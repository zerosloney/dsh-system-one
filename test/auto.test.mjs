/**
 * auto.test.mjs — 自动决策注入的行为测试。
 *
 * 用假 ctx 捕获 agent/pre-step 与 agent/created 监听器，验证：
 * 开关、注入形状、fail-open、超时、缓存、跳过规则、历史捕获、自动路由。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { installAutoDecide } from '../lib/auto.js'
import { MockProvider } from '../lib/provider.js'
import { resolveScenarios } from '../lib/scenarios.js'

const { scenarios } = resolveScenarios('')

const BASE_CONFIG = {
  autoDecide: true,
  autoScenario: 'customer_service',
  autoInject: 'message',
  autoTimeoutMs: 5000,
  autoMaxMessages: 3,
  autoCacheTtlMs: 60000,
  autoMinConfidence: 0.6,
  autoRouteMinConfidence: 0.35,
  autoMinChars: 4,
  model: 'u2-decision',
  minConfidence: 0.6,
}

/** 假上下文：记录监听器，可手动触发。 */
function fakeCtx() {
  const handlers = new Map()
  const warnings = []
  const infos = []
  return {
    handlers,
    warnings,
    infos,
    ctx: {
      logger: { warn: (m) => warnings.push(String(m)), info: (m) => infos.push(String(m)) },
      on(event, handler) {
        if (!handlers.has(event)) handlers.set(event, [])
        handlers.get(event).push(handler)
        return () => {
          const list = handlers.get(event) || []
          const i = list.indexOf(handler)
          if (i >= 0) list.splice(i, 1)
        }
      },
    },
  }
}

/** 计数的 mock 提供商。 */
function countingProvider(inner = new MockProvider({})) {
  const stats = { calls: 0 }
  return {
    name: inner.name,
    stats,
    async decide(options) {
      stats.calls += 1
      return inner.decide(options)
    },
  }
}

function agentWith(history = []) {
  return {
    id: 'session-test',
    session: {
      log: history.map((h, i) => ({
        type: h.role === 'assistant' ? 'assistant/message' : 'user/message',
        seq: i,
        data: h.role === 'assistant'
          ? { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: h.text }] } }
          : { role: 'user', content: [{ type: 'text', text: h.text }], ...(h.source ? { source: h.source } : {}) },
      })),
    },
  }
}

function userMessage(text, extra = {}) {
  return { role: 'user', content: [{ type: 'text', text }], ...extra }
}

const unchanged = () => Promise.resolve({ kind: 'enter', messages: [userMessage('原消息')] })

/* ─── 开关 ────────────────────────────────────────────────────────────────── */

test('默认关闭：不注册任何监听器', () => {
  const { ctx, handlers } = fakeCtx()
  const dispose = installAutoDecide(ctx, {
    provider: countingProvider(), config: { ...BASE_CONFIG, autoDecide: false }, scenarios,
  })
  assert.equal(handlers.get('agent/pre-step')?.length ?? 0, 0)
  assert.equal(handlers.get('agent/created')?.length ?? 0, 0)
  dispose()
})

test('开启后注册 pre-step 监听器，卸载后移除', () => {
  const { ctx, handlers } = fakeCtx()
  const dispose = installAutoDecide(ctx, {
    provider: countingProvider(), config: BASE_CONFIG, scenarios,
  })
  assert.equal(handlers.get('agent/pre-step').length, 1)
  dispose()
  assert.equal(handlers.get('agent/pre-step').length, 0)
})

/* ─── 注入形状 ────────────────────────────────────────────────────────────── */

test('autoInject=message：同一步追加一条本插件自有 kind 的消息（不复用宿主 runtime-context）', async () => {
  const { ctx, handlers, infos } = fakeCtx()
  const provider = countingProvider()
  installAutoDecide(ctx, { provider, config: BASE_CONFIG, scenarios, logger: ctx.logger })

  const [handler] = handlers.get('agent/pre-step')
  const agent = agentWith()
  const claimed = [userMessage('我的订单支付后 24 小时还没到账，赶紧处理')]
  const decision = await handler(
    { agent, messages: claimed, turn: 1, step: 1, signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'enter', messages: claimed }),
  )

  assert.equal(decision.kind, 'enter')
  assert.equal(decision.messages.length, 2)
  const injected = decision.messages[1]
  assert.equal(injected.role, 'user')
  // 关键回归：宿主 RuntimeContextProjection 仅凭 kind==='runtime-context' 认自己的快照，
  // 复用该 kind 会让宿主每步多追加一条冗余快照。本插件必须用自己的 kind。
  assert.equal(injected.source.kind, 'systemone-decision')
  assert.notEqual(injected.source.kind, 'runtime-context')
  assert.match(injected.content[0].text, /SystemOne 自动决策/)
  assert.match(injected.content[0].text, /建议：/)
  assert.equal(provider.stats.calls, 1)      // 固定场景，无路由请求
  assert.ok(infos.some((m) => m.includes('自动决策完成')))
})

test('autoInject=context：不改写 messages，入箱预计算后走动态上下文', async () => {
  const { ctx, handlers } = fakeCtx()
  const registered = []
  const agentCtx = {
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(handler)
      return () => {
        const list = handlers.get(event) || []
        const i = list.indexOf(handler)
        if (i >= 0) list.splice(i, 1)
      }
    },
    systemPrompt: {
      context(spec) {
        registered.push(spec)
        return () => {}
      },
    },
  }
  installAutoDecide(ctx, {
    provider: countingProvider(),
    config: { ...BASE_CONFIG, autoInject: 'context' },
    scenarios,
    logger: ctx.logger,
  })

  const [onCreated] = handlers.get('agent/created')
  onCreated({ agent: { id: 'a1', ctx: agentCtx } })
  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, 'systemone-auto-decision')
  assert.equal(registered[0].text(), '')      // 尚未决策

  // 入箱预计算：消息进入 inbox 后，上下文在 pre-step 之前就已就绪
  const [onInserted] = handlers.get('agent/inbox/inserted')
  await onInserted({ message: userMessage('发票开错了，需要重开') })
  assert.match(registered[0].text(), /SystemOne 自动决策/)

  // pre-step 不改写 messages
  const [handler] = handlers.get('agent/pre-step')
  const claimed = [userMessage('发票开错了，需要重开')]
  const decision = await handler(
    { agent: { id: 'a1' }, messages: claimed, turn: 1, step: 1, signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'enter', messages: claimed }),
  )
  assert.deepEqual(decision.messages, claimed)          // 未注入消息
  assert.match(registered[0].text(), /SystemOne 自动决策/)  // 上下文已就绪
})

