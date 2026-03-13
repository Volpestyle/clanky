import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  getVoiceScreenWatchCapability,
  startVoiceScreenWatch
} from "./screenShare.ts";

function createScreenShareRuntime({
  capability = null,
  createSessionResult = null,
  nativeStartResult = null,
  nativeDecoderSupported = true,
  activeSharerUserIds = nativeStartResult ? ["user-1"] : [],
  goLiveStreamTargetUserId = null,
  existingNativeWatch = null,
  participantEntries = [
    { userId: "user-1", displayName: "alice", username: "alice_user" },
    { userId: "user-2", displayName: "bob", username: "bob_user" },
    { userId: "user-3", displayName: "casey", username: "casey_user" }
  ],
  offerMessage = "bet, open this and start sharing",
  unavailableMessage = "can't share screen links right now"
} = {}) {
  const sentMessages = [];
  const logs = [];
  const createSessionCalls = [];
  const nativeStartCalls = [];
  const channel = {
    id: "chan-1",
    guildId: "guild-1"
  };
  const memberCache = new Map(
    participantEntries.map((entry) => [
      entry.userId,
      {
        displayName: entry.displayName,
        user: { username: entry.username }
      }
    ])
  );
  const sessionState = {
    ending: false,
    mode: "openai_realtime",
    voiceChannelId: "voice-1",
    streamWatch: existingNativeWatch
      ? {
          active: true,
          targetUserId: existingNativeWatch.targetUserId
        }
      : undefined,
    goLiveStream: goLiveStreamTargetUserId
      ? {
          active: true,
          targetUserId: goLiveStreamTargetUserId
        }
      : undefined,
    settingsSnapshot: {
      voice: {
        streamWatch: {
          enabled: true
        }
      }
    },
    nativeScreenShare: {
      sharers: new Map(
        activeSharerUserIds.map((userId, index) => {
          const streamSsrc = 4_200 + index;
          return [
            userId,
            {
              userId,
              codec: "h264",
              videoSsrc: streamSsrc,
              streams: [
                {
                  ssrc: streamSsrc,
                  rtxSsrc: streamSsrc + 100,
                  rid: "100",
                  quality: 100,
                  streamType: "screen",
                  active: true
                }
              ]
            }
          ];
        })
      ),
      transportStatus: existingNativeWatch?.transportStatus || null,
      lastDecodeSuccessAt: existingNativeWatch?.lastDecodeSuccessAt || 0
    }
  };

  return {
    sentMessages,
    logs,
    createSessionCalls,
    nativeStartCalls,
    sessionState,
    runtime: {
      screenShareSessionManager:
        capability || createSessionResult
          ? {
              getLinkCapability() {
                return capability;
              },
              async createSession(payload) {
                createSessionCalls.push(payload);
                return createSessionResult;
              }
            }
          : null,
      voiceSessionManager: nativeStartResult || existingNativeWatch
        ? {
            hasNativeDiscordVideoDecoderSupport() {
              return nativeDecoderSupported;
            },
            getSession() {
              return sessionState;
            },
            getVoiceChannelParticipants() {
              return participantEntries.map((entry) => ({
                userId: entry.userId,
                displayName: entry.displayName
              }));
            },
            isUserInSessionVoiceChannel() {
              return true;
            },
            supportsStreamWatchCommentary() {
              return true;
            },
            async enableWatchStreamForUser(payload) {
              nativeStartCalls.push(payload);
              return nativeStartResult;
            }
          }
        : null,
      composeVoiceOperationalMessage: async () => "",
      composeScreenShareOfferMessage: async ({ linkUrl }) => `${offerMessage}: ${String(linkUrl || "")}`,
      composeScreenShareUnavailableMessage: async () => unavailableMessage,
      resolveOperationalChannel: async () => channel,
      sendToChannel: async (_channel, text) => {
        sentMessages.push(text);
        return true;
      },
      store: {
        getSettings() {
          return {};
        },
        logAction(entry) {
          logs.push(entry);
        }
      },
      client: {
        guilds: {
          cache: new Map([[
            "guild-1",
            {
              members: {
                cache: memberCache
              }
            }
          ]])
        },
        users: {
          cache: new Map()
        }
      }
    }
  };
}

