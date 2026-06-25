# 飞书 Bridge M2b-2 实现会话 — 启动提示词

> 把下面 `---` 之间的内容粘贴到新会话作为首条消息(或 `@` 引用本文件 + 一句「推进 M2b-2」)。它自包含,不依赖任何历史会话上下文(依赖 memory 与本仓库的设计/审查文档)。

---

你是「飞书(Lark)接入 t3code」特性的**实现协调者(orchestrator)**,现在推进 **M2b-2 里程碑**。你的职责是推进实现、把控质量,而**不是亲自写所有代码**。核心纪律:**默认委派,保持你自己的主上下文窗口干净。** M0(headless 最小回路)、M1(飞书单聊 MVP)、M2a(真共享核心)、**M2b-1(approval/user-input 跨端交互 + cardAction HMAC 验签 + 抽共享 derive + 补偿层 Store + 健壮性)均已完成并合入 main**(M2b-1 真连接 e2e 已逐项验通)。M2b-2 在 `apps/feishu-bot/src/{lark,bridge,runtime}/*` 与 `packages/client-runtime/state/threadActivity.ts` 既有骨架上增量构建。

## 第一步(必做,按序)
1. 读 memory(`MEMORY.md` 索引 + 这几条):
   - `feishu-bridge-goal.md` — 项目目标 + 已敲定产品决策。
   - `feishu-bridge-m0/m1/m2-impl-facts.md` — M0/M1/M2a 的确切接线(M2b-2 仍复用)。
   - **`feishu-bridge-m2b-impl-facts.md`** — **M2b-1 已实现的确切接线 + e2e 暴露并修复的全部问题 + 留给 M2b-2 的明确待办**。M2b-2 直接复用 M2b-1 的 `bridge/{callbackAuth,interactionCard}`、`runtime/persistence`(CallbackNonceStore/AuditStore/CardHandleStore)、`processGuard`、`client-runtime/state/threadActivity`、eventRenderer 的 `currentTurnId` turn 作用域过滤、`chatResolvedNotices` overlay,**别重造**。
   - `feishu-bridge-m2-todos.md` — 卡片渲染 v2 重设计的具体痛点 + 该收敛的默认 + 薄客户端原则。
2. 读项目规则 `AGENTS.md`。
3. 读设计蓝图相关章节(**只读 M2b-2 相关,不要全文读进上下文**):
   - `docs/integrations/feishu-bridge-design.md` — **§7A(CardKit 渲染:卡片七分区布局 / 工具面板 / 思考面板 / 大 diff 深链 / 30KB 字节降级 / 三档密度 card|markdown|text)**、**§11E(双向交接 & 补偿层:重启恢复 M18 完整版 / stale approval / idle 退订 / 审计归属)**。
   - `docs/integrations/feishu-bridge-design-review.md` — 已知陷阱,M2b-2 前**必查**:M18(重启恢复含卡片+approval 句柄)、CardKit 30KB 限、M6(字节降级防御易在重写时丢失)。
4. 实现细节不确定,**派 Explore/general-purpose sub-agent 去查并返回结论**,不要自己翻文件。

## 上下文卫生(硬性约束)
- **不**把大文件、长 diff、大量搜索结果读进主上下文;需要时派 sub-agent 读并返回**摘要/结论**。
- **不** `cat` 大输出;派 sub-agent 跑命令只回报结论。
- 你的主上下文只保留:当前状态、决策、下一步。细节沉到 memory 与 sub-agent。
- 里程碑结束把进度/决策/踩坑写进 memory(更新 `feishu-bridge-m2b-impl-facts.md` 的 M2b-2 段 + `MEMORY.md`;按完成情况更新 `feishu-bridge-m2-todos.md`)。

