# 飞书 Bridge M-3「per-chat 配置消费」kickoff(命令白名单 / workspace 授权 / toolPolicy)

> 本文**自包含**,细化主 kickoff `docs/integrations/feishu-bridge-m2-m3-desktop-kickoff.md` §4 到落地粒度。file:line 快照 **2026-07-02,main = `a18ad4e5`**(M-2 PR2c 已合入:web 三态审批编辑器 + 成员名字 + 授权人锁定)。三块地基已由 3 路 Explore 对当前 main **逐条核实**(命令白名单 / workspace 授权 / toolPolicy 全链),动手前仍用 Explore 复核。
>
> ⚠️ **命名去歧义**:代码注释里 `M3a`/`M3b`(无连字符)= 老「群聊+话题路由」里程碑,**已交付**;`M-2`/`M-3`(带连字符)= per-chat config 消费,**本文**。二者不是一回事,勿混。

---

## 0. 硬前置(先核对,否则停)
- `git log --oneline -3` 应见 `a18ad4e5 …M-2 PR2c…(#23)` / `41dce388 …PR2b…(#22)` / `39e9474e …PR2a…(#21)`。
- 从**更新后的 main** 新开分支;每个 PR 独立分支;**提交/推送只在用户明确要求时,开 PR 前确认**。
- 主 kickoff §3.2 范围红线全部继续有效:**文件系统路径 sandbox(需求 3)整体搁置**,M-3 只做授权层/配置层,不得偷做 realpath 拦截。

## 1. 先读
- memory `MEMORY.md` → 尤其:
  - `feishu-bridge-m2-pr2b-impl-facts`(三态判定 + `bridge/chatConfig.ts` 字段级 fallback + payload.o 承重件 + 去白名单)、`feishu-bridge-m2-pr2c-impl-facts`(web 编辑器 + `normalizeConfig` picker==bot + 成员名字);
  - `feishu-bridge-per-chat-m0-m1-progress`(M-0 群名录 / M-1 /workspace 命令族 + `/resume` 归属校验的已交付语义);
  - `feishu-bridge-m4-impl-facts`(callbackAuth 四项 verify / payload.o 承重件 —— M-3 不碰审批但需知红线);
  - `feishu-bridge-e2e-pairing-token`(pairing token 现签 + **浏览器走 server 3773** + server-managed bot 免手起 + 未合入 web 先 rebuild dist);
  - `feishu-bridge-server-managed-bot-impl-facts` + `feishu-bridge-headless-prod-bundle-impl-facts`(bot 自动 spawn/入口解析,e2e runbook 依据);
  - `feishu-bridge-kickoff-review-rule`(本文末的必审自传播规则来源)。
- 主 kickoff `feishu-bridge-m2-m3-desktop-kickoff.md` §4(M-3 蓝图)/§7(红线)/§8(e2e)/§9(待确认);原始 kickoff `feishu-bridge-per-chat-config-kickoff.md` §5D(toolPolicy 管道依据)/§5E(文件隔离搁置 + `/resume` 授权)/§5I(额外设置项)。
- `AGENTS.md`(权威 check/test/typecheck 命令)。

## 2. 已交付地基(动手前必须吸收的语义 + 可复用 seam)

