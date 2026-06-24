# 飞书(Lark)接入方案审查报告

## 总体评价

方案整体**架构判断扎实、方向正确**：把飞书定位为 t3code server 的 headless 客户端、复用 `client-runtime` 与同一 `threadId` 实现真·跨端会话共享，这一核心结论经多维度核查站得住——多 WS 客户端可并发订阅同一 thread、重连重订阅可白嫖、bot 接入可大量借鉴参考仓库。已确定的几项产品决策（懒同步、会话映射、群聊默认收紧、多消息排队）思路合理。

但文档在**两个层面**存在系统性偏差，需要在落地前修正：

1. **对 t3code 服务端原语的理解有多处事实错误**——尤其把 `replayEvents` 当成 per-thread/接续的复用点、把 `getArchivedShellSnapshot` 当成活跃会话发现入口、把"群聊只读"映射到一个根本不存在的 `runtimeMode` 值。这些会直接误导实现者走错路径或构建出失效的核心卖点。
2. **大量"server 会替你兜底"的隐含假设不成立**——排队、turn 互斥、权限分级、消息不丢、幂等、审计归属、截断，server 端几乎都不做，责任全在 bridge。文档把它们当既得能力，实则是必须自建的核心工程。

### 最该优先处理的 Top 5

1. **【high】`/resume` 会话发现路由错误**：用 `getArchivedShellSnapshot` 只能列出已归档会话，恰好漏掉用户在终端正开着、最想接管的活跃会话——直接打脸"真·跨端接续"核心卖点。改用 `subscribeShell`/`getShellSnapshot`。
2. **【high】群聊"默认只读 runtimeMode"在 schema 层落不了地**：`RuntimeMode` 无 `read-only` 值，且系统默认是最危险的 `full-access`，字段还必填。群聊权限模型的安全支点失效，需改用 `approval-required` 并显式写死默认值。
3. **【high】server 无 turn 队列，"排队"是纯 bridge 责任且 provider 行为分裂**：naive forward 第二条消息，Claude 会 steer 进当前 turn、Codex 会覆盖 activeTurn——绝不是排队。这是会静默破坏用户体验的实现陷阱。
4. **【high·盲区】懒同步与"异步通知入口"自相矛盾 + 成本/配额完全缺失**：默认静默屏蔽了最该通知的 approval 卡死、危险写操作、turn 失败；多人共用机器额度无 per-user 配额/归因。
5. **【high·盲区】多飞书用户共用单一机器身份的连锁影响**：审计归属、per-user 吊销、成本归因、scope 不可细分（operate=全写）在 server 侧均无法落地，全部需 bridge 补偿。

---

## Critical

无 critical 级问题。所有事实错误均处于"设计文档待评审"阶段，可在落地前低成本修正，无运行时/数据不可逆影响。

---

## High

### H1. `/resume` 会话发现路由错误：`getArchivedShellSnapshot` 只返回已归档会话

- **问题**：§9 用 `replayEvents(0)` 或 `getArchivedShellSnapshot` 重建 `/resume` 列表。但 `getArchivedShellSnapshot` 查询 `archived_at IS NOT NULL`（`ProjectionSnapshotQuery.ts` `listArchivedThreadRows`），只返回**已归档/已关闭**会话。活跃会话走 `getShellSnapshot`（`archived_at IS NULL`，由 `subscribeShell` 暴露，`ws.ts:1060`）。
- **影响**：`/resume` 列表只列出已关闭会话，恰好漏掉用户在终端正开着、最想接管的活跃 thread——与 §11A"真·跨端接续，终端开的会话飞书直接续聊"和 M2 验收点直接矛盾，核心卖点失效。
- **建议**：`/resume` 会话发现改用 `subscribeShell`（首帧 `OrchestrationShellSnapshot` 含活跃 projects+threads），或复用 `client-runtime` 的 `state/shell.ts`。`getArchivedShellSnapshot` 仅用于"列历史/已归档会话以便 unarchive"辅助场景，文档需区分这两类。

### H2. 群聊"默认只读 runtimeMode"在契约中不存在（合并多条同源发现）

- **问题**：§11A 第 183 行"群聊 turn 默认 `runtimeMode` 为只读"。但 `RuntimeMode` 字面量仅 `approval-required`/`auto-accept-edits`/`full-access`（`orchestration.ts:117-122`），无 `read-only`（`read-only` 属于另一条正交轴 `ProviderSandboxMode`，且该枚举在 server 编排中未接线）。`DEFAULT_RUNTIME_MODE = full-access`（最危险档），且 `ClientThreadTurnStartCommand.runtimeMode` **必填**（:612），无法靠"省略=沿用 thread 默认"。
- **影响**：群聊权限模型的安全支点在 schema 层落不了地。多人群空间缺省 `full-access` 尤其危险，与"群默认收紧"意图相反。`approval-required` 也≠只读（仍可执行，只是要批）。
- **建议**：
  - 群聊默认改用 `runtimeMode=approval-required`（每个写/执行动作走审批卡片）表达"默认不放权"，提权=切 `auto-accept-edits`/`full-access`。
  - `commandTranslator` 必须为每个 turn **显式**写死群/私聊默认 `runtimeMode`（字段必填，不能省略）；私聊"沿用默认"需先读 `OrchestrationThread.runtimeMode` 再回填。
  - 若产品确需"群里完全不能改"的真只读，需在 bridge 层拦截（禁止触发写工具的 prompt），t3code server 不提供该保证；并确认 `ProviderSandboxMode` 能否由 client 命令设置还是只能 thread/instance 层配置。

