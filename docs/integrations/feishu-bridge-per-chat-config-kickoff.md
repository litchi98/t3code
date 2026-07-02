# 飞书 Bridge「/workspace 命令 + 群聊 per-chat 配置」里程碑 — 设计 / kickoff

> 本文**自包含**,file:line 来自 10-agent workflow 调研一手核实(快照 2026-07-02,可能微漂,动手前用 Explore 复核)。配合 memory(`feishu-bridge-workspace-cmd-per-chat-kickoff`、`feishu-bridge-desktop-process-tree-impl-facts`、`feishu-bridge-m4-impl-facts`、`feishu-bridge-m3a-impl-facts`、`feishu-bridge-m3b-impl-facts`、`feishu-bridge-goal`、`feishu-bridge-kickoff-review-rule`、`feishu-bridge-e2e-pairing-token`)使用。
>
> **本文取代** `docs/integrations/feishu-bridge-desktop-workspace-follow-kickoff.md` 的「server 造 active-project 信号 + bot 被动跟随 GUI 焦点」路线(见 §2)。

---

## 0. 硬前置(先核对,否则停)
- **desktop 三级进程树能力(commit `c1581d0c`)必须已合入 main**:按描述串 `feat(feishu-bot): desktop 三级进程树 …` 核 `git log --oneline`,或核 `scripts/build-desktop-artifact.ts` 有 `distDirs.botDist` + `resolvedFeishuBotDependencies`、`apps/server/src/feishu/FeishuBotManager.ts` `buildChildEnv` 有 `electronRunAsNode`。**当前分支 `feishu-bridge-desktop-process-tree` 已含**(本文在其上继续)。
- 从**更新后的 main** 新开分支;每个 PR 独立分支。
- 提交/推送只在用户明确要求时;开 PR 前确认。

