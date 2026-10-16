import { describe, expect, it } from "vitest";

import { SherpaParakeetRealtimeTranscriptionSession } from "./sherpa-parakeet-realtime-session.js";
import type { SherpaOfflineRecognizerEngine } from "./sherpa-offline-recognizer.js";

function createFakeEngine(): SherpaOfflineRecognizerEngine {
  const lengths = new WeakMap<object, number>();
  return {
    sampleRate: 16000,
    createStream: () => ({}),
    acceptWaveform: (stream: object, _rate: number, samples: Float32Array) => {
      lengths.set(stream, samples.length);
    },
    normalizeText: (text: string) => text,
    recognizer: {
      decode: () => undefined,
      getResult: (stream: object) => ({ text: `samples:${lengths.get(stream)}` }),
    },
  } as unknown as SherpaOfflineRecognizerEngine;
}

describe("SherpaParakeetRealtimeTranscriptionSession", () => {
  it("decodes the full committed audio when a partial decode is in flight at commit", async () => {
    const session = new SherpaParakeetRealtimeTranscriptionSession({
      engine: createFakeEngine(),
      minDecodeIntervalMs: 0,
    });
    const finals: Array<{ segmentId: string; transcript: string }> = [];
    const committed: string[] = [];
    session.on("committed", (p) => committed.push(p.segmentId));
    session.on("transcript", (p) => {
      if (p.isFinal) finals.push(p);
    });

    await session.connect();
    session.appendPcm16(Buffer.alloc(4)); // starts a partial decode over 2 samples
    session.appendPcm16(Buffer.alloc(4)); // arrives while that decode is in flight
    session.commit();
    session.appendPcm16(Buffer.alloc(2)); // belongs to the next segment
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(finals).toHaveLength(1);
    expect(finals[0]?.transcript.toLowerCase()).toBe("samples:4");
    expect(finals[0]?.segmentId).toBe(committed[0]);
  });
});