test('autoInject=context：寒暄入箱不触发预计算', async () => {
  const { ctx, handlers } = fakeCtx()
  const registered = []
  const agentCtx = {
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(handler)
      return () => {}
    },
    systemPrompt: {
      context(spec) {
        registered.push(spec)
        return () => {}
      },
    },
  }
  const provider = countingProvider()
  installAutoDecide(ctx, {
    provider,
    config: { ...BASE_CONFIG, autoInject: 'context' },
    scenarios,
    logger: ctx.logger,
  })

  const [onCreated] = handlers.get('agent/created')
  onCreated({ agent: { id: 'a1', ctx: agentCtx } })
  const [onInserted] = handlers.get('agent/inbox/inserted')
  await onInserted({ message: userMessage('你好') })
  assert.equal(registered[0].text(), '')
  assert.equal(provider.stats.calls, 0)
})

/* ─── 跳过规则 ────────────────────────────────────────────────────────────── */

test('无新用户消息（工具结果步骤）不触发', async () => {
  const { ctx, handlers } = fakeCtx()
  const provider = countingProvider()
  installAutoDecide(ctx, { provider, config: BASE_CONFIG, scenarios, logger: ctx.logger })

  const [handler] = handlers.get('agent/pre-step')
  const decision = await handler(
    { agent: agentWith(), messages: [], turn: 1, step: 2, signal: new AbortController().signal },
    unchanged,
  )
  assert.equal(provider.stats.calls, 0)
  assert.equal(decision.messages.length, 1)
})

test('斜杠命令不触发', async () => {
  const { ctx, handlers } = fakeCtx()
  const provider = countingProvider()
  installAutoDecide(ctx, { provider, config: BASE_CONFIG, scenarios, logger: ctx.logger })

  const [handler] = handlers.get('agent/pre-step')
  await handler(
    { agent: agentWith(), messages: [userMessage('/plan')], turn: 1, step: 1, signal: new AbortController().signal },
    unchanged,
  )
  assert.equal(provider.stats.calls, 0)
})

/* ─── fail-open ───────────────────────────────────────────────────────────── */

test('提供商报错时放行，不改写 messages', async () => {
  const { ctx, handlers, warnings } = fakeCtx()
  const failing = { name: 'failing', async decide() { throw new Error('上游 503') } }
  installAutoDecide(ctx, { provider: failing, config: BASE_CONFIG, scenarios, logger: ctx.logger })

  const [handler] = handlers.get('agent/pre-step')
  const claimed = [userMessage('订单支付后超过 24 小时仍未到账，用户要求立即处理')]
  const decision = await handler(
    { agent: agentWith(), messages: claimed, turn: 1, step: 1, signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'enter', messages: claimed }),
  )
  assert.deepEqual(decision.messages, claimed)
  assert.ok(warnings.some((w) => w.includes('已放行')))
})

test('超时后放行（不会一直等）', async () => {
  const { ctx, handlers } = fakeCtx()
  const slow = {
    name: 'slow',
    // 慢提供商：等到超时 abort 才落定。
    // keepAlive 必须是 ref 定时器：被测的超时定时器全是 unref 的（生产语义：
    // 不拖住宿主进程），而测试进程里没有其他句柄，事件循环会在 ~20ms 处被
    // 提前抽干，node 22 的 runner 判 "Promise resolution is still pending"
    // 并连坐取消后续测试（CI 自 v0.5.0 起红屏的根因）。它把循环撑到承诺落定。
    decide: ({ signal }) => new Promise((resolve) => {
      const done = () => { clearTimeout(keepAlive); resolve({ answers: {} }) }
      const keepAlive = setTimeout(done, 900)
      if (signal?.aborted) return done()
      signal?.addEventListener('abort', done, { once: true })
    }),
  }
  installAutoDecide(ctx, {
    provider: slow,
    config: { ...BASE_CONFIG, autoTimeoutMs: 600 },
    scenarios,
    logger: ctx.logger,
  })

  const [handler] = handlers.get('agent/pre-step')
  const claimed = [userMessage('慢请求')]
  const started = Date.now()
  const decision = await handler(
    { agent: agentWith(), messages: claimed, turn: 1, step: 1, signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'enter', messages: claimed }),
  )
  assert.ok(Date.now() - started < 1500, '应在超时后尽快返回')
  assert.deepEqual(decision.messages, claimed)
})

/* ─── fail-closed（autoFailMode='closed'，为将来做闸门预留的语义档） ─────── */

test('closed：提供商报错时返回 reject（宿主把本轮 turn 记为 blocked）', async () => {
  const { ctx, handlers, warnings } = fakeCtx()
  const failing = { name: 'failing', async decide() { throw new Error('上游 503') } }
  installAutoDecide(ctx, {
    provider: failing,
    config: { ...BASE_CONFIG, autoFailMode: 'closed' },
    scenarios,
    logger: ctx.logger,
  })

  const [handler] = handlers.get('agent/pre-step')
  const claimed = [userMessage('订单支付后超过 24 小时仍未到账，用户要求立即处理')]
  const decision = await handler(
    { agent: agentWith(), messages: claimed, turn: 1, step: 1, signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'enter', messages: claimed }),
  )
  // 宿主 @deepseek-ai/dsh-agent 的 PreStepDecision 契约：reject 无附加字段
  assert.deepEqual(decision, { kind: 'reject' })
  assert.ok(warnings.some((w) => w.includes('fail-closed')), '拦截必须留 warn 痕迹')
})

test('closed：场景执行失败（上游空决策 ok:false）同样拦截', async () => {
  const { ctx, handlers } = fakeCtx()
  const empty = { name: 'empty', async decide() { return { answers: {} } } }
  installAutoDecide(ctx, {
    provider: empty,
    config: { ...BASE_CONFIG, autoFailMode: 'closed' },
    scenarios,
    logger: ctx.logger,
  })

  const [handler] = handlers.get('agent/pre-step')
  const claimed = [userMessage('订单支付后超过 24 小时仍未到账，需要判断归属')]
  const decision = await handler(
    { agent: agentWith(), messages: claimed, turn: 1, step: 1, signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'enter', messages: claimed }),
  )
  assert.deepEqual(decision, { kind: 'reject' })
})

