/**
 * client.test.mjs — 浏览器侧（lib/client.js）纯函数的行为测试。
 *
 * client.js 由 DSH 桌面端的模块加载器执行（window.__ModuleLoader__.load + require），
 * 无法直接 import 内部函数；这里在 Node 里桩掉 window 与 react，捕获 factory，
 * 从导出的 __internals 拿纯函数做断言。UI 渲染由宿主负责，不在测试范围。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

let internalsCache = null

/** 桩掉 ModuleLoader 执行 client.js 的 factory，返回暴露的 __internals。 */
async function getInternals() {
  if (internalsCache) return internalsCache
  let captured = null
  globalThis.window = { __ModuleLoader__: { load: (m) => { captured = m } } }
  try {
    await import('../lib/client.js')
  } finally {
    delete globalThis.window
  }
  assert.ok(captured, 'client.js 应通过 window.__ModuleLoader__.load 注册模块')
  assert.equal(captured.id, '@master0071/dsh-systemone')
  const module = captured.factory((id) => {
    if (id === 'react') {
      return { Fragment: {}, useState: () => [null, () => {}], useRef: () => ({ current: null }) }
    }
    if (id === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null }
    throw new Error(`未预期的依赖：${id}`)
  })
  internalsCache = module.__internals
  assert.ok(internalsCache?.validateCustomScenarios, '应导出 __internals.validateCustomScenarios')
  return internalsCache
}

/* ─── validateCustomScenarios ─────────────────────────────────────────────── */

test('client：空文本合法，count=0', async () => {
const { validateCustomScenarios } = await getInternals()
const r = validateCustomScenarios('')
assert.deepEqual(r, { ok: true, ids: [], count: 0 })
assert.deepEqual(validateCustomScenarios('   '), { ok: true, ids: [], count: 0 })
})

test('client：合法场景数组通过并返回 id 列表', async () => {
const { validateCustomScenarios } = await getInternals()
const r = validateCustomScenarios(JSON.stringify([
  { id: 'legal', title: '法务', questions: { risk: { type: 'noul', instructions: '?' } } },
  {
    id: 'intent', title: '意图',
    questions: { intent: { type: 'choice', instructions: '?', criteria: { a: 'A', b: 'B' } } },
  },
]))
assert.equal(r.ok, true)
assert.deepEqual(r.ids, ['legal', 'intent'])
assert.equal(r.count, 2)
})

test('client：JSON 语法错误 / 非数组 / 非对象条目分别报错', async () => {
const { validateCustomScenarios } = await getInternals()
assert.equal(validateCustomScenarios('{ 坏').ok, false)
assert.match(validateCustomScenarios('{ 坏').error, /^json:/)
assert.equal(validateCustomScenarios('{"a":1}').error, 'notArray')
assert.match(validateCustomScenarios('[123]').error, /^item:1$/)
})

test('client：字段问题被汇总到 issues（缺 id/title、坏 type、选项数不足）', async () => {
const { validateCustomScenarios } = await getInternals()
const r = validateCustomScenarios(JSON.stringify([
  {
    id: '', title: '',
    questions: { q: { type: 'essay', instructions: 'x' } },
  },
  {
    id: 'c', title: 'C',
    questions: { q: { type: 'choice', instructions: '?', criteria: { a: 'A' } } },
  },
]))
assert.equal(r.ok, false)
const secondItem = validateCustomScenarios(JSON.stringify([
  { id: 'c', title: 'C', questions: { q: { type: 'choice', instructions: '?', criteria: { a: 'A' } } } },
]))
assert.match(secondItem.error, /至少 2 个选项/)
})

test('client：__proto__/constructor 作为问题 id 被拦截', async () => {
const { validateCustomScenarios } = await getInternals()
const unsafe = '[{"id":"x","title":"X","questions":{"__proto__":{"type":"noul","instructions":"?"}}}]'
const r = validateCustomScenarios(unsafe)
assert.equal(r.ok, false)
assert.match(r.error, /__proto__/)
const unsafe2 = '[{"id":"x","title":"X","questions":{"constructor":{"type":"noul","instructions":"?"}}}]'
assert.match(validateCustomScenarios(unsafe2).error, /constructor/)
})

/* ─── patch 条目（与宿主侧 mergeScenario 语义对齐） ────────────────────────── */

test('client：patch 条目允许省略 title 与完整问题定义', async () => {
const { validateCustomScenarios } = await getInternals()
const r = validateCustomScenarios(JSON.stringify([
  { id: 'customer_service', patch: true, questions: { department: { criteria: { vip: 'VIP', billing: '账单' } } } },
]))
assert.equal(r.ok, true)
assert.deepEqual(r.ids, ['customer_service'])
})

test('client：patch 条目连 questions 都可以省略', async () => {
const { validateCustomScenarios } = await getInternals()
const r = validateCustomScenarios(JSON.stringify([{ id: 'risk_control', patch: true, recommendation: 'x' }]))
assert.equal(r.ok, true)
})

test('client：patch 条目给出的 type 必须合法', async () => {
const { validateCustomScenarios } = await getInternals()
const r = validateCustomScenarios(JSON.stringify([
  { id: 'x', patch: true, questions: { q: { type: 'essay' } } },
]))
assert.equal(r.ok, false)
assert.match(r.error, /type 必须是 choice\/noul\/score/)
})

test('client：patch 条目的 questions 类型错误仍被拦截', async () => {
const { validateCustomScenarios } = await getInternals()
const r = validateCustomScenarios(JSON.stringify([{ id: 'x', patch: true, questions: 'oops' }]))
assert.equal(r.ok, false)
assert.match(r.error, /questions 必须是对象/)
})

test('client：patch 条目缺 id 仍被拦截', async () => {
const { validateCustomScenarios } = await getInternals()
const r = validateCustomScenarios(JSON.stringify([{ patch: true }]))
assert.equal(r.ok, false)
assert.match(r.error, /缺少 id/)
})

/* ─── describeCustomError（机器码 → 用户可读文案） ─────────────────────────── */

test('client：describeCustomError 正确映射各类错误码', async () => {
const { describeCustomError } = await getInternals()
const t = (key) => `«${key}»`
assert.equal(describeCustomError(undefined, t), undefined)
assert.equal(describeCustomError('notArray', t), '«jsonNotArray»')
assert.equal(describeCustomError('json:boom', t), '«jsonBadSyntax»')
assert.equal(describeCustomError('item:3', t), '«jsonItemNotObject»')
assert.equal(describeCustomError('issues:2:foo:缺少 id', t), '«jsonItemIssues»')
assert.equal(describeCustomError('weird', t), 'weird')
})