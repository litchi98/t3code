import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

/**
 * Runtime configuration for the headless feishu-bot M0 client.
 *
 * All inputs come from environment variables (with optional `--flag value`
 * CLI overrides). M0 deliberately keeps this tiny: no config file, no
 * persistence. See README for the supported variable names.
 */
export interface FeishuBotConfig {
  /** HTTP origin of the local t3code server, e.g. `http://127.0.0.1:3000`. */
  readonly httpBaseUrl: string;
  /** WebSocket origin of the local t3code server, e.g. `ws://127.0.0.1:3000`. */
  readonly wsBaseUrl: string;
  /** One-time pairing credential printed by the server as `Token: ...`. */
  readonly pairingToken: string;
  /** Prompt to send in the single M0 turn. */
  readonly prompt: string;
  /** Workspace root used when the bot has to create a project. */
  readonly workspaceRoot: string;
}

export class FeishuBotConfigError extends Data.TaggedError("FeishuBotConfigError")<{
  readonly message: string;
}> {}

const FLAG_BY_ENV: Readonly<Record<string, string>> = {
  T3_HTTP_BASE_URL: "--http-base-url",
  T3_WS_BASE_URL: "--ws-base-url",
  T3_PAIRING_TOKEN: "--pairing-token",
  T3_PROMPT: "--prompt",
  T3_WORKSPACE_ROOT: "--workspace-root",
};

/**
 * Parse `--flag value` pairs from a raw argv tail into a simple lookup map.
 * Unknown flags are ignored; this is intentionally forgiving for M0.
 */
function parseArgs(argv: ReadonlyArray<string>): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined || !token.startsWith("--")) {
      continue;
    }
    const eqIndex = token.indexOf("=");
    if (eqIndex !== -1) {
      result.set(token.slice(0, eqIndex), token.slice(eqIndex + 1));
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      result.set(token, next);
      index += 1;
    }
  }
  return result;
}

function resolveValue(
  envKey: string,
  env: Readonly<Record<string, string | undefined>>,
  args: ReadonlyMap<string, string>,
): string | undefined {
  const flag = FLAG_BY_ENV[envKey];
  const fromArg = flag === undefined ? undefined : args.get(flag);
  if (fromArg !== undefined && fromArg.trim() !== "") {
    return fromArg.trim();
  }
  const fromEnv = env[envKey];
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    return fromEnv.trim();
  }
  return undefined;
}

/**
 * Read the bot configuration from the process environment and CLI argv.
 *
 * The reads happen inside `Effect.sync` so they are deferred to runtime and
 * stay testable; `process` access is unavoidable for a Node entrypoint.
 */
export const loadConfig: Effect.Effect<FeishuBotConfig, FeishuBotConfigError> = Effect.gen(
  function* () {
    const env = yield* Effect.sync(() => process.env);
    const args = yield* Effect.sync(() => parseArgs(process.argv.slice(2)));

    const httpBaseUrl = resolveValue("T3_HTTP_BASE_URL", env, args) ?? "http://127.0.0.1:3000";
    const wsBaseUrl = resolveValue("T3_WS_BASE_URL", env, args) ?? deriveWsBaseUrl(httpBaseUrl);
    const workspaceRoot =
      resolveValue("T3_WORKSPACE_ROOT", env, args) ?? (yield* Effect.sync(() => process.cwd()));
    const prompt = resolveValue("T3_PROMPT", env, args) ?? "Say hello from the t3code feishu-bot.";

    const pairingToken = resolveValue("T3_PAIRING_TOKEN", env, args);
    if (pairingToken === undefined) {
      return yield* new FeishuBotConfigError({
        message:
          "Missing pairing token. Set T3_PAIRING_TOKEN (or pass --pairing-token <token>) " +
          "to the one-time `Token:` value printed by the t3code server.",
      });
    }

    return {
      httpBaseUrl,
      wsBaseUrl,
      pairingToken,
      prompt,
      workspaceRoot,
    } satisfies FeishuBotConfig;
  },
);

/**
 * Derive a sensible default `wsBaseUrl` from an `httpBaseUrl` by swapping the
 * URL scheme (`http`→`ws`, `https`→`wss`). Falls back to the input untouched
 * if it cannot be parsed.
 */
function deriveWsBaseUrl(httpBaseUrl: string): string {
  try {
    const url = new URL(httpBaseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString().replace(/\/$/, "");
  } catch {
    return httpBaseUrl;
  }
}