### 2.1 per-chat 配置读取(PR2a/2b/2c 已铺)
- **契约** `FeishuChatConfig`(`packages/contracts/src/settings.ts:375-395`):`approvalMode? / approvers? / workspaces?(projectId 白名单) / commands?(命令白名单) / toolPolicy?({mode:allowlist|denylist, tools})`。`workspaces`/`commands`/`toolPolicy` 三字段**当前已 surface 但无人消费**——M-3 就是来消费它们的。全部 `Schema.optional`(absent 语义:未配置=不限)。
- **纯函数** `effectiveChatConfig(chatId, configs, defaults): EffectiveChatConfig`(`apps/feishu-bot/src/bridge/chatConfig.ts:38-53`):**键 = bare chatId**;字段级 fallback `pick(k)=perChat?.[k] ?? defaults[k]`(`:44-45`)。返回结构 `:24-32` **已含 `workspaces`(:29)/`commands`(:30)/`toolPolicy`(:31)**,`undefined`=未配置。→ **M-3 大部分不需扩这个结构,只需消费。**
- **Ref 持有**:`chatConfigsRef` / `chatDefaultsRef` 建于 resident scope `bot.ts:3910-3911`(跨 re-bind 存活);watcher = **`runBindingAndConfigWatcher`**(`bot.ts:3817-3859`,订阅 `subscribeServerConfig`,`Ref.set` 于 `:3854-3855`,last-known-good 容错不清空);透传进 `runBoundSession(..., ownerRef, chatConfigsRef, chatDefaultsRef)`(签名 `bot.ts:373-380`,调用 `:3970`)。
- **现有消费点(仅审批)**:审批 gate `bot.ts:3040-3044`(喂 `authorizeApprovalClick`)、M18 恢复守卫 `bot.ts:3413-3417`。这两处是 `effectiveChatConfig` 目前**唯二**调用点。
- **web 编辑器现状**:`FeishuSettings.tsx`(PR2c 重写)已有三态审批编辑器 + 纯逻辑 `FeishuSettings.logic.ts`(`normalizeConfig` 保证 picker==bot);`workspaces/commands/toolPolicy` 编辑器**留桩待接**(PR2c 明标 M-3 跟进)。
- **手测回路(PR2b 已证)**:直接编辑 `<home>/userdata/settings.json` 的 `feishuChatDefaults`/`feishuChatConfigs`(`fs.watch` 外部编辑 live-refresh),bot 侧 gate 即时生效——**PR-A/PR-B 在 web 编辑器落地前用此路验证**。

### 2.2 命令层(M-1)
- 入口 `tryHandleCommand(message, table): Effect<CommandOutcome>`(`apps/feishu-bot/src/bridge/commands/registry.ts:91-128`);`CommandOutcome = {handled, unknownCommand?}`(`:64-73`)。命中判定:非 `/` 开头→`{handled:false}`(走正常 turn);`cmd=parts[0].toLowerCase()`(**带前导 `/`、已小写**)→`table.get(cmd)`;未命中→`{handled:true, unknownCommand}`;命中→跑 handler 返回 `{handled:true}`。**框架刻意 output-free,自己从不发消息。**
- 唯一调用点 `bot.ts:2807`(在 `handleInbound` 内),回执由调用点发:`if(outcome.unknownCommand!==undefined) sendNotice(chatKey,"未知命令,/help…",message.messageId)`(`bot.ts:2808-2812`)。**命令路由先于 `ensureThread`、先于 M-1 workspace gate**——命令永不受 workspace gate 约束。
- 命令表 `buildCommandTable(deps): Map<string,CommandHandler>`(`handlers.ts:263-820`),表 `:811-819`:`/help /status /workspace /resume /release /whoami`。**key = 顶层 `/token`**(子命令 `add/list/switch` 在 `workspaceCommand` 内按 `argv[0]` 分派,白名单看不到子命令)。
- 回执惯例 `sendNotice(chatKey, text, replyToMessageId?)`(`bot.ts:673-702`,失败只 log);命令 handler 侧走注入的 `deps.sendNotice`;chatKey 由 `chatKeyOf(ctx)=compositeChatKey(chatId, anchorOf(message))`(`handlers.ts:57-59`)。现成拒绝回执范本:`handlers.ts:644-650`(未选 workspace)、`:747-753`(resume 越权,无泄漏式拒绝)。
- **接线前置(命令白名单 + workspace 授权共用)**:`CommandDeps`(`handlers.ts:62-149`)与 `buildCommandTable({...})` 调用(`bot.ts:1655-1676`)**目前不含任何 config resolver**。M-3 须把一个闭包 `chatConfigsRef`/`chatDefaultsRef`(均在 `runBoundSession` scope,`bot.ts:378-379`)的解析器穿进 `CommandDeps`,handler 用 **bare `ctx.message.chatId`** 取 config(**不是** composite `chatKeyOf`)。

