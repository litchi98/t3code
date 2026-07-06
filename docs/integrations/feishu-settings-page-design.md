# 飞书设置页设计文档(定稿)

> 定稿高保真稿:`docs/integrations/feishu-settings-mockup-v2.html`(t3code 风格 + overlay 右抽屉)。
> 设计过程:2026-07-03 用 Workflow 派 4 位独立 UI/UX 设计师(信息架构 / 渐进极简 / 效率规模 / 可用性安全)各自出方案 → 设计总监综合 → 用户逐条拍板 8 决策 → 贴合 t3code 真实设计系统重画 → 双栏 vs 抽屉实物对比 → **抽屉定稿** → 四处结构精修。
> 三版本地稿并存(仅 `-v2` 为定稿):`feishu-settings-mockup.html`(控制台风+双栏,初版被否)/ `-v1-t3code.html`(t3code 风+双栏)/ **`-v2.html`(t3code 风+右抽屉=定稿)**。

---

## 0. 这是什么 / 解决什么

t3code web 设置区新增「飞书」tab——bot 管理员在此配置飞书 bot 的 **per-chat 行为**。t3code 多端(web/移动/CLI/飞书 bot)共享同一后端会话;飞书 bot 让团队在飞书群 @机器人 驱动 coding agent 跑任务。

**痛点**:M-2 已把 per-chat 配置(审批三态 / 命令白名单 / workspace 授权 / density)做进契约与 bot 消费层,但 web 侧只有审批编辑器,其余字段只能手编 `settings.json`;绑定区只显示裸 id。本设计给出这一页的完整形态。

---

## 1. 核心设计原则(四位设计师收敛 + 总监综合)

1. **继承是默认,覆盖是例外 → 静息态干净**。每个群/私聊未单独配置则回退「默认配置」(契约 `feishuChatConfigs[chatId]?.X ?? feishuChatDefaults.X ?? 内置` 三级 fallback)。90% 群零配置,列表里收成一行安静灰字,**显示继承到的真实生效值(不藏值)**——消失的只是控件不是值,「看懂一个群」成本恒为扫几行灰字。
2. **默认基线 = 同类可编辑对象**。「默认配置」和每个群共用同一套维度编辑器 → 「继承」不是需要解释的概念,而是「同一编辑器的两个落点」,与数据模型 1:1(`feishuChatDefaults` + `feishuChatConfigs`)。
3. **来源可视,按尺度双轨**。列表尺度用轻信号(改过 / 纯继承)+ 覆盖指纹;详情尺度用三级来源标签 `[本群]/[默认]/[内置]`,精确镜像 fallback,让管理员知道继承来的值是「我的基线」还是「系统兜底」。
4. **权限呈现为「后果」而非「开关」**。三态审批每档配一句白话后果;顶部「生效预览卡」把继承后的最终态用人名/项数列出(**所见 = bot 所判**,强制复用 bot 的 `normalizeConfig`/`effectiveChatConfig`,前端绝不重写 fallback)。
5. **防脚枪**。危险选择即时弹后果(禁 `/workspace` = 本群跑不了任务;`designated` + 0 审批人 = 仅授权人可批「最紧一档」非「无人能批」;空 workspace = 谁都进不去)。**两种「空」语义相反**必须区分:空命令白名单 = 回退全部命令、空 workspace 白名单 = 谁都进不去。
6. **贴合 t3code**。视觉 1:1 用 t3code 真实设计系统(靛蓝 hue264 / hairline 极细边框 / 1px 顶部内高光 / `rounded-2xl` / DM Sans / `.dark` class 主题);主体是标准 `max-w-3xl` 设置页,不做宽双栏控制台。

---

## 2. 信息架构(定稿)

主体 = 标准 t3code 设置页(左侧栏「飞书」激活 + 右 `max-w-3xl` 内容),自上而下四个 `SettingsSection`:

