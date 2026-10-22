import { useSafeAreaInsets } from "react-native-safe-area-context";
import { floatingActionsClearance } from "@/components/ui/floating-action-button";
import {
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ReactElement,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { TreeRail } from "@/components/tree-rail";
import { TreeRailToggle } from "@/components/tree-rail-toggle";
import { DiffStat } from "@/components/diff-stat";
import {
  View,
  Text,
  Pressable,
  PanResponder,
  ScrollView,
  type PressableStateCallbackType,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useQueryClient } from "@tanstack/react-query";
import { EditingTextInput } from "@/components/ui/text-input";
import { useFetchQuery } from "@/data/query";
import type { Theme } from "@/styles/theme";
import { useIsCompactFormFactor } from "@/constants/layout";
import {
  AlertTriangle,
  AlignJustify,
  Archive,
  ChevronDown,
  Columns2,
  ExternalLink,
  GitBranch,
  GitGraph,
  GitMerge,
  ListChevronsDownUp,
  ListChevronsUpDown,
  Maximize,
  MoreHorizontal,
  Pilcrow,
  RotateCw,
  Sparkles,
  WrapText,
} from "lucide-react-native";
import { type ParsedDiffFile } from "@/git/use-diff-query";
import { invalidateCheckoutGitQueriesForClient } from "@/git/query-keys";
import type { ChangesState } from "@/panels/changes/state";
import { defaultChangesState } from "@/panels/changes/state";
import { ReviewCommentSheet, ReviewFeedbackAction } from "@/review";
import { DiffDocument, type WorkingDiffMode } from "@/git/diff-document";
import { ChangedFilesTree } from "@/git/changed-files-tree";
import { JUMP_TO_FILE_CLEARANCE, JumpToFile } from "@/git/jump-to-file";
import {
  selectPrHintFromStatus,
  type PrHint,
  useCheckoutPrStatusQuery,
} from "@/git/use-pr-status-query";
import { CommitsSection } from "@/git/commits-section/commits-section";
import { NdlGitModal } from "@/git/ndl-git/ndl-git-modal";
import { MergeConflictResolverModal } from "@/git/ndl-git/merge-conflict-resolver-modal";
import { useAppSettings } from "@/hooks/use-settings";
import { useChangesPreferences } from "@/hooks/use-changes-preferences";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import * as Clipboard from "expo-clipboard";
import { useFileDownload } from "@/hooks/use-file-download";
import { useIsLocalExecution } from "@/hooks/use-is-local-daemon";
import { buildAbsoluteExplorerPath } from "@/utils/explorer-paths";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { GitActionsSplitButton } from "@/git/actions-split-button";
import type { GitActions } from "@/git/policy";
import { BranchSwitcher } from "@/components/branch-switcher";
import { useGitActions } from "@/git/use-actions";
import { GIT_ACTION_ICONS } from "@/git/action-icons";
import { buildForgeSignInCommand, getForgePresentation, type Forge } from "@/git/forge";
import { parseGitRemoteLocation } from "@getpaseo/protocol/git-remote";
import type { ForgeAuthState } from "@getpaseo/protocol/messages";
import { useCheckoutGitActionsStore } from "@/git/actions-store";
import { useToast } from "@/contexts/toast-context";
import { useSessionStore } from "@/stores/session-store";
import { confirmDialog } from "@/utils/confirm-dialog";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { Button } from "@/components/ui/button";
import {
  PaneContentToolbar,
  paneContentToolbarIconSize,
  paneContentToolbarIconButtonStyle,
  paneContentToolbarTrailingPadding,
  type ToolbarTrailingControl,
  ToolbarButton,
  ToolbarControls,
} from "@/components/ui/pane-content-toolbar";
import { extraMutedIconColorMapping } from "@/components/ui/icon-button-chrome";
import {
  isToolbarLabelTriggerHighlighted,
  ToolbarLabelTriggerIcon,
  toolbarLabelTriggerTextStyle,
  toolbarLabelTriggerStyle,
} from "@/components/ui/toolbar-label-trigger";
import { FOCUSED_PANE_PLACEMENT, useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import type { WorkspaceTabPlacement } from "@/stores/workspace-layout-actions";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { isWeb } from "@/constants/platform";
import { usePublishWorkingDiffAttachment, useWorkingDiff } from "@/git/use-working-diff";
import type { CheckoutStatusPayload } from "@/git/use-status-query";
import { DiffTooLargeState } from "@/git/diff-too-large-state";
import { openDesktopTarget, useDesktopOpenTargets } from "@/workspace/desktop-open-targets";
import { PullRequestStateIcon } from "@/git/pull-request-state-icon";
import { openExternalUrl } from "@/utils/open-external-url";
import { openWorkspacePullRequest } from "@/workspace-tabs/open-supporting-view";
import type { PullRequestOpenLocation } from "@/hooks/use-settings";

export type { GitActionId, GitAction, GitActions } from "@/git/policy";

export function resolveDiffLayout(
  layout: "unified" | "split",
  canUseSplitLayout: boolean,
): "unified" | "split" {
  return canUseSplitLayout ? layout : "unified";
}

function computeSelectedDiffStat(
  files: ParsedDiffFile[],
  isLoading: boolean,
): { additions: number; deletions: number } | null {
  if (isLoading) {
    return null;
  }
  return files.reduce(
    (total, file) => ({
      additions: total.additions + file.additions,
      deletions: total.deletions + file.deletions,
    }),
    { additions: 0, deletions: 0 },
  );
}

function useDiscardChangesAction({
  serverId,
  cwd,
  diffMode,
}: {
  serverId: string;
  cwd: string;
  diffMode: "uncommitted" | "base" | "all";
}): ((path: string, oldPath?: string) => void) | undefined {
  const { t } = useTranslation();
  const toast = useToast();
  const discardChanges = useCheckoutGitActionsStore((state) => state.discardChanges);
  // COMPAT(checkoutDiscardChanges): added in v0.3.0, remove gate after 2027-02-08.
  const discardSupported = useSessionStore(
    (s) => s.sessions[serverId]?.serverInfo?.features?.checkoutDiscardChanges === true,
  );
  const discardPath = useCallback(
    async (path: string, oldPath?: string) => {
      const confirmed = await confirmDialog({
        title: t("workspace.fileActions.confirmRevert.title"),
        message: t("workspace.fileActions.confirmRevert.message", { name: path }),
        confirmLabel: t("workspace.fileActions.confirmRevert.confirm"),
        cancelLabel: t("workspace.fileActions.confirmRevert.cancel"),
        destructive: true,
      });
      if (!confirmed) {
        return;
      }
      try {
        await discardChanges({
          serverId,
          cwd,
          paths: oldPath ? [path, oldPath] : [path],
        });
      } catch (cause) {
        toast.error(
          cause instanceof Error ? cause.message : t("workspace.fileActions.confirmRevert.failed"),
        );
      }
    },
    [cwd, discardChanges, serverId, t, toast],
  );
  const handleDiscardPath = useCallback(
    (path: string, oldPath?: string) => {
      void discardPath(path, oldPath);
    },
    [discardPath],
  );
  return discardSupported && diffMode === "uncommitted" ? handleDiscardPath : undefined;
}

function useStageAndUnstageActions({
  serverId,
  cwd,
  diffMode,
}: {
  serverId: string;
  cwd: string;
  diffMode: "uncommitted" | "base" | "all";
}): {
  onStagePath?: (path: string, oldPath?: string) => void;
  onUnstagePath?: (path: string, oldPath?: string) => void;
} {
  const toast = useToast();
  const stageChanges = useCheckoutGitActionsStore((state) => state.stageChanges);
  const unstageChanges = useCheckoutGitActionsStore((state) => state.unstageChanges);
  const handleStagePath = useCallback(
    (path: string, oldPath?: string) => {
      void stageChanges({
        serverId,
        cwd,
        paths: oldPath ? [path, oldPath] : [path],
      }).catch((cause) => {
        toast.error(cause instanceof Error ? cause.message : "Failed to stage file");
      });
    },
    [cwd, serverId, stageChanges, toast],
  );
  const handleUnstagePath = useCallback(
    (path: string, oldPath?: string) => {
      void unstageChanges({
        serverId,
        cwd,
        paths: oldPath ? [path, oldPath] : [path],
      }).catch((cause) => {
        toast.error(cause instanceof Error ? cause.message : "Failed to unstage file");
      });
    },
    [cwd, serverId, toast, unstageChanges],
  );
  if (diffMode !== "uncommitted") {
    return {};
  }
  return {
    onStagePath: handleStagePath,
    onUnstagePath: handleUnstagePath,
  };
}

interface ChangesSurfaceProps {
  serverId: string;
  workspaceId?: string | null;
  cwd: string;
  enabled?: boolean;
  presentation?: ChangesPresentation;
  focusPath?: string;
  focusRequestId?: number;
  onOpenFile?: (path: string) => void;
  onOpenToSide?: (path: string) => void;
  onSelectDiffFile?: (path: string) => void;
  onAddToChat?: (path: string) => void;
  state?: ChangesState;
  onStateChange?: (state: ChangesState) => void;
}

type PressableStyleFn = (
  state: PressableStateCallbackType & { hovered?: boolean; open?: boolean },
) => StyleProp<ViewStyle>;

const foregroundMutedIconColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const ThemedAlignJustify = withUnistyles(AlignJustify);
const ThemedColumns2 = withUnistyles(Columns2);
const ThemedPilcrow = withUnistyles(Pilcrow);
const ThemedWrapText = withUnistyles(WrapText);
const ThemedListChevronsDownUp = withUnistyles(ListChevronsDownUp);
const ThemedListChevronsUpDown = withUnistyles(ListChevronsUpDown);
const ThemedMaximize = withUnistyles(Maximize);
const noopStateChange = () => {};
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedMoreHorizontal = withUnistyles(MoreHorizontal);
const ThemedExternalLink = withUnistyles(ExternalLink);
const DIFF_OPTIONS_WHITESPACE_ICON = (
  <ThemedPilcrow size={14} uniProps={foregroundMutedIconColorMapping} />
);
const DIFF_OPTIONS_WRAP_ICON = (
  <ThemedWrapText size={14} uniProps={foregroundMutedIconColorMapping} />
);
const DIFF_OPTIONS_SPLIT_ICON = (
  <ThemedColumns2 size={14} uniProps={foregroundMutedIconColorMapping} />
);
const DIFF_OPTIONS_COLLAPSE_ICON = (
  <ThemedListChevronsDownUp size={14} uniProps={foregroundMutedIconColorMapping} />
);
const DIFF_OPTIONS_EXPAND_ICON = (
  <ThemedListChevronsUpDown size={14} uniProps={foregroundMutedIconColorMapping} />
);
const DIFF_OPTIONS_CHANGES_TAB_ICON = (
  <ThemedMaximize size={14} uniProps={foregroundMutedIconColorMapping} />
);

interface DiffLayoutToggleProps {
  layout: "unified" | "split";
  isMobile: boolean;
  testID?: string;
  toggleStyle?: PressableStyleFn;
  onToggle: () => void;
}
export function DiffLayoutToggle({
  layout,
  isMobile,
  testID = "changes-toggle-layout",
  toggleStyle,
  onToggle,
}: DiffLayoutToggleProps) {
  const defaultToggleStyle = useMemo(
    () => buildToggleButtonStyle(false, undefined, isMobile),
    [isMobile],
  );
  const { t } = useTranslation();
  const label =
    layout === "unified"
      ? t("workspace.git.diff.switchToSplit")
      : t("workspace.git.diff.switchToUnified");
  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          testID={testID}
          onPress={onToggle}
          style={toggleStyle ?? defaultToggleStyle}
        >
          {layout === "unified" ? (
            <ThemedColumns2 size={isMobile ? 18 : 14} uniProps={foregroundMutedIconColorMapping} />
          ) : (
            <ThemedAlignJustify
              size={isMobile ? 18 : 14}
              uniProps={foregroundMutedIconColorMapping}
            />
          )}
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <Text style={styles.tooltipText}>{label}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

interface DiffModeMenuProps {
  diffMode: "uncommitted" | "base" | "all";
  committedDescription?: string;
  testIDPrefix?: string;
  onSelectUncommitted: () => void;
  onSelectBase: () => void;
  onSelectAll: () => void;
}

export function DiffModeMenu({
  diffMode,
  committedDescription,
  testIDPrefix = "changes-diff",
  onSelectUncommitted,
  onSelectBase,
  onSelectAll,
}: DiffModeMenuProps) {
  const { t } = useTranslation();
  const uncommittedLabel = t("workspace.git.diff.uncommitted");
  const committedLabel = t("workspace.git.diff.committed");
  const allLabel = t("workspace.git.diff.all");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        testID={`${testIDPrefix}-status-trigger`}
        style={toolbarLabelTriggerStyle}
        accessibilityRole="button"
        accessibilityLabel={t("workspace.git.diff.diffMode")}
      >
        {(state) => {
          const highlighted = isToolbarLabelTriggerHighlighted(state);
          return (
            <>
              <Text style={toolbarLabelTriggerTextStyle(highlighted)} numberOfLines={1}>
                {{ all: allLabel, uncommitted: uncommittedLabel, base: committedLabel }[diffMode]}
              </Text>
              <ToolbarLabelTriggerIcon>
                <ThemedChevronDown size={12} uniProps={extraMutedIconColorMapping} />
              </ToolbarLabelTriggerIcon>
            </>
          );
        }}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" width={260} testID={`${testIDPrefix}-status-menu`}>
        <DropdownMenuItem
          testID={`${testIDPrefix}-mode-all`}
          selected={diffMode === "all"}
          onSelect={onSelectAll}
        >
          {allLabel}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          testID={`${testIDPrefix}-mode-uncommitted`}
          selected={diffMode === "uncommitted"}
          onSelect={onSelectUncommitted}
        >
          {uncommittedLabel}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          testID={`${testIDPrefix}-mode-committed`}
          selected={diffMode === "base"}
          description={committedDescription}
          onSelect={onSelectBase}
        >
          {committedLabel}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type ChangesPresentation = "combined" | "tree" | "diff";

interface ChangesToolbarRefreshAction {
  isRefreshing: boolean;
  onRefresh: () => void;
}

interface ChangesToolbarInlineDiffToggle {
  value: boolean;
  onToggle: () => void;
}

interface ChangesToolbarDiffOptions {
  collapse: {
    allFilesCollapsed: boolean;
    onCollapseAll: () => void;
    onExpandAll: () => void;
  } | null;
  layout: {
    value: "unified" | "split";
    onToggle: () => void;
  } | null;
  hideWhitespace: boolean;
  wrapLines: boolean;
  onToggleHideWhitespace: () => void;
  onToggleWrapLines: () => void;
}

type ChangesToolbarMode =
  | {
      kind: "tree";
      onOpenDiff: () => void;
      inlineDiff: ChangesToolbarInlineDiffToggle | null;
      refresh: ChangesToolbarRefreshAction | null;
    }
  | {
      kind: "diff";
      options: ChangesToolbarDiffOptions;
      refresh: ChangesToolbarRefreshAction | null;
    }
  | {
      kind: "combined";
      options: ChangesToolbarDiffOptions;
      refresh: ChangesToolbarRefreshAction | null;
      treeToggle: { visible: boolean; onToggle: () => void } | null;
      inlineDiff: ChangesToolbarInlineDiffToggle | null;
    };

function buildChangesToolbarMode(input: {
  presentation: ChangesPresentation;
  compact: boolean;
  hasChanges: boolean;
  canUseSplitLayout: boolean;
  refreshSupported: boolean;
  isRefreshing: boolean;
  layout: "unified" | "split";
  hideWhitespace: boolean;
  wrapLines: boolean;
  treeVisible: boolean;
  onOpenDiff: () => void;
  inlineDiff: ChangesToolbarInlineDiffToggle | null;
  onRefresh: () => void;
  onCollapseAll: () => void;
  onExpandAll: () => void;
  allFilesCollapsed: boolean;
  onToggleLayout: () => void;
  onToggleHideWhitespace: () => void;
  onToggleWrapLines: () => void;
  onToggleTree: () => void;
}): ChangesToolbarMode {
  const refresh = input.refreshSupported
    ? { isRefreshing: input.isRefreshing, onRefresh: input.onRefresh }
    : null;
  if (input.presentation === "tree") {
    return {
      kind: "tree",
      onOpenDiff: input.onOpenDiff,
      inlineDiff: input.inlineDiff,
      refresh,
    };
  }
  const options: ChangesToolbarDiffOptions = {
    collapse: input.hasChanges
      ? {
          allFilesCollapsed: input.allFilesCollapsed,
          onCollapseAll: input.onCollapseAll,
          onExpandAll: input.onExpandAll,
        }
      : null,
    layout: input.canUseSplitLayout
      ? { value: input.layout, onToggle: input.onToggleLayout }
      : null,
    hideWhitespace: input.hideWhitespace,
    wrapLines: input.wrapLines,
    onToggleHideWhitespace: input.onToggleHideWhitespace,
    onToggleWrapLines: input.onToggleWrapLines,
  };
  if (input.presentation === "diff") {
    return { kind: "diff", options, refresh };
  }
  return {
    kind: "combined",
    options,
    refresh,
    treeToggle:
      !input.compact && input.hasChanges
        ? { visible: input.treeVisible, onToggle: input.onToggleTree }
        : null,
    inlineDiff: input.inlineDiff,
  };
}

interface ChangesPullRequestLinkModel extends Pick<PrHint, "forge" | "number" | "state" | "url"> {
  onOpen: () => void;
}

interface ChangesRepositoryToolbarModel {
  branchName: string | null;
  cwd: string;
  gitActions: GitActions | null;
  onOpenGitLog?: () => void;
  onOpenConflictResolver?: (
    conflictFiles?: string[],
    inProgress?: "merge" | "rebase" | "cherry-pick" | "conflict" | null,
  ) => void;
  pullRequest: ChangesPullRequestLinkModel | null;
  serverId: string;
  workspaceId?: string | null;
}

interface ChangesComparisonToolbarModel {
  committedDescription?: string;
  diffMode: "uncommitted" | "base" | "all";
  mode: ChangesToolbarMode;
  selectedDiffStat: { additions: number; deletions: number } | null;
  onSelectBase: () => void;
  onSelectAll: () => void;
  onSelectUncommitted: () => void;
}

interface ChangesHeaderProps {
  compact: boolean;
  repository: ChangesRepositoryToolbarModel;
  comparison: ChangesComparisonToolbarModel;
  sidebarSurface: boolean;
}

interface BuildChangesHeaderModelInput {
  branchName: string | null;
  committedDescription?: string;
  compact: boolean;
  cwd: string;
  diffMode: "uncommitted" | "base" | "all";
  gitActions: GitActions;
  mode: ChangesToolbarMode;
  onOpenGitLog?: () => void;
  onOpenConflictResolver?: (
    conflictFiles?: string[],
    inProgress?: "merge" | "rebase" | "cherry-pick" | "conflict" | null,
  ) => void;
  onOpenPullRequest: () => void;
  onSelectBase: () => void;
  onSelectAll: () => void;
  onSelectUncommitted: () => void;
  pullRequest: PrHint | null;
  selectedDiffStat: { additions: number; deletions: number } | null;
  serverId: string;
  workspaceId?: string | null;
}

function buildChangesHeaderModel(input: BuildChangesHeaderModelInput): {
  repository: ChangesRepositoryToolbarModel;
  comparison: ChangesComparisonToolbarModel;
} {
  return {
    repository: {
      branchName: input.branchName,
      cwd: input.cwd,
      gitActions: input.compact ? input.gitActions : null,
      onOpenGitLog: input.onOpenGitLog,
      onOpenConflictResolver: input.onOpenConflictResolver,
      pullRequest: input.pullRequest
        ? { ...input.pullRequest, onOpen: input.onOpenPullRequest }
        : null,
      serverId: input.serverId,
      workspaceId: input.workspaceId,
    },
    comparison: {
      committedDescription: input.committedDescription,
      diffMode: input.diffMode,
      mode: input.mode,
      selectedDiffStat: input.selectedDiffStat,
      onSelectBase: input.onSelectBase,
      onSelectAll: input.onSelectAll,
      onSelectUncommitted: input.onSelectUncommitted,
    },
  };
}

// Presentation resolves into these two capability models before rendering. The rows
// never infer which host or Changes presentation produced them.
function ChangesHeader({ compact, repository, comparison, sidebarSurface }: ChangesHeaderProps) {
  if (comparison.mode.kind === "diff") {
    return (
      <ChangesDiffOnlyToolbar
        compact={compact}
        mode={comparison.mode}
        sidebarSurface={sidebarSurface}
      />
    );
  }
  return (
    <View>
      <ChangesRepositoryToolbar
        compact={compact}
        model={repository}
        sidebarSurface={sidebarSurface}
      />
      <ChangesComparisonToolbar
        compact={compact}
        model={comparison}
        sidebarSurface={sidebarSurface}
      />
    </View>
  );
}

function ChangesDiffOnlyToolbar({
  compact,
  mode,
  sidebarSurface,
}: {
  compact: boolean;
  mode: Extract<ChangesToolbarMode, { kind: "diff" }>;
  sidebarSurface: boolean;
}) {
  return (
    <ChangesToolbarRow
      compact={compact}
      sidebarSurface={sidebarSurface}
      testID="changes-header"
      trailing="glyph"
    >
      <ChangesToolbarLeading />
      <ChangesToolbarTrailing>
        <ChangesToolbarActions mode={mode} compact={compact} />
      </ChangesToolbarTrailing>
    </ChangesToolbarRow>
  );
}

function ChangesToolbarRow({
  children,
  compact,
  sidebarSurface,
  testID,
  trailing,
}: {
  children: ReactNode;
  compact: boolean;
  sidebarSurface: boolean;
  testID: string;
  /** What the row's last control paints, so it can pad to the shared trailing rail. */
  trailing: ToolbarTrailingControl;
}) {
  const toolbarStyle = useMemo(
    () => [
      styles.changesToolbar,
      { paddingRight: paneContentToolbarTrailingPadding(compact, trailing) },
      sidebarSurface ? styles.changesToolbarSidebar : null,
    ],
    [compact, sidebarSurface, trailing],
  );
  return (
    <PaneContentToolbar style={toolbarStyle} testID={testID}>
      {children}
    </PaneContentToolbar>
  );
}

function ChangesToolbarLeading({ children }: { children?: ReactNode }) {
  return <View style={styles.changesToolbarIdentity}>{children}</View>;
}

function ChangesToolbarTrailing({ children }: { children: ReactNode }) {
  return <ToolbarControls style={styles.changesToolbarControls}>{children}</ToolbarControls>;
}

const StashToolbarIcon = withUnistyles(Archive, extraMutedIconColorMapping);
const GitLogToolbarIcon = withUnistyles(GitGraph, extraMutedIconColorMapping);
const SparklesIcon = withUnistyles(Sparkles, (theme: Theme) => ({
  color: theme.colors.foreground,
}));

interface StashEntry {
  index: number;
  branch: string | null;
  message: string;
}

function StashEntryRow({
  entry,
  isBusy,
  onApplyOrPop,
  onDrop,
}: {
  entry: StashEntry;
  isBusy: boolean;
  onApplyOrPop: (index: number, drop: boolean) => Promise<void>;
  onDrop: (index: number) => Promise<void>;
}) {
  const handleApply = useCallback(() => {
    void onApplyOrPop(entry.index, false);
  }, [entry.index, onApplyOrPop]);
  const handlePop = useCallback(() => {
    void onApplyOrPop(entry.index, true);
  }, [entry.index, onApplyOrPop]);
  const handleDrop = useCallback(() => {
    void onDrop(entry.index);
  }, [entry.index, onDrop]);

  return (
    <View style={styles.stashEntryRow} testID={`changes-stash-entry-${entry.index}`}>
      <View style={styles.stashEntryInfo}>
        <Text style={styles.stashEntryTitle} numberOfLines={1}>
          #{entry.index} {entry.message || entry.branch || "WIP"}
        </Text>
        {entry.branch ? (
          <Text style={styles.stashEntrySubtitle} numberOfLines={1}>
            {entry.branch}
          </Text>
        ) : null}
      </View>
      <View style={styles.stashEntryActions}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Apply stash ${entry.index}`}
          disabled={isBusy}
          onPress={handleApply}
          style={styles.stashActionPill}
          testID={`changes-stash-apply-${entry.index}`}
        >
          <Text style={styles.stashActionPillText}>Apply</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Pop stash ${entry.index}`}
          disabled={isBusy}
          onPress={handlePop}
          style={styles.stashActionPill}
          testID={`changes-stash-pop-${entry.index}`}
        >
          <Text style={styles.stashActionPillText}>Pop</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Drop stash ${entry.index}`}
          disabled={isBusy}
          onPress={handleDrop}
          style={[styles.stashActionPill, styles.stashActionPillDestructive]}
          testID={`changes-stash-drop-${entry.index}`}
        >
          <Text style={[styles.stashActionPillText, styles.stashActionTextDestructive]}>Drop</Text>
        </Pressable>
      </View>
    </View>
  );
}

function StashEntriesList({
  isLoading,
  entries,
  isBusy,
  onApplyOrPop,
  onDrop,
}: {
  isLoading: boolean;
  entries: StashEntry[];
  isBusy: boolean;
  onApplyOrPop: (index: number, drop: boolean) => Promise<void>;
  onDrop: (index: number) => Promise<void>;
}) {
  if (isLoading) {
    return (
      <View style={styles.stashEmptyRow}>
        <ThemedLoadingSpinner size="small" uniProps={foregroundMutedIconColorMapping} />
      </View>
    );
  }
  if (entries.length === 0) {
    return (
      <View style={styles.stashEmptyRow}>
        <Text style={styles.stashEmptyText}>No stashes saved</Text>
      </View>
    );
  }
  return (
    <>
      {entries.map((entry) => (
        <StashEntryRow
          key={`stash-${entry.index}`}
          entry={entry}
          isBusy={isBusy}
          onApplyOrPop={onApplyOrPop}
          onDrop={onDrop}
        />
      ))}
    </>
  );
}

function ChangesStashMenu({ model }: { model: ChangesRepositoryToolbarModel }) {
  const [open, setOpen] = useState(false);
  const [stashMessage, setStashMessage] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const toast = useToast();
  const queryClient = useQueryClient();
  const client = useSessionStore((state) => state.sessions[model.serverId]?.client ?? null);
  const stashQueryKey = useMemo(
    () => ["stashList", model.serverId, model.workspaceId ?? model.cwd, "all"] as const,
    [model.cwd, model.serverId, model.workspaceId],
  );
  const stashListQuery = useFetchQuery({
    queryKey: stashQueryKey,
    dataShape: "list",
    staleTimeMs: 5_000,
    enabled: open && Boolean(client),
    queryFn: async () => {
      if (!client) {
        return { entries: [] };
      }
      return await client.stashList(model.cwd, { paseoOnly: false });
    },
  });
  const entries = stashListQuery.data?.entries ?? [];
  const refreshAfterStashAction = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: stashQueryKey });
    await invalidateCheckoutGitQueriesForClient(queryClient, {
      serverId: model.serverId,
      cwd: model.cwd,
    });
  }, [model.cwd, model.serverId, queryClient, stashQueryKey]);

  const handleSaveStash = useCallback(async () => {
    if (!client || isBusy) {
      return;
    }
    const label = stashMessage.trim() || `WIP on ${model.branchName || "current branch"}`;
    const confirmed = await confirmDialog({
      title: "Stash Uncommitted Changes?",
      message: `Save uncommitted working tree changes to a new stash entry (${label}) and revert the working directory to HEAD?`,
      confirmLabel: "Stash Changes",
      cancelLabel: "Cancel",
    });
    if (!confirmed) {
      return;
    }
    setIsBusy(true);
    try {
      const response = await client.stashSave(model.cwd, {
        message: stashMessage.trim() || undefined,
        branch: model.branchName ?? undefined,
      });
      if (!response.success) {
        toast.error(response.error?.message ?? "Nothing to stash");
        return;
      }
      setStashMessage("");
      await refreshAfterStashAction();
      toast.show("Saved changes to stash", { variant: "success" });
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Failed to save stash");
    } finally {
      setIsBusy(false);
    }
  }, [client, isBusy, model.branchName, model.cwd, refreshAfterStashAction, stashMessage, toast]);

  const handlePopOrApplyStash = useCallback(
    async (index: number, drop: boolean) => {
      if (!client || isBusy) {
        return;
      }
      const confirmed = await confirmDialog({
        title: drop ? `Pop stash@{${index}}?` : `Apply stash@{${index}}?`,
        message: drop
          ? `Apply stash@{${index}} to your working tree and remove it from the stash list?`
          : `Apply stash@{${index}} to your working tree and keep it in the stash list?`,
        confirmLabel: drop ? "Pop Stash" : "Apply Stash",
        cancelLabel: "Cancel",
      });
      if (!confirmed) {
        return;
      }
      setIsBusy(true);
      try {
        const response = await client.stashPop(model.cwd, index, undefined, {
          action: drop ? "pop" : "apply",
        });
        if (!response.success) {
          toast.error(response.error?.message ?? "Failed to restore stash");
          return;
        }
        await refreshAfterStashAction();
        toast.show(drop ? "Popped stash" : "Applied stash", { variant: "success" });
      } catch (cause) {
        toast.error(cause instanceof Error ? cause.message : "Failed to restore stash");
      } finally {
        setIsBusy(false);
      }
    },
    [client, isBusy, model.cwd, refreshAfterStashAction, toast],
  );

  const handleDropStash = useCallback(
    async (index: number) => {
      if (!client || isBusy) {
        return;
      }
      const confirmed = await confirmDialog({
        title: `Drop stash@{${index}}?`,
        message: `Permanently delete stash@{${index}}? This action cannot be undone.`,
        confirmLabel: "Drop Stash",
        cancelLabel: "Cancel",
        destructive: true,
      });
      if (!confirmed) {
        return;
      }
      setIsBusy(true);
      try {
        const response = await client.stashPop(model.cwd, index, undefined, { action: "drop" });
        if (!response.success) {
          toast.error(response.error?.message ?? "Failed to drop stash");
          return;
        }
        await refreshAfterStashAction();
        toast.show("Dropped stash", { variant: "success" });
      } catch (cause) {
        toast.error(cause instanceof Error ? cause.message : "Failed to drop stash");
      } finally {
        setIsBusy(false);
      }
    },
    [client, isBusy, model.cwd, refreshAfterStashAction, toast],
  );

  if (!client) {
    return null;
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        testID="changes-stash-menu-trigger"
        accessibilityRole="button"
        accessibilityLabel="Git Stash"
        style={toolbarLabelTriggerStyle}
      >
        {(state) => {
          const highlighted = isToolbarLabelTriggerHighlighted(state);
          return (
            <>
              <ToolbarLabelTriggerIcon>
                <StashToolbarIcon size={14} strokeWidth={1.5} />
              </ToolbarLabelTriggerIcon>
              <Text style={toolbarLabelTriggerTextStyle(highlighted)}>
                {entries.length > 0 ? `Stash (${entries.length})` : "Stash"}
              </Text>
            </>
          );
        }}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <View style={styles.stashMenuContent}>
          <View style={styles.stashComposerRow}>
            <EditingTextInput
              initialValue={stashMessage}
              onChangeText={setStashMessage}
              placeholder="Stash message (optional)..."
              placeholderTextColor="#888"
              style={styles.stashInput}
              editable={!isBusy}
              testID="changes-stash-message-input"
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Save stash"
              disabled={isBusy}
              onPress={handleSaveStash}
              style={[styles.stashSaveButton, isBusy ? styles.buttonDisabled : null]}
              testID="changes-stash-save-button"
            >
              <Text style={styles.stashSaveButtonText}>Stash</Text>
            </Pressable>
          </View>
          <DropdownMenuSeparator />
          <StashEntriesList
            isLoading={stashListQuery.isLoading}
            entries={entries}
            isBusy={isBusy}
            onApplyOrPop={handlePopOrApplyStash}
            onDrop={handleDropStash}
          />
        </View>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ChangesMergeMenu({ model }: { model: ChangesRepositoryToolbarModel }) {
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const toast = useToast();
  const queryClient = useQueryClient();
  const client = useSessionStore((state) => state.sessions[model.serverId]?.client ?? null);
  const mergeBranchesQueryKey = useMemo(
    () => ["mergeBranches", model.serverId, model.workspaceId ?? model.cwd] as const,
    [model.cwd, model.serverId, model.workspaceId],
  );
  const mergeBranchesQuery = useFetchQuery({
    queryKey: mergeBranchesQueryKey,
    dataShape: "list",
    staleTimeMs: 5_000,
    enabled: Boolean(client),
    queryFn: async () => {
      if (!client) {
        return {
          branches: [],
          remoteBranches: [],
          currentBranch: model.branchName,
          conflictState: { inProgress: null, conflictFiles: [] as string[] },
        };
      }
      const res = await client.queryGitGraphLog(model.cwd, {
        allBranches: true,
        limit: 10,
      });
      return {
        branches: res.branches ?? [],
        remoteBranches: res.remoteBranches ?? [],
        currentBranch: res.currentBranch ?? model.branchName,
        conflictState: res.conflictState ?? { inProgress: null, conflictFiles: [] as string[] },
      };
    },
  });

  const currentBranch = mergeBranchesQuery.data?.currentBranch ?? model.branchName ?? "HEAD";
  const conflictState = mergeBranchesQuery.data?.conflictState ?? {
    inProgress: null,
    conflictFiles: [] as string[],
  };
  const conflictCount = conflictState.conflictFiles.length;

  const filteredLocalBranches = useMemo(() => {
    const list = (mergeBranchesQuery.data?.branches ?? []).filter(
      (b) => !b.isCurrent && b.name !== currentBranch,
    );
    const q = searchQuery.trim().toLowerCase();
    if (!q) return list;
    return list.filter((b) => b.name.toLowerCase().includes(q));
  }, [currentBranch, mergeBranchesQuery.data?.branches, searchQuery]);

  const filteredRemoteBranches = useMemo(() => {
    const list = mergeBranchesQuery.data?.remoteBranches ?? [];
    const q = searchQuery.trim().toLowerCase();
    if (!q) return list;
    return list.filter((b) => b.name.toLowerCase().includes(q));
  }, [mergeBranchesQuery.data?.remoteBranches, searchQuery]);

  const refreshGitState = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: mergeBranchesQueryKey });
    await invalidateCheckoutGitQueriesForClient(queryClient, {
      serverId: model.serverId,
      cwd: model.cwd,
    });
  }, [mergeBranchesQueryKey, model.cwd, model.serverId, queryClient]);

  const handleBranchAction = useCallback(
    async (kind: "merge-ref" | "rebase-onto" | "checkout-ref", targetRef: string) => {
      if (!client || isBusy) {
        return;
      }
      if (kind === "merge-ref" || kind === "rebase-onto") {
        setOpen(false);
        const isMerge = kind === "merge-ref";
        const confirmed = await confirmDialog({
          title: isMerge
            ? `Merge '${targetRef}' into '${currentBranch}'?`
            : `Rebase '${currentBranch}' onto '${targetRef}'?`,
          message: isMerge
            ? `Merge changes from '${targetRef}' into current branch '${currentBranch}'. Uncommitted local changes will be auto-stashed and restored automatically.`
            : `Rebase current branch '${currentBranch}' onto '${targetRef}'. Uncommitted local changes will be auto-stashed and restored automatically.`,
          confirmLabel: isMerge ? "Merge Branch" : "Rebase Branch",
          cancelLabel: "Cancel",
          branchFlow: isMerge
            ? { from: targetRef, to: currentBranch, actionLabel: "MERGE INTO" }
            : { from: currentBranch, to: targetRef, actionLabel: "REBASE ONTO" },
          badges: [
            { label: "Auto-Stash: ON", tone: "emerald" },
            { label: "3-Way Conflict Resolver", tone: "cyan" },
          ],
        });
        if (!confirmed) {
          return;
        }
      }
      setIsBusy(true);
      try {
        const response = await client.runGitLogAction(model.cwd, {
          kind,
          target: targetRef,
        });
        await refreshGitState();
        const msg = response.message || `Completed ${kind} ${targetRef}`;
        if (msg.startsWith("CONFLICT:")) {
          toast.error(msg);
          setOpen(false);
          const refreshed = await client.queryGitGraphLog(model.cwd, {
            allBranches: false,
            limit: 5,
          });
          model.onOpenConflictResolver?.(
            refreshed.conflictState?.conflictFiles ?? [],
            refreshed.conflictState?.inProgress ?? "merge",
          );
          return;
        }
        toast.show(msg, { variant: "success" });
        setOpen(false);
      } catch (cause) {
        await refreshGitState();
        toast.error(cause instanceof Error ? cause.message : `Git ${kind} failed`);
      } finally {
        setIsBusy(false);
      }
    },
    [client, currentBranch, isBusy, model, refreshGitState, toast],
  );

  const handleOperationControl = useCallback(
    async (kind: "continue-operation" | "abort-operation") => {
      if (!client || isBusy) {
        return;
      }
      setIsBusy(true);
      try {
        const res = await client.runGitLogAction(model.cwd, {
          kind,
          target: "auto",
        });
        await refreshGitState();
        toast.show(res.message || `Completed ${kind}`, { variant: "success" });
      } catch (cause) {
        toast.error(cause instanceof Error ? cause.message : `Failed ${kind}`);
      } finally {
        setIsBusy(false);
      }
    },
    [client, isBusy, model.cwd, refreshGitState, toast],
  );

  if (!client) {
    return null;
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        testID="changes-merge-menu-trigger"
        accessibilityRole="button"
        accessibilityLabel="NDL-Git Quick Merge & Branch Actions"
        style={(state) => [
          toolbarLabelTriggerStyle(state),
          conflictCount > 0 ? styles.mergeToolbarTriggerConflict : styles.mergeToolbarTriggerNormal,
        ]}
      >
        {(state) => {
          const highlighted = isToolbarLabelTriggerHighlighted(state);
          return (
            <>
              <ToolbarLabelTriggerIcon>
                {conflictCount > 0 ? (
                  <AlertTriangle size={13} color="#f59e0b" />
                ) : (
                  <GitMerge size={13} color="#10b981" />
                )}
              </ToolbarLabelTriggerIcon>
              <Text
                style={[
                  toolbarLabelTriggerTextStyle(highlighted),
                  conflictCount > 0
                    ? { color: "#f59e0b", fontWeight: "700" as const }
                    : { color: "#10b981", fontWeight: "600" as const },
                ]}
              >
                {conflictCount > 0 ? `Conflicts (${conflictCount})` : "Merge..."}
              </Text>
            </>
          );
        }}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <View style={styles.mergeMenuContent} testID="changes-merge-menu-content">
          <View style={styles.mergeMenuHeaderRow}>
            <Text style={styles.mergeMenuHeaderTitle} numberOfLines={1}>
              Merge / Rebase into{" "}
              <Text style={styles.mergeMenuCurrentBranchHighlight}>{currentBranch}</Text>
            </Text>
            <Text style={styles.mergeMenuAutoStashBadge}>Auto-Stash ON</Text>
          </View>

          {conflictCount > 0 || conflictState.inProgress ? (
            <View style={styles.mergeConflictCalloutBox}>
              <View style={styles.mergeConflictCalloutHeader}>
                <AlertTriangle size={13} color="#f59e0b" />
                <Text style={styles.mergeConflictCalloutTitle}>
                  {conflictState.inProgress
                    ? `${conflictState.inProgress.toUpperCase()} IN PROGRESS`
                    : "UNRESOLVED CONFLICTS"}{" "}
                  ({conflictCount} file{conflictCount === 1 ? "" : "s"})
                </Text>
              </View>
              <View style={styles.mergeConflictCalloutActions}>
                {conflictCount > 0 ? (
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => {
                      setOpen(false);
                      model.onOpenConflictResolver?.(
                        conflictState.conflictFiles,
                        conflictState.inProgress ?? "merge",
                      );
                    }}
                    style={styles.mergeResolvePrimaryBtn}
                    testID="changes-merge-open-3way-resolver"
                  >
                    <Text style={styles.mergeResolvePrimaryBtnText}>
                      Resolve in 3-Way Merge ({conflictCount})
                    </Text>
                  </Pressable>
                ) : null}
                {conflictState.inProgress ? (
                  <Pressable
                    accessibilityRole="button"
                    disabled={isBusy}
                    onPress={() => void handleOperationControl("continue-operation")}
                    style={styles.mergeContinuePill}
                  >
                    <Text style={styles.mergeContinuePillText}>Continue</Text>
                  </Pressable>
                ) : null}
                {conflictState.inProgress ? (
                  <Pressable
                    accessibilityRole="button"
                    disabled={isBusy}
                    onPress={() => void handleOperationControl("abort-operation")}
                    style={styles.mergeAbortPill}
                  >
                    <Text style={styles.mergeAbortPillText}>Abort</Text>
                  </Pressable>
                ) : null}
              </View>
            </View>
          ) : null}

          <View style={styles.stashComposerRow}>
            <EditingTextInput
              initialValue={searchQuery}
              onChangeText={setSearchQuery}
              placeholder={`Search branch to merge into '${currentBranch}'...`}
              placeholderTextColor="#888"
              style={styles.stashInput}
              editable={!isBusy}
              testID="changes-merge-search-input"
            />
          </View>
          <DropdownMenuSeparator />

          <ScrollView
            style={styles.mergeBranchesScroll}
            nestedScrollEnabled
            showsVerticalScrollIndicator
          >
            {mergeBranchesQuery.isLoading ? (
              <View style={styles.stashEmptyRow}>
                <ThemedLoadingSpinner size="small" uniProps={foregroundMutedIconColorMapping} />
              </View>
            ) : filteredLocalBranches.length === 0 && filteredRemoteBranches.length === 0 ? (
              <View style={styles.stashEmptyRow}>
                <Text style={styles.stashEmptyText}>No other branches found</Text>
              </View>
            ) : (
              <>
                {filteredLocalBranches.length > 0 ? (
                  <View style={styles.mergeSectionGroup}>
                    <Text style={styles.mergeSectionHeader}>
                      LOCAL BRANCHES ({filteredLocalBranches.length})
                    </Text>
                    {filteredLocalBranches.map((b) => (
                      <View
                        key={`merge-local-${b.name}`}
                        style={styles.mergeBranchRow}
                        testID={`changes-merge-branch-row-${b.name}`}
                      >
                        <View style={styles.mergeBranchInfo}>
                          <GitBranch size={12} color="#10b981" />
                          <Text style={styles.mergeBranchName} numberOfLines={1}>
                            {b.name}
                          </Text>
                          {(b.ahead ?? 0) > 0 || (b.behind ?? 0) > 0 ? (
                            <Text style={styles.mergeBranchAheadBehind}>
                              {(b.ahead ?? 0) > 0 ? `↑${b.ahead}` : ""}
                              {(b.behind ?? 0) > 0 ? `↓${b.behind}` : ""}
                            </Text>
                          ) : null}
                        </View>
                        <View style={styles.mergeBranchActions}>
                          <Pressable
                            accessibilityRole="button"
                            disabled={isBusy}
                            onPress={() => void handleBranchAction("merge-ref", b.name)}
                            style={[
                              styles.mergeActionPillPrimary,
                              isBusy ? styles.buttonDisabled : null,
                            ]}
                            testID={`changes-merge-into-current-${b.name}`}
                          >
                            <Text style={styles.mergeActionPillPrimaryText}>Merge into</Text>
                          </Pressable>
                          <Pressable
                            accessibilityRole="button"
                            disabled={isBusy}
                            onPress={() => void handleBranchAction("rebase-onto", b.name)}
                            style={[
                              styles.mergeActionPillCyan,
                              isBusy ? styles.buttonDisabled : null,
                            ]}
                            testID={`changes-rebase-onto-${b.name}`}
                          >
                            <Text style={styles.mergeActionPillCyanText}>Rebase</Text>
                          </Pressable>
                          <Pressable
                            accessibilityRole="button"
                            disabled={isBusy}
                            onPress={() => void handleBranchAction("checkout-ref", b.name)}
                            style={[styles.stashActionPill, isBusy ? styles.buttonDisabled : null]}
                            testID={`changes-checkout-branch-${b.name}`}
                          >
                            <Text style={styles.stashActionPillText}>Checkout</Text>
                          </Pressable>
                        </View>
                      </View>
                    ))}
                  </View>
                ) : null}

                {filteredRemoteBranches.length > 0 ? (
                  <View style={styles.mergeSectionGroup}>
                    <Text style={styles.mergeSectionHeader}>
                      REMOTE BRANCHES ({filteredRemoteBranches.length})
                    </Text>
                    {filteredRemoteBranches.map((rb) => (
                      <View
                        key={`merge-remote-${rb.name}`}
                        style={styles.mergeBranchRow}
                        testID={`changes-merge-remote-row-${rb.name}`}
                      >
                        <View style={styles.mergeBranchInfo}>
                          <GitBranch size={12} color="#06b6d4" />
                          <Text style={styles.mergeBranchName} numberOfLines={1}>
                            {rb.name}
                          </Text>
                        </View>
                        <View style={styles.mergeBranchActions}>
                          <Pressable
                            accessibilityRole="button"
                            disabled={isBusy}
                            onPress={() => void handleBranchAction("merge-ref", rb.name)}
                            style={[
                              styles.mergeActionPillPrimary,
                              isBusy ? styles.buttonDisabled : null,
                            ]}
                            testID={`changes-merge-into-current-${rb.name}`}
                          >
                            <Text style={styles.mergeActionPillPrimaryText}>Merge into</Text>
                          </Pressable>
                          <Pressable
                            accessibilityRole="button"
                            disabled={isBusy}
                            onPress={() => void handleBranchAction("rebase-onto", rb.name)}
                            style={[
                              styles.mergeActionPillCyan,
                              isBusy ? styles.buttonDisabled : null,
                            ]}
                            testID={`changes-rebase-onto-${rb.name}`}
                          >
                            <Text style={styles.mergeActionPillCyanText}>Rebase</Text>
                          </Pressable>
                          <Pressable
                            accessibilityRole="button"
                            disabled={isBusy}
                            onPress={() => void handleBranchAction("checkout-ref", rb.name)}
                            style={[styles.stashActionPill, isBusy ? styles.buttonDisabled : null]}
                            testID={`changes-checkout-branch-${rb.name}`}
                          >
                            <Text style={styles.stashActionPillText}>Checkout</Text>
                          </Pressable>
                        </View>
                      </View>
                    ))}
                  </View>
                ) : null}
              </>
            )}
          </ScrollView>
        </View>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ChangesRepositoryToolbar({
  compact,
  model,
  sidebarSurface,
}: {
  compact: boolean;
  model: ChangesRepositoryToolbarModel;
  sidebarSurface: boolean;
}) {
  return (
    <ChangesToolbarRow
      compact={compact}
      sidebarSurface={sidebarSurface}
      testID="changes-repository-header"
      trailing={model.gitActions ? "framed" : "glyph"}
    >
      <ChangesToolbarLeading>
        <BranchSwitcher
          compact
          currentBranchName={model.branchName}
          serverId={model.serverId}
          workspaceId={model.workspaceId ?? model.cwd}
          workspaceDirectory={model.cwd}
          isGitCheckout
          onOpenConflictResolver={model.onOpenConflictResolver}
          testID="changes-branch-switcher"
        />
      </ChangesToolbarLeading>
      <ChangesToolbarTrailing>
        {model.pullRequest ? (
          <>
            <ChangesPullRequestLink model={model.pullRequest} />
            <ChangesPullRequestExternalLink compact={compact} model={model.pullRequest} />
          </>
        ) : null}
        <ChangesMergeMenu model={model} />
        {model.onOpenGitLog ? (
          <Pressable
            testID="changes-open-git-log-button"
            accessibilityRole="button"
            accessibilityLabel="Open NDL-Git Log (Cmd+9)"
            onPress={model.onOpenGitLog}
            style={toolbarLabelTriggerStyle}
          >
            {(state) => {
              const highlighted = isToolbarLabelTriggerHighlighted(state);
              return (
                <>
                  <ToolbarLabelTriggerIcon>
                    <GitLogToolbarIcon size={14} strokeWidth={1.5} />
                  </ToolbarLabelTriggerIcon>
                  <Text style={toolbarLabelTriggerTextStyle(highlighted)}>NDL-Git</Text>
                </>
              );
            }}
          </Pressable>
        ) : null}
        <ChangesStashMenu model={model} />
        {model.gitActions ? <GitActionsSplitButton gitActions={model.gitActions} menuOnly /> : null}
      </ChangesToolbarTrailing>
    </ChangesToolbarRow>
  );
}

function ChangesPullRequestLink({ model }: { model: ChangesPullRequestLinkModel }) {
  const { t } = useTranslation();
  const presentation = getForgePresentation(model.forge);
  const label = `${presentation.numberPrefix}${model.number}`;
  return (
    <Tooltip delayDuration={300} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger
        testID="changes-open-pull-request"
        accessibilityRole="button"
        accessibilityLabel={`${t("panels.pullRequest.label")} ${label}`}
        onPress={model.onOpen}
        style={toolbarLabelTriggerStyle}
      >
        {(state) => {
          const highlighted = isToolbarLabelTriggerHighlighted(state);
          return (
            <>
              <ToolbarLabelTriggerIcon>
                <PullRequestStateIcon state={model.state} size={14} strokeWidth={1.5} />
              </ToolbarLabelTriggerIcon>
              <Text style={toolbarLabelTriggerTextStyle(highlighted)}>{label}</Text>
            </>
          );
        }}
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <Text style={styles.tooltipText}>{t("panels.pullRequest.label")}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

function ChangesPullRequestExternalLink({
  compact,
  model,
}: {
  compact: boolean;
  model: ChangesPullRequestLinkModel;
}) {
  const { t } = useTranslation();
  const presentation = getForgePresentation(model.forge);
  const label = t("workspace.git.pr.actions.openOn", { brand: presentation.brandLabel });
  const handlePress = useCallback(() => {
    void openExternalUrl(model.url);
  }, [model.url]);
  return (
    <ToolbarButton
      compact={compact}
      label={label}
      onPress={handlePress}
      testID="changes-open-pull-request-external"
    >
      <ThemedExternalLink
        size={paneContentToolbarIconSize(compact)}
        strokeWidth={1.5}
        uniProps={extraMutedIconColorMapping}
      />
    </ToolbarButton>
  );
}

function ChangesComparisonToolbar({
  compact,
  model,
  sidebarSurface,
}: {
  compact: boolean;
  model: ChangesComparisonToolbarModel;
  sidebarSurface: boolean;
}) {
  return (
    <ChangesToolbarRow
      compact={compact}
      sidebarSurface={sidebarSurface}
      testID="changes-header"
      trailing="glyph"
    >
      <ChangesToolbarLeading>
        <DiffModeMenu
          diffMode={model.diffMode}
          committedDescription={model.committedDescription}
          onSelectUncommitted={model.onSelectUncommitted}
          onSelectBase={model.onSelectBase}
          onSelectAll={model.onSelectAll}
        />
        {model.selectedDiffStat ? (
          <DiffStat
            additions={model.selectedDiffStat.additions}
            deletions={model.selectedDiffStat.deletions}
            testID="changes-selected-diff-stat"
          />
        ) : null}
      </ChangesToolbarLeading>
      <ChangesToolbarTrailing>
        <ChangesToolbarActions mode={model.mode} compact={compact} />
      </ChangesToolbarTrailing>
    </ChangesToolbarRow>
  );
}

function ChangesToolbarActions({ mode, compact }: { mode: ChangesToolbarMode; compact: boolean }) {
  if (mode.kind === "tree") {
    return (
      <>
        {mode.refresh ? <ChangesRefreshButton refresh={mode.refresh} compact={compact} /> : null}
        <ChangesOptionsMenu mode={mode} compact={compact} />
      </>
    );
  }
  if (mode.kind === "diff") {
    return (
      <>
        {mode.refresh ? <ChangesRefreshButton refresh={mode.refresh} compact={compact} /> : null}
        <ChangesDiffToolbar options={mode.options} compact={compact} />
      </>
    );
  }
  return (
    <>
      {mode.treeToggle ? (
        <TreeRailToggle
          visible={mode.treeToggle.visible}
          testID="changes-toggle-tree"
          onToggle={mode.treeToggle.onToggle}
        />
      ) : null}
      {mode.refresh ? <ChangesRefreshButton refresh={mode.refresh} compact={compact} /> : null}
      <ChangesOptionsMenu mode={mode} compact={compact} />
    </>
  );
}

function ChangesDiffToolbar({
  options,
  compact,
}: {
  options: ChangesToolbarDiffOptions;
  compact: boolean;
}) {
  const { t } = useTranslation();
  const iconSize = paneContentToolbarIconSize(compact);
  const collapseLabel = t(
    options.collapse?.allFilesCollapsed
      ? "workspace.git.diff.expandAllFiles"
      : "workspace.git.diff.collapseAllFiles",
  );
  const whitespaceLabel = options.hideWhitespace
    ? t("workspace.git.diff.showWhitespace")
    : t("workspace.git.diff.hideWhitespace");
  const wrapLinesLabel = options.wrapLines
    ? t("workspace.git.diff.scrollLongLines")
    : t("workspace.git.diff.wrapLongLines");
  const layoutLabel =
    options.layout?.value === "split"
      ? t("workspace.git.diff.switchToUnified")
      : t("workspace.git.diff.switchToSplit");
  return (
    <>
      {options.collapse ? (
        <ToolbarButton
          compact={compact}
          label={collapseLabel}
          testID="changes-toggle-collapse-all"
          onPress={
            options.collapse.allFilesCollapsed
              ? options.collapse.onExpandAll
              : options.collapse.onCollapseAll
          }
        >
          {options.collapse.allFilesCollapsed ? (
            <ThemedListChevronsUpDown size={iconSize} uniProps={extraMutedIconColorMapping} />
          ) : (
            <ThemedListChevronsDownUp size={iconSize} uniProps={extraMutedIconColorMapping} />
          )}
        </ToolbarButton>
      ) : null}
      {options.layout ? (
        <ToolbarButton
          compact={compact}
          label={layoutLabel}
          selected={options.layout.value === "split"}
          testID="changes-toggle-layout"
          onPress={options.layout.onToggle}
        >
          <ThemedColumns2 size={iconSize} uniProps={extraMutedIconColorMapping} />
        </ToolbarButton>
      ) : null}
      <ToolbarButton
        compact={compact}
        label={whitespaceLabel}
        selected={options.hideWhitespace}
        testID="changes-toggle-whitespace"
        onPress={options.onToggleHideWhitespace}
      >
        <ThemedPilcrow size={iconSize} uniProps={extraMutedIconColorMapping} />
      </ToolbarButton>
      <ToolbarButton
        compact={compact}
        label={wrapLinesLabel}
        selected={options.wrapLines}
        testID="changes-toggle-wrap-lines"
        onPress={options.onToggleWrapLines}
      >
        <ThemedWrapText size={iconSize} uniProps={extraMutedIconColorMapping} />
      </ToolbarButton>
    </>
  );
}

function ChangesRefreshButton({
  refresh,
  compact,
}: {
  refresh: ChangesToolbarRefreshAction;
  compact: boolean;
}) {
  const { t } = useTranslation();
  const refreshLabel = refresh.isRefreshing
    ? t("workspace.git.diff.refreshing")
    : t("workspace.git.diff.refresh");
  return (
    <ToolbarButton
      label={refreshLabel}
      compact={compact}
      disabled={refresh.isRefreshing}
      testID="changes-refresh"
      onPress={refresh.onRefresh}
    >
      {refresh.isRefreshing ? (
        <ThemedLoadingSpinner
          size={paneContentToolbarIconSize(compact)}
          uniProps={extraMutedIconColorMapping}
        />
      ) : (
        <ThemedRotateCw
          size={paneContentToolbarIconSize(compact)}
          uniProps={extraMutedIconColorMapping}
        />
      )}
    </ToolbarButton>
  );
}

type ChangesOptionsMenuMode = Extract<ChangesToolbarMode, { kind: "tree" | "combined" }>;

function ChangesOptionsMenu({ mode, compact }: { mode: ChangesOptionsMenuMode; compact: boolean }) {
  const { t } = useTranslation();
  const optionsLabel = t("workspace.git.diff.options");
  const content =
    mode.kind === "tree" ? (
      <ChangesTreeOptions onOpenDiff={mode.onOpenDiff} inlineDiff={mode.inlineDiff} />
    ) : (
      <>
        <ChangesDiffOptions options={mode.options} />
        {mode.inlineDiff ? (
          <>
            <DropdownMenuSeparator />
            <ChangesInlineDiffOption toggle={mode.inlineDiff} />
          </>
        ) : null}
      </>
    );

  return (
    <DropdownMenu>
      <ToolbarButton
        kind="menu"
        label={optionsLabel}
        compact={compact}
        testID="changes-options-menu"
      >
        <ThemedMoreHorizontal
          size={paneContentToolbarIconSize(compact)}
          uniProps={extraMutedIconColorMapping}
        />
      </ToolbarButton>
      <DropdownMenuContent align="end" width={240} testID="changes-options-menu-content">
        {content}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ChangesTreeOptions({
  onOpenDiff,
  inlineDiff,
}: {
  onOpenDiff: () => void;
  inlineDiff: ChangesToolbarInlineDiffToggle | null;
}) {
  const { t } = useTranslation();
  return (
    <>
      <DropdownMenuItem
        leading={DIFF_OPTIONS_CHANGES_TAB_ICON}
        testID="changes-open-tab"
        onSelect={onOpenDiff}
      >
        {t("workspace.git.diff.openDiffTab")}
      </DropdownMenuItem>
      {inlineDiff ? (
        <>
          <DropdownMenuSeparator />
          <ChangesInlineDiffOption toggle={inlineDiff} />
        </>
      ) : null}
    </>
  );
}

function ChangesInlineDiffOption({ toggle }: { toggle: ChangesToolbarInlineDiffToggle }) {
  const { t } = useTranslation();
  return (
    <DropdownMenuItem
      selected={toggle.value}
      testID="changes-toggle-inline-diff"
      onSelect={toggle.onToggle}
    >
      {t("workspace.git.diff.inlineDiff")}
    </DropdownMenuItem>
  );
}

function ChangesDiffOptions({ options }: { options: ChangesToolbarDiffOptions }) {
  const { t } = useTranslation();
  const collapseLabel = t(
    options.collapse?.allFilesCollapsed
      ? "workspace.git.diff.expandAllFiles"
      : "workspace.git.diff.collapseAllFiles",
  );
  const whitespaceLabel = options.hideWhitespace
    ? t("workspace.git.diff.showWhitespace")
    : t("workspace.git.diff.hideWhitespace");
  const wrapLinesLabel = options.wrapLines
    ? t("workspace.git.diff.scrollLongLines")
    : t("workspace.git.diff.wrapLongLines");

  return (
    <>
      {options.collapse ? (
        <>
          <DropdownMenuItem
            leading={
              options.collapse.allFilesCollapsed
                ? DIFF_OPTIONS_EXPAND_ICON
                : DIFF_OPTIONS_COLLAPSE_ICON
            }
            testID="changes-toggle-collapse-all"
            onSelect={
              options.collapse.allFilesCollapsed
                ? options.collapse.onExpandAll
                : options.collapse.onCollapseAll
            }
          >
            {collapseLabel}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
        </>
      ) : null}
      {options.layout ? (
        <DropdownMenuItem
          leading={DIFF_OPTIONS_SPLIT_ICON}
          selected={options.layout.value === "split"}
          testID="changes-toggle-layout"
          onSelect={options.layout.onToggle}
        >
          {t("workspace.git.diff.split")}
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuItem
        leading={DIFF_OPTIONS_WHITESPACE_ICON}
        selected={options.hideWhitespace}
        testID="changes-toggle-whitespace"
        onSelect={options.onToggleHideWhitespace}
      >
        {whitespaceLabel}
      </DropdownMenuItem>
      <DropdownMenuItem
        leading={DIFF_OPTIONS_WRAP_ICON}
        selected={options.wrapLines}
        testID="changes-toggle-wrap-lines"
        onSelect={options.onToggleWrapLines}
      >
        {wrapLinesLabel}
      </DropdownMenuItem>
    </>
  );
}

const ThemedRotateCw = withUnistyles(RotateCw);

interface DiffBodyContentProps {
  isStatusLoading: boolean;
  statusErrorMessage: string | null;
  notGit: boolean;
  isDiffLoading: boolean;
  diffErrorMessage: string | null;
  diffTooLarge: boolean;
  hasChanges: boolean;
  emptyMessage: string;
  emptyAction: ChangesEmptyAction | null;
  children: ReactElement;
  checkingRepositoryLabel: string;
  notRepositoryLabel: string;
}

function DiffBodyContent({
  isStatusLoading,
  statusErrorMessage,
  notGit,
  isDiffLoading,
  diffErrorMessage,
  diffTooLarge,
  hasChanges,
  emptyMessage,
  emptyAction,
  children,
  checkingRepositoryLabel,
  notRepositoryLabel,
}: DiffBodyContentProps) {
  if (isStatusLoading) {
    return (
      <View style={styles.loadingContainer}>
        <ThemedLoadingSpinner size="large" uniProps={foregroundMutedIconColorMapping} />
        <Text style={styles.loadingText}>{checkingRepositoryLabel}</Text>
      </View>
    );
  }
  if (statusErrorMessage) {
    return (
      <View style={styles.errorContainer}>
        <Text style={styles.errorText}>{statusErrorMessage}</Text>
      </View>
    );
  }
  if (notGit) {
    return (
      <View style={styles.emptyContainer} testID="changes-not-git">
        <Text style={styles.emptyText}>{notRepositoryLabel}</Text>
      </View>
    );
  }
  if (isDiffLoading) {
    return (
      <View style={styles.loadingContainer}>
        <ThemedLoadingSpinner size="large" uniProps={foregroundMutedIconColorMapping} />
      </View>
    );
  }
  if (diffTooLarge) {
    return <DiffTooLargeState />;
  }
  if (diffErrorMessage) {
    return (
      <View style={styles.errorContainer}>
        <Text style={styles.errorText}>{diffErrorMessage}</Text>
      </View>
    );
  }
  if (!hasChanges) {
    return (
      <View style={styles.emptyContainer}>
        <Text style={styles.emptyText}>{emptyMessage}</Text>
        {emptyAction ? (
          <Button
            variant="ghost"
            size="xs"
            testID="changes-empty-switch-mode"
            onPress={emptyAction.onPress}
          >
            {emptyAction.label}
          </Button>
        ) : null}
      </View>
    );
  }
  return children;
}

function computeBaseRefLabel(baseRef: string | undefined, fallbackLabel: string): string {
  if (!baseRef) return fallbackLabel;
  const trimmed = baseRef.replace(/^refs\/(heads|remotes)\//, "").trim();
  return trimmed.startsWith("origin/") ? trimmed.slice("origin/".length) : trimmed;
}

function computeCommittedDiffDescription(
  branchLabel: string,
  baseRefLabel: string,
): string | undefined {
  if (!branchLabel || !baseRefLabel) {
    return undefined;
  }
  return branchLabel === baseRefLabel ? undefined : `${branchLabel} -> ${baseRefLabel}`;
}

interface ChangesEmptyAction {
  label: string;
  onPress: () => void;
}

function computeChangesEmptyAction(input: {
  hideWhitespace: boolean;
  diffMode: "uncommitted" | "base" | "all";
  status: CheckoutStatusPayload | null;
  seeUncommittedLabel: string;
  seeCommittedLabel: string;
  selectUncommitted: () => void;
  selectBase: () => void;
}): ChangesEmptyAction | null {
  if (input.hideWhitespace || !input.status?.isGit) {
    return null;
  }
  if (input.diffMode === "base" && input.status.isDirty) {
    return { label: input.seeUncommittedLabel, onPress: input.selectUncommitted };
  }
  if (input.diffMode === "uncommitted" && (input.status.aheadBehind?.ahead ?? 0) > 0) {
    return { label: input.seeCommittedLabel, onPress: input.selectBase };
  }
  return null;
}

function computePrErrorMessage(
  githubFeaturesEnabled: boolean,
  prPayloadError: { message?: string } | null | undefined,
): string | null {
  if (!githubFeaturesEnabled) return null;
  return prPayloadError?.message ?? null;
}

// The precise setup step a workspace needs before its forge features work, or
// null when nothing is actionable (authenticated, or no forge remote at all).
type ForgeSetupAction = "install_cli" | "sign_in" | null;

// Drive the onboarding callout from the forge's auth state so the message names
// the exact next step (install the CLI vs sign in) for whichever forge backs the
// workspace — GitHub included. GitLab additionally requires the host to advertise
// GitLab support, matching the rest of the GitLab UI.
function computeForgeSetupAction(input: {
  forge: Forge;
  forgeProvidersSupported: boolean;
  authState: ForgeAuthState | undefined;
}): ForgeSetupAction {
  // A daemon without pluggable forge support can't operate any non-GitHub forge,
  // so don't offer a setup action for one it can't drive.
  if (input.forge !== "github" && !input.forgeProvidersSupported) {
    return null;
  }
  switch (input.authState) {
    case "cli_missing":
      return "install_cli";
    case "unauthenticated":
      return "sign_in";
    case "authenticated":
    case "no_remote":
    case "error":
      return null;
    default:
      return null;
  }
}

function parseForgeHost(url: string | null | undefined): string | null {
  return url ? (parseGitRemoteLocation(url)?.host ?? null) : null;
}

function buildForgeSetupMessage(input: {
  action: ForgeSetupAction;
  forge: Forge;
  host: string | null;
  t: TFunction;
}): string | null {
  if (!input.action) {
    return null;
  }
  const { brandLabel, signInCli } = getForgePresentation(input.forge);
  // A forge with no known CLI (an unknown/third-party forge rendered neutrally)
  // has no install/sign-in command to interpolate — show neutral guidance
  // rather than the GitLab-specific callout or a null command.
  if (signInCli === null) {
    return input.t("workspace.git.forgeSetup.generic", { brand: brandLabel });
  }
  if (input.action === "install_cli") {
    return input.t("workspace.git.forgeSetup.installCli", { cli: signInCli, brand: brandLabel });
  }
  const command = buildForgeSignInCommand(input.forge, input.host);
  return input.t("workspace.git.forgeSetup.signIn", { command, brand: brandLabel });
}

function buildToggleButtonStyle(
  selected: boolean,
  baseStyles?: StyleProp<ViewStyle> | StyleProp<ViewStyle>[],
  isMobile = false,
): PressableStyleFn {
  return (state) => [baseStyles, paneContentToolbarIconButtonStyle(state, selected, isMobile)];
}

interface JumpToFileVisibility {
  isCompact: boolean;
  presentation: ChangesPresentation;
  hasChanges: boolean;
  isDiffLoading: boolean;
}

/**
 * The room the floating Jump to file action needs over the diff, and zero where
 * it is not offered. Compact users never see the tree rail, so the diff is their
 * only view of what changed; the tree and diff presentations are already halves
 * of a desktop split.
 */
function jumpToFileClearance(visibility: JumpToFileVisibility): number {
  if (!visibility.isCompact || visibility.presentation !== "combined") return 0;
  if (!visibility.hasChanges || visibility.isDiffLoading) return 0;
  return JUMP_TO_FILE_CLEARANCE;
}

function ChangesTreeRail({
  shown,
  children,
  files,
  mode,
  onSelectFile,
  treeWidth,
  onTreeWidthChange,
  collapsedFolderPaths,
  onCollapsedFolderPathsChange,
  checkedPaths,
  onToggleFileCheck,
  onToggleFolderCheck,
}: {
  shown: boolean;
  children: ReactElement;
  files: ParsedDiffFile[];
  mode: WorkingDiffMode;
  onSelectFile: (path: string) => void;
  treeWidth?: number;
  onTreeWidthChange: (width: number) => void;
  collapsedFolderPaths: string[];
  onCollapsedFolderPathsChange: (paths: string[]) => void;
  checkedPaths?: Set<string>;
  onToggleFileCheck?: (path: string) => void;
  onToggleFolderCheck?: (dirPath: string) => void;
}) {
  if (!shown) return children;
  return (
    <TreeRail testID="changes-tree-rail" width={treeWidth ?? 220} onWidthChange={onTreeWidthChange}>
      {children}
      <ChangedFilesTree
        files={files}
        mode={mode}
        onSelectFile={onSelectFile}
        collapsedFolderPaths={collapsedFolderPaths}
        onCollapsedFolderPathsChange={onCollapsedFolderPathsChange}
        checkedPaths={checkedPaths}
        onToggleFileCheck={onToggleFileCheck}
        onToggleFolderCheck={onToggleFolderCheck}
      />
    </TreeRail>
  );
}

function ChangesBody({
  presentation,
  children,
  desktopTreeVisible,
  isMobile,
  files,
  mode,
  onSelectFile,
  treeWidth,
  onTreeWidthChange,
  collapsedFolderPaths,
  onCollapsedFolderPathsChange,
  checkedPaths,
  onToggleFileCheck,
  onToggleFolderCheck,
}: {
  presentation: ChangesPresentation;
  children: ReactElement;
  desktopTreeVisible: boolean;
  isMobile: boolean;
  files: ParsedDiffFile[];
  mode: WorkingDiffMode;
  onSelectFile: (path: string) => void;
  treeWidth?: number;
  onTreeWidthChange: (width: number) => void;
  collapsedFolderPaths: string[];
  onCollapsedFolderPathsChange: (paths: string[]) => void;
  checkedPaths?: Set<string>;
  onToggleFileCheck?: (path: string) => void;
  onToggleFolderCheck?: (dirPath: string) => void;
}) {
  if (presentation === "tree") {
    if (files.length === 0) return children;
    return (
      <ChangedFilesTree
        files={files}
        mode={mode}
        onSelectFile={onSelectFile}
        collapsedFolderPaths={collapsedFolderPaths}
        onCollapsedFolderPathsChange={onCollapsedFolderPathsChange}
        checkedPaths={checkedPaths}
        onToggleFileCheck={onToggleFileCheck}
        onToggleFolderCheck={onToggleFolderCheck}
      />
    );
  }
  if (presentation === "diff") return children;
  return (
    <ChangesTreeRail
      shown={desktopTreeVisible && !isMobile && files.length > 0}
      files={files}
      mode={mode}
      onSelectFile={onSelectFile}
      treeWidth={treeWidth}
      onTreeWidthChange={onTreeWidthChange}
      collapsedFolderPaths={collapsedFolderPaths}
      onCollapsedFolderPathsChange={onCollapsedFolderPathsChange}
      checkedPaths={checkedPaths}
      onToggleFileCheck={onToggleFileCheck}
      onToggleFolderCheck={onToggleFolderCheck}
    >
      {children}
    </ChangesTreeRail>
  );
}

function ChangesCommits({
  presentation,
  serverId,
  cwd,
  collapsed,
  onCommitPress,
  onCollapsedChange,
  onOpenGitLog,
}: {
  presentation: ChangesPresentation;
  serverId: string;
  cwd: string;
  collapsed: boolean;
  onCommitPress: (sha: string) => void;
  onCollapsedChange: (collapsed: boolean) => void;
  onOpenGitLog?: () => void;
}) {
  if (presentation === "diff") return null;
  return (
    <CommitsSection
      serverId={serverId}
      cwd={cwd}
      onCommitPress={onCommitPress}
      collapsed={collapsed}
      onCollapsedChange={onCollapsedChange}
      onOpenGitLog={onOpenGitLog}
    />
  );
}

function useDiffTabNavigation({
  serverId,
  workspaceId,
  cwd,
  isMobile,
  pullRequestOpenLocation,
}: {
  serverId: string;
  workspaceId?: string | null;
  cwd: string;
  isMobile: boolean;
  pullRequestOpenLocation: PullRequestOpenLocation;
}) {
  const openTab = useWorkspaceLayoutStore((state) => state.openTab);
  const openWorkspaceTab = useCallback(
    (workspaceKey: string, target: WorkspaceTabTarget, placement?: WorkspaceTabPlacement) =>
      openTab({ workspaceKey, target, intent: "reveal", placement }),
    [openTab],
  );
  const persistenceKey = useMemo(
    () => buildWorkspaceTabPersistenceKey({ serverId, workspaceId: workspaceId ?? cwd }),
    [cwd, serverId, workspaceId],
  );
  const openDiff = useCallback(() => {
    if (!persistenceKey || isMobile) {
      return;
    }
    openWorkspaceTab(persistenceKey, { kind: "working_diff" }, FOCUSED_PANE_PLACEMENT);
  }, [isMobile, openWorkspaceTab, persistenceKey]);
  const openCommit = useCallback(
    (sha: string) => {
      if (persistenceKey) {
        openWorkspaceTab(persistenceKey, { kind: "commit_diff", sha }, FOCUSED_PANE_PLACEMENT);
      }
    },
    [openWorkspaceTab, persistenceKey],
  );
  const openPullRequest = useCallback(() => {
    if (!persistenceKey) return;
    openWorkspacePullRequest({
      isCompact: isMobile,
      workspaceKey: persistenceKey,
      destination: pullRequestOpenLocation,
    });
  }, [isMobile, persistenceKey, pullRequestOpenLocation]);
  return {
    openDiff,
    openCommit,
    openPullRequest,
  };
}

export function ChangesSurface({
  serverId,
  workspaceId,
  cwd,
  enabled,
  presentation = "combined",
  focusPath,
  focusRequestId,
  onOpenFile,
  onOpenToSide,
  onSelectDiffFile,
  onAddToChat,
  state: changesState,
  onStateChange,
}: ChangesSurfaceProps) {
  const { settings: appSettings } = useAppSettings();
  const { preferences, updatePreferences } = useChangesPreferences();
  const { t } = useTranslation();
  const isMobile = useIsCompactFormFactor();
  const canUseSplitLayout = isWeb && !isMobile;
  const instanceState = changesState ?? defaultChangesState;
  const updateState = onStateChange ?? noopStateChange;
  const wrapLines = preferences.wrapLines;
  const desktopTreeVisible = instanceState.treeVisible;
  const effectiveLayout = resolveDiffLayout(preferences.layout, canUseSplitLayout);
  const collapsedFilePaths = instanceState.collapsedFilePaths;
  const updateCollapsedFilePaths = useCallback(
    (paths: string[]) => updateState({ ...instanceState, collapsedFilePaths: paths }),
    [instanceState, updateState],
  );
  const updateCollapsedFolderPaths = useCallback(
    (paths: string[]) => updateState({ ...instanceState, collapsedFolderPaths: paths }),
    [instanceState, updateState],
  );
  const collapseState = useMemo(
    () => ({ paths: collapsedFilePaths, onChange: updateCollapsedFilePaths }),
    [collapsedFilePaths, updateCollapsedFilePaths],
  );

  const handleToggleWrapLines = useCallback(() => {
    void updatePreferences({ wrapLines: !wrapLines });
  }, [updatePreferences, wrapLines]);

  const handleToggleHideWhitespace = useCallback(() => {
    void updatePreferences({ hideWhitespace: !preferences.hideWhitespace });
  }, [preferences.hideWhitespace, updatePreferences]);

  const handleToggleInlineDiff = useCallback(() => {
    void updatePreferences({ inlineDiff: !preferences.inlineDiff });
  }, [preferences.inlineDiff, updatePreferences]);

  const handleToggleLayout = useCallback(() => {
    const layout = preferences.layout === "unified" ? "split" : "unified";
    void updatePreferences({ layout });
  }, [preferences.layout, updatePreferences]);
  const codeFontSize = appSettings.codeFontSize;

  const toast = useToast();
  const isLocalDaemon = useIsLocalExecution(serverId);
  const { targets: desktopOpenTargets } = useDesktopOpenTargets({
    isLocalExecution: isLocalDaemon,
  });
  const fileManagerTarget = desktopOpenTargets.find((target) => target.kind === "file-manager");
  const {
    openDiff: handleOpenDiff,
    openCommit: handleCommitPress,
    openPullRequest: handleOpenPullRequest,
  } = useDiffTabNavigation({
    serverId,
    workspaceId,
    cwd,
    isMobile,
    pullRequestOpenLocation: appSettings.pullRequestOpenLocation,
  });
  const refreshSupported = useSessionStore(
    (s) => s.sessions[serverId]?.serverInfo?.features?.checkoutRefresh === true,
  );
  const queryClient = useQueryClient();
  const client = useSessionStore((state) => state.sessions[serverId]?.client);
  // COMPAT(fsEntryDuplicate): added in v0.3.0, remove gate after 2027-02-09.
  const fsEntryDuplicateEnabled = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.fsEntryDuplicate === true,
  );
  const runRefresh = useCheckoutGitActionsStore((s) => s.refresh);
  const isRefreshing =
    useCheckoutGitActionsStore((s) => s.getStatus({ serverId, cwd, actionId: "refresh" })) ===
    "pending";

  const handleRefresh = useCallback(() => {
    if (isRefreshing) {
      return;
    }
    void runRefresh({ serverId, cwd }).catch((error) => {
      toast.error(error instanceof Error ? error.message : t("workspace.git.diff.failedRefresh"));
    });
  }, [cwd, isRefreshing, runRefresh, serverId, t, toast]);

  const {
    status,
    isStatusLoading,
    isGit,
    notGit,
    statusErrorMessage,
    baseRef,
    currentBranchName,
    diffMode,
    selectUncommitted: handleSelectUncommitted,
    selectBase: handleSelectBase,
    selectAll: handleSelectAll,
    files,
    diffPayloadError,
    diffTooLarge,
    isDiffLoading,
    reviewActions,
    reviewAttachment,
    reviewFeedback,
  } = useWorkingDiff({
    presentation,
    serverId,
    workspaceId: workspaceId ?? undefined,
    cwd,
    ignoreWhitespace: preferences.hideWhitespace,
    enabled: enabled !== false,
  });
  usePublishWorkingDiffAttachment({
    serverId,
    workspaceId: workspaceId ?? undefined,
    cwd,
    attachment: reviewAttachment,
    enabled: true,
  });
  const {
    status: pullRequestStatus,
    githubFeaturesEnabled,
    forge,
    authState,
    payloadError: prPayloadError,
  } = useCheckoutPrStatusQuery({
    serverId,
    cwd,
    enabled: isGit,
  });
  const forgeProvidersSupported = useSessionStore(
    (s) => s.sessions[serverId]?.serverInfo?.features?.forgeProviders === true,
  );
  const forgeSetupAction = computeForgeSetupAction({
    forge,
    forgeProvidersSupported,
    authState,
  });
  const forgeSetupMessage = useMemo(
    () =>
      buildForgeSetupMessage({
        action: forgeSetupAction,
        forge,
        host: parseForgeHost(status?.remoteUrl),
        t,
      }),
    [forgeSetupAction, forge, status?.remoteUrl, t],
  );
  const handleToggleDesktopTree = useCallback(() => {
    updateState({ ...instanceState, treeVisible: !desktopTreeVisible });
  }, [desktopTreeVisible, instanceState, updateState]);
  const handleCommitsCollapsedChange = useCallback(
    (commitsCollapsed: boolean) => updateState({ ...instanceState, commitsCollapsed }),
    [instanceState, updateState],
  );
  const handleChangesTreeWidth = useCallback(
    (treeWidth: number) => updateState({ ...instanceState, treeWidth }),
    [instanceState, updateState],
  );
  const sharedDisplayPreferences = useMemo(
    () => ({
      layout: effectiveLayout,
      wrapLines,
      codeFontSize,
      monoFontFamily: appSettings.monoFontFamily,
    }),
    [appSettings.monoFontFamily, codeFontSize, effectiveLayout, wrapLines],
  );
  const downloadFile = useFileDownload({ serverId, workspaceId, workspaceRoot: cwd });
  const handleCopyPath = useCallback(
    (path: string) => {
      void Clipboard.setStringAsync(
        buildAbsoluteExplorerPath({ workspaceRoot: cwd, entryPath: path }),
      );
    },
    [cwd],
  );
  const handleCopyRelativePath = useCallback((path: string) => {
    void Clipboard.setStringAsync(path);
  }, []);
  const handleRevealPath = useCallback(
    async (path: string) => {
      if (!fileManagerTarget) {
        return;
      }
      try {
        await openDesktopTarget({
          editorId: fileManagerTarget.id,
          workspacePath: cwd,
          filePath: buildAbsoluteExplorerPath({ workspaceRoot: cwd, entryPath: path }),
        });
      } catch (cause) {
        toast.error(
          cause instanceof Error ? cause.message : t("workspace.fileExplorer.errors.revealFailed"),
        );
      }
    },
    [cwd, fileManagerTarget, t, toast],
  );
  const handleDownloadPath = useCallback(
    (path: string) => {
      downloadFile({ fileName: path.split("/").pop() ?? path, path });
    },
    [downloadFile],
  );
  const handleDuplicatePath = useCallback(
    async (path: string) => {
      if (!client) {
        return;
      }
      try {
        const payload = await client.duplicateFileEntry({ cwd, path });
        if (!payload.success) {
          toast.error(payload.error ?? t("workspace.fileExplorer.errors.duplicateFailed"));
        }
      } catch (cause) {
        toast.error(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [client, cwd, t, toast],
  );
  const onRevertPath = useDiscardChangesAction({ serverId, cwd, diffMode });
  const { onStagePath, onUnstagePath } = useStageAndUnstageActions({ serverId, cwd, diffMode });
  const [localFocusRequest, setLocalFocusRequest] = useState<{
    path: string;
    revision: number;
  } | null>(null);
  const externalFocusRequest = useMemo(
    () => (focusPath ? { path: focusPath, revision: focusRequestId ?? 0 } : null),
    [focusPath, focusRequestId],
  );
  const documentFocusRequest = resolveDocumentFocusRequest(localFocusRequest, externalFocusRequest);
  const handleSelectTreeFile = useCallback(
    (path: string) => {
      if (presentation === "tree" && onSelectDiffFile) {
        onSelectDiffFile(path);
        return;
      }
      setLocalFocusRequest((current) => ({
        path,
        revision: Math.max(Date.now(), (current?.revision ?? 0) + 1),
      }));
    },
    [onSelectDiffFile, presentation],
  );
  const workingMode = useMemo(
    () => ({
      kind: "working" as const,
      reviewActions,
      focusPath: documentFocusRequest?.path,
      focusRequestId: documentFocusRequest?.revision,
      workspaceFileDragScope: workspaceId ? { serverId, workspaceId } : undefined,
      onOpenFile,
      onOpenToSide,
      onAddToChat,
      onCopyPath: handleCopyPath,
      onCopyRelativePath: handleCopyRelativePath,
      onReveal: fileManagerTarget ? handleRevealPath : undefined,
      revealTargetName: fileManagerTarget?.label,
      onDownload: handleDownloadPath,
      onDuplicate: fsEntryDuplicateEnabled ? handleDuplicatePath : undefined,
      onStage: onStagePath,
      onUnstage: onUnstagePath,
      onRevert: onRevertPath,
    }),
    [
      reviewActions,
      documentFocusRequest?.path,
      documentFocusRequest?.revision,
      serverId,
      workspaceId,
      onOpenFile,
      onOpenToSide,
      onAddToChat,
      handleCopyPath,
      handleCopyRelativePath,
      handleDownloadPath,
      handleDuplicatePath,
      handleRevealPath,
      fileManagerTarget,
      fsEntryDuplicateEnabled,
      onStagePath,
      onUnstagePath,
      onRevertPath,
    ],
  );

  const { bottom: bottomInset } = useSafeAreaInsets();
  const hasChanges = files.length > 0;
  const jumpToFileInset = jumpToFileClearance({
    isCompact: isMobile,
    presentation,
    hasChanges,
    isDiffLoading,
  });
  const showJumpToFile = jumpToFileInset > 0;
  const selectedDiffStat = useMemo(
    () => computeSelectedDiffStat(files, isDiffLoading),
    [files, isDiffLoading],
  );
  const allFilesCollapsed =
    hasChanges && files.every((file) => collapsedFilePaths.includes(file.path));
  const handleCollapseAllFiles = useCallback(
    () => updateCollapsedFilePaths(files.map((file) => file.path)),
    [files, updateCollapsedFilePaths],
  );
  const handleExpandAllFiles = useCallback(
    () => updateCollapsedFilePaths([]),
    [updateCollapsedFilePaths],
  );
  const diffErrorMessage = diffPayloadError?.message ?? null;
  const prErrorMessage = computePrErrorMessage(githubFeaturesEnabled, prPayloadError);
  const baseRefLabel = useMemo(
    () => computeBaseRefLabel(baseRef, t("workspace.git.diff.base")),
    [baseRef, t],
  );
  const { gitActions, branchLabel } = useGitActions({
    serverId,
    cwd,
    icons: GIT_ACTION_ICONS,
  });
  const committedDiffDescription = useMemo(
    () => computeCommittedDiffDescription(branchLabel, baseRefLabel),
    [baseRefLabel, branchLabel],
  );
  const emptyMessage = t("diffViewer.empty");
  const emptyAction = computeChangesEmptyAction({
    hideWhitespace: preferences.hideWhitespace,
    diffMode,
    status,
    seeUncommittedLabel: t("workspace.git.diff.seeUncommittedChanges"),
    seeCommittedLabel: t("workspace.git.diff.seeCommittedChanges"),
    selectUncommitted: handleSelectUncommitted,
    selectBase: handleSelectBase,
  });

  const diffContent: ReactElement = (
    <View style={styles.diffContainer}>
      <DiffBodyContent
        isStatusLoading={isStatusLoading}
        statusErrorMessage={statusErrorMessage}
        notGit={notGit}
        isDiffLoading={isDiffLoading}
        diffErrorMessage={diffErrorMessage}
        diffTooLarge={diffTooLarge}
        hasChanges={hasChanges}
        emptyMessage={emptyMessage}
        emptyAction={emptyAction}
        checkingRepositoryLabel={t("workspace.git.diff.checkingRepository")}
        notRepositoryLabel={t("workspace.git.diff.notRepository")}
      >
        <DiffDocument
          files={files}
          contentInsetBottom={floatingActionsClearance(
            [jumpToFileInset, reviewFeedback.clearance],
            bottomInset,
          )}
          collapseState={collapseState}
          displayPreferences={sharedDisplayPreferences}
          mode={workingMode}
        />
      </DiffBodyContent>
      <ReviewFeedbackAction
        bottomOffset={jumpToFileInset}
        enabled={enabled}
        hasDiff={presentation !== "tree"}
        model={reviewFeedback.model}
        state={reviewFeedback.state}
        serverId={serverId}
        workspaceId={workspaceId}
      />
    </View>
  );
  const [gitLogModalOpen, setGitLogModalOpen] = useState(false);
  const handleOpenGitLog = useCallback(() => setGitLogModalOpen(true), []);
  const handleCloseGitLog = useCallback(() => setGitLogModalOpen(false), []);
  const [conflictModalState, setConflictModalState] = useState<{
    open: boolean;
    conflictFiles: string[];
    inProgress: "merge" | "rebase" | "cherry-pick" | "conflict" | null;
  }>({
    open: false,
    conflictFiles: [],
    inProgress: null,
  });
  const handleOpenConflictResolver = useCallback(
    (
      conflictFiles?: string[],
      inProgress?: "merge" | "rebase" | "cherry-pick" | "conflict" | null,
    ) => {
      if (conflictFiles && conflictFiles.length > 0) {
        setConflictModalState({
          open: true,
          conflictFiles,
          inProgress: inProgress ?? "conflict",
        });
        return;
      }
      if (!client || !cwd) {
        setConflictModalState((prev) => ({ ...prev, open: true }));
        return;
      }
      void client
        .queryGitGraphLog(cwd, { limit: 1 })
        .then((res) => {
          setConflictModalState({
            open: true,
            conflictFiles: res.conflictState?.conflictFiles ?? [],
            inProgress: res.conflictState?.inProgress ?? inProgress ?? "conflict",
          });
        })
        .catch(() => {
          setConflictModalState((prev) => ({ ...prev, open: true }));
        });
    },
    [client, cwd],
  );

  useEffect(() => {
    if (!isWeb || !isGit) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "9") {
        event.preventDefault();
        setGitLogModalOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isGit]);

  const [uncheckedPaths, setUncheckedPaths] = useState<Set<string>>(() => new Set());
  const checkedPaths = useMemo(
    () => new Set(files.map((f) => f.path).filter((p) => !uncheckedPaths.has(p))),
    [files, uncheckedPaths],
  );
  const handleToggleFileCheck = useCallback((path: string) => {
    setUncheckedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);
  const handleToggleFolderCheck = useCallback(
    (dirPath: string) => {
      const prefix = `${dirPath}/`;
      const directMatches = files
        .filter((f) => f.path.split("/").slice(0, -1).join("/") === dirPath)
        .map((f) => f.path);
      const folderFilePaths =
        directMatches.length > 0
          ? directMatches
          : files.filter((f) => f.path.startsWith(prefix)).map((f) => f.path);
      setUncheckedPaths((prev) => {
        const next = new Set(prev);
        const allChecked = folderFilePaths.every((p) => !next.has(p));
        if (allChecked) {
          for (const p of folderFilePaths) {
            next.add(p);
          }
        } else {
          for (const p of folderFilePaths) {
            next.delete(p);
          }
        }
        return next;
      });
    },
    [files],
  );

  const bodyContent = (
    <ChangesBody
      presentation={presentation}
      desktopTreeVisible={desktopTreeVisible}
      isMobile={isMobile}
      files={files}
      mode={workingMode}
      onSelectFile={handleSelectTreeFile}
      treeWidth={instanceState.treeWidth}
      onTreeWidthChange={handleChangesTreeWidth}
      collapsedFolderPaths={instanceState.collapsedFolderPaths}
      onCollapsedFolderPathsChange={updateCollapsedFolderPaths}
      checkedPaths={diffMode === "uncommitted" ? checkedPaths : undefined}
      onToggleFileCheck={diffMode === "uncommitted" ? handleToggleFileCheck : undefined}
      onToggleFolderCheck={diffMode === "uncommitted" ? handleToggleFolderCheck : undefined}
    >
      {diffContent}
    </ChangesBody>
  );
  const toolbarMode = useMemo(
    () =>
      buildChangesToolbarMode({
        presentation,
        compact: isMobile,
        hasChanges,
        canUseSplitLayout,
        refreshSupported,
        isRefreshing,
        layout: preferences.layout,
        hideWhitespace: preferences.hideWhitespace,
        wrapLines,
        treeVisible: desktopTreeVisible,
        onOpenDiff: handleOpenDiff,
        inlineDiff: !isMobile
          ? { value: preferences.inlineDiff, onToggle: handleToggleInlineDiff }
          : null,
        onRefresh: handleRefresh,
        onCollapseAll: handleCollapseAllFiles,
        onExpandAll: handleExpandAllFiles,
        allFilesCollapsed,
        onToggleLayout: handleToggleLayout,
        onToggleHideWhitespace: handleToggleHideWhitespace,
        onToggleWrapLines: handleToggleWrapLines,
        onToggleTree: handleToggleDesktopTree,
      }),
    [
      allFilesCollapsed,
      canUseSplitLayout,
      desktopTreeVisible,
      handleCollapseAllFiles,
      handleExpandAllFiles,
      handleOpenDiff,
      handleToggleInlineDiff,
      handleRefresh,
      handleToggleDesktopTree,
      handleToggleHideWhitespace,
      handleToggleLayout,
      handleToggleWrapLines,
      hasChanges,
      preferences.hideWhitespace,
      preferences.inlineDiff,
      preferences.layout,
      isMobile,
      isRefreshing,
      presentation,
      refreshSupported,
      wrapLines,
    ],
  );
  const changesHeaderModel = useMemo(
    () =>
      buildChangesHeaderModel({
        branchName: currentBranchName,
        committedDescription: committedDiffDescription,
        compact: isMobile,
        cwd,
        diffMode,
        gitActions,
        mode: toolbarMode,
        onOpenConflictResolver: handleOpenConflictResolver,
        onOpenGitLog: handleOpenGitLog,
        onOpenPullRequest: handleOpenPullRequest,
        onSelectBase: handleSelectBase,
        onSelectAll: handleSelectAll,
        onSelectUncommitted: handleSelectUncommitted,
        pullRequest: selectPrHintFromStatus(pullRequestStatus, forge),
        selectedDiffStat,
        serverId,
        workspaceId,
      }),
    [
      committedDiffDescription,
      currentBranchName,
      cwd,
      diffMode,
      gitActions,
      handleOpenConflictResolver,
      handleOpenGitLog,
      handleOpenPullRequest,
      handleSelectBase,
      handleSelectAll,
      handleSelectUncommitted,
      isMobile,
      forge,
      pullRequestStatus,
      selectedDiffStat,
      serverId,
      toolbarMode,
      workspaceId,
    ],
  );
  const showCommitComposer = shouldRenderCommitComposer(isGit, diffMode, hasChanges);

  return (
    <View
      {...{
        onContextMenu: (event: { preventDefault?: () => void }) => event.preventDefault?.(),
      }}
      style={styles.container}
    >
      {isGit ? (
        <ChangesHeader
          compact={isMobile}
          repository={changesHeaderModel.repository}
          comparison={changesHeaderModel.comparison}
          sidebarSurface={presentation === "tree"}
        />
      ) : null}

      {showCommitComposer ? (
        <ChangesCommitComposer
          serverId={serverId}
          cwd={cwd}
          files={files}
          checkedPaths={checkedPaths}
        />
      ) : null}

      {forgeSetupMessage ? (
        <View style={styles.forgeSetupCallout} testID="forge-setup-callout">
          <Text style={styles.forgeSetupCalloutText}>{forgeSetupMessage}</Text>
        </View>
      ) : null}

      {prErrorMessage ? <Text style={styles.actionErrorText}>{prErrorMessage}</Text> : null}

      <View style={styles.diffContainer}>
        {bodyContent}
        {showJumpToFile ? (
          <JumpToFile files={files} mode={workingMode} onSelectFile={handleSelectTreeFile} />
        ) : null}
      </View>

      <ReviewCommentSheet
        enabled={enabled}
        editor={reviewActions.sheetEditor}
        reviewActions={reviewActions}
        onChangeBody={reviewActions.onChangeEditorBody}
      />

      <ChangesCommits
        presentation={presentation}
        serverId={serverId}
        cwd={cwd}
        onCommitPress={handleCommitPress}
        collapsed={instanceState.commitsCollapsed}
        onCollapsedChange={handleCommitsCollapsedChange}
        onOpenGitLog={handleOpenGitLog}
      />

      {isGit ? (
        <>
          <NdlGitModal
            visible={gitLogModalOpen}
            onClose={handleCloseGitLog}
            serverId={serverId}
            cwd={cwd}
            onOpenCommitTab={handleCommitPress}
          />
          <MergeConflictResolverModal
            visible={conflictModalState.open}
            onClose={() => setConflictModalState((prev) => ({ ...prev, open: false }))}
            serverId={serverId}
            cwd={cwd}
            conflictFiles={conflictModalState.conflictFiles}
            inProgressOperation={conflictModalState.inProgress}
            onResolved={() => {
              void invalidateCheckoutGitQueriesForClient(queryClient, { serverId, cwd });
              setConflictModalState((prev) => ({ ...prev, open: false }));
            }}
          />
        </>
      ) : null}
    </View>
  );
}

function resolveDocumentFocusRequest(
  localFocusRequest: { path: string; revision: number } | null,
  externalFocusRequest: { path: string; revision: number } | null,
) {
  if (!localFocusRequest) {
    return externalFocusRequest;
  }
  if (!externalFocusRequest || localFocusRequest.revision >= externalFocusRequest.revision) {
    return localFocusRequest;
  }
  return externalFocusRequest;
}

function shouldRenderCommitComposer(
  isGit: boolean,
  diffMode: string,
  hasChanges: boolean,
): boolean {
  return isGit && diffMode === "uncommitted" && hasChanges;
}

function resolveCommitButtonLabel(
  isCommitting: boolean,
  stagedCount: number,
  checkedCount: number,
  totalCount: number,
  amend: boolean,
): string {
  if (isCommitting) {
    return "Committing...";
  }
  const prefix = amend ? "Amend" : "Commit";
  if (stagedCount > 0) {
    return `${prefix} Staged (${stagedCount})`;
  }
  if (checkedCount < totalCount) {
    return `${prefix} Checked (${checkedCount})`;
  }
  return `${prefix} All (${totalCount})`;
}

function resolveErrorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

function ChangesCommitComposer({
  serverId,
  cwd,
  files,
  checkedPaths,
}: {
  serverId: string;
  cwd: string;
  files: ParsedDiffFile[];
  checkedPaths?: Set<string>;
}) {
  const [commitMessage, setCommitMessage] = useState("");
  const [amend, setAmend] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isStaging, setIsStaging] = useState(false);
  const [inputHeight, setInputHeight] = useState(52);
  const [isDraggingInput, setIsDraggingInput] = useState(false);
  const dragStartYRef = useRef(0);
  const dragStartHeightRef = useRef(52);
  const toast = useToast();
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const commit = useCheckoutGitActionsStore((state) => state.commit);
  const stageChanges = useCheckoutGitActionsStore((state) => state.stageChanges);
  const unstageChanges = useCheckoutGitActionsStore((state) => state.unstageChanges);
  const isCommitting =
    useCheckoutGitActionsStore((state) =>
      state.getStatus({ serverId, cwd, actionId: "commit" }),
    ) === "pending";

  const clampCommitInputHeight = useCallback(
    (value: number) => Math.max(34, Math.min(240, Math.round(value))),
    [],
  );

  const handleWebResizeMouseDown = useCallback(
    (event: { preventDefault?: () => void; clientY?: number }) => {
      if (!isWeb) return;
      event.preventDefault?.();
      const startY = event.clientY ?? 0;
      dragStartYRef.current = startY;
      dragStartHeightRef.current = inputHeight;
      setIsDraggingInput(true);

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const deltaY = moveEvent.clientY - dragStartYRef.current;
        setInputHeight(clampCommitInputHeight(dragStartHeightRef.current + deltaY));
      };
      const handleMouseUp = () => {
        setIsDraggingInput(false);
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", handleMouseUp);
      };
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    },
    [clampCommitInputHeight, inputHeight],
  );

  const inputPanResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => !isWeb,
        onMoveShouldSetPanResponder: (_, gestureState) => !isWeb && Math.abs(gestureState.dy) > 2,
        onPanResponderGrant: () => {
          dragStartHeightRef.current = inputHeight;
          setIsDraggingInput(true);
        },
        onPanResponderMove: (_, gestureState) => {
          setInputHeight(clampCommitInputHeight(dragStartHeightRef.current + gestureState.dy));
        },
        onPanResponderRelease: () => setIsDraggingInput(false),
        onPanResponderTerminate: () => setIsDraggingInput(false),
      }),
    [clampCommitInputHeight, inputHeight],
  );

  const stagedCount = useMemo(() => files.filter((file) => file.staged).length, [files]);
  const unstagedCount = useMemo(
    () => files.filter((file) => !file.staged || file.unstaged).length,
    [files],
  );
  const checkedCount = checkedPaths ? checkedPaths.size : files.length;

  const handleGenerateMessage = useCallback(() => {
    if (!client || isGenerating || isCommitting) {
      return;
    }
    setIsGenerating(true);
    void client
      .checkoutGenerateCommitMessage(cwd)
      .then((response) => {
        if (!response.success || !response.generatedMessage) {
          toast.error(response.error?.message ?? "Could not generate commit message");
          return;
        }
        setCommitMessage(response.generatedMessage);
        return;
      })
      .catch((cause: unknown) => {
        toast.error(resolveErrorMessage(cause, "Failed to generate commit message"));
      })
      .finally(() => {
        setIsGenerating(false);
      });
  }, [client, cwd, isCommitting, isGenerating, toast]);

  const handleStageAll = useCallback(() => {
    if (isStaging || isCommitting || unstagedCount === 0) {
      return;
    }
    setIsStaging(true);
    void stageChanges({ serverId, cwd, all: true })
      .catch((cause: unknown) => {
        toast.error(resolveErrorMessage(cause, "Failed to stage all files"));
      })
      .finally(() => {
        setIsStaging(false);
      });
  }, [cwd, isCommitting, isStaging, serverId, stageChanges, toast, unstagedCount]);

  const handleUnstageAll = useCallback(async () => {
    if (isStaging || isCommitting || stagedCount === 0) {
      return;
    }
    const confirmed = await confirmDialog({
      title: "Unstage All Files",
      message: `Unstage all ${stagedCount} staged file(s) from the index?`,
      confirmLabel: "Unstage All",
      cancelLabel: "Cancel",
    });
    if (!confirmed) {
      return;
    }
    setIsStaging(true);
    void unstageChanges({ serverId, cwd, all: true })
      .catch((cause: unknown) => {
        toast.error(resolveErrorMessage(cause, "Failed to unstage all files"));
      })
      .finally(() => {
        setIsStaging(false);
      });
  }, [cwd, isCommitting, isStaging, serverId, stagedCount, toast, unstageChanges]);

  const executeCommit = useCallback(
    async (pushAfterCommit: boolean) => {
      if (isCommitting || isGenerating) {
        return;
      }
      if (stagedCount === 0 && checkedCount === 0 && !amend) {
        toast.error("Select at least one file to commit");
        return;
      }
      const targetFilesCount = stagedCount > 0 ? stagedCount : checkedCount;
      const trimmedMessage = commitMessage.trim();
      const messagePreview = trimmedMessage
        ? `\n\nCommit message:\n"${trimmedMessage.length > 140 ? `${trimmedMessage.slice(0, 140)}...` : trimmedMessage}"`
        : "\n\nCommit message: ✨ Auto-generated by AI based on your diff.";
      const confirmed = await confirmDialog({
        title: pushAfterCommit
          ? amend
            ? "Amend Commit & Push?"
            : "Commit & Push to Remote?"
          : amend
            ? "Amend Previous Commit (HEAD)?"
            : `Commit ${targetFilesCount} File(s)?`,
        message: `${
          pushAfterCommit
            ? `Commit ${targetFilesCount} file(s)${amend ? " (amending HEAD)" : ""} and push immediately to the remote branch?`
            : amend
              ? `Rewrite the latest commit (HEAD) with ${targetFilesCount} selected file(s)?`
              : `Create a new commit with ${targetFilesCount} selected file(s)?`
        }${messagePreview}`,
        confirmLabel: pushAfterCommit
          ? amend
            ? "Amend & Push"
            : "Commit & Push"
          : amend
            ? "Amend Commit"
            : "Commit",
        cancelLabel: "Cancel",
        destructive: amend,
        badges: [
          { label: `${targetFilesCount} file(s)`, tone: "emerald" },
          ...(amend ? [{ label: "Amend HEAD", tone: "amber" as const }] : []),
          ...(pushAfterCommit ? [{ label: "Push to Remote", tone: "cyan" as const }] : []),
          ...(!trimmedMessage ? [{ label: "✨ AI Commit Message", tone: "blue" as const }] : []),
        ],
      });
      if (!confirmed) {
        return;
      }
      try {
        let shouldAddAll = stagedCount === 0;
        if (stagedCount === 0 && checkedPaths && checkedPaths.size < files.length) {
          shouldAddAll = false;
          if (checkedPaths.size > 0) {
            await stageChanges({
              serverId,
              cwd,
              paths: Array.from(checkedPaths),
            });
          }
        }
        await commit({
          serverId,
          cwd,
          message: trimmedMessage || undefined,
          addAll: shouldAddAll,
          amend,
          push: pushAfterCommit,
        });
        setCommitMessage("");
        setAmend(false);
        toast.show(pushAfterCommit ? "Committed & pushed successfully" : "Committed changes", {
          variant: "success",
        });
      } catch (cause) {
        toast.error(resolveErrorMessage(cause, "Failed to commit changes"));
      }
    },
    [
      amend,
      checkedCount,
      checkedPaths,
      commit,
      commitMessage,
      cwd,
      files.length,
      isCommitting,
      isGenerating,
      serverId,
      stageChanges,
      stagedCount,
      toast,
    ],
  );

  const handleCommit = useCallback(() => {
    void executeCommit(false);
  }, [executeCommit]);

  const handleCommitAndPush = useCallback(() => {
    void executeCommit(true);
  }, [executeCommit]);

  const commitButtonLabel = resolveCommitButtonLabel(
    isCommitting,
    stagedCount,
    checkedCount,
    files.length,
    amend,
  );
  const generateDisabled = !client || isGenerating || isCommitting;
  const stageAllDisabled = unstagedCount === 0 || isStaging || isCommitting;
  const unstageAllDisabled = stagedCount === 0 || isStaging || isCommitting;
  const commitDisabled =
    isCommitting || isGenerating || (stagedCount === 0 && checkedCount === 0 && !amend);

  return (
    <View style={styles.commitComposer} testID="changes-commit-composer">
      <View style={styles.commitInputRow}>
        <EditingTextInput
          initialValue={commitMessage}
          onChangeText={setCommitMessage}
          placeholder="Commit message (leave empty to auto-generate)..."
          placeholderTextColor="#888"
          editable={!commitDisabled}
          multiline
          textAlignVertical="top"
          style={[styles.commitInput, { height: inputHeight }]}
          testID="changes-commit-message-input"
        />
        <Tooltip delayDuration={300} enabledOnDesktop enabledOnMobile={false}>
          <TooltipTrigger
            accessibilityRole="button"
            accessibilityLabel="Generate commit message with AI"
            disabled={generateDisabled}
            onPress={handleGenerateMessage}
            style={[styles.aiGenerateButton, generateDisabled ? styles.buttonDisabled : null]}
            testID="changes-ai-generate-commit-message"
          >
            {isGenerating ? (
              <ThemedLoadingSpinner size="small" uniProps={foregroundMutedIconColorMapping} />
            ) : (
              <SparklesIcon size={13} strokeWidth={1.75} />
            )}
            <Text style={styles.aiGenerateButtonText}>AI</Text>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <Text style={styles.tooltipText}>Auto-generate commit message with AI</Text>
          </TooltipContent>
        </Tooltip>
      </View>
      <View
        {...inputPanResponder.panHandlers}
        // @ts-expect-error web mouse event
        onMouseDown={isWeb ? handleWebResizeMouseDown : undefined}
        style={[
          styles.commitInputResizeHandle,
          isDraggingInput ? styles.commitInputResizeHandleActive : null,
        ]}
        testID="changes-commit-input-resize-handle"
      >
        <View
          style={[
            styles.commitInputResizePill,
            isDraggingInput ? styles.commitInputResizePillActive : null,
          ]}
        />
      </View>
      <View style={styles.commitActionsRow}>
        <View style={styles.stageControlsGroup}>
          <Text style={styles.stageSummaryText}>
            {checkedCount}/{files.length} selected
            {stagedCount > 0 ? ` · ${stagedCount} staged` : ""}
          </Text>
          <Pressable
            accessibilityRole="checkbox"
            accessibilityState={{ checked: amend }}
            accessibilityLabel="Amend previous commit"
            onPress={() => setAmend((prev) => !prev)}
            style={[styles.stageActionPill, amend ? styles.stageActionPillActive : null]}
            testID="changes-amend-checkbox"
          >
            <Text
              style={[styles.stageActionPillText, amend ? styles.stageActionPillTextActive : null]}
            >
              {amend ? "✓ Amend" : "Amend"}
            </Text>
          </Pressable>
          {unstagedCount > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Stage all changes"
              disabled={stageAllDisabled}
              onPress={handleStageAll}
              style={[styles.stageActionPill, stageAllDisabled ? styles.buttonDisabled : null]}
              testID="changes-stage-all-button"
            >
              <Text style={styles.stageActionPillText}>+ Stage</Text>
            </Pressable>
          ) : null}
          {stagedCount > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Unstage all changes"
              disabled={unstageAllDisabled}
              onPress={() => void handleUnstageAll()}
              style={[styles.stageActionPill, unstageAllDisabled ? styles.buttonDisabled : null]}
              testID="changes-unstage-all-button"
            >
              <Text style={styles.stageActionPillText}>- Unstage</Text>
            </Pressable>
          ) : null}
        </View>
        <View style={styles.commitSubmitGroup}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={commitButtonLabel}
            disabled={commitDisabled}
            onPress={handleCommit}
            style={[styles.commitSubmitButton, commitDisabled ? styles.buttonDisabled : null]}
            testID="changes-commit-submit-button"
          >
            {isCommitting ? (
              <ThemedLoadingSpinner size="small" uniProps={foregroundMutedIconColorMapping} />
            ) : null}
            <Text style={styles.commitSubmitButtonText}>{commitButtonLabel}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Commit and Push"
            disabled={commitDisabled}
            onPress={handleCommitAndPush}
            style={[styles.commitAndPushButton, commitDisabled ? styles.buttonDisabled : null]}
            testID="changes-commit-and-push-button"
          >
            <Text style={styles.commitAndPushButtonText}>Commit & Push ↑</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
  },
  changesToolbar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingLeft: theme.spacing[2],
  },
  changesToolbarSidebar: {
    backgroundColor: theme.colors.surfaceSidebar,
  },
  changesToolbarIdentity: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  changesToolbarControls: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    flexShrink: 0,
  },
  commitComposer: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  commitInputRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
  },
  commitInput: {
    flex: 1,
    minWidth: 0,
    minHeight: 34,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  commitInputResizeHandle: {
    height: 10,
    alignItems: "center",
    justifyContent: "center",
    marginVertical: -2,
    ...(isWeb ? ({ cursor: "ns-resize", userSelect: "none" } as object) : {}),
  },
  commitInputResizeHandleActive: {
    backgroundColor: "rgba(16, 185, 129, 0.14)",
    borderRadius: 4,
  },
  commitInputResizePill: {
    width: 34,
    height: 3,
    borderRadius: 2,
    backgroundColor: theme.colors.border,
  },
  commitInputResizePillActive: {
    backgroundColor: "#10b981",
    width: 52,
  },
  aiGenerateButton: {
    height: 28,
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  aiGenerateButtonText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  commitActionsRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    flexWrap: "wrap",
  },
  stageControlsGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexWrap: "wrap",
  },
  stageSummaryText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    marginRight: 2,
  },
  stageActionPill: {
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: theme.borderRadius.sm,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  stageActionPillActive: {
    borderColor: "#3b82f6",
    backgroundColor: "rgba(59, 130, 246, 0.14)",
  },
  stageActionPillText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  stageActionPillTextActive: {
    color: "#3b82f6",
    fontWeight: theme.fontWeight.semibold,
  },
  commitSubmitGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexWrap: "wrap",
  },
  gitToolWindowButton: {
    height: 26,
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: "#10b981",
    backgroundColor: "rgba(16, 185, 129, 0.12)",
    flexDirection: "row",
    alignItems: "center",
  },
  gitToolWindowButtonText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: "#10b981",
  },
  commitSubmitButton: {
    height: 26,
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.foreground,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  commitSubmitButtonText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.background,
  },
  commitAndPushButton: {
    height: 26,
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: "#0ea5e9",
    backgroundColor: "rgba(14, 165, 233, 0.14)",
    flexDirection: "row",
    alignItems: "center",
  },
  commitAndPushButtonText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: "#0ea5e9",
  },
  buttonDisabled: {
    opacity: 0.45,
  },
  stashMenuContent: {
    minWidth: 280,
    maxWidth: 360,
    padding: theme.spacing[2],
    gap: theme.spacing[1],
  },
  stashComposerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingBottom: theme.spacing[1],
  },
  stashInput: {
    flex: 1,
    minWidth: 0,
    height: 26,
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.sm,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  stashSaveButton: {
    height: 26,
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.foreground,
    alignItems: "center",
    justifyContent: "center",
  },
  stashSaveButtonText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.background,
  },
  stashEmptyRow: {
    paddingVertical: theme.spacing[3],
    alignItems: "center",
    justifyContent: "center",
  },
  stashEmptyText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  stashEntryRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[1],
  },
  stashEntryInfo: {
    flex: 1,
    minWidth: 0,
  },
  stashEntryTitle: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
  },
  stashEntrySubtitle: {
    fontSize: 10,
    color: theme.colors.foregroundMuted,
  },
  stashEntryActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    flexShrink: 0,
  },
  stashActionPill: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: theme.borderRadius.sm,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  stashActionPillDestructive: {
    borderColor: theme.colors.border,
  },
  stashActionPillText: {
    fontSize: 10,
    color: theme.colors.foreground,
  },
  stashActionTextDestructive: {
    color: theme.colors.destructive,
  },
  diffStatusIconHidden: {
    opacity: 0,
  },
  actionErrorText: {
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[1],
    fontSize: theme.fontSize.sm,
    color: theme.colors.destructive,
  },
  forgeSetupCallout: {
    marginHorizontal: theme.spacing[3],
    marginBottom: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
  },
  forgeSetupCalloutText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  diffContainer: {
    flex: 1,
    minHeight: 0,
    position: "relative",
  },
  scrollContainer: {
    flex: 1,
    minHeight: 0,
    position: "relative",
  },
  loadingContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingTop: theme.spacing[16],
    gap: theme.spacing[4],
  },
  loadingText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
  },
  errorContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingTop: theme.spacing[16],
    paddingHorizontal: theme.spacing[6],
  },
  errorText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.destructive,
    textAlign: "center",
  },
  emptyContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingTop: theme.spacing[16],
    gap: theme.spacing[2],
  },
  emptyText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
  },
  tooltipText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  mergeToolbarTriggerNormal: {
    borderWidth: 1,
    borderColor: "rgba(16, 185, 129, 0.45)",
    backgroundColor: "rgba(16, 185, 129, 0.1)",
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  mergeToolbarTriggerConflict: {
    borderWidth: 1,
    borderColor: "rgba(245, 158, 11, 0.55)",
    backgroundColor: "rgba(245, 158, 11, 0.14)",
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  mergeMenuContent: {
    minWidth: 320,
    maxWidth: 400,
    padding: theme.spacing[2],
    gap: theme.spacing[2],
  },
  mergeMenuHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[1],
  },
  mergeMenuHeaderTitle: {
    flex: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  mergeMenuCurrentBranchHighlight: {
    color: "#10b981",
    fontWeight: theme.fontWeight.semibold,
  },
  mergeMenuAutoStashBadge: {
    fontSize: 10,
    color: "#06b6d4",
    fontWeight: theme.fontWeight.semibold,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
    borderColor: "rgba(6, 182, 212, 0.35)",
    backgroundColor: "rgba(6, 182, 212, 0.12)",
  },
  mergeConflictCalloutBox: {
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: "rgba(245, 158, 11, 0.45)",
    backgroundColor: "rgba(245, 158, 11, 0.12)",
    gap: theme.spacing[1],
  },
  mergeConflictCalloutHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  mergeConflictCalloutTitle: {
    flex: 1,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: "#f59e0b",
  },
  mergeConflictCalloutActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexWrap: "wrap",
  },
  mergeResolvePrimaryBtn: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: "#f59e0b",
  },
  mergeResolvePrimaryBtnText: {
    fontSize: 11,
    fontWeight: theme.fontWeight.semibold,
    color: "#0f172a",
  },
  mergeContinuePill: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
    borderColor: "#10b981",
    backgroundColor: "rgba(16, 185, 129, 0.14)",
  },
  mergeContinuePillText: {
    fontSize: 11,
    fontWeight: theme.fontWeight.semibold,
    color: "#10b981",
  },
  mergeAbortPill: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
    borderColor: "#f43f5e",
    backgroundColor: "rgba(244, 63, 94, 0.14)",
  },
  mergeAbortPillText: {
    fontSize: 11,
    fontWeight: theme.fontWeight.semibold,
    color: "#f43f5e",
  },
  mergeBranchesScroll: {
    maxHeight: 300,
  },
  mergeSectionGroup: {
    gap: 2,
    marginBottom: theme.spacing[1],
  },
  mergeSectionHeader: {
    fontSize: 10,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foregroundMuted,
    paddingHorizontal: theme.spacing[1],
    paddingVertical: 2,
  },
  mergeBranchRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingVertical: 5,
    paddingHorizontal: theme.spacing[1],
    borderRadius: theme.borderRadius.sm,
  },
  mergeBranchInfo: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  mergeBranchName: {
    flexShrink: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
  },
  mergeBranchAheadBehind: {
    fontSize: 10,
    color: theme.colors.foregroundMuted,
    flexShrink: 0,
  },
  mergeBranchActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    flexShrink: 0,
  },
  mergeActionPillPrimary: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
    borderColor: "#10b981",
    backgroundColor: "rgba(16, 185, 129, 0.15)",
  },
  mergeActionPillPrimaryText: {
    fontSize: 11,
    fontWeight: theme.fontWeight.semibold,
    color: "#10b981",
  },
  mergeActionPillCyan: {
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
    borderColor: "#06b6d4",
    backgroundColor: "rgba(6, 182, 212, 0.14)",
  },
  mergeActionPillCyanText: {
    fontSize: 11,
    fontWeight: theme.fontWeight.medium,
    color: "#06b6d4",
  },
}));
