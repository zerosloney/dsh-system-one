# SystemOne / 决策模型类 DSH 插件生态对照

> 调研时间：2026-10-05。数据来源为 GitHub 仓库 README / package.json / cordis.patch.yml 原文、npm registry 元数据，以及本机 `deepseek-harness` 检出的宿主源码。
> 本文档只做事实记录与对照，所有结论尽量给出 URL；属推断处标注【推断】。

---

## 0. 一句话结论

SystemOne（= 一次前向传播回答结构化问题、返回概率分布的决策模型）在 DSH 上**没有官方实现，全是社区第三方**；截至调研时点已有 **30+ 个**相关包。它们收敛出四种接入形态，而本项目 `@master0071/dsh-systemone` 属于其中最"重"的一种：**工具 + 服务 + 场景库 + 自动注入 + 图形配置页**五件套齐全，但生态位与工程规范上还有几处明显可对齐的空间（见第 6 节）。

---

## 1. 模型后端：wire 协议已经事实上统一

所有实现都打同一个端点、同一个 body：

```
POST {baseURL}/v1/systemone
{ "model": "...", "state": <string|object|array>, "questions": { <qid>: {...} } }
→ { "model": "...", "answers": { <qid>: { type, ... } }, "usage": {...} }
```

问题类型只有三种：`noul`（是/否概率）、`choice`（选项 + 全分布 + confidence）、`score`（有序分级 + 期望值 + 分布）。

