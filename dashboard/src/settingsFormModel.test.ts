import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  applyStackPresetDefaults,
  formToSettingsPatch,
  getCodeAgentValidationError,
  resolveBrowserProviderModelOptions,
  resolveModelOptionsFromText,
  resolvePresetModelSelection,
  resolveProviderModelOptions,
  sanitizeAliasListInput,
  settingsToForm,
  settingsToFormPreserving
} from "./settingsFormModel.ts";
import { normalizeSettings } from "../../src/store/settingsNormalization.ts";
import {
  getResolvedOrchestratorBinding,
  getResolvedFollowupBinding,
  getResolvedMemoryBinding,
  getResolvedTextInitiativeBinding,
  getResolvedVisionBinding,
  getResolvedVoiceInitiativeBinding,
  getResolvedVoiceAdmissionClassifierBinding,
  getResolvedVoiceGenerationBinding,
  resolveAgentStack
} from "../../src/settings/agentStack.ts";
import { resolveVoiceRuntimeSelectionFromMode } from "../../src/settings/voiceDashboardMappings.ts";

function withResolved(settings: unknown) {
  const s = settings as Record<string, unknown>;
  return {
    ...s,
    _resolved: {
      agentStack: resolveAgentStack(s),
      orchestrator: getResolvedOrchestratorBinding(s),
      followupBinding: getResolvedFollowupBinding(s),
      memoryBinding: getResolvedMemoryBinding(s),
      textInitiativeBinding: getResolvedTextInitiativeBinding(s),
      visionBinding: getResolvedVisionBinding(s),
      voiceProvider: resolveVoiceRuntimeSelectionFromMode(resolveAgentStack(s).voiceRuntime),
      voiceInitiativeBinding: getResolvedVoiceInitiativeBinding(s),
      voiceAdmissionClassifierBinding: getResolvedVoiceAdmissionClassifierBinding(s),
      voiceGenerationBinding: getResolvedVoiceGenerationBinding(s)
    }
  };
}

function assertDedicatedExecutionModel(
  execution: {
    mode?: "inherit_orchestrator" | "dedicated_model";
    model?: {
      provider?: string;
      model?: string;
    };
  },
  provider: string,
  model: string
) {
  assert.equal(execution.mode, "dedicated_model");
  if (execution.mode !== "dedicated_model") return;
  assert.equal(execution.model?.provider, provider);
  assert.equal(execution.model?.model, model);
}