### 2.3 workspace 选择态(M-1)
- `selectedWorkspaceFor(chatKey): SelectedWorkspace`(none/unavailable/ok,`bot.ts:733-749`);gate 文案 `workspaceGateText`(`bot.ts:753-756`)。消费于两处 dispatch:未绑定 pre-queue gate `bot.ts:2823-2829`、建 thread 权威 re-check `ensureThread` `bot.ts:2474-2481`。
- `/workspace` 族(`handlers.ts`):`listWorkspaces`(`:334-379`,从 `deps.shellCache.current.projects` 枚举 + 写 `workspaceOrdinals` 序号缓存 `:356-361`)、`switchWorkspace`(`:386-490`,三 gate busy/bound/pendingCreate,解析 target `:425-477` 后 `deps.workspace.select` `:484`)、`addWorkspace`(`:497-605`,建后 `selectAndConfirm` 复用 switch gate)。
- projects 枚举源 = **本地投影**(非 per-call RPC):`ShellSnapshotCache.current`(`bridge/shellCache.ts:53`,`Ref` 由 shell-stream fiber seed/patch);数据 `OrchestrationShellSnapshot.projects: Array(OrchestrationProjectShell{id:ProjectId,title,workspaceRoot,…})`(`contracts/orchestration.ts:378-419`)。→ 授权集 ∩ = `project.id(ProjectId as string) ∈ config.workspaces`。
- 选择态存储:`WorkspaceState`(内存权威,`bridge/workspaceState.ts:47-104`,`get/select`)+ `ChatWorkspaceStore`(durable,`runtime/persistence.ts:363-383/508-517`,`<stateDir>/chat-workspace.json`)。**键粒度陷阱**:选择态按 composite chatKey(`chatId[:larkThreadId]`),policy config(含 `workspaces`)按 bare chatId——授权判定用 bare chatId。
- `/resume`:`listCandidates`(`handlers.ts:640-681`,过滤 `shell.projectId===selectedProject` `:652-654`)、`resumeTarget`(`:684-777`,归属校验 `if(shell.projectId!==selectedProject) refuse` `:747-754`,**注释 `:745-746` 已标此处为未来「∩ per-chat 授权 workspaces」点**)。

## 3. M-3 范围(三块 + §5I 增量)

三块**按改动量递增**,各自的 gate 语义与插入点如下(file:line 已核实):

### 3.1 命令白名单(最小)
消费 `effectiveChatConfig(chatId).commands`:`undefined`→全放行;存在→仅放行名单内顶层 `/token`,被禁给**明确回执不静默**。**owner 豁免(已定,类比 owner-always)**:binding owner(`ownerRef` openId)不受命令白名单约束、任何命令始终放行——与 §3.2 workspace 授权共用 `isOwnerExempt(owner,sender)` overlay(`bridge/authz.ts`,复用审批 gate 的 owner 分支)。
- **插入点(首选)**:改造 `tryHandleCommand`(`registry.ts` table lookup 命中之后、handler 执行之前),注入谓词 `isCommandAllowed(chatId, cmd)`(闭包 config Ref)+ 传 bare `message.chatId`;命中但不允许→返回**新 `CommandOutcome` 变体** `{handled:true, deniedCommand:cmd}`;**回执仍由调用点 `bot.ts:2808-2812` 发**(与 `unknownCommand` 分支完全对称,复用 `sendNotice(chatKey,"…",messageId)`)。这样保住 registry 的 output-free 契约、拿现成归一化 `cmd`、不重复解析 `message.text`。
- **自锁护栏(已定,用户确认;类比 owner-always)**:群配错白名单会自锁——若 `/help` 被禁则用户无法发现可用命令;若 `/workspace` 被禁则「未选不建 thread」流程断死。**决策**:floor = `/help` + `/whoami`(二者=无副作用自省命令,`COMMAND_FLOOR` 常量于 `authz.ts`,始终放行);`/workspace` **允许被禁**,但禁用给**明确回执**(承主 §4.1,引导「如需在此群跑任务请联系管理员调整配置」,不与「未选 workspace」引导冲突)——禁 `/workspace` 的群 = 有意的只读/状态群,「不建 thread」是期望行为而非 bug。

