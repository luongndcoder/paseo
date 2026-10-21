import { describe, expect, it, vi } from "vitest";
import type { SessionOutboundMessage } from "../../messages.js";
import type { WorkspaceLabelService } from "../../workspace-labels/index.js";
import { WorkspaceLabelSession } from "./workspace-label-session.js";

function createSession(service: Partial<WorkspaceLabelService> | null) {
  const emitted: SessionOutboundMessage[] = [];
  const session = new WorkspaceLabelSession({
    host: {
      emit: (msg) => emitted.push(msg),
      delivery: { begin: vi.fn() } as never,
      createUnavailableError: () => new Error("Workspace labels unavailable"),
      errorCode: () => "test_code",
    },
    service: service as WorkspaceLabelService | null,
  });
  return { session, emitted };
}

describe("WorkspaceLabelSession", () => {
  it("emits the delete response with the service result", async () => {
    const { session, emitted } = createSession({
      delete: vi.fn().mockResolvedValue({ deleted: true }),
    });
    await session.handleDelete({
      type: "workspace.label.delete.request",
      requestId: "r1",
      name: "x",
    } as never);
    expect(emitted).toEqual([
      {
        type: "workspace.label.delete.response",
        payload: { requestId: "r1", deleted: true },
      },
    ]);
  });

  it("emits rpc_error when the service is unavailable", async () => {
    const { session, emitted } = createSession(null);
    await session.handleDeleteInspection({
      type: "workspace.label.delete.inspect.request",
      requestId: "r2",
      name: "x",
    } as never);
    expect(emitted).toEqual([
      {
        type: "rpc_error",
        payload: {
          requestId: "r2",
          requestType: "workspace.label.delete.inspect.request",
          code: "test_code",
          error: "Workspace labels unavailable",
        },
      },
    ]);
  });
});
