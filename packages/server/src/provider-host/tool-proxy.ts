import { z } from "zod";

import type {
  PaseoToolCatalog,
  PaseoToolDefinition,
  PaseoToolResult,
} from "../server/agent/tools/types.js";

/** Wire form of one internal Paseo tool (`LaunchContext.paseoTools[]`). */
export interface ToolSpec {
  name: string;
  description: string;
  title?: string;
  /** JSON Schema of the tool input. */
  inputSchema?: Record<string, unknown>;
}

export type ToolInvoker = (
  name: string,
  input: unknown,
  signal: AbortSignal | undefined,
) => Promise<PaseoToolResult>;

function inputSchemaOf(spec: ToolSpec): z.ZodType {
  if (!spec.inputSchema) return z.object({});
  try {
    return z.fromJSONSchema(spec.inputSchema as Parameters<typeof z.fromJSONSchema>[0]);
  } catch {
    // An unconvertible schema must not hide the tool; the client validates the input anyway.
    return z.looseObject({});
  }
}

/**
 * A `PaseoToolCatalog` whose tools run in the client (the Rust core) through the reverse
 * `tool.call` request. Providers consume it exactly like the in-process catalog.
 */
export function createProxyToolCatalog(specs: ToolSpec[], invoke: ToolInvoker): PaseoToolCatalog {
  const tools = new Map<string, PaseoToolDefinition>();
  for (const spec of specs) {
    tools.set(spec.name, {
      name: spec.name,
      description: spec.description,
      ...(spec.title ? { title: spec.title } : {}),
      inputSchema: inputSchemaOf(spec),
      handler: (input, context) => invoke(spec.name, input, context.signal),
    });
  }
  return {
    tools,
    getTool: (name) => tools.get(name),
    executeTool: async (name, input, context) => {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Paseo tool not found: ${name}`);
      return tool.handler(input, context ?? {});
    },
  };
}
