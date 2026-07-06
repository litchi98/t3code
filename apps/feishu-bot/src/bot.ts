import {
  connectionProjectionPhase,
  EnvironmentRegistry,
  EnvironmentSupervisor,
} from "@t3tools/client-runtime/connection";
import {
  createProject,
  createThread,
  respondToThreadApproval,
  respondToThreadUserInput,
  startThreadTurn,
} from "@t3tools/client-runtime/operations";
import * as EnvironmentRpc from "@t3tools/client-runtime/rpc";
import type { RemoteEnvironmentRequestError } from "@t3tools/client-runtime/rpc";
import {
  derivePendingApprovals,
  derivePendingUserInputs,
  isStalePendingRequestFailureDetail,
} from "@t3tools/client-runtime/state/thread-activity";
import {
  ApprovalRequestId,
  CommandId,
  type EnvironmentId,
  type FeishuChatConfig,
  isProviderAvailable,
  MessageId,
  ModelSelection,
  ORCHESTRATION_WS_METHODS,
  type OrchestrationMessage,
  type OrchestrationProjectShell,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type OrchestrationThreadStreamItem,
  ProjectId,
  type RuntimeMode,
  type ServerProvider,
  ThreadId,
  type TurnId,
  TrimmedNonEmptyString,
  WS_METHODS,
} from "@t3tools/contracts";
import { resolveSelectableModel } from "@t3tools/shared/model";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  DOMAIN_BY_TENANT,
  type FeishuBotConfig,
  type FeishuCredentialOverride,
  type FeishuTenant,
} from "./config.ts";
import { resolveEnvironment, type ResolvedEnvironment } from "./auth.ts";
import { connectionLayer } from "./runtime/connection.ts";
import {
  AuditStore,
  CallbackNonceStore,
  type CardHandle,
  CardHandleStore,
  fileStoresLayer,
  NoticeMemoryStore,
  SentCommandStore,
} from "./runtime/persistence.ts";
import { LarkGateway, type StreamingCard } from "./lark/index.ts";
import { larkGatewayLayer } from "./lark/channel.ts";
import { reportFeishuChatDirectory } from "./chat-directory.ts";
import type { BridgeHandlers, CardActionEvent, InboundMessage, SendOptions } from "./lark/types.ts";
import {
  authorizeApprovalClick,
  authorizeCommand,
  COMMAND_FLOOR,
  isOwnerExempt,
  isWorkspaceAuthorized,
} from "./bridge/authz.ts";
import { effectiveChatConfig } from "./bridge/chatConfig.ts";
import { CallbackAuth, computePolicyFingerprint } from "./bridge/callbackAuth.ts";
import {
  actionToApprovalDecision,
  formValueToAnswers,
  type InteractionContext,
  parseCardActionValue,
  renderInteractionSection,
  type ResolvedNoticeEntry,
} from "./bridge/interactionCard.ts";
import {
  anchorOf,
  compositeChatKey,
  densityForRuntime,
  deriveThreadId,
  ensureThreadForChat,
  refusesFullAccessTakeover,
  resolveRenderDensity,
  runtimeModeForChatType,
  splitChatKey,
} from "./bridge/chatThreadMap.ts";
import { deriveCommandId } from "./bridge/commandId.ts";
import { type RenderDensity, renderThreadCard } from "./bridge/eventRenderer.ts";
import { observeThread, type ThreadObservation } from "./bridge/session.ts";
import { type MergedDispatch, TurnQueue, turnQueueLayer } from "./bridge/turnQueue.ts";
import { OutboundQueue, outboundQueueLayer } from "./bridge/outbound.ts";
import { BindingState, bindingStateLayer } from "./bridge/bindingState.ts";
import { WorkspaceState, workspaceStateLayer } from "./bridge/workspaceState.ts";
import {
  createRejectedNoticeText,
  noProviderNoticeText,
  OfflineRetry,
  runOfflineCreateFlush,
  turnRejectedNoticeText,
  workspaceCollisionOutlet,
} from "./bridge/createIntent.ts";
import { runShellCacheFiber, shellStatus } from "./bridge/shellCache.ts";
import { runShellWatcherFiber } from "./bridge/shellWatcher.ts";
import { tryHandleCommand } from "./bridge/commands/registry.ts";
import { buildCommandTable, WorkspaceCommandError } from "./bridge/commands/handlers.ts";

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

/**
 * Whether `selection` still names a model on a currently-ready provider. Used to
 * validate a persisted `defaultModelSelection` before reusing it: a default that
 * points at a now-disabled/unavailable instance (or a model the instance no
 * longer exposes) must fall back rather than dispatch an unroutable selection.
 */
const isSelectionRoutable = (
  selection: ModelSelection,
  readyProviders: ReadonlyArray<ServerProvider>,
): boolean =>
  readyProviders.some(
    (provider) =>
      provider.instanceId === selection.instanceId &&
      provider.models.some((model) => model.slug === selection.model),
  );

/**
 * Resolve the model selection used to create the thread (and, under an explicit
 * override, to pin every turn — see `buildTurnStart`).
 *
 * Priority:
 *  1. **`T3_MODEL` override** (when set): wins over everything. Match it across
 *     *all* ready providers via the shared canonical resolver
 *     (`resolveSelectableModel`, which honours per-driver slug aliases such as
 *     `opus` → the canonical slug and name matches), preferring an exact/alias
 *     hit. Die — listing the available slugs across *every* ready provider — if
 *     nothing matches.
 *  2. The selected project's **`defaultModelSelection`** (passed by the
 *     caller; M-1 resolves this per chat from the chat's selected workspace),
 *     but only if it still names a model on a ready provider; otherwise fall
 *     back (with a warning).
 *  3. The **first ready provider's first model**.
 *
 * "Ready" mirrors the web client: `enabled && isProviderAvailable && status ===
 * "ready"`. Dies with a clear message when no ready provider (or no model on
 * one) is available.
 */
const resolveModelSelection = (
  defaultModelSelection: ModelSelection | null,
  modelOverride: string | null,
) =>
  Effect.gen(function* () {
    const serverConfig = yield* EnvironmentRpc.request(WS_METHODS.serverGetConfig, {});
    const readyProviders = serverConfig.providers.filter(
      (provider) =>
        provider.enabled && isProviderAvailable(provider) && provider.status === "ready",
    );
    if (readyProviders.length === 0) {
      return yield* Effect.die(
        new Error("No enabled, available, ready provider is available to start a thread."),
      );
    }

    // 1. Explicit T3_MODEL override: match across ALL ready providers via the
    //    shared canonical resolver (driver-aware alias + name matching),
    //    preferring an exact/alias hit over a later candidate.
    if (modelOverride !== null) {
      const matches: ReadonlyArray<ModelSelection> = readyProviders.flatMap((provider) => {
        const slug = resolveSelectableModel(provider.driver, modelOverride, provider.models);
        return slug === null
          ? []
          : [{ instanceId: provider.instanceId, model: slug } satisfies ModelSelection];
      });
      const chosen = matches[0];
      if (chosen === undefined) {
        const available = readyProviders
          .flatMap((provider) =>
            provider.models.map((model) => `${provider.instanceId}/${model.slug}`),
          )
          .join(", ");
        return yield* Effect.die(
          new Error(
            `No model on any ready provider matches T3_MODEL="${modelOverride}". ` +
              `Available: ${available || "(none)"}.`,
          ),
        );
      }
      if (matches.length > 1) {
        yield* Console.warn(
          `[feishu-bot] T3_MODEL="${modelOverride}" matched ${matches.length} ready providers; ` +
            `using ${chosen.instanceId}/${chosen.model}.`,
        );
      }
      return chosen;
    }

    // 2. No override: prefer the project's persisted default, but only if it is
    //    still routable on a ready provider; otherwise fall back with a warning.
    if (defaultModelSelection !== null) {
      if (isSelectionRoutable(defaultModelSelection, readyProviders)) {
        return defaultModelSelection;
      }
      yield* Console.warn(
        `[feishu-bot] project default model ${defaultModelSelection.instanceId}/` +
          `${defaultModelSelection.model} is no longer on a ready provider; ` +
          "falling back to the first ready provider's first model.",
      );
    }

    // 3. First ready provider's first model.
    const provider = readyProviders[0]!;
    const firstModel = provider.models[0];
    if (firstModel === undefined) {
      return yield* Effect.die(new Error(`Provider ${provider.instanceId} exposes no models.`));
    }
    return { instanceId: provider.instanceId, model: firstModel.slug } satisfies ModelSelection;
  });

/** Generate a branded id from a fresh UUIDv4 using the platform crypto service. */
const makeBrandedId = <A>(brand: { readonly make: (value: string) => A }) =>
  Crypto.Crypto.pipe(
    Effect.flatMap((crypto) => crypto.randomUUIDv4),
    Effect.orDie,
    Effect.map((uuid) => brand.make(uuid)),
  );

/**
 * Decode a `TrimmedNonEmptyString`. Compiled once at module scope (the schema's
 * decoder is rebuilt on every call site otherwise). Used only for the
 * statically-valid placeholder title, so callers `Effect.orDie` the result.
 */
const decodeTrimmedNonEmpty = Schema.decodeEffect(TrimmedNonEmptyString);

/**
 * Decode a {@link ModelSelection} from a plain literal. Compiled once at module
 * scope. Used only for the statically-valid placeholder selection (M-1: the
 * placeholder thread no longer inherits a startup project/model), so callers
 * `Effect.orDie` the result.
 */
const decodeModelSelection = Schema.decodeUnknownEffect(ModelSelection);

/**
 * The set of request ids whose pending approval/user-input was force-resolved by
 * a *stale/unknown* provider respond failure (M11). Scans the activity log for
 * `provider.{approval,user-input}.respond.failed` activities whose detail matches
 * {@link isStalePendingRequestFailureDetail}, surfacing their `requestId` so the
 * interaction renderer greys those controls out ("请求已失效") instead of leaving
 * a dead button. Pure; mirrors the same failed-kind detection the shared derive
 * helpers and the web/mobile clients use.
 */