### H3. server 不排队、不互斥：turn 运行中再发消息会 steer/覆盖（合并多条同源发现）

- **问题**：§11A"turn 运行中又发：默认排队，卡片显示已排队 N 条"。但 server 端**没有任何 turn 排队或 busy 拒绝**：`decider.ts:389` 处理 `thread.turn.start` 不检查 `activeTurnId`；`ProviderCommandReactor` fork 出 `sendTurn` 后立即返回；到 provider 层两家行为还不一致——`ClaudeAdapter.sendTurn`(:3648) 明确把"运行中再发"当 **steer**（注入同一 turn、复用 turnId），`CodexSessionRuntime.sendTurn` 则无条件再发 `turn/start` **覆盖** activeTurn。`ProjectionPipeline.ts:1057` 也确认"新 turn supersede 旧 running turn"。web 客户端同样不排队。
- **影响**：bridge 若 naive forward 第二条消息，对 Claude 是把用户消息静默注入正在跑的 turn、对 Codex 是覆盖——"已排队 N 条"语义静默失真，用户正在跑的 turn 被默默打断。这是会导致实现期踩坑的高发陷阱。
- **建议**：
  - 明确"排队是 bridge 责任"：bridge 监听 turn lifecycle（订阅 `OrchestrationSession.status/activeTurnId`），`activeTurn` 存在时 hold 后续消息，turn 完成/中断后再 dispatch。
  - 文档需并列说明两种产品选择并默认选 (A)：**(A) 真排队**（等当前 turn 结束串行发）；**(B) 透传 steer**（运行中发立即注入，借 Claude 原生 steer，但 Codex 不支持需降级）。注明 Codex/Claude 差异。

> **关联 low 项（一并处理）**：`ThreadTurnInterruptCommand` 的 `turnId` 在 server 端被忽略（按 session 打断，`ProviderCommandReactor.ts:882` "interrupt by session"），"停止"永远作用于当前活跃 turn。文档应弱化"按 turnId 停止"预期；"取消某条排队消息"靠 bridge 本地队列移除，与 server interrupt 是两条链路，卡片上应给两类不同按钮。

---

## Medium

### M1. 断线重连复用机制描述错误：是 snapshot 重发，不是 `replayEvents` 补齐（合并多条同源发现）

- **问题**：§9/§13 称"supervisor 自动 `replayEvents(fromSequenceExclusive=last)` 补齐缺失事件——无需自己实现"。但 `replayEvents` 在 `client-runtime`/web/mobile **零调用**（仅 server 端暴露 handler）。真实重连机制是 snapshot 驱动：`subscribe()` 用 `SubscriptionRef.changes(supervisor.session)|>switchMap` 在新 session 上重发 `subscribeThread`，server handler 每次订阅先 `Stream.concat(snapshot, liveStream)` 下发**完整 thread 投影 snapshot** 再接实时流；`OrchestrationSubscribeThreadInput` 只有 `threadId`、**不接受 sequence 游标**。
- **影响**：对 web/mobile（reducer，snapshot 幂等替换）无碍。但 bridge 是把事件流 append 渲染成流式卡片：重连后收到的是全量 snapshot（非 delta），既不能简单 append（丢中间过程），也不能无脑重放（重复渲染历史）。文档把这块当"复用即可"，实为 bridge 必须自己处理的核心难点。
- **建议**：重写 §9，明确接续/重连复用点是 `subscribeThread` 的"snapshot+live"语义而非 `replayEvents`。bridge 恢复策略二选一：(a) 重连后显式 `replayEvents(fromSequenceExclusive=本地持久化 lastSequence)` 拉增量再 append；(b) 把 snapshot 映射成"重建/刷新卡片"而非"追加事件"（与 §11A 的 `/resume` 全量重建模型一致，推荐）。无论哪种，bridge 都须自己持久化每个已接管 thread 的 `lastSequence`。落到 M2/M4 工作量。

### M2. `replayEvents` 是全局事件日志，不是 per-thread/shell 查询（合并三条同源发现）

- **问题**：`OrchestrationReplayEventsInput` 只有 `fromSequenceExclusive`、无 `threadId`；server `readEvents = readFromSequence(cursor)` 返回**跨所有 project/thread 的全量全局事件日志**（output 是 `Array(OrchestrationEvent)`，非 snapshot）。文档多处误用：
  - §11A/§11D `/resume` 后 `replayEvents(0) 回放完整历史`——subscribeThread 首帧已是该 thread 物化 snapshot，再叠 `replayEvents(0)` 既冗余又会拉全局流。
  - §9 `replayEvents(0) 重建 shell 快照（含 projects/threads 列表）`——它返回原始事件数组，要拿列表得客户端把整条全局日志重投影一遍。
