/* eslint-disable complexity, max-depth -- replay drivers are linear state machines over a recorded transcript */
import pino from "pino";

import type { AgentStreamEvent } from "../../src/server/agent/agent-sdk-types.js";
import { ClaudeAgentClient } from "../../src/server/agent/providers/claude/agent.js";
import { readJsonl, settle } from "../p4-fixture-utils.js";
import type { DriveContext, DriveResult } from "./types.js";

type Json = Record<string, unknown>;
interface Row {
  dir?: string;
  line?: Json;
}

const SDK_MESSAGE_TYPES = new Set([
  "system",
  "assistant",
  "user",
  "stream_event",
  "result",
  "rate_limit_event",
  "command_lifecycle",
  "tool_progress",
  "auth_status",
]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A Query whose iterator yields whatever the driver pushes. */
function createReplayQuery() {
  const queue: unknown[] = [];
  const waiters: Array<(value: IteratorResult<unknown, void>) => void> = [];
  let done = false;
  const push = (message: unknown) => {
    const waiter = waiters.shift();
    if (waiter) waiter({ value: message, done: false });
    else queue.push(message);
  };
  const end = () => {
    done = true;
    for (const waiter of waiters.splice(0)) waiter({ value: undefined, done: true });
  };
  const query = {
    close: () => end(),
    return: async () => {
      end();
      return { value: undefined, done: true as const };
    },
    interrupt: async () => undefined,
    applyFlagSettings: async () => undefined,
    setModel: async () => undefined,
    setPermissionMode: async () => undefined,
    getContextUsage: async () => undefined,
    supportedCommands: async () => [],
    initializationResult: async () => ({ commands: [], models: [], account: {} }),
    [Symbol.asyncIterator]() {
      return {
        next: (): Promise<IteratorResult<unknown, void>> => {
          if (queue.length > 0) return Promise.resolve({ value: queue.shift(), done: false });
          if (done) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => waiters.push(resolve));
        },
      };
    },
  };
  const isIdle = (): boolean => waiters.length > 0 || done;
  const idle = async (): Promise<void> => {
    // The pump only asks for the next message after fully processing the previous one.
    for (let attempt = 0; attempt < 200 && !isIdle(); attempt += 1) await sleep(5);
  };
  return { query, push, end, idle };
}

export async function driveClaude(ctx: DriveContext): Promise<DriveResult> {
  const rows = (readJsonl(ctx.file) as Json[]).filter((row) => row.line !== undefined) as Row[];
  const notes: string[] = [];
  let partial = false;
  const replay = createReplayQuery();
  const launches: Array<{ options: Record<string, unknown> }> = [];
  const queryFactory = (input: { options: Record<string, unknown> }) => {
    launches.push(input);
    return replay.query;
  };
  const client = new ClaudeAgentClient({
    logger: pino({ level: "silent" }),
    queryFactory: queryFactory as never,
    resolveBinary: async () => "/test/claude/bin",
  });
  const session = await client.createSession({
    provider: "claude",
    cwd: "/tmp/paseo-claude-fixture",
    modeId: "default",
  });
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));

  const userText = (line: Json): string => {
    const content = ((line.message as Json | undefined)?.content ?? []) as Json[];
    return Array.isArray(content)
      ? content.map((block) => (typeof block.text === "string" ? block.text : "")).join("")
      : String(content);
  };

  const pendingToolRequests = new Map<string, { toolName: string }>();
  const pending: Promise<unknown>[] = [];
  let started = false;
  for (const row of rows) {
    const line = row.line!;
    if (row.dir === "in") {
      if (line.type === "user") {
        if (!started) {
          started = true;
          await session.startTurn(userText(line));
          notes.push(`startTurn(${JSON.stringify(userText(line).slice(0, 60))})`);
          await replay.idle();
          await sleep(20);
          await settle(4);
        } else {
          try {
            await session.startTurn(userText(line));
            notes.push(`startTurn#2(${JSON.stringify(userText(line).slice(0, 60))})`);
          } catch (error) {
            partial = true;
            notes.push(`second user message not started: ${String(error)}`);
          }
          await settle(4);
        }
      } else if (line.type === "control_request") {
        const subtype = (line.request as Json).subtype;
        if (subtype === "interrupt") {
          await session.interrupt();
          notes.push("interrupt()");
          await settle(4);
        } else if (subtype !== "initialize") {
          partial = true;
          notes.push(`ignored in control_request subtype=${String(subtype)}`);
        }
      } else if (line.type === "control_response") {
        const response = (line.response as Json).response as Json | undefined;
        const requestId = String((line.response as Json).request_id);
        if (response?.behavior && pendingToolRequests.has(requestId)) {
          for (
            let attempt = 0;
            attempt < 100 && session.getPendingPermissions().length === 0;
            attempt += 1
          )
            await sleep(5);
          const target = session.getPendingPermissions()[0];
          if (target) {
            const deny = response.behavior === "deny";
            await session.respondToPermission(
              target.id,
              deny
                ? { behavior: "deny", message: String(response.message ?? "denied in fixture") }
                : { behavior: "allow" },
            );
            notes.push(`respondToPermission(${target.id}, ${response.behavior})`);
            await settle(4);
          } else {
            partial = true;
            notes.push(`control_response ${requestId} had no pending permission`);
          }
        } else if (!pendingToolRequests.has(requestId)) {
          partial = true;
          notes.push(`ignored in control_response ${requestId} (hook/mcp callback)`);
        }
      }
      continue;
    }
    // out
    if (line.type === "control_request") {
      const request = line.request as Json;
      if (request.subtype === "can_use_tool") {
        const canUseTool = launches[0]?.options.canUseTool as
          | ((name: string, input: unknown, options: Json) => Promise<unknown>)
          | undefined;
        if (canUseTool) {
          pendingToolRequests.set(String(line.request_id), { toolName: String(request.tool_name) });
          pending.push(
            canUseTool(String(request.tool_name), request.input, {
              signal: new AbortController().signal,
              toolUseID: String(request.tool_use_id),
            }).catch(() => undefined),
          );
          await settle(4);
        }
      } else {
        partial = true;
        notes.push(`out control_request subtype=${String(request.subtype)} not driven`);
      }
      continue;
    }
    if (typeof line.type === "string" && SDK_MESSAGE_TYPES.has(line.type)) {
      replay.push(line);
      await replay.idle();
      await sleep(2);
      await settle(3);
    }
  }
  await settle(8);
  await Promise.race([Promise.all(pending), sleep(300)]);
  await session.close().catch(() => undefined);
  replay.end();
  return {
    status: partial ? "partial" : "ok",
    driver:
      "ClaudeAgentSession pump over a replay Query iterator: out SDK messages yielded in order; user/interrupt/control_response in-lines drive startTurn/interrupt/respondToPermission; can_use_tool requests call the launch canUseTool callback",
    notes,
    events,
  };
}
