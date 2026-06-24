# 飞书（Lark）接入设计方案：作为 t3code 的共享会话客户端

> 状态：设计提案（待评审）
> 目标：把现有的"多端复用 coding agent 会话"能力扩展到飞书，使飞书能**真正接续**终端 / 移动端 / Web 开的同一个会话。

## 1. 目标与约束

- **真共享**：在飞书发消息，能接续你在终端开的那个对话；反之亦然。三端共享同一个 `threadId`。
- **可拓展、可维护**：复用 t3code 既有的连接 / 接续 / 状态机制，与 web / mobile 走同一套 `client-runtime`，而非另起炉灶维护第二套会话体系。
- **借鉴而不照搬** `lark-coding-agent-bridge`：只取它的"飞书 bot 打通"经验（`@larksuite/channel` 长连接、CardKit 2.0 流式卡片、访问控制、斜杠命令），**丢弃它自己 spawn CLI + `--resume` 维护独立 session 的做法**——那套 session 与 t3code server 不互通。

## 2. 为什么不能照搬参考仓库

| | t3code | lark-coding-agent-bridge |
|---|---|---|
| 会话载体 | 常驻 server 持有 `ProviderSessionRuntime`，`threadId` 主键，存 SQLite | bridge 自己 spawn `claude -p` / `codex` 子进程 |
| 接续机制 | 客户端 WS `subscribeThread` 订阅（首帧完整 snapshot + 实时流） | 自己存 `chatId→sessionId`，`--resume` 恢复 |
| 多端共享 | 天生：多客户端订阅同一 `threadId`，server 广播 | 仅飞书内部 |

两边的 session ID 体系**不互通**。要真共享，飞书只能作为 **t3code server 的又一个客户端**接入，而不是自己跑 CLI。

## 3. 核心架构决策

飞书 bridge = 一个常驻 Node 进程，扮演**双重角色**：

1. **对飞书**：用 `@larksuite/channel` 维持 WebSocket 长连接，收 IM 消息 / 卡片交互，回流 CardKit 2.0 卡片。（借鉴参考仓库）
2. **对 t3code server**：作为一个 **headless 客户端**，复用 `packages/client-runtime` 连接到 server，`dispatchCommand` 发指令、`subscribeThread`/`subscribeShell` 收事件（snapshot+实时流；`replayEvents` 仅按需补增量，见 §9）。（复用本项目）

```
  飞书用户
    │  im.message / card.action          ┌──────────────────────────────┐
    ▼                                     │   t3code server (常驻)        │
┌─────────────────────────────┐          │  OrchestrationEngine          │
│  apps/feishu-bot (新增)      │          │   ├ ProviderSessionRuntime    │
│  ┌────────────────────────┐  │   WS RPC │   │  (threadId, SQLite)       │
│  │ Lark 接入层 (借鉴)     │  │  ◄─────► │   └ StreamDomainEvents (广播) │
│  │  @larksuite/channel    │  │ dispatch │  Provider drivers:            │
│  │  CardKit 渲染 / 命令   │  │ subscribe│   claude-agent-sdk / codex    │
│  └──────────┬─────────────┘  │ subscribe└───────────────┬──────────────┘
│  ┌──────────▼─────────────┐  │                          │ 同一 threadId
│  │ Bridge 核心            │  │          ┌───────────────┴──────────────┐
│  │  chat↔thread 映射      │  │          ▼                              ▼
│  │  event→card 渲染映射   │  │      终端客户端                  移动端客户端
│  └──────────┬─────────────┘  │      (同样 client-runtime)      (同样 client-runtime)
│  ┌──────────▼─────────────┐  │
│  │ Headless Platform 实现 │  │
│  │  (client-runtime 适配) │  │
│  └────────────────────────┘  │
└─────────────────────────────┘
```

## 4. 概念映射

| 飞书概念 | t3code 概念 | 说明 |
|---|---|---|
| chat（私聊 / 群） | project + thread | 私聊绑一个活跃 thread；群聊每个话题 = 一个 thread（见 §11A） |
| 话题群 thread（`chatId:threadId`） | 独立 thread | 每个飞书话题映射独立 t3code thread |
| 用户发一条消息 | `ClientThreadTurnStartCommand` | 启动一轮对话（带 prompt） |
| 点"停止"按钮 | `ThreadTurnInterruptCommand` | 打断当前 turn |
| 工具权限审批卡片 | `ThreadApprovalRespondCommand` | 回应 approval 请求 |
| 交互输入卡片 | `ThreadUserInputRespondCommand` | 回应 agent 的 user-input 请求 |
| `/new` 命令 | `ThreadCreateCommand` | 新建会话 |
| agent 输出（文本 / 工具调用 / diff） | `OrchestrationEvent` 流 | 渲染成 CardKit 卡片 |

> 证据：`packages/contracts/src/orchestration.ts:681` `ClientOrchestrationCommand` union；三个核心 RPC 见 `orchestration.ts:26-32` 与 `OrchestrationRpcSchemas`（`orchestration.ts:1222+`）。

## 5. 模块划分（新增 `apps/feishu-bot`）

