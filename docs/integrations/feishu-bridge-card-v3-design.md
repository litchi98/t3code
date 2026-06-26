# 飞书 Bridge 卡片渲染 v3 设计方案(M2b-4)

> 状态:**待用户确认**。本文是 M2b-4 里程碑(卡片布局/交互第三次重构,全面向 web 靠拢)的设计载体,实现与 review 均参照本文。
> 取向(用户 2026-06-25 拍板):**全面向 web 信息架构靠拢,不被 v2 现状束缚**;统一活动流;新增 Plan 面板 + Changed files 摘要;密度三档继续留 seam 给 M3。

---

## 0. 一句话目标

把飞书卡片从 v2 的「正文 + 🧠子任务面板 + 🔧工具面板 分立」重排为**以 web 信息架构为蓝本的状态化单卡**:正文 + 统一活动流(工具/子任务混排,当前一步可见 + 历史单层折叠)+ Plan 面板 + Changed files 摘要 + 交互区,并按 turn 状态(running/done/error/interrupted/awaiting)切换布局与文案。

---

## 1. 调研结论(五路 Explore,已实证)

### 1A. web 的信息架构(借鉴蓝本)
- web 是一条**线性时间线**:历史 turn 折叠成「Worked for Xs」单行;当前 turn = 正文(assistant commentary)+ **统一 work log**(工具调用 + `task.*` 子任务**混排**,默认只显最新 1 条 `MAX_VISIBLE_WORK_LOG_ENTRIES=1`,其余折进「+N previous tool calls」)。
- **没有模型 reasoning 面板、没有 token 统计面板**。web 的「thinking」只有:(a) composer 的 `thinking On/Off` 发送前开关;(b) `task.progress` 活动作为 work log 里一条 `tone:"thinking"` 普通条目(BotIcon,不可展开,turn 完成随之折叠)。→ **印证 memory 纠错:v3 不渲模型 reasoning(核心层丢弃,另立项),「思考」= 子任务进度。**
- **Plan**(web 独有侧边栏 `PlanSidebar`):`turn.plan.updated`(TodoWrite)→ `deriveActivePlanState` → 步骤列表(✅completed / 🔄inProgress / ⬜pending)。
- **Changed files**(assistant 消息下 `AssistantChangedFilesSection`):「Changed files (N)」+ 各文件 +/- 行 + 「View diff」侧栏。
- **状态机**:`ThreadSession.status` ∈ {`starting`,`running`,`stopped`,`interrupted`,`error`};`activeTurnId`;`latestTurn.{startedAt,completedAt,state}`。settled = startedAt && completedAt && status≠running。

### 1B. 飞书 CardKit 2.0 约束(硬边界)
- **不做两层嵌套折叠**(panel 套 panel):虽 5 层嵌套合规,但三重风险——① 稳定性(checkbox 前车之鉴:未明文禁止≠稳定);② **30KB per-element 炸弹**(外层 panel 序列化把所有内层内容计入**同一 element** 体积);③ 官方明确建议避免多层嵌套。
- **推荐结构**:每个折叠区是**独立单层** `collapsible_panel`(各受独立 30KB 保护),内部多行 markdown;活动流靠**多个独立 panel/element 线性平铺**,层次用 header `icon`/`icon_expanded_angle`(展开旋转)/`background_color`/`vertical_spacing` 表达。
- 结构上限:element 总数 **200**(充裕)、嵌套 **5 层**、单 element **~30KB**。`form` 不能嵌进 collapsible_panel(对我们无影响)。
- **计时器**:飞书整卡 patch + 限流,**不能秒级刷新**。→ RUNNING 用静态「处理中…」;DONE/INTERRUPTED 用 server 的 `completedAt-startedAt` 一次性填「用时 Xs」。

### 1C. 现 v2 结构(演进基线)
- `renderThreadCard(thread, opts)` 纯函数,`opts = {streaming, currentTurnId, interaction?, density?, chrome?, maxElementBytes?}`;7 分区;`currentTurnId ?? activeTurnId` turn 作用域;`clampElement` 30KB hard guard(就地降级不 abort);chrome 开关;density seam(三值 fall-through card)。
- 两条渲染路径:`driveTurn`(自驱)+ `runObserveFiber`→`renderObservationToCard`(纯观察),**共用** `renderThreadCard`。
- `interactionCard.ts`:approval 按钮 + user-input 统一表单(select_static/multi_select_static/input)+ `renderInteractionSection`。

