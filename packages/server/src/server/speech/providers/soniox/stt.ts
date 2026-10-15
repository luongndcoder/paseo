import { EventEmitter } from "node:events";
import type pino from "pino";
import { WebSocket, type RawData } from "ws";

import type { SpeechToTextProvider, StreamingTranscriptionSession } from "../../speech-provider.js";
import {
  DEFAULT_SONIOX_LANGUAGE_HINTS,
  DEFAULT_SONIOX_STT_MODEL,
  DEFAULT_SONIOX_WS_ENDPOINT,
  type SonioxSpeechProviderConfig,
} from "./config.js";

const SONIOX_SAMPLE_RATE = 16000;
const SONIOX_CONNECT_TIMEOUT_MS = 6000;
const SONIOX_FINALIZE_WAIT_MS = 500;
const MAX_FALLBACK_PCM_BUFFER_BYTES = 5 * 1024 * 1024; // ~160s at 16kHz 16-bit mono

interface SonioxToken {
  text?: string;
  is_final?: boolean;
  confidence?: number;
  language?: string;
}

interface SonioxServerMessage {
  tokens?: SonioxToken[];
  finished?: boolean;
  error_code?: number;
  error_message?: string;
}

export type WebSocketFactory = (url: string) => WebSocket;

function normalizeLanguageCode(language: string | undefined): string | null {
  if (!language) {
    return null;
  }
  const trimmed = language.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }
  const primary = trimmed.split(/[-_]/)[0];
  return primary && primary.length > 0 ? primary : null;
}

export function resolveSonioxLanguageHints(
  sessionLanguage: string | undefined,
  configuredHints: string[] | undefined,
): string[] {
  const hints: string[] = [];
  const primary = normalizeLanguageCode(sessionLanguage);
  if (primary) {
    hints.push(primary);
  }
  for (const hint of configuredHints ?? DEFAULT_SONIOX_LANGUAGE_HINTS) {
    const normalized = normalizeLanguageCode(hint);
    if (normalized && !hints.includes(normalized)) {
      hints.push(normalized);
    }
  }
  if (hints.length === 0) {
    return [...DEFAULT_SONIOX_LANGUAGE_HINTS];
  }
  return hints;
}

function rawDataToString(data: RawData): string {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
}

function isControlTokenText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed === "<end>" || trimmed === "<fin>";
}

export interface SonioxStreamingSessionOptions {
  logger: pino.Logger;
  language?: string;
  prompt?: string;
  sampleRate?: number;
  getConfig: () => SonioxSpeechProviderConfig | null | undefined;
  fallbackProvider?: SpeechToTextProvider | null;
  createWebSocket?: WebSocketFactory;
  connectTimeoutMs?: number;
  finalizeWaitMs?: number;
}

