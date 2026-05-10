import { test } from "bun:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { normalizeVoiceAdmissionModeForDashboard } from "../../../../src/settings/voiceDashboardMappings.ts";
import { VoiceModeSettingsSection } from "./VoiceModeSettingsSection.tsx";

function noop() {}

function buildProps(mode: unknown, formOverrides: Record<string, unknown> = {}) {
  return {
    id: "voice-mode",
    form: {
      voiceEnabled: true,
      voiceProvider: "openai",
      voiceReplyPath: "brain",
      voiceTtsMode: "realtime",
      voiceThinking: "disabled",
      voiceThinkingBudgetTokens: 1024,
      voiceOpenAiRealtimeTranscriptionMethod: "realtime_bridge",
      voiceOpenAiRealtimeUsePerUserAsrBridge: false,
      voiceCommandOnlyMode: false,
      voiceReplyDecisionRealtimeAdmissionMode: mode,
      voiceReplyDecisionMusicWakeLatchSeconds: 15,
      voiceReplyDecisionLlmProvider: "claude-oauth",
      voiceReplyDecisionLlmModel: "claude-sonnet-4-6",
      voiceInterruptLlmProvider: "claude-oauth",
      voiceInterruptLlmModel: "claude-haiku-4-5",
      voiceMusicBrainMode: "dedicated_model",
      voiceMusicBrainLlmProvider: "claude-oauth",
      voiceMusicBrainLlmModel: "claude-haiku-4-5",
      voiceAmbientReplyEagerness: 50,
      voiceDefaultInterruptionMode: "anyone",
      voiceGenerationLlmUseTextModel: false,
      voiceGenerationLlmProvider: "claude-oauth",
      voiceGenerationLlmModel: "claude-sonnet-4-6",
      reasoningEffort: "low",
      voiceStreamingEnabled: true,
      voiceStreamingMinSentencesPerChunk: 2,
      voiceStreamingEagerFirstChunkChars: 30,
      voiceStreamingMaxBufferChars: 300,
      voiceAsrEnabled: true,
      voiceAsrLanguageMode: "auto",
      voiceAsrLanguageHint: "en",
      voiceXaiModel: "grok-voice-think-fast-1.0",
      voiceXaiVoice: "eve",
      voiceXaiAudioFormat: "audio/pcm",
      voiceXaiSampleRateHz: 24000,
      voiceOpenAiRealtimeModel: "gpt-realtime",
      voiceOpenAiRealtimeVoice: "alloy",
      voiceMaxSessionMinutes: 30,
      voiceInactivityLeaveSeconds: 300,
      voiceMaxSessionsPerDay: 120,
      voiceOperationalMessages: "minimal",
      voiceAllowNsfwHumor: true,
      voiceThoughtEngineEnabled: false,
      voiceStreamWatchEnabled: false,
      voiceStreamWatchVisualizerMode: "cqt",
      voiceStreamWatchCommentaryIntervalSeconds: 15,
      voiceSoundboardEagerness: 40,
      voiceSoundboardEnabled: false,
      voiceSoundboardAllowExternalSounds: false,
      voiceSoundboardPreferredSoundIds: "",
      reactivity: 35,
      voiceStreamWatchNoteProvider: "",
      voiceStreamWatchNoteModel: "",
      voiceStreamWatchCommentaryProvider: "",
      voiceStreamWatchCommentaryModel: "",
      provider: "claude-oauth",
      model: "claude-opus-4-6",
      visionProvider: "openai",
      visionModel: "gpt-5-mini",
      ...formOverrides
    },
    set: () => noop,
    showVoiceSettings: true,
    isVoiceAgentMode: false,
    isOpenAiRealtimeMode: true,
    isGeminiRealtimeMode: false,
    isElevenLabsRealtimeMode: false,
    setVoiceGenerationProvider: noop,
    selectVoiceGenerationPresetModel: noop,
    voiceGenerationModelOptions: ["claude-sonnet-4-6"],
    selectedVoiceGenerationPresetModel: "claude-sonnet-4-6",
    setVoiceThoughtEngineProvider: noop,
    selectVoiceThoughtEnginePresetModel: noop,
    voiceThoughtEngineModelOptions: ["claude-sonnet-4-6"],
    selectedVoiceThoughtEnginePresetModel: "claude-sonnet-4-6",
    setVoiceReplyDecisionProvider: noop,
    selectVoiceReplyDecisionPresetModel: noop,
    voiceReplyDecisionModelOptions: ["claude-sonnet-4-6"],
    selectedVoiceReplyDecisionPresetModel: "claude-sonnet-4-6",
    setVoiceInterruptProvider: noop,
    selectVoiceInterruptPresetModel: noop,
    voiceInterruptModelOptions: ["claude-haiku-4-5"],
    selectedVoiceInterruptPresetModel: "claude-haiku-4-5",
    setVoiceMusicBrainProvider: noop,
    selectVoiceMusicBrainPresetModel: noop,
    voiceMusicBrainModelOptions: ["claude-haiku-4-5"],
    selectedVoiceMusicBrainPresetModel: "claude-haiku-4-5",
    xAiModelOptions: ["grok-voice-think-fast-1.0"],
    xAiVoiceOptions: ["eve"],
    xAiAudioFormatOptions: ["audio/pcm"],
    openAiRealtimeModelOptions: ["gpt-realtime"],
    openAiRealtimeVoiceOptions: ["alloy"],
    openAiTranscriptionModelOptions: ["gpt-4o-mini-transcribe"],
    geminiRealtimeModelOptions: ["gemini-2.5-flash"],
    setStreamWatchNoteProvider: noop,
    selectStreamWatchNotePresetModel: noop,
    streamWatchNoteModelOptions: ["gpt-5-mini"],
    selectedStreamWatchNotePresetModel: "gpt-5-mini",
    setStreamWatchCommentaryProvider: noop,
    selectStreamWatchCommentaryPresetModel: noop,
    streamWatchCommentaryModelOptions: ["claude-opus-4-6"],
    selectedStreamWatchCommentaryPresetModel: "claude-opus-4-6"
  };
}

