import { Alert } from "react-native";
import { UnistylesRuntime } from "react-native-unistyles";
import { getDesktopHost, type DesktopDialogAskOptions } from "@/desktop/host";
import { isNative } from "@/constants/platform";
import type { Theme } from "@/styles/theme";

export type ConfirmDialogBadgeTone = "emerald" | "cyan" | "amber" | "rose" | "blue";

export interface ConfirmDialogBadge {
  label: string;
  tone?: ConfirmDialogBadgeTone;
}

export interface ConfirmDialogBranchFlow {
  from: string;
  to: string;
  actionLabel?: string;
}

export interface ConfirmDialogInput {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  branchFlow?: ConfirmDialogBranchFlow;
  badges?: ConfirmDialogBadge[];
}

export interface ConfirmCommitDialogInput {
  title?: string;
  confirmLabel?: string;
  branchName: string;
  diffStat?: { additions: number; deletions: number } | null;
  initialMessage?: string;
  initialAmend?: boolean;
  initialPush?: boolean;
}

export interface ConfirmCommitDialogResult {
  confirmed: boolean;
  message: string;
  amend: boolean;
  push: boolean;
}

interface ConfirmButtonConfig {
  confirmLabel: string;
  cancelLabel: string;
}

type ConfirmDialogTheme = Pick<
  Theme,
  "colorScheme" | "spacing" | "fontSize" | "fontWeight" | "borderRadius" | "fontFamily"
> & {
  colors: Pick<
    Theme["colors"],
    | "surface0"
    | "surface1"
    | "surface2"
    | "surface3"
    | "foreground"
    | "foregroundMuted"
    | "foregroundExtraMuted"
    | "border"
    | "borderAccent"
    | "accent"
    | "accentForeground"
    | "destructive"
    | "destructiveForeground"
    | "statusSuccess"
    | "statusSuccessTint"
    | "statusWarning"
    | "statusWarningTint"
    | "statusDanger"
    | "statusDangerTint"
    | "statusDotRunning"
    | "diffAddition"
    | "diffDeletion"
  >;
};

const FALLBACK_COMMON_TOKENS: Pick<
  ConfirmDialogTheme,
  "spacing" | "fontSize" | "fontWeight" | "borderRadius" | "fontFamily"
> = {
  spacing: {
    0: 0,
    0.5: 2,
    1: 4,
    1.5: 6,
    2: 8,
    3: 12,
    4: 16,
    6: 24,
    8: 32,
    12: 48,
    16: 64,
    20: 80,
    24: 96,
    32: 128,
  },
  fontSize: {
    code: 12,
    content: 15,
    sm: 12,
    base: 14,
    lg: 16,
    xl: 18,
    "2xl": 20,
    "3xl": 22,
    "4xl": 26,
  },
  fontWeight: {
    normal: "normal",
    medium: "500",
    semibold: "600",
    bold: "bold",
  },
  borderRadius: {
    none: 0,
    sm: 2,
    base: 4,
    md: 6,
    lg: 8,
    xl: 12,
    "2xl": 16,
    full: 9999,
  },
  fontFamily: {
    ui: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    mono: "SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
  },
};

const FALLBACK_LIGHT_THEME: ConfirmDialogTheme = {
  colorScheme: "light",
  ...FALLBACK_COMMON_TOKENS,
  colors: {
    surface0: "#ffffff",
    surface1: "#f4f4f5",
    surface2: "#e4e4e7",
    surface3: "#d4d4d8",
    foreground: "#18181b",
    foregroundMuted: "#71717a",
    foregroundExtraMuted: "#a1a1aa",
    border: "#e4e4e7",
    borderAccent: "#d4d4d8",
    accent: "#20744A",
    accentForeground: "#ffffff",
    destructive: "#dc2626",
    destructiveForeground: "#ffffff",
    statusSuccess: "#15803d",
    statusSuccessTint: "#16a34a1a",
    statusWarning: "#b45309",
    statusWarningTint: "#f59e0b1f",
    statusDanger: "#b91c1c",
    statusDangerTint: "#dc26261a",
    statusDotRunning: "#3b82f6",
    diffAddition: "#15803d",
    diffDeletion: "#b91c1c",
  },
};

