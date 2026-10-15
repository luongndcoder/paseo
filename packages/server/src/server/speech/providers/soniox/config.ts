import type { PersistedConfig } from "../../../persisted-config.js";

export const DEFAULT_SONIOX_WS_ENDPOINT = "wss://stt-rt.soniox.com/transcribe-websocket";
export const DEFAULT_SONIOX_STT_MODEL = "stt-rt-v5";
export const DEFAULT_SONIOX_LANGUAGE_HINTS = ["vi", "en"];

export interface SonioxSpeechProviderConfig {
  apiKey?: string;
  endpoint?: string;
  model?: string;
  languageHints?: string[];
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function parseLanguageHintsEnv(value: string | undefined): string[] | undefined {
  const trimmed = nonEmpty(value);
  if (!trimmed) {
    return undefined;
  }
  const hints = trimmed
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);
  return hints.length > 0 ? Array.from(new Set(hints)) : undefined;
}

export function resolveSonioxSpeechProviderConfigFromEnv(params: {
  env: NodeJS.ProcessEnv;
  persisted?: PersistedConfig;
}): SonioxSpeechProviderConfig {
  const { env, persisted } = params;
  const persistedSoniox = persisted?.providers?.soniox;
  const apiKey = nonEmpty(env.SONIOX_API_KEY) ?? nonEmpty(persistedSoniox?.apiKey);
  const endpoint =
    nonEmpty(env.SONIOX_STT_ENDPOINT) ??
    nonEmpty(persistedSoniox?.endpoint) ??
    DEFAULT_SONIOX_WS_ENDPOINT;
  const model =
    nonEmpty(env.SONIOX_STT_MODEL) ?? nonEmpty(persistedSoniox?.model) ?? DEFAULT_SONIOX_STT_MODEL;
  const languageHints =
    parseLanguageHintsEnv(env.SONIOX_LANGUAGE_HINTS) ??
    (persistedSoniox?.languageHints && persistedSoniox.languageHints.length > 0
      ? persistedSoniox.languageHints
      : DEFAULT_SONIOX_LANGUAGE_HINTS);

  return {
    ...(apiKey ? { apiKey } : {}),
    endpoint,
    model,
    languageHints,
  };
}
