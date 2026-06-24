# @t3tools/feishu-bot

Headless Node client for t3code (飞书 bridge, milestone **M0**).

It reuses `@t3tools/client-runtime` to connect to a local t3code server and runs
one end-to-end conversation:

> auth → connect WS → subscribe shell (discover/create project) → subscribe
> thread → create thread → start a turn with a prompt → print the event stream
> until the turn completes, then exit cleanly.

No Feishu SDK is involved at M0. The `src/runtime/*` layer is the reusable
skeleton later milestones (M1+) build on.

## Prerequisites

1. A running local t3code server (e.g. `pnpm dev:server`).
2. A one-time pairing credential. The server prints it on startup as a line like
   `Token: <value>` (valid once, ~5 minutes).

## Configuration

All inputs come from environment variables, each overridable by a CLI flag.

| Env var             | CLI flag           | Required | Default                                 |
| ------------------- | ------------------ | -------- | --------------------------------------- |
| `T3_PAIRING_TOKEN`  | `--pairing-token`  | **yes**  | —                                       |
| `T3_HTTP_BASE_URL`  | `--http-base-url`  | no       | `http://127.0.0.1:3000`                 |
| `T3_WS_BASE_URL`    | `--ws-base-url`    | no       | derived from HTTP url (`http`→`ws`)     |
| `T3_PROMPT`         | `--prompt`         | no       | `Say hello from the t3code feishu-bot.` |
| `T3_WORKSPACE_ROOT` | `--workspace-root` | no       | `process.cwd()`                         |

`T3_WORKSPACE_ROOT` is only used when the server has no project and the bot has
to create one.

## Running

```sh
# via env vars
T3_PAIRING_TOKEN=<token> \
T3_HTTP_BASE_URL=http://127.0.0.1:3000 \
T3_PROMPT="What files are in this repo?" \
pnpm --filter @t3tools/feishu-bot dev

# or via CLI flags
pnpm --filter @t3tools/feishu-bot dev -- \
  --pairing-token <token> \
  --http-base-url http://127.0.0.1:3000 \
  --prompt "What files are in this repo?"
```

The process prints `[feishu-bot] ...` log lines for each step and each thread
event, then exits 0 once it sees `thread.turn-diff-completed`.

## Checks

```sh
pnpm --filter @t3tools/feishu-bot typecheck   # tsgo --noEmit
vp check apps/feishu-bot                       # fmt + lint + typecheck
```

## Scope notes (M0)

- Self-contained: the bot creates its own thread and sends one prompt.
- Auth uses the bearer path (Option A): the pairing credential is exchanged for a
  30-day access token; the runtime turns that into a short-lived ws-ticket on its
  own. The relay / DPoP code paths are wired but never exercised.
- All state is in memory; SQLite/file persistence is deferred to a later
  milestone.
