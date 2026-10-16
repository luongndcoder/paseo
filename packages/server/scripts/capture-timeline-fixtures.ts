/**
 * P4 WP0: golden fixtures for the timeline core (store, projection, paging,
 * tool-call merge, content limits, prompt index) and the stream coalescer.
 *
 *   tsx scripts/capture-timeline-fixtures.ts --out <fixtures/p4>
 */
import { AgentStreamCoalescer } from "../src/server/agent/agent-stream-coalescer.js";
import type { AgentStreamCoalescerFlush } from "../src/server/agent/agent-stream-coalescer.js";
import {
  assertPluginTimelineDataSize,
  limitAgentTimelineItemContent,
  PLUGIN_TIMELINE_DATA_MAX_BYTES,
} from "../src/server/agent/agent-timeline-content.js";
import { InMemoryAgentTimelineStore } from "../src/server/agent/agent-timeline-store.js";
import type {
  AgentTimelineFetchOptions,
  AgentTimelineRow,
} from "../src/server/agent/agent-timeline-store-types.js";
import type { AgentStreamEvent, AgentTimelineItem } from "../src/server/agent/agent-sdk-types.js";
import { buildTimelinePromptIndex } from "../src/server/agent/timeline-prompt-index.js";
import {
  mergeToolCallItems,
  projectTimelineRows,
  selectItemsByProjectedLimit,
  selectProjectedTimelinePage,
  selectTimelineWindowByProjectedLimit,
  type TimelineLimitDirection,
} from "../src/server/agent/timeline-projection.js";
import {
  areaDir,
  errorSummary,
  createRng,
  expandGenerators,
  resolveOutRoot,
  summarizeLongStrings,
  tsAt,
  writeJson,
  writeJsonl,
} from "./p4-fixture-utils.js";

const EPOCH = "epoch-1";
const STALE_EPOCH = "epoch-stale";
const AGENT = "agent-1";

type ToolItem = Extract<AgentTimelineItem, { type: "tool_call" }>;

// --- item builders ----------------------------------------------------------

const user = (text: string, extra: Record<string, unknown> = {}): AgentTimelineItem =>
  ({ type: "user_message", text, ...extra }) as AgentTimelineItem;
const assistant = (text: string, messageId?: string): AgentTimelineItem => ({
  type: "assistant_message",
  text,
  ...(messageId !== undefined ? { messageId } : {}),
});
const reasoning = (text: string): AgentTimelineItem => ({ type: "reasoning", text });
const shell = (
  callId: string,
  status: ToolItem["status"],
  extra: {
    output?: string;
    error?: unknown;
    metadata?: Record<string, unknown>;
    name?: string;
  } = {},
): AgentTimelineItem =>
  ({
    type: "tool_call",
    callId,
    name: extra.name ?? "shell",
    detail: {
      type: "shell",
      command: `echo ${callId}`,
      ...(extra.output !== undefined ? { output: extra.output } : {}),
    },
    status,
    error: status === "failed" ? (extra.error ?? { message: "boom" }) : null,
    ...(extra.metadata ? { metadata: extra.metadata } : {}),
  }) as AgentTimelineItem;
const unknownTool = (
  callId: string,
  status: ToolItem["status"],
  input: unknown = null,
  output: unknown = null,
): AgentTimelineItem =>
  ({
    type: "tool_call",
    callId,
    name: "mystery",
    detail: { type: "unknown", input, output },
    status,
    error: status === "failed" ? { message: "boom" } : null,
  }) as AgentTimelineItem;
const plugin = (pluginId: string, id: string, data: unknown): AgentTimelineItem =>
  ({ type: "plugin", pluginId, id, kind: "card", version: 1, data }) as AgentTimelineItem;

interface AppendStep {
  item: AgentTimelineItem;
  turnId?: string;
  providerMessageId?: string;
}

const a = (item: AgentTimelineItem, turnId?: string, providerMessageId?: string): AppendStep => ({
  item,
  ...(turnId !== undefined ? { turnId } : {}),
  ...(providerMessageId !== undefined ? { providerMessageId } : {}),
});

// --- named timelines ---------------------------------------------------------

interface TimelineDef {
  name: string;
  description: string;
  /** Seed given to store.initialize before the appends. */
  seed?: {
    items?: AgentTimelineItem[];
    rows?: AgentTimelineRow[];
    nextSeq?: number;
  };
  steps: AppendStep[];
  /** Enrichments applied after the appends. */
  enrich?: Array<{ clientMessageId: string; providerMessageId: string }>;
}

function longTimeline(): AppendStep[] {
  const steps: AppendStep[] = [];
  for (let turn = 1; turn <= 6; turn += 1) {
    const turnId = `turn-${turn}`;
    steps.push(a(user(`prompt ${turn}`, { clientMessageId: `cm-${turn}` })));
    steps.push(a(reasoning("think "), turnId), a(reasoning(`about ${turn}`), turnId));
    steps.push(a(shell(`call-${turn}`, "running"), turnId));
    steps.push(a(assistant(`working on ${turn} `, `msg-${turn}`), turnId));
    steps.push(a(shell(`call-${turn}`, "completed", { output: `out ${turn}` }), turnId));
    steps.push(
      a(assistant("done ", `msg-${turn}`), turnId),
      a(assistant("now", `msg-${turn}`), turnId),
    );
  }
  return steps;
}

