import equal from "fast-deep-equal";
import { AlertCircle, CheckCircle2, ChevronDown, ChevronRight, GitFork } from "lucide-react-native";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, Text, View, type GestureResponderEvent } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
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
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useSessionStore, type Agent } from "@/stores/session-store";
import {
  collectAllTabs,
  findPaneById,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import { isWorkspaceRootAgent } from "@/subagents/policies";
import { refreshProviderSubagents, useProviderSubagentStore } from "@/subagents/provider-store";
import {
  selectProviderSubagentsForParent,
  selectSubagentsForParent,
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
          if (agent.archivedAt || pendingArchiveIds.has(agent.id)) return;
          const matchesWorkspaceId =
            Boolean(normalizedWorkspaceId) &&
            normalizeWorkspaceOpaqueId(agent.workspaceId) === normalizedWorkspaceId;
          const matchesDirectory =
            Boolean(normalizedWorkspaceDir) &&
            Boolean(agent.cwd) &&
            normalizeWorkspacePath(agent.cwd) === normalizedWorkspaceDir;
          const matchesLayoutTab = layoutAgentIdSet.has(agent.id);

          if (matchesWorkspaceId || matchesDirectory || matchesLayoutTab) {
            seenIds.add(agent.id);
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
        isWorkspaceRootAgent(agent, agent.parentAgentId ? byId.get(agent.parentAgentId) : undefined),
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
        const collected: SubagentRow[] = [];
        const seenIds = new Set<string>();
        for (const parentAgentId of rootAgentIds) {
          const rows = selectSubagentsForParent(
            state,
            { serverId, parentAgentId },
            pendingArchiveIds,
          );
          for (const row of rows) {
            if (!seenIds.has(row.id)) {
              seenIds.add(row.id);
              collected.push(row);
            }
          }
        }
        // Also include any non-root agent in this workspace whose parent might live elsewhere
        const rootIdSet = new Set(rootAgentIds);
        for (const agent of rawWorkspaceAgents) {
          if (!rootIdSet.has(agent.id) && !seenIds.has(agent.id)) {
            seenIds.add(agent.id);
            collected.push({
              kind: "paseo",
              id: agent.id,
              provider: agent.provider,
              title: agent.title,
              description: null,
              subtitle: null,
              status: agent.status,
              turn: agent.turn,
              requiresAttention: agent.requiresAttention,
              createdAt: agent.createdAt,
            });
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

    // If the workspace does not have a live root agent yet (e.g. draft tab or freshly opened workspace),
    // synthesize the configured provider from the draft tab setup or user's preferred provider so the
    // Provider Icon (Claude Code, Codex, Pi, etc.) is always visible in the sidebar.
    if (rootAgents.length === 0) {
      const fallbackProvider =
        layoutAgentAndDraftInfo.draftProvider ?? preferences?.provider ?? "claude";
      const providerPref = preferences?.providerPreferences?.[fallbackProvider];
      const fallbackModelFull =
        layoutAgentAndDraftInfo.draftModel ?? providerPref?.model ?? null;
      const fallbackModeId =
        layoutAgentAndDraftInfo.draftModeId ?? providerPref?.mode ?? null;

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

  const hasActiveSubagent =
    summary.runningSubagentCount > 0 || summary.needsInputSubagentCount > 0;
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
    [
      isCollapsed,
      serverId,
      summary.subagents,
      toggleWorkspaceSubagents,
      workspaceId,
      workspaceKey,
    ],
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

  if (!summary.primaryAgent && summary.subagents.length === 0) {
    return null;
  }

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
        <Pressable
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
          style={({ hovered }) => [
            styles.subagentTogglePill,
            {
              backgroundColor: subagentPillTone.bg,
              borderColor: subagentPillTone.border,
            },
            hovered && styles.subagentTogglePillHovered,
          ]}
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
        </Pressable>
      ) : null}
    </View>
  );
});

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
  const explicitCollapsed = useSidebarSubagentTreeStore(
    (state) => state.collapsedByWorkspaceKey[resolvedWorkspaceKey],
  );
  const hasActiveSubagent =
    summary.runningSubagentCount > 0 || summary.needsInputSubagentCount > 0;
  const isCollapsed = explicitCollapsed ?? !hasActiveSubagent;
  const getProviderIcon = useProviderIcons(workspace.serverId);

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

  if (summary.subagents.length === 0 || isCollapsed) {
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
      {summary.subagents.map((row) => {
        const rowTargetKey =
          row.kind === "paseo"
            ? `paseo:${row.id}`
            : `provider:${row.parentAgentId}:${row.id}`;
        return (
          <SidebarSubagentTreeItem
            key={`${row.kind}_${row.id}`}
            workspace={workspace}
            row={row}
            parentProvider={parentProvider}
            isSelected={activeTargetKey === rowTargetKey}
            getProviderIcon={getProviderIcon}
          />
        );
      })}
    </View>
  );
});

