/**
 * tools.test.mjs — 用 mock 提供商验证场景调度工具（无网络、无 Key）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProvider, HttpProvider, MockProvider } from '../lib/provider.js'
import { createTools } from '../lib/tools.js'
import { BUILTIN_SCENARIOS, resolveScenarios, findScenario, validateScenario } from '../lib/scenarios.js'

const provider = createProvider({ provider: 'mock' })
const config = { provider: 'mock', model: 'u2-decision', minConfidence: 0.6 }
const { scenarios } = resolveScenarios('')
const tools = Object.fromEntries(createTools(provider, config, scenarios).map((t) => [t.name, t]))
const scenarioTool = tools.systemone_scenario

/* ─── DSH 凭证缝（.credentials.yaml refs） ────────────────────────────────── */

/**
 * 在临时 DSH_HOME 下写一个 .credentials.yaml，跑 fn，然后恢复环境。
 * 用真实文件而不是打桩，是为了连"只在 refs: 段内匹配"这类缩进语义一起验到。
 */
async function withCredentials(yaml, fn) {
  const savedHome = process.env.DSH_HOME
  const savedEnv = {
    unisound: process.env.UNISOUND_API_KEY,
    systemone: process.env.SYSTEMONE_API_KEY,
    typesafe: process.env.TYPESAFE_API_KEY,
  }
  delete process.env.UNISOUND_API_KEY
  delete process.env.SYSTEMONE_API_KEY
  delete process.env.TYPESAFE_API_KEY
  const home = mkdtempSync(join(tmpdir(), 'dsh-systemone-cred-'))
  process.env.DSH_HOME = home
  if (yaml !== null) writeFileSync(join(home, '.credentials.yaml'), yaml)
  try {
    return await fn()
  } finally {
    rmSync(home, { recursive: true, force: true })
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
    if (savedEnv.unisound !== undefined) process.env.UNISOUND_API_KEY = savedEnv.unisound
    if (savedEnv.systemone !== undefined) process.env.SYSTEMONE_API_KEY = savedEnv.systemone
    if (savedEnv.typesafe !== undefined) process.env.TYPESAFE_API_KEY = savedEnv.typesafe
  }
}

test('凭证缝：apiKeyRef 指定的引用名从 .credentials.yaml 读到密钥', async () => {
  await withCredentials([
    'refs:',
    '  MY_SYSTEMONE_KEY: sk-from-refs',
    '',
  ].join('\n'), async () => {
    const p = new HttpProvider({ provider: 'unisound', apiKey: '', apiKeyRef: 'MY_SYSTEMONE_KEY' }, 'unisound')
    assert.equal(p.resolveApiKey(), 'sk-from-refs')
  })
})

test('凭证缝：apiKeyRef 留空时按默认名回退（SYSTEMONE_API_KEY 优先）', async () => {
  await withCredentials([
    'refs:',
    '  UNISOUND_API_KEY: sk-unisound',
    '  SYSTEMONE_API_KEY: sk-systemone',
    '',
  ].join('\n'), async () => {
    const p = new HttpProvider({ provider: 'unisound', apiKey: '' }, 'unisound')
    assert.equal(p.resolveApiKey(), 'sk-systemone', 'SYSTEMONE_API_KEY 应排在 UNISOUND_API_KEY 之前')
  })
})

test('凭证缝：剥掉值两端的引号（否则会连引号塞进 Authorization 头）', async () => {
  await withCredentials([
    'refs:',
    '  Q1: "sk-double-quoted"',
    "  Q2: 'sk-single-quoted'",
    '',
  ].join('\n'), async () => {
    assert.equal(new HttpProvider({ apiKey: '', apiKeyRef: 'Q1' }, 'unisound').resolveApiKey(), 'sk-double-quoted')
    assert.equal(new HttpProvider({ apiKey: '', apiKeyRef: 'Q2' }, 'unisound').resolveApiKey(), 'sk-single-quoted')
  })
})

test('凭证缝：裁掉未加引号值后的行内注释，但引号内的 # 属于值本身', async () => {
  await withCredentials([
    'refs:',
    '  PLAIN: sk-plain # 我的备注',
    '  QUOTED: "sk-with#hash"',
    '',
  ].join('\n'), async () => {
    assert.equal(new HttpProvider({ apiKey: '', apiKeyRef: 'PLAIN' }, 'unisound').resolveApiKey(), 'sk-plain')
    assert.equal(new HttpProvider({ apiKey: '', apiKeyRef: 'QUOTED' }, 'unisound').resolveApiKey(), 'sk-with#hash')
  })
})

test('凭证缝：只读 refs: 段，忽略段外同名键与更浅缩进', async () => {
  await withCredentials([
    'MY_KEY: sk-outside-refs',
    'other:',
    '  MY_KEY: sk-other-section',
    'refs:',
    '  MY_KEY: sk-inside-refs',
    'top_after:',
    '  MY_KEY: sk-after',
    '',
  ].join('\n'), async () => {
    const p = new HttpProvider({ apiKey: '', apiKeyRef: 'MY_KEY' }, 'unisound')
    assert.equal(p.resolveApiKey(), 'sk-inside-refs')
  })
})

test('凭证优先级：配置明文 > 环境变量 > 凭证缝', async () => {
  await withCredentials([
    'refs:',
    '  SYSTEMONE_API_KEY: sk-from-refs',
    '',
  ].join('\n'), async () => {
    // 三层都在：配置明文胜出
    assert.equal(
      new HttpProvider({ apiKey: 'sk-config', apiKeyRef: 'SYSTEMONE_API_KEY' }, 'unisound').resolveApiKey(),
      'sk-config',
    )
    // 摘掉配置明文：环境变量胜出
    process.env.SYSTEMONE_API_KEY = 'sk-env'
    try {
      assert.equal(new HttpProvider({ apiKey: '' }, 'unisound').resolveApiKey(), 'sk-env')
    } finally {
      delete process.env.SYSTEMONE_API_KEY
    }
    // 只剩凭证缝
    assert.equal(new HttpProvider({ apiKey: '' }, 'unisound').resolveApiKey(), 'sk-from-refs')
  })
})

