import type { CheckoutCommit } from "@getpaseo/protocol/messages";

/**
 * Non-purple high-contrast JetBrains-inspired branch lane palette.
 * Strictly avoids violet/purple hues per design rules.
 */
export const GRAPH_LANE_COLORS = [
  "#10b981", // Emerald
  "#06b6d4", // Cyan
  "#f59e0b", // Amber
  "#f43f5e", // Rose / Coral
  "#0ea5e9", // Sky Blue
  "#84cc16", // Lime
  "#f97316", // Orange
  "#14b8a6", // Teal
] as const;

export interface GraphSegment {
  fromLane: number;
  toLane: number;
  /**
   * "top-to-center": incoming from row top to commit node center
   * "center-to-bottom": outgoing from commit node center to row bottom
   * "top-to-bottom": pass-through lane across the entire row
   */
  span: "top-to-center" | "center-to-bottom" | "top-to-bottom";
  colorIndex: number;
}

export interface CommitGraphRowLayout {
  commit: CheckoutCommit;
  rowIndex: number;
  lane: number;
  colorIndex: number;
  isMerge: boolean;
  segments: GraphSegment[];
  laneCount: number;
}

export interface CommitGraphLayoutResult {
  rows: CommitGraphRowLayout[];
  maxLanes: number;
}

interface ActiveLane {
  sha: string;
  colorIndex: number;
}

function findOrAllocateLane(lanes: Array<ActiveLane | null>, reservedLane?: number): number {
  for (let i = 0; i < lanes.length; i++) {
    if (lanes[i] === null && i !== reservedLane) {
      return i;
    }
  }
  lanes.push(null);
  return lanes.length - 1;
}

function trimTrailingNulls(lanes: Array<ActiveLane | null>): void {
  while (lanes.length > 0 && lanes[lanes.length - 1] === null) {
    lanes.pop();
  }
}

/**
 * Computes a topological multi-branch lane layout for a chronological commit list.
 */
export function computeCommitGraphLayout(commits: CheckoutCommit[]): CommitGraphLayoutResult {
  if (commits.length === 0) {
    return { rows: [], maxLanes: 0 };
  }

  const commitSet = new Set<string>(commits.map((c) => c.sha));
  const lanes: Array<ActiveLane | null> = [];
  let nextColorIndex = 0;
  let maxLanes = 1;
  const rows: CommitGraphRowLayout[] = [];

  for (let rowIndex = 0; rowIndex < commits.length; rowIndex++) {
    const commit = commits[rowIndex];
    const lanesBefore = lanes.map((slot) => (slot ? { ...slot } : null));
    const segments: GraphSegment[] = [];

    // 1. Find all lanes currently expecting this commit SHA
    const matchingLanes: number[] = [];
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i]?.sha === commit.sha) {
        matchingLanes.push(i);
      }
    }

    let commitLane: number;
    let commitColorIndex: number;

    if (matchingLanes.length > 0) {
      commitLane = matchingLanes[0];
      commitColorIndex = lanes[commitLane]!.colorIndex;

      // Incoming segments from all matching lanes to the commit node center
      for (const laneIdx of matchingLanes) {
        const slotColor = lanesBefore[laneIdx]?.colorIndex ?? commitColorIndex;
        segments.push({
          fromLane: laneIdx,
          toLane: commitLane,
          span: "top-to-center",
          colorIndex: slotColor,
        });
        if (laneIdx !== commitLane) {
          lanes[laneIdx] = null;
        }
      }
    } else {
      commitLane = findOrAllocateLane(lanes);
      commitColorIndex = nextColorIndex % GRAPH_LANE_COLORS.length;
      nextColorIndex++;
    }

    // 2. Pass-through lanes that do not touch this commit
    for (let i = 0; i < lanesBefore.length; i++) {
      const beforeSlot = lanesBefore[i];
      if (!beforeSlot) continue;
      if (matchingLanes.includes(i)) continue;
      segments.push({
        fromLane: i,
        toLane: i,
        span: "top-to-bottom",
        colorIndex: beforeSlot.colorIndex,
      });
    }

    // 3. Route outgoing edges to visible parents
    const rawParents = commit.parents ?? [];
    const visibleParents = rawParents.filter((parentSha) => commitSet.has(parentSha));
    const isMerge = rawParents.length > 1;

    if (visibleParents.length === 0) {
      lanes[commitLane] = null;
    } else {
      const primaryParent = visibleParents[0];
      lanes[commitLane] = {
        sha: primaryParent,
        colorIndex: commitColorIndex,
      };
      segments.push({
        fromLane: commitLane,
        toLane: commitLane,
        span: "center-to-bottom",
        colorIndex: commitColorIndex,
      });

      // Secondary (merge) parents
      for (let pIdx = 1; pIdx < visibleParents.length; pIdx++) {
        const mergeParentSha = visibleParents[pIdx];
        const existingMergeLane = lanes.findIndex((slot) => slot?.sha === mergeParentSha);

        if (existingMergeLane !== -1) {
          const mergeColor = lanes[existingMergeLane]!.colorIndex;
          segments.push({
            fromLane: commitLane,
            toLane: existingMergeLane,
            span: "center-to-bottom",
            colorIndex: mergeColor,
          });
        } else {
          const newMergeLane = findOrAllocateLane(lanes, commitLane);
          const mergeColor = nextColorIndex % GRAPH_LANE_COLORS.length;
          nextColorIndex++;
          lanes[newMergeLane] = {
            sha: mergeParentSha,
            colorIndex: mergeColor,
          };
          segments.push({
            fromLane: commitLane,
            toLane: newMergeLane,
            span: "center-to-bottom",
            colorIndex: mergeColor,
          });
        }
      }
    }

    trimTrailingNulls(lanes);
    const rowLaneCount = Math.max(
      commitLane + 1,
      lanesBefore.length,
      lanes.length,
      ...segments.map((s) => Math.max(s.fromLane, s.toLane) + 1),
    );
    if (rowLaneCount > maxLanes) {
      maxLanes = rowLaneCount;
    }

    rows.push({
      commit,
      rowIndex,
      lane: commitLane,
      colorIndex: commitColorIndex,
      isMerge,
      segments,
      laneCount: rowLaneCount,
    });
  }

  return { rows, maxLanes };
}
