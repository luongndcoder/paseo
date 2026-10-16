/**
 * P4 WP0: golden vectors for directory sync (DirectorySyncService and
 * VersionedCollection): sequencing, cursors, tombstones, fingerprints,
 * generation stamps and localeCompare ordering.
 *
 *   LC_ALL=en_US.UTF-8 tsx scripts/capture-directory-fixtures.ts --out <fixtures/p4>
 */
import { DirectorySyncService } from "../src/server/directory-sync/index.js";
import { VersionedCollection } from "../src/server/directory-sync/internal/versioned-collection.js";
import { areaDir, errorSummary, resolveOutRoot, writeJson } from "./p4-fixture-utils.js";

const GENERATION = "gen-1";

// --- fixture entity builders --------------------------------------------------

const project = (projectId: string, name: string, extra: Record<string, unknown> = {}) => ({
  projectId,
  projectDisplayName: name,
  projectRootPath: `/${projectId}`,
  projectKind: "git" as const,
  ...extra,
});

const workspace = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  projectId: "prj_1",
  projectDisplayName: "Project",
  projectRootPath: "/repo",
  projectKind: "git" as const,
  workspaceKind: "local_checkout" as const,
  name,
  status: "done",
  activityAt: null,
  diffStat: null,
  ...extra,
});

const agentEntry = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  agent: {
    id,
    provider: "claude",
    cwd: "/repo",
    title,
    status: "idle",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  },
  project: {
    projectKey: "remote:github.com/acme/repo",
    projectName: "acme/repo",
    checkout: { cwd: "/repo", isGit: true },
  },
});

// --- service scenarios -------------------------------------------------------

interface Cursor {
  generation?: string;
  afterSeq?: number;
}

type SnapshotSource =
  | unknown[]
  | { gen: { count: number; prefix: string; kind: "project" | "workspace" | "agent" } };

type ServiceOp =
  | { op: "syncProjects"; snapshot: SnapshotSource; cursor: Cursor; summary?: boolean }
  | {
      op: "syncWorkspaces";
      snapshot: SnapshotSource;
      cursor: Cursor;
      includeBackground?: boolean;
      summary?: boolean;
    }
  | {
      op: "syncAgents";
      snapshot: SnapshotSource;
      cursor: Cursor;
      includeBackground?: boolean;
      summary?: boolean;
    }
  | { op: "seqProject"; update: unknown; includeSequence: boolean }
  | {
      op: "seqWorkspace";
      payload: object;
      value: unknown | null;
      id: string;
      includeSequence: boolean;
      includeBackground?: boolean;
    }
  | {
      op: "seqAgent";
      payload: object;
      value: unknown | null;
      id: string;
      includeSequence: boolean;
      includeBackground?: boolean;
    };

interface ServiceScenario {
  name: string;
  description: string;
  generation?: string;
  ops: ServiceOp[];
}

const P = project;
const W = workspace;
const A = agentEntry;
const none: Cursor = {};
const at = (afterSeq: number, generation = GENERATION): Cursor => ({ generation, afterSeq });

