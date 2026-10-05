/**
 * usage.test.mjs — 用量台账的行为测试。
 *
 * 台账的价值在于"可见 + 不被记账本身拖垮"，因此覆盖：
 * 累计正确性、缺字段容错、跨日归零、写盘失败降级、日限判定。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUsageLedger, usageLogPath } from '../lib/usage.js'

/** 建一个临时台账，跑 fn，然后清理。 */
async function withLedger(fn, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-systemone-usage-'))
  const path = join(dir, 'usage.jsonl')
  try {
    return await fn(createUsageLedger({ path, ...opts }), path, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** 读回 JSONL 每一行。 */
function readEntries(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
}

test('台账：累加调用数与 input_tokens，并写出一行 JSONL', async () => {
  await withLedger(async (ledger, path) => {
    ledger.record({ source: 'tool', ok: true, usage: { input_tokens: 1200 }, model: 'u2-decision', provider: 'unisound' })
    ledger.record({ source: 'auto-route', ok: true, usage: { input_tokens: 300 } })

    const today = ledger.today()
    assert.equal(today.calls, 2)
    assert.equal(today.tokens, 1500)
    assert.equal(today.failures, 0)

    const entries = readEntries(path)
    assert.equal(entries.length, 2, '每次调用一行')
    assert.equal(entries[0].source, 'tool')
    assert.equal(entries[0].input_tokens, 1200)
    assert.equal(entries[0].model, 'u2-decision')
    assert.equal(entries[1].source, 'auto-route')
    assert.ok(entries[0].day, '每行都带本地日键')
  })
})

test('台账：失败调用也计数（上游可能已计费）', async () => {
  await withLedger(async (ledger) => {
    ledger.record({ source: 'tool', ok: true, usage: { input_tokens: 100 } })
    ledger.record({ source: 'tool', ok: false, usage: { input_tokens: 0 } })
    const today = ledger.today()
    assert.equal(today.calls, 2)
    assert.equal(today.failures, 1)
  })
})

test('台账：usage 缺失或非法时不报错，token 记 0', async () => {
  await withLedger(async (ledger) => {
    ledger.record({ source: 'tool' })
    ledger.record({ source: 'tool', usage: {} })
    ledger.record({ source: 'tool', usage: { input_tokens: null } })
    ledger.record({ source: 'tool', usage: { input_tokens: 'abc' } })
    ledger.record({ source: 'tool', usage: { input_tokens: -5 } })
    const today = ledger.today()
    assert.equal(today.calls, 5)
    assert.equal(today.tokens, 0)
  })
})

test('台账：跨日自动归零（按本地日切分，不需要定时任务）', async () => {
  await withLedger(async (ledger) => {
    const day1 = new Date(2026, 9, 5, 23, 59, 0).getTime()
    const day2 = new Date(2026, 9, 6, 0, 1, 0).getTime()
    ledger.record({ source: 'tool', ok: true, usage: { input_tokens: 500 }, at: day1 })
    assert.equal(ledger.today(day1).tokens, 500)
    assert.equal(ledger.today(day1).calls, 1)

    ledger.record({ source: 'tool', ok: true, usage: { input_tokens: 700 }, at: day2 })
    const next = ledger.today(day2)
    assert.equal(next.calls, 1, '新的一天计数从 1 重新开始')
    assert.equal(next.tokens, 700, '新的一天 token 从 0 重新累计')
    assert.notEqual(ledger.today(day1).day, next.day)
  })
})

test('台账：写盘失败时降级为仅内存，不抛错且只告警一次', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-systemone-usage-'))
  const warnings = []
  try {
    // 用一个"父路径是文件"的非法路径，制造写入失败
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'not a directory')
    const ledger = createUsageLedger({
      path: join(blocker, 'nested', 'usage.jsonl'),
      logger: { warn: (m) => warnings.push(String(m)) },
    })

    assert.doesNotThrow(() => ledger.record({ source: 'tool', ok: true, usage: { input_tokens: 42 } }))
    assert.doesNotThrow(() => ledger.record({ source: 'tool', ok: true, usage: { input_tokens: 42 } }))
    assert.equal(ledger.today().calls, 2, '内存计数照常')
    assert.equal(ledger.today().tokens, 84)
    assert.equal(warnings.length, 1, '同一故障只告警一次，避免每步刷日志')
    assert.match(warnings[0], /台账写入失败/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('台账：日限在发请求前判定并给出可操作的拒绝原因', async () => {
  await withLedger(async (ledger) => {
    assert.equal(ledger.check({ dailyCallLimit: 3, dailyTokenLimit: 0 }).allowed, true)

    ledger.record({ source: 'tool', ok: true, usage: { input_tokens: 100 } })
    ledger.record({ source: 'tool', ok: true, usage: { input_tokens: 100 } })
    assert.equal(ledger.check({ dailyCallLimit: 3 }).allowed, true, '未达上限仍允许')

    ledger.record({ source: 'tool', ok: true, usage: { input_tokens: 100 } })
    const denied = ledger.check({ dailyCallLimit: 3 })
    assert.equal(denied.allowed, false)
    assert.match(denied.reason, /dailyCallLimit/, '拒绝原因要点名该改哪个配置')
    assert.match(denied.reason, /3/)

    // token 上限独立生效
    const tokenDenied = ledger.check({ dailyCallLimit: 0, dailyTokenLimit: 250 })
    assert.equal(tokenDenied.allowed, false)
    assert.match(tokenDenied.reason, /input token/)
    assert.match(tokenDenied.reason, /dailyTokenLimit/)

    // 0 = 不限
    assert.equal(ledger.check({ dailyCallLimit: 0, dailyTokenLimit: 0 }).allowed, true)
  })
})

test('台账：formatToday 给出一行可读摘要，并标注失败次数', async () => {
  await withLedger(async (ledger) => {
    ledger.record({ source: 'tool', ok: true, usage: { input_tokens: 2000 } })
    assert.match(ledger.formatToday(), /今日：1 次判断/)
    assert.match(ledger.formatToday(), /2\.0k input tokens/)

    ledger.record({ source: 'tool', ok: false })
    assert.match(ledger.formatToday(), /失败 1 次/)
  })
})

test('台账：usageLogPath 尊重 DSH_HOME，留空目录时回退到默认位置', () => {
  const saved = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = 'C:\\tmp\\dsh-home'
    assert.match(usageLogPath(''), /dsh-systemone[\\/]usage\.jsonl$/)
    // 显式目录优先于 DSH_HOME
    assert.equal(usageLogPath('D:\\custom\\dir'), join('D:\\custom\\dir', 'usage.jsonl'))
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
  }
})

test('台账：目录不存在时自动创建', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-systemone-usage-'))
  try {
    const nested = join(dir, 'a', 'b', 'usage.jsonl')
    const ledger = createUsageLedger({ path: nested })
    ledger.record({ source: 'tool', ok: true, usage: { input_tokens: 10 } })
    assert.equal(readEntries(nested).length, 1, '深层目录应被自动创建')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