function renderVoiceModeSection(mode: unknown, formOverrides: Record<string, unknown> = {}) {
  return renderToStaticMarkup(
    React.createElement(
      VoiceModeSettingsSection,
      buildProps(mode, formOverrides)
    )
  );
}

function hasText(markup: string, value: string) {
  // Strip HTML tags and collapse whitespace to approximate textContent
  const text = markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text.includes(value);
}

function hasControl(markup: string, id: string) {
  return markup.includes(`id="${id}"`);
}

test("normalizeVoiceAdmissionModeForDashboard preserves canonical values", () => {
  assert.equal(normalizeVoiceAdmissionModeForDashboard("generation_decides"), "generation_decides");
  assert.equal(normalizeVoiceAdmissionModeForDashboard("classifier_gate"), "classifier_gate");
  assert.equal(normalizeVoiceAdmissionModeForDashboard(""), "generation_decides");
});

test("voice admission select renders canonical classifier mode as selected", () => {
  const doc = renderVoiceModeSection("classifier_gate", {
    voiceReplyPath: "bridge"
  });

  assert.equal(hasText(doc, "Bridge mode requires a classifier"), true);
  assert.equal(hasControl(doc, "voice-reply-decision-provider"), true);
  assert.equal(hasControl(doc, "voice-reply-decision-model-preset"), true);
});

test("voice mode settings keep the admission stage and brain admission selector without classifier pickers in generation-owned mode", () => {
  const doc = renderVoiceModeSection("generation_decides", {
    voiceCommandOnlyMode: true
  });

  assert.equal(hasText(doc, "Reply Admission"), true);
  assert.equal(hasText(doc, "Full Brain is generation-owned here"), true);
  assert.equal(hasControl(doc, "voice-reply-decision-realtime-admission-mode"), true);
  assert.equal(hasControl(doc, "voice-reply-decision-provider"), false);
  assert.equal(hasControl(doc, "voice-reply-decision-model-preset"), false);
  assert.equal(hasText(doc, "Music Brain"), true);
  assert.equal(hasText(doc, "Music brain mode"), true);
  assert.equal(hasText(doc, "Music brain provider"), true);
  assert.equal(hasText(doc, "Music brain model ID"), true);
});

test("voice mode settings show brain classifier pickers when classifier-first admission is selected", () => {
  const doc = renderVoiceModeSection("classifier_gate", {
    voiceReplyPath: "brain"
  });

  assert.equal(hasText(doc, "Full Brain is running classifier-first admission here"), true);
  assert.equal(hasControl(doc, "voice-reply-decision-realtime-admission-mode"), true);
  assert.equal(hasControl(doc, "voice-reply-decision-provider"), true);
  assert.equal(hasControl(doc, "voice-reply-decision-model-preset"), true);
});

test("voice mode settings hide dedicated music-brain model pickers when main-brain handoff mode is selected", () => {
  const doc = renderVoiceModeSection("generation_decides", {
    voiceMusicBrainMode: "disabled"
  });

  assert.equal(hasText(doc, "Music brain mode"), true);
  assert.equal(hasText(doc, "Off (main brain handles music handoff)"), true);
  assert.equal(hasText(doc, "Music brain provider"), false);
  assert.equal(hasText(doc, "Music brain model ID"), false);
});

