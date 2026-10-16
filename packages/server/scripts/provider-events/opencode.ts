import type { AgentStreamEvent } from "../../src/server/agent/agent-sdk-types.js";
import {
  translateOpenCodeEvent,
  type OpenCodeEventTranslationState,
} from "../../src/server/agent/providers/opencode-agent.js";
import { readJsonl } from "../p4-fixture-utils.js";
import type { DriveContext, DriveResult } from "./types.js";

type Json = Record<string, unknown>;

export async function driveOpencode(ctx: DriveContext): Promise<DriveResult> {
  const rows = readJsonl(ctx.file) as Json[];
  const notes: string[] = [];
  const sessionCreated = rows.find(
    (row) =>
      row.dir === "sse" &&
      ((row.event as Json).payload as Json | undefined)?.type === "session.created",
  );
  const createdInfo = sessionCreated
    ? ((((sessionCreated.event as Json).payload as Json).properties as Json).info as Json)
    : null;
  const sessionResponse = rows.find(
    (row) =>
      row.dir === "res" &&
      typeof (row.body as Json | null)?.id === "string" &&
      String((row.body as Json).id).startsWith("ses_"),
  );
  const sessionId = String(
    createdInfo?.id ?? (sessionResponse?.body as Json | undefined)?.id ?? "",
  );
  if (!sessionId) {
    return { status: "failed", reason: "no session id found in fixture", events: [], notes };
  }
  notes.push(`sessionId=${sessionId}`);
  const state: OpenCodeEventTranslationState = {
    sessionId,
    cwd: "/tmp/paseo-opencode-fixture",
    messageRoles: new Map(),
    accumulatedUsage: {},
    materializedParts: new Map(),
    emittedStructuredMessageIds: new Set(),
    compactionSummaryMessageIds: new Set(),
    emittedCompactionPartIds: new Set(),
    partTypes: new Map(),
  };
  const events: AgentStreamEvent[] = [];
  let sse = 0;
  let ignored = 0;
  for (const row of rows) {
    if (row.dir !== "sse") continue;
    const payload = (row.event as Json).payload as Json | undefined;
    if (!payload || typeof payload.type !== "string") continue;
    sse += 1;
    if (payload.type === "sync" || payload.type === "server.heartbeat") {
      ignored += 1;
      continue;
    }
    events.push(...translateOpenCodeEvent(payload as never, state));
  }
  notes.push(`${sse} SSE events seen, ${ignored} sync/heartbeat events skipped`);
  notes.push(
    "turn_started/turn_completed and prompt submission events come from the session controller, not translateOpenCodeEvent; user_message pending state is not primed",
  );
  return {
    status: "partial",
    driver: "translateOpenCodeEvent over recorded SSE payloads with one shared translation state",
    notes,
    events,
  };
}