test("settingsFormModel converts settings to form defaults and back to normalized patch", () => {
  const form = settingsToForm(withResolved(normalizeSettings({
    identity: {
      botName: "clanker conk",
      botNameAliases: ["clank", "conk", "clank"]
    },
    persona: {
      flavor: "chaotic but kind",
      hardLimits: ["no hate", "no hate", "keep it fun"]
    },
    agentStack: {
      preset: "openai_native_realtime",
      advancedOverridesEnabled: true,
      overrides: {
        orchestrator: {
          provider: "openai",
          model: "claude-haiku-4-5"
        }
      }
    },
    voice: {
      conversationPolicy: {
        defaultInterruptionMode: "none",
        streaming: {
          enabled: true,
          eagerFirstChunkChars: 72,
          maxBufferChars: 280
        }
      }
    },
    permissions: {
      replies: {
        replyChannelIds: ["1", "2"],
        allowedChannelIds: ["2", "3"],
        blockedChannelIds: ["9"],
        blockedUserIds: ["u-1"]
      }
    }
  })));

  assert.equal(form.botName, "clanker conk");
  assert.equal(form.botNameAliases, "clank, conk");
  assert.equal(form.personaFlavor, "chaotic but kind");
  assert.equal(form.personaHardLimits, "no hate\nkeep it fun");
  assert.equal(form.stackPreset, "openai_native_realtime");
  assert.equal(form.stackAdvancedOverridesEnabled, true);
  assert.equal(form.provider, "openai");
  assert.equal(form.model, "claude-haiku-4-5");
  assert.equal(form.voiceGenerationLlmUseTextModel, false);
  assert.equal(form.voiceGenerationLlmProvider, "anthropic");
  assert.equal(form.voiceGenerationLlmModel, "claude-haiku-4-5");
  assert.equal(form.replyFollowupMaxToolSteps, 2);
  assert.equal(form.replyFollowupMaxTotalToolCalls, 3);
  assert.equal(form.replyFollowupMaxWebSearchCalls, 2);
  assert.equal(form.replyFollowupMaxMemoryLookupCalls, 2);
  assert.equal(form.replyFollowupMaxImageLookupCalls, 2);
  assert.equal(form.replyFollowupToolTimeoutMs, 10000);
  assert.equal(form.browserOpenAiComputerUseModel, "gpt-5.4");
  assert.equal(form.browserHeaded, false);
  assert.equal(form.browserLlmProvider, "claude-oauth");
  assert.equal(form.browserLlmModel, "claude-opus-4-6");
  assert.equal(form.codeAgentProvider, "auto");
  assert.equal(form.codeAgentModel, "sonnet");
  assert.equal(form.codeAgentCodexModel, "gpt-5.4");
  assert.equal(form.codeAgentCodexCliModel, "gpt-5.4");
  assert.equal(form.codeAgentRoleDesign, "codex_cli");
  assert.equal(form.codeAgentRoleImplementation, "codex_cli");
  assert.equal(form.codeAgentRoleReview, "codex_cli");
  assert.equal(form.codeAgentRoleResearch, "codex_cli");
  assert.equal(form.automationsEnabled, true);
  assert.equal(form.textInitiativeEnabled, true);
  assert.equal(form.textInitiativeEagerness, 20);
  assert.equal(form.textInitiativeMinMinutesBetweenPosts, 360);
  assert.equal(form.textInitiativeMaxPostsPerDay, 3);
  assert.equal(form.textInitiativeAllowActiveCuriosity, true);
  assert.equal(form.textInitiativeMaxToolSteps, 3);
  assert.equal(form.textInitiativeMaxToolCalls, 4);
  assert.equal(form.textInitiativeUseTextModel, true);
  assert.equal(form.textInitiativeLlmProvider, "openai");
  assert.equal(form.textInitiativeLlmModel, "claude-haiku-4-5");
  assert.equal(form.voiceThoughtEngineEnabled, true);
  assert.equal(form.voiceThoughtEngineEagerness, 50);
  assert.equal(form.voiceStreamWatchKeyframeIntervalMs, 1200);
  assert.equal(form.voiceStreamWatchAutonomousCommentaryEnabled, true);
  assert.equal(form.voiceStreamWatchBrainContextEnabled, true);
  assert.equal(form.voiceStreamWatchBrainContextMinIntervalSeconds, 4);
  assert.equal(form.voiceStreamWatchBrainContextMaxEntries, 8);
  assert.equal(form.voiceAsrLanguageMode, "auto");
  assert.equal(form.voiceAsrLanguageHint, "en");
  assert.equal(form.voiceStreamingEnabled, true);
  assert.equal(form.voiceStreamingEagerFirstChunkChars, 72);
  assert.equal(form.voiceStreamingMaxBufferChars, 280);
  assert.equal(form.voiceDefaultInterruptionMode, "none");
  assert.equal(form.voiceCommandOnlyMode, false);
  assert.equal(form.voiceOpenAiRealtimeTranscriptionMethod, "realtime_bridge");
  assert.equal(form.voiceOpenAiRealtimeUsePerUserAsrBridge, true);
  assert.equal(
    form.voiceStreamWatchBrainContextPrompt,
    "Write one short factual private note about the most salient visible state or change in this frame. Prioritize gameplay actions, objectives, outcomes, menus, or unusual/funny moments that could support a natural later comment. If the frame is mostly idle UI, lobby, desktop, or other non-gameplay context, say that plainly. Prefer what is newly different from the previous frame."
  );
  assert.equal(form.replyChannels, "1\n2");
  assert.equal(form.allowedChannels, "2\n3");

  form.personaHardLimits = "no hate\nno hate\nkeep it fun\n";
  form.botNameAliases = "clank\nconk\nclank\n";
  form.allowedChannels = "2\n2\n3\n";
  form.discoveryRssFeeds = "https://one.example/feed\nhttps://one.example/feed\n";
  form.discoveryXHandles = "@alice\n@alice\nbob\n";
  form.replyFollowupMaxToolSteps = 5;
  form.replyFollowupMaxTotalToolCalls = 11;
  form.replyFollowupMaxWebSearchCalls = 4;
  form.replyFollowupMaxMemoryLookupCalls = 3;
  form.replyFollowupMaxImageLookupCalls = 1;
  form.replyFollowupToolTimeoutMs = 16000;
  form.automationsEnabled = false;
  form.browserHeaded = true;
  form.voiceGenerationLlmUseTextModel = true;
  form.voiceStreamWatchKeyframeIntervalMs = 1750;
  form.voiceStreamWatchAutonomousCommentaryEnabled = false;
  form.voiceStreamWatchBrainContextEnabled = true;
  form.voiceStreamWatchBrainContextMinIntervalSeconds = 6;
  form.voiceStreamWatchBrainContextMaxEntries = 5;
  form.voiceStreamWatchBrainContextPrompt = "Use stream snapshots as context for replies.";
  form.voiceAsrLanguageMode = "fixed";
  form.voiceAsrLanguageHint = "en-us";
  form.voiceStreamingEnabled = false;
  form.voiceStreamingEagerFirstChunkChars = 84;
  form.voiceStreamingMaxBufferChars = 340;
  form.voiceDefaultInterruptionMode = "speaker";
  form.voiceCommandOnlyMode = true;
  form.voiceOpenAiRealtimeTranscriptionMethod = "file_wav";
  form.voiceOpenAiRealtimeUsePerUserAsrBridge = false;
  form.codeAgentProvider = "codex";
  form.codeAgentCodexModel = "gpt-5-codex";
  form.codeAgentRoleDesign = "claude_code";
  form.codeAgentRoleImplementation = "codex_cli";
  form.codeAgentRoleReview = "claude_code";
  form.codeAgentRoleResearch = "codex";
  form.textInitiativeUseTextModel = false;
  form.textInitiativeLlmProvider = "anthropic";
  form.textInitiativeLlmModel = "claude-haiku-4-5";
  form.textInitiativeMinMinutesBetweenPosts = 15;
  form.textInitiativeMaxPostsPerDay = 6;
  form.textInitiativeAllowActiveCuriosity = false;
  form.textInitiativeMaxToolSteps = 2;
  form.textInitiativeMaxToolCalls = 3;
  form.discoveryFeedEnabled = false;
  form.discoveryAllowSelfCuration = false;
  form.discoveryMaxSourcesPerType = 7;
  form.discoveryMaxMediaPromptChars = 640;

  const patch = formToSettingsPatch(form);
  assert.deepEqual(patch.identity.botNameAliases, ["clank", "conk"]);
  assert.deepEqual(patch.persona.hardLimits, ["no hate", "keep it fun"]);
  assert.deepEqual(patch.permissions.replies.allowedChannelIds, ["2", "3"]);
  assert.deepEqual(patch.initiative.discovery.rssFeeds, ["https://one.example/feed"]);
  assert.deepEqual(patch.initiative.discovery.xHandles, ["@alice", "bob"]);
  assert.equal(patch.interaction.followup.toolBudget.maxToolSteps, 5);
  assert.equal(patch.interaction.followup.toolBudget.maxTotalToolCalls, 11);
  assert.equal(patch.interaction.followup.toolBudget.maxWebSearchCalls, 4);
  assert.equal(patch.interaction.followup.toolBudget.maxMemoryLookupCalls, 3);
  assert.equal(patch.interaction.followup.toolBudget.maxImageLookupCalls, 1);
  assert.equal(patch.interaction.followup.toolBudget.toolTimeoutMs, 16000);
  assertDedicatedExecutionModel(
    patch.agentStack.runtimeConfig.browser.localBrowserAgent.execution,
    "claude-oauth",
    "claude-opus-4-6"
  );
  assert.equal(patch.agentStack.runtimeConfig.browser.headed, true);
  assert.equal(patch.automations.enabled, false);
  assertDedicatedExecutionModel(
    patch.initiative.text.execution,
    "anthropic",
    "claude-haiku-4-5"
  );
  assert.equal(patch.initiative.text.minMinutesBetweenPosts, 15);
  assert.equal(patch.initiative.text.maxPostsPerDay, 6);
  assert.equal(patch.initiative.text.allowActiveCuriosity, false);
  assert.equal(patch.initiative.text.maxToolSteps, 2);
  assert.equal(patch.initiative.text.maxToolCalls, 3);
  assert.equal(patch.agentStack.runtimeConfig.voice.generation.mode, "inherit_orchestrator");
  assert.equal(patch.voice.streamWatch.keyframeIntervalMs, 1750);
  assert.equal(patch.voice.streamWatch.autonomousCommentaryEnabled, false);
  assert.equal(patch.voice.streamWatch.brainContextEnabled, true);
  assert.equal(patch.voice.streamWatch.brainContextMinIntervalSeconds, 6);
  assert.equal(patch.voice.streamWatch.brainContextMaxEntries, 5);
  assert.equal(patch.voice.streamWatch.brainContextPrompt, "Use stream snapshots as context for replies.");
  assert.equal(patch.voice.conversationPolicy.streaming.enabled, false);
  assert.equal(patch.voice.conversationPolicy.streaming.eagerFirstChunkChars, 84);
  assert.equal(patch.voice.conversationPolicy.streaming.maxBufferChars, 340);
  assert.equal(patch.voice.conversationPolicy.defaultInterruptionMode, "speaker");
  assert.equal(patch.voice.conversationPolicy.commandOnlyMode, true);
  assert.equal(patch.agentStack.runtimeConfig.voice.openaiRealtime.transcriptionMethod, "file_wav");
  assert.equal(patch.agentStack.runtimeConfig.voice.openaiRealtime.usePerUserAsrBridge, false);
  assert.equal(patch.voice.transcription.languageMode, "fixed");
  assert.equal(patch.voice.transcription.languageHint, "en-us");
  assert.deepEqual(patch.agentStack.overrides.devTeam.codingWorkers, ["codex"]);
  assert.deepEqual(patch.agentStack.overrides.devTeam.roles, {
    design: "claude_code",
    implementation: "codex_cli",
    review: "claude_code",
    research: "codex"
  });
  assert.equal(patch.agentStack.runtimeConfig.devTeam.codex.model, "gpt-5-codex");
  assert.equal(patch.initiative.voice.enabled, true);
  assert.equal(patch.initiative.voice.eagerness, 50);
  assert.equal(patch.initiative.discovery.sources.reddit, false);
  assert.equal(patch.initiative.discovery.allowSelfCuration, false);
  assert.equal(patch.initiative.discovery.maxSourcesPerType, 7);
  assert.equal(patch.initiative.discovery.maxMediaPromptChars, 640);
});

