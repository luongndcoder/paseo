import { describe, expect, it } from "vitest";
import type { SubagentRow } from "@/subagents/select";
import { isRowActive } from "./sidebar-workspace-agent-tree";

function paseoRow(overrides: Partial<Extract<SubagentRow, { kind: "paseo" }>> = {}) {
  return {
    kind: "paseo",
    address: { serverId: "server-1", agentId: "agent-1" },
    id: "agent-1",
    provider: "claude",
    title: "Builder",
    description: null,
    subtitle: null,
    status: "idle",
    turn: { phase: "idle", cancellationRequestId: null },
    requiresAttention: false,
    createdAt: new Date(0),
    ...overrides,
  } as Extract<SubagentRow, { kind: "paseo" }>;
}

describe("isRowActive", () => {
  it("keeps a working agent in the working group", () => {
    expect(
      isRowActive(
        paseoRow({
          status: "running",
          turn: { phase: "open", turnId: null, startedAt: null, cancellationRequestId: null },
        }),
      ),
    ).toBe(true);
  });

  it("keeps an agent that needs the user in the working group", () => {
    expect(isRowActive(paseoRow({ requiresAttention: true }))).toBe(true);
  });

  it("moves a finished agent out of the working group", () => {
    expect(isRowActive(paseoRow({ status: "idle" }))).toBe(false);
    expect(isRowActive(paseoRow({ status: "error" }))).toBe(false);
  });

  it("moves an agent the daemon left running, with no open turn, out of the working group", () => {
    // The daemon did not clear the status when the agent stopped: the row's icon and the badge
    // already show it as done, so the tree must not keep it on top.
    expect(
      isRowActive(
        paseoRow({ status: "running", turn: { phase: "idle", cancellationRequestId: null } }),
      ),
    ).toBe(false);
  });

  it("moves a closed agent out of the working group", () => {
    expect(
      isRowActive(
        paseoRow({ status: "closed", turn: { phase: "idle", cancellationRequestId: null } }),
      ),
    ).toBe(false);
  });

  it("keeps an agent that is starting up in the working group", () => {
    expect(
      isRowActive(
        paseoRow({ status: "initializing", turn: { phase: "idle", cancellationRequestId: null } }),
      ),
    ).toBe(true);
  });
});
