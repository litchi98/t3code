/**
 * Batch A image-attachment pipeline: magic-byte sniff, encode, collect, and the
 * inbound download/cleanse loop (the bot cleanses so a bad image never makes the
 * server reject the whole turn).
 */
import { assert, describe, expect, it } from "@effect/vitest";
import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { LarkGatewayError } from "../lark/index.ts";
import type { InboundAttachment, InboundMessage } from "../lark/types.ts";
import {
  collectUploadedAttachments,
  encodeImageAttachment,
  prepareInboundImages,
  sniffImageMime,
} from "./imageAttachments.ts";
import type { QueuedMessage } from "./types.ts";

// ── magic-byte fixtures ──────────────────────────────────────────────────────
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const GIF = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const WEBP = Buffer.concat([
  Buffer.from([0x52, 0x49, 0x46, 0x46]), // "RIFF"
  Buffer.from([0x1a, 0x00, 0x00, 0x00]), // size (arbitrary)
  Buffer.from([0x57, 0x45, 0x42, 0x50]), // "WEBP"
  Buffer.from([0x56, 0x50, 0x38, 0x20]), // "VP8 "
]);
const NOT_IMAGE = Buffer.from("this is plainly not an image at all");
// RIFF container that is NOT WebP (e.g. a WAV) must not sniff as image/webp.
const RIFF_WAV = Buffer.concat([
  Buffer.from([0x52, 0x49, 0x46, 0x46]),
  Buffer.from([0x24, 0x00, 0x00, 0x00]),
  Buffer.from([0x57, 0x41, 0x56, 0x45]), // "WAVE"
]);

describe("sniffImageMime", () => {
  it("recognises the four Claude-supported types by magic bytes", () => {
    expect(sniffImageMime(PNG)).toBe("image/png");
    expect(sniffImageMime(JPEG)).toBe("image/jpeg");
    expect(sniffImageMime(GIF)).toBe("image/gif");
    expect(sniffImageMime(WEBP)).toBe("image/webp");
  });

  it("returns null for non-image and RIFF-but-not-WEBP content", () => {
    expect(sniffImageMime(NOT_IMAGE)).toBeNull();
    expect(sniffImageMime(RIFF_WAV)).toBeNull();
    expect(sniffImageMime(Buffer.from([]))).toBeNull();
  });

  it("does not over-read a buffer shorter than a signature", () => {
    // "RIFF" alone (no WEBP tag at offset 8) must not be mis-sniffed as webp.
    expect(sniffImageMime(Buffer.from([0x52, 0x49, 0x46, 0x46]))).toBeNull();
    // A 2-byte prefix of the PNG signature must not match.
    expect(sniffImageMime(Buffer.from([0x89, 0x50]))).toBeNull();
  });
});

describe("encodeImageAttachment", () => {
  it("builds a data URL + byte size from the buffer, using a valid file name", () => {
    const encoded = encodeImageAttachment({
      buffer: PNG,
      mime: "image/png",
      fileName: "screenshot.png",
      index: 0,
    });
    assert.deepStrictEqual(encoded, {
      type: "image",
      name: "screenshot.png",
      mimeType: "image/png",
      sizeBytes: PNG.byteLength,
      dataUrl: `data:image/png;base64,${PNG.toString("base64")}`,
    });
  });

  it("trims a padded file name", () => {
    const encoded = encodeImageAttachment({
      buffer: JPEG,
      mime: "image/jpeg",
      fileName: "  photo.jpg  ",
      index: 2,
    });
    expect(encoded.name).toBe("photo.jpg");
  });

  it("falls back to a synthetic name when the file name is missing, blank, or over-long", () => {
    expect(
      encodeImageAttachment({ buffer: GIF, mime: "image/gif", fileName: undefined, index: 3 }).name,
    ).toBe("image-3.gif");
    expect(
      encodeImageAttachment({ buffer: GIF, mime: "image/gif", fileName: "   ", index: 4 }).name,
    ).toBe("image-4.gif");
    const longName = `${"a".repeat(300)}.png`;
    expect(
      encodeImageAttachment({ buffer: PNG, mime: "image/png", fileName: longName, index: 5 }).name,
    ).toBe("image-5.png");
    // jpeg maps to the `jpg` extension in the synthetic name.
    expect(
      encodeImageAttachment({ buffer: JPEG, mime: "image/jpeg", fileName: undefined, index: 1 })
        .name,
    ).toBe("image-1.jpg");
  });
});

// ── message / source helpers ─────────────────────────────────────────────────
const baseMessage = (
  overrides: Partial<InboundMessage> & { readonly attachments: ReadonlyArray<InboundAttachment> },
): InboundMessage => ({
  chatId: "oc_chat",
  chatType: "p2p",
  messageId: "om_msg",
  senderId: "ou_sender",
  text: "",
  createTime: 0,
  ...overrides,
});

const source = (attachments: ReadonlyArray<InboundAttachment>): QueuedMessage => ({
  message: baseMessage({ attachments }),
  commandId: "cmd" as QueuedMessage["commandId"],
});