| 后端 | 端点 | 默认模型 | 凭证 | 备注 |
| --- | --- | --- | --- | --- |
| 云知声 Unisound | `https://maas-api.unisound.com/v1` | `u2-decision` | `UNISOUND_API_KEY` | **本项目默认**；[文档](https://maas.unisound.com/docs/api/text/systemone) |
| TypeSafe Jev | `https://api.typesafe.ai/v1` | `jev-latest`（= `jev-1.13.0`） | `TYPESAFE_API_KEY` | 生态里最主流；$0.042/M input，输出免费 |
| 硅基流动 | `https://api.siliconflow.cn/v1` | `Kev-4b` | 硅基流动 key | 由 `dsh-auto-review-jev` 支持 |
| Laya（开源自部署） | 自建 `http://127.0.0.1:<port>/v1/systemone` | 自动路由 | 回环免 key | Apache-2.0 编码器，~30% 更便宜；只读前 512/1024 token |
| OpenRouter | `…/typesafe/v1/systemone` | `typesafe-ai/jev` | `AI_GATEWAY_API_KEY` | [jevcore](https://github.com/PerryLink/jevcore) 支持的第三条路 |

**对本项目的含义**：`provider: http` + `endpoint` 已经能覆盖上表任意一行，抽象方向是对的；生态里没有一个实现把厂商写死在工具层。

---

## 2. 四种接入形态（生态归类）

### 形态 A｜注册 agent 工具（模型主动调用）

最常见、门槛最低。代表作 [`dsh-jev-decide`](https://github.com/nanami-0713/dsh-jev-decide)（单文件、零构建）。

- 工具名各异：`jev_decide` / `jev_ask` / `jev` / `ws_request_verdict` / `systemone_scenario`（本项目）
- 单问题（`jev_decide`）vs 一次 state 混搭多问题（[`noetion/dsh-jev`](https://github.com/noetion/dsh-jev) 的 `jev_ask`、[`dsh-jev-verify`](https://www.npmjs.com/package/dsh-jev-verify) 的 `jev_decision` 最多 25 问并行）
- **触发政策**是生态里被反复讨论的真问题：[`kaijia323/dsh-plugin-jev`](https://github.com/kaijia323/dsh-plugin-jev) 把"何时该用"写成同一组 `POLICY` 常量，同时挂到 **A 面工具 description** 和 **B 面 `systemPrompt` 常驻 section**，避免"装了但没人告诉模型什么时候用"

### 形态 B｜暴露服务供其他插件编程调用（不注册工具）

代表作 [`exoticknight/dsh-system1`](https://github.com/exoticknight/dsh-system1)（Apache-2.0，TypeScript + zod 校验）。

- `export default class … extends Service`，`ctx.system1.decide({ state, questions, model, signal, timeoutMs })`
- 消费者 `inject: ['system1']` + `import type {} from 'dsh-system1'`（声明合并拿类型）
- **按问题返回结果**：`result.answers.topic.status === 'ok'`，单题失败不丢其他题；错误分 `unavailable / unsupported / limit_exceeded / timeout / cancelled / provider_error / invalid_response`
- **provider 是独立插件行**，可 `registerProvider('custom', backend)` 扩展，`describe()` + `evaluate()` 两个方法
- 每个 provider 自己声明能力上限（choice ≤255 项、score 2–10 档、64k 上下文）

> 本项目也注册了 `ctx.systemone` 服务（`lib/index.js:135` `super(ctx, 'systemone')`），但**没有类型化的 per-question 契约**：`decide()` 直接把上游原始响应透传（`lib/index.js:318-320`）。

### 形态 C｜挂宿主拦截点做"闸门"（最卷、也最危险）

把决策当成策略执行器，挂在 `tools/pre-execute` / `tools/post-execute` 上做 `allow / ask / deny` 或改写结果。**这是生态里增长最快、安全事故也最多的一类。**

| 项目 | 挂点 | 做什么 |
| --- | --- | --- |
| [`zhangxaochen/dsh-jev`](https://github.com/zhangxaochen/dsh-jev) | `tools/pre-execute`、`tools/post-execute`、`system-prompt/assemble` | 死循环判定、高危操作闸门、工具裁剪、技能路由、结果整形（6 个模块） |
| [`buberlo/dsh-jev`](https://github.com/buberlo/dsh-jev) | `agent/pre-step`、`tools/pre-execute`、`agent/request`、`ctx.skills` | 工具收窄、调用评估、模型路由。**已停止维护**（2026-10），作者推荐改用 `jevcore` |
| [`xlennart/dsh-auto-review-jev`](https://github.com/xlennart/dsh-auto-review-jev) | 审批缝 | 权限请求先由 systemone 裁决（一次调用并行问 `decision` + `risk` 两个 choice）；置信度 = `\|p(allow)−0.5\|×2` |
| [`7starsseeker/dsh-jev-guard`](https://www.npmjs.com/package/dsh-jev-guard) | `tools/pre-execute` | 破坏性命令四态：allow / revise / block / escalate |
| [`AskTheWay/dsh-jev-interceptor`](https://www.npmjs.com/package/dsh-jev-interceptor) | 工具调用 | 风险分级 + 证据门控自动批准，**fail-closed by construction** |
| [`@codebam/dsh-jev-guardrails`](https://github.com/codebam/dsh-jev-guardrails) | prompt / tool call / tool result / model response | 四道 guardrail |

**关键对照**：本项目的 `agent/pre-step`（`lib/auto.js`）只做**注入**，不做拦截——这与形态 C 有本质区别。生态里形态 C 的通行原则是 **fail-closed**（决策失败 = 不放行），而本项目自动决策是 **fail-open**（`README.md` 明确写"任何错误只记 warning，原样返回宿主决策"）。对"注入参考信息"这是对的；如果将来要做闸门，必须换策略。

### 形态 D｜度量 / 成本 / 观测层

[`RaulLazaro/dsh-jev-plugin`](https://github.com/RaulLazaro/dsh-jev-plugin) 是这方面最完整的参考：

- 每次调用（包括失败的）都追加到 JSONL ledger，Settings 卡片显示"今日 · N 次判断 · N input tokens · $X"
- `dailyCallLimit`（默认 500）/ `dailyTokenLimit`（默认 5M）**在花钱之前**拒绝调用，并告诉用户该调哪个设置
- 实测数据：单次判断平均 **11,377 input tokens**；比模型快 13×便宜 13.6×，比 subagent 快 105×便宜 ~120×
- 明确写了一条重要结论：**Jev 的概率是未标定的**（按置信度分档准确率 33% / 25% / 67% / 57%，0.85 和 0.96 置信度上都有错答）→ "可以排序，不能拿来跟固定阈值比"

> 本项目 `minConfidence`（默认 0.6）+ `needs_human_review`（`lib/tools.js`）走的是"拿阈值卡"的路线。生态里最严谨的那份测量说这条路有风险。**这条值得认真对待。**

---

## 3. 插件工程规范对照（本项目 vs 生态通行做法）

| 维度 | 本项目 | 生态通行做法 | 差异 |
| --- | --- | --- | --- |
| 插件形态 | `export default class extends Service` | 官方原文：函数形态 `apply` 在多数情况下够用；**只有要对外提供服务才用类** | 本项目确实对外提供 `ctx.systemone`，用类是对的 ✓ |
| `dsh.manifestVersion` | 缺 | `dsh-system1`、`zhangxaochen/dsh-jev` 都有 `1` | **建议补** |
| `dsh.compatibility` | 缺 | `dsh-system1` 声明 `{dsh: ">=0.1.7-rc.1 <0.2.0", profiles: ["headless","web"]}` | **建议补**；本项目大量依赖宿主内部事件名，版本区间声明是刚需 |
| `dsh.bundle.patch` | `"cordis.patch.yml"` | 两种都见，官方 publish.md 用 `"./cordis.patch.yml"` | 可对齐 |
| 工具注册 | 手写 JSON-Schema `parameters` + `output.render` + `presentCall`，经 `ctx.get('tools').register()` | `ctx.tools.register(defineTool({...}))`（`@deepseek-ai/dsh-tools`），`parameters` 是 spec 对象、由 `defineTool` 编译成 JSON Schema | **两种都合法**：宿主 `tools.register()` 的契约就是 JSON Schema 节点（`packages/core/tools/src/index.ts:1063`），本项目走的是更底层但受支持的路径；`defineTool` 多拿到自动推断 + 校验 |
| 客户端 bundle | `window.__ModuleLoader__.load({id, factory})` classic script + `ctx.slots.inject('plugins.row.config')` + `ctx.locale` | 宿主模块加载器的硬要求就是这样；`dsh.client.inject` **只是信息性声明**，不提供 `ctx.slots` | 本项目写法正确 ✓（`lib/client.js:19`、`lib/client.js:844`）。且本项目在 `dsh.client.inject` 里声明的两个包**确实各导出了 `./client`**（已核 `packages/client/ui-renderer/package.json` 与 `packages/client/locale/package.json`），因此 `orderByModuleGraph` 能把它解析成真实的"依赖先行"边（`packages/client/modules/src/index.ts:517-518` 的 `stripClientSuffix`），**这两个声明是有效的，不是死配置** |
| 热更新 | schemastery `.volatile()` + `unwrap()` 脱壳 | `dsh-system1` / `zhangxaochen/dsh-jev` / `RaulLazaro` 都用 volatile；宿主 [cookbook `adding-a-settings-card.md`](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/adding-a-settings-card.md) 就是这个模式 | 本项目更进一步（Proxy 活引用），是超配 ✓ |
| 凭证 | `config.apiKey` → `UNISOUND_API_KEY` / `SYSTEMONE_API_KEY` | `dsh-jev-decide`：config → env → `~/.dsh/.credentials.yaml` 的 `refs.*`；`RaulLazaro`：密钥只进 DSH credentials store，**永不写 settings.yaml**；`jevcore`：用 `apiKeyRef`（引用而非明文） | **本项目明文落 `cordis.patch.yml`**，生态里已有更好的做法 |
| 离线默认 | `provider: mock` 可选 | `jevcore` 默认就是 mock 且启动打印 egress 契约；`buberlo` 默认 `mock + shadow`；`zhangxaochen` 无 key 时降级 mock 并 warn | 本项目 mock 做得比多数人好（确定性、无需网络），但**默认是联网的 unisound** |
| 数据外发声明 | README 说明 `redact` 选项 | [`jevcore`](https://github.com/PerryLink/jevcore) 每次启动打印 `SENDS <feature> { fields }`；并明确承认"脱敏是缓解不是许可" | 本项目有 `redact` 但**没有可审计的外发声明** |
| 发布 | tag → GH Actions → `npm publish --provenance` + GitHub Release | `nanami`、`zhangxaochen`、`RaulLazaro` 都是 tag 触发 + OIDC trusted publishing（**免长期 npm token**） | 本项目用 `secrets.NPM_TOKEN`；OIDC 是更新做法 |
| 测试 | node:test，6 个测试文件；本仓库无宿主集成测试 | `zhangxaochen` 有 `verify:mutants`（变异扫描）、`verify:solo`（顺序无关）、bench fixture；`noetion` 有 mock transport + `verify-git-install` | `noetion` / `zhangxaochen` 都有**真跑一次 DSH** 的验证脚本，本项目**没有**——这是最值得补的一项（见第 6 节第 8 条） |

---

## 4. 生态里已经踩过的坑（本项目可直接借鉴）

1. **`duplicate loader entry id`**：[`dsh-jev-decide` README](https://github.com/nanami-0713/dsh-jev-decide) 明确警告——手写过 insert 行的 profile 再跑 `dsh plugin add`，两处注册同一 id 会让**整份 profile 起不来**。本项目 README 同时给了"手动 link + 改 bundles"和 Release 页的 `dsh plugin add`，两条路并存有同样的风险，建议明确二选一。
2. **宿主不把 `@deepseek-ai/dsh-tools` 注入插件的模块解析链**（同上）：用 `link:` 接入必须在插件目录先物化 peer。
3. **`desktop` profile 不能用 CLI 装**：`dsh plugin --profile desktop add …` → `error: profile "desktop" is managed exclusively by the Electron application`（[`zhangxaochen/dsh-jev`](https://github.com/zhangxaochen/dsh-jev) 实测）。本项目 README 的安装示例正好写的 `desktop`。
4. **patch 覆盖是整份 config 替换，不是字段级深合并**：只写一个字段会把该 row 其余配置全清掉（`kaijia323/dsh-plugin-jev` 实测）。
5. **`client.inject` 不定序、不提供 `ctx.slots`**：它只是包图信息（宿主 `packages/util/package-manifest/src/types.ts:81-93` 注释原文："Informational package-name dependencies, not Cordis service injection"）。真正要注入的服务必须由 client 模块自己 `export const inject`（本项目 `lib/client.js:844` 做对了）。
6. **生态安全审计结论**（`jevcore` README，2026-09-17~20）：三天内出现 19 个 Jev×DSH 插件，审计发现**名为 guard/gate 的模块同时也在把 prompt、工具参数、文件内容发给第三方，而 README 通常不说**；部分默认开启；**有一个闸门的配置能被它所守护的模型改掉**。→ 对本项目的直接提醒：`redact` 默认 `false`，而 `state` 会送到上游。

---

## 5. 竞争格局（谁能替代本项目）

| 场景 | 已有更强/更专的替代 |
| --- | --- |
| 只想给 agent 一个决策工具 | `dsh-jev-decide`（单文件零构建）、`noetion/dsh-jev`（带 skill + mock 传输测试） |
| 想给别的插件一个决策服务 | `dsh-system1`（类型化契约 + 多 provider 子路径 + 错误分类） |
| 想让决策真正改变 agent 行为 | `zhangxaochen/dsh-jev`（6 个模块挂在 4 个宿主拦截点）、`dsh-jev-guard`、`dsh-jev-interceptor` |
| 想控制成本 / 看账 | `RaulLazaro/dsh-jev-plugin`（ledger + 双日限 + 实测基准） |
| 想做安全默认 / 可审计外发 | `jevcore`（默认 mock、egress 契约、gate 默认关） |
| 想做业务场景库 | **本项目独有**——生态里没有第二家内置 11 个业务场景 + 场景 JSON 热更新 + `params` 覆盖问题定义 |

**本项目的差异化护城河**：① 场景库（业务语义层）；② 自动注入（把决策变成"每步都跑"而不是"模型记得调"）；③ 图形配置页 + volatile 热更新（改场景不用重启）。这三条在生态里都没被复制。

**本项目最脆弱的地方**：① 场景库绑定云知声 `u2-decision` 的默认假设，而生态默认站 TypeSafe Jev；② 没有成本/用量可观测性；③ fail-open 的自动决策 + 默认联网 + 明文 key，在安全审查上会被 `jevcore` 那套标准打低分；④ 依赖宿主内部事件名（`agent/pre-step`、`agent/inbox/inserted`、`agent/created`、`agent/disposed`）却未声明 `dsh.compatibility` 版本区间。

---

## 6. 可执行的改进清单（按性价比排序）

> **进度标记（2026-10-05 更新）**：✅ = 已完成，⬜ = 待办。缺陷类条目的详细状态见
> [dsh-systemone-defect-audit.md](./dsh-systemone-defect-audit.md)。

1. ✅ **补 `dsh.manifestVersion: 1` 与兼容区间** —— 已完成：加了 `manifestVersion: 1`，并用 **`peerDependencies` 声明 `@deepseek-ai/dsh`** 区间（`>=0.1.7-rc.1 <0.3.0`）。
   > **重要更正**：原清单建议写 `dsh.compatibility`，但宿主**不读那个字段**。`app-boot` 的 `evaluatePluginCompatibility` 只遍历 `peerDependencies` 里 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 的区间（prerelease 参与比较），不满足就把该行**禁用**。第一方插件用的就是标准 peer（`workspace:*` = "= 当前运行时"）。已实测：本机运行时 0.2.0-rc.2 通过，0.1.6-alpha.2 与 0.3.0 会被拒。
2. ✅ **README 安装段二选一** —— 已完成：分清"方式一 `dsh plugin add`（推荐）/ 方式二手写 profile"，写明两者只能选一（否则 `duplicate loader entry id` 会让整份 profile 起不来）、桌面端不能用 CLI 装、以及验证命令 `--dump-config` 下 `id: systemone` 必须恰好一行。
3. ✅ **凭证不进明文配置** —— 已完成：新增 `apiKeyRef`，从 `$DSH_HOME/.credentials.yaml` 的 `refs.<名字>` 读密钥，解析顺序 `apiKey 明文 → 环境变量 → 凭证缝`。自带解析器比同类实现更严谨：剥掉值两端引号、裁掉未加引号值的行内注释、只读 `refs:` 段内、多候选时按默认名顺序而非文件顺序。已接入配置页（含中英文案）。
4. ✅ **加一条可审计的外发声明** —— 已完成：装载时（以及 `provider` / `redact` 变化时，触发点在 `currentProvider()`——所有请求路径取提供商的必经点，stamp 去重）打印两行 `[egress]`：
   ```
   @master0071/dsh-systemone[egress]: ON → https://maas-api.unisound.com/v1/systemone
   @master0071/dsh-systemone[egress]: SENDS state(<=20000 字符，含对话历史与用户原文) + questions + model；redact=OFF — 手机号/身份证/邮箱/银行卡号 等敏感内容**原样外发**，建议在处理含隐私数据的内容时开启 redact
   ```
   `provider=mock` 时打印 `OFF — 不会发起任何网络请求` 且不报 SENDS；`redact` 开启时改为 `ON — ... 尽力而为：不在规则内的敏感串仍会外发`（**不把脱敏说成保证**）。`state` 预算按是否开自动决策动态计算（工具路径 16000，自动路径 `8000 + N×2000`）。相同状态不重复打印，避免每步刷日志。敏感类型清单从 `REDACT_RULES` 派生，不会与实现漂移。
5. ✅ **给自动决策加"护栏模式"** —— 已完成：新增 volatile 枚举 `autoFailMode: 'open' | 'closed'`（默认 `open`，行为与现状完全一致）。`closed` 档在决策管线真失败时让 `agent/pre-step` 返回宿主 `PreStepDecision` 的 `{ kind: 'reject' }`（已核 `dsh-agent/lib/types/runtime-types.d.ts:92` 的契约，宿主把本轮 turn 记为 `blocked`）。"真失败"的判定面：请求异常、超时、场景执行失败（`ok:false`）、自动路由无可用品；寒暄/低置信度/斜杠命令等"主动不注入"永远放行；仅 message 通道拦截（context 通道只注入参考，不 gate）。配置页与 README 已同步。
   > 日后若真做形态 C 闸门，直接沿用这个枚举，不要再往 `autoDecide` 布尔里塞第二套语义。
6. ✅ **成本可见性** —— 已完成（**只做可见性，未加日限**）：新增 `lib/usage.js` 台账 + `usageLogPath` 配置。每次上游调用追加一行 JSONL（含 `source: tool|auto-route`、`input_tokens`、`ok`、`latency_ms`），**自动路由那一次单独记、目标场景记 tool、不重复计数**；失败调用也记（上游可能已计费）；按本地日切分跨日归零；写盘失败降级为仅内存并只告警一次；两个路径的记账都套了 try/catch，**台账炸了也不会破坏 auto 的 fail-open**。今日用量在 `systemone_scenario(action:"list")` 的 `### 用量` 小节与 `usage_today` 字段里。
   > 日限判定（`lib/usage.js` 的 `check()`，超限时点名该改哪个字段）已实现并有测试，但**故意没接进执行路径**——在决策前主动拒绝属于行为变更，留给维护者决定。
7. ✅ **降低对阈值的依赖** —— 已完成：`needs_human_review` 的**主要判据改为概率分布平坦度**（`最大概率 / (1/选项数) < 1.5` 即视为在猜），绝对置信度 `minConfidence` 降为**次要**信号。平坦度是**不依赖标定**的性质，因此跨后端可比——这正是应对"这类概率未标定"的正确做法。另外输出新增 `review_reasons` 字段与摘要里的理由子项（不只给布尔值），`auto` 注入文本也带上理由。已删除改成死代码的旧实现路径。
8. ✅ **加"接缝探针"层** —— 已完成（最小可用版）：`scripts/probe-host.mjs`（`npm run probe`）在一次性临时 `DSH_HOME` 里走完 `npm pack` → `--from-default-profile headless` 建 profile → `dsh plugin add` 真装 → `--dump-config` 断言 `- id: systemone` 恰好 1 行；坑 1（duplicate loader entry id）与坑 4（整份替换）都能被它拦住。配套 `.github/workflows/probe.yml` 三档矩阵（`0.1.7-rc.1` 下限哨兵 / `0.2.0-rc.2` 当前基线 / `master` 预警档，`continue-on-error`）+ 每日定时 early-warning。已实测本机 0.2.0-rc.2 全绿。
   > **boot 档（真实 headless 启动）刻意没做**：实测发现它需要 `DEEPSEEK_API_KEY`（启动在插件激活之前就被 MISSING_CREDENTIAL 拦下），且插件激活日志不落在可观测的 stdout（进 zstd 压缩的 session 日志）——CI 无凭证、无可靠判据。留待有凭证的环境人工验证。多版本矩阵对"宿主内部事件名漂移"的防线价值主要在版本组合层，dump-config 已覆盖接缝的声明面。
9. ⬜ **发布改 OIDC trusted publishing**：去掉长期 `NPM_TOKEN`，与生态头部项目一致。
   > 2026-10-05 曾完成仓库侧改造（删 `NODE_AUTH_TOKEN` + 升级 npm 步骤），同日按维护者要求回退，`release.yml` 已恢复 `secrets.NPM_TOKEN` 方式；README「首次配置」同步还原。待办状态不变。
10. ✅ **修正 README 内部不一致** —— 已完成：架构图 10→11 内置、测试数改为实测值、26 上限措辞去掉"建议"、补"失败形态"与许可证段落。
11. ✅ **补 LICENSE 文件** —— 已完成：新增标准 MIT（`Copyright (c) 2026 master0071 <574635594@qq.com>`）并加入 `package.json` 的 `files`，随 tarball 发布。
12. ✅ **`check` 脚本去掉硬编码文件清单** —— 已完成：改为动态遍历 `lib/*.js`，新增文件自动纳入、语法错误退出码 1。
13. ✅ **修正 `ci.yml` 的依赖声明注释** —— 已完成：原注释笼统写"只把 `@deepseek-ai/*` 声明为 peer/可选依赖"，与实际不符（`schemastery` 是 `dependencies` + `peerDependencies` 双声明，`cordis` 是 peer 但非 optional）。已按实际声明逐条重写，并注明不提交 lockfile 的代价是构建不可复现。

---

## 7. 参考链接

**直接同类（DSH × SystemOne）**

- [exoticknight/dsh-system1](https://github.com/exoticknight/dsh-system1) — 类型化决策服务
- [zhangxaochen/dsh-jev](https://github.com/zhangxaochen/dsh-jev) — 插件套件（4 个宿主拦截点）
- [nanami-0713/dsh-jev-decide](https://github.com/nanami-0713/dsh-jev-decide) — 最小可用范本
- [RaulLazaro/dsh-jev-plugin](https://github.com/RaulLazaro/dsh-jev-plugin) — Settings 页 + ledger + 实测基准
- [noetion/dsh-jev](https://github.com/noetion/dsh-jev) — `jev_ask` + skill + mock 传输
- [kaijia323/dsh-plugin-jev](https://github.com/kaijia323/dsh-plugin-jev) — 触发政策 A/B 两面
- [PerryLink/jevcore](https://github.com/PerryLink/jevcore) — 安全默认 + egress 契约
- [buberlo/dsh-jev](https://github.com/buberlo/dsh-jev) — 已停维护，思路可读
- [xlennart/dsh-auto-review-jev](https://github.com/xlennart/dsh-auto-review-jev) — 审批审查器
- [luobosibing2/dsh-jev-plugin](https://github.com/luobosibing2/dsh-jev-plugin) — 12 功能全默认关

**宿主规范**

- [docs/user/develop/basic/index.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/index.md) · [tool.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/tool.md) · [config.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/config.md) · [publish.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)
- [docs/user/develop/framework/service.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/framework/service.md) · [events.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/framework/events.md)
- [docs/cookbook/adding-a-settings-card.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/adding-a-settings-card.md) · [docs/cordis-tutorial/05-config.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-tutorial/05-config.md)

**生态目录**

- [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) · [dsh.pub](https://dsh.pub/en/plugins/) · [dshmarket](https://github.com/dsh-market/dsh-market)