test('closed：主动跳过（寒暄）不是失败，必须放行', async () => {
  const { ctx, handlers } = fakeCtx()
  const provider = countingProvider()
  installAutoDecide(ctx, {
    provider,
    config: { ...BASE_CONFIG, autoFailMode: 'closed' },
    scenarios,
    logger: ctx.logger,
  })

  const [handler] = handlers.get('agent/pre-step')
  const claimed = [userMessage('谢谢')]
  const decision = await handler(
    { agent: agentWith(), messages: claimed, turn: 1, step: 1, signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'enter', messages: claimed }),
  )
  assert.equal(decision.kind, 'enter', '低置信度/寒暄/斜杠是"主动不注入"，closed 也不得拦截')
  assert.equal(provider.stats.calls, 0)
})

/* ─── 缓存 ────────────────────────────────────────────────────────────────── */

test('相同内容命中缓存，只请求一次', async () => {
  const { ctx, handlers } = fakeCtx()
  const provider = countingProvider()
  installAutoDecide(ctx, { provider, config: BASE_CONFIG, scenarios, logger: ctx.logger })

  const [handler] = handlers.get('agent/pre-step')
  const payload = { agent: agentWith(), messages: [userMessage('订单支付后超过 24 小时仍未到账，需要判断归属')], turn: 1, step: 1, signal: new AbortController().signal }
  await handler(payload, unchanged)
  await handler(payload, unchanged)
  assert.equal(provider.stats.calls, 1)
})

test('autoCacheTtlMs=0 时不缓存', async () => {
  const { ctx, handlers } = fakeCtx()
  const provider = countingProvider()
  installAutoDecide(ctx, {
    provider, config: { ...BASE_CONFIG, autoCacheTtlMs: 0 }, scenarios, logger: ctx.logger,
  })

  const [handler] = handlers.get('agent/pre-step')
  const payload = { agent: agentWith(), messages: [userMessage('订单支付后超过 24 小时仍未到账，需要判断归属')], turn: 1, step: 1, signal: new AbortController().signal }
  await handler(payload, unchanged)
  await handler(payload, unchanged)
  assert.equal(provider.stats.calls, 2)
})

test('裸配置走默认值：默认 ttl 下缓存生效', async () => {
  const { ctx, handlers } = fakeCtx()
  const provider = countingProvider()
  // 不提供任何 auto 数字字段，兜底值由 AUTO_DEFAULTS 提供（ttl 默认 60000，不再是不缓存）
  const config = {
    autoDecide: true,
    autoScenario: 'customer_service',
    autoInject: 'message',
    model: 'u2-decision',
    minConfidence: 0.6,
  }
  installAutoDecide(ctx, { provider, config, scenarios, logger: ctx.logger })

  const [handler] = handlers.get('agent/pre-step')
  const payload = { agent: agentWith(), messages: [userMessage('订单支付后超过 24 小时仍未到账，需要判断归属')], turn: 1, step: 1, signal: new AbortController().signal }
  await handler(payload, unchanged)
  await handler(payload, unchanged)
  assert.equal(provider.stats.calls, 1, '默认 ttl=60000 生效，相同内容只请求一次')
})

test('决策参数变化时缓存失效：改固定场景后立即重新决策（不再注入旧结论）', async () => {
  const { ctx, handlers } = fakeCtx()
  const provider = countingProvider()
  // 用同一个可变配置对象模拟宿主的 volatile 引用：配置页保存后**原地**换值
  const config = { ...BASE_CONFIG, autoScenario: 'customer_service' }
  installAutoDecide(ctx, { provider, config, scenarios, logger: ctx.logger })

  const [handler] = handlers.get('agent/pre-step')
  const payload = { agent: agentWith(), messages: [userMessage('订单支付后超过 24 小时仍未到账，需要判断归属')], turn: 1, step: 1, signal: new AbortController().signal }

  const first = await handler(payload, unchanged)
  assert.equal(provider.stats.calls, 1)
  assert.equal(first.messages[1].source.kind, 'systemone-decision')

  // 同一 state、纯配置变更：缓存 key 必须随之改变，否则 60 秒内会继续注入 customer_service 的旧结论
  config.autoScenario = 'risk_control'
  const second = await handler(payload, unchanged)
  assert.equal(provider.stats.calls, 2, '改固定场景后应重新决策，而不是命中旧缓存')
  assert.match(second.messages[1].content[0].text, /金融风控/)

  // 配置未再变化时，仍应命中缓存（缓存本身没有被削弱）
  const third = await handler(payload, unchanged)
  assert.equal(provider.stats.calls, 2, '配置未变时应命中缓存')
  assert.equal(third.messages.length, 1, '同一决策不重复注入')
})

test('决策参数变化时缓存失效：换 model 后立即重新决策', async () => {
  const { ctx, handlers } = fakeCtx()
  const provider = countingProvider()
  const config = { ...BASE_CONFIG, model: 'u2-decision' }
  installAutoDecide(ctx, { provider, config, scenarios, logger: ctx.logger })

  const [handler] = handlers.get('agent/pre-step')
  const payload = { agent: agentWith(), messages: [userMessage('订单支付后超过 24 小时仍未到账，需要判断归属')], turn: 1, step: 1, signal: new AbortController().signal }

  await handler(payload, unchanged)
  assert.equal(provider.stats.calls, 1)

  config.model = 'u2-decision-pro'
  await handler(payload, unchanged)
  assert.equal(provider.stats.calls, 2, '换 model 后应重新决策')
})

test('裸配置走默认值：路由置信度低于 0.35 门槛时不注入', async () => {
  const { ctx, handlers } = fakeCtx()
  // 路由返回低于默认门槛（AUTO_DEFAULTS.autoRouteMinConfidence = 0.35）的置信度
  const provider = {
    name: 'lowconf',
    calls: 0,
    async decide(options) {
      this.calls += 1
      if (options.questions?.scenario) {   // 路由问句
        const ids = Object.keys(options.questions.scenario.criteria || {})
        return {
          answers: {
            scenario: {
              type: 'choice',
              choice: ids[0],
              probabilities: Object.fromEntries(ids.map((id, i) => [id, i === 0 ? 0.2 : 0.8 / (ids.length - 1)])),
              confidence: 0.2,
            },
          },
        }
      }
      return new MockProvider({}).decide(options)   // 场景执行问句
    },
  }
  // 不提供 autoRouteMinConfidence，兜底值由 AUTO_DEFAULTS 提供（默认 0.35，不再是不设门槛）
  const config = {
    autoDecide: true,
    autoScenario: '',
    autoInject: 'message',
    model: 'u2-decision',
    minConfidence: 0.6,
  }
  installAutoDecide(ctx, { provider, config, scenarios, logger: ctx.logger })

  const [handler] = handlers.get('agent/pre-step')
  const claimed = [userMessage('一段足够长的业务内容用于路由判断')]
  const decision = await handler(
    { agent: agentWith(), messages: claimed, turn: 1, step: 1, signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'enter', messages: claimed }),
  )
  assert.deepEqual(decision.messages, claimed, '低于默认门槛不应注入')
  assert.equal(provider.calls, 1, '只发生路由请求，不应继续执行场景')
})

