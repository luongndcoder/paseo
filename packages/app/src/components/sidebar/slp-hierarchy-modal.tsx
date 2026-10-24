import { AlertCircle, CheckCircle2, GitFork, X } from "lucide-react-native";
import { memo, useCallback, useMemo } from "react";
import { Modal, ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { PressHighlight } from "@/components/ui/press-highlight";
import { StatusRing } from "@/components/status-ring";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useSessionStore } from "@/stores/session-store";
import { buildSubagentRowPresentationData } from "@/subagents/track-presentation";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";
import {
  buildSubagentForest,
  deriveSubagentRole,
  formatShortModelName,
  getProviderAccentTone,
  getSlpRolePresentation,
  resolveBuiltinProviderIcon,
  resolveCodingAgentInfo,
  useWorkspaceAgentSidebarSummary,
  type CodingAgentInfo,
  type ProviderAccentTone,
  type SubagentTreeNode,
} from "./sidebar-workspace-agent-tree";

function StatusDot({ bucket }: { bucket: SidebarStateBucket }) {
  if (bucket === "running") {
    return (
      <View style={styles.spinnerWrap}>
        <StatusRing />
      </View>
    );
  }
  if (bucket === "needs_input") return <AlertCircle size={13} color="#f59e0b" />;
  if (bucket === "failed") return <AlertCircle size={13} color="#f43f5e" />;
  return <CheckCircle2 size={13} color="#64748b" />;
}

/** The branch a managed agent works on: its own workspace's checkout, else the host workspace's. */
function useRowBranch(
  row: SubagentTreeNode["row"],
  serverId: string,
  fallbackBranch: string | null,
): string | null {
  const rowBranch = useSessionStore(
    useCallback(
      (state) => {
        if (row.kind !== "paseo") return null;
        const session = state.sessions[serverId];
        const ws = row.workspaceId ? session?.workspaces.get(row.workspaceId) : undefined;
        return ws?.gitRuntime?.currentBranch ?? null;
      },
      [row, serverId],
    ),
  );
  if (row.kind !== "paseo") return null;
  return rowBranch ?? fallbackBranch;
}

const SlpMetaChips = memo(function SlpMetaChips({
  model,
  codingAgent,
  branch,
}: {
  model: string | null;
  codingAgent: CodingAgentInfo | null;
  branch: string | null;
}) {
  if (!model && !codingAgent && !branch) return null;
  const codingAgentColor = codingAgent ? getProviderAccentTone(codingAgent.id).text : "#94a3b8";
  return (
    <View style={styles.metaRow}>
      {codingAgent ? (
        <View style={styles.metaChip}>
          {codingAgent.Icon ? <codingAgent.Icon size={11} color={codingAgentColor} /> : null}
          <Text style={[styles.metaText, { color: codingAgentColor }]} numberOfLines={1}>
            {codingAgent.label}
          </Text>
        </View>
      ) : null}
      {model ? (
        <View style={styles.metaChip}>
          <Text style={styles.metaText} numberOfLines={1}>
            {model}
          </Text>
        </View>
      ) : null}
      {branch ? (
        <View style={styles.metaChip}>
          <GitFork size={11} color="#64748b" />
          <Text style={styles.metaText} numberOfLines={1}>
            {branch}
          </Text>
        </View>
      ) : null}
    </View>
  );
});

