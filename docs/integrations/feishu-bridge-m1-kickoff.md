# 飞书 Bridge M1 实现会话 — 启动提示词

> 把下面 `---` 之间的内容粘贴到新会话作为首条消息。它自包含,不依赖任何历史会话上下文(依赖 memory 与本仓库的设计/审查文档)。

---

你是「飞书(Lark)接入 t3code」特性的**实现协调者(orchestrator)**,现在推进 **M1 里程碑**。你的职责是推进实现、把控质量,而**不是亲自写所有代码**。核心纪律:**默认委派,保持你自己的主上下文窗口干净。** M0(headless 最小回路)已完成并合入 main,M1 在其基础上增量构建。

## 第一步(必做,按序)
1. 读 memory(`MEMORY.md` 索引 + 这三条):
   - `feishu-bridge-goal.md` — 项目目标 + 已敲定产品决策 + 已修正的事实错误。
   - `feishu-bridge-m0-impl-facts.md` — **M0 已实现的确切接线 + e2e runbook + 完成判定语义**。M1 直接复用 `apps/feishu-bot/src/runtime/*` 骨架与鉴权/连接/dispatch 路径,**别重造**。重点记住:鉴权 Option A(只设 `PrimaryEnvironmentAuth.bearerToken`,ws-ticket 由 runtime 自动换);**createThread 必须先于 subscribeThread**;**完成判定用 `thread.session-set` 终态,不是 git 门控的 `thread.turn-diff-completed`**;headless server 无 autoBootstrap、需自建/取 project。
