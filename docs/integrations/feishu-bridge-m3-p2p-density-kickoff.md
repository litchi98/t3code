# 飞书 Bridge M-3「私聊(p2p)section 平铺 + 密度可配」kickoff

> 本文**自包含**。承接 M-3 PR-C 系列(C1–C4 已合)与设计定稿 `docs/integrations/feishu-settings-page-design.md`(§35-37 / §67 / §84 / §86 / §107 私聊平铺意图)+ mockup `docs/integrations/feishu-settings-mockup-v2.html:1813-1838`(私聊 section 实物稿)。file:line 快照 **2026-07-08,main = `ba847bab`**(M-3 PR-C4 绑定区已合,#33;叠在 #32 pin-drift `9f97abab` 上)。全部锚点已由 2 路 Explore 对当前 main 逐条核验;动手前仍用 Explore 复核关键 seam。
>
> ⚠️ **命名去歧义**:`M3a`/`M3b`(无连字符)= 老「群聊+话题路由」里程碑,已交付;`M-3`(带连字符)= per-chat config。本文 = M-3 收尾的**私聊平铺** follow-up(PR-C3 决策8 descope 项),用户 2026-07-08 拍板「**放开 p2p 硬门、私聊密度真可配**」。

---

## 0. 硬前置(先核对,否则停)
- `git log --oneline -3` 应见 `ba847bab …绑定区…(#33)` / `9f97abab …observe pin-drift…(#32)` / `cc3732e1 …eventRenderer 拆分…(#31)`。
- 从当前 main(`ba847bab`)新开分支(建议 `feat/feishu-p2p-density`);**提交/推送只在用户明确要求时,开 PR 前确认**。
- **本 PR 跨三层**(contracts / feishu-bot / web)。每层 typecheck + `pnpm exec vp check <改动子目录>` + 单测必过(权威命令见 `AGENTS.md`;失败先 `vp fmt`)。改 web 必 `cd apps/web && pnpm exec vp build` rebuild dist;改 bot/contract 源码 dev serve 直接跑源码免 rebuild。

## 1. 先读(memory + 上游)
- `MEMORY.md` → 尤其:
  - `feishu-bridge-m3-pr-c3-impl-facts`(**density per-chat 契约字段 + `resolveRenderDensity`/`resolveDensity` 抽取 + 6 渲染读点迁读 + `isChatConfigEmpty` 加 density drop-empty 红线**;本 PR 直接改这套的 p2p 硬门);
  - `feishu-bridge-m3-pr-c4-impl-facts`(**owner 名字群名录反查**惯例,私聊行显示 owner 名字复用它;`useOptimisticSetting` 渲染实时值守水合坑);
  - `feishu-settings-page-design-decisions`(**决策8 = 私聊只显密度**;定稿四处精修①私聊 section 上移②平铺不走抽屉;owner-always 弱化「只在私聊 section 保留一句说明」);
  - `t3-web-settings-editor-hydration-pitfall`(编辑器渲染实时 atom 值 + `useOptimisticSetting` 乐观 overlay,别 `useState(()=>atomValue)`);
  - `feishu-bridge-e2e-pairing-token`(pairing token 现签 + 浏览器走 server 3773 + server-managed bot 免手起 + 未合入 web 先 rebuild dist);
  - `feishu-bridge-kickoff-review-rule` + `review-fanout-prefer-workflow`(文末必审自传播规则来源 + 审查用 Workflow)。
- 设计定稿 `docs/integrations/feishu-settings-page-design.md` §35-37/§67/§69/§84/§86/§107;mockup `feishu-settings-mockup-v2.html:1813-1838`(私聊段)。

## 2. 决策与设计(用户已拍板放开硬门,以下为落地设计)

**产品决策(2026-07-08 用户拍板)**:放开 bot 对 p2p 私聊 density 的硬门,让**私聊密度真可配**(忠于 mockup/决策8);私聊 section 上移到「绑定」之后、「群聊」之前,**平铺不走抽屉**——只一个密度 segmented 就地可改 + 一句 owner-always 说明。

### 2.1 三条已证实的地基事实(决定设计,勿再质疑)
1. **full-access ⟺ p2p 一一对应(feishu-bot 域)**:`runtimeModeForChatType`(`chatThreadMap.ts:82-83`)`chatType === "p2p" ? "full-access" : "approval-required"` 是**唯一** full-access 产生点;群/话题在任何路径(含 `/resume` `commands/handlers.ts:906`、审批)都不会变 full-access。契约层 `DEFAULT_RUNTIME_MODE="full-access"`(`orchestration.ts:123`)是 server/web session 域,**不流入** feishu-bot chat-thread。→ **gate 继续判 `runtimeMode === "full-access"` 安全,不误伤群**;无需改成按 chatType(bot 消费点手里稳定拿到的是 runtimeMode)。
2. **p2p 不进 roster、web 拿不到 p2p chatId**:`listChats`(`im.v1.chat.list`,`lark/index.ts:149-154`)明确「Excludes p2p private chats」→ `directory.chats` 永无 p2p 条目;`FeishuBinding` 契约(`settings.ts:475-481`)只有 `appId/tenant/ownerOpenId`,**无 p2p chatId**。→ **`feishuChatConfigs[p2pChatId]` 作 key 的方案 web 端断链**(写不进),排除。
3. **审批按钮不随密度降级消失**:三档 density 都产 `CardJson`(交互卡),交互段(审批按钮)在 density 分支**之外无条件注入**(`eventRenderer.ts:363-370`,注释 `:75`/`:136`「All three densities keep … the interaction section」)。→ p2p 降到 text/markdown **审批按钮仍在**,放开无功能回归。

### 2.2 契约设计:独立 `p2pDensity` 字段,只从全局 defaults 读(最小接线)
- 给 `FeishuChatConfig`(`settings.ts:384-410`)加 `p2pDensity: Schema.optional(Schema.Literals(FEISHU_RENDER_DENSITIES))`,**紧邻现有 `density`(`:409`)**,doc 明确:「私聊(p2p)渲染密度,**仅在全局 `feishuChatDefaults` 上有意义**,per-chat 群配置忽略此字段;缺失 → `card`(保留放开前的 p2p 恒 card 默认);与 `density`(群默认)**独立**,互不耦合。」
  - **为何加在 `FeishuChatConfig` 而非新顶层标量**:`feishuChatDefaults` 本身即 `FeishuChatConfig`(`settings.ts:492`),bot 侧 `resolveDensity` 闭包**已握 `chatDefaultsRef`**(`bot.ts:281`)→ 读 `p2pDensity` **零新 Ref/watcher/`runBoundSession` param**。新顶层标量则需新 Ref + `residency.ts:257-258` 加 `Ref.set` + `runBoundSession` 签名(`bot.ts:116-122`)+ 3 处 call site(`:366/565/598`)全改,plumbing 重得多。语义泄漏(字段挂在 per-chat 类型)由 doc + 「群侧零读写」封住。
  - ⚠ **不复用 `feishuChatDefaults.density`**:那是**群**默认(`settings.ts:405-409` + `FeishuSettings.tsx:263-267`),复用会让改群默认联动改私聊——用户要 p2p 独立可调,故必须独立字段。
  - `settings.ts:618-632` 的第二处(optionalKey 变体)引用同一个 `FeishuChatConfig`,单点改契约即两处生效(核对无需重复加)。

### 2.3 bot 消费:`resolveDensity` p2p 分支读 `p2pDensity`(替换硬门)
- `resolveDensity`(`bot.ts:269-285`)当前 `:276` `if (runtimeMode === "full-access") return "card";`。**改为**:
  ```ts
  if (runtimeMode === "full-access") {
    return (yield* Ref.get(chatDefaultsRef)).p2pDensity ?? "card";
  }
  ```
  仍提前返回、**不读 `binding?.density`**,故无 flicker、无需碰 bind-time STORE(见 2.4)。
- `resolveRenderDensity`(`chatThreadMap.ts:129-135`)的 `runtimeMode === "full-access" ? "card" : …` 分支,经上一步后**对 `resolveDensity` 路径变死代码**(p2p 已提前返回)。处理二选一(实现/审查定):(a)保留作防御 + 更新 doc;(b)去掉 full-access 特判、`resolveRenderDensity` 只管群 precedence(`configDensity ?? bindingDensity ?? groupChatDensity`),p2p 密度解析完全收敛进 `resolveDensity`。**倾向 (b)**(消灭误导性死分支,单测更聚焦)。`densityForRuntime`(`:110-113`)见 2.4。
- **必改注释**(现全体宣称「p2p 恒 card / 不可配」,放开后变谎言):`bot.ts:254-258`(「0. p2p … ALWAYS card — a hard M3b invariant …」)、`chatThreadMap.ts:102-108`(densityForRuntime doc)、`chatThreadMap.ts:115-122`(resolveRenderDensity doc「the M3b invariant … promised by the contract + editor copy」)、web 侧 `FeishuSettings.logic.ts:70-74`、`FeishuSettings.tsx:948-949`(`DensityDimension` doc「group-only」)。**改成**:「p2p 密度由 `feishuChatDefaults.p2pDensity` 配置,缺失默认 `card`」。
- **回归单测**:`chatConfig.test.ts:78-84`(`describe("resolveRenderDensity — p2p gate …")`)两条断言(`:82` 全参 → card;`:83` 全 undefined → card)。放开后:密度解析改走 `resolveDensity`,新增/改写断言为「p2p 分支:`p2pDensity` 设值 → 该值;未设 → card 兜底」。群/话题 precedence 测(`:86-95`)、`effectiveChatConfig` fallback(`:66-75`)、字面量 parity(`:98-105`)**不受影响,不改**。

### 2.4 ⚠ 占位首帧 flicker(kickoff 审查抓出的承重步骤,必须纳入范围)
**教训(2 维 Claude + gpt-5.5 三方独立命中,原 kickoff 误判为「不改自然无 flicker」)**:占位「思考中」首帧**不会自动**用 p2p 密度,不额外处理会出现 `card→配置值` 跳变——正是本 PR 视觉目的的破绽。
- **根因**:占位帧走的是**合成** `placeholderThread`,其 `runtimeMode` **硬编码 `"approval-required"`**(`notices.ts:113-124`,共享 const,注释「The real runtimeMode overwrites it on the first folded frame」),**不由 chatType 派生**。两处占位渲染点(`turnRunner.ts:247`、`observeMirror.ts:1049`)都 `resolveDensity(chatId, placeholderThread.runtimeMode)` = 传 `"approval-required"` → 命中 `resolveDensity` **群分支**(`bot.ts:284` → `resolveRenderDensity("approval-required", effectiveChatConfig(p2p).density, binding.density, groupChatDensity)`),读的是**群** `density` / `binding.density`(bind-time 固化的 `card`)**而非新 `p2pDensity`**;真帧(full-access)才走 2.3 的 p2p 分支拿 `p2pDensity`。→ 设 `p2pDensity="text"`(且群 `defaults.density` 未设,常态):占位帧 `card` → 真帧 `text`,每个 p2p turn 闪一次。
- **修法(纳入本 PR)**:占位渲染点必须用**真实 p2p runtimeMode** 解析密度,而非合成占位的 `approval-required`。真实 runtimeMode 在 `turnRunner.ts:196` 已由 `runtimeModeForChatType(dispatch.sources[0]?.message.chatType ?? "p2p")` 算出 → 把**它**(而非 `placeholderThread.runtimeMode`)传给 `turnRunner.ts:247` 的 `resolveDensity`。`observeMirror.ts:1049` 的占位同理,但 **须先 Explore 确认该处 chatType / 真实 runtimeMode 从何取**(observe 腿占位入参来源与 driveTurn 不同,可能须从 snapshot/adopt 的 thread 或 chatType 取;若取不到则 flicker 修法要另想)。
- **副结论**:占位一旦改用真实 runtimeMode,p2p 走 2.3 提前返回、`binding.density`(card)对 p2p 重新变**无害死值** → `densityForRuntime` 与 bind-time STORE(`ensureThread.ts:263/365`)**不用改**。反之若不修占位,`binding.density=card` 对占位是**承重**的(占位靠它出 card),**不能**当死值——这也是原 kickoff 的误判点。
- **动手仍须验证**:grep bot 侧 `\.density` 确认无第三条 p2p 渲染路径直读 `binding.density` 绕过 `resolveDensity`(PR-C3 已把 8 读点 `turnRunner.ts:247`/`observeMirror.ts:651/798/855/1049`/`recovery.ts:332`/`cardAction.ts:320/665` 收敛,理应无漏)。

### 2.5 web:新增私聊 section(平铺、就地可改、不走抽屉)
- 新 `FeishuP2pSection`(建议),渲染顺序:`FeishuSettingsPanel`(`FeishuSettings.tsx:89-95`)在 `FeishuBindingSection` 后、`FeishuChatConfigSection` 前插入。
- **数据源 = 绑定 owner**(非 directory):`binding = usePrimarySettings(s => s.feishuBinding)`;私聊行显示 owner(`🔒 <owner 名字>`,名字走 PR-C4 的群名录反查 `directory.chats.flatMap(members).find(openId===ownerOpenId)?.name ?? 裸 openId`)。未绑定则整个 section 不渲染。
- **密度控件**:就地复用 `DensityDimension`(`FeishuSettings.tsx:951-1012`,纯 UI 可复用),**不走 `RightPanelSheet` 抽屉**(绕开 `drawerTarget` 整套 `:387-458`);`value = feishuChatDefaults.p2pDensity ?? "card"`(⚠ **必须 coalesce**——审查抓出:`DensityDimension` 仅当 `value === option.value` 高亮段(`:988`),`includeInherit={false}` 无 undefined 选项,缺省传 `undefined` 则**无段高亮**,违反「默认显卡片 / 硬刷新保值」;镜像群默认编辑器 `:817` `value={defaults.density ?? DEFAULT_GROUP_DENSITY}` 写法),`includeInherit={false}`(私聊无「继承」概念),`onChange` 写 `feishuChatDefaults.p2pDensity`。
- **读写 seam**:`useOptimisticSetting`(`:295-327`,渲染实时值守水合坑)+ 新增纯函数 `setP2pDensity(defaults, density)`(`FeishuSettings.logic.ts`,整值替换写 `feishuChatDefaults.p2pDensity`,`undefined`→删字段);沿用整值替换 patch(`applyServerSettingsPatch`)。⚠ 若 density 缺省即 card,`undefined` 与显式 `card` 语义等价,写入可归一(选一,doc 注明)。
- **owner-always 说明**:一句(mockup `:1827`「私聊仅授权人可用 —— 审批 / 命令 / 工作区由 owner-always 规则免配,仅『消息密度』可个性化」)。
- **群列表 p2p 过滤保留**:`FeishuSettings.tsx:381` `filter(chat => chat.chatMode !== "p2p")` 不动(p2p 本就不进 roster,防御性 no-op;私聊 section 独立数据源)。
- **所见=所判**:web 显示/可选的 density = bot `resolveDensity` p2p 分支所判。**不新造** effective 逻辑;段内只读一个标量。

## 3. 范围边界(明确不做)
- **不碰群/话题 density**(2.1-1 已证不误伤;`resolveRenderDensity` 群 precedence 保持)。
- **不改审批/命令/工作区**(私聊三维对 owner 经 `isOwnerExempt` 恒真免配,`authz.ts:120-121/74-96/146-161/183-187`;私聊 section 不显示这三维,只一句说明)。
- **不碰 secret / callbackAuth / authz 决策层 / 重绑 / 飞书 scope**。
- **不做** owner 头像(PR-C4 descope,需 contact scope + 重绑)、私聊多实例(绑定=单 owner=单 p2p,一个标量足够)、density linter(v1.5)。

## 4. 红线
- **所见=所判**:web 可选 density = bot 对 p2p 实判;不得出现「控件能改但 bot 忽略」(正是本 PR 要消灭的旧态)。
- **群不受影响**:放开只对 `runtimeMode === "full-access"`(=p2p);群/话题密度 precedence 字节不变(2.1-1 保证)。
- **审批按钮不丢**:p2p 降 text/markdown 后交互段仍在(2.1-3);e2e 必验私聊降密度后审批仍可点。
- **默认保守**:`p2pDensity` 缺失 → `card`(保留放开前默认,不静默改变既有私聊观感)。
- **后向兼容**:`p2pDensity` 为 `Schema.optional`,旧 settings 无此字段照常解码;契约版本无关(settings 无版本字面量门)。
- **无 flicker**:占位首帧必须用**真实 p2p runtimeMode** 解析密度(2.4;合成占位的硬编码 `approval-required` 会让占位停在 `card` → 与真帧 `p2pDensity` 闪跳)——这是**范围内承重步骤**,非「不改自然成立」。
- **secret 零触碰 / 无新 scope / 不改重绑**。

## 5. e2e runbook(真连接)
- **可复用环境**:home `/Users/lizhipeng/.t3-feishu-m0`(已 binding + `im:chat:readonly` + web 登录态)。server-managed 自动托管 bot;起服务命令见 memory `feishu-bridge-e2e-pairing-token`(ws 目录 `.t3-feishu-m0-ws`;浏览器现签 token 走 3773)。**改 web 必 `cd apps/web && pnpm exec vp build`;改 bot/contract dev serve 跑源码免 rebuild**。
- **验证点**:
  - **web 私聊 section**:绑定后设置→飞书,「绑定」下方出现**私聊 section**(在群聊 section 之上),显示 `🔒 <owner 名字>` + 密度 segmented(默认「卡片」)+ owner-always 说明一句。
  - **可配生效(核心)**:私聊 section 把密度改 `纯文本`/`Markdown` → 在**与 bot 的私聊**里发一条触发一个 turn → 卡片按所选密度渲染(过程折叠成单行摘要/丢弃噪音),**非 card**。验「放开硬门、config 真生效」。
  - **审批按钮不丢(红线)**:私聊密度设 `纯文本`,触发一个**需审批**的动作(如需批准的工具)→ 卡片虽 text 密度,**审批按钮仍在且可点**、点击正常放行。
  - **默认兜底**:清空私聊密度(回默认)→ 私聊卡片回 `card`。
  - **群不受影响**:群聊照旧(默认/配置的群密度),私聊改动不波及任何群。
  - **无 flicker**:私聊 turn 的占位首帧与终帧密度一致(不闪 card 再降级)。
  - **硬刷新保值**:web 改私聊密度后硬刷新,控件仍显所选值(守水合坑)。
- **收口**:kill server(finalizer 级联 bot child);home 保留。

## 6. 待确认(实现中定或问用户)
- **`resolveRenderDensity` 死分支处理**:2.3 的 (a) 保留防御 vs (b) 去 full-access 特判收敛进 `resolveDensity`——**倾向 (b)**,实现/审查定。
- **`undefined` vs 显式 `card` 归一**:密度缺省即 card,写入时 `card` 是否归一为删字段(2.5)——建议归一(静息态干净、drop-empty 一致),doc 注明。
- **字段落点**:2.2 已定 `FeishuChatConfig.p2pDensity`(最小 plumbing);若审查认为语义泄漏不可接受,备选新顶层标量(代价:新 Ref/watcher/param 全链,见 2.2)。
- **私聊 section 未绑定态**:未绑定不渲染(建议)vs 显灰字占位——建议不渲染(与绑定区未绑定态一致)。
- **observe 腿占位的真实 runtimeMode 来源(2.4 修法的落地缺口)**:`turnRunner.ts:247` 的占位可直接复用 `:196` 已算的真实 runtimeMode;但 `observeMirror.ts:1049` 的占位入参来源不同,须 Explore 确认 chatType / 真实 runtimeMode 在该处是否在手(取不到则 flicker 修法要另想,如从 adopt/snapshot 的 thread 取或让占位密度按 chatType 直算)。

## 7. 委派 / 闭环
- **Explore/Plan**(只读,file:line + 结论):动手前复核 §2 各 seam(尤其 `resolveDensity` 闭包握 `chatDefaultsRef` / **两处占位渲染点 `turnRunner.ts:247`+`observeMirror.ts:1049` 传的是硬编码 `placeholderThread.runtimeMode="approval-required"`,须换成真实 p2p runtimeMode——见 2.4 承重步骤** / 8 处 density 读点无直读 `binding.density` 的 p2p 漏网 / `FeishuChatConfig` 契约两处引用 / `DensityDimension` props 及 `value===option.value` 高亮语义 / `useOptimisticSetting` 实时值 / owner 名字反查)。
- **Test**:contracts/bot/web typecheck、`pnpm exec vp check <改动子目录>`、单测(改写 `chatConfig.test.ts:78-84` p2p 断言 / 新增 `setP2pDensity` 纯函数测 / density 缺省 card 兜底)。**本 PR 三层 typecheck**。
- **Review**:多维 + 对抗(**用 Workflow**,`review-fanout-prefer-workflow`)。routing:审查用 opus-4.8/fable-5 + gpt-5.5(cc-codex 独立家族,**用 codex 前先 load cc-codex skill**)。

## 【kickoff 必审 · 自传播规则】
本设计文档交付前**必须**多维对抗审查(**优先 Workflow**,`review-fanout-prefer-workflow`):① **代码事实**——file:line 逐条对真实 main(`ba847bab`)核验(尤其:`runtimeModeForChatType@chatThreadMap.ts:82-83` full-access 唯一产生点 / `resolveDensity@bot.ts:269-285` 硬门 `:276` + 闭包握 `chatDefaultsRef` / `resolveRenderDensity`/`densityForRuntime@chatThreadMap.ts:110-135` / 8 处密度读点 / `eventRenderer.ts:363-370` 审批段无条件注入 / `FeishuChatConfig@settings.ts:384-410` + `feishuChatDefaults:492` / `FeishuBinding@settings.ts:475-481` 无 p2p chatId / `listChats@lark/index.ts:149-154` 排除 p2p / `chatConfig.test.ts:78-95` / `FeishuSettingsPanel@FeishuSettings.tsx:89-95` + `DensityDimension:951-1012` + p2p 过滤 `:381` + `useOptimisticSetting:295-327` / authz 免配 `authz.ts:120-121/74-96/146-161/183-187`);② **范围完整**——放开硬门(3 处注释 + `bot.ts:276` + 单测)/ 契约独立 `p2pDensity` 字段 / bot p2p 分支读 defaults / web 私聊 section 平铺 + 数据源=绑定 owner + 复用 `DensityDimension` 不走抽屉 都落到范围;群 density 不动 / 审批命令工作区不动 / owner 头像 / p2p 多实例 / linter 均已显式标不做;放开只对 full-access=p2p 不误伤群 / 审批按钮不丢 / 无 flicker / 默认 card / 后向兼容 / secret 零触碰 / 无新 scope 红线已点明;③ **自包含**——memory/文档引用真实(PR-C3·C4 施工事实 / 设计定稿 / mockup / 水合坑 / pairing token)、runbook 可执行(web 改先 rebuild dist、bot/contract dev serve 免 rebuild)、红线齐全、待确认项已在 §6 点明。修掉阻断项再交付,并把**本规则原样写进**衍生的下一里程碑 kickoff。
