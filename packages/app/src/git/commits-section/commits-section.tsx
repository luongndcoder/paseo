import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PanResponder, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { useCheckoutCommitsQuery, type CheckoutCommitsQueryResult } from "@/git/use-commits-query";
import { ThemedChevron, chevronColorMapping } from "@/git/themed-chevron";
import { treeRowPaddingLeft } from "@/components/tree-primitives";
import { normalizeBranchOptionName } from "@/utils/branch-suggestions";
import { CommitRow } from "./commit-row";

const DEFAULT_COMMITS_HEIGHT = 180;
const MIN_COMMITS_HEIGHT = 88;
const MAX_COMMITS_HEIGHT = 560;

interface CommitsSectionProps {
  serverId: string;
  cwd: string;
  onCommitPress: (sha: string) => void;
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  onOpenGitLog?: () => void;
}

function CommitsSectionSkeleton() {
  const { t } = useTranslation();
  return (
    <View
      accessible
      accessibilityLabel={t("workspace.git.diff.commits.loading")}
      style={styles.skeleton}
      testID="commits-section-skeleton"
    >
      <View style={styles.skeletonRow}>
        <View style={styles.skeletonDot} />
        <View style={styles.skeletonSha} />
        <View style={styles.skeletonSubject} />
        <View style={styles.skeletonTimestamp} />
        <View style={styles.skeletonCaret} />
      </View>
    </View>
  );
}

function CommitsSectionContent({
  query,
  onCommitPress,
  showRecentBaseCommits,
}: {
  query: Exclude<CheckoutCommitsQueryResult, { status: "unsupported" }>;
  onCommitPress: (sha: string) => void;
  showRecentBaseCommits?: boolean;
}) {
  const { t } = useTranslation();
  if (query.status === "error") {
    return (
      <Text style={styles.errorRow} testID="commits-section-error">
        {t("workspace.git.diff.commits.loadError")}
      </Text>
    );
  }
  if (query.status !== "loaded") {
    return <CommitsSectionSkeleton />;
  }
  const workspaceCommits = query.data.commits.filter((commit) => !commit.isOnBase);
  const baseCommits = query.data.commits.filter((commit) => commit.isOnBase);
  const baseRef = normalizeBranchOptionName(query.data.baseRef) ?? t("workspace.git.diff.base");
  if (workspaceCommits.length === 0) {
    return (
      <ScrollView style={styles.scrollArea} contentContainerStyle={styles.list} nestedScrollEnabled>
        <View style={styles.noWorkspaceCommitsRow} testID="commits-section-no-workspace-commits">
          <Text style={styles.noWorkspaceCommitsText}>
            {t("workspace.git.diff.commits.noneAhead", { baseRef })}
          </Text>
        </View>
        {showRecentBaseCommits && baseCommits.length > 0 ? (
          <View style={styles.recentCommitsBlock}>
            <Text style={styles.recentCommitsLabel}>Recent commits ({baseRef})</Text>
            {baseCommits.map((commit, index) => (
              <CommitRow
                key={commit.sha}
                commit={commit}
                isFirst={index === 0}
                isLast={index === baseCommits.length - 1}
                onCommitPress={onCommitPress}
              />
            ))}
          </View>
        ) : null}
      </ScrollView>
    );
  }
  return (
    <ScrollView style={styles.scrollArea} contentContainerStyle={styles.list} nestedScrollEnabled>
      {workspaceCommits.map((commit, index) => (
        <CommitRow
          key={commit.sha}
          commit={commit}
          isFirst={index === 0}
          isLast={index === workspaceCommits.length - 1}
          onCommitPress={onCommitPress}
        />
      ))}
    </ScrollView>
  );
}

