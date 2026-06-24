import {
  ClientPresentation,
  CloudSession,
  PlatformConnectionSource,
  PrimaryEnvironmentAuth,
  RelayDeviceIdentity,
  SshEnvironmentGateway,
} from "@t3tools/client-runtime/platform";
import {
  ConnectionBlockedError,
  Connectivity,
  PrimaryConnectionRegistration,
  type PrimaryConnectionTarget,
  Wakeups,
} from "@t3tools/client-runtime/connection";
import { AuthStandardClientScopes } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { connectionStorageLayer } from "./persistence.ts";

/**
 * Inputs the platform layer needs once the bearer session and environment
 * descriptor have been resolved at startup.
 */
export interface FeishuBotPlatformInput {
  /** Resolved primary connection target (environment id + endpoints). */
  readonly target: PrimaryConnectionTarget;
  /** Bearer access token (30-day) obtained via the pairing exchange. */
  readonly accessToken: string;
}

/**
 * Connectivity is hard-wired to "online" for a headless bot — there is no
 * OS-level network observer to subscribe to, and the supervisor only needs a
 * truthy status to attempt the connection.
 */
const connectivityLayer = Connectivity.layer({
  status: Effect.succeed("online"),
  changes: Stream.empty,
});

/**
 * The bot never needs to be "woken up": it runs a single turn and exits, so the
 * wakeup change stream is empty.
 */
const wakeupsLayer = Wakeups.layer({
  changes: Stream.empty,
});

/**
 * Cloud/relay/SSH capabilities are all unsupported for the headless bot. They
 * are provided as stubs that fail with `unsupported` because the M0 path only
 * uses the primary bearer connection — but the services must still exist for the
 * connection layer to construct (`ConnectionResolver` yields them eagerly).
 */
function capabilitiesLayer(input: FeishuBotPlatformInput) {
  return Layer.succeedContext(
    Context.make(
      CloudSession,
      CloudSession.of({
        clerkToken: Effect.fail(
          new ConnectionBlockedError({
            reason: "unsupported",
            detail: "T3 Cloud sign-in is not available in the headless feishu-bot.",
          }),
        ),
      }),
    ).pipe(
      Context.add(
        PrimaryEnvironmentAuth,
        PrimaryEnvironmentAuth.of({
          bearerToken: Effect.succeed(Option.some(input.accessToken)),
        }),
      ),
      Context.add(
        RelayDeviceIdentity,
        RelayDeviceIdentity.of({
          deviceId: Effect.succeed(Option.none()),
        }),
      ),
      Context.add(
        ClientPresentation,
        ClientPresentation.of({
          metadata: {
            label: "feishu-bot",
            deviceType: "bot",
          },
          scopes: AuthStandardClientScopes,
        }),
      ),
      Context.add(
        SshEnvironmentGateway,
        SshEnvironmentGateway.of({
          provision: () =>
            Effect.fail(
              new ConnectionBlockedError({
                reason: "unsupported",
                detail: "SSH environments are not available in the headless feishu-bot.",
              }),
            ),
          prepare: () =>
            Effect.fail(
              new ConnectionBlockedError({
                reason: "unsupported",
                detail: "SSH environments are not available in the headless feishu-bot.",
              }),
            ),
          disconnect: () => Effect.void,
        }),
      ),
    ),
  );
}

/**
 * The single registration the bot exposes to the connection registry: the
 * resolved primary target. The registry forks `runForEach(registerPlatform)`
 * over this stream, so emitting one element is enough to register and connect.
 */
function platformConnectionSourceLayer(input: FeishuBotPlatformInput) {
  return Layer.succeed(
    PlatformConnectionSource,
    PlatformConnectionSource.of({
      registrations: Stream.make(
        new PrimaryConnectionRegistration({
          target: input.target,
        }),
      ),
    }),
  );
}

type ConnectionPlatformLayerSource =
  | typeof connectionStorageLayer
  | typeof connectivityLayer
  | typeof wakeupsLayer
  | ReturnType<typeof capabilitiesLayer>
  | ReturnType<typeof platformConnectionSourceLayer>;

/**
 * Compose the full platform service layer for the headless bot. Mirrors
 * `apps/mobile/src/connection/platform.ts`, swapping the real device
 * capabilities for headless stubs and an in-memory store.
 */
export function connectionPlatformLayer(
  input: FeishuBotPlatformInput,
): Layer.Layer<
  Layer.Success<ConnectionPlatformLayerSource>,
  Layer.Error<ConnectionPlatformLayerSource>,
  Layer.Services<ConnectionPlatformLayerSource>
> {
  return Layer.mergeAll(
    connectionStorageLayer,
    connectivityLayer,
    wakeupsLayer,
    capabilitiesLayer(input),
    platformConnectionSourceLayer(input),
  );
}