test("settingsToForm preserves explicit empty prompt overrides", () => {
  const form = settingsToForm({
    prompting: {
      global: {
        capabilityHonestyLine: "",
        impossibleActionLine: "",
        memoryEnabledLine: "",
        memoryDisabledLine: "",
        skipLine: ""
      },
      text: {
        guidance: []
      },
      voice: {
        guidance: [],
        operationalGuidance: []
      },
      media: {
        promptCraftGuidance: ""
      }
    }
  });

  assert.equal(form.promptCapabilityHonestyLine, "");
  assert.equal(form.promptImpossibleActionLine, "");
  assert.equal(form.promptMemoryEnabledLine, "");
  assert.equal(form.promptMemoryDisabledLine, "");
  assert.equal(form.promptSkipLine, "");
  assert.equal(form.promptTextGuidance, "");
  assert.equal(form.promptVoiceGuidance, "");
  assert.equal(form.promptVoiceOperationalGuidance, "");
  assert.equal(form.promptMediaPromptCraftGuidance, "");
});

test("formToSettingsPatch parses bot aliases from comma-separated single-line input", () => {
  const form = settingsToForm({});
  form.botNameAliases = "clank, conk, clank";

  const patch = formToSettingsPatch(form);
  assert.deepEqual(patch.identity.botNameAliases, ["clank", "conk"]);
});

