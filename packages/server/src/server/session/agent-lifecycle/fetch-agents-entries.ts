import { getAgentStatusPriority } from "@getpaseo/protocol/agent-state-bucket";
import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import type {
  AgentSnapshotPayload,
  ProjectPlacementPayload,
  SessionInboundMessage,
  SessionOutboundMessage,
} from "../../messages.js";
import type { AgentDirectory } from "../../agent/directory.js";
import type { DirectorySyncService } from "../../directory-sync/index.js";
import { matchesAgentHistoryQuery } from "../../agent-history-search.js";
import { CursorError } from "../../pagination/cursor.js";
import { SortablePager, type SortSpec } from "../../pagination/sortable-pager.js";
import { matchesAgentUpdatesFilter } from "../agent-updates/agent-updates-service.js";
import { SessionRequestError } from "../session-request-error.js";

const FETCH_AGENTS_SORT_KEYS = ["status_priority", "created_at", "updated_at", "title"] as const;

type FetchAgentsRequestMessage = Extract<SessionInboundMessage, { type: "fetch_agents_request" }>;
type FetchAgentHistoryRequestMessage = Extract<
  SessionInboundMessage,
  { type: "fetch_agent_history_request" }
>;
export type AgentDirectoryRequestMessage =
  | FetchAgentsRequestMessage
  | FetchAgentHistoryRequestMessage;

type FetchAgentsRequestFilter = NonNullable<FetchAgentsRequestMessage["filter"]>;
type FetchAgentsRequestSort = NonNullable<FetchAgentsRequestMessage["sort"]>[number];
type FetchAgentsResponsePayload = Extract<
  SessionOutboundMessage,
  { type: "fetch_agents_response" }
>["payload"];
type FetchAgentsResponseEntry = FetchAgentsResponsePayload["entries"][number];
type FetchAgentsResponsePageInfo = FetchAgentsResponsePayload["pageInfo"];
type AgentUpdatesFilter = FetchAgentsRequestFilter;
type PlacementResolver = (
  workspaceId: string | undefined,
) => Promise<ProjectPlacementPayload | null>;

export interface FetchAgentsEntriesResult {
  entries: FetchAgentsResponseEntry[];
  pageInfo: FetchAgentsResponsePageInfo;
  searchTruncated?: boolean;
}

export interface FetchAgentsEntriesOptions {
  agentDirectory: AgentDirectory;
  listAgentPayloads(
    filter?: Parameters<AgentDirectory["list"]>[0],
  ): Promise<AgentSnapshotPayload[]>;
  directorySync: DirectorySyncService;
  buildProjectPlacementForWorkspaceId(workspaceId: string): Promise<ProjectPlacementPayload | null>;
  buildActiveProjectPlacementsByWorkspaceId(): Promise<Map<string, ProjectPlacementPayload>>;
}

/**
 * Only history carries a query. The active-agents directory filters on
 * structure and never ranks, so it always reads as no query at all.
 */
function agentDirectorySearchQuery(request: AgentDirectoryRequestMessage): string {
  if (request.type !== "fetch_agent_history_request") return "";
  return request.search?.trim() ?? "";
}

/** Sorted, filtered and cursor-paged reads of the agent directory. */
export class FetchAgentsEntries {
  private readonly agentDirectory: AgentDirectory;
  private readonly directorySync: DirectorySyncService;
  private readonly host: Pick<
    FetchAgentsEntriesOptions,
    | "listAgentPayloads"
    | "buildProjectPlacementForWorkspaceId"
    | "buildActiveProjectPlacementsByWorkspaceId"
  >;

  private readonly agentsPager = new SortablePager<
    AgentSnapshotPayload,
    FetchAgentsRequestSort["key"]
  >({
    validKeys: FETCH_AGENTS_SORT_KEYS,
    defaultSort: [{ key: "updated_at", direction: "desc" }],
    label: "fetch_agents",
    getId: (agent) => agent.id,
    getSortValue: (agent, key): number | string => {
      switch (key) {
        case "status_priority":
          return getAgentStatusPriority({
            status: agent.status,
            pendingPermissionCount: agent.pendingPermissions?.length ?? 0,
            requiresAttention: agent.requiresAttention,
            attentionReason: agent.attentionReason ?? null,
          });
        case "created_at":
          return Date.parse(agent.createdAt);
        case "updated_at":
          return Date.parse(agent.updatedAt);
        case "title":
          return agent.title?.toLocaleLowerCase() ?? "";
      }
    },
  });

  constructor(options: FetchAgentsEntriesOptions) {
    this.agentDirectory = options.agentDirectory;
    this.directorySync = options.directorySync;
    this.host = options;
  }

  private decodeAgentCursor(token: string, sort: SortSpec<FetchAgentsRequestSort["key"]>[]) {
    try {
      return this.agentsPager.decode(token, sort);
    } catch (error) {
      if (error instanceof CursorError) {
        throw new SessionRequestError("invalid_cursor", error.message);
      }
      throw error;
    }
  }

  private async collectFetchAgentsEntries(params: {
    candidates: AgentSnapshotPayload[];
    limit: number;
    getPlacement: PlacementResolver;
    filter: AgentUpdatesFilter | undefined;
    search?: string;
  }): Promise<FetchAgentsResponseEntry[]> {
    const { candidates, limit, getPlacement, filter, search } = params;
    const matchedEntries: FetchAgentsResponseEntry[] = [];
    const batchSize = 25;
    for (
      let start = 0;
      start < candidates.length && matchedEntries.length <= limit;
      start += batchSize
    ) {
      const batch = candidates.slice(start, start + batchSize);
      const batchEntries = await Promise.all(
        batch.map(async (agent) => {
          const project = await getPlacement(agent.workspaceId);
          return project ? { agent, project } : null;
        }),
      );
      for (const entry of batchEntries) {
        if (!entry) {
          continue;
        }
        if (
          !matchesAgentUpdatesFilter({
            agent: entry.agent,
            project: entry.project,
            filter,
          })
        ) {
          continue;
        }
        if (search && !matchesAgentHistoryQuery(search, entry)) continue;
        matchedEntries.push(entry);
        if (matchedEntries.length > limit) {
          break;
        }
      }
    }
    return matchedEntries;
  }

