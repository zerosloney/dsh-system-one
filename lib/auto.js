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
 * 时序约束（重要）：
 *   - `systemPrompt.context` 的 text 是**同步求值**，发生在 assembly 期间；
 *     而决策依赖异步 HTTP 调用。宿主在消息入箱后立即同步唤醒 driver，
 *     中间没有任何可等待异步结果的挂载点。
 *   - 因此「同一步生效」只能走 pre-step 的 messages 注入（autoInject='message'），
 *     该通道由宿主无条件持久化到会话历史（line 1061: surfaceOp:'append'）。
 *     本模块用「内容去重」把污染从"每步一条"降为"每个不同决策一条"。
 *   - autoInject='context' 通道不写历史，但在第一步装配时决策通常尚未就绪，
 *     从第二步（工具续步）起才稳定可见。
 *
 * 安全约束（任何一条不满足都直接放行，绝不阻塞会话）：
 *   - 默认关闭（config.autoDecide = false）
 *   - 超时（autoTimeoutMs）与失败一律 fail-open
 *   - 相同 state 走缓存（autoCacheTtlMs），并发相同 state 走 in-flight 去重
 *   - 只在"本轮有新用户消息"时触发，工具结果步骤不触发
 *   - 跳过斜杠命令、跳过本插件自己注入的运行时上下文
 */
import { runScenarioDecision } from './tools.js'
import { findScenario } from './scenarios.js'
import { readBoolean, readNumber, readString } from './volatile.js'

/** 宿主运行时上下文使用的 source.kind（见 dsh-agent-loop 的 SOURCE 常量）。 */
const RUNTIME_CONTEXT_SOURCE = 'runtime-context'

/** 自动决策结果缓存的最大条目数；达到后先清过期再按插入序淘汰最旧。 */
const MAX_AUTO_CACHE = 200

/** 当前请求注入 state 的最大字符数（历史逐条限 2000，这里限制本轮原文）。 */
const MAX_CURRENT_CHARS = 8000

/**
 * 安装自动决策。返回卸载函数。
 *
 * @param {object} ctx - 插件上下文
 * @param {{ provider: object, config: object, scenarios: object[], logger?: object }} deps
 * @returns {() => void}
 */
