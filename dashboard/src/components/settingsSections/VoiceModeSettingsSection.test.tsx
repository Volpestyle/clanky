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
      voiceReplyEagerness: 50,
      voiceDefaultInterruptionMode: "anyone",
      voiceGenerationLlmUseTextModel: false,
      voiceGenerationLlmProvider: "claude-oauth",
      voiceGenerationLlmModel: "claude-sonnet-4-6",
      voiceStreamingEnabled: true,
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
      voiceSoundboardEnabled: false,
      voiceSoundboardEagerness: 35,
      voiceSoundboardAllowExternalSounds: false,
      voiceSoundboardPreferredSoundIds: "",
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

test("normalizeVoiceAdmissionModeForDashboard maps legacy aliases to canonical values", () => {
  assert.equal(normalizeVoiceAdmissionModeForDashboard("generation_only"), "generation_decides");
  assert.equal(normalizeVoiceAdmissionModeForDashboard("generation_decides"), "generation_decides");
  assert.equal(normalizeVoiceAdmissionModeForDashboard("adaptive"), "adaptive");
  assert.equal(normalizeVoiceAdmissionModeForDashboard("hard_classifier"), "classifier_gate");
  assert.equal(normalizeVoiceAdmissionModeForDashboard("classifier_gate"), "classifier_gate");
});

test("voice admission select renders canonical classifier mode as selected", () => {
  const markup = renderToStaticMarkup(
    React.createElement(VoiceModeSettingsSection, buildProps("classifier_gate"))
  );

  assert.match(markup, /<option value="generation_decides">Off \(generation decides\)<\/option>/);
  assert.match(markup, /<option value="classifier_gate" selected="">On \(classifier gate\)<\/option>/);
});

test("voice admission select renders legacy generation_only as the off option", () => {
  const markup = renderToStaticMarkup(
    React.createElement(VoiceModeSettingsSection, buildProps("generation_only"))
  );

  assert.match(markup, /<option value="generation_decides" selected="">Off \(generation decides\)<\/option>/);
  assert.match(markup, /<option value="classifier_gate">On \(classifier gate\)<\/option>/);
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

  assert.equal(markup.includes("How screen share works"), true);
  assert.equal(markup.includes("Advanced stream watch settings"), true);
  assert.equal(markup.includes("Screen share pipeline"), false);
});

test("soundboard settings render a Discord soundboard tendency slider when enabled", () => {
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
  assert.equal(markup.includes("Discord soundboard tendency"), true);
  assert.equal(markup.includes("82%"), true);
  assert.equal(markup.includes("Lets the bot lean into playful soundboard bits"), true);
});