/* ─── 去重 ────────────────────────────────────────────────────────────────── */

test('去重：同一决策文本只注入一次', async () => {
  const { ctx, handlers } = fakeCtx()
  const provider = countingProvider()
  installAutoDecide(ctx, { provider, config: BASE_CONFIG, scenarios, logger: ctx.logger })

  const [handler] = handlers.get('agent/pre-step')
  const payload = {
    agent: agentWith(),
    messages: [userMessage('订单支付后超过 24 小时仍未到账，需要判断归属')],
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  }
  const next = () => Promise.resolve({ kind: 'enter', messages: payload.messages })

  const first = await handler(payload, next)
  assert.equal(first.messages.length, 2, '首次注入一条决策消息')

  const second = await handler(payload, next)
  assert.equal(second.messages.length, 1, '相同决策不重复注入')
  assert.equal(provider.stats.calls, 1, '缓存命中，不重复请求')
})

test('决策变化后才再次注入', async () => {
  const { ctx, handlers } = fakeCtx()
  const provider = countingProvider()
  installAutoDecide(ctx, {
    provider,
    config: { ...BASE_CONFIG, autoScenario: '', autoRouteMinConfidence: 0 },
    scenarios,
    logger: ctx.logger,
  })

  const [handler] = handlers.get('agent/pre-step')
  const agent = agentWith()
  const makeNext = (messages) => () => Promise.resolve({ kind: 'enter', messages })
  const base = { agent, turn: 1, step: 1, signal: new AbortController().signal }

  const firstMessages = [userMessage('这笔交易在 3 分钟内跨省登录并发起 5 笔大额转账')]
  const first = await handler({ ...base, messages: firstMessages }, makeNext(firstMessages))
  assert.equal(first.messages.length, 2, '首次注入')

  // 相同内容：缓存命中，决策不变 → 不注入
  const secondMessages = [userMessage('这笔交易在 3 分钟内跨省登录并发起 5 笔大额转账')]
  const second = await handler({ ...base, messages: secondMessages }, makeNext(secondMessages))
  assert.equal(second.messages.length, 1, '决策未变不注入')

  // 不同内容：state 变化 → 新决策 → 再次注入
  const thirdMessages = [userMessage('用户投诉客服态度恶劣，要求升级处理')]
  const third = await handler({ ...base, messages: thirdMessages }, makeNext(thirdMessages))
  assert.equal(third.messages.length, 2, '决策变化后再次注入')
  assert.ok(provider.stats.calls >= 2, '新内容应重新请求')
})

/* ─── 历史捕获 ────────────────────────────────────────────────────────────── */

test('捕获会话历史，并排除自己注入的运行时上下文', async () => {
  const { ctx, handlers } = fakeCtx()
  const seen = []
  const provider = {
    name: 'spy',
    async decide(options) {
      seen.push(options.state)
      return new MockProvider({}).decide(options)
    },
  }
  installAutoDecide(ctx, { provider, config: BASE_CONFIG, scenarios, logger: ctx.logger })

  const agent = agentWith([
    { role: 'user', text: '历史问题一' },
    { role: 'assistant', text: '历史回答一' },
    { role: 'user', text: '我注入的上下文', source: { kind: 'systemone-decision' } },
    { role: 'user', text: '宿主自己的动态上下文快照', source: { kind: 'runtime-context' } },
  ])
  const [handler] = handlers.get('agent/pre-step')
  await handler(
    { agent, messages: [userMessage('发票开错了，需要重新开具')], turn: 1, step: 1, signal: new AbortController().signal },
    unchanged,
  )

  assert.equal(seen.length, 1)
  assert.match(seen[0], /【近期对话】/)
  assert.match(seen[0], /历史问题一/)
  assert.match(seen[0], /历史回答一/)
  assert.match(seen[0], /【当前请求】/)
  assert.match(seen[0], /当前请求/)
  assert.ok(!seen[0].includes('我注入的上下文'), '不应把自己注入的决策喂回模型')
  // 排除必须精确到自己的 kind：宿主的 runtime-context 是合法历史，不该被一起丢掉
  assert.ok(seen[0].includes('宿主自己的动态上下文快照'), '宿主的动态上下文应保留在历史里')
})

/* ─── 自动路由 ────────────────────────────────────────────────────────────── */

test('autoScenario 留空时先路由再决策（多一次请求）', async () => {
  const { ctx, handlers } = fakeCtx()
  const provider = countingProvider()
  installAutoDecide(ctx, {
    // 路由门槛设为 0：本例验证"路由确实发生"，门槛行为由另一个用例覆盖
    provider,
    config: { ...BASE_CONFIG, autoScenario: '', autoRouteMinConfidence: 0 },
    scenarios,
    logger: ctx.logger,
  })

  const [handler] = handlers.get('agent/pre-step')
  const claimed = [userMessage('这笔交易在 3 分钟内跨省登录并发起 5 笔大额转账')]
  const decision = await handler(
    { agent: agentWith(), messages: claimed, turn: 1, step: 1, signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'enter', messages: claimed }),
  )

  assert.equal(provider.stats.calls, 2)   // 路由 + 场景决策
  assert.match(decision.messages[1].content[0].text, /自动路由/)
})

test('固定绑定未知场景时不注入', async () => {
  const { ctx, handlers } = fakeCtx()
  const provider = countingProvider()
  installAutoDecide(ctx, {
    provider, config: { ...BASE_CONFIG, autoScenario: 'no_such_scenario' }, scenarios, logger: ctx.logger,
  })

  const [handler] = handlers.get('agent/pre-step')
  const claimed = [userMessage('一段足够长的业务内容用于测试')]
  const decision = await handler(
    { agent: agentWith(), messages: claimed, turn: 1, step: 1, signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'enter', messages: claimed }),
  )
  assert.deepEqual(decision.messages, claimed)
  assert.equal(provider.stats.calls, 0)
})

