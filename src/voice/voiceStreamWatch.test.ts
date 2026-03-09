import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  enableWatchStreamForUser,
  getStreamWatchBrainContextForPrompt,
  ingestStreamFrame,
  initializeStreamWatchState,
  maybeTriggerStreamWatchCommentary,
  resolveStreamWatchVisionProviderSettings,
  stopWatchStreamForUser
} from "./voiceStreamWatch.ts";

function createSettings(overrides = {}) {
  const defaults = {
    botName: "clanker conk",
    llm: {
      provider: "openai",
      model: "claude-haiku-4-5"
    },
    voice: {
      streamWatch: {
        enabled: true,
        minCommentaryIntervalSeconds: 8,
        maxFramesPerMinute: 180,
        maxFrameBytes: 350000,
        keyframeIntervalMs: 1200,
        autonomousCommentaryEnabled: true,
        brainContextEnabled: true,
        brainContextMinIntervalSeconds: 4,
        brainContextMaxEntries: 8,
        brainContextProvider: "anthropic",
        brainContextModel: "claude-haiku-4-5",
        brainContextPrompt:
          "Write one short factual private note about the most salient visible state or change in this frame. Prioritize gameplay actions, objectives, outcomes, menus, or unusual/funny moments that could support a natural later comment. If the frame is mostly idle UI, lobby, desktop, or other non-gameplay context, say that plainly. Prefer what is newly different from the previous frame."
      }
    }
  };
  return {
    ...defaults,
    ...overrides,
    llm: {
      ...defaults.llm,
      ...(overrides.llm || {})
    },
    voice: {
      ...defaults.voice,
      ...(overrides.voice || {}),
      streamWatch: {
        ...defaults.voice.streamWatch,
        ...(overrides.voice?.streamWatch || {})
      }
    }
  };
}

function createSession(overrides = {}) {
  return {
    id: "session-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    voiceChannelId: "voice-1",
    mode: "openai_realtime",
    ending: false,
    settingsSnapshot: createSettings(),
    streamWatch: {
      active: true,
      targetUserId: "user-1",
      requestedByUserId: "user-1",
      lastFrameAt: 0,
      lastCommentaryAt: 0,
      lastCommentaryNote: null,
      lastBrainContextAt: 0,
      lastBrainContextProvider: null,
      lastBrainContextModel: null,
      brainContextEntries: [],
      ingestedFrameCount: 0,
      acceptedFrameCountInWindow: 0,
      frameWindowStartedAt: 0,
      latestFrameMimeType: null,
      latestFrameDataBase64: "",
      latestFrameAt: 0
    },
    userCaptures: new Map(),
    pendingResponse: false,
    lastInboundAudioAt: 0,
    realtimeClient: {
      appendInputVideoFrame() {},
      requestVideoCommentary() {}
    },
    ...overrides
  };
}

function createManager({
  session = null,
  settings = createSettings(),
  llm = {},
  memory = {},
  guildVoiceMembers = ["user-1"]
} = {}) {
  const actions = [];
  const touchCalls = [];
  const createdResponses = [];
  const brainReplyCalls = [];
  const memoryIngests = [];
  const memoryWrites = [];
  const manager = {
    sessions: new Map(),
    store: {
      getSettings() {
        return settings;
      },
      logAction(entry) {
        actions.push(entry);
      }
    },
    llm: {
      isProviderConfigured() {
        return false;
      },
      async generate() {
        return {
          text: "looks chaotic",
          provider: "openai",
          model: "claude-haiku-4-5"
        };
      },
      ...llm
    },
    memory: {
      async ingestMessage(payload) {
        memoryIngests.push(payload);
        return true;
      },
      async rememberDirectiveLineDetailed(payload) {
        memoryWrites.push(payload);
        return {
          ok: true,
          reason: "added_new"
        };
      },
      ...memory
    },
    client: {
      user: {
        id: "bot-1"
      },
      guilds: {
        cache: new Map()
      }
    },
    touchActivity(guildId, resolvedSettings) {
      touchCalls.push({ guildId, resolvedSettings });
    },
    resolveVoiceSpeakerName() {
      return "alice";
    },
    replyManager: {
      createTrackedAudioResponse() {
        const response = { id: `resp-${createdResponses.length + 1}` };
        createdResponses.push(response);
        return response;
      }
    },
    async runRealtimeBrainReply(payload) {
      brainReplyCalls.push(payload);
      return true;
    }
  };

  if (session) {
    manager.sessions.set(session.guildId, session);
    const members = new Set(guildVoiceMembers);
    const voiceChannel = {
      members: {
        has(userId) {
          return members.has(String(userId || ""));
        }
      }
    };
    manager.client.guilds.cache.set(session.guildId, {
      channels: {
        cache: new Map([[session.voiceChannelId, voiceChannel]])
      }
    });
  }

  return {
    manager,
    actions,
    touchCalls,
    createdResponses,
    brainReplyCalls,
    memoryIngests,
    memoryWrites
  };
}

