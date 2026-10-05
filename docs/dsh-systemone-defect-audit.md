# dsh-systemone v0.5.0 缺陷复核报告

> 复核时间：2026-10-05，工作树 `8974095`（v0.5.0）。
> 本文档只记录**已在本机复核确认**的问题，每条给出代码坐标与复核方式。未经复核的猜测不列入。
> **复核时的基线**（下列问题全部无法被当时的测试发现）：`node --test` **122/122** 通过、`npm run check` 通过。
> 修复后的当前状态见下方「验证结果」。

---

## 修复进度（2026-10-05 更新）

| 编号 | 状态 | 说明 |
| --- | --- | --- |
| P0-1 source kind 冲突 | ✅ **已修复** | `lib/auto.js` 新增 `INJECTED_SOURCE = 'systemone-decision'`，写入与自我排除同步改；测试断言"不等于 runtime-context"且宿主 kind 仍保留在历史里 |
| P0-2 缓存 key 不含配置 | ✅ **已修复** | 新增 `decisionFingerprint()`，key = `hashString(state + \u0000 + 指纹)`；指纹含 `autoScenario / provider.name / model / autoMinConfidence / autoRouteMinConfidence / 场景库指纹` |
| P0-3 路由超 26 选项 | ✅ **已修复** | 新增 `chunkScenarios()`，按 `MAX_CHOICE_OPTIONS`（26）分批成多道 choice，仍只发一次请求；跨组取最高置信度。路由题 id 改用 `systemone_route__N` 前缀（原 `scenario_N` 会与场景 id/问题 id 相撞） |
| P1-4 短输入语义与文档相反 | ✅ **已修复（改实现，非改文档）** | 采用了"改实现"方案：`isTrivialInput` 从**或**改为**且**——只有"短于 `autoMinChars` **且**整体是寒暄"才跳过。原实现的**或**语义在中文里会静默误杀完整请求：`退款`/`报错`/`超时`/`闪退`/`卡了` 都只有 2 个字，却都是真实业务请求，结果是"开了自动决策却什么都不发生、且无任何日志"。`autoMinChars` 的含义从"长度下限"变为**寒暄判定的长度上界**。代价：短业务请求现在会真的产生上游调用（README 已补"已知取舍"说明）。 |
| P1-5 漏 `software_dev` 端到端 | ✅ **已修复** | 补齐 sample，并新增断言强制 sample 集合 == `BUILTIN_SCENARIOS` id 集合（防未来再漂移） |
| P1-6 静默空成功 | ✅ **已修复** | `executeDecision` 增加空决策守卫，**覆盖两种形态**：(a) 无 answers / type 全不可识别；(b) 有 answers 但关键字段缺失导致 `decision[qid] === null`。命中时返回 `ok:false` + `needs_human_review:true` + 点名哪些问题无法判断 |
| P2-7 `autoInject` 无枚举校验 | ✅ **已修复** | `z.union(['message','context']).default('message')`；非法值在加载期报错。入口测试用带 `schemaKind` 的桩断言它确实是 union |
| P2-8a 无 LICENSE | ✅ **已修复** | 新增 `LICENSE`（标准 MIT，`Copyright (c) 2026 master0071 <574635594@qq.com>`），并加入 `package.json` 的 `files` |
| P2-8b `check` 硬编码文件清单 | ✅ **已修复** | 改为读 `lib/*.js` 动态遍历；已验证新增文件会被自动纳入、语法错误会退出码 1 |
| P2-8c 文档小项 | ✅ **已修复** | 测试数、架构图 10→11、26 上限措辞、CI 描述；README 另补"失败形态"与许可证段落 |

