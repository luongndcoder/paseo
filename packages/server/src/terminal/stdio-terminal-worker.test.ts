import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkerTerminalManager } from "./worker-terminal-manager.js";
import type { TerminalManager } from "./terminal-manager.js";
import {
  decodeWorkerLine,
  encodeWorkerLine,
  forkStdioTerminalWorker,
  isRustTerminalWorkerEnabled,
  resolveRustTerminalWorkerBinary,
  RUST_TERMINAL_WORKER_BIN_ENV,
  type StdioTerminalWorkerProcess,
} from "./stdio-terminal-worker.js";
import type {
  TerminalWorkerRequest,
  TerminalWorkerToParentMessage,
} from "./terminal-worker-protocol.js";

const temporaryDirs: string[] = [];
const workers: StdioTerminalWorkerProcess[] = [];
const managers: TerminalManager[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const manager of managers.splice(0)) {
    manager.killAll();
  }
  for (const worker of workers.splice(0)) {
    worker.kill();
  }
  for (const dir of temporaryDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Stand-in for the Rust binary: echoes every request back as a response whose
// result carries the request, exits on killAll, exits 0 on stdin EOF.
const FAKE_WORKER_SCRIPT = `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({ type: "response", requestId: request.requestId, ok: true, result: request }) + "\\n");
  if (request.type === "killAll") process.exit(3);
});
rl.on("close", () => process.exit(0));
`;

function startFakeWorker(): StdioTerminalWorkerProcess {
  const script = join(makeTempDir("stdio-worker-fake-"), "fake-worker.cjs");
  writeFileSync(script, FAKE_WORKER_SCRIPT);
  const worker = forkStdioTerminalWorker({ binaryPath: process.execPath, args: [script] });
  workers.push(worker);
  return worker;
}

function sendAndWait(
  worker: StdioTerminalWorkerProcess,
  request: TerminalWorkerRequest,
): Promise<TerminalWorkerToParentMessage> {
  return new Promise((resolve, reject) => {
    worker.on("message", resolve);
    worker.send(request, (error) => {
      if (error) {
        reject(error);
      }
    });
  });
}

function waitForExit(
  worker: StdioTerminalWorkerProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    worker.on("exit", (code, signal) => resolve({ code, signal }));
  });
}

describe("jsonl codec", () => {
  it("round-trips binary fields through {$b64}", () => {
    const line = encodeWorkerLine({ a: Buffer.from("hi"), nested: [new Uint8Array([1, 2, 3])] });
    expect(line.endsWith("\n")).toBe(true);
    expect(line).toContain('{"$b64":"aGk="}');
    const decoded = decodeWorkerLine(line.trim()) as { a: Buffer; nested: Buffer[] };
    expect(Buffer.isBuffer(decoded.a)).toBe(true);
    expect(decoded.a.toString()).toBe("hi");
    expect(Array.from(decoded.nested[0])).toEqual([1, 2, 3]);
  });

  it("replaces lone surrogates but keeps valid pairs", () => {
    const line = encodeWorkerLine({ data: "a\ud83d b \ude00 \u{1F600}" });
    expect(line).not.toMatch(/\\ud[89a-f]/i);
    expect((JSON.parse(line) as { data: string }).data).toBe("a\uFFFD b \uFFFD \u{1F600}");
  });

  it("decodes lines without $b64 as plain JSON", () => {
    const line = '{"a":[1,{"b":"x"}],"c":null}';
    expect(decodeWorkerLine(line)).toEqual(JSON.parse(line));
  });

  it("decodes a deeply nested {$b64} object", () => {
    const decoded = decodeWorkerLine('{"a":[{"b":{"c":[{"$b64":"aGk="}]}}]}') as {
      a: { b: { c: Buffer[] } }[];
    };
    expect(Buffer.isBuffer(decoded.a[0].b.c[0])).toBe(true);
    expect(decoded.a[0].b.c[0].toString()).toBe("hi");
  });

  it("does not decode strings that merely contain the text $b64", () => {
    const line = '{"s":"{\\"$b64\\":\\"aGk=\\"}","t":"\\"$b64\\"","k":{"x":"$b64"}}';
    const decoded = decodeWorkerLine(line) as { s: unknown; t: unknown; k: unknown };
    expect(typeof decoded.s).toBe("string");
    expect(decoded.s).toBe('{"$b64":"aGk="}');
    expect(decoded.t).toBe('"$b64"');
    expect(decoded.k).toEqual({ x: "$b64" });
  });

  it("does not decode a non-string $b64 value", () => {
    expect(decodeWorkerLine('{"$b64":5}')).toEqual({ $b64: 5 });
  });

  it("leaves objects with other keys alone", () => {
    expect(decodeWorkerLine('{"$b64":"aGk=","x":1}')).toEqual({ $b64: "aGk=", x: 1 });
  });
});

