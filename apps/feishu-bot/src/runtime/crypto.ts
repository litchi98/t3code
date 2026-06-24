import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * `Crypto.Crypto` backed by the Node global Web Crypto implementation.
 *
 * Node 24 ships a spec-compliant `globalThis.crypto`, so we can mirror the web
 * client's `browserCryptoLayer` verbatim — `getRandomValues` for entropy and
 * `subtle.digest` for hashing. This service feeds both the DPoP signer skeleton
 * and the orchestration command helpers (`Crypto.randomUUIDv4`).
 */
export const cryptoLayer: Layer.Layer<Crypto.Crypto> = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
    digest: (algorithm, data) =>
      Effect.promise(async () => {
        const input = new Uint8Array(data.length);
        input.set(data);
        return new Uint8Array(await globalThis.crypto.subtle.digest(algorithm, input.buffer));
      }),
  }),
);
