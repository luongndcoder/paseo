import { useCallback, useState } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { BranchSwitcher } from "@/components/branch-switcher";
import { GitActionsSplitButton } from "@/git/actions-split-button";
import { GIT_ACTION_ICONS } from "@/git/action-icons";
import { MergeConflictResolverModal } from "@/git/pycharm-git-window/merge-conflict-resolver-modal";
import { useGitActions } from "@/git/use-actions";

interface WorkspaceActionsProps {
  serverId: string;
  workspaceId?: string | null;
  cwd: string;
}

export function WorkspaceActions({ serverId, workspaceId, cwd }: WorkspaceActionsProps) {
  const { gitActions, currentBranchName, isGit } = useGitActions({
    serverId,
    cwd,
    icons: GIT_ACTION_ICONS,
  });

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
      conflictFiles: string[] = [],
      inProgress: "merge" | "rebase" | "cherry-pick" | "conflict" | null = null,
    ) => {
      setConflictModalState({
        open: true,
        conflictFiles,
        inProgress: inProgress ?? "merge",
      });
    },
    [],
  );

  return (
    <View style={styles.container}>
      <BranchSwitcher
        currentBranchName={currentBranchName}
        serverId={serverId}
        workspaceId={workspaceId ?? cwd}
        workspaceDirectory={cwd}
        isGitCheckout={isGit}
        onOpenConflictResolver={handleOpenConflictResolver}
        testID="workspace-header-branch-switcher"
      />
      <GitActionsSplitButton gitActions={gitActions} />
      {conflictModalState.open ? (
        <MergeConflictResolverModal
          visible={conflictModalState.open}
          onClose={() => setConflictModalState((prev) => ({ ...prev, open: false }))}
          serverId={serverId}
          cwd={cwd}
          conflictFiles={conflictModalState.conflictFiles}
          inProgressOperation={conflictModalState.inProgress}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexShrink: 1,
    minWidth: 0,
  },
}));
