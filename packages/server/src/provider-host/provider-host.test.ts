/* oxlint-disable typescript/no-explicit-any -- wire frames are inspected dynamically */
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, test } from "vitest";

import { runProviderHost } from "./main.js";
import { RpcErrorCode } from "./protocol.js";

interface Frame {
  id?: number | string | null;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string; data?: unknown };
}

/** Drives the real stdio entry through in-memory streams. */
class Harness {
  readonly input = new PassThrough();
  readonly output = new PassThrough();
  readonly frames: Frame[] = [];
  private nextId = 1;
  private waiters: Array<() => void> = [];
  readonly done: Promise<void>;

  constructor() {
    createInterface({ input: this.output }).on("line", (line) => {
      this.frames.push(JSON.parse(line));
      this.waiters.splice(0).forEach((resolve) => resolve());
    });
    this.done = runProviderHost({ input: this.input, output: this.output });
  }

  write(message: unknown): void {
    this.input.write(`${JSON.stringify(message)}\n`);
  }

  async waitFor(predicate: (frame: Frame) => boolean, timeoutMs = 10_000): Promise<Frame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.frames.find(predicate);
      if (found) return found;
      if (Date.now() > deadline) throw new Error("timed out waiting for frame");
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  }

  async call(method: string, params?: unknown): Promise<Frame> {
    const id = this.nextId++;
    this.write({ id, method, params });
    return this.waitFor((frame) => frame.id === id);
  }

  async ok(method: string, params?: unknown): Promise<any> {
    const frame = await this.call(method, params);
    if (frame.error) throw new Error(`${method}: ${frame.error.message}`);
    return frame.result;
  }

  events(handle: string, type?: string): any[] {
    return this.frames
      .filter((frame) => frame.method === "session.event" && frame.params.handle === handle)
      .map((frame) => frame.params.event)
      .filter((event) => type === undefined || event.type === type);
  }
}

const harnesses: Harness[] = [];
async function start(): Promise<Harness> {
  process.env.PASEO_PROVIDER_HOST_DEV = "1";
  const harness = new Harness();
  harnesses.push(harness);
  await harness.ok("host.initialize", { protocolVersion: 1, isDev: true, providers: ["mock"] });
  return harness;
}

async function createSession(h: Harness, featureValues: Record<string, unknown> = {}) {
  return h.ok("provider.createSession", {
    provider: "mock",
    config: { provider: "mock", cwd: process.cwd(), model: "ten-second-stream", featureValues },
  });
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    harness.input.end();
    await harness.done;
  }
});

