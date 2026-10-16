/**
 * P4 WP0: golden fixtures for the Paseo tool catalog and /mcp/agents surface:
 * tools/list per catalog configuration, per-tool input/output JSON schemas,
 * tools/call transcripts through a real MCP server/client pair, and the
 * structured-content text synthesis vectors.
 *
 *   tsx scripts/capture-tool-catalog-fixtures.ts --out <fixtures/p4>
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  normalizeObjectSchema,
  type AnySchema,
  type ZodRawShapeCompat,
} from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import pino from "pino";

import { createAgentMcpServer } from "../src/server/agent/mcp-server.js";
import {
  addModelVisibleStructuredContent,
  serializePaseoToolInputParameters,
} from "../src/server/agent/tools/paseo-tool-serialization.js";
import {
  createPaseoToolCatalog,
  type PaseoToolHostDependencies,
} from "../src/server/agent/tools/paseo-tools.js";
import { createPersistedWorkspaceRecord } from "../src/server/workspace-registry.js";
import { areaDir, errorSummary, resolveOutRoot, writeJson } from "./p4-fixture-utils.js";

// --- fake clock (Date.now and argument-less new Date) -------------------------

const FIXED_NOW = Date.parse("2026-02-01T12:00:00.000Z");
const RealDate = Date;
class FakeDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(FIXED_NOW);
    else super(...(args as [number]));
  }
  static override now(): number {
    return FIXED_NOW;
  }
}
globalThis.Date = FakeDate as unknown as DateConstructor;

const T0 = "2026-01-15T10:00:00.000Z";
const logger = pino({ level: "silent" });

// --- stubs ---------------------------------------------------------------------

const LIVE_ID = "11111111-1111-4111-8111-111111111111";
const STORED_ID = "22222222-2222-4222-8222-222222222222";

function managedAgent(overrides: Record<string, unknown> = {}) {
  const at = new RealDate(T0);
  return {
    id: LIVE_ID,
    provider: "claude",
    cwd: "/work/repo",
    workspaceId: "wks_0000000000000001",
    config: {},
    runtimeInfo: undefined,
    createdAt: at,
    updatedAt: at,
    lastUserMessageAt: null,
    lifecycle: "idle",
    capabilities: {
      supportsStreaming: false,
      supportsSessionPersistence: false,
      supportsDynamicModes: false,
      supportsMcpServers: true,
      supportsReasoningStream: false,
      supportsToolInvocations: true,
    },
    currentModeId: "default",
    availableModes: [],
    features: [],
    pendingPermissions: new Map(),
    persistence: null,
    labels: {},
    attention: { requiresAttention: false },
    ...overrides,
  };
}

const livePermission = {
  id: "perm-1",
  provider: "claude",
  name: "Bash",
  kind: "tool",
  title: "Run command",
  input: { command: "ls" },
};

const liveAgents = [
  managedAgent(),
  managedAgent({
    id: "33333333-3333-4333-8333-333333333333",
    lifecycle: "running",
    pendingPermissions: new Map([["perm-1", livePermission]]),
  }),
];

const timeline = [
  { type: "user_message", text: "hello" },
  { type: "assistant_message", text: "Hi " },
  { type: "assistant_message", text: "there" },
  {
    type: "tool_call",
    callId: "c1",
    name: "shell",
    detail: { type: "shell", command: "ls", output: "a\nb" },
    status: "completed",
    error: null,
  },
];

const storedRecord = {
  id: STORED_ID,
  provider: "claude",
  cwd: "/work/other",
  createdAt: T0,
  updatedAt: T0,
  lastActivityAt: T0,
  lastUserMessageAt: null,
  title: "Stored agent",
  labels: {},
  lastStatus: "closed",
  lastModeId: "default",
  config: { modeId: "default" },
  runtimeInfo: { provider: "claude", sessionId: "s-1" },
  features: [],
  persistence: { provider: "claude", sessionId: "s-1" },
  requiresAttention: false,
  attentionReason: null,
  attentionTimestamp: null,
  internal: false,
  archivedAt: null,
};

const calls: Array<{ target: string; method: string; args: unknown[] }> = [];
const record =
  <T extends (...a: never[]) => unknown>(target: string, method: string, fn: T) =>
  (...args: unknown[]) => {
    calls.push({ target, method, args });
    return (fn as unknown as (...a: unknown[]) => unknown)(...args);
  };

const agentManager = {
  getAgent: (id: string) => liveAgents.find((agent) => agent.id === id) ?? null,
  listAgents: () => liveAgents,
  getTimeline: () => timeline,
  getRegisteredProviderIds: () => ["claude", "codex"],
  listDraftFeatures: record("agentManager", "listDraftFeatures", async () => [
    { type: "toggle", id: "fast", label: "Fast", value: false },
  ]),
  setAgentMode: record("agentManager", "setAgentMode", async () => null),
  respondToPermission: record("agentManager", "respondToPermission", async () => undefined),
  hasInFlightRun: () => false,
};
const agentStorage = {
  get: async (id: string) => (id === STORED_ID ? storedRecord : null),
  list: async () => [storedRecord],
};

const workspaces = [
  createPersistedWorkspaceRecord({
    workspaceId: "wks_0000000000000001",
    projectId: "prj_0000000000000001",
    cwd: "/work/repo",
    kind: "local_checkout",
    displayName: "repo",
    createdAt: T0,
    updatedAt: T0,
  }),
  createPersistedWorkspaceRecord({
    workspaceId: "wks_0000000000000002",
    projectId: "prj_0000000000000001",
    cwd: "/work/repo-wt",
    kind: "worktree",
    displayName: "repo-wt",
    title: "Feature",
    createdAt: T0,
    updatedAt: T0,
  }),
  createPersistedWorkspaceRecord({
    workspaceId: "wks_0000000000000003",
    projectId: "prj_0000000000000002",
    cwd: "/work/bg",
    kind: "directory",
    displayName: "bg",
    background: true,
    createdAt: T0,
    updatedAt: T0,
  }),
  createPersistedWorkspaceRecord({
    workspaceId: "wks_0000000000000004",
    projectId: "prj_0000000000000002",
    cwd: "/work/archived",
    kind: "directory",
    displayName: "archived",
    archivedAt: T0,
    createdAt: T0,
    updatedAt: T0,
  }),
];
const workspaceRegistry = {
  get: async (id: string) => workspaces.find((w) => w.workspaceId === id) ?? null,
  list: async () => workspaces,
  upsert: async () => undefined,
};

const providerEntries = [
  {
    provider: "claude",
    status: "ready",
    enabled: true,
    label: "Claude",
    description: "Anthropic Claude",
    defaultModeId: "default",
    modes: [
      { id: "default", label: "Default", description: "Ask first" },
      { id: "bypassPermissions", label: "Bypass", description: "No prompts", isUnattended: true },
    ],
  },
  {
    provider: "codex",
    status: "unavailable",
    enabled: false,
    label: "Codex",
    description: "OpenAI Codex",
    modes: [],
  },
];
const providerSnapshotManager = {
  listRegisteredProviderIds: () => ["claude", "codex"],
  hasProvider: (id: string) => id === "claude" || id === "codex",
  getProviderLabel: (id: string) => id,
  listProviders: async () => providerEntries,
  getProvider: async ({ provider }: { provider: string }) => {
    const entry = providerEntries.find((e) => e.provider === provider);
    if (!entry) throw new Error(`Provider ${provider} is not configured`);
    return entry;
  },
  listModels: async ({ provider }: { provider: string }) => [
    {
      provider,
      id: "model-a",
      label: "Model A",
      isDefault: true,
      thinkingOptions: [{ id: "high", label: "High" }],
      defaultThinkingOptionId: "high",
    },
    { provider, id: "model-b", label: "Model B" },
  ],
  listModes: async () => [],
  resolveCreateConfig: async () => ({ modeId: undefined, featureValues: undefined }),
};

const daemonConfigStore = {
  get: () => ({
    agentProfiles: [
      {
        id: "reviewer",
        label: "Reviewer",
        provider: "claude",
        model: "model-a",
        modeId: "default",
        notes: "Careful code review.",
      },
    ],
  }),
};

const terminals = [
  { id: "term-1", name: "main", cwd: "/work/repo" },
  { id: "term-2", name: "logs", cwd: "/work/other" },
];
const terminalManager = {
  getTerminals: async (cwd: string) => terminals.filter((t) => t.cwd === cwd),
  listDirectories: () => ["/work/repo", "/work/other"],
  getTerminal: (id: string) => {
    const terminal = terminals.find((t) => t.id === id);
    return terminal
      ? {
          ...terminal,
          kill: record("terminal", "kill", () => undefined),
          send: record("terminal", "send", () => undefined),
        }
      : undefined;
  },
  createTerminal: record(
    "terminalManager",
    "createTerminal",
    async (input: { cwd: string; name?: string }) => ({
      id: "term-new",
      name: input.name ?? "Terminal",
      cwd: input.cwd,
    }),
  ),
  captureTerminal: record("terminalManager", "captureTerminal", async () => ({
    lines: ["$ ls", "a b c"],
    totalLines: 2,
  })),
};

const scheduleRun = {
  id: "run-1",
  scheduledFor: T0,
  startedAt: T0,
  endedAt: T0,
  status: "succeeded",
  agentId: LIVE_ID,
  workspaceId: null,
  output: "ok",
  error: null,
};
const storedSchedule = (id: string, target: "new-agent" | "agent") => ({
  id,
  name: "nightly",
  prompt: "run tests",
  cadence: { type: "cron", expression: "0 2 * * *", timezone: "UTC" },
  target:
    target === "new-agent"
      ? { type: "new-agent", config: { provider: "claude", cwd: "/work/repo" } }
      : { type: "agent", agentId: LIVE_ID },
  status: "active",
  createdAt: T0,
  updatedAt: T0,
  nextRunAt: T0,
  lastRunAt: null,
  pausedAt: null,
  expiresAt: null,
  maxRuns: null,
  runs: [scheduleRun],
});
function scheduleById(id: string): ReturnType<typeof storedSchedule> | null {
  if (id === "sch-1") return storedSchedule("sch-1", "new-agent");
  if (id === "sch-hb") return storedSchedule("sch-hb", "agent");
  return null;
}
const scheduleService = {
  list: async () => [storedSchedule("sch-1", "new-agent"), storedSchedule("sch-hb", "agent")],
  get: async (id: string) => scheduleById(id),
  inspect: async (id: string) => scheduleById(id),
  createOrReplace: record(
    "scheduleService",
    "createOrReplace",
    async (input: { name?: string }) => ({
      ...storedSchedule("sch-new", "new-agent"),
      name: input.name ?? null,
      runs: [],
    }),
  ),
  pause: record("scheduleService", "pause", async () => storedSchedule("sch-1", "new-agent")),
  resume: record("scheduleService", "resume", async () => storedSchedule("sch-1", "new-agent")),
  delete: record("scheduleService", "delete", async () => undefined),
  runOnce: record("scheduleService", "runOnce", async () => storedSchedule("sch-1", "new-agent")),
  update: record("scheduleService", "update", async () => storedSchedule("sch-1", "new-agent")),
  logs: async () => [],
};

const browserBroker = {
  execute: record("browserBroker", "execute", async () => ({ ok: true, result: {} })),
};

function deps(extra: Partial<PaseoToolHostDependencies> = {}): PaseoToolHostDependencies {
  return {
    agentManager,
    agentStorage,
    terminalManager,
    scheduleService,
    providerSnapshotManager,
    daemonConfigStore,
    workspaceRegistry,
    logger,
    ...extra,
  } as unknown as PaseoToolHostDependencies;
}

// --- catalog configurations -------------------------------------------------------

interface ConfigDef {
  name: string;
  description: string;
  options: Partial<PaseoToolHostDependencies>;
}

const speakCalls: unknown[] = [];
const CONFIGS: ConfigDef[] = [
  {
    name: "full",
    description: "Voice tools on, browser tools on with a broker, no caller agent.",
    options: {
      enableVoiceTools: true,
      browserToolsEnabled: true,
      browserToolsBroker: browserBroker as never,
    },
  },
  { name: "default", description: "No voice, no browser, no caller.", options: {} },
  {
    name: "voice_only",
    description: "voiceOnly returns right after speak.",
    options: { voiceOnly: true },
  },
  {
    name: "policy_disabled",
    description: "paseoToolPolicy.enabled=false disables everything except speak.",
    options: { paseoToolPolicy: { enabled: false } as never, enableVoiceTools: true },
  },
  {
    name: "policy_disabled_tools",
    description: "disabledTools removes named tools from list and execute.",
    options: {
      paseoToolPolicy: { disabledTools: ["create_agent", "kill_agent", "list_providers"] } as never,
    },
  },
  {
    name: "caller_agent",
    description: "Agent-scoped catalog: callerAgentId set, caller context enables voice.",
    options: {
      callerAgentId: LIVE_ID,
      resolveCallerContext: () =>
        ({ enableVoiceTools: true, lockedCwd: undefined, allowCustomCwd: true }) as never,
      resolveSpeakHandler: () => async (input: unknown) => {
        speakCalls.push(input);
      },
    },
  },
];

function outputSchemaJson(outputSchema: unknown): unknown {
  if (!outputSchema) return null;
  const schema = normalizeObjectSchema(outputSchema as AnySchema | ZodRawShapeCompat | undefined);
  return schema ? toJsonSchemaCompat(schema, { strictUnions: true, pipeStrategy: "input" }) : null;
}

async function connect(options: Partial<PaseoToolHostDependencies>) {
  const server = await createAgentMcpServer(deps(options));
  const client = new Client({ name: "p4-capture", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

async function captureLists() {
  const out: unknown[] = [];
  for (const config of CONFIGS) {
    const catalog = await createPaseoToolCatalog(deps(config.options));
    const { client, server } = await connect(config.options);
    const mcpList = await client.listTools();
    await client.close();
    await server.close();
    out.push({
      name: config.name,
      description: config.description,
      toolNames: [...catalog.tools.keys()],
      catalogTools: [...catalog.tools.values()].map((tool) => ({
        name: tool.name,
        title: tool.title ?? null,
        description: tool.description,
        inputJsonSchema: serializePaseoToolInputParameters(tool),
        outputJsonSchema: outputSchemaJson(tool.outputSchema),
      })),
      mcpToolsList: mcpList,
    });
  }
  return out;
}

// --- tools/call transcripts ---------------------------------------------------------

interface CallDef {
  config: string;
  tool: string;
  args: unknown;
  note?: string;
}

const CALLS: CallDef[] = [
  { config: "default", tool: "list_providers", args: {} },
  { config: "default", tool: "list_models", args: { provider: "claude" } },
  {
    config: "default",
    tool: "list_models",
    args: {},
    note: "missing required arg -> validation error",
  },
  { config: "default", tool: "list_profiles", args: {} },
  { config: "default", tool: "inspect_provider", args: { provider: "claude", cwd: "/work/repo" } },
  {
    config: "default",
    tool: "inspect_provider",
    args: { provider: "codex", cwd: "/work/repo" },
    note: "disabled provider error",
  },
  { config: "default", tool: "list_workspaces", args: {} },
  { config: "default", tool: "list_workspaces", args: { includeBackground: true } },
  { config: "default", tool: "list_agents", args: {} },
  { config: "default", tool: "list_agents", args: { statuses: ["running"] } },
  { config: "default", tool: "list_agents", args: { cwd: "/work/other", limit: 1 } },
  { config: "default", tool: "get_agent_status", args: { agentId: LIVE_ID } },
  { config: "default", tool: "get_agent_status", args: { agentId: STORED_ID } },
  { config: "default", tool: "get_agent_status", args: { agentId: "missing" } },
  { config: "default", tool: "get_agent_activity", args: { agentId: LIVE_ID } },
  { config: "default", tool: "get_agent_activity", args: { agentId: LIVE_ID, limit: 1 } },
  { config: "default", tool: "list_pending_permissions", args: {} },
  { config: "default", tool: "set_agent_mode", args: { agentId: LIVE_ID, modeId: "plan" } },
  {
    config: "default",
    tool: "respond_to_permission",
    args: { agentId: LIVE_ID, requestId: "perm-1", response: { behavior: "allow" } },
  },
  { config: "default", tool: "list_terminals", args: { cwd: "/work/repo" } },
  { config: "default", tool: "list_terminals", args: { all: true } },
  { config: "default", tool: "list_terminals", args: {}, note: "no cwd outside agent session" },
  {
    config: "default",
    tool: "create_terminal",
    args: { cwd: "/work/repo", name: " build " },
    note: "no workspace minting configured",
  },
  { config: "default", tool: "capture_terminal", args: { terminalId: "term-1", scrollback: true } },
  { config: "default", tool: "capture_terminal", args: { terminalId: "nope" } },
  { config: "default", tool: "send_terminal_keys", args: { terminalId: "term-1", keys: "C-c" } },
  {
    config: "default",
    tool: "send_terminal_keys",
    args: { terminalId: "term-1", keys: "C-c", literal: true },
  },
  { config: "default", tool: "kill_terminal", args: { terminalId: "term-2" } },
  { config: "default", tool: "list_schedules", args: {} },
  { config: "default", tool: "inspect_schedule", args: { id: "sch-1" } },
  {
    config: "default",
    tool: "inspect_schedule",
    args: { id: "sch-hb" },
    note: "heartbeat is not a new-agent schedule",
  },
  { config: "default", tool: "pause_schedule", args: { id: "sch-1" } },
  { config: "default", tool: "resume_schedule", args: { id: "sch-1" } },
  { config: "default", tool: "delete_schedule", args: { id: "sch-1" } },
  { config: "default", tool: "run_schedule_once", args: { id: "sch-1" } },
  {
    config: "default",
    tool: "create_schedule",
    args: {
      prompt: " run tests ",
      cron: "0 2 * * *",
      provider: "claude",
      cwd: "/work/repo",
      name: " nightly ",
    },
  },
  {
    config: "default",
    tool: "create_schedule",
    args: { prompt: "x", cron: "0 2 * * *" },
    note: "provider required without caller",
  },
  {
    config: "default",
    tool: "create_heartbeat",
    args: { prompt: "x", cron: "* * * * *" },
    note: "needs agent session",
  },
  {
    config: "caller_agent",
    tool: "create_heartbeat",
    args: { prompt: "ping", cron: "*/5 * * * *", name: "hb" },
  },
  { config: "caller_agent", tool: "speak", args: { text: "hello there" } },
  { config: "caller_agent", tool: "speak", args: { text: "   " }, note: "validation error" },
  { config: "caller_agent", tool: "list_terminals", args: {} },
  { config: "caller_agent", tool: "list_agents", args: {} },
  { config: "full", tool: "browser_list_tabs", args: {} },
  {
    config: "policy_disabled_tools",
    tool: "list_providers",
    args: {},
    note: "disabled tool is absent at execute",
  },
  { config: "default", tool: "no_such_tool", args: {} },
];

