/**
 * usage.js — 调用与 token 用量台账。
 *
 * 为什么需要它：SystemOne 调用是**按量计费**的，而本插件默认关闭不了的两条路径
 * （自动路由 + 场景决策）会随会话推进持续发请求。上游返回的 `usage.input_tokens`
 * 原本只是塞进工具返回值里，既不累计也不设上限——用户看不到花销，也就没有刹车。
 *
 * 设计取舍（对齐生态里同类做法，如 dsh-jev-plugin 的 ledger + 双日限）：
 *   - 每次调用**追加**一行 JSONL，包括失败/超时的调用（失败也可能已计费）；
 *   - 日限在**发请求之前**判定并拒绝，附上该改哪个配置项；
 *   - 台账不可写时降级为「仅内存」，绝不因为记账失败而让决策失败（fail-open 记账）；
 *   - 计数按**本地日**切分，跨日自动归零，不需要定时任务；
 *   - 进程启动时从文件尾部**恢复当日累计**：重启不是新的一天，重启后的「今日用量」
 *     与日限必须接着算（早期版本只累加内存，重启即归零）。
 *
 * 模块无第三方依赖，使用 node:fs / node:os / node:path。
 */
import { appendFileSync, closeSync, mkdirSync, openSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** token 数缺失时的兜底（上游不保证返回 usage）。 */
const UNKNOWN_TOKENS = 0

/**
 * 重启后恢复当日累计时最多回读的字节数。
 *
 * 台账是旁路设施，不能为了恢复它把一个长年累月只追加的大文件整个读进内存；
 * 2 MB 约等于上万次调用，足够覆盖"同一天内的重启"。
 */
const RESTORE_MAX_BYTES = 2 * 1024 * 1024

/** 本地日键，形如 2026-10-05。 */
function localDayKey(now = Date.now()) {
  const d = new Date(now)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 解析 DSH 主目录（尊重 DSH_HOME）；provider.js 的凭证读取与此同源。 */
export function dshHome() {
  const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return fromEnv || join(homedir(), '.dsh')
}

/**
 * 安全记账：台账是**旁路**设施，任何异常都不得影响决策或注入。
 *
 * 台账自身已经吞掉了写盘失败，但调用方可能传入别的实现（测试桩、将来的远端
 * 上报），所以这里再兜一层——「记账失败绝不影响决策」是写在文档里的承诺，
 * 不能只靠台账实现自觉。auto.js 与 tools.js 共用本函数。
 */
export function recordUsage(usage, entry) {
  try {
    usage?.record?.(entry)
  } catch {
    // 静默忽略
  }
}

/** 台账文件绝对路径。 */
export function usageLogPath(dir) {
  const base = typeof dir === 'string' && dir.trim() ? dir.trim() : join(dshHome(), 'dsh-systemone')
  return join(base, 'usage.jsonl')
}

/**
 * 从台账文件尾部恢复某个本地日的累计。
 *
 * 为什么需要：`totals` 是进程内状态，宿主一重启就归零——而用户看到的「今日用量」
 * 以及将来的日限判定都基于它。重启不是新的一天，账必须接着算。
 *
 * 三条容错：文件不存在 → 全 0；行是半截/坏 JSON → 跳过该行；读盘本身失败 → 全 0。
 * 台账坏了绝不能让插件起不来，也不能让决策失败。
 *
 * @param {string} file - 台账文件绝对路径
 * @param {string} day - 本地日键（与写入时的 `day` 同源）
 * @returns {{calls:number, tokens:number, failures:number}}
 */
function restoreDay(file, day) {
  const zero = { calls: 0, tokens: 0, failures: 0 }
  let text = ''
  let partialHead = false
  try {
    const stat = statSync(file, { throwIfNoEntry: false })
    if (!stat || stat.size === 0) return zero
    const start = Math.max(0, stat.size - RESTORE_MAX_BYTES)
    partialHead = start > 0
    const length = stat.size - start
    const buffer = Buffer.alloc(length)
    const fd = openSync(file, 'r')
    try {
      const read = readSync(fd, buffer, 0, length, start)
      text = buffer.subarray(0, read).toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return zero
  }

  const lines = text.split('\n')
  // 从文件中段开始读时，第一行几乎必然是被截断的半条记录
  if (partialHead) lines.shift()

  const totals = { ...zero }
  for (const line of lines) {
    if (!line.trim()) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue // 写到一半的坏行：忽略，不因它丢掉整天的账
    }
    if (!entry || entry.day !== day) continue
    totals.calls += 1
    const tokens = Number(entry.input_tokens)
    if (Number.isFinite(tokens) && tokens > 0) totals.tokens += Math.floor(tokens)
    if (entry.ok === false) totals.failures += 1
  }
  return totals
}

/** 从任意形态的 usage 字段里取 input_tokens（容忍缺字段与字符串）。 */
function inputTokensOf(usage) {
  const value = Number(usage?.input_tokens)
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : UNKNOWN_TOKENS
}

/**
 * 创建用量台账。
 *
 * @param {object} [options]
 * @param {string} [options.path] - 台账文件路径；留空则用 `$DSH_HOME/dsh-systemone/usage.jsonl`
 * @param {object} [options.logger] - 可选 logger，用于告警（写盘失败等）
 * @returns {{ record: Function, today: Function, check: Function, formatToday: Function }}
 */
export function createUsageLedger(options = {}) {
  const file = typeof options.path === 'string' && options.path.trim()
    ? options.path.trim()
    : usageLogPath('')
  const logger = options.logger

  /**
   * 内存累计：{ day, calls, tokens, failures } —— 读取时先按天校验再复用。
   * 构造时从文件尾部恢复当日累计，让「今日用量」与日限跨进程重启依然连续。
   */
  const initialDay = localDayKey()
  let totals = { day: initialDay, ...restoreDay(file, initialDay) }
  /** 写盘是否失败过（只告警一次，避免每一步刷日志） */
  let writeFailed = false

  function rollIfNeeded(now = Date.now()) {
    const day = localDayKey(now)
    if (totals.day !== day) {
      totals = { day, calls: 0, tokens: 0, failures: 0 }
    }
    return totals
  }

  /** 记录一次调用。永不抛错——记账失败不影响决策。 */
  function record(entry = {}) {
    const now = Number.isFinite(entry.at) ? entry.at : Date.now()
    const tokens = inputTokensOf(entry.usage)
    const ok = entry.ok !== false
    const current = rollIfNeeded(now)
    current.calls += 1
    current.tokens += tokens
    if (!ok) current.failures += 1

    try {
      mkdirSync(join(file, '..'), { recursive: true })
      appendFileSync(file, `${JSON.stringify({
        ts: now,
        day: current.day,
        source: String(entry.source || 'unknown'),
        model: entry.model ? String(entry.model) : '',
        provider: entry.provider ? String(entry.provider) : '',
        scenario: entry.scenario ? String(entry.scenario) : '',
        ok,
        input_tokens: tokens,
        latency_ms: Number.isFinite(Number(entry.latencyMs)) ? Number(entry.latencyMs) : null,
      })}\n`, 'utf8')
    } catch (error) {
      if (!writeFailed) {
        writeFailed = true
        try {
          logger?.warn?.(`@master0071/dsh-systemone[usage]: 台账写入失败，本次起降级为仅内存统计：${error?.message || error}`)
        } catch {
          // 日志失败不影响决策
        }
      }
    }
    return { calls: current.calls, tokens: current.tokens, failures: current.failures, day: current.day }
  }

  /** 今日累计（只读快照）。 */
  function today(now = Date.now()) {
    const current = rollIfNeeded(now)
    return { day: current.day, calls: current.calls, tokens: current.tokens, failures: current.failures }
  }

  /**
   * 发请求前的限额判定。
   * @param {{dailyCallLimit:number, dailyTokenLimit:number}} limits - 0 表示不限
   * @returns {{allowed:boolean, reason?:string, snapshot:object}}
   */
  function check(limits = {}) {
    const snapshot = today()
    const callLimit = Number(limits.dailyCallLimit)
    const tokenLimit = Number(limits.dailyTokenLimit)
    if (Number.isFinite(callLimit) && callLimit > 0 && snapshot.calls >= callLimit) {
      return {
        allowed: false,
        snapshot,
        reason: `今日调用数已达上限 ${callLimit}（当前 ${snapshot.calls}）。调大 dailyCallLimit，或设为 0 关闭上限。`,
      }
    }
    if (Number.isFinite(tokenLimit) && tokenLimit > 0 && snapshot.tokens >= tokenLimit) {
      return {
        allowed: false,
        snapshot,
        reason: `今日 input token 已达上限 ${tokenLimit}（当前 ${snapshot.tokens}）。调大 dailyTokenLimit，或设为 0 关闭上限。`,
      }
    }
    return { allowed: true, snapshot }
  }

  /** 一行人类可读的今日用量（供工具输出与日志）。 */
  function formatToday(now = Date.now()) {
    const s = today(now)
    const tokens = s.tokens >= 1000 ? `${(s.tokens / 1000).toFixed(1)}k` : String(s.tokens)
    const fail = s.failures > 0 ? `，其中失败 ${s.failures} 次` : ''
    return `今日：${s.calls} 次判断 · ${tokens} input tokens（${s.day}）${fail}`
  }

  return { record, today, check, formatToday, get path() { return file } }
}
