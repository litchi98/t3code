# 飞书 Bridge「bot 绑定 GUI」里程碑 — 启动提示词(设计 + kickoff)

> 本里程碑是 **M4-3 重定义**:原 `feishu-bridge-m4-3-kickoff.md`(OAuth 网页登录拿 openId 写白名单)被用户拍板取代为「**web 图形化扫码绑定飞书 bot**」。原 OAuth-redirect 方案(redirect_uri/state CSRF/callback 端点)**整体作废**,改用 `@larksuiteoapi/node-sdk` 的 **`registerApp` 设备码(RFC 8628)扫码** provision —— 一次扫码同时拿到 `{appId, appSecret, openId}`,无 redirect_uri、无 state CSRF。
>
> 把下面内容粘到新会话作为首条消息(或 `@` 引用本文件 + 「推进飞书 bot 绑定」)。它自包含,依赖 memory + 本仓库设计/审查文档 + 已实证的 file:line。

---

你是「飞书(Lark)接入 t3code」特性的**实现协调者(orchestrator)**,现在推进 **「飞书 bot 绑定 GUI」里程碑**。职责是推进实现、把控质量,**默认委派、保持主上下文干净**。

## 0. 一句话目标
让非开发用户在 web「飞书」settings tab 点「**绑定飞书 bot**」→ 弹窗显示二维码 → 用户用飞书 App 扫码(可新建 app 或用已有 app)→ server 用 `registerApp` 设备码流拿到 `{appId, appSecret, openId}` → **appId/tenant/owner 写 ServerSettings、appSecret 写 secret store、owner 写审批白名单** → bot 经新 RPC 从 server 取凭证连飞书。**取代手改 `.env` 的 `FEISHU_APP_ID/SECRET/OWNER`。**

## 1. 已确认的范围决策(用户 2026-06-29 拍板)
1. **app 来源 = 新建 + 已有都支持 + addons 预配能力**。`registerApp` 不传 `createOnly` → 飞书扫码页让用户选「新建」或「用已有 app」;传 `addons` 预配 scope/事件/卡片回调。**「零飞书后台配置」非 100%**(部分 addons 是飞书灰度特性、`im.message.recalled_v1` 不在 SDK addons EventMap)→ 绑定后做**能力校验 + 提示用户补配**。
2. **bot 进程模型 = 本里程碑 bot 仍独立启动**(仍需 `T3_PAIRING_TOKEN`+server url 连 server),但**飞书凭证改从 server RPC 取**;「server 托管 bot 生命周期(绑定后自动拉起+注入凭证)」拆**后续里程碑**。
3. **拆 3 个 PR**:PR1 后端(contracts+server)/ PR2 bot / PR3 web。
4. **同一 app**(隐含强制):`open_id` per-app scoped,bot 与扫码必须同 app 才能让 owner openId 与 bot 看到的 senderId 一致(M4-1/M4-2 白名单语义)。`registerApp` 出来的 app 即 bot 用的 app,天然一致。
5. **env 凭证保留为 dev override / fallback**:`.env` 有 `FEISHU_APP_ID/SECRET` 时 bot 直接用(向后兼容现有 e2e);无则走 server RPC 取。

## 2. registerApp 设备码流(实证,`@larksuiteoapi/node-sdk` v1.67.0)
- **本质**:RFC 8628 Device Authorization Grant。`POST /oauth/v1/app/registration?action=begin` → 返回 `{device_code, verification_uri_complete, expires_in, interval}` → `onQRCodeReady({url, expireIn})` → 轮询 `action=poll` 直到完成 → resolve `{client_id(appId), client_secret(appSecret), user_info.open_id, tenant_brand}`。**可在 server 进程独立调用**(顶层导出函数,无需先建 channel/无需已有凭证/不依赖 WS)。
- **回调/类型**(`node_modules/.pnpm/@larksuiteoapi+node-sdk@1.67.0_*/node_modules/@larksuiteoapi/node-sdk/types/index.d.ts`):
  - `QRCodeInfo { url: string; expireIn: number }`(:300752-300755)—— web 把 `url` 渲成二维码,`expireIn` 做倒计时。
  - `StatusChangeInfo { status: 'polling'|'slow_down'|'domain_switched'; interval?: number }`(:300756-300759)。
  - `AppAddons { scopes?{tenant?,user?}; events?{items?{tenant?,user?}}; callbacks?{items?} }`(:300795-300851)—— JSON→gzip→base64url 编码进 QR url。
  - `RegisterAppOptions`:`{ domain?, larkDomain?, source?, signal?: AbortSignal, onQRCodeReady(必需), onStatusChange?, appPreset?, addons?, appId?, createOnly? }`。
  - 返回 `RegisterAppResult { client_id, client_secret, user_info?{open_id?, tenant_brand?} }`。