describe("provider-host JSONL-RPC", () => {
  test("initialize lists only the requested providers", async () => {
    const h = await start();
    const { providers } = await h.ok("provider.list");
    expect(providers.map((p: { id: string }) => p.id)).toEqual(["mock"]);
  });

  test("initialize rejects unsupported protocol versions", async () => {
    const h = new Harness();
    harnesses.push(h);
    const frame = await h.call("host.initialize", { protocolVersion: 99 });
    expect(frame.error?.code).toBe(RpcErrorCode.InvalidParams);
  });

  test("unknown method, bad JSON and bad params produce typed errors", async () => {
    const h = await start();
    expect((await h.call("nope.nothing")).error?.code).toBe(RpcErrorCode.MethodNotFound);
    expect((await h.call("provider.createSession", { provider: "mock" })).error?.code).toBe(
      RpcErrorCode.InvalidParams,
    );
    expect((await h.call("provider.isAvailable", { provider: "ghost" })).error?.code).toBe(
      RpcErrorCode.UnknownProvider,
    );
    expect((await h.call("session.interrupt", { handle: "s999" })).error?.code).toBe(
      RpcErrorCode.UnknownSession,
    );
    h.input.write("{not json\n");
    const parse = await h.waitFor((frame) => frame.error?.code === RpcErrorCode.ParseError);
    expect(parse.id).toBeNull();
  });

  test("isAvailable and fetchCatalog expose the mock catalog", async () => {
    const h = await start();
    expect(await h.ok("provider.isAvailable", { provider: "mock" })).toEqual({ available: true });
    const catalog = await h.ok("provider.fetchCatalog", {
      provider: "mock",
      options: { scope: "global", force: false },
    });
    expect(catalog.models.some((m: { id: string }) => m.id === "ten-second-stream")).toBe(true);
    expect(catalog.modes.length).toBeGreaterThan(0);
  });

  test("createSession returns a handle and run streams events then the result", async () => {
    const h = await start();
    const session = await createSession(h, { mockAssistantResponse: "hello from host" });
    expect(session.handle).toMatch(/^s\d+$/);
    expect(session.capabilities.supportsStreaming).toBe(true);

    const result = await h.ok("session.run", { handle: session.handle, prompt: "hi" });
    expect(result.finalText).toBe("hello from host");
    expect(result.canceled).toBe(false);

    const types = h.events(session.handle).map((event) => event.type);
    expect(types).toContain("turn_started");
    expect(types).toContain("turn_completed");
    const seqs = h.frames
      .filter((frame) => frame.method === "session.event")
      .map((frame) => frame.params.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  test("startTurn returns a turn id and events carry it", async () => {
    const h = await start();
    const session = await createSession(h, { mockAssistantResponse: "turn text" });
    const { turnId } = await h.ok("session.startTurn", { handle: session.handle, prompt: "go" });
    expect(typeof turnId).toBe("string");
    await h.waitFor(
      (frame) => frame.method === "session.event" && frame.params.event.type === "turn_completed",
    );
    expect(h.events(session.handle, "turn_started")[0].turnId).toBe(turnId);
  });

  test("permission request round-trips through respondToPermission", async () => {
    const h = await start();
    const session = await createSession(h);
    const runId = 1000;
    h.write({
      id: runId,
      method: "session.run",
      params: { handle: session.handle, prompt: "Emit synthetic plan approval" },
    });
    const requested = await h.waitFor(
      (frame) =>
        frame.method === "session.event" && frame.params.event.type === "permission_requested",
    );
    const request = requested.params.event.request;
    expect(request.kind).toBe("plan");

    const pending = await h.ok("session.getPendingPermissions", { handle: session.handle });
    expect(pending.requests.map((r: { id: string }) => r.id)).toEqual([request.id]);

    await h.ok("session.respondToPermission", {
      handle: session.handle,
      requestId: request.id,
      response: { behavior: "allow", selectedActionId: "implement" },
    });
    const run = await h.waitFor((frame) => frame.id === runId);
    expect(run.error).toBeUndefined();
    expect(h.events(session.handle, "permission_resolved")).toHaveLength(1);
    const after = await h.ok("session.getPendingPermissions", { handle: session.handle });
    expect(after.requests).toEqual([]);
  });

  test("$/cancel on session.run interrupts the turn", async () => {
    const h = await start();
    const session = await createSession(h);
    const runId = 2000;
    h.write({
      id: runId,
      method: "session.run",
      params: { handle: session.handle, prompt: "long" },
    });
    await h.waitFor(
      (frame) => frame.method === "session.event" && frame.params.event.type === "turn_started",
    );
    h.write({ method: "$/cancel", params: { id: runId } });
    const frame = await h.waitFor((f) => f.id === runId);
    expect(frame.result?.canceled === true || frame.error?.code === RpcErrorCode.Canceled).toBe(
      true,
    );
    expect(h.events(session.handle, "turn_canceled")).toHaveLength(1);
  });

  test("session.interrupt cancels a started turn", async () => {
    const h = await start();
    const session = await createSession(h);
    await h.ok("session.startTurn", { handle: session.handle, prompt: "long" });
    await h.ok("session.interrupt", { handle: session.handle });
    expect(h.events(session.handle, "turn_canceled")).toHaveLength(1);
  });

  test("mode, model and runtime info round-trip", async () => {
    const h = await start();
    const session = await createSession(h);
    const modes = await h.ok("session.getAvailableModes", { handle: session.handle });
    expect(modes.modes.length).toBeGreaterThan(0);
    const current = await h.ok("session.getCurrentMode", { handle: session.handle });
    expect(typeof current.modeId).toBe("string");
    await h.ok("session.setModel", { handle: session.handle, modelId: "one-minute-stream" });
    const info = await h.ok("session.getRuntimeInfo", { handle: session.handle });
    expect(info.model).toBe("one-minute-stream");
  });

  test("describePersistence then resumeSession yields a new handle", async () => {
    const h = await start();
    const session = await createSession(h);
    const { persistence } = await h.ok("session.describePersistence", { handle: session.handle });
    expect(persistence.provider).toBe("mock");
    const resumed = await h.ok("provider.resumeSession", { provider: "mock", persistence });
    expect(resumed.handle).not.toBe(session.handle);
  });

  test("close releases the handle and emits session.closed", async () => {
    const h = await start();
    const session = await createSession(h);
    await h.ok("session.close", { handle: session.handle });
    const closed = await h.waitFor((frame) => frame.method === "session.closed");
    expect(closed.params.handle).toBe(session.handle);
    const after = await h.call("session.interrupt", { handle: session.handle });
    expect(after.error?.code).toBe(RpcErrorCode.UnknownSession);
  });

  test("host.shutdown responds then ends the stream", async () => {
    const h = await start();
    await createSession(h);
    expect(await h.ok("host.shutdown")).toBeNull();
    await h.done;
  });

  test("a session created while shutting down is never left open", async () => {
    const h = await start();
    h.write({
      id: 100,
      method: "provider.createSession",
      params: {
        provider: "mock",
        config: { provider: "mock", cwd: process.cwd(), model: "ten-second-stream" },
      },
    });
    h.write({ id: 101, method: "host.shutdown", params: {} });
    await h.done;
    const created = h.frames.find((frame) => frame.id === 100);
    expect(created).toBeDefined();
    if (created?.error) {
      expect(created.error.code).toBe(RpcErrorCode.ShuttingDown);
    } else {
      // Registered before shutdown began: closeAllSessions() must have closed it.
      const handle = created?.result.handle;
      expect(
        h.frames.some((f) => f.method === "session.closed" && f.params.handle === handle),
      ).toBe(true);
    }
  });

  test("stdin EOF shuts the host down", async () => {
    const h = await start();
    h.input.end();
    await h.done;
  });
});
