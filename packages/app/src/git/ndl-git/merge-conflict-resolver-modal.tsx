import { Portal } from "@gorhom/portal";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  FileWarning,
  GitMerge,
  Play,
  RefreshCw,
  RotateCcw,
  Square,
  X,
} from "lucide-react-native";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { StyleSheet, UnistylesRuntime } from "react-native-unistyles";

import { isWeb } from "@/constants/platform";
import { useToast } from "@/contexts/toast-context";
import { invalidateCheckoutGitQueriesForClient } from "@/git/query-keys";
import { useHostRuntimeClient } from "@/runtime/host-runtime";

export interface CheckoutGitConflictFilePayload {
  cwd: string;
  path: string;
  baseContent: string | null;
  oursContent: string | null;
  theirsContent: string | null;
  workingContent: string | null;
  oursLabel: string;
  theirsLabel: string;
  error?: { code: string; message: string } | null;
}

export interface MergeConflictResolverModalProps {
  visible: boolean;
  onClose: () => void;
  serverId: string;
  cwd: string;
  conflictFiles: string[];
  inProgressOperation?: "merge" | "rebase" | "cherry-pick" | "conflict" | null;
  initialFilePath?: string | null;
  onResolved?: () => void;
}

export type ConflictResolutionChoice = "ours" | "theirs" | "both";

export type ConflictSegment =
  | {
      id: string;
      kind: "clean";
      text: string;
    }
  | {
      id: string;
      kind: "conflict";
      oursLabel: string;
      theirsLabel: string;
      oursText: string;
      theirsText: string;
      resolvedText?: string;
      resolution?: ConflictResolutionChoice;
    };

/**
 * Parses standard Git conflict markers (`<<<<<<< ...`, optional diff3 `||||||| ...`,
 * `=======`, `>>>>>>> ...`) into alternating clean and conflict segments.
 */
export function parseConflictBlocks(workingContent: string): ConflictSegment[] {
  if (!workingContent) {
    return [];
  }

  const lines = workingContent.split(/\r?\n/);
  const segments: ConflictSegment[] = [];

  let state: "clean" | "ours" | "base" | "theirs" = "clean";
  let cleanBuffer: string[] = [];
  let rawConflictBuffer: string[] = [];
  let oursLabel = "HEAD";
  let theirsLabel = "MERGE_HEAD";
  let oursLines: string[] = [];
  let theirsLines: string[] = [];
  let conflictIndex = 0;

  const flushClean = () => {
    if (cleanBuffer.length > 0) {
      segments.push({
        id: `clean-${segments.length}`,
        kind: "clean",
        text: cleanBuffer.join("\n"),
      });
      cleanBuffer = [];
    }
  };

  for (const line of lines) {
    if (state === "clean") {
      if (line.startsWith("<<<<<<<")) {
        flushClean();
        state = "ours";
        oursLabel = line.slice(7).trim() || "HEAD (Yours)";
        oursLines = [];
        theirsLines = [];
        rawConflictBuffer = [line];
      } else {
        cleanBuffer.push(line);
      }
      continue;
    }

    rawConflictBuffer.push(line);

    if (state === "ours") {
      if (line.startsWith("|||||||")) {
        state = "base";
      } else if (line.startsWith("=======")) {
        state = "theirs";
      } else {
        oursLines.push(line);
      }
      continue;
    }

    if (state === "base") {
      if (line.startsWith("=======")) {
        state = "theirs";
      }
      continue;
    }

    if (state === "theirs") {
      if (line.startsWith(">>>>>>>")) {
        theirsLabel = line.slice(7).trim() || "Incoming (Theirs)";
        conflictIndex += 1;
        segments.push({
          id: `conflict-${conflictIndex}`,
          kind: "conflict",
          oursLabel,
          theirsLabel,
          oursText: oursLines.join("\n"),
          theirsText: theirsLines.join("\n"),
        });
        state = "clean";
        rawConflictBuffer = [];
      } else {
        theirsLines.push(line);
      }
    }
  }

  // If an unclosed conflict marker was at the end of the file, preserve raw lines
  if (state !== "clean" && rawConflictBuffer.length > 0) {
    cleanBuffer.push(...rawConflictBuffer);
  }
  flushClean();

  return segments;
}

