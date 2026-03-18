import { test } from "bun:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChatInputCommandInteraction } from "discord.js";
import { ActiveReplyRegistry, buildVoiceReplyScopeKey } from "../tools/activeReplyRegistry.ts";
import { createAbortError } from "../tools/browserTaskRuntime.ts";
import type { CaptureManager } from "./captureManager.ts";
import { VoiceSessionManager } from "./voiceSessionManager.ts";
import { createTestSettings as createCanonicalTestSettings, normalizeLegacyTestSettingsInput } from "../testSettings.ts";
import { deepMerge } from "../utils.ts";
import {
  ACTIVITY_TOUCH_MIN_SPEECH_MS,
  BARGE_IN_BOT_AUDIO_ECHO_GUARD_MS,
  BARGE_IN_MIN_SPEECH_MS,
  BARGE_IN_SUPPRESSION_MAX_MS,
  REALTIME_ASSISTANT_TTS_BACKPRESSURE_PAUSE_SAMPLES,
  REALTIME_ASSISTANT_TTS_BACKPRESSURE_RESUME_SAMPLES,
  VOICE_INTERRUPT_SPEECH_START_RECHECK_MS,
  VOICE_SILENCE_GATE_MIN_CLIP_MS,
  VOICE_TURN_PROMOTION_MIN_CLIP_MS
} from "./voiceSessionManager.constants.ts";
import {
  beginAsrUtterance,
  commitAsrUtterance,
  getOrCreatePerUserAsrState,
  getOrCreateSharedAsrState,
  trackSharedAsrCommittedItem,
  tryHandoffSharedAsr
} from "./voiceAsrBridge.ts";
import { ensureNativeDiscordScreenShareState } from "./nativeDiscordScreenShare.ts";
import type { AsrBridgeState } from "./voiceAsrBridge.ts";
import type { CaptureState, VoiceSession } from "./voiceSessionTypes.ts";

