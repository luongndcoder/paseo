import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import {
  buildEdgeSpawnSpec,
  createLineSplitter,
  EdgeConfigError,
  formatEdgeLifecycleLine,
  isEdgeTokenValid,
  isRustEdgeRequested,
  parseEdgeLifecycleLine,
  parseEdgeRemoteAddress,
  publicOriginsFor,
  readEdgeBackendConfig,
  scrubEdgeEnv,
  resolveEdgeBackendConfigPatch,
  resolveEdgeBinary,
  resolveEdgeConnectionIdentity,
  watchEdgeParent,
} from "./edge-backend.js";

describe("isRustEdgeRequested", () => {
  test("is off by default and for explicit off values", () => {
    expect(isRustEdgeRequested({})).toBe(false);
    expect(isRustEdgeRequested({ PASEO_EDGE: "" })).toBe(false);
    expect(isRustEdgeRequested({ PASEO_EDGE: "off" })).toBe(false);
  });

  test("is on for rust, case-insensitive", () => {
    expect(isRustEdgeRequested({ PASEO_EDGE: "rust" })).toBe(true);
    expect(isRustEdgeRequested({ PASEO_EDGE: " Rust " })).toBe(true);
  });

  test("rejects unknown values instead of silently running without the edge", () => {
    expect(() => isRustEdgeRequested({ PASEO_EDGE: "go" })).toThrow(EdgeConfigError);
  });
});

describe("resolveEdgeBinary", () => {
  const binRoots = ["/pkg/dist/bin", "/pkg/bin"];

  test("PASEO_EDGE_BIN wins when it exists", () => {
    const found = resolveEdgeBinary({
      env: { PASEO_EDGE_BIN: "/custom/paseod" },
      platform: "linux",
      arch: "x64",
      binRoots,
      exists: (p) => p === "/custom/paseod",
    });
    expect(found).toBe("/custom/paseod");
  });

  test("PASEO_EDGE_BIN pointing nowhere is an error, not a fallback to dist/bin", () => {
    expect(() =>
      resolveEdgeBinary({
        env: { PASEO_EDGE_BIN: "/custom/paseod" },
        platform: "linux",
        arch: "x64",
        binRoots,
        exists: (p) => p !== "/custom/paseod",
      }),
    ).toThrow(/PASEO_EDGE_BIN points to a missing file: \/custom\/paseod/);
  });

  test("falls back to dist/bin/<platform>-<arch>/paseod, first root wins", () => {
    const expected = path.join("/pkg/dist/bin", "darwin-arm64", "paseod");
    const found = resolveEdgeBinary({
      env: {},
      platform: "darwin",
      arch: "arm64",
      binRoots,
      exists: () => true,
    });
    expect(found).toBe(expected);
  });

  test("uses paseod.exe on Windows", () => {
    const found = resolveEdgeBinary({
      env: {},
      platform: "win32",
      arch: "x64",
      binRoots: ["/pkg/dist/bin"],
      exists: () => true,
    });
    expect(path.basename(found)).toBe("paseod.exe");
  });

  test("missing binary names every searched path", () => {
    expect(() =>
      resolveEdgeBinary({ env: {}, platform: "linux", arch: "x64", binRoots, exists: () => false }),
    ).toThrow(/paseod binary was not found.*dist\/bin\/linux-x64\/paseod.*bin\/linux-x64\/paseod/);
  });
});

describe("buildEdgeSpawnSpec", () => {
  test("spawns paseod and hands it the worker argv as JSON", () => {
    const spec = buildEdgeSpawnSpec({
      binary: "/bin/paseod",
      worker: { command: "/usr/bin/node", args: ["--import", "tsx", "worker.ts", "--no-mcp"] },
      env: { PASEO_HOME: "/h", PASEO_EDGE_TOKEN: "stale", PASEO_EDGE_PUBLIC_LISTEN: "stale" },
    });
    expect(spec.command).toBe("/bin/paseod");
    expect(spec.args).toEqual([]);
    expect(JSON.parse(spec.env.PASEO_EDGE_BACKEND_CMD ?? "")).toEqual([
      "/usr/bin/node",
      "--import",
      "tsx",
      "worker.ts",
      "--no-mcp",
    ]);
    expect(spec.env.PASEO_HOME).toBe("/h");
    expect(spec.env.PASEO_EDGE_TOKEN).toBeUndefined();
    expect(spec.env.PASEO_EDGE_PUBLIC_LISTEN).toBeUndefined();
    // paseod watches the supervisor's stdin pipe for liveness.
    expect(spec.env.PASEO_EDGE_PARENT_STDIN).toBe("1");
  });
});