const SCENARIOS: ServiceScenario[] = [
  {
    name: "projects_latest_changes",
    description:
      "Initial snapshot, two upserts of the same project, then changes after seq 1 (seq 3).",
    ops: [
      { op: "syncProjects", snapshot: [P("one", "One")], cursor: none },
      {
        op: "seqProject",
        update: { kind: "upsert", project: P("one", "Renamed") },
        includeSequence: true,
      },
      {
        op: "seqProject",
        update: { kind: "upsert", project: P("one", "Latest") },
        includeSequence: true,
      },
      { op: "syncProjects", snapshot: [P("one", "Latest")], cursor: at(1) },
    ],
  },
  {
    name: "projects_hard_removal_once",
    description:
      "Removal is sequenced once; repeating it returns the same seq; the tombstone shows in removals.",
    ops: [
      { op: "syncProjects", snapshot: [P("one", "One")], cursor: none },
      { op: "seqProject", update: { kind: "remove", projectId: "one" }, includeSequence: true },
      { op: "seqProject", update: { kind: "remove", projectId: "one" }, includeSequence: true },
      { op: "syncProjects", snapshot: [], cursor: at(1) },
      {
        op: "seqProject",
        update: { kind: "remove", projectId: "never-existed" },
        includeSequence: true,
      },
    ],
  },
  {
    name: "projects_repeated_observation_same_seq",
    description:
      "Re-observing an identical value never bumps; includeSequence=false returns the bare payload.",
    ops: [
      {
        op: "seqProject",
        update: { kind: "upsert", project: P("one", "One") },
        includeSequence: true,
      },
      {
        op: "seqProject",
        update: { kind: "upsert", project: P("one", "One") },
        includeSequence: true,
      },
      {
        op: "seqProject",
        update: { kind: "upsert", project: P("one", "One") },
        includeSequence: false,
      },
      {
        op: "seqProject",
        update: { kind: "upsert", project: P("one", "Two") },
        includeSequence: false,
      },
      {
        op: "seqProject",
        update: { kind: "upsert", project: P("one", "Two") },
        includeSequence: true,
      },
    ],
  },
  {
    name: "projects_icon_revision_change",
    description: "Only the project whose projectIconRevision changed is re-sequenced.",
    ops: [
      {
        op: "syncProjects",
        snapshot: [
          P("one", "One", { projectIconRevision: "icon-a" }),
          P("two", "Two", { projectIconRevision: "icon-a" }),
        ],
        cursor: none,
      },
      {
        op: "seqProject",
        update: { kind: "upsert", project: P("one", "One", { projectIconRevision: "icon-b" }) },
        includeSequence: true,
      },
      {
        op: "syncProjects",
        snapshot: [
          P("one", "One", { projectIconRevision: "icon-b" }),
          P("two", "Two", { projectIconRevision: "icon-a" }),
        ],
        cursor: at(2),
      },
    ],
  },
  {
    name: "cursor_resolution_order",
    description:
      "generation mismatch -> generation_changed (or no_cursor when generation absent) -> missing afterSeq -> no_cursor -> readAfter; afterSeq beyond head -> cursor_expired.",
    ops: [
      { op: "syncProjects", snapshot: [P("a", "A"), P("b", "B")], cursor: none },
      {
        op: "syncProjects",
        snapshot: [P("a", "A"), P("b", "B")],
        cursor: { generation: "old-gen", afterSeq: 1 },
      },
      { op: "syncProjects", snapshot: [P("a", "A"), P("b", "B")], cursor: { afterSeq: 1 } },
      {
        op: "syncProjects",
        snapshot: [P("a", "A"), P("b", "B")],
        cursor: { generation: GENERATION },
      },
      { op: "syncProjects", snapshot: [P("a", "A"), P("b", "B")], cursor: at(2) },
      { op: "syncProjects", snapshot: [P("a", "A"), P("b", "B")], cursor: at(0) },
      { op: "syncProjects", snapshot: [P("a", "A"), P("b", "B")], cursor: at(3) },
      { op: "syncProjects", snapshot: [P("a", "A"), P("b", "B")], cursor: at(-1) },
    ],
  },
  {
    name: "generation_changed_service",
    description: "A service with another generation answers an old cursor with a snapshot.",
    generation: "new-gen",
    ops: [
      {
        op: "syncProjects",
        snapshot: [P("one", "One")],
        cursor: { generation: "old-gen", afterSeq: 10 },
      },
    ],
  },
  {
    name: "snapshot_replace_all_mutates",
    description:
      "Snapshot reads call replaceAll first: values absent from the snapshot are removed (tombstoned), changed values bump, order is seq then id.",
    ops: [
      { op: "syncProjects", snapshot: [P("a", "A"), P("b", "B"), P("c", "C")], cursor: none },
      { op: "syncProjects", snapshot: [P("c", "C2"), P("a", "A")], cursor: none },
      { op: "syncProjects", snapshot: [P("c", "C2"), P("a", "A")], cursor: at(3) },
      { op: "syncProjects", snapshot: [P("c", "C2"), P("a", "A")], cursor: at(5) },
    ],
  },
  {
    name: "workspaces_basic_and_updates",
    description:
      "Workspace snapshot, upsert, removal, includeSequence=false, entries gain syncSeq.",
    ops: [
      { op: "syncWorkspaces", snapshot: [W("w1", "one"), W("w2", "two")], cursor: none },
      {
        op: "seqWorkspace",
        payload: { kind: "upsert", workspace: W("w1", "one-renamed") },
        value: W("w1", "one-renamed"),
        id: "w1",
        includeSequence: true,
      },
      {
        op: "seqWorkspace",
        payload: { kind: "upsert", workspace: W("w3", "three") },
        value: W("w3", "three"),
        id: "w3",
        includeSequence: false,
      },
      {
        op: "seqWorkspace",
        payload: { kind: "remove", id: "w2" },
        value: null,
        id: "w2",
        includeSequence: true,
      },
      {
        op: "seqWorkspace",
        payload: { kind: "remove", id: "w2" },
        value: null,
        id: "w2",
        includeSequence: true,
      },
      { op: "syncWorkspaces", snapshot: [W("w1", "one-renamed"), W("w3", "three")], cursor: at(2) },
    ],
  },
  {
    name: "workspaces_background_generation",
    description:
      "Background-including readers see `<generation>:background` in stamps and reads; update payloads stamped with includeBackground carry the background generation while internal sequence_for uses the bare generation.",
    ops: [
      { op: "syncWorkspaces", snapshot: [W("w1", "one")], cursor: none, includeBackground: true },
      { op: "syncWorkspaces", snapshot: [W("w1", "one")], cursor: at(1), includeBackground: true },
      {
        op: "syncWorkspaces",
        snapshot: [W("w1", "one")],
        cursor: at(1, `${GENERATION}:background`),
        includeBackground: true,
      },
      {
        op: "syncWorkspaces",
        snapshot: [W("w1", "one")],
        cursor: at(1, `${GENERATION}:background`),
        includeBackground: false,
      },
      {
        op: "seqWorkspace",
        payload: { kind: "upsert" },
        value: W("w1", "one-b"),
        id: "w1",
        includeSequence: true,
        includeBackground: true,
      },
      {
        op: "seqWorkspace",
        payload: { kind: "upsert" },
        value: W("w1", "one-c"),
        id: "w1",
        includeSequence: true,
        includeBackground: false,
      },
    ],
  },
  {
    name: "background_reader_alternation",
    description:
      "Quirk: one shared collection is fed by readers with different snapshots. A non-background reader that omits a background-only workspace tombstones it; the background reader then re-adds it with a new seq.",
    ops: [
      {
        op: "syncWorkspaces",
        snapshot: [W("w1", "visible"), W("bg", "background", { background: true })],
        cursor: none,
        includeBackground: true,
      },
      {
        op: "syncWorkspaces",
        snapshot: [W("w1", "visible")],
        cursor: none,
        includeBackground: false,
      },
      {
        op: "syncWorkspaces",
        snapshot: [W("w1", "visible")],
        cursor: at(2),
        includeBackground: false,
      },
      {
        op: "syncWorkspaces",
        snapshot: [W("w1", "visible"), W("bg", "background", { background: true })],
        cursor: none,
        includeBackground: true,
      },
      {
        op: "syncWorkspaces",
        snapshot: [W("w1", "visible"), W("bg", "background", { background: true })],
        cursor: at(2, `${GENERATION}:background`),
        includeBackground: true,
      },
    ],
  },
  {
    name: "agents_basic_and_updates",
    description:
      "Agent entries are {agent, project}; ids come from agent.id; sync, upsert, remove.",
    ops: [
      { op: "syncAgents", snapshot: [A("ag1", "one"), A("ag2", "two")], cursor: none },
      {
        op: "seqAgent",
        payload: { kind: "upsert" },
        value: A("ag1", "one", { status: "running" }),
        id: "ag1",
        includeSequence: true,
      },
      {
        op: "seqAgent",
        payload: { kind: "upsert" },
        value: A("ag1", "one", { status: "running" }),
        id: "ag1",
        includeSequence: true,
      },
      {
        op: "seqAgent",
        payload: { kind: "remove" },
        value: null,
        id: "ag2",
        includeSequence: true,
      },
      {
        op: "seqAgent",
        payload: { kind: "remove" },
        value: null,
        id: "unknown",
        includeSequence: true,
      },
      { op: "syncAgents", snapshot: [A("ag1", "one", { status: "running" })], cursor: at(2) },
      { op: "syncAgents", snapshot: [A("ag1", "one", { status: "running" })], cursor: at(0) },
    ],
  },
  {
    name: "ordering_locale_compare",
    description:
      "Same-seq values are ordered by id.localeCompare (ICU, en-US). Mixed case, digits, punctuation, accents.",
    ops: [
      {
        op: "syncProjects",
        snapshot: [
          "b",
          "B",
          "a",
          "A",
          "_x",
          "-y",
          "10",
          "9",
          "2",
          "é",
          "e",
          "E",
          "Z",
          "z",
          "a b",
          "a-b",
          "a_b",
          "ab",
          "Ä",
          "ae",
        ].map((id) => P(id, `name-${id}`)),
        cursor: none,
      },
    ],
  },
  {
    name: "tombstone_cap_5000",
    description:
      "5001 removals trim the oldest tombstone: expiredThroughSeq advances to its seq, so afterSeq below it falls back to cursor_expired.",
    ops: [
      {
        op: "syncProjects",
        snapshot: { gen: { count: 5001, prefix: "p", kind: "project" } },
        cursor: none,
        summary: true,
      },
      { op: "syncProjects", snapshot: [], cursor: none, summary: true },
      { op: "syncProjects", snapshot: [], cursor: at(5001), summary: true },
      { op: "syncProjects", snapshot: [], cursor: at(5002), summary: true },
      { op: "syncProjects", snapshot: [], cursor: at(5003), summary: true },
      { op: "syncProjects", snapshot: [], cursor: at(10002), summary: true },
    ],
  },
];

