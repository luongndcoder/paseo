/* eslint-disable complexity, max-depth -- replay drivers are linear state machines over a recorded transcript */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import pino from "pino";

import type { AgentStreamEvent } from "../../src/server/agent/agent-sdk-types.js";
import { CodexAppServerAgentSession } from "../../src/server/agent/providers/codex-app-server-agent.js";
import { createCodexAppServerChildProcess } from "../../src/server/agent/providers/codex/test-utils/fake-app-server.js";
import { readJsonl, settle } from "../p4-fixture-utils.js";
import type { DriveContext, DriveResult } from "./types.js";

type Json = Record<string, unknown>;
interface Row {
  dir?: string;
  line?: Json;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildReply(id: unknown, recorded: Json | undefined): Json {
  if (!recorded) return { id, result: {} };
  if ("error" in recorded) return { id, error: recorded.error };
  return { id, result: recorded.result };
}

function splitSegments(rows: Json[]): Row[][] {
  const segments: Row[][] = [];
  for (const row of rows) {
    if ("argv" in row) segments.push([]);
    else (segments.at(-1) ?? (segments.push([]), segments.at(-1)!)).push(row as Row);
  }
  return segments;
}

async function replaySegment(
  rows: Row[],
  label: string,
  notes: string[],
): Promise<{ events: AgentStreamEvent[]; partial: boolean } | null> {
  const turnStarts = rows.filter((row) => row.dir === "in" && row.line?.method === "turn/start");
  if (turnStarts.length === 0) {
    notes.push(`${label}: no turn/start (catalog/list-only process); nothing to map`);
    return null;
  }
  let partial = false;

  // Recorded responses per method, in order, matched to their request ids.
  const responseQueues = new Map<string, Json[]>();
  const requestIdToMethod = new Map<unknown, string>();
  for (const row of rows) {
    if (
      row.dir === "in" &&
      row.line &&
      typeof row.line.method === "string" &&
      row.line.id !== undefined
    ) {
      requestIdToMethod.set(row.line.id, row.line.method);
    }
  }
  for (const row of rows) {
    if (
      row.dir === "out" &&
      row.line &&
      row.line.method === undefined &&
      row.line.id !== undefined
    ) {
      const method = requestIdToMethod.get(row.line.id);
      if (method) {
        const queue = responseQueues.get(method) ?? [];
        queue.push(row.line);
        responseQueues.set(method, queue);
      }
    }
  }

  const child = createCodexAppServerChildProcess();
  const seen = new Map<string, number>();
  const adapterResponses: Json[] = [];
  let buffer = "";
  child.stdin.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index < 0) break;
      const text = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!text) continue;
      const message = JSON.parse(text) as Json;
      if (typeof message.method === "string" && message.id !== undefined) {
        seen.set(message.method, (seen.get(message.method) ?? 0) + 1);
        const queue = responseQueues.get(message.method) ?? [];
        const recorded = queue.length > 1 ? queue.shift() : queue[0];
        const reply = buildReply(message.id, recorded);
        // Reply asynchronously: PassThrough delivers `data` synchronously inside the adapter's write().
        setImmediate(() => child.stdout.write(`${JSON.stringify(reply)}\n`));
      } else if (message.id !== undefined) {
        adapterResponses.push(message);
      } else if (typeof message.method === "string") {
        seen.set(message.method, (seen.get(message.method) ?? 0) + 1);
      }
    }
  });

  const resumeRow = rows.find((row) => row.dir === "in" && row.line?.method === "thread/resume");
  const resumeThreadId = resumeRow ? String((resumeRow.line!.params as Json).threadId) : null;
  const session = new CodexAppServerAgentSession(
    { provider: "codex", cwd: "/tmp/paseo-codex-fixture", modeId: "auto", model: "gpt-5.4" },
    resumeThreadId ? { sessionId: resumeThreadId } : null,
    pino({ level: "silent" }),
    async () => child as unknown as ChildProcessWithoutNullStreams,
    {},
  );
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));

  const promptText = (row: Row): string => {
    const input = ((row.line!.params as Json).input ?? []) as Json[];
    return input.map((block) => (typeof block.text === "string" ? block.text : "")).join("");
  };
  const expected = new Map<string, number>();
  const waitForRequests = async (): Promise<void> => {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      let ready = true;
      for (const [method, count] of expected) if ((seen.get(method) ?? 0) < count) ready = false;
      if (ready) return;
      await sleep(5);
    }
    partial = true;
    notes.push(
      `${label}: timed out waiting for adapter requests ${JSON.stringify([...expected].filter(([m, c]) => (seen.get(m) ?? 0) < c))}`,
    );
    for (const [method, count] of expected) expected.set(method, seen.get(method) ?? count);
  };

  let turnsStarted = 0;
  const pending: Promise<unknown>[] = [];
  const startTurn = (row: Row): void => {
    turnsStarted += 1;
    const text = promptText(row);
    notes.push(`${label}: startTurn(${JSON.stringify(text.slice(0, 60))})`);
    pending.push(
      session
        .startTurn(text)
        .catch((error: unknown) => notes.push(`${label}: startTurn rejected: ${String(error)}`)),
    );
  };

  // The first turn starts the adapter, which issues the setup requests.
  startTurn(turnStarts[0]);

  const debug = (message: string): void => {
    if (process.env.P4_DEBUG) console.error(`[codex ${label}] ${message}`);
  };
  for (const row of rows) {
    const line = row.line;
    if (!line) continue;
    debug(
      `${row.dir} ${String(line.method ?? "resp:" + String(line.id))} seen=${JSON.stringify([...seen])}`,
    );
    if (row.dir === "in") {
      if (typeof line.method === "string" && line.id !== undefined) {
        expected.set(line.method, (expected.get(line.method) ?? 0) + 1);
        if (
          line.method === "turn/start" &&
          turnsStarted > 0 &&
          row !== turnStarts[0] &&
          expected.get("turn/start")! > turnsStarted
        ) {
          startTurn(row);
        } else if (line.method === "turn/interrupt") {
          pending.push(session.interrupt().catch(() => undefined));
          notes.push(`${label}: interrupt()`);
        }
      } else if (typeof line.method === "string") {
        expected.set(line.method, (expected.get(line.method) ?? 0) + 1);
      } else if (line.id !== undefined && line.result !== undefined) {
        await waitForRequests();
        for (
          let attempt = 0;
          attempt < 200 && session.getPendingPermissions().length === 0;
          attempt += 1
        )
          await sleep(5);
        const target = session.getPendingPermissions()[0];
        if (target) {
          const decision = String(
            (line.result as Json).decision ?? (line.result as Json).action ?? "accept",
          );
          const deny = /decline|cancel|deny|reject/i.test(decision);
          await session.respondToPermission(
            target.id,
            deny ? { behavior: "deny", message: "denied in fixture" } : { behavior: "allow" },
          );
          notes.push(
            `${label}: respondToPermission(${target.id}, ${deny ? "deny" : "allow"}) for decision=${decision}`,
          );
          await settle(4);
        } else {
          partial = true;
          notes.push(
            `${label}: recorded client response id=${String(line.id)} but no pending permission`,
          );
        }
      }
      continue;
    }
    // out line
    if (line.method === undefined && line.id !== undefined) continue; // responses are served on demand
    await waitForRequests();
    child.stdout.write(`${JSON.stringify(line)}\n`);
    await settle(3);
  }
  await settle(10);
  await Promise.race([Promise.all(pending), sleep(500)]);
  await session.close().catch(() => undefined);
  return { events, partial };
}

export async function driveCodex(ctx: DriveContext): Promise<DriveResult> {
  const rows = readJsonl(ctx.file) as Json[];
  const notes: string[] = [];
  const segments = splitSegments(rows);
  const results: Array<{ label: string; events: AgentStreamEvent[] }> = [];
  let partial = false;
  for (const [index, segment] of segments.entries()) {
    const label = `process-${index + 1}`;
    const result = await replaySegment(segment, label, notes);
    if (!result) continue;
    partial ||= result.partial;
    results.push({ label, events: result.events });
  }
  if (results.length === 0) {
    return {
      status: "failed",
      reason: "no process with a turn/start in this fixture",
      events: [],
      notes,
    };
  }
  return {
    status: partial ? "partial" : "ok",
    driver:
      "CodexAppServerAgentSession over a replay app-server child process: requests answered from recorded responses by method, notifications replayed in order gated on the adapter's own requests",
    notes,
    events: results.flatMap((r) => r.events),
    ...(results.length > 1 ? { segments: results } : {}),
  };
}
