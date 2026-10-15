import { closeSync, createReadStream, existsSync, openSync, readFileSync, readSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import type {
  ProviderInput,
  ProviderLaunch,
  ProviderSessionSummary,
  ProviderTimelineItem,
} from "@getpaseo/plugin/server/provider";
import { toolItem } from "./timeline.js";
import type { Step } from "./wire.js";

type ListSessionsInput = Extract<ProviderInput, { type: "sessions" }>;

interface SqliteDatabase {
  prepare(sql: string): { all(...args: unknown[]): unknown[] };
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (
    dbPath: string,
    options: { open?: boolean; readOnly?: boolean },
  ) => SqliteDatabase;
}

interface SummaryRow {
  conversation_id?: string;
  parent_conversation_id?: string;
  nesting_depth?: number;
  title?: string;
  preview?: string;
  step_count?: number;
  last_modified_time?: string;
  workspace_uris?: string;
}

interface HistoryLine {
  display?: string;
  timestamp?: number;
  workspace?: string;
  conversationId?: string;
  type?: string;
}

interface TranscriptToolCall {
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
}

interface TranscriptStep {
  step_index?: number;
  type?: string;
  source?: string;
  status?: string;
  created_at?: string;
  content?: string;
  thinking?: string;
  tool_calls?: TranscriptToolCall[];
}

interface DiscoveredSession {
  conversationId: string;
  cwd: string;
  workspaceIsGeneric: boolean;
  title?: string;
  description?: string;
  updatedAtMs: number;
}

function getBuiltinSqlite(): SqliteModule | null {
  const mod = process.getBuiltinModule?.("node:sqlite") as Partial<SqliteModule> | undefined;
  return mod && typeof mod.DatabaseSync === "function" ? (mod as SqliteModule) : null;
}

export async function listAntigravitySessions(
  launch: ProviderLaunch,
  input: ListSessionsInput,
): Promise<ProviderSessionSummary[]> {
  const limit = Math.max(1, input.limit ?? 50);
  const query = input.query?.trim().toLowerCase() ?? "";
  const homeDir = resolveHomeDir(launch);
  const normalizedHome = normalizePath(homeDir);
  const targetCwd = input.cwd ? normalizePath(input.cwd) : undefined;
  const roots = resolveAntigravityRoots(launch, homeDir);

  const byId = new Map<string, DiscoveredSession>();
  const ignoredIds = new Set<string>();

  for (const root of roots) {
    loadFromSummaryDb(root, homeDir, normalizedHome, byId, ignoredIds);
    loadFromHistoryJsonl(root, homeDir, normalizedHome, byId, ignoredIds);
    await loadFromBrainDirectories(root, normalizedHome, byId, ignoredIds);
  }

  const results: Array<{ summary: ProviderSessionSummary; updatedAtMs: number }> = [];
  for (const entry of byId.values()) {
    const matched = buildMatchedSessionSummary(entry, {
      homeDir,
      targetCwd,
      roots,
      query,
    });
    if (matched) {
      results.push(matched);
    }
  }

  results.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  return results.slice(0, limit).map((entry) => entry.summary);
}

function buildMatchedSessionSummary(
  entry: DiscoveredSession,
  options: {
    homeDir: string;
    targetCwd?: string;
    roots: string[];
    query: string;
  },
): { summary: ProviderSessionSummary; updatedAtMs: number } | null {
  const resolvedCwd = resolveMatchingCwd(entry, options);
  if (!resolvedCwd) return null;

  const title = entry.title ? cleanTitle(entry.title) : undefined;
  const description = entry.description ? cleanTitle(entry.description) : undefined;

  if (options.query) {
    const haystack = [title ?? "", description ?? "", resolvedCwd, entry.conversationId]
      .join("\n")
      .toLowerCase();
    if (!haystack.includes(options.query)) return null;
  }

  const updatedAt = entry.updatedAtMs > 0 ? new Date(entry.updatedAtMs).toISOString() : undefined;

  return {
    updatedAtMs: entry.updatedAtMs,
    summary: {
      persistence: {
        version: 1,
        data: { conversationId: entry.conversationId },
      },
      cwd: resolvedCwd,
      title: title || description || `Antigravity ${entry.conversationId.slice(0, 8)}`,
      description: description && description !== title ? description : undefined,
      updatedAt,
    },
  };
}

function resolveMatchingCwd(
  entry: DiscoveredSession,
  options: { homeDir: string; targetCwd?: string; roots: string[] },
): string | null {
  const resolvedCwd = normalizePath(entry.cwd || options.homeDir);
  if (!options.targetCwd || resolvedCwd === options.targetCwd) {
    return resolvedCwd;
  }
  if (
    entry.workspaceIsGeneric &&
    transcriptMentionsCwd(options.roots, entry.conversationId, options.targetCwd)
  ) {
    return options.targetCwd;
  }
  return null;
}

export async function readTranscriptTimeline(
  launch: ProviderLaunch,
  conversationId: string,
): Promise<Array<{ item: ProviderTimelineItem; timestamp?: string }>> {
  const homeDir = resolveHomeDir(launch);
  const roots = resolveAntigravityRoots(launch, homeDir);
  const transcriptPath = findTranscriptPath(roots, conversationId);
  if (!transcriptPath) return [];

  const items: Array<{ item: ProviderTimelineItem; timestamp?: string }> = [];
  const stream = createReadStream(transcriptPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  try {
    let fallbackIndex = 0;
    for await (const line of rl) {
      if (!line.includes('"USER_INPUT"') && !line.includes('"PLANNER_RESPONSE"')) {
        continue;
      }
      const step = parseTranscriptStep(line);
      if (!step) continue;

      const stepIndex = typeof step.step_index === "number" ? step.step_index : fallbackIndex++;
      appendTranscriptStepItems(items, conversationId, step, stepIndex);
    }
  } catch {
    return items;
  } finally {
    rl.close();
  }

  return items;
}

function parseTranscriptStep(line: string): TranscriptStep | null {
  try {
    return JSON.parse(line) as TranscriptStep;
  } catch {
    return null;
  }
}

function appendTranscriptStepItems(
  items: Array<{ item: ProviderTimelineItem; timestamp?: string }>,
  conversationId: string,
  step: TranscriptStep,
  stepIndex: number,
): void {
  const timestamp = normalizeIsoTimestamp(step.created_at);

  if (step.type === "USER_INPUT" && typeof step.content === "string") {
    const text = extractUserRequestText(step.content);
    if (!text) return;
    items.push({
      timestamp,
      item: {
        type: "user_message",
        id: `replay:${conversationId}:user:${stepIndex}`,
        text,
      },
    });
    return;
  }

  if (step.type !== "PLANNER_RESPONSE") return;

  if (typeof step.thinking === "string" && step.thinking.trim()) {
    items.push({
      timestamp,
      item: {
        type: "reasoning",
        id: `replay:${conversationId}:reasoning:${stepIndex}`,
        text: step.thinking.trim(),
      },
    });
  }

  if (Array.isArray(step.tool_calls)) {
    appendReplayToolCalls(items, conversationId, step.tool_calls, stepIndex, timestamp);
  }

  if (typeof step.content === "string" && step.content.trim()) {
    const messageId = `replay:${conversationId}:assistant:${stepIndex}`;
    items.push({
      timestamp,
      item: {
        type: "assistant_message",
        id: messageId,
        messageId,
        text: step.content.trim(),
      },
    });
  }
}

function appendReplayToolCalls(
  items: Array<{ item: ProviderTimelineItem; timestamp?: string }>,
  conversationId: string,
  toolCalls: TranscriptToolCall[],
  stepIndex: number,
  timestamp?: string,
): void {
  for (let i = 0; i < toolCalls.length; i++) {
    const call = toolCalls[i];
    if (!call || typeof call.name !== "string" || !call.name) continue;
    const itemId = `replay:${conversationId}:tool:${stepIndex}:${i}`;
    const mapped = toolItem(
      {
        conversation_id: conversationId,
        step_index: stepIndex,
        state: "DONE",
        step_type: "tool",
        text_delta: "",
        tool_name: call.name,
        tool_info: {
          name: call.name,
          parameters: (call.args ?? {}) as NonNullable<Step["tool_info"]>["parameters"],
          output: "",
          error: null,
        },
        subagent_info: null,
        usage: null,
      },
      itemId,
    );
    items.push({ timestamp, item: mapped });
  }
}

function resolveHomeDir(launch: ProviderLaunch): string {
  const fromEnv = launch.env.HOME?.trim() || launch.env.USERPROFILE?.trim();
  return fromEnv || os.homedir();
}

function resolveAntigravityRoots(launch: ProviderLaunch, homeDir: string): string[] {
  const explicit = launch.env.ANTIGRAVITY_CLI_HOME?.trim();
  if (explicit) {
    return [explicit];
  }
  return [
    path.join(homeDir, ".gemini", "antigravity-cli"),
    path.join(homeDir, ".gemini", "antigravity"),
  ];
}

function upsertDiscoveredSession(
  byId: Map<string, DiscoveredSession>,
  candidate: DiscoveredSession,
  overwriteDescription = false,
): void {
  const existing = byId.get(candidate.conversationId);
  if (!existing) {
    byId.set(candidate.conversationId, candidate);
    return;
  }
  if (existing.workspaceIsGeneric && !candidate.workspaceIsGeneric) {
    existing.cwd = candidate.cwd;
    existing.workspaceIsGeneric = false;
  }
  if (!existing.title && candidate.title) {
    existing.title = candidate.title;
  }
  if (candidate.description && (overwriteDescription || !existing.description)) {
    existing.description = candidate.description;
  }
  if (candidate.updatedAtMs > existing.updatedAtMs) {
    existing.updatedAtMs = candidate.updatedAtMs;
  }
}

function loadFromSummaryDb(
  root: string,
  homeDir: string,
  normalizedHome: string,
  byId: Map<string, DiscoveredSession>,
  ignoredIds: Set<string>,
): void {
  const dbPath = path.join(root, "conversation_summaries.db");
  if (!existsSync(dbPath)) return;
  const sqlite = getBuiltinSqlite();
  if (!sqlite) return;

  let db: SqliteDatabase | null = null;
  try {
    db = new sqlite.DatabaseSync(dbPath, { open: true, readOnly: true });
    const rows = db
      .prepare(
        `SELECT conversation_id, parent_conversation_id, nesting_depth, title, preview, step_count, last_modified_time, workspace_uris
         FROM conversation_summaries
         ORDER BY last_modified_time DESC`,
      )
      .all() as SummaryRow[];

    for (const row of rows) {
      processSummaryRow(row, homeDir, normalizedHome, byId, ignoredIds);
    }
  } catch {
    // Ignore SQLite read errors and fall back to history.jsonl / brain directories.
  } finally {
    try {
      db?.close();
    } catch {
      // Ignore close errors.
    }
  }
}

function processSummaryRow(
  row: SummaryRow,
  homeDir: string,
  normalizedHome: string,
  byId: Map<string, DiscoveredSession>,
  ignoredIds: Set<string>,
): void {
  const conversationId = row.conversation_id?.trim();
  if (!conversationId) return;

  const isSubagent =
    Boolean(row.parent_conversation_id?.trim()) || Number(row.nesting_depth ?? 0) > 0;
  if (isSubagent) {
    ignoredIds.add(conversationId);
    return;
  }
  if (Number(row.step_count ?? 0) <= 0) return;

  const updatedAtMs = parseSummaryTimestamp(row.last_modified_time);
  const workspaces = parseWorkspaceUris(row.workspace_uris);
  const specificWorkspace = workspaces.find((ws) => normalizePath(ws) !== normalizedHome);
  const rawCwd = specificWorkspace ?? workspaces[0] ?? homeDir;
  const normalizedCwd = normalizePath(rawCwd);
  const workspaceIsGeneric = workspaces.length === 0 || normalizedCwd === normalizedHome;

  const cleanRowTitle = row.title?.trim();
  const cleanPreview = row.preview?.trim();
  const title = cleanRowTitle || cleanPreview || undefined;
  const description =
    cleanRowTitle && cleanPreview && cleanPreview !== cleanRowTitle ? cleanPreview : undefined;

  upsertDiscoveredSession(byId, {
    conversationId,
    cwd: normalizedCwd,
    workspaceIsGeneric,
    title,
    description,
    updatedAtMs,
  });
}

function loadFromHistoryJsonl(
  root: string,
  homeDir: string,
  normalizedHome: string,
  byId: Map<string, DiscoveredSession>,
  ignoredIds: Set<string>,
): void {
  const historyPath = path.join(root, "history.jsonl");
  if (!existsSync(historyPath)) return;

  let content: string;
  try {
    content = readFileSync(historyPath, "utf8");
  } catch {
    return;
  }

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    processHistoryLine(line, homeDir, normalizedHome, byId, ignoredIds);
  }
}

function processHistoryLine(
  line: string,
  homeDir: string,
  normalizedHome: string,
  byId: Map<string, DiscoveredSession>,
  ignoredIds: Set<string>,
): void {
  let parsed: HistoryLine;
  try {
    parsed = JSON.parse(line) as HistoryLine;
  } catch {
    return;
  }
  const conversationId = parsed.conversationId?.trim();
  if (!conversationId || ignoredIds.has(conversationId)) return;

  const rawCwd = parsed.workspace?.trim() || homeDir;
  const normalizedCwd = normalizePath(rawCwd);
  const workspaceIsGeneric = !parsed.workspace?.trim() || normalizedCwd === normalizedHome;
  const timestamp =
    typeof parsed.timestamp === "number" && Number.isFinite(parsed.timestamp)
      ? parsed.timestamp
      : 0;
  const display =
    parsed.type !== "slash_command" && parsed.display?.trim() ? parsed.display.trim() : undefined;

  upsertDiscoveredSession(
    byId,
    {
      conversationId,
      cwd: normalizedCwd,
      workspaceIsGeneric,
      title: display,
      description: display,
      updatedAtMs: timestamp,
    },
    true,
  );
}

async function loadFromBrainDirectories(
  root: string,
  normalizedHome: string,
  byId: Map<string, DiscoveredSession>,
  ignoredIds: Set<string>,
): Promise<void> {
  const brainDir = path.join(root, "brain");
  if (!existsSync(brainDir)) return;

  let entries: string[];
  try {
    entries = await readdir(brainDir);
  } catch {
    return;
  }

  for (const conversationId of entries) {
    if (byId.has(conversationId) || ignoredIds.has(conversationId)) continue;
    const transcriptPath = path.join(
      brainDir,
      conversationId,
      ".system_generated",
      "logs",
      "transcript.jsonl",
    );
    if (!existsSync(transcriptPath)) continue;

    try {
      const info = await stat(transcriptPath);
      const snippet = readHeadSnippet(transcriptPath, 16384);
      const firstUserText = extractFirstUserPromptFromSnippet(snippet);
      if (!firstUserText) continue;
      byId.set(conversationId, {
        conversationId,
        cwd: normalizedHome,
        workspaceIsGeneric: true,
        title: firstUserText,
        description: firstUserText,
        updatedAtMs: info.mtimeMs,
      });
    } catch {
      // Skip unreadable transcripts.
    }
  }
}

function findTranscriptPath(roots: string[], conversationId: string): string | null {
  for (const root of roots) {
    const fullPath = path.join(
      root,
      "brain",
      conversationId,
      ".system_generated",
      "logs",
      "transcript_full.jsonl",
    );
    if (existsSync(fullPath)) return fullPath;

    const compactPath = path.join(
      root,
      "brain",
      conversationId,
      ".system_generated",
      "logs",
      "transcript.jsonl",
    );
    if (existsSync(compactPath)) return compactPath;
  }
  return null;
}

function transcriptMentionsCwd(
  roots: string[],
  conversationId: string,
  targetCwd: string,
): boolean {
  for (const root of roots) {
    const compactPath = path.join(
      root,
      "brain",
      conversationId,
      ".system_generated",
      "logs",
      "transcript.jsonl",
    );
    if (!existsSync(compactPath)) continue;
    const snippet = readHeadSnippet(compactPath, 65536);
    if (snippet.includes(targetCwd)) return true;
  }
  return false;
}

function readHeadSnippet(filePath: string, maxBytes: number): string {
  let fd: number | null = null;
  try {
    fd = openSync(filePath, "r");
    const buffer = Buffer.allocUnsafe(maxBytes);
    const bytesRead = readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close error.
      }
    }
  }
}

