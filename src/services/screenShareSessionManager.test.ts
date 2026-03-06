import { test } from "bun:test";
import assert from "node:assert/strict";
import { ScreenShareSessionManager } from "./screenShareSessionManager.ts";

function createHarness({
  appConfig = {},
  publicState = {
    enabled: true,
    status: "ready",
    publicUrl: "https://fancy-cat.trycloudflare.com"
  },
  getVoiceSession = () => ({
    guildId: "guild-1",
    voiceChannelId: "vc-1",
    ending: false
  }),
  settings = {
    voice: {
      streamWatch: {
        enabled: true
      }
    }
  },
  isUserInSessionVoiceChannel = () => true,
  enableWatchStreamForUser = async () => ({ ok: true }),
  stopWatchStreamForUser = async () => ({ ok: true, reason: "watching_stopped" }),
  ingestVoiceStreamFrame = async () => ({
    accepted: true,
    reason: "ok"
  })
} = {}) {
  const actions = [];
  const ingestCalls = [];
  const watchCalls = [];
  const store = {
    getSettings() {
      return settings;
    },
    logAction(action) {
      actions.push(action);
    }
  };
  const bot = {
    voiceSessionManager: {
      async enableWatchStreamForUser(payload) {
        watchCalls.push(payload);
        return await enableWatchStreamForUser(payload);
      },
      async stopWatchStreamForUser(payload) {
        return await stopWatchStreamForUser(payload);
      },
      getSession() {
        return getVoiceSession();
      },
      isUserInSessionVoiceChannel
    },
    async ingestVoiceStreamFrame(payload) {
      ingestCalls.push(payload);
      return await ingestVoiceStreamFrame(payload, ingestCalls.length);
    }
  };
  const publicHttpsEntrypoint = {
    getState() {
      return publicState;
    }
  };
  const manager = new ScreenShareSessionManager({
    appConfig,
    store,
    bot,
    publicHttpsEntrypoint
  });
  return {
    actions,
    manager,
    watchCalls,
    ingestCalls,
    getIngestCalls: () => ingestCalls.length
  };
}

test("createSession logs share host only (not full share URL token)", async () => {
  const { actions, manager } = createHarness();
  const created = await manager.createSession({
    guildId: "guild-1",
    channelId: "channel-1",
    requesterUserId: "user-1",
    requesterDisplayName: "volpe",
    targetUserId: "user-1",
    source: "test"
  });

  assert.equal(created.ok, true);
  const action = actions.find((entry) => String(entry?.content || "") === "screen_share_session_created");
  assert.ok(action);
  assert.equal(action.metadata.shareHost, "fancy-cat.trycloudflare.com");
  assert.equal("shareUrl" in (action.metadata || {}), false);
});

test("ingestFrameByToken rejects and stops session when requester leaves VC", async () => {
  const { actions, manager, getIngestCalls } = createHarness({
    isUserInSessionVoiceChannel({ userId }) {
      return String(userId || "") !== "user-1";
    }
  });
  const created = await manager.createSession({
    guildId: "guild-1",
    channelId: "channel-1",
    requesterUserId: "user-1",
    requesterDisplayName: "volpe",
    targetUserId: "user-1",
    source: "test"
  });
  assert.equal(created.ok, true);

  const result = await manager.ingestFrameByToken({
    token: created.token,
    mimeType: "image/jpeg",
    dataBase64: "dGVzdA==",
    source: "test"
  });

  assert.equal(result.accepted, false);
  assert.equal(result.reason, "requester_not_in_same_vc");
  assert.equal(getIngestCalls(), 0);
  assert.equal(manager.getSessionByToken(created.token), null);
  const stopAction = [...actions]
    .reverse()
    .find((entry) => String(entry?.content || "") === "screen_share_session_stopped");
  assert.ok(stopAction);
  assert.equal(stopAction.metadata.reason, "requester_not_in_same_vc");
});

test("ingestFrameByToken rejects and stops session when target leaves VC", async () => {
  const { actions, manager, getIngestCalls } = createHarness({
    isUserInSessionVoiceChannel({ userId }) {
      return String(userId || "") !== "target-9";
    }
  });
  const created = await manager.createSession({
    guildId: "guild-1",
    channelId: "channel-1",
    requesterUserId: "user-1",
    requesterDisplayName: "volpe",
    targetUserId: "target-9",
    source: "test"
  });
  assert.equal(created.ok, true);

  const result = await manager.ingestFrameByToken({
    token: created.token,
    mimeType: "image/jpeg",
    dataBase64: "dGVzdA==",
    source: "test"
  });

  assert.equal(result.accepted, false);
  assert.equal(result.reason, "target_user_not_in_same_vc");
  assert.equal(getIngestCalls(), 0);
  assert.equal(manager.getSessionByToken(created.token), null);
  const stopAction = [...actions]
    .reverse()
    .find((entry) => String(entry?.content || "") === "screen_share_session_stopped");
  assert.ok(stopAction);
  assert.equal(stopAction.metadata.reason, "target_user_not_in_same_vc");
});