const staleRequestIdsOf = (
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlySet<string> => {
  const stale = new Set<string>();
  for (const activity of activities) {
    if (
      activity.kind !== "provider.approval.respond.failed" &&
      activity.kind !== "provider.user-input.respond.failed"
    ) {
      continue;
    }
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId = typeof payload?.requestId === "string" ? payload.requestId : null;
    const detail = payload && typeof payload.detail === "string" ? payload.detail : undefined;
    if (requestId && isStalePendingRequestFailureDetail(detail)) {
      stale.add(requestId);
    }
  }
  return stale;
};

/** TTL for a callback button token: 24h (the card outlives a single turn). */
const CALLBACK_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Feishu's client locks a submitted form for ~1s (FORM_SETTLE_MS). Updating the
 * card before that lock clears rolls the update back, so a user-input *form*
 * submit echo waits this long before re-rendering. An approval (plain button)
 * echo is immediate.
 */
const FORM_SETTLE_DELAY = Duration.seconds(1);

/**
 * M3b: upper bound on the per-bystander "unauthorised click" dedup set. Realistic
 * bystander volume is tiny, but the set is keyed by `(chatKey, messageId, openId)`
 * and lives for the whole bridge scope, so a long-running, high-traffic group
 * could grow it without limit. On overflow we keep the most recent ~80% (Set
 * iteration order ≈ insertion order) and drop the oldest entries.
 */
const MAX_BYSTANDER_KEYS = 10_000;

// ── M3a (group + topic) routing helpers ──────────────────────────────────────

/**
 * Build the SDK {@link SendOptions} that post a streaming card *inside* a Feishu
 * topic or plain-group thread (M3a). Only produced when BOTH an anchor
 * (`larkThreadId`, non-undefined for topic / in-thread plain-group turns) and a
 * reply target (`replyTo`, the triggering message) are known — Feishu requires
 * `replyTo` to anchor the card inside the thread. Otherwise `undefined`, which
 * posts at the chat root (pre-M3a behaviour, and the acceptable degradation for
 * the observe path which has no triggering message). p2p always yields `undefined`
 * (`anchorOf` returns `undefined` for p2p, so no `larkThreadId` is ever set).
 * Plain-group and topic turns carry the composite anchor (rootId / messageId) and
 * post with `replyInThread: true`, which is also why plain-group turns require
 * topic mode (Feishu error 230071 otherwise).
 */
const topicSendOpts = (
  larkThreadId: string | undefined,
  replyTo: string | undefined,
): SendOptions | undefined =>
  larkThreadId !== undefined && replyTo !== undefined
    ? { replyTo, replyInThread: true }
    : undefined;

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

    // Fix B: per-bystander dedup so the "unauthorised click" notice fires at most
    // once per (chatKey, card messageId, clicker openId) triple. Realistic bystander
    // volume is tiny, but the set lives for the whole bridge scope, so the write
    // site (M3b) clamps it to `MAX_BYSTANDER_KEYS`, dropping the oldest keys on
    // overflow — bounded memory without breaking the at-most-once dedup.
    const bystanderNoticed = yield* Ref.make<ReadonlySet<string>>(new Set<string>());

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

    // P3: openId → resolved Feishu display name. The cardAction echo prefers the
    // name the event already carried (`evt.operator.name`), then this in-process
    // cache, then a one-off `gateway.getUser` contact lookup (cached on success).
    // A lookup failure (missing `contact:user.base:readonly` scope → 403, etc.)
    // is swallowed and falls back to the raw openId — never blocking the echo.
    const operatorNames = yield* Ref.make<ReadonlyMap<string, string>>(new Map());

    /**
     * Run an environment-scoped orchestration command on the connected
     * environment, discharging its `EnvironmentSupervisor` (via `registry.run`)
     * and `Crypto` requirements and surfacing any RPC/unavailable failure as a
     * defect. Returns a fully total `Effect<A>` the bridge can compose freely.
     */
    const runOnEnv = <A, E>(
      operation: Effect.Effect<A, E, Crypto.Crypto | EnvironmentSupervisor>,
    ): Effect.Effect<A> =>
      registry
        .run(environmentId, operation)
        .pipe(Effect.provideService(Crypto.Crypto, crypto), Effect.orDie);

    // Branded-id generator with `Crypto` already provided → fully total effect.
    const genId = <A>(brand: { readonly make: (value: string) => A }): Effect.Effect<A> =>
      makeBrandedId(brand).pipe(Effect.provideService(Crypto.Crypto, crypto));

    // `subscribeThread` stream for the session observer (replays a snapshot
    // first; the defensive retry mirrors M0's create→subscribe propagation lag).
    const subscribeThread = (threadId: ThreadId): Stream.Stream<OrchestrationThreadStreamItem> =>
      registry
        .followStream(
          environmentId,
          EnvironmentRpc.subscribe(
            ORCHESTRATION_WS_METHODS.subscribeThread,
            { threadId },
            {
              onExpectedFailure: () =>
                Console.log("[feishu-bot] thread not ready yet; retrying subscription..."),
              retryExpectedFailureAfter: "250 millis",
            },
          ),
        )
        .pipe(Stream.orDie);

    // Point read of whether the t3code environment is currently connected
    // (`ready`). Used to gate first-contact thread creation: a brand-new chat
    // arriving while the server is offline must be buffered (⏳ + outbound queue)
    // rather than orDie'ing inside the `createThread` dispatch. Never fails
    // (a not-yet-registered environment reads as "not ready").
    const isEnvReady: Effect.Effect<boolean> = registry.state(environmentId).pipe(
      Effect.map((state) => connectionProjectionPhase(state) === "ready"),
      Effect.orElseSucceed(() => false),
    );

    // A minimal, schema-valid `OrchestrationThread` used as the seed for the
    // first card render (before any tick) and as the envelope for static notice
    // cards. Built once from real branded ids + the resolved model selection, so
    // it satisfies every required field with proper types — no `as unknown`
    // cast. `renderThreadCard` only reads `messages`/`activities`/`session`; the
    // rest is well-typed filler.
    // A statically-valid constant; a decode failure here would be a programmer
    // error, so surface it as a defect rather than threading `SchemaError`.
    const placeholderTitle = yield* decodeTrimmedNonEmpty("feishu-bot").pipe(Effect.orDie);
    const placeholderTimestamp = "1970-01-01T00:00:00.000Z";
    const placeholderThreadId = yield* genId(ThreadId);
    const placeholderMessageId = yield* genId(MessageId);
    // M-1: with no startup project the placeholder carries *synthetic* ids. It
    // is a local render seed only — `renderThreadCard` reads
    // `messages`/`activities`/`session` and never the project/model fields, and
    // the workspace gate guarantees a real selected project exists before any
    // real thread render replaces this seed. The decode is statically valid, so
    // a failure is a programmer error (defect), same as `placeholderTitle`.
    const placeholderProjectId = yield* genId(ProjectId);
    const placeholderModelSelection = yield* decodeModelSelection({
      instanceId: "feishu-bot",
      model: "placeholder",
    }).pipe(Effect.orDie);
    const placeholderThread: OrchestrationThread = {
      id: placeholderThreadId,
      projectId: placeholderProjectId,
      title: placeholderTitle,
      modelSelection: placeholderModelSelection,
      // Safe default for the first streaming frame: driveTurn / runObserveFiber
      // render this placeholder before the real snapshot arrives, and
      // approval-required carries no header badge — so the card never flashes a
      // misleading red `bypass` for what is actually an approval-required session.
      // The real runtimeMode overwrites it on the first folded frame. (sendNotice
      // renders this thread with chrome:false, so the value is moot there.)
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt: placeholderTimestamp,
      updatedAt: placeholderTimestamp,
      archivedAt: null,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
      session: null,
    };

    // Render a static, single-message notice card into the placeholder envelope.
    // The notice text rides in as one assistant message so it flows through the
    // real renderer (markdown body, byte clamping) instead of hand-built JSON.
    const makeNoticeThread = (text: string): OrchestrationThread => {
      const message: OrchestrationMessage = {
        id: placeholderMessageId,
        role: "assistant",
        text,
        turnId: null,
        streaming: false,
        createdAt: placeholderTimestamp,
        updatedAt: placeholderTimestamp,
      };
      return { ...placeholderThread, messages: [message] };
    };

    // Send a one-off, non-streaming notice card to `chatId` (e.g. "text only",
    // "server not connected"). Opens a streaming card whose completion is already
    // resolved, so the SDK producer renders once and settles immediately. Failures
    // are logged and swallowed — a notice must never crash the handler.
    // M3a: `chatKey` is the composite `chatId[:larkThreadId]` (the bridge's
    // internal conversation identity). Fix 5: when the notice answers a *triggering*
    // message (`replyToMessageId` supplied) AND the key is a topic, `topicSendOpts`
    // anchors the card inside that topic; for p2p / plain group / no anchor it
    // returns `undefined` so the card posts at the chat/group root (byte-identical
    // to pre-Fix-5). A bare `chatId` (p2p / plain group) has no `larkThreadId`, so
    // the topic opts never fire there.
    const sendNotice = (
      chatKey: string,
      text: string,
      replyToMessageId?: string,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const { chatId, larkThreadId } = splitChatKey(chatKey);
        const done = yield* Deferred.make<void>();
        yield* Deferred.succeed(done, undefined);
        // #3/#4: notice cards carry only a short text body on a synthetic
        // placeholder thread (no real title/workspace), so `chrome: false`
        // suppresses the 🧵 header + 📁 subtitle that would otherwise be noise.
        const card = renderThreadCard(makeNoticeThread(text), {
          streaming: false,
          chrome: false,
        }).card;
        yield* gateway
          .startStreamingCard(
            chatId,
            card,
            { done: Deferred.await(done) },
            topicSendOpts(larkThreadId, replyToMessageId),
          )
          .pipe(
            Effect.tapError((error) =>
              Console.error(`[feishu-bot] notice card failed for chat ${chatId}: ${error.message}`),
            ),
            Effect.ignore,
          );
      });

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

    // ── M-1: per-chat selected workspace resolution ──────────────────────────
    //
    // The three-way status of a conversation's `/workspace` selection, resolved
    // against the *current* shell snapshot at the moment of use (so a project
    // deleted after selection is caught at dispatch time, not trusted forever):
    //   - "none":        the chat never selected a workspace.
    //   - "unavailable": a selection exists but its project is not in the
    //     current snapshot (deleted elsewhere, or the snapshot has not been
    //     seeded yet). The selection is intentionally KEPT (not auto-cleared):
    //     the snapshot can be transiently stale around reconnects, and a
    //     `/workspace` re-select overwrites it anyway.
    //   - "ok":          the selection names a live project (carried along).
    type SelectedWorkspace =
      | { readonly kind: "none" }
      | { readonly kind: "unavailable"; readonly projectId: ProjectId }
      | { readonly kind: "ok"; readonly project: OrchestrationProjectShell };

    const selectedWorkspaceFor = (chatKey: string): Effect.Effect<SelectedWorkspace> =>
      Effect.gen(function* () {
        const projectId = yield* workspace.get(chatKey);
        if (projectId === null) {
          return { kind: "none" } satisfies SelectedWorkspace;
        }
        const snapshot = yield* shellCache.current;
        const project = snapshot?.projects.find((candidate) => candidate.id === projectId);
        return project === undefined
          ? ({ kind: "unavailable", projectId } satisfies SelectedWorkspace)
          : ({ kind: "ok", project } satisfies SelectedWorkspace);
      });

    // User-facing gate text for a not-"ok" selection (the workspace gate and
    // the `ensureThread` dispatch-time re-check share this wording).
    const workspaceGateText = (selected: SelectedWorkspace): string =>
      selected.kind === "none"
        ? "请先用 /workspace 选择工作区(发送 /workspace 查看可选项)。"
        : "当前选中的工作区已不可用(项目可能已被删除或服务器尚未同步),请用 /workspace 重新选择。";

    // M-3: a live "ok" selection that a per-chat config change has since NARROWED
    // out of the chat's authorized set. Distinct wording from the none/unavailable
    // gate text so the user re-selects rather than thinking the project vanished.
    const workspaceRevokedText =
      "当前选中的工作区已不在本群授权范围,请用 /workspace 重新选择授权内的工作区。";

    // M-3 dispatch-time workspace authorization: whether `message`'s sender may
    // use `projectId` in this chat right now (owner exempt; `undefined` allowlist
    // = all authorized). Mirrors the approval gate's owner + effectiveChatConfig
    // resolve on the bare chatId.
    const senderMayUseProjectAtDispatch = (
      message: InboundMessage,
      projectId: ProjectId,
    ): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const owner = yield* Ref.get(ownerRef);
        const config = effectiveChatConfig(
          message.chatId,
          yield* Ref.get(chatConfigsRef),
          yield* Ref.get(chatDefaultsRef),
        );
        return isWorkspaceAuthorized({
          owner,
          sender: message.senderId,
          projectId,
          authorized: config.workspaces,
        });
      });

    // PR2: the binding + owner + per-chat config live-refresh fiber is hoisted OUT
    // of this per-binding session into the resident loop's OUTER scope (see
    // `runBindingAndConfigWatcher`). It must outlive any single binding — the owner
    // / per-chat config it publishes are binding-independent — and it doubles as the
    // binding-change watcher that drives re-bind. Here we only consume the shared
    // `ownerRef` / `chatConfigsRef` / `chatDefaultsRef` it maintains.

    // Render the last few messages of a takeover snapshot into a compact
    // markdown transcript (M2b-2). One line per message: `🧑 …` (user) / `🤖 …`
    // (assistant), each on its own paragraph. Each message body is trimmed to a
    // single short excerpt so the takeover card stays light — this is a *simple*
    // transcript, not the live card (no tools/reasoning). The renderer's global
    // byte-clamp is the backstop; this keeps the common case readable.
    const TRANSCRIPT_MESSAGE_COUNT = 5;
    const TRANSCRIPT_EXCERPT_CHARS = 280;
    const renderTranscriptMarkdown = (
      messages: ReadonlyArray<OrchestrationMessage>,
    ): string | null => {
      const recent = messages
        .filter(
          (message) =>
            (message.role === "user" || message.role === "assistant") &&
            message.text.trim().length > 0,
        )
        .slice(-TRANSCRIPT_MESSAGE_COUNT);
      if (recent.length === 0) {
        return null;
      }
      return recent
        .map((message) => {
          const icon = message.role === "user" ? "🧑" : "🤖";
          const text = message.text.trim();
          const excerpt =
            text.length > TRANSCRIPT_EXCERPT_CHARS
              ? `${text.slice(0, TRANSCRIPT_EXCERPT_CHARS)}…`
              : text;
          return `${icon} ${excerpt}`;
        })
        .join("\n\n");
    };

    // Mirror-light: a `/resume` takeover (or a self-created first contact) does
    // not start a resident per-thread observe fiber. `startMirror` re-binds the
    // chat as `origin: "resumed"` then pushes a single, one-off "已接管" card.
    // M2b-2: instead of a shell-status-only notice, it takes a one-shot thread
    // snapshot (the `subscribeThread` stream replays a full snapshot first;
    // `Stream.take(1)` + `Effect.scoped` closes the subscription immediately —
    // the same pattern the cardAction handler uses) and renders a *simple
    // transcript* card from the last few messages. No resident fiber is started
    // (still mirror-light); live streaming resumes only when the user sends the
    // next message (the normal turn path). A null/empty snapshot falls back to
    // the M2a shell-status text notice.
    const startMirror = (
      chatId: string,
      threadId: ThreadId,
      // M3b path A: the `/resume` command message id (belongs to the resumed topic).
      // Used as the in-thread reply anchor for the takeover approval card and stored
      // on the binding as `topicAnchorMessageId` so later topic-anchored cards land
      // inside the topic. Absent (non-`/resume` callers) → cards post at the root.
      replyToMessageId?: string,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        // M2b-3: a `/resume` may re-point a chat that is already mirroring a previous
        // thread. Tear down any existing observe fiber first so the new takeover's
        // `ensureObserving` below is not deduped out by a stale entry under this
        // chatId (which would leave the chat observing the OLD thread). Idempotent
        // no-op when nothing is observing.
        yield* stopObserve(chatId);
        // Fix A: clear stale cardHandle so a click on the old card cannot be
        // misidentified as "current card, unauthorised clicker" (bystander no-op).
        // `surfacePendingApprovalIfNew` at the end of startMirror will re-populate
        // the handle if the new thread has a pending approval; otherwise the handle
        // stays absent → any click on the old card correctly falls through to the
        // "degrade stale card" path.
        yield* cardHandles.remove(chatId).pipe(Effect.ignore);
        // M3b: anchor later topic-anchored cards (path A surfaces below, path B's
        // watcher) to the `/resume` command message — it belongs to the resumed
        // topic, whereas `anchorOf` may yield an `omt_…` Feishu rejects as a reply
        // target. exactOptionalPropertyTypes: omit the key when absent rather than
        // assigning `undefined` (see persistence.ts `migrateChatBinding`). Density is
        // deliberately NOT stored here — a clean per-thread `runtimeMode` is not yet
        // available (the snapshot is read below), and the placeholder's
        // `densityForRuntime(placeholderThread.runtimeMode, …)` fallback is safe.
        yield* bindings.bind(chatId, {
          threadId,
          origin: "resumed",
          ...(replyToMessageId !== undefined ? { topicAnchorMessageId: replyToMessageId } : {}),
        });
        const shell = yield* shellCache.threadById(threadId);
        const title = shell?.title ?? threadId;
        // Map the shared `shellStatus` classifier to this card's Chinese line, so
        // the takeover card and the `/status` tag stay in lock-step on one split.
        const statusLine = {
          running: "状态: 运行中",
          "pending-approval": "状态: 有待批准操作",
          idle: "状态: 空闲",
          unknown: "(状态未知)",
        }[shellStatus(shell)];

        // One-shot snapshot for the transcript. Any failure here must NOT block
        // the takeover — fall back to the M2a status-only notice. `Effect.option`
        // turns a (typed) read failure into `None`; `Option.flatten` collapses the
        // resulting `Option<Option<item>>` back to `Option<item>`.
        // #7: `subscribeThread` is `orDie`'d and retries a not-ready subscription
        // forever, so a deleted/never-delivering thread would hang the user's
        // `/resume` indefinitely. Bound the read with a `timeout` (→ None) so the
        // takeover always settles into the status-only fallback within ~10s.
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

        // ── M2b-3: live-mirror a takeover of an *already-running* turn ───────────
        // If the snapshot shows a turn currently running (`session.activeTurnId`),
        // start a resident observe fiber that mirrors its progress/approvals/result
        // onto a live streaming card until it ends — then `ensureObserving` itself
        // returns and the chat falls back to mirror-light. When observe DID start we
        // RETURN here, skipping both the transcript card AND 修法 A's one-shot surface:
        // the observe card already carries the full live state *and* the interaction
        // controls (via `buildInteraction` per tick), so a transcript + a separate
        // approval card would be a redundant double-post for the same takeover. With
        // no active turn we keep the existing mirror-light behaviour (transcript +
        // 修法 A). `ensureObserving`'s own gates (isChatBusy / dedup) make this safe to
        // call unconditionally.
        //
        // Safety net — `ensureObserving` may decline to start (e.g. `isChatBusy`, or a
        // claim it then self-evicts). When it does, `isObserving` stays false and we
        // must NOT silently swallow the takeover: fall through to the transcript + 修法
        // A path so the operator still sees the current state and any pending approval
        // (修法 A's dedup compares the real top requestId against the handle, so it
        // never double-posts the same request). With the Bug-C defer gate removed, an
        // outstanding-approval takeover now normally observes (and the observe fiber
        // adopts the recovered card), so this fall-through rarely fires — but it is a
        // harmless backstop.
        if (snapshotThread?.session?.activeTurnId != null) {
          yield* ensureObserving(chatId, threadId, snapshotThread.session.activeTurnId);
          if (yield* isObserving(chatId)) {
            return;
          }
        }

        const transcript =
          snapshotThread === null ? null : renderTranscriptMarkdown(snapshotThread.messages);

        if (transcript !== null) {
          yield* sendNotice(
            chatId,
            [
              `已接管会话: ${title}`,
              statusLine,
              "",
              "最近对话:",
              transcript,
              "",
              "发送消息即可继续这个会话;/status 查看状态,/release 退出。",
            ].join("\n"),
          );
        } else {
          // Fallback (no snapshot, or no message history): the M2a status-only card.
          yield* sendNotice(
            chatId,
            [
              `已接管会话: ${title}`,
              statusLine,
              // The shell view carries no message history and the snapshot was
              // unavailable/empty; be honest that full history lives elsewhere.
              "(完整历史请见终端/Web)",
              "发送消息即可继续这个会话;/status 查看状态,/release 退出。",
            ].join("\n"),
          );
        }

        // ── M2b-2 (修法 A): surface a pre-existing pending approval on takeover ──
        //
        // The §11E "电脑→飞书 approval 接手" promise: a turn started on web that is
        // *blocked on an approval/user-input* must become actionable from Feishu the
        // moment the operator `/resume`s. The transcript card above is a *messages*
        // view only — it never carries the interaction controls. So when a request is
        // still pending, emit ONE actionable card whose freshly-signed buttons let the
        // `/resume` operator approve cross-end.
        //
        // This now delegates to the shared `surfacePendingApprovalIfNew` helper (the
        // same one 修法 B's watcher calls) so the takeover-surface and the follow-on
        // surface stay byte-for-byte consistent (one render/send/persist path, AGENTS
        // anti-duplication). On takeover there is no prior CardHandle, so the helper's
        // single-source dedup naturally passes and surfaces approval #1 — persisting
        // its requestId as the dedup baseline the watcher then composes with (it skips
        // the same id and surfaces a later #2). The operator captured by
        // `handleInbound` before routing `/resume` is read from `chatOperators` inside
        // the helper. Still mirror-light: no resident observe fiber. Robustness
        // (catchCause) lives inside the helper.
        //
        // #7: reuse the `snapshotThread` we already read above for the transcript card
        // instead of letting the helper take a *second* one-shot snapshot — that
        // doubled the takeover latency (two reads, each bounded by the 10s subscribe
        // timeout). Passing it (even `null`) tells the helper "use this; do not read".
        yield* surfacePendingApprovalIfNew(chatId, threadId, snapshotThread, replyToMessageId);
      });

    // Read-only probe: is the chat busy (a turn running OR coalescing pending)?
    // Used by `/resume` to refuse a re-bind while a turn is in flight *or* about
    // to dispatch (the idle merge window). Reads the turn queue's busy view.
    const isChatBusy = (chatId: string): Effect.Effect<boolean> => turnQueue.isBusy(chatId);

    // ── M2b-3: resident observe-fiber registry (cross-end turn mirroring) ────────
    //
    // A `/resume` takeover (or a follow-on turn web starts after takeover) of a turn
    // the bridge did NOT drive must be mirrored live onto a Feishu card until it
    // ends. `ensureObserving` forks one `runObserveFiber` per chat and registers it
    // here.
    //
    // Dedup is keyed on CHAT-ID PRESENCE + SELF-EVICTION — NOT per-turn. The registry
    // holds at most one entry per `chatId`; `ensureObserving` skips when one is
    // already present (`map.has(chatId)`), and the fiber removes its own entry on exit
    // (self-eviction). The consequence is deliberate: a chat's CONSECUTIVE turns reuse
    // the SAME observe fiber and the SAME card — on an A→B turn rotation that never
    // surfaces `activeTurnId === null` between the two (a direct chain), fiber A keeps
    // folding the same thread subscription and mirrors B's progress onto its existing
    // card (continuous mirror). B's own `ensureObserving` is deduped out by the present
    // chat-id entry. This is the intended "纳入接管后新 turn" behaviour; it is NOT a
    // per-turn fiber rotation (that would break the continuous mirror). The only
    // identity used by guards is the per-attempt `token`; nothing keys on a turnId.
    //
    // Each per-chat entry carries a unique `token` (a fresh monotonic counter value)
    // plus the `fiber` (for interruption); the token — NOT a fiber reference — is the
    // identity used by every guard, so the claim→install→self-evict handshake is
    // immune to fiber-completion timing (a fiber that finishes before its handle is
    // even installed still evicts exactly its own token, never a newer entry).
    //
    // ALL reads/writes go through `Ref.modify` (atomic; Effect's cooperative
    // scheduling means no interleaving mid-`modify`), and `Fiber.interrupt` ALWAYS
    // runs AFTER the modify, outside the lock — the exact `turnQueue.ts` "decide in
    // modify, side-effect outside" pattern; the equality guard is on `token`.
    interface ObserveState {
      /** The forked observe fiber, or `null` in the claim→install window. */
      readonly fiber: Fiber.Fiber<void> | null;
      /** Unique per observe attempt; the sole identity used by every guard. */
      readonly token: number;
    }
    const activeRenderFibers = yield* Ref.make<ReadonlyMap<string, ObserveState>>(new Map());
    // Monotonic source for {@link ObserveState.token}s; never reused.
    const nextObserveToken = yield* Ref.make<number>(1);

    // Read-only: is an observe fiber currently registered for this chat? Used as
    // `surfacePendingApprovalIfNew`'s second door (an observe card already carries
    // the interaction, so a surface would double-post) and inside `ensureObserving`.
    const isObserving = (chatId: string): Effect.Effect<boolean> =>
      Ref.get(activeRenderFibers).pipe(Effect.map((map) => map.has(chatId)));

    // Atomically remove this chat's observe entry and interrupt its fiber (outside
    // the modify). No-op if none. `stopMirror` (so `/release` + watcher teardown
    // tear the mirror down) and `runTurn`'s pre-dispatch preemption both call it.
    const stopObserve = (chatId: string): Effect.Effect<void> =>
      Ref.modify(
        activeRenderFibers,
        (map): readonly [Fiber.Fiber<void> | null, ReadonlyMap<string, ObserveState>] => {
          const existing = map.get(chatId);
          if (existing === undefined) {
            return [null, map];
          }
          const next = new Map(map);
          next.delete(chatId);
          return [existing.fiber, next];
        },
      ).pipe(
        // Interrupt OUTSIDE the modify (lock), per the turnQueue Ref.modify+side-
        // effect-after pattern. Closing the fiber tears down its child scope →
        // unsubscribes the observed thread (see `runObserveFiber`). The fiber's own
        // self-evict finalizer is then a no-op (its token is already gone).
        Effect.flatMap((fiber) => (fiber === null ? Effect.void : Fiber.interrupt(fiber))),
      );

    // Mirror-light teardown is now the real observe teardown (M2b-3): interrupt the
    // chat's resident observe fiber (if any) so a `/release` / unbind / reconcile
    // stops the cross-end mirror. The candidate cache lives inside
    // `buildCommandTable`'s closure and is self-pruning, so there is nothing else to
    // clear here.
    const stopMirror = (chatId: string): Effect.Effect<void> => stopObserve(chatId);

    // Central trigger gate for cross-end turn mirroring. Forks a `runObserveFiber`
    // for `chatId`/`threadId` iff a turn is genuinely running on `threadId` that the
    // bridge is NOT itself driving and is NOT already observing.
    //
    // Gating (in order):
    //  1. `activeTurnId == null` → no live turn to mirror → skip.
    //  2. `isChatBusy(chatId)` → the bridge is driving (or about to dispatch) a turn
    //     for this chat; `driveTurn` owns the card. Observing too would double-render
    //     this end's own turn → skip. (driveTurn > observe; `runTurn` also preempts.)
    //  3. Atomic reservation (TOCTOU-free): a SINGLE `Ref.modify` both dedups and
    //     claims. If an entry already exists for this chat (observing, or a claim in
    //     flight) → return `false`, change nothing — this is the CHAT-ID-presence
    //     dedup, so a chat's later turn reuses the in-place fiber rather than starting
    //     a second one. Otherwise mint a fresh `token`, write the CLAIM marker
    //     `{ fiber: null, token }`, and return `true`. Because the dedup-check and the
    //     claim-write are the same atomic modify, two racing callers (startMirror on
    //     one fiber, the shellWatcher on another) can never BOTH see "free" and both
    //     fork — exactly one wins the claim; the loser sees the claim and skips. The
    //     winner forks (forking cannot happen inside a modify) and installs the real
    //     fiber into the slot — but only if its own `token` is still the current entry
    //     (guarded), so a concurrent `stopObserve` or self-evict wins and the just-
    //     forked fiber is interrupted, never leaked.
    const ensureObserving = (
      chatId: string,
      threadId: ThreadId,
      activeTurnId: TurnId | null,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (activeTurnId === null) {
          return;
        }
        // driveTurn (this end's own turn) wins over observe: never mirror a turn the
        // bridge is itself driving for this chat (would double-render).
        if (yield* isChatBusy(chatId)) {
          return;
        }
        // Bug C — an outstanding M2b-2 / M18 approval card does NOT block observe.
        // When a resumed chat was blocked on an approval at restart, M18 recovery
        // (`recoverApprovalCards`) re-renders that approval onto the EXISTING card
        // (old `messageId`) and writes a handle with `pendingRequestId != null`.
        // Rather than DEFER (which left a chat that is simultaneously running AND
        // awaiting an approval with no progress mirror — the normal §11E case — and
        // could pin forever on a stale cross-thread handle), `runObserveFiber` ADOPTS
        // that recovered card: if the persisted handle still solicits a currently-
        // live-pending request it continues rendering onto the same `messageId` via
        // `updateCard` (no new card, no `persistHandle(null)` clobber, operator
        // re-signed from the handle); otherwise it opens a fresh streaming card.
        // So we proceed to claim/observe unconditionally here — the adopt-vs-open
        // decision is made inside the fiber once it has the authoritative first frame.
        // Atomic dedup + claim (see the block comment above). Mint the token first;
        // the modify only consumes it (writes the claim) when the slot is free, so an
        // unused token on the dedup path is harmless (it is simply never installed).
        const token = yield* Ref.modify(nextObserveToken, (n) => [n, n + 1] as const);
        const claimed = yield* Ref.modify(
          activeRenderFibers,
          (map): readonly [boolean, ReadonlyMap<string, ObserveState>] => {
            if (map.has(chatId)) {
              // Already observing (a fiber is registered, or a claim is in flight) →
              // do not start a second one for this chat.
              return [false, map];
            }
            // Free: place the claim marker (fiber filled in after fork).
            return [true, new Map(map).set(chatId, { fiber: null, token })];
          },
        );
        if (!claimed) {
          return;
        }
        // We own the claim. Fork the observe fiber (cannot fork inside `modify`) — it
        // carries our `token` and self-evicts by it on exit — then install the real
        // fiber into the slot, but only if OUR token is still the current entry. A
        // concurrent `stopObserve` (preemption) or a fast self-evict (the turn was
        // already terminal) may have removed/replaced it; if so the fiber is orphaned
        // and we interrupt it so it does not leak an open thread subscription.
        const fiber = yield* runObserveFiber(chatId, threadId, token);
        const installed = yield* Ref.modify(
          activeRenderFibers,
          (map): readonly [boolean, ReadonlyMap<string, ObserveState>] => {
            const existing = map.get(chatId);
            if (existing !== undefined && existing.token === token) {
              return [true, new Map(map).set(chatId, { fiber, token })];
            }
            return [false, map];
          },
        );
        if (!installed) {
          yield* Fiber.interrupt(fiber);
          return;
        }
        // Bug A — close the `isChatBusy`-gate ↔ claim TOCTOU. The `isChatBusy` check
        // above (turnQueue.states Ref) and the claim (activeRenderFibers Ref) are two
        // independent atomics with a yield point between them, so a concurrent
        // `runTurn` can interleave: it does `beginTurn` (sets running=true) → then
        // `stopObserve` (which is a no-op if our claim wasn't installed yet). The bad
        // window is `runTurn`'s `stopObserve` running while our slot is empty (claim
        // minted, fiber not yet installed): `driveTurn` then opens its own card AND we
        // install our observe fiber → two streaming cards fight, and `runTurn`'s
        // one-shot `stopObserve` already ran, so observe is never torn down.
        //
        // Re-read `isChatBusy` AFTER a successful install. Invariant that closes the
        // window: `runTurn` calls `beginTurn` (running=true) BEFORE its `stopObserve`.
        //  • If our install lands AFTER `runTurn`'s `stopObserve`, then `beginTurn`
        //    already ran, so this re-check sees `isChatBusy === true` and we evict
        //    ourselves here.
        //  • If our install lands BEFORE `runTurn`'s `stopObserve`, that `stopObserve`
        //    sees our installed fiber and interrupts it.
        // Either way the just-installed observe is torn down — no double render. The
        // eviction uses the SAME token/fiber identity guard as `stopObserve`/self-
        // evict: only remove the slot if it still carries OUR token (a preempting
        // install must never be clobbered), and `Fiber.interrupt` runs AFTER the
        // `modify`, outside the lock (the turnQueue.ts pattern).
        if (yield* isChatBusy(chatId)) {
          const evicted = yield* Ref.modify(
            activeRenderFibers,
            (map): readonly [Fiber.Fiber<void> | null, ReadonlyMap<string, ObserveState>] => {
              const existing = map.get(chatId);
              if (existing === undefined || existing.token !== token) {
                return [null, map];
              }
              const next = new Map(map);
              next.delete(chatId);
              return [existing.fiber, next];
            },
          );
          if (evicted !== null) {
            yield* Fiber.interrupt(evicted);
          }
        }
      });

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

    // Per-chat turn lock: guarantees at most one turn runs for a chat at a time
    // regardless of path. The live queue's `running` flag already serialises
    // *live* turns, but a turn replayed from the outbound flush on reconnect does
    // not pass through `offer` and so would otherwise be invisible to that flag —
    // this lock keeps a flushed turn from dispatching concurrently with a fresh
    // live turn on the same thread (which would steer/overwrite the agent). Locks
    // are created lazily per chat and never reaped (one tiny Semaphore per chat is
    // negligible for M1's 1:1 traffic).
    const chatTurnLocks = yield* Ref.make<ReadonlyMap<string, Semaphore.Semaphore>>(new Map());
    const withChatTurnLock = <A, E>(chatId: string, effect: Effect.Effect<A, E>) =>
      Ref.modify(
        chatTurnLocks,
        (map): readonly [Semaphore.Semaphore, ReadonlyMap<string, Semaphore.Semaphore>] => {
          const existing = map.get(chatId);
          if (existing !== undefined) {
            return [existing, map];
          }
          const created = Semaphore.makeUnsafe(1);
          return [created, new Map(map).set(chatId, created)];
        },
      ).pipe(Effect.flatMap((lock) => lock.withPermits(1)(effect)));

    // Chats with an offline `createThread` already buffered this session, so a
    // *second* offline message for the same brand-new chat does not enqueue a
    // second create (which would hit the server's "thread already exists"
    // invariant — distinct create commandIds, same deterministic threadId). The
    // binding is persisted by the create intent *on success* (not optimistically),
    // so this in-memory set and the in-memory outbound queue are lost together on
    // a crash — a restart then re-creates the thread cleanly rather than pointing
    // a persisted binding at a thread that was never created.
    const pendingCreates = yield* Ref.make<ReadonlySet<string>>(new Set());

    /**
     * Build the `ThreadTurnStart` command for a merged dispatch. Stable
     * commandId, NO `createdAt` (M9/M19); a fresh `MessageId` per attempt is fine
     * (the server keys idempotency on the stable `commandId`, not the messageId).
     *
     * `modelSelection` is attached ONLY when an explicit `T3_MODEL` override is
     * set (`perTurnModelSelection !== null`); in that case every turn is pinned
     * to the bot-resolved model. Without an override it is omitted so the server
     * keeps the thread's persistent model — preserving the creation-time choice
     * and any model switch made by another end (M2). See `perTurnModelSelection`.
     */
    const buildTurnStart = (threadId: ThreadId, dispatch: MergedDispatch) =>
      genId(MessageId).pipe(
        Effect.map((messageId) =>
          startThreadTurn({
            commandId: dispatch.commandId,
            threadId,
            message: { messageId, role: "user", text: dispatch.prompt, attachments: [] },
            ...(perTurnModelSelection === null ? {} : { modelSelection: perTurnModelSelection }),
            // M3a: per-turn runtimeMode tracks the chat type of the message(s) that
            // drove this turn — p2p stays `full-access`, group/topic is
            // `approval-required`. A dispatched batch always carries ≥1 source
            // message; the `?? "p2p"` keeps the legacy `full-access` default in the
            // (unreachable) empty case so existing p2p behaviour is byte-identical.
            //
            // NOTE: for an *already-existing* thread this field is INERT — the
            // server pins `runtimeMode` at thread-creation time and `turn.start`
            // resolves the active mode from `targetThread.runtimeMode`
            // (decider.ts), IGNORING this command value. It is carried only because
            // `ThreadTurnStart` requires it; it does NOT re-assert per-turn policy.
            // (The group/topic safety gate that matters lives at thread creation +
            // the `/resume` full-access gate, not here.)
            runtimeMode: runtimeModeForChatType(dispatch.sources[0]?.message.chatType ?? "p2p"),
            interactionMode: "default",
          }),
        ),
      );

    /**
     * Build the interaction section (approval buttons / user-input form / stale
     * notices) for one folded thread state, signed for `chatId`'s current
     * operator. Pure derivation from `thread.activities`:
     *  - `derivePendingApprovals` / `derivePendingUserInputs` open the live
     *    pending requests (shared client-runtime logic, the same web/mobile use);
     *  - `staleRequestIdsOf` greys out any request a stale/unknown respond failure
     *    already force-resolved (M11);
     *  - each button is HMAC-signed via `auth.sign` bound to
     *    `(chatId, threadId, runtimeMode, operator, action)` (the policy
     *    fingerprint), with `runtimeMode = thread.runtimeMode` (E②: the render
     *    side uses the thread's own runtimeMode).
     * Returns the `RenderOptions.interaction` value (or `undefined` when there is
     * nothing pending — so the renderer adds no empty section).
     */
    const buildInteraction = (
      // M3a: the composite `chatId[:larkThreadId]` conversation key. State lookups
      // (resolved overlay / operator) read it verbatim; the *token* it signs must
      // carry the REAL Feishu `chatId` (the verify side reads `evt.chatId`) plus
      // the topic id (`InteractionContext.larkThreadId`) so the cardAction handler
      // can recover the topic — both are recovered via `splitChatKey` below.
      chatKey: string,
      thread: OrchestrationThread,
      // #0/#1(b): optional operator override. The live `driveTurn` path omits it
      // and resolves the operator from the in-process `chatOperators` Ref. M18
      // restart recovery passes the operator captured on the persisted card handle
      // (`handle.operatorOpenId`) because the Ref is empty right after a restart —
      // re-signing with an empty open id would never match at verify time and would
      // dead-end the recovered button. A non-empty override wins; otherwise we fall
      // back to the Ref (preserving the existing live behaviour exactly).
      operatorOverride?: string,
    ): Effect.Effect<{ readonly elements: ReadonlyArray<object> } | undefined> =>
      Effect.gen(function* () {
        const pendingApprovals = derivePendingApprovals(thread.activities);
        const pendingUserInputs = derivePendingUserInputs(thread.activities);
        // P2: read the resolved overlay BEFORE the early-return so a turn with no
        // live pending requests but one resolved this session still renders the
        // greyed-out echo ("✅ 已由 @… 允许") — during the turn AND after it completes
        // (when pending is empty). The streaming render has no operator knowledge, so
        // the overlay is the only carrier of the echo. Empty overlay → live state.
        const resolvedNotice =
          (yield* Ref.get(chatResolvedNotices)).get(chatKey) ??
          new Map<string, ResolvedNoticeEntry>();
        if (
          pendingApprovals.length === 0 &&
          pendingUserInputs.length === 0 &&
          resolvedNotice.size === 0
        ) {
          return undefined;
        }
        const operators = yield* Ref.get(chatOperators);
        const rawInitiator =
          operatorOverride !== undefined && operatorOverride.length > 0
            ? operatorOverride
            : (operators.get(chatKey) ?? "");
        // M-2/PR2b: the token's signed `payload.o` is the true turn initiator
        // (initiator-only). WHO may approve is decided by the cardAction gate's
        // three-state mode, NOT here; `payload.o` is only consulted in `initiator`
        // mode, where it must equal the real initiator. The per-turn operator pin
        // (idle-guarded `chatOperators` + `driveTurn`'s `operatorOverride`) keeps
        // `rawInitiator` un-flippable by a mid-turn bystander.
        const operatorOpenId = rawInitiator;
        const staleSet = staleRequestIdsOf(thread.activities);
        // M3a: recover the real Feishu chatId (for the token's `c`/`scope`, matched
        // at verify against `evt.chatId`) and the topic id (signed into the token's
        // `lt` + echoed in the button value) from the composite key. For p2p / plain
        // group the key has no `:`, so `chatId === chatKey` and `larkThreadId` is
        // `undefined` — the token is byte-identical to the pre-M3a shape.
        const { chatId: realChatId, larkThreadId } = splitChatKey(chatKey);
        const ctx: InteractionContext = {
          chatId: realChatId,
          threadId: thread.id,
          operatorOpenId,
          runtimeMode: thread.runtimeMode,
          auth,
          ttlMs: CALLBACK_TOKEN_TTL_MS,
          ...(larkThreadId !== undefined ? { larkThreadId } : {}),
        };
        const elements = renderInteractionSection(
          pendingApprovals,
          pendingUserInputs,
          staleSet,
          resolvedNotice,
          ctx,
        );
        return { elements };
      });

    // ── M2b-2 (修法 A + 修法 B shared): surface a *new* pending request as a card ──
    //
    // Single helper for "a pending approval/user-input exists on `threadId` that
    // Feishu has not yet rendered an actionable card for → send one fresh card and
    // remember it". Used by BOTH:
    //   - 修法 A (`startMirror`): the takeover moment — the approval already pending
    //     when the operator `/resume`s.
    //   - 修法 B (`shellWatcher`): the *chained/follow-on* approvals a resumed turn
    //     raises while the bridge is not live-mirroring (e.g. approve #1 → the turn
    //     continues → #2 appears). The watcher's single resident fiber calls this
    //     each frame the resumed thread's shell `hasPendingApprovals` is true.
    //
    // ── Single-source dedup (the load-bearing bit) ───────────────────────────────
    // `CardHandle.pendingRequestId` is the ONE source of truth for "which request is
    // currently surfaced in Feishu". We read a one-shot thread snapshot, take the
    // *top* pending requestId (approval first, then user-input — the same priority
    // `CardHandle` persistence uses elsewhere), and compare it to the stored handle:
    //   - top requestId === handle.pendingRequestId → already surfaced → return.
    //   - otherwise (no handle, or a different id) → a genuinely new request →
    //     send a new card and persist a handle whose `pendingRequestId` is that top
    //     id, so the next frame/call dedups against it.
    // This is what keeps the watcher from re-spamming the same approval across the
    // many frames it stays pending, and what makes 修法 A and 修法 B compose: 修法 A
    // persists the handle for approval #1 on takeover, so the watcher sees #1 (same
    // id) and skips; once #1 is approved and #2 appears (new id) the watcher surfaces
    // #2. No per-frame diffing — dedup is keyed on the stable requestId.
    //
    // ROBUSTNESS: the whole effect is `catchCause`-wrapped (warn only). A null/empty
    // snapshot, a `buildInteraction`/render failure, a failed card send, or a persist
    // failure must NEVER crash the bot or wedge the watcher's reconciliation loop.
    const surfacePendingApprovalIfNew = (
      // M3a: composite `chatId[:larkThreadId]` conversation key. Used verbatim for
      // every state lookup (busy/observe gates, cardHandles, chatOperators,
      // buildInteraction); the actual card is sent to the real Feishu chatId
      // (`splitChatKey`) at the `startStreamingCard` call below.
      chatId: string,
      threadId: ThreadId,
      // #7: optional already-read first-frame snapshot. `startMirror` reads a first
      // frame for its transcript card and then calls this helper; passing that same
      // snapshot here lets the helper reuse it instead of doing a *second*
      // independent one-shot read (which doubled the `/resume` latency, each read
      // bounded by the 10s subscribe timeout). The watcher (修法 B) does not pre-read
      // and passes nothing, so the helper still reads its own first frame. A
      // `null`/`undefined` value means "read it yourself".
      preReadSnapshot?: OrchestrationThread | null,
      // M3b path A: the `/resume` command message id, used as the in-thread reply
      // anchor so the surfaced card posts inside the topic. Path B (the watcher)
      // passes nothing → falls back to the binding's stored `topicAnchorMessageId`.
      replyToMessageId?: string,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        // #3: race guard. When the bridge is actively driving (or about to dispatch)
        // a turn for THIS chat, `driveTurn` owns the live streaming card and will
        // render the approval/user-input itself — so a surface here would call
        // `startStreamingCard` and post a *second*, parallel card before `driveTurn`
        // has persisted its `pendingRequestId` (the single-source dedup baseline),
        // i.e. the very window where the requestId dedup cannot yet fire. Skip the
        // surface entirely while busy and let `driveTurn` render. Read-only probe
        // (`turnQueue.isBusy`): never mutates the queue's token accounting. (修法 B
        // / the watcher only reconciles `origin: "resumed"` chats; a resumed user
        // sending a live message is exactly when this collision happens.)
        //
        // M2b-3 second door: likewise skip while an observe fiber is mirroring this
        // chat — the observe card already renders the interaction (`buildInteraction`
        // per tick), so a surface here would double-post the same approval. (修法 B
        // calls this on every `hasPendingApprovals` frame; without this gate it would
        // race the live observe card.) `isObserving` is read-only on the registry.
        if ((yield* isChatBusy(chatId)) || (yield* isObserving(chatId))) {
          return;
        }

        // One-shot snapshot read (same bounded pattern as 修法 A / M18 recovery:
        // `subscribeThread` is `orDie`'d and retries forever, so a deleted /
        // never-delivering thread would hang without the timeout). A null snapshot
        // → nothing to surface. #7: reuse a caller-supplied pre-read snapshot when
        // present so `startMirror` does not read the first frame twice.
        const snapshotThread =
          preReadSnapshot !== undefined
            ? preReadSnapshot
            : yield* Stream.runHead(subscribeThread(threadId).pipe(Stream.take(1))).pipe(
                Effect.scoped,
                Effect.timeout(Duration.seconds(10)),
                Effect.option,
                Effect.map(Option.flatten),
                Effect.map((firstFrame) =>
                  Option.match(firstFrame, {
                    onNone: () => null as OrchestrationThread | null,
                    onSome: (item) => (item.kind === "snapshot" ? item.snapshot.thread : null),
                  }),
                ),
              );
        if (snapshotThread === null) {
          return;
        }

        // Top pending requestId: approval first, then user-input. No pending → done.
        const pendingApprovals = derivePendingApprovals(snapshotThread.activities);
        const pendingUserInputs = derivePendingUserInputs(snapshotThread.activities);
        const topRequestId =
          pendingApprovals[0]?.requestId ?? pendingUserInputs[0]?.requestId ?? null;
        if (topRequestId === null) {
          return;
        }

        // Single-source dedup: if the currently-surfaced card already solicits this
        // exact request, it has been surfaced — do not re-send.
        const handleOpt = yield* cardHandles.get(chatId);
        if (Option.isSome(handleOpt) && handleOpt.value.pendingRequestId === topRequestId) {
          return;
        }

        // Operator: a `resumed` binding was `/resume`d by a user, so `chatOperators`
        // is normally populated (the inbound `/resume` set it before routing). After
        // a restart, though, the Ref is empty even though the durable handle still
        // carries the operator who triggered the prior card — so for a brand-new
        // approval that surfaces post-restart we fall back to that persisted operator
        // (in a p2p private chat the takeover operator is the same person, so the
        // persisted open id is valid for the new request too). Reuse the handle read
        // above for the dedup so we don't fetch it twice. If BOTH are empty we still
        // surface the card so the user *sees* a request is pending. M-2: whether its
        // buttons are actionable now depends on the authz gate's per-chat mode, not on
        // this operator: with a bound owner (owner-always) or a `designated`/`all`
        // chat, the card is approvable regardless of the empty operator here. Only in
        // `initiator` mode with no owner does an empty operator yield a readable-but-
        // not-clickable card (the gate then needs `payload.o` = the initiator; no
        // wildcard / auth bypass), prompting a resend — mirroring M18's graceful fallback.
        const operators = yield* Ref.get(chatOperators);
        const operatorOpenId =
          // #5: the trailing `?? ""` was unreachable — the conditional's else branch
          // already yields `""`, so the `??` could only ever see a non-nullish string.
          operators.get(chatId) ?? (Option.isSome(handleOpt) ? handleOpt.value.operatorOpenId : "");

        const interaction = yield* buildInteraction(chatId, snapshotThread, operatorOpenId);
        const density = yield* resolveDensity(chatId, snapshotThread.runtimeMode);
        const card = renderThreadCard(snapshotThread, {
          streaming: false,
          density,
          ...(interaction ? { interaction } : {}),
        }).card;

        // Send a fresh card (one-shot: completion already resolved → render once and
        // settle) and capture its messageId for the persisted handle.
        const done = yield* Deferred.make<void>();
        yield* Deferred.succeed(done, undefined);
        // M3b: anchor the surfaced approval card inside the topic when possible.
        // Path A (`/resume`) supplies the command message id; path B (the watcher)
        // passes nothing and falls back to the binding's stored
        // `topicAnchorMessageId`. `topicSendOpts` only emits in-thread opts when the
        // key is a topic (`larkThreadId` present) AND a reply anchor is known;
        // otherwise `undefined` → posts at the chat/group root (p2p / no anchor).
        const { chatId: realChatId, larkThreadId } = splitChatKey(chatId);
        const binding = yield* bindings.get(chatId);
        const effectiveReplyTo = replyToMessageId ?? binding?.topicAnchorMessageId;
        const sendOpts = topicSendOpts(larkThreadId, effectiveReplyTo);
        const sent = yield* gateway.startStreamingCard(
          realChatId,
          card,
          { done: Deferred.await(done) },
          sendOpts,
        );

        // Persist so this call/frame's surfaced request is the dedup baseline for the
        // next one, and so M18 restart recovery can re-render it.
        yield* cardHandles.put(chatId, {
          messageId: sent.messageId,
          pendingRequestId: topRequestId,
          lastSequence: 0,
          operatorOpenId,
        });
        yield* Console.log(
          `[feishu-bot] surfaced pending approval card for chat ${chatId} (request ${topRequestId}).`,
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(
            `[feishu-bot] failed to surface pending approval for chat ${chatId}.`,
            cause,
          ),
        ),
      );

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

    // Best-effort human-readable description of a typed RPC/registry failure,
    // for the user-facing WorkspaceCommandError messages below.
    const describeError = (error: unknown): string =>
      error instanceof Error
        ? error.message
        : typeof error === "object" && error !== null && "message" in error
          ? String((error as { message: unknown }).message)
          : String(error);

    // After a `createProject` dispatch, wait for the project to surface in the
    // shell snapshot (the projection round-trip is normally instant; 10s is the
    // generous bound). `null` on timeout — the caller reports it rather than
    // guessing at a shell it cannot see.
    const AWAIT_PROJECT_TRIES = 40;
    const AWAIT_PROJECT_INTERVAL = Duration.millis(250);
    const awaitProjectVisible = (
      projectId: ProjectId,
    ): Effect.Effect<OrchestrationProjectShell | null> =>
      Effect.gen(function* () {
        for (let attempt = 0; attempt < AWAIT_PROJECT_TRIES; attempt += 1) {
          const snapshot = yield* shellCache.current;
          const found = snapshot?.projects.find((project) => project.id === projectId);
          if (found !== undefined) {
            return found;
          }
          yield* Effect.sleep(AWAIT_PROJECT_INTERVAL);
        }
        return null;
      });

    // `/workspace add <local path>` backend: dispatch `createProject`
    // (creating the directory when missing — the M0 escape-hatch template) and
    // resolve once the shell snapshot carries the new project.
    const createWorkspaceProject = (
      workspaceRoot: string,
    ): Effect.Effect<OrchestrationProjectShell, WorkspaceCommandError> =>
      Effect.gen(function* () {
        const projectId = yield* genId(ProjectId);
        const title = workspaceRoot.replace(/\/+$/, "").split("/").pop() ?? "workspace";
        yield* registry
          .run(
            environmentId,
            createProject({
              projectId,
              title: title.length > 0 ? title : "workspace",
              workspaceRoot,
              createWorkspaceRootIfMissing: true,
            }),
          )
          .pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.mapError(
              (error) =>
                new WorkspaceCommandError({ message: `创建工作区失败: ${describeError(error)}` }),
            ),
          );
        const visible = yield* awaitProjectVisible(projectId);
        if (visible === null) {
          return yield* new WorkspaceCommandError({
            message: "工作区创建已提交,但尚未出现在项目列表;稍后发送 /workspace 查看并切换。",
          });
        }
        return visible;
      });

    // `/workspace add <git url>` backend: server-side clone via the
    // `sourceControl.cloneRepository` RPC (the server expands `~`/relative
    // destination paths against its own filesystem), returning the checkout cwd.
    const cloneWorkspaceRepository = (
      remoteUrl: string,
      destinationPath: string,
    ): Effect.Effect<string, WorkspaceCommandError> =>
      registry
        .run(
          environmentId,
          EnvironmentRpc.request(WS_METHODS.sourceControlCloneRepository, {
            remoteUrl,
            destinationPath,
          }),
        )
        .pipe(
          Effect.map((result) => result.cwd),
          Effect.mapError(
            (error) => new WorkspaceCommandError({ message: `克隆失败: ${describeError(error)}` }),
          ),
        );

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
      // Review fix C①: `/workspace switch` gate 3 — a buffered first-contact
      // create captured its project at buffer time, so the selection must not
      // change out from under it while it waits for the reconnect flush.
      hasPendingCreate: (chatKey) =>
        Ref.get(pendingCreates).pipe(Effect.map((set) => set.has(chatKey))),
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

    // ── M2b-3: pure render loop shared by `driveTurn` and `runObserveFiber` ──
    //
    // Given an OPEN streaming card `handle` plus a thread `observation`, mirror
    // that observation onto the card until it completes: per-tick render (interaction
    // + currentTurnId scoping + persist the top pending requestId on change) forked
    // onto the caller's `Scope`, then a single terminal render once `completion`
    // resolves. This is the EXACT render behaviour `driveTurn` had inline — extracted
    // verbatim (DRY) so the cross-end observe fiber (`runObserveFiber`) reuses the
    // identical card pipeline. Each call gets its OWN `currentTurnIdRef` /
    // `lastPendingId` closure state (created here), so two concurrent callers on
    // different chats never share write-once / dedup state.
    //
    // It does NOT open or close the card (the caller owns that, including the
    // `cardDone` producer-release in `driveTurn` and the child scope in
    // `runObserveFiber`) and NEVER touches the turn queue — it is pure observation →
    // card. Requires a `Scope` for the `forkScoped` per-tick updater.
    const renderObservationToCard = (
      chatId: string,
      threadId: ThreadId,
      observation: ThreadObservation,
      handle: StreamingCard,
      // M2b-3 adopt path: optional operator override forwarded to every
      // `buildInteraction` here. The live `driveTurn`/streaming paths omit it and
      // resolve the operator from the in-process `chatOperators` Ref. When this
      // observe fiber ADOPTS an M18-recovered card after a restart the Ref is empty,
      // so the adopt branch passes the operator captured on the persisted handle —
      // exactly as M18 `recoverApprovalCards` re-signs its buttons — so the adopted
      // approval's buttons verify when clicked instead of dead-ending on an empty
      // open id. A non-empty override wins inside `buildInteraction`; otherwise it
      // falls back to the Ref (live behaviour unchanged).
      operatorOverride?: string,
    ): Effect.Effect<void, never, Scope.Scope> =>
      Effect.gen(function* () {
        // The turnId of the turn being rendered. Captured from the first tick whose
        // folded session carries a non-null `activeTurnId` (turn now running), then
        // held — so once the turn completes and `activeTurnId` flips back to `null`,
        // the final/terminal render still filters tools/reasoning/error/body to
        // *this* turn instead of letting the whole thread's history flood in. `null`
        // only until the running frame lands (before which the renderer falls back to
        // `activeTurnId`).
        const currentTurnIdRef = yield* Ref.make<TurnId | null>(null);
        const captureCurrentTurnId = (thread: OrchestrationThread) =>
          Ref.update(currentTurnIdRef, (seen) => seen ?? thread.session?.activeTurnId ?? null);

        // The pendingRequestId last persisted to the card handle. Persist a handle
        // update only when it *changes* (the JSON store writes on every `put`), not
        // on every render tick — so recovery (M2b-2) still sees the outstanding
        // approval without per-tick file churn.
        const lastPendingId = yield* Ref.make<string | null | undefined>(undefined);
        const persistHandle = (pendingRequestId: string | null) =>
          Ref.get(lastPendingId).pipe(
            Effect.flatMap((seen) =>
              seen === pendingRequestId
                ? Effect.void
                : // Capture the chat's *current* real operator open id (#0/#1):
                  // the verify side reads `evt.operator.openId`, the same source
                  // `handleInbound` writes into `chatOperators` — so persisting it
                  // here lets M18 restart recovery re-sign approval buttons for the
                  // real operator instead of an empty string (which would never
                  // match at verify time, permanently dead-ending the button).
                  //
                  // Bug C — do NOT blank a recoverable operator. After a restart the
                  // `chatOperators` Ref is empty even though a durable handle may still
                  // carry the operator who triggered the prior (M18-recovered) card.
                  // Unconditionally writing `""` here would poison that handle, so on
                  // the next restart M18 sees an empty operator and DROPS the handle
                  // (downgrading to a "send a message" nudge). Fall back to the existing
                  // handle's `operatorOpenId` when the Ref has none. Empty string is
                  // only written when BOTH are genuinely unknown.
                  //
                  // Fix 1(b) (M3a): a non-empty `operatorOverride` (the live
                  // `driveTurn` now pins this turn's *initiator*; the observe/adopt
                  // path passes the recovered handle's operator) wins — the SAME
                  // precedence `buildInteraction` uses. This persists the pinned
                  // initiator into the durable handle so M18 restart recovery re-signs
                  // the recovered approval for the initiator, NOT for whoever last
                  // @-mentioned the bot (which a later inbound could have flipped in
                  // the Ref). For p2p the initiator equals the chat owner equals the
                  // Ref value, so this is byte-identical.
                  Effect.all([
                    Ref.get(chatOperators),
                    cardHandles
                      .get(chatId)
                      .pipe(Effect.orElseSucceed(() => Option.none<CardHandle>())),
                  ]).pipe(
                    Effect.flatMap(([operators, existing]) =>
                      cardHandles
                        .put(chatId, {
                          messageId: handle.messageId,
                          pendingRequestId,
                          lastSequence: 0,
                          operatorOpenId:
                            operatorOverride !== undefined && operatorOverride.length > 0
                              ? operatorOverride
                              : (operators.get(chatId) ??
                                (Option.isSome(existing) ? existing.value.operatorOpenId : "")),
                        })
                        .pipe(
                          Effect.ignore,
                          Effect.andThen(Ref.set(lastPendingId, pendingRequestId)),
                        ),
                    ),
                  ),
            ),
          );
        // Record the card handle once up front (no pending yet) so M2b-2 recovery can
        // re-render an outstanding approval card across a restart.
        yield* persistHandle(null);
        yield* observation.ticks.pipe(
          Stream.runForEach((thread) =>
            captureCurrentTurnId(thread).pipe(
              Effect.andThen(Ref.get(currentTurnIdRef)),
              Effect.flatMap((currentTurnId) =>
                // M-3 PR-C3: resolve density per tick from the REAL `thread.runtimeMode`
                // (p2p ⇒ full-access ⇒ card, via `resolveDensity`'s gate) so a per-chat
                // override lands AND the p2p-always-card invariant holds — the synthetic
                // placeholder's runtimeMode must never decide the live card's density.
                Effect.all({
                  interaction: buildInteraction(chatId, thread, operatorOverride),
                  density: resolveDensity(chatId, thread.runtimeMode),
                }).pipe(
                  Effect.flatMap(({ interaction, density }) =>
                    handle
                      .update(
                        renderThreadCard(thread, {
                          streaming: true,
                          currentTurnId,
                          density,
                          ...(interaction ? { interaction } : {}),
                        }).card,
                      )
                      .pipe(
                        Effect.ignore,
                        // Refresh the handle's `pendingRequestId` to the top open
                        // request (approval first, then user-input — the same
                        // priority `surfacePendingApprovalIfNew` derives its
                        // `topRequestId` with) — only when it changed. #2: a
                        // user-input-only turn must NOT persist `null` here, or M18
                        // restart recovery (which skips a handle whose
                        // `pendingRequestId === null`) would never recover the
                        // user-input card.
                        Effect.andThen(
                          persistHandle(
                            derivePendingApprovals(thread.activities)[0]?.requestId ??
                              derivePendingUserInputs(thread.activities)[0]?.requestId ??
                              null,
                          ),
                        ),
                      ),
                  ),
                ),
              ),
              Effect.ignore,
            ),
          ),
          Effect.forkScoped,
        );

        // Wait for the turn to reach a terminal state.
        const outcome = yield* observation.completion;
        yield* Console.log(
          `[feishu-bot] turn ${outcome.kind} on thread ${threadId}` +
            (outcome.kind === "failed" ? ` (status=${outcome.status}).` : "."),
        );

        // Final card render from the fold's authoritative state. By now the turn has
        // completed and `finalThread.session.activeTurnId` is null, so we pass the
        // captured `currentTurnId` to keep the terminal card scoped to *this* turn's
        // tools/reasoning/error/body (otherwise the whole thread's history would
        // surface).
        const finalThread = yield* observation.current;
        if (finalThread !== null) {
          const interaction = yield* buildInteraction(chatId, finalThread, operatorOverride);
          const currentTurnId = yield* Ref.get(currentTurnIdRef);
          // M-3 PR-C3: resolve density from the REAL terminal thread's runtimeMode
          // (same p2p-safe overlay as the per-tick render) for the stable final card.
          const density = yield* resolveDensity(chatId, finalThread.runtimeMode);
          yield* handle
            .update(
              renderThreadCard(finalThread, {
                streaming: false,
                currentTurnId,
                density,
                ...(interaction ? { interaction } : {}),
              }).card,
            )
            .pipe(Effect.ignore);
          // #2: top open request (approval first, then user-input) so a turn that
          // ends paused on a user-input prompt persists a non-null requestId and is
          // recoverable across a restart (M18 skips null-pendingRequestId handles).
          yield* persistHandle(
            derivePendingApprovals(finalThread.activities)[0]?.requestId ??
              derivePendingUserInputs(finalThread.activities)[0]?.requestId ??
              null,
          );
        }
      });

    // ── M2b-3: cross-end observe fiber (mirror a takeover's running turn) ────────
    //
    // Resident fiber that opens its OWN streaming card and mirrors `threadId`'s
    // current turn onto it via the shared `renderObservationToCard`, until the turn
    // reaches a terminal state. Unlike `driveTurn`, it dispatches NOTHING and touches
    // the turn queue NOT AT ALL — it is pure observation (the bridge is mirroring a
    // turn another end started, e.g. on web/terminal, after a `/resume` takeover, or
    // a follow-on turn web starts while the chat is taken over).
    //
    // Self-contained child scope (`Effect.scoped`): `observeThread`'s fold loop is
    // `forkScoped` onto THIS scope, so interrupting this fiber (via `stopObserve` /
    // root-scope teardown) closes the child scope → interrupts the fold → unsubscribes
    // the thread (no leaked subscription). `renderObservationToCard`'s per-tick
    // updater is likewise `forkScoped` here and torn down on completion/interrupt.
    //
    // Robustness: NOTHING inside may crash the bot. `startStreamingCard` failure is
    // caught (warn) and skips the render (the observe fiber just exits — the watcher
    // re-triggers `ensureObserving` on the next frame if the turn is still running);
    // `handle.update` is already `Effect.ignore` inside the helper; any residual
    // defect is `catchCause`'d so the forked fiber always succeeds (`E = never`).
    //
    // Self-eviction: the body has an `Effect.ensuring` finalizer that, on EVERY exit
    // (success / interrupt / defect), removes this chat's registry entry IFF it still
    // carries OUR `token`. Keying on the unique per-attempt token (not a fiber
    // reference) makes eviction immune to claim→install timing: even a turn already
    // terminal at fork time evicts exactly its own claim, and a preempting
    // `driveTurn`/`ensureObserving` that installed a newer entry (different token) is
    // never clobbered. Forked into `rootScope` so the observe outlives the triggering
    // message fiber (the takeover turn runs long after `/resume` returns) yet tears
    // down on bridge shutdown.
    const runObserveFiber = (
      chatId: string,
      threadId: ThreadId,
      token: number,
    ): Effect.Effect<Fiber.Fiber<void>, never, never> => {
      const body: Effect.Effect<void> = Effect.scoped(
        Effect.gen(function* () {
          const observation = yield* observeThread(threadId, { subscribe: subscribeThread });

          // Bug D — turn already over before the new subscription's first frame:
          // `ensureObserving` triggered us because a snapshot/shellCache frame
          // showed `activeTurnId != null`, but the turn can finish in the gap
          // between that decision and this fresh subscription's first folded
          // frame. If so, `observeThread`'s `turnObserved` latch never sets (it
          // only ever sees a null `activeTurnId`), so `completion` would NOT resolve
          // until the 10-min TURN_TIMEOUT — the observe card would hang empty in
          // streaming state, this fiber would never self-evict, and `isObserving`
          // would suppress 修法 A/B for ~10min. Wait for the fold's FIRST
          // authoritative frame (`current` is `null` until the replayed snapshot
          // lands — the fold loop is `forkScoped`, so it has not necessarily run by
          // the time `observeThread` returns; poll until non-null, bounded so a
          // never-delivering subscription can't pin us). If that first frame's
          // `activeTurnId` is already null, the turn is over — exit immediately (no
          // card opened, fiber self-evicts) rather than long-waiting `completion`.
          // Safe precisely because we only triggered on `activeTurnId != null`: a
          // null first frame here confirms the turn ended in the trigger→subscribe
          // gap. (TURN_TIMEOUT stays the backstop for a turn that genuinely runs
          // then wedges.) A read timeout just falls through to the normal path.
          const firstCurrent = yield* observation.current.pipe(
            Effect.repeat({
              until: (thread) => thread !== null,
              schedule: Schedule.spaced(Duration.millis(50)),
            }),
            Effect.timeoutOrElse({
              duration: Duration.seconds(10),
              orElse: () => Effect.succeed(null as OrchestrationThread | null),
            }),
          );
          if (firstCurrent !== null && firstCurrent.session?.activeTurnId == null) {
            return;
          }

          // ── M2b-3: ADOPT an already-recovered approval card (reuse-card) ─────────
          // When a resumed chat was blocked on an approval at restart, M18 recovery
          // (`recoverApprovalCards`) re-rendered that approval onto the EXISTING card
          // (`existing.messageId`) and persisted a handle with that request id +
          // operator. If that SAME request is still live-pending in this fold's first
          // authoritative frame, opening a fresh streaming card would post a SECOND
          // card for it (and `persistHandle(null)` would clobber the durable handle's
          // operator → dead buttons). Instead ADOPT: keep rendering onto the recovered
          // `messageId` via `updateCard`, re-signing the approval for the operator
          // captured on the handle (the `chatOperators` Ref is empty right after a
          // restart — same as M18). A STALE handle from an old turn whose request is
          // NOT in this thread's live-pending set is ignored → we fall through and open
          // a fresh card (no mis-adoption). The adopt path has NO streaming producer,
          // so it creates NO `cardDone` (a dangling `cardDone` would never resolve).
          const livePending = new Set<string>([
            ...(firstCurrent === null ? [] : derivePendingApprovals(firstCurrent.activities)).map(
              (a) => a.requestId,
            ),
            ...(firstCurrent === null ? [] : derivePendingUserInputs(firstCurrent.activities)).map(
              (u) => u.requestId,
            ),
          ]);
          const existing = yield* cardHandles
            .get(chatId)
            .pipe(Effect.orElseSucceed(() => Option.none<CardHandle>()));

          // Operator fallback shared by BOTH render branches (adopt AND fresh card).
          // The live `chatOperators` Ref is the authoritative source while the bot has
          // seen an inbound/`/resume` for this chat — but it is EMPTY right after a
          // restart, even though a durable handle may still carry the operator who
          // triggered the recovered (M18) card. When the Ref has this chat, pass
          // `undefined` so `buildInteraction` resolves from the Ref (live behaviour
          // unchanged); when it does not, fall back to the persisted handle's
          // `operatorOpenId` so an approval that surfaces post-restart is still signed
          // for the recovered operator instead of an empty open id (dead buttons). The
          // fresh-card branch previously passed NO override, so on a restart where
          // observe lost the adopt race (the first live-pending request already
          // resolved) its approval buttons would dead-end — this fallback fixes that.
          const liveOperators = yield* Ref.get(chatOperators);
          const operatorFallback = liveOperators.has(chatId)
            ? undefined
            : Option.isSome(existing) && existing.value.operatorOpenId.length > 0
              ? existing.value.operatorOpenId
              : undefined;

          if (
            Option.isSome(existing) &&
            existing.value.messageId.length > 0 &&
            existing.value.pendingRequestId !== null &&
            livePending.has(existing.value.pendingRequestId)
          ) {
            // Adopt: a static handle that patches the recovered card in place. No
            // streaming producer ⇒ no `cardDone`. `updateCard` failures are swallowed
            // (a bad patch must never crash the observe fiber); the operator override
            // (handle's captured operator, falling back to the live Ref when present)
            // re-signs the approval so its buttons verify across the restart.
            const recovered = existing.value;
            const adoptHandle: StreamingCard = {
              messageId: recovered.messageId,
              update: (card) => gateway.updateCard(recovered.messageId, card).pipe(Effect.ignore),
            };
            yield* renderObservationToCard(
              chatId,
              threadId,
              observation,
              adoptHandle,
              operatorFallback,
            );
            return;
          }

          // Bug B — `cardDone` must resolve on EVERY exit of this whole block, not
          // just around `renderObservationToCard`: the SDK streaming producer
          // (`startStreamingCard`'s `done`) parks on `Deferred.await(cardDone)`, so
          // any exit that opened the card but left `cardDone` unresolved — a
          // `Fiber.interrupt` (all four `stopObserve` sites) landing in/after
          // `startStreamingCard` but before the inner render-`ensuring`, or the
          // `handle === null` early return — would leave the producer parked forever
          // (card stuck streaming). Mirror `driveTurn`: create `cardDone`, then wrap
          // the start→handle-check→render block in a single `Effect.ensuring` that
          // resolves it on success / failure / interrupt / early return alike.
          const cardDone = yield* Deferred.make<void>();
          yield* Effect.gen(function* () {
            // Open this observe fiber's own streaming card; its producer settles when
            // the turn reaches a terminal state (the `cardDone` released below). A
            // failed start must NOT crash the fiber — skip the render and exit; the
            // watcher re-triggers on the next frame if the turn is still running.
            // M-3 PR-C3: resolve the placeholder first-frame density through the same
            // per-chat > binding > runtime overlay the real frames use, so a per-chat
            // override matches from the very first frame (no card→low-noise jump). The
            // binding read below still supplies the topic reply anchor.
            const binding = yield* bindings.get(chatId);
            const placeholderDensity = yield* resolveDensity(chatId, placeholderThread.runtimeMode);
            const initial = renderThreadCard(placeholderThread, {
              streaming: true,
              density: placeholderDensity,
            }).card;
            // M3b: an observe fiber mirrors a turn another end started (no triggering
            // message for this end), so anchor its fresh card inside the topic via the
            // binding's stored `topicAnchorMessageId` when present; `topicSendOpts`
            // degrades to a root post for p2p / plain group / no stored anchor.
            const { chatId: realChatId, larkThreadId } = splitChatKey(chatId);
            const sendOpts = topicSendOpts(larkThreadId, binding?.topicAnchorMessageId);
            const card = yield* gateway
              .startStreamingCard(realChatId, initial, { done: Deferred.await(cardDone) }, sendOpts)
              .pipe(
                Effect.tapError((error) =>
                  Console.error(
                    `[feishu-bot] observe streaming card failed to start for chat ${chatId}: ${error.message}`,
                  ),
                ),
                Effect.option,
              );
            const handle = Option.isSome(card) ? card.value : null;
            if (handle === null) {
              return;
            }
            yield* renderObservationToCard(chatId, threadId, observation, handle, operatorFallback);
          }).pipe(
            // Always release the SDK producer so the card settles into its terminal
            // (non-streaming) form instead of parking forever (mirrors `driveTurn`).
            Effect.ensuring(Deferred.succeed(cardDone, undefined)),
          );
        }),
      ).pipe(
        // No observe failure/defect may crash the bot; the fiber always succeeds.
        Effect.catchCause((cause) =>
          Effect.logWarning(`[feishu-bot] observe fiber failed for chat ${chatId}.`, cause),
        ),
        // Self-evict by token on every exit (see the block comment above).
        Effect.ensuring(
          Ref.update(activeRenderFibers, (map) => {
            const existing = map.get(chatId);
            if (existing === undefined || existing.token !== token) {
              return map;
            }
            const next = new Map(map);
            next.delete(chatId);
            return next;
          }),
        ),
      );

      return Effect.forkIn(body, rootScope);
    };

    // Drive the live card + observer + completion for an already-dispatched turn.
    // `cardDone` is resolved on EVERY exit (success/failure/interrupt) so the SDK
    // stream producer always exits and `stream()` settles — never a parked
    // producer (the LOW cardDone finding). Requires a `Scope`: the per-tick card
    // updater is `forkScoped` onto the caller's turn scope (`runTurn`'s
    // `Effect.scoped`), so it is interrupted when the turn ends.
    const driveTurn = (
      // M3a: composite `chatId[:larkThreadId]` key. The render loop keys state by
      // it (via `renderObservationToCard`); the card is opened on the real Feishu
      // chatId, and — for a topic, with the triggering message as the in-thread
      // reply anchor — posted *inside* that topic.
      chatId: string,
      threadId: ThreadId,
      observation: ThreadObservation,
      // The Feishu message id that triggered this turn (the topic reply anchor),
      // or `undefined` (flush/replay with no live trigger) → post at the root.
      replyToMessageId?: string,
      // Fix 1(a) (M3a): the open id of *this turn's initiator* (the sender of the
      // turn's first source message), pinned for the whole turn. Forwarded as the
      // `operatorOverride` to `renderObservationToCard` so every live tick signs
      // the approval/user-input buttons (and persists the handle) for the
      // initiator — NOT for whoever last @-mentioned the bot mid-turn (a group
      // hazard: a later `@bot` would otherwise re-sign the buttons to a bystander
      // who could then approve, and lock the real initiator out). `undefined`
      // (unreachable empty dispatch) falls back to the live Ref. For p2p the
      // initiator equals the chat owner equals the Ref value → byte-identical.
      initiatorOperatorOpenId?: string,
    ): Effect.Effect<void, never, Scope.Scope> =>
      Effect.gen(function* () {
        const cardDone = yield* Deferred.make<void>();
        yield* Effect.gen(function* () {
          // M-3 PR-C3: resolve the placeholder first-frame density through the same
          // per-chat > binding > runtime overlay the real frames use (no density jump
          // when a per-chat override lowers this chat below `card`).
          const placeholderDensity = yield* resolveDensity(chatId, placeholderThread.runtimeMode);
          const initial = renderThreadCard(placeholderThread, {
            streaming: true,
            density: placeholderDensity,
          }).card;

          // M3a: real Feishu chatId + (topic-only) in-thread reply opts. driveTurn
          // anchors to THIS turn's triggering message (`replyToMessageId`) — its
          // freshest in-topic message — not the binding anchor (red line: unchanged).
          const { chatId: realChatId, larkThreadId } = splitChatKey(chatId);
          const sendOpts = topicSendOpts(larkThreadId, replyToMessageId);
          const card = yield* gateway
            .startStreamingCard(realChatId, initial, { done: Deferred.await(cardDone) }, sendOpts)
            .pipe(
              // A failed card start must not abort the turn; the agent still runs.
              Effect.tapError((error) =>
                Console.error(`[feishu-bot] streaming card failed to start: ${error.message}`),
              ),
              Effect.option,
            );

          // Push each render tick to the card (best-effort; throttled by the SDK).
          const handle = Option.isSome(card) ? card.value : null;
          if (handle !== null) {
            // The whole render loop (per-tick + terminal render + handle persistence)
            // is the shared `renderObservationToCard` helper (M2b-3 DRY): identical
            // behaviour to the prior inline body. Fix 1(a): pin this turn's initiator
            // as the operator override so the live card's buttons stay signed for the
            // initiator across the whole turn.
            yield* renderObservationToCard(
              chatId,
              threadId,
              observation,
              handle,
              initiatorOperatorOpenId,
            );
          } else {
            // No card handle: still wait for the turn to settle (so the SDK
            // producer / completion path resolves identically).
            const outcome = yield* observation.completion;
            yield* Console.log(
              `[feishu-bot] turn ${outcome.kind} on thread ${threadId}` +
                (outcome.kind === "failed" ? ` (status=${outcome.status}).` : "."),
            );
          }
        }).pipe(
          // Whatever happens, release the SDK producer so the card settles into
          // its terminal (non-streaming) form instead of parking forever.
          Effect.ensuring(Deferred.succeed(cardDone, undefined)),
        );
      });

    /**
     * What to do when a turn dispatch finds the environment offline. Two callers:
     *  - **live** (`offlineBuffer`): give a ⏳ receipt and buffer a *flush* turn so
     *    the reconnect re-runs the full pipeline. Succeeds (the live message is now
     *    safely queued; the running flag is released by the completion path).
     *  - **flush** (`offlineRetry`): the environment dropped *again* mid-flush —
     *    **fail** with `OfflineRetry` so the outbound queue keeps the intent + its
     *    ⏳ and retries on the next flush (never records it as sent, never drops).
     */
    type OfflineStrategy = (params: {
      readonly chatId: string;
      readonly dispatch: MergedDispatch;
      readonly feishuMessageId: string;
    }) => Effect.Effect<void, OfflineRetry>;

    const offlineRetry: OfflineStrategy = () => Effect.fail(new OfflineRetry());

    const offlineBuffer: OfflineStrategy = ({ chatId, dispatch, feishuMessageId }) =>
      Effect.gen(function* () {
        yield* Console.log(
          `[feishu-bot] environment offline; queued turn for chat ${chatId} (⏳).`,
        );
        // Buffer the full turn: on reconnect the flush re-runs `runTurn` with the
        // `offlineRetry` strategy, so a mid-flush re-drop fails the intent (keeping
        // it + its ⏳) rather than self-enqueuing under the `offlineBuffer` path.
        // The turn target rides in `dispatch.resolvedThreadId` (B1).
        yield* outbound.enqueue({
          commandId: dispatch.commandId,
          feishuMessageId,
          run: runTurn(chatId, dispatch, offlineRetry),
        });
      });

    /**
     * Drive a single turn for `chatId` end to end.
     *
     * Accounting model (H3 reconnect-flush regression fix). Every turn — live or
     * flushed/replayed off the outbound queue — owns the chat's running slot for
     * exactly its lifetime:
     *  1. **Begin (inside the lock, before dispatch):** `beginTurn` mints a fresh
     *     ownership token and (idempotently) marks the slot running. A live turn
     *     already had `running` set by `offer`; a flushed/replay turn — which never
     *     passed through `offer` — gets it set here. Either way, messages arriving
     *     while this turn runs are *held*, not steered (invariant: a flushed turn
     *     still holds new traffic correctly).
     *  2. **Settle (inside the lock, on EVERY exit, before release):** the turn's
     *     finalizer calls `onTurnComplete(chatId, token)`. The queue only mutates
     *     state when `token` still owns the slot, so this turn settles *exactly*
     *     the `running`/`held` it claimed — a flushed turn can never clobber a live
     *     turn's running flag or drain its held messages (the bug). Because the
     *     settle runs *before the lock releases*, the next same-chat turn cannot
     *     begin until this one's accounting is committed ("settle before yield").
     *  3. **Chain (outside the lock):** if the settle drained held messages, the
     *     follow-up `runTurn` is dispatched *after the lock is released*, so it can
     *     re-acquire the same chat lock without self-deadlock.
     *
     * 1:1 pairing: each `beginTurn` is settled by exactly one matching
     * `onTurnComplete`; non-owning completions are no-ops. So `running`-true count
     * and settling count stay balanced even when a reconnect flush overlaps live
     * traffic on the same chat.
     *
     * Ordering rule (M0-verified trap): `observeThread` opens the subscription
     * *before* `startThreadTurn` dispatches, so no turn event is missed and the
     * dispatch never races a not-yet-ready session.
     *
     * Offline recovery (M8): if the dispatch finds the environment unavailable /
     * not yet registered, `onOffline` decides — the live caller buffers the *whole*
     * turn (card, observer, completion) as an outbound intent that re-runs this
     * same `runTurn` on reconnect (⏳ meanwhile); the flush caller fails with
     * `OfflineRetry` so the queue retries it. Either way the buffered turn flows
     * through the identical streaming pipeline and re-joins the queue's running/
     * completion coordination — never a bare, observer-less dispatch.
     */
    const runTurn = (
      chatId: string,
      dispatch: MergedDispatch,
      onOffline: OfflineStrategy,
    ): Effect.Effect<void, OfflineRetry> =>
      Effect.gen(function* () {
        // Single source of truth for *this* turn's target (B1 re-bind TOCTOU fix).
        // The dispatch carries the threadId resolved at the same instant its
        // commandId was derived (`turnQueue` → `mergeMessages`); we dispatch and
        // observe against *that* exact value. `runTurn` deliberately takes NO
        // separate threadId argument — the caller (`handleInbound`) used to pass a
        // threadId captured back at `ensureThread`, which a concurrent `/resume`
        // re-bind could have made stale, leaving the commandId's embedded threadId
        // and the turn's real target pointing at different threads. By driving
        // both from the dispatch's own resolution, they are one and the same by
        // construction and cannot drift. With no concurrent re-bind this equals
        // the thread `ensureThread` ensured exists.
        const target = dispatch.resolvedThreadId;

        // The held follow-up the settle drained (if any). Written by the in-lock
        // settle finalizer; read by the out-of-lock chain finalizer below. A Ref
        // (not a closure result) because the settle runs inside an `onExit`
        // finalizer whose value cannot otherwise reach the chain step.
        const followUp = yield* Ref.make<MergedDispatch | null>(null);

        yield* Effect.gen(function* () {
          // Own the running slot for this turn's whole critical section. Done
          // first, inside the lock, so ownership is established before the
          // dispatch and settled before the lock releases (settle-before-yield).
          // A flushed/replay turn (which bypassed `offer`) sets `running` here, so
          // messages arriving while it runs are held — never steering it.
          const token = yield* turnQueue.beginTurn(chatId);

          // M2b-3: driveTurn > observe. The bridge is now driving its OWN turn for
          // this chat, so it must be the single render source — preempt any resident
          // cross-end observe fiber (a takeover mirror) before `driveTurn` opens its
          // card, or two streaming cards would fight over the same chat. Interrupting
          // the observe closes its child scope (unsubscribes the thread); idempotent
          // no-op when nothing is observing. `ensureObserving`'s `isChatBusy` gate
          // then keeps observe from restarting while this turn owns the running slot.
          yield* stopObserve(chatId);

          yield* Effect.gen(function* () {
            // Local idempotency pre-check (M9): a stable commandId already recorded
            // as sent means a prior attempt/delivery dispatched this exact turn.
            // Short-circuit so a crash-recovery replay never double-dispatches (the
            // server's commandReceipt store is the second line of defence).
            const already = yield* sent
              .has(dispatch.commandId)
              .pipe(Effect.orElseSucceed(() => false));
            if (already) {
              yield* Console.log(
                `[feishu-bot] skipping already-dispatched turn for chat ${chatId} (commandId seen).`,
              );
              return;
            }

            // Subscribe BEFORE dispatching (M0-verified ordering trap). Observe
            // the dispatch's own resolved target so card/observer follow exactly
            // what the commandId encodes (B1).
            const observation = yield* observeThread(target, { subscribe: subscribeThread });

            const turnStart = yield* buildTurnStart(target, dispatch);

            // Attempt the dispatch. If the environment is unavailable / not yet
            // connected (M8), hand off to `onOffline` (buffer live / retry on
            // flush) instead of dropping; the re-dispatch is idempotent under the
            // stable commandId. Skip the live card here — there is no live turn to
            // stream yet.
            const triggerMessageId = dispatch.sources[0]?.message.messageId ?? dispatch.commandId;
            const dispatched = yield* registry.run(environmentId, turnStart).pipe(
              Effect.provideService(Crypto.Crypto, crypto),
              Effect.as("dispatched" as const),
              Effect.catchTags({
                EnvironmentRpcUnavailableError: () => Effect.succeed("offline" as const),
                EnvironmentNotRegisteredError: () => Effect.succeed("offline" as const),
              }),
              // Review fix A③ / turn-intent backstop: any OTHER failure is the
              // server actively rejecting this dispatch (thread missing after a
              // dropped create, previously-rejected receipt, validation). It
              // used to `orDie` — which silently LOST the message on the live
              // path and carried the intent over FOREVER on the flush path
              // (dispatchOne retries every failure). A rejection is terminal
              // for this exact commandId: settle the intent (success → queue
              // consumes it, ⏳ cleared) and tell the user visibly instead.
              Effect.catchCause((cause) =>
                Effect.logWarning(
                  `[feishu-bot] turn dispatch rejected by the server for chat ${chatId}; dropping with a visible notice.`,
                  cause,
                ).pipe(Effect.as("rejected" as const)),
              ),
            );
            if (dispatched === "offline") {
              yield* onOffline({ chatId, dispatch, feishuMessageId: triggerMessageId });
              return;
            }
            if (dispatched === "rejected") {
              yield* sendNotice(
                chatId,
                turnRejectedNoticeText,
                dispatch.sources[0]?.message.messageId,
              );
              return;
            }
            // Record the dispatch as sent (M9) so a later replay/flush short-circuits.
            yield* sent.add(dispatch.commandId).pipe(Effect.ignore);
            yield* Console.log(`[feishu-bot] started turn on thread ${target} for chat ${chatId}.`);

            // M3a: pass the *real* triggering Feishu message id (not the commandId
            // fallback `triggerMessageId` uses for the offline receipt) as the topic
            // reply anchor — `topicSendOpts` only emits in-thread send opts when this
            // is a genuine message id, so a flush/replay with no live source posts at
            // the root instead of replying to a non-message id.
            //
            // Fix 1(a): also pin this turn's *initiator* (the sender of the first
            // source message) as the live card's operator override, so the approval
            // buttons stay signed for the initiator for the turn's whole lifetime
            // (and not for a later mid-turn `@bot` from a bystander).
            yield* driveTurn(
              chatId,
              target,
              observation,
              dispatch.sources[0]?.message.messageId,
              dispatch.sources[0]?.message.senderId,
            );
          }).pipe(
            // Per-turn scope: tears down the thread subscription + card update
            // fiber on this turn's exit (inside the lock so teardown completes
            // before the next same-chat turn begins).
            Effect.scoped,
            // Settle on EVERY exit — success, failure, defect, interrupt, offline
            // branch alike — and STILL INSIDE THE LOCK, so the next same-chat turn
            // cannot begin before this turn's running/held accounting is committed.
            // The queue's token guard makes the settle a no-op unless this turn
            // owns the slot, so it releases *exactly* the `running`/`held` it
            // claimed — a flushed turn can never clobber a live turn's slot (the
            // bug). The drained held follow-up is stashed for the chain finalizer
            // below; nothing re-dispatches under the lock (would self-deadlock).
            Effect.onExit(() =>
              turnQueue
                .onTurnComplete(chatId, token)
                .pipe(Effect.flatMap((next) => Ref.set(followUp, next))),
            ),
          );
        }).pipe(
          (body) => withChatTurnLock(chatId, body),
          // Chain on EVERY exit, OUTSIDE the lock (mirrors the original finalizer's
          // every-exit guarantee, but now self-deadlock-free): the held follow-up's
          // `runTurn` re-acquires the same chat lock and `beginTurn`s afresh, so it
          // must run only after this turn released the lock. Its own failure is
          // swallowed so it can never mask this turn's exit.
          //
          // Offline strategy for the chain (LOW message-loss fix). The drained held
          // batch is a set of *new* messages this turn captured while running — it
          // is NOT part of any existing outbound intent's retry. So the chain must
          // re-dispatch it under `offlineBuffer` (independent re-buffer as a *new*
          // intent), NOT the parent `onOffline`. Were it to inherit a flush-path
          // `offlineRetry`, a re-drop here would raise `OfflineRetry` that only the
          // parent intent's outbound entry re-queues — and that entry replays the
          // *original* prompt, never this held batch; meanwhile this chain turn's
          // own settle already cleared `running`, so the held batch would be neither
          // re-buffered nor re-held → silently dropped. `offlineBuffer` instead
          // buffers the held batch as its own outbound intent (with a fresh ⏳),
          // so a re-drop keeps it for the next flush. (The live path already used
          // `offlineBuffer`, so for a live-origin chain this is unchanged.)
          Effect.onExit(() =>
            Ref.get(followUp).pipe(
              Effect.flatMap((next) =>
                next === null
                  ? Effect.void
                  : // The follow-up carries its own freshly-resolved threadId (from
                    // `onTurnComplete`'s merge); `runTurn` dispatches against that (B1).
                    runTurn(chatId, next, offlineBuffer).pipe(Effect.ignore),
              ),
            ),
          ),
        );
      });

    /**
     * Resolve the chat's bound thread, creating one on first contact. Serialised
     * under `ensureLock` so two concurrent first messages can't race into two
     * threads (and, while offline, can't enqueue two conflicting `createThread`s).
     *
     * Always returns the chat's threadId. The threadId is *deterministic* from the
     * chatId (`deriveThreadId`) — the same value the persistent binding holds and
     * the same value the turn queue resolves for the stable commandId — so the
     * merged dispatch's commandId is correct whether or not the binding has been
     * persisted yet.
     *
     * Outcomes:
     *  - already bound → the bound `threadId`.
     *  - unbound + no valid workspace selection (M-1) → notice + `null` (the
     *    handleInbound gate is the first line; this re-check is authoritative
     *    at create time — the project may have been deleted in between).
     *  - unbound + the deterministic threadId already EXISTS on the server
     *    (M-1 adopt-if-exists): same project → re-bind to it (no create);
     *    other project / archived → notice + `null` (the server rejects a
     *    create for an existing id — `requireThreadAbsent` — and
     *    `deriveThreadId` is intentionally project-agnostic, so the id cannot
     *    be re-minted under the new workspace).
     *  - unbound + ready → online `createThread` + persist → the new `threadId`.
     *    A mid-create environment drop falls back to the offline buffer.
     *  - unbound + offline → ⏳/notice + buffered create intent (binding persisted
     *    on flush success) → the (deterministic) `threadId`. The turn is buffered
     *    separately by `runTurn`'s offline branch. The buffered create resolves
     *    its model selection at FLUSH time (the resolve needs a live RPC).
     */
    const ensureThread = (message: InboundMessage): Effect.Effect<ThreadId | null> =>
      Effect.gen(function* () {
        // M3a: a Feishu topic backs its own thread, so every binding op keys on the
        // composite `chatId[:larkThreadId]` (byte-identical to the bare chatId for
        // p2p / plain group). `runtimeMode` is per chat type (p2p full-access;
        // group/topic approval-required) and injected into both create paths.
        const larkThreadId = anchorOf(message);
        const chatKey = compositeChatKey(message.chatId, larkThreadId);
        const runtimeMode = runtimeModeForChatType(message.chatType);

        // M2a: resolve the chat's *current* binding from the in-memory authority
        // (BindingState), not the store directly. A `/resume` takeover may have
        // re-pointed this chat at another end's thread (origin "resumed"); either
        // origin is honoured here by using the binding's threadId verbatim.
        const existing = yield* bindings.get(chatKey);
        if (existing !== null) {
          return existing.threadId;
        }

        // M-1 dispatch-time workspace re-check (second line; the handleInbound
        // gate already screened, but the project can be deleted between the two).
        const selected = yield* selectedWorkspaceFor(chatKey);
        if (selected.kind !== "ok") {
          yield* sendNotice(chatKey, workspaceGateText(selected), message.messageId);
          return null;
        }
        // M-3: even a live "ok" selection may have been narrowed out of the chat's
        // authorized set since it was chosen (a config change). Refuse rather than
        // create a thread on a now-unauthorized workspace. Owner exempt.
        if (!(yield* senderMayUseProjectAtDispatch(message, selected.project.id))) {
          yield* sendNotice(chatKey, workspaceRevokedText, message.messageId);
          return null;
        }
        const project = selected.project;

        // First contact. Derive the deterministic threadId up front so both the
        // online and offline create paths agree on it (and on the stable create
        // commandId), making re-delivery idempotent against the server. The topic
        // is folded into the derivation so a topic gets a distinct thread id.
        const threadId = deriveThreadId(message.chatId, larkThreadId);

        // M-1 adopt-if-exists. The server REJECTS a create whose threadId
        // already exists (`requireThreadAbsent`, commandInvariants.ts) — and a
        // thread with this derived id can only have been self-created by an
        // earlier epoch of this very conversation (before a `/release`). So:
        //   - live + same project  → re-bind (adopt), no create dispatched;
        //     this also heals the plain `/release` → next-message flow, which
        //     would otherwise create-collide and wedge in the offline buffer.
        //   - live + other project → refuse: the deterministic id is taken
        //     (`deriveThreadId` stays project-agnostic by design — the M3a
        //     zero-re-bind red line), so this conversation cannot self-create
        //     under the newly selected workspace. `/resume` still works.
        //   - archived             → refuse (the create would be rejected, and
        //     an archived thread cannot run turns). NOTE: normally UNREACHABLE
        //     — the shell snapshot does not carry archived/deleted threads —
        //     kept as a defensive fast path; the authoritative backstop for
        //     "id occupied by a thread the snapshot cannot see" is the
        //     rejected-create disposition below (review fix B).
        // Reads the last-known shell snapshot — present whenever the M-1 gate
        // above passed (an "ok" selection implies a seeded snapshot).
        const collided = yield* shellCache.threadById(threadId);
        if (collided !== null) {
          if (collided.archivedAt !== null) {
            yield* sendNotice(
              chatKey,
              "此对话之前的会话已归档,无法在同一对话中自动重建(会话 ID 由对话唯一决定)。" +
                workspaceCollisionOutlet(message.chatType),
              message.messageId,
            );
            return null;
          }
          if (collided.projectId !== project.id) {
            yield* sendNotice(
              chatKey,
              "此对话之前已在另一个工作区创建过会话,无法在当前工作区新建(会话 ID 由对话唯一决定)。" +
                workspaceCollisionOutlet(message.chatType),
              message.messageId,
            );
            return null;
          }
          // Review fix D: the adopt re-bind is a takeover like `/resume`, so it
          // must honour the SAME M3a full-access gate (shared predicate) — a
          // group/topic chat must not silently re-bind a full-access thread.
          if (refusesFullAccessTakeover(runtimeMode, collided.runtimeMode)) {
            yield* sendNotice(
              chatKey,
              "⚠️ 此对话的历史会话为 full-access(全权限)模式,群聊/话题不可重新绑定全权限会话,以免无人值守执行破坏性操作。请在 web 端处理该会话,或在新话题中开始。",
              message.messageId,
            );
            return null;
          }
          yield* bindings.bind(chatKey, {
            threadId,
            origin: "self-created",
            topicAnchorMessageId: message.messageId,
            density: densityForRuntime(runtimeMode, groupChatDensity),
          });
          yield* Console.log(
            `[feishu-bot] re-bound chat ${message.chatId} to its existing thread ${threadId}.`,
          );
          return threadId;
        }

        // Un-mark this chat's pending-create dedup (review fixes A/B/C: a
        // DROPPED intent must release the dedup so the chat's next message can
        // attempt a fresh create instead of being deduped against a corpse).
        const clearPendingCreate = Ref.update(pendingCreates, (set) => {
          if (!set.has(chatKey)) {
            return set;
          }
          const next = new Set(set);
          next.delete(chatKey);
          return next;
        });

        // Offline first contact (MEDIUM): visible ⏳ receipt + notice, then buffer
        // the `createThread` as an outbound intent that persists the binding *on
        // success* (not optimistically — see `pendingCreates`). The turn itself is
        // buffered separately by `runTurn`'s offline branch; intents flush in FIFO
        // order, so the create runs before any turn. A second offline message for
        // the same chat must NOT buffer a second create (it would hit the server's
        // "thread already exists" invariant), so we dedup on `pendingCreates`.
        const bufferOfflineCreate = Effect.gen(function* () {
          const firstCreate = yield* Ref.modify(
            pendingCreates,
            (set): readonly [boolean, ReadonlySet<string>] =>
              set.has(chatKey) ? [false, set] : [true, new Set(set).add(chatKey)],
          );
          // Fix 5: the ⏳ receipt answers the user's just-sent message, so anchor it
          // into the topic (composite `chatKey` + the message id); p2p / plain group
          // degrade to the root (byte-identical).
          yield* sendNotice(
            chatKey,
            "⏳ The server is not connected right now — your message is queued and will be sent once it reconnects.",
            message.messageId,
          );
          if (!firstCreate) {
            // A create for this brand-new chat is already buffered; its flush
            // persists the binding. This message only needs its turn buffered.
            yield* Console.log(
              `[feishu-bot] environment offline; create already buffered for chat ${message.chatId}, queuing turn only (⏳).`,
            );
            return threadId;
          }
          yield* Console.log(
            `[feishu-bot] environment offline on first contact; buffering create+turn for chat ${message.chatId} (⏳).`,
          );
          const createCommandId = deriveCommandId(message.chatId, threadId, message.messageId, 1);
          yield* outbound.enqueue({
            commandId: createCommandId,
            feishuMessageId: message.messageId,
            // Create THEN persist the binding — only a created thread gets a
            // binding, so a crash before the flush leaves no binding pointing at
            // a missing thread. The flush flow lives in `bridge/createIntent.ts`
            // (review fixes A/B/C②): the model selection is resolved at FLUSH
            // time (needs a live RPC; T3_MODEL override still wins inside), the
            // selection is re-validated against the CURRENT `/workspace` choice,
            // and a failure while the environment is READY (provider-less
            // server, `requireThreadAbsent` rejection) is a terminal, VISIBLE
            // drop — never an eternal carry-over; only a genuine mid-flush
            // env drop raises `OfflineRetry` (queue keeps the intent + ⏳).
            run: runOfflineCreateFlush({
              chatKey,
              chatType: message.chatType,
              replyToMessageId: message.messageId,
              projectId: project.id,
              getSelectedProject: workspace.get(chatKey),
              resolveModel: runOnEnv(
                resolveModelSelection(project.defaultModelSelection, config.modelOverride),
              ),
              dispatchCreate: (flushModelSelection) =>
                runOnEnv(
                  createThread({
                    commandId: createCommandId,
                    threadId,
                    projectId: project.id,
                    title: `Feishu · ${message.senderName ?? message.senderId} (${message.chatId.slice(0, 12)})`,
                    modelSelection: flushModelSelection,
                    // M3a: p2p stays full-access; group/topic creates an
                    // approval-required thread (matches the online create path).
                    runtimeMode,
                    interactionMode: "default",
                    branch: null,
                    worktreePath: null,
                  }),
                ),
              // Bind through the in-memory authority (BindingState), which also
              // mirrors the write to the durable store and absorbs a persist
              // failure (logged, not propagated) — so the create flush stays
              // total and the next message resolves the binding from memory.
              // M3b: store the trigger message id as the topic reply anchor and
              // the bind-time density (see `ensureThreadForChat` for the full
              // rationale); p2p stores them harmlessly.
              bindChat: bindings.bind(chatKey, {
                threadId,
                origin: "self-created",
                topicAnchorMessageId: message.messageId,
                density: densityForRuntime(runtimeMode, groupChatDensity),
              }),
              isEnvReady,
              clearPendingCreate,
              sendNotice,
            }),
          });
          return threadId;
        });

        const ready = yield* isEnvReady;
        if (!ready) {
          return yield* bufferOfflineCreate;
        }

        // M-1: resolve the model selection for THIS create from the selected
        // project's default (T3_MODEL override wins inside). Captured as an
        // exit; the disposition (review fix A) hinges on a READINESS RE-READ:
        //  - env no longer ready → a genuine mid-resolve drop (TOCTOU with
        //    `isEnvReady`) → offline buffer (the reconnect edge WILL flush it);
        //  - env still ready → a provider-less server. Buffering would be a
        //    LIE: the flush is edge-triggered on reconnect, and an environment
        //    that never dropped never re-fires it — the intent (and its "queued"
        //    receipt) would hang forever while the live turn dispatches against
        //    a thread that was never created (defect → message lost). Fail
        //    HONESTLY instead: notice + no thread, no queue, `null`.
        const selectionExit = yield* runOnEnv(
          resolveModelSelection(project.defaultModelSelection, config.modelOverride),
        ).pipe(Effect.exit);
        if (selectionExit._tag === "Failure") {
          if (!(yield* isEnvReady)) {
            yield* Effect.logWarning(
              `[feishu-bot] environment dropped mid model-resolution for chat ${message.chatId}; falling back to offline buffer.`,
              selectionExit.cause,
            );
            return yield* bufferOfflineCreate;
          }
          yield* Effect.logWarning(
            `[feishu-bot] model resolution failed for chat ${message.chatId} while connected (no ready provider?); refusing the message visibly.`,
            selectionExit.cause,
          );
          yield* sendNotice(chatKey, noProviderNoticeText, message.messageId);
          return null;
        }
        const modelSelection = selectionExit.value;

        // Online first contact. Attempt `createThread` + persist now. Capture the
        // exit so a mid-create environment drop (a TOCTOU between `isEnvReady` and
        // the dispatch — `runOnEnv` would orDie it into a defect) falls back to the
        // offline buffer instead of silently dropping the user's first message.
        const ensuredExit = yield* ensureThreadForChat(
          message.chatId,
          message,
          {
            environmentId,
            projectId: project.id,
            modelSelection,
            dispatch: runOnEnv,
            generateThreadId: genId(ThreadId),
          },
          // M3a: per-chat-type runtimeMode + topic id (forms the composite binding
          // key + the topic-aware thread id derivation inside the helper).
          runtimeMode,
          groupChatDensity,
          larkThreadId,
        ).pipe(Effect.provideService(BindingState, bindings), Effect.exit);

        if (ensuredExit._tag === "Failure") {
          // Same readiness-re-read disposition as the resolve above (review fix
          // B backstop): a mid-create env drop buffers (the reconnect edge will
          // replay it); a rejection while STILL CONNECTED is the server actively
          // refusing the create (dominantly `requireThreadAbsent`: the
          // deterministic id is occupied by an archived/deleted thread the
          // shell snapshot cannot show) — retrying or buffering can never
          // succeed, so fail visibly instead of wedging in the queue.
          if (!(yield* isEnvReady)) {
            yield* Effect.logWarning(
              `[feishu-bot] online first-contact create failed for chat ${message.chatId} (environment dropped); falling back to offline buffer.`,
              ensuredExit.cause,
            );
            return yield* bufferOfflineCreate;
          }
          yield* Effect.logWarning(
            `[feishu-bot] server rejected first-contact create for chat ${message.chatId}; refusing the message visibly.`,
            ensuredExit.cause,
          );
          yield* sendNotice(chatKey, createRejectedNoticeText(message.chatType), message.messageId);
          return null;
        }
        // M9: record the (stable) create commandId locally on a fresh create so a
        // crash-recovery replay short-circuits instead of re-dispatching (the
        // server's commandReceipt store is the authoritative second line). The
        // triple mirrors `ensureThreadForChat`'s internal derivation (part: 1).
        if (ensuredExit.value.created) {
          const createCommandId = deriveCommandId(message.chatId, threadId, message.messageId, 1);
          yield* sent.add(createCommandId).pipe(Effect.ignore);
        }
        return ensuredExit.value.threadId;
      });

    /**
     * Handle one inbound message: filter unsupported content, ensure the chat's
     * thread (binding/buffering on first contact, under `ensureLock`), then offer
     * it to the per-chat queue. An idle offer returns a merged dispatch (after the
     * ~600ms coalescing window) we run as a turn; a held offer (turn already
     * running) returns `null` — the running turn's completion picks it up.
     *
     * Forked one-per-message so concurrent `offer` calls drive the queue's
     * generation-debounce coalescing (rapid messages collapse into one prompt);
     * the only racy step, first-contact create, is serialized by `ensureLock`.
     */
    const handleInbound = (message: InboundMessage): Effect.Effect<void> =>
      Effect.gen(function* () {
        // M3a: the composite conversation key — a topic (`omt_…`) is its own
        // conversation, so binding / queue / operator / mirror state all key on
        // `chatId[:larkThreadId]` (byte-identical to the bare chatId for p2p /
        // plain group). All internal state below uses `chatKey`; the gateway sends
        // recover the real Feishu chatId via `splitChatKey`.
        const larkThreadId = anchorOf(message);
        const chatKey = compositeChatKey(message.chatId, larkThreadId);

        // M-3: a p2p private chat is owner-only. p2p is 1:1, so a non-owner DMing
        // the bot must not be able to drive a session (create a global project, run
        // a full-access turn). Judge on the authoritative `chatType === "p2p"`
        // (`chatMode` may be undefined); groups (`chatType === "group"`) are NOT
        // gated here — they still admit non-owners under the command allowlist /
        // workspace-authorization gates. Placed before the operator pin so a
        // non-owner touches no conversation state. `owner === null` (unbound) does
        // NOT gate — with no configured owner we keep the chat open (e.g. a binding
        // flow); only once an owner is set do we refuse non-owners.
        if (message.chatType === "p2p") {
          const p2pOwner = yield* Ref.get(ownerRef);
          if (p2pOwner !== null && !isOwnerExempt(p2pOwner, message.senderId)) {
            yield* sendNotice(
              chatKey,
              "私聊仅限 bot 管理员使用。如需协作,请在群聊中 @机器人。",
              message.messageId,
            );
            return;
          }
        }

        // E④: remember who this conversation's operator is (per topic). The
        // interaction card binds its buttons to this open id at render time; the
        // cardAction verify re-checks the actual clicker against the token's `o`.
        //
        // Fix 1(c)/(d) (M3a): record the operator ONLY when the conversation is
        // currently idle — i.e. this message is (about to become) a fresh turn's
        // initiator. While a turn is running OR coalescing (`isChatBusy`), the
        // active turn's operator is already pinned by `driveTurn`'s
        // `operatorOverride` (the initiator) and must NOT be overwritten: otherwise
        // a bystander @-mentioning the bot mid-turn would flip the Ref, the next
        // tick would re-sign the approval buttons to the bystander (who could then
        // approve someone else's turn), and the real initiator's own click would be
        // rejected (context-mismatch). The pinned-initiator override is the live
        // backstop; this idle guard keeps the Ref itself sane for the idle paths
        // (e.g. `surfacePendingApprovalIfNew`) that still read it. For p2p the
        // operator is always the same person, so skipping a redundant rewrite while
        // busy is a no-op → byte-identical.
        if (!(yield* isChatBusy(chatKey))) {
          yield* Ref.update(chatOperators, (map) => new Map(map).set(chatKey, message.senderId));
        }

        // Content filter (M16): M1 dispatches text only. A message with no text
        // (image/file-only, or an empty body) must NOT become an empty-prompt
        // turn — reply with an explicit "text only" notice and skip dispatch.
        if (message.text.trim().length === 0) {
          const what =
            message.attachments.length > 0
              ? "I can only act on text right now (image/file attachments aren't supported yet)."
              : "I received an empty message — please send some text.";
          // Fix 5: this reply answers a real triggering message, so anchor it into
          // the topic (composite `chatKey` + the message id) instead of the group
          // root; p2p / plain group degrade to the root (byte-identical).
          yield* sendNotice(chatKey, what, message.messageId);
          return;
        }

        // M2a command routing: a `/…` message is a control command, NOT a prompt.
        // Route it BEFORE `ensureThread` so commands work on an unbound chat
        // (`/help`, `/resume` listing candidates) without auto-creating a thread.
        // A known command is fully handled; a `/`-prefixed miss gets a help hint;
        // a non-command falls through to the normal turn path.
        // M-3: per-chat command allowlist. Resolve owner + effective config (bare
        // chatId, like the approval gate) ONLY for `/…` messages; the predicate is
        // pure and the registry calls it only on a table hit. The binding owner and
        // the /help+/whoami floor bypass the allowlist (in `authorizeCommand`).
        let isCommandAllowed: (command: string) => boolean = () => true;
        if (message.text.trimStart().startsWith("/")) {
          const cmdOwner = yield* Ref.get(ownerRef);
          const cmdConfig = effectiveChatConfig(
            message.chatId,
            yield* Ref.get(chatConfigsRef),
            yield* Ref.get(chatDefaultsRef),
          );
          isCommandAllowed = (command) =>
            authorizeCommand({
              owner: cmdOwner,
              sender: message.senderId,
              command,
              allowlist: cmdConfig.commands,
              floor: COMMAND_FLOOR,
            });
        }
        const outcome = yield* tryHandleCommand(message, commandTable, isCommandAllowed);
        if (outcome.handled) {
          if (outcome.unknownCommand !== undefined) {
            // Fix 5: anchor the "unknown command" reply into the triggering topic.
            yield* sendNotice(chatKey, "未知命令,/help 查看可用命令。", message.messageId);
          } else if (outcome.deniedCommand !== undefined) {
            // M-3: the command exists but this chat's allowlist denies it —
            // explicit refusal (never silent), symmetric with unknownCommand.
            // `/workspace` gets a tailored hint (承主 §4.1: don't clash with the
            // "no workspace selected" guidance) so its denial reads as intended.
            yield* sendNotice(
              chatKey,
              outcome.deniedCommand === "/workspace"
                ? "本群未开放 /workspace(无法在此群选择工作区或发起任务)。如需在此群跑任务,请联系 bot 管理员调整配置。发送 /help 查看本群可用命令。"
                : `命令 ${outcome.deniedCommand} 在本群未开放。发送 /help 查看本群可用命令。`,
              message.messageId,
            );
          }
          return;
        }

        // M-1 workspace gate: "no thread without a selected workspace". Only a
        // NOT-yet-bound conversation needs a (valid) selection — an already
        // bound chat has its thread and keeps the session regardless (pre-M-1
        // bindings and `/resume` takeovers pass through untouched). Commands
        // were routed above, so they are never gated. `ensureThread` re-checks
        // authoritatively at create time; this early gate exists so a
        // workspace-less chat is answered BEFORE the turn queue is touched.
        if ((yield* bindings.get(chatKey)) === null) {
          const selected = yield* selectedWorkspaceFor(chatKey);
          if (selected.kind !== "ok") {
            yield* sendNotice(chatKey, workspaceGateText(selected), message.messageId);
            return;
          }
          // M-3: refuse a selection narrowed out of the authorized set before the
          // turn queue is touched (owner exempt); `ensureThread` re-checks too.
          if (!(yield* senderMayUseProjectAtDispatch(message, selected.project.id))) {
            yield* sendNotice(chatKey, workspaceRevokedText, message.messageId);
            return;
          }
        }

        // Ensure the chat↔thread binding FIRST (serialised) so the queue resolves
        // the real threadId when it merges — the stable commandId triple includes
        // the threadId, so offering before binding would derive the wrong id.
        // We run `ensureThread` for its build-thread side effect (first
        // contact: create + bind, or buffer offline); the turn's actual target is
        // NOT taken from here but from the merged dispatch's own resolution (B1),
        // so a concurrent `/resume` re-bind between here and the offer cannot make
        // the dispatch target and its commandId disagree. M-1: a `null` result
        // means the create was refused (workspace missing/stale at create time,
        // or the deterministic threadId collided with another workspace's
        // thread) — `ensureThread` already sent the notice, so just stop here
        // (never offer a turn that has no thread to land on).
        const ensured = yield* ensureThread(message).pipe(ensureLock.withPermits(1));
        if (ensured === null) {
          return;
        }

        // `offer` blocks for the idle coalescing window; concurrent offers for
        // the same chat collapse via the generation-debounce into one dispatch.
        // The returned merge carries `resolvedThreadId` — resolved at the same
        // instant its commandId was — which `runTurn` dispatches against.
        const merged = yield* turnQueue.offer(chatKey, message);
        if (merged === null) {
          return; // Coalesced into a peer offer, or held during a running turn.
        }
        // Live path: `offlineBuffer` buffers (succeeds) rather than signalling a
        // retry, so `OfflineRetry` is unreachable here — treat it as a defect.
        yield* runTurn(chatKey, merged, offlineBuffer).pipe(Effect.orDie);
      });

    // ── M2b-1: cardAction (button click / form submit) → shared respond RPC ──
    //
    // Echo an outcome onto the very card that was clicked. `messageId` is taken
    // from the event (E④), so this never queries the card-handle store. Failures
    // degrade the card to a "已失效/已接管" notice rather than crashing the fiber.
    const updateCardNotice = (messageId: string, text: string): Effect.Effect<void> =>
      gateway
        .updateCard(
          messageId,
          // #3/#4: same notice/status card path as `sendNotice` — `chrome: false`
          // drops the meaningless 🧵/📁 chrome on the synthetic placeholder thread.
          renderThreadCard(makeNoticeThread(text), { streaming: false, chrome: false }).card,
        )
        .pipe(
          Effect.tapError((error) =>
            Console.error(`[feishu-bot] card update failed for ${messageId}: ${error.message}`),
          ),
          Effect.ignore,
        );

    // P3: resolve the operator's display name for the echo. Priority: the name
    // the cardAction event already carried → the in-process cache → a one-off
    // `gateway.getUser` contact lookup (cached on success). Every lookup failure
    // (missing scope → 403, network) degrades gracefully to the raw openId — the
    // echo must never block or throw on name resolution.
    const resolveOperatorName = (operator: {
      readonly openId: string;
      readonly name?: string;
    }): Effect.Effect<string> =>
      Effect.gen(function* () {
        const openId = operator.openId;
        const eventName = operator.name?.trim();
        if (eventName) {
          return eventName;
        }
        const cached = (yield* Ref.get(operatorNames)).get(openId);
        if (cached !== undefined) {
          return cached;
        }
        const looked = yield* gateway.getUser(openId).pipe(
          Effect.map((user): string | null => user.name?.trim() ?? null),
          // Missing `contact:user.base:readonly` scope (403), network, etc. → fall
          // back to the openId; never block or fail the echo.
          Effect.orElseSucceed((): string | null => null),
        );
        const resolved = looked && looked.length > 0 ? looked : openId;
        yield* Ref.update(operatorNames, (map) => new Map(map).set(openId, resolved));
        return resolved;
      });

    // Bystander handling (M3a; generalised + shared in M4-1; §11E re-arm in this PR).
    // An unauthorised click on the CURRENT card must NOT act on the request — the real
    // approver's decision is the only one that routes — but it MUST still change the
    // card, because of how a click that produces no card change gets deduped:
    //
    //   The lark SDK (`@larksuite/channel`) drops a card-action whose dedup key
    //   `card:<messageId>:<clicker>:<tag>|<name>|<option>|<value[:128]>` it has already
    //   seen within its 12h TTL (`Safety.pushAction` → `seenCache`; `DEFAULT_DEDUP.ttl`,
    //   no dedup config passed in `lark/channel.ts`). Because `onCardAction` is a
    //   fire-and-forget `runFork`, the SDK's `await h(evt)` resolves at once and the
    //   handled click's key is added to the cache immediately. Our signed token's only
    //   per-sign-varying bytes live PAST that 128-char window, so if we leave the card
    //   BYTE-FOR-BYTE unchanged, the SAME person's LATER click (e.g. after `approvalMode`
    //   flipped to `all` and they became authorised) carries an identical dedup key and
    //   is dropped in-process BEFORE `onCardAction` — the approval dead-ends at the turn's
    //   local timeout. (Diagnosed 2026-07-06: the second click produced zero
    //   `onCardAction` deliveries. Feishu may ALSO suppress re-delivery server-side, but
    //   the SDK seenCache is the code-proven mechanism the fix must defeat.)
    //
    // Fix (two parts): (a) `interactionCard.ts` puts a per-sign-unique `k` INSIDE the
    // 128-char window so a re-render yields a fresh dedup key; (b) here we re-render the
    // SAME card (same thread body + same live interaction, freshly-signed buttons) onto
    // the same `messageId`, so a fresh-`k` button lands on the card and the NEXT click —
    // authorised or not — is delivered. We re-arm on EVERY bystander click (never deduped)
    // so no click is ever the "unchanged" one the SDK latches onto; only the neutral
    // @-notice is deduped (to at most once per (chatKey, messageId, clicker)) so repeated
    // taps don't spam the topic. Buttons are re-signed for the verified token's initiator
    // (`res.payload.o`, passed as `initiatorOpenId`), NOT the driftable `chatOperators`
    // Ref and NOT the bystander clicker — see the call below for why. Called from the
    // authz gate: the token already passed `verify`, which proves the click targets the
    // live card for this chat/thread/policy. Generic wording covers approval and
    // user-input interactions.
    const preserveCardForBystander = (
      chatKey: string,
      threadId: ThreadId,
      messageId: string,
      clickerOpenId: string,
      // The initiator carried by the just-verified live token (`res.payload.o`). The
      // re-arm re-signs the card's buttons for THIS id so the re-armed card keeps the
      // exact same approval authority as the card the bystander clicked.
      initiatorOpenId: string,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* Console.log(
          `[feishu-bot] cardAction ignored for chat ${chatKey} — unauthorised click; re-arming the card for the real approver.`,
        );

        // Re-arm (core §11E fix). Best-effort and fully isolated: a snapshot / render /
        // update failure must never swallow the neutral notice below or crash the
        // handler, so we `catchCause` it to a warning. Mirrors the M18 restart-recovery
        // re-render (one-shot `subscribeThread` snapshot → `buildInteraction` →
        // `renderThreadCard` → `updateCard` on the same messageId).
        yield* Effect.gen(function* () {
          // Re-sign the re-armed buttons for the EXACT initiator carried by the just-
          // verified live token (`initiatorOpenId` = `res.payload.o`), passed as
          // `buildInteraction`'s `operatorOverride`. We must NOT let `buildInteraction`
          // resolve the operator from the live `chatOperators` Ref, which is DRIFTABLE on
          // the observe path: a bystander who @-mentions the bot with a floor command
          // (e.g. `/help`) on an `isChatBusy=false` observe turn (/resume takeover,
          // chained subagent, M18 recovery) flips the idle-guarded pin to their own id
          // WITHOUT starting a turn that would re-pin the initiator. Re-signing from that
          // Ref would let the bystander set the new `payload.o` to themselves and then
          // self-approve in `initiator` mode — a privilege escalation. Since a non-empty
          // override wins over the Ref, guard on it: when `initiatorOpenId` is empty (only
          // a non-initiator-mode / M18-recovered card whose initiator was never captured),
          // `buildInteraction` would FALL BACK to that driftable Ref, so we SKIP the re-arm
          // entirely rather than risk re-signing for a drifted bystander — mirroring M18
          // recovery's refusal to re-sign empty-operator cards. The narrow cost is that
          // such a recovered card keeps the old dead-button behaviour (no re-arm); the
          // common case (non-empty initiator) re-arms normally and stays signed for the
          // real approver, so the bystander stays locked out.
          if (initiatorOpenId.length === 0) {
            return;
          }
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
            return;
          }
          const interaction = yield* buildInteraction(chatKey, snapshotThread, initiatorOpenId);
          // No live interaction (the request was resolved elsewhere while this click was
          // in flight) → nothing to re-arm; leave the card to the normal render path.
          if (interaction === undefined) {
            return;
          }
          const density = yield* resolveDensity(chatKey, snapshotThread.runtimeMode);
          const card = renderThreadCard(snapshotThread, {
            streaming: false,
            density,
            interaction,
          }).card;
          yield* gateway.updateCard(messageId, card);
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning(
              `[feishu-bot] bystander card re-arm failed for chat ${chatKey} (message ${messageId}).`,
              cause,
            ),
          ),
        );

        const dedupKey = `${chatKey}:${messageId}:${clickerOpenId}`;
        const alreadyNotified = yield* Ref.modify(bystanderNoticed, (set) => {
          if (set.has(dedupKey)) return [true, set] as const;
          const next = new Set(set);
          next.add(dedupKey);
          // M3b: bound the set. On overflow keep the most recent ~80% (Set iteration
          // order ≈ insertion order) and drop the oldest keys.
          if (next.size > MAX_BYSTANDER_KEYS) {
            const keep = Math.floor(MAX_BYSTANDER_KEYS * 0.8);
            return [false, new Set(Array.from(next).slice(-keep))] as const;
          }
          return [false, next] as const;
        });
        if (!alreadyNotified) {
          // The WS card path has no native per-clicker toast, so post a short
          // topic-anchored notice; the re-arm above keeps the same live interaction on
          // the card, so the real approver's buttons remain actionable.
          yield* sendNotice(
            chatKey,
            `<at id=${clickerOpenId}></at> 你暂时没有此操作的权限,需由授权人处理。`,
            messageId,
          );
        }
      });

    /**
     * Handle one cardAction (button click / form submit) end to end (contract B9
     * §9). The bridge is a thin *shared* client: it verifies the signed token,
     * durably consumes its single-use nonce, then routes the operator's decision
     * through the SAME shared respond RPC (`respondToThreadApproval` /
     * `respondToThreadUserInput`) every other end uses — no bridge-private
     * approval state. Every step that can't proceed degrades the clicked card to
     * a plain notice instead of leaving a dead button.
     */
    const handleCardAction = (evt: CardActionEvent): Effect.Effect<void> =>
      Effect.gen(function* () {
        // 1. Parse the callback value. A foreign / legacy button → ignore.
        const parsed = parseCardActionValue(evt.action.value);
        if (parsed === null) {
          return;
        }

        // M3a: `CardActionEvent` carries no thread field, so the button echoes its
        // topic id in the value (`parsed.larkThreadId`) — a PRE-VERIFY bootstrap used
        // to locate the topic's binding (and thus its thread id) *before* the policy
        // fingerprint can be recomputed to verify the token. It is untrusted on its
        // own but tamper-evident: the signed fingerprint derives from the topic's
        // thread id, so a forged/stripped `lt` resolves a different (or no) binding →
        // a mismatched fingerprint → `verify` fails with `context-mismatch`. The
        // signed `res.payload.lt` (read after verify succeeds) is the authoritative
        // copy and, by that fingerprint binding, necessarily equals this bootstrap.
        const chatKey = compositeChatKey(evt.chatId, parsed.larkThreadId);

        // 2. Resolve the conversation's bound thread under the composite key. No
        //    binding → the topic/chat is not (or no longer) driving a session; tell
        //    the operator and stop.
        const binding = yield* bindings.get(chatKey);
        if (binding === null) {
          yield* updateCardNotice(evt.messageId, "会话未接管,无法响应此操作。");
          return;
        }
        const threadId = binding.threadId;

        // 3. Read the thread's *current* runtimeMode from the shell cache (E②:
        //    the verify side uses the shell's runtimeMode, which may lag the
        //    render side's by <1s). Absent shell → treat the button as stale.
        const shell = yield* shellCache.threadById(threadId);
        if (shell === null) {
          yield* updateCardNotice(evt.messageId, "⚠️ 此操作已失效。");
          return;
        }

        // 4. Recompute the policy fingerprint for the verify context.
        const fp = computePolicyFingerprint(evt.chatId, threadId, shell.runtimeMode);

        // 5. Verify the token's INTEGRITY against the expected context. M4-1: no
        //    `operatorOpenId` here either — authz (who may click) is decoupled from
        //    verify and enforced by the authz gate (step 6b) below. Verify now only
        //    proves the token is untampered and belongs to THIS chat/thread/policy
        //    (no `action`, adjustment 2; no `operatorOpenId`, M4-1).
        const res = auth.verify(parsed.token, {
          runId: threadId,
          scope: evt.chatId,
          chatId: evt.chatId,
          policyFingerprint: fp,
        });

        // 6. Verification failure = an INTEGRITY failure: a tampered token or a
        //    genuinely stale card (e.g. threadId/fp changed after a `/resume` or a
        //    runtimeMode change). M4-1: because authz is no longer folded into verify,
        //    the live card passes verify for ANY clicker — so `context-mismatch` no
        //    longer fires on a mere bystander click (that is now caught by the authz
        //    gate below), only on a truly stale/foreign card. Degrade it
        //    unconditionally; there is no live card left to preserve.
        if (!res.ok) {
          yield* Console.log(
            `[feishu-bot] cardAction rejected for chat ${evt.chatId} (${res.reason}).`,
          );
          yield* updateCardNotice(evt.messageId, "⚠️ 按钮已失效,请回到最新卡片重新操作。");
          return;
        }

        // 6b. Authz (M-2): verify proved integrity (this IS the live card for this
        //     chat/thread/policy); now decide WHO may act. Owner-always (the bound
        //     owner) overlays the per-chat three-state mode: `initiator` matches the
        //     signed `payload.o` (the true turn initiator), `designated` the
        //     configured approvers, `all` any chat member (any clicker of an in-chat
        //     card is a member — no roster fetch). A non-authorised clicker is a
        //     bystander: no-op the card (preserve it for the real approver) + neutral
        //     @notice. MUST run BEFORE the nonce consume (step 8) so a bystander click
        //     never burns the single-use nonce out from under the real approver.
        const clicker = evt.operator.openId;
        const owner = yield* Ref.get(ownerRef);
        const chatConfig = effectiveChatConfig(
          evt.chatId,
          yield* Ref.get(chatConfigsRef),
          yield* Ref.get(chatDefaultsRef),
        );
        const authorized = authorizeApprovalClick({
          owner,
          mode: chatConfig.approvalMode,
          approvers: chatConfig.approvers,
          clicker,
          initiator: res.payload.o,
        });
        if (!authorized) {
          yield* preserveCardForBystander(chatKey, threadId, evt.messageId, clicker, res.payload.o);
          return;
        }

        // 7. The request must still be open & pending (it may have been answered
        //    elsewhere, or force-resolved stale). Take a one-shot snapshot of the
        //    thread (the subscribe stream replays a full snapshot first) and
        //    re-derive the pending set, then locate the matching request. The
        //    `Stream.take(1)` closes the subscription immediately (scoped read).
        const firstFrame = yield* Stream.runHead(
          subscribeThread(threadId).pipe(Stream.take(1)),
        ).pipe(Effect.scoped);
        const snapshotThread = Option.match(firstFrame, {
          onNone: () => null as OrchestrationThread | null,
          onSome: (item) => (item.kind === "snapshot" ? item.snapshot.thread : null),
        });
        const activities = snapshotThread?.activities ?? [];
        const pendingApprovals = derivePendingApprovals(activities);
        const pendingUserInputs = derivePendingUserInputs(activities);
        const matchedApproval = pendingApprovals.find(
          (approval) => approval.requestId === parsed.requestId,
        );
        const matchedUserInput = pendingUserInputs.find(
          (userInput) => userInput.requestId === parsed.requestId,
        );
        if (matchedApproval === undefined && matchedUserInput === undefined) {
          yield* updateCardNotice(evt.messageId, "⚠️ 此操作已失效(请求已被处理或过期)。");
          return;
        }
        // #6/#8: past this guard a request matched, which is only possible when the
        // snapshot delivered a non-empty `activities` — i.e. `snapshotThread` is
        // non-null. The old `echoResolved` carried a `snapshotThread === null`
        // fallback branch (a plain `updateCardNotice` with an *un-truncated*
        // commandSummary), but that branch was unreachable for exactly this reason
        // (dead code, and #6/#12's missing-truncation only lived there). We narrow
        // the type here so the echo always re-renders the full card, and surface the
        // impossible-null case as a defect rather than silently dead-pathing.
        if (snapshotThread === null) {
          return yield* Effect.die(
            new Error("cardAction: matched a pending request but snapshot thread was null."),
          );
        }

        // 8. Durably consume the single-use nonce BEFORE routing (adjustment 1:
        //    no crash-replay window). A `false` means another delivery already
        //    consumed it → replay; degrade and stop.
        const consumed = yield* nonceStore
          .consume(res.payload.n, res.payload.exp)
          .pipe(Effect.orElseSucceed(() => false));
        if (!consumed) {
          yield* updateCardNotice(evt.messageId, "⚠️ 此操作已失效(重复点击)。");
          return;
        }

        // 9. One commandId for both the respond RPC and the audit row (adjustment
        //    6) so the durable ledger keys exactly the dispatched command.
        const commandId = yield* genId(CommandId);
        const requestId = ApprovalRequestId.make(parsed.requestId);

        // 10. Route through the shared respond RPC. `runOnEnv` discharges
        //     Crypto/EnvironmentSupervisor and orDies any unexpected failure.
        const isApproval = matchedApproval !== undefined;
        if (isApproval) {
          const decision = actionToApprovalDecision(res.payload.a);
          if (decision === null) {
            yield* updateCardNotice(evt.messageId, "⚠️ 无法识别的操作。");
            return;
          }
          yield* runOnEnv(respondToThreadApproval({ threadId, requestId, decision, commandId }));
        } else {
          const questions = matchedUserInput?.questions ?? [];
          // The unified user-input form submits natively, so the answers ride in
          // `evt.action.formValue`. `parsed.formValue` is a legacy fallback (the
          // removed single-select button group) kept for value-shape stability.
          const answers = formValueToAnswers(evt.action.formValue ?? parsed.formValue, questions);
          yield* runOnEnv(respondToThreadUserInput({ threadId, requestId, answers, commandId }));
        }

        // 11. Append the immutable audit row under the SAME commandId.
        const ts = yield* Clock.currentTimeMillis;
        // M3b: record the topic the command was routed within. `evt.chatId` is the
        // bare Feishu id; the composite `chatKey` carries the topic, so recover it
        // via `splitChatKey` (normalises empty → undefined). exactOptionalPropertyTypes:
        // omit the key for p2p / plain group rather than assigning `undefined`.
        const auditLarkThreadId = splitChatKey(chatKey).larkThreadId;
        yield* audit
          .append(commandId, {
            operatorOpenId: evt.operator.openId,
            chatId: evt.chatId,
            threadId,
            command: res.payload.a,
            ts,
            ...(auditLarkThreadId !== undefined ? { larkThreadId: auditLarkThreadId } : {}),
          })
          .pipe(Effect.ignore);

        // 12. Echo the outcome onto the clicked card by RE-RENDERING the same
        //     thread snapshot with this request's interaction controls greyed out,
        //     preserving the thread body — never replacing the whole card with a
        //     bare notice (which would drop the conversation). M2b-2: we build a
        //     structured {@link ResolvedNoticeEntry} (operator name + command
        //     summary + decision) and hand it to `interactionCard`, which composes
        //     the localized "✅ 已由 @X 授权 · <命令摘要>" / "🚫 … 拒绝 …" / "✅ … 提交"
        //     line itself (truncating the summary). We persist the entry into the
        //     chat's resolved overlay (P2) so every subsequent `driveTurn` render
        //     tick keeps this request greyed out for the whole turn and after it
        //     ends, then echo it onto this card now.
        const who = yield* resolveOperatorName(evt.operator);
        // Echo-display decision: derive it from the SAME action the respond RPC
        // routed (line ~2380) so the greyed-out echo matches what was actually
        // dispatched. A binary "accept vs else→decline" ternary would misclassify
        // an `acceptForSession` click as a 拒绝 echo, so map the action explicitly.
        // Only accept/acceptForSession/decline buttons exist (no `cancel` button),
        // and an unrecognized action can't reach here — routing already rejected a
        // null decision above — so decline is just a defensive default. User-input
        // submits stay "submit".
        const echoDecision = (action: string): ResolvedNoticeEntry["decision"] => {
          switch (action) {
            case "approval:accept":
              return "accept";
            case "approval:acceptForSession":
              return "acceptForSession";
            default:
              return "decline";
          }
        };
        const decision: ResolvedNoticeEntry["decision"] = isApproval
          ? echoDecision(res.payload.a)
          : "submit";
        // commandSummary: for an approval, the request's detail (the command/file
        // summary) — trimmed, `null` when empty; the renderer truncates it. A
        // user-input submit has no single-line detail, so it is `null`.
        const commandSummary = matchedApproval?.detail?.trim() || null;
        const entry: ResolvedNoticeEntry = {
          operatorName: who,
          commandSummary,
          decision,
        };

        // P2: record the overlay BEFORE echoing so any render tick racing this
        // handler already sees the request as resolved. M3a: keyed by the composite
        // `chatKey` so every subsequent `driveTurn`/observe render of THIS topic
        // (which read the overlay under the same composite key) keeps it greyed out.
        yield* Ref.update(chatResolvedNotices, (map) => {
          const forChat = new Map(map.get(chatKey) ?? new Map<string, ResolvedNoticeEntry>());
          forChat.set(parsed.requestId, entry);
          return new Map(map).set(chatKey, forChat);
        });

        const echoResolved = (): Effect.Effect<void> =>
          Effect.gen(function* () {
            const operatorOpenId = evt.operator.openId;
            const ctx: InteractionContext = {
              // The token's `c`/`scope` is the real Feishu chatId (matched at verify
              // against `evt.chatId`); the topic id rides in `larkThreadId` so any
              // *other* still-pending request re-signed on this echo card stays
              // topic-bound. Omitted for p2p / non-topic (token unchanged pre-M3a).
              chatId: evt.chatId,
              threadId,
              operatorOpenId,
              runtimeMode: shell.runtimeMode,
              auth,
              ttlMs: CALLBACK_TOKEN_TTL_MS,
              ...(parsed.larkThreadId !== undefined ? { larkThreadId: parsed.larkThreadId } : {}),
            };
            const resolvedNotice = new Map<string, ResolvedNoticeEntry>([
              [parsed.requestId, entry],
            ]);
            const elements = renderInteractionSection(
              pendingApprovals,
              pendingUserInputs,
              staleRequestIdsOf(activities),
              resolvedNotice,
              ctx,
            );
            const density = yield* resolveDensity(chatKey, snapshotThread.runtimeMode);
            const card = renderThreadCard(snapshotThread, {
              streaming: false,
              density,
              interaction: { elements },
            }).card;
            yield* gateway.updateCard(evt.messageId, card).pipe(
              Effect.tapError((error) =>
                Console.error(
                  `[feishu-bot] card echo failed for ${evt.messageId}: ${error.message}`,
                ),
              ),
              Effect.ignore,
            );
          });

        // Approval (plain button) echoes immediately. A user-input *form* submit
        // is gated by Feishu's ~1s client-side form lock (FORM_SETTLE_MS); a
        // button-group tap is not a native form submit so it echoes immediately
        // too. Native form submit is detected by `evt.action.formValue != null`
        // (the SDK only fills it on a form submit; a button-group tap carries its
        // answer in `parsed.formValue`/`value`). The settled echo is fired off
        // the handler so the cardAction callback returns promptly.
        const isNativeFormSubmit = !isApproval && evt.action.formValue != null;
        if (isNativeFormSubmit) {
          runFork(Effect.sleep(FORM_SETTLE_DELAY).pipe(Effect.andThen(echoResolved())));
        } else {
          yield* echoResolved();
        }
      });

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

