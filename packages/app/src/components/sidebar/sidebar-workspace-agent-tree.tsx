import equal from "fast-deep-equal";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ClipboardCheck,
  Compass,
  Crown,
  GitFork,
  Hammer,
  Network,
} from "lucide-react-native";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { Text, View, type GestureResponderEvent } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { PressHighlight } from "@/components/ui/press-highlight";
import { create } from "zustand";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { ClaudeIcon } from "@/components/icons/claude-icon";
import { CodexIcon } from "@/components/icons/codex-icon";
import { CopilotIcon } from "@/components/icons/copilot-icon";
import { MiniMaxIcon } from "@/components/icons/minimax-icon";
import { OmpIcon } from "@/components/icons/omp-icon";
import { OpenCodeIcon } from "@/components/icons/opencode-icon";
import { PiIcon } from "@/components/icons/pi-icon";
import { useProviderIcons, type ProviderIconComponent } from "@/components/provider-icons";
import { StatusRing } from "@/components/status-ring";
import { usePendingArchiveAgentIds } from "@/hooks/use-archive-agent";
import { useFormPreferences } from "@/hooks/use-form-preferences";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useSessionStore, type Agent } from "@/stores/session-store";
import {
  collectAllTabs,
  findPaneById,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import { getParentAddressFromLabels } from "@getpaseo/protocol/agent-labels";
import { isFinishedSubagent } from "@/subagents/archive-finished";
import { isWorkspaceRootAgent } from "@/subagents/policies";
import { refreshProviderSubagents, useProviderSubagentStore } from "@/subagents/provider-store";
import { SlpHierarchyModal } from "./slp-hierarchy-modal";
import {
  selectProviderSubagentsForParent,
  toSubagentRow,
  type SubagentRow,
} from "@/subagents/select";
import { buildSubagentRowPresentationData } from "@/subagents/track-presentation";
import { deriveSidebarStateBucket, type SidebarStateBucket } from "@/utils/sidebar-agent-state";
import { normalizeWorkspaceOpaqueId, normalizeWorkspacePath } from "@/utils/workspace-identity";

export interface ProviderAccentTone {
  text: string;
  border: string;
  bg: string;
}

/**
 * Distinct, non-purple palette per provider so users can identify Claude Code, Codex, Pi,
 * OpenCode, Copilot, MiniMax, OMP, etc. at a single glance.
 */
export function getProviderAccentTone(provider: string): ProviderAccentTone {
  const normalized = provider.trim().toLowerCase();
  if (
    normalized === "claude" ||
    normalized.includes("claude") ||
    normalized.includes("anthropic")
  ) {
    return {
      text: "#e07a5f",
      border: "rgba(224, 122, 95, 0.42)",
      bg: "rgba(224, 122, 95, 0.14)",
    };
  }
  if (normalized === "codex" || normalized.includes("codex") || normalized.includes("openai")) {
    return {
      text: "#10b981",
      border: "rgba(16, 185, 129, 0.42)",
      bg: "rgba(16, 185, 129, 0.14)",
    };
  }
  if (normalized === "pi") {
    return {
      text: "#3b82f6",
      border: "rgba(59, 130, 246, 0.42)",
      bg: "rgba(59, 130, 246, 0.14)",
    };
  }
  if (normalized === "opencode" || normalized.includes("opencode")) {
    return {
      text: "#06b6d4",
      border: "rgba(6, 182, 212, 0.42)",
      bg: "rgba(6, 182, 212, 0.14)",
    };
  }
  if (normalized === "copilot" || normalized.includes("copilot")) {
    return {
      text: "#38bdf8",
      border: "rgba(56, 189, 248, 0.42)",
      bg: "rgba(56, 189, 248, 0.14)",
    };
  }
  if (normalized === "minimax" || normalized.includes("minimax")) {
    return {
      text: "#f59e0b",
      border: "rgba(245, 158, 11, 0.42)",
      bg: "rgba(245, 158, 11, 0.14)",
    };
  }
  if (normalized === "omp") {
    return {
      text: "#14b8a6",
      border: "rgba(20, 184, 166, 0.42)",
      bg: "rgba(20, 184, 166, 0.14)",
    };
  }
  if (normalized === "antigravity" || normalized.includes("antigravity")) {
    return {
      text: "#38bdf8",
      border: "rgba(56, 189, 248, 0.42)",
      bg: "rgba(56, 189, 248, 0.14)",
    };
  }
  return {
    text: "#94a3b8",
    border: "rgba(148, 163, 184, 0.34)",
    bg: "rgba(148, 163, 184, 0.12)",
  };
}

/**
 * Directly resolves the official SVG icon component for built-in providers
 * (Claude Code, Codex, Pi, OpenCode, Copilot, MiniMax, OMP) and falls back to
 * server-registered custom SVG icons when applicable.
 */
export function resolveBuiltinProviderIcon(
  provider: string | null | undefined,
  fallbackGetIcon?: (p: string) => ProviderIconComponent,
): ProviderIconComponent {
  const normalized = (provider ?? "claude").trim().toLowerCase();
  if (
    normalized === "claude" ||
    normalized === "claude-code" ||
    normalized === "claudecode" ||
    normalized.includes("claude") ||
    normalized.includes("anthropic")
  ) {
    return ClaudeIcon;
  }
  if (normalized === "codex" || normalized.includes("codex") || normalized.includes("openai")) {
    return CodexIcon;
  }
  if (normalized === "pi") {
    return PiIcon;
  }
  if (normalized === "opencode" || normalized.includes("opencode")) {
    return OpenCodeIcon;
  }
  if (normalized === "copilot" || normalized.includes("copilot")) {
    return CopilotIcon;
  }
  if (normalized === "minimax" || normalized.includes("minimax")) {
    return MiniMaxIcon;
  }
  if (normalized === "omp") {
    return OmpIcon;
  }
  if (fallbackGetIcon && provider) {
    return fallbackGetIcon(provider);
  }
  return ClaudeIcon;
}

/**
 * The canonical builtin id a provider id hints at, used when the daemon has not reported
 * `derivedFromProviderId` for the provider (old daemons). Returns null when nothing matches,
 * so callers hide the coding-agent chip instead of guessing.
 */
export function heuristicBaseProviderId(provider: string | null | undefined): string | null {
  const normalized = (provider ?? "").trim().toLowerCase();
  if (!normalized) return null;
  if (normalized.includes("claude") || normalized.includes("anthropic")) return "claude";
  if (normalized.includes("codex") || normalized.includes("openai")) return "codex";
  if (normalized.includes("opencode")) return "opencode";
  if (normalized.includes("copilot")) return "copilot";
  if (normalized.includes("minimax")) return "minimax";
  if (normalized.includes("antigravity")) return "antigravity";
  if (normalized === "omp") return "omp";
  // Token match, not substring: "copilot" contains "pi" and is handled above.
  if (normalized.split(/[^a-z0-9]+/).includes("pi")) return "pi";
  return null;
}

export interface CodingAgentInfo {
  id: string;
  label: string;
  /** Absent when the base id is not a known builtin, so the row skips the icon. */
  Icon?: ProviderIconComponent;
}

/**
 * The coding agent (Claude Code, Codex, OpenCode, Pi…) a provider seat runs on. The daemon's
 * `derivedFromProviderId` is authoritative — SLP seat ids like `slp-lead` do not encode their
 * base — with the id heuristic as fallback for old daemons. null when even the heuristic
 * finds nothing, so the row can hide the chip.
 */
export function resolveCodingAgentInfo(
  provider: string,
  entries: readonly { provider: string; derivedFromProviderId?: string | null }[] | undefined,
): CodingAgentInfo | null {
  const entry = entries?.find((candidate) => candidate.provider === provider);
  const base = entry?.derivedFromProviderId ?? heuristicBaseProviderId(provider);
  if (!base) return null;
  return {
    id: base,
    label: formatProviderDisplayName(base),
    Icon: heuristicBaseProviderId(base) ? resolveBuiltinProviderIcon(base) : undefined,
  };
}

export function formatProviderDisplayName(provider: string | null | undefined): string {
  if (!provider) return "Claude Code";
  const normalized = provider.trim().toLowerCase();
  switch (normalized) {
    case "claude":
    case "claude-code":
    case "claudecode":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "pi":
      return "Pi";
    case "opencode":
      return "OpenCode";
    case "copilot":
      return "Copilot";
    case "minimax":
      return "MiniMax";
    case "omp":
      return "OMP";
    case "kiro":
      return "Kiro";
    default:
      return provider.charAt(0).toUpperCase() + provider.slice(1);
  }
}

export function formatShortProviderName(provider: string | null | undefined): string {
  if (!provider) return "Claude";
  const normalized = provider.trim().toLowerCase();
  switch (normalized) {
    case "claude":
    case "claude-code":
    case "claudecode":
      return "Claude";
    case "codex":
      return "Codex";
    case "pi":
      return "Pi";
    case "opencode":
      return "OpenCode";
    case "copilot":
      return "Copilot";
    case "minimax":
      return "MiniMax";
    case "omp":
      return "OMP";
    default:
      return provider.charAt(0).toUpperCase() + provider.slice(1);
  }
}

export function formatShortModelName(model: string | null | undefined): string | null {
  if (!model || typeof model !== "string") return null;
  let cleaned = model.trim();
  if (!cleaned || cleaned.toLowerCase() === "default") return null;

  // Strip provider prefix if present (e.g. "anthropic/claude-sonnet-4-5-20250929")
  if (cleaned.includes("/")) {
    const parts = cleaned.split("/");
    cleaned = parts[parts.length - 1] ?? cleaned;
  }

  // Strip trailing date stamp like -20250929 or @20250929
  cleaned = cleaned.replace(/[-@]\d{8}$/, "");
  cleaned = cleaned.replace(/:latest$/, "");

  // Normalize common Claude model IDs:
  // claude-sonnet-4-5 -> sonnet-4.5
  // claude-opus-4-6 -> opus-4.6
  // claude-3-7-sonnet -> sonnet-3.7
  const claudeModernMatch = /^claude-(opus|sonnet|haiku)-(\d+)-(\d+)$/i.exec(cleaned);
  if (claudeModernMatch) {
    return `${claudeModernMatch[1].toLowerCase()}-${claudeModernMatch[2]}.${claudeModernMatch[3]}`;
  }
  const claudeSingleVersionMatch = /^claude-(opus|sonnet|haiku)-(\d+)$/i.exec(cleaned);
  if (claudeSingleVersionMatch) {
    return `${claudeSingleVersionMatch[1].toLowerCase()}-${claudeSingleVersionMatch[2]}`;
  }
  const claudeLegacyMatch = /^claude-(\d+)-(\d+)-(opus|sonnet|haiku)$/i.exec(cleaned);
  if (claudeLegacyMatch) {
    return `${claudeLegacyMatch[3].toLowerCase()}-${claudeLegacyMatch[1]}.${claudeLegacyMatch[2]}`;
  }
  if (cleaned.toLowerCase().startsWith("claude-")) {
    cleaned = cleaned.slice("claude-".length);
  }

  return cleaned.length > 22 ? `${cleaned.slice(0, 20)}…` : cleaned;
}

export interface WorkspaceRootAgentSummary {
  id: string;
  provider: string;
  providerLabel: string;
  modelShort: string | null;
  modelFull: string | null;
  modeId: string | null;
  title: string | null;
  statusBucket: SidebarStateBucket | null;
  isDraftOrDefault?: boolean;
}

export interface WorkspaceAgentSidebarSummary {
  primaryAgent: WorkspaceRootAgentSummary | null;
  rootAgents: WorkspaceRootAgentSummary[];
  additionalProviders: string[];
  subagents: SubagentRow[];
  runningSubagentCount: number;
  needsInputSubagentCount: number;
  failedSubagentCount: number;
  doneSubagentCount: number;
}

function resolveAgentEffectiveStatus(agent: Agent): Agent["status"] {
  if (agent.turn.phase === "open") {
    return "running";
  }
  return agent.status === "running" ? "idle" : agent.status;
}

function getAgentPriorityScore(agent: Agent): number {
  const effectiveStatus = resolveAgentEffectiveStatus(agent);
  if (effectiveStatus === "running") return 4;
  if (agent.requiresAttention && agent.attentionReason === "permission") return 3;
  if (effectiveStatus === "error" || agent.attentionReason === "error") return 2;
  if (agent.requiresAttention) return 1;
  return 0;
}

export function useWorkspaceAgentSidebarSummary(
  serverId: string,
  workspaceId: string,
  workspaceDirectory?: string | null,
  workspaceKey?: string,
): WorkspaceAgentSidebarSummary {
  const normalizedWorkspaceId = normalizeWorkspaceOpaqueId(workspaceId);
  const normalizedWorkspaceDir = workspaceDirectory
    ? normalizeWorkspacePath(workspaceDirectory)
    : null;
  const resolvedWorkspaceKey = workspaceKey ?? `${serverId}:${workspaceId}`;
  const pendingArchiveIds = usePendingArchiveAgentIds(serverId);
  const { preferences } = useFormPreferences();

  // Inspect open tabs in this workspace's layout for agent tabs or draft setup tabs
  const layoutAgentAndDraftInfo = useStoreWithEqualityFn(
    useWorkspaceLayoutStore,
    useCallback(
      (state) => {
        const layout = state.layoutByWorkspace?.[resolvedWorkspaceKey];
        if (!layout) {
          return {
            agentIds: [] as string[],
            draftProvider: null as string | null,
            draftModel: null as string | null,
            draftModeId: null as string | null,
          };
        }
        const tabs = collectAllTabs(layout.root);
        const agentIds: string[] = [];
        let draftProvider: string | null = null;
        let draftModel: string | null = null;
        let draftModeId: string | null = null;
        for (const tab of tabs) {
          if (tab.target.kind === "agent" && tab.target.agentId) {
            agentIds.push(tab.target.agentId);
          } else if (tab.target.kind === "draft" && tab.target.setup?.provider && !draftProvider) {
            draftProvider = tab.target.setup.provider;
            draftModel = tab.target.setup.model ?? null;
            draftModeId = tab.target.setup.modeId ?? null;
          }
        }
        return { agentIds, draftProvider, draftModel, draftModeId };
      },
      [resolvedWorkspaceKey],
    ),
    equal,
  );

  const rawWorkspaceAgents = useStoreWithEqualityFn(
    useSessionStore,
    useCallback(
      (state) => {
        const session = state.sessions[serverId];
        if (!session) return [];
        const matching: Agent[] = [];
        const seenIds = new Set<string>();
        const layoutAgentIdSet = new Set(layoutAgentAndDraftInfo.agentIds);

        const considerAgent = (agent: Agent) => {
          if (seenIds.has(agent.id)) return;
          seenIds.add(agent.id);
          if (agent.archivedAt || pendingArchiveIds.has(agent.id)) return;
          const agentWorkspaceId = normalizeWorkspaceOpaqueId(agent.workspaceId);
          if (agentWorkspaceId) {
            if (Boolean(normalizedWorkspaceId) && agentWorkspaceId === normalizedWorkspaceId) {
              matching.push(agent);
            }
            return;
          }
          const matchesLegacyDirectory =
            Boolean(normalizedWorkspaceDir) &&
            Boolean(agent.cwd) &&
            normalizeWorkspacePath(agent.cwd) === normalizedWorkspaceDir;
          const matchesLayoutTab = layoutAgentIdSet.has(agent.id);

          if (matchesLegacyDirectory || matchesLayoutTab) {
            matching.push(agent);
          }
        };

        for (const agent of session.agents.values()) {
          considerAgent(agent);
        }
        if (session.agentDetails) {
          for (const agent of session.agentDetails.values()) {
            considerAgent(agent);
          }
        }
        return matching;
      },
      [
        layoutAgentAndDraftInfo.agentIds,
        normalizedWorkspaceDir,
        normalizedWorkspaceId,
        pendingArchiveIds,
        serverId,
      ],
    ),
    equal,
  );

  const rootAgentIds = useMemo(() => {
    if (rawWorkspaceAgents.length === 0) return [];
    const byId = new Map(rawWorkspaceAgents.map((a) => [a.id, a]));
    return rawWorkspaceAgents
      .filter((agent) =>
        isWorkspaceRootAgent(
          agent,
          agent.parentAgentId ? byId.get(agent.parentAgentId) : undefined,
        ),
      )
      .map((a) => a.id);
  }, [rawWorkspaceAgents]);

  const supported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.providerSubagents === true,
  );
  const nestingSupported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.providerSubagentNesting === true,
  );
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);

  useEffect(() => {
    if (!client || !supported || rootAgentIds.length === 0) return;
    for (const parentAgentId of rootAgentIds) {
      void refreshProviderSubagents(client, serverId, parentAgentId).catch(() => undefined);
    }
  }, [client, rootAgentIds, serverId, supported]);

  const paseoSubagents = useStoreWithEqualityFn(
    useSessionStore,
    useCallback(
      (state) => {
        if (rootAgentIds.length === 0 && rawWorkspaceAgents.length === 0) return [];
        const session = state.sessions[serverId];
        if (!session) return [];
        const collected: SubagentRow[] = [];
        const seenIds = new Set<string>();
        // Index every agent by its parent label once, then walk descendants breadth-first.
        // One level was not enough: an SLP lead's builders and checkers are grandchildren of
        // the workspace root, and without them the tree could never nest the real chain.
        const byParent = new Map<string, Agent[]>();
        const index = (agent: Agent) => {
          const parent = getParentAddressFromLabels(agent.labels, serverId);
          if (!parent || parent.serverId !== serverId) return;
          const list = byParent.get(parent.agentId);
          if (list) list.push(agent);
          else byParent.set(parent.agentId, [agent]);
        };
        for (const agent of session.agents.values()) index(agent);
        if (session.agentDetails) {
          for (const agent of session.agentDetails.values()) index(agent);
        }
        const visit = (parentId: string) => {
          for (const agent of byParent.get(parentId) ?? []) {
            if (seenIds.has(agent.id) || pendingArchiveIds.has(agent.id)) continue;
            seenIds.add(agent.id);
            collected.push(toSubagentRow(agent));
            visit(agent.id);
          }
        };
        for (const rootId of rootAgentIds) visit(rootId);
        // Also include any non-root agent in this workspace whose parent might live elsewhere
        const rootIdSet = new Set(rootAgentIds);
        for (const agent of rawWorkspaceAgents) {
          if (agent.parentAgentId && pendingArchiveIds.has(agent.parentAgentId)) {
            continue;
          }
          if (!rootIdSet.has(agent.id) && !seenIds.has(agent.id)) {
            seenIds.add(agent.id);
            collected.push(toSubagentRow(agent));
          }
        }
        return collected;
      },
      [pendingArchiveIds, rawWorkspaceAgents, rootAgentIds, serverId],
    ),
    equal,
  );

  const providerSubagents = useStoreWithEqualityFn(
    useProviderSubagentStore,
    useCallback(
      (state) => {
        if (!supported || rootAgentIds.length === 0) return [];
        const collected: SubagentRow[] = [];
        for (const parentAgentId of rootAgentIds) {
          const rows = selectProviderSubagentsForParent(
            state,
            { serverId, parentAgentId },
            supported,
            nestingSupported,
            true,
          );
          collected.push(...rows);
        }
        return collected;
      },
      [nestingSupported, rootAgentIds, serverId, supported],
    ),
    equal,
  );

  return useMemo(() => {
    const byId = new Map(rawWorkspaceAgents.map((a) => [a.id, a]));
    const rootCandidates = rawWorkspaceAgents.filter((agent) =>
      isWorkspaceRootAgent(agent, agent.parentAgentId ? byId.get(agent.parentAgentId) : undefined),
    );
    const sortedRootAgents = (rootCandidates.length > 0 ? rootCandidates : rawWorkspaceAgents)
      .slice()
      .sort((a, b) => {
        const scoreDiff = getAgentPriorityScore(b) - getAgentPriorityScore(a);
        if (scoreDiff !== 0) return scoreDiff;
        const aTime = (a.attentionTimestamp ?? a.lastActivityAt ?? a.updatedAt).getTime();
        const bTime = (b.attentionTimestamp ?? b.lastActivityAt ?? b.updatedAt).getTime();
        return bTime - aTime;
      });

    const rootAgents: WorkspaceRootAgentSummary[] = sortedRootAgents.map((agent) => {
      const modelFull = agent.model ?? agent.runtimeInfo?.model ?? null;
      return {
        id: agent.id,
        provider: agent.provider,
        providerLabel: formatProviderDisplayName(agent.provider),
        modelShort: formatShortModelName(modelFull),
        modelFull,
        modeId: agent.currentModeId ?? agent.runtimeInfo?.modeId ?? null,
        title: agent.title,
        statusBucket: deriveSidebarStateBucket({
          status: resolveAgentEffectiveStatus(agent),
          requiresAttention: agent.requiresAttention,
          attentionReason: agent.attentionReason,
        }),
      };
    });

    // If the workspace does not have a live root agent yet but has an explicit draft tab setup,
    // synthesize the configured provider from that workspace's own draft tab (never from global
    // preferences.provider, which would cause all empty/unhydrated workspaces to switch icons whenever
    // the user changes provider in any new session form).
    if (rootAgents.length === 0 && layoutAgentAndDraftInfo.draftProvider) {
      const fallbackProvider = layoutAgentAndDraftInfo.draftProvider;
      const providerPref = preferences?.providerPreferences?.[fallbackProvider];
      const fallbackModelFull = layoutAgentAndDraftInfo.draftModel ?? providerPref?.model ?? null;
      const fallbackModeId = layoutAgentAndDraftInfo.draftModeId ?? providerPref?.mode ?? null;

      rootAgents.push({
        id: `default-${resolvedWorkspaceKey}`,
        provider: fallbackProvider,
        providerLabel: formatProviderDisplayName(fallbackProvider),
        modelShort: formatShortModelName(fallbackModelFull),
        modelFull: fallbackModelFull,
        modeId: fallbackModeId,
        title: null,
        statusBucket: null,
        isDraftOrDefault: true,
      });
    }

    const primaryAgent = rootAgents[0] ?? null;
    const additionalProviders: string[] = [];
    if (primaryAgent) {
      const seenProviders = new Set<string>([primaryAgent.provider]);
      for (const agent of rootAgents.slice(1)) {
        if (!seenProviders.has(agent.provider)) {
          seenProviders.add(agent.provider);
          additionalProviders.push(agent.provider);
        }
      }
    }

    const allSubagents = [...paseoSubagents, ...providerSubagents].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    );

    let runningSubagentCount = 0;
    let needsInputSubagentCount = 0;
    let failedSubagentCount = 0;
    let doneSubagentCount = 0;

    for (const sub of allSubagents) {
      const pres = buildSubagentRowPresentationData(sub);
      if (pres.statusBucket === "running") {
        runningSubagentCount += 1;
      } else if (pres.statusBucket === "needs_input") {
        needsInputSubagentCount += 1;
      } else if (pres.statusBucket === "failed") {
        failedSubagentCount += 1;
      } else {
        doneSubagentCount += 1;
      }
    }

    return {
      primaryAgent,
      rootAgents,
      additionalProviders,
      subagents: allSubagents,
      runningSubagentCount,
      needsInputSubagentCount,
      failedSubagentCount,
      doneSubagentCount,
    };
  }, [
    layoutAgentAndDraftInfo.draftModeId,
    layoutAgentAndDraftInfo.draftModel,
    layoutAgentAndDraftInfo.draftProvider,
    paseoSubagents,
    preferences,
    providerSubagents,
    rawWorkspaceAgents,
    resolvedWorkspaceKey,
  ]);
}