- **错误**(`lib/index.js` registerApp :90014-90057 / polling :89926-90012 / abort :89945-89952):`expired_token`(过期)、`access_denied`(用户拒绝)、`abort`(`signal.abort()`)、网络 Error。`authorization_pending`→继续;`slow_down`→间隔+5s;`domain_switched`→切 larksuite 域重轮询。
- **取消**:`new AbortController()`,web 关弹窗/流断开 → `controller.abort()` → 立即 reject + 清理定时器。
- **t3code bot 所需飞书能力**(addons 预配目标,见 `docs/integrations/feishu-bridge-design.md`):scopes `im:message.send_as_bot`/`im:message.group_msg`;events `im.message.receive_v1`/reactions/(recalled——SDK addons 不支持,需后台补);callbacks `card.action.trigger`;长连接(`@larksuite/channel` 自动维护,非 scope)。
- **参考实现**:`/Users/lizhipeng/dev-workspace/lark-coding-agent-bridge`(zarazhangrui/lark-coding-agent-bridge)`src/bot/wizard.ts:29-116`(registerApp + addons 用法)、`src/bot/channel.ts:172-241`(用凭证起 channel)、`src/config/secret-resolver.ts:33-79`(secret 外部化)。**只借鉴扫码 provision,不照搬其单进程 spawn CLI/独立 session 做法**(memory [[feishu-bridge-goal]] 红线)。

## 3. 架构(四层,均有实证模板)

### 3.1 数据落点(secret 隔离红线)
| 字段 | 落点 | 下发 web? |
|---|---|---|
| appId | `ServerSettings.feishuBinding.appId` | ✅(非密) |
| tenant | `ServerSettings.feishuBinding.tenant` | ✅ |
| owner openId | `ServerSettings.feishuBinding.ownerOpenId` + 写入 `feishuApprovalAllowlist`(复用 M4-2) | ✅ |
| **appSecret** | **secret store**(`ServerSecretStore.set("<name>", encode)`,仿 provider sensitive env) | ❌ **绝不** |

- **ServerSecretStore**(`apps/server/src/auth/ServerSecretStore.ts`):通用命名 secret KV,`get/set/create/getOrCreateRandom/remove`,存 `{secretsDir}/{name}.bin`(0o600,原子写 :187-221),与 settings.json 物理隔离。provide @ `server.ts:315`。
- **secret 持久化先例(照抄)** = provider sensitive env:`serverSettings.ts:366-465 persistProviderEnvironmentSecrets`(写 `secretStore.set(providerEnvironmentSecretName(...), encode(value))`,settings 只留 `valueRedacted:true`)/ `:321-364 materializeProviderEnvironmentSecrets`(读回 decode)/ `:75-80 providerEnvironmentSecretName`。

> ⚠️ **本节及 §3.2~3.5 的 `feishuBinding` 字段、`feishuStartBinding`/`feishuGetBotCredentials`/`feishuClearBinding` RPC、web QR 库均为本里程碑要新建的内容**;凡引 M4-2/现有代码 file:line(如 `:420-422 feishuApprovalAllowlist`、`:280 WsServerUpdateSettingsRpc`)均为「照抄的现成范式」,不是说飞书绑定相关符号已存在。
- **redact**:`serverSettings.ts:96-109 redactServerSettingsForClient` 只 redact providerInstances → `feishuBinding` 非密字段照常下发,appSecret 因不进 settings 而物理隔离。
- ServerSettings 加字段范式 = M4-2:`packages/contracts/src/settings.ts:420-422`(def,`withDecodingDefault`)/ `:546`(patch,`optionalKey`)。`updateSettings`(`serverSettings.ts:124-126` / `:566-581`,writeSemaphore `:263/:567` 串行;deepMerge 数组/对象替换 `packages/shared/src/Struct.ts:19`)。emitChange→changesPubSub(`:271/:577`)→ M4-2 live-refresh 链路。

