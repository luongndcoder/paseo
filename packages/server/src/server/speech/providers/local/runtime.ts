import os from "node:os";
import path from "node:path";
import type { Logger } from "pino";

import type { PaseoSpeechConfig } from "../../../bootstrap.js";
import type { SpeechToTextProvider, TextToSpeechProvider } from "../../speech-provider.js";
import type { RequestedSpeechProviders } from "../../speech-types.js";
import type { TurnDetectionProvider } from "../../turn-detection-provider.js";
import {
  DEFAULT_LOCAL_STT_MODEL,
  DEFAULT_LOCAL_TTS_MODEL,
  LocalSttModelIdSchema,
  LocalTtsModelIdSchema,
  type LocalSpeechModelId,
  type LocalSttModelId,
  type LocalTtsModelId,
} from "./models.js";
import type { LocalSpeechProviderConfig } from "./config.js";
import { isNemotronModelInstalledSync } from "./sherpa/vietnamese-model.js";
import {
  LocalSpeechWorkerClient,
  WorkerBackedSpeechToTextProvider,
  WorkerBackedTextToSpeechProvider,
  WorkerBackedTurnDetectionProvider,
  createExternalWorkerForker,
} from "./worker-client.js";

interface ResolvedLocalModels {
  dictationLocalSttModel: LocalSttModelId;
  voiceLocalSttModel: LocalSttModelId;
  voiceLocalTtsModel: LocalTtsModelId;
}

interface LocalSpeechAvailability {
  configured: boolean;
  modelsDir: string | null;
}

export interface InitializedLocalSpeech {
  turnDetectionService: TurnDetectionProvider | null;
  sttService: SpeechToTextProvider | null;
  ttsService: TextToSpeechProvider | null;
  dictationSttService: SpeechToTextProvider | null;
  localVoiceSttProvider: SpeechToTextProvider | null;
  localDictationSttProvider: SpeechToTextProvider | null;
  localVoiceTtsProvider: TextToSpeechProvider | null;
  localModelConfig: {
    modelsDir: string;
    defaultModelIds: LocalSpeechModelId[];
    ensureVietnameseDictationModel?: boolean;
  } | null;
  availability: LocalSpeechAvailability;
  cleanup: () => void;
}

function resolveConfiguredLocalModels(speechConfig: PaseoSpeechConfig | null): ResolvedLocalModels {
  return {
    dictationLocalSttModel: LocalSttModelIdSchema.parse(
      speechConfig?.local?.models.dictationStt ?? DEFAULT_LOCAL_STT_MODEL,
    ),
    voiceLocalSttModel: LocalSttModelIdSchema.parse(
      speechConfig?.local?.models.voiceStt ?? DEFAULT_LOCAL_STT_MODEL,
    ),
    voiceLocalTtsModel: LocalTtsModelIdSchema.parse(
      speechConfig?.local?.models.voiceTts ?? DEFAULT_LOCAL_TTS_MODEL,
    ),
  };
}

export function getLocalSpeechAvailability(
  speechConfig: PaseoSpeechConfig | null,
): LocalSpeechAvailability {
  const localConfig = speechConfig?.local ?? null;
  return {
    configured: Boolean(localConfig),
    modelsDir: localConfig?.modelsDir ?? null,
  };
}

function isLocalOrSonioxProviderEnabled(provider: {
  enabled?: boolean;
  provider: string;
}): boolean {
  return (
    provider.enabled !== false && (provider.provider === "local" || provider.provider === "soniox")
  );
}

function isTempTestModelsDir(modelsDir: string | null | undefined): boolean {
  if (!modelsDir) {
    return false;
  }
  const normalized = path.resolve(modelsDir);
  const tmpDir = path.resolve(os.tmpdir());
  return (
    normalized.startsWith(tmpDir + path.sep) ||
    normalized.startsWith("/tmp/") ||
    normalized.startsWith("/private/tmp/") ||
    normalized.includes("paseo-missing-models-") ||
    normalized.includes("missing-local-speech-models")
  );
}

function shouldUseNemotronStt(params: {
  modelId: LocalSttModelId;
  language: string;
  modelsDir: string | null | undefined;
}): boolean {
  if (params.modelId === "nemotron-3.5-560ms-int8") {
    return true;
  }
  if (/^vi(?:-|$)/i.test(params.language)) {
    return true;
  }
  if (
    !isTempTestModelsDir(params.modelsDir) &&
    isNemotronModelInstalledSync(params.modelsDir ?? undefined)
  ) {
    return true;
  }
  return false;
}

