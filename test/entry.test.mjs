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

  // 桩：@deepseek-ai/schemastery（只需支持链式 default/min/max 与 object）
  const schemastery = join(root, 'node_modules', '@deepseek-ai', 'schemastery')
  mkdirSync(schemastery, { recursive: true })
  writeFileSync(join(schemastery, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/schemastery', version: '0.0.0-stub', type: 'module', main: 'index.js',
  }))
  writeFileSync(join(schemastery, 'index.js'), [
    'const chain = { default: () => chain, min: () => chain, max: () => chain }',
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

test('插件入口：注册 2 个工具并暴露 9 个场景', async () => {
  const root = buildHarness()
  try {
    const mod = await import(pathToFileURL(join(root, 'lib', 'index.js')).href)
    const { ctx, registered, warnings } = fakeContext()
    const service = new mod.default(ctx, CONFIG)

    assert.deepEqual([...registered.keys()].sort(), ['systemone_decide', 'systemone_scenario'])
    assert.equal(service.listScenarios().length, 9)
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
    assert.equal(ids.length, 10)
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

    assert.equal(service.listScenarios().length, 9)
    assert.equal(registered.size, 2)
    assert.equal(warnings.length, 1)
    assert.ok(warnings[0].includes('解析失败'))
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