/* ─── 回归：否决不能被改写 ────────────────────────────────────────────────── */

test('其他监听器 reject 时，绝不改写成 enter（回归）', async () => {
  const { ctx, handlers } = fakeCtx()
  const provider = countingProvider()
  installAutoDecide(ctx, { provider, config: BASE_CONFIG, scenarios, logger: ctx.logger })

  const [handler] = handlers.get('agent/pre-step')
  const claimed = [userMessage('这是一条足够长的工单内容，需要判断')]
  const decision = await handler(
    { agent: agentWith(), messages: claimed, turn: 1, step: 1, signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'reject' }),
  )
  assert.equal(decision.kind, 'reject', '插件不得覆盖其他监听器的否决')
})

/* ─── 回归：过短输入 ──────────────────────────────────────────────────────── */

test('短促寒暄不触发', async () => {
  const { ctx, handlers } = fakeCtx()
  const provider = countingProvider()
  installAutoDecide(ctx, { provider, config: BASE_CONFIG, scenarios, logger: ctx.logger })

  const [handler] = handlers.get('agent/pre-step')
  // 全是"短 + 整体寒暄"：长度都 < autoMinChars(4)
  for (const text of ['你好', '谢谢', 'ok', '好的', '在吗？', '嗯嗯']) {
    await handler(
      { agent: agentWith(), messages: [userMessage(text)], turn: 1, step: 1, signal: new AbortController().signal },
      unchanged,
    )
  }
  assert.equal(provider.stats.calls, 0)
})

test('寒暄词但不算短（超过 autoMinChars）仍交给模型判断', async () => {
  const { ctx, handlers } = fakeCtx()
  const provider = countingProvider()
  installAutoDecide(ctx, { provider, config: BASE_CONFIG, scenarios, logger: ctx.logger })

  const [handler] = handlers.get('agent/pre-step')
  // "Thanks!" 命中寒暄黑名单，但有 7 个字符、超过 autoMinChars(4)。
  // 旧语义（短 或 寒暄）会跳过它；新语义要求"短 且 寒暄"，因此放行给模型。
  await handler(
    { agent: agentWith(), messages: [userMessage('Thanks!')], turn: 1, step: 1, signal: new AbortController().signal },
    unchanged,
  )
  assert.equal(provider.stats.calls, 1, '长寒暄不再被长度阈值跳过，交由模型判断')
})

test('短但非寒暄的业务请求必须触发（长度阈值不得误伤）', async () => {
  const { ctx, handlers } = fakeCtx()
  const provider = countingProvider()
  installAutoDecide(ctx, { provider, config: BASE_CONFIG, scenarios, logger: ctx.logger })

  const [handler] = handlers.get('agent/pre-step')
  // 这些在中文里都是完整请求，却都短于默认阈值 4 —— 旧语义下会被静默丢弃
  for (const text of ['退款', '报错', '超时', '闪退', '卡了']) {
    await handler(
      { agent: agentWith(), messages: [userMessage(text)], turn: 1, step: 1, signal: new AbortController().signal },
      unchanged,
    )
  }
  assert.equal(provider.stats.calls, 5, '短促业务请求不应被长度阈值静默丢弃')
})

test('寒暄+业务内容不应被误判为寒暄', async () => {
  const { ctx, handlers } = fakeCtx()
  const provider = countingProvider()
  installAutoDecide(ctx, { provider, config: BASE_CONFIG, scenarios, logger: ctx.logger })

  const [handler] = handlers.get('agent/pre-step')
  await handler(
    { agent: agentWith(), messages: [userMessage('你好，我的订单支付后一直没到账')], turn: 1, step: 1, signal: new AbortController().signal },
    unchanged,
  )
  assert.equal(provider.stats.calls, 1)
})

test('短但真实的业务请求仍会触发（长度阈值不该误伤）', async () => {
  const { ctx, handlers } = fakeCtx()
  const provider = countingProvider()
  installAutoDecide(ctx, { provider, config: BASE_CONFIG, scenarios, logger: ctx.logger })

  const [handler] = handlers.get('agent/pre-step')
  await handler(
    { agent: agentWith(), messages: [userMessage('退款失败')], turn: 1, step: 1, signal: new AbortController().signal },
    unchanged,
  )
  assert.equal(provider.stats.calls, 1, '"退款失败" 是真实请求，不应被跳过')
})

test('autoMinChars=0 时不按长度过滤（寒暄黑名单仍生效）', async () => {
  const { ctx, handlers } = fakeCtx()
  const provider = countingProvider()
  installAutoDecide(ctx, {
    provider, config: { ...BASE_CONFIG, autoMinChars: 0 }, scenarios, logger: ctx.logger,
  })

  const [handler] = handlers.get('agent/pre-step')
  // 非寒暄的极短输入：长度阈值关闭后应触发
  await handler(
    { agent: agentWith(), messages: [userMessage('退款')], turn: 1, step: 1, signal: new AbortController().signal },
    unchanged,
  )
  assert.equal(provider.stats.calls, 1)

  // 寒暄即使长度阈值关闭也应跳过（黑名单独立生效）
  await handler(
    { agent: agentWith(), messages: [userMessage('你好')], turn: 1, step: 1, signal: new AbortController().signal },
    unchanged,
  )
  assert.equal(provider.stats.calls, 1, '寒暄不应触发')
})

/* ─── 路由置信度门槛 ──────────────────────────────────────────────────────── */

test('路由置信度过低时跳过注入', async () => {
  const { ctx, handlers } = fakeCtx()
  // 路由返回极低置信度
  const provider = {
    name: 'lowconf',
    calls: 0,
    async decide(options) {
      this.calls += 1
      const ids = Object.keys(options.questions?.scenario?.criteria || {})
      return {
        answers: {
          scenario: {
            type: 'choice',
            choice: ids[0],
            probabilities: Object.fromEntries(ids.map((id, i) => [id, i === 0 ? 0.12 : 0.88 / (ids.length - 1)])),
            confidence: 0.12,
          },
        },
      }
    },
  }
  installAutoDecide(ctx, {
    provider,
    config: { ...BASE_CONFIG, autoScenario: '', autoRouteMinConfidence: 0.35 },
    scenarios,
    logger: ctx.logger,
  })

  const [handler] = handlers.get('agent/pre-step')
  const claimed = [userMessage('一段足够长的业务描述内容用于路由判断')]
  const decision = await handler(
    { agent: agentWith(), messages: claimed, turn: 1, step: 1, signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'enter', messages: claimed }),
  )
  assert.deepEqual(decision.messages, claimed, '低置信度不应注入')
  assert.equal(provider.calls, 1, '只发生路由请求，不应继续执行场景')
})

