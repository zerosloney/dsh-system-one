/**
 * client.test.mjs — 浏览器侧（lib/client.js）纯函数的行为测试。
 *
 * client.js 由 DSH 桌面端的模块加载器执行（window.__ModuleLoader__.load + require），
 * 无法直接 import 内部函数；这里在 Node 里桩掉 window 与 react，捕获 factory，
 * 从导出的 __internals 拿纯函数做断言。UI 渲染由宿主负责，不在测试范围。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
// scenarios.js 是纯数据、无依赖，可以直接 import：用来钉住"客户端候选清单"与内置场景不漂移
import { BUILTIN_SCENARIOS } from '../lib/scenarios.js'

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
    // 记录元素而不是丢弃：组件冒烟测试要靠它判断走了哪个分支
    if (id === 'react/jsx-runtime') {
      return {
        jsx: (type, props, key) => ({ type, props, key }),
        jsxs: (type, props, key) => ({ type, props, key }),
      }
    }
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
  { id: 'risk_control', patch: true, questions: { q: { type: 'essay' } } },
]))
assert.equal(r.ok, false)
assert.match(r.error, /type 必须是 choice\/noul\/score/)
})

test('client：patch 条目的 questions 类型错误仍被拦截', async () => {
const { validateCustomScenarios } = await getInternals()
const r = validateCustomScenarios(JSON.stringify([{ id: 'risk_control', patch: true, questions: 'oops' }]))
assert.equal(r.ok, false)
assert.match(r.error, /questions 必须是对象/)
})

test('client：内置场景候选 id 与宿主 BUILTIN_SCENARIOS 完全一致（防止手抄漂移）', async () => {
const { SCENARIO_OPTIONS } = await getInternals()
assert.deepEqual(
  SCENARIO_OPTIONS.map((option) => option.id).sort(),
  BUILTIN_SCENARIOS.map((scenario) => scenario.id).sort(),
  '客户端候选清单是手抄的：宿主增删内置场景时必须同步，否则 patch 校验会误判',
)
})

test('client：patch 目标不存在时直接拦下（宿主会静默跳过整条）', async () => {
const { validateCustomScenarios } = await getInternals()
const r = validateCustomScenarios(JSON.stringify([
  { id: 'typo_scene', patch: true, recommendation: 'x' },
]))
assert.equal(r.ok, false)
assert.match(r.error, /patch 目标不存在/)
assert.equal(r.count, 0)
})

test('client：patch 可以指向本数组中更早出现的自定义场景', async () => {
const { validateCustomScenarios } = await getInternals()
const r = validateCustomScenarios(JSON.stringify([
  { id: 'my_intent', title: '意图', questions: { q: { type: 'noul', instructions: '?' } } },
  { id: 'my_intent', patch: true, questions: { q: { label: '是/否' } } },
]))
assert.equal(r.ok, true)
assert.deepEqual(r.ids, ['my_intent', 'my_intent'])
})

test('client：patch 不能指向数组里更晚出现的自定义场景（宿主按顺序登记）', async () => {
const { validateCustomScenarios } = await getInternals()
const r = validateCustomScenarios(JSON.stringify([
  { id: 'later_one', patch: true, recommendation: 'x' },
  { id: 'later_one', title: '后定义', questions: { q: { type: 'noul', instructions: '?' } } },
]))
assert.equal(r.ok, false)
assert.match(r.error, /patch 目标不存在/)
})

test('client：patch 目标匹配内置场景时大小写不敏感', async () => {
const { validateCustomScenarios } = await getInternals()
const r = validateCustomScenarios(JSON.stringify([
  { id: 'Customer_Service', patch: true, recommendation: 'x' },
]))
assert.equal(r.ok, true)
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

/* ─── 数字字段校验（与宿主 schema 的 min/max 对齐） ───────────────────────── */

test('client：越界数字在保存前就被拦住，而不是「已保存但不生效」', async () => {
const { numberErrorFor } = await getInternals()
const t = (key, params) => (key === 'numberRange' ? `range:${params.bounds}` : key)

const timeout = { key: 'timeoutMs', min: 1000 }
assert.equal(numberErrorFor(timeout, '', t), 'numberRequired')
assert.equal(numberErrorFor(timeout, '   ', t), 'numberRequired')
assert.equal(numberErrorFor(timeout, 'abc', t), 'numberInvalid')
assert.equal(numberErrorFor(timeout, '1000', t), undefined)
assert.equal(numberErrorFor(timeout, '999', t), 'range:≥ 1000')

const confidence = { key: 'minConfidence', min: 0, max: 1 }
assert.equal(numberErrorFor(confidence, '0', t), undefined)
assert.equal(numberErrorFor(confidence, '1', t), undefined)
assert.equal(numberErrorFor(confidence, '1.5', t), 'range:0~1')
assert.equal(numberErrorFor(confidence, '-0.1', t), 'range:0~1')

// 边界值来自字符串草稿，不能因为 "1000.0" 之类的写法被误判
assert.equal(numberErrorFor(timeout, ' 1000.0 ', t), undefined)
})

