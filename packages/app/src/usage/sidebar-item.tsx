import {
  createContext,
  Fragment,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import {
  Pressable,
  Text,
  View,
  type LayoutChangeEvent,
  type PressableStateCallbackType,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  pluginScreensHostKey,
  rememberPluginContributionHost,
} from "@/plugins/contribution-host";
import { useInstalledPlugin, usePluginInstallations } from "@/plugins/registry";
import { buildPluginSurfaceRoute } from "@/plugins/routes";
import { builtinSidebarNavLabelKey } from "@/sidebar-nav/model";
import { useUsagePreferences } from "./display";
import { formatPct } from "./format";
import { useUsageHostId } from "./hosts";
import { useUsageHostReports } from "./queries";
import { UsageSourceIcon } from "./source-icon";
import { UsageMeter } from "./meter";
import {
  choosePinnedUsageLayout,
  METER_GAP,
  MIN_METER_WIDTH,
  resolvePinnedUsage,
  type PinnedUsageLayout,
  type PinnedUsageSource,
  type PinnedUsageWindow,
} from "./pinned";
import type { UsageTone } from "./types";
import { UsageModal } from "./usage-modal";

const CLAUDE_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"/></svg>';

const CODEX_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" fill-rule="evenodd"><path d="M21.55 10.004a5.416 5.416 0 00-.478-4.501c-1.217-2.09-3.662-3.166-6.05-2.66A5.59 5.59 0 0010.831 1C8.39.995 6.224 2.546 5.473 4.838A5.553 5.553 0 001.76 7.496a5.487 5.487 0 00.691 6.5 5.416 5.416 0 00.477 4.502c1.217 2.09 3.662 3.165 6.05 2.66A5.586 5.586 0 0013.168 23c2.443.006 4.61-1.546 5.361-3.84a5.553 5.553 0 003.715-2.66 5.488 5.488 0 00-.693-6.497v.001zm-8.381 11.558a4.199 4.199 0 01-2.675-.954c.034-.018.093-.05.132-.074l4.44-2.53a.71.71 0 00.364-.623v-6.176l1.877 1.069c.02.01.033.029.036.05v5.115c-.003 2.274-1.87 4.118-4.174 4.123zM4.192 17.78a4.059 4.059 0 01-.498-2.763c.032.02.09.055.131.078l4.44 2.53c.225.13.504.13.73 0l5.42-3.088v2.138a.068.068 0 01-.027.057L9.9 19.288c-1.999 1.136-4.552.46-5.707-1.51h-.001zM3.023 8.216A4.15 4.15 0 015.198 6.41l-.002.151v5.06a.711.711 0 00.364.624l5.42 3.087-1.876 1.07a.067.067 0 01-.063.005l-4.489-2.559c-1.995-1.14-2.679-3.658-1.53-5.63h.001zm15.417 3.54l-5.42-3.088L14.896 7.6a.067.067 0 01.063-.006l4.489 2.557c1.998 1.14 2.683 3.662 1.529 5.633a4.163 4.163 0 01-2.174 1.807V12.38a.71.71 0 00-.363-.623zm1.867-2.773a6.04 6.04 0 00-.132-.078l-4.44-2.53a.731.731 0 00-.729 0l-5.42 3.088V7.325a.068.068 0 01.027-.057L14.1 4.713c2-1.137 4.555-.46 5.707 1.513.487.833.664 1.809.499 2.757h.001zm-11.741 3.81l-1.877-1.068a.065.065 0 01-.036-.051V6.559c.001-2.277 1.873-4.122 4.181-4.12.976 0 1.92.338 2.671.954-.034.018-.092.05-.131.073l-4.44 2.53a.71.71 0 00-.365.623l-.003 6.173v.002zm1.02-2.168L12 9.25l2.414 1.375v2.75L12 14.75l-2.415-1.375v-2.75z"/></svg>';

interface ZeroSubUsageWindow {
  id: string;
  label: string;
  usedPercent: number;
  resetsAt: string | null;
}

interface ZeroSubAccountView {
  id: string;
  family: "claude" | "codex";
  label: string;
  email: string | null;
  status: "ready" | "signed_out" | "limited" | "checking" | "disabled";
  isDefault: boolean;
  usage: {
    fetchedAt: string;
    windows: ZeroSubUsageWindow[];
  } | null;
}

interface ZeroSubStateView {
  accounts: ZeroSubAccountView[];
}

function useZeroSubPlugin() {
  const hostId = useUsageHostId();
  const hostPlugin = useInstalledPlugin(hostId ?? "", "zerosub");
  const allPlugins = usePluginInstallations("zerosub");
  return hostPlugin ?? allPlugins[0] ?? null;
}

function toneFromUsedPercent(usedPercent: number): UsageTone {
  if (usedPercent >= 90) return "danger";
  if (usedPercent >= 75) return "warning";
  return "normal";
}

function resolveZeroSubPinnedUsage(
  state: ZeroSubStateView | null | undefined,
  displayAs: "used" | "remaining",
): PinnedUsageSource[] {
  if (!state?.accounts || state.accounts.length === 0) return [];
  const meaning = displayAs === "remaining" ? "left" : "used";
  const families: Array<{ family: "claude" | "codex"; label: string; icon: string }> = [
    { family: "claude", label: "Claude", icon: CLAUDE_ICON_SVG },
    { family: "codex", label: "Codex", icon: CODEX_ICON_SVG },
  ];

  const sources: PinnedUsageSource[] = [];
  for (const { family, label, icon } of families) {
    const familyAccounts = state.accounts.filter(
      (a) => a.family === family && a.status !== "disabled" && a.status !== "signed_out",
    );
    if (familyAccounts.length === 0) continue;

    const activeAccount =
      familyAccounts.find((a) => a.isDefault && a.status === "ready" && a.usage?.windows?.length) ??
      familyAccounts.find((a) => a.status === "ready" && a.usage?.windows?.length) ??
      familyAccounts.find((a) => a.isDefault && a.usage?.windows?.length) ??
      familyAccounts.find((a) => a.usage?.windows?.length) ??
      familyAccounts[0];

    const rawWindows = activeAccount?.usage?.windows ?? [];
    const summaryWindows: PinnedUsageWindow[] = [];

    for (const w of rawWindows) {
      const lowerId = w.id.toLowerCase();
      const lowerLabel = w.label.toLowerCase();
      let shortLabel: string | null = null;
      if (lowerId === "five_hour" || lowerId === "primary" || lowerLabel === "5-hour") {
        shortLabel = "5h";
      } else if (
        lowerId === "seven_day" ||
        lowerId === "weekly" ||
        lowerId === "secondary" ||
        lowerLabel === "weekly"
      ) {
        shortLabel = "wk";
      }
      if (!shortLabel) continue;

      const used = Math.min(100, Math.max(0, w.usedPercent));
      const percent = displayAs === "remaining" ? Math.max(0, 100 - used) : used;
      const percentText = formatPct(percent);
      summaryWindows.push({
        key: `zerosub-${activeAccount.id}/${w.id}`,
        label: `ZeroSub ${label} (${activeAccount.label}) ${w.label} ${percentText} ${meaning}`,
        shortLabel,
        percent,
        percentText,
        tone: toneFromUsedPercent(used),
      });
    }

    if (summaryWindows.length > 0) {
      const readyCount = familyAccounts.filter((a) => a.status === "ready").length;
      const accountBadge =
        familyAccounts.length > 1 ? `${readyCount}/${familyAccounts.length}` : undefined;
      sources.push({
        key: `zerosub-${family}-${activeAccount.id}`,
        icon,
        accountBadge,
        windows: summaryWindows,
      });
    }
  }
  return sources;
}

/** Each summary window with data on the usage host, under its source; empty while none has. */
function useUsageSummary(): readonly PinnedUsageSource[] {
  const { preferences } = useUsagePreferences();
  const hostId = useUsageHostId();
  const zeroSubPlugin = useZeroSubPlugin();

  const zeroSubQuery = useQuery({
    queryKey: ["zerosub-sidebar-state", zeroSubPlugin?.serverId],
    queryFn: async () => {
      if (!zeroSubPlugin) return null;
      return (await zeroSubPlugin.invoke("zerosub.state", {
        refreshUsage: false,
      })) as ZeroSubStateView;
    },
    enabled: Boolean(zeroSubPlugin),
    refetchInterval: 15_000,
    staleTime: 10_000,
  });

  // Only poll built-in single-account usage sources when ZeroSub is not installed
  const reports = useUsageHostReports(zeroSubPlugin ? null : hostId);

  return useMemo(() => {
    if (zeroSubPlugin && zeroSubQuery.data) {
      const zeroSubSources = resolveZeroSubPinnedUsage(zeroSubQuery.data, preferences.displayAs);
      if (zeroSubSources.length > 0) return zeroSubSources;
    }
    return resolvePinnedUsage(reports, preferences);
  }, [preferences, reports, zeroSubPlugin, zeroSubQuery.data]);
}

/** Whether the sidebar Usage item has anything to show. */
export function useHasUsageSummary(): boolean {
  return useUsageSummary().length > 0;
}

/**
 * The sidebar footer's usage entry: each summary window's source icon and percent, and nothing
 * while no summary window has data, since the footer's Usage icon already opens Usage.
 * Pressing it opens ZeroSub (when installed) or the Usage modal.
 */
export function UsageSidebarItem() {
  const { t } = useTranslation();
  const zeroSubPlugin = useZeroSubPlugin();
  const label = zeroSubPlugin ? "ZeroSub" : t(builtinSidebarNavLabelKey("usage"));
  const openUsage = useOpenSidebarUsage();
  const sources = useUsageSummary();
  if (sources.length === 0) return null;
  return <PinnedUsageTrigger label={label} sources={sources} onPress={openUsage} />;
}

const OpenSidebarUsageContext = createContext<(() => void) | null>(null);

/**
 * One owner for the footer icon and summary: opens ZeroSub Accounts when ZeroSub is installed,
 * or falls back to the built-in Usage modal over the current screen.
 */
export function UsageSidebarRoot({ children }: { children: ReactNode }) {
  const router = useRouter();
  const zeroSubPlugin = useZeroSubPlugin();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const openUsage = useCallback(() => {
    if (zeroSubPlugin) {
      rememberPluginContributionHost(pluginScreensHostKey("zerosub"), zeroSubPlugin.serverId);
      router.push(
        buildPluginSurfaceRoute(zeroSubPlugin.serverId, "zerosub", {
          kind: "surface",
          id: "accounts",
        }),
      );
      return;
    }
    setMounted(true);
    setOpen(true);
  }, [router, zeroSubPlugin]);
  const closeUsage = useCallback(() => setOpen(false), []);
  const unmountUsage = useCallback(() => setMounted(false), []);

  return (
    <OpenSidebarUsageContext.Provider value={openUsage}>
      {children}
      {mounted ? <UsageModal visible={open} onClose={closeUsage} onDismiss={unmountUsage} /> : null}
    </OpenSidebarUsageContext.Provider>
  );
}

/** Both sidebar entry points send the same open command. */
export function useOpenSidebarUsage(): () => void {
  const openUsage = useContext(OpenSidebarUsageContext);
  if (!openUsage) throw new Error("Sidebar Usage must be inside UsageSidebarRoot.");
  return openUsage;
}

function pinnedUsageLabel(label: string, sources: readonly PinnedUsageSource[]): string {
  const windows = sources.flatMap((source) => source.windows);
  return `${label}: ${windows.map((window) => window.label).join(", ")}`;
}

function triggerStyle({ hovered }: PressableStateCallbackType & { hovered?: boolean }) {
  return hovered ? [styles.trigger, styles.triggerHovered] : styles.trigger;
}

function layoutWidth(event: LayoutChangeEvent): number {
  return event.nativeEvent.layout.width;
}

/**
 * One line: each account's icon, then per window a meter and "31% 5h". Off-screen copies measure
 * the line with labels and with percents alone; the richest layout that fits is shown, and what
 * it leaves out takes no space at all.
 */
function PinnedUsageTrigger({
  label,
  sources,
  onPress,
}: {
  label: string;
  sources: readonly PinnedUsageSource[];
  onPress: () => void;
}) {
  const [available, setAvailable] = useState<number | null>(null);
  const [labelsWidth, setLabelsWidth] = useState<number | null>(null);
  const [percentsWidth, setPercentsWidth] = useState<number | null>(null);
  const handleAvailableLayout = useCallback((event: LayoutChangeEvent) => {
    setAvailable(layoutWidth(event));
  }, []);
  const handleLabelsLayout = useCallback((event: LayoutChangeEvent) => {
    setLabelsWidth(layoutWidth(event));
  }, []);
  const handlePercentsLayout = useCallback((event: LayoutChangeEvent) => {
    setPercentsWidth(layoutWidth(event));
  }, []);
  const layout = choosePinnedUsageLayout({
    available,
    labelsWidth,
    percentsWidth,
    windowCount: sources.reduce((count, source) => count + source.windows.length, 0),
  });
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={pinnedUsageLabel(label, sources)}
      style={triggerStyle}
      testID="sidebar-usage"
    >
      <View style={styles.line} onLayout={handleAvailableLayout}>
        <PinnedUsageLine sources={sources} layout={layout} />
      </View>
      <View
        style={styles.measure}
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        aria-hidden
      >
        <View style={styles.measured} onLayout={handleLabelsLayout}>
          <PinnedUsageLine sources={sources} layout="labels" measuring />
        </View>
        <View style={styles.measured} onLayout={handlePercentsLayout}>
          <PinnedUsageLine sources={sources} layout="percents" measuring />
        </View>
      </View>
    </Pressable>
  );
}