export class SonioxStreamingTranscriptionSession
  extends EventEmitter
  implements StreamingTranscriptionSession
{
  readonly requiredSampleRate = SONIOX_SAMPLE_RATE;

  private readonly logger: pino.Logger;
  private readonly language?: string;
  private readonly prompt?: string;
  private readonly getConfig: () => SonioxSpeechProviderConfig | null | undefined;
  private readonly fallbackProvider: SpeechToTextProvider | null;
  private readonly createWebSocket: WebSocketFactory;
  private readonly connectTimeoutMs: number;
  private readonly finalizeWaitMs: number;

  private ws: WebSocket | null = null;
  private wsConnectPromise: Promise<void> | null = null;
  private wsReady = false;
  private closed = false;

  private usingFallback = false;
  private fallbackSession: StreamingTranscriptionSession | null = null;
  private fallbackActivatingPromise: Promise<boolean> | null = null;

  private segmentSequence = 1;
  private currentSegmentId = "soniox-seg-1";
  private previousSegmentId: string | null = null;

  private finalizedText = "";
  private nonFinalText = "";
  private lastPartial = "";

  private pendingSendChunks: Buffer[] = [];
  private currentSegmentPcmChunks: Buffer[] = [];
  private currentSegmentPcmBytes = 0;

  private commitPending = false;
  private commitFinalizeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: SonioxStreamingSessionOptions) {
    super();
    this.logger = options.logger.child({
      module: "speech",
      provider: "soniox",
      component: "streaming-stt",
    });
    this.language = options.language;
    this.prompt = options.prompt;
    this.getConfig = options.getConfig;
    this.fallbackProvider = options.fallbackProvider ?? null;
    this.createWebSocket = options.createWebSocket ?? ((url: string) => new WebSocket(url));
    this.connectTimeoutMs = options.connectTimeoutMs ?? SONIOX_CONNECT_TIMEOUT_MS;
    this.finalizeWaitMs = options.finalizeWaitMs ?? SONIOX_FINALIZE_WAIT_MS;
  }

  async connect(): Promise<void> {
    if (this.closed) {
      throw new Error("Soniox transcription session is closed");
    }
    if (this.usingFallback && this.fallbackSession) {
      return;
    }

    const config = this.getConfig();
    const apiKey = config?.apiKey?.trim();
    if (!apiKey) {
      const switched = await this.activateFallback(new Error("Soniox API key is not configured"));
      if (switched) {
        return;
      }
      throw new Error("Soniox API key is not configured and local STT fallback is unavailable");
    }

    try {
      await this.ensureWebSocketConnected();
    } catch (error) {
      const switched = await this.activateFallback(error);
      if (switched) {
        return;
      }
      throw error;
    }
  }

  appendPcm16(pcm16: Buffer): void {
    if (this.closed || pcm16.length === 0) {
      return;
    }

    if (this.usingFallback) {
      this.fallbackSession?.appendPcm16(pcm16);
      return;
    }

    // Buffer current segment PCM16 so we can replay into local Sherpa if Soniox drops mid-stream
    if (this.currentSegmentPcmBytes + pcm16.length <= MAX_FALLBACK_PCM_BUFFER_BYTES) {
      this.currentSegmentPcmChunks.push(Buffer.from(pcm16));
      this.currentSegmentPcmBytes += pcm16.length;
    }

    if (this.ws && this.wsReady && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(pcm16);
      } catch (error) {
        void this.handleRuntimeFailure(error);
      }
      return;
    }

    this.pendingSendChunks.push(Buffer.from(pcm16));
    if (!this.wsConnectPromise && !this.closed && !this.usingFallback) {
      void this.ensureWebSocketConnected().catch((error) => {
        void this.handleRuntimeFailure(error);
      });
    }
  }

  commit(): void {
    if (this.closed) {
      return;
    }

    if (this.usingFallback) {
      this.fallbackSession?.commit();
      return;
    }

    if (
      this.currentSegmentPcmBytes === 0 &&
      this.finalizedText.length === 0 &&
      this.nonFinalText.length === 0
    ) {
      this.completeCommit();
      return;
    }

    this.commitPending = true;
    this.flushPendingChunksToSocket();

    if (this.ws && this.wsReady && this.ws.readyState === WebSocket.OPEN) {
      try {
        // Empty binary frame tells Soniox that audio stream for this utterance has ended
        // and flushes all remaining tokens as final.
        this.ws.send(Buffer.alloc(0));
      } catch (error) {
        void this.handleRuntimeFailure(error);
        return;
      }
    }

    this.clearCommitFinalizeTimer();
    this.commitFinalizeTimer = setTimeout(() => {
      this.commitFinalizeTimer = null;
      if (this.commitPending && !this.usingFallback && !this.closed) {
        this.completeCommit();
      }
    }, this.finalizeWaitMs);
  }

  clear(): void {
    if (this.closed) {
      return;
    }
    if (this.usingFallback) {
      this.fallbackSession?.clear();
      return;
    }
    this.clearCommitFinalizeTimer();
    this.commitPending = false;
    this.resetSegmentState();
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.clearCommitFinalizeTimer();
    this.commitPending = false;
    this.pendingSendChunks = [];
    this.currentSegmentPcmChunks = [];
    this.currentSegmentPcmBytes = 0;
    this.teardownWebSocket();
    if (this.fallbackSession) {
      try {
        this.fallbackSession.close();
      } catch {
        // Ignore close errors on fallback session
      }
      this.fallbackSession = null;
    }
  }

  private async ensureWebSocketConnected(): Promise<void> {
    if (this.ws && this.wsReady && this.ws.readyState === WebSocket.OPEN) {
      return;
    }
    if (this.wsConnectPromise) {
      return this.wsConnectPromise;
    }

    const config = this.getConfig();
    const apiKey = config?.apiKey?.trim();
    if (!apiKey) {
      throw new Error("Soniox API key is not configured");
    }

    const endpoint = config?.endpoint?.trim() || DEFAULT_SONIOX_WS_ENDPOINT;
    const model = config?.model?.trim() || DEFAULT_SONIOX_STT_MODEL;
    const languageHints = resolveSonioxLanguageHints(this.language, config?.languageHints);

    this.wsConnectPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      const ws = this.createWebSocket(endpoint);
      this.ws = ws;
      this.wsReady = false;

      const connectTimer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        this.wsConnectPromise = null;
        this.teardownWebSocket();
        reject(new Error(`Soniox WebSocket connection timed out after ${this.connectTimeoutMs}ms`));
      }, this.connectTimeoutMs);

      ws.once("open", () => {
        if (this.closed || this.ws !== ws) {
          clearTimeout(connectTimer);
          return;
        }
        try {
          const initPayload: Record<string, unknown> = {
            api_key: apiKey,
            model,
            audio_format: "pcm_s16le",
            sample_rate: this.requiredSampleRate,
            num_channels: 1,
            language_hints: languageHints,
            enable_language_identification: true,
          };
          ws.send(JSON.stringify(initPayload));
          this.wsReady = true;
          this.flushPendingChunksToSocket();
          if (!settled) {
            settled = true;
            clearTimeout(connectTimer);
            this.wsConnectPromise = null;
            resolve();
          }
        } catch (sendErr) {
          if (!settled) {
            settled = true;
            clearTimeout(connectTimer);
            this.wsConnectPromise = null;
            reject(sendErr instanceof Error ? sendErr : new Error(String(sendErr)));
          }
        }
      });

      ws.on("message", (raw: RawData) => {
        if (this.closed || this.ws !== ws || this.usingFallback) {
          return;
        }
        this.handleServerMessage(raw);
      });

      ws.on("error", (err: Error) => {
        if (this.closed || this.ws !== ws) {
          return;
        }
        if (!settled) {
          settled = true;
          clearTimeout(connectTimer);
          this.wsConnectPromise = null;
          this.teardownWebSocket();
          reject(err);
          return;
        }
        void this.handleRuntimeFailure(err);
      });

      ws.on("close", (code: number, reason: Buffer) => {
        if (this.closed || this.ws !== ws) {
          return;
        }
        const reasonText = reason?.toString("utf8") || "";
        this.ws = null;
        this.wsReady = false;
        this.wsConnectPromise = null;

        if (!settled) {
          settled = true;
          clearTimeout(connectTimer);
          reject(
            new Error(
              `Soniox WebSocket closed before ready (code=${code}${reasonText ? `, reason=${reasonText}` : ""})`,
            ),
          );
          return;
        }

        if (this.commitPending) {
          // If we already received transcript text, complete the commit cleanly;
          // otherwise if we got nothing and closed abnormally, try fallback.
          const currentTranscript = `${this.finalizedText}${this.nonFinalText}`.trim();
          if (currentTranscript.length > 0 || code === 1000) {
            this.completeCommit();
          } else {
            void this.handleRuntimeFailure(
              new Error(`Soniox WebSocket closed unexpectedly during commit (code=${code})`),
            );
          }
        }
      });
    });

    return this.wsConnectPromise;
  }

  private flushPendingChunksToSocket(): void {
    if (!this.ws || !this.wsReady || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    while (this.pendingSendChunks.length > 0) {
      const chunk = this.pendingSendChunks.shift()!;
      try {
        this.ws.send(chunk);
      } catch (error) {
        void this.handleRuntimeFailure(error);
        return;
      }
    }
  }

  private handleServerMessage(raw: RawData): void {
    const text = rawDataToString(raw);
    let parsed: SonioxServerMessage;
    try {
      parsed = JSON.parse(text) as SonioxServerMessage;
    } catch (error) {
      this.logger.warn({ err: error, text }, "Failed to parse Soniox WebSocket message");
      return;
    }

    if (parsed.error_code || parsed.error_message) {
      const errMessage = `Soniox STT error (${parsed.error_code ?? "unknown"}): ${parsed.error_message ?? "Unknown error"}`;
      void this.handleRuntimeFailure(new Error(errMessage));
      return;
    }

    if (Array.isArray(parsed.tokens)) {
      let nextNonFinal = "";
      for (const token of parsed.tokens) {
        const tokenText = typeof token.text === "string" ? token.text : "";
        if (!tokenText || isControlTokenText(tokenText)) {
          continue;
        }
        if (token.is_final) {
          this.finalizedText += tokenText;
        } else {
          nextNonFinal += tokenText;
        }
      }
      this.nonFinalText = nextNonFinal;

      const combined = `${this.finalizedText}${this.nonFinalText}`.trim();
      if (combined.length > 0 && combined !== this.lastPartial) {
        this.lastPartial = combined;
        this.emit("partial", {
          segmentId: this.currentSegmentId,
          transcript: combined,
        });
        this.emit("transcript", {
          segmentId: this.currentSegmentId,
          transcript: combined,
          isFinal: false,
        });
      }
    }

    if (this.commitPending && parsed.finished === true) {
      this.completeCommit();
    }
  }

  private completeCommit(): void {
    this.clearCommitFinalizeTimer();
    if (
      !this.commitPending &&
      this.currentSegmentPcmBytes === 0 &&
      !this.finalizedText &&
      !this.nonFinalText
    ) {
      const segmentId = this.currentSegmentId;
      const previousSegmentId = this.previousSegmentId;
      this.emit("committed", { segmentId, previousSegmentId });
      this.emit("transcript", {
        segmentId,
        transcript: "",
        isFinal: true,
      });
      this.advanceSegment();
      return;
    }

    this.commitPending = false;
    const segmentId = this.currentSegmentId;
    const previousSegmentId = this.previousSegmentId;
    const finalTranscript = `${this.finalizedText}${this.nonFinalText}`.trim();

    this.emit("committed", { segmentId, previousSegmentId });
    this.emit("transcript", {
      segmentId,
      transcript: finalTranscript,
      isFinal: true,
    });

    this.advanceSegment();
    // Soniox closes the stream after empty-frame finalization; close socket cleanly
    // so a subsequent utterance in the same session opens a fresh stream.
    this.teardownWebSocket();
  }

  private advanceSegment(): void {
    this.previousSegmentId = this.currentSegmentId;
    this.segmentSequence += 1;
    this.currentSegmentId = `soniox-seg-${this.segmentSequence}`;
    this.resetSegmentState();
  }

  private resetSegmentState(): void {
    this.finalizedText = "";
    this.nonFinalText = "";
    this.lastPartial = "";
    this.pendingSendChunks = [];
    this.currentSegmentPcmChunks = [];
    this.currentSegmentPcmBytes = 0;
  }

  private clearCommitFinalizeTimer(): void {
    if (this.commitFinalizeTimer) {
      clearTimeout(this.commitFinalizeTimer);
      this.commitFinalizeTimer = null;
    }
  }

  private teardownWebSocket(): void {
    const ws = this.ws;
    this.ws = null;
    this.wsReady = false;
    this.wsConnectPromise = null;
    if (ws) {
      ws.removeAllListeners();
      try {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close(1000);
        }
      } catch {
        // Ignore close errors
      }
    }
  }

  private async handleRuntimeFailure(error: unknown): Promise<void> {
    if (this.closed || this.usingFallback) {
      return;
    }
    const err = error instanceof Error ? error : new Error(String(error));
    const switched = await this.activateFallback(err);
    if (switched) {
      return;
    }
    // If we already have partial text and commit is pending, emit what we have rather than losing it
    const partialTranscript = `${this.finalizedText}${this.nonFinalText}`.trim();
    if (this.commitPending && partialTranscript.length > 0) {
      this.logger.warn(
        { err },
        "Soniox error during commit with no fallback; completing with partial transcript",
      );
      this.completeCommit();
      return;
    }
    this.emit("error", err);
  }

  private async activateFallback(reason: unknown): Promise<boolean> {
    if (this.closed) {
      return false;
    }
    if (this.usingFallback && this.fallbackSession) {
      return true;
    }
    if (this.fallbackActivatingPromise) {
      return this.fallbackActivatingPromise;
    }
    const fallbackProvider = this.fallbackProvider;
    if (!fallbackProvider) {
      return false;
    }

    this.fallbackActivatingPromise = (async () => {
      try {
        this.logger.warn(
          { err: reason instanceof Error ? reason.message : String(reason) },
          "Activating local Sherpa STT fallback for Soniox session",
        );
        this.clearCommitFinalizeTimer();
        this.teardownWebSocket();

        const session = fallbackProvider.createSession({
          logger: this.logger,
          language: this.language,
          prompt: this.prompt,
        });

        session.on("committed", (event) => {
          if (!this.closed) {
            this.emit("committed", event);
          }
        });
        session.on("transcript", (event) => {
          if (!this.closed) {
            if (!event.isFinal) {
              this.emit("partial", {
                segmentId: event.segmentId,
                transcript: event.transcript,
              });
            }
            this.emit("transcript", event);
          }
        });
        session.on("error", (err) => {
          if (!this.closed) {
            this.emit("error", err);
          }
        });

        await session.connect();
        if (this.closed) {
          session.close();
          return false;
        }

        this.fallbackSession = session;
        this.usingFallback = true;

        // Replay buffered PCM16 chunks for the current utterance into the fallback session
        const replayChunks = this.currentSegmentPcmChunks;
        this.currentSegmentPcmChunks = [];
        this.currentSegmentPcmBytes = 0;
        this.pendingSendChunks = [];

        for (const chunk of replayChunks) {
          session.appendPcm16(chunk);
        }

        if (this.commitPending) {
          this.commitPending = false;
          session.commit();
        }

        return true;
      } catch (fallbackErr) {
        this.logger.error(
          { err: fallbackErr },
          "Failed to activate local Sherpa STT fallback session",
        );
        return false;
      } finally {
        this.fallbackActivatingPromise = null;
      }
    })();

    return this.fallbackActivatingPromise;
  }
}

