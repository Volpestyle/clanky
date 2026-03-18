import { normalizeProviderOrder } from "./primitives.ts";
import {
  CODING_WORKER_RUNTIME_KINDS,
  DEFAULT_SETTINGS,
  type Settings,
  type SettingsCodingWorkerName,
  type SettingsModelBinding
} from "../../settings/settingsSchema.ts";
import { SETTINGS_NUMERIC_CONSTRAINTS } from "../../settings/settingsConstraints.ts";
import {
  OPENAI_REALTIME_DEFAULT_TRANSCRIPTION_MODEL,
  normalizeOpenAiRealtimeTranscriptionModel
} from "../../voice/realtimeProviderNormalization.ts";
import { normalizeVoiceRuntimeMode } from "../../voice/voiceModes.ts";
import {
  isRecord,
  normalizeBoolean,
  normalizeHttpBaseUrl,
  normalizeInt,
  normalizeNumber,
  normalizeOpenAiRealtimeAudioFormat,
  normalizeOpenAiRealtimeTranscriptionMethod,
  normalizeOptionalString,
  normalizeString,
  normalizeStringList
} from "./primitives.ts";
import {
  type AgentStackPresetConfig,
  normalizeAgentSessionToolPolicy,
  normalizeBrowserExecutionPolicy,
  normalizeClaudeCodeContextPruningStrategy,
  normalizeClaudeCodeSessionScope,
  normalizeExecutionPolicy,
  normalizeModelBinding
} from "./shared.ts";

const CODING_WORKER_SET = new Set<SettingsCodingWorkerName>(CODING_WORKER_RUNTIME_KINDS);

function normalizeCodingWorkerName(value: unknown): SettingsCodingWorkerName | undefined {
  const normalized = normalizeString(value, "", 40).toLowerCase() as SettingsCodingWorkerName;
  return CODING_WORKER_SET.has(normalized) ? normalized : undefined;
}

function normalizeOpenAiComputerUseClient(value: unknown) {
  const normalized = normalizeString(value, "auto", 40).trim().toLowerCase();
  if (normalized === "openai" || normalized === "openai-oauth") {
    return normalized;
  }
  return DEFAULT_SETTINGS.agentStack.runtimeConfig.browser.openaiComputerUse.client;
}

function normalizeCodingWorkerList(value: unknown) {
  return normalizeStringList(value, 4, 40)
    .map((entry) => normalizeCodingWorkerName(entry))
    .filter((entry): entry is SettingsCodingWorkerName => entry !== undefined);
}

