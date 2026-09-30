/**
 * dsh-systemone 插件类型声明（手写，与 lib/index.js 对应）。
 */
import { Context, Service } from '@deepseek-ai/cordis'

/** 插件配置。所有字段均有默认值。 */
export interface Config {
  /** 提供商类型：unisound（官方）/ http（SystemOne 兼容端点）/ mock（本地模拟） */
  provider?: string
  /** Unisound API Key（也可用环境变量 UNISOUND_API_KEY / SYSTEMONE_API_KEY） */
  apiKey?: string
  /** Unisound API 基础地址 */
  baseUrl?: string
  /** provider=http 时的完整请求端点 */
  endpoint?: string
  /** 决策模型名 */
  model?: string
  /** 请求超时（毫秒） */
  timeoutMs?: number
  /** 置信度阈值 */
  minConfidence?: number
  /** 自定义场景：JSON 数组字符串 */
  customScenarios?: string

  /* ── 自动决策（默认关闭） ─────────────────────────────── */
  /** 是否在每一步推理前自动捕获上下文并执行决策 */
  autoDecide?: boolean
  /** 自动决策固定使用的场景 id；留空则自动路由 */
  autoScenario?: string
  /** 注入通道：message=同一步生效并去重；context=宿主动态上下文（不写历史） */
  autoInject?: string
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