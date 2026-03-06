import { normalizeProviderOrder } from "../../search.ts";
import {
  DEFAULT_SETTINGS,
  type Settings,
  type SettingsModelBinding
} from "../../settings/settingsSchema.ts";
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
  const claudeCodeSession = runtimeConfig.claudeCodeSession;
  const devTeam = runtimeConfig.devTeam;
  const rawDevTeamOverride = isRecord(rawOverrides.devTeam) ? rawOverrides.devTeam : null;

  const overrides: Settings["agentStack"]["overrides"] = {
    orchestrator: orchestratorOverride,
    voiceAdmissionClassifier: normalizeExecutionPolicy(
      rawOverrides.voiceAdmissionClassifier,
      presetConfig.presetVoiceAdmissionClassifierFallback.provider,
      presetConfig.presetVoiceAdmissionClassifierFallback.model,
      { fallbackMode: "dedicated_model" }
    )
  };

  const harness = normalizeOptionalString(rawOverrides.harness, 64);
  if (harness) overrides.harness = harness;

  const researchRuntime = normalizeOptionalString(rawOverrides.researchRuntime, 64);
  if (researchRuntime) overrides.researchRuntime = researchRuntime;

  const browserRuntime = normalizeOptionalString(rawOverrides.browserRuntime, 64);
  if (browserRuntime) overrides.browserRuntime = browserRuntime;

  const voiceRuntime = normalizeOptionalString(rawOverrides.voiceRuntime, 64);
  if (voiceRuntime) overrides.voiceRuntime = voiceRuntime;

  if (rawDevTeamOverride) {
    overrides.devTeam = {
      orchestrator: normalizeModelBinding(
        rawDevTeamOverride.orchestrator,
        presetConfig.presetOrchestratorFallback.provider,
        presetConfig.presetOrchestratorFallback.model
      ),
      codingWorkers: normalizeStringList(rawDevTeamOverride.codingWorkers, 4, 40)
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
        openaiComputerUse: {
          model: normalizeString(
            browser.openaiComputerUse.model,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.browser.openaiComputerUse.model,
            120
          )
        },
        localBrowserAgent: {
          execution: normalizeBrowserExecutionPolicy(browser.localBrowserAgent.execution),
          maxBrowseCallsPerHour: normalizeInt(
            browser.localBrowserAgent.maxBrowseCallsPerHour,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.browser.localBrowserAgent.maxBrowseCallsPerHour,
            0,
            60
          ),
          maxStepsPerTask: normalizeInt(
            browser.localBrowserAgent.maxStepsPerTask,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.browser.localBrowserAgent.maxStepsPerTask,
            1,
            30
          ),
          stepTimeoutMs: normalizeInt(
            browser.localBrowserAgent.stepTimeoutMs,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.browser.localBrowserAgent.stepTimeoutMs,
            5_000,
            120_000
          ),
          sessionTimeoutMs: normalizeInt(
            browser.localBrowserAgent.sessionTimeoutMs,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.browser.localBrowserAgent.sessionTimeoutMs,
            10_000,
            1_800_000
          )
        }
      },
      voice: {
        runtimeMode: normalizeVoiceRuntimeMode(
          voice.runtimeMode,
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
            8_000,
            96_000
          ),
          region: normalizeString(
            voice.xai.region,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.xai.region,
            120
          )
        },
        elevenLabsRealtime: {
          agentId: normalizeString(
            voice.elevenLabsRealtime.agentId,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.elevenLabsRealtime.agentId,
            200
          ),
          voiceId: normalizeString(
            voice.elevenLabsRealtime.voiceId,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.elevenLabsRealtime.voiceId,
            200
          ),
          apiBaseUrl: normalizeHttpBaseUrl(
            voice.elevenLabsRealtime.apiBaseUrl,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.elevenLabsRealtime.apiBaseUrl
          ),
          inputSampleRateHz: normalizeInt(
            voice.elevenLabsRealtime.inputSampleRateHz,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.elevenLabsRealtime.inputSampleRateHz,
            8_000,
            96_000
          ),
          outputSampleRateHz: normalizeInt(
            voice.elevenLabsRealtime.outputSampleRateHz,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.elevenLabsRealtime.outputSampleRateHz,
            8_000,
            96_000
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
            8_000,
            96_000
          ),
          outputSampleRateHz: normalizeInt(
            voice.geminiRealtime.outputSampleRateHz,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.geminiRealtime.outputSampleRateHz,
            8_000,
            96_000
          )
        },
        sttPipeline: {
          transcriptionModel: normalizeString(
            voice.sttPipeline.transcriptionModel,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.sttPipeline.transcriptionModel,
            120
          ),
          ttsModel: normalizeString(
            voice.sttPipeline.ttsModel,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.sttPipeline.ttsModel,
            120
          ),
          ttsVoice: normalizeString(
            voice.sttPipeline.ttsVoice,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.sttPipeline.ttsVoice,
            120
          ),
          ttsSpeed: normalizeNumber(
            voice.sttPipeline.ttsSpeed,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.sttPipeline.ttsSpeed,
            0.25,
            4
          )
        },
        generation: normalizeExecutionPolicy(voice.generation, "anthropic", "claude-sonnet-4-6")
      },
      claudeCodeSession: {
        sessionScope: normalizeClaudeCodeSessionScope(
          claudeCodeSession.sessionScope,
          DEFAULT_SETTINGS.agentStack.runtimeConfig.claudeCodeSession.sessionScope
        ),
        inactivityTimeoutMs: normalizeInt(
          claudeCodeSession.inactivityTimeoutMs,
          DEFAULT_SETTINGS.agentStack.runtimeConfig.claudeCodeSession.inactivityTimeoutMs,
          10_000,
          12 * 60 * 60 * 1000
        ),
        contextPruningStrategy: normalizeClaudeCodeContextPruningStrategy(
          claudeCodeSession.contextPruningStrategy,
          DEFAULT_SETTINGS.agentStack.runtimeConfig.claudeCodeSession.contextPruningStrategy
        ),
        maxPinnedStateChars: normalizeInt(
          claudeCodeSession.maxPinnedStateChars,
          DEFAULT_SETTINGS.agentStack.runtimeConfig.claudeCodeSession.maxPinnedStateChars,
          0,
          200_000
        ),
        voiceToolPolicy: normalizeAgentSessionToolPolicy(
          claudeCodeSession.voiceToolPolicy,
          DEFAULT_SETTINGS.agentStack.runtimeConfig.claudeCodeSession.voiceToolPolicy
        ),
        textToolPolicy: normalizeAgentSessionToolPolicy(
          claudeCodeSession.textToolPolicy,
          DEFAULT_SETTINGS.agentStack.runtimeConfig.claudeCodeSession.textToolPolicy
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
            1,
            200
          ),
          timeoutMs: normalizeInt(
            devTeam.codex.timeoutMs,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.codex.timeoutMs,
            10_000,
            1_800_000
          ),
          maxBufferBytes: normalizeInt(
            devTeam.codex.maxBufferBytes,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.codex.maxBufferBytes,
            4_096,
            10 * 1024 * 1024
          ),
          defaultCwd: normalizeString(
            devTeam.codex.defaultCwd,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.codex.defaultCwd,
            400
          ),
          maxTasksPerHour: normalizeInt(
            devTeam.codex.maxTasksPerHour,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.codex.maxTasksPerHour,
            0,
            200
          ),
          maxParallelTasks: normalizeInt(
            devTeam.codex.maxParallelTasks,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.codex.maxParallelTasks,
            1,
            20
          )
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
            1,
            200
          ),
          timeoutMs: normalizeInt(
            devTeam.claudeCode.timeoutMs,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.claudeCode.timeoutMs,
            10_000,
            1_800_000
          ),
          maxBufferBytes: normalizeInt(
            devTeam.claudeCode.maxBufferBytes,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.claudeCode.maxBufferBytes,
            4_096,
            10 * 1024 * 1024
          ),
          defaultCwd: normalizeString(
            devTeam.claudeCode.defaultCwd,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.claudeCode.defaultCwd,
            400
          ),
          maxTasksPerHour: normalizeInt(
            devTeam.claudeCode.maxTasksPerHour,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.claudeCode.maxTasksPerHour,
            0,
            200
          ),
          maxParallelTasks: normalizeInt(
            devTeam.claudeCode.maxParallelTasks,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.claudeCode.maxParallelTasks,
            1,
            20
          )
        }
      }
    }
  };
}