// Discord sends 48kHz stereo 16-bit PCM in 20ms frames = 3840 bytes
const DISCORD_PCM_FRAME_BYTES = 3840;
const LEGACY_TOP_LEVEL_KEYS = ["botName", "botNameAliases", "llm"] as const;
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
  "streamingMinSentencesPerChunk",
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

  for (const key of LEGACY_TOP_LEVEL_KEYS) {
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

function makeMonoPcm16(sampleCount: number, amplitude: number) {
  const pcm = Buffer.alloc(sampleCount * 2);
  for (let i = 0; i < sampleCount; i += 1) {
    pcm.writeInt16LE(amplitude, i * 2);
  }
  return pcm;
}

function makeSparseMonoPcm16(sampleCount: number, amplitude: number, activeEverySamples: number) {
  const pcm = Buffer.alloc(sampleCount * 2);
  const stride = Math.max(1, activeEverySamples);
  for (let i = 0; i < sampleCount; i += 1) {
    const sample = i % stride === 0 ? amplitude : 0;
    pcm.writeInt16LE(sample, i * 2);
  }
  return pcm;
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

function recordCommittedInterruptDecision(session: VoiceSession, utteranceId: number, source = "test_interrupt") {
  session.interruptDecisionsByUtteranceId = new Map([
    [
      utteranceId,
      {
        transcript: "",
        decision: "interrupt",
        decidedAt: Date.now(),
        source,
        burstId: 1
      }
    ]
  ]);
}

function seedReadyPerUserAsr(
  manager: VoiceSessionManager,
  session: ReturnType<typeof createSession>,
  userId: string
) {
  const appendedChunks: Buffer[] = [];
  const asrState = getOrCreatePerUserAsrState(session, userId);
  assert.ok(asrState);
  asrState.phase = "ready";
  asrState.client = {
    ws: { readyState: 1 },
    clearInputAudioBuffer() {},
    appendInputAudioPcm(chunk: Buffer) {
      appendedChunks.push(chunk);
    },
    commitInputAudioBuffer() {}
  };
  return {
    asrState,
    appendedChunks,
    deps: manager.buildAsrBridgeDeps(session)
  };
}

function runSharedAsrHandoff(
  manager: VoiceSessionManager,
  session: ReturnType<typeof createSession>,
  beginCalls: Array<{ userId: string }>,
  appendCalls: Array<{ userId: string; pcmChunk: Buffer }>
) {
  return tryHandoffSharedAsr({
    session,
    asrState: session.openAiSharedAsrState as AsrBridgeState | null,
    deps: manager.buildAsrBridgeDeps(session),
    settings: session.settingsSnapshot,
    beginUtterance: (userId) => {
      beginCalls.push({ userId });
      return true;
    },
    appendAudio: (userId, pcmChunk) => {
      appendCalls.push({ userId, pcmChunk });
      return true;
    },
    releaseUser: () => {}
  });
}

function createManager() {
  const messages = [];
  const endCalls = [];
  const touchCalls = [];
  const offCalls = [];
  const logs = [];

  const client = {
    on() {},
    off(eventName) {
      offCalls.push(eventName);
    },
    channels: {
      async fetch(channelId) {
        return {
          id: channelId,
          async send() {
            return true;
          }
        };
      }
    },
    guilds: { cache: new Map() },
    users: { cache: new Map() },
    user: { id: "bot-user", username: "clanky" }
  };

  const manager = new VoiceSessionManager({
    client,
    store: {
      logAction(entry) {
        logs.push(entry);
      },
      getSettings() {
        return createTestSettings({
          botName: "clanky",
          voice: {
            replyPath: "brain"
          }
        });
      }
    },
    appConfig: {
      openaiApiKey: "test-openai-key"
    },
    llm: {
      isAsrReady() {
        return true;
      },
      isSpeechSynthesisReady() {
        return true;
      },
      async generate() {
        return {
          text: "NO"
        };
      }
    },
    memory: null
  });

  manager.composeOperationalMessage = async (payload) => {
    messages.push(payload);
    return "ok";
  };
  manager.endSession = async (payload) => {
    endCalls.push(payload);
  };
  manager.touchActivity = (guildId, settings) => {
    touchCalls.push({ guildId, settings });
  };

  return {
    manager,
    messages,
    endCalls,
    touchCalls,
    offCalls,
    logs
  };
}

function createMessage(overrides = {}) {
  return {
    guild: {
      id: "guild-1"
    },
    channel: {
      id: "text-1",
      async send() {
        return true;
      }
    },
    channelId: "text-1",
    author: {
      id: "user-1"
    },
    id: "msg-1",
    ...overrides
  };
}

function createSession(overrides = {}) {
  const now = Date.now();
  const session = {
    id: "session-1",
    guildId: "guild-1",
    voiceChannelId: "voice-1",
    textChannelId: "text-1",
    startedAt: now - 60_000,
    lastActivityAt: now - 2_000,
    maxEndsAt: now + 120_000,
    inactivityEndsAt: now + 45_000,
    userCaptures: new Map(),
    soundboard: {
      playCount: 0,
      lastPlayedAt: 0
    },
    mode: "openai_realtime",
    streamWatch: {
      active: false,
      targetUserId: null,
      requestedByUserId: null,
      lastFrameAt: 0,
      lastCommentaryAt: 0,
      ingestedFrameCount: 0
    },
    music: {
      phase: "idle",
      active: false,
      ducked: false,
      pauseReason: null,
      startedAt: 0,
      stoppedAt: 0,
      provider: null,
      source: null,
      lastTrackId: null,
      lastTrackTitle: null,
      lastTrackArtists: [],
      lastTrackUrl: null,
      lastQuery: null,
      lastRequestedByUserId: null,
      lastRequestText: null,
      lastCommandAt: 0,
      lastCommandReason: null,
      pendingQuery: null,
      pendingPlatform: "auto",
      pendingResults: [],
      pendingRequestedByUserId: null,
      pendingRequestedAt: 0
    },
    assistantOutput: {
      phase: "idle",
      reason: "idle",
      phaseEnteredAt: now,
      lastSyncedAt: now,
      requestId: null,
      ttsPlaybackState: "idle",
      ttsBufferedSamples: 0,
      lastTrigger: "test_seed"
    },
    botTurnOpen: false,
    botTurnOpenAt: 0,
    lastResponseRequestAt: 0,
    lastAudioDeltaAt: 0,
    pendingResponse: null,
    awaitingToolOutputs: false,
    realtimeToolCallExecutions: new Map(),
    voxClient: null,
    pendingFileAsrTurns: 0,
    recentVoiceTurns: [],
    membershipEvents: [],
    cleanupHandlers: [],
    realtimeProvider: null,
    realtimeInputSampleRateHz: 24000,
    realtimeOutputSampleRateHz: 24000,
    realtimeClient: null,
    activeReplyInterruptionPolicy: null,
    deferredVoiceActions: {},
    deferredVoiceActionTimers: {},
    lastRequestedRealtimeUtterance: null,
    pendingRealtimeAssistantUtterances: [],
    realtimeAssistantUtteranceBackpressureActive: false,
    settingsSnapshot: createTestSettings({
      botName: "clanky",
      voice: {
        enabled: true,
        replyPath: "brain"
      }
    }),
    ...overrides
  };
  session.settingsSnapshot = createTestSettings(session.settingsSnapshot || {});
  return session;
}

function createAssertiveCaptureState(
  userId: string,
  overrides: Partial<CaptureState> = {}
): CaptureState {
  const sampleCount = 24_000;
  const activeSampleCount = 2_000;
  const peakAbs = 6_000;
  return {
    userId,
    startedAt: Date.now() - 1_200,
    promotedAt: Date.now() - 800,
    bytesSent: 48_000,
    signalSampleCount: sampleCount,
    signalActiveSampleCount: activeSampleCount,
    signalPeakAbs: peakAbs,
    signalSumSquares: sampleCount * peakAbs * peakAbs,
    speakingEndFinalizeTimer: null,
    ...overrides
  } as CaptureState;
}

function createClankSlashInteraction({
  subcommand = "say",
  subcommandGroup = null,
  message = "",
  query = ""
}: {
  subcommand?: string;
  subcommandGroup?: string | null;
  message?: string;
  query?: string;
} = {}) {
  const replies: string[] = [];
  const edits: string[] = [];
  let deferred = false;

  const interaction = {
    commandName: "clank",
    guild: { id: "guild-1" },
    channel: { id: "text-1" },
    channelId: "text-1",
    user: { id: "user-1" },
    options: {
      getSubcommandGroup(required?: boolean) {
        if (subcommandGroup) return subcommandGroup;
        if (required) throw new Error("missing subcommand group");
        return null;
      },
      getSubcommand(required?: boolean) {
        if (subcommand) return subcommand;
        if (required) throw new Error("missing subcommand");
        return null;
      },
      getString(name: string, required?: boolean) {
        if (name === "message") {
          if (message) return message;
          if (required) throw new Error("missing message");
          return null;
        }
        if (name === "query") {
          if (query) return query;
          if (required) throw new Error("missing query");
          return null;
        }
        return null;
      }
    },
    async reply(payload: string | { content?: string }) {
      replies.push(typeof payload === "string" ? payload : String(payload.content || ""));
      return null;
    },
    async deferReply() {
      deferred = true;
      return null;
    },
    async editReply(payload: string | { content?: string }) {
      edits.push(typeof payload === "string" ? payload : String(payload.content || ""));
      return null;
    }
  };

  return {
    interaction,
    replies,
    edits,
    get deferred() {
      return deferred;
    }
  };
}

test("getRuntimeState summarizes file ASR backlog alongside realtime sessions", () => {
  const { manager } = createManager();
  const now = Date.now();
  manager.client.users.cache.set("user-a", {
    id: "user-a",
    username: "alice"
  });

  manager.sessions.set(
    "guild-1",
    createSession({
      id: "stt-session",
      mode: "openai_realtime",
      realtimeProvider: "openai",
      pendingFileAsrTurns: 2,
      recentVoiceTurns: [{ role: "user", text: "hello" }],
      userCaptures: new Map([["user-a", {}]])
    })
  );
  manager.sessions.set(
    "guild-2",
    createSession({
      id: "realtime-session",
      guildId: "guild-2",
      voiceChannelId: "voice-2",
      textChannelId: "text-2",
      mode: "openai_realtime",
      streamWatch: {
        active: true,
        targetUserId: "user-z",
        requestedByUserId: "user-mod",
        lastFrameAt: now - 2_000,
        lastCommentaryAt: now - 4_000,
        lastCommentaryNote: "wild clutch moment on screen",
        lastMemoryRecapAt: now - 1_000,
        lastMemoryRecapText: "Streamer recently screen-shared a combat HUD and minimap pressure.",
        lastMemoryRecapDurableSaved: true,
        lastMemoryRecapReason: "share_page_stop",
        latestFrameAt: now - 2_000,
        latestFrameMimeType: "image/png",
        latestFrameDataBase64: "AAAAAA==",
        frameWindowStartedAt: now - 15_000,
        acceptedFrameCountInWindow: 5,
        lastNoteAt: now - 3_000,
        lastNoteProvider: "anthropic",
        lastNoteModel: "claude-vision",
        noteEntries: [
          {
            text: "enemy near top left minimap",
            at: now - 3_000,
            provider: "anthropic",
            model: "claude-vision",
            speakerName: "streamer"
          }
        ],
        ingestedFrameCount: 8
      },
      realtimeProvider: "openai",
      realtimeClient: {
        getState() {
          return { connected: true };
        }
      },
      recentVoiceTurns: [{ role: "user", text: "yo" }]
    })
  );

  const runtime = manager.getRuntimeState();
  assert.equal(runtime.activeCount, 2);

  const stt = runtime.sessions.find((row) => row.sessionId === "stt-session");
  assert.equal(stt?.batchAsr?.pendingTurns, 2);
  assert.equal(stt?.realtime?.provider, "openai");
  assert.equal(stt?.activeCaptures?.length, 1);
  assert.equal(stt?.activeCaptures?.[0]?.userId, "user-a");
  assert.equal(stt?.activeCaptures?.[0]?.displayName, "alice");

  const realtime = runtime.sessions.find((row) => row.sessionId === "realtime-session");
  assert.equal(realtime?.realtime?.provider, "openai");
  assert.equal(realtime?.realtime?.replySuperseded, 0);
  assert.deepEqual(realtime?.realtime?.state, { connected: true });
  assert.equal(realtime?.streamWatch?.latestFrameMimeType, "image/png");
  assert.equal(realtime?.streamWatch?.acceptedFrameCountInWindow, 5);
  assert.equal(realtime?.streamWatch?.noteCount, 1);
  assert.equal(realtime?.streamWatch?.lastCommentaryNote, "wild clutch moment on screen");
  assert.equal(realtime?.streamWatch?.lastMemoryRecapText, "Streamer recently screen-shared a combat HUD and minimap pressure.");
  assert.equal(realtime?.streamWatch?.lastMemoryRecapDurableSaved, true);
  assert.equal(realtime?.streamWatch?.lastMemoryRecapReason, "share_page_stop");
  assert.equal(realtime?.streamWatch?.visualFeed?.length, 1);
  assert.equal(realtime?.streamWatch?.visualFeed?.[0]?.text, "enemy near top left minimap");
  assert.equal(realtime?.streamWatch?.notePayload?.notes?.length, 1);
});

test("resolveSpeakingEndFinalizeDelayMs preserves baseline delays in low-load rooms", () => {
  const { manager } = createManager();
  const session = createSession({
    userCaptures: new Map([["speaker-1", {}]]),
    pendingFileAsrTurns: 0
  });

  assert.equal(
    manager.resolveSpeakingEndFinalizeDelayMs({
      session,
      captureAgeMs: 120
    }),
    420
  );
  assert.equal(
    manager.resolveSpeakingEndFinalizeDelayMs({
      session,
      captureAgeMs: 600
    }),
    220
  );
  assert.equal(
    manager.resolveSpeakingEndFinalizeDelayMs({
      session,
      captureAgeMs: 1200
    }),
    800
  );
});

test("resolveSpeakingEndFinalizeDelayMs adapts delays when room load increases", () => {
  const { manager } = createManager();

  const busyRealtimeSession = createSession({
    mode: "openai_realtime",
    userCaptures: new Map([
      ["speaker-1", {}],
      ["speaker-2", {}]
    ]),
    realtimeTurnDrainActive: true,
    pendingRealtimeTurns: [{ userId: "speaker-3" }]
  });
  assert.equal(
    manager.resolveSpeakingEndFinalizeDelayMs({
      session: busyRealtimeSession,
      captureAgeMs: 500
    }),
    154
  );

  const heavySttSession = createSession({
    mode: "openai_realtime",
    userCaptures: new Map([["speaker-1", {}]]),
    pendingFileAsrTurns: 4
  });
  assert.equal(
    manager.resolveSpeakingEndFinalizeDelayMs({
      session: heavySttSession,
      captureAgeMs: 150
    }),
    210
  );
  assert.equal(
    manager.resolveSpeakingEndFinalizeDelayMs({
      session: heavySttSession,
      captureAgeMs: 1400
    }),
    400
  );
});

test("shouldBargeIn requires sustained capture bytes", () => {
  const { manager } = createManager();
  const captureState = {
    bytesSent: 4_000,
    startedAt: Date.now() - 2_000,
    speakingEndFinalizeTimer: null,
    signalSampleCount: 24_000,
    signalActiveSampleCount: 1_680,
    signalPeakAbs: 5_400
  };
  const session = createSession({
    mode: "openai_realtime",
    botTurnOpen: true,
    userCaptures: new Map([["user-1", captureState]])
  });

  const result = manager.bargeInController.shouldBargeIn({ session, userId: "user-1", captureState });
  assert.equal(result.allowed, false);
});

test("shouldBargeIn ignores non-target speaker under assertive reply policy", () => {
  const { manager } = createManager();
  const minBytes = Math.ceil((24_000 * 2 * BARGE_IN_MIN_SPEECH_MS) / 1000);
  const captureState = {
    bytesSent: minBytes + 2_400,
    startedAt: Date.now() - 2_000,
    signalSampleCount: 24_000,
    signalActiveSampleCount: 1_680,
    signalPeakAbs: 5_400,
    speakingEndFinalizeTimer: null
  };
  const session = createSession({
    mode: "openai_realtime",
    botTurnOpen: true,
    activeReplyInterruptionPolicy: {
      assertive: true,
      scope: "speaker",
      allowedUserId: "user-1",
      reason: "engaged_continuation",
      source: "test"
    },
    userCaptures: new Map([["user-2", captureState]])
  });

  const result = manager.bargeInController.shouldBargeIn({ session, userId: "user-2", captureState });
  assert.equal(result.allowed, false);
});

test("shouldBargeIn blocks all interruptions when reply targets ALL", () => {
  const { manager } = createManager();
  const minBytes = Math.ceil((24_000 * 2 * BARGE_IN_MIN_SPEECH_MS) / 1000);
  const captureState = {
    bytesSent: minBytes + 2_400,
    startedAt: Date.now() - 2_000,
    signalSampleCount: 24_000,
    signalActiveSampleCount: 1_680,
    signalPeakAbs: 5_400,
    speakingEndFinalizeTimer: null
  };
  const session = createSession({
    mode: "openai_realtime",
    botTurnOpen: true,
    activeReplyInterruptionPolicy: {
      assertive: true,
      scope: "none",
      allowedUserId: null,
      talkingTo: "ALL",
      reason: "assistant_target_all",
      source: "test"
    },
    userCaptures: new Map([["user-1", captureState]])
  });

  const result = manager.bargeInController.shouldBargeIn({ session, userId: "user-1", captureState });
  assert.equal(result.allowed, false);
});

test("resolveReplyInterruptionPolicy applies speaker fallback for normal replies when configured", () => {
  const { manager } = createManager();
  const session = createSession({
    settingsSnapshot: createTestSettings({
      botName: "clanky",
      voice: {
        replyPath: "brain",
        defaultInterruptionMode: "speaker"
      }
    })
  });

  const result = manager.resolveReplyInterruptionPolicy({
    session,
    userId: "user-1",
  });

  assert.deepEqual(result, {
    assertive: true,
    scope: "speaker",
    allowedUserId: "user-1",
  });
});

test("resolveReplyInterruptionPolicy uses the repo default speaker mode when unset", () => {
  const { manager } = createManager();
  const session = createSession({
    settingsSnapshot: createTestSettings({
      botName: "clanky",
      voice: {
        replyPath: "brain"
      }
    })
  });

  const result = manager.resolveReplyInterruptionPolicy({
    session,
    userId: "user-1",
  });

  assert.deepEqual(result, {
    assertive: true,
    scope: "speaker",
    allowedUserId: "user-1",
  });
});

test("resolveReplyInterruptionPolicy keeps explicit anyone mode interruptible", () => {
  const { manager } = createManager();
  const session = createSession({
    settingsSnapshot: createTestSettings({
      botName: "clanky",
      voice: {
        replyPath: "brain",
        defaultInterruptionMode: "anyone"
      }
    })
  });

  const result = manager.resolveReplyInterruptionPolicy({
    session,
    userId: null,
  });

  assert.deepEqual(result, {
    assertive: true,
    scope: "anyone",
    allowedUserId: null,
  });
});

test("resolveReplyInterruptionPolicy routes speaker mode to the named assistant target", () => {
  const { manager } = createManager();
  manager.getVoiceChannelParticipants = () => [
    { userId: "speaker-1", displayName: "alice" },
    { userId: "speaker-2", displayName: "bob" }
  ];
  const session = createSession({
    settingsSnapshot: createTestSettings({
      botName: "clanky",
      voice: {
        replyPath: "brain",
        defaultInterruptionMode: "speaker"
      }
    })
  });

  const result = manager.resolveReplyInterruptionPolicy({
    session,
    userId: "speaker-1",
    talkingTo: "bob",
    source: "assistant_reply_target",
    reason: "assistant_target_speaker"
  });

  assert.deepEqual(result, {
    assertive: true,
    scope: "speaker",
    allowedUserId: "speaker-2",
    talkingTo: "bob",
    source: "assistant_reply_target",
    reason: "assistant_target_speaker"
  });
});

test("resolveReplyInterruptionPolicy closes ordinary talk-over for ALL-target speaker replies", () => {
  const { manager } = createManager();
  const session = createSession({
    settingsSnapshot: createTestSettings({
      botName: "clanky",
      voice: {
        replyPath: "brain",
        defaultInterruptionMode: "speaker"
      }
    })
  });

  const result = manager.resolveReplyInterruptionPolicy({
    session,
    userId: "speaker-1",
    talkingTo: "ALL",
    source: "assistant_reply_target",
    reason: "assistant_target_all"
  });

  assert.deepEqual(result, {
    assertive: true,
    scope: "none",
    allowedUserId: null,
    talkingTo: "ALL",
    source: "assistant_reply_target",
    reason: "assistant_target_all"
  });
});

test("resolveReplyInterruptionPolicy keeps speaker mode closed when an assistant reply target is missing", () => {
  const { manager } = createManager();
  const session = createSession({
    settingsSnapshot: createTestSettings({
      botName: "clanky",
      voice: {
        replyPath: "brain",
        defaultInterruptionMode: "speaker"
      }
    })
  });

  const result = manager.resolveReplyInterruptionPolicy({
    session,
    userId: "speaker-1",
    source: "assistant_reply_target",
    reason: "assistant_target_missing"
  });

  assert.deepEqual(result, {
    assertive: true,
    scope: "none",
    allowedUserId: null,
    source: "assistant_reply_target",
    reason: "assistant_target_missing"
  });
});

test("isUserAllowedToInterruptReply blocks when no interruption policy resolves", () => {
  const { manager } = createManager();

  const result = manager.isUserAllowedToInterruptReply({
    policy: null,
    userId: "user-1"
  });

  assert.equal(result, false);
});

test("createTrackedAudioResponse applies uninterruptible fallback for normal replies when configured", () => {
  const { manager } = createManager();
  const session = createSession({
    mode: "openai_realtime",
    settingsSnapshot: createTestSettings({
      botName: "clanky",
      voice: {
        replyPath: "brain",
        defaultInterruptionMode: "none"
      }
    })
  });

  const created = manager.replyManager.createTrackedAudioResponse({
    session,
    userId: "user-1",
    source: "test_default_uninterruptible",
    emitCreateEvent: false
  });

  assert.equal(created, true);
  assert.deepEqual(session.pendingResponse?.interruptionPolicy, {
    assertive: true,
    scope: "none",
    allowedUserId: null,
  });
});

test("shouldBargeIn allows barge-in after assertive speech", () => {
  const { manager } = createManager();
  const minBytes = Math.ceil((24_000 * 2 * BARGE_IN_MIN_SPEECH_MS) / 1000);
  const captureState = {
    bytesSent: minBytes + 2_400,
    startedAt: Date.now() - 2_000,
    signalSampleCount: 24_000,
    signalActiveSampleCount: 1_680,
    signalPeakAbs: 5_400,
    speakingEndFinalizeTimer: null
  };
  const session = createSession({
    mode: "openai_realtime",
    botTurnOpen: true,
    pendingResponse: {
      requestId: 9,
      requestedAt: Date.now() - 1200,
      retryCount: 0,
      hardRecoveryAttempted: false,
      source: "turn_flush",
      handlingSilence: false,
      audioReceivedAt: 0,
      interruptionPolicy: {
        assertive: true,
        scope: "speaker",
        allowedUserId: "user-1"
      }
    },
    userCaptures: new Map([["user-1", captureState]])
  });

  const result = manager.bargeInController.shouldBargeIn({ session, userId: "user-1", captureState });
  assert.equal(result.allowed, true);
  assert.equal(typeof result.minCaptureBytes, "number");
  assert.ok(result.minCaptureBytes > 0);
});

test("shouldDirectAddressedTurnInterruptReply keeps wake-word override for speaker-mode ALL-target replies", () => {
  const { manager } = createManager();
  const session = createSession({
    settingsSnapshot: createTestSettings({
      botName: "clanky",
      voice: {
        replyPath: "brain",
        defaultInterruptionMode: "speaker"
      }
    }),
    pendingResponse: {
      requestId: 17,
      userId: "speaker-1",
      requestedAt: Date.now() - 200,
      retryCount: 0,
      hardRecoveryAttempted: false,
      source: "voice_reply",
      handlingSilence: false,
      audioReceivedAt: 0,
      interruptionPolicy: {
        assertive: true,
        scope: "none",
        allowedUserId: null,
        talkingTo: "ALL",
        source: "assistant_reply_target",
        reason: "assistant_target_all"
      },
      utteranceText: "listen up everyone",
      latencyContext: null
    }
  });

  const result = manager.shouldDirectAddressedTurnInterruptReply({
    session,
    directAddressed: true
  });

  assert.equal(result, true);
});

test("shouldBargeIn ignores near-silent captures", () => {
  const { manager } = createManager();
  const minBytes = Math.ceil((24_000 * 2 * BARGE_IN_MIN_SPEECH_MS) / 1000);
  const captureState = {
    bytesSent: minBytes + 2_400,
    startedAt: Date.now() - 2_000,
    signalSampleCount: 24_000,
    signalActiveSampleCount: 120,
    signalPeakAbs: 220,
    speakingEndFinalizeTimer: null
  };
  const session = createSession({
    botTurnOpen: true,
    userCaptures: new Map([["user-1", captureState]])
  });

  const result = manager.bargeInController.shouldBargeIn({ session, userId: "user-1", captureState });
  assert.equal(result.allowed, false);
});

test("shouldBargeIn does not interrupt music-only playback lock", () => {
  const { manager } = createManager();
  const minBytes = Math.ceil((24_000 * 2 * BARGE_IN_MIN_SPEECH_MS) / 1000);
  const captureState = {
    bytesSent: minBytes + 2_400,
    startedAt: Date.now() - 2_000,
    signalSampleCount: 24_000,
    signalActiveSampleCount: 1_680,
    signalPeakAbs: 5_400,
    speakingEndFinalizeTimer: null
  };
  const session = createSession({
    mode: "openai_realtime",
    playerState: "playing",
    music: {
      phase: "playing",
      active: true,
      ducked: false,
      pauseReason: null,
      startedAt: Date.now() - 5_000,
      stoppedAt: 0,
      provider: "discord",
      source: "voice_tool_call",
      lastTrackId: "youtube:test",
      lastTrackTitle: "test track",
      lastTrackArtists: ["artist"],
      lastTrackUrl: "https://example.com",
      lastQuery: "test track",
      lastRequestedByUserId: "user-1",
      lastRequestText: "play test track",
      lastCommandAt: Date.now() - 5_000,
      lastCommandReason: "voice_tool_music_play",
      pendingQuery: null,
      pendingPlatform: "auto",
      pendingResults: [],
      pendingRequestedByUserId: null,
      pendingRequestedAt: 0
    },
    userCaptures: new Map([["user-1", captureState]])
  });

  const result = manager.bargeInController.shouldBargeIn({ session, userId: "user-1", captureState });
  assert.equal(result.allowed, false);
});

test("shouldBargeIn allows buffered subprocess playback interruption for the reply target", () => {
  const { manager } = createManager();
  const minBytes = Math.ceil((24_000 * 2 * BARGE_IN_MIN_SPEECH_MS) / 1000);
  const captureState = {
    bytesSent: minBytes + 2_400,
    startedAt: Date.now() - 2_000,
    signalSampleCount: 24_000,
    signalActiveSampleCount: 1_680,
    signalPeakAbs: 5_400,
    speakingEndFinalizeTimer: null
  };
  const session = createSession({
    mode: "openai_realtime",
    botTurnOpen: false,
    lastAudioDeltaAt: Date.now() - 2_000,
    pendingResponse: {
      requestId: 22,
      requestedAt: Date.now() - 500,
      retryCount: 0,
      hardRecoveryAttempted: false,
      source: "turn_flush",
      handlingSilence: false,
      audioReceivedAt: Date.now() - 200,
      interruptionPolicy: {
        assertive: true,
        scope: "speaker",
        allowedUserId: "user-1"
      }
    },
    voxClient: {
      ttsBufferDepthSamples: 48_000
    },
    userCaptures: new Map([["user-1", captureState]])
  });

  const result = manager.bargeInController.shouldBargeIn({ session, userId: "user-1", captureState });
  assert.equal(result.allowed, true);
});

test("shouldBargeIn requires minimum capture age for non-realtime playback", () => {
  const { manager } = createManager();
  const minBytes = Math.ceil((24_000 * 2 * BARGE_IN_MIN_SPEECH_MS) / 1000);
  const captureState = {
    bytesSent: minBytes + 2_400,
    startedAt: Date.now() - 100,
    signalSampleCount: 24_000,
    signalActiveSampleCount: 1_680,
    signalPeakAbs: 5_400,
    speakingEndFinalizeTimer: null
  };
  const session = createSession({
    mode: "offline",
    botTurnOpen: true,
    pendingResponse: {
      requestId: 30,
      requestedAt: Date.now() - 200,
      retryCount: 0,
      hardRecoveryAttempted: false,
      source: "turn_flush",
      handlingSilence: false,
      audioReceivedAt: 0
    },
    userCaptures: new Map([["user-1", captureState]])
  });

  const result = manager.bargeInController.shouldBargeIn({ session, userId: "user-1", captureState });
  assert.equal(result.allowed, false);
});

test("interruptBotSpeechForBargeIn truncates OpenAI assistant audio to played duration", () => {
  const { manager, logs } = createManager();
  const truncateCalls = [];
  let stopPlaybackCalls = 0;
  let clearTelemetryCalls = 0;
  const startedAt = Date.now();
  const voxClient = {
    ttsBufferDepthSamples: 24_000,
    stopPlayback() {
      stopPlaybackCalls += 1;
    },
    clearTtsPlaybackTelemetry() {
      clearTelemetryCalls += 1;
      voxClient.ttsBufferDepthSamples = 0;
    },
    getTtsPlaybackState() {
      return voxClient.ttsBufferDepthSamples > 0 ? "buffered" : "idle";
    }
  };
  const session = createSession({
    mode: "openai_realtime",
    botTurnOpen: true,
    pendingResponse: {
      requestId: 12,
      utteranceText: "continuation"
    },
    pendingRealtimeAssistantUtterances: [
      {
        prompt: "chunk one",
        utteranceText: "chunk one",
        userId: "bot-user",
        source: "realtime:stream_chunk_2",
        queuedAt: Date.now(),
        interruptionPolicy: null,
        latencyContext: null
      }
    ],
    lastRealtimeAssistantAudioItemId: "item_abc",
    lastRealtimeAssistantAudioItemContentIndex: 0,
    lastRealtimeAssistantAudioItemReceivedMs: 2000,
    realtimeClient: {
      cancelActiveResponse() {
        return true;
      },
      truncateConversationItem(payload) {
        truncateCalls.push(payload);
        return true;
      }
    },
    voxClient
  });

  const interrupted = manager.interruptBotSpeechForBargeIn({
    session,
    userId: "user-1",
    source: "truncate_test"
  });

  assert.equal(interrupted, true);
  assert.equal(truncateCalls.length, 1);
  assert.equal(truncateCalls[0]?.itemId, "item_abc");
  assert.equal(truncateCalls[0]?.contentIndex, 0);
  assert.equal(truncateCalls[0]?.audioEndMs, 1500);
  const interruptLog = logs.find((entry) => entry?.content === "voice_barge_in_interrupt");
  assert.equal(Boolean(interruptLog), true);
  assert.equal(interruptLog?.metadata?.truncateAttempted, true);
  assert.equal(interruptLog?.metadata?.truncateSucceeded, true);
  assert.equal(interruptLog?.metadata?.storedInterruptionContext, true);
  assert.equal(session.interruptedAssistantReply?.utteranceText, "continuation");
  assert.equal(session.interruptedAssistantReply?.interruptedByUserId, "user-1");
  assert.equal(session.interruptedAssistantReply?.source, "truncate_test");
  assert.equal(session.pendingRealtimeAssistantUtterances?.length || 0, 0);
  assert.equal(stopPlaybackCalls, 1);
  assert.equal(clearTelemetryCalls, 1);
  assert.equal(voxClient.ttsBufferDepthSamples, 0);
  assert.ok(Number(session.interruptedAssistantReply?.interruptedAt || 0) >= startedAt);
  const suppressionMs = Number(session.bargeInSuppressionUntil || 0) - startedAt;
  assert.ok(suppressionMs >= 0);
  assert.ok(suppressionMs <= BARGE_IN_SUPPRESSION_MAX_MS + 50);
  assert.equal(
    logs.some((entry) => entry?.content === "realtime_assistant_utterance_queue_cleared"),
    true
  );

  const conversationContext = manager.buildVoiceConversationContext({
    session,
    userId: "user-1",
    directAddressed: true
  });
  assert.equal(conversationContext.interruptedAssistantReply?.utteranceText, "continuation");
});

test("interruptBotSpeechForBargeIn stores recovery context when truncate succeeds but cancel fails", () => {
  const { manager, logs } = createManager();
  const startedAt = Date.now();
  const session = createSession({
    mode: "openai_realtime",
    botTurnOpen: true,
    pendingResponse: {
      requestId: 14,
      utteranceText: "still speaking"
    },
    lastRealtimeAssistantAudioItemId: "item_cancel_failed",
    lastRealtimeAssistantAudioItemContentIndex: 0,
    lastRealtimeAssistantAudioItemReceivedMs: 1600,
    realtimeClient: {
      cancelActiveResponse() {
        return false;
      },
      truncateConversationItem() {
        return true;
      }
    }
  });

  const interrupted = manager.interruptBotSpeechForBargeIn({
    session,
    userId: "user-1",
    source: "cancel_failed_test"
  });

  assert.equal(interrupted, true);
  assert.equal(session.interruptedAssistantReply?.utteranceText, "still speaking");
  assert.equal(session.interruptedAssistantReply?.interruptedByUserId, "user-1");
  assert.equal(session.interruptedAssistantReply?.source, "cancel_failed_test");
  const suppressionMs = Number(session.bargeInSuppressionUntil || 0) - startedAt;
  assert.ok(suppressionMs >= 0);
  assert.ok(suppressionMs <= BARGE_IN_BOT_AUDIO_ECHO_GUARD_MS + 50);
  const interruptLog = logs.find((entry) => entry?.content === "voice_barge_in_interrupt");
  assert.equal(interruptLog?.metadata?.storedInterruptionContext, true);
});

test("interruptBotSpeechForBargeIn ignores stale clankvox buffered telemetry when truncating provider audio", () => {
  const { manager } = createManager();
  const truncateCalls = [];
  const session = createSession({
    mode: "openai_realtime",
    botTurnOpen: true,
    pendingResponse: {
      requestId: 14,
      utteranceText: "still speaking"
    },
    lastRealtimeAssistantAudioItemId: "item_stale_telemetry",
    lastRealtimeAssistantAudioItemContentIndex: 0,
    lastRealtimeAssistantAudioItemReceivedMs: 1600,
    realtimeClient: {
      cancelActiveResponse() {
        return true;
      },
      truncateConversationItem(payload) {
        truncateCalls.push(payload);
        return true;
      }
    },
    voxClient: {
      ttsBufferDepthSamples: 24_000,
      getTtsBufferDepthSamples() {
        return this.ttsBufferDepthSamples;
      },
      getTtsTelemetryUpdatedAt() {
        return Date.now() - 10_000;
      }
    }
  });

  const interrupted = manager.interruptBotSpeechForBargeIn({
    session,
    userId: "user-1",
    source: "stale_telemetry_test"
  });

  assert.equal(interrupted, true);
  assert.equal(truncateCalls.length, 1);
  assert.equal(truncateCalls[0]?.audioEndMs, 1600);
});

test("interruptBotSpeechForOutputLockTurn returns false when neither cancel nor truncate succeeds", () => {
  const { manager, logs } = createManager();
  const session = createSession({
    mode: "openai_realtime",
    botTurnOpen: true,
    pendingResponse: {
      requestId: 14,
      utteranceText: "still speaking"
    },
    lastRealtimeAssistantAudioItemId: "item_interrupt_failed",
    lastRealtimeAssistantAudioItemContentIndex: 0,
    lastRealtimeAssistantAudioItemReceivedMs: 1600,
    realtimeClient: {
      cancelActiveResponse() {
        return false;
      },
      truncateConversationItem() {
        return false;
      }
    }
  });

  const interrupted = manager.interruptBotSpeechForOutputLockTurn({
    session,
    userId: "user-1",
    source: "interrupt_failed_test"
  });

  assert.equal(interrupted, false);
  assert.equal(session.interruptedAssistantReply, null);
  const interruptLog = logs.find((entry) => entry?.content === "voice_output_lock_interrupt");
  assert.equal(interruptLog?.metadata?.responseCancelSucceeded, false);
  assert.equal(interruptLog?.metadata?.truncateSucceeded, false);
  assert.equal(interruptLog?.metadata?.storedInterruptionContext, false);
});

for (const runtimeMode of ["gemini_realtime", "elevenlabs_realtime"] as const) {
  test(`interruptBotSpeechForOutputLockTurn accepts local playback cut for ${runtimeMode} async-confirmation runtimes`, () => {
    const { manager, logs } = createManager();
    const session = createSession({
      mode: runtimeMode,
      botTurnOpen: true,
      pendingResponse: {
        requestId: 15,
        utteranceText: "still speaking"
      },
      realtimeClient: {
        cancelActiveResponse() {
          return false;
        },
        getInterruptAcceptanceMode() {
          return "local_cut_async_confirmation";
        }
      }
    });

    const interrupted = manager.interruptBotSpeechForOutputLockTurn({
      session,
      userId: "user-1",
      source: `${runtimeMode}_interrupt_test`
    });

    assert.equal(interrupted, true);
    assert.equal(session.interruptedAssistantReply?.utteranceText, "still speaking");
    assert.equal(session.interruptedAssistantReply?.interruptedByUserId, "user-1");
    const interruptLog = logs.find((entry) => entry?.content === "voice_output_lock_interrupt");
    assert.equal(interruptLog?.metadata?.responseCancelSucceeded, false);
    assert.equal(interruptLog?.metadata?.truncateSucceeded, false);
    assert.equal(interruptLog?.metadata?.interruptAcceptanceMode, "local_cut_async_confirmation");
    assert.equal(interruptLog?.metadata?.localPlaybackCutCommitted, true);
    assert.equal(interruptLog?.metadata?.interruptAccepted, true);
    assert.equal(interruptLog?.metadata?.providerInterruptConfirmationPending, true);
    assert.equal(interruptLog?.metadata?.storedInterruptionContext, true);
  });
}

test("interruptBotSpeechForDirectAddressedTurn skips barge-in suppression while preserving interruption context", () => {
  const { manager, logs } = createManager();
  const session = createSession({
    mode: "openai_realtime",
    botTurnOpen: true,
    pendingResponse: {
      requestId: 15,
      utteranceText: "still talking"
    },
    lastRealtimeAssistantAudioItemId: "item_direct_address",
    lastRealtimeAssistantAudioItemContentIndex: 0,
    lastRealtimeAssistantAudioItemReceivedMs: 1800,
    realtimeClient: {
      cancelActiveResponse() {
        return true;
      },
      truncateConversationItem() {
        return true;
      }
    }
  });

  const interrupted = manager.interruptBotSpeechForDirectAddressedTurn({
    session,
    userId: "user-2",
    source: "direct_address_test"
  });

  assert.equal(interrupted, true);
  assert.equal(session.bargeInSuppressionUntil, 0);
  assert.equal(session.interruptedAssistantReply?.utteranceText, "still talking");
  assert.equal(session.interruptedAssistantReply?.interruptedByUserId, "user-2");
  const interruptLog = logs.find((entry) => entry?.content === "voice_direct_address_interrupt");
  assert.equal(Boolean(interruptLog), true);
  assert.equal(interruptLog?.metadata?.bargeInSuppressionApplied, false);
  assert.equal(interruptLog?.metadata?.suppressionMs, 0);
});

test("interruptBotSpeechForOutputLockTurn skips barge-in suppression while preserving interruption context", () => {
  const { manager, logs } = createManager();
  const session = createSession({
    mode: "openai_realtime",
    botTurnOpen: true,
    pendingResponse: {
      requestId: 16,
      utteranceText: "still talking"
    },
    lastRealtimeAssistantAudioItemId: "item_output_lock",
    lastRealtimeAssistantAudioItemContentIndex: 0,
    lastRealtimeAssistantAudioItemReceivedMs: 1900,
    realtimeClient: {
      cancelActiveResponse() {
        return true;
      },
      truncateConversationItem() {
        return true;
      }
    }
  });

  const interrupted = manager.interruptBotSpeechForOutputLockTurn({
    session,
    userId: "user-1",
    source: "authorized_speaker_test"
  });

  assert.equal(interrupted, true);
  assert.equal(session.bargeInSuppressionUntil, 0);
  assert.equal(session.interruptedAssistantReply?.utteranceText, "still talking");
  assert.equal(session.interruptedAssistantReply?.interruptedByUserId, "user-1");
  const interruptLog = logs.find((entry) => entry?.content === "voice_output_lock_interrupt");
  assert.equal(Boolean(interruptLog), true);
  assert.equal(interruptLog?.metadata?.bargeInSuppressionApplied, false);
  assert.equal(interruptLog?.metadata?.suppressionMs, 0);
});

test("interruptBotSpeechForOutputLockTurn leaves pre-audio leased replies alone", () => {
  const { manager, logs } = createManager();
  const now = Date.now();
  const session = createSession({
    mode: "openai_realtime",
    botTurnOpen: true,
    pendingResponse: {
      requestId: 17,
      utteranceText: "still talking",
      audioReceivedAt: 0,
      outputLeaseMode: "assertive"
    },
    outputLease: {
      mode: "assertive",
      requestId: 17,
      grantedAt: now - 40,
      expiresAt: now + 600,
      source: "voice_reply:test"
    },
    realtimeClient: {
      cancelActiveResponse() {
        throw new Error("lease should block cancellation before first audio");
      },
      truncateConversationItem() {
        throw new Error("lease should block truncation before first audio");
      }
    }
  });

  const interrupted = manager.interruptBotSpeechForOutputLockTurn({
    session,
    userId: "user-1",
    source: "leased_output_lock_test"
  });

  assert.equal(interrupted, false);
  assert.equal(session.interruptedAssistantReply ?? null, null);
  assert.equal(Boolean(logs.find((entry) => entry?.content === "voice_output_lock_interrupt")), false);
});

test("handleAsrBridgeSpeechStarted arms a sustained interrupt and flushes the staged turn normally if speech stops early", () => {
  const { manager, logs } = createManager();
  const queuedTurns = [];
  manager.turnProcessor.queueRealtimeTurn = (payload) => {
    queuedTurns.push(payload);
  };
  manager.shouldUseTranscriptOverlapInterrupts = () => true;

  const session = createSession({
    mode: "openai_realtime",
    botTurnOpen: true,
    botTurnOpenAt: Date.now() - 1_800,
    assistantOutput: {
      phase: "speaking_live",
      reason: "bot_audio_live",
      phaseEnteredAt: Date.now() - 900,
      lastSyncedAt: Date.now() - 900,
      requestId: 22,
      ttsPlaybackState: "playing",
      ttsBufferedSamples: 18_000,
      lastTrigger: "test_seed"
    },
    pendingResponse: {
      requestId: 22,
      requestedAt: Date.now() - 2_000,
      source: "voice_reply",
      handlingSilence: false,
      audioReceivedAt: Date.now() - 1_300,
      interruptionPolicy: {
        assertive: true,
        scope: "speaker",
        allowedUserId: "speaker-1"
      },
      utteranceText: "still talking",
      latencyContext: null,
      userId: "speaker-1",
      retryCount: 0,
      hardRecoveryAttempted: false
    },
    userCaptures: new Map([
      [
        "speaker-1",
        createAssertiveCaptureState("speaker-1")
      ]
    ]),
    realtimeClient: {
      cancelActiveResponse() {
        return true;
      },
      truncateConversationItem() {
        return true;
      }
    }
  });

  const armed = manager.handleAsrBridgeSpeechStarted({
    session,
    userId: "speaker-1",
    speakerName: "speaker one",
    utteranceId: 88,
    audioStartMs: 640,
    itemId: "item_88",
    eventType: "input_audio_buffer.speech_started"
  });

  assert.equal(armed, true);
  assert.equal(logs.some((entry) => entry?.content === "voice_interrupt_speech_started_pending"), true);
  assert.equal(Boolean(session.interruptedAssistantReply), false);

  const usedTranscript = manager.queueRealtimeTurnFromAsrBridge({
    session,
    userId: "speaker-1",
    pcmBuffer: Buffer.alloc(DISCORD_PCM_FRAME_BYTES * 2, 1),
    captureReason: "stream_end",
    finalizedAt: Date.now(),
    bridgeUtteranceId: 88,
    asrResult: {
      transcript: "actually wait",
      asrStartedAtMs: 1000,
      asrCompletedAtMs: 1110
    },
    source: "per_user"
  });

  assert.equal(usedTranscript, false);
  assert.equal(queuedTurns.length, 0);
  assert.equal(session.pendingInterruptBridgeTurns?.size || 0, 1);

  const released = manager.handleAsrBridgeSpeechStopped({
    session,
    userId: "speaker-1",
    speakerName: "speaker one",
    utteranceId: 88,
    audioEndMs: 910,
    itemId: "item_88",
    eventType: "input_audio_buffer.speech_stopped"
  });

  assert.equal(released, true);
  assert.equal(queuedTurns.length, 1);
  assert.equal(queuedTurns[0]?.bridgeUtteranceId, 88);
  assert.equal(queuedTurns[0]?.transcriptOverride, "actually wait");
  assert.equal(session.pendingInterruptBridgeTurns?.size || 0, 0);
  assert.equal(Boolean(session.interruptedAssistantReply), false);
});

test("handleAsrBridgeSpeechStarted leaves a pre-audio pending reply alone before playback starts", () => {
  const { manager, logs } = createManager();
  const cancelCalls = [];
  manager.shouldUseTranscriptOverlapInterrupts = () => true;

  const session = createSession({
    mode: "openai_realtime",
    realtimeClient: {
      cancelActiveResponse() {
        cancelCalls.push(true);
        return true;
      }
    },
    pendingResponse: {
      requestId: 24,
      requestedAt: Date.now() - 120,
      source: "voice_reply",
      handlingSilence: false,
      audioReceivedAt: 0,
      interruptionPolicy: {
        assertive: true,
        scope: "speaker",
        allowedUserId: "speaker-1"
      },
      utteranceText: "hang on",
      latencyContext: null,
      userId: "speaker-1",
      retryCount: 0,
      hardRecoveryAttempted: false
    },
    userCaptures: new Map([
      [
        "speaker-1",
        createAssertiveCaptureState("speaker-1", {
          promotionReason: "server_vad_confirmed"
        })
      ]
    ])
  });

  const handled = manager.handleAsrBridgeSpeechStarted({
    session,
    userId: "speaker-1",
    speakerName: "speaker one",
    utteranceId: 97,
    audioStartMs: 640,
    itemId: "item_97",
    eventType: "input_audio_buffer.speech_started"
  });

  assert.equal(handled, false);
  assert.equal(cancelCalls.length, 0);
  assert.ok(session.pendingResponse);
  assert.equal(
    logs.some((entry) => entry?.content === "voice_preplay_reply_superseded_for_user_speech"),
    false
  );
});

test("handleAsrBridgeSpeechStarted does not hold same-speaker generation-only reply before playback", () => {
  const { manager, logs } = createManager();
  manager.activeReplies = new ActiveReplyRegistry();
  manager.shouldUseTranscriptOverlapInterrupts = () => true;

  const session = createSession({
    mode: "openai_realtime",
    lastAudioDeltaAt: 0,
    pendingResponse: null,
    activeReplyInterruptionPolicy: {
      assertive: true,
      scope: "speaker",
      allowedUserId: "speaker-1"
    },
    inFlightAcceptedBrainTurn: {
      transcript: "Can you look up the price of Apple?",
      userId: "speaker-1",
      pcmBuffer: null,
      source: "realtime",
      acceptedAt: Date.now() - 500,
      phase: "generation_only",
      captureReason: "stream_end",
      directAddressed: true
    },
    userCaptures: new Map([
      [
        "speaker-1",
        createAssertiveCaptureState("speaker-1", {
          promotionReason: "server_vad_confirmed"
        })
      ]
    ])
  });
  const replyScopeKey = buildVoiceReplyScopeKey(session.id);
  const activeReply = manager.activeReplies.begin(replyScopeKey, "voice-generation", ["voice_generation"]);

  const handled = manager.handleAsrBridgeSpeechStarted({
    session,
    userId: "speaker-1",
    speakerName: "speaker one",
    utteranceId: 98,
    audioStartMs: 640,
    itemId: "item_98",
    eventType: "input_audio_buffer.speech_started"
  });

  assert.equal(handled, false);
  assert.equal(activeReply.abortController.signal.aborted, false);
  assert.equal(
    logs.some((entry) => entry?.content === "voice_preplay_reply_superseded_for_user_speech"),
    false
  );
  assert.equal(
    logs.some((entry) => entry?.content === "voice_preplay_reply_held_for_user_speech"),
    false
  );
});

test("commitPendingSpeechStartedInterrupt hard-cuts after sustained overlap and forwards the staged turn", () => {
  const { manager, logs } = createManager();
  const queuedTurns = [];
  const interruptCalls = [];
  manager.turnProcessor.queueRealtimeTurn = (payload) => {
    queuedTurns.push(payload);
  };
  manager.shouldUseTranscriptOverlapInterrupts = () => true;
  manager.interruptBotSpeechForOutputLockTurn = (payload) => {
    interruptCalls.push(payload);
    return true;
  };

  const session = createSession({
    mode: "openai_realtime",
    botTurnOpen: true,
    botTurnOpenAt: Date.now() - 1_800,
    assistantOutput: {
      phase: "speaking_live",
      reason: "bot_audio_live",
      phaseEnteredAt: Date.now() - 900,
      lastSyncedAt: Date.now() - 900,
      requestId: 23,
      ttsPlaybackState: "playing",
      ttsBufferedSamples: 18_000,
      lastTrigger: "test_seed"
    },
    pendingResponse: {
      requestId: 23,
      requestedAt: Date.now() - 2_000,
      source: "voice_reply",
      handlingSilence: false,
      audioReceivedAt: Date.now() - 1_300,
      interruptionPolicy: {
        assertive: true,
        scope: "speaker",
        allowedUserId: "speaker-1"
      },
      utteranceText: "still talking",
      latencyContext: null,
      userId: "speaker-1",
      retryCount: 0,
      hardRecoveryAttempted: false
    },
    userCaptures: new Map([
      [
        "speaker-1",
        createAssertiveCaptureState("speaker-1")
      ]
    ])
  });
  const asrState = getOrCreatePerUserAsrState(session, "speaker-1");
  assert.ok(asrState);
  asrState.speechActive = true;
  asrState.speechDetectedUtteranceId = 89;
  asrState.speechDetectedAt = Date.now();

  const armed = manager.handleAsrBridgeSpeechStarted({
    session,
    userId: "speaker-1",
    speakerName: "speaker one",
    utteranceId: 89,
    audioStartMs: 640,
    itemId: "item_89",
    eventType: "input_audio_buffer.speech_started"
  });

  assert.equal(armed, true);

  const usedTranscript = manager.queueRealtimeTurnFromAsrBridge({
    session,
    userId: "speaker-1",
    pcmBuffer: Buffer.alloc(DISCORD_PCM_FRAME_BYTES * 2, 1),
    captureReason: "stream_end",
    finalizedAt: Date.now(),
    bridgeUtteranceId: 89,
    asrResult: {
      transcript: "actually wait",
      asrStartedAtMs: 1000,
      asrCompletedAtMs: 1110
    },
    source: "per_user"
  });

  assert.equal(usedTranscript, false);
  assert.equal(session.pendingInterruptBridgeTurns?.size || 0, 1);

  const interrupted = manager.commitPendingSpeechStartedInterrupt({
    session,
    utteranceId: 89,
    reason: "test_sustain_window"
  });

  assert.equal(interrupted, true);
  assert.equal(interruptCalls.length, 1);
  assert.equal(queuedTurns.length, 1);
  assert.equal(queuedTurns[0]?.bridgeUtteranceId, 89);
  assert.equal(queuedTurns[0]?.transcriptOverride, "actually wait");
  assert.equal(session.pendingInterruptBridgeTurns?.size || 0, 0);
  assert.equal(logs.some((entry) => entry?.content === "voice_interrupt_on_speech_started_sustain"), true);
});

test("commitPendingSpeechStartedInterrupt flushes the staged turn without cutting if speech is no longer active", () => {
  const { manager, logs } = createManager();
  const queuedTurns = [];
  const interruptCalls = [];
  manager.turnProcessor.queueRealtimeTurn = (payload) => {
    queuedTurns.push(payload);
  };
  manager.shouldUseTranscriptOverlapInterrupts = () => true;
  manager.interruptBotSpeechForOutputLockTurn = (payload) => {
    interruptCalls.push(payload);
    return true;
  };

  const session = createSession({
    mode: "openai_realtime",
    botTurnOpen: true,
    botTurnOpenAt: Date.now() - 1_800,
    assistantOutput: {
      phase: "speaking_live",
      reason: "bot_audio_live",
      phaseEnteredAt: Date.now() - 900,
      lastSyncedAt: Date.now() - 900,
      requestId: 24,
      ttsPlaybackState: "playing",
      ttsBufferedSamples: 18_000,
      lastTrigger: "test_seed"
    },
    pendingResponse: {
      requestId: 24,
      requestedAt: Date.now() - 2_000,
      source: "voice_reply",
      handlingSilence: false,
      audioReceivedAt: Date.now() - 1_300,
      interruptionPolicy: {
        assertive: true,
        scope: "speaker",
        allowedUserId: "speaker-1"
      },
      utteranceText: "still talking",
      latencyContext: null,
      userId: "speaker-1",
      retryCount: 0,
      hardRecoveryAttempted: false
    },
    userCaptures: new Map([
      [
        "speaker-1",
        createAssertiveCaptureState("speaker-1")
      ]
    ])
  });
  const asrState = getOrCreatePerUserAsrState(session, "speaker-1");
  assert.ok(asrState);
  asrState.speechActive = true;
  asrState.speechDetectedUtteranceId = 90;
  asrState.speechDetectedAt = Date.now();

  const armed = manager.handleAsrBridgeSpeechStarted({
    session,
    userId: "speaker-1",
    speakerName: "speaker one",
    utteranceId: 90,
    audioStartMs: 640,
    itemId: "item_90",
    eventType: "input_audio_buffer.speech_started"
  });

  assert.equal(armed, true);

  const usedTranscript = manager.queueRealtimeTurnFromAsrBridge({
    session,
    userId: "speaker-1",
    pcmBuffer: Buffer.alloc(DISCORD_PCM_FRAME_BYTES * 2, 1),
    captureReason: "stream_end",
    finalizedAt: Date.now(),
    bridgeUtteranceId: 90,
    asrResult: {
      transcript: "yeah uh huh",
      asrStartedAtMs: 1000,
      asrCompletedAtMs: 1110
    },
    source: "per_user"
  });

  assert.equal(usedTranscript, false);
  assert.equal(session.pendingInterruptBridgeTurns?.size || 0, 1);

  asrState.speechActive = false;

  const interrupted = manager.commitPendingSpeechStartedInterrupt({
    session,
    utteranceId: 90,
    reason: "test_inactive_speech"
  });

  assert.equal(interrupted, false);
  assert.equal(interruptCalls.length, 0);
  assert.equal(queuedTurns.length, 1);
  assert.equal(queuedTurns[0]?.bridgeUtteranceId, 90);
  assert.equal(queuedTurns[0]?.transcriptOverride, "yeah uh huh");
  assert.equal(session.pendingInterruptBridgeTurns?.size || 0, 0);
  const releaseLog = logs.find((entry) => entry?.content === "voice_interrupt_speech_started_released");
  assert.equal(releaseLog?.metadata?.reason, "speech_no_longer_active");
});

test("handleAsrBridgeSpeechStarted keeps a same-speaker interrupt pending while the capture is still maturing", () => {
  const { manager, logs } = createManager();
  manager.shouldUseTranscriptOverlapInterrupts = () => true;

  const session = createSession({
    mode: "openai_realtime",
    botTurnOpen: true,
    botTurnOpenAt: Date.now() - 1_800,
    assistantOutput: {
      phase: "speaking_live",
      reason: "bot_audio_live",
      phaseEnteredAt: Date.now() - 900,
      lastSyncedAt: Date.now() - 900,
      requestId: 25,
      ttsPlaybackState: "playing",
      ttsBufferedSamples: 18_000,
      lastTrigger: "test_seed"
    },
    pendingResponse: {
      requestId: 25,
      requestedAt: Date.now() - 2_000,
      source: "voice_reply",
      handlingSilence: false,
      audioReceivedAt: Date.now() - 1_300,
      interruptionPolicy: {
        assertive: true,
        scope: "speaker",
        allowedUserId: "speaker-1"
      },
      utteranceText: "still talking",
      latencyContext: null,
      userId: "speaker-1",
      retryCount: 0,
      hardRecoveryAttempted: false
    },
    userCaptures: new Map([
      [
        "speaker-1",
        createAssertiveCaptureState("speaker-1", {
          bytesSent: 20_640
        })
      ]
    ])
  });

  const armed = manager.handleAsrBridgeSpeechStarted({
    session,
    userId: "speaker-1",
    speakerName: "speaker one",
    utteranceId: 91,
    audioStartMs: 640,
    itemId: "item_91",
    eventType: "input_audio_buffer.speech_started"
  });

  assert.equal(armed, true);
  assert.equal(session.pendingSpeechStartedInterrupts?.size || 0, 1);
  const pendingLog = logs.find((entry) => entry?.content === "voice_interrupt_speech_started_pending");
  assert.equal(pendingLog?.metadata?.initialReason, "insufficient_capture_bytes");
  assert.equal(pendingLog?.metadata?.captureBytesSent, 20_640);
  assert.equal(logs.some((entry) => entry?.content === "voice_interrupt_speech_started_ignored"), false);
});

test("commitPendingSpeechStartedInterrupt accepts an active local capture when provider speech_started was missed", () => {
  const { manager, logs } = createManager();
  const interruptCalls = [];
  manager.shouldUseTranscriptOverlapInterrupts = () => true;
  manager.interruptBotSpeechForOutputLockTurn = (payload) => {
    interruptCalls.push(payload);
    return true;
  };

  const session = createSession({
    mode: "openai_realtime",
    botTurnOpen: false,
    botTurnOpenAt: 0,
    assistantOutput: {
      phase: "speaking_buffered",
      reason: "bot_audio_buffered",
      phaseEnteredAt: Date.now() - 1_200,
      lastSyncedAt: Date.now() - 200,
      requestId: 26,
      ttsPlaybackState: "buffered",
      ttsBufferedSamples: 18_000,
      lastTrigger: "test_seed"
    },
    voxClient: {
      isAlive: true,
      getTtsBufferDepthSamples() {
        return 18_000;
      },
      getTtsPlaybackState() {
        return "buffered";
      }
    },
    pendingResponse: null,
    activeReplyInterruptionPolicy: {
      assertive: true,
      scope: "speaker",
      allowedUserId: "speaker-1"
    },
    userCaptures: new Map([
      [
        "speaker-1",
        createAssertiveCaptureState("speaker-1", {
          asrUtteranceId: 92,
          bytesSent: 20_640
        })
      ]
    ])
  });
  const capture = session.userCaptures.get("speaker-1");
  assert.ok(capture);

  const armed = manager.ensurePendingSpeechStartedInterruptFromLocalCapture({
    session,
    userId: "speaker-1",
    captureState: capture,
    source: "local_capture_overlap"
  });

  assert.equal(armed, true);
  capture.bytesSent = 48_000;

  const committed = manager.commitPendingSpeechStartedInterrupt({
    session,
    utteranceId: 92,
    reason: "recheck_window"
  });

  assert.equal(committed, true);
  assert.equal(interruptCalls.length, 1);
  assert.equal(session.pendingSpeechStartedInterrupts?.size || 0, 0);
  assert.equal(session.interruptDecisionsByUtteranceId?.get(92)?.source, "speech_started_sustained");
  const interruptLog = logs.find((entry) => entry?.content === "voice_interrupt_on_speech_started_sustain");
  assert.equal(interruptLog?.metadata?.eventType, "local_capture_overlap");
  assert.equal(interruptLog?.metadata?.speechStillActiveSource, "local_capture");
});

test("handleAsrBridgeSpeechStarted arms a same-speaker interrupt while buffered bot speech drains over active music", () => {
  const { manager, logs } = createManager();
  manager.shouldUseTranscriptOverlapInterrupts = () => true;

  const session = createSession({
    mode: "openai_realtime",
    botTurnOpen: false,
    botTurnOpenAt: 0,
    assistantOutput: {
      phase: "speaking_buffered",
      reason: "bot_audio_buffered",
      phaseEnteredAt: Date.now() - 1_200,
      lastSyncedAt: Date.now() - 200,
      requestId: 26,
      ttsPlaybackState: "buffered",
      ttsBufferedSamples: 18_000,
      lastTrigger: "test_seed"
    },
    voxClient: {
      isAlive: true,
      getTtsBufferDepthSamples() {
        return 18_000;
      },
      getTtsPlaybackState() {
        return "buffered";
      }
    },
    pendingResponse: null,
    activeReplyInterruptionPolicy: {
      assertive: true,
      scope: "speaker",
      allowedUserId: "speaker-1"
    },
    userCaptures: new Map([
      [
        "speaker-1",
        createAssertiveCaptureState("speaker-1")
      ]
    ])
  });
  session.music.phase = "playing";
  session.music.active = true;
  session.music.ducked = true;

  const armed = manager.handleAsrBridgeSpeechStarted({
    session,
    userId: "speaker-1",
    speakerName: "speaker one",
    utteranceId: 92,
    audioStartMs: 640,
    itemId: "item_92",
    eventType: "input_audio_buffer.speech_started"
  });

  assert.equal(armed, true);
  assert.equal(session.pendingSpeechStartedInterrupts?.size || 0, 1);
  assert.equal(logs.some((entry) => entry?.content === "voice_interrupt_speech_started_pending"), true);
  assert.equal(logs.some((entry) => entry?.content === "voice_interrupt_speech_started_ignored"), false);
});

test("commitPendingSpeechStartedInterrupt rechecks a same-speaker overlap until it becomes barge-in eligible", () => {
  const { manager, logs } = createManager();
  const interruptCalls = [];
  manager.shouldUseTranscriptOverlapInterrupts = () => true;
  manager.interruptBotSpeechForOutputLockTurn = (payload) => {
    interruptCalls.push(payload);
    return true;
  };

  const session = createSession({
    mode: "openai_realtime",
    botTurnOpen: true,
    botTurnOpenAt: Date.now() - 1_800,
    assistantOutput: {
      phase: "speaking_live",
      reason: "bot_audio_live",
      phaseEnteredAt: Date.now() - 900,
      lastSyncedAt: Date.now() - 900,
      requestId: 27,
      ttsPlaybackState: "playing",
      ttsBufferedSamples: 18_000,
      lastTrigger: "test_seed"
    },
    pendingResponse: {
      requestId: 27,
      requestedAt: Date.now() - 2_000,
      source: "voice_reply",
      handlingSilence: false,
      audioReceivedAt: Date.now() - 1_300,
      interruptionPolicy: {
        assertive: true,
        scope: "speaker",
        allowedUserId: "speaker-1"
      },
      utteranceText: "still talking",
      latencyContext: null,
      userId: "speaker-1",
      retryCount: 0,
      hardRecoveryAttempted: false
    },
    userCaptures: new Map([
      [
        "speaker-1",
        createAssertiveCaptureState("speaker-1", {
          bytesSent: 20_640
        })
      ]
    ])
  });
  const asrState = getOrCreatePerUserAsrState(session, "speaker-1");
  assert.ok(asrState);
  asrState.speechActive = true;
  asrState.speechDetectedUtteranceId = 93;
  asrState.speechDetectedAt = Date.now();

  const armed = manager.handleAsrBridgeSpeechStarted({
    session,
    userId: "speaker-1",
    speakerName: "speaker one",
    utteranceId: 93,
    audioStartMs: 640,
    itemId: "item_93",
    eventType: "input_audio_buffer.speech_started"
  });

  assert.equal(armed, true);

  const firstCommit = manager.commitPendingSpeechStartedInterrupt({
    session,
    utteranceId: 93,
    reason: "test_first_commit"
  });

  assert.equal(firstCommit, false);
  assert.equal(interruptCalls.length, 0);
  assert.equal(session.pendingSpeechStartedInterrupts?.size || 0, 1);
  const retryLog = logs.find((entry) => entry?.content === "voice_interrupt_speech_started_retry_scheduled");
  assert.equal(retryLog?.metadata?.reason, "insufficient_capture_bytes");
  assert.equal(retryLog?.metadata?.retryAfterMs, VOICE_INTERRUPT_SPEECH_START_RECHECK_MS);

  const capture = session.userCaptures?.get("speaker-1");
  assert.ok(capture);
  if (capture) {
    capture.bytesSent = 48_000;
  }

  const secondCommit = manager.commitPendingSpeechStartedInterrupt({
    session,
    utteranceId: 93,
    reason: "test_second_commit"
  });

  assert.equal(secondCommit, true);
  assert.equal(interruptCalls.length, 1);
  assert.equal(session.pendingSpeechStartedInterrupts?.size || 0, 0);
  assert.equal(logs.some((entry) => entry?.content === "voice_interrupt_on_speech_started_sustain"), true);
});

test("handleAsrBridgeTranscriptOverlapSegment lets a wake-word transcript grab the floor immediately", () => {
  const { manager, logs } = createManager();
  const interruptCalls = [];
  manager.shouldUseTranscriptOverlapInterrupts = () => true;
  manager.interruptBotSpeechForDirectAddressedTurn = (payload) => {
    interruptCalls.push(payload);
    return true;
  };

  const session = createSession({
    mode: "openai_realtime",
    botTurnOpen: true,
    botTurnOpenAt: Date.now() - 1_800,
    assistantOutput: {
      phase: "speaking_live",
      reason: "bot_audio_live",
      phaseEnteredAt: Date.now() - 900,
      lastSyncedAt: Date.now() - 900,
      requestId: 24,
      ttsPlaybackState: "playing",
      ttsBufferedSamples: 18_000,
      lastTrigger: "test_seed"
    },
    settingsSnapshot: createTestSettings({
      botName: "clanky",
      voice: {
        defaultInterruptionMode: "speaker"
      }
    }),
    pendingResponse: {
      requestId: 24,
      requestedAt: Date.now() - 2_000,
      source: "voice_reply",
      handlingSilence: false,
      audioReceivedAt: Date.now() - 1_300,
      interruptionPolicy: {
        assertive: true,
        scope: "speaker",
        allowedUserId: "speaker-1"
      },
      utteranceText: "still talking",
      latencyContext: null,
      userId: "speaker-1",
      retryCount: 0,
      hardRecoveryAttempted: false
    }
  });

  manager.handleAsrBridgeTranscriptOverlapSegment({
    session,
    userId: "speaker-2",
    speakerName: "speaker two",
    transcript: "yo clanker wait",
    utteranceId: 90,
    isFinal: false,
    eventType: "conversation.item.input_audio_transcription.delta",
    itemId: "item_90",
    previousItemId: null
  });

  assert.equal(interruptCalls.length, 1);
  assert.equal(interruptCalls[0]?.userId, "speaker-2");
  assert.equal(session.interruptDecisionsByUtteranceId?.get(90)?.decision, "interrupt");
  assert.equal(session.interruptDecisionsByUtteranceId?.get(90)?.source, "transcript_direct_address");
  assert.equal(logs.some((entry) => entry?.content === "voice_interrupt_on_transcript_direct_address"), true);
});

test("shouldDirectAddressedTurnInterruptReply allows wake-word overrides in speaker mode but not none mode", () => {
  const { manager } = createManager();
  const speakerModeSession = createSession({
    settingsSnapshot: createTestSettings({
      botName: "clanky",
      voice: {
        defaultInterruptionMode: "speaker"
      }
    })
  });
  const noneModeSession = createSession({
    settingsSnapshot: createTestSettings({
      botName: "clanky",
      voice: {
        defaultInterruptionMode: "none"
      }
    })
  });

  assert.equal(
    manager.shouldDirectAddressedTurnInterruptReply({
      session: speakerModeSession,
      directAddressed: true
    }),
    true
  );
  assert.equal(
    manager.shouldDirectAddressedTurnInterruptReply({
      session: noneModeSession,
      directAddressed: true
    }),
    false
  );
});

test("isCaptureConfirmedLiveSpeech requires both speech window and non-silent signal", () => {
  const { manager } = createManager();
  const session = createSession({
    mode: "openai_realtime",
    realtimeInputSampleRateHz: 24_000
  });
  const minSpeechBytes = Math.max(2, Math.ceil((24_000 * 2 * ACTIVITY_TOUCH_MIN_SPEECH_MS) / 1000));

  const underWindowCapture = {
    promotedAt: Date.now(),
    bytesSent: Math.max(2, minSpeechBytes - 2),
    signalSampleCount: 24_000,
    signalActiveSampleCount: 2_000,
    signalPeakAbs: 6_000
  };
  assert.equal(
    manager.isCaptureConfirmedLiveSpeech({
      session,
      capture: underWindowCapture
    }),
    false
  );

  const nearSilentCapture = {
    promotedAt: Date.now(),
    bytesSent: minSpeechBytes + 2,
    signalSampleCount: 24_000,
    signalActiveSampleCount: 120,
    signalPeakAbs: 150
  };
  assert.equal(
    manager.isCaptureConfirmedLiveSpeech({
      session,
      capture: nearSilentCapture
    }),
    false
  );

  const speechLikeCapture = {
    promotedAt: Date.now(),
    bytesSent: minSpeechBytes + 2,
    signalSampleCount: 24_000,
    signalActiveSampleCount: 2_000,
    signalPeakAbs: 6_000
  };
  assert.equal(
    manager.isCaptureConfirmedLiveSpeech({
      session,
      capture: speechLikeCapture
    }),
    true
  );
});

test("bindSessionHandlers does not touch activity on speaking.start before speech is confirmed", () => {
  const { manager, touchCalls } = createManager();
  const voxClient = new EventEmitter();
  const startCalls = [];
  manager.captureManager.startInboundCapture = (payload) => {
    startCalls.push(payload);
  };

  const session = createSession({
    cleanupHandlers: [],
    voxClient,
    settingsSnapshot: {
      botName: "clanky",
      voice: {
        enabled: true,
        asrEnabled: true
      }
    }
  });

  manager.sessionLifecycle.bindSessionHandlers(session, session.settingsSnapshot);
  voxClient.emit("speakingStart", "speaker-1");

  assert.equal(startCalls.length, 1);
  assert.equal(startCalls[0]?.userId, "speaker-1");
  assert.equal(touchCalls.length, 0);
});

test("bindSessionHandlers requests share-link recovery when native stream transport fails", async () => {
  const { manager, logs } = createManager();
  const voxClient = new EventEmitter();
  const stopCalls: Array<Record<string, unknown>> = [];
  const fallbackCalls: Array<Record<string, unknown>> = [];
  const session = createSession({
    cleanupHandlers: [],
    voxClient,
    textChannelId: "text-1",
    streamWatch: {
      active: true,
      targetUserId: "user-2",
      requestedByUserId: "user-1",
      lastFrameAt: 0,
      lastCommentaryAt: 0,
      ingestedFrameCount: 0
    }
  });

  manager.stopWatchStreamForUser = async (payload) => {
    stopCalls.push(payload);
    session.streamWatch.active = false;
    return {
      ok: true,
      reason: "watching_stopped"
    };
  };
  manager.startVoiceScreenWatch = async (payload) => {
    fallbackCalls.push(payload);
    return {
      started: true,
      transport: "link",
      reason: "started"
    };
  };

  manager.sessionLifecycle.bindSessionHandlers(session, session.settingsSnapshot);
  voxClient.emit("transportState", {
    role: "stream_watch",
    status: "failed",
    reason: "ice_failed"
  });
  await flushMicrotasks();

  assert.equal(stopCalls.length, 1);
  assert.equal(stopCalls[0]?.reason, "native_discord_stream_transport_failed");
  assert.equal(fallbackCalls.length, 1);
  assert.equal(fallbackCalls[0]?.preferredTransport, "link");
  assert.equal(fallbackCalls[0]?.nativeFailureReason, "native_discord_stream_transport_failed");
  assert.equal(fallbackCalls[0]?.targetUserId, "user-2");
  assert.equal(fallbackCalls[0]?.requesterUserId, "user-1");

  const fallbackRequested = logs.find(
    (entry) => String(entry?.content || "") === "native_discord_stream_transport_link_fallback_requested"
  );
  assert.equal(fallbackRequested?.metadata?.status, "failed");
  assert.equal(fallbackRequested?.metadata?.targetUserId, "user-2");
});

test("bindSessionHandlers does not request share-link recovery when STREAM_LINK_FALLBACK is disabled", async () => {
  const { manager, logs } = createManager();
  manager.appConfig.streamLinkFallbackEnabled = false;
  const voxClient = new EventEmitter();
  const stopCalls: Array<Record<string, unknown>> = [];
  const fallbackCalls: Array<Record<string, unknown>> = [];
  const session = createSession({
    cleanupHandlers: [],
    voxClient,
    textChannelId: "text-1",
    streamWatch: {
      active: true,
      targetUserId: "user-2",
      requestedByUserId: "user-1",
      lastFrameAt: 0,
      lastCommentaryAt: 0,
      ingestedFrameCount: 0
    }
  });

  manager.stopWatchStreamForUser = async (payload) => {
    stopCalls.push(payload);
    session.streamWatch.active = false;
    return {
      ok: true,
      reason: "watching_stopped"
    };
  };
  manager.startVoiceScreenWatch = async (payload) => {
    fallbackCalls.push(payload);
    return {
      started: true,
      transport: "link",
      reason: "started"
    };
  };

  manager.sessionLifecycle.bindSessionHandlers(session, session.settingsSnapshot);
  voxClient.emit("transportState", {
    role: "stream_watch",
    status: "failed",
    reason: "ice_failed"
  });
  await flushMicrotasks();

  assert.equal(stopCalls.length, 1);
  assert.equal(fallbackCalls.length, 0);
  const fallbackSkipped = logs.find(
    (entry) => String(entry?.content || "") === "native_discord_stream_transport_link_fallback_skipped"
  );
  assert.equal(fallbackSkipped?.metadata?.skipReason, "stream_link_fallback_disabled");
});

test("startInboundCapture drops provisional noise before activity promotion while streaming provisional ASR audio", async () => {
  const { manager, logs, touchCalls } = createManager();
  manager.appConfig.openaiApiKey = "test-openai-key";
  manager.shouldUsePerUserTranscription = () => true;
  const voxClient = new EventEmitter();
  voxClient.subscribeUser = () => {};
  const session = createSession({
    mode: "openai_realtime",
    realtimeInputSampleRateHz: 24_000,
    cleanupHandlers: [],
    settingsSnapshot: {
      botName: "clanky",
      voice: {
        enabled: true,
        asrEnabled: true,
        brainProvider: "anthropic"
      }
    },
    voxClient
  });
  const { appendedChunks } = seedReadyPerUserAsr(manager, session, "speaker-1");

  manager.captureManager.startInboundCapture({
    session,
    userId: "speaker-1",
    settings: session.settingsSnapshot
  });

  const noisePcm = makeMonoPcm16(Math.ceil((24_000 * VOICE_SILENCE_GATE_MIN_CLIP_MS) / 1000), 64);
  voxClient.emit("userAudio", "speaker-1", noisePcm);
  await flushMicrotasks();

  const capture = session.userCaptures.get("speaker-1");
  assert.ok(capture);
  capture.finalize("stream_end");

  assert.ok(Number(capture.asrUtteranceId || 0) > 0);
  assert.equal(appendedChunks.length, 1);
  assert.deepEqual(appendedChunks[0], noisePcm);
  assert.equal(touchCalls.length, 0);
  assert.equal(logs.some((entry) => entry?.content === "voice_activity_started"), false);
  assert.equal(logs.some((entry) => entry?.content === "voice_turn_dropped_provisional_capture"), true);
  assert.equal(session.userCaptures.has("speaker-1"), false);
});

test("startInboundCapture promotes strong local speech while streaming per-user ASR audio", async () => {
  const { manager, logs, touchCalls } = createManager();
  manager.appConfig.openaiApiKey = "test-openai-key";
  manager.shouldUsePerUserTranscription = () => true;
  const voxClient = new EventEmitter();
  voxClient.subscribeUser = () => {};
  const session = createSession({
    mode: "openai_realtime",
    realtimeInputSampleRateHz: 24_000,
    cleanupHandlers: [],
    settingsSnapshot: {
      botName: "clanky",
      voice: {
        enabled: true,
        asrEnabled: true,
        brainProvider: "anthropic"
      }
    },
    voxClient
  });
  const { asrState, appendedChunks } = seedReadyPerUserAsr(manager, session, "speaker-1");

  manager.captureManager.startInboundCapture({
    session,
    userId: "speaker-1",
    settings: session.settingsSnapshot
  });

  const speechPcm = makeMonoPcm16(Math.ceil((24_000 * (VOICE_TURN_PROMOTION_MIN_CLIP_MS + 40)) / 1000), 3000);
  voxClient.emit("userAudio", "speaker-1", speechPcm);
  await flushMicrotasks();

  const capture = session.userCaptures.get("speaker-1");
  assert.ok(capture);
  assert.equal(capture.asrUtteranceId, asrState.utterance.id);
  assert.equal(appendedChunks.length, 1);
  assert.deepEqual(appendedChunks[0], speechPcm);
  assert.ok(Number(capture.promotedAt || 0) > 0);
  assert.equal(capture.promotionReason, "strong_local_audio");
  assert.equal(touchCalls.length, 1);
  const activityLog = logs.find((entry) => entry?.content === "voice_activity_started");
  assert.ok(activityLog);
  assert.equal(activityLog?.userId, "speaker-1");
});

test("startInboundCapture promotes modest speech once server VAD confirms the provisional capture", async () => {
  const { manager, logs, touchCalls } = createManager();
  manager.appConfig.openaiApiKey = "test-openai-key";
  manager.hasCaptureServerVadSpeech = () => true;
  manager.shouldUsePerUserTranscription = () => true;
  const voxClient = new EventEmitter();
  voxClient.subscribeUser = () => {};
  const session = createSession({
    mode: "openai_realtime",
    realtimeInputSampleRateHz: 24_000,
    cleanupHandlers: [],
    settingsSnapshot: {
      botName: "clanky",
      voice: {
        enabled: true,
        asrEnabled: true,
        brainProvider: "anthropic"
      }
    },
    voxClient
  });
  const { asrState, appendedChunks } = seedReadyPerUserAsr(manager, session, "speaker-1");

  manager.captureManager.startInboundCapture({
    session,
    userId: "speaker-1",
    settings: session.settingsSnapshot
  });

  const speechPcm = makeMonoPcm16(Math.ceil((24_000 * (VOICE_TURN_PROMOTION_MIN_CLIP_MS + 40)) / 1000), 700);
  voxClient.emit("userAudio", "speaker-1", speechPcm);
  await flushMicrotasks();

  const capture = session.userCaptures.get("speaker-1");
  assert.ok(capture);
  assert.equal(capture.asrUtteranceId, asrState.utterance.id);
  assert.equal(appendedChunks.length, 1);
  assert.ok(Number(capture.promotedAt || 0) > 0);
  assert.equal(capture.promotionReason, "server_vad_confirmed");
  assert.equal(touchCalls.length, 1);
  const activityLog = logs.find((entry) => entry?.content === "voice_activity_started");
  assert.ok(activityLog);
  assert.equal(activityLog?.metadata?.promotionServerVadConfirmed, true);
});

test("startInboundCapture keeps sparse spike noise provisional even while streaming provisional ASR audio", async () => {
  const { manager, logs, touchCalls } = createManager();
  manager.appConfig.openaiApiKey = "test-openai-key";
  manager.shouldUsePerUserTranscription = () => true;
  const voxClient = new EventEmitter();
  voxClient.subscribeUser = () => {};
  const session = createSession({
    mode: "openai_realtime",
    realtimeInputSampleRateHz: 24_000,
    cleanupHandlers: [],
    settingsSnapshot: {
      botName: "clanky",
      voice: {
        enabled: true,
        asrEnabled: true,
        brainProvider: "anthropic"
      }
    },
    voxClient
  });
  const { appendedChunks } = seedReadyPerUserAsr(manager, session, "speaker-1");

  manager.captureManager.startInboundCapture({
    session,
    userId: "speaker-1",
    settings: session.settingsSnapshot
  });

  const noisyPcm = makeSparseMonoPcm16(
    Math.ceil((24_000 * VOICE_TURN_PROMOTION_MIN_CLIP_MS) / 1000),
    1024,
    60
  );
  voxClient.emit("userAudio", "speaker-1", noisyPcm);
  await flushMicrotasks();

  const capture = session.userCaptures.get("speaker-1");
  assert.ok(capture);
  assert.equal(Number(capture.promotedAt || 0), 0);
  capture.finalize("stream_end");

  assert.ok(Number(capture.asrUtteranceId || 0) > 0);
  assert.equal(appendedChunks.length, 1);
  assert.deepEqual(appendedChunks[0], noisyPcm);
  assert.equal(touchCalls.length, 0);
  assert.equal(logs.some((entry) => entry?.content === "voice_activity_started"), false);
  assert.equal(logs.some((entry) => entry?.content === "voice_turn_dropped_provisional_capture"), true);
});

test("bindSessionHandlers does not duplicate provisional capture creation for repeated speaking.start", () => {
  const { manager } = createManager();
  manager.appConfig.openaiApiKey = "test-openai-key";
  const voxClient = new EventEmitter();
  manager.captureManager.startInboundCapture = ({ session, userId }) => {
    if (!session.userCaptures.has(userId)) {
      session.userCaptures.set(userId, {
        speakingEndFinalizeTimer: null
      });
    }
  };

  const session = createSession({
    mode: "openai_realtime",
    cleanupHandlers: [],
    settingsSnapshot: {
      botName: "clanky",
      voice: {
        enabled: true,
        asrEnabled: true,
        brainProvider: "anthropic"
      }
    },
    voxClient
  });

  manager.sessionLifecycle.bindSessionHandlers(session, session.settingsSnapshot);
  voxClient.emit("speakingStart", "speaker-1");
  voxClient.emit("speakingStart", "speaker-1");

  assert.equal(session.userCaptures.size, 1);
});

test("commitAsrUtterance marks per-user commit in-flight before awaiting connect", async () => {
  const { manager } = createManager();
  const session = createSession({
    mode: "openai_realtime",
    openAiAsrTranscriptStableMs: 1,
    openAiAsrTranscriptWaitMaxMs: 1
  });
  const userId = "speaker-1";
  const asrState = getOrCreatePerUserAsrState(session, userId);
  assert.ok(asrState);
  let clearCalls = 0;
  let commitCalls = 0;
  const client = {
    ws: { readyState: 1 },
    clearInputAudioBuffer() {
      clearCalls += 1;
    },
    appendInputAudioPcm() {},
    commitInputAudioBuffer() {
      commitCalls += 1;
    }
  };
  asrState.utterance = {
    id: 1,
    startedAt: Date.now() - 200,
    bytesSent: 9_600,
    partialText: "",
    finalSegments: [],
    finalSegmentEntries: [],
    lastUpdateAt: Date.now() - 10
  };
  asrState.pendingAudioChunks = [{ utteranceId: 1, chunk: Buffer.alloc(9_600, 1) }];
  asrState.pendingAudioBytes = 9_600;

  let resolveConnect: (() => void) | null = null;
  const connectGate = new Promise((resolve) => {
    resolveConnect = () => {
      resolve(undefined);
    };
  });
  asrState.connectPromise = connectGate;

  const commitPromise = commitAsrUtterance(
    "per_user",
    manager.buildAsrBridgeDeps(session),
    session.settingsSnapshot,
    userId,
    "speaking_end"
  );

  assert.equal(asrState.phase, "committing");
  assert.equal(asrState.committingUtteranceId, 1);

  beginAsrUtterance("per_user", session, manager.buildAsrBridgeDeps(session), session.settingsSnapshot, userId);
  assert.equal(clearCalls, 0);

  asrState.client = client;
  resolveConnect?.();
  await commitPromise;
  assert.equal(commitCalls, 1);
});

test("bindSessionHandlers defers shared OpenAI ASR start until speech is confirmed", () => {
  const { manager } = createManager();
  manager.appConfig.openaiApiKey = "test-openai-key";
  const voxClient = new EventEmitter();
  manager.captureManager.startInboundCapture = ({ session, userId }) => {
    if (!session.userCaptures.has(userId)) {
      session.userCaptures.set(userId, {
        speakingEndFinalizeTimer: null
      });
    }
  };

  const session = createSession({
    mode: "openai_realtime",
    cleanupHandlers: [],
    settingsSnapshot: {
      botName: "clanky",
      voice: {
        enabled: true,
        asrEnabled: true,
        brainProvider: "anthropic",
        replyPath: "brain",
        openaiRealtime: {
          usePerUserAsrBridge: false
        }
      }
    },
    voxClient
  });

  manager.sessionLifecycle.bindSessionHandlers(session, session.settingsSnapshot);
  voxClient.emit("speakingStart", "speaker-1");
  voxClient.emit("speakingStart", "speaker-2");

  assert.equal(session.openAiSharedAsrState == null, true);
  assert.equal(session.userCaptures.size, 2);
});

test("shared ASR hands off to waiting speaker after commit", () => {
  const { manager, logs } = createManager();
  manager.appConfig.openaiApiKey = "test-openai-key";
  const beginCalls: Array<{ userId: string }> = [];
  const appendCalls: Array<{ userId: string; pcmChunk: Buffer }> = [];

  const session = createSession({
    mode: "openai_realtime",
    openAiSharedAsrState: {
      phase: "ready",
      userId: null,
      client: null,
      utterance: null,
      idleTimer: null,
      pendingAudioChunks: [],
      pendingAudioBytes: 0
    }
  });

  const pcmA = Buffer.alloc(960, 1);
  const pcmB = Buffer.alloc(960, 2);
  session.userCaptures.set("speaker-2", {
    userId: "speaker-2",
    promotedAt: Date.now(),
    bytesSent: pcmA.length + pcmB.length,
    sharedAsrBytesSent: 0,
    pcmChunks: [pcmA, pcmB],
    speakingEndFinalizeTimer: null
  });

  const result = runSharedAsrHandoff(manager, session, beginCalls, appendCalls);

  assert.equal(result, true);
  assert.equal(beginCalls.length, 1);
  assert.equal(beginCalls[0]?.userId, "speaker-2");
  assert.equal(appendCalls.length, 2);
  assert.equal(appendCalls[0]?.userId, "speaker-2");
  assert.deepEqual(appendCalls[0]?.pcmChunk, pcmA);
  assert.deepEqual(appendCalls[1]?.pcmChunk, pcmB);
  const handoffLog = logs.find((l) => l?.content === "openai_shared_asr_handoff");
  assert.equal(Boolean(handoffLog), true);
  assert.equal(handoffLog?.userId, "speaker-2");
});

test("shared ASR handoff skipped when no waiting captures", () => {
  const { manager } = createManager();
  manager.appConfig.openaiApiKey = "test-openai-key";
  const beginCalls: Array<{ userId: string }> = [];
  const appendCalls: Array<{ userId: string; pcmChunk: Buffer }> = [];

  const session = createSession({
    mode: "openai_realtime",
    openAiSharedAsrState: {
      phase: "ready",
      userId: null,
      client: null,
      utterance: null,
      idleTimer: null,
      pendingAudioChunks: [],
      pendingAudioBytes: 0
    }
  });

  const result = runSharedAsrHandoff(manager, session, beginCalls, appendCalls);

  assert.equal(result, false);
  assert.equal(beginCalls.length, 0);
  assert.equal(appendCalls.length, 0);
});

test("shared ASR handoff skips provisional captures that never promoted", () => {
  const { manager } = createManager();
  manager.appConfig.openaiApiKey = "test-openai-key";
  const beginCalls: Array<{ userId: string }> = [];
  const appendCalls: Array<{ userId: string; pcmChunk: Buffer }> = [];

  const session = createSession({
    mode: "openai_realtime",
    openAiSharedAsrState: {
      phase: "ready",
      userId: null,
      client: null,
      utterance: null,
      idleTimer: null,
      pendingAudioChunks: [],
      pendingAudioBytes: 0
    }
  });

  session.userCaptures.set("speaker-provisional", {
    userId: "speaker-provisional",
    promotedAt: 0,
    bytesSent: 960,
    sharedAsrBytesSent: 0,
    pcmChunks: [Buffer.alloc(960, 7)],
    speakingEndFinalizeTimer: null
  });

  const result = runSharedAsrHandoff(manager, session, beginCalls, appendCalls);

  assert.equal(result, false);
  assert.equal(beginCalls.length, 0);
  assert.equal(appendCalls.length, 0);
});

test("shared ASR handoff skips captures that already had ASR audio", () => {
  const { manager } = createManager();
  manager.appConfig.openaiApiKey = "test-openai-key";
  const beginCalls: Array<{ userId: string }> = [];
  const appendCalls: Array<{ userId: string; pcmChunk: Buffer }> = [];

  const session = createSession({
    mode: "openai_realtime",
    openAiSharedAsrState: {
      phase: "ready",
      userId: null,
      client: null,
      utterance: null,
      idleTimer: null,
      pendingAudioChunks: [],
      pendingAudioBytes: 0
    }
  });

  session.userCaptures.set("speaker-already-had-asr", {
    userId: "speaker-already-had-asr",
    promotedAt: Date.now(),
    bytesSent: 4800,
    sharedAsrBytesSent: 4800,
    pcmChunks: [Buffer.alloc(960, 3)],
    speakingEndFinalizeTimer: null
  });
  const freshPcm = Buffer.alloc(960, 4);
  session.userCaptures.set("speaker-fresh", {
    userId: "speaker-fresh",
    promotedAt: Date.now(),
    bytesSent: freshPcm.length,
    sharedAsrBytesSent: 0,
    pcmChunks: [freshPcm],
    speakingEndFinalizeTimer: null
  });

  const result = runSharedAsrHandoff(manager, session, beginCalls, appendCalls);

  assert.equal(result, true);
  assert.equal(beginCalls.length, 1);
  assert.equal(beginCalls[0]?.userId, "speaker-fresh");
  assert.equal(appendCalls.length, 1);
  assert.deepEqual(appendCalls[0]?.pcmChunk, freshPcm);
});

test("shared ASR handoff skips zero-audio captures and selects buffered speaker", () => {
  const { manager, logs } = createManager();
  manager.appConfig.openaiApiKey = "test-openai-key";
  const beginCalls: Array<{ userId: string }> = [];
  const appendCalls: Array<{ userId: string; pcmChunk: Buffer }> = [];

  const session = createSession({
    mode: "openai_realtime",
    openAiSharedAsrState: {
      phase: "ready",
      userId: null,
      client: null,
      utterance: null,
      idleTimer: null,
      pendingAudioChunks: [],
      pendingAudioBytes: 0
    }
  });

  session.userCaptures.set("speaker-empty", {
    userId: "speaker-empty",
    promotedAt: Date.now(),
    bytesSent: 0,
    sharedAsrBytesSent: 0,
    pcmChunks: [],
    speakingEndFinalizeTimer: null
  });
  const bufferedPcm = Buffer.alloc(960, 7);
  session.userCaptures.set("speaker-buffered", {
    userId: "speaker-buffered",
    promotedAt: Date.now(),
    bytesSent: bufferedPcm.length,
    sharedAsrBytesSent: 0,
    pcmChunks: [bufferedPcm],
    speakingEndFinalizeTimer: null
  });

  const result = runSharedAsrHandoff(manager, session, beginCalls, appendCalls);

  assert.equal(result, true);
  assert.equal(beginCalls.length, 1);
  assert.equal(beginCalls[0]?.userId, "speaker-buffered");
  assert.equal(appendCalls.length, 1);
  assert.equal(appendCalls[0]?.userId, "speaker-buffered");
  assert.deepEqual(appendCalls[0]?.pcmChunk, bufferedPcm);
  const handoffLog = logs.find((l) => l?.content === "openai_shared_asr_handoff");
  assert.equal(handoffLog?.userId, "speaker-buffered");
});

test("shared ASR committed events resolve waiters by commit user instead of FIFO", () => {
  createManager();
  const resolvedItemIds = [];
  const session = createSession({
    mode: "openai_realtime",
    openAiSharedAsrState: {
      phase: "ready",
      userId: null,
      client: null,
      utterance: null,
      idleTimer: null,
      pendingAudioChunks: [],
      pendingAudioBytes: 0,
      itemIdToUserId: new Map(),
      finalTranscriptsByItemId: new Map(),
      pendingCommitResolvers: [],
      pendingCommitRequests: []
    }
  });
  const asrState = session.openAiSharedAsrState;
  asrState.pendingCommitResolvers.push({
    id: "waiter-speaker-2",
    userId: "speaker-2",
    resolve: (itemId) => {
      resolvedItemIds.push(String(itemId || ""));
    }
  });
  asrState.pendingCommitRequests.push({
    id: "request-speaker-1",
    userId: "speaker-1",
    requestedAt: Date.now()
  });

  trackSharedAsrCommittedItem(asrState as AsrBridgeState, "item-speaker-1");

  assert.deepEqual(resolvedItemIds, []);
  assert.equal(asrState.pendingCommitResolvers.length, 1);
  assert.equal(asrState.itemIdToUserId.get("item-speaker-1"), "speaker-1");

  asrState.pendingCommitRequests.push({
    id: "request-speaker-2",
    userId: "speaker-2",
    requestedAt: Date.now()
  });
  trackSharedAsrCommittedItem(asrState as AsrBridgeState, "item-speaker-2");

  assert.deepEqual(resolvedItemIds, ["item-speaker-2"]);
  assert.equal(asrState.pendingCommitResolvers.length, 0);
  assert.equal(asrState.itemIdToUserId.get("item-speaker-2"), "speaker-2");
});

test("commitAsrUtterance (shared) preserves already-received final segments when commit item is empty", async () => {
  const logs: Record<string, unknown>[] = [];
  let commitCalls = 0;

  const session = createSession({
    mode: "openai_realtime",
    realtimeInputSampleRateHz: 24_000,
    // Set very short wait times so the test doesn't block on commit/transcript polling
    openAiAsrTranscriptStableMs: 10,
    openAiAsrTranscriptWaitMaxMs: 50,
    openAiSharedAsrState: {
      phase: "ready",
      userId: "speaker-1",
      client: {
        ws: { readyState: 1 },
        commitInputAudioBuffer() {
          commitCalls += 1;
        }
      },
      connectPromise: null,
      connectedAt: Date.now(),
      lastAudioAt: 0,
      lastTranscriptAt: 0,
      lastPartialLogAt: 0,
      lastPartialText: "",
      idleTimer: null,
      pendingAudioChunks: [],
      pendingAudioBytes: 0,
      committingUtteranceId: 0,
      pendingCommitResolvers: [],
      pendingCommitRequests: [],
      itemIdToUserId: new Map(),
      finalTranscriptsByItemId: new Map(),
      utterance: {
        id: 1,
        startedAt: Date.now() - 1_000,
        bytesSent: DISCORD_PCM_FRAME_BYTES * 2,
        partialText: "",
        finalSegments: ["What's goin'?"],
        finalSegmentEntries: [
          {
            itemId: "item_1",
            previousItemId: null,
            text: "What's goin'?",
            receivedAt: Date.now() - 300
          }
        ],
        lastUpdateAt: Date.now() - 300
      }
    }
  });

  const deps = {
    session,
    appConfig: { openaiApiKey: "test-openai-key" },
    store: {
      logAction(entry: Record<string, unknown>) { logs.push(entry); },
      getSettings() { return session.settingsSnapshot; }
    },
    botUserId: "bot-user",
    resolveVoiceSpeakerName: () => "speaker-1"
  };

  const result = await commitAsrUtterance("shared", deps, session.settingsSnapshot, "speaker-1", "stream_end");

  assert.equal(commitCalls, 1);
  assert.equal(result?.transcript, "What's goin'?");
  assert.equal(logs.some((entry) => entry?.content === "voice_realtime_transcription_empty"), false);
});

test("playVoiceReplyInOrder does not fallback to TTS when realtime utterance fails", async () => {
  const { manager } = createManager();
  const session = createSession({
    mode: "openai_realtime"
  });
  let ttsCalls = 0;

  manager.requestRealtimeTextUtterance = () => false;
  manager.speakVoiceLineWithTts = async () => {
    ttsCalls += 1;
    return true;
  };

  const result = await manager.playVoiceReplyInOrder({
    session,
    settings: session.settingsSnapshot,
    spokenText: "hello there",
    playbackSteps: [
      {
        type: "speech",
        text: "hello there"
      }
    ],
    source: "test_reply",
    preferRealtimeUtterance: true
  });

  assert.equal(result.completed, false);
  assert.equal(result.requestedRealtimeUtterance, false);
  assert.equal(result.spokeLine, false);
  assert.equal(ttsCalls, 0);
});

test("playVoiceReplyInOrder preserves inline soundboard sequencing on buffered playback", async () => {
  const { manager } = createManager();
  const session = createSession({
    settingsSnapshot: createTestSettings({
      botName: "clanky",
      voice: {
        soundboard: {
          enabled: true,
          preferredSoundIds: ["airhorn@123", "rimshot@456"]
        }
      }
    })
  });
  const eventOrder: string[] = [];
  manager.speakVoiceLineWithTts = async ({ text }) => {
    eventOrder.push(`speech:${String(text)}`);
    return true;
  };
  manager.waitForLeaveDirectivePlayback = async () => {};
  manager.soundboardDirector.play = async ({ soundId, sourceGuildId }) => {
    eventOrder.push(`sound:${sourceGuildId ? `${soundId}@${sourceGuildId}` : soundId}`);
    return { ok: true };
  };

  const playbackPlan = manager.buildVoiceReplyPlaybackPlan({
    replyText: "yo [[SOUNDBOARD:airhorn@123]] hold up [[SOUNDBOARD:rimshot@456]] done"
  });
  const result = await manager.playVoiceReplyInOrder({
    session,
    settings: session.settingsSnapshot,
    spokenText: playbackPlan.spokenText,
    playbackSteps: playbackPlan.steps,
    source: "test_reply",
    preferRealtimeUtterance: false
  });

  assert.equal(result.completed, true);
  assert.equal(result.spokeLine, true);
  assert.equal(result.requestedRealtimeUtterance, false);
  assert.equal(result.playedSoundboardCount, 2);
  assert.deepEqual(eventOrder, [
    "speech:yo",
    "sound:airhorn@123",
    "speech:hold up",
    "sound:rimshot@456",
    "speech:done"
  ]);
});

test("playVoiceReplyInOrder waits for prior realtime playback before a soundboard-only ordered chunk", async () => {
  const { manager } = createManager();
  const eventOrder: string[] = [];
  const session = createSession({
    mode: "openai_realtime",
    botTurnOpen: true,
    lastAudioDeltaAt: Date.now() - 200,
    pendingResponse: {
      requestId: 4,
      userId: "bot-user",
      requestedAt: Date.now() - 200,
      retryCount: 0,
      hardRecoveryAttempted: false,
      source: "realtime:stream_chunk_7",
      handlingSilence: false,
      audioReceivedAt: Date.now() - 150,
      interruptionPolicy: null,
      utteranceText: "earlier chunk",
      latencyContext: null
    },
    settingsSnapshot: createTestSettings({
      botName: "clanky",
      voice: {
        soundboard: {
          enabled: true,
          preferredSoundIds: ["airhorn@123"]
        }
      }
    })
  });
  manager.replyManager.isRealtimeResponseActive = () => Boolean(session.pendingResponse);
  manager.replyManager.hasBufferedTtsPlayback = () => Boolean(session.botTurnOpen);
  manager.replyManager.getBufferedTtsSamples = () => (session.botTurnOpen ? 24_000 : 0);
  manager.soundboardDirector.play = async ({ soundId, sourceGuildId }) => {
    eventOrder.push(`sound:${sourceGuildId ? `${soundId}@${sourceGuildId}` : soundId}`);
    return { ok: true };
  };

  setTimeout(() => {
    eventOrder.push("earlier_done");
    session.pendingResponse = null;
    session.botTurnOpen = false;
  }, 35);

  const result = await manager.playVoiceReplyInOrder({
    session,
    settings: session.settingsSnapshot,
    spokenText: "",
    playbackSteps: [
      {
        type: "soundboard",
        reference: "airhorn@123"
      }
    ],
    source: "test_reply",
    preferRealtimeUtterance: true
  });

  assert.equal(result.completed, true);
  assert.equal(result.spokeLine, false);
  assert.equal(result.playedSoundboardCount, 1);
  assert.deepEqual(eventOrder, [
    "earlier_done",
    "sound:airhorn@123"
  ]);
});

test("playVoiceReplyInOrder waits for the current realtime speech segment before the following soundboard", async () => {
  const { manager } = createManager();
  const eventOrder: string[] = [];
  const session = createSession({
    mode: "openai_realtime",
    realtimeClient: {},
    settingsSnapshot: createTestSettings({
      botName: "clanky",
      voice: {
        soundboard: {
          enabled: true,
          preferredSoundIds: ["airhorn@123"]
        }
      }
    })
  });
  manager.replyManager.isRealtimeResponseActive = () => Boolean(session.pendingResponse);
  manager.replyManager.hasBufferedTtsPlayback = () => Boolean(session.botTurnOpen);
  manager.replyManager.getBufferedTtsSamples = () => (session.botTurnOpen ? 24_000 : 0);
  manager.requestRealtimeTextUtterance = ({ source }) => {
    eventOrder.push(`request:${String(source)}`);
    const requestedAt = Date.now();
    session.pendingResponse = {
      requestId: 9,
      userId: "bot-user",
      requestedAt,
      retryCount: 0,
      hardRecoveryAttempted: false,
      source: String(source || "voice_reply"),
      handlingSilence: false,
      audioReceivedAt: 0,
      interruptionPolicy: null,
      utteranceText: "lead in",
      latencyContext: null
    };
    session.lastResponseRequestAt = requestedAt;
    setTimeout(() => {
      eventOrder.push("speech_audio_started");
      session.lastAudioDeltaAt = Date.now();
      session.botTurnOpen = true;
      setTimeout(() => {
        eventOrder.push("speech_done");
        session.pendingResponse = null;
        session.botTurnOpen = false;
      }, 20);
    }, 10);
    return true;
  };
  manager.soundboardDirector.play = async ({ soundId, sourceGuildId }) => {
    eventOrder.push(`sound:${sourceGuildId ? `${soundId}@${sourceGuildId}` : soundId}`);
    return { ok: true };
  };

  const result = await manager.playVoiceReplyInOrder({
    session,
    settings: session.settingsSnapshot,
    spokenText: "lead in",
    playbackSteps: [
      {
        type: "speech",
        text: "lead in"
      },
      {
        type: "soundboard",
        reference: "airhorn@123"
      }
    ],
    source: "test_reply",
    preferRealtimeUtterance: true
  });

  assert.equal(result.completed, true);
  assert.equal(result.spokeLine, true);
  assert.equal(result.requestedRealtimeUtterance, true);
  assert.equal(result.playedSoundboardCount, 1);
  assert.deepEqual(eventOrder, [
    "request:test_reply:speech_1",
    "speech_audio_started",
    "speech_done",
    "sound:airhorn@123"
  ]);
});

test("playVoiceReplyInOrder does not stall on bot turn tail flags after targeted realtime speech finishes", async () => {
  const { manager } = createManager();
  const eventOrder: string[] = [];
  const session = createSession({
    mode: "openai_realtime",
    realtimeClient: {},
    settingsSnapshot: createTestSettings({
      botName: "clanky",
      voice: {
        soundboard: {
          enabled: true,
          preferredSoundIds: ["airhorn@123"]
        }
      }
    })
  });
  manager.replyManager.isRealtimeResponseActive = () => Boolean(session.pendingResponse);
  manager.replyManager.hasBufferedTtsPlayback = () => Boolean(session.botTurnOpen);
  manager.replyManager.getBufferedTtsSamples = () => (session.botTurnOpen ? 24_000 : 0);
  manager.replyManager.syncAssistantOutputState = () => session.assistantOutput;
  manager.requestRealtimeTextUtterance = ({ source }) => {
    eventOrder.push(`request:${String(source)}`);
    const requestedAt = Date.now();
    session.pendingResponse = {
      requestId: 9,
      userId: "bot-user",
      requestedAt,
      retryCount: 0,
      hardRecoveryAttempted: false,
      source: String(source || "voice_reply"),
      handlingSilence: false,
      audioReceivedAt: 0,
      interruptionPolicy: null,
      utteranceText: "lead in",
      latencyContext: null
    };
    session.lastResponseRequestAt = requestedAt;
    session.assistantOutput = {
      ...session.assistantOutput,
      phase: "response_pending",
      reason: "pending_response",
      requestId: 9,
      lastSyncedAt: requestedAt
    };
    setTimeout(() => {
      eventOrder.push("speech_audio_started");
      session.lastAudioDeltaAt = Date.now();
      session.botTurnOpen = true;
      session.assistantOutput = {
        ...session.assistantOutput,
        phase: "speaking_live",
        reason: "bot_audio_live",
        requestId: 9,
        lastSyncedAt: Date.now()
      };
      setTimeout(() => {
        eventOrder.push("speech_done");
        session.pendingResponse = null;
        session.assistantOutput = {
          ...session.assistantOutput,
          phase: "idle",
          reason: "idle",
          requestId: null,
          lastSyncedAt: Date.now()
        };
        setTimeout(() => {
          eventOrder.push("tail_cleared");
          session.botTurnOpen = false;
        }, 80);
      }, 20);
    }, 10);
    return true;
  };
  manager.soundboardDirector.play = async ({ soundId, sourceGuildId }) => {
    eventOrder.push(`sound:${sourceGuildId ? `${soundId}@${sourceGuildId}` : soundId}`);
    return { ok: true };
  };

  const result = await manager.playVoiceReplyInOrder({
    session,
    settings: session.settingsSnapshot,
    spokenText: "lead in",
    playbackSteps: [
      {
        type: "speech",
        text: "lead in"
      },
      {
        type: "soundboard",
        reference: "airhorn@123"
      }
    ],
    source: "test_reply",
    preferRealtimeUtterance: true
  });

  assert.equal(result.completed, true);
  assert.equal(result.spokeLine, true);
  assert.equal(result.requestedRealtimeUtterance, true);
  assert.equal(result.playedSoundboardCount, 1);
  assert.deepEqual(eventOrder, [
    "request:test_reply:speech_1",
    "speech_audio_started",
    "speech_done",
    "sound:airhorn@123"
  ]);
});

test("collapsePendingRealtimeAssistantStreamTail leaves ordered soundboard chunk speech steps untouched", () => {
  const { manager } = createManager();
  const session = createSession({
    mode: "openai_realtime",
    pendingRealtimeAssistantUtterances: [
      {
        prompt: "say exactly: Check this out.",
        utteranceText: "Check this out.",
        userId: "bot-user",
        source: "realtime:stream_chunk_2:speech_1",
        queuedAt: Date.now() - 50,
        interruptionPolicy: null,
        musicWakeRefreshAfterSpeech: false,
        latencyContext: null
      },
      {
        prompt: "say exactly: That's the rizz right there.",
        utteranceText: "That's the rizz right there.",
        userId: "bot-user",
        source: "realtime:stream_chunk_2:speech_2",
        queuedAt: Date.now() - 25,
        interruptionPolicy: null,
        musicWakeRefreshAfterSpeech: false,
        latencyContext: null
      }
    ]
  });

  const collapsedCount = manager.collapsePendingRealtimeAssistantStreamTail({
    session,
    source: "realtime"
  });

  assert.equal(collapsedCount, 0);
  assert.deepEqual(
    manager.getPendingRealtimeAssistantUtterances(session).map((entry) => entry.source),
    [
      "realtime:stream_chunk_2:speech_1",
      "realtime:stream_chunk_2:speech_2"
    ]
  );
});

test("runRealtimeBrainReply treats revised-turn aborts as nonfatal", async () => {
  const { manager } = createManager();
  manager.activeReplies = new ActiveReplyRegistry();
  manager.getVoiceChannelParticipants = () => [{ userId: "speaker-1", displayName: "alice" }];
  manager.instructionManager.prepareRealtimeTurnContext = async () => {};
  manager.generateVoiceTurn = ({ signal }) =>
    new Promise((_resolve, reject) => {
      const abort = () => reject(createAbortError(signal?.reason || "Superseded by revised ASR transcript"));
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
    });

  const session = createSession({
    id: "session-revised-turn-abort-1",
    mode: "openai_realtime",
    realtimeClient: {}
  });

  const replyPromise = manager.runRealtimeBrainReply({
    session,
    settings: session.settingsSnapshot,
    userId: "speaker-1",
    transcript: "you call it",
    directAddressed: true,
    source: "realtime"
  });

  setTimeout(() => {
    manager.activeReplies?.abortAll(
      buildVoiceReplyScopeKey(session.id),
      "Superseded by revised ASR transcript"
    );
  }, 0);

  const result = await replyPromise;
  assert.equal(result, false);
});

test("playVoiceReplyInOrder seeds assistant-targeted interruption policy for local TTS playback", async () => {
  const { manager } = createManager();
  manager.speakVoiceLineWithTts = async () => true;
  const session = createSession({
    mode: "file_wav",
    activeReplyInterruptionPolicy: null
  });

  const result = await manager.playVoiceReplyInOrder({
    session,
    settings: session.settingsSnapshot,
    spokenText: "nah bob, the other one",
    playbackSteps: [
      { type: "speech", text: "nah bob, the other one" }
    ],
    source: "voice_reply",
    preferRealtimeUtterance: false,
    interruptionPolicy: {
      assertive: true,
      scope: "speaker",
      allowedUserId: "speaker-2",
      talkingTo: "bob",
      source: "assistant_reply_target",
      reason: "assistant_target_speaker"
    }
  });

  assert.deepEqual(result, {
    completed: true,
    spokeLine: true,
    requestedRealtimeUtterance: false,
    playedSoundboardCount: 0
  });
  assert.deepEqual(session.activeReplyInterruptionPolicy, {
    assertive: true,
    scope: "speaker",
    allowedUserId: "speaker-2",
    talkingTo: "bob",
    source: "assistant_reply_target",
    reason: "assistant_target_speaker"
  });
});

test("deliverVoiceThoughtCandidate does not fallback to TTS in realtime mode", async () => {
  const { manager } = createManager();
  const session = createSession({
    mode: "openai_realtime"
  });
  let ttsCalls = 0;

  manager.requestRealtimeTextUtterance = () => false;
  manager.speakVoiceLineWithTts = async () => {
    ttsCalls += 1;
    return true;
  };

  const delivered = await manager.deliverVoiceThoughtCandidate({
    session,
    settings: session.settingsSnapshot,
    thoughtCandidate: "ambient thought"
  });

  assert.equal(delivered, false);
  assert.equal(ttsCalls, 0);
});

test("requestRealtimeCodeTaskFollowup injects async code task completion into realtime session", () => {
  const { manager, logs } = createManager();
  const prompts: string[] = [];
  const session = createSession({
    mode: "openai_realtime",
    realtimeClient: {
      requestTextUtterance(prompt: string) {
        prompts.push(prompt);
      },
      isResponseInProgress() {
        return false;
      }
    }
  });
  manager.sessions.set(session.guildId, session as unknown as VoiceSession);

  const delivered = manager.requestRealtimeCodeTaskFollowup({
    guildId: session.guildId,
    channelId: session.textChannelId,
    prompt: "[CODE TASK COMPLETED]\nSession: code:guild-1:text-1:123\nResult:\nUpdated auth module.",
    userId: "user-1",
    source: "voice_realtime_code_task_result_followup"
  });

  assert.equal(delivered, true);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0] || "", /\[CODE TASK COMPLETED\]/i);
  assert.equal(session.lastRealtimeToolCallerUserId, "user-1");
  const logEntry = logs.find((entry) => entry?.content === "realtime_async_code_task_followup_enqueued");
  assert.equal(Boolean(logEntry), true);
});

