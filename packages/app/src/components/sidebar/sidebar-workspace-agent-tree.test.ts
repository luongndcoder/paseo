import { describe, expect, it } from "vitest";
import type { SubagentRow } from "@/subagents/select";
import {
  buildRowSections,
  compareSubagentRows,
  deriveSubagentRole,
  isRowActive,
  partitionSubagentRows,
} from "./sidebar-workspace-agent-tree";

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

describe("partitionSubagentRows", () => {
  const active = (id: string) =>
    paseoRow({
      id,
      address: { serverId: "server-1", agentId: id },
      status: "running",
      turn: { phase: "open", turnId: null, startedAt: null, cancellationRequestId: null },
      createdAt: new Date(10),
    });
  const done = (id: string, at: number) =>
    paseoRow({
      id,
      address: { serverId: "server-1", agentId: id },
      status: "idle",
      createdAt: new Date(at),
    });

  it("puts working rows on top and finished rows below, newest finished last", () => {
    const rows = [done("old", 1), active("work"), done("new", 2)];
    const part = partitionSubagentRows(rows, { showAllArchived: false, activeTargetKey: null });
    expect(part.visibleActiveSubagents.map((row) => row.id)).toEqual(["work"]);
    expect(part.visibleArchivedSubagents.map((row) => row.id)).toEqual(["old", "new"]);
    expect(part.hiddenArchivedCount).toBe(0);
    expect(part.totalArchivedCount).toBe(2);
  });

  it("caps the finished group and counts the hidden older ones", () => {
    const rows = Array.from({ length: 8 }, (_, index) => done(`done-${index}`, index));
    const part = partitionSubagentRows(rows, { showAllArchived: false, activeTargetKey: null });
    expect(part.visibleArchivedSubagents.map((row) => row.id)).toEqual([
      "done-3",
      "done-4",
      "done-5",
      "done-6",
      "done-7",
    ]);
    expect(part.hiddenArchivedCount).toBe(3);
    expect(part.totalArchivedCount).toBe(8);
  });

  it("shows every finished row once the older ones are expanded", () => {
    const rows = Array.from({ length: 8 }, (_, index) => done(`done-${index}`, index));
    const part = partitionSubagentRows(rows, { showAllArchived: true, activeTargetKey: null });
    expect(part.visibleArchivedSubagents).toHaveLength(8);
    expect(part.hiddenArchivedCount).toBe(0);
  });

  it("hides every finished row when only working rows are wanted", () => {
    const rows = [active("work"), done("old", 1), done("new", 2)];
    const part = partitionSubagentRows(rows, {
      showAllArchived: false,
      activeTargetKey: null,
      hideFinished: true,
    });
    expect(part.visibleActiveSubagents.map((row) => row.id)).toEqual(["work"]);
    expect(part.visibleArchivedSubagents).toEqual([]);
    expect(part.hiddenArchivedCount).toBe(0);
    // The total stays so the switch itself stays visible.
    expect(part.totalArchivedCount).toBe(2);
  });
});

describe("deriveSubagentRole", () => {
  const roleOf = (provider: string) =>
    deriveSubagentRole(paseoRow({ provider, address: { serverId: "s", agentId: "a" } }));

  it("reads the SLP seat from the provider id", () => {
    expect(roleOf("slp-supervisor")).toBe("supervisor");
    expect(roleOf("slp-lead")).toBe("lead");
    expect(roleOf("slp-opencode-builder")).toBe("builder");
    expect(roleOf("slp-claude-builder")).toBe("builder");
    expect(roleOf("slp-claude-checker")).toBe("checker");
    expect(roleOf("slp-claude-final-reviewer")).toBe("checker");
    expect(roleOf("slp-claude-advisor")).toBe("checker");
  });

  it("leaves ordinary providers seatless", () => {
    expect(roleOf("claude")).toBeNull();
    expect(roleOf("opencode")).toBeNull();
  });
});

describe("buildRowSections", () => {
  const row = (id: string, provider: string, at: number, running = false) =>
    paseoRow({
      id,
      address: { serverId: "s", agentId: id },
      provider,
      createdAt: new Date(at),
      ...(running
        ? {
            status: "running",
            turn: { phase: "open", turnId: null, startedAt: null, cancellationRequestId: null },
          }
        : {}),
    });

  it("orders seats Lead, then Builders, then Checkers, oldest first inside a seat", () => {
    const rows = [
      row("check-new", "slp-claude-checker", 3),
      row("build-old", "slp-opencode-builder", 1),
      row("lead", "slp-lead", 0, true),
      row("build-new", "slp-opencode-builder", 2),
      row("check-old", "slp-claude-checker", 0),
      row("plain", "claude", 0),
    ];
    const sorted = [...rows].sort(compareSubagentRows);
    expect(sorted.map((entry) => entry.id)).toEqual([
      "lead",
      "build-old",
      "build-new",
      "check-old",
      "check-new",
      "plain",
    ]);
    const sections = buildRowSections(sorted);
    expect(
      sections.map((section) =>
        section.kind === "header" ? `H:${section.label}` : `R:${section.row.id}`,
      ),
    ).toEqual([
      "R:lead",
      "H:Builders · 2",
      "R:build-old",
      "R:build-new",
      "H:Checkers · 2",
      "R:check-old",
      "R:check-new",
      "R:plain",
    ]);
  });

  it("skips the header for a lone row", () => {
    const sections = buildRowSections([row("only", "slp-lead", 0, true)]);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.kind).toBe("row");
  });
});