test('client：保存被拒时区分「并发冲突」与「校验拒绝」', async () => {
const { saveResultText } = await getInternals()
const t = (key) => `«${key}»`
// 成功：不产生任何错误文案
assert.equal(saveResultText({ ok: true, revision: 3, latestRevision: 3 }, t), undefined)
// revision 被别处推进：草稿已过期，提示冲突
assert.equal(saveResultText({ ok: false, revision: 3, latestRevision: 4 }, t), '«conflict»')
// revision 没变：是值本身没通过校验，不能误导成并发问题
assert.equal(saveResultText({ ok: false, revision: 3, latestRevision: 3 }, t), '«saveRefused»')
assert.equal(saveResultText({ ok: false, revision: undefined, latestRevision: undefined }, t), '«saveRefused»')
})

test('client：每张卡只提交自己卡片里改过的字段（三卡各自保存的核心）', async () => {
const { cardOps, SERVICE_FIELDS, CUSTOM_FIELDS, AUTO_FIELDS } = await getInternals()
const allFields = [...SERVICE_FIELDS, ...CUSTOM_FIELDS, ...AUTO_FIELDS]
const fieldsOf = (list) => list.map((field) => field.key)
const draft = {
  provider: 'http',
  timeoutMs: '5000',
  customScenarios: '[]',
  autoTimeoutMs: '9000',
}
const current = { provider: 'unisound', timeoutMs: '30000', customScenarios: '', autoTimeoutMs: '8000' }

assert.deepEqual(
  cardOps('service', { fields: fieldsOf(SERVICE_FIELDS), draft, current, allFields, clearApiKey: false }),
  [
    { op: 'set', path: ['provider'], value: 'http' },
    { op: 'set', path: ['timeoutMs'], value: 5000 },
  ],
  '服务卡不能把自动决策/自定义场景的草稿一起写下去',
)
assert.deepEqual(
  cardOps('auto', { fields: fieldsOf(AUTO_FIELDS), draft, current, allFields, clearApiKey: false }),
  [{ op: 'set', path: ['autoTimeoutMs'], value: 9000 }],
)
assert.deepEqual(
  cardOps('custom', { fields: fieldsOf(CUSTOM_FIELDS), draft, current, allFields, clearApiKey: false }),
  [{ op: 'set', path: ['customScenarios'], value: '[]' }],
)
})

test('client：清除 Key 用 unset，且不会串到别的卡片', async () => {
const { cardOps, SERVICE_FIELDS, AUTO_FIELDS } = await getInternals()
const fieldsOf = (list) => list.map((field) => field.key)
const allFields = [...SERVICE_FIELDS, ...AUTO_FIELDS]

assert.deepEqual(
  cardOps('service', { fields: fieldsOf(SERVICE_FIELDS), draft: {}, current: {}, allFields, clearApiKey: true }),
  [{ op: 'unset', path: ['apiKey'] }],
  '清空已保存的 Key 必须是 unset（写空串语义不同）',
)
assert.deepEqual(
  cardOps('auto', { fields: fieldsOf(AUTO_FIELDS), draft: {}, current: {}, allFields, clearApiKey: true }),
  [],
  '清除 Key 的意图不能串到自动决策卡',
)
})

test('client：redact 串转布尔、非法数字不发写操作、空 apiKey 不写', async () => {
const { cardOps, SERVICE_FIELDS } = await getInternals()
const fields = SERVICE_FIELDS.map((field) => field.key)
const ops = cardOps('service', {
  fields,
  draft: { redact: 'true', timeoutMs: 'abc', minConfidence: '0.7', apiKey: '' },
  current: { redact: 'false', timeoutMs: '30000', minConfidence: '0.6', apiKey: '' },
  allFields: [...SERVICE_FIELDS],
  clearApiKey: false,
})
assert.deepEqual(ops, [
  { op: 'set', path: ['redact'], value: true },
  { op: 'set', path: ['minConfidence'], value: 0.7 },
])
})