interface SidebarSubagentTreeStoreState {
  collapsedByWorkspaceKey: Record<string, boolean | undefined>;
  toggleWorkspaceSubagents: (workspaceKey: string, currentCollapsed: boolean) => void;
  setWorkspaceSubagentsCollapsed: (workspaceKey: string, collapsed: boolean) => void;
  /** Per-workspace "show only the subagents that are still working" switch. */
  workingOnlyByWorkspaceKey: Record<string, boolean | undefined>;
  toggleWorkingOnlySubagents: (workspaceKey: string) => void;
}

export const useSidebarSubagentTreeStore = create<SidebarSubagentTreeStoreState>((set) => ({
  collapsedByWorkspaceKey: {},
  toggleWorkspaceSubagents: (workspaceKey, currentCollapsed) =>
    set((state) => ({
      collapsedByWorkspaceKey: {
        ...state.collapsedByWorkspaceKey,
        [workspaceKey]: !currentCollapsed,
      },
    })),
  setWorkspaceSubagentsCollapsed: (workspaceKey, collapsed) =>
    set((state) => ({
      collapsedByWorkspaceKey: {
        ...state.collapsedByWorkspaceKey,
        [workspaceKey]: collapsed,
      },
    })),
  workingOnlyByWorkspaceKey: {},
  toggleWorkingOnlySubagents: (workspaceKey) =>
    set((state) => ({
      workingOnlyByWorkspaceKey: {
        ...state.workingOnlyByWorkspaceKey,
        [workspaceKey]: !state.workingOnlyByWorkspaceKey[workspaceKey],
      },
    })),
}));

