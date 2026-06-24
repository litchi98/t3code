import { p256 } from "@noble/curves/nist";
import {
  computeDpopAccessTokenHash,
  computeDpopJwkThumbprint,
  type DpopPublicJwk,
  normalizeDpopHtu,
} from "@t3tools/shared/dpop";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";

/**
 * In-memory DPoP signer for the headless bot.
 *
 * M0 connects to the primary environment with a bearer access token, so the
 * relay/DPoP code path is never exercised at runtime — but `ConnectionResolver`
 * and `RemoteEnvironmentAuthorization` both eagerly `yield* ManagedRelayDpopSigner`
 * while building the connection layer, so the service must still be provided and
 * must construct successfully. We mirror the mobile signer (noble P-256) but keep
 * the key purely in memory (no SecureStore / IndexedDB persistence) since the bot
 * is ephemeral. The proof logic is real so the path is correct if ever used.
 */

class FeishuBotDpopError extends Data.TaggedError("FeishuBotDpopError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

interface DpopProofKeyPair {
  readonly privateKey: Uint8Array;
  readonly publicJwk: DpopPublicJwk;
  readonly thumbprint: string;
}

function dpopError(message: string) {
  return (cause: unknown) => new FeishuBotDpopError({ message, cause });
}

function publicJwkFromUncompressedPublicKey(publicKey: Uint8Array): DpopPublicJwk {
  if (publicKey.length !== 65 || publicKey[0] !== 0x04) {
    throw new Error("Generated DPoP public key is not an uncompressed P-256 point.");
  }
  return {
    kty: "EC",
    crv: "P-256",
    x: Encoding.encodeBase64Url(publicKey.slice(1, 33)),
    y: Encoding.encodeBase64Url(publicKey.slice(33, 65)),
  };
}

const generateProofKeyPair: Effect.Effect<DpopProofKeyPair, FeishuBotDpopError, Crypto.Crypto> =
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    let privateKey: Uint8Array;
    do {
      privateKey = yield* crypto
        .randomBytes(p256.CURVE.nByteLength)
        .pipe(Effect.mapError(dpopError("Could not generate DPoP key randomness.")));
    } while (!p256.utils.isValidPrivateKey(privateKey));
    const publicJwk = yield* Effect.try({
      try: () => publicJwkFromUncompressedPublicKey(p256.getPublicKey(privateKey, false)),
      catch: dpopError("Generated DPoP public key is invalid."),
    });
    return {
      privateKey,
      publicJwk,
      thumbprint: computeDpopJwkThumbprint(publicJwk),
    };
  });

function encodeJsonBase64Url(value: unknown): string {
  return Encoding.encodeBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function createProof(
  keyPair: DpopProofKeyPair,
  input: ManagedRelay.ManagedRelayDpopProofInput,
): Effect.Effect<string, FeishuBotDpopError, Crypto.Crypto> {
  return Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const htu = normalizeDpopHtu(input.url);
    if (htu === null) {
      return yield* new FeishuBotDpopError({ message: "DPoP URL is invalid." });
    }
    const nowMs = yield* Clock.currentTimeMillis;
    const jti = yield* crypto.randomUUIDv4.pipe(
      Effect.mapError(dpopError("Could not generate DPoP proof identifier.")),
    );
    const header = encodeJsonBase64Url({
      typ: "dpop+jwt",
      alg: "ES256",
      jwk: keyPair.publicJwk,
    });
    const ath =
      input.accessToken === undefined ? null : computeDpopAccessTokenHash(input.accessToken);
    const payload = encodeJsonBase64Url({
      htm: input.method.toUpperCase(),
      htu,
      jti,
      iat: Math.floor(nowMs / 1_000),
      ...(ath === null ? {} : { ath }),
    });
    const signingInput = `${header}.${payload}`;
    const digest = yield* crypto
      .digest("SHA-256", new TextEncoder().encode(signingInput))
      .pipe(Effect.mapError(dpopError("Could not hash DPoP signing input.")));
    const signature = yield* Effect.try({
      try: () => p256.sign(digest, keyPair.privateKey, { prehash: false }).toCompactRawBytes(),
      catch: dpopError("Could not sign DPoP proof."),
    });
    return `${signingInput}.${Encoding.encodeBase64Url(signature)}`;
  });
}

export const relayDpopSignerLayer: Layer.Layer<
  ManagedRelay.ManagedRelayDpopSigner,
  never,
  Crypto.Crypto
> = Layer.effect(
  ManagedRelay.ManagedRelayDpopSigner,
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const loadKey = yield* Effect.cached(
      generateProofKeyPair.pipe(Effect.provideService(Crypto.Crypto, crypto)),
    );
    return ManagedRelay.ManagedRelayDpopSigner.of({
      thumbprint: loadKey.pipe(
        Effect.map((keyPair) => keyPair.thumbprint),
        Effect.mapError(
          (cause) =>
            new ManagedRelay.ManagedRelayDpopKeyLoadError({
              keyStore: "indexed-db",
              cause,
            }),
        ),
      ),
      createProof: Effect.fn("feishuBot.dpopSigner.createProof")(function* (input) {
        const keyPair = yield* loadKey.pipe(
          Effect.mapError(
            (cause) =>
              new ManagedRelay.ManagedRelayDpopProofCreationError({
                method: input.method,
                url: input.url,
                cause,
              }),
          ),
        );
        return yield* createProof(keyPair, input).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.mapError(
            (cause) =>
              new ManagedRelay.ManagedRelayDpopProofCreationError({
                method: input.method,
                url: input.url,
                cause,
              }),
          ),
        );
      }),
    });
  }),
);
