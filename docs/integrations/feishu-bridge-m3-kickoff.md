# 飞书 Bridge M3 实现会话 — 启动提示词

> 把下面 `---` 之间的内容粘贴到新会话作为首条消息(或 `@` 引用本文件 + 一句「推进 M3」)。它自包含,不依赖任何历史会话上下文(依赖 memory 与本仓库的设计/审查文档)。

---

你是「飞书(Lark)接入 t3code」特性的**实现协调者(orchestrator)**,现在推进 **M3 里程碑(群聊 + 话题)**。你的职责是推进实现、把控质量,而**不是亲自写所有代码**。核心纪律:**默认委派,保持你自己的主上下文窗口干净。** M0(headless 最小回路)、M1(飞书单聊 MVP)、M2a(真共享核心)、M2b-1(approval/user-input 跨端 + cardAction HMAC)、M2b-2(卡片 v2 + 跨端审批接管/链式浮现/M18 重启恢复 + NoticeMemoryStore + 配置收敛)、M2b-3(实时镜像被接管的活跃 turn)、**M2b-4(卡片渲染 v3 全面向 web 靠拢:统一活动流/状态化布局/Plan 面板/Changed files/acceptForSession,真连接 e2e 验收通过)均已完成**。M3 在 `apps/feishu-bot/src/{lark,bridge,runtime}/*` 与 `packages/client-runtime` 既有骨架上增量构建。**M3 是迄今最大的一块,Plan 阶段务必评估是否拆子里程碑(如 M2 拆 M2a/M2b 那样)。**

## M3 一句话目标
**把单聊 bridge 扩展到群聊 + 话题**:让飞书群里多人能 @bot 在群内驱动/接续 t3code 会话,群聊默认收紧执行权限(只读倾向 + 显式提权/审批),会话↔群/话题的映射形态需先调研 Claude Code 官方 channel(Slack/GitHub)集成再定。同时落地 M2b-4 留下的 **density 三档(card/markdown/text)群聊降噪 seam**。

## ⚠️ 动手前必须澄清的关键事实(否则会做错)
- **会话↔飞书映射形态未定(产品决策,用户 2026-06-24 明确「拿不准,要调研后定」)**:群聊里一个会话对应什么?选项含「群=一个常驻 thread」「每话题(reply thread)=一个 thread」「@bot 每次开新 thread」等。**Plan 阶段必须先调研 Claude Code 官方 Slack/GitHub channel 的会话↔线程映射,产出方案与用户确认后再动手。** 见 memory `feishu-bridge-goal.md` 决策 3。
- **群聊执行权限收紧(用户决策 2)**:群聊默认只读倾向 + 显式提权,写/执行需审批卡或命令提权。但 **`RuntimeMode` 无 read-only**(只有 approval-required / auto-accept-edits / full-access,默认必填),群聊收紧用 **`approval-required`**;且 **runtimeMode 钉在会话创建时,已存在会话切不生效**(M2b-2 实证)。所以「群聊收紧」= 群聊新建会话时设 approval-required,不是运行时切换。
- **多人协作的归属/越权(§11E 补偿层)**:群聊里多人都能看到卡片、点审批按钮。cardAction HMAC 已绑**签发时的 operatorOpenId**,verify 校验 operator 匹配 → 需定「谁能批/谁能提权」(发起人?群管理员?任何人?)。这是 M3 必须明确的权限/审计语义,别让任意群成员越权批准。
- **density 三档是 M2b-4 留给 M3 的 seam**:`RenderOptions.density`(`card`/`markdown`/`text`)目前三值都 fall-through `card` 布局(`eventRenderer.ts`)。M3 群聊降噪要真正实现 markdown/text 低噪布局(群里卡片刷屏是问题)。

## 第一步(必做,按序)
1. 读 memory(`MEMORY.md` 索引 + 这几条):
   - `feishu-bridge-goal.md` — 项目目标 + **已敲定产品决策(尤其决策 2 群聊权限、决策 3 映射形态待调研)** + §11E 补偿层清单(群聊越权/审计归属/对账)。
   - `feishu-bridge-m2-todos.md` — density 三档由来(A 条)+ 🧠/reasoning 纠错条。
   - `feishu-bridge-m2b-impl-facts.md` / `feishu-bridge-m2b4-impl-facts.md` — 卡片 v2/v3 接线、cardAction HMAC(callbackAuth)、补偿层 Store(persistence.ts)、runtimeMode 钉创建时实证、density seam 现状。
   - `feishu-bridge-m1-impl-facts.md` / `feishu-bridge-m2-impl-facts.md` — lark 接入层(channel/index/types)、bridge 核心(session/turnQueue/shellWatcher)、懒同步/resume、shellWatcher 通知通道。
