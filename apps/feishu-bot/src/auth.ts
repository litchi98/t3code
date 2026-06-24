import { bootstrapRemoteBearerSession } from "@t3tools/client-runtime/authorization";
import { fetchRemoteEnvironmentDescriptor } from "@t3tools/client-runtime/environment";
import {
  remoteHttpClientLayer,
  type RemoteEnvironmentRequestError,
} from "@t3tools/client-runtime/rpc";
import { PrimaryConnectionTarget } from "@t3tools/client-runtime/connection";
import { AuthStandardClientScopes } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { FeishuBotConfig } from "./config.ts";

const httpClientLayer = remoteHttpClientLayer(globalThis.fetch);

/**
 * Result of the startup handshake: the bearer access token used for the
 * websocket session plus the resolved primary connection target.
 */
export interface ResolvedEnvironment {
  readonly accessToken: string;
  readonly target: PrimaryConnectionTarget;
}

/**
 * Perform the M0 authentication handshake (Option A):
 *
 * 1. Exchange the one-time pairing credential for a 30-day bearer access token
 *    (`bootstrapRemoteBearerSession`). The runtime later turns this into a
 *    short-lived ws-ticket automatically — we do not touch that flow here.
 * 2. Fetch the environment descriptor (`/.well-known/t3/environment`) to learn
 *    the authoritative `environmentId`. We must not hardcode it because
 *    `authorizeBearer` re-validates the descriptor against this id.
 */
export const resolveEnvironment = (
  config: FeishuBotConfig,
): Effect.Effect<ResolvedEnvironment, RemoteEnvironmentRequestError> =>
  Effect.gen(function* () {
    const access = yield* bootstrapRemoteBearerSession({
      httpBaseUrl: config.httpBaseUrl,
      credential: config.pairingToken,
      scopes: AuthStandardClientScopes,
      clientMetadata: {
        label: "feishu-bot",
        deviceType: "bot",
      },
    });

    const descriptor = yield* fetchRemoteEnvironmentDescriptor({
      httpBaseUrl: config.httpBaseUrl,
    });

    return {
      accessToken: access.access_token,
      target: new PrimaryConnectionTarget({
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        httpBaseUrl: config.httpBaseUrl,
        wsBaseUrl: config.wsBaseUrl,
      }),
    };
  }).pipe(Effect.provide(httpClientLayer));
