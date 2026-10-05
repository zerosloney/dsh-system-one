/**
 * @master0071/dsh-systemone 插件入口。
 *
 * 架构：Cordis 插件（Service 形态）。依赖 harness 的 `tools`（工具注册表）
 * 与 `logger`；浏览器侧配置页由 client.js 提供（经 dsh.client 注入）。
 *
 * - 注册 2 个 Agent 工具：
 *     systemone_scenario — 统一场景调度（list / describe / run）
 *     systemone_decide   — 自定义问题的低层入口
 * - 场景库内置 11 大业务域，并支持在配置里用 JSON 追加/覆盖/patch 场景
 * - 暴露 `ctx.systemone.decide()` 供其他插件编程调用
 * - 提供商可配置（unisound / http / mock），切换厂商不影响工具层
 */
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createProvider, redactRuleSummary } from './provider.js'
import { createTools } from './tools.js'
import { resolveScenarios } from './scenarios.js'
import { installAutoDecide, AUTO_DEFAULTS } from './auto.js'
import { createUsageLedger } from './usage.js'
import { readBoolean, readNumber, readString, unwrap } from './volatile.js'

/** 合法的提供商类型；其他值会按 unisound 处理并告警一次。 */
const KNOWN_PROVIDERS = ['unisound', 'http', 'mock']

/**
 * 把「当前提供商」包成一个稳定引用的对象，内部每次调用都转发到最新实例。
 *
 * 工具与自动决策在装配期就拿到了这个对象并长期持有；有了它，
 * 配置页里切换 `provider` 后它们无需重新装配即可用上新提供商。
 *
 * 与 liveScenarios 同一原则：**不做 trap 白名单**，统一转发全部
 * （对象目标上合法的）内部方法——白名单的毛病是「漏一个就静默拿不到
 * 新实例的成员」。provider 将来新增 health()/close() 之类接口时，
 * 走代理的调用方自动可见，不需要回来改这里。
 * 注意 apply/construct 两个 trap 只对函数目标合法，provider 是普通对象，不适用。
 */