### 3.2 workspace 授权(中)
消费 `effectiveChatConfig(chatId).workspaces`:`undefined`→全部可见 projects;存在→`Set<ProjectId>` ∩ `snapshot.projects[].id`。**owner 豁免(已定)**:binding owner 不受 workspace 授权约束(四个 gate + `/workspace add` 防孤儿一律先判 `isOwnerExempt`)。**这是选择/授权层,不是运行期路径拦截**(§5 红线)。四个插入点(+ `add` 防孤儿:配了白名单的群仅 owner 可新增 workspace,否则新建 project 必不在授权集会 strand 或经 auto-switch 绕过白名单):
| Gate | 落点 file:line | 形状 |
|---|---|---|
| list 过滤 | `listWorkspaces` `handlers.ts:334-368` | 建 `lines` + `workspaceOrdinals` 前先按 `∈authorized` 过滤 `projects`,序号/名称只引用授权项 |
| switch 拒绝 | `switchWorkspace` target 解析后、`deps.workspace.select`(`handlers.ts:484`)前 | `target.id∉authorized`→越权拒;镜像 `addWorkspace` 的 `selectAndConfirm` 自动切(`:519`) |
| dispatch 二次校验 | `selectedWorkspaceFor` `bot.ts:738-749`(消费 `:2476`/`:2824`) | 把「配置收窄后不再授权」的 `ok` 选择转成 refusal,拦「已选中但收窄」存量;`workspaceGateText`(`:753-756`)加第三种文案 |
| resume ∩ | `listCandidates` 过滤(`:652`)+ `resumeTarget` 归属校验(`:747`) | 在既有 `projectId===selectedProject` 上再 ∩ `selectedProject∈authorized`(注释 `:745-746` 标此点) |

授权集解析器与 3.1 共用(穿进 `CommandDeps`);dispatch 二次校验在 bot.ts 侧,直接用 `Ref.get` + `effectiveChatConfig`。

### 3.3 toolPolicy(最大,单独 PR)
镜像 `runtimeMode` 已走通的 turn-start 管道,把 per-chat `toolPolicy` 贯穿到 Claude adapter,SDK 层真禁用 + canUseTool 防御纵深。**配置层非安全边界**(§5 红线)。

**A. 契约→投影→provider→adapter 全链(每跳加 `toolPolicy?` 兄弟字段,镜像 runtimeMode)**:
| 跳 | file:line(runtimeMode 锚) |
|---|---|
| 1 建线程命令 | `contracts/orchestration.ts:500`(`ThreadCreateCommand.runtimeMode`)+ bootstrap `:557`(`ThreadTurnStartBootstrapCreateThread`) |
| 2 decider 出事件 | `server/orchestration/decider.ts:238`(`thread.create`→`thread.created`,`runtimeMode:command.runtimeMode`;**唯一 `thread.created` 产出点 `:232-245`**) |
| 3 投影→线程 state | `ProjectionPipeline.ts:602`(`thread.created` reducer) |
| 4 reactor 读 state | `ProviderCommandReactor.ts:364`(`desiredRuntimeMode=thread.runtimeMode`) |
| 5 provider 输入契约 | `contracts/provider.ts:63`(`ProviderSessionStartInput`)+ session `:41`(`ProviderSession`) |
| 6 reactor→startSession | `ProviderCommandReactor.ts:485`(`startSession(threadId,{…runtimeMode:desiredRuntimeMode})`) |
| 7 重启触发(live-change 范本) | `ProviderCommandReactor.ts:517`(`runtimeModeChanged`)+ gate `:534-542` → **加 `toolPolicyChanged` OR 进 gate**,复用同款 session 重启 |

新字段全部 `Schema.optional`(provider 前后兼容:其它 driver / 旧 envelope round-trip 不丢)。客户端 op `commands.ts:114-124`(`createThread`)`...input` 展开,新 schema 字段自动流过。

