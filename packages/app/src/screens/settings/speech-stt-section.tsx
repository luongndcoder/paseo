import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { MutableSpeechSttProviderId } from "@getpaseo/protocol/messages";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { DropdownTrigger } from "@/components/ui/dropdown-trigger";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { useToast } from "@/contexts/toast-context";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";

interface SttProviderOption {
  id: MutableSpeechSttProviderId;
  label: string;
  shortLabel: string;
}

const STT_PROVIDER_OPTIONS: readonly SttProviderOption[] = [
  {
    id: "local",
    label: "Local (Nemotron 3.5 ASR — Vietnamese / English)",
    shortLabel: "Local (Nemotron 3.5)",
  },
  {
    id: "soniox",
    label: "Soniox (Realtime WebSocket + Local Fallback)",
    shortLabel: "Soniox (Realtime)",
  },
  {
    id: "openai",
    label: "OpenAI (Cloud Transcription)",
    shortLabel: "OpenAI",
  },
];

interface LanguageOption {
  id: string;
  label: string;
}

const STT_LANGUAGE_OPTIONS: readonly LanguageOption[] = [
  { id: "vi", label: "Tiếng Việt (vi)" },
  { id: "en", label: "English (en)" },
];

function resolveProviderShortLabel(id: MutableSpeechSttProviderId): string {
  return STT_PROVIDER_OPTIONS.find((opt) => opt.id === id)?.shortLabel ?? id;
}

function resolveLanguageLabel(id: string): string {
  return STT_LANGUAGE_OPTIONS.find((opt) => opt.id === id)?.label ?? id;
}