### 1D. client-runtime 可复用面
- **继续复用**(已正确):`derivePendingApprovals`/`derivePendingUserInputs`/`isStalePendingRequestFailureDetail`(子路径 `@t3tools/client-runtime/state/thread-activity`)。
- 工具聚合三套实现各异;**v3 沿用已语义正确的 v2 `aggregateToolActivities`**(不动 web/mobile,避免跨包风险),扩展为「把 `task.*` 也并入统一活动流」。
- `compareActivitiesByOrder` 四处重复未导出 → 若 v3 活动流需排序,**低风险**地把它加入 `./state/thread-activity` 导出(不改语义)。
- Plan 派生:web `deriveActivePlanState` 在 `session-logic.ts`(未导出、耦合 React)→ v3 在 bridge 自写轻量 `derivePlanSteps(turn.plan.updated payload)`(标注未来可抽共享)。
- `deriveWorkLogEntries`/`deriveTimelineEntries`/`derivePendingUserInputProgress`/mobile feed = React/web-only,**信息架构可借鉴,代码不可 import**。

---

## 2. v3 信息架构(分区与顺序)

整卡纵向分区(top→bottom),每个分区都是独立 element / 单层 panel:

| # | 分区 | 触发条件 | 对应 web |
|---|---|---|---|
| 1 | **Header**(`🧵 标题` + runtime badge) | chrome≠false | thread 标题 |
| 2 | **Subtitle**(`📁 ws · 🌿 branch · 🔒 mode`) | chrome≠false | thread meta |
| 3 | **错误 banner**(`⚠️ {lastError}`) | `session.lastError` 非空 | ThreadErrorBanner(顶部) |
| 4 | **正文**(assistant 最新文本,markdown) | 本轮有 assistant 文本 | AssistantTimelineRow |
| 5 | **状态行**(处理中/完成/已停止 + 用时) | 见状态表 | WorkingTimelineRow / TurnFold |
| 6 | **统一活动流**(当前一步可见 + 历史单层折叠) | 本轮有 tool/task 活动 | WorkGroupSection(work log) |
| 7 | **Plan 面板**(`📋 计划 (X/N)` 折叠,步骤列表) | 本轮有 `turn.plan.updated` | PlanSidebar |
| 8 | **Changed files**(`📝 改动 N 文件 (+X -Y)` 折叠) | 本轮有 file_change 活动 | AssistantChangedFilesSection |
| 9 | **交互区**(approval 按钮 / user-input 表单 / resolved 回显) | pending/resolved 存在 | composer 顶部面板 |

**取消 v2 的独立 error footer**:turn 内 `tone:"error"` 活动**融入活动流**(那一步标 ✗),只有 `session.lastError` 走顶部 banner——对齐 web(失败工具在 work log 标红 + session 错误顶部 banner)。

---

## 3. 统一活动流设计(v3 核心)

把 v2 的「🧠子任务 + 🔧工具」两个分立面板**合并为一条统一活动流**(对齐 web work log):

### 3.1 数据
- 输入:本轮(`currentTurnId` 过滤)的 `tool.*` + `task.*` 活动,经 `aggregateToolActivities` 扩展版聚合(tool 按 key 取最新 phase;task.progress/completed 作为条目并入,task.started 过滤——对齐 web)。
- 每条目:`{icon, label, detail, status}`,status ∈ {success ✓, failure ✗, inProgress ⏳, thinking 🧠}。

### 3.2 布局(RUNNING)
```
🔧 正在 Edit `src/auth.ts`            ← 当前/最新一步,markdown 单行,始终可见
▸ 之前 5 步 (4✓ 1✗)                   ← 单层 collapsible_panel,默认折叠
   ✓ Read src/auth.ts
   ✓ Grep "login"
   🧠 规划修复方案
   ✓ Bash npm test
   ✗ Edit config.ts — file not found
```
- **当前一步**:取活动流最后一条,单行 markdown(`{icon} 正在 {label}`),**始终可见**(对齐 web「最新 1 条」)。
- **历史**:单层 `collapsible_panel`,header `▸ 之前 N 步 (X✓ Y✗)`,默认 `expanded:false`;panel 内每步一行 markdown,detail 内联截断(`TOOL_DETAIL_MAX_CHARS`,diff 类用 overflow hint)。**不再嵌套折叠每步详情**(30KB 炸弹)。

### 3.3 布局(DONE)
整条活动流可折叠成一个摘要(对齐 web TurnFold):
```
▸ 已完成 · 8 步 (7✓ 1✗)              ← collapsible_panel header,默认折叠
   (展开后:全部步骤 + 各自 detail)
```

### 3.4 字节/数量
- 活动流 = 1 个「当前步」markdown element + 1 个「历史」panel element,各受独立 30KB clamp。
- 历史步骤过多时,panel 内 markdown 整体走 `trimToBytes`(已有);极端情况下顶部保留计数、底部截断提示。

---

## 4. 状态化布局(七状态对照)

