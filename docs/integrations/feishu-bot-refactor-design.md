# feishu-bot 重构设计:拆解 bot.ts 巨闭包

> 状态:v2(已过 4 路对抗审查:代码事实 / 耦合边界 / 范围约定 / gpt-5.5 独立视角;
> 全部 major+minor 已折进本版)。
> 目标读者:实施者 + 审查者。本文是「把 4342 行 bot.ts 拆成显式依赖模块」的唯一施工蓝图。

## 1. 背景与诊断

`apps/feishu-bot/src/bot.ts` 现为 4342 行,其主体是单个 ~3500 行的 `Effect.gen` 闭包
`runBoundSession`(L381–3892),内部 ~40 个函数靠闭包共享 **30 项可变状态/资源**
(10-agent workflow 测绘结论)。问题:

- 任何改动都在一个 4342 行文件里定位/审查,故障排查与增量迭代成本高;
- 函数间依赖不可见(全靠闭包捕获),竞态/顺序不变量只存在于注释,散布在相距 900+ 行的位置;
- 与 pending 分支(如 pin-drift 修复)的冲突面 = 整个文件。

同文件已有良好先例:`bridge/shellWatcher.ts`(`ShellWatcherDeps` + `runShellWatcherFiber`)、
`bridge/commands/handlers.ts`(`CommandDeps` + `buildCommandTable`)——**显式 Deps 接口 + 工厂函数返回
handle** 是本仓已验证的拆分范式。本设计将 runBoundSession 内部按域收拢成同款模块。

## 2. 目标与非目标

**目标**
- bot.ts 收缩为「外层编排 + runBoundSession 装配体」(~650–850 行);
- 每个域一个模块:显式 `XxxDeps` 接口、工厂函数、模块内自有状态私有化;
- 行为字节级保持:所有函数体逐字搬运(允许的唯一改动 = 依赖从闭包捕获改为 deps 解构),
  注释(尤其竞态/红线注释)随行搬运,一条不丢;
- 每一步 typecheck + 103 单测保绿;终态过 `vp check` + `vp run typecheck`(AGENTS.md 门禁)。

**非目标**
- 不改任何运行时行为、不修 bug、不动契约(contracts 零改动)、不动 `bridge/callbackAuth.ts`
  / `bridge/interactionCard.ts` / `bridge/authz.ts` / `bridge/chatConfig.ts` 等已模块化红线件;
- 不引入新 `Context.Service`(测绘确认:现有 service 层够用,新模块全是接线体,沿用既有
  Deps-工厂范式);
- 不在本次重构中吸收 pin-drift 修复(见 §7);
- eventRenderer.ts(1677 行纯函数)拆分为**独立后续 PR**,不与本次混合。

## 3. 目标文件结构

全部平铺 `src/bridge/`(camelCase,仓内约定;相对导入带 `.ts` 后缀)。行数为预算非硬约束。
「Deps 要点」列只列**非显然项**(完整 Deps 以实施时 typecheck 为准,但下列点名项必须按此归属)。