const FALLBACK_DARK_THEME: ConfirmDialogTheme = {
  colorScheme: "dark",
  ...FALLBACK_COMMON_TOKENS,
  colors: {
    surface0: "#121214",
    surface1: "#1a1a1d",
    surface2: "#27272a",
    surface3: "#3f3f46",
    foreground: "#fafafa",
    foregroundMuted: "#a1a1aa",
    foregroundExtraMuted: "#52525b",
    border: "#27272a",
    borderAccent: "#3f3f46",
    accent: "#20744A",
    accentForeground: "#fafafa",
    destructive: "#dc2626",
    destructiveForeground: "#fafafa",
    statusSuccess: "#4ade80",
    statusSuccessTint: "#4ade801f",
    statusWarning: "#fbbf24",
    statusWarningTint: "#fbbf241f",
    statusDanger: "#fca5a5",
    statusDangerTint: "#f871711f",
    statusDotRunning: "#3b82f6",
    diffAddition: "#4ade80",
    diffDeletion: "#fca5a5",
  },
};

function getActiveTheme(): ConfirmDialogTheme {
  try {
    const active = UnistylesRuntime.getTheme() as ConfirmDialogTheme | undefined;
    if (active && active.colors && typeof active.colors.surface1 === "string") {
      return active;
    }
    const themeName = UnistylesRuntime.themeName;
    if (typeof themeName === "string" && themeName.includes("dark")) {
      return FALLBACK_DARK_THEME;
    }
  } catch {
    // Fallback when Unistyles runtime is not initialized (e.g. unit tests)
  }
  if (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  ) {
    return FALLBACK_DARK_THEME;
  }
  return FALLBACK_LIGHT_THEME;
}

function resolveButtonLabels(input: ConfirmDialogInput): ConfirmButtonConfig {
  return {
    confirmLabel: input.confirmLabel ?? "Confirm",
    cancelLabel: input.cancelLabel ?? "Cancel",
  };
}

function resolveBadgePalette(theme: ConfirmDialogTheme, tone: ConfirmDialogBadgeTone = "emerald") {
  switch (tone) {
    case "emerald":
      return {
        color: theme.colors.statusSuccess,
        border: theme.colors.border,
        bg: theme.colors.statusSuccessTint,
      };
    case "cyan":
    case "blue":
      return {
        color: theme.colors.statusDotRunning,
        border: theme.colors.border,
        bg: theme.colors.surface2,
      };
    case "amber":
      return {
        color: theme.colors.statusWarning,
        border: theme.colors.border,
        bg: theme.colors.statusWarningTint,
      };
    case "rose":
      return {
        color: theme.colors.statusDanger,
        border: theme.colors.border,
        bg: theme.colors.statusDangerTint,
      };
  }
}

function createCloseIconButton(
  doc: Document,
  theme: ConfirmDialogTheme,
  onClose: () => void,
): HTMLButtonElement {
  const closeBtn = doc.createElement("button");
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "Close");
  Object.assign(closeBtn.style, {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    padding: `${theme.spacing[2]}px`,
    borderRadius: `${theme.borderRadius.lg}px`,
    border: "none",
    backgroundColor: "transparent",
    color: theme.colors.foregroundMuted,
    cursor: "pointer",
    lineHeight: "0",
  });
  closeBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
  closeBtn.addEventListener("mouseenter", () => {
    closeBtn.style.color = theme.colors.foreground;
  });
  closeBtn.addEventListener("mouseleave", () => {
    closeBtn.style.color = theme.colors.foregroundMuted;
  });
  closeBtn.addEventListener("click", onClose);
  return closeBtn;
}

async function showNativeConfirmDialog(input: ConfirmDialogInput): Promise<boolean> {
  const labels = resolveButtonLabels(input);
  const flowPrefix = input.branchFlow
    ? `${input.branchFlow.from} → ${input.branchFlow.to}\n\n`
    : "";

  return new Promise<boolean>((resolve) => {
    Alert.alert(
      input.title,
      `${flowPrefix}${input.message}`,
      [
        {
          text: labels.cancelLabel,
          style: "cancel",
          onPress: () => resolve(false),
        },
        {
          text: labels.confirmLabel,
          style: input.destructive ? "destructive" : "default",
          onPress: () => resolve(true),
        },
      ],
      {
        cancelable: true,
        onDismiss: () => resolve(false),
      },
    );
  });
}

function getDesktopApi() {
  if (isNative) {
    return null;
  }
  return getDesktopHost();
}