### 3.2 contracts(`packages/contracts/src/rpc.ts`,schema-only)
- `WS_METHODS`(:146-234)加方法名。RPC 定义范式:req/resp = `WsServerUpdateSettingsRpc`(:280,`Rpc.make({payload,success,error})`);流式 = `WsSubscribeServerConfigRpc`(:661,加 `stream:true`)。
- **新增 RPC**:
  1. `feishuStartBinding`(**流式**):payload `{ mode?: "new"|"existing", appId? }`(appId 仅 existing 模式可选预填);success/stream event union:`{type:"qr", url, expireIn}` | `{type:"status", status, interval?}` | `{type:"bound", appId, ownerOpenId}` | `{type:"error", reason}`。
  2. `feishuGetBotCredentials`(**req/resp**):payload `{}`;success `{bound:false}` | `{bound:true, appId, appSecret, tenant}`(**appSecret 在响应里——operate-scope + 不入日志**)。
  3.(可选)`feishuClearBinding`(req/resp):解绑(删 secret + 清 feishuBinding)。
- ServerSettings 加 `feishuBinding: Schema.optional(Schema.Struct({appId, tenant: Literal("feishu","lark"), ownerOpenId}))` + 对应 patch。

### 3.3 server(`apps/server`)
- 引 `@larksuiteoapi/node-sdk`(给 `apps/server/package.json` 加直接依赖;v1.67.0 与 `@larksuite/channel@0.2.0` 均已在 pnpm-lock、版本一致),**根 `pnpm-workspace.yaml` catalog 钉 `1.67.0`**,装后查 lock 无冲突。
- **binding service**:`feishuStartBinding` handler 用 `observeRpcStreamEffect`(`ws.ts:1691-1741` 范式)把 `registerApp` 的 `onQRCodeReady/onStatusChange` 经 **`Stream.callback`**(effect-smol `Stream.ts:848`,**非 `Stream.async`/`asyncScoped`——它们不存在**;callback→Stream + scope finalizer/`Effect.onInterrupt` 清理,见 `.repos/effect-smol/LLMS.md`)桥成流;**流被中断(web 关弹窗/断开)→ finalizer `AbortController.abort()`**;resolve 后:**单次 `updateSettings` patch 原子写 `feishuBinding` + append owner 到 `feishuApprovalAllowlist`**(两字段同 patch,`applyServerSettingsPatch` deepMerge,`packages/shared/src/serverSettings.ts:74-105`,writeSemaphore 串行)+ `secretStore.set` 写 appSecret → emit `{type:"bound"}`;reject → emit `{type:"error", reason}`(**reason 必须为常量枚举,绝不 `throw`/透传 registerApp 原始错误**——否则会落进 Effect span 属性)。
- **`feishuGetBotCredentials` handler**(`observeRpcEffect` 范式 `ws.ts:1219-1228`):读 `feishuBinding`(appId/tenant)+ `secretStore.get` appSecret → 返回;未绑定 → `{bound:false}`。**RPC 日志安全已验**:`RpcInstrumentation`(`apps/server/src/observability/RpcInstrumentation.ts:89-144`)只记 method/duration 元数据、**不记响应体** → appSecret 在响应里不入日志/trace(仍须 handler 内不主动 log)。
- **门控**:`RPC_REQUIRED_SCOPE`(`ws.ts:277-346`)给所有新 RPC 都挂 `AuthOrchestrationOperateScope`(绑定/取凭证/解绑都是 operate 级);**未挂 scope 的 method 会 throw「no declared authorization scope」非默认放行**(PR1 须验 `authorizeEffect(undefined,...)` 确实拦截)。
- **并发控制**:`registerApp` 绑定流须 server 端 `Semaphore`/`Ref` 单例(同时最多一个绑定进行中)或明示 last-write-wins;防多 web 端并发绑定互相覆盖 feishuBinding/appSecret。
- **能力校验(可选 MVP)**:绑定后调 open-platform API 校验 scope/事件是否齐,缺则 `{type:"bound", warnings:[...]}` 提示补配。

