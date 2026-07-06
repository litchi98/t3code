/**
 * Workspace dispatch gate extracted from bot.ts.
 *
 * Resolves selected workspaces against the live shell cache and keeps the
 * per-chat authorization gate explicit.
 */
import type { FeishuChatConfig, OrchestrationProjectShell, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import { effectiveChatConfig } from "./chatConfig.ts";
import type { ShellSnapshotCache } from "./shellCache.ts";
import type { WorkspaceState } from "./workspaceState.ts";
import { isWorkspaceAuthorized } from "./authz.ts";
import type { InboundMessage } from "../lark/types.ts";

/** Dependencies for constructing the workspace gate. */
export interface WorkspaceGateDeps {
  readonly workspace: WorkspaceState["Service"];
  readonly shellCache: ShellSnapshotCache;
  /** owned by the resident outer loop; read-only here; never cache a snapshot */
  readonly ownerRef: Ref.Ref<string | null>;
  /** owned by the resident outer loop; read-only here; never cache a snapshot */
  readonly chatConfigsRef: Ref.Ref<{ readonly [chatId: string]: FeishuChatConfig }>;
  /** owned by the resident outer loop; read-only here; never cache a snapshot */
  readonly chatDefaultsRef: Ref.Ref<FeishuChatConfig>;
}

// ── M-1: per-chat selected workspace resolution ──────────────────────────
//
// The three-way status of a conversation's `/workspace` selection, resolved
// against the *current* shell snapshot at the moment of use (so a project
// deleted after selection is caught at dispatch time, not trusted forever):
//   - "none":        the chat never selected a workspace.
//   - "unavailable": a selection exists but its project is not in the
//     current snapshot (deleted elsewhere, or the snapshot has not been
//     seeded yet). The selection is intentionally KEPT (not auto-cleared):
//     the snapshot can be transiently stale around reconnects, and a
//     `/workspace` re-select overwrites it anyway.
//   - "ok":          the selection names a live project (carried along).
export type SelectedWorkspace =
  | { readonly kind: "none" }
  | { readonly kind: "unavailable"; readonly projectId: ProjectId }
  | { readonly kind: "ok"; readonly project: OrchestrationProjectShell };

/** Handle returned by {@link makeWorkspaceGate}. */
export interface WorkspaceGateHandle {
  readonly selectedWorkspaceFor: (chatKey: string) => Effect.Effect<SelectedWorkspace>;
  readonly workspaceGateText: (selected: SelectedWorkspace) => string;
  readonly workspaceRevokedText: string;
  readonly senderMayUseProjectAtDispatch: (
    message: InboundMessage,
    projectId: ProjectId,
  ) => Effect.Effect<boolean>;
}

/** Construct workspace selection and authorization helpers. */
export const makeWorkspaceGate = (deps: WorkspaceGateDeps): WorkspaceGateHandle => {
  const { workspace, shellCache, ownerRef, chatConfigsRef, chatDefaultsRef } = deps;

  const selectedWorkspaceFor = (chatKey: string): Effect.Effect<SelectedWorkspace> =>
    Effect.gen(function* () {
      const projectId = yield* workspace.get(chatKey);
      if (projectId === null) {
        return { kind: "none" } satisfies SelectedWorkspace;
      }
      const snapshot = yield* shellCache.current;
      const project = snapshot?.projects.find((candidate) => candidate.id === projectId);
      return project === undefined
        ? ({ kind: "unavailable", projectId } satisfies SelectedWorkspace)
        : ({ kind: "ok", project } satisfies SelectedWorkspace);
    });

  // User-facing gate text for a not-"ok" selection (the workspace gate and
  // the `ensureThread` dispatch-time re-check share this wording).
  const workspaceGateText = (selected: SelectedWorkspace): string =>
    selected.kind === "none"
      ? "请先用 /workspace 选择工作区(发送 /workspace 查看可选项)。"
      : "当前选中的工作区已不可用(项目可能已被删除或服务器尚未同步),请用 /workspace 重新选择。";

  // M-3: a live "ok" selection that a per-chat config change has since NARROWED
  // out of the chat's authorized set. Distinct wording from the none/unavailable
  // gate text so the user re-selects rather than thinking the project vanished.
  const workspaceRevokedText =
    "当前选中的工作区已不在本群授权范围,请用 /workspace 重新选择授权内的工作区。";

  // M-3 dispatch-time workspace authorization: whether `message`'s sender may
  // use `projectId` in this chat right now (owner exempt; `undefined` allowlist
  // = all authorized). Mirrors the approval gate's owner + effectiveChatConfig
  // resolve on the bare chatId.
  const senderMayUseProjectAtDispatch = (
    message: InboundMessage,
    projectId: ProjectId,
  ): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      const owner = yield* Ref.get(ownerRef);
      const config = effectiveChatConfig(
        message.chatId,
        yield* Ref.get(chatConfigsRef),
        yield* Ref.get(chatDefaultsRef),
      );
      return isWorkspaceAuthorized({
        owner,
        sender: message.senderId,
        projectId,
        authorized: config.workspaces,
      });
    });

  return {
    selectedWorkspaceFor,
    workspaceGateText,
    workspaceRevokedText,
    senderMayUseProjectAtDispatch,
  } as const;
};