function expandSnapshot(source: SnapshotSource): unknown[] {
  if (Array.isArray(source)) return source;
  const { count, prefix, kind } = source.gen;
  return Array.from({ length: count }, (_, index) => {
    const id = `${prefix}${index}`;
    if (kind === "project") return P(id, `name ${id}`);
    if (kind === "workspace") return W(id, `name ${id}`);
    return A(id, `title ${id}`);
  });
}

function summarize(result: {
  projects?: unknown[];
  entries?: unknown[];
  sync: { removals: Array<{ id: string; seq: number }> } & Record<string, unknown>;
}) {
  const values = (result.projects ?? result.entries ?? []) as Array<{ syncSeq: number }>;
  return {
    valueCount: values.length,
    firstSyncSeq: values[0]?.syncSeq ?? null,
    lastSyncSeq: values.at(-1)?.syncSeq ?? null,
    sync: { ...result.sync, removals: undefined },
    removalCount: result.sync.removals.length,
    firstRemoval: result.sync.removals[0] ?? null,
    lastRemoval: result.sync.removals.at(-1) ?? null,
  };
}

function runScenario(scenario: ServiceScenario) {
  const service = new DirectorySyncService((scenario.generation ?? GENERATION) as never);
  const results = scenario.ops.map((op) => {
    let result: unknown;
    try {
      switch (op.op) {
        case "syncProjects": {
          const out = service.synchronizeProjects(expandSnapshot(op.snapshot) as never, op.cursor);
          result = op.summary ? summarize(out as never) : out;
          break;
        }
        case "syncWorkspaces": {
          const out = service.synchronizeWorkspaces(
            expandSnapshot(op.snapshot) as never,
            op.cursor,
            op.includeBackground,
          );
          result = op.summary ? summarize(out as never) : out;
          break;
        }
        case "syncAgents": {
          const out = service.synchronizeAgents(
            expandSnapshot(op.snapshot) as never,
            op.cursor,
            op.includeBackground,
          );
          result = op.summary ? summarize(out as never) : out;
          break;
        }
        case "seqProject":
          result = service.sequenceProjectUpdate(op.update as never, op.includeSequence);
          break;
        case "seqWorkspace":
          result = service.sequenceWorkspaceUpdate(
            op.payload,
            op.value as never,
            op.id,
            op.includeSequence,
            op.includeBackground,
          );
          break;
        case "seqAgent":
          result = service.sequenceAgentUpdate(
            op.payload,
            op.value as never,
            op.id,
            op.includeSequence,
            op.includeBackground,
          );
          break;
      }
    } catch (error) {
      result = { threw: errorSummary(error) };
    }
    return { ...op, result };
  });
  return {
    name: scenario.name,
    description: scenario.description,
    generation: scenario.generation ?? GENERATION,
    ops: results,
  };
}