async function captureCalls() {
  const clients = new Map<string, Awaited<ReturnType<typeof connect>>>();
  const transcripts: unknown[] = [];
  for (const call of CALLS) {
    const config = CONFIGS.find((c) => c.name === call.config);
    if (!config) throw new Error(`unknown config ${call.config}`);
    let entry = clients.get(config.name);
    if (!entry) {
      entry = await connect(config.options);
      clients.set(config.name, entry);
    }
    const before = calls.length;
    let response: unknown;
    try {
      response = await entry.client.callTool({ name: call.tool, arguments: call.args as never });
    } catch (error) {
      response = { threw: errorSummary(error) };
    }
    transcripts.push({
      config: call.config,
      tool: call.tool,
      args: call.args,
      ...(call.note ? { note: call.note } : {}),
      response,
      sideEffects: calls.slice(before),
    });
  }
  for (const { client, server } of clients.values()) {
    await client.close();
    await server.close();
  }

  // Direct catalog execution (what native host tools use).
  const catalog = await createPaseoToolCatalog(deps({}));
  const direct: unknown[] = [];
  for (const [tool, args] of [
    ["no_such_tool", {}],
    ["list_models", {}],
    ["list_providers", {}],
    ["list_workspaces", { includeBackground: "yes" }],
  ] as const) {
    try {
      direct.push({ tool, args, result: await catalog.executeTool(tool, args) });
    } catch (error) {
      direct.push({ tool, args, threw: errorSummary(error) });
    }
  }
  return { transcripts, direct, speakCalls };
}