**同一轮内追加的能力改进**（源自生态对照，非缺陷；详见 [dsh-systemone-ecosystem.md](./dsh-systemone-ecosystem.md) 第 6 节）

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 兼容性声明 | ✅ | `dsh.manifestVersion: 1` + `peerDependencies['@deepseek-ai/dsh'] = ">=0.1.7-rc.1 <0.3.0"`。**注意：宿主只读 `peerDependencies`，不读 `dsh.compatibility`** |
| README 安装二选一 | ✅ | 分清 `dsh plugin add` 与手写 profile，警示 `duplicate loader entry id` |
| 凭证不进明文 | ✅ | 新增 `apiKeyRef` → 读 `$DSH_HOME/.credentials.yaml` 的 `refs.<名字>`；解析器比同类更严谨（剥引号、裁注释、限 `refs:` 段内、按默认名优先级） |
| 用量台账 | ✅ | 新增 `lib/usage.js`；每次调用一行 JSONL（`tool` / `auto-route`，不重复计数），今日用量在 `action=list` 输出 |
| 外发声明 | ✅ | 装载时与 `provider`/`redact` 变化时打印 `[egress] ON/OFF` + `SENDS ...`；`redact=OFF` 时明确列出会原样外发的敏感类型 |
| 复核判定改平坦度 | ⚠️ **语义变更** | `needs_human_review` 主判据改为 `最大概率 / (1/选项数) < 1.5`（不依赖标定），`minConfidence` 降为次要信号；新增 `review_reasons` 输出理由 |

**验证结果（当前）**

- `npm run check`：全部 `lib/*.js` 通过（动态枚举，含新增文件检测与语法错误检测）
- `npm test`：全绿（起点为本文档复核时的 122 项；此后历次新增累计 +53）
- `npm pack --dry-run`：产物含 `LICENSE` 与 `lib/usage.js`

> **本文档不重复维护具体条数**——README 的「开发与测试」一节是数字的唯一声明位点，
> 且由 `npm run verify:docs`（CI 中为 *Verify documented numbers* 步骤）校验其与实际一致。
> 此处只记录**相对起点**的增量，避免同一数字在多处漂移（这正是 P2-8 那类问题的成因）。

**变异测试**：逐个把修复回退，确认新测试真的会失败——

| 回退的修复 | 测试结果 |
| --- | --- |
| `INJECTED_SOURCE` 改回 `'runtime-context'` | ✖ kind 测试失败 |
| key 改回 `hashString(String(state))` | ✖ 2 个缓存测试失败（pass 124 / fail 2） |
| 空决策守卫 `if (usable.length === 0)` → `if (false)` | ✖ 3 个空决策守卫测试失败（pass 132 / fail 3） |
| `MAX_CHOICE_OPTIONS` 26 → 9999 | ✖ 分批路由测试失败（fail 1） |
| `autoInject` union → string | ✖ 枚举测试失败（fail 1） |
| 指纹里去掉 `scenariosRef` | ✖ 场景库失效测试失败（fail 1） |
| 两个路径的 `usage.record` 调用失效 | ✖ 工具路径 fail 4 / 路由 fail 1 |
| egress 去重判断失效（`if (stamp === this._egressStamp) return` → `void`） | ✖ fail 1 |
| 平坦度判据 `if (ratio !== null && ratio < FLATNESS_RATIO)` → `if (false)` | ✖ fail 2 |
| `review_reasons: assessment.reasons` → `[]` | ✖ fail 5 |

**修复过程中发现的两个额外真问题**（均已在实现里处理）

1. **空决策守卫最初只覆盖了一半**：`normalizeAnswers` 的 `type` 取值是 `question.type || raw.type`（`lib/format.js:50`），所以"上游给出无法识别的 type、但问题定义合法"时不会跳过该问题，而是把 `decision[qid]` 写成 `null`。只判断 `Object.keys(decision).length === 0` 会漏掉这种"全 null"的空决策。现在按"是否至少有一个问题产出了非 null 判断"判定。
2. **路由题 id 会撞场景 id**：原实现用 `scenario_0/1/…` 作路由题 id，而 `scenario_0` 恰好是常见的场景 id 形态（测试里用 `s00…s29` 时嵌套路由直接把它当成了路由题）。已改为命名空间前缀 `systemone_route__N`。

