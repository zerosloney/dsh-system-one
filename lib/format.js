/**
 * format.js — 决策结果的归一化、模板渲染与 Markdown 摘要。
 */

/** 生成整个工具的 Markdown 摘要。 */
export function formatSummary({
  title,
  provider,
  model,
  requestId,
  latencyMs,
  lines = [],
  recommendation,
  notes = [],
  needsHumanReview = false,
}) {
  const out = [
    `## ${title}`,
    `- **决策服务**：${provider} / ${model}`,
    ...lines,
  ]
  for (const note of notes) out.push(`- **注意**：${note}`)
  if (recommendation) out.push(`- **建议**：${recommendation}`)
  out.push(`- **建议复核**：${needsHumanReview ? '需要人工复核' : '无需人工复核'}`)
  if (requestId) out.push(`- **请求 ID**：${requestId}（延迟 ${latencyMs}ms）`)
  return out.join('\n')
}

/**
 * 把原始 answers 归一化为结构化结果。
 * @param {object} answers - SystemOne 原始答案
 * @param {object} questions - 场景问题定义（用于补 label / legend 缺失的情况）
 * @returns {{ decision: object, labels: object, confidences: object }}
 */
export function normalizeAnswers(answers, questions = {}) {
  const decision = {}
  const labels = {}
  const confidences = {}

  for (const [qid, question] of Object.entries(questions)) {
    const raw = answers?.[qid]
    const type = question?.type || raw?.type
    if (!raw || typeof raw !== 'object') continue

    if (type === 'choice') {
      const key = raw.choice ?? null
      decision[qid] = key
      labels[qid] = key != null ? (question?.criteria?.[key] ?? raw.choice ?? String(key)) : '无法判断'
      if (Number.isFinite(Number(raw.confidence))) confidences[qid] = Number(raw.confidence)
      continue
    }
    if (type === 'score') {
      const score = Number(raw.score)
      const idx = Number.isFinite(score) ? Math.round(score) : null
      decision[qid] = Number.isFinite(score) ? idx : null
      const legend = raw.legend || {}
      const scale = Array.isArray(question?.criteria) ? question.criteria : []
      labels[qid] = idx != null ? (legend[String(idx)] ?? scale[idx] ?? String(idx)) : '无法判断'
      if (Number.isFinite(Number(raw.confidence))) confidences[qid] = Number(raw.confidence)
      continue
    }
    if (type === 'noul') {
      const v = Number(raw.noul)
      const flag = Number.isFinite(v) ? v >= 0.5 : null
      decision[qid] = flag
      labels[qid] = flag === null ? '无法判断' : flag ? '是' : '否'
      if (Number.isFinite(v)) confidences[qid] = flag ? v : 1 - v
      continue
    }
  }
  return { decision, labels, confidences }
}

/** 计算派生字段（如 severity → priority）。 */
export function deriveFields(deriveSpec, decision) {
  const derived = {}
  for (const [name, spec] of Object.entries(deriveSpec || {})) {
    if (!spec || typeof spec !== 'object' || typeof spec.question !== 'string') continue
    const value = decision?.[spec.question]
    if (Array.isArray(spec.values)) {
      const idx = Number(value)
      if (!Number.isFinite(idx)) continue
      const clamped = Math.min(Math.max(Math.round(idx), 0), spec.values.length - 1)
      derived[name] = spec.values[clamped]
    } else if (spec.map && typeof spec.map === 'object') {
      if (value == null) continue
      derived[name] = spec.map[String(value)] ?? String(value)
    }
  }
  return derived
}

/**
 * 渲染建议模板。支持 {qid}、{qid.key}、{qid.confidence}、{derived}、{qid?A|B}。
 * 条件文案内的占位符会在第二遍替换；不支持嵌套条件。
 */
export function renderTemplate(template, { labels = {}, decision = {}, confidences = {}, derived = {} } = {}) {
  if (!template) return ''
  const ctx = { labels, decision, confidences, derived }
  let out = String(template)
  out = out.replace(/\{(\w+)\?([^{}]*)\|([^{}]*)\}/g, (_, name, thenText, elseText) => (
    truthy(name, ctx) ? thenText : elseText
  ))
  out = out.replace(/\{(\w+)(?:\.(\w+))?\}/g, (_, name, prop) => {
    if (prop === 'key') return stringify(decision[name])
    if (prop === 'confidence') {
      const c = confidences[name]
      return Number.isFinite(c) ? `${(c * 100).toFixed(1)}%` : ''
    }
    if (name in labels) return stringify(labels[name])
    if (name in derived) return stringify(derived[name])
    return stringify(decision[name])
  })
  return out.replace(/\s+/g, ' ').trim()
}