test("cleanup and runtime state remove expired sessions and trim oldest overflow", () => {
  const { manager } = createHarness();
  const nowMs = Date.now();
  manager.sessions.set("expired-token", {
    token: "expired-token",
    createdAt: 1,
    expiresAt: nowMs - 1
  });
  for (let index = 0; index < 242; index += 1) {
    manager.sessions.set(`token-${index}`, {
      token: `token-${index}`,
      createdAt: index,
      expiresAt: nowMs + 60_000 + index
    });
  }

  manager.cleanupExpiredSessions(nowMs);
  assert.equal(manager.sessions.has("expired-token"), false);
  assert.equal(manager.sessions.size, 240);
  assert.equal(manager.sessions.has("token-0"), false);
  assert.equal(manager.sessions.has("token-1"), false);

  const runtime = manager.getRuntimeState();
  assert.equal(runtime.activeCount, 240);
  assert.equal(runtime.newestExpiresAt, new Date(nowMs + 60_000 + 241).toISOString());
});

test("link capability uses local fallback and prefers public URL when available", () => {
  const { manager } = createHarness({
    appConfig: {
      dashboardPort: 9191
    },
    publicState: {
      enabled: true,
      status: "starting",
      publicUrl: ""
    }
  });
  assert.deepEqual(manager.getLinkCapability(), {
    enabled: true,
    status: "ready",
    publicUrl: "http://127.0.0.1:9191"
  });
  assert.equal(manager.getPublicShareUrlForToken("abc"), "http://127.0.0.1:9191/share/abc");

  manager.publicHttpsEntrypoint = {
    getState() {
      return {
        enabled: true,
        status: "ready",
        publicUrl: "https://fancy-cat.trycloudflare.com/"
      };
    }
  };
  assert.equal(
    manager.getPublicShareUrlForToken("a/b"),
    "https://fancy-cat.trycloudflare.com/share/a%2Fb"
  );
});