## 1. 先读(memory + 文档)
- memory `MEMORY.md` → 尤其:`feishu-bridge-workspace-cmd-per-chat-kickoff`(本里程碑转向+决策+设计地图)、`feishu-bridge-m4-impl-facts`(M4-1 authz 解耦:callbackAuth verify 四项/authz 独立判定层/**payload.o 回归 initiator 曾被审查否决=承重件**)、`feishu-bridge-m3a-impl-facts`(话题=session/`anchorOf`/`compositeChatKey`/resolveApprover 绑 payload.o)、`feishu-bridge-m3b-impl-facts`(`ChatBinding.density`/话题内审批卡/`topicAnchorMessageId`)、`feishu-bridge-goal`(**核心目标=多端共享同一 session**)、`feishu-bridge-e2e-pairing-token`(真连接 e2e 启动)、`feishu-bridge-kickoff-review-rule`(本规则)。
- `AGENTS.md`(Performance/Reliability first;不 import `.repos/`;重复抽共享)。

## 2. 背景与方向转向(为什么放弃「跟随 GUI」改「显式 /workspace」)

### 2.1 五端 workspace 现状(五路 Explore 证实)
- web/desktop/mobile 共用 `@t3tools/client-runtime` 的 **Connection → Environment → Project → Thread** 模型;渲染层各自(web/desktop 同一份 React DOM bundle;mobile 独立 RN)。
- **「当前 project」在所有端都是纯客户端焦点态**,从 `activeThread.projectId` 反推(`apps/web/src/components/CommandPalette.tsx:550`),URL 只含 `(environment, thread)`、project 靠 thread 反推;**server 完全不可见**(全库 grep `setActiveProject`/`focusedProject`/`currentProjectId` 在 `apps/server/src`、`packages/contracts/src` 零命中)。
- 切「已存在」project = **零 RPC 前端导航**;开「新」folder 才经 `orchestration.dispatchCommand` 派 `ProjectCreateCommand`(**无独立 `project.create` RPC**;`packages/contracts/src/orchestration.ts:465`)。
- server 侧「active project」全库只表示「未软删」(`ProjectionSnapshotQuery.ts` `getActiveProjectByWorkspaceRoot`,`deleted_at IS NULL`),**不是 GUI 焦点**。shell 流事件只有 `project/thread-upserted|removed` 四种,snapshot 无 `activeProjectId`。
- feishu-bot 启动订阅 shell snapshot 盲取 `projects[0]`(snapshot 首个;顺序由 server 排序定、bot 侧不保证是「最旧」,`bot.ts:148/486` discoverProject 固化为 const;新方案改按 chat 显式选、不再依赖此语义);desktop 下 server cwd=home → home 孤岛。

### 2.2 方向转向(用户 2026-07-02 拍板)
旧 kickoff 拟「server 造 active-project 信号 + bot 被动跟随 GUI 焦点」。**新方向 = 用户在飞书里显式 `/workspace` 选/切/加 workspace**(正是旧 kickoff 里被列为退路的「候选 B 显式 pin」),per-chat 独立选择态。
- **红利 1**:active-project 整套跟随基建(`setActiveProject` RPC / GUI producer / bot 订阅跟随 / 不改 shell snapshot schema 的顾虑)**全部不再需要**。
- **红利 2**:desktop「bot 连 home 孤岛 ≠ GUI 真实项目、共享 session 不成立」的根因消失 —— desktop 内嵌 server 的 projects 就是 GUI 真实项目,`/workspace` 让用户显式选真的那个 → **解锁 desktop 默认开**([[feishu-bridge-goal]] 的核心目标由「用户显式选同一 workspaceRoot」达成:project 按 workspaceRoot 去重,选中 = 与 GUI 共享同一 project/session)。

## 3. 目标 + 范围

### 3.1 目标
1. **需求 1**:bot 新增 `/workspace` 命令族(`list` / `switch <id|alias|序号>` / `add <local path|git url>`),私聊群聊话题通用;**未选中 workspace 则不能发起 thread**。
2. **需求 2**:飞书 web setting 改版 —— 列出 bot 加入过的所有群聊,每群可单独配置 + 一个默认设置(fallback):(a) 审批权限三态【全员 / 指定人 / 发起人】+ bot owner 默认始终可批,**去除现有审批白名单**;(b) 每群可访问 workspace 列表;(c) 可用命令白名单;(d) agent 工具权限(Read/Write 等);(e) 额外设置项(见 §5I)。
3. **落地后**:翻转 desktop 默认开 gate + 修 teardown 2s<5s 竞态。

### 3.2 明确不做(范围红线,防混淆)
- **需求 3(文件系统路径 sandbox)整体搁置**(用户决策):即**不做** realpath+前缀路径校验、不踢 full-access、不过滤 `.claude` 注入、不上 OS sandbox。理由见 §5E:纯工具层结构性不可闭合,防对手必须 OS 级 sandbox,应作**独立安全立项**,不在本功能里程碑假装解决。
- **⚠️ 三个易混项属于「做」的范围,与被搁置的「文件隔离」是不同层**:
  - **`/resume` 跨 project 归属校验(M-1 做)** = **授权层**修复(防群用户接管别 project 的 session),不是文件系统 sandbox。
  - **工具权限 per-chat(需求 2d,M-3 做)** = SDK `disallowedTools` **配置层**(禁不禁某类工具),不是路径 sandbox。
  - **workspace 授权列表(需求 2b,M-3 做)** = 决定某群能在 `/workspace` 里**选**哪些 project,不是运行期路径拦截。
- 不碰:server-managed 生命周期(现签 token/退避/finalizer/reconcile/subscribe-first)、上一里程碑打包+入口解析+electronRunAsNode 注入、bot-binding、卡片渲染、M3 路由拓扑、callbackAuth 密码学红线(§7)。

## 4. 已定决策(2026-07-02)+ 待实现中确认的次要项

### 4.1 已定(用户拍板)
1. **文件隔离**:先搁置(§3.2)。`/resume` 归属校验仍纳入 M-1;工具权限 per-chat 仍做 M-3。
2. **desktop**:`/workspace` 取代 active-project 跟随;本里程碑落地 + e2e 通过后翻 desktop 默认开 gate + 修 teardown 竞态。
3. **/resume 越权**:提前纳入 M-1。
4. **流程**:先出本设计文档 + 拆 PR,经多维对抗审查(§【必审规则】)再开工。

### 4.2 待实现中确认(次要,给推荐,可动手前定或实现中定)
- **fallback 语义**:字段级(单群只覆盖显式设的字段,其余逐字段回落 default;**推荐**)vs 对象级(单群存在即整体覆盖)。
- **`/workspace switch` 旧会话处置**:第一版走「**禁止活跃会话时切、须先 `/release`**」(方案 b,最简最稳,**推荐**)vs 切=新会话(方案 a,需把 selectedProjectId 掺进 `deriveThreadId` hash,破 M3a 零 re-bind 不变式)。
- **`/workspace add` clone 目标目录**:约定基目录 vs `/workspace add <url> [dest]` 第二参。
- **「全员可批」边界**:飞书 SDK 提供群成员 API(§5G),可真验 `clicker ∈ 群成员`;成员列表是缓存快照,确认刷新时效可接受(启动全量 + 可选事件增量)。
- **默认 approval policy 缺省态**(全新 server):建议「发起人 + owner」(最保守)。
- **工具权限初期是否仅限 Claude provider**(其余 provider 无工具管道)。
- **老 `feishuApprovalAllowlist` 迁移**:静默弃用 vs 一次性迁进 default policy 的 approvers。

## 5. 架构(file:line 一手核实,快照 2026-07-02)

### 5A. 统一 per-chat 配置数据模型
**两个数据面必须分开存**:

| 数据面 | 落点 | 依据 |
|---|---|---|
| **per-chat 策略配置**(审批模式/授权 workspace/命令白名单/工具权限) | `ServerSettings`(settings.json),web 可配 | 复用 `getConfig`/`updateSettings` + `subscribeServerConfig` 全链 live-refresh,零新增下发管道(`serverSettings.ts:601` file-watcher + `:640` updateSettings 写入 → emitChange/`changesPubSub` → subscribeServerConfig RPC `ws.ts:1717` + streamChanges getter `serverSettings.ts:665`) |
| **per-chat workspace 选择态**(当前选中哪个 project) | bot 本地新 store `ChatWorkspaceStore`(`chat-workspace.json`) | 运行时会话态、变更频繁、要先于 thread 存在(有 selectedProjectId 尚无 threadId 的中间态),不适合走 web settings;仿 `ChatThreadMapStore`(`persistence.ts:324`)+ 内存权威层(仿 `bindingState.ts`) |
| **群名录 + 群成员**(bot 所在群列表 + 群名/类型 + 成员 open_id) | server 新 store `FeishuChatDirectory`,**bot 调飞书 SDK API 拉取后上报**(§5G) | server/web 对 ChatBinding 零可见,但**飞书 SDK 直接提供权威 bot 所在群列表 + 成员**(`im.chat.list`/`im.chatMembers.get`),无需消息累积;web 经 RPC 从 server 读(见 §5G、§6 M-0) |

**建议 Schema**(`packages/contracts/src/settings.ts` ~:428 区,全部 `Schema.optional` + `withDecodingDefault`,`DEFAULT_SERVER_SETTINGS` 不破;`redactServerSettingsForClient` `serverSettings.ts:102` 不碰 feishu 字段 → 原样下发 bot):
```
FeishuChatConfig = Struct{
  approvalMode?:  "all" | "designated" | "initiator"
  approvers?:     Array(String)            // open_id,mode=designated 时
  workspaces?:    Array(ProjectId)         // 该群授权可选的 workspace(§5B/§5D)
  commands?:      Array(String)            // 命令白名单(§5D)
  toolPolicy?:    Struct{ mode: "allowlist"|"denylist", tools: Array(String) }
}
feishuChatConfigs:  Record(BareChatId, FeishuChatConfig)   // 单群覆盖
feishuChatDefaults: FeishuChatConfig                        // 默认 fallback
```
- **键粒度**:策略配置按 **bare `chatId`**(每群;authz gate 用 `evt.chatId`,`bot.ts:2757` 区),不是 composite chatKey(每话题)——否则话题群炸出 N 行。**注意** workspace 选择态(上表第二行)反用 composite chatKey(每话题独立选 project),两者键粒度不同是有意为之。
- **合并语义(字段级 fallback,§4.2 待确认)**:`effectiveConfig(chatId).X = configs[chatId]?.X ?? defaults.X ?? 内置兜底`;`workspaces` 兜底 = 全部可见 projects,`commands` 兜底 = 全部命令,`toolPolicy` 兜底 = 不限,`approvalMode` 兜底 = `runtimeModeForChatType(chatType)`。
- **bot 侧消费(唯一 watcher,零新增 watch/reconcile)**:`runAllowlistAndBindingWatcher`(`bot.ts:3509`)已订阅 `subscribeServerConfig`、已消费完整 ServerSettings;照 `allowlistRef` 的 fail-safe/last-known-good 模式(`bot.ts:3601`,OUTER/resident scope)新增 `chatConfigsRef` / `chatDefaultsRef` / `ownerRef`。

### 5B. /workspace 命令族 + 选择态 + gating
- **命令解析(零 registry 改动)**:单表项 `["/workspace", handler]`,handler 内按 `ctx.argv` 分派,与 `/resume` 同构(`bridge/commands/registry.ts:91` `tryHandleCommand` 唯一入口;`handlers.ts:299-302`)。`argv` 空→list;`switch`/裸 `<id|alias|序号>`→switch;`add`→add。复用 `/resume` 的 ordinal 缓存**模式**(`handlers.ts:149` `Ref.makeUnsafe<Map>`)但用**独立 map 实例**(勿与 `/resume` 共用同一 chatKey 键,否则 `/workspace switch <n>` 与 `/resume <n>` 序号互相覆盖);**首版走文本列表 + 二次命令,不碰 callbackAuth 按钮红线**。同步更新 `/help` 手写文本(`handlers.ts:154-161`)。私聊/群聊/话题统一走 `chatKeyOf(ctx)`。
- **选择态存储**:新 store `ChatWorkspaceStore`(`Map<compositeChatKey, ProjectId>`,`chat-workspace.json`,跨重启持久)。**不能塞进 ChatBinding**(其 `threadId` 必填、只在 createThread 后 bind)。
- **「未选不能建 thread」gating**:拦在 `handleInbound`、command 路由之后(`bot.ts:2548`)、`ensureThread` 之前(`bot.ts:2565`);读 `chatWorkspace.get(chatKey)`,空 → `sendNotice("请先用 /workspace 选择工作区")` 后 return。`/workspace` 命令在 `:2548` 先行处理,天然不被 gate 拦。
- **承重改动:解耦启动期 const project**(本里程碑最大结构改动)。`project` 现于 `bot.ts:486` 一次性固化,深织三处:占位卡(`:669`)、离线建 thread(`:2404/2407`)、在线建 thread(`:2451/2456`,经 `EnsureThreadDeps.projectId`,`chatThreadMap.ts:196`)。改为**按 chat 读 selectedProjectId**;`modelSelection`(`bot.ts:501`)不再一次性固化 → 按选中 project 的 `defaultModelSelection` 走 `resolveModelSelection`(`:251`)重解析(`T3_MODEL` override 仍优先);**dispatch 前二次校验** selectedProjectId 仍在 shell snapshot(用户选后 project 可能被删),失效回落「请重新 /workspace」。
- **`/workspace add`(能力已存在)**:本地 path → `createProject({workspaceRoot, createWorkspaceRootIfMissing:true})`(范本 `bot.ts:198-205`);git url → RPC `sourceControl.cloneRepository`(`rpc.ts:223`,拿返回 `cwd`)→ 再 `createProject(cwd)`(照抄 `apps/mobile/.../AddProjectScreen.tsx:786-799`)。clone 目标目录见 §4.2。
- **切换旧 thread 处置(第一版方案 b,§4.2)**:`deriveThreadId(chatId, larkThreadId)`(`chatThreadMap.ts:186`)**与 project 正交**,同 chatKey 换 project 会撞同一 threadId 而服务端 `thread.projectId` 不可变 → 第一版仿 `/resume` 的 `isChatBusy` gate(`handlers.ts:259`)禁止活跃会话时切、要求先 `/release`(`handlers.ts:304`)。

### 5C. 审批三态 + 去白名单迁移 + 红线核对
- **红线核对结论:三态可完全不碰红线**。`callbackAuth.ts` `sign`/`verify`/`computePolicyFingerprint` 一行不动;`matchesExpected` M4-1 已只比 `r/s/c/fp`(`callbackAuth.ts:229-236`,不含 `o`/`a`);`computePolicyFingerprint = sha256(chatId\0threadId\0runtimeMode)`(`:220`,**不含 mode/白名单/owner** → 审批模式 live-change **不废在途卡、无需重签**);`payload.o` 承重件保持存在(删它变字节布局 + `decodePayload` 强校验会拒,`:250`),三态只**改它的取值**、不改布局(唯一读点 `bot.ts:2762`,审计回显用 `evt.operator.openId` 不用 `o`)。
- **三态判定表**(authz gate `bot.ts:2757-2766`,clicker=`evt.operator.openId`):全员=`clicker ∈ 群成员`(用 §5G `listChatMembers` 缓存真验成员,比原「clicker 非空」更严);指定人=`approvers.includes(clicker)`(approvers 由 web 从 §5G 群成员列表选人得到,非手填 open_id);发起人=`clicker===payload.o`(payload.o 须签**真发起人**)。**owner 始终可批叠加**:`authorized = (clicker===ownerOpenId) || modeCheck(clicker)`。
- **去白名单迁移(顺序不可乱:先加 ownerRef 再删白名单)**:
  1. **[硬前置]** 加 `ownerRef ← settings.feishuBinding.ownerOpenId`(公开、已在同一 watcher 快照里,只是 `toBindingIdentity` 当前丢弃它 `bot.ts:3341`),验证 owner-always 生效。**⚠️ 生产路径 `FeishuBotManager` spawn 时 scrub 掉 `FEISHU_OWNER_OPEN_IDS`(`FeishuBotManager.ts:161-169`),生产 bot 认识 owner 仅靠 `persistFeishuBinding` 播种进 `feishuApprovalAllowlist`(`serverSettings.ts:203-209`)—— 直接删白名单会让生产 bot 不知 owner → owner-always 失效、群锁死。**
  2. `resolveApprover`(`chatThreadMap.ts:107`)退回 **initiator-only**(签发端模式无关,mode 逻辑全集中在 gate)。
  3. gate + `effectiveAllowlistFor`(`bot.ts:553`)+ M18 恢复守卫(`bot.ts:3108-3147`)换 mode 表判据(从 `allowlistActive` 变 `mode!=='initiator' || ownerKnown`)。
  4. server 去掉 `persistFeishuBinding` 的 owner→allowlist append(`serverSettings.ts:203` test / `:700` real)。**注**:全仓无 `provisionFeishuBot` 符号,provision 实际在 `apps/server/src/feishu/binding.ts` 的 `registerApp`(不 append owner→allowlist),故只需动 `persistFeishuBinding` 两处。
  5. web `FeishuAllowlistSection`(`apps/web/src/components/settings/FeishuSettings.tsx:141-247`)整段换三态编辑器。
  6. `feishuApprovalAllowlist` 字段保留兼容或标废弃;旁观者保护 `preserveCardForBystander` 行为不变、仅判据换。
- **风险**:[高] owner 通道切换硬前置;[低] 「全员可批」现用 §5G `listChatMembers` 真验群成员(原「无法验成员」风险已由飞书 SDK 消除,注意成员缓存刷新时效);[中] `payload.o` 语义翻转(owner→initiator)——已核 bot 内仅一处读值,需确认无其它端假设;[中] mode live-change 影响在途卡(feature)。

### 5D. agent 工具权限 per-chat gating(需求 2d)
- **现状**:t3code 从不设 SDK `allowedTools`/`disallowedTools`;唯一旋钮是 `runtimeMode→permissionMode`(审批级别非工具可用性)+ `interactionMode:plan` + `canUseTool` 逐调用审批。SDK 原生支持 `allowedTools`/`disallowedTools`(`sdk.d.ts:1340/1360`),只差接进 `queryOptions`。
- **落点(镜像 runtimeMode 已走通的管道)**:contracts `ThreadCreateCommand` + bootstrap(`orchestration.ts:553`)加 `toolPolicy`,建线程时 pin;线程投影 state 增字段;`ProviderSessionStartInput`(`provider.ts:53`)加同字段 → server `ProviderCommandReactor.ts:364/478` 透传 → `ClaudeAdapter.ts:3443` queryOptions 注入 `disallowedTools`(SDK 层真禁用)**并/或** `canUseToolEffect`(`:3250`)加名单 deny(防御纵深)。bot 从 `chatConfigsRef` 读 per-chat toolPolicy,pin 到**真实建 thread 派发**(离线 `bot.ts:2404-2410` + 在线 `ensureThreadForChat` `:2451/2456`),**不是**占位卡 `:669/:671`(后者仅本地渲染常量、不建 server 线程)。
- **陷阱**:`canUseToolEffect` 对 full-access 提前 return allow(`ClaudeAdapter.ts:3293`),p2p=full-access → 黑名单检查须放短路**之上**,或依赖 SDK `disallowedTools`(与 permissionMode 无关);工具名需 SDK 规范名,`Bash` 内 grep/find 可替代 `Grep/Glob`(`sdk.d.ts:1393-1394`,故 denylist 禁 `Grep/Glob` 挡不住 Bash 搜索);pin-at-session-start,改策略需重启会话(复用 `ProviderCommandReactor.ts:517` runtimeModeChanged 重启路径);subagent(Task)继承未验证;**仅 Claude adapter 有工具管道**(§4.2 待定是否初期限 Claude)。
- **注意**:此项是「禁用整类工具」的配置层,**不等于**文件路径边界(§5E,已搁置)。禁 Bash 才是真安全边界但严重损可用性 —— 属搁置的严格级隔离。

### 5E. 文件隔离(需求 3)—— 本里程碑搁置,记录结论供后续独立立项
- **净裁定**:纯工具层路径校验**结构性不可闭合**(3 对抗一致):① Bash 类别失配(toolInput 是自由 shell 串无 path 字段,解析 ≈ 停机问题;`canUseTool` 全程不读路径,`ClaudeAdapter.ts:3250-3406`);② 执行位移(真 fs syscall 在 Bash/test runner/构建脚本/`node -e`/后台进程的孙进程,审批回调不经过);③ 网络维度正交(`git push`/`curl`/WebFetch 外泄不经文件路径);④ 路径字符串 ≠ 真实落点(git `--work-tree`/symlink/**hardlink 让 realpath 失效**);⑤ env 无 scrub(Claude 子进程继承完整 `process.env`,`ClaudeHome.ts:17-29` 仅覆盖 HOME)。Codex 群聊 `read-only`(`CodexSessionRuntime.ts:271`)是全仓唯一 OS 强制护栏,但只挡写、放行读全盘、外泄仍可能。
- **严格级(真隔离,独立安全立项需要什么)**:跟随进程树的 OS 级强制层(macOS `sandbox-exec`/Seatbelt、Linux Landlock+seccomp,或容器 bind-mount 仅 workspace)+ 网络 egress 策略 + 进程树 reaper + agent 子进程 env scrub(补 `ClaudeHome.ts`)。Claude SDK 无原生沙箱需 spawn 层包 wrapper(`ClaudeAdapter.ts:3446`);Codex 可复用原生沙箱但需从 read-only 收紧读+断网。
- **相关但独立的授权修复(纳入 M-1,不是文件 sandbox)**:`/resume` 跨 project 越权 —— `listCandidates`(`handlers.ts:199`)列**全环境所有未归档 thread**、不按 project/chat 过滤;bot 订阅整个 environment(`bot.ts:482` 空参);`/resume <threadId>` 无 project 归属校验 → 群用户接管别的 project 在未授权 workspaceRoot 跑 agent。**纯授权漏洞,工具层可修**:**M-1 先做 selected-project 归属校验**(候选/执行都校 `thread.projectId === ChatWorkspaceStore 该 chat 选中值`,ChatWorkspaceStore 在 M-1 内、不依赖后续字段);**∩ 该 chat 授权 workspace 列表(§5A `workspaces`)的交集校验挂 M-3 收口**(`workspaces` 字段 M-2 才加、M-3 才消费,故 M-1 不能依赖它)。

### 5F. desktop 默认开 + teardown 竞态(落地后)
- **默认开**:memory 记录「用户拍板暂缓默认开」的**根因是 workspace 语义不成立**;新方向(§2.2)解决该根因 → 翻转 `cli/config.ts` 的 `feishuBotManaged` desktop 兜底(现 `() => mode !== "desktop"`)为默认开。落地 + e2e 通过后做。
- **teardown 2s<5s 竞态**(独立待办,承 desktop 三级进程树 memory):desktop→server `DEFAULT_BACKEND_TERMINATE_GRACE=2s`(`apps/desktop/src/backend/DesktopBackendManager.ts:36`)< server→bot `BOT_TERMINATE_GRACE=5s`(`FeishuBotManager.ts`)→ 开 gate 前必须固化「desktop grace > bot grace + server 余量」不变量(两头一起挪 + 抽共享常量到 `packages/contracts`),否则开 gate = 批量制造 bot 孤儿。

### 5G. 飞书 IM SDK 群/成员 API(群名录 + 成员验证的数据源;调研 2026-07-02 证实)
**结论:飞书官方 API 直接支持,t3code 现有 SDK 层够用,只缺 scope + 事件订阅。** 全部用 `tenant_access_token`(bot 身份),无需 user token。
- **列 bot 所在群**:channel 已封 `listChats({pageSize,maxPages}) → {id,name}[]`(`@larksuite/channel@0.2.0`,底层 `im.v1.chat.list`,自动翻页;**只含群聊、不含 p2p、不含话题群标志**)。
- **群信息/群名/类型**:channel 已封 `getChatInfo(chatId) → {name,chatType,ownerId,memberCount,...}` + `getChatMode`(拿 `chat_mode` topic/group/p2p 判话题群,列表接口拿不到)。
- **群成员 open_id**:channel **未封**,走 rawClient 逃生舱(先例 `apps/feishu-bot/src/lark/channel.ts:330-344` getUser 调 contact.user.get)→ `rawClient.im.chatMembers.get({path:{chat_id},params:{member_id_type:"open_id",page_size,page_token}})`,按 `has_more`/`page_token` 翻页(或 `getWithIterator`)。**⚠️ 不返回 bot 成员**(对人类审批判定无碍);默认返回 open_id。
- **落点**:`LarkGateway`(`apps/feishu-bot/src/lark/index.ts:145` getUser 旁)加 `listChats`/`listChatMembers`(+可选 `getChatInfo`);实现 `channel.ts` 复用 `sdkCall`(`channel.ts:76`)/rawClient 模式。
- **⚠️ 连带前置:缺 scope**。现程序化 provision 的 scope 仅 `im:message.send_as_bot`+`im:message.group_msg`(`apps/server/src/feishu/binding.ts:81-93`)。**需在 `binding.ts:83` `scopes.tenant` 追加 `im:chat:readonly`**(飞书文档称一个 scope 覆盖 chat.list + chatMembers.get + chat.get + 进出群事件)→ 飞书后台重新授权;**已 provision 的应用需补授权**(bot-binding 运维步骤)。**⚠️ 动手前必验(仓内不可核实,属飞书权限模型)**:(a) chatMembers.get 取 open_id 是否另需 `im:chat.members:read` 类细粒度 scope;(b) `im.chat.member.user.added_v1/deleted_v1` 事件订阅是否被同一 readonly scope 覆盖(事件授权常独立于 API scope)。M-0 动手前逐端点对飞书 per-endpoint 权限表核对,否则事件订阅/成员细粒度可能另需 scope。
- **(可选)实时增量**:现仅订 `im.message.receive_v1`+`card.action.trigger`(`binding.ts:87/91`)。要实时维护群名录/成员,加 `im.chat.member.bot.added_v1/deleted_v1`(群列表)+ `im.chat.member.user.added_v1/deleted_v1/withdrawn_v1`(成员,payload 直带 open_id)订阅,channel 支持 `botAdded` wire(`channel.ts:230`)。**首版可只启动全量拉 + 按需刷新,不订事件**。
- **限制**:两接口各 1000/min、50/s、page_size≤100;群多时逐群拉成员需限流串行;成员是否拉完以 `has_more`/`page_token` 为准(单页数量会因排除 bot/并发进群波动)。

### 5I. 额外群聊设置项 propose(需求 2e)
基于已存在 seam、低成本高价值:①density 收编进 `FeishuChatConfig.density`(现 `ChatBinding.density`/env `FEISHU_GROUP_CHAT_DENSITY`,M3b);②per-chat 默认模型选择(现 `T3_MODEL` 全局;与 §5B per-chat modelSelection 重解析契合);③群级 rate limit / 并发 turn 上限(现无限制);④审计可见性开关(每群是否投递 AuditEntry / 显示 operator 回显);⑤群级默认 `interactionMode:plan`(只读/计划模式,最省力的「近似只读」);⑥危险命令二次确认(`/workspace add`、`/resume` 跨会话)。

## 6. 拆 PR(顺序依赖)
- **M-0(硬前置,阻塞需求 2)群名录 + 成员回路**:①**加 scope `im:chat:readonly`**(`binding.ts:83`)+ 飞书后台重授权(§5G,连带前置);②bot `LarkGateway` 加 `listChats`/`listChatMembers`/`getChatInfo`(§5G);③bot 调飞书 API 拉「群列表 + 群名/类型 + 成员 open_id」经新 RPC `feishu.reportChats` 上报 server `FeishuChatDirectory` store;④web→server `feishu.listChats` 读(供列群 + 「指定人」选人)。触发:bot 启动全量 + 按需刷新(可选 `im.chat.member.*` 事件增量)。**数据源是飞书权威 API 而非消息累积**——比原设想更权威且顺带拿到成员。
- **M-1 /workspace 命令族(需求 1)+ /resume 归属校验**:PR1a `ChatWorkspaceStore` + gating(§5B)+ **解耦 const project**(承重);PR1b `/workspace list/switch/add` + 切换方案 b + 删 `T3_WORKSPACE_ROOT` auto-create(§5B/§2)+ **`/resume` selected-project 归属校验**(校 `thread.projectId === ChatWorkspaceStore 选中值`,只用 M-1 内的 ChatWorkspaceStore;∩ 授权 `workspaces` 交集校验挂 M-3,§5E)。
- **M-2 审批三态 + 去白名单(需求 2a)**:PR2a contracts 加 `feishuChatConfigs`/`feishuChatDefaults` + bot watcher 加 `ownerRef`(**先加 owner 通道验证 owner-always**);PR2b gate 换三态 + `resolveApprover` initiator-only + server 去 allowlist append + M18 守卫改判据;PR2c web `FeishuAllowlistSection` → 三态编辑器。
- **M-3 per-chat 配置消费(需求 2b/c/d,按改动量递增)**:命令白名单(最小,`tryHandleCommand` 后加 gate)→ 授权 workspace 列表(与 §5B selectedProjectId ∩ 该群 `workspaces`)→ 工具权限(新 contract 字段贯穿 turn start,§5D,末位)。web 编辑器随各项跟进。**需求 2e 的额外设置项(§5I)按价值纳入本阶段增量或明标后续,不无限膨胀首版。**
- **M-desktop 默认开 + teardown 修复(§5F)**:依赖 M-1(bot 不再建孤岛)落地 + e2e。
- **(独立安全立项,不进本里程碑)文件隔离严格级**:§5E。
- **顺序**:M-0 阻塞需求 2 的 UI;M-1 独立可先行(需求 1);M-2 依赖 M-0(配置载体)+ 硬前置 ownerRef;M-3 依赖 M-0+M-2;M-desktop 依赖 M-1。

## 7. 红线(不可弱化)
- **callbackAuth 密码学字节级不动**:`sign`/`verify`/`computePolicyFingerprint`/HMAC/nonce/算法;`payload.o` 布局保留(承重件,M4-1 已因「回归 initiator 破 operatorOverride」否决过改动——本次只改**取值语义**不改布局,须审查确认无回归)。
- **去白名单前必须先落 ownerRef 并验证 owner-always**(§5C),否则生产 bot 群锁死。
- **不改 `OrchestrationShellSnapshot` schema**(blast-radius);per-chat 配置走 ServerSettings 已有下发链。
- **文件隔离范围红线**:本里程碑只做 §3.2 列明的「授权层 / 配置层」项,**不做文件系统路径 sandbox**;不得在 PR 里悄悄加 realpath 拦截而给人「已隔离」错觉。
- **不破 headless/CLI/web**:`T3_WORKSPACE_ROOT` 注入语义变更只随 §5B 的「未选不建 thread」一并处理,须确认 headless serve(server-managed workspaceRoot 教训)仍能工作或明确其在新模型下的行为。
- **env scrub / server-managed 生命周期 / 上一里程碑打包+入口解析 / bot-binding / M3 路由** 逻辑不碰(**例外**:bot-binding 的 provision scope 清单 `binding.ts:83` 追加 `im:chat:readonly`——见 §5G;provision 流程/密码学/绑定回路不动)。

## 8. 委派 / 闭环
- **Explore/Plan**(只读,file:line + 结论):动手前复核 §5 各点(尤其 `ChatWorkspaceStore` 落点与 `deriveThreadId` 正交性、去白名单 blast-radius 的全部消费点、`toolPolicy` 贯穿 turn start 的完整管道、群名录上报是否真零基础)。
- **实现**:M-0 → M-1 → M-2 → M-3 → M-desktop(充分利用 workflow 并行/对抗)。
- **Test**:`pnpm --filter @t3tools/feishu-bot run typecheck`、server/web/contracts typecheck、`pnpm exec vp check`(改动子目录,失败先 `vp fmt`)、相关单测(ChatWorkspaceStore/三态 gate/toolPolicy 贯穿/群名录上报)。
- **Review**:多维 + 对抗(维度:配置合并语义正确/键粒度不误用/审批三态不碰 callbackAuth 红线/去白名单前 ownerRef 就位/工具权限真禁用且 full-access 短路不漏/未选不建 thread/切换不撞 threadId/`/resume` 归属校验闭合越权/**未偷偷做文件 sandbox**/desktop 开 gate 前 teardown 不变量固化)。
- **Confirm**:真连接 e2e(§9)。

## 9. e2e runbook(真连接)
- 起 server + web 扫码复用 binding、headless bot 现签 pairing token:见 [[feishu-bridge-e2e-pairing-token]]。
- **验证点**:① 私聊/群聊 `/workspace` 列出可选 workspace、`switch` 生效、`add local|git` 建 project;② 未选 workspace 时发消息被 gate 挡(提示先选);③ 选中 GUI 真实项目的 workspaceRoot → 与 web 共享同一 session([[feishu-bridge-goal]]);④ 审批三态:同一群切「全员/指定人/发起人」各自放行/拒绝符判定表,owner 始终可批;⑤ 去白名单后生产 bot 仍认 owner(不锁死);⑥ 命令白名单:群里禁掉某命令后不响应;⑦ 工具权限:群配「只读」后 Write 被 SDK 拒;⑧ web setting:列出 bot 加入过的群、单群配置 + 默认 fallback 生效;⑨(desktop 阶段)默认开 + 关 server 无 bot 孤儿。
- desktop mode 真 electron-as-node 三级进程树手法承 [[feishu-bridge-desktop-process-tree-impl-facts]]。
- **收口 kill / 清临时 home**。

## 10. 不确定处(实现中确认 / 可能回头问用户)
- §4.2 全部次要决策。
- 群名录上报的触发时机(bot join 事件 vs 定期全量上报)与去重。
- `toolPolicy` 对 subagent/Task 的继承行为(未验证)。
- 去白名单后 `feishuApprovalAllowlist` 老部署数据迁移策略。
- `/workspace add` git clone 目标目录与失败回滚。

## 【kickoff 必审 · 自传播规则】
本设计文档交付前**必须**多维对抗审查(workflow 或多 agent):① **代码事实**——file:line 逐条对真实 main 代码核验(尤其 `bot.ts` 命令路由/discoverProject/authz gate/watcher、`callbackAuth.ts` fingerprint、`chatThreadMap.ts` resolveApprover/deriveThreadId、`serverSettings.ts` owner 播种/redact、`FeishuSettings.tsx` 白名单段、`ClaudeAdapter.ts` toolPolicy 管道、`handlers.ts` /resume);② **范围完整**——对照三块需求 + 4 项决策无遗漏无误分类,**尤其核对「文件隔离搁置」与「/resume 归属校验 / 工具权限 / workspace 授权」三个不同层的边界没有被混淆或悄悄扩权**;③ **自包含**——memory/文档路径真实、runbook 可执行、红线齐全(尤其 callbackAuth 字节级不动、去白名单前 ownerRef 就位、不偷做文件 sandbox、不改 shell snapshot schema),待确认项已在 §4.2 点明。修掉确认项再交付,并把**本规则原样写进**衍生的下一里程碑 kickoff。