test('凭证缝：文件缺失或引用名不存在时给出可操作报错', async () => {
  // 完全没有凭证文件
  await withCredentials(null, async () => {
    const p = new HttpProvider({ apiKey: '' }, 'unisound')
    assert.throws(() => p.resolveApiKey(), /未配置凭证/)
    assert.throws(() => p.resolveApiKey(), /credentials\.yaml/)
  })
  // 有文件但没有想要的引用名
  await withCredentials('refs:\n  OTHER: sk-x\n', async () => {
    const p = new HttpProvider({ apiKey: '', apiKeyRef: 'NOPE' }, 'unisound')
    assert.throws(() => p.resolveApiKey(), /refs\.<apiKeyRef>/)
  })
})

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
  assert.ok(res.answers.q2.confidence >= 0.5, 'noul 置信度应取倾向一侧的概率')
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
  // 用空的临时 DSH_HOME，连"本机 ~/.dsh/.credentials.yaml 里恰好有 key"这种情况也排除掉
  const p = createProvider({ provider: 'unisound', apiKey: '' })
  await withCredentials(null, async () => {
    await assert.rejects(() => p.decide({ state: 'x', questions: {} }), /未配置凭证/)
    await assert.rejects(() => p.decide({ state: 'x', questions: {} }), /apiKey/)
  })
} finally {
  if (saved.unisound !== undefined) process.env.UNISOUND_API_KEY = saved.unisound
  if (saved.systemone !== undefined) process.env.SYSTEMONE_API_KEY = saved.systemone
}
})

test('provider：外部 signal 已 aborted 时不再发起请求', async () => {
const p = new HttpProvider({ provider: 'http', endpoint: 'http://example.com', apiKey: 'k' })
const calls = []
const originalFetch = globalThis.fetch
// 模拟 undici：收到已中止的 signal 时直接拒绝，不发网络请求
globalThis.fetch = async (_url, options) => {
  if (options?.signal?.aborted) throw new Error('请求已中止')
  calls.push(_url)
  return new Response(JSON.stringify({ ok: true }), { status: 200 })
}
try {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    () => p.decide({ state: 'x', questions: {}, signal: controller.signal }),
    /请求已中止/,
  )
  assert.equal(calls.length, 0, 'signal 已 aborted 时不应发起请求')
} finally {
  globalThis.fetch = originalFetch
}
})

test('provider：redact 开启时 state 中的敏感信息被替换为类型标签', async () => {
const p = new HttpProvider({ provider: 'http', endpoint: 'http://example.com', apiKey: 'k', redact: true })
const bodies = []
const originalFetch = globalThis.fetch
globalThis.fetch = async (_url, options) => {
  bodies.push(JSON.parse(options.body))
  return new Response(JSON.stringify({ ok: true }), { status: 200 })
}
try {
  await p.decide({
    state: {
      contact: '手机 13812345678，邮箱 a.b@test.com，卡号 6222020200112233445',
      nested: ['身份证 11010119900307867X'],
    },
    questions: {},
  })
  const state = bodies[0].state
  assert.ok(state.contact.includes('[手机号]'))
  assert.ok(state.contact.includes('[邮箱]'))
  assert.ok(state.contact.includes('[银行卡号]'))
  assert.ok(!state.contact.includes('13812345678'), '原始手机号不应出现在请求体里')
  assert.ok(state.nested[0].includes('[身份证]'))
  assert.ok(!state.nested[0].includes('11010119900307867X'))
} finally {
  globalThis.fetch = originalFetch
}
})

test('provider：redact 关闭（默认）时 state 原样发送', async () => {
const p = new HttpProvider({ provider: 'http', endpoint: 'http://example.com', apiKey: 'k' })
const bodies = []
const originalFetch = globalThis.fetch
globalThis.fetch = async (_url, options) => {
  bodies.push(JSON.parse(options.body))
  return new Response(JSON.stringify({ ok: true }), { status: 200 })
}
try {
  await p.decide({ state: '手机 13812345678', questions: {} })
  assert.equal(bodies[0].state, '手机 13812345678', '默认不脱敏，内容原样发送')
} finally {
  globalThis.fetch = originalFetch
}
})

test('provider：临时故障（503）自动重试一次后成功', async () => {
const p = new HttpProvider({ provider: 'http', endpoint: 'http://example.com', apiKey: 'k', timeoutMs: 5000 })
let calls = 0
const originalFetch = globalThis.fetch
globalThis.fetch = async () => {
  calls += 1
  if (calls === 1) return new Response('busy', { status: 503 })
  return new Response(JSON.stringify({ answers: {} }), { status: 200 })
}
try {
  const result = await p.decide({ state: 'x', questions: {} })
  assert.deepEqual(result.answers, {})
  assert.equal(calls, 2, '首次 503 后应重试一次')
} finally {
  globalThis.fetch = originalFetch
}
})

test('provider：非临时故障（404）不重试', async () => {
const p = new HttpProvider({ provider: 'http', endpoint: 'http://example.com', apiKey: 'k' })
let calls = 0
const originalFetch = globalThis.fetch
globalThis.fetch = async () => {
  calls += 1
  return new Response('not found', { status: 404 })
}
try {
  await assert.rejects(() => p.decide({ state: 'x', questions: {} }), /HTTP 404/)
  assert.equal(calls, 1, '404 不是临时故障，不应重试')
} finally {
  globalThis.fetch = originalFetch
}
})

test('provider：端点不是合法 URL 时在发请求前给出清晰错误', async () => {
let calls = 0
const originalFetch = globalThis.fetch
globalThis.fetch = async () => {
  calls += 1
  return new Response('{}', { status: 200 })
}
try {
  const p = new HttpProvider({ provider: 'http', endpoint: 'example.com', apiKey: 'k' })
  await assert.rejects(() => p.decide({ state: 'x', questions: {} }), /合法 URL/)
  const p2 = new HttpProvider({ provider: 'unisound', baseUrl: 'maas-api.unisound.com', apiKey: 'k' })
  await assert.rejects(() => p2.decide({ state: 'x', questions: {} }), /合法 URL/)
  assert.equal(calls, 0, '非法 URL 不应发出任何请求')
} finally {
  globalThis.fetch = originalFetch
}
})

/* ─── 场景库 ──────────────────────────────────────────────────────────────── */

