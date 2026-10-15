import { EventEmitter } from "node:events";
import { v4 as uuidv4 } from "uuid";
import type pino from "pino";

import {
  parsePcm16MonoWav,
  parsePcmRateFromFormat,
  pcm16lePeakAbs,
  pcm16leToFloat32,
} from "../../../audio.js";
import type {
  SpeechToTextProvider,
  StreamingTranscriptionCommittedEvent,
  StreamingTranscriptionEvent,
  StreamingTranscriptionSession,
  TranscriptionResult,
} from "../../../speech-provider.js";
import { loadSherpaOnnxNode } from "./sherpa-onnx-node-loader.js";

export interface SherpaOnlineNemotronSttConfig {
  modelDir?: string;
  encoderPath?: string;
  decoderPath?: string;
  joinerPath?: string;
  tokensPath?: string;
  numThreads?: number;
  sampleRate?: number;
  featureDim?: number;
  defaultLanguage?: string;
}

interface SherpaOnlineRecognizerInstance {
  createStream(): unknown;
  isReady(stream: unknown): boolean;
  decode(stream: unknown): void;
  isEndpoint?(stream: unknown): boolean;
  reset?(stream: unknown): void;
  getResult(stream: unknown): { text?: string } | null | undefined;
  free?(): void;
}

const DEFAULT_SAMPLE_RATE = 16000;
const DEFAULT_FEATURE_DIM = 128;
const RIGHT_CONTEXT_FLUSH_SECONDS = 0.6;

export function normalizeNemotronLanguage(language?: string | null): string {
  const trimmed = language?.trim().toLowerCase();
  if (!trimmed) {
    return "vi";
  }
  if (trimmed === "auto") {
    return "auto";
  }
  const base = trimmed.split(/[-_]/)[0];
  return base || "vi";
}

/**
 * Collapses immediate word/phrase repetitions caused by streaming chunk boundaries.
 * Ported from Scribble's `src-tauri/src/stt/text.rs`.
 */
export function collapseRepeats(text: string): string {
  const words = text
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  if (words.length < 2) {
    return words.join(" ");
  }

  const stripPunct = (s: string): string =>
    s.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").toLowerCase();

  let current = words;
  for (let pass = 0; pass < 3; pass += 1) {
    const out: string[] = [];
    let i = 0;
    while (i < current.length) {
      let skipped = false;
      const maxN = Math.min(4, Math.floor((current.length - i) / 2));
      for (let n = maxN; n >= 1; n -= 1) {
        let matches = true;
        for (let k = 0; k < n; k += 1) {
          const a = stripPunct(current[i + k]);
          const b = stripPunct(current[i + n + k]);
          if (!a || a !== b) {
            matches = false;
            break;
          }
        }
        if (matches) {
          for (let k = 0; k < n; k += 1) {
            out.push(current[i + k]);
          }
          i += n * 2;
          while (i + n <= current.length) {
            let more = true;
            for (let k = 0; k < n; k += 1) {
              if (stripPunct(current[i + k]) !== stripPunct(out[out.length - n + k])) {
                more = false;
                break;
              }
            }
            if (more) {
              i += n;
            } else {
              break;
            }
          }
          skipped = true;
          break;
        }
      }
      if (!skipped) {
        out.push(current[i]);
        i += 1;
      }
    }
    if (out.length === current.length) {
      current = out;
      break;
    }
    current = out;
  }

  return current.join(" ");
}

function normalizeChunkGain(samples: Float32Array): Float32Array {
  if (samples.length === 0) {
    return samples;
  }
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const abs = Math.abs(samples[i]);
    if (abs > peak) {
      peak = abs;
    }
  }
  if (peak <= 0.008 || peak >= 0.25) {
    return samples;
  }
  const gain = Math.min(0.45 / peak, 6.0);
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    out[i] = Math.max(-1, Math.min(1, samples[i] * gain));
  }
  return out;
}

