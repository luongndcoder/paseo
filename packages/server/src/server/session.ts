import { AgentDirectory } from "./agent/directory.js";
import { searchTimeline } from "./agent/chat-search/index.js";
import type { BrowserToolsBroker } from "./browser-tools/broker.js";
import { BrowserAutomationHostCapabilitySchema } from "@getpaseo/protocol/browser-automation/capabilities";
import type {
  SessionEventSubscription,
  UsageReportEntry,
  ProviderUsage,
} from "@getpaseo/protocol/messages";
import { relative } from "node:path";
import { isAbsolute } from "node:path";
import { CreationService, type CreatedAgent } from "./creation/index.js";
import type { CreationSnapshot, AgentCreateRequest } from "@getpaseo/protocol/messages";
import type { MessageReceipts } from "./message-receipts/index.js";
import { WorkspaceSetupObservation } from "./workspace-setup-observation.js";
import { SessionDelivery, type OwnedSubscription } from "./session/owned-subscriptions/index.js";
import { v4 as uuidv4 } from "uuid";
import { lstat, mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { resolve, sep } from "path";
import { homedir } from "node:os";
import { CLIENT_CAPS, type ClientCapability } from "@getpaseo/protocol/client-capabilities";
import { formatPluginSourceReference } from "@getpaseo/protocol/plugin-source-reference";
import {
  serializeAgentStreamEvent,
  type AgentSnapshotPayload,
  type AgentAttachment,
  type FirstAgentContext,
  type SessionInboundMessage,
  type SessionOutboundMessage,
  type ScriptStatusUpdateMessage,
  type GitSetupOptions,
  type StartWorkspaceScriptRequest,
  type WorkspaceScriptListRequest,
  type WorkspaceScriptStartRequest,
  type WorkspaceScriptStopRequest,
  type ProjectPlacementPayload,
  type WorkspaceSetupSnapshot,
  type WorkspaceDescriptorPayload,
} from "./messages.js";
import type { TerminalManager } from "../terminal/terminal-manager.js";
import { TerminalSessionController } from "../terminal/terminal-session-controller.js";
import type { TerminalActivity } from "@getpaseo/protocol/terminal-activity";
import type { BinaryFrame } from "@getpaseo/protocol/binary-frames/index";
import type { SpeechToTextProvider, TextToSpeechProvider } from "./speech/speech-provider.js";
import type { TurnDetectionProvider } from "./speech/turn-detection-provider.js";
import { isStoredAgentProviderAvailable } from "./persistence-hooks.js";
import { ensureAgentLoaded, ensureUnarchivedAgentLoaded } from "./agent/agent-loading.js";
import { sendPromptToAgent } from "./agent/agent-prompt.js";
import {
  resolveCreateAgentTitles,
  resolveFirstAgentPromptTitle,
} from "./agent/create-agent-title.js";
import type { VoiceCallerContext, VoiceSpeakHandler } from "./voice-types.js";
import type { ScriptHealthState } from "./script-health-monitor.js";
import { spawnWorkspaceScript } from "./worktree-bootstrap.js";
import type { WorkspaceScriptRuntimeStore } from "./workspace-script-runtime-store.js";
import {
  listLocalDaemonEditorTargets,
  openInLocalDaemonEditorTarget,
} from "./local-editor-targets.js";
import {
  createWorkspaceScriptsService,
  type WorkspaceScriptsService,
} from "./session/workspace-scripts/workspace-scripts-service.js";
import type { DaemonConfigStore } from "./daemon-config-store.js";
import { loadPersistedConfig } from "./persisted-config.js";
import { getErrorMessage, getErrorMessageOr } from "@getpaseo/protocol/error-utils";
import type { WorkspaceGitService } from "./workspace-git-service.js";
import type { ProjectUpdate } from "./workspace-reconciliation-service.js";
import {
  CLIENT_SHUTDOWN_RPC_REASON,
  normalizeClientRestartRpcReason,
} from "./lifecycle-reasons.js";
import { DirectorySyncService } from "./directory-sync/index.js";
import {
  assertWorkspaceAutomationAllowedForWorkspace,
  clearWorkspaceAutomationBlock,
  formatWorkspaceAutomationBlockedMessage,
} from "./workspace-automation-gate.js";
import {
  WorkspaceLabelError,
  WorkspaceLabelStorageUncertainError,
  type WorkspaceLabelService,
} from "./workspace-labels/index.js";

import { AgentManager, AgentRunCancellationError } from "./agent/agent-manager.js";
import { buildTimelinePromptIndex } from "./agent/timeline-prompt-index.js";
import { ProviderSnapshotManager } from "./agent/provider-snapshot-manager.js";
import type {
  AgentManagerEvent,
  AgentTimelineCursor,
  AgentTimelineFetchDirection,
  AgentTimelineFetchResult,
  ManagedAgent,
} from "./agent/agent-manager.js";
import { createAgentCommand } from "./agent/create-agent/create.js";
import { resolveCreateAgentIntent, type CreateAgentIntent } from "./agent/create-agent/intent.js";
import { setAgentModeCommand } from "./agent/lifecycle-command.js";
import { buildStoredAgentPayload, toAgentPayload } from "./agent/agent-projections.js";
import {
  appendTimelineItemIfAgentKnown,
  emitLiveTimelineItemIfAgentKnown,
} from "./agent/timeline-append.js";
import { assertPluginTimelineDataSize } from "./agent/agent-timeline-content.js";
import { parsePluginClientId } from "./plugins/plugin-session-identity.js";
import { buildAgentForkContextAttachment } from "./agent/activity-curator.js";
import { buildAgentPrompt } from "./agent/prompt-attachments.js";
import type { StructuredGenerationDaemonConfig } from "./agent/structured-generation-providers.js";
import {
  getAgentStreamEventTurnId,
  type AgentRunOptions,
  type AgentSessionConfig,
} from "./agent/agent-sdk-types.js";
import type { StoredAgentRecord } from "./agent/agent-storage.js";
import type { AgentStorage } from "./agent/agent-storage.js";
import { checkoutFromPersistedWorkspacePlacement } from "./workspace-registry-model.js";
import { resolveWorkspaceIdForPath } from "./resolve-workspace-id-for-path.js";
import {
  resolveProjectDisplayName,
  resolveWorkspaceDisplayName,
  type PersistedProjectRecord,
  type PersistedWorkspaceRecord,
  type ProjectRegistry,
  type WorkspaceRegistry,
} from "./workspace-registry.js";
import { wrapSpokenInput } from "./voice-config.js";
import { shouldAutoAllowVoicePermission } from "./voice-permission-policy.js";
import { ProjectIconReader, removeProjectCustomIcon } from "../utils/project-custom-icon.js";
import { VoiceSessions } from "./session/voice/index.js";
import { CheckoutSession } from "./session/checkout/checkout-session.js";
import {
  createWorkspaceGitObserverService,
  type WorkspaceGitObserverService,
} from "./session/workspace-git-observer/workspace-git-observer-service.js";
import {
  createAgentStructuredTextGeneration,
  createGitMetadataGenerator,
} from "./session/checkout/git-metadata-generator.js";
import { ScheduleSession } from "./session/schedule/schedule-session.js";
import { ProviderCatalogSession } from "./session/provider/provider-catalog-session.js";
import { UsageSession } from "./session/usage/usage-session.js";
import { WorkspaceFilesSession } from "./session/files/workspace-files-session.js";
import { AgentConfigSession } from "./session/agent-config/agent-config-session.js";
import { AgentLifecycleSession } from "./session/agent-lifecycle/agent-lifecycle-session.js";
import { WorkspaceLabelSession } from "./session/workspace-labels/workspace-label-session.js";
import { isAppVersionAtLeast } from "./session/app-version.js";
import { WorkspaceSession } from "./session/workspace/workspace-session.js";
import { SessionRequestError } from "./session/session-request-error.js";
import { ProjectConfigSession } from "./session/project-config/project-config-session.js";
import { DaemonSession, type DaemonRuntimeConfig } from "./session/daemon/daemon-session.js";
import type { DaemonWebSocketRuntimeDiagnosticSnapshot } from "./session/daemon/diagnostics.js";
import type { HubRelationshipManagement } from "./hub/relationship-controller.js";
import { HubExecutionController } from "./hub/execution-controller.js";
import type { HubExecutionAgents } from "./hub/daemon-executions.js";
import { DownloadTokenStore } from "./file-download/token-store.js";
import type { PushNotifications } from "./push/index.js";
import { archiveWorkspaceContents } from "./workspace-archive-service.js";
import type { ServiceProxySubsystem } from "./service-proxy.js";
import { renameCurrentBranch as renameCurrentBranchDefault } from "../utils/checkout-git.js";
import {
  createGitMutationService,
  type GitMutationService,
} from "./session/git-mutation/git-mutation-service.js";
import {
  createWorkspaceProvisioningService,
  type WorkspaceProvisioningService,
} from "./session/workspace-provisioning/workspace-provisioning-service.js";
import {
  createWorkspaceRecoveryService,
  type WorkspaceRecoveryService,
} from "./session/workspace-recovery/workspace-recovery-service.js";
import {
  createAgentUpdatesService,
  type AgentUpdatesService,
} from "./session/agent-updates/agent-updates-service.js";
import { expandTilde } from "../utils/path.js";
import type { CheckoutDiffManager } from "./checkout-diff-manager.js";
import type { Resolvable } from "./speech/provider-resolver.js";
import type { SpeechReadinessSnapshot } from "./speech/speech-runtime.js";
import type pino from "pino";
import { ScheduleService } from "./schedule/service.js";
import {
  createGitHubService,
  GitHubAuthenticationError,
  GitHubCliMissingError,
  GitHubCommandError,
  type GitHubService,
} from "../services/github-service.js";
import type { ForgeService } from "../services/forge-service.js";
import { resolveWorkspaceRootAgent, WorkspaceDirectory } from "./workspace-directory.js";
import {
  createPaseoWorktree,
  type CreatePaseoWorktreeInput,
  type CreatePaseoWorktreeResult,
} from "./paseo-worktree-service.js";
import { WorkspaceAutoName } from "./workspace-auto-name.js";
import {
  buildAgentSessionConfig as buildWorktreeAgentSessionConfig,
  normalizeAgentCreationGitOptions,
  createPaseoWorktreeWorkflow as createWorktreeWorkflow,
  type CreatePaseoWorktreeSetupContinuationInput,
  type CreatePaseoWorktreeWorkflowResult,
  handleCreatePaseoWorktreeRequest as handleCreateWorktreeRequest,
  handlePaseoWorktreeArchiveRequest as handleWorktreeArchiveRequest,
  handlePaseoWorktreeListRequest as handleWorktreeListRequest,
  handleWorkspaceSetupStatusRequest as handleWorkspaceSetupStatusRequestMessage,
  handleWorkspaceSetupRunRequest as handleWorkspaceSetupRunRequestMessage,
} from "./worktree-session.js";
import { archiveByScope, type ActiveWorkspaceRef } from "./workspace-archive-service.js";
import { WorkspaceSetupRuntime } from "./workspace-setup-runtime.js";
import { SessionAuthorization, type DaemonPermission } from "./authorization/index.js";

function resolveWorkspaceSetupRuntime(
  runtime: WorkspaceSetupRuntime | undefined,
): WorkspaceSetupRuntime {
  return runtime ?? new WorkspaceSetupRuntime();
}
import { WorktreeRequestError, toWorktreeWireError } from "./worktree-errors.js";
import { parseGitRemoteLocation } from "@getpaseo/protocol/git-remote";
import {
  createProjectDirectory,
  ProjectDirectoryRequestError,
} from "./project-directory-service.js";
import { runGitCommand } from "../utils/run-git-command.js";
import { CreateAgentLifecycleDispatch } from "./agent/create-agent-lifecycle-dispatch.js";
import { resolveWorktreeSourceCwd } from "./workspace-source.js";

type ProviderSubagentManagerEvent = Extract<
  AgentManagerEvent,
  { type: "provider_subagent" }
>["event"];

// TODO: Remove once all app store clients are on >=0.1.45 and understand arbitrary provider strings.
// Clients before 0.1.45 validate providers with z.enum(["claude", "codex", "opencode"]) and reject
// the entire session message if they encounter an unknown provider.
const LEGACY_PROVIDER_IDS = new Set(["claude", "codex", "opencode"]);
const MIN_VERSION_ALL_PROVIDERS = "0.1.45";
function errorToFriendlyMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown error";
}

function clientSupportsAllProviders(appVersion: string | null): boolean {
  return isAppVersionAtLeast(appVersion, MIN_VERSION_ALL_PROVIDERS);
}

export { resolveWaitForFinishError } from "./session/agent-lifecycle/agent-lifecycle-session.js";

export interface SessionRuntimeMetrics {
  terminalDirectorySubscriptionCount: number;
  terminalSubscriptionCount: number;
  workspaceGitWatchedDirectoryCount: number;
  workspaceGitWorkspaceRecordCount: number;
  workspaceGitSubscriptionCount: number;
  inflightRequests: number;
  peakInflightRequests: number;
}

type CreateAgentRequestMessage = Extract<SessionInboundMessage, { type: "create_agent_request" }>;

interface ResolvedSessionCreateAgentIntent {
  config: AgentSessionConfig;
  intent: CreateAgentIntent;
  createdDirectoryWorkspace: boolean;
}

type WorkspaceGithubSearchRepositoriesResponsePayload = Extract<
  SessionOutboundMessage,
  { type: "workspace.github.search_repositories.response" }
>["payload"];

export interface SessionFileSystem {
  isDirectory(path: string): Promise<boolean>;
}

const nodeSessionFileSystem: SessionFileSystem = {
  async isDirectory(path) {
    const stats = await stat(path).catch(() => null);
    return stats?.isDirectory() ?? false;
  },
};

// Stub types for features under development (modules not yet available)
type AgentMcpTransportFactory = () => Promise<unknown>;

export interface SessionOptions {
  browserToolsBroker?: BrowserToolsBroker | null;
  clientId: string;
  permissions: readonly DaemonPermission[];
  appVersion?: string | null;
  clientCapabilities?: Record<string, unknown> | null;
  onMessage: (msg: SessionOutboundMessage) => void;
  onMessageToSource?: (source: object, msg: SessionOutboundMessage) => void;
  onBinaryMessage?: (frame: Uint8Array) => void;
  onBinaryMessageToSource?: (source: object, frame: Uint8Array) => Promise<void>;
  getTransportBufferedAmount?: (source?: object) => number | null;
  onLifecycleIntent?: (intent: SessionLifecycleIntent) => void;
  onWorkspaceRecovered?: (workspace: PersistedWorkspaceRecord) => Promise<void>;
  publishScriptStatusUpdate?: (message: ScriptStatusUpdateMessage) => void;
  logger: pino.Logger;
  downloadTokenStore: DownloadTokenStore;
  pushNotifications: PushNotifications;
  paseoHome: string;
  worktreesRoot?: string;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  messageReceipts: Pick<MessageReceipts, "send">;
  creationService: Pick<CreationService, "create" | "subscribe">;
  projectRegistry: ProjectRegistry;
  workspaceRegistry: WorkspaceRegistry;
  directorySync?: DirectorySyncService;
  workspaceLabelService?: WorkspaceLabelService;
  filesystem?: SessionFileSystem;
  scheduleService: ScheduleService;
  checkoutDiffManager: CheckoutDiffManager;
  github?: ForgeService;
  createAgentMcpTransport?: AgentMcpTransportFactory;
  // Injected so tests can substitute the git branch rename without module mocks;
  // defaults to the real checkout-git implementation.
  renameCurrentBranch?: typeof renameCurrentBranchDefault;
  workspaceGitService: WorkspaceGitService;
  workspaceAutoName: WorkspaceAutoName;
  daemonConfigStore: DaemonConfigStore;
  pluginRuntime?: {
    before: import("./plugins/lifecycle/index.js").PluginLifecycle["before"];
    emit: import("./plugins/lifecycle/index.js").PluginLifecycle["emit"];
    listPlugins(): Promise<import("@getpaseo/protocol/messages").PluginListItem[]>;
    getLogs(pluginId: string): import("@getpaseo/protocol/messages").PluginLogEntry[];
    installDirectory(input: {
      path: string;
      id?: string;
    }): Promise<import("@getpaseo/protocol/messages").PluginListItem>;
    inspectDirectory(path: string): Promise<{ id: string }>;
    installSource(input: {
      source: string;
      id?: string;
      ref?: string;
    }): Promise<import("@getpaseo/protocol/messages").PluginListItem>;
    statusSources(
      pluginId?: string,
    ): Promise<import("@getpaseo/protocol/messages").PluginSourceStatusItem[]>;
    previewUpdates(input: {
      pluginId?: string;
      target?: import("@getpaseo/protocol/messages").PluginUpdateSelection;
    }): Promise<import("@getpaseo/protocol/messages").PluginUpdatePreview[]>;
    applyUpdates(
      proposals: import("@getpaseo/protocol/messages").PluginUpdateProposal[],
    ): Promise<import("@getpaseo/protocol/messages").PluginUpdateResult[]>;
    updateSources(
      pluginId?: string,
    ): Promise<import("@getpaseo/protocol/messages").PluginSourceUpdateItem[]>;
    reloadPlugin(pluginId: string): Promise<import("@getpaseo/protocol/messages").PluginListItem>;
    enablePlugin(pluginId: string): Promise<import("@getpaseo/protocol/messages").PluginListItem>;
    disablePlugin(pluginId: string): Promise<import("@getpaseo/protocol/messages").PluginListItem>;
    removePlugin(pluginId: string): Promise<void>;
    subscribe(listener: (pluginId: string) => void): () => void;
    subscribeSettings?(listener: (pluginId: string, settingsId: string) => void): () => void;
    catalog(): Array<{ id: string; clientBundle: string }>;
    invokePluginRpc(pluginId: string, method: string, input: unknown): Promise<unknown>;
    listUsageReports(options?: {
      forceRefresh?: boolean;
      reportIds?: string[];
    }): Promise<UsageReportEntry[]>;
    listLegacyUsage(): Promise<{ fetchedAt: string; providers: ProviderUsage[] }>;
  };
  orchestrationSkills?: import("./orchestration-skills/index.js").OrchestrationSkills;
  mcpBaseUrl?: string | null;
  stt: Resolvable<SpeechToTextProvider | null>;
  sttLanguage?: string;
  tts: Resolvable<TextToSpeechProvider | null>;
  terminalManager: TerminalManager | null;
  providerSnapshotManager: ProviderSnapshotManager;
  hubExecutionAgents?: HubExecutionAgents;
  hubRelationships?: HubRelationshipManagement;
  serviceProxy?: ServiceProxySubsystem;
  scriptRuntimeStore?: WorkspaceScriptRuntimeStore;
  workspaceSetupObservation?: WorkspaceSetupObservation;
  workspaceSetupRuntime?: WorkspaceSetupRuntime;
  onBranchChanged?: (
    workspaceId: string,
    oldBranch: string | null,
    newBranch: string | null,
  ) => void;
  getDaemonTcpPort?: () => number | null;
  getDaemonTcpHost?: () => string | null;
  serviceProxyPublicBaseUrl?: string | null;
  resolveScriptHealth?: (hostname: string) => ScriptHealthState | null;
  voice?: {
    turnDetection?: Resolvable<TurnDetectionProvider | null>;
  };
  voiceBridge?: {
    registerVoiceSpeakHandler?: (agentId: string, handler: VoiceSpeakHandler) => void;
    unregisterVoiceSpeakHandler?: (agentId: string) => void;
    registerVoiceCallerContext?: (agentId: string, context: VoiceCallerContext) => void;
    unregisterVoiceCallerContext?: (agentId: string) => void;
  };
  dictation?: {
    finalTimeoutMs?: number;
    stt?: Resolvable<SpeechToTextProvider | null>;
    sttLanguage?: string;
    getSpeechReadiness?: () => SpeechReadinessSnapshot;
  };
  serverId?: string;
  daemonVersion?: string;
  daemonRuntimeConfig?: DaemonRuntimeConfig;
  getWebSocketRuntimeMetrics?: () => DaemonWebSocketRuntimeDiagnosticSnapshot | null;
}

export type SessionLifecycleIntent =
  | {
      type: "shutdown";
      clientId: string;
      requestId: string;
      reason: string;
    }
  | {
      type: "restart";
      clientId: string;
      requestId: string;
      reason: string;
    };

function parseClientCapabilities(
  capabilities: Record<string, unknown> | null | undefined,
): ReadonlySet<ClientCapability> {
  if (!capabilities) {
    return new Set();
  }
  const known = new Set<ClientCapability>(Object.values(CLIENT_CAPS));
  const result: ClientCapability[] = [];
  for (const [key, value] of Object.entries(capabilities)) {
    if (value === true && known.has(key as ClientCapability)) {
      result.push(key as ClientCapability);
    }
  }
  return new Set(result);
}

function sessionRequestId(message: SessionInboundMessage): string | null {
  if ("requestId" in message && typeof message.requestId === "string") {
    return message.requestId;
  }
  if (
    "payload" in message &&
    typeof message.payload === "object" &&
    message.payload !== null &&
    "requestId" in message.payload &&
    typeof message.payload.requestId === "string"
  ) {
    return message.payload.requestId;
  }
  return null;
}

type RegistryTransition = "created" | "unarchived" | "existing";

interface ArchivedRecordSnapshot {
  archivedAt?: string | null;
}

function resolveDirectorySync(service: DirectorySyncService | undefined): DirectorySyncService {
  return service ?? new DirectorySyncService();
}

function describeRegistryTransition(record: ArchivedRecordSnapshot | null): RegistryTransition {
  if (!record) {
    return "created";
  }
  return record.archivedAt ? "unarchived" : "existing";
}

/**
 * Session represents a single connected client session.
 * It owns all state management, orchestration logic, and message processing.
 * Session has no knowledge of WebSockets - it only emits and receives messages.
 */
function resolveWorkspaceLabelService(
  service: WorkspaceLabelService | undefined,
): WorkspaceLabelService | null {
  return service ?? null;
}

function hasInitialCreationPrompt(
  request?: Pick<AgentCreateRequest, "initialPrompt" | "images" | "attachments">,
): boolean {
  return Boolean(
    request &&
    buildAgentPrompt(request.initialPrompt?.trim() ?? "", request.images, request.attachments)
      .length,
  );
}

function workspaceLabelErrorCode(error: unknown): string {
  if (
    error instanceof WorkspaceLabelError ||
    error instanceof WorkspaceLabelStorageUncertainError ||
    error instanceof SessionRequestError
  ) {
    return error.code;
  }
  return "workspace_label_failed";
}

interface ClientActivity {
  deviceType: "web" | "mobile";
  focusedAgentId: string | null;
  focusedTerminalId: string | null;
  lastActivityAt: Date;
  appVisible: boolean;
  appVisibilityChangedAt: Date;
}

export class Session {
  readonly delivery = new SessionDelivery(
    (source, message) => {
      if (!this.authorization.allowsOutbound(message)) return;
      if (this.onMessageToSource) this.onMessageToSource(source, message);
      else this.onMessage(message);
    },
    (source, frame) => {
      if (this.onBinaryMessageToSource) {
        void this.onBinaryMessageToSource(source, frame).catch((error) =>
          this.sessionLogger.warn({ err: error }, "Failed to emit binary frame"),
        );
      } else this.emitBinary(frame);
    },
    (source, message) => this.workspaceSetupMessageForClient(message, source),
    (request, message) =>
      this.sessionLogger.warn(
        {
          requestType: request.type,
          messageType: message.type,
          status: message.type === "status" ? message.payload.status : undefined,
        },
        "Unrecognized reply contract; application delivery denied",
      ),
  );
  private readonly browserToolsBroker: SessionOptions["browserToolsBroker"];
  private readonly clientId: string;
  private readonly authorization: SessionAuthorization;
  private appVersion: string | null;
  private clientCapabilities: ReadonlySet<ClientCapability>;
  private readonly sessionId: string;
  private readonly onMessage: (msg: SessionOutboundMessage) => void;
  private readonly onMessageToSource:
    | ((source: object, msg: SessionOutboundMessage) => void)
    | null;
  private readonly onBinaryMessage: ((frame: Uint8Array) => void) | null;
  private readonly onBinaryMessageToSource:
    | ((source: object, frame: Uint8Array) => Promise<void>)
    | null;
  private readonly getTransportBufferedAmount: (source?: object) => number | null;
  private readonly onLifecycleIntent: ((intent: SessionLifecycleIntent) => void) | null;
  private readonly sessionLogger: pino.Logger;
  private readonly paseoHome: string;
  private readonly projectIcons: ProjectIconReader;
  private readonly worktreesRoot: string | undefined;
  private readonly rewindInitiators = new Map<string, object | undefined>();