/* ─── 状态清理 ────────────────────────────────────────────────────────────── */

test('agent 销毁时清理其状态', async () => {
const { ctx, handlers } = fakeCtx()
installAutoDecide(ctx, {
  provider: countingProvider(), config: BASE_CONFIG, scenarios, logger: ctx.logger,
})

assert.equal(handlers.get('agent/disposed')?.length ?? 0, 1)
const [onDisposed] = handlers.get('agent/disposed')
onDisposed({ agent: { id: 'session-test' } }) // 不应抛错
})

test('agent 销毁时移除其 per-agent 监听器（不再泄漏）', () => {
const { ctx, handlers } = fakeCtx()
let contextDisposed = false
const agentCtx = {
  on(event, handler) {
    if (!handlers.has(event)) handlers.set(event, [])
    handlers.get(event).push(handler)
    return () => {
      const list = handlers.get(event) || []
      const i = list.indexOf(handler)
      if (i >= 0) list.splice(i, 1)
    }
  },
  systemPrompt: {
    context() {
      return () => { contextDisposed = true }
    },
  },
}
installAutoDecide(ctx, {
  provider: countingProvider(),
  config: { ...BASE_CONFIG, autoInject: 'context' },
  scenarios,
  logger: ctx.logger,
})

const [onCreated] = handlers.get('agent/created')
onCreated({ agent: { id: 'a1', ctx: agentCtx } })
assert.ok((handlers.get('agent/inbox/inserted')?.length ?? 0) >= 1, '入箱监听已注册')

const [onDisposed] = handlers.get('agent/disposed')
onDisposed({ agent: { id: 'a1' } })

assert.equal(handlers.get('agent/inbox/inserted')?.length ?? 0, 0, 'agent 销毁后入箱监听应被移除')
assert.equal(contextDisposed, true, '动态上下文注册应随 agent 销毁被释放')
})

test('卸载后所有监听器都被摘掉', () => {
  const { ctx, handlers } = fakeCtx()
  const dispose = installAutoDecide(ctx, {
    provider: countingProvider(),
    config: { ...BASE_CONFIG, autoInject: 'context' },
    scenarios,
    logger: ctx.logger,
  })
  assert.ok(handlers.get('agent/pre-step').length >= 1)
  assert.ok(handlers.get('agent/created').length >= 1)
  assert.ok(handlers.get('agent/disposed').length >= 1)

  dispose()
  for (const [, list] of handlers) assert.equal(list.length, 0)
})

/* ─── autoInject 热切换（volatile 字段，两个方向都应即时生效） ─────────────── */

test('autoInject 运行时从 message 切到 context：入箱预计算立即接管', async () => {
  const { ctx, handlers } = fakeCtx()
  const registered = []
  const agentCtx = {
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(handler)
      return () => {
        const list = handlers.get(event) || []
        const i = list.indexOf(handler)
        if (i >= 0) list.splice(i, 1)
      }
    },
    systemPrompt: {
      context(spec) {
        registered.push(spec)
        return () => {}
      },
    },
  }
  const provider = countingProvider()
  const config = { ...BASE_CONFIG }   // autoInject: 'message'
  installAutoDecide(ctx, { provider, config, scenarios, logger: ctx.logger })

  // message 模式下创建的 agent 也注册入箱监听与动态上下文（按当前配置门控）
  const [onCreated] = handlers.get('agent/created')
  onCreated({ agent: { id: 'a1', ctx: agentCtx } })
  assert.equal(registered.length, 1)

  const [onInserted] = handlers.get('agent/inbox/inserted')
  const message = userMessage('发票开错了，需要重新开具')
  await onInserted({ message })
  assert.equal(provider.stats.calls, 0, 'message 通道下入箱不预计算')
  assert.equal(registered[0].text(), '')

  config.autoInject = 'context'   // 热切换，无需重启
  await onInserted({ message })
  assert.equal(provider.stats.calls, 1, '切换后入箱预计算生效')
  assert.match(registered[0].text(), /SystemOne 自动决策/)
})

test('autoInject 运行时从 context 切到 message：pre-step 立即接管注入', async () => {
  const { ctx, handlers } = fakeCtx()
  const provider = countingProvider()
  const config = { ...BASE_CONFIG, autoInject: 'context' }
  installAutoDecide(ctx, { provider, config, scenarios, logger: ctx.logger })

  config.autoInject = 'message'   // 热切换
  const [handler] = handlers.get('agent/pre-step')
  const claimed = [userMessage('订单支付后超过 24 小时仍未到账，请尽快处理')]
  const decision = await handler(
    { agent: agentWith(), messages: claimed, turn: 1, step: 1, signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'enter', messages: claimed }),
  )
  assert.equal(decision.messages.length, 2, 'message 通道注入一条决策')
  assert.equal(provider.stats.calls, 1)
})

/* ─── 自动路由：场景数超过单道 choice 上限 ─────────────────────────────────── */