/**
 * Crisp Provider SVG Icon badge (optional standalone export).
 */
export const WorkspaceTitleProviderBadge = memo(function WorkspaceTitleProviderBadge({
  serverId,
  workspaceId,
  workspaceDirectory,
  workspaceKey,
}: {
  serverId: string;
  workspaceId: string;
  workspaceDirectory?: string | null;
  workspaceKey: string;
}) {
  const summary = useWorkspaceAgentSidebarSummary(
    serverId,
    workspaceId,
    workspaceDirectory,
    workspaceKey,
  );
  const getProviderIcon = useProviderIcons(serverId);
  const primary = summary.primaryAgent;
  if (!primary) return null;

  const tone = getProviderAccentTone(primary.provider);
  const PrimaryIcon = resolveBuiltinProviderIcon(primary.provider, getProviderIcon);

  return (
    <View
      style={styles.titleProviderBadgeGroup}
      testID={`workspace-title-provider-icon-${workspaceKey}`}
    >
      <View
        style={[
          styles.titleProviderIconChip,
          {
            backgroundColor: tone.bg,
            borderColor: tone.border,
          },
        ]}
      >
        <PrimaryIcon size={11.5} color={tone.text} />
      </View>
    </View>
  );
});

/**
 * Renders the compact single-line Agent Provider Icon + Short Provider Name + Model badge
 * and the interactive Subagent count/status pill right inside the workspace row content.
 */