- **影响**：`replayEvents(0)` 在跑过一阵的 server 上拉回全量历史（成本是全局级非单 thread 级），bridge 还得自己按 `aggregateId` 过滤再 reduce；"回放该 thread 完整历史/重建 shell 列表"语义错误，会让实现走弯路。
- **建议**：
  - 接管某 thread → 直接 `subscribeThread`（首帧 snapshot 即完整会话），删除追加的 `replayEvents(0)`。
  - `/resume` 列表数据源 = `subscribeShell`（活跃）+ `getArchivedShellSnapshot`（归档），`client-runtime` 已维护 shell 投影。
  - 若坚持用 `replayEvents` 做审计/补洞，明确它是全局日志、需按 `aggregateId` 过滤，并永远带高水位游标（`0` 仅冷启动且限流）。

### M3. token 续期方案不成立：pairing 一次性 + 5 分钟过期、无 refresh（合并 auth 多条）

- **问题**：§8/§12 称"access token 到期前自动用 pairing 续期"。但 pairing 凭证由 `issueOneTimeToken` 签发、`consume()` 后即焚、默认 TTL 仅 5 分钟，`issuePairingCredential` 端点不暴露 ttl 入参；全代码无 `refresh_token`/`renew`/`reissue`。access token TTL 固定 30 天（`DEFAULT_SESSION_TTL`，不可按请求设置），且**带 DPoP 时硬编码 1 小时**（`EnvironmentAuth.ts:708`）。
- **影响**：一张 pairing 只能 5 分钟内换一次 token、换完即焚；30 天 token 到期后 bridge 无自动续期手段。叠加 DPoP（被列为"可选增强"）后每小时就要重拿 token 而无续期——DPoP 对无人值守 bridge 实际不可用。文档未点出此矛盾。
- **建议**：
  - 删掉"自动用 pairing 续期"措辞，改为"接受人工续期 + 到期前主动告警（飞书通知管理员重新 `/pair`）"。
  - 或暴露 `ttl` 入参签发长 TTL pairing（底层 `issueOneTimeToken`/`createPairingLink` 已贯通 ttl，改造轻量），或改用 `issueSession` 签发带 ttl 的 bot bearer 会话。
  - "可设 30d TTL"改为"固定 30 天，不可按请求调整"；明确 headless bridge 应用 **bearer 而非 DPoP**（DPoP=1h 无续期）。

### M4. scope 无法细分 + 多用户共用机器身份：权限/审计/吊销结构性缺失（合并 auth 多条）

- **问题**：server 侧 orchestration 只有两档 scope——snapshot 走 `orchestration:read`，所有写命令（`ThreadTurnStart`/`ApprovalRespond`/`CheckpointRevert`/`TurnInterrupt`）共用 `orchestration:operate`。orchestration 命令 schema 无 `actor/operator/senderId` 字段，dispatch 只校验 scope、不记发起人；bridge 用单一 `subject="one-time-token"` principal 落地所有飞书用户指令；`revokeClient` 吊销整条 session（一踢全踢）。
- **影响**：
  - "群聊只读/提权""approval 门禁"这些权限边界 server 端**无法强制**，纯靠 bridge 自律；operate token 一旦泄露 = 对任意 thread 发 full-access turn / revert，server 不拦。
  - server 端审计无法区分"是哪个飞书用户驱动了某次 turn / revert"；无法对单个飞书用户吊销。
- **建议**：
  - 文档如实写明"server 端只见 bot 一个 principal、operate=全写、无更细 scope、飞书用户身份不进 server"。
  - 审计责任落到 bridge：为每条 dispatch 持久化不可变审计日志 `(operatorOpenId, chatId, threadId, command, policyFingerprint, ts)`，定位为 server 端审计的唯一合规来源；考虑在 prompt/metadata 注入"发起人"。
  - token 按高敏感存储（OS keychain/加密 secret store，非明文 env），并备好快速 `revokeClient` 吊销预案（contracts 已有 `AuthRevokeClientSessionInput`）；评估是否真需要 `terminal:operate`。

### M5. 群聊隐私边界缺强制机制：读权限 ≠ 群可见性

- **问题**：§11C(f) 承认群聊隐私问题，但机制只有 `access.ts` 的 allowlist + 群默认只读。allowlist 控制"谁能驱动 agent"，控制不了"谁能看到 agent 回流的内容"——只要在群里，所有成员（含非 allowlist）都能看到 bridge 渲染的文件路径/diff/密钥/私有源码；`/resume` 回放更会把整段私有历史灌进群话题。
- **影响**：私有代码对全体群成员可见，是结构性数据暴露，仅靠 allowlist 不足。
- **建议**：明确区分"驱动权限(allowlist)"与"可见性(群成员全可见)"两层：(1) 群聊默认不回流敏感内容（diff/文件/密钥）到群卡片，只给摘要+深链（把 §7 取舍重定位为隐私控制）；(2) `/resume` 回放历史前提示"该会话历史将对全体群成员可见"并确认；(3) secret 输出脱敏；(4) 文档明确"敏感仓库不绑群聊，只走私聊"。

### M6. CardKit 卡片大小/元素上限是真实硬约束，文档未量化

- **问题**：参考仓库 `run-renderer.ts:116-127` 明确记录：单元素序列化超 ~30KB 触发飞书 400 并 **abort 整条流式卡片**。为此参考仓库做了 `collapsedToolSummary`（丢工具 body 留 header）、`REASONING_MAX=1500`、≥3 工具折叠等一整套防御——这些都在 renderer 层（即 bridge 要重写的那层）。t3code 的 `OrchestrationEvent`（diff/terminal/长文本）比参考仓库丰富得多。文档只在 §11C(d) 一句"截断+深链"带过，无量化。
- **影响**：一条大 diff turn 会让整张流式卡片 400 报废、流式中断，比"内容被截断"严重得多。重写 renderer 时这些防御最易丢失。
- **建议**：把 CardKit 限制写成显式约束清单（单 element ~30KB、总卡大小/元素数、超限=400 报废整条流）。`eventRenderer` 状态机必须"每 element 渲染前估字节、超阈降级折叠/截断"（移植参考仓库 `collapsedToolSummary` 思路）。从 §11C(d) 一句话提升为 **M1 必做项**。

