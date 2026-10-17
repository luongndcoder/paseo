import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { PluginRuntime } from "./runtime.js";
import type { PluginSessionSocket } from "./session-socket.js";

const temporaryDirectories: string[] = [];

async function createPlugin(id: string, source: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-inproc-"));
  temporaryDirectories.push(directory);
  await writeFile(path.join(directory, "paseo-plugin.json"), JSON.stringify({ id }), "utf8");
  await writeFile(path.join(directory, "index.server.ts"), source, "utf8");
  return directory;
}

// Records the client id each plugin session announces in its hello handshake.
function createSessionHost() {
  const clientIds: string[] = [];
  const active = new Set<PluginSessionSocket>();
  return {
    clientIds,
    active,
    host: {
      async attachPluginSocket(_pluginId: string, socket: PluginSessionSocket) {
        const closed = new Promise<void>((resolve) => socket.once("close", resolve));
        active.add(socket);
        socket.once("close", () => active.delete(socket));
        socket.on("message", (data) => {
          if (typeof data !== "string") return;
          const message = JSON.parse(data);
          if (message.type !== "hello") return;
          clientIds.push(message.clientId);
          socket.send(
            JSON.stringify({
              type: "session",
              message: {
                type: "status",
                payload: {
                  status: "server_info",
                  serverId: "in-process-test",
                  hostname: "in-process-test",
                  version: "0.4.0",
                  features: {},
                },
              },
            }),
          );
        });
        return { closed };
      },
    },
  };
}

function createRuntime(sessions = createSessionHost()) {
  return {
    sessions,
    runtime: new PluginRuntime(pino({ level: "silent" }), "0.4.0", { sessionHost: sessions.host }),
  };
}

