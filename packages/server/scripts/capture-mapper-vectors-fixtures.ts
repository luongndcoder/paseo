/* eslint-disable max-depth -- harvesting loops walk nested transcript structures */
/**
 * P4 WP0: pure mapper (input, output) vectors: tool-call mapper utils,
 * per-provider tool-call mappers (inputs harvested from the paseo-* crate
 * fixtures plus handwritten edge cases), the wire serializer
 * (serializeAgentStreamEvent), mergeToolCallItems callers, and
 * project_agent_message.
 *
 *   tsx scripts/capture-mapper-vectors-fixtures.ts --out <fixtures/p4>
 */
import path from "node:path";

import { projectAgentMessage } from "../src/server/agent/agent-messages/index.js";
import type { AgentStreamEvent, AgentTimelineItem } from "../src/server/agent/agent-sdk-types.js";
import {
  coerceToolCallId,
  extractCodexShellOutput,
  extractCodexTerminalSessionId,
  flattenReadContent,
  nonEmptyString,
  normalizeToolCallStatus,
  stripReadLineNumberGutter,
  truncateDiffText,
} from "../src/server/agent/providers/tool-call-mapper-utils.js";
import {
  mapClaudeCanceledToolCall,
  mapClaudeCompletedToolCall,
  mapClaudeFailedToolCall,
  mapClaudeRunningToolCall,
} from "../src/server/agent/providers/claude/tool-call-mapper.js";
import {
  mapCodexToolCallEnvelope,
  mapCodexToolCallFromThreadItem,
} from "../src/server/agent/providers/codex/tool-call-mapper.js";
import { mapOpencodeToolCall } from "../src/server/agent/providers/opencode/tool-call-mapper.js";
import {
  mapToolDetail as mapPiToolDetail,
  parseToolArgs as parsePiToolArgs,
  parseToolResult as parsePiToolResult,
} from "../src/server/agent/providers/pi/tool-call-mapper.js";
import {
  mapToolDetail as mapOmpCoreToolDetail,
  parseToolArgs as parseOmpToolArgs,
  parseToolResult as parseOmpToolResult,
} from "../src/server/agent/providers/omp/tool-call-detail.js";
import { mapOmpToolDetail } from "../src/server/agent/providers/omp/tool-call-mapper.js";
import { serializeAgentStreamEvent } from "../src/server/messages.js";
import {
  areaDir,
  errorSummary,
  readJsonl,
  resolveCratesDir,
  resolveOutRoot,
  writeJson,
  writeJsonl,
} from "./p4-fixture-utils.js";

type Json = Record<string, unknown>;
interface Vector {
  fn: string;
  name: string;
  input: unknown;
  output: unknown;
  threw?: { name: string; message: string };
}

const vectors: Vector[] = [];

function vec(fn: string, name: string, input: unknown, run: () => unknown): void {
  try {
    const output = run();
    vectors.push({ fn, name, input, output: output === undefined ? null : output });
  } catch (error) {
    vectors.push({ fn, name, input, output: null, threw: errorSummary(error) });
  }
}

// --- tool-call-mapper-utils ---------------------------------------------------------

function describeText(text: string | undefined): unknown {
  if (text === undefined) return null;
  return text.length > 100 ? { repeat: text[0], count: text.length } : text;
}

function claudeHandOutput(name: string): unknown {
  if (name === "Read") return "   1\tline one\n   2\tline two";
  if (name === "Bash") return { stdout: "ok", stderr: "", exit_code: 0 };
  return "done";
}

const statusRaw: Array<string | null | undefined> = [
  undefined,
  null,
  "",
  "  ",
  "failed",
  "FAILURE",
  " error ",
  "errored",
  "rejected",
  "denied",
  "declined",
  "canceled",
  "cancelled",
  "Interrupted",
  "aborted",
  "completed",
  "complete",
  "done",
  "success",
  "succeeded",
  "running",
  "pending",
  "in_progress",
  "weird",
];
for (const raw of statusRaw) {
  for (const error of [undefined, null, { message: "x" }, "", 0]) {
    for (const output of [undefined, null, "out", 0, ""]) {
      vec(
        "normalizeToolCallStatus",
        `${JSON.stringify(raw ?? null)}|${JSON.stringify(error ?? null)}|${JSON.stringify(output ?? null)}|${error === undefined ? "u" : ""}${output === undefined ? "u" : ""}`,
        {
          rawStatus: raw ?? null,
          rawStatusUndefined: raw === undefined,
          error: error ?? null,
          errorUndefined: error === undefined,
          output: output ?? null,
          outputUndefined: output === undefined,
        },
        () => normalizeToolCallStatus(raw, error, output),
      );
    }
  }
}

for (const value of [undefined, "", "a", "  "] as const) {
  vec(
    "nonEmptyString",
    JSON.stringify(value ?? null),
    { value: value ?? null, undefined: value === undefined },
    () => nonEmptyString(value),
  );
}