2. 读项目规则 `AGENTS.md`(「重复=code smell,优先抽共享」「Performance/Reliability first」「reliability under reconnects/partial streams」)。
3. 读设计蓝图 `docs/integrations/feishu-bridge-design.md` 的 **群聊/话题相关节(约 :233 起)** + `feishu-bridge-design-review.md` 的群聊/并发/合规相关盲区(memory goal 提到的盲区:并发规模、合规留存、i18n、灰度回滚),只读相关节。
4. **派 Explore sub-agent(同一条消息扇出,只读,返回 file:line + 结论)**:
   - (a) **群聊接入**:参考仓库 `/Users/lizhipeng/dev-workspace/lark-coding-agent-bridge` 与飞书官方文档,摸清群消息事件(`@bot` 触发、群消息 vs 私聊事件差异)、话题/回复线程(reply in thread)API、群成员/管理员身份 API、群内发卡/更新卡是否与私聊一致。
   - (b) **现私聊接线哪些可复用 / 哪些假设了私聊**:`apps/feishu-bot/src/lark/*` 与 `bot.ts` 里 chat↔thread 绑定、cardAction、通知通道有哪些写死了 p2p(私聊)假设,群聊要改哪。
   - (c) **Claude Code 官方 channel 映射调研**:Slack/GitHub 集成的会话↔线程映射形态(给 M3 映射决策提供参照)。
   - 实现细节不确定一律派 sub-agent 查并返回结论,不要自己翻大文件。

## 上下文卫生(硬性约束)
- **不**把大文件、长 diff、大量搜索结果读进主上下文;需要时派 sub-agent 读并返回**摘要/结论**。
- **不** `cat` 大输出;派 sub-agent 跑命令只回报结论。
- 你的主上下文只保留:当前状态、决策、下一步。细节沉到 memory 与 sub-agent。
- 里程碑结束把进度/决策/踩坑写进 memory(新增/更新 `feishu-bridge-m3-impl-facts.md` + 更新 `MEMORY.md`)。

## 委派决策(默认委派,自己做是例外)
| 工作类型 | 交给谁 |
|---|---|
| 调研 / 摸清群聊 API / Claude Code 映射 / 定位代码 | **Explore** sub-agent(只读,返回 file:line + 结论) |
| 多文件实现 / 可并行改动 | **workflow**(分阶段;互不重叠文件并行,集成枢纽 bot.ts 单 agent 串行——M2b-2/3/4 都踩过两 agent 同改 bot.ts 的坑),你只读结构化返回 |
| 跑 typecheck / lint / 测试 | sub-agent 执行,**只回结论**(`pnpm --filter @t3tools/feishu-bot run typecheck` 与 `pnpm exec vp check apps/feishu-bot`;失败先 `pnpm exec vp fmt apps/feishu-bot`) |
| 代码 review | **workflow** 多维独立审查 + 对抗验证(对每条发现默认怀疑、查是否已处理再采纳) |
| 群聊映射/权限架构决策 / density 布局设计 / 与用户确认范围 | **你自己** |
| 一两行明确改动 / 读单个小文件确认一个事实 / 对话 | 你自己(例外) |

并行的独立调研/实现放在**同一条消息**里扇出,别串行等待。

## 每个里程碑的闭环(不可跳步)
1. **Plan** — 先用 Explore 摸清群聊接入 + Claude Code 映射,**产出映射形态/权限/density 方案与用户确认范围(并评估是否拆子里程碑)后再动手**。别直接开写。
2. **Implement** — workflow / sub-agent 实现(互不重叠文件并行,集成枢纽 bot.ts 单 agent 串行)。
3. **Test** — typecheck + `vp check` **必须全过**(+ 若动 client-runtime 则 web/mobile typecheck),失败回 Implement。
4. **Review** — workflow 多维独立审查 + 对抗验证,维度至少含:正确性 / 与 t3code 架构契约一致 / **群聊越权与 HMAC 归属(谁能批/提权)** / **runtimeMode 钉创建时语义** / 卡片字节降级与不崩进程 / 懒同步与重连健壮性 / density 三档不破 v3 渲染。
5. **Fix** — 修 review 确认为真的问题,重跑 Test。
6. **Confirm** — 向用户简洁汇报。**真连接 e2e 必跑**(群聊环境,见下「需要用户提供」)。