飞书侧从 `thread.session.status` + `latestTurn.{startedAt,completedAt,state}` + `derivePendingApprovals/UserInputs` 判定状态(v3 新增的状态感知;v2 仅靠 `streaming` 标志 + `activeTurnId`)。

| 状态 | 正文 | 状态行 | 活动流 | Plan | Changed | 交互区 | Banner |
|---|---|---|---|---|---|---|---|
| **RUNNING** | 流式/空 | `⏳ 处理中…` | 当前步可见 + 历史折叠 | inProgress→展开 | —(turn 中一般空) | pending 则显示 | — |
| **DONE** | 最终正文 | `✅ 完成 · 用时 {X}` | 折叠成「已完成·N步」 | 折叠 | `📝 改动 N 文件` | resolved 回显 | — |
| **ERROR** | 正文(若有) | —(无 working) | 失败步标 ✗ | 折叠 | 部分 | — | `⚠️ {error}` |
| **INTERRUPTED** | 正文 | `⏹️ 已停止 · 用时 {X}` | 折叠(可展开看中断前) | 折叠 | 部分 | — | — |
| **AWAITING-APPROVAL** | 正文(若有) | `⏳ 处理中…` | 当前步可见 | — | — | `⚠️ 需批准` + 按钮 | — |
| **AWAITING-USER-INPUT** | 正文 | `⏳ 处理中…` | 当前步 | — | — | 统一表单 | — |
| **IDLE / 通知卡** | — | — | — | — | — | — | chrome=false 文本卡 |

> 注:approval/user-input 期间 turn 仍 running(web 同此),故状态行仍「处理中…」。

---

## 5. Plan 面板(新增,对齐 PlanSidebar)

