import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import * as Clipboard from "expo-clipboard";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Copy, FolderOpen, GitCommitHorizontal, History } from "lucide-react-native";
import {
  ToolbarButton,
  ToolbarControls,
  paneContentToolbarIconSize,
} from "@/components/ui/pane-content-toolbar";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useToast } from "@/contexts/toast-context";
import { GitBlameModal } from "@/git/ndl-git/git-blame-modal";
import { NdlGitModal } from "@/git/ndl-git/ndl-git-modal";
import { useIsLocalExecution } from "@/hooks/use-is-local-daemon";
import type { Theme } from "@/styles/theme";
import { openDesktopTarget, useDesktopOpenTargets } from "@/workspace/desktop-open-targets";
import { resolveWorkspaceFilePaths } from "@/workspace/file-open";

const mutedIconColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedGitBlameIcon = withUnistyles(GitCommitHorizontal, mutedIconColorMapping);
const ThemedGitHistoryIcon = withUnistyles(History, mutedIconColorMapping);
const ThemedCopyIcon = withUnistyles(Copy, mutedIconColorMapping);
const ThemedRevealIcon = withUnistyles(FolderOpen, mutedIconColorMapping);

/** The file actions the toolbar offers. Every one of them is optional. */
export interface FileActions {
  onCopyPath?: () => void;
  onRevealInFileManager?: () => void;
  revealTargetName?: string;
  onShowGitBlame?: () => void;
  onShowGitHistory?: () => void;
}

/** The file's own buttons: git blame, git history, copy path, reveal in the file manager. */
export function FileActionButtons({
  onCopyPath,
  onRevealInFileManager,
  revealTargetName,
  onShowGitBlame,
  onShowGitHistory,
}: FileActions) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const iconSize = paneContentToolbarIconSize(isCompact);
  if (!onShowGitBlame && !onShowGitHistory && !onCopyPath && !onRevealInFileManager) return null;
  return (
    <ToolbarControls style={styles.controls}>
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
          label={t("workspace.fileActions.revealIn", { target: revealTargetName ?? "Finder" })}
          onPress={onRevealInFileManager}
          testID="file-bar-reveal-in-file-manager"
        >
          <ThemedRevealIcon size={iconSize} strokeWidth={1.75} />
        </ToolbarButton>
      ) : null}
    </ToolbarControls>
  );
}

/**
 * The file actions for one file: copy its path, reveal it in the file manager, and open the git
 * file tools. The git tools need the workspace's git, so they only show for a file in a workspace.
 */
export function useFileActions(target: { serverId: string; workspaceRoot: string; path: string }): {
  actions: FileActions;
  modals: ReactNode;
} {
  const { serverId, workspaceRoot, path } = target;
  const { t } = useTranslation();
  const toast = useToast();
  const isLocalExecution = useIsLocalExecution(serverId);
  const { targets: desktopOpenTargets } = useDesktopOpenTargets({ isLocalExecution });
  const fileManagerTarget = desktopOpenTargets.find((entry) => entry.kind === "file-manager");
  const resolvedFilePaths = useMemo(
    () => (path ? resolveWorkspaceFilePaths({ path, workspaceRoot }) : null),
    [path, workspaceRoot],
  );
  const [gitBlameOpen, setGitBlameOpen] = useState(false);
  const [gitHistoryOpen, setGitHistoryOpen] = useState(false);
  const [selectedBlameCommitSha, setSelectedBlameCommitSha] = useState<string | null>(null);

  const relativeGitFilePath = useMemo(() => {
    const root = workspaceRoot.replace(/[\\/]+$/, "");
    const normalized = path.replace(/\\/g, "/");
    if (root && normalized.startsWith(`${root}/`)) return normalized.slice(root.length + 1);
    return normalized.replace(/^\.\//, "");
  }, [path, workspaceRoot]);

  const handleCopyPath = useCallback(() => {
    const targetPath = resolvedFilePaths?.absolutePath ?? path;
    if (!targetPath) return;
    void Clipboard.setStringAsync(targetPath);
  }, [path, resolvedFilePaths]);
  const handleRevealInFileManager = useCallback(() => {
    if (!fileManagerTarget || !resolvedFilePaths) return;
    void openDesktopTarget({
      editorId: fileManagerTarget.id,
      workspacePath: workspaceRoot || resolvedFilePaths.absolutePath,
      filePath: resolvedFilePaths.absolutePath,
    }).catch((cause) => {
      toast.error(
        cause instanceof Error ? cause.message : t("workspace.fileExplorer.errors.revealFailed"),
      );
    });
  }, [fileManagerTarget, workspaceRoot, resolvedFilePaths, t, toast]);
  const openGitBlame = useCallback(() => setGitBlameOpen(true), []);
  const openGitHistory = useCallback(() => {
    setSelectedBlameCommitSha(null);
    setGitHistoryOpen(true);
  }, []);
  const closeGitBlame = useCallback(() => setGitBlameOpen(false), []);
  const closeGitHistory = useCallback(() => setGitHistoryOpen(false), []);
  const openFileHistory = useCallback(() => {
    setGitBlameOpen(false);
    setSelectedBlameCommitSha(null);
    setGitHistoryOpen(true);
  }, []);
  const inspectCommit = useCallback((sha: string) => {
    setGitBlameOpen(false);
    setSelectedBlameCommitSha(sha);
    setGitHistoryOpen(true);
  }, []);

  const canUseGitFileTools = Boolean(workspaceRoot && path);
  const actions: FileActions = {
    onCopyPath: resolvedFilePaths || path ? handleCopyPath : undefined,
    onRevealInFileManager:
      fileManagerTarget && resolvedFilePaths ? handleRevealInFileManager : undefined,
    revealTargetName: fileManagerTarget?.label,
    onShowGitBlame: canUseGitFileTools ? openGitBlame : undefined,
    onShowGitHistory: canUseGitFileTools ? openGitHistory : undefined,
  };
  const modals = canUseGitFileTools ? (
    <>
      <GitBlameModal
        visible={gitBlameOpen}
        onClose={closeGitBlame}
        serverId={serverId}
        cwd={workspaceRoot}
        filePath={relativeGitFilePath}
        onOpenFileHistory={openFileHistory}
        onInspectCommit={inspectCommit}
      />
      <NdlGitModal
        visible={gitHistoryOpen}
        onClose={closeGitHistory}
        serverId={serverId}
        cwd={workspaceRoot}
        initialFilePath={relativeGitFilePath}
        initialCommitSha={selectedBlameCommitSha}
      />
    </>
  ) : null;
  return { actions, modals };
}

const styles = StyleSheet.create(() => ({
  controls: { flexDirection: "row", alignItems: "center" },
}));