const codexShell = [
  "plain output",
  "Chunk ID: abc\nWall time: 0.1 seconds\nProcess exited with code 0\nOriginal token count: 3\nOutput:\nhello\nworld",
  "Chunk ID: abc\r\nWall time: 0.1 seconds\r\nProcess exited with code 1\r\nOutput:\r\nline1\r\nline2",
  "Chunk ID: abc\nWall time: 0.1 seconds\nProcess exited with code 0\nOriginal token count: 3\nbody without marker\nmore",
  "Chunk ID: abc\nWall time: 0.1 seconds\nProcess exited with code 0\nOutput:\n",
  "Chunk ID: abc\nWall time: 0.1 seconds\nProcess exited with code 0",
  "Chunk ID: abc\nsomething else\nProcess exited with code 0",
  "chunk id: x\nwall time: 1\nprocess exited with code 2\noutput:\nlower",
  "",
  "Wall time: 1\nChunk ID: x\nProcess exited with code 0\nOutput:\nreordered",
];
for (const text of codexShell)
  vec("extractCodexShellOutput", text.slice(0, 40), { value: text }, () =>
    extractCodexShellOutput(text),
  );
vec("extractCodexShellOutput", "undefined", { value: null }, () =>
  extractCodexShellOutput(undefined),
);

for (const text of [
  "Process running with session id 123",
  "process RUNNING with session id abc-DEF_1.2:3 more",
  "no match",
  "",
  "session id 5",
]) {
  vec("extractCodexTerminalSessionId", text.slice(0, 40), { value: text }, () =>
    extractCodexTerminalSessionId(text),
  );
}

const readChunks: unknown[] = [
  "text",
  "",
  undefined,
  { text: "a" },
  { content: "b" },
  { output: "c" },
  { text: "", content: "d" },
  [{ text: "a" }, { content: "b" }, { output: "c" }, {}],
  [],
  [{ text: "" }, {}],
  [{ text: "x" }],
];
readChunks.forEach((value, index) =>
  vec(
    "flattenReadContent",
    `case-${index}`,
    { value: value ?? null, undefined: value === undefined },
    () => flattenReadContent(value as never),
  ),
);

const gutterCases: Array<string | undefined> = [
  undefined,
  "",
  "   1\timport a\n   2\timport b\n   3\t",
  "10\tfoo\n11\tbar",
  "   1\ta\n   3\tb",
  "plain\nsource",
  "   1\tfirst\nsecond no gutter\n   3\tthird",
  "\n   1\tleading blank\n   2\tx",
  "1\tonly",
  "   1\ta\r\n   2\tb\r\n",
  "  1\t\n  2\t\n  3\tz",
  "1\ta\n2\tb\nnot\nnot2\nnot3",
  "0\tzero\n1\tone",
  "a\t1\n2\tb",
  "  99\ta\n 100\tb",
  "   1\tcol\twith\ttabs\n   2\tx",
];
gutterCases.forEach((value, index) =>
  vec(
    "stripReadLineNumberGutter",
    `case-${index}`,
    { value: value ?? null, undefined: value === undefined },
    () => stripReadLineNumberGutter(value),
  ),
);

for (const [text, max] of [
  [undefined, undefined],
  ["short", undefined],
  ["x".repeat(12000), undefined],
  ["x".repeat(12001), undefined],
  ["abcdef", 3],
  ["abc", 3],
  ["\u{1f600}\u{1f600}\u{1f600}", 3],
  ["abcdef", 0],
] as Array<[string | undefined, number | undefined]>) {
  vec(
    "truncateDiffText",
    `${text?.length ?? "u"}|${max ?? "d"}`,
    { text: describeText(text), max: max ?? null },
    () => truncateDiffText(text, max),
  );
}

const idInputs: Array<{
  providerPrefix: string;
  rawCallId: string | null | undefined;
  toolName: string;
  input: unknown;
}> = [
  { providerPrefix: "codex", rawCallId: "given", toolName: "shell", input: {} },
  { providerPrefix: "codex", rawCallId: "  ", toolName: "shell", input: { a: 1 } },
  { providerPrefix: "codex", rawCallId: null, toolName: "shell", input: { command: "ls" } },
  { providerPrefix: "codex", rawCallId: undefined, toolName: "shell", input: undefined },
  { providerPrefix: "claude", rawCallId: "", toolName: "Bash", input: "string input" },
  { providerPrefix: "p", rawCallId: null, toolName: "t", input: null },
  {
    providerPrefix: "p",
    rawCallId: null,
    toolName: "\u{1f600}tool",
    input: { emoji: "\u{1f4a5}中" },
  },
  { providerPrefix: "p", rawCallId: null, toolName: "long", input: { text: "x".repeat(5000) } },
  {
    providerPrefix: "p",
    rawCallId: null,
    toolName: "nested",
    input: { a: [1, 2, { b: null }], c: "d" },
  },
  { providerPrefix: "p", rawCallId: null, toolName: "", input: 12345 },
  { providerPrefix: "p", rawCallId: null, toolName: "bool", input: true },
  { providerPrefix: "p", rawCallId: null, toolName: "fn", input: () => 1 },
  { providerPrefix: "p", rawCallId: null, toolName: "lone", input: "\ud83d" },
];
for (const [index, input] of idInputs.entries()) {
  vec(
    "coerceToolCallId",
    `case-${index}`,
    {
      ...input,
      input: typeof input.input === "function" ? "$function" : input.input,
      inputUndefined: input.input === undefined,
      rawCallIdUndefined: input.rawCallId === undefined,
    },
    () => coerceToolCallId(input),
  );
}
{
  // Circular input: JSON.stringify throws, String(input) is used.
  const circular: Json = {};
  circular.self = circular;
  vec(
    "coerceToolCallId",
    "circular",
    { providerPrefix: "p", rawCallId: null, toolName: "c", input: "$circular" },
    () =>
      coerceToolCallId({ providerPrefix: "p", rawCallId: null, toolName: "c", input: circular }),
  );
}

