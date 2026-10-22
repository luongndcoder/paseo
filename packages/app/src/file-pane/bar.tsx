import { View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Copy, FolderOpen, GitCommitHorizontal, History } from "lucide-react-native";
import {
  PaneContentToolbar,
  paneContentToolbarIconSize,
  ToolbarButton,
  ToolbarControls,
} from "@/components/ui/pane-content-toolbar";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { Theme } from "@/styles/theme";
import {
  FilePanelBarMenu,
  FilePanelSwitcher,
  useFilePanelChoiceSnapshot,
  type FilePanelChoice,
} from "@/file-panels";

const mutedIconColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedGitBlameIcon = withUnistyles(GitCommitHorizontal, mutedIconColorMapping);
const ThemedGitHistoryIcon = withUnistyles(History, mutedIconColorMapping);
const ThemedCopyIcon = withUnistyles(Copy, mutedIconColorMapping);
const ThemedRevealIcon = withUnistyles(FolderOpen, mutedIconColorMapping);

/**
 * The file tab's bar: the file actions, the switcher between the file's panels, "Open with…", and
 * whether the panel has unsaved changes.
 */
export function FilePanelBar({
  choice,
  modified,
  onCopyPath,
  onRevealInFileManager,
  revealTargetName,
  onShowGitBlame,
  onShowGitHistory,
}: {
  choice: FilePanelChoice;
  modified: boolean;
  onCopyPath?: () => void;
  onRevealInFileManager?: () => void;
  revealTargetName?: string;
  onShowGitBlame?: () => void;
  onShowGitHistory?: () => void;
}) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const iconSize = paneContentToolbarIconSize(isCompact);
  const { openWith } = useFilePanelChoiceSnapshot(choice);
  const hasFileTools = Boolean(
    onShowGitBlame || onShowGitHistory || onCopyPath || onRevealInFileManager,
  );
  if (!openWith && !hasFileTools) return null;
  return (
    <View style={styles.chrome}>
      <PaneContentToolbar testID="file-panel-bar">
        <View style={styles.row}>
          <View style={styles.spacer} />
          {hasFileTools ? (
            <ToolbarControls>
              {onShowGitBlame ? (
                <ToolbarButton
                  compact={isCompact}
                  hitSlop={4}
                  label="Git Blame (Annotate)"
                  onPress={onShowGitBlame}
                  testID="file-bar-git-blame"
                >
                  <ThemedGitBlameIcon size={iconSize} strokeWidth={1.75} />
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
                  <ThemedGitHistoryIcon size={iconSize} strokeWidth={1.75} />
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
                  <ThemedCopyIcon size={iconSize} strokeWidth={1.75} />
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
                  <ThemedRevealIcon size={iconSize} strokeWidth={1.75} />
                </ToolbarButton>
              ) : null}
            </ToolbarControls>
          ) : null}
          {modified ? (
            <View
              style={styles.modifiedDot}
              accessibilityLabel={t("panels.file.editor.unsavedChanges")}
              testID="file-panel-modified"
            />
          ) : null}
          <FilePanelSwitcher choice={choice} />
          <FilePanelBarMenu choice={choice} />
        </View>
      </PaneContentToolbar>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  chrome: {
    flexShrink: 0,
  },
  row: {
    height: "100%",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
  },
  spacer: { flex: 1 },
  modifiedDot: {
    width: 6,
    height: 6,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.foregroundExtraMuted,
  },
}));
