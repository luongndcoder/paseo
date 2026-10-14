import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type pino from "pino";

import { spawnProcess } from "../../../../../utils/spawn.js";

const MODEL_ID = "sherpa-onnx-zipformer-vi-30M-int8-2026-02-09";
// WHY: Sherpa's converted archive includes the token table required by its ONNX runtime.
const MODEL_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${MODEL_ID}.tar.bz2`;
const MODEL_SHA256 = "da8b637947091829d7ee9eda23da2a4ec7caa399233a3f4e34eb719fb2ea6b9b";
const REQUIRED_FILES = ["encoder.int8.onnx", "decoder.onnx", "joiner.int8.onnx", "tokens.txt"];

function modelDirectory(modelsDir: string): string {
  return path.join(modelsDir, MODEL_ID);
}

async function hasRequiredFiles(directory: string): Promise<boolean> {
  const files = await Promise.all(
    REQUIRED_FILES.map(async (filename) => {
      try {
        const info = await stat(path.join(directory, filename));
        return info.isFile() && info.size > 0;
      } catch {
        return false;
      }
    }),
  );
  return files.every(Boolean);
}

export async function isVietnameseDictationModelInstalled(modelsDir: string): Promise<boolean> {
  return hasRequiredFiles(modelDirectory(modelsDir));
}

async function downloadArchive(
  url: string,
  outputPath: string,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(url, { signal });
  if (!response.ok || !response.body) {
    throw new Error(
      `Failed to download Vietnamese speech model: ${response.status} ${response.statusText}`,
    );
  }
  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.tmp-${process.pid}`;
  try {
    await pipeline(
      Readable.fromWeb(response.body as never),
      createWriteStream(temporaryPath, { flags: "wx" }),
      { signal },
    );
    await rename(temporaryPath, outputPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function extractArchive(archivePath: string, destination: string, signal?: AbortSignal) {
  await mkdir(destination, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const child = spawnProcess("tar", ["xf", archivePath, "-C", destination], {
      stdio: "ignore",
      signal,
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Vietnamese speech model extraction failed (tar exited ${code})`));
    });
  });
}

export async function ensureVietnameseDictationModel(options: {
  modelsDir: string;
  logger: pino.Logger;
  signal?: AbortSignal;
}): Promise<string> {
  const { modelsDir, logger, signal } = options;
  const targetDirectory = modelDirectory(modelsDir);
  if (await hasRequiredFiles(targetDirectory)) return targetDirectory;

  const downloadsDirectory = path.join(modelsDir, ".downloads");
  const archivePath = path.join(downloadsDirectory, `${MODEL_ID}.tar.bz2`);
  const extractionPath = path.join(downloadsDirectory, `${MODEL_ID}.extracting-${process.pid}`);
  const extractedModelPath = path.join(extractionPath, MODEL_ID);
  logger.info({ modelId: MODEL_ID, modelsDir }, "Downloading Vietnamese dictation model");

  try {
    await mkdir(downloadsDirectory, { recursive: true });
    try {
      const archiveStat = await stat(archivePath);
      if (!archiveStat.isFile() || archiveStat.size === 0) {
        await rm(archivePath, { force: true });
        await downloadArchive(MODEL_URL, archivePath, signal);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await downloadArchive(MODEL_URL, archivePath, signal);
    }

    const archive = await readFile(archivePath);
    const archiveSha256 = createHash("sha256").update(archive).digest("hex");
    if (archiveSha256 !== MODEL_SHA256) {
      await rm(archivePath, { force: true });
      throw new Error("Downloaded Vietnamese speech model failed SHA-256 verification");
    }

    await rm(extractionPath, { recursive: true, force: true });
    await extractArchive(archivePath, extractionPath, signal);
    if (!(await hasRequiredFiles(extractedModelPath))) {
      throw new Error(
        `Vietnamese model archive is missing required files: ${REQUIRED_FILES.join(", ")}`,
      );
    }

    await rm(targetDirectory, { recursive: true, force: true });
    await rename(extractedModelPath, targetDirectory);
    await rm(archivePath, { force: true });
    return targetDirectory;
  } catch (error) {
    await rm(archivePath, { force: true }).catch(() => undefined);
    logger.error({ err: error, modelId: MODEL_ID }, "Vietnamese dictation model download failed");
    throw error;
  } finally {
    await rm(extractionPath, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function getVietnameseDictationModelDirectory(modelsDir: string): string {
  return modelDirectory(modelsDir);
}