### 3.4 bot(`apps/feishu-bot`)
- `config.ts`:飞书凭证字段转**可选**(server 连接字段不变);`.env` 有则用(dev override)。**🔴 阻塞项**:当前 `config.ts:221-230` 把 `FEISHU_APP_ID/SECRET` 当**必填**(缺则启动 throw)→ 必须改成可选返回 null,否则未绑定 bot 起不来。
- `bot.ts runBridge`(`:3413`):连飞书(`gateway.connect` :3101)前,**优先级 if-else**:`.env` 有 appId/secret → 直接用(跳过 RPC);否则 `EnvironmentRpc.request(WS_METHODS.feishuGetBotCredentials, {})`(`:246` 范式)取凭证。**larkGatewayLayer 由静态(`:3378 larkGatewayLayer(config.feishu)`)改为动态构建**(用 RPC 结果)。
- **未绑定**:`{bound:false}` → 不连飞书,订阅 config(复用已有 subscribeServerConfig fiber,M4-2,`bot.ts:765`)等 `feishuBinding` 出现 → 取凭证 → 连。
- **re-bind / 解绑**:config 流里 `feishuBinding` 变化 → 重取凭证 → **重连 channel**;解绑(feishuBinding 清空)→ disconnect + 回「未绑定等待」态,不留孤立 LarkGateway scope。`createLarkChannel`(`lark/channel.ts:178-201`)是长连 WS,有 reconnect handlers(:242-247)/disconnect+`Effect.addFinalizer`(:206-208/257)但**无「换凭证重建」逻辑**。
- **🔴 PR2 最大难点 = layer 动态化**:`larkGatewayLayer` 现固化在 baseLayer 的 `Layer.mergeAll`(`bot.ts:3373-3413`),其后的 `turnQueueLayer` 等也跟着固化 → 改「可销毁+换凭证重建」需 `Layer.unwrap`/scoped layer 重写整个堆栈(可借鉴 effect-smol `LayerMap.Service`,本项目未用过须调研)。**工程量高于其它 PR,建议 PR2 先单独梳理 layer 重构方案再动手;bot.ts 枢纽单 agent 串行改。**
- **顺序天然契合**:bot 本就先连 server(`:3366 resolveEnvironment` → auth.ts:34-61)再连飞书,插入「取凭证」在两者之间无冲突。

### 3.5 web(`apps/web`)
- `components/settings/FeishuSettings.tsx`:加「绑定飞书 bot」按钮 + 当前绑定态展示(appId/owner,从 `feishuBinding` 读,M4-2 atom 自动刷新)+「解绑/重新绑定」。
- 绑定弹窗:订阅 `feishuStartBinding` 流(`createEnvironmentRpcSubscriptionAtomFamily` `client-runtime/src/state/runtime.ts:577-607` 范式 + `useAtomValue` 消费)→ 渲二维码(`url`,用 QR 库)+ 状态 + `expireIn` 倒计时 → `bound` 显示成功(owner 已自动入白名单)/ `error` 显示原因 + 重试;关弹窗 → 取消订阅 → server 流中断 → registerApp abort。
- QR 渲染:web 需一个二维码库(`url`→QR image),确认 `apps/web` 现有依赖有无 QR 库,无则加一个轻量的。

## 4. 安全红线(不可弱化)
- **appSecret 隔离**:只进 secret store(0o600),绝不进 settings.json、绝不下发 web、绝不入日志(`registerApp` result、`feishuGetBotCredentials` 响应、错误日志均不得含 secret/code)。
- **appSecret 过线唯一处** = `feishuGetBotCredentials` 把 appSecret 下发给已配对 bot —— 经认证 WS、`AuthOrchestrationOperateScope` 门控、响应不入日志。bot 是 operate 级可信客户端,与其信任边界一致。
- **绑定端点门控**:`feishuStartBinding` / `feishuGetBotCredentials` / `feishuClearBinding` 全挂 `AuthOrchestrationOperateScope`(防暴露 server 被陌生人自助绑定)。
- **取消/资源**:流中断必 abort registerApp(`AbortController`),不泄漏轮询定时器/fiber。
- **设备码无 redirect_uri / 无 state CSRF**:比原 OAuth-redirect 方案少一整块攻击面(原 kickoff 的 redirect_uri 注册/state 存储/开放重定向全部作废)。
- **不破既有**:复用 M4-2 白名单写/live-refresh/fail-safe(env 地板/读侧 trim+filter/last-known-good)、M4-1 callbackAuth verify 四项/HMAC/nonce/policyFingerprint/`effectiveAllowlistFor` 门控/旁观者/M18、M3a·M3b 路由 density —— 全复用,只**新增**绑定入口 + 凭证下发 RPC。contracts 仍 schema-only。
- **健壮**:registerApp 失败/过期/拒绝/网络错/server 无凭证 → 优雅 `{type:"error"}` / `{bound:false}`,**绝不崩 server/bot 进程**。bot 取凭证失败 → 不连飞书、退避重试,不崩。
- **registerApp 长轮询 fiber 生命周期**(健壮性设计):① web 流断开/关弹窗 → finalizer `AbortController.abort()` 终止轮询 fiber(不泄漏);② server 重启 → web 流 error,客户端优雅重试(不残留);③ `expireIn` 到 → `expired_token` 收尾;④ 单例并发守卫见 §3.3。