// --- structured content text synthesis -------------------------------------------------

function synthesisVectors() {
  const cases: Array<{
    name: string;
    input: Parameters<typeof addModelVisibleStructuredContent>[0];
  }> = [
    {
      name: "object_with_id_arrays",
      input: { content: [], structuredContent: { agents: [{ id: "a" }, { id: "b" }], count: 2 } },
    },
    {
      name: "array_missing_ids",
      input: { content: [], structuredContent: { items: [{ id: "a" }, { name: "x" }] } },
    },
    {
      name: "array_non_string_id",
      input: { content: [], structuredContent: { items: [{ id: 1 }, { id: 2 }] } },
    },
    {
      name: "array_empty_id_string",
      input: { content: [], structuredContent: { items: [{ id: "" }] } },
    },
    { name: "empty_array", input: { content: [], structuredContent: { items: [] } } },
    { name: "scalar_arrays", input: { content: [], structuredContent: { tags: ["a", "b"] } } },
    {
      name: "two_arrays",
      input: {
        content: [],
        structuredContent: { a: [{ id: "x" }], b: [{ id: "y" }, { id: "z" }] },
      },
    },
    { name: "no_arrays", input: { content: [], structuredContent: { ok: true } } },
    {
      name: "nested_array_ignored",
      input: { content: [], structuredContent: { outer: { inner: [{ id: "q" }] } } },
    },
    { name: "top_level_array", input: { content: [], structuredContent: [{ id: "a" }] } },
    { name: "null_structured", input: { content: [], structuredContent: null } },
    { name: "string_structured", input: { content: [], structuredContent: "hello" } },
    { name: "number_structured", input: { content: [], structuredContent: 42 } },
    {
      name: "existing_content_untouched",
      input: {
        content: [{ type: "text", text: "kept" }],
        structuredContent: { items: [{ id: "a" }] },
      },
    },
    { name: "no_structured_content", input: { content: [] } },
    {
      name: "is_error_preserved",
      input: { content: [], structuredContent: { items: [{ id: "a" }] }, isError: true },
    },
    {
      name: "unicode_and_escapes",
      input: {
        content: [],
        structuredContent: { items: [{ id: "é😀" }], note: 'line\nbreak "q"  ' },
      },
    },
    {
      name: "key_order_preserved",
      input: { content: [], structuredContent: { z: 1, items: [{ id: "a" }], a: 2 } },
    },
  ];
  return cases.map((c) =>
    Object.assign({}, c, { output: addModelVisibleStructuredContent(c.input) }),
  );
}