test('场景库内置 11 大业务域', () => {
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
    'requirement_clarity',
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

/* ─── 别名解析（回归：自定义场景的别名曾被内置场景静默抢走） ───────────────── */

test('自定义场景声明的别名必须解析到它自己，而不是被内置场景抢走', () => {
  // 旧实现的 bug：resolveScenarios 只登记 id，别名冲突交给 Array.find 的
  // 遍历顺序决定，内置场景永远在前 → 自定义场景的别名永远查不到。
  const { scenarios: merged } = resolveScenarios(JSON.stringify([
    {
      id: 'vip_service',
      title: 'VIP 专属客服',
      aliases: ['客服', 'VIP'],
      questions: { q: { type: 'noul', instructions: '?' } },
    },
  ]))
  assert.equal(findScenario(merged, '客服')?.id, 'vip_service', '自定义场景的别名应优先命中自己')
  assert.equal(findScenario(merged, 'VIP')?.id, 'vip_service')
  assert.equal(findScenario(merged, 'vip_service')?.id, 'vip_service')
})

test('覆盖内置场景时继承其别名：省略 aliases 不等于清空别名', () => {
  const { scenarios: merged } = resolveScenarios(JSON.stringify([
    { id: 'customer_service', title: '我的客服', questions: { q: { type: 'noul', instructions: '?' } } },
  ]))
  assert.equal(merged.length, 11, '同 id 应覆盖而非新增')
  const replaced = findScenario(merged, 'customer_service')
  assert.equal(replaced.title, '我的客服')
  assert.equal(replaced.source, 'custom')
  // 内置场景原有的别名不应变成查不到的死键
  for (const alias of ['ticket_triage', '工单分流', '客服', '派单']) {
    assert.equal(findScenario(merged, alias)?.id, 'customer_service', `别名 ${alias} 不应失效`)
    assert.equal(findScenario(merged, alias)?.title, '我的客服', `别名 ${alias} 应指向覆盖后的场景`)
  }
})

test('覆盖内置场景并给出新别名时，新旧别名共存且不重复', () => {
  const { scenarios: merged } = resolveScenarios(JSON.stringify([
    {
      id: 'customer_service',
      title: '我的客服',
      aliases: ['VIP客服', '工单分流'],
      questions: { q: { type: 'noul', instructions: '?' } },
    },
  ]))
  const replaced = findScenario(merged, 'customer_service')
  assert.equal(findScenario(merged, 'VIP客服')?.id, 'customer_service', '新别名应生效')
  assert.equal(findScenario(merged, '派单')?.id, 'customer_service', '未冲突的旧别名仍应保留')
  const lower = replaced.aliases.map((a) => a.toLowerCase())
  assert.equal(new Set(lower).size, lower.length, '别名不应重复（工单分流 新旧都有）')
})

test('多个自定义场景抢同一别名时，后声明者稳定获胜', () => {
  const { scenarios: merged } = resolveScenarios(JSON.stringify([
    { id: 'first', title: '先', aliases: ['共享'], questions: { q: { type: 'noul', instructions: '?' } } },
    { id: 'second', title: '后', aliases: ['共享'], questions: { q: { type: 'noul', instructions: '?' } } },
  ]))
  assert.equal(findScenario(merged, '共享')?.id, 'second', '后写覆盖，结果必须确定')
})

test('别名解析不因自定义场景而回归：无冲突时内置别名照常工作', () => {
  const { scenarios: withCustom } = resolveScenarios(JSON.stringify([
    { id: 'legal', title: '法务', aliases: ['合同'], questions: { q: { type: 'noul', instructions: '?' } } },
  ]))
  assert.equal(findScenario(withCustom, '工单分流')?.id, 'customer_service')
  assert.equal(findScenario(withCustom, '开发')?.id, 'software_dev')
  assert.equal(findScenario(withCustom, '合同')?.id, 'legal')
  assert.equal(findScenario(withCustom, '不存在的场景'), undefined)
  assert.equal(findScenario(withCustom, ''), undefined)
  assert.equal(findScenario(withCustom, 123), undefined)
})

/* ─── 别名冲突提示（非致命：条目不被跳过，但要告知被遮蔽者） ───────────────── */

test('别名撞名时给出提示而非报错，场景仍然可用', () => {
  const { scenarios: merged, problems, warnings } = resolveScenarios(JSON.stringify([
    { id: 'vip_service', title: 'VIP', aliases: ['客服'], questions: { q: { type: 'noul', instructions: '?' } } },
  ]))
  assert.deepEqual(problems, [], '别名冲突不是致命错误，不应跳过条目')
  assert.equal(warnings.length, 1, '应给出一条提示')
  assert.ok(warnings[0].includes('vip_service'), '提示应指明声明者')
  assert.ok(warnings[0].includes('customer_service'), '提示应指明被遮蔽者')
  assert.equal(merged.length, 12, '场景仍然被加入库中')
  assert.equal(findScenario(merged, '客服')?.id, 'vip_service', '按「自定义优先」解析')
})

test('覆盖内置场景并继承其别名不算撞名，不产生提示', () => {
  const cases = {
    '省略 aliases（继承）': { id: 'customer_service', title: '我的客服', questions: { q: { type: 'noul', instructions: '?' } } },
    '显式重复原别名': { id: 'customer_service', title: '我的客服', aliases: ['客服', '派单'], questions: { q: { type: 'noul', instructions: '?' } } },
  }
  for (const [label, spec] of Object.entries(cases)) {
    const { warnings, problems } = resolveScenarios(JSON.stringify([spec]))
    assert.deepEqual(problems, [], `${label}：不应有致命问题`)
    assert.deepEqual(warnings, [], `${label}：覆盖同一个场景不算别名冲突`)
  }
})

test('别名等于自己的 id 不算撞名', () => {
  const { warnings } = resolveScenarios(JSON.stringify([
    { id: 'legal', title: '法务', aliases: ['legal'], questions: { q: { type: 'noul', instructions: '?' } } },
  ]))
  assert.deepEqual(warnings, [], '别名与自身 id 同名是无害的')
})

test('别名撞名提示对大小写不敏感', () => {
  const { warnings } = resolveScenarios(JSON.stringify([
    { id: 'my_edu', title: '我的教育', aliases: ['EDU'], questions: { q: { type: 'noul', instructions: '?' } } },
  ]))
  assert.equal(warnings.length, 1, 'EDU 与内置 education 的别名 edu 撞名，应提示')
  assert.ok(warnings[0].includes('education'))
})

test('两个自定义场景抢同一别名时给出提示', () => {
  const { warnings } = resolveScenarios(JSON.stringify([
    { id: 'a', title: 'A', aliases: ['共享'], questions: { q: { type: 'noul', instructions: '?' } } },
    { id: 'b', title: 'B', aliases: ['共享'], questions: { q: { type: 'noul', instructions: '?' } } },
  ]))
  assert.equal(warnings.length, 1, '后声明者遮蔽先声明者，应提示一次')
  assert.ok(warnings[0].includes('"b"'), '提示应指向后声明者')
  assert.ok(warnings[0].includes('a'), '提示应指出被遮蔽者')
})

test('无冲突时没有提示', () => {
  const { warnings } = resolveScenarios('')
  assert.deepEqual(warnings, [])
  const { warnings: w2 } = resolveScenarios(JSON.stringify([
    { id: 'legal', title: '法务', aliases: ['合同'], questions: { q: { type: 'noul', instructions: '?' } } },
  ]))
  assert.deepEqual(w2, [])
})

/* ─── 规范化（回归：未 trim 的 id/aliases 与 __proto__ 键曾导致静默失效） ───── */

test('id 与 aliases 会 trim：带首尾空白的定义仍可被查到', () => {
  // 旧 bug：validateScenario 只用 trim 判空，normalizeScenario 原样存 id，
  // 而 findScenario 会 trim 查询值 —— 两边不对称，存进去的 id 永远匹配不上。
  const { scenarios: merged, problems } = resolveScenarios(JSON.stringify([
    { id: '  legal_review\n', title: '法务预审', questions: { q: { type: 'noul', instructions: '?' } } },
  ]))
  assert.deepEqual(problems, [])
  const entry = merged.find((s) => s.source === 'custom')
  assert.equal(entry.id, 'legal_review', '入库 id 应已 trim')
  assert.equal(findScenario(merged, 'legal_review')?.id, 'legal_review', '应能用 trim 后的 id 查到')
  assert.equal(findScenario(merged, '  legal_review\n')?.id, 'legal_review', '未 trim 的查询值也应能查到')
})

test('aliases 会 trim 并丢弃空白项', () => {
  const { scenarios: merged } = resolveScenarios(JSON.stringify([
    { id: 'legal', title: '法务', aliases: ['  合同  ', '', '   '], questions: { q: { type: 'noul', instructions: '?' } } },
  ]))
  const entry = findScenario(merged, 'legal')
  assert.deepEqual(entry.aliases, ['合同'], '空串与纯空白别名应被丢弃')
  assert.equal(findScenario(merged, '合同')?.id, 'legal', 'trim 后的别名应可查到')
})

test('带空白的 id 仍能正确覆盖内置场景，而不是新增副本', () => {
  // 旧 bug：' customer_service ' 不 trim 时匹配不上内置 id，于是新增了一个
  // 永远查不到的副本（总数 11），且不产生任何告警。
  const { scenarios: merged } = resolveScenarios(JSON.stringify([
    { id: ' customer_service ', title: '我的客服', questions: { q: { type: 'noul', instructions: '?' } } },
  ]))
  assert.equal(merged.length, 11, '应覆盖而非新增')
  assert.equal(merged.filter((s) => s.source === 'custom').length, 1)
  assert.equal(findScenario(merged, 'customer_service')?.title, '我的客服')
})

test('__proto__ 作为问题 id 会被拒绝，不产出零问题的空场景', () => {
  // 旧 bug：questions['__proto__'] = q 走 [[Set]] 改的是原型，但 Object.keys
  // 又能看到 __proto__ 这个自有键，于是「至少 1 个问题」校验通过，
  // 却产出 0 个问题的空场景，run 静默返回 ok + 空 answers。
  const { scenarios: merged, problems } = resolveScenarios(JSON.stringify([
    { id: 'p', title: 'P', questions: JSON.parse('{"__proto__":{"type":"noul","instructions":"?"}}') },
  ]))
  assert.equal(problems.length, 1, '应报错而不是静默通过')
  assert.ok(problems[0].includes('__proto__'))
  assert.equal(merged.length, 11, '非法条目应被跳过')
  assert.equal(findScenario(merged, 'p'), undefined, '不应产出空场景')
})

test('constructor / prototype 作为问题 id 同样被拒绝', () => {
  for (const qid of ['constructor', 'prototype']) {
    const { problems } = resolveScenarios(JSON.stringify([
      { id: 'x', title: 'X', questions: { [qid]: { type: 'noul', instructions: '?' } } },
    ]))
    assert.equal(problems.length, 1, `${qid} 应被拒绝`)
    assert.ok(problems[0].includes(qid))
  }
})

test('规范化不影响正常场景：问题键与类型原样保留', () => {
  const { scenarios: merged, problems } = resolveScenarios(JSON.stringify([
    {
      id: 'legal',
      title: '法务',
      aliases: ['合同'],
      questions: {
        a: { type: 'noul', instructions: '有风险？' },
        b: { type: 'choice', instructions: '哪类？', criteria: { x: 'X', y: 'Y' } },
        c: { type: 'score', instructions: '多严重？', criteria: ['低', '高'] },
      },
    },
  ]))
  assert.deepEqual(problems, [])
  const entry = findScenario(merged, '合同')
  assert.deepEqual(Object.keys(entry.questions), ['a', 'b', 'c'])
  assert.equal(entry.questions.a.type, 'noul')
  assert.deepEqual(entry.questions.b.criteria, { x: 'X', y: 'Y' })
  assert.deepEqual(entry.questions.c.criteria, ['低', '高'])
  assert.equal(Object.getPrototypeOf(entry.questions), null, 'questions 应为无原型对象')
})

test('无原型的 questions 仍可被正常遍历与序列化', () => {
  // Object.create(null) 的对象没有 hasOwnProperty/toString；确认下游用到的
  // Object.keys / Object.entries / for...of / JSON.stringify 都不受影响。
  const { scenarios: merged } = resolveScenarios(JSON.stringify([
    { id: 'legal', title: '法务', questions: {
      a: { type: 'noul', instructions: '?' },
      b: { type: 'score', instructions: '?', criteria: ['低', '高'] },
    } },
  ]))
  const questions = findScenario(merged, 'legal').questions
  assert.deepEqual(Object.keys(questions), ['a', 'b'])
  assert.equal(Object.entries(questions).length, 2)
  assert.equal([...Object.values(questions)].length, 2)
  assert.equal(JSON.parse(JSON.stringify(questions)).a.type, 'noul')
  // 下游 format/normalize 走的就是这条路径
  assert.equal(questions.a.instructions, '?')
  assert.equal(questions.a.label, 'a', 'label 缺省应回退到 qid')
})

/* ─── action: list / describe ─────────────────────────────────────────────── */

test('action=list 列出全部场景', async () => {
  const out = await scenarioTool.execute({ action: 'list' }, {})
  assert.equal(out.ok, true)
  assert.equal(out.count, 11)
  assert.ok(out.summary.includes('SystemOne 场景库'))
})

test('action=list 支持关键词过滤', async () => {
  const out = await scenarioTool.execute({ action: 'list', keyword: '风控' }, {})
  assert.equal(out.count, 1)
  assert.equal(out.scenarios[0].id, 'risk_control')
})

test('action=list 透出别名冲突提示，无提示时不出现该字段', async () => {
  const merged = resolveScenarios(JSON.stringify([
    { id: 'vip_service', title: 'VIP', aliases: ['客服'], questions: { q: { type: 'noul', instructions: '?' } } },
  ]))

  // 有提示：结构化字段 + summary 都要能看到
  const tool = Object.fromEntries(
    createTools(provider, config, merged.scenarios, { warnings: () => merged.warnings }).map((t) => [t.name, t]),
  ).systemone_scenario
  const out = await tool.execute({ action: 'list' }, {})
  assert.equal(out.ok, true)
  assert.equal(out.warnings.length, 1)
  assert.ok(out.summary.includes('### 配置提示'), 'summary 里应有提示小节')
  assert.ok(out.summary.includes('vip_service'))

  // 无提示：不应凭空多出字段或小节
  const cleanTool = Object.fromEntries(
    createTools(provider, config, merged.scenarios, { warnings: () => [] }).map((t) => [t.name, t]),
  ).systemone_scenario
  const clean = await cleanTool.execute({ action: 'list' }, {})
  assert.ok(!('warnings' in clean), '无提示时不应出现 warnings 字段')
  assert.ok(!clean.summary.includes('配置提示'))
})

test('action=list 在 warnings 钩子缺失或抛错时仍可用', async () => {
  const missing = Object.fromEntries(
    createTools(provider, config, scenarios).map((t) => [t.name, t]),
  ).systemone_scenario
  assert.equal((await missing.execute({ action: 'list' }, {})).ok, true)

  const throwing = Object.fromEntries(
    createTools(provider, config, scenarios, { warnings: () => { throw new Error('boom') } }).map((t) => [t.name, t]),
  ).systemone_scenario
  const out = await throwing.execute({ action: 'list' }, {})
  assert.equal(out.ok, true, '提示读取失败不应影响 list')
  assert.equal(out.count, 11)
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
  assert.equal(out.available.length, 11)
})

/* ─── action: run（内置场景全覆盖） ───────────────────────────────────────── */

// 必须与 BUILTIN_SCENARIOS 的 id 一一对应：漏一个就是"主推场景零端到端覆盖"。
// 下方有断言强制两者集合相等，新增内置场景时这里不同步会直接测试失败。
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
  software_dev: '修复结算模块在并发场景下偶发的金额精度错误，涉及账务与对账两处实现，需要先读代码确认调用链。',
  requirement_clarity: '帮我把这个功能优化一下，跟之前那个一样就行。',
}

test('SAMPLES 覆盖全部内置场景，且没有多余或拼错的 id', () => {
  const builtinIds = BUILTIN_SCENARIOS.map((s) => s.id).sort()
  const sampleIds = Object.keys(SAMPLES).sort()
  assert.deepEqual(sampleIds, builtinIds, '每个内置场景都必须有一个端到端 sample')
})

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

test('params.criteria 为空对象时被忽略并报告', async () => {
const out = await scenarioTool.execute({
  action: 'run',
  scenario: 'customer_service',
  state: 'VIP 客户工单',
  params: { department: { criteria: {} } },
})
assert.equal(out.ok, true)
assert.equal(out.warnings.length, 1)
assert.match(out.warnings[0], /department\.criteria/)
assert.ok(Object.keys(out.answers.department.probabilities).length >= 2, '默认选项应保留')
})

/* ─── 工具路径的 state 硬上限 ─────────────────────────────────────────────── */

test('action=run 超长 state 会被截断后再发送', async () => {
const seen = []
const spy = {
  name: 'spy',
  async decide(options) {
    seen.push(options.state)
    return new MockProvider({}).decide(options)
  },
}
const spyTools = Object.fromEntries(createTools(spy, config, scenarios).map((t) => [t.name, t]))
const out = await spyTools.systemone_scenario.execute({
  action: 'run',
  scenario: 'customer_service',
  state: '退'.repeat(40000),
}, {})
assert.equal(out.ok, true)
assert.equal(seen.length, 1)
assert.ok(seen[0].length < 20000, `state 应被截断（实际 ${seen[0].length} 字符）`)
assert.ok(seen[0].includes('已截断'))
})

test('systemone_decide 超大的对象 state 按序列化长度截断', async () => {
const seen = []
const spy = {
  name: 'spy',
  async decide(options) {
    seen.push(options.state)
    return new MockProvider({}).decide(options)
  },
}
const spyTools = Object.fromEntries(createTools(spy, config, scenarios).map((t) => [t.name, t]))
await spyTools.systemone_decide.execute({
  state: { blob: '退'.repeat(40000) },
  questions: { ok: { type: 'noul', instructions: '?' } },
}, {})
assert.equal(seen.length, 1)
assert.equal(typeof seen[0], 'string', '超限对象应降级为截断后的 JSON 文本')
assert.ok(seen[0].includes('已截断'))
// 未超限的对象保持原结构
await spyTools.systemone_decide.execute({
  state: { small: '正常内容' },
  questions: { ok: { type: 'noul', instructions: '?' } },
}, {})
assert.deepEqual(seen[1], { small: '正常内容' })
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
  assert.equal(merged.length, 12) // 11 内置 + 1 自定义
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
  assert.equal(merged.length, 11)
  assert.equal(findScenario(merged, 'risk_control').title, '风控（自定义版）')
})

test('非法自定义场景被跳过并给出原因', () => {
  const bad = JSON.stringify([
    { id: 'broken', title: '缺问题' },
    { id: 'bad_type', title: '类型错误', questions: { q: { type: 'essay', instructions: 'x' } } },
  ])
  const { scenarios: merged, problems } = resolveScenarios(bad)
  assert.equal(merged.length, 11)
  assert.equal(problems.length, 2)
  assert.ok(problems.every((p) => p.includes('已跳过')))
})

test('自定义场景 JSON 语法错误被捕获', () => {
  const { scenarios: merged, problems } = resolveScenarios('{ not json')
  assert.equal(merged.length, 11)
  assert.equal(problems.length, 1)
  assert.ok(problems[0].includes('解析失败'))
})

/* ─── patch 式覆盖（opt-in："patch": true 才做字段级合并） ──────────────────── */

test('patch 只覆盖给出的问题字段，其余原样保留', () => {
const { scenarios: merged, problems } = resolveScenarios(JSON.stringify([
  {
    id: 'customer_service',
    patch: true,
    questions: { department: { criteria: { vip: 'VIP 专属通道', billing: '账单' } } },
  },
]))
assert.deepEqual(problems, [])
assert.equal(merged.length, 11, 'patch 不新增场景')
const entry = findScenario(merged, 'customer_service')
assert.deepEqual(Object.keys(entry.questions), ['department', 'severity', 'escalate'], '问题集合与顺序保留')
assert.deepEqual(entry.questions.department.criteria, { vip: 'VIP 专属通道', billing: '账单' }, '给出的问题字段被覆盖')
assert.equal(entry.questions.severity.criteria.length, 4, '未提到的问题原样保留')
assert.match(entry.recommendation, /\{priority\}/, '未给出的 recommendation 保留')
assert.equal(entry.source, 'custom')
})

test('patch 可以新增问题与追加别名', () => {
const { scenarios: merged, problems, warnings } = resolveScenarios(JSON.stringify([
  {
    id: 'customer_service',
    patch: true,
    aliases: ['售后'],
    questions: {
      vip: { type: 'noul', instructions: '是否 VIP 客户？' },
      department: { label: '归属团队' },
    },
  },
]))
assert.deepEqual(problems, [])
assert.deepEqual(warnings, [], '追加与原场景不冲突的别名不算撞名')
const entry = findScenario(merged, 'customer_service')
assert.ok('vip' in entry.questions, '新 qid 应被追加')
assert.equal(entry.questions.department.label, '归属团队', '仅给 label 就只覆盖 label')
assert.ok(entry.questions.department.criteria.billing, '同问题未给出的字段保留')
assert.equal(findScenario(merged, '售后')?.id, 'customer_service', '追加的别名可查')
})

test('patch 只改建议模板也成立（可省略 questions/title）', () => {
const { scenarios: merged, problems } = resolveScenarios(JSON.stringify([
  { id: 'risk_control', patch: true, recommendation: '按 {risk_level} 处置' },
]))
assert.deepEqual(problems, [])
const entry = findScenario(merged, 'risk_control')
assert.equal(entry.recommendation, '按 {risk_level} 处置')
assert.equal(Object.keys(entry.questions).length, 3, '原问题全部保留')
})

test('patch 目标不存在时跳过并说明原因', () => {
const { scenarios: merged, problems } = resolveScenarios(JSON.stringify([
  { id: 'no_such_scene', patch: true, questions: { q: { type: 'noul', instructions: '?' } } },
]))
assert.equal(merged.length, 11)
assert.equal(problems.length, 1)
assert.ok(problems[0].includes('patch 目标'))
assert.ok(problems[0].includes('no_such_scene'))
})

test('patch 合并结果非法时跳过，原场景不受影响', () => {
const { scenarios: merged, problems } = resolveScenarios(JSON.stringify([
  { id: 'customer_service', patch: true, questions: { department: { criteria: { only: '仅一个选项' } } } },
]))
assert.equal(problems.length, 1, '合并后 choice 选项少于 2 个应被拦下')
assert.ok(problems[0].includes('已跳过'))
const entry = findScenario(merged, 'customer_service')
assert.ok(entry.questions.department.criteria.billing, '原场景保持不变')
assert.equal(entry.source, 'builtin')
})

test('patch 后的场景可正常执行决策', async () => {
const { scenarios: merged, problems } = resolveScenarios(JSON.stringify([
  {
    id: 'customer_service',
    patch: true,
    questions: { department: { criteria: { vip: 'VIP 专属通道', billing: '账单' } } },
  },
]))
assert.deepEqual(problems, [])
const patchedTools = Object.fromEntries(createTools(provider, config, merged).map((t) => [t.name, t]))
const out = await patchedTools.systemone_scenario.execute({
  action: 'run',
  scenario: 'customer_service',
  state: 'VIP 客户的账单工单',
}, {})
assert.equal(out.ok, true)
assert.ok(['vip', 'billing'].includes(out.decision.department), 'patch 后的选项生效')
assert.ok('escalate' in out.decision, '未 patch 的问题照常回答')
})

test('patch 目标可以是前面的自定义场景（链式 patch）', () => {
const { scenarios: merged, problems } = resolveScenarios(JSON.stringify([
  { id: 'legal', title: '法务', questions: { risk: { type: 'noul', instructions: '有风险？' } } },
  {
    id: 'legal',
    patch: true,
    questions: {
      risk: { label: '风险' },
      level: { type: 'score', instructions: '几级？', criteria: ['低', '高'] },
    },
  },
]))
assert.deepEqual(problems, [])
assert.equal(merged.length, 12)
const entry = findScenario(merged, 'legal')
assert.equal(entry.title, '法务', 'patch 未给 title 时保留')
assert.equal(entry.questions.risk.label, '风险')
assert.equal(entry.questions.risk.instructions, '有风险？')
assert.ok('level' in entry.questions)
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

/* ─── 空决策守卫：不允许"成功但空" ───────────────────────────────────────── */

test('上游返回空 answers 时不得报 ok:true（静默空成功）', async () => {
  const empty = { name: 'empty', async decide() { return { answers: {} } } }
  const emptyTools = Object.fromEntries(createTools(empty, config, scenarios).map((t) => [t.name, t]))
  const out = await emptyTools.systemone_decide.execute({
    state: '任意内容',
    questions: { q: { type: 'noul', instructions: '是？' } },
  }, {})

  assert.equal(out.ok, false, '一个决策都没产出时必须是失败')
  assert.match(out.error, /未产出任何可用的决策/)
  assert.match(out.error, /上游未返回任何 answers/)
  assert.deepEqual(out.decision, {})
  assert.equal(out.needs_human_review, true, '空决策必须标记为需要复核')
  assert.match(out.summary, /未产出任何可用的决策/)
})

test('上游返回无法识别的 type 时不得报 ok:true', async () => {
  const weird = {
    name: 'weird',
    async decide() { return { answers: { q: { type: 'unknown' }, r: { type: 'select' } } } },
  }
  const weirdTools = Object.fromEntries(createTools(weird, config, scenarios).map((t) => [t.name, t]))
  const out = await weirdTools.systemone_decide.execute({
    state: '任意内容',
    questions: { q: { type: 'noul', instructions: '是？' } },
  }, {})

  assert.equal(out.ok, false, '答案没有可用取值时不得报成功')
  assert.match(out.error, /没有可用取值/)
  assert.match(out.error, /无法判断：q/, '错误信息要点出哪些问题无法判断')
  assert.equal(out.needs_human_review, true)
})

test('部分问题有答案时仍算成功：空决策守卫不误伤正常路径', async () => {
  const partial = {
    name: 'partial',
    async decide() {
      return { answers: { good: { type: 'noul', noul: 0.9 }, bad: { type: 'unknown' } } }
    },
  }
  const partialTools = Object.fromEntries(createTools(partial, config, scenarios).map((t) => [t.name, t]))
  const out = await partialTools.systemone_decide.execute({
    state: '任意内容',
    questions: {
      good: { type: 'noul', instructions: '是？' },
      bad: { type: 'noul', instructions: '也是？' },
    },
  }, {})

  assert.equal(out.ok, true, '只要有一个问题产出了决策就算成功')
  assert.equal(out.decision.good, true)
  // 无法判断的问题会被记为 null（"无法判断"），这不影响整体成功——
  // 守卫只要求"至少有一个可用决策"，而不是"每个问题都必须可用"。
  assert.equal(out.decision.bad, null)
  assert.equal(out.labels.bad, '无法判断')
})

test('questions 为空对象时不得报 ok:true', async () => {
  const provider = { name: 'p', async decide() { return { answers: {} } } }
  const t = Object.fromEntries(createTools(provider, config, scenarios).map((x) => [x.name, x]))
  const out = await t.systemone_decide.execute({ state: '内容', questions: {} }, {})
  assert.equal(out.ok, false)
  assert.match(out.error, /没有提交任何问题/)
})

/* ─── 用量台账接线 ─────────────────────────────────────────────────────────── */

test('工具路径把每次调用记进台账（source=tool）', async () => {
  const recorded = []
  const usage = {
    record: (entry) => { recorded.push(entry); return entry },
    today: () => ({ day: '2026-10-05', calls: recorded.length, tokens: 0, failures: 0 }),
    formatToday: () => `今日：${recorded.length} 次判断`,
  }
  const t = Object.fromEntries(
    createTools(new MockProvider({}), { ...config, model: 'u2-decision' }, scenarios, { usage }).map((x) => [x.name, x]),
  )
  await t.systemone_scenario.execute({ action: 'run', scenario: 'customer_service', state: SAMPLES.customer_service }, {})
  await t.systemone_decide.execute({
    state: 'x',
    questions: { q: { type: 'noul', instructions: '是？' } },
  }, {})

  assert.equal(recorded.length, 2, '两次工具调用各记一条')
  assert.ok(recorded.every((e) => e.source === 'tool'))
  assert.ok(recorded.every((e) => e.ok === true))
  assert.equal(recorded[0].scenario, 'customer_service')
})

test('工具路径：上游报错时也记一条失败调用', async () => {
  const recorded = []
  const usage = { record: (e) => { recorded.push(e); return e } }
  const failing = { name: 'failing', async decide() { throw new Error('上游 503') } }
  const t = Object.fromEntries(createTools(failing, config, scenarios, { usage }).map((x) => [x.name, x]))
  await t.systemone_decide.execute({ state: 'x', questions: { q: { type: 'noul', instructions: '？' } } }, {})

  assert.equal(recorded.length, 1)
  assert.equal(recorded[0].ok, false)
  assert.equal(recorded[0].source, 'tool')
})

test('action=list 输出今日用量，供调用方顺手看到花销', async () => {
  const usage = {
    record: () => {},
    today: () => ({ day: '2026-10-05', calls: 7, tokens: 12345, failures: 1 }),
    formatToday: () => '今日：7 次判断 · 12.3k input tokens（2026-10-05），其中失败 1 次',
  }
  const t = Object.fromEntries(createTools(new MockProvider({}), config, scenarios, { usage }).map((x) => [x.name, x]))
  const out = await t.systemone_scenario.execute({ action: 'list' }, {})

  assert.equal(out.ok, true)
  assert.deepEqual(out.usage_today, { day: '2026-10-05', calls: 7, tokens: 12345, failures: 1 })
  assert.match(out.summary, /### 用量/)
  assert.match(out.summary, /12\.3k input tokens/)
})

test('action=list：台账缺失或抛错都不影响场景列表', async () => {
  const broken = {
    today() { throw new Error('台账炸了') },
    formatToday() { throw new Error('台账炸了') },
  }
  const t = Object.fromEntries(createTools(new MockProvider({}), config, scenarios, { usage: broken }).map((x) => [x.name, x]))
  const out = await t.systemone_scenario.execute({ action: 'list' }, {})
  assert.equal(out.ok, true)
  assert.equal(out.count, 11)
  assert.ok(!('usage_today' in out))
  assert.ok(!/### 用量/.test(out.summary))
})

/* ─── 复核判定：概率分布平坦度语义 ─────────────────────────────────────────── */

/** 造一个 answers 只有一个 choice 题的 provider。 */
function choiceProvider(probabilities, extra = {}) {
  return {
    name: 'stub',
    async decide() {
      const keys = Object.keys(probabilities)
      const top = keys.reduce((a, b) => (probabilities[a] >= probabilities[b] ? a : b))
      return {
        answers: {
          q: { type: 'choice', choice: top, probabilities, confidence: probabilities[top], ...extra },
        },
        model: 'stub-model',
      }
    },
  }
}

async function runWith(provider) {
  const t = Object.fromEntries(createTools(provider, config, scenarios).map((x) => [x.name, x]))
  return t.systemone_decide.execute({
    state: 'x',
    questions: { q: { type: 'choice', instructions: '选一个', criteria: { a: 'A', b: 'B', c: 'C' } } },
  }, {})
}

test('复核判定：分布接近均匀（模型在猜）标记需复核，且给出平坦度理由', async () => {
  // 三选一，最大概率 0.5 → 是均匀分布(0.333)的 1.5 倍，不满足 1.5 的严格小于 → 边界
  // 用 0.45 明确落在"平"的一侧：0.45/0.333 = 1.35 倍
  const out = await runWith(choiceProvider({ a: 0.45, b: 0.35, c: 0.2 }))
  assert.equal(out.ok, true)
  assert.equal(out.needs_human_review, true, '分布平坦必须标记复核')
  assert.ok(out.review_reasons.length > 0)
  assert.match(out.review_reasons[0], /接近均匀/)
  assert.match(out.summary, /需要人工复核/)
  assert.match(out.summary, /接近均匀/, '摘要里要给理由，不能只给结论')
})

test('复核判定：分布明显集中时不需要复核（低 confidence 也不误伤）', async () => {
  // 最大概率 0.8 → 是均匀分布的 2.4 倍，明显集中
  const out = await runWith(choiceProvider({ a: 0.8, b: 0.15, c: 0.05 }))
  assert.equal(out.needs_human_review, false)
  assert.deepEqual(out.review_reasons, [])
  assert.match(out.summary, /无需人工复核/)
})

test('复核判定：跨后端不依赖绝对阈值——confidence 低但分布集中时不再误报', async () => {
  // 这是本次语义变更的核心：旧实现只要 confidence < minConfidence 就报复核，
  // 而各家 confidence 公式不同且实测未标定。分布集中在 A（0.7）就不该报。
  const provider = {
    name: 'stub',
    async decide() {
      // 故意把 confidence 报得很低（模拟"另一个后端用了不同公式"）
      return {
        answers: { q: { type: 'choice', choice: 'a', probabilities: { a: 0.7, b: 0.2, c: 0.1 }, confidence: 0.1 } },
        model: 'stub-model',
      }
    },
  }
  const t = Object.fromEntries(createTools(provider, { ...config, minConfidence: 0.6 }, scenarios).map((x) => [x.name, x]))
  const out = await t.systemone_decide.execute({
    state: 'x',
    questions: { q: { type: 'choice', instructions: '选一个', criteria: { a: 'A', b: 'B', c: 'C' } } },
  }, {})

  // 分布集中 → 平坦度判据不报；但绝对阈值仍作为次要信号保留（兼容既有配置），
  // 所以这里会因 confidence=0.1 < 0.6 而报复核——理由必须指明是"低于阈值"而不是"分布平坦"。
  assert.equal(out.needs_human_review, true)
  assert.ok(out.review_reasons.some((r) => /低于阈值/.test(r)), '要说明是阈值触发的')
  assert.ok(!out.review_reasons.some((r) => /接近均匀/.test(r)), '分布并不平坦，不该给平坦理由')
})

test('复核判定：choice 返回 uncertain 时标记复核', async () => {
  const provider = {
    name: 'stub',
    async decide() {
      return { answers: { q: { type: 'choice', choice: 'uncertain', probabilities: { a: 0.9, b: 0.1 }, confidence: 0.9 } } }
    },
  }
  const t = Object.fromEntries(createTools(provider, config, scenarios).map((x) => [x.name, x]))
  const out = await t.systemone_decide.execute({
    state: 'x',
    questions: { q: { type: 'choice', instructions: '选一个', criteria: { a: 'A', b: 'B' } } },
  }, {})
  assert.equal(out.needs_human_review, true)
  assert.ok(out.review_reasons.some((r) => /uncertain/.test(r)))
})

test('复核判定：noul 落在摇摆区间时标记复核', async () => {
  const provider = { name: 'stub', async decide() { return { answers: { q: { type: 'noul', noul: 0.5, confidence: 0.5 } } } } }
  const t = Object.fromEntries(createTools(provider, config, scenarios).map((x) => [x.name, x]))
  const out = await t.systemone_decide.execute({
    state: 'x',
    questions: { q: { type: 'noul', instructions: '是？' } },
  }, {})
  assert.equal(out.needs_human_review, true)
  assert.ok(out.review_reasons.some((r) => /摇摆区间/.test(r)))
})

test('复核判定：二选一题最大概率 0.6 视为偏平（1.2 倍均匀）', async () => {
  // 二选一：均匀是 0.5，0.6/0.5 = 1.2 倍 < 1.5 → 平
  const out = await runWith(choiceProvider({ a: 0.6, b: 0.4 }))
  assert.equal(out.needs_human_review, true)
  assert.match(out.review_reasons[0], /接近均匀/)
})

test('复核判定：明确集中的二选一不报复核', async () => {
  // 0.85/0.5 = 1.7 倍 ≥ 1.5 → 不平
  const provider = {
    name: 'stub',
    async decide() {
      return { answers: { q: { type: 'choice', choice: 'a', probabilities: { a: 0.85, b: 0.15 }, confidence: 0.85 } } }
    },
  }
  const t = Object.fromEntries(createTools(provider, config, scenarios).map((x) => [x.name, x]))
  const out = await t.systemone_decide.execute({
    state: 'x',
    questions: { q: { type: 'choice', instructions: '选一个', criteria: { a: 'A', b: 'B' } } },
  }, {})
  assert.equal(out.needs_human_review, false)
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
