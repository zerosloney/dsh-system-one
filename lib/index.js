/**
 * @master0071/dsh-systemone 插件入口。
 *
 * 架构：Cordis 插件（Service 形态）。依赖 harness 的 `tools`（工具注册表）
 * 与 `logger`；浏览器侧配置页由 client.js 提供（经 dsh.client 注入）。
 *
 * - 注册 2 个 Agent 工具：
 *     systemone_scenario — 统一场景调度（list / describe / run）
 *     systemone_decide   — 自定义问题的低层入口
 * - 场景库内置 10 大业务域，并支持在配置里用 JSON 追加/覆盖场景
 * - 暴露 `ctx.systemone.decide()` 供其他插件编程调用
 * - 提供商可配置（unisound / http / mock），切换厂商不影响工具层
 */
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createProvider } from './provider.js'
import { createTools } from './tools.js'
import { resolveScenarios } from './scenarios.js'
import { installAutoDecide, AUTO_DEFAULTS } from './auto.js'
import { readBoolean, readString, unwrap } from './volatile.js'

/** 合法的提供商类型；其他值会按 unisound 处理并告警一次。 */
const KNOWN_PROVIDERS = ['unisound', 'http', 'mock']

/**
 * 把「当前提供商」包成一个稳定引用的对象，内部每次调用都转发到最新实例。
 *
 * 工具与自动决策在装配期就拿到了这个对象并长期持有；有了它，
 * 配置页里切换 `provider` 后它们无需重新装配即可用上新提供商。
 */
function createProviderProxy(current) {
  return {
    get name() {
      return current().name
    },
    decide(options) {
      return current().decide(options)
    },
  }
}

/**
 * 插件配置。所有字段均有默认值。
 *
 * 标了 `.volatile()` 的字段可以在「插件 → @master0071/dsh-systemone → systemone」配置页
 * 里直接修改并立即生效，无需重启；读取时必须经 `unwrap()` 脱壳（见 volatile.js）。
 * 唯一的非 volatile 字段是 `autoDecide`（结构性：决定装配期要不要挂 pre-step 钩子），
 * 它不在配置页里，改动需重启。
 */
const Config = z.object({
  /* ── 热更新字段（volatile）：配置页可直接编辑 ────────────────────────────── */

  /**
   * 自定义场景：JSON 数组字符串，同 id 覆盖内置场景。
   *
   * 这是「通用意图识别」的入口——把意图标签集写成 choice 的 criteria 即可。
   * volatile：配置页（client.js 的 CUSTOM_FIELDS）可直接编辑，场景库会随保存
   * 立即重建（见 liveScenarios），无需重启。
   */
  customScenarios: z.string().default('').volatile(),
  /** 提供商类型：unisound（官方）/ http（SystemOne 兼容端点）/ mock（本地模拟） */
  provider: z.string().default('unisound').volatile(),
  /** Unisound API Key（也可用环境变量 UNISOUND_API_KEY / SYSTEMONE_API_KEY） */
  apiKey: z.string().default('').role('secret').volatile(),
  /** Unisound API 基础地址（默认 https://maas-api.unisound.com/v1） */
  baseUrl: z.string().default('https://maas-api.unisound.com/v1').volatile(),
  /** provider=http 时的完整请求端点；留空则回退到 baseUrl */
  endpoint: z.string().default('').volatile(),
  /** 决策模型名 */
  model: z.string().default('u2-decision').volatile(),
  /** 请求超时（毫秒） */
  timeoutMs: z.number().min(1000).default(30000).volatile(),
  /** 置信度阈值：任一答案低于该值则建议人工复核 */
  minConfidence: z.number().min(0).max(1).default(0.6).volatile(),

  /* ── 结构性字段：不在配置页里，改动需要重启 ───────────────────────────────── */

  /** 是否在每一步推理前自动捕获上下文并执行决策（挂载 pre-step，改动需重启） */
  autoDecide: z.boolean().default(false),

  /* ── 自动决策运行参数（volatile）：钩子已挂载时实时生效 ────────────────────── */
  /** 自动决策固定使用的场景 id；留空则用一次 choice 问句自动路由 */
  autoScenario: z.string().default('').volatile(),
  /** 注入通道：message=本步生效（pre-step 注入）；context=官方动态上下文（晚一步生效） */
  autoInject: z.string().default('message').volatile(),
  /** 自动决策超时（毫秒），超时即放行，绝不阻塞会话 */
  autoTimeoutMs: z.number().min(500).default(AUTO_DEFAULTS.autoTimeoutMs).volatile(),
  /** 捕获的历史消息条数（不含本轮新消息） */
  autoMaxMessages: z.number().min(1).max(50).default(AUTO_DEFAULTS.autoMaxMessages).volatile(),
  /** 相同内容的结果缓存时长（毫秒），0 表示不缓存 */
  autoCacheTtlMs: z.number().min(0).default(AUTO_DEFAULTS.autoCacheTtlMs).volatile(),
  /** 自动决策使用的置信度阈值 */
  autoMinConfidence: z.number().min(0).max(1).default(AUTO_DEFAULTS.autoMinConfidence).volatile(),
  /** 自动路由的置信度门槛：低于该值宁可不注入，避免塞入瞎猜的结论 */
  autoRouteMinConfidence: z.number().min(0).max(1).default(AUTO_DEFAULTS.autoRouteMinConfidence).volatile(),
  /** 触发自动决策的最小输入长度（字符）；低于该长度且整体是寒暄才跳过 */
  autoMinChars: z.number().min(0).default(AUTO_DEFAULTS.autoMinChars).volatile(),
})