function resampleLinear(
  input: Float32Array,
  fromSampleRate: number,
  toSampleRate: number,
): Float32Array {
  if (fromSampleRate === toSampleRate) {
    return input;
  }
  if (fromSampleRate <= 0 || toSampleRate <= 0) {
    throw new Error(`Invalid sample rate conversion: ${fromSampleRate} -> ${toSampleRate}`);
  }
  if (input.length === 0) {
    return new Float32Array(0);
  }
  const ratio = toSampleRate / fromSampleRate;
  const outLength = Math.max(1, Math.round(input.length * ratio));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i += 1) {
    const srcPos = i / ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(input.length - 1, i0 + 1);
    const frac = srcPos - i0;
    const s0 = input[Math.min(input.length - 1, Math.max(0, i0))];
    const s1 = input[i1];
    out[i] = s0 + (s1 - s0) * frac;
  }
  return out;
}

export class SherpaOnlineNemotronEngine {
  private readonly logger: pino.Logger;
  private readonly config: Required<Omit<SherpaOnlineNemotronSttConfig, "modelDir">> & {
    modelDir?: string;
  };
  private recognizer: SherpaOnlineRecognizerInstance | null = null;

  constructor(config: SherpaOnlineNemotronSttConfig, logger: pino.Logger) {
    this.logger = logger.child({ component: "sherpa-online-nemotron-engine" });
    const baseDir = config.modelDir ?? "";
    this.config = {
      modelDir: config.modelDir,
      encoderPath: config.encoderPath ?? `${baseDir}/encoder.int8.onnx`,
      decoderPath: config.decoderPath ?? `${baseDir}/decoder.int8.onnx`,
      joinerPath: config.joinerPath ?? `${baseDir}/joiner.int8.onnx`,
      tokensPath: config.tokensPath ?? `${baseDir}/tokens.txt`,
      numThreads: config.numThreads ?? 4,
      sampleRate: config.sampleRate ?? DEFAULT_SAMPLE_RATE,
      featureDim: config.featureDim ?? DEFAULT_FEATURE_DIM,
      defaultLanguage: normalizeNemotronLanguage(config.defaultLanguage),
    };
  }

  get sampleRate(): number {
    return this.config.sampleRate;
  }

  get defaultLanguage(): string {
    return this.config.defaultLanguage;
  }

  private ensureRecognizer(): SherpaOnlineRecognizerInstance {
    if (this.recognizer) {
      return this.recognizer;
    }

    const sherpa = loadSherpaOnnxNode();
    if (!sherpa.OnlineRecognizer) {
      throw new Error("sherpa-onnx-node does not expose OnlineRecognizer");
    }

    const recognizerConfig = {
      featConfig: {
        sampleRate: this.config.sampleRate,
        featureDim: this.config.featureDim,
      },
      modelConfig: {
        transducer: {
          encoder: this.config.encoderPath,
          decoder: this.config.decoderPath,
          joiner: this.config.joinerPath,
        },
        tokens: this.config.tokensPath,
        numThreads: this.config.numThreads,
        provider: "cpu",
        debug: 0,
      },
      decodingMethod: "greedy_search",
      maxActivePaths: 4,
      enableEndpoint: 1,
      rule1MinTrailingSilence: 2.4,
      rule2MinTrailingSilence: 1.2,
      rule3MinUtteranceLength: 20,
    };

    this.logger.info(
      {
        encoderPath: this.config.encoderPath,
        numThreads: this.config.numThreads,
        sampleRate: this.config.sampleRate,
        featureDim: this.config.featureDim,
        defaultLanguage: this.config.defaultLanguage,
      },
      "Initializing sherpa-onnx OnlineRecognizer for Nemotron 3.5 ASR",
    );

    this.recognizer = new sherpa.OnlineRecognizer(
      recognizerConfig,
    ) as SherpaOnlineRecognizerInstance;
    return this.recognizer;
  }

