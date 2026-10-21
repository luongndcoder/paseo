import { describe, expect, it, vi } from "vitest";
import type { SessionOutboundMessage } from "../../messages.js";
import { WorkspaceSession, type WorkspaceSessionOptions } from "./workspace-session.js";

function createSession(overrides: Partial<WorkspaceSessionOptions> = {}) {
  const emitted: SessionOutboundMessage[] = [];
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const session = new WorkspaceSession({
    host: {
      emit: (msg) => emitted.push(msg),
      wantsEvent: () => false,
      isCleanedUp: () => false,
      getAppVersion: () => null,
      refreshObservationProducers: vi.fn(),
      emitProjectUpdate: vi.fn(),
      buildProjectPlacementForWorkspace: vi.fn(),
      buildWorkspaceScriptPayloadSnapshot: vi.fn(),
    },
    projectRegistry: { get: vi.fn().mockResolvedValue(null) },
    workspaceRegistry: { list: vi.fn().mockResolvedValue([]) },
    logger,
    ...overrides,
  } as unknown as WorkspaceSessionOptions);
  return { session, emitted };
}

describe("WorkspaceSession", () => {
  it("rejects renaming an unknown project through its response", async () => {
    const { session, emitted } = createSession();
    await session.handleProjectRenameRequest("p1", "New", "r1");
    expect(emitted).toEqual([
      {
        type: "project.rename.response",
        payload: {
          requestId: "r1",
          projectId: "p1",
          accepted: false,
          customName: null,
          error: "Project not found",
        },
      },
    ]);
  });

  it("reports an unknown project icon through its response", async () => {
    const { session, emitted } = createSession();
    await session.handleProjectIconGetRequest("p1", "r2");
    expect(emitted).toEqual([
      {
        type: "project.icon.get.response",
        payload: { projectId: "p1", icon: null, error: "Project not found", requestId: "r2" },
      },
    ]);
  });
});