## 5. 拆 PR(用户拍板 PR1 后端 / PR2 bot / PR3 web)
- **PR1(后端,承载全部安全红线)**:contracts(feishuBinding 字段 + 2~3 个 RPC)+ server(`@larksuiteoapi/node-sdk` 依赖 + catalog 钉版本 + secret store 接线 + registerApp binding service + 流式/req-resp handler + RPC_REQUIRED_SCOPE 门控 + 能力校验可选)。**可验**:写个脚本/测试直连驱动 `feishuStartBinding` 流(手机扫码),看 feishuBinding 落 settings、appSecret 落 secret store(不下发)、owner 入白名单。
- **PR2(bot)**:config 凭证可选 + runBridge 取凭证(env fallback)+ larkGatewayLayer 动态构建 + 未绑定等待 + re-bind 重连 channel。**枢纽文件 bot.ts 单 agent 串行改**(M2b/M3/M4 都踩过两 agent 同改 bot.ts 的坑)。
- **PR3(web)**:绑定按钮 + 弹窗(订阅流 + QR + 状态 + 倒计时 + 取消)+ 当前绑定态/解绑 UI。

## 6. 飞书后台前置(用户做)
- **新建路径**:扫码时若飞书租户支持 addons 灰度 → scope/事件/卡片回调一步预配;**否则绑定后按校验提示去后台补**(尤其 `im.message.recalled_v1`)。
- **已有路径**:用户先在飞书后台建好 app + 配齐 t3code 所需 scope/事件/卡片回调 + 开长连接,扫码只取凭证。
- registerApp 的 QR 指向 `accounts.feishu.cn`(国内)/`accounts.larksuite.com`(国际,domain_switched 自动切)。

## 7. e2e runbook(沿用 M4-2 框架,改为绑定验证)
- 干净 `T3CODE_HOME=~/.t3-feishu-bind` serve(:3773,自带 web dist;web 改了 `pnpm --filter @t3tools/web build`)。
- web `localhost:3773/pair#token=<tok>` 认证 → 飞书 tab 点「绑定」→ 手机飞书扫码(新建或选已有 app)→ 看:① web 弹窗显示二维码+状态流转;② 绑定成功后 `<HOME>/userdata/settings.json` 出现 `feishuBinding`(appId/tenant/owner)+ `feishuApprovalAllowlist` 含 owner;③ secret store 文件出现 appSecret(`{secretsDir}/<name>.bin`,0o600),**web 下发的 settings 不含 secret**。
- bot(**不设** `.env` 的 FEISHU_APP_ID/SECRET,验从 server 取):`T3_PAIRING_TOKEN=<新token> T3_HTTP_BASE_URL=... node apps/feishu-bot/src/main.ts` → 日志显示「从 server 取到凭证 + 连飞书成功」→ 群里 @bot 起 turn / owner 批审批卡 → 通。④ web 解绑 → bot 检测 re-bind/解绑 → 断飞书。
- 失败路径:扫码超时/拒绝/关弹窗 → web 优雅报错 + registerApp abort;server 无凭证时 bot 等待不崩。**收口 kill server+bot 清理。**