function formatConflictSegment(
  segment: Extract<ConflictSegment, { kind: "conflict" }>,
  resolution?: ConflictResolutionChoice,
): string {
  const effectiveResolution = resolution ?? segment.resolution;
  if (effectiveResolution === "ours") {
    return segment.oursText;
  }
  if (effectiveResolution === "theirs") {
    return segment.theirsText;
  }
  if (effectiveResolution === "both") {
    if (segment.oursText.length > 0 && segment.theirsText.length > 0) {
      return `${segment.oursText}\n${segment.theirsText}`;
    }
    return `${segment.oursText}${segment.theirsText}`;
  }
  return [
    `<<<<<<< ${segment.oursLabel}`,
    segment.oursText,
    "=======",
    segment.theirsText,
    `>>>>>>> ${segment.theirsLabel}`,
  ].join("\n");
}

/**
 * Replaces a single conflict block (`blockId`) in `workingContent` with `ours`, `theirs`, or `both`.
 */
export function applyConflictBlockResolution(
  workingContent: string,
  blockId: string,
  resolution: ConflictResolutionChoice,
): string {
  const segments = parseConflictBlocks(workingContent);
  return segments
    .map((segment) => {
      if (segment.kind === "clean") {
        return segment.text;
      }
      if (segment.id === blockId) {
        return formatConflictSegment(segment, resolution);
      }
      return formatConflictSegment(segment);
    })
    .join("\n");
}

/**
 * Replaces all conflict blocks in `workingContent` with `ours`, `theirs`, or `both`.
 */
export function applyAllConflictResolutions(
  workingContent: string,
  resolution: ConflictResolutionChoice,
): string {
  const segments = parseConflictBlocks(workingContent);
  return segments
    .map((segment) => {
      if (segment.kind === "clean") {
        return segment.text;
      }
      return formatConflictSegment(segment, resolution);
    })
    .join("\n");
}

export function countUnresolvedConflicts(content: string): number {
  return parseConflictBlocks(content).filter((seg) => seg.kind === "conflict").length;
}

function splitNumberedLines(text: string): { lineNumber: number; content: string }[] {
  if (!text) return [];
  return text.split(/\r?\n/).map((content, idx) => ({
    lineNumber: idx + 1,
    content,
  }));
}

