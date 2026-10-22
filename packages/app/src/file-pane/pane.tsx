import { useCallback, useEffect, useMemo, useState } from "react";
import type { PluginFile, PluginFileTab } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import * as Clipboard from "expo-clipboard";
import { Button } from "@/components/ui/button";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useToast } from "@/contexts/toast-context";
import { useFileHandle, useFileHandleSnapshot } from "@/file-panels/file";
import { FilePanelLoading } from "@/file-panels/loading";
import { FilePanelPicker, FilePanelView, useFilePanelChoice, type FilePanel } from "@/file-panels";
import { resolveFilePreviewReadTarget } from "@/file-explorer/preview-target";
import { GitBlameModal } from "@/git/ndl-git/git-blame-modal";
import { NdlGitModal } from "@/git/ndl-git/ndl-git-modal";
import { useAppActivelyVisible } from "@/hooks/use-app-visible";
import { useIsLocalExecution } from "@/hooks/use-is-local-daemon";
import { usePublishPanelInstanceAttributes } from "@/panels/panel-instance-attributes";
import { useSessionStore } from "@/stores/session-store";
import { buildAbsoluteExplorerPath } from "@/utils/explorer-paths";
import { formatFileSize } from "@/utils/format-file-size";
import { openDesktopTarget, useDesktopOpenTargets } from "@/workspace/desktop-open-targets";
import { resolveWorkspaceFilePaths, type WorkspaceFileLocation } from "@/workspace/file-open";
import { FilePanelBar } from "./bar";

/**
 * The file tab: stats the file, picks its panel and mounts it. The panel reads, saves and shows
 * its own loading; the tab only knows the file exists, its kind, and whether the panel has
 * unsaved changes.
 */
