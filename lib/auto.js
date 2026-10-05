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
 *   - 相同 state 且决策参数未变时走缓存（autoCacheTtlMs），并发相同 state 走 in-flight 去重
 *   - 只在"本轮有新用户消息"时触发，工具结果步骤不触发
 *   - 跳过斜杠命令、跳过本插件自己注入的决策消息（按 INJECTED_SOURCE 识别）
 */
import { runScenarioDecision } from './tools.js'
import { MAX_CHOICE_OPTIONS, findScenario } from './scenarios.js'
import { recordUsage } from './usage.js'
import { readBoolean, readNumber, readString } from './volatile.js'

/**
 * 本插件注入消息的 source.kind —— **必须用自己的 kind，绝不能复用宿主的 `runtime-context`**。
 *
 * 宿主 `@deepseek-ai/dsh-agent-loop` 的 RuntimeContextProjection 只凭
 * `message.source.kind === 'runtime-context'` 判定"这是我自己写的动态上下文快照"
 * （runtime-context.ts 的 `isOwned()`），并据此维护 `retained`（上一条自有快照的
 * 序号与文本），用来决定下一步要不要再追加一条：
 *
 *   if (event.type === 'user/message' && isOwned(event.data)) this.retained = {...}
 *   if (this.retained?.text === snapshot) return          // 未变则不追加
 *   return [{ message: ..., intent: { surfaceOp: 'append' } }]
 *
 * 复用该 kind 的后果（本插件 v0.5.0 及更早版本的缺陷）：
 *   1. 每一步注入都把宿主的 retained 覆写成决策文本，于是宿主发现
 *      retained.text !== 自己渲染的上下文，**再追加一条冗余快照**；
 *   2. 会话恢复时宿主倒序扫描，会把本插件的最新决策消息误认成自己保留的快照；
 *   3. 宿主还有 CLEARED 归一化逻辑，任何按该 kind 过滤/替换的宿主代码都会误伤。
 *
 * 宿主 llm/message.ts 把 MessageSourceMap 定义为 merge-extensible：
 * "each producer declares its own `kind` in its own module; there is no shared
 * catch-all `plugin` kind"。首方同类插件（time-context / tmux-context）同样各用
 * 自己的 kind。本常量同时用于**写入**注入消息与**读取**时的自我排除，两者必须一致。
 */
const INJECTED_SOURCE = 'systemone-decision'

/** 自动决策结果缓存的最大条目数；达到后先清过期再按插入序淘汰最旧。 */
const MAX_AUTO_CACHE = 200

/** 当前请求注入 state 的最大字符数（历史逐条限 HISTORY_CHARS_PER_MESSAGE，这里限制本轮原文）。 */
export const MAX_CURRENT_CHARS = 8000

/** 历史消息**每条**进入 state 的最大字符数（index.js 的外发声明预算同源引用）。 */
export const HISTORY_CHARS_PER_MESSAGE = 2000

/** 自动决策数字配置的兜底默认值（与 lib/index.js Config schema 的 default 保持同一份来源）。 */
export const AUTO_DEFAULTS = {
  autoMaxMessages: 6,
  autoTimeoutMs: 8000,
  autoCacheTtlMs: 60000,
  autoRouteMinConfidence: 0.35,
  autoMinConfidence: 0.6,
  autoMinChars: 4,
}

/** fail-closed 档判定：closed 只对"本应得到决策却没有"的真失败生效（见各调用点）。 */
function isFailClosed(config) {
  return readString(config, 'autoFailMode', 'open') === 'closed'
}

/**
 * 安装自动决策。返回卸载函数。
 *
 * @param {object} ctx - 插件上下文
 * @param {{ provider: object, config: object, scenarios: object[], logger?: object }} deps
 * @returns {() => void}
 */