// ── PR2: runtime credential resolution + the resident re-bind loop ───────────

/**
 * The public identity of a bound bot — what changes on a re-bind (bind a new
 * app, unbind, or swap tenant). Deliberately excludes `appSecret`: the secret is
 * fetched on demand via the credentials RPC and never travels on the settings
 * stream or this view (so a leak surface is one place, not two).
 */
interface BindingIdentity {
  readonly appId: string;
  readonly tenant: FeishuTenant;
}

/** Structural equality for {@link BindingIdentity} (null = unbound). */
const bindingIdentityEq = (a: BindingIdentity | null, b: BindingIdentity | null): boolean =>
  a === null || b === null ? a === b : a.appId === b.appId && a.tenant === b.tenant;

/**
 * Project the public `ServerSettings.feishuBinding` (or `undefined` = no bot
 * bound) onto a {@link BindingIdentity}. Drops `ownerOpenId` — only app id +
 * tenant decide whether the running session must be re-bound.
 */
const toBindingIdentity = (
  binding: { readonly appId: string; readonly tenant: FeishuTenant } | undefined,
): BindingIdentity | null =>
  binding === undefined ? null : { appId: binding.appId, tenant: binding.tenant };

/**
 * The outcome of resolving the bot's credentials for one loop iteration: either a
 * full credential set (from the `.env` dev override or the server fetch) or
 * "unbound" (no bot bound yet, or the server was transiently unreachable — both
 * collapse to a backoff-and-retry in the resident loop).
 */
