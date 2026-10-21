import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import React, { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useSessionStore, type ExplorerFile } from "@/stores/session-store";
import { FilePanelPreview, resolveFilePreviewPanel, type FilePanel } from "@/file-panels";
import * as Clipboard from "expo-clipboard";
import { useAttachmentPreviewUrl } from "@/attachments/use-attachment-preview-url";
import { getFileNameFromPath } from "@/attachments/utils";
import { resolveFilePreviewReadTarget } from "@/file-explorer/preview-target";
import { resolveWorkspaceFilePaths, type WorkspaceFileLocation } from "@/workspace/file-open";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useAppActivelyVisible } from "@/hooks/use-app-visible";
import { isFileQueryEnabled } from "@/components/file-pane-enabled";
import { isWeb } from "@/constants/platform";
import { useToast } from "@/contexts/toast-context";
import { useIsLocalExecution } from "@/hooks/use-is-local-daemon";
import { useAppSettings } from "@/hooks/use-settings";
import { openDesktopTarget, useDesktopOpenTargets } from "@/workspace/desktop-open-targets";
import { useLiveFile } from "./live-file/hook";
import { useFilePreview } from "./preview-lifecycle/hook";
import { resolveFilePreviewLifecycle } from "./preview-lifecycle/model";
import { FilePanelBar } from "./bar";
import { FileEditorModel, getFileConflictCallout, type FileConflictCallout } from "./editor/model";
import { createFileObservationSource } from "./editor/observation-source";
import { FileEditorView } from "./editor/view";
import { FileSourceView } from "./source/view";
import type { FileConflictAlertState } from "./conflict-alert";
import type { LiveFileModel } from "./live-file/model";
import { confirmDialog } from "@/utils/confirm-dialog";
import { usePublishPanelInstanceAttributes } from "@/panels/panel-instance-attributes";
import type { Theme } from "@/styles/theme";
import { GitBlameModal } from "@/git/ndl-git/git-blame-modal";
import { NdlGitModal } from "@/git/ndl-git/ndl-git-modal";

// CodeMirror and native source rendering consume appearance as props. Subscribe at the
// rendering leaf so theme updates reconfigure it without replacing the editor/model.
const sourceAppearance = (theme: Theme) => ({
  theme: {
    colorScheme: theme.colorScheme,
    background: theme.colors.surface0,
    foreground: theme.colors.foreground,
    cursor: theme.colors.terminal.cursor,
    foregroundMuted: theme.colors.foregroundMuted,
    border: theme.colors.border,
    selection: theme.colors.terminal.selectionBackground,
    monoFont: theme.fontFamily.mono,
    codeFontSize: theme.fontSize.code,
    syntax: theme.colors.syntax,
  },
});
const ThemedFileEditorView = withUnistyles(FileEditorView, sourceAppearance);
const ThemedFileSourceView = withUnistyles(FileSourceView, sourceAppearance);

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

interface FilePreviewBodyProps {
  panel: FilePanel | null;
  preview: ExplorerFile | null;
  mode?: "preview" | "source";
  isLoading: boolean;
  isMobile: boolean;
  location: WorkspaceFileLocation;
  navigationRevision: number;
  imagePreviewUri: string | null;
  workspaceRoot: string;
  client: DaemonClient | null;
  serverId: string;
}

type TextExplorerFile = ExplorerFile & { kind: "text" };

function trimNonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function formatFileSize({ size }: { size: number }): string {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function ReadonlySource({
  preview,
  filename,
  location,
  navigationRevision,
}: {
  preview: ExplorerFile;
  filename: string;
  location: WorkspaceFileLocation;
  navigationRevision: number;
}) {
  const { t } = useTranslation();
  return (
    <ThemedFileSourceView
      content={preview.content ?? ""}
      filename={filename}
      location={location}
      navigationRevision={navigationRevision}
      size={preview.size}
      tooLargeMessage={t("panels.file.tooLargeToDisplay")}
    />
  );
}

function TooLargeSource({ size }: { size?: number }) {
  const { t } = useTranslation();
  return (
    <View style={styles.centerState} testID="file-source-too-large">
      <Text style={styles.emptyText}>{t("panels.file.tooLargeToDisplay")}</Text>
      {size ? <Text style={styles.binaryMetaText}>{formatFileSize({ size })}</Text> : null}
    </View>
  );
}

function FilePreviewBody({
  panel,
  preview,
  mode,
  isLoading,
  isMobile: _isMobile,
  location,
  navigationRevision,
  imagePreviewUri,
  workspaceRoot,
  client,
  serverId,
}: FilePreviewBodyProps) {
  const { t } = useTranslation();
  const filePath = location.path;

  if (isLoading && !preview) {
    return (
      <View style={styles.centerState} testID="file-preview-loading">
        <ThemedLoadingSpinner size="small" uniProps={foregroundMutedColorMapping} />
        <Text style={styles.loadingText}>{t("panels.file.loading")}</Text>
      </View>
    );
  }

  if (!preview) {
    return (
      <View style={styles.centerState} testID="file-preview-unsupported">
        <Text style={styles.emptyText}>{t("panels.file.noPreview")}</Text>
      </View>
    );
  }

  const showSource = preview.kind === "text" && (Boolean(location.lineStart) || mode === "source");
  if (panel && !showSource) {
    return (
      <FilePanelPreview
        panel={panel}
        content={preview.content ?? ""}
        filePath={filePath}
        workspaceRoot={workspaceRoot}
        client={client}
        serverId={serverId}
        imagePreviewUri={imagePreviewUri}
      />
    );
  }
  if (preview.kind === "text") {
    return (
      <ReadonlySource
        preview={preview}
        filename={filePath}
        location={location}
        navigationRevision={navigationRevision}
      />
    );
  }

  return (
    <View style={styles.centerState}>
      <Text style={styles.emptyText}>{t("panels.file.binaryPreviewUnavailable")}</Text>
      <Text style={styles.binaryMetaText}>{formatFileSize({ size: preview.size })}</Text>
    </View>
  );
}

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
  const { settings } = useAppSettings();
  const isMobile = useIsCompactFormFactor();
  const [previewMode, setPreviewMode] = useState<"preview" | "source">("preview");

  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  // COMPAT(workspaceFileEditing): added in v0.2.0, remove after 2027-01-18 once daemon floor >= v0.2.0.
  const supportsEditing = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.workspaceFileEditing === true,
  );
  const normalizedWorkspaceRoot = useMemo(() => workspaceRoot.trim(), [workspaceRoot]);
  const normalizedFilePath = useMemo(() => trimNonEmpty(location.path), [location.path]);
  const readTarget = useMemo(
    () =>
      normalizedFilePath
        ? resolveFilePreviewReadTarget({
            path: normalizedFilePath,
            workspaceRoot: normalizedWorkspaceRoot,
          })
        : null,
    [normalizedFilePath, normalizedWorkspaceRoot],
  );

  // Re-read the file when this pane becomes visible again (#445). `isActive`
  // covers tab switches; active app visibility covers backgrounding and returning
  // from another window after an external edit. The gate lives in isFileQueryEnabled.
  const isActive = useRetainedPanelActive();
  const isAppVisible = useAppActivelyVisible();
  const enabled = isFileQueryEnabled({
    hasReadTarget: Boolean(client && readTarget),
    isTabActive: isActive,
    isAppVisible,
  });
  const liveFile = useLiveFile({
    client,
    cwd: readTarget?.cwd ?? null,
    path: readTarget?.path ?? null,
    enabled,
    liveUpdates: supportsEditing,
  });

  const targetKey = readTarget ? `${readTarget.cwd}:${readTarget.path}` : null;
  const previewLifecycle = useFilePreview({
    targetKey,
    liveFileSnapshot: liveFile.snapshot,
  });

  useEffect(() => setPreviewMode("preview"), [targetKey]);

  const { file: preview, imageAttachment } = resolveFilePreviewLifecycle(previewLifecycle);
  const imagePreviewUri = useAttachmentPreviewUrl(imageAttachment);
  const panel = resolveFilePreviewPanel({
    preview,
    path: location.path,
    associations: settings.filePanelAssociations,
  });
  const isRenderable = preview?.kind === "text" && panel !== null;
  const editable = isEditableTextFile({
    preview,
    supportsEditing,
  });
  const canTogglePreviewMode = isRenderable && !location.lineStart;
  const lineCount =
    preview?.kind === "text" ? (preview.content ?? "").split("\n").length : undefined;
  const errorMessage = previewLifecycle.status === "error" ? previewLifecycle.message : null;
  const isLoading =
    previewLifecycle.status === "initial" ||
    previewLifecycle.status === "read_pending" ||
    previewLifecycle.status === "preparing";

  const barActions = useFilePaneBarActions({
    serverId,
    normalizedWorkspaceRoot,
    normalizedFilePath,
  });

  const [gitBlameOpen, setGitBlameOpen] = useState(false);
  const [gitHistoryOpen, setGitHistoryOpen] = useState(false);
  const [selectedBlameCommitSha, setSelectedBlameCommitSha] = useState<string | null>(null);

  const relativeGitFilePath = useMemo(() => {
    if (!readTarget) return "";
    const normalizedCwd = readTarget.cwd.replace(/[\\/]+$/, "");
    const normalizedPath = readTarget.path.replace(/\\/g, "/");
    if (normalizedCwd && normalizedPath.startsWith(`${normalizedCwd}/`)) {
      return normalizedPath.slice(normalizedCwd.length + 1);
    }
    return normalizedPath.replace(/^\.\//, "");
  }, [readTarget]);

  const canUseGitFileTools = Boolean(client && readTarget && preview?.kind !== "binary");

  return (
    <>
      <FilePanePresentation
        panel={panel}
        serverId={serverId}
        workspaceRoot={normalizedWorkspaceRoot}
        client={client}
        readTarget={readTarget}
        preview={preview}
        liveFile={liveFile.model}
        onRetryRead={liveFile.refresh}
        retryingRead={liveFile.isRetrying}
        retryLabel={t("common.actions.retry")}
        filename={getFileNameFromPath(location.path) ?? location.path}
        previewMode={canTogglePreviewMode ? previewMode : undefined}
        onPreviewModeChange={canTogglePreviewMode ? setPreviewMode : undefined}
        lineCount={lineCount}
        editable={editable}
        disconnectedMessage={t("workspace.terminal.hostDisconnected")}
        errorMessage={errorMessage}
        isLoading={isLoading}
        isMobile={isMobile}
        location={location}
        navigationRevision={navigationRevision}
        imagePreviewUri={imagePreviewUri}
        onCopyPath={barActions.onCopyPath}
        onRevealInFileManager={barActions.onRevealInFileManager}
        revealTargetName={barActions.revealTargetName}
        onShowGitBlame={canUseGitFileTools ? () => setGitBlameOpen(true) : undefined}
        onShowGitHistory={
          canUseGitFileTools
            ? () => {
                setSelectedBlameCommitSha(null);
                setGitHistoryOpen(true);
              }
            : undefined
        }
      />
      {readTarget ? (
        <>
          <GitBlameModal
            visible={gitBlameOpen}
            onClose={() => setGitBlameOpen(false)}
            serverId={serverId}
            cwd={readTarget.cwd}
            filePath={relativeGitFilePath}
            onOpenFileHistory={() => {
              setGitBlameOpen(false);
              setSelectedBlameCommitSha(null);
              setGitHistoryOpen(true);
            }}
            onInspectCommit={(sha) => {
              setGitBlameOpen(false);
              setSelectedBlameCommitSha(sha);
              setGitHistoryOpen(true);
            }}
          />
          <NdlGitModal
            visible={gitHistoryOpen}
            onClose={() => setGitHistoryOpen(false)}
            serverId={serverId}
            cwd={readTarget.cwd}
            initialFilePath={relativeGitFilePath}
            initialCommitSha={selectedBlameCommitSha}
          />
        </>
      ) : null}
    </>
  );
}