```
apps/feishu-bot/
  src/
    lark/                  # 飞书接入层（借鉴 lark-coding-agent-bridge）
      channel.ts           #   @larksuite/channel 连接、事件循环
      pending-queue.ts     #   消息去重 / 批处理
      commands/            #   /new /cd /ws /status /resume ...
      card/                #   CardKit 2.0 渲染（见 §7）
      access.ts            #   访问控制（owner/admin/allow/deny）
    bridge/                # 桥接核心（本项目自有）
      chatThreadMap.ts     #   飞书 chat ↔ t3code threadId 持久化映射
      commandTranslator.ts #   飞书动作 → ClientOrchestrationCommand
      eventRenderer.ts     #   OrchestrationEvent → CardKit 卡片状态机
    runtime/               # headless 客户端运行时
      platform.ts          #   实现 client-runtime 平台 Service（见 §6）
      storage.ts           #   ConnectionTargetStore/CacheStore 的 SQLite/文件实现
      auth.ts              #   pairing→token→ws-ticket 握手（见 §8）
    config/                # profile / secret / 配置
    bin.ts                 # CLI 入口（run/start/stop/status）
```

**复用关系**：`apps/feishu-bot` 依赖 `packages/client-runtime`（连接 / 接续 / 状态）、`packages/contracts`（RPC schema）、`packages/shared`。飞书接入层从参考仓库移植并改造。

## 6. Headless Platform 实现清单

`client-runtime` 依赖一组 Effect `Context.Service`（`packages/client-runtime/src/platform/`）。headless 客户端的最小实现（对照 `apps/web/src/connection/platform.ts` 与 `apps/mobile/src/connection/platform.ts`）：

| Service | headless 实现 |
|---|---|
| `CloudSession.clerkToken` | 若用 relay 中继：注入预取 token；若直连 server：可不需要 |
| `RelayDeviceIdentity.deviceId` | 固定 botId 或 `Option.none()` |
| `ClientPresentation` | `deviceType: "bot"`，`scopes: ["orchestration:read","orchestration:operate"]`（按需加 `terminal:operate`） |
| `PrimaryEnvironmentAuth.bearerToken` | 远程接入返回 `Option.none()`；本机直连可注入 bearer |
| `SshEnvironmentGateway` | 三个方法均返回 `unsupported`（同 mobile） |
| `ConnectionTargetStore` | 从配置读取目标 server 列表 |
| `ConnectionRegistrationStore` | SQLite / 文件持久化连接配置 |
| `EnvironmentCacheStore` | SQLite 缓存 shell / thread 快照，支撑断线回放 |
| `PlatformConnectionSource` | 返回固定的一个环境（或 `Stream.empty`） |

> 浏览器 / RN 专属的部分（IndexedDB、AsyncStorage、`navigator.onLine`、`expo-network`、`visibilitychange`）需替换为 Node 等价物（SQLite / 文件、`net` 探测、定时心跳）。`SshEnvironmentGateway` 仅桌面需要，headless 直接 unsupported。

## 7. 事件渲染：`OrchestrationEvent` → CardKit 2.0

- 复用参考仓库的 `RunState` reducer + 卡片流式更新思路（`channel.stream()` producer 持续 `update()`，序号保序）。
- **但事件 schema 不同**，需重写映射：t3code 的 `OrchestrationThreadStreamItem` 比参考仓库的 `AgentEvent` 丰富得多（turn、approval、user-input、diff、terminal、vcs…）。
- 取舍：飞书卡片承载**对话流 + 工具调用摘要 + 关键状态 + 审批/输入交互**；完整 IDE 能力（文件树、完整 diff、终端）不强求塞进卡片，必要时给一句"在终端 / Web 端查看完整内容"的引导 + 深链。
- **CardKit 硬约束（审查重点，必做）**：单 element 序列化超 ~30KB 会触发飞书 400、**abort 整条流式卡片**（参考仓库 `run-renderer.ts:116` 已记录）。`eventRenderer` 状态机必须「每 element 渲染前估字节、超阈降级折叠/截断」（移植参考仓库 `collapsedToolSummary`、reasoning 截断、≥3 工具折叠）。t3code 的 diff/terminal/长文本比参考仓库更易撞限——这是渲染层第一约束，非「截断+深链」一句话能带过。`ThreadTurnDiff.diff` 是单个无界字符串、无截断元数据，bridge 要按 hunk 边界自截并防 OOM。
- **附件 image-only（审查修正）**：t3code `UploadChatAttachment` 仅 `image/*`（≤10MB、data URL ≤14M 字符、单轮 ≤8 张，超限 server 拒整条 turn）。飞书的 PDF/源码/日志等**非图片文件无 attachment 通道**，需旁路（落盘到 project workspace 再在 prompt 引用路径，或给可访问 URL 让 agent 工具拉取）；agent 产出文件→飞书走 `getTurnDiff`/文件读取，非 attachment 协议。

## 7A. 卡片内容设计

### t3code 内容载体 → 卡片分区
一个 turn 的内容分散在 thread snapshot 的三处，`eventRenderer` 把它们组装进**一张随 turn 流式更新的卡片**：

