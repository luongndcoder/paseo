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
import {
  CANCEL_METHOD,
  PROVIDER_HOST_PROTOCOL_VERSION,
  RpcError,
  RpcErrorCode,
  SESSION_CLOSED_METHOD,
  SESSION_EVENT_METHOD,
  type OutboundMessage,
  type RpcId,
} from "./protocol.js";

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
    await this.closeAllSessions();
    await shutdownAgentClients(this.clients.values(), this.logger);
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
      this.logger.warn({ err: error, handle: entry.handle }, "session close failed");
    }
  }

  /** Register a session, subscribe to its events, and describe it. Must be called synchronously
   *  before the response is written so no event is delivered before the client knows the handle. */
  private register(provider: string, session: AgentSession): Record<string, unknown> {
    if (this.shuttingDown) {
      // closeAllSessions() already took its snapshot; release this one so it is not orphaned.
      const close = session.close().catch((error: unknown) => {
        this.logger.warn({ err: error }, "late session close failed");
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
        return {
          protocolVersion: PROVIDER_HOST_PROTOCOL_VERSION,
          providers: this.listProviders(),
        };
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
          optObj<AgentLaunchContext>(params, "launchContext"),
          optObj(params, "options"),
        );
        return this.register(provider, session);
      }),
      "provider.resumeSession": providerCall(async (client, params, _ctx, provider) => {
        const session = await client.resumeSession(
          obj<AgentPersistenceHandle>(params, "persistence"),
          optObj<Partial<AgentSessionConfig>>(params, "overrides"),
          optObj<AgentLaunchContext>(params, "launchContext"),
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
        const imported = await client.importSession(
          obj<ImportProviderSessionInput>(params, "input"),
          obj<ImportProviderSessionContext>(params, "context"),
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