const SidebarSubagentTreeItem = memo(function SidebarSubagentTreeItem({
  workspace,
  row,
  parentProvider,
  isSelected,
  getProviderIcon,
}: {
  workspace: SidebarWorkspaceEntry;
  row: SubagentRow;
  parentProvider: string | null;
  isSelected: boolean;
  getProviderIcon: ReturnType<typeof useProviderIcons>;
}) {
  const { theme } = useUnistyles();
  const [isHovered, setIsHovered] = useState(false);

  const presentation = useMemo(() => buildSubagentRowPresentationData(row), [row]);
  const providerTone = getProviderAccentTone(row.provider);
  const isSameProviderAsParent =
    Boolean(parentProvider) &&
    formatShortProviderName(row.provider) === formatShortProviderName(parentProvider);
  const ProviderIcon = !isSameProviderAsParent
    ? resolveBuiltinProviderIcon(row.provider, getProviderIcon)
    : null;

  const roleBadgeLabel = useMemo(() => {
    if (row.kind === "provider") {
      const rawType = row.title?.trim();
      if (rawType && rawType.length <= 18) {
        return rawType;
      }
      return "Task";
    }
    return formatShortProviderName(row.provider);
  }, [row]);

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

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${roleBadgeLabel}: ${primaryTaskLabel}`}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      onPress={handlePress}
      {...({
        onPointerDown: (e: { stopPropagation?: () => void }) => e.stopPropagation?.(),
        onMouseDown: (e: { stopPropagation?: () => void }) => e.stopPropagation?.(),
      } as object)}
      onHoverIn={() => setIsHovered(true)}
      onHoverOut={() => setIsHovered(false)}
      style={[
        styles.treeItemRow,
        isHovered && styles.treeItemRowHovered,
        isSelected && styles.treeItemRowSelected,
      ]}
      testID={`sidebar-subagent-row-${row.kind}-${row.id}`}
    >
      {/* Clean horizontal tree connector tick */}
      <View style={styles.treeBranchTick} />

      {/* Live status indicator */}
      <View style={styles.subagentStatusSlot}>
        {presentation.statusBucket === "running" ? (
          <View style={styles.miniSpinnerWrap}>
            <StatusRing />
          </View>
        ) : presentation.statusBucket === "needs_input" ? (
          <AlertCircle size={10} color="#f59e0b" />
        ) : presentation.statusBucket === "failed" ? (
          <AlertCircle size={10} color="#f43f5e" />
        ) : (
          <CheckCircle2 size={9.5} color={theme.colors.foregroundMuted} />
        )}
      </View>

      {/* Subagent role pill (only shows provider icon if different from parent workspace agent) */}
      <View
        style={[
          styles.subagentRoleBadge,
          {
            backgroundColor: providerTone.bg,
            borderColor: providerTone.border,
          },
        ]}
      >
        {ProviderIcon ? <ProviderIcon size={10} color={providerTone.text} /> : null}
        <Text style={[styles.subagentRoleText, { color: providerTone.text }]} numberOfLines={1}>
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
    </Pressable>
  );
});

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
  treeItemRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingVertical: 2,
    paddingHorizontal: 4,
    borderRadius: 5,
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