describe("selection and binary resolution", () => {
  it("enables only for PASEO_TERMINAL_WORKER=rust", () => {
    expect(isRustTerminalWorkerEnabled({})).toBe(false);
    expect(isRustTerminalWorkerEnabled({ PASEO_TERMINAL_WORKER: "node" })).toBe(false);
    expect(isRustTerminalWorkerEnabled({ PASEO_TERMINAL_WORKER: "rust" })).toBe(true);
  });

  it("errors clearly when the override binary is missing", () => {
    expect(() =>
      resolveRustTerminalWorkerBinary({ [RUST_TERMINAL_WORKER_BIN_ENV]: "/nonexistent/worker" }),
    ).toThrow(/missing file/);
  });

  it("errors clearly when no binary is available", () => {
    expect(() => resolveRustTerminalWorkerBinary({})).toThrow(/binary was not found/);
  });
});

describe("process emulation", () => {
  it("delivers messages and invokes the send callback with null on success", async () => {
    const worker = startFakeWorker();
    expect(worker.connected).toBe(true);
    const sendError = new Promise<Error | null>((resolve) => {
      worker.on("message", () => {});
      worker.send({ type: "killTerminal", requestId: "r1", terminalId: "t1" }, resolve);
    });
    expect(await sendError).toBeNull();
  });

  it("round-trips a response", async () => {
    const worker = startFakeWorker();
    const response = await sendAndWait(worker, {
      type: "registerCwdEnv",
      requestId: "r2",
      cwd: "/tmp",
      env: { A: "b" },
    });
    expect(response).toMatchObject({ type: "response", requestId: "r2", ok: true });
  });

  it("emits exit with the code and flips connected", async () => {
    const worker = startFakeWorker();
    const exited = waitForExit(worker);
    worker.send({ type: "killAll", requestId: "r3" }, () => {});
    expect(await exited).toEqual({ code: 3, signal: null });
    expect(worker.connected).toBe(false);
  });

  it("disconnect closes stdin and the worker exits cleanly", async () => {
    const worker = startFakeWorker();
    const exited = waitForExit(worker);
    worker.disconnect();
    expect(worker.connected).toBe(false);
    expect(await exited).toEqual({ code: 0, signal: null });
  });

  it("kill sets killed and emits exit with a signal", async () => {
    const worker = startFakeWorker();
    const exited = waitForExit(worker);
    expect(worker.kill()).toBe(true);
    expect(worker.killed).toBe(true);
    expect((await exited).signal).toBe("SIGTERM");
  });

  it("send after disconnect reports an error through the callback", async () => {
    const worker = startFakeWorker();
    worker.disconnect();
    const error = await new Promise<Error | null>((resolve) => {
      worker.send({ type: "killAll", requestId: "r4" }, resolve);
    });
    expect(error).toBeInstanceOf(Error);
  });

  it("a spawn failure surfaces as exit so pending requests reject", async () => {
    const worker = forkStdioTerminalWorker({ binaryPath: "/nonexistent/paseo-terminal-worker" });
    workers.push(worker);
    const exited = await waitForExit(worker);
    expect(exited).toEqual({ code: null, signal: null });
    expect(worker.connected).toBe(false);
  });
});