function computeRequiredLocalModelIds(params: {
  providers: RequestedSpeechProviders;
  models: ResolvedLocalModels;
  language: string;
  modelsDir: string | null | undefined;
}): LocalSpeechModelId[] {
  const ids = new Set<LocalSpeechModelId>();
  if (isLocalOrSonioxProviderEnabled(params.providers.dictationStt)) {
    if (
      !shouldUseNemotronStt({
        modelId: params.models.dictationLocalSttModel,
        language: params.language,
        modelsDir: params.modelsDir,
      })
    ) {
      ids.add(params.models.dictationLocalSttModel);
    }
  }
  if (isLocalOrSonioxProviderEnabled(params.providers.voiceStt)) {
    if (
      !shouldUseNemotronStt({
        modelId: params.models.voiceLocalSttModel,
        language: params.language,
        modelsDir: params.modelsDir,
      })
    ) {
      ids.add(params.models.voiceLocalSttModel);
    }
  }
  if (
    params.providers.voiceTts.enabled !== false &&
    params.providers.voiceTts.provider === "local"
  ) {
    ids.add(params.models.voiceLocalTtsModel);
  }
  return Array.from(ids);
}

function isLocalProviderEnabled(provider: { enabled?: boolean; provider: string }): boolean {
  return provider.enabled !== false && provider.provider === "local";
}

function shouldEnsureVietnameseDictationModel(params: {
  providers: RequestedSpeechProviders;
  models: ResolvedLocalModels;
  language: string;
  modelsDir: string | null | undefined;
}): boolean {
  const dictationUsesNemotron =
    isLocalOrSonioxProviderEnabled(params.providers.dictationStt) &&
    shouldUseNemotronStt({
      modelId: params.models.dictationLocalSttModel,
      language: params.language,
      modelsDir: params.modelsDir,
    });
  const voiceUsesNemotron =
    isLocalOrSonioxProviderEnabled(params.providers.voiceStt) &&
    shouldUseNemotronStt({
      modelId: params.models.voiceLocalSttModel,
      language: params.language,
      modelsDir: params.modelsDir,
    });
  return dictationUsesNemotron || voiceUsesNemotron;
}

function resolveLocalDictationLanguage(speechConfig: PaseoSpeechConfig | null): string {
  return speechConfig?.sttLanguages?.dictation ?? "en";
}

function warnLocalConfigMissing(logger: Logger, feature: string): void {
  logger.warn(
    { configured: false },
    `Local ${feature} selected but local provider config is missing; ${feature} will be unavailable`,
  );
}

function initializeLocalTurnDetection(params: {
  client: LocalSpeechWorkerClient;
}): TurnDetectionProvider {
  const { client } = params;
  return new WorkerBackedTurnDetectionProvider(client);
}

function initializeLocalVoiceStt(params: {
  client: LocalSpeechWorkerClient;
}): SpeechToTextProvider {
  const { client } = params;
  return new WorkerBackedSpeechToTextProvider(client, "voiceStt");
}

function initializeLocalDictationStt(params: {
  client: LocalSpeechWorkerClient;
}): SpeechToTextProvider {
  const { client } = params;
  return new WorkerBackedSpeechToTextProvider(client, "dictationStt");
}

function initializeLocalVoiceTts(params: {
  client: LocalSpeechWorkerClient;
}): TextToSpeechProvider {
  const { client } = params;
  return new WorkerBackedTextToSpeechProvider(client);
}

function createExternalDictationSttProvider(params: {
  providers: RequestedSpeechProviders;
  speechConfig: PaseoSpeechConfig | null;
  localConfig: LocalSpeechProviderConfig | null;
  localModels: ResolvedLocalModels;
  dictationLanguage: string;
  logger: Logger;
}): SpeechToTextProvider | null {
  const { providers, speechConfig, localConfig, localModels, dictationLanguage, logger } = params;
  if (providers.dictationStt.enabled === false || providers.dictationStt.provider !== "external") {
    return null;
  }
  const command = speechConfig?.external?.dictationSttCommand?.trim();
  if (!command) {
    logger.warn(
      "Dictation STT provider is 'external' but no external command is configured; set " +
        "features.dictation.stt.external.command or PASEO_DICTATION_EXTERNAL_STT_COMMAND",
    );
    return null;
  }
  if (!localConfig) {
    warnLocalConfigMissing(logger, "external dictation STT (models dir)");
    return null;
  }
  const externalClient = new LocalSpeechWorkerClient({
    logger,
    config: {
      modelsDir: localConfig.modelsDir,
      voiceSttModel: localModels.voiceLocalSttModel,
      dictationSttModel: localModels.dictationLocalSttModel,
      dictationLanguage,
      voiceTtsModel: localModels.voiceLocalTtsModel,
      voiceTtsSpeakerId: speechConfig?.local?.models.voiceTtsSpeakerId,
      voiceTtsSpeed: speechConfig?.local?.models.voiceTtsSpeed,
    },
    forkWorker: createExternalWorkerForker(command),
  });
  return initializeLocalDictationStt({ client: externalClient });
}

