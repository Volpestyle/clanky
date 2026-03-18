import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  appendStreamWatchNoteEntry,
  enableWatchStreamForUser,
  getStreamWatchNotesForPrompt,
  handleDiscoveredStreamCredentialsReceived,
  handleDiscoveredStreamDeleted,
  ingestStreamFrame,
  initializeStreamWatchState,
  maybeTriggerStreamWatchCommentary,
  resolveStreamWatchNoteModelSettings,
  stopWatchStreamForUser
} from "./voiceStreamWatch.ts";
import { createStreamDiscoveryState } from "../selfbot/streamDiscovery.ts";
import { ensureNativeDiscordScreenShareState } from "./nativeDiscordScreenShare.ts";

function createSettings(overrides = {}) {
  const defaults = {
    botName: "clanky",
    llm: {
      provider: "openai",
      model: "claude-haiku-4-5"
    },
    voice: {
      streamWatch: {
        enabled: true,
        commentaryIntervalSeconds: 8,
        maxFramesPerMinute: 180,
        maxFrameBytes: 350000,
        keyframeIntervalMs: 1200,
        autonomousCommentaryEnabled: true,
        noteIntervalSeconds: 4,
        maxNoteEntries: 8,
        noteProvider: "anthropic",
        noteModel: "claude-haiku-4-5",
        notePrompt:
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
      lastNoteAt: 0,
      lastNoteProvider: null,
      lastNoteModel: null,
      noteEntries: [],
      ingestedFrameCount: 0,
      acceptedFrameCountInWindow: 0,
      frameWindowStartedAt: 0,
      latestFrameMimeType: null,
      latestFrameDataBase64: "",
      latestFrameAt: 0
    },
    nativeScreenShare: {
      sharers: new Map(),
      subscribedTargetUserId: null,
      decodeInFlight: false,
      lastDecodeAttemptAt: 0,
      lastDecodeSuccessAt: 0,
      lastDecodeFailureAt: 0,
      lastDecodeFailureReason: null,
      ffmpegAvailable: null,
      activeStreamKey: null,
      lastRtcServerId: null,
      lastStreamEndpoint: null,
      lastCredentialsReceivedAt: 0,
      lastVoiceSessionId: null,
      transportStatus: null,
      transportReason: null,
      transportUpdatedAt: 0,
      transportConnectedAt: 0,
    },
    userCaptures: new Map(),
    pendingResponse: false,
    lastInboundAudioAt: 0,
    voxClient: {
      subscribeUserVideo() {},
      unsubscribeUserVideo() {},
      streamWatchConnect() {},
      streamWatchDisconnect() {},
      getLastVoiceSessionId() {
        return "voice-session-1";
      }
    },
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
  streamDiscovery = createStreamDiscoveryState(),
  guildVoiceMembers = ["user-1"],
  deferredQueuedTurns = [],
  outputChannelState = null,
  activeReplies = null
} = {}) {
  const actions = [];
  const touchCalls = [];
  const createdResponses = [];
  const brainReplyCalls = [];
  const memoryIngests = [];
  const memoryWrites = [];
  const manager = {
    sessions: new Map(),
    streamDiscovery,
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
      ws: {
        shards: {
          first() {
            return {
              id: 0,
              send() {}
            };
          }
        }
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
    deferredActionQueue: {
      getDeferredQueuedUserTurns() {
        return deferredQueuedTurns;
      }
    },
    getOutputChannelState() {
      return outputChannelState || {
        locked: false
      };
    },
    activeReplies: activeReplies || {
      has() {
        return false;
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
    nativeScreenShare: {
      sharers: new Map([[
        "target-1",
        {
          userId: "target-1",
          audioSsrc: 1001,
          videoSsrc: 1002,
          codec: "h264",
          streams: [],
          updatedAt: 123,
          lastFrameAt: 123,
          lastFrameCodec: "h264",
          lastFrameKeyframeAt: 123
        }
      ]]),
      subscribedTargetUserId: "target-1",
      decodeInFlight: false,
      lastDecodeAttemptAt: 123,
      lastDecodeSuccessAt: 456,
      lastDecodeFailureAt: 789,
      lastDecodeFailureReason: "old_failure",
      ffmpegAvailable: true,
      activeStreamKey: "old_stream",
      lastRtcServerId: "old_rtc",
      lastStreamEndpoint: "old_endpoint",
      lastCredentialsReceivedAt: 123,
      lastVoiceSessionId: "old_session",
      transportStatus: "ready",
      transportReason: "old_reason",
      transportUpdatedAt: 123,
      transportConnectedAt: 123
    },
    streamWatch: {
      active: false,
      targetUserId: null,
      requestedByUserId: null,
      lastFrameAt: 100,
      lastCommentaryAt: 100,
      lastCommentaryNote: "old note",
      lastNoteAt: 100,
      lastNoteProvider: "anthropic",
      lastNoteModel: "claude-haiku-4-5",
      noteEntries: [{ text: "old", at: 10 }],
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
  assert.equal(session.streamWatch.lastNoteAt, 0);
  assert.equal(session.streamWatch.lastNoteProvider, null);
  assert.equal(session.streamWatch.lastNoteModel, null);
  assert.deepEqual(session.streamWatch.noteEntries, []);
  assert.equal(session.streamWatch.ingestedFrameCount, 0);
  assert.equal(session.streamWatch.acceptedFrameCountInWindow, 0);
  assert.equal(session.streamWatch.frameWindowStartedAt, 0);
  assert.equal(session.streamWatch.latestFrameMimeType, null);
  assert.equal(session.streamWatch.latestFrameDataBase64, "");
  assert.equal(session.streamWatch.latestFrameAt, 0);

  const nativeScreenShare = ensureNativeDiscordScreenShareState(session);
  assert.equal(nativeScreenShare.lastDecodeAttemptAt, 0);
  assert.equal(nativeScreenShare.lastDecodeSuccessAt, 0);
  assert.equal(nativeScreenShare.lastDecodeFailureAt, 0);
  assert.equal(nativeScreenShare.lastDecodeFailureReason, null);
  assert.equal(nativeScreenShare.activeStreamKey, null);
  assert.equal(nativeScreenShare.transportStatus, null);
  assert.deepEqual([...nativeScreenShare.sharers.keys()], []);
});

test("getStreamWatchNotesForPrompt retains recent notes after screen share stops", () => {
  const now = Date.now();
  const session = createSession({
    streamWatch: {
      active: false,
      targetUserId: null,
      requestedByUserId: "user-1",
      lastFrameAt: now - 5_000,
      lastCommentaryAt: now - 4_000,
      lastCommentaryNote: "boss fight HUD visible",
      lastNoteAt: now - 3_000,
      lastNoteProvider: "anthropic",
      lastNoteModel: "claude-haiku-4-5",
      noteEntries: [
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

  const context = getStreamWatchNotesForPrompt(session, createSettings());
  assert.equal(Boolean(context), true);
  assert.equal(context?.active, false);
  assert.equal(context?.notes.length, 1);
  assert.equal(String(context?.notes[0] || "").includes("boss fight HUD visible"), true);
});

test("resolveStreamWatchNoteModelSettings uses configured provider/model from settings", () => {
  const { manager } = createManager({
    llm: {
      isProviderConfigured(provider) {
        return provider === "xai";
      }
    }
  });
  const resolved = resolveStreamWatchNoteModelSettings(manager, createSettings({
    llm: {
      maxOutputTokens: 999,
      temperature: 0.9
    },
    voice: {
      streamWatch: {
        noteProvider: "xai",
        noteModel: "grok-2-vision-latest"
      }
    }
  }));

  assert.equal(resolved.provider, "xai");
  assert.equal(resolved.model, "grok-2-vision-latest");
  assert.equal(resolved.temperature, 0.3);
  assert.equal(resolved.maxOutputTokens, 256);
});

test("resolveStreamWatchNoteModelSettings returns null when provider not configured", () => {
  const { manager } = createManager({
    llm: {
      isProviderConfigured() {
        return false;
      }
    }
  });
  const resolved = resolveStreamWatchNoteModelSettings(manager, createSettings({
    voice: {
      streamWatch: {
        noteProvider: "anthropic",
        noteModel: "claude-haiku-4-5"
      }
    }
  }));

  assert.equal(resolved, null);
});

test("resolveStreamWatchNoteModelSettings inherits orchestrator provider when note provider is blank", () => {
  const { manager } = createManager({
    llm: {
      isProviderConfigured(provider) {
        return provider === "claude-oauth";
      }
    }
  });
  const resolved = resolveStreamWatchNoteModelSettings(manager, createSettings({
    llm: {
      provider: "claude-oauth",
      model: "claude-opus-4-6"
    },
    voice: {
      streamWatch: {
        noteProvider: "",
        noteModel: "claude-sonnet-4-6"
      }
    }
  }));

  assert.equal(resolved?.provider, "claude-oauth");
  assert.equal(resolved?.model, "claude-sonnet-4-6");
  assert.equal(resolved?.temperature, 0.3);
  assert.equal(resolved?.maxOutputTokens, 256);
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
  assert.equal(allowedResult.reason, "waiting_for_frame_context");
  assert.equal(allowedResult.frameReady, false);
  assert.equal(allowedResult.reused, false);
  assert.equal(allowedResult.targetUserId, "user-2");
  assert.equal(allowed.manager.sessions.get("guild-1")?.streamWatch?.active, true);
  assert.equal(allowed.actions.some((entry) => entry.kind === "voice_runtime"), true);
});

test("enableWatchStreamForUser subscribes native Discord video and stopWatchStreamForUser clears it", async () => {
  const nativeVideoCalls: Array<Record<string, unknown>> = [];
  const streamDiscovery = createStreamDiscoveryState();
  streamDiscovery.streams.set("guild:guild-1:voice-1:user-2", {
    streamKey: "guild:guild-1:voice-1:user-2",
    userId: "user-2",
    guildId: "guild-1",
    channelId: "voice-1",
    rtcServerId: "9002",
    endpoint: "stream.discord.media:443",
    token: "stream-token",
    discoveredAt: Date.now(),
    credentialsReceivedAt: Date.now()
  });
  const session = createSession({
    streamWatch: {
      active: false,
      targetUserId: null,
      requestedByUserId: null,
      lastFrameAt: 0,
      lastCommentaryAt: 0,
      lastCommentaryNote: null,
      lastNoteAt: 0,
      lastNoteProvider: null,
      lastNoteModel: null,
      noteEntries: [],
      ingestedFrameCount: 0,
      acceptedFrameCountInWindow: 0,
      frameWindowStartedAt: 0,
      latestFrameMimeType: null,
      latestFrameDataBase64: "",
      latestFrameAt: 0
    },
    voxClient: {
      subscribeUserVideo(payload) {
        nativeVideoCalls.push({
          type: "subscribe",
          ...payload
        });
      },
      unsubscribeUserVideo(userId) {
        nativeVideoCalls.push({
          type: "unsubscribe",
          userId
        });
      },
      streamWatchConnect(payload) {
        nativeVideoCalls.push({
          type: "stream_connect",
          ...payload
        });
      },
      streamWatchDisconnect(reason) {
        nativeVideoCalls.push({
          type: "stream_disconnect",
          reason
        });
      },
      getLastVoiceSessionId() {
        return "voice-session-1";
      }
    }
  });
  const { manager } = createManager({ session, streamDiscovery });

  const startResult = await enableWatchStreamForUser(manager, {
    guildId: "guild-1",
    requesterUserId: "user-1",
    targetUserId: "user-2",
    settings: createSettings()
  });
  assert.equal(startResult.ok, true);
  assert.equal(session.nativeScreenShare.subscribedTargetUserId, "user-2");

  const stopResult = await stopWatchStreamForUser(manager, {
    guildId: "guild-1",
    targetUserId: "user-2",
    settings: createSettings({
      voice: {
        streamWatch: {
        }
      }
    }),
    reason: "native_discord_screen_share_ended"
  });
  assert.equal(stopResult.ok, true);
  assert.equal(session.nativeScreenShare.subscribedTargetUserId, null);
  assert.deepEqual(nativeVideoCalls, [
    {
      type: "stream_connect",
      endpoint: "stream.discord.media:443",
      token: "stream-token",
      serverId: "9002",
      sessionId: "voice-session-1",
      userId: "bot-1",
      daveChannelId: "9001"
    },
    {
      type: "subscribe",
      userId: "user-2",
      maxFramesPerSecond: 2,
      preferredQuality: 100,
      preferredPixelCount: 230400,
      preferredStreamType: "screen",
      jpegQuality: 60
    },
    {
      type: "unsubscribe",
      userId: "user-2"
    },
    {
      type: "stream_disconnect",
      reason: "native_discord_screen_share_ended"
    }
  ]);
});

test("enableWatchStreamForUser requests stream watch and connects later when credentials arrive", async () => {
  const transportCalls: Array<Record<string, unknown>> = [];
  const streamDiscovery = createStreamDiscoveryState();
  const session = createSession({
    streamWatch: {
      active: false,
      targetUserId: null,
      requestedByUserId: null,
      lastFrameAt: 0,
      lastCommentaryAt: 0,
      lastCommentaryNote: null,
      lastNoteAt: 0,
      lastNoteProvider: null,
      lastNoteModel: null,
      noteEntries: [],
      ingestedFrameCount: 0,
      acceptedFrameCountInWindow: 0,
      frameWindowStartedAt: 0,
      latestFrameMimeType: null,
      latestFrameDataBase64: "",
      latestFrameAt: 0
    },
    voxClient: {
      subscribeUserVideo() {},
      unsubscribeUserVideo() {},
      streamWatchConnect(payload) {
        transportCalls.push(payload);
      },
      streamWatchDisconnect() {},
      getLastVoiceSessionId() {
        return "voice-session-1";
      }
    }
  });
  const { manager } = createManager({ session, streamDiscovery });

  const startResult = await enableWatchStreamForUser(manager, {
    guildId: "guild-1",
    requesterUserId: "user-1",
    targetUserId: "user-2",
    settings: createSettings(),
    source: "test"
  });

  assert.equal(startResult.ok, true);
  assert.equal(streamDiscovery.watchingStreamKey, "guild:guild-1:voice-1:user-2");
  assert.equal(session.nativeScreenShare.transportStatus, "waiting_for_credentials");
  assert.equal(transportCalls.length, 0);

  const handled = handleDiscoveredStreamCredentialsReceived(manager, {
    stream: {
      streamKey: "guild:guild-1:voice-1:user-2",
      userId: "user-2",
      guildId: "guild-1",
      channelId: "voice-1",
      rtcServerId: "9010",
      endpoint: "stream.discord.media:443",
      token: "stream-token-2",
      discoveredAt: Date.now(),
      credentialsReceivedAt: Date.now()
    }
  });

  assert.equal(handled, true);
  assert.deepEqual(transportCalls, [
    {
      endpoint: "stream.discord.media:443",
      token: "stream-token-2",
      serverId: "9010",
      sessionId: "voice-session-1",
      userId: "bot-1",
      daveChannelId: "9009"
    }
  ]);
  assert.equal(session.nativeScreenShare.transportStatus, "connect_requested");
  assert.equal(session.nativeScreenShare.activeStreamKey, "guild:guild-1:voice-1:user-2");
});

test("enableWatchStreamForUser reuses an active native watch for the same target without resetting frame context", async () => {
  const transportCalls: Array<Record<string, unknown>> = [];
  const now = Date.now();
  const session = createSession({
    streamWatch: {
      active: true,
      targetUserId: "user-2",
      requestedByUserId: "user-1",
      lastFrameAt: now,
      lastCommentaryAt: now - 500,
      lastCommentaryNote: "scoreboard visible",
      lastNoteAt: now - 400,
      lastNoteProvider: "anthropic",
      lastNoteModel: "claude-haiku-4-5",
      noteEntries: [
        {
          text: "scoreboard visible",
          at: now - 400,
          provider: "anthropic",
          model: "claude-haiku-4-5",
          speakerName: "alice"
        }
      ],
      ingestedFrameCount: 3,
      acceptedFrameCountInWindow: 3,
      frameWindowStartedAt: now - 5_000,
      latestFrameMimeType: "image/jpeg",
      latestFrameDataBase64: "AAAA",
      latestFrameAt: now
    },
    nativeScreenShare: {
      sharers: new Map([
        [
          "user-2",
          {
            userId: "user-2",
            codec: "h264",
            updatedAt: now,
            lastFrameAt: now,
            lastFrameCodec: "h264",
            lastFrameKeyframeAt: now,
            audioSsrc: null,
            videoSsrc: 4201,
            streams: [
              {
                ssrc: 4201,
                rtxSsrc: 4202,
                rid: "100",
                quality: 100,
                streamType: "screen",
                active: true,
                maxBitrate: 2_500_000,
                maxFramerate: 30,
                width: 1920,
                height: 1080,
                resolutionType: "fixed",
                pixelCount: 1920 * 1080
              }
            ]
          }
        ]
      ]),
      subscribedTargetUserId: "user-2",
      decodeInFlight: false,
      lastDecodeAttemptAt: now - 250,
      lastDecodeSuccessAt: now - 200,
      lastDecodeFailureAt: 0,
      lastDecodeFailureReason: null,
      ffmpegAvailable: true,
      activeStreamKey: "guild:guild-1:voice-1:user-2",
      lastRtcServerId: "9010",
      lastStreamEndpoint: "stream.discord.media:443",
      lastCredentialsReceivedAt: now - 1_000,
      lastVoiceSessionId: "voice-session-1",
      transportStatus: "ready",
      transportReason: null,
      transportUpdatedAt: now - 200,
      transportConnectedAt: now - 200
    },
    voxClient: {
      subscribeUserVideo() {},
      unsubscribeUserVideo() {},
      streamWatchConnect(payload) {
        transportCalls.push(payload);
      },
      streamWatchDisconnect() {},
      getLastVoiceSessionId() {
        return "voice-session-1";
      }
    }
  });
  const { manager, actions } = createManager({ session });

  const result = await enableWatchStreamForUser(manager, {
    guildId: "guild-1",
    requesterUserId: "user-1",
    targetUserId: "user-2",
    settings: createSettings(),
    source: "test"
  });

  assert.equal(result.ok, true);
  assert.equal(result.reused, true);
  assert.equal(result.frameReady, true);
  assert.equal(result.reason, "frame_context_ready");
  assert.equal(transportCalls.length, 0);
  assert.equal(session.streamWatch.latestFrameDataBase64, "AAAA");
  assert.equal(session.streamWatch.latestFrameMimeType, "image/jpeg");
  assert.equal(session.streamWatch.noteEntries.length, 1);
  assert.equal(session.streamWatch.targetUserId, "user-2");
  const reuseLog = actions.find((entry) => entry.content === "stream_watch_reused_programmatic");
  assert.equal(Boolean(reuseLog), true);
  assert.equal(reuseLog?.metadata?.frameReady, true);
});

test("handleDiscoveredStreamDeleted stops an active native watch", async () => {
  const stopCalls: Array<Record<string, unknown>> = [];
  const session = createSession({
    voxClient: {
      subscribeUserVideo() {},
      unsubscribeUserVideo() {},
      streamWatchConnect() {},
      streamWatchDisconnect(reason) {
        stopCalls.push({ reason });
      },
      getLastVoiceSessionId() {
        return "voice-session-1";
      }
    }
  });
  initializeStreamWatchState({}, {
    session,
    requesterUserId: "user-1",
    targetUserId: "user-2"
  });
  const nativeScreenShare = ensureNativeDiscordScreenShareState(session);
  nativeScreenShare.sharers = new Map([
    [
      "user-2",
      {
        userId: "user-2",
        codec: "h264",
        updatedAt: Date.now(),
        lastFrameAt: Date.now(),
        lastFrameCodec: "h264",
        lastFrameKeyframeAt: Date.now(),
        audioSsrc: null,
        videoSsrc: 4201,
        streams: [
          {
            ssrc: 4201,
            rtxSsrc: 4202,
            rid: "100",
            quality: 100,
            streamType: "screen",
            active: true,
            maxBitrate: 2_500_000,
            maxFramerate: 30,
            width: 1920,
            height: 1080,
            resolutionType: "fixed",
            pixelCount: 1920 * 1080
          }
        ]
      }
    ],
    [
      "user-3",
      {
        userId: "user-3",
        codec: "h264",
        updatedAt: Date.now(),
        lastFrameAt: Date.now(),
        lastFrameCodec: "h264",
        lastFrameKeyframeAt: Date.now(),
        audioSsrc: null,
        videoSsrc: 4301,
        streams: [
          {
            ssrc: 4301,
            rtxSsrc: 4302,
            rid: "100",
            quality: 100,
            streamType: "screen",
            active: true,
            maxBitrate: 2_500_000,
            maxFramerate: 30,
            width: 1920,
            height: 1080,
            resolutionType: "fixed",
            pixelCount: 1920 * 1080
          }
        ]
      }
    ]
  ]);

  const { manager } = createManager({ session });
  const handled = await handleDiscoveredStreamDeleted(manager, {
    stream: {
      streamKey: "guild:guild-1:voice-1:user-2",
      userId: "user-2",
      guildId: "guild-1",
      channelId: "voice-1",
      rtcServerId: "9002",
      endpoint: "stream.discord.media:443",
      token: "stream-token",
      discoveredAt: Date.now(),
      credentialsReceivedAt: Date.now()
    },
    settings: createSettings({
      voice: {
        streamWatch: {
        }
      }
    })
  });

  assert.equal(handled, true);
  assert.equal(session.streamWatch.active, false);
  assert.deepEqual(stopCalls, [{ reason: "native_discord_stream_deleted" }]);
  assert.equal(session.nativeScreenShare.sharers.has("user-2"), false);
  assert.equal(session.nativeScreenShare.sharers.has("user-3"), true);
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
      lastNoteAt: 0,
      lastNoteProvider: null,
      lastNoteModel: null,
      noteEntries: [],
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
  assert.equal(brainReplyCalls[0]?.runtimeEventContext?.category, "screen_share");
  assert.equal(brainReplyCalls[0]?.runtimeEventContext?.eventType, "share_start");
  assert.equal(brainReplyCalls[0]?.runtimeEventContext?.actorUserId, "user-1");
  assert.equal(brainReplyCalls[0]?.runtimeEventContext?.actorDisplayName, "alice");
  assert.equal(brainReplyCalls[0]?.runtimeEventContext?.actorRole, "other");
  assert.equal(brainReplyCalls[0]?.runtimeEventContext?.hasVisibleFrame, true);
  assert.equal(session.streamWatch.lastCommentaryAt > 0, true);
  assert.equal(createdResponses.length, 0);
  const logged = actions.find((entry) => entry.content === "stream_watch_commentary_requested");
  assert.equal(Boolean(logged), true);
  assert.equal(logged?.metadata?.commentaryMode, "brain_turn");
  assert.equal(logged?.metadata?.triggerReason, "share_start");
});

test("maybeTriggerStreamWatchCommentary still uses the voice brain even when a note model is configured", async () => {
  const session = createSession({
    mode: "voice_agent",
    streamWatch: {
      active: true,
      targetUserId: "user-1",
      requestedByUserId: "user-1",
      lastFrameAt: Date.now(),
      lastCommentaryAt: 0,
      lastCommentaryNote: null,
      lastNoteAt: 0,
      lastNoteProvider: null,
      lastNoteModel: null,
      noteEntries: [],
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
        noteProvider: "anthropic",
        noteModel: "claude-haiku-4-5"
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
            urgency: "high"
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
  assert.equal(String(brainReplyCalls[0]?.source || ""), "stream_watch_brain_turn:interval");
  assert.equal(createdResponses.length, 0);
  const logged = actions.find((entry) => entry.content === "stream_watch_commentary_requested");
  assert.equal(Boolean(logged), true);
  assert.equal(logged?.metadata?.commentaryMode, "brain_turn");
  assert.equal(logged?.metadata?.triggerReason, "interval");
});

test("ingestStreamFrame captures a note even when autonomous commentary is disabled", async () => {
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
      lastNoteAt: 0,
      lastNoteProvider: null,
      lastNoteModel: null,
      noteEntries: [],
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
        noteIntervalSeconds: 1,
        maxNoteEntries: 6,
        notePrompt: "Summarize this frame for downstream brain replies."
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

  await ingestStreamFrame(manager, {
    guildId: "guild-1",
    streamerUserId: "user-1",
    mimeType: "image/png",
    dataBase64: "AAAA",
    settings,
    source: "unit_test"
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(createdResponses.length, 0);
  assert.equal(brainReplyCalls.length, 0);
  assert.equal(Array.isArray(session.streamWatch.noteEntries), true);
  assert.equal(session.streamWatch.noteEntries.length, 1);
  assert.equal(
    actions.some((entry) => entry.content === "stream_watch_note_updated"),
    true
  );
  assert.equal(
    actions.some((entry) => entry.content === "stream_watch_commentary_requested"),
    false
  );
});

test("maybeTriggerStreamWatchCommentary triggers early on visual change", async () => {
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
      lastNoteAt: 0,
      lastNoteProvider: null,
      lastNoteModel: null,
      noteEntries: [],
      ingestedFrameCount: 2,
      acceptedFrameCountInWindow: 2,
      frameWindowStartedAt: 0,
      latestFrameMimeType: "image/png",
      latestFrameDataBase64: "AAAA",
      latestFrameAt: now,
      latestChangeScore: 0.02,
      latestEmaChangeScore: 0.02,
      latestIsSceneCut: false
    }
  });
  session.streamWatch.lastCommentaryAt = now - 3_000;
  const { manager, actions, brainReplyCalls, createdResponses } = createManager({ session });

  await maybeTriggerStreamWatchCommentary(manager, {
    session,
    settings: createSettings(),
    streamerUserId: "user-1",
    source: "unit_test"
  });

  assert.equal(brainReplyCalls.length, 1);
  assert.equal(String(brainReplyCalls[0]?.source || ""), "stream_watch_brain_turn:change_detected");
  assert.equal(createdResponses.length, 0);
  assert.equal(actions.some((entry) => entry.content === "stream_watch_commentary_requested"), true);
  const logged = actions.find((entry) => entry.content === "stream_watch_commentary_requested");
  assert.equal(logged?.metadata?.triggerReason, "change_detected");
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
      lastNoteAt: 0,
      lastNoteProvider: "anthropic",
      lastNoteModel: "claude-haiku-4-5",
      noteEntries: [
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
      latestFrameAt: now,
      latestChangeScore: 0.001,
      latestEmaChangeScore: 0.001,
      latestIsSceneCut: false
    }
  });
  session.streamWatch.lastCommentaryAt = now;
  const { manager, actions, brainReplyCalls, createdResponses } = createManager({ session });

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
      lastNoteAt: now - 3_000,
      lastNoteProvider: "anthropic",
      lastNoteModel: "claude-haiku-4-5",
      noteEntries: [
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
            model: "gpt-5.4-nano"
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
  const context = getStreamWatchNotesForPrompt(session, settings);
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

test("maybeTriggerStreamWatchCommentary skips while voice generation is already in flight", async () => {
  const now = Date.now();
  const session = createSession({
    mode: "openai_realtime",
    botTurnOpen: false,
    inFlightAcceptedBrainTurn: {
      transcript: "already saying something",
      userId: "bot-1",
      pcmBuffer: null,
      source: "realtime",
      acceptedAt: now - 100,
      phase: "generation_only",
      captureReason: "stream_end",
      directAddressed: false
    },
    streamWatch: {
      active: true,
      targetUserId: "user-1",
      requestedByUserId: "user-1",
      lastFrameAt: now,
      lastCommentaryAt: 0,
      ingestedFrameCount: 2,
      acceptedFrameCountInWindow: 2,
      frameWindowStartedAt: 0,
      latestFrameMimeType: "image/png",
      latestFrameDataBase64: "AAAA",
      latestFrameAt: now
    }
  });
  const { manager, actions, brainReplyCalls } = createManager({
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
  assert.equal(actions.some((entry) => entry.content === "stream_watch_commentary_requested"), false);
});

test("maybeTriggerStreamWatchCommentary skips while deferred turns are queued", async () => {
  const now = Date.now();
  const session = createSession({
    mode: "openai_realtime",
    botTurnOpen: false,
    streamWatch: {
      active: true,
      targetUserId: "user-1",
      requestedByUserId: "user-1",
      lastFrameAt: now,
      lastCommentaryAt: 0,
      ingestedFrameCount: 2,
      acceptedFrameCountInWindow: 2,
      frameWindowStartedAt: 0,
      latestFrameMimeType: "image/png",
      latestFrameDataBase64: "AAAA",
      latestFrameAt: now
    }
  });
  const { manager, actions, brainReplyCalls } = createManager({
    session,
    deferredQueuedTurns: [{ transcript: "hold that thought", queuedAt: now - 100 }],
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
  assert.equal(actions.some((entry) => entry.content === "stream_watch_commentary_requested"), false);
});

test("appendStreamWatchNoteEntry queues evicted notes for compaction", () => {
  const session = createSession({
    pendingCompactionNotes: [],
    streamWatch: {
      active: true,
      targetUserId: "user-1",
      requestedByUserId: "user-1",
      lastFrameAt: 0,
      lastCommentaryAt: 0,
      lastCommentaryNote: null,
      lastNoteAt: 0,
      lastNoteProvider: "anthropic",
      lastNoteModel: "claude-haiku-4-5",
      noteEntries: [
        { text: "menu open", at: 1000, provider: "anthropic", model: "claude-haiku-4-5", speakerName: "alice" },
        { text: "queue popped", at: 2000, provider: "anthropic", model: "claude-haiku-4-5", speakerName: "alice" }
      ],
      ingestedFrameCount: 0,
      acceptedFrameCountInWindow: 0,
      frameWindowStartedAt: 0,
      latestFrameMimeType: null,
      latestFrameDataBase64: "",
      latestFrameAt: 0
    }
  });

  appendStreamWatchNoteEntry({
    session,
    text: "match started",
    at: 3000,
    provider: "anthropic",
    model: "claude-haiku-4-5",
    speakerName: "alice",
    maxEntries: 2
  });

  assert.deepEqual(
    session.streamWatch.noteEntries.map((entry) => entry.text),
    ["queue popped", "match started"]
  );
  assert.deepEqual(session.pendingCompactionNotes, ["alice: menu open"]);
});
