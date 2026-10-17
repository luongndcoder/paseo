import pino from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";

const { openAiConstructorOptionsMock, transcriptionsCreateMock } = vi.hoisted(() => ({
  openAiConstructorOptionsMock: vi.fn(),
  transcriptionsCreateMock: vi.fn(),
}));

vi.mock("openai", () => ({
  OpenAI: vi.fn(function OpenAI(options: unknown) {
    openAiConstructorOptionsMock(options);
    return {
      audio: {
        transcriptions: {
          create: transcriptionsCreateMock,
        },
      },
    };
  }),
}));

import { OpenAISTT } from "./stt.js";

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  return chunks;
}

describe("OpenAISTT", () => {
  afterEach(() => {
    openAiConstructorOptionsMock.mockReset();
    transcriptionsCreateMock.mockReset();
  });

  test("passes configured baseUrl to the OpenAI client", () => {
    const provider = new OpenAISTT(
      { apiKey: "sk-test", baseUrl: "https://speech.example.com/v1" },
      pino({ level: "silent" }),
    );

    expect(provider.id).toBe("openai");
    expect(openAiConstructorOptionsMock).toHaveBeenCalledWith({
      apiKey: "sk-test",
      baseURL: "https://speech.example.com/v1",
    });
  });

  test("passes transcription prompt to OpenAI REST STT", async () => {
    transcriptionsCreateMock.mockImplementation(
      async (request: { file: NodeJS.ReadableStream }) => {
        await new Promise<void>((resolve, reject) => {
          request.file.once("error", reject);
          request.file.once("end", resolve);
          request.file.resume();
        });
        return { text: "hello" };
      },
    );

    const provider = new OpenAISTT(
      { apiKey: "sk-test", model: "gpt-4o-transcribe" },
      pino({ level: "silent" }),
    );
    const session = provider.createSession({
      logger: pino({ level: "silent" }),
      language: "en",
      prompt: "Only transcribe the speaker.",
    });

    const transcript = new Promise<string>((resolve, reject) => {
      session.on("transcript", (event) => {
        if (event.isFinal) {
          resolve(event.transcript);
        }
      });
      session.on("error", (error) => {
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });

    await session.connect();
    session.appendPcm16(Buffer.from([0, 0, 0, 0]));
    session.commit();

    await expect(transcript).resolves.toBe("hello");
    expect(transcriptionsCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        language: "en",
        model: "gpt-4o-transcribe",
        prompt: "Only transcribe the speaker.",
        response_format: "json",
      }),
    );
  });
  test("keeps audio appended during an in-flight transcription for the next segment", async () => {
    const bodies: Buffer[] = [];
    const gates: Array<() => void> = [];
    transcriptionsCreateMock.mockImplementation(
      async (request: { file: NodeJS.ReadableStream }) => {
        const chunks = await readAll(request.file);
        bodies.push(Buffer.concat(chunks));
        await new Promise<void>((resolve) => gates.push(resolve));
        return { text: `t${bodies.length}` };
      },
    );

    const provider = new OpenAISTT({ apiKey: "sk-test" }, pino({ level: "silent" }));
    const session = provider.createSession({ logger: pino({ level: "silent" }), language: "en" });
    const committed: Array<{ segmentId: string; previousSegmentId: string | null }> = [];
    const finals: Array<{ segmentId: string; transcript: string }> = [];
    session.on("committed", (p) => committed.push(p));
    session.on("transcript", (p) => {
      if (p.isFinal) finals.push(p);
    });

    await session.connect();
    session.appendPcm16(Buffer.from([1, 0, 1, 0]));
    session.commit();
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    session.appendPcm16(Buffer.from([2, 0, 2, 0]));
    session.commit();
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    gates.forEach((g) => g());
    await vi.waitFor(() => expect(finals).toHaveLength(2));

    expect(committed[1]?.segmentId).not.toBe(committed[0]?.segmentId);
    expect(bodies[0]?.subarray(44)).toEqual(Buffer.from([1, 0, 1, 0]));
    expect(bodies[1]?.subarray(44)).toEqual(Buffer.from([2, 0, 2, 0]));
  });
});
