import type { AgentStreamEvent } from "../../src/server/agent/agent-sdk-types.js";

export interface DriveContext {
  /** Absolute path of the crate fixture (.jsonl). */
  file: string;
  /** File name without extension. */
  fixture: string;
}

export interface DriveResult {
  status: "ok" | "partial" | "failed";
  reason?: string;
  driver?: string;
  /** Replay decisions and ignored input worth knowing when reading the golden. */
  notes: string[];
  events: AgentStreamEvent[];
  /** Present when the fixture holds several provider processes; `events` is their concatenation. */
  segments?: Array<{ label: string; events: AgentStreamEvent[] }>;
}
