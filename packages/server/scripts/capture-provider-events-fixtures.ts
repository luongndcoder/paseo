/**
 * P4 WP0: provider raw -> AgentStreamEvent[] goldens.
 *
 * Feeds the recorded provider transcripts in crates/paseo-{pi,acp,opencode,codex,claude}/fixtures
 * through the real TS adapters (fake clock and counter uuids) and records the
 * AgentStreamEvent[] they emit. The driver per provider is the narrowest seam
 * that keeps the adapter's own state machine in the loop:
 *
 *   pi        PiRpcAgentSession over FakePi (runtime events replayed)
 *   acp       ACPAgentSession.translateSessionUpdate (session/update notifications)
 *   opencode  translateOpenCodeEvent (SSE events with shared translation state)
 *   codex     CodexAppServerAgentSession over a replay app-server child process
 *   claude    ClaudeAgentSession pump over a replay Query iterator
 *
 *   tsx scripts/capture-provider-events-fixtures.ts --out <fixtures/p4> [--only pi,acp]
 */
import path from "node:path";
import pino from "pino";

import type { AgentStreamEvent } from "../src/server/agent/agent-sdk-types.js";
import {
  areaDir,
  errorSummary,
  installDeterminism,
  readJsonl,
  resolveCratesDir,
  resolveOutRoot,
  settle,
  writeJson,
} from "./p4-fixture-utils.js";
import { driveAcp } from "./provider-events/acp.js";
import { driveClaude } from "./provider-events/claude.js";
import { driveCodex } from "./provider-events/codex.js";
import { driveOpencode } from "./provider-events/opencode.js";
import { drivePi } from "./provider-events/pi.js";
import type { DriveContext, DriveResult } from "./provider-events/types.js";

void pino;
void settle;
void readJsonl;

interface ProviderPlan {
  crate: string;
  provider: string;
  drive: (ctx: DriveContext) => Promise<DriveResult>;
}

const PLANS: ProviderPlan[] = [
  { crate: "paseo-pi", provider: "pi", drive: drivePi },
  { crate: "paseo-acp", provider: "acp", drive: driveAcp },
  { crate: "paseo-opencode", provider: "opencode", drive: driveOpencode },
  { crate: "paseo-codex", provider: "codex", drive: driveCodex },
  { crate: "paseo-claude", provider: "claude", drive: driveClaude },
];

const onlyArg = process.argv.indexOf("--only");
const only = onlyArg >= 0 ? new Set(process.argv[onlyArg + 1].split(",")) : null;

const root = resolveOutRoot();
const crates = resolveCratesDir(root);
const outDir = areaDir(root, "provider-events");
const determinism = installDeterminism();

import { readdirSync } from "node:fs";

const manifest: unknown[] = [];
for (const plan of PLANS) {
  if (only && !only.has(plan.provider)) continue;
  const fixturesDir = path.join(crates, plan.crate, "fixtures");
  const files = readdirSync(fixturesDir)
    .filter((name) => name.endsWith(".jsonl"))
    .sort();
  for (const file of files) {
    determinism.resetUuids();
    const fixture = file.replace(/\.jsonl$/, "");
    const ctx: DriveContext = { file: path.join(fixturesDir, file), fixture };
    let result: DriveResult;
    try {
      result = await Promise.race([
        plan.drive(ctx),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("driver timed out after 60s")), 60_000),
        ),
      ]);
    } catch (error) {
      result = { status: "failed", reason: errorSummary(error).message, events: [], notes: [] };
    }
    const events: AgentStreamEvent[] = result.events;
    const record = {
      provider: plan.provider,
      fixture,
      status: result.status,
      ...(result.reason ? { reason: result.reason } : {}),
      driver: result.driver ?? null,
      notes: result.notes,
      eventCount: events.length,
      ...(result.segments ? { segments: result.segments } : {}),
      events,
    };
    writeJson(outDir, `${plan.provider}/${fixture}.json`, record);
    manifest.push({
      provider: plan.provider,
      fixture,
      status: result.status,
      ...(result.reason ? { reason: result.reason } : {}),
      eventCount: events.length,
    });
  }
}
writeJson(outDir, "manifest.json", {
  note: "One entry per crate fixture. status ok = replayed through the TS adapter; partial = replayed with documented gaps (see notes in the per-fixture file); failed = not replayable (reason given).",
  fixtures: manifest,
});
determinism.restore();
process.exit(0);
