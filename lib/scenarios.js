/**
 * scenarios.js — SystemOne 场景库。
 *
 * 一个"场景"= 一组结构化问题（choice / noul / score）+ 可选的派生字段与建议模板。
 * 场景是与厂商无关的纯数据，既可以是内置的，也可以由用户在插件配置里用 JSON 追加。
 *
 * 场景定义格式：
 * {
 *   id: string,                       // 唯一标识（必填）
 *   title: string,                    // 展示名（必填）
 *   description?: string,             // 场景说明
 *   aliases?: string[],               // 别名，便于模型用中文名/英文名查找
 *   questions: {                      // 问题映射（必填，至少 1 个）
 *     [qid]: {
 *       type: 'choice' | 'noul' | 'score',
 *       instructions: string,         // 给模型的问题描述
 *       label?: string,               // 摘要里的显示名（默认用 qid）
 *       criteria?: object | string[], // choice=选项映射；score=分级标签数组
 *     }
 *   },
 *   derive?: {                        // 可选派生字段
 *     [name]: { question: string, values?: string[], map?: object }
 *   },
 *   recommendation?: string,          // 可选建议模板
 * }
 *
 * 建议模板语法：
 *   {qid}                → 该问题的可读标签（choice=选项说明，score=分级说明，noul=是/否）
 *   {qid.key}            → 原始值（choice=选项 key，score=取整后的分值，noul=true/false）
 *   {qid.confidence}     → 置信度百分比
 *   {derivedName}        → 派生字段
 *   {qid?文案A|文案B}     → 条件文案（noul 为真 / 分值≥1 / choice 非空非 none 时取 A）
 */