> **bootstrap 路径注(勿误锚 decider)**:`decider.ts` 里**无** bootstrap 建线程分支(`grep bootstrap` 空),`thread.created` 只在 `:232-245` 一处产出;`decider.ts:360` 是 `case "thread.runtime-mode.set"`(`:343` 起)的实时变更 handler = hop 7 上游,**与建线程无关,别锚这里**。真正的 turn.start-with-create(桌面/web,**非**飞书 M-3 两 pin)的 `bootstrap.createThread` 由 `apps/server/src/ws.ts:826-838` 组装成 `thread.create` 命令(`runtimeMode` `:834`)再入 decider `:238` 同一路径。hop 1 给 `ThreadTurnStartBootstrapCreateThread`(`:557`;struct 头在 `:553`,`:557` 是其 `runtimeMode` 字段,镜像锚约定)加 `toolPolicy?` 后,须在 `ws.ts:834` 补 `toolPolicy: bootstrap.createThread.toolPolicy` 转发;decider 因两路共用 `thread.create` 命令而自动覆盖,无需另插。飞书两 pin(§3.3 C)不走此路。

**B. Claude adapter 两注入点(`apps/server/src/provider/Layers/ClaudeAdapter.ts`)**:
1. **SDK 主执行 `disallowedTools`(当前 `ClaudeAdapter.ts` 主 queryOptions 完全缺失)**:queryOptions 构造 `:3443-3481` 加 key——denylist→`disallowedTools`,allowlist→`allowedTools`/`tools`。**runtime-mode 无关,穿透 full-access**,是真执行层。**`toolPolicy` 缺省(absent)时绝不设 `allowed/disallowedTools` key**(no-op)——桌面/web/CLI 全走这条共享 queryOptions,零配置时行为必须与现状字节级一致(§5「不破 headless/CLI/web」)。
2. **canUseTool denylist 防御纵深**:`canUseToolEffect` `:3250-3403`(wrapper `:3405-3406`)。也覆盖 subagent 调用(SDK `CanUseTool` 带 `agentID`)。
> **限定域注(勿误改)**:注入点 1 的「当前完全缺失」仅指 `ClaudeAdapter.ts` **主执行** queryOptions。另有 `ClaudeProvider.ts:568` 的**独立 account-init 探针 query** 已用 `allowedTools:[]`(仅取账号初始化数据、从不 yield prompt),与主执行无关——**别误改它、也别误认为 toolPolicy 已有接线**。
3. **⚠ full-access 短路陷阱 `:3292-3298`**:`if(runtimeMode==="full-access") return allow`——**放它之后的 denylist 检查在 full-access 下死掉**(飞书 p2p 线程正是 pinned `full-access`)。故 canUseTool denylist **必须插在 `:3292` 之前**(`ExitPlanMode` 块 `:3290` 之后);真执行靠注入点 1 的 SDK `disallowedTools`(穿透短路),canUseTool 仅防御纵深。

**C. bot 两 pin 点(真实建 thread,占位卡不算)**:
- 在线 `ensureThreadForChat`(`bridge/chatThreadMap.ts:238-291`,`createThread` payload `:281-291`,`runtimeMode:287`;调用 `bot.ts:2695-2710`,param `:2707`)→ 加 `toolPolicy` param + payload。
- 离线 buffered create(`bot.ts:2609` `runOfflineCreateFlush` → `dispatchCreate` `createThread` `:2618-2632`,`runtimeMode:2628`)→ 加 `toolPolicy`。
- 两处 `runtimeMode` 来自 `runtimeModeForChatType(chatType)`(`bot.ts:2463`);`toolPolicy` 改从 `effectiveChatConfig(chatId).toolPolicy`(`chatConfig.ts:51`)取。占位卡 `bot.ts:630/838-840` 非真建、正确排除。

**D. subagent 继承**:queryOptions 未设 `agents` key,subagent 跑 SDK 默认(继承父工具)。**canUseTool 经 `agentID` 覆盖 subagent 调用(有保证)**;SDK `disallowedTools`→subagent 子上下文传播**文档未明**——**动手前实测**:Task 起的 subagent 不得调到被禁工具;若 disallowedTools 不下传则依赖 canUseTool 层兜底。

