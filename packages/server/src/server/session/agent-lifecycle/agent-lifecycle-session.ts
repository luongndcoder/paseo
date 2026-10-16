import type pino from "pino";
import type { AgentCreateRequest, CreationSnapshot } from "@getpaseo/protocol/messages";
import { v4 as uuidv4 } from "uuid";
import { getErrorMessage } from "@getpaseo/protocol/error-utils";
import { getErrorMessageOr } from "@getpaseo/protocol/error-utils";
import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import type {
  AgentSnapshotPayload,
  CloseItemsRequest,
  ProjectPlacementPayload,
  SessionInboundMessage,
  SessionOutboundMessage,
} from "../../messages.js";
import type { AgentManager, ManagedAgent } from "../../agent/agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "../../agent/agent-storage.js";
import { ensureAgentLoaded } from "../../agent/agent-loading.js";
import { unarchiveAgentState } from "../../agent/agent-prompt.js";
import {
  buildConfigOverrides,
  isStoredAgentProviderAvailable,
  resolveStoredAgentUpdatedAt,
  toAgentPersistenceHandle,
} from "../../persistence-hooks.js";
import {
  archiveAgentCommand,
  cancelAgentRunCommand,
  closeAgentCommand,
  detachAgentCommand,
  updateAgentCommand,
} from "../../agent/lifecycle-command.js";
import {
  ImportSessionsRequestError,
  importProviderSession,
  listImportableProviderSessions,
  normalizeImportAgentRequest,
} from "../../agent/import-sessions.js";
import type {
  AgentPermissionResponse,
  AgentPersistenceHandle,
  AgentProvider,
} from "../../agent/agent-sdk-types.js";
import { sendPromptToAgent, waitForAgentRunStartWithTimeout } from "../../agent/agent-prompt.js";
import { resolveCreateAgentTitles } from "../../agent/create-agent-title.js";
import { respondToAgentPermission } from "../../agent/permission-response.js";
import { buildAgentPrompt } from "../../agent/prompt-attachments.js";
import type { AgentDirectory } from "../../agent/directory.js";
import type { ProviderSnapshotManager } from "../../agent/provider-snapshot-manager.js";
import type { DirectorySyncService } from "../../directory-sync/index.js";
import type { MessageReceipts } from "../../message-receipts/index.js";
import type { SessionDelivery } from "../owned-subscriptions/index.js";
import type { AgentUpdatesService } from "../agent-updates/agent-updates-service.js";
import { SessionRequestError } from "../session-request-error.js";
import { toWorktreeWireError } from "../../worktree-errors.js";
import { FetchAgentsEntries, type FetchAgentsEntriesResult } from "./fetch-agents-entries.js";
import type { PersistedWorkspaceRecord } from "../../workspace-registry.js";
import type { WorkspaceProvisioningService } from "../workspace-provisioning/workspace-provisioning-service.js";
import { WorktreeRequestError } from "../../worktree-errors.js";

export interface AgentLifecycleSessionHost {
  emit(msg: SessionOutboundMessage): void;
  forwardLiveAgent(agent: ManagedAgent): Promise<void>;
  buildAgentPayload(agent: ManagedAgent): Promise<AgentSnapshotPayload>;
  registerWorkspaceForImportedAgent(workspace: PersistedWorkspaceRecord): Promise<void>;
  restoreOwningWorkspaceForLegacyAgentRefresh(agentId: string): Promise<void>;
  interruptAgentIfRunning(agentId: string): Promise<void>;
  handleAgentRunError(agentId: string, error: unknown, context: string): void;
  listRegisteredProviderIds(): AgentProvider[];
  isProviderVisibleToClient(provider: string): boolean;
  buildStoredAgentPayload(record: StoredAgentRecord): AgentSnapshotPayload;
  buildProjectPlacementForWorkspaceId(workspaceId: string): Promise<ProjectPlacementPayload | null>;
  buildActiveProjectPlacementsByWorkspaceId(): Promise<Map<string, ProjectPlacementPayload>>;
  listAgentPayloads(
    filter?: Parameters<AgentDirectory["list"]>[0],
  ): Promise<AgentSnapshotPayload[]>;
  refreshObservationProducers(): void;
  emitWorkspaceUpdateForWorkspaceId(workspaceId: string): Promise<void>;
  emitWorkspaceUpdatesForWorkspaceIds(workspaceIds: Iterable<string>): Promise<void>;
  killTerminalForClose(terminalId: string): { terminalId: string; success: boolean };
  createRequestedAgent(request: AgentCreateRequest): Promise<CreationSnapshot>;
  createSessionAgent(msg: CreateAgentRequestMessage): Promise<{ agent: AgentSnapshotPayload }>;
}

export interface AgentLifecycleSessionOptions {
  host: AgentLifecycleSessionHost;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  workspaceProvisioning: WorkspaceProvisioningService;
  providerSnapshotManager: ProviderSnapshotManager;
  messageReceipts: Pick<MessageReceipts, "send">;
  delivery: SessionDelivery;
  agentUpdates: AgentUpdatesService;
  agentDirectory: AgentDirectory;
  directorySync: DirectorySyncService;
  logger: pino.Logger;
}

type DeleteFencedAgentStorage = AgentStorage & {
  beginDelete(agentId: string): void;
};

