import { useCallback, useMemo, useState } from "react";
import {
  Pressable,
  View,
  Text,
  type LayoutChangeEvent,
  type PressableStateCallbackType,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Folder } from "lucide-react-native";
import { DiffStat } from "@/components/diff-stat";
import {
  TreeChevron,
  treeRowPaddingLeft,
  workspaceTreeRowStyles,
  WORKSPACE_TREE_ICON_LABEL_GAP,
  WORKSPACE_TREE_ICON_SIZE,
} from "@/components/tree-primitives";
import { type Theme } from "@/styles/theme";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { FileActionsContextMenuContent } from "@/components/file-actions-menu";
import { isWeb } from "@/constants/platform";

interface DiffFolderRowProps {
  /** full uncompressed directory path — the collapse identity */
  dirPath: string;
  displayName: string;
  depth: number;
  collapsed: boolean;
  isSelected: boolean;
  additions: number;
  deletions: number;
  fileCount?: number;
  checkState?: "checked" | "unchecked" | "indeterminate";
  onToggleCheck?: (dirPath: string) => void;
  onToggle: (dirPath: string) => void;
  onCollapse: (dirPath: string) => void;
  onSelect: (dirPath: string) => void;
  onHeightChange?: (height: number) => void;
  onCopyPath?: (path: string) => void;
  onCopyRelativePath?: (path: string) => void;
  onReveal?: (path: string) => void;
  revealTargetName?: string;
  onDuplicate?: (path: string) => void;
  onRevert?: (path: string) => void;
  testID?: string;
}

function folderRowPressableStyle(
  { hovered, pressed }: PressableStateCallbackType & { hovered?: boolean },
  isSelected: boolean,
) {
  return [
    workspaceTreeRowStyles.row,
    (Boolean(hovered) || pressed || isSelected) && workspaceTreeRowStyles.active,
  ];
}

