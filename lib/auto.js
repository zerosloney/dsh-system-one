/**
 * auto.js — 自动决策注入。
 *
 * 把 SystemOne 从"模型主动调用的工具"升级为"每一步推理前自动执行的判断"。
 *
 * 挂钩点（已核对宿主源码 @deepseek-ai/dsh-agent-loop 的 preStep）：
 *
 *   const claimed = inbox.claim(target, position.turn)          // 本轮新进消息
 *   const assembly = await systemPrompt.assemble(...)           // ① 先装配提示词
 *   const context  = runtimeContext.project(...)                // ② 渲染运行时上下文
 *   const decision = await waterfall('agent/pre-step', {        // ③ 再跑瀑布
 *     messages: claimed, ... }, () => ({ kind: 'enter',
 *     messages: [...claimed, context] }))
 *
 * 注意顺序：装配在 pre-step **之前**，所以 `systemPrompt.context` 通道渲染的是
 * 上一步算出的内容（晚一步生效）。要"本轮就生效"，只能在 pre-step 里替换
 * messages —— 这正是下面 autoInject='message' 的默认行为。
 *
 * 安全约束（任何一条不满足都直接放行，绝不阻塞会话）：
 *   - 默认关闭（config.autoDecide = false）
 *   - 超时（autoTimeoutMs）与失败一律 fail-open
 *   - 相同 state 走缓存（autoCacheTtlMs）
 *   - 只在"本轮有新用户消息"时触发，工具结果步骤不触发
 *   - 跳过斜杠命令、跳过本插件自己注入的运行时上下文
 */
import { runScenarioDecision } from './tools.js'
import { findScenario } from './scenarios.js'

/** 宿主运行时上下文使用的 source.kind（见 dsh-agent-loop 的 SOURCE 常量）。 */
const RUNTIME_CONTEXT_SOURCE = 'runtime-context'

/**
 * 安装自动决策。返回卸载函数。
 *
 * @param {object} ctx - 插件上下文
 * @param {{ provider: object, config: object, scenarios: object[], logger?: object }} deps
 * @returns {() => void}
 */
export function installAutoDecide(ctx, deps) {
  const { provider, config, scenarios, logger } = deps
  if (!config.autoDecide) return () => {}

  const disposers = []
  /** agentId → { text, summary, scenarioId, at }：供 context 通道渲染。 */
  const perAgent = new Map()
  /** stateHash → { at, result }：避免同一内容重复请求。 */
  const cache = new Map()
  const minChars = Number.isFinite(Number(config.autoMinChars)) ? Number(config.autoMinChars) : 0
  const routeFloor = Number.isFinite(Number(config.autoRouteMinConfidence))
    ? Number(config.autoRouteMinConfidence)
    : 0

  const log = (level, message) => {
    try {
      const fn = logger?.[level]
      if (typeof fn === 'function') fn.call(logger, `dsh-systemone[auto]: ${message}`)
    } catch {
      // 日志失败不影响会话
    }
  }

  // agent 销毁时清理状态，避免长会话内存泄漏
  disposers.push(ctx.on('agent/disposed', (payload) => {
    const id = payload?.agent?.id
    if (id !== undefined) perAgent.delete(id)
  }))

  // ── context 通道：作用域内动态上下文（晚一步生效，但通道最干净） ──
  if (config.autoInject === 'context') {
    disposers.push(ctx.on('agent/created', (payload) => {
      const agent = payload?.agent
      const agentCtx = agent?.ctx
      if (!agentCtx?.systemPrompt?.context) return
      try {
        disposers.push(agentCtx.systemPrompt.context({
          name: 'systemone-auto-decision',
          order: 900,
          text: () => perAgent.get(agent?.id)?.text || '',
        }))
      } catch (error) {
        log('warn', `注册动态上下文失败：${messageOf(error)}`)
      }
    }))
  }

  // ── pre-step 通道：同一步生效 ──
  disposers.push(ctx.on('agent/pre-step', async (payload, next) => {
    let decision
    try {
      decision = await next()
    } catch (error) {
      // next() 自身失败时交回宿主处理，本插件不介入
      throw error
    }

    const agent = payload?.agent
    const claimed = Array.isArray(payload?.messages) ? payload.messages : []
    const newText = extractUserText(claimed)
    if (!newText) return decision                       // 工具结果步骤 / 无新用户消息
    if (newText.trimStart().startsWith('/')) return decision  // 斜杠命令
    if (isTrivialInput(newText, minChars)) return decision     // 寒暄/致谢等无业务含义的输入

    let injected = null
    try {
      // 双保险：既给上游传 abort signal，也用 race 兜底，
      // 即使提供商忽略 signal 也不会让这一步的推理被无限阻塞。
      const timeout = combineSignal(payload?.signal, config.autoTimeoutMs)
      try {
        injected = await raceTimeout(
          decide({
            agent,
            newText,
            provider,
            config,
            scenarios,
            cache,
            signal: timeout.signal,
            log,
          }),
          config.autoTimeoutMs,
        )
      } finally {
        timeout.dispose()
      }
    } catch (error) {
      log('warn', `自动决策失败，已放行：${messageOf(error)}`)
      return decision
    }
    if (!injected) return decision

    perAgent.set(agent?.id ?? 'unknown', injected)
    log('info', `自动决策完成（${injected.scenarioId}，${injected.source}）：${injected.headline}`)

    if (config.autoInject !== 'message') return decision

    // 别的监听器否决了这一步：绝不把 reject 改写成 enter
    if (decision?.kind === 'reject') return decision

    // 同一步注入：保留本轮消息，追加一条运行时上下文消息
    const messages = Array.isArray(decision?.messages) ? decision.messages : claimed
    return {
      kind: 'enter',
      messages: [...messages, buildContextMessage(injected.text)],
      ...(decision?.startsRequestSeries ? { startsRequestSeries: true } : {}),
    }
  }))

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // 卸载竞态
      }
    }
    perAgent.clear()
    cache.clear()
  }
}