type CredentialResolution =
  | {
      readonly _tag: "Resolved";
      readonly creds: FeishuCredentialOverride;
      readonly source: "env" | "rpc";
    }
  | { readonly _tag: "Unbound" };

/**
 * Internal marker that a per-binding session ended on a NON-interrupt cause
 * (e.g. the orDie'd Lark `connect` defect, or any unexpected session defect). It
 * never surfaces to the user: it exists only to feed `Effect.retry`'s typed
 * failure channel so the session self-heals (rebuild scope+gateway) with backoff.
 * An interrupt (a re-bind won by `raceFirst`) is NOT wrapped — it propagates
 * directly, so the retry never swallows it and re-bind always wins. `effect-smol`
 * has no `Effect.unsandbox`, so this typed-failure bridge replaces the
 * sandbox/retry/unsandbox idiom.
 */
class FeishuSessionFailure extends Data.TaggedError("FeishuSessionFailure") {}

/**
 * Strip a known secret from a string (e.g. a stringified {@link Cause.Cause})
 * before it is logged, so the secret-isolation red line holds even in the rare
 * case the Lark SDK echoes the `appSecret` inside a connect/session error. A
 * no-op when the secret is empty — a blank `replaceAll` would splice the marker
 * between every character. The bound-session `creds.appSecret` is always present,
 * so this only redacts; it never mangles.
 */
