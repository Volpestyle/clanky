import assert from "node:assert/strict";
import { test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MemoryManager } from "./memoryManager.ts";

function createMemoryForIngestTests(storeOverrides = {}) {
  return new MemoryManager({
    store: {
      logAction() {
        return undefined;
      },
      ...storeOverrides
    },
    llm: {},
    memoryFilePath: "memory/MEMORY.md"
  });
}

test("ingestMessage awaits processing and dedupes queued message ids", async () => {
  const memory = createMemoryForIngestTests();
  memory.ingestWorkerActive = true;
  let processed = 0;
  memory.processIngestMessage = async () => {
    processed += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
  };

  const payload = {
    messageId: "ingest-1",
    authorId: "user-1",
    authorName: "user-1",
    content: "hello",
    settings: {},
    trace: { guildId: "guild-1" }
  };

  const first = memory.ingestMessage(payload);
  const second = memory.ingestMessage(payload);
  memory.ingestWorkerActive = false;
  await memory.runIngestWorker();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult, true);
  assert.equal(secondResult, true);
  assert.equal(processed, 1);
});

test("queue overflow resolves dropped job as false", async () => {
  const memory = createMemoryForIngestTests();
  memory.maxIngestQueue = 1;
  memory.ingestWorkerActive = true;

  let processed = 0;
  memory.processIngestMessage = async () => {
    processed += 1;
    return undefined;
  };

  const first = memory.ingestMessage({
    messageId: "ingest-drop-1",
    authorId: "user-1",
    authorName: "user-1",
    content: "first",
    settings: {},
    trace: { guildId: "guild-1" }
  });
  const second = memory.ingestMessage({
    messageId: "ingest-drop-2",
    authorId: "user-2",
    authorName: "user-2",
    content: "second",
    settings: {},
    trace: { guildId: "guild-1" }
  });

  assert.equal(await first, false);

  memory.ingestWorkerActive = false;
  await memory.runIngestWorker();

  assert.equal(await second, true);
  assert.equal(processed, 1);
});

test("voice transcript ingest writes synthetic message rows for prompt history continuity", async () => {
  const recorded = [];
  const memory = createMemoryForIngestTests({
    recordMessage(row) {
      recorded.push(row);
    }
  });
  memory.ingestWorkerActive = true;
  memory.processIngestMessage = async () => undefined;

  const ingestPromise = memory.ingestMessage({
    messageId: "voice-guild-1-123456",
    authorId: "user-1",
    authorName: "  Alice  ",
    content: "  hey there from vc  ",
    settings: {},
    trace: {
      guildId: "guild-1",
      channelId: "chan-1",
      userId: "user-1",
      source: "voice_realtime_ingest"
    }
  });

  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]?.messageId, "voice-guild-1-123456");
  assert.equal(recorded[0]?.guildId, "guild-1");
  assert.equal(recorded[0]?.channelId, "chan-1");
  assert.equal(recorded[0]?.authorId, "user-1");
  assert.equal(recorded[0]?.authorName, "Alice");
  assert.equal(recorded[0]?.isBot, false);
  assert.equal(recorded[0]?.content, "hey there from vc");

  memory.ingestWorkerActive = false;
  await memory.runIngestWorker();
  assert.equal(await ingestPromise, true);
});

test("voice transcript ingest preserves bot-authored message rows", async () => {
  const recorded = [];
  const memory = createMemoryForIngestTests({
    recordMessage(row) {
      recorded.push(row);
    }
  });
  memory.ingestWorkerActive = true;
  memory.processIngestMessage = async () => undefined;

  const ingestPromise = memory.ingestMessage({
    messageId: "voice-guild-1-bot-123456",
    authorId: "bot-1",
    authorName: "  clanker conk  ",
    content: "  bet say less  ",
    isBot: true,
    settings: {},
    trace: {
      guildId: "guild-1",
      channelId: "chan-1",
      userId: "bot-1",
      source: "voice_assistant_timeline"
    }
  });

  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]?.messageId, "voice-guild-1-bot-123456");
  assert.equal(recorded[0]?.authorId, "bot-1");
  assert.equal(recorded[0]?.authorName, "clanker conk");
  assert.equal(recorded[0]?.isBot, true);
  assert.equal(recorded[0]?.content, "bet say less");

  memory.ingestWorkerActive = false;
  await memory.runIngestWorker();
  assert.equal(await ingestPromise, true);
});

test("appendDailyLogEntry dedupes repeated message ids", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clanker-memory-log-"));
  try {
    const memory = new MemoryManager({
      store: {
        logAction() {
          return undefined;
        }
      },
      llm: {},
      memoryFilePath: path.join(tempDir, "MEMORY.md")
    });

    await memory.appendDailyLogEntry({
      messageId: "voice-guild-1-dup-1",
      authorId: "user-1",
      authorName: "Alice",
      guildId: "guild-1",
      channelId: "chan-1",
      content: "hello from vc"
    });
    await memory.appendDailyLogEntry({
      messageId: "voice-guild-1-dup-1",
      authorId: "user-1",
      authorName: "Alice",
      guildId: "guild-1",
      channelId: "chan-1",
      content: "hello from vc"
    });

    const date = new Date();
    const dateKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    const dailyFilePath = path.join(tempDir, `${dateKey}.md`);
    const text = await fs.readFile(dailyFilePath, "utf8");
    const matches = text.match(/message:voice-guild-1-dup-1/gu) || [];
    assert.equal(matches.length, 1);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("processIngestMessage writes daily log without auto-extracting facts", async () => {
  let dailyLogCalled = false;
  let refreshCalled = false;
  const memory = new MemoryManager({
    store: {
      logAction() {
        return undefined;
      }
    },
    llm: {
      async extractMemoryFacts() {
        throw new Error("extractMemoryFacts should not be called");
      }
    },
    memoryFilePath: "memory/MEMORY.md"
  });
  memory.appendDailyLogEntry = async () => {
    dailyLogCalled = true;
  };
  memory.queueMemoryRefresh = () => {
    refreshCalled = true;
  };

  await memory.processIngestMessage({
    messageId: "msg-1",
    authorId: "user-1",
    authorName: "alex",
    content: "I am Alex and I love pizza.",
    trace: {
      guildId: "guild-1",
      channelId: "chan-1",
      userId: "user-1"
    }
  });

  assert.equal(dailyLogCalled, true);
  assert.equal(refreshCalled, true);
});
