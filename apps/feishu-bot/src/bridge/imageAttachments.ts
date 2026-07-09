/**
 * Inbound image-attachment pipeline (batch A).
 *
 * Turns the Feishu image resources carried by an {@link InboundMessage} into the
 * contract's upload shape ({@link UploadChatImageAttachment}) so the agent can
 * see the picture. All cleansing happens HERE, in the bot, because the server
 * rejects the WHOLE turn (text included) if any one attachment is malformed —
 * it never drops a single bad image or degrades (see `apps/server`
 * `Normalizer`). So we must drop anything the server (or, more narrowly, the
 * Claude adapter) would reject BEFORE we ever build the dispatch:
 *   - a resource that is not one of the four Claude-supported image types
 *     (`png`/`jpeg`/`gif`/`webp` — narrower than the contract's `image/*`);
 *   - a picture over the 10 MB byte cap;
 *   - a picture whose download failed.
 *
 * The 14 MB `dataUrl` character cap the contract also enforces is *subsumed* by
 * the 10 MB byte cap: base64 expands ~4/3, so a ≤10 MB buffer yields a data URL
 * of ≤ ~13.98 M chars (+ the tiny `data:…;base64,` prefix) < 14 M. We therefore
 * guard on bytes alone — keeping batch A zero-contract-change (the byte cap is
 * exported; the data-url cap is module-private in the contract and never
 * hardcoded here).
 *
 * Download + encode run at INBOUND time (see `bridge/inbound.ts`), one place, so
 * the merge/build path downstream is pure carrying — a source message arrives at
 * the queue already carrying its encoded `uploaded` payloads, and offline-buffered
 * messages are pre-encoded too (Feishu resources never expire mid-flush).
 */
