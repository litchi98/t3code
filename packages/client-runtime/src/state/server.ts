import {
  type EnvironmentId,
  type FeishuBindingStreamEvent,
  type ServerConfig,
  type ServerConfigStreamEvent,
  type ServerLifecycleWelcomePayload,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export interface ServerConfigProjection {
  readonly config: ServerConfig;
  readonly latestEvent: ServerConfigStreamEvent;
}

export function applyServerConfigProjection(
  current: Option.Option<ServerConfigProjection>,
  event: ServerConfigStreamEvent,
): Option.Option<ServerConfigProjection> {
  switch (event.type) {
    case "snapshot":
      return Option.some({
        config: event.config,
        latestEvent: event,
      });
    case "keybindingsUpdated":
      return Option.map(current, (projection) => ({
        config: {
          ...projection.config,
          keybindings: event.payload.keybindings,
          issues: event.payload.issues,
        },
        latestEvent: event,
      }));
    case "providerStatuses":
      return Option.map(current, (projection) => ({
        config: {
          ...projection.config,
          providers: event.payload.providers,
        },
        latestEvent: event,
      }));
    case "settingsUpdated":
      return Option.map(current, (projection) => ({
        config: {
          ...projection.config,
          settings: event.payload.settings,
        },
        latestEvent: event,
      }));
  }
}

export function projectServerConfig(
  current: Option.Option<ServerConfigProjection>,
  event: ServerConfigStreamEvent,
): readonly [Option.Option<ServerConfigProjection>, ReadonlyArray<ServerConfigProjection>] {
  const next = applyServerConfigProjection(current, event);
  return [next, Option.toArray(next)];
}

export function projectServerWelcome(
  current: Option.Option<ServerLifecycleWelcomePayload>,
  event: {
    readonly type: "welcome" | "ready";
    readonly payload: unknown;
  },
): readonly [
  Option.Option<ServerLifecycleWelcomePayload>,
  ReadonlyArray<ServerLifecycleWelcomePayload>,
] {
  if (event.type !== "welcome") {
    return [current, []];
  }
  const welcome = event.payload as ServerLifecycleWelcomePayload;
  return [Option.some(welcome), [welcome]];
}

/**
 * Accumulated view of the Feishu bot-binding device-code stream.
 *
 * The stream emits a single `qr` event, then a run of `status` polling events,
 * then a terminal `bound`/`error` event. Because the subscription atom only
 * retains the *latest* stream value, the QR url would vanish the instant the
 * first `status` event arrives — so we scan the stream into this sticky
 * projection (matching the config/terminal projection idiom). The dialog reads
 * `qr` for the code, `status` for polling feedback, and `bound`/`error` for the
 * terminal outcome. No `appSecret` is present anywhere in the stream.
 */
export interface FeishuBindingProjection {
  readonly qr: Extract<FeishuBindingStreamEvent, { type: "qr" }>["payload"] | null;
  readonly status: Extract<FeishuBindingStreamEvent, { type: "status" }>["payload"] | null;
  readonly bound: Extract<FeishuBindingStreamEvent, { type: "bound" }>["payload"] | null;
  readonly error: Extract<FeishuBindingStreamEvent, { type: "error" }>["payload"] | null;
}

export const EMPTY_FEISHU_BINDING_PROJECTION: FeishuBindingProjection = {
  qr: null,
  status: null,
  bound: null,
  error: null,
};

export function applyFeishuBindingStreamEvent(
  state: FeishuBindingProjection,
  event: FeishuBindingStreamEvent,
): FeishuBindingProjection {
  switch (event.type) {
    case "qr":
      return { ...state, qr: event.payload };
    case "status":
      return { ...state, status: event.payload };
    case "bound":
      return { ...state, bound: event.payload, error: null };
    case "error":
      return { ...state, error: event.payload };
  }
}

export function createServerEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  options: {
    readonly initialConfigValueAtom: (
      environmentId: EnvironmentId,
    ) => Atom.Atom<ServerConfig | null>;
  },
) {
  const configScheduler = createAtomCommandScheduler();
  const configConcurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  };
  const configProjection = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:server:config-projection",
    tag: WS_METHODS.subscribeServerConfig,
    transform: (stream) =>
      stream.pipe(Stream.mapAccum(Option.none<ServerConfigProjection>, projectServerConfig)),
  });
  const emptyConfigAtom = Atom.make<ServerConfig | null>(null).pipe(
    Atom.withLabel("environment-data:server:config:empty"),
  );
  const configValueAtom = Atom.family((environmentId: EnvironmentId | null) => {
    if (environmentId === null) {
      return emptyConfigAtom;
    }
    return Atom.make((get): ServerConfig | null => {
      const projection = Option.getOrNull(
        AsyncResult.value(get(configProjection({ environmentId, input: {} }))),
      );
      return projection?.config ?? get(options.initialConfigValueAtom(environmentId));
    }).pipe(Atom.withLabel(`environment-data:server:config:${environmentId}`));
  });
  const settingsValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => get(configValueAtom(environmentId))?.settings ?? null).pipe(
      Atom.withLabel(`environment-data:server:settings:${environmentId}`),
    ),
  );
  const providersValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => get(configValueAtom(environmentId))?.providers ?? null).pipe(
      Atom.withLabel(`environment-data:server:providers:${environmentId}`),
    ),
  );

  return {
    configValueAtom,
    settingsValueAtom,
    providersValueAtom,
    traceDiagnostics: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:trace-diagnostics",
      tag: WS_METHODS.serverGetTraceDiagnostics,
    }),
    processDiagnostics: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:process-diagnostics",
      tag: WS_METHODS.serverGetProcessDiagnostics,
    }),
    processResourceHistory: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:process-resource-history",
      tag: WS_METHODS.serverGetProcessResourceHistory,
    }),
    configProjection,
    welcome: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:server:welcome",
      tag: WS_METHODS.subscribeServerLifecycle,
      transform: (stream) =>
        stream.pipe(
          Stream.mapAccum(Option.none<ServerLifecycleWelcomePayload>, projectServerWelcome),
        ),
    }),
    refreshProviders: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:refresh-providers",
      tag: WS_METHODS.serverRefreshProviders,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId }) => environmentId,
      },
    }),
    updateProvider: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:update-provider",
      tag: WS_METHODS.serverUpdateProvider,
      scheduler: configScheduler,
      concurrency: configConcurrency,
    }),
    upsertKeybinding: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:upsert-keybinding",
      tag: WS_METHODS.serverUpsertKeybinding,
      scheduler: configScheduler,
      concurrency: configConcurrency,
    }),
    removeKeybinding: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:remove-keybinding",
      tag: WS_METHODS.serverRemoveKeybinding,
      scheduler: configScheduler,
      concurrency: configConcurrency,
    }),
    updateSettings: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:update-settings",
      tag: WS_METHODS.serverUpdateSettings,
      scheduler: configScheduler,
      concurrency: configConcurrency,
    }),
    // Feishu bot binding: the QR-scan provisioning stream (driven only while the
    // web binding dialog is open) and the unbind command. The stream carries no
    // `appSecret` — only public binding identity in its `bound` event. The stream
    // is scanned into a sticky projection so the QR url survives later `status`
    // events (see FeishuBindingProjection).
    feishuStartBinding: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:server:feishu-start-binding",
      tag: WS_METHODS.feishuStartBinding,
      // No idle grace: when the binding dialog closes (last subscriber leaves)
      // the atom is disposed immediately, closing the stream scope so the
      // server aborts the in-flight registerApp device-code polling at once
      // instead of leaking it for the default 5-minute idle window.
      idleTtlMs: 0,
      transform: (stream) =>
        stream.pipe(Stream.scan(EMPTY_FEISHU_BINDING_PROJECTION, applyFeishuBindingStreamEvent)),
    }),
    feishuClearBinding: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:feishu-clear-binding",
      tag: WS_METHODS.feishuClearBinding,
    }),
    signalProcess: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:signal-process",
      tag: WS_METHODS.serverSignalProcess,
    }),
  };
}