**升级到修复版后的一个瞬时影响**：旧版本注入的历史消息带的是 `runtime-context` kind，新版本的自我排除只认 `systemone-decision`，因此**旧会话里已存在的旧决策消息会被当作正常历史读入**（直到这些消息滚出捕获窗口）。方向安全（它们是本插件自己的产物，不是他人的），且随会话推进自愈。

---

## P0-1｜`source.kind: 'runtime-context'` 与宿主自有快照语义冲突

**位置**：`lib/auto.js:37`（`const RUNTIME_CONTEXT_SOURCE = 'runtime-context'`）、`lib/auto.js:527-533`（`buildContextMessage`）

**复核**：宿主 `packages/core/agent-loop/src/runtime-context.ts`

```ts
:19   const SOURCE = 'runtime-context'
:22   function isOwned(message: UserMessage): boolean {
:23     return message.source.kind === SOURCE      // ← 仅凭 kind 判定「这是我自己写的快照」
:24   }
:126  if (event.type !== 'user/message' || !isOwned(event.data)) continue
:129    this.retained = { seq: event.seq, text: textOf(event.data) }
:136    if (event.type === 'user/message' && isOwned(event.data)) {
:137      this.retained = { seq: event.seq, text: textOf(event.data) }
:155    if (this.retained?.text === snapshot) return
```

`RuntimeContextProjection` 把自己的快照状态存在 `this.retained`，并**用 `source.kind === 'runtime-context'` 唯一地识别自己的消息**。插件注入的消息用了同一个 kind（且同为单 text block、同为 user 消息），因此会被宿主当成自己的快照。

**后果**（按可信度排序）：

1. **宿主再追加一条自己的快照**：插件注入把 `retained.text` 覆写成决策文本，下一步 `project()` 发现 `retained.text !== 渲染结果`（`:155`），于是 **append 一条宿主自己的 runtime-context**（`:102` `intent: { surfaceOp: 'append' }`）。同一份动态上下文在会话里出现两份。
2. **会话恢复时误认**：`constructor` 倒序扫描（`:125-132`），会把插件最新的决策消息当作自己保留的快照，于是宿主真实快照被误判为"还在生效"。
3. 宿主还有 `CLEARED`（`:20`）归一化逻辑，任何按该 kind 过滤/替换的宿主代码都会碰到插件消息。

**为什么现有测试发现不了**：`test/auto.test.mjs` 用的是自建桩 ctx，没有宿主 `RuntimeContextProjection`。

**建议**：换成插件自己的 kind（该机制本就为多方贡献设计）。首方同类插件（`dsh-time-context` / `dsh-tmux-context`）用的是 `source: { kind: '<自己的插件名>', form: 'snapshot', sections: [...] }`，不要复用 `runtime-context`。

> 注意：`isTrivialInput` 之前，`lib/auto.js` 里 `RUNTIME_CONTEXT_SOURCE` 还用于 `:496/:507` 的**自我排除**（读历史时跳过自己注入的消息）。改 kind 时这三处必须一起改，否则自我排除失效、形成反馈环。

---

## P0-2｜自动决策缓存 key 不含配置 → 热更新后最长 60 秒注入旧结论

**位置**：`lib/auto.js:307`（`const key = hashString(state)`）、`:331-334`（命中即返回）

**复核**：key 只由 `state` 文本哈希得到，**不含** `autoScenario` / `provider` / `model` / `autoMinConfidence` / `autoRouteMinConfidence`。`inFlight` 用同一个 key。

**后果**：在配置页把「固定场景」从 A 改成 B（或切换 provider / model）后，**最长 `autoCacheTtlMs`（默认 60s）内仍会注入旧场景的旧结论**。这与项目主打的"保存即生效、无需重启"卖点直接冲突。

对照：`lib/index.js:196-204` 对 provider 做了类型比对式的重建，说明作者已经在别处处理了同类问题，这里遗漏了。

**为什么现有测试发现不了**：`test/auto.test.mjs:764` 附近只覆盖了 `autoMinChars` 的热更新（该字段不参与决策计算，所以看起来"立即生效"）。