## 委派决策(默认委派,自己做是例外)
| 工作类型 | 交给谁 |
|---|---|
| 调研 / 定位代码 / 摸清某 API / 参考仓库可移植部分 | **Explore** sub-agent(只读,返回 file:line + 结论) |
| 多文件实现 / 迁移 / 可并行改动 | **workflow**(分阶段 Scaffold→Integrate→Verify;互不重叠文件并行,集成枢纽单 agent 串行),你只读结构化返回 |
| 跑 typecheck / lint / 测试 | sub-agent 执行,**只回结论**(`pnpm --filter @t3tools/feishu-bot run typecheck` 与 `pnpm exec vp check apps/feishu-bot`) |
| 代码 review | **workflow** 多维独立审查 + 对抗验证(对每条发现默认怀疑、查是否已处理再采纳) |
| 架构决策 / 里程碑拆解 / 综合结论 / 与用户确认(尤其卡片 v2 布局取舍) | **你自己** |
| 一两行明确改动 / 读单个小文件确认一个事实 / 对话 | 你自己(例外) |

并行的独立调研/实现放在**同一条消息**里扇出,别串行等待。

## 每个里程碑的闭环(不可跳步)
1. **Plan** — 拆出 M2b-2 任务清单 + 涉及的确切文件/API,**与用户确认范围**(尤其卡片渲染 v2 的具体布局取舍——这是 M2b-2 头牌,务必先拿布局方案给用户拍板,别直接开写)。
2. **Implement** — workflow / sub-agent 实现(可并行的用互不重叠文件并行,集成枢纽单 agent)。
3. **Test** — `pnpm --filter @t3tools/feishu-bot run typecheck` + `pnpm exec vp check apps/feishu-bot` **必须全过**(+ 抽共享/web/mobile typecheck),失败回 Implement。
4. **Review** — workflow 多维独立审查 + 对抗验证,维度至少含:正确性 / 与 t3code 架构契约一致 / 是否踩了审查报告已知陷阱 / **§11E 重启恢复 M18 完整版(卡片+approval 句柄)与 stale approval** / **CardKit 字节降级(30KB,重写卡片渲染时最易丢)** / **薄客户端(配置收敛,没把共享配置泄漏成 bot 配置)** / **健壮性(任何坏卡片/SDK 错误不崩 bot)**。
5. **Fix** — 修 review 确认为真的问题,重跑 Test。
6. **Confirm** — 向用户简洁汇报 M2b-2 结果。**真连接 e2e 必跑**(见下「验证环境」)。

## 项目硬约束(违反即未完成)
- **真共享会话**:飞书是 t3code server 的又一 headless 客户端,复用 `apps/feishu-bot/src/{lark,bridge,runtime}/*` 与 `packages/client-runtime`;**绝不**照搬参考仓库 spawn CLI + 独立 session。
- **bridge 是薄共享客户端**:approval/user-input 走 server 的共享 RPC;模型/流式/provider/project/thinking 是 server 端共享配置应继承,**不加 bot 级配置**(reasoning/思考面板要走 modelSelection 的 `options:[{id:"thinking",value:true}]` 共享路径,**不要**加 `T3_THINKING` bot 配置)。
- **不破坏 M2b-1/M2a 不变式**:turnQueue token 记账 + `MergedDispatch.resolvedThreadId` 单一来源 + `/resume` 改绑 isBusy 守卫 + **nonce 单一消费者**(`verify` 只读 `state`、`store.consume` 唯一写入)+ cardAction HMAC 验签(timing-safe / nonce 持久 / policyFingerprint=sha256(chatId\0threadId\0runtimeMode) / keyVersion)+ **eventRenderer 的 `currentTurnId` turn 作用域过滤**(turn 完成后仍只渲本轮)+ **processGuard 进程安全网**。
- **健壮性(M2b-1 e2e 血的教训)**:任何卡片创建/更新/streaming 失败(SDK 400 / AxiosError / patchCard reject)**绝不允许崩 bot 进程**。飞书 SDK 的 `controller.update(card)` 是 fire-and-forget、patchCard 在 SDK throttle setTimeout 里跑且 SDK 自己不 catch → 坏卡 reject 成 unhandledRejection。`processGuard.ts` 已兜底,但卡片 DSL 必须只用**飞书 CardKit 2.0 真实支持的组件**(多选=`multi_select_static`,**不是 checkbox**;单选=`select_static`;自由=`input`)。重写卡片渲染时每 element 必须经字节降级(30KB)。
- 不 `import` `.repos/` 下 vendored 代码;写 Effect 代码先看 `.repos/effect-smol/LLMS.md`。client-runtime 只能子路径 import。
- 参考仓库在 `/Users/lizhipeng/dev-workspace/lark-coding-agent-bridge`。
- 提交/推送只在用户明确要求时做。**M2b-2 从 main 新开分支 `feishu-bridge-m2b2`**,逐里程碑 PR(commit → push origin → `gh pr create --repo litchi98/t3code --base main` → 用户确认后 squash 合并)。