test("requestRealtimeCodeTaskFollowup skips when channel does not match active session", () => {
  const { manager, logs } = createManager();
  const session = createSession({
    mode: "openai_realtime",
    realtimeClient: {
      requestTextUtterance() {
        throw new Error("should not be called");
      },
      isResponseInProgress() {
        return false;
      }
    }
  });
  manager.sessions.set(session.guildId, session as unknown as VoiceSession);

  const delivered = manager.requestRealtimeCodeTaskFollowup({
    guildId: session.guildId,
    channelId: "different-text-channel",
    prompt: "[CODE TASK COMPLETED]\nSession: code:guild-1:text-1:123",
    userId: "user-1",
    source: "voice_realtime_code_task_result_followup"
  });

  assert.equal(delivered, false);
  const logEntry = logs.find((entry) => entry?.content === "realtime_async_code_task_followup_skipped");
  assert.equal(Boolean(logEntry), false);
});

test("requestRealtimeCodeTaskFollowup uses realtime text transport when playback transport is available", () => {
  const { manager } = createManager();
  let textCalls = 0;
  let playbackCalls = 0;
  const session = createSession({
    mode: "openai_realtime",
    realtimeClient: {
      requestTextUtterance() {
        textCalls += 1;
      },
      requestPlaybackUtterance() {
        playbackCalls += 1;
      },
      isResponseInProgress() {
        return false;
      }
    }
  });
  manager.sessions.set(session.guildId, session as unknown as VoiceSession);

  const delivered = manager.requestRealtimeCodeTaskFollowup({
    guildId: session.guildId,
    channelId: session.textChannelId,
    prompt: "[CODE TASK COMPLETED]\nSession: code:guild-1:text-1:123",
    userId: "user-1",
    source: "voice_realtime_code_task_result_followup"
  });

  assert.equal(delivered, true);
  assert.equal(textCalls, 1);
  assert.equal(playbackCalls, 0);
});

