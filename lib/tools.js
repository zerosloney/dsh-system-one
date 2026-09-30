/**
 * tools.js — SystemOne 决策工具定义（统一调度形态）。
 *
 * 只注册 2 个工具：
 *   1. systemone_scenario — action: list / describe / run，覆盖全部内置与自定义场景
 *   2. systemone_decide   — 直接提交自定义 questions 的低层入口
 *
 * 场景全部来自 scenarios.js 的场景库（内置 10 个 + 配置追加），新增场景无需改代码。
 */
import {
  computeNeedsHumanReview,
  deriveFields,
  formatAnswerLines,
  formatSummary,
  normalizeAnswers,
  renderTemplate,
} from './format.js'
import { findScenario } from './scenarios.js'
import { readNumber, readString } from './volatile.js'

const DEFAULT_MIN_CONFIDENCE = 0.6

/** 创建全部工具定义。 */
export function createTools(provider, config, scenarios) {
  return [
    scenarioTool(provider, config, scenarios),
    decideTool(provider, config),
  ]
}

/* ─── 1. 场景调度工具 ─────────────────────────────────────────────────────── */

function scenarioTool(provider, config, scenarios) {
  return {
    name: 'systemone_scenario',
    description: [
      'SystemOne 场景决策：把业务状态与预置的结构化问题一次性提交给决策模型，返回带概率分布的判断与处置建议。',
      'action=list 列出全部场景；action=describe 查看某个场景的问题定义与可覆盖参数；action=run 执行决策。',
      '内置 10 大业务场景，可用 params 覆盖问题定义。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'describe', 'run'],
          description: '操作类型：list=列出场景，describe=查看场景问题定义，run=执行决策。',
        },
        scenario: {
          type: 'string',
          description: '场景 id 或别名，如 customer_service / content_moderation / risk_control（action=describe/run 时必填）。',
        },
        state: {
          type: ['string', 'object', 'array'],
          description: '业务上下文：工单文本、对话数组或结构化对象（action=run 时必填）。',
        },
        params: {
          type: 'object',
          additionalProperties: { type: 'object' },
          description: '可选：按问题 id 覆盖问题定义。criteria 整体替换选项（choice 传对象，score 传标签数组），addCriteria 在现有选项上追加/覆盖单个 key，也可覆盖 instructions 与 label。',
        },
        keyword: {
          type: 'string',
          description: '可选：action=list 时按关键词过滤场景（匹配 id/标题/别名）。',
        },
      },
      required: ['action'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: value?.summary || JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const action = args.action || 'run'

      if (action === 'list') {
        return listScenarios(scenarios, args.keyword)
      }
      if (action === 'describe') {
        return describeScenario(scenarios, args.scenario)
      }
      return runScenario({ provider, config, scenarios, args, exec })
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `SystemOne 场景：${args?.action || 'run'}${args?.scenario ? ` · ${args.scenario}` : ''}`,
      kind: 'other',
      rawInput: args,
    }),
  }
}

function listScenarios(scenarios, keyword) {
  const needle = typeof keyword === 'string' ? keyword.trim().toLowerCase() : ''
  const items = scenarios
    .filter((s) => {
      if (!needle) return true
      return [s.id, s.title, s.description, ...(s.aliases || [])]
        .join(' ')
        .toLowerCase()
        .includes(needle)
    })
    .map((s) => ({
      id: s.id,
      title: s.title,
      description: s.description,
      source: s.source,
      question_count: Object.keys(s.questions).length,
      questions: Object.entries(s.questions).map(([qid, q]) => `${qid}:${q.type}`),
    }))

  const summary = [
    `## SystemOne 场景库（${items.length} 个）`,
    ...items.map((s) => `- **${s.id}**：${s.title} — ${s.question_count} 个问题（${s.questions.join('，')}）`),
    '',
    '用 action=describe 查看某场景的问题定义，用 action=run 执行决策。',
  ].join('\n')

  return { ok: true, action: 'list', count: items.length, scenarios: items, summary }
}

