import { basename } from "node:path";
import equal from "fast-deep-equal";
import { v4 as uuidv4 } from "uuid";
import type pino from "pino";
import type { SessionEventSubscription } from "@getpaseo/protocol/messages";
import { getErrorMessage, getErrorMessageOr } from "@getpaseo/protocol/error-utils";
import type {
  ProjectPlacementPayload,
  SessionInboundMessage,
  SessionOutboundMessage,
  WorkspaceDescriptorPayload,
} from "../../messages.js";
import type { AgentStorage } from "../../agent/agent-storage.js";
import type { ProjectUpdate } from "../../workspace-reconciliation-service.js";
import type { TerminalWorkspaceContributionChangedEvent } from "../../../terminal/terminal-manager.js";
import type {
  WorkspaceGitRuntimeSnapshot,
  WorkspaceGitService,
} from "../../workspace-git-service.js";
import type { DirectorySyncService } from "../../directory-sync/index.js";
import type { WorkspaceScriptRuntimeStore } from "../../workspace-script-runtime-store.js";
import { CursorError } from "../../pagination/cursor.js";
import {
  checkoutLiteFromGitSnapshot,
  deriveWorkspaceDisplayName,
} from "../../workspace-registry-model.js";
import {
  resolveProjectDisplayName,
  resolveWorkspaceDisplayName,
  resolveWorkspaceName,
  type PersistedProjectRecord,
  type PersistedWorkspaceRecord,
  type ProjectMutation,
  type ProjectRegistry,
  type WorkspaceMutation,
  type WorkspaceRegistry,
} from "../../workspace-registry.js";
import {
  summarizeFetchWorkspacesEntries,
  workspaceIdsOnCheckout,
  type WorkspaceDirectory,
  type WorkspaceUpdatesFilter,
} from "../../workspace-directory.js";
import { shouldEmitPendingBootstrapUpdate } from "../../workspace-bootstrap-dedupe.js";
import { archivePersistedWorkspaceRecord } from "../../workspace-archive-service.js";
import { releaseWorkspaceServicePortPlan } from "../../workspace-service-port-registry.js";
import type { CreatePaseoWorktreeResult } from "../../paseo-worktree-service.js";
import {
  setProjectCustomIcon,
  type ProjectIconReader,
} from "../../../utils/project-custom-icon.js";
import type { OwnedSubscription, SessionDelivery } from "../owned-subscriptions/index.js";
import type { WorkspaceGitObserverService } from "../workspace-git-observer/workspace-git-observer-service.js";
import type { WorkspaceRecoveryService } from "../workspace-recovery/workspace-recovery-service.js";
import { isAppVersionAtLeast } from "../app-version.js";
import { SessionRequestError } from "../session-request-error.js";
import { handleDirectorySuggestionsRequest } from "./directory-suggestions.js";

const MIN_VERSION_EXPLICIT_WORKSPACE_RECOVERY = "0.1.105";

function clientUsesLegacyWorkspaceRestore(appVersion: string | null): boolean {
  return (
    appVersion !== null && !isAppVersionAtLeast(appVersion, MIN_VERSION_EXPLICIT_WORKSPACE_RECOVERY)
  );
}

type FetchWorkspacesRequestMessage = Extract<
  SessionInboundMessage,
  { type: "fetch_workspaces_request" }
>;
type FetchWorkspacesResponsePayload = Extract<
  SessionOutboundMessage,
  { type: "fetch_workspaces_response" }
>["payload"];
type FetchWorkspacesResponseEntry = FetchWorkspacesResponsePayload["entries"][number];
type FetchWorkspacesResponsePageInfo = FetchWorkspacesResponsePayload["pageInfo"];
type FetchWorkspacesRequestFilter = NonNullable<FetchWorkspacesRequestMessage["filter"]>;
type WorkspaceProjectDescriptorPayload = FetchWorkspacesResponsePayload["emptyProjects"][number];
type WorkspaceUpdatePayload = Extract<
  SessionOutboundMessage,
  { type: "workspace_update" }
>["payload"];

interface WorkspaceUpdateOptions {
  removedProjectId?: string;
  optimisticStatus?: WorkspaceDescriptorPayload["status"];
}

interface WorkspaceUpdatesSubscriptionState {
  subscriptionId: string;
  owner: OwnedSubscription;
  syncEnabled?: boolean;
  filter?: WorkspaceUpdatesFilter;
  isBootstrapping: boolean;
  pendingUpdatesByWorkspaceId: Map<string, WorkspaceUpdatePayload>;
  lastEmittedByWorkspaceId: Map<string, WorkspaceUpdatePayload>;
  visibleEmptyProjectIds?: Set<string>;
}

export interface WorkspaceSessionHost {
  emit(msg: SessionOutboundMessage): void;
  wantsEvent(event: SessionEventSubscription): boolean;
  isCleanedUp(): boolean;
  /** Live: the client app version is mutated after construction. */
  getAppVersion(): string | null;
  /** Re-evaluates which registry/agent producers the session needs after subscriptions change. */
  refreshObservationProducers(): void;
  emitProjectUpdate(update: ProjectUpdate): Promise<void>;
  buildProjectPlacementForWorkspace(
    workspace: PersistedWorkspaceRecord,
    projectRecord?: PersistedProjectRecord | null,
  ): Promise<ProjectPlacementPayload>;
  buildWorkspaceScriptPayloadSnapshot(
    workspace: PersistedWorkspaceRecord,
    project: PersistedProjectRecord | null,
  ): WorkspaceDescriptorPayload["scripts"];
  getWorkspaceSetupStatus(
    workspace: PersistedWorkspaceRecord,
  ): WorkspaceDescriptorPayload["setupStatus"];
}

export interface WorkspaceSessionOptions {
  host: WorkspaceSessionHost;
  delivery: Pick<SessionDelivery, "begin" | "forSource" | "hasDemand">;
  projectRegistry: ProjectRegistry;
  workspaceRegistry: WorkspaceRegistry;
  workspaceGitService: WorkspaceGitService;
  workspaceGitObserver: WorkspaceGitObserverService;
  workspaceDirectory: WorkspaceDirectory;
  workspaceRecovery: WorkspaceRecoveryService;
  directorySync: DirectorySyncService;
  projectIcons: ProjectIconReader;
  agentStorage: AgentStorage;
  scriptRuntimeStore: WorkspaceScriptRuntimeStore | null;
  paseoHome: string;
  onWorkspaceRecovered?: (workspace: PersistedWorkspaceRecord) => Promise<void>;
  logger: pino.Logger;
}