- 数据:`turn.plan.updated` 的 `payload.plan[].{step, status}` → `derivePlanSteps`(bridge 自写)。**对齐 web 跨 turn 持久**:取本轮最新一条,本轮无则回退全 thread 最近一条(TodoWrite 计划跨 follow-up 不丢失;§9#4 已定)。
- 渲染:`collapsible_panel` header `📋 计划 (已完成/总数)`;panel 内每步一行:
  - `✅ {step}`(completed)/ `🔄 {step}`(inProgress,对齐 web 蓝色 spin)/ `⬜ {step}`(pending)。
- 展开策略:RUNNING 且有 inProgress 步 → `expanded:true`;DONE → 折叠。
- 无 `turn.plan.updated` → 不渲该区(对齐 web「No active plan」不占位)。

---

## 6. Changed files 摘要(新增,对齐 AssistantChangedFilesSection)

- 数据:本轮 file_change/diff 类活动聚合 changed files(路径 + 增删行数,从活动 payload 提取——实现时核对 payload 结构)。
- 渲染:`collapsible_panel` header `📝 改动 N 文件 (+X -Y)`;panel 内每文件一行 `{path}  (+a -b)`;底部 `详见终端 / Web 查看 diff`(飞书无 diff panel)。
- **仅终态(DONE/INTERRUPTED/ERROR,非 RUNNING)显示**(对齐 web 完成后才显示 + 避免与活动流里 file_change 步重复;§9#4 已定)。
- **不渲 diff 正文**(飞书无 diff 组件 + 30KB);v2 把大 diff 塞工具 detail 的做法被本区取代。

---

## 7. 文案对照表(web 英文 → 飞书 v3 中文)

| web 原文 | 飞书 v3 | 出处 |
|---|---|---|
| `Working for {Xs}` / `Working...` | `⏳ 处理中…`(不秒级刷) | 状态行 RUNNING |
| `Worked for {duration}` / `Worked` | `✅ 完成 · 用时 {X}` / `✅ 完成` | 状态行 DONE |
| `You stopped after {duration}` / `You stopped this response` | `⏹️ 已停止 · 用时 {X}` / `⏹️ 已停止` | 状态行 INTERRUPTED |
| `+N previous tool calls` | `▸ 之前 N 步` | 活动流历史折叠 header |
| `Completed` / `Failed` / `Empty` | `✓` / `✗` / `⏳` | 活动条目状态 |
| `PENDING APPROVAL` | `⚠️ 需批准` | 交互区 approval |
| `Command/File-read/File-change approval requested` | `命令审批` / `文件读取审批` / `文件修改审批` | approval 类型 |
| `1/{N}` | `1/N` | 多条进度 |
| `Approve once` / `Decline` | `允许` / `拒绝` | approval 按钮 |
| `Always allow this session` | `本会话始终允许`(**待确认是否纳入**,见 §9) | approval 按钮 |
| `Changed files (N)` | `📝 改动 N 文件 (+X -Y)` | Changed files header |
| `(plan steps)` | `📋 计划 (X/N)` + `✅/🔄/⬜` | Plan 面板 |

---

## 8. 复用 / 契约 / 节流(硬约束保持)

- **契约保持**:`renderThreadCard(thread, opts)` 签名与 `opts` 字段不变;两条路径(driveTurn + observe `renderObservationToCard`)不变(纯重排 `renderThreadCard` 内部分区);`currentTurnId` turn 作用域过滤覆盖所有新区(正文/活动流/plan/changed);chrome 开关保持;density seam 保持(三值 fall-through card)。
- **复用**:interaction 继续 `derivePendingApprovals/UserInputs`;活动流沿用 v2 `aggregateToolActivities`(扩展并入 task.*);如需排序低风险导出 `compareActivitiesByOrder`。
- **节流**:沿用 M2b-3 `Queue.sliding(1)` + SDK throttle(实测够);v3 分区增多后用 e2e 复核体积/限流,**不预先引入新去抖**。
- **字节安全**:每区独立 element/panel,各走 `clampElement` 30KB;**绝不嵌套折叠**;element 总数估 10~15 远低于 200。
- **健壮性**:任何渲染/SDK 错误绝不崩进程(processGuard + 调用点 Effect.ignore/catchCause);绝无 checkbox;绝不动 callbackAuth/HMAC/nonce/turnQueue/processGuard。

---

## 9. 待用户确认的细节决策点

1. ~~approval 是否补「本会话始终允许」(acceptForSession)按钮?~~ **✅ 已确认纳入(用户 2026-06-25)**。approval 卡加第三个按钮「本会话始终允许」;接线 = callbackAuth payload `action` 枚举扩 `acceptForSession` 值(verify 不校验 a,a 受签名保护) + `interactionCard` 按钮组 + `bot.ts handleCardAction` 透传 `acceptForSession` decision 给 `respondToThreadApproval`。**绝不动 verify 校验项/HMAC 算法/nonce,只扩 action 路由。**
2. **状态行「用时」是否依赖 server 的 `latestTurn.startedAt/completedAt`?** 实现时核对该字段在飞书 thread 对象可得;若不可得则降级为不显示用时(仅 `✅ 完成`)。
3. **活动流 RUNNING 时历史默认折叠**(对齐 web 只显最新 1 条)—— 已定;如你想 RUNNING 时默认展开历史,请指出。
4. ~~Changed files 在 RUNNING 中是否显示~~ **✅ 已定:仅终态(DONE/INTERRUPTED/ERROR,非 RUNNING)显示**(对齐 web + 避免与活动流 file_change 步重复)。
5. ~~plan 是否本轮作用域~~ **✅ 已定:跨 turn 持久(对齐 web `deriveActivePlanState`)**——本轮无 plan 则回退全 thread 最近一条 `turn.plan.updated`,TodoWrite 计划跨 follow-up 不丢失。
6. ~~idle/never-run 会话状态行~~ **✅ 已定:never-run(latestTurn===null)不渲状态行**(既不假「⏳ 处理中…」也不假「✅ 完成」)。

---

## 10. 实现拆解(workflow 阶段,确认后执行)

主改 `apps/feishu-bot/src/bridge/eventRenderer.ts`(v2→v3 分区重排),`interactionCard.ts`(approval 类型文案 / 可选 acceptForSession 按钮),可能轻动 `bot.ts`(状态判定传入,若 renderThreadCard 需新 opts——尽量不改签名)。

1. **Scaffold(并行,文件级互斥)**:
   - eventRenderer:状态判定 helper + 统一活动流(当前步 + 历史单层折叠)+ 状态行 + 顶部 banner;`derivePlanSteps` + Plan 面板;Changed files 聚合 + 摘要面板。
   - interactionCard:approval 类型文案对齐 + (可选)acceptForSession 按钮。
   - client-runtime:(若需)导出 `compareActivitiesByOrder`。
2. **Integrate(单 agent 串行)**:bot.ts 接线(状态来源、两条路径验证),避免多 agent 同改枢纽文件(M2b-2/M2b-3 踩过)。
3. **Test**:`pnpm --filter @t3tools/feishu-bot run typecheck` + `pnpm exec vp check apps/feishu-bot`(+ 若动 client-runtime 则 web/mobile typecheck)全过;失败先 `vp fmt`。
4. **Review(workflow 多维对抗)**:正确性 / t3code 架构契约 / **30KB 字节降级 + 不崩进程** / **driveTurn + observe 两条路径都不破** / turn 作用域过滤 / 流式节流 / 健壮性 / **不嵌套折叠** / 状态判定正确。
5. **Fix** → 重跑 Test。
6. **Confirm**:真连接 e2e(沿用 M2b-3 runbook),在 web 起会触发思考/工具/子任务/长正文/计划/改文件的复杂 agentic turn,飞书 `/resume` 接管,肉眼对照 web 与飞书 v3 各状态贴近度。
