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

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { readBoolean, readNumber, readString } from './volatile.js'

const DEFAULT_BASE_URL = 'https://maas-api.unisound.com/v1'
const DEFAULT_MODEL = 'u2-decision'
/** 隐式凭证回退（环境变量 / 默认引用名）只对这些主机生效；其余必须显式配置凭证。 */
const OFFICIAL_HOSTS = new Set(['maas-api.unisound.com'])
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
    if (provider === 'http') {
      // 这里必须读**显式**值：readString 的默认值参数会把空串当成缺失回落到
      // 官方 baseUrl，于是「provider=http 却没配地址」会静默把业务 state（可能含
      // PII）连同厂商密钥发去 unisound 生产端点。宁可报错，也不能猜一个端点。
      const explicitBase = readString(this.config, 'baseUrl', '')
      const endpoint = readString(this.config, 'endpoint', '')
      const ep = String(endpoint || explicitBase || '').trim()
      if (!ep) {
        throw new Error(
          'SystemOne: provider=http 必须显式配置 endpoint（或 baseUrl）；'
          + '留空不会回退到 unisound 官方端点（避免把业务数据发给非预期主机）。',
        )
      }
      return assertValidUrl(ep, this.config)
    }
    const baseUrl = readString(this.config, 'baseUrl', DEFAULT_BASE_URL)
    const base = String(baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, '')
    return assertValidUrl(`${base}/systemone`, this.config)
  }

  /**
   * 解析 API Key，顺序为：插件配置明文 → 环境变量 → DSH 凭证缝引用。
   *
   * 推荐用最后一种（`apiKeyRef`）：配置里只留一个引用名，密钥本体留在
   * `$DSH_HOME/.credentials.yaml`，避免明文落进 profile 的 `cordis.patch.yml`。
   *
   * **端点归属约束**：环境变量与「默认引用名」都是给官方端点准备的隐式回退。
   * 当请求发往第三方主机（provider=http 指向别的域）时，只允许**显式**配置的
   * `apiKey` 与**显式点名**的 `apiKeyRef`——否则用户切到自建网关的一次笔误，
   * 就会把 unisound 的生产密钥当成 Bearer 发给别人。
   *
   * 三种来源都没有时给出可操作的报错。
   */
  resolveApiKey() {
    const explicitKey = readString(this.config, 'apiKey', '')
    if (explicitKey) return explicitKey

    const apiKeyRef = readString(this.config, 'apiKeyRef', '')
    if (usesImplicitCredentialFallback(this)) {
      const implicit = process.env.UNISOUND_API_KEY
        || process.env.SYSTEMONE_API_KEY
        || readCredentialRef(apiKeyRef)
        || ''
      if (implicit) return implicit
    } else {
      // 非官方端点：只认显式点名的引用，不回退环境变量与默认名。
      const explicitRef = apiKeyRef ? readCredentialRef(apiKeyRef) : undefined
      if (explicitRef) return explicitRef
      throw new Error(
        `SystemOne: 端点 ${redactSecretText(this.resolveEndpoint())} 不是 unisound 官方地址，`
        + '因此不会使用环境变量 UNISOUND_API_KEY / SYSTEMONE_API_KEY，也不会回退默认引用名。'
        + '请显式设置 apiKey，或显式设置 apiKeyRef 指向你要用的那份凭证（例如 apiKeyRef: MY_GATEWAY_KEY）。',
      )
    }

    throw new Error(
      'SystemOne: 未配置凭证。按序尝试了：插件配置的 apiKey → 环境变量 UNISOUND_API_KEY / SYSTEMONE_API_KEY '
      + `→ 凭证缝 ${credentialsPath()} 的 refs.<apiKeyRef>`
      + `${apiKeyRef ? '' : '（apiKeyRef 留空，回退默认名 ' + DEFAULT_KEY_REFS.join(' / ') + '）'}。`
      + '推荐在凭证文件里这样写（`refs:` 独占一行，键值缩进）：\n'
      + '  refs:\n    SYSTEMONE_API_KEY: <你的 key>\n'
      + '并保持插件配置里的 apiKey 为空。',
    )
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
    const redact = readBoolean(this.config, 'redact', false)
    const body = JSON.stringify({
      model: model || readString(this.config, 'model', DEFAULT_MODEL) || DEFAULT_MODEL,
      state: redactValue(state, redact),
      // questions 里的 instructions 同样是自由文本（systemone_decide 的 params 也并进来），
      // 只脱敏 state 会让这条路径漏掉 PII。
      questions: redactQuestions(questions, redact),
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
        // 厂商常把请求头/请求体回显在错误体里；先抹掉密钥形态再拼进错误串，
        // 否则这段文本会随工具结果进入会话历史与模型上下文。
        const error = new Error(
          `SystemOne: HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''} — ${redactSecretText(text.slice(0, 500)) || '无响应体'}`,
        )
        error.status = res.status
        throw error
      }
      try {
        return JSON.parse(text)
      } catch {
        throw new Error(`SystemOne: 响应不是合法 JSON — ${redactSecretText(text.slice(0, 300)) || '空响应'}`)
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
      // 与真实响应对齐：noul 也带 confidence（取倾向一侧的概率）。
      // mock 的分布是合成的，**不代表真实模型行为**，只能用于契约与确定性回归。
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

/**
 * 递归脱敏 questions。
 *
 * 只处理**自由文本**（`instructions` / `label`），**不动 qid 与 criteria 的键**——
 * 键是决策结果回填到场景的索引，改了就映射不回去了。`systemone_decide` 的
 * `params.instructions` 覆盖会在发请求前合并进 questions，因此也一并覆盖。
 *
 * @param {object} questions - 问题定义（`{ [qid]: { type, instructions, ... } }`）
 * @param {boolean} enabled - 是否开启脱敏
 * @returns {object} 脱敏后的副本（未开启时原样返回）
 */
function redactQuestions(questions, enabled) {
  if (!enabled || !questions || typeof questions !== 'object' || Array.isArray(questions)) {
    return questions
  }
  const out = {}
  for (const [qid, question] of Object.entries(questions)) {
    if (!question || typeof question !== 'object' || Array.isArray(question)) {
      out[qid] = question
      continue
    }
    const next = { ...question }
    if (typeof next.instructions === 'string') next.instructions = redactString(next.instructions)
    if (typeof next.label === 'string') next.label = redactString(next.label)
    out[qid] = next
  }
  return out
}

/* ─── DSH 凭证缝读取 ───────────────────────────────────────────────────────── */

/** DSH 主目录：与用量台账同源（usage.js 导出）。 */
import { dshHome } from './usage.js'

/** 未配置 apiKeyRef 时依次尝试的内置引用名（覆盖 SystemOne 各家后端）。 */
const DEFAULT_KEY_REFS = ['SYSTEMONE_API_KEY', 'UNISOUND_API_KEY', 'TYPESAFE_API_KEY']

/** 凭证文件路径（用于报错文案与读取）。 */
function credentialsPath() {
  return join(dshHome(), '.credentials.yaml')
}

/**
 * 从凭证文件里取 `refs.<name>` 的值。
 *
 * 只解析 `refs:` 下的**单层标量**，不引入 YAML 依赖（插件对 `@deepseek-ai/*` 之外的
 * 依赖保持为零）。解析要点：
 *   - 只认 `refs:` 之后、缩进更深的行，避免误取段外同名键；
 *   - 值两端的成对引号会被剥掉（`TYPESAFE_API_KEY: "sk-x"` 应得到 `sk-x`）——
 *     这是同类实现常见的一个缺陷：直接把捕获组当值，会连引号一起塞进 Authorization 头；
 *   - 行内 ` #` 注释会被裁掉（仅对未加引号的值）；
 *   - 多个候选名都在文件里时，**按 `wanted` 的顺序**返回，而不是按文件出现顺序。
 *
 * @param {string} name - 引用名；留空时依次尝试 DEFAULT_KEY_REFS
 * @returns {string|undefined} 找到的凭证；找不到返回 undefined
 */
function readCredentialRef(name) {
  const wanted = name && String(name).trim() ? [String(name).trim()] : DEFAULT_KEY_REFS
  const refs = loadCredentialRefs()
  if (!refs) return undefined // 文件不存在/不可读 → 视为未配置
  // 按候选名给定的优先级取值（不是文件顺序）
  for (const key of wanted) {
    const hit = refs.get(key)
    if (hit) return hit
  }
  return undefined
}

/**
 * 凭证文件解析缓存：`{ path, mtimeMs, size, refs }`。
 *
 * 每次上游请求都会走一遍 `resolveApiKey()`，而原先每次都同步读整份
 * `.credentials.yaml` 再重新解析——把磁盘 IO 放进请求路径没有必要。
 * 用 stat 的 mtime+size 做失效判断：轮换密钥后文件必然变化，缓存自动失效；
 * 路径变了（测试里换 DSH_HOME）也会重新解析。
 */
let credentialCache = null

/** 读取并（必要时）重新解析凭证文件；文件不存在时返回 null。 */
function loadCredentialRefs() {
  const path = credentialsPath()
  let stat
  try {
    stat = statSync(path)
  } catch {
    credentialCache = null // 文件被删了：别让缓存继续生效
    return null
  }
  if (credentialCache
    && credentialCache.path === path
    && credentialCache.mtimeMs === stat.mtimeMs
    && credentialCache.size === stat.size) {
    return credentialCache.refs
  }
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    credentialCache = null
    return null
  }
  const refs = parseCredentialRefs(raw)
  credentialCache = { path, mtimeMs: stat.mtimeMs, size: stat.size, refs }
  return refs
}

/**
 * 解析 `refs:` 段内的单层标量。
 *
 * @param {string} raw - 凭证文件原文
 * @returns {Map<string,string>} 引用名 → 值
 */
function parseCredentialRefs(raw) {
  const refs = new Map()
  let inRefs = false
  let refsIndent = -1
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    if (!inRefs) {
      if (/^refs\s*:\s*$/.test(line.trim())) {
        inRefs = true
        refsIndent = indent
      }
      continue
    }
    // 缩进不深于 refs: 即说明已离开该段
    if (indent <= refsIndent) break
    const match = /^\s*([^\s:#][^:]*?)\s*:\s*(.*)$/.exec(line)
    if (!match) continue
    const value = unquoteScalar(match[2]) ?? ''
    if (value) refs.set(match[1].trim(), value)
  }
  return refs
}

/** 剥掉标量两端成对的引号并裁掉未加引号值后的行内注释。 */
function unquoteScalar(raw) {
  const trimmed = String(raw ?? '').trim()
  if (trimmed === '') return ''
  const first = trimmed[0]
  if (first === '"' || first === "'") {
    // 引号值：取到配对的收尾引号为止，引号内的 # 不算注释
    const end = trimmed.indexOf(first, 1)
    return end === -1 ? trimmed.slice(1) : trimmed.slice(1, end)
  }
  const hash = trimmed.indexOf(' #')
  return hash === -1 ? trimmed : trimmed.slice(0, hash).trim()
}

/* ─── 脱敏规则清单（供外发声明复用，避免文案与实现漂移）────────────────────── */

/** 规则的中文类型标签，按 REDACT_RULES 的顺序。 */
const REDACT_TAGS = REDACT_RULES.map((rule) => rule.tag.replace(/^\[|\]$/g, ''))

/** 脱敏规则的中文清单，形如 `手机号/身份证/邮箱/银行卡号`。 */
export function redactRuleSummary() {
  return REDACT_TAGS.join('/')
}

/* ─── 通用内部工具 ─────────────────────────────────────────────────────────── */

/** 本机回环地址：http 只在这里被放行（凭据不出网卡）。 */
function isLoopbackHost(hostname) {
  const host = String(hostname || '').toLowerCase()
  return host === 'localhost' || host === '::1' || host === '[::1]' || /^127\./.test(host)
}

/**
 * 该请求目标是否属于「官方端点」——只有它才配享用隐式凭证回退。
 *
 * 判据是**解析出来的主机**而不是配置里的 provider 名：provider=http 也可以
 * 指向官方域（自建代理场景），provider=unisound 也可以被 baseUrl 改到别处。
 * 以实际要发请求的主机为准，才不会出现「provider 名对了、数据却发去别处」。
 *
 * 回环地址视为可信（本地联调/自建网关），与 assertValidUrl 的放行口径一致。
 *
 * @param {object} provider - HttpProvider 实例（有 resolveEndpoint / config）
 * @returns {boolean} true 表示可以使用环境变量与默认引用名做隐式回退
 */
function usesImplicitCredentialFallback(provider) {
  try {
    const { hostname } = new URL(provider.resolveEndpoint())
    if (isLoopbackHost(hostname)) return true
    return OFFICIAL_HOSTS.has(String(hostname).toLowerCase())
  } catch {
    // 端点本身不合法时，resolveApiKey 不是该报错的地方（resolveEndpoint 会先抛）。
    // 这里保守返回 false：宁可要求显式凭证，也不做隐式回退。
    return false
  }
}

/**
 * 把错误文本里可能夹带的密钥抹掉，再交给工具结果。
 *
 * 为什么必须做：工具的 error/summary 会进会话历史、模型上下文与日志。
 * 上游把请求回显在错误体里（很常见）、或 URL 里带了 userinfo 时，原始错误串
 * 会把 `sk-…` 原样带进模型上下文——这不是"日志泄漏"，是**模型可见的泄漏**。
 *
 * 只做定向抹除，不做通用遮蔽：误伤正常文案（把 status/data 之类抹掉）比漏抹更难查。
 *
 * @param {string} text - 原始错误文本
 * @returns {string} 抹掉 URL userinfo 与 Bearer/`sk-` 形态密钥后的文本
 */
export function redactSecretText(text) {
  let out = String(text ?? '')
  // 1) URL 里的 userinfo：scheme://user:pass@host → scheme://***@host
  out = out.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/gi, '$1***@')
  // 2) Authorization 头回显：Bearer xxx → Bearer ***
  out = out.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]{8,}/gi, '$1***')
  // 3) 常见密钥前缀（unisound/deepseek/openai 风格）
  out = out.replace(/\b(sk-)[A-Za-z0-9_-]{8,}/g, '$1***')
  return out
}

