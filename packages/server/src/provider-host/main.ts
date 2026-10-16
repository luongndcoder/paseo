import { createInterface } from "node:readline";
import pino from "pino";

import { ProviderHost } from "./host.js";
import type { OutboundMessage } from "./protocol.js";

/**
 * Standalone provider host: JSONL-RPC over stdio. stdout carries protocol frames only;
 * logs go to stderr. See paseo-rs/crates/paseo-provider-host/RPC.md.
 */
export function runProviderHost(options?: {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}): Promise<void> {
  const input = options?.input ?? process.stdin;
  const output = options?.output ?? process.stdout;
  const logger = pino(
    { level: process.env.PASEO_PROVIDER_HOST_LOG_LEVEL ?? "warn" },
    pino.destination(2),
  );
  const send = (message: OutboundMessage) => {
    output.write(`${JSON.stringify(message)}\n`);
  };
  const lines = createInterface({ input, crlfDelay: Infinity });
  const host = new ProviderHost({ logger, send, onShutdown: () => lines.close() });
  lines.on("line", (line) => host.handleLine(line));
  return new Promise((resolve) => {
    lines.on("close", () => {
      void host.shutdown().finally(resolve);
    });
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  void runProviderHost().then(() => process.stdout.write("", () => process.exit(0)));
}
