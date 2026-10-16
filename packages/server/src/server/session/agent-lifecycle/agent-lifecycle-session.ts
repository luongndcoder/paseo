import type pino from "pino";
import { v4 as uuidv4 } from "uuid";
import { getErrorMessage } from "@getpaseo/protocol/error-utils";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import type { AgentSnapshotPayload } from "../../messages.js";
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
import { cancelAgentRunCommand } from "../../agent/lifecycle-command.js";
import { importProviderSession, normalizeImportAgentRequest } from "../../agent/import-sessions.js";
import type { AgentPersistenceHandle, AgentProvider } from "../../agent/agent-sdk-types.js";
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
}

export interface AgentLifecycleSessionOptions {
  host: AgentLifecycleSessionHost;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  workspaceProvisioning: WorkspaceProvisioningService;
  logger: pino.Logger;
}

function errorToFriendlyMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown error";
}

/**
 * Bring an agent back or stop it: resume from a persistence handle, import a
 * provider session, refresh from persistence, and cancel the running turn.
 */
export class AgentLifecycleSession {
  private readonly host: AgentLifecycleSessionHost;
  private readonly agentManager: AgentManager;
  private readonly agentStorage: AgentStorage;
  private readonly workspaceProvisioning: WorkspaceProvisioningService;
  private readonly logger: pino.Logger;

  constructor(options: AgentLifecycleSessionOptions) {
    this.host = options.host;
    this.agentManager = options.agentManager;
    this.agentStorage = options.agentStorage;
    this.workspaceProvisioning = options.workspaceProvisioning;
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
}
