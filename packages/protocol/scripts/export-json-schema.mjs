// Exports JSON Schema for the WebSocket envelope and session message unions.
// Output feeds the Rust codegen in crates/paseo-protocol (see docs/refactors/rust-daemon-plan.md).
// Run with tsx (resolves the `.js` specifiers in src to `.ts`): `npm run protocol:schema`.
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import {
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
  WSInboundMessageSchema,
  WSOutboundMessageSchema,
} from "../src/messages.js";

// The Rust workspace lives in a sibling repo checkout (paseo-rs); override with PASEO_RS_DIR.
const rustRepo =
  process.env.PASEO_RS_DIR ?? resolve(process.env.HOME ?? "~", "Documents/AI/paseo-rs");
const outDir = resolve(rustRepo, "crates/paseo-protocol/schema");

const TARGETS = [
  { file: "ws-inbound.json", schema: WSInboundMessageSchema },
  { file: "ws-outbound.json", schema: WSOutboundMessageSchema },
  { file: "session-inbound.json", schema: SessionInboundMessageSchema },
  { file: "session-outbound.json", schema: SessionOutboundMessageSchema },
];

// Zod kinds that JSON Schema cannot express; with `unrepresentable: "any"` they become `{}`.
const UNREPRESENTABLE_KINDS = new Set([
  "custom",
  "transform",
  "date",
  "bigint",
  "symbol",
  "map",
  "set",
  "function",
  "promise",
  "nan",
  "undefined",
  "void",
  "never",
  "file",
]);

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys(value[key])]),
    );
  }
  return value;
}

await mkdir(outDir, { recursive: true });
const report = {};
for (const { file, schema } of TARGETS) {
  const unrepresentable = new Set();
  const jsonSchema = z.toJSONSchema(schema, {
    // Parsing semantics: defaulted fields are optional on the wire.
    io: "input",
    // typify (schemars 0.8) reads draft-07 `definitions`.
    target: "draft-7",
    unrepresentable: "any",
    reused: "ref",
    cycles: "ref",
    override: (ctx) => {
      // Wire fidelity: a typed `parse -> serialize` must not inject defaults the peer never sent.
      delete ctx.jsonSchema.default;
      const kind = ctx.zodSchema?._zod?.def?.type;
      if (UNREPRESENTABLE_KINDS.has(kind)) {
        unrepresentable.add(`${kind} @ ${ctx.path.join("/") || "<root>"}`);
      }
    },
  });
  await writeFile(resolve(outDir, file), `${JSON.stringify(sortKeys(jsonSchema), null, 1)}\n`);
  report[file] = [...unrepresentable].sort();
}

for (const [file, entries] of Object.entries(report)) {
  console.log(`${file}: ${entries.length} unrepresentable node(s)`);
  for (const entry of entries.slice(0, 40)) console.log(`  ${entry}`);
}