// --- harvest raw tool payloads from the crate fixtures ----------------------------------

const root = resolveOutRoot();
const crates = resolveCratesDir(root);
const fx = (crate: string, name: string) => path.join(crates, crate, "fixtures", name);

function outLines(file: string): Json[] {
  return (readJsonl(file) as Json[])
    .filter((entry) => entry.dir === "out")
    .map((entry) => entry.line as Json);
}

// Claude: pair tool_use blocks with tool_result blocks by id.
const CLAUDE_FIXTURES = [
  "01-single-prompt",
  "02-tool-allow",
  "03-tool-deny",
  "04-pretooluse-hook",
  "05-sdk-mcp-tool",
  "06-interrupt",
  "08-resume",
  "09-partial-messages",
  "10-rewind-files",
];
interface ClaudeUse {
  id: string;
  name: string;
  input: unknown;
}
const claudeSeen = new Set<string>();
for (const name of CLAUDE_FIXTURES) {
  let lines: Json[];
  try {
    lines = outLines(fx("paseo-claude", `${name}.jsonl`));
  } catch {
    continue;
  }
  const uses = new Map<string, ClaudeUse>();
  for (const line of lines) {
    const content = ((line.message as Json | undefined)?.content ?? []) as Json[];
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type === "tool_use") {
        const use = { id: block.id as string, name: block.name as string, input: block.input };
        uses.set(use.id, use);
        const key = `running:${use.id}`;
        if (claudeSeen.has(key)) continue;
        claudeSeen.add(key);
        vec(
          "mapClaudeRunningToolCall",
          `${name}:${use.name}:${use.id}`,
          { callId: use.id, name: use.name, input: use.input },
          () => mapClaudeRunningToolCall({ callId: use.id, name: use.name, input: use.input }),
        );
      } else if (block.type === "tool_result") {
        const use = uses.get(block.tool_use_id as string);
        if (!use) continue;
        const isError = block.is_error === true;
        const meta = { callId: use.id, name: use.name, input: use.input, output: block.content };
        if (isError) {
          vec(
            "mapClaudeFailedToolCall",
            `${name}:${use.name}:${use.id}`,
            { ...meta, error: block.content },
            () => mapClaudeFailedToolCall({ ...meta, error: block.content }),
          );
        } else {
          vec("mapClaudeCompletedToolCall", `${name}:${use.name}:${use.id}`, meta, () =>
            mapClaudeCompletedToolCall(meta),
          );
        }
        vec("mapClaudeCanceledToolCall", `${name}:${use.name}:${use.id}`, meta, () =>
          mapClaudeCanceledToolCall(meta),
        );
      }
    }
  }
}
const claudeHand: Array<[string, Json]> = [
  ["Bash", { command: "ls -la", description: "list", timeout: 1000 }],
  ["Read", { file_path: "/a/b.ts", offset: 5, limit: 10 }],
  ["Write", { file_path: "/a/b.ts", content: "x" }],
  ["Edit", { file_path: "/a/b.ts", old_string: "a", new_string: "b" }],
  [
    "MultiEdit",
    {
      file_path: "/a/b.ts",
      edits: [
        { old_string: "a", new_string: "b" },
        { old_string: "c", new_string: "d" },
      ],
    },
  ],
  ["Grep", { pattern: "foo", path: "/src", output_mode: "content" }],
  ["Glob", { pattern: "**/*.ts" }],
  ["WebSearch", { query: "rust serde" }],
  ["WebFetch", { url: "https://example.com", prompt: "summarize" }],
  ["ExitPlanMode", { plan: "1. do it" }],
  ["ExitPlanMode", { notplan: true }],
  ["mcp__paseo__speak", { text: "hi" }],
  ["Task", { description: "d", prompt: "p", subagent_type: "general" }],
  ["TodoWrite", { todos: [{ content: "a", status: "pending" }] }],
  ["Unknown", { anything: [1, 2] }],
];
for (const [name, input] of claudeHand) {
  const base = { callId: `hand-${name}`, name, input };
  vec("mapClaudeRunningToolCall", `hand:${name}`, base, () => mapClaudeRunningToolCall(base));
  const out = { ...base, output: claudeHandOutput(name) };
  vec("mapClaudeCompletedToolCall", `hand:${name}`, out, () => mapClaudeCompletedToolCall(out));
  vec("mapClaudeFailedToolCall", `hand:${name}`, { ...out, error: { message: "denied" } }, () =>
    mapClaudeFailedToolCall({ ...out, error: { message: "denied" } }),
  );
  vec("mapClaudeFailedToolCall", `hand-no-error:${name}`, { ...base, error: undefined }, () =>
    mapClaudeFailedToolCall({ ...base, error: undefined }),
  );
  vec("mapClaudeCanceledToolCall", `hand:${name}`, out, () => mapClaudeCanceledToolCall(out));
}
for (const [name, params] of [
  ["no_call_id", { name: "Bash", input: {} }],
  ["blank_call_id", { callId: "  ", name: "Bash", input: {} }],
  ["empty_name", { callId: "x", name: "", input: {} }],
  [
    "metadata",
    { callId: "x", name: "Bash", input: { command: "ls" }, metadata: { parentToolUseId: "p" } },
  ],
] as Array<[string, Json]>) {
  vec("mapClaudeRunningToolCall", `edge:${name}`, params, () =>
    mapClaudeRunningToolCall(params as never),
  );
}

