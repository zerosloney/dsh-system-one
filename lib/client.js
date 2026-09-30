/**
 * client.js — dsh-systemone 的浏览器侧（DSH 桌面端 / Web 界面）。
 *
 * 宿主侧那半边只注册工具与服务、没有界面；这个半边负责在
 * 「侧栏 → 插件 → dsh-systemone → systemone 行」里渲染配置表单。
 *
 * 注册方式：`plugins.row.config` 槽位，key 为 `<包名>#<行 id>`。
 * —— 这是插件管理页里**唯一**会把 `form` 传进页面的配置槽位：
 *    页面宿主调用 `formFor(rowId)`，命中会传入
 *    `{ state: <快照>, mutate(ops, revision) }`；
 *    没有可编辑（volatile）字段时 `form` 为 undefined，页面退化为只读展示。
 *
 * 表单写入的是 profile 的 cordis.patch.yml（由宿主 dsh-config-editor 落盘），
 * 保存后经 Loader 热更新，宿主的 volatile 配置字段原地生效、无需重启。
 *
 * 模块格式：DSH 客户端模块加载器要求 `window.__ModuleLoader__.load({ id, factory })`，
 * 依赖通过 factory 的 `require()` 取得（react 等由加载器提供，无需 npm 依赖）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-systemone',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const jsxRuntime = require('react/jsx-runtime')
    const h = jsxRuntime.jsx
    const hs = jsxRuntime.jsxs
    const Fragment = react.Fragment

    /** 字典命名空间。 */
    const NS = 'settings.systemone'
    /** 本半边注册进 `plugins.row.config` 的键：包名#行 id。 */
    const ROW_CONFIG_KEY = 'dsh-systemone#systemone'

    /* ────────────────────────────── 文案 ────────────────────────────── */

    const zh = {
      tabService: '模型服务',
      tabServiceHint: '连接哪个 SystemOne 决策服务，以及用哪个模型。保存后立即生效，无需重启。',
      tabCustom: '自定义场景',
      tabCustomHint: '用 JSON 定义自己的场景（含「通用意图识别」）。保存后场景库立即重建，无需重启。',
      customScenarios: '场景定义（JSON 数组）',
      customScenariosHint: '同 id 会覆盖内置场景；留空 [] 表示只用内置 10 个。每个场景最多 16 个问题，choice 选项 2~26 个。',
      customScenariosPlaceholder: '[\n  {\n    "id": "intent",\n    "title": "通用意图识别",\n    "questions": {\n      "intent": {\n        "type": "choice",\n        "instructions": "用户最想做什么？",\n        "criteria": { "query": "查询", "action": "执行操作", "chat": "闲聊" }\n      }\n    }\n  }\n]',
      insertTemplate: '插入意图识别模板',
      jsonEmpty: '（空 = 只用内置场景）',
      jsonNotArray: '必须是 JSON 数组（以 [ 开头）',
      jsonBadSyntax: 'JSON 语法错误：{message}',
      jsonItemNotObject: '第 {index} 项不是对象',
      jsonItemIssues: '第 {index} 项（{id}）：{issues}',
      jsonOk: 'JSON 有效，共 {count} 个自定义场景',
      customIdsUsed: '（已加入「固定场景」候选）',
      tabAuto: '自动决策',
      tabAutoHint: '开启自动决策后，这些参数控制每一步推理前的自动判断。',
      provider: '提供商',
      providerHint: 'unisound=云知声官方；http=任意 SystemOne 兼容端点；mock=本地模拟（无需 Key，用于联调）',
      providerUnisound: '云知声（官方）',
      providerHttp: '自建 / 兼容端点',
      providerMock: '本地模拟',
      apiKey: 'API Key',
      apiKeyHint: '也可用环境变量 UNISOUND_API_KEY / SYSTEMONE_API_KEY。出于安全，已保存的 Key 不会回显。',
      apiKeyPlaceholder: '留空表示不修改已保存的值',
      baseUrl: 'API 基础地址',
      baseUrlHint: '默认 https://maas-api.unisound.com/v1',
      endpoint: '完整端点（可选）',
      endpointHint: '仅在「自建 / 兼容端点」时使用；留空则回退到基础地址',
      model: '模型名',
      modelHint: '默认 u2-decision',
      timeoutMs: '请求超时（毫秒）',
      timeoutMsHint: '单次决策请求的最长等待时间',
      minConfidence: '置信度阈值',
      minConfidenceHint: '任一答案低于该值时，结果会标记为建议人工复核（0~1）',
      autoScenario: '固定场景（可选）',
      autoScenarioHint: '点右侧箭头可从 10 个内置场景里选，也可手填场景 id 或别名（如 software_dev / 开发）；留空则每次自动选场景（多一次路由请求）',
      autoInject: '注入通道',
      autoInjectHint: 'message=同一步生效；context=走宿主动态上下文，不写入会话历史',
      autoInjectMessage: '同步注入（message）',
      autoInjectContext: '动态上下文（context）',
      autoTimeoutMs: '自动决策超时（毫秒）',
      autoTimeoutMsHint: '超时即放行，绝不阻塞会话',
      autoMaxMessages: '捕获历史条数',
      autoMaxMessagesHint: '自动决策时参考的最近消息数',
      autoCacheTtlMs: '结果缓存时长（毫秒）',
      autoCacheTtlMsHint: '相同内容在此时长内复用结果，0 表示不缓存',
      autoMinConfidence: '自动决策置信度阈值',
      autoMinConfidenceHint: '低于该值时结论会附带「请人工确认」提示',
      autoRouteMinConfidence: '自动路由置信度门槛',
      autoRouteMinConfidenceHint: '低于该值时宁可不注入，避免塞入瞎猜的结论',
      autoMinChars: '最小触发长度（字符）',
      autoMinCharsHint: '低于该长度且整体是寒暄时跳过',
      save: '保存',
      saving: '保存中…',
      revert: '撤销修改',
      saved: '已保存，立即生效',
      saveFailed: '保存失败，请检查填写内容',
      conflict: '配置已被其他地方改动，已刷新为最新值，请重新修改',
      readOnly: '当前不可编辑',
      noForm: '宿主要求该条目声明 volatile 配置字段后才会显示表单。',
      summary: 'SystemOne 决策模型配置',
      current: '当前：{provider} · {model}',
      expand: '展开',
      collapse: '收起',
    }

    const en = {
      tabService: 'Model service',
      tabServiceHint: 'Which SystemOne decision service to call, and with which model. Saving applies immediately.',
      tabCustom: 'Custom scenarios',
      tabCustomHint: 'Define your own scenarios in JSON (including general intent recognition). Saving rebuilds the library immediately.',
      customScenarios: 'Scenario definitions (JSON array)',
      customScenariosHint: 'An id matching a built-in overrides it; empty [] keeps only the 10 built-ins. Max 16 questions per scenario, 2~26 choice options.',
      customScenariosPlaceholder: '[\n  {\n    "id": "intent",\n    "title": "General intent",\n    "questions": {\n      "intent": {\n        "type": "choice",\n        "instructions": "What does the user want?",\n        "criteria": { "query": "Look up", "action": "Do something", "chat": "Small talk" }\n      }\n    }\n  }\n]',
      insertTemplate: 'Insert intent template',
      jsonEmpty: '(empty = built-in scenarios only)',
      jsonNotArray: 'Must be a JSON array (starting with [)',
      jsonBadSyntax: 'JSON syntax error: {message}',
      jsonItemNotObject: 'Item {index} is not an object',
      jsonItemIssues: 'Item {index} ({id}): {issues}',
      jsonOk: 'Valid JSON — {count} custom scenario(s)',
      customIdsUsed: '(added to the fixed-scenario candidates)',
      tabAuto: 'Auto decision',
      tabAutoHint: 'These parameters drive the automatic decision taken before each reasoning step.',
      provider: 'Provider',
      providerHint: 'unisound=Unisound official; http=any SystemOne-compatible endpoint; mock=local mock (no key)',
      providerUnisound: 'Unisound (official)',
      providerHttp: 'Custom / compatible endpoint',
      providerMock: 'Local mock',
      apiKey: 'API key',
      apiKeyHint: 'UNISOUND_API_KEY / SYSTEMONE_API_KEY also work. A saved key is never echoed back.',
      apiKeyPlaceholder: 'Leave empty to keep the saved value',
      baseUrl: 'Base URL',
      baseUrlHint: 'Defaults to https://maas-api.unisound.com/v1',
      endpoint: 'Full endpoint (optional)',
      endpointHint: 'Used only by the custom/compatible provider; falls back to the base URL',
      model: 'Model',
      modelHint: 'Defaults to u2-decision',
      timeoutMs: 'Request timeout (ms)',
      timeoutMsHint: 'Longest wait for one decision request',
      minConfidence: 'Confidence threshold',
      minConfidenceHint: 'Below this value a result is flagged for human review (0~1)',
      autoScenario: 'Fixed scenario (optional)',
      autoScenarioHint: 'Pick one of the 10 built-in scenarios from the dropdown, or type a scenario id/alias (e.g. software_dev); empty routes automatically on every step (one extra request)',
      autoInject: 'Injection channel',
      autoInjectHint: 'message=applies in the same step; context=host dynamic context, not written to history',
      autoInjectMessage: 'Same step (message)',
      autoInjectContext: 'Dynamic context (context)',
      autoTimeoutMs: 'Auto decision timeout (ms)',
      autoTimeoutMsHint: 'On timeout the step proceeds — never blocks the session',
      autoMaxMessages: 'Captured history messages',
      autoMaxMessagesHint: 'How many recent messages the automatic decision reads',
      autoCacheTtlMs: 'Result cache TTL (ms)',
      autoCacheTtlMsHint: 'Reuse a result for identical input; 0 disables caching',
      autoMinConfidence: 'Auto decision confidence threshold',
      autoMinConfidenceHint: 'Below this value the conclusion carries a human-review note',
      autoRouteMinConfidence: 'Auto routing confidence floor',
      autoRouteMinConfidenceHint: 'Below this value nothing is injected rather than guessing',
      autoMinChars: 'Minimum trigger length (chars)',
      autoMinCharsHint: 'Shorter greetings are skipped',
      save: 'Save',
      saving: 'Saving…',
      revert: 'Revert changes',
      saved: 'Saved — applied immediately',
      saveFailed: 'Save failed — check the values',
      conflict: 'The configuration changed elsewhere; the newest values were reloaded',
      readOnly: 'Read-only right now',
      noForm: 'The host exposes a form only when the entry declares volatile config fields.',
      summary: 'SystemOne decision model configuration',
      current: 'Current: {provider} · {model}',
      expand: 'Expand',
      collapse: 'Collapse',
    }

    /* ────────────────────────────── 样式 ────────────────────────────── */

    const listStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: 12,
      listStyle: 'none',
      margin: 0,
      padding: 0,
    }

    const cardStyle = {
      border: '0.5px solid var(--dsw-alias-settings-card-stroke, #e3e3e6)',
      borderRadius: 12,
      background: 'var(--dsw-alias-settings-card-fill, transparent)',
      overflow: 'hidden',
    }

    const headStyle = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
      width: '100%',
      padding: '12px 14px',
      background: 'transparent',
      border: 0,
      cursor: 'pointer',
      textAlign: 'left',
      color: 'inherit',
      font: 'inherit',
    }

    const bodyStyle = {
      borderTop: '0.5px solid var(--dsw-alias-border-l2, #e3e3e6)',
      padding: '12px 14px 14px',
      display: 'flex',
      flexDirection: 'column',
      gap: 12,
    }

    const titleStyle = { fontSize: 14, fontWeight: 500, lineHeight: '20px' }
    const descStyle = {
      color: 'var(--dsw-alias-label-tertiary, #8a8a8e)',
      fontSize: 12,
      lineHeight: '18px',
      marginTop: 2,
    }
    const fieldStyle = { display: 'flex', flexDirection: 'column', gap: 4 }
    const labelStyle = { fontSize: 12, lineHeight: '18px', fontWeight: 500 }
    const hintStyle = { color: 'var(--dsw-alias-label-tertiary, #8a8a8e)', fontSize: 11, lineHeight: '17px' }
    const inputStyle = {
      width: '100%',
      boxSizing: 'border-box',
      height: 32,
      padding: '0 10px',
      fontSize: 13,
      borderRadius: 8,
      color: 'var(--dsw-alias-label-primary, inherit)',
      background: 'var(--dsw-alias-bg-layer-1, transparent)',
      border: '0.5px solid var(--dsw-alias-border-l4, #d0d0d4)',
      outline: 'none',
    }
    const footerStyle = { display: 'flex', alignItems: 'center', gap: 10, marginTop: 2 }
    const primaryButton = {
      height: 30,
      padding: '0 14px',
      borderRadius: 8,
      border: 'none',
      cursor: 'pointer',
      fontSize: 13,
      color: '#fff',
      background: 'var(--dsw-alias-state-business-primary, #4d6bfe)',
    }
    const ghostButton = {
      height: 30,
      padding: '0 12px',
      borderRadius: 8,
      cursor: 'pointer',
      fontSize: 13,
      color: 'inherit',
      background: 'transparent',
      border: '0.5px solid var(--dsw-alias-border-l3, #d0d0d4)',
    }
    const statusStyle = { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary, #8a8a8e)' }
    const errorStyle = { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-state-error-primary, #d64545)' }

    /* ────────────────────────────── 字段定义 ────────────────────────────── */

    /** 数字字段在草稿里保持字符串，保存时再转数字，避免用户输入中途被强制转换。 */
    /**
     * 内置场景候选（供「固定场景」输入框的下拉提示）。
     *
     * 用 `<datalist>` 而不是 `<select>`：既能把 10 个内置场景列出来点选，
     * 又允许手填自定义场景 id 或别名（别名见 README 的场景表）。
     * 这里只放 id + 中文标题；id 用别名也能命中（findScenario 会按别名匹配）。
     */
    const SCENARIO_OPTIONS = [
      { id: 'customer_service', label: '客服运营 · 工单派单与分流' },
      { id: 'content_moderation', label: '内容审核 · 违规判定与处置' },
      { id: 'agent_routing', label: '智能体路由 · 意图分流与工具决策' },
      { id: 'sales_lead', label: '销售线索 · 质量评分与分配' },
      { id: 'risk_control', label: '金融风控 · 交易异常与风险等级' },
      { id: 'recruiting', label: '招聘 HR · 简历匹配与流程推进' },
      { id: 'data_governance', label: '数据治理 · 打标、归因与敏感识别' },
      { id: 'education', label: '教育内容 · 知识点、难度与合规' },
      { id: 'requirements', label: '需求与变更 · 优先级、风险与派发' },
      { id: 'software_dev', label: '软件开发 · 任务类型、复杂度与处置' },
    ]

    const SERVICE_FIELDS = [
      { key: 'provider', kind: 'select', options: ['unisound', 'http', 'mock'] },
      { key: 'apiKey', kind: 'password' },
      { key: 'baseUrl', kind: 'text' },
      { key: 'endpoint', kind: 'text' },
      { key: 'model', kind: 'text' },
      { key: 'timeoutMs', kind: 'number' },
      { key: 'minConfidence', kind: 'number' },
    ]

    /** 自定义场景编辑区（JSON）。 */
    const CUSTOM_FIELDS = [{ key: 'customScenarios', kind: 'json' }]

    /**
     * 客户端侧校验自定义场景 JSON。
     *
     * 只做「能立刻发现」的检查：JSON 语法 + 每条的 id/title/questions 与
     * 问题类型/选项数量。宿主侧 `resolveScenarios` 还会做一遍同样的校验，
     * 语义问题（非法条目）宿主会跳过并写入日志；这里提前拦住，用户不必去翻日志。
     *
     * @param {string} text - 编辑框里的原始文本
     * @returns {{ ok: boolean, error?: string, ids: string[], count: number }}
     */
    function validateCustomScenarios(text) {
      const raw = typeof text === 'string' ? text.trim() : ''
      if (raw === '') return { ok: true, ids: [], count: 0 }

      let parsed
      try {
        parsed = JSON.parse(raw)
      } catch (error) {
        return { ok: false, error: `json:${error?.message || error}`, ids: [], count: 0 }
      }
      if (!Array.isArray(parsed)) return { ok: false, error: 'notArray', ids: [], count: 0 }

      const ids = []
      for (let i = 0; i < parsed.length; i += 1) {
        const spec = parsed[i]
        const at = i + 1
        if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
          return { ok: false, error: `item:${at}`, ids, count: 0 }
        }
        const issues = []
        if (typeof spec.id !== 'string' || spec.id.trim() === '') issues.push('缺少 id')
        if (typeof spec.title !== 'string' || spec.title.trim() === '') issues.push('缺少 title')
        const questions = spec.questions
        if (!questions || typeof questions !== 'object' || Array.isArray(questions)) {
          issues.push('缺少 questions 对象')
        } else {
          const qids = Object.keys(questions)
          if (qids.length === 0) issues.push('questions 至少 1 个')
          if (qids.length > 16) issues.push(`questions 最多 16 个（当前 ${qids.length}）`)
          for (const [qid, q] of Object.entries(questions)) {
            if (!q || typeof q !== 'object') { issues.push(`问题 ${qid} 必须是对象`); continue }
            if (!['choice', 'noul', 'score'].includes(q.type)) {
              issues.push(`问题 ${qid} 的 type 必须是 choice/noul/score`)
              continue
            }
            if (typeof q.instructions !== 'string' || q.instructions.trim() === '') {
              issues.push(`问题 ${qid} 缺少 instructions`)
            }
            if (q.type === 'choice') {
              const keys = q.criteria && typeof q.criteria === 'object' && !Array.isArray(q.criteria)
                ? Object.keys(q.criteria)
                : null
              if (keys === null) issues.push(`问题 ${qid}（choice）需要 criteria 对象`)
              else if (keys.length < 2) issues.push(`问题 ${qid}（choice）至少 2 个选项`)
              else if (keys.length > 26) issues.push(`问题 ${qid}（choice）选项建议 ≤26（当前 ${keys.length}）`)
            }
            if (q.type === 'score'
              && (!Array.isArray(q.criteria) || q.criteria.length < 2)) {
              issues.push(`问题 ${qid}（score）criteria 需为长度 ≥2 的数组`)
            }
          }
        }
        if (issues.length > 0) {
          return { ok: false, error: `issues:${at}:${spec.id ?? '?'}:${issues.join('；')}`, ids, count: 0 }
        }
        if (typeof spec.id === 'string') ids.push(spec.id.trim())
      }
      return { ok: true, ids, count: ids.length }
    }

    const AUTO_FIELDS = [
      { key: 'autoScenario', kind: 'datalist', options: SCENARIO_OPTIONS },
      { key: 'autoInject', kind: 'select', options: ['message', 'context'] },
      { key: 'autoTimeoutMs', kind: 'number' },
      { key: 'autoMaxMessages', kind: 'number' },
      { key: 'autoCacheTtlMs', kind: 'number' },
      { key: 'autoMinConfidence', kind: 'number' },
      { key: 'autoRouteMinConfidence', kind: 'number' },
      { key: 'autoMinChars', kind: 'number' },
    ]

    /** 选项字段的显示名走字典，例如 provider 的 unisound → 「云知声（官方）」。 */
    function optionLabel(t, key, value) {
      if (key === 'provider') {
        if (value === 'unisound') return t('providerUnisound')
        if (value === 'http') return t('providerHttp')
        if (value === 'mock') return t('providerMock')
      }
      if (key === 'autoInject') {
        if (value === 'message') return t('autoInjectMessage')
        if (value === 'context') return t('autoInjectContext')
      }
      return value
    }

    /** 把快照里的值转成草稿字符串（表单受控值统一按字符串处理）。 */
    function toDraft(value) {
      if (value === undefined || value === null) return ''
      return String(value)
    }

    /* ────────────────────────────── 组件 ────────────────────────────── */

    /**
     * 一个可折叠的配置卡片：标题 + 说明，展开后是字段表单。
     */
    function ConfigCard({ t, title, description, open, onToggle, children }) {
      return hs('li', {
        style: cardStyle,
        children: [
          h('button', {
            key: 'head',
            type: 'button',
            style: headStyle,
            'aria-expanded': open,
            onClick: onToggle,
            children: hs('span', {
              style: { display: 'flex', flexDirection: 'column', minWidth: 0 },
              children: [
                h('span', { key: 'title', style: titleStyle, children: title }),
                h('span', { key: 'desc', style: descStyle, children: description }),
              ],
            }),
          }),
          open ? h('div', { key: 'body', style: bodyStyle, children }) : null,
        ],
      })
    }

    /** 单个字段：标签 + 控件 + 说明。 */
    function Field({ t, field, value, disabled, onChange }) {
      const label = t(field.key)
      const hint = t(`${field.key}Hint`)
      const controlId = `systemone-${field.key}`

      let control
      if (field.kind === 'select') {
        // 注意：jsx(type, props, key) 的第三个参数是 key，children 必须放进 props
        control = h('select', {
          id: controlId,
          style: inputStyle,
          value: value,
          disabled,
          onChange: (event) => onChange(field.key, event.target.value),
          children: field.options.map((option) =>
            h('option', { key: option, value: option, children: optionLabel(t, field.key, option) }),
          ),
        })
      } else if (field.kind === 'datalist') {
        // 带候选的输入框：可直接点选内置场景，也能手填自定义场景 id / 别名
        const listId = `${controlId}-options`
        control = hs(Fragment, {
          children: [
            h('input', {
              key: 'input',
              id: controlId,
              style: inputStyle,
              type: 'text',
              list: listId,
              value,
              disabled,
              autoComplete: 'off',
              onChange: (event) => onChange(field.key, event.target.value),
            }),
            h('datalist', {
              key: 'list',
              id: listId,
              children: field.options.map((option) =>
                h('option', { key: option.id, value: option.id, children: option.label }),
              ),
            }),
          ],
        })
      } else if (field.kind === 'json') {
        // 多行 JSON 编辑框：等宽字体，保存前由调用方校验
        control = h('textarea', {
          id: controlId,
          style: {
            ...inputStyle,
            height: 'auto',
            minHeight: 180,
            padding: '8px 10px',
            fontFamily: 'var(--ds-font-family-code, ui-monospace, monospace)',
            fontSize: 12,
            lineHeight: '18px',
            resize: 'vertical',
          },
          value,
          disabled,
          spellCheck: false,
          placeholder: t('customScenariosPlaceholder'),
          onChange: (event) => onChange(field.key, event.target.value),
        })
      } else {
        control = h('input', {
          id: controlId,
          style: inputStyle,
          type: field.kind === 'password' ? 'password' : field.kind === 'number' ? 'text' : 'text',
          inputMode: field.kind === 'number' ? 'decimal' : undefined,
          value,
          disabled,
          placeholder: field.key === 'apiKey' ? t('apiKeyPlaceholder') : undefined,
          autoComplete: 'off',
          onChange: (event) => onChange(field.key, event.target.value),
        })
      }

      return hs('div', {
        style: fieldStyle,
        children: [
          hs('div', {
            key: 'head',
            style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 },
            children: [
              h('label', { key: 'label', htmlFor: controlId, style: labelStyle, children: label }),
              field.extra === undefined ? null : field.extra,
            ],
          }),
          control,
          h('span', { key: 'hint', style: hintStyle, children: hint }),
          field.error === undefined
            ? null
            : h('span', { key: 'err', style: errorStyle, children: field.error }),
        ],
      })
    }

    /** 把校验结果的机器码翻成给用户看的一句话。 */
    function describeCustomError(code, t) {
      if (code === undefined) return undefined
      if (code === 'notArray') return t('jsonNotArray')
      const syntax = /^json:(.*)$/s.exec(code)
      if (syntax) return t('jsonBadSyntax', { message: syntax[1] })
      const item = /^item:(\d+)$/.exec(code)
      if (item) return t('jsonItemNotObject', { index: item[1] })
      const issues = /^issues:(\d+):([^:]*):(.*)$/s.exec(code)
      if (issues) return t('jsonItemIssues', { index: issues[1], id: issues[2], issues: issues[3] })
      return code
    }

    /**
     * 配置页主体。
     *
     * `form` 由插件管理页注入：`{ state, mutate }`。
     * 没有 volatile 字段时宿主不传 form，这里退化为只读提示。
     */
    function SystemOneConfigPage({ view, t, form }) {
      const [openService, setOpenService] = react.useState(true)
      const [openCustom, setOpenCustom] = react.useState(false)
      const [openAuto, setOpenAuto] = react.useState(false)
      const [draft, setDraft] = react.useState(null)
      const [busy, setBusy] = react.useState(false)
      const [notice, setNotice] = react.useState(null)

      const live = form?.state?.value ?? {}
      const revision = form?.state?.revision
      const writable = form?.state?.writable !== false && form !== undefined

      // 快照更新（保存成功 / 别处改动）后，重置草稿
      const snapshotKey = `${String(revision)}|${JSON.stringify(live)}`
      const lastKey = react.useRef(null)
      if (lastKey.current !== snapshotKey) {
        lastKey.current = snapshotKey
        if (draft !== null) setDraft(null)
      }

      if (view === 'summary') {
        return t('summary')
      }

      if (form === undefined) {
        return h('p', { style: statusStyle, children: t('noForm') })
      }

      const ALL_FIELDS = [...SERVICE_FIELDS, ...CUSTOM_FIELDS, ...AUTO_FIELDS]
      const current = {}
      for (const field of ALL_FIELDS) current[field.key] = toDraft(live[field.key])

      const values = { ...current, ...(draft ?? {}) }

      // 自定义场景先校验：不通过就禁用保存，并把问题显示在编辑框下方
      const customCheck = validateCustomScenarios(values.customScenarios)
      const customErrorText = customCheck.ok ? undefined : describeCustomError(customCheck.error, t)

      const dirty = draft !== null && Object.keys(draft).some((key) => draft[key] !== current[key])
      const canSave = dirty && !busy && writable && customCheck.ok

      // 「固定场景」候选 = 10 个内置 + 当前生效的自定义场景 id
      const scenarioOptions = [
        ...SCENARIO_OPTIONS,
        ...(customCheck.ok
          ? customCheck.ids
              .filter((id) => !SCENARIO_OPTIONS.some((option) => option.id === id))
              .map((id) => ({ id, label: id }))
          : []),
      ]

      const onFieldChange = (key, value) => {
        setNotice(null)
        setDraft((previous) => ({ ...(previous ?? {}), [key]: value }))
      }

      const onSave = async () => {
        if (!canSave) return
        setBusy(true)
        setNotice(null)
        try {
          const ops = []
          for (const [key, value] of Object.entries(draft ?? {})) {
            if (value === current[key]) continue
            // apiKey 留空表示「保持已保存的值」，不发写操作
            if (key === 'apiKey' && value === '') continue
            const field = ALL_FIELDS.find((item) => item.key === key)
            let next = value
            if (field?.kind === 'number') {
              const parsed = Number(value)
              if (!Number.isFinite(parsed)) continue
              next = parsed
            }
            ops.push({ op: 'set', path: [key], value: next })
          }
          if (ops.length === 0) {
            setDraft(null)
            return
          }
          const ok = await form.mutate(ops, revision)
          if (ok) {
            setDraft(null)
            setNotice({ kind: 'ok', text: t('saved') })
          } else {
            setNotice({ kind: 'error', text: t('conflict') })
          }
        } catch {
          setNotice({ kind: 'error', text: t('saveFailed') })
        } finally {
          setBusy(false)
        }
      }

      /** 渲染字段；可按 key 附加错误提示、候选、右上角附加元素。 */
      const renderFields = (fields, extras = {}) =>
        fields.map((field) => {
          const extra = extras[field.key]
          const resolved = field.key === 'autoScenario'
            ? { ...field, options: scenarioOptions }
            : field
          return h(Field, {
            key: field.key,
            t,
            field: extra === undefined ? resolved : { ...resolved, ...extra },
            value: values[field.key],
            disabled: !writable || busy,
            onChange: onFieldChange,
          })
        })

      const statusLine = hs(Fragment, {
        children: [
          h('span', { key: 'now', children: t('current', { provider: values.provider || 'unisound', model: values.model || 'u2-decision' }) }),
          notice !== null
            ? h('span', { key: 'notice', style: notice.kind === 'ok' ? statusStyle : errorStyle, children: notice.text })
            : null,
          !writable ? h('span', { key: 'ro', style: statusStyle, children: t('readOnly') }) : null,
        ],
      })

      return hs('ul', {
        style: listStyle,
        children: [
          h(ConfigCard, {
            key: 'service',
            t,
            title: t('tabService'),
            description: t('tabServiceHint'),
            open: openService,
            onToggle: () => setOpenService((value) => !value),
            // 注意：jsx(type, props, key) 的第三个参数是 key，正文必须作为 children 放进 props
            children: hs(Fragment, {
              children: [
                ...renderFields(SERVICE_FIELDS),
                hs('div', {
                  key: 'footer',
                  style: footerStyle,
                  children: [
                    h('button', {
                      key: 'save',
                      type: 'button',
                      style: { ...primaryButton, opacity: canSave ? 1 : 0.5 },
                      disabled: !canSave,
                      onClick: onSave,
                      children: busy ? t('saving') : t('save'),
                    }),
                    h('button', {
                      key: 'revert',
                      type: 'button',
                      style: ghostButton,
                      disabled: !dirty || busy,
                      onClick: () => {
                        setDraft(null)
                        setNotice(null)
                      },
                      children: t('revert'),
                    }),
                    statusLine,
                  ],
                }),
              ],
            }),
          }),
          h(ConfigCard, {
            key: 'custom',
            t,
            title: t('tabCustom'),
            description: t('tabCustomHint'),
            open: openCustom,
            onToggle: () => setOpenCustom((value) => !value),
            children: hs(Fragment, {
              children: [
                ...renderFields(CUSTOM_FIELDS, {
                  customScenarios: {
                    error: customErrorText,
                    extra: h('button', {
                      key: 'tpl',
                      type: 'button',
                      style: { ...ghostButton, height: 24, padding: '0 8px', fontSize: 12 },
                      disabled: !writable || busy,
                      onClick: () => {
                        // 填一个「通用意图识别」模板，用户改 criteria 即可
                        const template = JSON.stringify([
                          {
                            id: 'intent',
                            title: '通用意图识别',
                            description: '把任意输入归类到业务意图。',
                            aliases: ['意图', 'intent'],
                            questions: {
                              intent: {
                                type: 'choice',
                                label: '意图',
                                instructions: '用户这句话最想做什么？',
                                criteria: {
                                  query: '查询/检索信息',
                                  action: '执行一个操作',
                                  create: '新建内容或文件',
                                  modify: '修改已有内容',
                                  analyze: '分析、对比、总结',
                                  explain: '解释原理或概念',
                                  debug: '排查报错或异常',
                                  chat: '闲聊、寒暄',
                                  other: '以上都不是',
                                },
                              },
                              urgency: {
                                type: 'score',
                                label: '紧急度',
                                instructions: '这件事有多紧急？',
                                criteria: ['不急', '可以等', '尽快', '马上'],
                              },
                            },
                            recommendation: '意图「{intent}」，紧急度 {urgency}',
                          },
                        ], null, 2)
                        onFieldChange('customScenarios', template)
                        setOpenCustom(true)
                      },
                      children: t('insertTemplate'),
                    }),
                  },
                }),
                hs('div', {
                  key: 'footer',
                  style: footerStyle,
                  children: [
                    h('button', {
                      key: 'save',
                      type: 'button',
                      style: { ...primaryButton, opacity: canSave ? 1 : 0.5 },
                      disabled: !canSave,
                      onClick: onSave,
                      children: busy ? t('saving') : t('save'),
                    }),
                    h('button', {
                      key: 'revert',
                      type: 'button',
                      style: ghostButton,
                      disabled: !dirty || busy,
                      onClick: () => {
                        setDraft(null)
                        setNotice(null)
                      },
                      children: t('revert'),
                    }),
                    customCheck.ok
                      ? h('span', {
                        key: 'ok',
                        style: statusStyle,
                        children: customCheck.count === 0
                          ? t('jsonEmpty')
                          : `${t('jsonOk', { count: customCheck.count })} ${t('customIdsUsed')}`,
                      })
                      : null,
                    statusLine,
                  ],
                }),
              ],
            }),
          }),
          h(ConfigCard, {
            key: 'auto',
            t,
            title: t('tabAuto'),
            description: t('tabAutoHint'),
            open: openAuto,
            onToggle: () => setOpenAuto((value) => !value),
            children: hs(Fragment, {
              children: [
                ...renderFields(AUTO_FIELDS),
                hs('div', {
                  key: 'footer',
                  style: footerStyle,
                  children: [
                    h('button', {
                      key: 'save',
                      type: 'button',
                      style: { ...primaryButton, opacity: canSave ? 1 : 0.5 },
                      disabled: !canSave,
                      onClick: onSave,
                      children: busy ? t('saving') : t('save'),
                    }),
                    statusLine,
                  ],
                }),
              ],
            }),
          }),
        ],
      })
    }

    /* ────────────────────────────── 注册 ────────────────────────────── */

    /** 稳定插件名。 */
    const name = 'dsh-systemone-client'

    /** 需要的客户端服务：槽位注册表与字典。 */
    const inject = ['slots', 'locale']

    /**
     * 挂载浏览器半边。
     * @param {object} ctx - 浏览器插件上下文
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-systemone: dictionaries')

      // 某一行的配置页。key 必须是「包名#行 id」，插件管理页才会把 form 传进来。
      ctx.effect(
        () =>
          ctx.slots.inject('plugins.row.config', () =>
            ctx.slots.register(
              {
                name: 'plugins.row.config',
                key: ROW_CONFIG_KEY,
                locale: NS,
              },
              SystemOneConfigPage,
            ),
          ),
        'dsh-systemone: row config page',
      )
    }

    exports.name = name
    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})