  createStream(language?: string): unknown {
    const recognizer = this.ensureRecognizer();
    const stream = recognizer.createStream();
    this.applyStreamLanguage(stream, language);
    return stream;
  }

  applyStreamLanguage(stream: unknown, language?: string): void {
    const lang = normalizeNemotronLanguage(language ?? this.config.defaultLanguage);
    const candidate = stream as { setOption?: (key: string, value: string) => void } | null;
    if (candidate && typeof candidate.setOption === "function") {
      try {
        candidate.setOption("language", lang);
      } catch (err) {
        this.logger.debug({ err, lang }, "Failed to set language option on Nemotron stream");
      }
    }
  }

  acceptWaveform(stream: unknown, samples: Float32Array, sampleRate: number): void {
    const candidate = stream as {
      acceptWaveform: (input: { sampleRate: number; samples: Float32Array }) => void;
    };
    candidate.acceptWaveform({ sampleRate, samples });
  }

  inputFinished(stream: unknown): void {
    const candidate = stream as { inputFinished?: () => void } | null;
    if (candidate && typeof candidate.inputFinished === "function") {
      candidate.inputFinished();
    }
  }

  decodeReady(stream: unknown): void {
    const recognizer = this.ensureRecognizer();
    while (recognizer.isReady(stream)) {
      recognizer.decode(stream);
    }
  }

  isEndpoint(stream: unknown): boolean {
    const recognizer = this.ensureRecognizer();
    return Boolean(recognizer.isEndpoint?.(stream));
  }

  reset(stream: unknown, language?: string): void {
    const recognizer = this.ensureRecognizer();
    recognizer.reset?.(stream);
    this.applyStreamLanguage(stream, language);
  }

  getResultText(stream: unknown): string {
    const recognizer = this.ensureRecognizer();
    const raw = recognizer.getResult(stream);
    const text = typeof raw?.text === "string" ? raw.text.trim() : "";
    return text;
  }

  free(): void {
    try {
      this.recognizer?.free?.();
    } catch {
      // ignore
    }
    this.recognizer = null;
  }

  transcribeFloat32(
    samples: Float32Array,
    sampleRate: number,
    language?: string,
  ): TranscriptionResult {
    const start = Date.now();
    const normalizedRate = this.config.sampleRate;
    const mono16k =
      sampleRate === normalizedRate ? samples : resampleLinear(samples, sampleRate, normalizedRate);
    const gained = normalizeChunkGain(mono16k);
    const stream = this.createStream(language);

    const chunkSize = Math.max(1, Math.round(normalizedRate * 0.28));
    for (let offset = 0; offset < gained.length; offset += chunkSize) {
      const slice = gained.subarray(offset, Math.min(gained.length, offset + chunkSize));
      this.acceptWaveform(stream, slice, normalizedRate);
      this.decodeReady(stream);
    }

    const silencePadding = new Float32Array(
      Math.round(normalizedRate * RIGHT_CONTEXT_FLUSH_SECONDS),
    );
    this.acceptWaveform(stream, silencePadding, normalizedRate);
    this.inputFinished(stream);
    this.decodeReady(stream);

    const text = collapseRepeats(this.getResultText(stream));
    return {
      text,
      language: normalizeNemotronLanguage(language ?? this.config.defaultLanguage),
      duration: Date.now() - start,
      isLowConfidence: text.length === 0,
    };
  }
}