test("initializeStreamWatchState resets stream-watch counters and frame buffers", () => {
  const session = createSession({
    streamWatch: {
      active: false,
      targetUserId: null,
      requestedByUserId: null,
      lastFrameAt: 100,
      lastCommentaryAt: 100,
      lastCommentaryNote: "old note",
      lastBrainContextAt: 100,
      lastBrainContextProvider: "anthropic",
      lastBrainContextModel: "claude-haiku-4-5",
      brainContextEntries: [{ text: "old", at: 10 }],
      ingestedFrameCount: 12,
      acceptedFrameCountInWindow: 8,
      frameWindowStartedAt: 123,
      latestFrameMimeType: "image/png",
      latestFrameDataBase64: "abc",
      latestFrameAt: 456
    }
  });

  initializeStreamWatchState({}, {
    session,
    requesterUserId: "requester-1",
    targetUserId: "target-1"
  });

  assert.equal(session.streamWatch.active, true);
  assert.equal(session.streamWatch.targetUserId, "target-1");
  assert.equal(session.streamWatch.requestedByUserId, "requester-1");
  assert.equal(session.streamWatch.lastFrameAt, 0);
  assert.equal(session.streamWatch.lastCommentaryAt, 0);
  assert.equal(session.streamWatch.lastCommentaryNote, null);
  assert.equal(session.streamWatch.lastBrainContextAt, 0);
  assert.equal(session.streamWatch.lastBrainContextProvider, null);
  assert.equal(session.streamWatch.lastBrainContextModel, null);
  assert.deepEqual(session.streamWatch.brainContextEntries, []);
  assert.equal(session.streamWatch.ingestedFrameCount, 0);
  assert.equal(session.streamWatch.acceptedFrameCountInWindow, 0);
  assert.equal(session.streamWatch.frameWindowStartedAt, 0);
  assert.equal(session.streamWatch.latestFrameMimeType, null);
  assert.equal(session.streamWatch.latestFrameDataBase64, "");
  assert.equal(session.streamWatch.latestFrameAt, 0);
});

test("getStreamWatchBrainContextForPrompt retains recent notes after screen share stops", () => {
  const now = Date.now();
  const session = createSession({
    streamWatch: {
      active: false,
      targetUserId: null,
      requestedByUserId: "user-1",
      lastFrameAt: now - 5_000,
      lastCommentaryAt: now - 4_000,
      lastCommentaryNote: "boss fight HUD visible",
      lastBrainContextAt: now - 3_000,
      lastBrainContextProvider: "anthropic",
      lastBrainContextModel: "claude-haiku-4-5",
      brainContextEntries: [
        {
          text: "boss fight HUD visible",
          at: now - 3_000,
          provider: "anthropic",
          model: "claude-haiku-4-5",
          speakerName: "alice"
        }
      ],
      ingestedFrameCount: 4,
      acceptedFrameCountInWindow: 4,
      frameWindowStartedAt: now - 10_000,
      latestFrameMimeType: null,
      latestFrameDataBase64: "",
      latestFrameAt: 0
    }
  });

  const context = getStreamWatchBrainContextForPrompt(session, createSettings());
  assert.equal(Boolean(context), true);
  assert.equal(context?.active, false);
  assert.equal(context?.notes.length, 1);
  assert.equal(String(context?.notes[0] || "").includes("boss fight HUD visible"), true);
});

