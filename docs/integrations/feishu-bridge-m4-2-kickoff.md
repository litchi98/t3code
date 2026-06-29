# 飞书 Bridge M4-2 实现会话 — 启动提示词

> 把下面 `---` 之间的内容粘贴到新会话作为首条消息(或 `@` 引用本文件 + 一句「推进 M4-2」)。它自包含,不依赖任何历史会话上下文(依赖 memory 与本仓库的设计/审查文档)。

---

你是「飞书(Lark)接入 t3code」特性的**实现协调者(orchestrator)**,现在推进 **M4-2 里程碑(web settings 飞书栏目 + 审批白名单 server 持久化 + bot live-refresh)**。你的职责是推进实现、把控质量,而**不是亲自写所有代码**。核心纪律:**默认委派,保持你自己的主上下文窗口干净。**

M0(headless 最小回路)、M1(单聊 MVP)、M2a/M2b-1〜4(approval/user-input 跨端 + HMAC + 卡片 v2/v3)、M3a(群聊 + 话题路由)、M3b(群聊降噪 + 话题内审批卡)、**M4-1(后端 authz 解耦 + 多审批人 env 白名单,根治 owner 死锁,PR #10 squash `dd76c153`)** 均已合入 main。M4-2 把 M4-1 的「bot 端 env 白名单」升级为「**web 配置 + server 持久化 + bot 实时读取**」,落地用户 2026-06-26 愿景的配置 UI 部分。**M4-2 是 M4 系列首个深度 touch web + server + contracts 多端的里程碑——但不碰 callbackAuth / authz 判定红线**(M4-1 已彻底解耦 authz,M4-2 只换 allowlist 的**数据来源**:env → env∪store)。

## M4-2 一句话目标
把审批白名单从「bot 端 env `FEISHU_OWNER_OPEN_IDS`」升级为「**web settings 飞书栏目配置 → server 持久化(ServerSettings)→ bot 经 RPC 读取(env∪store 并集,live-refresh 免重启)**」。env 降级为逃生口/默认地板。

## ⚠️ 动手前必须澄清的关键事实(否则会做错/碰红线)
- **【前置 · 已满足】M4-1 已合入 main(commit `dd76c153`,2026-06-29)**:authz 已解耦 —— M4-1 新增 `effectiveAllowlistFor(runtimeMode)`(bot.ts:524-525,`runtimeMode==="approval-required" ? ownerOpenIds : []`,其中 `ownerOpenIds = config.feishu.ownerOpenIds` @bot.ts:516)产出 allowlist,cardAction 处理器(bot.ts:2538 起内联分支)的 authz 判定(:2715-2724)`effectiveAllowlist.length>0 ? includes(clicker) : clicker.length>0 && clicker===res.payload.o`,早返前置于 nonce consume。**M4-2 唯一要改的是 `ownerOpenIds` 的数据源(env → env∪store),authz 判定逻辑 / callbackAuth verify 四项(r/s/c/fp,M4-1 已移除 o 比对→authz 解耦)/ HMAC / nonce / policyFingerprint 一律不动。**(若你读到此时 `main` 顶端非 M4-1 `dd76c153`,说明仓库状态有变,核对后再开分支。)
- **bridge 是薄客户端,白名单是 server 端共享配置**:web 配、server 存、bot 读。**不在 bot 加新配置入口**(env `FEISHU_OWNER_OPEN_IDS` 保留为逃生口/默认地板)。server 是权威存储。
- **复用现成 settings 持久化管道(别新建)**:web 写设置走 `useUpdatePrimarySettings`(apps/web/src/hooks/useSettings.ts)→ `WsServerUpdateSettingsRpc`(`WS_METHODS.serverUpdateSettings`,packages/contracts/src/rpc.ts)→ ws.ts handler(apps/server/src/ws.ts,约 :1219)→ `serverSettings.ts` 原子写 `stateDir/settings.json`。ServerSettings schema 在 `packages/contracts/src/settings.ts`(约 :366-412 ServerSettings / :504-533 ServerSettingsPatch)。**加白名单字段 = 扩 ServerSettings + ServerSettingsPatch 两处**(用 `withDecodingDefault` 空数组缺省,保证老 server/老配置向后兼容)。**注意 contracts 是 schema-only 包(AGENTS.md),不放运行时逻辑。**
- **bot 读白名单复用 `WsServerGetConfigRpc`**:`ServerConfig`(packages/contracts/src/server.ts,约 :409-421)已含 `settings: ServerSettings`。bot 现在 serverGetConfig **仅启动读一次**(apps/feishu-bot/src/bot.ts,约 :246)。**M4-2 必须加 live-refresh**(订阅 settings-changed 广播 或 周期 re-read serverGetConfig),否则 web 改了白名单 bot 不重启不生效。`serverSettings.ts` 有 `streamChanges`/PubSub(变更已在 server 侧广播,Explore 查 bot 能否经现有 RPC 订阅)。
- **【fail-safe 红线 · M4-1 审查钉死,不可弱化】**:`effectiveAllowlist = env ∪ ServerSettings.feishuApprovalAllowlist`。**store 读失败 / 字段缺失 ⇒ 退回 env-only(env 也空则 initiator-only),绝不 fallback 成全放行;并集只增不减,env 是不可移除地板;bot union 前对 store 列表做 `trim + filter(len>0)`(纵深防御,与 env 解析同款,防手改 settings.json 塞空串)。** live-refresh 刷新失败保留 last-known-good(绝不因刷新失败清空白名单致越权或死锁)。
- **不破 M4-1 authz 不变式**:`effectiveAllowlistFor` 的 runtimeMode 门控(approval-required→allowlist,否则 `[]` → full-access/p2p 落 `clicker===payload.o`)、authz 早返前置 nonce consume、旁观者保护 `preserveCardForBystander`、M18 allowlist-aware 一律保持。M4-2 只换「ownerOpenIds 这份数据从哪来」。

## 第一步(必做,按序)
1. 读 memory(`MEMORY.md` 索引 + 这几条):
   - `feishu-bridge-m4-impl-facts.md` — **M4-1 authz 解耦全接线(effectiveAllowlistFor / authz 判定 / 旁观者迁移 / M18 allowlist-aware)+ fail-safe / live-refresh 钉死待办(本里程碑要落地)+ 单账号 e2e 验法**。
   - `feishu-bridge-m2b-impl-facts.md` — **cardAction HMAC(callbackAuth verify 四项 r/s/c/fp〔M4-1 已移除 o 比对〕 / nonce / policyFingerprint)** —— M4-2 不碰但须知边界。
   - `feishu-bridge-m3b-impl-facts.md` / `feishu-bridge-m3a-impl-facts.md` — 群聊 + 话题路由不变式(density / 话题投递 / anchorOf,M4-2 不碰但别误触)。
   - `feishu-bridge-goal.md` — 薄客户端原则 + §11E 补偿层。
2. 读项目规则 `AGENTS.md`(「重复=code smell,优先抽共享」「Performance/Reliability first」「contracts 包 schema-only,无运行时逻辑」「client-runtime 子路径 import」)。
3. 读设计文档(只读相关节)`docs/integrations/feishu-bridge-design.md`(authz / settings 相关)。
4. **派 Explore sub-agent(同一条消息扇出,只读,返回 file:line + 结论)**:
   - (a) **ServerSettings 加字段**:`packages/contracts/src/settings.ts` 的 `ServerSettings` + `ServerSettingsPatch` 结构、`withDecodingDefault` 用法、`redactServerSettingsForClient`(apps/server/src/serverSettings.ts:96-109 现仅 redact `providerInstances` → 新增 `feishuApprovalAllowlist` **默认透传即正确、绝不可 redact**,否则 web tab 读不到既有白名单无法增删);加 `feishuApprovalAllowlist: ReadonlyArray<string>` 的最小改动面 + 是否触发其它消费点。
   - (b) **web 飞书 tab**:`apps/web/src/components/settings/SettingsSidebarNav.tsx`(导航/类型,约 :25-44)、settings 路由约定(`apps/web/src/routes/settings.*.tsx`)、新建 `FeishuSettings.tsx`(增删 openId 列表 UI)、`useSettings.ts` 读写 hook(`useUpdatePrimarySettings` 约 :278)的改动面。
   - (c) **bot 读取 + live-refresh**:bot.ts `serverGetConfig` 调用点(约 :246,仅启动读一次)+ `effectiveAllowlistFor` 函数(bot.ts:524-525)及其数据源 `ownerOpenIds`(:516);live-refresh 的最小可靠实现(订阅 vs 周期 re-read),刷新失败 last-known-good 怎么落。
   - (d) **server settings-changed 推送通道**:`apps/server/src/serverSettings.ts` 的 `streamChanges`/PubSub + `packages/contracts` 有没有 settings 变更订阅 RPC(类似 `subscribeShell`)bot 能复用;没有则 bot 周期轮询 serverGetConfig 的代价。
   - 实现细节不确定一律派 sub-agent 查并返回结论,不要自己翻大文件。

## 上下文卫生(硬性约束)
- **不**把大文件、长 diff、大量搜索结果读进主上下文;需要时派 sub-agent 读并返回**摘要/结论**。
- 你的主上下文只保留:当前状态、决策、下一步。细节沉到 memory 与 sub-agent。
- 里程碑结束把进度/决策/踩坑写进 memory(新增/更新 `feishu-bridge-m4-2-impl-facts.md` + 更新 `MEMORY.md` + 更新 `feishu-bridge-m4-impl-facts` 下一步指针)。
- **【kickoff 必审 · 自传播规则】收口时若写了下一会话的 kickoff(沿用「带下一里程碑 kickoff」约定,如 M4-3):必须用 workflow 多维对抗审查那份新 kickoff(维度至少:① 代码事实准确性——逐条对照真实 merged 代码的 file:line,② 范围完整性——对照 memory 残留/待办无遗漏无误分类,③ 自包含与引用正确——memory/文档路径真实存在、runbook 可执行、红线齐全),修掉确认项再交付。kickoff 里写错 file:line / 过时论断会误导下个会话。并把这条「kickoff 必审 · 自传播规则」原样写进你产出的新 kickoff。(本份 M4-2 kickoff 已按此审过。)**

## 委派决策(默认委派,自己做是例外)
| 工作类型 | 交给谁 |
|---|---|
| 调研 / ServerSettings 结构 / web settings / bot live-refresh / 定位代码 | **Explore** sub-agent(只读,返回 file:line + 结论) |
| 多文件实现 / 可并行改动 | **workflow** 或并行 sub-agent(互不重叠文件并行:contracts / server / web 可并行;**bot.ts 集成枢纽单 agent 串行**——M2b/M3a/M3b/M4-1 都踩过两 agent 同改一枢纽文件的坑),你只读结构化返回 |
| 跑 typecheck / lint / 测试 | sub-agent 执行,**只回结论**(`pnpm --filter @t3tools/feishu-bot run typecheck` + `pnpm exec vp check apps/feishu-bot`;**动 web 则 `apps/web` typecheck;动 contracts/server 则各自 typecheck**;失败先 `pnpm exec vp fmt <pkg>`) |
| 代码 review(**尤其 fail-safe / live-refresh / 不破 M4-1 authz**) | **workflow** 多维独立审查 + 对抗验证(对每条发现默认怀疑、查是否已处理再采纳);fail-safe(store 失败不全放行)+ live-refresh(刷新失败 last-known-good)必须单独深审 |
| ServerSettings schema 设计 / web UI 设计 / live-refresh 方案 / 拆 PR / 与用户确认 | **你自己** |
| 一两行明确改动 / 读单个小文件确认一个事实 / 对话 | 你自己(例外) |

并行的独立调研/实现放在**同一条消息**里扇出,别串行等待。

## 每个里程碑的闭环(不可跳步)
1. **Plan** — 先用 Explore 摸清 ServerSettings + web settings + bot live-refresh,**产出 schema 方案 + web UI 方案 + live-refresh 方案(fail-safe 怎么落)+ 拆 PR 与用户确认范围后再动手**。别直接开写。**fail-safe + live-refresh 方案务必先独立对抗审查**(可靠性红线区)。
2. **Implement** — workflow / sub-agent(contracts/server/web 互不重叠文件并行;bot.ts 集成枢纽单 agent 串行)。
3. **Test** — typecheck + `vp check` **必须全过**(feishu-bot + web + contracts + server,凡触及的包),失败回 Implement。
4. **Review** — workflow 多维独立审查 + 对抗验证,维度至少含:正确性 / **fail-safe(store 读失败/缺字段/空 ⇒ 退 env/initiator 绝不全放行)** / **live-refresh(刷新失败 last-known-good、不破 authz、不死锁)** / web↔server↔bot 配置一致 / **ServerSettings 向后兼容(老 server/老配置)** / **不破 M4-1 authz 不变式 + callbackAuth 红线零改动(grep 实证)** / 不破 M3a/M3b density·话题·路由。
5. **Fix** — 修 review 确认为真的问题,重跑 Test。
6. **Confirm** — 向用户简洁汇报。**真连接 e2e 必跑**:**web 配白名单实时生效**(web 加一个 openId → bot 不重启 → 该 openId 可批;web 移除 → 不能批;store 读失败/空 → 退 env/initiator 不全放行不死锁)。**M4-2 单账号即可验**(配置自己的 openId 进/出白名单 → 审批权限实时变化),不强依赖多账号。

## 项目硬约束(违反即未完成)
- **bridge 是薄共享客户端**:白名单 = server 端共享配置,web 配、server 存、bot 读;**不在 bot 加配置入口**(env `FEISHU_OWNER_OPEN_IDS` 降级为逃生口/默认地板,与 store 取并集)。
- **callbackAuth / authz 判定红线**:M4-1 已解耦,M4-2 **绝不动** callbackAuth verify 四项(r/s/c/fp,M4-1 已移除 o 比对)/ HMAC / nonce / policyFingerprint / `effectiveAllowlistFor` 的 runtimeMode 门控 / authz 早返前置 nonce consume / 旁观者保护。**只换 allowlist 数据源 env→env∪store。绝不加 wildcard 旁路、绝不弱化 fail-safe。**
- **fail-safe 红线**:store 读失败/缺字段/空 ⇒ 退 env-only / initiator-only,**绝不全放行**;并集只增不减,env 是地板;bot 读侧 trim+filter 空串;live-refresh 刷新失败保留 last-known-good。
- **ServerSettings 向后兼容**:新字段 `withDecodingDefault` 空数组,老 server 返回的 settings 缺字段 → 解出空数组(不报错、不全放行)。**contracts 包 schema-only,无运行时逻辑。**
- **不破坏 M2b/M3a/M3b/M4-1 既有不变式**:density 三档 + 话题投递(`topicAnchorMessageId`)+ M3a 路由(`anchorOf`/`compositeChatKey`)+ `renderThreadCard` 契约 + driveTurn/observe 两路径 + CardHandle 去重 + M4-1 authz 判定 + processGuard 一律不动。
- **健壮性**:任何 settings 读取/RPC/快照错误绝不崩 bot 进程;live-refresh 并发下行为可预测。
- 不 `import` `.repos/` 下 vendored 代码;写 Effect 代码先看 `.repos/effect-smol/LLMS.md`。client-runtime 只能子路径 import。重复逻辑抽共享。
- 提交/推送只在用户明确要求时做。**M4-2 从 main 新开分支 `feishu-bridge-m4-2`(先确认上方「前置」:M4-1 已合 main `dd76c153`)**,逐(子)里程碑 PR(commit → push origin → `gh pr create --repo litchi98/t3code --base main` → 用户确认后 squash 合并)。

## M4-2 范围(Plan 阶段与用户敲定确切边界)
核心:**web 配白名单 + server 持久化 + bot live-refresh**。候选清单(与用户拍板,**倾向拆多个 PR**:后端 contracts/server + bot 读取先行、web UI 次之):
- ① **ServerSettings 加 `feishuApprovalAllowlist`(后端 contracts/server)**:扩 ServerSettings + ServerSettingsPatch(withDecodingDefault 空数组),server 持久化复用现成管道。
- ② **bot 读 env∪store + live-refresh(fail-safe)**:`effectiveAllowlistFor` 数据源改 env∪store;live-refresh(订阅/周期);store 读失败/空 → 退 env/initiator;读侧 trim+filter。
- ③ **web 飞书 settings tab**:加「飞书」栏目,增删飞书 openId 白名单(复用 settings 持久化 hook)。
- ④ 可选:白名单变更审计 / web 上显示 openId 来源(env 逃生口 vs web 配置)/ 配合 `/whoami` 引导填 openId。(注:M4 候选④「审批卡回显由 @X 批准」M4-1 已天然支持——echoResolved 用点击者 `evt.operator.openId` 真名,N 选一下即显示哪个白名单成员批的,无需额外做。)

## 明确不在范围
- **M4-3 飞书 OAuth 登录**(web 飞书扫码登录自动拿 openId 写白名单,从零接 server `/auth/feishu/authorize`+`/callback`,体量最大,独立里程碑;写完 M4-2 若带 M4-3 kickoff 须按 kickoff 必审规则审)。
- **模型 extended-thinking reasoning 显示**(t3code 核心 gap,另立项;见 `feishu-bridge-m2-todos.md` 纠错条)。
- `compareActivitiesByOrder` 跨包去重(M2b-4 技术债,独立 PR)。
- M3b 暂缓的 D3 SECONDARY grace race / D4 planner✅闪现 polish(与 M4-2 无关)。

## 需要用户提供
**可验「web 配白名单实时生效」的 e2e 环境**(沿用 M4-1 runbook):干净 `T3CODE_HOME=~/.t3-feishu-m4` 的 `serve`(自带 web + 浏览器 + 飞书 bot;`<HOME>/userdata/settings.json` 写 `{"enableAssistantStreaming":true}`;web 改了要 `pnpm --filter @t3tools/web build` 重新构建)。bot 改代码需重启(`pkill -f 'src/main.ts'` → 新 pairing token `node apps/server/src/bin.ts auth pairing create`(同 `T3CODE_HOME`)→ 同 `T3_STATE_DIR` 重起,别用 dev;`T3_HTTP_BASE_URL=http://127.0.0.1:3773` + `T3_MODEL=opus` + `T3_WORKSPACE_ROOT=<scratch ws>`;config 不自动读 .env,启动 `set -a; . apps/feishu-bot/.env; set +a`)。**M4-2 单账号即可验**:web 上把自己 openId 加进/移出白名单 → bot 不重启 → 审批权限实时变化(对照 M4-1 的「改 env 须重启」)。**收口后须 kill server+bot 清理。**

## 起步:M4-2 第一动作
**先派 Explore sub-agent**(同一条消息扇出):(a) ServerSettings 加字段;(b) web 飞书 settings tab;(c) bot 读取 + live-refresh;(d) server settings-changed 推送通道。**产出 ServerSettings schema 方案 + web UI 方案 + bot live-refresh 方案(fail-safe 怎么落)+ 拆 PR,先对 fail-safe + live-refresh 方案独立对抗审查,再与我确认范围后动手。** 不要直接开写。

---

> 提示:这份提示词配合 memory(`feishu-bridge-m4-impl-facts`、`feishu-bridge-m3b-impl-facts`、`feishu-bridge-m3a-impl-facts`、`feishu-bridge-m2b-impl-facts`、`feishu-bridge-goal`、`feishu-bridge-kickoff-review-rule`)+ 设计文档 `feishu-bridge-design.md` 使用,共同构成完整施工上下文。