test("requestRealtimeTextUtterance queues assistant speech behind an active realtime response", () => {
  const { manager, logs } = createManager();
  const prompts = [];
  const session = createSession({
    mode: "openai_realtime",
    realtimeClient: {
      requestTextUtterance(prompt) {
        prompts.push(prompt);
      },
      isResponseInProgress() {
        return true;
      }
    },
    pendingResponse: {
      requestId: 4,
      userId: "bot-user",
      requestedAt: Date.now() - 1_000,
      retryCount: 0,
      hardRecoveryAttempted: false,
      source: "test_active_reply",
      handlingSilence: false,
      audioReceivedAt: 0,
      interruptionPolicy: null,
      utteranceText: "first chunk",
      latencyContext: null
    }
  });

  const requested = manager.requestRealtimeTextUtterance({
    session,
    text: "second chunk",
    source: "test_stream_chunk_1"
  });

  assert.equal(requested, true);
  assert.equal(prompts.length, 0);
  assert.equal(session.pendingRealtimeAssistantUtterances?.length, 1);
  assert.equal(session.pendingRealtimeAssistantUtterances?.[0]?.utteranceText, "second chunk");
  const queuedLog = logs.find((entry) => entry?.content === "realtime_assistant_utterance_queued");
  assert.equal(Boolean(queuedLog), true);
  assert.deepEqual(queuedLog?.metadata?.blockers, ["active_response", "pending_response"]);
  assert.equal(queuedLog?.metadata?.activeResponse, true);
  assert.equal(queuedLog?.metadata?.pendingResponse, true);
  assert.equal(queuedLog?.metadata?.pendingResponseRequestId, 4);
  assert.equal(queuedLog?.metadata?.pendingResponseSource, "test_active_reply");
  assert.equal(queuedLog?.metadata?.outputLockReason, "pending_response");
});

