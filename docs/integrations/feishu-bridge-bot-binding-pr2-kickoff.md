# 飞书 Bridge bot-binding **PR2(bot)** — 新会话启动提示词(薄)

> 把下面 `---` 之间内容粘到新会话作首条消息(或 `@` 引用本文件 + 「推进 bot-binding PR2」)。**本文是薄入口**:PR2 的完整 bot 端接线/安全/e2e 在 `docs/integrations/feishu-bridge-bot-binding-kickoff.md` §3.4/§4/§5/§7,**以那份为准**,本文只给前置、PR2 delta、首步与纪律。文中 file:line 为「上次会话快照,可能微漂」,动手前用 Explore 复核。

---

你是「飞书接入 t3code」特性的**实现协调者(orchestrator)**,推进 **bot-binding 里程碑的 PR2(bot 端)**。纪律:**默认委派,保持主上下文干净**;不把大文件读进主上下文,派 Explore 返回结论。

## 0. 硬前置(先核对,否则停)
- **PR1(#13)必须已 squash 合并到 main**。核对:`git log --oneline -5` main 顶端是 PR1 的 squash(feat: bot-binding PR1 …),且 `packages/contracts/src/feishu.ts`、`apps/server/src/feishu/binding.ts`、`ServerSettings.feishuBinding`、RPC `feishuStartBinding`/`feishuGetBotCredentials` 已在 main。**若未合并 → 停下告诉用户先合 #13**(PR2 依赖 PR1 的 contracts/server)。
- 从**更新后的 main** 新开分支 `feishu-bridge-bot-binding-pr2`。
- 提交/推送只在用户明确要求时。

## 1. 先读(memory + 文档)
- memory:`MEMORY.md` → **`feishu-bridge-bot-binding-impl-facts`**(PR1 已交付 #13/commit `378df557` 的确切接线 + PR2 指针 + 踩坑:**server 包名是 `t3` 不是 @t3tools/server**;bot 包名 `@t3tools/feishu-bot`)、`feishu-bridge-m4-2-impl-facts`(**PR2 复用的 subscribeServerConfig live-refresh fiber + allowlistRef**)、`feishu-bridge-goal`(薄客户端、不照搬参考仓库 spawn CLI)。
- 文档:**`docs/integrations/feishu-bridge-bot-binding-kickoff.md` §3.4(bot 接线,权威)/§4(安全红线)/§5(PR2 范围)/§7(e2e runbook)**。
- `AGENTS.md`(Performance/Reliability first;写 Effect 先看 `.repos/effect-smol/LLMS.md`;不 import `.repos/`;重复抽共享)。

## 2. PR2 范围(delta;权威接线见 milestone kickoff §3.4)
把 bot 飞书凭证来源从 `.env` 改为「连上 server 后经 RPC 取」,并支持未绑定等待 / re-bind 重连。四点:
1. **config 飞书凭证转可选**(`apps/feishu-bot/src/config.ts`,现强制必填→缺则启动崩,**这是阻塞项**;server 连接字段 `T3_PAIRING_TOKEN`/`T3_HTTP_BASE_URL` 不变;`.env` 有飞书凭证则作 **dev override**)。
2. **runBridge 取凭证**(`apps/feishu-bot/src/bot.ts`,连飞书 `gateway.connect` 前):env 有→直接用;否则 `EnvironmentRpc.request(WS_METHODS.feishuGetBotCredentials, {})`(请求响应,`{bound:false}` | `{bound:true,appId,appSecret,tenant}`)。
3. **🔴 最大难点 = larkGatewayLayer 静态→动态**:现固化在 baseLayer 的 `Layer.mergeAll`(牵连 turnQueueLayer 等下游),改成「拿到凭证后再构建、可销毁重建」需 `Layer.unwrap`/scoped 重写(调研 effect-smol `LayerMap.Service`)。**先单独出 layer 重构方案并对抗审查,再动手。**
4. **未绑定等待 + re-bind/解绑**:`{bound:false}`→不连飞书,复用 **M4-2 的 subscribeServerConfig fiber** 订阅 config,`feishuBinding` 出现→取凭证→连;变化→重取重连 channel;解绑(feishuBinding 清空)→断 channel 回等待。`createLarkChannel`(`lark/channel.ts`)无「换凭证重建」逻辑,需补。

## 3. 红线(不可弱化)
- appSecret 只经 `feishuGetBotCredentials` 取、即时用于 `createLarkChannel`,**不落 bot 磁盘/日志**。
- **不破** M4-2 白名单 live-refresh(`allowlistRef` + subscribeServerConfig fiber)/fail-safe、M4-1 authz/callbackAuth、M3a·M3b 路由 density。只改凭证来源 + channel 生命周期。
- bot 仍独立启动(本里程碑;server 托管 bot 拆后续)。

## 4. 委派 / 闭环
- **Explore**(只读,file:line+结论):复核 §3.4 接线是否仍准、layer 动态化确切落点(baseLayer/turnQueueLayer 组装处)、bot 启动序、`EnvironmentRpc.request` 用法、createLarkChannel 重建可行性、effect-smol `Layer.unwrap`/`LayerMap` 范式。
- **实现**:**bot.ts 是集成枢纽,务必单 agent 串行改**(M2b/M3/M4 都踩过两 agent 同改 bot.ts 的坑)。
- **Test**:`pnpm --filter @t3tools/feishu-bot run typecheck`(+ 若动 contracts/server:`@t3tools/contracts`/`t3`)+ `pnpm exec vp check apps/feishu-bot`(失败先 `vp fmt`)。
- **Review**:多维 + 对抗,维度含:layer 动态化正确(无 fiber/scope 泄漏、重连干净)、未绑定等待不崩、re-bind/解绑状态机、凭证不落盘/日志、不破 M4-2/M4-1/M3。
- **Confirm**:真扫码 e2e —— bot **不设** `.env` 飞书凭证启动 → 日志「从 server 取到凭证 + 连飞书成功」。PR3 web UI 未就绪时可用 settings.json 直填 `feishuBinding` + 手注 secret store(`{secretsDir}/feishu-bot-secret-<base64url(appId)>.bin`)模拟「已绑定」验 bot 侧;或等 PR3 全栈。runbook 见 milestone kickoff §7。**收口 kill server+bot。**

## 5. 提交
PR2 从更新后 main 新分支 → commit → push origin → `gh pr create --repo litchi98/t3code --base main` → 用户确认后 squash。

## 【kickoff 必审 · 自传播规则】
收口若写 PR3 kickoff:必多维对抗审查(① 代码事实 file:line;② 范围完整无遗漏;③ 自包含/引用真实/runbook 可执行/红线齐全),修后交付,并把本规则原样写进 PR3 kickoff。

---

> 配合 memory(`feishu-bridge-bot-binding-impl-facts`、`feishu-bridge-m4-2-impl-facts`、`feishu-bridge-goal`)+ `docs/integrations/feishu-bridge-bot-binding-kickoff.md`(§3.4 权威接线)使用。