/** 内置场景：10 个业务域，每个 3 个结构化问题。 */
export const BUILTIN_SCENARIOS = [
  {
    id: 'customer_service',
    title: '客服运营 · 工单派单与分流',
    description: '判断工单归属团队、严重程度，以及是否需要立即升级值班或 PO。',
    aliases: ['ticket_triage', '工单分流', '客服', '派单'],
    questions: {
      department: {
        type: 'choice',
        label: '受理部门',
        instructions: '这个工单应该由哪个团队处理？',
        criteria: {
          billing: '支付、退款和账单问题',
          technical: '产品故障和集成问题',
          account: '账号、权限与登录问题',
          logistics: '物流与交付问题',
          other: '其他问题',
        },
      },
      severity: {
        type: 'score',
        label: '严重程度',
        instructions: '这个问题有多严重？',
        criteria: [
          '轻微问题，不影响功能',
          '部分功能受影响，但存在替代方案',
          '核心功能不可用，没有替代方案',
          '造成严重业务或安全影响',
        ],
      },
      escalate: {
        type: 'noul',
        label: '立即升级',
        instructions: '是否需要立即通知值班人员或升级 PO？',
      },
    },
    derive: { priority: { question: 'severity', values: ['P4', 'P3', 'P2', 'P1'] } },
    recommendation: '转 {department} 处理（优先级 {priority}）。{escalate?需立即通知值班人员|无需紧急升级}',
  },
  {
    id: 'content_moderation',
    title: '内容审核 · 违规判定与处置',
    description: '判定内容是否违规、违规类型归类、风险等级，并给出放行/复审/拦截动作。',
    aliases: ['moderation', '内容安全', '审核'],
    questions: {
      violation: {
        type: 'choice',
        label: '违规类型',
        instructions: '这段内容属于哪种情况？',
        criteria: {
          none: '正常内容，无违规',
          violence: '暴力或血腥内容',
          hate: '仇恨或歧视言论',
          sexual: '色情或低俗内容',
          fraud: '诈骗、虚假或误导信息',
          politics: '政治敏感内容',
          other: '其他违规类型',
        },
      },
      severity: {
        type: 'score',
        label: '风险等级',
        instructions: '这段内容的风险程度有多高？',
        criteria: ['无风险', '低风险', '中风险', '高风险'],
      },
      action: {
        type: 'choice',
        label: '处置动作',
        instructions: '应该采取什么处置动作？',
        criteria: {
          allow: '放行',
          review: '进入人工复审',
          block: '拦截并下架',
        },
      },
    },
    recommendation: '处置动作「{action}」，违规类型「{violation}」，风险等级 {severity}。',
  },
  {
    id: 'agent_routing',
    title: '智能体路由 · 意图分流与工具决策',
    description: '识别用户意图，判断是否需要调用工具或检索知识库，以及是否需要转人工。',
    aliases: ['routing', '意图分流', '智能体'],
    questions: {
      intent: {
        type: 'choice',
        label: '用户意图',
        instructions: '这个请求属于哪类意图？',
        criteria: {
          knowledge_qa: '知识问答',
          order_service: '订单与售后',
          billing: '账单与支付',
          technical_support: '技术支持',
          chitchat: '闲聊或无法归类',
        },
      },
      use_tool: {
        type: 'noul',
        label: '调用工具',
        instructions: '是否需要调用外部工具或检索知识库？',
      },
      handoff: {
        type: 'noul',
        label: '转人工',
        instructions: '是否需要转交人工客服处理？',
      },
    },
    recommendation: '路由到「{intent}」。{use_tool?需要调用工具或检索|可直接回答}，{handoff?需转人工|可自动处理}',
  },
  {
    id: 'sales_lead',
    title: '销售线索 · 质量评分与分配',
    description: '评估线索质量、分配归属，判断是否值得主动跟进。',
    aliases: ['lead_scoring', '线索评分', '销售'],
    questions: {
      quality: {
        type: 'score',
        label: '线索质量',
        instructions: '这条线索的质量有多高？',
        criteria: ['无效线索', '低质量', '中等质量', '高质量', '极高意向'],
      },
      owner: {
        type: 'choice',
        label: '线索归属',
        instructions: '这条线索应该分配给谁？',
        criteria: {
          enterprise_sales: '大客户销售',
          smb_sales: '中小客户销售',
          channel: '渠道团队',
          self_service: '自助注册，无需跟进',
        },
      },
      follow_up: {
        type: 'noul',
        label: '是否跟进',
        instructions: '这条线索是否值得主动跟进？',
      },
    },
    recommendation: '线索质量 {quality} 分，分配给「{owner}」。{follow_up?值得主动跟进|暂不跟进}',
  },
  {
    id: 'risk_control',
    title: '金融风控 · 交易异常与风险等级',
    description: '评估交易异常程度、划分风险等级，判断是否需要人工复核。',
    aliases: ['fraud', '风控', '反欺诈'],
    questions: {
      anomaly: {
        type: 'score',
        label: '异常评分',
        instructions: '这笔交易的异常程度有多高？',
        criteria: ['完全正常', '轻微异常', '可疑', '高度可疑', '明确欺诈'],
      },
      risk_level: {
        type: 'choice',
        label: '风险等级',
        instructions: '这笔交易应归入哪个风险等级？',
        criteria: {
          low: '低风险',
          medium: '中风险',
          high: '高风险',
          critical: '极高风险',
        },
      },
      manual_review: {
        type: 'noul',
        label: '人工复核',
        instructions: '是否需要转人工复核？',
      },
    },
    recommendation: '交易异常评分 {anomaly}，风险等级「{risk_level}」。{manual_review?需转人工复核|可自动放行}',
  },
  {
    id: 'recruiting',
    title: '招聘 HR · 简历匹配与流程推进',
    description: '评估简历匹配度、判断是否进入下一轮，并给出岗位归属建议。',
    aliases: ['hr', 'resume', '招聘'],
    questions: {
      match: {
        type: 'score',
        label: '匹配度',
        instructions: '这份简历与岗位的匹配度有多高？',
        criteria: ['不匹配', '匹配度较低', '基本匹配', '匹配度较高', '高度匹配'],
      },
      next_round: {
        type: 'noul',
        label: '进入下一轮',
        instructions: '是否建议进入下一轮面试？',
      },
      position: {
        type: 'choice',
        label: '岗位归属',
        instructions: '这份简历更适合哪个岗位？',
        criteria: {
          backend: '后端工程师',
          frontend: '前端工程师',
          algorithm: '算法工程师',
          product: '产品经理',
          operation: '运营',
          talent_pool: '人才库储备',
        },
      },
    },
    recommendation: '简历匹配度 {match} 分，建议岗位「{position}」。{next_round?进入下一轮|本轮不通过}',
  },
  {
    id: 'data_governance',
    title: '数据治理 · 打标、归因与敏感识别',
    description: '自动打标文档、归因数据问题，并识别是否包含敏感数据。',
    aliases: ['governance', '数据标注', '数据治理'],
    questions: {
      tags: {
        type: 'choice',
        label: '文档标签',
        instructions: '这份文档应该打上哪个标签？',
        criteria: {
          contract: '合同与法务',
          finance: '财务与账单',
          product_doc: '产品文档',
          technical_doc: '技术文档',
          hr_doc: '人事文档',
          other: '其他',
        },
      },
      root_cause: {
        type: 'choice',
        label: '问题归因',
        instructions: '数据问题最可能的根因是什么？',
        criteria: {
          upstream_missing: '上游数据缺失',
          pipeline_bug: '采集/加工链路缺陷',
          schema_change: '模型或口径变更',
          business_change: '业务规则变更',
          unknown: '无法判断',
        },
      },
      sensitive: {
        type: 'noul',
        label: '敏感数据',
        instructions: '这份数据是否包含敏感信息（个人信息或商业机密）？',
      },
    },
    recommendation: '文档标签「{tags}」，问题归因「{root_cause}」。{sensitive?包含敏感数据，需脱敏处理|非敏感数据}',
  },
  {
    id: 'education',
    title: '教育内容 · 知识点、难度与合规',
    description: '归类题目知识点、评定难度等级，并预检内容合规性。',
    aliases: ['edu', '教学内容', '教育'],
    questions: {
      knowledge_point: {
        type: 'choice',
        label: '知识点',
        instructions: '这道题考查哪个知识点？',
        criteria: {
          algebra: '代数',
          geometry: '几何',
          probability: '概率统计',
          physics_mechanics: '力学',
          physics_electricity: '电学',
          chemistry: '化学',
          language: '语文/英语',
          other: '其他',
        },
      },
      difficulty: {
        type: 'score',
        label: '难度等级',
        instructions: '这道题的难度有多高？',
        criteria: ['入门', '基础', '中等', '较难', '竞赛级'],
      },
      compliance: {
        type: 'noul',
        label: '合规预检',
        instructions: '内容是否通过合规预检（无违规内容、无错误导向）？',
      },
    },
    recommendation: '知识点「{knowledge_point}」，难度 {difficulty}。{compliance?合规预检通过|存在合规风险，需人工复核}',
  },
  {
    id: 'requirements',
    title: '需求与变更 · 优先级、风险与派发',
    description: '评估需求优先级、变更风险等级，判断是否需要拆分并派发子任务。',
    aliases: ['requirement', '变更管理', '需求'],
    questions: {
      priority: {
        type: 'score',
        label: '优先级',
        instructions: '这个需求或变更的优先级有多高？',
        criteria: ['可延后', '低优先级', '中优先级', '高优先级', '最高优先级，需立即排期'],
      },
      change_risk: {
        type: 'choice',
        label: '变更风险',
        instructions: '这个变更的风险等级是什么？',
        criteria: {
          low: '低风险，可直接上线',
          medium: '中风险，需灰度验证',
          high: '高风险，需完整回归',
          critical: '极高风险，需专项评审',
        },
      },
      subtask_dispatch: {
        type: 'noul',
        label: '拆分派发',
        instructions: '是否需要拆分并派发子任务？',
      },
    },
    recommendation: '优先级 {priority}，变更风险「{change_risk}」。{subtask_dispatch?需拆分并派发子任务|无需拆分}',
  },
  {
    id: 'software_dev',
    title: '软件开发 · 任务类型、复杂度与处置',
    description: '判断编码请求属于缺陷修复、功能开发、重构、评审、测试、文档还是构建运维，评估复杂度并给出处置建议。',
    aliases: ['software', 'dev', 'coding', '开发', '编程', '编码', '研发'],
    questions: {
      task_type: {
        type: 'choice',
        label: '任务类型',
        instructions: '这个编码请求属于哪一类开发任务？',
        criteria: {
          bugfix: '修复缺陷或报错',
          feature: '新增功能或能力',
          refactor: '重构、整理或清理代码',
          review: '代码评审与质量检查',
          test: '编写或修复测试',
          docs: '文档、注释与说明',
          build: '构建、依赖、CI 与环境',
          perf: '性能优化',
          other: '其他开发任务',
        },
      },
      complexity: {
        type: 'score',
        label: '复杂度',
        instructions: '完成这个任务需要改动的范围有多大？',
        criteria: [
          '单点改动，一处即可完成',
          '局部改动，涉及少数几个文件',
          '跨模块改动，需要理解多处上下文',
          '系统性改动，影响架构或大量代码',
        ],
      },
      needs_context: {
        type: 'noul',
        label: '需先探查代码库',
        instructions: '动手前是否需要先检索代码库、阅读相关实现或运行验证？',
      },
    },
    derive: { effort: { question: 'complexity', values: ['S', 'M', 'L', 'XL'] } },
    recommendation: '任务类型「{task_type}」，改动规模 {effort}。{needs_context?建议先检索代码库并确认相关实现|可直接动手}',
  },
]

