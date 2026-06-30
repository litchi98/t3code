> ⚠️ **已被取代(2026-06-29)**:用户拍板把 M4-3 方向从「OAuth 网页登录拿 openId 写白名单」改为「**web 图形化扫码绑定飞书 bot**」(`registerApp` 设备码 provision,一次扫码拿 `{appId, appSecret, openId}`)。**本文档的 OAuth-redirect 方案(redirect_uri/state CSRF/callback 端点)整体作废。** 现行 kickoff 见 **`feishu-bridge-bot-binding-kickoff.md`**。本文件保留仅作历史/调研参考(server HTTP 路由/认证门控/secret 等接线调研仍部分有效)。

# 飞书 Bridge M4-3 实现会话 — 启动提示词(已取代,见 feishu-bridge-bot-binding-kickoff.md)

> 把下面 `---` 之间的内容粘贴到新会话作为首条消息(或 `@` 引用本文件 + 一句「推进 M4-3」)。它自包含,不依赖任何历史会话上下文(依赖 memory 与本仓库的设计/审查文档)。

---

你是「飞书(Lark)接入 t3code」特性的**实现协调者(orchestrator)**,现在推进 **M4-3 里程碑(飞书 OAuth 网页登录 → 自动获取本人 openId 写入审批白名单)**。你的职责是推进实现、把控质量,而**不是亲自写所有代码**。核心纪律:**默认委派,保持你自己的主上下文窗口干净。**

