# 飞书 Bridge M-3 PR-C4「绑定区显示改进 — bot 名字/头像 + owner 名字」kickoff

> 本文**自包含**,承 `docs/integrations/feishu-bridge-m3-pr-c3-density-kickoff.md`(density 已合入 #28)、设计定稿 `docs/integrations/feishu-settings-page-design.md`(绑定区改进)、memory `feishu-bridge-binding-display-facts`(四层可得性调查)。file:line 快照 **2026-07-06,main = `c0cb6e0d`(M-3 PR-C3 density 已合入,#28)**。全部锚点已由 2 路 Explore 对当前 main 逐条核实(binding-display-facts 原锚 `caf32408`,C1/C2/C3 大改 `FeishuSettings.tsx`+行漂移已重核),动手前仍复核。
>
> ⚠️ **命名去歧义**:`M3a`/`M3b`(无连字符)= 老「群聊+话题路由」,已交付;`M-3`(带连字符)= per-chat config。本文 = M-3 **PR-C4**(绑定区显示改进,承 PR-C3;C 系列收官)。
>
> ⚠️ **设计定稿是约束**:绑定区通栏显示 **bot 头像+名字(非裸 appId)+ 授权人名字+头像(非裸 ou)**——以 `feishu-settings-page-design.md`「绑定区改进」+ memory `feishu-bridge-binding-display-facts` 为准。
>
> 🔴 **范围收敛(可得性四层,BLOCKER 前置)**:memory 四层可得性调查已被 2 路 Explore 对当前 main 复核确认——**(a) bot 名字=白得被白扔 / (b) bot 头像=一次无 scope 调用 / (c) owner 名字=走群名录 best-effort / (d) owner 头像+无条件 owner 名字=需 `contact:user.base:readonly` scope + 重绑 + 加宽视图**。**本 PR = 白得三项(a/b/c),(d) owner 头像 descope**(需改 provision scope + 现有绑定必须重扫码,是 opt-in 重活,gate=先问用户,见 §4/§7)。

---

## 0. 硬前置(先核对,否则停)
- `git log --oneline -3` 应见 `c0cb6e0d …M-3 PR-C3 density…(#28)` / `48fddefe …PR-C2…(#27)` / `a275fbfc …死按钮…(#26)`。
- 从 main(`c0cb6e0d`)新开分支(建议 `feat/feishu-m3-pr-c4-binding-area`);**提交/推送只在用户明确要求时,开 PR 前确认**。
- 范围红线继续有效:**不改 provision scope / 不加 contact scope / 不碰重绑流程**(owner 头像 descope);**不动 appSecret / secret 通道 / callbackAuth / authz 决策层**;**不动 `feishuGetBotCredentials`**(secret 通道,与展示无关)。
- 本 PR **跨 contract + bot + server + web 四层**(数据管道 PR)。四层都要 typecheck + `pnpm exec vp check <改动子目录>` + 单测。

## 1. 先读
- memory `MEMORY.md` → 尤其:
  - `feishu-bridge-binding-display-facts`(**本 PR 的调查地基**:四层可得性 a/b/c/d + ⚠ 文档谎报 contact scope 已配=假,`binding.ts:89` 才是真相;行号旧锚 `caf32408`,按 §2 重核);
  - `feishu-bridge-m3-pr-c3-impl-facts`(**PR-C3 已交付**:承载通道语义、e2e home `.t3-feishu-m0`、server-managed bot);
  - `feishu-bridge-m3-pr-c2-impl-facts`(web 抽屉/`FeishuBindingSection` 结构;C4 只改绑定 section,不碰群 section);
  - `feishu-settings-page-design-decisions`(绑定区改进 = 通栏 bot 头像+名字 + 授权人名字+头像);
  - `t3-web-settings-editor-hydration-pitfall`(若绑定区新增可编辑态才涉及;本 PR 纯显示,读实时 `usePrimarySettings`/query 即可);
  - `feishu-bridge-e2e-pairing-token`(e2e:server-managed 自动托管 bot / 浏览器走 3773 / 测未合入 web 先 rebuild dist / 测未合入 bot 源码 dev serve 直接跑源码免 rebuild);
  - `review-fanout-prefer-workflow` + `feishu-bridge-kickoff-review-rule`(审查用 Workflow + 本文末必审自传播规则)。
- 设计定稿 `feishu-settings-page-design.md`(绑定区改进段)+ 高保真稿 `feishu-settings-mockup-v2.html`(绑定通栏形态)。
- `AGENTS.md`(权威 check/test/typecheck:`vp check` + `vp run typecheck`)。

## 2. 已交付地基(可复用 seam,file:line @ main `c0cb6e0d`,施工前复核)

### 2.1 承载通道 = chat-directory snapshot 管道(核心架构决策)
展示数据(bot 名字/头像/owner 名字)**必须由 bot 采集**(只有 bot 有活的飞书连接),经**已有的 `reportChats → server 存 → listChats` 管道**送到 web —— **不走 `feishuBinding` settings**(server 绑定流用另一个 SDK `@larksuiteoapi/node-sdk`、bind 时只有 openId、且是 secret-adjacent 广播;bot 也不写 settings),**不走 `feishuGetBotCredentials`**(secret 通道)。管道锚点:
- **契约**:`FeishuChatDirectorySnapshot`(`packages/contracts/src/feishu.ts:150-154`,`{chats, reportedAt?}`,`feishu.listChats` 返回体)+ `FeishuReportChatsInput`(`:157-160`,`{chats}`,bot→server)+ `FeishuChatMember`(`:117-121`,`{openId, name?}`,**无 avatar**)+ `FeishuChatDirectoryEntry`(`:124-144`,含 `members`/`ownerOpenId?`)。
- **bot 采集+上报**:`reportFeishuChatDirectory`(`apps/feishu-bot/src/chat-directory.ts:161-189`,RPC send 在 `:178` `EnvironmentRpc.request(WS_METHODS.feishuReportChats, { chats })`);`collectFeishuChatDirectory`/`buildEntry`(`chat-directory.ts:91-130`,members 从 `listChatMembers`);**触发点** = connect 后 fork **一次**(`apps/feishu-bot/src/bot.ts:715-725` `reportFeishuChatDirectory({source:gateway, registry, environmentId})`)。
- **⚠ fail-safe 的真实语义(审查订正,C4 承重)**:`collectFeishuChatDirectory` **只在 `listChats` 枚举失败时** fail;`reportFeishuChatDirectory` 的 `catchCause`(`:183`)**只在失败时**跳过。**一次成功但为空的枚举 `{chats:[]}` 今天照常上报**(无 `entries.length` 守卫,`:161-189` 复核)——真实不变式是「**失败→跳过**」,不是「空→不发」。**这对 C4 是承重的**:飞书 `listChats`=`im.v1.chat.list` 只列群聊(p2p/全新绑定 → roster 天然为空但成功),而 botIdentity 就搭这趟 report,**空但成功的 report 是无群绑定拿到 bot 名字/头像的唯一载体**。→ 红线措辞必须精确(§5),施工**绝不能**加「空 roster 不发」守卫,否则 p2p-only/全新绑定的绑定区永远停在裸 appId。
- **server 存+读**:`ws.ts:1263-1275`(`feishuReportChats` → `feishuChatDirectory.save(input.chats)`,OperateScope)/ `ws.ts:1278-1281`(`feishuListChats` → `read`,ReadScope);store `apps/server/src/feishu/FeishuChatDirectory.ts:102-168`(原子 JSON 文件 `feishu-chat-directory.json`,**独立于 settings.json**,boot-tolerant)。
- **web 读**:client atom `feishuListChats`(`packages/client-runtime/src/state/server.ts:254-256`),现只在 `FeishuChatConfigSection` 用(`apps/web/src/components/settings/FeishuSettings.tsx:271`)。
- **备选架构(设计文档提过,未采用)**:`feishu-settings-page-design.md` 曾建议「扩 `getFeishuBotCredentials` 或新增 profile RPC」拿 bot 身份。**本 PR 选 snapshot 管道**因:① `feishuGetBotCredentials` 是 secret 通道(红线不碰);② 管道已存在(bot→server→web 三层齐备),零新 RPC。**代价**:botIdentity 搭 connect 时的一次性 report(过期窗 → §3.1 `appId` gate 兜底)。**若未来嫌一次性 report 的过期窗**,可另开 profile RPC(web 现拉 → 无过期窗,但多一条 RPC + 需想清 secret 边界)——本 PR 不做。

### 2.2 bot 侧数据可得性(四层,Explore 复核)
- **(a) bot 名字 = 白得被白扔**:SDK `@larksuite/channel@0.2.0` 每次 `connect()` 调 `GET /open-apis/bot/v3/info`(mandatory,tenant token,无 scope)拿 `bot.app_name` 放进公有属性 **`channel.botIdentity`**(type `{openId, userId?, name}`,**无 avatar**)。t3code **零读取**(`grep '\.botIdentity'` 全仓 0 命中);`LarkGateway`(`apps/feishu-bot/src/lark/index.ts:72-198`)+ `channel.ts:525-537` 都没暴露它。→ 只需在 gateway 暴露 `channel.botIdentity` + report 时透传。
- **(b) bot 头像 = 一次无 scope 调用**:`bot/v3/info` 原始体含 `avatar_url`,SDK 抽取时丢弃(`BotIdentity` type 无该字段)。自己 `channel.rawClient.request({url:"/open-apis/bot/v3/info", method:"GET"})` 取原始体 `r.bot.avatar_url`,**无需 scope**(rawClient 逃生舱已是 t3code 惯例,`lark/channel.ts:404,423`)。
- **(c) owner 名字 = 走群名录(免费,best-effort)**:`members[].name` 已在 report(`listChatMembers` `lark/channel.ts:458-514`,name 抽取 `:491-494`;`im:chat:readonly` 已覆盖)。owner openId 来自 `FeishuChatDirectoryEntry.ownerOpenId`(群主)**或** binding owner(`ownerRef`)。⚠ **binding owner 未必在任何群名录**(他是扫码授权人,不一定是 bot 所在群成员/群主)→ 反查不到就回退裸 openId(never crash/mislead)。
- **(d) owner 头像 + 无条件 owner 名字 = descope**:`getUser`(`contact/v3/users/:id`,`lark/channel.ts:405-418`)存在但视图(`RawContactClient` `channel.ts:90-99`)strip 掉 avatar 只留 name;且 provision scope **不含** `contact:user.base:readonly`(`apps/server/src/feishu/binding.ts:89` 只有 `im:message.send_as_bot`/`im:message.group_msg`/`im:chat:readonly`)→ 现在 `getUser` 403 回退 openId(`bridge/cardAction.ts:206-212` `resolveOperatorName`)。**要做需:①`binding.ts:89` 加 scope(provision 时固化 → 现有绑定必须重扫码);②加宽 `RawContactClient` 视图读 avatar。→ §4 descope。**

### 2.3 web 绑定 section(要改的落点)
- `FeishuBindingSection`(`apps/web/src/components/settings/FeishuSettings.tsx:95-181`):读 `usePrimarySettings((s) => s.feishuBinding)`(`:96`,走 settings atom 非 RPC);绑定态 `<dl>` 三行 `:121-140`(App ID `:122-127` / 部署 `:128-133` / 授权人 `ownerOpenId` 裸 `:134-139`);解绑 `:143-150`。
- **契约 `ServerSettings.feishuBinding`**(`packages/contracts/src/settings.ts:473-479`,`{appId, tenant, ownerOpenId}` optional,Patch 镜像 `:616-622`)—— **只承载三裸字段,展示元数据不放这里**(§2.1)。绑定区继续用它拿 `appId`/`tenant`/`ownerOpenId`(裸兜底 + 复制),但 name/avatar 从 `listChats` snapshot 取。
- **web 无通用 Avatar 组件**(`apps/web/src/components/ui/` 下无 `avatar*`;仓内 `Avatar` 仅 Clerk 专用不可复用)→ **需新建** `ui/avatar.tsx`(`<img>` + 首字母 fallback + onError 回退)。
- **owner 名字反查范式已有**:`EffectivePreviewCard`(`FeishuSettings.tsx:770` 附近)已用 `members.find(m => m.openId === openId)?.name ?? openId`——绑定区可照此在 `data.chats[].members` 扫 `binding.ownerOpenId`。

## 3. PR-C4 范围(白得三项 a/b/c)

### 3.1 契约:snapshot/report 加 bot 身份 + owner 名字
- `FeishuChatDirectorySnapshot`(`feishu.ts:150-154`)+ `FeishuReportChatsInput`(`:157-160`)**加 `botIdentity`**(bot 送 + server 存 + web 读同构):
  - `botIdentity: Schema.optionalKey(Schema.Struct({ appId: TrimmedNonEmptyString, name: TrimmedString, avatarUrl: Schema.optionalKey(TrimmedNonEmptyString) }))`(optionalKey=首次 report 前/旧 snapshot 无该字段,向后兼容)。
  - **`appId` 是抗过期关联键(审查订正)**:snapshot 每 connect 才刷一次;re-bind(解绑 A→绑 B)到下一次 report 之间,`feishu-chat-directory.json` 仍存旧 app 的 botIdentity 而 `feishuBinding.appId` 已是新 app → web 必须 gate `botIdentity.appId === binding.appId`,不匹配就回退裸 appId(§3.4),否则绑定区显示 A 的名字/头像配 B 的 appId(误导)。
  - **不加 `ownerName` 契约字段(审查订正)**:owner 名字改 **web 侧反查**(拿**当前** `binding.ownerOpenId` 在 snapshot `chats[].members` 里查名字),天然免疫 re-bind 过期(总用当前 owner);bot 侧 resolve 会把旧 owner 名字腌进 snapshot,同 botIdentity 一样有过期窗。故 owner 名字**零契约改动**,只在 web 做(§3.4)。
- **`FeishuChatMember` 不加 `avatarUrl?`**:owner 头像走 contact scope 已 descope(§2.2d),members 头像无免 scope 源;owner 名字反查用现有 `members[].name` 足够。
- 加 optional 字段向后兼容(旧 `feishu-chat-directory.json` decode 不炸);加 decode 测试(snapshot round-trip with/without botIdentity + `appId` gate 纯函数)。

### 3.2 bot:采集 bot 身份(含 appId),经 report 透传(owner 名字不在 bot 侧做)
- **gateway 暴露 bot 身份**:`LarkGateway`(`lark/index.ts`)加 `getBotIdentity(): Effect<{appId, name, avatarUrl?}>` —— `appId` 取当前绑定 app 的 id(gateway 已持有)+ 读 `channel.botIdentity.name`(白得)+ `channel.rawClient.request('/open-apis/bot/v3/info')` 取 `avatar_url`(一次无 scope)。fail-safe:取不到 avatar 就只给 appId+name;取不到整体就返回 undefined(绝不阻断 report)。
- **report 带上 bot 身份**:`reportFeishuChatDirectory`(`chat-directory.ts:161-189`)采集 `botIdentity`;RPC payload(`:178`)从 `{chats}` → `{chats, botIdentity?}`。**不采集 ownerName**(owner 名字 web 侧反查,§3.1/§3.4)→ `bot.ts:720` 调用点**无需**加 `ownerOpenId` dep。**capRoster 只 cap 成员条目,botIdentity 不受影响。**
- **fail-safe 红线不破**:**只有 roster 枚举/RPC 失败才跳过 report**(§2.1;成功但空的 `{chats:[]}` 照发——它是无群/p2p 绑定拿到 botIdentity 的唯一载体);botIdentity 采集失败 → report 仍发(chats + 无 botIdentity),不因展示项失败而丢 roster;**绝不加「空 chats 不发」守卫**。

### 3.3 server:存+读透传新字段
- **⚠ store 是 typed schema,非 pass-through(审查订正)**:`FeishuChatDirectory.ts` 有显式 `PersistedFeishuChatDirectory` schema(~`:43-47`,施工前复核行号),save/read 都按它 decode/encode —— **不是「存啥返啥」的裸 JSON**。故加 `botIdentity` 要**三处同步扩**:① `PersistedFeishuChatDirectory` schema(`:43-54`,复核确认字段=`version:Schema.Literal(1)` + `chats` + `reportedAt`)加 `botIdentity?`(optionalKey);② `save` 签名从 `save(chats)` → 存整 snapshot(`{chats, botIdentity?}`),`ws.ts:1263` `feishuReportChats` handler 把 `input.botIdentity` 一并存;③ `read`(`:135-168`)+ `feishuListChats`(`ws.ts:1278-1281`)把 `botIdentity` 一并返回。**`version` literal 保持 `1` 不 bump**——optionalKey 新字段对旧文件天然向后兼容(旧 `feishu-chat-directory.json` 无 `botIdentity` 照常 decode),无需迁移。`reportedAt` 戳保留;scope(Operate/Read)零改动。

### 3.4 web:Avatar 组件 + 绑定区渲染
- **新建 `apps/web/src/components/ui/avatar.tsx`**:`<img src={avatarUrl}>` + 首字母 fallback(从 name/id 取)+ `onError` 回退首字母 + size prop。theme-aware(用设计 token,别硬编色)。
- **`FeishuBindingSection` 订阅 `feishuListChats`**(与群 section 同 query,`useEnvironmentQuery` 按 key 去重;或提升到 `FeishuSettingsPanel` 传下,二选一见 §7):
  - **bot 行**:App ID 那行(`:122-127`)→ bot 头像(`snapshot.botIdentity.avatarUrl`,无则首字母)+ bot 名字(`snapshot.botIdentity.name`,无则回退 appId)。**过期 gate(§3.1)**:仅当 `snapshot.botIdentity.appId === binding.appId` 才显示 name/avatar,否则回退裸 appId(re-bind 后旧 snapshot 未刷时不误导)。appId 降为次要灰字/复制按钮(裸 id 保留可复制,见 §7)。
  - **授权人行**:ownerOpenId 那行(`:134-139`)→ **web 侧反查**当前 `binding.ownerOpenId` 在 `data.chats[].members` 的 name(照 `EffectivePreviewCard` 的 `members.find(...)?.name ?? openId` 范式,§2.3)+ 首字母头像(owner 头像 descope)。**用当前 binding 的 ownerOpenId 反查 → 免疫 re-bind 过期**;查不到名字回退裸 openId(never mislead)。
  - 部署行(`:128-133`)不变。
- **所见=所判**:web 显示的 bot 名字 = bot 上报的 `botIdentity.name`(过 `appId` gate);owner 名字 = 当前 binding owner 在实时群名录里的 name,前端不另造。

## 4. 不在 C4 范围(明确后置,防误判遗漏)
- **owner 头像 + 无条件 owner 名字(可得性 d)· descope**:需 `contact:user.base:readonly` scope(`binding.ts:89` 加)+ **现有绑定必须重扫码**(provision 时固化 scope)+ 加宽 `RawContactClient`/`getUser` 视图读 avatar(`channel.ts:90-99,405-418`)。**gate=先问用户**(见 §7):是不是愿意为「授权人真头像/无条件名字」引入一次全员重绑?要么单列 follow-up(推荐),要么纳入本 PR(范围扩大 + 重绑成本)。owner 头像**无任何免 scope 路径**(chatMembers 不返回 avatar)。
- **群成员头像**:同 d(members 无免 scope avatar 源),不做。
- **绑定区可编辑化 / 改绑向导 / bot 状态(在线/离线)灯**:纯显示外的交互,后置。
- **toolPolicy 编辑器(PR-B)**:暂缓,不做。
- **契约 `feishuBinding` 加展示字段**:**明确不做**(§2.1 架构决策——展示走 snapshot 管道,不污染 secret-adjacent 的 settings 广播)。

## 5. 红线(不可弱化)
- **承载通道**:展示数据走 `reportChats/listChats` snapshot 管道;**不塞 `feishuBinding` settings、不塞 `feishuGetBotCredentials`**(secret 通道)。
- **fail-safe 语义精确(§2.1,不可弱化)**:`reportFeishuChatDirectory` **只在 roster 枚举/RPC 失败时跳过**;**成功但空的 `{chats:[]}` 照常上报**(它是无群/p2p 绑定拿到 botIdentity 的唯一载体)——**绝不能加「空 chats 不发」守卫**;botIdentity 采集失败 → report 照发 chats(展示项失败不拖垮 roster)。
- **过期防护(§3.1)**:botIdentity 带 `appId` 关联键,web 显示前 gate `botIdentity.appId === binding.appId`,不匹配回退裸 appId;owner 名字 web 侧反查**当前** binding owner(不把名字腌进 snapshot)——re-bind 后绝不显示旧 app 身份。
- **无新 scope / 无重绑**:owner 头像 descope;provision scope(`binding.ts:89`)零改动;不碰重扫码流程。
- **secret 零触碰**:appSecret / ServerSecretStore / `feishuGetBotCredentials` / callbackAuth / authz 决策层 zero change(展示纯读)。
- **best-effort 不误导**:owner 名字反查不到 → 回退裸 openId(明确显示 id,不假造名字);bot 名字取不到 → 回退 appId。
- **向后兼容**:snapshot 新字段全 optional;旧 `feishu-chat-directory.json` decode 不炸;web 无 botIdentity 时回退裸 id(不空白/不崩)。
- **所见=所判**:web 显示值 = bot 上报值,前端不另造 name。
- **设计定稿是约束**:绑定区通栏 bot 头像+名字 / 授权人名字(头像 descope)——不擅改。

## 6. e2e runbook(真连接)
- **可复用环境**:home `/Users/lizhipeng/.t3-feishu-m0`(已 binding + `im:chat:readonly` + web 登录态)。**server-managed 自动托管 bot**;起服务命令见 memory `feishu-bridge-e2e-pairing-token`(ws 目录 `.t3-feishu-m0-ws` git init 作 server cwd;浏览器现签 token 走 3773)。
- **⚠ 本 PR 跨四层**:改 web 必 `cd apps/web && pnpm exec vp build` rebuild dist;改 **bot/server/contract** 源码 dev serve 直接跑源码免 rebuild(`chooseBotEntry !packed → 源码`);改 contract 需确认 web rebuild dist(bot/server 跑 TS 源码)。
- **验证点**:
  - **管道/回路**:bot connect 后 report → 读 `feishu-chat-directory.json` 实锤含 `botIdentity{appId,name,avatarUrl?}`(**无 ownerName 字段** —— owner 名字 web 侧反查);`feishuListChats` 返回同值。
  - **web 绑定区**:硬刷新后绑定区显示 **bot 头像+名字**(非裸 appId)+ **授权人名字**(owner 在群时,非裸 ou);owner 不在任何群 → 回退裸 openId(不崩不空)。
  - **无群/p2p-only 绑定(§2.1 承重点)**:绑定无任何群(或只有 p2p)→ report `{chats:[]}` 仍带 botIdentity → `feishu-chat-directory.json` 实锤 `chats:[]` + 有 `botIdentity` → 绑定区照样显示 bot 头像+名字(**不停在裸 appId**)。验「空但成功的 report 承载 botIdentity」。
  - **re-bind 不显示过期身份(§3.1 appId gate)**:解绑 A → 绑 B,B 首次 report 落地前,绑定区显示 B 的 appId + **回退裸 appId**(而非 A 的名字/头像);B report 后刷新为 B 的名字/头像。
  - **fail-safe**:临时让 bot/v3/info 失败(或断网瞬间)→ roster 仍上报、绑定区回退裸 id,不空白不崩。
  - **所见=所判**:web 显示的 bot 名字 = `feishu-chat-directory.json` 的 `botIdentity.name` = 飞书后台 app 名。
  - **(owner 头像 descope,无 owner 头像验证点。)**
- **收口**:kill server(finalizer 级联 bot child);home 保留;`feishu-chat-directory.json` 可留(下次 report 覆盖)。

## 7. 待确认(实现中定或问用户)
- **owner 头像 = 已建议单列 follow-up**:本 PR 只做白得三项;owner 真头像 + 无条件 owner 名字等愿意接受「全员重扫码换 contact scope」时单开小 PR。gate:①是否值得为头像引入重绑;②届时加宽 `getUser` 视图 + `binding.ts:89` scope。**先问用户**。
- **owner 名字 = 已定 web 侧反查**(§3.1/§3.4 审查订正:免疫 re-bind 过期 + 零契约改动)——不再走 bot 侧 `snapshot.ownerName`。
- **listChats query 提升 vs 各自订阅**:绑定 section 与群 section 都要 `feishuListChats` → 提升到 `FeishuSettingsPanel` 传下(一份)vs 各自 `useEnvironmentQuery`(按 key 去重)。实现中定。
- **appId/ownerOpenId 裸 id 去留**:名字化后裸 id 是否保留(次要灰字 / 复制按钮 / tooltip)——建议**保留可复制**(调试/审计用),primary 显名字。
- **`avatar_url` 是飞书 API 假设,需实测**:`bot/v3/info` 返回体**假定**含 `avatar_url`(SDK 抽取时丢弃 → 现无实证字段名/存在性);动手第一步用 `rawClient` 打一次真接口 dump 原始体确认字段名与存在性,**缺失就直接降级首字母**(不阻断)。加载态:该 URL 是否公网可直接 `<img>` 加载(可能 CDN 公开但需实测;失败走 onError 首字母兜底)。
- **bot 名字空/占位**:`app_name` 理论恒有;为空则回退 appId。

## 8. 委派 / 闭环
- **Explore/Plan**(只读,file:line + 结论):动手前复核 §2 各 seam(尤其 `channel.botIdentity` 暴露路径 / rawClient bot/v3/info avatar / report 管道四层锚点 / `FeishuBindingSection` 当前行号 / provision scope / getUser 视图)。
- **Test**:contract/bot/server/web typecheck、`pnpm exec vp check <改动子目录>`、单测(snapshot decode with/without botIdentity / owner 名字反查纯函数 / Avatar fallback)。**本 PR 四层 typecheck**。
- **Review**:多维 + 对抗(**用 Workflow**,见 `review-fanout-prefer-workflow`;维度见下必审规则)。routing:审查用 opus-4.8/fable-5 + gpt-5.5(cc-codex 独立家族,**用 codex 前先 load cc-codex skill**)。

## 【kickoff 必审 · 自传播规则】
本设计文档交付前**必须**多维对抗审查(**优先 Workflow**,`review-fanout-prefer-workflow`):① **代码事实**——file:line 逐条对真实 main(`c0cb6e0d`)核验(尤其:`channel.botIdentity` 暴露位置 + t3code 零读取 / `bot/v3/info` avatar_url / report 管道 `chat-directory.ts:161-189`+触发 `bot.ts:715-725`+契约 `feishu.ts:150-160`+server `ws.ts:1263-1281`+store `FeishuChatDirectory.ts:102-168` / `FeishuBindingSection@FeishuSettings.tsx:95-181`(dl `:121-140`)/ `feishuBinding@settings.ts:473-479` / provision scope `binding.ts:89` 确无 contact / `getUser@channel.ts:405-418` 视图 strip avatar / web 无 Avatar 组件);② **范围完整**——对照设计定稿绑定区改进 + 可得性四层无遗漏无误分类:**bot 名字(a)/ bot 头像(b)/ owner 名字走群名录(c)/ 契约 snapshot 扩字段 / bot 采集+report 透传 / server 存读 / web Avatar+绑定区渲染** 都落到范围;**owner 头像+无条件 owner 名字(d)因需 contact scope+重绑 descope(§4/§7 gate 先问用户,非静默丢弃)/ 群成员头像 / 绑定区可编辑化 / toolPolicy(PR-B)/ feishuBinding 加展示字段(明确不做)** 均已显式标后置;承载通道走 snapshot 管道非 feishuBinding/secret / fail-safe 不破 / 无新 scope 无重绑 / secret 零触碰 / best-effort 不误导 / 向后兼容 / 所见=所判 红线已点明;③ **自包含**——memory/文档引用真实(binding-display-facts / 设计定稿 / PR-C3·C2 施工事实 / pairing token)、runbook 可执行(web 改先 rebuild dist、bot/server/contract 源码 dev serve 免 rebuild)、红线齐全、待确认项已在 §7 点明。修掉阻断项再交付,并把**本规则原样写进**衍生的下一里程碑 kickoff。