const VALID_TYPES = new Set(['choice', 'noul', 'score'])

/**
 * 校验一个场景定义。
 * @returns {string[]} 问题列表，空数组表示合法。
 */
export function validateScenario(spec) {
  const problems = []
  if (!spec || typeof spec !== 'object') return ['场景必须是对象']
  if (typeof spec.id !== 'string' || !spec.id.trim()) problems.push('缺少 id')
  if (typeof spec.title !== 'string' || !spec.title.trim()) problems.push('缺少 title')
  const questions = spec.questions
  if (!questions || typeof questions !== 'object' || Array.isArray(questions)) {
    problems.push('缺少 questions 对象')
    return problems
  }
  const ids = Object.keys(questions)
  if (ids.length === 0) problems.push('questions 至少需要 1 个问题')
  if (ids.length > 16) problems.push(`questions 最多 16 个（当前 ${ids.length} 个，延迟随问题数线性增长）`)
  for (const [qid, q] of Object.entries(questions)) {
    if (!q || typeof q !== 'object') {
      problems.push(`问题 ${qid} 必须是对象`)
      continue
    }
    if (!VALID_TYPES.has(q.type)) {
      problems.push(`问题 ${qid} 的 type 必须是 choice/noul/score`)
      continue
    }
    if (typeof q.instructions !== 'string' || !q.instructions.trim()) {
      problems.push(`问题 ${qid} 缺少 instructions`)
    }
    if (q.type === 'choice') {
      if (!q.criteria || typeof q.criteria !== 'object' || Array.isArray(q.criteria)) {
        problems.push(`问题 ${qid}（choice）的 criteria 必须是"选项 key → 说明"的对象`)
      } else if (Object.keys(q.criteria).length < 2) {
        problems.push(`问题 ${qid}（choice）至少需要 2 个选项`)
      } else if (Object.keys(q.criteria).length > 26) {
        problems.push(`问题 ${qid}（choice）选项建议不超过 26 个`)
      }
    }
    if (q.type === 'score' && (!Array.isArray(q.criteria) || q.criteria.length < 2)) {
      problems.push(`问题 ${qid}（score）的 criteria 必须是长度 ≥2 的分级标签数组`)
    }
  }
  return problems
}