export class SherpaOnlineNemotronRealtimeSession
  extends EventEmitter
  implements StreamingTranscriptionSession
{
  public readonly requiredSampleRate: number;
  private readonly engine: SherpaOnlineNemotronEngine;
  private readonly language: string;
  private connected = false;
  private stream: unknown | null = null;
  private currentSegmentId: string | null = null;
  private previousSegmentId: string | null = null;
  private completedSegments: string[] = [];
  private lastPartialEmitted = "";
  private hasAudioInCurrentTurn = false;

  constructor(options: { engine: SherpaOnlineNemotronEngine; language?: string }) {
    super();
    this.engine = options.engine;
    this.requiredSampleRate = this.engine.sampleRate;
    this.language = normalizeNemotronLanguage(options.language ?? options.engine.defaultLanguage);
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }
    this.currentSegmentId = uuidv4();
    this.stream = this.engine.createStream(this.language);
    this.completedSegments = [];
    this.lastPartialEmitted = "";
    this.hasAudioInCurrentTurn = false;
    this.connected = true;
  }

  private buildCombinedTranscript(activeStreamText: string): string {
    const parts = [...this.completedSegments];
    if (activeStreamText.trim().length > 0) {
      parts.push(activeStreamText.trim());
    }
    return collapseRepeats(parts.join(" "));
  }

  appendPcm16(pcm16le: Buffer): void {
    if (!this.connected || !this.stream || !this.currentSegmentId) {
      this.emit("error", new Error("Nemotron realtime session not connected"));
      return;
    }
    if (pcm16le.length === 0) {
      return;
    }

    try {
      const aligned = pcm16le.length % 2 === 0 ? pcm16le : pcm16le.subarray(0, pcm16le.length - 1);
      if (aligned.length === 0) {
        return;
      }

      const rawFloat32 = pcm16leToFloat32(aligned);
      const gained = normalizeChunkGain(rawFloat32);

      this.hasAudioInCurrentTurn = true;
      this.engine.acceptWaveform(this.stream, gained, this.requiredSampleRate);
      this.engine.decodeReady(this.stream);

      const activeText = this.engine.getResultText(this.stream);
      if (this.engine.isEndpoint(this.stream) && activeText.length > 0) {
        this.completedSegments.push(activeText);
        this.engine.reset(this.stream, this.language);
      }

      const currentActive = this.engine.getResultText(this.stream);
      const combined = this.buildCombinedTranscript(currentActive);
      if (combined.length > 0 && combined !== this.lastPartialEmitted) {
        this.lastPartialEmitted = combined;
        const payload: StreamingTranscriptionEvent = {
          segmentId: this.currentSegmentId,
          transcript: combined,
          isFinal: false,
          language: this.language,
        };
        this.emit("transcript", payload);
      }
    } catch (err) {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
    }
  }

  commit(): void {
    if (!this.connected || !this.stream || !this.currentSegmentId) {
      this.emit("error", new Error("Nemotron realtime session not connected"));
      return;
    }

    try {
      let finalTranscript = "";
      if (this.hasAudioInCurrentTurn) {
        const silencePadding = new Float32Array(
          Math.round(this.requiredSampleRate * RIGHT_CONTEXT_FLUSH_SECONDS),
        );
        this.engine.acceptWaveform(this.stream, silencePadding, this.requiredSampleRate);
        this.engine.inputFinished(this.stream);
        this.engine.decodeReady(this.stream);

        const tailText = this.engine.getResultText(this.stream);
        finalTranscript = this.buildCombinedTranscript(tailText);
      }

      const segmentId = this.currentSegmentId;
      const previousSegmentId = this.previousSegmentId;

      const committedPayload: StreamingTranscriptionCommittedEvent = {
        segmentId,
        previousSegmentId,
      };
      const transcriptPayload: StreamingTranscriptionEvent = {
        segmentId,
        transcript: finalTranscript,
        isFinal: true,
        language: this.language,
        ...(finalTranscript.length === 0 ? { isLowConfidence: true } : {}),
      };

      this.previousSegmentId = segmentId;
      this.currentSegmentId = uuidv4();
      this.stream = this.engine.createStream(this.language);
      this.completedSegments = [];
      this.lastPartialEmitted = "";
      this.hasAudioInCurrentTurn = false;

      this.emit("committed", committedPayload);
      this.emit("transcript", transcriptPayload);
    } catch (err) {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
    }
  }

  clear(): void {
    if (!this.connected) {
      return;
    }
    this.currentSegmentId = uuidv4();
    this.stream = this.engine.createStream(this.language);
    this.completedSegments = [];
    this.lastPartialEmitted = "";
    this.hasAudioInCurrentTurn = false;
  }

  close(): void {
    this.connected = false;
    this.currentSegmentId = null;
    this.stream = null;
    this.completedSegments = [];
    this.lastPartialEmitted = "";
    this.hasAudioInCurrentTurn = false;
  }
}