| # | 新文件 | 预算 | 内容(来源行号@当前 bot.ts) | 导出 | Deps 要点 |
|---|--------|------|------------------------------|------|-----------|
| 1 | `bridge/modelSelection.ts` | ~160 | `isSelectionRoutable`(143–169)、`resolveModelSelection`(171–261) | 2 函数 | 无(RPC 走上下文) |
| 2 | `bridge/envAccess.ts` | ~130 | `makeBrandedId`(263–269)与 `makeEnvAccess(deps)` 工厂:`runOnEnv`(597–608)、`genId`(610–612)、`subscribeThread`(614–630)、`isEnvReady`(632–640) | 工厂 + handle 类型 + `makeBrandedId` | registry、environmentId、crypto |
| 3 | `bridge/notices.ts` | ~290 | decode 单例(271–284,唯一消费点在此)、placeholder 常量组 + `placeholderThread` 构造(642–690)、`makeNoticeThread`(692–706)、`sendNotice`(708–748)、`topicSendOpts`(339–360,**模块级导出**)、`renderTranscriptMarkdown` + 常量(840–872,注意 833–838 是无关的 PR2 架构注释,留 bot.ts)、`updateCardNotice`(3025–3043) | `makeNotices(deps)` → handle 含 `placeholderThread`/`makeNoticeThread`/`sendNotice`/`updateCardNotice`/`renderTranscriptMarkdown`;`topicSendOpts` 模块级导出 | gateway、genId |
| 4 | `bridge/workspaceGate.ts` | ~120 | `SelectedWorkspace` + `selectedWorkspaceFor`(767–795)、gate 文案(797–808)、`senderMayUseProjectAtDispatch`(810–831) | `makeWorkspaceGate(deps)` | workspace、shellCache、ownerRef/chatConfigsRef/chatDefaultsRef |
| 5 | `bridge/workspaceOps.ts` | ~160 | `describeError`(1637–1646)、`awaitProjectVisible` + 常量(1648–1667)、`createWorkspaceProject`(1669–1702)、`cloneWorkspaceRepository`(1704–1724) | `makeWorkspaceOps(deps)` | **裸 registry/environmentId/crypto**(不经 envAccess,见 §5.14)、shellCache |
| 6 | `bridge/interaction.ts` | ~200 | `staleRequestIdsOf`(286–317)、`CALLBACK_TOKEN_TTL_MS`(319–320)、`buildInteraction`(1339–1425) | `makeInteractionBuilder(deps)` + **`staleRequestIdsOf`** + 常量 | auth、chatOperators、chatResolvedNotices |
| 7 | `bridge/observeMirror.ts` | ~750 | observe 注册表整簇:`ObserveState`/`activeRenderFibers`/`nextObserveToken`(1045–1082,**模块私有**)、`isObserving`(1084–1088)、`stopObserve`(1090–1111)、`stopMirror`(1113–1118)、`ensureObserving`(1120–1248)、`renderObservationToCard`(1769–1965)、`runObserveFiber`(1967–2183)、`surfacePendingApprovalIfNew`(1427–1606)、`startMirror`(874–1038) | `makeObserveMirror(deps)` → handle | rootScope、gateway、bindings、cardHandles、shellCache、chatOperators、buildInteraction、resolveDensity、isChatBusy、subscribeThread、sendNotice、**placeholderThread**(经 notices handle)、renderTranscriptMarkdown、topicSendOpts、genId、turnQueue(仅经 isChatBusy) |
| 8 | `bridge/turnRunner.ts` | ~480 | `buildTurnStart`(1301–1337)、`driveTurn`(2185–2269)、`OfflineStrategy`/`offlineRetry`/`offlineBuffer`(2271–2302)、`runTurn`(2304–2521)、`chatTurnLocks`+`withChatTurnLock`(1269–1289,**模块私有**) | `makeTurnRunner(deps)` → `{ runTurn, offlineBuffer }` | **裸 registry/environmentId/crypto**(§5.14)、turnQueue、sent、outbound、gateway、stopObserve、renderObservationToCard、resolveDensity、sendNotice、subscribeThread、**placeholderThread**、topicSendOpts、genId、**perTurnModelSelection**(标量) |
| 9 | `bridge/ensureThread.ts` | ~380 | `ensureThread`(2523–2847)、`pendingCreates`(1291–1299,**模块私有**,handle 导出 `hasPendingCreate` 探针给 commandTable) | `makeEnsureThread(deps)` | bindings、shellCache、sent、outbound、isEnvReady、runOnEnv、genId、sendNotice、workspaceGate handle、**environmentId、groupChatDensity、整个 `config`**(函数体访问 `config.modelOverride`,解构 `const { config } = deps` 保体逐字) |
| 10 | `bridge/inbound.ts` | ~220 | `handleInbound`(2849–3023) | `makeInboundHandler(deps)` | ownerRef/chatConfigsRef/chatDefaultsRef、chatOperators、bindings、ensureLock、turnQueue、isChatBusy、commandTable、ensureThread、runTurn、offlineBuffer、sendNotice、workspaceGate handle |
| 11 | `bridge/cardAction.ts` | ~660 | `FORM_SETTLE_DELAY`(322–328)+`MAX_BYSTANDER_KEYS`(330–337)(唯一消费点在此)、`resolveOperatorName` + `operatorNames`(590–595 + 3045–3073,**模块私有**)、`preserveCardForBystander` + `bystanderNoticed`(560–565 + 3075–3209,**模块私有**)、`handleCardAction`(3211–3516,**整体原子搬运**) | `makeCardActionHandler(deps)` | auth、nonceStore、audit、bindings、shellCache、gateway、ownerRef/chatConfigsRef/chatDefaultsRef、chatResolvedNotices、chatOperators(仅读)、buildInteraction、`staleRequestIdsOf`、resolveDensity、subscribeThread、updateCardNotice、sendNotice、runOnEnv、genId、**runFork**(form 延迟回显 fork) |
| 12 | `bridge/recovery.ts` | ~300 | M18 重启恢复循环(3629–3868,抽为 `recoverPendingApprovalCards(deps)`)、`notifyReconnect`(3558–3584) | 2 工厂 | cardHandles、shellCache、gateway、ownerRef/chatConfigsRef/chatDefaultsRef、chatOperators(**写:播种**)、buildInteraction(**不直接持有 auth**,签名经此间接)、resolveDensity、ensureObserving、subscribeThread、sendNotice、bindings |
| 13 | `bridge/residency.ts` | ~330 | 外层编排件:`BindingIdentity`/eq/投影(3896–3919)、`CredentialResolution`/`FeishuSessionFailure`/`redactSecret`/`SESSION_RETRY_SCHEDULE`/`UNBOUND_RECHECK_INTERVAL`(3921–3974)、`threadIdForChatKey`(3976–3993)、`acquireCredentials`(3995–4056)、`runBindingAndConfigWatcher`(4058–4125)、`reportAuthFailure`(4311–4342) | 若干 | — |

