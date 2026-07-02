# 飞书 Bridge「desktop 默认开 + workspace 跟随」里程碑 — 新会话启动提示词

> 把下面 `---` 之间内容粘到新会话作首条消息(或 `@` 引用本文件 + 「推进 feishu-bot desktop workspace 跟随里程碑」)。本文**自包含**,嵌了调研实证 file:line(快照 2026-07-01,可能微漂,动手前用 Explore 复核)。配合 memory(`feishu-bridge-desktop-process-tree-impl-facts`、`feishu-bridge-headless-prod-bundle-impl-facts`、`feishu-bridge-server-managed-bot-impl-facts`、`feishu-bridge-goal`、`feishu-bridge-kickoff-review-rule`、`feishu-bridge-e2e-pairing-token`)使用。

---

你是「飞书接入 t3code」特性的**实现协调者(orchestrator)**,推进**「desktop 默认开 + workspace 跟随」里程碑**(生产化后、让 desktop 飞书接入真正可用的收官拼图)。纪律:**默认委派,保持主上下文干净**;不把大文件读进主上下文,派 Explore/Plan 返回结论。

## 0. 硬前置(先核对,否则停)
- **desktop 三级进程树能力(PR #18 / commit `c1581d0c`)必须已合入 main**:`git log --oneline` 按**描述串** `feat(feishu-bot): desktop 三级进程树 …` 核(squash 合入后消息可能带或**不带** `(#18)`,别只按号搜);或核 `scripts/build-desktop-artifact.ts` 有 `distDirs.botDist`(~:1496)+ `resolvedFeishuBotDependencies`(~:1467)、`apps/server/src/feishu/FeishuBotManager.ts` `buildChildEnv` 有 `electronRunAsNode` 参数(~:206)。**若未合 → 停下告诉用户先合**(本里程碑在其上开 gate)。
- 从**更新后的 main** 新开分支 `feishu-bridge-desktop-workspace-follow`。
- 提交/推送只在用户明确要求时;开 PR 前确认。

## 1. 先读(memory + 文档)
- memory:`MEMORY.md` → **`feishu-bridge-desktop-process-tree-impl-facts`**(上一里程碑:desktop 能起 bot 但 gate 默认关,**原因正是本里程碑要解决的 workspace 语义**;含 teardown 2s grace 竞态待办、真 electron e2e 手法)、`feishu-bridge-server-managed-bot-impl-facts`(reconcile/binding 驱动/env scrub 红线)、`feishu-bridge-goal`(**核心目标 = 多端共享同一 session**——本里程碑正是让 desktop 飞书端接入用户真实工作的 session)、`feishu-bridge-e2e-pairing-token`(真连接 e2e 启动)、`feishu-bridge-kickoff-review-rule`(本规则)。
- `AGENTS.md`(Performance/Reliability first;不 import `.repos/`;重复抽共享)。

## 2. 背景与诊断(为什么现在 desktop 连不上用户真实项目)
- 上一里程碑让 desktop 三级进程树**能**起 bot,但 **gate 默认关**(`cli/config.ts:318-325` 兜底 `() => mode !== "desktop"`,注释已写「pending desktop workspace semantics … Enabling by default + workspace-follow is a later milestone」= **就是本里程碑**)。
- **根因诊断(Plan 已证)**:**server 根本没有「GUI 当前 project」这个概念**。
  - GUI 的「当前 project」是**纯渲染端状态**:由 activeThread 反推(`apps/web/src/components/CommandPalette.tsx:550` `currentProjectId = activeThread?.projectId`)、URL 只含 thread(`apps/web/src/routes/_chat.$environmentId.$threadId.tsx`,project 靠 thread 反推)、UI 态存 localStorage(`apps/web/src/uiStateStore.ts`)——**服务器侧不可见**。
  - bot 取的 `projects[0]`(`apps/feishu-bot/src/bot.ts:144-160` snapshot 分支)= `ProjectionSnapshotQuery.ts:314` `ORDER BY created_at ASC` 的**最旧**那个,既不是用户当前看的、更不是刚打开的。
  - shell 流事件只有 `snapshot|project-upserted|project-removed|thread-*`(`packages/contracts/src/orchestration.ts:421-452`),**无 focused/active-changed**;snapshot 结构无 `activeProjectId`。
  - 全库 `active project` 只表示「未删除」(`getActiveProjectByWorkspaceRoot`),**不是 GUI 焦点**。
  - **切「已存在」project 是纯客户端导航,服务器完全无感**;只有开「新」folder 才打服务器 `project.create`。
- **净结论**:desktop 下 bot 启动取 projects[0](最旧)或 fallback 在 home 建孤岛,与用户 GUI 当前 project 分叉 → 共享 session 不成立。**要让 bot 跟随,必须先在 server 造出「active project」信号,再让 bot 消费它** —— 这是本里程碑真正的地基。

## 3. 目标
让 desktop 飞书 bot 关联到**用户在 GUI 当前工作的 project**(使「共享 session」成立),然后 **desktop 默认开** gate;并修掉开 gate 才会暴露的 **teardown 2s grace 竞态**。

## 4. 用户决策(kickoff 第一件事必问,勿预设)
本里程碑触及**产品语义**,新会话**开工前必须**用 AskUserQuestion 跟用户敲定(尤其 ① 决定 Stage 2/PR-follow 存废与 bot 是否需重绑架构):
1. **锚定 vs 跟随(最关键)**:desktop 飞书 bot 是「启动时锚定一个 project 直到重启」(稳定、简单、Stage 1 即可),还是「用户在 GUI 切 project 就实时跟随重定向」(高保真、易 thrash、需 Stage 2 in-process 重绑或重启 bot)?
2. **切换时旧飞书会话**:用户切到 project B 时,project A 里已建的 Feishu topic→thread 映射与在途对话**留在 A**(仅新对话去 B)还是整体跟到 B?(bot topic 映射是 per-project 的,影响会话连续性)。
3. **单 vs 多 project**:一个 bot 进程只跟单一 active project(与「单 binding」对齐,推荐)还是同时服务多个 GUI 打开的 project(多窗口/tab)?
4. **多客户端谁说了算**:web + desktop 连同一 server 都在 assert active project 时,last-writer-wins 单一全局 activeProjectId(desktop 事实单用户,推荐)还是 per-client?
5. **无 project 空转**:fresh desktop、用户还没开任何 project 时 bot 收到飞书消息怎么回?(等待 / 提示「请先在 GUI 打开项目」)。

## 5. 架构(调研实证 file:line,快照 2026-07-01)

### 5A. 核心:server 造 active-project 信号 + bot 消费(候选 A,推荐;分阶段)
- **信号源**:新增 server 全局 in-memory `ActiveProjectRegistry`(`Ref<Option<ProjectId>>`,**非持久化**——GUI 焦点是易失的)。
- **生产者**:新增 RPC `orchestration.setActiveProject`(渲染端 thread 导航时调,projectId 从 activeThread 反推)。
- **消费面(bot)**:`orchestration.subscribeActiveProject`(变更流,**Stage 1 锚定用 subscribe-until-first + Stage 2 持续跟随都靠它**)+ `orchestration.getActiveProject`(即时读补充)。**刻意不改 `OrchestrationShellSnapshot` schema**(`orchestration.ts:413-419`,被 web/desktop 广泛消费,改它 blast-radius 大),用独立订阅解耦。
- **bot 改造(⚠ desktop-only,别破 headless)**:`discoverProject`(`apps/feishu-bot/src/bot.ts:163-214`)→ `resolveActiveProject`,**仅 desktop 分支**走 active-project;**headless/CLI/web 分支字节不变**(仍 projects[0] / `T3_WORKSPACE_ROOT` 自建)——否则 web client 连 headless server 会填 global activeProjectId 而改变 headless 行为(当前 oblivious to focus),破「不破 headless」红线。**空态 precedence 明确**:desktop = 订阅等 active-project 信号(见下);非 desktop = 现有 `T3_WORKSPACE_ROOT` 自建 → 无则 die。
- **⚠ Stage 1 是 subscribe-until-first,不是 get-once**:bot 在 server boot 时 binding 存在即 spawn,那时用户几乎还没导航 → activeProjectId 几乎总是 None。故 Stage 1 初始锚定必须**订阅等第一个非空信号**(subscribe→anchor-on-first→停),一次性 `getActiveProject` 会让 bot 永远空转。project 深织进 bridge(`bot.ts:486-499` 调用点、501-504 modelSelection、519-520 per-turn、CallbackAuth、topic 路由)——Stage 1 锚定后停订阅、不动态切;Stage 2 保持订阅 re-target。
- **分阶段**:
  - **Stage 1(本里程碑收官)**:bot 启动**订阅等第一个非空 active project 并锚定**(subscribe-until-first,替换 projects[0]),锚定后停订阅、不动态切。足以让 gate 默认开、共享 session 在锚定语义成立。
  - **Stage 2(可选,锁在 §4.1 产品决策后)**:bot 订阅 `subscribeActiveProject`,用户切 project 时新 Feishu turn 路由到新 project。
- **A 必带的连带修复(根除 home 孤岛)**:desktop 下停止注入 `T3_WORKSPACE_ROOT=home`(`FeishuBotManager.ts:648` `workspaceRoot: serverConfig.cwd` + `buildChildEnv` 201-214);mode==="desktop" 时省略该 key → bot 无 active project 时**空转等待**而非在 home 建孤儿。**⚠ 红线**:headless/CLI/web 仍须注入 `T3_WORKSPACE_ROOT=serverConfig.cwd`(server-managed 里程碑的 workspaceRoot 教训:headless serve 无 project 时靠它自建),只 desktop 分支改。

### 5B. 退路(候选 B):持久化进 ServerSettings + bot watch(pin 语义)
- `ServerSettings`(`packages/contracts/src/settings.ts:~428`)加 optional `feishuBotTargetProjectId`;渲染端经 `serverUpdateSettings` 写;bot 复用**已有 settings watch**(reconcile 已 watch `feishuBinding`)重定目标。
- **利**:复用现成持久化 + watch 基建、跨重启存活、天然单目标。**弊**:settings 是 atomic-write + semaphore,**每次导航写盘太重** → 更适合做**显式「把这个 project 用于飞书」的 pin 动作**(而非自动跟随);持久化对易失焦点语义是错的。
- **何时选 B**:若用户在 §4 倾向「显式 pin + 跨重启」而非「自动跟随当前」。

### 5C. 弃(候选 C):启发式取「最近活跃」project — bot 自己发 turn 会刷新时间戳自我 pin 死,太脆,记录为什么不选。

### 5D. gate 默认开(依赖 5A Stage 1 + 5E)
- `cli/config.ts:324` `() => mode !== "desktop"` → `() => true`,重写 305-317 注释(移除「pending workspace semantics」改述新机制)。`packages/contracts/src/desktopBootstrap.ts:9-11` 注释「Absent = defer to server default (managed=true)」当前**语义没错但括号笼统**——desktop 的最终 default 由 gate(`config.ts:324`)决定为 false、非 bootstrap schema;翻转 gate 后 desktop server default=true,该注释才字面完全对(无需改 schema)。**倾向不动** `DesktopBackendConfiguration.ts:124-141`(留空 = defer server default,最小)。

### 5E. teardown 2s grace 竞态修复(独立,应先行)
- 坐实:desktop→server `DEFAULT_BACKEND_TERMINATE_GRACE = 2s`(`apps/desktop/src/backend/DesktopBackendManager.ts:36`,用于 :361 `forceKillAfter`)< server→bot `BOT_TERMINATE_GRACE = 5s`(`FeishuBotManager.ts:67`,用于 :398;bot 关停是 server scope finalizer `FeishuBotManager.ts:813`)→ server 优雅关停需跑 finalizer 最坏 5s,但 desktop 2s 就 SIGKILL server → **bot 孤儿**(被 launchd/init 收养)。
- **不变量**:desktop→server grace **必须 >** server→bot grace(且给 server 其余 finalizer 留余量)。
- 方案权衡:(i) 单调大 desktop grace(拖慢所有 quit);(ii) 单调小 bot grace(可能来不及 flush Lark);**(iii) 推荐:两头一起挪 + 抽共享常量**固化不变量(如 bot ~2s + 更快 SIGTERM 响应、desktop ~4s,由共享常量派生 `desktop = bot + serverShutdownBudget`)。落点 `DesktopBackendManager.ts:36` / `FeishuBotManager.ts:67`,共享常量建议放 `packages/contracts`。**此 PR 独立可先行,且应在 gate 默认开之前落**(否则开 gate = 批量制造孤儿)。

### 5F. 不碰的(承前红线)
- server-managed 生命周期(现签 token/退避/finalizer/reconcile/subscribe-first)、上一里程碑入口解析 + 打包纳入 + electronRunAsNode 注入、bot-binding、M4 authz、M3 路由、M4-2 白名单——逻辑不动,只在其上加 active-project 消费。
- **env scrub 7 键 / 注入 key**:只在 desktop 分支省略 `T3_WORKSPACE_ROOT`(5A),其余字节不动。

## 6. 拆 PR(顺序依赖)
1. **PR-teardown**(独立先行去风险,§5E):grace 不变量 + 共享常量。
2. **PR-signal**(contracts + server,§5A):`ActiveProjectRegistry` + `setActiveProject`/`getActiveProject`/`subscribeActiveProject` 三 RPC + pubsub。不改 bot 行为(仍 projects[0]),纯铺信号。**含 registry 失效处理**:指向的 project 被 `project-removed`(shell 流)/ asserting client 断开时清 `Ref`(防 stale target;desktop 单用户低风险但须定义空态语义)。
3. **PR-producer**(渲染端):thread 导航时调 `setActiveProject`(projectId 从 activeThread 反推;**定义 `_chat.index`/无 thread/draft 时的空态**避免抖动)。
4. **PR-bot-anchor**(bot,Stage 1):`discoverProject`→`resolveActiveProject`(读 active,空则等待)+ desktop 停注入 `workspaceRoot=home`。此后共享 session 在锚定语义成立。
5. **PR-gate**(§5D):`config.ts:324` → `() => true` + 注释重写。依赖 PR-bot-anchor + PR-teardown。
6. **PR-follow**(可选 Stage 2,§5A):bot 订阅 `subscribeActiveProject` 切 project 重定新 turn。**锁在 §4.1 产品决策后**。
- 顺序:**PR1(teardown)与 PR2–PR5 整条链并行**(独立);PR2→PR3→PR4→PR5 线性(PR3 调 PR2 的 RPC、PR4 靠 PR2 信号、PR5 靠 PR4 不建孤岛);PR6 最后/可选。

## 7. 红线(不可弱化)
- **共享 session 目标**:改动最终要让 desktop 飞书端接入用户 GUI 当前工作的 project(锚定或跟随,按 §4 决策),而非 home 孤岛或最旧 project。
- **不破 headless/CLI/web**:`T3_WORKSPACE_ROOT` 注入只在 desktop 分支改;非 desktop 仍自建 project(server-managed workspaceRoot 教训)。gate 翻转不影响非 desktop(它们本就默认开)。
- **不改 `OrchestrationShellSnapshot` schema**(blast-radius),active-project 走独立 RPC/订阅。
- **teardown 无孤儿**:grace 不变量固化(desktop > bot),开 gate 前落。
- **env scrub / server-managed 生命周期 / 上一里程碑打包+入口解析 / bot-binding / M4 / M3** 逻辑不碰。
- **desktop app 层最小改动**(bootstrap 契约已 optional,倾向不显式传)。

## 8. 委派 / 闭环
- **Explore/Plan**(只读,file:line + 结论):复核 §5 各点(尤其渲染端「当前 project」信号在导航/index/draft/切环境下能否可靠产出明确 projectId 或明确「无」;active-project RPC 落点与 pubsub 复用;bot resolveActiveProject 改造面;grace 常量)。
- **实现**:PR-teardown → PR-signal → PR-producer → PR-bot-anchor → PR-gate →(PR-follow 可选)。
- **Test**:`pnpm --filter @t3tools/feishu-bot run typecheck`、server/web/contracts typecheck、`pnpm exec vp check`(改动子目录,失败先 `vp fmt`)、相关单测(registry/RPC/resolveActiveProject 空态)。
- **Review**:多维 + 对抗(维度:active-project 信号正确跟随 GUI / 空态不抖动 / bot 锚定或跟随符决策 / desktop 不再建 home 孤岛且 headless 仍自建 / gate 翻转不破非 desktop / teardown 无孤儿 / 不改 shell snapshot schema / env scrub 红线)。
- **Confirm**:真 electron-as-node 三级进程树 e2e(见 §9)。

## 9. e2e runbook(真 electron-as-node,承上一里程碑手法)
- **electron 二进制**:若本机是 stub(缺 `Frameworks/Electron Framework.framework`),`unzip ~/Library/Caches/electron/<hash>/electron-v<ver>-darwin-arm64.zip` 到 electron 包 `dist/` + 补 `path.txt`(上一里程碑实测手法)。
- **起三级进程树**:`ELECTRON_RUN_AS_NODE=1 <electron> apps/server/dist/bin.mjs serve <ws> --port <p> --base-dir <clean-home>`(先 `build:desktop` 产 dist)。**注意本里程碑要测 desktop mode 的 active-project**,serve/headless 可能不足以复现 GUI 当前 project 语义——需评估用真 desktop app 或注入 active-project 信号模拟。**PR-signal 落地后**:serve/headless e2e 可用 CLI/RPC 手动打 `orchestration.setActiveProject`(打点驱动验证点 ①②,免真 GUI);具体命令在 PR-signal 实现后补进本 runbook。
- **验证点**:① 用户 web 开 project A → setActiveProject → bot 锚定 A(非最旧/非 home);② (Stage 2)切 project B → 新飞书 turn 落 B;③ 无 project 时 bot 空态行为符 §4.5;④ desktop 下不再在 home 建孤岛(`ls` home 无新 project);⑤ gate 默认开:绑定即起 bot;⑥ teardown:关 server → bot 无孤儿(`ps`)。
- 参考 [[feishu-bridge-e2e-pairing-token]] 起 server + web 扫码复用 binding。**真 `.app`(electron-builder)全链路成本高,可留用户手动**。
- **收口 kill / 清临时 home**。

## 10. 不确定处(实现中确认 / 可能回头问用户)
1. **§4 全部产品决策**——尤其锚定 vs 跟随(决定 PR-follow 与 bot 重绑架构),kickoff 第一件事问。
2. **渲染端「当前 project」信号质量**:activeThread→projectId 在 `_chat.index`/无 thread/draft thread/切环境下的空态定义(PR-producer 地基)。建议先渲染端打点确认信号质量再定 RPC 形状。
3. **信号载体**:独立 RPC 对(推荐,低 blast-radius)vs 塞进 `OrchestrationShellSnapshot`(bot 单读省事但动全端 schema)——早定,决定 PR-signal contracts 面。
4. **Stage 2 重绑代价**:bot session observer/topic 路由深织单 project(`bot.ts:501+`),in-process 重绑是大改;退而重启 bot 则丢在途 turn + 重连 Lark,高频切换太重 → 影响 §4.1 决策。
5. **多客户端语义**:active-project 是 per-client 概念却拟用 server-global Ref(§4.4)。
6. **desktop mode e2e 复现**:serve/headless 能否复现 desktop 的 GUI-当前-project 语义,还是必须真 desktop app。

## 【kickoff 必审 · 自传播规则】
本 kickoff 交付前**必须**多维对抗审查(workflow 或多 agent):① **代码事实**——file:line 逐条对真实 main 代码核验(尤其 `bot.ts` discoverProject/调用点、`FeishuBotManager.ts` 注入点+grace、`cli/config.ts` gate、`orchestration.ts` shell 流+RPC 落点、`ProjectionSnapshotQuery.ts:314` ORDER BY、web `CommandPalette.tsx` currentProjectId、`DesktopBackendManager.ts` grace、`desktopBootstrap.ts`);② **范围完整**——对照设计(active-project 信号/bot 消费/gate/teardown/bootstrap)无遗漏无误分类,产品决策(§4)确列为「开工前必问」;③ **自包含**——memory/文档路径真实、runbook 可执行、红线齐全(尤其 desktop-only 改 `T3_WORKSPACE_ROOT`、不改 shell snapshot schema、共享 session 目标)、需问用户的产品语义已在文中点明。修掉确认项再交付,并把**本规则原样写进**衍生的下一里程碑 kickoff(若有)。