/**
 * The workspace domain of a client session: the `workspaceUpdates` subscription
 * state machine (bootstrap buffering, per-workspace ordered batches, dedupe),
 * `fetch_workspaces_request`, descriptor building, archive and restore, and the
 * project rename/icon RPCs that fan out to workspace updates.
 *
 * Agent-update coupling stays on the host: this class never reads
 * `agentUpdatesSubscription`; the host calls in when agent state changes a workspace.
 */
export class WorkspaceSession {
  private readonly host: WorkspaceSessionHost;
  private readonly delivery: Pick<SessionDelivery, "begin" | "forSource" | "hasDemand">;
  private readonly projectRegistry: ProjectRegistry;
  private readonly workspaceRegistry: WorkspaceRegistry;
  private readonly workspaceGitService: WorkspaceGitService;
  private readonly workspaceGitObserver: WorkspaceGitObserverService;
  private readonly workspaceDirectory: WorkspaceDirectory;
  private readonly workspaceRecovery: WorkspaceRecoveryService;
  private readonly directorySync: DirectorySyncService;
  private readonly projectIcons: ProjectIconReader;
  private readonly agentStorage: AgentStorage;
  private readonly scriptRuntimeStore: WorkspaceScriptRuntimeStore | null;
  private readonly paseoHome: string;
  private readonly onWorkspaceRecovered:
    | ((workspace: PersistedWorkspaceRecord) => Promise<void>)
    | undefined;
  private readonly logger: pino.Logger;
  private readonly workspaceUpdatesSubscriptions = new Map<
    string,
    WorkspaceUpdatesSubscriptionState
  >();
  private readonly workspaceUpdateTails = new Map<string, Promise<void>>();

  constructor(options: WorkspaceSessionOptions) {
    this.host = options.host;
    this.delivery = options.delivery;
    this.projectRegistry = options.projectRegistry;
    this.workspaceRegistry = options.workspaceRegistry;
    this.workspaceGitService = options.workspaceGitService;
    this.workspaceGitObserver = options.workspaceGitObserver;
    this.workspaceDirectory = options.workspaceDirectory;
    this.workspaceRecovery = options.workspaceRecovery;
    this.directorySync = options.directorySync;
    this.projectIcons = options.projectIcons;
    this.agentStorage = options.agentStorage;
    this.scriptRuntimeStore = options.scriptRuntimeStore;
    this.paseoHome = options.paseoHome;
    this.onWorkspaceRecovered = options.onWorkspaceRecovered;
    this.logger = options.logger;
  }

  handleDirectorySuggestions(
    msg: Parameters<typeof handleDirectorySuggestionsRequest>[0],
  ): Promise<void> {
    return handleDirectorySuggestionsRequest(msg, (message) => this.host.emit(message));
  }

  async syncWorkspaceGitObserverForWorkspace(workspace: PersistedWorkspaceRecord): Promise<void> {
    if (
      this.workspaceUpdatesSubscriptions.size === 0 &&
      !this.host.wantsEvent("checkout_status_update")
    )
      return;
    const descriptor = await this.describeWorkspaceRecord(workspace);
    const demanded = [...this.workspaceUpdatesSubscriptions.values()].some((subscription) =>
      this.matchesWorkspaceFilter({ workspace: descriptor, filter: subscription.filter }),
    );
    if (demanded || this.host.wantsEvent("checkout_status_update"))
      this.workspaceGitObserver.syncObservers([descriptor]);
  }

  async emitWorkspaceUpdateForWorkspaceId(workspaceId: string): Promise<void> {
    await this.emitWorkspaceUpdatesForWorkspaceIds([workspaceId]);
  }

  async emitCreatedWorkspaceUpdate(
    workspace: WorkspaceDescriptorPayload,
    optimisticStatus?: WorkspaceDescriptorPayload["status"],
  ): Promise<void> {
    if (this.workspaceUpdatesSubscriptions.size > 0) {
      await this.emitWorkspaceUpdatesForWorkspaceIds(
        [workspace.id],
        optimisticStatus ? { optimisticStatus } : undefined,
      );
      return;
    }
    // COMPAT(workspaceCreateCausalUpdate): added in v0.1.106, remove after 2027-01-12.
    // Older clients create before subscribing and require the causal update beside the response.
    if (workspace.background) return;
    this.host.emit({
      type: "workspace_update",
      payload: {
        kind: "upsert",
        workspace: optimisticStatus ? { ...workspace, status: optimisticStatus } : workspace,
      },
    });
  }

  async syncWorkspaceGitObserversForExternalWorkspaceIds(
    workspaceIds: Iterable<string>,
  ): Promise<void> {
    if (!this.delivery.hasDemand("workspaces") && !this.host.wantsEvent("checkout_status_update"))
      return;
    await Promise.all(
      Array.from(new Set(workspaceIds)).map(async (workspaceId) => {
        const workspace = await this.workspaceRegistry.get(workspaceId);
        if (workspace && !workspace.archivedAt) {
          await this.syncWorkspaceGitObserverForWorkspace(workspace);
        }
      }),
    );
  }

  async warmWorkspaceGitDataForWorkspace(workspace: PersistedWorkspaceRecord): Promise<void> {
    await this.syncWorkspaceGitObserverForWorkspace(workspace);
    await this.emitWorkspaceUpdateForWorkspaceId(workspace.workspaceId);
  }

  async refreshRecoveredWorkspaceForExternalMutation(
    workspace: PersistedWorkspaceRecord,
  ): Promise<void> {
    try {
      await this.syncWorkspaceGitObserverForWorkspace(workspace);
      await this.emitWorkspaceUpdateForWorkspaceId(workspace.workspaceId);
    } catch (error) {
      this.logger.warn(
        { err: error, workspaceId: workspace.workspaceId },
        "Failed to warm git observer after workspace recovery",
      );
      try {
        await this.emitWorkspaceUpdateForWorkspaceId(workspace.workspaceId);
      } catch (emitError) {
        this.logger.warn(
          { err: emitError, workspaceId: workspace.workspaceId },
          "Failed to emit workspace update after recovery",
        );
      }
    }
  }