/* ─── 决策流程 ─────────────────────────────────────────────────────────────── */

async function decide({ agent, newText, provider, config, scenarios, cache, signal, log }) {
  const state = captureState(agent, newText, config.autoMaxMessages)
  const key = hashString(state)

  const ttl = Number(config.autoCacheTtlMs) || 0
  if (ttl > 0) {
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < ttl) return hit.result
  }

  // 1) 选场景：固定绑定，或让模型做一次自动路由
  const routed = await resolveScenario({ state, provider, config, scenarios, signal })
  if (!routed) return null

  // 路由置信度不足：宁可不注入，也不要塞一个瞎猜的结论
  const floor = Number(config.autoRouteMinConfidence)
  if (Number.isFinite(floor) && floor > 0
    && Number.isFinite(routed.confidence) && routed.confidence < floor) {
    log?.('info', `路由置信度 ${(routed.confidence * 100).toFixed(1)}% 低于阈值 ${(floor * 100).toFixed(0)}%，跳过注入`)
    return null
  }

  // 2) 执行目标场景
  const result = await runScenarioDecision({
    provider,
    config,
    scenarios,
    scenario: routed.scenario.id,
    state,
    exec: { signal },
    minConfidence: config.autoMinConfidence,
  })
  if (!result?.ok) {
    log?.('warn', `场景 ${routed.scenario.id} 执行失败，已放行：${result?.error || '未知错误'}`)
    return null
  }

  const injected = {
    scenarioId: routed.scenario.id,
    source: routed.source,
    text: renderInjection(result, routed, config),
    headline: result.recommendation || routed.scenario.title,
    at: Date.now(),
  }
  if (ttl > 0) cache.set(key, { at: Date.now(), result: injected })
  return injected
}

/** 选择场景：固定绑定优先，否则用一次 choice 问句自动路由。 */
async function resolveScenario({ state, provider, config, scenarios, signal }) {
  const fixed = String(config.autoScenario || '').trim()
  if (fixed) {
    const scenario = findScenario(scenarios, fixed)
    if (!scenario) return null
    return { scenario, source: '固定绑定', confidence: null }
  }
  if (scenarios.length === 0) return null
  if (scenarios.length === 1) return { scenario: scenarios[0], source: '唯一场景', confidence: null }

  const response = await provider.decide({
    state,
    questions: {
      scenario: {
        type: 'choice',
        instructions: '这段内容最需要哪一类业务判断？',
        criteria: Object.fromEntries(scenarios.map((s) => [s.id, s.title])),
      },
    },
    model: config.model,
    signal,
  })
  const answer = response?.answers?.scenario
  const scenario = answer?.choice ? findScenario(scenarios, answer.choice) : undefined
  if (!scenario) return null
  return { scenario, source: '自动路由', confidence: Number(answer?.confidence) }
}

/** 把决策结果渲染成注入文本。 */
function renderInjection(result, routed, config) {
  const rationale = [
    `来源：${routed.source}`,
    Number.isFinite(routed.confidence) ? `路由置信度 ${pct(routed.confidence)}` : null,
  ].filter(Boolean).join('，')

  const lines = [
    '[SystemOne 自动决策 · 仅供参考，如有冲突以用户原始要求为准]',
    `场景：${routed.scenario.title}（${rationale}）`,
  ]

  const facts = Object.entries(result.labels || {})
    .map(([qid, label]) => `${questionLabel(routed.scenario, qid)}=${label}`)
    .join('；')
  if (facts) lines.push(`结论：${facts}`)

  const derived = Object.entries(result.derived || {}).map(([k, v]) => `${k}=${v}`).join('；')
  if (derived) lines.push(`派生：${derived}`)

  if (result.recommendation) lines.push(`建议：${result.recommendation}`)
  if (result.needs_human_review) lines.push('注意：本次判断置信度偏低，请人工确认后再执行。')

  return lines.join('\n')
}