function createProviderProxy(current) {
  // trap 的第一个参数是创建时固定的代理目标（占位空对象），必须丢弃、
  // 换成「当前提供商实例」——转发全部 trap 参数会把占位对象错当成属性名
  const forward = (name) => (_target, ...args) => Reflect[name](current(), ...args)
  return new Proxy({}, {
    get: forward('get'),
    set: forward('set'),
    has: forward('has'),
    deleteProperty: forward('deleteProperty'),
    ownKeys: forward('ownKeys'),
    getOwnPropertyDescriptor: forward('getOwnPropertyDescriptor'),
    defineProperty: forward('defineProperty'),
    getPrototypeOf: forward('getPrototypeOf'),
    setPrototypeOf: forward('setPrototypeOf'),
    isExtensible: forward('isExtensible'),
  })
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
  /**
   * 凭证引用名：从 DSH 凭证缝 `$DSH_HOME/.credentials.yaml` 的 `refs.<名字>` 读取密钥。
   *
   * 这是**推荐的凭证方式**：`apiKey` 虽然标了 `.role('secret')`（表单不回显），
   * 但值仍以明文落在 profile 的 `cordis.patch.yml` 里。用引用名则配置文件里只有
   * 一个名字，真正的密钥留在凭证文件（或环境变量）中。
   *
   * 留空时按顺序尝试内置默认引用名：SYSTEMONE_API_KEY → UNISOUND_API_KEY → TYPESAFE_API_KEY。
   */
  apiKeyRef: z.string().default('').volatile(),
  /**
   * Unisound API Key（明文；不想落明文请改用 apiKeyRef 或环境变量）。
   *
   * 解析顺序：apiKey → 环境变量 → 凭证引用（apiKeyRef 或内置默认名）。
   */
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
  /**
   * 发送前对 state 做内置脱敏：手机号/身份证/邮箱/银行卡号替换为
   * `[手机号]` 等类型标签（判断语义保留）。state 会发给上游决策服务，
   * 处理含隐私数据的场景（尤其 data_governance）时建议开启。
   */
  redact: z.boolean().default(false).volatile(),

  /* ── 结构性字段：不在配置页里，改动需要重启 ───────────────────────────────── */

  /** 是否在每一步推理前自动捕获上下文并执行决策（挂载 pre-step，改动需重启） */
  autoDecide: z.boolean().default(false),

  /* ── 自动决策运行参数（volatile）：钩子已挂载时实时生效 ────────────────────── */
  /** 自动决策固定使用的场景 id；留空则用一次 choice 问句自动路由 */
  autoScenario: z.string().default('').volatile(),
  /**
   * 注入通道：message=本步生效（pre-step 注入）；context=官方动态上下文（晚一步生效）。
   *
   * 必须是枚举而不是裸 string：auto.js 的三处门控都是精确比较
   * （`!== 'context'` / `=== 'context'` / `!== 'message'`），写错大小写
   * （如 `Context`）会静默掉进 message 分支、产生意料之外的历史写入。
   * 枚举让非法值在加载期就报错，而不是运行时无提示地走错通道。
   */
  autoInject: z.union(['message', 'context']).default('message').volatile(),
  /**
   * 自动决策失败语义：open=放行（注入用途的正确默认）；closed=否决本轮
   * （pre-step 返回 `{ kind: 'reject' }`，宿主把本轮 turn 记为 blocked）。
   *
   * 必须是枚举而不是裸 string，理由同 autoInject：auto.js 的分支是精确比较，
   * 写错值会静默落回 open。closed 只对"本应得到决策却没有"的真失败生效
   * （请求异常、超时、场景执行失败、路由无可用品）；"主动不注入"
   * （寒暄、低置信度、斜杠命令）永远放行。仅 message 通道会拦截——
   * context 通道只注入参考信息，不 gate 任何东西。本档是为将来做闸门
   * （形态 C）预留的语义缝，当前注入用途请保持 open。
   */
  autoFailMode: z.union(['open', 'closed']).default('open').volatile(),
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

  /* ── 用量台账（volatile）────────────────────────────────────────────────── */

  /** 用量台账文件路径；留空则用 `$DSH_HOME/dsh-systemone/usage.jsonl` */
  usageLogPath: z.string().default('').volatile(),
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

    // 外发声明：装载时打印一行，之后 provider / redact 变化时再打印一次。
    // 见 _announceEgress 的说明——state 会原样发往上游，这件事必须是可审计的。
    this._egressStamp = null
    this._announceEgress()

    // 用量台账：工具路径与自动路径都记账（含路由请求），让花销可见。
    // 台账写盘失败会降级为仅内存统计，绝不影响决策。
    this.usageLedger = createUsageLedger({ path: readString(config, 'usageLogPath', ''), logger: ctx.logger })

    // inject 保证 ctx.tools 存在；注册失败必须显式抛出，绝不静默降级
    const tools = ctx.get('tools') ?? ctx.tools
    if (!tools || typeof tools.register !== 'function') {
      throw new Error('@master0071/dsh-systemone: 工具注册表不可用（inject: [\'tools\'] 未生效）')
    }
    this._disposers = createTools(this.provider, config, scenarios, {
      // 惰性读取：场景库可能已随 customScenarios 热更新重建，
      // 这里必须每次取最新的 warnings，而不是装配期快照。
      warnings: () => this.scenarioWarnings || [],
      usage: this.usageLedger,
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
          usage: this.usageLedger,
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
   * 外发声明：把「这次会不会联网、往哪发、发什么」打成一行可审计的日志。
   *
   * 为什么需要它：`state`（含对话历史与用户原文）会原样发往上游决策服务，
   * 而 `redact` 默认是 **false**。生态里同类插件被审计出的最常见问题正是
   * 「名为 guard/gate 的模块同时在往外发数据，而 README 不说」。一行启动声明
   * 让这件事在日志里可见，而不是只藏在配置文档里。
   *
   * `provider` 与 `redact` 都是热更新字段，所以本方法在**值变化时**会再打一次；
   * 相同状态不重复输出，避免每步刷日志。
   */
  _announceEgress() {
    try {
      const kind = readString(this.config, 'provider', 'unisound')
      const redact = readBoolean(this.config, 'redact', false)
      const stamp = `${kind}|${redact}`
      if (stamp === this._egressStamp) return
      this._egressStamp = stamp

      const logger = this.ctx?.logger
      if (kind === 'mock') {
        logger?.info?.('@master0071/dsh-systemone[egress]: OFF — provider=mock，不会发起任何网络请求')
        return
      }

      const budget = this._stateBudget()
      // 尽量报告真实端点；解析失败（配错 URL 等）时退回配置原文，不让声明本身抛错
      let target = ''
      try {
        target = this.currentProvider().resolveEndpoint()
      } catch {
        target = readString(this.config, 'endpoint', '') || readString(this.config, 'baseUrl', '')
      }
      const where = target || '(端点未配置)'

      const redactLine = redact
        ? `ON — 发送前把 ${redactRuleSummary()} 替换为 [类型] 标签（尽力而为：不在规则内的敏感串仍会外发）`
        : `OFF — ${redactRuleSummary()} 等敏感内容**原样外发**，建议在处理含隐私数据的内容时开启 redact`

      logger?.info?.(`@master0071/dsh-systemone[egress]: ON → ${where}`)
      logger?.info?.(
        `@master0071/dsh-systemone[egress]: SENDS state(<=${budget} 字符，含对话历史与用户原文) + questions`
        + ` + model；redact=${redactLine}`,
      )
    } catch {
      // 声明失败绝不能影响装配
    }
  }

  /**
   * state 的字符预算：工具路径截断到 MAX_TOOL_STATE_CHARS，自动决策路径拼装后可能更大。
   * 声明里报一个保守上界，让「发出去多大」有个量级概念。
   */
  _stateBudget() {
    const AUTO_HISTORY_PER_MESSAGE = 2000
    const AUTO_CURRENT_CHARS = 8000
    if (!readBoolean(this.config, 'autoDecide', false)) return 16000
    const messages = readNumber(this.config, 'autoMaxMessages', 6)
    return Math.max(16000, AUTO_CURRENT_CHARS + messages * AUTO_HISTORY_PER_MESSAGE)
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
    // 所有请求路径（工具/自动决策/服务 decide）取提供商都经过这里：
    // provider **或 redact** 任一变化（stamp 去重）即重发外发声明。
    // 放在方法末尾，保证声明解析端点用的是（可能刚重建的）新提供商。
    this._announceEgress()
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
   *
   * 实现要点：**不维护 trap 白名单**，而是统一走 `_forwardTrap()` 转发全部
   * 内部方法（[[Get]]/[[HasProperty]]/[[OwnPropertyKeys]]/[[GetPrototypeOf]]/
   * [[IsExtensible]]……）。白名单的毛病是「漏一个就静默读到旧值」——早期版本
   * 只挂了 get/has/ownKeys/getOwnPropertyDescriptor，`getPrototypeOf` 与
   * `isExtensible` 就绕过了刷新（`instanceof`、按原型嗅探 `Array.prototype`
   * 方法的库都会走这两条路），于是同一份引用在不同消费方眼里可能新旧不一。
   * 补齐 trap 后，将来新增的内部方法也自动覆盖，不需要再回来改这里。
   *
   * 注意 `Array.isArray` 是规范内部方法，不经过任何 trap（也无从拦截），
   * 它靠目标数组本身判定，因此始终正确、无需刷新。
   */
  liveScenarios() {
    if (this._scenarioProxy === undefined) {
      // 转发全部内部方法：每个 trap 都先刷新，再调用目标数组上的同名方法。
      this._scenarioProxy = new Proxy(this._scenarioArray, {
        get: this._forwardTrap('get'),
        set: this._forwardTrap('set'),
        has: this._forwardTrap('has'),
        deleteProperty: this._forwardTrap('deleteProperty'),
        ownKeys: this._forwardTrap('ownKeys'),
        getOwnPropertyDescriptor: this._forwardTrap('getOwnPropertyDescriptor'),
        defineProperty: this._forwardTrap('defineProperty'),
        getPrototypeOf: this._forwardTrap('getPrototypeOf'),
        setPrototypeOf: this._forwardTrap('setPrototypeOf'),
        isExtensible: this._forwardTrap('isExtensible'),
        preventExtensions: this._forwardTrap('preventExtensions'),
        apply: this._forwardTrap('apply'),
        construct: this._forwardTrap('construct'),
      })
    }
    return this._scenarioProxy
  }

  /**
   * 生成一个「先刷新、再转发」的 Proxy trap。
   *
   * 统一入口而不是逐个手写，保证刷新逻辑只有一份，新增 trap 也不会漏掉刷新。
   *
   * @param {PropertyKey} name - Reflect 上的方法名，与 trap 名一一对应
   * @returns {(...args: unknown[]) => unknown}
   */
  _forwardTrap(name) {
    return (...args) => {
      // 目标数组恒为 this._scenarioArray（原地改写，引用不变），
      // 但刷新必须发生在读取之前，否则拿到的是上一版场景。
      this._refreshScenarios()
      return Reflect[name](...args)
    }
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