function useFilePaneBarActions(input: {
  serverId: string;
  normalizedWorkspaceRoot: string;
  normalizedFilePath: string | null;
}) {
  const { serverId, normalizedWorkspaceRoot, normalizedFilePath } = input;
  const { t } = useTranslation();
  const toast = useToast();
  const isLocalExecution = useIsLocalExecution(serverId);
  const { targets: desktopOpenTargets } = useDesktopOpenTargets({ isLocalExecution });
  const fileManagerTarget = desktopOpenTargets.find((target) => target.kind === "file-manager");
  const resolvedFilePaths = useMemo(
    () =>
      normalizedFilePath
        ? resolveWorkspaceFilePaths({
            path: normalizedFilePath,
            workspaceRoot: normalizedWorkspaceRoot,
          })
        : null,
    [normalizedFilePath, normalizedWorkspaceRoot],
  );
  const handleCopyPath = useCallback(() => {
    const targetPath = resolvedFilePaths?.absolutePath ?? normalizedFilePath;
    if (!targetPath) return;
    void Clipboard.setStringAsync(targetPath);
  }, [normalizedFilePath, resolvedFilePaths]);
  const handleRevealInFileManager = useCallback(() => {
    if (!fileManagerTarget || !resolvedFilePaths) return;
    void openDesktopTarget({
      editorId: fileManagerTarget.id,
      workspacePath: normalizedWorkspaceRoot || resolvedFilePaths.absolutePath,
      filePath: resolvedFilePaths.absolutePath,
    }).catch((cause) => {
      toast.error(
        cause instanceof Error ? cause.message : t("workspace.fileExplorer.errors.revealFailed"),
      );
    });
  }, [fileManagerTarget, normalizedWorkspaceRoot, resolvedFilePaths, t, toast]);

  return {
    onCopyPath: resolvedFilePaths || normalizedFilePath ? handleCopyPath : undefined,
    onRevealInFileManager:
      fileManagerTarget && resolvedFilePaths ? handleRevealInFileManager : undefined,
    revealTargetName: fileManagerTarget?.label,
  };
}