| t3code 来源 | 内容 | 卡片分区 | CardKit 组件 | 渲染策略 |
|---|---|---|---|---|
| `thread.title` + project + branch + `runtimeMode` | 会话上下文 | **Header + 副标题** | header（带状态色）+ markdown | 常驻；显示 `仓库 · 分支 · 权限档` |
| `activities` tone=`info`/kind 含 reasoning（`reasoning_text` / `reasoning_summary_text`） | 思考 | **思考折叠面板** | `collapsible_panel` | 默认折叠（active 时展开）；**优先 summary**；`truncate(~1500)` |
| `messages` role=`assistant`（`streaming`，`assistant.delta`） | 正文回复 | **主正文** | markdown | 流式 `update()` |
| `activities` tone=`tool`（command_execution/file_change/mcp_tool_call/web_search…） | 工具调用 | **每工具一个折叠面板** | `collapsible_panel` | 状态图标+边框色（error=红）；输出截断；≥N 个折叠旧的 |
| `getTurnDiff` / file_change | 文件改动/diff | 折叠面板 or 深链 | panel / 链接 | 小 diff 内联、大 diff 给深链 |
| `proposedPlans` | 方案（plan 模式） | **方案区** | markdown + 按钮 | 「采纳/修改」按钮 |
| `activities` tone=`approval`（`hasPendingApprovals`） | 工具审批 | **交互区** | button | 「允许/拒绝」→ `ApprovalRespond` |
| `hasPendingUserInput` | agent 反问 | **交互区** | form/button | → `UserInputRespond` |
| `session.status` + `activeTurnId` | 运行状态 | **Footer** | note | 🧠思考中 / ⚙️工具运行 / ✍️输出中 / ✅完成 / ❌失败 |
| `thread.token-usage.updated` | 用量 | Footer 小字 | note | 可选（见盲区 A 成本） |
| activeTurn 存在 | 停止 | **Action bar** | danger button | → `TurnInterrupt` |

### 整体布局（card 模式）
```
┌──────────────────────────────────────────┐
│ ⟳ 修复登录 bug            [会话标题/状态色] │  Header
│ 📁 t3code · 🌿 main · 🔒 approval-required │  副标题(context)
├──────────────────────────────────────────┤
│ 🧠 思考完成，点击查看 ▸        (默认折叠)   │  reasoning panel
├──────────────────────────────────────────┤
│ ⚙️ Bash `npm test` ✅ ▸                     │  tool panels
│ ⚙️ Edit `auth.ts` ✅ ▸                       │  (折叠, 当前活跃展开)
├──────────────────────────────────────────┤
│ 已定位到问题：token 过期未刷新… (流式正文)  │  assistant markdown
├──────────────────────────────────────────┤
│ ⚠️ 需批准：执行 `rm -rf dist`               │  交互区(pending approval)
│ [ 允许 ]  [ 拒绝 ]                           │
├──────────────────────────────────────────┤
│ _⚙️ 工具运行中…_           · 1.2k tok       │  Footer
│ [ ⏹ 停止 ]                                  │  Action bar
└──────────────────────────────────────────┘
```

### 按 turn 阶段的形态切换
footer + 面板随 `session.status`/activity 流转：**思考中**（🧠 reasoning 面板展开、footer「正在思考」）→ **工具运行**（⚙️ 当前工具面板展开、footer「工具运行中」）→ **输出中**（✍️ 正文流式）→ **等审批**（⚠️ 交互区+按钮，footer「等待批准」）→ **完成/失败**（✅/❌，reasoning+工具全折叠收起，停止按钮消失）。

### 渲染硬原则（结合 §7 的 30KB 约束）
1. **折叠优先**：reasoning、工具默认折叠，只展开「当前活跃」一个——控高度 + 规避 30KB。
2. **每 element 估字节降级**：超阈截断/折叠/转深链，绝不让单 element >~30KB（否则 400 abort 整条流）。
3. **优先 summary、大输出深链**：reasoning 用 `reasoning_summary_text`；大 diff/长输出给「在 Web/终端看完整」深链。
4. **可配置密度**（preference）：参考仓库 `messageReply` 三档——`card`（完整，含 reasoning+工具面板）/ `markdown`（轻量流式，无面板）/ `text`（结束一次性发，**丢弃 reasoning**，避免噪声）。
5. **reasoning 默认折叠（已定）**：思考中展开为「🧠 思考中…▾」，完成自动收起为「🧠 思考完成，点击查看 ▸」；优先 summary。
6. **群聊降噪（已定）**：群聊只渲染正文 + 工具**摘要行**（不展开输出）+ 最终结果，**隐藏 reasoning 面板与工具详细输出**；私聊用完整卡片。兼顾减噪与隐私（群里少暴露代码细节，呼应 §11E 群聊可见性）。

### 结构化提问（AskUserQuestion / Codex 选项弹窗）→ 飞书选择卡片
t3code 把 **Claude Code 的 AskUserQuestion** 和 **Codex 的选项弹窗**统一成 `user-input.requested`（`providerRuntime.ts:441` `UserInputQuestion`），结构与 AskUserQuestion 同构：`{id, header, question, options:[{label, description}], multiSelect}`，payload 可含**多个 questions**。映射：

| 形态 | 飞书组件 | 回传 |
|---|---|---|
| 单问题·单选 | **按钮组**（每 option 一个 callback button，label=文字、description=旁注），点击即答、无需提交 | `{act:"user-input", requestId, questionId, label}` |
| 单问题·多选 / 多问题 | CardKit **`form`**（`checkbox` / `select_static`）+ 提交按钮 | `form_value` 一次性回传 |
| 「其他/自定义」 | 附加 `input` 框（`answers` 是 `Record<string,Unknown>`，容纳自由文本） | 同上 |

- 提交 → `ThreadUserInputRespondCommand { requestId, answers: {questionId: 选中值} }`，复用 §11B 的签名+nonce 鉴权。
- **跨端交接成立**：pending user-input 同 approval 物化在 snapshot（`hasPendingUserInput`），电脑弹出的提问转飞书也能答（同 §11E 场景①）。
- 与工具审批的区别：审批是 yes/no（`ApprovalRespond`），这是结构化多选项问答（`UserInputRespond`）——两类不同交互，卡片各用各的组件。

