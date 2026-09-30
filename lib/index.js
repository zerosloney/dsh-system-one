/**
 * dsh-systemone 插件入口。
 *
 * 架构：Cordis 插件（Service 形态）。依赖 harness 的 `tools`（工具注册表）
 * 与 `logger`；无 Web 面。
 *
 * - 注册 2 个 Agent 工具：
 *     systemone_scenario — 统一场景调度（list / describe / run）
 *     systemone_decide   — 自定义问题的低层入口
 * - 场景库内置 9 大业务域，并支持在配置里用 JSON 追加/覆盖场景
 * - 暴露 `ctx.systemone.decide()` 供其他插件编程调用
 * - 提供商可配置（unisound / http / mock），切换厂商不影响工具层
 */
import { writeFileSync } from 'node:fs'
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createProvider } from './provider.js'
import { createTools } from './tools.js'
import { resolveScenarios } from './scenarios.js'
import { installAutoDecide } from './auto.js'

/**
 * 插件配置。所有字段均有默认值，可在插件设置面板中覆盖。
 */
const Config = z.object({
  /** 提供商类型：unisound（官方）/ http（SystemOne 兼容端点）/ mock（本地模拟） */
  provider: z.string().default('unisound'),
  /** Unisound API Key（也可用环境变量 UNISOUND_API_KEY / SYSTEMONE_API_KEY） */
  apiKey: z.string().default(''),
  /** Unisound API 基础地址（默认 https://maas-api.unisound.com/v1） */
  baseUrl: z.string().default('https://maas-api.unisound.com/v1'),
  /** provider=http 时的完整请求端点；留空则回退到 baseUrl */
  endpoint: z.string().default(''),
  /** 决策模型名 */
  model: z.string().default('u2-decision'),
  /** 请求超时（毫秒） */
  timeoutMs: z.number().min(1000).default(30000),
  /** 置信度阈值：任一答案低于该值则建议人工复核 */
  minConfidence: z.number().min(0).max(1).default(0.6),
  /** 自定义场景：JSON 数组字符串，同 id 覆盖内置场景；非法条目会被跳过并告警 */
  customScenarios: z.string().default(''),

  /* ── 自动决策（默认关闭） ─────────────────────────────────────────────── */
  /** 是否在每一步推理前自动捕获上下文并执行决策 */
  autoDecide: z.boolean().default(false),
  /** 自动决策固定使用的场景 id；留空则用一次 choice 问句自动路由 */
  autoScenario: z.string().default(''),
  /** 注入通道：message=本步生效（pre-step 注入）；context=官方动态上下文（晚一步生效） */
  autoInject: z.string().default('message'),
  /** 自动决策超时（毫秒），超时即放行，绝不阻塞会话 */
  autoTimeoutMs: z.number().min(500).default(8000),
  /** 捕获的历史消息条数（不含本轮新消息） */
  autoMaxMessages: z.number().min(1).max(50).default(6),
  /** 相同内容的结果缓存时长（毫秒），0 表示不缓存 */
  autoCacheTtlMs: z.number().min(0).default(60000),
  /** 自动决策使用的置信度阈值 */
  autoMinConfidence: z.number().min(0).max(1).default(0.6),
  /** 自动路由的置信度门槛：低于该值宁可不注入，避免塞入瞎猜的结论 */
  autoRouteMinConfidence: z.number().min(0).max(1).default(0.35),
  /** 触发自动决策的最小输入长度（字符）；低于该长度且整体是寒暄才跳过 */
  autoMinChars: z.number().min(0).default(4),
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
   * @param {import('zod').infer<typeof Config>} config
   */
  constructor(ctx, config) {
    super(ctx, 'systemone')
    this.config = config
    this.provider = createProvider(ctx, config)

    // ── 临时自检（诊断完成后删除）─────────────────────────────────────────
    // 宿主不写可读日志，插件又在关键路径上，激活结果必须能带外取证。
    const probe = {
      at: new Date().toISOString(),
      pluginVersion: '0.3.0',
      hasInject: SystemOneService.inject,
      toolsViaGet: typeof ctx.get?.('tools')?.register,
      toolsViaProp: typeof ctx.tools?.register,
    }
    try {
      writeFileSync(`${process.env.TEMP || '/tmp'}/dsh-systemone-activate.json`, JSON.stringify(probe, null, 2))
    } catch { /* 自检失败不影响启动 */ }
    // ── 临时自检结束 ──────────────────────────────────────────────────────

    const { scenarios, problems } = resolveScenarios(config.customScenarios)
    this.scenarios = scenarios
    for (const problem of problems) {
      ctx.logger?.warn?.(`dsh-systemone: ${problem}`)
    }

    // inject 保证 ctx.tools 存在；注册失败必须显式抛出，绝不静默降级
    const tools = ctx.get('tools') ?? ctx.tools
    if (!tools || typeof tools.register !== 'function') {
      throw new Error('dsh-systemone: 工具注册表不可用（inject: [\'tools\'] 未生效）')
    }
    this._disposers = createTools(this.provider, config, scenarios).map((tool) => tools.register(tool))
    this.scenarioProblems = problems

    // 自动决策：默认关闭；开启后在每一步推理前自动捕获上下文并注入判断
    this._autoDispose = () => {}
    if (config.autoDecide) {
      try {
        this._autoDispose = installAutoDecide(ctx, {
          provider: this.provider,
          config,
          scenarios,
          logger: ctx.logger,
        })
      } catch (error) {
        ctx.logger?.warn?.(`dsh-systemone: 自动决策安装失败，工具仍可用：${error?.message || error}`)
      }
    }

    ctx.logger?.info?.(
      `dsh-systemone: 已注册 ${this._disposers.length} 个工具、${scenarios.length} 个场景`
      + `（provider=${this.provider.name}, model=${config.model}, 自动决策=${config.autoDecide ? `开(${config.autoInject})` : '关'}）`,
    )
  }

  /** 列出当前全部场景（内置 + 自定义）。 */
  listScenarios() {
    return this.scenarios.map((s) => ({
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