test("sanitizeAliasListInput removes duplicate aliases and normalizes separators", () => {
  assert.equal(
    sanitizeAliasListInput("clank, conk\nclank,clanky\nconk"),
    "clank, conk, clanky"
  );
});

test("settingsToForm uses default prompt guidance lists when omitted", () => {
  const form = settingsToForm({});
  assert.equal(form.promptTextGuidance.length > 0, true);
  assert.equal(form.promptVoiceGuidance.length > 0, true);
  assert.equal(form.promptVoiceOperationalGuidance.length > 0, true);
});

test("settingsToForm uses speaker as the default voice interruption mode", () => {
  const form = settingsToForm(withResolved(normalizeSettings({})));
  assert.equal(form.voiceDefaultInterruptionMode, "speaker");
});

test("resolveProviderModelOptions merges catalog values with provider fallback defaults", () => {
  const openai = resolveProviderModelOptions(
    {
      openai: ["claude-haiku-4-5", "claude-haiku-4-5", "gpt-5.2"]
    },
    "openai"
  );
  assert.deepEqual(openai, ["claude-haiku-4-5", "gpt-5.2", "gpt-5-mini", "gpt-5", "gpt-4.1-mini"]);

  const anthropic = resolveProviderModelOptions(
    {
      anthropic: []
    },
    "anthropic"
  );
  assert.deepEqual(anthropic, ["claude-haiku-4-5", "claude-sonnet-4-6"]);
});

test("resolveBrowserProviderModelOptions merges catalog values with browser defaults", () => {
  const openai = resolveBrowserProviderModelOptions(
    {
      openai: ["gpt-5-mini", "gpt-5-mini", "gpt-5.2"]
    },
    "openai"
  );
  assert.deepEqual(openai, ["gpt-5-mini", "gpt-5.2"]);

  const anthropic = resolveBrowserProviderModelOptions(
    {
      anthropic: []
    },
    "anthropic"
  );
  assert.deepEqual(anthropic, ["claude-sonnet-4-5-20250929"]);

  const claudeOAuth = resolveBrowserProviderModelOptions(
    {
      "claude-oauth": ["claude-haiku-4-5", "claude-haiku-4-5"]
    },
    "claude-oauth"
  );
  assert.deepEqual(claudeOAuth, ["claude-haiku-4-5", "claude-opus-4-6", "claude-sonnet-4-6"]);
});

test("resolvePresetModelSelection preserves a valid current model even when the catalog is stale", () => {
  const nonClaude = resolvePresetModelSelection({
    modelCatalog: {
      openai: ["claude-haiku-4-5"]
    },
    provider: "openai",
    model: "custom-model-not-listed"
  });
  assert.equal(nonClaude.selectedPresetModel, "custom-model-not-listed");
  assert.equal(nonClaude.options.includes("custom-model-not-listed"), true);

  const openAiOAuth = resolvePresetModelSelection({
    modelCatalog: {
      "openai-oauth": ["gpt-5.4", "gpt-5.3-codex"]
    },
    provider: "openai-oauth",
    model: "gpt-5-codex"
  });
  assert.equal(openAiOAuth.selectedPresetModel, "gpt-5-codex");
  assert.equal(openAiOAuth.options.includes("gpt-5-codex"), true);
});