### M7. 飞书→bridge 入站消息在断连窗口会丢失，无法靠 client-runtime 解决

- **问题**：§9 称重连"无需自己实现"，但 `replayEvents` 只补 server→bridge 方向。飞书长连接对 IM 事件无 offset/replay，bridge 重启/WS 卡死期间用户发的 prompt 直接丢失；参考仓库 keepalive/reconnect 只拉回连接、不补消息。
- **影响**：文档把两个方向的"补齐"混为一谈，让人误以为入站消息零丢失。
- **建议**：区分两个方向。入站丢失需单独策略：(a) 重连后提示"我可能漏看了断线期间的消息，请重发"；或 (b) 用 `im.v1.message.list` 按 chat+时间窗补拉。加入 M4 并明确"不是免费的"。

### M8. server 离线时 dispatch 直接报错、client-runtime 不缓冲——"消息不丢失"全是 bridge 责任

- **问题**：`dispatch()` 走 `request()`，session 为 `Option.none()`（离线/重连中）时立即 `EnvironmentRpcUnavailableError`，`client-runtime` **无任何出站命令缓冲/重试队列**。§11C(e) 只说"明确反馈"——那是 web/mobile 的 fail-and-retry 模式。
- **影响**：飞书是异步 IM，用户发完即走、期待"server 回来照常执行"。"远程接管/异步通知入口"这一核心卖点恰恰最依赖"server 临时离线时收下消息、回来补发"，而该能力 client-runtime 不提供、文档未列为 bridge 必做项。
- **建议**：bridge 增"出站命令持久化队列"：收消息→落库（chatId/threadId/operator/payload）→给回执（reaction ⏳ 或卡片"server 离线，已记下，恢复后执行"）→supervisor 变 connected 时 flush。需考虑离线堆积的合并/排序、flush 时 thread 已被他端占用的排队、超长离线(>TTL)丢弃。列为 M1/M4 明确交付项。

### M9. commandId 幂等只在 server 去重，bridge 必须生成稳定 commandId

- **问题**：server 幂等可靠（`OrchestrationEngine` 按 `commandReceiptRepository.getByCommandId` 去重），但前提是 bridge 对"同一逻辑意图"复用同一 commandId。飞书 at-least-once 投递、崩溃重启重放未确认消息、断线重连重发——若每次新生成随机 commandId，server 视为不同命令，在共享 thread 里产生**重复 turn**。文档未规定派生规则与持久化（卡片回调 nonce 只部分覆盖 approval 子向量，`turn.start` 无保护）。
- **影响**：用户可见的重复 turn + 污染持久事件流。
- **建议**：规定 commandId 确定性派生（`turn.start` 用 `hash(chatId+threadId+飞书messageId)`，approval/user-input 用 `hash(requestId+decision)`），在 `chatThreadMap` 同库持久化已发 commandId/已确认 sequence，崩溃恢复前先查本地或依赖 server 幂等返回。

### M10. `chatThreadMap` 持久化与两侧对账缺细节（合并孤儿 threadId 相关发现）

- **问题**：§5/§9/§11C(h) 依赖 `chatThreadMap` 做恢复，但未规定：(1) 写入时机/原子性（map-write 与 `thread.create` 确认之间崩溃→悬空映射或丢映射）；(2) 同一 chat 行的并发写（私聊活跃 thread 切换 + 群多话题并行 @bot）；(3) **对账**——终端/Web 端 `thread.delete`/`archive` 后 `subscribeShell` 发 `thread-removed`，bridge 映射变悬空、`subscribeThread` 得 `GetSnapshotError`。**懒同步默认不订阅 shell 流时根本收不到 removed 事件**，会留下永久指向死 thread 的飞书群。
- **影响**：bridge 与 server 状态不一致的对账盲点，下一条群消息 dispatch 失败或静默错位。
- **建议**：(1) 映射写入与 `thread.create` 用同一 commandId 幂等，崩溃恢复用 `subscribeShell` 快照核对有效性；(2) per-chat 写串行化/加锁；(3) 订阅 `subscribeShell` 的 `thread-removed`/archive，自动失效本地映射并提示"该会话已在其他端删除/归档"。

### M11. approval/user-input 的 requestId 失效后 server 不报硬错、产 stale failed 活动

- **问题**：§11B 把审批按钮映射成 `ThreadApprovalRespondCommand`(带 requestId)，但未说 requestId 失效后的处理。server 行为：requestId 已不在 pending 集合（turn 结束/已被他端先点/SDK 超时清理）时，catch `isUnknownPendingApprovalRequestError` 并 append `provider.approval.respond.failed` 活动（detail=stale），**不返回 RPC 错误**。web 端专门有 `isStalePendingRequestFailureDetail` 识别并 UI 降级。
- **影响**：多人多端高发竞态。bridge 不做等价处理，用户点按钮后 dispatch "成功"了但实际 no-op 失败，卡片毫无变化。
- **建议**：`eventRenderer` 订阅并识别 `provider.{approval,user-input}.respond.failed`，把卡片更新为"此请求已失效（turn 已结束/已被他端处理）"。按钮回传后不能假定 dispatch 成功=被采纳，要等后续事件确认；同一 requestId 本地去重/置灰（点过即禁用）。在 §11C 补"stale/duplicate approval 响应"项。

