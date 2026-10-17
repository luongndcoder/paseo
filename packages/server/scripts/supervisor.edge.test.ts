import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

// Fake `paseod`: speaks the jsonl transport the supervisor uses for PASEO_EDGE=rust.
async function runWithFakeEdge(edgeScript: string) {
  const home = await mkdtemp(path.join(tmpdir(), "paseo-edge-supervisor-"));
  const edgePath = path.join(home, "fake-paseod.mjs");
  const runnerPath = path.join(home, "runner.mjs");
  const eventsPath = path.join(home, "events.jsonl");
  const supervisor = new URL("./supervisor.ts", import.meta.url).href;
  await writeFile(edgePath, edgeScript);
  await writeFile(
    runnerPath,
    `
    import { appendFile } from "node:fs/promises";
    import { runSupervisor } from ${JSON.stringify(supervisor)};
    const record = (event) => appendFile(${JSON.stringify(eventsPath)}, JSON.stringify(event) + "\\n");
    runSupervisor({
      name: "EdgeTest", startupMessage: "starting", restartOnCrash: true,
      resolveWorkerEntry: () => ${JSON.stringify(edgePath)}, workerArgs: [], workerExecArgv: [],
      resolveWorkerSpawnSpec: () => ({
        command: process.execPath, args: [${JSON.stringify(edgePath)}], transport: "jsonl",
      }),
      onWorkerReady: ({ listen, serverId }) => record({ listen, serverId }),
      onWorkerExit: () => record(null),
    });
  `,
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("PASEO_")),
  );
  const child = spawn(process.execPath, ["--import", "tsx", runnerPath], {
    cwd: fileURLToPath(new URL("../../../", import.meta.url)),
    env: { ...env, HOME: home, PASEO_HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`${stdout}\n${stderr}`));
      }, 10_000);
      child.once("error", reject);
      child.once("close", (exitCode) => {
        clearTimeout(timer);
        resolve(exitCode);
      });
    });
    const events = await readFile(eventsPath, "utf8").catch(() => "");
    return {
      code,
      stdout,
      events: events
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test.skipIf(process.platform === "win32")(
  "the supervisor publishes the edge's ready line, hides protocol lines and stops it with SIGTERM",
  async () => {
    const result = await runWithFakeEdge(`
      process.on("SIGTERM", () => process.exit(0));
      console.log("plain log line");
      console.log('@@paseo {"type":"paseo:ready","listen":"0.0.0.0:6767","serverId":"srv_1"}');
      console.log('@@paseo {"type":"paseo:shutdown","reason":"test_shutdown"}');
      setInterval(() => {}, 1000);
    `);
    expect(result.code).toBe(0);
    expect(result.events).toEqual([{ listen: "0.0.0.0:6767", serverId: "srv_1" }, null]);
    expect(result.stdout).toContain("plain log line");
    expect(result.stdout).not.toContain("@@paseo");
  },
);

test.skipIf(process.platform === "win32")(
  "an edge that exits before ready fails the supervisor",
  async () => {
    const result = await runWithFakeEdge(`process.exit(1);`);
    expect(result.code).toBe(1);
    expect(result.events).toEqual([null]);
  },
);