test("bridge path hides TTS mode controls and advertises provider-native tools", () => {
  const doc = renderVoiceModeSection("classifier_gate", {
    voiceReplyPath: "bridge",
    voiceTtsMode: "api"
  });

  assert.equal(hasText(doc, "TTS Mode"), false);
  assert.equal(hasText(doc, "provider-native tools where supported"), true);
});

test("full brain path keeps TTS mode controls visible", () => {
  const doc = renderVoiceModeSection("generation_decides", {
    voiceReplyPath: "brain",
    voiceTtsMode: "api"
  });

  assert.equal(hasText(doc, "TTS Mode"), true);
  assert.equal(hasText(doc, "TTS API"), true);
});

test("full brain path shows three thinking modes including silent enabled", () => {
  const doc = renderVoiceModeSection("generation_decides", {
    voiceReplyPath: "brain",
    voiceThinking: "enabled"
  });

  assert.equal(hasText(doc, "Off"), true);
  assert.equal(hasText(doc, "Enabled"), true);
  assert.equal(hasText(doc, "Think aloud"), true);
});

test("thinking budget control shows only when thinking is enabled", () => {
  const enabledDoc = renderVoiceModeSection("generation_decides", {
    voiceReplyPath: "brain",
    voiceThinking: "enabled",
    voiceThinkingBudgetTokens: 1400
  });
  assert.equal(hasControl(enabledDoc, "voice-thinking-budget-tokens"), true);
  assert.equal(hasText(enabledDoc, "Thinking budget tokens"), true);

  const disabledDoc = renderVoiceModeSection("generation_decides", {
    voiceReplyPath: "brain",
    voiceThinking: "disabled"
  });
  assert.equal(hasControl(disabledDoc, "voice-thinking-budget-tokens"), false);
});

test("brain stage hides Anthropic thinking controls for non-Anthropic providers", () => {
  const doc = renderVoiceModeSection("generation_decides", {
    voiceReplyPath: "brain",
    voiceGenerationLlmUseTextModel: false,
    voiceGenerationLlmProvider: "openai-oauth",
    voiceGenerationLlmModel: "gpt-5.4-mini"
  });

  assert.equal(hasText(doc, "Thinking mode"), false);
  assert.equal(hasControl(doc, "voice-thinking-budget-tokens"), false);
});

test("brain stage shows reasoning effort control for GPT-5 voice brain models", () => {
  const doc = renderVoiceModeSection("generation_decides", {
    voiceReplyPath: "brain",
    voiceGenerationLlmUseTextModel: false,
    voiceGenerationLlmProvider: "openai-oauth",
    voiceGenerationLlmModel: "gpt-5.4-mini"
  });

  assert.equal(hasControl(doc, "voice-brain-reasoning-effort"), true);
  assert.equal(hasText(doc, "Reasoning effort"), true);
});

test("brain stage hides reasoning effort control for non-GPT-5 voice brain models", () => {
  const doc = renderVoiceModeSection("generation_decides", {
    voiceReplyPath: "brain",
    voiceGenerationLlmUseTextModel: false,
    voiceGenerationLlmProvider: "claude-oauth",
    voiceGenerationLlmModel: "claude-sonnet-4-6"
  });

  assert.equal(hasControl(doc, "voice-brain-reasoning-effort"), false);
});

test("stream watch renders a compact mental model and hides advanced tuning behind disclosure copy", () => {
  const doc = renderVoiceModeSection("generation_decides", {
    voiceStreamWatchEnabled: true,
    voiceStreamWatchAutonomousCommentaryEnabled: true,
    voiceStreamWatchNoteProvider: "claude-oauth",
    voiceStreamWatchNoteModel: "claude-opus-4-6"
  });

  assert.equal(hasText(doc, "How screen watch works"), true);
  assert.equal(hasText(doc, "Advanced screen watch settings"), true);
  assert.equal(hasText(doc, "Music Go Live visualizer"), true);
  assert.equal(hasControl(doc, "voice-stream-watch-visualizer-mode"), true);
  assert.equal(hasText(doc, "Screen share pipeline"), false);
});

test("soundboard settings expose a dedicated eagerness control when enabled", () => {
  const doc = renderVoiceModeSection("generation_decides", {
    voiceSoundboardEnabled: true,
    voiceSoundboardEagerness: 82
  });

  assert.equal(hasText(doc, "Enable Discord soundboard reactions"), true);
  assert.equal(hasText(doc, "Soundboard eagerness"), true);
  assert.equal(hasText(doc, "82%"), true);
  assert.equal(hasText(doc, "separate from Core Behavior reactivity"), true);
  assert.equal(hasText(doc, "Lets the bot lean into playful soundboard bits"), true);
});
