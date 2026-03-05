import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  formToSettingsPatch,
  resolveBrowserProviderModelOptions,
  resolveModelOptionsFromText,
  resolvePresetModelSelection,
  resolveProviderModelOptions,
  sanitizeAliasListInput,
  settingsToForm,
  settingsToFormPreserving
} from "./settingsFormModel.ts";

test("settingsFormModel converts settings to form defaults and back to normalized patch", () => {
  const form = settingsToForm({
    botName: "clanker conk",
    botNameAliases: ["clank", "conk", "clank"],
    persona: {
      flavor: "chaotic but kind",
      hardLimits: ["no hate", "no hate", "keep it fun"]
    },
    llm: {
      provider: "openai",
      model: "claude-haiku-4-5"
    },
    permissions: {
      replyChannelIds: ["1", "2"],
      allowedChannelIds: ["2", "3"],
      blockedChannelIds: ["9"],
      blockedUserIds: ["u-1"]
    }
  });

  assert.equal(form.botName, "clanker conk");
  assert.equal(form.botNameAliases, "clank\nconk\nclank");
  assert.equal(form.personaFlavor, "chaotic but kind");
  assert.equal(form.personaHardLimits, "no hate\nno hate\nkeep it fun");
  assert.equal(form.provider, "openai");
  assert.equal(form.model, "claude-haiku-4-5");
  assert.equal(form.voiceGenerationLlmUseTextModel, true);
  assert.equal(form.voiceGenerationLlmProvider, "anthropic");
  assert.equal(form.voiceGenerationLlmModel, "claude-sonnet-4-6");
  assert.equal(form.replyFollowupMaxToolSteps, 2);
  assert.equal(form.replyFollowupMaxTotalToolCalls, 3);
  assert.equal(form.replyFollowupMaxWebSearchCalls, 2);
  assert.equal(form.replyFollowupMaxMemoryLookupCalls, 2);
  assert.equal(form.replyFollowupMaxImageLookupCalls, 2);
  assert.equal(form.replyFollowupToolTimeoutMs, 10000);
  assert.equal(form.browserLlmProvider, "anthropic");
  assert.equal(form.browserLlmModel, "claude-sonnet-4-5-20250929");
  assert.equal(form.codeAgentProvider, "claude-code");
  assert.equal(form.codeAgentModel, "sonnet");
  assert.equal(form.codeAgentCodexModel, "codex-mini-latest");
  assert.equal(form.memoryReflectionStrategy, "two_pass_extract_then_main");
  assert.equal(form.adaptiveDirectivesEnabled, true);
  assert.equal(form.automationsEnabled, true);
  assert.equal(form.voiceThoughtEngineEnabled, true);
  assert.equal(form.voiceThoughtEngineProvider, "anthropic");
  assert.equal(form.voiceThoughtEngineModel, "claude-sonnet-4-6");
  assert.equal(form.voiceThoughtEngineTemperature, 1.2);
  assert.equal(form.voiceThoughtEngineEagerness, 50);
  assert.equal(form.voiceStreamWatchCommentaryPath, "auto");
  assert.equal(form.voiceStreamWatchKeyframeIntervalMs, 1200);
  assert.equal(form.voiceStreamWatchAutonomousCommentaryEnabled, true);
  assert.equal(form.voiceStreamWatchBrainContextEnabled, true);
  assert.equal(form.voiceStreamWatchBrainContextMinIntervalSeconds, 4);
  assert.equal(form.voiceStreamWatchBrainContextMaxEntries, 8);
  assert.equal(form.voiceAsrLanguageMode, "auto");
  assert.equal(form.voiceAsrLanguageHint, "en");
  assert.equal(form.voiceCommandOnlyMode, false);
  assert.equal(form.voiceOpenAiRealtimeTranscriptionMethod, "realtime_bridge");
  assert.equal(form.voiceOpenAiRealtimeUsePerUserAsrBridge, true);
  assert.equal(
    form.voiceStreamWatchBrainContextPrompt,
    "For each keyframe, classify it as gameplay or non-gameplay, then generate notes that support either play-by-play commentary or observational shout-out commentary."
  );
  assert.equal(form.replyChannels, "1\n2");
  assert.equal(form.allowedChannels, "2\n3");
  assert.equal(form.voiceBrainProvider, "openai");

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
  form.memoryReflectionStrategy = "one_pass_main";
  form.adaptiveDirectivesEnabled = false;
  form.automationsEnabled = false;
  form.voiceGenerationLlmUseTextModel = true;
  form.voiceStreamWatchCommentaryPath = "anthropic_keyframes";
  form.voiceStreamWatchKeyframeIntervalMs = 1750;
  form.voiceStreamWatchAutonomousCommentaryEnabled = false;
  form.voiceStreamWatchBrainContextEnabled = true;
  form.voiceStreamWatchBrainContextMinIntervalSeconds = 6;
  form.voiceStreamWatchBrainContextMaxEntries = 5;
  form.voiceStreamWatchBrainContextPrompt = "Use stream snapshots as context for replies.";
  form.voiceAsrLanguageMode = "fixed";
  form.voiceAsrLanguageHint = "en-us";
  form.voiceCommandOnlyMode = true;
  form.voiceOpenAiRealtimeTranscriptionMethod = "file_wav";
  form.voiceOpenAiRealtimeUsePerUserAsrBridge = false;
  form.codeAgentProvider = "codex";
  form.codeAgentCodexModel = "gpt-5-codex";

  const patch = formToSettingsPatch(form);
  assert.deepEqual(patch.botNameAliases, ["clank", "conk"]);
  assert.deepEqual(patch.persona.hardLimits, ["no hate", "keep it fun"]);
  assert.deepEqual(patch.permissions.allowedChannelIds, ["2", "3"]);
  assert.deepEqual(patch.discovery.rssFeeds, ["https://one.example/feed"]);
  assert.deepEqual(patch.discovery.xHandles, ["@alice", "bob"]);
  assert.equal(patch.voice.brainProvider, "openai");
  assert.equal(patch.replyFollowupLlm.maxToolSteps, 5);
  assert.equal(patch.replyFollowupLlm.maxTotalToolCalls, 11);
  assert.equal(patch.replyFollowupLlm.maxWebSearchCalls, 4);
  assert.equal(patch.replyFollowupLlm.maxMemoryLookupCalls, 3);
  assert.equal(patch.replyFollowupLlm.maxImageLookupCalls, 1);
  assert.equal(patch.replyFollowupLlm.toolTimeoutMs, 16000);
  assert.equal(patch.browser.llm.provider, "anthropic");
  assert.equal(patch.browser.llm.model, "claude-sonnet-4-5-20250929");
  assert.equal(patch.memory.reflection.strategy, "one_pass_main");
  assert.equal(patch.adaptiveDirectives.enabled, false);
  assert.equal(patch.automations.enabled, false);
  assert.equal(patch.voice.generationLlm.useTextModel, true);
  assert.equal(patch.voice.streamWatch.commentaryPath, "anthropic_keyframes");
  assert.equal(patch.voice.streamWatch.keyframeIntervalMs, 1750);
  assert.equal(patch.voice.streamWatch.autonomousCommentaryEnabled, false);
  assert.equal(patch.voice.streamWatch.brainContextEnabled, true);
  assert.equal(patch.voice.streamWatch.brainContextMinIntervalSeconds, 6);
  assert.equal(patch.voice.streamWatch.brainContextMaxEntries, 5);
  assert.equal(patch.voice.streamWatch.brainContextPrompt, "Use stream snapshots as context for replies.");
  assert.equal(patch.voice.commandOnlyMode, true);
  assert.equal(patch.voice.openaiRealtime.transcriptionMethod, "file_wav");
  assert.equal(patch.voice.openaiRealtime.usePerUserAsrBridge, false);
  assert.equal(patch.voice.asrLanguageMode, "fixed");
  assert.equal(patch.voice.asrLanguageHint, "en-us");
  assert.equal(patch.codeAgent.provider, "codex");
  assert.equal(patch.codeAgent.codexModel, "gpt-5-codex");
  assert.equal(patch.voice.thoughtEngine.enabled, true);
  assert.equal(patch.voice.thoughtEngine.provider, "anthropic");
  assert.equal(patch.voice.thoughtEngine.model, "claude-sonnet-4-6");
  assert.equal(patch.voice.thoughtEngine.temperature, 1.2);
  assert.equal(patch.voice.thoughtEngine.eagerness, 50);
});

