import { Portal } from "@gorhom/portal";
import type {
  CheckoutCommit,
  CheckoutCommitFile,
  CheckoutGitBranchNode,
  CheckoutGitConflictState,
  CheckoutGitDiffDetail,
  CheckoutGitLogAction,
  CheckoutGitRemoteBranchNode,
  CheckoutGitStashNode,
  CheckoutGitTagNode,
} from "@getpaseo/protocol/messages";
import { useQueryClient } from "@tanstack/react-query";
import * as Clipboard from "expo-clipboard";
import {
  AlertTriangle,
  Archive,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Calendar,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Columns2,
  Copy,
  Edit3,
  ExternalLink,
  FileCode2,
  Folder,
  FolderGit2,
  FolderOpen,
  GitBranch,
  GitCommitHorizontal,
  GitCompare,
  GitFork,
  GitMerge,
  GitPullRequest,
  History,
  Layers,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Scissors,
  Search,
  Square,
  Star,
  Tag,
  Trash2,
  Undo2,
  User,
  X,
} from "lucide-react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import Svg, { Circle, Line, Path } from "react-native-svg";
import { StyleSheet, UnistylesRuntime } from "react-native-unistyles";

import { isWeb } from "@/constants/platform";
import { useToast } from "@/contexts/toast-context";
import { invalidateCheckoutGitQueriesForClient } from "@/git/query-keys";
import type { ParsedDiffFile } from "@/git/use-diff-query";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { confirmDialog, type ConfirmDialogInput } from "@/utils/confirm-dialog";

import {
  type CommitGraphRowLayout,
  computeCommitGraphLayout,
  GRAPH_LANE_COLORS,
} from "./commit-graph-layout";
import { MergeConflictResolverModal } from "./merge-conflict-resolver-modal";
import { SplitDiffViewer } from "./split-diff-viewer";

export interface PyCharmGitModalProps {
  visible?: boolean;
  open?: boolean;
  onClose: () => void;
  serverId: string;
  cwd: string;
  initialFilePath?: string | null;
  initialCommitSha?: string | null;
  onOpenCommitTab?: (sha: string) => void;
}

const LANE_WIDTH = 14;
const ROW_HEIGHT = 28;
const NODE_RADIUS = 4;

function laneCenterX(lane: number): number {
  return 10 + lane * LANE_WIDTH;
}

function CommitRowGraphSvg({
  row,
  surfaceColor,
}: {
  row: CommitGraphRowLayout;
  surfaceColor: string;
}) {
  const width = Math.max(24, (row.laneCount + 1) * LANE_WIDTH + 6);
  const centerY = ROW_HEIGHT / 2;
  const cx = laneCenterX(row.lane);
  const nodeColor = GRAPH_LANE_COLORS[row.colorIndex % GRAPH_LANE_COLORS.length];

  return (
    <View style={{ width, height: ROW_HEIGHT, flexShrink: 0 }}>
      <Svg width={width} height={ROW_HEIGHT}>
        {row.segments.map((seg, idx) => {
          const x1 = laneCenterX(seg.fromLane);
          const x2 = laneCenterX(seg.toLane);
          const stroke = GRAPH_LANE_COLORS[seg.colorIndex % GRAPH_LANE_COLORS.length];

          if (seg.span === "top-to-bottom") {
            return (
              <Line
                key={`seg-${idx}`}
                x1={x1}
                y1={0}
                x2={x2}
                y2={ROW_HEIGHT}
                stroke={stroke}
                strokeWidth={1.75}
              />
            );
          }

          if (seg.span === "top-to-center") {
            if (x1 === x2) {
              return (
                <Line
                  key={`seg-${idx}`}
                  x1={x1}
                  y1={0}
                  x2={x2}
                  y2={centerY}
                  stroke={stroke}
                  strokeWidth={1.75}
                />
              );
            }
            const d = `M ${x1} 0 C ${x1} ${centerY * 0.65}, ${x2} ${centerY * 0.35}, ${x2} ${centerY}`;
            return <Path key={`seg-${idx}`} d={d} stroke={stroke} strokeWidth={1.75} fill="none" />;
          }

          if (x1 === x2) {
            return (
              <Line
                key={`seg-${idx}`}
                x1={x1}
                y1={centerY}
                x2={x2}
                y2={ROW_HEIGHT}
                stroke={stroke}
                strokeWidth={1.75}
              />
            );
          }
          const midY = centerY + (ROW_HEIGHT - centerY) * 0.55;
          const d = `M ${x1} ${centerY} C ${x1} ${midY}, ${x2} ${centerY + 3}, ${x2} ${ROW_HEIGHT}`;
          return <Path key={`seg-${idx}`} d={d} stroke={stroke} strokeWidth={1.75} fill="none" />;
        })}

        <Circle
          cx={cx}
          cy={centerY}
          r={row.isMerge ? NODE_RADIUS + 0.5 : NODE_RADIUS}
          fill={row.commit.isOnRemote ? nodeColor : surfaceColor}
          stroke={nodeColor}
          strokeWidth={1.75}
        />
      </Svg>
    </View>
  );
}

/**
 * Formats commit timestamp in PyCharm's compact tabular style: `8/10/26, 18:27`
 */
function formatPyCharmTableDate(isoDate: string): string {
  try {
    const d = new Date(isoDate);
    if (Number.isNaN(d.getTime())) return isoDate;
    const day = d.getDate();
    const month = d.getMonth() + 1;
    const yearShort = String(d.getFullYear()).slice(-2);
    const hours = String(d.getHours()).padStart(2, "0");
    const mins = String(d.getMinutes()).padStart(2, "0");
    return `${day}/${month}/${yearShort}, ${hours}:${mins}`;
  } catch {
    return isoDate;
  }
}

function formatPyCharmFullDate(isoDate: string): string {
  try {
    const d = new Date(isoDate);
    if (Number.isNaN(d.getTime())) return isoDate;
    const day = d.getDate();
    const month = d.getMonth() + 1;
    const year = d.getFullYear();
    const hours = String(d.getHours()).padStart(2, "0");
    const mins = String(d.getMinutes()).padStart(2, "0");
    return `on ${day}/${month}/${year} at ${hours}:${mins}`;
  } catch {
    return isoDate;
  }
}

interface BranchFolderGroup<T> {
  folderName: string | null;
  items: { shortLabel: string; node: T }[];
}

/**
 * Groups branches by their first `/` folder segment (e.g. `feature/deal-sla` -> folder `feature`, leaf `deal-sla`).
 * For remote branches like `origin/feature/deal-sla`, strips `origin/` or groups under `origin/feature`.
 */
function groupBranchesByFolder<T extends { name: string }>(
  items: T[],
  starredSet: Set<string>,
  stripRemotePrefix = false,
): {
  rootItems: { shortLabel: string; node: T }[];
  folders: BranchFolderGroup<T>[];
} {
  const rootItems: { shortLabel: string; node: T }[] = [];
  const folderMap = new Map<string, { shortLabel: string; node: T }[]>();

  const sorted = [...items].sort((a, b) => {
    const aStar = starredSet.has(a.name) ? 0 : 1;
    const bStar = starredSet.has(b.name) ? 0 : 1;
    if (aStar !== bStar) return aStar - bStar;
    return a.name.localeCompare(b.name);
  });

  for (const item of sorted) {
    let displayPath = item.name;
    let remoteName = "";
    if (stripRemotePrefix) {
      const firstSlash = item.name.indexOf("/");
      if (firstSlash > 0) {
        remoteName = item.name.slice(0, firstSlash);
        displayPath = item.name.slice(firstSlash + 1);
      }
    }

    const slashIdx = displayPath.indexOf("/");
    if (slashIdx === -1) {
      rootItems.push({
        shortLabel: stripRemotePrefix && remoteName ? `${remoteName}/${displayPath}` : displayPath,
        node: item,
      });
    } else {
      const folderPrefix = displayPath.slice(0, slashIdx);
      const folderKey =
        stripRemotePrefix && remoteName ? `${remoteName}/${folderPrefix}` : folderPrefix;
      const leafLabel = displayPath.slice(slashIdx + 1);
      const list = folderMap.get(folderKey) ?? [];
      list.push({ shortLabel: leafLabel, node: item });
      folderMap.set(folderKey, list);
    }
  }

  const folders: BranchFolderGroup<T>[] = Array.from(folderMap.entries()).map(
    ([folderName, groupItems]) => ({
      folderName,
      items: groupItems,
    }),
  );

  return { rootItems, folders };
}

interface ChangedFileDirectoryGroup {
  dirPath: string;
  files: CheckoutCommitFile[];
}

function groupChangedFilesByDirectory(files: CheckoutCommitFile[]): ChangedFileDirectoryGroup[] {
  const map = new Map<string, CheckoutCommitFile[]>();
  for (const file of files) {
    const lastSlash = file.path.lastIndexOf("/");
    const dir = lastSlash === -1 ? "." : file.path.slice(0, lastSlash);
    const list = map.get(dir) ?? [];
    list.push(file);
    map.set(dir, list);
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dirPath, groupFiles]) => ({
      dirPath,
      files: groupFiles,
    }));
}