test("resolveModelOptionsFromText normalizes model lists for dropdown options", () => {
  const options = resolveModelOptionsFromText(
    "gpt-image-1.5\ngpt-image-1.5\n",
    "grok-imagine-image",
    ["", "grok-imagine-image"]
  );
  assert.deepEqual(options, ["gpt-image-1.5", "grok-imagine-image"]);
});

test("settingsFormModel round-trips canonical voice runtime mode", () => {
  const form = settingsToForm(withResolved(normalizeSettings({
    agentStack: {
      advancedOverridesEnabled: true,
      runtimeConfig: {
        voice: {
          runtimeMode: "openai_realtime"
        }
      }
    }
  })));

  assert.equal(form.voiceProvider, "openai");
  assert.equal(form.stackAdvancedOverridesEnabled, true);
  const patch = formToSettingsPatch(form);
  assert.equal(patch.agentStack.runtimeConfig.voice.runtimeMode, "openai_realtime");
});

test("settingsFormModel keeps realtime provider selection while preserving file_wav + api TTS overrides", () => {
  const form = settingsToForm(withResolved(normalizeSettings({
    agentStack: {
      advancedOverridesEnabled: true,
      runtimeConfig: {
        voice: {
          runtimeMode: "openai_realtime",
          openaiRealtime: {
            transcriptionMethod: "file_wav"
          },
          openaiAudioApi: {
            ttsModel: "gpt-4o-mini-tts",
            ttsVoice: "ash",
            ttsSpeed: 1.25
          }
        }
      },
    },
    voice: {
      conversationPolicy: {
        replyPath: "brain",
        ttsMode: "api"
      }
    }
  })));

  assert.equal(form.voiceProvider, "openai");
  assert.equal(form.voiceOpenAiRealtimeTranscriptionMethod, "file_wav");
  assert.equal(form.voiceTtsMode, "api");
  assert.equal(form.voiceApiTtsVoice, "ash");
  const patch = formToSettingsPatch(form);
  assert.equal(patch.agentStack.runtimeConfig.voice.runtimeMode, "openai_realtime");
  assert.equal(patch.agentStack.runtimeConfig.voice.openaiRealtime.transcriptionMethod, "file_wav");
  assert.equal(patch.agentStack.runtimeConfig.voice.openaiAudioApi.ttsVoice, "ash");
});

test("settingsFormModel round-trips browser llm provider and model", () => {
  const form = settingsToForm(withResolved(normalizeSettings({
    agentStack: {
      runtimeConfig: {
        browser: {
          localBrowserAgent: {
            execution: {
              mode: "dedicated_model",
              model: {
                provider: "openai",
                model: "gpt-5-mini"
              }
            }
          }
        }
      }
    }
  })));

  assert.equal(form.browserLlmProvider, "openai");
  assert.equal(form.browserLlmModel, "gpt-5-mini");

  const patch = formToSettingsPatch(form);
  assertDedicatedExecutionModel(
    patch.agentStack.runtimeConfig.browser.localBrowserAgent.execution,
    "openai",
    "gpt-5-mini"
  );
});

test("settingsFormModel round-trips claude oauth browser llm provider and model", () => {
  const form = settingsToForm(withResolved(normalizeSettings({
    agentStack: {
      runtimeConfig: {
        browser: {
          localBrowserAgent: {
            execution: {
              mode: "dedicated_model",
              model: {
                provider: "claude-oauth",
                model: "claude-sonnet-4-6"
              }
            }
          }
        }
      }
    }
  })));

  assert.equal(form.browserLlmProvider, "claude-oauth");
  assert.equal(form.browserLlmModel, "claude-sonnet-4-6");

  const patch = formToSettingsPatch(form);
  assertDedicatedExecutionModel(
    patch.agentStack.runtimeConfig.browser.localBrowserAgent.execution,
    "claude-oauth",
    "claude-sonnet-4-6"
  );
});

test("settingsFormModel round-trips browser headed mode", () => {
  const form = settingsToForm(withResolved(normalizeSettings({
    agentStack: {
      runtimeConfig: {
        browser: {
          headed: true
        }
      }
    }
  })));

  assert.equal(form.browserHeaded, true);

  const patch = formToSettingsPatch(form);
  assert.equal(patch.agentStack.runtimeConfig.browser.headed, true);
});

test("getCodeAgentValidationError requires allowed users when code agent is enabled", () => {
  const form = settingsToForm(withResolved(normalizeSettings({})));
  form.stackAdvancedOverridesEnabled = true;
  form.codeAgentEnabled = true;
  form.codeAgentAllowedUserIds = "";

  assert.equal(
    getCodeAgentValidationError(form),
    "Add at least one allowed user ID before enabling the code agent."
  );

  form.codeAgentAllowedUserIds = "123456789";
  assert.equal(getCodeAgentValidationError(form), "");
});

