import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePaseoCliExecutablePath } from "./paseo-cli-path.js";
import type {
  TerminalWorkerRequest,
  TerminalWorkerToParentMessage,
} from "./terminal-worker-protocol.js";

// Parent-side shim for the Rust terminal worker. It exposes the subset of the
// ChildProcess surface that worker-terminal-manager.ts relies on (message/exit
// events, send callback, connected/disconnect, kill) over a JSONL stdio pipe.
// Wire format: one JSON object per line, same objects as the Node IPC protocol,
// with any Buffer/Uint8Array field encoded as {"$b64":"..."}.

export const RUST_TERMINAL_WORKER_ENV = "PASEO_TERMINAL_WORKER";
export const RUST_TERMINAL_WORKER_BIN_ENV = "PASEO_TERMINAL_WORKER_BIN";
export const SHELL_INTEGRATION_DIR_ENV = "PASEO_SHELL_INTEGRATION_DIR";

export interface StdioTerminalWorkerProcess {
  connected: boolean;
  killed: boolean;
  send(message: TerminalWorkerRequest, callback: (error: Error | null) => void): boolean;
  disconnect(): void;
  kill(): boolean;
  on(event: "message", listener: (message: TerminalWorkerToParentMessage) => void): this;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
}

export interface StdioTerminalWorkerOptions {
  binaryPath: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
}

export function isRustTerminalWorkerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[RUST_TERMINAL_WORKER_ENV] === "rust";
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function encodeWorkerLine(message: unknown): string {
  // Read the raw value via `this`: Buffer#toJSON has already run on `value`.
  return `${JSON.stringify(
    message,
    function (this: Record<string, unknown>, key: string, value: unknown) {
      const raw = this[key];
      if (raw instanceof Uint8Array) {
        return { $b64: Buffer.from(raw).toString("base64") };
      }
      // Lone surrogates serialize as `\ud83d` escapes that serde_json rejects;
      // replace them with U+FFFD, which is what node-pty wrote to the pty.
      if (typeof value === "string") {
        return value.replace(LONE_SURROGATE, "\uFFFD");
      }
      return value;
    },
  )}\n`;
}

export function decodeWorkerLine(line: string): unknown {
  return JSON.parse(line, (_key, value: unknown) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const keys = Object.keys(value);
      const b64 = (value as { $b64?: unknown }).$b64;
      if (keys.length === 1 && typeof b64 === "string") {
        return Buffer.from(b64, "base64");
      }
    }
    return value;
  });
}

function findServerPackageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string };
        if (parsed.name === "@getpaseo/server") {
          return dir;
        }
      } catch {
        // keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error("Could not locate the @getpaseo/server package root");
    }
    dir = parent;
  }
}

export function resolveRustTerminalWorkerBinary(env: NodeJS.ProcessEnv = process.env): string {
  const exe = process.platform === "win32" ? "paseo-terminal-worker.exe" : "paseo-terminal-worker";
  const bundled = join(
    findServerPackageRoot(),
    "dist",
    "bin",
    `${process.platform}-${process.arch}`,
    exe,
  );
  if (existsSync(bundled)) {
    return bundled;
  }
  const override = env[RUST_TERMINAL_WORKER_BIN_ENV];
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`${RUST_TERMINAL_WORKER_BIN_ENV} points to a missing file: ${override}`);
    }
    return override;
  }
  throw new Error(
    `${RUST_TERMINAL_WORKER_ENV}=rust is set but the Rust terminal worker binary was not found. ` +
      `Expected ${bundled} or set ${RUST_TERMINAL_WORKER_BIN_ENV}.`,
  );
}

function resolveShellIntegrationDir(): string {
  return fileURLToPath(new URL("./shell-integration", import.meta.url));
}

class StdioTerminalWorker extends EventEmitter implements StdioTerminalWorkerProcess {
  connected = true;
  killed = false;
  private readonly child: ChildProcess;
  private stdoutBuffer = "";
  private exited = false;

  constructor(options: StdioTerminalWorkerOptions) {
    super();
    // Rust cannot `require.resolve` the CLI like Node, so hand it the resolved path.
    const cliPath = resolvePaseoCliExecutablePath();
    this.child = spawn(options.binaryPath, options.args ?? [], {
      env: {
        ...(options.env ?? process.env),
        [SHELL_INTEGRATION_DIR_ENV]: resolveShellIntegrationDir(),
        ...(cliPath ? { PASEO_CLI: cliPath } : {}),
      },
      stdio: ["pipe", "pipe", "inherit"],
    });

    this.child.stdout?.setEncoding("utf8");
    this.child.stdout?.on("data", (chunk: string) => this.handleStdout(chunk));
    this.child.stdin?.on("error", () => {
      // EPIPE after the worker died; the exit event reports the failure.
      this.connected = false;
    });
    this.child.on("error", (error) => {
      this.connected = false;
      if (this.listenerCount("error") > 0) {
        this.emit("error", error);
      } else {
        console.error("Rust terminal worker failed:", error);
      }
      // A failed spawn never emits "exit"; synthesize it so pending requests reject.
      this.emitExit(null, null);
    });
    this.child.on("exit", (code, signal) => {
      this.connected = false;
      this.flushStdout();
      this.emitExit(code, signal);
    });
  }

  send(message: TerminalWorkerRequest, callback: (error: Error | null) => void): boolean {
    const stdin = this.child.stdin;
    if (!this.connected || !stdin || stdin.destroyed || !stdin.writable) {
      const error = new Error("Terminal worker channel is closed");
      queueMicrotask(() => callback(error));
      return false;
    }
    let line: string;
    try {
      line = encodeWorkerLine(message);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      queueMicrotask(() => callback(failure));
      return false;
    }
    return stdin.write(line, (error) => callback(error ?? null));
  }

  disconnect(): void {
    if (!this.connected) {
      return;
    }
    this.connected = false;
    // EOF on stdin is the disconnect signal; the worker kills all terminals and exits.
    this.child.stdin?.end();
  }

  kill(): boolean {
    this.killed = true;
    return this.child.kill();
  }

  private emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) {
      return;
    }
    this.exited = true;
    this.emit("exit", code, signal);
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newline = this.stdoutBuffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      this.dispatchLine(line);
      newline = this.stdoutBuffer.indexOf("\n");
    }
  }

  private flushStdout(): void {
    const rest = this.stdoutBuffer;
    this.stdoutBuffer = "";
    if (rest.trim()) {
      this.dispatchLine(rest);
    }
  }

  private dispatchLine(line: string): void {
    if (!line.trim()) {
      return;
    }
    let message: unknown;
    try {
      message = decodeWorkerLine(line);
    } catch (error) {
      console.error("Rust terminal worker emitted an invalid line:", error);
      return;
    }
    this.emit("message", message as TerminalWorkerToParentMessage);
  }
}

export function forkStdioTerminalWorker(
  options?: Partial<StdioTerminalWorkerOptions>,
): StdioTerminalWorkerProcess {
  const binaryPath = options?.binaryPath ?? resolveRustTerminalWorkerBinary();
  return new StdioTerminalWorker({ ...options, binaryPath });
}
