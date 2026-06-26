# 飞书 Bridge M3b 实现会话 — 启动提示词

> 把下面 `---` 之间的内容粘贴到新会话作为首条消息(或 `@` 引用本文件 + 一句「推进 M3b」)。它自包含,不依赖任何历史会话上下文(依赖 memory 与本仓库的设计/审查文档)。

---

你是「飞书(Lark)接入 t3code」特性的**实现协调者(orchestrator)**,现在推进 **M3b 里程碑(群聊降噪 density 三档 + 审批/路由收尾 gap)**。你的职责是推进实现、把控质量,而**不是亲自写所有代码**。核心纪律:**默认委派,保持你自己的主上下文窗口干净。**

M0(headless 最小回路)、M1(单聊 MVP)、M2a(真共享核心)、M2b-1(approval/user-input 跨端 + cardAction HMAC)、M2b-2(卡片 v2 + 跨端审批接管/M18 恢复 + 配置收敛)、M2b-3(实时镜像被接管 turn)、M2b-4(卡片 v3 向 web 靠拢)、**M3a(群聊 + 话题:话题=session 路由 + owner-default 审批 + 斜杠命令话题感知,真连接群 e2e 验收通过,PR #8 已 squash 合并 main commit `e5f7a380`)均已完成**。M3b 在既有骨架上增量构建。

## M3b 一句话目标
**把群聊体验收尾**:① 真正落地 **density 三档**(`card`/`markdown`/`text`),群聊用低噪布局降低卡片刷屏(M2b-2 起就留的 seam,三值至今 fall-through `card`);② 补 M3a 留下的几个 gap(话题内 surfaced-approval 卡、几个已知残留)。**多审批人白名单 + web settings 飞书配置 UI 体量大、touch web,Plan 阶段评估是否拆出独立里程碑(倾向拆)。**

## ⚠️ 动手前必须澄清的关键事实(否则会做错)
- **density 三档现状 = seam 没实现**:`apps/feishu-bot/src/bridge/eventRenderer.ts` 的 `RenderOptions.density`(`card`/`markdown`/`text`)三值**全部 fall-through `card` 布局**(M2b-2 起留的)。群聊降噪要真做 `markdown`/`text` 低噪布局(群里高频整卡 patch 刷屏是真问题)。**谁来选 density?** 当前所有路径(driveTurn/observe/sendNotice)都没传 density、默认 `card`。M3b 要定:群聊默认走哪档、是否按 chatType(群→低噪 / p2p→card)、是否可配。
- **接管卡发群根 = M3a 已知 degradation(比字面窄,两条子路径,修法不同)**:发群根的是「**新发卡**」路径——`surfacePendingApprovalIfNew`(bot.ts:1412,**两个调用方**:startMirror `bot.ts:886` + shellWatcher 修法 B `shellWatcher.ts:404`)和 observe fiber 新发卡分支(bot.ts:1832),都发裸 chatId、无 `topicSendOpts`。**但** observe fiber 有 **adopt 分支**(bot.ts:1790):有现成卡(`driveTurn` 话题卡)就 `updateCard` 原地复用 → 留话题;**常见链式 subagent(planner 话题卡被 adopt)不发群根**(e2e 实证);**`/resume` 接管已有活跃 turn 也走 observe**(ensureObserving 令 isObserving 真 → surfacePendingApprovalIfNew 在 `bot.ts:1336` 早退)。所以 1412 真正发群根的是两种、**修法不同**:**(a) `/resume` 接管一个 idle-但-有-pending-approval 的话题** —— **有触发消息可锚**(`/resume` 命令消息 `ctx.message.messageId`,`handlers.ts:281` 已用于确认回复),只是没透传进 `startMirror`(`bot.ts:754` 签名只有 chatId/threadId);透传下去 reply-in-thread 即落话题,**不必派生话题根 id**。**(b) shellWatcher 修法 B 的常驻链式审批通知** —— **真无触发消息**,这条才需在 bind 时存话题锚点 / 取话题根消息 id(话题群 `larkThreadId` 是 `omt_` thread id、非 message id、不能直接当 replyTo = 难点)。见 memory `feishu-bridge-m3a-impl-facts`。
- **多审批人白名单需解耦 authz 与 verify 五项(红线区,谨慎)**:M3a 审批是**单 owner 单绑**(`resolveApprover` 绑 `payload.o`,verify 五项不动)。真·多审批人(N 选一)要把「授权判定」从 callbackAuth 的单 operator 匹配里**解耦出来**(verify 仍验完整性,authz 改成 allowlist 成员判定)。用户的完整愿景:**web settings 开飞书栏目做飞书登录授权 + 配置审批白名单**(2026-06-26 明确,M3a 只留了 env `FEISHU_OWNER_OPEN_IDS` seam)。这块 touch web + authz 模型 + 邻接红线,**体量与风险都大,优先评估拆独立里程碑**。
- **CardKit 红线仍在**:绝不 `checkbox`、绝不嵌套 `collapsible_panel`、每 element `clampElement` 30KB 字节降级、整卡 patch 全量刷新 + 节流。density 的 `markdown`/`text` 布局也必须守这些。

## 第一步(必做,按序)
1. 读 memory(`MEMORY.md` 索引 + 这几条):
   - `feishu-bridge-m3a-impl-facts.md` — **M3a 全部接线 + 4 决策 + M3b 范围条 + 已知残留**(density 未落地确认、话题内审批卡 gap、多审批人/web-config seam、planner「✅完成」闪现、bystanderNoticed Set 无界、SECONDARY grace race)。
   - `feishu-bridge-m2-todos.md` — **density 三档由来(A 条)** + 🧠/reasoning 纠错条(reasoning 不在范围)。
   - `feishu-bridge-m2b4-impl-facts.md` — 卡片 v3 接线(`eventRenderer.ts` 分区/统一活动流/Plan/Changed files/density seam 现状)+ `compareActivitiesByOrder` 跨包去重技术债。
   - `feishu-bridge-goal.md` — 项目目标 + §11E 补偿层。`feishu-bridge-m2b-impl-facts.md` — cardAction HMAC(callbackAuth)/CardHandleStore/NoticeMemoryStore。
2. 读项目规则 `AGENTS.md`(「重复=code smell,优先抽共享」「Performance/Reliability first」「reliability under reconnects/partial streams」)。
3. 读设计文档 `docs/integrations/feishu-bridge-card-v3-design.md`(卡片 v3 信息架构)+ `feishu-bridge-design.md` 相关节,只读相关。
4. **派 Explore sub-agent(同一条消息扇出,只读,返回 file:line + 结论)**:
   - (a) **density 布局设计**:`eventRenderer.ts` 的 `RenderDensity`/`RenderOptions.density` seam 现状(三值怎么 fall-through)、`renderThreadCard` 哪些分区在 `markdown`/`text` 档该精简/去掉/换纯文本;web 端有没有「紧凑/低噪」呈现可借鉴。
   - (b) **density 注入点**:driveTurn/observe/sendNotice 调 `renderThreadCard`/`renderObservationToCard` 时怎么传 density,按什么决定档位(chatType?群默认低噪?),改动面多大、契约怎么不破。
   - (c) **话题内审批卡**:`surfacePendingApprovalIfNew` + CardHandle 现状,要存什么(larkThreadId/锚点)才能 `topicSendOpts` 投进话题;observe/watcher 路径无触发消息时锚点取哪条(话题根消息?)。
   - 实现细节不确定一律派 sub-agent 查并返回结论,不要自己翻大文件。

## 上下文卫生(硬性约束)
- **不**把大文件、长 diff、大量搜索结果读进主上下文;需要时派 sub-agent 读并返回**摘要/结论**。
- 你的主上下文只保留:当前状态、决策、下一步。细节沉到 memory 与 sub-agent。
- 里程碑结束把进度/决策/踩坑写进 memory(新增/更新 `feishu-bridge-m3b-impl-facts.md` + 更新 `MEMORY.md`)。
- **【kickoff 必审 · 自传播规则】收口时若写了下一会话的 kickoff(沿用「带下一里程碑 kickoff」约定):必须用 **workflow 多维对抗审查那份新 kickoff**(维度至少:① 代码事实准确性——逐条对照真实 merged 代码的 file:line,② 范围完整性——对照 memory 残留/待办无遗漏无误分类,③ 自包含与引用正确——memory/文档路径真实存在、runbook 可执行、红线齐全),修掉确认项再交付。kickoff 里写错 file:line / 过时论断会误导下个会话。**并把这条「kickoff 必审 · 自传播规则」原样写进你产出的新 kickoff**,使之后每一份 kickoff 都被审。**(本份 M3b kickoff 已按此审过。)**

## 委派决策(默认委派,自己做是例外)
| 工作类型 | 交给谁 |
|---|---|
| 调研 / 摸清 density seam / 定位代码 | **Explore** sub-agent(只读,返回 file:line + 结论) |
| 多文件实现 / 可并行改动 | **workflow**(分阶段;互不重叠文件并行,集成枢纽 bot.ts 单 agent 串行——M2b/M3a 都踩过两 agent 同改 bot.ts 的坑),你只读结构化返回 |
| 跑 typecheck / lint / 测试 | sub-agent 执行,**只回结论**(`pnpm --filter @t3tools/feishu-bot run typecheck` 与 `pnpm exec vp check apps/feishu-bot`;失败先 `pnpm exec vp fmt apps/feishu-bot`) |
| 代码 review | **workflow** 多维独立审查 + 对抗验证(对每条发现默认怀疑、查是否已处理再采纳) |
| density 布局设计 / 范围拆分决策 / 与用户确认 | **你自己** |
| 一两行明确改动 / 读单个小文件确认一个事实 / 对话 | 你自己(例外) |

并行的独立调研/实现放在**同一条消息**里扇出,别串行等待。

## 每个里程碑的闭环(不可跳步)
1. **Plan** — 先用 Explore 摸清 density seam + 布局,**产出 density 各档布局方案 + 注入策略 + 是否拆子里程碑(多审批人 web-config 倾向拆)与用户确认范围后再动手**。别直接开写。
2. **Implement** — workflow / sub-agent(互不重叠文件并行,集成枢纽 bot.ts 单 agent 串行)。
3. **Test** — typecheck + `vp check` **必须全过**(+ 若动 client-runtime 则 web/mobile typecheck),失败回 Implement。
4. **Review** — workflow 多维独立审查 + 对抗验证,维度至少含:正确性 / 与 t3code 架构契约一致 / **density 三档不破 v3 渲染(card 档字节级不变)** / CardKit 字节降级不崩不嵌套 / 懒同步与重连健壮 / **callbackAuth/HMAC 红线未碰**。
5. **Fix** — 修 review 确认为真的问题,重跑 Test。
6. **Confirm** — 向用户简洁汇报。**真连接 e2e 必跑**(群聊环境,见下「需要用户提供」)。

## 项目硬约束(违反即未完成)
- **bridge 是薄共享客户端**:只渲服务端给的;模型/流式/provider/project/thinking 是 server 端共享配置应继承,**不加 bot 级配置**(密度是渲染选项、属 bridge 自有显示层,可加;但别把 server 共享配置泄漏成 bot 配置)。
- **CardKit 2.0 真实组件**(markdown/hr/collapsible_panel/select_static/multi_select_static/input/text_tag,**绝不 checkbox**;**绝不嵌套 collapsible_panel**;每 element `clampElement` 30KB 字节降级;整卡 patch 全量刷新 + 飞书限流节流 `Queue.sliding(1)`+SDK throttle)。
- **不破坏 M2b/M3a 既有不变式**:`renderThreadCard(thread,opts)` 纯函数 + driveTurn/observe 两条渲染路径 + `renderObservationToCard` 共享 + `currentTurnId` turn 作用域 + interaction 注入 + chrome 开关 + **density seam** + changedFiles 时序 grace(session.ts);**M3a 路由**(`anchorOf` 共享/`compositeChatKey` 零 re-bind/turnQueue 按 chatKey 记账/shellWatcher 对 self-created 也 observe 的 `isChatBusy` 守卫);cardAction HMAC(callbackAuth verify 五项/算法/nonce/policyFingerprint **一律不动、不加 wildcard 旁路**)/ `resolveApprover` owner-default / CardHandle 去重 / processGuard 一律不动。
- **健壮性**:任何卡片/SDK/快照错误**绝不崩 bot 进程**(processGuard + 调用点 Effect.ignore/catchCause);群聊并发(多人多群多话题)下行为可预测。
- 不 `import` `.repos/` 下 vendored 代码;写 Effect 代码先看 `.repos/effect-smol/LLMS.md`。client-runtime 只能子路径 import。重复逻辑抽共享。
- 提交/推送只在用户明确要求时做。**M3b 从 main 新开分支 `feishu-bridge-m3b`**,逐(子)里程碑 PR(commit → push origin → `gh pr create --repo litchi98/t3code --base main` → 用户确认后 squash 合并)。

## M3b 范围(Plan 阶段与用户敲定确切边界)
核心:**density 三档 + 群聊收尾 gap**。候选清单(与用户拍板):
- ① **density 三档落地**(头牌):`markdown`/`text` 低噪布局真实现 + 注入策略(群默认低噪?按 chatType?)。
- ② **接管卡话题内投递(窄 gap,两条子路径修法不同)**:`surfacePendingApprovalIfNew`(bot.ts:1412)发群根,两个调用方:**(a) `/resume` 接管 idle-但-有-pending 话题** —— 有命令消息 messageId 可锚(`handlers.ts:281` 已用),只是 `startMirror`(`bot.ts:754`)没透传 → 透传下去 reply-in-thread 即落话题,**不必派生话题根 id**;**(b) shellWatcher 修法 B 常驻链式审批通知**(`shellWatcher.ts:404`)—— 真无触发消息,需 bind 时存话题锚点 / 取话题根消息 id(话题群 `omt_` 非 message id=难点);observe fresh(1832)同理。**常见链式 subagent 被 adopt(1790)覆盖、`/resume` 活跃 turn 走 observe,均不受影响**(e2e 实证)。
- ③ **已知残留 / 限制**(看 `feishu-bridge-m3a-impl-facts` 残留条):
  - **owner 不在群 → 审批死锁**:配 `FEISHU_OWNER_OPEN_IDS` 为**非群成员**时,审批卡按钮签给 owner、群里无人能过 verify → turn 永等审批卡死(**默认不配 owner = 回退发起人,无此问题**;M3a e2e 是 owner 在群验的)。缓解 = 多审批人 allowlist(属下面 ⑤)。**M3b 至少应把此限制落代码文档**(`chatThreadMap.resolveApprover` / config owner 注释 / README;memory `feishu-bridge-m3a-impl-facts:49` 要求文档化但尚未落代码),避免误判群聊审批已完备。
  - planner 完成「✅完成」闪现再被 observe 翻回(状态判定 polish);`bystanderNoticed` Set 无界(加界/清理);SECONDARY grace race(persistHandle 误取后续 turn approval,实测未触发,加固)。
- ④ **AuditEntry 加 larkThreadId**(审计话题维度,信息完整性,小)。
- ⑤ **是否拆出「多审批人白名单 + web settings 飞书配置」为独立里程碑**(倾向拆:体量大、touch web + 邻接红线;用户愿景=web 飞书登录授权 + 配审批白名单,M3a 只留 env seam)。

## 明确不在范围
- **模型 extended-thinking reasoning 的显示**(t3code 核心 gap:ingestion 丢弃 reasoning_text,所有端含 web 都不渲;要做须改核心,另立项;详见 `feishu-bridge-m2-todos.md` 纠错条)。
- `compareActivitiesByOrder` 跨包去重(M2b-4 留的技术债,独立 PR 处理,非 M3b 必需)。
- 话题内免 @ 续聊(需 `im:message.group_msg` 群消息权限,用户 M3a 已选「每轮 @bot」;要改属产品决策变更,另议)。

## 需要用户提供
**可验「群聊 + 话题 + density」的 e2e 环境**:沿用 M3a runbook(干净 `T3CODE_HOME=~/.t3-feishu-m3b` 的 `serve` 自带 web + 浏览器 + 飞书 bot;`<HOME>/userdata/settings.json` 写 `{"enableAssistantStreaming":true}`),外加**话题模式的飞书群**(话题群 chat_mode=topic 或普通群开「话题形式」)。bot 改代码需重启(`pkill -f 'feishu-bot.*src/main.ts'` → 重签 pairing token `auth pairing create --base-dir <HOME>` → 同 `T3_STATE_DIR` 重起,**别用 dev**;`T3_HTTP_BASE_URL=http://127.0.0.1:3773` + `T3_MODEL=opus` + `T3_WORKSPACE_ROOT=<scratch ws>`;config 不自动读 .env,启动 `set -a; . apps/feishu-bot/.env; set +a`)。**收口后须 kill server+bot 清理。**

## 起步:M3b 第一动作
**先派 Explore sub-agent**(同一条消息扇出):(a) density 布局设计(eventRenderer seam 现状 + markdown/text 各分区怎么精简 + web 低噪借鉴);(b) density 注入点(driveTurn/observe/sendNotice 怎么传档、按什么决定);(c) 话题内审批卡(surfacePendingApprovalIfNew + CardHandle 要存什么)。**产出 density 各档布局方案 + 注入策略,与我确认范围(尤其群默认档位、是否拆出多审批人 web-config 里程碑)后再动手。** 不要直接开写。

---

> 提示:这份提示词配合 `feishu-bridge-card-v3-design.md` + memory(`feishu-bridge-m3a-impl-facts`、`feishu-bridge-m2-todos`、`feishu-bridge-m2b4-impl-facts`、`feishu-bridge-goal`、`feishu-bridge-m2b-impl-facts`)使用,共同构成完整施工上下文。
