import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { createTestSettings } from "../testSettings.ts";
import {
  isAsrActive,
  resolveRealtimeReplyStrategy,
  shouldUsePerUserTranscription,
  shouldUseRealtimeTranscriptBridge,
  shouldUseSharedTranscription
} from "./voiceConfigResolver.ts";

type VoiceSettingsOverrides = {
  mode?: string;
  asrEnabled?: boolean;
  textOnlyMode?: boolean;
  replyPath?: string;
  ttsMode?: string;
  openaiRealtime?: {
    transcriptionMethod?: string;
    usePerUserAsrBridge?: boolean;
  };
};

function createVoiceSettings(overrides: VoiceSettingsOverrides = {}) {
  const { openaiRealtime = {}, ...voiceOverrides } = overrides;
  return createTestSettings({
    voice: {
      mode: "openai_realtime",
      asrEnabled: true,
      textOnlyMode: false,
      replyPath: "brain",
      ttsMode: "realtime",
      openaiRealtime: {
        transcriptionMethod: "realtime_bridge",
        usePerUserAsrBridge: true,
        ...openaiRealtime
      },
      ...voiceOverrides
    }
  });
}

function createSession(mode: string, settingsSnapshot: ReturnType<typeof createVoiceSettings> | null = null) {
  return {
    mode,
    settingsSnapshot
  };
}

describe("resolveRealtimeReplyStrategy", () => {
  test("returns native only for realtime sessions configured for native replies", () => {
    const settings = createVoiceSettings({
      replyPath: "native"
    });

    const strategy = resolveRealtimeReplyStrategy({
      session: createSession("openai_realtime", settings)
    });

    assert.equal(strategy, "native");
  });

  test("prefers explicit settings over the session snapshot", () => {
    const snapshotSettings = createVoiceSettings({
      replyPath: "native"
    });
    const explicitSettings = createVoiceSettings({
      replyPath: "brain"
    });

    const strategy = resolveRealtimeReplyStrategy({
      session: createSession("openai_realtime", snapshotSettings),
      settings: explicitSettings
    });

    assert.equal(strategy, "brain");
  });

  test("falls back to brain outside realtime modes", () => {
    const settings = createVoiceSettings({
      mode: "stt_pipeline",
      replyPath: "native"
    });

    const strategy = resolveRealtimeReplyStrategy({
      session: createSession("stt_pipeline", settings)
    });

    assert.equal(strategy, "brain");
  });
});

describe("shouldUsePerUserTranscription", () => {
  test("enables per-user transcription when realtime bridge ASR is configured", () => {
    const settings = createVoiceSettings();

    const result = shouldUsePerUserTranscription({
      session: createSession("openai_realtime", settings),
      settings,
      hasOpenAiApiKey: true
    });

    assert.equal(result, true);
  });

  test("disables per-user transcription when replies are native", () => {
    const settings = createVoiceSettings({
      replyPath: "native"
    });

    const result = shouldUsePerUserTranscription({
      session: createSession("openai_realtime", settings),
      settings,
      hasOpenAiApiKey: true
    });

    assert.equal(result, false);
  });

  test("disables per-user transcription when the runtime lacks that capability", () => {
    const settings = createVoiceSettings({
      mode: "voice_agent"
    });

    const result = shouldUsePerUserTranscription({
      session: createSession("voice_agent", settings),
      settings,
      hasOpenAiApiKey: true
    });

    assert.equal(result, false);
  });
});

describe("shouldUseSharedTranscription", () => {
  test("enables shared transcription for supported runtimes when per-user ASR is off", () => {
    const settings = createVoiceSettings({
      mode: "voice_agent",
      openaiRealtime: {
        usePerUserAsrBridge: false
      }
    });

    const result = shouldUseSharedTranscription({
      session: createSession("voice_agent", settings),
      settings,
      hasOpenAiApiKey: true
    });

    assert.equal(result, true);
  });

  test("disables shared transcription when per-user ASR is enabled", () => {
    const settings = createVoiceSettings();

    const result = shouldUseSharedTranscription({
      session: createSession("openai_realtime", settings),
      settings,
      hasOpenAiApiKey: true
    });

    assert.equal(result, false);
  });

  test("disables shared transcription in text-only mode", () => {
    const settings = createVoiceSettings({
      mode: "voice_agent",
      textOnlyMode: true,
      openaiRealtime: {
        usePerUserAsrBridge: false
      }
    });

    const result = shouldUseSharedTranscription({
      session: createSession("voice_agent", settings),
      settings,
      hasOpenAiApiKey: true
    });

    assert.equal(result, false);
  });
});

describe("shouldUseRealtimeTranscriptBridge", () => {
  test("enables the transcript bridge for realtime bridge replies with realtime TTS", () => {
    const settings = createVoiceSettings({
      replyPath: "bridge",
      ttsMode: "realtime"
    });

    const result = shouldUseRealtimeTranscriptBridge({
      session: createSession("openai_realtime", settings),
      settings
    });

    assert.equal(result, true);
  });

  test("disables the transcript bridge when bridge replies use API TTS", () => {
    const settings = createVoiceSettings({
      replyPath: "bridge",
      ttsMode: "api"
    });

    const result = shouldUseRealtimeTranscriptBridge({
      session: createSession("openai_realtime", settings),
      settings
    });

    assert.equal(result, false);
  });

  test("disables the transcript bridge outside realtime modes", () => {
    const settings = createVoiceSettings({
      mode: "stt_pipeline",
      replyPath: "bridge"
    });

    const result = shouldUseRealtimeTranscriptBridge({
      session: createSession("stt_pipeline", settings),
      settings
    });

    assert.equal(result, false);
  });
});

describe("isAsrActive", () => {
  test("returns true when transcription is enabled and voice mode is not text-only", () => {
    const settings = createVoiceSettings();

    const result = isAsrActive({
      session: createSession("openai_realtime", settings),
      settings
    });

    assert.equal(result, true);
  });

  test("returns false when transcription is disabled", () => {
    const settings = createVoiceSettings({
      asrEnabled: false
    });

    const result = isAsrActive({
      session: createSession("openai_realtime", settings),
      settings
    });

    assert.equal(result, false);
  });

  test("returns false when text-only mode is enabled", () => {
    const settings = createVoiceSettings({
      textOnlyMode: true
    });

    const result = isAsrActive({
      session: createSession("openai_realtime", settings),
      settings
    });

    assert.equal(result, false);
  });
});