function describeScenario(scenarios, id) {
  const scenario = findScenario(scenarios, id)
  if (!scenario) {
    return {
      ok: false,
      error: `未知场景 "${id}"`,
      available: scenarios.map((s) => s.id),
      summary: `## SystemOne 场景\n\n**未找到场景**：${id}\n\n可用场景：${scenarios.map((s) => s.id).join('、')}`,
    }
  }
  const questions = Object.entries(scenario.questions).map(([qid, q]) => ({
    id: qid,
    type: q.type,
    label: q.label,
    instructions: q.instructions,
    criteria: q.criteria ?? null,
  }))
  const summary = [
    `## ${scenario.title}`,
    `- **场景 id**：${scenario.id}${scenario.aliases?.length ? `（别名：${scenario.aliases.join('、')}）` : ''}`,
    scenario.description ? `- **说明**：${scenario.description}` : null,
    ...questions.map((q) => {
      const criteria = q.type === 'choice'
        ? Object.entries(q.criteria || {}).map(([k, v]) => `${k}=${v}`).join('；')
        : q.type === 'score'
          ? (q.criteria || []).map((v, i) => `${i}=${v}`).join('；')
          : '（0~1 概率）'
      return `- **${q.label}** \`${q.id}\`（${q.type}）：${q.instructions}\n  - 选项：${criteria}`
    }).filter(Boolean),
    scenario.recommendation ? `- **建议模板**：${scenario.recommendation}` : null,
    '',
    '用 action=run 执行，可用 params 覆盖上面任意问题的 criteria。',
  ].filter(Boolean).join('\n')

  return { ok: true, action: 'describe', scenario: scenario.id, title: scenario.title, questions, summary }
}

async function runScenario({ provider, config, scenarios, args, exec }) {
  return runScenarioDecision({
    provider,
    config,
    scenarios,
    scenario: args.scenario,
    state: args.state,
    params: args.params,
    exec,
  })
}

/**
 * 执行一次场景决策（工具与自动决策共用的核心入口）。
 *
 * @param {object} options
 * @param {object} options.provider - 提供商
 * @param {object} options.config - 插件配置
 * @param {object[]} options.scenarios - 场景库
 * @param {string} options.scenario - 场景 id 或别名
 * @param {unknown} options.state - 业务上下文
 * @param {object} [options.params] - 按问题 id 覆盖问题定义
 * @param {object} [options.exec] - 工具执行上下文（取 signal）
 * @param {string} [options.model] - 覆盖模型
 * @param {number} [options.minConfidence] - 覆盖置信度阈值
 * @returns {Promise<object>} 与工具输出同构的决策结果
 */
export async function runScenarioDecision({
  provider,
  config,
  scenarios,
  scenario: scenarioRef,
  state,
  params,
  exec,
  model,
  minConfidence,
}) {
  const scenario = findScenario(scenarios, scenarioRef)
  if (!scenario) {
    return {
      ok: false,
      error: `未知场景 "${scenarioRef ?? ''}"`,
      available: scenarios.map((s) => s.id),
      summary: `## SystemOne 场景决策\n\n**未找到场景**：${scenarioRef ?? '（未提供）'}\n\n可用场景：${scenarios.map((s) => s.id).join('、')}`,
    }
  }
  if (state === undefined || state === null || state === '') {
    return {
      ok: false,
      error: '缺少 state',
      scenario: scenario.id,
      summary: `## ${scenario.title}\n\n**缺少 state**：请提供需要判断的业务上下文。`,
    }
  }

  const questions = applyParams(scenario.questions, params)
  const configThreshold = readNumber(config, 'minConfidence', NaN)
  const threshold = Number.isFinite(Number(minConfidence))
    ? Number(minConfidence)
    : Number.isFinite(Number(scenario.minConfidence))
      ? Number(scenario.minConfidence)
      : Number.isFinite(configThreshold)
        ? configThreshold
        : DEFAULT_MIN_CONFIDENCE

  return executeDecision({
    title: scenario.title,
    scenarioId: scenario.id,
    state,
    questions,
    provider,
    config,
    minConfidence: threshold,
    exec,
    model,
    finalize(answers) {
      const { decision, labels, confidences } = normalizeAnswers(answers, questions)
      const derived = deriveFields(scenario.derive, decision)
      const recommendation = scenario.recommendation
        ? renderTemplate(scenario.recommendation, { labels, decision, confidences, derived })
        : ''
      return { decision, labels, derived, confidences, recommendation }
    },
  })
}