export function SpeechSttSettingsSection({ serverId }: { serverId: string }) {
  const toast = useToast();
  const isConnected = useHostRuntimeIsConnected(serverId);
  const { config, patchConfig } = useDaemonConfig(serverId);

  const speech = config?.speech;
  const dictationProvider: MutableSpeechSttProviderId = speech?.dictationSttProvider ?? "local";
  const voiceProvider: MutableSpeechSttProviderId = speech?.voiceSttProvider ?? "local";
  const dictationLanguage = speech?.dictationLanguage ?? "vi";
  const configuredApiKey = speech?.sonioxApiKey ?? "";
  const configuredModel = speech?.sonioxModel ?? "stt-rt-v5";
  const configuredHintsText = useMemo(
    () => (speech?.sonioxLanguageHints ?? ["vi", "en"]).join(", "),
    [speech?.sonioxLanguageHints],
  );

  const [apiKeyDraft, setApiKeyDraft] = useState(configuredApiKey);
  const [modelDraft, setModelDraft] = useState(configuredModel);
  const [hintsDraft, setHintsDraft] = useState(configuredHintsText);
  const [showApiKey, setShowApiKey] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [resetCounter, setResetCounter] = useState(0);

  useEffect(() => {
    setApiKeyDraft(configuredApiKey);
    setModelDraft(configuredModel);
    setHintsDraft(configuredHintsText);
    setResetCounter((c) => c + 1);
  }, [configuredApiKey, configuredModel, configuredHintsText]);

  const handleSelectDictationProvider = useCallback(
    async (provider: MutableSpeechSttProviderId) => {
      try {
        await patchConfig({
          speech: {
            dictationSttProvider: provider,
          },
        });
        toast.show(`Dictation STT switched to ${resolveProviderShortLabel(provider)}`, {
          variant: "success",
        });
      } catch (error) {
        Alert.alert(
          "Unable to update Dictation STT provider",
          error instanceof Error ? error.message : String(error),
        );
      }
    },
    [patchConfig, toast],
  );

  const handleSelectVoiceProvider = useCallback(
    async (provider: MutableSpeechSttProviderId) => {
      try {
        await patchConfig({
          speech: {
            voiceSttProvider: provider,
          },
        });
        toast.show(`Voice Mode STT switched to ${resolveProviderShortLabel(provider)}`, {
          variant: "success",
        });
      } catch (error) {
        Alert.alert(
          "Unable to update Voice Mode STT provider",
          error instanceof Error ? error.message : String(error),
        );
      }
    },
    [patchConfig, toast],
  );

  const handleSelectLanguage = useCallback(
    async (lang: string) => {
      try {
        await patchConfig({
          speech: {
            dictationLanguage: lang,
            voiceLanguage: lang,
          },
        });
        toast.show(`STT language set to ${resolveLanguageLabel(lang)}`, {
          variant: "success",
        });
      } catch (error) {
        Alert.alert(
          "Unable to update STT language",
          error instanceof Error ? error.message : String(error),
        );
      }
    },
    [patchConfig, toast],
  );

  const handleSaveSoniox = useCallback(async () => {
    if (isSaving) return;
    setIsSaving(true);
    try {
      const parsedHints = hintsDraft
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
      const nextHints = parsedHints.length > 0 ? parsedHints : ["vi", "en"];
      const trimmedKey = apiKeyDraft.trim();
      const trimmedModel = modelDraft.trim() || "stt-rt-v5";

      await patchConfig({
        speech: {
          sonioxApiKey: trimmedKey,
          sonioxModel: trimmedModel,
          sonioxLanguageHints: nextHints,
          ...(trimmedKey.length > 0 && dictationProvider === "local"
            ? {
                dictationSttProvider: "soniox",
                voiceSttProvider: "soniox",
              }
            : {}),
        },
      });
      toast.show(
        trimmedKey.length > 0
          ? "Soniox API configuration saved"
          : "Soniox API key cleared (using Local Sherpa fallback)",
        { variant: "success" },
      );
    } catch (error) {
      Alert.alert(
        "Unable to save Soniox settings",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setIsSaving(false);
    }
  }, [apiKeyDraft, dictationProvider, hintsDraft, isSaving, modelDraft, patchConfig, toast]);

  const toggleShowApiKey = useCallback(() => {
    setShowApiKey((prev) => !prev);
  }, []);

  if (!isConnected) {
    return null;
  }

  const hasConfiguredKey = configuredApiKey.trim().length > 0;
  const isDirty =
    apiKeyDraft.trim() !== configuredApiKey.trim() ||
    modelDraft.trim() !== configuredModel.trim() ||
    hintsDraft.trim() !== configuredHintsText.trim();

  return (
    <SettingsSection
      title="Speech & Dictation (STT)"
      testID="host-page-speech-stt-section"
      style={styles.section}
    >
      <View style={settingsStyles.card} testID="host-page-speech-stt-card">
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>Dictation STT Engine</Text>
            <Text style={settingsStyles.rowHint}>
              Speech-to-text engine for microphone dictation input
            </Text>
          </View>
          <DropdownMenu>
            <DropdownTrigger
              testID="speech-dictation-provider-trigger"
              accessibilityRole="button"
              accessibilityLabel="Dictation STT Engine"
            >
              {resolveProviderShortLabel(dictationProvider)}
            </DropdownTrigger>
            <DropdownMenuContent side="bottom" align="end" width={310}>
              {STT_PROVIDER_OPTIONS.map((option) => (
                <DropdownMenuItem
                  key={option.id}
                  selected={option.id === dictationProvider}
                  onSelect={() => {
                    void handleSelectDictationProvider(option.id);
                  }}
                >
                  {option.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </View>

        <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>Realtime Voice Mode STT</Text>
            <Text style={settingsStyles.rowHint}>
              Streaming transcription provider for hands-free voice sessions
            </Text>
          </View>
          <DropdownMenu>
            <DropdownTrigger
              testID="speech-voice-provider-trigger"
              accessibilityRole="button"
              accessibilityLabel="Realtime Voice Mode STT"
            >
              {resolveProviderShortLabel(voiceProvider)}
            </DropdownTrigger>
            <DropdownMenuContent side="bottom" align="end" width={310}>
              {STT_PROVIDER_OPTIONS.map((option) => (
                <DropdownMenuItem
                  key={option.id}
                  selected={option.id === voiceProvider}
                  onSelect={() => {
                    void handleSelectVoiceProvider(option.id);
                  }}
                >
                  {option.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </View>

        <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>Primary Language</Text>
            <Text style={settingsStyles.rowHint}>
              Used for offline Local Sherpa model selection & language hints
            </Text>
          </View>
          <DropdownMenu>
            <DropdownTrigger
              testID="speech-language-trigger"
              accessibilityRole="button"
              accessibilityLabel="Primary STT Language"
            >
              {resolveLanguageLabel(dictationLanguage)}
            </DropdownTrigger>
            <DropdownMenuContent side="bottom" align="end" width={220}>
              {STT_LANGUAGE_OPTIONS.map((option) => (
                <DropdownMenuItem
                  key={option.id}
                  selected={option.id === dictationLanguage}
                  onSelect={() => {
                    void handleSelectLanguage(option.id);
                  }}
                >
                  {option.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </View>

        <View style={[styles.sonioxPanel, settingsStyles.rowBorder]}>
          <View style={styles.sonioxHeaderRow}>
            <View style={styles.sonioxTitleGroup}>
              <Text style={settingsStyles.rowTitle}>Soniox Realtime WebSocket API</Text>
              <Text style={settingsStyles.rowHint}>
                Streams 16kHz PCM16 audio to wss://stt-rt.soniox.com with automatic Local Sherpa
                fallback on disconnect or missing key
              </Text>
            </View>
            <View
              style={[
                styles.statusPill,
                {
                  borderColor: hasConfiguredKey ? "#10b981" : "#f59e0b",
                },
              ]}
            >
              <View
                style={[
                  styles.statusDot,
                  { backgroundColor: hasConfiguredKey ? "#10b981" : "#f59e0b" },
                ]}
              />
              <Text
                style={[styles.statusPillText, { color: hasConfiguredKey ? "#10b981" : "#f59e0b" }]}
              >
                {hasConfiguredKey ? "API Key Active" : "Local Fallback"}
              </Text>
            </View>
          </View>

          <View style={styles.fieldsColumn}>
            <Field
              label="Soniox API Key (SONIOX_API_KEY)"
              hint="Stored in ~/.paseo/config.json under providers.soniox.apiKey"
              testID="soniox-api-key-field"
            >
              <View style={styles.apiKeyInputRow}>
                <View style={styles.apiKeyInputWrapper}>
                  <FormTextInput
                    initialValue={configuredApiKey}
                    resetKey={`key-${resetCounter}-${showApiKey ? "plain" : "masked"}`}
                    onChangeText={setApiKeyDraft}
                    placeholder="Enter Soniox API Key..."
                    autoCapitalize="none"
                    autoCorrect={false}
                    secureTextEntry={!showApiKey}
                    editable={!isSaving}
                    testID="soniox-api-key-input"
                  />
                </View>
                <Button
                  variant="secondary"
                  size="sm"
                  onPress={toggleShowApiKey}
                  testID="soniox-api-key-toggle"
                >
                  {showApiKey ? "Hide" : "Show"}
                </Button>
              </View>
            </Field>

            <View style={styles.twoColRow}>
              <View style={styles.halfCol}>
                <Field label="Realtime Model" hint="Default: stt-rt-v5" testID="soniox-model-field">
                  <FormTextInput
                    initialValue={configuredModel}
                    resetKey={`model-${resetCounter}`}
                    onChangeText={setModelDraft}
                    placeholder="stt-rt-v5"
                    autoCapitalize="none"
                    autoCorrect={false}
                    editable={!isSaving}
                    testID="soniox-model-input"
                  />
                </Field>
              </View>

              <View style={styles.halfCol}>
                <Field
                  label="Language Hints"
                  hint="Comma-separated (e.g. vi, en)"
                  testID="soniox-hints-field"
                >
                  <FormTextInput
                    initialValue={configuredHintsText}
                    resetKey={`hints-${resetCounter}`}
                    onChangeText={setHintsDraft}
                    placeholder="vi, en"
                    autoCapitalize="none"
                    autoCorrect={false}
                    editable={!isSaving}
                    testID="soniox-hints-input"
                  />
                </Field>
              </View>
            </View>

            <View style={styles.actionsRow}>
              <Button
                variant="default"
                size="sm"
                onPress={() => {
                  void handleSaveSoniox();
                }}
                disabled={isSaving || !isDirty}
                testID="soniox-save-button"
              >
                {isSaving ? "Saving..." : "Save Soniox Config"}
              </Button>
            </View>
          </View>
        </View>
      </View>
    </SettingsSection>
  );
}

const styles = StyleSheet.create((theme) => ({
  section: {
    marginBottom: theme.spacing[4],
  },
  sonioxPanel: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[4],
    gap: theme.spacing[3],
  },
  sonioxHeaderRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    flexWrap: "wrap",
  },
  sonioxTitleGroup: {
    flex: 1,
    minWidth: 200,
    gap: 2,
  },
  statusPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 4,
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    backgroundColor: theme.colors.surface2,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  statusPillText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  fieldsColumn: {
    gap: theme.spacing[3],
    marginTop: theme.spacing[1],
  },
  apiKeyInputRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  apiKeyInputWrapper: {
    flex: 1,
  },
  twoColRow: {
    flexDirection: "row",
    gap: theme.spacing[3],
    flexWrap: "wrap",
  },
  halfCol: {
    flex: 1,
    minWidth: 180,
  },
  actionsRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
    marginTop: theme.spacing[1],
  },
}));