export default class SystemOneService extends Service {
  /**
   * 声明式依赖：Cordis 会等 `tools` 就绪后再启动本插件。
   *
   * 不能用构造期的 `ctx.get('tools')` 去赌加载顺序：tools 尚未提供时会静默
   * 拿到 undefined，插件"激活成功但一个工具都没注册"，且只有一条看不到的 warn。
   */
  static inject = ['tools']

  static Config = Config

  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx
   * @param {object} config - 经 Config schema 校验的插件配置（volatile 字段是引用对象，读取须经 volatile.js 脱壳）
   */
  constructor(ctx, config) {
    super(ctx, 'systemone')
    this.ctx = ctx
    this.config = config

    // provider 字段是 volatile：配置页里切换 unisound / http / mock 时，
    // 下面这个代理会按需重建真正的提供商，工具与自动决策无需改动即可跟随。
    this._warnedProviders = new Set()
    this._providerKind = null
    this._provider = null
    this.provider = createProviderProxy(() => this.currentProvider())
    this.currentProvider()

    // 场景库同样是热更新的：customScenarios 一变就原地重建，
    // 工具与自动决策持有的是同一个 liveScenarios 引用，因此无需重新装配。
    this._scenarioSource = null
    this._scenarioRawValue = undefined
    this.scenarioProblems = []
    this.scenarioWarnings = []
    this._scenarioArray = []
    this._refreshScenarios()
    const scenarios = this.liveScenarios()

    // inject 保证 ctx.tools 存在；注册失败必须显式抛出，绝不静默降级
    const tools = ctx.get('tools') ?? ctx.tools
    if (!tools || typeof tools.register !== 'function') {
      throw new Error('@master0071/dsh-systemone: 工具注册表不可用（inject: [\'tools\'] 未生效）')
    }
    this._disposers = createTools(this.provider, config, scenarios, {
      // 惰性读取：场景库可能已随 customScenarios 热更新重建，
      // 这里必须每次取最新的 warnings，而不是装配期快照。
      warnings: () => this.scenarioWarnings || [],
    }).map((tool) => tools.register(tool))

    // 自动决策：默认关闭；开启后在每一步推理前自动捕获上下文并注入判断
    this._autoDispose = () => {}
    if (readBoolean(config, 'autoDecide', false)) {
      try {
        this._autoDispose = installAutoDecide(ctx, {
          provider: this.provider,
          config,
          scenarios,
          logger: ctx.logger,
        })
      } catch (error) {
        ctx.logger?.warn?.(`@master0071/dsh-systemone: 自动决策安装失败，工具仍可用：${error?.message || error}`)
      }
    }

    ctx.logger?.info?.(
      `@master0071/dsh-systemone: 已注册 ${this._disposers.length} 个工具、${scenarios.length} 个场景`
      + `（provider=${this.provider.name}, model=${readString(config, 'model', 'u2-decision')}`
      + `, 自动决策=${readBoolean(config, 'autoDecide', false) ? `开(${readString(config, 'autoInject', 'message')})` : '关'}）`,
    )
  }

