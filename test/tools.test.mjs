/**
 * tools.test.mjs — 用 mock 提供商验证场景调度工具（无网络、无 Key）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createProvider } from '../lib/provider.js'
import { createTools } from '../lib/tools.js'
import { BUILTIN_SCENARIOS, resolveScenarios, findScenario, validateScenario } from '../lib/scenarios.js'

const provider = createProvider({ provider: 'mock' })
const config = { provider: 'mock', model: 'u2-decision', minConfidence: 0.6 }
const { scenarios } = resolveScenarios('')
const tools = Object.fromEntries(createTools(provider, config, scenarios).map((t) => [t.name, t]))
const scenarioTool = tools.systemone_scenario

/* ─── mock 提供商 ─────────────────────────────────────────────────────────── */

test('mock provider 返回 SystemOne 兼容结构', async () => {
  const res = await provider.decide({
    state: 'test',
    questions: {
      q1: { type: 'choice', instructions: 'which?', criteria: { a: 'A', b: 'B' } },
      q2: { type: 'noul', instructions: 'yes?' },
      q3: { type: 'score', instructions: 'how?', criteria: ['low', 'mid', 'high'] },
    },
  })
  assert.equal(res.model, 'mock-decision')
  assert.ok(res.answers.q1.choice)
  assert.ok(res.answers.q1.confidence > 0)
  assert.equal(typeof res.answers.q2.noul, 'number')
  assert.ok(res.answers.q3.score >= 0)
  assert.equal(res.answers.q3.legend['0'], 'low')
})

test('unisound 提供商未配置 Key 时抛出清晰错误', async () => {
  // 测试必须封闭：本机可能设置了 UNISOUND_API_KEY / SYSTEMONE_API_KEY，
  // 不摘掉的话这里会真的发起网络请求
  const saved = {
    unisound: process.env.UNISOUND_API_KEY,
    systemone: process.env.SYSTEMONE_API_KEY,
  }
  delete process.env.UNISOUND_API_KEY
  delete process.env.SYSTEMONE_API_KEY
  try {
    const p = createProvider({ provider: 'unisound', apiKey: '' })
    await assert.rejects(() => p.decide({ state: 'x', questions: {} }), /apiKey|API Key/)
  } finally {
    if (saved.unisound !== undefined) process.env.UNISOUND_API_KEY = saved.unisound
    if (saved.systemone !== undefined) process.env.SYSTEMONE_API_KEY = saved.systemone
  }
})

/* ─── 场景库 ──────────────────────────────────────────────────────────────── */

test('场景库内置 10 大业务域', () => {
  const ids = scenarios.map((s) => s.id)
  assert.deepEqual(ids, [
    'customer_service',
    'content_moderation',
    'agent_routing',
    'sales_lead',
    'risk_control',
    'recruiting',
    'data_governance',
    'education',
    'requirements',
    'software_dev',
  ])
})

test('每个内置场景都有 3 个合法问题', () => {
  for (const s of BUILTIN_SCENARIOS) {
    assert.deepEqual(validateScenario(s), [], `${s.id} 定义非法`)
    assert.equal(Object.keys(s.questions).length, 3, `${s.id} 问题数应为 3`)
  }
})

test('findScenario 支持 id 与别名', () => {
  assert.equal(findScenario(scenarios, 'customer_service').id, 'customer_service')
  assert.equal(findScenario(scenarios, 'ticket_triage').id, 'customer_service')
  assert.equal(findScenario(scenarios, '风控').id, 'risk_control')
  assert.equal(findScenario(scenarios, '不存在的场景'), undefined)
})

/* ─── action: list / describe ─────────────────────────────────────────────── */

test('action=list 列出全部场景', async () => {
  const out = await scenarioTool.execute({ action: 'list' }, {})
  assert.equal(out.ok, true)
  assert.equal(out.count, 10)
  assert.ok(out.summary.includes('SystemOne 场景库'))
})

test('action=list 支持关键词过滤', async () => {
  const out = await scenarioTool.execute({ action: 'list', keyword: '风控' }, {})
  assert.equal(out.count, 1)
  assert.equal(out.scenarios[0].id, 'risk_control')
})

test('action=describe 返回问题定义', async () => {
  const out = await scenarioTool.execute({ action: 'describe', scenario: 'recruiting' }, {})
  assert.equal(out.ok, true)
  assert.equal(out.scenario, 'recruiting')
  assert.equal(out.questions.length, 3)
  assert.ok(out.questions.every((q) => q.id && q.type && q.instructions))
  assert.ok(out.summary.includes('招聘 HR'))
})

