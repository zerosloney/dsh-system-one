/**
 * tools.js — SystemOne 决策工具定义（统一调度形态）。
 *
 * 只注册 2 个工具：
 *   1. systemone_scenario — action: list / describe / run，覆盖全部内置与自定义场景
 *   2. systemone_decide   — 直接提交自定义 questions 的低层入口
 *
 * 场景全部来自 scenarios.js 的场景库（内置 11 个 + 配置追加），新增场景无需改代码。
 */
import {
  deriveFields,
  formatAnswerLines,
  formatSummary,
  normalizeAnswers,
  renderTemplate,
  reviewAssessment,
} from './format.js'
import { findScenario } from './scenarios.js'
import { recordUsage } from './usage.js'
import { readNumber, readString } from './volatile.js'

const DEFAULT_MIN_CONFIDENCE = 0.6

/**
 * 工具入参 state 的硬上限。自动决策路径有自己的截断（见 auto.js 的
 * MAX_CURRENT_CHARS / 每条历史 2000 字），这里只防工具路径被塞进超大输入
 * 直接打到上游 API；超长内容对决策质量也没有增量。
 */
const MAX_TOOL_STATE_CHARS = 16000

/**
 * 给 state 套硬上限：超长字符串截断；对象/数组按序列化长度衡量，
 * 超限降级为截断后的 JSON 文本（决策模型反正是按文本理解的）。
 * undefined/null/空字符串原样返回，让「缺少 state」的校验路径保持不变。
 */
function capState(state) {
  if (state === undefined || state === null) return state
  if (typeof state === 'string') {
    return state.length <= MAX_TOOL_STATE_CHARS
      ? state
      : `${state.slice(0, MAX_TOOL_STATE_CHARS)}…（已截断，原 ${state.length} 字符）`
  }
  let serialized
  try {
    serialized = JSON.stringify(state)
  } catch {
    // 循环引用等无法序列化的结构：原样交给下游，由序列化失败的报错路径兜底
    return state
  }
  if (serialized.length <= MAX_TOOL_STATE_CHARS) return state
  return `${serialized.slice(0, MAX_TOOL_STATE_CHARS)}…（已截断，原 ${serialized.length} 字符）`
}

/**
 * 创建全部工具定义。
 *
 * @param {object} provider - 提供商
 * @param {object} config - 插件配置
 * @param {object[]} scenarios - 场景库（活引用）
 * @param {object} [hooks] - 可选运行时钩子
 * @param {() => string[]} [hooks.warnings] - 读取当前非致命提示（如别名遮蔽），
 *   用于让 `action=list` 把「哪个别名被抢走了」告诉模型，而不只是写进宿主日志。
 * @param {object} [hooks.usage] - 用量台账（createUsageLedger 的返回值）。有则记录每次上游调用。
 */
export function createTools(provider, config, scenarios, hooks = {}) {
  return [
    scenarioTool(provider, config, scenarios, hooks),
    decideTool(provider, config, hooks),
  ]
}

/* ─── 1. 场景调度工具 ─────────────────────────────────────────────────────── */

function scenarioTool(provider, config, scenarios, hooks = {}) {
  return {
    name: 'systemone_scenario',
    description: [
      'SystemOne 场景决策：把业务状态与预置的结构化问题一次性提交给决策模型，返回带概率分布的判断与处置建议。',
      'action=list 列出全部场景；action=describe 查看某个场景的问题定义与可覆盖参数；action=run 执行决策。',
      '内置 11 大业务场景，可用 params 覆盖问题定义。',
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
        return listScenarios(scenarios, args.keyword, readWarnings(hooks), hooks?.usage)
      }
      if (action === 'describe') {
        return describeScenario(scenarios, args.scenario)
      }
      return runScenarioDecision({
        provider,
        config,
        scenarios,
        scenario: args.scenario,
        state: capState(args.state),
        params: args.params,
        exec,
        usage: hooks?.usage,
      })
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `SystemOne 场景：${args?.action || 'run'}${args?.scenario ? ` · ${args.scenario}` : ''}`,
      kind: 'other',
      rawInput: args,
    }),
  }
}