test("createSession rejects invalid input and falls back to localhost share URL", async () => {
  const { manager } = createHarness();
  const invalid = await manager.createSession({
    guildId: "",
    requesterUserId: ""
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.reason, "invalid_share_request");

  const noPublic = createHarness({
    publicState: {
      enabled: false,
      status: "disabled",
      publicUrl: ""
    }
  });
  const unavailable = await noPublic.manager.createSession({
    guildId: "guild-1",
    channelId: "channel-1",
    requesterUserId: "user-1"
  });
  assert.equal(unavailable.ok, true);
  assert.equal(
    String(unavailable.shareUrl || "").startsWith("http://127.0.0.1:8787/share/"),
    true
  );
});

test("createSession propagates stream-watch failures and clamps ttl and fields on success", async () => {
  const blocked = createHarness({
    enableWatchStreamForUser: async () => ({
      ok: false,
      reason: "watch_unavailable",
      fallback: "join voice first"
    })
  });
  const failed = await blocked.manager.createSession({
    guildId: "guild-1",
    channelId: "channel-1",
    requesterUserId: "user-1"
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, "watch_unavailable");
  assert.equal(failed.message, "join voice first");

  const success = createHarness({
    appConfig: {
      publicShareSessionTtlMinutes: 999
    }
  });
  const created = await success.manager.createSession({
    guildId: "guild-1",
    channelId: "channel-1",
    requesterUserId: "user-1",
    requesterDisplayName: "x".repeat(200),
    targetUserId: null,
    source: "z".repeat(200)
  });
  assert.equal(created.ok, true);
  assert.equal(created.expiresInMinutes, 30);
  assert.equal(created.targetUserId, "user-1");
  const session = success.manager.getSessionByToken(created.token);
  assert.equal(session?.requesterDisplayName?.length, 80);
  assert.equal(session?.source?.length, 80);
});

test("ingestFrameByToken handles missing sessions, rearm, and unknown ingestor results", async () => {
  const { manager, watchCalls, ingestCalls } = createHarness({
    ingestVoiceStreamFrame: async (_payload, callCount) => {
      if (callCount === 1) {
        return {
          accepted: false,
          reason: "watch_not_active"
        };
      }
      return {
        accepted: true,
        reason: "ok"
      };
    }
  });
  const missing = await manager.ingestFrameByToken({
    token: "missing-token"
  });
  assert.equal(missing.accepted, false);
  assert.equal(missing.reason, "share_session_not_found");

  const created = await manager.createSession({
    guildId: "guild-1",
    channelId: "channel-1",
    requesterUserId: "user-1",
    targetUserId: "user-1"
  });
  const accepted = await manager.ingestFrameByToken({
    token: created.token,
    mimeType: "image/jpeg",
    dataBase64: "dGVzdA==",
    source: "test_frame"
  });
  assert.equal(accepted.accepted, true);
  assert.equal(ingestCalls.length, 2);
  assert.equal(watchCalls.some((call) => call.source === "screen_share_frame_rearm"), true);

  const unknownHarness = createHarness({
    ingestVoiceStreamFrame: async () => null
  });
  const createdUnknown = await unknownHarness.manager.createSession({
    guildId: "guild-1",
    channelId: "channel-1",
    requesterUserId: "user-1"
  });
  const unknown = await unknownHarness.manager.ingestFrameByToken({
    token: createdUnknown.token
  });
  assert.equal(unknown.accepted, false);
  assert.equal(unknown.reason, "unknown");
});

test("validateSessionVoicePresence and stopSessionByToken handle missing dependencies", async () => {
  const managerWithoutVoice = new ScreenShareSessionManager({
    appConfig: {},
    store: {
      getSettings() {
        return {};
      },
      logAction() {}
    },
    bot: {},
    publicHttpsEntrypoint: {
      getState() {
        return {
          publicUrl: "https://fancy-cat.trycloudflare.com"
        };
      }
    }
  });
  const missingVoice = managerWithoutVoice.validateSessionVoicePresence({
    guildId: "guild-1",
    requesterUserId: "user-1"
  });
  assert.equal(missingVoice.ok, false);
  assert.equal(missingVoice.reason, "voice_session_not_found");

  const endingVoice = createHarness({
    getVoiceSession: () => ({
      guildId: "guild-1",
      ending: true
    }),
    isUserInSessionVoiceChannel: null
  });
  const ended = endingVoice.manager.validateSessionVoicePresence({
    guildId: "guild-1",
    requesterUserId: "user-1"
  });
  assert.equal(ended.ok, false);
  assert.equal(ended.reason, "voice_session_not_found");

  assert.equal(await endingVoice.manager.stopSessionByToken({ token: "missing" }), false);
});

test("stopSessionByToken stops the underlying voice watch session when available", async () => {
  const stopCalls = [];
  const { manager } = createHarness({
    stopWatchStreamForUser: async (payload) => {
      stopCalls.push(payload);
      return {
        ok: true,
        reason: "watching_stopped"
      };
    }
  });
  const created = await manager.createSession({
    guildId: "guild-1",
    channelId: "channel-1",
    requesterUserId: "user-1",
    targetUserId: "user-1"
  });

  const stopped = await manager.stopSessionByToken({
    token: created.token,
    reason: "manual_stop"
  });

  assert.equal(stopped, true);
  assert.equal(stopCalls.length, 1);
  assert.equal(stopCalls[0]?.guildId, "guild-1");
  assert.equal(stopCalls[0]?.requesterUserId, "user-1");
  assert.equal(stopCalls[0]?.targetUserId, "user-1");
});

test("renderSharePage returns branded invalid and valid pages", async () => {
  const { manager } = createHarness();
  const invalid = manager.renderSharePage("missing-token");
  assert.equal(invalid.statusCode, 404);
  assert.equal(invalid.html.includes("Screen share link unavailable."), true);
  assert.equal(invalid.html.includes("invalid or expired"), true);

  const created = await manager.createSession({
    guildId: "guild-1",
    channelId: "channel-1",
    requesterUserId: "user-1",
    targetUserId: "user-1"
  });
  const valid = manager.renderSharePage(created.token);
  assert.equal(valid.statusCode, 200);
  assert.equal(valid.html.includes("<title>clanker conk - screen share</title>"), true);
  assert.equal(
    valid.html.includes(`/api/voice/share-session/${encodeURIComponent(created.token)}/frame`),
    true
  );
  assert.equal(
    valid.html.includes(`/api/voice/share-session/${encodeURIComponent(created.token)}/stop`),
    true
  );
  assert.equal(valid.html.includes("const FRAME_INTERVAL_MS=1200;"), true);
  assert.equal(valid.html.includes("const MAX_WIDTH=960;"), true);
  assert.equal(valid.html.includes("const JPEG_QUALITY=0.6;"), true);
  assert.equal(valid.html.includes("TERMINAL_REASONS"), true);
});

test("renderSharePage clamps capture interval and image encoding settings", async () => {
  const { manager } = createHarness({
    settings: {
      voice: {
        streamWatch: {
          enabled: true,
          keyframeIntervalMs: 150,
          sharePageMaxWidthPx: 4_000,
          sharePageJpegQuality: 0.99
        }
      }
    }
  });
  const created = await manager.createSession({
    guildId: "guild-1",
    channelId: "channel-1",
    requesterUserId: "user-1",
    targetUserId: "user-1"
  });
  const valid = manager.renderSharePage(created.token);
  assert.equal(valid.statusCode, 200);
  assert.equal(valid.html.includes("const FRAME_INTERVAL_MS=500;"), true);
  assert.equal(valid.html.includes("const MAX_WIDTH=1920;"), true);
  assert.equal(valid.html.includes("const JPEG_QUALITY=0.75;"), true);
});
