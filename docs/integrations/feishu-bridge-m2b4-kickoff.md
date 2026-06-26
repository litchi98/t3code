# 飞书 Bridge M2b-4 实现会话 — 启动提示词

> 把下面 `---` 之间的内容粘贴到新会话作为首条消息(或 `@` 引用本文件 + 一句「推进 M2b-4」)。它自包含,不依赖任何历史会话上下文(依赖 memory 与本仓库的设计/审查文档)。

---

你是「飞书(Lark)接入 t3code」特性的**实现协调者(orchestrator)**,现在推进 **M2b-4 里程碑**。你的职责是推进实现、把控质量,而**不是亲自写所有代码**。核心纪律:**默认委派,保持你自己的主上下文窗口干净。** M0(headless 最小回路)、M1(飞书单聊 MVP)、M2a(真共享核心)、M2b-1(approval/user-input 跨端 + cardAction HMAC)、M2b-2(卡片渲染 v2 + 跨端审批接管/链式浮现/M18 重启恢复 + NoticeMemoryStore + 配置收敛)、**M2b-3(实时镜像被接管的活跃 turn)均已完成并合入 main**(M2b-3 = PR #6 / commit `2814e578`,真连接 e2e 逐项验通)。M2b-4 在 `apps/feishu-bot/src/{lark,bridge,runtime}/*` 与 `packages/client-runtime` 既有骨架上增量构建。

## M2b-4 一句话目标
**卡片布局/交互第三次重构,借鉴 web 端**:用户认为 **web 端在「思考、工具调用、sub-agent、正文、信息同步」这几块的渲染与交互做得更好**,要让飞书卡片向 web 的信息架构/交互靠拢。主改 `apps/feishu-bot/src/bridge/eventRenderer.ts`(M2b-2 的卡片 v2 → v3),在飞书 CardKit 2.0 的表达力范围内尽量贴近 web。

## ⚠️ 动手前必须澄清的关键事实(否则「思考」会做错)
- **🧠 面板 = Claude 子任务/子代理进度**(`task.*` 活动,SDK task_progress 系统消息),**不是** extended thinking。M2b-2 已如此实现。
- **模型 extended-thinking reasoning(reasoning_text)在 t3code 核心层被丢弃**(`ProviderRuntimeIngestion` 只收 assistant_text)→ **所有端含 web 都不渲模型 reasoning**;web 的「思考」= thinking 开关 + token 统计 + 子任务进度,**没有 reasoning 面板**。
- **推论**:若用户其实想要「模型链式思考」显示,那是**独立 t3code 核心 feature**(改 ingestion+contracts+reducer+各端),**不在 bridge/M2b-4 范围**。**Plan 阶段务必与用户确认**:M2b-4 只借鉴 web **已有**的渲染(子任务进度/工具/正文/信息同步),还是要顺带推动核心 reasoning(后者另立项,别混进 M2b-4)。详见 memory `feishu-bridge-m2-todos.md` 纠错条 + `feishu-bridge-m2b4-todos.md`。

## 第一步(必做,按序)
1. 读 memory(`MEMORY.md` 索引 + 这几条):
   - `feishu-bridge-goal.md` — 项目目标 + 已敲定产品决策。
   - **`feishu-bridge-m2b4-todos.md`** — **M2b-4 的范围/约束/关键澄清地基,先读它。**
   - `feishu-bridge-m2-todos.md` — A 条(卡片渲染 v2 由来、遗留 seam、整卡 patch/节流权衡)+ B/C 条 + **🧠/reasoning 纠错条(必读)**。
   - `feishu-bridge-m2b-impl-facts.md` — 卡片 v2 的确切接线(eventRenderer `renderThreadCard` 七分区 + currentTurnId 过滤 + clampElement 字节降级 + chrome 开关 + density seam;interactionCard 表单)。
   - `feishu-bridge-m2b3-impl-facts.md` — **M2b-3 已合入的渲染复用**(`renderObservationToCard` 共享 helper、driveTurn 与 observe 两条渲染路径都调 `renderThreadCard`、operator 重签、e2e runbook)。改 eventRenderer **须同时不破坏这两条路径**。
   - `feishu-bridge-m1/m2-impl-facts.md` — 仍复用的 applyThreadDetailEvent/subscribeThread/OrchestrationThread 结构。
2. 读项目规则 `AGENTS.md`(尤其「重复=code smell,优先抽共享」「Performance/Reliability first」)。
3. 读设计蓝图 `docs/integrations/feishu-bridge-design.md` 的 **§7 / §7A(卡片渲染、工具面板)** + `feishu-bridge-design-review.md` 的相关陷阱(CardKit 单 element >30KB 400 abort、turn 作用域闪现、整卡 patch 全量刷新与限流),只读相关节,别全文读进上下文。
4. **派 Explore sub-agent 摸清 web 端到底怎么渲**(只读,返回 file:line + 结论):`apps/web` 的会话渲染——ChatView / session-logic / 消息·活动·工具·思考·子任务面板组件,五个维度(思考 / 工具调用 / sub-agent / 正文 / 信息同步)各自的信息架构、折叠/交互、增量更新与节流时机。**同时**派一个读现 `eventRenderer.ts`(卡片 v2)结构。实现细节不确定一律派 sub-agent 查并返回结论,不要自己翻大文件。

## 上下文卫生(硬性约束)
- **不**把大文件、长 diff、大量搜索结果读进主上下文;需要时派 sub-agent 读并返回**摘要/结论**。
- **不** `cat` 大输出;派 sub-agent 跑命令只回报结论。
- 你的主上下文只保留:当前状态、决策、下一步。细节沉到 memory 与 sub-agent。
- 里程碑结束把进度/决策/踩坑写进 memory(新增/更新 `feishu-bridge-m2b4-impl-facts.md` + 更新 `MEMORY.md`;`feishu-bridge-m2b4-todos.md` 按完成情况收敛)。

## 委派决策(默认委派,自己做是例外)
| 工作类型 | 交给谁 |
|---|---|
| 调研 / 摸清 web 渲染 / 定位代码 / 摸清某 API | **Explore** sub-agent(只读,返回 file:line + 结论) |
| 多文件实现 / 可并行改动 | **workflow**(分阶段;互不重叠文件并行,集成枢纽单 agent 串行——M2b-2/M2b-3 都踩过两 agent 同改 bot.ts 的坑),你只读结构化返回 |
| 跑 typecheck / lint / 测试 | sub-agent 执行,**只回结论**(`pnpm --filter @t3tools/feishu-bot run typecheck` 与 `pnpm exec vp check apps/feishu-bot`;失败先 `pnpm exec vp fmt apps/feishu-bot`) |
| 代码 review | **workflow** 多维独立审查 + 对抗验证(对每条发现默认怀疑、查是否已处理再采纳) |
| 设计 v3 布局 / 架构决策 / 与用户确认范围(尤其「思考」澄清、节流、密度档位) | **你自己** |
| 一两行明确改动 / 读单个小文件确认一个事实 / 对话 | 你自己(例外) |

并行的独立调研/实现放在**同一条消息**里扇出,别串行等待。

## 每个里程碑的闭环(不可跳步)
1. **Plan** — 先用 Explore 摸清 web 渲染 + 现 v2,**产出 v3 布局/交互方案(五维度各怎么改 + 节流/密度策略)与用户确认范围后再动手**。尤其先敲定「思考」到底渲什么(子任务进度 vs 是否推动核心 reasoning,后者另立项)。别直接开写。
2. **Implement** — workflow / sub-agent 实现(eventRenderer 为主;互不重叠文件并行,集成枢纽单 agent 串行)。
3. **Test** — typecheck + `vp check` **必须全过**(+ 若动 client-runtime 则 web/mobile typecheck),失败回 Implement。
4. **Review** — workflow 多维独立审查 + 对抗验证,维度至少含:正确性 / 与 t3code 架构契约一致 / **CardKit 字节降级(30KB)与坏卡不崩进程** / **driveTurn 与 observe 两条渲染路径都不破** / turn 作用域过滤(currentTurnId)/ 流式与限流节流 / 健壮性。
5. **Fix** — 修 review 确认为真的问题,重跑 Test。
6. **Confirm** — 向用户简洁汇报。**真连接 e2e 必跑**(见下「需要用户提供」)。

## 项目硬约束(违反即未完成)
- **bridge 是薄共享客户端**:只渲服务端给的;模型/流式/provider/project/thinking 是 server 端共享配置应继承,**不加 bot 级配置**。
- **CardKit 2.0 真实组件**(markdown/hr/collapsible_panel/select_static/multi_select_static/input,**绝不 checkbox**——M2b-1 实证 checkbox→400→unhandledRejection 崩进程);每 element 经 **clampElement 30KB 字节降级**(超限 abort 整条流);整卡 patch 全量刷新(非原生 typewriter),高频刷新与飞书限流的权衡影响节流策略。
- **不破坏 M2b-3 渲染复用与不变式**:`renderThreadCard(thread,{streaming,currentTurnId,interaction?,density?,chrome?})` 纯函数,被 driveTurn 与 observe 的 `renderObservationToCard` 共用;`currentTurnId` turn 作用域过滤、interaction 注入、chrome 开关、density seam 都要**保持/演进而非推翻**;改完须同时验 driveTurn(自驱)+ observe(纯观察)两条路径。turnQueue 记账 / nonce 单一消费者 / cardAction HMAC(不动 callbackAuth、不加 wildcard)/ CardHandle.pendingRequestId dedup 单一来源 / processGuard 一律不动。
- **健壮性**:任何卡片创建/更新/快照读/SDK 错误**绝不崩 bot 进程**(processGuard 兜底 + 调用点 Effect.ignore/catchCause)。
- 不 `import` `.repos/` 下 vendored 代码;写 Effect 代码先看 `.repos/effect-smol/LLMS.md`。client-runtime 只能子路径 import。维护性:重复逻辑抽共享(AGENTS.md),别在 eventRenderer 里复制 web 的逻辑——能子路径复用 client-runtime 的就复用。
- 参考仓库在 `/Users/lizhipeng/dev-workspace/lark-coding-agent-bridge`(只借鉴飞书接入层,不照搬其 spawn CLI 独立 session)。
- 提交/推送只在用户明确要求时做。**M2b-4 从 main 新开分支 `feishu-bridge-m2b4`**,逐里程碑 PR(commit → push origin → `gh pr create --repo litchi98/t3code --base main` → 用户确认后 squash 合并)。

## M2b-4 范围(Plan 阶段与用户敲定确切边界)
核心:**借鉴 web 渲染重写 eventRenderer(卡片 v3)**。五个借鉴维度:
- ① **思考**(先澄清:子任务进度 🧠 vs 模型 reasoning——后者核心 gap 另立项);
- ② **工具调用**(聚合/折叠阈值/详情截断/diff 处理,对照 web 的工具呈现);
- ③ **sub-agent**(子任务/子代理进度的层次与展开);
- ④ **正文**(流式/折叠/working vs 完成);
- ⑤ **信息同步**(增量更新、节流、刷新时机——CardKit 整卡 patch 的现实约束 vs web 的增量)。
**待用户拍板的边界**:① 「思考」澄清(见上);② 节流策略(高频整卡 patch vs 去抖/合并 vs 依赖 SDK throttle——M2b-3 实测 `Queue.sliding(1)`+SDK throttle 已够,v3 若加密度/折叠需复核);③ 三档密度(card/markdown/text seam,M2b-2 留给 M3 群聊)是否在 M2b-4 一并落地;④ 改动是「演进 v2 分区」还是「推倒重排」(倾向演进,保住 M2b-3 两条渲染路径与 interaction/currentTurnId/chrome 契约)。

## 明确不在范围
- **模型 extended-thinking reasoning 的显示**(t3code 核心 gap:ingestion 丢弃 reasoning_text,所有端含 web 都不渲;要做须改核心,另立项)。
- 群聊 + 话题(= M3,design.md:233);density 三档若不做则继续留 seam。

## 需要用户提供
**可验「卡片 v3 渲染 + 两条渲染路径」的 e2e 环境**(沿用 M2b-3 runbook,已记 `feishu-bridge-m2b3-impl-facts.md`):单台干净 `T3CODE_HOME` 的 `serve` 自带 web(先 `pnpm --filter @t3tools/web build`;`<HOME>/userdata/settings.json` 写 `{"enableAssistantStreaming":true}`)+ 浏览器 + 飞书 bot 同连;**在 web 起一个会触发思考/工具/子任务/长正文的复杂 agentic turn**(理想能派生子任务以验 🧠 面板),飞书 `/resume` 接管 → 肉眼对照 web 与飞书卡片的渲染贴近度(思考/工具折叠/子任务/正文/同步刷新)。bot 改代码需重启(`kill` bot pid → 重签 pairing token `--base-dir` → 同 `T3_STATE_DIR` 重起,**别用 dev**;`T3_HTTP_BASE_URL=http://127.0.0.1:3773` + `T3_MODEL=opus` + `T3_WORKSPACE_ROOT=<scratch ws>`)。**收口后须 kill server+bot 清理。**

## 起步:M2b-4 第一动作
**先派 Explore sub-agent**(同一条消息扇出):(a) 摸清 `apps/web` 五维度(思考/工具/sub-agent/正文/信息同步)的渲染信息架构 + 交互 + 增量/节流,返回 file:line + 结论;(b) 读现 `eventRenderer.ts`(卡片 v2)的分区结构与 RenderOptions 契约 + `renderObservationToCard`/driveTurn 两条调用路径;(c) 摸清 client-runtime 里 web/mobile 共用、可被 bridge 子路径复用的渲染/派生逻辑(避免在 eventRenderer 复制)。**产出 v3 布局/交互方案,与我确认范围(尤其「思考」澄清、推倒 vs 演进、节流、密度档位)后再动手。** 不要直接开写。

---

> 提示:这份提示词配合 `feishu-bridge-design.md`(§7/§7A) + `feishu-bridge-design-review.md` + memory(`feishu-bridge-goal`、`feishu-bridge-m2-todos`、`feishu-bridge-m2b-impl-facts`、`feishu-bridge-m2b3-impl-facts`、**`feishu-bridge-m2b4-todos`**)使用,共同构成完整施工上下文。