function createBuiltInWorkerProviders(params: {
  localConfig: LocalSpeechProviderConfig | null;
  localModels: ResolvedLocalModels;
  dictationLanguage: string;
  speechConfig: PaseoSpeechConfig | null;
  logger: Logger;
}): {
  workerClient: LocalSpeechWorkerClient | null;
  localVoiceSttProvider: SpeechToTextProvider | null;
  localDictationSttProvider: SpeechToTextProvider | null;
} {
  const { localConfig, localModels, dictationLanguage, speechConfig, logger } = params;
  const workerClient = localConfig
    ? new LocalSpeechWorkerClient({
        logger,
        config: {
          modelsDir: localConfig.modelsDir,
          voiceSttModel: localModels.voiceLocalSttModel,
          dictationSttModel: localModels.dictationLocalSttModel,
          dictationLanguage,
          voiceTtsModel: localModels.voiceLocalTtsModel,
          voiceTtsSpeakerId: speechConfig?.local?.models.voiceTtsSpeakerId,
          voiceTtsSpeed: speechConfig?.local?.models.voiceTtsSpeed,
        },
      })
    : null;
  return {
    workerClient,
    localVoiceSttProvider: workerClient ? initializeLocalVoiceStt({ client: workerClient }) : null,
    localDictationSttProvider: workerClient
      ? initializeLocalDictationStt({ client: workerClient })
      : null,
  };
}

export async function initializeLocalSpeechServices(params: {
  providers: RequestedSpeechProviders;
  speechConfig: PaseoSpeechConfig | null;
  logger: Logger;
}): Promise<InitializedLocalSpeech> {
  const { providers, logger, speechConfig } = params;
  const localConfig = speechConfig?.local ?? null;
  const localModels = resolveConfiguredLocalModels(speechConfig);
  const dictationLanguage = resolveLocalDictationLanguage(speechConfig);
  const ensureVietnameseDictationModel = shouldEnsureVietnameseDictationModel({
    providers,
    models: localModels,
    language: dictationLanguage,
    modelsDir: localConfig?.modelsDir,
  });

  let sttService: SpeechToTextProvider | null = null;
  let ttsService: TextToSpeechProvider | null = null;
  let dictationSttService: SpeechToTextProvider | null = null;
  let turnDetectionService: TurnDetectionProvider | null = null;
  let localVoiceTtsProvider: TextToSpeechProvider | null = null;

  const requiredLocalModelIds = computeRequiredLocalModelIds({
    providers,
    models: localModels,
    language: dictationLanguage,
    modelsDir: localConfig?.modelsDir,
  });

  const { workerClient, localVoiceSttProvider, localDictationSttProvider } =
    createBuiltInWorkerProviders({
      localConfig,
      localModels,
      dictationLanguage,
      speechConfig,
      logger,
    });

  // Dictation STT can ride on an external worker module (e.g. the standalone paseo-voice-vi
  // package) while voice-mode features keep using the built-in worker. The external worker
  // speaks the same protocol, so the only difference is what gets forked.
  const externalDictationSttProvider = createExternalDictationSttProvider({
    providers,
    speechConfig,
    localConfig,
    localModels,
    dictationLanguage,
    logger,
  });

  if (isLocalProviderEnabled(providers.voiceTurnDetection)) {
    if (workerClient) {
      turnDetectionService = initializeLocalTurnDetection({ client: workerClient });
    } else {
      warnLocalConfigMissing(logger, "turn detection");
    }
  }

  if (isLocalProviderEnabled(providers.voiceStt)) {
    if (localVoiceSttProvider) {
      sttService = localVoiceSttProvider;
    } else {
      warnLocalConfigMissing(logger, "voice STT");
    }
  }

  if (isLocalProviderEnabled(providers.dictationStt)) {
    if (localDictationSttProvider) {
      dictationSttService = localDictationSttProvider;
    } else {
      warnLocalConfigMissing(logger, "dictation STT");
    }
  } else if (providers.dictationStt.provider === "external") {
    if (externalDictationSttProvider) {
      dictationSttService = externalDictationSttProvider;
    }
  }

  if (isLocalProviderEnabled(providers.voiceTts)) {
    if (workerClient) {
      localVoiceTtsProvider = initializeLocalVoiceTts({ client: workerClient });
    } else {
      warnLocalConfigMissing(logger, "voice TTS");
    }
    if (localVoiceTtsProvider) {
      ttsService = localVoiceTtsProvider;
    }
  }

  const cleanup = () => {
    workerClient?.shutdown();
  };

  return {
    turnDetectionService,
    sttService,
    ttsService,
    dictationSttService,
    localVoiceSttProvider,
    localDictationSttProvider,
    localVoiceTtsProvider,
    localModelConfig: localConfig
      ? {
          modelsDir: localConfig.modelsDir,
          defaultModelIds: requiredLocalModelIds,
          ensureVietnameseDictationModel,
        }
      : null,
    availability: getLocalSpeechAvailability(speechConfig),
    cleanup,
  };
}
