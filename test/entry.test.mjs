/**
 * entry.test.mjs — 插件入口（lib/index.js）的装配测试。
 *
 * 宿主在运行时才提供 `@deepseek-ai/cordis` 与 `@deepseek-ai/schemastery`，
 * 插件的 node_modules 里没有它们。这里把 lib/ 复制到临时目录、放上最小桩，
 * 真实实例化插件，验证：配置 schema 能构建、工具注册数量、场景加载、卸载清理。
 * （桩只存在于临时目录，不会污染插件包。）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const PLUGIN_ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

function buildHarness() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-systemone-entry-'))
  cpSync(join(PLUGIN_ROOT, 'lib'), join(root, 'lib'), { recursive: true })

  // 桩：@deepseek-ai/cordis
  const cordis = join(root, 'node_modules', '@deepseek-ai', 'cordis')
  mkdirSync(cordis, { recursive: true })
  writeFileSync(join(cordis, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/cordis', version: '0.0.0-stub', type: 'module', main: 'index.js',
  }))
  writeFileSync(join(cordis, 'index.js'), [
    'export class Service {',
    '  constructor(ctx, name) { this.ctx = ctx; this.name = name }',
    '}',
  ].join('\n'))

  // 桩：@deepseek-ai/schemastery（只需支持链式 default/min/max/role/volatile 与 object）
  const schemastery = join(root, 'node_modules', '@deepseek-ai', 'schemastery')
  mkdirSync(schemastery, { recursive: true })
  writeFileSync(join(schemastery, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/schemastery', version: '0.0.0-stub', type: 'module', main: 'index.js',
  }))
  writeFileSync(join(schemastery, 'index.js'), [
    'const chain = {',
    '  default: () => chain, min: () => chain, max: () => chain,',
    '  role: () => chain, volatile: () => chain,',
    '}',
    'const z = { object: () => chain, string: () => chain, number: () => chain, boolean: () => chain }',
    'export default z',
  ].join('\n'))

  return root
}

function fakeContext() {
  const registered = new Map()
  const warnings = []
  const handlers = new Map()
  const ctx = {
    logger: {
      info: () => {},
      warn: (msg) => warnings.push(String(msg)),
    },
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(handler)
      return () => {
        const list = handlers.get(event) || []
        const i = list.indexOf(handler)
        if (i >= 0) list.splice(i, 1)
      }
    },
    get: (name) => (name === 'tools' ? {
      register(definition) {
        assert.ok(!registered.has(definition.name), `工具重名：${definition.name}`)
        registered.set(definition.name, definition)
        return () => registered.delete(definition.name)
      },
    } : undefined),
  }
  return { ctx, registered, warnings, handlers }
}

const CONFIG = {
  provider: 'mock',
  apiKey: '',
  baseUrl: 'https://maas-api.unisound.com/v1',
  endpoint: '',
  model: 'u2-decision',
  timeoutMs: 30000,
  minConfidence: 0.6,
  customScenarios: '',
  autoDecide: false,
  autoScenario: '',
  autoInject: 'message',
  autoTimeoutMs: 8000,
  autoMaxMessages: 6,
  autoCacheTtlMs: 60000,
  autoMinConfidence: 0.6,
}

test('插件入口：注册 2 个工具并暴露 11 个场景', async () => {
  const root = buildHarness()
  try {
    const mod = await import(pathToFileURL(join(root, 'lib', 'index.js')).href)
    const { ctx, registered, warnings } = fakeContext()
    const service = new mod.default(ctx, CONFIG)

    assert.deepEqual([...registered.keys()].sort(), ['systemone_decide', 'systemone_scenario'])
    assert.equal(service.listScenarios().length, 11)
    assert.deepEqual(warnings, [])
    assert.equal(service.name, 'systemone')

    // 工具定义形状符合宿主契约
    for (const definition of registered.values()) {
      assert.equal(typeof definition.description, 'string')
      assert.equal(typeof definition.execute, 'function')
      assert.ok(definition.parameters?.type === 'object')
      assert.equal(typeof definition.output?.render, 'function')
      assert.ok(definition.output?.schema)
      assert.ok(Array.isArray(definition.output.render({}, { summary: 'x' })))
    }

    // 卸载后工具全部注销
    service.dispose()
    assert.equal(registered.size, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('插件入口：自定义场景从配置注入并覆盖内置场景', async () => {
  const root = buildHarness()
  try {
    const mod = await import(pathToFileURL(join(root, 'lib', 'index.js')).href)
    const { ctx, warnings } = fakeContext()
    const service = new mod.default(ctx, {
      ...CONFIG,
      customScenarios: JSON.stringify([
        { id: 'legal_review', title: '法务预审', questions: { risk: { type: 'noul', instructions: '有风险？' } } },
      ]),
    })
    const ids = service.listScenarios().map((s) => s.id)
    assert.equal(ids.length, 12)
    assert.ok(ids.includes('legal_review'))
    assert.deepEqual(warnings, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('插件入口：非法自定义场景只告警，不影响内置场景', async () => {
  const root = buildHarness()
  try {
    const mod = await import(pathToFileURL(join(root, 'lib', 'index.js')).href)
    const { ctx, registered, warnings } = fakeContext()
    const service = new mod.default(ctx, { ...CONFIG, customScenarios: '{ 坏 JSON' })

    assert.equal(service.listScenarios().length, 11)
    assert.equal(registered.size, 2)
    assert.equal(warnings.length, 1)
    assert.ok(warnings[0].includes('解析失败'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('插件入口：customScenarios 是热更新字段，原地改配置即重建场景库', async () => {
  const root = buildHarness()
  try {
    const mod = await import(pathToFileURL(join(root, 'lib', 'index.js')).href)
    const { ctx, registered, warnings } = fakeContext()
    const config = { ...CONFIG }
    const service = new mod.default(ctx, config)

    assert.equal(service.listScenarios().length, 11)

    // 模拟 volatile 热更新：宿主原地替换配置值，插件不重新装配。
    // 工具与自动决策在装配期捕获的是 liveScenarios() 的引用，必须仍然生效。
    config.customScenarios = JSON.stringify([
      { id: 'hot_scene', title: '热更新场景', questions: { risk: { type: 'noul', instructions: '有风险？' } } },
    ])

    const ids = service.listScenarios().map((s) => s.id)
    assert.equal(ids.length, 12, '保存后立即重建，无需重启')
    assert.ok(ids.includes('hot_scene'))

    // 已注册的工具定义看到的是同一个场景库引用（未被装配期快照冻结）
    const scenarioTool = registered.get('systemone_scenario')
    const listed = await scenarioTool.execute({ action: 'list' }, {})
    assert.ok(
      listed.scenarios.some((s) => s.id === 'hot_scene'),
      '工具持有的场景库引用也应看到新场景',
    )

    // 改回空值同样立即生效
    config.customScenarios = ''
    assert.equal(service.listScenarios().length, 11)

    assert.deepEqual(warnings, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('插件入口：活引用场景库对全部内部方法都刷新，且保持 Array 不变量', async () => {
  const root = buildHarness()
  try {
    const mod = await import(pathToFileURL(join(root, 'lib', 'index.js')).href)
    const { ctx } = fakeContext()
    const config = { ...CONFIG }
    const service = new mod.default(ctx, config)
    const live = service.liveScenarios()

    // 计数刷新次数：判断「某个操作有没有触发刷新」必须看调用次数，
    // 不能看返回值——刷新是全局状态，别的操作先刷过一次后，
    // 后面任何读取拿到的都是新数据，看数据会误判成「这个操作也刷新了」。
    const refreshes = { n: 0 }
    const realRefresh = service._refreshScenarios.bind(service)
    service._refreshScenarios = () => { refreshes.n++; return realRefresh() }

    // 每次操作都从「配置已变、场景库尚未刷新」的状态出发，
    // 这样刷新与否只取决于被考察的那一个操作。
    const bump = (id) => { config.customScenarios = JSON.stringify([
      { id, title: id, questions: { q: { type: 'noul', instructions: '?' } } },
    ]) }
    const refreshesOn = (fn) => { refreshes.n = 0; fn(); return refreshes.n > 0 }

    const trapOnly = {
      'Object.getPrototypeOf': () => Object.getPrototypeOf(live),
      'Object.isExtensible': () => Object.isExtensible(live),
    }
    const arrayReaders = {
      'for...of': () => { const out = []; for (const s of live) out.push(s); return out },
      'spread': () => [...live],
      'Object.keys': () => Object.keys(live),
      'Object.values': () => Object.values(live),
      'JSON.stringify': () => JSON.parse(JSON.stringify(live)),
      'concat': () => live.concat([]),
      'slice': () => live.slice(),
      'map': () => live.map((s) => s),
      'filter': () => live.filter(() => true),
      'flat': () => live.flat(),
      'find': () => live.find((s) => s.id === 'x'),
      'at': () => live.at(-1),
      'has (in)': () => (0 in live),
      'length': () => live.length,
    }

    let seq = 0
    // 自定义场景是「追加/覆盖」到内置 11 个之上，所以每次 bump 后总数是 12。
    const BUILTIN_COUNT = 11
    // ① 每个数组读取操作都必须触发刷新，并且读到最新数据
    for (const [name, read] of Object.entries(arrayReaders)) {
      const id = `iso_${seq++}`
      bump(id)
      assert.ok(refreshesOn(read), `${name} 应触发刷新`)
      assert.equal(live.length, BUILTIN_COUNT + 1, `${name} 之后应看到最新场景`)
      assert.ok(
        live.some((s) => s.id === id),
        `${name} 应读到最新数据`,
      )
    }

    // ② 只走 trap、不返回数组数据的两个操作，同样必须触发刷新。
    //    这正是旧实现漏掉的两条路径（白名单里没有它们）。
    for (const [name, read] of Object.entries(trapOnly)) {
      bump(`iso_${seq++}`)
      assert.ok(refreshesOn(read), `${name} 应触发刷新（旧的白名单实现会漏掉这里）`)
    }

    // ③ 刷新不得破坏数组语义
    assert.equal(Object.getPrototypeOf(live), Array.prototype, '必须是真正的 Array 原型')
    assert.equal(Object.isExtensible(live), true, '必须可扩展')
    assert.ok(live instanceof Array)
    assert.ok(Array.isArray(live))

    // ④ 写操作同样经统一转发，不得让代理与目标数组脱节
    config.customScenarios = ''
    assert.equal(live.length, 11)
    assert.equal(Object.getPrototypeOf(live), Array.prototype)

    // ⑤ 引用稳定 + 原地改写：工具捕获的引用不会被换掉
    assert.equal(service.liveScenarios(), live)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('插件入口：工具注册表不可用时显式失败（不再静默降级）', async () => {
  const root = buildHarness()
  try {
    const mod = await import(pathToFileURL(join(root, 'lib', 'index.js')).href)
    const ctx = { logger: { info: () => {}, warn: () => {} }, get: () => undefined }
    assert.throws(
      () => new mod.default(ctx, CONFIG),
      /工具注册表不可用/,
      '拿不到 tools 时必须抛错，而不是"激活成功但零工具"',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('插件入口：声明 inject=[tools]，由 Cordis 保证加载顺序', async () => {
const root = buildHarness()
try {
  const mod = await import(pathToFileURL(join(root, 'lib', 'index.js')).href)
  assert.deepEqual(mod.default.inject, ['tools'])
} finally {
  rmSync(root, { recursive: true, force: true })
}
})

test('提供商代理：全 trap 转发到当前实例，热切换立即可见', async () => {
const root = buildHarness()
try {
  const mod = await import(pathToFileURL(join(root, 'lib', 'index.js')).href)
  const { ctx } = fakeContext()
  const config = { ...CONFIG }
  const service = new mod.default(ctx, config)
  const provider = service.provider

  // 读操作经 trap 转发到当前实例（不再依赖 name/decide 白名单）
  assert.equal(provider.name, 'mock')
  assert.ok('decide' in provider, 'in 检查应经 has trap 命中')
  assert.equal(Object.getPrototypeOf(provider).constructor.name, 'MockProvider')
  assert.ok(
    provider.decide({ state: 'x', questions: { q: { type: 'noul', instructions: '?' } } }) instanceof Promise,
  )

  // 热切换 provider：代理自动指向新实例，无需重新装配
  config.provider = 'http'
  config.endpoint = 'http://example.com'
  assert.equal(provider.name, 'http')
  assert.equal(Object.getPrototypeOf(provider).constructor.name, 'HttpProvider')

  service.dispose()
} finally {
  rmSync(root, { recursive: true, force: true })
}
})

test('插件入口：开启自动决策时挂上 pre-step，卸载时摘掉', async () => {
  const root = buildHarness()
  try {
    const mod = await import(pathToFileURL(join(root, 'lib', 'index.js')).href)
    const { ctx, handlers } = fakeContext()
    const service = new mod.default(ctx, { ...CONFIG, autoDecide: true })

    assert.equal(handlers.get('agent/pre-step')?.length ?? 0, 1)

    service.dispose()
    assert.equal(handlers.get('agent/pre-step')?.length ?? 0, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