## 8. 鉴权握手（无人值守机器客户端）

推荐 **pairing → token-exchange → ws-ticket**（端点见 `apps/server/src/auth/http.ts`）：

```
1. 管理员一次性签发 pairing 凭证
     POST /api/auth/pairing/credential   (admin bearer)
     scopes: ["orchestration:read","orchestration:operate"]
2. bridge 用 pairing 换长期 access token
     POST /oauth/token  (grant_type=token-exchange, subject_token=<pairing>)
     → access_token (固定 30 天 TTL，不可按请求调整)
3. bridge 用 access token 换一次性 WS ticket
     POST /api/auth/websocket-ticket  (Bearer access_token)
     → ticket
4. 建立 WS
     GET /ws?wsTicket=<ticket>
5. subscribeThread（首帧即该 thread 完整 snapshot）→ dispatchCommand
```

- access token 持久化到 secret store（SecretRef：env / file / exec，高敏感建议 OS keychain）。
- **续期（审查修正）**：pairing 凭证**一次性、默认 5 分钟过期、无 refresh_token**；access token 固定 30 天不可调。故**无法「到期前自动用 pairing 续期」**——改为**到期前主动告警**（飞书通知管理员重新 `/pair`）；或评估暴露 `ttl` 入参签发长 TTL pairing / 改用 `issueSession` 签发带 ttl 的 bot bearer 会话。
- **headless 用 bearer，不用 DPoP（审查修正）**：DPoP 带 token 时硬编码 1h TTL 且无续期，对无人值守 bridge 不可用。
- **scope 现实（审查修正）**：orchestration 仅 `read`/`operate` 两档，所有写/执行/回滚共用 `operate`（无法更细分）；server 只见 bot 一个 principal、不记飞书发起人。审计 / 越权拦截 / per-user 吊销责任全在 bridge（见 §11E）。scope 定义见 `packages/contracts/src/auth.ts`。

> 注：上面的端点名以 `apps/server/src/auth/http.ts` 实际 handler 为准（`pairingCredential` / `token` / `webSocketTicket` / `browserSession`），实现时需逐一对齐真实路由与 schema。

## 9. 会话发现与接续

- **接续已有会话**：飞书 chat 首次绑定时，把 `chatId → threadId` 写入 `chatThreadMap`。之后该 chat 的消息 `dispatchCommand(threadId, ThreadTurnStart)`，server 接续 `ProviderSessionRuntime`。
- **断线重连（审查修正）**：真实机制**不是 `replayEvents` 补齐**，而是 `client-runtime` 的 supervisor 在新连接上**重新 `subscribeThread`、server 首帧重发完整 thread snapshot** 再接实时流（`subscribeThread` 入参只有 threadId、无 sequence 游标；`replayEvents` 在 client-runtime/web/mobile 零调用）。对 web/mobile（reducer 幂等替换）透明；但 bridge 渲染流式卡片要自己处理「收到的是全量 snapshot 而非 delta」——要么把 snapshot 当「重建/刷新卡片」（推荐，与 `/resume` 全量重建一致），要么自持久化每个已接管 thread 的 `lastSequence`、重连后显式 `replayEvents(fromSequenceExclusive=lastSequence)` 拉增量再 append。**这是 bridge 必做项，非「免费复用」。**
- **列举可接续的 thread（审查修正）**：**活跃会话**用 `subscribeShell`（首帧 `OrchestrationShellSnapshot` 含活跃 projects+threads）/ 复用 `client-runtime` 的 `state/shell.ts`；`getArchivedShellSnapshot` 只返回**已归档**会话（会漏掉终端正开着、最想接管的活跃 thread——核心卖点所在）。`replayEvents` 是**全局事件日志**（跨所有 thread、无 threadId 入参），不适合做 per-thread 历史或 shell 列表。
- **新建会话**：`/new` → `ThreadCreateCommand`。

## 10. 可直接复用 / 参考的文件

| 用途 | 文件 |
|---|---|
| 平台 Service 接口 | `packages/client-runtime/src/platform/{capabilities,persistence,source}.ts` |
| 连接 / 重连 / 订阅 | `packages/client-runtime/src/connection/`（supervisor、driver、registry）；`state/shell.ts`、`state/threads.ts` |
| token / ticket 交换 | `packages/client-runtime/src/authorization/remote.ts` |
| RPC schema | `packages/contracts/src/orchestration.ts`、`auth.ts` |
| web 平台实现参考 | `apps/web/src/connection/platform.ts`、`storage.ts` |
| mobile 平台实现参考（headless 更接近） | `apps/mobile/src/connection/platform.ts` |
| server 鉴权端点 | `apps/server/src/auth/http.ts` |
| 飞书接入层移植源 | `lark-coding-agent-bridge/src/bot/`、`src/card/`、`src/commands/` |

## 11. 分阶段实施计划

- **M0 — 打通最小回路（验证可行性）**：headless 客户端连上本机 server，CLI 里手动 `dispatchCommand` 发一句 prompt，`subscribeThread` 收事件并打印。不涉及飞书。验证 §6 platform + §8 鉴权。
- **M1 — 飞书单聊 MVP**：接入 `@larksuite/channel`，私聊消息 → ThreadTurnStart，agent 文本输出 → markdown 卡片流式回复。一个 chat 固定绑一个 thread。
- **M2 — 真共享验证**：终端开会话，飞书 `/resume` 接续同一 `threadId`，双向看到彼此消息。这是核心目标的验收点。
- **M3 — 富交互**：工具调用展示、approval / user-input 卡片按钮、停止按钮、`/cd` `/ws` `/new` 命令、群聊 + @ 提及 + 话题群。
- **M4 — 运维**：访问控制、多 profile、daemon（launchd/systemd）、断线重连健壮性、日志 / 遥测。