const SlpNodeCard = memo(function SlpNodeCard({
  node,
  depth,
  workspace,
  resolveCodingAgent,
}: {
  node: SubagentTreeNode;
  depth: number;
  workspace: SidebarWorkspaceEntry;
  resolveCodingAgent: (provider: string) => CodingAgentInfo | null;
}) {
  const { row } = node;
  const role = useMemo(() => deriveSubagentRole(row), [row]);
  const seat = useMemo(() => (role ? getSlpRolePresentation(role) : null), [role]);
  const tone: ProviderAccentTone = seat?.tone ?? getProviderAccentTone(row.provider);
  const presentation = useMemo(() => buildSubagentRowPresentationData(row), [row]);
  const model = useMemo(
    () => (row.kind === "paseo" ? formatShortModelName(row.model) : null),
    [row],
  );
  const codingAgent = useMemo(
    () => (row.kind === "paseo" ? resolveCodingAgent(row.provider) : null),
    [resolveCodingAgent, row],
  );
  const branch = useRowBranch(row, workspace.serverId, workspace.currentBranch ?? null);
  const title =
    row.kind === "paseo"
      ? row.title?.trim() || "Subagent"
      : row.description?.trim() || row.title?.trim() || "Subagent task";

  return (
    <View>
      <View style={[styles.card, { borderLeftColor: tone.border }]}>
        <View style={styles.cardMainRow}>
          <StatusDot bucket={presentation.statusBucket ?? "done"} />
          <View style={[styles.seatPill, { backgroundColor: tone.bg, borderColor: tone.border }]}>
            {seat ? <seat.Icon size={11} color={tone.text} /> : null}
            <Text style={[styles.seatText, { color: tone.text }]} numberOfLines={1}>
              {seat?.label ?? row.provider}
            </Text>
          </View>
          <Text style={styles.cardTitle} numberOfLines={2}>
            {title}
          </Text>
        </View>
        <SlpMetaChips model={model} codingAgent={codingAgent} branch={branch} />
      </View>
      {node.children.length > 0 ? (
        <View style={styles.childrenIndent}>
          {node.children.map((child) => (
            <SlpNodeCard
              key={`${child.row.kind}_${child.row.id}`}
              node={child}
              depth={depth + 1}
              workspace={workspace}
              resolveCodingAgent={resolveCodingAgent}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
});

/**
 * Full-screen SLP hierarchy view for a workspace: the supervisor card on top, then every
 * subagent nested Supervisor → Lead → Builder/Checker with one card per agent showing the
 * model it runs, the coding agent its provider fronts, and its checkout branch.
 */
export function SlpHierarchyModal({
  workspace,
  visible,
  onClose,
}: {
  workspace: SidebarWorkspaceEntry;
  visible: boolean;
  onClose: () => void;
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
  const forest = useMemo(() => buildSubagentForest(summary.subagents), [summary.subagents]);
  const supervisor = summary.primaryAgent;
  const supervisorCodingAgent = supervisor ? resolveCodingAgent(supervisor.provider) : null;
  const supervisorTone = supervisor ? getProviderAccentTone(supervisor.provider) : null;
  const SupervisorIcon = supervisor ? resolveBuiltinProviderIcon(supervisor.provider) : null;

  return (
    <Modal visible={visible} animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.header}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            SLP hierarchy
          </Text>
          <PressHighlight onPress={onClose} hitSlop={8} style={styles.closeButton}>
            <X size={18} color="#94a3b8" />
          </PressHighlight>
        </View>
        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator>
          {supervisor ? (
            <View style={[styles.card, styles.supervisorCard, { borderLeftColor: "#a78bfa" }]}>
              <View style={styles.cardMainRow}>
                <StatusDot bucket={supervisor.statusBucket ?? "done"} />

                <View style={[styles.seatPill, styles.supervisorPill]}>
                  <Text style={[styles.seatText, { color: "#a78bfa" }]}>Supervisor</Text>
                </View>
                <Text style={styles.cardTitle} numberOfLines={2}>
                  {supervisor.title?.trim() || workspace.name}
                </Text>
              </View>
              <SlpMetaChips
                model={supervisor.modelShort}
                codingAgent={supervisorCodingAgent}
                branch={workspace.currentBranch ?? null}
              />
              {SupervisorIcon && supervisorTone ? (
                <View style={styles.supervisorProviderRow}>
                  <SupervisorIcon size={12} color={supervisorTone.text} />
                  <Text style={[styles.metaText, { color: supervisorTone.text }]}>
                    {supervisor.providerLabel}
                  </Text>
                </View>
              ) : null}
            </View>
          ) : null}
          {forest.map((node) => (
            <SlpNodeCard
              key={`${node.row.kind}_${node.row.id}`}
              node={node}
              depth={0}
              workspace={workspace}
              resolveCodingAgent={resolveCodingAgent}
            />
          ))}
          {forest.length === 0 && !supervisor ? (
            <Text style={styles.emptyText}>No agents in this workspace yet.</Text>
          ) : null}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create((theme) => ({
  overlay: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: "600",
    color: theme.colors.foreground,
    flex: 1,
  },
  closeButton: {
    padding: 6,
    borderRadius: 6,
  },
  content: {
    padding: 16,
    gap: 8,
  },
  card: {
    backgroundColor: theme.colors.surface0,
    borderLeftWidth: 3,
    borderRadius: 8,
    padding: 10,
    gap: 6,
  },
  supervisorCard: {
    backgroundColor: theme.colors.surface1,
  },
  cardMainRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  seatPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 5,
    borderWidth: 1,
    flexShrink: 0,
  },
  supervisorPill: {
    backgroundColor: "rgba(167, 139, 250, 0.14)",
    borderColor: "rgba(167, 139, 250, 0.45)",
  },
  seatText: {
    fontSize: 11,
    fontWeight: "600",
    fontFamily: theme.fontFamily.ui,
  },
  cardTitle: {
    flex: 1,
    minWidth: 40,
    fontSize: 13,
    lineHeight: 17,
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.ui,
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingLeft: 21,
    flexWrap: "wrap",
  },
  metaChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  metaText: {
    fontSize: 11,
    lineHeight: 14,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foregroundMuted,
  },
  childrenIndent: {
    marginLeft: 14,
    paddingLeft: 10,
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.border,
    gap: 8,
    marginTop: 8,
  },
  supervisorProviderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingLeft: 21,
  },
  spinnerWrap: {
    width: 13,
    height: 13,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyText: {
    fontSize: 13,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
    paddingVertical: 24,
  },
}));