// Codex: item/started + item/completed thread items.
const CODEX_FIXTURES = [
  "01-single-prompt",
  "02-tool-allow",
  "03-tool-deny",
  "04-interrupt",
  "05-resume",
  "08-image-input",
];
const codexSeen = new Set<string>();
for (const name of CODEX_FIXTURES) {
  let lines: Json[];
  try {
    lines = outLines(fx("paseo-codex", `${name}.jsonl`));
  } catch {
    continue;
  }
  for (const line of lines) {
    if (line.method !== "item/started" && line.method !== "item/completed") continue;
    const item = (line.params as Json).item as Json;
    if (item.type === "userMessage" || item.type === "agentMessage" || item.type === "reasoning")
      continue;
    const key = `${line.method}:${JSON.stringify(item)}`;
    if (codexSeen.has(key)) continue;
    codexSeen.add(key);
    vec(
      "mapCodexToolCallFromThreadItem",
      `${name}:${line.method}:${String(item.type)}:${String(item.id)}`,
      item,
      () => mapCodexToolCallFromThreadItem(item),
    );
    vec(
      "mapCodexToolCallFromThreadItem",
      `${name}:${line.method}:${String(item.type)}:${String(item.id)}:cwd`,
      { item, options: { cwd: "/tmp/paseo-codex-fixture" } },
      () => mapCodexToolCallFromThreadItem(item, { cwd: "/tmp/paseo-codex-fixture" } as never),
    );
  }
}
const codexHandItems: Json[] = [
  {
    type: "commandExecution",
    id: "ce1",
    command: "ls -la",
    cwd: "/w",
    status: "inProgress",
    aggregatedOutput: null,
    exitCode: null,
  },
  {
    type: "commandExecution",
    id: "ce2",
    command: ["bash", "-lc", "echo hi"],
    cwd: "/w",
    status: "completed",
    aggregatedOutput: "hi\n",
    exitCode: 0,
  },
  {
    type: "commandExecution",
    id: "ce3",
    command: "false",
    cwd: "/w",
    status: "failed",
    aggregatedOutput: "",
    exitCode: 1,
  },
  { type: "commandExecution", id: "ce4", command: "x", cwd: "/w", status: "declined" },
  {
    type: "fileChange",
    id: "fc1",
    status: "completed",
    changes: [{ path: "/w/a.txt", kind: { type: "update" }, diff: "@@ -1 +1 @@\n-a\n+b\n" }],
  },
  {
    type: "fileChange",
    id: "fc2",
    status: "inProgress",
    changes: [{ path: "/w/new.txt", kind: { type: "add" }, diff: "hello\n" }],
  },
  {
    type: "mcpToolCall",
    id: "mc1",
    server: "paseo",
    tool: "list_agents",
    status: "completed",
    arguments: { a: 1 },
    result: { content: [{ type: "text", text: "ok" }] },
    error: null,
  },
  {
    type: "mcpToolCall",
    id: "mc2",
    server: "paseo",
    tool: "x",
    status: "failed",
    arguments: {},
    result: null,
    error: { message: "boom" },
  },
  { type: "webSearch", id: "ws1", query: "rust" },
  { type: "plan", id: "pl1", text: "1. a" },
  {
    type: "collabAgentToolCall",
    id: "ca1",
    tool: "spawnAgent",
    status: "completed",
    senderThreadId: "t1",
    receiverThreadIds: ["t2"],
    prompt: "do",
    agentsStates: {},
  },
  { type: "unknownKind", id: "uk1" },
  { type: "commandExecution", command: "no id" },
];
codexHandItems.forEach((item, index) =>
  vec("mapCodexToolCallFromThreadItem", `hand-${index}:${String(item.type)}`, item, () =>
    mapCodexToolCallFromThreadItem(item),
  ),
);
const codexEnvelopes: Json[] = [
  {
    callId: "e1",
    name: "shell",
    input: { command: "ls" },
    output: "Chunk ID: a\nWall time: 1\nProcess exited with code 0\nOutput:\nx",
    cwd: "/w",
  },
  {
    callId: "e2",
    name: "apply_patch",
    input: { patch: "*** Begin Patch\n*** Update File: a.txt\n@@\n-a\n+b\n*** End Patch" },
    output: "Success",
  },
  { callId: "e3", name: "read_file", input: { path: "/a" }, output: "content" },
  { callId: "e4", name: "shell", input: { command: "x" }, error: { message: "bad" } },
  { callId: "", name: "shell" },
  { callId: "e5", name: "  " },
  {
    callId: "e6",
    name: "web_search",
    input: { query: "q" },
    output: { results: [{ title: "t", url: "https://u" }] },
  },
  { callId: "e7", name: "custom_tool", input: { x: 1 }, output: { y: 2 } },
];
codexEnvelopes.forEach((params, index) =>
  vec("mapCodexToolCallEnvelope", `hand-${index}:${String(params.name)}`, params, () =>
    mapCodexToolCallEnvelope(params as never),
  ),
);