const TIMELINES: TimelineDef[] = [
  { name: "empty", description: "No rows: window {0,0,1}.", steps: [] },
  {
    name: "single_user",
    description: "One user_message.",
    steps: [a(user("hello", { clientMessageId: "cm-1" }))],
  },
  {
    name: "text_chunks_same_turn",
    description: "Adjacent assistant chunks without messageId merge into the last row.",
    steps: [
      a(user("go")),
      a(assistant("Hel"), "t1"),
      a(assistant("lo "), "t1"),
      a(assistant("wor"), "t1"),
      a(assistant("ld"), "t1"),
    ],
  },
  {
    name: "assistant_message_id_rules",
    description:
      "Explicit differing messageId breaks the merge; undefined messageId merges into the previous row; same id merges.",
    steps: [
      a(assistant("a1 ", "m1"), "t1"),
      a(assistant("a2 ", "m1"), "t1"),
      a(assistant("b1 ", "m2"), "t1"),
      a(assistant("b2-no-id "), "t1"),
      a(assistant("b3 ", "m2"), "t1"),
      a(assistant("c1 ", "m3"), "t1"),
    ],
  },
  {
    name: "turn_id_change",
    description: "Same text kind with a different turnId (or absent turnId) never merges.",
    steps: [
      a(assistant("x "), "t1"),
      a(assistant("y "), "t2"),
      a(assistant("z ")),
      a(assistant("w ")),
      a(reasoning("r1 "), "t2"),
      a(reasoning("r2 "), "t3"),
    ],
  },
  {
    name: "reasoning_merge",
    description: "Reasoning chunks merge when adjacent and same turn.",
    steps: [
      a(reasoning("one "), "t1"),
      a(reasoning("two "), "t1"),
      a(assistant("answer"), "t1"),
      a(reasoning("three"), "t1"),
    ],
  },
  {
    name: "tool_interleaved",
    description:
      "Tool updates merge into the first row by callId; seqEnd of the first row is non-monotonic against later rows.",
    steps: [
      a(user("run things")),
      a(shell("A", "running"), "t1"),
      a(assistant("between "), "t1"),
      a(shell("B", "running"), "t1"),
      a(shell("A", "completed", { output: "A out" }), "t1"),
      a(assistant("more "), "t1"),
      a(shell("B", "failed", { error: { message: "B failed", code: 2 } }), "t1"),
      a(assistant("end"), "t1"),
    ],
  },
  {
    name: "tool_same_callid_new_turn",
    description: "Same callId under a different turnId starts a new row and takes the identity.",
    steps: [
      a(shell("X", "running"), "t1"),
      a(shell("X", "completed", { output: "first" }), "t1"),
      a(shell("X", "running"), "t2"),
      a(shell("X", "completed", { output: "second" }), "t2"),
      a(shell("X", "completed", { output: "third (turn absent)" })),
    ],
  },
  {
    name: "tool_detail_merge",
    description:
      "unknown detail never overwrites a known one; known replaces unknown; metadata shallow-merges; error rules per status.",
    steps: [
      a(shell("K", "running", { metadata: { a: 1, b: 1 } }), "t1"),
      a(unknownTool("K", "running"), "t1"),
      a(shell("K", "completed", { output: "ok", metadata: { b: 2, c: 3 } }), "t1"),
      a(unknownTool("U", "running", { q: 1 }, null), "t1"),
      a(shell("U", "running"), "t1"),
      a(unknownTool("F", "running"), "t1"),
      a(unknownTool("F", "failed"), "t1"),
      a(unknownTool("F", "completed", null, "done"), "t1"),
    ],
  },
  {
    name: "tool_error_semantics",
    description:
      "failed sets error, completed/canceled null it, running keeps/overrides when present.",
    steps: [
      a(shell("E1", "failed", { error: { message: "first" } }), "t1"),
      a(shell("E1", "running"), "t1"),
      a(shell("E2", "running"), "t1"),
      a(shell("E2", "canceled"), "t1"),
      a(shell("E3", "failed", { error: "string error" }), "t1"),
      a(shell("E3", "failed", { error: { message: "second" } }), "t1"),
    ],
  },
  {
    name: "plugin_identity",
    description:
      "Plugin items with the same pluginId/id replace the item but keep seqStart; other plugin ids stay separate.",
    steps: [
      a(plugin("p.one", "card-1", { n: 1 })),
      a(assistant("text between")),
      a(plugin("p.two", "card-1", { n: 10 })),
      a(plugin("p.one", "card-1", { n: 2 })),
      a(plugin("p.one", "card-2", { n: 3 })),
      a(plugin("p.one", "card-1", { n: 4 })),
    ],
  },
  {
    name: "non_merging_types",
    description: "todo, error, notification and compaction rows never merge.",
    steps: [
      a({ type: "todo", items: [{ text: "one", completed: false }] } as AgentTimelineItem, "t1"),
      a({ type: "todo", items: [{ text: "one", completed: true }] } as AgentTimelineItem, "t1"),
      a({ type: "error", message: "bad" }, "t1"),
      a({ type: "notification", level: "info", message: "fyi" }, "t1"),
      a({ type: "compaction", status: "loading", trigger: "auto" } as AgentTimelineItem, "t1"),
      a(
        {
          type: "compaction",
          status: "completed",
          trigger: "auto",
          preTokens: 10,
        } as AgentTimelineItem,
        "t1",
      ),
    ],
  },
  {
    name: "text_tool_text",
    description: "Text separated by a tool row does not merge across it.",
    steps: [
      a(assistant("before "), "t1"),
      a(shell("T", "running"), "t1"),
      a(assistant("after "), "t1"),
      a(assistant("after2"), "t1"),
      a(shell("T", "completed"), "t1"),
    ],
  },
  {
    name: "provider_message_id_enrich",
    description:
      "Submitted user rows get providerMessageId via enrich; rows keep turnId/providerMessageId.",
    steps: [
      a(user("first", { clientMessageId: "cm-a" })),
      a(assistant("reply"), "t1", "prov-1"),
      a(user("second", { clientMessageId: "cm-b" })),
    ],
    enrich: [
      { clientMessageId: "cm-b", providerMessageId: "prov-user-2" },
      { clientMessageId: "cm-missing", providerMessageId: "nope" },
    ],
  },
  {
    name: "seeded_items_next_seq",
    description: "initialize({items,nextSeq}) numbers seeded rows from nextSeq (imported agents).",
    seed: {
      items: [user("old prompt"), assistant("old "), assistant("answer"), shell("S", "completed")],
      nextSeq: 10,
    },
    steps: [a(user("new prompt")), a(assistant("fresh"), "t9")],
  },
  {
    name: "seeded_rows_gap",
    description: "Seeded rows start at seq 5: minSeq 5, so after-cursors below 4 are gaps.",
    seed: {
      rows: [
        { seq: 5, timestamp: tsAt(5000), item: user("p") },
        { seq: 6, timestamp: tsAt(6000), item: assistant("a ") },
        { seq: 7, timestamp: tsAt(7000), item: assistant("b") },
        { seq: 8, timestamp: tsAt(8000), item: shell("G", "running") },
      ],
    },
    steps: [a(shell("G", "completed", { output: "late" })), a(assistant("tail"))],
  },
  {
    name: "long_multi_turn",
    description: "Six turns mixing reasoning, tools and text; used for limit/paging matrices.",
    steps: longTimeline(),
  },
];

