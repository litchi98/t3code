# 飞书 Bridge 批次 A「入站图片附件」kickoff(发图给 agent · 纯 bot-side)

> 本文**自包含**。承接最初设计文档 `docs/integrations/feishu-bridge-design.md` §7(附件 image-only)+ §11C-c(附件双向),把「飞书用户发图片 → 上传成 t3code attachment → 进 turn 让 agent 看到」细化到落地粒度。file:line 快照 **2026-07-09,main = `fbd41a15`(M-3 私聊密度已合入,#34)**。锚点由两路调研核实(feishu-bot 侧自读、t3code 端 attachment 全链 Explore 核实),动手前仍用 Explore 复核。

> ⚠️ **命名去歧义**:这是「未做功能分批推进」的**批次 A**(3 批方案:A=入站图片管道 / B=reaction 五态+token 用量 / C=撤回+入站 emoji;详见对话规划)。与 M-3 PR-A/B/C 系列**无关**——批次 A 不碰 per-chat config、不碰 toolPolicy、不碰审批链。

---

## 0. 硬前置(先核对,否则停)
- `git log --oneline -3` 应见 `fbd41a15 …私聊密度…(#34)` / `ba847bab …PR-C4…(#33)` / `9f97abab …pin-drift…(#32)`。
- 从 main(`fbd41a15`)新开分支(建议 `feat/feishu-batch-a-image-attachment`);**提交/推送只在用户明确要求时,开 PR 前确认**。
- **本批次 = 纯 bot-side(`apps/feishu-bot`),零契约改动**。契约层 `UploadChatImageAttachment` 已 surface(web/mobile 已在用),bot 只是**填充它**。不新增契约字段、不动 server/provider。这是批次 A 相对 PR-B 的最大优点。
- `pnpm --filter @t3tools/feishu-bot run typecheck` + `pnpm exec vp check apps/feishu-bot` + `pnpm exec vp test run apps/feishu-bot` 必过(权威命令见 `AGENTS.md`;失败先 `vp fmt`)。

## 1. 先读
- memory `MEMORY.md` → 尤其:
  - `feishu-bridge-m3-p2p-density-impl-facts`(最近一批,turnRunner/密度渲染现状 + 私聊语义);
  - `feishu-bridge-m3a-impl-facts`(群/话题路由 + `runtimeModeForChatType` + 消息雨合并语义);
  - `feishu-bot-refactor-split-impl-facts`(bot.ts/eventRenderer 拆分后模块地图,搬代码先读设计文档 §5 十五条不变量);
  - `feishu-bridge-e2e-pairing-token`(pairing token 现签 + 浏览器走 3773 + server-managed bot 免手起 + 未合入 web 先 rebuild dist);
  - `feishu-bridge-kickoff-review-rule` + `review-fanout-prefer-workflow`(本文末必审自传播规则来源 + 审查用 Workflow)。
- 最初设计文档 `feishu-bridge-design.md` §7(CardKit 附件 image-only + 非图片旁路)/§11C-c/§12A(成本盲区,与本批次无关但同属"当初规划")。
- `AGENTS.md`(权威 check/test/typecheck 命令)。

## 2. 已交付地基(动手前必须吸收的接线 + 可复用 seam)

### 2.1 目标契约(t3code 端已就位,bot 要对齐的形状)
- **上传态** `UploadChatImageAttachment`(`packages/contracts/src/orchestration.ts:165-174`):`{ type:"image", name(≤255), mimeType(≤100,`^image/`), sizeBytes(≤10MB), dataUrl(≤14M字符) }`。**无 `id`**(id 由 server 生成)。图片数据**只通过 `dataUrl`**(内含 base64)携带。这是 bot 要构造的目标结构。
- **turn 命令挂点**:`ClientThreadTurnStartCommand.message`(`orchestration.ts:600-617`)= `{ messageId, role:"user", text:Schema.String, attachments: UploadChatAttachment[] }`(`:604-609`)。attachments 挂在 **`message.attachments`**,元素类型 `UploadChatAttachment = Union([UploadChatImageAttachment])`(`:178`)。⚠ **`text` 无 maxLength、`message.attachments` 数组无 maxLength**——数量/字符上限不在这层(见 2.3),bot 必须自己预限。
- **限制常量**(`orchestration.ts:141-145`):`MAX_INPUT_CHARS=120_000` / `MAX_ATTACHMENTS=8` / `MAX_IMAGE_BYTES=10*1024*1024` / `MAX_IMAGE_DATA_URL_CHARS=14_000_000`。bot 从 `@t3tools/contracts` 直接 import 这些常量(已 export,勿硬编码数字)。

### 2.2 server 如何消费(决定 bot 的清洗策略 —— 因为**任一图不合规拒整条 turn**)
- **normalize**(`apps/server/src/orchestration/Normalizer.ts:72-143`):逐个 attachment `parseBase64DataUrl(dataUrl)`(`imageMime.ts:32-58`,正则要求 header 末段是 `base64`)→ mime 校验 `^image/`(`:77`)→ 大小 `非空 且 ≤10MB`(`:83`)→ 生成 id、落盘到 `serverConfig.attachmentsDir`、**剥 dataUrl 换 id** 返回 `ChatImageAttachment`。
- **⚠ 超限行为 = 整条 turn 被拒**:任一 attachment 失败即返回 `OrchestrationDispatchCommandError`,`normalizeDispatchCommand` 整体失败(`Normalizer.ts:78-88`)。**server 不会丢单张、不会降级**——所以清洗责任全在 bot:bot 必须在构造前把「超 8 张 / 超大 / mime 不支持 / dataUrl 超长」的图**自己剔除并 notice**,绝不把注定被拒的 payload 发出去(否则整轮连带文本一起挂)。
- **8 张 + 120k 硬上限的真实位置**:不在 Normalizer、不在 client 命令 schema,而在下游 `ProviderSendTurnInput`(`packages/contracts/src/provider.ts:67-78`):`attachments` 有 `isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS)`(`:73`)、`input` 有 `isMaxLength(MAX_INPUT_CHARS)`(`:70`)。→ bot 聚合后 **>8 张必须自截断**。
- **⚠ Claude 比契约更窄(关键陷阱)**:`SUPPORTED_CLAUDE_IMAGE_MIME_TYPES = {gif, jpeg, png, webp}`(`apps/server/src/provider/Layers/ClaudeAdapter.ts:882-887`)。svg/bmp/avif/heic 能过 Normalizer 落盘,但会在 `ClaudeAdapter.ts:958-963` 被拒 → `ProviderAdapterRequestError`(**发 turn 时才炸,更隐蔽**)。→ bot 应把 mimeType **直接限定在 `{png, jpeg, gif, webp}`**,不支持的当场剔除 + notice,别指望 server 兜。

### 2.3 编码范式(参考 mobile,不用 web 的 FileReader)
- web 用 `FileReader.readAsDataURL`(`apps/web/src/components/ChatView.logic.ts:161-176`)——**DOM 依赖,headless 不可用**。
- **mobile 是 bot 的模板**(`apps/mobile/src/lib/composerImages.ts`):`data:${mimeType};base64,${base64}`,base64 来自原生(`file.base64()` / picker `asset.base64`);`estimateBase64ByteSize`(`:15`)从 base64 长度反推字节。
- **bot 侧等价**:`const dataUrl = \`data:${mimeType};base64,${buffer.toString("base64")}\``(Node `Buffer` 现成)。`sizeBytes = buffer.byteLength`。

### 2.4 feishu-bot 现状接线(改动落点)
- **入站解析(已把图片捞出来了)**:`normalizeInbound`(`apps/feishu-bot/src/lark/channel.ts:196-203`)filter `resource.type === "image"` → `InboundAttachment{ kind:"image", fileKey, fileName? }`(定义 `lark/types.ts:43-47`);挂在 `InboundMessage.attachments`(`types.ts:83`)。⚠ **只有 `fileKey`/`fileName?`,没有 mime/size/字节**——数据要现下载。
- **下载能力(现成、零调用方)**:`downloadImage(messageId, fileKey) → Effect<Buffer>`(接口 `lark/index.ts:120-123`,实现 `lark/channel.ts:590-591` = `channel.downloadResource(messageId, fileKey, "image")`)。⚠ **需要 owning `messageId` + `fileKey` 配对**——聚合时必须保留每张图所属的 `message.messageId`。
- **拒绝点(要改)**:`bridge/inbound.ts:160-169`——text 为空(M16 filter)直接回 "image/file attachments aren't supported yet" 并 return,**即使带图也拒**。批次 A 要放开「有图片时」这条(见 §3-D)。
- **在线建 turn**:`buildTurnStart`(`bridge/turnRunner.ts:175-200`)——`message.attachments` 硬编码 `[]`(`:181`)。这里把 `[]` 替换为**入站已编码好的**图片数组(下载编码在 inbound,见 §3-B);buildTurnStart 只多一行,**不引入新依赖**。
- **聚合点**:`MergedDispatch.sources: ReadonlyArray<QueuedMessage>`(`bridge/turnQueue.ts:70`),每个 `source.message` 是 `InboundMessage`(带 `attachments`+`messageId`)。`mergeMessages`(`turnQueue.ts:189-209`)目前**只合并 `prompt` 文本**(`:194-197`),不合并 attachments——批次 A 要让图片也跨"消息雨"聚合。
- **离线 buffered create**:`runOfflineCreateFlush`/`dispatchCreate`→`createThread`(`bridge/ensureThread.ts:342-353`)。⚠ 见 §3-E 离线边界。

## 3. 批次 A 范围(单 PR,纯 bot-side)

**让飞书用户发的图片进入 turn 的 `message.attachments`,agent 能看到图。清洗在 bot 侧(避开 server「拒整条 turn」),非图片文件仍不支持(descope,见 §3-F)。**

### A. 图片编码核心:下载 → sniff mime → 编码 → 构造上传结构
每张入站图片:
1. `downloadImage(message.messageId, att.fileKey)` → `Buffer`(飞书 SDK,不依赖 t3code server)。失败 → **跳过该图**(见统一处置)。
2. **mime = magic-byte sniff**(读前 ~12 字节判 `png/jpeg/gif/webp`)。飞书图片消息不带 mime、`downloadImage` 只返回 Buffer,故 sniff;非这四种 → 跳过。
3. `sizeBytes = buffer.byteLength`(>10MB → 跳过);`dataUrl = \`data:${mime};base64,${buffer.toString("base64")}\``(`dataUrl.length > MAX_IMAGE_DATA_URL_CHARS` → 跳过;base64 膨胀 ~4/3,10MB≈13.3M 字符贴近 14M 上限,须显式挡)。
4. `name = att.fileName ?? \`image-${idx}.${extFromMime(mime)}\``;构造 `{ type:"image", name, mimeType:mime, sizeBytes, dataUrl }`(**不带 id**)。
- **统一处置**:上面任一步"跳过"的图累计计数,turn 前发**一句**合并 notice「N 张图未发送(格式不支持/过大/下载失败)」——不逐张逐因刷屏。

> **mime sniff 为什么不用 fileName 后缀**:飞书 image 消息通常无 fileName;且必须保证落在 Claude 支持的 4 种内(§2.2 陷阱)。**magic bytes 可靠**:PNG=`89 50 4E 47`、JPEG=`FF D8 FF`、GIF=`47 49 46 38`、WebP=`RIFF`…`57 45 42 50`(offset 8)。
> **不能 import `apps/server/src/imageMime.ts`**(跨 app 边界,feishu-bot 只依赖 contracts/client-runtime/shared)。→ bot 侧**自实现**一个 ~20 行 `sniffImageMime(buffer): SupportedMime | null`,附单测(四种 magic + 非图片 → null)。动手前 grep `packages/shared` 确认无现成 util 可复用。

### B. 下载位置:**入站即编码**(核心简化 —— 下游零接线改造)
- 在 **inbound handler**(`bridge/inbound.ts`,本就是 Effect 上下文、已持 `LarkGateway`——它已在调 `sendNotice`),**确认消息进入 turn 路径后、入 `turnQueue` 前**,对该 message 的图片做 §3-A 的下载+编码,把结果**附在 message 上**(扩 `InboundAttachment` 加可选 `uploaded?: UploadChatImageAttachment`,或等价随行字段;命令/空消息不触发下载)。
- **下游全程纯搬运、零接线改造**:`mergeMessages`(纯函数,`turnQueue.ts:189-209`)只把各 source 已编码的 `uploaded` flatMap 聚合;`buildTurnStart`(`turnRunner.ts:181`)把 `attachments: []` 换成聚合结果。→ **不给 `buildTurnStart` 注入 `LarkGateway`、不改 `Effect.map`→`flatMap`、不给 `MergedDispatch` 加字段**。(这消解了审查抓的"下载 Effect 上下文/依赖注入边界模糊"——下载压根不进纯聚合/构造链。)
- **为什么在这里而非 dispatch 时**:inbound 已是"带 gateway 的 async 边界",下载天然归它;放到 dispatch 会逼着把 gateway 穿进纯聚合/构造链(先前草案的复杂度来源)。入站编码把下载收敛到**一处**,turnQueue/turnRunner 只见已备好的数据。
- **代价(有意取舍)**:已编码 dataUrl 随 message 在队列短暂驻留(600ms 合并窗 / turn 运行时排队,通常几张图、几十 MB、秒级)。**用一点短暂内存换掉整条接线复杂度**——值得;极端连发大图属边缘,不为它加提前落盘。
- **顺带好处**:离线缓冲的消息在入站时(飞书在线、下载不依赖 t3code server)已编码好,flush 时不怕飞书资源过期——原「离线接图」风险天然消失(§3-E 收缩为一句)。
- **下载失败(单图)**:归入 §3-A 的统一「跳过 + 累计 notice」,不拒整轮;失败是 `LarkGatewayError`(`sdkCall` 包裹,`channel.ts:584-591`),按域内容错(不崩进程)。

### C. 聚合 + 8 张截断(纯搬运)
- `mergeMessages`(`turnQueue.ts:189-209`,**纯函数**)在合并 prompt 文本的同时,把各 `source.message` 已编码的图 flatMap 聚合成 `UploadChatImageAttachment[]`(**只搬 §3-B 已备好的 `uploaded`,不下载**)。跨"600ms 窗口合并的多条消息"与"一条消息多图"统一。
- **8 张截断**:聚合后 `> MAX_ATTACHMENTS` → `slice(0, MAX_ATTACHMENTS)` + 一句 notice「已省略 N 张(单轮最多 8 张)」。(坏图已在入站清洗剔除,这里都是好图,按数量直截。)
- `buildTurnStart`(`turnRunner.ts:181`)把 `attachments: []` 换成该数组——**这是 turnRunner 侧唯一改动**。

### D. 放开「有图片」的入站门(`inbound.ts:160-169`)
- 当前:`text.trim().length === 0` → 一律拒。改为:
  - `text` 空 **且 有 image attachments** → **不再拒**,进入 turn 路径(prompt 为空,图片承载意图)。
  - `text` 空 **且 无 attachments** → 保持原「空消息」notice。
  - 非图片 attachments(未来若出现)→ 保持「不支持」notice(§3-F)。
- **⚠ 纯图 + 空 text 的边界(已大部澄清,余下实测)**:server `buildUserMessageEffect`(`ClaudeAdapter.ts:938-999`)对 text 有 gate——`if (text.length > 0) sdkContent.push({ type:"text", text })`(`:949-951`),**空 text 根本不会生成空 text block**,只留 image block(s)。故先前担心的"空 text block 被 Anthropic SDK 拒"**不成立**。**余下待实测**:只含 image block、无 text 的 user message 是否被 Claude 正常接受(通常可以)。→ 倾向**不合成占位 prompt**(保持 prompt 真实为空);若实测发现纯 image message 有问题,再回退合成占位(如 `"[图片]"`)。结论记 §7。
- notice 措辞:剔除/截断/降级都要**明确回报用户**(哪几张没进、为什么),锚进触发话题(复用 `sendNotice(chatKey, …, message.messageId)` 的话题锚定,见 `inbound.ts:165-168`)。

### E. 离线 buffered create —— 无需特殊处理
- 入站即编码(§3-B)已让离线缓冲的消息带上编码好的图,flush 时直接搬运,飞书资源过期风险天然消失。**离线路径无额外工作**——动手时顺带确认离线 flush 的 message 也经同一入站编码点(`ensureThread.ts:342-353` 附近)即可。

### F. 非图片文件旁路 —— **descope(不在批次 A)**
- 设计文档 §7 的"非图片文件落盘 workspace + prompt 引用路径"**不做**:要访问 project workspace 写文件、拼绝对路径进 prompt,是另一条独立管道,价值次于图片。
- 批次 A 只做 `image/*`(且窄到 Claude 支持的 4 种)。非图片消息保持「不支持」notice(措辞可更新为「暂只支持图片」)。旁路留作后续 follow-up。

## 4. PR 边界与依赖
- **本 PR = 批次 A(入站图片附件)**,单 PR,纯 `apps/feishu-bot`。零契约/server 改动。
- 流程:实现 → 多维对抗审查(**Workflow**,见 `review-fanout-prefer-workflow`)→ 修阻断项 → 用户确认 commit/PR → 真连接 e2e → 合入。
- **不依赖批次 B/C**,可独立交付。

## 5. 红线(不可弱化)
- **纯 bot-side、零契约改动**:不新增/修改 `packages/contracts` 的 attachment schema(已就位),不动 server `Normalizer`/`ClaudeAdapter`。行为有意变更只在 bot 入站/建 turn 路径。
- **清洗在 bot、避开 server「拒整条 turn」**:任何注定被 server(`Normalizer.ts:78-88`)或 Claude(`ClaudeAdapter.ts:958`)拒的图,bot **必须发送前剔除**;绝不让一张坏图连累整轮(含文本)被拒。
- **限制常量从 `@t3tools/contracts` import**(`MAX_ATTACHMENTS`/`MAX_IMAGE_BYTES`/`MAX_IMAGE_DATA_URL_CHARS`),**禁止硬编码** 8/10MB/14M 数字(与 server 单一真相同源)。
- **mimeType 收窄到 Claude 支持的 `{png,jpeg,gif,webp}`**(非契约的宽 `image/*`),不支持的当场剔除。
- **不碰审批/pin-drift 承重件**:`callbackAuth`/`payload.o`/`feishuInitiators`/`operator` 签名链字节不动(批次 A 不涉审批)。
- **不破现有语义**:runtimeMode/密度/命令路由/话题锚定/消息雨合并的既有行为保持;纯文本消息路径**字节级不变**(只在"有图片/空文本带图"分支引入新行为)。
- **接线最小面**:入站即编码只在 `InboundAttachment` 加可选 `uploaded` 字段 + `mergeMessages` 搬运 + `buildTurnStart` 一行替换 `[]`;**不给纯函数/构造链注入 `LarkGateway`、不改 turnQueue/turnRunner 控制流**。已编码 dataUrl 的短暂队列驻留是有意取舍(§3-B)。
- **不崩进程**:下载/编码失败是 `LarkGatewayError`,按域内容错(降级+notice),绝不让单图异常掀翻 turn fiber 或进程。
- **键粒度**:一切沿用现有 `chatKey`/`chatId` 惯例,不新造键。

## 6. e2e runbook(真连接)
- **可复用环境**:home `/Users/lizhipeng/.t3-feishu-m0`(已 binding + provisioned app + web 登录态)。启动:被测分支 worktree 起 `T3CODE_HOME=/Users/lizhipeng/.t3-feishu-m0 T3CODE_PORT=3773 node apps/server/src/bin.ts serve`;**bot 由 server-managed 自动 spawn**(凭证走 RPC、pairing token 每次现签);浏览器 pairing `node apps/server/src/bin.ts auth pairing create --base-dir <HOME> --base-url http://localhost:3773`,**认证走 3773**;测未合入 web 先 `cd apps/web && pnpm exec vp build`。细节见 memory `feishu-bridge-e2e-pairing-token`。
- ⚠ **worktree 无 web/dist**:批次 A 不改 web,但 server 静态服务 `apps/web/dist`,worktree 里若无 dist 需先 build 或**从主树复制/软链 `apps/web/dist` 过来**(批次 A 不改 web,dist 内容不影响验证;见 pin-drift memory 的 worktree 坑)。
- **先校验环境**:`/whoami` 或 web 登录页确认 binding 仍有效(app scope/web 登录态不落盘)。
- **M-1 语义**:bot 不自动建 project——先 `/workspace`。
- **验证点**:
  1. **图文混发**:发「这个报错什么意思?」+ 一张 PNG 截图 → agent 回复引用了图片内容(证明图进了 prompt)。
  2. **纯图**:只发一张图不带文字 → 不再回「不支持」,agent 看到图(证明 §3-D 门放开 + 空 text 占位可行)。
  3. **一条多图**:一条消息 3 张图 → 全部进同一 turn。
  4. **消息雨聚合**:600ms 内连发「图A」「图B」→ 合并成一 turn 且两图都在(证明 §3-C `sources` 聚合)。
  5. **>8 张截断**:发 10 张 → 前 8 张进,notice 告知省略 2 张,turn 不被拒(证明 bot 侧清洗避开 server 拒整轮)。
  6. **非支持格式**:发一张 svg/bmp → 该图被剔除 + notice「暂不支持该格式」,同消息的文本/其它图仍正常(证明 §2.2 Claude 窄集陷阱被 bot 挡住,而非发 turn 时炸)。
  7. **过大图**:发 >10MB → 剔除 + notice,不拒整轮。
  8. **回归**:纯文本消息、命令(`/help` 等)行为字节级不变。
- **收口**:kill server;home 保留;无需改 settings.json(批次 A 不涉配置)。

## 7. 待确认(实现中定或问用户)
- **纯 image message 的 provider 行为**(§3-D):server 已 gate 掉空 text block(`ClaudeAdapter.ts:949-951`);余下实测「只含 image block、无 text 的 user message」是否被 Claude 正常接受,决定是否需合成占位 prompt(倾向不需)。
- **mime sniff 复用**:`packages/shared` 是否已有 image sniff util?无则 bot 自实现(§3-A)。
- **离线 flush 编码点**(§3-E):确认离线 buffered 消息也经同一入站编码点(§3-B)带上 `uploaded`;若离线走了不同入口,补一处编码。
- **post(富文本)消息内嵌图**:`normalizeInbound` 的 `resources` 是否涵盖 post 内联图片(SDK 行为)?动手前复核 `channel.ts` resource 提取路径。

## 8. 委派 / 闭环
- **Explore/Plan**(只读,file:line + 结论):动手前复核 §2 全链锚点(尤其 `orchestration.ts:165-174` 上传态 schema / `Normalizer.ts:72-143` 落盘+拒整轮 / `provider.ts:73` 8 张上限 / `ClaudeAdapter.ts:882-887` Claude 窄集 + `:958-963` 拒 + `:938-999` buildUserMessageEffect(空 text gate :949-951) / `composerImages.ts` 编码范式 / `channel.ts:196-203` 入站解析 + `:590` downloadImage / `turnRunner.ts:181` 硬编码 `[]` / `turnQueue.ts:189-209` mergeMessages / `inbound.ts:160-169` 拒绝门 / `ensureThread.ts:342-353` 离线)。
- **Test**:`pnpm --filter @t3tools/feishu-bot run typecheck`、`pnpm exec vp check apps/feishu-bot`、单测(sniffImageMime 四格式+null / dataUrl 编码 / sizeBytes / 8 张截断 / mime 窄集剔除 / mergeMessages 聚合 attachments + 保留 messageId / 空 text+图 分支不误拒 / 纯文本回归字节级不变)。
- **Review**:多维 + 对抗(**用 Workflow**;维度见下必审规则)。

## 【kickoff 必审 · 自传播规则】
本设计文档交付前**必须**多维对抗审查(**优先 Workflow**,`review-fanout-prefer-workflow`):① **代码事实**——file:line 逐条对真实 main(`fbd41a15`)核验(尤其 `orchestration.ts` 上传态 schema `:165-174` + 常量 `:141-145` + turn 命令 message.attachments `:604-609` / `Normalizer.ts` 落盘+**拒整轮** `:72-143` / `imageMime.ts` parseBase64DataUrl / `provider.ts:73` 8 张 + `:70` 120k / `ClaudeAdapter.ts:882-887` Claude 窄集 + `:958-963` 拒 + `:938-999` buildUserMessageEffect(空 text gate :949-951) / `composerImages.ts` 编码 / `ChatComposer.tsx:1797` 预校验 / feishu-bot: `channel.ts:196-203`+`:584-591` / `types.ts:43-47`+`:83` / `inbound.ts:160-169` / `turnRunner.ts:175-200`(`:181` 硬编码 `[]`) / `turnQueue.ts:70`+`:189-209` / `ensureThread.ts:342-353`);② **范围完整**——「清洗在 bot 侧避开 server 拒整轮」没有被误当成"server 会降级"、「Claude 窄集(png/jpeg/gif/webp)比契约 image/* 更窄」的陷阱已点明、「纯图空 text 的 provider 边界」如实标为待实测(不虚构已验证)、「非图片旁路 descope」边界清晰、「纯 bot-side 零契约改动」没有被悄悄扩成改契约/server、messageId+fileKey 下载配对没被漏(否则 downloadImage 无从取 owning message);③ **自包含**——memory/文档引用真实、runbook 可执行、红线齐全(零契约改动、清洗避开拒整轮、常量 import 不硬编码、mime 窄集、不碰审批/pin-drift 承重件、纯文本路径字节级不变、不崩进程)、待确认项已在 §7 点明。修掉阻断项再交付,并把**本规则原样写进**衍生的下一里程碑 kickoff。