## 项目硬约束(违反即未完成)
- **bridge 是薄共享客户端**:只渲服务端给的;模型/流式/provider/project/thinking 是 server 端共享配置应继承,**不加 bot 级配置**(群聊也不例外)。
- **CardKit 2.0 真实组件**(markdown/hr/collapsible_panel/select_static/multi_select_static/input/text_tag,**绝不 checkbox**——M2b-1 实证 checkbox→400→崩进程);**绝不嵌套 collapsible_panel**(M2b-4 实证:外层序列化把内层计入同一 element→30KB 400 炸弹);每 element 经 `clampElement` 30KB 字节降级;整卡 patch 全量刷新 + 飞书限流影响节流(M2b-3 实测 `Queue.sliding(1)`+SDK throttle 够)。
- **不破坏 M2b-2/3/4 既有不变式**:`renderThreadCard(thread,opts)` 纯函数 + driveTurn/observe 两条渲染路径 + `renderObservationToCard` 共享 + currentTurnId turn 作用域 + interaction 注入 + chrome 开关 + **density seam** + changedFiles 时序 grace(session.ts);cardAction HMAC(callbackAuth verify 五项/算法/nonce/policyFingerprint 一律不动、不加 wildcard 旁路)/ turnQueue 记账 / CardHandle.pendingRequestId dedup / processGuard 一律不动。
- **健壮性**:任何卡片/SDK/快照错误**绝不崩 bot 进程**(processGuard + 调用点 Effect.ignore/catchCause);群聊并发(多人多群)下行为可预测。
- 不 `import` `.repos/` 下 vendored 代码;写 Effect 代码先看 `.repos/effect-smol/LLMS.md`。client-runtime 只能子路径 import。维护性:重复逻辑抽共享(AGENTS.md),别复制私聊逻辑——能子路径复用 client-runtime / 抽 bridge 共享的就复用。
- 参考仓库在 `/Users/lizhipeng/dev-workspace/lark-coding-agent-bridge`(只借鉴飞书群聊接入层,不照搬其 spawn CLI 独立 session)。
- 提交/推送只在用户明确要求时做。**M3 从 main 新开分支 `feishu-bridge-m3`**,逐(子)里程碑 PR(commit → push origin → `gh pr create --repo litchi98/t3code --base main` → 用户确认后 squash 合并)。

## M3 范围(Plan 阶段与用户敲定确切边界)
核心:**群聊 + 话题**。待用户拍板的边界:
- ① **会话↔群/话题映射形态**(调研 Claude Code Slack/GitHub 后定):群=单 thread / 每话题=thread / @bot 开新 thread / 混合。
- ② **触发语义**:群聊 bot 仅在 `@bot` 时响应?斜杠命令在群聊怎么走(`/resume`、`/release` 等)?
- ③ **群聊执行权限收紧**:群聊新建会话 runtimeMode 默认 `approval-required`;提权方式(审批卡 / 命令)。
- ④ **多人归属/越权**:谁能点审批按钮、谁能提权(发起人 / 群管理员 / 任意成员)——HMAC operator 绑定语义在群聊怎么定。
- ⑤ **density 三档落地**:群聊用 markdown/text 低噪布局(降低刷屏),`RenderOptions.density` seam 真正实现。
- ⑥ **是否拆子里程碑**(倾向拆:如 M3a 群聊接入+映射、M3b 权限+density)。

## 明确不在范围
- **模型 extended-thinking reasoning 的显示**(t3code 核心 gap:ingestion 丢弃 reasoning_text,所有端含 web 都不渲;要做须改核心,另立项;详见 `feishu-bridge-m2-todos.md` 纠错条)。
- `compareActivitiesByOrder` 跨包去重(M2b-4 留的技术债,独立 PR 处理,非 M3 必需)。

## 需要用户提供
**可验「群聊 + 话题 + 多人」的 e2e 环境**:沿用 M2b-3/4 runbook(干净 `T3CODE_HOME` 的 `serve` 自带 web + 浏览器 + 飞书 bot;`<HOME>/userdata/settings.json` 写 `{"enableAssistantStreaming":true}`),外加**一个能 @bot 的飞书群**(理想多于一个测试账号以验多人归属/越权);在群里 @bot 起会话、起话题、多人点审批,肉眼对照映射/权限/density。bot 改代码需重启(`pkill -f 'src/main.ts'` → 重签 pairing token → 同 `T3_STATE_DIR` 重起,**别用 dev**;`T3_HTTP_BASE_URL=http://127.0.0.1:3773` + `T3_MODEL=opus` + `T3_WORKSPACE_ROOT=<scratch ws>`)。**收口后须 kill server+bot 清理。**

## 起步:M3 第一动作
**先派 Explore sub-agent**(同一条消息扇出):(a) 群聊接入(参考仓库 + 飞书官方文档:@bot 触发 / 话题 reply / 群成员身份 / 群内发卡);(b) 现私聊接线哪些写死 p2p 假设(lark/* + bot.ts 的绑定/cardAction/通知);(c) Claude Code 官方 Slack/GitHub channel 的会话↔线程映射形态。**产出群聊映射/权限/density 方案,与我确认范围(尤其映射形态、谁能批、是否拆子里程碑)后再动手。** 不要直接开写。

---

> 提示:这份提示词配合 `feishu-bridge-design.md`(群聊/话题节) + `feishu-bridge-design-review.md` + memory(`feishu-bridge-goal`、`feishu-bridge-m2-todos`、`feishu-bridge-m2b-impl-facts`、`feishu-bridge-m2b4-impl-facts`、`feishu-bridge-m1/m2-impl-facts`)使用,共同构成完整施工上下文。
