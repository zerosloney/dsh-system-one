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