/** 按 params 覆盖问题定义。 */
function applyParams(questions, params) {
  if (!params || typeof params !== 'object') return questions
  const merged = {}
  for (const [qid, question] of Object.entries(questions)) {
    const override = params[qid]
    if (!override || typeof override !== 'object') {
      merged[qid] = question
      continue
    }
    const next = { ...question }
    if (typeof override.instructions === 'string' && override.instructions.trim()) {
      next.instructions = override.instructions
    }
    if (typeof override.label === 'string' && override.label.trim()) {
      next.label = override.label
    }
    // criteria 整体替换；addCriteria 在替换结果之上追加/覆盖单个选项
    if (override.criteria) {
      if (question.type === 'choice' && !Array.isArray(override.criteria)) {
        next.criteria = Object.fromEntries(
          Object.entries(override.criteria).map(([k, v]) => [String(k), String(v)]),
        )
      } else if (question.type === 'score' && Array.isArray(override.criteria) && override.criteria.length >= 2) {
        next.criteria = override.criteria.map((v) => String(v))
      }
    }
    if (override.addCriteria && question.type === 'choice' && !Array.isArray(override.addCriteria)) {
      next.criteria = { ...(next.criteria || {}), ...override.addCriteria }
    }
    merged[qid] = next
  }
  return merged
}

/* ─── 2. 通用决策工具 ─────────────────────────────────────────────────────── */

function decideTool(provider, config) {
  return {
    name: 'systemone_decide',
    description: [
      'SystemOne 通用决策：直接提交业务状态与自定义问题映射（choice/noul/score）到决策模型，返回原始概率化答案。',
      '适合场景库中没有的临时判断。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        state: {
          type: ['string', 'object', 'array'],
          description: '业务上下文：字符串、结构化对象或数组。非字符串会被序列化后推理。',
        },
        questions: {
          type: 'object',
          additionalProperties: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['choice', 'noul', 'score'], description: '问题类型。' },
              instructions: { type: 'string', description: '问题描述。' },
              criteria: {
                description: 'choice 为选项映射对象（key=选项标识，value=说明）；score 为分级标签数组。',
              },
            },
            required: ['type', 'instructions'],
          },
          description: '问题映射：键为问题 ID，值为问题对象。推荐不超过 16 个问题。',
        },
        model: { type: 'string', description: '可选：模型名，默认取插件配置的 model。' },
      },
      required: ['state', 'questions'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: value?.summary || JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const minConfidence = readNumber(config, 'minConfidence', DEFAULT_MIN_CONFIDENCE)
      return executeDecision({
        title: 'SystemOne 通用决策',
        scenarioId: null,
        state: args.state,
        questions: args.questions || {},
        provider,
        config,
        minConfidence,
        exec,
        model: args.model,
        finalize(answers) {
          const { decision, labels, confidences } = normalizeAnswers(answers, args.questions || {})
          return { decision, labels, derived: {}, confidences, recommendation: '' }
        },
      })
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'SystemOne 通用决策',
      kind: 'other',
      rawInput: args,
    }),
  }
}

/* ─── 公共执行逻辑 ─────────────────────────────────────────────────────────── */

async function executeDecision({
  title,
  scenarioId,
  state,
  questions,
  provider,
  config,
  minConfidence,
  exec,
  model,
  finalize,
}) {
  try {
    const started = Date.now()
    const configuredModel = readString(config, 'model', '')
    const response = await provider.decide({
      state,
      questions,
      model: model || configuredModel,
      signal: exec?.signal,
    })
    const answers = response.answers || {}
    const { decision, labels, derived, confidences, recommendation } = finalize(answers)
    const needsHumanReview = computeNeedsHumanReview(answers, minConfidence)
    const lines = formatAnswerLines(answers, questions)
    const latencyMs = Number.isFinite(Number(response.latency_ms))
      ? Number(response.latency_ms)
      : Date.now() - started
    const modelName = response.model || configuredModel || 'unknown'
    const summary = formatSummary({
      title,
      provider: provider.name,
      model: modelName,
      requestId: response.request_id || '',
      latencyMs,
      lines,
      recommendation,
      needsHumanReview,
    })
    return {
      ok: true,
      scenario: scenarioId,
      provider: provider.name,
      model: modelName,
      request_id: response.request_id || '',
      latency_ms: latencyMs,
      answers,
      decision,
      labels,
      derived,
      confidences,
      needs_human_review: needsHumanReview,
      recommendation,
      summary,
    }
  } catch (err) {
    const msg = messageOf(err)
    return {
      ok: false,
      scenario: scenarioId,
      provider: provider.name,
      error: msg,
      summary: `## ${title}\n\n**SystemOne 调用失败**：${msg}`,
    }
  }
}

function messageOf(err) {
  if (err !== null && typeof err === 'object' && typeof err.message === 'string') return err.message
  if (typeof err === 'string') return err
  return String(err)
}

