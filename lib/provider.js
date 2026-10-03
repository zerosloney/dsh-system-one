/**
 * provider.js — SystemOne 提供商抽象层。
 *
 * 所有业务工具只依赖统一的 `decide()` 接口，不感知具体厂商：
 *
 *   {
 *     name: string,
 *     async decide({ state, questions, model, signal }): Promise<SystemOneResponse>
 *   }
 *
 * 切换厂商 = 修改插件配置的 `provider` 字段，业务工具代码零改动。
 * 内置三种提供商：
 *   - "unisound"：官方 HTTP API（默认）
 *   - "http"    ：任意实现了相同 SystemOne 协议的 HTTP 端点（自建网关/其他厂商）
 *   - "mock"    ：本地确定性模拟（无需 API Key，用于测试与演示）
 */

import { readBoolean, readNumber, readString } from './volatile.js'

const DEFAULT_BASE_URL = 'https://maas-api.unisound.com/v1'
const DEFAULT_MODEL = 'u2-decision'
/** 临时故障（5xx/429/网络错误）自动重试次数与退避间隔；决策请求是幂等读，重发安全。 */
const RETRY_LIMIT = 1
const RETRY_DELAY_MS = 300

/** 创建提供商实例。config 来自插件配置（已由 Config schema 校验）。未知 provider 值回退到 unisound（入口层负责告警）。 */
export function createProvider(config) {
  const kind = readString(config, 'provider', 'unisound')
  if (kind === 'mock') return new MockProvider(config)
  if (kind === 'http') return new HttpProvider(config, 'http')
  return new UnisoundProvider(config)
}

/** 通用 HTTP 提供商：请求 SystemOne 兼容端点，Bearer 认证。 */
export class HttpProvider {
  /**
   * @param {object} config - 插件配置
   * @param {string} [name] - 提供商显示名
   */
  constructor(config, name = 'http') {
    this.config = config || {}
    this.name = name
  }

  /** 解析完整请求端点（每次调用都读最新配置，支持热更新）。 */
  resolveEndpoint() {
    const provider = readString(this.config, 'provider', 'unisound')
    const baseUrl = readString(this.config, 'baseUrl', DEFAULT_BASE_URL)
    const endpoint = readString(this.config, 'endpoint', '')
    if (provider === 'http') {
      const ep = String(endpoint || baseUrl || '').trim()
      if (!ep) {
        throw new Error('SystemOne: provider=http 需要配置 endpoint 或 baseUrl')
      }
      return assertValidUrl(ep)
    }
    const base = String(baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, '')
    return assertValidUrl(`${base}/systemone`)
  }

  /** 解析 API Key：配置优先，其次环境变量。 */
  resolveApiKey() {
    const key = readString(this.config, 'apiKey', '')
      || process.env.UNISOUND_API_KEY
      || process.env.SYSTEMONE_API_KEY
      || ''
    if (!key) {
      throw new Error(
        'SystemOne: 未配置 apiKey（请在插件配置中填写，或设置环境变量 UNISOUND_API_KEY / SYSTEMONE_API_KEY）',
      )
    }
    return key
  }

  /**
   * 调用决策接口。
   * @param {{ state: unknown, questions: object, model?: string, signal?: AbortSignal }} options
   * @returns {Promise<object>} SystemOne 响应对象（model/request_id/latency_ms/answers/usage）
   */
  async decide({ state, questions, model, signal }) {
    const endpoint = this.resolveEndpoint()
    const apiKey = this.resolveApiKey()
    const timeoutMs = readNumber(this.config, 'timeoutMs', 30000) || 30000
    const body = JSON.stringify({
      model: model || readString(this.config, 'model', DEFAULT_MODEL) || DEFAULT_MODEL,
      state: redactValue(state, readBoolean(this.config, 'redact', false)),
      questions,
    })

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error(`SystemOne: 请求超时（${timeoutMs}ms）`)), timeoutMs)
    timer.unref?.()
    const onOuterAbort = () => controller.abort()
    if (signal && typeof signal.addEventListener === 'function') {
      if (signal.aborted) {
        controller.abort()
      } else {
        signal.addEventListener('abort', onOuterAbort, { once: true })
      }
    }

    /** 单次请求：非 2xx 抛错并带上 status，供重试判定。 */
    const sendOnce = async () => {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body,
        signal: controller.signal,
      })
      const text = await res.text().catch(() => '')
      if (!res.ok) {
        const error = new Error(
          `SystemOne: HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''} — ${text.slice(0, 500) || '无响应体'}`,
        )
        error.status = res.status
        throw error
      }
      try {
        return JSON.parse(text)
      } catch {
        throw new Error(`SystemOne: 响应不是合法 JSON — ${text.slice(0, 300) || '空响应'}`)
      }
    }

    try {
      let lastError
      for (let attempt = 0; attempt <= RETRY_LIMIT; attempt += 1) {
        if (attempt > 0) {
          // 已中止（超时/外部取消）不再重试，让上一次的原始错误穿透
          if (controller.signal.aborted) throw lastError
          await sleep(RETRY_DELAY_MS)
        }
        try {
          return await sendOnce()
        } catch (error) {
          lastError = error
          if (attempt < RETRY_LIMIT && !controller.signal.aborted && isRetryable(error)) continue
          throw error
        }
      }
      throw lastError
    } finally {
      clearTimeout(timer)
      if (signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onOuterAbort)
      }
    }
  }
}