function beginAgentDeleteIfSupported(agentStorage: AgentStorage, agentId: string): void {
  if ("beginDelete" in agentStorage && typeof agentStorage.beginDelete === "function") {
    (agentStorage as DeleteFencedAgentStorage).beginDelete(agentId);
  }
}

type CreateAgentRequestMessage = Extract<SessionInboundMessage, { type: "create_agent_request" }>;

export function resolveWaitForFinishError(options: {
  status: "permission" | "error" | "idle";
  final: AgentSnapshotPayload | null;
}): string | null {
  if (options.status !== "error") {
    return null;
  }
  const message = options.final?.lastError;
  return typeof message === "string" && message.trim().length > 0 ? message : "Agent failed";
}

function errorToFriendlyMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown error";
}

/**
 * Agent lifecycle: fetch, create, resume, import, refresh, cancel, update,
 * message, wait, archive, delete, detach, close and permission answers.
 */
export class AgentLifecycleSession {
  private readonly host: AgentLifecycleSessionHost;
  private readonly agentManager: AgentManager;
  private readonly agentStorage: AgentStorage;
  private readonly workspaceProvisioning: WorkspaceProvisioningService;
  private readonly providerSnapshotManager: ProviderSnapshotManager;
  private readonly messageReceipts: Pick<MessageReceipts, "send">;
  private readonly delivery: SessionDelivery;
  private readonly agentUpdates: AgentUpdatesService;
  private readonly fetchEntries: FetchAgentsEntries;
  private readonly logger: pino.Logger;

  constructor(options: AgentLifecycleSessionOptions) {
    this.host = options.host;
    this.agentManager = options.agentManager;
    this.agentStorage = options.agentStorage;
    this.workspaceProvisioning = options.workspaceProvisioning;
    this.providerSnapshotManager = options.providerSnapshotManager;
    this.messageReceipts = options.messageReceipts;
    this.delivery = options.delivery;
    this.agentUpdates = options.agentUpdates;
    this.fetchEntries = new FetchAgentsEntries({
      agentDirectory: options.agentDirectory,
      directorySync: options.directorySync,
      listAgentPayloads: (filter) => this.host.listAgentPayloads(filter),
      buildProjectPlacementForWorkspaceId: (workspaceId) =>
        this.host.buildProjectPlacementForWorkspaceId(workspaceId),
      buildActiveProjectPlacementsByWorkspaceId: () =>
        this.host.buildActiveProjectPlacementsByWorkspaceId(),
    });
    this.logger = options.logger;
  }

  private async unarchiveAgentByHandle(handle: AgentPersistenceHandle): Promise<{
    record: StoredAgentRecord;
    didUnarchive: boolean;
    originalArchivedAt: string | null;
  } | null> {
    const records = await this.agentStorage.listByProviderSession(
      handle.provider,
      handle.sessionId,
    );
    const matched = records.reduce<StoredAgentRecord | null>((latest, candidate) => {
      if (!latest) {
        return candidate;
      }
      const updatedDelta =
        Date.parse(resolveStoredAgentUpdatedAt(candidate)) -
        Date.parse(resolveStoredAgentUpdatedAt(latest));
      if (updatedDelta !== 0) {
        return updatedDelta > 0 ? candidate : latest;
      }
      return Date.parse(candidate.createdAt) > Date.parse(latest.createdAt) ? candidate : latest;
    }, null);
    if (!matched) {
      return null;
    }
    const didUnarchive = await unarchiveAgentState(
      this.agentStorage,
      this.agentManager,
      matched.id,
    );
    return {
      record: matched,
      didUnarchive,
      originalArchivedAt: matched.archivedAt ?? null,
    };
  }

  listFetchAgentsEntries(
    request: Parameters<FetchAgentsEntries["list"]>[0],
  ): Promise<FetchAgentsEntriesResult> {
    return this.fetchEntries.list(request);
  }

