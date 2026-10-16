import { describe, expect, test } from "vitest";

import type { AgentPermissionRequest } from "./agent/agent-sdk-types.js";
import type { AgentStreamEvent } from "./agent/agent-sdk-types.js";
import {
  isVoicePermissionAllowed,
  shouldAutoAllowVoicePermission,
} from "./voice-permission-policy.js";

function buildRequest(partial: Partial<AgentPermissionRequest>): AgentPermissionRequest {
  return {
    id: "req-1",
    provider: "codex",
    name: "unknown",
    kind: "tool",
    ...partial,
  };
}

describe("isVoicePermissionAllowed", () => {
  test("allows direct speak tool names across provider conventions", () => {
    const result = isVoicePermissionAllowed(buildRequest({ name: "speak" }));
    expect(result).toBe(true);
    expect(isVoicePermissionAllowed(buildRequest({ name: "paseo_voice.speak" }))).toBe(true);
    expect(isVoicePermissionAllowed(buildRequest({ name: "mcp__paseo_voice__speak" }))).toBe(true);
  });

  test("denies non-speak tool names", () => {
    expect(isVoicePermissionAllowed(buildRequest({ name: "mcp__paseo__create_agent" }))).toBe(
      false,
    );
    expect(isVoicePermissionAllowed(buildRequest({ name: "paseo_create_agent" }))).toBe(false);
  });

  test("denies non-tool permission kinds", () => {
    const result = isVoicePermissionAllowed(
      buildRequest({ kind: "mode", name: "mcp__paseo__create_agent" }),
    );
    expect(result).toBe(false);
  });

  test("denies wrapper tools even when metadata references speak", () => {
    const denied = isVoicePermissionAllowed(
      buildRequest({
        name: "codextool",
        metadata: {
          questions: [{ question: "Allow codextool to call paseo_voice.speak for user feedback?" }],
        },
      }),
    );
    expect(denied).toBe(false);
  });
});

describe("shouldAutoAllowVoicePermission", () => {
  const requested = (name: string): AgentStreamEvent =>
    ({
      type: "permission_requested",
      provider: "codex",
      request: buildRequest({ name }),
    }) as AgentStreamEvent;

  test("allows a speak request when voice is active for the agent", () => {
    expect(
      shouldAutoAllowVoicePermission({ voiceActiveForAgent: true, event: requested("speak") }),
    ).toBe(true);
  });

  test("denies when voice is not active for the agent", () => {
    expect(
      shouldAutoAllowVoicePermission({ voiceActiveForAgent: false, event: requested("speak") }),
    ).toBe(false);
  });

  test("denies non-speak requests and non-request events", () => {
    expect(
      shouldAutoAllowVoicePermission({
        voiceActiveForAgent: true,
        event: requested("mcp__paseo__create_agent"),
      }),
    ).toBe(false);
    expect(
      shouldAutoAllowVoicePermission({
        voiceActiveForAgent: true,
        event: { type: "turn_started", provider: "codex" } as AgentStreamEvent,
      }),
    ).toBe(false);
  });
});