**E. denylist 挡不住等价操作(必须对用户写明,非安全边界的具体形态)**:denylist 某工具 ≠ 阻断等价能力——`Bash` 内 `grep`/`find` 可替代 `Grep`/`Glob`,shell 重定向(`echo > file`)可替代 `Write`。故 denylist `Write` 只是让 `Write` 工具不出现在清单,**不阻断 `Bash` 写文件**。web 编辑器 UI 与 PR 描述必须对用户写明「这是配置层非安全边界,denylist 不阻断 Bash 等价操作」(呼应 §5 三易混项红线),否则 e2e 的「Write 不出现在可用工具」会给「写已被隔离」的错觉。禁 `Bash` 才是真边界但严重损可用性——属搁置的严格级隔离,不在 M-3。

### 3.4 §5I 额外设置增量(不无限膨胀首版)
基于已有 seam、低成本高价值,**推荐首版仅纳**:① **density 收编进 `FeishuChatConfig.density`**(现 `ChatBinding.density` / env `FEISHU_GROUP_CHAT_DENSITY`,M3b);② **危险命令二次确认**(`/workspace add`、`/resume` 跨会话)。其余(per-chat 默认模型 / 群级 rate limit / 审计可见性 / 群级 plan 模式)**明标后续**。此项 §7 待确认。

## 4. PR 拆分与依赖
**PR-A(最小,先行)→ PR-B → PR-C**,每 PR:实现 → 多维对抗审查(workflow)→ 修 → 用户确认 commit/PR → 真连接 e2e → 合入。每 PR 合入前 `pnpm exec vp check <改动子目录>` + 各包 typecheck + `pnpm exec vp test run <改动子目录>` 必过(权威命令见 `AGENTS.md`;失败先 `vp fmt`;注:`vp test run` = 内置 `vp test` 走 vitest `run`(单跑非 watch),**别与 `vp run test`(test 包脚本)混淆**)。

- **PR-A:命令白名单 + workspace 授权(bot 消费,无契约改动)**。二者共用「config resolver 穿进 `CommandDeps`」前置,天然一组。仅 bot-side gate,手测走编辑 settings.json。**含 `/help` floor 自锁护栏。**
- **PR-B:toolPolicy 契约全链 + adapter 双注入 + bot 两 pin**。契约跨 contracts/server/bot;手测编辑 settings.json 的 `feishuChatDefaults.toolPolicy`。**初期仅 Claude adapter**(其余 provider 无工具管道,§7 待确认)。
- **PR-C:web 三字段编辑器(commands / workspaces / toolPolicy)+ §5I 首版增量(density 收编 + 危险命令确认)**。**web 编辑器部分 web-only**,叠在 PR-A/B 上,沿用 `FeishuSettings.logic.ts` 纯逻辑 + `normalizeConfig` picker==bot 惯例。**⚠️ 但捆入的 §5I 两项并非 web-only,别让「web-only」定性名不副实**:**density 收编**需 `FeishuChatConfig` 契约**新增 `density` 字段** + bot 从 `ChatBinding.density`/env `FEISHU_GROUP_CHAT_DENSITY` **迁到新字段读**(否则死字段);**危险命令二次确认**(`/workspace add`、`/resume` 跨会话)是纯 **bot handler 改动**,几无 web 成分。故 PR-C 实际跨 web+契约+bot 三层——施工时若要保「纯 web」边界,应把 §5I 的契约/bot 部分单列(PR-D)或并入 PR-A/B 的对应层(§7 web 拆法待确认时一并定)。
- **替代拆法**(留给施工定):每字段的 web 编辑器随其 bot 消费 PR 一起走(PR-A 含 commands/workspaces 编辑器、PR-B 含 toolPolicy 编辑器),不单列 PR-C——代价是 PR 更大但 picker==bot 同 PR 闭环。**推荐上面的 A/B/C**(承 PR2b→PR2c「bot 先、web 后」节奏,手测回路成熟)。