const redactSecret = (text: string, secret: string): string =>
  secret.length > 0 ? text.replaceAll(secret, "***") : text;

/**
 * Per-session self-heal schedule: exponential from 1s, capped at 30s, recurring
 * forever (mirrors apps/web's `exponential ∪ spaced` cap idiom — `either` takes
 * the min delay). Used to rebuild the Lark gateway after a transient connect
 * failure (the `gateway.connect` `orDie` defect) without crashing the loop.
 */
const SESSION_RETRY_SCHEDULE = Schedule.exponential(Duration.seconds(1)).pipe(
  Schedule.either(Schedule.spaced(Duration.seconds(30))),
);

/**
 * Safety re-check interval for the Unbound wait: even with no binding-change
 * wakeup we re-acquire periodically, so a secret injected without a
 * `feishuBinding` change (the split-injection e2e) — or a lost wakeup — recovers
 * within this bound instead of parking forever.
 */
const UNBOUND_RECHECK_INTERVAL = Duration.seconds(30);

/**
 * Resolve the bound thread for a composite chat key from {@link BindingState},
 * falling back to the deterministic `deriveThreadId` for a not-yet-bound chat.
 * Hoisted out of `program` so each per-binding `turnQueueLayer` reuses the SAME
 * lookup (its `BindingState` requirement is satisfied by the outer layer). See
 * the M2a/M3a invariant note on `turnQueueLayer`.
 */