export function PyCharmGitModal({
  visible: visibleProp,
  open,
  onClose,
  serverId,
  cwd,
  initialFilePath = null,
  initialCommitSha = null,
  onOpenCommitTab,
}: PyCharmGitModalProps) {
  const theme = UnistylesRuntime.getTheme();
  const visible = Boolean(visibleProp ?? open);
  const client = useHostRuntimeClient(serverId);
  const queryClient = useQueryClient();
  const toast = useToast();

  // Filter & query state
  const [allBranches, setAllBranches] = useState<boolean>(true);
  const [selectedRef, setSelectedRef] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [authorFilter, setAuthorFilter] = useState<string>("");
  const [authorFilterOpen, setAuthorFilterOpen] = useState<boolean>(false);
  const [dateFilterPreset, setDateFilterPreset] = useState<"all" | "24h" | "7d" | "30d">("all");
  const [filePathFilter, setFilePathFilter] = useState<string>(initialFilePath ?? "");
  const [refTreeFilter, setRefTreeFilter] = useState<string>("");

  // Starred favorite branches (default stars current branch & master/main)
  const [starredRefs, setStarredRefs] = useState<Set<string>>(
    () => new Set(["master", "main", "origin/master", "origin/main"]),
  );

  // Collapsible branch sub-folders
  const [collapsedBranchFolders, setCollapsedBranchFolders] = useState<Set<string>>(
    () => new Set(),
  );

  // Right pane directory grouping state (matches PyCharm top-right file tree)
  const [groupFilesByDir, setGroupFilesByDir] = useState<boolean>(true);
  const [collapsedFileDirs, setCollapsedFileDirs] = useState<Set<string>>(() => new Set());

  // Full-screen PyCharm "Repository Diff" Modal state (`pycharm-ref-2.png`)
  const [repoDiffModalOpen, setRepoDiffModalOpen] = useState<boolean>(false);
  const [activeHunkIndex, setActiveHunkIndex] = useState<number>(0);
  const lastFileClickRef = useRef<{ path: string; time: number }>({ path: "", time: 0 });
  const lastBranchClickRef = useRef<{ name: string; time: number }>({ name: "", time: 0 });

  // Graph & Refs data
  const [loading, setLoading] = useState<boolean>(false);
  const [actionBusy, setActionBusy] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [statusBanner, setStatusBanner] = useState<{
    kind: "info" | "success" | "error";
    text: string;
  } | null>(null);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showModalFeedback = useCallback((kind: "info" | "success" | "error", text: string) => {
    if (statusTimerRef.current) {
      clearTimeout(statusTimerRef.current);
      statusTimerRef.current = null;
    }
    setStatusBanner({ kind, text });
    if (kind !== "info") {
      statusTimerRef.current = setTimeout(() => {
        setStatusBanner(null);
      }, 4500);
    }
  }, []);

  const [commits, setCommits] = useState<CheckoutCommit[]>([]);
  const [currentBranch, setCurrentBranch] = useState<string | null>(null);
  const [headSha, setHeadSha] = useState<string | null>(null);
  const [branches, setBranches] = useState<CheckoutGitBranchNode[]>([]);
  const [remoteBranches, setRemoteBranches] = useState<CheckoutGitRemoteBranchNode[]>([]);
  const [tags, setTags] = useState<CheckoutGitTagNode[]>([]);
  const [stashes, setStashes] = useState<CheckoutGitStashNode[]>([]);
  const [conflictState, setConflictState] = useState<CheckoutGitConflictState>({
    inProgress: null,
    conflictFiles: [],
  });

  // Tree section collapse states
  const [localBranchesOpen, setLocalBranchesOpen] = useState<boolean>(true);
  const [remoteBranchesOpen, setRemoteBranchesOpen] = useState<boolean>(true);
  const [tagsOpen, setTagsOpen] = useState<boolean>(false);
  const [stashesOpen, setStashesOpen] = useState<boolean>(true);

  // Selected commit / stash / compare & file diff
  const [selectedCommitSha, setSelectedCommitSha] = useState<string | null>(
    initialCommitSha ?? null,
  );
  const [selectedStashIndex, setSelectedStashIndex] = useState<number | null>(null);
  const [stashDetail, setStashDetail] = useState<CheckoutGitDiffDetail | null>(null);
  const [selectedCompareRef, setSelectedCompareRef] = useState<string | null>(null);
  const [compareDetail, setCompareDetail] = useState<CheckoutGitDiffDetail | null>(null);

  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [selectedFileDiff, setSelectedFileDiff] = useState<ParsedDiffFile | null>(null);
  const [loadingFileDiff, setLoadingFileDiff] = useState<boolean>(false);
  const [diffViewMode, setDiffViewMode] = useState<"unified" | "split">("split");

  // 3-Way Merge Conflict Resolver modal state
  const [conflictModalOpen, setConflictModalOpen] = useState<boolean>(false);
  const [conflictInitialFile, setConflictInitialFile] = useState<string | null>(null);

  // Inline prompt state (rendered at top of Git window so it is always visible)
  const [promptMode, setPromptMode] = useState<
    | null
    | { kind: "new-branch"; targetSha: string; defaultLabel: string }
    | { kind: "new-tag"; targetSha: string }
    | { kind: "reset"; targetSha: string }
    | { kind: "reword"; targetSha: string; initialMessage: string }
    | { kind: "squash"; targetSha: string; initialMessage: string }
    | { kind: "new-stash" }
    | { kind: "stash-branch"; stashIndex: number; stashRef: string }
    | {
        kind: "confirm-action";
        title: string;
        message: string;
        confirmLabel: string;
        destructive?: boolean;
        action: CheckoutGitLogAction;
      }
  >(null);
  const [promptInputValue, setPromptInputValue] = useState<string>("");

  useEffect(() => {
    if (initialFilePath !== undefined && initialFilePath !== null) {
      setFilePathFilter(initialFilePath);
    }
  }, [initialFilePath]);

  useEffect(() => {
    if (initialCommitSha) {
      setSelectedCommitSha(initialCommitSha);
    }
  }, [initialCommitSha]);

  const fetchGraphData = useCallback(
    async (manualRefresh = false) => {
      if (!client || !cwd || !visible) return;
      setLoading(true);
      setErrorMsg(null);
      if (manualRefresh) {
        showModalFeedback("info", "Refreshing Git log...");
      }
      try {
        const response = await client.queryGitGraphLog(cwd, {
          allBranches: selectedRef ? false : allBranches,
          ref: selectedRef ?? undefined,
          search: searchQuery.trim() || undefined,
          author: authorFilter.trim() || undefined,
          filePath: filePathFilter.trim() || undefined,
          limit: 250,
        });
        setCommits(response.commits ?? []);
        setCurrentBranch(response.currentBranch ?? null);
        setHeadSha(response.headSha ?? null);
        setBranches(response.branches ?? []);
        setRemoteBranches(response.remoteBranches ?? []);
        setTags(response.tags ?? []);
        setStashes(response.stashes ?? []);
        setConflictState(
          response.conflictState ?? {
            inProgress: null,
            conflictFiles: [],
          },
        );

        if (response.commits.length > 0) {
          setSelectedCommitSha((prev) =>
            prev && response.commits.some((c) => c.sha === prev) ? prev : response.commits[0].sha,
          );
        } else {
          setSelectedCommitSha(null);
        }
        if (manualRefresh) {
          showModalFeedback(
            "success",
            `Refreshed Git log (${response.commits?.length ?? 0} commits)`,
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to load git graph";
        setErrorMsg(msg);
        if (manualRefresh) {
          showModalFeedback("error", msg);
        }
      } finally {
        setLoading(false);
      }
    },
    [
      allBranches,
      authorFilter,
      client,
      cwd,
      filePathFilter,
      searchQuery,
      selectedRef,
      showModalFeedback,
      visible,
    ],
  );

  useEffect(() => {
    if (visible) {
      void fetchGraphData();
    }
  }, [fetchGraphData, visible]);

  // Keyboard shortcuts on Web (Escape closes Repository Diff first, then Git Window; Cmd+D opens Repository Diff)
  useEffect(() => {
    if (!isWeb || !visible || conflictModalOpen || typeof window === "undefined") return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (repoDiffModalOpen) {
          setRepoDiffModalOpen(false);
        } else {
          onClose();
        }
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d") {
        if (selectedFilePath) {
          e.preventDefault();
          setRepoDiffModalOpen((prev) => !prev);
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [conflictModalOpen, onClose, repoDiffModalOpen, selectedFilePath, visible]);

  // Filter commits by Date preset if active
  const visibleCommits = useMemo(() => {
    if (dateFilterPreset === "all") return commits;
    const now = Date.now();
    const cutoffMs =
      dateFilterPreset === "24h"
        ? 24 * 3600 * 1000
        : dateFilterPreset === "7d"
          ? 7 * 24 * 3600 * 1000
          : 30 * 24 * 3600 * 1000;
    return commits.filter((c) => {
      const t = new Date(c.authorDate).getTime();
      return !Number.isNaN(t) && now - t <= cutoffMs;
    });
  }, [commits, dateFilterPreset]);

  const selectedCommit = useMemo(
    () =>
      visibleCommits.find((c) => c.sha === selectedCommitSha) ??
      commits.find((c) => c.sha === selectedCommitSha) ??
      null,
    [commits, selectedCommitSha, visibleCommits],
  );

  // Load stash detail when selectedStashIndex changes
  useEffect(() => {
    if (!client || !cwd || selectedStashIndex === null) {
      setStashDetail(null);
      return;
    }
    let cancelled = false;
    setLoadingFileDiff(true);
    client
      .getGitStashDetail(cwd, selectedStashIndex)
      .then((res) => {
        if (!cancelled) {
          setStashDetail(res.stashDetail);
          const firstPath = res.stashDetail?.files[0]?.path ?? null;
          setSelectedFilePath(firstPath);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setStashDetail(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingFileDiff(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [client, cwd, selectedStashIndex]);

  // Load compare detail when selectedCompareRef changes
  useEffect(() => {
    if (!client || !cwd || !selectedCompareRef) {
      setCompareDetail(null);
      return;
    }
    let cancelled = false;
    setLoadingFileDiff(true);
    client
      .getGitCompareDetail(cwd, selectedCompareRef)
      .then((res) => {
        if (!cancelled) {
          setCompareDetail(res.compareDetail);
          const firstPath = res.compareDetail?.files[0]?.path ?? null;
          setSelectedFilePath(firstPath);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCompareDetail(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingFileDiff(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [client, cwd, selectedCompareRef]);

  // Load file diff when selectedFilePath changes
  useEffect(() => {
    setActiveHunkIndex(0);
    if (selectedStashIndex !== null) {
      const diff = stashDetail?.diffs.find((d) => d.path === selectedFilePath) ?? null;
      setSelectedFileDiff(diff as ParsedDiffFile | null);
      return;
    }
    if (selectedCompareRef !== null) {
      const diff = compareDetail?.diffs.find((d) => d.path === selectedFilePath) ?? null;
      setSelectedFileDiff(diff as ParsedDiffFile | null);
      return;
    }
    if (!client || !cwd || !selectedCommit || !selectedFilePath) {
      setSelectedFileDiff(null);
      return;
    }
    let cancelled = false;
    setLoadingFileDiff(true);
    client
      .getCommitFileDiff(cwd, selectedCommit.sha, selectedFilePath)
      .then((res) => {
        if (!cancelled) {
          setSelectedFileDiff(res.file);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSelectedFileDiff(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingFileDiff(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    client,
    compareDetail,
    cwd,
    selectedCommit,
    selectedCompareRef,
    selectedFilePath,
    selectedStashIndex,
    stashDetail,
  ]);

  // Auto-select first file of selected commit when not in stash/compare mode
  useEffect(() => {
    if (selectedStashIndex !== null || selectedCompareRef !== null) return;
    if (selectedCommit && selectedCommit.files.length > 0) {
      setSelectedFilePath(selectedCommit.files[0].path);
    } else {
      setSelectedFilePath(null);
    }
  }, [selectedCommit, selectedCompareRef, selectedStashIndex]);

  const graphLayout = useMemo(() => computeCommitGraphLayout(visibleCommits), [visibleCommits]);

  const executeGitAction = useCallback(
    async (action: CheckoutGitLogAction, skipConfirm = false) => {
      if (!client || !cwd || actionBusy) return;
      if (!skipConfirm) {
        const shortTarget = action.target.length === 40 ? action.target.slice(0, 7) : action.target;
        const headLabel = currentBranch ?? "HEAD";
        let confirmInput: ConfirmDialogInput | null = null;
        switch (action.kind) {
          case "merge-ref":
            confirmInput = {
              title: `Merge '${shortTarget}' into '${headLabel}'?`,
              message: `Merge changes from '${shortTarget}' into current branch '${headLabel}'. Any uncommitted local changes will be automatically stashed and restored.`,
              confirmLabel: "Merge Branch",
              branchFlow: { from: shortTarget, to: headLabel, actionLabel: "MERGE INTO" },
              badges: [
                { label: "Auto-Stash: ON", tone: "emerald" },
                { label: "3-Way Conflict Resolver", tone: "cyan" },
              ],
            };
            break;
          case "rebase-onto":
            confirmInput = {
              title: `Rebase '${headLabel}' onto '${shortTarget}'?`,
              message: `Reapply commits from '${headLabel}' on top of '${shortTarget}'. Any uncommitted local changes will be automatically stashed and restored.`,
              confirmLabel: "Rebase Branch",
              branchFlow: { from: headLabel, to: shortTarget, actionLabel: "REBASE ONTO" },
              badges: [
                { label: "Auto-Stash: ON", tone: "emerald" },
                { label: "3-Way Conflict Resolver", tone: "cyan" },
              ],
            };
            break;
          case "cherry-pick":
            confirmInput = {
              title: `Cherry-Pick Commit ${shortTarget}?`,
              message: `Apply commit ${shortTarget} onto current branch '${headLabel}'. Uncommitted local changes will be auto-stashed and restored.`,
              confirmLabel: "Cherry-Pick",
              branchFlow: { from: shortTarget, to: headLabel, actionLabel: "CHERRY-PICK" },
              badges: [{ label: "Auto-Stash: ON", tone: "emerald" }],
            };
            break;
          case "revert":
            confirmInput = {
              title: `Revert Commit ${shortTarget}?`,
              message: `Create a new commit on '${headLabel}' that reverses all changes introduced by commit ${shortTarget}.`,
              confirmLabel: "Revert Commit",
              branchFlow: { from: shortTarget, to: headLabel, actionLabel: "REVERT ON" },
              badges: [{ label: "Auto-Stash: ON", tone: "emerald" }],
            };
            break;
          case "drop-commit":
            confirmInput = {
              title: "Drop Commit",
              message: `Permanently drop commit ${shortTarget} from branch '${headLabel}' history?`,
              confirmLabel: "Drop Commit",
              destructive: true,
            };
            break;
          case "reset": {
            const resetMode = action.mode ?? "mixed";
            confirmInput = {
              title: `Reset Current Branch (--${resetMode})`,
              message:
                resetMode === "hard"
                  ? `Reset "${headLabel}" to ${shortTarget} (--hard)? Uncommitted working tree and staged changes will be permanently discarded!`
                  : `Move "${headLabel}" HEAD pointer to ${shortTarget} (--${resetMode})? Working tree files will be preserved.`,
              confirmLabel: `Reset --${resetMode.toUpperCase()}`,
              destructive: resetMode === "hard",
              branchFlow: {
                from: headLabel,
                to: shortTarget,
                actionLabel: `RESET --${resetMode.toUpperCase()}`,
              },
            };
            break;
          }
          case "delete-branch":
            confirmInput = {
              title: "Delete Branch",
              message: `Delete local branch "${action.target}"?`,
              confirmLabel: "Delete Branch",
              destructive: true,
            };
            break;
          case "delete-tag":
            confirmInput = {
              title: "Delete Tag",
              message: `Delete tag "${action.target}"?`,
              confirmLabel: "Delete Tag",
              destructive: true,
            };
            break;
          case "stash-drop":
            confirmInput = {
              title: "Drop Stash",
              message: `Permanently delete stash@{${action.target}}?`,
              confirmLabel: "Drop Stash",
              destructive: true,
            };
            break;
          case "apply-hunk-patch":
            if (action.patchMode !== "stage") {
              confirmInput = {
                title: "Rollback Diff Hunk",
                message: `Discard changes in this hunk from "${action.target}"?`,
                confirmLabel: "Rollback Hunk",
                destructive: true,
              };
            }
            break;
          case "abort-operation":
            confirmInput = {
              title: "Abort Git Operation",
              message: "Abort the current Merge / Rebase / Cherry-Pick and restore previous state?",
              confirmLabel: "Abort Operation",
              destructive: true,
            };
            break;
          default:
            break;
        }
        if (confirmInput) {
          const ok = await confirmDialog(confirmInput);
          if (!ok) {
            return;
          }
        }
      }

      setActionBusy(true);
      showModalFeedback(
        "info",
        action.kind === "checkout-ref"
          ? `Switching HEAD to ${action.target}...`
          : `Running ${action.kind} (${action.target})...`,
      );
      try {
        const res = await client.runGitLogAction(cwd, action);
        if (!res.success) {
          const errText = res.message ?? `Git ${action.kind} failed`;
          showModalFeedback("error", errText);
          toast.error(errText);
          await fetchGraphData();
          return;
        }
        const msg = res.message || `Executed ${action.kind}`;
        const hasConflict = msg.startsWith("CONFLICT:");
        showModalFeedback(hasConflict ? "error" : "success", msg);
        toast.show(msg);
        setPromptMode(null);
        setPromptInputValue("");
        if (action.kind === "stash-drop" || action.kind === "stash-pop") {
          setSelectedStashIndex(null);
        }
        if (action.kind === "delete-branch" && selectedRef === action.target) {
          setSelectedRef(null);
        }
        await invalidateCheckoutGitQueriesForClient(queryClient, { serverId, cwd });
        await fetchGraphData();
        if (hasConflict) {
          setConflictModalOpen(true);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : `Git ${action.kind} failed`;
        showModalFeedback("error", message);
        toast.error(message);
        await fetchGraphData();
      } finally {
        setActionBusy(false);
      }
    },
    [
      actionBusy,
      client,
      currentBranch,
      cwd,
      fetchGraphData,
      queryClient,
      selectedRef,
      serverId,
      showModalFeedback,
      toast,
    ],
  );

  const handlePull = useCallback(async () => {
    if (!client || !cwd || actionBusy) return;
    setActionBusy(true);
    showModalFeedback("info", `Pulling latest changes into ${currentBranch ?? "HEAD"}...`);
    try {
      await client.checkoutPull(cwd);
      showModalFeedback("success", `Pulled latest changes into ${currentBranch ?? "HEAD"}`);
      toast.show("Pulled latest changes");
      await invalidateCheckoutGitQueriesForClient(queryClient, { serverId, cwd });
      await fetchGraphData();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Pull failed";
      showModalFeedback("error", `Pull failed: ${msg}`);
      toast.error(msg);
    } finally {
      setActionBusy(false);
    }
  }, [
    actionBusy,
    client,
    currentBranch,
    cwd,
    fetchGraphData,
    queryClient,
    serverId,
    showModalFeedback,
    toast,
  ]);

  const handlePush = useCallback(async () => {
    if (!client || !cwd || actionBusy) return;
    setActionBusy(true);
    showModalFeedback("info", `Pushing ${currentBranch ?? "HEAD"} to remote...`);
    try {
      await client.checkoutPush(cwd);
      showModalFeedback("success", `Pushed ${currentBranch ?? "HEAD"} to remote`);
      toast.show("Pushed current branch");
      await invalidateCheckoutGitQueriesForClient(queryClient, { serverId, cwd });
      await fetchGraphData();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Push failed";
      showModalFeedback("error", `Push failed: ${msg}`);
      toast.error(msg);
    } finally {
      setActionBusy(false);
    }
  }, [
    actionBusy,
    client,
    currentBranch,
    cwd,
    fetchGraphData,
    queryClient,
    serverId,
    showModalFeedback,
    toast,
  ]);

  const handleCopySha = useCallback(
    async (sha: string) => {
      await Clipboard.setStringAsync(sha);
      showModalFeedback("success", `Copied SHA ${sha.slice(0, 8)}`);
      toast.show(`Copied SHA ${sha.slice(0, 8)}`);
    },
    [showModalFeedback, toast],
  );

  const toggleStarRef = useCallback((refName: string) => {
    setStarredRefs((prev) => {
      const next = new Set(prev);
      if (next.has(refName)) {
        next.delete(refName);
      } else {
        next.add(refName);
      }
      return next;
    });
  }, []);

  const toggleBranchFolder = useCallback((folderKey: string) => {
    setCollapsedBranchFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderKey)) {
        next.delete(folderKey);
      } else {
        next.add(folderKey);
      }
      return next;
    });
  }, []);

  const toggleFileDir = useCallback((dirPath: string) => {
    setCollapsedFileDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) {
        next.delete(dirPath);
      } else {
        next.add(dirPath);
      }
      return next;
    });
  }, []);

  const filteredLocalBranches = useMemo(() => {
    const q = refTreeFilter.trim().toLowerCase();
    if (!q) return branches;
    return branches.filter((b) => b.name.toLowerCase().includes(q));
  }, [branches, refTreeFilter]);

  const filteredRemoteBranches = useMemo(() => {
    const q = refTreeFilter.trim().toLowerCase();
    if (!q) return remoteBranches;
    return remoteBranches.filter((b) => b.name.toLowerCase().includes(q));
  }, [remoteBranches, refTreeFilter]);

  const filteredTags = useMemo(() => {
    const q = refTreeFilter.trim().toLowerCase();
    if (!q) return tags;
    return tags.filter((t) => t.name.toLowerCase().includes(q));
  }, [tags, refTreeFilter]);

  const filteredStashes = useMemo(() => {
    const q = refTreeFilter.trim().toLowerCase();
    if (!q) return stashes;
    return stashes.filter(
      (s) => s.ref.toLowerCase().includes(q) || s.message.toLowerCase().includes(q),
    );
  }, [stashes, refTreeFilter]);

  const groupedLocalBranches = useMemo(
    () => groupBranchesByFolder(filteredLocalBranches, starredRefs, false),
    [filteredLocalBranches, starredRefs],
  );

  const groupedRemoteBranches = useMemo(
    () => groupBranchesByFolder(filteredRemoteBranches, starredRefs, true),
    [filteredRemoteBranches, starredRefs],
  );

  const activeChangedFiles = useMemo(() => {
    if (selectedStashIndex !== null) {
      return stashDetail?.files ?? [];
    }
    if (selectedCompareRef !== null) {
      return compareDetail?.files ?? [];
    }
    return selectedCommit?.files ?? [];
  }, [compareDetail, selectedCommit, selectedCompareRef, selectedStashIndex, stashDetail]);

  const groupedChangedFiles = useMemo(
    () => groupChangedFilesByDirectory(activeChangedFiles),
    [activeChangedFiles],
  );

  const selectedFileIndex = useMemo(
    () => activeChangedFiles.findIndex((f) => f.path === selectedFilePath),
    [activeChangedFiles, selectedFilePath],
  );

  const handleFileRowPress = useCallback((path: string) => {
    const now = Date.now();
    if (lastFileClickRef.current.path === path && now - lastFileClickRef.current.time < 360) {
      setSelectedFilePath(path);
      setRepoDiffModalOpen(true);
    } else {
      setSelectedFilePath(path);
    }
    lastFileClickRef.current = { path, time: now };
  }, []);

  const selectedLocalBranchObj = useMemo(
    () => branches.find((b) => b.name === selectedRef) ?? null,
    [branches, selectedRef],
  );
  const selectedRemoteBranchObj = useMemo(
    () => remoteBranches.find((rb) => rb.name === selectedRef) ?? null,
    [remoteBranches, selectedRef],
  );
  const selectedTagObj = useMemo(
    () => tags.find((t) => t.name === selectedRef) ?? null,
    [tags, selectedRef],
  );

  if (!visible) return null;

  const logTabTitle = selectedRef
    ? `Log: ${selectedRef}`
    : !allBranches
      ? `Log: HEAD (${currentBranch ?? "detached"})`
      : "Log: All";

  const renderLocalBranchRow = (
    b: CheckoutGitBranchNode,
    shortLabel: string,
    indented: boolean,
  ) => {
    const isSelected = selectedRef === b.name;
    const isStarred = starredRefs.has(b.name) || b.isCurrent;
    return (
      <View key={`local-${b.name}`}>
        <Pressable
          style={[
            styles.refTreeItem,
            indented && styles.refTreeItemIndented,
            isSelected && styles.refTreeItemSelected,
          ]}
          onPress={() => {
            const now = Date.now();
            if (
              lastBranchClickRef.current.name === b.name &&
              now - lastBranchClickRef.current.time < 360 &&
              !b.isCurrent
            ) {
              lastBranchClickRef.current = { name: "", time: 0 };
              void executeGitAction({ kind: "checkout-ref", target: b.name });
              return;
            }
            lastBranchClickRef.current = { name: b.name, time: now };
            setSelectedStashIndex(null);
            setSelectedCompareRef(null);
            setSelectedRef(b.name);
            setAllBranches(false);
          }}
          testID={`pycharm-git-branch-local-${b.name}`}
        >
          <Pressable
            onPress={(e) => {
              e.stopPropagation?.();
              toggleStarRef(b.name);
            }}
            hitSlop={4}
          >
            <Star
              size={11}
              color={isStarred ? "#f59e0b" : "#475569"}
              fill={isStarred ? "#f59e0b" : "transparent"}
            />
          </Pressable>
          <GitBranch size={12} color={b.isCurrent ? "#10b981" : "#94a3b8"} />
          <Text
            style={[
              styles.refTreeItemText,
              b.isCurrent && styles.refTreeItemCurrentText,
              isSelected && styles.refTreeItemSelectedText,
            ]}
            numberOfLines={1}
          >
            {shortLabel}
          </Text>
          {(b.ahead ?? 0) > 0 || (b.behind ?? 0) > 0 ? (
            <Text style={styles.aheadBehindBadge}>
              {(b.ahead ?? 0) > 0 ? `↑${b.ahead}` : ""}
              {(b.ahead ?? 0) > 0 && (b.behind ?? 0) > 0 ? " " : ""}
              {(b.behind ?? 0) > 0 ? `↓${b.behind}` : ""}
            </Text>
          ) : null}
        </Pressable>
        {isSelected && !b.isCurrent ? (
          <View
            style={styles.inlineBranchActionStrip}
            testID={`pycharm-git-branch-popup-${b.name}`}
          >
            <Pressable
              style={styles.inlineBranchCheckoutBtn}
              disabled={actionBusy}
              onPress={() => void executeGitAction({ kind: "checkout-ref", target: b.name })}
              testID={`pycharm-git-inline-checkout-${b.name}`}
            >
              <Text style={styles.inlineBranchCheckoutText}>Checkout</Text>
            </Pressable>
            <Pressable
              style={styles.inlineBranchMergeBtn}
              disabled={actionBusy}
              onPress={() => void executeGitAction({ kind: "merge-ref", target: b.name })}
              testID={`pycharm-git-inline-merge-${b.name}`}
            >
              <Text style={styles.inlineBranchMergeText}>Merge into {currentBranch ?? "HEAD"}</Text>
            </Pressable>
            <Pressable
              style={styles.inlineBranchNeutralBtn}
              disabled={actionBusy}
              onPress={() => void executeGitAction({ kind: "rebase-onto", target: b.name })}
              testID={`pycharm-git-inline-rebase-${b.name}`}
            >
              <Text style={styles.inlineBranchNeutralText}>Rebase</Text>
            </Pressable>
            <Pressable
              style={styles.inlineBranchNeutralBtn}
              disabled={actionBusy}
              onPress={() => {
                setSelectedStashIndex(null);
                setSelectedCompareRef((prev) => (prev === b.name ? null : b.name));
              }}
              testID={`pycharm-git-inline-compare-${b.name}`}
            >
              <Text style={styles.inlineBranchNeutralText}>Compare</Text>
            </Pressable>
            <Pressable
              style={styles.inlineBranchDangerBtn}
              disabled={actionBusy}
              onPress={() => void executeGitAction({ kind: "delete-branch", target: b.name })}
              testID={`pycharm-git-inline-delete-${b.name}`}
            >
              <Text style={styles.inlineBranchDangerText}>Delete</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    );
  };

  const renderRemoteBranchRow = (
    rb: CheckoutGitRemoteBranchNode,
    shortLabel: string,
    indented: boolean,
  ) => {
    const isSelected = selectedRef === rb.name;
    const isStarred = starredRefs.has(rb.name);
    return (
      <View key={`remote-${rb.name}`}>
        <Pressable
          style={[
            styles.refTreeItem,
            indented && styles.refTreeItemIndented,
            isSelected && styles.refTreeItemSelected,
          ]}
          onPress={() => {
            setSelectedStashIndex(null);
            setSelectedCompareRef(null);
            setSelectedRef(rb.name);
            setAllBranches(false);
          }}
          testID={`pycharm-git-branch-remote-${rb.name}`}
        >
          <Pressable
            onPress={(e) => {
              e.stopPropagation?.();
              toggleStarRef(rb.name);
            }}
            hitSlop={4}
          >
            <Star
              size={11}
              color={isStarred ? "#f59e0b" : "#475569"}
              fill={isStarred ? "#f59e0b" : "transparent"}
            />
          </Pressable>
          <GitFork size={12} color="#06b6d4" />
          <Text
            style={[styles.refTreeItemText, isSelected && styles.refTreeItemSelectedText]}
            numberOfLines={1}
          >
            {shortLabel}
          </Text>
        </Pressable>
        {isSelected ? (
          <View
            style={styles.inlineBranchActionStrip}
            testID={`pycharm-git-branch-popup-${rb.name}`}
          >
            <Pressable
              style={styles.inlineBranchCheckoutBtn}
              disabled={actionBusy}
              onPress={() => void executeGitAction({ kind: "checkout-ref", target: rb.name })}
              testID={`pycharm-git-inline-checkout-${rb.name}`}
            >
              <Text style={styles.inlineBranchCheckoutText}>Checkout</Text>
            </Pressable>
            <Pressable
              style={styles.inlineBranchMergeBtn}
              disabled={actionBusy}
              onPress={() => void executeGitAction({ kind: "merge-ref", target: rb.name })}
              testID={`pycharm-git-inline-merge-${rb.name}`}
            >
              <Text style={styles.inlineBranchMergeText}>Merge into {currentBranch ?? "HEAD"}</Text>
            </Pressable>
            <Pressable
              style={styles.inlineBranchNeutralBtn}
              disabled={actionBusy}
              onPress={() => void executeGitAction({ kind: "rebase-onto", target: rb.name })}
              testID={`pycharm-git-inline-rebase-${rb.name}`}
            >
              <Text style={styles.inlineBranchNeutralText}>Rebase</Text>
            </Pressable>
            <Pressable
              style={styles.inlineBranchNeutralBtn}
              disabled={actionBusy}
              onPress={() => {
                setSelectedStashIndex(null);
                setSelectedCompareRef((prev) => (prev === rb.name ? null : rb.name));
              }}
              testID={`pycharm-git-inline-compare-${rb.name}`}
            >
              <Text style={styles.inlineBranchNeutralText}>Compare</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    );
  };

  const renderChangedFileRow = (
    f: CheckoutCommitFile,
    showDirSuffix: boolean,
    indented: boolean,
  ) => {
    const isFileSelected = f.path === selectedFilePath;
    const lastSlash = f.path.lastIndexOf("/");
    const fileName = lastSlash === -1 ? f.path : f.path.slice(lastSlash + 1);
    const dirName = lastSlash === -1 ? "" : f.path.slice(0, lastSlash);
    const statusColor =
      f.status === "added"
        ? "#10b981"
        : f.status === "deleted"
          ? "#f43f5e"
          : f.status === "renamed"
            ? "#06b6d4"
            : theme.colorScheme === "dark"
              ? "#60a5fa"
              : "#2563eb";

    return (
      <Pressable
        key={f.path}
        style={[
          styles.fileTreeLeafRow,
          indented && styles.fileTreeLeafIndented,
          isFileSelected && styles.fileTreeLeafSelected,
        ]}
        onPress={() => handleFileRowPress(f.path)}
      >
        <FileCode2 size={13} color={statusColor} />
        <Text style={[styles.fileTreeLeafName, { color: statusColor }]} numberOfLines={1}>
          {fileName}
        </Text>
        {showDirSuffix && dirName ? (
          <Text style={styles.fileTreeLeafDirHint} numberOfLines={1}>
            {dirName}
          </Text>
        ) : null}
        <View style={styles.commitFileStats}>
          {f.additions > 0 ? <Text style={styles.statAdd}>+{f.additions}</Text> : null}
          {f.deletions > 0 ? <Text style={styles.statDel}>-{f.deletions}</Text> : null}
          <Pressable
            style={styles.fileRowQuickDiffBtn}
            onPress={(e) => {
              e.stopPropagation?.();
              setSelectedFilePath(f.path);
              setRepoDiffModalOpen(true);
            }}
            hitSlop={4}
            testID={`open-repo-diff-${fileName}`}
          >
            <Columns2 size={11} color={theme.colors.foregroundMuted} />
          </Pressable>
        </View>
      </Pressable>
    );
  };

  const hunkCount = selectedFileDiff?.hunks?.length ?? 0;
  const parentShortSha = selectedCommit?.parents?.[0]?.slice(0, 8) ?? "base";
  const commitShortSha =
    selectedStashIndex !== null
      ? `stash@{${selectedStashIndex}}`
      : selectedCompareRef !== null
        ? "HEAD"
        : (selectedCommit?.shortSha ?? "HEAD");
  const leftLabel =
    selectedCompareRef !== null
      ? `${selectedCompareRef} ${selectedFilePath ?? ""}`
      : `${parentShortSha} ${selectedFilePath ?? ""}`;
  const rightLabel = `${commitShortSha} ${selectedFilePath ?? ""}`;

  const modalContent = (
    <>
      <View style={styles.backdrop} testID="pycharm-git-modal-backdrop">
        <View style={styles.modalWindow} testID="pycharm-git-modal">
          {/* PyCharm Tool Window Top Tab Bar */}
          <View style={styles.topHeader}>
            <View style={styles.topHeaderLeft}>
              <Text style={styles.toolWindowTitle}>Git</Text>

              {/* Active Log Tab Pill (`Log: master ×`) */}
              <View style={styles.toolWindowTabActive}>
                <GitBranch size={12} color="#10b981" />
                <Text style={styles.toolWindowTabText}>{logTabTitle}</Text>
                {selectedRef || !allBranches ? (
                  <Pressable
                    onPress={() => {
                      setSelectedRef(null);
                      setAllBranches(true);
                    }}
                    hitSlop={6}
                  >
                    <X size={11} color={theme.colors.foregroundMuted} />
                  </Pressable>
                ) : null}
              </View>

              {currentBranch ? (
                <View style={styles.currentBranchPill}>
                  <Text style={styles.currentBranchPillText}>HEAD → {currentBranch}</Text>
                </View>
              ) : null}

              {(selectedLocalBranchObj && !selectedLocalBranchObj.isCurrent) ||
              selectedRemoteBranchObj ? (
                <>
                  <Pressable
                    style={({ pressed }) => [
                      styles.headerSwitchBranchBtn,
                      pressed && styles.btnPressed,
                    ]}
                    disabled={actionBusy}
                    onPress={() =>
                      void executeGitAction({
                        kind: "checkout-ref",
                        target: (selectedLocalBranchObj ?? selectedRemoteBranchObj)!.name,
                      })
                    }
                    testID="pycharm-git-header-checkout-selected-btn"
                  >
                    <GitBranch size={11} color="#10b981" />
                    <Text style={styles.headerSwitchBranchBtnText}>
                      Checkout {(selectedLocalBranchObj ?? selectedRemoteBranchObj)!.name}
                    </Text>
                  </Pressable>
                  <Pressable
                    style={({ pressed }) => [
                      styles.headerMergeBranchBtn,
                      pressed && styles.btnPressed,
                    ]}
                    disabled={actionBusy}
                    onPress={() =>
                      void executeGitAction({
                        kind: "merge-ref",
                        target: (selectedLocalBranchObj ?? selectedRemoteBranchObj)!.name,
                      })
                    }
                    testID="pycharm-git-header-merge-selected-btn"
                  >
                    <GitMerge size={11} color="#06b6d4" />
                    <Text style={styles.headerMergeBranchBtnText}>
                      Merge into {currentBranch ?? "HEAD"}
                    </Text>
                  </Pressable>
                </>
              ) : null}
            </View>

            <View style={styles.topHeaderActions}>
              {conflictState.conflictFiles.length > 0 ? (
                <Pressable
                  style={({ pressed }) => [
                    styles.headerActionBtn,
                    styles.headerConflictBtn,
                    pressed && styles.btnPressed,
                  ]}
                  onPress={() => {
                    setConflictInitialFile(conflictState.conflictFiles[0] ?? null);
                    setConflictModalOpen(true);
                  }}
                  testID="pycharm-git-open-conflicts-btn"
                >
                  <AlertTriangle size={13} color="#f59e0b" />
                  <Text style={styles.headerConflictBtnText}>
                    Resolve Conflicts ({conflictState.conflictFiles.length})
                  </Text>
                </Pressable>
              ) : null}
              <Pressable
                style={({ pressed }) => [styles.headerActionBtn, pressed && styles.btnPressed]}
                onPress={() => {
                  setPromptMode((prev) =>
                    prev?.kind === "new-stash" ? null : { kind: "new-stash" },
                  );
                  setPromptInputValue("");
                }}
                disabled={actionBusy}
                testID="pycharm-git-stash-create-btn"
              >
                <Archive size={13} color="#f59e0b" />
                <Text style={styles.headerActionBtnText}>Stash</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [styles.headerActionBtn, pressed && styles.btnPressed]}
                onPress={() => void fetchGraphData(true)}
                disabled={loading || actionBusy}
                testID="pycharm-git-refresh-btn"
              >
                <RefreshCw size={13} color={theme.colors.foregroundMuted} />
                <Text style={styles.headerActionBtnText}>
                  {loading ? "Refreshing..." : "Refresh"}
                </Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [styles.headerActionBtn, pressed && styles.btnPressed]}
                onPress={() => void handlePull()}
                disabled={actionBusy}
                testID="pycharm-git-pull-btn"
              >
                <ArrowDown size={13} color="#06b6d4" />
                <Text style={styles.headerActionBtnText}>Pull</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [styles.headerActionBtn, pressed && styles.btnPressed]}
                onPress={() => void handlePush()}
                disabled={actionBusy}
                testID="pycharm-git-push-btn"
              >
                <ArrowUp size={13} color="#10b981" />
                <Text style={styles.headerActionBtnText}>Push</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [styles.closeBtn, pressed && styles.btnPressed]}
                onPress={onClose}
                testID="pycharm-git-close-btn"
              >
                <X size={16} color={theme.colors.foregroundMuted} />
              </Pressable>
            </View>
          </View>

          {/* In-Modal Live Action Status Feedback Bar (always visible inside portal) */}
          {statusBanner ? (
            <View
              style={[
                styles.statusFeedbackBar,
                statusBanner.kind === "error"
                  ? styles.statusFeedbackError
                  : statusBanner.kind === "success"
                    ? styles.statusFeedbackSuccess
                    : styles.statusFeedbackInfo,
              ]}
              testID="pycharm-git-status-banner"
            >
              <Text
                style={[
                  styles.statusFeedbackText,
                  statusBanner.kind === "error"
                    ? { color: "#f43f5e" }
                    : statusBanner.kind === "success"
                      ? { color: "#10b981" }
                      : { color: "#06b6d4" },
                ]}
                numberOfLines={2}
              >
                {statusBanner.kind === "success"
                  ? `✓ ${statusBanner.text}`
                  : statusBanner.kind === "error"
                    ? `⚠ ${statusBanner.text}`
                    : `⟳ ${statusBanner.text}`}
              </Text>
              <Pressable onPress={() => setStatusBanner(null)} hitSlop={6}>
                <X size={13} color="#94a3b8" />
              </Pressable>
            </View>
          ) : null}

          {/* Top-Level Prompt / Confirmation Bar (Stash, New Branch, Tag, Reword, Squash, Reset, Confirm) */}
          {promptMode ? (
            <View style={styles.topPromptBar} testID="pycharm-git-top-prompt-bar">
              {promptMode.kind === "confirm-action" ? (
                <View style={styles.topPromptRow}>
                  <AlertTriangle size={13} color={promptMode.destructive ? "#f43f5e" : "#f59e0b"} />
                  <Text style={styles.topPromptTitle}>{promptMode.title}:</Text>
                  <Text style={styles.topPromptMessage} numberOfLines={1}>
                    {promptMode.message}
                  </Text>
                  <Pressable
                    style={[
                      styles.promptConfirmBtn,
                      promptMode.destructive && styles.promptConfirmDangerBtn,
                    ]}
                    disabled={actionBusy}
                    onPress={() => void executeGitAction(promptMode.action, true)}
                  >
                    <Check size={12} color={promptMode.destructive ? "#ffffff" : "#0f172a"} />
                    <Text
                      style={[
                        styles.promptConfirmText,
                        promptMode.destructive && { color: "#ffffff" },
                      ]}
                    >
                      {promptMode.confirmLabel}
                    </Text>
                  </Pressable>
                  <Pressable style={styles.promptCancelBtn} onPress={() => setPromptMode(null)}>
                    <Text style={styles.promptCancelText}>Cancel</Text>
                  </Pressable>
                </View>
              ) : promptMode.kind === "reset" ? (
                <View style={styles.topPromptRow}>
                  <Text style={styles.topPromptTitle}>
                    Reset current branch ({currentBranch ?? "HEAD"}) to{" "}
                    {promptMode.targetSha.slice(0, 7)}:
                  </Text>
                  <View style={styles.resetButtonsRow}>
                    {(["soft", "mixed", "hard"] as const).map((mode) => (
                      <Pressable
                        key={mode}
                        style={[
                          styles.resetModeChoiceBtn,
                          mode === "hard" && styles.resetModeChoiceDanger,
                        ]}
                        onPress={() =>
                          void executeGitAction({
                            kind: "reset",
                            target: promptMode.targetSha,
                            mode,
                          })
                        }
                      >
                        <Text style={styles.resetModeChoiceText}>{mode.toUpperCase()}</Text>
                      </Pressable>
                    ))}
                    <Pressable style={styles.promptCancelBtn} onPress={() => setPromptMode(null)}>
                      <Text style={styles.promptCancelText}>Cancel</Text>
                    </Pressable>
                  </View>
                </View>
              ) : (
                <View style={styles.topPromptRow}>
                  <Text style={styles.topPromptTitle}>
                    {promptMode.kind === "new-branch"
                      ? `Create & Checkout Branch from ${promptMode.defaultLabel}:`
                      : promptMode.kind === "new-tag"
                        ? `Create Tag at ${promptMode.targetSha.slice(0, 7)}:`
                        : promptMode.kind === "reword"
                          ? `Reword Commit ${promptMode.targetSha.slice(0, 7)}:`
                          : promptMode.kind === "squash"
                            ? `Squash ${promptMode.targetSha.slice(0, 7)} into Parent:`
                            : promptMode.kind === "new-stash"
                              ? "Stash Local Changes (includes untracked):"
                              : `Create Branch from ${promptMode.stashRef}:`}
                  </Text>
                  <TextInput
                    value={promptInputValue}
                    onChangeText={setPromptInputValue}
                    autoFocus
                    placeholder={
                      promptMode.kind === "new-branch" || promptMode.kind === "stash-branch"
                        ? "feature/my-branch"
                        : promptMode.kind === "new-tag"
                          ? "v1.0.0"
                          : promptMode.kind === "new-stash"
                            ? "WIP: stash description (optional)..."
                            : "New commit message..."
                    }
                    placeholderTextColor="#64748b"
                    style={styles.promptInput}
                  />
                  <Pressable
                    style={styles.promptConfirmBtn}
                    disabled={
                      actionBusy ||
                      (promptMode.kind !== "squash" &&
                        promptMode.kind !== "new-stash" &&
                        !promptInputValue.trim())
                    }
                    onPress={() => {
                      const val = promptInputValue.trim();
                      if (promptMode.kind === "new-branch") {
                        if (!val) return;
                        void executeGitAction({
                          kind: "create-branch",
                          target: val,
                          secondTarget: promptMode.targetSha,
                        });
                      } else if (promptMode.kind === "new-tag") {
                        if (!val) return;
                        void executeGitAction({
                          kind: "create-tag",
                          target: val,
                          secondTarget: promptMode.targetSha,
                        });
                      } else if (promptMode.kind === "reword") {
                        if (!val) return;
                        void executeGitAction({
                          kind: "reword-commit",
                          target: promptMode.targetSha,
                          message: val,
                        });
                      } else if (promptMode.kind === "squash") {
                        void executeGitAction({
                          kind: "squash-commit",
                          target: promptMode.targetSha,
                          message: val || undefined,
                        });
                      } else if (promptMode.kind === "new-stash") {
                        void executeGitAction({
                          kind: "stash-create",
                          target: val || "WIP",
                          message: val || "WIP",
                        });
                      } else if (promptMode.kind === "stash-branch") {
                        if (!val) return;
                        void executeGitAction({
                          kind: "stash-branch",
                          target: val,
                          secondTarget: String(promptMode.stashIndex),
                        });
                      }
                    }}
                  >
                    <Check size={12} color="#0f172a" />
                    <Text style={styles.promptConfirmText}>
                      {promptMode.kind === "new-stash" ? "Stash Now" : "Apply"}
                    </Text>
                  </Pressable>
                  <Pressable style={styles.promptCancelBtn} onPress={() => setPromptMode(null)}>
                    <Text style={styles.promptCancelText}>Cancel</Text>
                  </Pressable>
                </View>
              )}
            </View>
          ) : null}

          {/* Active Operation / Merge Conflict Alert Banner */}
          {conflictState.inProgress !== null || conflictState.conflictFiles.length > 0 ? (
            <View style={styles.conflictBanner} testID="pycharm-git-conflict-banner">
              <View style={styles.conflictBannerLeft}>
                <AlertTriangle size={14} color="#f59e0b" />
                <Text style={styles.conflictBannerTitle}>
                  {conflictState.inProgress
                    ? `${conflictState.inProgress.toUpperCase()} IN PROGRESS`
                    : "UNRESOLVED MERGE CONFLICTS"}
                </Text>
                <Text style={styles.conflictBannerSub}>
                  {conflictState.conflictFiles.length > 0
                    ? `${conflictState.conflictFiles.length} conflicted file(s): ${conflictState.conflictFiles.slice(0, 3).join(", ")}${conflictState.conflictFiles.length > 3 ? "..." : ""}`
                    : "All conflicts resolved — ready to continue or abort."}
                </Text>
              </View>
              <View style={styles.conflictBannerActions}>
                {conflictState.conflictFiles.length > 0 ? (
                  <Pressable
                    style={styles.conflictBannerPrimaryBtn}
                    onPress={() => {
                      setConflictInitialFile(conflictState.conflictFiles[0] ?? null);
                      setConflictModalOpen(true);
                    }}
                    testID="pycharm-git-resolve-3way-btn"
                  >
                    <Layers size={12} color="#0f172a" />
                    <Text style={styles.conflictBannerPrimaryText}>Resolve in 3-Way Merge...</Text>
                  </Pressable>
                ) : null}
                {conflictState.inProgress ? (
                  <Pressable
                    style={styles.conflictBannerContinueBtn}
                    disabled={actionBusy}
                    onPress={() =>
                      void executeGitAction({
                        kind: "continue-operation",
                        target: "auto",
                      })
                    }
                  >
                    <Play size={11} color="#10b981" />
                    <Text style={styles.conflictBannerContinueText}>Continue</Text>
                  </Pressable>
                ) : null}
                {conflictState.inProgress ? (
                  <Pressable
                    style={styles.conflictBannerAbortBtn}
                    disabled={actionBusy}
                    onPress={() =>
                      void executeGitAction({
                        kind: "abort-operation",
                        target: "auto",
                      })
                    }
                  >
                    <Square size={11} color="#f43f5e" />
                    <Text style={styles.conflictBannerAbortText}>Abort</Text>
                  </Pressable>
                ) : null}
              </View>
            </View>
          ) : null}

          {/* Main 3-Pane PyCharm Body */}
          <View style={styles.threeColumnBody}>
            {/* LEFT PANE: Hierarchical Branch / Tag / Stash Tree (`pycharm-ref-1.png`) */}
            <View style={styles.leftColumn}>
              <View style={styles.refFilterBox}>
                <TextInput
                  value={refTreeFilter}
                  onChangeText={setRefTreeFilter}
                  placeholder="Branch or tag"
                  placeholderTextColor="#64748b"
                  style={styles.refFilterInput}
                />
                {refTreeFilter ? (
                  <Pressable
                    onPress={() => setRefTreeFilter("")}
                    hitSlop={6}
                    style={styles.filterIconWrap}
                  >
                    <X size={12} color="#64748b" />
                  </Pressable>
                ) : (
                  <View style={styles.filterIconWrap}>
                    <Search size={13} color="#64748b" />
                  </View>
                )}
              </View>

              <ScrollView style={styles.refTreeScroll} showsVerticalScrollIndicator>
                {/* HEAD (Current Branch) */}
                <Pressable
                  style={[
                    styles.refTreeItem,
                    !selectedRef && !allBranches && styles.refTreeItemSelected,
                  ]}
                  onPress={() => {
                    setSelectedRef(null);
                    setSelectedStashIndex(null);
                    setSelectedCompareRef(null);
                    setAllBranches(false);
                  }}
                >
                  <GitCommitHorizontal size={13} color="#f59e0b" />
                  <Text
                    style={[
                      styles.refTreeItemText,
                      !selectedRef && !allBranches && styles.refTreeItemSelectedText,
                    ]}
                    numberOfLines={1}
                  >
                    HEAD (Current Branch)
                  </Text>
                </Pressable>

                {/* All Branches */}
                <Pressable
                  style={[
                    styles.refTreeItem,
                    !selectedRef && allBranches && styles.refTreeItemSelected,
                  ]}
                  onPress={() => {
                    setSelectedRef(null);
                    setSelectedStashIndex(null);
                    setSelectedCompareRef(null);
                    setAllBranches(true);
                  }}
                >
                  <FolderGit2 size={13} color="#10b981" />
                  <Text
                    style={[
                      styles.refTreeItemText,
                      !selectedRef && allBranches && styles.refTreeItemSelectedText,
                    ]}
                  >
                    All Branches
                  </Text>
                </Pressable>

                {/* Local Branches Section (with Folder Grouping!) */}
                <Pressable
                  style={styles.refGroupHeader}
                  onPress={() => setLocalBranchesOpen((v) => !v)}
                >
                  {localBranchesOpen ? (
                    <ChevronDown size={13} color="#94a3b8" />
                  ) : (
                    <ChevronRight size={13} color="#94a3b8" />
                  )}
                  <Text style={styles.refGroupTitle}>Local</Text>
                  <Pressable
                    style={styles.refGroupAddBtn}
                    onPress={() => {
                      setPromptMode({
                        kind: "new-branch",
                        targetSha: headSha ?? "HEAD",
                        defaultLabel: currentBranch ?? "HEAD",
                      });
                      setPromptInputValue("");
                    }}
                    hitSlop={6}
                  >
                    <Plus size={12} color="#10b981" />
                  </Pressable>
                </Pressable>

                {localBranchesOpen ? (
                  <View>
                    {groupedLocalBranches.rootItems.map(({ shortLabel, node }) =>
                      renderLocalBranchRow(node, shortLabel, false),
                    )}
                    {groupedLocalBranches.folders.map((folder) => {
                      const folderKey = `local-folder:${folder.folderName}`;
                      const isCollapsed = collapsedBranchFolders.has(folderKey);
                      return (
                        <View key={folderKey}>
                          <Pressable
                            style={styles.branchFolderRow}
                            onPress={() => toggleBranchFolder(folderKey)}
                          >
                            {isCollapsed ? (
                              <ChevronRight size={12} color="#94a3b8" />
                            ) : (
                              <ChevronDown size={12} color="#94a3b8" />
                            )}
                            {isCollapsed ? (
                              <Folder size={13} color="#94a3b8" />
                            ) : (
                              <FolderOpen size={13} color="#94a3b8" />
                            )}
                            <Text style={styles.branchFolderText} numberOfLines={1}>
                              {folder.folderName}
                            </Text>
                          </Pressable>
                          {!isCollapsed
                            ? folder.items.map(({ shortLabel, node }) =>
                                renderLocalBranchRow(node, shortLabel, true),
                              )
                            : null}
                        </View>
                      );
                    })}
                  </View>
                ) : null}

                {/* Remote Branches Section (with Folder Grouping!) */}
                <Pressable
                  style={styles.refGroupHeader}
                  onPress={() => setRemoteBranchesOpen((v) => !v)}
                >
                  {remoteBranchesOpen ? (
                    <ChevronDown size={13} color="#94a3b8" />
                  ) : (
                    <ChevronRight size={13} color="#94a3b8" />
                  )}
                  <Text style={styles.refGroupTitle}>Remote</Text>
                </Pressable>

                {remoteBranchesOpen ? (
                  <View>
                    {groupedRemoteBranches.rootItems.map(({ shortLabel, node }) =>
                      renderRemoteBranchRow(node, shortLabel, false),
                    )}
                    {groupedRemoteBranches.folders.map((folder) => {
                      const folderKey = `remote-folder:${folder.folderName}`;
                      const isCollapsed = collapsedBranchFolders.has(folderKey);
                      return (
                        <View key={folderKey}>
                          <Pressable
                            style={styles.branchFolderRow}
                            onPress={() => toggleBranchFolder(folderKey)}
                          >
                            {isCollapsed ? (
                              <ChevronRight size={12} color="#94a3b8" />
                            ) : (
                              <ChevronDown size={12} color="#94a3b8" />
                            )}
                            {isCollapsed ? (
                              <Folder size={13} color="#94a3b8" />
                            ) : (
                              <FolderOpen size={13} color="#94a3b8" />
                            )}
                            <Text style={styles.branchFolderText} numberOfLines={1}>
                              {folder.folderName}
                            </Text>
                          </Pressable>
                          {!isCollapsed
                            ? folder.items.map(({ shortLabel, node }) =>
                                renderRemoteBranchRow(node, shortLabel, true),
                              )
                            : null}
                        </View>
                      );
                    })}
                  </View>
                ) : null}

                {/* Tags Section */}
                <Pressable style={styles.refGroupHeader} onPress={() => setTagsOpen((v) => !v)}>
                  {tagsOpen ? (
                    <ChevronDown size={13} color="#94a3b8" />
                  ) : (
                    <ChevronRight size={13} color="#94a3b8" />
                  )}
                  <Text style={styles.refGroupTitle}>Tags ({filteredTags.length})</Text>
                </Pressable>

                {tagsOpen
                  ? filteredTags.map((tag) => {
                      const isSelected = selectedRef === tag.name;
                      return (
                        <Pressable
                          key={`tag-${tag.name}`}
                          style={[styles.refTreeItem, isSelected && styles.refTreeItemSelected]}
                          onPress={() => {
                            setSelectedStashIndex(null);
                            setSelectedCompareRef(null);
                            setSelectedRef(tag.name);
                            setAllBranches(false);
                          }}
                        >
                          <Tag size={12} color="#f59e0b" />
                          <Text
                            style={[
                              styles.refTreeItemText,
                              isSelected && styles.refTreeItemSelectedText,
                            ]}
                            numberOfLines={1}
                          >
                            {tag.name}
                          </Text>
                        </Pressable>
                      );
                    })
                  : null}

                {/* Stashes / Shelf Section */}
                <Pressable style={styles.refGroupHeader} onPress={() => setStashesOpen((v) => !v)}>
                  {stashesOpen ? (
                    <ChevronDown size={13} color="#94a3b8" />
                  ) : (
                    <ChevronRight size={13} color="#94a3b8" />
                  )}
                  <Text style={styles.refGroupTitle}>Stashes ({filteredStashes.length})</Text>
                  <Pressable
                    style={styles.refGroupAddBtn}
                    onPress={() => {
                      setPromptMode({ kind: "new-stash" });
                      setPromptInputValue("");
                    }}
                    hitSlop={6}
                  >
                    <Plus size={12} color="#f59e0b" />
                  </Pressable>
                </Pressable>

                {stashesOpen
                  ? filteredStashes.map((s) => {
                      const isStashSelected = selectedStashIndex === s.index;
                      return (
                        <Pressable
                          key={`stash-${s.index}`}
                          style={[
                            styles.refTreeItem,
                            isStashSelected && styles.refTreeItemSelected,
                          ]}
                          onPress={() => {
                            setSelectedCompareRef(null);
                            setSelectedStashIndex((prev) => (prev === s.index ? null : s.index));
                          }}
                        >
                          <Archive size={12} color="#f59e0b" />
                          <Text
                            style={[
                              styles.refTreeItemText,
                              isStashSelected && styles.refTreeItemSelectedText,
                            ]}
                            numberOfLines={1}
                          >
                            {s.ref}: {s.message}
                          </Text>
                        </Pressable>
                      );
                    })
                  : null}
              </ScrollView>

              {/* Selected Branch / Tag / Stash Docked Footer Action Bar */}
              {selectedLocalBranchObj ? (
                <View style={styles.leftFooterActionsDock}>
                  <Text style={styles.leftFooterDockTitle} numberOfLines={1}>
                    Branch: {selectedLocalBranchObj.name}
                  </Text>
                  <View style={styles.leftFooterPillsRow}>
                    {!selectedLocalBranchObj.isCurrent ? (
                      <Pressable
                        style={styles.miniActionPill}
                        onPress={() =>
                          void executeGitAction({
                            kind: "checkout-ref",
                            target: selectedLocalBranchObj.name,
                          })
                        }
                      >
                        <Text style={styles.miniActionPillText}>Checkout</Text>
                      </Pressable>
                    ) : null}
                    {!selectedLocalBranchObj.isCurrent ? (
                      <Pressable
                        style={styles.miniActionPill}
                        onPress={() =>
                          void executeGitAction({
                            kind: "merge-ref",
                            target: selectedLocalBranchObj.name,
                          })
                        }
                      >
                        <Text style={styles.miniActionPillText}>Merge</Text>
                      </Pressable>
                    ) : null}
                    {!selectedLocalBranchObj.isCurrent ? (
                      <Pressable
                        style={styles.miniActionPill}
                        onPress={() =>
                          void executeGitAction({
                            kind: "rebase-onto",
                            target: selectedLocalBranchObj.name,
                          })
                        }
                      >
                        <Text style={styles.miniActionPillText}>Rebase</Text>
                      </Pressable>
                    ) : null}
                    {!selectedLocalBranchObj.isCurrent ? (
                      <Pressable
                        style={styles.miniActionPill}
                        onPress={() => {
                          setSelectedStashIndex(null);
                          setSelectedCompareRef(selectedLocalBranchObj.name);
                        }}
                      >
                        <GitCompare size={10} color="#06b6d4" />
                        <Text style={styles.miniActionPillText}>Compare</Text>
                      </Pressable>
                    ) : null}
                    <Pressable
                      style={styles.miniActionPill}
                      onPress={() => {
                        setPromptMode({
                          kind: "new-branch",
                          targetSha: selectedLocalBranchObj.name,
                          defaultLabel: selectedLocalBranchObj.name,
                        });
                        setPromptInputValue("");
                      }}
                    >
                      <Text style={styles.miniActionPillText}>+ Branch</Text>
                    </Pressable>
                    {!selectedLocalBranchObj.isCurrent ? (
                      <Pressable
                        style={[styles.miniActionPill, styles.miniActionPillDanger]}
                        onPress={() =>
                          void executeGitAction({
                            kind: "delete-branch",
                            target: selectedLocalBranchObj.name,
                            force: false,
                          })
                        }
                      >
                        <Trash2 size={10} color="#f43f5e" />
                      </Pressable>
                    ) : null}
                  </View>
                </View>
              ) : selectedRemoteBranchObj ? (
                <View style={styles.leftFooterActionsDock}>
                  <Text style={styles.leftFooterDockTitle} numberOfLines={1}>
                    Remote: {selectedRemoteBranchObj.name}
                  </Text>
                  <View style={styles.leftFooterPillsRow}>
                    <Pressable
                      style={styles.miniActionPill}
                      onPress={() => {
                        const localShort = selectedRemoteBranchObj.name.replace(/^[^/]+\//, "");
                        setPromptMode({
                          kind: "new-branch",
                          targetSha: selectedRemoteBranchObj.name,
                          defaultLabel: selectedRemoteBranchObj.name,
                        });
                        setPromptInputValue(localShort);
                      }}
                    >
                      <Text style={styles.miniActionPillText}>Checkout as Local</Text>
                    </Pressable>
                    <Pressable
                      style={styles.miniActionPill}
                      onPress={() =>
                        void executeGitAction({
                          kind: "merge-ref",
                          target: selectedRemoteBranchObj.name,
                        })
                      }
                    >
                      <Text style={styles.miniActionPillText}>Merge</Text>
                    </Pressable>
                    <Pressable
                      style={styles.miniActionPill}
                      onPress={() => {
                        setSelectedStashIndex(null);
                        setSelectedCompareRef(selectedRemoteBranchObj.name);
                      }}
                    >
                      <GitCompare size={10} color="#06b6d4" />
                      <Text style={styles.miniActionPillText}>Compare</Text>
                    </Pressable>
                  </View>
                </View>
              ) : selectedTagObj ? (
                <View style={styles.leftFooterActionsDock}>
                  <Text style={styles.leftFooterDockTitle} numberOfLines={1}>
                    Tag: {selectedTagObj.name}
                  </Text>
                  <View style={styles.leftFooterPillsRow}>
                    <Pressable
                      style={styles.miniActionPill}
                      onPress={() =>
                        void executeGitAction({
                          kind: "checkout-ref",
                          target: selectedTagObj.name,
                        })
                      }
                    >
                      <Text style={styles.miniActionPillText}>Checkout</Text>
                    </Pressable>
                    <Pressable
                      style={styles.miniActionPill}
                      onPress={() => {
                        setSelectedStashIndex(null);
                        setSelectedCompareRef(selectedTagObj.name);
                      }}
                    >
                      <GitCompare size={10} color="#06b6d4" />
                      <Text style={styles.miniActionPillText}>Compare</Text>
                    </Pressable>
                    <Pressable
                      style={[styles.miniActionPill, styles.miniActionPillDanger]}
                      onPress={() =>
                        void executeGitAction({
                          kind: "delete-tag",
                          target: selectedTagObj.name,
                        })
                      }
                    >
                      <Trash2 size={10} color="#f43f5e" />
                    </Pressable>
                  </View>
                </View>
              ) : null}
            </View>

            {/* CENTER PANE: PyCharm Inline Filter Bar + Ultra-Clean Single-Line Commit Table (`pycharm-ref-1.png`) */}
            <View style={styles.centerColumn}>
              {/* PyCharm Inline Filter Bar */}
              <View style={styles.pycharmFilterBar}>
                <View style={styles.pycharmSearchBox}>
                  <TextInput
                    value={searchQuery}
                    onChangeText={setSearchQuery}
                    placeholder="Text or hash"
                    placeholderTextColor="#64748b"
                    style={styles.pycharmSearchInput}
                    testID="pycharm-git-search-input"
                  />
                  {searchQuery ? (
                    <Pressable
                      onPress={() => setSearchQuery("")}
                      hitSlop={6}
                      style={styles.filterIconWrap}
                    >
                      <X size={12} color="#64748b" />
                    </Pressable>
                  ) : null}
                  <Text style={styles.searchIconBadge}>.*</Text>
                  <View style={styles.filterIconWrap}>
                    <Search size={12} color="#64748b" />
                  </View>
                </View>

                {/* Branch Filter Pill */}
                <Pressable
                  style={styles.filterDropdownPill}
                  onPress={() => {
                    if (selectedRef) {
                      setSelectedRef(null);
                      setAllBranches(true);
                    } else {
                      setAllBranches((v) => !v);
                    }
                  }}
                >
                  <Text style={styles.filterDropdownLabel}>Branch:</Text>
                  <Text style={styles.filterDropdownValue} numberOfLines={1}>
                    {selectedRef ? selectedRef : allBranches ? "All" : (currentBranch ?? "HEAD")}
                  </Text>
                  <ChevronDown size={11} color="#94a3b8" />
                </Pressable>

                {/* User Filter Pill / Input */}
                {authorFilterOpen || authorFilter ? (
                  <View style={styles.authorInlineBox}>
                    <View style={styles.filterIconWrap}>
                      <User size={11} color="#06b6d4" />
                    </View>
                    <TextInput
                      value={authorFilter}
                      onChangeText={setAuthorFilter}
                      placeholder="User..."
                      placeholderTextColor="#64748b"
                      style={styles.authorInlineInput}
                      autoFocus
                      onBlur={() => {
                        if (!authorFilter.trim()) {
                          setAuthorFilterOpen(false);
                        }
                      }}
                      onKeyPress={(e: any) => {
                        if (e?.nativeEvent?.key === "Escape") {
                          setAuthorFilter("");
                          setAuthorFilterOpen(false);
                        }
                      }}
                      testID="pycharm-git-author-input"
                    />
                    <Pressable
                      onPress={() => {
                        setAuthorFilter("");
                        setAuthorFilterOpen(false);
                      }}
                      hitSlop={8}
                      style={styles.authorClearBtn}
                      testID="pycharm-git-author-clear-btn"
                    >
                      <X size={12} color="#94a3b8" />
                    </Pressable>
                  </View>
                ) : (
                  <Pressable
                    style={styles.filterDropdownPill}
                    onPress={() => setAuthorFilterOpen(true)}
                  >
                    <Text style={styles.filterDropdownLabel}>User</Text>
                    <ChevronDown size={11} color="#94a3b8" />
                  </Pressable>
                )}

                {/* Date Filter Pill */}
                <Pressable
                  style={styles.filterDropdownPill}
                  onPress={() => {
                    setDateFilterPreset((prev) =>
                      prev === "all"
                        ? "24h"
                        : prev === "24h"
                          ? "7d"
                          : prev === "7d"
                            ? "30d"
                            : "all",
                    );
                  }}
                >
                  <Calendar size={11} color="#94a3b8" />
                  <Text style={styles.filterDropdownLabel}>
                    {dateFilterPreset === "all" ? "Date" : `Date: ${dateFilterPreset}`}
                  </Text>
                  <ChevronDown size={11} color="#94a3b8" />
                </Pressable>

                {/* Paths Filter Pill */}
                {filePathFilter ? (
                  <View style={styles.filterActivePathPill}>
                    <Text style={styles.filterActivePathText} numberOfLines={1}>
                      Path: {filePathFilter.split("/").pop()}
                    </Text>
                    <Pressable onPress={() => setFilePathFilter("")} hitSlop={6}>
                      <X size={11} color="#06b6d4" />
                    </Pressable>
                  </View>
                ) : null}
              </View>

              {/* Single-Line Tabular Commit Rows (`pycharm-ref-1.png`) */}
              {errorMsg ? (
                <View style={styles.emptyCenterBox}>
                  <Text style={styles.errorText}>{errorMsg}</Text>
                </View>
              ) : visibleCommits.length === 0 ? (
                <View style={styles.emptyCenterBox}>
                  <Text style={styles.emptyText}>
                    {loading
                      ? "Loading commit graph..."
                      : dateFilterPreset !== "all"
                        ? `No commits in the last ${dateFilterPreset}${selectedRef ? ` on ${selectedRef}` : ""}.`
                        : "No commits match current filter."}
                  </Text>
                  {!loading &&
                  (dateFilterPreset !== "all" ||
                    searchQuery ||
                    authorFilter ||
                    filePathFilter ||
                    selectedRef) ? (
                    <View style={{ flexDirection: "row", gap: 8, marginTop: 10 }}>
                      {dateFilterPreset !== "all" ? (
                        <Pressable
                          style={styles.resetFiltersBtn}
                          onPress={() => setDateFilterPreset("all")}
                        >
                          <Text style={styles.resetFiltersBtnText}>
                            Clear Date Filter ({dateFilterPreset})
                          </Text>
                        </Pressable>
                      ) : null}
                      <Pressable
                        style={styles.resetFiltersBtn}
                        onPress={() => {
                          setDateFilterPreset("all");
                          setSearchQuery("");
                          setAuthorFilter("");
                          setAuthorFilterOpen(false);
                          setFilePathFilter("");
                          setSelectedRef(null);
                          setAllBranches(true);
                        }}
                      >
                        <Text style={styles.resetFiltersBtnText}>Reset All Filters</Text>
                      </Pressable>
                    </View>
                  ) : null}
                </View>
              ) : (
                <ScrollView style={styles.commitListScroll} showsVerticalScrollIndicator>
                  {graphLayout.rows.map((row) => {
                    const { commit } = row;
                    const isSelected =
                      selectedStashIndex === null &&
                      selectedCompareRef === null &&
                      commit.sha === selectedCommitSha;
                    const refs = commit.refs ?? [];

                    return (
                      <Pressable
                        key={commit.sha}
                        style={[styles.commitRow, isSelected && styles.commitRowSelected]}
                        onPress={() => {
                          setSelectedStashIndex(null);
                          setSelectedCompareRef(null);
                          setSelectedCommitSha(commit.sha);
                        }}
                        testID={`pycharm-git-commit-row-${commit.shortSha}`}
                      >
                        <CommitRowGraphSvg row={row} surfaceColor={theme.colors.surface0} />

                        {/* Column 1: Commit Subject + Subtle Right-Aligned Ref Badge (exact PyCharm layout!) */}
                        <View style={styles.commitRowSubjectCol}>
                          <Text
                            style={[
                              styles.commitSubjectText,
                              isSelected && styles.commitSubjectTextSelected,
                            ]}
                            numberOfLines={1}
                          >
                            {commit.subject}
                          </Text>

                          {refs.length > 0 ? (
                            <View style={styles.inlineRefBadgesGroup}>
                              {refs.slice(0, 2).map((refLabel) => {
                                const isHead = refLabel.includes("HEAD");
                                const isTag = refLabel.startsWith("tag:");
                                const cleanLabel = refLabel
                                  .replace(/^HEAD -> /, "")
                                  .replace(/^tag: /, "");
                                return (
                                  <View
                                    key={refLabel}
                                    style={[
                                      styles.pycharmRefBadge,
                                      isHead && styles.pycharmRefBadgeHead,
                                      isTag && styles.pycharmRefBadgeTag,
                                    ]}
                                  >
                                    <Tag
                                      size={9}
                                      color={isHead ? "#f59e0b" : isTag ? "#f43f5e" : "#10b981"}
                                    />
                                    <Text style={styles.pycharmRefBadgeText} numberOfLines={1}>
                                      {cleanLabel}
                                    </Text>
                                  </View>
                                );
                              })}
                            </View>
                          ) : null}
                        </View>

                        {/* Column 2: Fixed-Width Author Column */}
                        <Text
                          style={[styles.commitAuthorCol, isSelected && styles.commitMetaSelected]}
                          numberOfLines={1}
                        >
                          {commit.authorName}
                        </Text>

                        {/* Column 3: Fixed-Width Date/Time Column (`8/10/26, 18:27`) */}
                        <Text
                          style={[styles.commitDateCol, isSelected && styles.commitMetaSelected]}
                          numberOfLines={1}
                        >
                          {formatPyCharmTableDate(commit.authorDate)}
                        </Text>
                      </Pressable>
                    );
                  })}
                </ScrollView>
              )}
            </View>

            {/* RIGHT PANE: Vertically Split Top = Changed Files Directory Tree, Bottom = Clean Commit Message & Details (`pycharm-ref-1.png`) */}
            <View style={styles.rightColumn}>
              {/* TOP HALF: Changed Files Directory Tree */}
              <View style={styles.rightTopFilesPane}>
                {/* PyCharm File Tree Toolbar */}
                <View style={styles.rightFilesToolbar}>
                  <View style={styles.rightFilesToolbarLeft}>
                    {selectedStashIndex !== null ? (
                      <View style={styles.contextModePill}>
                        <Archive size={11} color="#f59e0b" />
                        <Text style={styles.contextModePillText}>
                          stash@{`{${selectedStashIndex}}`} ({activeChangedFiles.length})
                        </Text>
                        <Pressable onPress={() => setSelectedStashIndex(null)} hitSlop={6}>
                          <X size={11} color="#94a3b8" />
                        </Pressable>
                      </View>
                    ) : selectedCompareRef !== null ? (
                      <View style={styles.contextModePill}>
                        <GitCompare size={11} color="#06b6d4" />
                        <Text style={styles.contextModePillText}>
                          {selectedCompareRef} ↔ HEAD ({activeChangedFiles.length})
                        </Text>
                        <Pressable onPress={() => setSelectedCompareRef(null)} hitSlop={6}>
                          <X size={11} color="#94a3b8" />
                        </Pressable>
                      </View>
                    ) : (
                      <Text style={styles.filesCountLabel}>
                        {activeChangedFiles.length}{" "}
                        {activeChangedFiles.length === 1 ? "file" : "files"}
                      </Text>
                    )}
                  </View>

                  <View style={styles.rightFilesToolbarRight}>
                    {/* Open Full-Screen Repository Diff Button (`pycharm-ref-2.png`) */}
                    <Pressable
                      style={[styles.openRepoDiffBtn, !selectedFilePath && styles.btnDisabled]}
                      disabled={!selectedFilePath}
                      onPress={() => setRepoDiffModalOpen(true)}
                      testID="pycharm-open-repository-diff-btn"
                    >
                      <Columns2 size={12} color="#10b981" />
                      <Text style={styles.openRepoDiffBtnText}>Diff (⌘D)</Text>
                    </Pressable>

                    {/* Group by Directory Toggle */}
                    <Pressable
                      style={[styles.iconToggleBtn, groupFilesByDir && styles.iconToggleBtnActive]}
                      onPress={() => setGroupFilesByDir((v) => !v)}
                      testID="pycharm-group-by-dir-btn"
                    >
                      <Folder size={13} color={groupFilesByDir ? "#10b981" : "#94a3b8"} />
                    </Pressable>

                    {/* Expand / Collapse All Directories */}
                    <Pressable
                      style={styles.iconToggleBtn}
                      onPress={() => {
                        if (collapsedFileDirs.size > 0) {
                          setCollapsedFileDirs(new Set());
                        } else {
                          setCollapsedFileDirs(new Set(groupedChangedFiles.map((g) => g.dirPath)));
                        }
                      }}
                    >
                      {collapsedFileDirs.size > 0 ? (
                        <ChevronDown size={13} color="#94a3b8" />
                      ) : (
                        <ChevronUp size={13} color="#94a3b8" />
                      )}
                    </Pressable>

                    {/* Filter History by Selected File */}
                    {selectedFilePath ? (
                      <Pressable
                        style={styles.iconToggleBtn}
                        onPress={() => setFilePathFilter(selectedFilePath)}
                      >
                        <History size={13} color="#06b6d4" />
                      </Pressable>
                    ) : null}
                  </View>
                </View>

                {/* Changed Files Hierarchical Tree Body */}
                <ScrollView style={styles.rightFilesTreeScroll} showsVerticalScrollIndicator>
                  {activeChangedFiles.length === 0 ? (
                    <View style={styles.emptyFilesBox}>
                      <Text style={styles.emptyText}>No changed files</Text>
                    </View>
                  ) : groupFilesByDir ? (
                    groupedChangedFiles.map((group) => {
                      const isCollapsed = collapsedFileDirs.has(group.dirPath);
                      return (
                        <View key={group.dirPath} style={styles.fileDirBlock}>
                          <Pressable
                            style={styles.fileDirHeaderRow}
                            onPress={() => toggleFileDir(group.dirPath)}
                          >
                            {isCollapsed ? (
                              <ChevronRight size={12} color="#94a3b8" />
                            ) : (
                              <ChevronDown size={12} color="#94a3b8" />
                            )}
                            {isCollapsed ? (
                              <Folder size={13} color="#94a3b8" />
                            ) : (
                              <FolderOpen size={13} color="#94a3b8" />
                            )}
                            <Text style={styles.fileDirPathText} numberOfLines={1}>
                              {group.dirPath === "." ? "(root)" : group.dirPath}
                            </Text>
                            <Text style={styles.fileDirCountText}>
                              {group.files.length} {group.files.length === 1 ? "file" : "files"}
                            </Text>
                          </Pressable>

                          {!isCollapsed
                            ? group.files.map((f) => renderChangedFileRow(f, false, true))
                            : null}
                        </View>
                      );
                    })
                  ) : (
                    activeChangedFiles.map((f) => renderChangedFileRow(f, true, false))
                  )}
                </ScrollView>
              </View>

              {/* BOTTOM HALF: Commit Message, Metadata & Operations (`pycharm-ref-1.png` bottom-right) */}
              <View style={styles.rightBottomDetailsPane}>
                {selectedStashIndex !== null ? (
                  <ScrollView style={styles.commitDetailsScroll} showsVerticalScrollIndicator>
                    <View style={styles.compactOpsStrip}>
                      <Pressable
                        style={styles.compactOpPill}
                        disabled={actionBusy}
                        onPress={() =>
                          void executeGitAction({
                            kind: "stash-apply",
                            target: String(selectedStashIndex),
                          })
                        }
                      >
                        <Play size={11} color="#10b981" />
                        <Text style={styles.compactOpPillText}>Apply</Text>
                      </Pressable>
                      <Pressable
                        style={styles.compactOpPill}
                        disabled={actionBusy}
                        onPress={() => {
                          void executeGitAction({
                            kind: "stash-pop",
                            target: String(selectedStashIndex),
                          });
                          setSelectedStashIndex(null);
                        }}
                      >
                        <ArrowUp size={11} color="#06b6d4" />
                        <Text style={styles.compactOpPillText}>Pop</Text>
                      </Pressable>
                      <Pressable
                        style={styles.compactOpPill}
                        disabled={actionBusy}
                        onPress={() => {
                          void executeGitAction({
                            kind: "stash-drop",
                            target: String(selectedStashIndex),
                          });
                          setSelectedStashIndex(null);
                        }}
                      >
                        <Trash2 size={11} color="#f43f5e" />
                        <Text style={styles.compactOpPillText}>Drop</Text>
                      </Pressable>
                    </View>
                    <Text style={styles.pycharmCommitSubjectTitle}>
                      {stashes.find((s) => s.index === selectedStashIndex)?.message ??
                        "Stashed Changes"}
                    </Text>
                  </ScrollView>
                ) : selectedCompareRef !== null ? (
                  <ScrollView style={styles.commitDetailsScroll} showsVerticalScrollIndicator>
                    <Text style={styles.pycharmCommitSubjectTitle}>
                      Comparing {selectedCompareRef} ↔ HEAD ({currentBranch ?? "HEAD"})
                    </Text>
                    <Text style={styles.pycharmCommitMetaFooter}>
                      Click any file above or press Diff (⌘D) to open the full-screen Side-by-Side
                      Repository Diff.
                    </Text>
                  </ScrollView>
                ) : !selectedCommit ? (
                  <View style={styles.emptyFilesBox}>
                    <Text style={styles.emptyText}>Select a commit to view details</Text>
                  </View>
                ) : (
                  <ScrollView style={styles.commitDetailsScroll} showsVerticalScrollIndicator>
                    {/* Compact Commit Operations Toolbar */}
                    <View style={styles.compactOpsStrip}>
                      <Pressable
                        style={styles.compactOpPill}
                        disabled={actionBusy}
                        onPress={() =>
                          void executeGitAction({
                            kind: "cherry-pick",
                            target: selectedCommit.sha,
                          })
                        }
                        testID="pycharm-git-cherry-pick-btn"
                      >
                        <GitPullRequest size={11} color="#10b981" />
                        <Text style={styles.compactOpPillText}>Cherry-Pick</Text>
                      </Pressable>

                      <Pressable
                        style={styles.compactOpPill}
                        disabled={actionBusy}
                        onPress={() =>
                          void executeGitAction({
                            kind: "revert",
                            target: selectedCommit.sha,
                          })
                        }
                        testID="pycharm-git-revert-btn"
                      >
                        <Undo2 size={11} color="#f59e0b" />
                        <Text style={styles.compactOpPillText}>Revert</Text>
                      </Pressable>

                      <Pressable
                        style={styles.compactOpPill}
                        disabled={actionBusy}
                        onPress={() => {
                          const fullMsg = selectedCommit.body
                            ? `${selectedCommit.subject}\n\n${selectedCommit.body}`
                            : selectedCommit.subject;
                          setPromptMode({
                            kind: "reword",
                            targetSha: selectedCommit.sha,
                            initialMessage: fullMsg,
                          });
                          setPromptInputValue(fullMsg);
                        }}
                        testID="pycharm-git-reword-btn"
                      >
                        <Edit3 size={11} color="#06b6d4" />
                        <Text style={styles.compactOpPillText}>Reword</Text>
                      </Pressable>

                      {selectedCommit.parents && selectedCommit.parents.length > 0 ? (
                        <Pressable
                          style={styles.compactOpPill}
                          disabled={actionBusy}
                          onPress={() => {
                            setPromptMode({
                              kind: "squash",
                              targetSha: selectedCommit.sha,
                              initialMessage: selectedCommit.subject,
                            });
                            setPromptInputValue("");
                          }}
                          testID="pycharm-git-squash-btn"
                        >
                          <Scissors size={11} color="#10b981" />
                          <Text style={styles.compactOpPillText}>Squash</Text>
                        </Pressable>
                      ) : null}

                      <Pressable
                        style={styles.compactOpPill}
                        disabled={actionBusy}
                        onPress={() =>
                          void executeGitAction({
                            kind: "drop-commit",
                            target: selectedCommit.sha,
                          })
                        }
                        testID="pycharm-git-drop-commit-btn"
                      >
                        <Trash2 size={11} color="#f43f5e" />
                        <Text style={styles.compactOpPillText}>Drop</Text>
                      </Pressable>

                      <Pressable
                        style={styles.compactOpPill}
                        disabled={actionBusy}
                        onPress={() =>
                          setPromptMode((prev) =>
                            prev?.kind === "reset"
                              ? null
                              : { kind: "reset", targetSha: selectedCommit.sha },
                          )
                        }
                        testID="pycharm-git-reset-btn"
                      >
                        <RotateCcw size={11} color="#f43f5e" />
                        <Text style={styles.compactOpPillText}>Reset...</Text>
                      </Pressable>

                      <Pressable
                        style={styles.compactOpPill}
                        disabled={actionBusy}
                        onPress={() =>
                          void executeGitAction({
                            kind: "checkout-ref",
                            target: selectedCommit.sha,
                          })
                        }
                      >
                        <GitMerge size={11} color="#06b6d4" />
                        <Text style={styles.compactOpPillText}>Checkout</Text>
                      </Pressable>

                      <Pressable
                        style={styles.compactOpPill}
                        disabled={actionBusy}
                        onPress={() => {
                          setPromptMode({
                            kind: "new-branch",
                            targetSha: selectedCommit.sha,
                            defaultLabel: selectedCommit.shortSha,
                          });
                          setPromptInputValue("");
                        }}
                      >
                        <Plus size={11} color="#10b981" />
                        <Text style={styles.compactOpPillText}>Branch</Text>
                      </Pressable>

                      <Pressable
                        style={styles.compactOpPill}
                        disabled={actionBusy}
                        onPress={() => {
                          setPromptMode({
                            kind: "new-tag",
                            targetSha: selectedCommit.sha,
                          });
                          setPromptInputValue("");
                        }}
                      >
                        <Tag size={11} color="#f59e0b" />
                        <Text style={styles.compactOpPillText}>Tag</Text>
                      </Pressable>

                      {onOpenCommitTab ? (
                        <Pressable
                          style={styles.compactOpPill}
                          onPress={() => {
                            onOpenCommitTab(selectedCommit.sha);
                            onClose();
                          }}
                        >
                          <ExternalLink size={11} color="#06b6d4" />
                        </Pressable>
                      ) : null}
                    </View>

                    {/* PyCharm Commit Subject & Body (`pycharm-ref-1.png` bottom-right) */}
                    <Text style={styles.pycharmCommitSubjectTitle}>{selectedCommit.subject}</Text>

                    {selectedCommit.body ? (
                      <Text style={styles.pycharmCommitBodyText}>{selectedCommit.body}</Text>
                    ) : null}

                    {/* PyCharm Footer Line: `<sha> <author> <email> on <date> at <time>` */}
                    <View style={styles.pycharmCommitFooterBlock}>
                      <View style={styles.pycharmCommitFooterLine}>
                        <Pressable
                          onPress={() => void handleCopySha(selectedCommit.sha)}
                          style={styles.pycharmInlineShaBtn}
                        >
                          <Text style={styles.pycharmInlineShaText}>{selectedCommit.shortSha}</Text>
                          <Copy size={10} color="#64748b" />
                        </Pressable>
                        <Text style={styles.pycharmCommitMetaFooter}>
                          {selectedCommit.authorName}{" "}
                          {selectedCommit.authorEmail ? `<${selectedCommit.authorEmail}>` : ""}{" "}
                          {formatPyCharmFullDate(selectedCommit.authorDate)}
                        </Text>
                      </View>

                      {selectedCommit.refs && selectedCommit.refs.length > 0 ? (
                        <Text style={styles.pycharmInBranchesText}>
                          In refs: {selectedCommit.refs.join(", ")}
                        </Text>
                      ) : null}
                    </View>
                  </ScrollView>
                )}
              </View>
            </View>
          </View>
        </View>
      </View>

      {/* DEDICATED FULL-SCREEN PYCHARM "REPOSITORY DIFF" WINDOW (`pycharm-ref-2.png`) */}
      {repoDiffModalOpen && selectedFilePath ? (
        <View style={styles.repoDiffBackdrop} testID="pycharm-repository-diff-modal">
          <View style={styles.repoDiffWindow}>
            {/* PyCharm Repository Diff Top Header Bar */}
            <View style={styles.repoDiffHeaderBar}>
              <View style={styles.repoDiffHeaderLeft}>
                <Text style={styles.repoDiffWindowTitle} numberOfLines={1}>
                  Repository Diff: {selectedFilePath.split("/").pop()}
                </Text>

                {/* Prev / Next Hunk (`↑` `↓`) */}
                <View style={styles.repoDiffNavGroup}>
                  <Pressable
                    style={[styles.repoDiffNavBtn, hunkCount <= 1 && styles.btnDisabled]}
                    disabled={hunkCount <= 1}
                    onPress={() =>
                      setActiveHunkIndex((prev) =>
                        hunkCount > 0 ? (prev - 1 + hunkCount) % hunkCount : 0,
                      )
                    }
                  >
                    <ArrowUp size={13} color={theme.colors.foregroundMuted} />
                  </Pressable>
                  <Pressable
                    style={[styles.repoDiffNavBtn, hunkCount <= 1 && styles.btnDisabled]}
                    disabled={hunkCount <= 1}
                    onPress={() =>
                      setActiveHunkIndex((prev) => (hunkCount > 0 ? (prev + 1) % hunkCount : 0))
                    }
                  >
                    <ArrowDown size={13} color={theme.colors.foregroundMuted} />
                  </Pressable>
                </View>

                {/* Prev / Next Changed File in Commit (`← 4/11 files →`) */}
                <View style={styles.repoDiffFileSwitcher}>
                  <Pressable
                    style={[styles.repoDiffNavBtn, selectedFileIndex <= 0 && styles.btnDisabled]}
                    disabled={selectedFileIndex <= 0}
                    onPress={() => {
                      if (selectedFileIndex > 0) {
                        setSelectedFilePath(activeChangedFiles[selectedFileIndex - 1].path);
                      }
                    }}
                    testID="repo-diff-prev-file-btn"
                  >
                    <ArrowLeft size={13} color={theme.colors.foregroundMuted} />
                  </Pressable>

                  <Text style={styles.repoDiffFileCounterText} numberOfLines={1}>
                    {selectedFileIndex >= 0
                      ? `${selectedFileIndex + 1} / ${activeChangedFiles.length}`
                      : `1 / ${activeChangedFiles.length}`}{" "}
                    — {selectedFilePath}
                  </Text>

                  <Pressable
                    style={[
                      styles.repoDiffNavBtn,
                      (selectedFileIndex === -1 ||
                        selectedFileIndex >= activeChangedFiles.length - 1) &&
                        styles.btnDisabled,
                    ]}
                    disabled={
                      selectedFileIndex === -1 || selectedFileIndex >= activeChangedFiles.length - 1
                    }
                    onPress={() => {
                      if (
                        selectedFileIndex >= 0 &&
                        selectedFileIndex < activeChangedFiles.length - 1
                      ) {
                        setSelectedFilePath(activeChangedFiles[selectedFileIndex + 1].path);
                      }
                    }}
                    testID="repo-diff-next-file-btn"
                  >
                    <ArrowRight size={13} color={theme.colors.foregroundMuted} />
                  </Pressable>
                </View>
              </View>

              <View style={styles.repoDiffHeaderRight}>
                <Pressable
                  style={styles.closeBtn}
                  onPress={() => setRepoDiffModalOpen(false)}
                  testID="repo-diff-close-btn"
                >
                  <X size={16} color={theme.colors.foregroundMuted} />
                </Pressable>
              </View>
            </View>

            {/* Repository Diff Body (`SplitDiffViewer` Full Height) */}
            <View style={styles.repoDiffBody}>
              {loadingFileDiff ? (
                <View style={styles.emptyCenterBox}>
                  <Text style={styles.emptyText}>Loading repository diff...</Text>
                </View>
              ) : (
                <SplitDiffViewer
                  file={selectedFileDiff}
                  mode={diffViewMode}
                  onModeChange={setDiffViewMode}
                  enableHunkActions={true}
                  hunkActionBusy={actionBusy}
                  leftRevisionLabel={leftLabel}
                  rightRevisionLabel={rightLabel}
                  fullHeight={true}
                  activeHunkIndex={activeHunkIndex}
                  onRollbackHunk={(_file, _hunk, patch) =>
                    void executeGitAction({
                      kind: "apply-hunk-patch",
                      target: selectedFilePath,
                      patch,
                      patchMode: "rollback",
                    })
                  }
                  onStageHunk={(_file, _hunk, patch) =>
                    void executeGitAction({
                      kind: "apply-hunk-patch",
                      target: selectedFilePath,
                      patch,
                      patchMode: "stage",
                    })
                  }
                />
              )}
            </View>
          </View>
        </View>
      ) : null}

      {/* 3-Way Merge Conflict Resolver Modal */}
      {conflictModalOpen ? (
        <MergeConflictResolverModal
          visible={conflictModalOpen}
          onClose={() => setConflictModalOpen(false)}
          serverId={serverId}
          cwd={cwd}
          conflictFiles={conflictState.conflictFiles}
          inProgressOperation={conflictState.inProgress}
          initialFilePath={conflictInitialFile}
          onResolved={() => void fetchGraphData()}
        />
      ) : null}
    </>
  );

  if (isWeb && typeof document !== "undefined" && document.body) {
    return createPortal(modalContent, document.body);
  }

  return <Portal>{modalContent}</Portal>;
}

const styles = StyleSheet.create((theme) => ({
  backdrop: {
    position: isWeb ? ("fixed" as unknown as "absolute") : "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0, 0, 0, 0.76)",
    alignItems: "center",
    justifyContent: "center",
    padding: 12,
    zIndex: 100000,
  },
  modalWindow: {
    width: "100%",
    maxWidth: 1600,
    height: "95%",
    backgroundColor: theme.colors.surface0,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.colors.border,
    overflow: "hidden",
    flexDirection: "column",
  },
  topHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    height: 36,
    backgroundColor: theme.colors.surface2,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  topHeaderLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    flex: 1,
    minWidth: 0,
  },
  toolWindowTitle: {
    fontSize: 13,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  toolWindowTabActive: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    height: 28,
    borderRadius: 4,
    backgroundColor: theme.colors.surface0,
    borderBottomWidth: 2,
    borderBottomColor: "#3b82f6",
  },
  toolWindowTabText: {
    fontSize: 12,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  currentBranchPill: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
    backgroundColor: "rgba(16, 185, 129, 0.14)",
    borderWidth: 1,
    borderColor: "rgba(16, 185, 129, 0.35)",
  },
  currentBranchPillText: {
    fontSize: 11,
    fontFamily: theme.fontFamily.mono,
    color: "#10b981",
  },
  topHeaderActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  headerActionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  headerConflictBtn: {
    borderColor: "rgba(245, 158, 11, 0.55)",
    backgroundColor: "rgba(245, 158, 11, 0.14)",
  },
  headerConflictBtnText: {
    fontSize: 11,
    color: "#f59e0b",
    fontWeight: theme.fontWeight.semibold,
  },
  headerActionBtnText: {
    fontSize: 11,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
  },
  closeBtn: {
    padding: 5,
    borderRadius: 4,
  },
  btnPressed: {
    opacity: 0.75,
  },
  btnDisabled: {
    opacity: 0.4,
  },
  conflictBanner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingVertical: 7,
    backgroundColor: "rgba(245, 158, 11, 0.12)",
    borderBottomWidth: 1,
    borderBottomColor: "rgba(245, 158, 11, 0.35)",
    gap: 10,
  },
  conflictBannerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flex: 1,
    minWidth: 0,
  },
  conflictBannerTitle: {
    fontSize: 11,
    fontWeight: theme.fontWeight.semibold,
    color: "#f59e0b",
  },
  conflictBannerSub: {
    fontSize: 11,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foreground,
    flex: 1,
  },
  conflictBannerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  conflictBannerPrimaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 4,
    backgroundColor: "#f59e0b",
  },
  conflictBannerPrimaryText: {
    fontSize: 11,
    fontWeight: theme.fontWeight.semibold,
    color: "#0f172a",
  },
  conflictBannerContinueBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: "rgba(16, 185, 129, 0.45)",
    backgroundColor: "rgba(16, 185, 129, 0.14)",
  },
  conflictBannerContinueText: {
    fontSize: 11,
    color: "#10b981",
    fontWeight: theme.fontWeight.medium,
  },
  conflictBannerAbortBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: "rgba(244, 63, 94, 0.45)",
    backgroundColor: "rgba(244, 63, 94, 0.14)",
  },
  conflictBannerAbortText: {
    fontSize: 11,
    color: "#f43f5e",
    fontWeight: theme.fontWeight.medium,
  },
  threeColumnBody: {
    flex: 1,
    flexDirection: "row",
    minHeight: 0,
  },
  leftColumn: {
    width: 240,
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    flexDirection: "column",
  },
  refFilterBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 8,
    height: 32,
    backgroundColor: theme.colors.surface0,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  refFilterInput: {
    flex: 1,
    minWidth: 0,
    width: 0,
    fontSize: 12,
    color: theme.colors.foreground,
    paddingVertical: 0,
    ...(isWeb ? ({ outlineStyle: "none" } as any) : null),
  },
  filterIconWrap: {
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  refTreeScroll: {
    flex: 1,
    paddingVertical: 4,
  },
  refGroupHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    height: 24,
    paddingHorizontal: 6,
    marginTop: 2,
  },
  refGroupTitle: {
    flex: 1,
    fontSize: 12,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  refGroupAddBtn: {
    padding: 2,
  },
  branchFolderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    height: 24,
    paddingLeft: 18,
    paddingRight: 8,
  },
  branchFolderText: {
    flex: 1,
    fontSize: 12,
    color: theme.colors.foregroundMuted,
  },
  refTreeItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 24,
    paddingLeft: 18,
    paddingRight: 8,
  },
  refTreeItemIndented: {
    paddingLeft: 34,
  },
  refTreeItemSelected: {
    backgroundColor: theme.colorScheme === "dark" ? "#2d4f7c" : "rgba(59, 130, 246, 0.16)",
  },
  refTreeItemText: {
    flex: 1,
    fontSize: 12,
    color: theme.colors.foreground,
  },
  refTreeItemCurrentText: {
    color: "#10b981",
    fontWeight: theme.fontWeight.semibold,
  },
  refTreeItemSelectedText: {
    color: theme.colorScheme === "dark" ? "#ffffff" : theme.colors.foreground,
  },
  aheadBehindBadge: {
    fontSize: 10,
    fontFamily: theme.fontFamily.mono,
    color: "#06b6d4",
  },
  leftFooterActionsDock: {
    padding: 8,
    backgroundColor: theme.colors.surface0,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    gap: 6,
  },
  leftFooterDockTitle: {
    fontSize: 11,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foregroundMuted,
  },
  leftFooterPillsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 4,
  },
  miniActionPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 4,
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  miniActionPillDanger: {
    borderColor: "rgba(244, 63, 94, 0.45)",
  },
  miniActionPillText: {
    fontSize: 11,
    color: theme.colors.foreground,
  },
  centerColumn: {
    flex: 1.55,
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    flexDirection: "column",
    minWidth: 0,
  },
  pycharmFilterBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 10,
    height: 32,
    backgroundColor: theme.colors.surface1,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  pycharmSearchBox: {
    flex: 1,
    minWidth: 120,
    maxWidth: 280,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 8,
    height: 24,
    borderRadius: 4,
    backgroundColor: theme.colors.surface0,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  pycharmSearchInput: {
    flex: 1,
    minWidth: 0,
    width: 0,
    fontSize: 12,
    color: theme.colors.foreground,
    paddingVertical: 0,
    ...(isWeb ? ({ outlineStyle: "none" } as any) : null),
  },
  searchIconBadge: {
    flexShrink: 0,
    fontSize: 10,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foregroundMuted,
  },
  filterDropdownPill: {
    flexShrink: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 6,
    height: 24,
    borderRadius: 4,
  },
  filterDropdownLabel: {
    fontSize: 12,
    color: theme.colors.foregroundMuted,
  },
  filterDropdownValue: {
    fontSize: 12,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
    maxWidth: 120,
  },
  authorInlineBox: {
    flexShrink: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 8,
    height: 24,
    borderRadius: 4,
    backgroundColor: theme.colors.surface0,
    borderWidth: 1,
    borderColor: "#06b6d4",
    minWidth: 150,
    maxWidth: 190,
  },
  authorInlineInput: {
    flex: 1,
    minWidth: 0,
    width: 0,
    fontSize: 12,
    color: theme.colors.foreground,
    paddingVertical: 0,
    ...(isWeb ? ({ outlineStyle: "none" } as any) : null),
  },
  authorClearBtn: {
    flexShrink: 0,
    padding: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  filterActivePathPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 6,
    height: 22,
    borderRadius: 4,
    backgroundColor: "rgba(6, 182, 212, 0.14)",
    borderWidth: 1,
    borderColor: "rgba(6, 182, 212, 0.35)",
  },
  filterActivePathText: {
    fontSize: 11,
    color: "#06b6d4",
    maxWidth: 140,
  },
  commitListScroll: {
    flex: 1,
  },
  commitRow: {
    flexDirection: "row",
    alignItems: "center",
    height: ROW_HEIGHT,
    paddingRight: 10,
  },
  commitRowSelected: {
    backgroundColor: theme.colorScheme === "dark" ? "#2d4f7c" : "rgba(59, 130, 246, 0.16)",
  },
  commitRowSubjectCol: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    minWidth: 0,
    paddingLeft: 4,
    paddingRight: 8,
  },
  commitSubjectText: {
    flex: 1,
    fontSize: 12.5,
    color: theme.colors.foreground,
    minWidth: 0,
  },
  commitSubjectTextSelected: {
    color: theme.colorScheme === "dark" ? "#ffffff" : theme.colors.foreground,
  },
  inlineRefBadgesGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    flexShrink: 0,
  },
  pycharmRefBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 3,
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: theme.colors.border,
    maxWidth: 150,
  },
  pycharmRefBadgeHead: {
    borderColor: "rgba(245, 158, 11, 0.45)",
  },
  pycharmRefBadgeTag: {
    borderColor: "rgba(244, 63, 94, 0.45)",
  },
  pycharmRefBadgeText: {
    fontSize: 11,
    color: theme.colors.foregroundMuted,
  },
  commitAuthorCol: {
    width: 110,
    fontSize: 12,
    color: theme.colors.foregroundMuted,
    paddingRight: 8,
    flexShrink: 0,
  },
  commitDateCol: {
    width: 112,
    fontSize: 12,
    color: theme.colors.foregroundMuted,
    textAlign: "right",
    flexShrink: 0,
  },
  commitMetaSelected: {
    color: theme.colorScheme === "dark" ? "#e2e8f0" : theme.colors.foreground,
  },
  rightColumn: {
    width: 390,
    backgroundColor: theme.colors.surface1,
    flexDirection: "column",
    minWidth: 0,
  },
  rightTopFilesPane: {
    flex: 1.15,
    flexDirection: "column",
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    minHeight: 0,
  },
  rightFilesToolbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 10,
    height: 32,
    backgroundColor: theme.colors.surface2,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  rightFilesToolbarLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flex: 1,
    minWidth: 0,
  },
  filesCountLabel: {
    flexShrink: 0,
    fontSize: 12,
    color: theme.colors.foregroundMuted,
    fontWeight: theme.fontWeight.medium,
  },
  contextModePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    backgroundColor: theme.colors.surface0,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  contextModePillText: {
    fontSize: 11,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foreground,
  },
  rightFilesToolbarRight: {
    flexShrink: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  openRepoDiffBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
    backgroundColor: "rgba(16, 185, 129, 0.14)",
    borderWidth: 1,
    borderColor: "rgba(16, 185, 129, 0.4)",
  },
  openRepoDiffBtnText: {
    fontSize: 11,
    color: "#10b981",
    fontWeight: theme.fontWeight.semibold,
  },
  iconToggleBtn: {
    padding: 4,
    borderRadius: 4,
  },
  iconToggleBtnActive: {
    backgroundColor: "rgba(16, 185, 129, 0.14)",
  },
  rightFilesTreeScroll: {
    flex: 1,
    paddingVertical: 4,
  },
  fileDirBlock: {
    marginBottom: 2,
  },
  fileDirHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    height: 24,
    paddingHorizontal: 8,
  },
  fileDirPathText: {
    flexShrink: 1,
    fontSize: 12,
    color: theme.colors.foreground,
  },
  fileDirCountText: {
    fontSize: 11,
    color: theme.colors.foregroundMuted,
    marginLeft: 4,
  },
  fileTreeLeafRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 24,
    paddingHorizontal: 10,
  },
  fileTreeLeafIndented: {
    paddingLeft: 28,
  },
  fileTreeLeafSelected: {
    backgroundColor: theme.colorScheme === "dark" ? "#2d4f7c" : "rgba(59, 130, 246, 0.16)",
  },
  fileTreeLeafName: {
    flex: 1,
    fontSize: 12,
    minWidth: 0,
  },
  fileTreeLeafDirHint: {
    fontSize: 11,
    color: theme.colors.foregroundMuted,
    maxWidth: 110,
  },
  commitFileStats: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    flexShrink: 0,
  },
  statAdd: {
    fontSize: 10,
    fontFamily: theme.fontFamily.mono,
    color: "#10b981",
  },
  statDel: {
    fontSize: 10,
    fontFamily: theme.fontFamily.mono,
    color: "#f43f5e",
  },
  fileRowQuickDiffBtn: {
    paddingHorizontal: 4,
    paddingVertical: 2,
    borderRadius: 3,
  },
  rightBottomDetailsPane: {
    flex: 0.85,
    backgroundColor: theme.colors.surface0,
    flexDirection: "column",
    minHeight: 0,
  },
  commitDetailsScroll: {
    flex: 1,
    padding: 12,
  },
  compactOpsStrip: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 4,
    paddingBottom: 10,
    marginBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  compactOpPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 4,
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  compactOpPillText: {
    fontSize: 11,
    color: theme.colors.foreground,
  },
  pycharmCommitSubjectTitle: {
    fontSize: 13.5,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
    lineHeight: 19,
    marginBottom: 8,
  },
  pycharmCommitBodyText: {
    fontSize: 12.5,
    color: theme.colors.foregroundMuted,
    lineHeight: 18,
    marginBottom: 12,
  },
  pycharmCommitFooterBlock: {
    marginTop: 6,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    gap: 4,
  },
  pycharmCommitFooterLine: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 6,
  },
  pycharmInlineShaBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  pycharmInlineShaText: {
    fontSize: 11.5,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foregroundMuted,
  },
  pycharmCommitMetaFooter: {
    fontSize: 11.5,
    color: theme.colors.foregroundMuted,
  },
  pycharmInBranchesText: {
    fontSize: 11,
    color: theme.colors.foregroundMuted,
  },
  inlinePromptBox: {
    marginBottom: 10,
    padding: 8,
    borderRadius: 4,
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  resetModePrompt: {
    gap: 6,
  },
  textInputPrompt: {
    gap: 6,
  },
  promptTitle: {
    fontSize: 11,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
  },
  resetButtonsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  resetModeChoiceBtn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 4,
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  resetModeChoiceDanger: {
    borderColor: "#f43f5e",
    backgroundColor: "rgba(244, 63, 94, 0.14)",
  },
  resetModeChoiceText: {
    fontSize: 11,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  promptInputRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  promptInput: {
    flex: 1,
    minWidth: 0,
    width: 0,
    height: 26,
    paddingHorizontal: 8,
    borderRadius: 4,
    backgroundColor: theme.colors.surface0,
    borderWidth: 1,
    borderColor: theme.colors.border,
    fontSize: 12,
    color: theme.colors.foreground,
    ...(isWeb ? ({ outlineStyle: "none" } as any) : null),
  },
  promptConfirmBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 4,
    backgroundColor: "#10b981",
  },
  promptConfirmText: {
    fontSize: 11,
    fontWeight: theme.fontWeight.semibold,
    color: "#0f172a",
  },
  promptCancelBtn: {
    paddingHorizontal: 6,
    paddingVertical: 4,
  },
  promptCancelText: {
    fontSize: 11,
    color: theme.colors.foregroundMuted,
  },
  emptyCenterBox: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
  },
  emptyFilesBox: {
    padding: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyText: {
    fontSize: 12,
    color: theme.colors.foregroundMuted,
  },
  errorText: {
    fontSize: 12,
    color: "#f43f5e",
  },
  repoDiffBackdrop: {
    position: isWeb ? ("fixed" as unknown as "absolute") : "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0, 0, 0, 0.82)",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
    zIndex: 100005,
  },
  repoDiffWindow: {
    width: "100%",
    maxWidth: 1680,
    height: "96%",
    backgroundColor: theme.colors.surface0,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.colors.border,
    overflow: "hidden",
    flexDirection: "column",
  },
  repoDiffHeaderBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    height: 38,
    backgroundColor: theme.colors.surface2,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  repoDiffHeaderLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    flex: 1,
    minWidth: 0,
  },
  repoDiffWindowTitle: {
    fontSize: 13,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  repoDiffNavGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    backgroundColor: theme.colors.surface0,
    padding: 2,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  repoDiffNavBtn: {
    padding: 4,
    borderRadius: 3,
  },
  repoDiffFileSwitcher: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: theme.colors.surface0,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: theme.colors.border,
    maxWidth: 520,
  },
  repoDiffFileCounterText: {
    fontSize: 11.5,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foregroundMuted,
    maxWidth: 420,
  },
  repoDiffHeaderRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  repoDiffBody: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface0,
  },
  inlineBranchCheckoutBtn: {
    paddingHorizontal: 6,
    paddingVertical: 1.5,
    borderRadius: 3,
    backgroundColor: "rgba(16, 185, 129, 0.16)",
    borderWidth: 1,
    borderColor: "rgba(16, 185, 129, 0.45)",
  },
  inlineBranchCheckoutText: {
    fontSize: 10,
    fontWeight: theme.fontWeight.semibold,
    color: "#10b981",
  },
  headerSwitchBranchBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
    backgroundColor: "rgba(16, 185, 129, 0.18)",
    borderWidth: 1,
    borderColor: "rgba(16, 185, 129, 0.5)",
  },
  headerSwitchBranchBtnText: {
    fontSize: 11,
    fontWeight: theme.fontWeight.semibold,
    color: "#10b981",
  },
  statusFeedbackBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderBottomWidth: 1,
    gap: 10,
  },
  statusFeedbackInfo: {
    backgroundColor: "rgba(6, 182, 212, 0.14)",
    borderBottomColor: "rgba(6, 182, 212, 0.35)",
  },
  statusFeedbackSuccess: {
    backgroundColor: "rgba(16, 185, 129, 0.14)",
    borderBottomColor: "rgba(16, 185, 129, 0.35)",
  },
  statusFeedbackError: {
    backgroundColor: "rgba(244, 63, 94, 0.16)",
    borderBottomColor: "rgba(244, 63, 94, 0.4)",
  },
  statusFeedbackText: {
    fontSize: 11.5,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
    flex: 1,
  },
  topPromptBar: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: theme.colors.surface1,
    borderBottomWidth: 1,
    borderBottomColor: "#3b82f6",
  },
  topPromptRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
  },
  topPromptTitle: {
    fontSize: 11.5,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  topPromptMessage: {
    fontSize: 11.5,
    color: theme.colors.foregroundMuted,
    flex: 1,
    minWidth: 180,
  },
  promptConfirmDangerBtn: {
    backgroundColor: "#f43f5e",
  },
  resetFiltersBtn: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 4,
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: "#3b82f6",
  },
  resetFiltersBtnText: {
    fontSize: 11.5,
    fontWeight: theme.fontWeight.medium,
    color: "#3b82f6",
  },
  inlineBranchActionStrip: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginHorizontal: 8,
    marginBottom: 4,
    borderRadius: 6,
    backgroundColor: theme.colors.surface0,
    borderWidth: 1,
    borderColor: "rgba(6, 182, 212, 0.28)",
  },
  inlineBranchMergeBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    backgroundColor: "rgba(6, 182, 212, 0.16)",
    borderWidth: 1,
    borderColor: "rgba(6, 182, 212, 0.45)",
  },
  inlineBranchMergeText: {
    fontSize: 10,
    fontWeight: theme.fontWeight.semibold,
    color: "#06b6d4",
  },
  inlineBranchNeutralBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    backgroundColor: "rgba(148, 163, 184, 0.14)",
    borderWidth: 1,
    borderColor: "rgba(148, 163, 184, 0.32)",
  },
  inlineBranchNeutralText: {
    fontSize: 10,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  inlineBranchDangerBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    backgroundColor: "rgba(244, 63, 94, 0.15)",
    borderWidth: 1,
    borderColor: "rgba(244, 63, 94, 0.4)",
  },
  inlineBranchDangerText: {
    fontSize: 10,
    fontWeight: theme.fontWeight.medium,
    color: "#f43f5e",
  },
  headerMergeBranchBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
    backgroundColor: "rgba(6, 182, 212, 0.18)",
    borderWidth: 1,
    borderColor: "rgba(6, 182, 212, 0.5)",
  },
  headerMergeBranchBtnText: {
    fontSize: 11,
    fontWeight: theme.fontWeight.semibold,
    color: "#06b6d4",
  },
}));
