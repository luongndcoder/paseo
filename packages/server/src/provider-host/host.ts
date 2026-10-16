import type { Logger } from "pino";

import type {
  AgentClient,
  AgentLaunchContext,
  AgentPermissionResponse,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentRunOptions,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
  FetchCatalogOptions,
  ImportProviderSessionContext,
  ImportProviderSessionInput,
  ListImportableSessionsOptions,
  SteerActiveTurnOptions,
} from "../server/agent/agent-sdk-types.js";
import {
  buildProviderRegistry,
  shutdownAgentClients,
  type BuildProviderRegistryOptions,
  type ProviderDefinition,
} from "../server/agent/provider-registry.js";
import { OpenCodeBridge } from "../server/agent/providers/opencode/bridge.js";
import type { PaseoToolCatalog, PaseoToolResult } from "../server/agent/tools/types.js";
import {
  CANCEL_METHOD,
  HOST_LOG_METHOD,
  PROVIDER_HOST_PROTOCOL_VERSION,
  RpcError,
  RpcErrorCode,
  SESSION_CLOSED_METHOD,
  SESSION_EVENT_METHOD,
  TOOL_CALL_METHOD,
  type OutboundMessage,
  type RpcId,
} from "./protocol.js";
import { createProxyToolCatalog, type ToolSpec } from "./tool-proxy.js";

type Params = Record<string, unknown>;

interface CallContext {
  id: RpcId;
  signal: AbortSignal;
}

type Handler = (params: Params, ctx: CallContext) => Promise<unknown>;

interface SessionEntry {
  handle: string;
  provider: string;
  session: AgentSession;
  unsubscribe: () => void;
  seq: number;
}

export interface InitializeParams {
  protocolVersion?: number;
  isDev?: boolean;
  /** Restrict the registry to these provider ids. */
  providers?: string[];
  providerOverrides?: BuildProviderRegistryOptions["providerOverrides"];
  runtimeSettings?: BuildProviderRegistryOptions["runtimeSettings"];
  /**
   * Directory the host may write runtime files into (the OpenCode bridge plugin lands in
   * `<runtimeDir>/runtime/opencode`). The host never writes `$PASEO_HOME`. Without it the
   * OpenCode bridge is off and OpenCode sessions get no native Paseo tools.
   */
  runtimeDir?: string;
}

/** Host -> client request awaiting its response. */
interface OutboundRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export interface ProviderHostOptions {
  logger: Logger;
  send: (message: OutboundMessage) => void;
  /** Called after the `host.shutdown` response is written. */
  onShutdown?: () => void;
  /** Defaults from the environment (`PASEO_PROVIDER_HOST_DEV=1` enables dev-only providers). */
  defaults?: InitializeParams;
  buildRegistry?: (
    logger: Logger,
    options: BuildProviderRegistryOptions,
  ) => Record<string, ProviderDefinition>;
}

function asParams(value: unknown): Params {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new RpcError(RpcErrorCode.InvalidParams, "params must be an object");
  }
  return value as Params;
}

function str(params: Params, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new RpcError(RpcErrorCode.InvalidParams, `params.${key} must be a non-empty string`);
  }
  return value;
}

function obj<T>(params: Params, key: string): T {
  const value = params[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RpcError(RpcErrorCode.InvalidParams, `params.${key} must be an object`);
  }
  return value as T;
}

function optObj<T>(params: Params, key: string): T | undefined {
  return params[key] === undefined || params[key] === null ? undefined : obj<T>(params, key);
}

function prompt(params: Params): AgentPromptInput {
  const value = params.prompt;
  if (typeof value === "string" || Array.isArray(value)) return value as AgentPromptInput;
  throw new RpcError(
    RpcErrorCode.InvalidParams,
    "params.prompt must be a string or content block array",
  );
}

interface RpcErrorBodyLike {
  code?: unknown;
  message?: unknown;
  data?: unknown;
}