M0(headless 最小回路)、M1(单聊 MVP)、M2a/M2b-1〜4(approval/user-input 跨端 + HMAC + 卡片 v2/v3)、M3a(群聊 + 话题路由)、M3b(群聊降噪 + 话题内审批卡)、M4-1(后端 authz 解耦 + 多审批人 env 白名单)、**M4-2(web 配审批白名单 + server 持久化 + bot live-refresh,PR #11 `156649b0` + PR #12 `7bba63db`)** 均已合入 main。M4-3 把 M4-2 的「web 手填 openId」升级为「**飞书扫码 OAuth → server 换取本人 open_id → 自动加入 `ServerSettings.feishuApprovalAllowlist`**」,免去用户手动 `/whoami` 抄 openId。这是 M4 系列最后一块、也是体量最大的一块(**从零接 server HTTP OAuth 端点 + 给 server 引入飞书 SDK 依赖**)。

## M4-3 一句话目标
在 web「飞书」settings tab 加一个「用飞书登录添加我自己」按钮:点击 → 整页跳飞书授权页 → 用户扫码/授权 → server `/auth/feishu/callback` 用 code 换取该用户 `open_id` → 把这个 open_id 加进 `feishuApprovalAllowlist`(bot 经 M4-2 的 live-refresh 立即生效)。**纯工具性获取本人 openId,不创建 t3code 身份/session。**

## ⚠️ 动手前必须澄清的关键事实(否则会做错/碰红线)
- **【前置 · 须核对】M4-2 已合入 main**:PR #11(`156649b0`,后端 contracts+bot)+ PR #12(`7bba63db`,web tab)。`ServerSettings.feishuApprovalAllowlist`(`packages/contracts/src/settings.ts`,withDecodingDefault [])已存在;bot 经 `subscribeServerConfig` live-refresh(env∪store,fail-safe,见 bot.ts 的 `allowlistRef` + 订阅 fiber);web「飞书」tab 在 `apps/web/src/components/settings/FeishuSettings.tsx`(手填 openId,`update({feishuApprovalAllowlist:[...]})` @ :42)+ 路由 `apps/web/src/routes/settings.feishu.tsx`。**若 `main` 顶端非 `7bba63db` 或上述不符,核对后再开分支。** M4-3 复用这套白名单读写/live-refresh,**只新增"OAuth 获取 openId"的入口**,不改白名单的存储/生效机制。
- **t3code 是单 operator 模型,无多用户/身份概念**(调研实证:auth 只管"哪些客户端能连这个 server",`apps/web/src/environments/primary/auth.ts:504-527` 只有 authenticated/requires-auth 两态,无 userId)。⟹ **M4-3 的 OAuth open_id 仅用于写白名单,绝不创建用户账户/发 session/接入身份体系**(不碰 `createBrowserSession`/`exchangeBootstrapCredentialForAccessToken` 等)。callback 换到 openId、写白名单、redirect 回 web 成功页即止。
- **openId 一致性成立(M4-3 可行性地基,调研实证)**:飞书 `open_id` 是 **per-app scoped**(同一用户在同一飞书 app 下恒定)。OAuth 用**同一个 appId**拿到的 `open_id` == 用户给 bot 发消息的 `message.senderId`(`apps/feishu-bot/src/lark/types.ts:77`)== 点卡片的 `evt.operator.openId` == `/whoami` 显示值(`apps/feishu-bot/src/bridge/commands/handlers.ts:327`,`ctx.message.senderId`)== 白名单条目格式(`ou_...`)。**OAuth 拿到的 openId 直接进白名单即生效,无需任何转换。**(开工时建议一次性实测对一次:`/whoami` 拿 openId vs OAuth 拿 openId 应完全相同。)
- **飞书 SDK 能力(调研实证)**:`apps/feishu-bot` 用 `@larksuite/channel` v0.2.0(`apps/feishu-bot/package.json:13`),其 `channel.rawClient` 暴露底层 `@larksuiteoapi/node-sdk` 的 `Client`(`apps/feishu-bot/src/lark/channel.ts:317-327` 已用 `rawClient.contact.user.get`)。OAuth 三步:① **authorize URL 手拼**(SDK 无此方法):`${domain}/open-apis/authen/v1/index?app_id={appId}&redirect_uri={encoded}&state={state}`(domain 由 `FEISHU_TENANT` 决定:`DOMAIN_BY_TENANT` 表 `apps/feishu-bot/src/config.ts:97-101`、env 读取 :235、`config.domain` 赋值 :269);② **code 换 token 用 SDK 原生** `client.authen.accessToken.create({ data:{ grant_type:'authorization_code', code }})` —— **旧版 API 响应直含 `open_id`,一步到位**,SDK 的 `formatPayload`/`tokenManager` 自动注入 app_access_token,**不要手撸 HTTP**;③ 省去 userInfo 步骤。
- **server 当前无飞书依赖、无飞书密钥**(调研实证):`apps/server` 不依赖任何 lark SDK,`apps/server/src/config.ts` 也没有 FEISHU_APP_ID/SECRET(它们只在 `apps/feishu-bot/.env`)。M4-3 **必须给 server 引入飞书 code-exchange 能力**(给 `apps/server` 加 `@larksuiteoapi/node-sdk` 依赖,在 callback 里 new 一个 Client,只需 appId+appSecret,SDK 自管 app_access_token)+ 让 server 读 `FEISHU_APP_ID`/`FEISHU_APP_SECRET`(推荐 `Config.nonEmptyString("FEISHU_APP_ID")`,同 `apps/server/src/cloud/publicConfig.ts:95-106` 读 env 的现成模式,**不必动 `ServerConfig` interface**)。这是 M4-3 唯一的"架构扩面",务必在 Plan 与用户确认。
- **HTTP 路由落点(调研实证)**:server 用 Effect Platform `HttpRouter`。raw 路由模式 = `HttpRouter.add(method, path, Effect.gen(...))` 返回 Layer,在 `apps/server/src/server.ts:345` 的 `makeRoutesLayer` 里 `Layer.mergeAll` 挂入,**必须排在 catch-all `staticAndDevRouteLayer`(`apps/server/src/http.ts:217`,`GET *` 返回 index.html)之前**否则被吞。最佳 OAuth callback 模板 = `apps/server/src/cloud/CliTokenManager.ts:181-203`(state 校验 + code 换取的完整范式);302 redirect 见 `apps/server/src/http.ts:230`(`HttpServerResponse.redirect(url,{status:302})`);写 cookie 见 `apps/server/src/auth/http.ts:222-231`(`Cookies.set` @ :222 / `mergeCookies` @ :231)。`/pair` 不是 server 路由(是 SPA 客户端路由,catch-all 返回 index.html)。
- **server 端写白名单(调研实证)**:`serverSettings.updateSettings`(`apps/server/src/serverSettings.ts:124-126`,`(patch)=>Effect<ServerSettings,ServerSettingsError>`)在整个 server Layer 内经 `yield* ServerSettingsService` 可调(`apps/server/src/server.ts:315` 已 provide)。`feishuApprovalAllowlist` 是**整数组替换**(deepMerge 对 array 直接替换,`packages/shared/src/Struct.ts:19`),故**必须先 `getSettings` 读当前值再 append 去重再写**(updateSettings 内有 writeSemaphore 串行,并发安全)。
- **【fail-safe / 红线 · 不可弱化】**:M4-3 **绝不动** M4-2 的白名单 fail-safe(env 地板不可移除、bot 读侧 trim+filter、刷新失败 last-known-good)/ M4-1 的 authz 判定(callbackAuth verify 四项 r/s/c/fp、HMAC、nonce、policyFingerprint、`effectiveAllowlistFor` runtimeMode 门控、authz 早返前置 nonce consume、preserveCardForBystander、M18)/ M3a·M3b 路由·density。M4-3 只**新增** OAuth 入口往 `feishuApprovalAllowlist` 写值,白名单的读取/生效/鉴权一律复用现状。
- **【M4-3 自身安全红线】**:① **OAuth 端点必须经 operator 认证门控** —— `/auth/feishu/authorize` 应只允许已认证 server 的 web(带 browser session cookie)发起,否则暴露的 server(Tailscale/公网)会被任意陌生人 OAuth 自助加白名单(=越权)。② **CSRF**:authorize 生成 `state`、callback 校验 + 一次性消费(内存 `Ref<Map<state,{expiresAt}>>` TTL≤5min,参考 `apps/server/src/auth/PairingGrantStore.ts` seeded grant 模式;或 stateless HMAC 签名 state)。③ **redirect_uri 严格匹配**飞书后台注册值,不接受未注册/可篡改的 redirect。④ open_id 写入白名单走与 M4-2 同一信任边界(能操作已认证 web 的 operator 即可配置),不放宽。

## 第一步(必做,按序)
1. 读 memory(`MEMORY.md` 索引 + 这几条):
   - `feishu-bridge-m4-2-impl-facts.md` — **M4-2 全接线(ServerSettings.feishuApprovalAllowlist / bot subscribeServerConfig live-refresh / web FeishuSettings tab / fail-safe)+ e2e 验法**,M4-3 复用这套白名单基础设施。
   - `feishu-bridge-m4-impl-facts.md` — M4-1 authz 解耦(callbackAuth verify 四项 / authz 判定 / 旁观者 / M18),M4-3 不碰但须知红线。
   - `feishu-bridge-m2b-impl-facts.md` — cardAction HMAC / nonce / policyFingerprint 边界。
   - `feishu-bridge-goal.md` — 薄客户端原则 + §11E 补偿层 + token 现状(pairing 一次性+5min、无 refresh)。
   - `feishu-bridge-approval-timeout-deadcard-bug.md` — 与 M4-3 无关但记得它是独立待修项,别误碰超时/observe 路径。
2. 读项目规则 `AGENTS.md`(「重复=code smell 优先抽共享」「Performance/Reliability first」「contracts 包 schema-only」「不 import .repos/」「写 Effect 先看 .repos/effect-smol/LLMS.md」)。
3. 读设计文档相关节 `docs/integrations/feishu-bridge-design.md`(auth / settings 相关)。
4. **派 Explore sub-agent(同一条消息扇出,只读,返回 file:line + 结论)复核本 kickoff 的关键接线是否仍准确**(本 kickoff 写于 M4-2 刚合并时,代码可能微漂):
   - (a) **server OAuth 路由**:`HttpRouter.add` 模式 + `server.ts:345 makeRoutesLayer` 挂载顺序(须在 `http.ts:217 staticAndDevRouteLayer` 前)+ `CliTokenManager.ts:181-203` callback 范式 + 302/cookie 工具;以及 `/auth/feishu/authorize` 是否能拿到 browser session 做门控(`apps/server/src/auth/EnvironmentAuth.ts` / `auth/http.ts`)。
   - (b) **server 引飞书 SDK + 读密钥**:给 `apps/server` 加 `@larksuiteoapi/node-sdk` 依赖的最小面 + `Config.nonEmptyString` 读 FEISHU_APP_ID/SECRET(对照 `cloud/publicConfig.ts:95-106`)+ `client.authen.accessToken.create` 的确切调用签名/返回(node-sdk 类型)+ redirect_uri 配置项怎么传(env/CLI flag)。
   - (c) **白名单写入**:`serverSettings.updateSettings`(serverSettings.ts:124-126)server 端 read-then-append 写法 + ServerSettingsService 可达性(server.ts:315);对比"web-write"路径(server callback 只 redirect 带 openId 回 web,web 用 `useUpdatePrimarySettings` 写,useSettings.ts:278)。
   - (d) **web 入口 + 回跳**:`FeishuSettings.tsx` 加按钮(整页 `window.location.href`,先例 `SettingsPanels.tsx:351`/`PairingRouteSurface.tsx:280`)+ 新建 web 回调路由 `routes/settings.feishu.callback.tsx`(若采 web-write)+ `primaryServerSettingsAtom`(state/server.ts:74-76)自动刷新机制 + web 怎么拿 server HTTP base URL 拼 authorize 入口。
   - 实现细节不确定一律派 sub-agent 查并返回结论,不要自己翻大文件。

## 上下文卫生(硬性约束)
- **不**把大文件、长 diff、大量搜索结果读进主上下文;需要时派 sub-agent 读并返回**摘要/结论**。
- 你的主上下文只保留:当前状态、决策、下一步。细节沉到 memory 与 sub-agent。
- 里程碑结束把进度/决策/踩坑写进 memory(新增 `feishu-bridge-m4-3-impl-facts.md` + 更新 `MEMORY.md` + 更新 `feishu-bridge-m4-2-impl-facts` 下一步指针)。
- **【kickoff 必审 · 自传播规则】收口时若写了下一会话的 kickoff(如 M4 系列收尾报告或后续里程碑):必须用多维对抗审查那份新 kickoff(维度至少:① 代码事实准确性——逐条对照真实 merged 代码的 file:line;② 范围完整性——对照 memory 残留/待办无遗漏无误分类;③ 自包含与引用正确——memory/文档路径真实存在、runbook 可执行、红线齐全),修掉确认项再交付。kickoff 里写错 file:line / 过时论断会误导下个会话。并把这条「kickoff 必审 · 自传播规则」原样写进你产出的新 kickoff。(本份 M4-3 kickoff 已按此审过。)**

## 委派决策(默认委派,自己做是例外)
| 工作类型 | 交给谁 |
|---|---|
| 调研 / OAuth 接线 / server 路由 / SDK 用法 / web 回跳 / 定位代码 | **Explore** sub-agent(只读,返回 file:line + 结论) |
| 多文件实现 / 可并行改动 | **workflow** 或并行 sub-agent(互不重叠文件并行:server 路由层 / web 入口+回调路由 可并行;**若改 bot.ts 集成枢纽则单 agent 串行**——M2b/M3/M4 都踩过两 agent 同改一枢纽文件的坑)。注:M4-3 主战场在 server + web,bot 大概率不动(白名单 live-refresh M4-2 已就绪)。 |
| 跑 typecheck / lint / 测试 | sub-agent 执行,**只回结论**(动 server 则 `pnpm --filter @t3tools/server run typecheck`;动 web 则 `apps/web`;动 contracts 则 contracts;`pnpm exec vp check <pkg>`;失败先 `pnpm exec vp fmt <pkg>`) |
| 代码 review(**尤其 OAuth 安全:state/CSRF、端点门控、redirect_uri、密钥不泄、不破 M4-2/M4-1**) | 多维独立审查 + 对抗验证(对每条发现默认怀疑、查是否已处理再采纳);OAuth 安全面必须单独深审 |
| OAuth 流设计 / state 方案 / server-write vs web-write / 拆 PR / 与用户确认 | **你自己** |
| 一两行明确改动 / 读单个小文件确认一个事实 / 对话 | 你自己(例外) |

并行的独立调研/实现放在**同一条消息**里扇出,别串行等待。

## 每个里程碑的闭环(不可跳步)
1. **Plan** — 先用 Explore 复核接线,**产出 OAuth 流端到端方案(authorize→callback→换 openId→写白名单→回跳)+ state/CSRF 方案 + 端点门控方案 + server-write vs web-write 定夺 + 飞书后台前置项清单 + 拆 PR,与用户敲定范围后再动手**。别直接开写。**OAuth 安全方案(state/CSRF、端点门控、redirect_uri、密钥处理)务必先独立对抗审查。**
2. **Implement** — workflow / sub-agent(server 路由+SDK / web 入口+回调路由 互不重叠并行;枢纽文件单 agent 串行)。
3. **Test** — typecheck + `vp check` **必须全过**(凡触及的包:server + web +(若动)contracts),失败回 Implement。
4. **Review** — 多维独立审查 + 对抗验证,维度至少含:正确性 / **OAuth 安全(state 不可伪造/重放、callback 校验、端点经 operator 门控、redirect_uri 严格匹配、appSecret 不进日志/不泄露给前端;**若采 web-write**:open_id 是否经 redirect URL query param 传递 → 会落浏览器历史/server·Nginx·Tailscale 访问日志明文,Plan 定夺传值方式 = fragment `#openId=` / server-side session cookie / 短寿一次性 state-code 换取,避免 query 明文落日志)** / **openId 一致性(OAuth open_id 真能进白名单生效)** / 不破 M4-2 白名单读写·live-refresh·fail-safe / 不破 M4-1 authz·callbackAuth 红线 / 不破 M3a·M3b / server 引飞书依赖不污染其它路径 / 健壮(飞书 API 失败/超时/用户取消授权不崩 server)。
5. **Fix** — 修 review 确认为真的问题,重跑 Test。
6. **Confirm** — 向用户简洁汇报。**真连接 e2e 必跑**:web 点「用飞书登录添加我自己」→ 飞书授权 → 回跳后 `feishuApprovalAllowlist` 出现本人 open_id(与 `/whoami` 一致)→ bot live-refresh 日志 `allowlist updated added=[你]` → 群审批卡本人可批。再验 state 不匹配/用户取消授权的失败路径优雅处理。**单账号即可验。**

## 项目硬约束(违反即未完成)
- **bridge 是薄共享客户端**:白名单 = server 端共享配置;M4-3 只加"OAuth 获取 openId 写入"的入口,**白名单存储/生效/鉴权复用 M4-2/M4-1 现状**,不另起炉灶。
- **callbackAuth / authz / 白名单 fail-safe 红线**:M4-3 绝不动 callbackAuth verify 四项 / HMAC / nonce / policyFingerprint / `effectiveAllowlistFor` 门控 / authz 早返前置 nonce / 旁观者保护 / env 地板不可移除 / 读侧 trim+filter / live-refresh last-known-good。
- **OAuth 安全红线**:state CSRF 防护 + 一次性消费 + TTL;`/auth/feishu/*` 端点经 operator session 门控(防暴露 server 被陌生人自助加白名单);redirect_uri 严格匹配飞书后台注册;**appSecret 绝不出现在日志/前端/redirect URL**;OAuth 只取 open_id 不创建 t3code 身份/session。
- **server 引飞书依赖**:仅为 OAuth code-exchange,用 `@larksuiteoapi/node-sdk` 在 callback 内 new Client(appId+appSecret,SDK 自管 app_access_token);密钥经 `Config.nonEmptyString` 读 env,**不进 settings.json 明文**;不污染 server 其它路径。contracts 仍 schema-only。
- **健壮性**:飞书 API 失败/超时/用户拒绝授权/state 失配,server 一律优雅回错误页或 redirect 带 error,绝不崩进程、绝不写入垃圾 openId。
- 不 `import` `.repos/` 下 vendored 代码(且 `.repos/` 无 lark repo);写 Effect 代码先看 `.repos/effect-smol/LLMS.md`。client-runtime 只能子路径 import。重复逻辑抽共享。
- 提交/推送只在用户明确要求时做。**M4-3 从 main 新开分支 `feishu-bridge-m4-3`(先确认上方「前置」:M4-2 已合 main `7bba63db`)**,逐(子)里程碑 PR(commit → push origin → `gh pr create --repo litchi98/t3code --base main` → 用户确认后 squash 合并)。

## M4-3 范围(Plan 阶段与用户敲定确切边界)
核心:**web 飞书 OAuth 登录 → server 换取本人 open_id → 写入 `feishuApprovalAllowlist`**。候选清单(与用户拍板):
- ① **server OAuth 端点**:`GET /auth/feishu/authorize`(经 operator 门控,生成 state,302 跳飞书授权 URL)+ `GET /auth/feishu/callback`(校验 state,SDK `accessToken.create` 换 open_id)。
- ② **写白名单**:Plan 定夺 server-write(callback 内 `updateSettings` read-then-append)vs web-write(callback 只 redirect 带 open_id 回 web,web 用 `useUpdatePrimarySettings` 写,**调研倾向 web-write,改动更小、复用现成乐观更新+WS 推送、写入天然经已认证 web session 门控**)。
- ③ **web 入口**:`FeishuSettings.tsx` 加「用飞书登录添加我自己」按钮(整页 redirect);若 web-write 则新建 `routes/settings.feishu.callback.tsx` 读 open_id 写白名单再 navigate 回 tab。
- ④ **server 引飞书 SDK + 密钥 + redirect_uri 配置**:加 `@larksuiteoapi/node-sdk` 依赖 + `Config.nonEmptyString` 读 FEISHU_APP_ID/SECRET + redirect_uri 配置项。
- ⑤ 可选:登录成功/失败的 web 提示页;openId 与白名单已存在时的幂等提示;同 app 一致性的一次性实测脚本。

**建议性拆 PR(沿用 M4-2 后端→web 先例,Plan 与用户定夺)**:PR1 = server OAuth 端点(① authorize+callback)+ ④ server 引飞书 SDK+读密钥+redirect_uri 配置(后端,承载全部 OAuth 安全红线,可用 curl/浏览器直连验 authorize→callback 换 openId);PR2 = ③ web 入口按钮 + web callback 路由 + 写白名单(若 web-write)。OAuth 安全(state/CSRF/门控/密钥)红线归 PR1 重审。

## 明确不在范围
- **多用户 / 飞书身份登录 t3code**(创建账户/发 session/绑定身份)——单 operator 模型不需要,体量跳量级,本里程碑只做"工具性获取本人 openId"。若未来要做属全新认证层重设计。
- **§11E 审批卡超时死按钮 bug**(M4-2 e2e 发现,见 `feishu-bridge-approval-timeout-deadcard-bug.md`)——独立立项,与 M4-3 无关,别误碰超时/observe 路径。
- **模型 extended-thinking reasoning 显示** / `compareActivitiesByOrder` 跨包去重 / M3b 暂缓的 D3·D4 polish(grace race / planner✅闪现,跟踪在 [[feishu-bridge-m3b-impl-facts]])——均与 M4-3 无关。

## 需要用户提供
1. **飞书开放平台后台配置(M4-3 前置,用户在飞书后台做)**:① 给(与 bot 同一个 / 或专用 web 的)飞书 app **开启网页登录(OAuth/authen)能力**;② 在「安全设置」**注册 redirect_uri**(精确匹配 server 的 `/auth/feishu/callback` 完整 URL,本地通常 `http://127.0.0.1:3773/auth/feishu/callback`,公网/Tailscale 则相应域名);③ 确认 OAuth scope(拿 open_id 通常 `contact:user.base:readonly` 或等价)已开通。**Plan 阶段先与用户确认:同一个 bot app 还是专用 web OAuth app。**
2. **可验「web 飞书登录加白名单实时生效」的 e2e 环境**(沿用 M4-2 runbook):干净 `T3CODE_HOME=~/.t3-feishu-m4-3` 的 serve(`node apps/server/src/bin.ts serve --base-dir <HOME> --port 3773`,自带 web dist;web 改了要 `pnpm --filter @t3tools/web build` 重新构建;**server 还需能读 FEISHU_APP_ID/SECRET**——启动前 `export` 或 `set -a; . apps/feishu-bot/.env; set +a`)+ bot(同 M4-2:`set -a; . apps/feishu-bot/.env; set +a` 取 APP_ID/SECRET;新 pairing token `node apps/server/src/bin.ts auth pairing create --base-dir <HOME>`;`T3_PAIRING_TOKEN=<token> T3_HTTP_BASE_URL=http://127.0.0.1:3773 T3_MODEL=opus T3_WORKSPACE_ROOT=<ws> T3_STATE_DIR=<bot-state> FEISHU_OWNER_OPEN_IDS=<可设空或非你> node apps/feishu-bot/src/main.ts`)。serve headless 会打印 web pairing URL(`http://127.0.0.1:3773/pair#token=...`)供浏览器认证;给 bot 单独再建一个 pairing token。**收口后须 kill server+bot 清理。**

## 起步:M4-3 第一动作
**先派 Explore sub-agent**(同一条消息扇出,复核本 kickoff 的接线):(a) server OAuth 路由+门控;(b) server 引飞书 SDK+读密钥+accessToken.create 签名;(c) 白名单写入(server-write vs web-write);(d) web 入口+回调路由+刷新。**产出 OAuth 端到端方案 + state/CSRF 方案 + 端点门控方案 + server-write/web-write 定夺 + 飞书后台前置清单 + 拆 PR,先对 OAuth 安全方案独立对抗审查,再与我确认范围(尤其:同 app vs 专用 app、redirect_uri 域名、写白名单路径)后动手。** 不要直接开写。

---

> 提示:这份提示词配合 memory(`feishu-bridge-m4-2-impl-facts`、`feishu-bridge-m4-impl-facts`、`feishu-bridge-m2b-impl-facts`、`feishu-bridge-goal`、`feishu-bridge-kickoff-review-rule`、`feishu-bridge-approval-timeout-deadcard-bug`)+ 设计文档 `feishu-bridge-design.md` 使用,共同构成完整施工上下文。