test("settingsFormModel round-trips code agent provider fields", () => {
  const form = settingsToForm(withResolved(normalizeSettings({
    agentStack: {
      advancedOverridesEnabled: true,
      overrides: {
        devTeam: {
          codingWorkers: ["codex"]
        }
      },
      runtimeConfig: {
        devTeam: {
          claudeCode: {
            enabled: false,
            model: "sonnet"
          },
          codex: {
            enabled: true,
            model: "gpt-5-codex"
          }
        }
      }
    }
  })));

  assert.equal(form.codeAgentProvider, "codex");
  assert.equal(form.codeAgentModel, "sonnet");
  assert.equal(form.codeAgentCodexModel, "gpt-5-codex");

  const patch = formToSettingsPatch(form);
  assert.deepEqual(patch.agentStack.overrides.devTeam.codingWorkers, ["codex"]);
  assert.equal(patch.agentStack.runtimeConfig.devTeam.claudeCode.model, "sonnet");
  assert.equal(patch.agentStack.runtimeConfig.devTeam.codex.model, "gpt-5-codex");
});

test("settingsFormModel round-trips codex cli code agent fields", () => {
  const form = settingsToForm(withResolved(normalizeSettings({
    agentStack: {
      advancedOverridesEnabled: true,
      overrides: {
        devTeam: {
          codingWorkers: ["codex_cli"]
        }
      },
      runtimeConfig: {
        devTeam: {
          codexCli: {
            enabled: true,
            model: "gpt-5.4"
          }
        }
      }
    }
  })));

  assert.equal(form.codeAgentProvider, "codex-cli");
  assert.equal(form.codeAgentCodexCliModel, "gpt-5.4");

  const patch = formToSettingsPatch(form);
  assert.deepEqual(patch.agentStack.overrides.devTeam.codingWorkers, ["codex_cli"]);
  assert.equal(patch.agentStack.runtimeConfig.devTeam.codexCli.model, "gpt-5.4");
});

test("settingsFormModel enables role-selected coding workers even when provider stays auto", () => {
  const form = settingsToForm(withResolved(normalizeSettings({})));
  form.stackAdvancedOverridesEnabled = true;
  form.codeAgentEnabled = true;
  form.codeAgentAllowedUserIds = "123456789";
  form.codeAgentProvider = "auto";
  form.codeAgentRoleDesign = "claude_code";
  form.codeAgentRoleImplementation = "codex_cli";
  form.codeAgentRoleReview = "claude_code";
  form.codeAgentRoleResearch = "codex";

  const patch = formToSettingsPatch(form);

  assert.equal(patch.agentStack.runtimeConfig.devTeam.codex.enabled, true);
  assert.equal(patch.agentStack.runtimeConfig.devTeam.codexCli.enabled, true);
  assert.equal(patch.agentStack.runtimeConfig.devTeam.claudeCode.enabled, true);
  assert.equal(patch.agentStack.overrides.devTeam.codingWorkers, undefined);
  assert.equal(
    resolveAgentStack(normalizeSettings(patch)).devTeam.roles.research,
    "codex"
  );
});

test("settingsFormModel supports the claude_oauth preset (migrated from claude_oauth_local_tools)", () => {
  const form = settingsToForm(withResolved(normalizeSettings({
    agentStack: {
      preset: "claude_oauth_local_tools"
    }
  })));

  assert.equal(form.stackPreset, "claude_oauth");
  assert.equal(form.provider, "claude-oauth");
  assert.equal(form.model, "claude-opus-4-6");
  assert.equal(form.voiceReplyDecisionRealtimeAdmissionMode, "generation_decides");
  assert.equal(form.voiceReplyDecisionLlmProvider, "claude-oauth");
  assert.equal(form.voiceReplyDecisionLlmModel, "claude-sonnet-4-6");
  assert.equal(form.voiceGenerationLlmUseTextModel, false);
  assert.equal(form.voiceGenerationLlmProvider, "claude-oauth");
  assert.equal(form.voiceGenerationLlmModel, "claude-sonnet-4-6");

  const patch = formToSettingsPatch(form);
  assert.equal(patch.agentStack.preset, "claude_oauth");
});

test("settingsFormModel preserves adaptive admission defaults for openai_native_realtime", () => {
  const form = settingsToForm(withResolved(normalizeSettings({
    agentStack: {
      preset: "openai_native_realtime"
    }
  })));

  assert.equal(form.stackPreset, "openai_native_realtime");
  assert.equal(form.voiceReplyPath, "bridge");
  assert.equal(form.voiceReplyDecisionRealtimeAdmissionMode, "adaptive");
  assert.equal(form.voiceReplyDecisionLlmProvider, "openai");
  assert.equal(form.voiceReplyDecisionLlmModel, "gpt-5-mini");

  const patch = formToSettingsPatch(form);
  assert.equal(patch.voice.admission.mode, "adaptive");
});