function extractFirstUserPromptFromSnippet(snippet: string): string | undefined {
  for (const line of snippet.split("\n")) {
    if (!line.includes('"USER_INPUT"')) continue;
    const step = parseTranscriptStep(line);
    if (step?.type === "USER_INPUT" && typeof step.content === "string") {
      const extracted = extractUserRequestText(step.content);
      if (extracted) return extracted;
    }
  }
  return undefined;
}

export function extractUserRequestText(raw: string): string {
  const match = raw.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i);
  if (match && match[1]) {
    return match[1].trim();
  }
  const openIdx = raw.indexOf("<USER_REQUEST>");
  if (openIdx >= 0) {
    const afterOpen = raw.slice(openIdx + "<USER_REQUEST>".length);
    const metaIdx = afterOpen.indexOf("<ADDITIONAL_METADATA>");
    const sliced = metaIdx >= 0 ? afterOpen.slice(0, metaIdx) : afterOpen;
    return sliced.replace(/<\/USER_REQUEST>/gi, "").trim();
  }
  return raw.trim();
}

function parseWorkspaceUris(raw?: string): string[] {
  if (!raw || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const paths: string[] = [];
    for (const item of parsed) {
      if (typeof item !== "string" || !item.trim()) continue;
      paths.push(resolveWorkspaceUriItem(item));
    }
    return paths;
  } catch {
    return [];
  }
}

function resolveWorkspaceUriItem(item: string): string {
  if (!item.startsWith("file://")) {
    return item.trim();
  }
  try {
    return fileURLToPath(item);
  } catch {
    return decodeURIComponent(item.replace(/^file:\/\//, ""));
  }
}

function parseSummaryTimestamp(raw?: string): number {
  if (!raw || !raw.trim() || raw.startsWith("0001-01-01")) return 0;
  const normalized = raw.trim().replace(" ", "T");
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

function normalizeIsoTimestamp(raw?: string): string | undefined {
  if (!raw || !raw.trim()) return undefined;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : undefined;
}

function normalizePath(inputPath: string): string {
  return path.resolve(inputPath).replace(/\/+$/, "") || "/";
}

function cleanTitle(value: string): string {
  const firstLine =
    value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? value.trim();
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
}