test('action=describe 未知场景返回可用列表', async () => {
  const out = await scenarioTool.execute({ action: 'describe', scenario: 'nope' }, {})
  assert.equal(out.ok, false)
  assert.equal(out.available.length, 10)
})

/* ─── action: run（10 大场景全覆盖） ───────────────────────────────────────── */

const SAMPLES = {
  customer_service: '订单支付后超过 24 小时仍未到账，用户无法继续使用核心服务，要求立即处理。',
  content_moderation: '这个商品是假货，大家千万不要买，我已经被骗了三千块。',
  agent_routing: '我上个月的发票找不到了，能帮我重新开一张吗？',
  sales_lead: '某制造业客户留资，预算充足，计划三个月内采购 200 个席位。',
  risk_control: '该账户在 3 分钟内跨省登录并发起 5 笔大额转账，设备指纹与历史不符。',
  recruiting: '候选人 5 年后端经验，主导过高并发交易系统，熟悉 Go 与分布式事务。',
  data_governance: '这份供应商合同中包含联系人手机号与银行账号，字段口径与上月不一致。',
  education: '已知三角形两边长与夹角，求第三边长。',
  requirements: '需要在结算模块新增多币种支持，涉及账务与对账链路改造。',
}

for (const [id, state] of Object.entries(SAMPLES)) {
  test(`action=run 场景 ${id} 返回完整决策`, async () => {
    const out = await scenarioTool.execute({ action: 'run', scenario: id, state }, {})
    const scenario = findScenario(scenarios, id)
    assert.equal(out.ok, true, `${id} 执行失败：${out.error || ''}`)
    assert.equal(out.scenario, id)
    assert.ok(out.summary.includes(scenario.title), `${id} 摘要缺少标题`)
    assert.ok(out.summary.includes('决策服务'), `${id} 摘要缺少服务信息`)
    assert.ok(out.recommendation && out.recommendation.length > 0, `${id} 建议为空`)
    assert.equal(typeof out.needs_human_review, 'boolean')
    const questionIds = Object.keys(scenario.questions)
    for (const qid of questionIds) {
      assert.ok(qid in out.decision, `${id} 缺少 decision.${qid}`)
      assert.ok(out.labels[qid], `${id} 缺少 labels.${qid}`)
    }
  })
}

test('场景 customer_service 能派生优先级', async () => {
  const out = await scenarioTool.execute({
    action: 'run',
    scenario: 'customer_service',
    state: SAMPLES.customer_service,
  })
  assert.match(out.derived.priority, /^P[1-4]$/)
  assert.ok(out.summary.includes('优先级'))
})

test('action=run 缺少 state 时报错', async () => {
  const out = await scenarioTool.execute({ action: 'run', scenario: 'risk_control' }, {})
  assert.equal(out.ok, false)
  assert.match(out.error, /state/)
})

test('params.criteria 整体替换选项', async () => {
  const out = await scenarioTool.execute({
    action: 'run',
    scenario: 'customer_service',
    state: 'VIP 客户工单',
    params: { department: { criteria: { vip: 'VIP 专属通道', billing: '账单' } } },
  })
  assert.equal(out.ok, true)
  assert.ok(['vip', 'billing'].includes(out.decision.department), `实际：${out.decision.department}`)
})

test('params.addCriteria 追加选项而不丢默认项', async () => {
  const out = await scenarioTool.execute({
    action: 'run',
    scenario: 'customer_service',
    state: 'VIP 客户工单',
    params: { department: { addCriteria: { vip: 'VIP 专属通道' } } },
  })
  assert.equal(out.ok, true)
  assert.ok(Object.keys(out.answers.department.probabilities).includes('vip'))
  assert.ok(Object.keys(out.answers.department.probabilities).includes('billing'))
})

test('params 中无效覆盖被忽略并在结果与摘要中报告', async () => {
  const out = await scenarioTool.execute({
    action: 'run',
    scenario: 'customer_service',
    state: 'VIP 客户工单',
    params: {
      severity: { criteria: { a: 'score 不能用对象形式的 criteria' } },
      nope: { instructions: '未知问题 id' },
    },
  })
  assert.equal(out.ok, true, '无效覆盖不应让决策失败')
  assert.equal(out.warnings.length, 1)
  assert.match(out.warnings[0], /severity\.criteria/)
  assert.match(out.warnings[0], /nope/)
  assert.match(out.summary, /注意/)
  // 合法覆盖仍然生效
  const ok = await scenarioTool.execute({
    action: 'run',
    scenario: 'customer_service',
    state: 'VIP 客户工单',
    params: { department: { addCriteria: { vip: 'VIP 专属通道' } } },
  })
  assert.equal(ok.warnings.length, 0)
})