const threadIdForChatKey = (chatKey: string): Effect.Effect<ThreadId, never, BindingState> =>
  BindingState.pipe(
    Effect.flatMap((bindingState) => bindingState.get(chatKey)),
    Effect.map((binding) => {
      if (binding !== null) {
        return binding.threadId;
      }
      const { chatId, larkThreadId } = splitChatKey(chatKey);
      return deriveThreadId(chatId, larkThreadId);
    }),
  );

/**
 * Resolve the bot's Feishu credentials for one loop iteration (never fails).
 *
 * - `.env` dev override present → use it verbatim (`source: "env"`); the bot
 *   never consults the server and never re-binds.
 * - Otherwise fetch the bound bot's credentials from the server via the
 *   `feishuGetBotCredentials` RPC. `{bound:false}` (no bot bound yet, or the
 *   secret was lost) → Unbound. `{bound:true}` → assemble the full credential set,
 *   deriving `domain` from `tenant` (the RPC carries `tenant`, not `domain`).
 *
 * A transient RPC failure (server briefly unreachable, reconnect snapshot
 * reload) is caught and collapsed to Unbound so the resident loop backs off and
 * retries — credential acquisition is total, matching the long-lived bot's
 * "wait, don't crash" contract. The logged cause is a typed RPC error and
 * structurally cannot carry the `appSecret` (that only rides a SUCCESS payload),
 * so logging it leaks nothing.
 */