// OpenCode: tool parts from SSE message.part.updated.
const OPENCODE_FIXTURES = [
  "01-prompt-reply",
  "02-permission-allow",
  "03-permission-deny",
  "04-interrupt",
  "05-resume",
  "08-image-prompt",
];
const openSeen = new Set<string>();
for (const name of OPENCODE_FIXTURES) {
  let rows: Json[];
  try {
    rows = readJsonl(fx("paseo-opencode", `${name}.jsonl`)) as Json[];
  } catch {
    continue;
  }
  for (const row of rows) {
    if (row.dir !== "sse") continue;
    const payload = (row.event as Json).payload as Json | undefined;
    if (payload?.type !== "message.part.updated") continue;
    const part = (payload.properties as Json).part as Json;
    if (part.type !== "tool") continue;
    const state = (part.state ?? {}) as Json;
    const params = {
      toolName: part.tool,
      callId: part.callID,
      status: state.status,
      input: state.input,
      output: state.output,
      error: state.error,
      metadata: state.metadata,
    };
    const key = JSON.stringify(params);
    if (openSeen.has(key)) continue;
    openSeen.add(key);
    vec(
      "mapOpencodeToolCall",
      `${name}:${String(part.tool)}:${String(state.status)}:${String(part.callID)}`,
      params,
      () => mapOpencodeToolCall(params as never),
    );
  }
}
const opencodeHand: Json[] = [
  { toolName: "bash", callId: "o1", status: "running", input: { command: "ls", description: "d" } },
  {
    toolName: "bash",
    callId: "o2",
    status: "completed",
    input: { command: "ls" },
    output: "a\nb",
    metadata: { exit: 0 },
  },
  { toolName: "bash", callId: "o3", status: "error", input: { command: "ls" }, error: "nope" },
  {
    toolName: "read",
    callId: "o4",
    status: "completed",
    input: { filePath: "/a", offset: 1, limit: 5 },
    output: "<file>\n00001| a\n</file>",
  },
  {
    toolName: "edit",
    callId: "o5",
    status: "completed",
    input: { filePath: "/a", oldString: "a", newString: "b" },
    output: "ok",
    metadata: { diff: "--- a\n+++ b" },
  },
  {
    toolName: "write",
    callId: "o6",
    status: "completed",
    input: { filePath: "/a", content: "x" },
    output: "ok",
  },
  {
    toolName: "grep",
    callId: "o7",
    status: "completed",
    input: { pattern: "x", path: "/" },
    output: "Found 1 matches\n/a:1: x",
  },
  {
    toolName: "glob",
    callId: "o8",
    status: "completed",
    input: { pattern: "*.ts" },
    output: "/a.ts\n/b.ts",
  },
  {
    toolName: "webfetch",
    callId: "o9",
    status: "completed",
    input: { url: "https://e.com", format: "markdown" },
    output: "# hi",
  },
  {
    toolName: "task",
    callId: "o10",
    status: "running",
    input: { description: "d", prompt: "p", subagent_type: "general" },
  },
  { toolName: "todowrite", callId: "o11", status: "completed", input: { todos: [] }, output: "[]" },
  {
    toolName: "unknown_tool",
    callId: "o12",
    status: "completed",
    input: { a: 1 },
    output: { b: 2 },
  },
  { toolName: "bash", callId: "  trimmed  ", status: "completed", input: {}, output: "" },
  { toolName: "bash", status: "completed", input: {} },
  { toolName: "", callId: "x" },
];
opencodeHand.forEach((params, index) =>
  vec("mapOpencodeToolCall", `hand-${index}:${String(params.toolName)}`, params, () =>
    mapOpencodeToolCall(params as never),
  ),
);