## 5. 红线(不可弱化;承主 kickoff §7 全部)
- `callbackAuth.ts` 密码学字节级不动;`payload.o` 布局/取值不动(M-3 不碰审批链)。**initiator per-turn operator 钉死承重件不得因 M-3 触碰命令/turn 路由而弱化**。
- **不做文件路径 sandbox**(需求 3 搁置);**toolPolicy=配置层非安全边界**、**workspace 授权=选择/授权层非路径拦截**——PR 描述不得给「已隔离」错觉,三易混项边界不得混淆或悄悄扩权。**denylist 不阻断 Bash 等价操作**(grep/find 替代 Grep/Glob、shell 重定向替代 Write),须对用户写明(§3.3 E)。
- **不破 headless/CLI/web**:M-3 各 gate 与 toolPolicy adapter 注入,`toolPolicy` 缺省时对桌面/web/CLI **零行为变更**(adapter 不设 `allowed/disallowedTools` key,§3.3 B 注入点1);命令白名单/workspace 授权只作用于飞书入站路径,不碰其它端。行为有意变更须 PR 明示。
- 不改 `OrchestrationShellSnapshot` schema;toolPolicy 新增字段只加在 turn-start 管道契约(ThreadCreateCommand/Provider* )且全 `Schema.optional`(前后兼容,其它 driver round-trip 不丢)。
- M-1 语义不回退:deriveThreadId、adopt-if-exists、createIntent 终态处置(绝不静默丢消息/假排队)、未选不建 thread、`/resume` 归属校验。命令路由先于 workspace gate 的顺序不变。
- M-0 语义不弱化:FeishuChatDirectory full-replace + 上报 fail-safe。
- env scrub 7 键不动;`toBindingIdentity` 不掺 owner;server-managed 生命周期/打包入口解析/bot-binding 不碰。
- **命令白名单不得静默**:被禁命令必有明确回执(与 `unknownCommand` 对称);`/help` floor 防自锁。
- **键粒度**:policy config 取值一律 bare chatId,不得误用 composite chatKey。

## 6. e2e runbook(真连接)
- **可复用环境**:home `/Users/lizhipeng/.t3-feishu-m0`(已 binding + provisioned app 含 `im:chat:readonly` + web 登录态)。启动:被测分支 worktree 起 `T3CODE_HOME=/Users/lizhipeng/.t3-feishu-m0 T3CODE_PORT=3773 node apps/server/src/bin.ts serve`;**bot 由 server-managed 自动 spawn(凭证走 RPC、pairing token 每次 spawn 现签,均免手动)**;唯一手动 = 浏览器 pairing `node apps/server/src/bin.ts auth pairing create --base-dir <HOME> --base-url http://localhost:3773`,**浏览器认证走 3773**(静态 apps/web/dist,别另起 5733);**测未合入 web 先 `cd apps/web && pnpm exec vp build` rebuild dist**。细节见 `feishu-bridge-e2e-pairing-token`。**起 server 后首步先校验环境假设**:以 `/whoami` 或 web 登录页确认 binding 仍有效(app scope/web 登录态不落盘 `settings.json`,不可仅凭 home 目录存在就断言可用)。
- **M-1 语义注意**:bot 不自动建 project——一律先 `/workspace`。
- **手测配置回路**:PR-A/PR-B 在 web 编辑器落地前,直接编辑 `<home>/userdata/settings.json` 的 `feishuChatDefaults`/`feishuChatConfigs`(`fs.watch` live-refresh 即时生效),验证 gate。
- **验证点**:
  - **PR-A 命令白名单**:群配 `commands:["/status"]` 后 `/workspace` 被拒且有明确回执、`/status` 正常;`/help` floor 始终可用(自锁护栏);缺省(absent)全放行。
  - **PR-A workspace 授权**:群配 `workspaces:[projA]` 后 `list` 只见 projA、越权 `switch projB` 拒、**先选 projB 再把配置收窄到 [projA]** 下一次发消息被 dispatch 二次校验拦、`/resume` 候选只见授权集内。
  - **PR-B toolPolicy**:群配 `toolPolicy:{mode:"denylist",tools:["Write"]}` → Write 不出现在可用工具(SDK disallowedTools)且 canUseTool 同判拒(**注:此仅证明 Write 工具不在清单,非证明写文件被阻断——Bash 重定向仍可写,§3.3 E**);**p2p(full-access)下 denylist 仍生效**(证明穿透短路);allowlist 模式只放行名单内;**缺省 toolPolicy 时桌面/web/CLI 工具集不变**(no-op 回归);**subagent 实测**:Task 起的 subagent 调不到被禁工具;live-change(改 toolPolicy)触发 session 重启(复用 runtimeModeChanged 范本)。
  - **PR-C**:web 列群 + 单群配 commands/workspaces/toolPolicy + 默认 fallback 生效;picker==bot(编辑器所选=bot 所判)。
