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
      voiceStreamingEnabled: true,
      voiceStreamingMinSentencesPerChunk: 2,
      voiceStreamingEagerFirstChunkChars: 30,
      voiceStreamingMaxBufferChars: 300,
      voiceAsrEnabled: true,
      voiceAsrLanguageMode: "auto",
      voiceAsrLanguageHint: "en",
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
      voiceSoundboardEagerness: 40,
      voiceSoundboardEnabled: false,
      voiceSoundboardAllowExternalSounds: false,
      voiceSoundboardPreferredSoundIds: "",
      reactivity: 35,
      voiceStreamWatchBrainContextProvider: "",
      voiceStreamWatchBrainContextModel: "",
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
    xAiVoiceOptions: ["Ara"],
    openAiRealtimeModelOptions: ["gpt-realtime"],
    openAiRealtimeVoiceOptions: ["alloy"],
    openAiTranscriptionModelOptions: ["gpt-4o-mini-transcribe"],
    geminiRealtimeModelOptions: ["gemini-2.5-flash"],
    setStreamWatchVisionProvider: noop,
    selectStreamWatchVisionPresetModel: noop,
    streamWatchVisionModelOptions: ["gpt-5-mini"],
    selectedStreamWatchVisionPresetModel: "gpt-5-mini"
  };
}

test("normalizeVoiceAdmissionModeForDashboard preserves canonical values", () => {
  assert.equal(normalizeVoiceAdmissionModeForDashboard("generation_decides"), "generation_decides");
  assert.equal(normalizeVoiceAdmissionModeForDashboard("classifier_gate"), "classifier_gate");
  assert.equal(normalizeVoiceAdmissionModeForDashboard(""), "generation_decides");
});

test("voice admission select renders canonical classifier mode as selected", () => {
  const markup = renderToStaticMarkup(
    React.createElement(
      VoiceModeSettingsSection,
      buildProps("classifier_gate", {
        voiceReplyPath: "bridge"
      })
    )
  );

  assert.equal(markup.includes("Bridge mode requires a classifier"), true);
  assert.equal(markup.includes("voice-reply-decision-provider"), true);
  assert.equal(markup.includes("voice-reply-decision-model-preset"), true);
});

test("voice mode settings keep the admission stage and brain admission selector without classifier pickers in generation-owned mode", () => {
  const markup = renderToStaticMarkup(
    React.createElement(
      VoiceModeSettingsSection,
      buildProps("generation_decides", {
        voiceCommandOnlyMode: true
      })
    )
  );

  assert.equal(markup.includes("Reply Admission"), true);
  assert.equal(markup.includes("Full Brain is generation-owned here"), true);
  assert.equal(markup.includes("voice-reply-decision-realtime-admission-mode"), true);
  assert.equal(markup.includes("voice-reply-decision-provider"), false);
  assert.equal(markup.includes("voice-reply-decision-model-preset"), false);
  assert.equal(markup.includes("Music Brain"), true);
  assert.equal(markup.includes("Music brain mode"), true);
  assert.equal(markup.includes("Music brain provider"), true);
  assert.equal(markup.includes("Music brain model ID"), true);
});

test("voice mode settings show brain classifier pickers when classifier-first admission is selected", () => {
  const markup = renderToStaticMarkup(
    React.createElement(
      VoiceModeSettingsSection,
      buildProps("classifier_gate", {
        voiceReplyPath: "brain"
      })
    )
  );

  assert.equal(markup.includes("Full Brain is running classifier-first admission here"), true);
  assert.equal(markup.includes("voice-reply-decision-realtime-admission-mode"), true);
  assert.equal(markup.includes("voice-reply-decision-provider"), true);
  assert.equal(markup.includes("voice-reply-decision-model-preset"), true);
});

test("voice mode settings hide dedicated music-brain model pickers when main-brain handoff mode is selected", () => {
  const markup = renderToStaticMarkup(
    React.createElement(
      VoiceModeSettingsSection,
      buildProps("generation_decides", {
        voiceMusicBrainMode: "disabled"
      })
    )
  );

  assert.equal(markup.includes("Music brain mode"), true);
  assert.equal(markup.includes("Off (main brain handles music handoff)"), true);
  assert.equal(markup.includes("Music brain provider"), false);
  assert.equal(markup.includes("Music brain model ID"), false);
});

test("bridge path hides TTS mode controls and advertises provider-native tools", () => {
  const markup = renderToStaticMarkup(
    React.createElement(
      VoiceModeSettingsSection,
      buildProps("classifier_gate", {
        voiceReplyPath: "bridge",
        voiceTtsMode: "api"
      })
    )
  );

  assert.equal(markup.includes("TTS Mode"), false);
  assert.equal(markup.includes("provider-native tools where supported"), true);
});

test("full brain path keeps TTS mode controls visible", () => {
  const markup = renderToStaticMarkup(
    React.createElement(
      VoiceModeSettingsSection,
      buildProps("generation_decides", {
        voiceReplyPath: "brain",
        voiceTtsMode: "api"
      })
    )
  );

  assert.equal(markup.includes("TTS Mode"), true);
  assert.equal(markup.includes("TTS API"), true);
});

test("stream watch renders a compact mental model and hides advanced tuning behind disclosure copy", () => {
  const markup = renderToStaticMarkup(
    React.createElement(
      VoiceModeSettingsSection,
      buildProps("generation_decides", {
        voiceStreamWatchEnabled: true,
        voiceStreamWatchAutonomousCommentaryEnabled: true,
        voiceStreamWatchBrainContextEnabled: true,
        voiceStreamWatchBrainContextProvider: "claude-oauth",
        voiceStreamWatchBrainContextModel: "claude-opus-4-6"
      })
    )
  );

  assert.equal(markup.includes("How screen watch works"), true);
  assert.equal(markup.includes("Advanced screen watch settings"), true);
  assert.equal(markup.includes("Music Go Live visualizer"), true);
  assert.equal(markup.includes("voice-stream-watch-visualizer-mode"), true);
  assert.equal(markup.includes("Screen share pipeline"), false);
});

test("soundboard settings expose a dedicated eagerness control when enabled", () => {
  const markup = renderToStaticMarkup(
    React.createElement(
      VoiceModeSettingsSection,
      buildProps("generation_decides", {
        voiceSoundboardEnabled: true,
        voiceSoundboardEagerness: 82
      })
    )
  );

  assert.equal(markup.includes("Enable Discord soundboard reactions"), true);
  assert.equal(markup.includes("Soundboard eagerness"), true);
  assert.equal(markup.includes("82%"), true);
  assert.equal(markup.includes("separate from Core Behavior reactivity"), true);
  assert.equal(markup.includes("Lets the bot lean into playful soundboard bits"), true);
});
