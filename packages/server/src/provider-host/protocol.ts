/**
 * Wire types for the provider-host JSONL-RPC protocol. One JSON object per line over stdio.
 * The authoritative description lives in paseo-rs/crates/paseo-provider-host/RPC.md.
 */

export const PROVIDER_HOST_PROTOCOL_VERSION = 1;

export const RpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  Internal: -32603,
  Provider: -32000,
  UnknownProvider: -32001,
  UnknownSession: -32002,
  ShuttingDown: -32003,
  Canceled: -32800,
} as const;

export type RpcId = number | string;

export interface RpcRequest {
  id: RpcId;
  method: string;
  params?: unknown;
}

export interface RpcNotification {
  method: string;
  params?: unknown;
}

export interface RpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

export type RpcResponse =
  | { id: RpcId; result: unknown }
  | { id: RpcId | null; error: RpcErrorBody };

/** Frames the host writes. Requests are host -> client reverse calls (`tool.call`). */
export type OutboundMessage = RpcResponse | RpcNotification | RpcRequest;

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

/** Client -> host notification: abort the in-flight request `params.id`. */
export const CANCEL_METHOD = "$/cancel";
/** Host -> client notification: `{ handle, seq, event }`. */
export const SESSION_EVENT_METHOD = "session.event";
/** Host -> client notification: `{ handle }`, sent when a session closes on its own. */
export const SESSION_CLOSED_METHOD = "session.closed";

/** Host -> client request: run an internal Paseo tool. `{ agentId?, tool, arguments }`. */
export const TOOL_CALL_METHOD = "tool.call";
/** Host -> client notification: `{ level, message, data? }`. */
export const HOST_LOG_METHOD = "host.log";