test("requestRealtimeTextUtterance prefers playback-specific realtime client method when available", () => {
  const { manager } = createManager();
  const textPrompts = [];
  const playbackPrompts = [];
  const session = createSession({
    mode: "openai_realtime",
    realtimeClient: {
      requestTextUtterance(prompt) {
        textPrompts.push(prompt);
      },
      requestPlaybackUtterance(prompt) {
        playbackPrompts.push(prompt);
      },
      isResponseInProgress() {
        return false;
      }
    }
  });

  const requested = manager.requestRealtimeTextUtterance({
    session,
    text: "Say less, let me pull that up real quick.",
    source: "voice_web_lookup:busy_utterance"
  });

  assert.equal(requested, true);
  assert.deepEqual(textPrompts, []);
  assert.equal(playbackPrompts.length, 1);
});

test("utterance fires immediately during promoted capture (floor-taking symmetry)", async () => {
  const { manager } = createManager();
  manager.shouldUsePerUserTranscription = () => false;
  manager.shouldUseSharedTranscription = () => false;
  const prompts = [];
  const queuedTurns = [];
  const voxClient = new EventEmitter();
  voxClient.subscribeUser = () => {};
  manager.turnProcessor.queueRealtimeTurn = (payload) => {
    queuedTurns.push(payload);
  };
  const session = createSession({
    mode: "openai_realtime",
    cleanupHandlers: [],
    settingsSnapshot: createTestSettings({
      botName: "clanky",
      voice: {
        enabled: true,
        asrEnabled: true,
        brainProvider: "anthropic"
      }
    }),
    voxClient,
    realtimeClient: {
      requestTextUtterance(prompt) {
        prompts.push(prompt);
      },
      isResponseInProgress() {
        return false;
      }
    }
  });

  manager.captureManager.startInboundCapture({
    session,
    userId: "speaker-1",
    settings: session.settingsSnapshot
  });

  const speechPcm = makeMonoPcm16(Math.ceil((24_000 * (VOICE_TURN_PROMOTION_MIN_CLIP_MS + 40)) / 1000), 3000);
  voxClient.emit("userAudio", "speaker-1", speechPcm);
  await flushMicrotasks();

  // Active captures (even promoted ones) no longer block bot speech.
  const queued = manager.requestRealtimeTextUtterance({
    session,
    text: "old queued line",
    source: "test_promoted_capture_queue"
  });

  assert.equal(queued, true);
  // Utterance fires immediately — not deferred.
  assert.equal(prompts.length, 1);
  assert.match(prompts[0] || "", /old queued line/i);
});

test("handleResponseDone drains queued assistant speech after realtime audio completes", () => {
  const { manager, logs } = createManager();
  const prompts = [];
  let activeResponse = true;
  const session = createSession({
    mode: "openai_realtime",
    realtimeClient: {
      requestTextUtterance(prompt) {
        prompts.push(prompt);
      },
      isResponseInProgress() {
        return activeResponse;
      }
    },
    pendingResponse: {
      requestId: 5,
      userId: "bot-user",
      requestedAt: Date.now() - 1_500,
      retryCount: 0,
      hardRecoveryAttempted: false,
      source: "test_active_reply",
      handlingSilence: false,
      audioReceivedAt: 0,
      interruptionPolicy: null,
      utteranceText: "first chunk",
      latencyContext: null
    }
  });

  const queued = manager.requestRealtimeTextUtterance({
    session,
    text: "second chunk",
    source: "test_stream_chunk_1"
  });
  assert.equal(queued, true);
  assert.equal(session.pendingRealtimeAssistantUtterances?.length, 1);

  activeResponse = false;
  session.lastAudioDeltaAt = Date.now();
  manager.replyManager.handleResponseDone({
    session,
    event: {
      response: {
        id: "resp_test_1",
        status: "completed"
      }
    }
  });

  assert.equal(prompts.length, 1);
  assert.match(prompts[0] || "", /second chunk/);
  assert.equal(session.pendingRealtimeAssistantUtterances?.length, 0);
  assert.equal(Number(session.pendingResponse?.requestId || 0) > 0, true);
  assert.equal(session.pendingResponse?.utteranceText, "second chunk");
  assert.equal(logs.some((entry) => entry?.content === "realtime_assistant_utterance_queue_drained"), true);
});