  async handleWorkspaceMutation(mutation: WorkspaceMutation): Promise<void> {
    try {
      if (this.host.isCleanedUp()) {
        return;
      }
      if (
        mutation.kind === "archive" ||
        mutation.kind === "remove" ||
        mutation.workspace?.archivedAt
      ) {
        this.workspaceGitObserver.removeForWorkspaceId(mutation.workspaceId);
      } else {
        await this.syncWorkspaceMutationObserver(mutation);
      }
      if (this.host.isCleanedUp()) {
        return;
      }
      await this.emitWorkspaceUpdatesForWorkspaceIds(
        [mutation.workspaceId],
        mutation.expectsInitialAgent ? { optimisticStatus: "running" } : undefined,
      );
    } catch (error) {
      this.logger.warn(
        { err: error, workspaceId: mutation.workspaceId, mutationKind: mutation.kind },
        "Failed to apply workspace mutation to session",
      );
    }
  }

  private async syncWorkspaceMutationObserver(mutation: WorkspaceMutation): Promise<void> {
    if (
      !mutation.workspace ||
      (this.workspaceUpdatesSubscriptions.size === 0 &&
        !this.host.wantsEvent("checkout_status_update"))
    )
      return;
    const descriptorsByWorkspaceId = await this.buildWorkspaceDescriptorMap({
      workspaceIds: [mutation.workspaceId],
      includeGitData: false,
    });
    const descriptor = descriptorsByWorkspaceId.get(mutation.workspaceId);
    if (
      !descriptor ||
      (!this.host.wantsEvent("checkout_status_update") &&
        ![...this.workspaceUpdatesSubscriptions.values()].some((subscription) =>
          this.matchesWorkspaceFilter({ workspace: descriptor, filter: subscription.filter }),
        ))
    ) {
      this.workspaceGitObserver.removeForWorkspaceId(mutation.workspaceId);
      return;
    }
    const currentWorkspace = await this.workspaceRegistry.get(mutation.workspaceId);
    if (!currentWorkspace || currentWorkspace.archivedAt) {
      this.workspaceGitObserver.removeForWorkspaceId(mutation.workspaceId);
      return;
    }
    await this.syncWorkspaceGitObserverForWorkspace(currentWorkspace);
    if (this.host.isCleanedUp()) {
      this.workspaceGitObserver.removeForWorkspaceId(mutation.workspaceId);
    }
  }

  async handleProjectMutation(mutation: ProjectMutation): Promise<void> {
    for (const subscription of this.workspaceUpdatesSubscriptions.values()) {
      await this.handleProjectMutationForSubscription(mutation, subscription);
    }
  }

  private async handleProjectMutationForSubscription(
    mutation: ProjectMutation,
    subscription: WorkspaceUpdatesSubscriptionState,
  ): Promise<void> {
    try {
      if (this.host.isCleanedUp()) {
        return;
      }
      const projectWorkspaceIds = (await this.workspaceRegistry.list())
        .filter((workspace) => workspace.projectId === mutation.projectId)
        .map((workspace) => workspace.workspaceId);

      if (mutation.kind === "remove") {
        const visibleWorkspaceIds = projectWorkspaceIds.filter((workspaceId) => {
          const lastEmitted = subscription.lastEmittedByWorkspaceId.get(workspaceId);
          return (
            lastEmitted?.kind === "upsert" ||
            (lastEmitted?.kind === "remove" &&
              lastEmitted.emptyProject?.projectId === mutation.projectId)
          );
        });
        let updateIds = visibleWorkspaceIds;
        if (
          updateIds.length === 0 &&
          subscription.visibleEmptyProjectIds?.has(mutation.projectId)
        ) {
          updateIds = [mutation.projectId];
        }
        if (updateIds.length === 0) {
          return;
        }
        for (const workspaceId of projectWorkspaceIds) {
          this.workspaceGitObserver.removeForWorkspaceId(workspaceId);
        }
        await this.enqueueWorkspaceUpdates(new Set(updateIds), subscription, {
          removedProjectId: mutation.projectId,
        });
        return;
      }

      if (mutation.kind === "archive" || mutation.project?.archivedAt) {
        for (const workspaceId of projectWorkspaceIds) {
          this.workspaceGitObserver.removeForWorkspaceId(workspaceId);
        }
      }
      await this.enqueueWorkspaceUpdates(new Set(projectWorkspaceIds), subscription, undefined);
    } catch (error) {
      this.logger.warn(
        { err: error, projectId: mutation.projectId, mutationKind: mutation.kind },
        "Failed to apply project mutation to session",
      );
    }
  }

