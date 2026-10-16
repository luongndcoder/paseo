import type { ParsedDiffFile } from "@getpaseo/protocol/messages";
import { Columns2, Lock, Plus, RotateCcw, Rows2 } from "lucide-react-native";
import { useMemo } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet, UnistylesRuntime } from "react-native-unistyles";

export type ParsedDiffHunk = ParsedDiffFile["hunks"][number] & {
  header?: string;
};

export type ParsedDiffLine = ParsedDiffFile["hunks"][number]["lines"][number] & {
  oldLineNumber?: number | null;
  newLineNumber?: number | null;
};

export interface NumberedDiffLineItem {
  type: "add" | "remove" | "context";
  content: string;
  oldLineNumber: number | null;
  newLineNumber: number | null;
  tokens?: ParsedDiffLine["tokens"];
}

export interface SplitAlignedRow {
  left: NumberedDiffLineItem | null;
  right: NumberedDiffLineItem | null;
}

export interface SplitDiffViewerProps {
  file: ParsedDiffFile | null;
  mode: "unified" | "split";
  onModeChange?: (mode: "unified" | "split") => void;
  enableHunkActions?: boolean;
  onRollbackHunk?: (file: ParsedDiffFile, hunk: ParsedDiffHunk, patch: string) => void;
  onStageHunk?: (file: ParsedDiffFile, hunk: ParsedDiffHunk, patch: string) => void;
  hunkActionBusy?: boolean;
  leftRevisionLabel?: string;
  rightRevisionLabel?: string;
  fullHeight?: boolean;
  activeHunkIndex?: number | null;
}

export function resolveHunkHeader(hunk: ParsedDiffHunk): string {
  if (typeof hunk.header === "string" && hunk.header.trim().length > 0) {
    return hunk.header.trim();
  }
  const headerLine = hunk.lines.find((line) => line.type === "header");
  if (headerLine && headerLine.content.trim().length > 0) {
    return headerLine.content.trim();
  }
  return `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`;
}

/**
 * Constructs a valid git unified diff patch for a single hunk so
 * `git apply --unidiff-zero` (or `--cached` / `-R`) can apply or reverse it.
 */
export function buildSingleHunkPatch(file: ParsedDiffFile, hunk: ParsedDiffHunk): string {
  const oldPath = file.oldPath || file.path;
  const newPath = file.path;
  const header = resolveHunkHeader(hunk);
  const headerLines = [
    `diff --git a/${oldPath} b/${newPath}`,
    `--- a/${oldPath}`,
    `+++ b/${newPath}`,
    header,
  ];
  const bodyLines = hunk.lines
    .filter((line) => line.type !== "header")
    .map((line) => {
      const prefix = line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";
      return `${prefix}${line.content}`;
    });
  return [...headerLines, ...bodyLines, ""].join("\n");
}

export function numberHunkLines(hunk: ParsedDiffHunk): NumberedDiffLineItem[] {
  let oldLineNo = hunk.oldStart ?? 1;
  let newLineNo = hunk.newStart ?? 1;
  const result: NumberedDiffLineItem[] = [];

  for (const rawLine of hunk.lines as ParsedDiffLine[]) {
    if (rawLine.type === "header") {
      continue;
    }

    if (rawLine.type === "remove") {
      const oldNum = rawLine.oldLineNumber ?? oldLineNo;
      oldLineNo = oldNum + 1;
      result.push({
        type: "remove",
        content: rawLine.content,
        oldLineNumber: oldNum,
        newLineNumber: null,
        tokens: rawLine.tokens,
      });
    } else if (rawLine.type === "add") {
      const newNum = rawLine.newLineNumber ?? newLineNo;
      newLineNo = newNum + 1;
      result.push({
        type: "add",
        content: rawLine.content,
        oldLineNumber: null,
        newLineNumber: newNum,
        tokens: rawLine.tokens,
      });
    } else {
      const oldNum = rawLine.oldLineNumber ?? oldLineNo;
      const newNum = rawLine.newLineNumber ?? newLineNo;
      oldLineNo = oldNum + 1;
      newLineNo = newNum + 1;
      result.push({
        type: "context",
        content: rawLine.content,
        oldLineNumber: oldNum,
        newLineNumber: newNum,
        tokens: rawLine.tokens,
      });
    }
  }

  return result;
}

/**
 * Zips consecutive `remove` (-) and `add` (+) blocks into side-by-side rows
 * while emitting `context` lines across both left and right columns.
 */
