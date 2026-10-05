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
  reviewReasons = [],
}) {
  const out = [
    `## ${title}`,
    `- **决策服务**：${provider} / ${model}`,
    ...lines,
  ]
  for (const note of notes) out.push(`- **注意**：${note}`)
  if (recommendation) out.push(`- **建议**：${recommendation}`)
  out.push(`- **建议复核**：${needsHumanReview ? '需要人工复核' : '无需人工复核'}`)
  // 只给结论不给理由，调用方无法判断该不该信；把判据一并写出来。
  for (const reason of reviewReasons) out.push(`  - ${reason}`)
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

/**
 * 概率分布的"平坦度"兜底阈值：`最大概率 / (1/选项数)` 低于该值即视为模型在猜。
 *
 * 为什么用比值而不是绝对概率：**不同后端算 confidence 的公式不同**（TypeSafe 与
 * Laya 就不一样），文献里的实测也表明这类概率**未标定**——把 0.6 这种绝对阈值
 * 套在所有后端上，等于把"某个后端的经验值"当成通用标准。而"最大概率有没有明显
 * 高出均匀分布"是**不依赖标定**的性质：0.5 除以 1/3 = 1.5 倍，说明只是略偏。
 *
 * 1.5 的取法：二选一题里对应 p≈0.75（比掷硬币强，但不足以据此自动执行）；
 * 三选一题里对应 p≈0.5。要更宽松/更严格可调本常量。
 */
const FLATNESS_RATIO = 1.5

/**
 * 概率分布的平坦度比值：最大概率相对均匀分布的倍数。
 * 选项少于 2 个或除基为 0 时返回 null。choice 与 score 共用
 * （同是 probabilities 分布，复核判据也相同）。
 */
function flatnessRatio(probs) {
  const keys = probs && typeof probs === 'object' ? Object.keys(probs) : []
  if (keys.length < 2) return null
  const max = Math.max(...keys.map((k) => Number(probs[k]) || 0))
  const uniform = 1 / keys.length
  return uniform > 0 ? max / uniform : null
}

/**
 * 单题的可信度评估。
 * @param {object} answer - 原始 answer（choice/noul/score）
 * @returns {{ reason: string|null, ratio: number|null }} 不可信时给出原因与平坦度比值
 */
function assessAnswer(answer) {
  if (!answer || typeof answer !== 'object') return { reason: null, ratio: null }

  if (answer.type === 'choice') {
    if (answer.choice == null) return { reason: 'choice 未给出选项', ratio: null }
    if (UNCERTAIN_CHOICES.has(answer.choice)) return { reason: `choice 返回「${answer.choice}」`, ratio: null }
    const ratio = flatnessRatio(answer.probabilities)
    if (ratio !== null && ratio < FLATNESS_RATIO) {
      return { reason: `choice 的分布接近均匀（最大概率仅均匀分布的 ${ratio.toFixed(2)} 倍）`, ratio }
    }
    return { reason: null, ratio: null }
  }

  if (answer.type === 'noul') {
    const v = Number(answer.noul)
    if (!Number.isFinite(v)) return { reason: 'noul 未给出数值', ratio: null }
    if (v > NOUL_UNCERTAIN_LOW && v < NOUL_UNCERTAIN_HIGH) {
      return { reason: `noul=${v.toFixed(3)} 落在 ${NOUL_UNCERTAIN_LOW}~${NOUL_UNCERTAIN_HIGH} 的摇摆区间`, ratio: null }
    }
    return { reason: null, ratio: null }
  }

  if (answer.type === 'score') {
    const ratio = flatnessRatio(answer.probabilities)
    if (ratio !== null && ratio < FLATNESS_RATIO) {
      return { reason: `score 的分布接近均匀（最大概率仅均匀分布的 ${ratio.toFixed(2)} 倍）`, ratio }
    }
    if (!Number.isFinite(Number(answer.score))) return { reason: 'score 未给出分值', ratio: null }
    return { reason: null, ratio: null }
  }

  return { reason: null, ratio: null }
}

/**
 * 复核评估：判定是否需要人工复核，并给出**理由**。
 *
 * 判据分两类，区别很重要：
 *   - **分布平坦**（`assessAnswer`）：概率没有明显高出均匀分布 → 模型在猜。
 *     这是不依赖标定的信号，是主要判据。
 *   - **绝对置信度低于 `minConfidence`**：保留为次要信号以兼容既有配置，
 *     但它在跨后端时意义有限（各家 confidence 公式不同，且实测未标定）。
 *
 * @param {object} answers - 原始 answers
 * @param {number} [minConfidence] - 绝对置信度阈值；不传则只按平坦度判定
 * @returns {{ needed: boolean, reasons: string[] }}
 */
export function reviewAssessment(answers, minConfidence) {
  const reasons = []
  const threshold = Number(minConfidence)
  for (const [qid, answer] of Object.entries(answers || {})) {
    const { reason } = assessAnswer(answer)
    if (reason) reasons.push(`${qid}：${reason}`)
    if (Number.isFinite(threshold)
      && typeof answer?.confidence === 'number'
      && answer.confidence < threshold) {
      reasons.push(`${qid}：置信度 ${(answer.confidence * 100).toFixed(1)}% 低于阈值 ${(threshold * 100).toFixed(0)}%`)
    }
  }
  return { needed: reasons.length > 0, reasons }
}

/**
 * 是否需要人工复核。
 *
 * 语义已从"只看绝对置信度阈值"改为"**看概率分布是否平坦**（分布接近均匀说明模型
 * 在猜），并保留 `minConfidence` 作为次要信号"。理由见 reviewAssessment。
 *
 * @deprecated 直接用 `reviewAssessment()`——它额外给出**判定理由**，调用方不必
 *   只拿到一个布尔值就无从判断该不该信。本函数保留为布尔快捷方式。
 */
export function computeNeedsHumanReview(answers, minConfidence) {
  return reviewAssessment(answers, minConfidence).needed
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