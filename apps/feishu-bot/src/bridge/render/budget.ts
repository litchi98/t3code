/**
 * Byte estimation, trimming, and the final hard clamp (degradation budgets).
 *
 * The base sizing layer of the v3 renderer (extracted from `eventRenderer.ts`;
 * M6, card render v3, M2b-4). Every element is byte-estimated and degraded to
 * stay under Feishu's ~30KB per-element ceiling. Strictly pure: no IO.
 */
import type { CardElement } from "../../lark/card.ts";

import { markdown } from "./elements.ts";

// ── Degradation budgets ───────────────────────────────────────────────────
// Headroom below MAX_ELEMENT_BYTES so the JSON envelope (tag/field keys, escape
// expansion of the markdown content) can't push a "safe" element over the wire
// limit. We size content against this rather than the raw ceiling.
export const SAFE_ELEMENT_BYTES = 28_000;
/** A single activity row's detail before it gets trimmed. */
export const TOOL_DETAIL_MAX_CHARS = 800;
/** Marker appended to any text we had to cut. */
export const TRUNCATION_MARKER = "\n\n… [truncated]";
/**
 * Appended to an activity detail row when its content was truncated. Diff/
 * file-change tools can carry far more than {@link TOOL_DETAIL_MAX_CHARS}; rather
 * than mint a deep link we point the operator at the terminal/Web where the full
 * diff lives.
 */
export const DIFF_OVERFLOW_HINT = " (diff 较大,完整内容请见终端/Web)";

// ── Byte estimation ─────────────────────────────────────────────────────────

/**
 * UTF-8 byte length of a string. `Buffer.byteLength` is exact and allocation
 * free for length queries.
 */
const utf8Bytes = (value: string): number => Buffer.byteLength(value, "utf8");

/**
 * Estimate the serialized byte size of a card element. We serialize to JSON
 * (what actually goes on the wire) and measure its UTF-8 length, so key names,
 * nesting, and escape expansion are all counted — not just the visible text.
 */
export const elementBytes = (element: CardElement): number => utf8Bytes(JSON.stringify(element));

/**
 * Trim `text` so its UTF-8 byte length (plus the truncation marker) stays at or
 * under `maxBytes`. Cuts on a code-point boundary; appends the marker only when
 * a cut actually happened.
 */
export const trimToBytes = (
  text: string,
  maxBytes: number,
): { readonly text: string; readonly cut: boolean } => {
  if (utf8Bytes(text) <= maxBytes) {
    return { text, cut: false };
  }
  const markerBytes = utf8Bytes(TRUNCATION_MARKER);
  const budget = Math.max(0, maxBytes - markerBytes);
  // Walk code points (not UTF-16 units) so we never split a surrogate pair.
  let acc = "";
  let accBytes = 0;
  for (const ch of text) {
    const chBytes = utf8Bytes(ch);
    if (accBytes + chBytes > budget) {
      break;
    }
    acc += ch;
    accBytes += chBytes;
  }
  return { text: `${acc}${TRUNCATION_MARKER}`, cut: true };
};

/** Trim by character count, marking truncation. Cheaper pre-pass before bytes. */
export const trimToChars = (
  text: string,
  maxChars: number,
): { readonly text: string; readonly cut: boolean } => {
  if (text.length <= maxChars) {
    return { text, cut: false };
  }
  return { text: `${text.slice(0, maxChars)}${TRUNCATION_MARKER}`, cut: true };
};

/**
 * Final guard: any element still over the hard ceiling after section-level
 * trimming gets its markdown content clamped to bytes. Guarantees no element
 * can abort the stream regardless of how content was composed.
 */
export const clampElement = (
  element: CardElement,
  maxBytes: number,
): { readonly element: CardElement; readonly degraded: boolean } => {
  if (elementBytes(element) <= maxBytes) {
    return { element, degraded: false };
  }
  // Re-clamp the visible markdown content against a content-only budget. We
  // subtract the element's structural overhead (its serialized size minus the
  // content) from the ceiling so the whole element lands under the limit.
  const e = element as { tag?: string; content?: string };
  if (e.tag === "markdown" && typeof e.content === "string") {
    const overhead = elementBytes({ ...e, content: "" } as CardElement);
    const budget = Math.max(0, maxBytes - overhead);
    const candidate = markdown(trimToBytes(e.content, budget).text);
    // `trimToBytes` measures the *raw* UTF-8 content, but the wire bytes are the
    // JSON-serialized element — escape expansion (\n, ", \\, control chars each
    // cost +1 byte) can push a "fits the budget" content back over the ceiling
    // (e.g. a multi-line stack-trace lastError banner). Re-measure the serialized
    // element; if it still overflows, fall through to the marker fallback. (#7/#8)
    if (elementBytes(candidate) <= maxBytes) {
      return { element: candidate, degraded: true };
    }
  }
  // Collapsible (or unknown) element, or markdown whose escape expansion still
  // overflows: collapse to a degraded marker.
  return { element: markdown("… [content too large; collapsed]"), degraded: true };
};