test("drainPendingRealtimeAssistantUtterances logs blocker attribution when playback is still blocked", () => {
  const { manager, logs } = createManager();
  let activeResponse = true;
  const session = createSession({
    mode: "openai_realtime",
    realtimeClient: {
      isResponseInProgress() {
        return activeResponse;
      }
    },
    pendingResponse: {
      requestId: 9,
      userId: "bot-user",
      requestedAt: Date.now() - 500,
      retryCount: 0,
      hardRecoveryAttempted: false,
      source: "test_blocked_reply",
      handlingSilence: false,
      audioReceivedAt: 0,
      interruptionPolicy: null,
      utteranceText: "first chunk",
      latencyContext: null
    },
    pendingRealtimeAssistantUtterances: [
      {
        prompt: "queued prompt",
        utteranceText: "queued prompt",
        userId: "bot-user",
        source: "test_stream_chunk_queued",
        queuedAt: Date.now(),
        interruptionPolicy: null,
        latencyContext: null
      }
    ]
  });

  const drained = manager.drainPendingRealtimeAssistantUtterances(session, "response_done_had_audio");

  assert.equal(drained, false);
  const blockedLog = logs.find((entry) => entry?.content === "realtime_assistant_utterance_drain_blocked");
  assert.equal(Boolean(blockedLog), true);
  assert.deepEqual(blockedLog?.metadata?.blockers, ["active_response", "pending_response"]);
  assert.equal(blockedLog?.metadata?.reason, "response_done_had_audio");
  assert.equal(blockedLog?.metadata?.source, "test_stream_chunk_queued");
  assert.equal(blockedLog?.metadata?.queueDepth, 1);
  assert.equal(blockedLog?.metadata?.pendingResponseRequestId, 9);
  assert.equal(blockedLog?.metadata?.pendingResponseSource, "test_blocked_reply");
  assert.equal(blockedLog?.metadata?.outputLockReason, "pending_response");
  assert.equal(blockedLog?.metadata?.backpressureActive, false);

  activeResponse = false;
  const drainedAfterActiveResponseCleared = manager.drainPendingRealtimeAssistantUtterances(
    session,
    "response_done_had_audio"
  );
  assert.equal(drainedAfterActiveResponseCleared, false);
  const blockedLogs = logs.filter((entry) => entry?.content === "realtime_assistant_utterance_drain_blocked");
  assert.equal(blockedLogs.length, 2);
  assert.deepEqual(blockedLogs[1]?.metadata?.blockers, ["pending_response"]);
});

test("requestRealtimeTextUtterance queues assistant speech when clankvox playback backlog is already high", () => {
  const { manager, logs } = createManager();
  const prompts = [];
  const voxClient = {
    ttsBufferDepthSamples: REALTIME_ASSISTANT_TTS_BACKPRESSURE_PAUSE_SAMPLES,
    getTtsBufferDepthSamples() {
      return this.ttsBufferDepthSamples;
    },
    getTtsTelemetryUpdatedAt() {
      return Date.now();
    }
  };
  const session = createSession({
    mode: "openai_realtime",
    voxClient,
    realtimeClient: {
      requestTextUtterance(prompt) {
        prompts.push(prompt);
      },
      isResponseInProgress() {
        return false;
      }
    }
  });

  const requested = manager.requestRealtimeTextUtterance({
    session,
    text: "third chunk",
    source: "test_stream_chunk_2"
  });

  assert.equal(requested, true);
  assert.equal(prompts.length, 0);
  assert.equal(session.pendingRealtimeAssistantUtterances?.length, 1);
  assert.equal(session.realtimeAssistantUtteranceBackpressureActive, true);
  assert.equal(
    logs.some((entry) => entry?.content === "realtime_assistant_utterance_backpressure_on"),
    true
  );
});

test("buffer depth updates release queued assistant speech once clankvox playback backlog recovers", () => {
  const { manager, logs } = createManager();
  const prompts = [];
  let activeResponse = true;
  const voxClient = Object.assign(new EventEmitter(), {
    ttsBufferDepthSamples: REALTIME_ASSISTANT_TTS_BACKPRESSURE_PAUSE_SAMPLES + 24_000,
    getTtsBufferDepthSamples() {
      return this.ttsBufferDepthSamples;
    },
    getTtsTelemetryUpdatedAt() {
      return Date.now();
    },
    getTtsPlaybackState() {
      return this.ttsBufferDepthSamples > 0 ? "buffered" : "idle";
    },
    getPlaybackArmedReason() {
      return null;
    }
  });
  const session = createSession({
    mode: "openai_realtime",
    voxClient,
    realtimeClient: {
      requestTextUtterance(prompt) {
        prompts.push(prompt);
      },
      isResponseInProgress() {
        return activeResponse;
      }
    },
    pendingResponse: {
      requestId: 5,
      userId: "bot-user",
      requestedAt: Date.now() - 1_500,
      retryCount: 0,
      hardRecoveryAttempted: false,
      source: "test_active_reply",
      handlingSilence: false,
      audioReceivedAt: 0,
      interruptionPolicy: null,
      utteranceText: "first chunk",
      latencyContext: null
    }
  });

  manager.sessionLifecycle.bindVoxHandlers(session);

  const queued = manager.requestRealtimeTextUtterance({
    session,
    text: "second chunk",
    source: "test_stream_chunk_1"
  });
  assert.equal(queued, true);

  activeResponse = false;
  session.lastAudioDeltaAt = Date.now();
  manager.replyManager.handleResponseDone({
    session,
    event: {
      response: {
        id: "resp_test_1",
        status: "completed"
      }
    }
  });

  assert.equal(prompts.length, 0);
  assert.equal(session.pendingRealtimeAssistantUtterances?.length, 1);
  assert.equal(session.realtimeAssistantUtteranceBackpressureActive, true);

  voxClient.ttsBufferDepthSamples = REALTIME_ASSISTANT_TTS_BACKPRESSURE_RESUME_SAMPLES;
  voxClient.emit("bufferDepth", voxClient.ttsBufferDepthSamples, 0);

  assert.equal(prompts.length, 1);
  assert.match(prompts[0] || "", /second chunk/);
  assert.equal(session.pendingRealtimeAssistantUtterances?.length, 0);
  assert.equal(session.realtimeAssistantUtteranceBackpressureActive, false);
  assert.equal(
    logs.some((entry) => entry?.content === "realtime_assistant_utterance_backpressure_off"),
    true
  );
  assert.equal(logs.some((entry) => entry?.content === "realtime_assistant_utterance_queue_drained"), true);
});

test("handleResponseDone preserves tool work when a tool-only realtime response completes", () => {
  const { manager } = createManager();
  manager.activeReplies = new ActiveReplyRegistry();
  const toolAbortController = new AbortController();
  const replyScopeKey = buildVoiceReplyScopeKey("session-tool-followup-1");
  const activeReply = manager.activeReplies.begin(replyScopeKey, "voice-generation");
  const session = createSession({
    id: "session-tool-followup-1",
    mode: "openai_realtime",
    realtimeClient: {
      isResponseInProgress() {
        return false;
      }
    },
    pendingResponse: {
      requestId: 7,
      userId: "speaker-1",
      requestedAt: Date.now() - 1_000,
      retryCount: 0,
      hardRecoveryAttempted: false,
      source: "voice_web_lookup:busy_utterance",
      handlingSilence: false,
      audioReceivedAt: 0,
      interruptionPolicy: {
        assertive: true,
        scope: "speaker",
        allowedUserId: "speaker-1"
      },
      utteranceText: "still looking",
      latencyContext: null
    },
    awaitingToolOutputs: true,
    activeReplyInterruptionPolicy: {
      assertive: true,
      scope: "speaker",
      allowedUserId: "speaker-1"
    },
    realtimeToolCallExecutions: new Map([
      ["call-1", { startedAtMs: Date.now() - 200, toolName: "web_search" }]
    ]),
    realtimePendingToolAbortControllers: new Map([
      ["call-1", toolAbortController]
    ])
  });

  manager.replyManager.handleResponseDone({
    session,
    event: {
      type: "response.done",
      response: {
        id: "resp-tool-followup-1",
        status: "completed"
      }
    }
  });

  assert.equal(session.pendingResponse, null);
  assert.equal(toolAbortController.signal.aborted, false);
  assert.equal(activeReply.abortController.signal.aborted, false);
  assert.equal(session.awaitingToolOutputs, true);
  assert.deepEqual(session.activeReplyInterruptionPolicy, {
    assertive: true,
    scope: "speaker",
    allowedUserId: "speaker-1"
  });
  const outputChannelState = manager.getOutputChannelState(session);
  assert.equal(outputChannelState.awaitingToolOutputs, true);
  assert.equal(outputChannelState.lockReason, "awaiting_tool_outputs");
});

test("handleResponseDone preserves in-flight tool work when spoken audio and tool calls share a response", () => {
  const { manager } = createManager();
  manager.activeReplies = new ActiveReplyRegistry();
  const toolAbortController = new AbortController();
  const requestedAt = Date.now() - 1_000;
  const replyScopeKey = buildVoiceReplyScopeKey("session-tool-followup-audio-1");
  const activeReply = manager.activeReplies.begin(replyScopeKey, "voice-tool", ["music_play"]);
  const session = createSession({
    id: "session-tool-followup-audio-1",
    mode: "openai_realtime",
    realtimeClient: {
      isResponseInProgress() {
        return false;
      }
    },
    lastAudioDeltaAt: requestedAt + 250,
    pendingResponse: {
      requestId: 8,
      userId: "speaker-1",
      requestedAt,
      retryCount: 0,
      hardRecoveryAttempted: false,
      source: "tool_call_followup",
      handlingSilence: false,
      audioReceivedAt: requestedAt + 250,
      interruptionPolicy: {
        assertive: true,
        scope: "speaker",
        allowedUserId: "speaker-1"
      },
      utteranceText: "give me a sec",
      latencyContext: null
    },
    awaitingToolOutputs: true,
    activeReplyInterruptionPolicy: {
      assertive: true,
      scope: "speaker",
      allowedUserId: "speaker-1"
    },
    realtimeToolCallExecutions: new Map([
      ["call-1", { startedAtMs: Date.now() - 200, toolName: "music_play" }]
    ]),
    realtimePendingToolAbortControllers: new Map([
      ["call-1", toolAbortController]
    ])
  });

  manager.replyManager.handleResponseDone({
    session,
    event: {
      type: "response.done",
      response: {
        id: "resp-tool-followup-audio-1",
        status: "completed"
      }
    }
  });

  assert.equal(session.pendingResponse, null);
  assert.equal(toolAbortController.signal.aborted, false);
  assert.equal(activeReply.abortController.signal.aborted, false);
  assert.equal(manager.activeReplies.has(replyScopeKey), true);
  assert.equal(session.awaitingToolOutputs, true);
  const outputChannelState = manager.getOutputChannelState(session);
  assert.equal(outputChannelState.awaitingToolOutputs, true);
  assert.equal(outputChannelState.lockReason, "awaiting_tool_outputs");
});

test("handleResponseDone preserves active voice generation when busy utterance audio completes", () => {
  const { manager } = createManager();
  manager.activeReplies = new ActiveReplyRegistry();
  const requestedAt = Date.now() - 1_000;
  const replyScopeKey = buildVoiceReplyScopeKey("session-busy-utterance-1");
  const activeReply = manager.activeReplies.begin(replyScopeKey, "voice-generation");
  const session = createSession({
    id: "session-busy-utterance-1",
    mode: "openai_realtime",
    realtimeClient: {
      isResponseInProgress() {
        return false;
      }
    },
    lastAudioDeltaAt: requestedAt + 250,
    pendingResponse: {
      requestId: 9,
      userId: "speaker-1",
      requestedAt,
      retryCount: 0,
      hardRecoveryAttempted: false,
      source: "voice_web_lookup:busy_utterance",
      handlingSilence: false,
      audioReceivedAt: 0,
      interruptionPolicy: {
        assertive: true,
        scope: "speaker",
        allowedUserId: "speaker-1"
      },
      utteranceText: "still looking",
      latencyContext: null
    },
    activeReplyInterruptionPolicy: {
      assertive: true,
      scope: "speaker",
      allowedUserId: "speaker-1"
    }
  });

  manager.replyManager.handleResponseDone({
    session,
    event: {
      type: "response.done",
      response: {
        id: "resp-busy-utterance-1",
        status: "completed"
      }
    }
  });

  assert.equal(session.pendingResponse, null);
  assert.equal(activeReply.abortController.signal.aborted, false);
  assert.equal(manager.activeReplies.has(replyScopeKey), true);
  assert.deepEqual(session.activeReplyInterruptionPolicy, {
    assertive: true,
    scope: "speaker",
    allowedUserId: "speaker-1"
  });
});

test("handleResponseDone preserves active voice generation when a streamed chunk completes mid-tool-loop", () => {
  const { manager } = createManager();
  manager.activeReplies = new ActiveReplyRegistry();
  const requestedAt = Date.now() - 1_000;
  const replyScopeKey = buildVoiceReplyScopeKey("session-stream-chunk-1");
  const activeReply = manager.activeReplies.begin(replyScopeKey, "voice-generation");
  const session = createSession({
    id: "session-stream-chunk-1",
    mode: "openai_realtime",
    realtimeClient: {
      isResponseInProgress() {
        return false;
      }
    },
    lastAudioDeltaAt: requestedAt + 250,
    pendingResponse: {
      requestId: 10,
      userId: "speaker-1",
      requestedAt,
      retryCount: 0,
      hardRecoveryAttempted: false,
      source: "realtime:stream_chunk_0",
      handlingSilence: false,
      audioReceivedAt: 0,
      interruptionPolicy: {
        assertive: true,
        scope: "speaker",
        allowedUserId: "speaker-1"
      },
      utteranceText: "lemme pull that up",
      latencyContext: null
    },
    activeReplyInterruptionPolicy: {
      assertive: true,
      scope: "speaker",
      allowedUserId: "speaker-1"
    }
  });

  manager.replyManager.handleResponseDone({
    session,
    event: {
      type: "response.done",
      response: {
        id: "resp-stream-chunk-1",
        status: "completed"
      }
    }
  });

  assert.equal(session.pendingResponse, null);
  assert.equal(activeReply.abortController.signal.aborted, false);
  assert.equal(manager.activeReplies.has(replyScopeKey), true);
  assert.deepEqual(session.activeReplyInterruptionPolicy, {
    assertive: true,
    scope: "speaker",
    allowedUserId: "speaker-1"
  });
});

test("queueRealtimeTurnFromAsrBridge drops empty ASR transcript instead of queueing PCM", () => {
  const { manager, logs } = createManager();
  const queuedTurns = [];
  manager.turnProcessor.queueRealtimeTurn = (payload) => {
    queuedTurns.push(payload);
  };
  const session = createSession({
    mode: "openai_realtime"
  });
  const pcmBuffer = Buffer.alloc(DISCORD_PCM_FRAME_BYTES * 2, 6);

  const usedTranscript = manager.queueRealtimeTurnFromAsrBridge({
    session,
    userId: "speaker-1",
    pcmBuffer,
    captureReason: "stream_end",
    finalizedAt: Date.now(),
    asrResult: {
      transcript: ""
    },
    source: "per_user"
  });

  assert.equal(usedTranscript, false);
  assert.equal(queuedTurns.length, 0);
  const droppedLog = logs.find((entry) => entry?.content === "openai_realtime_asr_bridge_empty_dropped");
  assert.equal(Boolean(droppedLog), true);
  assert.equal(droppedLog?.metadata?.source, "per_user");
  assert.equal(droppedLog?.metadata?.pcmBytes, pcmBuffer.length);
});

test("queueRealtimeTurnFromAsrBridge drops punctuation-only ASR transcript without queueing", () => {
  const { manager, logs } = createManager();
  const queuedTurns = [];
  const interruptCalls = [];
  manager.turnProcessor.queueRealtimeTurn = (payload) => {
    queuedTurns.push(payload);
  };
  manager.shouldUseTranscriptOverlapInterrupts = () => true;
  manager.interruptBotSpeechForOutputLockTurn = (payload) => {
    interruptCalls.push(payload);
    return true;
  };

  const session = createSession({
    mode: "openai_realtime",
    botTurnOpen: true,
    botTurnOpenAt: Date.now() - 1_800,
    assistantOutput: {
      phase: "speaking_live",
      reason: "bot_audio_live",
      phaseEnteredAt: Date.now() - 900,
      lastSyncedAt: Date.now() - 900,
      requestId: 25,
      ttsPlaybackState: "playing",
      ttsBufferedSamples: 18_000,
      lastTrigger: "test_seed"
    },
    pendingResponse: {
      requestId: 25,
      requestedAt: Date.now() - 2_000,
      source: "voice_reply",
      handlingSilence: false,
      audioReceivedAt: Date.now() - 1_000,
      interruptionPolicy: {
        assertive: true,
        scope: "speaker",
        allowedUserId: "speaker-1"
      },
      utteranceText: "still talking",
      latencyContext: null,
      userId: "speaker-1",
      retryCount: 0,
      hardRecoveryAttempted: false
    }
  });
  const pcmBuffer = Buffer.alloc(DISCORD_PCM_FRAME_BYTES * 2, 6);

  const usedTranscript = manager.queueRealtimeTurnFromAsrBridge({
    session,
    userId: "speaker-1",
    pcmBuffer,
    captureReason: "stream_end",
    finalizedAt: Date.now(),
    bridgeUtteranceId: 92,
    asrResult: {
      transcript: "?"
    },
    source: "per_user"
  });

  assert.equal(usedTranscript, false);
  assert.equal(queuedTurns.length, 0);
  assert.equal(interruptCalls.length, 0);
  assert.equal(logs.some((entry) => entry?.content === "openai_realtime_asr_bridge_empty_dropped"), true);
});

test("queueRealtimeTurnFromAsrBridge drops malformed control-token ASR transcript instead of queueing PCM", () => {
  const { manager, logs } = createManager();
  const queuedTurns = [];
  manager.turnProcessor.queueRealtimeTurn = (payload) => {
    queuedTurns.push(payload);
  };
  const session = createSession({
    mode: "openai_realtime"
  });
  const pcmBuffer = Buffer.alloc(DISCORD_PCM_FRAME_BYTES * 2, 6);

  const usedTranscript = manager.queueRealtimeTurnFromAsrBridge({
    session,
    userId: "speaker-1",
    pcmBuffer,
    captureReason: "stream_end",
    finalizedAt: Date.now(),
    asrResult: {
      transcript: "<|audio_future3|><|vq_lbr_audio_58759|>"
    },
    source: "per_user"
  });

  assert.equal(usedTranscript, false);
  assert.equal(queuedTurns.length, 0);
  const droppedLog = logs.find((entry) => entry?.content === "openai_realtime_asr_bridge_control_token_dropped");
  assert.equal(Boolean(droppedLog), true);
  assert.equal(droppedLog?.metadata?.controlTokenCount, 2);
  assert.equal(droppedLog?.metadata?.reservedAudioMarkerCount, 2);
});

test("queueRealtimeTurnFromAsrBridge drains queued assistant speech when empty ASR produces no replacement work", () => {
  const { manager, logs } = createManager();
  const prompts = [];
  const session = createSession({
    mode: "openai_realtime",
    realtimeClient: {
      requestTextUtterance(prompt) {
        prompts.push(prompt);
      },
      isResponseInProgress() {
        return false;
      }
    },
    pendingRealtimeAssistantUtterances: [
      {
        prompt: "queued prompt",
        utteranceText: "queued prompt",
        userId: "bot-user",
        source: "test_stream_chunk_queued",
        queuedAt: Date.now(),
        interruptionPolicy: null,
        latencyContext: null,
        musicWakeRefreshAfterSpeech: false
      }
    ]
  });
  const pcmBuffer = Buffer.alloc(DISCORD_PCM_FRAME_BYTES * 2, 6);

  const usedTranscript = manager.queueRealtimeTurnFromAsrBridge({
    session,
    userId: "speaker-1",
    pcmBuffer,
    captureReason: "stream_end",
    finalizedAt: Date.now(),
    asrResult: {
      transcript: ""
    },
    source: "per_user"
  });

  assert.equal(usedTranscript, false);
  assert.deepEqual(prompts, ["queued prompt"]);
  assert.equal(session.pendingRealtimeAssistantUtterances?.length, 0);
  assert.equal(logs.some((entry) => entry?.content === "openai_realtime_asr_bridge_empty_dropped"), true);
  assert.equal(logs.some((entry) => entry?.content === "realtime_assistant_utterance_queue_drained"), true);
});

test("queueRealtimeTurnFromAsrBridge hands empty interrupted ASR turns back to the voice brain", async () => {
  const { manager, logs } = createManager();
  const runtimeEvents = [];
  manager.fireVoiceRuntimeEvent = async (payload) => {
    runtimeEvents.push(payload);
    return true;
  };
  const session = createSession({
    mode: "openai_realtime",
    interruptedAssistantReply: {
      utteranceText: "let me finish that thought",
      interruptedByUserId: "speaker-1",
      interruptedAt: Date.now() - 250,
      source: "cancel_failed_test",
      interruptionPolicy: {
        assertive: true,
        scope: "speaker",
        allowedUserId: "speaker-1"
      }
    }
  });
  const bridgeUtteranceId = 91;
  recordCommittedInterruptDecision(session, bridgeUtteranceId);
  const pcmBuffer = Buffer.alloc(DISCORD_PCM_FRAME_BYTES * 2, 6);

  const usedTranscript = manager.queueRealtimeTurnFromAsrBridge({
    session,
    userId: "speaker-1",
    pcmBuffer,
    captureReason: "stream_end",
    finalizedAt: Date.now(),
    bridgeUtteranceId,
    asrResult: {
      transcript: ""
    },
    source: "per_user"
  });

  assert.equal(usedTranscript, true);
  await flushMicrotasks();
  assert.equal(runtimeEvents.length, 1);
  assert.equal(runtimeEvents[0]?.source, "interrupted_empty_asr_bridge_turn");
  assert.match(String(runtimeEvents[0]?.transcript || ""), /interrupted you, but their words were unclear/i);
  assert.equal(
    logs.some((entry) => entry?.content === "voice_interrupt_unclear_turn_handoff_requested"),
    true
  );
});

test("queueRealtimeTurnFromAsrBridge drops empty ASR turns without synthetic unclear-interrupt handoff when no committed interrupt occurred", async () => {
  const { manager, logs } = createManager();
  const runtimeEvents = [];
  manager.fireVoiceRuntimeEvent = async (payload) => {
    runtimeEvents.push(payload);
    return true;
  };
  const session = createSession({
    mode: "openai_realtime",
    interruptedAssistantReply: {
      utteranceText: "let me finish that thought",
      interruptedByUserId: "speaker-1",
      interruptedAt: Date.now() - 250,
      source: "cancel_failed_test",
      interruptionPolicy: {
        assertive: true,
        scope: "speaker",
        allowedUserId: "speaker-1"
      }
    }
  });
  const pcmBuffer = Buffer.alloc(DISCORD_PCM_FRAME_BYTES * 2, 6);

  const usedTranscript = manager.queueRealtimeTurnFromAsrBridge({
    session,
    userId: "speaker-1",
    pcmBuffer,
    captureReason: "stream_end",
    finalizedAt: Date.now(),
    bridgeUtteranceId: 91,
    asrResult: {
      transcript: ""
    },
    source: "per_user"
  });

  assert.equal(usedTranscript, false);
  await flushMicrotasks();
  assert.equal(runtimeEvents.length, 0);
  assert.equal(
    logs.some((entry) => entry?.content === "voice_interrupt_unclear_turn_handoff_requested"),
    false
  );
  const skippedLog = logs.find((entry) => entry?.content === "voice_interrupt_unclear_turn_handoff_skipped");
  assert.equal(Boolean(skippedLog), true);
  assert.equal(skippedLog?.metadata?.skipReason, "missing_committed_interrupt_turn");
  assert.equal(
    logs.some((entry) => entry?.content === "openai_realtime_asr_bridge_empty_dropped"),
    true
  );
});

test("interruptBotSpeechForOutputLockTurn aborts active voice reply scopes", () => {
  const { manager, logs } = createManager();
  manager.activeReplies = new ActiveReplyRegistry();
  const session = createSession({
    mode: "openai_realtime",
    pendingResponse: {
      requestId: 17,
      utteranceText: "still talking"
    },
    lastRealtimeAssistantAudioItemId: "item_output_lock_active_reply",
    lastRealtimeAssistantAudioItemContentIndex: 0,
    lastRealtimeAssistantAudioItemReceivedMs: 1_900,
    realtimeClient: {
      cancelActiveResponse() {
        return true;
      },
      truncateConversationItem() {
        return true;
      }
    }
  });
  const replyScopeKey = buildVoiceReplyScopeKey(session.id);
  const activeReply = manager.activeReplies.begin(replyScopeKey, "voice-generation", ["voice_generation"]);

  const interrupted = manager.interruptBotSpeechForOutputLockTurn({
    session,
    userId: "speaker-1",
    source: "authorized_speaker_test"
  });

  assert.equal(interrupted, true);
  assert.equal(activeReply.abortController.signal.aborted, true);
  assert.equal(manager.activeReplies.has(replyScopeKey), false);

  const interruptLog = logs.find((entry) => entry?.content === "voice_output_lock_interrupt");
  assert.equal(Boolean(interruptLog), true);
  assert.equal(interruptLog?.metadata?.activeReplyAbortCount, 1);
});

