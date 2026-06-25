/**
 * Process-level safety net for SDK-internal async failures the Effect runtime
 * cannot see (M2b-1 reliability hardening).
 *
 * Why this exists. `@larksuite/channel`'s streaming-card controller patches the
 * card on a *throttle timer*: `update(card)` only records the next snapshot and
 * arms a `setTimeout`; the real network write (`patchCard` → node-sdk
 * `im.v1.message.patch`) happens later inside that timer's callback, which the
 * SDK fires **without awaiting or catching** the returned promise
 * (`CardStreamControllerImpl` → `Throttle.fireSoon` → `setTimeout(() =>
 * this.doFire())`). So when a card is rejected by Feishu (e.g. the
 * "[parse card json err] not support tag: checkbox" 400, or any future bad
 * payload / transient 5xx / network blip), the rejection is a raw `AxiosError`
 * that escapes as an **unhandledRejection** — outside every `Effect.tryPromise`
 * / `.catch` we wrap our own calls in — and Node's default handler aborts the
 * whole resident bot (`triggerUncaughtException`, exit 1). One bad streaming
 * tick must never take the process down.
 *
 * What this does. Installs `unhandledRejection` / `uncaughtException` handlers
 * that LOG the failure (so it is never silent) and keep the process alive. The
 * bot is a long-lived bridge whose entire job is to survive flaky Feishu IO; a
 * dropped card tick degrades that one card (the next render tick or the turn's
 * final render re-pushes the authoritative state), it does not warrant killing
 * every other chat's live session. This is deliberately broad because the
 * offending rejection is a bare `AxiosError` with no bridge-specific marker to
 * match on — but it is the *last* line of defence: every failure we can reach
 * inside Effect is already caught and degraded at its call site (notice/card
 * sends are `Effect.ignore`-d with a logged `tapError`; the per-tick card
 * update is `Effect.ignore`-d; `channel.stream(...)` has its own `.catch`).
 *
 * Fatal-by-design exits still work: `NodeRuntime.runMain` calls
 * `process.exit(code)` on the main fiber's terminal failure, which these
 * handlers do not intercept (they only catch *unhandled* async errors). SIGINT/
 * SIGTERM teardown is likewise untouched.
 */
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";

/**
 * Whether a thrown value looks like a Feishu/Lark/Axios IO failure — i.e. the
 * class of error the SDK leaks past our Effect wrappers (a card patch / message
 * send rejection). Matched leniently on the error name / message / code so the
 * bare `AxiosError` that crashed the bot (and its `LarkChannelError` siblings)
 * are recognised, without swallowing a genuine programmer defect (a
 * TypeError/ReferenceError in our own logic, which should still surface).
 */
const looksLikeSdkIoError = (value: unknown): boolean => {
  if (!(value instanceof Error)) {
    return false;
  }
  const name = value.name.toLowerCase();
  if (name.includes("axios") || name.includes("larkchannel") || name.includes("lark")) {
    return true;
  }
  const code = (value as { code?: unknown }).code;
  if (typeof code === "string" && (code.startsWith("ERR_") || code.startsWith("E")) /* ECONN… */) {
    return true;
  }
  const message = value.message.toLowerCase();
  return (
    message.includes("axios") ||
    message.includes("parse card json") ||
    message.includes("request failed") ||
    message.includes("status code") ||
    message.includes("feishu") ||
    message.includes("lark")
  );
};

/** Best-effort one-line description of an unknown thrown value. */
const describe = (value: unknown): string => {
  if (value instanceof Error) {
    // AxiosError stringifies poorly; surface name + message (+ any `code`).
    const code = (value as { code?: unknown }).code;
    const codeSuffix = typeof code === "string" || typeof code === "number" ? ` [${code}]` : "";
    return `${value.name}: ${value.message}${codeSuffix}`;
  }
  try {
    return String(value);
  } catch {
    return "<unprintable error>";
  }
};

/**
 * Register the resident process guards. Idempotent-friendly (call once from
 * `main`), and a no-op-safe `void` so it never throws on install. Returns a
 * disposer that removes the handlers (used by tests; the resident process never
 * calls it).
 */
export const installProcessGuards = (): (() => void) => {
  const onUnhandledRejection = (reason: unknown): void => {
    // Survive: log and keep running. The dropped operation (almost always a
    // throttled streaming-card `patchCard`) degrades one card tick, not the bot.
    Effect.runSync(
      Console.error(
        `[feishu-bot] survived unhandledRejection (likely a streaming-card SDK write): ${describe(
          reason,
        )}`,
      ),
    );
  };

  const onUncaughtException = (error: Error): void => {
    // A *synchronous* uncaught throw is narrower than the rejection case: only
    // survive when it looks like an SDK / Feishu / Axios IO error (the escape
    // class we are guarding). A genuine programmer defect (TypeError, …) is NOT
    // swallowed — re-throw it so Node's default handler aborts, surfacing the
    // bug instead of leaving the process limping in a corrupt state.
    if (!looksLikeSdkIoError(error)) {
      throw error;
    }
    Effect.runSync(
      Console.error(`[feishu-bot] survived uncaughtException (SDK IO): ${describe(error)}`),
    );
  };

  process.on("unhandledRejection", onUnhandledRejection);
  process.on("uncaughtException", onUncaughtException);

  return () => {
    process.off("unhandledRejection", onUnhandledRejection);
    process.off("uncaughtException", onUncaughtException);
  };
};
