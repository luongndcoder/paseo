import fs from "node:fs";
import path from "node:path";
import pino from "pino";
import { describe, expect, it } from "vitest";

import {
  collapseRepeats,
  normalizeNemotronLanguage,
  SherpaOnlineNemotronEngine,
  SherpaOnlineNemotronSTT,
} from "./sherpa-online-nemotron-stt.js";
import {
  isVietnameseDictationModelInstalled,
  resolveInstalledNemotronModelSync,
} from "./vietnamese-model.js";

describe("sherpa-online-nemotron-stt helpers", () => {
  it("collapses consecutive repeated words and 2-word phrases", () => {
    expect(collapseRepeats("xin xin chào các bạn")).toBe("xin chào các bạn");
    expect(collapseRepeats("hôm nay hôm nay trời đẹp")).toBe("hôm nay trời đẹp");
    expect(collapseRepeats("bình thường không lặp")).toBe("bình thường không lặp");
  });

  it("normalizes BCP-47 language tags to Nemotron language codes", () => {
    expect(normalizeNemotronLanguage("vi-VN")).toBe("vi");
    expect(normalizeNemotronLanguage("en-US")).toBe("en");
    expect(normalizeNemotronLanguage("ja-JP")).toBe("ja");
    expect(normalizeNemotronLanguage(undefined)).toBe("vi");
    expect(normalizeNemotronLanguage("")).toBe("vi");
  });
});

describe("SherpaOnlineNemotronSTT integration with installed Nemotron 3.5 ASR model", () => {
  const resolved = resolveInstalledNemotronModelSync();
  const testWavPath = resolved ? path.join(resolved.modelDir, "test_wavs", "vi.wav") : null;
  const hasInstalledModelAndWav = Boolean(resolved && testWavPath && fs.existsSync(testWavPath));

  it.skipIf(!hasInstalledModelAndWav)(
    "discovers installed Scribble Nemotron 3.5 model and transcribes Vietnamese WAV via streaming session and single-shot API",
    async () => {
      expect(await isVietnameseDictationModelInstalled(resolved!.modelDir)).toBe(true);

      const logger = pino({ level: "silent" });
      const engine = new SherpaOnlineNemotronEngine(
        {
          modelDir: resolved!.modelDir,
          encoderPath: resolved!.encoderPath,
          decoderPath: resolved!.decoderPath,
          joinerPath: resolved!.joinerPath,
          tokensPath: resolved!.tokensPath,
          numThreads: 4,
        },
        logger,
      );

      try {
        const stt = new SherpaOnlineNemotronSTT({ engine, defaultLanguage: "vi" }, logger);
        const wavBytes = fs.readFileSync(testWavPath!);

        // 1. Single-shot transcription
        const singleShot = await stt.transcribeAudio(wavBytes, "audio/wav");
        expect(singleShot.text.toLowerCase()).toContain("đất nước");

        // 2. Streaming session transcription (chunked PCM16LE)
        const pcm16le = wavBytes.subarray(44);
        const session = stt.createSession({ logger, language: "vi" });
        const partials: string[] = [];
        const finals: string[] = [];
        const committedIds: string[] = [];

        session.on("transcript", (ev) => {
          if (ev.isFinal) {
            finals.push(ev.transcript);
          } else {
            partials.push(ev.transcript);
          }
        });
        session.on("committed", (ev) => {
          committedIds.push(ev.segmentId);
        });

        await session.connect();
        const chunkBytes = 3200 * 2; // 200ms @ 16kHz PCM16
        for (let offset = 0; offset < pcm16le.length; offset += chunkBytes) {
          session.appendPcm16(pcm16le.subarray(offset, offset + chunkBytes));
        }
        session.commit();
        session.close();

        expect(partials.length).toBeGreaterThan(0);
        expect(committedIds.length).toBe(1);
        expect(finals.length).toBe(1);
        expect(finals[0]?.toLowerCase()).toContain("đất nước");
      } finally {
        engine.free();
      }
    },
    30_000,
  );
});
