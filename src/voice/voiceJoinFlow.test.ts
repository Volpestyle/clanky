import { test } from "bun:test";
import assert from "node:assert/strict";
import { requestJoin } from "./voiceJoinFlow.ts";
import { createTestSettings as createCanonicalTestSettings, normalizeLegacyTestSettingsInput } from "../testSettings.ts";
import { deepMerge } from "../utils.ts";
import { OpenAiRealtimeClient } from "./openaiRealtimeClient.ts";
import { XaiRealtimeClient } from "./xaiRealtimeClient.ts";
import { ClankvoxClient } from "./clankvoxClient.ts";

const LEGACY_VOICE_KEYS = [
  "mode",
  "voiceProvider",
  "brainProvider",
  "generationLlm",
  "replyDecisionLlm",
  "asrEnabled",
  "asrLanguageMode",
  "asrLanguageHint",
  "allowedVoiceChannelIds",
  "blockedVoiceChannelIds",
  "blockedVoiceUserIds",
  "maxSessionMinutes",
  "inactivityLeaveSeconds",
  "maxSessionsPerDay",
  "maxConcurrentSessions",
  "ambientReplyEagerness",
  "commandOnlyMode",
  "allowNsfwHumor",
  "textOnlyMode",
  "defaultInterruptionMode",
  "replyPath",
  "ttsMode",
  "operationalMessages",
  "streamingEnabled",
  "streamingEagerFirstChunkChars",
  "streamingMaxBufferChars",
  "thoughtEngine",
  "musicDucking",
  "intentConfidenceThreshold",
  "openaiRealtime",
  "xai",
  "elevenLabsRealtime",
  "geminiRealtime",
  "openaiAudioApi"
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function createTestSettings(overrides: Record<string, unknown> = {}) {
  const canonicalOverrides: Record<string, unknown> = { ...overrides };
  const legacyOverrides: Record<string, unknown> = {};

  for (const key of ["botName", "botNameAliases"] as const) {
    if (key in canonicalOverrides) {
      legacyOverrides[key] = canonicalOverrides[key];
      delete canonicalOverrides[key];
    }
  }

  if (isRecord(canonicalOverrides.voice)) {
    const canonicalVoice = { ...canonicalOverrides.voice };
    const legacyVoice: Record<string, unknown> = {};
    for (const key of LEGACY_VOICE_KEYS) {
      if (key in canonicalVoice) {
        legacyVoice[key] = canonicalVoice[key];
        delete canonicalVoice[key];
      }
    }

    if (Object.keys(legacyVoice).length > 0) {
      legacyOverrides.voice = legacyVoice;
    }
    if (Object.keys(canonicalVoice).length > 0) {
      canonicalOverrides.voice = canonicalVoice;
    } else {
      delete canonicalOverrides.voice;
    }
  }

  const normalizedLegacy =
    Object.keys(legacyOverrides).length > 0 ? normalizeLegacyTestSettingsInput(legacyOverrides) : {};
  return createCanonicalTestSettings(deepMerge(normalizedLegacy, canonicalOverrides));
}

function baseSettings(overrides = {}) {
  const base = {
    voice: {
      enabled: true,
      mode: "voice_agent",
      blockedVoiceUserIds: [],
      blockedVoiceChannelIds: [],
      allowedVoiceChannelIds: [],
      maxSessionsPerDay: 0,
      maxConcurrentSessions: 2,
      maxSessionMinutes: 20,
      inactivityLeaveSeconds: 90
    }
  };

  return createTestSettings({
    ...base,
    ...overrides,
    voice: {
      ...base.voice,
      ...(overrides.voice || {})
    }
  });
}

function createMessage({ userId = "user-1", voiceChannelId = "voice-1", ...overrides } = {}) {
  return {
    guild: {
      id: "guild-1",
      members: {
        me: { id: "bot-1" }
      },
      voiceAdapterCreator: {}
    },
    member: {
      voice: {
        channel: voiceChannelId
          ? {
              id: voiceChannelId
            }
          : null
      }
    },
    channel: {
      id: "text-1",
      async send() {
        return true;
      }
    },
    channelId: "text-1",
    author: userId
      ? {
          id: userId,
          username: "alice"
        }
      : {
          username: "alice"
        },
    id: "msg-1",
    ...overrides
  };
}

function createManager(overrides = {}) {
  const operationalMessages = [];

  const defaultStore = {
    countActionsSince() {
      return 0;
    },
    logAction() {}
  };

  const defaultLlm = {
    isAsrReady() {
      return true;
    },
    isSpeechSynthesisReady() {
      return true;
    }
  };

  const manager = {
    sessions: new Map(),
    pendingSessionGuildIds: new Set(),
    client: {
      user: {
        id: "bot-1"
      }
    },
    appConfig: {},
    llm: defaultLlm,
    store: defaultStore,
    generateVoiceTurn: async () => ({ text: "ok" }),
    async withJoinLock(_guildId, fn) {
      return await fn();
    },
    async composeOperationalMessage(payload) {
      operationalMessages.push(payload);
      return "ok";
    },
    primeSessionFactProfiles() {},
    recordVoiceMembershipEvent() {},
    async fireVoiceRuntimeEvent() {},
    touchActivityCalls: 0,
    touchActivity() {
      this.touchActivityCalls += 1;
    },
    endSessionCalls: 0,
    async endSession() {
      this.endSessionCalls += 1;
    },
    sessionLifecycle: {
      async attachSessionRuntime() {}
    },
    getMissingJoinPermissionInfo() {
      return null;
    }
  };

  return {
    manager: {
      ...manager,
      ...overrides,
      store: {
        ...defaultStore,
        ...(overrides.store || {})
      },
      llm: {
        ...defaultLlm,
        ...(overrides.llm || {})
      },
      appConfig: {
        ...(overrides.appConfig || {})
      }
    },
    operationalMessages
  };
}

test("requestJoin returns false when message context is incomplete", async () => {
  const { manager } = createManager();
  const result = await requestJoin(manager, {
    message: null,
    settings: baseSettings()
  });
  assert.equal(result, false);
});

test("requestJoin blocks when voice mode is disabled", async () => {
  const { manager, operationalMessages } = createManager();
  const result = await requestJoin(manager, {
    message: createMessage(),
    settings: baseSettings({
      voice: {
        enabled: false
      }
    })
  });

  assert.equal(result, true);
  assert.equal(operationalMessages.at(-1)?.reason, "voice_disabled");
});

test("requestJoin blocks requester when user is in blocked voice list", async () => {
  const { manager, operationalMessages } = createManager();
  const result = await requestJoin(manager, {
    message: createMessage({
      userId: "blocked-user"
    }),
    settings: baseSettings({
      voice: {
        blockedVoiceUserIds: ["blocked-user"]
      }
    })
  });

  assert.equal(result, true);
  assert.equal(operationalMessages.at(-1)?.reason, "requester_blocked");
});

test("requestJoin requires requester to be in a voice channel", async () => {
  const { manager, operationalMessages } = createManager();
  const result = await requestJoin(manager, {
    message: createMessage({
      voiceChannelId: null
    }),
    settings: baseSettings()
  });

  assert.equal(result, true);
  assert.equal(operationalMessages.at(-1)?.reason, "requester_not_in_voice");
});

test("requestJoin enforces blocked and allowlisted voice channel settings", async () => {
  const blockedManager = createManager();
  const blockedResult = await requestJoin(blockedManager.manager, {
    message: createMessage({
      voiceChannelId: "voice-blocked"
    }),
    settings: baseSettings({
      voice: {
        blockedVoiceChannelIds: ["voice-blocked"]
      }
    })
  });
  assert.equal(blockedResult, true);
  assert.equal(blockedManager.operationalMessages.at(-1)?.reason, "channel_blocked");

  const allowlistManager = createManager();
  const allowlistResult = await requestJoin(allowlistManager.manager, {
    message: createMessage({
      voiceChannelId: "voice-other"
    }),
    settings: baseSettings({
      voice: {
        allowedVoiceChannelIds: ["voice-allowed"]
      }
    })
  });
  assert.equal(allowlistResult, true);
  assert.equal(allowlistManager.operationalMessages.at(-1)?.reason, "channel_not_allowlisted");
});

test("requestJoin enforces per-day voice session cap", async () => {
  const { manager, operationalMessages } = createManager({
    store: {
      countActionsSince() {
        return 4;
      }
    }
  });
  const result = await requestJoin(manager, {
    message: createMessage(),
    settings: baseSettings({
      voice: {
        maxSessionsPerDay: 4
      }
    })
  });

  assert.equal(result, true);
  assert.equal(operationalMessages.at(-1)?.reason, "max_sessions_per_day_reached");
});

test("requestJoin reports already_in_channel for existing same-channel session", async () => {
  const { manager, operationalMessages } = createManager();
  manager.sessions.set("guild-1", {
    voiceChannelId: "voice-1"
  });

  const result = await requestJoin(manager, {
    message: createMessage({
      voiceChannelId: "voice-1"
    }),
    settings: baseSettings()
  });

  assert.equal(result, true);
  assert.equal(manager.touchActivityCalls, 1);
  assert.equal(operationalMessages.at(-1)?.reason, "already_in_channel");
  assert.equal(operationalMessages.at(-1)?.allowSkip, true);
});

test("requestJoin requires API keys for realtime runtime modes", async () => {
  const xai = createManager();
  const xaiResult = await requestJoin(xai.manager, {
    message: createMessage(),
    settings: baseSettings({
      voice: {
        mode: "voice_agent"
      }
    })
  });
  assert.equal(xaiResult, true);
  assert.equal(xai.operationalMessages.at(-1)?.reason, "xai_api_key_missing");

  const openai = createManager();
  const openAiResult = await requestJoin(openai.manager, {
    message: createMessage(),
    settings: baseSettings({
      voice: {
        mode: "openai_realtime"
      }
    })
  });
  assert.equal(openAiResult, true);
  assert.equal(openai.operationalMessages.at(-1)?.reason, "openai_api_key_missing");

  const gemini = createManager();
  const geminiResult = await requestJoin(gemini.manager, {
    message: createMessage(),
    settings: baseSettings({
      voice: {
        mode: "gemini_realtime"
      }
    })
  });
  assert.equal(geminiResult, true);
  assert.equal(gemini.operationalMessages.at(-1)?.reason, "gemini_api_key_missing");

  const elevenLabs = createManager();
  const elevenLabsResult = await requestJoin(elevenLabs.manager, {
    message: createMessage(),
    settings: baseSettings({
      voice: {
        mode: "elevenlabs_realtime",
        elevenLabsRealtime: {
          agentId: "agent_123"
        }
      }
    })
  });
  assert.equal(elevenLabsResult, true);
  assert.equal(elevenLabs.operationalMessages.at(-1)?.reason, "elevenlabs_api_key_missing");
});

test("requestJoin requires ElevenLabs agent id when mode is elevenlabs_realtime", async () => {
  const { manager, operationalMessages } = createManager({
    appConfig: {
      elevenLabsApiKey: "el-key"
    }
  });
  const result = await requestJoin(manager, {
    message: createMessage(),
    settings: baseSettings({
      voice: {
        mode: "elevenlabs_realtime",
        elevenLabsRealtime: {
          agentId: ""
        }
      }
    })
  });

  assert.equal(result, true);
  assert.equal(operationalMessages.at(-1)?.reason, "elevenlabs_agent_id_missing");
});

test("requestJoin validates file-WAV ASR, API TTS, and brain dependencies", async () => {
  const noAsr = createManager({
    appConfig: {
      openaiApiKey: "openai-key"
    },
    llm: {
      isAsrReady() {
        return false;
      }
    }
  });
  const noAsrResult = await requestJoin(noAsr.manager, {
    message: createMessage(),
    settings: baseSettings({
      voice: {
        mode: "openai_realtime",
        openaiRealtime: {
          transcriptionMethod: "file_wav"
        }
      }
    })
  });
  assert.equal(noAsrResult, true);
  assert.equal(noAsr.operationalMessages.at(-1)?.reason, "voice_file_asr_unavailable");

  const noTts = createManager({
    appConfig: {
      openaiApiKey: "openai-key"
    },
    llm: {
      isAsrReady() {
        return true;
      },
      isSpeechSynthesisReady() {
        return false;
      }
    }
  });
  const noTtsResult = await requestJoin(noTts.manager, {
    message: createMessage(),
    settings: baseSettings({
      voice: {
        mode: "openai_realtime",
        replyPath: "brain",
        ttsMode: "api"
      }
    })
  });
  assert.equal(noTtsResult, true);
  assert.equal(noTts.operationalMessages.at(-1)?.reason, "voice_api_tts_unavailable");

  const noBrain = createManager({
    appConfig: {
      openaiApiKey: "openai-key"
    },
    generateVoiceTurn: null
  });
  const noBrainResult = await requestJoin(noBrain.manager, {
    message: createMessage(),
    settings: baseSettings({
      voice: {
        mode: "openai_realtime",
        replyPath: "brain"
      }
    })
  });
  assert.equal(noBrainResult, true);
  assert.equal(noBrain.operationalMessages.at(-1)?.reason, "voice_brain_unavailable");
});

test("requestJoin reports missing permission info from manager checks", async () => {
  const { manager, operationalMessages } = createManager({
    appConfig: {
      xaiApiKey: "xai-key",
      openaiApiKey: "openai-key"
    },
    getMissingJoinPermissionInfo() {
      return {
        reason: "missing_voice_permissions",
        missingPermissions: ["CONNECT"]
      };
    }
  });

  const result = await requestJoin(manager, {
    message: createMessage(),
    settings: baseSettings()
  });

  assert.equal(result, true);
  assert.equal(operationalMessages.at(-1)?.reason, "missing_voice_permissions");
  assert.deepEqual(operationalMessages.at(-1)?.details?.missingPermissions, ["CONNECT"]);
});

test("requestJoin enforces max concurrent sessions before connecting", async () => {
  const { manager, operationalMessages } = createManager({
    appConfig: {
      xaiApiKey: "xai-key",
      openaiApiKey: "openai-key"
    }
  });
  manager.sessions.set("other-guild", {
    id: "session-1"
  });

  const result = await requestJoin(manager, {
    message: createMessage(),
    settings: baseSettings({
      voice: {
        maxConcurrentSessions: 1
      }
    })
  });

  assert.equal(result, true);
  assert.equal(operationalMessages.at(-1)?.reason, "max_concurrent_sessions_reached");
});

test("requestJoin omits provider-native realtime tools at connect for brain transport-only sessions", async () => {
  const originalSpawn = ClankvoxClient.spawn;
  const originalConnect = OpenAiRealtimeClient.prototype.connect;
  const connectCalls = [];

  ClankvoxClient.spawn = async () => ({
    destroy() {},
    on() {},
    off() {}
  }) as ClankvoxClient;
  OpenAiRealtimeClient.prototype.connect = async function connectStub(payload = {}) {
    connectCalls.push(payload);
    return {};
  };

  try {
    const { manager } = createManager({
      appConfig: {
        openaiApiKey: "openai-key"
      }
    });

    const result = await requestJoin(manager, {
      message: createMessage(),
      settings: baseSettings({
        voice: {
          mode: "openai_realtime",
          replyPath: "brain"
        }
      })
    });

    assert.equal(result, true);
    assert.equal(connectCalls.length, 1);
    assert.deepEqual(connectCalls[0]?.tools, []);
    const session = manager.sessions.get("guild-1");
    assert.equal(session?.realtimeToolOwnership, "transport_only");
    assert.equal(session?.realtimePendingToolCalls, undefined);
    assert.equal(session?.realtimeToolDefinitions, undefined);
    assert.equal(session?.awaitingToolOutputs, undefined);
    assert.equal(Array.isArray(session?.toolCallEvents), true);
    assert.equal(Array.isArray(session?.mcpStatus), true);
    assert.equal(session?.toolMusicTrackCatalog instanceof Map, true);
    assert.equal(Array.isArray(session?.memoryWriteWindow), true);
  } finally {
    ClankvoxClient.spawn = originalSpawn;
    OpenAiRealtimeClient.prototype.connect = originalConnect;
  }
});

test("requestJoin emits structured self-join runtime context for the bot arrival event", async () => {
  const originalSpawn = ClankvoxClient.spawn;
  const originalConnect = OpenAiRealtimeClient.prototype.connect;
  const runtimeEventCalls = [];

  ClankvoxClient.spawn = async () => ({
    destroy() {},
    on() {},
    off() {}
  }) as ClankvoxClient;
  OpenAiRealtimeClient.prototype.connect = async function connectStub() {
    return {};
  };

  try {
    const { manager } = createManager({
      appConfig: {
        openaiApiKey: "openai-key"
      },
      async fireVoiceRuntimeEvent(payload) {
        runtimeEventCalls.push(payload);
        return true;
      }
    });

    const result = await requestJoin(manager, {
      message: createMessage(),
      settings: baseSettings({
        botName: "clanker conk",
        voice: {
          mode: "openai_realtime",
          replyPath: "brain"
        }
      })
    });

    assert.equal(result, true);
    assert.equal(runtimeEventCalls.length, 1);
    assert.equal(runtimeEventCalls[0]?.transcript, "[YOU joined the voice channel]");
    assert.deepEqual(runtimeEventCalls[0]?.runtimeEventContext, {
      category: "membership",
      eventType: "join",
      actorUserId: "bot-1",
      actorDisplayName: "clanker conk",
      actorRole: "self"
    });
  } finally {
    ClankvoxClient.spawn = originalSpawn;
    OpenAiRealtimeClient.prototype.connect = originalConnect;
  }
});

test("requestJoin omits provider-native realtime tools at connect for xAI brain transport-only sessions", async () => {
  const originalSpawn = ClankvoxClient.spawn;
  const originalConnect = XaiRealtimeClient.prototype.connect;
  const connectCalls = [];

  ClankvoxClient.spawn = async () => ({
    destroy() {},
    on() {},
    off() {}
  }) as ClankvoxClient;
  XaiRealtimeClient.prototype.connect = async function connectStub(payload = {}) {
    connectCalls.push(payload);
    return {};
  };

  try {
    const { manager } = createManager({
      appConfig: {
        xaiApiKey: "xai-key",
        openaiApiKey: "openai-key"
      }
    });

    const result = await requestJoin(manager, {
      message: createMessage(),
      settings: baseSettings({
        voice: {
          mode: "voice_agent",
          replyPath: "brain"
        }
      })
    });

    assert.equal(result, true);
    assert.equal(connectCalls.length, 1);
    assert.deepEqual(connectCalls[0]?.tools, []);
    const session = manager.sessions.get("guild-1");
    assert.equal(session?.realtimeToolOwnership, "transport_only");
    assert.equal(session?.realtimePendingToolCalls, undefined);
    assert.equal(session?.realtimeToolDefinitions, undefined);
    assert.equal(session?.awaitingToolOutputs, undefined);
  } finally {
    ClankvoxClient.spawn = originalSpawn;
    XaiRealtimeClient.prototype.connect = originalConnect;
  }
});

test("requestJoin includes OpenAI realtime tools at connect for bridge sessions", async () => {
  const originalSpawn = ClankvoxClient.spawn;
  const originalConnect = OpenAiRealtimeClient.prototype.connect;
  const connectCalls = [];

  ClankvoxClient.spawn = async () => ({
    destroy() {},
    on() {},
    off() {}
  }) as ClankvoxClient;
  OpenAiRealtimeClient.prototype.connect = async function connectStub(payload = {}) {
    connectCalls.push(payload);
    return {};
  };

  try {
    const { manager } = createManager({
      appConfig: {
        openaiApiKey: "openai-key"
      }
    });

    const result = await requestJoin(manager, {
      message: createMessage(),
      settings: baseSettings({
        voice: {
          mode: "openai_realtime",
          replyPath: "bridge"
        }
      })
    });

    assert.equal(result, true);
    assert.equal(connectCalls.length, 1);
    assert.equal(Array.isArray(connectCalls[0]?.tools), true);
    assert.equal((connectCalls[0]?.tools || []).length > 0, true);
    const session = manager.sessions.get("guild-1");
    assert.equal(session?.realtimeToolOwnership, "provider_native");
    assert.equal(session?.realtimePendingToolCalls instanceof Map, true);
    assert.equal(Array.isArray(session?.realtimeToolDefinitions), true);
    assert.equal(session?.awaitingToolOutputs, false);
  } finally {
    ClankvoxClient.spawn = originalSpawn;
    OpenAiRealtimeClient.prototype.connect = originalConnect;
  }
});

test("requestJoin includes xAI realtime tools at connect for bridge sessions", async () => {
  const originalSpawn = ClankvoxClient.spawn;
  const originalConnect = XaiRealtimeClient.prototype.connect;
  const connectCalls = [];

  ClankvoxClient.spawn = async () => ({
    destroy() {},
    on() {},
    off() {}
  }) as ClankvoxClient;
  XaiRealtimeClient.prototype.connect = async function connectStub(payload = {}) {
    connectCalls.push(payload);
    return {};
  };

  try {
    const { manager } = createManager({
      appConfig: {
        xaiApiKey: "xai-key",
        openaiApiKey: "openai-key"
      }
    });

    const result = await requestJoin(manager, {
      message: createMessage(),
      settings: baseSettings({
        voice: {
          mode: "voice_agent",
          replyPath: "bridge"
        }
      })
    });

    assert.equal(result, true);
    assert.equal(connectCalls.length, 1);
    assert.equal(Array.isArray(connectCalls[0]?.tools), true);
    assert.equal((connectCalls[0]?.tools || []).length > 0, true);
    const session = manager.sessions.get("guild-1");
    assert.equal(session?.realtimeToolOwnership, "provider_native");
    assert.equal(session?.realtimePendingToolCalls instanceof Map, true);
    assert.equal(Array.isArray(session?.realtimeToolDefinitions), true);
    assert.equal(session?.awaitingToolOutputs, false);
    assert.equal(session?.perUserAsrEnabled, true);
    assert.equal(session?.sharedAsrEnabled, false);
  } finally {
    ClankvoxClient.spawn = originalSpawn;
    XaiRealtimeClient.prototype.connect = originalConnect;
  }
});

test("requestJoin requires OpenAI ASR backing for xAI text-mediated sessions", async () => {
  const { manager, operationalMessages } = createManager({
    appConfig: {
      xaiApiKey: "xai-key"
    }
  });

  const result = await requestJoin(manager, {
    message: createMessage(),
    settings: baseSettings({
      voice: {
        mode: "voice_agent",
        replyPath: "bridge",
        openaiRealtime: {
          transcriptionMethod: "realtime_bridge",
          usePerUserAsrBridge: true
        }
      }
    })
  });

  assert.equal(result, true);
  assert.equal(operationalMessages.at(-1)?.reason, "openai_audio_api_key_missing");
});
