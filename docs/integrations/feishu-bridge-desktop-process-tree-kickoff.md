# 飞书 Bridge「desktop 三级进程树 + 生产 bundle 纳入」里程碑 — 新会话启动提示词

> 把下面 `---` 之间内容粘到新会话作首条消息(或 `@` 引用本文件 + 「推进 feishu-bot desktop 三级进程树里程碑」)。本文**自包含**,嵌了调研实证 file:line(快照 2026-07-01,可能微漂,动手前用 Explore 复核)。配合 memory(`feishu-bridge-headless-prod-bundle-impl-facts`、`feishu-bridge-server-managed-bot-impl-facts`、`feishu-bridge-bot-binding-impl-facts`、`feishu-bridge-e2e-pairing-token`、`feishu-bridge-goal`、`feishu-bridge-kickoff-review-rule`)使用。

---

你是「飞书接入 t3code」特性的**实现协调者(orchestrator)**,推进**「desktop 三级进程树 + 生产 bundle 纳入」里程碑**(生产化两步走的**第二步 / 收官**)。纪律:**默认委派,保持主上下文干净**;不把大文件读进主上下文,派 Explore/Plan 返回结论。

## 0. 硬前置(先核对,否则停)
- **生产化第一步(headless 生产 bundle,PR #17)必须已合入 main**:`git log --oneline -3` 看有没有 `feat(feishu-bot): headless 生产 bundle …`(squash 带 `(#17)`,commit `1fc8fb77`);**或直接核** `apps/feishu-bot/vite.config.ts`(bot 的 `vp pack` 配置)在 main、`apps/server/src/feishu/FeishuBotManager.ts` 里有 `isPackedBuild`/`chooseBotEntry`/`resolveBotEntry`。**若第一步还没合 → 停下告诉用户先合**(本里程碑复用它的入口解析 + bot bundle)。
- 从**更新后的 main** 新开分支 `feishu-bridge-desktop-process-tree`。
- 提交/推送只在用户明确要求时;开 PR 前确认。

## 1. 先读(memory + 文档)
- memory:`MEMORY.md` → **`feishu-bridge-headless-prod-bundle-impl-facts`**(第一步全貌:bot `dist/main.mjs`/`__T3_PACKED__` define 信号/三个 entry 常量各绑 dirname/`chooseBotEntry`/**每次 spawn 重解析** dist/两个 e2e 抓到的 bug)、**`feishu-bridge-server-managed-bot-impl-facts`**(FeishuBotManager 装配/**env scrub 7 键 + 4 注入 key** 红线/`feishuBotManaged` 开关兜底 `() => mode !== "desktop"`/**🔑 workspaceRoot 教训:headless serve 强制 autoBootstrapProjectFromCwd=false → 注入 T3_WORKSPACE_ROOT=serverConfig.cwd**)、**`feishu-bridge-e2e-pairing-token`**、`feishu-bridge-goal`(薄客户端原则)、`feishu-bridge-kickoff-review-rule`(本规则)。
- `AGENTS.md`(Performance/Reliability first;不 import `.repos/`;重复抽共享)。

## 2. 背景与目标
- **现状**:第一步已让 **headless 生产** server(`node apps/server/dist/bin.mjs serve`)自动 spawn bot 的 `dist/main.mjs`。但 **desktop** 仍不能起 bot:
  - `feishuBotManaged` 兜底 `() => mode !== "desktop"`(`apps/server/src/cli/config.ts:305-319`)= **desktop 默认关**(当初的阻断修复:desktop 包只带 `apps/server/dist`、不带 bot 的 `.ts` 源,若 managed spawn 源码 entry 会 doomed-spawn)。
  - desktop 打包**不含 bot 产物**:`scripts/build-desktop-artifact.ts:1503-1509` 只复制 `serverDist` → `apps/server/dist`,没复制 bot dist。
  - desktop 进程树:electron 以 `ELECTRON_RUN_AS_NODE=1` 跑 server(`apps/desktop/src/backend/DesktopBackendConfiguration.ts:117-144`),故 server 内 `FeishuBotManager` 的 `process.execPath` 会是 **electron 二进制**(不是 node)—— 第三级 bot 要能被 electron-as-node 起。
- **目标(本里程碑 = 生产化收官)**:让 **desktop**(electron → server → bot 三级进程树)也能自动起 bot。① desktop 打包纳入 bot `dist/main.mjs`;② FeishuBotManager 在 desktop 下用 electron-as-node 起 bot(`ELECTRON_RUN_AS_NODE`);③ desktop `feishuBotManaged` 默认开;④ CI + 根 build 纳入 bot 构建;⑤ bootstrap 接线 `feishuBotManaged`。**入口解析复用第一步**(desktop server 从 `dist/bin.mjs` 跑 → `isPackedBuild()`=true → prod entry `../../feishu-bot/dist/main.mjs`;打包保持 `apps/server/dist` + `apps/feishu-bot/dist` 相对布局,解析成立 —— 动手前须核对打包后的真实布局)。
- **最大未知 = ELECTRON_RUN_AS_NODE 的传递** 与 **desktop 下 bot 的 workspaceRoot/stateDir 语义**(见 §4B / §9)。

## 3. 用户决策(已拍板,2026-07-01)
1. **desktop 默认开**:gate `() => mode !== "desktop"` 改为 `() => true`,desktop 与 web/CLI 一致默认开(打包纳入 bot dist 后不再 doomed-spawn);仍保留 flag/env/bootstrap 可显式关。
2. **拆 2 PR**:**PR1 = 能力落地**(进程树 `ELECTRON_RUN_AS_NODE` + 打包纳入 bot dist + 根 build/`build:desktop` 纳入 bot 构建)让 desktop **能**起 bot;**PR2 = 启用**(desktop 默认开 gate + bootstrap 接线**(可选增强,见 §4D/§9.4)** + CI release.yml 复核)。能力先落、启用后开,降风险。
3. **e2e 分层**:先用 `ELECTRON_RUN_AS_NODE` 模拟 desktop 三级进程树验证(electron-as-node 起 server 起 bot)+ 打包冒烟(artifact 含 bot dist);**真 desktop app(electron)+ 真飞书扫码 e2e 由用户择时手动**。

## 4. 架构(调研实证 file:line,快照 2026-07-01)

### 4A. desktop 打包纳入 bot dist(PR1)
- **复制点**:`scripts/build-desktop-artifact.ts` 现有 `fs.copy(distDirs.serverDist, path.join(stageAppDir, "apps/server/dist"))`(serverDist 复制具体在 **:1509**,整个 staging 段 :1503-1509)。**照加** `fs.copy(botDistDir, path.join(stageAppDir, "apps/feishu-bot/dist"))`。`botDistDir` 需在 `distDirs`(~:1460-1464,`serverDist` 成员 :1463)附近定义为 `path.join(repoRoot, "apps/feishu-bot/dist")`,并在 `requiredBuildInputs`(数组 :1479-1483,校验循环 :1484-1491)加存在性校验(缺 bot dist 则 **fail-fast**,别静默产不含 bot 的包)。
- **布局意义**:stage 后 `apps/server/dist/bin.mjs` + `apps/feishu-bot/dist/main.mjs` 保持第一步的相对结构 → FeishuBotManager prod entry `../../feishu-bot/dist/main.mjs`(从 `apps/server/dist`,2 层)解析成立。**动手前用 Explore 核对打包后 stageAppDir 的真实布局**(desktop app 内 appRoot 结构可能与 repo 不同层级)。

### 4B. desktop 进程树 — 第三级 bot 的 electron-as-node(PR1,核心难点)
- **现状**:`DesktopBackendConfiguration.ts:117-144` desktop 起 server 用 `executablePath: process.execPath`(electron)+ `env: { ...backendChildEnvPatch(), ELECTRON_RUN_AS_NODE: "1" }`;server entry = `apps/desktop/src/app/DesktopEnvironment.ts:185` `path.join(appRoot, "apps/server/dist/bin.mjs")`。
- **FeishuBotManager 现状**:`FeishuBotManager.ts:442` `executablePath = process.execPath` —— **desktop 下这是 electron 二进制**;`runBotProcess`(`:374-379`)`ChildProcess.make(executablePath, [entryPath], { …, extendEnv: true })`。`extendEnv: true` 会**隐式继承** server 进程的 `ELECTRON_RUN_AS_NODE=1` → electron 当 node 跑 `dist/main.mjs`。
- **🔴 核心设计(别踩坑)**:
  - **先验证隐式继承是否已 work**:server(electron-as-node)spawn bot,`extendEnv:true` 继承 `ELECTRON_RUN_AS_NODE=1` → 理论上 electron 直接跑 bot dist。**但这是隐式依赖**。倾向**显式注入更稳**:改 `buildChildEnv`(`:191-202`)签名接 `mode`(或 `serverConfig`),desktop 模式显式加 `ELECTRON_RUN_AS_NODE: "1"`。注意 `ELECTRON_RUN_AS_NODE` **不在** `FEISHU_BOT_SCRUBBED_ENV_KEYS`(7 键)里,所以隐式继承不会被 scrub —— 显式注入是"补强 + 自文档",非"修复缺失"。
  - **红线:env scrub 7 键 / 4 注入 key 字节级不动**(只**新增** `ELECTRON_RUN_AS_NODE` 一个 key,且仅 desktop 模式)。`buildChildEnv` 是纯函数、有单测 —— 加参数后补 desktop 分支单测。
  - **execPath 不用改**(desktop=electron+ELECTRON_RUN_AS_NODE,headless=node,均 `process.execPath` 自适应)。

### 4C. desktop 默认开 gate(PR2)
- `apps/server/src/cli/config.ts:305-319`:`feishuBotManaged = Option.getOrElse(resolveOptionPrecedence(flags/env/bootstrap), () => mode !== "desktop")`。**改兜底为 `() => true`**(desktop 也默认开)。**更新那段注释**(原注释解释"desktop 默认关因为不带 bot 源会 doomed" —— 现在打包纳入 bot dist 了,前提已消除)。flag/env/bootstrap 优先级链不动(仍可显式关)。

### 4D. bootstrap 接线 feishuBotManaged(PR2)
- `DesktopBackendConfiguration.ts:117-144` 的 bootstrap envelope **当前没注入 feishuBotManaged**。契约 `packages/contracts/src/desktopBootstrap.ts:11` `feishuBotManaged: Schema.optional(Schema.Boolean)`(第一步已加 optional 字段)。**若 gate 兜底已改 `() => true`,bootstrap 不传也默认开** —— bootstrap 注入是为让 desktop app 层能显式覆盖(可选增强,非必需)。实现时定:仅靠 gate 默认开(最小),还是同时让 desktop app 显式传值(见 §9)。

### 4E. CI + 根 build 纳入 bot 构建(PR1 产物链 + PR2 CI 复核)
- **根 build**:根 `package.json:16` `build = vp run --filter './apps/*' … build`(跑各包 **build task**)。bot `apps/feishu-bot/vite.config.ts` 目前**无** `run.tasks.build` → `pnpm build` 不构建 bot。**PR1 给 bot vite.config 加 `run.tasks.build`**(照 server `apps/server/vite.config.ts:25-29`,command 让 bot 产 dist,**无 dependsOn**(bot 不依赖 web))。
- **build:desktop**:`package.json:18` `build:desktop = vp run --filter @t3tools/desktop --filter t3 build`(不含 bot)。**PR1 加 `--filter @t3tools/feishu-bot`** 让 desktop artifact 构建时先产 bot dist(否则 §4A 的复制会因 bot dist 缺失 fail)。**⚠ 这是 §4A 复制的前提,必须同在 PR1**。
- **CI release.yml**:`.github/workflows/release.yml` build server/web 在 ~:592-595、desktop artifact 在 **:496**(release.yml 调 `vp run dist:desktop:artifact` = `node scripts/build-desktop-artifact.ts`;该脚本内部 ~:1469 **先**跑 `vp run build:desktop` **再**复制 :1509,故 CI 自身不单独构建 bot)。若 `build:desktop` 脚本(PR1)已含 bot,release.yml **无需单独改**(已核 release.yml 零 feishu-bot 构建命令)。**PR2 复核 release.yml** 确认 bot 被构建/纳入无遗漏。

### 4F. desktop teardown — 三级进程树的关停(别只做 spawn)
「三级进程树」= 起 **+** 关。electron app 退出时须优雅 SIGTERM server,让 server 的 finalizer(server-managed 里程碑:`addFinalizer(stop)` → SIGTERM bot + `forceKillAfter`)清掉 bot,否则 bot **孤儿残留**。**⚠ 前一里程碑的「server 退出清子进程」只在 headless(手动 kill server)验证过;desktop 由 electron 托管 server 子进程的关停是另一条路径,未验证。** 复核 `apps/desktop/src/backend/DesktopBackendManager`(或 app 退出钩子)怎么关 server 子进程:SIGTERM 优雅(走 server finalizer 清 bot)vs SIGKILL 直杀(绕过 finalizer → 留孤儿 bot)。**归属:若查出 desktop 关停留孤儿 → 修复属能力性质 → 归 PR1。**

### 4G. 不碰的(承第一步红线)
- 第一步的入口解析(`isPackedBuild`/三 entry 常量/`chooseBotEntry`/每次 spawn 重解析/prod-source fallback)**逻辑不动**,只复用。
- server-managed 生命周期红线(现签 token/退避/finalizer/reconcile/subscribe-first)不动。
- bot-binding / M4 authz / M3 路由 / M4-2 白名单不碰。

## 5. 拆 PR(2 个,顺序依赖)
- **PR1 — desktop 能起 bot(能力落地)**:① `build-desktop-artifact.ts` 复制 bot dist + requiredBuildInputs 校验(§4A);② `FeishuBotManager.buildChildEnv` desktop 显式注入 `ELECTRON_RUN_AS_NODE`(§4B)+ 单测;③ bot `vite.config.ts` 加 `run.tasks.build`、`package.json` `build:desktop` 加 bot filter(§4E)。**gate 仍默认关**(desktop 此时能起 bot 但不自动起)。真构建 desktop artifact 冒烟(含 bot dist)+ ELECTRON_RUN_AS_NODE 模拟三级进程树 e2e。
- **PR2 — 启用**:① `cli/config.ts` gate 兜底 `() => true`(§4C)+ 注释更新;② bootstrap 接线(§4D,按 §9 定);③ release.yml CI 复核(§4E)。依赖 PR1。启用后 e2e(desktop 默认开 → 自动起 bot)。

## 6. 红线(不可弱化)
- **不破 headless / dev 路径**:headless 生产(node dist/bin.mjs)、dev(node src/bin.ts)仍各自正确 spawn bot;第一步入口解析逻辑零改动。
- **env scrub 7 键 / 4 注入 key 字节级不动**;`buildChildEnv` 只**新增** `ELECTRON_RUN_AS_NODE`(仅 desktop 模式),纯函数 + 单测覆盖新分支。
- **不 doomed-spawn**:desktop 默认开的前提是打包**确实**纳入 bot dist(§4A);若打包链未就绪就开 gate = 回到当初 doomed 问题。**PR 顺序(能力 PR1 → 启用 PR2)+ §4A 的 `requiredBuildInputs` fail-fast(确保打进的 bot dist 真存在、非静默空包)共同保证这条红线**。
- **三级进程树关停无孤儿**:desktop app 退出 → server 优雅关停 → bot 被 finalizer 清(§4F);不留孤儿 bot 进程。
- **server-managed 生命周期 / 第一步入口解析 / bot-binding / M4 / M3** 全部不碰逻辑。
- **desktop app 层最小改动**:优先在 server/打包脚本/config 侧解决,尽量不动 `apps/desktop/src` 的 app 逻辑(bootstrap 契约已 optional)。

## 7. 委派 / 闭环
- **Explore/Plan**(只读,file:line + 结论):复核 §4 各点(尤其打包后 stageAppDir 真实布局、ELECTRON_RUN_AS_NODE 隐式继承链、desktop 下 serverConfig.stateDir/cwd → bot 的 T3_STATE_DIR/T3_WORKSPACE_ROOT 语义、build:desktop/根 build task 编排、release.yml bot 纳入)。
- **实现**:PR1(打包 + 进程树 + 构建链)→ PR2(gate + bootstrap + CI)。
- **Test**:`pnpm --filter @t3tools/feishu-bot run build:bundle` + `pnpm --filter t3 run typecheck` + `pnpm --filter @t3tools/feishu-bot run typecheck` + desktop 相关包 typecheck + `pnpm exec vp check`(失败先 `vp fmt`,**只跑改动子目录**) + `buildChildEnv` desktop 分支单测 + 真构建 desktop artifact 冒烟(确认含 `apps/feishu-bot/dist/main.mjs`)。
- **Review**:多维 + 对抗,维度含:ELECTRON_RUN_AS_NODE 传递正确(electron-as-node 真能跑 bot dist)/ 打包含 bot dist 且入口解析在 desktop 布局成立 / desktop 默认开不 doomed(bot dist 在)/ env scrub + 4 注入 key 红线零改动 / 不破 headless+dev / 第一步入口解析逻辑零改动 / desktop 下 workspaceRoot·stateDir 语义正确(§9)/ desktop teardown 无孤儿 bot(app 退出→server 优雅关→bot 被清,§4F)/ `ELECTRON_RUN_AS_NODE` 不经 bot 泄漏污染用户命令执行(核既存行为)。
- **Confirm**:分层 e2e(见 §8)。

## 8. e2e runbook(分层,sketch,实现时细化)
### 8A. 模拟 desktop 三级进程树(不打包 electron app,ELECTRON_RUN_AS_NODE 模拟)
- build:`pnpm --filter @t3tools/feishu-bot run build:bundle` + `pnpm --filter t3 run build:bundle`。
- 用 electron 二进制以 `ELECTRON_RUN_AS_NODE=1` 跑 server dist(模拟 desktop 第二级;electron 在 `apps/desktop/node_modules/.bin/electron`,或 `node -e "console.log(require('electron'))"` 定位),`feishuBotManaged` 显式开:确认 server 内 FeishuBotManager spawn bot 时 **execPath=electron + bot 进程真能起**(electron-as-node 跑 `dist/main.mjs`)→ bot 连真飞书 `ws client ready`。验证点:① bot 进程 args = `<electron> .../feishu-bot/dist/main.mjs`(`ps` 实证);② `ELECTRON_RUN_AS_NODE` 传到 bot(显式或继承);③ bot ws ready(electron-as-node 能跑 bundle 铁证)。
  - 参考 [[feishu-bridge-e2e-pairing-token]] 起 server + web 扫码绑定复用 binding(切 server 免重扫码,见第一步 e2e 手法)。
### 8B. 打包冒烟
- 真构建 desktop artifact(`vp run dist:desktop:artifact` 或等价):确认 stage 产物含 `apps/feishu-bot/dist/main.mjs`(§4A 复制生效);检查 requiredBuildInputs 缺 bot dist 时 fail-fast。
### 8C. 真 desktop app 全链路(用户择时手动)
- 真装真 electron app → 绑定飞书 → 看 electron→server→bot 三级自动起 → bot 连飞书 ready;**并验退出:关闭 electron app → server 优雅关 → bot 进程必死(`ps` 确认无孤儿 bot,§4F)**。**成本高(构建 electron app),由用户手动**;kickoff 交付时告知用户此步留给他。
- **收口 kill / 清临时 home**。

## 9. 不确定处(实现中需确认 / 可能回头问用户)
1. **ELECTRON_RUN_AS_NODE 隐式继承 vs 显式注入**:`extendEnv:true` 隐式继承 server 的 `ELECTRON_RUN_AS_NODE=1` 是否已让 bot 正常起?**PR1 先真验隐式**;倾向 `buildChildEnv` desktop 分支**显式注入**(补强 + 自文档)。若显式注入,`buildChildEnv` 签名要接 `mode`/`serverConfig`,注意别破 headless(headless 不设该 key)。
2. **🔑 desktop 下 bot 的 workspaceRoot / stateDir 语义**:第一步 workspaceRoot 教训(headless serve 强制 `autoBootstrapProjectFromCwd=false` → 注入 `T3_WORKSPACE_ROOT=serverConfig.cwd` 兜底)。**desktop 下 server 有没有 project?serverConfig.cwd/stateDir 是什么?**(desktop 的 cwd 可能是 app 目录,非用户工作区)。必须复核:desktop 下 bot 建 project 的位置是否合理(别在 app 安装目录建 project)。**这是 desktop 特有的、可能回头问用户的点**;desktop **非** isHeadlessStartup → 第一步那条 `autoBootstrapProjectFromCwd=false` gate 不适用 → 可能在 cwd=app 安装目录 autoBootstrap 一个 project(坏)。**若查出真问题,其修复属能力性质 → 归 PR1**。
3. **打包后真实布局**:desktop app 内 appRoot(packaged `input.appPath`)下 `apps/server/dist` + `apps/feishu-bot/dist` 的相对层级是否与 repo 一致(FeishuBotManager 2 层 prod entry 是否成立)?构建 artifact 后按真实布局核对钉死。
4. **bootstrap 接线深度**:仅靠 gate 默认开(最小,不动 desktop app),还是让 desktop app 显式传 `feishuBotManaged`(需碰 `apps/desktop/src` bootstrap 构造)?倾向最小(gate 默认开),bootstrap 传值作可选。
5. **CI release.yml 归属**:`build:desktop` 脚本含 bot(PR1)后 release.yml(调 `dist:desktop:artifact`)已自动纳入(已核 release.yml 零 feishu-bot 构建命令),PR2 复核确认无遗漏。另核 `scripts/build-desktop-artifact.ts:~1745` 的 `T3CODE_DESKTOP_SKIP_BUILD` 逃生口(跳过内部 `build:desktop`):release.yml 当前**未设**(已核),PR2 确认无 CI 路径设它(否则 §4A fail-fast 会打断 release CI)。
6. **desktop teardown 孤儿 bot**(§4F):desktop app 退出关 server 的方式(优雅 SIGTERM vs SIGKILL 直杀)决定 bot 会不会孤儿残留;headless 已验、desktop 路径未验。查出留孤儿则修复归 PR1。

## 【kickoff 必审 · 自传播规则】
本 kickoff 交付前**必须**多维对抗审查(workflow 或多 agent):① **代码事实**——file:line 逐条对真实 main 代码核验(尤其 `build-desktop-artifact.ts` 复制点行号、`DesktopBackendConfiguration.ts` 的 `ELECTRON_RUN_AS_NODE`、`FeishuBotManager.buildChildEnv`/execPath、`cli/config.ts` gate、`desktopBootstrap.ts` optional 字段、`build:desktop`/根 build task、release.yml bot 纳入);② **范围完整**——对照用户决策(desktop 默认开、拆 2 PR 能力/启用、e2e 分层)无遗漏无误分类,§4A 复制前提(build:desktop 含 bot 构建)确在 PR1;③ **自包含**——memory/文档路径真实、runbook 可执行、红线齐全、workspaceRoot·stateDir 特有风险(§9.2)已在文中点明。修掉确认项再交付,并把**本规则原样写进**衍生的下一里程碑 kickoff(若有)。