test("settingsFormModel persists voice classifier overrides even when advanced overrides are off", () => {
  const form = settingsToForm(withResolved(normalizeSettings({
    agentStack: {
      preset: "claude_oauth"
    },
    voice: {
      admission: {
        mode: "classifier_gate"
      }
    }
  })));

  form.stackAdvancedOverridesEnabled = false;
  form.voiceReplyDecisionLlmProvider = "anthropic";
  form.voiceReplyDecisionLlmModel = "claude-haiku-4-5";

  const patch = formToSettingsPatch(form);
  assert.equal(patch.voice.admission.mode, "classifier_gate");
  assert.deepEqual(patch.agentStack.overrides.voiceAdmissionClassifier, {
    mode: "dedicated_model",
    model: {
      provider: "anthropic",
      model: "claude-haiku-4-5"
    }
  });
});

test("settingsFormModel persists classifier selections even when they match the preset fallback", () => {
  const form = settingsToForm(withResolved(normalizeSettings({
    agentStack: {
      preset: "claude_oauth",
      overrides: {
        voiceAdmissionClassifier: {
          mode: "dedicated_model",
          model: {
            provider: "claude-oauth",
            model: "claude-sonnet-4-5"
          }
        }
      }
    },
    voice: {
      admission: {
        mode: "adaptive"
      },
      conversationPolicy: {
        replyPath: "bridge"
      }
    }
  })));

  form.stackAdvancedOverridesEnabled = false;
  form.voiceReplyDecisionLlmProvider = "claude-oauth";
  form.voiceReplyDecisionLlmModel = "claude-sonnet-4-6";

  const patch = formToSettingsPatch(form);
  assert.equal(patch.voice.admission.mode, "adaptive");
  assert.deepEqual(patch.agentStack.overrides.voiceAdmissionClassifier, {
    mode: "dedicated_model",
    model: {
      provider: "claude-oauth",
      model: "claude-sonnet-4-6"
    }
  });
});

test("settingsFormModel uses canonical voice fallbacks when legacy form fields are blank", () => {
  const form = settingsToForm(withResolved(normalizeSettings({})));
  form.voiceReplyPath = "";
  form.voiceOperationalMessages = "";
  Reflect.set(form, "voiceReplyDecisionRealtimeAdmissionMode", "");

  const patch = formToSettingsPatch(form);

  assert.equal(patch.voice.conversationPolicy.replyPath, "brain");
  assert.equal(patch.voice.conversationPolicy.operationalMessages, "minimal");
  assert.equal(patch.voice.admission.mode, "generation_decides");
});

test("settingsFormModel forces bridge replies onto realtime output", () => {
  const form = settingsToForm(withResolved(normalizeSettings({
    voice: {
      conversationPolicy: {
        replyPath: "bridge",
        ttsMode: "api"
      }
    }
  })));

  assert.equal(form.voiceReplyPath, "bridge");
  assert.equal(form.voiceTtsMode, "realtime");

  form.voiceTtsMode = "api";
  const patch = formToSettingsPatch(form);

  assert.equal(patch.voice.conversationPolicy.replyPath, "bridge");
  assert.equal(patch.voice.conversationPolicy.ttsMode, "realtime");
});

test("settingsFormModel preserves adaptive voice admission and canonicalizes legacy aliases", () => {
  const form = settingsToForm(withResolved(normalizeSettings({
    voice: {
      admission: {
        mode: "adaptive"
      }
    }
  })));

  assert.equal(form.voiceReplyDecisionRealtimeAdmissionMode, "adaptive");

  const patch = formToSettingsPatch(form);
  assert.equal(patch.voice.admission.mode, "generation_decides");
});

test("applyStackPresetDefaults merges server-returned defaults into form", () => {
  const base = settingsToForm(withResolved(normalizeSettings({
    agentStack: { preset: "openai_native_realtime" }
  })));

  const patched = applyStackPresetDefaults(base, {
    stackPreset: "claude_oauth",
    provider: "claude-oauth",
    model: "claude-opus-4-6",
    voiceProvider: "openai",
    voiceReplyPath: "brain",
    voiceTtsMode: "realtime",
    voiceReplyDecisionRealtimeAdmissionMode: "generation_decides",
    voiceReplyDecisionLlmProvider: "claude-oauth",
    voiceReplyDecisionLlmModel: "claude-sonnet-4-6",
    voiceGenerationLlmUseTextModel: false,
    voiceGenerationLlmProvider: "claude-oauth",
    voiceGenerationLlmModel: "claude-sonnet-4-6"
  });

  assert.equal(patched.stackPreset, "claude_oauth");
  assert.equal(patched.provider, "claude-oauth");
  assert.equal(patched.model, "claude-opus-4-6");
  assert.equal(patched.voiceProvider, "openai");
  assert.equal(patched.voiceReplyPath, "brain");
  assert.equal(patched.voiceTtsMode, "realtime");
  assert.equal(patched.voiceReplyDecisionRealtimeAdmissionMode, "generation_decides");
  assert.equal(patched.voiceReplyDecisionLlmProvider, "claude-oauth");
  assert.equal(patched.voiceReplyDecisionLlmModel, "claude-sonnet-4-6");
  assert.equal(patched.voiceGenerationLlmUseTextModel, false);
  assert.equal(patched.voiceGenerationLlmProvider, "claude-oauth");
  assert.equal(patched.voiceGenerationLlmModel, "claude-sonnet-4-6");
});