export function installAutoDecide(ctx, deps) {
  const { provider, config, scenarios, logger, usage } = deps
  if (!readBoolean(config, 'autoDecide', false)) return () => {}

  const disposers = []
  /** agentId → 该 agent 的 per-agent 清理函数；agent 销毁时一并调用并从表中移除，避免无界增长。 */
  const agentDisposers = new Map()
  /** agentId → { stateKey, text, scenarioId, source, headline, at }：供 context 通道渲染。 */
  const perAgent = new Map()
  /** agentId → 上次注入的决策文本：同一决策只注入一次，避免每步重复污染历史。 */
  const lastInjected = new Map()
  /** 决策 key（state + 决策指纹）→ { at, result }：避免同一内容在同一配置下重复请求。 */
  const cache = new Map()
  /** 决策 key → Promise：并发相同 state 且同配置时只发一次上游请求。 */
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

  // agent 销毁时清理状态与 per-agent 监听器，避免长会话内存泄漏
  disposers.push(ctx.on('agent/disposed', (payload) => {
    const id = payload?.agent?.id
    if (id !== undefined) {
      perAgent.delete(id)
      lastInjected.delete(id)
      const list = agentDisposers.get(id)
      if (list) {
        for (const dispose of list) {
          try {
            dispose()
          } catch {
            // 卸载竞态
          }
        }
        agentDisposers.delete(id)
      }
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
    const agentId = agent?.id
    // 该 agent 的监听器与动态上下文注册统一记到这里，随 agent 销毁一起移除
    const perAgentDisposers = []
    // ① 消息一入箱就异步预计算，让决策尽可能在 assembly 之前就绪
    if (typeof agentCtx.on === 'function') {
      try {
        const dispose = agentCtx.on('agent/inbox/inserted', (event) => {
          if (readString(config, 'autoInject', 'message') !== 'context') return
          const newText = extractUserText([event?.message])
          if (!newText) return
          if (newText.trimStart().startsWith('/')) return
          if (isTrivialInput(newText, readNumber(config, 'autoMinChars', AUTO_DEFAULTS.autoMinChars))) return
          // 返回 promise 便于测试等待；宿主事件总线忽略返回值
          return computeAndStore(agent, newText)
        })
        if (typeof dispose === 'function') perAgentDisposers.push(dispose)
      } catch (error) {
        log('warn', `注册入箱预计算失败：${messageOf(error)}`)
      }
    }
    // ② 把最新决策渲染进作用域动态上下文
    if (agentCtx?.systemPrompt?.context) {
      try {
        const dispose = agentCtx.systemPrompt.context({
          name: 'systemone-auto-decision',
          order: 900,
          text: () => (readString(config, 'autoInject', 'message') === 'context')
            ? (perAgent.get(agent?.id)?.text || '')
            : '',
        })
        if (typeof dispose === 'function') perAgentDisposers.push(dispose)
      } catch (error) {
        log('warn', `注册动态上下文失败：${messageOf(error)}`)
      }
    }
    // 记入 per-agent 表：agent 销毁时移除；同一 agent 重复创建时先清理旧条目。
    // agentId 缺失时退回插件级 disposers，随插件卸载统一清理。
    if (perAgentDisposers.length === 0) return
    if (agentId === undefined) {
      disposers.push(...perAgentDisposers)
      return
    }
    const existing = agentDisposers.get(agentId)
    if (existing) {
      for (const dispose of existing) {
        try {
          dispose()
        } catch {
          // 重复创建竞态
        }
      }
    }
    agentDisposers.set(agentId, perAgentDisposers)
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
    if (isTrivialInput(newText, readNumber(config, 'autoMinChars', AUTO_DEFAULTS.autoMinChars))) return decision     // 寒暄/致谢等无业务含义的输入

    let injected = null
    try {
      // 双保险：既给上游传 abort signal，也用 race 兜底，
      // 即使提供商忽略 signal 也不会让这一步的推理被无限阻塞。
      const timeoutMs = readNumber(config, 'autoTimeoutMs', AUTO_DEFAULTS.autoTimeoutMs)
      const timeout = combineSignal(payload?.signal, timeoutMs)
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
            usage,
          }),
          timeoutMs,
        )
      } finally {
        timeout.dispose()
      }
    } catch (error) {
      // fail-closed 档：决策管线失败 = 本轮没有可用决策，按 closed 语义否决
      // （宿主把 turn 记为 blocked）。open 档维持注入语义：记 warning 放行。
      if (isFailClosed(config)) {
        log('warn', `自动决策失败，fail-closed 拦截本轮：${messageOf(error)}`)
        return { kind: 'reject' }
      }
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
      const timeoutMs = readNumber(config, 'autoTimeoutMs', AUTO_DEFAULTS.autoTimeoutMs)
      const timeout = combineSignal(undefined, timeoutMs)
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
            usage,
          }),
          timeoutMs,
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
    // 兜底：即使宿主未触发 agent/disposed，也清掉所有 per-agent 监听器
    for (const list of agentDisposers.values()) {
      for (const dispose of list) {
        try {
          dispose()
        } catch {
          // 卸载竞态
        }
      }
    }
    agentDisposers.clear()
    perAgent.clear()
    lastInjected.clear()
    cache.clear()
    inFlight.clear()
  }
}