export function installAutoDecide(ctx, deps) {
  const { provider, config, scenarios, logger } = deps
  if (!readBoolean(config, 'autoDecide', false)) return () => {}

  const disposers = []
  /** agentId → { stateKey, text, scenarioId, source, headline, at }：供 context 通道渲染。 */
  const perAgent = new Map()
  /** agentId → 上次注入的决策文本：同一决策只注入一次，避免每步重复污染历史。 */
  const lastInjected = new Map()
  /** stateHash → { at, result }：避免同一内容重复请求。 */
  const cache = new Map()
  /** stateHash → Promise：并发相同 state 只发一次上游请求。 */
  const inFlight = new Map()
  /** 已告警过的无效固定场景 id：同一错误只提示一次，避免每步刷日志。 */
  const warnedScenarios = new Set()

  const log = (level, message) => {
    try {
      const fn = logger?.[level]
      if (typeof fn === 'function') fn.call(logger, `@master0071/dsh-systemone[auto]: ${message}`)
    } catch {
      // 日志失败不影响会话
    }
  }

  // agent 销毁时清理状态，避免长会话内存泄漏
  disposers.push(ctx.on('agent/disposed', (payload) => {
    const id = payload?.agent?.id
    if (id !== undefined) {
      perAgent.delete(id)
      lastInjected.delete(id)
    }
  }))

  // ── context 通道：入箱预计算 + 动态上下文渲染（不写历史，第二步起稳定可见） ──
  // 监听器无条件注册，autoInject 的门控放在事件回调里按当前配置判断：
  // autoInject 是 volatile 字段，只有事件期判断才能让 message ↔ context
  // 在运行期双向切换都立即生效（在装配期固化只支持一个方向）。
  disposers.push(ctx.on('agent/created', (payload) => {
    const agent = payload?.agent
    const agentCtx = agent?.ctx
    if (!agentCtx) return
    // ① 消息一入箱就异步预计算，让决策尽可能在 assembly 之前就绪
    if (typeof agentCtx.on === 'function') {
      try {
        disposers.push(agentCtx.on('agent/inbox/inserted', (event) => {
          if (readString(config, 'autoInject', 'message') !== 'context') return
          const newText = extractUserText([event?.message])
          if (!newText) return
          if (newText.trimStart().startsWith('/')) return
          if (isTrivialInput(newText, readNumber(config, 'autoMinChars', 0))) return
          // 返回 promise 便于测试等待；宿主事件总线忽略返回值
          return computeAndStore(agent, newText)
        }))
      } catch (error) {
        log('warn', `注册入箱预计算失败：${messageOf(error)}`)
      }
    }
    // ② 把最新决策渲染进作用域动态上下文
    if (agentCtx?.systemPrompt?.context) {
      try {
        disposers.push(agentCtx.systemPrompt.context({
          name: 'systemone-auto-decision',
          order: 900,
          text: () => (readString(config, 'autoInject', 'message') === 'context')
            ? (perAgent.get(agent?.id)?.text || '')
            : '',
        }))
      } catch (error) {
        log('warn', `注册动态上下文失败：${messageOf(error)}`)
      }
    }
  }))

  // ── pre-step：同一步生效（仅 message 通道） ──
  disposers.push(ctx.on('agent/pre-step', async (payload, next) => {
    let decision
    try {
      decision = await next()
    } catch (error) {
      // next() 自身失败时交回宿主处理，本插件不介入
      throw error
    }

    // context 通道：不在这里计算（会晚于 assembly），由入箱预计算 + 动态上下文负责
    if (readString(config, 'autoInject', 'message') !== 'message') return decision

    const agent = payload?.agent
    const claimed = Array.isArray(payload?.messages) ? payload.messages : []
    const newText = extractUserText(claimed)
    if (!newText) return decision                       // 工具结果步骤 / 无新用户消息
    if (newText.trimStart().startsWith('/')) return decision  // 斜杠命令
    if (isTrivialInput(newText, readNumber(config, 'autoMinChars', 0))) return decision     // 寒暄/致谢等无业务含义的输入

    let injected = null
    try {
      // 双保险：既给上游传 abort signal，也用 race 兜底，
      // 即使提供商忽略 signal 也不会让这一步的推理被无限阻塞。
      const timeout = combineSignal(payload?.signal, readNumber(config, 'autoTimeoutMs', 8000))
      try {
        injected = await raceTimeout(
          computeDecision({
            agent,
            newText,
            provider,
            config,
            scenarios,
            cache,
            inFlight,
            signal: timeout.signal,
            log,
            warnedScenarios,
          }),
          readNumber(config, 'autoTimeoutMs', 8000),
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

    // 别的监听器否决了这一步：绝不把 reject 改写成 enter
    if (decision?.kind === 'reject') return decision

    // 去重：同一决策文本只注入一次。决策不变时不再重复追加，历史里
    // 每个不同决策只出现一条，把"每步一条"的污染降为"每个决策一条"。
    const agentId = agent?.id ?? 'unknown'
    if (lastInjected.get(agentId) === injected.text) return decision
    lastInjected.set(agentId, injected.text)

    // 同一步注入：保留本轮消息，追加一条运行时上下文消息
    const messages = Array.isArray(decision?.messages) ? decision.messages : claimed
    return {
      kind: 'enter',
      messages: [...messages, buildContextMessage(injected.text)],
      ...(decision?.startsRequestSeries ? { startsRequestSeries: true } : {}),
    }
  }))

  /** 入箱预计算：异步算好并存进 perAgent，供 context 通道渲染。 */
  async function computeAndStore(agent, newText) {
    try {
      const timeout = combineSignal(undefined, readNumber(config, 'autoTimeoutMs', 8000))
      try {
        const injected = await raceTimeout(
          computeDecision({
            agent,
            newText,
            provider,
            config,
            scenarios,
            cache,
            inFlight,
            signal: timeout.signal,
            log,
            warnedScenarios,
          }),
          readNumber(config, 'autoTimeoutMs', 8000),
        )
        if (injected) perAgent.set(agent?.id ?? 'unknown', injected)
      } finally {
        timeout.dispose()
      }
    } catch (error) {
      log('warn', `入箱预计算失败（忽略）：${messageOf(error)}`)
    }
  }

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // 卸载竞态
      }
    }
    perAgent.clear()
    lastInjected.clear()
    cache.clear()
    inFlight.clear()
  }
}

