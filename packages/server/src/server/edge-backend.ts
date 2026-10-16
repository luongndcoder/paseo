// Contract between the Rust edge (`paseod`) and the TS daemon when `PASEO_EDGE=rust`.
// Mirrors `paseo-rs/wip/paseod/src/internal.rs`; change both together.
//
// Roles:
// - supervisor: sees `PASEO_EDGE=rust`, spawns `paseod` instead of the worker.
// - worker: sees `PASEO_EDGE_TOKEN` (set by paseod), binds only a loopback port and
//   trusts `x-paseo-edge-*` headers only from requests carrying that token.
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import type { IncomingHttpHeaders } from "node:http";
import type { Readable } from "node:stream";

export const ENV_EDGE_MODE = "PASEO_EDGE";
export const ENV_EDGE_BIN = "PASEO_EDGE_BIN";
export const ENV_EDGE_BACKEND_CMD = "PASEO_EDGE_BACKEND_CMD";
export const ENV_EDGE_TOKEN = "PASEO_EDGE_TOKEN";
export const ENV_EDGE_PUBLIC_LISTEN = "PASEO_EDGE_PUBLIC_LISTEN";

export const HEADER_EDGE_TOKEN = "x-paseo-edge-token";
export const HEADER_EDGE_TRANSPORT = "x-paseo-edge-transport";
export const HEADER_EDGE_REMOTE_ADDR = "x-paseo-edge-remote-addr";
export const HEADER_EDGE_CONNECTION_ID = "x-paseo-edge-connection-id";

export const EDGE_LIFECYCLE_PREFIX = "@@paseo ";

export interface EdgeBackendConfig {
  token: string;
  /** Public listen string of the edge (same grammar as PASEO_LISTEN), or null when unknown. */
  publicListen: string | null;
}

export class EdgeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EdgeConfigError";
  }
}

// ---------------------------------------------------------------------------
// Supervisor side
// ---------------------------------------------------------------------------

export function isRustEdgeRequested(env: NodeJS.ProcessEnv): boolean {
  const raw = env[ENV_EDGE_MODE]?.trim().toLowerCase();
  if (!raw || raw === "off" || raw === "none" || raw === "ts") {
    return false;
  }
  if (raw === "rust") {
    return true;
  }
  throw new EdgeConfigError(
    `Invalid ${ENV_EDGE_MODE}="${env[ENV_EDGE_MODE]}". Use "rust" or unset.`,
  );
}

export function edgeBinaryName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "paseod.exe" : "paseod";
}

interface ResolveEdgeBinaryInput {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  arch: string;
  /** Directories that may contain `<platform>-<arch>/paseod`, in priority order. */
  binRoots: string[];
  exists?: (candidate: string) => boolean;
}

export function resolveEdgeBinary(input: ResolveEdgeBinaryInput): string {
  const exists = input.exists ?? existsSync;
  const override = input.env[ENV_EDGE_BIN]?.trim();
  if (override) {
    if (!exists(override)) {
      throw new EdgeConfigError(`${ENV_EDGE_BIN} points to a missing file: ${override}`);
    }
    return override;
  }

  const candidates = input.binRoots.map((root) =>
    path.join(root, `${input.platform}-${input.arch}`, edgeBinaryName(input.platform)),
  );
  const found = candidates.find((candidate) => exists(candidate));
  if (!found) {
    throw new EdgeConfigError(
      `${ENV_EDGE_MODE}=rust but the paseod binary was not found. Set ${ENV_EDGE_BIN} or build it to one of: ${candidates.join(", ")}`,
    );
  }
  return found;
}