test('自动路由：场景数超过 26 时拆成多道 choice，每题都不越界', async () => {
  const { ctx, handlers } = fakeCtx()
  const sent = []
  // 30 个场景 → 必须拆成 2 组（26 + 4），而不是塞进一道 30 选项的题
  const many = Array.from({ length: 30 }, (_, i) => ({
    id: `s${String(i).padStart(2, '0')}`,
    title: `场景 ${i}`,
    questions: { q: { type: 'noul', instructions: '是不是？' } },
  }))
  const provider = {
    name: 'route-probe',
    async decide(options) {
      sent.push(options.questions)
      const ids = Object.keys(options.questions || {})
      // 决策题（不是路由分批题）交给 mock 产出真实答案
      if (!(ids.length > 0 && ids.every((id) => id.startsWith('systemone_route__')))) {
        return new MockProvider({}).decide(options)
      }
      // 路由题：固定让第 2 组给出更高置信度，验证"跨组取最高置信度"
      const answers = {}
      for (const qid of ids) {
        if (qid === 'systemone_route__1') {
          answers[qid] = { type: 'choice', choice: 's27', probabilities: { s27: 0.9 }, confidence: 0.9 }
        } else {
          answers[qid] = { type: 'choice', choice: 's00', probabilities: { s00: 0.6 }, confidence: 0.6 }
        }
      }
      return { answers }
    },
  }
  installAutoDecide(ctx, {
    provider,
    config: { ...BASE_CONFIG, autoScenario: '' },
    scenarios: many,
    logger: ctx.logger,
  })

  const [handler] = handlers.get('agent/pre-step')
  const decision = await handler(
    { agent: agentWith(), messages: [userMessage('需要判断这段内容属于哪一类业务场景')], turn: 1, step: 1, signal: new AbortController().signal },
    unchanged,
  )

  // 两次上游调用：一次路由（含 2 道题）、一次目标场景决策
  assert.equal(sent.length, 2, '路由与决策各一次')
  const routing = sent[0]
  const groups = Object.values(routing)
  assert.equal(groups.length, 2, '30 个场景应拆成 2 组')
  for (const q of groups) {
    assert.equal(q.type, 'choice')
    assert.ok(Object.keys(q.criteria).length <= 26, `单题选项数 ${Object.keys(q.criteria).length} 超过 26`)
  }
  assert.equal(groups[0].criteria.s00, '场景 0')
  assert.equal(groups[1].criteria.s29, '场景 29', '第二组要包含剩余场景')
  // 路由应取置信度最高的那一组 → s27（第 2 组），而不是按组序取 s00
  assert.match(decision.messages[1].content[0].text, /场景 27/)
})

test('自动路由：场景数不超 26 时仍只出一道题', async () => {
  const { ctx, handlers } = fakeCtx()
  const sent = []
  const few = scenarios.slice(0, 5)
  const provider = {
    name: 'route-probe',
    async decide(options) {
      sent.push(options.questions)
      const answers = {}
      for (const qid of Object.keys(options.questions || {})) {
        answers[qid] = { type: 'choice', choice: 'customer_service', probabilities: {}, confidence: 0.8 }
      }
      return { answers }
    },
  }
  installAutoDecide(ctx, {
    provider, config: { ...BASE_CONFIG, autoScenario: '' }, scenarios: few, logger: ctx.logger,
  })
  const [handler] = handlers.get('agent/pre-step')
  await handler(
    { agent: agentWith(), messages: [userMessage('订单迟迟不到账，需要判断归谁处理')], turn: 1, step: 1, signal: new AbortController().signal },
    unchanged,
  )
  assert.equal(Object.keys(sent[0]).length, 1, '不超限时只有一道路由题')
  assert.equal(Object.keys(sent[0].systemone_route__0.criteria).length, 5)
})

test('场景库变化使缓存失效：新增自定义场景后路由重新决策', async () => {
  const { ctx, handlers } = fakeCtx()
  const calls = []
  // 确定性 provider：路由题固定选场景库里的第一个 id，决策题走 mock。
  // 不用 MockProvider 的路由结果——它按 criteria 权重做伪随机，选项集一变结论就变，
  // 那种不确定性会把"缓存是否失效"这个断言搅浑。
  const provider = {
    name: 'route-stable',
    async decide(options) {
      calls.push(options.questions)
      const ids = Object.keys(options.questions || {})
      if (ids.length > 0 && ids.every((id) => id.startsWith('systemone_route__'))) {
        const criteria = Object.keys(options.questions[ids[0]].criteria || {})
        return { answers: { [ids[0]]: { type: 'choice', choice: criteria[0], probabilities: {}, confidence: 0.9 } } }
      }
      return new MockProvider({}).decide(options)
    },
  }
  const config = { ...BASE_CONFIG, autoScenario: '' }
  // 用 Proxy 模拟插件的 liveScenarios 活引用：内容原地变化、引用不变
  let live = [...scenarios]
  const liveRef = new Proxy([], {
    get: (_t, prop) => {
      if (prop === 'length') return live.length
      const value = live[prop]
      return typeof value === 'function' ? value.bind(live) : value
    },
  })
  installAutoDecide(ctx, { provider, config, scenarios: liveRef, logger: ctx.logger })

  const [handler] = handlers.get('agent/pre-step')
  const payload = { agent: agentWith(), messages: [userMessage('订单支付后超过 24 小时仍未到账，需要判断归属')], turn: 1, step: 1, signal: new AbortController().signal }
  await handler(payload, unchanged)
  assert.equal(calls.length, 2, '路由 + 决策各一次')

  // 场景库原地变化 → 缓存 key 必须随之改变
  live = [...live, { id: 'zz_new', title: '新场景', questions: { q: { type: 'noul', instructions: '？' } } }]
  await handler(payload, unchanged)
  assert.equal(calls.length, 4, '场景库变化后应重新路由并重新决策')

  // 场景库未再变化时，缓存仍然有效（没有把缓存整个废掉）
  await handler(payload, unchanged)
  assert.equal(calls.length, 4, '场景库未变时应命中缓存')
})

/* ─── 用量台账接线（自动路径） ─────────────────────────────────────────────── */

test('自动路径记账：路由记 auto-route，目标场景记 tool，且不重复计数', async () => {
  const { ctx, handlers } = fakeCtx()
  const recorded = []
  const usage = { record: (e) => { recorded.push(e); return e } }
  const provider = {
    name: 'probe',
    async decide(options) {
      const ids = Object.keys(options.questions || {})
      if (ids.length > 0 && ids.every((id) => id.startsWith('systemone_route__'))) {
        return { answers: { [ids[0]]: { type: 'choice', choice: 'customer_service', probabilities: {}, confidence: 0.9 } }, usage: { input_tokens: 700 }, model: 'u2-decision' }
      }
      return { ...await new MockProvider({}).decide(options), usage: { input_tokens: 900 } }
    },
  }
  installAutoDecide(ctx, {
    provider,
    config: { ...BASE_CONFIG, autoScenario: '' },   // 空 → 走自动路由
    scenarios,
    logger: ctx.logger,
    usage,
  })

  const [handler] = handlers.get('agent/pre-step')
  await handler(
    { agent: agentWith(), messages: [userMessage('订单支付后超过 24 小时仍未到账，需要判断归属')], turn: 1, step: 1, signal: new AbortController().signal },
    unchanged,
  )

  assert.equal(recorded.length, 2, '一次自动决策 = 路由 1 条 + 场景决策 1 条，不应重复或遗漏')
  const bySource = recorded.map((e) => e.source).sort()
  assert.deepEqual(bySource, ['auto-route', 'tool'])
  const route = recorded.find((e) => e.source === 'auto-route')
  assert.equal(route.ok, true)
  assert.equal(route.usage.input_tokens, 700, '路由请求的 usage 要被记下来')
  const decision = recorded.find((e) => e.source === 'tool')
  assert.equal(decision.scenario, 'customer_service')
  assert.equal(decision.usage.input_tokens, 900)
})