### M12. 懒同步默认不订阅，与"飞书发起 turn 需实时感知 approval"冲突

- **问题**：§11A 懒同步"默认不订阅任何 thread"，但 §11C(a) 说审批必做否则 turn 挂死。审批/排队判断都依赖实时 `subscribeThread` 拿 `status/activeTurnId/approval-requested`。§9 又写非 `/resume` 入口"一律 `dispatchCommand`"却未要求先 subscribe——这是丢失 approval 的窗口。
- **影响**：飞书用户在 `/new` 或私聊活跃 thread 直接发消息触发 turn，若未先订阅，approval 事件落在订阅窗口外，turn 静默挂死。
- **建议**：明确订阅生命周期——任何由飞书发起 `turn.start` 的 thread（私聊活跃 thread、群被 @ 话题）必须在 dispatch 前先 `subscribeThread`，维持到 turn 终态 + approval/user-input 全部 resolve。懒同步只适用于"纯终端发起、飞书未接管"。保证 subscribe 与 dispatch 间无事件丢失窗口（先 subscribe 再 dispatch）。区分"飞书主动驱动(强订阅)"与"仅观察(懒订阅)"。

### M13. 私聊"单一活跃 thread"模型未覆盖并行多任务

- **问题**：§11A"私聊维持一个当前活跃 thread"。但真实场景用户常想"让 A 后台跑长任务，同时在 B 问别的"。切到 B 后 A 的事件流向哪里未定义（懒同步只订阅活跃 thread？切走即不再镜像？）。文档自称"异步通知"却默认零订阅，自相矛盾。
- **影响**：用户回切才发现 A 早跑完/出错，核心异步通知卖点落空。
- **建议**：定义私聊多 thread 并发模型——是否允许同时订阅多个；非活跃 thread 完成/出错时发轻量通知（@你+深链）拉回；`/resume` 列表标注各 thread running/done/error 状态与未读。明确"活跃 thread"只是输入路由默认目标，而非订阅范围限制。

### M14. 群话题(topic)=thread 映射未处理话题归档/无 topic 退化

- **问题**：§11A"飞书话题=一个 thread"。两个未覆盖边界：(1) 话题被归档/关闭后，对应 thread 仍在 server 持有 running session 成孤儿，用户无法续聊也收不到通知；(2) 群内非话题区 @bot 消息无 topicId——映射到哪个 thread 未定义。
- **影响**：直接影响群聊可用性。
- **建议**：话题归档时定义行为（interrupt+stop 对应 session，或允许下次 `/resume` 在新话题接管同 threadId）；群内无话题 @bot 给确定性 thread 选择（建议强制群内话题内 @bot，否则提示开话题，避免群级单 thread 串话）。

### M15. workspace/project 切换误操作防护缺失 + `/cd /ws` 来源未澄清

- **问题**：§11A 心智"一群=一仓库"，但 §11B"切换仓库/分支"映射 `ThreadCreateCommand`、§5 又列 `/cd /ws`。(1) 群里 `/cd` 切到别的 project 破坏心智、误操作后续话题全错仓库，无二次确认；(2) `ThreadCreateCommand` 需 `projectId/title/modelSelection/runtimeMode`（均必填），飞书用户如何选 project/branch（列表从哪取、模糊输入/自然语言歧义解析）完全没设计。
- **影响**：误改后续整条话题执行目标；项目选择无来源会逼实现做不可靠的自由文本解析。
- **建议**：群聊建议锁定 project（切仓库=换群或高权命令+确认卡片）；project/branch 选择走 shell snapshot 的 projects 列表→选择卡片，避免自由文本解析；切换类操作加确认卡片。

### M16. 附件双向方案与契约不符：t3code attachment 仅支持 image/*（合并多条同源发现）