const dir = areaDir(resolveOutRoot(), "tool-catalog");
const lists = await captureLists();
const callResult = await captureCalls();
writeJson(dir, "tools-list.json", {
  note: "Per catalog configuration: catalogTools (title, description, input/output JSON schema as serializePaseoToolInputParameters / toJsonSchemaCompat) and mcpToolsList (the MCP tools/list response from a real McpServer, which carries only inputSchema).",
  configs: CONFIGS.map((c) => ({ name: c.name, description: c.description })),
  lists,
});
writeJson(dir, "tools-call-transcripts.json", {
  note: "callTool responses through McpServer/Client in-memory transport against hand-built stubs (agents: live idle, live running with a pending permission, one stored; workspaces: 4 incl. background and archived; clock fixed at 2026-02-01T12:00:00.000Z). sideEffects are the recorded stub invocations.",
  stubs: { liveAgentIds: liveAgents.map((a) => a.id), storedAgentId: STORED_ID, timeline },
  transcripts: callResult.transcripts,
  directCatalogExecution: callResult.direct,
  speakCalls: callResult.speakCalls,
});
writeJson(dir, "structured-content-text.json", {
  note: "addModelVisibleStructuredContent vectors: per array key `<k>_count=N`, `<k>_ids=a,b` when every item has a non-empty string id, blank line, JSON.stringify(x,null,2).",
  cases: synthesisVectors(),
});