export function normalizeAgentStackSection(
  section: Settings["agentStack"],
  rawAgentStack: Record<string, unknown>,
  rawOverrides: Record<string, unknown>,
  presetConfig: AgentStackPresetConfig,
  orchestratorOverride: SettingsModelBinding
): Settings["agentStack"] {
  const runtimeConfig = section.runtimeConfig;
  const research = runtimeConfig.research;
  const browser = runtimeConfig.browser;
  const voice = runtimeConfig.voice;
  const claudeOAuthSession = runtimeConfig.claudeOAuthSession;
  const devTeam = runtimeConfig.devTeam;
  const rawDevTeamOverride = isRecord(rawOverrides.devTeam) ? rawOverrides.devTeam : null;
  const rawRuntimeConfig = isRecord(rawAgentStack.runtimeConfig) ? rawAgentStack.runtimeConfig : {};
  const rawVoiceRuntime = isRecord(rawRuntimeConfig.voice) ? rawRuntimeConfig.voice : {};
  const rawVoiceMusicBrain = rawVoiceRuntime.musicBrain;
  const rawVoiceGeneration = rawVoiceRuntime.generation;
  const rawVoiceAdmissionOverride = rawOverrides.voiceAdmissionClassifier;
  const rawVoiceInterruptOverride = rawOverrides.voiceInterruptClassifier;

  const overrides: Settings["agentStack"]["overrides"] = {
    orchestrator: orchestratorOverride
  };

  if (rawVoiceAdmissionOverride !== undefined || presetConfig.presetVoiceAdmissionClassifierFallback) {
    const fallback = presetConfig.presetVoiceAdmissionClassifierFallback
      || presetConfig.presetOrchestratorFallback;
    const shouldSeedClassifierOverride =
      rawVoiceAdmissionOverride !== undefined || presetConfig.presetVoiceAdmissionMode !== "generation_decides";
    if (shouldSeedClassifierOverride) {
      overrides.voiceAdmissionClassifier = normalizeExecutionPolicy(
        rawVoiceAdmissionOverride,
        fallback.provider,
        fallback.model,
        { fallbackMode: "dedicated_model" }
      );
    }
  }

  if (rawVoiceInterruptOverride !== undefined) {
    const fallback = presetConfig.presetVoiceAdmissionClassifierFallback
      || presetConfig.presetOrchestratorFallback;
    overrides.voiceInterruptClassifier = normalizeExecutionPolicy(
      rawVoiceInterruptOverride,
      fallback.provider,
      fallback.model,
      { fallbackMode: "dedicated_model" }
    );
  }

  const harness = normalizeOptionalString(rawOverrides.harness, 64);
  if (harness) overrides.harness = harness;

  const researchRuntime = normalizeOptionalString(rawOverrides.researchRuntime, 64);
  if (researchRuntime) overrides.researchRuntime = researchRuntime;

  const browserRuntime = normalizeOptionalString(rawOverrides.browserRuntime, 64);
  if (browserRuntime) overrides.browserRuntime = browserRuntime;

  if (rawDevTeamOverride) {
    const rawRoleOverrides = isRecord(rawDevTeamOverride.roles) ? rawDevTeamOverride.roles : {};
    const normalizedRoles = {
      design: normalizeCodingWorkerName(rawRoleOverrides.design),
      implementation: normalizeCodingWorkerName(rawRoleOverrides.implementation),
      review: normalizeCodingWorkerName(rawRoleOverrides.review),
      research: normalizeCodingWorkerName(rawRoleOverrides.research)
    };
    const roleEntries = Object.entries(normalizedRoles).filter(([, value]) => value !== undefined);
    overrides.devTeam = {
      orchestrator: normalizeModelBinding(
        rawDevTeamOverride.orchestrator,
        presetConfig.presetOrchestratorFallback.provider,
        presetConfig.presetOrchestratorFallback.model
      ),
      codingWorkers: normalizeCodingWorkerList(rawDevTeamOverride.codingWorkers),
      ...(roleEntries.length
        ? {
            roles: Object.fromEntries(roleEntries) as NonNullable<Settings["agentStack"]["overrides"]["devTeam"]>["roles"]
          }
        : {})
    };
  }

  return {
    preset: presetConfig.preset,
    advancedOverridesEnabled: normalizeBoolean(
      rawAgentStack.advancedOverridesEnabled,
      DEFAULT_SETTINGS.agentStack.advancedOverridesEnabled
    ),
    overrides,
    runtimeConfig: {
      research: {
        enabled: normalizeBoolean(
          research.enabled,
          DEFAULT_SETTINGS.agentStack.runtimeConfig.research.enabled
        ),
        maxSearchesPerHour: normalizeInt(
          research.maxSearchesPerHour,
          DEFAULT_SETTINGS.agentStack.runtimeConfig.research.maxSearchesPerHour,
          0,
          120
        ),
        openaiNativeWebSearch: {
          userLocation: normalizeString(
            research.openaiNativeWebSearch.userLocation,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.research.openaiNativeWebSearch.userLocation,
            120
          ),
          allowedDomains: normalizeStringList(
            research.openaiNativeWebSearch.allowedDomains,
            50,
            200
          )
        },
        localExternalSearch: {
          safeSearch: normalizeBoolean(
            research.localExternalSearch.safeSearch,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.research.localExternalSearch.safeSearch
          ),
          providerOrder: normalizeProviderOrder(research.localExternalSearch.providerOrder),
          maxResults: normalizeInt(
            research.localExternalSearch.maxResults,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.research.localExternalSearch.maxResults,
            1,
            10
          ),
          maxPagesToRead: normalizeInt(
            research.localExternalSearch.maxPagesToRead,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.research.localExternalSearch.maxPagesToRead,
            0,
            5
          ),
          maxCharsPerPage: normalizeInt(
            research.localExternalSearch.maxCharsPerPage,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.research.localExternalSearch.maxCharsPerPage,
            350,
            24_000
          ),
          recencyDaysDefault: normalizeInt(
            research.localExternalSearch.recencyDaysDefault,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.research.localExternalSearch.recencyDaysDefault,
            1,
            3_650
          ),
          maxConcurrentFetches: normalizeInt(
            research.localExternalSearch.maxConcurrentFetches,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.research.localExternalSearch.maxConcurrentFetches,
            1,
            10
          )
        }
      },
      browser: {
        enabled: normalizeBoolean(browser.enabled, DEFAULT_SETTINGS.agentStack.runtimeConfig.browser.enabled),
        headed: normalizeBoolean(browser.headed, DEFAULT_SETTINGS.agentStack.runtimeConfig.browser.headed),
        profile: normalizeString(browser.profile, DEFAULT_SETTINGS.agentStack.runtimeConfig.browser.profile, 500),
        openaiComputerUse: {
          client: normalizeOpenAiComputerUseClient(browser.openaiComputerUse.client),
          model: normalizeString(
            browser.openaiComputerUse.model,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.browser.openaiComputerUse.model,
            120
          )
        },
        localBrowserAgent: {
          execution: normalizeBrowserExecutionPolicy(browser.localBrowserAgent.execution, presetConfig.presetBrowserFallback),
          maxBrowseCallsPerHour: normalizeInt(
            browser.localBrowserAgent.maxBrowseCallsPerHour,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.browser.localBrowserAgent.maxBrowseCallsPerHour,
            SETTINGS_NUMERIC_CONSTRAINTS.agentStack.browser.maxBrowseCallsPerHour.min,
            SETTINGS_NUMERIC_CONSTRAINTS.agentStack.browser.maxBrowseCallsPerHour.max
          ),
          maxStepsPerTask: normalizeInt(
            browser.localBrowserAgent.maxStepsPerTask,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.browser.localBrowserAgent.maxStepsPerTask,
            SETTINGS_NUMERIC_CONSTRAINTS.agentStack.browser.maxStepsPerTask.min,
            SETTINGS_NUMERIC_CONSTRAINTS.agentStack.browser.maxStepsPerTask.max
          ),
          stepTimeoutMs: normalizeInt(
            browser.localBrowserAgent.stepTimeoutMs,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.browser.localBrowserAgent.stepTimeoutMs,
            SETTINGS_NUMERIC_CONSTRAINTS.agentStack.browser.stepTimeoutMs.min,
            SETTINGS_NUMERIC_CONSTRAINTS.agentStack.browser.stepTimeoutMs.max
          ),
          sessionTimeoutMs: normalizeInt(
            browser.localBrowserAgent.sessionTimeoutMs,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.browser.localBrowserAgent.sessionTimeoutMs,
            SETTINGS_NUMERIC_CONSTRAINTS.agentStack.browser.sessionTimeoutMs.min,
            SETTINGS_NUMERIC_CONSTRAINTS.agentStack.browser.sessionTimeoutMs.max
          )
        }
      },
      voice: {
        runtimeMode: normalizeVoiceRuntimeMode(
          rawVoiceRuntime.runtimeMode !== undefined
            ? voice.runtimeMode
            : (presetConfig.presetVoiceRuntimeMode || voice.runtimeMode),
          DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.runtimeMode
        ),
        openaiRealtime: {
          model: normalizeString(
            voice.openaiRealtime.model,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.openaiRealtime.model,
            120
          ),
          voice: normalizeString(
            voice.openaiRealtime.voice,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.openaiRealtime.voice,
            120
          ),
          inputAudioFormat: normalizeString(
            normalizeOpenAiRealtimeAudioFormat(
              voice.openaiRealtime.inputAudioFormat,
              DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.openaiRealtime.inputAudioFormat
            ),
            DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.openaiRealtime.inputAudioFormat,
            120
          ),
          outputAudioFormat: normalizeString(
            normalizeOpenAiRealtimeAudioFormat(
              voice.openaiRealtime.outputAudioFormat,
              DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.openaiRealtime.outputAudioFormat
            ),
            DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.openaiRealtime.outputAudioFormat,
            120
          ),
          transcriptionMethod: normalizeOpenAiRealtimeTranscriptionMethod(
            voice.openaiRealtime.transcriptionMethod,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.openaiRealtime.transcriptionMethod
          ),
          inputTranscriptionModel: normalizeOpenAiRealtimeTranscriptionModel(
            voice.openaiRealtime.inputTranscriptionModel,
            OPENAI_REALTIME_DEFAULT_TRANSCRIPTION_MODEL
          ),
          usePerUserAsrBridge: normalizeBoolean(
            voice.openaiRealtime.usePerUserAsrBridge,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.openaiRealtime.usePerUserAsrBridge
          )
        },
        xai: {
          voice: normalizeString(
            voice.xai.voice,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.xai.voice,
            120
          ),
          audioFormat: normalizeString(
            voice.xai.audioFormat,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.xai.audioFormat,
            120
          ),
          sampleRateHz: normalizeInt(
            voice.xai.sampleRateHz,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.xai.sampleRateHz,
            SETTINGS_NUMERIC_CONSTRAINTS.agentStack.voiceRuntime.sampleRateHz.min,
            SETTINGS_NUMERIC_CONSTRAINTS.agentStack.voiceRuntime.sampleRateHz.max
          ),
          region: normalizeString(
            voice.xai.region,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.xai.region,
            120
          )
        },
        elevenLabsRealtime: {
          voiceId: normalizeString(
            voice.elevenLabsRealtime.voiceId,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.elevenLabsRealtime.voiceId,
            200
          ),
          ttsModel: normalizeString(
            voice.elevenLabsRealtime.ttsModel,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.elevenLabsRealtime.ttsModel,
            120
          ),
          transcriptionModel: normalizeString(
            voice.elevenLabsRealtime.transcriptionModel,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.elevenLabsRealtime.transcriptionModel,
            120
          ),
          apiBaseUrl: normalizeHttpBaseUrl(
            voice.elevenLabsRealtime.apiBaseUrl,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.elevenLabsRealtime.apiBaseUrl
          ),
          inputSampleRateHz: normalizeInt(
            voice.elevenLabsRealtime.inputSampleRateHz,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.elevenLabsRealtime.inputSampleRateHz,
            SETTINGS_NUMERIC_CONSTRAINTS.agentStack.voiceRuntime.sampleRateHz.min,
            SETTINGS_NUMERIC_CONSTRAINTS.agentStack.voiceRuntime.sampleRateHz.max
          ),
          outputSampleRateHz: normalizeInt(
            voice.elevenLabsRealtime.outputSampleRateHz,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.elevenLabsRealtime.outputSampleRateHz,
            SETTINGS_NUMERIC_CONSTRAINTS.agentStack.voiceRuntime.sampleRateHz.min,
            SETTINGS_NUMERIC_CONSTRAINTS.agentStack.voiceRuntime.sampleRateHz.max
          )
        },
        geminiRealtime: {
          model: normalizeString(
            voice.geminiRealtime.model,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.geminiRealtime.model,
            120
          ),
          voice: normalizeString(
            voice.geminiRealtime.voice,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.geminiRealtime.voice,
            120
          ),
          apiBaseUrl: normalizeHttpBaseUrl(
            voice.geminiRealtime.apiBaseUrl,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.geminiRealtime.apiBaseUrl
          ),
          inputSampleRateHz: normalizeInt(
            voice.geminiRealtime.inputSampleRateHz,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.geminiRealtime.inputSampleRateHz,
            SETTINGS_NUMERIC_CONSTRAINTS.agentStack.voiceRuntime.sampleRateHz.min,
            SETTINGS_NUMERIC_CONSTRAINTS.agentStack.voiceRuntime.sampleRateHz.max
          ),
          outputSampleRateHz: normalizeInt(
            voice.geminiRealtime.outputSampleRateHz,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.geminiRealtime.outputSampleRateHz,
            SETTINGS_NUMERIC_CONSTRAINTS.agentStack.voiceRuntime.sampleRateHz.min,
            SETTINGS_NUMERIC_CONSTRAINTS.agentStack.voiceRuntime.sampleRateHz.max
          )
        },
        openaiAudioApi: {
          ttsModel: normalizeString(
            voice.openaiAudioApi.ttsModel,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.openaiAudioApi.ttsModel,
            120
          ),
          ttsVoice: normalizeString(
            voice.openaiAudioApi.ttsVoice,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.openaiAudioApi.ttsVoice,
            120
          ),
          ttsSpeed: normalizeNumber(
            voice.openaiAudioApi.ttsSpeed,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.openaiAudioApi.ttsSpeed,
            0.25,
            4
          )
        },
        musicBrain:
          rawVoiceMusicBrain === undefined && presetConfig.presetVoiceMusicBrainFallback
            ? {
                mode: "disabled"
              }
            : normalizeExecutionPolicy(voice.musicBrain, "anthropic", "claude-haiku-4-5"),
        generation:
          rawVoiceGeneration === undefined && presetConfig.presetVoiceGenerationFallback
            ? {
                mode: "dedicated_model",
                model: {
                  provider: presetConfig.presetVoiceGenerationFallback.provider,
                  model: presetConfig.presetVoiceGenerationFallback.model
                }
              }
            : normalizeExecutionPolicy(voice.generation, "anthropic", "claude-sonnet-4-6")
      },
      claudeOAuthSession: {
        sessionScope: normalizeClaudeCodeSessionScope(
          claudeOAuthSession.sessionScope,
          DEFAULT_SETTINGS.agentStack.runtimeConfig.claudeOAuthSession.sessionScope
        ),
        inactivityTimeoutMs: normalizeInt(
          claudeOAuthSession.inactivityTimeoutMs,
          DEFAULT_SETTINGS.agentStack.runtimeConfig.claudeOAuthSession.inactivityTimeoutMs,
          10_000,
          12 * 60 * 60 * 1000
        ),
        contextPruningStrategy: normalizeClaudeCodeContextPruningStrategy(
          claudeOAuthSession.contextPruningStrategy,
          DEFAULT_SETTINGS.agentStack.runtimeConfig.claudeOAuthSession.contextPruningStrategy
        ),
        maxPinnedStateChars: normalizeInt(
          claudeOAuthSession.maxPinnedStateChars,
          DEFAULT_SETTINGS.agentStack.runtimeConfig.claudeOAuthSession.maxPinnedStateChars,
          0,
          200_000
        ),
        voiceToolPolicy: normalizeAgentSessionToolPolicy(
          claudeOAuthSession.voiceToolPolicy,
          DEFAULT_SETTINGS.agentStack.runtimeConfig.claudeOAuthSession.voiceToolPolicy
        ),
        textToolPolicy: normalizeAgentSessionToolPolicy(
          claudeOAuthSession.textToolPolicy,
          DEFAULT_SETTINGS.agentStack.runtimeConfig.claudeOAuthSession.textToolPolicy
        )
      },
      devTeam: {
        codex: {
          enabled: normalizeBoolean(
            devTeam.codex.enabled,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.codex.enabled
          ),
          model:
            normalizeString(
              devTeam.codex.model,
              DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.codex.model,
              120
            ) || DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.codex.model,
          maxTurns: normalizeInt(
            devTeam.codex.maxTurns,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.codex.maxTurns,
            SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.maxTurns.min,
            SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.maxTurns.max
          ),
          timeoutMs: normalizeInt(
            devTeam.codex.timeoutMs,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.codex.timeoutMs,
            SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.timeoutMs.min,
            SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.timeoutMs.max
          ),
          maxBufferBytes: normalizeInt(
            devTeam.codex.maxBufferBytes,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.codex.maxBufferBytes,
            SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.maxBufferBytes.min,
            SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.maxBufferBytes.max
          ),
          defaultCwd: normalizeString(
            devTeam.codex.defaultCwd,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.codex.defaultCwd,
            400
          ),
          maxTasksPerHour: normalizeInt(
            devTeam.codex.maxTasksPerHour,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.codex.maxTasksPerHour,
            SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.maxTasksPerHour.min,
            SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.maxTasksPerHour.max
          ),
          maxParallelTasks: normalizeInt(
            devTeam.codex.maxParallelTasks,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.codex.maxParallelTasks,
            SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.maxParallelTasks.min,
            SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.maxParallelTasks.max
          ),
          asyncDispatch: {
            enabled: normalizeBoolean(
              devTeam.codex.asyncDispatch?.enabled,
              DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.codex.asyncDispatch.enabled
            ),
            thresholdMs: normalizeInt(
              devTeam.codex.asyncDispatch?.thresholdMs,
              DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.codex.asyncDispatch.thresholdMs,
              SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.asyncDispatchThresholdMs.min,
              SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.asyncDispatchThresholdMs.max
            ),
            progressReports: {
              enabled: normalizeBoolean(
                devTeam.codex.asyncDispatch?.progressReports?.enabled,
                DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.codex.asyncDispatch.progressReports.enabled
              ),
              intervalMs: normalizeInt(
                devTeam.codex.asyncDispatch?.progressReports?.intervalMs,
                DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.codex.asyncDispatch.progressReports.intervalMs,
                SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.asyncDispatchProgressIntervalMs.min,
                SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.asyncDispatchProgressIntervalMs.max
              ),
              maxReportsPerTask: normalizeInt(
                devTeam.codex.asyncDispatch?.progressReports?.maxReportsPerTask,
                DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.codex.asyncDispatch.progressReports.maxReportsPerTask,
                SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.asyncDispatchMaxReportsPerTask.min,
                SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.asyncDispatchMaxReportsPerTask.max
              )
            }
          }
        },
        codexCli: {
          enabled: normalizeBoolean(
            devTeam.codexCli.enabled,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.codexCli.enabled
          ),
          model:
            normalizeString(
              devTeam.codexCli.model,
              DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.codexCli.model,
              120
            ) || DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.codexCli.model,
          maxTurns: normalizeInt(
            devTeam.codexCli.maxTurns,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.codexCli.maxTurns,
            SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.maxTurns.min,
            SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.maxTurns.max
          ),
          timeoutMs: normalizeInt(
            devTeam.codexCli.timeoutMs,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.codexCli.timeoutMs,
            SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.timeoutMs.min,
            SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.timeoutMs.max
          ),
          maxBufferBytes: normalizeInt(
            devTeam.codexCli.maxBufferBytes,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.codexCli.maxBufferBytes,
            SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.maxBufferBytes.min,
            SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.maxBufferBytes.max
          ),
          defaultCwd: normalizeString(
            devTeam.codexCli.defaultCwd,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.codexCli.defaultCwd,
            400
          ),
          maxTasksPerHour: normalizeInt(
            devTeam.codexCli.maxTasksPerHour,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.codexCli.maxTasksPerHour,
            SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.maxTasksPerHour.min,
            SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.maxTasksPerHour.max
          ),
          maxParallelTasks: normalizeInt(
            devTeam.codexCli.maxParallelTasks,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.codexCli.maxParallelTasks,
            SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.maxParallelTasks.min,
            SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.maxParallelTasks.max
          ),
          asyncDispatch: {
            enabled: normalizeBoolean(
              devTeam.codexCli.asyncDispatch?.enabled,
              DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.codexCli.asyncDispatch.enabled
            ),
            thresholdMs: normalizeInt(
              devTeam.codexCli.asyncDispatch?.thresholdMs,
              DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.codexCli.asyncDispatch.thresholdMs,
              SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.asyncDispatchThresholdMs.min,
              SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.asyncDispatchThresholdMs.max
            ),
            progressReports: {
              enabled: normalizeBoolean(
                devTeam.codexCli.asyncDispatch?.progressReports?.enabled,
                DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.codexCli.asyncDispatch.progressReports.enabled
              ),
              intervalMs: normalizeInt(
                devTeam.codexCli.asyncDispatch?.progressReports?.intervalMs,
                DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.codexCli.asyncDispatch.progressReports.intervalMs,
                SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.asyncDispatchProgressIntervalMs.min,
                SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.asyncDispatchProgressIntervalMs.max
              ),
              maxReportsPerTask: normalizeInt(
                devTeam.codexCli.asyncDispatch?.progressReports?.maxReportsPerTask,
                DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.codexCli.asyncDispatch.progressReports.maxReportsPerTask,
                SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.asyncDispatchMaxReportsPerTask.min,
                SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.asyncDispatchMaxReportsPerTask.max
              )
            }
          }
        },
        claudeCode: {
          enabled: normalizeBoolean(
            devTeam.claudeCode.enabled,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.claudeCode.enabled
          ),
          model:
            normalizeString(
              devTeam.claudeCode.model,
              DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.claudeCode.model,
              120
            ) || DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.claudeCode.model,
          maxTurns: normalizeInt(
            devTeam.claudeCode.maxTurns,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.claudeCode.maxTurns,
            SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.maxTurns.min,
            SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.maxTurns.max
          ),
          timeoutMs: normalizeInt(
            devTeam.claudeCode.timeoutMs,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.claudeCode.timeoutMs,
            SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.timeoutMs.min,
            SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.timeoutMs.max
          ),
          maxBufferBytes: normalizeInt(
            devTeam.claudeCode.maxBufferBytes,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.claudeCode.maxBufferBytes,
            SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.maxBufferBytes.min,
            SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.maxBufferBytes.max
          ),
          defaultCwd: normalizeString(
            devTeam.claudeCode.defaultCwd,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.claudeCode.defaultCwd,
            400
          ),
          maxTasksPerHour: normalizeInt(
            devTeam.claudeCode.maxTasksPerHour,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.claudeCode.maxTasksPerHour,
            SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.maxTasksPerHour.min,
            SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.maxTasksPerHour.max
          ),
          maxParallelTasks: normalizeInt(
            devTeam.claudeCode.maxParallelTasks,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.claudeCode.maxParallelTasks,
            SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.maxParallelTasks.min,
            SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.maxParallelTasks.max
          ),
          asyncDispatch: {
            enabled: normalizeBoolean(
              devTeam.claudeCode.asyncDispatch?.enabled,
              DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.claudeCode.asyncDispatch.enabled
            ),
            thresholdMs: normalizeInt(
              devTeam.claudeCode.asyncDispatch?.thresholdMs,
              DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.claudeCode.asyncDispatch.thresholdMs,
              SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.asyncDispatchThresholdMs.min,
              SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.asyncDispatchThresholdMs.max
            ),
            progressReports: {
              enabled: normalizeBoolean(
                devTeam.claudeCode.asyncDispatch?.progressReports?.enabled,
                DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.claudeCode.asyncDispatch.progressReports.enabled
              ),
              intervalMs: normalizeInt(
                devTeam.claudeCode.asyncDispatch?.progressReports?.intervalMs,
                DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.claudeCode.asyncDispatch.progressReports.intervalMs,
                SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.asyncDispatchProgressIntervalMs.min,
                SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.asyncDispatchProgressIntervalMs.max
              ),
              maxReportsPerTask: normalizeInt(
                devTeam.claudeCode.asyncDispatch?.progressReports?.maxReportsPerTask,
                DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.claudeCode.asyncDispatch.progressReports.maxReportsPerTask,
                SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.asyncDispatchMaxReportsPerTask.min,
                SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.asyncDispatchMaxReportsPerTask.max
              )
            }
          }
        }
      }
    }
  };
}