**建议**：把影响结果的配置纳入 key，例如 `hashString(`${state}|${scenarioRef}|${providerName}|${model}|${minConfidence}`)`。最省事的做法是 `state` 拼接前先附上一个"决策指纹"字符串。

---

## P0-3｜自动路由问句在场景数 >26 时超出模型 choice 上限

**位置**：`lib/auto.js:405-413`（路由问句的 `criteria` = 全部场景 `id → title`）；规则见 `lib/scenarios.js:468-472`（choice 选项硬上限 26）

**复核**：插件自己规定 choice 的 criteria 为 2~26 项，超限在 `validateScenario` 里是**硬失败**（`:470-472`）。但自动路由构造的那个问题**不经过任何校验**。11 个内置 + 15 个自定义即越界（而配置页与 README 都在鼓励加自定义场景）。

**建议**：路由时若场景数 >26 就先按关键词/固定场景收敛，或把路由问句改成 score/多次 choice；至少在越界时给出显式告警而不是发一个必然被拒的请求。

---

## P1-4｜README 对「短输入跳过」的描述与实现相反（已实测）

**位置**：`README.md:277` 写「低于该长度**且整体是寒暄**才跳过（`退款失败` 这类短请求不会被误伤）」；实现 `lib/auto.js:464-468`：

```js
function isTrivialInput(text, minChars) {
  const trimmed = text.trim()
  if (Number.isFinite(minChars) && minChars > 0 && trimmed.length < minChars) return true  // ← 命中即跳过
  return TRIVIAL_PATTERN.test(trimmed)
}
```

**实测**（`autoMinChars: 4`，桩 ctx + 计数 provider）：

| 输入 | 上游调用次数 | 是否注入 |
| --- | --- | --- |
| `退款`（2 字，非寒暄） | **0** | 否 |
| `谢谢`（寒暄） | 0 | 否 |
| `退款失败`（4 字） | 1 | 是 |
| `这个订单一直不到账，请查一下` | 1 | 是（本次因去重未注入） |

**结论**：实现是**或**语义——短于阈值**一律**跳过，与是否寒暄无关。`退款` 这类 2 字但有业务含义的输入会被丢弃。`lib/client.js:96` 的配置页提示写的是「低于该长度、或整体就是寒暄」，**与实现一致**；只有 README 写错，且 `lib/auto.js:456-460` 的注释描述的也是"或"（`两条独立的跳过规则（命中任一即跳过）`）。

**注意**：这是**行为 vs 文档**的取舍题，不是纯笔误——README 承诺的"短请求不误伤"更具业务价值（很多中文短请求有含义）。建议改实现为「短 **且** 寒暄才跳过」，而不是改文档。

---

## P1-5｜端到端测试漏掉 `software_dev`（README 主推场景）

**位置**：`test/tools.test.mjs:502` 注释写「11 大场景全覆盖」，但 `:504-515` 的 `SAMPLES` 只有 **10** 个键，**缺 `software_dev`**。

**复核**：`grep -n software_dev test/tools.test.mjs` → 只有 `:187`（id 清单断言）与 `:268`（别名解析）。**没有一次 `action=run` 的端到端执行**。而 `software_dev` 正是 `README.md:32-48` 主推的"编码 Agent 最常用域"。

**建议**：补一条 sample（例如「修复 CI 上偶发的订单超时用例」，同时覆盖 `derive.effort` 的派生路径）。

---

## P1-6｜`systemone_decide` 可能"成功但空"

**位置**：入参 schema `lib/tools.js` 的 `systemone_decide.parameters` 只要求 `type` + `instructions`，`criteria` 无约束；归一化 `lib/format.js:40-80`。

**机制（实测校正）**：`normalizeAnswers` 里 `const type = question?.type || raw?.type`（`format.js:42`）——**优先取问题定义的 type**。所以上游给个无法识别的 type、而问题定义合法时，代码**不会** `continue` 跳过，而是走进该题型分支、因关键字段缺失把 `decision[qid]` 写成 `null`：

