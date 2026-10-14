import { useQuery } from "@tanstack/react-query";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { isWeb } from "@/constants/platform";
import { getDesktopHost, type DesktopEditorBridge } from "@/desktop/host";
import { useSessionStore } from "@/stores/session-store";

export type DesktopOpenTargetKind = "editor" | "file-manager";
export type DesktopOpenTargetIcon =
  | { kind: "image"; dataUrl: string }
  | { kind: "symbol"; name: "folder" | "terminal" };

export interface DesktopOpenTarget {
  id: string;
  label: string;
  kind: DesktopOpenTargetKind;
  icon: DesktopOpenTargetIcon;
}

export interface OpenDesktopTargetInput {
  editorId: string;
  workspacePath: string;
  filePath?: string;
  line?: number;
  column?: number;
}

interface AvailableDesktopEditorBridge {
  listTargets: NonNullable<DesktopEditorBridge["listTargets"]>;
  openTarget: NonNullable<DesktopEditorBridge["openTarget"]>;
}

interface SelectDesktopOpenTargetsInput {
  canListTargets: boolean;
  targets: DesktopOpenTarget[] | undefined;
}

export function selectDesktopOpenTargets({
  canListTargets,
  targets,
}: SelectDesktopOpenTargetsInput): DesktopOpenTarget[] {
  if (!canListTargets) {
    return [];
  }
  return (targets ?? []).filter(
    (target) =>
      target.kind === "file-manager" ||
      isFileManagerEditorId(target.id) ||
      target.id === "vscode",
  );
}

function getDesktopEditorBridge(): AvailableDesktopEditorBridge | null {
  const bridge = getDesktopHost()?.editor;
  if (!bridge?.listTargets || !bridge.openTarget) {
    return null;
  }
  return {
    listTargets: bridge.listTargets,
    openTarget: bridge.openTarget,
  };
}

function getActiveDaemonClient(): DaemonClient | null {
  if (!isWeb) {
    return null;
  }
  const sessions = Object.values(useSessionStore.getState().sessions);
  for (const session of sessions) {
    if (session?.client) {
      return session.client;
    }
  }
  return null;
}

function isFileManagerEditorId(editorId: string): boolean {
  return editorId === "finder" || editorId === "explorer" || editorId === "file-manager";
}

export function hasDesktopOpenTargetsBridge(): boolean {
  return getDesktopEditorBridge() !== null;
}

export async function listDesktopOpenTargets(): Promise<DesktopOpenTarget[]> {
  const bridge = getDesktopEditorBridge();
  if (bridge) {
    return await bridge.listTargets();
  }
  const client = getActiveDaemonClient();
  if (!client) {
    return [];
  }
  const response = await client.listAvailableEditors();
  if (response.error) {
    return [];
  }
  return response.editors.map((editor) => {
    const isFileManager = isFileManagerEditorId(editor.id);
    return {
      id: editor.id,
      label: editor.label,
      kind: isFileManager ? "file-manager" : "editor",
      icon: {
        kind: "symbol",
        name: isFileManager ? "folder" : "terminal",
      },
    };
  });
}

function formatOpenTargetPath(input: OpenDesktopTargetInput, isFileManager: boolean): string {
  if (!input.filePath) {
    return input.workspacePath;
  }
  if (isFileManager || !input.line) {
    return input.filePath;
  }
  if (input.column) {
    return `${input.filePath}:${input.line}:${input.column}`;
  }
  return `${input.filePath}:${input.line}`;
}

export async function openDesktopTarget(input: OpenDesktopTargetInput): Promise<void> {
  const bridge = getDesktopEditorBridge();
  if (bridge) {
    await bridge.openTarget(input);
    return;
  }
  const client = getActiveDaemonClient();
  if (!client) {
    throw new Error("Desktop editor bridge is unavailable");
  }
  const isFileManager = isFileManagerEditorId(input.editorId);
  const pathWithLocation = formatOpenTargetPath(input, isFileManager);
  const response = await client.openInEditor({
    editorId: input.editorId,
    path: pathWithLocation,
    cwd: input.workspacePath,
    mode: isFileManager && input.filePath ? "reveal" : "open",
  });
  if (response.error) {
    throw new Error(response.error);
  }
}

export function useDesktopOpenTargets(input: { isLocalExecution: boolean }) {
  const hasBridge = hasDesktopOpenTargetsBridge();
  const hasConnectedSessionClient = useSessionStore((state) =>
    Object.values(state.sessions).some((session) => Boolean(session?.client)),
  );
  const canListTargets =
    (hasBridge || (isWeb && hasConnectedSessionClient)) && input.isLocalExecution;
  const query = useQuery({
    queryKey: ["desktop-open-targets", hasBridge ? "bridge" : "daemon"],
    enabled: canListTargets,
    staleTime: 60_000,
    retry: false,
    queryFn: listDesktopOpenTargets,
  });
  const targets = selectDesktopOpenTargets({
    canListTargets,
    targets: query.data,
  });

  return {
    targets,
    isAvailable: canListTargets,
  };
}