const rustBinary = process.env[RUST_TERMINAL_WORKER_BIN_ENV];

describe.skipIf(!rustBinary)(
  `node vs rust worker parity (needs ${RUST_TERMINAL_WORKER_BIN_ENV}; skipped otherwise)`,
  () => {
    const SCRIPTS: Record<string, string> = {
      plain: `process.stdout.write("hello\\r\\nworld\\r\\n");`,
      sgr: `process.stdout.write("\\x1b[31mred\\x1b[0m \\x1b[1;4mbold\\x1b[0m \\x1b[38;5;82mx\\x1b[0m\\r\\n");`,
      cursor: `process.stdout.write("abc\\x1b[2D\\x1b[1;1HZ\\x1b[3;5Hhere\\x1b[K");`,
      wrap: `process.stdout.write("x".repeat(95) + "\\r\\n");`,
      scrollback: `for (let i = 0; i < 40; i++) process.stdout.write("line " + i + "\\r\\n");`,
      clear: `process.stdout.write("junk\\r\\n\\x1b[2J\\x1b[Hfresh");`,
      utf8: `process.stdout.write("h\\u00e9llo \\u4e16\\u754c \\ud83d\\ude00\\r\\n");`,
      title: `process.stdout.write("\\x1b]0;my title\\x07body");`,
    };

    async function waitFor(check: () => Promise<boolean>, timeoutMs = 10000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await check()) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error("Timed out waiting for terminal output");
    }

    async function runScript(manager: TerminalManager, script: string) {
      const cwd = makeTempDir("stdio-worker-parity-");
      // The trailing marker is written after the scripted bytes, so once it is
      // visible the emulator has consumed everything before it.
      const full = `${script}\nprocess.stdout.write("\\x1b[10;1HDONE-MARKER");setInterval(()=>{},1000);`;
      const session = await manager.createTerminal({
        workspaceId: "ws-parity",
        cwd,
        command: process.execPath,
        args: ["-e", full],
        rows: 12,
        cols: 40,
      });
      await waitFor(async () => {
        const snapshot = await manager.getTerminalState(session.id);
        return snapshot?.state.grid.some((row) => rowText(row).includes("DONE-MARKER")) ?? false;
      });
      const snapshot = await manager.getTerminalState(session.id);
      const capture = await manager.captureTerminal(session.id, { stripAnsi: true });
      const captureRaw = await manager.captureTerminal(session.id, { stripAnsi: false });
      const state = snapshot!.state;
      return {
        rows: state.rows,
        cols: state.cols,
        grid: state.grid,
        scrollback: state.scrollback,
        cursor: state.cursor,
        title: state.title,
        capture,
        captureRaw,
      };
    }

    for (const [name, script] of Object.entries(SCRIPTS)) {
      it(`matches state and capture: ${name}`, async () => {
        const previous = process.env.PASEO_TERMINAL_WORKER;
        delete process.env.PASEO_TERMINAL_WORKER;
        try {
          const nodeManager = createWorkerTerminalManager();
          managers.push(nodeManager);
          const rustManager = createWorkerTerminalManager({
            forkWorker: () => forkStdioTerminalWorker({ binaryPath: rustBinary! }),
          });
          managers.push(rustManager);
          const [nodeResult, rustResult] = await Promise.all([
            runScript(nodeManager, script),
            runScript(rustManager, script),
          ]);
          expect(rustResult).toEqual(nodeResult);
        } finally {
          if (previous !== undefined) {
            process.env.PASEO_TERMINAL_WORKER = previous;
          }
        }
      }, 30000);
    }
  },
);

function rowText(row: Array<{ char: string }>): string {
  return row.map((c) => c.char).join("");
}
