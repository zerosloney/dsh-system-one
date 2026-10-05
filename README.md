# @master0071/dsh-systemone

[![CI](https://github.com/zerosloney/dsh-system-one/actions/workflows/ci.yml/badge.svg)](https://github.com/zerosloney/dsh-system-one/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@master0071/dsh-systemone)](https://www.npmjs.com/package/@master0071/dsh-systemone)

DeepSeek Harness 插件：把 **SystemOne 决策模型**（默认云知声 Unisound `u2-decision`，可切换提供商）接入 Agent 工作流。

SystemOne 协议一次请求携带业务状态与**结构化问题**（`choice` / `noul` / `score`），一次前向传播返回带概率分布的判断，没有自由文本幻觉，非常适合需要可解释、可复核的自动化决策。

> 文档：[SystemOne | 云知声 MaaS](https://maas.unisound.com/docs/api/text/systemone)

---

## 内置场景（11 大业务域）

每个场景 = 3 个结构化问题，覆盖 33 项业务能力。

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
| `software_dev` | **软件开发** | 任务类型（缺陷/功能/重构/评审/测试/文档/构建/性能）、改动复杂度、是否需先探查代码库 |
| `requirement_clarity` | **需求预检** | 需求明确度评分、最缺信息（目标/范围/验收/约束）、不澄清就推进的返工风险 |

### `software_dev`：给编码 Agent 用的软件开发场景

对编码 Agent 来说这是最常用的域。`systemone_scenario(action: "run", scenario: "software_dev")` 会返回三项判断：

| 问题 | 类型 | 取值 |
|---|---|---|
| `task_type` | choice | `bugfix` 缺陷修复 / `feature` 新增功能 / `refactor` 重构整理 / `review` 代码评审 / `test` 测试 / `docs` 文档注释 / `build` 构建依赖 CI 环境 / `perf` 性能优化 / `other` 其他 |
| `complexity` | score | 0~3：单点改动 → 局部改动 → 跨模块改动 → 系统性改动 |
| `needs_context` | noul | 动手前是否需要先检索代码库、读实现或跑验证 |

派生字段 `effort` 把复杂度映射为 `S / M / L / XL`，`recommendation` 直接给出一句处置建议，例如：

```
bugfix 任务（规模 M）。建议先检索代码库并确认相关实现
```

**典型用法**：把「固定场景」设为 `software_dev`，开启自动决策后，Agent 每一步推理前都会先判断「这是 bug 还是新功能、改动多大、要不要先翻代码」，并把结论注入上下文——用来驱动「先探查再动手」这类工作流非常合适。

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
- **图形配置页**：侧栏「插件 → @master0071/dsh-systemone → systemone」里可直接改提供商、Key、模型与自动决策参数，保存即生效（volatile 热更新，无需重启）。
- **场景可扩展**：内置 11 大场景（含软件开发与需求预检），并可在配置页里用 JSON 追加或覆盖场景，**无需改代码、无需重启**
- **可自动决策**：开启后挂 `agent/pre-step`，每一步推理前自动捕获上下文并注入判断（fail-open、硬超时、可缓存）。
- **概率化输出**：返回每个选项的概率分布与置信度，而非单一答案。
- **复核兜底（分布平坦度）**：`needs_human_review` 的**主要判据是概率分布是否平坦**——最大概率相对均匀分布不足 1.5 倍即视为"模型在猜"（不依赖标定，跨后端可比）。`minConfidence`（默认 0.6）保留为**次要**信号以兼容既有配置。判定理由放在 `review_reasons` 字段与摘要里，不只给一个布尔值（见「复核判定」）。
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
│    捕获 context ─→ 路由场景 ─→ 执行决策 ─→ 注入决策消息 │
└───────────────────────────┬────────────────────────────────────┘
                            │
                   ┌────────▼─────────┐
                   │   场景库          │  scenarios.js
                   │  11 内置 + 配置自定义 │  （纯数据，可扩展）
                   └────────┬─────────┘
                            │ 统一 decide({ state, questions })
                   ┌──────────────────┐
                   │  provider 抽象层  │  ← 切换厂商只改这里
                   │ unisound│http│mock│
                   └──────────────────┘
                            │
                   POST /v1/systemone

浏览器侧（配置界面）
┌────────────────────────────────────────────────────────────────┐
│  client.js ── 注册 plugins.row.config（键 @master0071/dsh-systemone#systemone）│
│    折叠卡片表单 ── form.mutate(ops) ──► profile cordis.patch.yml │
│    ▲                                                      │      │
│    └────── form.state（volatile 快照）◄── Loader 热更新 ◄──┘      │
└────────────────────────────────────────────────────────────────┘
```

## 安装

本包自带 bundle patch（`cordis.patch.yml`），所以 `dsh plugin add` 会顺带把插件行插进 profile。

> **⚠️ 两种方式只能选一种。** 手写过 `insert` 行的 profile 再跑 `dsh plugin add`，会出现**同 id 两行**（用户层一行 + bundle 层一行），启动时报 `duplicate loader entry id`，**整份 profile 起不来**。切换方式时必须先删掉旧的 `insert` 行。

### 方式一（推荐）：`dsh plugin add`

```powershell
# npm 包（发布版）
dsh plugin --profile <profile> add @master0071/dsh-systemone

# 或直接从 GitHub（仓库已提交构建产物 lib/，git 安装无需本地构建）
dsh plugin --profile <profile> add github:zerosloney/dsh-system-one

# 或本地目录（开发用；注意 host 不会把 @deepseek-ai/* 注入插件的模块解析链，
# 用 link: 接入时需先在插件目录跑一次 npm install 物化 peer）
dsh plugin --profile <profile> add D:/code/dsh-system-one
```

`dsh plugin` 本身没有子命令，它只是把参数转发给该 profile 目录里的 pnpm，所以 `add` / `remove` / `list` 都是 pnpm 的语义。

### 方式二：手写 profile 配置（等价，需自己维护）

```powershell
# 1. profile package.json 的 dependencies 中加入
"@master0071/dsh-systemone": "link:D:/code/dsh-system-one"

# 2. dsh.profile.bundles 中加入 "@master0071/dsh-systemone"

# 3. 在 profile 目录执行 pnpm install
cd C:\Users\<你>\.dsh\profiles\<profile>
node "C:\Users\<你>\AppData\Local\Programs\DeepSeek Harness\resources\runtime\pnpm\bin\pnpm.cjs" install
```

### 生效与验证

新 bundle 需要刷新运行时模块解析，**装完必须完全退出并重启 DeepSeek Harness**（只关窗口不算，要从托盘退出）。**桌面端 profile 不能用 CLI 安装**（`dsh plugin --profile desktop add …` 会被拒绝：`profile "desktop" is managed exclusively by the Electron application`），请改用应用内的插件入口。

验证装配结果——`id: systemone` 必须**恰好出现一行**：

```powershell
dsh --profile <profile> --dump-config | Select-String -Context 2,2 "systemone"
```

> 另一个常见坑：桌面端启动时才会构建模块解析表，之后再往 profile 里加 `link:` 包，配置树里能看到条目、但插件导入会失败（`Cannot find package '@deepseek-ai/cordis'`），表现为插件一直 `inactive`、工具不注册、配置页也不出现。重启即可解决。

### 兼容性

`peerDependencies` 声明了 `@deepseek-ai/dsh: ">=0.1.7-rc.1 <0.3.0"`。宿主在装载前会逐个校验 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 的 peer 区间（`app-boot` 的 `evaluatePluginCompatibility`，prerelease 参与比较），**不满足的行会被直接禁用**并提示 `dsh plugin allow-version` 的精确版本豁免途径。因此装到区间外的 DSH 上会在启动时明确拒绝，而不是运行到一半才崩。

> 注意：该机制**只认 `peerDependencies`**，不读 `dsh.compatibility` 之类的自定义字段——网上一些插件 README 里写的 `dsh.compatibility` 其实不会生效。

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
   │     └─ 注入：messages + 一条决策消息（source.kind = systemone-decision）
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
| 结果缓存 | 相同 state **且决策参数未变**时命中 `autoCacheTtlMs`（默认 60s）缓存，不重复请求；并发相同 state 自动合并。决策参数（固定场景 / provider / model / 两个置信度门槛）变化会使缓存立即失效 |
| 注入去重 | `message` 通道对同一决策文本只注入一次，避免每步重复追加 |
| 精准触发 | 仅当本轮有新用户消息时触发；工具结果步骤不触发 |
| 跳过命令 | 以 `/` 开头的斜杠命令不触发 |
| 不进反馈环 | 从历史里排除自己注入的 `systemone-decision` 消息 |

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
| `autoFailMode` | `open` | 自动决策失败语义：`open`=决策失败记 warning 放行（注入用途的正确默认）；`closed`=决策失败返回 reject、宿主把本轮记为 blocked（为将来做闸门预留的档位）。`closed` 只对**真失败**生效（请求异常/超时/场景执行失败/路由无可用品），寒暄、低置信度等"主动不注入"仍放行；仅 `message` 通道会拦截 |
| `autoTimeoutMs` | `8000` | 自动决策硬超时（毫秒） |
| `autoMaxMessages` | `6` | 捕获的历史消息条数 |
| `autoCacheTtlMs` | `60000` | 相同内容的结果缓存时长，`0` 表示不缓存。缓存键含决策参数，改场景/模型/门槛会立即失效 |
| `autoMinConfidence` | `0.6` | 自动决策的置信度阈值 |
| `autoRouteMinConfidence` | `0.35` | 自动路由的置信度门槛，低于该值宁可不注入 |
| `autoMinChars` | `4` | **寒暄判定的长度上界**：只有"短于此长度**且**整体是寒暄"才跳过。`退款`/`报错`/`闪退` 这类中文短请求是完整业务请求，会正常触发；设为 `0` 表示不做长度限制、只按寒暄名单判定 |

### 已知取舍与限制

| 项 | 说明 |
| --- | --- |
| **短输入现在会真的发请求** | `autoMinChars` 语义修正后（见上表），`退款`/`报错` 这类短业务请求不再被长度静默丢弃，因此**会产生上游调用、token 与延迟**。若你更在意成本、希望短输入一律不触发，把 `autoMinChars` 调大（例如 `8`）即可——它现在是"寒暄判定的长度上界"，调大等于要求更短的输入才算寒暄。 |
| **`message` 通道仍会写入会话历史** | `dsh-agent-loop` 对 `pre-step` 返回的 messages 执行无条件 `session.append('user/message', …, {surfaceOp:'append'})`。插件已做**内容去重**：同一决策文本只注入一次，把「每步一条」降为「每个不同决策一条」；但长对话中决策多次变化时仍会累积。需要绝对零历史写入时请用 `autoInject: "context"`。 |
| **注入消息用自己的 `source.kind`** | 注入消息标记为 `source.kind = "systemone-decision"`，**不复用宿主的 `runtime-context`**。宿主 `RuntimeContextProjection` 仅凭该 kind 认定"这是我自己写的快照"并维护去重状态，复用会让宿主每步多追加一条冗余的自身快照。副作用（正向）：读历史时现在会排除自己的决策消息、但**保留**宿主真实的动态上下文快照。 |
| **`context` 通道第一步通常看不到结论** | `systemPrompt.context` 的 `text` 是同步求值，而决策是异步 HTTP 调用，第一步装配时通常尚未返回。插件在 `agent/inbox/inserted` 时预计算，因此**第二步起稳定可见**；单步问答（模型不调工具）时，结论会落到下一轮。 |
| **自动路由会多一次请求** | 场景数 >1 且 `autoScenario` 为空时，需先路由再决策。固定场景可省掉。场景数超过 26 时自动拆成多道 choice 并行问出（每题仍在限制内），仍只是一次请求。 |
| **延迟直接叠加** | 自动决策在关键路径上同步等待，SystemOne 延迟会加到首字延迟。`autoTimeoutMs` 是硬上限，超时即放行。 |

建议：先用 `autoScenario` 固定场景省掉路由请求；把 `autoTimeoutMs` 设成你能接受的最大延迟；若只是想让模型"知道该用哪个场景"，用提示词引导即可，不必开自动决策。

## 配置

插件带**图形配置页**：在 DSH 侧栏打开 **插件 → @master0071/dsh-systemone**，点开 `systemone` 这一行，即可编辑下面的「热更新字段」。保存写入 profile 的 `cordis.patch.yml`，经 Loader 热更新后**立即生效，无需重启**（底层是 schemastery 的 volatile 字段 + 插件的按次读取）。

两个配置入口的分工：

| 入口 | 能改什么 | 生效时机 |
| --- | --- | --- |
| 插件页（图形表单） | 下表标注「热更新」的字段 | 保存即生效 |
| profile 的 `cordis.patch.yml` | 全部字段（含结构性字段） | 按 profile 的 HMR 设置，或重启 |

```yaml
# C:\Users\<你>\.dsh\profiles\desktop\cordis.patch.yml
- id: systemone
  name: @master0071/dsh-systemone
  config:
    provider: unisound        # unisound / http / mock
    apiKeyRef: ''             # 推荐：从 .credentials.yaml 的 refs.<名字> 取密钥，配置里只留名字
    apiKey: ''                # 明文备用；留空则读环境变量 UNISOUND_API_KEY / SYSTEMONE_API_KEY
    model: u2-decision
    customScenarios: ''       # 热更新：保存后场景库立即重建
    autoDecide: false         # 结构性：需要重启
```

| 配置项 | 默认值 | 生效 | 说明 |
| --- | --- | --- | --- |
| `provider` | `unisound` | 热更新 | `unisound`（官方）/ `http`（SystemOne 兼容端点）/ `mock`（本地模拟） |
| `apiKeyRef` | 空 | 热更新 | **推荐的凭证方式**：从 `$DSH_HOME/.credentials.yaml` 的 `refs.<名字>` 读密钥，配置文件里只留这个名字。留空时依次尝试 `SYSTEMONE_API_KEY` → `UNISOUND_API_KEY` → `TYPESAFE_API_KEY` |
| `apiKey` | 空 | 热更新 | 明文密钥（备用）。声明为 secret，**已保存的值不会回显到界面**，但仍以明文落在 profile 的 `cordis.patch.yml` 里——不想落明文就用 `apiKeyRef` 或环境变量 |
| `baseUrl` | `https://maas-api.unisound.com/v1` | 热更新 | Unisound API 基础地址 |
| `endpoint` | 空 | 热更新 | `provider=http` 时的完整请求端点；留空回退到 `baseUrl` |
| `model` | `u2-decision` | 热更新 | 决策模型名 |
| `timeoutMs` | `30000` | 热更新 | 请求超时（毫秒） |
| `minConfidence` | `0.6` | 热更新 | **次要**复核信号：置信度低于该值时也标记需复核。主要判据是分布平坦度，见「复核判定」 |
| `redact` | `false` | 热更新 | 发送前对 `state` 脱敏：手机号/身份证/邮箱/银行卡号替换为 `[手机号]` 等类型标签（判断语义保留；处理含隐私数据的内容时建议开启） |
| `customScenarios` | 空 | 热更新 | 自定义场景 JSON 数组（见下）。保存后**场景库立即重建**，无需重启 |
| `autoDecide` | `false` | 需重启 | 是否开启自动决策（挂载 `agent/pre-step`） |
| `auto*` | 见「自动决策」 | 热更新 | 自动决策的运行参数（钩子挂载后实时生效） |
| `usageLogPath` | 空 | 热更新 | 用量台账文件路径；留空则用 `$DSH_HOME/dsh-systemone/usage.jsonl` |

> 为什么 `autoDecide` 需要重启：它决定「要不要挂钩子」，属于装配期决定。其余字段每次请求/每次事件都会重新读取，所以可以热更新。

### 用量台账（花了多少）

SystemOne 是**按量计费**的，而自动决策会随会话持续推进——所以每次上游调用（含自动路由那一次、以及**失败但可能已计费**的调用）都会追加一行 JSONL：

```
$DSH_HOME/dsh-systemone/usage.jsonl
{"ts":1759...,"day":"2026-10-05","source":"auto-route","model":"u2-decision","ok":true,"input_tokens":1200,"latency_ms":322}
{"ts":1759...,"day":"2026-10-05","source":"tool","scenario":"customer_service","ok":true,"input_tokens":980,"latency_ms":310}
```

- `source` 区分 `tool`（模型主动调用工具）与 `auto-route`（自动决策的路由请求）；目标场景的那次决策也记 `tool`，**不会重复计数**。
- 计数按**本地日**切分，跨日自动归零，不需要定时任务。
- 台账写盘失败会**降级为仅内存统计**并只告警一次——记账失败绝不让决策失败。

查看今日用量：`systemone_scenario(action: "list")` 的 `### 用量` 小节与 `usage_today` 字段，例如 `今日：7 次判断 · 12.3k input tokens（2026-10-05），其中失败 1 次`。

> 台账只做**可见性**，不设上限。要加日限时有现成的判定函数（`lib/usage.js` 的 `check()`，超限时点名该改哪个字段），接进 `executeDecision` 发请求前即可。

### 复核判定（`needs_human_review`）

`needs_human_review` 判的是「这个结论能不能直接拿去自动执行」，判据分两类：

| 判据 | 内容 | 为什么 |
| --- | --- | --- |
| **分布平坦**（主要） | 最大概率 / (1/选项数) < **1.5** 即视为模型在猜 | **不依赖标定**。各家后端算 confidence 的公式不同（TypeSafe 与 Laya 就不一样），把某个后端的经验阈值当通用标准会误伤；而"最大概率有没有明显高出均匀分布"是概率分布自身的性质，跨后端可比 |
| 绝对置信度（次要） | 任一答案 `confidence < minConfidence`（默认 0.6） | 保留以兼容既有配置。文献实测这类概率**未标定**，所以只当辅助信号 |

`1.5` 的含义：二选一题对应 p≈0.75，三选一题对应 p≈0.5——比掷硬币强，但不足以据此自动执行。

输出里不只给布尔值，还给出**理由**（`review_reasons` 字段 + 摘要里的缩进子项），例如：

```
- **建议复核**：需要人工复核
  - department：choice 的分布接近均匀（最大概率仅均匀分布的 1.35 倍）
```

另有两类确定性判据：`choice` 返回 `uncertain`/`unknown`/空值，以及 `noul` 落在 0.45~0.55 的摇摆区间。

> 调严/调松：平坦度阈值是 `lib/format.js` 的 `FLATNESS_RATIO`；绝对阈值是配置项 `minConfidence`（设为 0 可让它完全不参与判定，只按分布平坦度走）。

### 凭证怎么放（推荐用凭证缝）

密钥解析顺序：**`apiKey` 明文 → 环境变量 → 凭证缝 `refs.<apiKeyRef>`**，第一个非空者生效。

```yaml
# C:\Users\<你>\.dsh\.credentials.yaml
refs:
  SYSTEMONE_API_KEY: sk-你的密钥
```

配置里只留引用名（`apiKeyRef: SYSTEMONE_API_KEY`，或留空走默认名），`cordis.patch.yml` 里就不出现明文。三点注意：

- **值两端的引号会被自动剥掉**（`"sk-x"` 与 `sk-x` 等价），未加引号的值允许行内 ` # 注释`；
- 只读取 `refs:` 段内的键，段外的同名键不会被误取；
- 环境变量优先级高于凭证缝，所以 export 过 `UNISOUND_API_KEY` 时它会盖掉凭证文件里的同名项。

## 添加自定义场景

**推荐用图形配置页**：插件 → @master0071/dsh-systemone → systemone → 「自定义场景」卡片，粘贴 JSON 即可。编辑框会实时校验（JSON 语法、`id`/`title`/`questions`、问题类型与选项数量），不通过时保存按钮禁用并给出具体原因；保存后场景库立即重建，新场景的 id 也会自动出现在「固定场景」的候选列表里。

卡片右上角的**「插入意图识别模板」**会填入下面这个通用意图识别场景，改 `criteria` 即可用。

也可以在 profile 的 `cordis.patch.yml` 里配置 `customScenarios`（同样的 JSON 字符串）。同 `id` 会覆盖内置场景，否则新增。

覆盖与别名的解析规则：

- **patch 式覆盖**：默认同 `id` 是**整体替换**。只想改一两个字段时，给条目加 `"patch": true` 即可做**字段级合并**——`title`/`description`/`recommendation` 给了才覆盖；`questions` 按 qid 合并（只换给出的字段，如只覆盖某个问题的 `criteria`，其余问题原样保留，新 qid 追加）；`derive` 同名覆盖；`aliases` 求并集。例如给 `customer_service` 的部门问题加一个 VIP 通道：

  ```json
  [{ "id": "customer_service", "patch": true,
     "questions": { "department": { "criteria": { "vip": "VIP 专属通道", "billing": "账单", "technical": "技术", "account": "账号", "logistics": "物流", "other": "其他" } } } }]
  ```

  patch 目标不存在、或合并结果非法（如 choice 选项少于 2 个）时该条目会被跳过并记入日志。不带 `patch` 的条目维持整体替换语义，已有配置不受影响。
- **同 `id` 覆盖**：自定义场景替换同名内置场景，只写 `title`/`questions` 也够——被替换场景原有的 `aliases` 会被**继承**（省略 `aliases` 不等于清空别名），新声明的别名与继承的别名共存且自动去重。
- **别名冲突**：别名与 `id` 平权参与查找，冲突时**后登记者获胜**（自定义场景优先于内置场景，自定义之间后声明者优先）。因此自定义场景声明的别名一定指向它自己，不会被内置场景抢走。
- **冲突提示**：别名撞名是**非致命**的——场景照常可用，但插件会给出提示（宿主日志里带「（提示）」前缀，`systemone_scenario(action: "list")` 的 `warnings` 字段与「配置提示」小节里也会列出），说明谁遮蔽了谁，避免调用方把「别名被占」误判成「场景不存在」。
- **查找大小写不敏感**，`findScenario` 同时匹配 `id` 与 `aliases`。

### 用自定义场景做通用意图识别

SystemOne 是「结构化问题 → 概率分布」的决策模型，**不是开放式意图分类器**：它的标签空间就是你声明的 `criteria`。所以要「通用意图识别」，就自己定义一个意图场景，把标签集写进去，再把「固定场景」指向它：

```json
[
  {
    "id": "intent",
    "title": "通用意图识别",
    "description": "把任意输入归类到业务意图。",
    "aliases": ["意图", "intent"],
    "questions": {
      "intent": {
        "type": "choice",
        "label": "意图",
        "instructions": "用户这句话最想做什么？",
        "criteria": {
          "query": "查询/检索信息",
          "action": "执行一个操作",
          "create": "新建内容或文件",
          "modify": "修改已有内容",
          "analyze": "分析、对比、总结",
          "explain": "解释原理或概念",
          "debug": "排查报错或异常",
          "chat": "闲聊、寒暄",
          "other": "以上都不是"
        }
      },
      "urgency": {
        "type": "score",
        "label": "紧急度",
        "instructions": "这件事有多紧急？",
        "criteria": ["不急", "可以等", "尽快", "马上"]
      }
    },
    "derive": { "level": { "question": "urgency", "values": ["P4", "P3", "P2", "P1"] } },
    "recommendation": "意图「{intent}」，紧急度 {level}"
  }
]
```

配合 `autoScenario: "intent"`，自动决策就不再受内置 11 个业务场景的约束。

**容量上限**：每个场景最多 **16 个问题**（延迟随问题数线性增长），`choice` 的选项 **2~26 个**，所以意图标签集实践上限约 26 类——超了只能合并或落到 `other`。

> 如果连固定标签集都不够用（想要开放标签、自由文本意图），那超出了这个模型的形态，得换真正的分类器或 LLM 自由文本方案。

### 另一个例子里

下面是一个业务场景的完整写法（法务合同风险预审）：

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
| `id` | ✅ | 唯一标识；首尾空白会被自动 trim |
| `title` | ✅ | 展示名 |
| `description` | | 场景说明（`list` 时展示） |
| `aliases` | | 别名数组，便于按中文名/英文名查找；与 `id` 平权，冲突时自定义场景优先于内置场景。首尾空白自动 trim，空串/纯空白项会被丢弃 |
| `questions` | ✅ | 问题映射，最多 16 个（延迟随问题数线性增长）。问题 id 不能是 `__proto__` / `constructor` / `prototype` |
| `derive` | | 派生字段：`{ name: { question, values } }` 或 `{ name: { question, map } }` |
| `recommendation` | | 建议模板 |

### 问题类型

| type | 定义 | 模型返回 |
| --- | --- | --- |
| `choice` | `criteria` 为「选项 key → 说明」对象（**最多 26 个，硬限制**；超过该场景会被跳过） | `choice` + `probabilities` + `confidence` |
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
npm run check   # 9 个 lib/*.js 语法检查通过
npm run test    # 179 项测试：
                # - 场景库完整性、11 大场景端到端（有断言强制 sample 覆盖全部内置场景）、
                #   自定义场景合并/覆盖/patch/非法跳过
                # - params 覆盖语义、确定性、失败路径（无网络、无 Key）
                # - 插件入口装配（临时桩实例化：工具注册、降级、卸载）
                # - 自动决策（开关、注入形状与自有 source.kind、fail-open、硬超时、
                #   缓存与"改配置即失效"、去重、跳过规则、历史捕获、自动路由、卸载）
```

## 发布（CI / CD）

仓库用 GitHub Actions 做持续集成与发布，两个工作流：

| 工作流 | 触发 | 做什么 |
|---|---|---|
| [`ci.yml`](.github/workflows/ci.yml) | push / PR 到 `master`、`main`，或手动 | Node **22.19 / 24** 双版本跑 `npm run check` + `npm test`，再跑一次 `npm pack --dry-run` 确认产物完整 |
| [`release.yml`](.github/workflows/release.yml) | push `v*` tag，或手动（默认演练） | 校验 tag ↔ 版本 → 校验 npm 上未重名 → 测试 → `npm publish --provenance` → 创建 GitHub Release |
| [`probe.yml`](.github/workflows/probe.yml) | push / PR、每日定时、或手动 | **接缝探针**：对着三档真实宿主（peer 区间下限哨兵 / 当前基线 / master 预警档）跑 `npm run probe`，在隔离的临时 profile 里真装一次本包并断言组合后的 `id: systemone` 恰好一行；master 档只告警不挡合并 |

### 发一个版本

```powershell
# 1) 先升版本（semver：patch / minor / major）
npm version patch          # 0.4.0 → 0.4.1，会自动打 v0.4.1 tag 并提交

# 2) 推送提交和 tag
git push && git push --tags
```

推送 tag 后 `release.yml` 自动接管。发布前两道闸会拦住常见事故：

1. **tag 必须与 `package.json` 的 `version` 完全一致**（例如 `v0.4.1` ↔ `0.4.1`），否则打错 tag 会静默发错版本；
2. **该版本在 npm 上必须不存在**，防止覆盖已发布的版本。

### 首次配置需要的密钥

`Settings → Secrets and variables → Actions → New repository secret`：

- `NPM_TOKEN` —— npm 的 **Automation** 类型 token（[npmjs.com → Access Tokens](https://www.npmjs.com/settings/~/tokens) 生成，勾选 `Automation` 以绕过 2FA）。

发布用的是 `npm publish --provenance`，会带上 npm 的来源证明（Sigstore），因此工作流额外申请了 `id-token: write` 权限——**不需要**额外配置，但需要包在 npm 上与该 GitHub 仓库关联。

### 本地演练

不想真发时，可以在 GitHub 上手动触发 `Release` 工作流，**`dry_run` 输入默认勾选**，只跑校验与 `npm publish --dry-run`。

```powershell
npm run check && npm test && npm pack --dry-run   # 本地等价演练
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

**失败形态**：`ok: false` + `error` + 人可读 `summary`。除了上游报错，还有一种**空决策**也会走失败路径：上游没有任何一个问题产出可用判断（`answers` 为空、`type` 无法识别、或答案缺关键字段）时，插件返回 `ok: false` 且 `needs_human_review: true`，并在 `error` 里点名是哪些问题无法判断。这样调用方不会把一个空判断当成"已完成"。

## 许可证

MIT

本项目采用 MIT 许可证，全文见仓库根目录的 [LICENSE](LICENSE)。