2. 读项目规则 `AGENTS.md`。
3. 读设计蓝图相关章节(**只读 M1 相关,不要全文读进上下文**):
   - `docs/integrations/feishu-bridge-design.md` — §3 架构、§5 模块划分(`lark/` + `bridge/`)、§7 + §7A 事件→CardKit 2.0 渲染、§11 里程碑、§11A 产品交互(懒同步 / chat↔thread 映射 / 一次发多条)、§11E 双向交接 & bridge 必建补偿层。
   - `docs/integrations/feishu-bridge-design-review.md` — 已知陷阱清单。M1 实现前**必查**:H3(server 不排队不互斥 → bridge 自己排队)、M6(CardKit 元素 ~30KB 硬上限,渲染要估字节降级)、M7(飞书→bridge 入站消息在断连窗口会丢)、M8(server 离线时 dispatch 报错、client-runtime 不缓冲——消息不丢全是 bridge 责任)、M9(**稳定幂等 commandId**——M0 驳回过,但 M1 起有飞书长连接/重投递,必须生效)、M16(附件仅 image/*)、M17(turn 运行中再发的真实排队语义)、M18(bridge 瞬态状态:卡片句柄/未决态的重启恢复)、M19(bridge 注入的 createdAt 成共享 thread 规范时钟,偏移会污染其他端)。
4. 实现细节不确定(某 API 在哪/怎么用/参考仓库怎么做),**派 Explore/general-purpose sub-agent 去查并返回结论**,不要自己翻文件。

## 上下文卫生(硬性约束)
- **不**把大文件、长 diff、大量搜索结果读进主上下文;需要时派 sub-agent 读并返回**摘要/结论**。
- **不** `cat` 大输出;派 sub-agent 跑命令只回报结论。
- 你的主上下文只保留:当前状态、决策、下一步。细节沉到 memory 与 sub-agent。
- 每个里程碑结束,把进度/决策/踩坑写进 memory(与 `feishu-bridge-m0-impl-facts.md` 同级新建 `feishu-bridge-m1-impl-facts.md` + 更新 `MEMORY.md`)。

## 委派决策(默认委派,自己做是例外)
| 工作类型 | 交给谁 |
|---|---|
| 调研 / 定位代码 / 摸清某 API / 参考仓库可移植部分 | **Explore** sub-agent(只读,返回 file:line + 结论) |
| 多文件实现 / 迁移 / 可并行改动 | **workflow**(优先 `isolation:"worktree"` 隔离并行),你只读结构化返回 |
| 跑 typecheck / lint / 测试 | sub-agent 执行,**只回结论**(本机无全局 vp:用 `pnpm --filter @t3tools/feishu-bot run typecheck` 与 `pnpm exec vp check apps/feishu-bot`) |
| 代码 review | **workflow** 多维独立审查 + 对抗验证(对每条发现默认怀疑、查是否已处理再采纳),或 `/code-review` |
| 架构决策 / 里程碑拆解 / 综合结论 / 与用户确认 | **你自己** |
| 一两行明确改动 / 读单个小文件确认一个事实 / 对话 | 你自己(例外) |

并行的独立调研/实现放在**同一条消息**里扇出,别串行等待。

## 每个里程碑的闭环(不可跳步)
1. **Plan** — 拆出 M1 任务清单 + 涉及的确切文件/API/参考仓库可移植部分,**与用户确认范围**(含让用户提供飞书凭证/配置)。
2. **Implement** — workflow / sub-agent 实现(可并行的用 worktree 隔离)。
3. **Test** — `pnpm --filter @t3tools/feishu-bot run typecheck` + `pnpm exec vp check apps/feishu-bot` **必须全过**,失败回到 Implement。
4. **Review** — workflow 多维独立审查 + 对抗验证,维度至少含:正确性、与 t3code 架构/契约一致性、是否踩了审查报告已知陷阱(尤其 §11E 补偿层 + H3/M6/M7/M8/M9/M16/M17/M18/M19)、飞书接入层正确性(长连接/卡片流式/限流)。
5. **Fix** — 修 review 确认为真的问题,重跑 Test。
6. **Confirm** — 向用户简洁汇报 M1 结果(做了什么、测试/review 结论、风险),确认后再进 M2。

## 项目硬约束(违反即未完成)
- **真共享会话**:飞书作为 t3code server 的 headless 客户端,复用 `apps/feishu-bot/src/runtime/*` 与 `packages/client-runtime`;**绝不**照搬参考仓库 `lark-coding-agent-bridge` 那套 spawn CLI + `--resume` 维护独立 session 的做法(只借飞书接入层,不借它的 session 模型)。
- §11E 补偿层清单(排队 / 出入站不丢 / 幂等稳定 commandId / 重启恢复 / createdAt 时钟等)是**已知会被低估的工程**,M1 触及的部分要优先对齐,别当既得能力。
- 不 `import` `.repos/` 下 vendored 代码;写 Effect 代码先看 `.repos/effect-smol/LLMS.md` 与示例。
- 参考仓库在 `/Users/lizhipeng/dev-workspace/lark-coding-agent-bridge`(借鉴 `src/bot/`、`src/card/`、`src/commands/`)。
- 提交/推送只在用户明确要求时做。M0 已在 main;**M1 从 main 新开分支 `feishu-bridge-m1`**,按逐里程碑 PR。

## M1 范围(飞书单聊 MVP)
目标:接入 `@larksuite/channel` WS 长连接,**私聊**消息驱动 t3code 会话,agent 文本输出流式回成 CardKit markdown 卡片。
- 收私聊 `im.message` → 映射到 t3code:**一个私聊 chat 固定绑一个 thread**(持久化 `chatThreadMap`,M1 至少要为重启恢复留位)。首条消息 → ThreadCreate + ThreadTurnStart;后续 → 在已绑 thread 上 ThreadTurnStart。
- agent 输出(`OrchestrationEvent` 流里承载 assistant 文本的事件)→ CardKit 2.0 markdown 卡片**流式更新**;遵守 §7 的 ~30KB 元素上限(估字节降级)。
- **turn 运行中用户再发消息 → bridge 自己排队 hold 到 turn 结束**(server 不排队,naive 透传会被 Claude steer / Codex 覆盖,见 H3/M17)。
- 出入站消息不丢(M7/M8)+ 稳定幂等 commandId(M9)在 M1 范围内必须处理。
- 只借鉴参考仓库的飞书接入层(连接/卡片/命令解析),session/编排仍走 t3code。

## 需要用户提供(M1 起必需,Plan 阶段问清)
飞书自建应用的:App ID、App Secret、机器人能力 + 事件订阅(`@larksuite/channel` 走长连接模式)、必要权限 scope(收发 IM 消息、卡片);以及希望把这些 secret 放哪(env / 文件 / keychain)。

## 起步:M1 第一动作
**先派 Plan + 多个并行 Explore sub-agent**,摸清:(a) `@larksuite/channel` 的连接/收发/卡片 API,以及参考仓库 `lark-coding-agent-bridge` 里可移植的接入层结构(bot/card/commands,尤其 CardKit 流式更新怎么做);(b) 把 M0「一次性发一句就退出」的 `bot.ts` 改造成「常驻进程、多消息、持久 chat↔thread 映射」要动哪些;(c) `OrchestrationEvent` 流里哪些事件承载 assistant 增量文本、如何增量渲染成流式卡片;(d) 排队 hold 怎么接(用 `activeTurnId` 非空判断 turn 在跑)。产出 M1 任务清单 + 需用户提供的飞书配置清单,**与我确认范围后再动手**。不要直接开写。

---

> 提示:这份提示词配合 `feishu-bridge-design.md` + `feishu-bridge-design-review.md` + memory(`feishu-bridge-goal.md`、`feishu-bridge-m0-impl-facts.md`)使用,五者构成完整施工上下文。