/** 把 answers 渲染为 Markdown 行（带问题显示名）。 */
export function formatAnswerLines(answers, questions = {}) {
  const lines = []
  for (const [qid, raw] of Object.entries(answers || {})) {
    if (!raw || typeof raw !== 'object') continue
    const label = questions?.[qid]?.label || qid
    if (raw.type === 'choice') lines.push(choiceLine(label, raw, questions?.[qid]))
    else if (raw.type === 'score') lines.push(scoreLine(label, raw, questions?.[qid]))
    else if (raw.type === 'noul') lines.push(noulLine(label, raw))
    else lines.push(`- **${label}**：${JSON.stringify(raw)}`)
  }
  return lines
}

export function choiceLine(label, answer, question) {
  const { choice, confidence, probabilities } = answer
  const text = choice != null ? (question?.criteria?.[choice] ?? choice) : '无法判断'
  const dist = topProbs(probabilities, 3)
  return `- **${label}**：${text}（置信度 ${fmtPct(confidence)}｜分布 ${dist}）`
}

export function scoreLine(label, answer, question) {
  const { score, confidence, legend, probabilities } = answer
  const idx = Number.isFinite(Number(score)) ? Math.round(Number(score)) : null
  const text = idx != null
    ? (legend?.[String(idx)] ?? (Array.isArray(question?.criteria) ? question.criteria[idx] : undefined) ?? String(idx))
    : '无法判断'
  const raw = Number.isFinite(Number(score)) ? ` ${Number(score).toFixed(2)}` : ''
  const dist = topProbs(probabilities, 3)
  return `- **${label}**：${text}${raw}（置信度 ${fmtPct(confidence)}｜分布 ${dist}）`
}

export function noulLine(label, answer) {
  const v = Number(answer.noul)
  if (!Number.isFinite(v)) return `- **${label}**：无法判断`
  return `- **${label}**：${v >= 0.5 ? '是' : '否'}（${(v * 100).toFixed(1)}%）`
}

/** noul 落在该区间视为「摇摆不定」（接近 0.5），建议人工复核。 */
const NOUL_UNCERTAIN_LOW = 0.45
const NOUL_UNCERTAIN_HIGH = 0.55

/** choice 返回这些取值时视为「无法判断」。 */
const UNCERTAIN_CHOICES = new Set(['uncertain', 'unknown'])

/** 是否需要人工复核：置信度低于阈值，或出现不确定项。 */
export function computeNeedsHumanReview(answers, minConfidence) {
  for (const a of Object.values(answers || {})) {
    if (!a || typeof a !== 'object') continue
    if (typeof a.confidence === 'number' && a.confidence < minConfidence) return true
    if (a.type === 'choice' && (a.choice == null || UNCERTAIN_CHOICES.has(a.choice))) return true
    if (a.type === 'noul' && typeof a.noul === 'number'
      && a.noul > NOUL_UNCERTAIN_LOW && a.noul < NOUL_UNCERTAIN_HIGH) return true
  }
  return false
}

/* ─── 内部工具 ─────────────────────────────────────────────────────────────── */

function truthy(name, { decision, derived }) {
  if (name in derived) {
    const v = derived[name]
    if (typeof v === 'boolean') return v
    if (typeof v === 'number') return v >= 1
    return !['', 'none', 'normal', 'no', 'false', '0'].includes(String(v).toLowerCase())
  }
  const value = decision[name]
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value >= 1
  if (typeof value === 'string') return !['', 'none', 'normal', 'no', 'false', '0'].includes(value.toLowerCase())
  return Boolean(value)
}

function stringify(value) {
  if (value === null || value === undefined) return ''
  return String(value)
}

function fmtPct(value) {
  const n = Number(value)
  return Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : '?'
}

function topProbs(probabilities, n = 3) {
  const entries = Object.entries(probabilities || {})
    .filter(([, p]) => Number.isFinite(Number(p)))
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, n)
  if (!entries.length) return '—'
  return entries.map(([k, p]) => `${k}=${(Number(p) * 100).toFixed(1)}%`).join(' ')
}