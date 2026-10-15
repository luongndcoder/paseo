import type { Logger } from "pino";

import type { PaseoSpeechConfig } from "../../../bootstrap.js";
import type { SpeechToTextProvider } from "../../speech-provider.js";
import type { RequestedSpeechProviders } from "../../speech-types.js";
import { SonioxSTT } from "./stt.js";

export interface SonioxSpeechAvailability {
  configured: boolean;
}

export interface InitializedSonioxSpeech {
  sttService: SpeechToTextProvider | null;
  dictationSttService: SpeechToTextProvider | null;
  availability: SonioxSpeechAvailability;
}

export function getSonioxSpeechAvailability(
  speechConfig: PaseoSpeechConfig | null,
): SonioxSpeechAvailability {
  const apiKey = speechConfig?.soniox?.apiKey?.trim() ?? "";
  return {
    configured: apiKey.length > 0,
  };
}

export function initializeSonioxSpeechServices(params: {
  providers: RequestedSpeechProviders;
  speechConfig: PaseoSpeechConfig | null;
  logger: Logger;
  localVoiceSttProvider?: SpeechToTextProvider | null;
  localDictationSttProvider?: SpeechToTextProvider | null;
}): InitializedSonioxSpeech {
  const {
    providers,
    speechConfig,
    logger,
    localVoiceSttProvider = null,
    localDictationSttProvider = null,
  } = params;
  const availability = getSonioxSpeechAvailability(speechConfig);

  let sttService: SpeechToTextProvider | null = null;
  let dictationSttService: SpeechToTextProvider | null = null;

  const isVoiceSoniox =
    providers.voiceStt.enabled !== false && providers.voiceStt.provider === "soniox";
  if (isVoiceSoniox) {
    if (availability.configured || localVoiceSttProvider) {
      if (!availability.configured && localVoiceSttProvider) {
        logger.warn(
          { provider: "soniox", feature: "voiceStt" },
          "Soniox voice STT selected without API key; using Local (Sherpa) fallback until SONIOX_API_KEY is configured",
        );
      }
      sttService = new SonioxSTT({
        logger,
        getConfig: () => speechConfig?.soniox,
        fallbackProvider: localVoiceSttProvider,
      });
    } else {
      logger.warn(
        { configured: false },
        "Soniox voice STT selected but SONIOX_API_KEY and local fallback are unavailable",
      );
    }
  }

  const isDictationSoniox =
    providers.dictationStt.enabled !== false && providers.dictationStt.provider === "soniox";
  if (isDictationSoniox) {
    if (availability.configured || localDictationSttProvider) {
      if (!availability.configured && localDictationSttProvider) {
        logger.warn(
          { provider: "soniox", feature: "dictationStt" },
          "Soniox dictation STT selected without API key; using Local (Sherpa) fallback until SONIOX_API_KEY is configured",
        );
      }
      dictationSttService = new SonioxSTT({
        logger,
        getConfig: () => speechConfig?.soniox,
        fallbackProvider: localDictationSttProvider,
      });
    } else {
      logger.warn(
        { configured: false },
        "Soniox dictation STT selected but SONIOX_API_KEY and local fallback are unavailable",
      );
    }
  }

  return {
    sttService,
    dictationSttService,
    availability,
  };
}