export interface SonioxSTTOptions {
  getConfig: () => SonioxSpeechProviderConfig | null | undefined;
  fallbackProvider?: SpeechToTextProvider | null;
  logger: pino.Logger;
  createWebSocket?: WebSocketFactory;
}

export class SonioxSTT implements SpeechToTextProvider {
  readonly id = "soniox";

  private readonly getConfig: () => SonioxSpeechProviderConfig | null | undefined;
  private readonly fallbackProvider: SpeechToTextProvider | null;
  private readonly logger: pino.Logger;
  private readonly createWebSocket?: WebSocketFactory;

  constructor(options: SonioxSTTOptions) {
    this.getConfig = options.getConfig;
    this.fallbackProvider = options.fallbackProvider ?? null;
    this.logger = options.logger.child({ module: "speech", provider: "soniox", component: "stt" });
    this.createWebSocket = options.createWebSocket;
  }

  createSession(options: {
    logger: pino.Logger;
    language?: string;
    prompt?: string;
    sampleRate?: number;
  }): StreamingTranscriptionSession {
    return new SonioxStreamingTranscriptionSession({
      logger: options.logger ?? this.logger,
      language: options.language,
      prompt: options.prompt,
      sampleRate: options.sampleRate,
      getConfig: this.getConfig,
      fallbackProvider: this.fallbackProvider,
      createWebSocket: this.createWebSocket,
    });
  }
}
