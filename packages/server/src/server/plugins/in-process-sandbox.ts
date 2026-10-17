import { Console } from "node:console";
import { PassThrough } from "node:stream";

type TimerHandle = ReturnType<typeof setTimeout>;
type TimerCallback = (...args: unknown[]) => unknown;

export interface InProcessSandbox {
  /** Shadows of host globals; passed to `evaluateBundle` as the bundle's free variables. */
  readonly globals: Readonly<Record<string, unknown>>;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  /** Called when plugin code throws somewhere no RPC can carry the error back. */
  onFatal: (error: unknown) => void;
  /** Clears every timer the plugin still has pending. */
  dispose(): void;
}

function describe(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

/**
 * Scopes the process-wide effects a plugin can have when it shares the daemon's process:
 * output goes to the plugin's log, timers are tracked and cleared on stop, errors thrown from
 * timer callbacks fail only this plugin, and `process.exit()` cannot end the daemon.
 * A plugin that reaches the real globals some other way (for example through a required Node
 * module) is not contained; that is the cost of skipping the subprocess.
 */
export function createInProcessSandbox(): InProcessSandbox {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const timeouts = new Set<TimerHandle>();
  const intervals = new Set<TimerHandle>();
  const immediates = new Set<NodeJS.Immediate>();
  let disposed = false;

  const sandbox: InProcessSandbox = {
    globals: {},
    stdout,
    stderr,
    onFatal(error) {
      stderr.write(`${describe(error)}\n`);
    },
    dispose() {
      disposed = true;
      for (const handle of timeouts) clearTimeout(handle);
      for (const handle of intervals) clearInterval(handle);
      for (const handle of immediates) clearImmediate(handle);
      timeouts.clear();
      intervals.clear();
      immediates.clear();
    },
  };

  function guard(callback: TimerCallback, args: unknown[]): void {
    if (disposed) return;
    try {
      const result = callback(...args);
      if (result && typeof (result as PromiseLike<unknown>).then === "function") {
        (result as PromiseLike<unknown>).then(undefined, (error) => sandbox.onFatal(error));
      }
    } catch (error) {
      sandbox.onFatal(error);
    }
  }

  const processShim = new Proxy(process, {
    get(target, key) {
      if (key === "stdout") return stdout;
      if (key === "stderr") return stderr;
      if (key === "exit") {
        return (code?: number) => {
          throw new Error(`Plugin called process.exit(${code ?? ""})`);
        };
      }
      if (key === "chdir") {
        return () => {
          throw new Error("Plugins cannot change the daemon working directory");
        };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  Object.assign(sandbox.globals, {
    console: new Console({ stdout, stderr }),
    process: processShim,
    setTimeout(callback: TimerCallback, delay?: number, ...args: unknown[]): TimerHandle {
      const handle: TimerHandle = setTimeout(() => {
        timeouts.delete(handle);
        guard(callback, args);
      }, delay);
      timeouts.add(handle);
      return handle;
    },
    clearTimeout(handle: TimerHandle | undefined): void {
      if (handle) timeouts.delete(handle);
      clearTimeout(handle);
    },
    setInterval(callback: TimerCallback, delay?: number, ...args: unknown[]): TimerHandle {
      const handle: TimerHandle = setInterval(() => guard(callback, args), delay);
      intervals.add(handle);
      return handle;
    },
    clearInterval(handle: TimerHandle | undefined): void {
      if (handle) intervals.delete(handle);
      clearInterval(handle);
    },
    setImmediate(callback: TimerCallback, ...args: unknown[]): NodeJS.Immediate {
      const handle = setImmediate(() => {
        immediates.delete(handle);
        guard(callback, args);
      });
      immediates.add(handle);
      return handle;
    },
    clearImmediate(handle: NodeJS.Immediate | undefined): void {
      if (handle) immediates.delete(handle);
      clearImmediate(handle);
    },
  });
  return sandbox;
}