  private agentManager: AgentManager;
  private readonly agentStorage: AgentStorage;
  private readonly projectRegistry: ProjectRegistry;
  private readonly workspaceRegistry: WorkspaceRegistry;
  private readonly agentDirectory: AgentDirectory;
  private readonly directorySync: DirectorySyncService;
  private readonly filesystem: SessionFileSystem;
  private readonly github: ForgeService;
  private readonly renameCurrentBranch: typeof renameCurrentBranchDefault;
  private readonly workspaceGitService: WorkspaceGitService;
  private readonly workspaceAutoName: WorkspaceAutoName;
  private readonly gitMutation: GitMutationService;
  private readonly workspaceProvisioning: WorkspaceProvisioningService;
  private readonly workspaceRecovery: WorkspaceRecoveryService;
  private readonly daemonConfigStore: DaemonConfigStore;
  private readonly pushNotifications: PushNotifications;
  private readonly pluginRuntime: SessionOptions["pluginRuntime"];
  private readonly orchestrationSkills: SessionOptions["orchestrationSkills"];
  private unsubscribeAgentEvents: (() => void) | null = null;
  private unsubscribeProjectMutations: (() => void) | null = null;
  private unsubscribePluginChanges: (() => void) | null = null;
  private unsubscribeWorkspaceMutations: (() => void) | null = null;
  private registryMutationQueue: Promise<void> = Promise.resolve();
  private projectUpdateQueue: Promise<void> = Promise.resolve();
  private isCleanedUp = false;
  private readonly timelineSubscriptions = new Map<
    string,
    { owner: OwnedSubscription; agentIds: Set<string> }
  >();
  private readonly clientSources = new Map<
    object,
    {
      capabilities: ReadonlySet<ClientCapability>;
      appVersion: string | null;
      activity: ClientActivity | null;
      pushToken: string | null;
    }
  >();
  private unsubscribeTerminalWorkspaceContributionEvents: (() => void) | null = null;
  private readonly agentUpdates: AgentUpdatesService;
  private readonly workspaceLabelSession: WorkspaceLabelSession;
  private readonly workspaceSession: WorkspaceSession;
  private readonly eventSubscriptions = new Map<
    string,
    { owner: OwnedSubscription; events: Set<SessionEventSubscription>; notifications: boolean }
  >();
  private readonly terminalManager: TerminalManager | null;
  private readonly providerSnapshotManager: ProviderSnapshotManager;
  private readonly serviceProxy: ServiceProxySubsystem | null;
  private readonly scriptRuntimeStore: WorkspaceScriptRuntimeStore | null;
  private readonly getDaemonTcpPort: (() => number | null) | null;
  private readonly getDaemonTcpHost: (() => string | null) | null;
  private readonly serviceProxyPublicBaseUrl: string | null;
  private readonly resolveScriptHealth: ((hostname: string) => ScriptHealthState | null) | null;
  private readonly terminalController: TerminalSessionController;
  private inflightRequests = 0;
  private peakInflightRequests = 0;
  private readonly workspaceSetupObservation: WorkspaceSetupObservation;
  private readonly unsubscribeSetupObservation: () => void;
  private readonly workspaceSetupRuntime: WorkspaceSetupRuntime;
  private readonly workspaceGitObserver: WorkspaceGitObserverService;
  private readonly workspaceDirectory: WorkspaceDirectory;
  private readonly voiceSessions: VoiceSessions;
  private readonly checkoutSession: CheckoutSession;
  private readonly scheduleSession: ScheduleSession;
  private readonly providerCatalogSession: ProviderCatalogSession;
  private readonly usageSession: UsageSession;
  private readonly workspaceFilesSession: WorkspaceFilesSession;
  private readonly agentConfigSession: AgentConfigSession;
  private readonly agentLifecycleSession: AgentLifecycleSession;
  private readonly projectConfigSession: ProjectConfigSession;
  private readonly daemonSession: DaemonSession;
  private readonly hubExecutionController: HubExecutionController | null;
  private readonly workspaceScripts: WorkspaceScriptsService;
  private readonly messageReceipts: Pick<MessageReceipts, "send">;
  private readonly createAgentLifecycleDispatch: CreateAgentLifecycleDispatch;
  private readonly creationService: Pick<CreationService, "create" | "subscribe">;

  constructor(options: SessionOptions) {
    const {
      clientId,
      permissions,
      appVersion,
      clientCapabilities,
      onMessage,
      onMessageToSource,
      onBinaryMessage,
      onBinaryMessageToSource,
      getTransportBufferedAmount,
      onLifecycleIntent,
      onWorkspaceRecovered,
      publishScriptStatusUpdate,
      logger,
      downloadTokenStore,
      pushNotifications,
      paseoHome,
      worktreesRoot,
      agentManager,
      agentStorage,
      projectRegistry,
      workspaceRegistry,
      directorySync,
      workspaceLabelService,
      filesystem,
      scheduleService,
      checkoutDiffManager,
      github,
      renameCurrentBranch,
      workspaceGitService,
      workspaceAutoName,
      daemonConfigStore,
      pluginRuntime,
      orchestrationSkills,
      stt,
      sttLanguage,
      tts,
      terminalManager,
      providerSnapshotManager,
      serviceProxy,
      scriptRuntimeStore,
      workspaceSetupObservation,
      workspaceSetupRuntime,
      onBranchChanged,
      getDaemonTcpPort,
      getDaemonTcpHost,
      serviceProxyPublicBaseUrl,
      resolveScriptHealth,
      voice,
      voiceBridge,
      dictation,
      serverId,
      daemonVersion,
      daemonRuntimeConfig,
      getWebSocketRuntimeMetrics,
    } = options;
    this.browserToolsBroker = options.browserToolsBroker;
    this.clientId = clientId;
    this.authorization = new SessionAuthorization(permissions);
    this.appVersion = appVersion ?? null;
    this.clientCapabilities = parseClientCapabilities(clientCapabilities);
    this.sessionId = uuidv4();
    this.onMessage = onMessage;
    this.onMessageToSource = onMessageToSource ?? null;
    this.onBinaryMessage = onBinaryMessage ?? null;
    this.onBinaryMessageToSource = onBinaryMessageToSource ?? null;
    this.getTransportBufferedAmount = getTransportBufferedAmount ?? (() => 0);
    this.onLifecycleIntent = onLifecycleIntent ?? null;
    this.pushNotifications = pushNotifications;
    this.paseoHome = paseoHome;
    this.messageReceipts = options.messageReceipts;
    this.creationService = options.creationService;
    this.projectIcons = new ProjectIconReader(paseoHome);
    this.worktreesRoot = worktreesRoot;
    this.pluginRuntime = pluginRuntime;
    this.orchestrationSkills = orchestrationSkills;
    this.sessionLogger = logger.child({
      module: "session",
      clientId: this.clientId,
      sessionId: this.sessionId,
    });
    this.workspaceFilesSession = new WorkspaceFilesSession({
      host: {
        emit: (msg, source) => this.emitForSource(msg, source),
        emitBinary: (frame, source) => this.emitBinaryForFileTransfer(frame, source),
        hasBinaryChannel: () => this.onBinaryMessage !== null,
      },
      downloadTokenStore,
      paseoHome,
      logger: this.sessionLogger,
    });
    this.agentManager = agentManager;
    this.agentStorage = agentStorage;
    this.projectRegistry = projectRegistry;
    this.workspaceRegistry = workspaceRegistry;
    this.directorySync = resolveDirectorySync(directorySync);
    this.workspaceLabelSession = new WorkspaceLabelSession({
      host: {
        emit: (msg) => this.emit(msg),
        delivery: this.delivery,
        createUnavailableError: () =>
          new SessionRequestError("workspace_labels_unavailable", "Workspace labels unavailable"),
        errorCode: workspaceLabelErrorCode,
      },
      service: resolveWorkspaceLabelService(workspaceLabelService),
    });
    this.filesystem = filesystem ?? nodeSessionFileSystem;
    this.github = github ?? createGitHubService();
    this.renameCurrentBranch = renameCurrentBranch ?? renameCurrentBranchDefault;
    this.workspaceGitService = workspaceGitService;
    this.gitMutation = createGitMutationService({
      workspaceGitService: this.workspaceGitService,
      logger: this.sessionLogger,
    });
    this.workspaceAutoName = workspaceAutoName;
    this.workspaceProvisioning = createWorkspaceProvisioningService({
      lifecycle: this.pluginRuntime,
      serverId,
      workspaceRegistry: this.workspaceRegistry,
      projectRegistry: this.projectRegistry,
      workspaceGitService: this.workspaceGitService,
      isDirectory: (path) => this.filesystem.isDirectory(path),
      logger: this.sessionLogger,
    });
    this.workspaceRecovery = createWorkspaceRecoveryService({
      paseoHome: this.paseoHome,
      worktreesRoot: this.worktreesRoot,
      getWorkspace: (workspaceId) => this.workspaceRegistry.get(workspaceId),
      getProject: (projectId) => this.projectRegistry.get(projectId),
      isDirectory: (path) => this.filesystem.isDirectory(path),
      unarchiveWorkspace: async (workspace) => {
        await this.workspaceProvisioning.ensureWorkspaceRecordUnarchived(workspace);
      },
    });
    this.checkoutSession = new CheckoutSession({
      host: {
        emit: (msg) => this.emit(msg),
        emitWorkspaceUpdateForCwd: (cwd) => this.workspaceSession.emitWorkspaceUpdateForCwd(cwd),
        handleWorkspaceGitBranchSnapshot: (cwd, branchName) =>
          this.workspaceGitObserver.handleBranchSnapshot(cwd, branchName),
        renameCurrentBranch: (cwd, branch) => this.renameCurrentBranch(cwd, branch),
      },
      gitMutation: this.gitMutation,
      workspaceGitService: this.workspaceGitService,
      github: this.github,
      checkoutDiffManager,
      gitMetadataGenerator: createGitMetadataGenerator({
        workspaceGitService: this.workspaceGitService,
        generation: createAgentStructuredTextGeneration({
          agentManager: this.agentManager,
          providerSnapshotManager,
          readDaemonConfig: () => this.readStructuredGenerationDaemonConfig(),
          getFocusedSelection: (cwd) => this.getFocusedAgentSelectionForCwd(cwd),
        }),
      }),
      paseoHome: this.paseoHome,
      worktreesRoot: this.worktreesRoot,
      logger: this.sessionLogger,
    });
    this.workspaceGitObserver = createWorkspaceGitObserverService({
      workspaceGitService: this.workspaceGitService,
      emitWorkspaceUpdateForCwd: (cwd) => this.workspaceSession.emitWorkspaceUpdateForCwd(cwd),
      emitStatusUpdate: (cwd, snapshot) => this.checkoutSession.emitStatusUpdate(cwd, snapshot),
      onBranchChanged,
      logger: this.sessionLogger,
    });
    this.scheduleSession = new ScheduleSession({
      host: { emit: (msg) => this.emit(msg) },
      scheduleService,
      logger: this.sessionLogger,
    });
    this.providerCatalogSession = new ProviderCatalogSession({
      host: {
        emit: (msg) => this.emit(msg),
        isProviderVisibleToClient: (provider) => this.isProviderVisibleToClient(provider),
        supportsCustomModeIcons: () => this.supports(CLIENT_CAPS.customModeIcons),
        supportsCompactProviderSnapshots: () => this.supports(CLIENT_CAPS.compactProviderSnapshots),
        publishSnapshot: (project) => {
          const delivered = new Set<object>();
          for (const subscription of this.eventSubscriptions.values()) {
            if (!subscription.events.has("providers_snapshot_update")) continue;
            const message = this.delivery.forSource(subscription.owner.source, project);
            if (message) subscription.owner.emit(message);
            delivered.add(subscription.owner.source);
          }
          // COMPAT(ownedSubscriptions): added in v0.8.0, remove implicit provider delivery after 2027-03-09.
          for (const source of this.clientSources.keys()) {
            if (
              delivered.has(source) ||
              this.delivery.isModern(source) ||
              !this.wantsEvent("providers_snapshot_update", source)
            )
              continue;
            const message = this.delivery.forSource(source, project);
            if (message) this.onMessageToSource?.(source, message);
          }
        },
        supportsProviderSnapshotReferences: () =>
          this.supports(CLIENT_CAPS.providerSnapshotReferences),
        listProviderAvailability: () => this.agentManager.listProviderAvailability(),
        listDraftFeatures: (config) => this.agentManager.listDraftFeatures(config),
      },
      providerSnapshotManager,
      logger: this.sessionLogger,
    });
    this.usageSession = new UsageSession({
      emit: (msg) => this.emit(msg),
      runtime: pluginRuntime,
      logger: this.sessionLogger,
    });
    this.agentConfigSession = new AgentConfigSession({
      host: {
        emit: (msg) => this.emit(msg),
      },
      operations: {
        ensureLoaded: async (agentId) => {
          await ensureUnarchivedAgentLoaded(agentId, {
            agentManager,
            agentStorage,
            logger: this.sessionLogger,
          });
        },
        setMode: async (agentId, modeId) =>
          (await setAgentModeCommand({ agentManager }, { agentId, modeId })).notice,
        setModel: (agentId, modelId) => agentManager.setAgentModel(agentId, modelId),
        setFeature: (agentId, featureId, value) =>
          agentManager.setAgentFeature(agentId, featureId, value),
        setThinking: (agentId, thinkingOptionId) =>
          agentManager.setAgentThinkingOption(agentId, thinkingOptionId),
        resolveCommandSource: async (agentId) => {
          const existing = agentManager.getAgent(agentId);
          const stored = existing ? null : await agentStorage.get(agentId);
          const agent =
            existing || (stored && !stored.archivedAt)
              ? await ensureAgentLoaded(agentId, {
                  agentManager,
                  agentStorage,
                  logger: this.sessionLogger,
                })
              : null;
          const session = agent?.session;
          const listCommands = session?.listCommands?.bind(session);
          return { found: agent !== null, ...(listCommands ? { listCommands } : {}) };
        },
        listDraftCommands: (draftConfig) =>
          agentManager.listDraftCommands({
            provider: draftConfig.provider,
            cwd: expandTilde(draftConfig.cwd),
            ...(draftConfig.modeId ? { modeId: draftConfig.modeId } : {}),
            ...(draftConfig.model ? { model: draftConfig.model } : {}),
            ...(draftConfig.thinkingOptionId
              ? { thinkingOptionId: draftConfig.thinkingOptionId }
              : {}),
          }),
      },
      logger: this.sessionLogger,
    });
    this.projectConfigSession = new ProjectConfigSession({
      host: {
        emit: (msg) => this.emit(msg),
      },
      projectRegistry: this.projectRegistry,
      logger: this.sessionLogger,
    });
    this.daemonSession = new DaemonSession({
      host: {
        emit: (msg) => this.emit(msg),
        emitLifecycleIntent: (intent) => this.emitLifecycleIntent(intent),
      },
      clientId: this.clientId,
      paseoHome: this.paseoHome,
      serverId,
      daemonVersion,
      daemonRuntimeConfig,
      getWebSocketRuntimeMetrics,
      getObservationMetrics: () => ({
        Registrations: this.delivery.registrationCount,
        "Source registrations": this.delivery.sourceRegistrationCount(),
        "Producer listeners": [
          this.unsubscribeAgentEvents,
          this.unsubscribeProjectMutations,
          this.unsubscribeWorkspaceMutations,
          this.unsubscribePluginChanges,
          this.unsubscribeTerminalWorkspaceContributionEvents,
          this.providerCatalogSession.isObserving,
          this.hubExecutionController?.isObserving,
        ].filter(Boolean).length,
        "Git observations": this.workspaceGitObserver.getMetrics().subscriptionCount,
        "Terminal directories": this.terminalController.getMetrics().directorySubscriptionCount,
        "Terminal output": this.terminalController.getMetrics().streamSubscriptionCount,
      }),
      listProviderAvailability: () => this.agentManager.listProviderAvailability(),
      listAgents: () => this.agentManager.listAgents(),
      listProjects: () => this.projectRegistry.list(),
      listWorkspaces: () => this.workspaceRegistry.list(),
      logger: this.sessionLogger,
      hubRelationships: options.hubRelationships,
      reloadConfig: () => daemonConfigStore.reload(),
    });
    this.hubExecutionController = options.hubExecutionAgents
      ? new HubExecutionController({
          agents: options.hubExecutionAgents,
          validateAgentConfiguration: (input) =>
            providerSnapshotManager.validateAgentConfiguration(input),
          send: (message) => this.emit(message),
        })
      : null;
    this.daemonConfigStore = daemonConfigStore;
    this.terminalManager = terminalManager;
    this.terminalController = new TerminalSessionController({
      terminalManager,
      emit: (msg) => this.emit(msg),
      hasBinaryChannel: () => this.onBinaryMessage !== null,
      isPathWithinRoot: (rootPath, candidatePath) => this.isPathWithinRoot(rootPath, candidatePath),
      sessionLogger: this.sessionLogger,
      listTerminalWorkspaceRefs: () => this.listActiveWorkspaceRefs(),
      clientSupportsWrapReflow: (source) =>
        this.supportsForSource(CLIENT_CAPS.terminalReflowableSnapshot, source),
      getClientBufferedAmount: (source) => this.getTransportBufferedAmount(source),
    });
    this.agentDirectory = new AgentDirectory({
      manager: this.agentManager,
      storage: this.agentStorage,
      workspaces: this.workspaceRegistry,
      projectLive: (agent) => this.buildAgentPayload(agent),
      projectStored: (record) => this.buildStoredAgentPayload(record),
      isProviderVisible: (provider) => this.isProviderVisibleToClient(provider),
      isStoredProviderAvailable: (record) =>
        isStoredAgentProviderAvailable(
          record,
          new Set(this.providerSnapshotManager.listRegisteredProviderIds()),
        ),
    });
    this.agentUpdates = createAgentUpdatesService({
      includesWorkspace: (agent, includeBackground) =>
        this.agentDirectory.includes(agent, includeBackground),
      emit: (message) => this.emit(message),
      enrichAgentPayload: (payload) => this.enrichAgentPayload(payload),
      buildStoredAgentPayload: (record) => this.buildStoredAgentPayload(record),
      isProviderVisibleToClient: (provider) => this.isProviderVisibleToClient(provider),
      buildProjectPlacementForWorkspaceId: (workspaceId) =>
        this.buildProjectPlacementForWorkspaceId(workspaceId),
      emitWorkspaceUpdateForWorkspaceId: (workspaceId) =>
        this.workspaceSession.emitWorkspaceUpdateForWorkspaceId(workspaceId),
      sequenceAgentUpdate: (payload, agent, project, agentId, includeSequence, includeBackground) =>
        this.directorySync.sequenceAgentUpdate(
          payload,
          agent && project ? { agent, project } : null,
          agentId,
          includeSequence,
          includeBackground,
        ),
      logger: this.sessionLogger,
    });
    this.agentLifecycleSession = new AgentLifecycleSession({
      host: {
        emit: (msg) => this.emit(msg),
        forwardLiveAgent: (agent) => this.agentUpdates.forwardLiveAgent(agent),
        buildAgentPayload: (agent) => this.buildAgentPayload(agent),
        registerWorkspaceForImportedAgent: (workspace) =>
          this.registerWorkspaceForImportedAgent(workspace),
        restoreOwningWorkspaceForLegacyAgentRefresh: (agentId) =>
          this.workspaceSession.restoreOwningWorkspaceForLegacyAgentRefresh(agentId),
        interruptAgentIfRunning: (agentId) => this.interruptAgentIfRunning(agentId),
        handleAgentRunError: (agentId, error, context) =>
          this.handleAgentRunError(agentId, error, context),
        listRegisteredProviderIds: () => this.providerSnapshotManager.listRegisteredProviderIds(),
        isProviderVisibleToClient: (provider) => this.isProviderVisibleToClient(provider),
        buildStoredAgentPayload: (record) => this.buildStoredAgentPayload(record),
        buildProjectPlacementForWorkspaceId: (workspaceId) =>
          this.buildProjectPlacementForWorkspaceId(workspaceId),
        buildActiveProjectPlacementsByWorkspaceId: () =>
          this.buildActiveProjectPlacementsByWorkspaceId(),
        listAgentPayloads: (filter) => this.listAgentPayloads(filter),
        refreshObservationProducers: () => this.refreshObservationProducers(),
        emitWorkspaceUpdateForWorkspaceId: (workspaceId) =>
          this.workspaceSession.emitWorkspaceUpdateForWorkspaceId(workspaceId),
        emitWorkspaceUpdatesForWorkspaceIds: (workspaceIds) =>
          this.workspaceSession.emitWorkspaceUpdatesForWorkspaceIds(workspaceIds),
        killTerminalForClose: (terminalId) =>
          this.terminalController.killTerminalForClose(terminalId),
        createRequestedAgent: (request) => this.createRequestedAgent(request),
        createSessionAgent: (msg) => this.createSessionAgent(msg),
      },
      agentManager,
      agentStorage,
      workspaceProvisioning: this.workspaceProvisioning,
      providerSnapshotManager,
      messageReceipts: this.messageReceipts,
      delivery: this.delivery,
      agentUpdates: this.agentUpdates,
      agentDirectory: this.agentDirectory,
      directorySync: this.directorySync,
      logger: this.sessionLogger,
    });
    this.createAgentLifecycleDispatch = new CreateAgentLifecycleDispatch({
      paseoHome: this.paseoHome,
      worktreesRoot: this.worktreesRoot,
      agentManager: this.agentManager,
      agentStorage: this.agentStorage,
      github: this.github,
      workspaceGitService: this.workspaceGitService,
      createPaseoWorktreeWorkflow: (input, workflowOptions) =>
        this.createPaseoWorktreeWorkflow(input, workflowOptions),
      archiveAgentForClose: (agentId) => this.agentLifecycleSession.archiveAgentForClose(agentId),
      findWorkspaceIdForCwd: (cwd) => this.findWorkspaceIdForCwd(cwd),
      listActiveWorkspaces: () => this.listActiveWorkspaceRefs(),
      archiveWorkspaceRecord: (workspaceId) =>
        this.workspaceSession.archiveWorkspaceRecord(workspaceId),
      emit: (message) => this.emit(message),
      emitAgentRemove: (agentId) => this.agentUpdates.removeAgent(agentId),
      emitWorkspaceUpdatesForWorkspaceIds: (workspaceIds) =>
        this.workspaceSession.emitWorkspaceUpdatesForWorkspaceIds(workspaceIds),
      markWorkspaceArchiving: (workspaceIds, archivingAt) =>
        this.workspaceSession.markWorkspaceArchiving(workspaceIds, archivingAt),
      clearWorkspaceArchiving: (workspaceIds) =>
        this.workspaceSession.clearWorkspaceArchiving(workspaceIds),
      killTerminalsForWorkspace: (workspaceId) =>
        this.terminalController.killTerminalsForWorkspace(workspaceId),
      logger: this.sessionLogger,
    });
    this.providerSnapshotManager = providerSnapshotManager;
    this.serviceProxy = serviceProxy ?? null;
    this.scriptRuntimeStore = scriptRuntimeStore ?? null;
    this.workspaceSetupObservation = workspaceSetupObservation ?? new WorkspaceSetupObservation();
    this.unsubscribeSetupObservation = this.workspaceSetupObservation.subscribe(
      (workspaceId, snapshot, statusChanged) => {
        if (statusChanged)
          void this.workspaceSession
            .emitWorkspaceUpdateForWorkspaceId(workspaceId)
            .catch((error) =>
              this.sessionLogger.warn(
                { err: error, workspaceId },
                "Failed to publish setup status",
              ),
            );
        this.emitSubscribedEvent({
          type: "workspace_setup_progress",
          payload: { workspaceId, ...snapshot },
        });
      },
    );
    this.workspaceSetupRuntime = resolveWorkspaceSetupRuntime(workspaceSetupRuntime);
    this.getDaemonTcpPort = getDaemonTcpPort ?? null;
    this.getDaemonTcpHost = getDaemonTcpHost ?? null;
    this.serviceProxyPublicBaseUrl = serviceProxyPublicBaseUrl ?? null;
    this.resolveScriptHealth = resolveScriptHealth ?? null;
    this.workspaceScripts = createWorkspaceScriptsService({
      serviceProxy: this.serviceProxy,
      scriptRuntimeStore: this.scriptRuntimeStore,
      terminalManager: this.terminalManager,
      workspaceRegistry: this.workspaceRegistry,
      projectRegistry: this.projectRegistry,
      workspaceGitService: this.workspaceGitService,
      getDaemonTcpPort: this.getDaemonTcpPort,
      getDaemonTcpHost: this.getDaemonTcpHost,
      serviceProxyPublicBaseUrl: this.serviceProxyPublicBaseUrl,
      resolveScriptHealth: this.resolveScriptHealth,
      logger: this.sessionLogger,
      emit: (message) => this.emit(message),
      publishStatusUpdate: (message) => {
        if (publishScriptStatusUpdate) publishScriptStatusUpdate(message);
        else this.emit(message);
      },
      spawnWorkspaceScript,
      assertAutomationAllowed: (workspaceId) =>
        assertWorkspaceAutomationAllowedForWorkspace(this.workspaceRegistry, workspaceId),
      globalServicePorts: loadPersistedConfig(this.paseoHome).worktrees?.servicePorts,
    });
    this.workspaceDirectory = new WorkspaceDirectory({
      logger: this.sessionLogger,
      projectRegistry: this.projectRegistry,
      workspaceRegistry: this.workspaceRegistry,
      listAgentPayloads: () => this.listAgentPayloads({ includeBackground: true }),
      listProviderSubagentActivity: async () => this.agentManager.listProviderSubagentActivity(),
      listTerminalActivityContributions: () => this.listTerminalActivityContributions(),
      isProviderVisibleToClient: (provider) => this.isProviderVisibleToClient(provider),
      buildWorkspaceDescriptor: (input) => this.workspaceSession.buildWorkspaceDescriptor(input),
    });
    this.workspaceSession = new WorkspaceSession({
      host: {
        emit: (msg) => this.emit(msg),
        wantsEvent: (event) => this.wantsEvent(event),
        isCleanedUp: () => this.isCleanedUp,
        getAppVersion: () => this.appVersion,
        refreshObservationProducers: () => this.refreshObservationProducers(),
        emitProjectUpdate: (update) => this.emitProjectUpdate(update),
        buildProjectPlacementForWorkspace: (workspace, projectRecord) =>
          this.buildProjectPlacementForWorkspace(workspace, projectRecord),
        buildWorkspaceScriptPayloadSnapshot: (workspace, project) =>
          this.buildWorkspaceScriptPayloadSnapshot(workspace, project),
        getWorkspaceSetupStatus: (workspace) => this.workspaceSetupObservation.status(workspace),
      },
      delivery: this.delivery,
      projectRegistry: this.projectRegistry,
      workspaceRegistry: this.workspaceRegistry,
      workspaceGitService: this.workspaceGitService,
      workspaceGitObserver: this.workspaceGitObserver,
      workspaceDirectory: this.workspaceDirectory,
      workspaceRecovery: this.workspaceRecovery,
      directorySync: this.directorySync,
      projectIcons: this.projectIcons,
      agentStorage: this.agentStorage,
      scriptRuntimeStore: this.scriptRuntimeStore,
      paseoHome: this.paseoHome,
      onWorkspaceRecovered,
      logger: this.sessionLogger,
    });

    this.voiceSessions = new VoiceSessions(
      {
        host: {
          emit: (msg) => this.emit(msg),
          loadAgent: (agentId) =>
            ensureAgentLoaded(agentId, {
              agentManager: this.agentManager,
              agentStorage: this.agentStorage,
              logger: this.sessionLogger,
            }),
          reloadAgentSession: (agentId, overrides) =>
            this.agentManager.reloadAgentSession(agentId, overrides),
          sendSpokenInput: async (agentId, text) => {
            await this.handleSendAgentMessage(
              agentId,
              text,
              undefined,
              undefined,
              undefined,
              undefined,
              { spokenInput: true },
            );
          },
          interruptAgentIfRunning: (agentId) => this.interruptAgentIfRunning(agentId),
          hasActiveAgentRun: (agentId) => this.hasActiveAgentRun(agentId),
        },
        logger: this.sessionLogger,
        sessionId: this.sessionId,
        sttLanguage,
        tts,
        stt,
        voice,
        voiceBridge,
        dictation,
      },
      this.delivery,
      () => this.refreshObservationProducers(),
    );

    this.sessionLogger.trace({}, "agent.session.lifecycle.created");
  }