  async handleResumeAgentRequest(
    msg: Extract<SessionInboundMessage, { type: "resume_agent_request" }>,
  ): Promise<void> {
    const { handle, overrides, requestId } = msg;
    if (!handle) {
      this.logger.warn("Resume request missing persistence handle");
      if (requestId) {
        this.host.emit({
          type: "rpc_error",
          payload: {
            requestId,
            requestType: msg.type,
            error: "Unable to resume agent: missing persistence handle",
            code: "agent_resume_failed",
          },
        });
      }
      this.host.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: "Unable to resume agent: missing persistence handle",
        },
      });
      return;
    }
    this.logger.info(
      { sessionId: handle.sessionId, provider: handle.provider },
      `Resuming agent ${handle.sessionId} (${handle.provider})`,
    );
    try {
      const matched = await this.unarchiveAgentByHandle(handle);
      const effectiveOverrides = matched
        ? { ...buildConfigOverrides(matched.record), ...overrides }
        : overrides;
      let snapshot: ManagedAgent;
      try {
        snapshot = await this.agentManager.resumeAgentFromPersistence(handle, effectiveOverrides);
      } catch (error) {
        if (matched?.didUnarchive && matched.originalArchivedAt) {
          await this.agentManager.archiveSnapshot(matched.record.id, matched.originalArchivedAt);
        }
        throw error;
      }
      await unarchiveAgentState(this.agentStorage, this.agentManager, snapshot.id);
      await this.agentManager.hydrateTimelineFromProvider(snapshot.id);
      await this.host.forwardLiveAgent(snapshot);
      const timelineSize = this.agentManager.getTimeline(snapshot.id).length;
      if (requestId) {
        const agentPayload = await this.host.buildAgentPayload(snapshot);
        this.host.emit({
          type: "status",
          payload: {
            status: "agent_resumed",
            agentId: snapshot.id,
            requestId,
            timelineSize,
            agent: agentPayload,
          },
        });
      }
    } catch (error) {
      const message = getErrorMessage(error);
      this.logger.error({ err: error }, "Failed to resume agent");
      if (requestId) {
        this.host.emit({
          type: "rpc_error",
          payload: {
            requestId,
            requestType: msg.type,
            error: message,
            code: "agent_resume_failed",
          },
        });
      }
      this.host.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Failed to resume agent: ${message}`,
        },
      });
    }
  }

  async handleImportAgentRequest(
    msg: Extract<SessionInboundMessage, { type: "import_agent_request" }>,
  ): Promise<void> {
    const normalized = normalizeImportAgentRequest(msg);
    if ("error" in normalized) {
      this.host.emit({
        type: "status",
        payload: {
          status: "agent_create_failed",
          requestId: msg.requestId,
          error: normalized.error,
        },
      });
      return;
    }
    const { provider, providerHandleId, requestId } = normalized;
    this.logger.info(
      { providerHandleId, provider },
      `Importing agent ${providerHandleId} (${provider})`,
    );

    try {
      if (!normalized.cwd) {
        throw new Error("Import requires cwd from the selected provider session");
      }
      const { snapshot, timelineSize, createdWorkspace } = await importProviderSession({
        request: normalized,
        workspaceProvisioning: this.workspaceProvisioning,
        agentManager: this.agentManager,
        agentStorage: this.agentStorage,
        logger: this.logger,
      });
      if (createdWorkspace) {
        await this.host.registerWorkspaceForImportedAgent(createdWorkspace);
      }
      const agentPayload = await this.host.buildAgentPayload(snapshot);
      this.host.emit({
        type: "status",
        payload: {
          status: "agent_resumed",
          agentId: snapshot.id,
          requestId,
          timelineSize,
          agent: agentPayload,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ err: error }, "Failed to import agent");
      this.host.emit({
        type: "status",
        payload: {
          status: "agent_create_failed",
          requestId,
          error: message,
        },
      });
      this.host.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Failed to import agent: ${message}`,
        },
      });
    }
  }

  async handleRefreshAgentRequest(
    msg: Extract<SessionInboundMessage, { type: "refresh_agent_request" }>,
  ): Promise<void> {
    const { agentId, requestId } = msg;
    this.logger.info({ agentId }, `Refreshing agent ${agentId} from persistence`);

    try {
      await this.host.restoreOwningWorkspaceForLegacyAgentRefresh(agentId);
      await unarchiveAgentState(this.agentStorage, this.agentManager, agentId);
      let snapshot: ManagedAgent;
      const existing = this.agentManager.getAgent(agentId);
      if (existing) {
        await this.host.interruptAgentIfRunning(agentId);
        snapshot = await this.agentManager.reloadAgentSession(agentId, undefined, {
          rehydrateFromDisk: true,
        });
      } else {
        const record = await this.agentStorage.get(agentId);
        if (!record) {
          throw new Error(`Agent not found: ${agentId}`);
        }
        const registeredProviderIds = this.host.listRegisteredProviderIds();
        if (!isStoredAgentProviderAvailable(record, registeredProviderIds)) {
          throw new Error(`Agent ${agentId} references unavailable provider '${record.provider}'`);
        }
        if (!toAgentPersistenceHandle(registeredProviderIds, record.persistence)) {
          throw new Error(`Agent ${agentId} cannot be refreshed because it lacks persistence`);
        }
        // Share the loader's per-agent in-flight operation with timeline fetches.
        // Unarchiving publishes the record before provider resume finishes, so
        // the agent pane can otherwise race this request and resume it twice.
        snapshot = await ensureAgentLoaded(agentId, {
          agentManager: this.agentManager,
          agentStorage: this.agentStorage,
          broadcastTimeline: true,
          logger: this.logger,
        });
      }
      await this.agentManager.hydrateTimelineFromProvider(agentId, { broadcast: true });
      await this.host.forwardLiveAgent(snapshot);
      const timelineSize = this.agentManager.getTimeline(agentId).length;
      if (requestId) {
        this.host.emit({
          type: "status",
          payload: {
            status: "agent_refreshed",
            agentId,
            requestId,
            timelineSize,
          },
        });
      }
    } catch (error) {
      const message = getErrorMessage(error);
      this.logger.error({ err: error, agentId }, `Failed to refresh agent ${agentId}`);
      if (requestId) {
        this.host.emit({
          type: "rpc_error",
          payload: {
            requestId,
            requestType: msg.type,
            error: message,
            code: error instanceof WorktreeRequestError ? error.code : "agent_refresh_failed",
          },
        });
      }
      this.host.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Failed to refresh agent: ${message}`,
        },
      });
    }
  }

  async handleCancelAgentRequest(agentId: string, requestId?: string): Promise<void> {
    this.logger.info({ agentId }, `Cancel request received for agent ${agentId}`);

    try {
      await cancelAgentRunCommand(
        { agentManager: this.agentManager, logger: this.logger },
        agentId,
      );
      if (requestId) {
        const agent = this.agentManager.getAgent(agentId);
        const payload = agent ? await this.host.buildAgentPayload(agent) : null;
        this.host.emit({
          type: "cancel_agent_response",
          payload: {
            requestId,
            agentId,
            agent: payload,
            error: null,
          },
        });
      }
    } catch (error) {
      if (requestId) {
        this.logger.error(
          { err: error, agentId },
          `Failed to cancel running agent on request for agent ${agentId}`,
        );
        const agent = this.agentManager.getAgent(agentId);
        const payload = agent ? await this.host.buildAgentPayload(agent) : null;
        this.host.emit({
          type: "cancel_agent_response",
          payload: {
            requestId,
            agentId,
            agent: payload,
            error: errorToFriendlyMessage(error),
          },
        });
      } else {
        this.host.handleAgentRunError(agentId, error, "Failed to cancel running agent on request");
      }
    }
  }

  async handleDeleteAgentRequest(agentId: string, requestId: string): Promise<void> {
    this.logger.info({ agentId }, `Deleting agent ${agentId} from registry`);

    const knownWorkspaceId =
      this.agentManager.getAgent(agentId)?.workspaceId ??
      (await this.agentStorage.get(agentId))?.workspaceId ??
      null;

    // File-backed storage still needs an early delete fence before closeAgent().
    beginAgentDeleteIfSupported(this.agentStorage, agentId);

    try {
      await closeAgentCommand({ agentManager: this.agentManager }, agentId);
    } catch (error) {
      this.logger.warn({ err: error, agentId }, `Failed to close agent ${agentId} during delete`);
    }

    // Drain queued persistence from the just-closed agent before removing its
    // durable snapshot, otherwise an in-flight background write can recreate it.
    await this.agentManager.flush();

    try {
      await this.agentStorage.remove(agentId);
      await this.agentManager.deleteAgentState(agentId);
    } catch (error) {
      this.logger.error({ err: error, agentId }, `Failed to fully delete agent ${agentId}`);
    }

    this.host.emit({
      type: "agent_deleted",
      payload: {
        agentId,
        requestId,
      },
    });

    await this.agentUpdates.removeAgent(agentId);

    if (knownWorkspaceId) {
      await this.host.emitWorkspaceUpdateForWorkspaceId(knownWorkspaceId);
    }
  }

  async handleArchiveAgentRequest(agentId: string, requestId: string): Promise<void> {
    this.logger.info({ agentId }, `Archiving agent ${agentId}`);

    const { archivedAt } = await this.archiveAgentForClose(agentId);

    this.host.emit({
      type: "agent_archived",
      payload: {
        agentId,
        archivedAt,
        requestId,
      },
    });
  }

  async archiveAgentForClose(agentId: string): Promise<{ agentId: string; archivedAt: string }> {
    const { archivedAt, record: archivedRecord } = await archiveAgentCommand(
      {
        agentManager: this.agentManager,
        agentStorage: this.agentStorage,
        logger: this.logger,
      },
      agentId,
    );

    if (archivedRecord && this.agentUpdates.hasSubscription()) {
      const payload = await this.agentUpdates.emitStoredRecord(archivedRecord);
      if (payload.workspaceId) {
        await this.host.emitWorkspaceUpdateForWorkspaceId(payload.workspaceId);
      }
    }

    return { agentId, archivedAt };
  }

  async handleDetachAgentRequest(agentId: string, requestId: string): Promise<void> {
    this.logger.info({ agentId, requestId }, "Detaching agent from parent");

    try {
      const result = await detachAgentCommand({ agentManager: this.agentManager }, agentId);
      const affectedWorkspaceIds = new Set<string>();

      if (!result.live) {
        const payload = await this.agentUpdates.emitStoredRecord(result.record);
        if (payload.workspaceId) {
          affectedWorkspaceIds.add(payload.workspaceId);
        }
      } else if (result.record.workspaceId) {
        affectedWorkspaceIds.add(result.record.workspaceId);
      }

      if (result.previousParentAgentId) {
        const rootWorkspaceId = await this.resolveDelegationRootWorkspaceId(
          result.previousParentAgentId,
        );
        if (rootWorkspaceId) {
          affectedWorkspaceIds.add(rootWorkspaceId);
        }
      }

      await this.host.emitWorkspaceUpdatesForWorkspaceIds(affectedWorkspaceIds);

      this.host.emit({
        type: "agent.detach.response",
        payload: {
          requestId,
          agentId,
          accepted: true,
          error: null,
        },
      });
    } catch (error) {
      const message = getErrorMessageOr(error, "Failed to detach agent");
      this.logger.error({ err: error, agentId, requestId }, "Failed to detach agent");
      this.host.emit({
        type: "agent.detach.response",
        payload: {
          requestId,
          agentId,
          accepted: false,
          error: message,
        },
      });
    }
  }

  async handleCloseItemsRequest(msg: CloseItemsRequest): Promise<void> {
    const archiveResults = await Promise.allSettled(
      msg.agentIds.map((agentId) => this.archiveAgentForClose(agentId)),
    );
    const agents = [];
    for (let i = 0; i < archiveResults.length; i += 1) {
      const result = archiveResults[i];
      if (result.status === "fulfilled") {
        agents.push(result.value);
      } else {
        this.logger.warn(
          { err: result.reason, agentId: msg.agentIds[i], requestId: msg.requestId },
          "Failed to archive agent during close_items batch",
        );
      }
    }

    const terminals = [];
    for (const terminalId of msg.terminalIds) {
      try {
        terminals.push(this.host.killTerminalForClose(terminalId));
      } catch (error) {
        this.logger.warn(
          { err: error, terminalId, requestId: msg.requestId },
          "Failed to kill terminal during close_items batch",
        );
        terminals.push({
          terminalId,
          success: false,
        });
      }
    }

    this.host.emit({
      type: "close_items_response",
      payload: {
        agents,
        terminals,
        requestId: msg.requestId,
      },
    });
  }

  async handleUpdateAgentRequest(
    agentId: string,
    name: string | undefined,
    labels: Record<string, string> | undefined,
    requestId: string,
  ): Promise<void> {
    this.logger.info(
      {
        agentId,
        requestId,
        hasName: typeof name === "string",
        labelCount: labels ? Object.keys(labels).length : 0,
      },
      "session: update_agent_request",
    );

    try {
      const result = await updateAgentCommand(
        { agentManager: this.agentManager },
        { agentId, name, labels },
      );

      if (!result.accepted) {
        this.host.emit({
          type: "update_agent_response",
          payload: {
            requestId,
            agentId,
            accepted: false,
            error: result.error,
          },
        });
        return;
      }

      this.host.emit({
        type: "update_agent_response",
        payload: { requestId, agentId, accepted: true, error: null },
      });
    } catch (error) {
      this.logger.error({ err: error, agentId, requestId }, "session: update_agent_request error");
      this.host.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Failed to update agent: ${getErrorMessage(error)}`,
        },
      });
      this.host.emit({
        type: "update_agent_response",
        payload: {
          requestId,
          agentId,
          accepted: false,
          error: getErrorMessageOr(error, "Failed to update agent"),
        },
      });
    }
  }

  async handleCreateAgentRequest(msg: CreateAgentRequestMessage): Promise<void> {
    try {
      let agent: AgentSnapshotPayload;
      if (msg.idempotencyKey !== undefined) {
        if (msg.initialPrompt !== undefined) {
          throw new Error("Idempotent creation requires sending the initial prompt separately");
        }
        const creation = await this.host.createRequestedAgent({
          ...msg,
          type: "agent.create.request",
        });
        if (creation.error || !creation.agent)
          throw new SessionRequestError(
            creation.errorCode ?? "unknown",
            creation.error ?? "Agent creation failed",
          );
        const record = await this.agentStorage.get(creation.agent.id);
        if (!record) throw new Error("Previously created agent no longer exists");
        agent = this.host.buildStoredAgentPayload(record);
      } else {
        ({ agent } = await this.host.createSessionAgent(msg));
      }
      this.host.emit({
        type: "status",
        payload: {
          status: "agent_created",
          agentId: agent.id,
          requestId: msg.requestId,
          agent,
        },
      });
    } catch (error) {
      const wireError = error instanceof SessionRequestError ? error : toWorktreeWireError(error);
      this.logger.error({ err: error }, "Failed to create agent");
      this.host.emit({
        type: "status",
        payload: {
          status: "agent_create_failed",
          requestId: msg.requestId,
          error: wireError.message,
          errorCode: wireError.code,
        },
      });
      this.host.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Failed to create agent: ${wireError.message}`,
        },
      });
    }
  }

  /**
   * Handle clearing agent attention flag
   */
  async handleClearAgentAttention(agentId: string | string[], requestId?: string): Promise<void> {
    const agentIds = Array.isArray(agentId) ? agentId : [agentId];

    try {
      await Promise.all(
        agentIds.map((id) =>
          ensureAgentLoaded(id, {
            agentManager: this.agentManager,
            agentStorage: this.agentStorage,
            logger: this.logger,
          }),
        ),
      );
      await Promise.all(agentIds.map((id) => this.agentManager.clearAgentAttention(id)));
      if (requestId) {
        const agents = (
          await Promise.all(
            agentIds.map(async (id) => {
              const agent = this.agentManager.getAgent(id);
              return agent ? this.host.buildAgentPayload(agent) : null;
            }),
          )
        ).filter((payload): payload is NonNullable<typeof payload> => payload !== null);
        this.host.emit({
          type: "clear_agent_attention_response",
          payload: {
            requestId,
            agentId,
            agents,
          },
        });
      }
    } catch (error) {
      this.logger.error({ err: error, agentIds }, "Failed to clear agent attention");
      // Don't throw - this is not critical
    }
  }

  /**
   * Handle agent permission response from user
   */
  async handleAgentPermissionResponse(
    agentId: string,
    requestId: string,
    response: AgentPermissionResponse,
  ): Promise<void> {
    try {
      await respondToAgentPermission({
        agentManager: this.agentManager,
        agentId,
        requestId,
        response,
        logger: this.logger,
      });
      // COMPAT(ownedSubscriptions): added in v0.8.0, remove after 2027-03-09.
      // Legacy clients consume the single domain resolution; modern request outcomes
      // are independent of whether this socket (or its logical Session) observes it.
      if (this.delivery.isModern(this.delivery.currentSource)) {
        this.delivery.reply({
          type: "agent_permission_resolved",
          payload: { agentId, requestId, resolution: response },
        });
      }
    } catch (error) {
      this.logger.error({ err: error, agentId, requestId }, "Failed to respond to permission");
      this.host.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Failed to respond to permission: ${getErrorMessage(error)}`,
        },
      });
      throw error;
    }
  }

  async resolveAgentIdentifier(
    identifier: string,
  ): Promise<{ ok: true; agentId: string } | { ok: false; notFound: boolean; error: string }> {
    const trimmed = identifier.trim();
    if (!trimmed) {
      return { ok: false, notFound: false, error: "Agent identifier cannot be empty" };
    }

    // An internal agent, live or recently archived, is addressable by its exact
    // id and nothing else: the caller that created it holds the id, and no
    // listing ever includes it.
    if (this.agentManager.getAgent(trimmed) || this.agentManager.getRetiredInternalAgent(trimmed)) {
      return { ok: true, agentId: trimmed };
    }

    const stored = await this.agentStorage.list();
    const storedRecords = stored.filter((record) => !record.internal);
    const knownIds = new Set<string>();
    for (const record of storedRecords) {
      knownIds.add(record.id);
    }
    for (const agent of this.agentManager.listAgents()) {
      knownIds.add(agent.id);
    }

    if (knownIds.has(trimmed)) {
      return { ok: true, agentId: trimmed };
    }

    const prefixMatches = Array.from(knownIds).filter((id) => id.startsWith(trimmed));
    if (prefixMatches.length === 1) {
      return { ok: true, agentId: prefixMatches[0] };
    }
    if (prefixMatches.length > 1) {
      return {
        ok: false,
        notFound: false,
        error: `Agent identifier "${trimmed}" is ambiguous (${prefixMatches
          .slice(0, 5)
          .map((id) => id.slice(0, 8))
          .join(", ")}${prefixMatches.length > 5 ? ", …" : ""})`,
      };
    }

    const titleMatches = storedRecords.filter((record) => record.title === trimmed);
    if (titleMatches.length === 1) {
      return { ok: true, agentId: titleMatches[0].id };
    }
    if (titleMatches.length > 1) {
      return {
        ok: false,
        notFound: false,
        error: `Agent title "${trimmed}" is ambiguous (${titleMatches
          .slice(0, 5)
          .map((r) => r.id.slice(0, 8))
          .join(", ")}${titleMatches.length > 5 ? ", …" : ""})`,
      };
    }

    return { ok: false, notFound: true, error: `Agent not found: ${trimmed}` };
  }

  /**
   * An agent that is no longer live, in its settled form: the retained snapshot
   * of a recently archived internal agent, else its stored record. Null when
   * neither exists, and for a stored internal record, which is never served.
   */
  async readSettledAgent(
    agentId: string,
  ): Promise<{ record: StoredAgentRecord; lastMessage: string | null } | null> {
    const retired = this.agentManager.getRetiredInternalAgent(agentId);
    if (retired) {
      return { record: retired.record, lastMessage: retired.lastMessage };
    }
    const record = await this.agentStorage.get(agentId);
    if (!record || record.internal) {
      return null;
    }
    return { record, lastMessage: null };
  }

  async getAgentPayloadById(agentId: string): Promise<AgentSnapshotPayload | null> {
    const live = this.agentManager.getAgent(agentId);
    if (live) {
      const payload = await this.host.buildAgentPayload(live);
      return this.host.isProviderVisibleToClient(payload.provider) ? payload : null;
    }

    const settled = await this.readSettledAgent(agentId);
    if (!settled) {
      return null;
    }
    const payload = this.host.buildStoredAgentPayload(settled.record);
    return this.host.isProviderVisibleToClient(payload.provider) ? payload : null;
  }

  async resolveDelegationRootWorkspaceId(agentId: string): Promise<string | null> {
    const seen = new Set<string>();
    let currentAgentId = agentId;

    while (true) {
      if (seen.has(currentAgentId)) {
        return null;
      }
      seen.add(currentAgentId);

      const live = this.agentManager.getAgent(currentAgentId);
      const source = live ?? (await this.agentStorage.get(currentAgentId));
      if (!source) {
        return null;
      }
      if ("archivedAt" in source && source.archivedAt) {
        return null;
      }

      const parentAgentId = getParentAgentIdFromLabels(source.labels);
      if (!parentAgentId) {
        return source.workspaceId ?? null;
      }
      currentAgentId = parentAgentId;
    }
  }

  async handleFetchAgents(
    request: Extract<SessionInboundMessage, { type: "fetch_agents_request" }>,
  ): Promise<void> {
    const owner = request.subscribe
      ? this.delivery.begin("agents", request.subscribe.subscriptionId, (id) => {
          this.agentUpdates.clearSubscription(id);
          this.host.refreshObservationProducers();
        })
      : null;
    const subscriptionId = owner?.responseId;
    try {
      if (owner) {
        this.agentUpdates.beginSubscription({
          subscriptionId: owner.id,
          isProviderVisible: (provider) =>
            this.delivery.forSource(owner.source, () =>
              this.host.isProviderVisibleToClient(provider),
            ),
          filter: {
            ...request.filter,
            ...(request.includeBackground ? { includeBackground: true } : {}),
          },
          syncEnabled: Boolean(request.sync),
          emit: (message) => {
            if (message.type === "agent_update") owner.emit(message);
          },
        });
        this.host.refreshObservationProducers();
      }

      const payload = request.sync
        ? await this.fetchEntries.readSync(request)
        : await this.listFetchAgentsEntries(request);
      const snapshotUpdatedAtByAgentId = new Map<string, number>();
      for (const entry of payload.entries) {
        const parsedUpdatedAt = Date.parse(entry.agent.updatedAt);
        if (!Number.isNaN(parsedUpdatedAt)) {
          snapshotUpdatedAtByAgentId.set(entry.agent.id, parsedUpdatedAt);
        }
      }

      this.host.emit({
        type: "fetch_agents_response",
        payload: {
          requestId: request.requestId,
          ...(subscriptionId ? { subscriptionId } : {}),
          ...payload,
        },
      });

      if (subscriptionId) {
        this.agentUpdates.flushBootstrapped(owner!.id, { snapshotUpdatedAtByAgentId });
      }
    } catch (error) {
      if (subscriptionId) {
        await owner?.release();
      }
      const code = error instanceof SessionRequestError ? error.code : "fetch_agents_failed";
      const message = error instanceof Error ? error.message : "Failed to fetch agents";
      this.logger.error({ err: error }, "Failed to handle fetch_agents_request");
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

  async handleFetchAgentHistory(
    request: Extract<SessionInboundMessage, { type: "fetch_agent_history_request" }>,
  ): Promise<void> {
    try {
      const payload = await this.listFetchAgentsEntries(request);
      this.host.emit({
        type: "fetch_agent_history_response",
        payload: {
          requestId: request.requestId,
          ...payload,
        },
      });
    } catch (error) {
      const code = error instanceof SessionRequestError ? error.code : "fetch_agent_history_failed";
      const message = error instanceof Error ? error.message : "Failed to fetch agent history";
      this.logger.error({ err: error }, "Failed to handle fetch_agent_history_request");
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

  async handleFetchRecentProviderSessions(
    request: Extract<SessionInboundMessage, { type: "fetch_recent_provider_sessions_request" }>,
  ): Promise<void> {
    try {
      const result = await listImportableProviderSessions({
        request,
        agentManager: this.agentManager,
        agentStorage: this.agentStorage,
        providerSnapshotManager: this.providerSnapshotManager,
      });
      this.host.emit({
        type: "fetch_recent_provider_sessions_response",
        payload: {
          requestId: request.requestId,
          entries: result.entries,
          ...(result.filteredAlreadyImportedCount > 0
            ? { filteredAlreadyImportedCount: result.filteredAlreadyImportedCount }
            : {}),
          ...(result.providerErrors.length > 0 ? { providerErrors: result.providerErrors } : {}),
        },
      });
    } catch (error) {
      const code =
        error instanceof ImportSessionsRequestError
          ? error.code
          : "fetch_recent_provider_sessions_failed";
      const message =
        error instanceof Error ? error.message : "Failed to fetch recent provider sessions";
      this.logger.error({ err: error }, "Failed to handle fetch_recent_provider_sessions_request");
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

  async handleFetchAgent(agentIdOrIdentifier: string, requestId: string): Promise<void> {
    // An unknown agent is a null agent, not an error. Errors are for empty or ambiguous identifiers.
    const resolved = await this.resolveAgentIdentifier(agentIdOrIdentifier);
    if (!resolved.ok) {
      this.host.emit({
        type: "fetch_agent_response",
        payload: {
          requestId,
          agent: null,
          project: null,
          error: resolved.notFound ? null : resolved.error,
        },
      });
      return;
    }

    const agent = await this.getAgentPayloadById(resolved.agentId);
    if (!agent) {
      this.host.emit({
        type: "fetch_agent_response",
        payload: { requestId, agent: null, project: null, error: null },
      });
      return;
    }

    const project = agent.workspaceId
      ? await this.host.buildProjectPlacementForWorkspaceId(agent.workspaceId)
      : null;
    this.host.emit({
      type: "fetch_agent_response",
      payload: { requestId, agent, project, error: null },
    });
  }

  async prepareAgentMessage(agentId: string, text: string): Promise<void> {
    await ensureAgentLoaded(agentId, {
      agentManager: this.agentManager,
      agentStorage: this.agentStorage,
      logger: this.logger,
    });
    const stored = await this.agentStorage.get(agentId);
    if (stored && !stored.title && !stored.lastUserMessageAt) {
      const { provisionalTitle } = resolveCreateAgentTitles({ initialPrompt: text });
      if (provisionalTitle) await this.agentManager.setTitle(agentId, provisionalTitle);
    }
  }

  async handleSendAgentMessageRequest(
    msg: Extract<SessionInboundMessage, { type: "send_agent_message_request" }>,
  ): Promise<void> {
    const resolved = await this.resolveAgentIdentifier(msg.agentId);
    if (!resolved.ok) {
      this.host.emit({
        type: "send_agent_message_response",
        payload: {
          requestId: msg.requestId,
          agentId: msg.agentId,
          accepted: false,
          error: resolved.error,
        },
      });
      return;
    }

    try {
      const agentId = resolved.agentId;

      const prompt = buildAgentPrompt(msg.text, msg.images, msg.attachments);
      this.logger.trace(
        {
          agentId,
          messageId: msg.messageId,
          activeTurnBehavior: msg.activeTurnBehavior,
          textPrefix: msg.text.slice(0, 80),
        },
        "agent.session.send_agent_message",
      );
      const send = async () => {
        const result = await sendPromptToAgent({
          agentManager: this.agentManager,
          agentStorage: this.agentStorage,
          agentId,
          prompt,
          source: msg.sourceAgentId
            ? { kind: "agent-message", agentId: msg.sourceAgentId }
            : undefined,
          messageId: msg.messageId,
          activeTurnBehavior: msg.activeTurnBehavior ?? "interrupt",
          clearPendingPermissions: true,
          logger: this.logger,
        });
        if (result.disposition === "turn_started") {
          await waitForAgentRunStartWithTimeout(
            this.agentManager,
            agentId,
            this.delivery.requestSignal,
          );
        }
      };
      if (msg.messageId) {
        await this.messageReceipts.send({
          agentId,
          messageId: msg.messageId,
          request: {
            prompt,
            sourceAgentId: msg.sourceAgentId,
            activeTurnBehavior: msg.activeTurnBehavior ?? "interrupt",
          },
          prepare: async () => {
            if (!msg.sourceAgentId) await this.prepareAgentMessage(agentId, msg.text);
          },
          send,
        });
      } else {
        await send();
      }

      this.host.emit({
        type: "send_agent_message_response",
        payload: {
          requestId: msg.requestId,
          agentId,
          accepted: true,
          error: null,
        },
      });
    } catch (error) {
      if (this.delivery.requestSignal.aborted) return;
      this.host.handleAgentRunError(resolved.agentId, error, "Failed to send agent message");
      this.host.emit({
        type: "send_agent_message_response",
        payload: {
          requestId: msg.requestId,
          agentId: resolved.agentId,
          accepted: false,
          error: errorToFriendlyMessage(error),
        },
      });
    }
  }

  async handleWaitForFinish(
    agentIdOrIdentifier: string,
    requestId: string,
    timeoutMs?: number,
  ): Promise<void> {
    const sourceSignal = this.delivery.requestSignal;
    sourceSignal.throwIfAborted();
    const resolved = await this.resolveAgentIdentifier(agentIdOrIdentifier);
    if (!resolved.ok) {
      this.host.emit({
        type: "wait_for_finish_response",
        payload: {
          requestId,
          status: "error",
          final: null,
          error: resolved.error,
          lastMessage: null,
        },
      });
      return;
    }

    const agentId = resolved.agentId;
    const live = this.agentManager.getAgent(agentId);
    if (!live) {
      const settled = await this.readSettledAgent(agentId);
      if (!settled) {
        this.host.emit({
          type: "wait_for_finish_response",
          payload: {
            requestId,
            status: "error",
            final: null,
            error: `Agent not found: ${agentId}`,
            lastMessage: null,
          },
        });
        return;
      }
      const { record, lastMessage } = settled;
      const final = this.host.buildStoredAgentPayload(record);
      let status: "permission" | "error" | "idle";
      if (record.attentionReason === "permission") {
        status = "permission";
      } else if (record.lastStatus === "error") {
        status = "error";
      } else {
        status = "idle";
      }
      const error = resolveWaitForFinishError({ status, final });
      this.host.emit({
        type: "wait_for_finish_response",
        payload: { requestId, status, final, error, lastMessage },
      });
      return;
    }

    const abortController = new AbortController();
    const hasTimeout = typeof timeoutMs === "number" && timeoutMs > 0;
    const timeoutHandle = hasTimeout
      ? setTimeout(() => {
          abortController.abort("timeout");
        }, timeoutMs)
      : null;

    try {
      let result = await this.agentManager.waitForAgentEvent(agentId, {
        signal: AbortSignal.any([abortController.signal, sourceSignal]),
        waitForActive: true,
      });
      let final = await this.getAgentPayloadById(agentId);
      if (!final) {
        throw new Error(`Agent ${agentId} disappeared while waiting`);
      }

      let status: "permission" | "error" | "idle";
      if (result.permission) {
        status = "permission";
      } else if (result.status === "error") {
        status = "error";
      } else {
        status = "idle";
      }
      const error = resolveWaitForFinishError({ status, final });

      this.host.emit({
        type: "wait_for_finish_response",
        payload: { requestId, status, final, error, lastMessage: result.lastMessage },
      });
    } catch (error) {
      if (sourceSignal.aborted) return;
      const isAbort =
        error instanceof Error &&
        (error.name === "AbortError" || error.message.toLowerCase().includes("aborted"));
      if (!isAbort) {
        const message = errorToFriendlyMessage(error);
        this.logger.error({ err: error, agentId }, "wait_for_finish_request failed");
        const final = await this.getAgentPayloadById(agentId);
        this.host.emit({
          type: "wait_for_finish_response",
          payload: {
            requestId,
            status: "error",
            final,
            error: message,
            lastMessage: null,
          },
        });
        return;
      }

      const final = await this.getAgentPayloadById(agentId);
      if (!final) {
        throw new Error(`Agent ${agentId} disappeared while waiting`, { cause: error });
      }
      this.host.emit({
        type: "wait_for_finish_response",
        payload: { requestId, status: "timeout", final, error: null, lastMessage: null },
      });
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }
}
