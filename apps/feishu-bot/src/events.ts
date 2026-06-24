import type { OrchestrationThreadStreamItem } from "@t3tools/contracts";

/**
 * Render a thread stream item as a single human-friendly log line for stdout.
 *
 * The thread subscription emits two kinds of items: an initial `snapshot` of the
 * thread state, then a sequence of `event`s. We surface the event `type` (the
 * discriminant inside the `event` payload) plus its sequence number so the M0
 * run is easy to follow without dumping full payloads.
 */
export function describeThreadEvent(item: OrchestrationThreadStreamItem): string {
  if (item.kind === "snapshot") {
    return `[feishu-bot] thread snapshot @${item.snapshot.snapshotSequence}`;
  }
  const event = item.event;
  return `[feishu-bot] event #${event.sequence} ${event.type}`;
}