// --- store execution ---------------------------------------------------------

function buildStore(def: TimelineDef): {
  store: InMemoryAgentTimelineStore;
  appended: AgentTimelineRow[];
} {
  const store = new InMemoryAgentTimelineStore();
  store.initialize(AGENT, {
    epoch: EPOCH,
    timestamp: tsAt(0),
    ...(def.seed?.items ? { items: def.seed.items } : {}),
    ...(def.seed?.rows ? { rows: def.seed.rows } : {}),
    ...(def.seed?.nextSeq !== undefined ? { nextSeq: def.seed.nextSeq } : {}),
  });
  const appended: AgentTimelineRow[] = [];
  def.steps.forEach((step, index) => {
    appended.push(
      store.append(AGENT, step.item, {
        timestamp: tsAt(1000 * (index + 20)),
        ...(step.turnId !== undefined ? { turnId: step.turnId } : {}),
        ...(step.providerMessageId !== undefined
          ? { providerMessageId: step.providerMessageId }
          : {}),
      }),
    );
  });
  return { store, appended };
}

function fetchOptionsMatrix(
  seqs: number[],
  minSeq: number,
  maxSeq: number,
): AgentTimelineFetchOptions[] {
  const options: AgentTimelineFetchOptions[] = [];
  const limits: Array<number | undefined> = [undefined, 0, 1, 2, 5];
  const directions = [undefined, "tail", "before", "after"] as const;
  const cursorSeqs = new Set<number>([0, minSeq - 2, minSeq - 1, maxSeq, maxSeq + 1, ...seqs]);
  for (const direction of directions) {
    for (const limit of limits) {
      options.push({
        ...(direction ? { direction } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      if (direction === undefined) continue;
      for (const seq of [...cursorSeqs].filter((s) => s >= 0).sort((x, y) => x - y)) {
        options.push({
          ...(direction ? { direction } : {}),
          cursor: { epoch: EPOCH, seq },
          ...(limit !== undefined ? { limit } : {}),
        });
      }
      options.push({
        direction,
        cursor: { epoch: STALE_EPOCH, seq: Math.max(minSeq, 1) },
        ...(limit !== undefined ? { limit } : {}),
      });
    }
  }
  return options;
}

function captureStore(): void {
  const timelines: unknown[] = [];
  const fetchCases: unknown[] = [];
  const projectionCases: unknown[] = [];

  for (const def of TIMELINES) {
    const { store, appended } = buildStore(def);
    const enrichResults = (def.enrich ?? []).map((entry) =>
      Object.assign({}, entry, {
        result: store.enrichSubmittedUserMessage(
          AGENT,
          entry.clientMessageId,
          entry.providerMessageId,
        ),
      }),
    );
    const projectedRows = store.getRows(AGENT);
    const window = store.fetch(AGENT, { direction: "tail", limit: 0 }).window;
    const submitted = [
      ...new Set([
        ...def.steps.flatMap((s) =>
          s.item.type === "user_message" && typeof s.item.clientMessageId === "string"
            ? [s.item.clientMessageId]
            : [],
        ),
        "cm-missing",
      ]),
    ];
    timelines.push({
      name: def.name,
      description: def.description,
      epoch: EPOCH,
      agentId: AGENT,
      seed: def.seed ?? null,
      initTimestamp: tsAt(0),
      steps: def.steps.map((step, index) => ({
        op: "append",
        item: step.item,
        timestamp: tsAt(1000 * (index + 20)),
        ...(step.turnId !== undefined ? { turnId: step.turnId } : {}),
        ...(step.providerMessageId !== undefined
          ? { providerMessageId: step.providerMessageId }
          : {}),
        returnedRow: appended[index],
      })),
      enrich: enrichResults,
      expected: {
        window,
        items: store.getItems(AGENT),
        projectedRows,
        lastItem: store.getLastItem(AGENT),
        lastAssistantMessage: store.getLastAssistantMessage(AGENT),
        epoch: store.getEpoch(AGENT),
        submittedUserMessages: submitted.map((clientMessageId) => ({
          clientMessageId,
          row: store.getSubmittedUserMessage(AGENT, clientMessageId),
        })),
      },
    });

    const seqs = projectedRows.flatMap((row) => [row.seqStart, row.seqEnd]);
    const uniqueSeqs = [...new Set(seqs)];
    const options = fetchOptionsMatrix(
      def.name === "long_multi_turn" ? sampleSeqs(window.minSeq, window.maxSeq, 8) : uniqueSeqs,
      window.minSeq,
      window.maxSeq,
    );
    for (const option of options) {
      fetchCases.push({ timeline: def.name, options: option, result: store.fetch(AGENT, option) });
    }

    // Canonical rows (what the actor records) -> projection helpers.
    projectionCases.push(projectionCase(def.name, canonicalFromDef(def, appended)));
  }

  // Fetch on an agent without state throws.
  const missing = new InMemoryAgentTimelineStore();
  let missingError: unknown = null;
  try {
    missing.fetch("ghost");
  } catch (error) {
    missingError = errorSummary(error);
  }

  const dir = areaDir(resolveOutRoot(), "timeline");
  writeJson(dir, "store-timelines.json", {
    note: "Replay `seed` through initialize(agentId,{epoch,timestamp,...seed}) then each append step; `expected` is the store state after all appends and enrichments.",
    unknownAgentFetchError: missingError,
    timelines,
  });
  writeJsonl(dir, "store-fetch-cases.jsonl", fetchCases);
  // One case per line: {name, rows (canonical AgentTimelineRows as recorded by the actor), canonical,
  // projected, reprojected, windows, pages, itemSelections}. Results are TS outputs.
  writeJsonl(dir, "projection-cases.jsonl", projectionCases);
}

function sampleSeqs(min: number, max: number, count: number): number[] {
  const out: number[] = [];
  const span = Math.max(1, max - min);
  for (let i = 0; i < count; i += 1) out.push(min + Math.floor((span * i) / (count - 1)));
  return out;
}

function canonicalFromDef(def: TimelineDef, appended: AgentTimelineRow[]): AgentTimelineRow[] {
  const seeded: AgentTimelineRow[] = def.seed?.rows
    ? def.seed.rows.map((row) => ({ ...row }))
    : (def.seed?.items ?? []).map((item, index) => ({
        seq: (def.seed?.nextSeq ?? 1) + index,
        timestamp: tsAt(0),
        item,
      }));
  return [...seeded, ...appended];
}

function projectionCase(name: string, rows: AgentTimelineRow[]) {
  const canonical = projectTimelineRows({ rows, mode: "canonical" });
  const projected = projectTimelineRows({ rows, mode: "projected" });
  const reprojected = projectTimelineRows({
    rows: projected as unknown as AgentTimelineRow[],
    mode: "projected",
  });
  const directions: TimelineLimitDirection[] = ["tail", "before", "after"];
  const limits = [0, 1, 2, 3, 5];
  const windows = directions.flatMap((direction) =>
    limits.map((limit) => {
      const selected = selectTimelineWindowByProjectedLimit({ rows, direction, limit });
      return { direction, limit, result: selected };
    }),
  );
  const minSeq = rows[0]?.seq ?? 0;
  const maxSeq = rows.at(-1)?.seq ?? 0;
  const pages = directions.flatMap((direction) =>
    limits.flatMap((limit) => {
      const cursors: Array<number | undefined> =
        direction === "tail"
          ? [undefined]
          : [undefined, minSeq, Math.floor((minSeq + maxSeq) / 2), maxSeq, maxSeq + 1];
      return cursors.map((cursorSeq) => ({
        direction,
        limit,
        cursorSeq: cursorSeq ?? null,
        result: selectProjectedTimelinePage({
          rows,
          direction,
          limit,
          ...(cursorSeq !== undefined ? { cursorSeq } : {}),
        }),
      }));
    }),
  );
  const itemSelections = directions.flatMap((direction) =>
    limits.map((limit) => ({
      direction,
      limit,
      result: selectItemsByProjectedLimit({ items: rows.map((row) => row.item), direction, limit }),
    })),
  );
  return { name, rows, canonical, projected, reprojected, windows, pages, itemSelections };
}

// --- mergeToolCallItems --------------------------------------------------------

function captureMerge(): void {
  const cases: Array<{ name: string; existing: ToolItem; incoming: ToolItem }> = [];
  const tool = (over: Record<string, unknown>): ToolItem =>
    ({
      type: "tool_call",
      callId: "c",
      name: "shell",
      detail: { type: "shell", command: "ls" },
      status: "running",
      error: null,
      ...over,
    }) as ToolItem;
  const known = { type: "shell", command: "ls", output: "x" };
  const unknown = { type: "unknown", input: { a: 1 }, output: null };
  const statuses: ToolItem["status"][] = ["running", "completed", "failed", "canceled"];
  for (const from of statuses) {
    for (const to of statuses) {
      cases.push({
        name: `status_${from}_to_${to}`,
        existing: tool({ status: from, error: from === "failed" ? { message: "old" } : null }),
        incoming: tool({
          status: to,
          error: to === "failed" ? { message: "new" } : null,
          detail: known,
        }),
      });
    }
  }
  cases.push(
    {
      name: "unknown_over_known",
      existing: tool({ detail: known }),
      incoming: tool({ detail: unknown }),
    },
    {
      name: "known_over_unknown",
      existing: tool({ detail: unknown }),
      incoming: tool({ detail: known }),
    },
    {
      name: "unknown_over_unknown",
      existing: tool({ detail: unknown }),
      incoming: tool({ detail: { type: "unknown", input: 2, output: 3 } }),
    },
    {
      name: "known_over_known_other_type",
      existing: tool({ detail: known }),
      incoming: tool({ detail: { type: "read", filePath: "/a" } }),
    },
    {
      name: "metadata_both",
      existing: tool({ metadata: { a: 1, b: 1 } }),
      incoming: tool({ metadata: { b: 2, c: 3 } }),
    },
    { name: "metadata_existing_only", existing: tool({ metadata: { a: 1 } }), incoming: tool({}) },
    { name: "metadata_incoming_only", existing: tool({}), incoming: tool({ metadata: { z: 1 } }) },
    { name: "metadata_neither", existing: tool({}), incoming: tool({}) },
    {
      name: "running_with_error_overrides",
      existing: tool({}),
      incoming: tool({ status: "running", error: { message: "warn" } }),
    },
    {
      name: "running_null_error_keeps_existing_failed_error",
      existing: tool({ status: "failed", error: { message: "kept" } }),
      incoming: tool({ status: "running", error: null }),
    },
    {
      name: "extra_keys_and_name_override",
      existing: tool({ title: "old", extra: 1, name: "old_name" }),
      incoming: tool({ title: "new", name: "new_name", other: true }),
    },
    {
      name: "incoming_error_undefined_running",
      existing: tool({ status: "failed", error: { message: "e" } }),
      incoming: (() => {
        const item = tool({ status: "running" }) as Record<string, unknown>;
        delete item.error;
        return item as ToolItem;
      })(),
    },
  );
  writeJson(areaDir(resolveOutRoot(), "timeline"), "tool-merge-cases.json", {
    note: "merged = mergeToolCallItems(existing, incoming). JSON drops undefined-valued keys (e.g. metadata).",
    cases: cases.map((c) =>
      Object.assign({}, c, { merged: mergeToolCallItems(c.existing, c.incoming) }),
    ),
  });
}

// --- content limits -----------------------------------------------------------

function captureLimits(): void {
  const CAP = 65536;
  const NOTICE_LEN = "\n\n[Content truncated]".length;
  const gen = (...parts: Array<[string, number]>) => ({
    $gen: { parts: parts.map(([unit, count]) => ({ unit, count })) },
  });
  const shellDetail = (output: unknown, extra: Record<string, unknown> = {}) => ({
    type: "shell",
    command: "cmd",
    output,
    ...extra,
  });
  const toolItem = (over: Record<string, unknown>) => ({
    type: "tool_call",
    callId: "c1",
    name: "shell",
    detail: shellDetail("short"),
    status: "completed",
    error: null,
    ...over,
  });
  const inputs: Array<{ name: string; item: unknown }> = [
    {
      name: "shell_output_below_cap",
      item: toolItem({ detail: shellDetail(gen(["a", CAP - 1])) }),
    },
    { name: "shell_output_at_cap", item: toolItem({ detail: shellDetail(gen(["a", CAP])) }) },
    {
      name: "shell_output_one_over_cap",
      item: toolItem({ detail: shellDetail(gen(["a", CAP + 1])) }),
    },
    {
      name: "shell_output_astral_pair_straddles_cap",
      item: toolItem({ detail: shellDetail(gen(["a", CAP - 1], ["\u{1f600}", 10])) }),
    },
    {
      name: "shell_output_astral_pair_ends_at_cap",
      item: toolItem({ detail: shellDetail(gen(["a", CAP - 2], ["\u{1f600}", 10])) }),
    },
    {
      name: "shell_output_cjk_over_cap",
      item: toolItem({ detail: shellDetail(gen(["中", CAP + 100])) }),
    },
    { name: "shell_output_not_string", item: toolItem({ detail: shellDetail({ big: "x" }) }) },
    {
      name: "failed_shell_error_content_over_cap",
      item: toolItem({
        status: "failed",
        detail: shellDetail("ok"),
        error: { message: "m", content: gen(["e", CAP + 5]) },
      }),
    },
    {
      name: "failed_shell_error_content_astral_straddle",
      item: toolItem({
        status: "failed",
        detail: shellDetail("ok"),
        error: { message: "m", content: gen(["e", CAP - 1], ["\u{1f4a5}", 4]) },
      }),
    },
    {
      name: "failed_shell_error_string",
      item: toolItem({ status: "failed", detail: shellDetail("ok"), error: gen(["e", CAP + 5]) }),
    },
    {
      name: "failed_shell_error_without_content",
      item: toolItem({ status: "failed", detail: shellDetail("ok"), error: { message: "m" } }),
    },
    {
      name: "failed_shell_both_error_and_output_over_cap",
      item: toolItem({
        status: "failed",
        detail: shellDetail(gen(["o", CAP + 7])),
        error: { content: gen(["e", CAP + 9]) },
      }),
    },
    {
      name: "completed_shell_error_content_not_truncated",
      item: toolItem({ status: "completed", error: { content: gen(["e", CAP + 5]) } }),
    },
    {
      name: "plain_text_over_cap",
      item: toolItem({
        name: "custom",
        detail: { type: "plain_text", label: "L", text: gen(["p", CAP + 10]) },
      }),
    },
    {
      name: "plain_text_at_cap",
      item: toolItem({ name: "custom", detail: { type: "plain_text", text: gen(["p", CAP]) } }),
    },
    {
      name: "plain_text_astral_straddle_before_notice",
      item: toolItem({
        name: "custom",
        detail: { type: "plain_text", text: gen(["p", CAP - NOTICE_LEN - 1], ["\u{1f680}", 10]) },
      }),
    },
    {
      name: "plain_text_astral_pair_ends_before_notice",
      item: toolItem({
        name: "custom",
        detail: { type: "plain_text", text: gen(["p", CAP - NOTICE_LEN - 2], ["\u{1f680}", 10]) },
      }),
    },
    {
      name: "read_content_not_limited",
      item: toolItem({ detail: { type: "read", filePath: "/a", content: gen(["r", CAP + 50]) } }),
    },
    {
      name: "assistant_message_not_limited",
      item: { type: "assistant_message", text: gen(["m", CAP + 50]) },
    },
  ];
  const limitCases = inputs.map((input) => {
    const expanded = expandGenerators(input.item) as AgentTimelineItem;
    const output = limitAgentTimelineItemContent(expanded);
    return {
      name: input.name,
      input: input.item,
      output: summarizeLongStrings(output),
      outputIsSameReference: output === expanded,
    };
  });

  const pluginSizes: Array<{ name: string; data: unknown }> = [
    { name: "ascii_exactly_cap", data: gen(["a", PLUGIN_TIMELINE_DATA_MAX_BYTES - 2]) },
    { name: "ascii_one_over_cap", data: gen(["a", PLUGIN_TIMELINE_DATA_MAX_BYTES - 1]) },
    { name: "two_byte_chars_at_cap", data: gen(["é", (PLUGIN_TIMELINE_DATA_MAX_BYTES - 2) / 2]) },
    {
      name: "two_byte_chars_over_cap",
      data: gen(["é", (PLUGIN_TIMELINE_DATA_MAX_BYTES - 2) / 2 + 1]),
    },
    { name: "astral_over_cap", data: gen(["\u{1f600}", PLUGIN_TIMELINE_DATA_MAX_BYTES / 4]) },
    { name: "object_small", data: { a: 1, b: [1, 2, 3], c: null } },
  ];
  const pluginCases = pluginSizes.map((entry) => {
    const data = expandGenerators(entry.data) as never;
    let result: unknown = { ok: true };
    try {
      assertPluginTimelineDataSize(data);
    } catch (error) {
      result = { ok: false, error: errorSummary(error) };
    }
    return {
      name: entry.name,
      data: entry.data,
      utf8Bytes: Buffer.byteLength(JSON.stringify(data), "utf8"),
      result,
    };
  });

  writeJson(areaDir(resolveOutRoot(), "timeline"), "content-limits.json", {
    note: "Inputs use {$gen:{parts:[{unit,count}]}} placeholders for strings; outputs replace strings > 1024 UTF-16 units with {$str:{length16,sha256Utf16le,tail16Hex}} (sha256 over UTF-16LE bytes, preserving lone surrogates). TS slices by UTF-16 code units and may leave a lone surrogate (PARITY-QUIRK surrogate-truncation).",
    cap: CAP,
    pluginDataMaxBytes: PLUGIN_TIMELINE_DATA_MAX_BYTES,
    limitCases,
    pluginCases,
  });
}

// --- prompt index -------------------------------------------------------------

function capturePromptIndex(): void {
  const rows: AgentTimelineRow[] = [];
  let seq = 1;
  const add = (item: AgentTimelineItem) => {
    rows.push({ seq, timestamp: tsAt(seq * 1000), item });
    seq += 1;
  };
  add(user("  hello\n\tworld   again  "));
  add(assistant("not a prompt"));
  add(user("x".repeat(120)));
  add(user("y".repeat(121)));
  add(user("z".repeat(118) + "\u{1f600}tail"));
  add(user("中".repeat(200)));
  add(user(""));
  add(user(" \n "));
  add(shell("c", "completed"));
  add(user("last"));
  writeJson(areaDir(resolveOutRoot(), "timeline"), "prompt-index.json", {
    note: "preview collapses whitespace, trims, truncates at 119 UTF-16 units + U+2026 when > 120 (can leave a lone surrogate).",
    epoch: EPOCH,
    rows,
    result: buildTimelinePromptIndex(EPOCH, rows),
  });
}

// --- coalescer traces ----------------------------------------------------------

class FakeClock {
  private current = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; seq: number; callback: () => void }>();
  private order = 0;

  now = (): number => this.current;

  setTimeout = (callback: () => void, ms = 0): ReturnType<typeof setTimeout> => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.current + ms, seq: this.order++, callback });
    return Object.assign({ id, unref: () => undefined }) as unknown as ReturnType<
      typeof setTimeout
    >;
  };

  clearTimeout = ((handle: unknown) => {
    const id = (handle as { id?: number } | undefined)?.id;
    if (id !== undefined) this.timers.delete(id);
  }) as typeof clearTimeout;

  advanceTo(target: number): void {
    for (;;) {
      let nextKey: number | null = null;
      let next: { at: number; seq: number; callback: () => void } | null = null;
      for (const [key, timer] of this.timers) {
        if (timer.at > target) continue;
        if (!next || timer.at < next.at || (timer.at === next.at && timer.seq < next.seq)) {
          next = timer;
          nextKey = key;
        }
      }
      if (!next || nextKey === null) break;
      this.timers.delete(nextKey);
      this.current = Math.max(this.current, next.at);
      next.callback();
    }
    this.current = Math.max(this.current, target);
  }

  pendingTimers(): number {
    return this.timers.size;
  }
}

