/**
 * Mutable chat→thread binding state (M2a).
 *
 * M1 resolved a chat's thread straight from {@link ChatThreadMapStore} (whose
 * value was a bare `ThreadId`). M2a needs the binding to be *mutable* — a chat
 * can be re-pointed at a different thread via `/resume` (taking over a thread
 * another end created) — and to carry per-binding metadata ({@link ChatBinding}:
 * `origin`). This module is the single in-memory owner of the "current binding"
 * per chat, mirrored to the durable {@link ChatThreadMapStore}.
 *
 * Why an in-memory layer over the store rather than hitting the store directly:
 * the store's reads/writes sit in the `FeishuBotPersistenceError` channel, but
 * the bridge's hot path wants a *total* binding lookup. So {@link BindingState}
 * keeps an authoritative in-memory `Map` (seeded once from the store at layer
 * build) and serves `get`/`entries` from it synchronously; `bind`/`unbind`
 * update the map first (so the next `get` reflects the change immediately) and
 * then persist through the store, *absorbing* a persist failure (logged, not
 * propagated) to keep the public surface `never`-failing — the same "memory is
 * authoritative, persistence is best-effort, log on failure" discipline
 * `bridge/outbound.ts` and `bot.ts` already apply around this store.
 *
 * The {@link ChatBinding} type is owned by `runtime/persistence.ts` (the storage
 * domain) and re-exported here for callers that only depend on `bindingState`.
 */
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { type ChatBinding, ChatThreadMapStore } from "../runtime/persistence.ts";

// Re-export so modules that consume bindings depend on `bridge/bindingState`
// for the full set of binding contracts without reaching into the store module.
export type { ChatBinding };

/**
 * Mutable chat→thread binding state service (M2a).
 *
 * The `Context.Service` tag whose `["Service"]` shape is the bridge's read/write
 * surface over the current bindings. Follows the house style
 * (`OutboundQueue`/`TurnQueue`/`ChatThreadMapStore`). Consumers that only need
 * the shape (e.g. `bridge/shellWatcher.ts`) reference `BindingState["Service"]`.
 *
 * Reads (`get`, `entries`) are total and synchronous (served from the in-memory
 * map). Writes (`bind`, `unbind`) update the map *and* persist to
 * {@link ChatThreadMapStore}; a persistence failure is logged and swallowed so
 * the effects stay `never`-failing (memory authoritative, persistence
 * best-effort — see the module doc).
 */
export class BindingState extends Context.Service<
  BindingState,
  {
    /** Current binding for `chatId`, or `null` if the chat is unbound. */
    readonly get: (chatId: string) => Effect.Effect<ChatBinding | null>;
    /**
     * Set `chatId`'s current binding (overwrites any existing one), updating both
     * the in-memory map and the durable store. A persist failure is logged, not
     * propagated.
     */
    readonly bind: (chatId: string, binding: ChatBinding) => Effect.Effect<void>;
    /**
     * Drop `chatId`'s binding from both memory and the durable store (no-op if
     * absent). A persist failure is logged, not propagated.
     */
    readonly unbind: (chatId: string) => Effect.Effect<void>;
    /** Snapshot of every `[chatId, binding]` pair (e.g. for warm-up logging). */
    readonly entries: Effect.Effect<ReadonlyArray<readonly [string, ChatBinding]>>;
  }
>()("@t3tools/feishu-bot/bridge/bindingState") {}

/**
 * Build the {@link BindingState} layer over a {@link ChatThreadMapStore}.
 *
 * Seeds the in-memory map once from the store's `entries` at build time (the
 * store has already migrated any legacy M1 bare-`ThreadId` JSON to
 * {@link ChatBinding} — see `runtime/persistence.ts`). The seed read is
 * best-effort: if it fails we start empty and log, rather than refusing to boot
 * the bridge (a fresh/unreadable store should degrade to "no bindings yet", not
 * crash). Subsequent reads are served from the map; writes mirror to the store.
 */
export const bindingStateLayer: Layer.Layer<BindingState, never, ChatThreadMapStore> = Layer.effect(
  BindingState,
  Effect.gen(function* () {
    const store = yield* ChatThreadMapStore;

    // Seed once from the durable store (already migrated to ChatBinding). Treat a
    // read failure as "no bindings yet" + log, so an unreadable store degrades
    // rather than blocking startup.
    const seeded = yield* store.entries.pipe(
      Effect.tapError((error) =>
        Console.error(
          `[feishu-bot] could not load chat bindings from store; starting empty: ${error.message}`,
        ),
      ),
      Effect.orElseSucceed(() => [] as ReadonlyArray<readonly [string, ChatBinding]>),
    );
    const bindings = yield* Ref.make<ReadonlyMap<string, ChatBinding>>(new Map(seeded));

    const get = (chatId: string): Effect.Effect<ChatBinding | null> =>
      Ref.get(bindings).pipe(Effect.map((map) => map.get(chatId) ?? null));

    const bind = (chatId: string, binding: ChatBinding): Effect.Effect<void> =>
      Effect.gen(function* () {
        // Update memory first so the next `get` reflects the new binding even if
        // the persist below fails (memory authoritative).
        yield* Ref.update(bindings, (map) => new Map(map).set(chatId, binding));
        yield* store.put(chatId, binding).pipe(
          // Severity depends on whether the lost persist self-heals. A
          // `self-created` binding's threadId is deterministic from chatId
          // (`deriveThreadId`), so a dropped persist is re-derived on the next
          // message + dedup'd by the server — best-effort, low severity. A
          // `resumed` takeover's threadId is *not* recoverable from chatId, so a
          // dropped persist + crash silently loses the takeover (the chat reverts
          // to its self-created thread on restart). Surface that at error level
          // and say so explicitly.
          Effect.tapError((error) =>
            binding.origin === "resumed"
              ? Effect.logError(
                  `[feishu-bot] resumed takeover bound in memory but persist failed for chat ${chatId}; the takeover may not survive a restart: ${error.message}`,
                )
              : Console.error(
                  `[feishu-bot] binding updated in memory but persist failed for chat ${chatId}: ${error.message}`,
                ),
          ),
          Effect.ignore,
        );
      });

    const unbind = (chatId: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* Ref.update(bindings, (map) => {
          if (!map.has(chatId)) {
            return map;
          }
          const next = new Map(map);
          next.delete(chatId);
          return next;
        });
        yield* store.remove(chatId).pipe(
          Effect.tapError((error) =>
            Console.error(
              `[feishu-bot] binding removed in memory but persist failed for chat ${chatId}: ${error.message}`,
            ),
          ),
          Effect.ignore,
        );
      });

    const entries: Effect.Effect<ReadonlyArray<readonly [string, ChatBinding]>> = Ref.get(
      bindings,
    ).pipe(Effect.map((map) => Array.from(map.entries())));

    return BindingState.of({ get, bind, unbind, entries });
  }),
);
