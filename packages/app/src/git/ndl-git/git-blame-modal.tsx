import { Portal } from "@gorhom/portal";
import type { CheckoutGitBlameLine } from "@getpaseo/protocol/messages";
import * as Clipboard from "expo-clipboard";
import { FileCode2, GitCommitHorizontal, History, RefreshCw, X } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import { isWeb } from "@/constants/platform";
import { useToast } from "@/contexts/toast-context";
import { useHostRuntimeClient } from "@/runtime/host-runtime";

import { GRAPH_LANE_COLORS } from "./commit-graph-layout";

export interface GitBlameModalProps {
  visible?: boolean;
  open?: boolean;
  onClose: () => void;
  serverId: string;
  cwd: string;
  filePath?: string;
  path?: string;
  onOpenFileHistory?: (filePath: string) => void;
  onInspectCommit?: (sha: string) => void;
  onSelectCommit?: (sha: string) => void;
}

function hashShaToColor(sha: string): string {
  let hash = 0;
  for (let i = 0; i < Math.min(sha.length, 8); i++) {
    hash = (hash * 31 + sha.charCodeAt(i)) >>> 0;
  }
  return GRAPH_LANE_COLORS[hash % GRAPH_LANE_COLORS.length];
}

function formatBlameShortDate(line: CheckoutGitBlameLine): string {
  const rawDate = (line as unknown as { date?: string }).date;
  if (typeof rawDate === "string" && rawDate.length >= 10) {
    return rawDate.slice(0, 10);
  }
  if (typeof line.authorTime === "number" && line.authorTime > 0) {
    try {
      return new Date(line.authorTime * 1000).toISOString().slice(0, 10);
    } catch {
      return "";
    }
  }
  return "";
}

function formatBlameFullDate(line: CheckoutGitBlameLine): string {
  const rawDate = (line as unknown as { date?: string }).date;
  if (typeof rawDate === "string" && rawDate.length > 0) {
    const parsed = new Date(rawDate);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toLocaleString();
    }
  }
  if (typeof line.authorTime === "number" && line.authorTime > 0) {
    try {
      return new Date(line.authorTime * 1000).toLocaleString();
    } catch {
      return "";
    }
  }
  return "";
}

export function GitBlameModal({
  visible,
  open,
  onClose,
  serverId,
  cwd,
  filePath,
  path,
  onOpenFileHistory,
  onInspectCommit,
  onSelectCommit,
}: GitBlameModalProps) {
  const isVisible = Boolean(visible ?? open);
  const resolvedFilePath = filePath ?? path ?? "";
  const { theme } = useUnistyles();
  const client = useHostRuntimeClient(serverId);
  const toast = useToast();

  const [loading, setLoading] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [lines, setLines] = useState<CheckoutGitBlameLine[]>([]);
  const [hoveredSha, setHoveredSha] = useState<string | null>(null);

  const loadBlame = useCallback(async () => {
    if (!client || !cwd || !resolvedFilePath || !isVisible) return;
    setLoading(true);
    setErrorMsg(null);
    try {
      const response = await client.getGitBlame(cwd, resolvedFilePath);
      const blameLines = Array.isArray(response) ? response : (response?.blameLines ?? []);
      setLines(blameLines);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to load git blame");
    } finally {
      setLoading(false);
    }
  }, [client, cwd, isVisible, resolvedFilePath]);

  useEffect(() => {
    if (isVisible) {
      void loadBlame();
    }
  }, [isVisible, loadBlame]);

  useEffect(() => {
    if (!isWeb || !isVisible || typeof window === "undefined") return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isVisible, onClose]);

  const hoveredCommitSummary = useMemo(() => {
    if (!hoveredSha) return null;
    return lines.find((l) => l.sha === hoveredSha) ?? null;
  }, [hoveredSha, lines]);

  if (!isVisible) return null;

  const modalContent = (
    <View style={styles.backdrop} testID="git-blame-modal-backdrop">
      <View style={styles.modalWindow} testID="git-blame-modal">
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <FileCode2 size={15} color="#10b981" />
            <Text style={styles.headerTitle}>Git Annotate (Blame)</Text>
            <View style={styles.pathBadge}>
              <Text style={styles.pathBadgeText} numberOfLines={1}>
                {resolvedFilePath}
              </Text>
            </View>
          </View>

          <View style={styles.headerActions}>
            {onOpenFileHistory ? (
              <Pressable
                style={styles.actionBtn}
                onPress={() => {
                  onClose();
                  onOpenFileHistory(resolvedFilePath);
                }}
              >
                <History size={13} color="#06b6d4" />
                <Text style={styles.actionBtnText}>File History</Text>
              </Pressable>
            ) : null}
            <Pressable style={styles.actionBtn} onPress={() => void loadBlame()} disabled={loading}>
              <RefreshCw size={13} color={theme.colors.foreground} />
              <Text style={styles.actionBtnText}>Refresh</Text>
            </Pressable>
            <Pressable style={styles.closeBtn} onPress={onClose}>
              <X size={16} color={theme.colors.foregroundMuted} />
            </Pressable>
          </View>
        </View>

        {hoveredCommitSummary ? (
          <View style={styles.commitTooltipBar}>
            <GitCommitHorizontal size={13} color="#10b981" />
            <Text style={styles.tooltipSha}>{hoveredCommitSummary.shortSha}</Text>
            <Text style={styles.tooltipAuthor}>{hoveredCommitSummary.author}</Text>
            <Text style={styles.tooltipDate}>{formatBlameFullDate(hoveredCommitSummary)}</Text>
            <Text style={styles.tooltipSummary} numberOfLines={1}>
              {hoveredCommitSummary.summary}
            </Text>
          </View>
        ) : null}

        {errorMsg ? (
          <View style={styles.centerBox}>
            <Text style={styles.errorText}>{errorMsg}</Text>
          </View>
        ) : loading ? (
          <View style={styles.centerBox}>
            <Text style={styles.mutedText}>Annotating {resolvedFilePath}...</Text>
          </View>
        ) : lines.length === 0 ? (
          <View style={styles.centerBox}>
            <Text style={styles.mutedText}>No blame data available for this file.</Text>
          </View>
        ) : (
          <ScrollView style={styles.scrollArea} showsVerticalScrollIndicator>
            {lines.map((line, idx) => {
              const prevLine = idx > 0 ? lines[idx - 1] : null;
              const isSameBlockAsPrev = prevLine?.sha === line.sha;
              const accentColor = hashShaToColor(line.sha);
              const isHighlighted = hoveredSha === line.sha;

              return (
                <View
                  key={`blame-${line.lineNumber}`}
                  style={[
                    styles.blameRow,
                    isHighlighted && styles.blameRowHighlighted,
                    !isSameBlockAsPrev && idx > 0 && styles.blameBlockTopBorder,
                  ]}
                >
                  <Pressable
                    style={[styles.blameGutter, { borderLeftColor: accentColor }]}
                    onHoverIn={() => setHoveredSha(line.sha)}
                    onPress={async () => {
                      setHoveredSha(line.sha);
                      const commitHandler = onInspectCommit ?? onSelectCommit;
                      if (commitHandler) {
                        commitHandler(line.sha);
                      } else {
                        await Clipboard.setStringAsync(line.sha);
                        toast.show(`Copied ${line.shortSha}: ${line.summary}`);
                      }
                    }}
                  >
                    <Text style={[styles.gutterSha, { color: accentColor }]}>
                      {isSameBlockAsPrev ? "⋮" : line.shortSha}
                    </Text>
                    <Text style={styles.gutterAuthor} numberOfLines={1}>
                      {isSameBlockAsPrev ? "" : line.author}
                    </Text>
                    <Text style={styles.gutterDate}>
                      {isSameBlockAsPrev ? "" : formatBlameShortDate(line)}
                    </Text>
                  </Pressable>

                  <Text style={styles.lineNum}>{line.lineNumber}</Text>
                  <Text style={styles.codeContent}>{line.content}</Text>
                </View>
              );
            })}
          </ScrollView>
        )}
      </View>
    </View>
  );

  if (isWeb && typeof document !== "undefined" && document.body) {
    return createPortal(modalContent, document.body);
  }

  return <Portal>{modalContent}</Portal>;
}