test('自动路径记账：固定场景时不产生 auto-route 记录', async () => {
  const { ctx, handlers } = fakeCtx()
  const recorded = []
  const usage = { record: (e) => { recorded.push(e); return e } }
  installAutoDecide(ctx, {
    provider: countingProvider(),
    config: BASE_CONFIG,                            // autoScenario 固定 → 无路由请求
    scenarios,
    logger: ctx.logger,
    usage,
  })

  const [handler] = handlers.get('agent/pre-step')
  await handler(
    { agent: agentWith(), messages: [userMessage('订单支付后超过 24 小时仍未到账，需要判断归属')], turn: 1, step: 1, signal: new AbortController().signal },
    unchanged,
  )

  assert.equal(recorded.length, 1, '固定场景只发一次请求')
  assert.equal(recorded[0].source, 'tool')
})

test('自动路径记账：命中缓存时不重复记账', async () => {
  const { ctx, handlers } = fakeCtx()
  const recorded = []
  const usage = { record: (e) => { recorded.push(e); return e } }
  installAutoDecide(ctx, { provider: countingProvider(), config: BASE_CONFIG, scenarios, logger: ctx.logger, usage })

  const [handler] = handlers.get('agent/pre-step')
  const payload = { agent: agentWith(), messages: [userMessage('订单支付后超过 24 小时仍未到账，需要判断归属')], turn: 1, step: 1, signal: new AbortController().signal }
  await handler(payload, unchanged)
  const afterFirst = recorded.length
  await handler(payload, unchanged)     // 命中缓存，不发上游请求
  assert.equal(recorded.length, afterFirst, '缓存命中没有产生新的上游调用，也不该新增台账记录')
})

test('自动路径记账：台账抛错不影响注入', async () => {
  const { ctx, handlers } = fakeCtx()
  const usage = { record() { throw new Error('台账炸了') } }
  installAutoDecide(ctx, { provider: countingProvider(), config: BASE_CONFIG, scenarios, logger: ctx.logger, usage })

  const [handler] = handlers.get('agent/pre-step')
  const decision = await handler(
    { agent: agentWith(), messages: [userMessage('订单支付后超过 24 小时仍未到账，需要判断归属')], turn: 1, step: 1, signal: new AbortController().signal },
    unchanged,
  )
  assert.equal(decision.messages.length, 2, '记账失败必须 fail-open，注入照常')
})

/* ─── autoMinChars 热更新 ─────────────────────────────────────────────────── */

test('autoMinChars 配置热更新立即生效', async () => {
  const { ctx, handlers } = fakeCtx()
  const provider = countingProvider()
  const config = { ...BASE_CONFIG, autoMinChars: 0 }
  installAutoDecide(ctx, { provider, config, scenarios, logger: ctx.logger })

  const [handler] = handlers.get('agent/pre-step')
  // autoMinChars=0 → 不做长度限制，只按寒暄黑名单判定
  await handler(
    { agent: agentWith(), messages: [userMessage('退款')], turn: 1, step: 1, signal: new AbortController().signal },
    unchanged,
  )
  assert.equal(provider.stats.calls, 1, '阈值为 0 时短请求触发')

  // 热更新把上界调到 4：同一批"短 + 寒暄"的输入开始被跳过，非寒暄的仍放行
  config.autoMinChars = 4
  await handler(
    { agent: agentWith(), messages: [userMessage('谢谢')], turn: 1, step: 1, signal: new AbortController().signal },
    unchanged,
  )
  assert.equal(provider.stats.calls, 1, '短促寒暄在新上界下被跳过（热更新生效）')

  await handler(
    { agent: agentWith(), messages: [userMessage('报错')], turn: 1, step: 1, signal: new AbortController().signal },
    unchanged,
  )
  assert.equal(provider.stats.calls, 2, '非寒暄的短请求不受长度上界影响')
})

/* ─── 固定场景配置错误要可诊断 ────────────────────────────────────────────── */

test('固定绑定未知场景时告警且只告警一次', async () => {
  const { ctx, handlers, warnings } = fakeCtx()
  const provider = countingProvider()
  installAutoDecide(ctx, {
    provider, config: { ...BASE_CONFIG, autoScenario: 'no_such_scenario' }, scenarios, logger: ctx.logger,
  })

  const [handler] = handlers.get('agent/pre-step')
  const run = () => handler(
    { agent: agentWith(), messages: [userMessage('一段足够长的业务内容用于测试')], turn: 1, step: 1, signal: new AbortController().signal },
    unchanged,
  )
  await run()
  await run()

  assert.equal(provider.stats.calls, 0)
  const hits = warnings.filter((w) => w.includes('固定场景'))
  assert.equal(hits.length, 1, '同一错误 id 只告警一次')
  assert.match(hits[0], /no_such_scenario/)
})

/* ─── state 截断 ─────────────────────────────────────────────────────────── */

test('超长的当前请求会被截断后再进入 state', async () => {
  const { ctx, handlers } = fakeCtx()
  const seen = []
  const provider = {
    name: 'spy',
    async decide(options) {
      seen.push(options.state)
      return new MockProvider({}).decide(options)
    },
  }
  installAutoDecide(ctx, { provider, config: BASE_CONFIG, scenarios, logger: ctx.logger })

  const [handler] = handlers.get('agent/pre-step')
  await handler(
    { agent: agentWith(), messages: [userMessage('退'.repeat(20000))], turn: 1, step: 1, signal: new AbortController().signal },
    unchanged,
  )

  assert.equal(seen.length, 1)
  assert.ok(seen[0].length < 12000, `state 应被截断（实际 ${seen[0].length} 字符）`)
  assert.ok(seen[0].includes('已截断'))
})