// Pi: tool_execution_* events -> parseToolArgs + mapToolDetail.
const PI_FIXTURES = [
  "01-prompt-reply",
  "02-tool-bash",
  "03-permission-allow",
  "04-permission-deny",
  "05-interrupt",
  "06-resume",
  "07-model-thinking-switch",
];
const piSeen = new Set<string>();
function piVector(
  fn: "pi" | "omp",
  name: string,
  toolName: string,
  args: unknown,
  rawResult: unknown,
): void {
  const key = `${fn}:${toolName}:${JSON.stringify(args)}:${JSON.stringify(rawResult)}`;
  if (piSeen.has(key)) return;
  piSeen.add(key);
  const input = {
    toolName,
    args: args ?? null,
    rawResult: rawResult ?? null,
    rawResultUndefined: rawResult === undefined,
  };
  if (fn === "pi") {
    vec("pi.parseToolArgs", name, { toolName, args: args ?? null }, () =>
      parsePiToolArgs(toolName, args),
    );
    vec("pi.parseToolResult", name, { rawResult: rawResult ?? null }, () =>
      parsePiToolResult(rawResult),
    );
    vec("pi.mapToolDetail", name, input, () =>
      mapPiToolDetail(
        parsePiToolArgs(toolName, args),
        rawResult === undefined ? undefined : parsePiToolResult(rawResult),
      ),
    );
  } else {
    vec("omp.parseToolArgs", name, { toolName, args: args ?? null }, () =>
      parseOmpToolArgs(toolName, args),
    );
    vec("omp.parseToolResult", name, { rawResult: rawResult ?? null }, () =>
      parseOmpToolResult(rawResult),
    );
    vec("omp.mapOmpToolDetail", name, input, () =>
      mapOmpToolDetail(parseOmpToolArgs(toolName, args), parseOmpToolResult(rawResult ?? null)),
    );
    vec("omp.mapToolDetail(core)", name, input, () =>
      mapOmpCoreToolDetail(parseOmpToolArgs(toolName, args), parseOmpToolResult(rawResult ?? null)),
    );
  }
}
for (const name of PI_FIXTURES) {
  let lines: Json[];
  try {
    lines = outLines(fx("paseo-pi", `${name}.jsonl`));
  } catch {
    continue;
  }
  const starts = new Map<string, Json>();
  for (const line of lines) {
    if (line.type === "tool_execution_start") starts.set(line.toolCallId as string, line);
    if (line.type === "tool_execution_end") {
      const start = starts.get(line.toolCallId as string);
      piVector(
        "pi",
        `${name}:${String(line.toolName)}`,
        line.toolName as string,
        start?.args,
        line.result,
      );
      piVector(
        "omp",
        `${name}:${String(line.toolName)}`,
        line.toolName as string,
        start?.args,
        line.result,
      );
    }
  }
}
const piHand: Array<[string, unknown, unknown]> = [
  [
    "bash",
    { command: "ls", timeout: 5 },
    { content: [{ type: "text", text: "a\nb\n" }], details: { exitCode: 0 } },
  ],
  ["bash", { command: "false" }, "plain string result"],
  ["bash", { command: "x" }, { output: "o", exit_code: 2 }],
  ["bash", { nocommand: true }, null],
  ["read", { path: "/a", offset: 2, limit: 3 }, { content: [{ type: "text", text: "l1\nl2" }] }],
  [
    "edit",
    {
      path: "/a",
      edits: [
        { oldText: "a", newText: "b" },
        { oldText: "c", newText: "d" },
      ],
    },
    { content: [], details: { diff: "-a\n+b" } },
  ],
  ["edit", { path: "/a", oldText: "a", newText: "b" }, null],
  ["write", { path: "/a", content: "x" }, { content: [{ type: "text", text: "Wrote" }] }],
  [
    "find",
    { pattern: "*.ts", path: "/src" },
    { content: [{ type: "text", text: "/src/a.ts\n/src/b.ts" }] },
  ],
  [
    "grep",
    { pattern: "foo", path: "/src", glob: "*.ts" },
    { content: [{ type: "text", text: "/src/a.ts:1: foo" }] },
  ],
  ["ls", { path: "/src", limit: 10 }, { content: [{ type: "text", text: "a\nb" }] }],
  ["custom", { anything: 1 }, { content: [{ type: "text", text: "x" }] }],
  ["task", { description: "d" }, { content: [] }],
  ["todo", { items: [] }, undefined],
];
for (const [toolName, args, result] of piHand) {
  piVector("pi", `hand:${toolName}`, toolName, args, result);
  piVector("omp", `hand:${toolName}`, toolName, args, result);
}

// --- project_agent_message --------------------------------------------------------------

const envelope = (id: string, source: unknown, text: string) =>
  JSON.stringify({ paseo: { version: 1, id, ...(source ? { source } : {}), text } });
void envelope;
const projectItems: AgentTimelineItem[] = [
  { type: "user_message", text: "plain prompt" },
  { type: "user_message", text: "<paseo-system>\nschedule fired\n</paseo-system>" },
  { type: "user_message", text: "<paseo-system>\nunterminated" },
  { type: "assistant_message", text: "hello" },
  { type: "reasoning", text: "think" },
  { type: "user_message", text: "", clientMessageId: "c" },
];
projectItems.forEach((item, index) =>
  vec("projectAgentMessage", `plain-${index}`, item, () => projectAgentMessage(item)),
);
// Versioned envelopes are produced by prepareAgentMessage; round-trip through it.
import { prepareAgentMessage } from "../src/server/agent/agent-messages/index.js";
for (const [name, prompt, source] of [
  [
    "agent_message_with_title",
    "hello agent",
    { kind: "agent-message", agentId: "a1", title: "Sender" },
  ],
  ["agent_message_no_title", "hello agent", { kind: "agent-message", agentId: "a1" }],
  [
    "notification_finished",
    "done",
    { kind: "agent-notification", agentId: "a2", title: "Worker", event: "finished" },
  ],
  [
    "notification_permission",
    "needs approval",
    { kind: "agent-notification", agentId: "a2", event: "permission-required" },
  ],
  ["user_without_source", "from user", null],
] as Array<[string, string, unknown]>) {
  let prepared: unknown;
  try {
    prepared = (prepareAgentMessage as unknown as (...a: unknown[]) => unknown)(prompt, source, {
      id: `msg-${name}`,
    });
  } catch (error) {
    prepared = { threw: errorSummary(error) };
  }
  vec("prepareAgentMessage", name, { prompt, source }, () => prepared);
  const text = (prepared as { prompt?: unknown })?.prompt;
  if (typeof text === "string") {
    vec("projectAgentMessage", `envelope:${name}`, { type: "user_message", text }, () =>
      projectAgentMessage({ type: "user_message", text }),
    );
  }
}

