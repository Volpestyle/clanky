import { test } from "bun:test";
import assert from "node:assert/strict";
import { dequeueReplyBurst } from "./queueGateway.ts";
import { createTestSettings } from "../testSettings.ts";

function createJob(messageId, createdTimestamp, authorId = "user-1") {
  return {
    message: {
      id: messageId,
      channelId: "channel-1",
      createdTimestamp,
      author: {
        id: authorId
      }
    }
  };
}

function createBotWithQueue(jobs = []) {
  return {
    replyQueues: new Map([["channel-1", [...jobs]]]),
    replyQueuedMessageIds: new Set(jobs.map((job) => String(job?.message?.id || "")))
  };
}

test("dequeueReplyBurst coalesces rolling bursts across authors within window", () => {
  const baseTs = Date.now();
  const bot = createBotWithQueue([
    createJob("m1", baseTs, "u1"),
    createJob("m2", baseTs + 3_500, "u2"),
    createJob("m3", baseTs + 7_000, "u3")
  ]);
  const settings = createTestSettings({
    activity: {
      replyCoalesceWindowSeconds: 4,
      replyCoalesceMaxMessages: 6
    }
  });

  const burst = dequeueReplyBurst(bot, "channel-1", settings);

  assert.deepEqual(
    burst.map((job) => job.message.id),
    ["m1", "m2", "m3"]
  );
  assert.equal(bot.replyQueues.has("channel-1"), false);
  assert.deepEqual([...bot.replyQueuedMessageIds], []);
});

test("dequeueReplyBurst respects coalesce max messages", () => {
  const baseTs = Date.now();
  const bot = createBotWithQueue([
    createJob("m1", baseTs),
    createJob("m2", baseTs + 1_000),
    createJob("m3", baseTs + 2_000),
    createJob("m4", baseTs + 3_000)
  ]);
  const settings = createTestSettings({
    activity: {
      replyCoalesceWindowSeconds: 4,
      replyCoalesceMaxMessages: 2
    }
  });

  const burst = dequeueReplyBurst(bot, "channel-1", settings);

  assert.deepEqual(
    burst.map((job) => job.message.id),
    ["m1", "m2"]
  );
  assert.deepEqual(
    (bot.replyQueues.get("channel-1") || []).map((job) => job.message.id),
    ["m3", "m4"]
  );
});
