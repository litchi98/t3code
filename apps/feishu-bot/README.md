# @t3tools/feishu-bot

Headless Node client for t3code (飞书 bridge, milestone **M2b**).

It reuses `@t3tools/client-runtime` to connect to a running t3code server and
keeps a resident Feishu bot alive: auth → connect WS → discover project →
resolve model → route every private-chat message through the bridge (dispatch
turn → stream card → handle approvals/user-input) — looping forever.

## Prerequisites

1. A running t3code server with at least one project already configured (the
   normal case — the server's project is inherited; the bot never calls
   `createProject`).
2. A one-time pairing credential. The server prints it on startup as a line like
   `Token: <value>` (valid once, ~5 minutes).
3. A Feishu open-platform app with long-connection WebSocket enabled, and its
   App ID / App Secret.

## Configuration

All inputs come from environment variables, each overridable by a matching CLI
flag.

### Required — connecting to an already-configured server (normal use)

| Env var             | CLI flag              | Notes                                         |
| ------------------- | --------------------- | --------------------------------------------- |
| `FEISHU_APP_ID`     | `--feishu-app-id`     | Open-platform app id (`cli_...`)              |
| `FEISHU_APP_SECRET` | `--feishu-app-secret` | Open-platform app secret                      |
| `T3_PAIRING_TOKEN`  | `--pairing-token`     | One-time `Token:` value printed by the server |

### Optional — networking / storage

| Env var            | CLI flag          | Default                             |
| ------------------ | ----------------- | ----------------------------------- |
| `T3_HTTP_BASE_URL` | `--http-base-url` | `http://127.0.0.1:3000`             |
| `T3_WS_BASE_URL`   | `--ws-base-url`   | derived from HTTP url (`http`→`ws`) |
| `FEISHU_TENANT`    | `--feishu-tenant` | `feishu` (`lark` for Lark/global)   |
| `T3_STATE_DIR`     | `--state-dir`     | `<cwd>/.feishu-bot`                 |

### Escape hatches — non-standard / bare-server use only

These are not needed when connecting to an already-configured t3code server.

| Env var             | CLI flag           | Default | Purpose                                                                                                                     |
| ------------------- | ------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------- |
| `T3_WORKSPACE_ROOT` | `--workspace-root` | `null`  | If set, the bot creates a project at this path when the server has none. Leave unset when the server already has a project. |
| `T3_MODEL`          | `--model`          | `null`  | Force a specific model slug (e.g. `claude-sonnet-4-5`). Leave unset to inherit the project's default model selection.       |

## Running

```sh
# Minimal — connect to an already-configured local server
FEISHU_APP_ID=cli_... \
FEISHU_APP_SECRET=... \
T3_PAIRING_TOKEN=<token> \
pnpm --filter @t3tools/feishu-bot dev

# With explicit server URL
FEISHU_APP_ID=cli_... \
FEISHU_APP_SECRET=... \
T3_PAIRING_TOKEN=<token> \
T3_HTTP_BASE_URL=http://127.0.0.1:3000 \
pnpm --filter @t3tools/feishu-bot dev

# Bare-server escape hatch: create a project at a specific path
FEISHU_APP_ID=cli_... \
FEISHU_APP_SECRET=... \
T3_PAIRING_TOKEN=<token> \
T3_WORKSPACE_ROOT=/path/to/workspace \
pnpm --filter @t3tools/feishu-bot dev
```

## Troubleshooting / Known limitations

- **Group approval card can't be approved by anyone / the turn hangs.**
  `FEISHU_OWNER_OPEN_IDS` is the approval allowlist (comma-separated, N-of-1): any
  listed member may approve a group/topic card. M4-1 structurally fixed the old
  single-owner deadlock — a group no longer hangs just because the first id is not
  in it. A residual hang only happens if NONE of the listed ids is a member of that
  group; ask a configured approver to run `/whoami` in the group and confirm their
  open id is in the list. Leaving `FEISHU_OWNER_OPEN_IDS` unset (the default) falls
  back to initiator approval and can never deadlock.

## Checks

```sh
pnpm --filter @t3tools/feishu-bot typecheck   # tsgo --noEmit
vp check apps/feishu-bot                       # fmt + lint + typecheck
```
