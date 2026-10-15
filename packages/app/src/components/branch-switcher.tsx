import { useCallback, useRef, useState } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, GitBranch, GitMerge } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Combobox, ComboboxItem, type ComboboxProps } from "@/components/ui/combobox";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useToast } from "@/contexts/toast-context";
import { useBranchSwitcher } from "@/hooks/use-branch-switcher";
import { buttonControlHeight, HEADER_CONTROL_HEIGHT } from "@/components/ui/control-geometry";
import { invalidateCheckoutGitQueriesForClient } from "@/git/query-keys";
import { confirmDialog } from "@/utils/confirm-dialog";

interface BranchSwitcherProps {
  currentBranchName: string | null;
  serverId: string;
  workspaceId: string;
  workspaceDirectory: string | null;
  isGitCheckout: boolean;
  compact?: boolean;
  onOpenConflictResolver?: (
    conflictFiles?: string[],
    inProgress?: "merge" | "rebase" | "cherry-pick" | "conflict" | null,
  ) => void;
  testID?: string;
}

export function BranchSwitcher({
  currentBranchName,
  serverId,
  workspaceId,
  workspaceDirectory,
  isGitCheckout,
  compact = false,
  onOpenConflictResolver,
  testID = "workspace-header-branch-switcher",
}: BranchSwitcherProps) {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const anchorRef = useRef<View>(null);
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const toast = useToast();
  const queryClient = useQueryClient();
  const [busyBranchAction, setBusyBranchAction] = useState<string | null>(null);

  const { branchOptions, isOpen, setIsOpen, handleBranchSelect } = useBranchSwitcher({
    client,
    normalizedServerId: serverId,
    normalizedWorkspaceId: workspaceId,
    workspaceDirectory,
    currentBranchName,
    isGitCheckout,
    isConnected,
    toast,
    queryClient,
  });

  const handleOpen = useCallback(() => setIsOpen(true), [setIsOpen]);

  const handleQuickBranchOperation = useCallback(
    async (kind: "merge-ref" | "rebase-onto", targetBranch: string) => {
      if (!client || !workspaceDirectory || busyBranchAction) {
        return;
      }
      setIsOpen(false);
      const currentName = currentBranchName ?? "HEAD";
      const isMerge = kind === "merge-ref";
      const confirmed = await confirmDialog({
        title: isMerge
          ? `Merge '${targetBranch}' into '${currentName}'?`
          : `Rebase '${currentName}' onto '${targetBranch}'?`,
        message: isMerge
          ? `Merge changes from '${targetBranch}' into your current branch '${currentName}'. Any uncommitted local changes will be automatically stashed before merging and restored afterward.`
          : `Reapply commits from '${currentName}' on top of '${targetBranch}'. Any uncommitted local changes will be automatically stashed before rebasing and restored afterward.`,
        confirmLabel: isMerge ? "Merge Branch" : "Rebase Branch",
        cancelLabel: "Cancel",
        branchFlow: isMerge
          ? { from: targetBranch, to: currentName, actionLabel: "MERGE INTO" }
          : { from: currentName, to: targetBranch, actionLabel: "REBASE ONTO" },
        badges: [
          { label: "Auto-Stash: ON", tone: "emerald" },
          { label: "3-Way Conflict Resolver", tone: "cyan" },
        ],
      });
      if (!confirmed) {
        return;
      }
      setBusyBranchAction(`${kind}:${targetBranch}`);
      try {
        const res = await client.runGitLogAction(workspaceDirectory, {
          kind,
          target: targetBranch,
        });
        await invalidateCheckoutGitQueriesForClient(queryClient, {
          serverId,
          cwd: workspaceDirectory,
        });
        if (!res.success) {
          toast.error(res.message ?? `Failed to ${kind} ${targetBranch}`);
          return;
        }
        if (res.message?.startsWith("CONFLICT:")) {
          toast.show(res.message, { variant: "info" });
          onOpenConflictResolver?.([], kind === "merge-ref" ? "merge" : "rebase");
          return;
        }
        toast.show(
          res.message ||
            (kind === "merge-ref"
              ? `Merged '${targetBranch}' into '${currentBranchName}'`
              : `Rebased '${currentBranchName}' onto '${targetBranch}'`),
          { variant: "success" },
        );
      } catch (err) {
        toast.error(err instanceof Error ? err.message : `Failed to ${kind} ${targetBranch}`);
      } finally {
        setBusyBranchAction(null);
      }
    },
    [
      busyBranchAction,
      client,
      currentBranchName,
      onOpenConflictResolver,
      queryClient,
      serverId,
      setIsOpen,
      toast,
      workspaceDirectory,
    ],
  );

  const renderBranchOption = useCallback<NonNullable<ComboboxProps["renderOption"]>>(
    ({ option, selected, active, onPress }) => (
      <ComboboxItem
        label={option.label}
        selected={selected}
        active={active}
        onPress={onPress}
        leadingSlot={
          <GitBranch size={15} color={selected ? "#10b981" : theme.colors.foregroundMuted} />
        }
        trailingSlot={
          selected ? (
            <View style={styles.currentBranchBadge}>
              <Text style={styles.currentBranchBadgeText}>CURRENT</Text>
            </View>
          ) : workspaceDirectory ? (
            <View style={styles.branchRowQuickActions}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Merge ${option.label} into ${currentBranchName ?? "current"}`}
                disabled={Boolean(busyBranchAction)}
                onPress={(event) => {
                  event?.stopPropagation?.();
                  void handleQuickBranchOperation("merge-ref", option.id);
                }}
                style={styles.mergeIntoPill}
                testID={`branch-switcher-merge-${option.id}`}
              >
                <GitMerge size={11} color="#10b981" />
                <Text style={styles.mergeIntoPillText}>Merge into</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Rebase onto ${option.label}`}
                disabled={Boolean(busyBranchAction)}
                onPress={(event) => {
                  event?.stopPropagation?.();
                  void handleQuickBranchOperation("rebase-onto", option.id);
                }}
                style={styles.rebasePill}
                testID={`branch-switcher-rebase-${option.id}`}
              >
                <Text style={styles.rebasePillText}>Rebase</Text>
              </Pressable>
            </View>
          ) : null
        }
      />
    ),
    [
      busyBranchAction,
      currentBranchName,
      handleQuickBranchOperation,
      theme.colors.foregroundMuted,
      workspaceDirectory,
    ],
  );

  const triggerStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      compact ? styles.triggerCompact : styles.triggerHeader,
      (Boolean(hovered) || pressed || isOpen) && styles.triggerHighlighted,
      isOpen && styles.triggerOpen,
    ],
    [compact, isOpen],
  );

  if (!currentBranchName) {
    return null;
  }

  return (
    <View ref={anchorRef} collapsable={false} style={styles.anchor}>
      <Tooltip delayDuration={300} enabledOnDesktop enabledOnMobile={false}>
        <TooltipTrigger asChild>
          <Pressable
            testID={testID}
            onPress={handleOpen}
            style={triggerStyle}
            accessibilityRole="button"
            accessibilityLabel={t("branchSwitcher.currentBranch", {
              branchName: currentBranchName,
            })}
          >
            <GitBranch size={compact ? 13 : 15} color="#10b981" />
            <Text
              style={compact ? styles.triggerLabelCompact : styles.triggerLabelHeader}
              numberOfLines={1}
            >
              {currentBranchName}
            </Text>
            <ChevronDown
              size={compact ? 13 : 14}
              color={isOpen ? theme.colors.foreground : theme.colors.foregroundMuted}
            />
          </Pressable>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <Text style={styles.tooltipText}>{t("branchSwitcher.triggerTooltip")}</Text>
        </TooltipContent>
      </Tooltip>
      <Combobox
        options={branchOptions}
        value={currentBranchName}
        onSelect={handleBranchSelect}
        searchable
        allowCustomValue
        customValuePrefix={t("branchSwitcher.createBranchPrefix", {
          defaultValue: "Create branch",
        })}
        placeholder={t("branchSwitcher.placeholder")}
        searchPlaceholder={t("branchSwitcher.searchPlaceholder")}
        emptyText={t("branchSwitcher.empty")}
        title={t("branchSwitcher.title")}
        open={isOpen}
        onOpenChange={setIsOpen}
        anchorRef={anchorRef}
        desktopPlacement="bottom-start"
        desktopPreventInitialFlash
        desktopMinWidth={430}
        renderOption={renderBranchOption}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  anchor: {
    flexShrink: 1,
    minWidth: 0,
  },
  triggerHeader: {
    height: {
      xs: buttonControlHeight.xs,
      md: HEADER_CONTROL_HEIGHT,
    },
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    backgroundColor: "rgba(16, 185, 129, 0.08)",
    flexShrink: 1,
    minWidth: 0,
  },
  triggerCompact: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: "rgba(16, 185, 129, 0.35)",
    backgroundColor: "rgba(16, 185, 129, 0.08)",
    flexShrink: 1,
    minWidth: 0,
  },
  triggerHighlighted: {
    backgroundColor: "rgba(16, 185, 129, 0.16)",
    borderColor: "rgba(16, 185, 129, 0.55)",
  },
  triggerOpen: {
    backgroundColor: "rgba(16, 185, 129, 0.2)",
    borderColor: "#10b981",
  },
  triggerLabelHeader: {
    fontSize: theme.fontSize.base,
    lineHeight: theme.fontSize.base * 1.4,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
    flexShrink: 1,
    minWidth: 0,
  },
  triggerLabelCompact: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
    flexShrink: 1,
    minWidth: 0,
  },
  tooltipText: {
    color: theme.colors.popoverForeground,
    fontSize: theme.fontSize.sm,
  },
  currentBranchBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: "rgba(16, 185, 129, 0.16)",
    borderWidth: 1,
    borderColor: "rgba(16, 185, 129, 0.45)",
    marginLeft: 6,
  },
  currentBranchBadgeText: {
    fontSize: 9.5,
    fontWeight: theme.fontWeight.semibold,
    color: "#10b981",
    letterSpacing: 0.4,
  },
  branchRowQuickActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginLeft: 8,
  },
  mergeIntoPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
    borderColor: "#10b981",
    backgroundColor: "rgba(16, 185, 129, 0.16)",
  },
  mergeIntoPillText: {
    fontSize: 11,
    fontWeight: theme.fontWeight.semibold,
    color: "#10b981",
  },
  rebasePill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
    borderColor: "#06b6d4",
    backgroundColor: "rgba(6, 182, 212, 0.14)",
  },
  rebasePillText: {
    fontSize: 11,
    fontWeight: theme.fontWeight.semibold,
    color: "#06b6d4",
  },
}));