export const WorkspaceAgentMetaRow = memo(function WorkspaceAgentMetaRow({
  serverId,
  workspaceId,
  workspaceDirectory,
  workspaceKey,
}: {
  serverId: string;
  workspaceId: string;
  workspaceDirectory?: string | null;
  workspaceKey: string;
}) {
  const summary = useWorkspaceAgentSidebarSummary(
    serverId,
    workspaceId,
    workspaceDirectory,
    workspaceKey,
  );
  const getProviderIcon = useProviderIcons(serverId);
  const explicitCollapsed = useSidebarSubagentTreeStore(
    (state) => state.collapsedByWorkspaceKey[workspaceKey],
  );
  const toggleWorkspaceSubagents = useSidebarSubagentTreeStore(
    (state) => state.toggleWorkspaceSubagents,
  );

  const hasActiveSubagent = summary.runningSubagentCount > 0 || summary.needsInputSubagentCount > 0;
  const isCollapsed = explicitCollapsed ?? !hasActiveSubagent;

  const handleToggleSubagentsPressIn = useCallback((event: GestureResponderEvent) => {
    event.stopPropagation();
  }, []);

  const handleToggleSubagentsPressOut = useCallback((event: GestureResponderEvent) => {
    event.stopPropagation();
  }, []);

  const handleToggleSubagentsPress = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      toggleWorkspaceSubagents(workspaceKey, isCollapsed);

      // When expanding the subagent tree pill, also reveal the first subagent's detail tab
      if (isCollapsed && summary.subagents.length > 0) {
        const firstSub = summary.subagents[0];
        if (firstSub) {
          const target =
            firstSub.kind === "paseo"
              ? ({ kind: "agent", agentId: firstSub.id } as const)
              : ({
                  kind: "provider_subagent",
                  parentAgentId: firstSub.parentAgentId,
                  subagentId: firstSub.id,
                } as const);
          useWorkspaceLayoutStore.getState().openTab({
            workspaceKey,
            target,
            intent: "reveal",
            pin: true,
          });
          navigateToWorkspace({
            serverId,
            workspaceId,
            target,
            pin: true,
          });
        }
      }
    },
    [isCollapsed, serverId, summary.subagents, toggleWorkspaceSubagents, workspaceId, workspaceKey],
  );

  const subagentSummaryText = useMemo(() => {
    const total = summary.subagents.length;
    if (total === 0) return "";
    const base = total === 1 ? "1 subagent" : `${total} subagents`;
    if (summary.runningSubagentCount > 0) {
      return `${total} · ${summary.runningSubagentCount} running`;
    }
    if (summary.needsInputSubagentCount > 0) {
      return `${total} · ${summary.needsInputSubagentCount} waiting`;
    }
    if (summary.failedSubagentCount > 0) {
      return `${total} · ${summary.failedSubagentCount} failed`;
    }
    return base;
  }, [
    summary.failedSubagentCount,
    summary.needsInputSubagentCount,
    summary.runningSubagentCount,
    summary.subagents.length,
  ]);

  const primary = summary.primaryAgent;
  const tone = primary ? getProviderAccentTone(primary.provider) : getProviderAccentTone("default");
  const PrimaryProviderIcon = primary
    ? resolveBuiltinProviderIcon(primary.provider, getProviderIcon)
    : null;
  const shortProviderLabel = primary ? formatShortProviderName(primary.provider) : "";

  const hasSubagents = summary.subagents.length > 0;
  const subagentRunning = summary.runningSubagentCount > 0;
  const subagentNeedsInput = summary.needsInputSubagentCount > 0;
  const subagentFailed = summary.failedSubagentCount > 0;

  let subagentPillTone = {
    text: "#94a3b8",
    border: "rgba(148, 163, 184, 0.24)",
    bg: "rgba(148, 163, 184, 0.07)",
  };
  if (subagentRunning) {
    subagentPillTone = {
      text: "#10b981",
      border: "rgba(16, 185, 129, 0.35)",
      bg: "rgba(16, 185, 129, 0.1)",
    };
  } else if (subagentNeedsInput) {
    subagentPillTone = {
      text: "#f59e0b",
      border: "rgba(245, 158, 11, 0.35)",
      bg: "rgba(245, 158, 11, 0.1)",
    };
  } else if (subagentFailed) {
    subagentPillTone = {
      text: "#f43f5e",
      border: "rgba(244, 63, 94, 0.35)",
      bg: "rgba(244, 63, 94, 0.1)",
    };
  }

  const handleSubagentPillStyle = useCallback(
    ({ hovered }: { hovered?: boolean }) => [
      styles.subagentTogglePill,
      {
        backgroundColor: subagentPillTone.bg,
        borderColor: subagentPillTone.border,
      },
      hovered && styles.subagentTogglePillHovered,
    ],
    [subagentPillTone.bg, subagentPillTone.border],
  );

  if (!summary.primaryAgent && summary.subagents.length === 0) {
    return null;
  }

  return (
    <View style={styles.agentMetaRow} testID={`workspace-agent-meta-row-${workspaceKey}`}>
      {primary && PrimaryProviderIcon ? (
        <View
          style={[
            styles.providerBadge,
            {
              backgroundColor: tone.bg,
              borderColor: tone.border,
            },
          ]}
          testID={`workspace-provider-badge-${workspaceKey}`}
        >
          <View style={styles.providerIconBox}>
            <PrimaryProviderIcon size={11} color={tone.text} />
          </View>
          <Text style={[styles.providerNameText, { color: tone.text }]} numberOfLines={1}>
            {shortProviderLabel}
          </Text>
          {primary.modelShort ? (
            <>
              <Text style={styles.providerModelDot}>·</Text>
              <Text style={styles.providerModelText} numberOfLines={1}>
                {primary.modelShort}
              </Text>
            </>
          ) : null}
          {summary.additionalProviders.map((extraProvider) => {
            const extraTone = getProviderAccentTone(extraProvider);
            const ExtraIcon = resolveBuiltinProviderIcon(extraProvider, getProviderIcon);
            return (
              <View key={extraProvider} style={styles.extraProviderIconInline}>
                <ExtraIcon size={10} color={extraTone.text} />
              </View>
            );
          })}
          {summary.rootAgents.length > 1 ? (
            <Text style={styles.multiAgentCountBadge}>+{summary.rootAgents.length - 1}</Text>
          ) : null}
        </View>
      ) : null}

      {hasSubagents ? (
        <PressHighlight
          accessibilityRole="button"
          accessibilityLabel={subagentSummaryText}
          onPressIn={handleToggleSubagentsPressIn}
          onPressOut={handleToggleSubagentsPressOut}
          onPress={handleToggleSubagentsPress}
          {...({
            onPointerDown: (e: { stopPropagation?: () => void }) => e.stopPropagation?.(),
            onMouseDown: (e: { stopPropagation?: () => void }) => e.stopPropagation?.(),
          } as object)}
          hitSlop={4}
          style={handleSubagentPillStyle}
          testID={`workspace-subagent-pill-${workspaceKey}`}
        >
          {subagentRunning ? (
            <View style={styles.miniSpinnerWrap}>
              <StatusRing />
            </View>
          ) : (
            <GitFork size={9.5} color={subagentPillTone.text} />
          )}
          <Text
            style={[styles.subagentTogglePillText, { color: subagentPillTone.text }]}
            numberOfLines={1}
          >
            {subagentSummaryText}
          </Text>
          {isCollapsed ? (
            <ChevronRight size={10} color={subagentPillTone.text} />
          ) : (
            <ChevronDown size={10} color={subagentPillTone.text} />
          )}
        </PressHighlight>
      ) : null}
    </View>
  );
});

const ARCHIVED_SUBAGENTS_LIMIT = 5;

export interface PartitionSubagentRowsOptions {
  showAllArchived: boolean;
  activeTargetKey: string | null;
  /** "Working only" hides everything that is done: no finished rows and no older toggle. */
  hideFinished?: boolean;
}

export interface PartitionedSubagentForest {
  /** Subtrees with someone still working; archived children stay nested under their parent. */
  workingRoots: SubagentTreeNode[];
  /** Fully finished subtrees, newest roots kept with a toggle for the older ones. */
  archivedRoots: SubagentTreeNode[];
  hiddenArchivedCount: number;
  totalArchivedCount: number;
}

export type SubagentRole = "supervisor" | "lead" | "builder" | "checker";