```
① 飞书 Bot 绑定
   bot 头像 + 名字("t3code 机器人") · App cli_… (mono) · 授权人 [头像]张伟 · [管理绑定]
② 私聊 · 1                        ← 用户拍板:私聊上移、独立、平铺
   🔒 张伟 (owner)  ················· 密度 [卡片|Markdown|纯文本] segmented(就地可改,不走抽屉)
   说明:私聊仅授权人可用 —— 审批/命令/工作区由 owner-always 免配,仅密度可个性化
③ 群聊 · 41
   ┌ 默认配置 [基线]  所有群的默认基线 · 应用于 34 个未覆盖的群      [编辑默认]→抽屉 ┐  ← 置顶基线条目
   ├───────────────────────────────────────────────────────────────────────────┤
   │ 后端研发群   话题  ●●○○   指定审批人·3人 · 命令 4项              →抽屉        │  ← 覆盖群
   │ 前端项目群   继承默认 · 仅发起人                                  →抽屉        │  ← 干净群(一行灰字)
   │ …                                                                            │
   └───────────────────────────────────────────────────────────────────────────┘
```

**详情 = 右侧 overlay 抽屉**(点群行 / 点默认基线条目 / 点私聊「编辑」时滑出 `Sheet`):

```
┌ 后端研发群              [复制ID] ✕ ┐   ← 抽屉从右滑出 ≈28rem,背景变暗模糊
│ 话题群 · 32人 · oc_88…d1            │
│ ┌ 生效预览 ────────────────────┐   │   ← 复用 effectiveChatConfig 解析后的最终态
│ │ • 审批  指定审批人:李娜、王强 │   │
│ │ • 命令  4 项 + 基础            │   │
│ │ • 工作区 2 个已授权            │   │
│ │ • 密度  card(继承默认)       │   │
│ └──────────────────────────────┘   │
│ ▾ 审批 · 指定审批人·3人   [本群]⟲  │   ← 折叠维度网格,任一时刻只展开一维
│    ○仅发起人 ●指定审批人 ○任意成员 │
│    ☑李娜 ☑王强 ☐陈昊  +open_id    │   ← 审批维度里不再出现 owner
│ ▷ 命令 · 4项+基础         [本群]⟲  │
│ ▷ 工作区 · 2个已授权      [本群]⟲  │
│ ▷ 密度 · card             [默认]覆盖│
└────────────────────────────────────┘
```

**私聊特例(用户拍板)**:私聊只有 owner 能用,审批走 owner-always、命令/工作区对 owner 豁免 → **私聊只有「密度」一维有意义**,故在 section ② 平铺一个密度控件即可,不进抽屉、不显示其余维度。

**owner-always 呈现(用户拍板弱化)**:审批维度里不出现 owner 护栏轨道;生效预览卡不加「+授权人,始终」尾巴;各维度不加 owner 豁免脚注。**只在私聊 section 保留一句** owner-always 说明作为唯一解释处。

---

## 3. 用户拍板的决策(8 条 + 定稿修正)

| # | 决策 | 备注 |
|---|---|---|
| 1 | **density 加契约字段**(optional `FeishuChatConfig.density`)做成真 per-chat 维度 | server 托管 bot spawn scrub 了 `FEISHU_GROUP_CHAT_DENSITY` → env 路已死,web 是唯一控制面 |
| 2 | ~~详情常驻右栏~~ → **overlay 右抽屉** | 看双栏 vs 抽屉实物后翻转;复用 `Sheet`/`RightPanelSheet`,与 t3code 设置页范式一致 |
| 3 | **审计轴二元「松于默认」flag** | 非逐维三向评分(边界脆弱);toolPolicy 暂缓后更无需方向归一 |
| 4 | **配置体检 linter 延 v1.5** | v1 用可点⚠告警 |
| 5 | **配置剪贴板 / 另存基线收进行 ⋯ 菜单** | 不占主流程 |
| 6 | ~~接受双栏破 max-w-3xl~~ → **作废** | 改抽屉后主体回归标准 `max-w-3xl` |
| 7 | **批量套用跳过不匹配审批人 + 提示** | 跨群 open_id 不通用,原样写会灌无效审批人 |
| 8 | **私聊只显密度**(独立、上移、平铺) | 其余维度 owner-always 免配 |

**定稿四处结构精修**(在 v2 上逐条确认):① 私聊 section 上移到「绑定」之后、「群聊」之前;② 私聊平铺密度不走抽屉;③ 默认配置并入「群聊」section 顶部作基线条目(非独立 section、非列表行);④ owner-always 大幅弱化,只私聊处说一次。