export function FilePane({
  serverId,
  workspaceRoot,
  location,
  navigationRevision,
}: {
  serverId: string;
  workspaceRoot: string;
  location: WorkspaceFileLocation;
  navigationRevision: number;
}) {
  const { t } = useTranslation();
  const connected = useSessionStore((state) => Boolean(state.sessions[serverId]?.client));
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const root = workspaceRoot.trim();
  const path = location.path.trim();
  const target = useMemo(
    () => (path ? resolveFilePreviewReadTarget({ path, workspaceRoot: root }) : null),
    [path, root],
  );
  const absolutePath = useMemo(
    () => buildAbsoluteExplorerPath({ workspaceRoot: root, entryPath: path }),
    [path, root],
  );
  // A hidden tab or a backgrounded app stops observing; observing again reports what changed.
  const isActive = useRetainedPanelActive();
  const isAppVisible = useAppActivelyVisible();
  const handle = useFileHandle({
    serverId,
    target,
    absolutePath,
    observing: isActive && isAppVisible,
  });
  const snapshot = useFileHandleSnapshot(handle);
  const targetKey = target ? `${target.cwd}:${target.path}` : null;
  const { panel, choice } = useFilePanelChoice({
    serverId,
    targetKey,
    path,
    fileKind: snapshot.status === "ready" ? snapshot.kind : null,
    presentable: isActive,
    lineNavigation: location.lineStart ? navigationRevision : null,
  });
  const [modified, setModified] = useState(false);
  const barActions = useFilePaneBarActions({ serverId, workspaceRoot: root, path: path });
  const [gitBlameOpen, setGitBlameOpen] = useState(false);
  const [gitHistoryOpen, setGitHistoryOpen] = useState(false);
  const [selectedBlameCommitSha, setSelectedBlameCommitSha] = useState<string | null>(null);
  const relativeGitFilePath = useMemo(() => {
    if (!target) return "";
    const normalizedCwd = target.cwd.replace(/[\\/]+$/, "");
    const normalizedPath = target.path.replace(/\\/g, "/");
    if (normalizedCwd && normalizedPath.startsWith(`${normalizedCwd}/`)) {
      return normalizedPath.slice(normalizedCwd.length + 1);
    }
    return normalizedPath.replace(/^\.\//, "");
  }, [target]);
  const canUseGitFileTools = Boolean(client && target);
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
  usePublishPanelInstanceAttributes({ modified, suspendPendingSave: handle?.holdWrites });
  const panelLocation = useMemo(
    () => ({
      lineStart: location.lineStart,
      lineEnd: location.lineEnd,
      revision: navigationRevision,
    }),
    [location.lineEnd, location.lineStart, navigationRevision],
  );
  const panelTarget = useMemo(
    () => ({ serverId, workspaceRoot: root, path }),
    [path, root, serverId],
  );
  const gitTools = target ? (
    <>
      <GitBlameModal
        visible={gitBlameOpen}
        onClose={closeGitBlame}
        serverId={serverId}
        cwd={target.cwd}
        filePath={relativeGitFilePath}
        onOpenFileHistory={openFileHistory}
        onInspectCommit={inspectCommit}
      />
      <NdlGitModal
        visible={gitHistoryOpen}
        onClose={closeGitHistory}
        serverId={serverId}
        cwd={target.cwd}
        initialFilePath={relativeGitFilePath}
        initialCommitSha={selectedBlameCommitSha}
      />
    </>
  ) : null;

  let body;
  if (!connected && target) {
    body = <Text style={styles.errorText}>{t("workspace.terminal.hostDisconnected")}</Text>;
  } else if (!handle || snapshot.status === "loading") {
    return (
      <View style={styles.container} testID="workspace-file-pane">
        <FilePanelLoading />
      </View>
    );
  } else if (snapshot.status === "missing" || snapshot.status === "error") {
    body = (
      <>
        <Text style={styles.errorText}>
          {snapshot.status === "error" ? snapshot.error : t("panels.file.notFound")}
        </Text>
        <Button variant="outline" size="sm" onPress={handle.retry}>
          {t("common.actions.retry")}
        </Button>
      </>
    );
  } else if (!panel) {
    body = (
      <>
        <Text style={styles.mutedText}>{t("panels.file.binaryPreviewUnavailable")}</Text>
        <Text style={styles.mutedText}>{formatFileSize(snapshot.size)}</Text>
      </>
    );
  } else {
    return (
      <View style={styles.container} testID="workspace-file-pane">
        <FilePanelPicker choice={choice} />
        <FilePanelBar
          choice={choice}
          modified={modified}
          onCopyPath={barActions.onCopyPath}
          onRevealInFileManager={barActions.onRevealInFileManager}
          revealTargetName={barActions.revealTargetName}
          onShowGitBlame={canUseGitFileTools ? openGitBlame : undefined}
          onShowGitHistory={canUseGitFileTools ? openGitHistory : undefined}
        />
        <MountedFilePanel
          key={`${panel.id}:${targetKey}`}
          panel={panel}
          file={handle.file}
          location={panelLocation}
          target={panelTarget}
          onModifiedChange={setModified}
        />
        {gitTools}
      </View>
    );
  }
  return (
    <View style={styles.container} testID="workspace-file-pane">
      <View style={styles.centerState}>{body}</View>
    </View>
  );
}

/** The file actions the bar offers: copy the file's path, reveal it in the file manager. */
function useFilePaneBarActions(input: { serverId: string; workspaceRoot: string; path: string }) {
  const { serverId, workspaceRoot, path } = input;
  const { t } = useTranslation();
  const toast = useToast();
  const isLocalExecution = useIsLocalExecution(serverId);
  const { targets: desktopOpenTargets } = useDesktopOpenTargets({ isLocalExecution });
  const fileManagerTarget = desktopOpenTargets.find((target) => target.kind === "file-manager");
  const resolvedFilePaths = useMemo(
    () => (path ? resolveWorkspaceFilePaths({ path, workspaceRoot }) : null),
    [path, workspaceRoot],
  );
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

  return {
    onCopyPath: resolvedFilePaths || path ? handleCopyPath : undefined,
    onRevealInFileManager:
      fileManagerTarget && resolvedFilePaths ? handleRevealInFileManager : undefined,
    revealTargetName: fileManagerTarget?.label,
  };
}

/** One panel mount. Its tab reports unsaved changes until the panel unmounts. */
function MountedFilePanel({
  panel,
  file,
  location,
  target,
  onModifiedChange,
}: {
  panel: FilePanel;
  file: PluginFile;
  location: { lineStart?: number; lineEnd?: number; revision: number };
  target: { serverId: string; workspaceRoot: string; path: string };
  onModifiedChange: (modified: boolean) => void;
}) {
  const [tab] = useState<PluginFileTab>(() => ({
    setModified: (modified) => onModifiedChange(modified),
  }));
  useEffect(() => () => onModifiedChange(false), [onModifiedChange]);
  return <FilePanelView panel={panel} file={file} tab={tab} location={location} target={target} />;
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface0,
  },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[4],
  },
  errorText: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  mutedText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
}));
