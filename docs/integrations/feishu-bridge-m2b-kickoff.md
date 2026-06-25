# 飞书 Bridge M2b 实现会话 — 启动提示词

> 把下面 `---` 之间的内容粘贴到新会话作为首条消息(或 `@` 引用本文件 + 一句「推进 M2b」)。它自包含,不依赖任何历史会话上下文(依赖 memory 与本仓库的设计/审查文档)。

---

你是「飞书(Lark)接入 t3code」特性的**实现协调者(orchestrator)**,现在推进 **M2b 里程碑**。你的职责是推进实现、把控质量,而**不是亲自写所有代码**。核心纪律:**默认委派,保持你自己的主上下文窗口干净。** M0(headless 最小回路)、M1(飞书单聊 MVP)、**M2a(真共享核心:懒同步 + `/resume` 接管 + 斜杠命令框架 + 关键通知通道)均已完成并合入 main**(M2a = PR #3,commit `87726f45`,真连接 e2e 已验「真共享」)。M2b 在 `apps/feishu-bot/src/{lark,bridge,runtime}/*` 既有骨架上增量构建。

## 第一步(必做,按序)
1. 读 memory(`MEMORY.md` 索引 + 这五条):
   - `feishu-bridge-goal.md` — 项目目标 + 已敲定产品决策 + 已修正的事实错误。
   - `feishu-bridge-m0-impl-facts.md` — M0 鉴权/平台/连接的确切接线(M2b 仍复用)。
   - `feishu-bridge-m1-impl-facts.md` — M1 已实现的确切接线 + 真连接事实(turnQueue 记账不变式、逐字流式=server 设置、模型钉死在 thread 创建时、e2e runbook)。
   - `feishu-bridge-m2-impl-facts.md` — **M2a 已实现的确切接线 + 已证实的 M2b 接线事实(approval/cardAction 调研结论)+ e2e runbook + 顺带发现的 t3code 核心 bug**。M2b 直接复用 M2a 的 `bridge/{shellCache,shellWatcher,bindingState,commands/*}`、`lark/`、turnQueue 的 `resolvedThreadId` 单一来源不变式,**别重造**。
   - `feishu-bridge-m2-todos.md` — 卡片渲染 v2 重设计的具体痛点 + 该收敛的默认 + 薄客户端原则。
2. 读项目规则 `AGENTS.md`。
3. 读设计蓝图相关章节(**只读 M2b 相关,不要全文读进上下文**):
   - `docs/integrations/feishu-bridge-design.md` — **§7A(CardKit 渲染:approval 按钮 / user-input 结构化提问 / 工具面板 / 思考面板 / 大 diff 深链 / 30KB 字节降级)**、**§11B(approval/user-input 回传链路 + 按钮 value HMAC 签名结构)**、**§11E(双向交接 & 补偿层:重启恢复现含卡片句柄+未决 approval 句柄 / stale approval / 审计归属 / idle 退订)**、§11 里程碑(确认 M2b 的确切边界——哪些算 M2b、哪些推 M3 如群聊/话题)。
   - `docs/integrations/feishu-bridge-design-review.md` — 已知陷阱。M2b 前**必查**:H? approval 相关、M11(stale approval failed 活动)、M18(重启恢复含卡片+approval 句柄)、M4(scope 无法细分 / 审计归属)、CardKit 30KB 限。
4. 实现细节不确定(某 API 在哪/怎么用/参考仓库怎么做),**派 Explore/general-purpose sub-agent 去查并返回结论**,不要自己翻文件。

## 上下文卫生(硬性约束)
- **不**把大文件、长 diff、大量搜索结果读进主上下文;需要时派 sub-agent 读并返回**摘要/结论**。
- **不** `cat` 大输出;派 sub-agent 跑命令只回报结论。
- 你的主上下文只保留:当前状态、决策、下一步。细节沉到 memory 与 sub-agent。
- 里程碑结束把进度/决策/踩坑写进 memory(更新 `feishu-bridge-m2-impl-facts.md` 的 M2b 段 + `MEMORY.md`;按完成情况更新 `feishu-bridge-m2-todos.md`)。

## 委派决策(默认委派,自己做是例外)
| 工作类型 | 交给谁 |
|---|---|
| 调研 / 定位代码 / 摸清某 API / 参考仓库可移植部分 | **Explore** sub-agent(只读,返回 file:line + 结论) |
| 多文件实现 / 迁移 / 可并行改动 | **workflow**(分阶段 Scaffold→Integrate→Verify;互不重叠文件并行,集成枢纽单 agent 串行),你只读结构化返回 |
| 跑 typecheck / lint / 测试 | sub-agent 执行,**只回结论**(`pnpm --filter @t3tools/feishu-bot run typecheck` 与 `pnpm exec vp check apps/feishu-bot`) |
| 代码 review | **workflow** 多维独立审查 + 对抗验证(对每条发现默认怀疑、查是否已处理再采纳) |
| 架构决策 / 里程碑拆解 / 综合结论 / 与用户确认 | **你自己** |
| 一两行明确改动 / 读单个小文件确认一个事实 / 对话 | 你自己(例外) |

并行的独立调研/实现放在**同一条消息**里扇出,别串行等待。

## 每个里程碑的闭环(不可跳步)
1. **Plan** — 拆出 M2b 任务清单 + 涉及的确切文件/API/参考仓库可移植部分,**与用户确认范围**(含是否拆子里程碑、卡片渲染 v2 的具体布局取舍)。
2. **Implement** — workflow / sub-agent 实现(可并行的用互不重叠文件并行,集成枢纽单 agent)。
3. **Test** — `pnpm --filter @t3tools/feishu-bot run typecheck` + `pnpm exec vp check apps/feishu-bot` **必须全过**,失败回 Implement。
4. **Review** — workflow 多维独立审查 + 对抗验证,维度至少含:正确性 / 与 t3code 架构契约一致 / 是否踩了审查报告已知陷阱 / **飞书 cardAction 回调签名鉴权正确性(timing-safe / nonce 持久 / policyFingerprint)** / **§11E 重启恢复(卡片+approval 句柄)与 stale approval** / **薄客户端(approval 走 server 共享 RPC,没把共享配置泄漏成 bot 配置)** / CardKit 字节降级。
5. **Fix** — 修 review 确认为真的问题,重跑 Test。
6. **Confirm** — 向用户简洁汇报 M2b 结果,确认后再进 M3。**真连接 e2e 必跑**(见下「验证环境」)。

## 项目硬约束(违反即未完成)
- **真共享会话**:飞书是 t3code server 的又一 headless 客户端,复用 `apps/feishu-bot/src/{lark,bridge,runtime}/*` 与 `packages/client-runtime`;**绝不**照搬参考仓库 spawn CLI + 独立 session。
- **bridge 是薄共享客户端**:approval/user-input 走 server 的共享 RPC(`respondToThreadApproval`/`respondToThreadUserInput`),**别另起一套**;模型/流式/provider/project 是 server 端共享配置应继承,不加 bot 级配置(thinking 面板要走 modelSelection 的 `options:[{id:"thinking",value:true}]` 共享路径,**不要**加 `T3_THINKING` bot 配置)。
- **不破坏 M2a 不变式**:turnQueue token 记账(beginTurn/onTurnComplete/withChatTurnLock)+ commandId 派生 threadId == dispatch 的 `resolvedThreadId` 单一来源 + `/resume` 改绑 busy 守卫。`derivePendingApprovals`/`derivePendingUserInputs` 当前在 web/mobile **各复制一份**,M2b 应**抽到 client-runtime 共享**给 bridge 复用(AGENTS.md:重复=code smell),勿第三次复制。
- **cardAction 验签 bridge 自做**:HMAC-SHA256 timing-safe;nonce store **持久化磁盘**防重放(与 M18 补偿层一体);exp(参考 24h);policyFingerprint 入签→撤权即失效;keyVersion 轮换。移植参考仓 `src/card/callback-auth.ts` + `src/card/dispatcher.ts` + `src/bot/`(cardAction 分发)。
- 不 `import` `.repos/` 下 vendored 代码;写 Effect 代码先看 `.repos/effect-smol/LLMS.md`。client-runtime 只能子路径 import。
- 参考仓库在 `/Users/lizhipeng/dev-workspace/lark-coding-agent-bridge`。
- 提交/推送只在用户明确要求时做。**M2b 从 main 新开分支 `feishu-bridge-m2b`**,逐里程碑 PR(commit → push origin → `gh pr create --repo litchi98/t3code --base main` → 用户确认后 squash 合并)。

## M2b 已证实的接线事实(本会话调研所得,可直接采信,别重复调研)
- **cardAction 走 `@larksuite/channel` 长连接事件,不是 HTTP webhook** → **无需** 回调 URL / verification_token / encrypt_key;只需在飞书开发者后台开 **cardAction 事件订阅**。M1 的 `lark/channel.ts` 只注册了 p2p `message`,**无 cardAction**;M2b 要加 cardAction 监听 + `BridgeHandlers.onCardAction` + `CallbackAuth`。
- `CardActionEvent`:`{operator.openId, chatId, messageId, action.value, raw.action.form_value}`(需 `includeRawEvent`)。按钮 behaviors:`callback`/`url`/`form_submit`;表单 `select_static`/`input`/`checkbox`。
- **响应命令现成**:`respondToThreadApproval({threadId,requestId,decision})` / `respondToThreadUserInput({threadId,requestId,answers})`(`packages/client-runtime/src/operations/commands.ts:213/224`,自动补 commandId/createdAt)。`decision`=`accept|acceptForSession|decline|cancel`(`ProviderApprovalDecision`)。命令定义 `packages/contracts/src/orchestration.ts:627-643`。
- **pending 物化**:在 subscribeThread snapshot 的 `activities`——`approval.requested`(payload `requestId`/`requestKind`:command|file-read|file-change/`detail`)、`user-input.requested`(`requestId`/`questions`);stale 终态 `provider.approval.respond.failed`(M11:server 不报硬错,bridge 要识别→卡片降级「请求已失效」+ 同 requestId 置灰)。shell 有 `hasPendingApprovals`/`hasPendingUserInput` 快速位。
- **derive 函数**:`derivePendingApprovals(activities)` / `derivePendingUserInputs(activities)` 在 `apps/web/src/session-logic.ts` 与 `apps/mobile/src/lib/threadActivity.ts` 各一份 → **抽到 client-runtime 共享**。`PendingApproval={requestId,requestKind,createdAt,detail?}`;`PendingUserInput={requestId,createdAt,questions[]}`。
- **RuntimeMode** 无 read-only,仅 `approval-required|auto-accept-edits|full-access`;**只有 `approval-required` 才生成 pending approval**(thread 创建时定,可 `thread.runtime-mode.set` 改)。e2e 验通知通道时即靠把会话切 `approval-required`。
- **M2a 已铺好的位**:通知通道已能在 resumed 绑定有 pending approval 时推**纯文本**通知卡(「请在终端/Web 处理,飞书内审批将于后续版本支持」)——M2b 把它升级为**带按钮的交互卡 + cardAction 回传**。

## M2b 范围(Plan 阶段按 §7A/§11B/§11E 与用户敲定确切边界)
核心目标:**让飞书能直接在卡片上批准/拒绝 approval、回答 user-input 结构化提问**(跨端:电脑/Web 弹出的 approval 转飞书也能答,物化在 snapshot,新接入即可见)。
- **approval/user-input 跨端交互(头牌)**:`derivePendingApprovals`/`derivePendingUserInputs`(抽共享)→ 渲成带按钮/表单的 CardKit 卡片 → cardAction 回调(bridge 自做 HMAC 验签)→ `respondToThreadApproval`/`respondToThreadUserInput`。单选→按钮组;多选/多问→ form(checkbox/select_static)+ 提交;「其他」→ input 框。
- **卡片渲染 v2 重设计(M2-todos A)**:整套布局重排——working 指示 vs 真 reasoning 面板区分(消除 `_thinking…_` 误解)、工具(started/updated/completed 聚合、内联 vs 折叠阈值、详情截断)、思考面板视觉层次、approval/user-input 卡片在其中的位置。按字节降级(30KB element 限)。reasoning 面板需 modelSelection 带 `thinking` option(走共享路径,非 bot 配置)。
- **接管卡渲历史**:`/resume` 接管时一次性 subscribeThread 取首帧 snapshot 渲近 N 条 messages 后即关(不起常驻 fiber,仍 mirror-light),替换 M2a 的纯状态文本卡。
- **§11E 补偿层补全**:**重启恢复 M18 完整版**(持久化卡片 messageId + 未决 requestId + lastSequence;重启读表→重连→snapshot 校正→对 awaiting-approval 重渲审批卡;无法接回旧卡片时新发一张+旧卡标失效);**通知 dedup 跨重启持久化**(M2a 仅首帧 baseline);**stale approval(M11)**;审计归属(每条 dispatch 落不可变 `(operatorOpenId,chatId,threadId,command,ts)`)。
- **群聊 + 话题**:按 §11 确认——大概率仍 **M3**;若属 M3 则 M2b 只私聊。
- (随上述一并)**默认配置收敛验证(M2-todos C)**:接已配置 server 时 bot 配置塌缩为 飞书凭证+连接+state。

## 需要用户提供
1. **飞书侧 cardAction 事件订阅**:开发者后台 → 事件与回调 → 订阅方式 → **使用长连接接收事件/回调** + 开启 **卡片回调(cardAction)** 事件。**无需** verification_token / encrypt_key / 回调 URL(长连接)。App ID/Secret 已在 `apps/feishu-bot/.env`。
2. **可验「跨端 approval」的 e2e 环境**(沿用 M2a runbook,已记 `feishu-bridge-m2-impl-facts.md`):单台 `serve` 自带 web(先 `pnpm --filter @t3tools/web build`)+ 浏览器 + 飞书 bot 同连一台;**把会话切 `approval-required`** 触发审批,在飞书卡片点「允许/拒绝」验回传,电脑端同步看到结果。
3. **产品决策**:卡片渲染 v2 的具体布局取舍、user-input「其他/自定义」交互、审计归属展示形态。

## 起步:M2b 第一动作
**先派 Plan + 多个并行 Explore sub-agent**,摸清:(a) `@larksuite/channel` 渲染带按钮/表单交互卡的确切 API(CardKit 2.0 button behaviors / form / formValue 回传形状)+ cardAction 监听如何加进 M1 的 `lark/channel.ts`;(b) 参考仓 `src/card/callback-auth.ts` + `dispatcher.ts` + `bot/` 的可移植部分(HMAC token 结构、nonce store、policyFingerprint),剥光其 CLI/session;(c) `derivePendingApprovals`/`derivePendingUserInputs` 抽到 client-runtime 的最小改动(web/mobile 改 import,bridge 复用);(d) 卡片渲染 v2 的布局设计(对照 §7A + M2-todos A 的痛点,产出布局方案供与用户确认);(e) §11E 重启恢复完整版(persistence 要持久化卡片 messageId/requestId/lastSequence 的接线);(f) stale approval(M11)的识别与卡片降级。产出 M2b 任务清单 + 需用户提供的飞书配置/环境清单,**与我确认范围(含卡片 v2 布局、群聊归属)后再动手**。不要直接开写。

---

> 提示:这份提示词配合 `feishu-bridge-design.md` + `feishu-bridge-design-review.md` + memory(`feishu-bridge-goal`、`feishu-bridge-m0/m1/m2-impl-facts`、`feishu-bridge-m2-todos`)使用,共同构成完整施工上下文。