export function alignHunkLinesSideBySide(hunk: ParsedDiffHunk): SplitAlignedRow[] {
  const numbered = numberHunkLines(hunk);
  const rows: SplitAlignedRow[] = [];
  let pendingRemoves: NumberedDiffLineItem[] = [];
  let pendingAdds: NumberedDiffLineItem[] = [];

  const flushPending = () => {
    if (pendingRemoves.length === 0 && pendingAdds.length === 0) return;
    const count = Math.max(pendingRemoves.length, pendingAdds.length);
    for (let i = 0; i < count; i++) {
      rows.push({
        left: pendingRemoves[i] ?? null,
        right: pendingAdds[i] ?? null,
      });
    }
    pendingRemoves = [];
    pendingAdds = [];
  };

  for (const line of numbered) {
    if (line.type === "remove") {
      if (pendingAdds.length > 0) {
        flushPending();
      }
      pendingRemoves.push(line);
    } else if (line.type === "add") {
      pendingAdds.push(line);
    } else {
      flushPending();
      rows.push({
        left: line,
        right: line,
      });
    }
  }

  flushPending();
  return rows;
}

export function SplitDiffViewer({
  file,
  mode,
  onModeChange,
  enableHunkActions = false,
  onRollbackHunk,
  onStageHunk,
  hunkActionBusy = false,
  leftRevisionLabel,
  rightRevisionLabel,
  fullHeight = false,
  activeHunkIndex = null,
}: SplitDiffViewerProps) {
  const theme = UnistylesRuntime.getTheme();

  const preparedHunks = useMemo(() => {
    if (!file || !file.hunks) return [];
    return file.hunks.map((rawHunk, idx) => {
      const hunk = rawHunk as ParsedDiffHunk;
      const header = resolveHunkHeader(hunk);
      const unifiedLines = numberHunkLines(hunk);
      const splitRows = alignHunkLinesSideBySide(hunk);
      return {
        key: `hunk-${idx}-${hunk.oldStart}-${hunk.newStart}`,
        hunk,
        header,
        unifiedLines,
        splitRows,
      };
    });
  }, [file]);

  if (!file) {
    return (
      <View style={styles.emptyBox} testID="split-diff-viewer-empty">
        <Text style={styles.emptyText}>Select a file to inspect its diff.</Text>
      </View>
    );
  }

  const resolvedLeftLabel = leftRevisionLabel || `Base (${file.oldPath || file.path})`;
  const resolvedRightLabel = rightRevisionLabel || `Revision (${file.path})`;

  return (
    <View
      style={[styles.container, fullHeight && styles.containerFullHeight]}
      testID="split-diff-viewer"
    >
      {/* Top Mode & Stats Toolbar (shown when not embedded in custom Repository Diff header, or always for quick toggle) */}
      {onModeChange ? (
        <View style={styles.toolbar}>
          <View style={styles.toolbarLeft}>
            <Text style={styles.filePathText} numberOfLines={1}>
              {file.oldPath && file.oldPath !== file.path
                ? `${file.oldPath} → ${file.path}`
                : file.path}
            </Text>
            <View style={styles.statsRow}>
              <View style={styles.statAddBadge}>
                <Text style={styles.statAddText}>+{file.additions}</Text>
              </View>
              <View style={styles.statDelBadge}>
                <Text style={styles.statDelText}>-{file.deletions}</Text>
              </View>
              <Text style={styles.diffCountText}>
                {preparedHunks.length} {preparedHunks.length === 1 ? "difference" : "differences"}
              </Text>
            </View>
          </View>

          <View style={styles.modeToggleGroup} testID="split-diff-mode-toggle">
            <Pressable
              testID="diff-mode-unified-btn"
              style={[styles.modePill, mode === "unified" && styles.modePillActive]}
              onPress={() => onModeChange("unified")}
            >
              <Rows2
                size={12}
                color={mode === "unified" ? "#10b981" : theme.colors.foregroundMuted}
              />
              <Text style={[styles.modePillText, mode === "unified" && styles.modePillTextActive]}>
                Unified
              </Text>
            </Pressable>

            <Pressable
              testID="diff-mode-split-btn"
              style={[styles.modePill, mode === "split" && styles.modePillActive]}
              onPress={() => onModeChange("split")}
            >
              <Columns2
                size={12}
                color={mode === "split" ? "#10b981" : theme.colors.foregroundMuted}
              />
              <Text style={[styles.modePillText, mode === "split" && styles.modePillTextActive]}>
                Side-by-Side
              </Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {/* NDL-Git Revision Path Bar (Left vs Right panes) */}
      {mode === "split" ? (
        <View style={styles.revisionSubHeaderRow}>
          <View style={[styles.revisionSubHeaderPane, styles.splitLeftBorder]}>
            <Lock size={11} color={theme.colors.foregroundMuted} />
            <Text style={styles.revisionSubHeaderText} numberOfLines={1}>
              {resolvedLeftLabel}
            </Text>
          </View>
          <View style={styles.revisionSubHeaderPane}>
            <Lock size={11} color={theme.colors.foregroundMuted} />
            <Text style={styles.revisionSubHeaderText} numberOfLines={1}>
              {resolvedRightLabel}
            </Text>
          </View>
        </View>
      ) : null}

      {preparedHunks.length === 0 ? (
        <View style={styles.emptyBox}>
          <Text style={styles.emptyText}>
            {file.status === "binary"
              ? "Binary file changed — no textual diff hunks."
              : "No textual hunks to display."}
          </Text>
        </View>
      ) : (
        <ScrollView
          style={[styles.hunksScroll, fullHeight && styles.hunksScrollFull]}
          nestedScrollEnabled
        >
          {preparedHunks.map(({ key, hunk, header, unifiedLines, splitRows }, hIdx) => {
            const isHighlightedHunk = activeHunkIndex === hIdx;
            return (
              <View
                key={key}
                style={[styles.hunkCard, isHighlightedHunk && styles.hunkCardHighlighted]}
                testID={`diff-hunk-${hIdx}`}
              >
                {/* Hunk Separator / Action Bar */}
                <View style={styles.hunkHeaderBar}>
                  <Text style={styles.hunkHeaderText} numberOfLines={1}>
                    {header}
                  </Text>

                  {enableHunkActions ? (
                    <View style={styles.hunkActionsRow}>
                      {onStageHunk ? (
                        <Pressable
                          testID={`stage-hunk-btn-${hIdx}`}
                          disabled={hunkActionBusy}
                          style={({ pressed }) => [
                            styles.stageHunkBtn,
                            (pressed || hunkActionBusy) && styles.btnDimmed,
                          ]}
                          onPress={() => {
                            const patch = buildSingleHunkPatch(file, hunk);
                            onStageHunk(file, hunk, patch);
                          }}
                        >
                          <Plus size={11} color="#10b981" />
                          <Text style={styles.stageHunkBtnText}>+ Stage Hunk</Text>
                        </Pressable>
                      ) : null}

                      {onRollbackHunk ? (
                        <Pressable
                          testID={`rollback-hunk-btn-${hIdx}`}
                          disabled={hunkActionBusy}
                          style={({ pressed }) => [
                            styles.rollbackHunkBtn,
                            (pressed || hunkActionBusy) && styles.btnDimmed,
                          ]}
                          onPress={() => {
                            const patch = buildSingleHunkPatch(file, hunk);
                            onRollbackHunk(file, hunk, patch);
                          }}
                        >
                          <RotateCcw size={11} color="#f43f5e" />
                          <Text style={styles.rollbackHunkBtnText}>↺ Rollback Hunk</Text>
                        </Pressable>
                      ) : null}
                    </View>
                  ) : null}
                </View>

                {/* Hunk Body: Unified or NDL-Git Side-by-Side (Split) */}
                {mode === "unified" ? (
                  <View style={styles.unifiedBody}>
                    {unifiedLines.slice(0, 400).map((line, lIdx) => {
                      const prefix = line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";
                      return (
                        <View
                          key={`u-${hIdx}-${lIdx}`}
                          style={[
                            styles.unifiedRow,
                            line.type === "add" && styles.rowAddBg,
                            line.type === "remove" && styles.rowRemoveBg,
                          ]}
                        >
                          <Text style={styles.lineNumberCell}>{line.oldLineNumber ?? ""}</Text>
                          <Text style={styles.lineNumberCell}>{line.newLineNumber ?? ""}</Text>
                          <Text
                            style={[
                              styles.prefixCell,
                              line.type === "add" && styles.textAddMarker,
                              line.type === "remove" && styles.textRemoveMarker,
                            ]}
                          >
                            {prefix}
                          </Text>
                          <Text
                            style={[
                              styles.codeCell,
                              line.type === "add" && styles.textAddCode,
                              line.type === "remove" && styles.textRemoveCode,
                            ]}
                          >
                            {line.content}
                          </Text>
                        </View>
                      );
                    })}
                  </View>
                ) : (
                  <View style={styles.splitBody} testID={`split-hunk-body-${hIdx}`}>
                    {splitRows.slice(0, 400).map((pair, rIdx) => {
                      const left = pair.left;
                      const right = pair.right;
                      const isChangedPair = left?.type === "remove" || right?.type === "add";
                      const connectorColor =
                        left?.type === "remove" && right?.type === "add"
                          ? "#06b6d4"
                          : right?.type === "add"
                            ? "#10b981"
                            : left?.type === "remove"
                              ? "#f43f5e"
                              : "transparent";

                      return (
                        <View key={`s-${hIdx}-${rIdx}`} style={styles.splitPairRow}>
                          {/* Left Code Pane */}
                          <View
                            style={[
                              styles.splitHalfPane,
                              left === null && styles.splitEmptyCellBg,
                              left?.type === "remove" && styles.rowRemoveBg,
                            ]}
                          >
                            <Text style={styles.lineNumberGutterLeft}>
                              {left?.oldLineNumber ?? ""}
                            </Text>
                            <Text
                              style={[
                                styles.codeCell,
                                left?.type === "remove" && styles.textRemoveCode,
                              ]}
                            >
                              {left?.content ?? ""}
                            </Text>
                          </View>

                          {/* NDL-Git Center Dual Line-Number & Connector Gutter */}
                          <View
                            style={[
                              styles.centerBridgeGutter,
                              isChangedPair && styles.centerBridgeGutterActive,
                            ]}
                          >
                            <Text
                              style={[
                                styles.centerBridgeLineNum,
                                left?.type === "remove" && styles.textRemoveMarker,
                              ]}
                            >
                              {left?.oldLineNumber ?? ""}
                            </Text>
                            <View
                              style={[styles.centerBridgeBar, { backgroundColor: connectorColor }]}
                            />
                            <Text
                              style={[
                                styles.centerBridgeLineNum,
                                right?.type === "add" && styles.textAddMarker,
                              ]}
                            >
                              {right?.newLineNumber ?? ""}
                            </Text>
                          </View>

                          {/* Right Code Pane */}
                          <View
                            style={[
                              styles.splitHalfPane,
                              right === null && styles.splitEmptyCellBg,
                              right?.type === "add" && styles.rowAddBg,
                            ]}
                          >
                            <Text
                              style={[styles.codeCell, right?.type === "add" && styles.textAddCode]}
                            >
                              {right?.content ?? ""}
                            </Text>
                          </View>
                        </View>
                      );
                    })}
                  </View>
                )}
              </View>
            );
          })}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: "column",
    gap: 6,
  },
  containerFullHeight: {
    flex: 1,
    minHeight: 0,
  },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: 6,
    backgroundColor: theme.colors.surface1,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  toolbarLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flex: 1,
    minWidth: 0,
  },
  filePathText: {
    flexShrink: 1,
    fontSize: 12,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
  },
  statsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  statAddBadge: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: "rgba(16, 185, 129, 0.14)",
    borderWidth: 1,
    borderColor: "rgba(16, 185, 129, 0.35)",
  },
  statAddText: {
    fontSize: 10,
    fontFamily: theme.fontFamily.mono,
    fontWeight: theme.fontWeight.semibold,
    color: "#10b981",
  },
  statDelBadge: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: "rgba(244, 63, 94, 0.14)",
    borderWidth: 1,
    borderColor: "rgba(244, 63, 94, 0.35)",
  },
  statDelText: {
    fontSize: 10,
    fontFamily: theme.fontFamily.mono,
    fontWeight: theme.fontWeight.semibold,
    color: "#f43f5e",
  },
  diffCountText: {
    fontSize: 11,
    color: theme.colors.foregroundMuted,
    marginLeft: 4,
  },
  modeToggleGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    padding: 2,
    borderRadius: theme.borderRadius.base,
    backgroundColor: theme.colors.surface0,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  modePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: theme.borderRadius.sm,
  },
  modePillActive: {
    backgroundColor: "rgba(16, 185, 129, 0.16)",
    borderWidth: 1,
    borderColor: "rgba(16, 185, 129, 0.4)",
  },
  modePillText: {
    fontSize: 11,
    color: theme.colors.foregroundMuted,
  },
  modePillTextActive: {
    color: "#10b981",
    fontWeight: theme.fontWeight.semibold,
  },
  revisionSubHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: theme.colors.surface1,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  revisionSubHeaderPane: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    minWidth: 0,
  },
  revisionSubHeaderText: {
    flex: 1,
    fontSize: 11,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foregroundMuted,
  },
  hunksScroll: {
    maxHeight: 540,
  },
  hunksScrollFull: {
    flex: 1,
    maxHeight: 99999,
  },
  hunkCard: {
    marginBottom: 8,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    overflow: "hidden",
  },
  hunkCardHighlighted: {
    borderColor: "#06b6d4",
  },
  hunkHeaderBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: theme.colors.surface2,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  hunkHeaderText: {
    flex: 1,
    fontSize: 11,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foregroundMuted,
  },
  hunkActionsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  stageHunkBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: "rgba(16, 185, 129, 0.14)",
    borderWidth: 1,
    borderColor: "#10b981",
  },
  stageHunkBtnText: {
    fontSize: 10,
    fontFamily: theme.fontFamily.mono,
    fontWeight: theme.fontWeight.semibold,
    color: "#10b981",
  },
  rollbackHunkBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: "rgba(244, 63, 94, 0.14)",
    borderWidth: 1,
    borderColor: "#f43f5e",
  },
  rollbackHunkBtnText: {
    fontSize: 10,
    fontFamily: theme.fontFamily.mono,
    fontWeight: theme.fontWeight.semibold,
    color: "#f43f5e",
  },
  btnDimmed: {
    opacity: 0.6,
  },
  unifiedBody: {
    flexDirection: "column",
  },
  unifiedRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  splitBody: {
    flexDirection: "column",
  },
  splitPairRow: {
    flexDirection: "row",
    alignItems: "stretch",
    minHeight: 20,
  },
  splitHalfPane: {
    flex: 1,
    flexDirection: "row",
    alignItems: "flex-start",
    paddingHorizontal: 8,
    paddingVertical: 2,
    minWidth: 0,
  },
  splitLeftBorder: {
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
  },
  splitEmptyCellBg: {
    backgroundColor: theme.colors.surfaceDiffEmpty,
  },
  rowAddBg: {
    backgroundColor:
      theme.colorScheme === "dark" ? "rgba(27, 67, 50, 0.55)" : "rgba(22, 163, 74, 0.12)",
  },
  rowRemoveBg: {
    backgroundColor:
      theme.colorScheme === "dark" ? "rgba(69, 26, 38, 0.55)" : "rgba(220, 38, 38, 0.12)",
  },
  lineNumberGutterLeft: {
    width: 34,
    fontSize: 11,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foregroundExtraMuted,
    textAlign: "right",
    paddingRight: 8,
    flexShrink: 0,
  },
  centerBridgeGutter: {
    width: 78,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 6,
    backgroundColor: theme.colors.surface1,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: theme.colors.border,
    flexShrink: 0,
  },
  centerBridgeGutterActive: {
    backgroundColor: theme.colors.surface2,
  },
  centerBridgeLineNum: {
    width: 28,
    fontSize: 10,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foregroundExtraMuted,
    textAlign: "right",
  },
  centerBridgeBar: {
    width: 3,
    alignSelf: "stretch",
    borderRadius: 1,
    marginHorizontal: 4,
  },
  lineNumberCell: {
    width: 36,
    fontSize: 11,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foregroundExtraMuted,
    textAlign: "right",
    paddingRight: 6,
    flexShrink: 0,
  },
  prefixCell: {
    width: 14,
    fontSize: 11,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foregroundExtraMuted,
    flexShrink: 0,
  },
  codeCell: {
    flex: 1,
    fontSize: 12,
    lineHeight: 17,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foreground,
  },
  textAddMarker: {
    color: theme.colors.diffAddition,
    fontWeight: theme.fontWeight.semibold,
  },
  textRemoveMarker: {
    color: theme.colors.diffDeletion,
    fontWeight: theme.fontWeight.semibold,
  },
  textAddCode: {
    color: theme.colors.foreground,
  },
  textRemoveCode: {
    color: theme.colors.foreground,
  },
  emptyBox: {
    padding: theme.spacing[4],
    alignItems: "center",
    justifyContent: "center",
  },
  emptyText: {
    fontSize: 12,
    color: theme.colors.foregroundMuted,
  },
}));