  updateAppVersion(appVersion: string | null): void {
    if (appVersion && appVersion !== this.appVersion) {
      this.appVersion = appVersion;
    }
  }

  updateClientCapabilities(
    capabilities: Record<string, unknown> | null,
    source?: object,
    appVersion = this.appVersion,
  ): void {
    this.clientCapabilities = parseClientCapabilities(capabilities);
    if (source) {
      this.delivery.attach(source, capabilities?.[CLIENT_CAPS.ownedSubscriptions] === true);
      this.clientSources.set(source, {
        capabilities: this.clientCapabilities,
        appVersion,
        activity: this.clientSources.get(source)?.activity ?? null,
        pushToken: this.clientSources.get(source)?.pushToken ?? null,
      });
      this.refreshObservationProducers();
      // COMPAT(ownedSubscriptions): added in v0.8.0, remove capability-driven legacy host registration after 2027-03-09.
      if (
        !this.delivery.isModern(source) &&
        this.authorization.allowsPermission("workspace.write")
      ) {
        const host = BrowserAutomationHostCapabilitySchema.safeParse(capabilities?.browser_host);
        if (host.success && this.browserToolsBroker) {
          const request = {
            type: "browser.host.register.request" as const,
            requestId: uuidv4(),
            hostKind: host.data.hostKind,
            supportedCommands: host.data.supportedCommands,
          };
          void this.delivery
            .request(source, request, () => this.registerBrowserHost(request, false))
            .catch((error) =>
              this.sessionLogger.warn({ err: error }, "Failed to register legacy browser host"),
            );
        }
      }
    }
  }

  clearAgentTimelineSubscription(source: object): void {
    void this.delivery
      .detach(source)
      .catch((err) => this.sessionLogger.error({ err }, "Failed to release source subscriptions"));
    this.clientSources.delete(source);
    this.refreshObservationProducers();
  }

  private subscribeAgentTimelines(agentIds: string[]): OwnedSubscription {
    const owner = this.delivery.begin("timelines", undefined, (id) => {
      this.timelineSubscriptions.delete(id);
      this.refreshObservationProducers();
    });
    this.timelineSubscriptions.set(owner.id, { owner, agentIds: new Set(agentIds) });
    this.refreshObservationProducers();
    return owner;
  }

  // COMPAT(timelineItemCapabilities): plugin items added in v0.8.0, notifications in v0.7.2.
  // Remove after 2027-03-07 once the supported client floor is >= v0.8.0.
  private supportsTimelineItem(item: { type: string }, source?: object): boolean {
    let capability: ClientCapability;
    if (item.type === "notification") capability = CLIENT_CAPS.timelineNotifications;
    else if (item.type === "plugin") capability = CLIENT_CAPS.pluginTimelineItems;
    else return true;
    return source ? this.supportsForSource(capability, source) : this.supports(capability);
  }

  private forwardAgentStream(
    event: Extract<AgentManagerEvent, { type: "agent_stream" }>,
    serializedEvent: Extract<SessionOutboundMessage, { type: "agent_stream" }>["payload"]["event"],
  ): void {
    const attention = serializedEvent.type === "attention_required";
    if (attention) {
      this.emit({
        type: "agent_attention_required",
        payload: {
          agentId: event.agentId,
          reason: serializedEvent.reason,
          timestamp: serializedEvent.timestamp,
          shouldNotify: serializedEvent.shouldNotify,
          ...(serializedEvent.notification ? { notification: serializedEvent.notification } : {}),
        },
      });
    }
    const message: SessionOutboundMessage = {
      type: "agent_stream",
      payload: this.buildAgentStreamPayload(event, serializedEvent),
    };
    for (const subscription of this.timelineSubscriptions.values()) {
      const source = subscription.owner.source;
      if (!subscription.agentIds.has(event.agentId)) continue;
      if (
        attention &&
        (this.delivery.isModern(source) ||
          this.supportsForSource(CLIENT_CAPS.selectiveAgentTimeline, source))
      )
        continue;
      if (
        serializedEvent.type === "timeline" &&
        !this.supportsTimelineItem(serializedEvent.item, source)
      )
        continue;
      subscription.owner.emit(message);
    }
    // COMPAT(ownedSubscriptions): added in v0.8.0, remove implicit timeline delivery after 2027-03-09.
    for (const [source, { capabilities }] of this.clientSources) {
      if (this.delivery.isModern(source) || capabilities.has(CLIENT_CAPS.selectiveAgentTimeline))
        continue;
      if (
        serializedEvent.type === "timeline" &&
        !this.supportsTimelineItem(serializedEvent.item, source)
      )
        continue;
      const alreadyDelivered = [...this.timelineSubscriptions.values()].some(
        (subscription) =>
          subscription.owner.source === source && subscription.agentIds.has(event.agentId),
      );
      if (!alreadyDelivered) this.onMessageToSource?.(source, message);
    }
    if (
      this.clientSources.size === 0 &&
      !this.supports(CLIENT_CAPS.selectiveAgentTimeline) &&
      this.timelineSubscriptions.size === 0
    )
      this.emit(message);
  }

  supports(capability: ClientCapability): boolean {
    const source = this.delivery.currentSource;
    return source
      ? this.supportsForSource(capability, source)
      : this.clientCapabilities.has(capability);
  }

  supportsForSource(capability: ClientCapability, source: object): boolean {
    return (
      this.clientSources.get(source)?.capabilities.has(capability) ??
      this.clientCapabilities.has(capability)
    );
  }

  emitProjectUpdate(update: ProjectUpdate): Promise<void> {
    if (!this.wantsEvent("project.update")) return Promise.resolve();
    const queued = this.projectUpdateQueue
      .catch(() => undefined)
      .then(() => this.publishProjectUpdate(update));
    this.projectUpdateQueue = queued;
    return queued;
  }

  private async publishProjectUpdate(update: ProjectUpdate): Promise<void> {
    if (!this.wantsEvent("project.update")) return;
    const projectedPayload =
      update.kind === "upsert"
        ? {
            kind: "upsert" as const,
            project: await this.workspaceSession.buildProjectDescriptor(update.project),
          }
        : update;
    if (!this.wantsEvent("project.update")) return;
    const message: SessionOutboundMessage = {
      type: "project.update",
      payload: this.directorySync.sequenceProjectUpdate(projectedPayload, true),
    };
    this.emit(message);
  }

  markWorkspaceArchivingForExternalMutation(
    workspaceIds: Iterable<string>,
    archivingAt: string,
  ): void {
    this.workspaceSession.markWorkspaceArchiving(workspaceIds, archivingAt);
  }

  clearWorkspaceArchivingForExternalMutation(workspaceIds: Iterable<string>): void {
    this.workspaceSession.clearWorkspaceArchiving(workspaceIds);
  }

  async emitWorkspaceUpdatesForExternalWorkspaceIds(workspaceIds: Iterable<string>): Promise<void> {
    await this.workspaceSession.emitWorkspaceUpdatesForWorkspaceIds(workspaceIds);
  }

  syncWorkspaceGitObserversForExternalWorkspaceIds(workspaceIds: Iterable<string>): Promise<void> {
    return this.workspaceSession.syncWorkspaceGitObserversForExternalWorkspaceIds(workspaceIds);
  }

  warmWorkspaceGitDataForWorkspace(workspace: PersistedWorkspaceRecord): Promise<void> {
    return this.workspaceSession.warmWorkspaceGitDataForWorkspace(workspace);
  }

  refreshRecoveredWorkspaceForExternalMutation(workspace: PersistedWorkspaceRecord): Promise<void> {
    return this.workspaceSession.refreshRecoveredWorkspaceForExternalMutation(workspace);
  }

  /**
   * Get the client's current activity state
   */
  private currentClientMetadata() {
    const source = this.delivery.currentSource;
    if (!source) throw new Error("Client control has no source");
    let metadata = this.clientSources.get(source);
    if (!metadata) {
      // COMPAT(ownedSubscriptions): added in v0.8.0, remove socketless legacy session adapter after 2027-03-09.
      metadata = {
        capabilities: this.clientCapabilities,
        appVersion: this.appVersion,
        activity: null,
        pushToken: null,
      };
      this.clientSources.set(source, metadata);
    }
    return metadata;
  }

  public getClientActivity(source = this.delivery.currentSource): ClientActivity | null {
    return source ? (this.clientSources.get(source)?.activity ?? null) : null;
  }

  private getFocusedAgentSelectionForCwd(cwd: string):
    | {
        provider?: string | null;
        model?: string | null;
        thinkingOptionId?: string | null;
      }
    | undefined {
    const focusedAgentId = this.getClientActivity()?.focusedAgentId;
    if (!focusedAgentId) {
      return undefined;
    }

    const agent = this.agentManager.getAgent(focusedAgentId);
    if (!agent || agent.cwd !== cwd) {
      return undefined;
    }

    return {
      provider: agent.provider,
      model: agent.runtimeInfo?.model ?? agent.config.model ?? null,
      thinkingOptionId:
        agent.runtimeInfo?.thinkingOptionId ?? agent.config.thinkingOptionId ?? null,
    };
  }

  private readStructuredGenerationDaemonConfig(): StructuredGenerationDaemonConfig {
    return {
      metadataGeneration: this.daemonConfigStore.get().metadataGeneration,
    };
  }

  public getRuntimeMetrics(): SessionRuntimeMetrics {
    const terminalMetrics = this.terminalController.getMetrics();
    const workspaceGitMetrics = this.workspaceGitObserver.getMetrics();
    return {
      terminalDirectorySubscriptionCount: terminalMetrics.directorySubscriptionCount,
      terminalSubscriptionCount: terminalMetrics.streamSubscriptionCount,
      workspaceGitWatchedDirectoryCount: workspaceGitMetrics.watchedDirectoryCount,
      workspaceGitWorkspaceRecordCount: workspaceGitMetrics.workspaceRecordCount,
      workspaceGitSubscriptionCount: workspaceGitMetrics.subscriptionCount,
      inflightRequests: this.inflightRequests,
      peakInflightRequests: this.peakInflightRequests,
    };
  }

  public emitServerMessage(message: SessionOutboundMessage): void {
    this.emit(message);
  }

  /**
   * Send initial state to client after connection
   */
  public async sendInitialState(): Promise<void> {
    // No unsolicited agent list hydration. Callers must use fetch_agents_request.
  }

  /**
   * Interrupt the agent's active run so the next prompt starts a fresh turn.
   * Returns once the manager confirms the stream has been cancelled.
   */
  private async interruptAgentIfRunning(agentId: string): Promise<void> {
    const snapshot = this.agentManager.getAgent(agentId);
    if (!snapshot) {
      this.sessionLogger.trace({ agentId }, "agent.session.interrupt.not_found");
      throw new Error(`Agent ${agentId} not found`);
    }

    const hasInFlightRun = this.agentManager.hasInFlightRun(agentId);
    if (!hasInFlightRun) {
      this.sessionLogger.trace(
        {
          agentId,
          provider: snapshot.provider,
          lifecycle: snapshot.lifecycle,
          hasInFlightRun,
        },
        "agent.session.interrupt.skip_not_running",
      );
      return;
    }

    this.sessionLogger.debug(
      { agentId, lifecycle: snapshot.lifecycle, hasInFlightRun },
      "interruptAgentIfRunning: interrupting",
    );

    const t0 = Date.now();
    const cancellation = await this.agentManager.cancelAgentRun(agentId);
    this.sessionLogger.debug(
      { agentId, cancellation: cancellation.status, durationMs: Date.now() - t0 },
      "interruptAgentIfRunning: cancelAgentRun completed",
    );
    if (cancellation.status === "refused") {
      this.sessionLogger.warn(
        { agentId },
        "interruptAgentIfRunning: reported running but no active run was cancelled",
      );
      throw new AgentRunCancellationError(agentId, "stop");
    }
  }

  private hasActiveAgentRun(agentId: string | null): boolean {
    if (!agentId) {
      return false;
    }
    return this.agentManager.hasInFlightRun(agentId);
  }

  private handleAgentRunError(agentId: string, error: unknown, context: string): void {
    const message = errorToFriendlyMessage(error);
    this.sessionLogger.error({ err: error, agentId, context }, `${context} for agent ${agentId}`);
    this.emit({
      type: "activity_log",
      payload: {
        id: uuidv4(),
        timestamp: new Date(),
        type: "error",
        content: `${context}: ${message}`,
      },
    });
  }

  /**
   * Subscribe to AgentManager events and forward them to the client
   */
  private refreshObservationProducers(): void {
    const legacy = this.delivery.hasLegacySources();
    const workspaces =
      legacy || this.delivery.hasDemand("workspaces") || this.wantsEvent("checkout_status_update");
    const agents =
      workspaces ||
      this.delivery.hasDemand("agents") ||
      this.delivery.hasDemand("timelines") ||
      this.voiceSessions.hasDemand ||
      this.wantsEvent("agent_attention_required") ||
      this.wantsEvent("agent_permission_request") ||
      this.wantsEvent("agent_permission_resolved") ||
      this.wantsEvent("agent.provider_subagents.update");
    if (agents && !this.unsubscribeAgentEvents) this.subscribeToAgentEvents();
    if (!agents) {
      this.unsubscribeAgentEvents?.();
      this.unsubscribeAgentEvents = null;
    }
    this.refreshWorkspaceProducers(workspaces);
    this.refreshCatalogProducers(legacy);
  }

  private refreshWorkspaceProducers(observing: boolean): void {
    if (observing) {
      this.unsubscribeProjectMutations ??=
        this.projectRegistry.subscribeToMutations?.((mutation) =>
          this.enqueueRegistryMutation(() => this.workspaceSession.handleProjectMutation(mutation)),
        ) ?? null;
      this.unsubscribeWorkspaceMutations ??=
        this.workspaceRegistry.subscribeToMutations?.((mutation) =>
          this.enqueueRegistryMutation(() =>
            this.workspaceSession.handleWorkspaceMutation(mutation),
          ),
        ) ?? null;
      this.unsubscribeTerminalWorkspaceContributionEvents ??=
        this.terminalManager?.subscribeTerminalWorkspaceContributionChanged((event) => {
          void this.workspaceSession
            .emitWorkspaceUpdateForTerminalContribution(event)
            .catch((error) =>
              this.sessionLogger.warn(
                { err: error, terminalId: event.terminalId },
                "Failed to emit workspace terminal contribution",
              ),
            );
        }) ?? null;
    } else {
      this.unsubscribeProjectMutations?.();
      this.unsubscribeProjectMutations = null;
      this.unsubscribeWorkspaceMutations?.();
      this.unsubscribeWorkspaceMutations = null;
      this.unsubscribeTerminalWorkspaceContributionEvents?.();
      this.unsubscribeTerminalWorkspaceContributionEvents = null;
    }
  }

  private refreshCatalogProducers(legacy: boolean): void {
    this.hubExecutionController?.setObserving(
      legacy ||
        this.wantsEvent("hub.execution.agent.update") ||
        this.wantsEvent("hub.execution.agent.stream"),
    );
    if (this.wantsEvent("providers_snapshot_update")) this.providerCatalogSession.start();
    else this.providerCatalogSession.dispose();
    if (
      legacy ||
      this.wantsEvent("status.plugin_catalog_changed") ||
      this.wantsEvent("status.plugin_settings_changed")
    )
      this.unsubscribePluginChanges ??= this.subscribeToPluginChanges(this.pluginRuntime);
    else {
      this.unsubscribePluginChanges?.();
      this.unsubscribePluginChanges = null;
    }
  }

  private enqueueRegistryMutation(handleMutation: () => Promise<void>): Promise<void> {
    const next = this.registryMutationQueue.then(handleMutation);
    this.registryMutationQueue = next.catch(() => {});
    return next;
  }

  private supportsSubagentTimelineItem(
    item: AgentTimelineFetchResult["rows"][number]["item"],
    source?: object,
  ): boolean {
    // COMPAT(projectedSubagentTimeline): added after v0.8.0, remove gate after 2027-03-14.
    const supportsProjection = source
      ? this.supportsForSource(CLIENT_CAPS.projectedSubagentTimeline, source)
      : this.supports(CLIENT_CAPS.projectedSubagentTimeline);
    return supportsProjection && this.supportsTimelineItem(item, source);
  }

  private forwardProviderSubagentUpdate(
    update: Extract<AgentManagerEvent, { type: "provider_subagent" }>["event"],
  ): void {
    let message: SessionOutboundMessage;
    if (update.type === "upsert") {
      message = {
        type: "agent.provider_subagents.update",
        payload: { kind: "upsert", subagent: update.subagent },
      };
    } else if (update.type === "timeline") {
      message = {
        type: "agent.provider_subagents.update",
        payload: {
          kind: "timeline",
          parentAgentId: update.parentAgentId,
          subagentId: update.subagentId,
          provider: update.provider,
          item: update.row.item,
          timestamp: update.row.timestamp,
          seq: update.row.seq,
          epoch: update.epoch,
        },
      };
    } else {
      message = {
        type: "agent.provider_subagents.update",
        payload: {
          kind: "remove",
          parentAgentId: update.parentAgentId,
          subagentId: update.subagentId,
        },
      };
    }

    const delivered = new Set<object>();
    for (const subscription of this.eventSubscriptions.values()) {
      if (!subscription.events.has("agent.provider_subagents.update")) continue;
      if (
        update.type === "timeline" &&
        !this.supportsSubagentTimelineItem(update.row.item, subscription.owner.source)
      )
        continue;
      subscription.owner.emit(message);
      delivered.add(subscription.owner.source);
    }
    if (this.clientSources.size === 0 || !this.onMessageToSource) {
      if (
        this.supports(CLIENT_CAPS.providerSubagents) &&
        (update.type !== "timeline" || this.supportsSubagentTimelineItem(update.row.item))
      ) {
        this.emit(message);
      }
      return;
    }
    for (const [source, { capabilities }] of this.clientSources) {
      if (
        delivered.has(source) ||
        this.delivery.isModern(source) ||
        !capabilities.has(CLIENT_CAPS.providerSubagents)
      )
        continue;
      if (update.type === "timeline" && !this.supportsSubagentTimelineItem(update.row.item, source))
        continue;
      this.onMessageToSource(source, message);
    }
  }

  private subscribeToAgentEvents(): void {
    if (this.unsubscribeAgentEvents) {
      this.unsubscribeAgentEvents();
    }

    this.unsubscribeAgentEvents = this.agentManager.subscribe(
      (event) => {
        if (event.type === "timeline_replacement") {
          this.deliverTimelineReplacement(event.agentId, this.rewindInitiators.get(event.agentId));
          return;
        }
        if (event.type === "agent_state") {
          this.onAgentUpdate(event);
          return;
        }
        if (event.type === "provider_subagent") {
          this.onProviderSubagentEvent(event);
          return;
        }
        if (this.shouldAutoAllowVoicePermission(event)) {
          this.autoAllowVoicePermission(event);
        }
        this.onStreamEvent(event);
      },
      // Internal agents flow through so exact-id subscribers and opted-in
      // listings see them; everything else above filters them out.
      { replayState: false, includeInternal: true },
    );
  }

  private onAgentUpdate(event: Extract<AgentManagerEvent, { type: "agent_state" }>): void {
    this.sessionLogger.trace(
      {
        agentId: event.agent.id,
        provider: event.agent.provider,
        providerSessionId: event.agent.persistence?.sessionId ?? undefined,
        turnId: event.agent.activeForegroundTurnId ?? undefined,
        lifecycle: event.agent.lifecycle,
      },
      "agent.session.forward_update",
    );
    void this.agentUpdates.forwardLiveAgent(event.agent);
  }

  private onProviderSubagentEvent(
    event: Extract<AgentManagerEvent, { type: "provider_subagent" }>,
  ): void {
    // The subagents track of an internal parent stays hidden.
    const parentAgentId =
      event.event.type === "upsert"
        ? event.event.subagent.parentAgentId
        : event.event.parentAgentId;
    if (this.agentManager.getAgent(parentAgentId)?.internal) return;
    this.emitProviderSubagentWorkspaceUpdate(event.event);
    this.forwardProviderSubagentUpdate(event.event);
  }

  private shouldAutoAllowVoicePermission(
    event: Extract<AgentManagerEvent, { type: "agent_stream" }>,
  ): boolean {
    return shouldAutoAllowVoicePermission({
      voiceActiveForAgent: this.voiceSessions.isActiveForAgent(event.agentId),
      event: event.event,
    });
  }

  private autoAllowVoicePermission(
    event: Extract<AgentManagerEvent, { type: "agent_stream" }>,
  ): void {
    if (event.event.type !== "permission_requested") return;
    const requestId = event.event.request.id;
    void this.agentManager
      .respondToPermission(event.agentId, requestId, {
        behavior: "allow",
      })
      .catch((error) => {
        this.sessionLogger.warn(
          {
            err: error,
            agentId: event.agentId,
            requestId,
          },
          "Failed to auto-allow speak tool permission in voice mode",
        );
      });
  }

  private onStreamEvent(event: Extract<AgentManagerEvent, { type: "agent_stream" }>): void {
    const serializedEvent = serializeAgentStreamEvent(event.event);
    if (!serializedEvent) {
      return;
    }
    this.sessionLogger.trace(
      {
        agentId: event.agentId,
        provider: event.event.provider,
        turnId: getAgentStreamEventTurnId(event.event),
        seq: event.seq,
        epoch: event.epoch,
        event: event.event,
      },
      "agent.session.forward_stream",
    );

    this.forwardAgentStream(event, serializedEvent);

    // An internal agent streams only to clients subscribed to it by id;
    // session-wide prompts would surface it everywhere.
    const internal = this.agentManager.getAgent(event.agentId)?.internal === true;
    if (event.event.type === "permission_requested" && !internal) {
      this.emit({
        type: "agent_permission_request",
        payload: {
          agentId: event.agentId,
          request: event.event.request,
        },
      });
    } else if (event.event.type === "permission_resolved") {
      // A provider event is not the outcome of whichever request is currently running.
      this.emitSubscribedEvent({
        type: "agent_permission_resolved",
        payload: {
          agentId: event.agentId,
          requestId: event.event.requestId,
          resolution: event.event.resolution,
        },
      });
    }
  }

  private emitProviderSubagentWorkspaceUpdate(event: ProviderSubagentManagerEvent): void {
    if (event.type === "timeline") {
      return;
    }
    const parentAgentId =
      event.type === "upsert" ? event.subagent.parentAgentId : event.parentAgentId;
    const parent = this.agentManager.getAgent(parentAgentId);
    if (!parent?.workspaceId) {
      return;
    }
    void this.workspaceSession
      .emitWorkspaceUpdateForWorkspaceId(parent.workspaceId)
      .catch((error) => {
        this.sessionLogger.error(
          { err: error, parentAgentId, workspaceId: parent.workspaceId },
          "Failed to emit provider subagent workspace update",
        );
      });
  }

  private buildAgentStreamPayload(
    event: Extract<AgentManagerEvent, { type: "agent_stream" }>,
    serializedEvent: Extract<SessionOutboundMessage, { type: "agent_stream" }>["payload"]["event"],
  ): Extract<SessionOutboundMessage, { type: "agent_stream" }>["payload"] {
    return {
      agentId: event.agentId,
      event: serializedEvent,
      timestamp: event.timestamp ?? new Date().toISOString(),
      ...(typeof event.seq === "number" ? { seq: event.seq } : {}),
      ...(typeof event.epoch === "string" ? { epoch: event.epoch } : {}),
    };
  }

  private async enrichAgentPayload(payload: AgentSnapshotPayload): Promise<AgentSnapshotPayload> {
    const storedRecord = await this.agentStorage.get(payload.id);
    payload.title = storedRecord?.title ?? null;
    payload.archivedAt = storedRecord?.archivedAt ?? null;
    return payload;
  }

  private buildAgentPayload(agent: ManagedAgent): Promise<AgentSnapshotPayload> {
    return this.enrichAgentPayload(toAgentPayload(agent));
  }

  private buildStoredAgentPayload(
    record: StoredAgentRecord,
    registeredProviderIds = new Set(this.providerSnapshotManager.listRegisteredProviderIds()),
  ): AgentSnapshotPayload {
    return buildStoredAgentPayload(record, registeredProviderIds);
  }

  private isProviderVisibleToClient(provider: string): boolean {
    if (
      this.supports(CLIENT_CAPS.allProviders) ||
      clientSupportsAllProviders(
        this.delivery.currentSource
          ? (this.clientSources.get(this.delivery.currentSource)?.appVersion ?? null)
          : this.appVersion,
      )
    ) {
      return true;
    }
    return LEGACY_PROVIDER_IDS.has(provider);
  }

  private async buildProjectPlacementForWorkspace(
    workspace: PersistedWorkspaceRecord,
    projectRecord?: PersistedProjectRecord | null,
  ): Promise<ProjectPlacementPayload> {
    const project = projectRecord ?? (await this.projectRegistry.get(workspace.projectId));
    if (!project) {
      throw new Error(`Project not found for workspace ${workspace.workspaceId}`);
    }
    const snapshot = this.workspaceGitService.peekSnapshot(workspace.cwd);
    const checkout = checkoutFromPersistedWorkspacePlacement({
      workspace,
      // COMPAT(workspacePlacementBackfill): added in v0.1.107, remove after 2027-01-15.
      // Legacy records can lack branch and worktreeRoot because persisted registries
      // are not migrated in place.
      fallbackBranch: snapshot?.git.currentBranch ?? null,
      fallbackWorktreeRoot: snapshot?.git.repoRoot,
    });
    return {
      projectKey: project.projectId,
      projectName: resolveProjectDisplayName(project),
      workspaceName: resolveWorkspaceDisplayName(workspace),
      checkout,
    };
  }

  private async buildProjectPlacementForWorkspaceId(
    workspaceId: string,
  ): Promise<ProjectPlacementPayload | null> {
    const workspace = await this.workspaceRegistry.get(workspaceId);
    if (!workspace) return null;

    const project = await this.projectRegistry.get(workspace.projectId);
    if (!project) return null;
    return this.buildProjectPlacementForWorkspace(workspace, project);
  }

  /**
   * Main entry point for processing session messages
   */
  public async handleMessage(msg: SessionInboundMessage, source?: object): Promise<void> {
    return this.delivery.request(source, msg, () => this.handleRequest(msg, source));
  }

