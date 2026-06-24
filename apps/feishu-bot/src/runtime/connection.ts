import { Connection } from "@t3tools/client-runtime/connection";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import { remoteHttpClientLayer } from "@t3tools/client-runtime/rpc";
import { RelayWebClientId } from "@t3tools/contracts/relay";
import * as Layer from "effect/Layer";
import * as Socket from "effect/unstable/socket/Socket";

import { cryptoLayer } from "./crypto.ts";
import { relayDpopSignerLayer } from "./dpop.ts";
import { connectionPlatformLayer, type FeishuBotPlatformInput } from "./platform.ts";

/**
 * Low-level runtime services every connection needs, regardless of platform:
 *
 * - `HttpClient` (built from the Node global `fetch`) for the auth/descriptor
 *   HTTP calls and the websocket-ticket exchange the runtime performs.
 * - `WebSocketConstructor` from `globalThis.WebSocket` (native in Node 24) for
 *   the RPC socket session.
 * - `Crypto.Crypto` for command id / DPoP proof generation.
 * - A relay client + DPoP signer. The bot never uses the relay path, but
 *   `ConnectionResolver.make` and `RemoteEnvironmentAuthorization.make` both
 *   yield these services while constructing the connection layer, so they must
 *   be present. Passing `relayUrl: ""` yields a disabled relay client whose
 *   methods are never invoked.
 */
const httpClientLayer = remoteHttpClientLayer(globalThis.fetch);

const managedRelayClientLayer = ManagedRelay.layer({
  relayUrl: "",
  clientId: RelayWebClientId,
}).pipe(Layer.provideMerge(relayDpopSignerLayer));

/**
 * Low-level services merged together. `cryptoLayer` and `httpClientLayer` are
 * `provideMerge`d (not plain `merge`d) so they both satisfy the relay client's
 * dependencies *and* remain visible to downstream layers — `Layer.mergeAll`
 * builds in parallel and would not wire intra-call dependencies.
 */
const runtimeServicesLayer = Layer.mergeAll(
  Socket.layerWebSocketConstructorGlobal,
  managedRelayClientLayer,
).pipe(Layer.provideMerge(Layer.merge(cryptoLayer, httpClientLayer)));

/**
 * Build the complete connection layer for a resolved primary environment. The
 * resulting layer provides `EnvironmentRegistry` (and the rest of the connection
 * services), already started and registered with the bot's single target.
 */
export function connectionLayer(input: FeishuBotPlatformInput) {
  const platformLayer = connectionPlatformLayer(input).pipe(
    Layer.provideMerge(runtimeServicesLayer),
  );
  return Connection.layer.pipe(Layer.provideMerge(platformLayer));
}
