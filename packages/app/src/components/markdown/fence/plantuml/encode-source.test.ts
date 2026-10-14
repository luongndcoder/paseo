import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { encodePlantUmlSource, normalizePlantUmlSource } from "./encode-source";

const PLANTUML_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";

function decodeBytes(encoded: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < encoded.length; i += 4) {
    const [c1, c2, c3, c4] = [0, 1, 2, 3].map((k) => PLANTUML_ALPHABET.indexOf(encoded[i + k]));
    out.push((c1 << 2) | (c2 >> 4), ((c2 & 0xf) << 4) | (c3 >> 2), ((c3 & 0x3) << 6) | c4);
  }
  return new Uint8Array(out);
}

// node:zlib stops at the end of the deflate stream; DecompressionStream rejects the zero padding.
function inflateRaw(bytes: Uint8Array): string {
  return inflateRawSync(bytes).toString("utf8");
}

describe("encodePlantUmlSource", () => {
  it("round-trips Vietnamese source through deflate and the PlantUML alphabet", async () => {
    const source = '@startuml\nactor "Cán bộ Hội sở" as ho\nho --> pr : Tạo chiến dịch\n@enduml';
    const encoded = await encodePlantUmlSource(source);
    expect(encoded).toMatch(/^[0-9A-Za-z\-_]+$/);
    // Padding bytes from the last 3-byte group decode as trailing zeros, which inflate ignores.
    expect(inflateRaw(decodeBytes(encoded))).toBe(source);
  });

  it("wraps bare diagram bodies in @startuml/@enduml", () => {
    expect(normalizePlantUmlSource("Bob -> Alice : hi")).toBe(
      "@startuml\nBob -> Alice : hi\n@enduml",
    );
    expect(normalizePlantUmlSource("@startmindmap\n* root\n@endmindmap")).toBe(
      "@startmindmap\n* root\n@endmindmap",
    );
  });
});