/* ─── 决策流程 ─────────────────────────────────────────────────────────────── */

/**
 * 决策指纹：把**影响决策结果的全部配置**压成一个短字符串。
 *
 * 缓存与 in-flight 去重的 key 必须是 `hashString(state + 指纹)`，不能只哈希 state
 * ——否则用户在配置页改了「固定场景」、切了 model/provider、或调了两个置信度门槛后，
 * 最长 autoCacheTtlMs（默认 60 秒）内仍会继续注入**旧场景的旧结论**，与
 * "保存即生效、无需重启"的承诺直接冲突。
 *
 * 指纹含 `scenariosRef`：场景库本身也是热更新的（customScenarios），而自动路由的
 * 结果是一个场景 id；若期间删除/改名了该场景，旧的路由结论会指向已不存在的场景，
 * 表现为"决策突然不注入了"。把场景库指纹纳入 key 让这种变更立即失效。
 *
 * 刻意**不含** `autoTimeoutMs` / `autoCacheTtlMs` / `autoMaxMessages`：
 *   - 前两个只影响等待与缓存寿命，不影响判定内容，纳入只会让改超时白白清空缓存；
 *   - autoMaxMessages 已通过 state 文本体现（改变条数就会改变 state）。
 *
 * provider 用实例的 `name`（它本身由 provider 配置派生），model / 门槛现读现取，
 * 因此本函数必须**在每次决策时调用**，而不能在装配期算一次。
 *
 * @param {object} config - 插件配置（volatile 字段经 readString/readNumber 脱壳）
 * @param {object} provider - 当前提供商实例
 * @param {string} scenariosRef - 场景库指纹（见 scenariosFingerprint）
 * @returns {string} 形如 `customer_service|unisound|u2-decision|0.6|0.35|11:customer_service,…`
 */
function decisionFingerprint(config, provider, scenariosRef) {
  return [
    readString(config, 'autoScenario', ''),
    readString(provider, 'name', ''),
    readString(config, 'model', ''),
    String(readNumber(config, 'autoMinConfidence', AUTO_DEFAULTS.autoMinConfidence)),
    String(readNumber(config, 'autoRouteMinConfidence', AUTO_DEFAULTS.autoRouteMinConfidence)),
    scenariosRef,
  ].join('|')
}

/**
 * 场景库指纹：场景总数 + 每个场景的 `id:title`。
 *
 * 自定义场景是热更新的，改一个别名/加一个场景都会让自动路由的候选集变化。
 * 用这个便宜字符串（远小于任何一次上游请求）换取"配置一改、缓存立即失效"。
 *
 * @param {object[]} scenarios - 场景库（活引用）
 * @returns {string}
 */
function scenariosFingerprint(scenarios) {
  const list = Array.isArray(scenarios) ? scenarios : []
  const parts = list.map((s) => `${s?.id ?? ''}:${s?.title ?? ''}`)
  return `${list.length}:${parts.join(',')}`
}

/**
 * 计算决策（带并发去重）。相同 state 且决策参数未变时只发一次上游请求。
 */
async function computeDecision({ agent, newText, provider, config, scenarios, cache, inFlight, signal, log, warnedScenarios, usage }) {
  const state = captureState(agent, newText, readNumber(config, 'autoMaxMessages', AUTO_DEFAULTS.autoMaxMessages))
  // key = state 文本 + 决策指纹：state 决定"问什么"，指纹决定"按什么配置问"
  const key = hashString(`${state}\u0000${decisionFingerprint(config, provider, scenariosFingerprint(scenarios))}`)
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
    usage,
  }).finally(() => {
    if (inFlight.get(key) === promise) inFlight.delete(key)
  })
  inFlight.set(key, promise)
  return promise
}