test("getVoiceScreenWatchCapability normalizes status and handles missing manager", () => {
  const missingRuntime = createScreenShareRuntime().runtime;
  const unavailable = getVoiceScreenWatchCapability(missingRuntime, {
    settings: {
      voice: {
        streamWatch: {
          enabled: true
        }
      }
    }
  });
  assert.equal(unavailable.supported, false);
  assert.equal(unavailable.enabled, false);
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.status, "disabled");
  assert.equal(unavailable.reason, "screen_watch_unavailable");

  const readyRuntime = createScreenShareRuntime({
    capability: {
      enabled: true,
      status: "READY",
      publicUrl: " https://demo.trycloudflare.com "
    }
  }).runtime;
  const ready = getVoiceScreenWatchCapability(readyRuntime, {
    settings: {
      voice: {
        streamWatch: {
          enabled: true
        }
      }
    }
  });
  assert.equal(ready.supported, true);
  assert.equal(ready.enabled, true);
  assert.equal(ready.available, true);
  assert.equal(ready.status, "ready");
  assert.equal(ready.publicUrl, "https://demo.trycloudflare.com");
  assert.equal(ready.reason, null);

  const warmingRuntime = createScreenShareRuntime({
    capability: {
      enabled: true,
      status: "starting",
      publicUrl: "https://demo.trycloudflare.com"
    }
  }).runtime;
  const warming = getVoiceScreenWatchCapability(warmingRuntime, {
    settings: {
      voice: {
        streamWatch: {
          enabled: true
        }
      }
    }
  });
  assert.equal(warming.supported, true);
  assert.equal(warming.enabled, true);
  assert.equal(warming.available, false);
  assert.equal(warming.status, "starting");
  assert.equal(warming.reason, "starting");
});

test("startVoiceScreenWatch sends generated offer to text channel when session is created", async () => {
  const { runtime, sentMessages, createSessionCalls } = createScreenShareRuntime({
    createSessionResult: {
      ok: true,
      shareUrl: "https://screen.example/session/abc",
      expiresInMinutes: 12
    }
  });

  const result = await startVoiceScreenWatch(runtime, {
    settings: {
      voice: {
        streamWatch: {
          enabled: true
        }
      }
    },
    guildId: "guild-1",
    channelId: "chan-1",
    requesterUserId: "user-1",
    transcript: "yo look at this",
    source: "voice_turn_directive"
  });

  assert.equal(result.started, true);
  assert.equal(result.transport, "link");
  assert.equal(result.reason, "started");
  assert.equal(sentMessages.length, 1);
  assert.match(String(sentMessages[0] || ""), /screen\.example\/session\/abc/);
  assert.equal(createSessionCalls.length, 1);
  assert.equal(createSessionCalls[0]?.guildId, "guild-1");
  assert.equal(createSessionCalls[0]?.channelId, "chan-1");
  assert.equal(createSessionCalls[0]?.requesterUserId, "user-1");
  assert.equal(createSessionCalls[0]?.targetUserId, "user-1");
  assert.equal(createSessionCalls[0]?.source, "voice_turn_directive");
});

