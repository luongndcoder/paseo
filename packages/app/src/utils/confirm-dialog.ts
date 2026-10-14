import { Alert } from "react-native";
import { getDesktopHost, type DesktopDialogAskOptions } from "@/desktop/host";
import { isNative } from "@/constants/platform";

export interface ConfirmDialogInput {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
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

async function showNativeConfirmDialog(input: ConfirmDialogInput): Promise<boolean> {
  const labels = resolveButtonLabels(input);

  return new Promise<boolean>((resolve) => {
    Alert.alert(
      input.title,
      input.message,
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
      backgroundColor: "rgba(0, 0, 0, 0.62)",
      backdropFilter: "blur(2px)",
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
      maxWidth: "440px",
      backgroundColor: "#2b2d30",
      border: `1px solid ${input.destructive ? "#c75450" : "#43454a"}`,
      borderRadius: "8px",
      boxShadow: "0 20px 50px rgba(0, 0, 0, 0.65)",
      color: "#dfe1e5",
      overflow: "hidden",
    });

    const header = doc.createElement("div");
    Object.assign(header.style, {
      display: "flex",
      alignItems: "center",
      gap: "10px",
      padding: "14px 18px 10px 18px",
      borderBottom: "1px solid #393b40",
      backgroundColor: "#1e1f22",
    });

    const badge = doc.createElement("span");
    badge.textContent = input.destructive ? "!" : "?";
    Object.assign(badge.style, {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      width: "22px",
      height: "22px",
      borderRadius: "50%",
      fontSize: "13px",
      fontWeight: "700",
      flexShrink: "0",
      backgroundColor: input.destructive ? "rgba(229, 72, 77, 0.18)" : "rgba(53, 116, 240, 0.18)",
      color: input.destructive ? "#f75464" : "#589df6",
      border: `1px solid ${input.destructive ? "rgba(229, 72, 77, 0.45)" : "rgba(53, 116, 240, 0.45)"}`,
    });

    const titleEl = doc.createElement("div");
    titleEl.textContent = input.title;
    Object.assign(titleEl.style, {
      fontSize: "14px",
      fontWeight: "600",
      color: "#dfe1e5",
      lineHeight: "1.35",
    });

    header.appendChild(badge);
    header.appendChild(titleEl);

    const body = doc.createElement("div");
    body.textContent = input.message;
    Object.assign(body.style, {
      padding: "16px 18px",
      fontSize: "13px",
      lineHeight: "1.55",
      color: "#b4b8c2",
      whiteSpace: "pre-wrap",
      wordBreak: "break-word",
    });

    const footer = doc.createElement("div");
    Object.assign(footer.style, {
      display: "flex",
      alignItems: "center",
      justifyContent: "flex-end",
      gap: "8px",
      padding: "12px 18px",
      backgroundColor: "#1e1f22",
      borderTop: "1px solid #393b40",
    });

    const cancelBtn = doc.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = labels.cancelLabel;
    cancelBtn.setAttribute("data-testid", "paseo-confirm-dialog-cancel");
    Object.assign(cancelBtn.style, {
      padding: "6px 14px",
      borderRadius: "5px",
      border: "1px solid #4e5157",
      backgroundColor: "#2b2d30",
      color: "#dfe1e5",
      fontSize: "12px",
      fontWeight: "500",
      cursor: "pointer",
    });

    const confirmBtn = doc.createElement("button");
    confirmBtn.type = "button";
    confirmBtn.textContent = labels.confirmLabel;
    confirmBtn.setAttribute("data-testid", "paseo-confirm-dialog-confirm");
    Object.assign(confirmBtn.style, {
      padding: "6px 14px",
      borderRadius: "5px",
      border: `1px solid ${input.destructive ? "#e5484d" : "#3574f0"}`,
      backgroundColor: input.destructive ? "#c73a3f" : "#3574f0",
      color: "#ffffff",
      fontSize: "12px",
      fontWeight: "600",
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

    footer.appendChild(cancelBtn);
    footer.appendChild(confirmBtn);
    card.appendChild(header);
    card.appendChild(body);
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

export const __private__ = {
  blurActiveWebElement,
  buildDesktopAskOptions,
};