function buildDesktopAskOptions(input: ConfirmDialogInput): DesktopDialogAskOptions {
  const labels = resolveButtonLabels(input);

  return {
    title: input.title,
    okLabel: labels.confirmLabel,
    cancelLabel: labels.cancelLabel,
    kind: input.destructive ? "warning" : "info",
  };
}

function blurActiveWebElement(): void {
  if (isNative) {
    return;
  }
  const activeElement = (globalThis as { document?: Document }).document?.activeElement;
  (activeElement as HTMLElement | null)?.blur?.();
}

async function showDesktopConfirmDialog(input: ConfirmDialogInput): Promise<boolean | null> {
  // Prefer rich DOM confirm modal when running in web/desktop webview so branchFlow & badges render clearly
  if (
    canRenderDomConfirmModal() &&
    (input.branchFlow || (input.badges && input.badges.length > 0))
  ) {
    return null;
  }
  const desktopApi = getDesktopApi();
  if (!desktopApi) {
    return null;
  }

  blurActiveWebElement();
  const options = buildDesktopAskOptions(input);
  const desktopAsk = desktopApi.dialog?.ask;

  if (typeof desktopAsk === "function") {
    return await desktopAsk(input.message, options);
  }

  return null;
}

export function canRenderDomConfirmModal(): boolean {
  if (isNative) {
    return false;
  }
  const doc = (globalThis as { document?: Document }).document;
  return Boolean(
    doc &&
    typeof doc.createElement === "function" &&
    doc.body &&
    typeof doc.body.appendChild === "function",
  );
}