  private resolveRequestFilter(
    request: AgentDirectoryRequestMessage,
  ): FetchAgentsRequestFilter | undefined {
    return request.type === "fetch_agent_history_request" &&
      request.filter?.includeArchived === undefined
      ? { ...request.filter, includeArchived: true }
      : request.filter;
  }

  private async listUnscopedAgents(
    request: AgentDirectoryRequestMessage,
    filter: FetchAgentsRequestFilter | undefined,
  ): Promise<AgentSnapshotPayload[]> {
    const agents = await this.host.listAgentPayloads({
      labels: filter?.labels,
      includeArchived: filter?.includeArchived,
      includeBackground:
        filter?.includeBackground ||
        (request.type === "fetch_agents_request" && request.includeBackground),
      includeUnavailablePersisted: request.type === "fetch_agent_history_request",
    });
    if (request.type !== "fetch_agent_history_request" || filter?.labels) {
      return agents;
    }
    return agents.filter(
      (agent) =>
        !(
          agent.archivedAt &&
          (Boolean(getParentAgentIdFromLabels(agent.labels)) ||
            agent.provider.endsWith("-worker") ||
            agent.provider.startsWith("slp-"))
        ),
    );
  }

  private createPlacementResolver(
    activePlacementsByWorkspaceId: Map<string, ProjectPlacementPayload> | null,
  ): PlacementResolver {
    const placementByWorkspaceId = new Map<string, Promise<ProjectPlacementPayload | null>>();
    return (workspaceId) => {
      if (!workspaceId) {
        return Promise.resolve(null);
      }
      if (activePlacementsByWorkspaceId) {
        return Promise.resolve(activePlacementsByWorkspaceId.get(workspaceId) ?? null);
      }
      const existing = placementByWorkspaceId.get(workspaceId);
      if (existing) {
        return existing;
      }
      const placementPromise = this.host.buildProjectPlacementForWorkspaceId(workspaceId);
      placementByWorkspaceId.set(workspaceId, placementPromise);
      return placementPromise;
    };
  }

  private sortAndSeekCandidates(
    agents: AgentSnapshotPayload[],
    sort: SortSpec<FetchAgentsRequestSort["key"]>[],
    cursorToken: string | undefined,
  ): AgentSnapshotPayload[] {
    let candidates = [...agents];
    candidates.sort((left, right) => this.agentsPager.compare(left, right, sort));
    if (cursorToken) {
      const cursor = this.decodeAgentCursor(cursorToken, sort);
      candidates = candidates.filter(
        (agent) => this.agentsPager.compareWithCursor(agent, cursor, sort) > 0,
      );
    }
    return candidates;
  }

  async list(request: AgentDirectoryRequestMessage): Promise<FetchAgentsEntriesResult> {
    const filter = this.resolveRequestFilter(request);
    const scope = request.type === "fetch_agents_request" ? request.scope : undefined;
    const sort = this.agentsPager.normalizeSort(request.sort);

    let agents = await this.listUnscopedAgents(request, filter);
    const activePlacementsByWorkspaceId =
      scope === "active" ? await this.host.buildActiveProjectPlacementsByWorkspaceId() : null;
    if (activePlacementsByWorkspaceId) {
      agents = agents.filter(
        (agent) =>
          !agent.archivedAt &&
          agent.workspaceId != null &&
          activePlacementsByWorkspaceId.has(agent.workspaceId),
      );
    }

    const getPlacement = this.createPlacementResolver(activePlacementsByWorkspaceId);
    const search = agentDirectorySearchQuery(request);
    const candidates = this.sortAndSeekCandidates(agents, sort, request.page?.cursor);
    const limit = request.page?.limit ?? 200;

    const matchedEntries = await this.collectFetchAgentsEntries({
      candidates,
      limit,
      getPlacement,
      filter,
      search,
    });

    const pagedEntries = matchedEntries.slice(0, limit);
    const hasMore = matchedEntries.length > limit;
    const nextCursor =
      hasMore && pagedEntries.length > 0
        ? this.agentsPager.encode(pagedEntries[pagedEntries.length - 1].agent, sort)
        : null;

    return {
      entries: pagedEntries,
      pageInfo: {
        nextCursor,
        prevCursor: request.page?.cursor ?? null,
        hasMore,
      },
    };
  }

  async readSync(request: FetchAgentsRequestMessage) {
    if (request.scope !== "active" || request.filter) {
      throw new SessionRequestError(
        "invalid_request",
        "Sequenced agent directory reads require scope=active and no filter.",
      );
    }
    const snapshot = await this.list({
      ...request,
      includeBackground: true,
      page: { limit: Number.MAX_SAFE_INTEGER },
    });
    const result = this.directorySync.synchronizeAgents(
      snapshot.entries,
      request.sync ?? {},
      request.includeBackground,
    );
    const entries = await Promise.all(
      result.entries.map(async (entry) =>
        (await this.agentDirectory.includes(entry.agent, request.includeBackground)) ? entry : null,
      ),
    );
    return { ...result, entries: entries.filter((entry) => entry !== null) };
  }
}
