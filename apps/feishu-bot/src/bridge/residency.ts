/**
 * Resident session helpers extracted from bot.ts.
 *
 * Owns the binding identity, credential acquisition, rebinding watcher, and
 * auth-failure reporting used by the bridge's outer lifecycle.
 */
import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import * as EnvironmentRpc from "@t3tools/client-runtime/rpc";
import type { RemoteEnvironmentRequestError } from "@t3tools/client-runtime/rpc";
import { WS_METHODS } from "@t3tools/contracts";
import type { EnvironmentId, FeishuChatConfig, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  DOMAIN_BY_TENANT,
  type FeishuBotConfig,
  type FeishuCredentialOverride,
  type FeishuTenant,
} from "../config.ts";
import { BindingState } from "./bindingState.ts";
import { deriveThreadId, splitChatKey } from "./chatThreadMap.ts";

// ── PR2: runtime credential resolution + the resident re-bind loop ───────────

/**
 * The public identity of a bound bot — what changes on a re-bind (bind a new
 * app, unbind, or swap tenant). Deliberately excludes `appSecret`: the secret is
 * fetched on demand via the credentials RPC and never travels on the settings
 * stream or this view (so a leak surface is one place, not two).
 */
export interface BindingIdentity {
  readonly appId: string;
  readonly tenant: FeishuTenant;
}

/** Structural equality for {@link BindingIdentity} (null = unbound). */
export const bindingIdentityEq = (a: BindingIdentity | null, b: BindingIdentity | null): boolean =>
  a === null || b === null ? a === b : a.appId === b.appId && a.tenant === b.tenant;

/**
 * Project the public `ServerSettings.feishuBinding` (or `undefined` = no bot
 * bound) onto a {@link BindingIdentity}. Drops `ownerOpenId` — only app id +
 * tenant decide whether the running session must be re-bound.
 */
export const toBindingIdentity = (
  binding: { readonly appId: string; readonly tenant: FeishuTenant } | undefined,
): BindingIdentity | null =>
  binding === undefined ? null : { appId: binding.appId, tenant: binding.tenant };

/**
 * The outcome of resolving the bot's credentials for one loop iteration: either a
 * full credential set (from the `.env` dev override or the server fetch) or
 * "unbound" (no bot bound yet, or the server was transiently unreachable — both
 * collapse to a backoff-and-retry in the resident loop).
 */
export type CredentialResolution =
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
export class FeishuSessionFailure extends Data.TaggedError("FeishuSessionFailure") {}

/**
 * Strip a known secret from a string (e.g. a stringified {@link Cause.Cause})
 * before it is logged, so the secret-isolation red line holds even in the rare
 * case the Lark SDK echoes the `appSecret` inside a connect/session error. A
 * no-op when the secret is empty — a blank `replaceAll` would splice the marker
 * between every character. The bound-session `creds.appSecret` is always present,
 * so this only redacts; it never mangles.
 */
export const redactSecret = (text: string, secret: string): string =>
  secret.length > 0 ? text.replaceAll(secret, "***") : text;

/**
 * Per-session self-heal schedule: exponential from 1s, capped at 30s, recurring
 * forever (mirrors apps/web's `exponential ∪ spaced` cap idiom — `either` takes
 * the min delay). Used to rebuild the Lark gateway after a transient connect
 * failure (the `gateway.connect` `orDie` defect) without crashing the loop.
 */
export const SESSION_RETRY_SCHEDULE = Schedule.exponential(Duration.seconds(1)).pipe(
  Schedule.either(Schedule.spaced(Duration.seconds(30))),
);

/**
 * Safety re-check interval for the Unbound wait: even with no binding-change
 * wakeup we re-acquire periodically, so a secret injected without a
 * `feishuBinding` change (the split-injection e2e) — or a lost wakeup — recovers
 * within this bound instead of parking forever.
 */
export const UNBOUND_RECHECK_INTERVAL = Duration.seconds(30);

/**
 * Resolve the bound thread for a composite chat key from {@link BindingState},
 * falling back to the deterministic `deriveThreadId` for a not-yet-bound chat.
 * Hoisted out of `program` so each per-binding `turnQueueLayer` reuses the SAME
 * lookup (its `BindingState` requirement is satisfied by the outer layer). See
 * the M2a/M3a invariant note on `turnQueueLayer`.
 */
export const threadIdForChatKey = (chatKey: string): Effect.Effect<ThreadId, never, BindingState> =>
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
export const acquireCredentials = (
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
export const runBindingAndConfigWatcher = (
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
 * Translate the typed `resolveEnvironment` failures into an actionable,
 * single-line diagnostic and exit cleanly. Mirrors M0's reporter.
 */
export const reportAuthFailure = (error: RemoteEnvironmentRequestError): Effect.Effect<void> => {
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