function showDomConfirmModal(input: ConfirmDialogInput): Promise<boolean> {
  const doc = (globalThis as { document?: Document }).document!;
  const labels = resolveButtonLabels(input);
  const theme = getActiveTheme();
  blurActiveWebElement();

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const overlay = doc.createElement("div");
    overlay.setAttribute("data-testid", "paseo-confirm-dialog-overlay");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    Object.assign(overlay.style, {
      position: "fixed",
      inset: "0",
      zIndex: "2147483646",
      backgroundColor: "rgba(0, 0, 0, 0.55)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: `${theme.spacing[6]}px`,
      fontFamily: theme.fontFamily.ui,
    });

    const card = doc.createElement("div");
    Object.assign(card.style, {
      width: "100%",
      maxWidth: "520px",
      backgroundColor: theme.colors.surface1,
      border: `1px solid ${theme.colors.surface2}`,
      borderRadius: `${theme.borderRadius.xl}px`,
      boxShadow:
        theme.colorScheme === "dark"
          ? "0 12px 24px rgba(0, 0, 0, 0.40)"
          : "0 8px 24px rgba(0, 0, 0, 0.08)",
      color: theme.colors.foreground,
      overflow: "hidden",
    });

    const cleanup = (result: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      globalThis.removeEventListener?.("keydown", onKeyDown, true);
      overlay.remove();
      resolve(result);
    };

    const header = doc.createElement("div");
    Object.assign(header.style, {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: `${theme.spacing[2]}px`,
      padding: `${theme.spacing[4]}px ${theme.spacing[6]}px`,
      borderBottom: `1px solid ${theme.colors.surface2}`,
    });

    const titleEl = doc.createElement("div");
    titleEl.textContent = input.title;
    Object.assign(titleEl.style, {
      flex: "1",
      fontSize: `${theme.fontSize.base}px`,
      fontWeight: String(theme.fontWeight.medium),
      color: theme.colors.foreground,
      lineHeight: "1.4",
    });

    header.appendChild(titleEl);
    header.appendChild(createCloseIconButton(doc, theme, () => cleanup(false)));

    const contentWrap = doc.createElement("div");
    Object.assign(contentWrap.style, {
      padding: `${theme.spacing[6]}px`,
      display: "flex",
      flexDirection: "column",
      gap: `${theme.spacing[4]}px`,
    });

    if (input.branchFlow) {
      const flowBox = doc.createElement("div");
      Object.assign(flowBox.style, {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: `${theme.spacing[2]}px`,
        padding: `${theme.spacing[3]}px`,
        borderRadius: `${theme.borderRadius.md}px`,
        backgroundColor: theme.colors.surface0,
        border: `1px solid ${theme.colors.border}`,
        flexWrap: "wrap",
      });

      const makeBranchPill = (branch: string, highlight: boolean) => {
        const pill = doc.createElement("span");
        pill.textContent = branch;
        Object.assign(pill.style, {
          display: "inline-flex",
          alignItems: "center",
          padding: `${theme.spacing[1]}px ${theme.spacing[2]}px`,
          borderRadius: `${theme.borderRadius.base}px`,
          fontSize: `${theme.fontSize.code}px`,
          fontWeight: String(theme.fontWeight.medium),
          fontFamily: theme.fontFamily.mono,
          backgroundColor: highlight ? theme.colors.statusSuccessTint : theme.colors.surface2,
          color: highlight ? theme.colors.statusSuccess : theme.colors.foreground,
          border: `1px solid ${theme.colors.border}`,
        });
        return pill;
      };

      const arrowWrap = doc.createElement("span");
      arrowWrap.textContent = input.branchFlow.actionLabel
        ? `→ ${input.branchFlow.actionLabel} →`
        : "→";
      Object.assign(arrowWrap.style, {
        fontSize: `${theme.fontSize.sm}px`,
        fontWeight: String(theme.fontWeight.medium),
        color: theme.colors.foregroundMuted,
      });

      flowBox.appendChild(makeBranchPill(input.branchFlow.from, false));
      flowBox.appendChild(arrowWrap);
      flowBox.appendChild(makeBranchPill(input.branchFlow.to, true));
      contentWrap.appendChild(flowBox);
    }

    if (input.badges && input.badges.length > 0) {
      const badgesRow = doc.createElement("div");
      Object.assign(badgesRow.style, {
        display: "flex",
        alignItems: "center",
        gap: `${theme.spacing[1.5]}px`,
        flexWrap: "wrap",
      });
      for (const b of input.badges) {
        const palette = resolveBadgePalette(theme, b.tone);
        const chip = doc.createElement("span");
        chip.textContent = b.label;
        Object.assign(chip.style, {
          padding: `2px ${theme.spacing[2]}px`,
          borderRadius: `${theme.borderRadius.base}px`,
          fontSize: `${theme.fontSize.sm}px`,
          fontWeight: String(theme.fontWeight.medium),
          color: palette.color,
          backgroundColor: palette.bg,
          border: `1px solid ${palette.border}`,
        });
        badgesRow.appendChild(chip);
      }
      contentWrap.appendChild(badgesRow);
    }

    const body = doc.createElement("div");
    body.textContent = input.message;
    Object.assign(body.style, {
      fontSize: `${theme.fontSize.base}px`,
      lineHeight: "1.5",
      color: theme.colors.foregroundMuted,
      whiteSpace: "pre-wrap",
      wordBreak: "break-word",
    });
    contentWrap.appendChild(body);

    const btnGroup = doc.createElement("div");
    Object.assign(btnGroup.style, {
      display: "flex",
      alignItems: "center",
      gap: `${theme.spacing[2]}px`,
      marginTop: `${theme.spacing[1]}px`,
    });

    const cancelBtn = doc.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = labels.cancelLabel;
    cancelBtn.setAttribute("data-testid", "paseo-confirm-dialog-cancel");
    Object.assign(cancelBtn.style, {
      flex: "1",
      height: "32px",
      padding: `0 ${theme.spacing[3]}px`,
      borderRadius: `${theme.borderRadius.lg}px`,
      border: `1px solid ${theme.colors.surface3}`,
      backgroundColor: theme.colors.surface3,
      color: theme.colors.foreground,
      fontSize: `${theme.fontSize.base}px`,
      fontWeight: String(theme.fontWeight.normal),
      fontFamily: theme.fontFamily.ui,
      cursor: "pointer",
    });

    const confirmBg = input.destructive ? theme.colors.destructive : theme.colors.accent;
    const confirmFg = input.destructive
      ? theme.colors.destructiveForeground
      : theme.colors.accentForeground;

    const confirmBtn = doc.createElement("button");
    confirmBtn.type = "button";
    confirmBtn.textContent = labels.confirmLabel;
    confirmBtn.setAttribute("data-testid", "paseo-confirm-dialog-confirm");
    Object.assign(confirmBtn.style, {
      flex: "1",
      height: "32px",
      padding: `0 ${theme.spacing[3]}px`,
      borderRadius: `${theme.borderRadius.lg}px`,
      border: `1px solid ${confirmBg}`,
      backgroundColor: confirmBg,
      color: confirmFg,
      fontSize: `${theme.fontSize.base}px`,
      fontWeight: String(theme.fontWeight.normal),
      fontFamily: theme.fontFamily.ui,
      cursor: "pointer",
    });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cleanup(false);
      } else if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        cleanup(true);
      }
    };

    cancelBtn.addEventListener("click", () => cleanup(false));
    confirmBtn.addEventListener("click", () => cleanup(true));
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) {
        cleanup(false);
      }
    });

    btnGroup.appendChild(cancelBtn);
    btnGroup.appendChild(confirmBtn);
    contentWrap.appendChild(btnGroup);
    card.appendChild(header);
    card.appendChild(contentWrap);
    overlay.appendChild(card);
    doc.body.appendChild(overlay);
    globalThis.addEventListener?.("keydown", onKeyDown, true);
    confirmBtn.focus?.();
  });
}