async function decide({ agent, newText, state, key, provider, config, scenarios, cache, signal, log, warnedScenarios, usage }) {
  const ttl = readNumber(config, 'autoCacheTtlMs', AUTO_DEFAULTS.autoCacheTtlMs) || 0
  if (ttl > 0) {
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < ttl) return hit.result
  }

  // 1) 选场景：固定绑定，或让模型做一次自动路由
  const routed = await resolveScenario({ state, provider, config, scenarios, signal, log, warnedScenarios, usage })
  if (!routed) return null

  // 路由置信度不足：宁可不注入，也不要塞一个瞎猜的结论
  const floor = readNumber(config, 'autoRouteMinConfidence', AUTO_DEFAULTS.autoRouteMinConfidence)
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
    minConfidence: readNumber(config, 'autoMinConfidence', AUTO_DEFAULTS.autoMinConfidence),
    usage,
  })
  if (!result?.ok) {
    // 上游明确回答"决策失败"：closed 档必须上抛，让 pre-step 的 catch 按语义拦截；
    // open 档维持原行为：warn + 不注入（= 放行）。
    if (isFailClosed(config)) {
      throw new Error(`场景 ${routed.scenario.id} 执行失败：${result?.error || '未知错误'}`)
    }
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

/**
 * 自动路由分批题的问题 id 前缀。
 *
 * 必须与"场景自己的问题 id"不可能相撞：场景问题 id 由用户定义，`scenario_0`
 * 这种名字（正好也是 practice 里常见的场景 id 形态）会与之冲突，导致消费方
 * 无法区分"这是路由题"还是"这是场景决策题"。用带命名空间的前缀 + 双下划线。
 */
const ROUTE_QUESTION_PREFIX = 'systemone_route__'

/**
 * 把场景清单切成每个不超过 MAX_CHOICE_OPTIONS 个选项的批次。
 *
 * 上游决策模型对单道 choice 的选项数有硬限制，而自动路由原本把**全部**场景塞进
 * 一道题——11 个内置 + 15 个自定义即越界，且越界的问题不经过任何校验，只会被上游
 * 拒绝（表现为路由静默失效）。分批后每道题都在限制内。
 *
 * @param {object[]} scenarios - 场景库
 * @returns {object[][]} 批次数组；场景数不超限时只有一个批次
 */
function chunkScenarios(scenarios) {
  const size = Math.max(1, MAX_CHOICE_OPTIONS)
  const batches = []
  for (let i = 0; i < scenarios.length; i += size) {
    batches.push(scenarios.slice(i, i + size))
  }
  return batches
}

/** 选择场景：固定绑定优先，否则用一次分批 choice 问句自动路由。 */
async function resolveScenario({ state, provider, config, scenarios, signal, log, warnedScenarios, usage }) {
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

  // 场景数超过单道 choice 的上限时拆成多道题，一次请求并行问出（题目之间相互独立）
  const batches = chunkScenarios(scenarios)
  const questions = {}
  batches.forEach((batch, index) => {
    questions[`${ROUTE_QUESTION_PREFIX}${index}`] = {
      type: 'choice',
      instructions: batches.length === 1
        ? '这段内容最需要哪一类业务判断？'
        : `这段内容最需要哪一类业务判断？（第 ${index + 1}/${batches.length} 组；若都不匹配，选组内语义最近的一项）`,
      criteria: Object.fromEntries(batch.map((s) => [s.id, s.title])),
    }
  })

  const response = await provider.decide({
    state,
    questions,
    model: readString(config, 'model', ''),
    signal,
  })
  // 记账：路由请求不经过 executeDecision，必须在这里单独记，否则自动路由的花销完全不可见。
  // 注意别重复计：目标场景那次决策由 runScenarioDecision → executeDecision 统一记账。
  recordUsage(usage, {
    source: 'auto-route',
    ok: true,
    model: response?.model || readString(config, 'model', ''),
    provider: provider.name,
    usage: response?.usage,
    latencyMs: response?.latency_ms,
  })
  // 每题各选出一个候选，取置信度最高的那题作为路由结果；
  // 置信度不可用时按题目顺序（第 1 组优先），保持确定性。
  const answers = response?.answers || {}
  const candidates = []
  batches.forEach((_batch, index) => {
    const answer = answers[`${ROUTE_QUESTION_PREFIX}${index}`]
    const scenario = answer?.choice ? findScenario(scenarios, answer.choice) : undefined
    if (scenario) candidates.push({ scenario, confidence: Number(answer?.confidence) })
  })
  if (candidates.length === 0) {
    // 路由题全部无法映射回场景 = 上游给了不可用的回答，与请求异常同级。
    // closed 档上抛拦截本轮；open 档维持"静默不注入"。
    if (isFailClosed(config)) {
      throw new Error('自动路由没有产出任何可映射到场景的回答')
    }
    return null
  }
  candidates.sort((a, b) => {
    const ac = Number.isFinite(a.confidence) ? a.confidence : -1
    const bc = Number.isFinite(b.confidence) ? b.confidence : -1
    return bc - ac
  })
  const best = candidates[0]
  return { scenario: best.scenario, source: '自动路由', confidence: best.confidence }
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
  if (result.needs_human_review) {
    // 带上判定理由：只写"置信度偏低"会让模型无法判断该不该采信这条结论
    const reasons = Array.isArray(result.review_reasons) && result.review_reasons.length > 0
      ? `（${result.review_reasons.slice(0, 2).join('；')}）`
      : ''
    lines.push(`注意：本次判断的可能分布不够集中${reasons}，请人工确认后再执行。`)
  }

  return lines.join('\n')
}

function questionLabel(scenario, qid) {
  return scenario?.questions?.[qid]?.label || qid
}

/* ─── 上下文捕获 ───────────────────────────────────────────────────────────── */

/**
 * 判断是否应当跳过自动决策：**只有"短促"且"整体是寒暄"才跳过**。
 *
 * 语义（0.6.0 起修正）：早期实现是"短于 autoMinChars 一律跳过"的**或**关系，
 * 在中文里会静默误杀完整的业务请求——"退款""报错""超时""闪退"都只有 2 个字，
 * 却都是真实请求，结果是开了自动决策却什么都不发生、且没有任何日志。
 *
 * 现在两条规则取**交集**：
 *   1. `TRIVIAL_PATTERN` 是整体匹配（`^…$`），单独一条就足以识别寒暄；
 *   2. `autoMinChars` 从"长度下限"变为**寒暄判定的长度上界**——超过这个长度
 *      即使内容是"你好…"也交给模型判断（如「你好，我的订单一直没到账」）。
 *
 * 注意：`autoMinChars: 0` 表示**不做长度限制**，即只按寒暄黑名单判定。
 * 副作用：短业务请求现在会真的发起一次上游调用（有 token 与延迟成本）。
 */
const TRIVIAL_PATTERN = /^(你好|您好|哈喽|在吗|hi|hello|hey|ok|okay|好的|好嘞|收到|明白|嗯+|谢谢|多谢|感谢|thanks|thank you|thx|再见|拜拜|bye|测试|test)[\s!！。.~～,，、?？]*$/i

function isTrivialInput(text, minChars) {
  const trimmed = text.trim()
  // 只按寒暄黑名单判定（不做长度限制）
  if (!Number.isFinite(minChars) || minChars <= 0) return TRIVIAL_PATTERN.test(trimmed)
  // 短 + 整体是寒暄：两个条件同时成立才跳过
  return trimmed.length < minChars && TRIVIAL_PATTERN.test(trimmed)
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

    if (event.type === 'user/message' && message?.source?.kind === INJECTED_SOURCE) continue
    const text = textOfMessage(message)
    if (text) picked.unshift(`- ${event.type === 'user/message' ? '用户' : '助手'}：${truncate(text, HISTORY_CHARS_PER_MESSAGE)}`)
  }
  return picked
}

function extractUserText(messages) {
  const texts = []
  for (const message of messages || []) {
    if (message?.role !== 'user') continue
    if (message?.source?.kind === INJECTED_SOURCE) continue
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

/** 构造本插件自己的注入消息（UserMessage）；kind 见 INJECTED_SOURCE 的说明。 */
function buildContextMessage(text) {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: INJECTED_SOURCE },
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