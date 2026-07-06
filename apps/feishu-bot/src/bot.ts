import { connectionProjectionPhase, EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import * as EnvironmentRpc from "@t3tools/client-runtime/rpc";
import {
  derivePendingApprovals,
  derivePendingUserInputs,
} from "@t3tools/client-runtime/state/thread-activity";
import {
  type FeishuChatConfig,
  ModelSelection,
  ORCHESTRATION_WS_METHODS,
  type OrchestrationThread,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { type FeishuBotConfig, type FeishuCredentialOverride } from "./config.ts";
import { resolveEnvironment, type ResolvedEnvironment } from "./auth.ts";
import { connectionLayer } from "./runtime/connection.ts";
import {
  AuditStore,
  CallbackNonceStore,
  CardHandleStore,
  fileStoresLayer,
  NoticeMemoryStore,
  SentCommandStore,
} from "./runtime/persistence.ts";
import { LarkGateway } from "./lark/index.ts";
import { larkGatewayLayer } from "./lark/channel.ts";
import { reportFeishuChatDirectory } from "./chat-directory.ts";
import type { BridgeHandlers, InboundMessage } from "./lark/types.ts";
import { effectiveChatConfig } from "./bridge/chatConfig.ts";
import { CallbackAuth } from "./bridge/callbackAuth.ts";
import { type ResolvedNoticeEntry } from "./bridge/interactionCard.ts";
import {
  densityForRuntime,
  resolveRenderDensity,
  splitChatKey,
} from "./bridge/chatThreadMap.ts";
import { type RenderDensity, renderThreadCard } from "./bridge/eventRenderer.ts";
import { TurnQueue, turnQueueLayer } from "./bridge/turnQueue.ts";
import { OutboundQueue, outboundQueueLayer } from "./bridge/outbound.ts";
import { BindingState, bindingStateLayer } from "./bridge/bindingState.ts";
import { WorkspaceState, workspaceStateLayer } from "./bridge/workspaceState.ts";
import { runShellCacheFiber } from "./bridge/shellCache.ts";
import { runShellWatcherFiber } from "./bridge/shellWatcher.ts";
import { buildCommandTable } from "./bridge/commands/handlers.ts";
import { resolveModelSelection } from "./bridge/modelSelection.ts";
import { makeEnvAccess } from "./bridge/envAccess.ts";
import { makeNotices } from "./bridge/notices.ts";
import { makeObserveMirror } from "./bridge/observeMirror.ts";
import { makeWorkspaceGate } from "./bridge/workspaceGate.ts";
import { makeWorkspaceOps } from "./bridge/workspaceOps.ts";
import { makeTurnRunner } from "./bridge/turnRunner.ts";
import { makeEnsureThread } from "./bridge/ensureThread.ts";
import { makeInteractionBuilder } from "./bridge/interaction.ts";
import { makeInboundHandler } from "./bridge/inbound.ts";
import { makeCardActionHandler } from "./bridge/cardAction.ts";
import {
  acquireCredentials,
  bindingIdentityEq,
  type BindingIdentity,
  FeishuSessionFailure,
  redactSecret,
  reportAuthFailure,
  runBindingAndConfigWatcher,
  SESSION_RETRY_SCHEDULE,
  threadIdForChatKey,
  UNBOUND_RECHECK_INTERVAL,
} from "./bridge/residency.ts";

/**
 * How long to wait for the first shell snapshot (i.e. a healthy, authenticated
 * websocket session) before giving up. `supervisor.connect` retries forever, so
 * without this bound a wrong `wsBaseUrl`, a failed ws-ticket exchange, or a down
 * server would hang silently at "discovering project...".
 */
const DISCOVERY_TIMEOUT = Duration.seconds(30);

// ── Model resolution (M-1: per-chat, no startup project) ─────────────────────
//
// M0's `discoverProject` (blind `projects[0]` pick + `T3_WORKSPACE_ROOT`
// auto-create on a bare server) is GONE: the project is no longer fixed at
// startup. Each conversation explicitly selects its workspace via `/workspace`
// (persisted in `WorkspaceState`/`ChatWorkspaceStore`), and thread creation
// resolves the project — and its model selection — per chat at dispatch time.
// A bot connected to a zero-project server boots normally; users must
// `/workspace add`/`switch` before the first prompt. The `workspaceRoot`
// config field (and the server-managed `T3_WORKSPACE_ROOT` injection) is kept
// for compatibility but is no longer consumed here.

// ── Resident bridge core ─────────────────────────────────────────────────────

/**
 * One bound session: connect to Feishu with the given credentials, then route
 * every chat message through the bridge (bind → dispatch/queue → observe →
 * render → stream card), parking on `Effect.never` so it lives as long as the
 * binding does. PR2 makes this *per-binding*: it is built once per resolved
 * credential set inside its own `Effect.scoped` sub-scope (see `program`), so a
 * re-bind/unbind interrupts it (tearing the Lark socket + every forked fiber
 * down) and the resident loop starts a fresh session with the new credentials.
 *
 * Runs inside the outer layer (so `EnvironmentRegistry` and the durable stores
 * are available) and the per-binding `boundLayer` (Lark gateway + queues). The
 * `creds` carry the resolved app id/secret/domain. `ownerRef` is the shared
 * binding owner (`feishuBinding.ownerOpenId`, or `null` when unbound) and
 * `chatConfigsRef`/`chatDefaultsRef` the per-chat approval config — all owned by
 * the resident loop and live-refreshed across re-binds by the outer watcher. The
 * cardAction gate reads them for owner-always + three-state authorization (M-2).
 */
const runBoundSession = (
  config: FeishuBotConfig,
  resolved: ResolvedEnvironment,
  creds: FeishuCredentialOverride,
  ownerRef: Ref.Ref<string | null>,
  chatConfigsRef: Ref.Ref<{ readonly [chatId: string]: FeishuChatConfig }>,
  chatDefaultsRef: Ref.Ref<FeishuChatConfig>,
) =>
  Effect.gen(function* () {
    const registry = yield* EnvironmentRegistry;
    const gateway = yield* LarkGateway;
    const sent = yield* SentCommandStore;
    const outbound = yield* OutboundQueue;
    const turnQueue = yield* TurnQueue;
    // M2b-1 interaction-kernel stores: the durable nonce guard (single-use
    // callback tokens), the append-only audit log (who clicked what), and the
    // chat → latest interaction-card handle (for re-render / recovery). All three
    // come from `fileStoresLayer` (no baseLayer change needed).
    const nonceStore = yield* CallbackNonceStore;
    const audit = yield* AuditStore;
    const cardHandles = yield* CardHandleStore;
    // M2b-2: persistent notice-dedup store so the shellWatcher survives restarts.
    const noticeMemoryStore = yield* NoticeMemoryStore;
    // A stable, synchronous view of the live nonce map for `CallbackAuth.verify`
    // (which is sync and IO-free). Yielded once; its reference never changes
    // because the backing `Map` is mutated in place — it always reflects the
    // latest state. Durable consumption is the handler's job (await
    // `nonceStore.consume` after verify succeeds, before routing).
    const nonceProbe = yield* nonceStore.probe;
    // M2a: the mutable chat↔thread binding view (in-memory, store-backed). This
    // is now the single source of truth for "which thread backs this chat" — it
    // replaces the M1 direct `ChatThreadMapStore` reads on the bridge hot path
    // (ensureThread / turnQueue.threadIdFor / warm-up / reconnect). The durable
    // `ChatThreadMapStore` remains the backend behind it (`bindings.bind`/`unbind`
    // mirror writes through), provided to `bindingStateLayer` in `program`.
    const bindings = yield* BindingState;
    // M-1: the per-chat workspace selection authority (in-memory, mirrored to
    // the durable `ChatWorkspaceStore`). Read on every inbound message by the
    // "no thread without a selected workspace" gate; written by `/workspace`.
    const workspace = yield* WorkspaceState;
    const environmentId = resolved.target.environmentId;

    // M2b-3: the bridge's own (root) scope. PR2: this is now the *per-binding*
    // sub-scope — `program` wraps each `runBoundSession` in its own `Effect.scoped`,
    // so `Effect.scope` here resolves to that session's scope, NOT the resident
    // outer scope. Resident observe fibers (the cross-end mirror of a takeover's
    // running turn) are `forkIn(rootScope)`'d onto it so they live the binding's
    // lifetime and are interrupted when the binding tears down (re-bind/unbind
    // closes this sub-scope, which also disconnects the Lark gateway provided into
    // it) — unless a stronger source (a new bridge-driven turn, `/release`, the
    // watcher's reconciliation) interrupts them first via `stopObserve`. Binding
    // this scope per-session (not to the long-lived outer scope) is what prevents
    // observe fibers from outliving — and holding a dead reference to — a
    // disconnected gateway after a re-bind.
    const rootScope = yield* Effect.scope;

    yield* Console.log(`[feishu-bot] connected to ${resolved.target.label} (${environmentId}).`);
    yield* Console.log("[feishu-bot] waiting for the first shell snapshot...");

    // Startup health gate (M-1: replaces `discoverProject`): wait for the first
    // shell frame so a wrong `wsBaseUrl` / failed ws-ticket exchange still fails
    // fast with an actionable message. The frame's *content* no longer matters —
    // a zero-project server is a normal boot state now; each conversation picks
    // its workspace via `/workspace` before its first thread is created.
    const shellStream = registry
      .followStream(
        environmentId,
        EnvironmentRpc.subscribe(ORCHESTRATION_WS_METHODS.subscribeShell, {}),
      )
      .pipe(Stream.orDie);
    yield* Stream.runHead(shellStream.pipe(Stream.take(1))).pipe(
      Effect.timeoutOrElse({
        duration: DISCOVERY_TIMEOUT,
        orElse: () =>
          Effect.die(
            new Error(
              `Timed out after ${Duration.format(DISCOVERY_TIMEOUT)} waiting for the first shell ` +
                "snapshot. Check that the server is running and that wsBaseUrl is correct and " +
                "reachable, and that the ws-ticket exchange (pairing token) succeeds.",
            ),
          ),
      }),
    );

    // Per-turn model selection (M2 cross-end safety). Only an *explicit*
    // `T3_MODEL` override pins the model on every turn; without one we omit
    // `modelSelection` on `startThreadTurn` so the server keeps the thread's
    // persistent model — honouring both the creation-time choice and any model
    // switch another end (e.g. web) made. Unconditionally re-sending the
    // startup selection would silently overwrite such a switch (and break the
    // next turn for `requiresNewThreadForModelChange` providers like Grok),
    // and the server does not per-turn-switch an existing thread anyway, so it
    // would be useless and harmful. (`createThread` still always carries
    // `modelSelection` — it is required to build the thread; M-1 resolves that
    // one per chat, from the selected project's default, at create time.)
    //
    // M-1: the override is project-independent (priority 1 in
    // `resolveModelSelection` never consults the project default), so it is
    // still resolved ONCE at session start; without an override nothing is
    // resolved here.
    const perTurnModelSelection: ModelSelection | null =
      config.modelOverride === null
        ? null
        : yield* registry.run(environmentId, resolveModelSelection(null, config.modelOverride));
    if (perTurnModelSelection !== null) {
      yield* Console.log(
        `[feishu-bot] model override: ${perTurnModelSelection.instanceId} / ${perTurnModelSelection.model}.`,
      );
    }

    // Capture the platform crypto service so environment-scoped command
    // operations (which need `Crypto` for any auto-generated ids) can have that
    // requirement discharged here, leaving a fully-total effect for the bridge.
    const crypto = yield* Crypto.Crypto;

    // M2b-1 callback-button HMAC auth. Single key (version 1) seeded from the
    // Feishu app secret; the synchronous nonce probe lets `verify` reject
    // replays in memory while the handler awaits the durable `consume`. A
    // re-signed token binds each rendered button to its exact
    // `(chat, thread, runtimeMode, operator, action)` context (policy
    // fingerprint) so a stale or cross-context click fails verification.
    const auth = new CallbackAuth({
      keys: [{ version: 1, secret: creds.appSecret }],
      nonces: nonceProbe,
    });

    // M3b: render density for group / topic chats, captured once from config
    // (bot-side) so every `renderThreadCard` call site below
    // derives its layout from one place via `densityForRuntime(runtimeMode, …)`.
    // p2p (`full-access`) is always `card`; only an explicit
    // `FEISHU_GROUP_CHAT_DENSITY` lowers a group/topic below `card`.
    const groupChatDensity = config.feishu.groupChatDensity;

    // M-3 PR-C3: resolve the effective render density for a chat, layering the
    // per-chat config over the legacy fallbacks. Server-managed spawn scrubs
    // `FEISHU_GROUP_CHAT_DENSITY`, so the web per-chat/defaults `density` field is
    // now the live control surface for GROUP/topic chats. Precedence (mirrors the
    // web's `effectiveConfig` so what the editor shows == what the bot renders):
    //   0. p2p (`full-access`) is ALWAYS `card` — a hard M3b invariant that
    //      per-chat / `feishuChatDefaults` density must NOT lower (the private-chat
    //      section is not configurable here; the contract + editor copy promise it).
    //      This gate mirrors `densityForRuntime`'s full-access force and must sit
    //      ABOVE the config so an inherited group default can't leak into a p2p chat.
    //   1. per-chat / defaults `density` (`effectiveChatConfig`, keyed by BARE
    //      chatId — the authz grain — so split the composite chatKey first);
    //   2. the bind-time `binding.density` (legacy stored value);
    //   3. `densityForRuntime(runtimeMode, groupChatDensity)` (env default).
    // Requires the REAL thread `runtimeMode` (p2p ⇒ full-access) — callers pass the
    // live thread's mode, NOT the synthetic placeholder's, or the p2p gate misfires.
    // Every render read point derives density through here so an override wins on the
    // *stable terminal* card. `chatKey` is the ambient composite key
    // (`chatId[:larkThreadId]`); bind-time STORE points keep computing
    // `densityForRuntime` directly — this is a read-time overlay only.
    const resolveDensity = (
      chatKey: string,
      runtimeMode: RuntimeMode,
    ): Effect.Effect<RenderDensity> =>
      Effect.gen(function* () {
        // Fast p2p path: `full-access` is always `card` (see `resolveRenderDensity`),
        // so skip the config/binding reads entirely for private chats.
        if (runtimeMode === "full-access") return "card";
        const { chatId: bareChatId } = splitChatKey(chatKey);
        const configDensity = effectiveChatConfig(
          bareChatId,
          yield* Ref.get(chatConfigsRef),
          yield* Ref.get(chatDefaultsRef),
        ).density;
        const binding = yield* bindings.get(chatKey);
        return resolveRenderDensity(runtimeMode, configDensity, binding?.density, groupChatDensity);
      });

    // E④: composite chatKey → operator open id, captured from each inbound message.
    // `chatOperators` records the most recent sender per composite key (chatId or
    // chatId:larkThreadId). During a running turn the turn initiator is pinned via
    // `operatorOverride`; after the turn ends `chatOperators` carries the last
    // known sender as a fallback. The cardAction verify re-checks the actual
    // clicker against the token's `o` field at click time.
    const chatOperators = yield* Ref.make<ReadonlyMap<string, string>>(new Map());

    // P2: per-chat resolved overlay — chatId → (requestId → {@link ResolvedNoticeEntry}).
    // The cardAction handler writes a resolved entry here on a successful respond;
    // the live `driveTurn` render reads it (via `buildInteraction`) so a
    // subsequent streaming tick — which has no operator knowledge of its own —
    // keeps the resolved request greyed out for the whole turn AND after it ends,
    // instead of the echo being overwritten by the next plain re-render. Cleared
    // for a chat on `/release` (the overlay is bound to the chat's session).
    // M2b-2: the value is now a structured {@link ResolvedNoticeEntry} (operator
    // name + command summary + decision) so the renderer composes the localized
    // "✅ 已由 @X 授权 · <命令摘要>" line itself (the bare-string echo is gone).
    const chatResolvedNotices = yield* Ref.make<
      ReadonlyMap<string, ReadonlyMap<string, ResolvedNoticeEntry>>
    >(new Map());
    const clearChatResolvedNotices = (chatId: string): Effect.Effect<void> =>
      Ref.update(chatResolvedNotices, (map) => {
        if (!map.has(chatId)) {
          return map;
        }
        const next = new Map(map);
        next.delete(chatId);
        return next;
      });

    const interaction = makeInteractionBuilder({ auth, chatOperators, chatResolvedNotices });
    const { buildInteraction } = interaction;

    const envAccess = makeEnvAccess({ registry, environmentId, crypto });
    const { runOnEnv, genId, subscribeThread, isEnvReady } = envAccess;

    const notices = yield* makeNotices({ gateway, genId });
    const { placeholderThread, sendNotice, renderTranscriptMarkdown, updateCardNotice } = notices;

    // ── M2a: resident shell cache + reverse-notification watcher ─────────────
    //
    // Subscribe to the environment shell on a *fresh* `followStream` — NOT the
    // `shellStream` discovery used above, which was truncated by `Stream.take(1)`
    // and would never deliver further frames. `followStream` replays a full
    // snapshot first and never fails (orDie'd), and `runShellCacheFiber` folds it
    // into the resident `ShellSnapshotCache` via the SAME shell reducer the
    // web/mobile clients use. Forked on `runBoundSession`'s scope, so it tears down
    // with the connection (same lifetime as the inbox/flush fibers below).
    const shellSubscription = registry
      .followStream(
        environmentId,
        EnvironmentRpc.subscribe(ORCHESTRATION_WS_METHODS.subscribeShell, {}),
      )
      .pipe(Stream.orDie);
    const shellCache = yield* runShellCacheFiber({ shellStream: shellSubscription });

    const workspaceGate = makeWorkspaceGate({
      workspace,
      shellCache,
      ownerRef,
      chatConfigsRef,
      chatDefaultsRef,
    });
    const {
      selectedWorkspaceFor,
      workspaceGateText,
      workspaceRevokedText,
      senderMayUseProjectAtDispatch,
    } = workspaceGate;

    // PR2: the binding + owner + per-chat config live-refresh fiber is hoisted OUT
    // of this per-binding session into the resident loop's OUTER scope (see
    // `runBindingAndConfigWatcher`). It must outlive any single binding — the owner
    // / per-chat config it publishes are binding-independent — and it doubles as the
    // binding-change watcher that drives re-bind. Here we only consume the shared
    // `ownerRef` / `chatConfigsRef` / `chatDefaultsRef` it maintains.

    // Read-only probe: is the chat busy (a turn running OR coalescing pending)?
    // Used by `/resume` to refuse a re-bind while a turn is in flight *or* about
    // to dispatch (the idle merge window). Reads the turn queue's busy view.
    const isChatBusy = (chatId: string): Effect.Effect<boolean> => turnQueue.isBusy(chatId);

    const observeMirror = yield* makeObserveMirror({
      rootScope,
      gateway,
      bindings,
      cardHandles,
      shellCache,
      isChatBusy,
      chatOperators,
      buildInteraction,
      resolveDensity,
      subscribeThread,
      sendNotice,
      renderTranscriptMarkdown,
      placeholderThread,
    });
    const {
      startMirror,
      isObserving,
      stopObserve,
      stopMirror,
      ensureObserving,
      surfacePendingApprovalIfNew,
      renderObservationToCard,
    } = observeMirror;

    // Capture a runtime that forks effects into a scoped FiberSet. This is the
    // edge between the SDK's plain `void` callbacks and the Effect world: the
    // callback offers to a queue, and a forked consumer drains it. Forked fibers
    // are interrupted when the scope closes. Every service the forked effects use
    // (Crypto/EnvironmentSupervisor via `genId`/`runOnEnv`, the stores via their
    // captured service values) is already discharged, so the forked effects are
    // fully total — the runtime needs no residual requirements.
    const runFork = yield* FiberSet.makeRuntime<never>();

    // Inbound mailbox: the SDK callback is non-blocking, so it only enqueues;
    // the consumer below forks one handler per message.
    const inbox = yield* Queue.unbounded<InboundMessage>();

    // Serialize the first-contact get-or-create so two concurrent messages for
    // an unbound chat can never race into two threads. Cheap after the first
    // message (a store cache hit); a single global permit is ample for M1's
    // low, 1:1 private-chat traffic.
    const ensureLock = yield* Semaphore.make(1);

    // M2b-3 / M8: the per-chat turn runner (turn lock, live card/observer drive,
    // offline buffering). Constructed after `observeMirror` (needs `stopObserve` /
    // `renderObservationToCard`); the mutually-recursive `runTurn`/`offlineBuffer`
    // live inside its module. §5.14 red line: the runner uses the bare
    // `registry`/`environmentId`/`crypto` (NOT `runOnEnv`) so the offline typed
    // errors survive to `catchTags`.
    const turnRunner = yield* makeTurnRunner({
      registry,
      environmentId,
      crypto,
      turnQueue,
      sent,
      outbound,
      gateway,
      stopObserve,
      renderObservationToCard,
      resolveDensity,
      sendNotice,
      subscribeThread,
      placeholderThread,
      genId,
      perTurnModelSelection,
    });
    const { runTurn, offlineBuffer } = turnRunner;

    // M-1: first-contact thread resolution (get-or-create, adopt-if-exists,
    // offline-buffered create). Constructed after `workspaceGate` and before the
    // command table, which reads its `hasPendingCreate` probe. §5.7: the caller
    // (`handleInbound`) must hold `ensureLock` around each `ensureThread` call.
    const ensureThreadHandle = yield* makeEnsureThread({
      bindings,
      shellCache,
      sent,
      outbound,
      isEnvReady,
      runOnEnv,
      genId,
      sendNotice,
      environmentId,
      groupChatDensity,
      config,
      workspace,
      selectedWorkspaceFor,
      senderMayUseProjectAtDispatch,
      workspaceGateText,
      workspaceRevokedText,
    });
    const { ensureThread, hasPendingCreate } = ensureThreadHandle;

    // Reverse-notification + reconciliation watcher. One fiber folding the shared
    // `shellCache.changes`: it reconciles dangling bindings (thread deleted /
    // archived elsewhere → unbind + notice), surfaces key blind-spot events
    // (failed/interrupted turn) and — M2b-2 修法 B — the follow-on/chained pending
    // approvals/user-inputs a resumed turn raises after takeover
    // (`surfacePendingApproval` delegates to `surfacePendingApprovalIfNew`), all for
    // `origin: "resumed"` takeovers that are not live-mirroring. Defined here (after
    // `surfacePendingApprovalIfNew` and `buildInteraction`) so the injected
    // `surfacePendingApproval` reference is initialised, and before the command table
    // so `/release` can clear a thread's dedup memory via the returned handle (the
    // discrete unbind lifecycle reset).
    //
    // #4: only the HANDLE is built here; the fold loop is forked later via
    // `shellWatcher.start` — deliberately AFTER the M18 restart-recovery pass (and
    // after `gateway.connect`) so recovery has already seeded each chat's
    // `CardHandle.pendingRequestId` dedup baseline before the watcher's first frame
    // can race it into a duplicate card.
    const shellWatcher = yield* runShellWatcherFiber({
      shellCache,
      bindings,
      stopMirror,
      sendNotice,
      surfacePendingApproval: surfacePendingApprovalIfNew,
      // M2b-3: the watcher mirrors a turn web/terminal starts after a takeover by
      // handing the resumed thread's running turn off to the bot's observe registry.
      ensureObserving,
      noticeMemoryStore,
    });

    // ── M-1: `/workspace add` backends ───────────────────────────────────────

    const workspaceOps = makeWorkspaceOps({
      registry,
      environmentId,
      crypto,
      shellCache,
    });
    const { createWorkspaceProject, cloneWorkspaceRepository } = workspaceOps;

    // The slash-command table (`/help`, `/status`, `/workspace`, `/resume`,
    // `/release`, `/whoami`). All deps are already-total effects (captured
    // service values + the mirror hooks above) or typed-error backends the
    // handlers catch themselves, so every handler slots into the table as
    // `Effect.Effect<void>`.
    const commandTable = buildCommandTable({
      sendNotice,
      bindings,
      shellCache,
      startMirror,
      stopMirror,
      clearNoticeMemory: shellWatcher.clearNoticeMemory,
      // P2: `/release` drops the chat's resolved overlay so a future session in
      // the same chat does not inherit stale "✅ 已由 …" greyed-out controls.
      clearResolvedNotices: clearChatResolvedNotices,
      isChatBusy,
      // M-1 (/workspace + /resume ownership): the selection authority and the
      // add backends.
      workspace: { get: workspace.get, select: workspace.select },
      createWorkspaceProject,
      cloneRepository: cloneWorkspaceRepository,
      hasPendingCreate,
      // M-3: per-chat authz inputs — the live owner open_id + the effective
      // per-chat config resolver (bare chatId grain, mirroring the approval gate
      // at ~3040). The `/workspace` + `/resume` authorization gates read these;
      // the binding owner is exempt from both (owner-always overlay).
      authz: {
        owner: Ref.get(ownerRef),
        config: (chatId) =>
          Effect.gen(function* () {
            return effectiveChatConfig(
              chatId,
              yield* Ref.get(chatConfigsRef),
              yield* Ref.get(chatDefaultsRef),
            );
          }),
      },
    });

    // M-1 / M3a: the per-message inbound pipeline (p2p owner gate → operator pin
    // → content filter → command routing → workspace gate → first-contact
    // ensureThread → queue offer → turn drive). §5.7: `ensureLock` is threaded in
    // so the handler holds it around each first-contact `ensureThread` call.
    const inbound = makeInboundHandler({
      ownerRef,
      chatConfigsRef,
      chatDefaultsRef,
      chatOperators,
      bindings,
      ensureLock,
      turnQueue,
      isChatBusy,
      commandTable,
      ensureThread,
      runTurn,
      offlineBuffer,
      sendNotice,
      selectedWorkspaceFor,
      workspaceGateText,
      workspaceRevokedText,
      senderMayUseProjectAtDispatch,
    });
    const { handleInbound } = inbound;

    // ── M2b-1: cardAction (button click / form submit) → shared respond RPC ──
    //
    // The click handler (verify → authz → nonce-consume → route → audit → echo)
    // lives in its module; its private bystander re-arm and operator-name cache
    // are constructed inside. Built after `runFork` — the form-settle echo forks
    // onto the bridge's scoped FiberSet runtime.
    const cardAction = yield* makeCardActionHandler({
      auth,
      nonceStore,
      audit,
      bindings,
      shellCache,
      gateway,
      ownerRef,
      chatConfigsRef,
      chatDefaultsRef,
      chatResolvedNotices,
      buildInteraction,
      resolveDensity,
      subscribeThread,
      updateCardNotice,
      sendNotice,
      runOnEnv,
      genId,
      runFork,
    });
    const { handleCardAction } = cardAction;

    // Consumer: fork one handler per message so the queue's idle-window coalesce
    // works (the SDK callback already decoupled intake). Offline first-contact is
    // compensated (⏳ + buffered create/turn intents), so a handler should only
    // ever fail on a genuine defect — logged and isolated to that message's fiber.
    yield* Stream.fromQueue(inbox).pipe(
      Stream.runForEach((message) =>
        Effect.sync(
          () =>
            void runFork(
              handleInbound(message).pipe(
                Effect.catchCause((cause) =>
                  Effect.logError(
                    `[feishu-bot] message handler failed for chat ${message.chatId}.`,
                    cause,
                  ),
                ),
              ),
            ),
        ),
      ),
      Effect.forkScoped,
    );

    // Flush the outbound queue whenever the *t3code environment* (re)connects —
    // intents are buffered when that environment is offline (M8), so its
    // reconnection (not Feishu's) is the correct flush trigger. Edge-triggered:
    // flush only on the transition into `connected`.
    yield* registry.stateChanges(environmentId).pipe(
      Stream.orDie,
      Stream.map((state) => connectionProjectionPhase(state) === "ready"),
      Stream.changes,
      Stream.filter((ready) => ready),
      Stream.runForEach(() =>
        Console.log("[feishu-bot] t3code environment connected; flushing outbound queue.").pipe(
          Effect.andThen(outbound.flush),
        ),
      ),
      Effect.forkScoped,
    );

    // M7 reconnect notice: Feishu has no inbound replay, so after the WebSocket
    // drops and reconnects, any message a user sent during the gap is lost to us.
    // Tell every chat we know about (restored bindings) to resend — a user-visible
    // prompt, not just a console line. Best-effort and bounded: notices are sent
    // serially and individually swallowed (`sendNotice` already logs failures).
    const notifyReconnect: Effect.Effect<void> = Effect.gen(function* () {
      const entries = yield* bindings.entries;
      // Fix 4 (M3a): a group with K topic bindings yields K composite keys that all
      // split to the SAME Feishu chatId — sending one notice per binding would spam
      // the group root with K identical reconnect prompts. Dedup on the real chatId
      // (`splitChatKey`) so each Feishu chat is prompted exactly once. A bare chatId
      // (p2p / plain group) splits to itself, so this collapses to the pre-Fix-4
      // one-notice-per-chat behaviour.
      const roots = Array.from(new Set(entries.map(([chatKey]) => splitChatKey(chatKey).chatId)));
      yield* Console.log(
        `[feishu-bot] feishu websocket reconnected; prompting ${roots.length} known chat(s) to resend.`,
      );
      yield* Effect.forEach(
        roots,
        (chatId) =>
          sendNotice(
            chatId,
            "⚠️ I briefly lost connection — any message you sent in the last moment may not have reached me. Please resend it if you didn't get a reply.",
          ),
        { discard: true },
      );
    });

    // Bridge handlers: the SDK edge. All non-blocking — enqueue / fork only.
    const handlers: BridgeHandlers = {
      onInboundMessage: (message) => {
        runFork(Queue.offer(inbox, message));
      },
      onCardAction: (evt) => {
        // The cardAction handler degrades every failure to a card notice and
        // orDies only on a genuine defect; fork it on the bridge runtime so the
        // SDK callback returns immediately (non-blocking edge).
        runFork(
          handleCardAction(evt).pipe(
            Effect.catchCause((cause) =>
              Effect.logError(
                `[feishu-bot] cardAction handler failed for chat ${evt.chatId}.`,
                cause,
              ),
            ),
          ),
        );
      },
      onReconnecting: () => {
        runFork(Console.log("[feishu-bot] feishu websocket reconnecting..."));
      },
      onReconnected: () => {
        // Feishu inbound replay is unavailable (M7): the user must resend any
        // messages sent during the gap. We surface that to each known chat (not
        // just the console). (Outbound t3code intents flush on the *t3code*
        // environment's reconnect, watched separately above.)
        runFork(notifyReconnect);
      },
      onError: (error) => {
        runFork(Console.error(`[feishu-bot] feishu channel error (${error.code ?? "?"}).`));
      },
    };

    yield* Console.log("[feishu-bot] connecting to feishu...");
    yield* gateway.connect(handlers).pipe(Effect.orDie);
    yield* Console.log("[feishu-bot] ready — listening for private-chat messages.");

    // Warm-up log of restored bindings (read from the in-memory authority).
    const restored = yield* bindings.entries;
    yield* Console.log(`[feishu-bot] restored ${restored.length} chat binding(s).`);

    // ── M2b-2: restart recovery of outstanding approval cards ────────────────
    //
    // After a bot restart the durable `CardHandleStore` may still hold a card
    // whose `pendingRequestId` was awaiting an operator decision. Feishu has no
    // inbound replay, so unless we re-render that card its buttons carry tokens
    // signed with the OLD app-secret-derived key context and the operator has no
    // fresh card to act on. For each restored binding we read its card handle and,
    // when it has a `pendingRequestId`, take a one-shot thread snapshot (the same
    // `Stream.take(1)` + `Effect.scoped` pattern the cardAction handler uses),
    // re-derive the pending approvals, and:
    //   - still pending  → re-render the approval card (`renderThreadCard` +
    //     `buildInteraction`, freshly-signed buttons) onto the same `messageId`;
    //   - no longer pending → drop the stale handle so we don't try again.
    //
    // ROBUSTNESS: the WHOLE block is wrapped in `Effect.catchCause` (warning only).
    // Recovery is strictly best-effort — a snapshot/render/update failure for one
    // chat must NEVER interrupt startup (the bot must come up and serve live
    // traffic regardless). Per-chat work is additionally isolated so one bad chat
    // doesn't abort the others.
    yield* Effect.forEach(
      restored,
      ([chatId, binding]) =>
        Effect.gen(function* () {
          const handleOpt = yield* cardHandles.get(chatId);
          if (Option.isNone(handleOpt)) {
            return;
          }
          const handle = handleOpt.value;
          if (handle.pendingRequestId === null) {
            return;
          }
          const threadId = binding.threadId;

          // #0/#1(c): graceful fallback when the persisted handle has no captured
          // operator (pre-M2b-2 data, or the card was rendered before any inbound
          // message identified the chat's operator). M-2/PR2b: the "empty open id →
          // dead button" premise only holds when the gate's authority DEPENDS on the
          // (missing) initiator — i.e. `initiator` mode with no bound owner. If an
          // owner is bound (owner-always) OR the chat's mode is `designated`/`all`
          // (initiator-independent), the card is approvable with no captured operator,
          // so recover it. Resolve the mode from the thread's current per-chat config
          // (same source the cardAction gate uses); a cold shell cache (null) is
          // treated as not-recoverable → the safe nudge fallback.
          if (handle.operatorOpenId.length === 0) {
            const recoveryShell = yield* shellCache.threadById(threadId);
            const owner = yield* Ref.get(ownerRef);
            const mode =
              recoveryShell === null
                ? null
                : effectiveChatConfig(
                    chatId,
                    yield* Ref.get(chatConfigsRef),
                    yield* Ref.get(chatDefaultsRef),
                  ).approvalMode;
            const recoverable = mode !== null && (owner !== null || mode !== "initiator");
            if (!recoverable) {
              // initiator-only with no owner (or cold cache): re-signing with an empty
              // open id would dead-end at verify time, so drop the stale handle and
              // nudge the user to send a message — which re-drives the turn and produces
              // a fresh, correctly-signed card. No wildcard / auth bypass.
              yield* cardHandles.remove(chatId).pipe(Effect.ignore);
              yield* sendNotice(
                chatId,
                "⚠️ 有待批准的操作,请发送一条消息以继续(将刷新可操作的卡片)。",
              );
              yield* Console.log(
                `[feishu-bot] skipping approval-card recovery for chat ${chatId} (no captured operator, initiator-only mode); nudged user to resend.`,
              );
              return;
            }
            // Recoverable (owner bound or non-initiator mode): fall through. The
            // recovered buttons sign the (empty) initiator into `payload.o`, but the
            // owner / a designated approver / any member can still approve them — the
            // gate does not consult `payload.o` in those cases.
            yield* Console.log(
              `[feishu-bot] recovering approval card for chat ${chatId} with no captured operator (owner bound or non-initiator mode; approvable without the initiator).`,
            );
          }

          // 修法 3: seed the in-process `chatOperators` Ref with the recovered operator.
          // That Ref is empty right after a restart (it is only written by inbound /
          // `/resume`), so every render path that resolves the operator from it —
          // observe (修法 2), 修法 A/B (`surfacePendingApprovalIfNew`), `driveTurn` —
          // would sign post-restart approval buttons with an empty open id (dead
          // buttons) until the next inbound message. Planting the durable handle's
          // operator here means those paths pick up the recovered operator immediately,
          // so the buttons verify across the restart even when observe lands on a fresh
          // card (修法 1 starts observe right below). The recovered operator is seeded
          // per composite key (chatId or chatId:larkThreadId), covering p2p, group,
          // and topic chats; it is used for follow-on approval requests until the next
          // inbound message refreshes `chatOperators`.
          yield* Ref.update(chatOperators, (map) =>
            new Map(map).set(chatId, handle.operatorOpenId),
          );

          // #7: bound the one-shot snapshot read. `subscribeThread` is `orDie`'d and
          // retries the subscription forever on an expected failure, so a thread
          // that was deleted/archived while the bot was down (or a server that never
          // delivers its first frame) would otherwise hang this read — and, since it
          // runs synchronously on the main `runBoundSession` fiber before `Effect.never`,
          // wedge startup. A `timeout` turns that into a `None` we skip past.
          const firstFrame = yield* Stream.runHead(
            subscribeThread(threadId).pipe(Stream.take(1)),
          ).pipe(
            Effect.scoped,
            Effect.timeout(Duration.seconds(10)),
            Effect.option,
            Effect.map(Option.flatten),
          );
          const snapshotThread = Option.match(firstFrame, {
            onNone: () => null as OrchestrationThread | null,
            onSome: (item) => (item.kind === "snapshot" ? item.snapshot.thread : null),
          });
          if (snapshotThread === null) {
            yield* Console.log(
              `[feishu-bot] approval-card recovery skipped for chat ${chatId} (no snapshot within timeout).`,
            );
            return;
          }

          const pendingApprovals = derivePendingApprovals(snapshotThread.activities);
          const pendingUserInputs = derivePendingUserInputs(snapshotThread.activities);
          const stillPending = pendingApprovals.some(
            (approval) => approval.requestId === handle.pendingRequestId,
          );
          // #2: the original request may have been resolved while the bot was down,
          // but a *new* approval (B) can have appeared on the same thread in the
          // meantime. Only drop the handle when nothing at all is pending; if any
          // approval/user-input is pending we fall through to the render path, which
          // lets `buildInteraction` (via `derivePendingApprovals` /
          // `derivePendingUserInputs`) surface B on the same card/messageId rather
          // than leaving the user with no actionable card.
          if (!stillPending && pendingApprovals.length === 0 && pendingUserInputs.length === 0) {
            // Nothing pending at all (resolved elsewhere, no replacement): drop the
            // stale handle so we don't keep trying to recover a dead request.
            yield* cardHandles.remove(chatId).pipe(Effect.ignore);
            return;
          }

          // Still pending (the original request, or a newer approval B): re-render
          // the approval card with freshly-signed buttons and push it onto the same
          // message id. #0/#1(b): re-sign for the operator captured on the handle
          // (the `chatOperators` Ref is empty right after a restart) so the buttons
          // verify correctly when clicked; the operator is re-checked at verify time.
          const interaction = yield* buildInteraction(
            chatId,
            snapshotThread,
            handle.operatorOpenId,
          );
          const density = yield* resolveDensity(chatId, snapshotThread.runtimeMode);
          const card = renderThreadCard(snapshotThread, {
            streaming: false,
            density,
            ...(interaction ? { interaction } : {}),
          }).card;
          // #10: reflect the ACTUAL outcome of the card push. `updateCard` failures
          // are still swallowed (recovery must never crash the bot), but we no
          // longer log a "recovered" success unconditionally — a failed push logs a
          // warning instead, so the log doesn't claim success that didn't happen.
          const pushExit = yield* gateway.updateCard(handle.messageId, card).pipe(Effect.exit);
          if (pushExit._tag === "Failure") {
            yield* Effect.logWarning(
              `[feishu-bot] approval-card recovery render failed for chat ${chatId} (request ${handle.pendingRequestId}).`,
              pushExit.cause,
            );
          } else {
            // #2: the card we just rendered may solicit a *newer* request (B) than the
            // one stored on the handle (the original was resolved while the bot was
            // down). Refresh the durable `pendingRequestId` to the request actually
            // rendered — the SAME priority `buildInteraction`/`renderInteractionSection`
            // used (approval first, then user-input) — so the resident shellWatcher's
            // single-source dedup (`CardHandle.pendingRequestId`) matches the surfaced
            // card and does NOT re-send a duplicate (which would also be signed with the
            // post-restart-empty `chatOperators`, i.e. dead buttons). Reuse the recovered
            // `messageId` and the persisted `operatorOpenId` (the Ref is still empty).
            const renderedRequestId =
              pendingApprovals[0]?.requestId ?? pendingUserInputs[0]?.requestId ?? null;
            yield* cardHandles
              .put(chatId, {
                messageId: handle.messageId,
                pendingRequestId: renderedRequestId,
                lastSequence: handle.lastSequence,
                operatorOpenId: handle.operatorOpenId,
              })
              .pipe(Effect.ignore);
            yield* Console.log(
              `[feishu-bot] recovered outstanding approval card for chat ${chatId} (request ${renderedRequestId}).`,
            );

            // 修法 1 (core): if the recovered turn is STILL RUNNING, start observe NOW
            // so it ADOPTS this just-recovered card instead of opening a second one
            // later. The bug it fixes: with the turn paused on an approval the shell
            // stops pushing frames, so observe's adopt trigger (the shellWatcher's 2nd
            // frame) never fires while paused; it only fires after the user approves #1
            // and the turn resumes — by which point request #1 is resolved and NOT in
            // observe's live-pending set, so the adopt branch misses and observe opens a
            // FRESH card for #2 (with, pre-修法 2/3, an empty-operator signature → dead
            // buttons). Starting observe here, while #1 is still live-pending, makes
            // observe's adopt branch HIT immediately: it keeps rendering onto THIS
            // `messageId` (single card) and 修法 2 forwards the recovered operator, so
            // follow-on #2 renders on the same card with verifiable buttons.
            //
            // `recoverApprovalCards` runs BEFORE `shellWatcher.start`, inside this same
            // `runBoundSession` gen scope, so `ensureObserving` is callable here. Its own
            // gates apply: `isChatBusy` (turnQueue empty post-restart → false) lets it
            // through, and the atomic claim dedups per-chat (multiple bindings each get
            // their own observe, keyed by `chatId`). A null `activeTurnId` (turn already
            // settled) makes `ensureObserving` a no-op. `Effect.ignore` keeps any
            // observe-start failure from aborting this chat's recovery (the per-chat
            // `catchCause` below is the second backstop, so startup never crashes).
            const recoveredActiveTurnId = snapshotThread.session?.activeTurnId ?? null;
            if (recoveredActiveTurnId !== null) {
              yield* ensureObserving(chatId, threadId, recoveredActiveTurnId).pipe(Effect.ignore);
            }
          }
        }).pipe(
          // Per-chat isolation: a failure recovering one chat must not abort the
          // others. Logged at warning level, then swallowed.
          Effect.catchCause((cause) =>
            Effect.logWarning(
              `[feishu-bot] approval-card recovery failed for chat ${chatId}.`,
              cause,
            ),
          ),
        ),
      // #6: recover chats with bounded concurrency. Each per-chat snapshot read is
      // bounded by a 10s `timeout`; with the old fully-serial `forEach` a handful of
      // chats whose threads were deleted/never-deliver-a-frame while the bot was down
      // would each burn their full 10s back-to-back (N × 10s) and stall startup right
      // up to `Effect.never`. A small bound runs them in parallel so the worst case is
      // ~10s total, not 10s per chat, while the per-chat `catchCause` isolation above
      // (one bad chat never aborts the pass) is preserved unchanged.
      { concurrency: 8, discard: true },
    ).pipe(
      // Outer guard: ANY failure of the recovery pass as a whole is non-fatal —
      // startup must proceed to `Effect.never` regardless.
      Effect.catchCause((cause) =>
        Effect.logWarning("[feishu-bot] approval-card recovery pass failed.", cause),
      ),
    );

    // #4: NOW fork the shell-watcher fold loop — after `gateway.connect` and after
    // the M18 recovery pass above. By this point recovery has updated each restored
    // chat's `CardHandle.pendingRequestId` (the single-source dedup baseline), so the
    // watcher's very first frame dedups against it instead of racing recovery to post
    // a second card. (The handle / `clearNoticeMemory` was already available to the
    // command table from `runShellWatcherFiber` above; only the loop was deferred.)
    yield* shellWatcher.start;

    // M-0: report the group roster (name / mode / owner / members) to the server
    // so the web settings UI can list the bot's groups and pick approvers. Purely
    // best-effort — forked onto this bound-session scope (torn down on re-bind)
    // and self-contained fail-safe, so it never blocks or crashes the resident
    // loop. First version fires once on connect; on-demand refresh comes later.
    yield* reportFeishuChatDirectory({ source: gateway, registry, environmentId }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("[feishu-bot] feishu chat report failed.", cause),
      ),
      Effect.forkScoped,
    );

    // Resident: keep the scope (connection, subscriptions, fibers) open forever.
    return yield* Effect.never;
  });

/**
 * Top-level program: resolve the environment, build the long-lived OUTER layer
 * (connection + durable stores + binding authority) once, then run the resident
 * re-bind loop. The whole flow is wrapped in `Effect.scoped` so the connection
 * (and the outer watcher fiber) tear down cleanly on exit; each per-binding
 * session lives in its own nested `Effect.scoped` sub-scope so a re-bind/unbind
 * tears just that session (Lark socket + its fibers) down. Auth failures are
 * reported as actionable one-liners before exiting; only genuinely unexpected
 * defects die.
 */
export const program = (
  config: FeishuBotConfig,
): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const resolved = yield* resolveEnvironment(config);
    const environmentId = resolved.target.environmentId;

    // OUTER layer (long-lived, built once): the durable stores + the in-memory
    // binding/workspace authorities + the server connection. `bindingStateLayer`
    // requires the `ChatThreadMapStore` — and `workspaceStateLayer` (M-1) the
    // `ChatWorkspaceStore` — that `fileStoresLayer` provides, so `provideMerge`
    // them *with* the store set below (the stores are fed to them and both
    // outputs are retained, so neither store leaks into the program's RIn). The
    // Lark gateway is NO LONGER here — it is per-binding (see `boundLayer` below).
    const outerLayer = Layer.merge(bindingStateLayer, workspaceStateLayer).pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          connectionLayer({ target: resolved.target, accessToken: resolved.accessToken }),
          fileStoresLayer({ stateDir: config.stateDir }),
        ),
      ),
    );

    // Resident loop: maintain the binding-independent binding view + owner +
    // per-chat config in the OUTER scope, then (re)build a per-binding session as
    // the binding comes and goes. Provided the OUTER layer once, wrapped in
    // `Effect.scoped`.
    const resident = Effect.gen(function* () {
      // The current bound identity as seen in server settings (null = unbound).
      // Drives re-bind; never carries the secret.
      const bindingView = yield* SubscriptionRef.make<BindingIdentity | null>(null);
      // Shared binding owner (`feishuBinding.ownerOpenId`), live-refreshed by the
      // outer watcher and read by every per-binding session's cardAction gate for
      // owner-always authz (M-2). Seeded `null` (unbound) until the first settings
      // snapshot arrives.
      const ownerRef = yield* Ref.make<string | null>(null);
      // Per-chat approval config (M-2): live-refreshed here so it survives re-bind;
      // read by the gate (three-state mode) and the M18 recovery guard via
      // `runBoundSession`. Seeded empty.
      const chatConfigsRef = yield* Ref.make<{ readonly [chatId: string]: FeishuChatConfig }>({});
      const chatDefaultsRef = yield* Ref.make<FeishuChatConfig>({});

      // Outer watcher: binding view + owner/per-chat config. Forked onto the OUTER
      // (resident) scope so it outlives every per-binding session.
      yield* runBindingAndConfigWatcher(
        environmentId,
        bindingView,
        ownerRef,
        chatConfigsRef,
        chatDefaultsRef,
      ).pipe(Effect.forkScoped);

      // Re-bind loop. Each iteration: acquire credentials, then either wait for a
      // binding (Unbound) or run one bound session until the binding changes.
      return yield* Effect.gen(function* () {
        const resolution = yield* acquireCredentials(config, environmentId);

        if (resolution._tag === "Unbound") {
          yield* Console.log("[feishu-bot] no bot credentials yet; waiting for a binding...");
          // Wait for the NEXT binding change — `Stream.drop(1)` skips the replayed
          // current value so we never tight-loop when a binding is present but its
          // secret is still missing (RPC keeps returning `{bound:false}`). A fixed
          // re-check interval is the safety net for a lost wakeup or a secret
          // injected without a `feishuBinding` change. Whichever fires first → loop.
          yield* Effect.raceFirst(
            SubscriptionRef.changes(bindingView).pipe(
              Stream.drop(1),
              Stream.filter((id) => id !== null),
              Stream.runHead,
              Effect.asVoid,
            ),
            Effect.sleep(UNBOUND_RECHECK_INTERVAL),
          );
          return;
        }

        const creds = resolution.creds;
        const sessionIdentity: BindingIdentity = { appId: creds.appId, tenant: creds.tenant };

        // Per-binding layer: the Lark gateway (built from `creds`) plus the two
        // queues. `provideMerge(larkGatewayLayer)` discharges the queues' gateway
        // requirement and retains `LarkGateway`; the residual `SentCommandStore` /
        // `BindingState` bubble up to the outer layer. The `turnQueue` threadId
        // lookup is the shared `threadIdForChatKey` (its `BindingState` comes from
        // the outer layer, captured at build time).
        const boundLayer = Layer.merge(outboundQueueLayer, turnQueueLayer(threadIdForChatKey)).pipe(
          Layer.provideMerge(larkGatewayLayer(creds)),
        );

        // The bound session in its OWN sub-scope (so `runBoundSession`'s
        // `Effect.scope` is THIS scope and a re-bind interrupt tears it — gateway +
        // forked fibers — down). Self-heal: any NON-interrupt cause (incl. the
        // `gateway.connect` `orDie` defect) is logged and converted to a typed
        // `FeishuSessionFailure`, which `retry` rebuilds the scope+gateway for with
        // backoff (the infinite schedule means it never actually surfaces). An
        // interrupt (raceFirst won by a binding change) is re-raised via
        // `Effect.interrupt` — NOT a typed failure, so `retry` lets it through and
        // re-bind always wins. Env-override credentials self-heal the same way.
        const boundSession = Effect.scoped(
          runBoundSession(config, resolved, creds, ownerRef, chatConfigsRef, chatDefaultsRef).pipe(
            Effect.provide(boundLayer),
          ),
        ).pipe(
          Effect.catchCause((cause) =>
            // Interrupt (re-bind won by raceFirst): re-interrupt so this fiber
            // terminates and the winner proceeds. NOT a typed failure → `retry`
            // never retries it. (Re-raising via `failCause` would leak the
            // session's typed-error union back into the channel; a fresh
            // `Effect.interrupt` is `Effect<never, never>` and equally terminal.)
            Cause.hasInterrupts(cause)
              ? Effect.interrupt
              : // Stringify + redact the cause before logging: `creds.appSecret`
                // is in scope here, so even if the Lark SDK ever echoes it inside a
                // connect/session error, the secret-isolation red line holds. We log
                // the redacted `Cause.pretty` text (not the raw cause object, which
                // the structured logger could serialise verbatim) — non-secret
                // debug detail is preserved.
                Effect.logWarning(
                  "[feishu-bot] feishu session ended unexpectedly; reconnecting with backoff... " +
                    redactSecret(Cause.pretty(cause), creds.appSecret),
                ).pipe(Effect.andThen(Effect.fail(new FeishuSessionFailure()))),
          ),
          Effect.retry(SESSION_RETRY_SCHEDULE),
        );

        if (resolution.source === "env") {
          // Dev override: credentials are fixed → never re-bind; run (self-healing)
          // until the process exits. `boundSession` never succeeds, so `return
          // yield*` marks the definitive exit point.
          return yield* boundSession;
        } else {
          // Server-fetched: run until the binding changes away from the creds we
          // are running (`sessionIdentity`). `Stream.drop(1)` skips the REPLAYED
          // current value so we only react to genuine FUTURE changes — without it,
          // a startup race where the loop's RPC beats the watcher's first snapshot
          // (so `bindingView` is still the seed `null`) would read that `null` as a
          // change and tear the just-started session down spuriously. After the
          // drop, the watcher's snapshot re-publishes the SAME identity, which
          // `bindingIdentityEq` filters out; a real re-bind / unbind publishes a
          // differing identity (or `null`) and wins the race. (The vanishingly rare
          // case where the binding moved on between the RPC and this subscribe is
          // re-synced by the next binding change — acceptable per the known-races
          // note.)
          yield* boundSession.pipe(
            Effect.raceFirst(
              SubscriptionRef.changes(bindingView).pipe(
                Stream.drop(1),
                Stream.filter((id) => !bindingIdentityEq(id, sessionIdentity)),
                Stream.runHead,
                Effect.asVoid,
              ),
            ),
          );
          yield* Console.log("[feishu-bot] bot binding changed; re-acquiring credentials...");
        }
      }).pipe(Effect.forever);
    });

    return yield* resident.pipe(Effect.provide(outerLayer), Effect.scoped);
  }).pipe(
    Effect.catchTags({
      EnvironmentRequestInvalidError: reportAuthFailure,
      EnvironmentAuthInvalidError: reportAuthFailure,
      EnvironmentScopeRequiredError: reportAuthFailure,
      EnvironmentOperationForbiddenError: reportAuthFailure,
      EnvironmentInternalError: reportAuthFailure,
      RemoteEnvironmentAuthFetchError: reportAuthFailure,
      RemoteEnvironmentAuthInvalidJsonError: reportAuthFailure,
      RemoteEnvironmentAuthUndeclaredStatusError: reportAuthFailure,
      RemoteEnvironmentAuthTimeoutError: reportAuthFailure,
    }),
    Effect.orDie,
  );
