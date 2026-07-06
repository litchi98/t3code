/**
 * Resolve the operator to sign into an observe-mirrored approval card's `payload.o`
 * (security: pin-drift → `initiator`-mode bypass).
 *
 * An observe fiber (`runObserveFiber`) mirrors a turn this end did NOT drive — a
 * chained subagent, a web/terminal-started turn, a `/resume` takeover, or an M18
 * restart recovery. It never touches the turn queue, so `isChatBusy` stays FALSE for
 * its whole life. If the card's signed `payload.o` were resolved from a per-chat
 * "last sender" ref, a mid-observe bystander who `@`-mentions the bot (even a floor
 * command) would flip that ref to themselves, the next tick would re-sign the card to
 * them, and their single click would self-authorize in `initiator` mode. So the
 * operator MUST come from a TRUSTED source, never a driftable ref.
 *
 * The caller passes the value from the per-thread `feishuInitiators` map — written
 * ONLY by turn-establishing Feishu actions (`driveTurn` / `/resume` / M18), so a
 * bystander cannot poison it — with the persisted card handle's operator as a restart
 * fallback.
 *
 * Precedence:
 *  1. `mapInitiator` — the trusted per-thread Feishu initiator, else
 *  2. `handleOperator` — the durable handle's operator (M18 restart: the map may be
 *     empty right after a restart, but the persisted handle still carries the
 *     recovered operator so the button stays signed), else
 *  3. `undefined` — NO Feishu initiator (a web/terminal-started turn the bot merely
 *     mirrors). `buildInteraction` then signs `payload.o` empty, so the
 *     `initiator`-mode gate rejects every non-owner click (approve it from the web /
 *     as owner; owner-always and `designated`/`all` are unaffected). This is the SAFE
 *     outcome — there is NO fresh driftable-ref read behind it.
 *
 * Pure + IO-free so it is unit-testable in isolation from the Effect fiber.
 */
export const resolveObserveOperator = (
  /** The trusted per-thread Feishu initiator (`feishuInitiators.get(threadId)`). */
  mapInitiator: string | undefined,
  /** The persisted card handle's `operatorOpenId`, or `undefined` when absent/empty. */
  handleOperator: string | undefined,
): string | undefined => {
  if (mapInitiator !== undefined && mapInitiator.length > 0) {
    return mapInitiator;
  }
  if (handleOperator !== undefined && handleOperator.length > 0) {
    return handleOperator;
  }
  return undefined;
};
