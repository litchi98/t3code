# 飞书 Bridge M4 实现会话 — 启动提示词

> 把下面 `---` 之间的内容粘贴到新会话作为首条消息(或 `@` 引用本文件 + 一句「推进 M4」)。它自包含,不依赖任何历史会话上下文(依赖 memory 与本仓库的设计/审查文档)。

---

你是「飞书(Lark)接入 t3code」特性的**实现协调者(orchestrator)**,现在推进 **M4 里程碑(多审批人白名单 + web settings 飞书配置)**。你的职责是推进实现、把控质量,而**不是亲自写所有代码**。核心纪律:**默认委派,保持你自己的主上下文窗口干净。**

M0(headless 最小回路)、M1(单聊 MVP)、M2a(真共享核心)、M2b-1〜4(approval/user-input 跨端 + HMAC + 卡片 v2/v3)、M3a(群聊 + 话题路由 + owner-default 审批,PR #8 合并 `e5f7a380`)、**M3b(群聊降噪 density 三档 + 话题内审批卡投递 A/B + 残留收尾,PR #9 —— 实现+审查+真连接 e2e 全部完成,**待 squash 合并 main**)代码均已完成**。M4 在既有骨架上增量构建,**是体量最大、唯一深度 touch web + 邻接 callbackAuth 红线的里程碑**——务必谨慎、分阶段、与用户充分确认。

## M4 一句话目标
把 M3a/M3b 的**单 owner 单绑审批**升级为**可配置的多审批人白名单(N 选一)**,并落地用户的完整愿景:**web settings 开「飞书」栏目做飞书登录授权 + 配置审批白名单**(用户 2026-06-26 明确)。根治 M3b 已文档化的「owner 不在群→群审批死锁」限制。

## ⚠️ 动手前必须澄清的关键事实(否则会做错/碰红线)
- **【前置 · 已满足】PR #9 已 squash 合并 main(commit `efe13879`,2026-06-26)**:M3b 全部代码(density 三档 / 话题投递 `topicAnchorMessageId` / `resolveApprover` owner 文档 / `ChatBinding` 升级)已在主线、基线就绪 → 直接从 main 新开 `feishu-bridge-m4` 即可。(若你读到此时 `main` 顶端已非 M3b(`efe13879`),说明仓库状态有变,核对后再开分支,避免 base 缺 M3b 代码。)
- **当前是单 owner 单绑,authz 与 verify 未分离(这正是 M4 要解耦的)**:M3a/M3b 的审批归属 = `resolveApprover`(`apps/feishu-bot/src/bridge/chatThreadMap.ts`:100-107,M3b 在其 JSDoc :94-98 加了 owner 死锁 KNOWN LIMITATION)在 `buildInteraction` 算 `operatorOpenId`,绑进 `payload.o`;`callbackAuth` 的 verify **五项 r/s/c/o/fp** 里 `o` 是「点击者 openId 必须 ===payload.o」的**单值匹配**(bot.ts handleCardAction,verify 调用点 :2624)。**真·多审批人(N 选一)= 把「o 单值匹配」改成「点击者 ∈ allowlist 成员判定」,但 HMAC / nonce 单消费 / policyFingerprint / 算法绝对不动**——authz(谁有权)是叠加在 verify(消息完整性)**之上**的新判定层,不是替换 verify。**这是全项目最敏感的红线区,Plan 阶段必须对解耦方案做独立对抗审查后再动手。**
- **M3a/M3b 已留的 seam(复用别重造)**:env `FEISHU_OWNER_OPEN_IDS`(`config.ts`:71/115/244,M3b owner 死锁文档在 :77-82)、`resolveApprover(runtimeMode, ownerOpenIds, initiatorOpenId)` 已是**列表形态参数**(当前只取 `[0]` 单绑)、provider 闭包可换(Store 读 ∪ env)。M3a memory 明示「未来加 `isAuthorizedApprover` 解耦 verify;M3a/M3b 不建 Store(YAGNI,无 writer)」——**M4 就是建 writer(web 配置)的时候**。
- **payload.o 的语义要变(谨慎)**:单 owner 时 `payload.o` = 唯一审批人,签名时确定。多审批人 N 选一时,「签给谁」不再唯一——要么 payload 不再绑单个 o 而 verify 改查 allowlist(动 verify 的 o 项=红线核心,需最谨慎),要么保留 payload.o 为「allowlist 引用/指纹」让 verify 仍单值比对但比对目标是「allowlist 成员之一」。**两种路线的红线影响不同,Plan 阶段务必让 Explore + 独立审查厘清 callbackAuth 的 o 项究竟怎么改最小且不破 HMAC 覆盖/policyFingerprint**。别想当然。
- **bridge 是薄客户端,白名单是 server 端共享配置**:审批白名单 + 飞书身份绑定应存 **server 端 authz store**(web/bot 都读),**不在 bot 加配置**(bot 只读)。web settings 是配置入口,server 是权威存储。env `FEISHU_OWNER_OPEN_IDS` 降级为「裸部署逃生口/默认」,与 store 取并集(对齐 M3a「Store 读 ∪ env」设想)。
- **飞书登录授权 = 把飞书 openId 绑到 web 用户(机制待 Explore 证实)**:用户要「web 飞书栏目做飞书登录授权」——即在 web 上通过飞书 OAuth 登录、拿到该用户的飞书 openId、存进 authz store 作为授权审批人。**飞书 OAuth/扫码登录的确切机制 + t3code 现有 auth(`apps/server` AuthAccessManagement / pairing / session)怎么接,必须 Explore 查实,不要臆断。**
- **CardKit / 投递红线仍在(M3b 已立)**:绝不 checkbox、绝不嵌套 collapsible、clampElement 30KB、density 三档不破、话题投递 reply_in_thread 只认 message id(`topicAnchorMessageId`)。M4 主要碰 authz + web,但若动审批卡渲染须守这些。

## 第一步(必做,按序)
1. 读 memory(`MEMORY.md` 索引 + 这几条):
   - `feishu-bridge-m3b-impl-facts.md` — **M3b 全部接线(density 三档 / 话题投递 A/B / binding 升级 / 残留)+ owner 死锁文档化位置 + D3/D4 暂缓**。
   - `feishu-bridge-m3a-impl-facts.md` — **owner-default seam 设计(resolveApprover / FEISHU_OWNER_OPEN_IDS / buildInteraction 单点注入)+ callbackAuth 五项红线 + 决策 2(可配审批白名单,默认 owner)的完整原话**。
   - `feishu-bridge-m2b-impl-facts.md` — **cardAction HMAC(callbackAuth verify 五项 r/s/c/o/fp / 算法 / nonce / policyFingerprint)的确切接线** —— M4 红线核心,务必读准。
   - `feishu-bridge-goal.md` — 项目目标 + §11E 补偿层 + 薄客户端原则。
2. 读项目规则 `AGENTS.md`(「重复=code smell,优先抽共享」「Performance/Reliability first」)。
3. 读设计文档(只读相关节):`docs/integrations/feishu-bridge-design.md`(审批 / authz / cardAction 相关)。
4. **派 Explore sub-agent(同一条消息扇出,只读,返回 file:line + 结论)**:
   - (a) **callbackAuth authz 解耦点**:`callbackAuth.ts` 的 verify 五项实现(r/s/c/o/fp 各怎么算/比对、HMAC 覆盖范围、nonce 单消费、policyFingerprint 怎么算)+ bot.ts handleCardAction 的 verify 调用点 + `payload.o` 怎么生成/比对。**给出「把 o 单值匹配改成 allowlist 成员判定」的最小改动面 + 哪些绝对不能动(HMAC/nonce/fingerprint 算法)**。
   - (b) **resolveApprover / buildInteraction 注入链**:M3a 单点注入(`resolveApprover` → `payload.o`)的完整链路 file:line,多审批人怎么改这一处。
   - (c) **web settings 结构**:`apps/web` 的 settings UI 怎么组织(现有栏目/tab 怎么加)、设置怎么经 WS/contracts 存到 server。加「飞书」栏目的改动面。
   - (d) **server authz store + 飞书登录**:`apps/server` 的 AuthAccessManagement / 现有 auth(pairing/session/scopes,见 migrations 20/21/22/31/32)能否承载「飞书 openId ↔ 审批白名单」存储 + 飞书 OAuth 登录怎么接。
   - 实现细节不确定一律派 sub-agent 查并返回结论,不要自己翻大文件。

## 上下文卫生(硬性约束)
- **不**把大文件、长 diff、大量搜索结果读进主上下文;需要时派 sub-agent 读并返回**摘要/结论**。
- 你的主上下文只保留:当前状态、决策、下一步。细节沉到 memory 与 sub-agent。
- 里程碑结束把进度/决策/踩坑写进 memory(新增/更新 `feishu-bridge-m4-impl-facts.md` + 更新 `MEMORY.md`)。
- **【kickoff 必审 · 自传播规则】收口时若写了下一会话的 kickoff(沿用「带下一里程碑 kickoff」约定):必须用 workflow 多维对抗审查那份新 kickoff(维度至少:① 代码事实准确性——逐条对照真实 merged 代码的 file:line,② 范围完整性——对照 memory 残留/待办无遗漏无误分类,③ 自包含与引用正确——memory/文档路径真实存在、runbook 可执行、红线齐全),修掉确认项再交付。kickoff 里写错 file:line / 过时论断会误导下个会话。并把这条「kickoff 必审 · 自传播规则」原样写进你产出的新 kickoff,使之后每一份 kickoff 都被审。(本份 M4 kickoff 已按此审过。)**

## 委派决策(默认委派,自己做是例外)
| 工作类型 | 交给谁 |
|---|---|
| 调研 / 摸清 authz 解耦点 / web settings 结构 / 定位代码 | **Explore** sub-agent(只读,返回 file:line + 结论) |
| 多文件实现 / 可并行改动 | **workflow** 或并行 sub-agent(互不重叠文件并行;集成枢纽 bot.ts / callbackAuth / web settings 单 agent 串行——M2b/M3a/M3b 都踩过两 agent 同改一枢纽文件的坑),你只读结构化返回 |
| 跑 typecheck / lint / 测试 | sub-agent 执行,**只回结论**(`pnpm --filter @t3tools/feishu-bot run typecheck` 与 `pnpm exec vp check apps/feishu-bot`;动 web 则 `apps/web` typecheck;失败先 `pnpm exec vp fmt <pkg>`) |
| 代码 review(**尤其 authz/callbackAuth 解耦**) | **workflow** 多维独立审查 + 对抗验证(对每条发现默认怀疑、查是否已处理再采纳);authz 红线必须单独一维深审 |
| authz 解耦方案 / web UI 设计 / 拆 PR 决策 / 与用户确认 | **你自己** |
| 一两行明确改动 / 读单个小文件确认一个事实 / 对话 | 你自己(例外) |

并行的独立调研/实现放在**同一条消息**里扇出,别串行等待。

## 每个里程碑的闭环(不可跳步)
1. **Plan** — 先用 Explore 摸清 authz 解耦点 + web settings + 飞书登录,**产出 authz 解耦方案(payload.o 怎么改最小且不破 HMAC/nonce/fingerprint)+ web UI 方案 + 拆 PR 与用户确认范围后再动手**。别直接开写。**authz 解耦方案务必先独立对抗审查**(红线区)。
2. **Implement** — workflow / sub-agent(互不重叠文件并行;callbackAuth / bot.ts / web settings 集成枢纽单 agent 串行)。
3. **Test** — typecheck + `vp check` **必须全过**(+ 动 web/client-runtime 则 web/mobile typecheck),失败回 Implement。
4. **Review** — workflow 多维独立审查 + 对抗验证,维度至少含:正确性 / **authz 解耦正确(N 选一放行、越权拒绝)** / **callbackAuth verify 五项 + HMAC + nonce + policyFingerprint 算法字节级未变(红线,单独一维深审)** / web↔server↔bot 配置一致 / 不破 M3a/M3b 不变式(density / 话题投递 / 路由)。
5. **Fix** — 修 review 确认为真的问题,重跑 Test。
6. **Confirm** — 向用户简洁汇报。**真连接 e2e 必跑**:**多账号群**验「白名单内任一人可批 / 白名单外越权被拒 / web 配置实时生效 / 飞书登录绑定」(见下「需要用户提供」)。

## 项目硬约束(违反即未完成)
- **bridge 是薄共享客户端**:白名单 + 飞书身份是 **server 端共享配置**,web 配、server 存、bot 读;**不在 bot 加配置**(env `FEISHU_OWNER_OPEN_IDS` 降级为逃生口/默认,与 store 取并集)。
- **callbackAuth 红线**:verify 五项 r/s/c/o/fp 的**算法 / HMAC 覆盖 / nonce 单消费 / policyFingerprint 计算绝对不动**;authz 是叠加在 verify **之上**的成员判定层。**绝不加 wildcard 旁路、绝不弱化 verify**。改 `o` 项的任何方案必须独立审查确认不破完整性保证。
- **不破坏 M2b/M3a/M3b 既有不变式**:density 三档 + 话题投递(`topicAnchorMessageId` reply_in_thread)+ M3a 路由(`anchorOf`/`compositeChatKey` 零 re-bind)+ `renderThreadCard` 契约 + driveTurn/observe 两路径 + CardHandle 去重 + processGuard 一律不动。
- **CardKit**:绝不 checkbox、绝不嵌套 collapsible、clampElement 30KB、整卡 patch 节流。
- **健壮性**:任何卡片/SDK/快照/authz 查询错误绝不崩 bot 进程;多账号群并发下行为可预测。
- 不 `import` `.repos/` 下 vendored 代码;写 Effect 代码先看 `.repos/effect-smol/LLMS.md`。client-runtime 只能子路径 import。重复逻辑抽共享。
- 提交/推送只在用户明确要求时做。**M4 从 main 新开分支 `feishu-bridge-m4`(先确认上方「前置」:PR #9 已合 main,否则从 `feishu-bridge-m3b` 拉)**,逐(子)里程碑 PR(commit → push origin → `gh pr create --repo litchi98/t3code --base main` → 用户确认后 squash 合并)。

## M4 范围(Plan 阶段与用户敲定确切边界)
核心:**多审批人白名单 + web 飞书配置**。候选清单(与用户拍板,**倾向拆多个 PR**:authz 后端先行、web UI 次之):
- ① **authz 解耦 + 多审批人白名单(后端)**:`resolveApprover`/`buildInteraction`/`callbackAuth` 从单值 o 匹配 → allowlist 成员判定(红线核心,最谨慎);server authz store 存白名单;env `FEISHU_OWNER_OPEN_IDS` 与 store 并集。**根治 M3b owner 死锁限制。**
- ② **web settings 飞书栏目**:加「飞书」配置 tab;配审批白名单(增删飞书 openId/用户)。
- ③ **飞书登录授权**:web 上飞书 OAuth 登录 → 拿 openId → 绑 web 用户 → 写 authz store(机制 Explore 证实)。
- ④ 可选:审批白名单变更的审计 / 多审批人时审批卡回显「由 @X(白名单)批准」。

## 明确不在范围
- **模型 extended-thinking reasoning 显示**(t3code 核心 gap,另立项;见 `feishu-bridge-m2-todos.md` 纠错条)。
- `compareActivitiesByOrder` 跨包去重(M2b-4 技术债,独立 PR)。
- 话题内免 @ 续聊(需群消息权限,产品决策,另议)。
- M3b 暂缓的 **D3 SECONDARY grace race / D4 planner✅闪现 polish**(与 M4 无关,若要做另立小项;D4 注意「拒绝 completed→running」会破坏链式 subagent)。

## 需要用户提供
**可验「多审批人 + web 配置 + 飞书登录」的 e2e 环境**:沿用 M3b runbook(干净 `T3CODE_HOME=~/.t3-feishu-m4` 的 `serve` 自带 web + 浏览器 + 飞书 bot;`<HOME>/userdata/settings.json` 写 `{"enableAssistantStreaming":true}`),外加**多个飞书账号**(验白名单内任一人可批 / 白名单外越权被拒)+ **web 端飞书登录授权流程**。bot 改代码需重启(`pkill -f 'src/main.ts'` → 新 pairing token `node apps/server/src/bin.ts auth pairing create`(同 `T3CODE_HOME`) → 同 `T3_STATE_DIR` 重起,别用 dev;`T3_HTTP_BASE_URL=http://127.0.0.1:3773` + `T3_MODEL=opus` + `T3_WORKSPACE_ROOT=<scratch ws>`;config 不自动读 .env,启动 `set -a; . apps/feishu-bot/.env; set +a`)。多审批人测试**必须配白名单**(否则回退发起人)。**收口后须 kill server+bot 清理。**

## 起步:M4 第一动作
**先派 Explore sub-agent**(同一条消息扇出):(a) callbackAuth authz 解耦点(verify 五项 + o 项怎么改成 allowlist 最小且不破 HMAC/nonce/fingerprint);(b) resolveApprover/buildInteraction 注入链;(c) web settings 结构 + 加飞书栏目;(d) server authz store + 飞书登录机制。**产出 authz 解耦方案 + web UI 方案 + 拆 PR,先对 authz 解耦方案独立对抗审查,再与我确认范围后动手。** 不要直接开写。

---

> 提示:这份提示词配合 memory(`feishu-bridge-m3b-impl-facts`、`feishu-bridge-m3a-impl-facts`、`feishu-bridge-m2b-impl-facts`、`feishu-bridge-goal`、`feishu-bridge-kickoff-review-rule`)+ 设计文档 `feishu-bridge-design.md` 使用,共同构成完整施工上下文。
