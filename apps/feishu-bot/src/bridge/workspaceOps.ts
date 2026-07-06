/**
 * Workspace command backends extracted from bot.ts.
 *
 * These helpers intentionally keep their bare registry dispatch behavior for
 * typed workspace-command error handling.
 */
import { createProject } from "@t3tools/client-runtime/operations";
import {
  type EnvironmentId,
  type OrchestrationProjectShell,
  ProjectId,
  WS_METHODS,
} from "@t3tools/contracts";
import type { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import * as EnvironmentRpc from "@t3tools/client-runtime/rpc";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import { makeBrandedId } from "./envAccess.ts";
import type { ShellSnapshotCache } from "./shellCache.ts";
import { WorkspaceCommandError } from "./commands/handlers.ts";

/** Dependencies for constructing workspace command backends. */
export interface WorkspaceOpsDeps {
  readonly registry: EnvironmentRegistry["Service"];
  readonly environmentId: EnvironmentId;
  readonly crypto: Crypto.Crypto;
  readonly shellCache: ShellSnapshotCache;
}

/** Handle returned by {@link makeWorkspaceOps}. */
export interface WorkspaceOpsHandle {
  readonly createWorkspaceProject: (
    workspaceRoot: string,
  ) => Effect.Effect<OrchestrationProjectShell, WorkspaceCommandError>;
  readonly cloneWorkspaceRepository: (
    remoteUrl: string,
    destinationPath: string,
  ) => Effect.Effect<string, WorkspaceCommandError>;
}

/** Construct workspace command backends for one bound Feishu session. */
export const makeWorkspaceOps = (deps: WorkspaceOpsDeps): WorkspaceOpsHandle => {
  const { registry, environmentId, crypto, shellCache } = deps;

  // Branded-id generator with `Crypto` already provided → fully total effect.
  const genId = <A>(brand: { readonly make: (value: string) => A }): Effect.Effect<A> =>
    makeBrandedId(brand).pipe(Effect.provideService(Crypto.Crypto, crypto));

  // Best-effort human-readable description of a typed RPC/registry failure,
  // for the user-facing WorkspaceCommandError messages below.
  const describeError = (error: unknown): string =>
    error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null && "message" in error
        ? String((error as { message: unknown }).message)
        : String(error);

  // After a `createProject` dispatch, wait for the project to surface in the
  // shell snapshot (the projection round-trip is normally instant; 10s is the
  // generous bound). `null` on timeout — the caller reports it rather than
  // guessing at a shell it cannot see.
  const AWAIT_PROJECT_TRIES = 40;
  const AWAIT_PROJECT_INTERVAL = Duration.millis(250);
  const awaitProjectVisible = (
    projectId: ProjectId,
  ): Effect.Effect<OrchestrationProjectShell | null> =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < AWAIT_PROJECT_TRIES; attempt += 1) {
        const snapshot = yield* shellCache.current;
        const found = snapshot?.projects.find((project) => project.id === projectId);
        if (found !== undefined) {
          return found;
        }
        yield* Effect.sleep(AWAIT_PROJECT_INTERVAL);
      }
      return null;
    });

  // `/workspace add <local path>` backend: dispatch `createProject`
  // (creating the directory when missing — the M0 escape-hatch template) and
  // resolve once the shell snapshot carries the new project.
  const createWorkspaceProject = (
    workspaceRoot: string,
  ): Effect.Effect<OrchestrationProjectShell, WorkspaceCommandError> =>
    Effect.gen(function* () {
      const projectId = yield* genId(ProjectId);
      const title = workspaceRoot.replace(/\/+$/, "").split("/").pop() ?? "workspace";
      yield* registry
        .run(
          environmentId,
          createProject({
            projectId,
            title: title.length > 0 ? title : "workspace",
            workspaceRoot,
            createWorkspaceRootIfMissing: true,
          }),
        )
        .pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.mapError(
            (error) =>
              new WorkspaceCommandError({ message: `创建工作区失败: ${describeError(error)}` }),
          ),
        );
      const visible = yield* awaitProjectVisible(projectId);
      if (visible === null) {
        return yield* new WorkspaceCommandError({
          message: "工作区创建已提交,但尚未出现在项目列表;稍后发送 /workspace 查看并切换。",
        });
      }
      return visible;
    });

  // `/workspace add <git url>` backend: server-side clone via the
  // `sourceControl.cloneRepository` RPC (the server expands `~`/relative
  // destination paths against its own filesystem), returning the checkout cwd.
  const cloneWorkspaceRepository = (
    remoteUrl: string,
    destinationPath: string,
  ): Effect.Effect<string, WorkspaceCommandError> =>
    registry
      .run(
        environmentId,
        EnvironmentRpc.request(WS_METHODS.sourceControlCloneRepository, {
          remoteUrl,
          destinationPath,
        }),
      )
      .pipe(
        Effect.map((result) => result.cwd),
        Effect.mapError(
          (error) => new WorkspaceCommandError({ message: `克隆失败: ${describeError(error)}` }),
        ),
      );

  return { createWorkspaceProject, cloneWorkspaceRepository } as const;
};
