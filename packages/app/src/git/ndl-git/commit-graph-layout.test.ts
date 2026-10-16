import { describe, expect, it } from "vitest";
import type { CheckoutCommit } from "@getpaseo/protocol/messages";

import { computeCommitGraphLayout, GRAPH_LANE_COLORS } from "./commit-graph-layout";

function makeCommit(
  partial: Partial<CheckoutCommit> & Pick<CheckoutCommit, "sha" | "subject">,
): CheckoutCommit {
  return {
    shortSha: partial.sha.slice(0, 7),
    authorName: "Dev",
    authorDate: "2026-10-14T12:00:00Z",
    isOnRemote: true,
    files: [],
    ...partial,
  };
}

describe("computeCommitGraphLayout", () => {
  it("computes single-lane layout for linear commit history", () => {
    const commits: CheckoutCommit[] = [
      makeCommit({
        sha: "c3",
        subject: "Third commit",
        parents: ["c2"],
        refs: ["HEAD -> main"],
      }),
      makeCommit({
        sha: "c2",
        subject: "Second commit",
        parents: ["c1"],
        refs: [],
      }),
      makeCommit({
        sha: "c1",
        subject: "Initial commit",
        parents: [],
        refs: [],
      }),
    ];

    const result = computeCommitGraphLayout(commits);
    expect(result.maxLanes).toBe(1);
    expect(result.rows).toHaveLength(3);
    expect(result.rows[0].lane).toBe(0);
    expect(result.rows[1].lane).toBe(0);
    expect(result.rows[2].lane).toBe(0);
  });

  it("allocates parallel lane for merge commits and converges at common ancestor", () => {
    const commits: CheckoutCommit[] = [
      makeCommit({
        sha: "m1",
        subject: "Merge feature into main",
        parents: ["c2", "f1"],
        refs: ["HEAD -> main"],
      }),
      makeCommit({
        sha: "f1",
        subject: "Feature work",
        parents: ["c1"],
        refs: ["feature"],
      }),
      makeCommit({
        sha: "c2",
        subject: "Mainline work",
        parents: ["c1"],
        refs: [],
      }),
      makeCommit({
        sha: "c1",
        subject: "Root commit",
        parents: [],
        refs: [],
      }),
    ];

    const result = computeCommitGraphLayout(commits);
    expect(result.maxLanes).toBe(2);
    expect(result.rows[0].isMerge).toBe(true);
    expect(result.rows[0].lane).toBe(0);
    expect(result.rows[1].lane).toBe(1);
    expect(result.rows[2].lane).toBe(0);
    expect(result.rows[3].lane).toBe(0);
  });

  it("does not include purple or violet colors in GRAPH_LANE_COLORS", () => {
    for (const color of GRAPH_LANE_COLORS) {
      expect(color.toLowerCase()).not.toBe("#8b5cf6");
      expect(color.toLowerCase()).not.toBe("#a855f7");
    }
  });
});