  private async handleRequest(msg: SessionInboundMessage, source?: object): Promise<void> {
    this.inflightRequests++;
    if (this.inflightRequests > this.peakInflightRequests) {
      this.peakInflightRequests = this.inflightRequests;
    }
    try {
      this.sessionLogger.trace(
        {
          messageType: msg.type,
          payloadBytes: JSON.stringify(msg).length,
        },
        "agent.session.inbound",
      );
      if (!this.authorization.allowsInbound(msg)) {
        const requestId = sessionRequestId(msg);
        if (requestId) {
          this.emit({
            type: "rpc_error",
            payload: {
              requestId,
              requestType: msg.type,
              error: `Session is not authorized for ${msg.type}`,
              code: "access_denied",
            },
          });
        }
        return;
      }
      try {
        await this.dispatchInboundMessage(msg, source);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.sessionLogger.error({ err }, "Error handling message");

        const requestId =
          "requestId" in msg && typeof msg.requestId === "string" ? msg.requestId : undefined;
        if (typeof requestId === "string") {
          try {
            this.emit({
              type: "rpc_error",
              payload: {
                requestId,
                requestType: msg.type,
                error: `Request failed: ${err.message}`,
                code: "handler_error",
              },
            });
          } catch (emitError) {
            this.sessionLogger.error({ err: emitError }, "Failed to emit rpc_error");
          }
        }

        this.emit({
          type: "activity_log",
          payload: {
            id: uuidv4(),
            timestamp: new Date(),
            type: "error",
            content: `Error: ${err.message}`,
          },
        });
      }
    } finally {
      this.inflightRequests--;
    }
  }

  public setPermissions(permissions: readonly DaemonPermission[]): void {
    this.authorization.replacePermissions(permissions);
    if (!this.authorization.allowsPermission("workspace.write")) {
      void this.delivery
        .releaseFamily("browser-host")
        .catch((error) =>
          this.sessionLogger.error({ err: error }, "Failed to release revoked browser hosting"),
        );
    }
  }

  public getPermissions(): DaemonPermission[] {
    return this.authorization.listPermissions();
  }

  public allowsInbound(message: SessionInboundMessage): boolean {
    return this.authorization.allowsInbound(message);
  }

  public allowsPermission(permission: DaemonPermission): boolean {
    return this.authorization.allowsPermission(permission);
  }

  public subscribesToAgent(agent: ManagedAgent, source: object): Promise<boolean> {
    return this.agentUpdates.includesLiveAgent(
      agent,
      new Set(this.delivery.subscriptionIds(source, "agents")),
    );
  }

  public subscribesToTerminalDirectory(
    input: {
      cwd: string;
      workspaceId?: string;
    },
    source: object,
  ): Promise<boolean> {
    return this.terminalController.hasDirectorySubscription(input, source);
  }

  public publishToSource(source: object, message: SessionOutboundMessage): void {
    if (!this.authorization.allowsOutbound(message)) return;
    this.emitSubscribedEvent(message, source);
  }

  public wantsSourceEvent(source: object, event: SessionEventSubscription): boolean {
    return this.wantsEvent(event, source);
  }

  public wantsSourceNotification(source: object, event: SessionEventSubscription): boolean {
    // COMPAT(ownedSubscriptions): added in v0.8.0, remove legacy notification selection after 2027-03-09.
    if (!this.delivery.isModern(source)) return true;
    return [...this.eventSubscriptions.values()].some(
      (subscription) =>
        subscription.owner.source === source &&
        subscription.notifications &&
        subscription.events.has(event),
    );
  }

  public publish(message: SessionOutboundMessage): void {
    this.emit(message);
  }

  private async registerBrowserHost(
    request: Extract<SessionInboundMessage, { type: "browser.host.register.request" }>,
    respond = true,
  ): Promise<void> {
    if (!this.browserToolsBroker) throw new Error("Browser hosting is unavailable");
    let unregister: (() => void) | undefined;
    const owner = this.delivery.begin("browser-host", undefined, () => unregister?.());
    try {
      unregister = this.browserToolsBroker.registerClient({
        id: owner.id,
        hostKind: request.hostKind,
        supportedCommands: request.supportedCommands,
        sendBrowserAutomationRequest: (message) => owner.emit(message),
      });
      if (respond)
        this.emit({
          type: "browser.host.register.response",
          payload: { requestId: request.requestId, subscriptionId: owner.responseId },
        });
    } catch (error) {
      await owner.release();
      throw error;
    }
  }

  private async subscribeWorkspaceSetup(
    request: Extract<SessionInboundMessage, { type: "workspace.setup.subscribe.request" }>,
  ): Promise<void> {
    if (
      !this.supports(CLIENT_CAPS.workspaceSetupObservation) ||
      !this.delivery.isModern(this.delivery.currentSource)
    )
      throw new Error("Workspace setup observation requires owned subscriptions");
    // Resolve persisted blocked state first. Register and read the current cache in one
    // synchronous turn afterward, so a setup transition during this read cannot be lost.
    let initial: WorkspaceSetupSnapshot | null = null;
    await handleWorkspaceSetupStatusRequestMessage(
      {
        workspaceSetupSnapshots: this.workspaceSetupObservation,
        getWorkspace: (id) => this.workspaceRegistry.get(id),
        emit: (message) => {
          if (message.type === "workspace_setup_status_response")
            initial = message.payload.snapshot;
        },
      },
      { ...request, type: "workspace_setup_status_request" },
    );
    let stop: (() => void) | undefined;
    const owner = this.delivery.begin("workspace-setup", undefined, () => stop?.());
    stop = this.workspaceSetupObservation.subscribe((workspaceId, snapshot) => {
      if (workspaceId === request.workspaceId)
        owner.emit({ type: "workspace_setup_progress", payload: { workspaceId, ...snapshot } });
    });
    this.emit({
      type: "workspace.setup.subscribe.response",
      payload: {
        requestId: request.requestId,
        subscriptionId: owner.responseId,
        workspaceId: request.workspaceId,
        snapshot: this.workspaceSetupObservation.get(request.workspaceId) ?? initial,
      },
    });
  }

  private dispatchSubscriptionMessage(
    msg: SessionInboundMessage,
    source?: object,
  ): Promise<void> | undefined {
    if (msg.type === "workspace.setup.subscribe.request") return this.subscribeWorkspaceSetup(msg);
    if (msg.type === "browser.host.register.request") return this.registerBrowserHost(msg);
    if (msg.type === "browser.automation.execute.response") {
      if (source)
        this.browserToolsBroker?.receiveResponse(
          msg,
          this.delivery.subscriptionIds(source, "browser-host"),
        );
      return Promise.resolve();
    }
    if (msg.type === "subscription.release.request") {
      return this.delivery.release(msg.subscriptionId).then(() => {
        this.emit({
          type: "subscription.release.response",
          payload: { requestId: msg.requestId, subscriptionId: msg.subscriptionId },
        });
        return undefined;
      });
    }
    return undefined;
  }

  private async dispatchInboundMessage(msg: SessionInboundMessage, source?: object): Promise<void> {
    const promise =
      this.dispatchSubscriptionMessage(msg, source) ??
      this.dispatchVoiceAndControlMessage(msg) ??
      this.dispatchAgentRewindMessage(msg, source) ??
      this.dispatchAgentRelationshipMessage(msg) ??
      this.dispatchAgentTimelineMessage(msg, source) ??
      this.dispatchHubExecutionMessage(msg) ??
      this.dispatchCreationMessage(msg, source) ??
      this.dispatchAgentLifecycleMessage(msg) ??
      this.dispatchAgentConfigMessage(msg) ??
      this.dispatchCheckoutMessage(msg) ??
      this.dispatchWorkspaceLifecycleMessage(msg) ??
      this.dispatchWorkspaceFileMessage(msg, source) ??
      this.dispatchProviderMessage(msg) ??
      this.dispatchOrchestrationSkillsMessage(msg) ??
      this.dispatchPluginDirectoryMessage(msg) ??
      this.dispatchPluginMessage(msg) ??
      this.dispatchTerminalMessage(msg) ??
      this.dispatchScheduleMessage(msg) ??
      this.dispatchMiscMessage(msg);
    if (promise) await promise;
  }

  private dispatchWorkspaceLifecycleMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    return (
      this.dispatchWorkspaceStateMessage(msg) ??
      this.dispatchWorkspaceLabelMessage(msg) ??
      this.dispatchWorkspaceSetupMessage(msg) ??
      this.dispatchWorkspaceAndProjectMessage(msg)
    );
  }

  private dispatchOrchestrationSkillsMessage(
    msg: SessionInboundMessage,
  ): Promise<void> | undefined {
    if (!this.orchestrationSkills || !msg.type.startsWith("agent.skills.")) return undefined;
    const emitStatus = (
      type:
        | "agent.skills.get_status.response"
        | "agent.skills.reconcile.response"
        | "agent.skills.uninstall.response",
      requestId: string,
      operation: Promise<import("./orchestration-skills/index.js").SkillsSnapshot>,
    ) =>
      operation.then((status) => {
        this.emit({ type, payload: { requestId, ...status } });
        return undefined;
      });
    switch (msg.type) {
      case "agent.skills.get_status.request":
        return emitStatus(
          "agent.skills.get_status.response",
          msg.requestId,
          this.orchestrationSkills.getStatus(),
        );
      case "agent.skills.reconcile.request":
        return emitStatus(
          "agent.skills.reconcile.response",
          msg.requestId,
          this.orchestrationSkills.reconcile(),
        );
      case "agent.skills.uninstall.request":
        return emitStatus(
          "agent.skills.uninstall.response",
          msg.requestId,
          this.orchestrationSkills.uninstall(),
        );
      case "agent.skills.save_selection.request":
        return this.orchestrationSkills
          .saveSelection(msg.selection, msg.confirmedRemovals)
          .then((result) => {
            this.emit({
              type: "agent.skills.save_selection.response",
              payload: { requestId: msg.requestId, ...result },
            });
            return undefined;
          });
      case "agent.skills.import_legacy_selection.request":
        return this.orchestrationSkills
          .importLegacySelectionIfUnset(msg.selection)
          .then((result) => {
            this.emit({
              type: "agent.skills.import_legacy_selection.response",
              payload: { requestId: msg.requestId, ...result },
            });
            return undefined;
          });
      default:
        return undefined;
    }
  }

  private dispatchPluginMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    if (msg.type === "plugin.list.request") {
      return (this.pluginRuntime?.listPlugins() ?? Promise.resolve([])).then((plugins) => {
        this.emit({
          type: "plugin.list.response",
          payload: { requestId: msg.requestId, plugins },
        });
        return undefined;
      });
    }
    if (msg.type === "plugin.logs.get.request") {
      if (!this.pluginRuntime) throw new Error("Plugin service is unavailable");
      this.emit({
        type: "plugin.logs.get.response",
        payload: {
          requestId: msg.requestId,
          pluginId: msg.pluginId,
          entries: this.pluginRuntime.getLogs(msg.pluginId),
        },
      });
      return undefined;
    }
    if (msg.type === "plugin.reload.request") {
      if (!this.pluginRuntime) throw new Error("Plugin service is unavailable");
      return this.pluginRuntime.reloadPlugin(msg.pluginId).then((plugin) => {
        this.emit({
          type: "plugin.reload.response",
          payload: { requestId: msg.requestId, plugin },
        });
        return undefined;
      });
    }
    if (msg.type === "plugin.enable.request") {
      if (!this.pluginRuntime) throw new Error("Plugin service is unavailable");
      return this.pluginRuntime.enablePlugin(msg.pluginId).then((plugin) => {
        this.emit({
          type: "plugin.enable.response",
          payload: { requestId: msg.requestId, plugin },
        });
        return undefined;
      });
    }
    if (msg.type === "plugin.disable.request") {
      if (!this.pluginRuntime) throw new Error("Plugin service is unavailable");
      return this.pluginRuntime.disablePlugin(msg.pluginId).then((plugin) => {
        this.emit({
          type: "plugin.disable.response",
          payload: { requestId: msg.requestId, plugin },
        });
        return undefined;
      });
    }
    if (msg.type === "plugin.remove.request") {
      if (!this.pluginRuntime) throw new Error("Plugin service is unavailable");
      return this.pluginRuntime.removePlugin(msg.pluginId).then(() => {
        this.emit({ type: "plugin.remove.response", payload: { requestId: msg.requestId } });
        return undefined;
      });
    }
    if (msg.type === "plugin.catalog.get.request") {
      this.emit({
        type: "plugin.catalog.get.response",
        payload: {
          requestId: msg.requestId,
          plugins: this.pluginRuntime?.catalog() ?? [],
        },
      });
      return undefined;
    }
    if (msg.type === "plugin.rpc.invoke.request") {
      if (!this.pluginRuntime) throw new Error("Plugin service is unavailable");
      return this.pluginRuntime
        .invokePluginRpc(msg.pluginId, msg.method, msg.input)
        .then((output) => {
          this.emit({
            type: "plugin.rpc.invoke.response",
            payload: { requestId: msg.requestId, output },
          });
          return undefined;
        });
    }
    return undefined;
  }

  private dispatchPluginDirectoryMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    if (msg.type === "plugin.source.install.request") {
      if (!this.pluginRuntime) throw new Error("Plugin service is unavailable");
      return this.pluginRuntime
        .installSource({
          // COMPAT(plugin-source-path): accepted for v0.7 clients; remove after 2027-09-01.
          source: formatPluginSourceReference(msg.source, msg.pluginPath),
          ...(msg.id ? { id: msg.id } : {}),
          ...(msg.ref ? { ref: msg.ref } : {}),
        })
        .then((plugin) => {
          this.emit({
            type: "plugin.source.install.response",
            payload: { requestId: msg.requestId, plugin },
          });
          return undefined;
        });
    }
    if (msg.type === "plugin.source.status.request") {
      if (!this.pluginRuntime) throw new Error("Plugin service is unavailable");
      return this.pluginRuntime.statusSources(msg.pluginId).then((plugins) => {
        this.emit({
          type: "plugin.source.status.response",
          payload: { requestId: msg.requestId, plugins },
        });
        return undefined;
      });
    }
    if (msg.type === "plugin.source.update.preview.request") {
      if (!this.pluginRuntime) throw new Error("Plugin service is unavailable");
      return this.pluginRuntime
        .previewUpdates({ pluginId: msg.pluginId, target: msg.target })
        .then((plugins) => {
          this.emit({
            type: "plugin.source.update.preview.response",
            payload: { requestId: msg.requestId, plugins },
          });
          return undefined;
        });
    }
    if (msg.type === "plugin.source.update.apply.request") {
      if (!this.pluginRuntime) throw new Error("Plugin service is unavailable");
      return this.pluginRuntime.applyUpdates(msg.proposals).then((plugins) => {
        this.emit({
          type: "plugin.source.update.apply.response",
          payload: { requestId: msg.requestId, plugins },
        });
        return undefined;
      });
    }
    if (msg.type === "plugin.source.update.request") {
      if (!this.pluginRuntime) throw new Error("Plugin service is unavailable");
      return this.pluginRuntime.updateSources(msg.pluginId).then((plugins) => {
        this.emit({
          type: "plugin.source.update.response",
          payload: { requestId: msg.requestId, plugins },
        });
        return undefined;
      });
    }
    if (msg.type === "plugin.directory.install.request") {
      if (!this.pluginRuntime) throw new Error("Plugin service is unavailable");
      return this.pluginRuntime.installDirectory({ path: msg.path, id: msg.id }).then((plugin) => {
        this.emit({
          type: "plugin.directory.install.response",
          payload: { requestId: msg.requestId, plugin },
        });
        return undefined;
      });
    }
    if (msg.type === "plugin.directory.inspect.request") {
      if (!this.pluginRuntime) throw new Error("Plugin service is unavailable");
      return this.pluginRuntime.inspectDirectory(msg.path).then(({ id }) => {
        this.emit({
          type: "plugin.directory.inspect.response",
          payload: { requestId: msg.requestId, id },
        });
        return undefined;
      });
    }
    return undefined;
  }

  private subscribeToPluginChanges(
    pluginRuntime: SessionOptions["pluginRuntime"],
  ): (() => void) | null {
    if (!pluginRuntime) return null;
    const catalog = pluginRuntime.subscribe((pluginId) => {
      this.emit({ type: "status", payload: { status: "plugin_catalog_changed", pluginId } });
    });
    const settings = pluginRuntime.subscribeSettings?.((pluginId, settingsId) => {
      this.emit({
        type: "status",
        payload: { status: "plugin_settings_changed", pluginId, settingsId },
      });
    });
    return () => {
      catalog();
      settings?.();
    };
  }

  private dispatchVoiceAndControlMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    switch (msg.type) {
      case "voice_audio_chunk":
      case "abort_request":
      case "audio_played":
      case "set_voice_mode":
      case "dictation_stream_start":
      case "dictation_stream_chunk":
      case "dictation_stream_finish":
      case "dictation_stream_cancel":
        return this.voiceSessions.handleMessage(msg);
      case "restart_server_request":
        return this.handleRestartServerRequest(msg.requestId, msg.reason);
      case "shutdown_server_request":
        return this.handleShutdownServerRequest(msg.requestId);
      case "client_heartbeat":
        this.handleClientHeartbeat(msg);
        return undefined;
      case "ping": {
        const now = Date.now();
        this.emit({
          type: "pong",
          payload: {
            requestId: msg.requestId,
            clientSentAt: msg.clientSentAt,
            serverReceivedAt: now,
            serverSentAt: now,
          },
        });
        return undefined;
      }
      default:
        return undefined;
    }
  }

  private dispatchAgentRewindMessage(
    msg: SessionInboundMessage,
    source?: object,
  ): Promise<void> | undefined {
    switch (msg.type) {
      case "agent.rewind.request":
        return this.handleAgentRewindRequest(msg, source);
      default:
        return undefined;
    }
  }

  private dispatchAgentRelationshipMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    switch (msg.type) {
      case "agent.detach.request":
        return this.agentLifecycleSession.handleDetachAgentRequest(msg.agentId, msg.requestId);
      default:
        return undefined;
    }
  }

  private dispatchAgentTimelineMessage(
    msg: SessionInboundMessage,
    source?: object,
  ): Promise<void> | undefined {
    switch (msg.type) {
      case "fetch_agent_timeline_request":
        return this.handleFetchAgentTimelineRequest(msg, source);
      case "agent.timeline.append.request":
        return this.handleAgentTimelineAppendRequest(msg);
      case "agent.timeline.search.request":
        return this.handleAgentTimelineSearchRequest(msg, source);
      case "agent.timeline.list_prompts.request":
        return this.handleAgentTimelineListPromptsRequest(msg, source);
      case "agent.provider_subagents.list.request":
        return this.handleProviderSubagentListRequest(msg);
      case "agent.provider_subagents.timeline.get.request":
        return this.handleProviderSubagentTimelineRequest(msg, source);
      case "session.events.set_subscription.request": {
        const owner = this.delivery.begin("events", undefined, async (id) => {
          this.eventSubscriptions.delete(id);
          this.refreshObservationProducers();
          if (msg.events.includes("checkout_status_update"))
            await this.workspaceSession.reconcileWorkspaceGitObservers();
        });
        this.eventSubscriptions.set(owner.id, {
          owner,
          events: new Set(msg.events),
          notifications: msg.notifications === true,
        });
        this.emitForSource(
          {
            type: "session.events.set_subscription.response",
            payload: { requestId: msg.requestId, subscriptionId: owner.responseId },
          },
          source,
        );
        this.refreshObservationProducers();
        if (!msg.events.includes("checkout_status_update")) return undefined;
        return this.workspaceSession.reconcileWorkspaceGitObservers().catch(async (error) => {
          await owner.release();
          throw error;
        });
      }
      case "agent.timeline.set_subscription.request": {
        const agentIds = [...new Set(msg.agentIds)].sort();
        const owner = this.subscribeAgentTimelines(agentIds);
        this.emitForSource(
          {
            type: "agent.timeline.set_subscription.response",
            payload: { agentIds, requestId: msg.requestId, subscriptionId: owner.responseId },
          },
          source,
        );
        return undefined;
      }
      case "agent.fork_context.request":
        return this.handleAgentForkContextRequest(msg);
      default:
        return undefined;
    }
  }

  private dispatchHubExecutionMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    if (msg.type === "hub.execution.agent.create.request") {
      return this.hubExecutionController?.createAgent(msg);
    }
    if (msg.type === "hub.execution.agent.validate.request") {
      return this.hubExecutionController?.validateAgent(msg);
    }
    if (msg.type === "hub.execution.control.request") {
      return this.hubExecutionController?.controlExecution(msg);
    }
    return undefined;
  }

  private dispatchCreationMessage(
    msg: SessionInboundMessage,
    source?: object,
  ): Promise<void> | undefined {
    switch (msg.type) {
      case "agent.create.request":
        return this.handleAgentCreation(msg, source);
      case "creation.subscribe.request":
        return this.handleCreationSubscription(msg, source);
      case "workspace.create.request":
        return this.handleWorkspaceCreation(msg, source);
      default:
        return undefined;
    }
  }

  private dispatchAgentLifecycleMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    switch (msg.type) {
      case "fetch_agents_request":
        return this.agentLifecycleSession.handleFetchAgents(msg);
      case "fetch_agent_history_request":
        return this.agentLifecycleSession.handleFetchAgentHistory(msg);
      case "fetch_recent_provider_sessions_request":
        return this.agentLifecycleSession.handleFetchRecentProviderSessions(msg);
      case "fetch_agent_request":
        return this.agentLifecycleSession.handleFetchAgent(msg.agentId, msg.requestId);
      case "delete_agent_request":
        return this.agentLifecycleSession.handleDeleteAgentRequest(msg.agentId, msg.requestId);
      case "archive_agent_request":
        return this.agentLifecycleSession.handleArchiveAgentRequest(msg.agentId, msg.requestId);
      case "close_items_request":
        return this.agentLifecycleSession.handleCloseItemsRequest(msg);
      case "update_agent_request":
        return this.agentLifecycleSession.handleUpdateAgentRequest(
          msg.agentId,
          msg.name,
          msg.labels,
          msg.requestId,
        );
      case "project.rename.request":
        return this.workspaceSession.handleProjectRenameRequest(
          msg.projectId,
          msg.customName,
          msg.requestId,
        );
      case "project.icon.set.request":
        return this.workspaceSession.handleProjectIconSetRequest(msg);
      case "send_agent_message_request":
        return this.agentLifecycleSession.handleSendAgentMessageRequest(msg);
      case "wait_for_finish_request":
        return this.agentLifecycleSession.handleWaitForFinish(
          msg.agentId,
          msg.requestId,
          msg.timeoutMs,
        );
      case "create_agent_request":
        return this.agentLifecycleSession.handleCreateAgentRequest(msg);
      case "resume_agent_request":
        return this.agentLifecycleSession.handleResumeAgentRequest(msg);
      case "import_agent_request":
        return this.agentLifecycleSession.handleImportAgentRequest(msg);
      case "refresh_agent_request":
        return this.agentLifecycleSession.handleRefreshAgentRequest(msg);
      case "cancel_agent_request":
        return this.agentLifecycleSession.handleCancelAgentRequest(msg.agentId, msg.requestId);
      case "agent_permission_response":
        return this.agentLifecycleSession.handleAgentPermissionResponse(
          msg.agentId,
          msg.requestId,
          msg.response,
        );
      case "clear_agent_attention":
        return this.agentLifecycleSession.handleClearAgentAttention(msg.agentId, msg.requestId);
      default:
        return undefined;
    }
  }

  private dispatchAgentConfigMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    switch (msg.type) {
      case "set_agent_mode_request":
        return this.agentConfigSession.handleSetAgentModeRequest(msg);
      case "set_agent_model_request":
        return this.agentConfigSession.handleSetAgentModelRequest(msg);
      case "set_agent_feature_request":
        return this.agentConfigSession.handleSetAgentFeatureRequest(msg);
      case "set_agent_thinking_request":
        return this.agentConfigSession.handleSetAgentThinkingRequest(msg);
      case "agent.config.apply.request":
        return this.agentConfigSession.handleAgentConfigApplyRequest(msg);
      case "list_commands_request":
        return this.agentConfigSession.handleListCommandsRequest(msg);
      case "get_daemon_config_request":
        this.emit({
          type: "get_daemon_config_response",
          payload: { requestId: msg.requestId, config: this.daemonConfigStore.get() },
        });
        return undefined;
      case "daemon.get_status.request":
        return this.daemonSession.handleGetStatusRequest(msg);
      case "daemon.get_pairing_offer.request":
        return this.daemonSession.handleGetPairingOfferRequest(msg);
      case "daemon.config.reload.request":
        this.daemonSession.handleConfigReloadRequest(msg);
        return undefined;
      case "hub.management.daemon.connect.request":
      case "hub.management.daemon.get_status.request":
      case "hub.management.daemon.disconnect.request":
      case "hub.management.daemon.permissions.update.request":
        return this.daemonSession.handleHubRelationshipRequest(msg);
      case "diagnostics.request":
        return this.daemonSession.handleDiagnosticsRequest(msg);
      case "daemon.update.request":
        return this.daemonSession.handleUpdateRequest(msg);
      case "set_daemon_config_request":
        this.emit({
          type: "set_daemon_config_response",
          payload: {
            requestId: msg.requestId,
            config: this.daemonConfigStore.patch(msg.config),
          },
        });
        return undefined;
      case "read_project_config_request":
        return this.projectConfigSession.handleReadProjectConfigRequest(msg);
      case "write_project_config_request":
        return this.projectConfigSession.handleWriteProjectConfigRequest(msg);
      default:
        return undefined;
    }
  }

  // eslint-disable-next-line complexity
  private dispatchCheckoutMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    switch (msg.type) {
      case "checkout_status_request":
        return this.checkoutSession.handleStatusRequest(msg);
      case "checkout.commits.list.request":
        return this.checkoutSession.handleCommitsListRequest(msg);
      case "checkout.commits.file_diff.request":
        return this.checkoutSession.handleCommitFileDiffRequest(msg);
      case "validate_branch_request":
        return this.checkoutSession.handleValidateBranchRequest(msg);
      case "branch_suggestions_request":
        return this.checkoutSession.handleBranchSuggestionsRequest(msg);
      case "directory_suggestions_request":
        return this.workspaceSession.handleDirectorySuggestions(msg);
      case "checkout.diff.get.request":
        return this.checkoutSession.handleReadDiffRequest(msg);
      case "subscribe_checkout_diff_request":
        return this.checkoutSession.handleSubscribeDiffRequest(msg, this.delivery);
      case "unsubscribe_checkout_diff_request":
        return this.checkoutSession.handleUnsubscribeDiffRequest(msg, this.delivery);
      case "checkout_switch_branch_request":
        return this.checkoutSession.handleCheckoutSwitchBranchRequest(msg);
      case "checkout.rename_branch.request":
        return this.checkoutSession.handleCheckoutRenameBranchRequest(msg);
      case "checkout_commit_request":
        return this.checkoutSession.handleCheckoutCommitRequest(msg);
      case "checkout_merge_request":
        return this.checkoutSession.handleCheckoutMergeRequest(msg);
      case "checkout_merge_from_base_request":
        return this.checkoutSession.handleCheckoutMergeFromBaseRequest(msg);
      case "checkout_pull_request":
        return this.checkoutSession.handleCheckoutPullRequest(msg);
      case "checkout_push_request":
        return this.checkoutSession.handleCheckoutPushRequest(msg);
      case "checkout.refresh.request":
        return this.checkoutSession.handleRefreshRequest(msg);
      case "checkout.discard_changes.request":
        return this.checkoutSession.handleCheckoutDiscardChangesRequest(msg);
      case "checkout_pr_create_request":
        return this.checkoutSession.handleCheckoutPrCreateRequest(msg);
      case "checkout_pr_merge_request":
        return this.checkoutSession.handleCheckoutPrMergeRequest(msg);
      case "checkout.forge.set_auto_merge.request":
      case "checkout.github.set_auto_merge.request":
        return this.checkoutSession.handleCheckoutForgeSetAutoMergeRequest(msg);
      case "checkout.forge.get_check_details.request":
      case "checkout.github.get_check_details.request":
        return this.checkoutSession.handleCheckoutForgeGetCheckDetailsRequest(msg);
      case "checkout_pr_status_request":
        return this.checkoutSession.handleCheckoutPrStatusRequest(msg);
      case "pull_request_timeline_request":
        return this.checkoutSession.handlePullRequestTimelineRequest(msg);
      case "forge.search.request":
      case "github_search_request":
        return this.checkoutSession.handleForgeSearchRequest(msg);
      case "stash_save_request":
        return this.checkoutSession.handleStashSaveRequest(msg);
      case "stash_pop_request":
        return this.checkoutSession.handleStashPopRequest(msg);
      case "stash_list_request":
        return this.checkoutSession.handleStashListRequest(msg);
      default:
        return undefined;
    }
  }

  private dispatchWorkspaceAndProjectMessage(
    msg: SessionInboundMessage,
  ): Promise<void> | undefined {
    switch (msg.type) {
      case "fetch_workspaces_request":
        return this.workspaceSession.handleFetchWorkspacesRequest(msg);
      case "project.list.request":
        return this.handleProjectListRequest(msg);
      case "paseo_worktree_list_request":
        return this.handlePaseoWorktreeListRequest(msg);
      case "paseo_worktree_archive_request":
        return this.handlePaseoWorktreeArchiveRequest(msg);
      case "create_paseo_worktree_request":
        return this.handleCreatePaseoWorktreeRequest(msg);
      // COMPAT(desktopEditorBridge): added in v0.1.88, remove after 2026-12-03 once old clients no longer call daemon editor RPCs.
      case "list_available_editors_request":
        return this.handleLegacyListAvailableEditorsRequest(msg);
      case "open_in_editor_request":
        return this.handleLegacyOpenInEditorRequest(msg);
      case "open_project_request":
        return this.handleOpenProjectRequest(msg);
      case "project.add.request":
        return this.handleProjectAddRequest(msg);
      case "project.create_directory.request":
        return this.handleProjectCreateDirectoryRequest(msg);
      case "workspace.github.search_repositories.request":
        return this.handleWorkspaceGithubSearchRepositoriesRequest(msg);
      case "project.github.clone.request":
        return this.handleProjectGithubCloneRequest(msg);
      case "archive_workspace_request":
        return this.handleArchiveWorkspaceRequest(msg);
      case "project.remove.request":
        return this.handleProjectRemoveRequest(msg);
      case "workspace.title.set.request":
        return this.handleWorkspaceTitleSetRequest(msg.workspaceId, msg.title, msg.requestId);
      case "workspace.pin.set.request":
        return this.handleWorkspacePinSetRequest(msg.workspaceId, msg.pinned, msg.requestId);
      default:
        return undefined;
    }
  }

  private dispatchWorkspaceSetupMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    if (msg.type === "workspace_setup_status_request") {
      return this.handleWorkspaceSetupStatusRequest(msg);
    }
    if (msg.type === "workspace.setup.run.request") {
      return this.handleWorkspaceSetupRunRequest(msg);
    }
    return undefined;
  }

  private dispatchWorkspaceLabelMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    switch (msg.type) {
      case "workspace.label.list.request":
        return this.workspaceLabelSession.handleList(msg);
      case "workspace.label.assignment.set.request":
        return this.workspaceLabelSession.handleAssignment(msg);
      case "workspace.label.update.request":
        return this.workspaceLabelSession.handleUpdate(msg);
      case "workspace.label.delete.request":
        return this.workspaceLabelSession.handleDelete(msg);
      case "workspace.label.delete.inspect.request":
        return this.workspaceLabelSession.handleDeleteInspection(msg);
      default:
        return undefined;
    }
  }

  private dispatchWorkspaceFileMessage(
    msg: SessionInboundMessage,
    source?: object,
  ): Promise<void> | undefined {
    switch (msg.type) {
      case "file_explorer_request":
        return this.workspaceFilesSession.handleFileExplorerRequest(msg, source);
      case "fs.file.subscribe.request":
        return this.workspaceFilesSession.handleFileSubscribeRequest(msg, this.delivery);
      case "fs.file.unsubscribe.request":
        return this.workspaceFilesSession.handleFileUnsubscribeRequest(msg, this.delivery);
      case "fs.file.write.request":
        return this.workspaceFilesSession.handleFileWriteRequest(msg);
      case "fs.entry.create.request":
        return this.workspaceFilesSession.handleFileEntryCreateRequest(msg);
      case "fs.entry.rename.request":
        return this.workspaceFilesSession.handleFileEntryRenameRequest(msg);
      case "fs.entry.duplicate.request":
        return this.workspaceFilesSession.handleFileEntryDuplicateRequest(msg);
      case "fs.entry.delete.request":
        return this.workspaceFilesSession.handleFileEntryDeleteRequest(msg);
      case "project_icon_request":
        return this.workspaceFilesSession.handleProjectIconRequest(msg);
      case "project.icon.get.request":
        return this.workspaceSession.handleProjectIconGetRequest(msg.projectId, msg.requestId);
      case "file_download_token_request":
        return this.workspaceFilesSession.handleFileDownloadTokenRequest(msg);
      case "file.upload.request":
        this.workspaceFilesSession.handleFileUploadRequest(msg, this.delivery);
        return undefined;
      default:
        return undefined;
    }
  }

  private dispatchWorkspaceStateMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    switch (msg.type) {
      case "workspace.recovery.inspect.request":
        return this.workspaceSession.handleWorkspaceRecoveryInspectRequest(msg);
      case "workspace.recovery.restore.request":
        return this.workspaceSession.handleWorkspaceRecoveryRestoreRequest(msg);
      case "workspace.clear_attention.request":
        return this.handleWorkspaceClearAttentionRequest(msg);
      case "workspace.mark_unread.request":
        return this.handleWorkspaceMarkUnreadRequest(msg);
      default:
        return undefined;
    }
  }

  private dispatchProviderMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    switch (msg.type) {
      case "list_provider_models_request":
        return this.providerCatalogSession.handleListProviderModelsRequest(msg);
      case "list_provider_modes_request":
        return this.providerCatalogSession.handleListProviderModesRequest(msg);
      case "list_provider_features_request":
        return this.providerCatalogSession.handleListProviderFeaturesRequest(msg);
      case "list_available_providers_request":
        return this.providerCatalogSession.handleListAvailableProvidersRequest(msg);
      case "get_providers_snapshot_request":
        return this.providerCatalogSession.handleGetProvidersSnapshotRequest(msg);
      case "refresh_providers_snapshot_request":
        return this.providerCatalogSession.handleRefreshProvidersSnapshotRequest(msg);
      case "provider_diagnostic_request":
        return this.providerCatalogSession.handleProviderDiagnosticRequest(msg);
      case "provider.usage.list.request":
        return this.usageSession.handleLegacyList(msg);
      case "usage.list_reports.request":
        return this.usageSession.handleListReports(msg);
      default:
        return undefined;
    }
  }

  private dispatchTerminalMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    switch (msg.type) {
      case "start_workspace_script_request":
        return this.handleStartWorkspaceScriptRequest(msg);
      case "workspace.script.list.request":
        return this.handleWorkspaceScriptListRequest(msg);
      case "workspace.script.start.request":
        return this.handleWorkspaceScriptStartRequest(msg);
      case "workspace.script.stop.request":
        return this.handleWorkspaceScriptStopRequest(msg);
      default:
        return this.terminalController.dispatch(msg, this.delivery);
    }
  }

  private dispatchScheduleMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    switch (msg.type) {
      case "schedule/create":
        return this.scheduleSession.handleScheduleCreateRequest(msg);
      case "schedule/list":
        return this.scheduleSession.handleScheduleListRequest(msg);
      case "schedule/inspect":
        return this.scheduleSession.handleScheduleInspectRequest(msg);
      case "schedule/logs":
        return this.scheduleSession.handleScheduleLogsRequest(msg);
      case "schedule/pause":
        return this.scheduleSession.handleSchedulePauseRequest(msg);
      case "schedule/resume":
        return this.scheduleSession.handleScheduleResumeRequest(msg);
      case "schedule/delete":
        return this.scheduleSession.handleScheduleDeleteRequest(msg);
      case "schedule/run-once":
        return this.scheduleSession.handleScheduleRunOnceRequest(msg);
      case "schedule/update":
        return this.scheduleSession.handleScheduleUpdateRequest(msg);
      default:
        return undefined;
    }
  }

  private async dispatchMiscMessage(msg: SessionInboundMessage): Promise<void> {
    switch (msg.type) {
      case "register_push_token":
        this.handleRegisterPushToken(msg.token);
        return;
      case "push.unregister.request":
        this.pushNotifications.revoke(msg.token);
        if (this.currentClientMetadata().pushToken?.trim() === msg.token.trim()) {
          this.currentClientMetadata().pushToken = null;
        }
        this.emit({
          type: "push.unregister.response",
          payload: { requestId: msg.requestId },
        });
        return;
    }
  }

  public resetPeakInflight(): void {
    this.peakInflightRequests = this.inflightRequests;
  }

  public getSessionId(): string {
    return this.sessionId;
  }

  public async handleBinaryFrame(binaryFrame: BinaryFrame, source: object): Promise<void> {
    if (!this.authorization.allowsPermission("workspace.write")) {
      return;
    }
    if (binaryFrame.kind === "file_transfer") {
      await this.workspaceFilesSession.handleFileTransferFrame(binaryFrame.frame, source);
      return;
    }
    this.terminalController.handleBinaryFrame(binaryFrame.frame, source);
  }

  private async handleRestartServerRequest(requestId: string, reason?: string): Promise<void> {
    const lifecycleReason = normalizeClientRestartRpcReason(reason);
    const payload: { status: string } & Record<string, unknown> = {
      status: "restart_requested",
      clientId: this.clientId,
    };
    if (reason && reason.trim().length > 0) {
      payload.reason = reason;
    }
    payload.requestId = requestId;

    this.sessionLogger.warn({ reason: lifecycleReason }, "Restart requested via websocket");
    this.emit({
      type: "status",
      payload,
    });

    this.emitLifecycleIntent({
      type: "restart",
      clientId: this.clientId,
      requestId,
      reason: lifecycleReason,
    });
  }

  private async handleShutdownServerRequest(requestId: string): Promise<void> {
    const reason = CLIENT_SHUTDOWN_RPC_REASON;
    this.sessionLogger.warn({ reason }, "Shutdown requested via websocket");
    this.emit({
      type: "status",
      payload: {
        status: "shutdown_requested",
        clientId: this.clientId,
        requestId,
      },
    });

    this.emitLifecycleIntent({
      type: "shutdown",
      clientId: this.clientId,
      requestId,
      reason,
    });
  }

  private emitLifecycleIntent(intent: SessionLifecycleIntent): void {
    if (!this.onLifecycleIntent) {
      return;
    }
    try {
      this.onLifecycleIntent(intent);
    } catch (error) {
      this.sessionLogger.error({ err: error, intent }, "Lifecycle intent handler failed");
    }
  }

  private async handleProjectRemoveRequest(
    request: Extract<SessionInboundMessage, { type: "project.remove.request" }>,
  ): Promise<void> {
    const { projectId, requestId } = request;
    this.sessionLogger.info({ projectId, requestId }, "session: project.remove.request");

    try {
      const project = await this.projectRegistry.get(projectId);
      const resolvedProjectId = project?.projectId ?? projectId;
      const projectWorkspaces = (await this.workspaceRegistry.list()).filter(
        (workspace) => workspace.projectId === resolvedProjectId,
      );
      const activeWorkspaceIds = projectWorkspaces
        .filter((workspace) => !workspace.archivedAt)
        .map((workspace) => workspace.workspaceId);

      if (activeWorkspaceIds.length > 0) {
        this.workspaceSession.markWorkspaceArchiving(activeWorkspaceIds, new Date().toISOString());
        await this.workspaceSession.emitWorkspaceUpdatesForWorkspaceIds(activeWorkspaceIds);
      }

      const removedWorkspaceIds: string[] = [];
      try {
        for (const workspaceId of activeWorkspaceIds) {
          await archiveWorkspaceContents(
            {
              agentManager: this.agentManager,
              agentStorage: this.agentStorage,
              killTerminalsForWorkspace: (id) =>
                this.terminalController.killTerminalsForWorkspace(id),
              sessionLogger: this.sessionLogger,
            },
            workspaceId,
          );
          await this.workspaceSession.archiveWorkspaceRecord(workspaceId);
          removedWorkspaceIds.push(workspaceId);
        }

        await this.projectRegistry.remove(resolvedProjectId);
        await removeProjectCustomIcon({
          paseoHome: this.paseoHome,
          projectId: resolvedProjectId,
        }).catch((error) => {
          this.sessionLogger.warn(
            { err: error, projectId: resolvedProjectId },
            "Failed to clean up removed project icon",
          );
        });
      } finally {
        if (activeWorkspaceIds.length > 0) {
          this.workspaceSession.clearWorkspaceArchiving(activeWorkspaceIds);
        }
      }

      const updateIds =
        removedWorkspaceIds.length > 0
          ? removedWorkspaceIds
          : [projectWorkspaces[0]?.workspaceId ?? projectId];
      await this.workspaceSession.emitWorkspaceUpdatesForWorkspaceIds(updateIds, {
        removedProjectId: projectId,
      });

      this.emit({
        type: "project.remove.response",
        payload: {
          requestId,
          projectId,
          accepted: true,
          removedWorkspaceIds,
          error: null,
        },
      });
    } catch (error) {
      this.sessionLogger.error(
        { err: error, projectId, requestId },
        "session: project.remove.request error",
      );
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Failed to remove project: ${getErrorMessage(error)}`,
        },
      });
      this.emit({
        type: "project.remove.response",
        payload: {
          requestId,
          projectId,
          accepted: false,
          removedWorkspaceIds: [],
          error: getErrorMessageOr(error, "Failed to remove project"),
        },
      });
    }
  }

  private async handleWorkspaceTitleSetRequest(
    workspaceId: string,
    title: string | null,
    requestId: string,
  ): Promise<void> {
    this.sessionLogger.info(
      { workspaceId, requestId, hasTitle: typeof title === "string" },
      "session: workspace.title.set.request",
    );

    try {
      const trimmed = title?.trim() ?? "";
      const nextTitle = trimmed.length === 0 ? null : trimmed;
      const updatedAt = new Date().toISOString();
      const updated = await this.workspaceRegistry.update(workspaceId, (existing) => ({
        ...existing,
        title: nextTitle,
        updatedAt,
      }));
      if (!updated) {
        this.emit({
          type: "workspace.title.set.response",
          payload: {
            requestId,
            workspaceId,
            accepted: false,
            title: null,
            error: "Workspace not found",
          },
        });
        return;
      }

      this.emit({
        type: "workspace.title.set.response",
        payload: {
          requestId,
          workspaceId,
          accepted: true,
          title: nextTitle,
          error: null,
        },
      });

      await this.workspaceSession.emitWorkspaceUpdatesForWorkspaceIds([workspaceId]);
    } catch (error) {
      this.sessionLogger.error(
        { err: error, workspaceId, requestId },
        "session: workspace.title.set.request error",
      );
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Failed to set workspace title: ${getErrorMessage(error)}`,
        },
      });
      this.emit({
        type: "workspace.title.set.response",
        payload: {
          requestId,
          workspaceId,
          accepted: false,
          title: null,
          error: getErrorMessageOr(error, "Failed to set workspace title"),
        },
      });
    }
  }

  private async handleWorkspacePinSetRequest(
    workspaceId: string,
    pinned: boolean,
    requestId: string,
  ): Promise<void> {
    const logContext = { workspaceId, pinned, requestId };
    this.sessionLogger.info(logContext, "session: workspace.pin.set.request");
    const emitResponse = (accepted: boolean, pinnedAt: string | null, error: string | null) => {
      this.emit({
        type: "workspace.pin.set.response",
        payload: { requestId, workspaceId, accepted, pinnedAt, error },
      });
    };

    try {
      const nextPinnedAt = pinned ? new Date().toISOString() : null;
      const updatedAt = new Date().toISOString();
      const updated = await this.workspaceRegistry.update(workspaceId, (existing) => ({
        ...existing,
        pinnedAt: nextPinnedAt,
        updatedAt,
      }));
      if (!updated) {
        emitResponse(false, null, "Workspace not found");
        return;
      }
      emitResponse(true, nextPinnedAt, null);
      await this.workspaceSession.emitWorkspaceUpdatesForWorkspaceIds([workspaceId]);
    } catch (error) {
      this.sessionLogger.error(
        { ...logContext, err: error },
        "session: workspace.pin.set.request error",
      );
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Failed to pin workspace: ${getErrorMessage(error)}`,
        },
      });
      emitResponse(false, null, getErrorMessageOr(error, "Failed to pin workspace"));
    }
  }

  /**
   * Handle text message to agent (with optional image attachments)
   */
  private async handleSendAgentMessage(
    agentId: string,
    text: string,
    messageId?: string,
    images?: Array<{ data: string; mimeType: string }>,
    attachments?: AgentAttachment[],
    runOptions?: AgentRunOptions,
    options?: { spokenInput?: boolean },
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    this.sessionLogger.info(
      {
        agentId,
        textPreview: text.substring(0, 50),
        imageCount: images?.length ?? 0,
        attachmentCount: attachments?.length ?? 0,
      },
      `Sending text to agent ${agentId}${
        images && images.length > 0 ? ` with ${images.length} image attachment(s)` : ""
      }${
        attachments && attachments.length > 0
          ? ` and ${attachments.length} structured attachment(s)`
          : ""
      }`,
    );

    const promptText = options?.spokenInput ? wrapSpokenInput(text) : text;
    const prompt = buildAgentPrompt(promptText, images, attachments);

    try {
      await sendPromptToAgent({
        agentManager: this.agentManager,
        agentStorage: this.agentStorage,
        agentId,
        prompt,
        messageId,
        runOptions,
        // A typed or spoken message from the human answers any permission the
        // agent is blocked on.
        clearPendingPermissions: true,
        logger: this.sessionLogger,
      });
      return { ok: true };
    } catch (error) {
      this.handleAgentRunError(agentId, error, "Failed to send agent message");
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Handle create agent request
   */
  private creationUpdate(snapshot: CreationSnapshot): SessionOutboundMessage {
    return {
      type: snapshot.kind === "workspace" ? "workspace.create.update" : "agent.create.update",
      payload: snapshot,
    };
  }

  private async handleCreationSubscription(
    request: Extract<SessionInboundMessage, { type: "creation.subscribe.request" }>,
    source?: object,
  ): Promise<void> {
    let unsubscribe = () => {};
    const owner =
      request.subscribe === false
        ? undefined
        : this.delivery.begin(
            "creation",
            undefined,
            () => unsubscribe(),
            JSON.stringify([request.kind, request.idempotencyKey]),
          );
    try {
      const observation = await this.creationService.subscribe(
        request.kind,
        request.idempotencyKey,
        (snapshot) => owner?.emit(this.creationUpdate(snapshot)),
      );
      unsubscribe = observation.unsubscribe;
      if (!owner || owner.signal.aborted) unsubscribe();
      this.emitForSource(
        {
          type: "creation.subscribe.response",
          payload: {
            requestId: request.requestId,
            subscriptionId: owner?.responseId,
            snapshot: observation.snapshot,
            error: null,
          },
        },
        source,
      );
    } catch (error) {
      await owner?.release();
      this.emitForSource(
        {
          type: "creation.subscribe.response",
          payload: {
            requestId: request.requestId,
            snapshot: null,
            error: error instanceof Error ? error.message : String(error),
          },
        },
        source,
      );
    }
  }

  private creationResourceExists = async (
    kind: "workspace" | "agent",
    id: string,
  ): Promise<boolean> =>
    kind === "workspace"
      ? (await this.workspaceRegistry.get(id)) !== null
      : this.agentManager.getAgent(id) != null || (await this.agentStorage.get(id)) !== null;

  private createRequestedAgent(
    request: AgentCreateRequest,
    observer?: (snapshot: CreationSnapshot) => void,
  ): Promise<CreationSnapshot> {
    const { requestId, type: _type, subscribe: _subscribe, idempotencyKey, ...intent } = request;
    return this.creationService.create(
      {
        kind: "agent",
        key: idempotencyKey ?? requestId,
        request: intent,
        workspaceId: request.workspaceId,
        agentId: request.agentId,
        hasAgent: true,
        hasPrompt: hasInitialCreationPrompt(request),
        exists: this.creationResourceExists,
        readAgent: async (id) => {
          const record = await this.agentStorage.get(id);
          return record ? this.buildStoredAgentPayload(record) : null;
        },
        createAgent: async (id, _workspace, onReady) => {
          try {
            return await this.createSessionAgent(
              { ...request, type: "create_agent_request" },
              id,
              onReady,
            );
          } catch (error) {
            throw new WorktreeRequestError(toWorktreeWireError(error));
          }
        },
      },
      observer,
    );
  }

  private async handleAgentCreation(request: AgentCreateRequest, source?: object): Promise<void> {
    const { requestId, subscribe } = request;
    const progress = subscribe
      ? this.delivery.operation(
          (message) =>
            message.type === "workspace.create.update" || message.type === "agent.create.update",
          () => {},
        )
      : undefined;
    try {
      const creation = await this.createRequestedAgent(
        request,
        progress ? (snapshot) => progress.emit(this.creationUpdate(snapshot)) : undefined,
      );
      this.emitForSource(
        {
          type: "agent.create.response",
          payload: { requestId, agent: creation.agent ?? null, error: creation.error, creation },
        },
        source,
      );
    } catch (error) {
      this.emitForSource(
        {
          type: "agent.create.response",
          payload: {
            requestId,
            agent: null,
            error: error instanceof Error ? error.message : String(error),
          },
        },
        source,
      );
    } finally {
      await progress?.release();
    }
  }

  private async handleWorkspaceCreation(
    request: Extract<SessionInboundMessage, { type: "workspace.create.request" }>,
    source?: object,
  ): Promise<void> {
    const { requestId, subscribe, type: _type, idempotencyKey, ...intent } = request;
    const progress = subscribe
      ? this.delivery.operation(
          (message) =>
            message.type === "workspace.create.update" || message.type === "agent.create.update",
          () => {},
        )
      : undefined;
    try {
      if (
        request.agent &&
        !this.authorization.allowsPermission("workspace.write") &&
        !this.authorization.allowsPermission("hub.execute")
      ) {
        throw new Error("Session is not authorized to create an agent");
      }
      const agentInput = request.agent;
      const creation = await this.creationService.create(
        {
          kind: "workspace",
          key: idempotencyKey ?? requestId,
          request: intent,
          workspaceId: request.workspaceId,
          agentId: agentInput?.agentId,
          hasAgent: Boolean(agentInput),
          hasPrompt: hasInitialCreationPrompt(agentInput),
          exists: this.creationResourceExists,
          provision: async (id) => {
            const descriptor = await this.createRequestedWorkspace(
              {
                ...request,
                firstAgentContext: agentInput
                  ? { prompt: agentInput.initialPrompt, attachments: agentInput.attachments }
                  : request.firstAgentContext,
              },
              id,
            );
            const workspace = await this.workspaceRegistry.get(descriptor.id);
            return {
              workspace: descriptor,
              setupSkippedReason: workspace?.untrustedSource
                ? formatWorkspaceAutomationBlockedMessage(workspace.untrustedSource)
                : undefined,
            };
          },
          createAgent: agentInput
            ? async (id, workspace, onReady) => {
                if (!workspace?.workspaceDirectory)
                  throw new Error("Created workspace has no directory");
                const sourceCwd =
                  request.source.kind === "directory"
                    ? request.source.path
                    : await resolveWorktreeSourceCwd(request.source, this.projectRegistry);
                const relativeCwd = relative(resolve(sourceCwd), resolve(agentInput.config.cwd));
                if (
                  relativeCwd === ".." ||
                  relativeCwd.startsWith(`..${sep}`) ||
                  isAbsolute(relativeCwd)
                )
                  throw new Error("Agent directory must be inside the workspace source");
                return this.createSessionAgent(
                  {
                    ...agentInput,
                    type: "create_agent_request",
                    requestId,
                    config: {
                      ...agentInput.config,
                      cwd: resolve(workspace.workspaceDirectory, relativeCwd),
                    },
                    workspaceId: workspace.id,
                  },
                  id,
                  onReady,
                );
              }
            : undefined,
        },
        progress ? (snapshot) => progress.emit(this.creationUpdate(snapshot)) : undefined,
      );
      this.emitForSource(
        {
          type: "workspace.create.response",
          payload: {
            requestId,
            workspace: creation.workspace ?? null,
            agent: creation.agent,
            creation,
            setupSkippedReason: creation.setupSkippedReason,
            error: creation.error,
            errorCode: creation.errorCode,
            setupTerminalId: null,
          },
        },
        source,
      );
    } catch (error) {
      this.emitForSource(
        {
          type: "workspace.create.response",
          payload: {
            requestId,
            workspace: null,
            error: error instanceof Error ? error.message : String(error),
            errorCode:
              error instanceof Error && "code" in error && typeof error.code === "string"
                ? error.code
                : undefined,
            setupTerminalId: null,
          },
        },
        source,
      );
    } finally {
      await progress?.release();
    }
  }

  private validatePublicAgentWorkspaceIntent(
    request: CreateAgentRequestMessage,
    createsWorktree: boolean,
  ): void {
    if (request.internal)
      throw new Error(
        "Public internal agents were removed; create a background workspace instead.",
      );
    if (
      request.background !== undefined &&
      (request.workspaceId || (request.callerAgentId && !createsWorktree))
    ) {
      throw new Error(
        "background is workspace creation intent; configure the selected workspace at creation.",
      );
    }
  }

  private async createSessionAgent(
    msg: CreateAgentRequestMessage,
    agentId?: string,
    onAgentReady?: (agent: AgentSnapshotPayload) => Promise<void>,
  ): Promise<CreatedAgent> {
    const {
      config,
      worktreeName,
      initialPrompt,
      clientMessageId,
      outputSchema,
      git,
      worktree,
      autoArchive,
      images,
      attachments,
      env,
    } = msg;
    this.sessionLogger.info(
      { cwd: config.cwd, provider: config.provider, worktreeName },
      `Creating agent in ${config.cwd} (${config.provider})${
        worktreeName ? ` with worktree ${worktreeName}` : ""
      }`,
    );

    let createdWorktreeForCleanup: CreatePaseoWorktreeWorkflowResult | null = null;
    let createdAgentId: string | null = null;
    try {
      const requestedCwd = resolve(config.cwd);
      const needsRequestedDirectory =
        Boolean(worktreeName || git || worktree) || (!msg.workspaceId && !msg.callerAgentId);
      if (needsRequestedDirectory && !(await this.filesystem.isDirectory(requestedCwd))) {
        throw new Error(`Working directory does not exist or is not a directory: ${requestedCwd}`);
      }
      // Resolve all supported worktree input forms before provisioning workspace ownership.
      const gitIntent = normalizeAgentCreationGitOptions(git, worktreeName, worktree);
      this.validatePublicAgentWorkspaceIntent(msg, gitIntent?.createWorktree === true);
      const trimmedPrompt = initialPrompt?.trim();
      const { provisionalTitle } = resolveCreateAgentTitles({
        configTitle: config.title,
        initialPrompt: trimmedPrompt,
      });

      const firstAgentContext: FirstAgentContext = {
        ...(trimmedPrompt ? { prompt: trimmedPrompt } : {}),
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
      };
      const workspacePromptTitle = resolveFirstAgentPromptTitle(firstAgentContext);
      const createdWorktree = await this.createAgentLifecycleDispatch.createWorktreeForRequest({
        cwd: config.cwd,
        target: gitIntent,
        firstAgentContext,
        setupContinuation: worktree ? undefined : this.agentWorktreeSetupContinuation(),
        background: msg.background,
        callerWorkspaceId: this.getCallerWorkspaceId(msg.callerAgentId),
      });
      createdWorktreeForCleanup = createdWorktree;
      const resolvedIntent = await this.resolveSessionCreateAgentIntent({
        request: msg,
        createdWorktree,
        workspacePromptTitle,
      });
      const resolvedCwd = resolve(resolvedIntent.config.cwd);
      if (!(await this.filesystem.isDirectory(resolvedCwd))) {
        throw new Error(`Working directory does not exist or is not a directory: ${resolvedCwd}`);
      }

      const { snapshot, liveSnapshot, initialPromptStarted } = await createAgentCommand(
        {
          agentManager: this.agentManager,
          agentStorage: this.agentStorage,
          logger: this.sessionLogger,
          paseoHome: this.paseoHome,
          worktreesRoot: this.worktreesRoot,
          providerSnapshotManager: this.providerSnapshotManager,
        },
        {
          kind: "session",
          onAgentReady: async (agent) => {
            createdAgentId = agent.id;
            await onAgentReady?.(await this.buildAgentPayload(agent));
          },
          agentId,
          config: resolvedIntent.config,
          workspaceId: resolvedIntent.intent.workspaceId,
          worktreeName,
          initialPrompt,
          source: msg.callerAgentId
            ? { kind: "agent-message", agentId: msg.callerAgentId }
            : undefined,
          clientMessageId,
          outputSchema,
          images,
          attachments,
          git,
          labels: resolvedIntent.intent.labels,
          env,
          provisionalTitle,
          firstAgentContext,
          buildSessionConfig: async (sessionConfig, gitOptions, legacyWorktreeName, ctx) =>
            createdWorktree
              ? {
                  sessionConfig,
                  setupContinuation: createdWorktree.setupContinuation,
                  createdWorkspaceId: createdWorktree.workspace.workspaceId,
                }
              : this.buildAgentSessionConfig(sessionConfig, gitOptions, legacyWorktreeName, ctx),
        },
      );
      createdAgentId = snapshot.id;
      await this.agentUpdates.forwardLiveAgent(snapshot);
      if (resolvedIntent.createdDirectoryWorkspace && trimmedPrompt) {
        this.workspaceAutoName.scheduleForDirectory(
          {
            workspaceId: resolvedIntent.intent.workspaceId,
            cwd: resolvedIntent.config.cwd,
            firstAgentContext,
          },
          { currentSelection: this.getFocusedAgentSelectionForCwd(resolvedIntent.config.cwd) },
        );
      }
      this.createAgentLifecycleDispatch.registerAutoArchiveIfRequested({
        autoArchive,
        agentId: snapshot.id,
        createdWorktree,
      });
      this.sessionLogger.info(
        { agentId: snapshot.id, provider: snapshot.provider },
        "Created agent",
      );
      return { agent: await this.buildAgentPayload(liveSnapshot), initialPromptStarted };
    } catch (error) {
      await this.createAgentLifecycleDispatch.cleanupCreatedWorktreeAfterFailedAgentCreate({
        createdWorktree: createdWorktreeForCleanup,
        createdAgentId,
      });
      throw error;
    }
  }

  private async resolveSessionCreateAgentIntent(input: {
    request: CreateAgentRequestMessage;
    createdWorktree: CreatePaseoWorktreeWorkflowResult | null;
    workspacePromptTitle: string | null;
  }): Promise<ResolvedSessionCreateAgentIntent> {
    const { request, createdWorktree } = input;
    const callerAgent = request.callerAgentId
      ? this.agentManager.getAgent(request.callerAgentId)
      : null;
    if (request.callerAgentId && !callerAgent) {
      throw new Error(`Caller agent ${request.callerAgentId} not found`);
    }

    let config = request.config;

    const intent = await resolveCreateAgentIntent({
      explicitWorkspaceId: createdWorktree?.workspace.workspaceId ?? request.workspaceId,
      caller: callerAgent
        ? { id: callerAgent.id, cwd: callerAgent.cwd, workspaceId: callerAgent.workspaceId }
        : null,
      labels: request.labels,
      resolveWorkspace: async (workspaceId) => {
        if (createdWorktree?.workspace.workspaceId === workspaceId) {
          return { workspaceId, cwd: createdWorktree.workspace.cwd };
        }
        const workspace = await this.workspaceRegistry.get(workspaceId);
        if (!workspace || workspace.archivedAt) {
          throw new Error(`Workspace ${workspaceId} not found`);
        }
        return { workspaceId, cwd: workspace.cwd };
      },
      createWorkspace: async () => ({
        workspaceId: await this.workspaceProvisioning.resolveOrCreateWorkspaceIdForCreateAgent({
          createdWorktree: null,
          cwd: config.cwd,
          initialTitle: input.workspacePromptTitle,
          background: request.background,
          callerWorkspaceId: callerAgent?.workspaceId,
        }),
        cwd: config.cwd,
      }),
    });
    config = { ...config, cwd: intent.cwd };

    return {
      config,
      intent,
      createdDirectoryWorkspace: !createdWorktree && !request.workspaceId && !callerAgent,
    };
  }

  private async handleAgentRewindRequest(
    msg: Extract<SessionInboundMessage, { type: "agent.rewind.request" }>,
    source?: object,
  ): Promise<void> {
    try {
      this.rewindInitiators.set(msg.agentId, source);
      await this.agentManager.rewind(msg.agentId, msg.messageId, msg.mode);
      this.emitForSource(
        {
          type: "agent.rewind.response",
          payload: {
            requestId: msg.requestId,
            agentId: msg.agentId,
            ok: true,
            error: null,
          },
        },
        source,
      );
    } catch (error) {
      this.emitForSource(
        {
          type: "agent.rewind.response",
          payload: {
            requestId: msg.requestId,
            agentId: msg.agentId,
            ok: false,
            error: error instanceof Error ? error.message : "Failed to rewind agent",
          },
        },
        source,
      );
    } finally {
      this.rewindInitiators.delete(msg.agentId);
    }
  }

  private deliverTimelineReplacement(agentId: string, initiatingSource?: object): void {
    const agent = this.agentManager.getAgent(agentId);
    if (!agent) return;
    const timeline = this.agentManager.fetchTimeline(agentId, { limit: 0 });
    const epoch = timeline.epoch;

    if (this.clientSources.size === 0 || !this.onMessageToSource) {
      if (!this.supports(CLIENT_CAPS.timelineReplacementInvalidation)) {
        this.emitReconstructedTimelineRows(agentId, agent.provider, timeline.rows, epoch);
      }
      return;
    }

    for (const subscription of this.timelineSubscriptions.values()) {
      const source = subscription.owner.source;
      if (!subscription.agentIds.has(agentId)) continue;
      const modern = this.delivery.isModern(source);
      if (
        modern ||
        (source !== initiatingSource &&
          this.supportsForSource(CLIENT_CAPS.timelineReplacementInvalidation, source))
      ) {
        subscription.owner.emit({
          type: "agent.timeline.replacement",
          payload: { agentId, epoch },
        });
      }
    }
    // COMPAT(timelineReplacementInvalidation): added in v0.5.0, remove reconstructed replay after 2027-02-21.
    for (const [source, { capabilities }] of this.clientSources) {
      if (
        !this.delivery.isModern(source) &&
        !capabilities.has(CLIENT_CAPS.timelineReplacementInvalidation)
      ) {
        this.emitReconstructedTimelineRows(agentId, agent.provider, timeline.rows, epoch, source);
      }
    }
  }

  private emitReconstructedTimelineRows(
    agentId: string,
    provider: ManagedAgent["provider"],
    rows: AgentTimelineFetchResult["rows"],
    epoch: string,
    source?: object,
  ): void {
    for (const row of rows) {
      if (!this.supportsTimelineItem(row.item, source)) {
        continue;
      }
      const event = serializeAgentStreamEvent({
        type: "timeline",
        provider,
        item: row.item,
        ...(row.turnId ? { turnId: row.turnId } : {}),
        timestamp: row.timestamp,
      });
      if (!event) continue;
      this.emitForSource(
        {
          type: "agent_stream",
          payload: { agentId, event, timestamp: row.timestamp, seq: row.seq, epoch },
        },
        source,
      );
    }
  }

  private agentWorktreeSetupContinuation(): CreatePaseoWorktreeSetupContinuationInput {
    return {
      kind: "agent",
      terminalManager: this.terminalManager,
      appendTimelineItem: ({ agentId, item }) =>
        appendTimelineItemIfAgentKnown({
          agentManager: this.agentManager,
          agentId,
          item,
        }),
      emitLiveTimelineItem: ({ agentId, item }) =>
        emitLiveTimelineItemIfAgentKnown({
          agentManager: this.agentManager,
          agentId,
          item,
        }),
      logger: this.sessionLogger,
    };
  }

  private async buildAgentSessionConfig(
    config: AgentSessionConfig,
    gitOptions?: GitSetupOptions,
    legacyWorktreeName?: string,
    firstAgentContext?: FirstAgentContext,
  ): Promise<{
    sessionConfig: AgentSessionConfig;
    setupContinuation?: CreatePaseoWorktreeWorkflowResult["setupContinuation"];
    createdWorkspaceId?: string;
  }> {
    return buildWorktreeAgentSessionConfig(
      {
        paseoHome: this.paseoHome,
        worktreesRoot: this.worktreesRoot,
        sessionLogger: this.sessionLogger,
        workspaceGitService: this.workspaceGitService,
        createPaseoWorktree: (input, serviceOptions) =>
          this.createPaseoWorktreeWorkflow(input, {
            ...serviceOptions,
            setupContinuation: this.agentWorktreeSetupContinuation(),
          }),
        checkoutExistingBranch: (cwd, branch) =>
          this.gitMutation.checkoutExistingBranch(cwd, branch),
        createBranchFromBase: (params) => this.gitMutation.createBranchFromBase(params),
      },
      config,
      gitOptions,
      legacyWorktreeName,
      firstAgentContext,
    );
  }

  private isPathWithinRoot(rootPath: string, candidatePath: string): boolean {
    const resolvedRoot = resolve(rootPath);
    const resolvedCandidate = resolve(candidatePath);
    if (resolvedCandidate === resolvedRoot) {
      return true;
    }
    return resolvedCandidate.startsWith(resolvedRoot + sep);
  }

  /**
   * Handle client heartbeat for activity tracking
   */
  private handleClientHeartbeat(msg: {
    deviceType: "web" | "mobile";
    focusedAgentId: string | null;
    focusedTerminalId?: string | null;
    lastActivityAt: string;
    appVisible: boolean;
    appVisibilityChangedAt?: string;
  }): void {
    const focusedTerminalId = msg.focusedTerminalId?.trim() || null;
    const appVisibilityChangedAt = msg.appVisibilityChangedAt
      ? new Date(msg.appVisibilityChangedAt)
      : new Date(msg.lastActivityAt);
    const metadata = this.currentClientMetadata();
    metadata.activity = {
      deviceType: msg.deviceType,
      focusedAgentId: msg.focusedAgentId,
      focusedTerminalId,
      lastActivityAt: new Date(msg.lastActivityAt),
      appVisible: msg.appVisible,
      appVisibilityChangedAt,
    };
    if (msg.appVisible && focusedTerminalId) {
      void this.clearFocusedTerminalAttention(focusedTerminalId);
    }
    if (metadata.pushToken) {
      this.pushNotifications.renew(metadata.pushToken);
    }
  }

  private async clearFocusedTerminalAttention(terminalId: string): Promise<void> {
    const terminalManager = this.terminalManager;
    if (!terminalManager) {
      return;
    }
    try {
      await terminalManager.clearTerminalAttention(terminalId);
    } catch (error) {
      this.sessionLogger.warn({ err: error, terminalId }, "Failed to clear terminal attention");
    }
  }

  /**
   * Handle push token registration
   */
  private handleRegisterPushToken(token: string): void {
    this.currentClientMetadata().pushToken = token;
    this.pushNotifications.renew(token);
    this.sessionLogger.info("Registered push token");
  }

  private async handlePaseoWorktreeListRequest(
    msg: Extract<SessionInboundMessage, { type: "paseo_worktree_list_request" }>,
  ): Promise<void> {
    return handleWorktreeListRequest(
      {
        emit: (message) => this.emit(message),
        paseoHome: this.paseoHome,
        workspaceGitService: this.workspaceGitService,
      },
      msg,
    );
  }

  private async handlePaseoWorktreeArchiveRequest(
    msg: Extract<SessionInboundMessage, { type: "paseo_worktree_archive_request" }>,
  ): Promise<void> {
    return handleWorktreeArchiveRequest(
      {
        paseoHome: this.paseoHome,
        paseoWorktreesBaseRoot: this.worktreesRoot,
        github: this.github,
        workspaceGitService: this.workspaceGitService,
        agentManager: this.agentManager,
        agentStorage: this.agentStorage,
        findWorkspaceIdForCwd: (cwd) => this.findWorkspaceIdForCwd(cwd),
        listActiveWorkspaces: () => this.listActiveWorkspaceRefs(),
        archiveWorkspaceRecord: (workspaceId) =>
          this.workspaceSession.archiveWorkspaceRecord(workspaceId),
        emit: (message) => this.emit(message),
        emitWorkspaceUpdatesForWorkspaceIds: (workspaceIds) =>
          this.workspaceSession.emitWorkspaceUpdatesForWorkspaceIds(workspaceIds),
        markWorkspaceArchiving: (workspaceIds, archivingAt) =>
          this.workspaceSession.markWorkspaceArchiving(workspaceIds, archivingAt),
        clearWorkspaceArchiving: (workspaceIds) =>
          this.workspaceSession.clearWorkspaceArchiving(workspaceIds),
        killTerminalsForWorkspace: (workspaceId) =>
          this.terminalController.killTerminalsForWorkspace(workspaceId),
        sessionLogger: this.sessionLogger,
      },
      msg,
    );
  }

  private async listTerminalActivityContributions(): Promise<
    Array<{ cwd: string; workspaceId?: string; activity: TerminalActivity | null }>
  > {
    const terminalManager = this.terminalManager;
    if (!terminalManager) {
      return [];
    }
    const directories = terminalManager.listDirectories();
    const terminalsByDirectory = await Promise.all(
      directories.map((cwd) => terminalManager.getTerminals(cwd)),
    );
    return terminalsByDirectory.flat().map((session) => {
      const contribution: { cwd: string; workspaceId?: string; activity: TerminalActivity | null } =
        {
          cwd: session.cwd,
          activity: session.getActivity(),
        };
      if (session.workspaceId) {
        contribution.workspaceId = session.workspaceId;
      }
      return contribution;
    });
  }

  /**
   * Build the current agent list payload (live + persisted), optionally filtered by labels.
   */
  private listAgentPayloads(
    filter?: Parameters<AgentDirectory["list"]>[0],
  ): Promise<AgentSnapshotPayload[]> {
    return this.agentDirectory.list(filter);
  }

  private async buildActiveProjectPlacementsByWorkspaceId(): Promise<
    Map<string, ProjectPlacementPayload>
  > {
    const [persistedWorkspaces, persistedProjects] = await Promise.all([
      this.workspaceRegistry.list(),
      this.projectRegistry.list(),
    ]);
    const activeProjects = new Map(
      persistedProjects
        .filter((project) => !project.archivedAt)
        .map((project) => [project.projectId, project] as const),
    );
    const placementsByWorkspaceId = new Map<string, ProjectPlacementPayload>();

    const pairs = persistedWorkspaces.flatMap((workspace) => {
      if (workspace.archivedAt) return [];
      const project = activeProjects.get(workspace.projectId);
      if (!project) return [];
      return [{ workspace, project }];
    });
    const placements = await Promise.all(
      pairs.map(({ workspace, project }) =>
        this.buildProjectPlacementForWorkspace(workspace, project),
      ),
    );
    for (let i = 0; i < pairs.length; i += 1) {
      placementsByWorkspaceId.set(pairs[i].workspace.workspaceId, placements[i]);
    }

    return placementsByWorkspaceId;
  }

  // external path→workspace adapter, not ownership. Used by archive-by-path flows
  // where the request carries a worktree path (unique to one workspace) rather
  // than a workspaceId. This is a directory lookup for an archive target, not a
  // status/ownership attribution.
  private async findWorkspaceIdForCwd(cwd: string): Promise<string | null> {
    const workspaces = await this.workspaceRegistry.list();
    return resolveWorkspaceIdForPath(cwd, workspaces);
  }

  private async createPaseoWorktree(
    input: CreatePaseoWorktreeInput,
    options?: {
      resolveDefaultBranch?: (repoRoot: string) => Promise<string>;
    },
  ): Promise<CreatePaseoWorktreeResult> {
    const result = await createPaseoWorktree(input, {
      github: this.github,
      ...(options?.resolveDefaultBranch
        ? { resolveDefaultBranch: options.resolveDefaultBranch }
        : {}),
      workspaceGitService: this.workspaceGitService,
      workspaceProvisioning: this.workspaceProvisioning,
    });
    void Promise.all([
      this.gitMutation.notifyGitMutation(input.cwd, "create-worktree"),
      this.gitMutation.notifyGitMutation(result.worktree.worktreePath, "create-worktree"),
    ]).catch((error) => {
      this.sessionLogger.warn(
        { err: error, cwd: input.cwd, worktreePath: result.worktree.worktreePath },
        "Failed to warm git snapshots after creating worktree",
      );
    });
    return result;
  }

  private async listActiveWorkspaceRefs(): Promise<ActiveWorkspaceRef[]> {
    const workspaces = await this.workspaceRegistry.list();
    return workspaces
      .filter((workspace) => !workspace.archivedAt)
      .map((workspace) => ({
        workspaceId: workspace.workspaceId,
        cwd: workspace.cwd,
        kind: workspace.kind,
        worktreeRoot: workspace.worktreeRoot,
        isPaseoOwnedWorktree: workspace.isPaseoOwnedWorktree,
        mainRepoRoot: workspace.mainRepoRoot,
      }));
  }

  private async handleProjectListRequest(
    request: Extract<SessionInboundMessage, { type: "project.list.request" }>,
  ): Promise<void> {
    try {
      const projects = await Promise.all(
        (await this.projectRegistry.list())
          .filter((project) => !project.archivedAt)
          .map((project) => this.workspaceSession.buildProjectDescriptor(project)),
      );
      const synchronized = request.sync
        ? this.directorySync.synchronizeProjects(projects, request.sync)
        : null;
      this.emit({
        type: "project.list.response",
        payload: {
          requestId: request.requestId,
          ...(synchronized ?? { projects }),
        },
      });
    } catch (error) {
      this.sessionLogger.error({ err: error }, "Failed to handle project.list.request");
      this.emit({
        type: "rpc_error",
        payload: {
          requestId: request.requestId,
          requestType: "project.list.request",
          error: error instanceof Error ? error.message : "Failed to list projects",
          code: "project_list_failed",
        },
      });
    }
  }

  private async registerWorkspaceForImportedAgent(
    workspace: PersistedWorkspaceRecord,
  ): Promise<void> {
    try {
      await this.workspaceSession.syncWorkspaceGitObserverForWorkspace(workspace);
      await this.workspaceSession.describeWorkspaceRecord(workspace);
      await this.workspaceSession.emitWorkspaceUpdateForWorkspaceId(workspace.workspaceId);
    } catch (error) {
      this.sessionLogger.warn(
        { err: error, workspaceId: workspace.workspaceId, cwd: workspace.cwd },
        "Failed to register workspace for imported agent",
      );
    }
  }

  private getCallerWorkspaceId(callerAgentId?: string): string | undefined {
    if (!callerAgentId) return undefined;
    const caller = this.agentManager.getAgent(callerAgentId);
    if (!caller) throw new Error(`Caller agent ${callerAgentId} not found`);
    return caller.workspaceId;
  }

  private async createRequestedWorkspace(
    request: Extract<SessionInboundMessage, { type: "workspace.create.request" }>,
    workspaceId?: string,
  ): Promise<WorkspaceDescriptorPayload> {
    if (request.internal)
      throw new Error(
        "Public internal workspaces were removed; use background workspace creation.",
      );
    if (request.agent?.background !== undefined)
      throw new Error("Configure background on the workspace, not its initial agent.");
    let creationRequest = request;
    // Hooks belong to the operation: retries fingerprint the caller's input
    // and must not rerun hooks or compare their potentially changing output.
    if (this.pluginRuntime) {
      const { type, requestId, ...input } = request;
      const transformed = await this.pluginRuntime.before("workspace.create", input);
      creationRequest = { ...transformed, type, requestId };
    }
    return creationRequest.source.kind === "directory"
      ? this.handleWorkspaceCreateLocal(creationRequest, workspaceId)
      : this.handleWorkspaceCreateWorktree(creationRequest, workspaceId);
  }

  private async handleWorkspaceCreateLocal(
    request: Extract<SessionInboundMessage, { type: "workspace.create.request" }>,
    workspaceId?: string,
  ): Promise<WorkspaceDescriptorPayload> {
    if (request.source.kind !== "directory") {
      throw new Error("Unexpected workspace source");
    }

    const cwd = expandTilde(request.source.path);
    const directoryExists = await this.filesystem.isDirectory(cwd).catch(() => false);
    if (!directoryExists) {
      throw new SessionRequestError("directory_not_found", `Directory not found: ${cwd}`);
    }

    const explicitTitle = request.title?.trim() || null;
    const promptTitle = resolveFirstAgentPromptTitle(request.firstAgentContext);
    const workspace = await this.workspaceProvisioning.createWorkspaceForDirectory(
      cwd,
      explicitTitle ?? promptTitle,
      request.source.projectId,
      {
        expectsInitialAgent: Boolean(request.firstAgentContext),
        workspaceId,
        background: request.background,
        callerWorkspaceId: this.getCallerWorkspaceId(request.callerAgentId),
      },
    );
    await this.workspaceSession.syncWorkspaceGitObserverForWorkspace(workspace);
    const descriptor = await this.workspaceSession.describeWorkspaceRecord(workspace);
    await this.workspaceSession.emitCreatedWorkspaceUpdate(
      descriptor,
      request.firstAgentContext ? "running" : undefined,
    );
    void this.workspaceGitService
      .getSnapshot(workspace.cwd, { force: true, includeForge: true, reason: "open_project" })
      .catch((error) => {
        this.sessionLogger.warn(
          { err: error, cwd: workspace.cwd },
          "Background snapshot refresh failed after workspace.create",
        );
      });
    if (request.firstAgentContext) {
      const firstAgentContext = request.firstAgentContext;
      this.workspaceAutoName.scheduleForDirectory(
        {
          workspaceId: workspace.workspaceId,
          cwd: workspace.cwd,
          firstAgentContext,
        },
        { currentSelection: this.getFocusedAgentSelectionForCwd(workspace.cwd) },
      );
    }
    return descriptor;
  }

  private async handleWorkspaceCreateWorktree(
    request: Extract<SessionInboundMessage, { type: "workspace.create.request" }>,
    workspaceId?: string,
  ): Promise<WorkspaceDescriptorPayload> {
    if (request.source.kind !== "worktree") {
      throw new Error("Unexpected workspace source");
    }

    const source = request.source;

    if (!source.cwd && !source.projectId) {
      throw new SessionRequestError(
        "source_required",
        "cwd or projectId is required for a worktree-backed workspace",
      );
    }

    const sourceCwd = await resolveWorktreeSourceCwd(source, this.projectRegistry);

    const result = await this.createPaseoWorktreeWorkflow(
      {
        cwd: sourceCwd,
        workspaceId,
        projectId: source.projectId,
        worktreeSlug: source.worktreeSlug,
        action: source.action,
        refName: source.refName,
        branchName: source.branchName,
        checkoutSource: source.checkoutSource,
        githubPrNumber: source.githubPrNumber,
        firstAgentContext: request.firstAgentContext,
        title: request.title,
        background: request.background,
        callerWorkspaceId: this.getCallerWorkspaceId(request.callerAgentId),
      },
      source.baseBranch
        ? { resolveDefaultBranch: async () => source.baseBranch as string }
        : undefined,
    );

    const descriptor = await this.workspaceSession.describeCreatedWorktreeWorkspace(result);
    await this.workspaceSession.emitCreatedWorkspaceUpdate(
      descriptor,
      request.firstAgentContext ? "running" : undefined,
    );
    return descriptor;
  }

  private async handleOpenProjectRequest(
    request: Extract<SessionInboundMessage, { type: "open_project_request" }>,
  ): Promise<void> {
    const requestedCwd = request.cwd;
    const cwd = expandTilde(requestedCwd);
    const directoryExists = await this.filesystem.isDirectory(cwd).catch(() => false);
    if (!directoryExists) {
      this.sessionLogger.info(
        { requestedCwd, resolvedCwd: cwd, reason: "directory_not_found" },
        "Open project rejected",
      );
      this.emit({
        type: "open_project_response",
        payload: {
          requestId: request.requestId,
          workspace: null,
          error: `Directory not found: ${cwd}`,
          errorCode: "directory_not_found",
        },
      });
      return;
    }

    try {
      const projectsBefore = new Map<string, PersistedProjectRecord>();
      for (const project of await this.projectRegistry.list()) {
        projectsBefore.set(project.projectId, project);
      }
      const workspacesBefore = new Map<string, PersistedWorkspaceRecord>();
      for (const workspaceRecord of await this.workspaceRegistry.list()) {
        workspacesBefore.set(workspaceRecord.workspaceId, workspaceRecord);
      }
      const workspace = await this.workspaceProvisioning.findOrCreateWorkspaceForDirectory(cwd);
      const project = await this.projectRegistry.get(workspace.projectId);
      await this.workspaceSession.syncWorkspaceGitObserverForWorkspace(workspace);
      const descriptor = await this.workspaceSession.describeWorkspaceRecord(workspace);
      await this.workspaceSession.emitWorkspaceUpdateForWorkspaceId(workspace.workspaceId);
      this.sessionLogger.info(
        {
          requestedCwd,
          resolvedCwd: cwd,
          workspaceCwd: workspace.cwd,
          workspaceId: workspace.workspaceId,
          workspaceKind: workspace.kind,
          workspaceTransition: describeRegistryTransition(
            workspacesBefore.get(workspace.workspaceId) ?? null,
          ),
          projectId: workspace.projectId,
          projectKind: project?.kind ?? null,
          projectTransition: describeRegistryTransition(
            projectsBefore.get(workspace.projectId) ?? null,
          ),
        },
        "Project opened",
      );
      this.emit({
        type: "open_project_response",
        payload: {
          requestId: request.requestId,
          workspace: descriptor,
          error: null,
        },
      });
      void this.workspaceGitService
        .getSnapshot(workspace.cwd, {
          force: true,
          includeForge: true,
          reason: "open_project",
        })
        .catch((error) => {
          this.sessionLogger.warn(
            { err: error, cwd: workspace.cwd },
            "Background snapshot refresh failed after open_project",
          );
        });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to open project";
      this.sessionLogger.error({ err: error, cwd }, "Failed to open project");
      this.emit({
        type: "open_project_response",
        payload: {
          requestId: request.requestId,
          workspace: null,
          error: message,
        },
      });
    }
  }

  private async handleProjectAddRequest(
    request: Extract<SessionInboundMessage, { type: "project.add.request" }>,
  ): Promise<void> {
    const requestedCwd = request.cwd;
    const cwd = expandTilde(requestedCwd);
    const directoryExists = await this.filesystem.isDirectory(cwd).catch(() => false);
    if (!directoryExists) {
      this.sessionLogger.info(
        { requestedCwd, resolvedCwd: cwd, reason: "directory_not_found" },
        "Add project rejected",
      );
      this.emit({
        type: "project.add.response",
        payload: {
          requestId: request.requestId,
          project: null,
          error: `Directory not found: ${cwd}`,
          errorCode: "directory_not_found",
        },
      });
      return;
    }

    try {
      const projectsBefore = new Map<string, PersistedProjectRecord>();
      for (const project of await this.projectRegistry.list()) {
        projectsBefore.set(project.projectId, project);
      }
      const project = await this.workspaceProvisioning.findOrCreateProjectForDirectory(cwd);
      this.sessionLogger.info(
        {
          requestedCwd,
          resolvedCwd: cwd,
          projectId: project.projectId,
          projectKind: project.kind,
          projectTransition: describeRegistryTransition(
            projectsBefore.get(project.projectId) ?? null,
          ),
        },
        "Project added",
      );
      this.emit({
        type: "project.add.response",
        payload: {
          requestId: request.requestId,
          project: await this.workspaceSession.buildProjectDescriptor(project),
          error: null,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to add project";
      this.sessionLogger.error({ err: error, cwd }, "Failed to add project");
      this.emit({
        type: "project.add.response",
        payload: {
          requestId: request.requestId,
          project: null,
          error: message,
        },
      });
    }
  }

  private async handleProjectCreateDirectoryRequest(
    request: Extract<SessionInboundMessage, { type: "project.create_directory.request" }>,
  ): Promise<void> {
    try {
      const result = await createProjectDirectory(
        { parentPath: request.parentPath, name: request.name },
        {
          registerProject: (directoryPath) =>
            this.workspaceProvisioning.findOrCreateProjectForDirectory(directoryPath),
        },
      );
      this.emit({
        type: "project.create_directory.response",
        payload: {
          requestId: request.requestId,
          directoryPath: result.directoryPath,
          project: await this.workspaceSession.buildProjectDescriptor(result.project),
          error: null,
          errorCode: null,
        },
      });
    } catch (error) {
      const requestError =
        error instanceof ProjectDirectoryRequestError
          ? error
          : new ProjectDirectoryRequestError(
              "registration_failed",
              error instanceof Error ? error.message : "Failed to create project directory",
            );
      this.sessionLogger.error(
        {
          err: error,
          parentPath: request.parentPath,
          name: request.name,
          errorCode: requestError.code,
        },
        "Failed to create project directory",
      );
      this.emit({
        type: "project.create_directory.response",
        payload: {
          requestId: request.requestId,
          directoryPath: requestError.directoryPath,
          project: null,
          error: requestError.message,
          errorCode: requestError.code,
        },
      });
    }
  }

  private async handleWorkspaceGithubSearchRepositoriesRequest(
    request: Extract<
      SessionInboundMessage,
      { type: "workspace.github.search_repositories.request" }
    >,
  ): Promise<void> {
    try {
      const searchRepositories = (this.github as Partial<GitHubService>).searchRepositories;
      if (!searchRepositories) {
        throw new Error("GitHub repository search is unavailable");
      }
      const repositories = await searchRepositories.call(this.github, {
        cwd: homedir(),
        query: request.query,
        limit: request.limit,
      });
      this.emit({
        type: "workspace.github.search_repositories.response",
        payload: {
          requestId: request.requestId,
          repositories,
          status: "success",
          available: true,
          error: null,
        },
      });
    } catch (error) {
      const missing = error instanceof GitHubCliMissingError;
      const unauthenticated = error instanceof GitHubAuthenticationError;
      const commandError = error instanceof GitHubCommandError ? error.stderr.trim() : "";
      let message: string;
      if (missing) {
        message = "GitHub CLI (gh) is not installed or not in PATH";
      } else if (unauthenticated) {
        message = "GitHub CLI is not authenticated. Run gh auth login on the host.";
      } else if (commandError) {
        message = commandError;
      } else {
        message = error instanceof Error ? error.message : "GitHub search failed";
      }
      let payload: WorkspaceGithubSearchRepositoriesResponsePayload;
      if (missing) {
        payload = {
          status: "unavailable",
          requestId: request.requestId,
          repositories: [],
          reason: "gh_missing",
          available: false,
          error: message,
        };
      } else if (unauthenticated) {
        payload = {
          status: "unauthenticated",
          requestId: request.requestId,
          repositories: [],
          available: false,
          error: message,
        };
      } else {
        payload = {
          status: "error",
          requestId: request.requestId,
          repositories: [],
          available: true,
          error: message,
        };
      }
      this.sessionLogger.warn({ err: error }, "GitHub repository search failed");
      this.emit({
        type: "workspace.github.search_repositories.response",
        payload,
      });
    }
  }

  private async handleProjectGithubCloneRequest(
    request: Extract<SessionInboundMessage, { type: "project.github.clone.request" }>,
  ): Promise<void> {
    let normalizedRepo = request.repo;
    let checkoutPath: string | null = null;
    try {
      const repo = normalizeCloneRepository({
        repo: request.repo,
        cloneProtocol: request.cloneProtocol,
      });
      normalizedRepo = repo.displayName;
      const targetParent = resolve(expandTilde(request.targetDirectory.trim()));
      checkoutPath = resolve(targetParent, repo.name);
      if (!this.isPathWithinRoot(targetParent, checkoutPath)) {
        throw new Error("Resolved checkout path must stay inside the target directory");
      }

      await mkdir(targetParent, { recursive: true });
      try {
        await lstat(checkoutPath);
        throw new Error(`Checkout path already exists: ${checkoutPath}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }

      const cloneStagingPath = await mkdtemp(resolve(targetParent, ".paseo-clone-"));
      try {
        await runGitCommand(["clone", repo.cloneUrl, cloneStagingPath], {
          cwd: targetParent,
          timeout: 5 * 60 * 1000,
          maxOutputBytes: 1024 * 1024,
          logger: this.sessionLogger,
        });
        await rename(cloneStagingPath, checkoutPath);
      } catch (error) {
        await rm(cloneStagingPath, { recursive: true, force: true }).catch((cleanupError) => {
          this.sessionLogger.warn(
            { err: cleanupError, cloneStagingPath },
            "Failed to clean up partial GitHub clone",
          );
        });
        throw error;
      }

      const project =
        await this.workspaceProvisioning.findOrCreateProjectForDirectory(checkoutPath);

      this.emit({
        type: "project.github.clone.response",
        payload: {
          requestId: request.requestId,
          repo: repo.displayName,
          checkoutPath,
          project: await this.workspaceSession.buildProjectDescriptor(project),
          error: null,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to clone GitHub repo";
      this.sessionLogger.error(
        { err: error, repo: request.repo, targetDirectory: request.targetDirectory },
        "Failed to clone GitHub project",
      );
      this.emit({
        type: "project.github.clone.response",
        payload: {
          requestId: request.requestId,
          repo: normalizedRepo,
          checkoutPath,
          project: null,
          error: message,
        },
      });
    }
  }

  // Named accessor: the workspace descriptor builder and the git-watch test both read a workspace's
  // scripts snapshot through here; the workspace-scripts module owns the payload assembly.
  private buildWorkspaceScriptPayloadSnapshot(
    workspace: PersistedWorkspaceRecord,
    project: PersistedProjectRecord | null,
  ): WorkspaceDescriptorPayload["scripts"] {
    return this.workspaceScripts.buildSnapshot(workspace, project);
  }

  private handleStartWorkspaceScriptRequest(request: StartWorkspaceScriptRequest): Promise<void> {
    return this.workspaceScripts.start(request);
  }

  private async handleWorkspaceScriptListRequest(
    request: WorkspaceScriptListRequest,
  ): Promise<void> {
    try {
      const scripts = await this.workspaceScripts.list(request.workspaceId);
      this.emit({
        type: "workspace.script.list.response",
        payload: {
          requestId: request.requestId,
          workspaceId: request.workspaceId,
          scripts,
          error: null,
        },
      });
    } catch (error) {
      this.emit({
        type: "workspace.script.list.response",
        payload: {
          requestId: request.requestId,
          workspaceId: request.workspaceId,
          scripts: [],
          error: error instanceof Error ? error.message : "Failed to list workspace scripts",
        },
      });
    }
  }

  private async handleWorkspaceScriptStartRequest(
    request: WorkspaceScriptStartRequest,
  ): Promise<void> {
    try {
      const script = await this.workspaceScripts.launch(request);
      this.emit({
        type: "workspace.script.start.response",
        payload: {
          requestId: request.requestId,
          workspaceId: request.workspaceId,
          scriptName: request.scriptName,
          script,
          error: null,
        },
      });
    } catch (error) {
      this.emit({
        type: "workspace.script.start.response",
        payload: {
          requestId: request.requestId,
          workspaceId: request.workspaceId,
          scriptName: request.scriptName,
          script: null,
          error: error instanceof Error ? error.message : "Failed to start workspace script",
        },
      });
    }
  }

  private async handleWorkspaceScriptStopRequest(
    request: WorkspaceScriptStopRequest,
  ): Promise<void> {
    try {
      const script = await this.workspaceScripts.stop(request);
      this.emit({
        type: "workspace.script.stop.response",
        payload: {
          requestId: request.requestId,
          workspaceId: request.workspaceId,
          scriptName: request.scriptName,
          script,
          error: null,
        },
      });
    } catch (error) {
      this.emit({
        type: "workspace.script.stop.response",
        payload: {
          requestId: request.requestId,
          workspaceId: request.workspaceId,
          scriptName: request.scriptName,
          script: null,
          error: error instanceof Error ? error.message : "Failed to stop workspace script",
        },
      });
    }
  }

  private async handleLegacyListAvailableEditorsRequest(
    request: Extract<SessionInboundMessage, { type: "list_available_editors_request" }>,
  ): Promise<void> {
    try {
      const editors = listLocalDaemonEditorTargets();
      this.emit({
        type: "list_available_editors_response",
        payload: {
          requestId: request.requestId,
          editors,
          error: null,
        },
      });
    } catch (error) {
      this.emit({
        type: "list_available_editors_response",
        payload: {
          requestId: request.requestId,
          editors: [],
          error: error instanceof Error ? error.message : "Failed to list available editors",
        },
      });
    }
  }

  private async handleLegacyOpenInEditorRequest(
    request: Extract<SessionInboundMessage, { type: "open_in_editor_request" }>,
  ): Promise<void> {
    try {
      await openInLocalDaemonEditorTarget({
        editorId: request.editorId,
        path: request.path,
        ...(request.cwd ? { cwd: request.cwd } : {}),
        ...(request.mode ? { mode: request.mode } : {}),
      });
      this.emit({
        type: "open_in_editor_response",
        payload: {
          requestId: request.requestId,
          error: null,
        },
      });
    } catch (error) {
      this.emit({
        type: "open_in_editor_response",
        payload: {
          requestId: request.requestId,
          error: error instanceof Error ? error.message : "Failed to open in editor",
        },
      });
    }
  }

  private async handleCreatePaseoWorktreeRequest(
    request: Extract<SessionInboundMessage, { type: "create_paseo_worktree_request" }>,
  ): Promise<void> {
    return handleCreateWorktreeRequest(
      {
        paseoHome: this.paseoHome,
        worktreesRoot: this.worktreesRoot,
        describeWorkspaceRecord: (result) =>
          this.workspaceSession.describeCreatedWorktreeWorkspace(result),
        emit: (message) => this.emit(message),
        sessionLogger: this.sessionLogger,
        createPaseoWorktreeWorkflow: (input) => this.createPaseoWorktreeWorkflow(input),
      },
      request,
    );
  }

  private async createPaseoWorktreeWorkflow(
    input: CreatePaseoWorktreeInput,
    options?: {
      resolveDefaultBranch?: (repoRoot: string) => Promise<string>;
      setupContinuation?: CreatePaseoWorktreeSetupContinuationInput;
    },
  ): Promise<CreatePaseoWorktreeWorkflowResult> {
    return createWorktreeWorkflow(
      {
        paseoHome: this.paseoHome,
        worktreesRoot: this.worktreesRoot,
        createPaseoWorktree: (workflowInput, serviceOptions) =>
          this.createPaseoWorktree(workflowInput, serviceOptions),
        warmWorkspaceGitData: (workspace) =>
          this.workspaceSession.warmWorkspaceGitDataForWorkspace(workspace),
        autoNameWorkspaceBranchForFirstAgent: (autoNameInput) =>
          this.workspaceAutoName.scheduleForWorktree(autoNameInput, {
            currentSelection: this.getFocusedAgentSelectionForCwd(autoNameInput.workspace.cwd),
          }),
        startWorkspaceSetup: (workspaceId, operation) =>
          this.workspaceSetupRuntime.start(workspaceId, operation),
        assertWorkspaceAutomationAllowed: (workspaceId) =>
          assertWorkspaceAutomationAllowedForWorkspace(this.workspaceRegistry, workspaceId),
        emitWorkspaceUpdateForWorkspaceId: (workspaceId) =>
          this.workspaceSession.emitWorkspaceUpdateForWorkspaceId(workspaceId),
        cacheWorkspaceSetupSnapshot: (workspaceId, snapshot) => {
          this.workspaceSetupObservation.cache(workspaceId, snapshot);
        },
        emit: (message) => this.emit(message),
        sessionLogger: this.sessionLogger,
        terminalManager: this.terminalManager,
        serviceProxy: this.serviceProxy,
        scriptRuntimeStore: this.scriptRuntimeStore,
        getDaemonTcpPort: this.getDaemonTcpPort,
        getDaemonTcpHost: this.getDaemonTcpHost,
        serviceProxyPublicBaseUrl: this.serviceProxyPublicBaseUrl,
        onScriptsChanged: (workspaceId, workspaceDirectory) => {
          this.workspaceScripts.emitStatusUpdate(workspaceId, workspaceDirectory);
        },
      },
      input,
      options,
    );
  }

  private async handleWorkspaceSetupStatusRequest(
    request: Extract<SessionInboundMessage, { type: "workspace_setup_status_request" }>,
  ): Promise<void> {
    return handleWorkspaceSetupStatusRequestMessage(
      {
        emit: (message) => this.emit(message),
        workspaceSetupSnapshots: this.workspaceSetupObservation,
        getWorkspace: (workspaceId) => this.workspaceRegistry.get(workspaceId),
      },
      request,
    );
  }

  private async handleWorkspaceSetupRunRequest(
    request: Extract<SessionInboundMessage, { type: "workspace.setup.run.request" }>,
  ): Promise<void> {
    return handleWorkspaceSetupRunRequestMessage(
      {
        getWorkspace: (workspaceId) => this.workspaceRegistry.get(workspaceId),
        clearAutomationBlock: (workspaceId) =>
          clearWorkspaceAutomationBlock(this.workspaceRegistry, workspaceId),
        startWorkspaceSetup: (workspaceId, operation) =>
          this.workspaceSetupRuntime.start(workspaceId, operation),
        paseoHome: this.paseoHome,
        worktreesRoot: this.worktreesRoot,
        emitWorkspaceUpdateForWorkspaceId: (workspaceId) =>
          this.workspaceSession.emitWorkspaceUpdateForWorkspaceId(workspaceId),
        cacheWorkspaceSetupSnapshot: (workspaceId, snapshot) =>
          this.workspaceSetupObservation.cache(workspaceId, snapshot),
        emit: (message) => this.emit(message),
        sessionLogger: this.sessionLogger,
        terminalManager: this.terminalManager,
        serviceProxy: this.serviceProxy,
        scriptRuntimeStore: this.scriptRuntimeStore,
        getDaemonTcpPort: this.getDaemonTcpPort,
        getDaemonTcpHost: this.getDaemonTcpHost,
        serviceProxyPublicBaseUrl: this.serviceProxyPublicBaseUrl,
        onScriptsChanged: (workspaceId, workspaceDirectory) =>
          this.workspaceScripts.emitStatusUpdate(workspaceId, workspaceDirectory),
      },
      request,
    );
  }

  private async handleArchiveWorkspaceRequest(
    request: Extract<SessionInboundMessage, { type: "archive_workspace_request" }>,
  ): Promise<void> {
    try {
      const existing = await this.workspaceRegistry.get(request.workspaceId);
      if (!existing) {
        throw new Error(`Workspace not found: ${request.workspaceId}`);
      }

      await archiveByScope(
        {
          paseoHome: this.paseoHome,
          paseoWorktreesBaseRoot: this.worktreesRoot,
          github: this.github,
          workspaceGitService: this.workspaceGitService,
          agentManager: this.agentManager,
          agentStorage: this.agentStorage,
          findWorkspaceIdForCwd: (cwd) => this.findWorkspaceIdForCwd(cwd),
          getWorkspace: (workspaceId) => this.workspaceRegistry.get(workspaceId),
          listActiveWorkspaces: () => this.listActiveWorkspaceRefs(),
          archiveWorkspaceRecord: (workspaceId) =>
            this.workspaceSession.archiveWorkspaceRecord(workspaceId),
          emitWorkspaceUpdatesForWorkspaceIds: (workspaceIds) =>
            this.workspaceSession.emitWorkspaceUpdatesForWorkspaceIds(workspaceIds),
          markWorkspaceArchiving: (workspaceIds, archivingAt) =>
            this.workspaceSession.markWorkspaceArchiving(workspaceIds, archivingAt),
          clearWorkspaceArchiving: (workspaceIds) =>
            this.workspaceSession.clearWorkspaceArchiving(workspaceIds),
          assertWorkspaceAutomationAllowed: (workspaceId) =>
            assertWorkspaceAutomationAllowedForWorkspace(this.workspaceRegistry, workspaceId),
          killTerminalsForWorkspace: (workspaceId) =>
            this.terminalController.killTerminalsForWorkspace(workspaceId),
          stopWorkspaceSetup: (workspaceId) => this.workspaceSetupRuntime.stop(workspaceId),
          sessionLogger: this.sessionLogger,
        },
        {
          scope: { kind: "workspace", workspaceId: existing.workspaceId },
          requestId: request.requestId,
        },
      );

      const archivedWorkspace = await this.workspaceRegistry.get(request.workspaceId);
      const archivedAt = archivedWorkspace?.archivedAt ?? new Date().toISOString();
      this.emit({
        type: "archive_workspace_response",
        payload: {
          requestId: request.requestId,
          workspaceId: request.workspaceId,
          archivedAt,
          error: null,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to archive workspace";
      this.sessionLogger.error(
        { err: error, workspaceId: request.workspaceId },
        "Failed to archive workspace",
      );
      this.emit({
        type: "archive_workspace_response",
        payload: {
          requestId: request.requestId,
          workspaceId: request.workspaceId,
          archivedAt: null,
          error: message,
        },
      });
    }
  }

  private async handleWorkspaceClearAttentionRequest(
    request: Extract<SessionInboundMessage, { type: "workspace.clear_attention.request" }>,
  ): Promise<void> {
    const { requestId, workspaceId } = request;
    const requestedWorkspaceIds = Array.isArray(workspaceId) ? workspaceId : [workspaceId];
    let agents: AgentSnapshotPayload[];
    try {
      agents = await this.listAgentPayloads({ includeBackground: true });
    } catch (error) {
      const message = getErrorMessage(error);
      const results = requestedWorkspaceIds.map((requestedWorkspaceId) => ({
        workspaceId: requestedWorkspaceId,
        clearedAgentIds: [],
        success: false,
        error: message,
      }));
      this.emit({
        type: "workspace.clear_attention.response",
        payload: {
          requestId,
          workspaceId,
          clearedAgentIds: [],
          results,
          success: false,
          error: message,
        },
      });
      return;
    }
    const results: Array<{
      workspaceId: string;
      clearedAgentIds: string[];
      success: boolean;
      error: string | null;
    }> = [];

    for (const requestedWorkspaceId of requestedWorkspaceIds) {
      const clearedAgentIds: string[] = [];
      try {
        const workspace = await this.workspaceRegistry.get(requestedWorkspaceId);
        if (!workspace || workspace.archivedAt) {
          throw new Error(`Workspace not found: ${requestedWorkspaceId}`);
        }

        // Clearing attention is scoped to the workspace that OWNS the agent, by
        // workspaceId — never by comparing cwd strings. A sibling workspace
        // sharing the same directory keeps its own agents' attention.
        const clearableAgentIds = agents
          .filter((agent) => !agent.archivedAt)
          .filter((agent) => agent.workspaceId === workspace.workspaceId)
          .filter((agent) => agent.requiresAttention === true)
          .filter((agent) => (agent.pendingPermissions?.length ?? 0) === 0)
          .filter((agent) => agent.attentionReason !== "permission")
          .map((agent) => agent.id);

        for (const agentId of clearableAgentIds) {
          const liveAgent = this.agentManager.getAgent(agentId);
          if (liveAgent) {
            await this.agentManager.clearAgentAttention(agentId);
            clearedAgentIds.push(agentId);
            continue;
          }

          const record = await this.agentStorage.get(agentId);
          if (
            !record ||
            record.internal ||
            record.archivedAt ||
            record.requiresAttention !== true
          ) {
            continue;
          }
          const nextRecord: StoredAgentRecord = {
            ...record,
            updatedAt: new Date().toISOString(),
            requiresAttention: false,
            attentionReason: null,
            attentionTimestamp: null,
          };
          await this.agentStorage.upsert(nextRecord);
          const agent = this.buildStoredAgentPayload(nextRecord);
          const project = await this.buildProjectPlacementForWorkspace(workspace);
          this.emit({
            type: "agent_update",
            payload: {
              kind: "upsert",
              agent,
              project,
            },
          });
          clearedAgentIds.push(agentId);
        }

        await this.workspaceSession.emitWorkspaceUpdateForWorkspaceId(workspace.workspaceId);
        results.push({
          workspaceId: requestedWorkspaceId,
          clearedAgentIds,
          success: true,
          error: null,
        });
      } catch (error) {
        const message = getErrorMessage(error);
        this.sessionLogger.error(
          { err: error, workspaceId: requestedWorkspaceId },
          "Failed to clear workspace attention",
        );
        results.push({
          workspaceId: requestedWorkspaceId,
          clearedAgentIds,
          success: false,
          error: message,
        });
      }
    }

    const clearedAgentIds = results.flatMap((result) => result.clearedAgentIds);
    const failedResults = results.filter((result) => !result.success);
    this.emit({
      type: "workspace.clear_attention.response",
      payload: {
        requestId,
        workspaceId,
        clearedAgentIds,
        results,
        success: failedResults.length === 0,
        error:
          failedResults.length === 0
            ? null
            : failedResults
                .map((result) => result.error)
                .filter((error) => error !== null)
                .join("; "),
      },
    });
  }

  private async handleWorkspaceMarkUnreadRequest(
    request: Extract<SessionInboundMessage, { type: "workspace.mark_unread.request" }>,
  ): Promise<void> {
    const { requestId, workspaceId } = request;
    let markedAgentId: string | null = null;
    try {
      const workspace = await this.workspaceRegistry.get(workspaceId);
      if (!workspace || workspace.archivedAt) {
        throw new Error(`Workspace not found: ${workspaceId}`);
      }

      const agents = (await this.listAgentPayloads({ includeBackground: true })).filter((agent) =>
        this.isProviderVisibleToClient(agent.provider),
      );
      const agentsById = new Map(agents.map((agent) => [agent.id, agent] as const));
      const candidates = agents
        .filter((agent) => !agent.archivedAt && agent.workspaceId === workspace.workspaceId)
        .filter((agent) => resolveWorkspaceRootAgent(agent, agentsById)?.id === agent.id)
        .filter((agent) => agent.status === "idle" || agent.status === "closed")
        .filter((agent) => agent.requiresAttention !== true)
        .filter((agent) => (agent.pendingPermissions?.length ?? 0) === 0)
        .sort(
          (left, right) =>
            right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id),
        );
      const candidate = candidates[0];
      if (!candidate) {
        throw new Error(`Workspace has no finished agent to mark unread: ${workspaceId}`);
      }

      await this.agentManager.markAgentUnread(candidate.id);
      markedAgentId = candidate.id;
      this.emit({
        type: "workspace.mark_unread.response",
        payload: {
          requestId,
          workspaceId,
          markedAgentId,
          success: true,
          error: null,
        },
      });
    } catch (error) {
      const message = getErrorMessage(error);
      this.sessionLogger.error({ err: error, workspaceId }, "Failed to mark workspace unread");
      this.emit({
        type: "workspace.mark_unread.response",
        payload: {
          requestId,
          workspaceId,
          markedAgentId,
          success: false,
          error: message,
        },
      });
    }
  }

  private async handleFetchAgentTimelineRequest(
    msg: Extract<SessionInboundMessage, { type: "fetch_agent_timeline_request" }>,
    source?: object,
  ): Promise<void> {
    const direction: AgentTimelineFetchDirection = msg.direction ?? (msg.cursor ? "after" : "tail");
    const projection = "projected" as const;
    const requestedLimit = msg.limit;
    const pageLimit = requestedLimit ?? (direction === "after" ? 0 : 200);
    const cursor: AgentTimelineCursor | undefined = msg.cursor
      ? {
          epoch: msg.cursor.epoch,
          seq: msg.cursor.seq,
        }
      : undefined;

    try {
      const snapshot = await ensureAgentLoaded(msg.agentId, {
        agentManager: this.agentManager,
        agentStorage: this.agentStorage,
        logger: this.sessionLogger,
      });
      const agentPayload = await this.buildAgentPayload(snapshot);

      const fetchedControlTimeline = this.agentManager.fetchTimeline(msg.agentId, {
        direction,
        cursor,
        limit: pageLimit,
      });
      const selectedTimeline = {
        timeline: fetchedControlTimeline,
        entries: fetchedControlTimeline.rows,
        startSeq: fetchedControlTimeline.startSeq,
        endSeq: fetchedControlTimeline.endSeq,
        hasOlder: fetchedControlTimeline.hasOlder,
        hasNewer: fetchedControlTimeline.hasNewer,
      };
      const startCursor =
        selectedTimeline.startSeq !== null
          ? { epoch: selectedTimeline.timeline.epoch, seq: selectedTimeline.startSeq }
          : null;
      const endCursor =
        selectedTimeline.endSeq !== null
          ? { epoch: selectedTimeline.timeline.epoch, seq: selectedTimeline.endSeq }
          : null;
      const entries = selectedTimeline.entries.filter((entry) =>
        this.supportsTimelineItem(entry.item, source),
      );

      this.emitForSource(
        {
          type: "fetch_agent_timeline_response",
          payload: {
            requestId: msg.requestId,
            agentId: msg.agentId,
            agent: agentPayload,
            direction,
            projection,
            epoch: selectedTimeline.timeline.epoch,
            reset: fetchedControlTimeline.reset,
            staleCursor: fetchedControlTimeline.staleCursor,
            gap: fetchedControlTimeline.gap,
            window: selectedTimeline.timeline.window,
            startCursor,
            endCursor,
            hasOlder: selectedTimeline.hasOlder,
            hasNewer: selectedTimeline.hasNewer,
            ...(msg.mergeWindow === true ? { mergeWindow: true } : {}),
            entries: entries.map((entry) => {
              const payloadEntry = {
                provider: snapshot.provider,
                item: entry.item,
                timestamp: entry.timestamp,
                seqStart: entry.seqStart,
                seqEnd: entry.seqEnd,
                sourceSeqRanges: entry.sourceSeqRanges,
                turnId: undefined as string | undefined,
                collapsed: (
                  source
                    ? this.supportsForSource(CLIENT_CAPS.reasoningMergeEnum, source)
                    : this.supports(CLIENT_CAPS.reasoningMergeEnum)
                )
                  ? entry.collapsed
                  : entry.collapsed.filter((value) => value !== "reasoning_merge"),
              };
              payloadEntry.turnId = entry.turnId;
              return payloadEntry;
            }),
            error: null,
          },
        },
        source,
      );
    } catch (error) {
      this.sessionLogger.error(
        { err: error, agentId: msg.agentId },
        "Failed to handle fetch_agent_timeline_request",
      );
      this.emitForSource(
        {
          type: "fetch_agent_timeline_response",
          payload: {
            requestId: msg.requestId,
            agentId: msg.agentId,
            agent: null,
            direction,
            projection,
            epoch: "",
            reset: false,
            staleCursor: false,
            gap: false,
            window: { minSeq: 0, maxSeq: 0, nextSeq: 0 },
            startCursor: null,
            endCursor: null,
            hasOlder: false,
            hasNewer: false,
            ...(msg.mergeWindow === true ? { mergeWindow: true } : {}),
            entries: [],
            error: error instanceof Error ? error.message : String(error),
          },
        },
        source,
      );
    }
  }

  private async handleAgentTimelineAppendRequest(
    msg: Extract<SessionInboundMessage, { type: "agent.timeline.append.request" }>,
  ): Promise<void> {
    const pluginId = parsePluginClientId(this.clientId);
    if (!pluginId) throw new Error("Only plugin sessions can append plugin timeline items");
    assertPluginTimelineDataSize(msg.item.data);
    const { seq, epoch } = await this.agentManager.appendTimelineItem(msg.agentId, {
      ...msg.item,
      pluginId,
    });
    this.emit({
      type: "agent.timeline.append.response",
      payload: { requestId: msg.requestId, seq, epoch },
    });
  }

  private async handleAgentTimelineSearchRequest(
    msg: Extract<SessionInboundMessage, { type: "agent.timeline.search.request" }>,
    source?: object,
  ): Promise<void> {
    try {
      await ensureAgentLoaded(msg.agentId, {
        agentManager: this.agentManager,
        agentStorage: this.agentStorage,
        logger: this.sessionLogger,
      });
      const rows = await this.agentManager.getTimelineRows(msg.agentId);
      const { epoch } = this.agentManager.fetchTimeline(msg.agentId, {
        direction: "tail",
        limit: 1,
      });
      const result = await searchTimeline({ rows, query: msg.query, cursor: msg.cursor });
      if (
        this.agentManager.fetchTimeline(msg.agentId, { direction: "tail", limit: 1 }).epoch !==
        epoch
      ) {
        throw new Error("History changed; search again");
      }
      this.emitForSource(
        {
          type: "agent.timeline.search.response",
          payload: {
            requestId: msg.requestId,
            agentId: msg.agentId,
            epoch,
            ...result,
            error: null,
          },
        },
        source,
      );
    } catch (error) {
      this.emitForSource(
        {
          type: "agent.timeline.search.response",
          payload: {
            requestId: msg.requestId,
            agentId: msg.agentId,
            epoch: "",
            locations: [],
            nextCursor: null,
            error: error instanceof Error ? error.message : String(error),
          },
        },
        source,
      );
    }
  }

  private async handleAgentTimelineListPromptsRequest(
    msg: Extract<SessionInboundMessage, { type: "agent.timeline.list_prompts.request" }>,
    source?: object,
  ): Promise<void> {
    try {
      await ensureAgentLoaded(msg.agentId, {
        agentManager: this.agentManager,
        agentStorage: this.agentStorage,
        logger: this.sessionLogger,
      });
      const rows = await this.agentManager.getTimelineRows(msg.agentId);
      const timeline = this.agentManager.fetchTimeline(msg.agentId, {
        direction: "tail",
        limit: 1,
      });
      const index = buildTimelinePromptIndex(timeline.epoch, rows);
      this.emitForSource(
        {
          type: "agent.timeline.list_prompts.response",
          payload: {
            requestId: msg.requestId,
            agentId: msg.agentId,
            ...index,
            error: null,
          },
        },
        source,
      );
    } catch (error) {
      this.sessionLogger.error(
        { err: error, agentId: msg.agentId },
        "Failed to handle agent.timeline.list_prompts.request",
      );
      this.emitForSource(
        {
          type: "agent.timeline.list_prompts.response",
          payload: {
            requestId: msg.requestId,
            agentId: msg.agentId,
            epoch: "",
            prompts: [],
            error: error instanceof Error ? error.message : String(error),
          },
        },
        source,
      );
    }
  }

  private async handleProviderSubagentListRequest(
    msg: Extract<SessionInboundMessage, { type: "agent.provider_subagents.list.request" }>,
  ): Promise<void> {
    try {
      await ensureUnarchivedAgentLoaded(msg.parentAgentId, {
        agentManager: this.agentManager,
        agentStorage: this.agentStorage,
        logger: this.sessionLogger,
      });
      this.emit({
        type: "agent.provider_subagents.list.response",
        payload: {
          requestId: msg.requestId,
          parentAgentId: msg.parentAgentId,
          subagents: this.agentManager.listProviderSubagents(msg.parentAgentId),
          error: null,
        },
      });
    } catch (error) {
      this.emit({
        type: "agent.provider_subagents.list.response",
        payload: {
          requestId: msg.requestId,
          parentAgentId: msg.parentAgentId,
          subagents: [],
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private async handleProviderSubagentTimelineRequest(
    msg: Extract<SessionInboundMessage, { type: "agent.provider_subagents.timeline.get.request" }>,
    source?: object,
  ): Promise<void> {
    const direction: AgentTimelineFetchDirection = msg.direction ?? (msg.cursor ? "after" : "tail");
    try {
      await ensureUnarchivedAgentLoaded(msg.parentAgentId, {
        agentManager: this.agentManager,
        agentStorage: this.agentStorage,
        logger: this.sessionLogger,
      });
      const descriptor = this.agentManager.getProviderSubagent(msg.parentAgentId, msg.subagentId);
      if (!descriptor) {
        throw new Error("Provider subagent not found");
      }
      // COMPAT(projectedSubagentTimeline): added after v0.8.0, remove after 2027-03-14.
      const supportsProjection = source
        ? this.supportsForSource(CLIENT_CAPS.projectedSubagentTimeline, source)
        : this.supports(CLIENT_CAPS.projectedSubagentTimeline);
      const timeline = this.agentManager.fetchProviderSubagentTimeline(
        msg.parentAgentId,
        msg.subagentId,
        {
          direction,
          cursor: msg.cursor,
          limit: msg.limit ?? (direction === "after" ? 0 : 200),
        },
      );
      const rows = timeline.rows.filter((row) => this.supportsTimelineItem(row.item, source));
      this.emitForSource(
        {
          type: "agent.provider_subagents.timeline.get.response",
          payload: {
            requestId: msg.requestId,
            parentAgentId: msg.parentAgentId,
            subagentId: msg.subagentId,
            provider: descriptor.provider,
            direction,
            epoch: timeline.epoch,
            projection: "projected",
            startCursor:
              timeline.startSeq === null ? null : { epoch: timeline.epoch, seq: timeline.startSeq },
            endCursor:
              timeline.endSeq === null ? null : { epoch: timeline.epoch, seq: timeline.endSeq },
            reset: timeline.reset,
            staleCursor: timeline.staleCursor,
            gap: timeline.gap,
            window: timeline.window,
            hasOlder: supportsProjection && timeline.hasOlder,
            hasNewer: supportsProjection && timeline.hasNewer,
            rows: supportsProjection
              ? rows.map((row) => ({
                  item: row.item,
                  timestamp: row.timestamp,
                  seq: row.seqEnd,
                  seqStart: row.seqStart,
                  seqEnd: row.seqEnd,
                  sourceSeqRanges: row.sourceSeqRanges,
                }))
              : [
                  {
                    seq: timeline.window.maxSeq,
                    timestamp: new Date().toISOString(),
                    item: {
                      type: "assistant_message",
                      text: "Please upgrade the Paseo app to view this subagent conversation.",
                    },
                  },
                ],
            error: null,
          },
        },
        source,
      );
    } catch (error) {
      this.emitForSource(
        {
          type: "agent.provider_subagents.timeline.get.response",
          payload: {
            requestId: msg.requestId,
            parentAgentId: msg.parentAgentId,
            subagentId: msg.subagentId,
            provider: null,
            direction,
            epoch: "",
            reset: false,
            staleCursor: false,
            gap: false,
            window: { minSeq: 0, maxSeq: 0, nextSeq: 0 },
            hasOlder: false,
            hasNewer: false,
            rows: [],
            error: error instanceof Error ? error.message : String(error),
          },
        },
        source,
      );
    }
  }

  private async handleAgentForkContextRequest(
    msg: Extract<SessionInboundMessage, { type: "agent.fork_context.request" }>,
  ): Promise<void> {
    try {
      const snapshot = await ensureAgentLoaded(msg.agentId, {
        agentManager: this.agentManager,
        agentStorage: this.agentStorage,
        logger: this.sessionLogger,
      });
      const agentPayload = await this.buildAgentPayload(snapshot);
      const timeline = this.agentManager.fetchTimeline(msg.agentId, {
        direction: "tail",
        limit: 0,
      });
      const forkContext = buildAgentForkContextAttachment({
        rows: timeline.rows,
        cursorBoundary: msg.boundaryCursor
          ? { timelineEpoch: timeline.epoch, cursor: msg.boundaryCursor }
          : null,
        boundaryMessageId: msg.boundaryMessageId,
        agentTitle: agentPayload.title,
        cwd: snapshot.cwd,
      });

      this.emit({
        type: "agent.fork_context.response",
        payload: {
          requestId: msg.requestId,
          agentId: msg.agentId,
          attachment: forkContext.attachment,
          itemCount: forkContext.itemCount,
          boundaryCursor: forkContext.boundaryCursor,
          boundaryMessageId: forkContext.boundaryMessageId,
          error: null,
        },
      });
    } catch (error) {
      this.sessionLogger.error(
        { err: error, agentId: msg.agentId },
        "Failed to handle agent.fork_context.request",
      );
      this.emit({
        type: "agent.fork_context.response",
        payload: {
          requestId: msg.requestId,
          agentId: msg.agentId,
          attachment: null,
          itemCount: 0,
          boundaryCursor: msg.boundaryCursor ?? null,
          boundaryMessageId: msg.boundaryMessageId ?? null,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  /**
   * Emit a message to the client
   */
  // COMPAT(explicitEventSubscriptions): added in v0.8.0, remove legacy broadcasts after 2027-03-08.
  private wantsEvent(event: SessionEventSubscription, source?: object): boolean {
    // COMPAT(workspaceSetupObservation): added in v0.12.0, remove global setup delivery after 2027-04-19 once client floor >= v0.12.0.
    if (
      event === "workspace_setup_progress" &&
      source &&
      this.supportsForSource(CLIENT_CAPS.workspaceSetupObservation, source)
    )
      return false;
    for (const subscription of this.eventSubscriptions.values()) {
      if (
        (!source || subscription.owner.source === source) &&
        subscription.events.has(event) &&
        !(
          event === "workspace_setup_progress" &&
          this.supportsForSource(CLIENT_CAPS.workspaceSetupObservation, subscription.owner.source)
        )
      )
        return true;
    }
    if (!source && this.clientSources.size > 0) {
      return [...this.clientSources.keys()].some((candidate) => this.wantsEvent(event, candidate));
    }
    if (source && this.delivery.isModern(source)) return false;
    if (!source && !this.delivery.hasLegacySources()) return false;
    // COMPAT(ownedSubscriptions): added in v0.8.0, remove implicit event delivery after 2027-03-09.
    const capabilities = source
      ? (this.clientSources.get(source)?.capabilities ?? this.clientCapabilities)
      : this.clientCapabilities;
    return legacyWantsEvent(event, capabilities);
  }

  private emitEventToOwner(
    subscription: { owner: OwnedSubscription; notifications: boolean },
    message: SessionOutboundMessage,
    notified: Set<object>,
  ): void {
    if (
      message.type !== "agent_attention_required" &&
      message.type !== "terminal_attention_required"
    ) {
      subscription.owner.emit(message);
      return;
    }
    const shouldNotify =
      message.payload.shouldNotify &&
      subscription.notifications &&
      !notified.has(subscription.owner.source);
    subscription.owner.emit(
      message.type === "agent_attention_required"
        ? { ...message, payload: { ...message.payload, shouldNotify } }
        : { ...message, payload: { ...message.payload, shouldNotify } },
    );
    if (shouldNotify) notified.add(subscription.owner.source);
  }

  private emitSubscribedEvent(message: SessionOutboundMessage, onlySource?: object): boolean {
    const event = sessionEventCategory(message);
    if (!event) return false;
    if (!this.authorization.allowsOutbound(message)) return true;
    const delivered = new Set<object>();
    const notified = new Set<object>();
    for (const subscription of this.eventSubscriptions.values()) {
      if (
        !subscription.events.has(event) ||
        (event === "workspace_setup_progress" &&
          this.supportsForSource(
            CLIENT_CAPS.workspaceSetupObservation,
            subscription.owner.source,
          )) ||
        (onlySource && subscription.owner.source !== onlySource)
      )
        continue;
      this.emitEventToOwner(subscription, message, notified);
      delivered.add(subscription.owner.source);
    }
    // COMPAT(ownedSubscriptions): added in v0.8.0, remove implicit event delivery after 2027-03-09.
    if (this.onMessageToSource && this.clientSources.size > 0) {
      for (const source of this.clientSources.keys()) {
        if (
          (!onlySource || source === onlySource) &&
          !delivered.has(source) &&
          !this.delivery.isModern(source) &&
          this.wantsEvent(event, source)
        )
          this.onMessageToSource(source, this.workspaceSetupMessageForClient(message, source));
      }
    } else if (delivered.size === 0 && this.wantsEvent(event)) this.onMessage(message);
    return true;
  }

  private emit(msg: SessionOutboundMessage): void {
    if (!this.authorization.allowsOutbound(msg)) return;
    if (msg.type === "workspace_setup_progress") {
      const { workspaceId, subscriptionId: _subscriptionId, ...snapshot } = msg.payload;
      this.workspaceSetupObservation.publish(workspaceId, snapshot);
      return;
    }
    if (this.delivery.reply(msg)) return;
    if (this.emitSubscribedEvent(msg)) return;
    // JSON.stringify(msg) is only computed when trace is enabled — it runs for
    // every outbound message otherwise, and trace is disabled by default.
    // Optional-chained because test logger stubs don't implement isLevelEnabled.
    if (this.sessionLogger.isLevelEnabled?.("trace")) {
      this.sessionLogger.trace(
        {
          messageType: msg.type,
          payloadBytes: JSON.stringify(msg).length,
        },
        "agent.session.outbound",
      );
    }
    if (msg.type === "workspace_setup_status_response") {
      if (this.clientSources.size > 0 && this.onMessageToSource) {
        for (const [source] of this.clientSources) {
          this.onMessageToSource(source, this.workspaceSetupMessageForClient(msg, source));
        }
        return;
      }
      msg = this.workspaceSetupMessageForClient(msg);
    }
    this.onMessage(msg);
  }

  // COMPAT(workspaceSetupBlocked): added in v0.8.0, remove after 2027-03-07 once client floor >= v0.8.0.
  private workspaceSetupMessageForClient(
    message: SessionOutboundMessage,
    source?: object,
  ): SessionOutboundMessage {
    if (
      message.type !== "workspace_setup_progress" &&
      message.type !== "workspace_setup_status_response"
    )
      return message;
    const supportsBlocked = source
      ? this.supportsForSource(CLIENT_CAPS.workspaceSetupBlocked, source)
      : this.supports(CLIENT_CAPS.workspaceSetupBlocked);
    const snapshot =
      message.type === "workspace_setup_progress" ? message.payload : message.payload.snapshot;
    if (supportsBlocked || snapshot?.status !== "blocked") return message;
    const legacySnapshot = {
      ...snapshot,
      status: "failed" as const,
      error:
        "Workspace setup is blocked pending approval of code from a fork pull request. Update Paseo to review and run setup.",
    };
    return message.type === "workspace_setup_progress"
      ? { ...message, payload: { ...message.payload, ...legacySnapshot } }
      : { ...message, payload: { ...message.payload, snapshot: legacySnapshot } };
  }

  private emitBinary(frame: Uint8Array): void {
    if (!this.onBinaryMessage) {
      return;
    }
    try {
      this.onBinaryMessage(frame);
    } catch (error) {
      this.sessionLogger.error({ err: error }, "Failed to emit binary frame");
    }
  }

  private async emitBinaryForFileTransfer(frame: Uint8Array, source?: object): Promise<void> {
    if (source && this.onBinaryMessageToSource) {
      this.delivery.authorizeFileReply(frame, source);
      await this.onBinaryMessageToSource(source, frame);
      return;
    }
    this.emitBinary(frame);
  }

  private emitForSource(msg: SessionOutboundMessage, source?: object): void {
    if (source && this.onMessageToSource) {
      msg = this.delivery.authorizeReply(msg, source);
      this.onMessageToSource(source, msg);
      return;
    }
    this.emit(msg);
  }

  /**
   * Clean up session resources
   */
  public async cleanup(): Promise<void> {
    this.sessionLogger.trace({}, "agent.session.lifecycle.cleanup");
    this.isCleanedUp = true;
    this.unsubscribeSetupObservation();
    await this.delivery.close();

    if (this.unsubscribeAgentEvents) {
      this.unsubscribeAgentEvents();
      this.unsubscribeAgentEvents = null;
    }
    this.unsubscribeProjectMutations?.();
    this.unsubscribeProjectMutations = null;
    this.unsubscribePluginChanges?.();
    this.unsubscribePluginChanges = null;
    this.unsubscribeWorkspaceMutations?.();
    this.unsubscribeWorkspaceMutations = null;
    this.agentUpdates.dispose();
    await this.hubExecutionController?.cleanup();
    if (this.unsubscribeTerminalWorkspaceContributionEvents) {
      this.unsubscribeTerminalWorkspaceContributionEvents();
      this.unsubscribeTerminalWorkspaceContributionEvents = null;
    }
    this.providerCatalogSession.dispose();

    this.terminalController.dispose();

    this.checkoutSession.cleanup();

    this.workspaceGitObserver.dispose();
  }
}

interface CloneRepositoryInput {
  name: string;
  displayName: string;
  cloneUrl: string;
}

function normalizeCloneRepository(input: {
  repo: string;
  cloneProtocol?: "https" | "ssh";
}): CloneRepositoryInput {
  const trimmed = input.repo.trim();
  if (!trimmed) {
    throw new Error("Repository is required");
  }

  const remote = parseGitRemoteLocation(trimmed);
  if (remote) {
    const segments = remote.path.split("/").filter(Boolean);
    const name = segments.at(-1);
    if (!name || !isValidGitHubRepoSegment(name)) {
      throw new Error("Repository name contains invalid characters");
    }
    return { name, displayName: remote.path, cloneUrl: trimmed };
  }

  const [owner, rawName, ...extra] = trimmed.split("/");
  if (!owner || !rawName || extra.length > 0) {
    throw new Error("Repository must use owner/repo format or a git remote URL");
  }
  const name = rawName.endsWith(".git") ? rawName.slice(0, -4) : rawName;
  if (!isValidGitHubRepoSegment(owner) || !isValidGitHubRepoSegment(name)) {
    throw new Error("Repository contains invalid characters");
  }
  if (!input.cloneProtocol) {
    throw new Error("Clone protocol is required for owner/repo repository names");
  }
  const cloneUrl =
    input.cloneProtocol === "ssh"
      ? `git@github.com:${owner}/${name}.git`
      : `https://github.com/${owner}/${name}.git`;
  return {
    name,
    displayName: `${owner}/${name}`,
    cloneUrl,
  };
}

function isValidGitHubRepoSegment(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/u.test(value);
}

function sessionEventCategory(message: SessionOutboundMessage): SessionEventSubscription | null {
  switch (message.type) {
    case "project.update":
    case "providers_snapshot_update":
    case "agent_attention_required":
    case "agent_permission_request":
    case "agent_permission_resolved":
    case "checkout_status_update":
    case "script_status_update":
    case "workspace_setup_progress":
    case "agent.provider_subagents.update":
    case "terminal_attention_required":
    case "activity_log":
    case "hub.execution.agent.update":
    case "hub.execution.agent.stream":
      return message.type;
    case "status":
      switch (message.payload.status) {
        case "server_info":
          return "status.server_info";
        case "daemon_config_changed":
          return "status.daemon_config_changed";
        case "plugin_catalog_changed":
          return "status.plugin_catalog_changed";
        case "plugin_settings_changed":
          return "status.plugin_settings_changed";
        default:
          return null;
      }
    default:
      return null;
  }
}

// COMPAT(ownedSubscriptions): added in v0.8.0, remove implicit event delivery after 2027-03-09.
function legacyWantsEvent(
  event: SessionEventSubscription,
  capabilities: ReadonlySet<ClientCapability>,
): boolean {
  if (event === "project.update" && !capabilities.has(CLIENT_CAPS.projectUpdates)) return false;
  switch (event) {
    case "project.update":
    case "providers_snapshot_update":
    case "agent_attention_required":
    case "agent_permission_request":
    case "agent_permission_resolved":
      return !capabilities.has(CLIENT_CAPS.explicitEventSubscriptions);
    case "agent.provider_subagents.update":
      return capabilities.has(CLIENT_CAPS.providerSubagents);
    default:
      return true;
  }
}