test("queueRealtimeTurnFromAsrBridge forwards transcript metadata when ASR transcript exists", () => {
  const { manager, logs } = createManager();
  const queuedTurns = [];
  manager.turnProcessor.queueRealtimeTurn = (payload) => {
    queuedTurns.push(payload);
  };
  const session = createSession({
    mode: "openai_realtime",
    realtimeInputSampleRateHz: 24_000
  });
  const pcmBuffer = Buffer.alloc(DISCORD_PCM_FRAME_BYTES * 2, 4);

  const usedTranscript = manager.queueRealtimeTurnFromAsrBridge({
    session,
    userId: "speaker-1",
    pcmBuffer,
    captureReason: "speaking_end",
    finalizedAt: Date.now(),
    bridgeUtteranceId: 14,
    asrResult: {
      transcript: "hello from asr",
      asrStartedAtMs: 1000,
      asrCompletedAtMs: 1125,
      transcriptionModelPrimary: "gpt-4o-mini-transcribe",
      transcriptionModelFallback: "whisper-1",
      transcriptionPlanReason: "openai_realtime_per_user_transcription",
      usedFallbackModel: true
    },
    source: "per_user"
  });

  assert.equal(usedTranscript, true);
  assert.equal(queuedTurns.length, 1);
  assert.equal(queuedTurns[0]?.transcriptOverride, "hello from asr");
  assert.equal(queuedTurns[0]?.bridgeUtteranceId, 14);
  assert.equal(queuedTurns[0]?.transcriptionModelPrimaryOverride, "gpt-4o-mini-transcribe");
  assert.equal(queuedTurns[0]?.transcriptionModelFallbackOverride, "whisper-1");
  assert.equal(queuedTurns[0]?.transcriptionPlanReasonOverride, "openai_realtime_per_user_transcription");
  assert.equal(queuedTurns[0]?.usedFallbackModelForTranscriptOverride, true);
  assert.equal(logs.some((entry) => entry?.content === "openai_realtime_asr_bridge_empty_dropped"), false);
});

test("shared ASR bridge forwards recovered transcript after timeout instead of discarding it", async () => {
  const { manager, logs } = createManager();
  manager.appConfig.openaiApiKey = "test-openai-key";
  manager.shouldUseSharedTranscription = () => true;
  manager.evaluatePcmSilenceGate = () => ({
    drop: false,
    clipDurationMs: 480,
    rms: 0.2,
    peak: 0.4,
    activeSampleRatio: 0.4
  });

  const bridgedTurns = [];
  manager.queueRealtimeTurnFromAsrBridge = (payload) => {
    bridgedTurns.push(payload);
    return true;
  };

  const settings = createTestSettings({
    botName: "clanky",
    llm: {
      provider: "anthropic",
      model: "claude-haiku-4-5"
    },
    voice: {
      openaiRealtime: {
        transcriptionMethod: "realtime_bridge",
        usePerUserAsrBridge: false
      }
    }
  });
  const voxClient = new EventEmitter();
  voxClient.subscribeUser = () => {};
  const session = createSession({
    mode: "openai_realtime",
    realtimeInputSampleRateHz: 24_000,
    cleanupHandlers: [],
    settingsSnapshot: settings,
    voxClient
  });

  const pcmBuffer = makeMonoPcm16(
    Math.ceil((24_000 * (VOICE_TURN_PROMOTION_MIN_CLIP_MS + 80)) / 1000),
    3000
  );
  manager.captureManager.startInboundCapture({
    session,
    userId: "speaker-1",
    settings
  });

  const sharedAsrState = getOrCreateSharedAsrState(session);
  assert.ok(sharedAsrState);
  sharedAsrState.phase = "ready";
  sharedAsrState.client = {
    ws: { readyState: 1 },
    clearInputAudioBuffer() {},
    appendInputAudioPcm() {},
    commitInputAudioBuffer() {
      setTimeout(() => {
        sharedAsrState.utterance.finalSegments = ["can i show you my screen?"];
        sharedAsrState.utterance.lastUpdateAt = Date.now();
      }, 750);
    }
  };
  voxClient.emit("userAudio", "speaker-1", pcmBuffer);
  await flushMicrotasks();

  const capture = session.userCaptures.get("speaker-1");
  assert.ok(capture);
  assert.ok(Number(capture.promotedAt || 0) > 0);
  assert.ok(Number(capture.sharedAsrBytesSent || 0) > 0);
  const captureManager = manager.captureManager as CaptureManager & {
    runAsrBridgeCommit(args: {
      session: VoiceSession;
      userId: string;
      settings?: Record<string, unknown> | null;
      captureState: CaptureState;
      pcmBuffer: Buffer;
      captureReason: string;
      finalizedAt: number;
      useOpenAiPerUserAsr: boolean;
      useOpenAiSharedAsr: boolean;
    }): Promise<void>;
  };
  await captureManager.runAsrBridgeCommit({
    session,
    userId: "speaker-1",
    settings,
    captureState: capture,
    pcmBuffer,
    captureReason: "stream_end",
    finalizedAt: Date.now(),
    useOpenAiPerUserAsr: false,
    useOpenAiSharedAsr: true
  });

  assert.equal(bridgedTurns.length >= 1, true);
  assert.equal(bridgedTurns.at(-1)?.asrResult?.transcript, "can i show you my screen?");
  assert.equal(logs.some((entry) => entry?.content === "openai_realtime_asr_bridge_timeout_fallback"), true);
  assert.equal(logs.some((entry) => entry?.content === "openai_realtime_asr_bridge_late_result_ignored"), false);
  assert.equal(logs.some((entry) => entry?.content === "openai_realtime_asr_bridge_empty_dropped"), false);
});

test("per-user ASR bridge keeps watching the committed utterance across rollover and recovers the late transcript", async () => {
  const { manager, logs } = createManager();
  manager.appConfig.openaiApiKey = "test-openai-key";
  manager.shouldUsePerUserTranscription = () => true;
  manager.shouldUseSharedTranscription = () => false;
  manager.evaluatePcmSilenceGate = () => ({
    drop: false,
    clipDurationMs: 960,
    rms: 0.2,
    peak: 0.4,
    activeSampleRatio: 0.4
  });

  const bridgedTurns = [];
  manager.queueRealtimeTurnFromAsrBridge = (payload) => {
    bridgedTurns.push(payload);
    return true;
  };

  const settings = createTestSettings({
    botName: "clanky",
    llm: {
      provider: "anthropic",
      model: "claude-haiku-4-5"
    },
    voice: {
      openaiRealtime: {
        transcriptionMethod: "realtime_bridge",
        usePerUserAsrBridge: true
      }
    }
  });
  const session = createSession({
    mode: "openai_realtime",
    realtimeInputSampleRateHz: 24_000,
    cleanupHandlers: [],
    settingsSnapshot: settings,
    openAiAsrTranscriptStableMs: 100,
    openAiAsrTranscriptWaitMaxMs: 260
  });

  const pcmBuffer = makeMonoPcm16(24_000, 3000);
  manager.captureManager.startInboundCapture({
    session,
    userId: "speaker-1",
    settings
  });

  const capture = session.userCaptures.get("speaker-1");
  assert.ok(capture);
  const { asrState } = seedReadyPerUserAsr(manager, session, "speaker-1");
  assert.ok(asrState?.utterance);
  asrState.utterance.bytesSent = pcmBuffer.length;
  capture.promotedAt = Date.now();
  capture.asrUtteranceId = Math.max(0, Number(asrState.utterance.id || 0));

  asrState.client = {
    ws: { readyState: 1 },
    clearInputAudioBuffer() {},
    appendInputAudioPcm() {},
    commitInputAudioBuffer() {
      const committedUtterance = asrState.utterance;
      setTimeout(() => {
        beginAsrUtterance("per_user", session, manager.buildAsrBridgeDeps(session), settings, "speaker-1");
      }, 320);
      setTimeout(() => {
        committedUtterance.finalSegments = ["uh, money so big."];
        committedUtterance.lastUpdateAt = Date.now();
      }, 520);
    }
  };

  const captureManager = manager.captureManager as CaptureManager & {
    runAsrBridgeCommit(args: {
      session: VoiceSession;
      userId: string;
      settings?: Record<string, unknown> | null;
      captureState: CaptureState;
      pcmBuffer: Buffer;
      captureReason: string;
      finalizedAt: number;
      useOpenAiPerUserAsr: boolean;
      useOpenAiSharedAsr: boolean;
    }): Promise<void>;
  };
  await captureManager.runAsrBridgeCommit({
    session,
    userId: "speaker-1",
    settings,
    captureState: capture,
    pcmBuffer,
    captureReason: "stream_end",
    finalizedAt: Date.now(),
    useOpenAiPerUserAsr: true,
    useOpenAiSharedAsr: false
  });

  assert.equal(bridgedTurns.length >= 1, true);
  assert.equal(bridgedTurns.at(-1)?.asrResult?.transcript, "uh, money so big.");
  assert.equal(bridgedTurns.at(-1)?.source, "per_user_late_streaming");
  assert.equal(logs.some((entry) => entry?.content === "openai_realtime_asr_bridge_late_streaming_recovered"), true);
  assert.equal(logs.some((entry) => entry?.content === "openai_realtime_asr_bridge_empty_dropped"), false);
});

test("per-user ASR bridge logs explicit empty drop when no transcript ever materializes", async () => {
  const { manager, logs } = createManager();
  manager.appConfig.openaiApiKey = "test-openai-key";
  manager.shouldUsePerUserTranscription = () => true;
  manager.shouldUseSharedTranscription = () => false;
  manager.evaluatePcmSilenceGate = () => ({
    drop: false,
    clipDurationMs: 960,
    rms: 0.2,
    peak: 0.4,
    activeSampleRatio: 0.4
  });

  const bridgedTurns = [];
  manager.queueRealtimeTurnFromAsrBridge = (payload) => {
    bridgedTurns.push(payload);
    return true;
  };

  const settings = createTestSettings({
    botName: "clanky",
    llm: {
      provider: "anthropic",
      model: "claude-haiku-4-5"
    },
    voice: {
      openaiRealtime: {
        transcriptionMethod: "realtime_bridge",
        usePerUserAsrBridge: true
      }
    }
  });
  const session = createSession({
    mode: "openai_realtime",
    realtimeInputSampleRateHz: 24_000,
    cleanupHandlers: [],
    settingsSnapshot: settings,
    openAiAsrTranscriptStableMs: 100,
    openAiAsrTranscriptWaitMaxMs: 200
  });

  const pcmBuffer = makeMonoPcm16(24_000, 3000);
  manager.captureManager.startInboundCapture({
    session,
    userId: "speaker-1",
    settings
  });

  const capture = session.userCaptures.get("speaker-1");
  assert.ok(capture);
  const { asrState } = seedReadyPerUserAsr(manager, session, "speaker-1");
  assert.ok(asrState?.utterance);
  asrState.utterance.bytesSent = pcmBuffer.length;
  capture.promotedAt = Date.now();
  capture.asrUtteranceId = Math.max(0, Number(asrState.utterance.id || 0));

  asrState.client = {
    ws: { readyState: 1 },
    clearInputAudioBuffer() {},
    appendInputAudioPcm() {},
    commitInputAudioBuffer() {}
  };

  const captureManager = manager.captureManager as CaptureManager & {
    runAsrBridgeCommit(args: {
      session: VoiceSession;
      userId: string;
      settings?: Record<string, unknown> | null;
      captureState: CaptureState;
      pcmBuffer: Buffer;
      captureReason: string;
      finalizedAt: number;
      useOpenAiPerUserAsr: boolean;
      useOpenAiSharedAsr: boolean;
    }): Promise<void>;
  };
  await captureManager.runAsrBridgeCommit({
    session,
    userId: "speaker-1",
    settings,
    captureState: capture,
    pcmBuffer,
    captureReason: "stream_end",
    finalizedAt: Date.now(),
    useOpenAiPerUserAsr: true,
    useOpenAiSharedAsr: false
  });

  assert.equal(bridgedTurns.length, 0);
  assert.equal(logs.some((entry) => entry?.content === "voice_realtime_transcription_empty"), true);
  assert.equal(logs.some((entry) => entry?.content === "openai_realtime_asr_bridge_empty_dropped"), true);
});

test("per-user ASR bridge forwards same-utterance transcript continuity across late streaming updates", async () => {
  const { manager, logs } = createManager();
  manager.appConfig.openaiApiKey = "test-openai-key";
  manager.shouldUsePerUserTranscription = () => true;
  manager.shouldUseSharedTranscription = () => false;
  manager.evaluatePcmSilenceGate = () => ({
    drop: false,
    clipDurationMs: 960,
    rms: 0.2,
    peak: 0.4,
    activeSampleRatio: 0.4
  });

  const bridgedTurns = [];
  manager.queueRealtimeTurnFromAsrBridge = (payload) => {
    bridgedTurns.push(payload);
    return true;
  };

  const settings = createTestSettings({
    botName: "clanky",
    llm: {
      provider: "anthropic",
      model: "claude-haiku-4-5"
    },
    voice: {
      openaiRealtime: {
        transcriptionMethod: "realtime_bridge",
        usePerUserAsrBridge: true
      }
    }
  });
  const voxClient = new EventEmitter();
  voxClient.subscribeUser = () => {};
  const session = createSession({
    mode: "openai_realtime",
    realtimeInputSampleRateHz: 24_000,
    cleanupHandlers: [],
    settingsSnapshot: settings,
    voxClient,
    openAiAsrTranscriptStableMs: 100,
    openAiAsrTranscriptWaitMaxMs: 260
  });

  const pcmBuffer = makeMonoPcm16(24_000, 3000);
  manager.captureManager.startInboundCapture({
    session,
    userId: "speaker-1",
    settings
  });

  const capture = session.userCaptures.get("speaker-1");
  assert.ok(capture);
  const { asrState } = seedReadyPerUserAsr(manager, session, "speaker-1");
  assert.ok(asrState?.utterance);
  asrState.utterance.bytesSent = pcmBuffer.length;
  capture.promotedAt = Date.now();
  capture.asrUtteranceId = Math.max(0, Number(asrState.utterance.id || 0));
  asrState.client = {
    ws: { readyState: 1 },
    clearInputAudioBuffer() {},
    appendInputAudioPcm() {},
    commitInputAudioBuffer() {
      setTimeout(() => {
        if (!asrState.utterance) return;
        asrState.utterance.finalSegments = ["Yo, what's up, man? Can you look up on eBay what..."];
        asrState.utterance.lastUpdateAt = Date.now();
      }, 10);
      setTimeout(() => {
        if (!asrState.utterance) return;
        asrState.utterance.finalSegments = [
          "Yo, what's up, man? Can you look up on eBay what...",
          "Uh, Nintendo DS."
        ];
        asrState.utterance.lastUpdateAt = Date.now();
      }, 600);
    }
  };

  const captureManager = manager.captureManager as CaptureManager & {
    runAsrBridgeCommit(args: {
      session: VoiceSession;
      userId: string;
      settings?: Record<string, unknown> | null;
      captureState: CaptureState;
      pcmBuffer: Buffer;
      captureReason: string;
      finalizedAt: number;
      useOpenAiPerUserAsr: boolean;
      useOpenAiSharedAsr: boolean;
    }): Promise<void>;
  };
  await captureManager.runAsrBridgeCommit({
    session,
    userId: "speaker-1",
    settings,
    captureState: capture,
    pcmBuffer,
    captureReason: "max_duration",
    finalizedAt: Date.now(),
    useOpenAiPerUserAsr: true,
    useOpenAiSharedAsr: false
  });

  assert.equal(bridgedTurns.length >= 1, true);
  const firstTranscript = bridgedTurns[0]?.asrResult?.transcript || "";
  const lastTranscript = bridgedTurns.at(-1)?.asrResult?.transcript || "";
  assert.equal(
    [
      "Yo, what's up, man? Can you look up on eBay what...",
      "Yo, what's up, man? Can you look up on eBay what... Uh, Nintendo DS."
    ].includes(lastTranscript),
    true
  );
  assert.equal(Math.max(0, Number(bridgedTurns[0]?.bridgeUtteranceId || 0)) > 0, true);
  if (bridgedTurns.length >= 2) {
    assert.equal(
      firstTranscript,
      "Yo, what's up, man? Can you look up on eBay what..."
    );
    assert.equal(lastTranscript, "Yo, what's up, man? Can you look up on eBay what... Uh, Nintendo DS.");
    assert.equal(bridgedTurns[0]?.bridgeUtteranceId, bridgedTurns.at(-1)?.bridgeUtteranceId);
    assert.equal(bridgedTurns[1]?.source, "per_user_late_streaming_revision");
    assert.equal(logs.some((entry) => entry?.content === "openai_realtime_asr_bridge_late_streaming_revised"), true);
  }
});

test("evaluateVoiceThoughtLoopGate waits for silence window and queue cooldown", () => {
  const { manager } = createManager();
  const now = Date.now();
  const session = createSession({
    lastActivityAt: now - 5_000,
    lastThoughtAttemptAt: 0
  });

  const blockedBySilence = manager.thoughtEngine.evaluateVoiceThoughtLoopGate({
    session,
    settings: createTestSettings({
      voice: {
        ambientReplyEagerness: 100,
      },
      initiative: {
        voice: {
          enabled: true,
          eagerness: 100,
          minSilenceSeconds: 20,
          minSecondsBetweenThoughts: 20
        }
      }
    }),
    now
  });
  assert.equal(blockedBySilence.allow, false);
  assert.equal(blockedBySilence.reason, "silence_window_not_met");

  const allowed = manager.thoughtEngine.evaluateVoiceThoughtLoopGate({
    session: {
      ...session,
      lastActivityAt: now - 25_000
    },
    settings: createTestSettings({
      voice: {
        ambientReplyEagerness: 100,
      },
      initiative: {
        voice: {
          enabled: true,
          eagerness: 100,
          minSilenceSeconds: 20,
          minSecondsBetweenThoughts: 20
        }
      }
    }),
    now
  });
  assert.equal(allowed.allow, true);
  assert.equal(allowed.reason, "ok");
});

test("evaluateVoiceThoughtLoopGate blocks thoughts in command-only mode", () => {
  const { manager } = createManager();
  const now = Date.now();
  const session = createSession({
    lastActivityAt: now - 25_000,
    lastThoughtAttemptAt: 0
  });

  const blocked = manager.thoughtEngine.evaluateVoiceThoughtLoopGate({
    session,
    settings: createTestSettings({
      voice: {
        commandOnlyMode: true,
      },
      initiative: {
        voice: {
          enabled: true,
          eagerness: 100,
          minSilenceSeconds: 20,
          minSecondsBetweenThoughts: 20
        }
      }
    }),
    now
  });

  assert.equal(blocked.allow, false);
  assert.equal(blocked.reason, "command_only_mode");
});

test("maybeRunVoiceThoughtLoop speaks approved thought candidates", async () => {
  const { manager } = createManager();
  const now = Date.now();
  const settings = createTestSettings({
    botName: "clanky",
    voice: {
      enabled: true,
      ambientReplyEagerness: 100
    },
    initiative: {
      voice: {
        enabled: true,
        execution: {
          mode: "dedicated_model",
          model: {
            provider: "anthropic",
            model: "claude-haiku-4-5"
          }
        },
        eagerness: 100,
        minSilenceSeconds: 20,
        minSecondsBetweenThoughts: 20
      }
    }
  });
  const session = createSession({
    mode: "openai_realtime",
    lastActivityAt: now - 25_000,
    settingsSnapshot: settings
  });

  const scheduledDelays = [];
  manager.thoughtEngine.scheduleVoiceThoughtLoop = ({ delayMs }) => {
    scheduledDelays.push(delayMs);
  };
  manager.generateVoiceThoughtCandidate = async () => "did you know octopuses have three hearts";
  manager.evaluateVoiceThoughtDecision = async () => ({
    action: "speak_now",
    reason: "llm_yes"
  });
  let delivered = 0;
  manager.deliverVoiceThoughtCandidate = async () => {
    delivered += 1;
    return true;
  };

  const originalRandom = Math.random;
  Math.random = () => 0.01;
  try {
    const ran = await manager.thoughtEngine.maybeRunVoiceThoughtLoop({
      session,
      settings,
      trigger: "test"
    });
    assert.equal(ran, true);
    assert.equal(delivered, 1);
    assert.equal(session.lastThoughtSpokenAt > 0, true);
    assert.equal(scheduledDelays.length, 1);
    assert.equal(scheduledDelays[0], 20_000);
  } finally {
    Math.random = originalRandom;
  }
});

test("maybeRunVoiceThoughtLoop can hold and revisit a pending ambient thought", async () => {
  const { manager } = createManager();
  const now = Date.now();
  const settings = createTestSettings({
    botName: "clanky",
    initiative: {
      voice: {
        enabled: true,
        eagerness: 100,
        minSilenceSeconds: 20,
        minSecondsBetweenThoughts: 20
      }
    }
  });
  const session = createSession({
    mode: "openai_realtime",
    lastActivityAt: now - 25_000,
    settingsSnapshot: settings
  });

  const scheduledDelays = [];
  manager.thoughtEngine.scheduleVoiceThoughtLoop = ({ delayMs }) => {
    scheduledDelays.push(delayMs);
  };
  manager.generateVoiceThoughtCandidate = async ({ pendingThought }) =>
    pendingThought ? "actually the octopus fact is better now" : "did you know octopuses have three hearts";

  let decisionPass = 0;
  manager.evaluateVoiceThoughtDecision = async () => {
    decisionPass += 1;
    if (decisionPass === 1) {
      return {
        action: "hold",
        reason: "almost_there",
        finalThought: "did you know octopuses have three hearts"
      };
    }
    return {
      action: "speak_now",
      reason: "ready_now",
      finalThought: "actually the octopus fact is better now"
    };
  };

  let delivered = 0;
  manager.deliverVoiceThoughtCandidate = async () => {
    delivered += 1;
    return true;
  };

  const originalRandom = Math.random;
  Math.random = () => 0.01;
  try {
    const firstRun = await manager.thoughtEngine.maybeRunVoiceThoughtLoop({
      session,
      settings,
      trigger: "test"
    });
    assert.equal(firstRun, false);
    assert.equal(session.pendingAmbientThought?.currentText, "did you know octopuses have three hearts");
    assert.equal(session.pendingAmbientThought?.revision, 1);
    assert.equal(Number(scheduledDelays[0]) >= 9_900 && Number(scheduledDelays[0]) <= 10_000, true);

    session.lastActivityAt = Date.now() - 25_000;
    if (session.pendingAmbientThought) {
      session.pendingAmbientThought.notBeforeAt = 0;
    }
    const secondRun = await manager.thoughtEngine.maybeRunVoiceThoughtLoop({
      session,
      settings,
      trigger: "test"
    });
    assert.equal(secondRun, true);
    assert.equal(delivered, 1);
    assert.equal(session.pendingAmbientThought ?? null, null);
  } finally {
    Math.random = originalRandom;
  }
});

test("maybeRunVoiceThoughtLoop skips generation when eagerness probability roll fails", async () => {
  const { manager } = createManager();
  const settings = createTestSettings({
    botName: "clanky",
    voice: {
      enabled: true,
      ambientReplyEagerness: 10
    },
    initiative: {
      voice: {
        enabled: true,
        execution: {
          mode: "dedicated_model",
          model: {
            provider: "anthropic",
            model: "claude-haiku-4-5"
          }
        },
        eagerness: 10,
        minSilenceSeconds: 20,
        minSecondsBetweenThoughts: 20
      }
    }
  });
  const session = createSession({
    mode: "openai_realtime",
    lastActivityAt: Date.now() - 25_000,
    settingsSnapshot: settings
  });

  manager.thoughtEngine.scheduleVoiceThoughtLoop = () => {};
  manager.generateVoiceThoughtCandidate = async () => {
    throw new Error("thought generation should not run when probability gate fails");
  };

  const originalRandom = Math.random;
  Math.random = () => 0.95;
  try {
    const ran = await manager.thoughtEngine.maybeRunVoiceThoughtLoop({
      session,
      settings,
      trigger: "test"
    });
    assert.equal(ran, false);
    assert.equal(session.lastThoughtAttemptAt > 0, true);
  } finally {
    Math.random = originalRandom;
  }
});