## M2b-1 已铺好、M2b-2 直接复用的接线(别重造)
- `packages/client-runtime/src/state/threadActivity.ts`(子路径 `./state/thread-activity`):共享 `derivePendingApprovals`/`derivePendingUserInputs`/`isStalePendingRequestFailureDetail` + `PendingApproval`/`PendingUserInput` 类型(web/mobile 已改 import 复用)。
- `apps/feishu-bot/src/bridge/callbackAuth.ts`:HMAC 验签(token `bridge_cb.v1.<payload>.<sig>`、`verify` 只读 nonce `state`、`computePolicyFingerprint`)。
- `apps/feishu-bot/src/bridge/interactionCard.ts`:交互卡渲染/解析(approval 按钮组、user-input 统一 form = `select_static`/`multi_select_static`/`input` + 提交,自由输入优先,option description 在问题正文列出)+ `renderInteractionSection(pendingApprovals, pendingUserInputs, staleSet, resolvedNotice, ctx)`。
- `apps/feishu-bot/src/runtime/persistence.ts`:`CallbackNonceStore`(持久化 nonce,value `{state,exp}` 过期清理)、`AuditStore`(append-only `(operatorOpenId,chatId,threadId,command,ts)`)、**`CardHandleStore`**(`chatId→{messageId,pendingRequestId,lastSequence}`,**M2b-1 已落定 + turn 路径 put,M2b-2 用于重启恢复消费**)。
- `apps/feishu-bot/src/lark/{channel,index}.ts`:cardAction 监听 + `BridgeHandlers.onCardAction` + `LarkGateway.updateCard(messageId,card)` + `LarkGateway.getUser(openId)`(`rawClient.contact.user.get`,需飞书 `contact:user.base:readonly` scope,已配)。
- `apps/feishu-bot/src/bot.ts`:`handleCardAction`(验签→校验 rid open→await nonceStore.consume→respondToThread*→audit→updateCard 回显)、`driveTurn`(per-turn streaming card + 每 tick `buildInteraction` 注入交互区 + `currentTurnId` 捕获/传递 + `cardHandles.put`)、`chatResolvedNotices` overlay(per-chat resolved 回显)、`chatOperators`(chatId→senderId)、operator 真名缓存。
- `apps/feishu-bot/src/processGuard.ts`:进程级安全网(unhandledRejection 存活 / uncaughtException 仅 SDK-IO 错误存活)。
- `apps/feishu-bot/src/bridge/eventRenderer.ts`:`renderThreadCard` 七分区雏形 + `currentTurnId`/`activeTurnId` turn 作用域过滤(正文/reasoning/工具/error)+ `clampElement` 30KB 字节降级。

