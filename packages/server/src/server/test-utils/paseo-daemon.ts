import { BuiltinPluginLoader } from "../plugins/builtin/index.js";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import net from "node:net";

import pino from "pino";
import {
  createPaseoDaemon,
  type PaseoDaemonConfig,
  type PaseoOpenAIConfig,
  type PaseoSpeechConfig,
} from "../bootstrap.js";
import type { AgentClient, AgentProvider } from "../agent/agent-sdk-types.js";
import { createTestAgentClients } from "./fake-agent-client.js";
import type { PushNotificationSender } from "../push/index.js";
import type { AgentProfile } from "@getpaseo/protocol/messages";

interface TestPaseoDaemonOptions {
  daemonVersion?: string;
  desktopManaged?: boolean;
  downloadTokenTtlMs?: number;
  corsAllowedOrigins?: string[];
  listen?: string;
  listenPort?: number;
  logger?: Parameters<typeof createPaseoDaemon>[1];
  mcpEnabled?: boolean;
  mcpDebug?: boolean;
  isDev?: boolean;
  relayEnabled?: boolean;
  relayEndpoint?: string;
  relayUseTls?: boolean;
  relayPublicUseTls?: boolean;
  daemonStatusRpcCapability?: boolean;
  relayConfigCapability?: boolean;
  agentClients?: Partial<Record<AgentProvider, AgentClient>>;
  providerOverrides?: PaseoDaemonConfig["providerOverrides"];
  paseoHomeRoot?: string;
  staticDir?: string;
  cleanup?: boolean;
  openai?: PaseoOpenAIConfig;
  speech?: PaseoSpeechConfig;
  voiceLlmProvider?: PaseoDaemonConfig["voiceLlmProvider"];
  voiceLlmProviderExplicit?: boolean;
  voiceLlmModel?: string | null;
  dictationFinalTimeoutMs?: number;
  auth?: PaseoDaemonConfig["auth"];
  pushNotificationSender?: PushNotificationSender;
  serviceProxy?: PaseoDaemonConfig["serviceProxy"];
  webUi?: PaseoDaemonConfig["webUi"];
  trustedProxies?: PaseoDaemonConfig["trustedProxies"];
  agentProfiles?: AgentProfile[];
  autoArchiveAfterMerge?: boolean;
  pluginsEnabled?: PaseoDaemonConfig["pluginsEnabled"];
  builtinPlugins?: BuiltinPluginLoader;
  plugins?: PaseoDaemonConfig["plugins"];
}

export interface TestPaseoDaemon {
  config: PaseoDaemonConfig;
  daemon: Awaited<ReturnType<typeof createPaseoDaemon>>;
  port: number;
  paseoHome: string;
  staticDir: string;
  close: () => Promise<void>;
}

const TEST_DAEMON_START_TIMEOUT_MS = 20_000;

async function startDaemonWithTimeout(
  daemon: Awaited<ReturnType<typeof createPaseoDaemon>>,
  timeoutMs: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      const timeoutError = new Error(
        `Timed out starting test daemon after ${timeoutMs}ms`,
      ) as Error & { code?: string };
      timeoutError.code = "TEST_DAEMON_START_TIMEOUT";
      reject(timeoutError);
    }, timeoutMs);

    daemon.start().then(
      () => {
        clearTimeout(timeoutHandle);
        resolve();
        return;
      },
      (error) => {
        clearTimeout(timeoutHandle);
        reject(error);
      },
    );
  });
}

export async function createTestPaseoDaemon(
  options: TestPaseoDaemonOptions = {},
): Promise<TestPaseoDaemon> {
  const maxAttempts = 8;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const { config, paseoHomeRoot, paseoHome, staticDir, createdDirs } =
      await prepareTestDaemonConfig(options);
    const edgeSetup = await prepareEdge(config);
    const logger = options.logger ?? pino({ level: "silent" });
    const daemon = await createPaseoDaemon(config, logger, {
      builtinPlugins: options.builtinPlugins ?? new BuiltinPluginLoader(undefined, []),
      serverFeatureOverrides: {
        daemonStatusRpc: options.daemonStatusRpcCapability,
        relayConfig: options.relayConfigCapability,
      },
    });
    try {
      await startDaemonWithTimeout(daemon, TEST_DAEMON_START_TIMEOUT_MS);
      const listenTarget = daemon.getListenTarget();
      if (!listenTarget || listenTarget.type !== "tcp") {
        throw new Error("Test daemon did not expose a bound TCP listen target");
      }

      const edge = edgeSetup
        ? await startEdgeInFront({ edgeSetup, paseoHome, internalPort: listenTarget.port })
        : null;

      const close = async (): Promise<void> => {
        await edge?.stop();
        await daemon.stop().catch(() => undefined);
        await daemon.agentManager.flush().catch(() => undefined);
        if (options.cleanup ?? true) {
          await new Promise((r) => setTimeout(r, 50));
          await removeDirs([paseoHomeRoot, staticDir]);
        }
      };

      return {
        config,
        daemon,
        port: edge ? edge.port : listenTarget.port,
        paseoHome,
        staticDir,
        close,
      };
    } catch (error) {
      lastError = error;
      await daemon.stop().catch(() => undefined);
      // A failed attempt removes only what it created: a caller-supplied home keeps its serverId.
      await removeDirs(createdDirs);

      if (
        (!isAddressInUseError(error) && !isStartupTimeoutError(error)) ||
        attempt === maxAttempts - 1
      ) {
        throw error;
      }
    }
  }

  throw lastError ?? new Error("Failed to start test daemon");
}

interface PreparedTestDaemonConfig {
  config: PaseoDaemonConfig;
  paseoHomeRoot: string;
  paseoHome: string;
  staticDir: string;
  createdDirs: string[];
}