test("requestStatus reports offline and online states", async () => {
  const { manager, messages } = createManager();

  const offline = await manager.requestStatus({
    message: createMessage(),
    settings: { voice: { enabled: true } }
  });
  assert.equal(offline, true);
  assert.equal(messages.at(-1)?.reason, "offline");

  manager.sessions.set(
    "guild-1",
    createSession({
      userCaptures: new Map([
        ["user-a", {}],
        ["user-b", {}]
      ]),
      streamWatch: {
        active: true,
        targetUserId: "user-a",
        requestedByUserId: "user-mod",
        lastFrameAt: Date.now() - 1_000,
        lastCommentaryAt: Date.now() - 2_000,
        ingestedFrameCount: 3
      },
      music: {
        active: true,
        phase: "playing",
        provider: "youtube",
        lastTrackTitle: "lone star",
        lastTrackArtists: ["artist a"]
      }
    })
  );

  const online = await manager.requestStatus({
    message: createMessage({
      content: "clankie r u in vc rn?"
    }),
    settings: null
  });
  assert.equal(online, true);
  assert.equal(messages.at(-1)?.reason, "online");
  assert.equal(messages.at(-1)?.details?.activeCaptures, 2);
  assert.equal(messages.at(-1)?.details?.streamWatchActive, true);
  assert.equal(messages.at(-1)?.details?.musicActive, true);
  assert.equal(messages.at(-1)?.details?.musicProvider, "youtube");
  assert.equal(messages.at(-1)?.details?.musicTrackTitle, "lone star");
  assert.deepEqual(messages.at(-1)?.details?.musicTrackArtists, ["artist a"]);
  assert.equal(messages.at(-1)?.details?.requestText, "clankie r u in vc rn?");
});

test("getOutputChannelState mirrors lock state for music playback", () => {
  const { manager } = createManager();
  const session = createSession({
    music: {
      phase: "playing",
      active: true
    }
  });

  const outputChannelState = manager.getOutputChannelState(session);
  assert.equal(outputChannelState.locked, true);
  assert.equal(outputChannelState.lockReason, "music_playback_active");
  assert.equal(outputChannelState.musicActive, true);
  assert.equal(outputChannelState.deferredBlockReason, null);
});

test("getOutputChannelState surfaces deferred blockers and turn backlog", () => {
  const { manager } = createManager();
  const session = createSession({
    pendingFileAsrTurns: 2,
    awaitingToolOutputs: true,
    realtimeToolCallExecutions: new Map([["call-1", Promise.resolve()]]),
    userCaptures: new Map([[
      "user-a",
      {
        userId: "user-a",
        bytesSent: 0,
        signalSampleCount: 0,
        speakingEndFinalizeTimer: null
      }
    ]])
  });

  const outputChannelState = manager.getOutputChannelState(session);
  assert.equal(outputChannelState.captureBlocking, true);
  assert.equal(outputChannelState.turnBacklog, 2);
  assert.equal(outputChannelState.awaitingToolOutputs, true);
  assert.equal(outputChannelState.toolCallsRunning, true);
  assert.equal(outputChannelState.deferredBlockReason, "active_captures");
});

test("bindVoxHandlers tracks explicit tts playback lifecycle from clankvox", () => {
  const { manager } = createManager();
  let playbackState: "idle" | "buffered" = "idle";
  const voxClient = new EventEmitter() as EventEmitter & {
    ttsBufferDepthSamples: number;
    getPlaybackArmedReason: () => string | null;
    getTtsPlaybackState: () => "idle" | "buffered";
    off: (event: string, listener: (...args: unknown[]) => void) => EventEmitter;
  };
  voxClient.ttsBufferDepthSamples = 0;
  voxClient.getPlaybackArmedReason = () => null;
  voxClient.getTtsPlaybackState = () => playbackState;
  const session = createSession({
    voxClient
  });

  manager.sessionLifecycle.bindVoxHandlers(session);
  playbackState = "buffered";
  voxClient.emit("ttsPlaybackState", "buffered");

  let lockState = manager.replyManager.getReplyOutputLockState(session);
  assert.equal(lockState.locked, true);
  assert.equal(lockState.reason, "bot_audio_buffered");
  assert.equal(lockState.phase, "speaking_buffered");

  playbackState = "idle";
  voxClient.emit("ttsPlaybackState", "idle");
  lockState = manager.replyManager.getReplyOutputLockState(session);
  assert.equal(lockState.locked, false);
  assert.equal(lockState.reason, "idle");
  assert.equal(lockState.phase, "idle");
});

test("resetBotAudioPlayback clears cached clankvox playback telemetry immediately", () => {
  const { manager } = createManager();
  let playbackState: "idle" | "buffered" = "buffered";
  const voxClient = {
    isAlive: true,
    ttsBufferDepthSamples: 24_000,
    stopPlayback() {},
    clearTtsPlaybackTelemetry() {
      playbackState = "idle";
      voxClient.ttsBufferDepthSamples = 0;
    },
    getTtsPlaybackState() {
      return playbackState;
    }
  };
  const session = createSession({
    voxClient
  });

  let lockState = manager.replyManager.getReplyOutputLockState(session);
  assert.equal(lockState.reason, "bot_audio_buffered");

  manager.replyManager.resetBotAudioPlayback(session);
  lockState = manager.replyManager.getReplyOutputLockState(session);
  assert.equal(lockState.locked, false);
  assert.equal(lockState.reason, "idle");
});

test("bot speech music duck helpers use configured gain and release after inactivity", async () => {
  const { manager } = createManager();
  const session = createSession({
    music: {
      phase: "playing",
      active: true,
      ducked: false,
      pauseReason: null
    }
  });
  const settings = {
    voice: {
      enabled: true,
      musicDucking: {
        targetGain: 0.22,
        fadeMs: 120
      }
    }
  };
  const duckCalls = [];
  const unduckCalls = [];

  manager.musicPlayer = {
    async duck(options) {
      duckCalls.push(options);
    },
    unduck(options) {
      unduckCalls.push(options);
    }
  };

  const engaged = await manager.engageBotSpeechMusicDuck(session, settings, { awaitFade: true });
  assert.equal(engaged, true);
  assert.equal(session.botSpeechMusicDucked, true);
  assert.equal(session.music.ducked, true);
  assert.deepEqual(duckCalls[0], {
    targetGain: 0.22,
    fadeMs: 120
  });

  manager.scheduleBotSpeechMusicUnduck(session, settings, 0);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(session.botSpeechMusicDucked, false);
  assert.equal(session.music.ducked, false);
  assert.deepEqual(unduckCalls[0], {
    targetGain: 1,
    fadeMs: 120
  });
});

test("scheduleBotSpeechMusicUnduck waits for buffered tts playback to drain", async () => {
  const { manager } = createManager();
  const session = createSession({
    botSpeechMusicDucked: true,
    voxClient: {
      ttsBufferDepthSamples: 24_000
    },
    music: {
      phase: "playing",
      active: true,
      ducked: true,
      pauseReason: null
    }
  });
  const settings = {
    voice: {
      enabled: true,
      musicDucking: {
        targetGain: 0.22,
        fadeMs: 120
      }
    }
  };
  const unduckCalls = [];

  manager.musicPlayer = {
    unduck(options) {
      unduckCalls.push(options);
    }
  };

  manager.scheduleBotSpeechMusicUnduck(session, settings, 0);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(unduckCalls.length, 0);

  session.voxClient.ttsBufferDepthSamples = 0;
  await new Promise((resolve) => setTimeout(resolve, 250));

  assert.equal(session.botSpeechMusicDucked, false);
  assert.equal(session.music.ducked, false);
  assert.deepEqual(unduckCalls[0], {
    targetGain: 1,
    fadeMs: 120
  });
});

test("maybeHandleMusicTextStopRequest routes stop phrase from text chat", async () => {
  const { manager } = createManager();
  const stopCalls = [];
  manager.requestStopMusic = async (payload) => {
    stopCalls.push(payload);
    return true;
  };
  manager.sessions.set(
    "guild-1",
    createSession({
      music: {
        active: true,
        phase: "playing"
      }
    })
  );

  const handled = await manager.maybeHandleMusicTextStopRequest({
    message: createMessage({
      content: "clank stop music"
    }),
    settings: null
  });
  assert.equal(handled, true);
  assert.equal(stopCalls.length, 1);
  assert.equal(stopCalls[0]?.reason, "text_music_stop_failsafe");
});

test("handleClankSlashCommand injects /clank say text into the active realtime session", async () => {
  const { manager } = createManager();
  const injectedTurns = [];
  manager.injectTextTurn = async (payload) => {
    injectedTurns.push(payload);
  };
  manager.sessions.set("guild-1", createSession());

  const slash = createClankSlashInteraction({
    subcommand: "say",
    message: "check the queue"
  });

  await manager.handleClankSlashCommand(slash.interaction as ChatInputCommandInteraction, null);

  assert.equal(slash.deferred, true);
  assert.equal(injectedTurns.length, 1);
  assert.equal(injectedTurns[0]?.text, "check the queue");
  assert.equal(injectedTurns[0]?.source, "slash_command_clank_say");
  assert.equal(slash.edits[0], "Processing: \"check the queue\"");
});

test("handleClankSlashCommand routes /clank music subcommands to the music slash handler", async () => {
  const { manager } = createManager();
  const musicCalls = [];
  manager.handleMusicSlashCommand = async (interaction, settings) => {
    musicCalls.push({ interaction, settings });
  };

  const settings = createTestSettings({
    botName: "clanky"
  });
  const slash = createClankSlashInteraction({
    subcommandGroup: "music",
    subcommand: "play",
    query: "all caps"
  });

  await manager.handleClankSlashCommand(slash.interaction as ChatInputCommandInteraction, settings);

  assert.equal(musicCalls.length, 1);
  assert.equal(musicCalls[0]?.interaction, slash.interaction);
  assert.equal(musicCalls[0]?.settings, settings);
  assert.equal(slash.deferred, false);
  assert.equal(slash.replies.length, 0);
  assert.equal(slash.edits.length, 0);
});

test("maybeHandleMusicTextSelectionRequest routes numeric disambiguation picks", async () => {
  const { manager } = createManager();
  const playCalls = [];
  manager.requestPlayMusic = async (payload) => {
    playCalls.push(payload);
    return true;
  };
  manager.sessions.set(
    "guild-1",
    createSession({
      voiceCommandState: {
        userId: "user-1",
        domain: "music",
        intent: "music_disambiguation",
        startedAt: Date.now(),
        expiresAt: Date.now() + 10_000
      },
      music: {
        pendingQuery: "all caps",
        pendingPlatform: "auto",
        pendingRequestedAt: Date.now(),
        pendingResults: [
          {
            id: "youtube:abc111",
            title: "all caps",
            artist: "mf doom",
            platform: "youtube",
            externalUrl: "https://youtube.com/watch?v=abc111",
            durationSeconds: 140
          },
          {
            id: "youtube:def222",
            title: "all caps",
            artist: "madvillain",
            platform: "youtube",
            externalUrl: "https://youtube.com/watch?v=def222",
            durationSeconds: 150
          }
        ]
      }
    })
  );

  const handled = await manager.maybeHandleMusicTextSelectionRequest({
    message: createMessage({
      content: "2"
    }),
    settings: null
  });
  assert.equal(handled, true);
  assert.equal(playCalls.length, 1);
  assert.equal(playCalls[0]?.trackId, "youtube:def222");
  assert.equal(playCalls[0]?.reason, "text_music_disambiguation_selection");
});

test("maybeHandlePendingMusicDisambiguationTurn ignores non-requesting speakers", async () => {
  const { manager } = createManager();
  const playCalls = [];
  manager.requestPlayMusic = async (payload) => {
    playCalls.push(payload);
    return true;
  };
  manager.sessions.set(
    "guild-1",
    createSession({
      music: {
        pendingQuery: "all caps",
        pendingPlatform: "auto",
        pendingAction: "play_now",
        pendingRequestedByUserId: "user-1",
        pendingRequestedAt: Date.now(),
        pendingResults: [
          {
            id: "youtube:abc111",
            title: "all caps",
            artist: "mf doom",
            platform: "youtube",
            externalUrl: "https://youtube.com/watch?v=abc111",
            durationSeconds: 140
          },
          {
            id: "youtube:def222",
            title: "all caps",
            artist: "madvillain",
            platform: "youtube",
            externalUrl: "https://youtube.com/watch?v=def222",
            durationSeconds: 150
          }
        ]
      }
    })
  );

  const handled = await manager.maybeHandlePendingMusicDisambiguationTurn({
    session: manager.sessions.get("guild-1"),
    settings: null,
    userId: "user-2",
    transcript: "2",
    source: "voice_disambiguation"
  });

  assert.equal(handled, false);
  assert.equal(playCalls.length, 0);
});

test("maybeHandlePendingMusicDisambiguationTurn clears pending state on cancel", async () => {
  const { manager, messages } = createManager();
  manager.sessions.set(
    "guild-1",
    createSession({
      voiceCommandState: {
        userId: "user-1",
        domain: "music",
        intent: "music_disambiguation",
        startedAt: Date.now(),
        expiresAt: Date.now() + 10_000
      },
      music: {
        pendingQuery: "all caps",
        pendingPlatform: "auto",
        pendingAction: "play_now",
        pendingRequestedByUserId: "user-1",
        pendingRequestedAt: Date.now(),
        pendingResults: [
          {
            id: "youtube:abc111",
            title: "all caps",
            artist: "mf doom",
            platform: "youtube",
            externalUrl: "https://youtube.com/watch?v=abc111",
            durationSeconds: 140
          }
        ]
      }
    })
  );

  const session = manager.sessions.get("guild-1");
  const handled = await manager.maybeHandlePendingMusicDisambiguationTurn({
    session,
    settings: null,
    userId: "user-1",
    transcript: "never mind",
    source: "voice_disambiguation",
    mustNotify: true
  });

  assert.equal(handled, true);
  assert.equal(manager.getMusicDisambiguationPromptContext(session), null);
  assert.equal(manager.ensureVoiceCommandState(session), null);
  assert.equal(messages.at(-1)?.reason, "disambiguation_cancelled");
});

test("requestStopMusic clears queue state when clearQueue is true", async () => {
  const { manager } = createManager();
  const session = createSession({
    music: {
      active: true,
      provider: "discord"
    },
    musicQueueState: {
      guildId: "guild-1",
      voiceChannelId: "voice-1",
      tracks: [
        {
          id: "youtube:abc111",
          title: "all caps",
          artist: "mf doom",
          durationMs: 140000,
          source: "yt",
          streamUrl: null,
          platform: "youtube",
          externalUrl: "https://youtube.com/watch?v=abc111"
        }
      ],
      nowPlayingIndex: 0,
      isPaused: false,
      volume: 1
    }
  });
  manager.sessions.set("guild-1", session);

  await manager.requestStopMusic({
    guildId: "guild-1",
    requestedByUserId: "user-1",
    settings: null,
    reason: "test_stop",
    source: "test",
    clearQueue: true,
    mustNotify: false
  });

  assert.equal(session.musicQueueState.tracks.length, 0);
  assert.equal(session.musicQueueState.nowPlayingIndex, null);
});

test("requestLeave sends not_in_voice or ends active session", async () => {
  const { manager, messages, endCalls } = createManager();

  const withoutSession = await manager.requestLeave({
    message: createMessage(),
    settings: {}
  });
  assert.equal(withoutSession, true);
  assert.equal(messages.at(-1)?.reason, "not_in_voice");

  manager.sessions.set("guild-1", createSession());
  const withSession = await manager.requestLeave({
    message: createMessage(),
    settings: {},
    reason: "manual_leave"
  });
  assert.equal(withSession, true);
  assert.equal(endCalls.length, 1);
  assert.equal(endCalls[0]?.reason, "manual_leave");
});

test("withJoinLock serializes join operations per guild key", async () => {
  const { manager } = createManager();
  const order = [];

  const first = manager.withJoinLock("guild-1", async () => {
    order.push("first:start");
    await new Promise((resolve) => setTimeout(resolve, 20));
    order.push("first:end");
    return "first";
  });
  const second = manager.withJoinLock("guild-1", async () => {
    order.push("second:run");
    return "second";
  });

  const results = await Promise.all([first, second]);
  assert.deepEqual(results, ["first", "second"]);
  assert.deepEqual(order, ["first:start", "first:end", "second:run"]);
  assert.equal(manager.joinLocks.size, 0);
});

test("reconcileSettings ends blocked sessions and touches allowed sessions", async () => {
  const { manager, endCalls, touchCalls } = createManager();

  manager.sessions.set(
    "guild-blocked",
    createSession({
      guildId: "guild-blocked",
      voiceChannelId: "voice-blocked"
    })
  );
  manager.sessions.set(
    "guild-allowed",
    createSession({
      guildId: "guild-allowed",
      voiceChannelId: "voice-allowed"
    })
  );
  manager.sessions.set(
    "guild-not-allowlisted",
    createSession({
      guildId: "guild-not-allowlisted",
      voiceChannelId: "voice-other"
    })
  );

  await manager.reconcileSettings(createTestSettings({
    voice: {
      enabled: true,
      blockedVoiceChannelIds: ["voice-blocked"],
      allowedVoiceChannelIds: ["voice-allowed"]
    }
  }));

  assert.equal(endCalls.length, 2);
  assert.deepEqual(
    endCalls.map((entry) => entry.reason).sort(),
    ["settings_channel_blocked", "settings_channel_not_allowlisted"]
  );
  assert.equal(touchCalls.length, 1);
  assert.equal(touchCalls[0]?.guildId, "guild-allowed");
});

test("reconcileSettings hot-refreshes active realtime sessions", async () => {
  const { manager, touchCalls, logs } = createManager();
  const instructionRefreshCalls = [];
  const toolUpdates = [];
  manager.instructionManager.scheduleRealtimeInstructionRefresh = (payload) => {
    instructionRefreshCalls.push(payload);
  };

  const originalMaxTimer = setTimeout(() => {}, 60_000);
  const session = createSession({
    mode: "openai_realtime",
    realtimeToolOwnership: "provider_native",
    maxTimer: originalMaxTimer,
    realtimeClient: {
      updateTools(payload) {
        toolUpdates.push(payload);
      },
      updateInstructions() {}
    }
  });
  manager.sessions.set(session.guildId, session);

  const nextSettings = createTestSettings({
    voice: {
      enabled: true,
      replyPath: "bridge",
      maxSessionMinutes: 45
    }
  });

  await manager.reconcileSettings(nextSettings);

  assert.equal(session.settingsSnapshot, nextSettings);
  assert.notEqual(session.maxTimer, originalMaxTimer);
  assert.equal(touchCalls.length, 1);
  assert.equal(toolUpdates.length, 1);
  assert.equal(instructionRefreshCalls.length, 1);
  assert.equal(instructionRefreshCalls[0]?.reason, "settings_reconcile");
  assert.equal(
    logs.some((entry) => entry.content === "voice_session_settings_reconciled"),
    true
  );

  clearTimeout(originalMaxTimer);
  clearTimeout(session.maxTimer);
});

test("handleVoiceStateUpdate records join/leave membership events and refreshes realtime instructions", async () => {
  const { manager, logs } = createManager();
  const now = Date.now();
  const refreshCalls = [];
  manager.instructionManager.scheduleRealtimeInstructionRefresh = (payload) => {
    refreshCalls.push(payload);
  };

  const session = createSession({
    mode: "openai_realtime",
    membershipEvents: [],
    pendingAmbientThought: {
      id: "thought-1",
      status: "queued",
      trigger: "timer",
      draftText: "save the octopus fact",
      currentText: "save the octopus fact",
      createdAt: now - 30_000,
      updatedAt: now - 30_000,
      basisAt: now - 30_000,
      notBeforeAt: now + 5_000,
      expiresAt: now + 60_000,
      revision: 1,
      lastDecisionReason: "felt half-baked",
      lastDecisionAction: "hold",
      memoryFactCount: 0,
      usedMemory: false,
      invalidatedAt: null,
      invalidatedByUserId: null,
      invalidationReason: null
    }
  });
  manager.sessions.set("guild-1", session);

  await manager.handleVoiceStateUpdate(
    {
      id: "user-2",
      guild: { id: "guild-1" },
      channelId: null,
      member: {
        user: { bot: false, username: "bob_user" },
        displayName: "bob"
      }
    },
    {
      id: "user-2",
      guild: { id: "guild-1" },
      channelId: "voice-1",
      member: {
        user: { bot: false, username: "bob_user" },
        displayName: "bob"
      }
    }
  );

  await manager.handleVoiceStateUpdate(
    {
      id: "user-2",
      guild: { id: "guild-1" },
      channelId: "voice-1",
      member: {
        user: { bot: false, username: "bob_user" },
        displayName: "bob"
      }
    },
    {
      id: "user-2",
      guild: { id: "guild-1" },
      channelId: null,
      member: {
        user: { bot: false, username: "bob_user" },
        displayName: "bob"
      }
    }
  );

  assert.equal(Array.isArray(session.membershipEvents), true);
  assert.equal(session.membershipEvents.length, 2);
  assert.equal(session.membershipEvents[0]?.eventType, "join");
  assert.equal(session.membershipEvents[1]?.eventType, "leave");
  assert.equal(session.membershipEvents[0]?.displayName, "bob");
  assert.equal(session.membershipEvents[1]?.displayName, "bob");

  assert.equal(refreshCalls.length, 2);
  assert.equal(refreshCalls[0]?.reason, "voice_membership_changed");
  assert.equal(refreshCalls[1]?.reason, "voice_membership_changed");
  assert.equal(refreshCalls[0]?.speakerUserId, "user-2");
  assert.equal(refreshCalls[1]?.speakerUserId, "user-2");

  const membershipLogs = logs.filter((entry) => entry?.content === "voice_membership_changed");
  assert.equal(membershipLogs.length, 2);
  assert.equal(membershipLogs[0]?.metadata?.eventType, "join");
  assert.equal(membershipLogs[1]?.metadata?.eventType, "leave");
  assert.equal(session.pendingAmbientThought?.status, "reconsider");
  assert.equal(session.pendingAmbientThought?.lastDecisionReason, "felt half-baked");
  assert.equal(session.pendingAmbientThought?.invalidationReason, "member_leave");
  assert.equal(session.pendingAmbientThought?.invalidatedByUserId, "user-2");
});

test("handleVoiceChannelEffectSend marks a pending ambient thought stale without erasing its hold reason", async () => {
  const { manager, logs } = createManager();
  const now = Date.now();
  const session = createSession({
    mode: "openai_realtime",
    pendingAmbientThought: {
      id: "thought-1",
      status: "queued",
      trigger: "timer",
      draftText: "drop the cursed rimshot line later",
      currentText: "drop the cursed rimshot line later",
      createdAt: now - 30_000,
      updatedAt: now - 30_000,
      basisAt: now - 30_000,
      notBeforeAt: now + 5_000,
      expiresAt: now + 60_000,
      revision: 1,
      lastDecisionReason: "felt half-baked",
      lastDecisionAction: "hold",
      memoryFactCount: 0,
      usedMemory: false,
      invalidatedAt: null,
      invalidatedByUserId: null,
      invalidationReason: null
    }
  });
  manager.sessions.set("guild-1", session);

  await manager.handleVoiceChannelEffectSend({
    guild: {
      id: "guild-1",
      members: {
        cache: new Map([
          ["user-2", { displayName: "bob" }]
        ])
      }
    },
    channelId: "voice-1",
    userId: "user-2",
    soundId: "sound-1",
    soundboardSound: {
      name: "rimshot"
    },
    soundVolume: 0.5,
    emoji: null,
    animationType: null,
    animationId: null
  });

  assert.equal(session.pendingAmbientThought?.status, "reconsider");
  assert.equal(session.pendingAmbientThought?.lastDecisionReason, "felt half-baked");
  assert.equal(session.pendingAmbientThought?.invalidationReason, "voice_effect");
  assert.equal(session.pendingAmbientThought?.invalidatedByUserId, "user-2");
  assert.equal(logs.some((entry) => entry?.content === "voice_channel_effect_send"), true);
});

test("dispose detaches handlers and clears join locks", async () => {
  const { manager, offCalls } = createManager();
  manager.joinLocks.set("guild-1", Promise.resolve());
  manager.sessions.set("guild-1", createSession());

  await manager.dispose("shutdown");

  assert.equal(offCalls.includes("voiceStateUpdate"), true);
  assert.equal(manager.joinLocks.size, 0);
});
