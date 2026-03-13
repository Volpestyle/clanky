import { test } from "bun:test";
import assert from "node:assert/strict";
import { sendOperationalMessage } from "./voiceOperationalMessaging.ts";

function createManager({ composeOperationalMessage = null } = {}) {
  const sentMessages = [];
  const manager = {
    composeOperationalMessage,
    store: {
      getSettings() {
        return {
          botName: "clanky"
        };
      },
      logAction() {}
    },
    client: {
      user: {
        id: "bot-1"
      },
      channels: {
        fetch: async () => null
      }
    }
  };
  const channel = {
    id: "chan-1",
    async send(content) {
      sentMessages.push(String(content || ""));
      return true;
    }
  };
  return {
    manager,
    channel,
    sentMessages
  };
}

test("optional operational message can skip posting when composer returns [SKIP]", async () => {
  let seenAllowSkip = null;
  const { manager, channel, sentMessages } = createManager({
    composeOperationalMessage: async (payload) => {
      seenAllowSkip = payload.allowSkip;
      return "[SKIP]";
    }
  });

  const handled = await sendOperationalMessage(manager, {
    channel,
    event: "voice_join_request",
    reason: "already_in_channel",
    mustNotify: false
  });

  assert.equal(handled, true);
  assert.equal(seenAllowSkip, true);
  assert.deepEqual(sentMessages, []);
});

test("required operational message suppresses [SKIP] output without sending", async () => {
  let seenAllowSkip = null;
  const { manager, channel, sentMessages } = createManager({
    composeOperationalMessage: async (payload) => {
      seenAllowSkip = payload.allowSkip;
      return "[SKIP]";
    }
  });

  const handled = await sendOperationalMessage(manager, {
    channel,
    event: "voice_join_request",
    reason: "requester_not_in_voice",
    mustNotify: true
  });

  assert.equal(handled, true);
  assert.equal(seenAllowSkip, false);
  assert.deepEqual(sentMessages, []);
});

test("optional operational message sends composed text when present", async () => {
  const { manager, channel, sentMessages } = createManager({
    composeOperationalMessage: async () => "say less, doing it"
  });

  const handled = await sendOperationalMessage(manager, {
    channel,
    event: "voice_stream_watch_request",
    reason: "watching_started",
    mustNotify: false
  });

  assert.equal(handled, true);
  assert.deepEqual(sentMessages, ["say less, doing it"]);
});