/* ─── 自定义场景 ──────────────────────────────────────────────────────────── */

const CUSTOM = JSON.stringify([
  {
    id: 'legal_review',
    title: '法务 · 合同风险预审',
    description: '判断合同风险等级与是否需要法务介入。',
    questions: {
      risk: { type: 'score', label: '风险等级', instructions: '这份合同风险多高？', criteria: ['无风险', '低风险', '高风险'] },
      lawyer: { type: 'noul', label: '法务介入', instructions: '是否需要法务介入？' },
    },
    recommendation: '风险等级 {risk}。{lawyer?需法务介入|可业务自审}',
  },
])

test('自定义场景可与内置场景合并', async () => {
  const { scenarios: merged, problems } = resolveScenarios(CUSTOM)
  assert.deepEqual(problems, [])
  assert.equal(merged.length, 11) // 10 内置 + 1 自定义
  const custom = findScenario(merged, 'legal_review')
  assert.equal(custom.source, 'custom')

  const customTools = Object.fromEntries(createTools(provider, config, merged).map((t) => [t.name, t]))
  const out = await customTools.systemone_scenario.execute(
    { action: 'run', scenario: 'legal_review', state: '一份含无限连带责任的采购合同' },
    {},
  )
  assert.equal(out.ok, true)
  assert.ok(out.summary.includes('法务 · 合同风险预审'))
  assert.match(out.recommendation, /风险等级/)
})

test('同 id 自定义场景覆盖内置场景', () => {
  const override = JSON.stringify([
    {
      id: 'risk_control',
      title: '风控（自定义版）',
      questions: { flag: { type: 'noul', instructions: '是否可疑？' } },
    },
  ])
  const { scenarios: merged, problems } = resolveScenarios(override)
  assert.deepEqual(problems, [])
  assert.equal(merged.length, 10)
  assert.equal(findScenario(merged, 'risk_control').title, '风控（自定义版）')
})

test('非法自定义场景被跳过并给出原因', () => {
  const bad = JSON.stringify([
    { id: 'broken', title: '缺问题' },
    { id: 'bad_type', title: '类型错误', questions: { q: { type: 'essay', instructions: 'x' } } },
  ])
  const { scenarios: merged, problems } = resolveScenarios(bad)
  assert.equal(merged.length, 10)
  assert.equal(problems.length, 2)
  assert.ok(problems.every((p) => p.includes('已跳过')))
})

test('自定义场景 JSON 语法错误被捕获', () => {
  const { scenarios: merged, problems } = resolveScenarios('{ not json')
  assert.equal(merged.length, 10)
  assert.equal(problems.length, 1)
  assert.ok(problems[0].includes('解析失败'))
})

/* ─── 通用决策工具 ────────────────────────────────────────────────────────── */

test('systemone_decide 返回原始概率化答案', async () => {
  const out = await tools.systemone_decide.execute({
    state: { order: 'x' },
    questions: { ok: { type: 'choice', instructions: 'ok?', criteria: { yes: '是', no: '否' } } },
  }, {})
  assert.equal(out.ok, true)
  assert.equal(out.scenario, null)
  assert.ok(out.answers.ok)
  assert.ok(out.decision.ok)
})

/* ─── 确定性与失败路径 ────────────────────────────────────────────────────── */

test('mock 确定性：相同输入得到相同输出', async () => {
  const args = { action: 'run', scenario: 'customer_service', state: SAMPLES.customer_service }
  const a = await scenarioTool.execute(args, {})
  const b = await scenarioTool.execute(args, {})
  assert.deepEqual(a.answers, b.answers)
  assert.equal(a.recommendation, b.recommendation)
})

test('提供商抛错时工具返回结构化错误', async () => {
  const failing = { name: 'failing', async decide() { throw new Error('上游 503') } }
  const failingTools = Object.fromEntries(createTools(failing, config, scenarios).map((t) => [t.name, t]))
  const out = await failingTools.systemone_scenario.execute(
    { action: 'run', scenario: 'education', state: '题目' },
    {},
  )
  assert.equal(out.ok, false)
  assert.match(out.error, /503/)
  assert.match(out.summary, /调用失败/)
})