// --- VersionedCollection direct scenarios --------------------------------------

interface Item {
  id: string;
  v?: unknown;
  [key: string]: unknown;
}

type CollectionOp =
  | { op: "replace"; value: Item }
  | { op: "remove"; id: string }
  | { op: "replaceAll"; values: Item[] }
  | { op: "readSnapshot"; reason?: "no_cursor" | "generation_changed" | "cursor_expired" }
  | { op: "readAfter"; afterSeq: number }
  | { op: "sequenceFor"; id: string }
  | { op: "headSeq" };

interface CollectionScenario {
  name: string;
  description: string;
  maxTombstones?: number;
  ops: CollectionOp[];
}

const I = (id: string, v: unknown = 1): Item => ({ id, v });

const COLLECTION_SCENARIOS: CollectionScenario[] = [
  {
    name: "replace_and_fingerprint",
    description: "replace bumps only when JSON.stringify differs; remove of unknown id is a no-op.",
    ops: [
      { op: "replace", value: I("a", 1) },
      { op: "replace", value: I("a", 1) },
      { op: "replace", value: I("a", 2) },
      { op: "remove", id: "zzz" },
      { op: "remove", id: "a" },
      { op: "remove", id: "a" },
      { op: "replace", value: I("a", 2) },
      { op: "sequenceFor", id: "a" },
      { op: "headSeq" },
    ],
  },
  {
    name: "tombstone_revival",
    description: "A removed id has a tombstone seq; replacing it drops the tombstone and bumps.",
    ops: [
      { op: "replace", value: I("a") },
      { op: "remove", id: "a" },
      { op: "sequenceFor", id: "a" },
      { op: "readAfter", afterSeq: 0 },
      { op: "replace", value: I("a") },
      { op: "readAfter", afterSeq: 0 },
      { op: "readAfter", afterSeq: 2 },
    ],
  },
  {
    name: "tombstone_cap_3",
    description:
      "maxTombstones=3: the 4th removal evicts the oldest tombstone and advances expiredThroughSeq to its seq.",
    maxTombstones: 3,
    ops: [
      { op: "replaceAll", values: [I("a"), I("b"), I("c"), I("d"), I("e")] },
      { op: "remove", id: "a" },
      { op: "remove", id: "b" },
      { op: "remove", id: "c" },
      { op: "readAfter", afterSeq: 5 },
      { op: "remove", id: "d" },
      { op: "readAfter", afterSeq: 5 },
      { op: "readAfter", afterSeq: 6 },
      { op: "readAfter", afterSeq: 7 },
      { op: "sequenceFor", id: "a" },
      { op: "sequenceFor", id: "d" },
      { op: "remove", id: "a" },
      { op: "headSeq" },
    ],
  },
  {
    name: "read_after_bounds",
    description:
      "afterSeq < expiredThrough or > headSeq -> cursor_expired snapshot; otherwise changes sorted by seq then removals by seq then id.",
    ops: [
      { op: "replaceAll", values: [I("b"), I("a"), I("c")] },
      { op: "readAfter", afterSeq: 0 },
      { op: "readAfter", afterSeq: 1 },
      { op: "readAfter", afterSeq: 3 },
      { op: "readAfter", afterSeq: 4 },
      { op: "readAfter", afterSeq: -1 },
      { op: "readSnapshot" },
      { op: "readSnapshot", reason: "generation_changed" },
    ],
  },
  {
    name: "replace_all_semantics",
    description:
      "replaceAll upserts in iteration order then removes ids not retained, in map insertion order.",
    ops: [
      { op: "replaceAll", values: [I("x"), I("y"), I("z")] },
      { op: "replaceAll", values: [I("z", 2), I("w")] },
      { op: "readAfter", afterSeq: 0 },
      { op: "replaceAll", values: [I("w"), I("w", 3)] },
      { op: "readSnapshot" },
    ],
  },
  {
    name: "same_seq_order_locale",
    description:
      "Values sharing a seq cannot exist via replace; removals tie-break with localeCompare after seq (tombstone seqs are unique, so ordering is by seq).",
    ops: [
      { op: "replaceAll", values: [I("B"), I("a"), I("A"), I("b")] },
      { op: "replaceAll", values: [] },
      { op: "readAfter", afterSeq: 0 },
    ],
  },
];