/**
 * 从配置的 JSON 字符串加载自定义场景，并与内置场景合并。
 * 同 id 的自定义场景会覆盖内置场景；非法条目被跳过并记入 problems。
 *
 * @param {string} customJson - 自定义场景 JSON（数组）
 * @returns {{ scenarios: object[], problems: string[] }}
 */
export function resolveScenarios(customJson) {
  const scenarios = BUILTIN_SCENARIOS.map((s) => ({ ...s, source: 'builtin' }))
  const problems = []
  const raw = typeof customJson === 'string' ? customJson.trim() : ''
  if (!raw) return { scenarios, problems }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    problems.push(`自定义场景 JSON 解析失败：${messageOf(error)}`)
    return { scenarios, problems }
  }
  if (!Array.isArray(parsed)) {
    problems.push('自定义场景必须是 JSON 数组（[...]）')
    return { scenarios, problems }
  }

  const indexById = new Map(scenarios.map((s, i) => [s.id.toLowerCase(), i]))
  parsed.forEach((spec, i) => {
    const issues = validateScenario(spec)
    if (issues.length > 0) {
      problems.push(`自定义场景 #${i + 1} 已跳过：${issues.join('；')}`)
      return
    }
    const entry = normalizeScenario(spec)
    const key = entry.id.toLowerCase()
    if (indexById.has(key)) {
      scenarios[indexById.get(key)] = entry
    } else {
      indexById.set(key, scenarios.length)
      scenarios.push(entry)
    }
  })
  return { scenarios, problems }
}

/** 规范化场景定义，补齐可选字段。 */
function normalizeScenario(spec) {
  const questions = {}
  for (const [qid, q] of Object.entries(spec.questions)) {
    const question = {
      type: q.type,
      instructions: String(q.instructions ?? ''),
      label: typeof q.label === 'string' && q.label ? q.label : qid,
    }
    if (q.type === 'choice') {
      question.criteria = Object.fromEntries(
        Object.entries(q.criteria).map(([k, v]) => [String(k), String(v)]),
      )
    } else if (q.type === 'score') {
      question.criteria = q.criteria.map((v) => String(v))
    }
    questions[qid] = question
  }
  return {
    id: spec.id,
    title: spec.title,
    description: typeof spec.description === 'string' ? spec.description : '',
    aliases: Array.isArray(spec.aliases) ? spec.aliases.filter((a) => typeof a === 'string') : [],
    questions,
    derive: spec.derive && typeof spec.derive === 'object' ? spec.derive : {},
    recommendation: typeof spec.recommendation === 'string' ? spec.recommendation : '',
    minConfidence: Number.isFinite(Number(spec.minConfidence)) ? Number(spec.minConfidence) : undefined,
    source: 'custom',
  }
}

/**
 * 按 id 或别名查找场景（大小写不敏感）。
 * @returns {object | undefined}
 */
export function findScenario(scenarios, id) {
  if (typeof id !== 'string' || !id.trim()) return undefined
  const needle = id.trim().toLowerCase()
  return scenarios.find(
    (s) => s.id.toLowerCase() === needle || (s.aliases || []).some((a) => a.toLowerCase() === needle),
  )
}

function messageOf(err) {
  if (err !== null && typeof err === 'object' && typeof err.message === 'string') return err.message
  return String(err)
}