type TraceOp =
  | { at: number; op: "handle"; agent: string; event: AgentStreamEvent }
  | { at: number; op: "flushFor"; agent: string }
  | { at: number; op: "flushAll" }
  | { at: number; op: "flushAndDiscard"; agent: string }
  | { at: number; op: "advance" };

interface TraceDef {
  name: string;
  description: string;
  windowMs?: number;
  ops: TraceOp[];
}

const tl = (
  item: AgentTimelineItem,
  turnId?: string,
  provider: "codex" | "claude" = "codex",
): AgentStreamEvent => ({
  type: "timeline",
  item,
  provider,
  ...(turnId !== undefined ? { turnId } : {}),
});
const H = (at: number, agent: string, event: AgentStreamEvent): TraceOp => ({
  at,
  op: "handle",
  agent,
  event,
});

function burstyTrace(): TraceOp[] {
  const rng = createRng(0xc0ffee);
  const ops: TraceOp[] = [];
  let at = 0;
  const agents = ["agent-a", "agent-b"];
  let callCounter = 0;
  for (let i = 0; i < 300; i += 1) {
    at += 1 + Math.floor(rng() * 25);
    const agent = agents[rng() < 0.7 ? 0 : 1];
    const roll = rng();
    const turnId = `turn-${Math.floor(i / 60)}`;
    if (roll < 0.62) {
      ops.push(H(at, agent, tl(assistant(`tok${i} `, i % 90 < 45 ? "m-1" : "m-2"), turnId)));
    } else if (roll < 0.8) {
      ops.push(H(at, agent, tl(reasoning(`r${i} `), turnId)));
    } else if (roll < 0.9) {
      callCounter += 1;
      ops.push(H(at, agent, tl(shell(`call-${callCounter}`, "running"), turnId)));
    } else if (roll < 0.96 && callCounter > 0) {
      ops.push(
        H(at, agent, tl(shell(`call-${callCounter}`, "completed", { output: `o${i}` }), turnId)),
      );
    } else if (roll < 0.98) {
      ops.push(H(at, agent, tl(assistant(""), turnId)));
    } else {
      ops.push(H(at, agent, tl({ type: "error", message: `e${i}` }, turnId)));
    }
    if (i % 97 === 96) ops.push({ at, op: "flushFor", agent });
  }
  ops.push({ at: at + 500, op: "advance" });
  return ops;
}