test("settingsToForm preserves explicit empty prompt overrides", () => {
  const form = settingsToForm({
    prompt: {
      capabilityHonestyLine: "",
      impossibleActionLine: "",
      memoryEnabledLine: "",
      memoryDisabledLine: "",
      skipLine: "",
      textGuidance: [],
      voiceGuidance: [],
      voiceOperationalGuidance: [],
      voiceLookupBusySystemPrompt: "",
      mediaPromptCraftGuidance: ""
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
  assert.equal(form.promptVoiceLookupBusySystemPrompt, "");
  assert.equal(form.promptMediaPromptCraftGuidance, "");
});

test("formToSettingsPatch parses bot aliases from comma-separated single-line input", () => {
  const form = settingsToForm({});
  form.botNameAliases = "clank, conk, clank";

  const patch = formToSettingsPatch(form);
  assert.deepEqual(patch.botNameAliases, ["clank", "conk"]);
});

test("sanitizeAliasListInput removes duplicate aliases and normalizes separators", () => {
  assert.equal(
    sanitizeAliasListInput("clank, conk\nclank,clanky\nconk"),
    "clank\nconk\nclanky"
  );
});

test("settingsToForm uses default prompt guidance lists when omitted", () => {
  const form = settingsToForm({});
  assert.equal(form.promptTextGuidance.length > 0, true);
  assert.equal(form.promptVoiceGuidance.length > 0, true);
  assert.equal(form.promptVoiceOperationalGuidance.length > 0, true);
});

test("resolveProviderModelOptions merges catalog values with provider fallback defaults", () => {
  const openai = resolveProviderModelOptions(
    {
      openai: ["claude-haiku-4-5", "claude-haiku-4-5", "gpt-5.2"]
    },
    "openai"
  );
  assert.deepEqual(openai, ["claude-haiku-4-5", "gpt-5.2"]);

  const anthropic = resolveProviderModelOptions(
    {
      anthropic: []
    },
    "anthropic"
  );
  assert.deepEqual(anthropic, ["claude-haiku-4-5"]);
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
});

test("resolvePresetModelSelection always resolves to a real dropdown option", () => {
  const nonClaude = resolvePresetModelSelection({
    modelCatalog: {
      openai: ["claude-haiku-4-5"]
    },
    provider: "openai",
    model: "custom-model-not-listed"
  });
  assert.equal(nonClaude.selectedPresetModel, "claude-haiku-4-5");

  const claudeCode = resolvePresetModelSelection({
    modelCatalog: {
      "claude-code": ["opus", "sonnet"]
    },
    provider: "claude-code",
    model: "nonexistent"
  });
  assert.equal(claudeCode.selectedPresetModel, "opus");
});

test("resolveModelOptionsFromText normalizes model lists for dropdown options", () => {
  const options = resolveModelOptionsFromText(
    "gpt-image-1.5\ngpt-image-1.5\n",
    "grok-imagine-image",
    ["", "grok-imagine-image"]
  );
  assert.deepEqual(options, ["gpt-image-1.5", "grok-imagine-image"]);
});

test("settingsFormModel round-trips voice provider and brain provider", () => {
  const form = settingsToForm({
    voice: {
      voiceProvider: "openai",
      brainProvider: "anthropic"
    }
  });

  assert.equal(form.voiceBrainProvider, "anthropic");
  const patch = formToSettingsPatch(form);
  assert.equal(patch.voice.brainProvider, "anthropic");
});

test("settingsFormModel round-trips browser llm provider and model", () => {
  const form = settingsToForm({
    browser: {
      llm: {
        provider: "openai",
        model: "gpt-5-mini"
      }
    }
  });

  assert.equal(form.browserLlmProvider, "openai");
  assert.equal(form.browserLlmModel, "gpt-5-mini");

  const patch = formToSettingsPatch(form);
  assert.equal(patch.browser.llm.provider, "openai");
  assert.equal(patch.browser.llm.model, "gpt-5-mini");
});

test("settingsFormModel round-trips code agent provider fields", () => {
  const form = settingsToForm({
    codeAgent: {
      provider: "codex",
      model: "sonnet",
      codexModel: "gpt-5-codex"
    }
  });

  assert.equal(form.codeAgentProvider, "codex");
  assert.equal(form.codeAgentModel, "sonnet");
  assert.equal(form.codeAgentCodexModel, "gpt-5-codex");

  const patch = formToSettingsPatch(form);
  assert.equal(patch.codeAgent.provider, "codex");
  assert.equal(patch.codeAgent.model, "sonnet");
  assert.equal(patch.codeAgent.codexModel, "gpt-5-codex");
});

test("settingsFormModel round-trips elevenlabs realtime settings", () => {
  const form = settingsToForm({
    voice: {
      voiceProvider: "elevenlabs",
      elevenLabsRealtime: {
        agentId: "agent_123",
        apiBaseUrl: "https://api.elevenlabs.io",
        inputSampleRateHz: 16000,
        outputSampleRateHz: 22050
      }
    }
  });

  assert.equal(form.voiceProvider, "elevenlabs");
  assert.equal(form.voiceElevenLabsRealtimeAgentId, "agent_123");
  assert.equal(form.voiceElevenLabsRealtimeApiBaseUrl, "https://api.elevenlabs.io");
  assert.equal(form.voiceElevenLabsRealtimeInputSampleRateHz, 16000);
  assert.equal(form.voiceElevenLabsRealtimeOutputSampleRateHz, 22050);

  const patch = formToSettingsPatch(form);
  assert.equal(patch.voice.voiceProvider, "elevenlabs");
  assert.equal(patch.voice.elevenLabsRealtime.agentId, "agent_123");
  assert.equal(patch.voice.elevenLabsRealtime.apiBaseUrl, "https://api.elevenlabs.io");
  assert.equal(patch.voice.elevenLabsRealtime.inputSampleRateHz, 16000);
  assert.equal(patch.voice.elevenLabsRealtime.outputSampleRateHz, 22050);
});

test("settingsFormModel preserves explicit reflection strategy values", () => {
  const form = settingsToForm({
    memory: {
      reflection: {
        strategy: "one_pass_main"
      }
    }
  });

  assert.equal(form.memoryReflectionStrategy, "one_pass_main");
  form.memoryReflectionStrategy = "two_pass_extract_then_main";

  const patch = formToSettingsPatch(form);
  assert.equal(patch.memory.reflection.strategy, "two_pass_extract_then_main");
});

test("settingsToFormPreserving keeps user's comma format for aliases on reload", () => {
  const currentForm = settingsToForm({ botNameAliases: ["clank", "conk"] });
  // user edits to comma-separated
  currentForm.botNameAliases = "clank, conk";

  // server returns the same values after save
  const preserved = settingsToFormPreserving({ botNameAliases: ["clank", "conk"] }, currentForm);
  assert.equal(preserved.botNameAliases, "clank, conk");

  // parsing still yields the correct array
  const patch = formToSettingsPatch(preserved);
  assert.deepEqual(patch.botNameAliases, ["clank", "conk"]);
});

test("settingsToFormPreserving updates value when server content actually changed", () => {
  const currentForm = settingsToForm({ botNameAliases: ["clank", "conk"] });
  currentForm.botNameAliases = "clank, conk";

  // server returns different values (e.g. another admin added an alias)
  const preserved = settingsToFormPreserving({ botNameAliases: ["clank", "conk", "clanky"] }, currentForm);
  assert.equal(preserved.botNameAliases, "clank\nconk\nclanky");
});

test("settingsToFormPreserving preserves newline format when user prefers it", () => {
  const currentForm = settingsToForm({ botNameAliases: ["a", "b"] });
  // user keeps newlines
  currentForm.botNameAliases = "a\nb";

  const preserved = settingsToFormPreserving({ botNameAliases: ["a", "b"] }, currentForm);
  assert.equal(preserved.botNameAliases, "a\nb");
});
