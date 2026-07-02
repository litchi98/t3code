# 飞书 Bridge「审批三态 + per-chat 配置消费 + desktop 默认开」kickoff(M-2 / M-3 / M-desktop)

> 本文**自包含**,承接并细化 `docs/integrations/feishu-bridge-per-chat-config-kickoff.md`(下称「原 kickoff」)中 M-0/M-1 之后的全部剩余工作。file:line 快照 **2026-07-02,main = `f875c632`**(M-0 `77adb18b` #19 + M-1 `f875c632` #20 均已合入且真连接 e2e 通过),动手前用 Explore 复核。配合 memory(`feishu-bridge-per-chat-m0-m1-progress`、`feishu-bridge-workspace-cmd-per-chat-kickoff`、`feishu-bridge-m4-impl-facts`、`feishu-bridge-m3a-impl-facts`、`feishu-bridge-m3b-impl-facts`、`feishu-bridge-goal`、`feishu-bridge-e2e-pairing-token`、`feishu-bridge-server-managed-bot-impl-facts`、`feishu-bridge-headless-prod-bundle-impl-facts`、`feishu-bridge-desktop-process-tree-impl-facts`、`feishu-bridge-kickoff-review-rule`)使用。

---

## 0. 硬前置(先核对,否则停)
- `git log --oneline -2` 应见 `f875c632 …M-1…(#20)` 与 `77adb18b …M-0…(#19)`。
- 从**更新后的 main** 新开分支;每个 PR 独立分支;**提交/推送只在用户明确要求时,开 PR 前确认**。
- 原 kickoff 的 §3.2 范围红线全部继续有效:**文件系统路径 sandbox(需求 3)整体搁置**,本组里程碑只做授权层/配置层,不得偷做 realpath 拦截。

## 1. 先读
- memory `MEMORY.md` → 尤其 `feishu-bridge-per-chat-m0-m1-progress`(M-0/M-1 已交付语义,本文 §2 是其浓缩)、`feishu-bridge-m4-impl-facts`(M4-1 authz 解耦:verify 四项/payload.o 承重件)、`feishu-bridge-m3a/m3b-impl-facts`(话题=session/anchorOf/密度)、`feishu-bridge-e2e-pairing-token`(pairing token 现签手法;**注意其「手动起 bot」流程已被 server-managed 取代**,见 §8)、`feishu-bridge-server-managed-bot-impl-facts` + `feishu-bridge-headless-prod-bundle-impl-facts`(bot 自动 spawn/token 自签/dev-prod 入口分支——§8 runbook 的机制依据)、`feishu-bridge-desktop-process-tree-impl-facts`(§5 desktop 默认开根因与三级进程树 e2e 手法)。
- 原 kickoff §2(方向转向)、§3(三块需求)、§5C/§5D/§5F/§5G/§5I(设计依据,本文按落地粒度重写并更新锚点)。
- `AGENTS.md`。

## 2. 已交付地基(M-0/M-1,新会话必须先吸收的语义)
- **M-0 群名录**:server `FeishuChatDirectory` store(`apps/server/src/feishu/FeishuChatDirectory.ts:72` Context.Service,`save`(full-replace+Semaphore 串行):80、`read`(恒不失败):87;文件 `stateDir/feishu-chat-directory.json`)。RPC `feishu.reportChats`(operate scope,`ws.ts:352/:1263`)/`feishu.listChats`(read scope,`ws.ts:353`);web 读端 atom `feishuListChats`(`packages/client-runtime/src/state/server.ts:254`)。bot 侧 `LarkGateway.listChats/getChatInfo/listChatMembers`(`apps/feishu-bot/src/lark/index.ts:156/:171/:189`;成员走 rawClient `im.chatMembers.get`,open_id 翻页 50 页上限);`chat-directory.ts` 的 `collectFeishuChatDirectory`/`reportFeishuChatDirectory`(**可复用的按需刷新 seam**,现仅 connect 后单发,`bot.ts:3621`)。**坑**:飞书 `user_count` 运行时是 string(SDK d.ts 谎报 number)→ `coerceChatMemberCount` 守卫;`chatMode` 是 opaque string(group/topic/p2p/unknown 哨兵);listChats 失败→整报跳过绝不发空名录(full-replace 防擦库)。provision scope 已含 `im:chat:readonly`(全新 provision 自带;**存量应用需后台补授权**)。
- **M-1 /workspace**:`ChatWorkspaceStore`(composite chatKey→ProjectId,`chat-workspace.json`)+ `bridge/workspaceState.ts` 内存权威层;`selectedWorkspaceFor`(`bot.ts:752`,none/unavailable/ok 三态)+ 未选不建 thread gate(只拦未绑定 chat);bot 启动**不再自动建 project**(headless 首次须 `/workspace`);`/workspace list/switch/add`(switch 三道 gate:busy/bound/pendingCreate;add 被 gate 时照建不切);`/resume` selected-project 归属校验;**adopt-if-exists**(server `requireThreadAbsent` 拒重建同 id → 同 project 活 thread 直接 re-bind 复用;异 project 或 `refusesFullAccessTakeover`(`bridge/chatThreadMap.ts:96`,/resume 与 adopt 共享)→ 拒绝);**`bridge/createIntent.ts` rejected-receipt 终态处置**(失败后重读 isEnvReady 二分:仍 ready=可见终态失败+弃置 intent,不 ready=OfflineRetry 留队;不变量=绝不静默丢消息、绝不假排队)。**v1 已知局限**:p2p 在 A 建过 thread 后切 B 无法自建会话(deriveThreadId 与 project 正交,M3a 红线),文案引导 web 建会话后 /resume。
- **命令层**:`tryHandleCommand`(`bridge/commands/registry.ts:91`)唯一入口;命令表 `buildCommandTable`(`handlers.ts:263`,表 `:811` 区:/help /status /resume /release /whoami /workspace)。

## 3. M-2 审批三态 + 去白名单(需求 2a)——拆 3 个 PR

### 3.1 PR2a:per-chat 配置契约 + ownerRef 硬前置(刻意小,先行合入)
**本 PR 不改三态判定、不删白名单**,只铺数据通道并让 owner-always 生效。
1. **contracts**(`packages/contracts/src/settings.ts`,feishu 区 `:420` feishuApprovalAllowlist / `:428` feishuBinding / `:438` DEFAULT_SERVER_SETTINGS=decodeSync({}) 必须仍过 / `:558-560` ServerSettingsPatch 区)新增,全部 `Schema.optional`/`withDecodingDefault`:
```
FeishuChatConfig = Struct{
  approvalMode?: Literals(["all","designated","initiator"])
  approvers?:    Array(String)        // open_id,designated 用
  workspaces?:   Array(String)        // projectId 白名单(M-3 消费)
  commands?:     Array(String)        // 命令白名单(M-3 消费)
  toolPolicy?:   Struct{ mode: Literals(["allowlist","denylist"]), tools: Array(String) }
}
feishuChatConfigs:  Record(chatId → FeishuChatConfig)   // 键=bare chatId(每群一行)
feishuChatDefaults: FeishuChatConfig                     // 默认 fallback
```
   键粒度警告(原 kickoff §5A):策略配置按 **bare chatId**(authz gate 用 `evt.chatId`),workspace **选择态**才按 composite chatKey——两者键粒度不同是有意为之。schema 注释写明「字段级 fallback」意图(消费在 PR2b/M-3)。`redactServerSettingsForClient`(`apps/server/src/serverSettings.ts:102`)只重写 providerInstances,feishu 字段原样下发 bot——确认新字段不被裁。
2. **bot watcher 加三个 Ref**(`runAllowlistAndBindingWatcher` `bot.ts:3819`;resident scope 的 `allowlistRef` fail-safe/last-known-good 范本 `:3912`,env∪store 合并 `:3848-3852`):`ownerRef ← settings.feishuBinding?.ownerOpenId ?? null`(公开字段,同一快照已有;**`toBindingIdentity` `:3654` 只投影 {appId,tenant} 驱动 re-bind,别改它**,旁路取)、`chatConfigsRef`/`chatDefaultsRef`(本 PR 立通道,PR2b 消费)。错误不清 Ref;变更 logInfo 照 allowlist updated 风格。
3. **owner-always 叠加进 authz gate**(`bot.ts:3055-3064`:现判定 `effectiveAllowlist.length>0 ? effectiveAllowlist.includes(clicker) : clicker.length>0 && clicker===res.payload.o`——**注意 `clicker.length>0` 空 openId 守卫,叠加时勿删**):改 `authorized = (owner 非空且 clicker===owner) || 原判定`。**纯叠加**,白名单逻辑一字不删;`callbackAuth.ts` 零接触;旁观者保护 `preserveCardForBystander` 行为不变。
4. 单测:contracts decodeSync({}) 默认/round-trip/Patch;gate owner-always 叠加三分支;watcher refs fail-safe。
5. **为什么硬前置**(原 kickoff §5C 风险[高]):生产路径 `FeishuBotManager` spawn 时 scrub `FEISHU_OWNER_OPEN_IDS`(7 键 env scrub,红线不动),生产 bot 认识 owner 目前**仅**靠 `persistFeishuBinding` 把 owner 播种进 `feishuApprovalAllowlist`(`serverSettings.ts:193` test / `:682` real)——PR2b 删播种前,ownerRef 通道必须已合入并 e2e 验证 owner-always,否则生产群锁死。

### 3.2 PR2b:三态判定 + 去白名单迁移(依赖 PR2a 合入 + e2e)
1. **effectiveConfig 合并语义(字段级 fallback)**:bot 侧纯函数 `effectiveChatConfig(chatId): {approvalMode, approvers, …}` = `configs[chatId]?.X ?? defaults.X ?? 内置兜底`;`approvalMode` 兜底 = `runtimeModeForChatType`(群/话题=initiator 语义、p2p 维持 full-access 免审批现状)。单测钉住字段级(非对象级)语义。
2. **三态判定表**(gate `bot.ts:3055-3064` 区,clicker=`evt.operator.openId`):
   - `initiator`:`clicker === payload.o`(payload.o 自 PR2b 起签**真发起人**,见 3);
   - `designated`:`approvers.includes(clicker)`(approvers 由 web 从群成员选,PR2c);
   - `all`:`clicker ∈ 群成员`——**数据源 = bot 本地按需拉 `gateway.listChatMembers(chatId)` + 短 TTL 缓存**(分钟级;首选实时性)或退化用 FeishuChatDirectory 上报缓存,实现中定并记录;成员列表**不含 bot 自身**是 SDK 预期。
   - **owner-always 叠加**(PR2a 已落):`authorized = clicker===owner || modeCheck(clicker)`。
3. **`resolveApprover`(`bridge/chatThreadMap.ts:123`)退回 initiator-only**:签发端与 mode 无关,mode 逻辑全部集中在 gate。**payload.o 取值语义翻转(owner→initiator)正是 M4-1 曾否决的「改动 C」的有意反转**——M4-1 否决理由(allowlist 模型下会塌成「仅发起人可批」、破坏多审批人)已被「去白名单 + mode 逻辑集中在 gate」化解,故本次反转架构成立;布局照旧保留(`decodePayload` 强校验)、`matchesExpected` 只比 r/s/c/fp 四项、`computePolicyFingerprint`(`apps/feishu-bot/src/bridge/callbackAuth.ts:220`)= sha256(chatId\0threadId\0runtimeMode) **不含 mode/白名单/owner** → 审批模式 live-change 不废在途卡、无需重签;唯一读值点 gate(`bot.ts:3060`),已全库核实无其它消费端假设 o=owner。**残留依赖必须护住:initiator 模式的授权正确性押在「payload.o=真发起人」上,即依赖既有 per-turn operator 钉死承重件(mid-turn 旁观者 @bot 不得翻转 operator 变成 approver,M3a/M4-1 所立)——PR2b 不得弱化,e2e 加 pin 回归(§7/§8)。**
4. **换判据两处**:`effectiveAllowlistFor`(`bot.ts:508`)与 M18 恢复守卫(`bot.ts:3420-3423` `allowlistActive`)从「allowlist 非空」改为 mode 感知(如 `mode!=='initiator' || ownerKnown`);M18 空 operator 的 nudge 回退路径语义不变。
5. **server 去播种**:删 `persistFeishuBinding` 两处 owner→allowlist append(`serverSettings.ts:193`/`:682`);`feishuApprovalAllowlist` 字段**保留标废弃**(老部署兼容,迁移策略见 §9)。
6. 单测:三态×owner 矩阵、live-change 在途卡不废、M18 判据。
7. **红线**:`callbackAuth.ts` 字节级不动(sign/verify/fingerprint/HMAC/nonce);`payload.o` 布局不动只改取值;env scrub 不动。

### 3.3 PR2c:web 三态编辑器 + 群列表(依赖 PR2a 契约;可与 PR2b 并行开发、后合)
1. `FeishuAllowlistSection`(`apps/web/src/components/settings/FeishuSettings.tsx:141`,挂载点 `:26`)整段替换为 per-chat 配置编辑器:群列表(`feishuListChats` atom,`client-runtime/state/server.ts:254`,显示群名/chatMode/成员数)+ 每群 `approvalMode` 三态 + designated 时从该群 `memberOpenIds` 选人(展示名可经 bot 的 getUser 或先显 open_id,实现中定)+ 默认 fallback(feishuChatDefaults)编辑。
2. 写路径:复用 `updateSettings` patch(ServerSettingsPatch 已在 PR2a 扩展)→ file-watcher/subscribeServerConfig 既有 live-refresh 链(M4-2 已验证双链路)。
3. `workspaces/commands/toolPolicy` 字段的编辑器**可留桩**(M-3 跟进),但 schema 已在,别写死只支持 approval。
4. web typecheck + 组件测试照仓内惯例。

## 4. M-3 per-chat 配置消费(需求 2b/c/d,按改动量递增拆 1-2 个 PR)
1. **命令白名单(最小)**:`handleInbound` 命令路由处(`tryHandleCommand` 调用点,registry `:91`)前后加 gate:`effectiveChatConfig(chatId).commands` 缺省=全部命令;禁用命令回执明确提示(不静默)。注意 `/workspace`/`/resume` 被禁时的提示要与「未选 workspace」引导不冲突。
2. **workspace 授权列表**:`/workspace list/switch` 与 `selectedWorkspaceFor`(`bot.ts:752`)消费 `workspaces`(缺省=全部可见 projects):list 只列授权集、switch 拒绝越权、**已选中但配置收窄后**的存量选择在下一次 dispatch 二次校验时拦下并提示;`/resume` 候选在 M-1 selected 校验之上再 ∩ 授权集(原 kickoff §5E 的收口项)。
3. **工具权限 toolPolicy(最大,单独 PR)**:镜像 runtimeMode 管道——contracts `ThreadCreateCommand`(`packages/contracts/src/orchestration.ts:493`)与 bootstrap `ThreadTurnStartBootstrapCreateThread`(`:553`,挂点 `:572`)加 `toolPolicy` 可选字段 → 线程投影 state → `ProviderSessionStartInput`(`packages/contracts/src/provider.ts:53`)→ `ProviderCommandReactor` 透传(session 重启范本:`apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:517` `runtimeModeChanged`,策略变更走同款重启)→ `ClaudeAdapter` `queryOptions`(`:3443`)注入 SDK `disallowedTools`(真禁用)**并** `canUseToolEffect`(`:3250`)名单 deny(防御纵深)。**陷阱**(原 kickoff §5D 全部有效):`:3292-3293` full-access 提前 return allow——canUseTool 层的黑名单检查必须放短路**之上**,或完全依赖 SDK `disallowedTools`(与 permissionMode 无关);`Bash` 内 grep/find 可替代 `Grep/Glob`(denylist 挡不住 Bash 搜索,文档里写明这不是安全边界);pin-at-session-start;subagent(Task)继承行为动手前实测;初期仅 Claude adapter(其余 provider 无工具管道,§9 待确认)。bot 从 `chatConfigsRef` 读 per-chat toolPolicy,pin 到真实建 thread 派发(在线 `ensureThreadForChat` + 离线 buffered create 两路;占位卡不算)。
4. **§5I 额外设置项**按价值增量纳入(density 收编进 FeishuChatConfig、per-chat 默认模型(M-1 已按 project 现解析,叠加 per-chat override)、群级 rate limit、审计可见性、群级 plan 模式、危险命令二次确认),**首版不无限膨胀**,明标后续。

## 5. M-desktop 默认开 + teardown 竞态(依赖 M-1 已合入=已满足;建议在 M-2/M-3 之后收官,也可独立先行)
1. **先固化 teardown 不变量再翻 gate**(顺序不可反,否则开 gate=批量制造 bot 孤儿):`DesktopBackendManager` grace 2s(`apps/desktop/src/backend/DesktopBackendManager.ts:36`,使用点 `:361`)< `FeishuBotManager` BOT_TERMINATE_GRACE 5s(`apps/server/src/feishu/FeishuBotManager.ts:67`,使用点 `:398`)→ 抽共享常量到 `packages/contracts`,固化 `desktop grace > bot grace + server 余量`(两头一起挪)。
2. **翻转 desktop 默认开**:`feishuBotManaged` 的 desktop 兜底逻辑在 **`apps/server/src/cli/config.ts:318-325`,核心默认 `:324` `() => mode !== "desktop"`**(理由注释 `:305-317`,注释里「暂缓默认开」的 workspace 语义理由已被 M-1 化解,翻转时顺手更新注释;flag `:46`/env `:117`/option `:151`/装配 `:186`)改为默认开。根因已消(M-1 后 desktop 内嵌 server 的 projects=GUI 真实项目,/workspace 显式选中即共享 session,memory `feishu-bridge-desktop-process-tree-impl-facts` 记录的「暂缓默认开」理由不再成立)。
3. desktop 真 electron-as-node 三级进程树 e2e 手法承 `feishu-bridge-desktop-process-tree-impl-facts`;验证默认开 + 关 server 无孤儿 + teardown 时序。

## 6. PR 顺序与依赖
**PR2a(合入+e2e 验 owner-always)→ PR2b(三态+去白名单)→ PR2c(web 编辑器;契约上仅依赖 PR2a,可与 PR2b 并行开发)→ M-3 PR(命令白名单+workspace 授权)→ M-3 PR(toolPolicy)→ M-desktop**。每 PR:实现 → 多维对抗审查(workflow)→ 修复 → 用户确认 commit/PR → 真连接 e2e → 合入;**每 PR 合入前 `pnpm exec vp check <改动子目录>` + 各包 typecheck + `pnpm exec vp test run <改动子目录>` 必过**(权威命令见 `AGENTS.md`)。

## 7. 红线(不可弱化;承原 kickoff §7 全部)
- `callbackAuth.ts` 密码学字节级不动;`payload.o` 布局保留、只改取值语义(全库核无其它读值消费端)。
- **去白名单(PR2b)前 ownerRef(PR2a)必须已合入并 e2e 验证**,否则生产 bot 群锁死。
- 不改 `OrchestrationShellSnapshot` schema;per-chat 配置走 ServerSettings 既有下发链。
- **不做文件路径 sandbox**(需求 3 搁置);toolPolicy 是配置层非安全边界,PR 描述里不得给人「已隔离」错觉。
- M-1 语义不回退:deriveThreadId、adopt-if-exists、createIntent 终态处置(绝不静默丢消息/假排队)、未选不建 thread、/resume 归属校验。
- M-0 语义不弱化:FeishuChatDirectory full-replace + 上报 fail-safe(失败跳过不发空名录)。
- env scrub 7 键不动(`FEISHU_OWNER_OPEN_IDS` 仍被 scrub,owner 认知走 settings.feishuBinding.ownerOpenId)。
- `toBindingIdentity` 不掺 owner(改 owner 不应触发 re-bind 重连)。
- **initiator 模式的 per-turn operator 钉死承重件不得弱化**:`payload.o=真发起人` 的安全性押在既有「turn 发起人快照钉死、mid-turn 旁观者 @bot 不得翻转 operator 自批」机制上(M3a/M4-1 所立),PR2b 触碰签发/判定链时必须保住,e2e 加 pin 回归(§8)。
- **workspace 授权(M-3 需求 2b)是「选择/授权层」**——决定某群能在 /workspace 里**选**哪些 project,**不是运行期路径拦截**;不得以它为名偷做被搁置的文件 sandbox(与 toolPolicy=配置层同属原 kickoff §3.2 三易混项)。
- **不破 headless/CLI/web**:M-3 各 gate 与 M-desktop 默认开不得破坏 headless serve(现状=首次须 `/workspace`,bot 不自动建 project)与 CLI/web 既有行为;行为有意变更须在 PR 里明示。

## 8. e2e runbook(真连接,更新版)
- **可复用环境**:home `/Users/lizhipeng/.t3-feishu-m0` 已有 binding + provisioned app(**已含 im:chat:readonly**)+ web 登录态(30 天 bearer),复用则免扫码;新 home 则 web 扫码绑定一次(全新 provision 自带 scope)。启动:从**被测分支的 worktree** 起 `T3CODE_HOME=/Users/lizhipeng/.t3-feishu-m0 T3CODE_PORT=3773 node apps/server/src/bin.ts serve`。**bot 由 server-managed 自动 spawn:凭证走 RPC、pairing token 由 FeishuBotManager 每次 spawn 现签,均无需手动;唯一要手动 pairing 的是浏览器**——`node apps/server/src/bin.ts auth pairing create --base-dir <HOME> --base-url http://localhost:3773` 现签(token 手法承 `feishu-bridge-e2e-pairing-token`;**该 memory 里「手动起 bot + 手填 T3_PAIRING_TOKEN/T3_STATE_DIR」的旧流程已被 server-managed 取代,勿照抄**,机制见 `feishu-bridge-server-managed-bot-impl-facts`)。未打包 dev serve 下 `chooseBotEntry` 解析到同 worktree 的 `apps/feishu-bot/src/main.ts`(`FeishuBotManager.ts:453-468`),即 bot 跑被测分支源码。
- **M-1 语义注意**:bot 不再自动建 project——e2e 一律先 `/workspace`(list/switch 或 add)。
- **M-2 验证点**:①PR2a:owner 可批(白名单空时)+ 白名单老行为不变;②PR2b 三态矩阵:同一群依次切 all/designated/initiator,各自放行/拒绝符判定表,owner 始终可批,**切换 mode 后在途旧卡仍可按新 mode 判定**(fingerprint 不含 mode);③去白名单后生产 bot 仍认 owner(不锁死);④p2p 免审批现状不回归;⑤**operator pin 回归**:initiator 模式下,turn 进行中另一名群成员 @bot 插话,不得因此获得该 turn 审批卡的 approver 资格(payload.o 仍=原发起人)。
- **M-3 验证点**:①群里禁掉某命令后不响应且有明确回执;②workspace 授权收窄后 list 只见授权集、越权 switch 被拒、存量选择被二次校验拦;③工具权限:群配 denylist Write 后,SDK 层拒绝(Write 不出现在可用工具)且 canUseTool 防御层同判;full-access(p2p)下 denylist 仍生效;subagent 继承实测记录。
- **M-desktop 验证点**:desktop 打包版默认起 bot、退出无孤儿(`pgrep -f feishu-bot`)、teardown 时序符合新不变量。
- **收口**:kill server;home 保留给后续里程碑(记录在案)。

## 9. 待确认(实现中定或问用户)
- 老 `feishuApprovalAllowlist` 数据迁移:静默弃用(推荐,字段保留标废弃)vs 一次性迁入 `feishuChatDefaults.approvers`。
- 「全员」成员数据源:bot 实时拉+短 TTL(推荐)vs 目录缓存;TTL 取值。
- 工具权限初期仅限 Claude provider(推荐)vs 其它 provider 报「不支持」。
- toolPolicy 对 subagent/Task 的继承(动手前实测)。
- §5I 哪些进 M-3 首版(推荐:density 收编 + 危险命令确认,其余后续)。
- designated 选人的展示名来源(getUser 实时查 vs 只显 open_id)。

## 【kickoff 必审 · 自传播规则】
本设计文档交付前**必须**多维对抗审查(workflow 或多 agent):① **代码事实**——file:line 逐条对真实 main(`f875c632`)核验(尤其 bot.ts gate/watcher/effectiveAllowlistFor/M18 守卫、callbackAuth fingerprint、chatThreadMap resolveApprover、serverSettings persistFeishuBinding 两处、FeishuSettings.tsx、ClaudeAdapter full-access 短路与 queryOptions、ProviderCommandReactor 重启路径、cli/config feishuBotManaged、两处 TERMINATE_GRACE);② **范围完整**——对照原 kickoff 三块需求 + 已定决策无遗漏无误分类,**「文件隔离搁置」与「toolPolicy=配置层、workspace 授权=选择层」的三易混项边界没有被混淆或悄悄扩权**;③ **自包含**——memory/文档引用真实、runbook 可执行、红线齐全(尤其 callbackAuth 字节级不动、去白名单前 ownerRef 就位、payload.o 承重件、不改 shell snapshot schema)、待确认项已点明。修掉确认项再交付,并把**本规则原样写进**衍生的下一里程碑 kickoff。