**bot.ts 保留**(~700 行):imports、`DISCOVERY_TIMEOUT` + 启动健康门(437–463)、
`perTurnModelSelection` 解析(465–489)、`CallbackAuth` 构造(496–505)、`resolveDensity`
(514–550,横切读函数,构造后注入各模块)、**`isChatBusy`(1040–1043,turnQueue.isBusy 薄包装,
构造后注入 observeMirror/inbound/commandTable 三方)**、跨模块共享 Ref 的创建(`chatOperators`
552–558、`chatResolvedNotices` + `clearChatResolvedNotices` 567–588,见 §4)、PR2 架构注释
(833–838)、`runFork`/`inbox`/`ensureLock` 创建(1250–1267)、shellCache 构建(750–765)、
shellWatcher 构建(1608–1635)、commandTable 构建(1726–1767)、**inbox 消费 fork(3518–3539)**、
**环境重连 outbound flush watcher(3541–3556)**、`BridgeHandlers` 接线(3586–3619)、
`gateway.connect` → M18 恢复 → `shellWatcher.start` 的**顺序装配**(3621–3876)、群名录上报 fork +
`Effect.never`(3878–3892);外层 `program`(4127–4309)。

## 4. 状态归属决策

30 项共享状态按「唯一写者/横切度」分三类:

1. **模块私有化**(创建挪进模块工厂):`activeRenderFibers`+`nextObserveToken`(observeMirror)、
   `chatTurnLocks`(turnRunner)、`pendingCreates`(ensureThread,handle 导出只读探针)、
   `bystanderNoticed`+`operatorNames`(cardAction)。
2. **装配体创建、显式注入**(横切读写,保持现状语义):`chatOperators`(写:inbound idle-guard
   + M18 播种;读:interaction/observeMirror/cardAction)——**故意不私有化**:pending 的 pin-drift
   修复将把它整个替换为 `feishuInitiators`,保持它在 Deps 边界上显式可见能让该移植改动面最小;
   `chatResolvedNotices`(写:cardAction;读:interaction;清:commandTable 经
   `clearChatResolvedNotices`)。
3. **既有 service/参数保持不动**:全部 store/queue/gateway/registry 句柄、`ownerRef`/
   `chatConfigsRef`/`chatDefaultsRef`(只读参数,Deps 类型注释标明「调用时现读,禁缓存快照」)。

## 5. 承重不变量清单(搬运时逐条核对)

每条 = 搬运后必须原样成立;实施 checklist 与终审 diff 审查都对照本清单。

1. **handleCardAction 步骤顺序**:verify(纯读 probe)→ authz(fail 早返,在 consume **前**)
   → pending 匹配 → `nonceStore.consume`(durable,路由 RPC 前)→ 路由 → 审计 → overlay → 回显。
   整函数原子搬运,步骤编号注释随行。
