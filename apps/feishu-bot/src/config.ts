import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import type { RenderDensity } from "./bridge/eventRenderer.ts";

/**
 * Runtime configuration for the headless feishu-bot client.
 *
 * All inputs come from environment variables (with optional `--flag value`
 * CLI overrides). Intentionally tiny: no config file beyond these. See README
 * for the supported variable names.
 */
export interface FeishuBotConfig {
  /** HTTP origin of the local t3code server, e.g. `http://127.0.0.1:3000`. */
  readonly httpBaseUrl: string;
  /** WebSocket origin of the local t3code server, e.g. `ws://127.0.0.1:3000`. */
  readonly wsBaseUrl: string;
  /** One-time pairing credential printed by the server as `Token: ...`. */
  readonly pairingToken: string;
  /**
   * Escape hatch — non-standard use only. When set, the bot selects the ready
   * provider's model whose slug equals or contains this value, instead of
   * defaulting to the project's `defaultModelSelection` / first model. Lets you
   * force a specific model when connecting to a bare/unconfigured server (e.g. a
   * gated `claude-fable-5` that the project's default would miss). Set via
   * `T3_MODEL` / `--model`. When connecting to an already-configured server this
   * is normally unnecessary — the server's project carries its own default.
   */
  readonly modelOverride: string | null;
  /**
   * Escape hatch — non-standard use only. Workspace root used only when the bot
   * has to create a new project because the server has none. `null` (the
   * default) means the bot connects to an already-configured server and inherits
   * its project — `createProject` is never called. Set a non-null path only when
   * running against a bare server (no projects yet) and you need the bot to
   * create one. Set via `T3_WORKSPACE_ROOT` / `--workspace-root`.
   */
  readonly workspaceRoot: string | null;
  /** Feishu/Lark long-connection app credentials (M1+). */
  readonly feishu: FeishuAppConfig;
  /**
   * Directory under which the bot's durable JSON stores live (chatThreadMap,
   * sent commandIds). M4 swaps the backend for SQLite without changing callers.
   */
  readonly stateDir: string;
}

/** Which Feishu tenant the bot connects to; selects the open-platform domain. */
export type FeishuTenant = "feishu" | "lark";

/**
 * Long-connection credentials for the Feishu/Lark open platform. The bot uses
 * App ID + App Secret over a WebSocket transport (no scan-code, no user OAuth);
 * the SDK auto-exchanges these for a `tenant_access_token`.
 */
export interface FeishuAppConfig {
  /** Open-platform app id (`cli_...`). From `FEISHU_APP_ID`. */
  readonly appId: string;
  /** Open-platform app secret. From `FEISHU_APP_SECRET`. */
  readonly appSecret: string;
  /** Which tenant this app belongs to. From `FEISHU_TENANT` (default `feishu`). */
  readonly tenant: FeishuTenant;
  /**
   * Open-platform domain derived from {@link tenant}: `feishu` →
   * `https://open.feishu.cn`, `lark` → `https://open.larksuite.com`. Passed
   * straight to `createLarkChannel({ domain })`.
   */
  readonly domain: string;
  /**
   * Bot-side approval allowlist for group/topic chats (M3a; N-of-1 in M4-1). From
   * `FEISHU_OWNER_OPEN_IDS` (comma-separated). Like `appId`, this is bot-own config
   * — not shared with the server. Empty array = fall back to turn initiator (pre-M3a
   * behavior, no regression). When set, M4-1 treats the WHOLE list as an approval
   * allowlist: the cardAction gate authorises ANY listed member to approve an
   * approval-gated chat (the signed `payload.o` still carries `ownerOpenIds[0]`, but
   * approval is gated by allowlist membership, not by `payload.o`).
   *
   * STRUCTURAL FIX (M4-1) of the M3a single-owner deadlock: approval is now N-of-1,
   * so a group no longer hangs just because `ownerOpenIds[0]` is not a member — any
   * other listed member who IS in the group can approve. A residual deadlock only
   * remains if NONE of the listed members are in the target group (operational
   * misconfiguration, self-diagnosable via `/whoami`). The empty-array default
   * (initiator approval) can never deadlock.
   */
  readonly ownerOpenIds: ReadonlyArray<string>;
  /**
   * Render density for group / topic chats (M3b). From `FEISHU_GROUP_CHAT_DENSITY`
   * (`card` | `markdown` | `text`). Like `ownerOpenIds`, this is bot-own config —
   * not shared with the server. p2p 1:1 chats are always `card` regardless of this
   * value (see `densityForRuntime`); this seam only lowers group/topic noise when
   * set explicitly. Defaults to `card` (no auto-downgrade); an unrecognised value
   * falls back to `card` (non-fatal).
   */
  readonly groupChatDensity: RenderDensity;
}

/** Map a {@link FeishuTenant} to its open-platform domain origin. */
const DOMAIN_BY_TENANT: Readonly<Record<FeishuTenant, string>> = {
  feishu: "https://open.feishu.cn",
  lark: "https://open.larksuite.com",
};