export function DiffFolderRow({
  dirPath,
  displayName,
  depth,
  collapsed,
  isSelected,
  additions,
  deletions,
  fileCount,
  checkState,
  onToggleCheck,
  onToggle,
  onCollapse,
  onSelect,
  onHeightChange,
  onCopyPath,
  onCopyRelativePath,
  onReveal,
  revealTargetName,
  onDuplicate,
  onRevert,
  testID,
}: DiffFolderRowProps) {
  const handleSelect = useCallback(() => {
    onSelect(dirPath);
  }, [dirPath, onSelect]);
  const [isHovered, setIsHovered] = useState(false);
  const showNameHover = useCallback(() => setIsHovered(true), []);
  const hideNameHover = useCallback(() => setIsHovered(false), []);

  const handlePress = useCallback(() => {
    const selection = isWeb ? window.getSelection() : null;
    if (selection && !selection.isCollapsed && selection.toString().length > 0) {
      return;
    }
    handleSelect();
    onToggle(dirPath);
  }, [dirPath, handleSelect, onToggle]);

  const pressableStyle = useCallback(
    (state: PressableStateCallbackType & { hovered?: boolean }) =>
      folderRowPressableStyle(state, isSelected),
    [isSelected],
  );

  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      onHeightChange?.(event.nativeEvent.layout.height);
    },
    [onHeightChange],
  );

  const handleCollapse = useCallback(() => {
    onCollapse(dirPath);
  }, [dirPath, onCollapse]);

  const handleCopyPath = useCallback(() => {
    onCopyPath?.(dirPath);
  }, [dirPath, onCopyPath]);

  const handleCopyRelativePath = useCallback(() => {
    onCopyRelativePath?.(dirPath);
  }, [dirPath, onCopyRelativePath]);

  const handleReveal = useCallback(() => {
    onReveal?.(dirPath);
  }, [dirPath, onReveal]);

  const handleDuplicate = useCallback(() => {
    onDuplicate?.(dirPath);
  }, [dirPath, onDuplicate]);

  const handleRevert = useCallback(() => {
    onRevert?.(dirPath);
  }, [dirPath, onRevert]);

  const leftStyle = useMemo(
    () => [
      styles.left,
      inlineUnistylesStyle({
        paddingLeft: treeRowPaddingLeft(depth),
      }),
    ],
    [depth],
  );

  const accessibilityState = useMemo(
    () => ({ expanded: !collapsed, selected: isSelected }),
    [collapsed, isSelected],
  );

  return (
    <View style={styles.container} onLayout={handleLayout} testID={testID}>
      <ContextMenu>
        <ContextMenuTrigger
          onPress={handlePress}
          onLongPress={handleSelect}
          onContextMenu={handleSelect}
          style={pressableStyle}
          onHoverIn={showNameHover}
          onHoverOut={hideNameHover}
          accessibilityRole="button"
          accessibilityState={accessibilityState}
          aria-selected={isSelected}
          testID={testID ? `${testID}-toggle` : undefined}
        >
          <View style={leftStyle}>
            <View style={styles.chevronSlot}>
              <TreeChevron expanded={!collapsed} />
            </View>
            {onToggleCheck ? (
              <Pressable
                accessibilityRole="checkbox"
                accessibilityState={{
                  checked: checkState === "indeterminate" ? "mixed" : checkState === "checked",
                }}
                onPress={(e) => {
                  e.stopPropagation?.();
                  onToggleCheck(dirPath);
                }}
                style={[
                  styles.checkboxBox,
                  checkState === "checked" || checkState === "indeterminate"
                    ? styles.checkboxBoxChecked
                    : null,
                ]}
                testID={testID ? `${testID}-checkbox` : undefined}
              >
                {checkState === "checked" ? (
                  <Text style={styles.checkboxMark}>✓</Text>
                ) : checkState === "indeterminate" ? (
                  <Text style={styles.checkboxMark}>−</Text>
                ) : null}
              </Pressable>
            ) : null}
            <Folder size={13} color="#8c94a4" style={styles.folderIcon} />
            <Text
              style={[
                styles.folderName,
                workspaceTreeRowStyles.name,
                isHovered && workspaceTreeRowStyles.nameHovered,
              ]}
              numberOfLines={1}
              testID={testID ? `${testID}-name` : undefined}
            >
              {displayName}
            </Text>
          </View>
          <View style={styles.right}>
            {typeof fileCount === "number" ? (
              <Text style={styles.fileCountText} testID={testID ? `${testID}-stat` : undefined}>
                {fileCount} {fileCount === 1 ? "file" : "files"}
              </Text>
            ) : (
              <DiffStat
                additions={additions}
                deletions={deletions}
                testID={testID ? `${testID}-stat` : undefined}
              />
            )}
          </View>
        </ContextMenuTrigger>
        <FileActionsContextMenuContent
          fileKind="directory"
          onCollapseFolder={!collapsed ? handleCollapse : undefined}
          onCopyPath={onCopyPath ? handleCopyPath : undefined}
          onCopyRelativePath={onCopyRelativePath ? handleCopyRelativePath : undefined}
          onReveal={onReveal ? handleReveal : undefined}
          revealTargetName={revealTargetName}
          onDuplicate={onDuplicate ? handleDuplicate : undefined}
          onRevert={onRevert ? handleRevert : undefined}
          testIDPrefix={testID}
        />
      </ContextMenu>
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  container: {
    overflow: "hidden",
  },
  left: {
    flexDirection: "row",
    alignItems: "center",
    gap: WORKSPACE_TREE_ICON_LABEL_GAP,
    flex: 1,
    minWidth: 0,
  },
  chevronSlot: {
    width: WORKSPACE_TREE_ICON_SIZE,
    height: WORKSPACE_TREE_ICON_SIZE,
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxBox: {
    width: 14,
    height: 14,
    borderRadius: 3,
    borderWidth: 1,
    borderColor: "#4e5157",
    backgroundColor: theme.colors.surface1,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  checkboxBoxChecked: {
    backgroundColor: "#3574f0",
    borderColor: "#3574f0",
  },
  checkboxMark: {
    fontSize: 10,
    fontWeight: theme.fontWeight.bold,
    color: "#ffffff",
    lineHeight: 11,
  },
  folderIcon: {
    flexShrink: 0,
  },
  right: {
    flexDirection: "row",
    alignItems: "center",
    flexShrink: 0,
    gap: theme.spacing[1],
    paddingLeft: 6,
  },
  fileCountText: {
    fontSize: 11,
    color: theme.colors.foregroundMuted,
    userSelect: "none",
  },
  folderName: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
    flexShrink: 1,
    minWidth: 0,
    userSelect: "none",
  },
}));