describe("lifecycle lines", () => {
  test("round-trips a ready message", () => {
    const message = { type: "paseo:ready", listen: "127.0.0.1:1", serverId: "s" };
    const line = formatEdgeLifecycleLine(message);
    expect(line.endsWith("\n")).toBe(true);
    expect(parseEdgeLifecycleLine(line.trimEnd())).toEqual(message);
  });

  test("ordinary log lines and malformed payloads are not lifecycle events", () => {
    expect(parseEdgeLifecycleLine('{"level":30}')).toBeNull();
    expect(parseEdgeLifecycleLine("@@paseo not-json")).toBeNull();
  });

  test("line splitter joins chunks and flushes the tail", () => {
    const lines: string[] = [];
    const splitter = createLineSplitter((line) => lines.push(line));
    splitter.push("ab");
    splitter.push("c\r\nde");
    splitter.push("f\ng");
    expect(lines).toEqual(["abc", "def"]);
    splitter.flush();
    expect(lines).toEqual(["abc", "def", "g"]);
  });
});

describe("readEdgeBackendConfig", () => {
  test("is null without a token", () => {
    expect(readEdgeBackendConfig({})).toBeNull();
    expect(readEdgeBackendConfig({ PASEO_EDGE_TOKEN: "  " })).toBeNull();
  });

  test("reads token and public listen", () => {
    expect(
      readEdgeBackendConfig({ PASEO_EDGE_TOKEN: "t", PASEO_EDGE_PUBLIC_LISTEN: "0.0.0.0:6767" }),
    ).toEqual({ token: "t", publicListen: "0.0.0.0:6767" });
    expect(readEdgeBackendConfig({ PASEO_EDGE_TOKEN: "t" })).toEqual({
      token: "t",
      publicListen: null,
    });
  });
});

describe("scrubEdgeEnv", () => {
  test("removes the token, public listen and backend command", () => {
    const env: NodeJS.ProcessEnv = {
      PASEO_EDGE_TOKEN: "t",
      PASEO_EDGE_PUBLIC_LISTEN: "0.0.0.0:6767",
      PASEO_EDGE_BACKEND_CMD: "[]",
      PASEO_LISTEN: "127.0.0.1:1",
    };
    scrubEdgeEnv(env);
    expect(env).toEqual({ PASEO_LISTEN: "127.0.0.1:1" });
  });
});

describe("resolveEdgeBackendConfigPatch", () => {
  const edge = { token: "t", publicListen: "127.0.0.1:6767" };

  test("keeps the internal loopback listen and leaves relay config alone", () => {
    const patch = resolveEdgeBackendConfigPatch({
      env: { PASEO_LISTEN: "127.0.0.1:41000" },
      edge,
      corsAllowedOrigins: ["https://app.example"],
    });
    expect(patch.listen).toBe("127.0.0.1:41000");
    expect(patch).not.toHaveProperty("relayEnabled");
    expect(patch.edgeBackend).toBe(edge);
  });

  test("adds the public origins to CORS without duplicates", () => {
    const patch = resolveEdgeBackendConfigPatch({
      env: { PASEO_LISTEN: "127.0.0.1:41000" },
      edge,
      corsAllowedOrigins: ["http://localhost:6767"],
    });
    expect(patch.corsAllowedOrigins).toEqual(["http://localhost:6767", "http://127.0.0.1:6767"]);
  });

  test("rejects a missing internal listen", () => {
    expect(() => resolveEdgeBackendConfigPatch({ env: {}, edge, corsAllowedOrigins: [] })).toThrow(
      /PASEO_LISTEN/,
    );
  });

  test.each(["0.0.0.0:41000", "/tmp/paseo.sock", "example.com:41000", "127.0.0.1:99999"])(
    "rejects non-loopback internal listen %s",
    (listen) => {
      expect(() =>
        resolveEdgeBackendConfigPatch({
          env: { PASEO_LISTEN: listen },
          edge,
          corsAllowedOrigins: [],
        }),
      ).toThrow(EdgeConfigError);
    },
  );

  test("rejects an internal listen equal to the public one", () => {
    expect(() =>
      resolveEdgeBackendConfigPatch({
        env: { PASEO_LISTEN: "127.0.0.1:6767" },
        edge,
        corsAllowedOrigins: [],
      }),
    ).toThrow(/edge owns the public port/);
  });
});

