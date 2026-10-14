// PlantUML's URL alphabet: base64 with its own ordering, see https://plantuml.com/text-encoding
const PLANTUML_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";

export const PLANTUML_SERVER_URL = "https://www.plantuml.com/plantuml";

function encodeBytes(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b1 = bytes[i];
    const b2 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b3 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out +=
      PLANTUML_ALPHABET[b1 >> 2] +
      PLANTUML_ALPHABET[((b1 & 0x3) << 4) | (b2 >> 4)] +
      PLANTUML_ALPHABET[((b2 & 0xf) << 2) | (b3 >> 6)] +
      PLANTUML_ALPHABET[b3 & 0x3f];
  }
  return out;
}

function encodeHex(bytes: Uint8Array): string {
  let out = "~h";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

async function deflateRaw(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function normalizePlantUmlSource(code: string): string {
  const trimmed = code.trim();
  return /^@start/i.test(trimmed) ? trimmed : `@startuml\n${trimmed}\n@enduml`;
}

// WHY: Vietnamese labels are 2-3 UTF-8 bytes each, so the uncompressed `~h` hex form makes
// HLD-sized diagrams exceed the server's URL limit. Deflate keeps the URL short; hex is only the
// fallback for runtimes without CompressionStream.
export async function encodePlantUmlSource(code: string): Promise<string> {
  const bytes = new TextEncoder().encode(normalizePlantUmlSource(code));
  if (typeof CompressionStream === "undefined") {
    return encodeHex(bytes);
  }
  return encodeBytes(await deflateRaw(bytes));
}

export async function buildPlantUmlSvgUrl(code: string): Promise<string> {
  return `${PLANTUML_SERVER_URL}/svg/${await encodePlantUmlSource(code)}`;
}