test("resolveStreamWatchVisionProviderSettings uses configured provider/model from settings", () => {
  const { manager } = createManager({
    llm: {
      isProviderConfigured(provider) {
        return provider === "xai";
      }
    }
  });
  const resolved = resolveStreamWatchVisionProviderSettings(manager, createSettings({
    llm: {
      maxOutputTokens: 999,
      temperature: 0.9
    },
    voice: {
      streamWatch: {
        brainContextProvider: "xai",
        brainContextModel: "grok-2-vision-latest"
      }
    }
  }));

  assert.equal(resolved.provider, "xai");
  assert.equal(resolved.model, "grok-2-vision-latest");
  assert.equal(resolved.temperature, 0.3);
  assert.equal(resolved.maxOutputTokens, 72);
});

test("resolveStreamWatchVisionProviderSettings returns null when provider not configured", () => {
  const { manager } = createManager({
    llm: {
      isProviderConfigured() {
        return false;
      }
    }
  });
  const resolved = resolveStreamWatchVisionProviderSettings(manager, createSettings({
    voice: {
      streamWatch: {
        brainContextProvider: "anthropic",
        brainContextModel: "claude-haiku-4-5"
      }
    }
  }));

  assert.equal(resolved, null);
});

test("enableWatchStreamForUser enforces same-voice-channel requirement and supports success", async () => {
  const session = createSession();
  const denied = createManager({
    session,
    guildVoiceMembers: []
  });

  const deniedResult = await enableWatchStreamForUser(denied.manager, {
    guildId: "guild-1",
    requesterUserId: "user-1"
  });
  assert.equal(deniedResult.ok, false);
  assert.equal(deniedResult.reason, "requester_not_in_same_vc");

  const allowed = createManager({
    session: createSession()
  });
  const allowedResult = await enableWatchStreamForUser(allowed.manager, {
    guildId: "guild-1",
    requesterUserId: "user-1",
    targetUserId: "user-2",
    source: "test"
  });

  assert.equal(allowedResult.ok, true);
  assert.equal(allowedResult.reason, "watching_started");
  assert.equal(allowedResult.targetUserId, "user-2");
  assert.equal(allowed.manager.sessions.get("guild-1")?.streamWatch?.active, true);
  assert.equal(allowed.actions.some((entry) => entry.kind === "voice_runtime"), true);
});

test("ingestStreamFrame validates mime, frame size, and frame-rate limits", async () => {
  const settings = createSettings({
    voice: {
      streamWatch: {
        enabled: true,
        maxFramesPerMinute: 1,
        maxFrameBytes: 12
      }
    }
  });
  const session = createSession({
    mode: "voice_agent",
    realtimeClient: {
      requestTextUtterance() {}
    },
    settingsSnapshot: settings
  });
  const { manager } = createManager({
    session,
    settings,
    llm: {
      isProviderConfigured(provider) {
        return provider === "anthropic";
      }
    }
  });

  let result = await ingestStreamFrame(manager, {
    guildId: "guild-1",
    streamerUserId: "user-1",
    mimeType: "image/gif",
    dataBase64: "abcd"
  });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "invalid_mime_type");

  result = await ingestStreamFrame(manager, {
    guildId: "guild-1",
    streamerUserId: "user-1",
    mimeType: "image/png",
    dataBase64: "A".repeat(100_000)
  });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "frame_too_large");

  session.streamWatch.frameWindowStartedAt = Date.now();
  session.streamWatch.acceptedFrameCountInWindow = 6;
  result = await ingestStreamFrame(manager, {
    guildId: "guild-1",
    streamerUserId: "user-1",
    mimeType: "image/png",
    dataBase64: "AAAA"
  });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "frame_rate_limited");
});

