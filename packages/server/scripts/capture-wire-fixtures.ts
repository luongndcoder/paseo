/**
 * Captures real daemon WebSocket traffic into JSONL fixtures for the Rust port.
 *
 *   npx tsx scripts/capture-wire-fixtures.ts [outDir]
 *
 * Default outDir: ../../../paseo-rs/crates/paseo-protocol/fixtures (override with arg or
 * PASEO_FIXTURE_OUT). Starts an isolated in-process daemon (temp PASEO_HOME, ephemeral port).
 *
 * Line format: {"dir":"in"|"out","frame":<parsed JSON>}. "in" = daemon -> client,
 * "out" = client -> daemon. Binary frames (terminal stream, file transfer) are written as
 * {"dir":..., "binary_b64":"<base64>"} so the Rust side can test the binary codec too.
 */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import {
  DaemonClient as SharedDaemonClient,
  type WebSocketLike,
} from "@getpaseo/client/internal/daemon-client";
import { MockLoadTestAgentClient } from "../src/server/agent/providers/mock-load-test-agent.js";
import { createTestPaseoDaemon } from "../src/server/test-utils/paseo-daemon.js";

const FIXTURE_ROOT = "/tmp/paseo-fixture";
const MAX_SCENARIO_BYTES = 400_000;
const APP_VERSION = "0.1.70";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(
  process.argv[2] ??
    process.env.PASEO_FIXTURE_OUT ??
    path.join(scriptDir, "../../../../../../paseo-rs/crates/paseo-protocol/fixtures"),
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Recorder {
  readonly lines: string[] = [];
  private bytes = 0;
  truncated = false;
  constructor(private readonly replacements: Array<[string, string]>) {}

  private scrub(text: string): string {
    let result = text;
    for (const [from, to] of this.replacements) result = result.split(from).join(to);
    return result;
  }

  push(dir: "in" | "out", data: unknown, isBinary: boolean): void {
    if (this.bytes > MAX_SCENARIO_BYTES) {
      this.truncated = true;
      return;
    }
    let record: Record<string, unknown>;
    if (isBinary) {
      let buf: Buffer;
      if (Buffer.isBuffer(data)) buf = data;
      else if (data instanceof ArrayBuffer) buf = Buffer.from(data);
      else buf = Buffer.from(data as Uint8Array);
      record = { dir, binary_b64: buf.toString("base64") };
    } else {
      const text = typeof data === "string" ? data : Buffer.from(data as Buffer).toString("utf8");
      try {
        record = { dir, frame: JSON.parse(this.scrub(text)) };
      } catch {
        return;
      }
    }
    const line = JSON.stringify(record);
    this.bytes += line.length + 1;
    this.lines.push(line);
  }
}

function tappedClient(url: string, recorder: Recorder): SharedDaemonClient {
  return new SharedDaemonClient({
    url,
    appVersion: APP_VERSION,
    clientId: "clid_fixture_client",
    webSocketFactory: (u, options) => {
      const ws = new WebSocket(u, options?.protocols, { headers: options?.headers });
      ws.on("message", (data, isBinary) => recorder.push("in", data, isBinary));
      const originalSend = ws.send.bind(ws) as (data: unknown, ...rest: unknown[]) => void;
      (ws as unknown as { send: (data: unknown, ...rest: unknown[]) => void }).send = (
        data,
        ...rest
      ) => {
        recorder.push("out", data, typeof data !== "string");
        originalSend(data, ...rest);
      };
      return ws as unknown as WebSocketLike;
    },
  });
}

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const scratch = await mkdtemp(path.join(os.tmpdir(), "paseo-fixture-src-"));
  const realScratch = await realpath(scratch);
  const repo = path.join(scratch, "repo");
  await mkdir(repo, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: repo,
      stdio: "ignore",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "f@example.com",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "f@example.com",
      },
    });
  git("init", "-b", "main");
  await writeFile(path.join(repo, "README.md"), "# fixture\n");
  await mkdir(path.join(repo, "src"), { recursive: true });
  await writeFile(path.join(repo, "src", "index.ts"), "export {};\n");
  git("add", ".");
  git("commit", "-m", "init");
  await writeFile(path.join(repo, "dirty.txt"), "dirty\n");

  const daemon = await createTestPaseoDaemon({
    mcpEnabled: false,
    isDev: true,
    agentClients: { mock: new MockLoadTestAgentClient() },
  });
  const repoReal = path.join(realScratch, "repo");
  const dirs = [
    repoReal,
    repo,
    realScratch,
    scratch,
    daemon.paseoHome,
    path.dirname(daemon.paseoHome),
    daemon.staticDir,
  ];
  const sorted = [...new Set(dirs)].sort((a, b) => b.length - a.length);
  const replacements: Array<[string, string]> = sorted.map((d) => [
    d,
    d.startsWith(repo) || d.startsWith(repoReal) ? `${FIXTURE_ROOT}/repo` : FIXTURE_ROOT,
  ]);
  // Real home dirs of the temp tree may be addressed through /private/var or /var.
  const url = `ws://127.0.0.1:${daemon.port}/ws`;
  replacements.push([`127.0.0.1:${daemon.port}`, "127.0.0.1:0"]);

  const summary: string[] = [];
  const scenario = async (
    name: string,
    run: (client: SharedDaemonClient) => Promise<void>,
  ): Promise<void> => {
    const recorder = new Recorder(replacements);
    const client = tappedClient(url, recorder);
    try {
      await client.connect();
      await run(client);
      await sleep(300);
    } catch (error) {
      console.error(`scenario ${name} failed:`, error);
      summary.push(`${name}: FAILED ${(error as Error).message}`);
    } finally {
      await client.close().catch(() => undefined);
    }
    await sleep(100);
    await writeFile(path.join(outDir, `${name}.jsonl`), `${recorder.lines.join("\n")}\n`);
    summary.push(
      `${name}: ${recorder.lines.length} frames${recorder.truncated ? " (truncated)" : ""}`,
    );
  };

  try {
    await scenario("handshake_ping", async (client) => {
      await client.ping();
      await client.ping();
    });

    await scenario("list_state", async (client) => {
      await client.fetchAgents({ subscribe: {} });
      await client.openProject(repo);
      await client.fetchWorkspaces({ subscribe: {} });
      await client.listProjects();
      await client.listTerminals(repo);
    });

    await scenario("agent_mock", async (client) => {
      await client.fetchAgents({ subscribe: {} });
      await client.openProject(repo);
      const agent = await client.createAgent({
        provider: "mock",
        cwd: repo,
        title: "Fixture agent",
      });
      await client.sendMessage(agent.id, "hello fixture");
      await sleep(1200);
      await client.cancelAgent(agent.id).catch(() => undefined);
      await sleep(300);
      await client.archiveAgent(agent.id).catch(() => undefined);
    });

    await scenario("terminal", async (client) => {
      await client.fetchAgents({ subscribe: {} });
      await client.openProject(repo);
      const created = await client.createTerminal(repo, "fixture-term", undefined, {
        command: "/bin/sh",
        args: ["-c", "printf 'ready\\n'; cat"],
        size: { rows: 24, cols: 80 },
      });
      const terminalId = created.terminal?.id;
      if (!terminalId) throw new Error(`createTerminal failed: ${created.error}`);
      const sub = await client.subscribeTerminal(terminalId);
      await sleep(400);
      client.sendTerminalInput(terminalId, { type: "input", data: "echo hi-fixture\r" });
      await sleep(400);
      client.sendTerminalInput(terminalId, { type: "resize", rows: 30, cols: 100 });
      await sleep(300);
      await client.captureTerminal(terminalId);
      await client.listTerminals(repo);
      sub.subscription.unsubscribe?.();
      await client.killTerminal(terminalId);
    });

    await scenario("checkout_status", async (client) => {
      await client.fetchAgents({ subscribe: {} });
      await client.openProject(repo);
      await client.getCheckoutStatus(repo);
      await client.getBranchSuggestions({ cwd: repo, query: "ma" }).catch(() => undefined);
    });

    await scenario("directory_suggestions", async (client) => {
      await client.fetchAgents({ subscribe: {} });
      await client.getDirectorySuggestions({
        cwd: repo,
        query: "src",
        limit: 10,
        includeFiles: true,
        includeDirectories: true,
        matchMode: "fuzzy",
      });
      await client.getDirectorySuggestions({
        cwd: repo,
        query: "./README",
        limit: 5,
        includeFiles: true,
        includeDirectories: false,
        matchMode: "suffix",
      });
    });
  } finally {
    await daemon.close();
    await rm(scratch, { recursive: true, force: true });
  }
  console.log(summary.join("\n"));
  console.log(`fixtures written to ${outDir}`);
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
