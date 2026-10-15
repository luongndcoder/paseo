import { Alert } from "react-native";
import { getDesktopHost, type DesktopDialogAskOptions } from "@/desktop/host";
import { isNative } from "@/constants/platform";

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

function resolveButtonLabels(input: ConfirmDialogInput): ConfirmButtonConfig {
  return {
    confirmLabel: input.confirmLabel ?? "Confirm",
    cancelLabel: input.cancelLabel ?? "Cancel",
  };
}

function resolveBadgePalette(tone: ConfirmDialogBadgeTone = "emerald") {
  switch (tone) {
    case "emerald":
      return {
        color: "#10b981",
        border: "rgba(16, 185, 129, 0.45)",
        bg: "rgba(16, 185, 129, 0.14)",
      };
    case "cyan":
      return {
        color: "#06b6d4",
        border: "rgba(6, 182, 212, 0.45)",
        bg: "rgba(6, 182, 212, 0.14)",
      };
    case "amber":
      return {
        color: "#f59e0b",
        border: "rgba(245, 158, 11, 0.45)",
        bg: "rgba(245, 158, 11, 0.14)",
      };
    case "rose":
      return {
        color: "#f43f5e",
        border: "rgba(244, 63, 94, 0.45)",
        bg: "rgba(244, 63, 94, 0.14)",
      };
    case "blue":
      return {
        color: "#3b82f6",
        border: "rgba(59, 130, 246, 0.45)",
        bg: "rgba(59, 130, 246, 0.14)",
      };
  }
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
      backgroundColor: "rgba(0, 0, 0, 0.65)",
      backdropFilter: "blur(3px)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: "16px",
      fontFamily:
        '-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    });

    const card = doc.createElement("div");
    Object.assign(card.style, {
      width: "100%",
      maxWidth: "460px",
      backgroundColor: "#1e2229",
      border: `1px solid ${input.destructive ? "#f43f5e" : "#10b981"}`,
      borderRadius: "10px",
      boxShadow: "0 22px 55px rgba(0, 0, 0, 0.72)",
      color: "#e2e8f0",
      overflow: "hidden",
    });

    const header = doc.createElement("div");
    Object.assign(header.style, {
      display: "flex",
      alignItems: "center",
      gap: "10px",
      padding: "14px 18px 12px 18px",
      borderBottom: "1px solid #2e3440",
      backgroundColor: "#15181e",
    });

    const badge = doc.createElement("span");
    badge.textContent = input.destructive ? "!" : "⎇";
    Object.assign(badge.style, {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      width: "24px",
      height: "24px",
      borderRadius: "6px",
      fontSize: "13px",
      fontWeight: "700",
      flexShrink: "0",
      backgroundColor: input.destructive ? "rgba(244, 63, 94, 0.18)" : "rgba(16, 185, 129, 0.18)",
      color: input.destructive ? "#f43f5e" : "#10b981",
      border: `1px solid ${input.destructive ? "rgba(244, 63, 94, 0.45)" : "rgba(16, 185, 129, 0.45)"}`,
    });

    const titleEl = doc.createElement("div");
    titleEl.textContent = input.title;
    Object.assign(titleEl.style, {
      fontSize: "14px",
      fontWeight: "700",
      color: "#f8fafc",
      lineHeight: "1.35",
    });

    header.appendChild(badge);
    header.appendChild(titleEl);

    const contentWrap = doc.createElement("div");
    Object.assign(contentWrap.style, {
      padding: "16px 18px",
      display: "flex",
      flexDirection: "column",
      gap: "12px",
    });

    if (input.branchFlow) {
      const flowBox = doc.createElement("div");
      Object.assign(flowBox.style, {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "8px",
        padding: "10px 12px",
        borderRadius: "8px",
        backgroundColor: "#11141a",
        border: "1px solid #2e3440",
        flexWrap: "wrap",
      });

      const makeBranchPill = (branch: string, highlight: boolean) => {
        const pill = doc.createElement("span");
        pill.textContent = `⎇ ${branch}`;
        Object.assign(pill.style, {
          display: "inline-flex",
          alignItems: "center",
          padding: "4px 10px",
          borderRadius: "6px",
          fontSize: "12px",
          fontWeight: "700",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
          backgroundColor: highlight ? "rgba(16, 185, 129, 0.16)" : "rgba(6, 182, 212, 0.14)",
          color: highlight ? "#10b981" : "#06b6d4",
          border: `1px solid ${highlight ? "rgba(16, 185, 129, 0.45)" : "rgba(6, 182, 212, 0.4)"}`,
        });
        return pill;
      };

      const arrowWrap = doc.createElement("span");
      arrowWrap.textContent = input.branchFlow.actionLabel
        ? `── ${input.branchFlow.actionLabel} ──►`
        : "────►";
      Object.assign(arrowWrap.style, {
        fontSize: "11px",
        fontWeight: "700",
        color: "#94a3b8",
        letterSpacing: "0.4px",
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
        gap: "6px",
        flexWrap: "wrap",
      });
      for (const b of input.badges) {
        const palette = resolveBadgePalette(b.tone);
        const chip = doc.createElement("span");
        chip.textContent = b.label;
        Object.assign(chip.style, {
          padding: "3px 8px",
          borderRadius: "5px",
          fontSize: "11px",
          fontWeight: "600",
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
      fontSize: "13px",
      lineHeight: "1.55",
      color: "#cbd5e1",
      whiteSpace: "pre-wrap",
      wordBreak: "break-word",
    });
    contentWrap.appendChild(body);

    const footer = doc.createElement("div");
    Object.assign(footer.style, {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: "8px",
      padding: "12px 18px",
      backgroundColor: "#15181e",
      borderTop: "1px solid #2e3440",
    });

    const shortcutHint = doc.createElement("span");
    shortcutHint.textContent = "Esc: Huỷ · Enter: Xác nhận";
    Object.assign(shortcutHint.style, {
      fontSize: "11px",
      color: "#64748b",
    });

    const btnGroup = doc.createElement("div");
    Object.assign(btnGroup.style, {
      display: "flex",
      alignItems: "center",
      gap: "8px",
    });

    const cancelBtn = doc.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = labels.cancelLabel;
    cancelBtn.setAttribute("data-testid", "paseo-confirm-dialog-cancel");
    Object.assign(cancelBtn.style, {
      padding: "6px 14px",
      borderRadius: "6px",
      border: "1px solid #3b4252",
      backgroundColor: "#242933",
      color: "#e2e8f0",
      fontSize: "12px",
      fontWeight: "600",
      cursor: "pointer",
    });

    const confirmBtn = doc.createElement("button");
    confirmBtn.type = "button";
    confirmBtn.textContent = labels.confirmLabel;
    confirmBtn.setAttribute("data-testid", "paseo-confirm-dialog-confirm");
    Object.assign(confirmBtn.style, {
      padding: "6px 14px",
      borderRadius: "6px",
      border: `1px solid ${input.destructive ? "#f43f5e" : "#10b981"}`,
      backgroundColor: input.destructive ? "#e11d48" : "#10b981",
      color: input.destructive ? "#ffffff" : "#062319",
      fontSize: "12px",
      fontWeight: "700",
      cursor: "pointer",
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
    footer.appendChild(shortcutHint);
    footer.appendChild(btnGroup);
    card.appendChild(header);
    card.appendChild(contentWrap);
    card.appendChild(footer);
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
      backgroundColor: "rgba(0, 0, 0, 0.65)",
      backdropFilter: "blur(3px)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: "16px",
      fontFamily:
        '-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    });

    const card = doc.createElement("div");
    Object.assign(card.style, {
      width: "100%",
      maxWidth: "480px",
      backgroundColor: "#1e2229",
      border: "1px solid #10b981",
      borderRadius: "10px",
      boxShadow: "0 22px 55px rgba(0, 0, 0, 0.72)",
      color: "#e2e8f0",
      overflow: "hidden",
    });

    const header = doc.createElement("div");
    Object.assign(header.style, {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: "10px",
      padding: "14px 18px 12px 18px",
      borderBottom: "1px solid #2e3440",
      backgroundColor: "#15181e",
    });

    const headerLeft = doc.createElement("div");
    Object.assign(headerLeft.style, {
      display: "flex",
      alignItems: "center",
      gap: "10px",
    });

    const badge = doc.createElement("span");
    badge.textContent = "⊶";
    Object.assign(badge.style, {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      width: "24px",
      height: "24px",
      borderRadius: "6px",
      fontSize: "14px",
      fontWeight: "700",
      backgroundColor: "rgba(16, 185, 129, 0.18)",
      color: "#10b981",
      border: "1px solid rgba(16, 185, 129, 0.45)",
    });

    const titleEl = doc.createElement("div");
    titleEl.textContent = "Confirm Git Commit";
    Object.assign(titleEl.style, {
      fontSize: "14px",
      fontWeight: "700",
      color: "#f8fafc",
    });

    headerLeft.appendChild(badge);
    headerLeft.appendChild(titleEl);

    const branchPill = doc.createElement("span");
    branchPill.textContent = `⎇ ${input.branchName}`;
    Object.assign(branchPill.style, {
      padding: "3px 9px",
      borderRadius: "6px",
      fontSize: "12px",
      fontWeight: "700",
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      color: "#10b981",
      backgroundColor: "rgba(16, 185, 129, 0.14)",
      border: "1px solid rgba(16, 185, 129, 0.45)",
    });

    header.appendChild(headerLeft);
    header.appendChild(branchPill);

    const body = doc.createElement("div");
    Object.assign(body.style, {
      padding: "16px 18px",
      display: "flex",
      flexDirection: "column",
      gap: "12px",
    });

    const statRow = doc.createElement("div");
    Object.assign(statRow.style, {
      display: "flex",
      alignItems: "center",
      gap: "8px",
      flexWrap: "wrap",
      fontSize: "12px",
      color: "#94a3b8",
    });
    const statLabel = doc.createElement("span");
    statLabel.textContent = "Stage toàn bộ thay đổi hiện tại và tạo commit mới trên nhánh ";
    const statBranch = doc.createElement("strong");
    statBranch.textContent = input.branchName;
    statBranch.style.color = "#f8fafc";
    statRow.appendChild(statLabel);
    statRow.appendChild(statBranch);

    if (input.diffStat && (input.diffStat.additions > 0 || input.diffStat.deletions > 0)) {
      const diffBadge = doc.createElement("span");
      diffBadge.textContent = `+${input.diffStat.additions} / -${input.diffStat.deletions}`;
      Object.assign(diffBadge.style, {
        padding: "2px 7px",
        borderRadius: "5px",
        fontSize: "11px",
        fontWeight: "600",
        color: "#06b6d4",
        backgroundColor: "rgba(6, 182, 212, 0.14)",
        border: "1px solid rgba(6, 182, 212, 0.4)",
      });
      statRow.appendChild(diffBadge);
    }
    body.appendChild(statRow);

    const textareaLabel = doc.createElement("div");
    textareaLabel.textContent = "Commit Message (Để trống để AI tự động sinh commit message):";
    Object.assign(textareaLabel.style, {
      fontSize: "12px",
      fontWeight: "600",
      color: "#cbd5e1",
    });
    body.appendChild(textareaLabel);

    const textarea = doc.createElement("textarea");
    textarea.value = input.initialMessage ?? "";
    textarea.placeholder =
      "Nhập nội dung commit tại đây, hoặc để trống để AI tự phân tích diff & tạo commit message...";
    textarea.rows = 4;
    textarea.setAttribute("data-testid", "paseo-confirm-commit-message-input");
    Object.assign(textarea.style, {
      width: "100%",
      boxSizing: "border-box",
      padding: "10px 12px",
      borderRadius: "7px",
      border: "1px solid #3b4252",
      backgroundColor: "#11141a",
      color: "#f8fafc",
      fontSize: "13px",
      lineHeight: "1.45",
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      resize: "vertical",
      outline: "none",
    });
    body.appendChild(textarea);

    const optionsRow = doc.createElement("div");
    Object.assign(optionsRow.style, {
      display: "flex",
      alignItems: "center",
      gap: "10px",
      flexWrap: "wrap",
    });

    const createOptionToggle = (
      label: string,
      active: boolean,
      activeColor: string,
      onToggle: () => void,
    ) => {
      const btn = doc.createElement("button");
      btn.type = "button";
      const renderStyle = (isActive: boolean) => {
        btn.textContent = `${isActive ? "✓ " : ""}${label}`;
        Object.assign(btn.style, {
          padding: "5px 10px",
          borderRadius: "6px",
          fontSize: "12px",
          fontWeight: "600",
          cursor: "pointer",
          border: `1px solid ${isActive ? activeColor : "#3b4252"}`,
          backgroundColor: isActive ? "rgba(16, 185, 129, 0.14)" : "#15181e",
          color: isActive ? activeColor : "#94a3b8",
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

    const amendToggle = createOptionToggle("Amend previous commit", amendState, "#f59e0b", () => {
      amendState = !amendState;
      amendToggle.renderStyle(amendState);
      updateConfirmButtonText();
    });

    const pushToggle = createOptionToggle(
      "Push to remote after commit",
      pushState,
      "#06b6d4",
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

    const footer = doc.createElement("div");
    Object.assign(footer.style, {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: "8px",
      padding: "12px 18px",
      backgroundColor: "#15181e",
      borderTop: "1px solid #2e3440",
    });

    const shortcutHint = doc.createElement("span");
    shortcutHint.textContent = "Esc: Huỷ · ⌘+Enter: Commit";
    Object.assign(shortcutHint.style, {
      fontSize: "11px",
      color: "#64748b",
    });

    const btnGroup = doc.createElement("div");
    Object.assign(btnGroup.style, {
      display: "flex",
      alignItems: "center",
      gap: "8px",
    });

    const cancelBtn = doc.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = "Cancel";
    cancelBtn.setAttribute("data-testid", "paseo-confirm-commit-cancel");
    Object.assign(cancelBtn.style, {
      padding: "6px 14px",
      borderRadius: "6px",
      border: "1px solid #3b4252",
      backgroundColor: "#242933",
      color: "#e2e8f0",
      fontSize: "12px",
      fontWeight: "600",
      cursor: "pointer",
    });

    Object.assign(confirmBtn.style, {
      padding: "6px 16px",
      borderRadius: "6px",
      border: "1px solid #10b981",
      backgroundColor: "#10b981",
      color: "#062319",
      fontSize: "12px",
      fontWeight: "700",
      cursor: "pointer",
    });
    updateConfirmButtonText();

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
    footer.appendChild(shortcutHint);
    footer.appendChild(btnGroup);
    card.appendChild(header);
    card.appendChild(body);
    card.appendChild(footer);
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
