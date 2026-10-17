import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { PluginServerContribution } from "@getpaseo/plugin/server";
import { createPluginWorker, type PluginWorkerChannel } from "./plugin-process.js";
import type { PluginProcessMessage, PluginProcessRequest } from "./plugin-process-protocol.js";

const SHUTDOWN_TIMEOUT_MS = 10_000;

export class InternalPluginChild extends EventEmitter {
  connected = true;
  killed = false;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  private readonly worker: ReturnType<typeof createPluginWorker>;
  private readonly workerMessages = new Set<(message: PluginProcessRequest) => void>();
  private closing: Promise<void> | null = null;

  constructor(
    contribute: PluginServerContribution,
    private readonly options: {
      stdout?: PassThrough;
      stderr?: PassThrough;
      /** Runs after the plugin's cleanup, before the child reports closed. */
      dispose?: () => void;
    } = {},
  ) {
    super();
    this.stdout = options.stdout ?? new PassThrough();
    this.stderr = options.stderr ?? new PassThrough();
    const channel: PluginWorkerChannel = {
      send: (message: PluginProcessMessage, callback?: () => void) => {
        const copy = structuredClone(message);
        queueMicrotask(() => {
          if (this.connected) this.emit("message", copy);
          callback?.();
        });
      },
      onMessage: (handler) => {
        this.workerMessages.add(handler);
        return () => this.workerMessages.delete(handler);
      },
      disconnect: () => this.disconnect(),
    };
    this.worker = createPluginWorker({ channel, contribute });
  }

  send(message: PluginProcessRequest, callback?: (error: Error | null) => void): boolean {
    if (!this.connected) {
      callback?.(new Error("Plugin child is disconnected"));
      return false;
    }
    const copy = structuredClone(message);
    queueMicrotask(() => {
      for (const handler of this.workerMessages) handler(copy);
      callback?.(null);
    });
    return true;
  }

  kill(): boolean {
    if (this.killed) return false;
    this.killed = true;
    this.disconnect();
    return true;
  }

  /** Ends the child as an unexpected exit; the runtime reports the plugin as failed. */
  crash(error: unknown): void {
    if (this.closing) return;
    this.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    this.disconnect();
  }

  disconnect(): void {
    if (this.closing) return;
    // Plugin cleanup shares the daemon's event loop and cannot be killed, so bound the wait.
    this.closing = Promise.race([
      Promise.resolve().then(() => this.worker.shutdown()),
      new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS).unref()),
    ])
      .catch(() => undefined)
      .finally(() => {
        this.options.dispose?.();
        this.connected = false;
        this.stdout.end();
        this.stderr.end();
        this.emit("close", 0, null);
      });
  }
}