/* ─── 决策流程 ─────────────────────────────────────────────────────────────── */

/**
 * 计算决策（带并发去重）。相同 state 只发一次上游请求。
 */
async function computeDecision({ agent, newText, provider, config, scenarios, cache, inFlight, signal, log, warnedScenarios }) {
  const state = captureState(agent, newText, readNumber(config, 'autoMaxMessages', 6))
  const key = hashString(state)
  const existing = inFlight.get(key)
  if (existing) return existing
  const promise = decide({
    agent,
    newText,
    state,
    key,
    provider,
    config,
    scenarios,
    cache,
    signal,
    log,
    warnedScenarios,
  }).finally(() => {
    if (inFlight.get(key) === promise) inFlight.delete(key)
  })
  inFlight.set(key, promise)
  return promise
}

async function decide({ agent, newText, state, key, provider, config, scenarios, cache, signal, log, warnedScenarios }) {
  const ttl = readNumber(config, 'autoCacheTtlMs', 0) || 0
  if (ttl > 0) {
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < ttl) return hit.result
  }

  // 1) 选场景：固定绑定，或让模型做一次自动路由
  const routed = await resolveScenario({ state, provider, config, scenarios, signal, log, warnedScenarios })
  if (!routed) return null

  // 路由置信度不足：宁可不注入，也不要塞一个瞎猜的结论
  const floor = readNumber(config, 'autoRouteMinConfidence', 0)
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
    minConfidence: readNumber(config, 'autoMinConfidence', 0.6),
  })
  if (!result?.ok) {
    log?.('warn', `场景 ${routed.scenario.id} 执行失败，已放行：${result?.error || '未知错误'}`)
    return null
  }

  const injected = {
    stateKey: key,
    scenarioId: routed.scenario.id,
    source: routed.source,
    text: renderInjection(result, routed, config),
    headline: result.recommendation || routed.scenario.title,
    at: Date.now(),
  }
  if (ttl > 0) {
    // 缓存上限：先清过期，再按插入序淘汰最旧，防止长会话无限增长
    if (cache.size >= MAX_AUTO_CACHE) {
      const now = Date.now()
      for (const [k, v] of cache) {
        if (now - v.at >= ttl) cache.delete(k)
      }
    }
    while (cache.size >= MAX_AUTO_CACHE) {
      cache.delete(cache.keys().next().value)
    }
    cache.set(key, { at: Date.now(), result: injected })
  }
  return injected
}

/** 选择场景：固定绑定优先，否则用一次 choice 问句自动路由。 */
async function resolveScenario({ state, provider, config, scenarios, signal, log, warnedScenarios }) {
  const fixed = readString(config, 'autoScenario', '').trim()
  if (fixed) {
    const scenario = findScenario(scenarios, fixed)
    if (!scenario) {
      // 配置错误不能静默：同一 id 只告警一次，避免每步刷日志
      if (!warnedScenarios.has(fixed)) {
        warnedScenarios.add(fixed)
        log?.('warn', `固定场景 "${fixed}" 不在场景库中，自动决策已停用（请检查 autoScenario 配置；可用：${scenarios.map((s) => s.id).join('、')}）`)
      }
      return null
    }
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
    model: readString(config, 'model', ''),
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
 * 两条独立的跳过规则（命中任一即跳过）：
 *   1. 长度阈值：短于 autoMinChars 的一律跳过（默认 4，"退款失败" 恰好 4 字不被误伤）；
 *   2. 寒暄黑名单：整体就是一句寒暄/致谢的跳过，与长度无关。
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
  parts.push(`【当前请求】\n${truncate(newText, MAX_CURRENT_CHARS)}`)
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