test('client：每个数字字段都声明了范围（新增字段不能漏写）', async () => {
const { SERVICE_FIELDS, AUTO_FIELDS } = await getInternals()
const numeric = [...SERVICE_FIELDS, ...AUTO_FIELDS].filter((field) => field.kind === 'number')
assert.ok(numeric.length >= 10, '数字字段清单不应突然变少')
for (const field of numeric) {
  assert.ok(
    Number.isFinite(field.min) || Number.isFinite(field.max),
    `${field.key} 缺少 min/max：宿主 schema 有范围约束，界面不校验就会出现「显示已保存、实际被拒或不生效」`,
  )
}
})
/* ─── 配置页冒烟：渲染一次不抛错 + 走对分支 ──────────────────────────────── */

/** 递归收集元素树里的文本节点（jsx 桩返回 {type, props}）。 */
function collectText(node, out = []) {
if (node === null || node === undefined || node === false) return out
if (Array.isArray(node)) { for (const item of node) collectText(item, out); return out }
if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
if (typeof node === 'object' && node.props && 'children' in node.props) collectText(node.props.children, out)
return out
}

/** 一份「全部合法」的快照，作为渲染基线。 */
const VALID_VALUE = {
provider: 'unisound', apiKeyRef: '', apiKey: '', baseUrl: 'https://maas-api.unisound.com/v1',
endpoint: '', model: 'u2-decision', timeoutMs: 30000, minConfidence: 0.6, redact: false,
allowInsecureHttp: false,
customScenarios: '', usageLogPath: '',
autoDecide: false, autoScenario: '', autoInject: 'message', autoFailMode: 'open',
autoTimeoutMs: 8000, autoMaxMessages: 6, autoCacheTtlMs: 60000, autoRouteCacheTtlMs: 180000,
autoFailureCooldownMs: 60000, autoMinConfidence: 0.6, autoRouteMinConfidence: 0.35, autoMinChars: 4,
}

test('client：快照未就绪时显示加载/不可用，而不是空表单 + 一堆红字', async () => {
const { SystemOneConfigPage } = await getInternals()
const t = (key) => key
const loading = SystemOneConfigPage({ view: 'page', t, form: { state: { status: 'loading' }, mutate: async () => true } })
assert.equal(loading.type, 'p')
assert.equal(loading.props.children, 'loadingConfig')

const unavailable = SystemOneConfigPage({ view: 'page', t, form: { state: { status: 'unavailable' }, mutate: async () => true } })
assert.equal(unavailable.props.children, 'unavailableConfig')
})

test('client：数字越界时渲染出「为什么不能保存」，而不是没有解释的灰按钮', async () => {
const { SystemOneConfigPage } = await getInternals()
// 参数也拼进文本里：这样才能断言"提示点名了出错的字段"
const t = (key, params) => (params?.reason ? `${key}:${params.reason}` : key)
const form = (value) => ({ state: { status: 'ready', revision: 1, writable: true, value }, mutate: async () => true })

const good = SystemOneConfigPage({ view: 'page', t, form: form(VALID_VALUE) })
assert.ok(good, '组件应返回元素树')
const goodTexts = collectText(good)
assert.ok(!goodTexts.some((text) => text.startsWith('saveBlocked')), '合法配置不该出现阻塞提示')

// 数字越界只拦截所属的那张卡（timeoutMs 在「模型服务」卡里）
const bad = SystemOneConfigPage({ view: 'page', t, form: form({ ...VALID_VALUE, timeoutMs: 500 }) })
const blocked = collectText(bad).filter((text) => text.startsWith('saveBlocked'))
assert.equal(blocked.length, 1, '只有出问题的那张卡需要解释原因，不能把其他卡的保存一起禁掉')
assert.ok(blocked[0].includes('timeoutMs'), '提示要点名是哪个字段')
assert.ok(blocked[0].includes('numberRange'), '提示要带上具体规则（超出允许范围）')

// 自定义场景 JSON 错误同样只拦「自定义场景」卡，不牵连服务/自动决策两卡
const badJson = SystemOneConfigPage({ view: 'page', t, form: form({ ...VALID_VALUE, customScenarios: '[{' }) })
const jsonBlocked = collectText(badJson).filter((text) => text.startsWith('saveBlocked'))
assert.equal(jsonBlocked.length, 1, '自定义场景卡的错误不该牵连其他卡')
assert.ok(jsonBlocked[0].includes('tabCustom'), '要指出问题出在自定义场景')
})