- `formatAnswerLines` 退化为 JSON 打印（`format.js`）
- `computeNeedsHumanReview` 因 `confidence` 缺失、`choice` 为 `null` 之外的分支都不命中 → 全 `null` 时返回 **`false`**
- 最终 `executeDecision` 返回 **`ok: true`**，且 `decision` 是 `{q: null}` 或 `{}`

> 注：原始报告描述为"`decision = {}`、`labels = {}`"并让 `normalizeAnswers` `continue`。那只在**上游 answers 为空或 qid 对不上**时成立；"type 无法识别但问题定义合法"这条实际走的是 `null` 路径。**这个区别很关键**——只判断 `Object.keys(decision).length === 0` 会漏掉"全 null"形态（修复时第一版就漏了，被测试逼出来）。

对一个"决策"工具，这种静默空成功比显式报错更危险——调用方（模型）会以为拿到了判断。

**建议**：`ok:true` 前断言「至少一个问题产出了**非 null** 决策」；一个都没有时返回 `ok:false` 并说明原因。

---

## P2-7｜`autoInject` 无枚举校验 → 拼错即静默走错通道

**位置**：`lib/index.js` 的 Config `autoInject: z.string().default('message').volatile()`；比较处 `lib/auto.js` 的三处门控（message 通道 `!== 'context'`、context 通道 `=== 'context'`、`!== 'message'`）都是精确比较。

**后果（实测校正）**：原始报告称"两个通道同时失效且没有任何告警"，这不准确。实际行为取决于拼错成什么：

| 误写 | 实际行为 |
| --- | --- |
| `Message` / `ctx` / `channel`（任意非 `context` 值） | 走 **message 通道**（因为门控是 `!== 'context'`），退化为默认行为 |
| `Context`（想写 `context` 却大写） | 仍然走 **message 通道** → **意料之外的历史写入**（context 通道本意是不写历史） |

所以真正的危害是**静默走错通道**、而不是双失效。枚举化让两类误写都在加载期报错。

**建议**：改成 `z.union(['message', 'context'])`，让非法值在加载期就报错。

---

## P2-8｜文档与事实不一致（小项汇总）

> 下表「现状」列记录的是 **v0.5.0 修复前**的原文（行号亦为当时的工作树），保留下来作为对照。
> 所有条目均已修复。

| 位置（修复前） | 现状 | 事实 | 修复 |
| --- | --- | --- | --- |
| `README.md:485` | 「npm run test # 59 项测试」 | 测试数严重滞后于实际 | ✅ 已改为实测值 |
| `README.md:486` | 「11 大场景端到端」 | 端到端只有 10 个（见 P1-5） | ✅ 补齐 sample + 强制集合相等的断言 |
| `README.md:157` | 架构图「10 内置」 | 11（`README.md:14` 与 `package.json:4` 都写 11） | ✅ 已改 |
| `README.md:457` | choice「**建议** ≤26 项」 | 超 26 是**硬失败**（`scenarios.js:470-472`）；`client.js:386` 写的是"不能超过" | ✅ 已改为"最多 26 个，硬限制" |
| 仓库根 | 无 `LICENSE` 文件 | `package.json:5` 声明 MIT，但发布产物里没有许可证正文 | ✅ 已新增并入 `files` |
| `package.json:49` | `check` 硬编码 8 个 `lib/*.js` | 新增模块必须手工登记，否则语法检查漏网（CI 把它当门禁） | ✅ 已改为动态遍历 |
| `ci.yml:31-32` | 注释「只把 `@deepseek-ai/*` 声明为 peer/可选依赖」 | `package.json:52-54` 把 schemastery 同时放进了 `dependencies` 与 `peerDependencies`；且 cordis 是 peer 但**非** optional | ✅ 已重写注释（见下） |

**`ci.yml` 注释的最终写法**（按实际声明逐条说明，不是笼统的"peer/可选依赖"）：

