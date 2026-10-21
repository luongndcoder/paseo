/* oxlint-disable typescript/no-explicit-any -- wire frames are inspected dynamically */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, test } from "vitest";

import type { AgentLaunchContext, AgentSession } from "../server/agent/agent-sdk-types.js";
import type { OpenCodeBridge } from "../server/agent/providers/opencode/bridge.js";
import type { BuildProviderRegistryOptions } from "../server/agent/provider-registry.js";
import type { PaseoToolCatalog } from "../server/agent/tools/types.js";
import { ProviderHost } from "./host.js";
import { RpcErrorCode, type OutboundMessage } from "./protocol.js";

const logger = pino({ level: "silent" });

const ECHO_TOOL = {
  name: "echo",
  description: "Echo the input",
  inputSchema: {
    type: "object",
    properties: { x: { type: "number" } },
    required: ["x"],
  },
};

interface FakeProvider {
  launchContexts: AgentLaunchContext[];
  sessions: AgentSession[];
}

function fakeSession(provider: string, onTurn: () => void): AgentSession {
  return {
    provider,
    id: "fake-session",
    capabilities: {},
    subscribe: () => () => undefined,
    describePersistence: () => null,
    close: async () => undefined,
    startTurn: async () => {
      onTurn();
      return { turnId: "t1" };
    },
  } as unknown as AgentSession;
}

class Rig {
  readonly frames: any[] = [];
  readonly fake: FakeProvider = { launchContexts: [], sessions: [] };
  registryOptions: BuildProviderRegistryOptions | undefined;
  onTurn: (catalog: PaseoToolCatalog) => void = () => undefined;
  readonly host: ProviderHost;
  private waiters: Array<() => void> = [];

  constructor() {
    this.host = new ProviderHost({
      logger,
      send: (message: OutboundMessage) => {
        this.frames.push(message);
        this.waiters.splice(0).forEach((resolve) => resolve());
      },
      buildRegistry: (_logger, options) => {
        this.registryOptions = options;
        return {
          fake: {
            id: "fake",
            label: "Fake",
            description: "fake",
            enabled: true,
            defaultModeId: null,
            modes: [],
            createClient: () =>
              ({
                provider: "fake",
                capabilities: {},
                createSession: async (_config: unknown, launchContext?: AgentLaunchContext) => {
                  this.fake.launchContexts.push(launchContext ?? {});
                  const session = fakeSession("fake", () => {
                    if (launchContext?.paseoTools) this.onTurn(launchContext.paseoTools);
                  });
                  this.fake.sessions.push(session);
                  return session;
                },
                isAvailable: async () => true,
                shutdown: async () => undefined,
              }) as any,
          },
        } as any;
      },
    });
  }

  write(message: unknown): void {
    this.host.handleLine(JSON.stringify(message));
  }

  async waitFor(predicate: (frame: any) => boolean, timeoutMs = 5000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.frames.find(predicate);
      if (found) return found;
      if (Date.now() > deadline) throw new Error("timed out waiting for frame");
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 25);
      });
    }
  }

  async call(id: number, method: string, params: unknown): Promise<any> {
    this.write({ id, method, params });
    return this.waitFor((frame) => frame.id === id);
  }

  async init(params: Record<string, unknown> = {}): Promise<void> {
    const frame = await this.call(1, "host.initialize", { protocolVersion: 1, ...params });
    expect(frame.error).toBeUndefined();
  }

  createSession(launchContext: unknown): Promise<any> {
    return this.call(10, "provider.createSession", {
      provider: "fake",
      config: { provider: "fake", cwd: "/" },
      launchContext,
    });
  }
}

const rigs: Rig[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const active of rigs.splice(0)) await active.host.shutdown();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function rig(): Rig {
  const instance = new Rig();
  rigs.push(instance);
  return instance;
}