- **问题**：§11C(c)"附件双向（飞书图片/**文件** ↔ t3code attachment）"。但 `ChatAttachment`/`UploadChatAttachment` 是 image-only（`mimeType` 强制 `/^image\//`，仅 union `ChatImageAttachment`）。`message.attachments` 只接受图片。即飞书的 PDF/源码/日志等非图片文件**根本没有合法的 t3code 入站通道**。图片还有硬上限：单图 ≤10MB、data URL ≤14M 字符、单轮 ≤8 张，超限 server schema decode 直接拒绝整条 turn。
- **影响**：文档承诺了当前契约无法满足的能力（文件双向），且大图会触发整条 turn 失败/静默丢附件。
- **建议**：明确 (1) 入站只有 image/* 可直达 attachment，飞书文件需旁路（落盘到 project workspace 再在 prompt 引用路径，或上传可访问 URL 让 agent 用工具拉取），而非塞 attachments；(2) 明列 10MB/14M-char/8 张上限与超限反馈（拒绝/压缩/降级链接，可移植参考仓库 `rejectionReason` 机制）；(3) agent 产出文件→飞书走 `getTurnDiff`/文件读取，非 attachment 协议。

### M17. "turn 运行中再发=排队"与参考仓库 PendingQueue 实际语义不符

- **问题**：§11A 将"排队 N 条"与参考仓库 `PendingQueue` 关联，但 `PendingQueue` 实际是 run 活跃时 block、累积消息、unblock 后**合并成下一批的一个 prompt**（非排队成 N 个独立 turn）。文档第 187 行对 600ms 合并的引用是正确的，但第 188 行的 run-active 场景语义二义（合并成一条 vs 真排队多 turn）未澄清，且后者是参考仓库没有的新机制。
- **影响**：误导实现者去做参考仓库不存在的"多 turn 队列"，或对单 `activeTurn` 串行化的配合方式不清。
- **建议**：明确选定语义。若沿用参考仓库行为：写成"运行中消息合并，turn 结束后作为一条后续 prompt 发送"，卡片提示改"已收到 N 条，将在当前回合结束后合并处理"；若要真排队多 turn，说明是新机制并与单 `activeTurn` 串行化配合。不要把"排队 N 条"算作参考仓库已有能力。（与 H3 配合处理。）

### M18. bridge 自有瞬态状态（卡片句柄/未决 approval）重启恢复语义不完整

- **问题**：§9/§11C(h)"映射持久化+replay"只覆盖 chat↔thread 映射。重启后真正难的是：(1) **CardKit 流式卡片句柄**（靠 messageId+序号持续 update()），进程重启后"哪条卡片对应哪个 thread 的哪个 turn"丢失，重连拿 snapshot 接不回原卡片，留下永远停在"执行中"的僵尸卡片；(2) **未决 approval**——若在"已弹审批卡片、用户未点"时重启，server 端 turn 仍挂起等 respond，bridge 能否把恢复出的 requestId 重新绑回卡片按钮未设计（与 §11C(a)"必做否则挂死"直接冲突）。nonce store 已覆盖。
- **影响**：审批子项有功能性后果（turn 可能挂死）；僵尸卡片误导用户。
- **建议**：定义持久化状态表至少含 `threadId/chatId/卡片 messageId/activeTurnId/未决 requestId/lastSequence`。重启恢复：读表→重连 subscribe→用 snapshot 校正→对"仍 awaiting-approval"的 turn 重渲/复用审批卡片（requestId 来自 snapshot 而非内存）。定义"无法接回旧卡片时"兜底（新发一张+旧卡片标失效）。单列进 §11C(h)。

### M19. bridge 注入的 createdAt 成为共享 thread 规范时间戳，时钟偏移会污染其他端

- **问题**：`IsoDateTime` 在契约里只是裸 `Schema.String`（无格式/时区校验），server decider 对 `thread.turn.start`/`project.create`/`thread.create` 直接用 `command.createdAt` 作 `occurredAt` 写投影。跨端排序依赖 `createdAt`。
- **影响**：飞书消息在共享 thread 的显示/排序时间完全由 bridge 注入；若用本机偏移时钟、或直接拿飞书 `create_time(ms)` 未转 UTC ISO，会让终端/移动端看到错序/错时消息，且事件溯源写入后不可纠正。（注：headless 复用 `client-runtime` 的命令构造器默认即取 `DateTime.now→formatIso`，走既有 builder 即自动正确——风险主要来自时钟漂移或刻意覆盖。）
- **建议**：§6/§11B 明确 bridge 构造命令的 createdAt 一律用 UTC ISO-8601（沿用 client-runtime 默认），**禁止直接把飞书 `create_time(ms)` 当 createdAt**；可在握手后做一次时钟偏移校准。点明 `turn.start` 等命令的 createdAt 会成为共享时间线的规范时间。

---

## Low

以下为完整性补充或措辞修正项，影响面小、修复廉价：

- **Reaction emoji 写成裸 unicode**：§11D 状态表的 ⏳/❌/⏹ 需换成飞书实际存在的具名 `emoji_type`（参考仓库传的是 `'Typing'` 字符串而非 ⌨️ 字符）。补一句 reactionId 持久化、换状态=remove+add 的生命周期（参考仓库已示范，"reaction 失败不阻断主流"已覆盖）。
- **`ThreadCheckpointRevert` 用 `turnCount` 非 `turnId`**：revert 按钮按"回退 N 个 turn"寻址（`checkpointTurnCount` 提供）；补一句 revert 应在无活跃 turn 时才允许（或先 interrupt 再 revert），decider 不校验活跃 turn。
- **多端并发竞态矩阵未展开**：§11C(g)"sequence 串行化"只保证日志有序、不保证 turn 互斥。补两端同点同一 approval、一端 interrupt 另一端正 respond 的处理（核心 mitigation 已在 §11A 排队模型隐含）。
- **入站 reaction "已确认支持"为不可复现断言**：本仓库未装 `@larksuite/channel`，无法核实 EventMap.reaction；改标"待 SDK 实测验证"，保持其"可选增强、主路径用签名按钮"定位。
- **`@larksuite/channel` 版本与 alpha 依赖未锁定**：`^0.2.0`（0.x 易漂移）+ 大量 alpha SDK 私有 knobs（`includeRawEvent→form_value`、`fetchRawMessage→thread_id` 绕 normalizer）。补"SDK 依赖与版本策略"节：pin 精确版本、列依赖的非稳定行为做升级回归 checklist、评估 fork/vendoring 兜底。爆炸半径限于飞书适配层。
- **大 diff/输出截断契约缺失**：`ThreadTurnDiff.diff` 是单个无界 `Schema.String`，无 `sizeBytes/isTruncated/分页`，server 整串发、bridge 全量持有再自截。明确截断阈值/按 hunk 边界/超大直接给深链不拉全量、`assistant.delta` 增量缓冲上限防 OOM/刷爆更新频率。
- **多机多 server 路由模型缺失**：§11C(k) 列了但无方案。需 chat→`environmentId`→threadId **三级**映射（现仅二级）。runtime 已是 per-environment supervisor、ConnectionTargetStore 已返回列表，能力存在，缺文档展开。（注：发现称 §6 `PlatformConnectionSource`/`ConnectionTargetStore` 描述自相矛盾不成立——二者是互补机制，非同一事物。）
- **idle 会话清理责任**：server 无自动 reap，懒同步下 bridge 是泄漏点（每接管一 thread 持一个 subscribe fiber+卡片状态+缓存）。web/mobile 靠 `Atom.setIdleTTL` 回收，headless 拿不到，需 bridge 自实现 idle 退订。区分"飞书侧退订(省资源)"与"server 侧 archive(改状态)"，bridge 不隐式 archive。
- **卡片/reaction 与 server 权威状态最终一致性**：缺"以 subscribeThread snapshot 为权威源重对齐"机制——重连或序号跳变时用快照 `activeTurnId/approval pending` 强制重渲卡片并校正 reaction，reaction 仅装饰、卡片正文须可从快照重建。
- **token 续期的 DPoP 密钥持久化 / 401 中途失效**：直连拓扑实际走 bearer broker（无 DPoP 密钥/无 thumbprint cache），DPoP 仅在 relay 拓扑接线，故"重启不变 DPoP 密钥"非直连路径要求。真正缺口窄：pairing TTL 耗尽/被 revoke 后无告警降级、WS 建链后 401/invalid_credential 中途失效未反馈飞书用户。补一句"检测 invalid_credential→重试+推送'凭证失效，请管理员重新配对'"。

---

## 完整性盲区（文档完全未触及的维度）

> 这些不是文档里写错的地方，而是整类被忽略的场景。

### 盲区 A【high】成本/计费归属与配额
t3code 已发 `thread.token-usage.updated`（带 input/output/used/maxTokens），每个 turn 都烧可计量额度。飞书把会话开放给"一群人共用一个 bridge 机器身份"后，任何成员发 prompt 都烧同一份账号额度，却**无 per-user 配额、限速到顶降级、成本归属**。多人群+懒同步接管会让额度被陌生成员或刷屏耗尽且无法归因（与 M4 共用身份叠加放大）。**需补**：token 预算、用量上限提醒、把 usage 事件渲染回飞书。

### 盲区 B【high】agent 主动副作用 / 后台长任务的通知语义（懒同步根本矛盾）
懒同步默认静默，意味着 agent 在终端侧自主完成的高影响动作（git commit/push、删文件、跑部署、worktree/branch 切换）飞书侧完全无感。把飞书定位为"异步通知入口"却又默认静默，自相矛盾——真正需要异步通知的恰恰是这些后台副作用和 approval 卡死。**需补**：一个"即使未接管也要 push 关键通知（approval 待处理、turn 失败、危险写操作）"的最小订阅/通知通道。

### 盲区 C【medium】国际版 Lark vs 中国版飞书双域/双租户
参考仓库按 `international` 标志在 `open.larksuite.com` 与 `open.feishu.cn` 间切换 domain，两者是隔离租户体系（不同 app_id/secret、事件域名、可能不同 CardKit/SDK 能力与合规要求）。文档通篇只说"飞书"，未说明目标版本、是否同时支持、域名/凭证/数据驻留如何随版本切换。

### 盲区 D【medium】测试/可验证性策略缺失
多处出现"SDK 已确认支持/不可验证断言"。`@larksuite/channel` 是有状态长连接、CardKit 渲染要真租户、approval 回传是多方时序——都无法单元测试覆盖。缺"契约层 mock server + bridge 翻译层纯函数测试 + staging 飞书租户端到端冒烟"的分层验证设计；M0-M4 无对应测试门禁。

### 盲区 E【medium】灰度/回滚与 bridge 版本演进对共享 thread 的污染
bridge 是单点常驻进程、写入共享 thread。升级/回滚期间若 `chatThreadMap` schema 或 commandId 生成逻辑变更，会在共享时间线留下不可回滚的脏 turn，并同时影响正在用终端/移动端的真实用户。缺灰度（先内部群再放开）、双写/迁移、"bridge bug 不能损坏其他端会话"的隔离与回滚预案。

### 盲区 F【medium】合规/留存：飞书侧与 server 双重留存、eDiscovery 与删除权冲突
代码/prompt/diff 同时存在于 t3code server(SQLite) 和飞书消息/卡片两套留存体系，飞书受组织合规/审计管辖。撤回只删 IM 不删 server（已提）；但反向——server 删了 thread，飞书里代码快照仍在——以及离职成员历史可见、监管导出义务，完全未纳入。

### 盲区 G【medium】并发会话/连接规模上限与水平扩展
未界定单 bridge 进程的并发 thread 上限、内存（大 diff/输出已是 OOM 点）随订阅数线性增长边界、超容量时拒绝接管还是水平扩多进程（多进程又各自下发 snapshot、抢同一机器身份，与多客户端仲裁叠加）。容量规划与水平扩展模型整体缺失。

### 盲区 H【medium】project/thread 被他端删除/归档时的失效驱动
契约有 `project-removed`/`thread-removed` 投影事件。终端/Web 删掉后飞书侧映射指向死 threadId，下条消息 dispatch 失败或静默错位。关键：这是**他端主动删除事件驱动**的，bridge 必须订阅消费这些 removed 事件来主动解绑/提示——而懒同步默认不订阅时根本收不到。（与 M10 强相关，但根因是 server 端主动事件。）

### 盲区 I【low】i18n / 多语言
卡片所有 bridge 自有文案（"已排队 N 条""在终端查看""允许/拒绝"）硬编码中文，海外 Lark/英文用户体验割裂；agent 输出语言由模型决定可能与群语言不一致；reaction 具名 key 是英文语义，混入本地化会再踩坑。

### 盲区 J【low】对现有 web/mobile 客户端的反向影响
新增 `deviceType:'bot'` 一等客户端后，web/mobile 会看到新 presence 来源、看到 bot 注入的 turn，可能影响"活跃端"判定、通知逻辑、turn 归属展示。文档只关心飞书侧，未评估加 bot 客户端对既有端的回归影响。

---

## 经审查证明站得住的部分（增强信心）

以下被对抗性核查驳回或确认无误，说明方案地基稳固：

1. **核心架构成立**：飞书作为 headless 客户端复用 `client-runtime` 即可实现真·跨端接续与断线重连——这一根本结论正确。即便 §9 的 `replayEvents` 实现路径描述有误，实现者按"复用 connection/supervisor/driver + client-runtime 状态"去做会自然走到正确的 `subscribeThread` snapshot 路径。
2. **client-runtime 不假设单一前台客户端**：多客户端可按 `(environmentId,threadId)` 各自并发订阅同一 thread，server 各自重发 snapshot，无前台独占概念——对"多端共享"是好消息。`AuthClientPresentationMetadata` 只上报 label/deviceType/os 不参与仲裁。
3. **流式 API 选型无误**：§7 已正确写明流式走 `channel.stream() producer 持续 update()、序号保序`，§11B 的 `updateCardById` 是按钮回传后的一次性卡片刷新（managed-card），两条链路文档已区分——"用错低阶 API"的质疑不成立。
4. **撤回分级里"排队中→从队列移除"已正确定位在 bridge**：文档 §5/§11A 把队列放在 bridge 侧，§11D"撤回事件可能延迟、按当下 turn 状态幂等处理"已覆盖竞态，并非"误以为 server 支持撤销未执行 turn"。
5. **提权不会因 runtimeMode 重启打断在途 turn**：群聊提权走 `ThreadApprovalRespondCommand`（approval-respond，turn 暂停后续接、无重启），而非 mid-turn 切 `runtime-mode.set`（后者才重启）。文档映射正确。
6. **斜杠命令歧义已被参考仓库逻辑覆盖**：`/tmp`、`/usr` 等非注册命令会 `return false` 落回普通 prompt（`commands/index.ts`），@bot 噪声治理（非提及 drop）随移植保留——这些借鉴层行为正确继承。
7. **`/resume` 列表能从 `replayEvents`/`getArchivedShellSnapshot` 重建**：`replayEvents` 是全局事件日志（非 per-thread），`replayEvents(0)` 确可枚举 projects/threads 生命周期事件——"无法枚举 thread"的质疑基于对 `fromSequenceExclusive` 的误解，不成立。（但活跃会话发现仍应优先用 `subscribeShell`，见 H1。）

---

**总结**：方案的"做什么"是对的，问题集中在"t3code 具体怎么做"的细节失准和"server 不兜底、责任全在 bridge"的隐含假设。建议先修正 H1-H3 三处会导致核心卖点失效/安全失守/实现踩坑的事实错误，再补齐盲区 A/B 这两处与"懒同步+多人共用身份"决策直接冲突的结构性缺口，其余 medium 项随 M1-M4 分阶段落地时逐条收口。

相关文件：
- 设计文档：`/Users/lizhipeng/dev-workspace/t3code/docs/integrations/feishu-bridge-design.md`
- 关键契约：`/Users/lizhipeng/dev-workspace/t3code/packages/contracts/src/orchestration.ts`（RuntimeMode:117-123、UploadChatAttachment:142-179、ClientThreadTurnStart:600-617、replayEvents:1213-1219）、`auth.ts`
- server 引擎：`/Users/lizhipeng/dev-workspace/t3code/apps/server/src/orchestration/`（decider.ts、ProviderCommandReactor.ts、ProjectionPipeline.ts、ProjectionSnapshotQuery.ts）、`ws.ts`、`auth/`
- client-runtime：`/Users/lizhipeng/dev-workspace/t3code/packages/client-runtime/src/`（rpc/client.ts、state/threads.ts、state/shell.ts、operations/commands.ts）
- 参考仓库：`/Users/lizhipeng/dev-workspace/lark-coding-agent-bridge/src/`（bot/channel.ts、card/run-renderer.ts、policy/access.ts、media/attachment.ts）
