import type { AgentPermissionRequest, AgentStreamEvent } from "./agent/agent-sdk-types.js";
import { isSpeakToolName } from "@getpaseo/protocol/tool-name-normalization";

/** Voice assistant policy: only allow the speak tool. */
export function isVoicePermissionAllowed(request: AgentPermissionRequest): boolean {
  if (request.kind !== "tool") {
    return false;
  }

  const normalizedName = request.name.trim().toLowerCase();
  if (!normalizedName) {
    return false;
  }

  return isSpeakToolName(normalizedName);
}

/** Auto-allow gate for the agent-subscribe fan-out: voice mode active for the agent and a speak-tool request. */
export function shouldAutoAllowVoicePermission(input: {
  voiceActiveForAgent: boolean;
  event: AgentStreamEvent;
}): boolean {
  return (
    input.voiceActiveForAgent &&
    input.event.type === "permission_requested" &&
    isVoicePermissionAllowed(input.event.request)
  );
}