test("ingestStreamFrame accepts fallback-buffered frame and updates runtime counters", async () => {
  const session = createSession({
    mode: "voice_agent",
    realtimeClient: {
      requestTextUtterance() {}
    },
    userCaptures: new Map([["user-1", {}]])
  });
  const { manager, actions, touchCalls } = createManager({
    session,
    settings: createSettings({
      voice: {
        streamWatch: {
          enabled: true,
          maxFramesPerMinute: 10,
          maxFrameBytes: 1_000_000
        }
      }
    }),
    llm: {
      isProviderConfigured(provider) {
        return provider === "anthropic";
      }
    }
  });

  const result = await ingestStreamFrame(manager, {
    guildId: "guild-1",
    streamerUserId: "user-1",
    mimeType: "image/jpg",
    dataBase64: "AAAAAA==",
    source: "unit_test"
  });

  assert.equal(result.accepted, true);
  assert.equal(result.reason, "ok");
  assert.equal(session.streamWatch.latestFrameMimeType, "image/jpeg");
  assert.equal(session.streamWatch.latestFrameDataBase64, "AAAAAA==");
  assert.equal(session.streamWatch.ingestedFrameCount, 1);
  assert.equal(session.streamWatch.acceptedFrameCountInWindow, 1);
  assert.equal(touchCalls.length, 1);
  assert.equal(actions.some((entry) => entry.content === "stream_watch_frame_ingested"), true);
});

test("maybeTriggerStreamWatchCommentary fires a normal brain turn on the first frame", async () => {
  const session = createSession({
    mode: "openai_realtime",
    streamWatch: {
      active: true,
      targetUserId: "user-1",
      requestedByUserId: "user-1",
      lastFrameAt: Date.now(),
      lastCommentaryAt: 0,
      lastCommentaryNote: null,
      lastBrainContextAt: 0,
      lastBrainContextProvider: null,
      lastBrainContextModel: null,
      brainContextEntries: [],
      ingestedFrameCount: 1,
      acceptedFrameCountInWindow: 1,
      frameWindowStartedAt: Date.now(),
      latestFrameMimeType: "image/png",
      latestFrameDataBase64: "AAAA",
      latestFrameAt: Date.now()
    }
  });
  session.streamWatch.lastCommentaryAt = 0;
  const { manager, actions, brainReplyCalls, createdResponses } = createManager({ session });

  await maybeTriggerStreamWatchCommentary(manager, {
    session,
    settings: createSettings(),
    streamerUserId: "user-1",
    source: "unit_test"
  });

  assert.equal(brainReplyCalls.length, 1);
  assert.equal(String(brainReplyCalls[0]?.source || ""), "stream_watch_brain_turn:share_start");
  assert.equal(String(brainReplyCalls[0]?.frozenFrameSnapshot?.dataBase64 || ""), "AAAA");
  assert.equal(session.streamWatch.lastCommentaryAt > 0, true);
  assert.equal(createdResponses.length, 0);
  const logged = actions.find((entry) => entry.content === "stream_watch_commentary_requested");
  assert.equal(Boolean(logged), true);
  assert.equal(logged?.metadata?.commentaryMode, "brain_turn");
  assert.equal(logged?.metadata?.triggerReason, "share_start");
});