```yaml
# 注意：本仓库有意不提交 lockfile。插件对两个宿主包的声明是不同的：
#   - @deepseek-ai/cordis      → 只在 peerDependencies，由宿主提供（插件不打包它）；
#   - @deepseek-ai/schemastery → dependencies + peerDependencies 双声明，
#     因为 lib/index.js 直接 import 它，而宿主**不会**把它注入插件的模块
#     解析链（与 @deepseek-ai/dsh-tools 同款问题），所以必须能被装上。
# CI 因此用 install 而不是 ci（ci 要求 lockfile 存在），
# 也因此 setup-node 不能开 cache: npm（它要求 lockfile 才能算缓存键）。
# 代价：每次跑 CI 都会解析到 schemastery ^3.18.1 的最新版，构建不可复现。
```

（只改注释，未改任何依赖声明——双声明是有意的：`peerDependencies` 表达"宿主已提供时应复用同一份"，`dependencies` 兜底"宿主未注入解析链时仍能装上"。已用 Python 的 YAML 解析器验证改动后 `ci.yml` 仍是合法 YAML，jobs 与步骤数不变。）

---

## 已复核但**判定为无问题**的两条

- **`presentCall` 字段名合法**：宿主 `ToolDefinition.presentCall?(args): ToolCallView | undefined`，`GenericCallView = { card: 'generic'; title; kind?; rawInput?; … }` 与 `lib/tools.js:131-136` 一致。
- **`dsh.client.inject` 的两个包有效**：`@deepseek-ai/dsh-client-ui-renderer` 与 `@deepseek-ai/dsh-client-locale` **都确实导出了 `./client` 子路径**，因此 `orderByModuleGraph` 能把它们解析成真实的"依赖先行"边（`packages/client/modules/src/index.ts:517-518` 的 `stripClientSuffix`）。不是死配置。

---

## 未确证事项（需要读 Cordis 源码或真实上游才能判定）

1. **`dispose()` 是否会被框架调用**：`lib/index.js:323-338` 定义了它，但 Cordis 的清理是 fiber/effect 语义。`ctx.on(...)` 会自动解绑，**但 `tools.register(...)` 返回的 disposer 是否随插件卸载自动生效未确证**。`test/entry.test.mjs` 是**手工调用** `service.dispose()`，因此不能证明框架会调它。若不会，热卸载/重载会残留工具注册。
2. **宿主是否真的把 pre-step 注入的 messages 以 `surfaceOp:'append'` 落盘**：README:283 引用的那行未能逐字对应。
3. **`form.state.writable` 是否真存在于宿主快照**：`lib/client.js:592` 依赖它，缺失时按 `!== false` 视为可写（方向安全）。
4. **宿主是否真的把 secret 字段从配置页快照剔除**：决定 `apiKey` 是否真的"不回显"。
5. **本机 profile 旧包名 `dsh-systemone` 与 patch 新名 `@master0071/dsh-systemone` 如何解析成功**：实机可用，但解析路径未读 loader 源码确认。旧装机升级时值得留意。

---

## 建议修复顺序

缺陷条目（P0-1 ~ P2-8c）与 P1-4 全部处理完毕。

**P1-4（短输入语义）已按"方案 A：改实现"落地**——用户选择不让中文短业务请求被静默丢弃：

```js
// 旧实现：命中任一即跳过（中文里会误杀"退款""报错"等 2 字完整请求）
if (Number.isFinite(minChars) && minChars > 0 && trimmed.length < minChars) return true
return TRIVIAL_PATTERN.test(trimmed)

// 现实现：只有"短 + 寒暄"才跳过
if (!Number.isFinite(minChars) || minChars <= 0) return TRIVIAL_PATTERN.test(trimmed)
return trimmed.length < minChars && TRIVIAL_PATTERN.test(trimmed)
```

`autoMinChars` 的含义随之从"长度下限"变为**寒暄判定的长度上界**。回归测试覆盖：`退款/报错/超时/闪退/卡了` 全部触发决策；`你好/谢谢/ok/嗯嗯` 全部跳过；长寒暄（`Thanks!`）放行给模型。变异测试确认：回退成旧语义则 3 个测试失败。

代价（已在 README「已知取舍」记录）：短业务请求现在会真的发一次上游请求，多花 token/延迟。若更在意成本，可调大 `autoMinChars`。