/** 安全读取钩子里的提示列表：钩子缺失或抛错都不应影响 list。 */
function readWarnings(hooks) {
  try {
    const value = hooks?.warnings?.()
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

function listScenarios(scenarios, keyword, warnings = [], usage) {
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

  // 用量台账：list 是调用方最容易顺手调用的入口，把今日花销挂在这里，
  // 让「花了多少」不需要另开一个工具就能看到。
  let usageLine = null
  let usageSnapshot = null
  try {
    if (typeof usage?.today === 'function') {
      usageSnapshot = usage.today()
      usageLine = typeof usage.formatToday === 'function' ? usage.formatToday() : null
    }
  } catch {
    // 台账读取失败不影响 list
  }

  const summary = [
    `## SystemOne 场景库（${items.length} 个）`,
    ...items.map((s) => `- **${s.id}**：${s.title} — ${s.question_count} 个问题（${s.questions.join('，')}）`),
    // 别名遮蔽提示只在 list 时给出：它影响「用别名能否调到这个场景」，
    // 不说的话调用方会以为是场景不存在，而不是别名被别的场景占了。
    ...(warnings.length > 0
      ? ['', '### 配置提示', ...warnings.map((w) => `- ${w}`)]
      : []),
    ...(usageLine ? ['', '### 用量', `- ${usageLine}`] : []),
    '',
    '用 action=describe 查看某场景的问题定义，用 action=run 执行决策。',
  ].join('\n')

  return {
    ok: true,
    action: 'list',
    count: items.length,
    scenarios: items,
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(usageSnapshot ? { usage_today: usageSnapshot } : {}),
    summary,
  }
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
 * @param {number} [options.minConfidence] - 覆盖置信度阈值
 * @param {object} [options.usage] - 用量台账；有则记录本次调用
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
  minConfidence,
  usage,
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

  const { questions, ignored } = applyParams(scenario.questions, params)
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
    usage,
    warnings: ignored.length > 0
      ? [`以下 params 覆盖无效，已忽略：${ignored.join('；')}`]
      : [],
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

/**
 * 按 params 覆盖问题定义，并收集无法应用的覆盖项（类型不匹配、未知问题 id），
 * 让调用方能把「传了但没生效」反馈给模型，而不是静默丢弃。
 *
 * @returns {{ questions: object, ignored: string[] }}
 */
function applyParams(questions, params) {
  if (!params || typeof params !== 'object') return { questions, ignored: [] }
  const merged = {}
  const ignored = []
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
        const entries = Object.entries(override.criteria)
        if (entries.length < 2) {
          ignored.push(`${qid}.criteria（choice 至少需要 2 个选项）`)
        } else {
          next.criteria = Object.fromEntries(entries.map(([k, v]) => [String(k), String(v)]))
        }
      } else if (question.type === 'score' && Array.isArray(override.criteria) && override.criteria.length >= 2) {
        next.criteria = override.criteria.map((v) => String(v))
      } else {
        ignored.push(`${qid}.criteria（与问题类型 ${question.type} 不匹配）`)
      }
    }
    if (override.addCriteria) {
      if (question.type === 'choice' && !Array.isArray(override.addCriteria)) {
        next.criteria = { ...(next.criteria || {}), ...override.addCriteria }
      } else {
        ignored.push(`${qid}.addCriteria（仅支持 choice 问题）`)
      }
    }
    merged[qid] = next
  }
  for (const qid of Object.keys(params)) {
    if (!(qid in questions)) ignored.push(`${qid}（未知问题 id）`)
  }
  return { questions: merged, ignored }
}

/* ─── 2. 通用决策工具 ─────────────────────────────────────────────────────── */

function decideTool(provider, config, hooks = {}) {
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
        state: capState(args.state),
        questions: args.questions || {},
        provider,
        config,
        minConfidence,
        exec,
        model: args.model,
        usage: hooks?.usage,
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
  warnings = [],
  usage,
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
    // 记账：成功与失败都记（上游可能已计费）。记账失败绝不影响决策。
    recordUsage(usage, {
      source: 'tool',
      ok: true,
      model: response.model || model || configuredModel,
      provider: provider.name,
      scenario: scenarioId || '',
      usage: response.usage,
      latencyMs: response.latency_ms,
    })
    const answers = response.answers || {}
    const { decision, labels, derived, confidences, recommendation } = finalize(answers)

    // ── 空决策守卫 ────────────────────────────────────────────────────────────
    // 必须同时覆盖两种"沉默"形态：
    //   a) answers 为空 / 全是无法识别的 type → decision 里一个键都没有；
    //   b) 有 answers 但关键字段缺失（如 noul 答案没有 noul 数值）→
    //      normalizeAnswers 会把该问题写成 null（"无法判断"）。
    // 注意 type 的取值是 `question.type || raw.type`：上游给个无法识别的 type、
    // 而问题定义是合法 type 时，会走 (b) 这条路——所以只看 decision 是否为空
    // 是不够的，必须看**有没有任何一个问题真正产出了判断**。
    // 若此时仍报 ok:true，调用方（模型）会以为"判断已完成"，实际拿到的是空判断；
    // 对决策工具来说，这种静默空成功比显式失败更危险。
    const asked = Object.keys(questions || {})
    const usable = asked.filter((qid) => {
      const value = decision[qid]
      return value !== null && value !== undefined
    })
    if (usable.length === 0) {
      const returned = Object.keys(answers)
      const unusable = asked.filter((qid) => qid in decision)
      let detail
      if (asked.length === 0) {
        detail = '本次没有提交任何问题'
      } else if (returned.length === 0) {
        detail = `提交了 ${asked.length} 个问题（${asked.join('、')}）；上游未返回任何 answers`
      } else if (unusable.length > 0) {
        detail = `提交了 ${asked.length} 个问题（${asked.join('、')}）；上游返回的 answers 里没有可用取值`
          + `（无法判断：${unusable.join('、')}）`
      } else {
        detail = `提交了 ${asked.length} 个问题（${asked.join('、')}）；`
          + `上游仅返回了 ${returned.join('、')}，与所问的问题对不上`
      }
      const error = `SystemOne 未产出任何可用的决策：${detail}`
      return {
        ok: false,
        scenario: scenarioId,
        provider: provider.name,
        error,
        answers,
        decision,
        labels,
        derived: {},
        confidences: {},
        recommendation: '',
        needs_human_review: true,
        warnings,
        summary: `## ${title}\n\n**未产出任何可用的决策**：${detail}\n\n无法给出置信度与概率分布。请核对问题定义（type 必须是 choice / noul / score；choice 的 criteria 需 2~26 个选项；score 的 criteria 需 ≥2 级标签）后重试。`,
      }
    }

    const assessment = reviewAssessment(answers, minConfidence)
    const needsHumanReview = assessment.needed
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
      notes: warnings,
      needsHumanReview,
      reviewReasons: assessment.reasons,
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
      review_reasons: assessment.reasons,
      recommendation,
      warnings,
      summary,
    }
  } catch (err) {
    const msg = messageOf(err)
    recordUsage(usage, { source: 'tool', ok: false, model, provider: provider?.name, scenario: scenarioId || '' })
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