describe("collectUploadedAttachments", () => {
  it("flattens uploaded payloads across sources in order, dropping un-encoded ones", () => {
    const up = (name: string) => ({
      type: "image" as const,
      name,
      mimeType: "image/png" as const,
      sizeBytes: 1,
      dataUrl: "data:image/png;base64,AA==",
    });
    const sources: ReadonlyArray<QueuedMessage> = [
      source([
        { kind: "image", fileKey: "a", uploaded: up("a") },
        { kind: "image", fileKey: "b" }, // dropped: no uploaded
      ]),
      source([{ kind: "image", fileKey: "c", uploaded: up("c") }]),
    ];
    expect(collectUploadedAttachments(sources).map((u) => u.name)).toEqual(["a", "c"]);
  });

  it("returns an empty array for no sources or no encoded images", () => {
    expect(collectUploadedAttachments([])).toEqual([]);
    expect(collectUploadedAttachments([source([{ kind: "image", fileKey: "x" }])])).toEqual([]);
  });
});

// ── prepareInboundImages: the download + cleanse loop ────────────────────────
/**
 * A mock gateway downloader keyed by fileKey. A key mapped to `null` fails the
 * download (an in-domain `LarkGatewayError`); any other key yields its buffer.
 * Records the (messageId, fileKey) pairs it was called with.
 */
const mockDownloader = (table: Record<string, Buffer | null>) => {
  const calls: Array<{ messageId: string; fileKey: string }> = [];
  return {
    calls,
    downloadImage: (messageId: string, fileKey: string) => {
      calls.push({ messageId, fileKey });
      const buffer = table[fileKey];
      return buffer == null
        ? Effect.fail(
            new LarkGatewayError({ message: `download failed for ${fileKey}`, cause: null }),
          )
        : Effect.succeed(buffer);
    },
  };
};

describe("prepareInboundImages", () => {
  it.effect("short-circuits a message with no attachments (no download)", () =>
    Effect.gen(function* () {
      const dl = mockDownloader({});
      const message = baseMessage({ text: "hello", attachments: [] });
      const result = yield* prepareInboundImages(dl, message);
      assert.strictEqual(result.skipped, 0);
      assert.strictEqual(result.message, message);
      assert.lengthOf(dl.calls, 0);
    }),
  );

  it.effect("encodes a good image, pairing the owning messageId with the fileKey", () =>
    Effect.gen(function* () {
      const dl = mockDownloader({ k1: PNG });
      const message = baseMessage({
        messageId: "om_owner",
        attachments: [{ kind: "image", fileKey: "k1", fileName: "a.png" }],
      });
      const result = yield* prepareInboundImages(dl, message);
      assert.strictEqual(result.skipped, 0);
      assert.deepStrictEqual(dl.calls, [{ messageId: "om_owner", fileKey: "k1" }]);
      assert.strictEqual(result.message.attachments[0]?.uploaded?.mimeType, "image/png");
      assert.strictEqual(result.message.attachments[0]?.uploaded?.name, "a.png");
    }),
  );

  it.effect("drops an unsupported (sniff-null) image and counts it", () =>
    Effect.gen(function* () {
      const dl = mockDownloader({ k1: NOT_IMAGE });
      const result = yield* prepareInboundImages(
        dl,
        baseMessage({ attachments: [{ kind: "image", fileKey: "k1" }] }),
      );
      assert.strictEqual(result.skipped, 1);
      assert.isUndefined(result.message.attachments[0]?.uploaded);
    }),
  );

  it.effect("drops an oversized image (byte cap) and counts it", () =>
    Effect.gen(function* () {
      const big = Buffer.alloc(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1);
      big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0); // valid PNG header
      const dl = mockDownloader({ k1: big });
      const result = yield* prepareInboundImages(
        dl,
        baseMessage({ attachments: [{ kind: "image", fileKey: "k1" }] }),
      );
      assert.strictEqual(result.skipped, 1);
      assert.isUndefined(result.message.attachments[0]?.uploaded);
    }),
  );

  it.effect("drops on download failure without crashing the fiber", () =>
    Effect.gen(function* () {
      const dl = mockDownloader({ k1: null });
      const result = yield* prepareInboundImages(
        dl,
        baseMessage({ attachments: [{ kind: "image", fileKey: "k1" }] }),
      );
      assert.strictEqual(result.skipped, 1);
      assert.isUndefined(result.message.attachments[0]?.uploaded);
    }),
  );

  it.effect("mixes good/bad: encodes the good ones, counts the rest, preserves order", () =>
    Effect.gen(function* () {
      const dl = mockDownloader({ good1: PNG, bad: NOT_IMAGE, fail: null, good2: WEBP });
      const result = yield* prepareInboundImages(
        dl,
        baseMessage({
          attachments: [
            { kind: "image", fileKey: "good1" },
            { kind: "image", fileKey: "bad" },
            { kind: "image", fileKey: "fail" },
            { kind: "image", fileKey: "good2" },
          ],
        }),
      );
      assert.strictEqual(result.skipped, 2);
      const encoded = collectUploadedAttachments([
        { message: result.message, commandId: "c" as QueuedMessage["commandId"] },
      ]);
      assert.deepStrictEqual(
        encoded.map((u) => u.mimeType),
        ["image/png", "image/webp"],
      );
    }),
  );
});
