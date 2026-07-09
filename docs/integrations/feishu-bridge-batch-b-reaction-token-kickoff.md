# 飞书 Bridge 批次 B「reaction 5 态 + token 用量展示」kickoff(纯 bot-side)

> 本文**自包含**。承接最初设计文档 `docs/integrations/feishu-bridge-design.md` §11D(reaction 状态标识)+ §7A/§12A(token 用量)。快照 **2026-07-09,main 含批次 A(图片附件 PR #35)**。锚点由两路 Explore 核实(reaction observe 生命周期 / token 数据源+footer),动手前仍用 Explore 复核精确符号名/行号。

> **命名**:未做功能分批推进的**批次 B**(A=入站图片已合#35 / B=本文 / C=消息撤回)。**用户 2026-07-09 拍板**:reaction 做**完整 5 态**;token **只做展示**(不做配额);入站 emoji **已砍**(不在任何批次)。

---

## 0. 硬前置
- 从 main(含批次 A)新开分支(建议 `feat/feishu-batch-b-reaction-token`)。**提交/推送只在用户明确要求时**。
- **纯 bot-side(`apps/feishu-bot`),零契约改动**:reaction 用现有 gateway;token 数据(`ThreadTokenUsage`)已在契约快照里 surface,bot 只消费。
- `pnpm --filter @t3tools/feishu-bot run typecheck` + `pnpm exec vp check apps/feishu-bot` + `pnpm exec vp test run apps/feishu-bot` 必过(权威命令见 `AGENTS.md`;失败先 `vp fmt`)。

## 1. 先读
- memory `MEMORY.md` → `feishu-bridge-batch-a-image-kickoff`(批次划分 + B 调研地基)、`feishu-bridge-m2b3-impl-facts`/`feishu-bridge-m2b4-impl-facts`(observe/driveTurn/mirror 语义)、`feishu-bot-refactor-split-impl-facts`(render/ 七模块地图,搬码先读设计文档 §5 十五不变量)、`feishu-bridge-e2e-pairing-token`(e2e 环境)、`feishu-bridge-kickoff-review-rule`+`review-fanout-prefer-workflow`(末尾必审规则)。
- 设计文档 §11D(reaction 5 态表 + "用具名 emoji_type 非 unicode、换态=remove旧+add新、持久化 reactionId")/§7A(Footer 小字)/§12A【high】(成本盲区——本批**只做展示不做配额**)。

## 2. 已交付地基(两路 Explore 核实)

### 2.1 reaction 现状(单态 ack,与 turn 生命周期解耦)
- `bridge/outbound.ts`:`PROCESSING_EMOJI = "Typing"`(`:31`);dispatch 时 `addReaction(triggerMessageId, "Typing")`(`:98`,锚点 = **merged dispatch 的 `sources[0]` 触发消息**,不是每条);`removeReactionByEmoji(...,"Typing")`(`:117`/`:132`)。
- **gateway**(`lark/channel.ts` ~`:584` / 接口 `lark/index.ts` ~`:104-115`):`addReaction(messageId, emojiType) → Effect<reactionId:string>`(Feishu 回的 `reaction_id`);**同时有** `removeReaction(messageId, reactionId)`(按 id 删)**和** `removeReactionByEmoji(messageId, emojiType)`(按 emoji 删)——⚠ 动手前核实两者签名(换态用 `removeReaction(reactionId)` 精确删自己那条更稳)。
- **移除时机**:`bridge/turnRunner.ts` 的 `driveTurn` observe 循环,**首帧 observation 到达即清 Typing**(视觉反馈之后交给 mirror 卡片)。→ **现状 = Typing 只覆盖「入队→turn 首帧」,completed/failed/interrupted 完全没碰。**

### 2.1a ⚠⚠ 地基前置(**批次 B 第 0 步,必须先坐实**)
**用户实测反馈(2026-07-09):从未在飞书看到 bot 发出任何 reaction**——即便代码里 Typing 单态"已实现"。**这意味着现有 reaction 很可能从未真正生效**,而 5 态全建立在"reaction 能发出"之上。**动手第一步 = 先让单态 Typing 在真机可见,再谈 5 态**。可疑根因(逐一排查):
- **best-effort 吞错**:整条链 `Effect.ignore`(`outbound.ts:98/117/132`)——飞书 API 任何报错都被静默吞。**排查法:临时去掉 `Effect.ignore` / 加 `Effect.tapError` 打日志**,看 `addReaction` 真实返回/报错。
- **⚠ 根因待真机报错定论(两个"坐实"假设已证伪,2026-07-09)**:先后两个结论都被推翻,**勿再纸上断根因**。① ~~缺 reaction 权限 scope~~ **证伪**——`binding.ts:89` 确实只有 `["im:message.send_as_bot","im:message.group_msg","im:chat:readonly"]`,但飞书 create-reaction API 只需 `im:message.reaction` **或** `im:message` **或** `im:message:send_as_bot` 之一,`send_as_bot` 可能已够(⚠ 代码 `im:message.send_as_bot` 点号 vs 文档 `im:message:send_as_bot` 冒号是否同一未核实;此结论源自 WebFetch 小模型摘要,须以飞书官方文档原文为准)+ 用户确认后台有权限 → **权限看似具备但未坐实**。② ~~emoji_type `Typing` 非法~~ **证伪**——`Typing` 在飞书官方 reaction emoji_type 枚举里(`…Sigh, Typing, Lemon, …, OnIt…`)。→ **剩余嫌疑**:后台权限是否已**发布版本生效**(仅勾选不发版不生效)/ `tenant_access_token` 缓存未刷(需重启 bot)/ `channel.addReaction` SDK 调用方式(`lark/channel.ts:584`)/ add 后被首帧 observation 过快 remove。**唯一定论法 = 临时去 `Effect.ignore`(`outbound.ts:98`)+ 打 addReaction 真实返回,真机发一条消息看报错**——必须看真实 API 响应。
- **合法 emoji_type(批次 B 5 态选 key,飞书官方枚举)**:处理中 `OnIt`/`Typing`;完成 `DONE`/`CheckMark`/`OK`;失败 `ERROR`/`CrossMark`;打断 `SHHH`/`GeneralDoNotDisturb`(或复用 `CrossMark`)。
- **`emoji_type` 不合法**:`"Typing"` 是否真是飞书合法具名 emoji_type?错 key → API 报错被吞(与 §7 的 emoji_type 枚举排查合并做)。
- **调用方式/时机**:`addReaction` SDK 调用参数/endpoint 是否对;add 后是否被首帧 observation 过快 remove(一闪而过)——但"从未见过"更像根本没发出,非时机。
> **产出**:批次 B 的**第一个可验证里程碑 = 真机看到 Typing reaction 出现**(哪怕先不做 5 态)。这一步没过,后面 5 态无意义。排查结论(尤其是否缺 scope)决定批次 B 是否附带"加 reaction scope + 重绑"子任务。

### 2.2 turn 生命周期从哪读(5 态换态的数据源)
- `driveTurn`(`bridge/turnRunner.ts`)消费 `session.observeThread(threadId)` 的 `Stream<ThreadObservation>`(`bridge/session.ts`)。
- 每帧 `ThreadObservation`(`bridge/observeTypes.ts`)含 `snapshot: OrchestrationThreadSnapshot`,内有:`snapshot.session.status`、`snapshot.activeTurnId: string|null`、`snapshot.turns[]`(每 turn 有 `status`)。
- **单 turn 终态**:`snapshot.turns.find(t => t.id === turnId).status`,取值 `"completed" | "failed" | "interrupted" | "running"`(契约 `OrchestrationTurnStatus`)。
- **终止判定钩子点**:`driveTurn` 的 stream 消费在 `activeTurnId === null`(turn 结束)处已做卡片终态渲染 + resolve `cardDone`——**这就是 5 态里 completed/failed/interrupted 换 emoji 的天然挂钩点**(当前此处不碰 reaction)。
- **打断可直接区分**:`turn.status === "interrupted"`(用户点停止→`ThreadTurnInterruptCommand`→server 标 interrupted)。**权威读 observation 的 status,不用本地乐观推断**(即便 bot 自己发过 interrupt)。

### 2.3 token 数据源 + Footer(纯展示,无需新订阅)
- **数据已在快照**:`ThreadObservation.snapshot.tokenUsage`(`observeTypes.ts`,snapshot 即契约类型)。契约 `ThreadTokenUsage`(`packages/contracts/src/orchestration.ts`):`{ inputTokens, outputTokens, totalTokens, contextWindowTokens? }`——**无 cost/费用字段**。→ **无需订阅 `thread.token-usage.updated` 事件**,driveTurn 每帧 snapshot 自带最新 usage。
- **Footer 渲染点**:`bridge/render/footer.ts`(PR#31 七模块之一),现渲染**运行状态行**(🧠思考/⚙️工具/✍️输出/✅完成/❌失败,数据来自 `snapshot.session.status`)。token 小字拼在状态行末尾,如 `· 1.2k tok`(读 `snapshot.tokenUsage?.totalTokens`)。⚠ 精确函数名/行号动手前 grep(`grep -rn "footer\|tokenUsage\|status" apps/feishu-bot/src/bridge/render/`)。
- **密度**:只有 `card` 档有 Footer(markdown/text 无)→ token **card-only**(p2p 恒 card 天然有;群看 per-chat density)。
- **字节预算**:`render/budget.ts` 只截正文/工具输出/reasoning,**footer 加几十字节安全**。

## 3. 批次 B 范围(单 PR,纯 bot-side)

### A. reaction 完整 5 态
把「单态 ack」升级为「随 turn 生命周期换 emoji 的状态机」,锚点仍 = `sources[0]` 触发消息(单锚,不逐条)。

| 态 | 挂钩点 | 现状 |
|---|---|---|
| 排队 queued | `outbound.ts` dispatch 入队(现 Typing 时机) | 现无独立排队态 |
| 执行中 running | `driveTurn` 首帧 observation(turn started) | 现是「清 Typing」 |
| 完成 completed | `driveTurn` 终止判定 `turn.status==="completed"` | ❌ |
| 失败 failed | 同上 `"failed"` | ❌ |
| 打断 interrupted | 同上 `"interrupted"` | ❌ |

**主接线工作**:
0. **⚠ 先做 §2.1a 地基排查**:坐实单态 Typing 真机可见(可能要加 reaction scope + 重绑)。这一步没过,下面免谈。
1. **透传锚点状态进 observe**:`driveTurn` 当前拿得到 chatId/threadId,但换 reaction 要 `triggerMessageId` + 当前 `reactionId`(现由 outbound 持有,observe 不持有)。把 `{ triggerMessageId, currentReactionId }` 透传进 `driveTurn`/observe scope——**这是本批主要接线**。
2. **换态**:每次 = `removeReaction(msgId, prevReactionId)` → `addReaction(msgId, newEmoji)` → 存新 reactionId。queued→running→(completed|failed|interrupted)。
3. **终止处按 status 分派**:在 §2.2 的终止判定处读 `turn.status` 换对应终态 emoji。
4. **best-effort 全程**:沿用现有 `Effect.ignore`,reaction 任何失败**绝不阻断** dispatch/turn/卡片主流程。
5. **锚点单一**:5 态只作用于 `sources[0]` 触发消息;消息雨里的后续消息不各自打(与现状一致)。

### B. token 用量展示
- 在 `render/footer.ts` 的状态行末尾追加 `· N tok`(`snapshot.tokenUsage?.totalTokens`,格式化如 `1.2k`);`tokenUsage` absent(旧/无 usage)时**不显示**(no-op,不破现状)。
- card-only(markdown/text footer 不存在,天然不显示,无需特判)。
- 可选:`contextWindowTokens` 显示上下文占用(§7 待定,MVP 先只 `totalTokens`)。

## 4. PR 边界
- 本 PR = 批次 B(reaction 5 态 + token 展示),单 PR,纯 `apps/feishu-bot`,零契约/server 改动。
- 流程:实现 → Workflow 多维对抗审查 → 修阻断项 → 用户确认 commit/PR → 真连接 e2e → 合入。
- 不依赖批次 C,可独立交付。

## 5. 红线
- **纯 bot-side、零契约改动**:token `ThreadTokenUsage` 已在契约快照 surface;reaction 用现有 gateway。不动 contracts/server。
- **best-effort 不阻断**:reaction 换态 / token 渲染任何失败(`LarkGatewayError`)一律 `Effect.ignore`,不阻断主流程、不崩进程(承 M1 原则)。
- **权威状态读 observation**:reaction 终态一律读 `turn.status`(server 权威),不靠本地乐观(即便 bot 发过 interrupt)。
- **不碰审批/pin-drift/payload.o**:reaction 是卡片外的辅助信号,与审批链、`feishuInitiators`、operator 签名**完全无关**,不得触碰。
- **不破 mirror 卡片**:reaction 与卡片渲染是**两条独立视觉通道**;本批只加 reaction 换态 + footer 一行 token,不改卡片正文/工具/审批渲染。
- **token card-only**:不强塞 markdown/text 档(它们无 footer);`tokenUsage` absent 时不显示(字节级不破现状)。
- **锚点键粒度**:reaction 锚 `sources[0].message.messageId`(触发消息),不误用 composite chatKey。

## 6. e2e runbook(真连接)
- 环境同批次 A:home `/Users/lizhipeng/.t3-feishu-m0`,`T3CODE_HOME=... T3CODE_PORT=3773 node apps/server/src/bin.ts serve`,bot server-managed 自动 spawn,浏览器 pairing 走 3773,未合入 web 先 `cd apps/web && pnpm exec vp build`(本批不改 web,worktree 可复制主树 dist)。细节见 memory `feishu-bridge-e2e-pairing-token`。先 `/whoami` 校验 binding。M-1 先 `/workspace`。
- **验证点**:
  1. **5 态流转**:发一条 prompt → 触发消息 reaction 依次 排队→执行→✅完成(真机肉眼看 emoji 换)。
  2. **失败态**:制造一个失败 turn(如无效命令/provider 报错)→ reaction 变 ❌。
  3. **打断态**:turn 运行中点卡片「停止」→ reaction 变 ⏹(证明读到 `status==="interrupted"` 而非 failed)。
  4. **token 展示**:card 档卡片 Footer 末尾出现 `· N tok`,随 turn 增长;`markdown`/`text` 档不显示(无 footer)。
  5. **best-effort 回归**:reaction/token 相关调用失败(可临时 mock 报错)不影响 turn 正常跑完、卡片正常渲染。
  6. **消息雨**:600ms 内连发 2 条 → 只有 `sources[0]` 触发消息带 5 态 reaction(锚点单一)。
- **收口**:kill server;home 保留;无需改 settings.json。

## 7. 待确认(动手前敲定 / 实现中定)
- **⚠ 飞书 `emoji_type` 具名枚举(外部依赖,动手前必敲)**:飞书 reaction 的 `emoji_type` 是**固定具名字符串枚举、非 unicode**。`"Typing"` 已知可用;**completed/failed/interrupted/queued 的确切可用 key 必须查飞书开放平台 `im.message.reaction` 官方 emoji_type 列表**(候选:完成 `DONE`/`OK`/`THUMBSUP`、失败 `CrossMark`/`CROSS`、打断待定、排队待定)。传错 key 会 API 报错。**建议动手前先跑一个真机 addReaction 探针**确认每个 key 可用。
- **gateway remove 双签名**:`removeReaction(reactionId)` vs `removeReactionByEmoji(emojiType)` 现状核实(换态倾向用 `removeReaction(reactionId)` 精确删)。
- **排队态是否真做**:queued 独立态只在「turn 运行中又发消息」出现(场景少);若飞书无合适"排队/沙漏"具名 emoji,退化为「入队即 running(Typing)」的 4 态实测(用户已要 5 态,优先做全,emoji 不可得再降级并回报)。
- **render/footer.ts 精确符号名/行号**(grep 确认)。
- **contextWindowTokens 是否显示**(MVP 先只 totalTokens)。
- **reactionId 状态存哪**:活跃 turn 需存 `{triggerMessageId, currentReactionId}`;driveTurn 的 turn scope 内持有即可(turn 结束释放),无需跨 turn 持久化。

## 8. 委派 / 闭环
- **Explore/Plan**(只读):动手前复核 §2 锚点(`outbound.ts:31/98/117/132` reaction 现状 / `turnRunner.ts` driveTurn observe 循环 + 终止判定 / `observeTypes.ts` ThreadObservation.snapshot.turns[].status + tokenUsage / 契约 `ThreadTokenUsage` + `OrchestrationTurnStatus` / `render/footer.ts` 状态行 / gateway addReaction 返回 reactionId + remove 双签名)。**必查飞书 emoji_type 官方枚举**(§7 外部依赖)。
- **Test**:typecheck + `vp check` + 单测(5 态换态状态机纯逻辑 / status→emoji 映射 / token 格式化 `1.2k` / tokenUsage absent no-op / best-effort 失败不阻断)。
- **Review**:多维 + 对抗(**用 Workflow**;维度见下必审规则)。

## 【kickoff 必审 · 自传播规则】
交付前**必须**多维对抗审查(**优先 Workflow**,`review-fanout-prefer-workflow`):① **代码事实**——file:line 逐条对真实 main 核验(`outbound.ts` reaction 现状 / `turnRunner.ts` driveTurn observe 终止判定 / `observeTypes.ts` snapshot.turns[].status + tokenUsage / 契约 `ThreadTokenUsage`(无cost)+ `OrchestrationTurnStatus`(completed/failed/interrupted) / `render/footer.ts` 状态行 / gateway addReaction→reactionId + removeReaction 双签名 / token 数据在快照非需新订阅);② **范围完整**——「reaction 与审批/pin-drift/卡片渲染是独立通道没被混淆」、「打断读 server status 非本地乐观」、「token 纯展示无配额、card-only、absent no-op 不破现状」、「主接线=triggerMessageId+reactionId 透传进 driveTurn 没被漏」、「飞书 emoji_type 具名枚举是外部依赖已如实标为动手前必敲(不虚构已知全部 key)」;③ **自包含**——memory/文档引用真实、runbook 可执行、红线齐全(纯bot-side零契约、best-effort不阻断、权威读status、不碰审批链、token card-only+absent no-op)、待确认已在 §7 点明。修掉阻断项再交付,并把**本规则原样写进**衍生的下一里程碑 kickoff。
