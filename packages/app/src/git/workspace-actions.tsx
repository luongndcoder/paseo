import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { BranchSwitcher } from "@/components/branch-switcher";
import { GitActionsSplitButton } from "@/git/actions-split-button";
import { GIT_ACTION_ICONS } from "@/git/action-icons";
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

  return (
    <View style={styles.container}>
      <BranchSwitcher
        currentBranchName={currentBranchName}
        serverId={serverId}
        workspaceId={workspaceId ?? cwd}
        workspaceDirectory={cwd}
        isGitCheckout={isGit}
        testID="workspace-header-branch-switcher"
      />
      <GitActionsSplitButton gitActions={gitActions} />
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