## 11A. 产品交互设计（已敲定决策）

### 同步策略：懒同步 / 按需接管
- bridge **默认不订阅任何 thread**。你在终端 / Web 开的会话，飞书**完全静默**。
- 只有当你在飞书里 `/resume` 接管某个 thread 后，bridge 才对它 `subscribeThread`（首帧即该 thread 完整 snapshot，无需再叠 `replayEvents(0)`），并开始实时同步。
- 体验上等价于 Slack「thread 内才有上下文」：未接管 = 安静，接管 = 拉进飞书话题续聊。飞书定位是「异步通知 + 远程接管」入口，而非全量镜像刷屏。

### 会话 ↔ 飞书映射（参考 Claude 官方 Slack「线程=会话」模型）
- **私聊**：维持一个「当前活跃 thread」+ `/resume` 切换 + `/new` 开新。1:1 专注单会话。
- **群聊**：**飞书话题（topic）= 一个 t3code thread**，`@bot` 触发；话题内续聊 = 同会话，不同话题 = 不同会话（参考仓库已有 `chatId:threadId` 隔离）。
  - **话题内卡片已验证可行**（参考仓库生产在用）：流式卡片 `channel.stream(..., sendOpts)` + 卡片更新 + 按钮交互在话题内全 work。两个实现要点：① 发卡片须带 `replyInThread:true`+`replyTo`（`channel.ts:681`），否则不落话题；② 卡片回调事件不带话题 `threadId`，需 `channel.fetchRawMessage(messageId)` 取 raw `thread_id`（`dispatcher.ts:153`，**必须 raw 接口**，normalize 过的会丢 thread_id），即每次话题内卡片回调多一次 API 调用。
- 心智：**一个飞书群 = 一个仓库（project）**，群里话题 = 该仓库下的多个会话。卡片标题常驻显示 `仓库 · 分支 · worktree`。
- **t3code 的差异化优势**：官方 Slack 只能「跳回 web 看会话」、Discord channels 不支持跨端接续；t3code 因 server 持久持有 session，飞书能做到**真·跨端接续**（终端开的会话飞书直接续聊）。这是核心卖点，官方目前无等价能力。

### 群聊执行权限：默认 approval-required + 显式提权
- **（审查修正）`RuntimeMode` 没有 read-only 值**——只有 `approval-required` / `auto-accept-edits` / `full-access`（`orchestration.ts:117`），系统默认是最危险的 `full-access` 且字段**必填**。`read-only` 属于另一条正交轴 `ProviderSandboxMode`，未在 server 编排接线。
- 因此「群默认收紧」改用 `runtimeMode = approval-required` 表达（每个写/执行动作弹审批卡片），提权 = 切 `auto-accept-edits` / `full-access`。
- `commandTranslator` 必须为每个 turn **显式写死**群/私聊默认 `runtimeMode`（字段必填，不能靠省略）；私聊「沿用默认」需先读 `OrchestrationThread.runtimeMode` 再回填。
- 若产品确需「群里完全不能改」的真只读，server 不提供该保证，需 bridge 层拦截（禁止触发写工具的 prompt）。
- 理由：群是多人空间，避免任意成员驱动 agent 改私有仓库。

### 一次发多条消息
- **空闲连发（消息雨）**：600ms 窗口合并成一条 prompt（参考仓库 `PendingQueue`）。
- **turn 运行中又发**：**对齐 t3code 官方语义**——web/mobile 在 `session.status==="running"` 时**直接禁用 composer**（`ChatComposer` `phase==="running"` 禁发，`session-logic.ts:1381` `derivePhase`），既不排队也不 steer。飞书是 IM 无法禁用输入框，故等价做法是 **bridge 排队**：运行中 hold 后续消息，turn 结束再串行 dispatch（卡片提示「已收到 N 条，将在当前回合结束后发送」）。
  - ⚠️ **不能 naive 透传（审查修正）**：server 不排队，运行中再发 `turn.start` 会被 Claude **steer 进当前 turn** / Codex **覆盖 activeTurn**（`ClaudeAdapter.sendTurn` / `CodexSessionRuntime.sendTurn`），绝非排队。排队责任在 bridge。
  - 「停止」按钮走 `ThreadTurnInterruptCommand`；「取消某条排队消息」是 bridge 本地队列移除——两条不同链路、卡片给两类按钮。
  - 可选：借 `interactionMode="plan"`（agent 先出方案再确认）做飞书 `/plan` 模式（与 `runtimeMode` 正交：前者控规划、后者控放权）。

## 11B. 卡片交互回传（按钮 / 表单 → t3code command）

### 链路
用户点按钮 → `@larksuite/channel` 触发 `cardAction` 事件（payload: `action.value`、`operator.openId`、`chatId`、`messageId`、`raw.action.form_value`）→ bridge 验签 → 按动作类型路由 → 构造 `ClientOrchestrationCommand` → `dispatchCommand` → `updateCardById` 反馈。

### 按钮 value → command 映射（结构化，t3code 特有）

