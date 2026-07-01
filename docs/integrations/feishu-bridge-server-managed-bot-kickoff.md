# 飞书 Bridge「server 托管 feishu-bot 生命周期」里程碑 — 新会话启动提示词

> 把下面 `---` 之间内容粘到新会话作首条消息(或 `@` 引用本文件 + 「推进 server 托管 bot 里程碑」)。本文**自包含**,嵌了调研实证 file:line(快照 2026-06-30,可能微漂,动手前用 Explore 复核)。配合 memory(`feishu-bridge-bot-binding-impl-facts`、`feishu-bridge-e2e-pairing-token`、`feishu-bridge-goal`、`feishu-bridge-kickoff-review-rule`)使用。

---

你是「飞书接入 t3code」特性的**实现协调者(orchestrator)**,推进**「server 托管 feishu-bot 生命周期」里程碑**。纪律:**默认委派,保持主上下文干净**;不把大文件读进主上下文,派 Explore/Plan 返回结论。

## 0. 硬前置(先核对,否则停)

- **bot-binding 里程碑必须已全部合入 main**:PR1(#13 `5a093786`)+ PR2(#14 `07334dcf`)+ **PR3(web 扫码绑定 GUI + 后端 `clearFeishuBinding`,squash 即 PR #15 合入 main)**。核对 `git log --oneline -6`;`apps/feishu-bot/src/bot.ts`(resident loop/未绑定等待/re-bind)、`serverSettings.ts` 的 `persistFeishuBinding`/`clearFeishuBinding`/`getFeishuBotCredentials`/`streamChanges`、web `FeishuBindingDialog.tsx` 都在 main。**若缺 → 停下告诉用户先合**。
- 从**更新后的 main** 新开分支 `feishu-bridge-server-managed-bot`(或逐 PR 各自分支)。
- 提交/推送只在用户明确要求时。

## 1. 先读(memory + 文档)

- memory:`MEMORY.md` → **`feishu-bridge-bot-binding-impl-facts`**(bot-binding 全貌 + 踩坑:**server 包名 `t3` 非 @t3tools/server**;bot 包名 `@t3tools/feishu-bot`;web 包名 `@t3tools/web`)、**`feishu-bridge-e2e-pairing-token`**(e2e 启动真相:`auth pairing create --base-dir <HOME>` 现签一次性 token,bot 不落盘 bearer;完整 server/bot 启动命令)、`feishu-bridge-goal`(薄客户端原则)、`feishu-bridge-kickoff-review-rule`(本规则)。
- `AGENTS.md`(Performance/Reliability first;不 import `.repos/`;重复抽共享)。

## 2. 背景与目标

- **现状**:feishu-bot 是**独立进程**(`apps/feishu-bot`),**手动起**:`node apps/server/src/bin.ts auth pairing create --base-dir <HOME>` 现签 pairing token → `T3_PAIRING_TOKEN=<tok> T3_HTTP_BASE_URL=http://127.0.0.1:3773 T3_STATE_DIR=<dir> node apps/feishu-bot/src/main.ts`(不设 `FEISHU_*` 走 RPC 取凭证)。bot 已能未绑定等待 / 绑定后连飞书 / re-bind 重连 / 解绑断连(PR2 larkGateway 动态化)。
- **目标**:**server 自动托管 bot 进程生命周期**,消除手动起 bot——web 绑定后 server 自动起 bot、解绑后停、bot 崩溃退避重起、server 重启后按 binding 恢复。最终非开发用户**彻底零配置**(只在 web 扫码,bot 自动跑)。

## 3. 用户决策(已拍板,2026-06-30)

1. **范围 = dev 闭环优先**:本里程碑做 **PR1(`FeishuBotManager` service)+ PR2(binding 驱动自动起停 + boot 恢复 + 开关)**;dev 从源码 spawn(`process.execPath` + TS loader)。**生产 bot bundle(`dist/main.mjs`)+ 生产入口解析 + desktop 三级进程树 = 拆后续里程碑**(bot 当前无 build 产物,是最大难点)。
2. **开关 `feishuBotManaged` 全局默认开**(用户不手动起 bot)。dev 想手动起时靠关开关(escape hatch)。

## 4. 架构(调研实证 file:line,均现成范式)

**蓝本 = `apps/desktop/src/backend/DesktopBackendManager.ts`(778 行,desktop 托管 server 子进程的完整范式,几乎照搬)**:spawn(`runBackendProcess` :331-440,`ChildProcessSpawner.spawn` + `killSignal:"SIGTERM"` + `forceKillAfter` :360)、指数退避(`INITIAL_RESTART_DELAY=500ms`/`MAX_RESTART_DELAY=10s` :31-32,`calculateRestartDelay=min(500ms*2^n,10s)` :244,`scheduleRestart` :669)、desired-state 状态机(`desiredRunning`+`active` :214-222,`start` :485 / `stop` :735,`onReady` 归零 `restartAttempt` :611)、就绪探测(`waitForHttpReady` :262)、进程泄漏防护(`addFinalizer(()=>stop())` :768,`forkIn(program, parentScope)` :660)、stdout/stderr drain 到日志(`drainBackendOutput` :290)。

- **决策 A — spawn 子进程(非 in-process)🔴**:理由 ① `apps/feishu-bot/src/processGuard.ts` 装**全局** `process.on('unhandledRejection')` 吞噬器(刻意"保活吞一切" 吞 axios/lark IO 错误)——in-process 会让它**吞掉 server 自己的 unhandledRejection**,与 server 错误哲学相悖;② 崩溃隔离(bot die/defect 不污染 server fiber 树)。`ChildProcessSpawner` 在 server runtime 已可用(`apps/server/src/processRunner.ts:401`、`apps/server/src/process/externalLauncher.ts:367` 都从它取)。
- **决策 B — token 每次 spawn 前现签 🔴**:bot **不落盘 30 天 bearer**(`apps/feishu-bot/src/auth.ts:38-53` `bootstrapRemoteBearerSession` 只存内存 `ResolvedEnvironment.accessToken`,进程退出即丢,全仓无 bearer 落盘)。故每次 spawn(首启/崩溃重起/server 重启恢复)都 `environmentAuth.createPairingLink({scopes:AuthStandardClientScopes, subject:"feishu-bot"})`(`apps/server/src/auth/EnvironmentAuth.ts:766-790` → `PairingGrantStore.issueOneTimeToken` :351,server runtime 内可直接 `yield*` 拿 `.credential` 字符串,**无需走 CLI**)注入 `T3_PAIRING_TOKEN`。one-time + 5min 过期被"签完即用"消解(比手动起还安全)。scopes 与 bot `auth.ts:41` 一致。
- **决策 C — desired-state = `feishuBinding` 存在性 🔴**:订阅 `serverSettings.streamChanges`(`apps/server/src/serverSettings.ts:665`,`Stream.fromPubSub(changesPubSub)` 发全量 `ServerSettings`),读 `settings.feishuBinding`(契约 `packages/contracts/src/settings.ts:428`,`{appId,tenant,ownerOpenId}`)存在→start、消失→stop。boot 时先 `getSettings` 读当前 `feishuBinding` 恢复。**persist 无 race**:`persistFeishuBinding`(`serverSettings.ts:682`)先写 secret 再 `updateSettings`(内部 `emitChange`),streamChanges 发射时 secret 已落库。**re-bind(appId 变)不强制重启进程**——bot 内部 watcher(`bot.ts:3688-3711`,只重取 creds 不重 auth、沿用内存 bearer)已处理,manager 当"哑监督者"(越薄越不与 bot 状态机打架)。
- **env 装配**:`T3_PAIRING_TOKEN`(现签)+ `T3_HTTP_BASE_URL` = **manager 生成 env 时注入** `http://127.0.0.1:${serverConfig.port}`(serverConfig.port 见 server `config.ts:65`;bot 端默认硬编码 `http://127.0.0.1:3000` `feishu-bot/config.ts:204`,被注入覆盖)+ `T3_STATE_DIR=join(serverConfig.stateDir,"feishu-bot")`(`serverConfig.stateDir` = `baseDir/userdata` 或 `dev`,`config.ts:96`);**不设** `FEISHU_*` / `T3_WORKSPACE_ROOT`(bot 继承 server 项目,`feishu-bot/config.ts:206`)。注入方式 `ChildProcess.make(..., {env, extendEnv:true})`(范式 `DesktopBackendManager.ts:354`)。
- **layer 接入**:`FeishuBotManager.layer` 并入 `apps/server/src/server.ts` 的 `RuntimeServicesLive`(:341)/`makeServerLayer`(:362),依赖 `EnvironmentAuth`(`AuthLayerLive` :268)、`ServerSettingsService`(:315)、`ChildProcessSpawner`(平台层)、`ServerConfig`;在 `apps/server/src/serverRuntimeStartup.ts:307-405` `startup` 里加一个 `runStartupPhase("feishu-bot.reconcile",…)` + `forkScoped` 启动 reconcile fiber(与 `keybindings.start`/`settings.start` 并列 :309-338)。

## 5. 拆 PR(2 个,顺序依赖)

- **PR1 — `apps/server/src/feishu/FeishuBotManager.ts`(spawn + 退避重启 + token 现签)**:裁剪 `DesktopBackendManager`;service 暴露 `start`/`stop`/`snapshot` + 内部 `BotManagerState{desiredRunning,active,restartAttempt}` + `Semaphore(1)` 串行;spawn 体注入 env(决策 B token 现签);退避复用 `calculateRestartDelay`/`scheduleRestart`;`addFinalizer(()=>stop())`;bot 入口解析(dev:`process.execPath` + TS loader 跑 `apps/feishu-bot/src/main.ts`)。**不接 `streamChanges`**,内部 `start/stop` + 单测驱动。无依赖,可独立合。
- **PR2 — binding 驱动生命周期(自动起停 + boot 恢复 + 开关)**:reconcile fiber 订阅 `serverSettings.streamChanges` + boot `getSettings` 恢复;`serverRuntimeStartup.ts` 注册 startup phase + `forkScoped`;`server.ts` layer 接入;加 `ServerConfig.feishuBotManaged: boolean`(范式 `config.ts:71` `noBrowser`)**默认开**。端到端:扫码绑定→自动起 bot→连飞书→解绑停→崩溃退避重起→server 重启恢复。依赖 PR1。
- **(拆后续里程碑)**:feishu-bot 生产 bundle + 生产入口解析 + desktop 三级进程树验证;bot 落盘 30 天 bearer 省 token;多 binding/多 bot。

## 6. 红线(不可弱化)

- **secret 永不进 manager/env/日志**:manager 绝不接触 appSecret(bot 仍自走 `feishuGetBotCredentials` RPC 取,`bot.ts:3451`);注入 env 只有 token+url+stateDir。**token 也不 log**(`createPairingLink` 结果勿打日志)。
- **server 退出必清子进程**:`addFinalizer(()=>stop())` + `SIGTERM` + `forceKillAfter`(防进程泄漏)。
- **不破 dev 手动起 bot**:`feishuBotManaged` 开关(默认开,可关)+ **bot 入口(`main.ts`/`config.ts`/`bot.ts`)零改动**——dev 手动 spawn 仍工作。
- **不碰 bot 内部逻辑 / PR1-3 binding / M4 authz / M3 路由 / M4-2 白名单**:manager 只在 server 侧"外挂"一个 spawn 监督者 + 调两个已有 API(`createPairingLink`、`streamChanges`/`getSettings`)。
- **单 bot only**:`feishuBinding` 是单数(`settings.ts:428` 单对象);多 binding 拆后续。
- **重启风暴防护**:退避封顶 10s(已有)+ 重启次数/告警上限(binding 在但 provider 未就绪/项目缺失会让 bot `Effect.die` `bot.ts:187-195`/`:258-262` 快退→循环);start/stop 用 `Semaphore(1)` 串行 + 以 `streamChanges` 最新值 reconcile(desired 优先)化解 unbind/crash-restart 竞态。

## 7. 委派 / 闭环

- **Explore/Plan**(只读,file:line + 结论):复核 `DesktopBackendManager` 可裁剪面、`createPairingLink` 程序化签 token 接线、`streamChanges`/`getSettings` 订阅范式、`ChildProcessSpawner` 在 server runtime 取法、bot 入口 dev 解析(`process.execPath` + TS loader 参数)、`serverRuntimeStartup` startup phase 注册位、就绪信号策略。
- **实现**:PR1(FeishuBotManager,纯 server 新增)→ PR2(接 streamChanges + layer + startup + 开关)。
- **Test**:`pnpm --filter t3 run typecheck`(**server 包名 `t3`**)+ `pnpm exec vp check apps/server`(失败先 `vp fmt`);FeishuBotManager 单测。
- **Review**:多维 + 对抗,维度含:spawn 生命周期正确(start/stop/退避/onReady 归零)/ token 现签不泄漏(不 log、env-only、scopes 对齐)/ desired-state reconcile 竞态(unbind vs crash-restart,Semaphore 串行 + 最新值优先)/ 进程泄漏(finalizer+SIGTERM,server 退出清子进程)/ 不破 dev 手动路径(开关 + bot 入口零改)/ 重启风暴封顶 / secret-token 红线。
- **Confirm**:真扫码 e2e(见 §8)。

## 8. e2e runbook(sketch,实现时细化)

- 干净 `T3CODE_HOME` serve(`feishuBotManaged` 默认开;**dev 从源码 spawn**)。
- web `localhost:3773/pair#token=<tok>` 认证 → 飞书 tab 扫码绑定 → **看 server 日志自动 spawn bot(无需手动 `auth pairing create`)+ bot 从注入的现签 token bootstrap → 连飞书 `ws client ready`**。
- 验:① 解绑 → server 停 bot(SIGTERM);② re-bind(appId 变)→ **bot 内部动态重取凭证、不重启进程**(决策 C,manager 当哑监督者);③ `kill <bot pid>` → server 退避重起(500ms→…→10s 封顶 + onReady 归零);④ **重启 server → 按盘上 `feishuBinding` 自动恢复 bot**;⑤ server 退出 → 子 bot 进程被清(无泄漏)。
- **收口 kill server(子 bot 随之清),清理临时 home**。参考 `feishu-bridge-e2e-pairing-token`(但本里程碑 token 由 manager 现签,e2e 不再手动 `auth pairing create`)。

## 9. 不确定处(实现中需确认 / 可能回头问用户)

1. **就绪信号**:存活计时(N 秒不退即就绪,保 bot 零改)vs bot 加一行 stdout ready 标记由 manager 解析(更准,与"bot 零改"轻微张力)。倾向先存活计时,影响 `restartAttempt` 归零时机。
2. **bot 入口 dev 解析**:`process.execPath` + TS loader 跑 `apps/feishu-bot/src/main.ts` 的确切 loader 参数(Node 26 原生 strip-types?还是需 `--import`?核实 dev `node --watch src/main.ts` 怎么跑 TS)。
3. **dev override**:靠关 `feishuBotManaged` 开关(已定);是否再加"检测到已有 bot 连上同 owner/appId 就不重复起"留作可选增强。
4. **desktop 模式**:三级进程树(desktop→server→bot)先不验证,只保证 headless serve 路径(用户范围决策已收窄)。

## 【kickoff 必审 · 自传播规则】

本 kickoff 交付前**必须**多维对抗审查(workflow 或多 agent):① **代码事实**——file:line 逐条对真实 main 代码核验(尤其 `DesktopBackendManager` 各行号、`createPairingLink`/`streamChanges`/`serverRuntimeStartup` 落点、bot `processGuard`/`auth.ts` 不落盘 bearer);② **范围完整**——对照用户决策(dev 闭环优先、开关默认开)无遗漏无误分类,生产打包确实拆后续;③ **自包含**——memory/文档路径真实、runbook 可执行、红线齐全。修掉确认项再交付,并把**本规则原样写进**衍生的下一里程碑 kickoff。