export const SUBAGENT_ROLE_LABEL: Record<SubagentRole, string> = {
  supervisor: "Supervisor",
  lead: "Lead",
  builder: "Builder",
  checker: "Checker",
};

export interface SlpRolePresentation {
  label: string;
  Icon: typeof Crown;
  tone: ProviderAccentTone;
}

/**
 * One icon plus one color block per SLP seat, deliberately provider-independent: a Builder
 * reads the same whether it runs on OpenCode or Claude, so the eye learns seat before vendor.
 */
export function getSlpRolePresentation(role: SubagentRole): SlpRolePresentation {
  switch (role) {
    case "supervisor":
      return {
        label: SUBAGENT_ROLE_LABEL.supervisor,
        Icon: Crown,
        tone: {
          text: "#a78bfa",
          border: "rgba(167, 139, 250, 0.45)",
          bg: "rgba(167, 139, 250, 0.14)",
        },
      };
    case "lead":
      return {
        label: SUBAGENT_ROLE_LABEL.lead,
        Icon: Compass,
        tone: {
          text: "#60a5fa",
          border: "rgba(96, 165, 250, 0.45)",
          bg: "rgba(96, 165, 250, 0.14)",
        },
      };
    case "builder":
      return {
        label: SUBAGENT_ROLE_LABEL.builder,
        Icon: Hammer,
        tone: {
          text: "#34d399",
          border: "rgba(52, 211, 153, 0.45)",
          bg: "rgba(52, 211, 153, 0.14)",
        },
      };
    case "checker":
      return {
        label: SUBAGENT_ROLE_LABEL.checker,
        Icon: ClipboardCheck,
        tone: {
          text: "#fbbf24",
          border: "rgba(251, 191, 36, 0.45)",
          bg: "rgba(251, 191, 36, 0.14)",
        },
      };
  }
}

const SUBAGENT_ROLE_RANK: Record<SubagentRole, number> = {
  supervisor: 0,
  lead: 1,
  builder: 2,
  checker: 3,
};

/**
 * Which SLP seat a row holds, read from its provider id (`slp-lead`, `slp-opencode-builder`,
 * `slp-claude-checker`, `slp-final-reviewer` …). Checkers, reviewers and advisors all verify
 * someone else's work, so they share the Checker seat. Non-SLP rows have no seat.
 */
export function deriveSubagentRole(row: SubagentRow): SubagentRole | null {
  if (row.kind !== "paseo") return null;
  const provider = row.provider.toLowerCase();
  if (provider.includes("supervisor")) return "supervisor";
  if (provider.includes("lead")) return "lead";
  if (provider.includes("builder")) return "builder";
  if (provider.includes("checker") || provider.includes("reviewer") || provider.includes("advisor"))
    return "checker";
  return null;
}

export function subagentRoleRank(row: SubagentRow): number {
  const role = deriveSubagentRole(row);
  return role === null ? 4 : SUBAGENT_ROLE_RANK[role];
}

/** Seats read top-down; oldest first inside a seat. */
export function compareSubagentRows(a: SubagentRow, b: SubagentRow): number {
  return subagentRoleRank(a) - subagentRoleRank(b) || a.createdAt.getTime() - b.createdAt.getTime();
}

export interface SubagentTreeNode {
  row: SubagentRow;
  children: SubagentTreeNode[];
}

function rowKey(row: SubagentRow): string {
  return `${row.kind}:${row.id}`;
}

function rowParentKey(row: SubagentRow): string | null {
  // Both row kinds name a managed (paseo) agent as their parent.
  if (!row.parentAgentId) return null;
  return `paseo:${row.parentAgentId}`;
}

/**
 * Nests flat rows into a forest by parent linkage, so the tree reads Supervisor → Lead →
 * Builder/Checker instead of one chronological list. Rows whose parent is not in the set
 * (workspace roots, filtered-out agents, other hosts) stay top-level. Siblings keep seat
 * order, oldest first. Cycles fall back to top level rather than recursing forever.
 */
export function buildSubagentForest(rows: readonly SubagentRow[]): SubagentTreeNode[] {
  const byKey = new Map<string, SubagentRow>();
  for (const row of rows) byKey.set(rowKey(row), row);
  const childrenOf = new Map<string, SubagentRow[]>();
  const roots: SubagentRow[] = [];
  for (const row of rows) {
    const parentKey = rowParentKey(row);
    if (parentKey && byKey.has(parentKey) && parentKey !== rowKey(row)) {
      const siblings = childrenOf.get(parentKey);
      if (siblings) siblings.push(row);
      else childrenOf.set(parentKey, [row]);
    } else {
      roots.push(row);
    }
  }
  const build = (row: SubagentRow, ancestry: ReadonlySet<string>): SubagentTreeNode => {
    const key = rowKey(row);
    const next = new Set(ancestry);
    next.add(key);
    const children = (childrenOf.get(key) ?? [])
      .filter((child) => !next.has(rowKey(child)))
      .sort(compareSubagentRows)
      .map((child) => build(child, next));
    return { row, children };
  };
  const forest = roots.sort(compareSubagentRows).map((row) => build(row, new Set()));
  // Pure parent cycles have no root and would vanish; surface them top-level instead.
  const seen = new Set<string>();
  const mark = (nodes: SubagentTreeNode[]): void => {
    for (const node of nodes) {
      seen.add(rowKey(node.row));
      mark(node.children);
    }
  };
  mark(forest);
  for (const row of [...rows].sort(compareSubagentRows)) {
    if (seen.has(rowKey(row))) continue;
    const extra = build(row, new Set());
    forest.push(extra);
    mark([extra]);
  }
  forest.sort((a, b) => compareSubagentRows(a.row, b.row));
  return forest;
}

function subagentRowTargetKey(row: SubagentRow): string {
  return row.kind === "paseo" ? `paseo:${row.id}` : `provider:${row.parentAgentId}:${row.id}`;
}

function subtreeHasActive(node: SubagentTreeNode): boolean {
  return isRowActive(node.row) || node.children.some(subtreeHasActive);
}

function subtreeHasTarget(node: SubagentTreeNode, targetKey: string): boolean {
  return (
    subagentRowTargetKey(node.row) === targetKey ||
    node.children.some((child) => subtreeHasTarget(child, targetKey))
  );
}

/**
 * Splits the forest into the working group on top and the fully finished group below, capping
 * the finished group at the newest subtrees with a toggle for the older ones. The split happens
 * per subtree, not per row: a lead that is still open keeps its archived builders nested under
 * it, instead of them falling to the bottom as flat orphaned rows. Pure so it is testable; the
 * tree reads it through a memo.
 */
export function partitionSubagentForest(
  rows: readonly SubagentRow[],
  options: PartitionSubagentRowsOptions,
): PartitionedSubagentForest {
  const { showAllArchived, activeTargetKey, hideFinished = false } = options;

  // "Working only" hides everything that is done, so a busy workspace shows only the agents
  // that still need attention. Row filtering keeps orphans top-level; no older toggle.
  if (hideFinished) {
    const activeRows = rows.filter(isRowActive);
    return {
      workingRoots: buildSubagentForest(activeRows),
      archivedRoots: [],
      hiddenArchivedCount: 0,
      totalArchivedCount: rows.length - activeRows.length,
    };
  }

  const forest = buildSubagentForest(rows);
  const workingRoots: SubagentTreeNode[] = [];
  const archivedRoots: SubagentTreeNode[] = [];
  for (const node of forest) {
    (subtreeHasActive(node) ? workingRoots : archivedRoots).push(node);
  }

  if (archivedRoots.length <= ARCHIVED_SUBAGENTS_LIMIT || showAllArchived) {
    return {
      workingRoots,
      archivedRoots,
      hiddenArchivedCount: 0,
      totalArchivedCount: archivedRoots.length,
    };
  }

  // Keep the newest finished subtrees; older ones hide behind the toggle.
  const ranked = archivedRoots
    .map((node, index) => ({ node, index, createdAt: node.row.createdAt.getTime() }))
    .sort((a, b) => b.createdAt - a.createdAt || a.index - b.index);
  const kept = ranked.slice(0, ARCHIVED_SUBAGENTS_LIMIT);
  const hiddenCount = archivedRoots.length - kept.length;

  // The selected subtree stays visible even when it ranks among the older ones.
  if (activeTargetKey) {
    const selected = ranked
      .slice(ARCHIVED_SUBAGENTS_LIMIT)
      .find(({ node }) => subtreeHasTarget(node, activeTargetKey));
    if (selected && !kept.some((entry) => entry.node === selected.node)) {
      kept.push(selected);
    }
  }

  const visibleArchived = kept
    .map((entry) => entry.node)
    .sort((a, b) => compareSubagentRows(a.row, b.row));

  return {
    workingRoots,
    archivedRoots: visibleArchived,
    hiddenArchivedCount: hiddenCount,
    totalArchivedCount: archivedRoots.length,
  };
}

