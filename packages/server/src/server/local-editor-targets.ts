import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute } from "node:path";

export interface LocalDaemonEditorTargetDescriptor {
  id: string;
  label: string;
}

export interface OpenLocalDaemonEditorTargetInput {
  editorId: string;
  path: string;
  cwd?: string;
  mode?: "open" | "reveal";
}

interface EditorTargetSpec {
  id: string;
  label: string;
  commands: readonly string[];
  macAppName?: string;
  macAppBinRelativePath?: string;
  gotoFlag?: "--goto" | "zed-line";
}

const EDITOR_SPECS: readonly EditorTargetSpec[] = [
  {
    id: "vscode",
    label: "VS Code",
    commands: ["code"],
    macAppName: "Visual Studio Code",
    macAppBinRelativePath: "Contents/Resources/app/bin/code",
    gotoFlag: "--goto",
  },
];

function resolveCommandInPath(
  commands: readonly string[],
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const pathValue = env.PATH ?? env.Path ?? env.path ?? "";
  const delimiter = platform === "win32" ? ";" : ":";
  for (const command of commands) {
    if (isAbsolute(command) && existsSync(command)) {
      return command;
    }
    for (const dir of pathValue.split(delimiter)) {
      if (!dir) continue;
      const candidate = `${dir}/${command}`;
      if (platform !== "win32") {
        if (existsSync(candidate)) return candidate;
        continue;
      }
      for (const ext of [".exe", ".cmd", ".bat", ".com", ""]) {
        if (existsSync(`${candidate}${ext}`)) {
          return `${candidate}${ext}`;
        }
      }
    }
  }
  return null;
}