describe("provider-host reverse calls (tool.call)", () => {
  test("a proxied paseo tool call becomes a tool.call request and resolves with the response", async () => {
    const r = rig();
    await r.init();
    const result = new Promise<unknown>((resolve, reject) => {
      r.onTurn = (catalog) => {
        catalog.executeTool("echo", { x: 1 }).then(resolve, reject);
      };
    });
    const session = await r.createSession({ agentId: "agent-1", paseoTools: [ECHO_TOOL] });
    expect(session.error).toBeUndefined();
    const handle = session.result.handle;
    await r.call(11, "session.startTurn", { handle, prompt: "go" });

    const request = await r.waitFor((frame) => frame.method === "tool.call");
    expect(request.id).toMatch(/^h\d+$/);
    expect(request.params).toEqual({ agentId: "agent-1", tool: "echo", arguments: { x: 1 } });

    r.write({ id: request.id, result: { content: [{ type: "text", text: "ok" }] } });
    expect(await result).toEqual({ content: [{ type: "text", text: "ok" }] });
  });

  test("an error response rejects the tool call and is logged to the client", async () => {
    const r = rig();
    await r.init();
    const result = new Promise<unknown>((resolve) => {
      r.onTurn = (catalog) => {
        catalog.executeTool("echo", { x: 2 }).then(resolve, (error: Error) => resolve(error));
      };
    });
    const session = await r.createSession({ paseoTools: [ECHO_TOOL] });
    await r.call(11, "session.startTurn", { handle: session.result.handle, prompt: "go" });
    const request = await r.waitFor((frame) => frame.method === "tool.call");
    r.write({ id: request.id, error: { code: -32000, message: "tool exploded" } });
    const error = (await result) as Error;
    expect(error.message).toBe("tool exploded");
    const log = await r.waitFor((frame) => frame.method === "host.log");
    expect(log.params.level).toBe("warn");
    expect(log.params.message).toBe("tool.call failed");
    expect(log.params.data.tool).toBe("echo");
  });

  test("aborting the tool call sends $/cancel for the reverse request", async () => {
    const r = rig();
    await r.init();
    const controller = new AbortController();
    const outcome = new Promise<Error>((resolve) => {
      r.onTurn = (catalog) => {
        catalog
          .executeTool("echo", { x: 3 }, { signal: controller.signal })
          .then(() => resolve(new Error("resolved")), resolve);
      };
    });
    const session = await r.createSession({ paseoTools: [ECHO_TOOL] });
    await r.call(11, "session.startTurn", { handle: session.result.handle, prompt: "go" });
    const request = await r.waitFor((frame) => frame.method === "tool.call");
    controller.abort();
    const cancel = await r.waitFor((frame) => frame.method === "$/cancel");
    expect(cancel.params).toEqual({ id: request.id });
    expect(((await outcome) as any).code).toBe(RpcErrorCode.Canceled);
  });

  test("unknown tools are rejected locally without a request", async () => {
    const r = rig();
    await r.init();
    const outcome = new Promise<Error>((resolve) => {
      r.onTurn = (catalog) => {
        catalog.executeTool("missing", {}).then(() => resolve(new Error("resolved")), resolve);
      };
    });
    const session = await r.createSession({ paseoTools: [ECHO_TOOL] });
    await r.call(11, "session.startTurn", { handle: session.result.handle, prompt: "go" });
    expect((await outcome).message).toContain("missing");
    expect(r.frames.some((frame) => frame.method === "tool.call")).toBe(false);
  });

  test("malformed paseoTools is invalid params", async () => {
    const r = rig();
    await r.init();
    const frame = await r.createSession({ paseoTools: "nope" });
    expect(frame.error.code).toBe(RpcErrorCode.InvalidParams);
    const bad = await r.call(12, "provider.createSession", {
      provider: "fake",
      config: { provider: "fake", cwd: "/" },
      launchContext: { paseoTools: [{ name: 5 }] },
    });
    expect(bad.error.code).toBe(RpcErrorCode.InvalidParams);
  });

  test("a launch context without tools passes through untouched", async () => {
    const r = rig();
    await r.init();
    await r.createSession({ agentId: "a", env: { K: "V" } });
    expect(r.fake.launchContexts[0]).toEqual({ agentId: "a", env: { K: "V" } });
  });

  test("shutdown rejects in-flight reverse requests", async () => {
    const r = rig();
    await r.init();
    const outcome = new Promise<Error>((resolve) => {
      r.onTurn = (catalog) => {
        catalog.executeTool("echo", { x: 4 }).then(() => resolve(new Error("resolved")), resolve);
      };
    });
    const session = await r.createSession({ paseoTools: [ECHO_TOOL] });
    await r.call(11, "session.startTurn", { handle: session.result.handle, prompt: "go" });
    await r.waitFor((frame) => frame.method === "tool.call");
    await r.host.shutdown();
    expect(((await outcome) as any).code).toBe(RpcErrorCode.ShuttingDown);
  });
});

describe("provider-host OpenCode bridge", () => {
  test("tool.call round trip through the OpenCode bridge HTTP route", async () => {
    const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "paseo-host-runtime-"));
    dirs.push(runtimeDir);
    const r = rig();
    await r.init({ providers: ["fake", "opencode"], runtimeDir });
    const bridge = r.registryOptions?.openCodeBridge as OpenCodeBridge | undefined;
    expect(bridge).toBeDefined();

    const manifest = await r.call(5, "host.setToolManifest", { tools: [ECHO_TOOL] });
    expect(manifest.result).toEqual({ applied: true });

    const session = await r.createSession({ agentId: "agent-1", paseoTools: [ECHO_TOOL] });
    expect(session.error).toBeUndefined();
    const catalog = r.fake.launchContexts[0].paseoTools as PaseoToolCatalog;
    const unbind = bridge!.bindSession({ sessionId: "ses_1", env: {}, tools: catalog });

    const options = JSON.parse(bridge!.decorateServerEnv({}).OPENCODE_CONFIG_CONTENT).plugin.at(
      -1,
    )[1];
    const headers = {
      authorization: `Bearer ${options.token}`,
      "content-type": "application/json",
    };

    // The manifest the plugin registers comes from the proxy catalog's JSON Schema.
    const listed = await fetch(`${options.baseUrl}/_internal/opencode/tools`, { headers });
    const tools = (await listed.json()).tools;
    expect(tools.map((tool: { name: string }) => tool.name)).toEqual(["echo"]);
    expect(tools[0].inputSchema.properties.x.type).toBe("number");

    const pending = fetch(`${options.baseUrl}/_internal/opencode/sessions/ses_1/tools/echo`, {
      method: "POST",
      headers,
      body: JSON.stringify({ x: 41 }),
    });
    const request = await r.waitFor((frame) => frame.method === "tool.call");
    expect(request.params).toEqual({ agentId: "agent-1", tool: "echo", arguments: { x: 41 } });
    r.write({ id: request.id, result: { content: [{ type: "text", text: "42" }] } });
    const response = await pending;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ content: [{ type: "text", text: "42" }] });
    unbind();

    // The bridge plugin lives under the runtime dir the client supplied.
    expect(bridge!.decorateServerEnv({}).OPENCODE_CONFIG_CONTENT).toContain(runtimeDir);
  });

  test("without runtimeDir the host starts no bridge and writes nothing", async () => {
    const r = rig();
    await r.init({ providers: ["fake", "opencode"] });
    expect(r.registryOptions?.openCodeBridge).toBeUndefined();
    const manifest = await r.call(5, "host.setToolManifest", { tools: [ECHO_TOOL] });
    expect(manifest.result).toEqual({ applied: false });
  });
});
