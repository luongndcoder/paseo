import { EventEmitter } from "node:events";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import type { SpeechToTextProvider, StreamingTranscriptionSession } from "../../speech-provider.js";
import {
  DEFAULT_SONIOX_LANGUAGE_HINTS,
  DEFAULT_SONIOX_STT_MODEL,
  DEFAULT_SONIOX_WS_ENDPOINT,
  resolveSonioxSpeechProviderConfigFromEnv,
  type SonioxSpeechProviderConfig,
} from "./config.js";
import { resolveSonioxLanguageHints, SonioxSTT } from "./stt.js";

const logger = pino({ level: "silent" });

class FakeWebSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  sentPayloads: Array<string | Buffer> = [];
  closedWithCode: number | null = null;

  constructor(public readonly url: string) {
    super();
  }

  send(data: string | Buffer): void {
    this.sentPayloads.push(typeof data === "string" ? data : Buffer.from(data));
  }

  close(code = 1000): void {
    this.closedWithCode = code;
    this.readyState = WebSocket.CLOSED;
    this.emit("close", code, Buffer.alloc(0));
  }

  simulateOpen(): void {
    this.readyState = WebSocket.OPEN;
    this.emit("open");
  }

  simulateServerJson(payload: Record<string, unknown>): void {
    this.emit("message", Buffer.from(JSON.stringify(payload), "utf8"));
  }

  simulateError(err: Error): void {
    this.emit("error", err);
  }
}

class FakeFallbackSession extends EventEmitter implements StreamingTranscriptionSession {
  readonly requiredSampleRate = 16000;
  connected = false;
  appendedChunks: Buffer[] = [];
  committed = false;
  closed = false;

  async connect(): Promise<void> {
    this.connected = true;
  }

  appendPcm16(pcm16: Buffer): void {
    this.appendedChunks.push(Buffer.from(pcm16));
  }

  commit(): void {
    this.committed = true;
    const totalBytes = this.appendedChunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const transcript = `fallback-sherpa-transcript(${totalBytes}b)`;
    this.emit("committed", { segmentId: "local-seg-1", previousSegmentId: null });
    this.emit("transcript", {
      segmentId: "local-seg-1",
      transcript,
      isFinal: true,
    });
  }

  clear(): void {
    this.appendedChunks = [];
  }

  close(): void {
    this.closed = true;
  }
}

function createFakeFallbackProvider(): {
  provider: SpeechToTextProvider;
  sessions: FakeFallbackSession[];
} {
  const sessions: FakeFallbackSession[] = [];
  const provider: SpeechToTextProvider = {
    id: "local",
    createSession: () => {
      const session = new FakeFallbackSession();
      sessions.push(session);
      return session;
    },
  };
  return { provider, sessions };
}