test("maybeTriggerStreamWatchCommentary keeps direct frame-to-brain active even with a scanner provider configured", async () => {
  const session = createSession({
    mode: "voice_agent",
    streamWatch: {
      active: true,
      targetUserId: "user-1",
      requestedByUserId: "user-1",
      lastFrameAt: Date.now(),
      lastCommentaryAt: 0,
      lastCommentaryNote: null,
      lastBrainContextAt: 0,
      lastBrainContextProvider: null,
      lastBrainContextModel: null,
      brainContextEntries: [],
      ingestedFrameCount: 2,
      acceptedFrameCountInWindow: 2,
      frameWindowStartedAt: Date.now(),
      latestFrameMimeType: "image/png",
      latestFrameDataBase64: "AAAA",
      latestFrameAt: Date.now()
    }
  });
  const settings = createSettings({
    voice: {
      streamWatch: {
        brainContextProvider: "anthropic",
        brainContextModel: "claude-haiku-4-5"
      }
    }
  });
  const { manager, actions, brainReplyCalls, createdResponses } = createManager({
    session,
    settings,
    llm: {
      isProviderConfigured(provider) {
        return provider === "anthropic";
      },
      async generate() {
        return {
          text: JSON.stringify({
            note: "scoreboard changed and the timer is low",
            sceneChanged: true
          }),
          provider: "anthropic",
          model: "claude-haiku-4-5"
        };
      }
    }
  });

  await maybeTriggerStreamWatchCommentary(manager, {
    session,
    settings,
    streamerUserId: "user-1",
    source: "unit_test"
  });

  assert.equal(brainReplyCalls.length, 1);
  assert.equal(String(brainReplyCalls[0]?.source || ""), "stream_watch_brain_turn:scene_changed");
  assert.equal(createdResponses.length, 0);
  const logged = actions.find((entry) => entry.content === "stream_watch_commentary_requested");
  assert.equal(Boolean(logged), true);
  assert.equal(logged?.metadata?.commentaryMode, "brain_turn");
  assert.equal(logged?.metadata?.triggerReason, "scene_changed");
});

test("maybeTriggerStreamWatchCommentary can update brain context without speaking commentary", async () => {
  const session = createSession({
    mode: "openai_realtime",
    botTurnOpen: false,
    realtimeClient: {
      appendInputVideoFrame() {}
    },
    streamWatch: {
      active: true,
      targetUserId: "user-1",
      requestedByUserId: "user-1",
      lastFrameAt: Date.now(),
      lastCommentaryAt: 0,
      lastBrainContextAt: 0,
      lastBrainContextProvider: null,
      lastBrainContextModel: null,
      brainContextEntries: [],
      ingestedFrameCount: 0,
      acceptedFrameCountInWindow: 0,
      frameWindowStartedAt: 0,
      latestFrameMimeType: "image/png",
      latestFrameDataBase64: "AAAA",
      latestFrameAt: Date.now()
    }
  });
  const settings = createSettings({
    voice: {
      streamWatch: {
        autonomousCommentaryEnabled: false,
        brainContextEnabled: true,
        brainContextMinIntervalSeconds: 1,
        brainContextMaxEntries: 6,
        brainContextPrompt: "Summarize this frame for downstream brain replies."
      }
    }
  });
  const { manager, actions, brainReplyCalls, createdResponses } = createManager({
    session,
    settings,
    llm: {
      isProviderConfigured(provider) {
        return provider === "anthropic";
      },
      async generate() {
        return {
          text: "fps hud and a team fight on screen",
          provider: "anthropic",
          model: "claude-haiku-4-5"
        };
      }
    }
  });

  await maybeTriggerStreamWatchCommentary(manager, {
    session,
    settings,
    streamerUserId: "user-1",
    source: "unit_test"
  });

  assert.equal(createdResponses.length, 0);
  assert.equal(brainReplyCalls.length, 0);
  assert.equal(Array.isArray(session.streamWatch.brainContextEntries), true);
  assert.equal(session.streamWatch.brainContextEntries.length, 1);
  assert.equal(
    actions.some((entry) => entry.content === "stream_watch_brain_context_updated"),
    true
  );
  assert.equal(
    actions.some((entry) => entry.content === "stream_watch_commentary_requested"),
    false
  );
});

