# 飞书 Bridge bot-binding **PR3(web 绑定 GUI + 后端 clearBinding)** — 新会话启动提示词(薄)

> 把下面 `---` 之间内容粘到新会话作首条消息(或 `@` 引用本文件 + 「推进 bot-binding PR3」)。**本文是薄入口**:PR3 的 web 弹窗/二维码接线在 `docs/integrations/feishu-bridge-bot-binding-kickoff.md` §3.5/§4/§5/§7,**权威以那份 + 本文 delta 为准**(本文含一处**范围修正**:解绑需后端)。文中 file:line 为上次会话快照(2026-06-30),可能微漂,动手前用 Explore 复核。

---

你是「飞书接入 t3code」特性的**实现协调者(orchestrator)**,推进 **bot-binding 里程碑的 PR3(最后一块:web 扫码绑定 GUI + 后端解绑)**。纪律:**默认委派,保持主上下文干净**;不把大文件读进主上下文,派 Explore 返回结论。

## 0. 硬前置(先核对,否则停)
- **PR1(#13/`5a093786`)+ PR2(#14/`07334dcf`)必须已在 main**。核对:`git log --oneline -6` main 顶端有这两个 squash;`packages/contracts/src/feishu.ts`(`FeishuBindingStreamEvent` + `feishuStartBinding` RPC)、`apps/server/src/feishu/binding.ts`、`ServerSettings.feishuBinding`、bot 端 `acquireCredentials`/`runBoundSession` 都在 main。**若缺 → 停下告诉用户先合**。
- 从**更新后的 main** 新开分支 `feishu-bridge-bot-binding-pr3`。
- 提交/推送只在用户明确要求时。

## 1. 先读(memory + 文档)
- memory:`MEMORY.md` → **`feishu-bridge-bot-binding-impl-facts`**(PR1/PR2 已交付契约 + 本里程碑全貌 + 踩坑:**server 包名 `t3` 非 @t3tools/server**;bot 包名 `@t3tools/feishu-bot`;web 包名 `@t3tools/web`)、`feishu-bridge-m4-2-impl-facts`(**`FeishuSettings.tsx` 是 M4-2 PR2 #12 建的 web 飞书 tab,复用 `ProviderModelsSection` 的 Input+Add+XIcon 模式;file-based routing `settings.feishu.tsx`**)、`feishu-bridge-goal`(薄客户端原则)。
- 文档:**`docs/integrations/feishu-bridge-bot-binding-kickoff.md` §3.5(web 接线,权威)/§4(安全红线)/§5(PR3 范围)/§7(e2e runbook)**。
- `AGENTS.md`(Performance/Reliability first;contracts schema-only;不 import `.repos/`;重复抽共享)。

## 2. PR3 范围(delta;权威接线见 milestone kickoff §3.5)
**⚠️ 范围修正(2 路 Explore 2026-06-30 实证):PR3 不是纯 web——解绑必须碰后端**。四块:

### 2.1 🔴 后端 `feishuClearBinding` RPC + `clearFeishuBinding` service 方法(解绑,PR1 未实现)
- **为何必须后端**(2 路 Explore 实证):① web 无法用 `updateSettings` patch 删 `feishuBinding`——`deepMerge`(`packages/shared/src/Struct.ts:16` `if(value===undefined)continue`)**不能删字段**;② secret store 的 appSecret **孤立残留**(`updateSettings` 只经 `persistProviderEnvironmentSecrets` 处理 provider env,**从不碰** `feishuSecretName`)。全仓无现成 clearBinding 符号、无更简单纯 web 解法。
- **contracts**(`packages/contracts/src/rpc.ts`):`WS_METHODS.feishuClearBinding: "feishu.clearBinding"`(:227-228 区)+ `WsFeishuClearBindingRpc = Rpc.make(WS_METHODS.feishuClearBinding, {payload: Schema.Struct({}), error: Schema.Union([ServerSettingsError, EnvironmentAuthorizationError])})`(req/resp 非流式,success 仿 `feishuGetBotCredentials`)。**🔴 别漏:注册进 `WsRpcGroup`(`rpc.ts:700+`)**。
- **🔴 必须新增 `clearFeishuBinding` service 方法(不能 handler 直接清)**:`apps/server/src/serverSettings.ts` 的 `ServerSettingsService` 加 `clearFeishuBinding`(平行 `persistFeishuBinding` `:663-705`),**在 `make()` 闭包内实现**——因 `writeSettingsAtomically`(`:529`)/`feishuSecretName`(`:84-86`)是**私有 const、未导出、不在 service 接口**,ws.ts handler 够不着;只有 make() 内 `writeSettingsAtomically`/`secretStore`/`writeSemaphore`/`settingsCache`/`emitChange` 都在作用域。
- **server handler**(`apps/server/src/ws.ts` `observeRpcEffect` 范式,仿 feishuGetBotCredentials `:1242`):只 `serverSettings.clearFeishuBinding`。**🔴 别漏:加进 handler record(:1242 区)+ `RPC_REQUIRED_SCOPE`(`ws.ts:278-349`)挂 `AuthOrchestrationOperateScope`(照抄现有飞书两条先例 :347-348)**。
- **🔴 `clearFeishuBinding` 实现要点**(实证):
  - **清字段=整体重写**(`deepMerge` 不能删):读全量 settings→构造**不含 `feishuBinding`** 的对象→`writeSettingsAtomically(next)`(`:529`;`stripDefaultServerSettings` 剥默认,`feishuBinding` 是 `Schema.optional` 无 decoding default,不含该键即落盘干净)。**不要改 `applyServerSettingsPatch`(`packages/shared/src/serverSettings.ts:74-105`,经 `apps/server/src/serverSettings.ts:51` import;M4-2/所有 settings 写都走它,改它风险大)**。
  - **🔴 写尾三件不可漏**:`writeSettingsAtomically(next)` + `settingsCache` 的 `Cache.set` + `emitChange(next)`,整体包在 `writeSemaphore.withPermits(1)`(`:553/:622` 区)内做 read-modify-write。**`emitChange` 是 PR2 bot 解绑检测(`changesPubSub`→subscribeServerConfig→bindingView null)与 web live-refresh 的依赖,缺了只能靠 file-watcher 兜=脆弱/慢;不走 semaphore 则全量覆写吞并发 `updateSettings`(provider/allowlist)写**。
  - **🔴 删 secret + 清字段顺序**:**先清 settings 字段、后 best-effort `secretStore.remove(feishuSecretName(appId))`(remove 失败不硬翻整个 RPC)**——对齐 `persistFeishuBinding` 回滚纪律(`:698-703`)。对称分析:先删 secret 后清 settings 失败 → web section 仍显「已绑定」但 getBotCredentials 返 `{bound:false}`=不可用(体验更差);先清 settings 则最坏只留 dormant 孤立 secret(benign,re-bind 同 appId 覆盖)。未绑定→幂等。
- **bot 侧零改**:PR2 已验解绑(feishuBinding 消失→`subscribeServerConfig`→bindingView null→`raceFirst` 抢断→断飞书回未绑定等待),bot 不动。

### 2.2 client-runtime:绑定流订阅 atom + 解绑命令 atom
- **绑定流(订阅)**:`createEnvironmentRpcSubscriptionAtomFamily(runtime, {label, tag: WS_METHODS.feishuStartBinding})`(`packages/client-runtime/src/state/runtime.ts:577-607`,**空 payload**)。样例:terminal events(`state/terminal.ts:47-50`)/ vcs status(`state/vcs.ts:24-36`)。web 用 `useEnvironmentQuery(atom)` 消费→`{data, error, isPending}`(`apps/web/src/state/query.ts:11-13`;`atom===null→isPending:false`=关弹窗传 null 即断流)。
- **🔴 解绑(req/resp 命令)**:`feishuClearBinding` 是请求-响应,需一个**命令 atom/hook**(范式 `createEnvironmentRpcCommand` `runtime.ts:609`,**非订阅**)供解绑按钮触发;订阅 atom 只管绑定流,别用它发解绑。

### 2.3 web FeishuSettings 加绑定 section + 弹窗
- `apps/web/src/components/settings/FeishuSettings.tsx`(M4-2 #12,`FeishuSettingsPanel`,现状审批白名单):加 `<SettingsSection title="飞书 Bot 绑定">`(平行于审批白名单 section):
  - **当前绑定态**:`usePrimarySettings((s) => s.feishuBinding)`(redact 不碰它=下发安全,`serverSettings.ts:102-115` 只 redact providerInstances)→ 显示 appId + ownerOpenId;
  - 「**绑定**」按钮 → 开弹窗;「**解绑**」按钮 → 调 2.2 的**解绑命令 atom**(feishuClearBinding)→ 成功后 `feishuBinding` live-refresh 自动清空、section 回未绑定态。
- **绑定弹窗**(`apps/web/src/components/ui/dialog.tsx` `@base-ui/react` Dialog,样例 `PullRequestThreadDialog.tsx:18-25/57-64`):订阅 2.2 流 `useEnvironmentQuery(isOpen ? atom({environmentId}) : null)`——**关弹窗 isOpen=false→null→立即断流→server finalizer `AbortController.abort()`**(`apps/server/src/feishu/binding.ts:69-79`,不泄漏 registerApp 轮询)。按事件渲染(`FeishuBindingStreamEvent` `feishu.ts:28-77`):
  - `qr{url, expireIn}` → 二维码(QR 库)+ `expireIn` 倒计时;
  - `status{status, interval?}` → 轮询/扫码提示;
  - `bound{appId, ownerOpenId, tenant}` → 成功(owner 已自动入白名单,M4-2 复用);
  - `error{reason}` → 错误 + 重试(重开订阅)。
- **倒计时**:无现成 hook,`setInterval`+`useEffect`(仿 `apps/web/src/components/settings/settingsLayout.tsx:8-16 useRelativeTimeTick`);过期(expireIn→0)提示重新发起。

### 2.4 QR 库
- apps/web **无** QR 库(`apps/web/package.json` 确认)。加一个轻量 React QR → `apps/web` `dependencies`(web-only 直接写版本号,非根 catalog)。**确认最新版 API**(候选 `qrcode.react` v4 用 `import {QRCodeSVG} from "qrcode.react"`,或 `react-qr-code`;Explore 报告的 `qrcode.react` v1 `<QRCode>` API 已过时,勿照抄)。加依赖后 `pnpm install`。

## 3. 红线(不可弱化)
- **appSecret 绝不下发 web**:`bound` 事件只 `{appId,ownerOpenId,tenant}` 无 secret(契约 `feishu.ts:9` 保证 secret 只随 `feishuGetBotCredentials` 响应过线);web 读 `feishuBinding` 也无 secret。
- **流取消必触发 server abort**:关弹窗/组件卸载 → atom null → 流中断 → `AbortController.abort()`(`binding.ts:69-79`),不泄漏轮询 fiber/定时器。
- **clearBinding 门控 `AuthOrchestrationOperateScope`**(`ws.ts:278-349`,照抄飞书先例 :347-348)。**🔴 删 secret/清字段顺序固定:先清 settings 字段、后 best-effort `secretStore.remove`(remove 失败不硬翻 RPC)**——对齐 `persistFeishuBinding` 回滚(`apps/server/src/serverSettings.ts:698-703`),不留孤立 secret 且无「UI 显已绑定实不可用」态。
- **🔴 并发/原子**:`clearFeishuBinding` 的 read-modify-write(全量覆写)**必须在 `writeSemaphore.withPermits(1)` 内**(否则吞并发 `updateSettings` 的 provider/allowlist 写);写尾 `Cache.set`+`emitChange` 不可漏(`emitChange` 是 bot 解绑检测 + web live-refresh 依赖)。
- **不破**:M4-2 白名单 tab(同文件加 section,**不动审批白名单读写逻辑**)/ M4-1 authz/callbackAuth / PR2 bot(解绑/取凭证已验,bot 零改)/ M3·M4 路由 density。contracts 仍 schema-only。**不改 `applyServerSettingsPatch`(`packages/shared/src/serverSettings.ts:74-105`,经 `apps/server/src/serverSettings.ts:51` import)**——clearBinding 用 `writeSettingsAtomically` 整体写而非改 patch 语义,**不破坏其它 settings 写路径**(M4-2 allowlist/provider 等)。

## 4. 委派 / 闭环
- **Explore**(只读,file:line+结论):复核 §3.5 接线、`clearFeishuBinding` service 方法落点(`writeSettingsAtomically`/`feishuSecretName` 是 `make()` 闭包私有 const + 写尾 Cache.set/emitChange/writeSemaphore)、解绑命令 atom 范式(`createEnvironmentRpcCommand` `runtime.ts:609`)、QR 库最新 API、流订阅 `useEnvironmentQuery` 取消语义(关弹窗 null 立即断流非等 idleTtl)、`feishuStartBinding` 事件 union 渲染映射。
- **实现**:后端(contracts→server clearBinding)与 web(client-runtime atom + FeishuSettings + 弹窗 + QR)**文件不重叠可并行**(contracts schema 先行,后端/web 各一 agent);弹窗是新文件,FeishuSettings 是改 M4-2 文件须谨慎。
- **Test**:`pnpm --filter t3 run typecheck`(server)+ `@t3tools/contracts` + `@t3tools/web` typecheck;`pnpm exec vp check apps/server apps/web packages/contracts`(失败先 `vp fmt`)。web 加依赖后先 `pnpm install`。
- **Review**:多维 + 对抗,维度含:secret 不下发 web / 流取消 abort 资源清理(无 fiber/定时器泄漏)/ clearBinding 正确(整体写不破 patch 其它路径 + `writeSemaphore` 串行不吞并发写 + 写尾 Cache.set/emitChange 全 + 删 secret/清字段顺序无孤立/无「显已绑定实不可用」)/ 不破 M4-2 白名单 tab / 弹窗生命周期(订阅取消、倒计时 clearInterval、过期重发、error 重试)。
- **Confirm**:**全栈真扫码 e2e**(沿用 milestone kickoff §7):干净 `T3CODE_HOME` server(web 改了先 `pnpm -F @t3tools/web build`)→ web `localhost:3773/pair#token=` 认证 → 飞书 tab 点「绑定」→ 手机飞书扫码 → ① 弹窗显二维码+状态流转;② 绑定成功 `feishuBinding` 落 settings + appSecret 落 secret store(`{secretsDir}/feishu-bot-secret-<base64url(appId)>.bin`,**web 下发 settings 不含 secret**)+ owner 入 `feishuApprovalAllowlist`;③ bot 不设 `.env` 飞书凭证启动 → 从 server 取凭证连飞书(PR2 已验路径)→ ready;④ web 解绑 → secret 文件删除 + feishuBinding 清空 → bot 断飞书回未绑定等待。**收口 kill server+bot,清理 home。**

## 5. 提交
PR3 从更新后 main 新分支 → commit → push origin → `gh pr create --repo litchi98/t3code --base main` → 用户确认后 squash。**PR3 squash 即 bot-binding 里程碑完成**(web 扫码绑定 → 后端落 secret+binding → bot 自动取凭证连飞书 → web 解绑断连,全栈打通)。

## 【kickoff 必审 · 自传播规则】
本 PR3 收口 = bot-binding 里程碑完成,**无下一 PR kickoff**。但若衍生新里程碑 kickoff(如 server 托管 bot 生命周期、§11E 死按钮 bug),交付前必多维对抗审查(① 代码事实 file:line 逐条对真实 merged 代码;② 范围完整无遗漏无误分类;③ 自包含/引用真实/runbook 可执行/红线齐全),修后交付,并把本规则原样写进新 kickoff。

---

> 配合 memory(`feishu-bridge-bot-binding-impl-facts`、`feishu-bridge-m4-2-impl-facts`、`feishu-bridge-goal`、`feishu-bridge-kickoff-review-rule`)+ `docs/integrations/feishu-bridge-bot-binding-kickoff.md`(§3.5 权威接线)使用。