const echoPlugin = (marker: string) => `
import { z } from "zod";
import { definePluginRpc } from "@getpaseo/plugin";
const state = { marker: ${JSON.stringify(marker)}, count: 0 };
export default function contribute(plugin: any) {
  plugin.handle({
    name: "echo",
    input: z.object({ value: z.string() }),
    output: z.object({ value: z.string(), count: z.number(), marker: z.string() }),
  }, ({ value }: { value: string }) => ({ value, count: ++state.count, marker: state.marker }));
  return () => undefined;
}
`;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("PluginRuntime in-process plugins", () => {
  it("serves an RPC from the daemon process under the plugin:<id> session identity", async () => {
    const directory = await createPlugin("inproc", echoPlugin("a"));
    const { runtime, sessions } = createRuntime();

    await runtime.startPlugin("inproc", directory, () => true, { runtime: "in-process" });

    await expect(runtime.invoke("inproc", "echo", { value: "hi" })).resolves.toEqual({
      value: "hi",
      count: 1,
      marker: "a",
    });
    expect(sessions.clientIds).toEqual(["plugin:inproc"]);
    expect(runtime.catalog().map((plugin) => plugin.id)).toEqual(["inproc"]);
    await runtime.stopAll();
    expect(sessions.active.size).toBe(0);
  });

  it("re-evaluates the module on reload and drops the old module state", async () => {
    const directory = await createPlugin("reloaded", echoPlugin("old"));
    const { runtime } = createRuntime();
    await runtime.startPlugin("reloaded", directory, () => true, { runtime: "in-process" });
    await runtime.invoke("reloaded", "echo", { value: "x" });
    await runtime.invoke("reloaded", "echo", { value: "x" });

    await runtime.stopPluginById("reloaded");
    await writeFile(path.join(directory, "index.server.ts"), echoPlugin("new"), "utf8");
    await runtime.startPlugin("reloaded", directory, () => true, { runtime: "in-process" });

    await expect(runtime.invoke("reloaded", "echo", { value: "x" })).resolves.toMatchObject({
      count: 1,
      marker: "new",
    });
    await runtime.stopAll();
  });

  it("stops the plugin on disable: runs its cleanup, clears its timers, closes its session", async () => {
    const directory = await createPlugin(
      "stoppable",
      `export default function contribute(plugin: any) {
  void plugin;
  setInterval(() => console.log("tick"), 5);
  return () => { console.log("cleanup ran"); };
}`,
    );
    const { runtime, sessions } = createRuntime();
    await runtime.startPlugin("stoppable", directory, () => true, { runtime: "in-process" });
    await expect
      .poll(() => runtime.getLogs("stoppable").map((entry) => entry.message))
      .toContain("tick");

    await runtime.stopPluginById("stoppable");
    const logged = runtime.getLogs("stoppable").length;
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(runtime.getLogs("stoppable").map((entry) => entry.message)).toContain("cleanup ran");
    expect(runtime.getLogs("stoppable")).toHaveLength(logged);
    expect(runtime.catalog()).toEqual([]);
    expect(sessions.active.size).toBe(0);
    await expect(runtime.invoke("stoppable", "echo", {})).rejects.toThrow(
      "Plugin is not available",
    );
  });

  it("attributes console output to the plugin log", async () => {
    const directory = await createPlugin(
      "chatty",
      `export default function contribute(plugin: any) {
  void plugin;
  console.log("hello from plugin");
  console.error("problem from plugin");
  return () => undefined;
}`,
    );
    const { runtime } = createRuntime();
    await runtime.startPlugin("chatty", directory, () => true, { runtime: "in-process" });
    await runtime.stopAll();

    const logs = runtime.getLogs("chatty").filter((entry) => !entry.message.startsWith("[paseo]"));
    expect(logs.map(({ stream, message }) => ({ stream, message }))).toEqual([
      { stream: "stdout", message: "hello from plugin" },
      { stream: "stderr", message: "problem from plugin" },
    ]);
  });

  it("fails a plugin that throws while starting without throwing into the daemon", async () => {
    const directory = await createPlugin(
      "throws-on-start",
      `export default function contribute(plugin: any) { void plugin; throw new Error("boom on start"); }`,
    );
    const { runtime, sessions } = createRuntime();

    await expect(
      runtime.startPlugin("throws-on-start", directory, () => true, { runtime: "in-process" }),
    ).rejects.toThrow("boom on start");
    expect(runtime.catalog()).toEqual([]);
    expect(sessions.active.size).toBe(0);
  });

  it("fails a plugin whose module throws while evaluating", async () => {
    const directory = await createPlugin(
      "throws-on-load",
      `throw new Error("boom on load");\nexport default function contribute() { return () => undefined; }`,
    );
    const { runtime } = createRuntime();
    await expect(
      runtime.startPlugin("throws-on-load", directory, () => true, { runtime: "in-process" }),
    ).rejects.toThrow("boom on load");
  });

  it("returns a handler error to the caller and keeps the plugin running", async () => {
    const directory = await createPlugin(
      "bad-handler",
      `import { z } from "zod";
export default function contribute(plugin: any) {
  plugin.handle({ name: "fail", input: z.object({}), output: z.object({}) }, () => { throw new Error("handler broke"); });
  return () => undefined;
}`,
    );
    const { runtime } = createRuntime();
    await runtime.startPlugin("bad-handler", directory, () => true, { runtime: "in-process" });

    await expect(runtime.invoke("bad-handler", "fail", {})).rejects.toThrow("handler broke");
    expect(runtime.catalog().map((plugin) => plugin.id)).toEqual(["bad-handler"]);
    await runtime.stopAll();
  });

  it("marks a plugin failed when a timer callback throws and leaves the daemon running", async () => {
    const directory = await createPlugin(
      "bad-timer",
      `export default function contribute(plugin: any) {
  void plugin;
  setTimeout(() => { throw new Error("timer broke"); }, 10);
  return () => undefined;
}`,
    );
    const { runtime, sessions } = createRuntime();
    const failed = new Promise<string>((resolve) => {
      runtime.subscribe((pluginId, error) => {
        if (pluginId === "bad-timer" && error) resolve(error);
      });
    });
    await runtime.startPlugin("bad-timer", directory, () => true, { runtime: "in-process" });

    await expect(failed).resolves.toBe("Plugin process exited: bad-timer");
    expect(runtime.catalog()).toEqual([]);
    expect(
      runtime.getLogs("bad-timer").some((entry) => entry.message.includes("timer broke")),
    ).toBe(true);
    expect(sessions.active.size).toBe(0);
  });

  it("turns process.exit() in plugin code into a plugin failure, not a daemon exit", async () => {
    const directory = await createPlugin(
      "exiting",
      `import { z } from "zod";
export default function contribute(plugin: any) {
  plugin.handle({ name: "quit", input: z.object({}), output: z.object({}) }, () => { process.exit(3); });
  return () => undefined;
}`,
    );
    const { runtime } = createRuntime();
    await runtime.startPlugin("exiting", directory, () => true, { runtime: "in-process" });

    await expect(runtime.invoke("exiting", "quit", {})).rejects.toThrow("process.exit(3)");
    await runtime.stopAll();
  });

  it("keeps the subprocess runtime by default", async () => {
    const directory = await createPlugin(
      "sub",
      `import { z } from "zod";
export default function contribute(plugin: any) {
  plugin.handle({ name: "pid", input: z.object({}), output: z.object({ pid: z.number() }) }, () => ({ pid: process.pid }));
  return () => undefined;
}`,
    );
    const { runtime } = createRuntime();
    await runtime.startPlugin("sub", directory);

    const output = (await runtime.invoke("sub", "pid", {})) as { pid: number };
    expect(output.pid).not.toBe(process.pid);
    await runtime.stopAll();

    const explicit = createRuntime().runtime;
    await explicit.startPlugin("sub", directory, () => true, { runtime: "subprocess" });
    expect(((await explicit.invoke("sub", "pid", {})) as { pid: number }).pid).not.toBe(
      process.pid,
    );
    await explicit.stopAll();
  });
});