// --- wire serializer ---------------------------------------------------------------------

const turn = { provider: "claude", turnId: "t1" };
const toolBase = { type: "tool_call", callId: "c1", name: "shell" };
const wireEvents: Array<[string, unknown]> = [
  ["thread_started", { type: "thread_started", sessionId: "s1", provider: "claude" }],
  ["turn_started", { type: "turn_started", ...turn }],
  ["turn_started_no_turn_id", { type: "turn_started", provider: "claude" }],
  [
    "turn_completed_usage",
    {
      type: "turn_completed",
      ...turn,
      usage: { inputTokens: 1, outputTokens: 2, cachedInputTokens: 3, totalCostUsd: 0.5 },
    },
  ],
  ["turn_completed_extra_key", { type: "turn_completed", ...turn, extra: 1 }],
  ["turn_failed", { type: "turn_failed", ...turn, error: "boom", code: "E", diagnostic: "d" }],
  ["turn_failed_missing_error", { type: "turn_failed", ...turn }],
  ["turn_canceled", { type: "turn_canceled", ...turn, reason: "user" }],
  ["usage_updated", { type: "usage_updated", ...turn, usage: { inputTokens: 1 } }],
  [
    "mode_changed",
    { type: "mode_changed", provider: "claude", currentModeId: "plan", availableModes: [] },
  ],
  [
    "model_changed",
    {
      type: "model_changed",
      provider: "claude",
      runtimeInfo: { provider: "claude", sessionId: "s" },
    },
  ],
  [
    "thinking_option_changed",
    { type: "thinking_option_changed", provider: "claude", thinkingOptionId: null },
  ],
  ["provider_subagent", { type: "provider_subagent", provider: "claude", subagentId: "x" }],
  [
    "timeline_assistant",
    {
      type: "timeline",
      provider: "claude",
      turnId: "t1",
      item: { type: "assistant_message", text: "hi", messageId: "m" },
    },
  ],
  [
    "timeline_assistant_with_timestamp",
    {
      type: "timeline",
      provider: "claude",
      timestamp: "2026-01-01T00:00:00.000Z",
      item: { type: "assistant_message", text: "hi" },
    },
  ],
  [
    "timeline_unknown_item_type",
    { type: "timeline", provider: "claude", item: { type: "mystery", a: 1 } },
  ],
  [
    "tool_running_unknown_detail_omitted_io",
    {
      type: "timeline",
      ...turn,
      item: { ...toolBase, status: "running", error: null, detail: { type: "unknown" } },
    },
  ],
  [
    "tool_unknown_detail_values",
    {
      type: "timeline",
      ...turn,
      item: {
        ...toolBase,
        status: "completed",
        error: null,
        detail: { type: "unknown", input: { a: 1 }, output: "o" },
      },
    },
  ],
  [
    "tool_unknown_detail_null_io",
    {
      type: "timeline",
      ...turn,
      item: {
        ...toolBase,
        status: "completed",
        error: null,
        detail: { type: "unknown", input: null, output: null },
      },
    },
  ],
  [
    "tool_failed_null_error",
    {
      type: "timeline",
      ...turn,
      item: { ...toolBase, status: "failed", error: null, detail: { type: "shell", command: "x" } },
    },
  ],
  [
    "tool_failed_missing_error",
    {
      type: "timeline",
      ...turn,
      item: { ...toolBase, status: "failed", detail: { type: "shell", command: "x" } },
    },
  ],
  [
    "tool_failed_error_object",
    {
      type: "timeline",
      ...turn,
      item: {
        ...toolBase,
        status: "failed",
        error: { message: "bad", code: 1 },
        detail: { type: "shell", command: "x" },
      },
    },
  ],
  [
    "tool_completed_error_non_null",
    {
      type: "timeline",
      ...turn,
      item: {
        ...toolBase,
        status: "completed",
        error: { message: "?" },
        detail: { type: "shell", command: "x" },
      },
    },
  ],
  [
    "tool_extra_keys_metadata",
    {
      type: "timeline",
      ...turn,
      item: {
        ...toolBase,
        status: "running",
        error: null,
        detail: { type: "shell", command: "x", extra: 1 },
        metadata: { m: 1 },
        agentMessage: { event: "message", sender: { id: "a" }, text: "t" },
        bogus: true,
      },
    },
  ],
  [
    "tool_detail_all_kinds_read",
    {
      type: "timeline",
      ...turn,
      item: {
        ...toolBase,
        name: "read",
        status: "completed",
        error: null,
        detail: { type: "read", filePath: "/a", content: "c", offset: 1, limit: 2 },
      },
    },
  ],
  [
    "tool_detail_search",
    {
      type: "timeline",
      ...turn,
      item: {
        ...toolBase,
        name: "grep",
        status: "completed",
        error: null,
        detail: { type: "search", query: "q", toolName: "grep", filePaths: ["/a"], numMatches: 1 },
      },
    },
  ],
  [
    "tool_detail_plain_text_icon",
    {
      type: "timeline",
      ...turn,
      item: {
        ...toolBase,
        status: "completed",
        error: null,
        detail: { type: "plain_text", text: "t", icon: "bot" },
      },
    },
  ],
  [
    "tool_detail_invalid_icon",
    {
      type: "timeline",
      ...turn,
      item: {
        ...toolBase,
        status: "completed",
        error: null,
        detail: { type: "plain_text", text: "t", icon: "nope" },
      },
    },
  ],
  [
    "tool_detail_sub_agent",
    {
      type: "timeline",
      ...turn,
      item: {
        ...toolBase,
        name: "task",
        status: "running",
        error: null,
        detail: { type: "sub_agent", log: "", actions: [{ index: 1, toolName: "x" }] },
      },
    },
  ],
  [
    "tool_missing_call_id",
    {
      type: "timeline",
      ...turn,
      item: {
        type: "tool_call",
        name: "shell",
        status: "running",
        error: null,
        detail: { type: "shell", command: "x" },
      },
    },
  ],
  [
    "plugin_item",
    {
      type: "timeline",
      ...turn,
      item: {
        type: "plugin",
        id: "i",
        pluginId: "p",
        kind: "k",
        version: 1,
        data: { a: [1, null] },
      },
    },
  ],
  [
    "todo_item",
    { type: "timeline", ...turn, item: { type: "todo", items: [{ text: "a", completed: false }] } },
  ],
  [
    "compaction_item",
    {
      type: "timeline",
      ...turn,
      item: { type: "compaction", status: "completed", trigger: "auto", preTokens: 5 },
    },
  ],
  [
    "notification_item",
    { type: "timeline", ...turn, item: { type: "notification", level: "warning", message: "m" } },
  ],
  ["error_item", { type: "timeline", ...turn, item: { type: "error", message: "m" } }],
  [
    "permission_requested",
    {
      type: "permission_requested",
      provider: "claude",
      turnId: "t1",
      request: {
        id: "p1",
        provider: "claude",
        name: "Bash",
        kind: "tool",
        input: { command: "ls" },
      },
    },
  ],
  [
    "permission_requested_bad",
    { type: "permission_requested", provider: "claude", request: { id: "p1" } },
  ],
  [
    "permission_resolved",
    {
      type: "permission_resolved",
      provider: "claude",
      requestId: "p1",
      resolution: { behavior: "allow" },
    },
  ],
  [
    "permission_resolved_deny",
    {
      type: "permission_resolved",
      provider: "claude",
      requestId: "p1",
      resolution: { behavior: "deny", message: "no" },
    },
  ],
  [
    "attention_required_stripped",
    {
      type: "attention_required",
      provider: "claude",
      reason: "finished",
      timestamp: "2026-01-01T00:00:00.000Z",
      shouldNotify: true,
      extra: 1,
    },
  ],
  [
    "attention_required_error",
    {
      type: "attention_required",
      provider: "claude",
      reason: "error",
      timestamp: "2026-01-01T00:00:00.000Z",
    },
  ],
  [
    "attention_required_bad_reason",
    { type: "attention_required", provider: "claude", reason: "zzz", timestamp: "t" },
  ],
  ["unknown_event_type", { type: "mystery", provider: "claude" }],
];
for (const [name, event] of wireEvents) {
  vec("serializeAgentStreamEvent", name, event, () =>
    serializeAgentStreamEvent(event as AgentStreamEvent),
  );
}

