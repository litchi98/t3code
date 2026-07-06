# 飞书 Bridge M-3 PR-C3「density 契约字段 + bot 迁读 + web 群密度控件」kickoff

> 本文**自包含**,承 `docs/integrations/feishu-bridge-m3-pr-c2-drawer-kickoff.md`(抽屉/基线/静息态已落)、设计定稿 `docs/integrations/feishu-settings-page-design.md`(§2 信息架构 + 决策 1/8)、`feishu-settings-mockup-v2.html`。file:line 快照 **2026-07-06,main = `48fddefe`(M-3 PR-C2 已合入,#27;死按钮 #26 亦已合入 `a275fbfc`)**。全部锚点已对当前 main 核实(PR-C2 大改 `FeishuSettings.tsx`,#26 改 bot.ts 行号漂移),动手前仍复核。
>
> ⚠️ **命名去歧义**:`M3a`/`M3b`(无连字符)= 老「群聊+话题路由 / density 三档 env」,已交付;`M-3`(带连字符)= per-chat config。本文 = M-3 **PR-C3**(density per-chat 契约字段 + web 群密度控件 + bot 迁读,承 PR-C2)。
>
> ⚠️ **设计定稿是硬约束**:密度控件形态(segmented「卡片|Markdown|纯文本」)——以 `feishu-settings-page-design.md` §2 + 决策 1 为准,不擅改。
>
> 🔴 **范围收敛(kickoff 审查 BLOCKER 已修正)**:原设想「density 维度 + 私聊 section 平铺(决策 8)」合体。**审查证实私聊 section 在架构上无法在本 PR 落地** —— bot `listChats`(`im.v1.chat.list`)**明确排除 p2p 私聊**(`apps/feishu-bot/src/lark/index.ts:150-151` doc:"Excludes p2p private chats"),而群名录唯一数据源就是它(`chat-directory.ts:124` `source.listChats`)→ web `data.chats` **永远不含 p2p 条目**(现有 `FeishuSettings.tsx:300` 的 `.filter(chatMode !== "p2p")` 是防御性空操作,从不真剔除)。故**私聊 section 需要一条当前不存在的 p2p 数据通道**(bot 上报见过的 p2p 会话 / 从 binding 解析 p2p chatId),**descope 到 follow-up**(见 §4/§7,gate=先问用户/先补数据源)。**本 PR = 纯 density 维度(群聊 + defaults),决策 8 的私聊 section 单列后续**。

---

## 0. 硬前置(先核对,否则停)
- `git log --oneline -4` 应见 `48fddefe …M-3 PR-C2…(#27)` / `a275fbfc …死按钮…(#26)` / `f9a24367 …PR-C1…(#25)` / `caf32408 …PR-A…(#24)`。
- 从**更新后的 main(`48fddefe`)** 新开分支(建议 `feat/feishu-m3-pr-c3-density`);**提交/推送只在用户明确要求时,开 PR 前确认**。
- 范围红线继续有效:**不做 toolPolicy 编辑器**(PR-B 暂缓);**不做绑定区**(PR-C4);**callbackAuth/authz 决策层零改动**。
- 本 PR **跨 contract + bot + web 三层**(与 C1/C2 纯 web 不同):契约加字段 → bot 消费迁读 → web 编辑器控件。三层都要 typecheck。

## 1. 先读
- memory `MEMORY.md` → 尤其:
  - `feishu-settings-page-design-decisions`(**设计定稿 + 决策 1(density 加契约字段)+ 决策 8(私聊只显密度、上移、平铺)+ 定稿四精修**;⚠该 memory 已记录本 PR 的 **BLOCKER 前置**:「density 迁读点不止占位卡」——旧行号已漂,按 §3.3 重核当前 main);
  - `feishu-bridge-m3-pr-c2-impl-facts`(**PR-C2 已交付**:抽屉/`effectiveConfig`/两 overlay/`EffectivePreviewCard`/p2p 被 filter 的位置;C3 在此之上**只扩 density 维度**,私聊 section 已 descope 见 §4);
  - `feishu-bridge-m3-pr-c1-impl-facts`(「限制」开关/两种空语义/`isChatConfigEmpty` 字段集——**C3 必须往 `isChatConfigEmpty` 加 `density===undefined`**);
  - `feishu-bridge-m3b-impl-facts`(density 三档语义:`card` 默认、`markdown`/`text` collapsible→单行摘要;`ChatBinding.density` bind-time 存;p2p 恒 `card`);
  - `t3-web-settings-editor-hydration-pitfall`(`useOptimisticSetting` 渲染实时值);
  - `feishu-bridge-e2e-pairing-token`(e2e:server-managed 自动托管 bot / 浏览器走 3773 / 测未合入 web 先 `cd apps/web && pnpm exec vp build` / 测未合入 **bot** 源码 dev serve 直接跑源码免 rebuild;⚠**server 托管 spawn scrub 了 `FEISHU_GROUP_CHAT_DENSITY`** → env 路已死,web 是 density 唯一控制面,这正是决策 1 的依据);
  - `review-fanout-prefer-workflow` + `feishu-bridge-kickoff-review-rule`(审查用 Workflow + 本文末必审自传播规则)。
- 设计定稿 `feishu-settings-page-design.md`(§2 群抽屉密度维度行;⚠§2 画的私聊 section ② 已 descope 见 §4——p2p 无数据源)+ 高保真稿 `feishu-settings-mockup-v2.html`(密度 segmented 形态)。
- `AGENTS.md`(权威 check/test/typecheck:`vp check` + `vp run typecheck`)。

## 2. 已交付地基(可复用 seam,file:line @ main `48fddefe`,施工前复核)
- **契约**:`FeishuChatConfig`(`packages/contracts/src/settings.ts:375-395`)——现有 approvalMode/approvers/workspaces/commands/toolPolicy,**每字段 `Schema.optional`**(字段级 fallback 由 bot 读时叠加);**无 density**。加 density 只在此 Struct 追加一字段,`applyServerSettingsPatch` 整值替换自动流过(无需改 patch 层,PR-C1 已证)。settings.test.ts(`:149+`)有 decode 测试,加 optional 字段向后兼容。
- **bot density 现状**:
  - `densityForRuntime(runtimeMode, groupChatDensity)`(`apps/feishu-bot/src/bridge/chatThreadMap.ts:110`)= p2p(full-access)恒 `card`;group(approval-required)取 `groupChatDensity`(env,server-managed 下被 scrub → 默认 `card`)。**纯函数**。
  - `RenderDensity` 类型定义在 **`apps/feishu-bot/src/bridge/eventRenderer.ts`**(bot-side,contract 不可 import)→ 契约 density 字段须**内联 3 literal** `["card","markdown","text"]`,与 `RenderDensity` 保 parity(加 set-parity 测试防漂移,仿 PR-C1 的 `FEISHU_COMMAND_REGISTRY` parity 测)。
  - `effectiveChatConfig(chatId, configs, defaults)`(`apps/feishu-bot/src/bridge/chatConfig.ts`)= 字段级 fallback,现无 density → 须加 `density` 到 `EffectiveChatConfig` 接口 + `pick("density")`。bot.ts 已持 `chatConfigsRef`/`chatDefaultsRef`(`:384/385`),`effectiveChatConfig` 已在 `bot.ts:780`(workspace authz)、`:1719`(approval gate)被调 → density 解析器可复用同一对 Ref。
  - `ChatBinding.density`(bind-time 存,`chatThreadMap.ts:306-311`;placeholder 读 `binding?.density`)= legacy 兜底层。
- **web 编辑器(PR-C2 后结构,C3 扩 density 的对象)**,`apps/web/src/components/settings/FeishuSettings.tsx`:
  - `FeishuChatConfigSection`——**群聊 section**;`chats.filter((chat) => chat.chatMode !== "p2p")` 是**空操作**(`listChats` 本就不返回 p2p,§4);持 `configs`/`commitChat` + `defaults`/`commitDefaults` 两 overlay(**密度控件复用此二者,不新起 overlay**,§5)。
  - `ChatConfigDrawer`(群抽屉,四维平铺)/ `DefaultsDrawer`(defaults 抽屉)/ `EffectivePreviewCard`(生效预览,**现无 density 行**,C3 加)。
  - 纯逻辑 `FeishuSettings.logic.ts`:`effectiveConfig`(**C3 加 density 字段**)、`isChatConfigEmpty`(**C3 加 `density===undefined`**,红线)、`SOURCE_LABELS`、`restingChatSummary`/`defaultsSummary`(可选:加 density 摘要)、`writeChatConfig`(drop-empty,不改逻辑但受 `isChatConfigEmpty` 影响)。
- **密度 segmented 控件**:用现成 `toggle-group.tsx` 或 `Select`(实现中定,§7);放在群抽屉/defaults 抽屉里作维度控件(与 `ModeSelect`/`CommandsEditor` 并列)。
- **数据回路(不改)**:整值替换 `applyServerSettingsPatch`(`packages/shared/src/serverSettings.ts`)+ `useUpdatePrimarySettings`。

## 3. PR-C3 范围

### 3.1 契约:`FeishuChatConfig.density`(决策 1)
- `settings.ts:375` 的 Struct 追加 `density: Schema.optional(Schema.Literals(["card","markdown","text"]))`(注释:absent → 字段级 fallback,group 默认 `card`)。
- **parity 测试**(防契约 literal ↔ bot `RenderDensity` 漂移):在 bot 侧加一测(仿 PR-C1 命令 parity),断言契约 density literal 集合 === `RenderDensity` 全集。位置:bot 能同时 import 两者处(如 `chatThreadMap.test.ts` 或新测)。
- `EffectiveChatConfig`(`chatConfig.ts`)加 `density: RenderDensity | undefined` + `pick("density")`(built-in 兜底放在 §3.3 的 `resolveDensity`,**不**在 `effectiveChatConfig` 里硬编 `card`——因为 built-in 依赖 runtimeMode,由 `densityForRuntime` 决定)。

### 3.2 web:群密度控件 + 预览 density 行(决策 1)
- **`isChatConfigEmpty` 加 `density===undefined`(红线,BLOCKER 级)**:否则「只设 density」的 per-chat entry 被 `writeChatConfig` drop-empty **误删**,density 永远存不进 `feishuChatConfigs`。加单测(density-only entry NOT empty)。
- **`effectiveConfig` 加 density 字段**:`perChat?.density ?? defaults.density ?? "card"`(web 端 group built-in = `card`,与 bot `densityForRuntime` group 默认一致)+ source 三态。built-in 常量 `"card"` 抽为共享常量(呼应 bot,防两端硬编分叉,§7)。
- **群抽屉密度维度**:`ChatConfigDrawer` 四维后加第五维「密度」控件(segmented「卡片 / Markdown / 纯文本」+「继承默认」态);写 per-chat density(经 `setConfigDensity` 新 setter,仿 `setConfigCommands`,undefined=继承)。**`DefaultsDrawer` 同加**(defaults 密度,无「继承」)。
- **`EffectivePreviewCard` 加 density 行**(PR-C2 明确挪来的一行):复用 `effectiveConfig.density` + source 徽标。
- **单一 overlay(红线,审查 finding)**:密度控件写入**复用 `FeishuChatConfigSection` 已持的 `configs`/`commitChat`(群)与 `defaults`/`commitDefaults`(默认)那一份 `useOptimisticSetting`**,**不新起第二个 overlay**——群/默认密度都在同一 section 组件内,天然共用。**⚠ 别把密度控件拆成独立 section/sibling 组件另起 `useOptimisticSetting(serverConfigs,…)`**:同一 `feishuChatConfigs` map 上两个乐观 overlay 会 last-writer-wins 相互覆盖(整值替换语义)。
- **私聊 section descope**(见范围收敛 note + §4/§7):决策 8 的私聊平铺**不在本 PR**——p2p 无数据源(`listChats` 排除 p2p),需先补 p2p 数据通道,单列 follow-up。

### 3.3 bot:per-chat density 迁读(决策 1 的承重件 + memory 记录的 BLOCKER)
- **根因(memory `feishu-settings-page-design-decisions` 审查 BLOCKER 复述,行号已按当前 main 重核)**:当前所有渲染点就地 `densityForRuntime(runtimeMode, groupChatDensity)` 或 `binding?.density ?? densityForRuntime(...)`,**不读 per-chat**。只迁部分 = per-chat density「闪一帧随即被覆盖」e2e 必失败。
- **修法**:抽 `resolveDensity(chatId, runtimeMode) = effectiveChatConfig(chatId, configs, defaults).density ?? binding?.density ?? densityForRuntime(runtimeMode, groupChatDensity)`(per-chat > binding > env-default,保 legacy 兜底)。统一**全部渲染读点**;`renderObservationToCard`(`bot.ts:1744`,签名无 density 参)**加 density 参**,其内 `:1848`(streaming)/`:1900`(final)改用传入值。
- **当前 main `48fddefe` 渲染读点清单(逐一改为 `resolveDensity`,施工前 grep `density: ` 重核不遗漏)**:
  - 审批卡 `:1522`(snapshotThread)
  - streaming `:1848` / final `:1900`(均在 `renderObservationToCard` 内,经新 density 参)
  - 占位卡 placeholderDensity `:2080-2085` / `:2171-2175`(现 `binding?.density ?? densityForRuntime` → 改 `resolveDensity` 让 per-chat 覆盖首帧,防 placeholder→real 跳变)
  - snapshot 系 `:3125` / `:3438` / `:3726`
  - **bind-time 存点 `:2600` / `:2702` 是「写 binding.density」非渲染读点** → **不改**(仍存 runtime-derived 作 binding 默认;per-chat 覆盖在读时经 resolveDensity 叠加)。⚠ 施工务必分清「读点(渲染)」vs「存点(bind-time)」,勿把存点也套 resolveDensity。
- **e2e 验「稳定终态 text」非首帧**(placeholder 首帧可能仍 binding 值,终态必须是 per-chat 值):设 per-chat `density:"text"` → 该群终态卡走单行摘要;改回继承 → 复 card。

## 4. 不在 C3 范围(明确后置,防误判遗漏)
- **私聊 section 平铺(决策 8)· descope(审查 BLOCKER,非静默丢弃)**:p2p 私聊无数据源——`listChats`(`im.v1.chat.list`,`lark/index.ts:150-151`)**排除 p2p**,群名录唯一源就是它(`chat-directory.ts:124`)→ `data.chats` 永无 p2p 条目,`FeishuSettings.tsx:300` 的 p2p filter 是空操作。**落地私聊 section 须先补一条 p2p 数据通道**(bot 上报见过的 p2p 会话 chatId+owner,或从 binding/inbound 解析 p2p chatId),这是 C3 之外的独立工作。**gate=先问用户**(见 §7):要么单列 follow-up(推荐)、要么把「p2p 数据通道」也纳入本 PR(范围扩大)。**私聊 density 本身**(若将来建成)由 §3.3 `resolveDensity` 天然覆盖 —— per-chat/default density 先于 `densityForRuntime` 的 p2p card-force 命中(density 是最后兜底),**但**这与 M3b「p2p 恒 card」的设计意图有张力(p2p 是否该允许降到 card 以下),届时一并向用户确认(§7)。
- **toolPolicy 编辑器**:PR-B 暂缓,不做。
- **绑定区改进**(bot 名字/头像 + owner 名字):→ PR-C4。
- **覆盖指纹 ○◐● / 2px rail / 折叠网格「任一时刻只展开一维」/ 详情来源标签 `[本群]/[默认]/[内置]` 附在折叠维度行**:随折叠网格后置(PR-C2 §7 已标)。
- **批量套用 / 审计条 / 配置剪贴板**:规模化重装备,首版后置(决策 3/4/5/7)。
- **数据回路**:`applyServerSettingsPatch` / `useUpdatePrimarySettings` / `writeChatConfig` 逻辑零改动(仅 `isChatConfigEmpty` 加 density 判断)。

## 5. 红线(不可弱化)
- **drop-empty 加 density(BLOCKER 级)**:`isChatConfigEmpty` 必须加 `config.density === undefined`,否则 density-only override 被误删(memory 明确记录的坑)。加单测。
- **所见=所判**:web `effectiveConfig.density` 与 bot `resolveDensity` 的 fallback 链必须一致(per-chat > (binding/)default > `card`);预览卡/静息摘要展示值 = bot 渲染实际用值。前端绝不重写一份 density fallback 与 bot 分叉。
- **水合坑**:density 控件渲染实时 `configs`/`defaults` + `useOptimisticSetting`,别 seed-once(详见 `t3-web-settings-editor-hydration-pitfall`)。
- **整值替换**:density 经 `feishuChatConfigs`/`feishuChatDefaults` 整值替换写入,不改 `applyServerSettingsPatch`。
- **契约 ↔ bot parity**:density literal 集合与 `RenderDensity` 全集相等(parity 测试防漂移)。
- **bot 读点 vs 存点**:只迁**渲染读点**到 `resolveDensity`;bind-time 存点(`:2600/2702`)不动。callbackAuth/authz/approval gate **零改动**(density 纯渲染,与审批无关)。
- **单一 overlay**:群/默认密度控件复用 section 已持的 `commitChat`/`commitDefaults`(同一份 `useOptimisticSetting`),**不新起第二个** `feishuChatConfigs` overlay(整值替换下会相互 clobber)。
- **设计定稿是约束**:密度 segmented 三档形态 / 群密度作抽屉第五维——不擅改(私聊 section 已 descope,§4)。

## 6. e2e runbook(真连接)
- **可复用环境**:home `/Users/lizhipeng/.t3-feishu-m0`(已 binding + `im:chat:readonly` + web 登录态,PR-C2 e2e 后已复原干净基线:owner `ou_9b9f...` + `feishuChatDefaults:{approvalMode:initiator}` + `feishuChatConfigs:{}`)。**server-managed 自动托管 bot**;起服务确切命令见 memory `feishu-bridge-e2e-pairing-token`(ws 目录 `.t3-feishu-m0-ws` git init 作 server cwd;浏览器现签 token 走 3773)。
- **⚠ 本 PR 跨三层**:改 web 必 `cd apps/web && pnpm exec vp build` rebuild dist;改 **bot 源码** dev serve 直接跑源码免 rebuild(`chooseBotEntry !packed → 源码`,见 pairing-token memory);改 **contract** 需确认 web/bot 都重编译(dev serve 跑 TS 源码,web 需 rebuild dist)。
- **验证点**:
  - **契约/回路**:web 设 per-chat `density:"text"` → 落 `settings.json` 的 `feishuChatConfigs[chatId].density`(读文件实锤,**且未被 drop-empty 误删** = §3.2/§5 铁证);清除 → 字段消失(entry 若仅 density 则整条删)。
  - **bot 迁读(稳定终态)**:在设了 `density:"text"` 的群 @bot 跑一轮 → 卡片终态走单行摘要(text 档);改回继承默认(card)→ 卡片复 card。**验终态非首帧**。(注:home `.t3-feishu-m0` 现有 `restored 5 chat binding(s)`,群聊可直接用。)
  - **所见=所判**:群抽屉密度维度所选 + 预览 density 行 = `settings.json` 落值 = bot resolveDensity 读值。
  - **(私聊 section 已 descope,无私聊验证点。)**
- **收口**:kill server(finalizer 级联 bot child);home 保留;settings.json 复原干净基线。

## 7. 待确认(实现中定或问用户)
- **私聊 section = 已拍板单列 follow-up(用户 2026-07-06 决,选项 a)**:本 PR **只做群密度**;私聊 section 等一条 p2p 数据通道就绪后单开小 PR。届时该 follow-up kickoff 需先决:①p2p 数据来源(bot 上报见过的 p2p 会话 chatId+owner / 从 binding/inbound 解析);②M3b「p2p 恒 card」vs 决策 8「私聊显密度」的张力——`resolveDensity` 机制上让 per-chat p2p density 覆盖 card-force(density 是最后兜底,非「形同虚设」),**但**是否该允许 p2p 降到 card 以下需确认;③私聊密度控件复用群 section 的单一 overlay(§5,别另起)。
- **群抽屉密度维度布局**:平铺第五维 vs 随折叠网格(折叠网格后置,建议**平铺**)。
- **密度控件用 `toggle-group` 还是 `Select`**:segmented 更贴定稿(mockup 是 segmented),`toggle-group.tsx` 现成;实现中定。
- **`restingChatSummary`/`defaultsSummary` 是否纳 density**:群行摘要是否加「· 密度 text」——density 覆盖较少见,建议**静息摘要不加密度**(保持简洁,预览卡已含),仅 source==="chat" 的 density 是否值得在行内标一笔,实现中定。
- **built-in group density 常量**:web `effectiveConfig.density` 的 built-in 兜底 `"card"` 应抽为共享常量(呼应 bot `densityForRuntime` group 默认),防两端硬编分叉。

## 8. 委派 / 闭环
- **Explore/Plan**(只读,file:line + 结论):动手前复核 §2/§3.3 各 seam(尤其 bot.ts 全部 density 渲染读点 vs bind-time 存点的当前行号 / `renderObservationToCard` 签名 / `effectiveChatConfig` 与 Ref 可达性 / `RenderDensity` 定义 / 契约 Struct / web `isChatConfigEmpty`+`effectiveConfig`+私聊 filter 点)。
- **Test**:`pnpm --filter @t3tools/web run typecheck`、bot/contract typecheck、`pnpm exec vp check`(改动子目录)、单测(density-only entry NOT empty / `effectiveConfig` density fallback / 契约↔`RenderDensity` parity / bot `resolveDensity` 若抽纯函数则单测)。**本 PR 有契约+bot typecheck 需求**(非纯 web)。
- **Review**:多维 + 对抗(**用 Workflow**,见 `review-fanout-prefer-workflow`;维度见下必审规则)。routing:审查用 opus-4.8/fable-5 + gpt-5.5(cc-codex 独立家族,**用 codex 前先 load cc-codex skill**)。

## 【kickoff 必审 · 自传播规则】
本设计文档交付前**必须**多维对抗审查(**优先 Workflow**,`review-fanout-prefer-workflow`):① **代码事实**——file:line 逐条对真实 main(`48fddefe`)核验(尤其 bot.ts **全部 density 渲染读点**当前行号 + 读点/存点区分:`:1522/:1848/:1900/:2080-2085/:2171-2175/:3125/:3438/:3726` 读点、`:2600/:2702` 存点不改;`renderObservationToCard:1744` 签名;`densityForRuntime@chatThreadMap.ts:110`;`RenderDensity@eventRenderer.ts`;`effectiveChatConfig@chatConfig.ts` + Ref `:384/385`;契约 `FeishuChatConfig@settings.ts:375-395`;web `isChatConfigEmpty`/`effectiveConfig`/p2p filter);② **范围完整**——对照设计定稿 §2 + 决策 1(density 契约字段)无遗漏无误分类:**density 契约字段 / bot 迁读全读点 / web 群密度控件(群抽屉+defaults) / 预览 density 行 / isChatConfigEmpty 加 density** 五项都落到范围;**私聊 section 平铺(决策 8)因 p2p 无数据源 descope(§4/§7 gate 先问用户,非静默丢弃)/toolPolicy(PR-B)/绑定区(PR-C4)/指纹·折叠网格·来源标签(随折叠网格)确未纳入** 均已显式标后置;drop-empty 加 density / 所见=所判 / 水合坑 / 整值替换 / 契约↔bot parity / 读点vs存点 / 单一 overlay / authz 零改动 红线已点明;③ **自包含**——memory/文档引用真实(设计定稿 / PR-C2·C1·M3b 施工事实 / 水合坑 / pairing token)、runbook 可执行(web 改先 rebuild dist、bot 源码 dev serve 免 rebuild、契约改两端重编译)、红线齐全、待确认项已在 §7 点明。修掉阻断项再交付,并把**本规则原样写进**衍生的下一里程碑 kickoff(PR-C4)。
