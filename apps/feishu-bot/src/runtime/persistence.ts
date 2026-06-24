import {
  ConnectionRegistrationStore,
  ConnectionTargetStore,
  EnvironmentCacheStore,
} from "@t3tools/client-runtime/platform";
import { TokenStore } from "@t3tools/client-runtime/authorization";
import { CredentialStore, ProfileStore } from "@t3tools/client-runtime/connection";
import type { ConnectionCredential, ConnectionProfile } from "@t3tools/client-runtime/connection";
import type {
  EnvironmentId,
  OrchestrationShellSnapshot,
  OrchestrationThread,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

/**
 * Entirely in-memory implementations of the connection persistence services.
 *
 * M0 has no durable storage requirement, so every store is a `Map` (or a
 * trivial empty/no-op effect). Persistence (SQLite/file) is deferred to a later
 * milestone. The shapes here mirror `apps/mobile/src/connection/storage.ts`,
 * minus the on-disk catalog machinery, and are all built once inside a single
 * `Layer.effectContext` so the backing maps are shared across the yielded
 * services.
 */
export const connectionStorageLayer: Layer.Layer<
  | ConnectionTargetStore
  | ConnectionRegistrationStore
  | ProfileStore.ConnectionProfileStore
  | CredentialStore.ConnectionCredentialStore
  | TokenStore.RemoteDpopAccessTokenStore
  | EnvironmentCacheStore
> = Layer.effectContext(
  Effect.sync(() => {
    const profileMap = new Map<string, ConnectionProfile>();
    const credentialMap = new Map<string, ConnectionCredential>();
    const remoteTokenMap = new Map<EnvironmentId, TokenStore.RemoteDpopAccessToken>();
    const shellMap = new Map<EnvironmentId, OrchestrationShellSnapshot>();
    const threadMap = new Map<string, OrchestrationThread>();

    const threadKey = (environmentId: EnvironmentId, threadId: ThreadId) =>
      `${environmentId}::${threadId}`;

    const targetStore = ConnectionTargetStore.of({
      list: Effect.succeed([]),
    });

    const registrationStore = ConnectionRegistrationStore.of({
      register: () => Effect.void,
      remove: () => Effect.void,
    });

    const profileStore = ProfileStore.make({
      get: (connectionId) =>
        Effect.sync(() => Option.fromUndefinedOr(profileMap.get(connectionId))),
      put: (profile) =>
        Effect.sync(() => {
          profileMap.set(profile.connectionId, profile);
        }),
      remove: (connectionId) =>
        Effect.sync(() => {
          profileMap.delete(connectionId);
        }),
    });

    const credentialStore = CredentialStore.make({
      get: (connectionId) =>
        Effect.sync(() => Option.fromUndefinedOr(credentialMap.get(connectionId))),
      put: (connectionId, credential) =>
        Effect.sync(() => {
          credentialMap.set(connectionId, credential);
        }),
      remove: (connectionId) =>
        Effect.sync(() => {
          credentialMap.delete(connectionId);
        }),
    });

    const remoteTokenStore = TokenStore.make({
      get: (environmentId) =>
        Effect.sync(() => Option.fromUndefinedOr(remoteTokenMap.get(environmentId))),
      put: (token) =>
        Effect.sync(() => {
          remoteTokenMap.set(token.environmentId, token);
        }),
      remove: (environmentId) =>
        Effect.sync(() => {
          remoteTokenMap.delete(environmentId);
        }),
    });

    const cacheStore = EnvironmentCacheStore.of({
      loadShell: (environmentId) =>
        Effect.sync(() => Option.fromUndefinedOr(shellMap.get(environmentId))),
      saveShell: (environmentId, snapshot) =>
        Effect.sync(() => {
          shellMap.set(environmentId, snapshot);
        }),
      loadThread: (environmentId, threadId) =>
        Effect.sync(() =>
          Option.fromUndefinedOr(threadMap.get(threadKey(environmentId, threadId))),
        ),
      saveThread: (environmentId, thread) =>
        Effect.sync(() => {
          threadMap.set(threadKey(environmentId, thread.id), thread);
        }),
      removeThread: (environmentId, threadId) =>
        Effect.sync(() => {
          threadMap.delete(threadKey(environmentId, threadId));
        }),
      clear: (environmentId) =>
        Effect.sync(() => {
          shellMap.delete(environmentId);
          const prefix = `${environmentId}::`;
          // Deleting during Map iteration is well-defined; entries removed after
          // the current position are simply not visited.
          for (const key of threadMap.keys()) {
            if (key.startsWith(prefix)) {
              threadMap.delete(key);
            }
          }
        }),
    });

    return Context.make(ConnectionTargetStore, targetStore).pipe(
      Context.add(ConnectionRegistrationStore, registrationStore),
      Context.add(ProfileStore.ConnectionProfileStore, profileStore),
      Context.add(CredentialStore.ConnectionCredentialStore, credentialStore),
      Context.add(TokenStore.RemoteDpopAccessTokenStore, remoteTokenStore),
      Context.add(EnvironmentCacheStore, cacheStore),
    );
  }),
);
