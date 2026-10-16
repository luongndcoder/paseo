/* eslint-disable complexity, max-depth -- replay drivers are linear state machines over a recorded transcript */
import pino from "pino";

import type { AgentStreamEvent } from "../../src/server/agent/agent-sdk-types.js";
import {
  PiRpcAgentClient,
  type PiRpcAgentSession,
} from "../../src/server/agent/providers/pi/agent.js";
import { FakePi } from "../../src/server/agent/providers/pi/test-utils/fake-pi.js";
import type { PiRuntimeEvent } from "../../src/server/agent/providers/pi/rpc-types.js";
import type { PiUsagePollScheduler } from "../../src/server/agent/providers/pi/usage-poller.js";
import { readJsonl, settle } from "../p4-fixture-utils.js";
import type { DriveContext, DriveResult } from "./types.js";

type Json = Record<string, unknown>;

class NoopScheduler implements PiUsagePollScheduler {
  schedulePoll(): () => void {
    return () => undefined;
  }
}

export async function drivePi(ctx: DriveContext): Promise<DriveResult> {
  const rows = readJsonl(ctx.file) as Json[];
  const notes: string[] = [];
  const meta = (rows.find((row) => "argv" in row) ?? {}) as { argv?: string[] };
  const protocolRows = rows.filter((row) => row.line !== undefined) as unknown as Array<{
    dir: string;
    line: Json;
  }>;
  const isOmp = ctx.fixture.startsWith("omp-");
  if (isOmp) {
    return {
      status: "failed",
      reason: "OMP is host-only in P4 (Q8); no native mapper to capture",
      events: [],
      notes,
    };
  }

  const pi = new FakePi();
  const getState = protocolRows.find(
    (row) => row.dir === "out" && row.line.type === "response" && row.line.command === "get_state",
  );
  const recordedState = (getState?.line.data ?? null) as Json | null;
  pi.queueSessionSetup((session) => {
    if (recordedState) {
      session.state = {
        ...session.state,
        model: (recordedState.model as never) ?? null,
        thinkingLevel: (recordedState.thinkingLevel as never) ?? "medium",
        sessionId: String(recordedState.sessionId ?? "pi-session-1"),
      };
    }
  });
  const client = new PiRpcAgentClient({
    logger: pino({ level: "silent" }),
    runtime: pi,
    usagePollScheduler: new NoopScheduler(),
  });
  const session = (await client.createSession({
    provider: "pi",
    cwd: "/tmp/paseo-pi-fixture",
  })) as PiRpcAgentSession;
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  const fake = pi.latestSession();
  notes.push(`argv: ${JSON.stringify(meta.argv ?? [])}`);

  let partial = false;
  for (const row of protocolRows) {
    const line = row.line;
    if (row.dir === "in") {
      switch (line.type) {
        case "prompt":
          await session.startTurn(String(line.message));
          await settle();
          notes.push(`startTurn(${JSON.stringify(String(line.message).slice(0, 60))})`);
          break;
        case "abort":
          await session.interrupt();
          await settle();
          notes.push("interrupt()");
          break;
        case "extension_ui_response": {
          const pending = session.getPendingPermissions();
          const target = pending.find((p) => p.id === line.id) ?? pending[0];
          if (target) {
            const deny = line.cancelled === true || line.confirmed === false;
            await session.respondToPermission(
              target.id,
              deny ? { behavior: "deny", message: "denied in fixture" } : { behavior: "allow" },
            );
            await settle();
            notes.push(`respondToPermission(${target.id}, ${deny ? "deny" : "allow"})`);
          } else {
            partial = true;
            notes.push(`extension_ui_response ${String(line.id)} had no pending permission`);
          }
          break;
        }
        case "get_state":
        case "get_messages":
        case "get_available_models":
        case "get_commands":
        case "get_session_stats":
          break;
        default:
          partial = true;
          notes.push(`ignored in-line type=${String(line.type)}`);
      }
      continue;
    }
    if (line.type === "response") continue;
    fake.emit(line as unknown as PiRuntimeEvent);
    await settle(2);
  }
  await settle(4);
  await session.close();
  if (events.length === 0) {
    return {
      status: "failed",
      reason: "no turn in this fixture (catalog/list-only)",
      notes,
      events,
    };
  }
  return {
    status: partial ? "partial" : "ok",
    driver:
      "PiRpcAgentSession over FakePi: out lines replayed as runtime events; prompt/abort/extension_ui_response in-lines trigger startTurn/interrupt/respondToPermission",
    notes,
    events,
  };
}