| 飞书卡片组件 | 按钮 value 编码 | → t3code command |
|---|---|---|
| 工具审批「允许/拒绝」 | `{act:"approval", threadId, requestId, decision}` | `ThreadApprovalRespondCommand`（`requestId` + `ProviderApprovalDecision`） |
| agent 反问提交 | `{act:"user-input", threadId, requestId}` + `form_value` | `ThreadUserInputRespondCommand`（answers 取自 `form_value`） |
| 停止 | `{act:"interrupt", threadId}` | `ThreadTurnInterruptCommand`（server 按 session 打断，**turnId 被忽略**，总是停当前活跃 turn） |
| `/resume` 选会话 | `{act:"resume", threadId}` | 绑定该 thread + `subscribeThread`（首帧 snapshot） |
| 切换仓库/分支 | `{act:"thread.create", projectId, branch}` | `ThreadCreateCommand` |

> **关键差异**：参考仓库把按钮点击当「合成消息 `[card-click]{...}`」塞回 CLI agent。t3code 不该这样——它的 approval/user-input 是带 `requestId` 的结构化协议，按钮直接映射成 `ThreadApprovalRespond` / `ThreadUserInputRespond`，agent 精确知道回应哪个请求，比解析自由文本可靠。

### 鉴权防重放（参考仓库方案成熟，直接搬）
按钮 value 带 HMAC 签名 token（`bridge_cb.v1.<payload>.<sig>`），payload 含 `runId/scope/operator/action/exp/nonce/keyVersion` + **policyFingerprint**：
- 防伪造：HMAC-SHA256 timing-safe 比对
- 防重放：一次性 nonce，持久化磁盘，重启仍有效
- 防过期：`exp`（参考仓库 24h）
- 权限变化即失效：`policyFingerprint` 入签名，用户被移出 allowlist 后旧按钮自动作废
- 密钥轮换：`keyVersion`

飞书多人 IM 场景下这套是必需的：保证「只有有权的人、有效期内、点一次」才能触发危险操作。

参考实现：`lark-coding-agent-bridge/src/card/{dispatcher,callback-auth,callback-store,run-renderer}.ts`、`src/bot/channel.ts`（`cardAction` 注册）。

## 11C. 必须覆盖的边界场景（总览，详见各节）

| # | 场景 | 处理 / 详见 |
|---|---|---|
| a | 工具审批（必做否则 turn 挂死） | §7A 交互区、§11B、§11E 场景① |
| b | agent 反问 user-input | §7A 结构化提问、§11B |
| c | 附件双向（仅 `image/*`，非图片文件需旁路） | §7 附件 image-only |
| d | 长输出 / 大 diff 超卡片容量 | §7 CardKit 30KB、§7A 渲染原则 |
| e | server 离线消息不丢 | §11E 补偿层「出/入站消息不丢」 |
| f | 群聊隐私（私有代码群可见） | §11A 群聊降噪、§11E 群聊可见性 |
| g | 多端并发同一 thread | §11E「共享非独占」、§11E stale approval |
| h | bridge 重启恢复 | §11E 补偿层「重启恢复」 |
| i | 身份审计（记 `operatorOpenId`） | §11E 补偿层「审计归属」 |
| j | 会话清理（archive / idle 超时） | §11E 补偿层「idle 退订」 |
| k | 多机器多 server 路由 | §12A 盲区；需 chat→`environmentId`→threadId 三级映射 |

## 11D. Reaction 状态标识 & 消息撤回

### 用 reaction 标识 turn 状态
把**触发 turn 的用户消息**当状态锚点，bot 按 t3code turn 生命周期事件给它打/换 emoji（`channel.addReaction`/`removeReaction` 确定可用，参考仓库 `src/bot/reaction.ts` 已用 `Typing`）：

| t3code 状态 | reaction | 时机 |
|---|---|---|
| 排队中 queued | ⏳ | 进队列 |
| 执行中 activeTurn | ⌨️ `Typing` | turn started |
| 完成 | ✅ `DONE`/`OK` | turn completed |
| 失败 | ❌ | turn error |
| 打断 | ⏹ | interrupt |

> **（审查修正）** 上表 ⏳⌨️✅❌⏹ 仅示意语义；实际须用飞书**具名 `emoji_type`**（参考仓库传字符串 `'Typing'`，非 unicode 字符）。换状态 = `removeReaction` 旧 + `addReaction` 新，需持久化 `reactionId`。

价值：每条 prompt 自带状态表情，在「一次发多条」场景里一眼区分 active / queued / done，不全靠卡片。reaction 是装饰，失败不得影响主回复流。
**可选反向增强**：用户打特定 emoji 触发动作（👍=approve、🚫=取消队列）——SDK **已确认支持**入站 `reaction` 事件（`@larksuite/channel@0.2.0` `EventMap.reaction`，含 added/removed，对应 `im.message.reaction.created/deleted`；参考仓库只是没接 handler）。正反向都可直接走 SDK；主路径仍建议用带签名的卡片按钮（更明确）。

### 消息撤回处理（SDK 不暴露 → 需原生 `im.message.recalled_v1` 订阅）

> **已验证**：`@larksuite/channel@0.2.0` 的 `EventMap` 为 `message/reject/cardAction/reaction/botAdded/comment/error/reconnecting/reconnected`，**无 recall 入站事件**；`recallMessage()` 仅出站（bot 撤自己的消息）。要响应**用户撤回 prompt**，须在 SDK 之外单独订阅飞书原生 `im.message.recalled_v1`（独立事件监听或 patch SDK）。若 recall 处理在范围内，M1+ 需排此项。