/**
 * 发请求前的端点体检。
 *
 * 除了"是不是合法 URL"，还要挡住**明文传输凭据**：本插件所有请求都带
 * `Authorization: Bearer <key>`，走 http 等于把密钥明文发到网络上。因此默认
 * 只允许 https；http 仅对本机回环放行（本地联调 / mock 网关），其他明文端点
 * 必须显式配置 `allowInsecureHttp: true`（给内网自建网关留的逃生口）。
 *
 * 另外拒绝 URL 内嵌 userinfo（`https://user:pass@host`）：密钥该走 apiKey/
 * apiKeyRef，写进 URL 只会出现在报错、日志与代理记录里。
 *
 * @param {string} url - 已解析出的完整端点
 * @param {object} [config] - 插件配置（读取 allowInsecureHttp）
 */
function assertValidUrl(url, config) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`SystemOne: 端点不是合法 URL：${redactSecretText(url)}（需以 http:// 或 https:// 开头）`)
  }
  if (parsed.username || parsed.password) {
    throw new Error(
      `SystemOne: 端点里不能内嵌账号/密码（${redactSecretText(url)}）。`
      + '请把密钥放到 apiKey / apiKeyRef / 环境变量，URL 里只保留主机与路径。',
    )
  }
  if (parsed.protocol === 'https:') return url
  if (parsed.protocol !== 'http:') {
    throw new Error(`SystemOne: 不支持的端点协议 ${parsed.protocol}：${redactSecretText(url)}（只支持 http/https）`)
  }
  if (isLoopbackHost(parsed.hostname)) return url
  if (readBoolean(config, 'allowInsecureHttp', false)) return url
  throw new Error(
    `SystemOne: 拒绝向非 https 端点发送请求：${redactSecretText(url)}`
    + '（Authorization 里的 API Key 会明文过网）。'
    + '本机联调请用 http://127.0.0.1 或 http://localhost；'
    + '确需连接明文内网网关时，请在配置里显式设置 allowInsecureHttp: true。',
  )
}

/** 仅临时故障值得重试：5xx、429 限流、网络层错误（fetch 失败抛 TypeError）。 */
function isRetryable(error) {
  if (error instanceof TypeError) return true
  return error?.status === 429 || (typeof error?.status === 'number' && error.status >= 500)
}

function sleep(ms) {
  // ref 定时器（不能 unref）：重试退避期间调用方正在 await decide()，
  // 这个承诺必须落定。unref 会让无其他句柄的进程（如测试 runner）事件循环
  // 提前抽干、承诺悬空，也可能在宿主退出时静默吞掉一次重试。
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}