const acquireCredentials = (
  config: FeishuBotConfig,
  environmentId: EnvironmentId,
): Effect.Effect<CredentialResolution, never, EnvironmentRegistry> =>
  Effect.gen(function* () {
    const override = config.feishu.credentialOverride;
    if (override !== null) {
      return { _tag: "Resolved", creds: override, source: "env" } as const;
    }
    const registry = yield* EnvironmentRegistry;
    return yield* registry
      .run(environmentId, EnvironmentRpc.request(WS_METHODS.feishuGetBotCredentials, {}))
      .pipe(
        Effect.map(
          (result): CredentialResolution =>
            result.bound
              ? {
                  _tag: "Resolved",
                  creds: {
                    appId: result.appId,
                    appSecret: result.appSecret,
                    tenant: result.tenant,
                    domain: DOMAIN_BY_TENANT[result.tenant],
                  },
                  source: "rpc",
                }
              : { _tag: "Unbound" },
        ),
        Effect.catchCause((cause) =>
          // Symmetric with the bound-session self-heal: let an interrupt (process
          // shutdown) propagate verbatim instead of swallowing it into Unbound; any
          // OTHER cause — a registry/transport defect or the two typed RPC errors —
          // collapses to Unbound, preserving the never-fail contract (the resident
          // loop then backs off and retries). The cause here is an RPC error and
          // structurally cannot carry the `appSecret` (it only rides a SUCCESS
          // payload), so no redaction is needed.
          Cause.hasInterrupts(cause)
            ? Effect.interrupt
            : Effect.logWarning(
                "[feishu-bot] could not fetch bot credentials from the server; will retry.",
                cause,
              ).pipe(Effect.as({ _tag: "Unbound" } as const)),
        ),
      );
  });

