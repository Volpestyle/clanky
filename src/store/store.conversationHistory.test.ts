import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { Store } from "./store.ts";

async function withTempStore(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clanker-store-conversation-test-"));
  const dbPath = path.join(dir, "clanker.db");
  const store = new Store(dbPath);
  store.init();

  try {
    await run(store);
  } finally {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function recordMessage(store, {
  messageId,
  createdAt,
  guildId = "guild-1",
  channelId = "chan-1",
  authorId,
  authorName,
  isBot = false,
  content
}) {
  store.recordMessage({
    messageId,
    createdAt,
    guildId,
    channelId,
    authorId,
    authorName,
    isBot,
    content
  });
}

test("searchConversationWindows returns a matched conversation window with surrounding turns", async () => {
  await withTempStore(async (store) => {
    const baseTime = Date.now() - 10 * 60 * 1000;
    recordMessage(store, {
      messageId: "m1",
      createdAt: baseTime,
      authorId: "user-1",
      authorName: "alice",
      content: "can you check nvidia stock price today"
    });
    recordMessage(store, {
      messageId: "m2",
      createdAt: baseTime + 1000,
      authorId: "bot-1",
      authorName: "clanker conk",
      isBot: true,
      content: "NVDA was around 181 earlier."
    });
    recordMessage(store, {
      messageId: "m3",
      createdAt: baseTime + 2000,
      authorId: "user-1",
      authorName: "alice",
      content: "what do you think about that nvidia stock price"
    });

    const windows = store.searchConversationWindows({
      guildId: "guild-1",
      channelId: "chan-1",
      queryText: "that nvidia stock price",
      limit: 2,
      maxAgeHours: 24,
      before: 1,
      after: 1
    });

    assert.equal(windows.length, 1);
    assert.equal((windows[0]?.messages?.length || 0) >= 2, true);
    assert.equal(
      windows[0]?.messages?.some((row) => row?.content === "NVDA was around 181 earlier."),
      true
    );
  });
});

test("searchConversationWindows prefers same-channel history when scores are otherwise similar", async () => {
  await withTempStore(async (store) => {
    const baseTime = Date.now() - 30 * 60 * 1000;
    recordMessage(store, {
      messageId: "same-channel",
      createdAt: baseTime,
      channelId: "chan-1",
      authorId: "user-1",
      authorName: "alice",
      content: "nvidia stock price was 181"
    });
    recordMessage(store, {
      messageId: "other-channel",
      createdAt: baseTime + 1000,
      channelId: "chan-2",
      authorId: "user-2",
      authorName: "bob",
      content: "nvidia stock price was 181"
    });

    const windows = store.searchConversationWindows({
      guildId: "guild-1",
      channelId: "chan-1",
      queryText: "nvidia stock price",
      limit: 2,
      maxAgeHours: 24,
      before: 0,
      after: 0
    });

    assert.equal(windows.length >= 1, true);
    assert.equal(windows[0]?.channelId, "chan-1");
  });
});