async function showWebConfirmDialog(input: ConfirmDialogInput): Promise<boolean> {
  if (canRenderDomConfirmModal()) {
    return showDomConfirmModal(input);
  }

  const browserConfirm = (globalThis as { confirm?: (message?: string) => boolean }).confirm;
  if (typeof browserConfirm !== "function") {
    throw new Error("[ConfirmDialog] No web confirmation backend is available.");
  }

  blurActiveWebElement();
  const promptMessage = `${input.title}\n\n${input.message}`;
  return browserConfirm(promptMessage);
}

export async function confirmDialog(input: ConfirmDialogInput): Promise<boolean> {
  if (isNative) {
    return showNativeConfirmDialog(input);
  }

  const desktopResult = await showDesktopConfirmDialog(input);
  if (desktopResult !== null) {
    return desktopResult;
  }

  return showWebConfirmDialog(input);
}

export async function confirmCommitDialog(
  input: ConfirmCommitDialogInput,
): Promise<ConfirmCommitDialogResult> {
  if (!canRenderDomConfirmModal()) {
    const confirmed = await confirmDialog({
      title: `Commit Changes (${input.branchName})`,
      message: "Commit all local changes on this branch?",
      confirmLabel: "Commit",
      cancelLabel: "Cancel",
    });
    return {
      confirmed,
      message: input.initialMessage ?? "",
      amend: Boolean(input.initialAmend),
      push: Boolean(input.initialPush),
    };
  }

  const doc = (globalThis as { document?: Document }).document!;
  const theme = getActiveTheme();
  blurActiveWebElement();

  return new Promise<ConfirmCommitDialogResult>((resolve) => {
    let settled = false;
    let amendState = Boolean(input.initialAmend);
    let pushState = Boolean(input.initialPush);

    const overlay = doc.createElement("div");
    overlay.setAttribute("data-testid", "paseo-confirm-commit-dialog-overlay");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    Object.assign(overlay.style, {
      position: "fixed",
      inset: "0",
      zIndex: "2147483646",
      backgroundColor: "rgba(0, 0, 0, 0.55)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: `${theme.spacing[6]}px`,
      fontFamily: theme.fontFamily.ui,
    });

    const card = doc.createElement("div");
    Object.assign(card.style, {
      width: "100%",
      maxWidth: "520px",
      backgroundColor: theme.colors.surface1,
      border: `1px solid ${theme.colors.surface2}`,
      borderRadius: `${theme.borderRadius.xl}px`,
      boxShadow:
        theme.colorScheme === "dark"
          ? "0 12px 24px rgba(0, 0, 0, 0.40)"
          : "0 8px 24px rgba(0, 0, 0, 0.08)",
      color: theme.colors.foreground,
      overflow: "hidden",
    });

    const textarea = doc.createElement("textarea");

    const cleanup = (confirmed: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      globalThis.removeEventListener?.("keydown", onKeyDown, true);
      overlay.remove();
      resolve({
        confirmed,
        message: textarea.value.trim(),
        amend: amendState,
        push: pushState,
      });
    };

    const header = doc.createElement("div");
    Object.assign(header.style, {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: `${theme.spacing[2]}px`,
      padding: `${theme.spacing[4]}px ${theme.spacing[6]}px`,
      borderBottom: `1px solid ${theme.colors.surface2}`,
    });

    const titleEl = doc.createElement("div");
    titleEl.textContent = input.title ?? "Confirm Git Commit";
    Object.assign(titleEl.style, {
      flex: "1",
      fontSize: `${theme.fontSize.base}px`,
      fontWeight: String(theme.fontWeight.medium),
      color: theme.colors.foreground,
    });

    const headerRight = doc.createElement("div");
    Object.assign(headerRight.style, {
      display: "flex",
      alignItems: "center",
      gap: `${theme.spacing[2]}px`,
    });

    const branchPill = doc.createElement("span");
    branchPill.textContent = input.branchName;
    Object.assign(branchPill.style, {
      padding: `2px ${theme.spacing[2]}px`,
      borderRadius: `${theme.borderRadius.base}px`,
      fontSize: `${theme.fontSize.code}px`,
      fontWeight: String(theme.fontWeight.medium),
      fontFamily: theme.fontFamily.mono,
      color: theme.colors.statusSuccess,
      backgroundColor: theme.colors.statusSuccessTint,
      border: `1px solid ${theme.colors.border}`,
    });

    headerRight.appendChild(branchPill);
    headerRight.appendChild(createCloseIconButton(doc, theme, () => cleanup(false)));
    header.appendChild(titleEl);
    header.appendChild(headerRight);

    const body = doc.createElement("div");
    Object.assign(body.style, {
      padding: `${theme.spacing[6]}px`,
      display: "flex",
      flexDirection: "column",
      gap: `${theme.spacing[3]}px`,
    });

    const statRow = doc.createElement("div");
    Object.assign(statRow.style, {
      display: "flex",
      alignItems: "center",
      gap: `${theme.spacing[2]}px`,
      flexWrap: "wrap",
      fontSize: `${theme.fontSize.sm}px`,
      color: theme.colors.foregroundMuted,
    });
    const statLabel = doc.createElement("span");
    statLabel.textContent = "Stage toàn bộ thay đổi hiện tại và tạo commit mới trên nhánh ";
    const statBranch = doc.createElement("strong");
    statBranch.textContent = input.branchName;
    statBranch.style.color = theme.colors.foreground;
    statRow.appendChild(statLabel);
    statRow.appendChild(statBranch);

    if (input.diffStat && (input.diffStat.additions > 0 || input.diffStat.deletions > 0)) {
      const diffBadge = doc.createElement("span");
      diffBadge.textContent = `+${input.diffStat.additions} / -${input.diffStat.deletions}`;
      Object.assign(diffBadge.style, {
        padding: `2px ${theme.spacing[2]}px`,
        borderRadius: `${theme.borderRadius.base}px`,
        fontSize: `${theme.fontSize.sm}px`,
        fontWeight: String(theme.fontWeight.medium),
        color: theme.colors.foreground,
        backgroundColor: theme.colors.surface2,
        border: `1px solid ${theme.colors.border}`,
      });
      statRow.appendChild(diffBadge);
    }
    body.appendChild(statRow);

    const textareaLabel = doc.createElement("div");
    textareaLabel.textContent = "Commit Message (Để trống để AI tự động sinh commit message):";
    Object.assign(textareaLabel.style, {
      fontSize: `${theme.fontSize.sm}px`,
      fontWeight: String(theme.fontWeight.medium),
      color: theme.colors.foregroundMuted,
    });
    body.appendChild(textareaLabel);

    textarea.value = input.initialMessage ?? "";
    textarea.placeholder =
      "Nhập nội dung commit tại đây, hoặc để trống để AI tự phân tích diff & tạo commit message...";
    textarea.rows = 4;
    textarea.setAttribute("data-testid", "paseo-confirm-commit-message-input");
    Object.assign(textarea.style, {
      width: "100%",
      boxSizing: "border-box",
      padding: `${theme.spacing[3]}px`,
      borderRadius: `${theme.borderRadius.md}px`,
      border: `1px solid ${theme.colors.border}`,
      backgroundColor: theme.colors.surface0,
      color: theme.colors.foreground,
      fontSize: `${theme.fontSize.base}px`,
      lineHeight: "1.45",
      fontFamily: theme.fontFamily.mono,
      resize: "vertical",
      outline: "none",
    });
    body.appendChild(textarea);

    const optionsRow = doc.createElement("div");
    Object.assign(optionsRow.style, {
      display: "flex",
      alignItems: "center",
      gap: `${theme.spacing[2]}px`,
      flexWrap: "wrap",
    });

    const createOptionToggle = (
      label: string,
      active: boolean,
      activeColor: string,
      activeTint: string,
      onToggle: () => void,
    ) => {
      const btn = doc.createElement("button");
      btn.type = "button";
      const renderStyle = (isActive: boolean) => {
        btn.textContent = `${isActive ? "✓ " : ""}${label}`;
        Object.assign(btn.style, {
          padding: `4px ${theme.spacing[2]}px`,
          borderRadius: `${theme.borderRadius.md}px`,
          fontSize: `${theme.fontSize.sm}px`,
          fontWeight: String(theme.fontWeight.medium),
          fontFamily: theme.fontFamily.ui,
          cursor: "pointer",
          border: `1px solid ${isActive ? activeColor : theme.colors.border}`,
          backgroundColor: isActive ? activeTint : theme.colors.surface2,
          color: isActive ? activeColor : theme.colors.foregroundMuted,
        });
      };
      renderStyle(active);
      btn.addEventListener("click", () => {
        onToggle();
      });
      return { btn, renderStyle };
    };

    const confirmBtn = doc.createElement("button");
    confirmBtn.type = "button";
    confirmBtn.setAttribute("data-testid", "paseo-confirm-commit-submit");

    const updateConfirmButtonText = () => {
      if (amendState && pushState) {
        confirmBtn.textContent = "Amend & Push";
      } else if (pushState) {
        confirmBtn.textContent = "Commit & Push";
      } else if (amendState) {
        confirmBtn.textContent = "Amend Commit";
      } else {
        confirmBtn.textContent = textarea.value.trim() ? "Commit" : "✨ AI Commit";
      }
    };

    const amendToggle = createOptionToggle(
      "Amend previous commit",
      amendState,
      theme.colors.statusWarning,
      theme.colors.statusWarningTint,
      () => {
        amendState = !amendState;
        amendToggle.renderStyle(amendState);
        updateConfirmButtonText();
      },
    );

    const pushToggle = createOptionToggle(
      "Push to remote after commit",
      pushState,
      theme.colors.statusSuccess,
      theme.colors.statusSuccessTint,
      () => {
        pushState = !pushState;
        pushToggle.renderStyle(pushState);
        updateConfirmButtonText();
      },
    );

    textarea.addEventListener("input", updateConfirmButtonText);
    optionsRow.appendChild(amendToggle.btn);
    optionsRow.appendChild(pushToggle.btn);
    body.appendChild(optionsRow);

    const btnGroup = doc.createElement("div");
    Object.assign(btnGroup.style, {
      display: "flex",
      alignItems: "center",
      gap: `${theme.spacing[2]}px`,
      marginTop: `${theme.spacing[1]}px`,
    });

    const cancelBtn = doc.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = "Cancel";
    cancelBtn.setAttribute("data-testid", "paseo-confirm-commit-cancel");
    Object.assign(cancelBtn.style, {
      flex: "1",
      height: "32px",
      padding: `0 ${theme.spacing[3]}px`,
      borderRadius: `${theme.borderRadius.lg}px`,
      border: `1px solid ${theme.colors.surface3}`,
      backgroundColor: theme.colors.surface3,
      color: theme.colors.foreground,
      fontSize: `${theme.fontSize.base}px`,
      fontWeight: String(theme.fontWeight.normal),
      fontFamily: theme.fontFamily.ui,
      cursor: "pointer",
    });

    Object.assign(confirmBtn.style, {
      flex: "1",
      height: "32px",
      padding: `0 ${theme.spacing[3]}px`,
      borderRadius: `${theme.borderRadius.lg}px`,
      border: `1px solid ${theme.colors.accent}`,
      backgroundColor: theme.colors.accent,
      color: theme.colors.accentForeground,
      fontSize: `${theme.fontSize.base}px`,
      fontWeight: String(theme.fontWeight.normal),
      fontFamily: theme.fontFamily.ui,
      cursor: "pointer",
    });
    updateConfirmButtonText();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cleanup(false);
      } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        event.stopPropagation();
        cleanup(true);
      }
    };

    cancelBtn.addEventListener("click", () => cleanup(false));
    confirmBtn.addEventListener("click", () => cleanup(true));
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) {
        cleanup(false);
      }
    });

    btnGroup.appendChild(cancelBtn);
    btnGroup.appendChild(confirmBtn);
    body.appendChild(btnGroup);
    card.appendChild(header);
    card.appendChild(body);
    overlay.appendChild(card);
    doc.body.appendChild(overlay);
    globalThis.addEventListener?.("keydown", onKeyDown, true);
    textarea.focus?.();
  });
}

export const __private__ = {
  blurActiveWebElement,
  buildDesktopAskOptions,
};
