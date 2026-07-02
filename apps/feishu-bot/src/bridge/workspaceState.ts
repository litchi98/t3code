/**
 * Mutable chat→workspace selection state (M-1, per-chat-config milestone).
 *
 * The single in-memory owner of "which project this conversation has selected
 * via `/workspace`", mirrored to the durable {@link ChatWorkspaceStore}
 * (`chat-workspace.json`). Exactly the {@link BindingState} discipline over
 * {@link ChatThreadMapStore}: memory is authoritative (seeded once from the
 * store at layer build, reads are total and synchronous), persistence is
 * best-effort (writes update the map first, then persist through the store,
 * absorbing a persist failure with a log) — so the bridge hot path (the
 * "no thread without a selected workspace" gate runs on every inbound
 * message) never touches the `FeishuBotPersistenceError` channel.
 *
 * Keyed by the composite `chatId[:larkThreadId]` (`compositeChatKey`): each
 * topic in a topic group selects its workspace independently, intentionally
 * matching the binding-key granularity (kickoff §5A/§5B).
 *
 * Selection lifecycle notes:
 * - A selection exists *before* any thread does (that is why it cannot live on
 *   `ChatBinding`, whose `threadId` is required).
 * - `/release` does NOT clear the selection — releasing a session does not
 *   un-choose the workspace.
 * - A selection whose project has since been deleted is kept as-is (the
 *   dispatch-time validation refuses it with a "re-select" notice instead of
 *   silently dropping state): the shell snapshot may be transiently
 *   empty/stale around reconnects, and auto-clearing on a transient gap would
 *   destroy a perfectly valid selection.
 */
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import type { ProjectId } from "@t3tools/contracts";

import { ChatWorkspaceStore } from "../runtime/persistence.ts";

/**
 * Mutable chat→workspace selection service (M-1).
 *
 * Reads (`get`) are total and synchronous (served from the in-memory map).
 * Writes (`select`) update the map *and* persist to {@link ChatWorkspaceStore};
 * a persistence failure is logged and swallowed so the effects stay
 * `never`-failing (memory authoritative, persistence best-effort).
 */
export class WorkspaceState extends Context.Service<
  WorkspaceState,
  {
    /** Selected project for `chatKey`, or `null` when the chat has not chosen. */
    readonly get: (chatKey: string) => Effect.Effect<ProjectId | null>;
    /**
     * Set `chatKey`'s selected project (overwrites any existing selection),
     * updating both the in-memory map and the durable store. A persist failure
     * is logged, not propagated.
     */
    readonly select: (chatKey: string, projectId: ProjectId) => Effect.Effect<void>;
  }
>()("@t3tools/feishu-bot/bridge/workspaceState") {}

/**
 * Build the {@link WorkspaceState} layer over a {@link ChatWorkspaceStore}.
 *
 * Seeds the in-memory map once from the store at build time; a seed-read
 * failure degrades to "no selections yet" with a log rather than refusing to
 * boot (same discipline as `bindingStateLayer`).
 */
export const workspaceStateLayer: Layer.Layer<WorkspaceState, never, ChatWorkspaceStore> =
  Layer.effect(
    WorkspaceState,
    Effect.gen(function* () {
      const store = yield* ChatWorkspaceStore;

      const seeded = yield* store.entries.pipe(
        Effect.tapError((error) =>
          Console.error(
            `[feishu-bot] could not load chat workspace selections from store; starting empty: ${error.message}`,
          ),
        ),
        Effect.orElseSucceed(() => [] as ReadonlyArray<readonly [string, ProjectId]>),
      );
      const selections = yield* Ref.make<ReadonlyMap<string, ProjectId>>(new Map(seeded));

      const get = (chatKey: string): Effect.Effect<ProjectId | null> =>
        Ref.get(selections).pipe(Effect.map((map) => map.get(chatKey) ?? null));

      const select = (chatKey: string, projectId: ProjectId): Effect.Effect<void> =>
        Effect.gen(function* () {
          // Update memory first so the next `get` reflects the new selection
          // even if the persist below fails (memory authoritative).
          yield* Ref.update(selections, (map) => new Map(map).set(chatKey, projectId));
          yield* store.put(chatKey, projectId).pipe(
            Effect.tapError((error) =>
              Console.error(
                `[feishu-bot] workspace selection updated in memory but persist failed for chat ${chatKey}: ${error.message}`,
              ),
            ),
            Effect.ignore,
          );
        });

      return WorkspaceState.of({ get, select });
    }),
  );
