import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { createTestSettings } from "../testSettings.ts";
import {
  isAsrActive,
  resolveRealtimeToolOwnership,
  shouldHandleRealtimeFunctionCalls,
  shouldRegisterRealtimeTools,
  shouldUseTextMediatedRealtimeReply,
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

describe("shouldUseTextMediatedRealtimeReply", () => {
  test("returns false for realtime sessions configured for native replies", () => {
    const settings = createVoiceSettings({
      replyPath: "native"
    });

    const result = shouldUseTextMediatedRealtimeReply({
      session: createSession("openai_realtime", settings)
    });

    assert.equal(result, false);
  });

  test("prefers explicit settings over the session snapshot", () => {
    const snapshotSettings = createVoiceSettings({
      replyPath: "native"
    });
    const explicitSettings = createVoiceSettings({
      replyPath: "brain"
    });

    const result = shouldUseTextMediatedRealtimeReply({
      session: createSession("openai_realtime", snapshotSettings),
      settings: explicitSettings
    });

    assert.equal(result, true);
  });

  test("returns false outside realtime modes", () => {
    const settings = createVoiceSettings({
      mode: "offline",
      replyPath: "native"
    });

    const result = shouldUseTextMediatedRealtimeReply({
      session: createSession("offline", settings)
    });

    assert.equal(result, false);
  });
});

describe("resolveRealtimeToolOwnership", () => {
  test("returns transport_only for brain reply path", () => {
    const settings = createVoiceSettings({
      replyPath: "brain"
    });

    const ownership = resolveRealtimeToolOwnership({
      session: createSession("openai_realtime", settings)
    });

    assert.equal(ownership, "transport_only");
  });

  test("returns provider_native for bridge reply path", () => {
    const settings = createVoiceSettings({
      replyPath: "bridge"
    });

    const ownership = resolveRealtimeToolOwnership({
      session: createSession("openai_realtime", settings)
    });

    assert.equal(ownership, "provider_native");
  });

  test("returns provider_native for native reply path", () => {
    const settings = createVoiceSettings({
      replyPath: "native"
    });

    const ownership = resolveRealtimeToolOwnership({
      session: createSession("openai_realtime", settings)
    });

    assert.equal(ownership, "provider_native");
  });

  test("uses the latched session ownership over current settings", () => {
    const ownership = resolveRealtimeToolOwnership({
      session: {
        mode: "openai_realtime",
        realtimeToolOwnership: "transport_only",
        settingsSnapshot: createVoiceSettings({
          replyPath: "native"
        })
      },
      settings: createVoiceSettings({
        replyPath: "native"
      })
    });

    assert.equal(ownership, "transport_only");
  });
});

describe("realtime tool gating", () => {
  test("does not register realtime tools for brain sessions", () => {
    const settings = createVoiceSettings({
      replyPath: "brain"
    });

    assert.equal(
      shouldRegisterRealtimeTools({
        session: createSession("openai_realtime", settings),
        settings
      }),
      false
    );
  });

  test("registers realtime tools for bridge sessions on supported providers", () => {
    const settings = createVoiceSettings({
      replyPath: "bridge"
    });

    assert.equal(
      shouldRegisterRealtimeTools({
        session: createSession("openai_realtime", settings),
        settings
      }),
      true
    );
  });

  test("registers realtime tools for native sessions on supported providers", () => {
    const settings = createVoiceSettings({
      replyPath: "native"
    });

    assert.equal(
      shouldRegisterRealtimeTools({
        session: createSession("openai_realtime", settings),
        settings
      }),
      true
    );
  });

  test("handles provider function calls for provider-owned realtime sessions", () => {
    const brainSettings = createVoiceSettings({
      replyPath: "brain"
    });
    const bridgeSettings = createVoiceSettings({
      replyPath: "bridge"
    });
    const nativeSettings = createVoiceSettings({
      replyPath: "native"
    });

    assert.equal(
      shouldHandleRealtimeFunctionCalls({
        session: createSession("openai_realtime", brainSettings),
        settings: brainSettings
      }),
      false
    );
    assert.equal(
      shouldHandleRealtimeFunctionCalls({
        session: createSession("openai_realtime", bridgeSettings),
        settings: bridgeSettings
      }),
      true
    );
    assert.equal(
      shouldHandleRealtimeFunctionCalls({
        session: createSession("openai_realtime", nativeSettings),
        settings: nativeSettings
      }),
      true
    );
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

  test("enables per-user transcription for xAI bridge sessions when OpenAI ASR is configured", () => {
    const settings = createVoiceSettings({
      mode: "voice_agent"
    });

    const result = shouldUsePerUserTranscription({
      session: createSession("voice_agent", settings),
      settings,
      hasOpenAiApiKey: true
    });

    assert.equal(result, true);
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
  test("enables the transcript bridge for realtime bridge replies", () => {
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

  test("keeps the transcript bridge enabled even if legacy bridge settings request API TTS", () => {
    const settings = createVoiceSettings({
      replyPath: "bridge",
      ttsMode: "api"
    });

    const result = shouldUseRealtimeTranscriptBridge({
      session: createSession("openai_realtime", settings),
      settings
    });

    assert.equal(result, true);
  });

  test("disables the transcript bridge outside realtime modes", () => {
    const settings = createVoiceSettings({
      mode: "offline",
      replyPath: "bridge"
    });

    const result = shouldUseRealtimeTranscriptBridge({
      session: createSession("offline", settings),
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
