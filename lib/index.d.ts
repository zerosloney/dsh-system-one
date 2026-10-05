/**
 * @master0071/dsh-systemone 插件类型声明（手写，与 lib/index.js 对应）。
 */
import { Context, Service } from '@deepseek-ai/cordis'

/** 插件配置。所有字段均有默认值。 */
export interface Config {
  /** 提供商类型：unisound（官方）/ http（SystemOne 兼容端点）/ mock（本地模拟） */
  provider?: string
  /**
   * 凭证引用名（推荐）：从 `$DSH_HOME/.credentials.yaml` 的 `refs.<名字>` 读密钥，
   * 配置文件里只留这个名字。留空时依次尝试 SYSTEMONE_API_KEY / UNISOUND_API_KEY / TYPESAFE_API_KEY。
   */
  apiKeyRef?: string
  /** 明文 API Key（备用；也可用环境变量 UNISOUND_API_KEY / SYSTEMONE_API_KEY） */
  apiKey?: string
  /** Unisound API 基础地址 */
  baseUrl?: string
  /** provider=http 时的完整请求端点 */
  endpoint?: string
  /** 决策模型名 */
  model?: string
  /** 请求超时（毫秒） */
  timeoutMs?: number
  /**
   * **次要**复核信号：置信度低于该值时也标记需复核。
   * 主要判据是概率分布平坦度（见 `reviewAssessment` 语义），因为这类概率未标定、跨后端不可比。
   */
  minConfidence?: number
  /** 发送前对 state 做内置脱敏（手机号/身份证/邮箱/银行卡号替换为类型标签） */
  redact?: boolean
  /** 自定义场景：JSON 数组字符串 */
  customScenarios?: string
  /** 用量台账文件路径；留空则用 `$DSH_HOME/dsh-systemone/usage.jsonl` */
  usageLogPath?: string

  /* ── 自动决策（默认关闭） ─────────────────────────────── */
  /** 是否在每一步推理前自动捕获上下文并执行决策 */
  autoDecide?: boolean
  /** 自动决策固定使用的场景 id；留空则自动路由 */
  autoScenario?: string
  /** 注入通道：message=同一步生效并去重；context=宿主动态上下文（不写历史） */
  autoInject?: string
  /** 自动决策失败语义：open=放行（默认）；closed=决策失败时否决本轮（供将来做闸门用，仅 message 通道） */
  autoFailMode?: string
  /** 自动决策超时（毫秒） */
  autoTimeoutMs?: number
  /** 捕获的历史消息条数 */
  autoMaxMessages?: number
  /** 相同内容的结果缓存时长（毫秒），0 表示不缓存 */
  autoCacheTtlMs?: number
  /** 自动决策使用的置信度阈值 */
  autoMinConfidence?: number
  /** 自动路由的置信度门槛 */
  autoRouteMinConfidence?: number
  /** 触发自动决策的最小输入长度（字符） */
  autoMinChars?: number
}

/** 运行时导出的配置 schema（schemastery 对象），与上面的接口同名。 */
export const Config: any

/** 编程式调用 SystemOne 的参数。 */
export interface DecideOptions {
  state: unknown
  questions: Record<string, unknown>
  model?: string
  signal?: AbortSignal
}

/** 场景摘要。 */
export interface ScenarioInfo {
  id: string
  title: string
  source: 'builtin' | 'custom'
  questions: string[]
}

/**
 * 工具决策结果里与复核相关的字段。
 *
 * `computeNeedsHumanReview` 的语义自本版本起改为「**概率分布是否平坦**」
 * （最大概率相对均匀分布不足 1.5 倍即视为在猜，不依赖标定），
 * 绝对置信度 `minConfidence` 降为次要信号。
 */
export interface ReviewOutcome {
  /**
   * 是否需要人工复核。判据为分布平坦（主要）或低于 `minConfidence`（次要），
   * 以及 `choice` 返回 uncertain/空值、`noul` 落在 0.45~0.55 摇摆区间。
   */
  needs_human_review: boolean
  /** 判定理由（每条形如 `qid：原因`）；为空表示无需复核。仅工具输出提供。 */
  review_reasons?: string[]
}

/** 工具返回的决策结果（`systemone_scenario(action:"run")` 与 `systemone_decide`）。 */
export interface DecisionResult extends ReviewOutcome {
  ok: boolean
  scenario: string | null
  provider: string
  model?: string
  request_id?: string
  latency_ms?: number
  answers?: Record<string, unknown>
  decision?: Record<string, unknown>
  labels?: Record<string, unknown>
  derived?: Record<string, unknown>
  confidences?: Record<string, number>
  recommendation?: string
  warnings?: string[]
  /** 人可读的 Markdown 摘要（含复核理由子项）。 */
  summary: string
  /** 失败时的人类可读原因。 */
  error?: string
  /** 未知场景时列出的可用场景 id。 */
  available?: string[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** SystemOne 决策服务。 */
    systemone: SystemOneService
  }
}

export default class SystemOneService extends Service {
  static Config: any
  readonly config: Config
  readonly provider: {
    name: string
    decide(options: DecideOptions): Promise<Record<string, unknown>>
  }

  constructor(ctx: Context, config: Config)

  /** 列出当前全部场景（内置 + 自定义）。 */
  listScenarios(): ScenarioInfo[]

  /** 编程式调用决策模型。 */
  decide(options: DecideOptions): Promise<Record<string, unknown>>
}