/**
 * Table-driven slash-command parsing framework (M2a).
 *
 * Ported from the reference bridge's `commands/index.ts` (`tryHandleCommand` +
 * the handler table), stripped of everything M2a does not own: the CLI, the
 * standalone-session machinery, the access policy, and the admin gate. What
 * remains is the pure parse-and-dispatch skeleton, rewritten from the
 * reference's `async`/`Promise` shape into Effect.
 *
 * The framework is deliberately *output-free*: it never sends a Feishu message.
 * It only classifies an inbound message —
 *   - not a command (no leading `/`)  → `{ handled: false }` (the caller routes
 *     it to the normal turn path),
 *   - a known command                 → runs the handler, `{ handled: true }`,
 *   - an unknown command (`/` prefix, no table hit) → `{ handled: true,
 *     unknownCommand }` (the caller decides whether to reply with help).
 *
 * Per-handler isolation mirrors the reference's `try/catch` and `bot.ts`'s
 * per-message fiber isolation: each handler runs under {@link Effect.catchCause}
 * so a handler failure is logged and swallowed — it never bubbles out of
 * `tryHandleCommand` and never crashes the message loop.
 */
import * as Effect from "effect/Effect";

import type { InboundMessage } from "../../lark/types.ts";

/**
 * Context handed to a command handler: the triggering message plus the parsed
 * argument forms.
 *
 * `args` is the raw remainder after the command token (everything past the
 * first whitespace run), preserving inner spacing — handlers that want a single
 * free-text argument read this. `argv` is the same remainder split on
 * whitespace, for handlers that take positional sub-arguments.
 */
export interface CommandContext {
  /** The inbound message that triggered the command. */
  readonly message: InboundMessage;
  /** Raw argument string: everything after the command token, untrimmed inner. */
  readonly args: string;
  /** Argument tokens: the trimmed body split on whitespace, command excluded. */
  readonly argv: ReadonlyArray<string>;
}

/**
 * A command handler. Total by contract: any failure is caught and logged by
 * {@link tryHandleCommand}, so the effect's error/requirement channels are
 * `never` at the dispatch boundary (handlers may use a richer effect internally
 * and discharge it before being placed in the table).
 */
export type CommandHandler = (ctx: CommandContext) => Effect.Effect<void>;

/**
 * Classification of an inbound message by the command system.
 *
 * `handled: false` — not a command (no leading `/`); the caller dispatches it as
 * a normal turn.
 *
 * `handled: true` — the message *was* a command and is fully accounted for by
 * the command system: either a table hit (its handler ran) or a `/`-prefixed
 * miss. On a miss, {@link CommandOutcome.unknownCommand} carries the normalised
 * command token so the caller can decide how to respond (e.g. reply with help).
 */
export interface CommandOutcome {
  /** True when the command system owns this message (hit, or `/`-prefixed miss). */
  readonly handled: boolean;
  /**
   * Set only on a `/`-prefixed message that matched no table entry: the
   * normalised (lowercased) command token, including its leading `/`. Absent on
   * a hit and on a non-command message.
   */
  readonly unknownCommand?: string;
}

/**
 * Parse `message.text` as a slash command and, on a table hit, run its handler.
 *
 * Parse rules (mirrors the reference, minus the gates):
 *  - Trim the text. If it does not start with `/`, it is not a command →
 *    `{ handled: false }` (the caller routes it to the normal turn path).
 *  - Otherwise split on whitespace runs. The command token is the first part,
 *    normalised to lowercase (so `/HELP` ≡ `/help`); `args` is the raw
 *    remainder after that token; `argv` is the remaining parts.
 *  - On a table hit, run the handler under {@link Effect.catchCause} (a handler
 *    failure is logged, never bubbled) → `{ handled: true }`.
 *  - On a `/`-prefixed miss, return `{ handled: true, unknownCommand }` without
 *    sending anything (the caller decides the response).
 *
 * Always total: never fails, never requires services at the boundary.
 */
export const tryHandleCommand = (
  message: InboundMessage,
  table: ReadonlyMap<string, CommandHandler>,
): Effect.Effect<CommandOutcome> =>
  Effect.gen(function* () {
    const trimmed = message.text.trim();
    if (!trimmed.startsWith("/")) {
      return { handled: false } satisfies CommandOutcome;
    }

    const parts = trimmed.split(/\s+/);
    // `parts[0]` is non-empty: `trimmed` starts with `/` and was already
    // trimmed, so the split's first token is the `/…` command word.
    const cmd = (parts[0] ?? "").toLowerCase();
    const argv = parts.slice(1);
    // Raw remainder after the command token, preserving inner spacing. Slice off
    // the original (un-normalised) token length, then drop the single separating
    // run via trimStart so `args` is the argument body without a leading space.
    const args = trimmed.slice((parts[0] ?? "").length).trimStart();

    const handler = table.get(cmd);
    if (handler === undefined) {
      // `/`-prefixed but unmatched: the command system still owns it (so the
      // caller does NOT dispatch it as a turn), but we send nothing — the caller
      // reads `unknownCommand` to decide whether to reply with help.
      return { handled: true, unknownCommand: cmd } satisfies CommandOutcome;
    }

    // Per-handler isolation: a handler failure (any cause — error or defect) is
    // logged and swallowed here, exactly like the reference's try/catch and
    // bot.ts's per-message fiber isolation. It must never bubble out of dispatch.
    yield* handler({ message, args, argv }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError(`[feishu-bot] command handler failed for ${cmd}.`, cause),
      ),
    );
    return { handled: true } satisfies CommandOutcome;
  });