function runCollectionScenario(scenario: CollectionScenario) {
  const collection = new VersionedCollection<Item>({
    getId: (item) => item.id,
    ...(scenario.maxTombstones !== undefined ? { maxTombstones: scenario.maxTombstones } : {}),
  });
  return {
    name: scenario.name,
    description: scenario.description,
    maxTombstones: scenario.maxTombstones ?? 5000,
    ops: scenario.ops.map((op) => {
      let result: unknown;
      switch (op.op) {
        case "replace":
          result = collection.replace(op.value);
          break;
        case "remove":
          result = collection.remove(op.id);
          break;
        case "replaceAll":
          collection.replaceAll(op.values);
          result = { headSeq: collection.headSeq };
          break;
        case "readSnapshot":
          result = collection.readSnapshot(op.reason);
          break;
        case "readAfter":
          result = collection.readAfter(op.afterSeq);
          break;
        case "sequenceFor":
          result = collection.sequenceFor(op.id);
          break;
        case "headSeq":
          result = collection.headSeq;
          break;
      }
      return { ...op, result };
    }),
  };
}

// --- fingerprint goldens --------------------------------------------------------

function fingerprintCases() {
  const pairs: Array<{ name: string; a: unknown; b: unknown }> = [
    { name: "identical", a: { id: "x", n: 1 }, b: { id: "x", n: 1 } },
    { name: "key_order_differs", a: { id: "x", a: 1, b: 2 }, b: { id: "x", b: 2, a: 1 } },
    { name: "undefined_vs_missing", a: { id: "x", v: undefined }, b: { id: "x" } },
    { name: "null_vs_missing", a: { id: "x", v: null }, b: { id: "x" } },
    { name: "negative_zero_vs_zero", a: { id: "x", v: -0 }, b: { id: "x", v: 0 } },
    { name: "nan_vs_null", a: { id: "x", v: Number.NaN }, b: { id: "x", v: null } },
    {
      name: "infinity_vs_null",
      a: { id: "x", v: Number.POSITIVE_INFINITY },
      b: { id: "x", v: null },
    },
    { name: "float_formats", a: { id: "x", v: 1.0 }, b: { id: "x", v: 1 } },
    { name: "exponent_numbers", a: { id: "x", v: 1e21 }, b: { id: "x", v: 1e20 } },
    { name: "small_exponent", a: { id: "x", v: 1e-7 }, b: { id: "x", v: 0.0000001 } },
    {
      name: "array_with_undefined",
      a: { id: "x", v: [undefined, 1] },
      b: { id: "x", v: [null, 1] },
    },
    { name: "nested_order", a: { id: "x", o: { b: 1, a: 2 } }, b: { id: "x", o: { a: 2, b: 1 } } },
    {
      name: "unicode_escape_lone_surrogate",
      a: { id: "x", v: "\ud83d" },
      b: { id: "x", v: "\\ud83d" },
    },
    { name: "astral_vs_escaped", a: { id: "x", v: "\u{1f600}" }, b: { id: "x", v: "😀" } },
    { name: "control_chars", a: { id: "x", v: 'a\u0007\u001f\n"\\/' }, b: { id: "x", v: "a" } },
    {
      name: "integer_like_keys_reorder",
      a: { id: "x", "2": 1, "1": 2, z: 3 },
      b: { id: "x", "1": 2, "2": 1, z: 3 },
    },
    { name: "u2028", a: { id: "x", v: "  " }, b: { id: "x", v: "" } },
    { name: "boolean_vs_string", a: { id: "x", v: true }, b: { id: "x", v: "true" } },
  ];
  return pairs.map((pair) => {
    const collection = new VersionedCollection<Item>({ getId: (item) => item.id });
    collection.replace(pair.a as Item);
    const second = collection.replace(pair.b as Item);
    return {
      name: pair.name,
      aJson: JSON.stringify(pair.a),
      bJson: JSON.stringify(pair.b),
      // Whether the second observation bumped the sequence (fingerprint differs).
      secondObservationBumped: second !== null,
      headSeq: collection.headSeq,
    };
  });
}