2. **operator/initiator 签名契约**:`buildInteraction` 本体的回落链是
   `非空 operatorOverride > chatOperators > ""`(**不含** durable handle;空即签空)。
   durable `handle.operatorOpenId` 回落由**调用方**计算后作为 operatorOverride 传入
   (`surfacePendingApprovalIfNew` @1553、`runObserveFiber` operatorFallback @2077、
   M18 恢复 @3773)——三个调用点的回落链各自逐字保持;`preserveCardForBystander` 重签**必须**
   用 `res.payload.o`,空 initiator 拒绝 re-arm(防提权,该判空是承重件)。
3. **observe token 协议**:claim→install→自逐全簇同模块;跨模块顺序不变量「`runTurn` 先
   `turnQueue.beginTurn`(置 busy)再 `stopObserve`」在 turnRunner 调用点与 observeMirror
   的 `ensureObserving` busy 复检两处注释**成对保留**。
4. **启动时序**:`gateway.connect` → M18 恢复(播种 `CardHandle.pendingRequestId` 基线 +
   `chatOperators` + 提前 `ensureObserving`)→ `shellWatcher.start`。装配体中三行相邻、注释钉死。
   inbox 消费 fork 在 connect 之前(现状 3518 < 3621)。
5. **rootScope 语义**:observe fiber `forkIn` 的目标 = per-binding 子作用域(`Effect.scope`
   在 runBoundSession 顶部解析)。observeMirror 的 Deps 显式收 `rootScope: Scope.Scope`,
   工厂**不得**自建 scope。
6. **3 个参数 Ref 只读 + 现读**:任何模块不得写 `ownerRef`/`chatConfigsRef`/`chatDefaultsRef`,
   不得缓存其快照(Deps 注释钉死)。
7. **ensureThread 的串行化前置**:锁在调用方(`handleInbound` 的 `ensureLock.withPermits(1)`),
   `makeEnsureThread` 的文档注释必须声明该前置条件。
8. **runTurn↔offlineBuffer 互递归**:同模块(turnRunner)。
9. **nonceProbe 引用稳定性**:`CallbackAuth` 构造保持在装配体;auth 实例经 Deps 注入
   **interaction 与 cardAction**(recovery 经 buildInteraction 间接签名,不直接持有 auth);
   `nonceStore.consume` 只在 handleCardAction。
10. **secret-isolation**:`redactSecret` 及「只 log 字符串化+脱敏文本」的调用点(program 内
    catchCause)原样保留;`BindingIdentity` 不含 secret。
11. **FORM_SETTLE_DELAY 双路径语义**:form 延迟回显 / approval 立即回显两分支不分家
    (都在 handleCardAction 内)。
12. **schema decoder 单例编译**:decode 常量保持模块作用域(oxlint no-inline-schema-compile)。
13. **composite chatKey vs 裸 chatId**:搬运不改任何键的取值路径(state 查询用 composite,
    token c/scope 与 verify 用裸 chatId)。
14. **裸 `registry.run` 禁止归一到 `runOnEnv`**:`runTurn` 的 dispatch(@2414–2420,依赖
    catchTags 捕 `EnvironmentRpcUnavailableError`/`EnvironmentNotRegisteredError` 走 M8 离线
    缓冲)与 workspaceOps 的 RPC 调用刻意用裸 `registry.run`(+`provideService(Crypto)`);
    `runOnEnv` 以 orDie 收尾会把 typed error 变 defect,catchTags 永远打不中 → offline 消息
    从缓冲变崩溃。这些调用点保持裸 registry 注入,不经 envAccess。
15. **有状态工厂单例装配**:每个有状态模块工厂(observeMirror/turnRunner/ensureThread/
    cardAction/notices)在每次 runBoundSession 中**必须且只能实例化一次**,同一 handle 传给
    所有消费者(闭包时代天然单例,拆分后靠装配纪律)。终审 checklist 含「装配体 grep 每个
    `makeXxx(` 恰好一次」的机械核对。

## 6. 实施策略

- 新开 git worktree + 分支 `refactor/feishu-bot-split`。
- **逐模块抽取,每步一个 commit,每步 `pnpm typecheck && pnpm test`(feishu-bot 包内)保绿**。
  顺序(依赖自底向上,审查确认的可行拓扑序):
  1. residency.ts(外层件,最独立)+ modelSelection.ts
  2. envAccess.ts + notices.ts + workspaceGate.ts + workspaceOps.ts
  3. interaction.ts
  4. observeMirror.ts(最大簇)
  5. turnRunner.ts + ensureThread.ts
  6. inbound.ts + cardAction.ts
  7. recovery.ts + bot.ts 装配体收尾清理
