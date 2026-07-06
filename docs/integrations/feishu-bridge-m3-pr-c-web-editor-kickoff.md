# 飞书 Bridge M-3 PR-C「web 配置编辑器」kickoff(commands / workspaces / density 编辑器 + 抽屉化 + 私聊平铺 + 绑定区改进)

> 本文**自包含**,承接 `docs/integrations/feishu-bridge-m3-per-chat-consume-kickoff.md` §3.1/3.2/3.4 与设计定稿 `docs/integrations/feishu-settings-page-design.md`。file:line 快照 **2026-07-04,main = `caf32408`(M-3 PR-A 已合入,#24;web/contracts 侧零漂移)**。全部锚点已由 Explore 对当前 main **逐条核实**,动手前仍复核。
>
> ⚠️ **命名去歧义**:`M3a`/`M3b`(无连字符)= 老「群聊+话题路由」,已交付;`M-2`/`M-3`(带连字符)= per-chat config。本文 = M-3 **PR-C**(web 编辑器,承 PR-A;**PR-B toolPolicy 已暂缓**,故 PR-C 不含 toolPolicy 编辑器)。
>
> ⚠️ **设计定稿是硬约束**:UI 形态以 `feishu-settings-page-design.md` + 高保真稿 `feishu-settings-mockup-v2.html` 为准(overlay 右抽屉 / 私聊上移平铺 / 默认配置作群聊基线条目 / owner-always 弱化 / 静息态干净)。施工不得擅自改设计决策。

---

## 0. 硬前置(先核对,否则停)
- `git log --oneline -3` 应见 `caf32408 …M-3 PR-A…(#24)` / `a18ad4e5 …PR2c…(#23)` / `41dce388 …PR2b…(#22)`。
- 从**更新后的 main(`caf32408`)** 新开分支(建议 `feat/feishu-m3-pr-c-web-editor`);**提交/推送只在用户明确要求时,开 PR 前确认**。
- 范围红线继续有效(原始 kickoff `feishu-bridge-per-chat-config-kickoff.md` §3.2 + 主 kickoff `feishu-bridge-m2-m3-desktop-kickoff.md` §7):**不做文件路径 sandbox**;**workspace 授权=选择/授权层非路径拦截**,PR 描述不得给「已隔离」错觉。
- **PR-B(toolPolicy)已暂缓**(`feishu-bridge-m3-pr-b-toolpolicy-kickoff.md` 顶部🅿️,因只 Claude 支持):PR-C **不做 toolPolicy 编辑器**,契约 `toolPolicy` 字段保留但 web 不碰。

## 1. 先读
- memory `MEMORY.md` → 尤其:
  - `feishu-settings-page-design-decisions`(**设计定稿 + 用户拍板 8 决策 + 定稿四精修**,本 PR 的 UI 依据);
  - `feishu-bridge-binding-display-facts`(**绑定区改进**:bot 名字白得 / bot 头像一次无 scope 调用 / owner 名字走群名录 / 只 owner 头像需 contact scope + 重绑;⚠ 文档谎报 contact scope 已配);
  - `t3-web-settings-editor-hydration-pitfall`(`useOptimisticSetting` 渲染实时值,别 `useState(()=>atomValue)` 冻结);
  - `feishu-bridge-m2-pr2c-impl-facts`(PR2c 三态审批编辑器 + `normalizeConfig` picker==bot + 成员名字);
  - `feishu-bridge-m3-pr-a-impl-facts`(PR-A 消费 commands/workspaces 的 bot 侧语义 + owner 豁免);
  - `feishu-bridge-e2e-pairing-token`(e2e:pairing 现签 + 浏览器走 3773 + **测未合入 web 先 `cd apps/web && pnpm exec vp build` rebuild dist**);
  - `review-fanout-prefer-workflow` + `feishu-bridge-kickoff-review-rule`(审查用 Workflow + 本文末必审自传播规则)。
- 设计定稿 `feishu-settings-page-design.md`(§2 信息架构 / §4 落地映射)+ 高保真稿 `feishu-settings-mockup-v2.html`(浏览器打开看形态)。
- `AGENTS.md`(权威 check/test/typecheck 命令)。

## 2. 已交付地基(可复用 seam,PR-C 直接用)
- **设置外壳**:`SettingsPageContainer`(`max-w-3xl`,`apps/web/src/components/settings/settingsLayout.tsx:122`)/ `SettingsSection`(`:18`)/ `SettingsRow`(`:48`)/ `SettingResetButton`(`:98`);左栏「飞书」导航项已存在(`SettingsSidebarNav.tsx:45`,path `/settings/feishu`)。
- **抽屉组件(抽屉化用)**:`RightPanelSheet`(`apps/web/src/components/RightPanelSheet.tsx:6`,宽 `RIGHT_PANEL_SHEET_CLASS_NAME = w-[min(42vw,28rem)] min-w-80 max-w-[28rem]`,`rightPanelLayout.ts:2`);底层 `Sheet`/`SheetPopup`(`ui/sheet.tsx:9/:60`,`side="right"` 默认,`SheetHeader/Footer/Title/Panel :112/:125/:147/:167`,backdrop `:21`)。
- **现有飞书编辑器**(`apps/web/src/components/settings/FeishuSettings.tsx`,572 行):`FeishuSettingsPanel :45` / `FeishuBindingSection :62`(已绑定 3 行:appId `:90` / tenant `:96` / ownerOpenId `:102`)/ `FeishuChatConfigSection :220`(读群 `feishuListChats :222`、读 `feishuChatConfigs :226`、读 owner `:229`、`writeConfigs :231`、`commitChat :236`、p2p 过滤 `:245`)/ `FeishuDefaultsEditor :301` / `FeishuChatConfigCard :344` / `ModeSelect :394` / `ApproversEditor :438` / 内联 `useOptimisticSetting :186`。
- **纯逻辑**(`FeishuSettings.logic.ts`,155 行):`normalizeConfig :81`(picker==bot)/ `writeChatConfig :122`(整值替换,drop-empty `:128`)/ `isChatConfigEmpty :94`(检查 approvalMode/approvers/workspaces`:97`/commands`:98`/toolPolicy`:99`)/ `deepEqual :51` / setter 群。
- **数据回路**:整值替换 `applyServerSettingsPatch`(`packages/shared/src/serverSettings.ts:74`,feishuChatConfigs `:91-93` / feishuChatDefaults `:94-96` 特判整值替换非 deepMerge)+ web 提交 `useUpdatePrimarySettings`(`apps/web/src/hooks/useSettings.ts:278`)→ `persistServerSettings`(`:244`)。**新字段作为 `FeishuChatConfig` 内部字段,自动随整值替换流过,无需改 patch 层。**
- **可选项数据源**:projects `useProjects()`(`apps/web/src/state/entities.ts:104`)→ `projectsAtom`(`packages/client-runtime/src/state/projectEntities.ts:85`),字段 `OrchestrationProjectShell.{id`:379`/title`:380`/workspaceRoot`:381`}`(`contracts/orchestration.ts`);群+成员 `feishuListChats`(`contracts/rpc.ts:238`)→ `FeishuChatDirectoryEntry.{chatId/name/chatMode/members/ownerOpenId}`(`contracts/feishu.ts:124`)+ `FeishuChatMember.{openId:118/name:119}`。
- **契约 `FeishuChatConfig`**(`packages/contracts/src/settings.ts:375-394`):approvalMode`:379`/approvers`:381`/workspaces`:383`/commands`:385`/toolPolicy`:388`;`feishuChatConfigs :471` / `feishuChatDefaults :476`;**无 density 字段**(§3.3 要加)。

## 3. PR-C 范围(按可独立性 + 设计定稿拆)

三块,**按依赖递增**。可拆多个 PR(见 §4),也可合一个大 PR;推荐至少把「density 契约+bot 迁读」与「纯 web 编辑器」分开(前者跨端、后者 web-only)。

### 3.1 web 编辑器:commands + workspaces(纯 web,消费 PR-A 已接的 bot 侧)
PR-A 已让 bot 消费 `commands`/`workspaces`(手编 settings.json 生效),PR-C 补 web 编辑器,让其可视化配置。
- **commands 编辑器**:勾选本群可用斜杠命令。语义(对齐 bot `authorizeCommand`,PR-A):`undefined`=全放行、`[]`=仅 floor、名单=floor+勾选项。UI 要点(设计定稿):floor 命令(`/help`/`/whoami`)锁定可见不可关(防自锁),owner 豁免脚注**已按设计弱化**(不加,只私聊说一次)。
  - **⚠ 命令全集数据源需新建(唯一跨包缺口)**:`HELP_SECTIONS`(`apps/feishu-bot/src/bridge/commands/handlers.ts:59`)/ `COMMAND_FLOOR`(`authz.ts:84`)在 `apps/feishu-bot`,web 无法 import(独立进程/包)。**推荐:提升命令清单到 `packages/contracts`**(建单一 command registry:可白名单命令 `["/workspace","/resume","/status","/release"]` + floor `["/help","/whoami"]`),web 与 bot 都从 contracts 引用(消除「web 镜像漂移」风险);次选:web 硬编码镜像常量(标注需与 bot 同步)。
- **workspaces 编辑器**:`useProjects()` 列 project 勾选,存 `ProjectId`(`project.id`),展示用 `title`+`workspaceRoot`。语义(对齐 bot `isWorkspaceAuthorized`,PR-A):`undefined`=全授权、名单=∩。
- **落点**:两者作为 `FeishuChatConfigCard`(`:344`)展开体里新增的维度行,复用 `commitChat`/`writeChatConfig`;新增纯 setter(`setConfigCommands`/`setConfigWorkspaces` 之类)于 `FeishuSettings.logic.ts`,复用 `normalizeConfig`/drop-empty。

### 3.2 抽屉化 + 私聊平铺 + 默认配置基线条目(设计定稿结构)
把现状(全在 `SettingsPageContainer` 列表内联)重构成定稿信息架构(设计文档 §2):
- **抽屉化**:把 `FeishuChatConfigCard`(`:344`)的展开体(ModeSelect + ApproversEditor + 新的 commands/workspaces/density 维度)移入 `RightPanelSheet`(`:6`),群行点击滑出。纯逻辑/`useOptimisticSetting`/`commitChat` 回路不改(Explore 已确认)。
- **默认配置基线条目**:删独立 `FeishuDefaultsEditor` 作为独立 section 的形态,改成「群聊」section 顶部一个带「基线」badge 的条目(与群列表用分隔区隔,非列表行),点开抽屉编辑 `feishuChatDefaults`(defaults 抽屉无「继承」选项,每维显式值)。
- **私聊上移平铺**:私聊单列 section(在绑定之后、群聊之前),`SettingsRow` 右侧直接放 density segmented(就地改,不走抽屉);一句 owner-always 说明(唯一解释处)。当前 `FeishuChatConfigSection` p2p 过滤在 `:245`(`chat.chatMode !== "p2p"`)——私聊要单独取出渲染。
- **静息态干净**:无覆盖群列表行只显一行灰字(继承到的真实生效值),不铺控件。生效值解析**必须复用** bot 语义(见 §5 红线)。
- **owner-always 弱化**:审批维度不出现 owner 护栏轨道;生效预览卡不加「授权人,始终」;不加各维度 owner 豁免脚注。

### 3.3 density 契约字段 + 编辑器 + bot 迁读(跨契约+bot,建议单列)
- **契约**:`FeishuChatConfig`(`settings.ts:375`)加 `density: Schema.optional(Schema.Literals(["card","markdown","text"]))`(镜像 `RenderDensity`,`eventRenderer.ts:63`)。`ServerSettingsPatch` 无需改(整体引用 `FeishuChatConfig`)。
- **⚠ web 一致性硬约束**:`isChatConfigEmpty`(`logic.ts:94`)**必须加 `config.density === undefined` 判断**,否则「只设 density」的 entry 被 `writeChatConfig` drop-empty 误删(Explore 点出的坑)。
- **web 编辑器**:群抽屉里加 density segmented 维度;私聊 section 平铺 density(§3.2)。
- **bot 迁读(⚠ 审查纠正:不止占位卡两处,是全部 8 个渲染点)**:`effectiveChatConfig`(`apps/feishu-bot/src/bridge/chatConfig.ts:38`,接口 `EffectiveChatConfig :24`)加 `density` 字段(`pick("density")`)。**关键坑**:`bot.ts:2081-2082`/`:2172` 只是**占位卡首帧**(注释 `:2075-2077` 明说 placeholder 首帧只为匹配 real frame),真正渲染**可见卡**的点全部就地重算 `densityForRuntime(thread.runtimeMode, groupChatDensity)` 且**不读 per-chat**——只迁占位两处,per-chat density 会「闪一帧随即被 densityForRuntime 覆盖」,§6 e2e 必失败。**必须统一全部 8 个 `densityForRuntime` 渲染调用点**:审批卡 `:1522`、streaming `:1848`、final `:1900`(后两者在共享 `renderObservationToCard` 内,签名 `:1744` 当前**无 density 参**)、echo `:3344`、M18 恢复 `:3632`、bind-time 存 `:2600`/`:2702`、占位 `:2081`/`:2172`。
  - **推荐做法**:抽一个 `resolveDensity(chatId, runtimeMode)` 助手 = `effectiveChatConfig(chatId).density ?? binding?.density ?? densityForRuntime(runtimeMode, groupChatDensity)`,把上述 8 处 `densityForRuntime(...runtimeMode, groupChatDensity)` 统一替换为 `resolveDensity(chatId, ...runtimeMode)`;`renderObservationToCard`(`:1744`)**加一个 density 参**(或在其内部按 chatId 解析),由三处调用点(`:2049/:2107/:2201`)传入。bind-time `:2600/:2702` 把 `binding.density` 存成 `resolveDensity(...)` 以保占位首帧与 real frame 恒等(否则又闪)。
  - env 兜底(`config.ts:274`)+ scrub(`FeishuBotManager.ts:168`)保留不动。**动机**:server 托管 bot spawn scrub 了 `FEISHU_GROUP_CHAT_DENSITY` → env 路已死,web 是唯一控制面。
  - ⚠ **施工前必用 Explore 重扫全仓 `grep -n densityForRuntime apps/feishu-bot/src/bot.ts`**,确认渲染调用点清单完整(本 kickoff 列的 8 处已核实但代码会演进),漏一处该处的卡就无视 per-chat density。
- **键粒度**:`effectiveChatConfig` 键 = **bare chatId**(与 PR-A/PR-B 一致,别用 composite chatKey)。

### 3.4 绑定区改进(bot 名字/头像 + owner 名字,可独立小 PR)
现状绑定区只显 appId/tenant/ownerOpenId 三裸行(`FeishuSettings.tsx:90-105`)。设计定稿要显示 bot 名字/头像 + owner 名字。分层(见 memory `feishu-bridge-binding-display-facts`):
- **owner 名字(零后端改动,先做)**:web 已有 `feishuListChats` members,按 `feishuBinding.ownerOpenId` 反查 `FeishuChatMember.name`(`feishu.ts:119`)显示。owner 不在任何群则回退 openId。
- **bot 名字(需接线)**:`FeishuBotCredentials`(`feishu.ts:88`)与绑定事件(`:50`)都不带 name/avatar。bot 名字现在只从收到的 @mention 文本白拿即弃(`lark/channel.ts:208`),未持久化/上报。需 bot 经 Feishu API(bot/v3/info,tenant token 无需 scope)取 bot 名字/头像 → 上报 server → 扩 `getFeishuBotCredentials`(`serverSettings.ts:209`)或新增 profile RPC。
- **owner 头像**:唯一需加 `contact:user.base:readonly` scope + 重新绑定的项,**可暂缓**(⚠ 文档谎报已配,实为 `binding.ts:89` 只有 im scope)。
- **建议**:owner 名字(白得)+ bot 名字/头像(接线)先做;owner 头像单独决策。此块与 3.1-3.3 解耦,可独立小 PR 先行或最后收尾。

## 4. PR 拆分建议
承 PR2b→PR2c「bot 先、web 后」与本 milestone 节奏。推荐拆法(可调):
- **PR-C1(纯 web,最小先行)**:commands + workspaces 编辑器(§3.1)+ 命令清单提升到 contracts。手编 settings.json 已验 bot 侧,web 只加 UI。
- **PR-C2(结构)**:抽屉化 + 私聊平铺 + 默认配置基线条目(§3.2)。纯 web 重构,叠在 C1 上。
- **PR-C3(density 跨端)**:契约加字段 + web density 编辑器 + bot 迁读(§3.3)。跨 contracts/web/bot。
- **PR-C4(绑定区)**:owner 名字 + bot 名字/头像(§3.4)。可与上面并行或最后。
- **替代**:C1+C2 合并(编辑器与抽屉化同 PR 闭环);density 与绑定区各自独立。每 PR:实现 → workflow 多维对抗审查 → 修 → 用户确认 commit/PR → 真连接 e2e → 合入。每 PR 合入前各包 typecheck + `pnpm exec vp check <改动子目录>` + `pnpm exec vp test run <改动子目录>` 必过(失败先 `vp fmt`)。

## 5. 红线(不可弱化)
- **所见=所判(承 PR2c 核心)**:web 编辑器展示的生效值 / picker 选择,必须与 bot 强制执行一致——复用 `normalizeConfig`(`logic.ts:81`)+ 忠于 bot 的 `effectiveChatConfig` 三级 fallback 语义,**前端绝不重写一份 fallback**(静息态灰字生效值、生效预览卡尤其)。`FeishuSettings.logic.ts` 注释已立此约束。
- **水合坑**:设置编辑器渲染实时 atom 值 + `useOptimisticSetting` 乐观 overlay,**别** `useState(()=>atomValue)` seed-once 冻结(硬刷新丢显示,详见 memory `t3-web-settings-editor-hydration-pitfall`)。
- **整值替换语义**:web 每次发全量 `feishuChatConfigs`/`feishuChatDefaults`(省略 chat=删、省略字段=清);新字段随整值替换流过,**不改 `applyServerSettingsPatch`**。
- **drop-empty 一致性**:契约 `FeishuChatConfig` 字段集与 `isChatConfigEmpty`(`logic.ts:94`)**必须同步**——加 density 时两处都改,否则只设 density 的 entry 被误删。
- **命令清单单一真相**:命令全集提升到 contracts 后,bot 与 web 都从 contracts 引用;若走 web 镜像必须标注同步义务(防漂移)。
- **bot 侧红线不碰**:PR-A/PR-B 的 authz(`bridge/authz.ts`)、callbackAuth 字节级、payload.o 承重件、键粒度 bare chatId、density 迁读只加 per-chat 优先级不动 env/scrub。
- **不做 toolPolicy 编辑器**(PR-B 暂缓);契约 toolPolicy 字段保留不动。
- **绑定区**:bot 名字/头像接线不得改绑定流程红线(env scrub 7 键、`toBindingIdentity` 不掺 owner、appSecret 只存 ServerSecretStore);owner 头像加 scope 需独立决策(涉及重绑)。
- **设计定稿是约束**:owner-always 弱化 / 私聊平铺 / 默认配置基线条目 / 抽屉 / 静息态干净——不擅自回退成旧形态。

## 6. e2e runbook(真连接)
- **可复用环境**:home `/Users/lizhipeng/.t3-feishu-m0`(已 binding + provisioned app 含 `im:chat:readonly` + web 登录态)。起 server:`T3CODE_HOME=/Users/lizhipeng/.t3-feishu-m0 T3CODE_PORT=3773 node apps/server/src/bin.ts serve`;bot 由 server-managed 自动 spawn;浏览器 pairing `node apps/server/src/bin.ts auth pairing create --base-dir <HOME> --base-url http://localhost:3773`,**浏览器认证走 3773**。**⚠ 本 PR 是 web 改动,必须 `cd apps/web && pnpm exec vp build` rebuild dist 后再测**(3773 静态服务 dist)。细节见 memory `feishu-bridge-e2e-pairing-token`。
- **验证点**:
  - **commands 编辑器**:web 配 `commands:["/status"]` → 飞书群 `/workspace` 被拒有回执、`/status` 通、`/help`/`/whoami` floor 始终可用;web 显示与 bot 判定一致。
  - **workspaces 编辑器**:web 配 `workspaces:[projA]` → 群内 `list` 只见 projA、越权 switch 拒;硬刷新 web 保值(水合坑回归)。
  - **density**:web 群配 density=text → 该群 bot 卡片降级为 text;私聊平铺改 density 生效;defaults density 对未覆盖群生效;托管 bot(env scrub)下 web 是唯一控制面能改动密度。**⚠ 必须验「稳定终态」而非首帧**:因占位卡首帧曾用别的 density 源(§3.3),要确认卡片跑完流式后**稳定停在 text**、不是「闪一下 text 又回 card」(后者=漏迁 `renderObservationToCard`/审批卡渲染点);并单独验**审批卡**(`:1522` 路径)也走 text。
  - **抽屉 + 结构**:点群滑出抽屉编辑、默认配置基线条目开抽屉、私聊平铺密度就地改;静息态干净群显真实继承值;所见=所判(编辑器所选=bot 所判)。
  - **绑定区**:显示 owner 名字(群名录反查)、bot 名字/头像(若本 PR 含)。
- **收口**:kill server;home 保留;settings.json 复原干净基线。

## 7. 待确认(实现中定或问用户)
- **命令清单提升 contracts vs web 镜像**:推荐提升到 contracts 建单一 registry(消除漂移);若嫌动 contracts 面大可先 web 镜像 + 标注同步义务。
- **PR 拆分粒度**:C1/C2/C3/C4 四拆(推荐)vs C1+C2 合;density 与绑定区独立。
- **绑定区做到哪层**:owner 名字(白得)+ bot 名字/头像(接线)必做?owner 头像(加 scope+重绑)本 PR 做还是暂缓(建议暂缓)。
- **批量套用 / 审计条 / 覆盖指纹**:设计稿画了但属规模化重装备,首版是否纳入还是后置(建议首版先做单群编辑器+私聊+默认基线,规模化后置)。
- **默认配置基线条目的抽屉 vs 内联**:defaults 走抽屉(与群一致)还是保留内联编辑(现状 `FeishuDefaultsEditor`)——设计定稿倾向抽屉一致,实现中定。
- **危险命令二次确认(明确后置,非遗漏)**:上级 consume-kickoff §3.4/§5I 曾把「危险命令二次确认(`/workspace add`、`/resume` 跨会话)」与 density 并列为首版推荐项。**本 PR-C 只落 density,该项后置**——它是纯 bot handler 行为(几无 web 成分)、不在设计定稿或用户拍板 8 决策内,与本 PR「web 编辑器」主题不同层;留待后续独立 bot-side 小项(或并入某 bot PR)。此处显式标注避免被误判为遗漏。

## 8. 委派 / 闭环
- **Explore/Plan**(只读,file:line + 结论):动手前复核 §2 各 seam(尤其 `FeishuSettings.tsx` 编辑器结构 / `logic.ts` 纯函数 / `Sheet`/`RightPanelSheet` / `settingsLayout` 外壳 / 命令清单跨包缺口 / 绑定 credential 契约)。**⚠ density 迁读点务必 `grep -n densityForRuntime apps/feishu-bot/src/bot.ts` 扫全 8 处渲染调用点**(§3.3 已列但代码会演进),别只迁占位卡 `:2081/2172`——真正的可见卡在 `renderObservationToCard`(`:1848/1900`)与审批卡(`:1522`)就地重算。
- **Test**:`pnpm --filter @t3tools/web run typecheck`、contracts/shared/feishu-bot typecheck、`pnpm exec vp check`(改动子目录)、单测(`FeishuSettings.logic` 的 setter/normalizeConfig/isChatConfigEmpty 含 density / effectiveChatConfig density 贯穿 / 命令清单 registry)。
- **Review**:多维 + 对抗(**用 Workflow**,见 `review-fanout-prefer-workflow`;维度见下必审规则)。

## 【kickoff 必审 · 自传播规则】
本设计文档交付前**必须**多维对抗审查(**优先 Workflow**,`review-fanout-prefer-workflow`):① **代码事实**——file:line 逐条对真实 main(`caf32408`)核验(尤其 `FeishuSettings.tsx` 编辑器结构 / `FeishuSettings.logic.ts` `normalizeConfig`/`writeChatConfig`/`isChatConfigEmpty` / 契约 `FeishuChatConfig` 字段集无 density / 整值替换 `serverSettings.ts:91-96` / `useProjects`/`feishuListChats` 数据源 / 命令清单在 `apps/feishu-bot` 的跨包缺口 / density 迁读点 `bot.ts:2081/2172` + `effectiveChatConfig` / 抽屉 `Sheet`/`RightPanelSheet` / 绑定 credential `feishu.ts:88` 不带 name/avatar);② **范围完整**——对照设计定稿 `feishu-settings-page-design.md` 与用户拍板 8 决策无遗漏无误分类,**toolPolicy 编辑器确未纳入(PR-B 暂缓)、owner-always 弱化 / 私聊平铺 / 默认配置基线条目 / 抽屉化 / density 加字段 五项设计决策都落到范围**,drop-empty 一致性坑(density 加 `isChatConfigEmpty`)与命令清单单一真相已点明,**density 迁读覆盖全部 8 个渲染点(非只占位卡 `:2081/2172`,含 `renderObservationToCard` 与审批卡)**,上级 §3.4 未落项(危险命令二次确认)已显式标后置(§7)非静默丢弃;③ **自包含**——memory/文档引用真实(设计定稿 / 绑定事实 / 水合坑 / pairing token)、runbook 可执行(web 改动先 rebuild dist)、红线齐全(所见=所判 / 水合坑 / 整值替换 / drop-empty 同步 / 键粒度 bare chatId / 不做 toolPolicy / 绑定流程红线 / 设计定稿约束)、待确认项已在 §7 点明。修掉阻断项再交付,并把**本规则原样写进**衍生的下一里程碑 kickoff。