export function MergeConflictResolverModal({
  visible,
  onClose,
  serverId,
  cwd,
  conflictFiles,
  inProgressOperation = null,
  initialFilePath = null,
  onResolved,
}: MergeConflictResolverModalProps) {
  const theme = UnistylesRuntime.getTheme();
  const client = useHostRuntimeClient(serverId);
  const queryClient = useQueryClient();
  const toast = useToast();

  const [selectedFile, setSelectedFile] = useState<string>(
    initialFilePath || conflictFiles[0] || "",
  );
  const [loading, setLoading] = useState<boolean>(false);
  const [actionBusy, setActionBusy] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [conflictData, setConflictData] = useState<CheckoutGitConflictFilePayload | null>(null);
  const [mergedContent, setMergedContent] = useState<string>("");

  useEffect(() => {
    if (!visible) return;
    if (initialFilePath && conflictFiles.includes(initialFilePath)) {
      setSelectedFile(initialFilePath);
    } else if (conflictFiles.length > 0 && !conflictFiles.includes(selectedFile)) {
      setSelectedFile(conflictFiles[0]);
    }
  }, [conflictFiles, initialFilePath, selectedFile, visible]);

  const loadConflictFile = useCallback(async () => {
    if (!client || !cwd || !selectedFile || !visible) return;
    setLoading(true);
    setErrorMsg(null);
    try {
      let payload: CheckoutGitConflictFilePayload | null = null;
      const runtimeClient = client as unknown as {
        getGitConflictFile?: (
          cwdPath: string,
          filePath: string,
        ) => Promise<
          | { conflictFile: CheckoutGitConflictFilePayload | null }
          | CheckoutGitConflictFilePayload
          | null
        >;
        queryGitGraphLog?: (
          cwdPath: string,
          opts: { conflictFilePath?: string; limit?: number },
        ) => Promise<{ conflictFile?: CheckoutGitConflictFilePayload | null }>;
      };

      if (typeof runtimeClient.getGitConflictFile === "function") {
        const res = await runtimeClient.getGitConflictFile(cwd, selectedFile);
        payload =
          res && typeof res === "object" && "conflictFile" in res
            ? (res.conflictFile ?? null)
            : (res ?? null);
      } else if (typeof runtimeClient.queryGitGraphLog === "function") {
        const res = await runtimeClient.queryGitGraphLog(cwd, {
          conflictFilePath: selectedFile,
          limit: 1,
        });
        payload = res?.conflictFile ?? null;
      }

      if (payload) {
        setConflictData(payload);
        setMergedContent(payload.workingContent ?? "");
      } else {
        setConflictData(null);
        setMergedContent("");
        setErrorMsg(`No 3-way conflict data available for ${selectedFile}`);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to load conflict file");
    } finally {
      setLoading(false);
    }
  }, [client, cwd, selectedFile, visible]);

  useEffect(() => {
    if (visible && selectedFile) {
      void loadConflictFile();
    }
  }, [loadConflictFile, selectedFile, visible]);

  useEffect(() => {
    if (!isWeb || !visible || typeof window === "undefined") return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, visible]);

  const activeConflicts = useMemo(() => {
    return parseConflictBlocks(mergedContent).filter(
      (seg): seg is Extract<ConflictSegment, { kind: "conflict" }> => seg.kind === "conflict",
    );
  }, [mergedContent]);

  const oursLines = useMemo(
    () => splitNumberedLines(conflictData?.oursContent ?? ""),
    [conflictData?.oursContent],
  );

  const theirsLines = useMemo(
    () => splitNumberedLines(conflictData?.theirsContent ?? ""),
    [conflictData?.theirsContent],
  );

  const operationBadgeText = useMemo(() => {
    switch (inProgressOperation) {
      case "merge":
        return "MERGE IN PROGRESS";
      case "rebase":
        return "REBASE IN PROGRESS";
      case "cherry-pick":
        return "CHERRY-PICK IN PROGRESS";
      default:
        return "CONFLICT IN PROGRESS";
    }
  }, [inProgressOperation]);

  const handleResolveBlock = useCallback(
    (blockId: string, resolution: ConflictResolutionChoice) => {
      setMergedContent((prev) => applyConflictBlockResolution(prev, blockId, resolution));
    },
    [],
  );

  const handleAcceptAllYours = useCallback(() => {
    if (!conflictData) return;
    const ours = conflictData.oursContent ?? "";
    const working = conflictData.workingContent ?? "";
    if (ours.length > 0 && countUnresolvedConflicts(working) === 0) {
      setMergedContent(ours);
      return;
    }
    setMergedContent((prev) => {
      const hasBlocks = countUnresolvedConflicts(prev) > 0;
      if (hasBlocks) {
        return applyAllConflictResolutions(prev, "ours");
      }
      if (working && countUnresolvedConflicts(working) > 0) {
        return applyAllConflictResolutions(working, "ours");
      }
      return ours || prev;
    });
  }, [conflictData]);

  const handleAcceptAllTheirs = useCallback(() => {
    if (!conflictData) return;
    const theirs = conflictData.theirsContent ?? "";
    const working = conflictData.workingContent ?? "";
    if (theirs.length > 0 && countUnresolvedConflicts(working) === 0) {
      setMergedContent(theirs);
      return;
    }
    setMergedContent((prev) => {
      const hasBlocks = countUnresolvedConflicts(prev) > 0;
      if (hasBlocks) {
        return applyAllConflictResolutions(prev, "theirs");
      }
      if (working && countUnresolvedConflicts(working) > 0) {
        return applyAllConflictResolutions(working, "theirs");
      }
      return theirs || prev;
    });
  }, [conflictData]);

  const handleResetToWorking = useCallback(() => {
    if (!conflictData) return;
    setMergedContent(conflictData.workingContent ?? "");
  }, [conflictData]);

  const handleSaveAndMarkResolved = useCallback(async () => {
    if (!client || !cwd || !selectedFile || actionBusy) return;
    setActionBusy(true);
    try {
      const res = await (client as any).runGitLogAction(cwd, {
        kind: "resolve-conflict",
        target: selectedFile,
        content: mergedContent,
      });
      toast.show(res?.message || `Resolved and staged ${selectedFile}`);
      await invalidateCheckoutGitQueriesForClient(queryClient, { serverId, cwd });
      onResolved?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save resolved file");
    } finally {
      setActionBusy(false);
    }
  }, [
    actionBusy,
    client,
    cwd,
    mergedContent,
    onResolved,
    queryClient,
    selectedFile,
    serverId,
    toast,
  ]);

  const handleContinueOperation = useCallback(async () => {
    if (!client || !cwd || actionBusy) return;
    setActionBusy(true);
    try {
      const res = await (client as any).runGitLogAction(cwd, {
        kind: "continue-operation",
        target: "auto",
      });
      toast.show(res?.message || "Continued Git operation");
      await invalidateCheckoutGitQueriesForClient(queryClient, { serverId, cwd });
      onResolved?.();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to continue operation");
    } finally {
      setActionBusy(false);
    }
  }, [actionBusy, client, cwd, onClose, onResolved, queryClient, serverId, toast]);

  const handleAbortOperation = useCallback(async () => {
    if (!client || !cwd || actionBusy) return;
    setActionBusy(true);
    try {
      const res = await (client as any).runGitLogAction(cwd, {
        kind: "abort-operation",
        target: "auto",
      });
      toast.show(res?.message || "Aborted Git operation");
      await invalidateCheckoutGitQueriesForClient(queryClient, { serverId, cwd });
      onResolved?.();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to abort operation");
    } finally {
      setActionBusy(false);
    }
  }, [actionBusy, client, cwd, onClose, onResolved, queryClient, serverId, toast]);

  if (!visible) return null;

  const modalContent = (
    <View style={styles.backdrop} testID="merge-conflict-resolver-backdrop">
      <View style={styles.modalWindow} testID="merge-conflict-resolver-modal">
        {/* Top Header */}
        <View style={styles.topHeader}>
          <View style={styles.topHeaderLeft}>
            <GitMerge size={16} color="#f59e0b" />
            <Text style={styles.modalTitle}>3-Way Merge Conflict Resolver</Text>

            <View style={styles.operationBadge} testID="conflict-operation-badge">
              <AlertTriangle size={11} color="#f59e0b" />
              <Text style={styles.operationBadgeText}>{operationBadgeText}</Text>
            </View>

            <View
              style={[
                styles.counterBadge,
                activeConflicts.length === 0
                  ? styles.counterBadgeResolved
                  : styles.counterBadgePending,
              ]}
              testID="conflict-counter-badge"
            >
              <Text
                style={[
                  styles.counterBadgeText,
                  activeConflicts.length === 0
                    ? styles.counterTextResolved
                    : styles.counterTextPending,
                ]}
              >
                {activeConflicts.length === 0
                  ? "0 conflicts remaining"
                  : `${activeConflicts.length} unresolved ${
                      activeConflicts.length === 1 ? "block" : "blocks"
                    }`}
              </Text>
            </View>
          </View>

          <View style={styles.topHeaderActions}>
            <Pressable
              testID="continue-operation-btn"
              disabled={actionBusy}
              style={({ pressed }) => [
                styles.continueBtn,
                (pressed || actionBusy) && styles.btnDimmed,
              ]}
              onPress={() => void handleContinueOperation()}
            >
              <Play size={12} color="#0f172a" />
              <Text style={styles.continueBtnText}>Continue Merge/Rebase</Text>
            </Pressable>

            <Pressable
              testID="abort-operation-btn"
              disabled={actionBusy}
              style={({ pressed }) => [
                styles.abortBtn,
                (pressed || actionBusy) && styles.btnDimmed,
              ]}
              onPress={() => void handleAbortOperation()}
            >
              <Square size={12} color="#f43f5e" />
              <Text style={styles.abortBtnText}>Abort Merge/Rebase</Text>
            </Pressable>

            <Pressable
              style={styles.iconBtn}
              disabled={loading}
              onPress={() => void loadConflictFile()}
            >
              <RefreshCw size={14} color={theme.colors.foreground} />
            </Pressable>

            <Pressable
              testID="close-conflict-resolver-btn"
              style={styles.iconBtn}
              onPress={onClose}
            >
              <X size={16} color={theme.colors.foregroundMuted} />
            </Pressable>
          </View>
        </View>

        {/* File Selector Bar + Whole-File Quick Actions */}
        <View style={styles.subToolbar}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.filePillsScroll}
            contentContainerStyle={styles.filePillsContainer}
          >
            {(conflictFiles.length > 0 ? conflictFiles : selectedFile ? [selectedFile] : []).map(
              (filePath) => {
                const isActive = filePath === selectedFile;
                return (
                  <Pressable
                    key={filePath}
                    testID={`conflict-file-pill-${filePath}`}
                    style={[styles.filePill, isActive && styles.filePillActive]}
                    onPress={() => setSelectedFile(filePath)}
                  >
                    <FileWarning
                      size={12}
                      color={isActive ? "#f59e0b" : theme.colors.foregroundMuted}
                    />
                    <Text
                      style={[styles.filePillText, isActive && styles.filePillTextActive]}
                      numberOfLines={1}
                    >
                      {filePath}
                    </Text>
                  </Pressable>
                );
              },
            )}
          </ScrollView>

          <View style={styles.wholeFileActions}>
            <Pressable
              testID="accept-all-yours-btn"
              style={({ pressed }) => [styles.wholeActionOursBtn, pressed && styles.btnDimmed]}
              onPress={handleAcceptAllYours}
            >
              <Text style={styles.wholeActionOursText}>Accept All Yours</Text>
              <ArrowRight size={11} color="#10b981" />
            </Pressable>

            <Pressable
              testID="accept-all-theirs-btn"
              style={({ pressed }) => [styles.wholeActionTheirsBtn, pressed && styles.btnDimmed]}
              onPress={handleAcceptAllTheirs}
            >
              <ArrowLeft size={11} color="#06b6d4" />
              <Text style={styles.wholeActionTheirsText}>Accept All Theirs</Text>
            </Pressable>

            <Pressable
              testID="reset-working-conflict-btn"
              style={({ pressed }) => [styles.wholeActionResetBtn, pressed && styles.btnDimmed]}
              onPress={handleResetToWorking}
            >
              <RotateCcw size={11} color={theme.colors.foregroundMuted} />
              <Text style={styles.wholeActionResetText}>Reset to Working Conflict</Text>
            </Pressable>
          </View>
        </View>

        {/* Interactive Conflict Blocks Bar */}
        {activeConflicts.length > 0 ? (
          <View style={styles.conflictBlocksSection} testID="interactive-conflict-blocks-bar">
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.conflictBlocksRow}
            >
              {activeConflicts.map((block, idx) => {
                const oursPreview = block.oursText.split(/\r?\n/)[0]?.trim() || "(empty)";
                const theirsPreview = block.theirsText.split(/\r?\n/)[0]?.trim() || "(empty)";

                return (
                  <View
                    key={block.id}
                    style={styles.conflictBlockCard}
                    testID={`conflict-block-card-${idx + 1}`}
                  >
                    <View style={styles.conflictBlockHeader}>
                      <Text style={styles.conflictBlockBadge}>Conflict #{idx + 1}</Text>
                      <Text style={styles.conflictBlockPreview} numberOfLines={1}>
                        {oursPreview} ⇄ {theirsPreview}
                      </Text>
                    </View>

                    <View style={styles.conflictBlockBtnRow}>
                      <Pressable
                        testID={`accept-yours-btn-${idx + 1}`}
                        style={({ pressed }) => [styles.blockBtnOurs, pressed && styles.btnDimmed]}
                        onPress={() => handleResolveBlock(block.id, "ours")}
                      >
                        <Text style={styles.blockBtnOursText}>Accept Yours &gt;&gt;</Text>
                      </Pressable>

                      <Pressable
                        testID={`accept-theirs-btn-${idx + 1}`}
                        style={({ pressed }) => [
                          styles.blockBtnTheirs,
                          pressed && styles.btnDimmed,
                        ]}
                        onPress={() => handleResolveBlock(block.id, "theirs")}
                      >
                        <Text style={styles.blockBtnTheirsText}>&lt;&lt; Accept Theirs</Text>
                      </Pressable>

                      <Pressable
                        testID={`accept-both-btn-${idx + 1}`}
                        style={({ pressed }) => [styles.blockBtnBoth, pressed && styles.btnDimmed]}
                        onPress={() => handleResolveBlock(block.id, "both")}
                      >
                        <Text style={styles.blockBtnBothText}>Accept Both</Text>
                      </Pressable>
                    </View>
                  </View>
                );
              })}
            </ScrollView>
          </View>
        ) : null}

        {/* 3 Side-by-Side Panes */}
        {errorMsg ? (
          <View style={styles.centerBox}>
            <Text style={styles.errorText}>{errorMsg}</Text>
          </View>
        ) : loading ? (
          <View style={styles.centerBox}>
            <Text style={styles.mutedText}>
              Loading 3-way conflict versions for {selectedFile}...
            </Text>
          </View>
        ) : (
          <View style={styles.threePanesContainer}>
            {/* Left Pane: Local / Yours */}
            <View style={[styles.sidePane, styles.paneRightBorder]} testID="conflict-pane-ours">
              <View style={[styles.paneHeader, styles.paneHeaderOurs]}>
                <View style={styles.paneHeaderTitleRow}>
                  <View style={[styles.paneAccentDot, { backgroundColor: "#10b981" }]} />
                  <Text style={styles.paneHeaderTitle}>Local / Yours</Text>
                </View>
                <Text style={styles.paneHeaderSub} numberOfLines={1}>
                  {conflictData?.oursLabel || "HEAD (:2)"}
                </Text>
              </View>

              <ScrollView style={styles.paneScroll}>
                {oursLines.length === 0 ? (
                  <Text style={styles.paneEmptyText}>(Empty on Local / Yours)</Text>
                ) : (
                  oursLines.map((line) => (
                    <View key={`ours-${line.lineNumber}`} style={styles.codeLineRow}>
                      <Text style={styles.codeLineNum}>{line.lineNumber}</Text>
                      <Text style={styles.codeLineText}>{line.content}</Text>
                    </View>
                  ))
                )}
              </ScrollView>
            </View>

            {/* Center Pane: Merged Result (Editable) */}
            <View style={[styles.centerPane, styles.paneRightBorder]} testID="conflict-pane-merged">
              <View style={[styles.paneHeader, styles.paneHeaderCenter]}>
                <View style={styles.paneHeaderTitleRow}>
                  <View style={[styles.paneAccentDot, { backgroundColor: "#f59e0b" }]} />
                  <Text style={styles.paneHeaderTitle}>Merged Result — Editable</Text>
                </View>

                <Pressable
                  testID="save-mark-resolved-btn"
                  disabled={actionBusy || !selectedFile}
                  style={({ pressed }) => [
                    styles.saveResolveBtn,
                    (pressed || actionBusy) && styles.btnDimmed,
                  ]}
                  onPress={() => void handleSaveAndMarkResolved()}
                >
                  <Check size={12} color="#0f172a" />
                  <Text style={styles.saveResolveBtnText}>Save &amp; Mark Resolved (git add)</Text>
                </Pressable>
              </View>

              <View style={styles.editorWrapper}>
                <TextInput
                  testID="merged-result-editor"
                  multiline
                  value={mergedContent}
                  onChangeText={setMergedContent}
                  placeholder="Resolved file content..."
                  placeholderTextColor={theme.colors.foregroundMuted}
                  style={styles.mergedEditorInput}
                />
              </View>
            </View>

            {/* Right Pane: Remote / Theirs */}
            <View style={styles.sidePane} testID="conflict-pane-theirs">
              <View style={[styles.paneHeader, styles.paneHeaderTheirs]}>
                <View style={styles.paneHeaderTitleRow}>
                  <View style={[styles.paneAccentDot, { backgroundColor: "#06b6d4" }]} />
                  <Text style={styles.paneHeaderTitle}>Remote / Theirs</Text>
                </View>
                <Text style={styles.paneHeaderSub} numberOfLines={1}>
                  {conflictData?.theirsLabel || "Incoming (:3)"}
                </Text>
              </View>

              <ScrollView style={styles.paneScroll}>
                {theirsLines.length === 0 ? (
                  <Text style={styles.paneEmptyText}>(Empty on Remote / Theirs)</Text>
                ) : (
                  theirsLines.map((line) => (
                    <View key={`theirs-${line.lineNumber}`} style={styles.codeLineRow}>
                      <Text style={styles.codeLineNum}>{line.lineNumber}</Text>
                      <Text style={styles.codeLineText}>{line.content}</Text>
                    </View>
                  ))
                )}
              </ScrollView>
            </View>
          </View>
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
    backgroundColor: "rgba(0, 0, 0, 0.76)",
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[3],
    zIndex: 100010,
  },
  modalWindow: {
    width: "100%",
    maxWidth: 1480,
    height: "92%",
    backgroundColor: theme.colors.surface0,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    overflow: "hidden",
    flexDirection: "column",
  },
  topHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    backgroundColor: theme.colors.surface1,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  topHeaderLeft: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    flex: 1,
    minWidth: 0,
  },
  modalTitle: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  operationBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: "rgba(245, 158, 11, 0.14)",
    borderWidth: 1,
    borderColor: "rgba(245, 158, 11, 0.45)",
  },
  operationBadgeText: {
    fontSize: 10,
    fontFamily: theme.fontFamily.mono,
    fontWeight: theme.fontWeight.semibold,
    color: "#f59e0b",
  },
  counterBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
  },
  counterBadgeResolved: {
    backgroundColor: "rgba(16, 185, 129, 0.14)",
    borderColor: "rgba(16, 185, 129, 0.45)",
  },
  counterBadgePending: {
    backgroundColor: "rgba(245, 158, 11, 0.14)",
    borderColor: "rgba(245, 158, 11, 0.45)",
  },
  counterBadgeText: {
    fontSize: 10,
    fontFamily: theme.fontFamily.mono,
    fontWeight: theme.fontWeight.semibold,
  },
  counterTextResolved: {
    color: "#10b981",
  },
  counterTextPending: {
    color: "#f59e0b",
  },
  topHeaderActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  continueBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: theme.borderRadius.base,
    backgroundColor: "#10b981",
  },
  continueBtnText: {
    fontSize: 11,
    fontWeight: theme.fontWeight.semibold,
    color: "#0f172a",
  },
  abortBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: theme.borderRadius.base,
    backgroundColor: "rgba(244, 63, 94, 0.14)",
    borderWidth: 1,
    borderColor: "#f43f5e",
  },
  abortBtnText: {
    fontSize: 11,
    fontWeight: theme.fontWeight.semibold,
    color: "#f43f5e",
  },
  iconBtn: {
    padding: 5,
    borderRadius: theme.borderRadius.sm,
  },
  btnDimmed: {
    opacity: 0.65,
  },
  subToolbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: 6,
    backgroundColor: theme.colors.surface0,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  filePillsScroll: {
    flex: 1,
  },
  filePillsContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  filePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: theme.borderRadius.base,
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
    maxWidth: 280,
  },
  filePillActive: {
    backgroundColor: "rgba(245, 158, 11, 0.15)",
    borderColor: "#f59e0b",
  },
  filePillText: {
    fontSize: 11,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foregroundMuted,
  },
  filePillTextActive: {
    color: "#f59e0b",
    fontWeight: theme.fontWeight.semibold,
  },
  wholeFileActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  wholeActionOursBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: "rgba(16, 185, 129, 0.14)",
    borderWidth: 1,
    borderColor: "#10b981",
  },
  wholeActionOursText: {
    fontSize: 11,
    fontWeight: theme.fontWeight.semibold,
    color: "#10b981",
  },
  wholeActionTheirsBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: "rgba(6, 182, 212, 0.14)",
    borderWidth: 1,
    borderColor: "#06b6d4",
  },
  wholeActionTheirsText: {
    fontSize: 11,
    fontWeight: theme.fontWeight.semibold,
    color: "#06b6d4",
  },
  wholeActionResetBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  wholeActionResetText: {
    fontSize: 11,
    color: theme.colors.foregroundMuted,
  },
  conflictBlocksSection: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: 6,
    backgroundColor: theme.colors.surface1,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  conflictBlocksRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  conflictBlockCard: {
    flexDirection: "column",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: theme.borderRadius.base,
    backgroundColor: theme.colors.surface0,
    borderWidth: 1,
    borderColor: "rgba(245, 158, 11, 0.4)",
    minWidth: 270,
    maxWidth: 380,
  },
  conflictBlockHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  conflictBlockBadge: {
    fontSize: 10,
    fontFamily: theme.fontFamily.mono,
    fontWeight: theme.fontWeight.semibold,
    color: "#f59e0b",
  },
  conflictBlockPreview: {
    flex: 1,
    fontSize: 10,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foregroundMuted,
  },
  conflictBlockBtnRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  blockBtnOurs: {
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: "rgba(16, 185, 129, 0.14)",
    borderWidth: 1,
    borderColor: "#10b981",
  },
  blockBtnOursText: {
    fontSize: 10,
    fontFamily: theme.fontFamily.mono,
    fontWeight: theme.fontWeight.semibold,
    color: "#10b981",
  },
  blockBtnTheirs: {
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: "rgba(6, 182, 212, 0.14)",
    borderWidth: 1,
    borderColor: "#06b6d4",
  },
  blockBtnTheirsText: {
    fontSize: 10,
    fontFamily: theme.fontFamily.mono,
    fontWeight: theme.fontWeight.semibold,
    color: "#06b6d4",
  },
  blockBtnBoth: {
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: "rgba(245, 158, 11, 0.14)",
    borderWidth: 1,
    borderColor: "#f59e0b",
  },
  blockBtnBothText: {
    fontSize: 10,
    fontFamily: theme.fontFamily.mono,
    fontWeight: theme.fontWeight.semibold,
    color: "#f59e0b",
  },
  threePanesContainer: {
    flex: 1,
    flexDirection: "row",
    minHeight: 0,
  },
  sidePane: {
    flex: 1,
    flexDirection: "column",
    minWidth: 0,
    backgroundColor: theme.colors.surface0,
  },
  centerPane: {
    flex: 1.25,
    flexDirection: "column",
    minWidth: 0,
    backgroundColor: theme.colors.surface0,
  },
  paneRightBorder: {
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
  },
  paneHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 6,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  paneHeaderOurs: {
    backgroundColor: "rgba(16, 185, 129, 0.08)",
    borderTopWidth: 2,
    borderTopColor: "#10b981",
  },
  paneHeaderCenter: {
    backgroundColor: "rgba(245, 158, 11, 0.08)",
    borderTopWidth: 2,
    borderTopColor: "#f59e0b",
  },
  paneHeaderTheirs: {
    backgroundColor: "rgba(6, 182, 212, 0.08)",
    borderTopWidth: 2,
    borderTopColor: "#06b6d4",
  },
  paneHeaderTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  paneAccentDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  paneHeaderTitle: {
    fontSize: 11,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  paneHeaderSub: {
    fontSize: 10,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foregroundMuted,
    maxWidth: 180,
  },
  saveResolveBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: "#10b981",
  },
  saveResolveBtnText: {
    fontSize: 10,
    fontFamily: theme.fontFamily.mono,
    fontWeight: theme.fontWeight.semibold,
    color: "#0f172a",
  },
  paneScroll: {
    flex: 1,
    paddingVertical: 4,
  },
  paneEmptyText: {
    padding: theme.spacing[3],
    fontSize: 11,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foregroundMuted,
  },
  codeLineRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  codeLineNum: {
    width: 36,
    fontSize: 10,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foregroundMuted,
    textAlign: "right",
    paddingRight: 8,
    flexShrink: 0,
  },
  codeLineText: {
    flex: 1,
    fontSize: 11,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foreground,
  },
  editorWrapper: {
    flex: 1,
    padding: theme.spacing[2],
  },
  mergedEditorInput: {
    flex: 1,
    textAlignVertical: "top",
    fontFamily: theme.fontFamily.mono,
    fontSize: 11,
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.base,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing[2],
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