- 终态门禁:`vp check` + `vp run typecheck`(仓库根,AGENTS.md 要求)+ `vp pack`。
- **函数体零改动技巧**:每个工厂顶部 `const { sendNotice, bindings, … } = deps;` 解构,
  函数体内标识符与原闭包捕获同名 → 搬运后函数体逐字不变,diff 审查可机械比对。
  `config.modelOverride` 这类属性访问 → 注入整个 `config` 并解构同名。
- 模块头保留/新写设计说明 docstring(house style),原区段的块注释随代码走。
- 抽取期间**禁止**顺手改名/顺手优化/顺手修注释错字——纯搬运。

## 7. 与 pending 工作的关系

**pin-drift 分支** `origin/worktree-fix+feishu-observe-pin-drift-initiator`(2 commits,改
bot.ts ±400 行,删 `chatOperators`/idle-guard,新增 `feishuInitiators` + `observeOperator.ts`)
在等真连接 e2e,**不能抢先合并**(security 语义变更,项目惯例必须真 e2e)。处置:

- 本重构从 main 出发,不吸收该修复;
- `chatOperators` 保持装配体级显式状态(§4),使其替换面清晰;
- 重构合入后,**把该修复语义重新移植到新结构**出新分支(`fix/feishu-pin-drift-on-split`),
  跑 typecheck+单测+对照原分支 diff 语义核对,交用户真 e2e;原分支保留不动作为语义参照。

**两份 pending kickoff 文档的锚点漂移**:`feishu-bridge-m3-pr-b-toolpolicy-kickoff.md` 与
`feishu-bridge-m3-pr-c4-binding-area-kickoff.md` 以 bot.ts 精确行号锚定施工点,拆分后全部漂移。
处置:重构合入后同步更新两份 kickoff 的 file:line 锚点(指向新模块路径),作为本次工作的
收尾步骤之一。

## 8. 验证计划

1. 每步 commit:`pnpm typecheck` + `pnpm test`(103 例)。
2. 终态:`vp check` + `vp run typecheck`(仓库根)+ `vp pack` 产 bundle 成功。
3. **行为保持机械核对**:脚本抽取「旧 bot.ts 各搬运函数体 vs 新模块函数体」归一化 diff
   (剥缩进/解构头),要求逐字一致;例外(deps 线程化必须的行)逐条列入 PR 描述。
4. Workflow 多维对抗审查(以真实 diff 为对象):①红线清单逐条核验(§5 的 15 条)
   ②并发/生命周期(scope、fork、finalizer)③依赖接线正确性——**强制逐行核验装配体对
   cardAction/observeMirror/turnRunner 的 deps 传递 + §5.15 工厂单例 grep**(103 单测
   零覆盖 bot.ts,接线正确性只能靠审查与冒烟,故此项为最高优先)④(gpt-5.5 独立视角)
   行为回归扫描。全部 CONFIRMED 项修完再审到 0。
5. 冒烟:本地起 server(复用 e2e home `.t3-feishu-m0`)→ server 托管 spawn bot →
   连真飞书 ws ready + restored bindings 日志(覆盖装配、connect、M18 恢复、watcher 启动路径)。
6. **交互路径残余风险书面声明**:cardAction 点击链 / turn dispatch / observe 接管的真连接
   回归需要真人飞书账号发消息与点击,自动化无法覆盖(本仓所有里程碑均由用户 litchi98 真机
   验收)。本 PR 以 §8.3 机械核对 + §8.4 强制接线审查 + §8.5 冒烟为合并门槛,并在 PR 描述
   中列出「合并后建议用户执行的 5 分钟交互验收清单」(单聊消息→流卡、群审批卡点击、
   /resume 接管)。若任何审查维度对接线仍有未闭合疑点,升级为「等用户验收再合并」。

## 9. PR 拆分

- **PR-1(本设计)**:bot.ts 拆分。单 PR、逐模块 commit,便于按 commit 审查。
- **PR-2(后续)**:eventRenderer.ts 按渲染维度拆分(budget/elements/turnScope/activityStream/
  plan/changedFiles/status + 装配 façade,对外 API 与 import 路径不变)。
- **PR-3(后续,不自动合并)**:pin-drift 修复移植分支,交用户 e2e。
- 收尾:更新 PR-B / PR-C4 kickoff 锚点(§7)。