describe("publicOriginsFor", () => {
  test("derives loopback and named-host origins", () => {
    expect(publicOriginsFor("192.168.1.5:6767")).toEqual([
      "http://localhost:6767",
      "http://127.0.0.1:6767",
      "http://192.168.1.5:6767",
    ]);
  });

  test("wildcard binds do not become origins; unix sockets have none", () => {
    expect(publicOriginsFor("0.0.0.0:7000")).toEqual([
      "http://localhost:7000",
      "http://127.0.0.1:7000",
    ]);
    expect(publicOriginsFor("/tmp/paseo.sock")).toEqual([]);
    expect(publicOriginsFor(null)).toEqual([]);
  });
});

describe("edge identity", () => {
  const edge = { token: "secret", publicListen: null };

  test("token comparison", () => {
    expect(isEdgeTokenValid("secret", "secret")).toBe(true);
    expect(isEdgeTokenValid("secreT", "secret")).toBe(false);
    expect(isEdgeTokenValid(undefined, "secret")).toBe(false);
  });

  test("forwarded headers are honoured with a matching token", () => {
    expect(
      resolveEdgeConnectionIdentity(
        {
          "x-paseo-edge-token": "secret",
          "x-paseo-edge-transport": "relay",
          "x-paseo-edge-remote-addr": "203.0.113.9:51234",
          "x-paseo-edge-connection-id": "c1",
        },
        edge,
      ),
    ).toEqual({ transport: "relay", remoteAddress: "203.0.113.9", relayConnectionId: "c1" });
  });

  test("forged headers without the token are ignored", () => {
    const headers = {
      "x-paseo-edge-transport": "relay",
      "x-paseo-edge-remote-addr": "203.0.113.9:1",
    };
    expect(resolveEdgeConnectionIdentity(headers, edge)).toBeNull();
    expect(
      resolveEdgeConnectionIdentity({ ...headers, "x-paseo-edge-token": "wrong" }, edge),
    ).toBeNull();
  });

  test("outside edge mode nothing is honoured", () => {
    expect(resolveEdgeConnectionIdentity({ "x-paseo-edge-token": "secret" }, null)).toBeNull();
  });

  test("defaults to the direct transport", () => {
    expect(resolveEdgeConnectionIdentity({ "x-paseo-edge-token": "secret" }, edge)).toEqual({
      transport: "direct",
    });
  });

  test.each([
    ["1.2.3.4:80", "1.2.3.4"],
    ["[::1]:80", "::1"],
    ["2001:db8::1", "2001:db8::1"],
    ["1.2.3.4", "1.2.3.4"],
    ["", undefined],
  ])("parses remote address %s", (input, expected) => {
    expect(parseEdgeRemoteAddress(input)).toBe(expected);
  });
});

describe("watchEdgeParent", () => {
  test("stdin EOF means the edge is gone", () => {
    const stdin = new PassThrough();
    const onParentLost = vi.fn();
    watchEdgeParent({ stdin, onParentLost, onGracefulShutdown: vi.fn() });
    stdin.end();
    return vi.waitFor(() => expect(onParentLost).toHaveBeenCalled());
  });

  test("a graceful-shutdown line requests a clean stop with its reason", () => {
    const stdin = new PassThrough();
    const onGracefulShutdown = vi.fn();
    watchEdgeParent({ stdin, onParentLost: vi.fn(), onGracefulShutdown });
    stdin.write('{"type":"paseo:graceful-shutdown","reason":"restart"}\n');
    return vi.waitFor(() => expect(onGracefulShutdown).toHaveBeenCalledWith("restart"));
  });

  test("unrelated stdin lines are ignored", async () => {
    const stdin = new PassThrough();
    const onGracefulShutdown = vi.fn();
    watchEdgeParent({ stdin, onParentLost: vi.fn(), onGracefulShutdown });
    stdin.write("garbage\n");
    stdin.write('{"type":"other"}\n');
    await new Promise((resolve) => setImmediate(resolve));
    expect(onGracefulShutdown).not.toHaveBeenCalled();
  });
});