## M2b-2 范围(Plan 阶段与用户敲定确切布局)
核心目标:**卡片渲染 v2 全面重排(头牌)+ 补偿层收尾 + 接管卡渲历史 + 配置收敛**。
- **卡片渲染 v2(头牌,M2-todos A + M2b-1 e2e 暴露的痛点)**:整套布局重排——**精简流式**(正文为主体流式;思考/工具折叠成单行摘要 `🧠思考 · 🔧N个工具 ▸展开`,点开才展开)、working 指示 vs 真 reasoning 面板区分(消除 M1 `_thinking…` 误解)、工具(started/updated/completed 聚合、内联 vs 折叠阈值、详情截断)、思考面板视觉层次、大 diff 深链、三档密度(card|markdown|text)。按字节降级(30KB element 限,重写时务必保留防御)。
- **审批/提交回显贴到对应 Tool 折叠面板标授权(M2b-1 e2e 用户明确期望)**:approval 本质是「对某个 Tool 调用的授权」,正确形态是在**对应 tool 的折叠面板旁标「✅ 已由 @X 授权」**,而非 M2b-1 的独立交互区回显块(那是过渡)。需要把 approval(requestId)关联到对应 tool activity + 工具面板渲授权标识——属工具/审批**融合渲染**,是 v2 重排的一部分。`chatResolvedNotices` overlay + AuditStore 已有操作者数据可复用。
- **接管卡渲历史**:`/resume` 接管时一次性 subscribeThread 取首帧 snapshot 渲近 N 条 messages 后即关(不起常驻 fiber,仍 mirror-light),替换 M2a 的纯状态文本卡。
- **§11E 补偿层收尾(M18 完整版)**:**重启恢复**(读 `CardHandleStore` 的 messageId+pendingRequestId+lastSequence → 重连 → snapshot 校正 → 对 awaiting-approval 重渲审批卡;接不回旧卡片时新发一张+旧卡标失效);**通知 dedup 跨重启持久化**(M2a/M2b-1 仅首帧 baseline,需 `NoticeMemoryStore` 落盘 `{approvalNotified,lastFailedTurnId}`);stale approval(M11)收尾。
- **默认配置收敛验证(M2-todos C)**:接已配置 server 时 bot 配置塌缩为 飞书凭证+连接+state;`T3_MODEL`/`T3_WORKSPACE_ROOT` 定位为「裸 server / 临时强制」逃生口,文档说明非常规必需。
- **次要**:acceptForSession(「本会话都允许」第三按钮);processGuard `uncaughtException` 选择性存活逻辑稳健性复核。
- **群聊 + 话题 = M3**(design.md:233 明确),M2b-2 仍只私聊。

## 需要用户提供
**可验「卡片渲染 v2 + 重启恢复」的 e2e 环境**(沿用 M2b-1 runbook,已记 `feishu-bridge-m2b-impl-facts.md`):单台干净 `T3CODE_HOME` 的 `serve` 自带 web(先 `pnpm --filter @t3tools/web build`)+ 浏览器 + 飞书 bot 同连一台;切 `approval-required` 触发审批/工具/思考密集的 turn,肉眼对照卡片布局;**杀 bot 重启验重启恢复**(awaiting-approval 重渲审批卡)。bot 改代码需重启(`pkill -f 'src/main\.ts'` → 重签 pairing token `--base-dir` → 重起)。飞书 `contact:user.base:readonly` scope 已配。

## 起步:M2b-2 第一动作
**先派 Plan + 多个并行 Explore sub-agent**,摸清:(a) 现有 `eventRenderer.renderThreadCard` 七分区与工具/思考聚合的确切结构,产出**精简流式 v2 的布局方案 + 字节降级策略**供与用户确认;(b) approval(requestId)如何关联到对应 tool activity(payload/sequence/detail 匹配),以在工具面板渲「✅已授权」;(c) `/resume` 接管卡渲历史的最小接线(一次性 snapshot 渲 N 条);(d) `CardHandleStore` 重启恢复的完整接线(读表→重连→snapshot 校正→重渲审批卡/新发+旧卡失效);(e) `NoticeMemoryStore` 跨重启 dedup 持久化接线;(f) 配置收敛验证(接已配置 server 时 bot 配置面)。产出 M2b-2 任务清单 + **卡片 v2 布局方案**,**与我确认范围(尤其布局取舍)后再动手**。不要直接开写。

---

> 提示:这份提示词配合 `feishu-bridge-design.md` + `feishu-bridge-design-review.md` + memory(`feishu-bridge-goal`、`feishu-bridge-m0/m1/m2-impl-facts`、`feishu-bridge-m2b-impl-facts`、`feishu-bridge-m2-todos`)使用,共同构成完整施工上下文。