/**
 * The line's items as direct children of one row, so every meter shares the leftover width
 * equally.
 */
function PinnedUsageLine({
  sources,
  layout,
  measuring = false,
}: {
  sources: readonly PinnedUsageSource[];
  layout: PinnedUsageLayout;
  measuring?: boolean;
}) {
  return sources.map((source, sourceIndex) => (
    <Fragment key={source.key}>
      <View
        style={[styles.sourceIconRow, sourceIndex === 0 ? null : styles.sourceGap]}
        testID={measuring ? undefined : "sidebar-usage-source"}
      >
        <UsageSourceIcon svg={source.icon} size={14} />
        {source.accountBadge && layout !== "percents" ? (
          <Text style={styles.accountBadge} numberOfLines={1}>
            {source.accountBadge}
          </Text>
        ) : null}
      </View>
      {source.windows.map((window, windowIndex) => {
        const leadStyle = windowIndex === 0 ? styles.iconGap : styles.windowGap;
        return (
          <Fragment key={window.key}>
            {layout === "meters" ? (
              <View style={[styles.meterSlot, leadStyle]}>
                <UsageMeter
                  percent={window.percent}
                  tone={window.tone}
                  quiet
                  style={styles.meter}
                />
              </View>
            ) : null}
            <Text
              style={[styles.percent, layout === "meters" ? null : leadStyle]}
              numberOfLines={1}
              testID={measuring ? undefined : "sidebar-usage-pinned-window"}
            >
              {window.percentText}
              {layout === "percents" || window.shortLabel === "" ? null : (
                <Text style={styles.windowLabel}>{` ${window.shortLabel}`}</Text>
              )}
            </Text>
          </Fragment>
        );
      })}
    </Fragment>
  ));
}

