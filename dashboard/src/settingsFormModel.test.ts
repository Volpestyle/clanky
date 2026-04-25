import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  formToSettingsPatch,
  formToSettingsSnapshot,
  getCodeAgentValidationError,
  getSettingsValidationError,
  resolveBrowserProviderModelOptions,
  resolveModelOptionsFromText,
  resolvePresetModelSelection,
  resolveProviderModelOptions,
  sanitizeAliasListInput,
  settingsToForm,
  settingsToFormPreserving
} from "./settingsFormModel.ts";
import { buildDashboardSettingsEnvelope } from "../../src/settings/dashboardSettingsState.ts";
import { normalizeSettings } from "../../src/store/settingsNormalization.ts";
import { resolveAgentStack } from "../../src/settings/agentStack.ts";

function withResolved(settings: unknown) {
  return buildDashboardSettingsEnvelope({ intent: settings, effective: settings });
}

function assertDedicatedExecutionModel(
  execution: {
    mode?: "inherit_orchestrator" | "dedicated_model" | "disabled";
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

function serializeForm(form: ReturnType<typeof settingsToForm>) {
  const patch = formToSettingsPatch(form);
  return {
    patch,
    effectivePatch: normalizeSettings(patch)
  };
}

test("settingsFormModel emits a full replacement snapshot for dashboard saves", () => {
  const effectiveSettings = normalizeSettings({
    permissions: {
      replies: {
        replyChannelIds: ["1", "2"]
      }
    },
    interaction: {
      activity: {
        responseWindowEagerness: 60
      },
      startup: {
        catchupEnabled: false
      }
    },
    agentStack: {
      advancedOverridesEnabled: true,
      overrides: {
        browserRuntime: "openai_computer_use",
        devTeam: {
          roles: {
            design: "claude_code",
            implementation: "claude_code",
            review: "claude_code",
            research: "claude_code"
          }
        },
        voiceAdmissionClassifier: {
          mode: "dedicated_model",
          model: {
            provider: "claude-oauth",
            model: "claude-sonnet-4-6"
          }
        },
        voiceInterruptClassifier: {
          mode: "dedicated_model",
          model: {
            provider: "claude-oauth",
            model: "claude-haiku-4-5"
          }
        }
      },
      runtimeConfig: {
        browser: {
          headed: true
        },
        voice: {
          musicBrain: {
            mode: "dedicated_model",
            model: {
              provider: "claude-oauth",
              model: "claude-haiku-4-5"
            }
          },
          generation: {
            mode: "dedicated_model",
            model: {
              provider: "claude-oauth",
              model: "claude-opus-4-6"
            }
          }
        }
      }
    },
    initiative: {
      text: {
        eagerness: 50
      }
    },
    voice: {
      conversationPolicy: {
        replyPath: "bridge"
      },
      admission: {
        mode: "classifier_gate"
      }
    }
  });
  const form = settingsToForm(withResolved(effectiveSettings));
  form.voiceReplyPath = "brain";

  const patch = formToSettingsPatch(form);
  const snapshot = formToSettingsSnapshot(form);

  assert.equal(patch.voice?.conversationPolicy?.replyPath, undefined);
  assert.equal(patch.agentStack?.preset, undefined);
  assert.equal(snapshot.voice.conversationPolicy.replyPath, "brain");
  assert.equal(snapshot.agentStack.preset, "claude_oauth");
  assert.equal(snapshot.permissions.replies.maxMessagesPerHour, 20);
});

test("settingsFormModel preserves dashboard-hidden settings in full save snapshots", () => {
  const effectiveSettings = normalizeSettings({
    interaction: {
      activity: {
        replyCoalesceWindowSeconds: 17,
        replyCoalesceMaxMessages: 11
      },
      replyGeneration: {
        pricing: {
          "custom-reply-model": {
            input: 1,
            output: 2
          }
        }
      }
    },
    agentStack: {
      overrides: {
        voiceInterruptClassifier: {
          mode: "dedicated_model",
          model: {
            provider: "anthropic",
            model: "claude-haiku-4-5"
          }
        }
      },
      runtimeConfig: {
        claudeOAuthSession: {
          sessionScope: "channel",
          inactivityTimeoutMs: 90_000,
          contextPruningStrategy: "sliding_window",
          maxPinnedStateChars: 32_000,
          voiceToolPolicy: "full",
          textToolPolicy: "fast_only"
        }
      }
    },
    memory: {
      promptSlice: {
        maxRecentMessages: 77
      },
      embeddingModel: "text-embedding-3-large",
      reflection: {
        enabled: false,
        hour: 22,
        minute: 15,
        maxFactsPerReflection: 42
      }
    },
    initiative: {
      voice: {
        execution: {
          mode: "dedicated_model",
          model: {
            provider: "claude-oauth",
            model: "claude-opus-4-6"
          },
          temperature: 0.7
        }
      }
    },
    voice: {
      admission: {
        wakeSignals: ["direct_address"]
      }
    },
    media: {
      videoContext: {
        execution: {
          mode: "dedicated_model",
          model: {
            provider: "openai",
            model: "gpt-5-mini"
          }
        }
      }
    },
    music: {
      ducking: {
        targetGain: 0.33,
        fadeMs: 450
      }
    }
  });
  const form = settingsToForm(withResolved(effectiveSettings));
  form.botName = "clanky-save-check";

  const snapshot = formToSettingsSnapshot(form);

  assert.equal(snapshot.identity.botName, "clanky-save-check");
  assert.equal(snapshot.interaction.activity.replyCoalesceWindowSeconds, 17);
  assert.equal(snapshot.interaction.activity.replyCoalesceMaxMessages, 11);
  assert.deepEqual(snapshot.interaction.replyGeneration.pricing, {
    "custom-reply-model": {
      input: 1,
      output: 2
    }
  });
  assert.deepEqual(snapshot.agentStack.runtimeConfig.claudeOAuthSession, {
    sessionScope: "channel",
    inactivityTimeoutMs: 90_000,
    contextPruningStrategy: "sliding_window",
    maxPinnedStateChars: 32_000,
    voiceToolPolicy: "full",
    textToolPolicy: "fast_only"
  });
  assert.deepEqual(snapshot.memory, {
    enabled: true,
    promptSlice: {
      maxRecentMessages: 77
    },
    embeddingModel: "text-embedding-3-large",
    reflection: {
      enabled: false,
      hour: 22,
      minute: 15,
      maxFactsPerReflection: 42
    }
  });
  assert.deepEqual(snapshot.initiative.voice.execution, {
    mode: "dedicated_model",
    model: {
      provider: "claude-oauth",
      model: "claude-opus-4-6"
    },
    temperature: 0.7
  });
  assert.deepEqual(snapshot.voice.admission.wakeSignals, ["direct_address"]);
  assert.deepEqual(snapshot.media.videoContext.execution, {
    mode: "dedicated_model",
    model: {
      provider: "openai",
      model: "gpt-5-mini"
    }
  });
  assert.deepEqual(snapshot.music.ducking, {
    targetGain: 0.33,
    fadeMs: 450
  });

  form.voiceInterruptLlmExplicit = false;
  form.voiceInterruptLlmProvider = "claude-oauth";
  form.voiceInterruptLlmModel = "claude-haiku-4-5";
  const clearedSnapshot = formToSettingsSnapshot(form);
  assert.equal(clearedSnapshot.agentStack.overrides.voiceInterruptClassifier, undefined);
});

test("settingsFormModel converts settings to form defaults and back to normalized patch", () => {
  const form = settingsToForm(withResolved(normalizeSettings({
    identity: {
      botName: "clanky",
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
          minSentencesPerChunk: 3,
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

  assert.equal(form.botName, "clanky");
  assert.equal(form.botNameAliases, "clank, conk");
  assert.equal(form.personaFlavor, "chaotic but kind");
  assert.equal(form.allowedChannels, "2\n3");
  assert.equal(form.voiceStreamingEnabled, true);
  assert.equal(form.voiceDefaultInterruptionMode, "none");
  assert.equal(form.browserLlmProvider, "claude-oauth");
  assert.equal(form.codeAgentProvider, "auto");
  assert.equal(form.textInitiativeUseTextModel, true);
  assert.equal(form.reasoningEffort, "low");

  form.personaHardLimits = "no hate\nno hate\nkeep it fun\n";
  form.botNameAliases = "clank\nconk\nclank\n";
  form.allowedChannels = "2\n2\n3\n";
  form.discoveryRssFeeds = "https://one.example/feed\nhttps://one.example/feed\n";
  form.discoveryXHandles = "@alice\n@alice\nbob\n";
  form.automationsEnabled = false;
  form.browserHeaded = true;
  form.voiceGenerationLlmUseTextModel = true;
  form.voiceStreamWatchVisualizerMode = "VECTORSCOPE";
  form.voiceStreamWatchKeyframeIntervalMs = 1750;
  form.voiceStreamWatchAutonomousCommentaryEnabled = false;
  form.voiceStreamWatchNoteIntervalSeconds = 6;
  form.voiceStreamWatchMaxNoteEntries = 5;
  form.voiceStreamWatchNotePrompt = "Use stream snapshots as context for replies.";
  form.voiceStreamWatchNativeDiscordMaxFramesPerSecond = 4;
  form.voiceStreamWatchNativeDiscordPreferredQuality = 88;
  form.voiceStreamWatchNativeDiscordPreferredPixelCount = 1920 * 1080;
  form.voiceStreamWatchNativeDiscordPreferredStreamType = "camera";
  form.voiceAsrLanguageMode = "fixed";
  form.voiceAsrLanguageHint = "en-us";
  form.voiceThinking = "enabled";
  form.voiceThinkingBudgetTokens = 2048;
  form.voiceStreamingEnabled = false;
  form.voiceStreamingMinSentencesPerChunk = 4;
  form.voiceStreamingEagerFirstChunkChars = 84;
  form.voiceStreamingMaxBufferChars = 340;
  form.voiceDefaultInterruptionMode = "speaker";
  form.voiceCommandOnlyMode = true;
  form.voiceOpenAiRealtimeTranscriptionMethod = "file_wav";
  form.voiceOpenAiRealtimeUsePerUserAsrBridge = false;
  form.codeAgentProvider = "codex-cli";
  form.codeAgentCodexCliModel = "gpt-5.3-codex";
  form.codeAgentRoleDesign = "claude_code";
  form.codeAgentRoleImplementation = "codex_cli";
  form.codeAgentRoleReview = "claude_code";
  form.codeAgentRoleResearch = "codex_cli";
  form.textInitiativeUseTextModel = false;
  form.textInitiativeLlmProvider = "anthropic";
  form.textInitiativeLlmModel = "claude-haiku-4-5";
  form.reasoningEffort = "xhigh";
  form.textInitiativeMinMinutesBetweenPosts = 15;
  form.textInitiativeMaxPostsPerDay = 6;
  form.textInitiativeAllowActiveCuriosity = false;
  form.textInitiativeMaxToolSteps = 2;
  form.textInitiativeMaxToolCalls = 3;
  form.discoveryFeedEnabled = false;
  form.discoveryAllowSelfCuration = false;
  form.discoveryMaxSourcesPerType = 7;
  form.discoveryMaxMediaPromptChars = 640;

  const { patch, effectivePatch } = serializeForm(form);
  assert.deepEqual(patch.identity.botNameAliases, ["clank", "conk"]);
  assert.deepEqual(patch.persona.hardLimits, ["no hate", "keep it fun"]);
  assert.deepEqual(patch.initiative.discovery.rssFeeds, ["https://one.example/feed"]);
  assert.deepEqual(patch.initiative.discovery.xHandles, ["@alice", "bob"]);
  assert.deepEqual(patch.permissions.replies.allowedChannelIds, ["2", "3"]);
  assert.equal(effectivePatch.agentStack.runtimeConfig.browser.headed, true);
  assert.equal(patch.automations.enabled, false);
  assertDedicatedExecutionModel(
    effectivePatch.initiative.text.execution,
    "anthropic",
    "claude-haiku-4-5"
  );
  assert.equal(effectivePatch.initiative.text.minMinutesBetweenPosts, 15);
  assert.equal(effectivePatch.initiative.text.maxPostsPerDay, 6);
  assert.equal(effectivePatch.initiative.text.allowActiveCuriosity, false);
  assert.equal(effectivePatch.initiative.text.maxToolSteps, 2);
  assert.equal(effectivePatch.initiative.text.maxToolCalls, 3);
  assert.equal(effectivePatch.voice.streamWatch.visualizerMode, "vectorscope");
  assert.equal(effectivePatch.voice.streamWatch.notePrompt, "Use stream snapshots as context for replies.");
  assert.equal(effectivePatch.voice.conversationPolicy.streaming.enabled, false);
  assert.equal(effectivePatch.voice.conversationPolicy.thinking, "enabled");
  assert.equal(effectivePatch.voice.conversationPolicy.thinkingBudgetTokens, 2048);
  assert.equal(effectivePatch.voice.conversationPolicy.defaultInterruptionMode, "speaker");
  assert.equal(effectivePatch.voice.conversationPolicy.commandOnlyMode, true);
  assert.equal(effectivePatch.agentStack.runtimeConfig.voice.openaiRealtime.transcriptionMethod, "file_wav");
  assert.equal(effectivePatch.agentStack.runtimeConfig.voice.openaiRealtime.usePerUserAsrBridge, false);
  assert.equal(effectivePatch.voice.transcription.languageMode, "fixed");
  assert.deepEqual(patch.agentStack.overrides.devTeam.codingWorkers, ["codex_cli"]);
  assert.deepEqual(patch.agentStack.overrides.devTeam.roles, {
    design: "claude_code",
    implementation: "codex_cli",
    review: "claude_code",
    research: "codex_cli"
  });
  assert.equal(effectivePatch.agentStack.runtimeConfig.devTeam.codexCli.model, "gpt-5.3-codex");
  assert.equal(effectivePatch.interaction.replyGeneration.reasoningEffort, "xhigh");
  assert.equal(effectivePatch.initiative.voice.enabled, true);
  assert.equal(effectivePatch.initiative.discovery.sources.reddit, false);
  assert.equal(effectivePatch.initiative.discovery.allowSelfCuration, false);
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
  assert.deepEqual(openai, ["claude-haiku-4-5", "gpt-5.2", "gpt-5.4-mini", "gpt-5-mini", "gpt-5"]);

  const anthropic = resolveProviderModelOptions(
    {
      anthropic: []
    },
    "anthropic"
  );
  assert.deepEqual(anthropic, ["claude-haiku-4-5", "claude-sonnet-4-6", "claude-sonnet-4-0"]);
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
  assert.deepEqual(claudeOAuth, ["claude-haiku-4-5", "claude-opus-4-6", "claude-sonnet-4-6", "claude-sonnet-4-0"]);
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
  const { effectivePatch } = serializeForm(form);
  assert.equal(effectivePatch.agentStack.runtimeConfig.voice.runtimeMode, "openai_realtime");
});

test("settingsFormModel preserves a full-brain reply-path override on the openai native realtime preset", () => {
  const presetEnvelope = withResolved(normalizeSettings({
    agentStack: {
      preset: "openai_native_realtime"
    }
  }));
  const form = settingsToForm(presetEnvelope);

  assert.equal(form.voiceReplyPath, "bridge");

  form.voiceReplyPath = "brain";
  const { patch, effectivePatch } = serializeForm(form);

  assert.equal(patch.voice?.conversationPolicy?.replyPath, "brain");
  assert.equal(effectivePatch.voice.conversationPolicy.replyPath, "brain");
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
  const { effectivePatch } = serializeForm(form);
  assert.equal(effectivePatch.agentStack.runtimeConfig.voice.runtimeMode, "openai_realtime");
  assert.equal(effectivePatch.agentStack.runtimeConfig.voice.openaiRealtime.transcriptionMethod, "file_wav");
  assert.equal(effectivePatch.agentStack.runtimeConfig.voice.openaiAudioApi.ttsVoice, "ash");
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

  const { effectivePatch } = serializeForm(form);
  assertDedicatedExecutionModel(
    effectivePatch.agentStack.runtimeConfig.browser.localBrowserAgent.execution,
    "claude-oauth",
    "claude-sonnet-4-6"
  );
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

test("getSettingsValidationError blocks blank browser numeric inputs even without advanced overrides", () => {
  const form = settingsToForm(withResolved(normalizeSettings({})));
  form.browserEnabled = true;
  (form as Record<string, unknown>).browserMaxPerHour = "";

  assert.deepEqual(getSettingsValidationError(form), {
    sectionId: "sec-browser",
    message: "Max browse calls per hour is required."
  });
});

test("getSettingsValidationError blocks blank numeric inputs that do not have explicit range checks", () => {
  const videoForm = settingsToForm(withResolved(normalizeSettings({})));
  (videoForm as Record<string, unknown>).videoContextMaxChars = "";
  assert.deepEqual(getSettingsValidationError(videoForm), {
    sectionId: "sec-media",
    message: "Video context max chars is required."
  });

  const streamWatchForm = settingsToForm(withResolved(normalizeSettings({})));
  (streamWatchForm as Record<string, unknown>).voiceStreamWatchCommentaryIntervalSeconds = "";
  assert.deepEqual(getSettingsValidationError(streamWatchForm), {
    sectionId: "sec-voice",
    message: "Voice stream watch commentary interval seconds is required."
  });

  const webSearchForm = settingsToForm(withResolved(normalizeSettings({})));
  (webSearchForm as Record<string, unknown>).webSearchMaxPages = "";
  assert.deepEqual(getSettingsValidationError(webSearchForm), {
    sectionId: "sec-research",
    message: "Web search max pages is required."
  });
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

  const { patch, effectivePatch } = serializeForm(form);
  assert.deepEqual(patch.agentStack.overrides.devTeam.codingWorkers, ["codex_cli"]);
  assert.equal(effectivePatch.agentStack.runtimeConfig.devTeam.codexCli.model, "gpt-5.4");
});

test("settingsFormModel preserves code-agent workspace mode and swarm runtime config", () => {
  const form = settingsToForm(withResolved(normalizeSettings({
    agentStack: {
      advancedOverridesEnabled: true,
      runtimeConfig: {
        devTeam: {
          workspace: {
            mode: "shared_checkout"
          },
          swarm: {
            enabled: true,
            serverName: "swarm-bus",
            command: "bun",
            args: ["run", "C:/Users/volpe/swarm-mcp/src/index.ts"],
            dbPath: "C:/shared/swarm.db",
            appendCoordinationPrompt: false
          },
          codexCli: {
            enabled: true,
            model: "gpt-5.4"
          }
        }
      }
    }
  })));

  assert.equal(form.codeAgentWorkspaceMode, "shared_checkout");

  const { patch, effectivePatch } = serializeForm(form);
  assert.equal(patch.agentStack.runtimeConfig.devTeam.workspace.mode, "shared_checkout");
  assert.deepEqual(effectivePatch.agentStack.runtimeConfig.devTeam.swarm, {
    enabled: true,
    serverName: "swarm-bus",
    command: "bun",
    args: ["run", "C:/Users/volpe/swarm-mcp/src/index.ts"],
    dbPath: "C:/shared/swarm.db",
    appendCoordinationPrompt: false
  });
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
  form.codeAgentRoleResearch = "codex_cli";

  const patch = formToSettingsPatch(form);

  assert.equal(patch.agentStack.runtimeConfig.devTeam.codexCli.enabled, true);
  assert.equal(patch.agentStack.runtimeConfig.devTeam.claudeCode.enabled, true);
  assert.equal(patch.agentStack.overrides.devTeam.codingWorkers, undefined);
  assert.equal(
    resolveAgentStack(normalizeSettings(patch)).devTeam.roles.research,
    "codex_cli"
  );
});

test("settingsFormModel persists dedicated music brain selections", () => {
  const form = settingsToForm(withResolved(normalizeSettings({
    agentStack: {
      preset: "claude_oauth"
    }
  })));

  form.voiceMusicBrainMode = "dedicated_model";
  form.voiceMusicBrainLlmProvider = "anthropic";
  form.voiceMusicBrainLlmModel = "claude-haiku-4-5";

  const { patch, effectivePatch } = serializeForm(form);
  assert.equal(patch.agentStack.runtimeConfig.voice.musicBrain.mode, "dedicated_model");
  assert.deepEqual(effectivePatch.agentStack.runtimeConfig.voice.musicBrain, {
    mode: "dedicated_model",
    model: {
      provider: "anthropic",
      model: "claude-haiku-4-5"
    }
  });
});

test("settingsFormModel persists dedicated Minecraft brain selections", () => {
  const form = settingsToForm(withResolved(normalizeSettings({
    agentStack: {
      preset: "claude_oauth"
    }
  })));

  form.minecraftBrainUseTextModel = false;
  form.minecraftBrainLlmProvider = "anthropic";
  form.minecraftBrainLlmModel = "claude-haiku-4-5";

  const { patch, effectivePatch } = serializeForm(form);
  assert.equal(patch.agentStack.runtimeConfig.minecraft.execution.mode, "dedicated_model");
  assert.deepEqual(effectivePatch.agentStack.runtimeConfig.minecraft.execution, {
    mode: "dedicated_model",
    model: {
      provider: "anthropic",
      model: "claude-haiku-4-5"
    }
  });
});

test("settingsFormModel round-trips Minecraft narration knobs", () => {
  const form = settingsToForm(withResolved(normalizeSettings({
    agentStack: {
      runtimeConfig: {
        minecraft: {
          enabled: true,
          narration: {
            eagerness: 72,
            minSecondsBetweenPosts: 45
          }
        }
      }
    }
  })));

  assert.equal(form.minecraftNarrationEagerness, 72);
  assert.equal(form.minecraftNarrationMinSecondsBetweenPosts, 45);

  form.minecraftNarrationEagerness = 10;
  form.minecraftNarrationMinSecondsBetweenPosts = 600;

  const { effectivePatch } = serializeForm(form);
  assert.deepEqual(effectivePatch.agentStack.runtimeConfig.minecraft.narration, {
    eagerness: 10,
    minSecondsBetweenPosts: 600
  });
});

test("settingsFormModel preserves hidden Minecraft server and project config on save", () => {
  const form = settingsToForm(withResolved(normalizeSettings({
    agentStack: {
      runtimeConfig: {
        minecraft: {
          enabled: true,
          server: {
            label: "Survival",
            host: "survival.example",
            port: 25565,
            description: "Primary world"
          },
          serverCatalog: [{
            label: "Creative",
            host: "creative.example",
            port: 25566,
            description: "Sandbox"
          }],
          project: {
            defaultActionBudget: 77
          }
        }
      }
    }
  })));

  form.minecraftNarrationEagerness = 33;

  const snapshot = formToSettingsSnapshot(form);
  assert.deepEqual(snapshot.agentStack.runtimeConfig.minecraft.server, {
    label: "Survival",
    host: "survival.example",
    port: 25565,
    description: "Primary world"
  });
  assert.deepEqual(snapshot.agentStack.runtimeConfig.minecraft.serverCatalog, [{
    label: "Creative",
    host: "creative.example",
    port: 25566,
    description: "Sandbox"
  }]);
  assert.deepEqual(snapshot.agentStack.runtimeConfig.minecraft.project, {
    defaultActionBudget: 77
  });
});

test("settingsFormModel persists bridge classifier overrides even when advanced overrides are off", () => {
  const form = settingsToForm(withResolved(normalizeSettings({
    agentStack: {
      preset: "claude_oauth"
    },
    voice: {
      admission: {
        mode: "classifier_gate"
      },
      conversationPolicy: {
        replyPath: "bridge"
      }
    }
  })));

  form.stackAdvancedOverridesEnabled = false;
  form.voiceReplyDecisionLlmProvider = "anthropic";
  form.voiceReplyDecisionLlmModel = "claude-haiku-4-5";

  const { patch, effectivePatch } = serializeForm(form);
  assert.equal(patch.voice.conversationPolicy.replyPath, "bridge");
  assert.equal(patch.voice.admission.mode, "classifier_gate");
  assert.deepEqual(effectivePatch.agentStack.overrides.voiceAdmissionClassifier, {
    mode: "dedicated_model",
    model: {
      provider: "anthropic",
      model: "claude-haiku-4-5"
    }
  });
});

test("settingsFormModel preserves optional full-brain classifier admission", () => {
  const form = settingsToForm(withResolved(normalizeSettings({
    agentStack: {
      preset: "claude_oauth"
    },
    voice: {
      admission: {
        mode: "classifier_gate"
      },
      conversationPolicy: {
        replyPath: "brain"
      }
    }
  })));

  assert.equal(form.voiceReplyPath, "brain");
  assert.equal(form.voiceReplyDecisionRealtimeAdmissionMode, "classifier_gate");
  assert.equal(form.voiceReplyDecisionLlmProvider, "claude-oauth");
  assert.equal(form.voiceReplyDecisionLlmModel, "claude-sonnet-4-6");

  const { effectivePatch } = serializeForm(form);
  assert.equal(effectivePatch.voice.conversationPolicy.replyPath, "brain");
  assert.equal(effectivePatch.voice.admission.mode, "classifier_gate");
  assert.deepEqual(effectivePatch.agentStack.overrides.voiceAdmissionClassifier, {
    mode: "dedicated_model",
    model: {
      provider: "claude-oauth",
      model: "claude-sonnet-4-6"
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
        mode: "classifier_gate"
      },
      conversationPolicy: {
        replyPath: "bridge"
      }
    }
  })));

  form.stackAdvancedOverridesEnabled = false;
  form.voiceReplyDecisionLlmProvider = "claude-oauth";
  form.voiceReplyDecisionLlmModel = "claude-sonnet-4-6";

  const { patch, effectivePatch } = serializeForm(form);
  assert.equal(patch.voice.admission.mode, "classifier_gate");
  assert.deepEqual(effectivePatch.agentStack.overrides.voiceAdmissionClassifier, {
    mode: "dedicated_model",
    model: {
      provider: "claude-oauth",
      model: "claude-sonnet-4-6"
    }
  });
});

test("settingsFormModel uses canonical voice fallbacks when form fields are blank", () => {
  const form = settingsToForm(withResolved(normalizeSettings({})));
  form.voiceReplyPath = "";
  form.voiceOperationalMessages = "";
  Reflect.set(form, "voiceReplyDecisionRealtimeAdmissionMode", "");

  const { effectivePatch } = serializeForm(form);

  assert.equal(effectivePatch.voice.conversationPolicy.replyPath, "brain");
  assert.equal(effectivePatch.voice.conversationPolicy.operationalMessages, "minimal");
  assert.equal(effectivePatch.voice.admission.mode, "generation_decides");
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
  const { patch, effectivePatch } = serializeForm(form);

  assert.equal(patch.voice.conversationPolicy.replyPath, "bridge");
  assert.equal(effectivePatch.voice.conversationPolicy.ttsMode, "realtime");
});

test("settingsFormModel round-trips elevenlabs realtime settings", () => {
  const form = settingsToForm(withResolved(normalizeSettings({
    voice: {
      transcription: {
        provider: "elevenlabs"
      },
      conversationPolicy: {
        replyPath: "brain",
        ttsMode: "api"
      }
    },
    agentStack: {
      advancedOverridesEnabled: true,
        runtimeConfig: {
          voice: {
            runtimeMode: "elevenlabs_realtime",
            elevenLabsRealtime: {
              voiceId: "voice_123",
              ttsModel: "eleven_multilingual_v2",
              transcriptionModel: "scribe_v1",
              apiBaseUrl: "https://api.elevenlabs.io",
              inputSampleRateHz: 16000,
              outputSampleRateHz: 22050
            }
          }
        }
    }
  })));

  assert.equal(form.voiceProvider, "elevenlabs");
  assert.equal(form.voiceTranscriptionProvider, "elevenlabs");
  assert.equal(form.voiceElevenLabsRealtimeVoiceId, "voice_123");
  assert.equal(form.voiceElevenLabsRealtimeTtsModel, "eleven_multilingual_v2");
  assert.equal(form.voiceElevenLabsRealtimeTranscriptionModel, "scribe_v1");
  assert.equal(form.voiceElevenLabsRealtimeApiBaseUrl, "https://api.elevenlabs.io");
  assert.equal(form.voiceElevenLabsRealtimeInputSampleRateHz, 16000);
  assert.equal(form.voiceElevenLabsRealtimeOutputSampleRateHz, 22050);

  const { effectivePatch } = serializeForm(form);
  assert.equal(effectivePatch.agentStack.runtimeConfig.voice.runtimeMode, "elevenlabs_realtime");
  assert.equal(effectivePatch.voice.transcription.provider, "elevenlabs");
  assert.equal(effectivePatch.voice.conversationPolicy.replyPath, "brain");
  assert.equal(effectivePatch.voice.conversationPolicy.ttsMode, "api");
  assert.equal(effectivePatch.agentStack.runtimeConfig.voice.elevenLabsRealtime.voiceId, "voice_123");
  assert.equal(
    effectivePatch.agentStack.runtimeConfig.voice.elevenLabsRealtime.ttsModel,
    "eleven_multilingual_v2"
  );
  assert.equal(
    effectivePatch.agentStack.runtimeConfig.voice.elevenLabsRealtime.transcriptionModel,
    "scribe_v1"
  );
  assert.equal(
    effectivePatch.agentStack.runtimeConfig.voice.elevenLabsRealtime.apiBaseUrl,
    "https://api.elevenlabs.io"
  );
  assert.equal(
    effectivePatch.agentStack.runtimeConfig.voice.elevenLabsRealtime.inputSampleRateHz,
    16000
  );
  assert.equal(
    effectivePatch.agentStack.runtimeConfig.voice.elevenLabsRealtime.outputSampleRateHz,
    22050
  );
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