function isEditableTextFile(input: {
  preview: ExplorerFile | null;
  supportsEditing: boolean;
}): boolean {
  return Boolean(
    isWeb &&
    input.supportsEditing &&
    input.preview?.kind === "text" &&
    input.preview.size <= 1024 * 1024,
  );
}

function FilePanePresentation({
  panel,
  serverId,
  workspaceRoot,
  client,
  readTarget,
  preview,
  liveFile,
  onRetryRead,
  retryingRead,
  retryLabel,
  filename,
  previewMode,
  onPreviewModeChange,
  lineCount,
  editable,
  disconnectedMessage,
  errorMessage,
  isLoading,
  isMobile,
  location,
  navigationRevision,
  imagePreviewUri,
  onCopyPath,
  onRevealInFileManager,
  revealTargetName,
  onShowGitBlame,
  onShowGitHistory,
}: {
  panel: FilePanel | null;
  serverId: string;
  workspaceRoot: string;
  client: DaemonClient | null;
  readTarget: { cwd: string; path: string } | null;
  preview: ExplorerFile | null;
  liveFile: LiveFileModel;
  onRetryRead: () => void;
  retryingRead: boolean;
  retryLabel: string;
  filename: string;
  previewMode?: "preview" | "source";
  onPreviewModeChange?: (mode: "preview" | "source") => void;
  lineCount?: number;
  editable: boolean;
  disconnectedMessage: string;
  errorMessage: string | null;
  isLoading: boolean;
  isMobile: boolean;
  location: WorkspaceFileLocation;
  navigationRevision: number;
  imagePreviewUri: string | null;
  onCopyPath?: () => void;
  onRevealInFileManager?: () => void;
  revealTargetName?: string;
  onShowGitBlame?: () => void;
  onShowGitHistory?: () => void;
}) {
  if (!client && readTarget) {
    return (
      <View style={styles.container} testID="workspace-file-pane">
        <View style={styles.centerState}>
          <Text style={styles.errorText}>{disconnectedMessage}</Text>
        </View>
      </View>
    );
  }

  if (editable && client && readTarget && preview?.kind === "text") {
    return (
      <EditableFilePane
        panel={panel}
        key={`${serverId}:${readTarget.cwd}:${readTarget.path}`}
        serverId={serverId}
        workspaceRoot={workspaceRoot}
        client={client}
        cwd={readTarget.cwd}
        path={readTarget.path}
        preview={preview as TextExplorerFile}
        liveFile={liveFile}
        onRetryRead={onRetryRead}
        retryingRead={retryingRead}
        filename={filename}
        mode={previewMode}
        onModeChange={onPreviewModeChange}
        isLoading={isLoading}
        isMobile={isMobile}
        location={location}
        navigationRevision={navigationRevision}
        onCopyPath={onCopyPath}
        onRevealInFileManager={onRevealInFileManager}
        revealTargetName={revealTargetName}
        onShowGitBlame={onShowGitBlame}
        onShowGitHistory={onShowGitHistory}
      />
    );
  }

  if (errorMessage) {
    if (errorMessage === "File is too large to display") {
      return (
        <View style={styles.container} testID="workspace-file-pane">
          <TooLargeSource />
        </View>
      );
    }
    return (
      <View style={styles.container} testID="workspace-file-pane">
        <View style={styles.centerState}>
          <Text style={styles.errorText}>{errorMessage}</Text>
          <Button variant="outline" size="sm" onPress={onRetryRead} loading={retryingRead}>
            {retryLabel}
          </Button>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container} testID="workspace-file-pane">
      {preview ? (
        <FilePanelBar
          size={preview.size}
          lineCount={lineCount}
          mode={previewMode}
          onModeChange={onPreviewModeChange}
          onCopyPath={onCopyPath}
          onRevealInFileManager={onRevealInFileManager}
          revealTargetName={revealTargetName}
          onShowGitBlame={onShowGitBlame}
          onShowGitHistory={onShowGitHistory}
        />
      ) : null}
      <FilePreviewBody
        panel={panel}
        preview={preview}
        mode={previewMode}
        isLoading={isLoading}
        isMobile={isMobile}
        location={location}
        navigationRevision={navigationRevision}
        imagePreviewUri={imagePreviewUri}
        workspaceRoot={workspaceRoot}
        client={client}
        serverId={serverId}
      />
    </View>
  );
}

