import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import type { WorkspaceLabelService } from "../../workspace-labels/index.js";
import type { SessionDelivery } from "../owned-subscriptions/index.js";

export interface WorkspaceLabelSessionHost {
  emit(msg: SessionOutboundMessage): void;
  readonly delivery: Pick<SessionDelivery, "begin">;
  /** Error thrown when no label service is configured for this session. */
  createUnavailableError(): Error;
  /** Maps a failure to the rpc_error code reported to the client. */
  errorCode(error: unknown): string;
}

export interface WorkspaceLabelSessionOptions {
  host: WorkspaceLabelSessionHost;
  service: WorkspaceLabelService | null;
}

/**
 * Workspace label RPCs: list (optionally as an owned live subscription),
 * assignment, update, delete and delete-inspection. Reaches no state beyond the
 * injected label service, the owned-subscription delivery and the outbound channel.
 */
export class WorkspaceLabelSession {
  private readonly host: WorkspaceLabelSessionHost;
  private readonly service: WorkspaceLabelService | null;

  constructor(options: WorkspaceLabelSessionOptions) {
    this.host = options.host;
    this.service = options.service;
  }

  private requireWorkspaceLabels(): WorkspaceLabelService {
    if (!this.service) {
      throw this.host.createUnavailableError();
    }
    return this.service;
  }

  private emitWorkspaceLabelError(
    request: { requestId: string; type: string },
    error: unknown,
  ): void {
    this.host.emit({
      type: "rpc_error",
      payload: {
        requestId: request.requestId,
        requestType: request.type,
        code: this.host.errorCode(error),
        error: error instanceof Error ? error.message : "Workspace label operation failed",
      },
    });
  }

  async handleList(
    request: Extract<SessionInboundMessage, { type: "workspace.label.list.request" }>,
  ): Promise<void> {
    const service = this.requireWorkspaceLabels();
    if (!request.subscribe) {
      this.host.emit({
        type: "workspace.label.list.response",
        payload: { requestId: request.requestId, ...(await service.list(request.sync)) },
      });
      return;
    }
    let bootstrap: ReturnType<typeof service.subscribe> | undefined;
    const owner = this.host.delivery.begin("labels", request.subscribe.subscriptionId, async () => {
      await bootstrap?.then(
        (subscription) => subscription.unsubscribe(),
        () => undefined,
      );
    });
    try {
      type LiveChange = Parameters<Parameters<typeof service.subscribe>[0]["onChange"]>[0];
      const pending = new Map<string, LiveChange>();
      let ready = false;
      const emitChange = (change: LiveChange): void => {
        owner.emit({
          type: "workspace.label.update",
          payload: change,
        });
      };
      bootstrap = service.subscribe({
        cursor: request.sync,
        onChange: (change) => {
          if (owner.signal.aborted) return;
          if (!ready)
            pending.set(change.kind === "upsert" ? change.label.name : change.name, change);
          else emitChange(change);
        },
      });
      const subscription = await bootstrap;
      if (owner.signal.aborted) return;
      this.host.emit({
        type: "workspace.label.list.response",
        payload: {
          requestId: request.requestId,
          subscriptionId: owner.responseId,
          ...subscription.snapshot,
        },
      });
      ready = true;
      for (const change of pending.values()) {
        if (change.seq > subscription.snapshot.sync.headSeq) emitChange(change);
      }
      pending.clear();
    } catch (error) {
      await owner.release();
      this.emitWorkspaceLabelError(request, error);
    }
  }

  async handleAssignment(
    request: Extract<SessionInboundMessage, { type: "workspace.label.assignment.set.request" }>,
  ): Promise<void> {
    try {
      const result = await this.requireWorkspaceLabels().setAssignment(request);
      this.host.emit({
        type: "workspace.label.assignment.set.response",
        payload: { requestId: request.requestId, ...result },
      });
    } catch (error) {
      this.emitWorkspaceLabelError(request, error);
    }
  }

  async handleUpdate(
    request: Extract<SessionInboundMessage, { type: "workspace.label.update.request" }>,
  ): Promise<void> {
    try {
      const result = await this.requireWorkspaceLabels().update(request);
      this.host.emit({
        type: "workspace.label.update.response",
        payload: { requestId: request.requestId, ...result },
      });
    } catch (error) {
      this.emitWorkspaceLabelError(request, error);
    }
  }

  async handleDelete(
    request: Extract<SessionInboundMessage, { type: "workspace.label.delete.request" }>,
  ): Promise<void> {
    try {
      const result = await this.requireWorkspaceLabels().delete(request.name);
      this.host.emit({
        type: "workspace.label.delete.response",
        payload: { requestId: request.requestId, ...result },
      });
    } catch (error) {
      this.emitWorkspaceLabelError(request, error);
    }
  }

  async handleDeleteInspection(
    request: Extract<SessionInboundMessage, { type: "workspace.label.delete.inspect.request" }>,
  ): Promise<void> {
    try {
      const affectedWorkspaceCount = await this.requireWorkspaceLabels().countAffectedWorkspaces(
        request.name,
      );
      this.host.emit({
        type: "workspace.label.delete.inspect.response",
        payload: { requestId: request.requestId, affectedWorkspaceCount },
      });
    } catch (error) {
      this.emitWorkspaceLabelError(request, error);
    }
  }
}
