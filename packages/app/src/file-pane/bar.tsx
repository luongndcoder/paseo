import { Text, View } from "react-native";
import { StyleSheet, useUnistyles, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Copy, FolderOpen, GitCommitHorizontal, History } from "lucide-react-native";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import {
  PaneContentToolbar,
  paneContentToolbarIconSize,
  ToolbarButton,
  ToolbarControls,
} from "@/components/ui/pane-content-toolbar";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { Theme } from "@/styles/theme";
import { FileConflictAlert, type FileConflictAlertState } from "./conflict-alert";
import type { FileEditorStatus } from "./editor/model";

const ThemedSpinner = withUnistyles(LoadingSpinner);
const spinnerMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export function FilePanelBar({
  size,
  lineCount,
  mode,
  onModeChange,
  editorStatus,
  cursor,
  vimMode,
  conflict,
  onCopyPath,
  onRevealInFileManager,
  revealTargetName,
  onShowGitBlame,
  onShowGitHistory,
}: {
  size: number;
  lineCount?: number;
  mode?: "preview" | "source";
  onModeChange?(mode: "preview" | "source"): void;
  editorStatus?: FileEditorStatus;
  cursor?: { line: number; column: number };
  vimMode?: string | null;
  conflict?: FileConflictAlertState;
  onCopyPath?: () => void;
  onRevealInFileManager?: () => void;
  revealTargetName?: string;
  onShowGitBlame?: () => void;
  onShowGitHistory?: () => void;
}) {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const isCompact = useIsCompactFormFactor();
  const iconSize = paneContentToolbarIconSize(isCompact);
  const iconColor = theme.colors.foregroundMuted;
  const previewModes = [
    {
      value: "preview" as const,
      label: t("panels.file.editor.preview"),
      testID: "file-mode-preview",
    },
    { value: "source" as const, label: t("panels.file.editor.source"), testID: "file-mode-source" },
  ];
  return (
    <View style={styles.chrome}>
      <PaneContentToolbar testID="file-panel-bar">
        <View style={styles.row}>
          <View style={styles.metadata}>
            <Text
              style={styles.whisper}
              accessibilityLabel={t("panels.file.editor.fileSize", { size: formatFileSize(size) })}
            >
              {formatFileSize(size)}
            </Text>
            {lineCount !== undefined ? (
              <Text
                style={styles.whisper}
                accessibilityLabel={t("panels.file.editor.lines", { count: lineCount })}
              >
                {t("panels.file.editor.lines", { count: lineCount })}
              </Text>
            ) : null}
          </View>
          <View
            style={styles.status}
            accessibilityLabel={
              editorStatus
                ? t("panels.file.editor.editorStatus", { status: editorStatus })
                : undefined
            }
          >
            {editorStatus === "dirty" ? (
              <View
                style={styles.dirtyDot}
                accessibilityLabel={t("panels.file.editor.unsavedChanges")}
              />
            ) : null}
            {editorStatus === "saving" ? (
              <>
                <ThemedSpinner size={14} uniProps={spinnerMapping} />
                <Text style={styles.secondary}>{t("panels.file.editor.saving")}</Text>
              </>
            ) : null}
            {editorStatus === "error" ? (
              <Text style={styles.error}>{t("panels.file.editor.saveFailed")}</Text>
            ) : null}
            {vimMode ? (
              <Text
                style={styles.vim}
                accessibilityLabel={t("panels.file.editor.vimMode", { mode: vimMode })}
              >
                {vimMode}
              </Text>
            ) : null}
            {cursor ? (
              <Text
                style={styles.whisper}
                accessibilityLabel={t("panels.file.editor.cursor", cursor)}
              >
                Ln {cursor.line}, Col {cursor.column}
              </Text>
            ) : null}
          </View>
          {mode && onModeChange ? (
            <SegmentedControl
              size="xs"
              value={mode}
              onValueChange={onModeChange}
              testID="file-preview-mode"
              options={previewModes}
            />
          ) : null}
          {onShowGitBlame || onShowGitHistory || onCopyPath || onRevealInFileManager ? (
            <>
              <View style={styles.toolbarDivider} />
              <ToolbarControls style={styles.toolbarControls}>
                {onShowGitBlame ? (
                  <ToolbarButton
                    compact={isCompact}
                    hitSlop={4}
                    label="Git Blame (Annotate)"
                    onPress={onShowGitBlame}
                    testID="file-bar-git-blame"
                  >
                    <GitCommitHorizontal size={iconSize} strokeWidth={1.75} color={iconColor} />
                  </ToolbarButton>
                ) : null}
                {onShowGitHistory ? (
                  <ToolbarButton
                    compact={isCompact}
                    hitSlop={4}
                    label="Git File History"
                    onPress={onShowGitHistory}
                    testID="file-bar-git-history"
                  >
                    <History size={iconSize} strokeWidth={1.75} color={iconColor} />
                  </ToolbarButton>
                ) : null}
                {onCopyPath ? (
                  <ToolbarButton
                    compact={isCompact}
                    hitSlop={4}
                    label={t("workspace.fileActions.copyPath")}
                    onPress={onCopyPath}
                    testID="file-bar-copy-path"
                  >
                    <Copy size={iconSize} strokeWidth={1.75} color={iconColor} />
                  </ToolbarButton>
                ) : null}
                {onRevealInFileManager ? (
                  <ToolbarButton
                    compact={isCompact}
                    hitSlop={4}
                    label={t("workspace.fileActions.revealIn", {
                      target: revealTargetName ?? "Finder",
                    })}
                    onPress={onRevealInFileManager}
                    testID="file-bar-reveal-in-file-manager"
                  >
                    <FolderOpen size={iconSize} strokeWidth={1.75} color={iconColor} />
                  </ToolbarButton>
                ) : null}
              </ToolbarControls>
            </>
          ) : null}
        </View>
      </PaneContentToolbar>
      {conflict ? <FileConflictAlert state={conflict} /> : null}
    </View>
  );
}

function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

const styles = StyleSheet.create((theme) => ({
  chrome: {
    flexShrink: 0,
  },
  row: {
    height: "100%",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
  },
  metadata: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  secondary: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  whisper: { color: theme.colors.foregroundExtraMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.palette.red[300], fontSize: theme.fontSize.sm },
  dirtyDot: {
    width: 6,
    height: 6,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.foregroundExtraMuted,
  },
  status: {
    flexShrink: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  toolbarDivider: {
    width: 1,
    height: 12,
    backgroundColor: theme.colors.border,
    opacity: 0.7,
    marginHorizontal: 2,
  },
  toolbarControls: {
    gap: 2,
  },
  vim: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
  },
}));
