import { describe, expect, it } from "vitest";
import type { SubagentRow } from "@/subagents/select";
import {
  buildSubagentForest,
  deriveSubagentRole,
  getSlpRolePresentation,
  isRowActive,
  partitionSubagentRows,
} from "./sidebar-workspace-agent-tree";

function paseoRow(overrides: Partial<Extract<SubagentRow, { kind: "paseo" }>> = {}) {
  return {
    kind: "paseo",
    address: { serverId: "server-1", agentId: "agent-1" },
    id: "agent-1",
    parentAgentId: null,
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

describe("getSlpRolePresentation", () => {
  it("gives every seat its own label, icon and color block", () => {
    const roles = ["supervisor", "lead", "builder", "checker"] as const;
    const presentations = roles.map(getSlpRolePresentation);
    expect(presentations.map((presentation) => presentation.label)).toEqual([
      "Supervisor",
      "Lead",
      "Builder",
      "Checker",
    ]);
    // Colors must differ per seat, or the seats blur back together. Icons are stubbed to one
    // component in tests, so only check each seat names a real icon here.
    expect(presentations.every((presentation) => presentation.Icon)).toBe(true);
    expect(new Set(presentations.map((presentation) => presentation.tone.text)).size).toBe(4);
    for (const presentation of presentations) {
      expect(presentation.tone.text).toMatch(/^#[0-9a-f]{6}$/);
      expect(presentation.tone.border).toContain("rgba(");
      expect(presentation.tone.bg).toContain("rgba(");
    }
  });
});

describe("buildSubagentForest", () => {
  const lead = (id: string, at = 0) =>
    paseoRow({
      id,
      address: { serverId: "s", agentId: id },
      provider: "slp-lead",
      createdAt: new Date(at),
    });
  const build = (id: string, parent: string | null, provider = "slp-opencode-builder", at = 0) =>
    paseoRow({
      id,
      address: { serverId: "s", agentId: id },
      parentAgentId: parent,
      provider,
      createdAt: new Date(at),
    });

  it("nests builders under their lead and keeps orphans on top", () => {
    const forest = buildSubagentForest([
      build("b1", "lead-1"),
      lead("lead-1"),
      build("orphan", "gone"),
      build("b2", "lead-1"),
    ]);
    expect(forest.map((node) => node.row.id)).toEqual(["lead-1", "orphan"]);
    expect(forest[0]?.children.map((child) => child.row.id)).toEqual(["b1", "b2"]);
  });

  it("sorts siblings by seat, oldest first", () => {
    const forest = buildSubagentForest([
      build("check", "lead-1", "slp-claude-checker", 5),
      build("build", "lead-1", "slp-opencode-builder", 9),
      lead("lead-1"),
    ]);
    expect(forest[0]?.children.map((child) => child.row.id)).toEqual(["build", "check"]);
  });

  it("refuses to loop on cyclic parents", () => {
    const forest = buildSubagentForest([build("a", "b"), build("b", "a")]);
    const ids: string[] = [];
    const walk = (nodes: typeof forest): void => {
      for (const node of nodes) {
        ids.push(node.row.id);
        walk(node.children);
      }
    };
    walk(forest);
    expect(ids.sort()).toEqual(["a", "b"]);
  });
});