  /**
   * 返回当前应当使用的提供商；`provider` 配置变化时按需重建。
   *
   * volatile 字段热更新后 `config.provider` 会变，但已构建的提供商实例不会，
   * 所以这里做一次惰性比对——只有真的换了提供商类型才重建。
   */
  currentProvider() {
    const kind = readString(this.config, 'provider', 'unisound')
    if (kind !== this._providerKind) {
      this._warnUnknownProvider(kind)
      this._provider = createProvider(this.config)
      this._providerKind = kind
    }
    return this._provider
  }

  /** 未知 provider 值会在 provider.js 里静默回退到 unisound，这里负责告警（每个未知值只提示一次）。 */
  _warnUnknownProvider(kind) {
    if (KNOWN_PROVIDERS.includes(kind) || this._warnedProviders.has(kind)) return
    this._warnedProviders.add(kind)
    this.ctx?.logger?.warn?.(
      `@master0071/dsh-systemone: 未知 provider "${kind}"，将按 unisound 处理（可选：${KNOWN_PROVIDERS.join(' / ')}）`,
    )
  }

  /**
   * 场景库的「活引用」。
   *
   * 返回一个 Proxy：任何读取（`.map`、`.length`、`findScenario` 的遍历……）都会
   * 先按需重建，然后转发到真实数组。这样工具与自动决策在装配期捕获一次引用就够，
   * 之后 `customScenarios` 怎么改都能立刻看到新场景。
   */
  liveScenarios() {
    if (this._scenarioProxy === undefined) {
      this._scenarioProxy = new Proxy(this._scenarioArray, {
        get: (target, prop, receiver) => {
          this._refreshScenarios()
          return Reflect.get(target, prop, receiver)
        },
        has: (target, prop) => {
          this._refreshScenarios()
          return Reflect.has(target, prop)
        },
        ownKeys: (target) => {
          this._refreshScenarios()
          return Reflect.ownKeys(target)
        },
        getOwnPropertyDescriptor: (target, prop) => {
          this._refreshScenarios()
          return Reflect.getOwnPropertyDescriptor(target, prop)
        },
      })
    }
    return this._scenarioProxy
  }

  /**
   * 按需重建场景库：`customScenarios` 的原始字符串变了才重建。
   *
   * 原地改写 `this._scenarioArray`（清空 + 填充），而不是换一个新数组——
   * 因为工具与自动决策捕获的是那个数组本身。
   */
  _refreshScenarios() {
    // 先做引用比较快速返回：Proxy 的每次属性访问都会走到这里，
    // 字符串不可变，volatile 热更新换值时会换引用，引用相同即配置未变，
    // 避免对大段自定义场景 JSON 反复做全量 String() + trim + 比较。
    const value = unwrap(this.config?.customScenarios) ?? ''
    if (value === this._scenarioRawValue) return
    this._scenarioRawValue = value
    const source = String(value).trim()
    if (source === this._scenarioSource) return
    const { scenarios, problems, warnings } = resolveScenarios(source)
    this._scenarioArray.length = 0
    this._scenarioArray.push(...scenarios)
    this._scenarioSource = source
    this.scenarioProblems = problems
    this.scenarioWarnings = warnings
    // problems=致命（条目已被跳过），warnings=非致命提示（别名遮蔽等，场景仍可用）。
    // 两者都用 warn 输出，但文案前缀区分，便于一眼看出是否需要处理。
    for (const problem of problems) {
      this.ctx?.logger?.warn?.(`@master0071/dsh-systemone: ${problem}`)
    }
    for (const warning of warnings) {
      this.ctx?.logger?.warn?.(`@master0071/dsh-systemone（提示）: ${warning}`)
    }
  }

  /** 列出当前全部场景（内置 + 自定义）。 */
  listScenarios() {
    return this.liveScenarios().map((s) => ({
      id: s.id,
      title: s.title,
      source: s.source,
      questions: Object.keys(s.questions),
    }))
  }

  /**
   * 编程式调用决策模型。
   * @param {{ state: unknown, questions: object, model?: string, signal?: AbortSignal }} options
   * @returns {Promise<object>} SystemOne 响应
   */
  async decide(options) {
    return this.provider.decide(options)
  }

  /** 插件卸载时注销所有工具与自动决策挂钩。 */
  dispose() {
    try {
      this._autoDispose?.()
    } catch {
      // 卸载竞态
    }
    this._autoDispose = () => {}
    for (const dispose of this._disposers || []) {
      try {
        dispose()
      } catch {
        // 热卸载竞态：工具可能已被注销
      }
    }
    this._disposers = []
  }
}

// 供其他模块在 JS 侧引用
export { Config }
