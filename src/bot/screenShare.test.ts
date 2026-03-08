import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  getVoiceScreenShareCapability,
  offerVoiceScreenShareLink
} from "./screenShare.ts";

function createScreenShareRuntime({
  capability = null,
  createSessionResult = null,
  offerMessage = "bet, open this and start sharing",
  unavailableMessage = "can't share screen links right now"
} = {}) {
  const sentMessages = [];
  const logs = [];
  const createSessionCalls = [];
  const channel = {
    id: "chan-1",
    guildId: "guild-1"
  };

  return {
    sentMessages,
    logs,
    createSessionCalls,
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
                cache: new Map([[
                  "user-1",
                  {
                    displayName: "alice",
                    user: { username: "alice_user" }
                  }
                ]])
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

test("getVoiceScreenShareCapability normalizes status and handles missing manager", () => {
  const missingRuntime = createScreenShareRuntime().runtime;
  const unavailable = getVoiceScreenShareCapability(missingRuntime);
  assert.equal(unavailable.supported, false);
  assert.equal(unavailable.enabled, false);
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.status, "disabled");
  assert.equal(unavailable.reason, "screen_share_manager_unavailable");

  const readyRuntime = createScreenShareRuntime({
    capability: {
      enabled: true,
      status: "READY",
      publicUrl: " https://demo.trycloudflare.com "
    }
  }).runtime;
  const ready = getVoiceScreenShareCapability(readyRuntime);
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
  const warming = getVoiceScreenShareCapability(warmingRuntime);
  assert.equal(warming.supported, true);
  assert.equal(warming.enabled, true);
  assert.equal(warming.available, false);
  assert.equal(warming.status, "starting");
  assert.equal(warming.reason, "starting");
});

test("offerVoiceScreenShareLink sends generated offer to text channel when session is created", async () => {
  const { runtime, sentMessages, createSessionCalls } = createScreenShareRuntime({
    createSessionResult: {
      ok: true,
      shareUrl: "https://screen.example/session/abc",
      expiresInMinutes: 12
    }
  });

  const result = await offerVoiceScreenShareLink(runtime, {
    settings: {},
    guildId: "guild-1",
    channelId: "chan-1",
    requesterUserId: "user-1",
    transcript: "yo look at this",
    source: "voice_turn_directive"
  });

  assert.equal(result.offered, true);
  assert.equal(result.reason, "offered");
  assert.equal(sentMessages.length, 1);
  assert.match(String(sentMessages[0] || ""), /screen\.example\/session\/abc/);
  assert.equal(createSessionCalls.length, 1);
  assert.equal(createSessionCalls[0]?.guildId, "guild-1");
  assert.equal(createSessionCalls[0]?.channelId, "chan-1");
  assert.equal(createSessionCalls[0]?.requesterUserId, "user-1");
  assert.equal(createSessionCalls[0]?.targetUserId, "user-1");
  assert.equal(createSessionCalls[0]?.source, "voice_turn_directive");
});

test("offerVoiceScreenShareLink sends generated unavailable text when session creation fails", async () => {
  const { runtime, sentMessages } = createScreenShareRuntime({
    createSessionResult: {
      ok: false,
      reason: "provider_unavailable"
    }
  });

  const result = await offerVoiceScreenShareLink(runtime, {
    settings: {},
    guildId: "guild-1",
    channelId: "chan-1",
    requesterUserId: "user-1",
    transcript: "screen share broken?",
    source: "voice_turn_directive"
  });

  assert.equal(result.offered, false);
  assert.equal(result.reason, "provider_unavailable");
  assert.equal(sentMessages.length, 1);
  assert.match(String(sentMessages[0] || ""), /can't share screen links right now/i);
});
