import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Shared helpers for the P4 golden fixture capture scripts
 * (`capture-*-fixtures.ts`). Output is deterministic: no wall clock, no random
 * uuids, stable key order, trailing newline.
 *
 * Usage: tsx scripts/capture-<area>-fixtures.ts --out <fixtures/p4 dir>
 * (or P4_FIXTURES_OUT=<dir>)
 */

export const FIXTURE_BASE_MS = Date.parse("2026-01-01T00:00:00.000Z");

export function tsAt(offsetMs: number): string {
  return new Date(FIXTURE_BASE_MS + offsetMs).toISOString();
}

export function resolveOutRoot(argv: readonly string[] = process.argv.slice(2)): string {
  const index = argv.indexOf("--out");
  const fromArg = index >= 0 ? argv[index + 1] : undefined;
  const root = fromArg ?? process.env.P4_FIXTURES_OUT;
  if (!root) {
    throw new Error("Pass --out <fixtures/p4 dir> or set P4_FIXTURES_OUT");
  }
  return path.resolve(root);
}

export function areaDir(root: string, area: string): string {
  const dir = path.join(root, area);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeJson(dir: string, name: string, value: unknown): void {
  mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
  writeFileSync(path.join(dir, name), `${JSON.stringify(value, null, 2)}\n`);
}

export function writeJsonl(dir: string, name: string, values: readonly unknown[]): void {
  mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
  writeFileSync(
    path.join(dir, name),
    values.map((value) => JSON.stringify(value)).join("\n") + (values.length ? "\n" : ""),
  );
}

/** Small deterministic PRNG (mulberry32). */
export function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- Long-string generators -------------------------------------------------
// Goldens that need 64 KiB strings describe them as generators so the fixture
// stays small; Rust expands the same descriptor and compares a digest.

export interface StringGen {
  parts: Array<{ unit: string; count: number }>;
}

export interface StringSummary {
  length16: number;
  sha256Utf16le: string;
  tail16Hex: string[];
}

export function expandGen(gen: StringGen): string {
  return gen.parts.map((part) => part.unit.repeat(part.count)).join("");
}

export function summarizeString(value: string): StringSummary {
  const tail: string[] = [];
  for (let i = Math.max(0, value.length - 8); i < value.length; i += 1) {
    tail.push(value.charCodeAt(i).toString(16).padStart(4, "0"));
  }
  return {
    length16: value.length,
    sha256Utf16le: createHash("sha256").update(Buffer.from(value, "utf16le")).digest("hex"),
    tail16Hex: tail,
  };
}

export function expandGenerators(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(expandGenerators);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if ("$gen" in record && Object.keys(record).length === 1) {
      return expandGen(record.$gen as StringGen);
    }
    return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, expandGenerators(v)]));
  }
  return value;
}

/** Replace every string longer than `threshold` UTF-16 units by its summary. */
export function summarizeLongStrings(value: unknown, threshold = 1024): unknown {
  if (typeof value === "string") {
    return value.length > threshold ? { $str: summarizeString(value) } : value;
  }
  if (Array.isArray(value)) return value.map((entry) => summarizeLongStrings(entry, threshold));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        summarizeLongStrings(v, threshold),
      ]),
    );
  }
  return value;
}

export function errorSummary(error: unknown): { name: string; message: string } {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "NonError", message: String(error) };
}

// --- Rust-crate provider fixtures (inputs for the mapper / provider-event captures) ---

import { readFileSync } from "node:fs";

/** crates/ dir of the paseo-rs repo, derived from <repo>/fixtures/p4 (override: P4_CRATES_DIR). */
export function resolveCratesDir(root: string): string {
  return process.env.P4_CRATES_DIR
    ? path.resolve(process.env.P4_CRATES_DIR)
    : path.resolve(root, "..", "..", "crates");
}

export function readJsonl(file: string): unknown[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

// --- determinism for full-adapter replays -------------------------------------------------

import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";

/**
 * Replace randomUUID with a counter and Date with a clock that advances 1 ms per
 * observation. Call before importing adapters is NOT required: crypto's named
 * exports are re-synced and Date is swapped globally.
 */
export function installDeterminism(options: { baseMs?: number } = {}): {
  resetUuids(): void;
  restore(): void;
} {
  let uuidCounter = 0;
  const realRandomUuid = crypto.randomUUID;
  const RealDate = Date;
  let tick = 0;
  const base = options.baseMs ?? Date.parse("2026-01-01T00:00:00.000Z");
  (crypto as unknown as { randomUUID: () => string }).randomUUID = () => {
    uuidCounter += 1;
    return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, "0")}`;
  };
  syncBuiltinESMExports();
  class FixedDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) {
        tick += 1;
        super(base + tick);
      } else {
        super(...(args as [number]));
      }
    }
    static override now(): number {
      tick += 1;
      return base + tick;
    }
  }
  globalThis.Date = FixedDate as unknown as DateConstructor;
  return {
    resetUuids() {
      uuidCounter = 0;
      tick = 0;
    },
    restore() {
      (crypto as unknown as { randomUUID: unknown }).randomUUID = realRandomUuid;
      syncBuiltinESMExports();
      globalThis.Date = RealDate;
    },
  };
}

export const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
export async function settle(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) await tick();
}