  async handleProjectRenameRequest(
    projectId: string,
    customName: string | null,
    requestId: string,
  ): Promise<void> {
    this.logger.info(
      { projectId, requestId, hasCustomName: typeof customName === "string" },
      "session: project.rename.request",
    );

    try {
      const existing = await this.projectRegistry.get(projectId);
      if (!existing) {
        this.host.emit({
          type: "project.rename.response",
          payload: {
            requestId,
            projectId,
            accepted: false,
            customName: null,
            error: "Project not found",
          },
        });
        return;
      }

      const trimmed = customName?.trim() ?? "";
      const nextCustomName = trimmed.length === 0 ? null : trimmed;

      const updated = {
        ...existing,
        customName: nextCustomName,
        updatedAt: new Date().toISOString(),
      };
      await this.projectRegistry.upsert(updated);

      this.host.emit({
        type: "project.rename.response",
        payload: {
          requestId,
          projectId,
          accepted: true,
          customName: nextCustomName,
          error: null,
        },
      });

      // Emit a project.update so clients that track the project as an empty
      // project (no workspaces yet) receive the resolved name immediately.
      await this.host.emitProjectUpdate({ kind: "upsert", project: updated });

      // Re-emit descriptors for every workspace under this project so the new
      // resolved name lands in the UI immediately.
      const workspaces = await this.workspaceRegistry.list();
      const affectedWorkspaceIds = workspaces
        .filter((workspace) => workspace.projectId === existing.projectId)
        .map((workspace) => workspace.workspaceId);
      if (affectedWorkspaceIds.length > 0) {
        await this.emitWorkspaceUpdatesForWorkspaceIds(affectedWorkspaceIds);
      }
    } catch (error) {
      this.logger.error(
        { err: error, projectId, requestId },
        "session: project.rename.request error",
      );
      this.host.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Failed to rename project: ${getErrorMessage(error)}`,
        },
      });
      this.host.emit({
        type: "project.rename.response",
        payload: {
          requestId,
          projectId,
          accepted: false,
          customName: null,
          error: getErrorMessageOr(error, "Failed to rename project"),
        },
      });
    }
  }

  async handleProjectIconSetRequest(
    request: Extract<SessionInboundMessage, { type: "project.icon.set.request" }>,
  ): Promise<void> {
    const { projectId, requestId } = request;
    try {
      const updated = await setProjectCustomIcon({
        paseoHome: this.paseoHome,
        projectId,
        source: request.source,
        projects: this.projectRegistry,
      });

      this.host.emit({
        type: "project.icon.set.response",
        payload: { requestId, projectId, accepted: true, error: null },
      });
      await this.host.emitProjectUpdate({ kind: "upsert", project: updated });

      const affectedWorkspaceIds = (await this.workspaceRegistry.list())
        .filter((workspace) => workspace.projectId === projectId)
        .map((workspace) => workspace.workspaceId);
      if (affectedWorkspaceIds.length > 0) {
        await this.emitWorkspaceUpdatesForWorkspaceIds(affectedWorkspaceIds);
      }
    } catch (error) {
      this.host.emit({
        type: "project.icon.set.response",
        payload: {
          requestId,
          projectId,
          accepted: false,
          error: getErrorMessageOr(error, "Failed to update project icon"),
        },
      });
    }
  }

  async handleProjectIconGetRequest(projectId: string, requestId: string): Promise<void> {
    try {
      const project = await this.projectRegistry.get(projectId);
      if (!project) throw new Error("Project not found");

      const icon = await this.projectIcons.read(project);
      this.host.emit({
        type: "project.icon.get.response",
        payload: { projectId, icon, error: null, requestId },
      });
    } catch (error) {
      this.host.emit({
        type: "project.icon.get.response",
        payload: { projectId, icon: null, error: getErrorMessage(error), requestId },
      });
    }
  }

  async handleWorkspaceRecoveryInspectRequest(
    request: Extract<SessionInboundMessage, { type: "workspace.recovery.inspect.request" }>,
  ): Promise<void> {
    const state = await this.workspaceRecovery.inspect(request.workspaceId);
    this.host.emit({
      type: "workspace.recovery.inspect.response",
      payload: {
        requestId: request.requestId,
        state,
      },
    });
  }

  async handleWorkspaceRecoveryRestoreRequest(
    request: Extract<SessionInboundMessage, { type: "workspace.recovery.restore.request" }>,
  ): Promise<void> {
    try {
      await this.restoreWorkspaceAndEmit(request.workspaceId);
      this.host.emit({
        type: "workspace.recovery.restore.response",
        payload: {
          requestId: request.requestId,
          workspaceId: request.workspaceId,
          accepted: true,
          error: null,
        },
      });
    } catch (error) {
      const message = getErrorMessageOr(error, "Failed to recover workspace");
      this.logger.warn(
        { err: error, workspaceId: request.workspaceId, requestId: request.requestId },
        "session: workspace.recovery.restore.request rejected",
      );
      this.host.emit({
        type: "workspace.recovery.restore.response",
        payload: {
          requestId: request.requestId,
          workspaceId: request.workspaceId,
          accepted: false,
          error: message,
        },
      });
    }
  }

  async describeWorkspaceRecord(
    workspace: PersistedWorkspaceRecord,
    projectRecord?: PersistedProjectRecord | null,
  ): Promise<WorkspaceDescriptorPayload> {
    const resolvedProjectRecord =
      projectRecord ?? (await this.projectRegistry.get(workspace.projectId));

    let diffStat: { additions: number; deletions: number } | null = null;
    const snapshot = this.workspaceGitService.peekSnapshot(workspace.cwd);
    if (snapshot?.git.diffStat) {
      diffStat = snapshot.git.diffStat;
    }

    const worktreeSlug =
      workspace.isPaseoOwnedWorktree && workspace.worktreeRoot
        ? basename(workspace.worktreeRoot)
        : undefined;

    return {
      id: workspace.workspaceId,
      projectId: workspace.projectId,
      projectDisplayName: resolvedProjectRecord
        ? resolveProjectDisplayName(resolvedProjectRecord)
        : workspace.projectId,
      projectCustomName: resolvedProjectRecord?.customName ?? null,
      projectCustomIconRevision: resolvedProjectRecord?.customIconRevision ?? null,
      projectRootPath: resolvedProjectRecord?.rootPath ?? workspace.cwd,
      workspaceDirectory: workspace.cwd,
      setupStatus: this.host.getWorkspaceSetupStatus(workspace),
      worktreeSlug,
      projectKind: (resolvedProjectRecord?.kind ?? "directory") === "git" ? "git" : "non_git",
      workspaceKind: workspace.kind,
      name: resolveWorkspaceDisplayName(workspace),
      title: workspace.title,
      pinnedAt: workspace.pinnedAt,
      ...(workspace.labels && workspace.labels.length > 0 ? { labels: workspace.labels } : {}),
      background: workspace.background,
      archivingAt: null,
      status: "done",
      statusEnteredAt: null,
      activityAt: null,
      diffStat,
      scripts: this.host.buildWorkspaceScriptPayloadSnapshot(workspace, resolvedProjectRecord),
      ...(resolvedProjectRecord
        ? {
            project: await this.host.buildProjectPlacementForWorkspace(
              workspace,
              resolvedProjectRecord,
            ),
          }
        : {}),
    };
  }

  private buildWorkspaceGitRuntimePayload(
    snapshot: WorkspaceGitRuntimeSnapshot,
  ): NonNullable<WorkspaceDescriptorPayload["gitRuntime"]> | null {
    if (!snapshot.git.isGit) {
      return null;
    }

    return {
      currentBranch: snapshot.git.currentBranch,
      remoteUrl: snapshot.git.remoteUrl,
      isPaseoOwnedWorktree: snapshot.git.isPaseoOwnedWorktree,
      isDirty: snapshot.git.isDirty,
      aheadBehind: snapshot.git.aheadBehind,
      aheadOfOrigin: snapshot.git.aheadOfOrigin,
      behindOfOrigin: snapshot.git.behindOfOrigin,
    };
  }

  private buildWorkspaceGitHubRuntimePayload(
    snapshot: WorkspaceGitRuntimeSnapshot,
  ): NonNullable<WorkspaceDescriptorPayload["githubRuntime"]> {
    return {
      featuresEnabled: snapshot.forge.featuresEnabled,
      pullRequest: snapshot.forge.pullRequest,
      error: snapshot.forge.error,
    };
  }

  private async describeWorkspaceRecordWithGitData(
    workspace: PersistedWorkspaceRecord,
    projectRecord?: PersistedProjectRecord | null,
  ): Promise<WorkspaceDescriptorPayload> {
    const base = await this.describeWorkspaceRecord(workspace, projectRecord);
    const snapshot = this.workspaceGitService.peekSnapshot(workspace.cwd);
    if (!snapshot) {
      return base;
    }

    const checkout = checkoutLiteFromGitSnapshot(workspace.cwd, snapshot.git);
    const displayName = deriveWorkspaceDisplayName({ cwd: workspace.cwd, checkout });

    return {
      ...base,
      name: resolveWorkspaceName({ title: workspace.title, derivedDisplayName: displayName }),
      diffStat: snapshot.git.diffStat ?? null,
      gitRuntime: this.buildWorkspaceGitRuntimePayload(snapshot) ?? undefined,
      githubRuntime: this.buildWorkspaceGitHubRuntimePayload(snapshot),
      // Reuse the forge already resolved on the snapshot (probe-aware; GitHub-only
      // resolves to "github") so the sidebar/hover-card brand mark matches the
      // status projection without a second resolve.
      forge: snapshot.forge.forge,
    };
  }

  async describeCreatedWorktreeWorkspace(
    result: CreatePaseoWorktreeResult,
  ): Promise<WorkspaceDescriptorPayload> {
    const projectRecord = await this.projectRegistry.get(result.workspace.projectId);
    return {
      id: result.workspace.workspaceId,
      projectId: result.workspace.projectId,
      projectDisplayName: projectRecord
        ? resolveProjectDisplayName(projectRecord)
        : result.workspace.projectId,
      projectCustomName: projectRecord?.customName ?? null,
      projectCustomIconRevision: projectRecord?.customIconRevision ?? null,
      projectRootPath: projectRecord?.rootPath ?? result.repoRoot,
      workspaceDirectory: result.workspace.cwd,
      setupStatus: this.host.getWorkspaceSetupStatus(result.workspace),
      worktreeSlug: basename(result.worktree.worktreePath),
      projectKind: projectRecord?.kind ?? "git",
      workspaceKind: result.workspace.kind,
      background: result.workspace.background,
      name: resolveWorkspaceName({
        title: result.workspace.title,
        derivedDisplayName: result.worktree.branchName || result.workspace.displayName,
      }),
      title: result.workspace.title,
      pinnedAt: result.workspace.pinnedAt,
      ...(result.workspace.labels && result.workspace.labels.length > 0
        ? { labels: result.workspace.labels }
        : {}),
      archivingAt: null,
      status: "done",
      statusEnteredAt: result.workspace.createdAt,
      activityAt: null,
      diffStat: { additions: 0, deletions: 0 },
      scripts: [],
      gitRuntime: {
        currentBranch: result.worktree.branchName || null,
        remoteUrl: null,
        isPaseoOwnedWorktree: true,
        isDirty: false,
        aheadBehind: null,
        aheadOfOrigin: null,
        behindOfOrigin: null,
      },
      githubRuntime: null,
    };
  }

  async buildWorkspaceDescriptor(input: {
    workspace: PersistedWorkspaceRecord;
    projectRecord?: PersistedProjectRecord | null;
    includeGitData: boolean;
  }): Promise<WorkspaceDescriptorPayload> {
    if (input.includeGitData && input.workspace.kind !== "directory") {
      return this.describeWorkspaceRecordWithGitData(input.workspace, input.projectRecord);
    }
    return this.describeWorkspaceRecord(input.workspace, input.projectRecord);
  }

  markWorkspaceArchiving(workspaceIds: Iterable<string>, archivingAt: string): void {
    this.workspaceDirectory.markArchiving(workspaceIds, archivingAt);
  }

  clearWorkspaceArchiving(workspaceIds: Iterable<string>): void {
    this.workspaceDirectory.clearArchiving(workspaceIds);
  }

  async buildWorkspaceDescriptorMap(options: {
    includeGitData: boolean;
    workspaceIds?: Iterable<string>;
  }): Promise<Map<string, WorkspaceDescriptorPayload>> {
    return this.workspaceDirectory.buildDescriptorMap(options);
  }

  private matchesWorkspaceFilter(input: {
    workspace: WorkspaceDescriptorPayload;
    filter: FetchWorkspacesRequestFilter | undefined;
  }): boolean {
    return this.workspaceDirectory.matchesFilter(input);
  }

  private async listFetchWorkspacesEntries(
    request: Extract<SessionInboundMessage, { type: "fetch_workspaces_request" }>,
  ): Promise<{
    entries: FetchWorkspacesResponseEntry[];
    emptyProjects: WorkspaceProjectDescriptorPayload[];
    pageInfo: FetchWorkspacesResponsePageInfo;
  }> {
    try {
      return await this.workspaceDirectory.listFetchEntries({
        ...request,
        filter: {
          ...request.filter,
          ...(request.includeBackground ? { includeBackground: true } : {}),
        },
      });
    } catch (error) {
      if (error instanceof CursorError) {
        throw new SessionRequestError("invalid_cursor", error.message);
      }
      throw error;
    }
  }

  private bufferOrEmitWorkspaceUpdate(
    subscription: WorkspaceUpdatesSubscriptionState,
    payload: WorkspaceUpdatePayload,
  ): void {
    if (this.workspaceUpdatesSubscriptions.get(subscription.subscriptionId) !== subscription)
      return;
    if (payload.kind === "upsert") {
      subscription.visibleEmptyProjectIds?.delete(payload.workspace.projectId);
    } else {
      if (payload.emptyProject) {
        subscription.visibleEmptyProjectIds?.add(payload.emptyProject.projectId);
      }
      if (payload.removedProjectId) {
        subscription.visibleEmptyProjectIds?.delete(payload.removedProjectId);
      }
    }
    if (subscription.isBootstrapping) {
      const workspaceId = payload.kind === "upsert" ? payload.workspace.id : payload.id;
      subscription.pendingUpdatesByWorkspaceId.set(workspaceId, payload);
      return;
    }
    const workspaceId = payload.kind === "upsert" ? payload.workspace.id : payload.id;
    subscription.lastEmittedByWorkspaceId.set(workspaceId, payload);
    subscription.owner.emit({ type: "workspace_update", payload });
  }

  private flushBootstrappedWorkspaceUpdates(
    subscription: WorkspaceUpdatesSubscriptionState,
    options?: {
      snapshotByWorkspaceId?: Map<
        string,
        { status: string; statusEnteredAt: string | null; activityAtMs: number | null }
      >;
    },
  ): void {
    if (
      this.workspaceUpdatesSubscriptions.get(subscription.subscriptionId) !== subscription ||
      !subscription.isBootstrapping
    ) {
      return;
    }

    subscription.isBootstrapping = false;
    const pending = Array.from(subscription.pendingUpdatesByWorkspaceId.values());
    subscription.pendingUpdatesByWorkspaceId.clear();

    for (const payload of pending) {
      if (payload.kind === "upsert") {
        const snapshot = options?.snapshotByWorkspaceId?.get(payload.workspace.id);
        const updateActivityAtMs = payload.workspace.activityAt
          ? Date.parse(payload.workspace.activityAt)
          : null;
        const shouldEmit = shouldEmitPendingBootstrapUpdate({
          snapshot: snapshot
            ? {
                status: snapshot.status,
                statusEnteredAt: snapshot.statusEnteredAt,
                activityAtMs: snapshot.activityAtMs,
              }
            : null,
          update: {
            status: payload.workspace.status,
            statusEnteredAt: payload.workspace.statusEnteredAt ?? null,
            activityAtMs: Number.isNaN(updateActivityAtMs) ? null : updateActivityAtMs,
          },
        });
        if (!shouldEmit) {
          continue;
        }
      }
      const workspaceId = payload.kind === "upsert" ? payload.workspace.id : payload.id;
      subscription.lastEmittedByWorkspaceId.set(workspaceId, payload);
      subscription.owner.emit({ type: "workspace_update", payload });
    }
  }

  async buildProjectDescriptor(
    project: PersistedProjectRecord,
  ): Promise<WorkspaceProjectDescriptorPayload> {
    const icon = await this.projectIcons.snapshot(project);
    return {
      projectId: project.projectId,
      ...(project.projectKey ? { projectKey: project.projectKey } : {}),
      projectDisplayName: resolveProjectDisplayName(project),
      projectCustomName: project.customName ?? null,
      projectCustomIconRevision: project.customIconRevision ?? null,
      projectIconRevision: icon.revision,
      projectRootPath: project.rootPath,
      projectKind: project.kind,
    };
  }

  private async restoreWorkspaceAndEmit(workspaceId: string): Promise<void> {
    await this.workspaceRecovery.restore(workspaceId);
    const workspace = await this.workspaceRegistry.get(workspaceId);
    if (!workspace) {
      throw new Error(`Recovered workspace record not found: ${workspaceId}`);
    }
    if (this.onWorkspaceRecovered) {
      try {
        await this.onWorkspaceRecovered(workspace);
        return;
      } catch (error) {
        this.logger.warn(
          { err: error, workspaceId },
          "Failed to publish workspace recovery to active sessions",
        );
      }
    }
    await this.refreshRecoveredWorkspaceForExternalMutation(workspace);
  }

  async restoreOwningWorkspaceForLegacyAgentRefresh(agentId: string): Promise<void> {
    // COMPAT(worktreeRestore): clients older than v0.1.105 used refresh_agent_request
    // as their explicit recovery RPC. Remove after 2027-01-11.
    if (!clientUsesLegacyWorkspaceRestore(this.host.getAppVersion())) {
      return;
    }
    const record = await this.agentStorage.get(agentId);
    if (!record?.workspaceId) {
      return;
    }
    const recovery = await this.workspaceRecovery.inspect(record.workspaceId);
    if (recovery.kind !== "recoverable") {
      return;
    }
    await this.restoreWorkspaceAndEmit(record.workspaceId);
  }

  async archiveWorkspaceRecord(workspaceId: string, archivedAt?: string): Promise<void> {
    const archiveTimestamp = archivedAt ?? new Date().toISOString();
    const existingWorkspace = await archivePersistedWorkspaceRecord({
      workspaceId,
      archivedAt: archiveTimestamp,
      workspaceRegistry: this.workspaceRegistry,
    });
    if (!existingWorkspace) {
      this.workspaceGitObserver.removeForWorkspaceId(workspaceId);
      return;
    }

    if (!existingWorkspace.archivedAt) {
      const activeSiblings = (await this.workspaceRegistry.list()).filter(
        (workspace) => workspace.projectId === existingWorkspace.projectId && !workspace.archivedAt,
      );
      this.logger.info(
        {
          workspaceId,
          workspaceCwd: existingWorkspace.cwd,
          projectId: existingWorkspace.projectId,
          projectArchived: activeSiblings.length === 0,
          archivedAt: archiveTimestamp,
        },
        "Workspace archived",
      );
    }

    await this.teardownArchivedWorkspace(existingWorkspace.workspaceId);
  }

  private async teardownArchivedWorkspace(workspaceId: string): Promise<void> {
    this.workspaceGitObserver.removeForWorkspaceId(workspaceId);
    this.scriptRuntimeStore?.removeForWorkspace(workspaceId);
    releaseWorkspaceServicePortPlan(workspaceId);
  }

  async emitWorkspaceUpdatesForWorkspaceIds(
    workspaceIds: Iterable<string>,
    options?: WorkspaceUpdateOptions,
  ): Promise<void> {
    const uniqueWorkspaceIds = new Set(workspaceIds);
    if (uniqueWorkspaceIds.size === 0) return;
    for (const subscription of this.workspaceUpdatesSubscriptions.values()) {
      await this.enqueueWorkspaceUpdates(uniqueWorkspaceIds, subscription, options);
    }
  }

  private enqueueWorkspaceUpdates(
    workspaceIds: ReadonlySet<string>,
    subscription: WorkspaceUpdatesSubscriptionState,
    options: WorkspaceUpdateOptions | undefined,
  ): Promise<void> {
    const previous = Array.from(workspaceIds, (workspaceId) =>
      (this.workspaceUpdateTails.get(workspaceId) ?? Promise.resolve()).catch(() => undefined),
    );
    const next = Promise.all(previous).then(() =>
      this.delivery.forSource(subscription.owner.source, () =>
        this.emitWorkspaceUpdateBatch(workspaceIds, subscription, options),
      ),
    );
    for (const workspaceId of workspaceIds) {
      this.workspaceUpdateTails.set(workspaceId, next);
    }

    const clearTail = () => {
      for (const workspaceId of workspaceIds) {
        if (this.workspaceUpdateTails.get(workspaceId) === next) {
          this.workspaceUpdateTails.delete(workspaceId);
        }
      }
    };
    void next.then(clearTail, clearTail);
    return next;
  }

  private async emitWorkspaceUpdateBatch(
    workspaceIds: ReadonlySet<string>,
    subscription: WorkspaceUpdatesSubscriptionState,
    options: WorkspaceUpdateOptions | undefined,
  ): Promise<void> {
    if (this.workspaceUpdatesSubscriptions.get(subscription.subscriptionId) !== subscription) {
      return;
    }

    const descriptorsByWorkspaceId = await this.buildWorkspaceDescriptorMap({
      workspaceIds,
      includeGitData: true,
    });

    for (const workspaceId of workspaceIds) {
      if (this.workspaceUpdatesSubscriptions.get(subscription.subscriptionId) !== subscription) {
        return;
      }
      const workspace = descriptorsByWorkspaceId.get(workspaceId);
      const filteredWorkspace =
        workspace && this.matchesWorkspaceFilter({ workspace, filter: subscription.filter })
          ? workspace
          : null;
      const nextWorkspace = this.applyOptimisticWorkspaceStatus(
        filteredWorkspace,
        options?.optimisticStatus,
      );
      const lastEmitted = subscription.lastEmittedByWorkspaceId.get(workspaceId);
      this.workspaceGitObserver.recordDescriptorState(workspaceId, nextWorkspace);
      if (!nextWorkspace) {
        if (this.shouldSkipWorkspaceRemoval(lastEmitted, options?.removedProjectId)) {
          continue;
        }
        if (this.workspaceUpdatesSubscriptions.get(subscription.subscriptionId) !== subscription) {
          return;
        }
        subscription.lastEmittedByWorkspaceId.delete(workspaceId);
        const removePayload = await this.buildWorkspaceRemoveUpdatePayload(
          workspaceId,
          options?.removedProjectId,
        );
        this.bufferOrEmitWorkspaceUpdate(
          subscription,
          this.directorySync.sequenceWorkspaceUpdate(
            removePayload,
            workspace ?? null,
            workspaceId,
            subscription.syncEnabled === true,
            subscription.filter?.includeBackground,
          ),
        );
        continue;
      }

      const nextPayload: WorkspaceUpdatePayload = this.directorySync.sequenceWorkspaceUpdate(
        { kind: "upsert", workspace: nextWorkspace },
        workspace ?? null,
        workspaceId,
        subscription.syncEnabled === true,
        subscription.filter?.includeBackground,
      );

      if (
        lastEmitted &&
        lastEmitted.kind === "upsert" &&
        equal(lastEmitted.workspace, nextWorkspace)
      ) {
        continue;
      }

      this.bufferOrEmitWorkspaceUpdate(subscription, nextPayload);
    }
  }

  private applyOptimisticWorkspaceStatus(
    workspace: WorkspaceDescriptorPayload | null,
    optimisticStatus: WorkspaceDescriptorPayload["status"] | undefined,
  ): WorkspaceDescriptorPayload | null {
    if (!workspace || !optimisticStatus) {
      return workspace;
    }
    return { ...workspace, status: optimisticStatus };
  }

  private shouldSkipWorkspaceRemoval(
    lastEmitted: WorkspaceUpdatePayload | undefined,
    removedProjectId: string | undefined,
  ): boolean {
    if (lastEmitted?.kind === "remove") {
      return !removedProjectId || lastEmitted.removedProjectId === removedProjectId;
    }
    return !lastEmitted && !removedProjectId;
  }

  private async buildWorkspaceRemoveUpdatePayload(
    workspaceId: string,
    removedProjectId?: string,
  ): Promise<WorkspaceUpdatePayload> {
    if (removedProjectId) {
      return { kind: "remove", id: workspaceId, removedProjectId };
    }
    return {
      kind: "remove",
      id: workspaceId,
      ...(await this.resolveProjectWithoutActiveWorkspacesForArchivedWorkspace(workspaceId)),
    };
  }

  // When a workspace is archived its project may have no active workspaces left.
  // Resolve that project parent so the `remove` update can carry it, keeping the
  // sidebar in sync without a full re-hydration.
  private async resolveProjectWithoutActiveWorkspacesForArchivedWorkspace(
    workspaceId: string,
  ): Promise<{ emptyProject: WorkspaceProjectDescriptorPayload } | null> {
    const archivedWorkspace = await this.workspaceRegistry.get(workspaceId);
    if (!archivedWorkspace) {
      return null;
    }
    const projectWithoutActiveWorkspaces = (await this.workspaceDirectory.listEmptyProjects()).find(
      (project) => project.projectId === archivedWorkspace.projectId,
    );
    return projectWithoutActiveWorkspaces ? { emptyProject: projectWithoutActiveWorkspaces } : null;
  }

  async emitWorkspaceUpdateForTerminalContribution(
    event: TerminalWorkspaceContributionChangedEvent,
  ): Promise<void> {
    // A terminal's activity contributes only to the workspace it carries. A
    // terminal with no workspaceId attributes to nothing — status is per-id.
    if (!event.workspaceId) {
      return;
    }
    await this.emitWorkspaceUpdatesForWorkspaceIds([event.workspaceId]);
  }

  // A git fact (branch, diff, dirty, PR) changed at `cwd`. Every workspace whose
  // OWN cwd is this folder re-derives its git facts from that folder (id → cwd)
  // and emits its own per-id descriptor. This is a deliberate same-folder fan,
  // not a cwd → id ownership lookup: git never resolves which workspace owns a
  // path. See `workspaceIdsOnCheckout`.
  async emitWorkspaceUpdateForCwd(cwd: string, options?: {}): Promise<void> {
    if (this.workspaceUpdatesSubscriptions.size === 0) return;
    const workspaceIds = workspaceIdsOnCheckout(await this.workspaceRegistry.list(), cwd);
    if (workspaceIds.length === 0) {
      return;
    }
    await this.emitWorkspaceUpdatesForWorkspaceIds(workspaceIds, options);
  }

  async handleFetchWorkspacesRequest(
    request: Extract<SessionInboundMessage, { type: "fetch_workspaces_request" }>,
  ): Promise<void> {
    const owner = request.subscribe
      ? this.delivery.begin("workspaces", request.subscribe.subscriptionId, async (id) => {
          this.workspaceUpdatesSubscriptions.delete(id);
          this.host.refreshObservationProducers();
          await this.reconcileWorkspaceGitObservers();
        })
      : null;
    const subscriptionId = owner?.responseId;
    const subscription: WorkspaceUpdatesSubscriptionState | null = owner
      ? {
          subscriptionId: owner.id,
          owner,
          syncEnabled: Boolean(request.sync),
          filter: {
            ...request.filter,
            ...(request.includeBackground ? { includeBackground: true } : {}),
          },
          isBootstrapping: true,
          pendingUpdatesByWorkspaceId: new Map(),
          lastEmittedByWorkspaceId: new Map(),
          visibleEmptyProjectIds: new Set(),
        }
      : null;
    if (subscription) {
      this.workspaceUpdatesSubscriptions.set(subscription.subscriptionId, subscription);
      this.host.refreshObservationProducers();
    }
    try {
      this.logger.debug(
        {
          requestId: request.requestId,
          subscribeRequested: Boolean(request.subscribe),
          filter: request.filter ?? null,
          sort: request.sort ?? null,
          page: request.page ?? null,
        },
        "fetch_workspaces_request_received",
      );
      const payload = request.sync
        ? await this.readWorkspaceDirectorySync(request)
        : await this.listFetchWorkspacesEntries(request);

      this.logger.debug(
        {
          requestId: request.requestId,
          subscriptionId,
          pageInfo: payload.pageInfo,
          payload: summarizeFetchWorkspacesEntries(payload.entries),
        },
        "fetch_workspaces_response_ready",
      );
      const snapshot = this.buildBootstrapSnapshot(payload.entries);
      if (subscription) {
        this.seedWorkspaceSubscriptionSnapshot(
          subscription,
          payload.entries,
          payload.emptyProjects,
        );
      }

      this.host.emit({
        type: "fetch_workspaces_response",
        payload: {
          requestId: request.requestId,
          ...(subscriptionId ? { subscriptionId } : {}),
          ...payload,
        },
      });

      if (subscription) {
        await this.reconcileWorkspaceGitObservers();
        this.flushBootstrappedWorkspaceUpdates(subscription, snapshot);
      }
    } catch (error) {
      await owner?.release();
      const code = error instanceof SessionRequestError ? error.code : "fetch_workspaces_failed";
      const message = error instanceof Error ? error.message : "Failed to fetch workspaces";
      this.logger.error({ err: error }, "Failed to handle fetch_workspaces_request");
      this.host.emit({
        type: "rpc_error",
        payload: {
          requestId: request.requestId,
          requestType: request.type,
          error: message,
          code,
        },
      });
    }
  }

  private async readWorkspaceDirectorySync(
    request: Extract<SessionInboundMessage, { type: "fetch_workspaces_request" }>,
  ) {
    if (request.filter)
      throw new SessionRequestError(
        "invalid_request",
        "Sequenced workspace directory reads do not support filters.",
      );
    const result = this.directorySync.synchronizeWorkspaces(
      await this.workspaceDirectory.listDescriptors(),
      request.sync ?? {},
      request.includeBackground,
    );
    return {
      ...result,
      entries: result.entries.filter(
        (workspace) => request.includeBackground || !workspace.background,
      ),
    };
  }

  // Build the bootstrap snapshot used by `flushBootstrappedWorkspaceUpdates`
  // to decide which pending updates to drop. Captures the status,
  // statusEnteredAt, and activityAt (parsed to ms) for each workspace entry
  // so a status-only change (e.g. the unmask case), a statusEnteredAt-only
  // change (e.g. a fresh unmask time), AND a fresher activity all still
  // ship to the client.
  private buildBootstrapSnapshot(entries: FetchWorkspacesResponseEntry[]): {
    snapshotByWorkspaceId: Map<
      string,
      { status: string; statusEnteredAt: string | null; activityAtMs: number | null }
    >;
  } {
    const snapshotByWorkspaceId = new Map<
      string,
      { status: string; statusEnteredAt: string | null; activityAtMs: number | null }
    >();
    for (const entry of entries) {
      const parsedActivity = entry.activityAt ? Date.parse(entry.activityAt) : null;
      snapshotByWorkspaceId.set(entry.id, {
        status: entry.status,
        statusEnteredAt: entry.statusEnteredAt ?? null,
        activityAtMs: Number.isNaN(parsedActivity) ? null : parsedActivity,
      });
    }
    return { snapshotByWorkspaceId };
  }

  async reconcileWorkspaceGitObservers(): Promise<void> {
    const all = this.host.wantsEvent("checkout_status_update")
      ? await this.workspaceDirectory.listObservationTargets()
      : [];
    const entries = [...this.workspaceUpdatesSubscriptions.values()].flatMap((subscription) =>
      [...subscription.lastEmittedByWorkspaceId.values()].flatMap((update) =>
        update.kind === "upsert" ? [update.workspace] : [],
      ),
    );
    this.workspaceGitObserver.reconcileObservers(
      this.host.wantsEvent("checkout_status_update") ? [...entries, ...all] : entries,
    );
  }

  private seedWorkspaceSubscriptionSnapshot(
    subscription: WorkspaceUpdatesSubscriptionState,
    entries: FetchWorkspacesResponseEntry[],
    emptyProjects: WorkspaceProjectDescriptorPayload[],
  ): void {
    if (this.workspaceUpdatesSubscriptions.get(subscription.subscriptionId) !== subscription)
      return;
    for (const entry of entries) {
      subscription.lastEmittedByWorkspaceId.set(entry.id, {
        kind: "upsert",
        workspace: entry,
      });
    }
    for (const project of emptyProjects) {
      subscription.visibleEmptyProjectIds?.add(project.projectId);
    }
  }
}