const dir = areaDir(root, "mapper-vectors");
const byFn = new Map<string, Vector[]>();
for (const v of vectors) {
  const list = byFn.get(v.fn) ?? [];
  list.push(v);
  byFn.set(v.fn, list);
}
const groups: Record<string, string[]> = {
  "tool-call-mapper-utils": [
    "normalizeToolCallStatus",
    "nonEmptyString",
    "extractCodexShellOutput",
    "extractCodexTerminalSessionId",
    "flattenReadContent",
    "stripReadLineNumberGutter",
    "truncateDiffText",
    "coerceToolCallId",
  ],
  claude: [
    "mapClaudeRunningToolCall",
    "mapClaudeCompletedToolCall",
    "mapClaudeFailedToolCall",
    "mapClaudeCanceledToolCall",
  ],
  codex: ["mapCodexToolCallFromThreadItem", "mapCodexToolCallEnvelope"],
  opencode: ["mapOpencodeToolCall"],
  pi: ["pi.parseToolArgs", "pi.parseToolResult", "pi.mapToolDetail"],
  omp: [
    "omp.parseToolArgs",
    "omp.parseToolResult",
    "omp.mapOmpToolDetail",
    "omp.mapToolDetail(core)",
  ],
  "agent-messages": ["projectAgentMessage", "prepareAgentMessage"],
  "wire-serializer": ["serializeAgentStreamEvent"],
};
const manifest: Record<string, number> = {};
for (const [group, fns] of Object.entries(groups)) {
  const rows = fns.flatMap((fn) => byFn.get(fn) ?? []);
  writeJsonl(dir, `${group}.jsonl`, rows);
  manifest[group] = rows.length;
}
writeJson(dir, "README.json", {
  note: "Each *.jsonl line is {fn,name,input,output,threw?}. `input` is the JSON-safe call input (null in place of undefined; *Undefined flags mark where undefined was passed). `output: null` with `threw` set means the TS function threw. mapper vectors with inputs harvested from the paseo-* crate fixtures are named <fixture>:<tool>:<id>; handwritten edge cases are named hand-*/edge:*. serializeAgentStreamEvent returns null when TS drops the event (validation failure).",
  counts: manifest,
});