export interface EdgeSpawnSpec {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

interface BuildEdgeSpawnSpecInput {
  binary: string;
  /** How paseod must launch the TS worker. */
  worker: { command: string; args: string[] };
  env: NodeJS.ProcessEnv;
}

export function buildEdgeSpawnSpec(input: BuildEdgeSpawnSpecInput): EdgeSpawnSpec {
  const env: NodeJS.ProcessEnv = { ...input.env };
  // Stale values would leak into the next worker; paseod generates its own.
  delete env[ENV_EDGE_TOKEN];
  delete env[ENV_EDGE_PUBLIC_LISTEN];
  env[ENV_EDGE_BACKEND_CMD] = JSON.stringify([input.worker.command, ...input.worker.args]);
  return { command: input.binary, args: [], env };
}

// ---------------------------------------------------------------------------
// Lifecycle lines (worker -> edge -> supervisor), JSONL on stdout instead of Node IPC
// ---------------------------------------------------------------------------

export function formatEdgeLifecycleLine(message: object): string {
  return `${EDGE_LIFECYCLE_PREFIX}${JSON.stringify(message)}\n`;
}

/** Returns the parsed JSON payload, or null for ordinary log output. */
export function parseEdgeLifecycleLine(line: string): unknown {
  if (!line.startsWith(EDGE_LIFECYCLE_PREFIX)) {
    return null;
  }
  try {
    return JSON.parse(line.slice(EDGE_LIFECYCLE_PREFIX.length).trim());
  } catch {
    return null;
  }
}

/** Splits a stream of chunks into lines, keeping a partial tail between chunks. */
export function createLineSplitter(onLine: (line: string) => void): {
  push(chunk: Buffer | string): void;
  flush(): void;
} {
  let tail = "";
  return {
    push(chunk) {
      tail += chunk.toString();
      let index = tail.indexOf("\n");
      while (index !== -1) {
        onLine(tail.slice(0, index).replace(/\r$/, ""));
        tail = tail.slice(index + 1);
        index = tail.indexOf("\n");
      }
    },
    flush() {
      if (tail.length > 0) {
        onLine(tail);
        tail = "";
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Worker side
// ---------------------------------------------------------------------------

export function readEdgeBackendConfig(env: NodeJS.ProcessEnv): EdgeBackendConfig | null {
  const token = env[ENV_EDGE_TOKEN]?.trim();
  if (!token) {
    return null;
  }
  const publicListen = env[ENV_EDGE_PUBLIC_LISTEN]?.trim();
  return { token, publicListen: publicListen ? publicListen : null };
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

function splitHostPort(listen: string): { host: string; port: number } | null {
  const idx = listen.lastIndexOf(":");
  if (idx <= 0) {
    return null;
  }
  const rawHost = listen.slice(0, idx);
  const host = rawHost.startsWith("[") && rawHost.endsWith("]") ? rawHost.slice(1, -1) : rawHost;
  const port = Number(listen.slice(idx + 1));
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    return null;
  }
  return { host, port };
}

export interface EdgeBackendDaemonConfigPatch {
  listen: string;
  corsAllowedOrigins: string[];
  relayEnabled: false;
  relayEnabledMutable: false;
  edgeBackend: EdgeBackendConfig;
}

/**
 * Validates and derives the worker config in edge mode. The edge always sets
 * PASEO_LISTEN to an ephemeral loopback port; anything else is a wiring error and
 * fails loudly instead of binding a second public socket.
 */
export function resolveEdgeBackendConfigPatch(input: {
  env: NodeJS.ProcessEnv;
  edge: EdgeBackendConfig;
  corsAllowedOrigins: string[];
}): EdgeBackendDaemonConfigPatch {
  const listen = input.env.PASEO_LISTEN?.trim();
  if (!listen) {
    throw new EdgeConfigError(
      `${ENV_EDGE_TOKEN} is set but PASEO_LISTEN (internal port) is missing`,
    );
  }
  const parsed = splitHostPort(listen);
  if (!parsed || !LOOPBACK_HOSTS.has(parsed.host)) {
    throw new EdgeConfigError(
      `Edge backend must bind a loopback TCP address, got PASEO_LISTEN=${listen}`,
    );
  }
  if (input.edge.publicListen === listen) {
    throw new EdgeConfigError(
      `Internal listen ${listen} equals ${ENV_EDGE_PUBLIC_LISTEN}; the edge owns the public port`,
    );
  }
  return {
    listen,
    corsAllowedOrigins: [
      ...new Set([...input.corsAllowedOrigins, ...publicOriginsFor(input.edge.publicListen)]),
    ],
    relayEnabled: false,
    relayEnabledMutable: false,
    edgeBackend: input.edge,
  };
}

/** CORS origins a browser would use against the edge's public TCP port. */
export function publicOriginsFor(publicListen: string | null): string[] {
  if (!publicListen) {
    return [];
  }
  const parsed = splitHostPort(publicListen);
  if (!parsed) {
    return [];
  }
  const hosts = new Set(["localhost", "127.0.0.1"]);
  if (parsed.host !== "0.0.0.0" && parsed.host !== "::") {
    hosts.add(parsed.host.includes(":") ? `[${parsed.host}]` : parsed.host);
  }
  return [...hosts].map((host) => `http://${host}:${parsed.port}`);
}

export function isEdgeTokenValid(provided: string | undefined, expected: string): boolean {
  if (!provided) {
    return false;
  }
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export interface EdgeConnectionIdentity {
  transport: "direct" | "relay";
  /** Real client IP without port, when forwarded. */
  remoteAddress?: string;
  relayConnectionId?: string;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function parseEdgeRemoteAddress(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end > 1 ? trimmed.slice(1, end) : undefined;
  }
  const colons = trimmed.split(":").length - 1;
  if (colons === 1) {
    return trimmed.slice(0, trimmed.indexOf(":")) || undefined;
  }
  // Bare IPv6 without port, or a bare IPv4.
  return trimmed;
}

/**
 * Identity forwarded by the edge, or null when the request did not come through it.
 * Headers are honoured only with a matching token, so a direct client cannot forge them.
 */
export function resolveEdgeConnectionIdentity(
  headers: IncomingHttpHeaders,
  edge: EdgeBackendConfig | null,
): EdgeConnectionIdentity | null {
  if (!edge || !isEdgeTokenValid(firstHeader(headers[HEADER_EDGE_TOKEN]), edge.token)) {
    return null;
  }
  const transport =
    firstHeader(headers[HEADER_EDGE_TRANSPORT])?.trim() === "relay" ? "relay" : "direct";
  const remoteAddress = parseEdgeRemoteAddress(firstHeader(headers[HEADER_EDGE_REMOTE_ADDR]));
  const relayConnectionId = firstHeader(headers[HEADER_EDGE_CONNECTION_ID])?.trim();
  return {
    transport,
    ...(remoteAddress ? { remoteAddress } : {}),
    ...(relayConnectionId ? { relayConnectionId } : {}),
  };
}

/**
 * Worker parent liveness without Node IPC: the edge holds our stdin pipe. EOF means the
 * edge is gone. A `paseo:graceful-shutdown` line asks for a clean stop (Windows has no SIGTERM).
 */
export function watchEdgeParent(options: {
  stdin: Readable;
  onParentLost: () => void;
  onGracefulShutdown: (reason: string) => void;
}): void {
  const splitter = createLineSplitter((line) => {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (
      typeof message === "object" &&
      message !== null &&
      (message as { type?: unknown }).type === "paseo:graceful-shutdown"
    ) {
      const reason = (message as { reason?: unknown }).reason;
      options.onGracefulShutdown(typeof reason === "string" ? reason : "edge_requested_shutdown");
    }
  });
  options.stdin.on("data", (chunk) => splitter.push(chunk));
  options.stdin.on("end", () => options.onParentLost());
  options.stdin.on("close", () => options.onParentLost());
  options.stdin.on("error", () => options.onParentLost());
}
