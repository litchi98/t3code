/**
 * Model selection helpers extracted from bot.ts.
 *
 * Keeps the per-chat/provider routing rules in one small module while the bridge
 * split keeps behavior byte-for-byte with the original implementation.
 */
import * as EnvironmentRpc from "@t3tools/client-runtime/rpc";
import { isProviderAvailable, WS_METHODS } from "@t3tools/contracts";
import type { ModelSelection, ServerProvider } from "@t3tools/contracts";
import { resolveSelectableModel } from "@t3tools/shared/model";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";

/**
 * Whether `selection` still names a model on a currently-ready provider. Used to
 * validate a persisted `defaultModelSelection` before reusing it: a default that
 * points at a now-disabled/unavailable instance (or a model the instance no
 * longer exposes) must fall back rather than dispatch an unroutable selection.
 */
export const isSelectionRoutable = (
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
export const resolveModelSelection = (
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