test("maybeTriggerStreamWatchCommentary does not let scanner shouldComment disable a brain turn", async () => {
  const now = Date.now();
  const session = createSession({
    mode: "openai_realtime",
    botTurnOpen: false,
    realtimeClient: {
      appendInputVideoFrame() {}
    },
    streamWatch: {
      active: true,
      targetUserId: "user-1",
      requestedByUserId: "user-1",
      lastFrameAt: now,
      lastCommentaryAt: 0,
      lastCommentaryNote: null,
      lastBrainContextAt: 0,
      lastBrainContextProvider: null,
      lastBrainContextModel: null,
      brainContextEntries: [],
      ingestedFrameCount: 2,
      acceptedFrameCountInWindow: 2,
      frameWindowStartedAt: 0,
      latestFrameMimeType: "image/png",
      latestFrameDataBase64: "AAAA",
      latestFrameAt: now
    }
  });
  const { manager, actions, brainReplyCalls, createdResponses } = createManager({
    session,
    llm: {
      isProviderConfigured(provider) {
        return provider === "anthropic";
      },
      async generate({ trace }) {
        if (trace?.source === "voice_stream_watch_brain_context") {
          return {
            text: JSON.stringify({
              note: "inventory menu still open",
              sceneChanged: true,
              shouldComment: false
            }),
            provider: "anthropic",
            model: "claude-haiku-4-5"
          };
        }
        return {
          text: "inventory menu still open",
          provider: "anthropic",
          model: "claude-haiku-4-5"
        };
      }
    }
  });

  await maybeTriggerStreamWatchCommentary(manager, {
    session,
    settings: createSettings(),
    streamerUserId: "user-1",
    source: "unit_test"
  });

  assert.equal(brainReplyCalls.length, 1);
  assert.equal(String(brainReplyCalls[0]?.source || ""), "stream_watch_brain_turn:scene_changed");
  assert.equal(createdResponses.length, 0);
  assert.equal(
    actions.some((entry) => entry.content === "stream_watch_brain_context_updated"),
    true
  );
  assert.equal(actions.some((entry) => entry.content === "stream_watch_commentary_requested"), true);
});

test("maybeTriggerStreamWatchCommentary skips autonomous commentary when no trigger is active", async () => {
  const now = Date.now();
  const session = createSession({
    mode: "openai_realtime",
    botTurnOpen: false,
    realtimeClient: {
      appendInputVideoFrame() {}
    },
    streamWatch: {
      active: true,
      targetUserId: "user-1",
      requestedByUserId: "user-1",
      lastFrameAt: now,
      lastCommentaryAt: 0,
      lastCommentaryNote: "same HUD and minimap visible",
      lastBrainContextAt: 0,
      lastBrainContextProvider: "anthropic",
      lastBrainContextModel: "claude-haiku-4-5",
      brainContextEntries: [
        {
          text: "same HUD and minimap visible",
          at: now - 5_000,
          provider: "anthropic",
          model: "claude-haiku-4-5",
          speakerName: "alice"
        }
      ],
      ingestedFrameCount: 3,
      acceptedFrameCountInWindow: 3,
      frameWindowStartedAt: 0,
      latestFrameMimeType: "image/png",
      latestFrameDataBase64: "AAAA",
      latestFrameAt: now
    }
  });
  const { manager, actions, brainReplyCalls, createdResponses } = createManager({
    session,
    llm: {
      isProviderConfigured(provider) {
        return provider === "anthropic";
      },
      async generate() {
        return {
          text: "same HUD and minimap visible",
          provider: "anthropic",
          model: "claude-haiku-4-5"
        };
      }
    }
  });

  await maybeTriggerStreamWatchCommentary(manager, {
    session,
    settings: createSettings(),
    streamerUserId: "user-1",
    source: "unit_test"
  });

  assert.equal(brainReplyCalls.length, 0);
  assert.equal(createdResponses.length, 0);
  assert.equal(actions.some((entry) => entry.content === "stream_watch_commentary_requested"), false);
  assert.equal(
    actions.some((entry) => entry.content === "stream_watch_brain_context_updated"),
    true
  );
});