function localeCompareVectors() {
  const samples = [
    "a",
    "A",
    "b",
    "B",
    "z",
    "Z",
    "_",
    "-",
    " ",
    "0",
    "1",
    "2",
    "9",
    "10",
    "a b",
    "a-b",
    "a_b",
    "ab",
    "aB",
    "é",
    "e",
    "E",
    "f",
    "Ä",
    "ae",
    "ü",
    "u",
    "ñ",
    "n",
    "o",
    "中",
    "\u{1f600}",
    "",
    "prj_00ff",
    "prj_00FF",
    "wks_abc",
    "wks_ABD",
  ];
  const sorted = [...samples].sort((l, r) => l.localeCompare(r));
  const pairs: Array<{ l: string; r: string; cmp: number }> = [];
  for (const l of samples) {
    for (const r of samples) {
      pairs.push({ l, r, cmp: Math.sign(l.localeCompare(r)) });
    }
  }
  return {
    icuVersion: process.versions.icu ?? null,
    resolvedLocale: new Intl.Collator().resolvedOptions().locale,
    samples,
    sorted,
    pairs,
  };
}

const root = resolveOutRoot();
const dir = areaDir(root, "directory");
const locale = localeCompareVectors();
if (!locale.resolvedLocale.toLowerCase().startsWith("en")) {
  throw new Error(
    `Run with an English default locale (got ${locale.resolvedLocale}); set LC_ALL=en_US.UTF-8`,
  );
}
writeJson(dir, "service-scenarios.json", {
  note: "Each scenario runs on a fresh DirectorySyncService(generation). ops[].result is the TS return value (or {threw}). snapshot.gen expands to count entities with ids <prefix><index>.",
  scenarios: SCENARIOS.map(runScenario),
});
writeJson(dir, "versioned-collection-scenarios.json", {
  note: "Each scenario runs on a fresh VersionedCollection with getId=item.id and default JSON.stringify fingerprint.",
  scenarios: COLLECTION_SCENARIOS.map(runCollectionScenario),
});
writeJson(dir, "fingerprint-cases.json", {
  note: "Default fingerprint is JSON.stringify(value). secondObservationBumped is true when b differs from a after a was replaced.",
  cases: fingerprintCases(),
});
writeJson(dir, "locale-compare.json", {
  note: "String.prototype.localeCompare (ICU, default locale en-US) used to order values sharing a seq. `pairs[].cmp` is Math.sign of l.localeCompare(r).",
  ...locale,
});
