---
title: Voice
description: Paseo voice architecture, local-first model execution, and provider configuration.
nav: Voice
order: 41
category: Configuration
---

# Voice

Paseo has first-class voice support for dictation and voice mode conversations with your coding environment.

## Philosophy

Voice is local-first. You can run speech fully on-device, or choose OpenAI for speech features. For voice reasoning/orchestration, Paseo reuses agent providers already installed and authenticated on your machine.

This keeps credentials and execution in your environment and avoids introducing a separate cloud-only voice stack.

## Architecture

- Speech I/O: STT and TTS providers per feature (`local` or `openai`)
- Local speech runtime: ONNX models executed on CPU by default
- Voice LLM orchestration: hidden agent session using your configured provider (`claude`, `codex`, or `opencode`)
- Tooling path: MCP stdio bridge for voice tools and agent control

## Local Speech

Local speech defaults to model IDs `parakeet-tdt-0.6b-v2-int8` (STT) and `kokoro-en-v0_19` (TTS, speaker 0 / voice 00).

Missing models are downloaded at daemon startup into `$PASEO_HOME/models/local-speech`. Downloads happen only for missing files.

### Local STT models and language support

| Model ID                              | Languages                                                                                                                                                                                                                                                                    |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parakeet-tdt-0.6b-v2-int8`           | English only (default). Includes punctuation and capitalization.                                                                                                                                                                                                             |
| `parakeet-tdt-0.6b-v3-int8`           | 25 European languages, auto-detected: Bulgarian, Croatian, Czech, Danish, Dutch, English, Estonian, Finnish, French, German, Greek, Hungarian, Italian, Latvian, Lithuanian, Maltese, Polish, Portuguese, Romanian, Russian, Slovak, Slovenian, Spanish, Swedish, Ukrainian. |
| `language: "vi"` with local dictation | Vietnamese Zipformer 30M INT8. Paseo downloads the Sherpa-ONNX conversion in the background when the daemon starts; partial text refreshes while audio arrives.                                                                                                              |

To use Vietnamese local dictation, set `features.dictation.stt.language` to `vi`. If the local provider is enabled for dictation, Paseo downloads the Vietnamese model in the background at daemon startup and reports readiness while it is downloading. Other languages keep the configured local model. Parakeet v3 detects its supported European languages automatically. The `language` field also applies to OpenAI STT.

```json
{
  "version": 1,
  "features": {
    "dictation": {
      "stt": { "provider": "local", "language": "vi" }
    },
    "voiceMode": {
      "llm": { "provider": "claude", "model": "haiku" },
      "stt": { "provider": "local", "model": "parakeet-tdt-0.6b-v2-int8", "language": "en" },
      "tts": { "provider": "local", "model": "kokoro-en-v0_19", "speakerId": 0 }
    }
  },
  "providers": {
    "local": {
      "modelsDir": "~/.paseo/models/local-speech"
    }
  }
}
```

For multilingual local dictation, set the model to v3 — it auto-detects the language, so no `language` field is needed:

```json
{
  "version": 1,
  "features": {
    "dictation": {
      "stt": { "provider": "local", "model": "parakeet-tdt-0.6b-v3-int8" }
    }
  }
}
```

Local Vietnamese dictation uses the Zipformer 30M model built from [hynt/Zipformer-30M-RNNT-Streaming-6000h](https://huggingface.co/hynt/Zipformer-30M-RNNT-Streaming-6000h), downloaded as a Sherpa-ONNX conversion at runtime. The source model is published under `CC BY-NC-ND 4.0`; this implementation does not bundle or redistribute the model. Keep this setup for non-commercial internal use, and obtain the appropriate permission or license before commercial deployment or redistribution.

The voice-mode `language` field applies to OpenAI STT. If voice language is omitted, Paseo uses the dictation language before falling back to `en`. Local voice-mode STT continues using its configured model.

## OpenAI Voice Option

You can switch dictation, voice STT, and voice TTS to OpenAI by setting provider fields to `openai` and providing OpenAI credentials.

```json
{
  "version": 1,
  "features": {
    "dictation": { "stt": { "provider": "openai" } },
    "voiceMode": {
      "stt": { "provider": "openai" },
      "tts": { "provider": "openai" }
    }
  },
  "providers": {
    "openai": {
      "stt": {
        "apiKey": "...",
        "baseUrl": "https://api.openai.com/v1"
      },
      "tts": {
        "apiKey": "...",
        "baseUrl": "https://api.openai.com/v1"
      }
    }
  }
}
```

`providers.openai.stt` covers dictation and voice mode speech-to-text, and `providers.openai.tts` covers voice mode text-to-speech. Because they resolve independently, you can point STT and TTS at different endpoints. Each falls back to `providers.openai.apiKey`/`baseUrl`, then `OPENAI_API_KEY`/`OPENAI_BASE_URL`, when unset. These settings configure only Paseo OpenAI speech traffic, without changing Codex or other OpenAI-backed tools.

Paseo uses these paths under the configured OpenAI base URL:

- dictation STT: `/v1/audio/transcriptions`
- voice mode STT: `/v1/audio/transcriptions`
- voice mode TTS: `/v1/audio/speech`

## Environment Variables

- `PASEO_VOICE_LLM_PROVIDER`, voice agent provider override
- `PASEO_DICTATION_STT_PROVIDER`, `PASEO_VOICE_STT_PROVIDER`, `PASEO_VOICE_TTS_PROVIDER`, speech provider selection (`local` or `openai`)
- `OPENAI_STT_API_KEY`, `OPENAI_STT_BASE_URL`, OpenAI speech-to-text endpoint (dictation + voice mode STT)
- `OPENAI_TTS_API_KEY`, `OPENAI_TTS_BASE_URL`, OpenAI text-to-speech endpoint (voice mode TTS)
- `PASEO_LOCAL_MODELS_DIR`, local model storage directory
- `PASEO_DICTATION_LOCAL_STT_MODEL`, local dictation STT model ID
- `PASEO_VOICE_LOCAL_STT_MODEL`, `PASEO_VOICE_LOCAL_TTS_MODEL`, local voice STT/TTS model IDs
- `PASEO_DICTATION_LANGUAGE`, dictation STT language; `vi` selects the local Vietnamese model when dictation uses local STT
- `PASEO_VOICE_LANGUAGE`, voice mode STT language; falls back to `PASEO_DICTATION_LANGUAGE` when unset (applies to OpenAI STT)
- `PASEO_VOICE_LOCAL_TTS_SPEAKER_ID`, `PASEO_VOICE_LOCAL_TTS_SPEED`, optional local voice TTS tuning

## Operational Notes

Voice mode can launch and control agents. Treat voice prompts with the same care as direct agent instructions, especially when specifying working directories or destructive operations.