| 撤回消息对应 turn 状态 | 处理 |
|---|---|
| 排队中（未开始） | 从队列移除 + 清 reaction（「发错撤回」=别执行） |
| 执行中 | 触发 `ThreadTurnInterruptCommand` 打断 + 卡片提示；或保守提示「撤回无法回滚，请用停止按钮」 |
| 已完成 | 忽略（仅 IM 层），审计标记 |

**关键边界**：t3code 的 `ThreadCheckpointRevertCommand`（真正回滚 agent 改动）**不可由撤回隐式触发**——IM 撤回只做「取消排队/打断」，撤销已做改动走显式 revert 按钮/命令。群聊需校验撤回者身份（仅发起者/admin）。撤回事件可能延迟，按当下 turn 状态判定、幂等处理。
bot 主动 `channel.recallMessage()` 可用（清理过期卡片/错误回复），但会话卡片是历史，一般不撤。

## 11E. 双向交接语义 & bridge 必建的补偿层

### 重要前提：t3code 是「共享」不是「独占接管」
多客户端可同时订阅同一 thread，server 不做前台/独占仲裁。所以**「飞书接管」≠「电脑让出控制」**——接管只是飞书也加入这个 thread，电脑仍可用同一会话。若产品想要「一端接管时另一端只读/让出」的独占语义，server 不提供，需 bridge/产品层自建约束。

### 场景 ①：电脑触发 approval → 人走到飞书接手处理（已验证可行）
- agent 在电脑侧等待批准时，server 把 `approval.requested` 物化进 thread 的 `activities`，并在 shell 投影置 `hasPendingApprovals=true`。
- 用户飞书 `/resume` 接管 → bridge `subscribeThread` 拿到**完整 snapshot（含全部 activities）** → 用 `derivePendingApprovals(activities)`（`session-logic.ts:355`）解析出 pending 请求 → 渲染审批卡片 → 用户在飞书点「允许/拒绝」→ `ThreadApprovalRespondCommand`。
- **不依赖错过实时事件**：pending 状态物化在 snapshot 里，新接入者一订阅即可见。电脑端同时也会实时看到结果（共享）。
- 进阶（配合下方关键通知）：bridge 即便未接管、只订阅轻量 `subscribeShell`，靠 `hasPendingApprovals` 也能感知「某 thread 卡在审批」，主动 push 通知拉人来接管。

### 场景 ②：飞书接管 → 转回电脑（接管 → 静默）
- 飞书侧 `/release`（或离开话题）→ bridge 对该 thread `unsubscribeThread`、清理本地卡片/队列状态。thread 仍在 server，电脑端继续用，无需通知 server。
- 本质是 bridge 单方面退订，干净。注意清理已接管 thread 的订阅 fiber / 卡片句柄 / 排队，避免泄漏（见下「idle 退订」）。

### 关键通知通道（与懒同步并存，解决「最该通知的被静默」）
懒同步主体不变（终端会话默认静默），但 bridge **常驻一条轻量 `subscribeShell`**，对**已与飞书建立过关系的 chat 所绑定的 thread**，在以下关键节点即便未实时接管也 push 一条通知（@人 + 深链 + 「在飞书接管」按钮）：approval 待处理（`hasPendingApprovals`）、turn 失败、（可选）危险写操作完成。普通过程输出仍不推。

### bridge 必建的补偿层（server 不兜底清单 — 多处引用）
审查的核心结论：以下能力 **server / client-runtime 都不提供**，必须 bridge 自建。按里程碑排期：

| 能力 | server 现状 | bridge 责任 |
|---|---|---|
| turn 排队 | 不排队（steer/覆盖） | 监听 turn 生命周期，运行中 hold、结束后串行发（§11A） |
| 出站消息不丢 | 离线时 `dispatch` 直接报错、无缓冲 | 收消息落库→回执→`connected` 时 flush（含离线堆积合并/超 TTL 丢弃） |
| 入站消息不丢 | 飞书长连接无 offset/replay | 重连后提示重发，或 `im.v1.message.list` 按时间窗补拉 |
| 幂等 | 按 `commandId` 去重（可靠） | 对「同一意图」派生**稳定 commandId**（turn.start=`hash(chat+thread+飞书msgId)`，approval=`hash(requestId+decision)`），持久化已发 id |
| 审计归属 | 只见 bot 一个 principal、命令无 operator 字段 | 每条 dispatch 落不可变审计 `(operatorOpenId, chatId, threadId, command, ts)`，作为唯一合规来源 |
| 越权拦截 | scope 只有 read/operate，operate=全写 | allowlist + 群只读(approval-required) + 提权确认，全靠 bridge 自律 |
| stale approval | requestId 失效不报硬错、产 `*.respond.failed` 活动 | 订阅识别该活动，卡片更新「请求已失效」；按钮回传不假定 dispatch 成功=被采纳，等事件确认；同 requestId 点过即置灰 |
| 状态对账 | 他端 `thread-removed`/archive 只在 shell 流发 | 订阅 `subscribeShell` 的 removed/archive，失效本地映射并提示；`chatThreadMap` 写入与 `thread.create` 同 commandId 幂等、per-chat 串行化 |
| 卡片/reaction 重对齐 | snapshot 为权威 | 重连/序号跳变时以 `subscribeThread` snapshot 的 `activeTurnId`/pending 强制重渲卡片、校正 reaction |
| 重启恢复 | — | 持久化 `threadId/chatId/卡片messageId/activeTurnId/未决requestId/lastSequence`，重启读表→重连→snapshot 校正→对 awaiting-approval 重渲审批卡片；接不回旧卡片则新发+旧卡标失效 |
| idle 退订 | server 无自动 reap | bridge 自实现 idle 退订（省资源），但**不隐式 archive**（改状态是 server 侧动作） |
| createdAt 时间线 | 直接用 command.createdAt 作权威 occurredAt | 一律 UTC ISO-8601（用 client-runtime 默认 builder），**禁止**直接拿飞书 `create_time(ms)`；握手后做一次时钟偏移校准 |