/**
 * Outer (binding-independent) watcher over `subscribeServerConfig`, hoisted from
 * the per-binding session (was the M4-2 fiber) so it survives every re-bind. It
 * carries several duties on each `snapshot` / `settingsUpdated` event, all
 * reading the FULL `ServerSettings` (not a delta):
 *
 *  1. **Binding view.** Publish the public binding identity (no secret) to
 *     `bindingView` so the resident loop can re-bind on a change. Because the
 *     settings are the FULL snapshot, `feishuBinding` always reflects the current
 *     binding — an unrelated settings change re-publishes the SAME identity,
 *     which `bindingIdentityEq` filters out (no spurious re-bind).
 *  2. **Owner + per-chat config live-refresh (M-2).** Publish the binding owner
 *     (`feishuBinding.ownerOpenId`, or `null`) to `ownerRef` for owner-always
 *     authz, and the per-chat approval config (`feishuChatConfigs`/
 *     `feishuChatDefaults`) to `chatConfigsRef`/`chatDefaultsRef` for the gate's
 *     three-state decision. Pure extractions, never cleared on error →
 *     last-known-good (a schema defect keeps the last good config rather than
 *     locking approvals out), preserving the authz fail-safe.
 *
 * `Stream.orDie` mirrors the other forked subscriptions: `subscribeServerConfig`
 * self-heals transient WS drops, and the handler is pure computation that never
 * throws, so `orDie` fires only on a schema defect / unhandled typed failure —
 * rare, and even then fail-safe (the Refs keep last-known-good). Forked onto the
 * OUTER scope by the caller.
 */
const runBindingAndConfigWatcher = (
  environmentId: EnvironmentId,
  bindingView: SubscriptionRef.SubscriptionRef<BindingIdentity | null>,
  ownerRef: Ref.Ref<string | null>,
  chatConfigsRef: Ref.Ref<{ readonly [chatId: string]: FeishuChatConfig }>,
  chatDefaultsRef: Ref.Ref<FeishuChatConfig>,
): Effect.Effect<void, never, EnvironmentRegistry> =>
  Effect.gen(function* () {
    const registry = yield* EnvironmentRegistry;
    yield* registry
      .followStream(environmentId, EnvironmentRpc.subscribe(WS_METHODS.subscribeServerConfig, {}))
      .pipe(
        Stream.orDie,
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            // ServerConfigStreamEvent union: `snapshot` carries the full
            // `config.settings`, `settingsUpdated` the full `payload.settings`;
            // `keybindingsUpdated` / `providerStatuses` carry no settings → ignore.
            const settings =
              event.type === "snapshot"
                ? event.config.settings
                : event.type === "settingsUpdated"
                  ? event.payload.settings
                  : null;
            if (settings === null) {
              return;
            }
            // (1) Binding view — drives re-bind. Pure extraction, never throws.
            yield* SubscriptionRef.set(bindingView, toBindingIdentity(settings.feishuBinding));
            // (2) Owner + per-chat config live-refresh (M-2). Pure extractions,
            // never throw → last-known-good fail-safe (never cleared on error, so a
            // schema defect keeps the last good config rather than locking approvals
            // out). `ownerRef` is the binding owner (a PUBLIC field) read by the
            // cardAction gate for owner-always authz; `chatConfigsRef` /
            // `chatDefaultsRef` carry the per-chat approval config the gate reads for
            // its three-state (initiator/designated/all) decision.
            yield* Ref.set(ownerRef, settings.feishuBinding?.ownerOpenId ?? null);
            yield* Ref.set(chatConfigsRef, settings.feishuChatConfigs);
            yield* Ref.set(chatDefaultsRef, settings.feishuChatDefaults);
          }),
        ),
      );
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

/**
 * Translate the typed `resolveEnvironment` failures into an actionable,
 * single-line diagnostic and exit cleanly. Mirrors M0's reporter.
 */
const reportAuthFailure = (error: RemoteEnvironmentRequestError): Effect.Effect<void> => {
  switch (error._tag) {
    case "EnvironmentAuthInvalidError":
      return Console.error(
        `[feishu-bot] pairing token rejected (${error.reason}). Re-run /pair on the server and update T3_PAIRING_TOKEN.`,
      );
    case "EnvironmentScopeRequiredError":
      return Console.error(
        `[feishu-bot] pairing token is missing the required scope "${error.requiredScope}". Re-issue it with the needed scopes.`,
      );
    case "EnvironmentRequestInvalidError":
      return Console.error(`[feishu-bot] auth request rejected by the server (${error.reason}).`);
    case "EnvironmentOperationForbiddenError":
      return Console.error(`[feishu-bot] auth operation forbidden (${error.reason}).`);
    case "EnvironmentInternalError":
      return Console.error(`[feishu-bot] the server reported an internal error (${error.reason}).`);
    case "RemoteEnvironmentAuthTimeoutError":
    case "RemoteEnvironmentAuthFetchError":
      return Console.error(
        `[feishu-bot] could not reach the server; is it running and are httpBaseUrl/wsBaseUrl correct? (${error.message})`,
      );
    case "RemoteEnvironmentAuthUndeclaredStatusError":
    case "RemoteEnvironmentAuthInvalidJsonError":
      return Console.error(
        `[feishu-bot] the server returned an unexpected response. ${error.message}`,
      );
  }
};