const styles = StyleSheet.create((theme) => ({
  backdrop: {
    position: isWeb ? ("fixed" as unknown as "absolute") : "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0, 0, 0, 0.72)",
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[4],
    zIndex: 100010,
  },
  modalWindow: {
    width: "100%",
    maxWidth: 1260,
    height: "88%",
    backgroundColor: theme.colors.surface0,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    overflow: "hidden",
    flexDirection: "column",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    backgroundColor: theme.colors.surface1,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flex: 1,
    minWidth: 0,
  },
  headerTitle: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  pathBadge: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: "rgba(16, 185, 129, 0.14)",
    maxWidth: 420,
  },
  pathBadgeText: {
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
    color: "#10b981",
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  actionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 5,
    borderRadius: theme.borderRadius.base,
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  actionBtnText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  closeBtn: {
    padding: 5,
  },
  commitTooltipBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: 6,
    backgroundColor: theme.colors.surface2,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  tooltipSha: {
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
    color: "#10b981",
  },
  tooltipAuthor: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  tooltipDate: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  tooltipSummary: {
    flex: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  scrollArea: {
    flex: 1,
  },
  blameRow: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 20,
  },
  blameRowHighlighted: {
    backgroundColor: "rgba(16, 185, 129, 0.11)",
  },
  blameBlockTopBorder: {
    borderTopWidth: 1,
    borderTopColor: "rgba(148, 163, 184, 0.12)",
  },
  blameGutter: {
    width: 240,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 2,
    backgroundColor: theme.colors.surface1,
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
    borderLeftWidth: 3,
    flexShrink: 0,
  },
  gutterSha: {
    width: 54,
    fontSize: 10,
    fontFamily: theme.fontFamily.mono,
  },
  gutterAuthor: {
    flex: 1,
    fontSize: 10,
    color: theme.colors.foregroundMuted,
  },
  gutterDate: {
    width: 66,
    fontSize: 10,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foregroundMuted,
    textAlign: "right",
  },
  lineNum: {
    width: 44,
    fontSize: 10,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foregroundMuted,
    textAlign: "right",
    paddingRight: 8,
    flexShrink: 0,
  },
  codeContent: {
    flex: 1,
    fontSize: 11,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foreground,
  },
  centerBox: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[4],
  },
  mutedText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  errorText: {
    fontSize: theme.fontSize.sm,
    color: "#f43f5e",
  },
}));
