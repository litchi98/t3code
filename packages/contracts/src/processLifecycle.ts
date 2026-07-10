/**
 * Shared SIGTERM→SIGKILL grace periods for the three-level process tree:
 * desktop spawns the server, and the server spawns the feishu-bot.
 *
 * Teardown is layered: each parent sends SIGTERM to its child and waits its
 * own grace period before escalating to SIGKILL. The invariant that must
 * hold across layers:
 *
 *   DESKTOP_BACKEND_TERMINATE_GRACE = SERVER_BOT_TERMINATE_GRACE + margin
 *
 * where `margin` (> 0) covers the server's own shutdown overhead, so desktop
 * always gives the server strictly more time than it needs to force-kill the bot.
 *
 * If the outer (desktop→server) grace were shorter than — or too close to —
 * the inner (server→bot) grace, desktop could SIGKILL the server *while the
 * server is still mid-way through its own SIGTERM→SIGKILL escalation
 * against the bot*. That escalation logic runs inside the server process,
 * so killing the server aborts it before the bot ever gets force-killed,
 * orphaning the bot. `DESKTOP_BACKEND_TERMINATE_GRACE` is derived from
 * `SERVER_BOT_TERMINATE_GRACE` below so the invariant holds by construction
 * instead of by convention.
 *
 * @module processLifecycle
 */
import * as Duration from "effect/Duration";

/**
 * Grace period the server allows the feishu-bot child to shut down
 * gracefully after SIGTERM before escalating to SIGKILL.
 */
export const SERVER_BOT_TERMINATE_GRACE = Duration.seconds(5);

/**
 * Extra time `DESKTOP_BACKEND_TERMINATE_GRACE` adds on top of
 * `SERVER_BOT_TERMINATE_GRACE` to cover the server's *own* shutdown
 * overhead — closing its HTTP listener, flushing state, and observing the
 * bot's exit after SIGKILL — before desktop force-kills the server.
 */
const DESKTOP_BACKEND_TERMINATE_GRACE_MARGIN = Duration.seconds(2);

/**
 * Grace period desktop allows the server child to shut down gracefully
 * after SIGTERM before escalating to SIGKILL.
 *
 * Must exceed `SERVER_BOT_TERMINATE_GRACE` plus a safety margin — see the
 * module doc above for why.
 */
export const DESKTOP_BACKEND_TERMINATE_GRACE = Duration.sum(
  SERVER_BOT_TERMINATE_GRACE,
  DESKTOP_BACKEND_TERMINATE_GRACE_MARGIN,
);