export function CommitsSection({
  serverId,
  cwd,
  onCommitPress,
  collapsed = true,
  onCollapsedChange,
  onOpenGitLog,
}: CommitsSectionProps) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const [sectionHeight, setSectionHeight] = useState<number>(DEFAULT_COMMITS_HEIGHT);
  const [isDragging, setIsDragging] = useState(false);
  const [hasResized, setHasResized] = useState(false);
  const dragStartYRef = useRef<number>(0);
  const dragStartHeightRef = useRef<number>(DEFAULT_COMMITS_HEIGHT);
  const sectionHeightRef = useRef<number>(DEFAULT_COMMITS_HEIGHT);
  sectionHeightRef.current = sectionHeight;

  const query = useCheckoutCommitsQuery({
    serverId,
    cwd,
    enabled: !collapsed,
  });

  const handleToggleSection = useCallback(() => {
    onCollapsedChange?.(!collapsed);
  }, [collapsed, onCollapsedChange]);

  const clampHeight = useCallback((nextHeight: number) => {
    return Math.max(MIN_COMMITS_HEIGHT, Math.min(MAX_COMMITS_HEIGHT, Math.round(nextHeight)));
  }, []);

  const handleWebMouseDown = useCallback(
    (event: any) => {
      if (Platform.OS !== "web") return;
      event?.preventDefault?.();
      event?.stopPropagation?.();
      const clientY = event?.nativeEvent?.clientY ?? event?.clientY ?? 0;
      dragStartYRef.current = clientY;
      const baseHeight = collapsed ? DEFAULT_COMMITS_HEIGHT : sectionHeightRef.current;
      dragStartHeightRef.current = baseHeight;
      if (collapsed) {
        onCollapsedChange?.(false);
      }
      setIsDragging(true);
      setHasResized(true);
    },
    [collapsed, onCollapsedChange],
  );

  useEffect(() => {
    if (Platform.OS !== "web" || !isDragging || typeof window === "undefined") {
      return;
    }
    const handleMouseMove = (event: MouseEvent) => {
      const deltaY = dragStartYRef.current - event.clientY;
      setSectionHeight(clampHeight(dragStartHeightRef.current + deltaY));
    };
    const handleMouseUp = () => {
      setIsDragging(false);
    };
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [clampHeight, isDragging]);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => Platform.OS !== "web",
        onMoveShouldSetPanResponder: (_, gestureState) =>
          Platform.OS !== "web" && Math.abs(gestureState.dy) > 2,
        onPanResponderGrant: () => {
          dragStartHeightRef.current = collapsed
            ? DEFAULT_COMMITS_HEIGHT
            : sectionHeightRef.current;
          if (collapsed) {
            onCollapsedChange?.(false);
          }
          setIsDragging(true);
          setHasResized(true);
        },
        onPanResponderMove: (_, gestureState) => {
          const deltaY = -gestureState.dy;
          setSectionHeight(clampHeight(dragStartHeightRef.current + deltaY));
        },
        onPanResponderRelease: () => {
          setIsDragging(false);
        },
        onPanResponderTerminate: () => {
          setIsDragging(false);
        },
      }),
    [clampHeight, collapsed, onCollapsedChange],
  );

  const headerChevronStyle = useMemo(
    () => [styles.headerChevron, !collapsed && styles.headerChevronExpanded],
    [collapsed],
  );
  const containerStyle = useMemo(
    () => [
      styles.container,
      { paddingBottom: insets.bottom },
      !collapsed && { height: sectionHeight },
    ],
    [collapsed, insets.bottom, sectionHeight],
  );

  if (query.status === "unsupported") {
    return null;
  }
  const commitCount =
    query.status === "loaded"
      ? query.data.commits.filter((commit) => !commit.isOnBase).length
      : null;

  return (
    <View style={containerStyle}>
      <View
        testID="commits-section-resize-handle"
        {...panResponder.panHandlers}
        // @ts-expect-error web mouse down support
        onMouseDown={handleWebMouseDown}
        style={[styles.resizeHandle, isDragging && styles.resizeHandleActive]}
      >
        <View style={[styles.resizeGripPill, isDragging && styles.resizeGripPillActive]} />
      </View>
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          testID="commits-section-header"
          onPress={handleToggleSection}
          style={styles.headerToggle}
        >
          <View style={headerChevronStyle}>
            <ThemedChevron size={14} uniProps={chevronColorMapping} />
          </View>
          <Text style={styles.title}>{t("workspace.git.diff.commits.title")}</Text>
          {commitCount === null ? (
            <View style={styles.countSpacer} />
          ) : (
            <Text
              style={styles.count}
              accessibilityLabel={t("workspace.git.diff.commits.countLabel", {
                count: commitCount,
              })}
            >
              {commitCount}
            </Text>
          )}
        </Pressable>
        {onOpenGitLog ? (
          <Pressable
            accessibilityRole="button"
            testID="commits-section-open-git-log"
            onPress={onOpenGitLog}
            style={styles.gitLogButton}
          >
            <Text style={styles.gitLogButtonText}>Git Log (⌘9)</Text>
          </Pressable>
        ) : null}
      </View>
      {collapsed ? null : (
        <CommitsSectionContent
          query={query}
          onCommitPress={onCommitPress}
          showRecentBaseCommits={hasResized || sectionHeight > 120}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    flexShrink: 0,
  },
  resizeHandle: {
    height: 8,
    alignItems: "center",
    justifyContent: "center",
    ...(Platform.OS === "web" ? ({ cursor: "ns-resize" } as any) : null),
  },
  resizeHandleActive: {
    backgroundColor: "rgba(16, 185, 129, 0.14)",
  },
  resizeGripPill: {
    width: 32,
    height: 3,
    borderRadius: 2,
    backgroundColor: theme.colors.border,
  },
  resizeGripPillActive: {
    backgroundColor: "#10b981",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    // Same leading rail as a depth-0 tree row, so the disclosure chevron lines up
    // with the folder chevrons above it.
    paddingLeft: treeRowPaddingLeft(0),
    paddingRight: theme.spacing[3],
    paddingTop: 2,
    paddingBottom: theme.spacing[2],
    flexShrink: 0,
  },
  headerToggle: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  headerChevron: {
    width: 16,
    height: 16,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  headerChevronExpanded: {
    transform: [{ rotate: "90deg" }],
  },
  title: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
  },
  count: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    flex: 1,
  },
  countSpacer: {
    flex: 1,
  },
  gitLogButton: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
    borderRadius: theme.borderRadius.sm,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
  },
  gitLogButtonText: {
    fontSize: 11,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  scrollArea: {
    flex: 1,
    minHeight: 0,
  },
  list: {
    paddingBottom: theme.spacing[2],
  },
  recentCommitsBlock: {
    marginTop: theme.spacing[1],
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    paddingTop: theme.spacing[1],
  },
  recentCommitsLabel: {
    fontSize: 11,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
    paddingHorizontal: theme.spacing[2],
    paddingBottom: 4,
  },
  noWorkspaceCommitsRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: theme.spacing[2],
    paddingRight: theme.spacing[3],
    paddingTop: theme.spacing[1],
    paddingBottom: theme.spacing[2],
  },
  noWorkspaceCommitsText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  errorRow: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.statusDanger,
    paddingLeft: theme.spacing[2],
    paddingRight: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  skeleton: {
    paddingBottom: theme.spacing[1],
    gap: theme.spacing[2],
  },
  skeletonRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    minHeight: 20,
  },
  skeletonDot: {
    width: 8,
    height: 8,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
  },
  skeletonSha: {
    width: 48,
    height: 10,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface2,
  },
  skeletonSubject: {
    flex: 1,
    minWidth: 0,
    height: 12,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface2,
  },
  skeletonTimestamp: {
    width: 40,
    height: 10,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface2,
    flexShrink: 0,
  },
  skeletonCaret: {
    width: 16,
    height: 16,
    flexShrink: 0,
  },
}));