const styles = StyleSheet.create((theme) => ({
  trigger: {
    width: "100%",
    flexDirection: "row",
    alignItems: "center",
    overflow: "hidden",
    // Same row geometry and leading rail as Add project and the footer icons.
    minHeight: 28,
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
  },
  triggerHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  line: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    overflow: "hidden",
  },
  // Wide enough that nothing inside wraps or shrinks; each child reports its natural width.
  measure: {
    position: "absolute",
    top: 0,
    left: 0,
    width: 10_000,
    opacity: 0,
  },
  measured: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
  },
  sourceIconRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
  },
  accountBadge: {
    fontSize: 10,
    fontWeight: theme.fontWeight.semibold,
    color: "#10b981",
    fontVariant: ["tabular-nums"],
  },
  sourceGap: {
    marginLeft: theme.spacing[3],
  },
  iconGap: {
    marginLeft: theme.spacing[1.5],
  },
  windowGap: {
    marginLeft: theme.spacing[2],
  },
  // Every slot takes an equal share of the leftover width, so the line fills the row.
  meterSlot: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    minWidth: MIN_METER_WIDTH,
    marginRight: METER_GAP,
  },
  meter: {
    height: 6,
    borderRadius: 3,
  },
  percent: {
    flexShrink: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  windowLabel: {
    color: theme.colors.foregroundMuted,
  },
}));