## 8. 明确不在范围
- **server 托管 bot 生命周期**(绑定后自动拉起 bot + 注入凭证)—— 用户确认拆后续里程碑;本里程碑 bot 仍独立启动(凭证从 server 取)。
- **多 bot / 多租户**(一个 server 绑多个飞书 app)—— 单 bot 单绑定;若未来要做属新设计。
- **§11E 审批卡超时死按钮 bug**([[feishu-bridge-approval-timeout-deadcard-bug]])—— 独立立项,别误碰超时/observe 路径。
- 原 M4-3 OAuth-redirect 方案(redirect_uri/state CSRF/callback 端点)—— **作废**,设备码取代。

## 9. 第一步(必做,按序)
1. 读 memory:[[feishu-bridge-bot-binding-impl-facts]](本里程碑施工事实,若已存在)、[[feishu-bridge-m4-2-impl-facts]](白名单 live-refresh/secret 隔离基础)、[[feishu-bridge-m4-impl-facts]](authz 红线)、[[feishu-bridge-goal]](薄客户端原则/不照搬参考仓库 spawn CLI)、[[feishu-bridge-m2b-impl-facts]](HMAC/nonce 边界)。
2. 读 `AGENTS.md`(重复抽共享 / Performance·Reliability first / contracts schema-only / 不 import .repos/ / 写 Effect 先看 `.repos/effect-smol/LLMS.md`)。
3. 派 Explore 复核本 kickoff 关键接线是否仍准(代码可能微漂):secret store 写法、`registerApp` callback→Stream 桥接(effect-smol 的 `Stream.async`/`Stream.asyncScoped` + finalizer)、RPC 流式 handler 范式、bot larkGatewayLayer 动态化落点。
4. **OAuth/凭证安全面(secret 不泄、operate-scope、abort 清理、不破 M4-1/M4-2)先独立对抗审查方案,再开写。**

## 上下文卫生(硬约束)
- 不把大文件/长 diff/大量搜索结果读进主上下文;派 sub-agent 读并返回摘要/结论。主上下文只留:当前状态、决策、下一步。
- 里程碑结束把进度/决策/踩坑写进 memory(`feishu-bridge-bot-binding-impl-facts.md` + 更新 `MEMORY.md` + 更新 `feishu-bridge-m4-2-impl-facts` 下一步指针)。
- **委派决策**:调研/接线/SDK 用法/定位代码 → Explore;多文件实现 → workflow/并行 sub-agent(**互不重叠文件并行;bot.ts 枢纽单 agent 串行**);typecheck/vp check → sub-agent 只回结论(`pnpm exec vp check <pkg>`,失败先 `vp fmt`);代码 review(尤其 secret 安全)→ 多维独立审查 + 对抗验证;流设计/拆 PR/与用户确认 → 你自己。

## 每里程碑闭环(不可跳步)
Plan(Explore 复核 + 安全方案对抗审查 + 与用户敲定)→ Implement(PR1→2→3)→ Test(typecheck + `vp check` 全过)→ Review(多维 + 对抗;维度含:secret 隔离/operate-scope 门控/abort 资源清理/registerApp 健壮/不破 M4-2·M4-1·M3/动态 channel 重连正确)→ Fix → Confirm(真连接 e2e 必跑,单账号即可:扫码绑定 → settings+secret store+白名单落位且 secret 不下发 → bot 从 server 取凭证连飞书 → 解绑断连)。提交/推送只在用户明确要求时;从 main 新开分支逐 PR。

## 【kickoff 必审 · 自传播规则】
收口时若写下一会话 kickoff:必须多维对抗审查那份新 kickoff(① 代码事实准确性——逐条对照真实 merged 代码 file:line;② 范围完整性——对照 memory 残留/待办无遗漏无误分类;③ 自包含与引用正确——memory/文档路径真实存在、runbook 可执行、红线齐全),修掉确认项再交付,并把本规则原样写进新 kickoff。(本份已按 [[feishu-bridge-kickoff-review-rule]] 多维审查后交付。)

---

> 配合 memory(`feishu-bridge-bot-binding-impl-facts`、`feishu-bridge-m4-2-impl-facts`、`feishu-bridge-m4-impl-facts`、`feishu-bridge-goal`、`feishu-bridge-m2b-impl-facts`、`feishu-bridge-kickoff-review-rule`、`feishu-bridge-approval-timeout-deadcard-bug`)+ 设计文档 `feishu-bridge-design.md` 使用。
