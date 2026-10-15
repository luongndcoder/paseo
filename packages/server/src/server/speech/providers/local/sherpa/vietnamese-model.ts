import { createWriteStream, existsSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type pino from "pino";

export const NEMOTRON_MODEL_ID = "nemotron-3.5-560ms-int8";
export const VIETNAMESE_SHERPA_MODEL_DIR_NAME = NEMOTRON_MODEL_ID;

const HF_NEMOTRON_REPO =
  "csukuangfj2/sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-560ms-int8-2026-06-11";
const HF_NEMOTRON_BASE_URL = `https://huggingface.co/${HF_NEMOTRON_REPO}/resolve/main`;

const REQUIRED_NEMOTRON_FILES = [
  "tokens.txt",
  "decoder.int8.onnx",
  "joiner.int8.onnx",
  "encoder.int8.onnx",
] as const;

export interface VietnameseSherpaModelFiles {
  modelDir: string;
  encoderPath: string;
  decoderPath: string;
  joinerPath: string;
  tokensPath: string;
}

function getCandidateNemotronDirs(modelsDir?: string | null): string[] {
  const candidates = [
    process.env.PASEO_NEMOTRON_MODEL_DIR?.trim(),
    process.env.VOICESCRIBE_NEMOTRON_DIR?.trim(),
    process.env.PASEO_VIETNAMESE_MODEL_DIR?.trim(),
    path.join(os.homedir(), ".voicescribe", "models", NEMOTRON_MODEL_ID),
    modelsDir ? path.join(modelsDir, NEMOTRON_MODEL_ID) : undefined,
    path.join(os.homedir(), ".paseo", "models", "local-speech", NEMOTRON_MODEL_ID),
  ].filter((value): value is string => Boolean(value && value.length > 0));

  return Array.from(new Set(candidates.map((dir) => path.resolve(dir))));
}

function resolveFromDirSync(dir: string): VietnameseSherpaModelFiles | null {
  const encoderPath = path.join(dir, "encoder.int8.onnx");
  const decoderPath = path.join(dir, "decoder.int8.onnx");
  const joinerPath = path.join(dir, "joiner.int8.onnx");
  const tokensPath = path.join(dir, "tokens.txt");

  for (const filePath of [encoderPath, decoderPath, joinerPath, tokensPath]) {
    try {
      const stat = statSync(filePath);
      if (!stat.isFile() || stat.size === 0) {
        return null;
      }
    } catch {
      return null;
    }
  }

  return {
    modelDir: dir,
    encoderPath,
    decoderPath,
    joinerPath,
    tokensPath,
  };
}

export function resolveInstalledNemotronModelSync(
  modelsDir?: string | null,
): VietnameseSherpaModelFiles | null {
  for (const dir of getCandidateNemotronDirs(modelsDir)) {
    const resolved = resolveFromDirSync(dir);
    if (resolved) {
      return resolved;
    }
  }
  return null;
}

export function isNemotronModelInstalledSync(modelsDir?: string | null): boolean {
  return resolveInstalledNemotronModelSync(modelsDir) !== null;
}

export async function isVietnameseDictationModelInstalled(modelsDir: string): Promise<boolean> {
  return isNemotronModelInstalledSync(modelsDir);
}

export function getVietnameseDictationModelDirectory(modelsDir: string): string {
  const installed = resolveInstalledNemotronModelSync(modelsDir);
  if (installed) {
    return installed.modelDir;
  }
  return path.join(modelsDir, NEMOTRON_MODEL_ID);
}

async function downloadFileToPath(
  url: string,
  targetPath: string,
  signal?: AbortSignal,
): Promise<void> {
  const tmpPath = `${targetPath}.part-${process.pid}-${Date.now()}`;
  const response = await fetch(url, { redirect: "follow", signal });
  if (!response.ok || !response.body) {
    throw new Error(`HTTP ${response.status} ${response.statusText} while downloading ${url}`);
  }
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const nodeStream = Readable.fromWeb(response.body as never);
  try {
    await pipeline(nodeStream, createWriteStream(tmpPath), { signal });
    await fs.rename(tmpPath, targetPath);
  } catch (error) {
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function ensureVietnameseSherpaModel(
  modelsDir: string,
  logger: pino.Logger,
  signal?: AbortSignal,
): Promise<VietnameseSherpaModelFiles> {
  const log = logger.child({
    component: "nemotron-sherpa-model",
    model: NEMOTRON_MODEL_ID,
  });

  const existing = resolveInstalledNemotronModelSync(modelsDir);
  if (existing) {
    log.info(
      { modelDir: existing.modelDir },
      "Resolved installed NVIDIA Nemotron 3.5 ASR model on disk",
    );
    return existing;
  }

  const targetDir = path.join(path.resolve(modelsDir), NEMOTRON_MODEL_ID);
  await fs.mkdir(targetDir, { recursive: true });

  log.info(
    { targetDir, repo: HF_NEMOTRON_REPO },
    "Downloading NVIDIA Nemotron 3.5 ASR model files from HuggingFace",
  );

  for (const fileName of REQUIRED_NEMOTRON_FILES) {
    const destPath = path.join(targetDir, fileName);
    if (existsSync(destPath)) {
      try {
        const stat = await fs.stat(destPath);
        if (stat.isFile() && stat.size > 0) {
          continue;
        }
      } catch {
        // continue to download
      }
    }
    const url = `${HF_NEMOTRON_BASE_URL}/${fileName}`;
    log.info({ fileName, url }, "Downloading Nemotron 3.5 model file");
    await downloadFileToPath(url, destPath, signal);
  }

  const resolved = resolveFromDirSync(targetDir);
  if (!resolved) {
    throw new Error(
      `Nemotron 3.5 model download completed at ${targetDir}, but required ONNX files were not found`,
    );
  }

  log.info({ modelDir: resolved.modelDir }, "Nemotron 3.5 ASR model ready");
  return resolved;
}

export async function ensureVietnameseDictationModel(options: {
  modelsDir: string;
  logger: pino.Logger;
  signal?: AbortSignal;
}): Promise<string> {
  const resolved = await ensureVietnameseSherpaModel(
    options.modelsDir,
    options.logger,
    options.signal,
  );
  return resolved.modelDir;
}