export class SherpaOnlineNemotronSTT implements SpeechToTextProvider {
  public readonly id = "local" as const;
  private readonly logger: pino.Logger;
  private readonly engine: SherpaOnlineNemotronEngine;
  private readonly defaultLanguage: string;
  private readonly silencePeakThreshold: number;

  constructor(
    configOrEngine:
      | SherpaOnlineNemotronSttConfig
      | SherpaOnlineNemotronEngine
      | { engine: SherpaOnlineNemotronEngine; defaultLanguage?: string },
    logger: pino.Logger,
    defaultLanguage?: string,
    silencePeakThreshold: number = 200,
  ) {
    this.logger = logger.child({
      module: "speech",
      provider: "local",
      component: "nemotron-stt",
    });
    this.silencePeakThreshold = silencePeakThreshold;
    if (configOrEngine instanceof SherpaOnlineNemotronEngine) {
      this.engine = configOrEngine;
      this.defaultLanguage = normalizeNemotronLanguage(
        defaultLanguage ?? configOrEngine.defaultLanguage,
      );
    } else if (
      "engine" in configOrEngine &&
      configOrEngine.engine instanceof SherpaOnlineNemotronEngine
    ) {
      this.engine = configOrEngine.engine;
      this.defaultLanguage = normalizeNemotronLanguage(
        defaultLanguage ?? configOrEngine.defaultLanguage ?? configOrEngine.engine.defaultLanguage,
      );
    } else {
      const cfg = configOrEngine as SherpaOnlineNemotronSttConfig;
      this.engine = new SherpaOnlineNemotronEngine(cfg, this.logger);
      this.defaultLanguage = normalizeNemotronLanguage(defaultLanguage ?? cfg.defaultLanguage);
    }
  }

  public createSession(params: {
    logger: pino.Logger;
    language?: string;
    prompt?: string;
  }): StreamingTranscriptionSession {
    return new SherpaOnlineNemotronRealtimeSession({
      engine: this.engine,
      language: params.language ?? this.defaultLanguage,
    });
  }

  public async transcribeAudio(audioBuffer: Buffer, format: string): Promise<TranscriptionResult> {
    const start = Date.now();
    if (audioBuffer.length === 0) {
      return {
        text: "",
        language: this.defaultLanguage,
        duration: 0,
        isLowConfidence: true,
      };
    }

    const fmt = format.trim().toLowerCase();
    let sampleRate = this.engine.sampleRate;
    let pcm16: Buffer;

    if (fmt.includes("audio/wav") || fmt === "audio/wave") {
      const parsed = parsePcm16MonoWav(audioBuffer);
      sampleRate = parsed.sampleRate;
      pcm16 = parsed.pcm16;
    } else if (fmt.includes("audio/pcm")) {
      sampleRate = parsePcmRateFromFormat(fmt, this.engine.sampleRate) ?? this.engine.sampleRate;
      pcm16 =
        audioBuffer.length % 2 === 0
          ? audioBuffer
          : audioBuffer.subarray(0, audioBuffer.length - 1);
    } else {
      throw new Error(`Unsupported audio format for Nemotron STT: ${format}`);
    }

    const peak = pcm16lePeakAbs(pcm16);
    if (peak < this.silencePeakThreshold) {
      return {
        text: "",
        language: this.defaultLanguage,
        duration: Date.now() - start,
        isLowConfidence: true,
      };
    }

    const float32 = pcm16leToFloat32(pcm16);
    return this.engine.transcribeFloat32(float32, sampleRate, this.defaultLanguage);
  }
}