- **收口**:kill server;home 保留给后续。

## 7. 待确认(实现中定或问用户)
- ~~**命令白名单 floor**~~ **【已定 · 用户确认 · PR-A 已实现】**:floor = `/help` + `/whoami`(`COMMAND_FLOOR`);`/workspace` 允许被禁,禁用给明确回执(承主 §4.1,不与「未选 workspace」引导冲突);**owner 豁免整套 per-chat 配置**(命令白名单 + workspace 授权,`isOwnerExempt` overlay 类比 owner-always)。
- **toolPolicy 初期仅 Claude provider**(推荐)vs 其它 provider 报「不支持」。
- **toolPolicy 对 subagent/Task 继承**:动手前实测(canUseTool 有保证,disallowedTools 下传待验)。
- **toolPolicy allowlist 模式的内置放行工具**:`AskUserQuestion`/`ExitPlanMode` 已在短路前特判(`:3266`/`:3270`),allowlist 是否需保底放行这些控制类工具,避免流程死锁。
- **§5I 首版纳哪些**:推荐 density 收编 + 危险命令二次确认,其余标后续。
- **web 编辑器拆法**:单列 PR-C(推荐)vs 随各 bot 消费 PR。

## 8. 委派 / 闭环
- **Explore/Plan**(只读,file:line + 结论):动手前复核 §2/§3 各锚点(尤其 `registry.ts` tryHandleCommand 改造面、`chatThreadMap.ts` 两 pin、`ClaudeAdapter.ts` full-access 短路与 queryOptions、`ProviderCommandReactor` 重启 gate、键粒度)。
- **Test**:`pnpm --filter @t3tools/feishu-bot run typecheck`、server/web/contracts typecheck、`pnpm exec vp check`(改动子目录)、单测(命令白名单 gate 三态 / workspace 授权四点 / effectiveChatConfig 字段级 / toolPolicy 贯穿与短路上方注入)。
- **Review**:多维 + 对抗(维度见下必审规则)。

## 【kickoff 必审 · 自传播规则】
本设计文档交付前**必须**多维对抗审查(workflow 或多 agent):① **代码事实**——file:line 逐条对真实 main(`a18ad4e5`)核验(尤其 `registry.ts` tryHandleCommand / `handlers.ts` CommandDeps+/workspace+/resume / `bot.ts` 命令调用点+selectedWorkspaceFor+两 pin+config Ref+watcher / `chatConfig.ts` effectiveChatConfig 结构 / `chatThreadMap.ts` ensureThreadForChat / `contracts` orchestration+provider runtimeMode 锚 / `decider.ts`+`ProjectionPipeline.ts`+`ProviderCommandReactor.ts` 投影与重启 / `ClaudeAdapter.ts` full-access 短路+queryOptions+canUseToolEffect);② **范围完整**——对照主 kickoff §4 三块需求 + §5I 无遗漏无误分类,**「文件隔离搁置」与「toolPolicy=配置层、workspace 授权=选择层」三易混项边界没有被混淆或悄悄扩权**,命令白名单自锁护栏与 toolPolicy full-access 短路陷阱已点明;③ **自包含**——memory/文档引用真实、runbook 可执行、红线齐全(callbackAuth 字节级不动、payload.o 承重件、不做文件 sandbox、不改 shell snapshot schema、键粒度 bare chatId)、待确认项已在 §7 点明。修掉阻断项再交付,并把**本规则原样写进**衍生的下一里程碑 kickoff。