function toolSpecs(value: unknown[]): ToolSpec[] {
  return value.map((entry) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof (entry as ToolSpec).name !== "string" ||
      typeof (entry as ToolSpec).description !== "string"
    ) {
      throw new RpcError(
        RpcErrorCode.InvalidParams,
        "tool specs must be objects with name and description",
      );
    }
    return entry as ToolSpec;
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ProviderHost {
  private readonly logger: Logger;
  private readonly send: ProviderHostOptions["send"];
  private readonly buildRegistry: NonNullable<ProviderHostOptions["buildRegistry"]>;
  private init: InitializeParams;
  private registry: Record<string, ProviderDefinition> | null = null;
  private readonly clients = new Map<string, AgentClient>();
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly inflight = new Map<RpcId, AbortController>();
  private readonly pending = new Set<Promise<void>>();
  /** Sessions that finished creating after shutdown began and are being closed. */
  private readonly lateCloses = new Set<Promise<void>>();
  private readonly outbound = new Map<RpcId, OutboundRequest>();
  private nextOutboundId = 1;
  private bridge: OpenCodeBridge | null = null;
  private nextHandle = 1;
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | null = null;
  private readonly onShutdown: (() => void) | undefined;
  private readonly handlers: Record<string, Handler>;

  constructor(options: ProviderHostOptions) {
    this.logger = options.logger;
    this.send = options.send;
    this.onShutdown = options.onShutdown;
    this.buildRegistry = options.buildRegistry ?? buildProviderRegistry;
    this.init = options.defaults ?? {};
    this.handlers = this.createHandlers();
  }

  /** Feed one decoded JSON line. Never throws. */
  handleLine(line: string): void {
    if (line.trim().length === 0) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.send({ id: null, error: { code: RpcErrorCode.ParseError, message: messageOf(error) } });
      return;
    }
    this.handleMessage(message);
  }

  handleMessage(message: unknown): void {
    if (typeof message !== "object" || message === null || Array.isArray(message)) {
      this.send({
        id: null,
        error: { code: RpcErrorCode.InvalidRequest, message: "message must be an object" },
      });
      return;
    }
    const { id, method, params } = message as { id?: unknown; method?: unknown; params?: unknown };
    if (
      method === undefined &&
      (typeof id === "number" || typeof id === "string") &&
      ("result" in message || "error" in message)
    ) {
      this.handleClientResponse(id, message as { result?: unknown; error?: RpcErrorBodyLike });
      return;
    }
    if (typeof method !== "string") {
      this.send({
        id: null,
        error: { code: RpcErrorCode.InvalidRequest, message: "method must be a string" },
      });
      return;
    }
    if (id === undefined) {
      this.handleNotification(method, params);
      return;
    }
    if (typeof id !== "number" && typeof id !== "string") {
      this.send({
        id: null,
        error: { code: RpcErrorCode.InvalidRequest, message: "id must be number or string" },
      });
      return;
    }
    const task = this.dispatch(id, method, params);
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task));
  }

  /** Close every session, shut providers down, and wait for in-flight requests. */
  shutdown(waitForRequests = true): Promise<void> {
    this.shutdownPromise ??= this.runShutdown();
    return waitForRequests
      ? this.shutdownPromise
          .then(() => Promise.allSettled(this.pending))
          .then(() => Promise.allSettled(this.lateCloses))
          .then(() => undefined)
      : this.shutdownPromise;
  }

  private async runShutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const controller of this.inflight.values()) controller.abort();
    this.rejectOutbound(new RpcError(RpcErrorCode.ShuttingDown, "host is shutting down"));
    await this.closeAllSessions();
    await shutdownAgentClients(this.clients.values(), this.logger);
    await this.bridge?.close().catch((error: unknown) => {
      this.logger.warn({ err: error }, "OpenCode bridge close failed");
    });
  }

  /** Send a request to the client and wait for its response (`tool.call`). */
  requestClient(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.shuttingDown) {
      return Promise.reject(new RpcError(RpcErrorCode.ShuttingDown, "host is shutting down"));
    }
    const id = `h${this.nextOutboundId++}`;
    return new Promise<unknown>((resolve, reject) => {
      const onAbort = () => {
        if (!this.outbound.delete(id)) return;
        this.send({ method: CANCEL_METHOD, params: { id } });
        reject(new RpcError(RpcErrorCode.Canceled, "request canceled"));
      };
      const settle =
        <T>(fn: (value: T) => void) =>
        (value: T) => {
          signal?.removeEventListener("abort", onAbort);
          fn(value);
        };
      this.outbound.set(id, { resolve: settle(resolve), reject: settle(reject) });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      this.send({ id, method, params });
    });
  }

  private handleClientResponse(
    id: RpcId,
    message: { result?: unknown; error?: RpcErrorBodyLike },
  ): void {
    const pending = this.outbound.get(id);
    if (!pending) {
      this.logger.debug({ id }, "response for unknown or abandoned host request");
      return;
    }
    this.outbound.delete(id);
    if (message.error) {
      pending.reject(
        new RpcError(
          typeof message.error.code === "number" ? message.error.code : RpcErrorCode.Internal,
          typeof message.error.message === "string" ? message.error.message : "client error",
          message.error.data,
        ),
      );
      return;
    }
    pending.resolve(message.result ?? null);
  }

  private rejectOutbound(error: Error): void {
    for (const pending of this.outbound.values()) pending.reject(error);
    this.outbound.clear();
  }

  /** Log locally and forward warn/error to the client as `host.log`. */
  private hostLog(level: "warn" | "error", message: string, data?: Record<string, unknown>): void {
    this.logger[level](data ?? {}, message);
    this.send({ method: HOST_LOG_METHOD, params: { level, message, ...(data ? { data } : {}) } });
  }

  /** Catalog whose tools run in the client through `tool.call`. */
  private proxyCatalog(specs: ToolSpec[], agentId: string | undefined): PaseoToolCatalog {
    return createProxyToolCatalog(specs, async (tool, input, signal) => {
      try {
        return (await this.requestClient(
          TOOL_CALL_METHOD,
          { ...(agentId ? { agentId } : {}), tool, arguments: input ?? {} },
          signal,
        )) as PaseoToolResult;
      } catch (error) {
        if (!(error instanceof RpcError && error.code === RpcErrorCode.Canceled)) {
          this.hostLog("warn", "tool.call failed", { tool, error: messageOf(error) });
        }
        throw error;
      }
    });
  }

  /** Decode the wire `launchContext`: `paseoTools` specs become a proxy catalog. */
  private launchContext(params: Params): AgentLaunchContext | undefined {
    return this.hydrateLaunchContext(optObj<Record<string, unknown>>(params, "launchContext"));
  }

  private hydrateLaunchContext(
    raw: Record<string, unknown> | undefined,
  ): AgentLaunchContext | undefined {
    if (!raw) return undefined;
    const { paseoTools, ...rest } = raw;
    if (paseoTools === undefined || paseoTools === null) return rest as AgentLaunchContext;
    if (!Array.isArray(paseoTools)) {
      throw new RpcError(
        RpcErrorCode.InvalidParams,
        "params.launchContext.paseoTools must be an array",
      );
    }
    const agentId = typeof rest.agentId === "string" ? rest.agentId : undefined;
    return {
      ...rest,
      paseoTools: this.proxyCatalog(toolSpecs(paseoTools), agentId),
    } as AgentLaunchContext;
  }

  private handleNotification(method: string, params: unknown): void {
    if (method !== CANCEL_METHOD) {
      this.logger.debug({ method }, "ignoring unknown notification");
      return;
    }
    const id = (params as { id?: RpcId } | undefined)?.id;
    if (id === undefined) return;
    this.inflight.get(id)?.abort();
  }

  private async dispatch(id: RpcId, method: string, rawParams: unknown): Promise<void> {
    const handler = this.handlers[method];
    if (!handler) {
      this.send({
        id,
        error: { code: RpcErrorCode.MethodNotFound, message: `unknown method ${method}` },
      });
      return;
    }
    if (this.shuttingDown && method !== "host.shutdown") {
      this.send({
        id,
        error: { code: RpcErrorCode.ShuttingDown, message: "host is shutting down" },
      });
      return;
    }
    const controller = new AbortController();
    this.inflight.set(id, controller);
    try {
      const result = await handler(asParams(rawParams), { id, signal: controller.signal });
      this.send({ id, result: result === undefined ? null : result });
    } catch (error) {
      this.send({ id, error: this.toErrorBody(error, controller.signal) });
    } finally {
      this.inflight.delete(id);
    }
  }

  private toErrorBody(error: unknown, signal: AbortSignal) {
    if (error instanceof RpcError) {
      return { code: error.code, message: error.message, data: error.data };
    }
    if (signal.aborted) {
      return { code: RpcErrorCode.Canceled, message: "request canceled" };
    }
    return { code: RpcErrorCode.Provider, message: messageOf(error) };
  }

  private getRegistry(): Record<string, ProviderDefinition> {
    if (this.registry) return this.registry;
    const isDev = this.init.isDev ?? process.env.PASEO_PROVIDER_HOST_DEV === "1";
    const full = this.buildRegistry(this.logger, {
      isDev,
      providerOverrides: this.init.providerOverrides,
      runtimeSettings: this.init.runtimeSettings,
      ...(this.bridge ? { openCodeBridge: this.bridge } : {}),
    });
    const allow = this.init.providers;
    this.registry = allow
      ? Object.fromEntries(Object.entries(full).filter(([id]) => allow.includes(id)))
      : full;
    return this.registry;
  }

  private definition(provider: string): ProviderDefinition {
    const definition = this.getRegistry()[provider];
    if (!definition) {
      throw new RpcError(RpcErrorCode.UnknownProvider, `unknown provider ${provider}`);
    }
    return definition;
  }

  private client(provider: string): AgentClient {
    let client = this.clients.get(provider);
    if (!client) {
      client = this.definition(provider).createClient(this.logger);
      this.clients.set(provider, client);
    }
    return client;
  }

  private entry(params: Params): SessionEntry {
    const handle = str(params, "handle");
    const entry = this.sessions.get(handle);
    if (!entry) throw new RpcError(RpcErrorCode.UnknownSession, `unknown session handle ${handle}`);
    return entry;
  }

  private async closeAllSessions(): Promise<void> {
    await Promise.allSettled([...this.sessions.values()].map((entry) => this.closeEntry(entry)));
  }

  private async closeEntry(entry: SessionEntry): Promise<void> {
    this.sessions.delete(entry.handle);
    entry.unsubscribe();
    try {
      await entry.session.close();
    } catch (error) {
      this.hostLog("warn", "session close failed", {
        handle: entry.handle,
        error: messageOf(error),
      });
    }
  }

  /** Register a session, subscribe to its events, and describe it. Must be called synchronously
   *  before the response is written so no event is delivered before the client knows the handle. */
  private register(provider: string, session: AgentSession): Record<string, unknown> {
    if (this.shuttingDown) {
      // closeAllSessions() already took its snapshot; release this one so it is not orphaned.
      const close = session.close().catch((error: unknown) => {
        this.hostLog("warn", "late session close failed", { error: messageOf(error) });
      });
      this.lateCloses.add(close);
      void close.finally(() => this.lateCloses.delete(close));
      throw new RpcError(RpcErrorCode.ShuttingDown, "host is shutting down");
    }
    const handle = `s${this.nextHandle++}`;
    const entry: SessionEntry = { handle, provider, session, unsubscribe: () => {}, seq: 0 };
    entry.unsubscribe = session.subscribe((event: AgentStreamEvent) => {
      entry.seq += 1;
      this.send({
        method: SESSION_EVENT_METHOD,
        params: { handle, seq: entry.seq, event },
      });
    });
    this.sessions.set(handle, entry);
    return {
      handle,
      provider: session.provider,
      sessionId: session.id,
      capabilities: session.capabilities,
      features: session.features ?? [],
      initialTimeline: session.initialTimeline ?? [],
      persistence: session.describePersistence(),
    };
  }

  private createHandlers(): Record<string, Handler> {
    const providerCall =
      (
        fn: (
          client: AgentClient,
          params: Params,
          ctx: CallContext,
          provider: string,
        ) => Promise<unknown>,
      ): Handler =>
      (params, ctx) => {
        const provider = str(params, "provider");
        return fn(this.client(provider), params, ctx, provider);
      };
    const sessionCall =
      (
        fn: (session: AgentSession, params: Params, ctx: CallContext) => Promise<unknown>,
      ): Handler =>
      (params, ctx) =>
        fn(this.entry(params).session, params, ctx);

    return {
      "host.initialize": async (params) => {
        const requested =
          typeof params.protocolVersion === "number"
            ? params.protocolVersion
            : PROVIDER_HOST_PROTOCOL_VERSION;
        if (requested !== PROVIDER_HOST_PROTOCOL_VERSION) {
          throw new RpcError(
            RpcErrorCode.InvalidParams,
            `unsupported protocolVersion ${requested}`,
            {
              supported: PROVIDER_HOST_PROTOCOL_VERSION,
            },
          );
        }
        if (this.registry) {
          throw new RpcError(RpcErrorCode.InvalidRequest, "host already initialized");
        }
        this.init = { ...this.init, ...(params as InitializeParams) };
        await this.startBridge();
        return {
          protocolVersion: PROVIDER_HOST_PROTOCOL_VERSION,
          providers: this.listProviders(),
        };
      },
      "host.setToolManifest": async (params) => {
        const tools = params.tools;
        if (!Array.isArray(tools)) {
          throw new RpcError(RpcErrorCode.InvalidParams, "params.tools must be an array");
        }
        // The manifest lists the tools OpenCode registers; calls still go through tool.call.
        this.bridge?.setManifestCatalog(this.proxyCatalog(toolSpecs(tools), undefined));
        return { applied: this.bridge !== null };
      },
      "host.shutdown": async () => {
        await this.shutdown(false);
        setImmediate(() => this.onShutdown?.());
        return null;
      },
      "provider.list": async () => ({ providers: this.listProviders() }),
      "provider.isAvailable": providerCall(async (client, params, ctx) => ({
        available: await client.isAvailable(
          ctx.signal,
          optObj<FetchCatalogOptions>(params, "options"),
        ),
      })),
      "provider.fetchCatalog": providerCall(async (client, params, ctx, provider) => {
        const options = obj<FetchCatalogOptions>(params, "options");
        return this.definition(provider).fetchCatalog(options, client, {
          signal: ctx.signal,
          runActivity: (_name, operation) => operation(),
        });
      }),
      "provider.getCapabilities": providerCall(async (client) => ({
        capabilities: client.capabilities,
      })),
      "provider.listCommands": providerCall(async (client, params) => ({
        commands: (await client.listCommands?.(obj<AgentSessionConfig>(params, "config"))) ?? [],
      })),
      "provider.listFeatures": providerCall(async (client, params) => ({
        features: (await client.listFeatures?.(obj<AgentSessionConfig>(params, "config"))) ?? [],
      })),
      "provider.listImportableSessions": providerCall(async (client, params) => ({
        sessions:
          (await client.listImportableSessions?.(
            optObj<ListImportableSessionsOptions>(params, "options"),
          )) ?? [],
      })),
      "provider.getDiagnostic": providerCall(
        async (client) => (await client.getDiagnostic?.()) ?? null,
      ),
      "provider.archiveNativeSession": providerCall(async (client, params) => {
        await client.archiveNativeSession?.(obj<AgentPersistenceHandle>(params, "persistence"));
        return null;
      }),
      "provider.unarchiveNativeSession": providerCall(async (client, params) => {
        await client.unarchiveNativeSession?.(obj<AgentPersistenceHandle>(params, "persistence"));
        return null;
      }),
      "provider.createSession": providerCall(async (client, params, _ctx, provider) => {
        const session = await client.createSession(
          obj<AgentSessionConfig>(params, "config"),
          this.launchContext(params),
          optObj(params, "options"),
        );
        return this.register(provider, session);
      }),
      "provider.resumeSession": providerCall(async (client, params, _ctx, provider) => {
        const session = await client.resumeSession(
          obj<AgentPersistenceHandle>(params, "persistence"),
          optObj<Partial<AgentSessionConfig>>(params, "overrides"),
          this.launchContext(params),
          optObj(params, "options"),
        );
        return this.register(provider, session);
      }),
      "provider.importSession": providerCall(async (client, params, _ctx, provider) => {
        if (!client.importSession) {
          throw new RpcError(
            RpcErrorCode.InvalidRequest,
            `provider ${provider} cannot import sessions`,
          );
        }
        const context = obj<ImportProviderSessionContext>(params, "context");
        const launchContext = this.hydrateLaunchContext(
          context.launchContext as Record<string, unknown> | undefined,
        );
        const imported = await client.importSession(
          obj<ImportProviderSessionInput>(params, "input"),
          {
            ...context,
            ...(launchContext ? { launchContext } : {}),
          },
        );
        return {
          session: this.register(provider, imported.session),
          config: imported.config,
          persistence: imported.persistence,
          timeline: imported.timeline,
          providerSubagentEvents: imported.providerSubagentEvents ?? [],
        };
      }),

      "session.run": async (params, ctx) => {
        const session = this.entry(params).session;
        const onAbort = () => void session.interrupt().catch(() => undefined);
        ctx.signal.addEventListener("abort", onAbort, { once: true });
        try {
          return await session.run(prompt(params), optObj<AgentRunOptions>(params, "options"));
        } finally {
          ctx.signal.removeEventListener("abort", onAbort);
        }
      },
      "session.startTurn": sessionCall((session, params) =>
        session.startTurn(prompt(params), optObj<AgentRunOptions>(params, "options")),
      ),
      "session.steerActiveTurn": sessionCall(async (session, params) => {
        if (!session.steerActiveTurn) return { status: "unavailable" };
        return session.steerActiveTurn(
          prompt(params),
          obj<SteerActiveTurnOptions>(params, "options"),
        );
      }),
      "session.tryHandleOutOfBand": sessionCall(async (session, params) => {
        const handler = session.tryHandleOutOfBand?.(prompt(params));
        if (!handler) return { handled: false };
        const handle = str(params, "handle");
        const entry = this.sessions.get(handle);
        await handler.run({
          emit: (event) => {
            if (!entry) return;
            entry.seq += 1;
            this.send({ method: SESSION_EVENT_METHOD, params: { handle, seq: entry.seq, event } });
          },
        });
        return { handled: true };
      }),
      "session.streamHistory": sessionCall(async (session) => {
        const events: AgentStreamEvent[] = [];
        for await (const event of session.streamHistory()) events.push(event);
        return { events };
      }),
      "session.getRuntimeInfo": sessionCall((session) => session.getRuntimeInfo()),
      "session.getAvailableModes": sessionCall(async (session) => ({
        modes: await session.getAvailableModes(),
      })),
      "session.getCurrentMode": sessionCall(async (session) => ({
        modeId: await session.getCurrentMode(),
      })),
      "session.setMode": sessionCall(async (session, params) => ({
        notice: (await session.setMode(str(params, "modeId"))) ?? null,
      })),
      "session.getPendingPermissions": sessionCall(async (session) => ({
        requests: session.getPendingPermissions(),
      })),
      "session.respondToPermission": sessionCall(async (session, params) => ({
        result:
          (await session.respondToPermission(
            str(params, "requestId"),
            obj<AgentPermissionResponse>(params, "response"),
          )) ?? null,
      })),
      "session.describePersistence": sessionCall(async (session) => ({
        persistence: session.describePersistence(),
      })),
      "session.interrupt": sessionCall(async (session) => {
        await session.interrupt();
        return null;
      }),
      "session.close": async (params) => {
        const entry = this.entry(params);
        await this.closeEntry(entry);
        this.send({ method: SESSION_CLOSED_METHOD, params: { handle: entry.handle } });
        return null;
      },
      "session.listCommands": sessionCall(async (session) => ({
        commands: (await session.listCommands?.()) ?? [],
      })),
      "session.setModel": sessionCall(async (session, params) => {
        const modelId = params.modelId;
        await session.setModel?.(typeof modelId === "string" ? modelId : null);
        return null;
      }),
      "session.setThinkingOption": sessionCall(async (session, params) => {
        const id = params.thinkingOptionId;
        return {
          notice: (await session.setThinkingOption?.(typeof id === "string" ? id : null)) ?? null,
        };
      }),
      "session.setFeature": sessionCall(async (session, params) => {
        await session.setFeature?.(str(params, "featureId"), params.value);
        return null;
      }),
      "session.revertConversation": sessionCall(async (session, params) => {
        await this.requireRevert(session.revertConversation)?.call(session, {
          messageId: str(params, "messageId"),
        });
        return null;
      }),
      "session.revertFiles": sessionCall(async (session, params) => {
        await this.requireRevert(session.revertFiles)?.call(session, {
          messageId: str(params, "messageId"),
        });
        return null;
      }),
      "session.revertBoth": sessionCall(async (session, params) => {
        await this.requireRevert(session.revertBoth)?.call(session, {
          messageId: str(params, "messageId"),
        });
        return null;
      }),
    };
  }

  private async startBridge(): Promise<void> {
    const runtimeDir = this.init.runtimeDir;
    if (!runtimeDir || this.bridge) return;
    const allow = this.init.providers;
    if (allow && !allow.some((id) => id === "opencode" || id.startsWith("opencode"))) return;
    const bridge = new OpenCodeBridge({ paseoHome: runtimeDir, logger: this.logger });
    await bridge.start();
    this.bridge = bridge;
  }

  private requireRevert<T>(fn: T | undefined): T {
    if (!fn)
      throw new RpcError(
        RpcErrorCode.InvalidRequest,
        "session does not support this revert operation",
      );
    return fn;
  }

  private listProviders() {
    return Object.values(this.getRegistry()).map((definition) => ({
      id: definition.id,
      label: definition.label,
      description: definition.description,
      enabled: definition.enabled,
      defaultModeId: definition.defaultModeId,
      modes: definition.modes,
    }));
  }
}