---

## 4. 落地映射(→ M-3 PR-C 施工,file:line @ main `caf32408`)

> 详见配套 kickoff `feishu-bridge-m3-pr-c-web-editor-kickoff.md`。此处仅给设计→代码的对应关系。

**可复用 seam(直接用)**:
- 设置外壳:`SettingsPageContainer`(max-w-3xl,`settingsLayout.tsx:122`)/ `SettingsSection`(`:18`)/ `SettingsRow`(`:48`);左栏「飞书」导航项(`SettingsSidebarNav.tsx:45`)。
- 抽屉:`RightPanelSheet`(`RightPanelSheet.tsx:6`,≈28rem)或直接 `SheetPopup`(`sheet.tsx:60`)传更宽 className。
- 现有编辑器骨架:`FeishuSettings.tsx` 的 `FeishuChatConfigSection`(`:220`)/ `FeishuChatConfigCard`(`:344`)/ `ModeSelect`(`:394`)/ `ApproversEditor`(`:438`);纯逻辑 `FeishuSettings.logic.ts`(`normalizeConfig :81` / `writeChatConfig :122` / `isChatConfigEmpty :94`);`useOptimisticSetting`(`FeishuSettings.tsx:186`)。
- 数据回路:整值替换 `applyServerSettingsPatch`(`serverSettings.ts:91-96`)+ `useUpdatePrimarySettings`(`useSettings.ts:278`)——新字段自动随整值替换流过,无需改 patch 层。
- 可选项:projects `useProjects()`(`entities.ts:104`,存 `ProjectId`);群+成员 `feishuListChats`(`rpc.ts:238`)+ `FeishuChatMember.name`(`feishu.ts:119`)。

**需新建**:
- **commands 编辑器 UI** + **命令全集数据源**:`HELP_SECTIONS`(`handlers.ts:59`)/ `COMMAND_FLOOR`(`authz.ts:84`)在 `apps/feishu-bot`,web 无法 import → 提升到 `packages/contracts`(推荐,建单一 command registry)或 web 镜像。
- **workspaces 编辑器 UI**:`useProjects()` 列 project 勾选,存 `ProjectId`;体现 undefined=全授权。
- **density 契约字段 + 编辑器 + bot 迁读**:契约 `FeishuChatConfig` 加 `density`(`settings.ts:375`);`isChatConfigEmpty` 加 `density===undefined` 判断(否则只设 density 的 entry 被误删);web 加 density 控件;bot `effectiveChatConfig`(`chatConfig.ts:38` + 接口 `:24`)加 density,`bot.ts:2081/2172` 等读点从 `binding?.density ?? groupChatDensity` 迁到优先读 per-chat density。
- **绑定区 bot 名字/头像**:`FeishuBotCredentials`(`feishu.ts:88`)不带 name/avatar → 扩 `getFeishuBotCredentials`(`serverSettings.ts:209`)或新增 profile RPC(bot 名字/头像详见 memory `feishu-bridge-binding-display-facts`:bot 名字可白得、头像一次无 scope 调用、owner 名字走群名录反查、只 owner 头像需加 contact scope)。
- **抽屉化**:把 `FeishuChatConfigCard` 展开体移入 `Sheet`。
- **私聊平铺**:私聊单列 section,`SettingsRow` 右侧直接放 density segmented。

**toolPolicy 编辑器不在本设计范围**(随 PR-B toolPolicy 一起暂缓,见 `feishu-bridge-m3-pr-b-toolpolicy-kickoff.md` 🅿️)。

---

## 5. 未纳入首版(记录待后续)

- 规模化重装备:严格度逐维评分、配置体检 linter、配置剪贴板/另存基线(降级或延后,见决策 3/4/5)。
- 批量套用向导(逐维 tri-state + 写入前 before→after diff + 失败重试)——高保真稿画了(抽屉屏),但首版可后置;⚠ 写入是 fire-and-forget 无 echo,批量落地时须补每群写入回执/失败重试。
- 抽屉屏背后变暗剪影仍是旧结构(高保真稿的已知小瑕疵,不影响设计意图)。