/** Unisound 官方提供商（默认）。 */
export class UnisoundProvider extends HttpProvider {
  constructor(config) {
    super({ ...config, provider: 'unisound' }, 'unisound')
  }
}

/** 本地确定性模拟提供商：无网络、无 Key，便于测试与演示。 */
export class MockProvider {
  /**
   * @param {object} config - 插件配置
   */
  constructor(config) {
    this.config = config || {}
    this.name = 'mock'
  }

  /**
   * 用输入内容 + 问题 ID 做种子，生成确定性的概率分布。
   * 响应结构与 Unisound 完全一致。
   */
  async decide({ state, questions, model, signal }) {
    void signal
    const seedSource = `${model || 'mock-decision'}|${typeof state === 'string' ? state : JSON.stringify(state)}`
    const answers = {}
    for (const [id, q] of Object.entries(questions || {})) {
      answers[id] = mockAnswer(id, q, seedSource)
    }
    return {
      model: model || 'mock-decision',
      request_id: `mock-${hashString(seedSource).toString(16)}`,
      latency_ms: 1,
      answers,
      usage: { input_tokens: 0 },
    }
  }
}

/* ─── 确定性模拟工具 ───────────────────────────────────────────────────────── */

function mockAnswer(id, q, seedSource) {
  if (!q || typeof q !== 'object') {
    return { type: 'unknown' }
  }
  const rand = mulberry32(hashString(`${seedSource}|${id}`))

  switch (q.type) {
    case 'choice': {
      const keys = Object.keys(q.criteria || {})
      if (!keys.length) {
        return { type: 'choice', choice: null, probabilities: {}, confidence: 0 }
      }
      const weights = keys.map(() => rand() + 0.1)
      const sum = weights.reduce((a, b) => a + b, 0)
      const probabilities = {}
      keys.forEach((k, i) => {
        probabilities[k] = weights[i] / sum
      })
      const top = keys.reduce((a, b) => (probabilities[a] >= probabilities[b] ? a : b))
      return {
        type: 'choice',
        choice: top,
        probabilities,
        confidence: probabilities[top],
      }
    }
    case 'noul': {
      // 与真实响应对齐：noul 也带 confidence（取倾向一侧的概率），
      // 否则 mock 下 computeNeedsHumanReview 走不到置信度分支
      const v = Math.round((rand() * 0.6 + 0.2) * 1000) / 1000
      return { type: 'noul', noul: v, confidence: Math.max(v, 1 - v) }
    }
    case 'score': {
      const list = Array.isArray(q.criteria) ? q.criteria : []
      const len = Math.max(list.length, 1)
      const weights = Array.from({ length: len }, () => rand() + 0.1)
      const sum = weights.reduce((a, b) => a + b, 0)
      const probabilities = {}
      let score = 0
      weights.forEach((w, i) => {
        probabilities[String(i)] = w / sum
        score += i * (w / sum)
      })
      const legend = {}
      list.forEach((label, i) => {
        legend[String(i)] = label
      })
      const topIdx = weights.indexOf(Math.max(...weights))
      return {
        type: 'score',
        legend,
        probabilities,
        score: Math.round(score * 1000) / 1000,
        confidence: probabilities[String(topIdx)],
      }
    }
    default:
      return { type: q.type || 'unknown' }
  }
}

function hashString(str) {
  let h = 2166136261 >>> 0
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/* ─── 敏感数据脱敏（redact=true 时，发送前对 state 生效） ──────────────────── */

/**
 * 内置脱敏规则：手机号/身份证/邮箱/银行卡号替换为类型标签。
 * 替换成标签（而不是抹成 ***）是有意的：决策模型仍能看出「这段内容
 * 包含手机号」——对 data_governance 这类场景，这个信号正是判断依据。
 * 顺序有意义：身份证（18 位）先于银行卡（13~19 位）匹配，
 * 环视断言保证不会在更长的数字串内部截取匹配。
 */
const REDACT_RULES = [
  { pattern: /(?<![\dXx])\d{17}[\dXx](?![\dXx])/g, tag: '[身份证]' },
  { pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, tag: '[邮箱]' },
  { pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/g, tag: '[手机号]' },
  { pattern: /(?<!\d)\d{13,19}(?!\d)/g, tag: '[银行卡号]' },
]

function redactString(text) {
  return REDACT_RULES.reduce((acc, rule) => acc.replace(rule.pattern, rule.tag), text)
}

/**
 * 递归脱敏 state：字符串叶子做规则替换，对象/数组逐层下钻。
 * 不修改原对象（调用方可能还要用），返回脱敏后的副本；非字符串叶子原样保留。
 */
function redactValue(value, enabled) {
  if (!enabled) return value
  if (typeof value === 'string') return redactString(value)
  if (Array.isArray(value)) return value.map((item) => redactValue(item, enabled))
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      out[key] = redactValue(item, enabled)
    }
    return out
  }
  return value
}

/* ─── 通用内部工具 ─────────────────────────────────────────────────────────── */

/** URL 合法性在发请求前拦下：漏写协议时 fetch 的报错非常隐晦，不如直接说清楚。 */
function assertValidUrl(url) {
  try {
    new URL(url)
  } catch {
    throw new Error(`SystemOne: 端点不是合法 URL：${url}（需以 http:// 或 https:// 开头）`)
  }
  return url
}

/** 仅临时故障值得重试：5xx、429 限流、网络层错误（fetch 失败抛 TypeError）。 */
function isRetryable(error) {
  if (error instanceof TypeError) return true
  return error?.status === 429 || (typeof error?.status === 'number' && error.status >= 500)
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}