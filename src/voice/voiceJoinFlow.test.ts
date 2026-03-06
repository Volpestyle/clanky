import { test } from "bun:test";
import assert from "node:assert/strict";
import { requestJoin } from "./voiceJoinFlow.ts";
import { createTestSettings } from "../testSettings.ts";

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
      id: "text-1"
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
    appConfig: {},
    llm: defaultLlm,
    store: defaultStore,
    generateVoiceTurn: async () => ({ text: "ok" }),
    async withJoinLock(_guildId, fn) {
      return await fn();
    },
    async sendOperationalMessage(payload) {
      operationalMessages.push(payload);
    },
    touchActivityCalls: 0,
    touchActivity() {
      this.touchActivityCalls += 1;
    },
    endSessionCalls: 0,
    async endSession() {
      this.endSessionCalls += 1;
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
  assert.equal(operationalMessages.at(-1)?.mustNotify, false);
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

test("requestJoin validates stt pipeline dependencies", async () => {
  const noAsr = createManager({
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
        mode: "stt_pipeline"
      }
    })
  });
  assert.equal(noAsrResult, true);
  assert.equal(noAsr.operationalMessages.at(-1)?.reason, "stt_pipeline_asr_unavailable");

  const noTts = createManager({
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
        mode: "stt_pipeline"
      }
    })
  });
  assert.equal(noTtsResult, true);
  assert.equal(noTts.operationalMessages.at(-1)?.reason, "stt_pipeline_tts_unavailable");

  const noBrain = createManager({
    generateVoiceTurn: null
  });
  const noBrainResult = await requestJoin(noBrain.manager, {
    message: createMessage(),
    settings: baseSettings({
      voice: {
        mode: "stt_pipeline"
      }
    })
  });
  assert.equal(noBrainResult, true);
  assert.equal(noBrain.operationalMessages.at(-1)?.reason, "stt_pipeline_brain_unavailable");
});

test("requestJoin reports missing permission info from manager checks", async () => {
  const { manager, operationalMessages } = createManager({
    appConfig: {
      xaiApiKey: "xai-key"
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
      xaiApiKey: "xai-key"
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