/**
 * Whether the row is still working. The badge and the row's icon read the agent's effective
 * status, so the tree must read the same one: an agent the daemon closed, or one it left in
 * "running" without an open turn, is done. Keeping those in the working group is how a busy
 * workspace ends up with a column of long-finished agents on top of the one that is working.
 */
export function isRowActive(row: SubagentRow): boolean {
  if (row.requiresAttention) {
    return true;
  }
  if (row.kind === "paseo") {
    if (row.turn.phase === "open") {
      return true;
    }
    if (row.status === "running" || row.status === "closed") {
      return false;
    }
  }
  return !isFinishedSubagent(row);
}

/**
 * Renders the collapsible, indented Subagent Tree directly underneath a workspace row
 * in the Left Sidebar ("By Status", "Pinned", and "By Project" views).
 */
export const SidebarWorkspaceSubagentTree = memo(function SidebarWorkspaceSubagentTree({
  workspace,
  inStatusGroup = false,
}: {
  workspace: SidebarWorkspaceEntry;
  inStatusGroup?: boolean;
}) {
  const resolvedWorkspaceKey =
    workspace.workspaceKey || `${workspace.serverId}:${workspace.workspaceId}`;
  const summary = useWorkspaceAgentSidebarSummary(
    workspace.serverId,
    workspace.workspaceId,
    workspace.workspaceDirectory,
    resolvedWorkspaceKey,
  );
  const { entries: providerEntries } = useProvidersSnapshot(workspace.serverId);
  const resolveCodingAgent = useCallback(
    (provider: string) => resolveCodingAgentInfo(provider, providerEntries),
    [providerEntries],
  );
  const explicitCollapsed = useSidebarSubagentTreeStore(
    (state) => state.collapsedByWorkspaceKey[resolvedWorkspaceKey],
  );
  const hasActiveSubagent = summary.runningSubagentCount > 0 || summary.needsInputSubagentCount > 0;
  const isCollapsed = explicitCollapsed ?? !hasActiveSubagent;
  const getProviderIcon = useProviderIcons(workspace.serverId);
  const [showAllArchived, setShowAllArchived] = useState(false);
  const [isToggleHovered, setIsToggleHovered] = useState(false);

  const handleShowAllArchived = useCallback(() => {
    setShowAllArchived(true);
  }, []);

  const handleHideOlderArchived = useCallback(() => {
    setShowAllArchived(false);
  }, []);

  const handleToggleMouseEnter = useCallback(() => {
    setIsToggleHovered(true);
  }, []);

  const handleToggleMouseLeave = useCallback(() => {
    setIsToggleHovered(false);
  }, []);

  // Determine which subagent tab is currently focused in this workspace (if any)
  const activeTargetKey = useWorkspaceLayoutStore(
    useCallback(
      (state) => {
        const layout = state.layoutByWorkspace?.[resolvedWorkspaceKey];
        if (!layout) return null;
        const focusedPane = findPaneById(layout.root, layout.focusedPaneId);
        if (!focusedPane || !focusedPane.focusedTabId) return null;
        const activeTab = collectAllTabs(layout.root).find(
          (t) => t.tabId === focusedPane.focusedTabId,
        );
        if (!activeTab) return null;
        if (activeTab.target.kind === "agent") {
          return `paseo:${activeTab.target.agentId}`;
        }
        if (activeTab.target.kind === "provider_subagent") {
          return `provider:${activeTab.target.parentAgentId}:${activeTab.target.subagentId}`;
        }
        return null;
      },
      [resolvedWorkspaceKey],
    ),
  );

  const workingOnly =
    useSidebarSubagentTreeStore((state) => state.workingOnlyByWorkspaceKey[resolvedWorkspaceKey]) ??
    false;
  const toggleWorkingOnlySubagents = useSidebarSubagentTreeStore(
    (state) => state.toggleWorkingOnlySubagents,
  );
  const handleToggleWorkingOnly = useCallback(() => {
    toggleWorkingOnlySubagents(resolvedWorkspaceKey);
  }, [toggleWorkingOnlySubagents, resolvedWorkspaceKey]);
  const {
    workingRoots,
    archivedRoots: shownArchivedRoots,
    hiddenArchivedCount: shownHiddenArchivedCount,
    totalArchivedCount,
  } = useMemo(
    () =>
      partitionSubagentForest(summary.subagents, {
        showAllArchived,
        activeTargetKey,
        hideFinished: workingOnly,
      }),
    [activeTargetKey, showAllArchived, summary.subagents, workingOnly],
  );

  if (workspace.archivingAt !== null || summary.subagents.length === 0 || isCollapsed) {
    return null;
  }

  const parentProvider = summary.primaryAgent?.provider ?? null;

  return (
    <View
      style={[styles.treeContainer, inStatusGroup && styles.treeContainerStatusGroup]}
      testID={`sidebar-subagent-tree-${resolvedWorkspaceKey}`}
      {...({
        onPointerDown: (e: { stopPropagation?: () => void }) => e.stopPropagation?.(),
        onMouseDown: (e: { stopPropagation?: () => void }) => e.stopPropagation?.(),
      } as object)}
    >
      {/* SLP hierarchy: opens the full-screen per-level view (Supervisor → Lead → Peer with
          model, coding agent and branch per seat). */}
      <HierarchyButton workspace={workspace} />
      {/* Working-only switch: hides everything that is done, so a busy workspace shows only
          the agents that still need attention. Offered once there is anything done to hide. */}
      {totalArchivedCount > 0 ? (
        <WorkingOnlyToggle workingOnly={workingOnly} onToggle={handleToggleWorkingOnly} />
      ) : null}
      {/* 1. Working / Active subagents on top, nested Supervisor → Lead → Builders */}
      <SubagentTreeForest
        nodes={workingRoots}
        workspace={workspace}
        parentProvider={parentProvider}
        activeTargetKey={activeTargetKey}
        getProviderIcon={getProviderIcon}
        resolveCodingAgent={resolveCodingAgent}
      />

      {/* 2. Toggle button for older archived subagents */}
      {shownHiddenArchivedCount > 0 ? (
        <PressHighlight
          accessibilityRole="button"
          accessibilityLabel={`Show ${shownHiddenArchivedCount} older archived subagents`}
          onPress={handleShowAllArchived}
          style={[styles.treeToggleMoreRow, isToggleHovered && styles.treeToggleMoreRowHovered]}
          {...({
            onMouseEnter: handleToggleMouseEnter,
            onMouseLeave: handleToggleMouseLeave,
          } as object)}
        >
          <ChevronRight size={10} color="#94a3b8" />
          <Text style={styles.treeToggleMoreText}>+{shownHiddenArchivedCount} older archived</Text>
        </PressHighlight>
      ) : null}
      {shownHiddenArchivedCount === 0 &&
      showAllArchived &&
      !workingOnly &&
      totalArchivedCount > ARCHIVED_SUBAGENTS_LIMIT ? (
        <PressHighlight
          accessibilityRole="button"
          accessibilityLabel="Show fewer archived subagents"
          onPress={handleHideOlderArchived}
          style={[styles.treeToggleMoreRow, isToggleHovered && styles.treeToggleMoreRowHovered]}
          {...({
            onMouseEnter: handleToggleMouseEnter,
            onMouseLeave: handleToggleMouseLeave,
          } as object)}
        >
          <ChevronDown size={10} color="#94a3b8" />
          <Text style={styles.treeToggleMoreText}>Show less</Text>
        </PressHighlight>
      ) : null}

      {/* 3. Archived / Completed subagents below, nested the same way */}
      <SubagentTreeForest
        nodes={shownArchivedRoots}
        workspace={workspace}
        parentProvider={parentProvider}
        activeTargetKey={activeTargetKey}
        getProviderIcon={getProviderIcon}
        resolveCodingAgent={resolveCodingAgent}
      />
    </View>
  );
});

/**
 * One flat row list rendered as seat sections (Lead, Builders, Checkers …), oldest first
 * inside a seat. Sections earn a header once they hold more than one row.
 */
/**
 * One visible row list rendered as a nested Supervisor → Lead → Builder/Checker tree.
 * Children indent under their parent so the chain of command reads at a glance.
 */
/** Sidebar entry to the full-screen SLP hierarchy view; owns its own open state. */
function HierarchyButton({ workspace }: { workspace: SidebarWorkspaceEntry }) {
  const [isOpen, setIsOpen] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  return (
    <>
      <PressHighlight
        accessibilityRole="button"
        accessibilityLabel="Open SLP hierarchy"
        onPress={open}
        style={[styles.hierarchyButtonRow, isHovered && styles.treeToggleMoreRowHovered]}
        {...({
          onMouseEnter: () => setIsHovered(true),
          onMouseLeave: () => setIsHovered(false),
        } as object)}
      >
        <Network size={10} color="#a78bfa" />
        <Text style={styles.hierarchyButtonText}>SLP hierarchy</Text>
      </PressHighlight>
      {isOpen ? <SlpHierarchyModal workspace={workspace} visible onClose={close} /> : null}
    </>
  );
}