import {
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type UploadChatImageAttachment,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";

import type { LarkGatewayError } from "../lark/index.ts";
import type { InboundAttachment, InboundMessage } from "../lark/types.ts";
import type { QueuedMessage } from "./types.ts";

/**
 * The image MIME types Claude actually accepts. Deliberately NARROWER than the
 * contract's `image/*` pattern: svg/bmp/avif/heic pass the server's Normalizer
 * and land on disk, but are then rejected by the Claude adapter *at send time*
 * (a later, more opaque failure) — so we keep only these four and drop the rest
 * at inbound with a notice.
 */
export type SupportedImageMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

const EXT_BY_MIME: Record<SupportedImageMime, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** Does `buffer` start with `bytes` at `offset`? Length-guarded. */
const matchesAt = (buffer: Buffer, bytes: ReadonlyArray<number>, offset = 0): boolean =>
  buffer.length >= offset + bytes.length && bytes.every((b, i) => buffer[offset + i] === b);

/**
 * Sniff the image type from the buffer's magic bytes, returning `null` for
 * anything not in {@link SupportedImageMime}.
 *
 * Feishu image messages carry no MIME type and `downloadImage` returns only raw
 * bytes, so the file name (usually absent for pasted images) is unreliable — we
 * must inspect the content. The signatures:
 *   - PNG  : `89 50 4E 47 0D 0A 1A 0A`
 *   - JPEG : `FF D8 FF`
 *   - GIF  : `47 49 46 38` ("GIF8", covers 87a/89a)
 *   - WebP : `52 49 46 46` ("RIFF") at 0 AND `57 45 42 50` ("WEBP") at 8
 */
export const sniffImageMime = (buffer: Buffer): SupportedImageMime | null => {
  if (matchesAt(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (matchesAt(buffer, [0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }
  if (matchesAt(buffer, [0x47, 0x49, 0x46, 0x38])) {
    return "image/gif";
  }
  if (
    matchesAt(buffer, [0x52, 0x49, 0x46, 0x46]) &&
    matchesAt(buffer, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return "image/webp";
  }
  return null;
};

/**
 * Build the contract upload struct from a sniffed image buffer. Pure.
 *
 * The `name` is sanitised to satisfy the contract's `TrimmedNonEmptyString` +
 * `maxLength(255)` — a Feishu-provided file name that is blank or over-long
 * would otherwise make the server reject the whole turn. Falls back to a stable
 * synthetic name (`image-<idx>.<ext>`). Callers MUST have already checked the
 * byte cap and sniffed a supported MIME.
 */
export const encodeImageAttachment = (params: {
  readonly buffer: Buffer;
  readonly mime: SupportedImageMime;
  readonly fileName: string | undefined;
  readonly index: number;
}): UploadChatImageAttachment => {
  const { buffer, mime, fileName, index } = params;
  const trimmed = (fileName ?? "").trim();
  const name =
    trimmed.length > 0 && trimmed.length <= 255 ? trimmed : `image-${index}.${EXT_BY_MIME[mime]}`;
  return {
    type: "image",
    name,
    mimeType: mime,
    sizeBytes: buffer.byteLength,
    dataUrl: `data:${mime};base64,${buffer.toString("base64")}`,
  };
};

/** The gateway capability {@link prepareInboundImages} needs. */
export interface ImageDownloader {
  readonly downloadImage: (
    messageId: string,
    fileKey: string,
  ) => Effect.Effect<Buffer, LarkGatewayError>;
}

/** Outcome of preparing a message's image attachments. */
export interface PreparedInboundImages {
  /**
   * The message with each successfully-encoded image attachment carrying its
   * `uploaded` payload; every other field is byte-identical to the input.
   */
  readonly message: InboundMessage;
  /** How many image attachments were dropped (unsupported / oversized / download failure). */
  readonly skipped: number;
}

/**
 * Download + encode a message's image attachments at inbound time.
 *
 * Each image is downloaded (paired with its owning `message.messageId`),
 * magic-byte sniffed, byte-capped, then encoded onto the attachment as
 * `uploaded`. Any image that fails a step is dropped and counted (the caller
 * sends ONE merged notice rather than spamming per image); a download failure
 * is caught in-domain (never crashes the fiber). A message with no attachments
 * short-circuits unchanged, so a pure-text message costs nothing.
 */
export const prepareInboundImages = (
  deps: ImageDownloader,
  message: InboundMessage,
): Effect.Effect<PreparedInboundImages> =>
  Effect.gen(function* () {
    if (message.attachments.length === 0) {
      return { message, skipped: 0 };
    }
    let skipped = 0;
    const prepared: InboundAttachment[] = [];
    for (const [index, att] of message.attachments.entries()) {
      const buffer = yield* deps.downloadImage(message.messageId, att.fileKey).pipe(
        Effect.tapError((error) =>
          Console.warn(
            `[feishu-bot] image download failed (fileKey=${att.fileKey}): ${error.message}`,
          ),
        ),
        Effect.orElseSucceed(() => null),
      );
      if (buffer === null) {
        skipped += 1;
        continue;
      }
      const mime = sniffImageMime(buffer);
      if (mime === null) {
        skipped += 1;
        yield* Console.warn(
          `[feishu-bot] dropping unsupported image (fileKey=${att.fileKey}); not png/jpeg/gif/webp.`,
        );
        continue;
      }
      if (buffer.byteLength <= 0 || buffer.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
        skipped += 1;
        yield* Console.warn(
          `[feishu-bot] dropping oversized image (fileKey=${att.fileKey}, ${buffer.byteLength} bytes).`,
        );
        continue;
      }
      const uploaded = encodeImageAttachment({ buffer, mime, fileName: att.fileName, index });
      prepared.push({ ...att, uploaded });
    }
    return { message: { ...message, attachments: prepared }, skipped };
  });

/**
 * Collect every encoded upload payload across a merged dispatch's source
 * messages, in source order (message-rain order, then within-message order).
 * Pure. Used by `turnRunner.buildTurnStart` to fill `message.attachments` and to
 * decide the >8 truncation notice — so the merge/queue path itself stays a pure
 * carrier and `MergedDispatch` gains no field.
 */
export const collectUploadedAttachments = (
  sources: ReadonlyArray<QueuedMessage>,
): ReadonlyArray<UploadChatImageAttachment> =>
  sources
    .flatMap((source) => source.message.attachments)
    .flatMap((attachment) => (attachment.uploaded !== undefined ? [attachment.uploaded] : []));