test("settingsFormModel round-trips elevenlabs realtime settings", () => {
  const form = settingsToForm(withResolved(normalizeSettings({
    agentStack: {
      advancedOverridesEnabled: true,
        runtimeConfig: {
          voice: {
            runtimeMode: "elevenlabs_realtime",
            elevenLabsRealtime: {
              agentId: "agent_123",
              apiBaseUrl: "https://api.elevenlabs.io",
              inputSampleRateHz: 16000,
              outputSampleRateHz: 22050
            }
          }
        }
    }
  })));

  assert.equal(form.voiceProvider, "elevenlabs");
  assert.equal(form.voiceElevenLabsRealtimeAgentId, "agent_123");
  assert.equal(form.voiceElevenLabsRealtimeApiBaseUrl, "https://api.elevenlabs.io");
  assert.equal(form.voiceElevenLabsRealtimeInputSampleRateHz, 16000);
  assert.equal(form.voiceElevenLabsRealtimeOutputSampleRateHz, 22050);

  const patch = formToSettingsPatch(form);
  assert.equal(patch.agentStack.runtimeConfig.voice.runtimeMode, "elevenlabs_realtime");
  assert.equal(patch.agentStack.runtimeConfig.voice.elevenLabsRealtime.agentId, "agent_123");
  assert.equal(
    patch.agentStack.runtimeConfig.voice.elevenLabsRealtime.apiBaseUrl,
    "https://api.elevenlabs.io"
  );
  assert.equal(
    patch.agentStack.runtimeConfig.voice.elevenLabsRealtime.inputSampleRateHz,
    16000
  );
  assert.equal(
    patch.agentStack.runtimeConfig.voice.elevenLabsRealtime.outputSampleRateHz,
    22050
  );
});

test("settingsFormModel surfaces explicit legacy memory LLM overrides in the form view", () => {
  const form = settingsToForm({
    memoryLlm: {
      provider: "anthropic",
      model: "claude-haiku-4-5"
    }
  });

  assert.equal(form.memoryLlmInheritTextModel, false);
  assert.equal(form.memoryLlmProvider, "anthropic");
  form.memoryLlmProvider = "openai";
  form.memoryLlmModel = "gpt-5-mini";
  assert.equal(form.memoryLlmProvider, "openai");
  assert.equal(form.memoryLlmModel, "gpt-5-mini");
});

test("settingsFormModel keeps memory LLM inheriting the main text model by default", () => {
  const form = settingsToForm(withResolved(normalizeSettings({})));

  assert.equal(form.memoryLlmInheritTextModel, true);
  const patch = formToSettingsPatch(form);
  assert.deepEqual(patch.memoryLlm, {});
});

test("settingsToFormPreserving keeps user's comma format for aliases on reload", () => {
  const currentForm = settingsToForm(withResolved(normalizeSettings({
    identity: {
      botNameAliases: ["clank", "conk"]
    }
  })));
  // user edits to comma-separated
  currentForm.botNameAliases = "clank, conk";

  // server returns the same values after save
  const preserved = settingsToFormPreserving(
    withResolved(normalizeSettings({
      identity: {
        botNameAliases: ["clank", "conk"]
      }
    })),
    currentForm
  );
  assert.equal(preserved.botNameAliases, "clank, conk");

  // parsing still yields the correct array
  const patch = formToSettingsPatch(preserved);
  assert.deepEqual(patch.identity.botNameAliases, ["clank", "conk"]);
});

test("settingsToFormPreserving updates value when server content actually changed", () => {
  const currentForm = settingsToForm(withResolved(normalizeSettings({
    identity: {
      botNameAliases: ["clank", "conk"]
    }
  })));
  currentForm.botNameAliases = "clank, conk";

  // server returns different values (e.g. another admin added an alias)
  const preserved = settingsToFormPreserving(
    withResolved(normalizeSettings({
      identity: {
        botNameAliases: ["clank", "conk", "clanky"]
      }
    })),
    currentForm
  );
  assert.equal(preserved.botNameAliases, "clank, conk, clanky");
});

test("settingsToFormPreserving preserves newline format when user prefers it", () => {
  const currentForm = settingsToForm(withResolved(normalizeSettings({
    identity: {
      botNameAliases: ["a", "b"]
    }
  })));
  // user keeps newlines
  currentForm.botNameAliases = "a\nb";

  const preserved = settingsToFormPreserving(
    withResolved(normalizeSettings({
      identity: {
        botNameAliases: ["a", "b"]
      }
    })),
    currentForm
  );
  assert.equal(preserved.botNameAliases, "a\nb");
});