const SubagentTreeForest = memo(function SubagentTreeForest({
  nodes,
  workspace,
  parentProvider,
  activeTargetKey,
  getProviderIcon,
  resolveCodingAgent,
}: {
  /** Prebuilt subtree roots; the working/archived split already happened upstream. */
  nodes: readonly SubagentTreeNode[];
  workspace: SidebarWorkspaceEntry;
  parentProvider: string | null;
  activeTargetKey: string | null;
  getProviderIcon: ReturnType<typeof useProviderIcons>;
  resolveCodingAgent: (provider: string) => CodingAgentInfo | null;
}) {
  return (
    <>
      {nodes.map((node) => (
        <SubagentTreeNodeView
          key={`${node.row.kind}_${node.row.id}`}
          node={node}
          workspace={workspace}
          parentProvider={parentProvider}
          activeTargetKey={activeTargetKey}
          getProviderIcon={getProviderIcon}
          resolveCodingAgent={resolveCodingAgent}
        />
      ))}
    </>
  );
});

const SubagentTreeNodeView = memo(function SubagentTreeNodeView({
  node,
  workspace,
  parentProvider,
  activeTargetKey,
  getProviderIcon,
  resolveCodingAgent,
}: {
  node: SubagentTreeNode;
  workspace: SidebarWorkspaceEntry;
  parentProvider: string | null;
  activeTargetKey: string | null;
  getProviderIcon: ReturnType<typeof useProviderIcons>;
  resolveCodingAgent: (provider: string) => CodingAgentInfo | null;
}) {
  const { row } = node;
  const rowTargetKey =
    row.kind === "paseo" ? `paseo:${row.id}` : `provider:${row.parentAgentId}:${row.id}`;
  return (
    <View>
      <SidebarSubagentTreeItem
        workspace={workspace}
        row={row}
        parentProvider={parentProvider}
        isSelected={activeTargetKey === rowTargetKey}
        getProviderIcon={getProviderIcon}
        resolveCodingAgent={resolveCodingAgent}
      />
      {node.children.length > 0 ? (
        <View style={styles.treeChildrenIndent}>
          {node.children.map((child) => (
            <SubagentTreeNodeView
              key={`${child.row.kind}_${child.row.id}`}
              node={child}
              workspace={workspace}
              parentProvider={parentProvider}
              activeTargetKey={activeTargetKey}
              getProviderIcon={getProviderIcon}
              resolveCodingAgent={resolveCodingAgent}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
});

const WorkingOnlyToggle = memo(function WorkingOnlyToggle({
  workingOnly,
  onToggle,
}: {
  workingOnly: boolean;
  onToggle: () => void;
}) {
  const [isHovered, setIsHovered] = useState(false);
  const handleMouseEnter = useCallback(() => {
    setIsHovered(true);
  }, []);
  const handleMouseLeave = useCallback(() => {
    setIsHovered(false);
  }, []);
  return (
    <PressHighlight
      accessibilityRole="button"
      accessibilityLabel={workingOnly ? "Show all subagents" : "Show only working subagents"}
      onPress={onToggle}
      style={[styles.treeToggleMoreRow, isHovered && styles.treeToggleMoreRowHovered]}
      {...({
        onMouseEnter: handleMouseEnter,
        onMouseLeave: handleMouseLeave,
      } as object)}
    >
      <Text style={styles.treeToggleMoreText}>{workingOnly ? "Show all" : "Working only"}</Text>
    </PressHighlight>
  );
});

const SidebarSubagentTreeItem = memo(function SidebarSubagentTreeItem({
  workspace,
  row,
  parentProvider,
  isSelected,
  getProviderIcon,
  resolveCodingAgent,
}: {
  workspace: SidebarWorkspaceEntry;
  row: SubagentRow;
  parentProvider: string | null;
  isSelected: boolean;
  getProviderIcon: ReturnType<typeof useProviderIcons>;
  resolveCodingAgent: (provider: string) => CodingAgentInfo | null;
}) {
  const [isHovered, setIsHovered] = useState(false);

  const presentation = useMemo(() => buildSubagentRowPresentationData(row), [row]);
  const slpRole = useMemo(() => deriveSubagentRole(row), [row]);
  const rolePresentation = useMemo(
    () => (slpRole ? getSlpRolePresentation(slpRole) : null),
    [slpRole],
  );
  const providerTone = getProviderAccentTone(row.provider);
  // An SLP seat wears its own icon and color block; anything else keeps the provider's.
  const badgeTone = rolePresentation?.tone ?? providerTone;
  const isSameProviderAsParent =
    Boolean(parentProvider) &&
    formatShortProviderName(row.provider) === formatShortProviderName(parentProvider);
  const ProviderIcon = !isSameProviderAsParent
    ? resolveBuiltinProviderIcon(row.provider, getProviderIcon)
    : null;
  const BadgeIcon = rolePresentation?.Icon ?? ProviderIcon;

  const roleBadgeLabel = useMemo(() => {
    if (rolePresentation) return rolePresentation.label;
    if (row.kind === "provider") {
      const rawType = row.title?.trim();
      if (rawType && rawType.length <= 18) {
        return rawType;
      }
      return "Task";
    }
    return formatShortProviderName(row.provider);
  }, [rolePresentation, row]);

  const primaryTaskLabel = useMemo(() => {
    if (row.kind === "provider") {
      return row.description?.trim() || row.title?.trim() || "Subagent task";
    }
    return presentation.label || row.title?.trim() || "Subagent";
  }, [presentation.label, row]);

  const statusText = useMemo(() => {
    switch (presentation.statusBucket) {
      case "running":
        return "Running";
      case "needs_input":
        return "Input";
      case "failed":
        return "Failed";
      default:
        return "";
    }
  }, [presentation.statusBucket]);

  const statusIndicator = useMemo(() => {
    if (presentation.statusBucket === "running") {
      return (
        <View style={styles.miniSpinnerWrap}>
          <StatusRing />
        </View>
      );
    }
    if (presentation.statusBucket === "needs_input") {
      return <AlertCircle size={10} color="#f59e0b" />;
    }
    if (presentation.statusBucket === "failed") {
      return <AlertCircle size={10} color="#f43f5e" />;
    }
    return <CheckCircle2 size={9.5} color="#64748b" />;
  }, [presentation.statusBucket]);

  // Per-seat meta: the model the agent runs, the coding agent its provider fronts, and the
  // checkout branch it works on. Managed (paseo) rows carry all three; provider-owned
  // subagent tasks expose none of them, so they stay a single line.
  const codingAgent = useMemo(
    () => (row.kind === "paseo" ? resolveCodingAgent(row.provider) : null),
    [resolveCodingAgent, row],
  );
  const modelShort = useMemo(
    () => (row.kind === "paseo" ? formatShortModelName(row.model) : null),
    [row],
  );
  const rowBranch = useSessionStore(
    useCallback(
      (state) => {
        if (row.kind !== "paseo") return null;
        const session = state.sessions[workspace.serverId];
        const ws = row.workspaceId ? session?.workspaces.get(row.workspaceId) : undefined;
        return ws?.gitRuntime?.currentBranch ?? null;
      },
      [row, workspace.serverId],
    ),
  );
  const branch = row.kind === "paseo" ? (rowBranch ?? workspace.currentBranch ?? null) : null;

  const handlePress = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      const target =
        row.kind === "paseo"
          ? ({ kind: "agent", agentId: row.id } as const)
          : ({
              kind: "provider_subagent",
              parentAgentId: row.parentAgentId,
              subagentId: row.id,
            } as const);
      const resolvedWorkspaceKey =
        workspace.workspaceKey || `${workspace.serverId}:${workspace.workspaceId}`;

      useWorkspaceLayoutStore.getState().openTab({
        workspaceKey: resolvedWorkspaceKey,
        target,
        intent: "reveal",
        pin: true,
      });

      navigateToWorkspace({
        serverId: workspace.serverId,
        workspaceId: workspace.workspaceId,
        target,
        pin: true,
      });
    },
    [row, workspace.serverId, workspace.workspaceId, workspace.workspaceKey],
  );

  const handlePressIn = useCallback((event: GestureResponderEvent) => {
    event.stopPropagation();
  }, []);

  const handlePressOut = useCallback((event: GestureResponderEvent) => {
    event.stopPropagation();
  }, []);

  const handleHoverIn = useCallback(() => {
    setIsHovered(true);
  }, []);

  const handleHoverOut = useCallback(() => {
    setIsHovered(false);
  }, []);

  return (
    <PressHighlight
      accessibilityRole="button"
      accessibilityLabel={`${roleBadgeLabel}: ${primaryTaskLabel}`}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      onPress={handlePress}
      {...({
        onPointerDown: (e: { stopPropagation?: () => void }) => e.stopPropagation?.(),
        onMouseDown: (e: { stopPropagation?: () => void }) => e.stopPropagation?.(),
      } as object)}
      onHoverIn={handleHoverIn}
      onHoverOut={handleHoverOut}
      style={[
        styles.treeItemRow,
        isHovered && styles.treeItemRowHovered,
        isSelected && styles.treeItemRowSelected,
      ]}
      testID={`sidebar-subagent-row-${row.kind}-${row.id}`}
    >
      {/* Clean horizontal tree connector tick */}
      <View style={styles.treeBranchTick} />

      <View style={styles.treeItemBody}>
        <View style={styles.treeItemMainRow}>
          {/* Live status indicator */}
          <View style={styles.subagentStatusSlot}>{statusIndicator}</View>

          {/* Seat pill: SLP seats wear their own icon and color block, anything else keeps the
              provider icon — shown only when it differs from the parent workspace agent. */}
          <View
            style={[
              styles.subagentRoleBadge,
              {
                backgroundColor: badgeTone.bg,
                borderColor: badgeTone.border,
              },
            ]}
          >
            {BadgeIcon ? <BadgeIcon size={10} color={badgeTone.text} /> : null}
            <Text style={[styles.subagentRoleText, { color: badgeTone.text }]} numberOfLines={1}>
              {roleBadgeLabel}
            </Text>
          </View>

          {/* Subagent task title */}
          <Text
            style={[
              styles.subagentTaskTitle,
              (isHovered || isSelected) && styles.subagentTaskTitleActive,
            ]}
            numberOfLines={1}
          >
            {primaryTaskLabel}
          </Text>

          {/* Active status label on right (only when running / input / failed) */}
          {statusText ? (
            <Text
              style={[
                styles.subagentStatusLabel,
                presentation.statusBucket === "running" && styles.subagentStatusRunning,
                presentation.statusBucket === "needs_input" && styles.subagentStatusNeedsInput,
                presentation.statusBucket === "failed" && styles.subagentStatusFailed,
              ]}
              numberOfLines={1}
            >
              {statusText}
            </Text>
          ) : null}
        </View>

        {/* Meta line: which model, which coding agent, which branch. SLP rows show all three;
            anything without the data stays a single line. */}
        <SubagentTreeItemMeta codingAgent={codingAgent} modelShort={modelShort} branch={branch} />
      </View>
    </PressHighlight>
  );
});

/** The row's second line: coding agent, model, branch. Renders nothing when all are absent. */
function SubagentTreeItemMeta({
  codingAgent,
  modelShort,
  branch,
}: {
  codingAgent: CodingAgentInfo | null;
  modelShort: string | null;
  branch: string | null;
}) {
  if (!codingAgent && !modelShort && !branch) return null;
  const codingAgentColor = codingAgent ? getProviderAccentTone(codingAgent.id).text : "#94a3b8";
  return (
    <View style={styles.treeItemMetaRow}>
      {codingAgent ? (
        <View style={styles.subagentMetaChip}>
          {codingAgent.Icon ? <codingAgent.Icon size={9} color={codingAgentColor} /> : null}
          <Text style={[styles.subagentMetaText, { color: codingAgentColor }]} numberOfLines={1}>
            {codingAgent.label}
          </Text>
        </View>
      ) : null}
      {modelShort ? (
        <Text style={styles.subagentMetaText} numberOfLines={1}>
          {modelShort}
        </Text>
      ) : null}
      {branch ? (
        <View style={styles.subagentMetaChip}>
          <GitFork size={9} color="#64748b" />
          <Text style={styles.subagentMetaText} numberOfLines={1}>
            {branch}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  titleProviderBadgeGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    flexShrink: 0,
  },
  titleProviderIconChip: {
    width: 16,
    height: 16,
    borderRadius: 4,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  agentMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "nowrap",
    gap: 4,
    marginTop: 2,
  },
  providerBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3.5,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
    borderWidth: 1,
    flexShrink: 1,
    minWidth: 0,
  },
  providerIconBox: {
    width: 12,
    height: 12,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  extraProviderIconInline: {
    marginLeft: 1.5,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  providerNameText: {
    fontSize: 10,
    lineHeight: 13,
    fontFamily: theme.fontFamily.ui,
    fontWeight: "600",
    flexShrink: 0,
  },
  providerModelDot: {
    fontSize: 9.5,
    lineHeight: 13,
    color: theme.colors.foregroundMuted,
    flexShrink: 0,
  },
  providerModelText: {
    fontSize: 9.5,
    lineHeight: 13,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foregroundMuted,
    flexShrink: 1,
  },
  multiAgentCountBadge: {
    fontSize: 9,
    lineHeight: 12,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foregroundMuted,
    marginLeft: 1,
    flexShrink: 0,
  },
  subagentTogglePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
    borderWidth: 1,
    flexShrink: 0,
  },
  subagentTogglePillHovered: {
    opacity: 0.9,
  },
  subagentTogglePillText: {
    fontSize: 9.5,
    lineHeight: 13,
    fontFamily: theme.fontFamily.ui,
    fontWeight: "500",
  },
  miniSpinnerWrap: {
    width: 10,
    height: 10,
    alignItems: "center",
    justifyContent: "center",
    transform: [{ scale: 0.72 }],
  },
  treeContainer: {
    marginLeft: 20,
    marginRight: 6,
    marginTop: 1,
    marginBottom: 3,
    paddingLeft: 4,
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.border,
    gap: 1,
  },
  treeContainerStatusGroup: {
    marginLeft: 16,
  },
  treeToggleMoreRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingVertical: 2,
    paddingHorizontal: 4,
    borderRadius: 4,
    marginLeft: 4,
    marginVertical: 1,
  },
  treeChildrenIndent: {
    marginLeft: 10,
    paddingLeft: 4,
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.border,
  },
  treeToggleMoreRowHovered: {
    backgroundColor: theme.colors.surface1,
  },
  hierarchyButtonRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingVertical: 3,
    paddingHorizontal: 6,
    borderRadius: 5,
  },
  hierarchyButtonText: {
    fontSize: 10,
    lineHeight: 13,
    fontFamily: theme.fontFamily.ui,
    fontWeight: "600",
    color: "#a78bfa",
  },
  treeToggleMoreText: {
    fontSize: 9.5,
    lineHeight: 13,
    fontFamily: theme.fontFamily.ui,
    color: theme.colors.foregroundMuted,
  },
  treeItemRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingVertical: 2,
    paddingHorizontal: 4,
    borderRadius: 5,
  },
  treeItemBody: {
    flex: 1,
    minWidth: 0,
    flexDirection: "column",
    gap: 1,
  },
  treeItemMainRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  treeItemMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingLeft: 15,
  },
  treeItemRowHovered: {
    backgroundColor: theme.colors.surface1,
  },
  treeItemRowSelected: {
    backgroundColor: theme.colors.surface2,
  },
  treeBranchTick: {
    width: 6,
    height: 1,
    backgroundColor: theme.colors.border,
    flexShrink: 0,
  },
  subagentStatusSlot: {
    width: 11,
    height: 11,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  subagentMetaChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    flexShrink: 0,
    maxWidth: "45%",
  },
  subagentMetaText: {
    fontSize: 9,
    lineHeight: 11,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foregroundMuted,
    flexShrink: 1,
  },
  subagentRoleBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingHorizontal: 4,
    paddingVertical: 0.5,
    borderRadius: 3.5,
    borderWidth: 1,
    flexShrink: 0,
  },
  subagentRoleText: {
    fontSize: 9,
    lineHeight: 12,
    fontFamily: theme.fontFamily.ui,
    fontWeight: "600",
  },
  subagentTaskTitle: {
    flex: 1,
    minWidth: 40,
    fontSize: 11,
    lineHeight: 14,
    fontFamily: theme.fontFamily.ui,
    color: theme.colors.foregroundMuted,
  },
  subagentTaskTitleActive: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.ui,
    fontWeight: "500",
  },
  subagentStatusLabel: {
    fontSize: 9,
    lineHeight: 12,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foregroundMuted,
    flexShrink: 0,
    marginLeft: 2,
  },
  subagentStatusRunning: {
    color: "#10b981",
    fontFamily: theme.fontFamily.ui,
    fontWeight: "600",
  },
  subagentStatusNeedsInput: {
    color: "#f59e0b",
    fontFamily: theme.fontFamily.ui,
    fontWeight: "600",
  },
  subagentStatusFailed: {
    color: "#f43f5e",
    fontFamily: theme.fontFamily.ui,
    fontWeight: "600",
  },
}));