function EditableFilePane({
  panel,
  serverId,
  workspaceRoot,
  client,
  cwd,
  path,
  preview,
  liveFile,
  onRetryRead,
  retryingRead,
  filename,
  mode,
  onModeChange,
  isLoading,
  isMobile,
  location,
  navigationRevision,
  onCopyPath,
  onRevealInFileManager,
  revealTargetName,
  onShowGitBlame,
  onShowGitHistory,
}: {
  panel: FilePanel | null;
  serverId: string;
  workspaceRoot: string;
  client: DaemonClient;
  cwd: string;
  path: string;
  preview: TextExplorerFile;
  liveFile: LiveFileModel;
  onRetryRead: () => void;
  retryingRead: boolean;
  filename: string;
  mode?: "preview" | "source";
  onModeChange?: (mode: "preview" | "source") => void;
  isLoading: boolean;
  isMobile: boolean;
  location: WorkspaceFileLocation;
  navigationRevision: number;
  onCopyPath?: () => void;
  onRevealInFileManager?: () => void;
  revealTargetName?: string;
  onShowGitBlame?: () => void;
  onShowGitHistory?: () => void;
}) {
  const { settings } = useAppSettings();
  const { t } = useTranslation();
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [vimMode, setVimMode] = useState<string | null>(settings.vimKeybindings ? "NORMAL" : null);
  const session = useMemo(
    () => ({
      write(input: { content: string; expectedModifiedAt: string; expectedRevision?: string }) {
        return client.writeFile({ cwd, path, ...input });
      },
    }),
    [client, cwd, path],
  );
  const [model] = useState(() => {
    return new FileEditorModel({
      file: {
        content: preview.content ?? "",
        hasBom: preview.hasBom,
        version: {
          status: "ready",
          cwd,
          path,
          size: preview.size,
          modifiedAt: preview.modifiedAt,
          revision: preview.revision,
        },
      },
      session,
    });
  });
  useEffect(() => {
    const source = createFileObservationSource(liveFile);
    model.connectFileObservations(source);
    return () => model.disconnectFileObservations();
  }, [liveFile, model]);
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const suspendPendingSave = useCallback(() => model.suspendAutosave(), [model]);
  usePublishPanelInstanceAttributes({ modified: snapshot.modified, suspendPendingSave });
  useEffect(() => () => model.dispose(), [model]);

  const handleReload = useCallback(() => {
    if (!snapshot.modified) {
      void model.reload();
      return;
    }
    void (async () => {
      const confirmed = await confirmDialog({
        title: t("panels.file.editor.reloadTitle"),
        message: t("panels.file.editor.reloadMessage"),
        confirmLabel: t("panels.file.editor.reload"),
        destructive: true,
      });
      if (confirmed) void model.reload();
    })();
  }, [model, snapshot.modified, t]);
  const handleOverwrite = useCallback(() => void model.overwrite(), [model]);
  const conflict = fileConflictAlertState({
    callout: getFileConflictCallout(snapshot),
    onOverwrite: handleOverwrite,
    onReload: handleReload,
    onRetry: onRetryRead,
    retrying: retryingRead,
  });
  const handleVimModeChange = useCallback((nextMode: string | null) => setVimMode(nextMode), []);
  const renderedPreview = useMemo<ExplorerFile>(
    () => ({
      ...preview,
      content: snapshot.content,
      size: snapshot.version.status === "ready" ? snapshot.version.size : preview.size,
      modifiedAt:
        snapshot.version.status === "ready" ? snapshot.version.modifiedAt : preview.modifiedAt,
    }),
    [preview, snapshot.content, snapshot.version],
  );
  const showSource = mode !== "preview";

  return (
    <View style={styles.container} testID="workspace-file-pane">
      <FilePanelBar
        size={
          snapshot.observedVersion.status === "ready" ? snapshot.observedVersion.size : preview.size
        }
        lineCount={snapshot.content.split("\n").length}
        editorStatus={snapshot.status}
        cursor={showSource ? cursor : undefined}
        vimMode={showSource ? vimMode : null}
        conflict={conflict}
        mode={mode}
        onModeChange={onModeChange}
        onCopyPath={onCopyPath}
        onRevealInFileManager={onRevealInFileManager}
        revealTargetName={revealTargetName}
        onShowGitBlame={onShowGitBlame}
        onShowGitHistory={onShowGitHistory}
      />
      {showSource ? (
        <ThemedFileEditorView
          model={model}
          filename={filename}
          location={location}
          navigationRevision={navigationRevision}
          vimEnabled={settings.vimKeybindings}
          onCursorChange={setCursor}
          onVimModeChange={handleVimModeChange}
        />
      ) : (
        <FilePreviewBody
          panel={panel}
          preview={renderedPreview}
          mode={mode}
          isLoading={isLoading}
          isMobile={isMobile}
          location={location}
          navigationRevision={navigationRevision}
          imagePreviewUri={null}
          workspaceRoot={workspaceRoot}
          client={client}
          serverId={serverId}
        />
      )}
    </View>
  );
}

function fileConflictAlertState(input: {
  callout: FileConflictCallout | null;
  onOverwrite(): void;
  onReload(): void;
  onRetry(): void;
  retrying: boolean;
}): FileConflictAlertState | undefined {
  if (!input.callout) return undefined;
  if (input.callout.kind === "deleted") return { kind: "deleted" };
  if (input.callout.kind === "checkFailed") {
    return { kind: "checkFailed", retrying: input.retrying, onRetry: input.onRetry };
  }
  return {
    kind: "changed",
    canOverwrite: input.callout.canOverwrite,
    onReload: input.onReload,
    onOverwrite: input.onOverwrite,
  };
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
  loadingText: {
    marginTop: theme.spacing[2],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  errorText: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  binaryMetaText: {
    marginTop: theme.spacing[2],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
}));
