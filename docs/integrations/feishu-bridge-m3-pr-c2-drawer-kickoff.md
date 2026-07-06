# 飞书 Bridge M-3 PR-C2「web 结构:群详情抽屉化 + 默认基线条目 + 静息态干净」kickoff

> 本文**自包含**,承 `docs/integrations/feishu-bridge-m3-pr-c-web-editor-kickoff.md` §3.2 与设计定稿 `docs/integrations/feishu-settings-page-design.md`(§2 信息架构)。file:line 快照 **2026-07-06,main = `f9a24367`(M-3 PR-C1 已合入,#25)**。全部锚点已对当前 main 重核(PR-C1 大改了 `FeishuSettings.tsx` 结构),动手前仍复核。
>
> ⚠️ **命名去歧义**:`M3a`/`M3b`(无连字符)= 老「群聊+话题路由」,已交付;`M-3`(带连字符)= per-chat config。本文 = M-3 **PR-C2**(web 结构重构,承 PR-C1)。
>
> ⚠️ **设计定稿是硬约束**:UI 形态以 `feishu-settings-page-design.md` + 高保真稿 `feishu-settings-mockup-v2.html` 为准(overlay 右抽屉 / 默认配置作群 section 顶部基线条目 / 静息态干净 / owner-always 弱化)。施工不得擅自改设计决策。
>
> ⚠️ **相对原 §3.2 的一处范围修正(重要)**:原 kickoff 把「**私聊平铺**」并入 C2,但设计定稿(决策 8)私聊 section **唯一控件是 density**,而 density 是 **PR-C3 才加的契约字段**——故 C2 的私聊 section 会「空有其表无控件」。本 kickoff **把私聊平铺挪到 PR-C3**(随 density 一起落),**C2 只做群侧结构**(抽屉 + 默认基线 + 静息态)。见 §7。

---

## 0. 硬前置(先核对,否则停)
- `git log --oneline -3` 应见 `f9a24367 …M-3 PR-C1…(#25)` / `caf32408 …PR-A…(#24)` / `a18ad4e5 …PR2c…(#23)`。
- 从**更新后的 main(`f9a24367`)** 新开分支(建议 `feat/feishu-m3-pr-c2-drawer`);**提交/推送只在用户明确要求时,开 PR 前确认**。
- 范围红线继续有效:**不做文件路径 sandbox**;**不做 toolPolicy 编辑器**(PR-B 暂缓);**不改 bot 侧**(纯 web 结构重构,零契约/零 bot 改动)。
- PR-C2 是**纯 web 重构**:把 PR-C1 已建好的编辑器组件**搬进抽屉 + 换信息架构**,不新增 per-chat 维度、不动数据回路。

## 1. 先读
- memory `MEMORY.md` → 尤其:
  - `feishu-settings-page-design-decisions`(**设计定稿 + 用户拍板 8 决策 + 定稿四精修**,本 PR 的 UI 依据;抽屉/基线条目/静息态/owner-always 弱化);
  - `feishu-bridge-m3-pr-c1-impl-facts`(**PR-C1 已交付**:CommandsEditor/WorkspacesEditor/describeInherited*/「限制」开关/两种空语义;这些组件 C2 直接搬进抽屉,回路不改);
  - `t3-web-settings-editor-hydration-pitfall`(`useOptimisticSetting` 渲染实时值,别 seed-once 冻结);
  - `feishu-bridge-e2e-pairing-token`(e2e:pairing 现签 + 浏览器走 3773 + **测未合入 web 先 `cd apps/web && pnpm exec vp build` rebuild dist**);
  - `review-fanout-prefer-workflow` + `feishu-bridge-kickoff-review-rule`(审查用 Workflow + 本文末必审自传播规则)。
- 设计定稿 `feishu-settings-page-design.md`(§2 信息架构给出抽屉 ASCII 稿)+ 高保真稿 `feishu-settings-mockup-v2.html`(浏览器打开看形态)。
- `AGENTS.md`(权威 check/test/typecheck 命令:`vp check` + `vp run typecheck`)。

## 2. 已交付地基(可复用 seam,file:line @ main `f9a24367`,施工前复核)
- **设置外壳**:`SettingsPageContainer`/`SettingsSection`/`SettingsRow`/`SettingResetButton`(`apps/web/src/components/settings/settingsLayout.tsx`;PR-C1 未碰,行号沿用 PR-C kickoff §2:`:122/:18/:48/:98`,复核)。左栏「飞书」导航项 `SettingsSidebarNav.tsx:45`。
- **抽屉组件(抽屉化用)**:`RightPanelSheet`(`apps/web/src/components/RightPanelSheet.tsx:6`,`side="right"` `:21`,宽 `RIGHT_PANEL_SHEET_CLASS_NAME` `:24` ← `rightPanelLayout.ts`,≈28rem);底层 `Sheet`/`SheetPopup`(`ui/sheet.tsx:60`,`side` 默认 right `:65`)+ `SheetHeader:112`/`SheetFooter:125`/`SheetTitle:147`/`SheetPanel:167`。**优先 `RightPanelSheet`**(现成 backdrop+宽度),不够再直接用 `SheetPopup` 传更宽 className。
- **现有飞书编辑器(PR-C1 后结构,C2 要重排的对象)**,`apps/web/src/components/settings/FeishuSettings.tsx`:
  - `FeishuSettingsPanel :60`(壳:`FeishuBindingSection` + `FeishuChatConfigSection`);
  - `FeishuChatConfigSection :235`——读 `serverConfigs`/`serverDefaults :248`/`bindingOwnerOpenId`、`useOptimisticSetting` `configs,commitConfigs :257`、`commitChat`、`useProjects()→projects` 过滤 primary env `:268`、群 p2p 过滤 `chats :276`、渲染 `FeishuDefaultsEditor :301` + `FeishuChatConfigCard :319`(传 `defaultCommands/defaultWorkspaces :325/326`);
  - `FeishuDefaultsEditor :342`(独立块:ModeSelect + ApproversEditor + CommandsEditor + WorkspacesEditor);
  - `FeishuChatConfigCard :392`(展开体:ModeSelect `:429` + designated 时 ApproversEditor `:437` + CommandsEditor `:445` + WorkspacesEditor `:450`);
  - 维度编辑器:`ModeSelect :461` / `ApproversEditor :505` / `CommandsEditor :651` / `WorkspacesEditor :746`;
  - 内联 `useOptimisticSetting :201`(乐观 overlay,水合修复)。
- **纯逻辑**(`FeishuSettings.logic.ts`):`normalizeConfig`(picker==bot)/ `writeChatConfig`(整值替换 + drop-empty)/ `isChatConfigEmpty` / `chatModeSelection` / `defaultsModeSelection` / **`describeInheritedCommands`/`describeInheritedWorkspaces`**(PR-C1 新增,忠实继承提示)/ setter 群。
- **数据回路(不改)**:整值替换 `applyServerSettingsPatch`(`packages/shared/src/serverSettings.ts:91-96` feishuChatConfigs/Defaults 特判整值替换)+ web 提交 `useUpdatePrimarySettings`。C2 **不动回路**——只重排 UI。

## 3. PR-C2 范围(按设计定稿 §2 信息架构,纯 web 结构)

### 3.1 群详情**抽屉化**(overlay 右抽屉,定稿硬约束)
- 把 `FeishuChatConfigCard`(`:392`)的**展开体**(ModeSelect + ApproversEditor + CommandsEditor + WorkspacesEditor 四维)**移入 `RightPanelSheet`**:群列表行**只显一行摘要**(§3.3),**点击行 → 右侧滑出抽屉**编辑该群。
- **接线**:`FeishuChatConfigSection` 持一个 `selectedChatId: string | null` state;群行 `onClick` 设 `selectedChatId`;抽屉 `open={selectedChatId !== null}`,内容 = 选中群的四维编辑器,`onCommit`/`commitChat` 回路**原样复用**(Explore 已确认纯逻辑/`useOptimisticSetting`/`commitChat` 不改)。抽屉 header = 群名 + 「复制 ID」+ 关闭(`SheetTitle`/`SheetHeader`)。
- **抽屉顶「生效预览卡」(定稿 §2 抽屉顶置 + 原则 4「所见=bot 所判」承重件)**:抽屉最上方一张预览卡,用**人名/项数**列出该群继承+解析后的**最终态**(审批模式/审批人、命令、工作区),**复用 §3.3 的 `effectiveSummary` 纯函数**(忠于 `effectiveChatConfig` 三级 fallback,前端绝不重写)。⚠ **density 行随 density 一起 → PR-C3**——C2 的预览卡先不含密度行(§4/§7)。
- **不嵌套折叠**:抽屉内四维平铺(或按定稿「任一时刻只展开一维」的折叠网格——**折叠网格属加分项,首版可先四维平铺**,§7)。

### 3.2 **默认配置基线条目**(并入群 section 顶部,删独立块)
- 删 `FeishuDefaultsEditor` 作为**独立 section 块**的形态(`:301` 那个 `<div>`),改成「群聊」section **顶部一个带「基线」badge 的条目**(与群列表用分隔区隔,**非列表行**),点开**同一个抽屉**编辑 `feishuChatDefaults`。
- **defaults 抽屉无「继承」选项**:每维显式值(ModeSelect `includeInherit={false}`,CommandsEditor/WorkspacesEditor 的 offHint 用 defaults 语义「不限制,允许全部…」——PR-C1 已是此文案,复用)。
- **实现**:抽屉复用同一套编辑器,靠 `selectedChatId === DEFAULTS_SENTINEL`(或独立 `editingDefaults` 布尔)切「编辑 defaults」分支,commit 走 `feishuChatDefaults` 而非 `commitChat`。

### 3.3 **静息态干净**(设计定稿立论根基)
- 无覆盖的群列表行**只显一行安静灰字 = 继承到的真实生效值**(不藏值);有覆盖的群显「改过」信号(定稿:2px 左 rail 亮 + 策略指纹 ○◐● + 被覆盖维度 chip——**指纹/rail 属加分项,首版至少做「一行生效值摘要 + 改过/纯继承二态」**,§7)。
- **生效值解析必须复用 bot 语义(红线,§5)**:`configs[chatId]?.X ?? defaults.X ?? 内置`——审批模式复用 `chatModeSelection`/`defaultsModeSelection`,commands/workspaces 复用 PR-C1 的 `describeInherited*` 思路(或抽一个 `effectiveSummary(chatId, configs, defaults)` 纯函数于 `logic.ts`,**忠于 bot `effectiveChatConfig` 三级 fallback**,单测)。**此纯函数是唯一真相,§3.1 抽屉顶生效预览卡与本处列表行摘要两处消费方共用同一份**,**前端绝不重写一份 fallback**。
- **owner-always 弱化**(定稿):审批维度不出现 owner 护栏轨道;生效摘要不加「授权人,始终」尾巴;各维度不加 owner 豁免脚注。

## 4. 不在 C2 范围(明确后置,防误判遗漏)
- **私聊平铺 + density**:→ **PR-C3**(私聊 section 唯一控件=density,density 是 C3 契约字段;二者绑定,见 §7)。
- **density 维度**(群抽屉里的密度控件):→ PR-C3。
- **绑定区改进**(bot 名字/头像 + owner 名字):→ PR-C4。
- **toolPolicy 编辑器**:PR-B 暂缓,不做。
- **批量套用 / 审计条 / 配置指纹 rail / 折叠网格「任一时刻只展开一维」**:设计稿画了但属规模化重装备,**首版后置**(§7;定稿决策 3/4/5)。
- **数据回路**:`applyServerSettingsPatch` / `useUpdatePrimarySettings` / `commitChat` / `writeChatConfig` **零改动**。

## 5. 红线(不可弱化)
- **所见=所判**:静息态灰字/生效摘要展示的值,必须与 bot 强制执行一致——复用 `normalizeConfig` + 忠于 `effectiveChatConfig` 三级 fallback,**前端绝不重写一份 fallback**。
- **水合坑**:抽屉/摘要渲染实时 atom 值 + `useOptimisticSetting` 乐观 overlay,**别** seed-once `useState(()=>atomValue)`(硬刷新丢显示,详见 memory `t3-web-settings-editor-hydration-pitfall`)。抽屉是「受控 overlay」——`selectedChatId` 是本地 UI state 可 seed,但**配置值必须读实时 `configs`/`serverDefaults`**,不得把配置快照冻进抽屉。
- **整值替换 / drop-empty 语义不变**:抽屉编辑仍走 `commitChat`→`writeChatConfig`(整值替换 + drop-empty),defaults 走整值写;**不改 `applyServerSettingsPatch`、不改 `isChatConfigEmpty` 字段集**。
- **bot 侧零改动**:C2 纯 web,不碰契约/bot/authz;PR-C1 的命令 registry、bot authz 不动。
- **设计定稿是约束**:overlay 右抽屉 / 默认基线条目 / 静息态干净 / owner-always 弱化——不擅自回退旧形态、不擅改决策。

## 6. e2e runbook(真连接)
- **可复用环境**:home `/Users/lizhipeng/.t3-feishu-m0`(已 binding + provisioned app 含 `im:chat:readonly` + web 登录态,PR-C1 e2e 后已复原干净基线:owner `ou_9b9f1f56…` + `feishuChatDefaults:{approvalMode:initiator}` 无 configs)。起 server:`T3CODE_HOME=/Users/lizhipeng/.t3-feishu-m0 T3CODE_PORT=3773 node apps/server/src/bin.ts serve`;bot server-managed 自动 spawn;浏览器 pairing `node apps/server/src/bin.ts auth pairing create --base-dir <HOME> --base-url http://localhost:3773`,**浏览器认证走 3773**。**⚠ 本 PR 是 web 改动,必须 `cd apps/web && pnpm exec vp build` rebuild dist 后再测**。细节见 memory `feishu-bridge-e2e-pairing-token`。
- **验证点**(纯 web,多数不需 bot 交互):
  - **抽屉**:点群行 → 右抽屉滑出该群四维编辑器;编辑审批/命令/工作区 → 落 settings.json(读文件实锤);关抽屉再开 → 值仍在;硬刷新 web 保值(水合回归)。
  - **默认基线条目**:群 section 顶部「基线」条目点开抽屉编辑 defaults(无「继承」选项);改 defaults → 无覆盖群的静息摘要随之变(所见=所判 + live)。
  - **静息态干净**:无覆盖群显一行生效灰字(= 继承到的真实值,如「仅发起人 · 命令全部 · 工作区全部」);配了覆盖的群显「改过」信号。
  - **所见=所判**:抽屉所选 = settings.json 落值 = bot 会读的值(可对若干群配置后直接读 settings.json 比对)。
- **收口**:kill server;home 保留;settings.json 复原干净基线。

## 7. 待确认(实现中定或问用户)
- **私聊平铺挪到 C3(本 kickoff 的范围修正)**:C2 只做群侧;私聊 section(唯一控件 density)与 density 契约一起在 C3 落。**若用户希望 C2 就摆出私聊 section**(哪怕暂无控件、只一句 owner-always 说明),可纳入——但收益低,建议随 C3。
- **静息态信号做到哪层**:首版「一行生效摘要 + 改过/纯继承二态」是否够?还是首版就上 2px rail + ○◐● 指纹 + 被覆盖维度 chip(设计稿画了,属规模化)。建议**首版摘要 + 二态,指纹/rail 后置**。
- **详情尺度「来源双轨」标签(定稿原则 3)显式后置**:抽屉内各维度行的 `[本群]/[默认]/[内置]` 三级来源标签 + ⟲ 重置按钮(附在折叠网格维度行上)——**与折叠网格一起后置**(首版四维平铺不带来源标签,靠 §3.1 生效预览卡 + §3.2 defaults 无「继承」项已足够表达来源);待折叠网格落地时随之补。此处显式标注,避免被误判为遗漏。
- **抽屉内维度布局**:四维平铺 vs 定稿「折叠网格·任一时刻只展开一维」。建议**首版平铺**(折叠网格后置,不阻断)。
- **默认基线 vs 群 抽屉复用程度**:同一抽屉组件靠 sentinel 切分支(推荐)vs 两个抽屉。实现中定。
- **批量套用 / 审计条 / 配置剪贴板**:规模化重装备,首版后置(设计定稿决策 3/4/5)。

## 8. 委派 / 闭环
- **Explore/Plan**(只读,file:line + 结论):动手前复核 §2 各 seam(尤其 `FeishuSettings.tsx` PR-C1 后结构 / `RightPanelSheet`+`Sheet` 用法 / `settingsLayout` 外壳行号 / `useOptimisticSetting` 与抽屉受控的相容 / `describeInherited*` 复用面)。
- **Test**:`pnpm --filter @t3tools/web run typecheck`、`pnpm exec vp check`(改动子目录)、单测(新抽的 `effectiveSummary` 等纯函数;`FeishuSettings.logic` 保持既有单测过)。**纯 web,无契约/bot typecheck 需求**。
- **Review**:多维 + 对抗(**用 Workflow**,见 `review-fanout-prefer-workflow`;维度见下必审规则)。

## 【kickoff 必审 · 自传播规则】
本设计文档交付前**必须**多维对抗审查(**优先 Workflow**,`review-fanout-prefer-workflow`):① **代码事实**——file:line 逐条对真实 main(`f9a24367`)核验(尤其 `FeishuSettings.tsx` PR-C1 后结构:`FeishuChatConfigSection :235`/`FeishuChatConfigCard :392`/四维编辑器行号 / `FeishuDefaultsEditor :342` / `useOptimisticSetting :201` / `describeInherited*`;抽屉 `RightPanelSheet.tsx:6`+`ui/sheet.tsx` 组件 / `settingsLayout` 外壳 / 数据回路 `serverSettings.ts:91-96` 整值替换 / `applyServerSettingsPatch` 不改);② **范围完整**——对照设计定稿 `feishu-settings-page-design.md` §2 与用户拍板 8 决策无遗漏无误分类,**抽屉化 / 默认基线条目 / 静息态干净 / 抽屉顶生效预览卡 / owner-always 弱化 五项设计决策都落到范围**(生效预览卡的 density 行随 density 挪 C3),**私聊平铺+density 确未纳入 C2(挪 C3)、toolPolicy 编辑器确未纳入(PR-B 暂缓)、绑定区确未纳入(PR-C4)、详情尺度「来源双轨」标签+⟲+折叠网格确未纳入(随折叠网格后置)** 均已显式标后置(§4/§7)非静默丢弃,所见=所判/水合坑/整值替换红线已点明;③ **自包含**——memory/文档引用真实(设计定稿 / PR-C1 施工事实 / 水合坑 / pairing token)、runbook 可执行(web 改动先 rebuild dist)、红线齐全(所见=所判 / 水合坑 / 整值替换 / bot 零改动 / 设计定稿约束)、待确认项已在 §7 点明。修掉阻断项再交付,并把**本规则原样写进**衍生的下一里程碑 kickoff(PR-C3)。
