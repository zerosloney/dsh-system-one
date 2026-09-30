# dsh-systemone

DeepSeek Harness 插件：把 **SystemOne 决策模型**（默认云知声 Unisound `u2-decision`，可切换提供商）接入 Agent 工作流。

SystemOne 协议一次请求携带业务状态与**结构化问题**（`choice` / `noul` / `score`），一次前向传播返回带概率分布的判断，没有自由文本幻觉，非常适合需要可解释、可复核的自动化决策。

> 文档：[SystemOne | 云知声 MaaS](https://maas.unisound.com/docs/api/text/systemone)

---

## 内置场景（9 大业务域）

每个场景 = 3 个结构化问题，覆盖 27 项业务能力。

| 场景 id | 业务域 | 覆盖能力 |
| --- | --- | --- |
| `customer_service` | 客服运营 | 工单派单与分流、升级 PO 判定、严重度评分 |
| `content_moderation` | 内容审核 | 违规与否判定、违规类型归类、放行/复审/拦截 |
| `agent_routing` | 智能体路由 | 意图识别分流、是否调用工具、是否转人工 |
| `sales_lead` | 销售线索 | 线索质量评分、线索分配、是否值得跟进 |
| `risk_control` | 金融风控 | 交易异常评分、风险等级划分、是否人工复核 |
| `recruiting` | 招聘 HR | 简历匹配度打分、是否进入下一轮、岗位归属 |
| `data_governance` | 数据治理 | 文档自动打标、数据问题归因、是否敏感数据 |
| `education` | 教育内容 | 题目知识点归类、难度分级评分、内容合规预检 |
| `requirements` | 需求与变更 | 优先级评分、变更风险评级、子任务派发 |

## 工具

插件只注册 2 个工具，控制工具 schema 的 token 开销，同时支持无限扩展场景。

### `systemone_scenario` — 统一场景调度

| action | 作用 |
| --- | --- |
| `list` | 列出全部场景（可用 `keyword` 过滤） |
| `describe` | 查看某场景的问题定义与可覆盖参数 |
| `run` | 执行决策，返回概率化答案 + 归一化决策 + 建议 |

```text
systemone_scenario(action: "run",
                   scenario: "customer_service",
                   state: "订单支付后超过 24 小时仍未到账，用户无法继续使用核心服务，要求立即处理。")
```

返回（摘要节选）：

```markdown
## 客服运营 · 工单派单与分流
- **决策服务**：unisound / u2-decision
- **受理部门**：支付、退款和账单问题（置信度 89.3%｜分布 billing=89.3% technical=10.7%）
- **严重程度**：核心功能不可用，没有替代方案 2.00（置信度 98.9%｜分布 2=98.9% ...）
- **立即升级**：是（96.0%）
- **建议**：转 支付、退款和账单问题 处理（优先级 P2）。需立即通知值班人员
- **建议复核**：无需人工复核
```

结构化字段：

```json
{
  "ok": true,
  "scenario": "customer_service",
  "decision": { "department": "billing", "severity": 2, "escalate": true },
  "labels": { "department": "支付、退款和账单问题", "severity": "核心功能不可用，没有替代方案", "escalate": "是" },
  "derived": { "priority": "P2" },
  "confidences": { "department": 0.893, "severity": 0.989 },
  "needs_human_review": false,
  "recommendation": "转 支付、退款和账单问题 处理（优先级 P2）。需立即通知值班人员"
}
```

**运行时覆盖问题定义**（`params`）：

```jsonc
{
  "action": "run",
  "scenario": "customer_service",
  "state": "...",
  "params": {
    // criteria 整体替换选项（choice 传对象，score 传标签数组）
    "department": { "criteria": { "vip": "VIP 专属通道", "billing": "账单与支付" } },
    // addCriteria 在现有选项上追加/覆盖单个 key，不丢默认项（仅 choice）
    "severity":   { "instructions": "这个问题对业务的严重程度有多高？" }
  }
}
```

### `systemone_decide` — 自定义问题

场景库里没有的临时判断，直接提交原始 `questions`：

```text
systemone_decide(
  state: "订单支付后超过 24 小时仍未到账",
  questions: {
    "department": { "type": "choice", "instructions": "哪个团队处理？", "criteria": { "billing": "账单", "technical": "技术" } },
    "severity":   { "type": "score",  "instructions": "多严重？",   "criteria": ["轻微", "部分", "核心不可用", "严重"] },
    "escalate":   { "type": "noul",   "instructions": "需要立即升级吗？" }
  }
)
```

## 特性

- **提供商无关**：所有工具只依赖统一的 `provider.decide()` 接口。切换厂商只改一行配置，业务工具零改动。
- **场景可扩展**：内置 9 大场景，并可在配置里用 JSON 追加或覆盖场景，**无需改代码**。
- **可自动决策**：开启后挂 `agent/pre-step`，每一步推理前自动捕获上下文并注入判断（fail-open、硬超时、可缓存）。
- **概率化输出**：返回每个选项的概率分布与置信度，而非单一答案。
- **置信度兜底**：任一答案置信度低于 `minConfidence`（默认 0.6）时标记 `needs_human_review: true`。
- **可编程调用**：注册 `ctx.systemone` 服务，其他插件可直接 `ctx.systemone.decide({ state, questions })`。
- **本地可测**：内置 `mock` 提供商，无需 API Key、无网络，输出确定。

---

## 架构

```
被动通道（模型主动调用）
┌────────────────────────  Agent（模型）  ────────────────────────┐
│                                                                │
│  systemone_scenario                     systemone_decide       │
│  （list / describe / run）              （自定义 questions）    │
└───────────────────────────┬────────────────────────────────────┘
                            │
主动通道（开启 autoDecide 后）
┌───────────────────────────┴────────────────────────────────────┐
│  agent/pre-step ◄─ auto.js                                     │
│    捕获 context ─→ 路由场景 ─→ 执行决策 ─→ 注入 runtime-context │
└───────────────────────────┬────────────────────────────────────┘
                            │
                   ┌────────▼─────────┐
                   │   场景库          │  scenarios.js
                   │  9 内置 + 配置自定义 │  （纯数据，可扩展）
                   └────────┬─────────┘
                            │ 统一 decide({ state, questions })
                   ┌────────▼─────────┐
                   │  provider 抽象层  │  ← 切换厂商只改这里
                   │ unisound│http│mock│
                   └──────────────────┘
                            │
                   POST /v1/systemone
```

## 安装

以本地 `link:` 依赖接入 profile（与 `dsh-plugin-admin` 等本地插件一致）：

```powershell
# 1. profile package.json 的 dependencies 中加入
"dsh-systemone": "link:E:/Demo/cli-tools/dsh-system-one"

# 2. dsh.profile.bundles 中加入 "dsh-systemone"

# 3. 在 profile 目录执行 pnpm install
cd C:\Users\Administrator\.dsh\profiles\desktop
node "D:\Program Files\Deepseek\resources\runtime\pnpm\bin\pnpm.cjs" install
```

新 bundle 需要刷新运行时模块解析，**首次安装后需重启 DeepSeek Harness 才能激活**。

## 自动决策（可选，默认关闭）

工具是**被动**的：只有模型主动调用才会执行。开启 `autoDecide` 后，插件会在**每一步推理前**自动捕获上下文、执行决策，并把结论注入当步上下文——无需模型记得调用工具。`autoInject: "message"`（默认）同一步生效且**同一决策只注入一次**；`autoInject: "context"` 走宿主动态上下文通道，不写入会话历史。

### 它是怎么挂上去的

关键顺序（摘自宿主 `@deepseek-ai/dsh-agent-loop` 的 `preStep`）：

```js
const claimed  = inbox.claim(target, position.turn)          // 本轮新进消息
const assembly = await systemPrompt.assemble(...)            // ① 先装配提示词
const context  = runtimeContext.project(...)                 // ② 渲染运行时上下文
const decision = await waterfall('agent/pre-step', {         // ③ 再跑瀑布
  messages: claimed, ... }, () => ({ kind: 'enter',
  messages: [...claimed, context] }))
```

因为**装配在 `pre-step` 之前**，`systemPrompt.context` 的 `text` 是同步求值的，而决策依赖异步 HTTP 调用；宿主在消息入箱后立即同步唤醒 driver，中间没有可等待异步结果的挂载点。因此：

- **`autoInject: "message"`（默认）**：在 `pre-step` 里替换 `messages`，**同一步生效**。宿主会把这些消息持久化到会话历史，本插件做了**内容去重**——同一决策只注入一次，不逐条累积。
- **`autoInject: "context"`**：在 `agent/inbox/inserted`（消息一入箱）就**异步预计算**决策并缓存，通过 `systemPrompt.context` 渲染进宿主动态上下文。不写历史；但第一步装配时决策通常尚未返回，从第二步（工具续步）起稳定可见。

```
用户消息到达
   │
   ├─ agent/inbox/inserted ◄── context 通道在这里预计算
   │     └─ 异步执行 SystemOne，结果写入 per-agent 缓存
   ├─ inbox.claim → 本轮新消息
   ├─ systemPrompt.assemble     ← 提示词装配（context 通道在这里读取缓存渲染）
   ├─ agent/pre-step ◄── message 通道在这里
   │     ├─ 捕获：本轮消息 + session.log 历史（排除自己注入的）
   │     ├─ 路由：固定场景，或用一次 choice 问句自动选场景
   │     ├─ 决策：执行目标场景（缓存命中则秒回）
   │     ├─ 去重：同一决策只注入一次
   │     └─ 注入：messages + 一条 runtime-context 消息
   └─ 模型推理（已带上决策结论）
```

注入的内容形如：

```
[SystemOne 自动决策 · 仅供参考，如有冲突以用户原始要求为准]
场景：金融风控 · 交易异常与风险等级（来源：自动路由，路由置信度 87.0%）
结论：异常评分=高度可疑；风险等级=高风险；人工复核=是
建议：交易异常评分 3，风险等级「高风险」。需转人工复核
注意：本次判断置信度偏低，请人工确认后再执行。
```

### 安全约束

自动决策会插入关键路径，因此每个环节都做了 fail-open：

| 约束 | 说明 |
| --- | --- |
| 默认关闭 | `autoDecide: false`，需显式开启 |
| 硬超时 | `autoTimeoutMs`（默认 8s）。既给上游传 `AbortSignal`，也用 Promise race 兜底——**即使提供商忽略 signal 也不会阻塞推理** |
| 失败放行 | 任何错误只记 warning，原样返回宿主决策 |
| 结果缓存 | 相同 state 命中 `autoCacheTtlMs`（默认 60s）缓存，不重复请求；并发相同 state 自动合并 |
| 注入去重 | `message` 通道对同一决策文本只注入一次，避免每步重复追加 |
| 精准触发 | 仅当本轮有新用户消息时触发；工具结果步骤不触发 |
| 跳过命令 | 以 `/` 开头的斜杠命令不触发 |
| 不进反馈环 | 从历史里排除自己注入的 `runtime-context` 消息 |

### 上下文捕获

`state` 由两部分拼成：

- **近期对话**：从 `agent.session.log` 倒序取最近 `autoMaxMessages`（默认 6）条 user/assistant 消息，单条截断 2000 字符；
- **当前请求**：本轮 `pre-step` 的新用户消息。

### 配置

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `autoDecide` | `false` | 是否开启自动决策 |
| `autoScenario` | 空 | 固定场景 id；留空则用一次 choice 问句**自动路由**（多一次请求） |
| `autoInject` | `message` | `message`=同一步生效并去重；`context`=宿主动态上下文通道（不写历史，入箱预计算，第一步通常来不及、第二步起稳定可见） |
| `autoTimeoutMs` | `8000` | 自动决策硬超时（毫秒） |
| `autoMaxMessages` | `6` | 捕获的历史消息条数 |
| `autoCacheTtlMs` | `60000` | 相同内容的结果缓存时长，`0` 表示不缓存 |
| `autoMinConfidence` | `0.6` | 自动决策的置信度阈值 |
| `autoRouteMinConfidence` | `0.35` | 自动路由的置信度门槛，低于该值宁可不注入 |
| `autoMinChars` | `4` | 低于该长度**且整体是寒暄**才跳过（`退款失败` 这类短请求不会被误伤） |

### 已知取舍与限制

| 项 | 说明 |
| --- | --- |
| **`message` 通道仍会写入会话历史** | `dsh-agent-loop` 对 `pre-step` 返回的 messages 执行无条件 `session.append('user/message', …, {surfaceOp:'append'})`。插件已做**内容去重**：同一决策文本只注入一次，把「每步一条」降为「每个不同决策一条」；但长对话中决策多次变化时仍会累积。需要绝对零历史写入时请用 `autoInject: "context"`。 |
| **`context` 通道第一步通常看不到结论** | `systemPrompt.context` 的 `text` 是同步求值，而决策是异步 HTTP 调用，第一步装配时通常尚未返回。插件在 `agent/inbox/inserted` 时预计算，因此**第二步起稳定可见**；单步问答（模型不调工具）时，结论会落到下一轮。 |
| **自动路由会多一次请求** | 场景数 >1 且 `autoScenario` 为空时，需先路由再决策。固定场景可省掉。 |
| **延迟直接叠加** | 自动决策在关键路径上同步等待，SystemOne 延迟会加到首字延迟。`autoTimeoutMs` 是硬上限，超时即放行。 |

建议：先用 `autoScenario` 固定场景省掉路由请求；把 `autoTimeoutMs` 设成你能接受的最大延迟；若只是想让模型"知道该用哪个场景"，用提示词引导即可，不必开自动决策。

## 配置

在 **设置 → 插件 → systemone** 中配置（均有默认值）：

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `provider` | `unisound` | `unisound`（官方）/ `http`（SystemOne 兼容端点）/ `mock`（本地模拟） |
| `apiKey` | 空 | Unisound API Key；也可用环境变量 `UNISOUND_API_KEY` / `SYSTEMONE_API_KEY` |
| `baseUrl` | `https://maas-api.unisound.com/v1` | Unisound API 基础地址 |
| `endpoint` | 空 | `provider=http` 时的完整请求端点；留空回退到 `baseUrl` |
| `model` | `u2-decision` | 决策模型名 |
| `timeoutMs` | `30000` | 请求超时 |
| `minConfidence` | `0.6` | 置信度阈值，低于则建议人工复核 |
| `customScenarios` | 空 | 自定义场景 JSON 数组（见下） |
| `auto*` | 见「自动决策」 | 自动捕获与注入，默认关闭 |

## 添加自定义场景

在配置的 `customScenarios` 里粘贴 JSON 数组即可，**无需改代码**。同 `id` 会覆盖内置场景，否则新增。

```json
[
  {
    "id": "legal_review",
    "title": "法务 · 合同风险预审",
    "description": "判断合同风险等级与是否需要法务介入。",
    "aliases": ["合同", "法务"],
    "questions": {
      "risk": {
        "type": "score",
        "label": "风险等级",
        "instructions": "这份合同的风险有多高？",
        "criteria": ["无风险", "低风险", "中风险", "高风险"]
      },
      "clause": {
        "type": "choice",
        "label": "问题条款",
        "instructions": "主要问题出在哪类条款？",
        "criteria": {
          "none": "无问题条款",
          "liability": "责任与赔偿条款",
          "payment": "付款与结算条款",
          "ip": "知识产权条款",
          "other": "其他"
        }
      },
      "lawyer": {
        "type": "noul",
        "label": "法务介入",
        "instructions": "是否需要法务介入？"
      }
    },
    "derive": { "level": { "question": "risk", "values": ["L1", "L2", "L3", "L4"] } },
    "recommendation": "风险等级 {risk}（{level}），问题条款「{clause}」。{lawyer?需法务介入|可业务自审}"
  }
]
```

### 场景字段说明

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | ✅ | 唯一标识 |
| `title` | ✅ | 展示名 |
| `description` | | 场景说明（`list` 时展示） |
| `aliases` | | 别名数组，便于按中文名/英文名查找 |
| `questions` | ✅ | 问题映射，最多 16 个（延迟随问题数线性增长） |
| `derive` | | 派生字段：`{ name: { question, values } }` 或 `{ name: { question, map } }` |
| `recommendation` | | 建议模板 |

### 问题类型

| type | 定义 | 模型返回 |
| --- | --- | --- |
| `choice` | `criteria` 为「选项 key → 说明」对象（建议 ≤26 项） | `choice` + `probabilities` + `confidence` |
| `noul` | 无 `criteria` | `noul`（0~1，≥0.5 视为是） |
| `score` | `criteria` 为分级标签数组 | `score`（期望值）+ `legend` + `probabilities` + `confidence` |

### 建议模板语法

| 语法 | 含义 |
| --- | --- |
| `{qid}` | 该问题的可读标签（choice=选项说明，score=分级说明，noul=是/否） |
| `{qid.key}` | 原始值（choice=选项 key，score=取整分值，noul=true/false） |
| `{qid.confidence}` | 置信度百分比 |
| `{derivedName}` | 派生字段 |
| `{qid?文案A\|文案B}` | 条件文案（noul 为真 / 分值 ≥1 / choice 非空非 `none` 时取 A；不支持嵌套） |

非法自定义场景会被**跳过并在日志中告警**，不影响内置场景使用。

## 切换提供商

插件与厂商解耦：只要目标服务实现相同协议（`POST {endpoint}`，请求体 `{ model, state, questions }`，响应 `{ answers: { [id]: { type, ... } } }`）即可切换。

- **换一家云厂商**：配置 `provider: "http"` + `endpoint` 指向该厂商或自建网关，`apiKey` 填对应凭证。
- **本地联调**：`provider: "mock"`，无需 Key，确定性输出。
- **编程扩展**：参考 `lib/provider.js`，实现 `{ name, decide() }` 后注册到 `createProvider()`。

## 开发与测试

```powershell
npm run check   # 语法检查
npm run test    # 59 项测试：
                # - 场景库完整性、9 大场景端到端、自定义场景合并/覆盖/非法跳过
                # - params 覆盖语义、确定性、失败路径（无网络、无 Key）
                # - 插件入口装配（临时桩实例化：工具注册、降级、卸载）
                # - 自动决策（开关、注入形状、fail-open、硬超时、缓存、去重、
                #   跳过规则、历史捕获、自动路由、卸载）
```

## 工具输出结构

```json
{
  "ok": true,
  "scenario": "risk_control",
  "provider": "unisound",
  "model": "u2-decision",
  "request_id": "4682848d-...",
  "latency_ms": 322,
  "answers": { "...": { "type": "...", "probabilities": {}, "confidence": 0.9 } },
  "decision": { "...": "归一化值（choice=key，score=取整分值，noul=boolean）" },
  "labels": { "...": "可读标签" },
  "derived": { "...": "派生字段" },
  "confidences": { "...": 0.9 },
  "needs_human_review": false,
  "recommendation": "建议文案",
  "summary": "## Markdown 摘要"
}
```

## 许可证

MIT