test("stopWatchStreamForUser persists a screen-share recap to memory and preserves prompt notes", async () => {
  const now = Date.now();
  const session = createSession({
    streamWatch: {
      active: true,
      targetUserId: "user-1",
      requestedByUserId: "user-1",
      lastFrameAt: now,
      lastCommentaryAt: now - 5_000,
      lastCommentaryNote: "boss fight HUD visible",
      lastBrainContextAt: now - 3_000,
      lastBrainContextProvider: "anthropic",
      lastBrainContextModel: "claude-haiku-4-5",
      brainContextEntries: [
        {
          text: "boss fight HUD visible",
          at: now - 4_000,
          provider: "anthropic",
          model: "claude-haiku-4-5",
          speakerName: "alice"
        },
        {
          text: "health bar flashing during boss phase",
          at: now - 2_000,
          provider: "anthropic",
          model: "claude-haiku-4-5",
          speakerName: "alice"
        }
      ],
      ingestedFrameCount: 4,
      acceptedFrameCountInWindow: 4,
      frameWindowStartedAt: now - 10_000,
      latestFrameMimeType: "image/png",
      latestFrameDataBase64: "AAAA",
      latestFrameAt: now
    }
  });
  const settings = createSettings({
    memory: {
      enabled: true
    }
  });
  const { manager, memoryIngests, memoryWrites } = createManager({
    session,
    settings,
    llm: {
      async generate({ trace }) {
        if (trace?.source === "voice_stream_watch_memory_recap") {
          return {
            text: JSON.stringify({
              shouldStore: true,
              recap: "Alice recently screen-shared a boss fight HUD with a flashing health bar."
            }),
            provider: "openai",
            model: "gpt-4o-mini"
          };
        }
        return {
          text: "unused"
        };
      }
    }
  });

  const stopped = await stopWatchStreamForUser(manager, {
    guildId: "guild-1",
    requesterUserId: "user-1",
    targetUserId: "user-1",
    settings,
    reason: "share_page_stop"
  });

  assert.equal(stopped.ok, true);
  assert.equal(session.streamWatch.active, false);
  assert.equal(session.streamWatch.targetUserId, null);
  assert.equal(session.streamWatch.latestFrameDataBase64, "");
  assert.equal(memoryIngests.length, 1);
  assert.equal(String(memoryIngests[0]?.content || "").includes("Screen share recap:"), true);
  assert.equal(memoryWrites.length, 1);
  assert.equal(memoryWrites[0]?.line, "Alice recently screen-shared a boss fight HUD with a flashing health bar.");
  const context = getStreamWatchBrainContextForPrompt(session, settings);
  assert.equal(Boolean(context), true);
  assert.equal(context?.active, false);
  assert.equal(context?.notes.length, 2);
});

test("maybeTriggerStreamWatchCommentary skips while playback stream is busy", async () => {
  const session = createSession({
    mode: "voice_agent",
    botTurnOpen: true,
    streamWatch: {
      active: true,
      targetUserId: "user-1",
      requestedByUserId: "user-1",
      lastFrameAt: Date.now(),
      lastCommentaryAt: 0,
      ingestedFrameCount: 0,
      acceptedFrameCountInWindow: 0,
      frameWindowStartedAt: 0,
      latestFrameMimeType: "image/png",
      latestFrameDataBase64: "AAAA",
      latestFrameAt: Date.now()
    },
    botAudioStream: {
      writableLength: 96_000,
      destroyed: false,
      writableEnded: false,
      destroy() {}
    }
  });
  const { manager, actions, brainReplyCalls, createdResponses } = createManager({
    session,
    llm: {
      isProviderConfigured(provider) {
        return provider === "anthropic";
      }
    }
  });

  await maybeTriggerStreamWatchCommentary(manager, {
    session,
    settings: createSettings(),
    streamerUserId: "user-1",
    source: "unit_test"
  });

  assert.equal(brainReplyCalls.length, 0);
  assert.equal(createdResponses.length, 0);
  assert.equal(actions.some((entry) => entry.content === "stream_watch_commentary_requested"), false);
});