function captureCoalescer(): void {
  const traces: TraceDef[] = [
    {
      name: "leading_edge_then_trailing",
      description:
        "First event flushes synchronously; later events in the window batch until the 60 ms timer.",
      ops: [
        H(0, "a", tl(assistant("A"), "t1")),
        H(10, "a", tl(assistant("B"), "t1")),
        H(20, "a", tl(assistant("C"), "t1")),
        { at: 59, op: "advance" },
        { at: 61, op: "advance" },
        H(200, "a", tl(assistant("D"), "t1")),
      ],
    },
    {
      name: "elapsed_exactly_window",
      description: "Leading edge triggers when now - lastFlushAt >= windowMs (boundary at 60).",
      ops: [
        H(0, "a", tl(assistant("A"), "t1")),
        H(60, "a", tl(assistant("B"), "t1")),
        H(100, "a", tl(assistant("C"), "t1")),
        H(119, "a", tl(assistant("D"), "t1")),
        H(120, "a", tl(assistant("E"), "t1")),
        { at: 300, op: "advance" },
      ],
    },
    {
      name: "empty_text_swallowed",
      description:
        "Empty assistant/reasoning text returns handled=true and produces nothing, not even a buffer.",
      ops: [
        H(0, "a", tl(assistant(""), "t1")),
        H(1, "a", tl(reasoning(""), "t1")),
        H(2, "a", tl(assistant("x"), "t1")),
        { at: 100, op: "advance" },
      ],
    },
    {
      name: "non_coalescable_not_handled",
      description: "user_message, error, todo, plugin, compaction are not handled (return false).",
      ops: [
        H(0, "a", tl(user("u"), "t1")),
        H(1, "a", tl({ type: "error", message: "e" }, "t1")),
        H(2, "a", { type: "turn_started", provider: "codex", turnId: "t1" }),
        H(3, "a", tl(plugin("p", "i", {}), "t1")),
        H(4, "a", tl({ type: "todo", items: [] } as AgentTimelineItem, "t1")),
      ],
    },
    {
      name: "text_boundaries",
      description:
        "Concatenate only same kind, same assistant messageId, same provider, same turnId; reasoning ignores messageId.",
      ops: [
        H(0, "a", tl(assistant("prime"), "t0")),
        H(1, "a", tl(assistant("a "), "t1")),
        H(2, "a", tl(assistant("b "), "t1")),
        H(3, "a", tl(assistant("c ", "m1"), "t1")),
        H(4, "a", tl(assistant("d ", "m1"), "t1")),
        H(5, "a", tl(assistant("e ", "m2"), "t1")),
        H(6, "a", tl(reasoning("r1 "), "t1")),
        H(7, "a", tl(reasoning("r2 "), "t1")),
        H(8, "a", tl(assistant("f "), "t2")),
        H(9, "a", tl(assistant("g "), "t2", "claude")),
        H(10, "a", tl(assistant("h "), "t2", "claude")),
        H(11, "a", tl(assistant("i "))),
        H(12, "a", tl(assistant("j "))),
        { at: 100, op: "advance" },
      ],
    },
    {
      name: "tool_call_merge_by_call_id_in_place",
      description:
        "Tool entries merge by callId and keep the first slot; text between stays ordered.",
      ops: [
        H(0, "a", tl(assistant("prime"), "t1")),
        H(1, "a", tl(shell("T1", "running", { metadata: { a: 1 } }), "t1")),
        H(2, "a", tl(assistant("between "), "t1")),
        H(3, "a", tl(shell("T2", "running"), "t1")),
        H(4, "a", tl(unknownTool("T1", "running"), "t1")),
        H(5, "a", tl(shell("T1", "running", { metadata: { b: 2 } }), "t1")),
        { at: 100, op: "advance" },
      ],
    },
    {
      name: "terminal_tool_flushes_immediately",
      description:
        "completed/failed/canceled tool status flushes the whole buffer immediately and clears the timer.",
      ops: [
        H(0, "a", tl(assistant("prime"), "t1")),
        H(1, "a", tl(assistant("pending "), "t1")),
        H(2, "a", tl(shell("T", "running"), "t1")),
        H(3, "a", tl(shell("T", "completed", { output: "done" }), "t1")),
        H(4, "a", tl(assistant("after "), "t1")),
        H(5, "a", tl(shell("U", "failed"), "t1")),
        H(6, "a", tl(shell("V", "canceled"), "t1")),
        { at: 200, op: "advance" },
      ],
    },
    {
      name: "flush_for_and_discard",
      description:
        "flushFor flushes and keeps the buffer (lastFlushAt retained); flushAndDiscard also drops it (next event is a leading edge).",
      ops: [
        H(0, "a", tl(assistant("prime"), "t1")),
        H(1, "a", tl(assistant("one "), "t1")),
        { at: 2, op: "flushFor", agent: "a" },
        H(3, "a", tl(assistant("two "), "t1")),
        { at: 4, op: "flushAndDiscard", agent: "a" },
        H(5, "a", tl(assistant("three "), "t1")),
        H(6, "a", tl(assistant("four "), "t1")),
        { at: 7, op: "flushAndDiscard", agent: "ghost" },
        { at: 100, op: "advance" },
      ],
    },
    {
      name: "flush_all_multiple_agents",
      description: "flushAll iterates buffers in creation order.",
      ops: [
        H(0, "b", tl(assistant("b-prime"), "t1")),
        H(0, "a", tl(assistant("a-prime"), "t1")),
        H(1, "a", tl(assistant("a1 "), "t1")),
        H(2, "b", tl(assistant("b1 "), "t1")),
        { at: 3, op: "flushAll" },
        { at: 200, op: "advance" },
      ],
    },
    {
      name: "per_agent_independence",
      description: "Windows are tracked per agent.",
      ops: [
        H(0, "a", tl(assistant("a0"), "t1")),
        H(1, "b", tl(assistant("b0"), "t1")),
        H(2, "a", tl(assistant("a1"), "t1")),
        H(3, "b", tl(assistant("b1"), "t1")),
        H(70, "b", tl(assistant("b2"), "t1")),
        { at: 200, op: "advance" },
      ],
    },
    {
      name: "custom_window_10ms",
      description: "windowMs=10.",
      windowMs: 10,
      ops: [
        H(0, "a", tl(assistant("A"), "t1")),
        H(3, "a", tl(assistant("B"), "t1")),
        H(9, "a", tl(assistant("C"), "t1")),
        H(10, "a", tl(assistant("D"), "t1")),
        H(25, "a", tl(assistant("E"), "t1")),
        { at: 100, op: "advance" },
      ],
    },
    {
      name: "bursty_stream",
      description:
        "300 pseudo-random events (seeded) over two agents with tools, reasoning, empty text and errors.",
      ops: burstyTrace(),
    },
  ];

  const output = traces.map((trace) => {
    const clock = new FakeClock();
    const flushes: Array<AgentStreamCoalescerFlush & { at: number }> = [];
    const coalescer = new AgentStreamCoalescer({
      ...(trace.windowMs !== undefined ? { windowMs: trace.windowMs } : {}),
      timers: { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
      now: clock.now,
      onFlush: (payload) => flushes.push({ at: clock.now(), ...payload }),
    });
    const log = trace.ops.map((op) => {
      clock.advanceTo(op.at);
      const before = flushes.length;
      let handled: boolean | null = null;
      switch (op.op) {
        case "handle":
          handled = coalescer.handle(op.agent, op.event);
          break;
        case "flushFor":
          coalescer.flushFor(op.agent);
          break;
        case "flushAll":
          coalescer.flushAll();
          break;
        case "flushAndDiscard":
          coalescer.flushAndDiscard(op.agent);
          break;
        case "advance":
          break;
      }
      return { ...op, handled, flushedCount: flushes.length - before };
    });
    return {
      name: trace.name,
      description: trace.description,
      windowMs: trace.windowMs ?? 60,
      ops: log.map(({ flushedCount: _ignored, ...rest }) => rest),
      flushes,
      pendingTimersAtEnd: clock.pendingTimers(),
    };
  });
  const dir = areaDir(resolveOutRoot(), "timeline");
  writeJson(dir, "coalescer-traces.json", {
    note: "Fake clock starts at 0. Before each op the clock advances to `at`, firing due timers (earliest first, FIFO on ties) so trailing flushes are recorded at their timer time. `handled` is the boolean returned by handle(). `flushes[].at` is the clock at flush.",
    traces: output,
  });
}

captureStore();
captureMerge();
captureLimits();
capturePromptIndex();
captureCoalescer();