describe("Soniox STT provider & streaming session", () => {
  it("resolves config from env and persisted settings with sensible defaults", () => {
    const resolved = resolveSonioxSpeechProviderConfigFromEnv({
      env: {
        SONIOX_API_KEY: "  sx_test_key_123  ",
        SONIOX_LANGUAGE_HINTS: "vi, en, ja",
      } as unknown as NodeJS.ProcessEnv,
      persisted: undefined,
    });

    expect(resolved).toEqual({
      apiKey: "sx_test_key_123",
      endpoint: DEFAULT_SONIOX_WS_ENDPOINT,
      model: DEFAULT_SONIOX_STT_MODEL,
      languageHints: ["vi", "en", "ja"],
    });
  });

  it("prioritizes session language first in language_hints while deduplicating", () => {
    expect(resolveSonioxLanguageHints("en-US", ["vi", "en"])).toEqual(["en", "vi"]);
    expect(resolveSonioxLanguageHints("vi-VN", undefined)).toEqual(DEFAULT_SONIOX_LANGUAGE_HINTS);
  });

  it("streams PCM16 over WebSocket, emits live partial and final transcripts, and flushes with empty binary frame on commit", async () => {
    const sockets: FakeWebSocket[] = [];
    const config: SonioxSpeechProviderConfig = {
      apiKey: "soniox_secret_key",
      endpoint: DEFAULT_SONIOX_WS_ENDPOINT,
      model: DEFAULT_SONIOX_STT_MODEL,
      languageHints: ["vi", "en"],
    };

    const stt = new SonioxSTT({
      logger,
      getConfig: () => config,
      createWebSocket: (url) => {
        const ws = new FakeWebSocket(url);
        sockets.push(ws);
        queueMicrotask(() => ws.simulateOpen());
        return ws as unknown as WebSocket;
      },
    });

    const session = stt.createSession({
      logger,
      language: "vi",
      sampleRate: 16000,
    });

    const partials: string[] = [];
    const transcripts: Array<{ transcript: string; isFinal: boolean }> = [];
    session.on("transcript", (e: { transcript: string; isFinal: boolean }) => {
      if (!e.isFinal) {
        partials.push(e.transcript);
      }
      transcripts.push({ transcript: e.transcript, isFinal: e.isFinal });
    });

    await session.connect();
    expect(sockets).toHaveLength(1);
    const ws = sockets[0]!;
    expect(ws.url).toBe(DEFAULT_SONIOX_WS_ENDPOINT);

    // First sent frame must be the JSON init handshake
    expect(ws.sentPayloads).toHaveLength(1);
    expect(typeof ws.sentPayloads[0]).toBe("string");
    const initHandshake = JSON.parse(ws.sentPayloads[0] as string);
    expect(initHandshake).toEqual({
      api_key: "soniox_secret_key",
      model: "stt-rt-v5",
      audio_format: "pcm_s16le",
      sample_rate: 16000,
      num_channels: 1,
      language_hints: ["vi", "en"],
      enable_language_identification: true,
    });

    // Stream two PCM16 chunks
    const chunk1 = Buffer.from([1, 2, 3, 4]);
    const chunk2 = Buffer.from([5, 6, 7, 8]);
    session.appendPcm16(chunk1);
    session.appendPcm16(chunk2);
    expect(ws.sentPayloads).toHaveLength(3);
    expect(Buffer.isBuffer(ws.sentPayloads[1])).toBe(true);
    expect(Buffer.isBuffer(ws.sentPayloads[2])).toBe(true);

    // Simulate non-final partial tokens from Soniox
    ws.simulateServerJson({
      tokens: [
        { text: "Xin ", is_final: true },
        { text: "chào ", is_final: false },
        { text: "bạn", is_final: false },
      ],
    });

    expect(partials).toEqual(["Xin chào bạn"]);
    expect(transcripts).toEqual([{ transcript: "Xin chào bạn", isFinal: false }]);

    // Commit utterance -> sends empty binary frame (length 0)
    session.commit();
    expect(ws.sentPayloads).toHaveLength(4);
    const finalizeFrame = ws.sentPayloads[3] as Buffer;
    expect(Buffer.isBuffer(finalizeFrame)).toBe(true);
    expect(finalizeFrame.length).toBe(0);

    // Simulate final token flush with finished=true and control token <end>
    ws.simulateServerJson({
      tokens: [
        { text: "chào ", is_final: true },
        { text: "bạn ", is_final: true },
        { text: "Paseo", is_final: true },
        { text: "<end>", is_final: true },
      ],
      finished: true,
    });

    expect(transcripts.at(-1)).toEqual({
      transcript: "Xin chào bạn Paseo",
      isFinal: true,
    });

    session.close();
  });

  it("automatically falls back to Local Sherpa STT when Soniox API key is missing", async () => {
    const { provider: fallbackProvider, sessions } = createFakeFallbackProvider();
    const createWsSpy = vi.fn();

    const stt = new SonioxSTT({
      logger,
      getConfig: () => ({
        apiKey: "",
        endpoint: DEFAULT_SONIOX_WS_ENDPOINT,
        model: DEFAULT_SONIOX_STT_MODEL,
        languageHints: ["vi", "en"],
      }),
      fallbackProvider,
      createWebSocket: createWsSpy as unknown as (url: string) => WebSocket,
    });

    const session = stt.createSession({ logger, language: "vi" });
    const finals: string[] = [];
    session.on("transcript", (e: { transcript: string; isFinal: boolean }) => {
      if (e.isFinal) {
        finals.push(e.transcript);
      }
    });

    await session.connect();
    expect(createWsSpy).not.toHaveBeenCalled();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.connected).toBe(true);

    session.appendPcm16(Buffer.alloc(320));
    session.commit();

    expect(finals).toEqual(["fallback-sherpa-transcript(320b)"]);
    session.close();
  });

  it("replays buffered PCM16 audio into Local Sherpa fallback when Soniox fails mid-stream", async () => {
    const { provider: fallbackProvider, sessions } = createFakeFallbackProvider();
    const sockets: FakeWebSocket[] = [];

    const stt = new SonioxSTT({
      logger,
      getConfig: () => ({
        apiKey: "soniox_valid_key",
        endpoint: DEFAULT_SONIOX_WS_ENDPOINT,
        model: DEFAULT_SONIOX_STT_MODEL,
        languageHints: ["vi", "en"],
      }),
      fallbackProvider,
      createWebSocket: (url) => {
        const ws = new FakeWebSocket(url);
        sockets.push(ws);
        queueMicrotask(() => ws.simulateOpen());
        return ws as unknown as WebSocket;
      },
    });

    const session = stt.createSession({ logger, language: "vi" });
    const finals: string[] = [];
    session.on("transcript", (e: { transcript: string; isFinal: boolean }) => {
      if (e.isFinal) {
        finals.push(e.transcript);
      }
    });

    await session.connect();
    const ws = sockets[0]!;

    // Stream 640 bytes across two chunks before Soniox encounters a server/network error
    session.appendPcm16(Buffer.alloc(300, 1));
    session.appendPcm16(Buffer.alloc(340, 2));

    // Trigger Soniox runtime error mid-utterance
    ws.simulateServerJson({
      error_code: 503,
      error_message: "Service temporarily unavailable",
    });

    // Wait a microtask for async fallback activation & PCM16 replay
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(sessions).toHaveLength(1);
    const fallbackSession = sessions[0]!;
    expect(fallbackSession.appendedChunks).toHaveLength(2);
    expect(fallbackSession.appendedChunks[0]!.length).toBe(300);
    expect(fallbackSession.appendedChunks[1]!.length).toBe(340);

    // Append one more chunk and commit -> goes straight to fallback session
    session.appendPcm16(Buffer.alloc(160, 3));
    session.commit();

    expect(finals).toEqual(["fallback-sherpa-transcript(800b)"]);
    session.close();
  });
});