export class FeishuBotConfigError extends Data.TaggedError("FeishuBotConfigError")<{
  readonly message: string;
}> {}

const FLAG_BY_ENV: Readonly<Record<string, string>> = {
  T3_HTTP_BASE_URL: "--http-base-url",
  T3_WS_BASE_URL: "--ws-base-url",
  T3_PAIRING_TOKEN: "--pairing-token",
  T3_MODEL: "--model",
  T3_WORKSPACE_ROOT: "--workspace-root",
  FEISHU_APP_ID: "--feishu-app-id",
  FEISHU_APP_SECRET: "--feishu-app-secret",
  FEISHU_TENANT: "--feishu-tenant",
  FEISHU_OWNER_OPEN_IDS: "--feishu-owner-open-ids",
  FEISHU_GROUP_CHAT_DENSITY: "--feishu-group-chat-density",
  T3_STATE_DIR: "--state-dir",
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
    const workspaceRoot = resolveValue("T3_WORKSPACE_ROOT", env, args) ?? null;
    const modelOverride = resolveValue("T3_MODEL", env, args) ?? null;

    const pairingToken = resolveValue("T3_PAIRING_TOKEN", env, args);
    if (pairingToken === undefined) {
      return yield* new FeishuBotConfigError({
        message:
          "Missing pairing token. Set T3_PAIRING_TOKEN (or pass --pairing-token <token>) " +
          "to the one-time `Token:` value printed by the t3code server.",
      });
    }

    const feishu = yield* resolveFeishuAppConfig(env, args);

    const stateDir =
      resolveValue("T3_STATE_DIR", env, args) ??
      (yield* Effect.sync(() => `${process.cwd()}/.feishu-bot`));

    return {
      httpBaseUrl,
      wsBaseUrl,
      pairingToken,
      modelOverride,
      workspaceRoot,
      feishu,
      stateDir,
    } satisfies FeishuBotConfig;
  },
);

/**
 * Resolve the Feishu/Lark app credentials from env/CLI. `appId`/`appSecret`
 * are required (no scan-code fallback in the headless bot); `tenant` defaults
 * to `feishu` and selects the open-platform domain. Missing/invalid values
 * yield a clear, actionable {@link FeishuBotConfigError}.
 */
const resolveFeishuAppConfig = (
  env: Readonly<Record<string, string | undefined>>,
  args: ReadonlyMap<string, string>,
): Effect.Effect<FeishuAppConfig, FeishuBotConfigError> =>
  Effect.gen(function* () {
    const appId = resolveValue("FEISHU_APP_ID", env, args);
    if (appId === undefined) {
      return yield* new FeishuBotConfigError({
        message:
          "Missing Feishu app id. Set FEISHU_APP_ID (or pass --feishu-app-id <cli_...>) " +
          "to your open-platform app's App ID.",
      });
    }

    const appSecret = resolveValue("FEISHU_APP_SECRET", env, args);
    if (appSecret === undefined) {
      return yield* new FeishuBotConfigError({
        message:
          "Missing Feishu app secret. Set FEISHU_APP_SECRET (or pass --feishu-app-secret <secret>) " +
          "to your open-platform app's App Secret.",
      });
    }

    const rawTenant = (resolveValue("FEISHU_TENANT", env, args) ?? "feishu").toLowerCase();
    if (rawTenant !== "feishu" && rawTenant !== "lark") {
      return yield* new FeishuBotConfigError({
        message:
          `Invalid FEISHU_TENANT "${rawTenant}". Expected "feishu" (open.feishu.cn) ` +
          'or "lark" (open.larksuite.com).',
      });
    }
    const tenant: FeishuTenant = rawTenant;

    const ownerOpenIds = (resolveValue("FEISHU_OWNER_OPEN_IDS", env, args) ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    // M3b: group/topic render density. Validated against the three known modes;
    // an unset value defaults to `card`, an unrecognised one falls back to `card`
    // (non-fatal — mirrors the forgiving ownerOpenIds default) with a warning.
    const rawDensity = resolveValue("FEISHU_GROUP_CHAT_DENSITY", env, args);
    const groupChatDensity: RenderDensity =
      rawDensity === "card" || rawDensity === "markdown" || rawDensity === "text"
        ? rawDensity
        : "card";
    if (rawDensity !== undefined && rawDensity !== groupChatDensity) {
      yield* Effect.logWarning(
        `[feishu-bot] Ignoring invalid FEISHU_GROUP_CHAT_DENSITY "${rawDensity}" ` +
          '(expected "card" | "markdown" | "text"); falling back to "card".',
      );
    }

    return {
      appId,
      appSecret,
      tenant,
      domain: DOMAIN_BY_TENANT[tenant],
      ownerOpenIds,
      groupChatDensity,
    } satisfies FeishuAppConfig;
  });

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