function resolveMacAppBundlePath(appName: string): string | null {
  if (process.platform !== "darwin") return null;
  const home = homedir();
  const candidates = [
    `/Applications/${appName}.app`,
    `${home}/Applications/${appName}.app`,
    `/System/Applications/${appName}.app`,
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function resolveEditorExecutable(spec: EditorTargetSpec): string | null {
  const fromPath = resolveCommandInPath(spec.commands);
  if (fromPath) return fromPath;
  if (process.platform === "darwin" && spec.macAppName && spec.macAppBinRelativePath) {
    const bundlePath = resolveMacAppBundlePath(spec.macAppName);
    if (bundlePath) {
      const binPath = `${bundlePath}/${spec.macAppBinRelativePath}`;
      if (existsSync(binPath)) {
        return binPath;
      }
    }
  }
  return null;
}

function isEditorInstalled(spec: EditorTargetSpec): boolean {
  if (resolveEditorExecutable(spec) !== null) {
    return true;
  }
  if (process.platform === "darwin" && spec.macAppName) {
    return resolveMacAppBundlePath(spec.macAppName) !== null;
  }
  return false;
}

function getFileManagerDescriptor(
  platform: NodeJS.Platform = process.platform,
): LocalDaemonEditorTargetDescriptor {
  if (platform === "darwin") {
    return { id: "finder", label: "Finder" };
  }
  if (platform === "win32") {
    return { id: "explorer", label: "Explorer" };
  }
  return { id: "file-manager", label: "Files" };
}

export function listLocalDaemonEditorTargets(): LocalDaemonEditorTargetDescriptor[] {
  const targets: LocalDaemonEditorTargetDescriptor[] = [];
  for (const spec of EDITOR_SPECS) {
    if (isEditorInstalled(spec)) {
      targets.push({ id: spec.id, label: spec.label });
    }
  }
  targets.push(getFileManagerDescriptor());
  return targets;
}

function parsePathWithLineColumn(rawPath: string): {
  filePath: string;
  line?: number;
  column?: number;
} {
  const trimmed = rawPath.trim();
  if (existsSync(trimmed)) {
    return { filePath: trimmed };
  }
  const match = /^(.*):(\d+)(?::(\d+))?$/u.exec(trimmed);
  if (match && match[1] && existsSync(match[1])) {
    const line = Number.parseInt(match[2], 10);
    const column = match[3] ? Number.parseInt(match[3], 10) : undefined;
    return {
      filePath: match[1],
      ...(Number.isFinite(line) && line > 0 ? { line } : {}),
      ...(column !== undefined && Number.isFinite(column) && column > 0 ? { column } : {}),
    };
  }
  return { filePath: trimmed };
}

async function spawnDetachedCommand(command: string, args: readonly string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let child;
    try {
      child = spawn(command, [...args], {
        detached: true,
        stdio: "ignore",
      });
    } catch (error) {
      reject(error);
      return;
    }
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function assertExistingAbsolutePath(targetPath: string, errorLabel: string): void {
  if (!isAbsolute(targetPath)) {
    throw new Error(`${errorLabel} must be an absolute local path`);
  }
  if (!existsSync(targetPath)) {
    throw new Error(`Path does not exist: ${targetPath}`);
  }
}

function formatTargetLocation(parsed: {
  filePath: string;
  line?: number;
  column?: number;
}): string {
  if (!parsed.line) {
    return parsed.filePath;
  }
  if (parsed.column) {
    return `${parsed.filePath}:${parsed.line}:${parsed.column}`;
  }
  return `${parsed.filePath}:${parsed.line}`;
}

async function openFileManagerTarget(targetPath: string, reveal: boolean): Promise<void> {
  if (process.platform === "darwin") {
    await spawnDetachedCommand("/usr/bin/open", reveal ? ["-R", targetPath] : [targetPath]);
    return;
  }
  if (process.platform === "win32") {
    await spawnDetachedCommand("explorer.exe", reveal ? [`/select,${targetPath}`] : [targetPath]);
    return;
  }
  await spawnDetachedCommand("xdg-open", [reveal ? dirname(targetPath) : targetPath]);
}

function buildEditorCliArgs(input: {
  spec: EditorTargetSpec;
  targetPath: string;
  workspaceCwd?: string;
  line?: number;
  locationWithLine: string;
}): string[] {
  const args: string[] = [];
  if (input.workspaceCwd && input.workspaceCwd !== input.targetPath) {
    args.push(input.workspaceCwd);
  }
  if (input.spec.gotoFlag === "--goto" && input.line) {
    args.push("--goto", input.locationWithLine);
  } else if (input.spec.gotoFlag === "zed-line" && input.line) {
    args.push(input.locationWithLine);
  } else {
    args.push(input.targetPath);
  }
  return args;
}

export async function openInLocalDaemonEditorTarget(
  input: OpenLocalDaemonEditorTargetInput,
): Promise<void> {
  const parsed = parsePathWithLineColumn(input.path);
  const targetPath = parsed.filePath;
  assertExistingAbsolutePath(targetPath, "Editor target path");

  const workspaceCwd = input.cwd?.trim();
  if (workspaceCwd) {
    assertExistingAbsolutePath(workspaceCwd, "Editor target workspace path");
  }

  const editorId = input.editorId.trim();
  if (editorId === "finder" || editorId === "explorer" || editorId === "file-manager") {
    await openFileManagerTarget(targetPath, input.mode === "reveal");
    return;
  }

  const spec = EDITOR_SPECS.find((candidate) => candidate.id === editorId);
  if (!spec) {
    throw new Error(`Unknown editor target: ${editorId}`);
  }

  const executable = resolveEditorExecutable(spec);
  if (executable) {
    const args = buildEditorCliArgs({
      spec,
      targetPath,
      workspaceCwd,
      line: parsed.line,
      locationWithLine: formatTargetLocation(parsed),
    });
    await spawnDetachedCommand(executable, args);
    return;
  }

  if (
    process.platform === "darwin" &&
    spec.macAppName &&
    resolveMacAppBundlePath(spec.macAppName)
  ) {
    const openPaths =
      workspaceCwd && workspaceCwd !== targetPath ? [workspaceCwd, targetPath] : [targetPath];
    await spawnDetachedCommand("/usr/bin/open", ["-a", spec.macAppName, ...openPaths]);
    return;
  }

  throw new Error(`Editor target unavailable: ${spec.label}`);
}
