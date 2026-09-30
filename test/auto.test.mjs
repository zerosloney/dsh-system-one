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

test('autoInject=message：同一步追加一条 runtime-context 消息', async () => {
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
  assert.equal(injected.source.kind, 'runtime-context')
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
    decide: () => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ answers: {} }), 2000)
      timer.unref?.()
      // 尊重 signal
      void reject
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
    { role: 'user', text: '我注入的上下文', source: { kind: 'runtime-context' } },
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
  assert.ok(!seen[0].includes('我注入的上下文'), '不应把自己注入的上下文喂回模型')
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

test('过短输入（寒暄）不触发', async () => {
  const { ctx, handlers } = fakeCtx()
  const provider = countingProvider()
  installAutoDecide(ctx, { provider, config: BASE_CONFIG, scenarios, logger: ctx.logger })

  const [handler] = handlers.get('agent/pre-step')
  for (const text of ['你好', '谢谢', 'ok', '好的', '在吗？', 'Thanks!']) {
    await handler(
      { agent: agentWith(), messages: [userMessage(text)], turn: 1, step: 1, signal: new AbortController().signal },
      unchanged,
    )
  }
  assert.equal(provider.stats.calls, 0)
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
  onDisposed({ agent: { id: 'session-test' } })   // 不应抛错
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

/* ─── autoMinChars 热更新 ─────────────────────────────────────────────────── */

test('autoMinChars 配置热更新立即生效', async () => {
  const { ctx, handlers } = fakeCtx()
  const provider = countingProvider()
  const config = { ...BASE_CONFIG, autoMinChars: 0 }
  installAutoDecide(ctx, { provider, config, scenarios, logger: ctx.logger })

  const [handler] = handlers.get('agent/pre-step')
  await handler(
    { agent: agentWith(), messages: [userMessage('退款')], turn: 1, step: 1, signal: new AbortController().signal },
    unchanged,
  )
  assert.equal(provider.stats.calls, 1, '阈值为 0 时短请求触发')

  config.autoMinChars = 4   // 热更新：同样的短请求被跳过
  await handler(
    { agent: agentWith(), messages: [userMessage('补开')], turn: 1, step: 1, signal: new AbortController().signal },
    unchanged,
  )
  assert.equal(provider.stats.calls, 1, '低于新阈值即跳过')
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