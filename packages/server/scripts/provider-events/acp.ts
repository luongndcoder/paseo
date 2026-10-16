/* eslint-disable complexity, max-depth -- replay drivers are linear state machines over a recorded transcript */
import path from "node:path";
import pino from "pino";

import type { AgentStreamEvent } from "../../src/server/agent/agent-sdk-types.js";
import { ACPAgentSession } from "../../src/server/agent/providers/acp-agent.js";
import { readJsonl } from "../p4-fixture-utils.js";
import type { DriveContext, DriveResult } from "./types.js";

type Json = Record<string, unknown>;

interface Internals {
  activeForegroundTurnId: string | null;
  translateSessionUpdate(update: unknown): AgentStreamEvent[];
}

export async function driveAcp(ctx: DriveContext): Promise<DriveResult> {
  const rows = readJsonl(ctx.file) as Json[];
  const meta = (rows.find((row) => "argv" in row) ?? {}) as { argv?: string[] };
  const provider = path.basename(meta.argv?.[0] ?? "acp");
  const notes: string[] = [`provider id derived from argv[0]: ${provider}`];
  const session = new ACPAgentSession(
    { provider, cwd: "/tmp/paseo-acp-fixture" },
    {
      provider,
      logger: pino({ level: "silent" }),
      defaultCommand: (meta.argv?.length ? meta.argv : ["acp"]) as [string, ...string[]],
      defaultModes: [],
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: true,
        supportsDynamicModes: true,
        supportsMcpServers: true,
        supportsReasoningStream: true,
        supportsToolInvocations: true,
      },
    },
  );
  const internals = session as unknown as Internals;
  const events: AgentStreamEvent[] = [];
  let turn = 0;
  let promptId: unknown = null;
  let updates = 0;
  let skipped = 0;
  for (const row of rows as Array<{ dir?: string; line?: Json }>) {
    const line = row.line;
    if (!line) continue;
    if (row.dir === "in" && line.method === "session/prompt") {
      turn += 1;
      promptId = line.id;
      internals.activeForegroundTurnId = `turn-${turn}`;
      notes.push(`session/prompt -> activeForegroundTurnId=turn-${turn}`);
      continue;
    }
    if (row.dir === "out" && line.method === "session/update") {
      const update = (line.params as Json).update;
      events.push(...internals.translateSessionUpdate(update));
      updates += 1;
      continue;
    }
    if (
      row.dir === "out" &&
      line.id === promptId &&
      promptId !== null &&
      line.method === undefined
    ) {
      internals.activeForegroundTurnId = null;
      notes.push(
        `prompt response stopReason=${JSON.stringify((line.result as Json | undefined)?.stopReason ?? null)} -> turn cleared`,
      );
      promptId = null;
      continue;
    }
    if (row.dir === "out" && line.method === "session/request_permission") skipped += 1;
  }
  notes.push(`${updates} session/update notifications translated`);
  if (skipped > 0)
    notes.push(
      `${skipped} session/request_permission requests not driven (permission mapping lives in the controller)`,
    );
  notes.push(
    "turn_started/turn_completed/permission events are produced by the prompt/permission controller, not by translateSessionUpdate",
  );
  if (updates === 0) {
    return {
      status: "failed",
      reason: "no session/update notifications (catalog/list-only fixture)",
      events,
      notes,
    };
  }
  return {
    status: "partial",
    driver: "ACPAgentSession.translateSessionUpdate over recorded session/update notifications",
    notes,
    events,
  };
}