## 12. 风险与取舍

1. **事件渲染工作量**：`OrchestrationEvent` schema 丰富，→ CardKit 的映射是主要工作量与持续维护点。建议先覆盖核心子集，增量扩展。
2. ~~**鉴权链路对齐**~~ **已验证**：`apps/server/src/auth/http.ts` 的 `browserSession` / `token`（`/oauth/token:58`，接受 `scope`/`client_label`/`client_device_type`/`client_os`，可选 DPoP）/ `webSocketTicket` / `pairingCredential`（需 `access:write`，默认 `AuthStandardClientScopes`）handler 均存在，与设计的 pairing→token-exchange→ws-ticket 一致。剩余工作仅是 headless 机器身份凭证的签发与续期策略。
3. ~~**`client-runtime` 的 Node 适配**~~ **已验证为低风险**：transport 是**注入**的——HTTP 走 `remoteHttpClientLayer(fetchFn)`（`rpc/http.ts:80`），WS 走 `Socket.WebSocketConstructor` Effect 服务（`rpc/session.ts:68,94`）。核心 connection/rpc/auth 无真实 DOM 耦合（早先 `window`/`document` 命中均为误报：本地变量名 / OS 路径检测 / 字符串字面量）；IndexedDB 等仅在 `apps/web`。Node 客户端只需提供 `fetch`（Node 22 全局）+ 一个 `WebSocketConstructor`（`ws` 包或 Node 全局）+ 平台 Service 实现，无需改核心。
4. **裸 RPC vs 复用 client-runtime**：本方案选复用 `client-runtime`（长期一致、好维护）。上条验证已大幅降低其风险，裸 RPC 退路基本可不考虑。
5. **飞书卡片表达力上限**：复杂 IDE 视图无法完整呈现，以"对话 + 摘要 + 深链回 Web/终端"为产品定位。
6. **入站事件能力**：reaction 入站事件 SDK 已支持；**消息撤回入站事件 SDK 不支持**，需原生 `im.message.recalled_v1` 订阅（见 §11D）。
7. **「server 不兜底」是最大隐含风险**：排队/消息不丢/幂等/审计/越权/截断/对账，server 都不做，全是 bridge 工程（见 §11E 清单）。把这些当既得能力会严重低估工作量。

## 12A. 完整性盲区（整类被忽略，详见审查报告）

> 完整审查报告：`docs/integrations/feishu-bridge-design-review.md`（52 发现/确认 47/10 盲区）。

- **【high】成本/配额归属**：t3code 发 `thread.token-usage.updated`，每 turn 烧可计量额度。多人共用一个 bridge 机器身份 = 共用一份账号额度，无 per-user 配额/归因，群里任何人可耗尽。需补 token 预算、用量上限提醒、usage 渲染回飞书。
- **【medium】国际版 Lark vs 中国版飞书**：两套隔离租户（不同 app_id/secret、域名 `open.larksuite.com`/`open.feishu.cn`、可能不同 CardKit/合规）。需明确目标版本与切换。
- **【medium】测试策略**：长连接/CardKit/approval 时序难单测，缺「契约 mock + 翻译层纯函数测试 + staging 租户冒烟」分层验证与 M0–M4 测试门禁。
- **【medium】灰度/回滚污染共享 thread**：bridge 单点写共享 thread，升级/回滚若改 commandId 或映射 schema 会在共享时间线留脏 turn 并波及终端/移动端真实用户。需灰度 + 隔离 + 「bridge bug 不损坏其他端」预案。
- **【medium】合规留存**：代码/diff 同存 t3code SQLite 与飞书两套留存，撤回只删 IM 不删 server、反向 server 删 thread 飞书仍留快照、离职成员可见、监管导出——未纳入。
- **【medium】并发规模/水平扩展**：单 bridge 并发 thread 上限、内存随订阅线性增长（大 diff 是 OOM 点）、超容拒绝还是多进程（多进程抢同一机器身份）——缺容量模型。
- **【low】i18n / 对现有 web/mobile 反向影响**：卡片文案硬编码中文；新增 `deviceType:'bot'` 客户端对既有端 presence/活跃判定/turn 归属的回归未评估。

## 13. 结论

**可行，方向正确**。架构地基经多维度审查站得住：headless 客户端复用 `client-runtime` + 同一 `threadId` 实现真·跨端共享，approval 等 pending 状态物化在 snapshot 里、新接入即可见（场景①已验证），多端共享非独占。

**但「做什么对，怎么做的细节失准」**：已修正多处事实错误（`/resume` 走 `subscribeShell` 非 `getArchivedShellSnapshot`、`RuntimeMode` 无 read-only、重连靠 `subscribeThread` snapshot 非 `replayEvents`、token 无自动续期、附件 image-only 等）。核心工作量除 (a) headless 适配 (b) 鉴权 (c) CardKit 渲染外，**第四块是 §11E 的「bridge 补偿层」**——server 不兜底的排队/消息不丢/幂等/审计/对账，是真正的工程主体。

建议仍从 **M0 最小回路**起步验证关键假设，再投入飞书接入层与补偿层。
```