test("startVoiceScreenWatch sends generated unavailable text when session creation fails", async () => {
  const { runtime, sentMessages } = createScreenShareRuntime({
    createSessionResult: {
      ok: false,
      reason: "provider_unavailable"
    }
  });

  const result = await startVoiceScreenWatch(runtime, {
    settings: {
      voice: {
        streamWatch: {
          enabled: true
        }
      }
    },
    guildId: "guild-1",
    channelId: "chan-1",
    requesterUserId: "user-1",
    transcript: "screen share broken?",
    source: "voice_turn_directive"
  });

  assert.equal(result.started, false);
  assert.equal(result.reason, "provider_unavailable");
  assert.equal(sentMessages.length, 1);
  assert.match(String(sentMessages[0] || ""), /can't share screen links right now/i);
});

test("startVoiceScreenWatch prefers native watch before link fallback", async () => {
  const { runtime, sentMessages, createSessionCalls } = createScreenShareRuntime({
    createSessionResult: {
      ok: true,
      shareUrl: "https://screen.example/session/abc",
      expiresInMinutes: 12
    },
    nativeStartResult: {
      ok: true,
      reason: "watching_started",
      targetUserId: "user-1"
    }
  });

  const result = await startVoiceScreenWatch(runtime, {
    settings: {
      voice: {
        streamWatch: {
          enabled: true
        }
      }
    },
    guildId: "guild-1",
    channelId: "chan-1",
    requesterUserId: "user-1",
    transcript: "watch this live",
    source: "voice_turn_directive"
  });

  assert.equal(result.started, true);
  assert.equal(result.transport, "native");
  assert.equal(result.reason, "watching_started");
  assert.equal(sentMessages.length, 0);
  assert.equal(createSessionCalls.length, 0);
});

test("getVoiceScreenWatchCapability treats the master toggle as disabling both native and fallback paths", () => {
  const { runtime } = createScreenShareRuntime({
    capability: {
      enabled: true,
      status: "ready",
      publicUrl: "https://screen.example"
    },
    nativeStartResult: {
      ok: true,
      reason: "watching_started",
      targetUserId: "user-1"
    }
  });

  const capability = getVoiceScreenWatchCapability(runtime, {
    settings: {
      voice: {
        streamWatch: {
          enabled: false
        }
      }
    },
    guildId: "guild-1",
    requesterUserId: "user-1"
  });

  assert.equal(capability.available, false);
  assert.equal(capability.enabled, false);
  assert.equal(capability.reason, "stream_watch_disabled");
});

test("startVoiceScreenWatch can start native watch without a text channel", async () => {
  const { runtime, sentMessages, createSessionCalls } = createScreenShareRuntime({
    nativeStartResult: {
      ok: true,
      reason: "watching_started",
      targetUserId: "user-1"
    }
  });

  const result = await startVoiceScreenWatch(runtime, {
    settings: {
      voice: {
        streamWatch: {
          enabled: true
        }
      }
    },
    guildId: "guild-1",
    channelId: null,
    requesterUserId: "user-1",
    transcript: "watch this",
    source: "voice_turn_directive"
  });

  assert.equal(result.started, true);
  assert.equal(result.transport, "native");
  assert.equal(sentMessages.length, 0);
  assert.equal(createSessionCalls.length, 0);
});

test("getVoiceScreenWatchCapability reports active native sharers from the Bun voice session", () => {
  const { runtime } = createScreenShareRuntime({
    nativeStartResult: {
      ok: true,
      reason: "watching_started",
      targetUserId: "user-2"
    },
    activeSharerUserIds: ["user-2"]
  });

  const capability = getVoiceScreenWatchCapability(runtime, {
    settings: {
      voice: {
        streamWatch: {
          enabled: true
        }
      }
    },
    guildId: "guild-1",
    requesterUserId: "user-1"
  });

  assert.equal(capability.activeSharerCount, 1);
  assert.deepEqual(capability.activeSharerUserIds, ["user-2"]);
});

test("getVoiceScreenWatchCapability stays available when multiple active sharers require explicit target selection", () => {
  const { runtime } = createScreenShareRuntime({
    nativeStartResult: {
      ok: true,
      reason: "watching_started",
      targetUserId: "user-2"
    },
    activeSharerUserIds: ["user-2", "user-3"]
  });

  const capability = getVoiceScreenWatchCapability(runtime, {
    settings: {
      voice: {
        streamWatch: {
          enabled: true
        }
      }
    },
    guildId: "guild-1",
    requesterUserId: "user-1"
  });

  assert.equal(capability.available, true);
  assert.equal(capability.nativeAvailable, true);
  assert.equal(capability.activeSharerCount, 2);
});

test("startVoiceScreenWatch binds native watch to the active Discord sharer instead of the requester", async () => {
  const { runtime } = createScreenShareRuntime({
    nativeStartResult: {
      ok: true,
      reason: "watching_started",
      targetUserId: "user-2"
    },
    activeSharerUserIds: ["user-2"]
  });

  const result = await startVoiceScreenWatch(runtime, {
    settings: {
      voice: {
        streamWatch: {
          enabled: true
        }
      }
    },
    guildId: "guild-1",
    channelId: "chan-1",
    requesterUserId: "user-1",
    transcript: "watch the share",
    source: "voice_turn_directive"
  });

  assert.equal(result.started, true);
  assert.equal(result.transport, "native");
  assert.equal(result.targetUserId, "user-2");
});

test("startVoiceScreenWatch lets the runtime choose a specific active sharer by name", async () => {
  const { runtime, nativeStartCalls } = createScreenShareRuntime({
    nativeStartResult: {
      ok: true,
      reason: "watching_started",
      targetUserId: "user-3"
    },
    activeSharerUserIds: ["user-2", "user-3"]
  });

  const result = await startVoiceScreenWatch(runtime, {
    settings: {
      voice: {
        streamWatch: {
          enabled: true
        }
      }
    },
    guildId: "guild-1",
    channelId: "chan-1",
    requesterUserId: "user-1",
    target: "casey",
    transcript: "watch casey's stream",
    source: "voice_turn_directive"
  });

  assert.equal(result.started, true);
  assert.equal(result.transport, "native");
  assert.equal(result.targetUserId, "user-3");
  assert.equal(nativeStartCalls.length, 1);
  assert.equal(nativeStartCalls[0]?.targetUserId, "user-3");
});

test("startVoiceScreenWatch falls back to the share link when no active Discord sharer exists", async () => {
  const { runtime, sentMessages, createSessionCalls, logs } = createScreenShareRuntime({
    nativeStartResult: {
      ok: true,
      reason: "watching_started",
      targetUserId: "user-1"
    },
    activeSharerUserIds: [],
    createSessionResult: {
      ok: true,
      shareUrl: "https://screen.example/session/fallback",
      expiresInMinutes: 15
    }
  });

  const result = await startVoiceScreenWatch(runtime, {
    settings: {
      voice: {
        streamWatch: {
          enabled: true
        }
      }
    },
    guildId: "guild-1",
    channelId: "chan-1",
    requesterUserId: "user-1",
    transcript: "watch my screen",
    source: "voice_turn_directive"
  });

  assert.equal(result.started, true);
  assert.equal(result.transport, "link");
  assert.equal(createSessionCalls.length, 1);
  assert.equal(sentMessages.length, 1);
  const nativeFailure = logs.find((entry) => String(entry?.content || "") === "screen_watch_native_start_failed");
  assert.equal(nativeFailure?.metadata?.reason, "no_active_discord_screen_share");
  assert.deepEqual(nativeFailure?.metadata?.nativeActiveSharerUserIds, []);
  const fallbackStarted = logs.find((entry) => String(entry?.content || "") === "screen_watch_link_fallback_started");
  assert.equal(fallbackStarted?.metadata?.nativeFailureReason, "no_active_discord_screen_share");
});

test("startVoiceScreenWatch can force share-link recovery without retrying native watch", async () => {
  const { runtime, sentMessages, createSessionCalls, nativeStartCalls, logs } = createScreenShareRuntime({
    nativeStartResult: {
      ok: true,
      reason: "watching_started",
      targetUserId: "user-2"
    },
    activeSharerUserIds: ["user-2"],
    createSessionResult: {
      ok: true,
      shareUrl: "https://screen.example/session/recovery",
      expiresInMinutes: 15,
      targetUserId: "user-2"
    }
  });

  const result = await startVoiceScreenWatch(runtime, {
    settings: {
      voice: {
        streamWatch: {
          enabled: true
        }
      }
    },
    guildId: "guild-1",
    channelId: "chan-1",
    requesterUserId: "user-1",
    targetUserId: "user-2",
    source: "native_discord_stream_transport_failed",
    preferredTransport: "link",
    nativeFailureReason: "native_discord_stream_transport_failed"
  });

  assert.equal(result.started, true);
  assert.equal(result.transport, "link");
  assert.equal(nativeStartCalls.length, 0);
  assert.equal(createSessionCalls.length, 1);
  assert.equal(createSessionCalls[0]?.targetUserId, "user-2");
  assert.equal(sentMessages.length, 1);
  const fallbackStarted = logs.find((entry) => String(entry?.content || "") === "screen_watch_link_fallback_started");
  assert.equal(fallbackStarted?.metadata?.nativeFailureReason, "native_discord_stream_transport_failed");
});

test("startVoiceScreenWatch targets the named voice participant for share-link fallback when they are not actively sharing", async () => {
  const { runtime, createSessionCalls, logs } = createScreenShareRuntime({
    nativeStartResult: {
      ok: true,
      reason: "watching_started",
      targetUserId: "user-2"
    },
    activeSharerUserIds: [],
    createSessionResult: {
      ok: true,
      shareUrl: "https://screen.example/session/bob",
      expiresInMinutes: 15,
      targetUserId: "user-2"
    }
  });

  const result = await startVoiceScreenWatch(runtime, {
    settings: {
      voice: {
        streamWatch: {
          enabled: true
        }
      }
    },
    guildId: "guild-1",
    channelId: "chan-1",
    requesterUserId: "user-1",
    target: "bob",
    transcript: "watch bob's screen",
    source: "voice_turn_directive"
  });

  assert.equal(result.started, true);
  assert.equal(result.transport, "link");
  assert.equal(createSessionCalls.length, 1);
  assert.equal(createSessionCalls[0]?.targetUserId, "user-2");
  const nativeFailure = logs.find((entry) => String(entry?.content || "") === "screen_watch_native_start_failed");
  assert.equal(nativeFailure?.metadata?.reason, "requested_target_not_actively_sharing");
  assert.equal(nativeFailure?.metadata?.requestedTargetUserId, "user-2");
  const fallbackStarted = logs.find((entry) => String(entry?.content || "") === "screen_watch_link_fallback_started");
  assert.equal(fallbackStarted?.metadata?.nativeFailureReason, "requested_target_not_actively_sharing");
});

test("startVoiceScreenWatch trusts discovered Go Live state for an explicit target before falling back", async () => {
  const { runtime, createSessionCalls, nativeStartCalls, logs, sentMessages } = createScreenShareRuntime({
    nativeStartResult: {
      ok: true,
      reason: "watching_started",
      targetUserId: "user-2"
    },
    activeSharerUserIds: [],
    goLiveStreamTargetUserId: "user-2",
    createSessionResult: {
      ok: true,
      shareUrl: "https://screen.example/session/should-not-fallback",
      expiresInMinutes: 15,
      targetUserId: "user-2"
    }
  });

  const result = await startVoiceScreenWatch(runtime, {
    settings: {
      voice: {
        streamWatch: {
          enabled: true
        }
      }
    },
    guildId: "guild-1",
    channelId: "chan-1",
    requesterUserId: "user-1",
    targetUserId: "user-2",
    transcript: "watch bob's screen",
    source: "voice_turn_directive"
  });

  assert.equal(result.started, true);
  assert.equal(result.transport, "native");
  assert.equal(nativeStartCalls.length, 1);
  assert.equal(nativeStartCalls[0]?.targetUserId, "user-2");
  assert.equal(createSessionCalls.length, 0);
  assert.equal(sentMessages.length, 0);
  const nativeFailure = logs.find((entry) => String(entry?.content || "") === "screen_watch_native_start_failed");
  assert.equal(nativeFailure, undefined);
  const fallbackStarted = logs.find((entry) => String(entry?.content || "") === "screen_watch_link_fallback_started");
  assert.equal(fallbackStarted, undefined);
});

test("startVoiceScreenWatch cancels a stale link fallback once native watch becomes ready before send", async () => {
  const { runtime, createSessionCalls, logs, sentMessages, sessionState } = createScreenShareRuntime({
    createSessionResult: {
      ok: true,
      shareUrl: "https://screen.example/session/stale-fallback",
      expiresInMinutes: 15,
      targetUserId: "user-2"
    },
    existingNativeWatch: {
      targetUserId: "user-2",
      transportStatus: null,
      lastDecodeSuccessAt: 0
    },
    offerMessage: "unused"
  });

  runtime.composeScreenShareOfferMessage = async ({ linkUrl }) => {
    assert.equal(linkUrl, "https://screen.example/session/stale-fallback");
    sessionState.nativeScreenShare.transportStatus = "ready";
    sessionState.nativeScreenShare.lastDecodeSuccessAt = Date.now();
    return "should never send";
  };

  const result = await startVoiceScreenWatch(runtime, {
    settings: {
      voice: {
        streamWatch: {
          enabled: true
        }
      }
    },
    guildId: "guild-1",
    channelId: "chan-1",
    requesterUserId: "user-1",
    targetUserId: "user-2",
    source: "native_discord_stream_transport_failed",
    preferredTransport: "link",
    nativeFailureReason: "requested_target_not_actively_sharing"
  });

  assert.equal(result.started, true);
  assert.equal(result.transport, "native");
  assert.equal(createSessionCalls.length, 1);
  assert.equal(sentMessages.length, 0);
  const fallbackStarted = logs.find((entry) => String(entry?.content || "") === "screen_watch_link_fallback_started");
  assert.equal(fallbackStarted, undefined);
  const fallbackCancelled = logs.find((entry) => String(entry?.content || "") === "screen_watch_link_fallback_cancelled_native_active");
  assert.equal(fallbackCancelled?.metadata?.stage, "post_compose");
});

test("startVoiceScreenWatch does not guess when multiple active sharers exist and no target was provided", async () => {
  const { runtime, createSessionCalls, logs } = createScreenShareRuntime({
    nativeStartResult: {
      ok: true,
      reason: "watching_started",
      targetUserId: "user-2"
    },
    activeSharerUserIds: ["user-2", "user-3"],
    createSessionResult: {
      ok: true,
      shareUrl: "https://screen.example/session/should-not-start",
      expiresInMinutes: 15
    }
  });

  const result = await startVoiceScreenWatch(runtime, {
    settings: {
      voice: {
        streamWatch: {
          enabled: true
        }
      }
    },
    guildId: "guild-1",
    channelId: "chan-1",
    requesterUserId: "user-1",
    transcript: "watch the screen share",
    source: "voice_turn_directive"
  });

  assert.equal(result.started, false);
  assert.equal(result.reason, "multiple_active_discord_screen_shares");
  assert.equal(createSessionCalls.length, 0);
  const nativeFailure = logs.find((entry) => String(entry?.content || "") === "screen_watch_native_start_failed");
  assert.equal(nativeFailure?.metadata?.reason, "multiple_active_discord_screen_shares");
  assert.deepEqual(nativeFailure?.metadata?.nativeActiveSharerUserIds, ["user-2", "user-3"]);
});