async function removeDirs(dirs: string[]): Promise<void> {
  await Promise.all(
    dirs.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })),
  );
}

async function createTempDir(prefix: string, createdDirs: string[]): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

async function prepareTestDaemonConfig(
  options: TestPaseoDaemonOptions,
): Promise<PreparedTestDaemonConfig> {
  const createdDirs: string[] = [];
  const paseoHomeRoot = options.paseoHomeRoot ?? (await createTempDir("paseo-home-", createdDirs));
  const paseoHome = path.join(paseoHomeRoot, ".paseo");
  await mkdir(paseoHome, { recursive: true });
  const staticDir = options.staticDir ?? (await createTempDir("paseo-static-", createdDirs));
  const listenHost = options.listen ?? "127.0.0.1";
  const listenPort = options.listenPort ?? 0;
  const config: PaseoDaemonConfig = {
    listen: `${listenHost}:${listenPort}`,
    paseoHome,
    daemonVersion: options.daemonVersion,
    desktopManaged: options.desktopManaged,
    corsAllowedOrigins: options.corsAllowedOrigins ?? [],
    hostnames: true,
    mcpEnabled: options.mcpEnabled ?? true,
    staticDir,
    mcpDebug: options.mcpDebug ?? false,
    isDev: options.isDev,
    agentClients: options.agentClients ?? createTestAgentClients(),
    providerOverrides: options.providerOverrides,
    agentStoragePath: path.join(paseoHome, "agents"),
    relayEnabled: options.relayEnabled ?? false,
    relayEndpoint: options.relayEndpoint ?? "relay.paseo.sh:443",
    relayUseTls: options.relayUseTls,
    relayPublicUseTls: options.relayPublicUseTls,
    appBaseUrl: "https://app.paseo.sh",
    auth: options.auth,
    pushNotificationSender: options.pushNotificationSender,
    serviceProxy: options.serviceProxy,
    webUi: options.webUi,
    trustedProxies: options.trustedProxies,
    openai: options.openai,
    speech: options.speech,
    voiceLlmProvider: options.voiceLlmProvider ?? null,
    voiceLlmProviderExplicit: options.voiceLlmProviderExplicit ?? false,
    voiceLlmModel: options.voiceLlmModel ?? null,
    dictationFinalTimeoutMs: options.dictationFinalTimeoutMs,
    downloadTokenTtlMs: options.downloadTokenTtlMs,
    agentProfiles: options.agentProfiles,
    autoArchiveAfterMerge: options.autoArchiveAfterMerge,
    pluginsEnabled: options.pluginsEnabled,
    plugins: options.plugins,
  };
  return { config, paseoHomeRoot, paseoHome, staticDir, createdDirs };
}

function isAddressInUseError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const record = error as { code?: string };
  return record.code === "EADDRINUSE";
}

function isStartupTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const record = error as { code?: string };
  return record.code === "TEST_DAEMON_START_TIMEOUT";
}

// ---------------------------------------------------------------------------
// Optional Rust edge in front of the in-process daemon (PASEO_EDGE=rust).
// Off by default; with the flag unset nothing above changes.
// ---------------------------------------------------------------------------

interface EdgeSetup {
  binary: string;
  token: string;
  publicPort: number;
}

async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function prepareEdge(config: PaseoDaemonConfig): Promise<EdgeSetup | null> {
  if (process.env.PASEO_EDGE?.trim().toLowerCase() !== "rust") {
    return null;
  }
  const binary = process.env.PASEO_EDGE_BIN;
  if (!binary) {
    throw new Error("PASEO_EDGE=rust requires PASEO_EDGE_BIN for the test daemon harness");
  }
  const publicPort = await pickFreePort();
  const token = randomBytes(24).toString("hex");
  // The in-process daemon keeps its ephemeral loopback listener as the internal port and
  // reports the edge's public address, exactly as the worker does behind paseod.
  config.edgeBackend = { token, publicListen: `127.0.0.1:${publicPort}` };
  config.relayEnabled = false;
  return { binary, token, publicPort };
}

async function startEdgeInFront(input: {
  edgeSetup: EdgeSetup;
  paseoHome: string;
  internalPort: number;
}): Promise<{ port: number; stop: () => Promise<void> }> {
  const { edgeSetup } = input;
  const child: ChildProcess = spawn(edgeSetup.binary, [], {
    env: {
      ...process.env,
      PASEO_HOME: input.paseoHome,
      PASEO_LISTEN: `127.0.0.1:${edgeSetup.publicPort}`,
      PASEO_EDGE_ATTACH: `127.0.0.1:${input.internalPort}`,
      PASEO_EDGE_TOKEN: edgeSetup.token,
      PASEO_RELAY_ENABLED: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    const exited = once(child, "exit");
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 3_000);
    child.kill("SIGTERM");
    await exited;
    clearTimeout(killTimer);
  };
  try {
    let stderr = "";
    let stdoutBuffer = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const ready = new Promise<void>((resolve) => {
      child.stdout?.on("data", (chunk: Buffer) => {
        stdoutBuffer += chunk.toString();
        if (stdoutBuffer.includes("paseo:ready")) {
          resolve();
        }
      });
    });
    const failed = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`paseod not ready: ${stderr}`)), 10_000);
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`paseod exited ${code} before ready: ${stderr}`));
      });
      void ready.then(() => clearTimeout(timer));
    });
    await Promise.race([ready, failed]);
  } catch (error) {
    await stop();
    throw error;
  }
  // Keep draining so the pipe never blocks the edge.
  child.stdout?.resume();
  child.stderr?.resume();
  return { port: edgeSetup.publicPort, stop };
}