function questionLabel(scenario, qid) {
  return scenario?.questions?.[qid]?.label || qid
}

/* ─── 上下文捕获 ───────────────────────────────────────────────────────────── */

/**
 * 判断是否为"无业务含义"的输入，用于跳过自动决策。
 *
 * 只用长度阈值会误伤真实请求（"退款失败" 只有 4 个字），所以改成
 * 「长度阈值 + 寒暄黑名单」：短且整体就是寒暄才跳过。
 */
const TRIVIAL_PATTERN = /^(你好|您好|哈喽|在吗|hi|hello|hey|ok|okay|好的|好嘞|收到|明白|嗯+|谢谢|多谢|感谢|thanks|thank you|thx|再见|拜拜|bye|测试|test)[\s!！。.~～,，、?？]*$/i

function isTrivialInput(text, minChars) {
  const trimmed = text.trim()
  if (Number.isFinite(minChars) && minChars > 0 && trimmed.length < minChars) return true
  return TRIVIAL_PATTERN.test(trimmed)
}

/**
 * 组合 state：会话历史（倒序取最近 N 条）+ 本轮新消息。
 * 本插件自己注入的运行时上下文会被排除，避免自我强化。
 */
function captureState(agent, newText, maxMessages) {
  const limit = Number.isFinite(Number(maxMessages)) && Number(maxMessages) > 0
    ? Math.floor(Number(maxMessages))
    : 6
  const history = readHistory(agent, limit)
  const parts = []
  if (history.length > 0) parts.push(`【近期对话】\n${history.join('\n')}`)
  parts.push(`【当前请求】\n${newText}`)
  return parts.join('\n\n')
}

function readHistory(agent, limit) {
  const events = agent?.session?.log
  if (!Array.isArray(events)) return []
  const picked = []
  for (let i = events.length - 1; i >= 0 && picked.length < limit; i--) {
    const event = events[i]
    let message
    if (event?.type === 'user/message') message = event.data
    else if (event?.type === 'assistant/message') message = event.data?.message
    else continue

    if (event.type === 'user/message' && message?.source?.kind === RUNTIME_CONTEXT_SOURCE) continue
    const text = textOfMessage(message)
    if (text) picked.unshift(`- ${event.type === 'user/message' ? '用户' : '助手'}：${truncate(text, 2000)}`)
  }
  return picked
}

function extractUserText(messages) {
  const texts = []
  for (const message of messages || []) {
    if (message?.role !== 'user') continue
    if (message?.source?.kind === RUNTIME_CONTEXT_SOURCE) continue
    const text = textOfMessage(message)
    if (text) texts.push(text)
  }
  return texts.join('\n\n').trim()
}

function textOfMessage(message) {
  if (!message) return ''
  if (typeof message.text === 'string') return message.text
  if (typeof message.content === 'string') return message.content
  const blocks = Array.isArray(message.content) ? message.content : Array.isArray(message.blocks) ? message.blocks : []
  return blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/** 构造与宿主 runtime-context 同形的消息（UserMessage）。 */
function buildContextMessage(text) {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: RUNTIME_CONTEXT_SOURCE },
  }
}

/* ─── 工具函数 ─────────────────────────────────────────────────────────────── */

/**
 * 把步骤 signal 与超时合并：任一触发即中止上游请求。
 * 返回 { signal, dispose }，dispose 用于在正常完成后清理定时器与监听器。
 */
function combineSignal(signal, timeoutMs) {
  const ms = Number(timeoutMs)
  const controller = new AbortController()
  let timer = null
  let onOuterAbort = null

  const dispose = () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (onOuterAbort && typeof signal?.removeEventListener === 'function') {
      signal.removeEventListener('abort', onOuterAbort)
      onOuterAbort = null
    }
  }

  if (Number.isFinite(ms) && ms > 0) {
    timer = setTimeout(() => {
      timer = null
      controller.abort(new Error(`自动决策超时（${ms}ms）`))
    }, ms)
    timer.unref?.()
  }
  if (signal && typeof signal.addEventListener === 'function') {
    if (signal.aborted) controller.abort()
    else {
      onOuterAbort = () => controller.abort()
      signal.addEventListener('abort', onOuterAbort, { once: true })
    }
  }
  return { signal: controller.signal, dispose }
}

/**
 * 给 promise 加硬超时。即使被调用方忽略 abort signal，也不会无限等待。
 */
function raceTimeout(promise, timeoutMs) {
  const ms = Number(timeoutMs)
  if (!Number.isFinite(ms) || ms <= 0) return promise
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`自动决策超时（${ms}ms）`)), ms)
    timer.unref?.()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function truncate(text, max) {
  const value = String(text)
  return value.length <= max ? value : `${value.slice(0, max)}…（已截断）`
}

function pct(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : '—'
}

function hashString(str) {
  let h = 2166136261 >>> 0
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(16)
}

function messageOf(error) {
  if (error !== null && typeof error === 'object' && typeof error.message === 'string') return error.message
  return String(error)
}