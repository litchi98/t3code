# 飞书 Bridge「feishu-bot headless 生产 bundle」里程碑 — 新会话启动提示词

> 把下面 `---` 之间内容粘到新会话作首条消息(或 `@` 引用本文件 + 「推进 feishu-bot headless 生产 bundle 里程碑」)。本文**自包含**,嵌了调研实证 file:line(快照 2026-07-01,可能微漂,动手前用 Explore 复核)。配合 memory(`feishu-bridge-server-managed-bot-impl-facts`、`feishu-bridge-bot-binding-impl-facts`、`feishu-bridge-e2e-pairing-token`、`feishu-bridge-goal`、`feishu-bridge-kickoff-review-rule`)使用。

---

你是「飞书接入 t3code」特性的**实现协调者(orchestrator)**,推进**「feishu-bot headless 生产 bundle」里程碑**(生产化两步走的**第一步**)。纪律:**默认委派,保持主上下文干净**;不把大文件读进主上下文,派 Explore/Plan 返回结论。

## 0. 硬前置(先核对,否则停)
- **server 托管 bot 里程碑(PR #16)必须已合入 main**:`git log --oneline -3` 看有没有 `feat(feishu-bot): server 托管 feishu-bot 生命周期…`(可能 squash 带 `(#16)` 后缀,也可能普通 commit 如 `7e5919fa`);**或直接核** `apps/server/src/feishu/FeishuBotManager.ts` 在 main。核对 `apps/server/src/feishu/FeishuBotManager.ts`(service)、`serverRuntimeStartup.ts` 的 `reconcileFeishuBotLifecycle`/`feishu-bot.reconcile` phase、`cli/config.ts` 的 `feishuBotManaged`(兜底 `() => mode !== "desktop"`)都在 main。**若 PR #16 还挂着未合 → 停下告诉用户先合**(本里程碑改 `FeishuBotManager` 的入口解析,依赖它已在 main)。
- 从**更新后的 main** 新开分支 `feishu-bridge-headless-prod-bundle`。
- 提交/推送只在用户明确要求时;开 PR 前确认。

## 1. 先读(memory + 文档)
- memory:`MEMORY.md` → **`feishu-bridge-server-managed-bot-impl-facts`**(上一里程碑全貌:`FeishuBotManager` 现状/env 装配 4 注入 key/入口解析 `BOT_ENTRY_RELATIVE_PATH`/workspaceRoot 教训;**server 包名 `t3` 非 @t3tools/server**;bot 包名 `@t3tools/feishu-bot`)、**`feishu-bridge-e2e-pairing-token`**(e2e 启动真相 + server-managed 下不再手动起 bot)、`feishu-bridge-goal`(薄客户端原则)、`feishu-bridge-kickoff-review-rule`(本规则)。
- `AGENTS.md`(Performance/Reliability first;不 import `.repos/`;重复抽共享)。

## 2. 背景与目标
- **现状**:`FeishuBotManager` spawn bot 用**源码入口** `process.execPath` + `apps/feishu-bot/src/main.ts`(`FeishuBotManager.ts:84` `BOT_ENTRY_RELATIVE_PATH`,`:379` execPath,`:380` `path.resolve(import.meta.dirname, …)`)。bot **当前无 build 产物**(`apps/feishu-bot/package.json` 只有 `"dev": "node --watch src/main.ts"`,无 `build:bundle`,无 `dist/`)。
- **目标(本里程碑 = 生产化第一步)**:给 feishu-bot 产**独立生产 bundle**(`dist/main.mjs`,照 server 的 `dist/bin.mjs` 范式),并让 `FeishuBotManager` 在**生产**下 spawn `dist/main.mjs`、**dev** 下仍 spawn `src/main.ts`。让 headless 生产 server 不依赖 bot 的 `.ts` 源码 + TS toolchain 就能自动起 bot。**最大未知 = bundle 可行性**(bot 依赖能否干净打包),本里程碑要真正验证它。
- **不做(拆第二步里程碑)**:desktop 三级进程树(desktop→server→bot)、desktop 打包纳入 bot bundle、desktop `feishuBotManaged` 默认开、CI 加 bot 构建步骤、bot 落盘 30 天 bearer、多 binding。

## 3. 用户决策(已拍板,2026-07-01)
1. **范围 = 分两步,先 headless 生产 bundle**:本里程碑只做 bot 生产 bundle + `FeishuBotManager` 入口 dev/prod 分支,让 **headless 生产** server 能起 bot;desktop 相关全部拆第二步(降单里程碑风险)。
2. **desktop 保持默认关**(`feishuBotManaged` 兜底 `() => mode !== "desktop"` 不动),desktop 启用留第二步。

## 4. 架构(调研实证 file:line,快照 2026-07-01)

### 4A. bot 生产 bundle(照 server `vp pack` 范式)
- **工具 = vite-plus(`vp pack`)**。server:`apps/server/package.json:19` `"build:bundle": "vp pack"`;配置 `apps/server/vite.config.ts`(继承根 `vite.config.ts`),关键项:`pack.entry:["src/bin.ts"]`、`outDir:"dist"`、ESM、`banner:"#!/usr/bin/env node\n"`、`deps.alwaysBundle: shouldBundleCliDependency`(`vite.config.ts:7-16`,bundle 前缀 `@t3tools/`/`@pierre/diffs`/`effect-acp`/…),`@larksuiteoapi/node-sdk` 等 external(在 `package.json` deps 声明,不打进 bundle)。
- **bot 加 bundle 的最小改动**:① `apps/feishu-bot/package.json` scripts 加 `"build:bundle": "vp pack"`;② 新建 `apps/feishu-bot/vite.config.ts`(`mergeConfig(baseConfig, { pack:{ entry:["src/main.ts"], outDir:"dist", sourcemap:true, clean:true, deps:{ alwaysBundle: 只 bundle `@t3tools/` 前缀 } } })`)。bot entry `src/main.ts:33` `NodeRuntime.runMain(main)`(不用 `import.meta.main`,vp pack 能正确打单文件)。
- **workspace 内部依赖**:bot 依赖 `@t3tools/client-runtime`/`@t3tools/contracts`/`@t3tools/shared` —— 照 server **打进 bundle**(`@t3tools/` 前缀)。第三方 `@larksuite/channel`/`@effect/platform-node`/`@noble/curves` 走 external(照 server 对 lark SDK 的处理)。
- **根 build 纳入 = 需加 `build` task(非仅 `build:bundle`)**:根 `package.json:16` `"build"` 跑各包的 **`build` task**——server 被纳入靠 `apps/server/vite.config.ts:23-31` 的 `run.tasks.build`(= `node scripts/cli.ts build`,内部再 `--run build:bundle`),**server package.json 并无 `build` 脚本**。所以 bot **只加 `build:bundle` 脚本不会被 `pnpm build` 纳入**;要么照 server 给 bot 加真正的 `build` run-task(才能被根 build 产出 bot dist),要么把「根 build 纳入」显式划到第二步(本里程碑靠 `pnpm --filter @t3tools/feishu-bot run build:bundle` 手动产 dist)。见 §9.4。
- **external 依赖仍需 node_modules**:`@larksuite/channel`/`@noble/curves`/`@effect/platform-node` 照 server 走 external,bundle **非零依赖单文件**——运行时仍需 `node_modules`(与 server 一致;从仓库 checkout 跑 e2e 时 node_modules 在,OK)。
- **无 __dirname 坑**:grep 已验证 `apps/feishu-bot/src` 无 `__dirname`/`import.meta.dirname`/`import.meta.url` 用法,bundle 后不失效。
- **⚠ 最大未知**:`@larksuite/channel`(bot 的飞书长连接 SDK)能否干净 external/运行 —— 有无 native binding / dynamic require。**PR1 必须真构建 + `node dist/main.mjs` 跑起来验证**。

### 4B. `FeishuBotManager` 入口 dev/prod 分支(核心,信号选择要小心)
- 当前:`FeishuBotManager.ts:84` 硬编码 `BOT_ENTRY_RELATIVE_PATH="../../../feishu-bot/src/main.ts"`;`:379` `executablePath=process.execPath`;`:380` `entryPath=path.resolve(import.meta.dirname, BOT_ENTRY_RELATIVE_PATH)`。execPath **不用改**(headless dev/prod 都是 node;desktop 是 electron+`ELECTRON_RUN_AS_NODE`,那是第二步)。
- **要改 = entry 路径按 dev/prod 选**:dev → `src/main.ts`;prod → `dist/main.mjs`。
- **🔴 信号选择(关键设计,别踩坑;审查已实证)**:一个初判是用 `serverConfig.devUrl`(`config.ts:70`,来自 `VITE_DEV_SERVER_URL`/`--dev-url`)判 dev/prod——**否决**:headless dev(`node src/bin.ts serve` 不设 `VITE_DEV_SERVER_URL`)devUrl=undefined(`cli/config.ts:271-274` `getOrElse(()=>undefined)`)会被**误判 prod**;`staticDir`/`logWebSocketEvents` 同陷阱,更别用。用更 robust 的:
  - **首选:构建期 `define` 常量**——server `vite.config.ts:44-61` 已有 `pack.define` 范式;给 server pack.define 注入如 `__T3_PACKED__: true`,源码里该常量在 dev(从 src 跑)为 `false`/`undefined`、在 bundle 里为 `true`。**最确定、免疫目录布局漂移**(不依赖路径 substring)。
  - **备选:`import.meta.url` 后缀自省**——server 自身 prod 是**扁平单文件** `apps/server/dist/bin.mjs`(FeishuBotManager 被 **inline** 进去,后缀 `.mjs`)、dev 是 `apps/server/src/feishu/FeishuBotManager.ts`(后缀 `.ts`)。用 `endsWith(".mjs")`=prod / `.ts`=dev,**比"含 `/dist/`、`/src/`" substring 稳**(防仓库 clone 到本身含 `/dist/` 的路径误命中)。
  - **叠加兜底:dist 存在性 fallback**——判为 prod 后若 bot `dist/main.mjs` 不存在,fallback 到 `src/main.ts` + `logWarning`(防「生产 server 但 bot 没 build」doomed-spawn)。**存在性只做 prod 侧降级、不做主判**(否则 dev 环境有 stale dist 会错跑旧 bundle)。
  - **实现时定选 define(首选)或后缀自省**(见 §9.1);**别单用 devUrl、别用路径 substring 主判**。
- **🔴 prod/dev 相对路径不同级数(实测,别硬编同一常量)**:`vp pack` 产 server 为**扁平单文件** `apps/server/dist/bin.mjs`(**无** `dist/feishu/` 子目录),故 prod `import.meta.dirname` = `…/apps/server/dist`(到 `apps/` 只 **2 层**),prod entry = **`../../feishu-bot/dist/main.mjs`(2 层 `../`)**;dev 从 `…/apps/server/src/feishu`(**3 层**),dev entry = `../../../feishu-bot/src/main.ts`(3 层 `../`,= 现有常量)。**dev/prod 两分支必须用不同 `../` 级数** —— 不能复用单一 `BOT_ENTRY_RELATIVE_PATH`(那个 3 层常量只对 dev);更稳妥可从 server 包根结构化锚定 `apps/feishu-bot/…` 而非硬编层数。

### 4C. 不碰的(第二步里程碑)
- desktop 打包纳入 bot bundle:`scripts/build-desktop-artifact.ts:1509`(复制 server dist 的位置,bot 照加)、`DesktopEnvironment.ts:185`(`backendEntryPath`)、`DesktopBackendConfiguration.ts:122`(`ELECTRON_RUN_AS_NODE`)/`:124-141`(bootstrap envelope 加 `feishuBotManaged`)、`cli/config.ts:312-319`(desktop 默认关的 gate)、`.github/workflows/release.yml:420-496`(CI)。**本里程碑一律不动**。

## 5. 拆 PR(2 个,顺序依赖)
- **PR1 — feishu-bot 生产 bundle**:`apps/feishu-bot/vite.config.ts` + `package.json` `build:bundle`;真构建 `pnpm --filter @t3tools/feishu-bot run build:bundle` 产出 `dist/main.mjs`;**验证 `node apps/feishu-bot/dist/main.mjs` 能起到「等待 pairing token / binding」那步**(证明 bundle 可运行,尤其 `@larksuite/channel` 长连接能加载)。不碰 server。无依赖,可独立合。
- **PR2 — `FeishuBotManager` 入口 dev/prod 分支 + headless prod e2e**:改 `FeishuBotManager.ts:84/:380` 的 entry 解析(§4B 信号 + dist 存在性兜底);dev 仍 src、prod 走 dist。补单测(dev/prod 各解析到正确 entry;dist 缺失兜底)。headless 生产 e2e(见 §8)。依赖 PR1。

## 6. 红线(不可弱化)
- **不破 dev 手动/自动路径**:dev(server 从 src 跑)仍 spawn `src/main.ts`;`node --watch src/main.ts` 手动起 bot 仍工作。
- **bundle 不改 bot 运行时逻辑**:PR1 只加 build 配置,**不动 `apps/feishu-bot/src/**` 任何运行时代码**(改逻辑 = 越界)。
- **入口解析要有兜底**:prod dist 不存在时降级 src + `logWarning`,不直接 doomed-spawn(呼应 server-managed 里程碑的 desktop 教训)。
- **不碰 desktop / server-managed 生命周期红线**:现签 token / env scrub 7 键 / 退避 / finalizer / reconcile / `feishuBotManaged` 开关(desktop 默认关)全部不动;desktop 打包/CI 不动。
- **不碰** bot-binding / M4 authz / M3 路由 / M4-2 白名单。
- **单 bot、headless only**:desktop 三级进程树拆第二步。

## 7. 委派 / 闭环
- **Explore/Plan**(只读,file:line + 结论):复核 server `vp pack` 配置可裁剪面、bot 依赖 external/bundle 边界(尤其 `@larksuite/channel`)、`FeishuBotManager` 入口解析改点、dev/prod 信号(devUrl 陷阱 vs import.meta 自省 vs 存在性)、prod 相对路径层级、根 build 编排纳入。
- **实现**:PR1(bot bundle,纯 bot 侧新增配置)→ PR2(FeishuBotManager 入口分支,server 侧)。
- **Test**:`pnpm --filter @t3tools/feishu-bot run build:bundle`(产 dist) + `pnpm --filter @t3tools/feishu-bot run typecheck` + `pnpm --filter t3 run typecheck`(server 包名 `t3`) + `pnpm exec vp check`(失败先 `vp fmt`,**只跑改动子目录别在仓库根跑**) + FeishuBotManager 入口解析单测。
- **Review**:多维 + 对抗,维度含:bundle 产物可运行(dist/main.mjs 真能起,lark SDK 加载)/ 入口信号正确(dev 不误判 prod、prod 不误判 dev、devUrl 陷阱避开)/ dist 缺失兜底 / 不破 dev 路径 / bot 运行时零改动 / prod 相对路径正确 / desktop 与 server-managed 红线零改动。
- **Confirm**:headless 生产 e2e(见 §8)。

## 8. e2e runbook(sketch,实现时细化)
- **build bot**:`pnpm --filter @t3tools/feishu-bot run build:bundle` → 确认 `apps/feishu-bot/dist/main.mjs` 存在。
- **build server**(prod 布局):`pnpm --filter t3 run build:bundle` → `apps/server/dist/bin.mjs`(让 server 从 dist 跑 = prod 自省信号成立)。
- **起 headless 生产 server**:干净 `T3CODE_HOME`,`cd <ws> && T3CODE_HOME=<clean> T3CODE_PORT=3773 node apps/server/dist/bin.mjs serve`(**从 dist 跑,不设 `VITE_DEV_SERVER_URL`** = prod)。
- web `localhost:3773/pair#token=<tok>` 认证 → 飞书 tab 扫码绑定 → **看 server 自动 spawn bot,且 entry = `apps/feishu-bot/dist/main.mjs`(非 src)** → bot bootstrap → 连真飞书 `ws client ready`。
- 验:① prod server spawn 的是 **dist** entry(日志/进程 args 确认);② bot 连飞书 ready(bundle 可运行铁证);③ 对照 dev 模式(`node apps/server/src/bin.ts serve` 从 src 跑)仍 spawn **src** entry;④ 删掉 `feishu-bot/dist/` 后 prod server 兜底降级到 src + `logWarning`(不 doomed-spawn)。
- **收口 kill server(子 bot 随之清),清理临时 home**。参考 `feishu-bridge-e2e-pairing-token` + `feishu-bridge-server-managed-bot-impl-facts`(server-managed e2e 启动方式)。

## 9. 不确定处(实现中需确认 / 可能回头问用户)
1. **dev/prod 信号最终选型**:构建期 `define` 常量(`__T3_PACKED__`,首选,免疫布局漂移)vs `import.meta.url` 后缀自省(`.mjs`/`.ts`)vs dist 存在性 fallback。倾向「define 或后缀自省判 prod + dist 存在性只做 prod 侧兜底降级 src」。**别单用 `serverConfig.devUrl`**(headless dev 误判 prod)、**别用路径 `/dist/` substring 主判**(仓库路径可能含 `/dist/`)。实现时钉死。
2. **`@larksuite/channel` bundle 可行性**:能否 external 后在 bundle 运行时正常加载长连接;有无 native/dynamic require 让 `vp pack` 失败或运行时崩。**PR1 真构建 + 真跑验证**;若打不进/跑不了,回头调整 external 清单或问用户。
3. **prod 相对路径层级(已实测:扁平)**:`vp pack` 产扁平单文件 `dist/bin.mjs`,prod `import.meta.dirname` = `apps/server/dist` → prod entry = **`../../feishu-bot/dist/main.mjs`(2 层)**、dev = `../../../feishu-bot/src/main.ts`(3 层),两分支不同级数。构建后按真实 dist 布局复核钉死(或结构化锚定 `apps/`)。
4. **根 build 纳入 = task 机制非仅命名**:根 `package.json:16` build 跑各包 `build` task(server 靠 `vite.config.ts:23-31 run.tasks.build`,非 `build:bundle` 脚本)。bot 要被 `pnpm build` 纳入须加真正的 `build` task;否则本里程碑手动 `--filter @t3tools/feishu-bot run build:bundle` 产 dist(把根 build 纳入划第二步)。见 §4A。

## 【kickoff 必审 · 自传播规则】
本 kickoff 交付前**必须**多维对抗审查(workflow 或多 agent):① **代码事实**——file:line 逐条对真实 main 代码核验(尤其 `vp pack` 配置、`FeishuBotManager` 入口解析行号、`serverConfig.devUrl`/`import.meta` 信号、bot 依赖 external 边界、desktop 各落点确属第二步);② **范围完整**——对照用户决策(分两步、先 headless bundle、desktop 保持默认关)无遗漏无误分类,desktop/CI 确实拆第二步;③ **自包含**——memory/文档路径真实、runbook 可执行、红线齐全、devUrl 陷阱已在文中纠正。修掉确认项再交付,并把**本规则原样写进**衍生的下一里程碑(第二步 desktop)kickoff。
