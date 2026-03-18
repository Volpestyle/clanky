import assert from "node:assert/strict";
import { test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MemoryManager } from "./memoryManager.ts";
import { Store } from "../store/store.ts";

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
    authorName: "  clanky  ",
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
  assert.equal(recorded[0]?.authorName, "clanky");
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

test("processIngestMessage skips text micro-reflection scheduling for bot-authored messages", async () => {
  let scheduled = false;
  const memory = createMemoryForIngestTests();
  memory.appendDailyLogEntry = async () => undefined;
  memory.queueMemoryRefresh = () => undefined;
  memory.ensureConversationMessageVector = async () => null;
  memory.scheduleTextChannelMicroReflection = () => {
    scheduled = true;
  };

  await memory.processIngestMessage({
    messageId: "bot-msg-1",
    authorId: "bot-1",
    authorName: "clanky",
    content: "I already answered that.",
    isBot: true,
    trace: {
      guildId: "guild-1",
      channelId: "chan-1",
      userId: "bot-1"
    }
  });

  assert.equal(scheduled, false);
});

test("text micro-reflection can trigger on context pressure before silence", async () => {
  const logActions: Array<Record<string, unknown>> = [];
  const memory = createMemoryForIngestTests({
    getMessagesInWindow() {
      const now = new Date().toISOString();
      return Array.from({ length: 18 }, (_, index) => ({
        message_id: `msg-${index + 1}`,
        is_bot: false,
        created_at: now,
        author_name: `user-${index + 1}`,
        author_id: `user-${index + 1}`,
        content: `message ${index + 1}`
      }));
    },
    logAction(payload) {
      logActions.push(payload as Record<string, unknown>);
    }
  });

  const runs: Array<Record<string, unknown>> = [];
  memory.runTextChannelMicroReflection = async (_key, payload) => {
    runs.push(payload as Record<string, unknown>);
    return { ok: true, reason: "completed" };
  };

  memory.scheduleTextChannelMicroReflection({
    messageId: "msg-99",
    guildId: "guild-1",
    channelId: "chan-1",
    settings: {
      memory: {
        enabled: true,
        promptSlice: {
          maxRecentMessages: 20
        },
        reflection: {
          enabled: true
        }
      }
    }
  });

  await Promise.resolve();

  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.trigger, "text_context_pressure");
  assert.equal(typeof runs[0]?.untilMs, "number");
  assert.equal(
    logActions.some((entry) => entry.content === "memory_micro_reflection_context_pressure"),
    true
  );

  const timer = memory.textMicroReflectionTimers.get("guild-1:chan-1");
  if (timer) {
    clearTimeout(timer);
    memory.textMicroReflectionTimers.delete("guild-1:chan-1");
  }
});

test("context-pressure reflection skips while a text micro-reflection is already running", async () => {
  const memory = createMemoryForIngestTests({
    getMessagesInWindow() {
      const now = new Date().toISOString();
      return Array.from({ length: 18 }, (_, index) => ({
        message_id: `msg-${index + 1}`,
        is_bot: false,
        created_at: now,
        author_name: `user-${index + 1}`,
        author_id: `user-${index + 1}`,
        content: `message ${index + 1}`
      }));
    }
  });
  const runs: Array<Record<string, unknown>> = [];
  memory.runTextChannelMicroReflection = async (_key, payload) => {
    runs.push(payload as Record<string, unknown>);
    return { ok: true, reason: "completed" };
  };
  memory.microReflectionInFlight.add("text:guild-1:chan-1");

  memory.scheduleTextChannelMicroReflection({
    messageId: "msg-100",
    guildId: "guild-1",
    channelId: "chan-1",
    settings: {
      memory: {
        enabled: true,
        promptSlice: {
          maxRecentMessages: 20
        },
        reflection: {
          enabled: true
        }
      }
    }
  });

  await Promise.resolve();

  assert.equal(runs.length, 0);
  memory.microReflectionInFlight.delete("text:guild-1:chan-1");
  const timer = memory.textMicroReflectionTimers.get("guild-1:chan-1");
  if (timer) {
    clearTimeout(timer);
    memory.textMicroReflectionTimers.delete("guild-1:chan-1");
  }
});

test("context-pressure reflection preserves newer state updates after async completion", async () => {
  let releaseModel = () => undefined;
  const modelGate = new Promise<void>((resolve) => {
    releaseModel = () => resolve();
  });

  const memory = new MemoryManager({
    store: {
      getFactProfileRows() {
        return [];
      },
      getMessagesInWindow() {
        const now = Date.now();
        return [
          {
            message_id: "msg-1",
            created_at: new Date(now - 10_000).toISOString(),
            author_name: "Alice",
            author_id: "user-1",
            is_bot: false,
            content: "I like Rust and systems programming for backend infrastructure and performance work"
          },
          {
            message_id: "msg-2",
            created_at: new Date(now - 5_000).toISOString(),
            author_name: "Alice",
            author_id: "user-1",
            is_bot: false,
            content: "Also, I prefer concise replies when we troubleshoot deployment and production incidents"
          }
        ];
      },
      logAction() {
        return undefined;
      }
    },
    llm: {
      async callChatModel() {
        await modelGate;
        return { text: '{"facts":[]}' };
      }
    },
    memoryFilePath: "memory/MEMORY.md"
  });
  memory.rememberDirectiveLineDetailed = async () => ({ ok: true });

  const key = "guild-1:chan-1";
  const firstMessageAtMs = Date.now() - 1_000;
  const newerMessageAtMs = Date.now();
  const settings = {
    memory: {
      enabled: true,
      reflection: {
        enabled: true
      }
    }
  };

  memory.textMicroReflectionState.set(key, {
    guildId: "guild-1",
    channelId: "chan-1",
    lastMessageAtMs: firstMessageAtMs,
    lastMessageId: "msg-1",
    settings
  });

  const reflectionPromise = memory.runTextChannelMicroReflection(key, {
    trigger: "text_context_pressure",
    untilMs: firstMessageAtMs
  });

  memory.textMicroReflectionState.set(key, {
    guildId: "guild-1",
    channelId: "chan-1",
    lastMessageAtMs: newerMessageAtMs,
    lastMessageId: "msg-2",
    settings
  });

  releaseModel();
  const result = await reflectionPromise;
  assert.equal(result.ok, true);
  const finalState = memory.textMicroReflectionState.get(key) as Record<string, unknown>;
  assert.equal(Number(finalState.lastMessageAtMs || 0), newerMessageAtMs);
  assert.equal(Number(finalState.processedThroughMs || 0), firstMessageAtMs);
});

test("archival eviction prefers removing old unreinforced facts over recent ones", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clanker-memory-eviction-"));
  const store = new Store(path.join(tempDir, "clanker.db"));
  store.init();

  try {
    // Insert an old high-confidence fact and a newer lower-confidence fact.
    const sixMonthsAgo = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString();
    const now = new Date().toISOString();

    store.db.prepare(
      `INSERT INTO memory_facts(created_at, updated_at, guild_id, subject, fact, fact_type, confidence, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
    ).run(sixMonthsAgo, sixMonthsAgo, "guild-1", "user-1", "Old fact about user.", "preference", 0.95);

    store.db.prepare(
      `INSERT INTO memory_facts(created_at, updated_at, guild_id, subject, fact, fact_type, confidence, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
    ).run(now, now, "guild-1", "user-1", "Recent fact about user.", "preference", 0.72);

    // Request keeping only 1 fact — with decay, the old 0.95 should be evicted
    // because its decayed confidence is well below the recent 0.72.
    const archived = store.archiveOldFactsForSubject({
      guildId: "guild-1",
      subject: "user-1",
      keep: 1
    });

    assert.equal(archived, 1);

    const remaining = store.getFactsForScope({ guildId: "guild-1", limit: 10 });
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]?.fact, "Recent fact about user.");
  } finally {
    store.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("archival eviction keeps guidance facts despite age (evergreen)", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clanker-memory-eviction-guidance-"));
  const store = new Store(path.join(tempDir, "clanker.db"));
  store.init();

  try {
    const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
    const now = new Date().toISOString();

    store.db.prepare(
      `INSERT INTO memory_facts(created_at, updated_at, guild_id, subject, fact, fact_type, confidence, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
    ).run(oneYearAgo, oneYearAgo, "guild-1", "user-1", "Always greet me in Spanish.", "guidance", 0.9);

    store.db.prepare(
      `INSERT INTO memory_facts(created_at, updated_at, guild_id, subject, fact, fact_type, confidence, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
    ).run(now, now, "guild-1", "user-1", "Recent preference fact.", "preference", 0.72);

    const archived = store.archiveOldFactsForSubject({
      guildId: "guild-1",
      subject: "user-1",
      keep: 1
    });

    assert.equal(archived, 1);
    const remaining = store.getFactsForScope({ guildId: "guild-1", limit: 10 });
    assert.equal(remaining.length, 1);
    // Guidance fact is evergreen — it should survive despite being a year old.
    assert.equal(remaining[0]?.fact, "Always greet me in Spanish.");
  } finally {
    store.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("purgeGuildMemory removes only the selected guild's stored memory artifacts", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clanker-memory-purge-"));
  const store = new Store(path.join(tempDir, "clanker.db"));
  store.init();

  try {
    const memory = new MemoryManager({
      store,
      llm: {},
      memoryFilePath: path.join(tempDir, "MEMORY.md")
    });

    store.addMemoryFact({
      guildId: "guild-1",
      channelId: "chan-1",
      subject: "user-1",
      fact: "Guild one likes handhelds.",
      factType: "preference",
      sourceMessageId: "msg-g1",
      confidence: 0.7
    });
    store.addMemoryFact({
      guildId: "guild-2",
      channelId: "chan-2",
      subject: "user-2",
      fact: "Guild two likes keyboards.",
      factType: "preference",
      sourceMessageId: "msg-g2",
      confidence: 0.8
    });

    const guildOneFact = store.getMemoryFactBySubjectAndFact("guild-1", "user-1", "Guild one likes handhelds.");
    const guildTwoFact = store.getMemoryFactBySubjectAndFact("guild-2", "user-2", "Guild two likes keyboards.");
    assert.ok(guildOneFact);
    assert.ok(guildTwoFact);

    store.upsertMemoryFactVectorNative({
      factId: Number(guildOneFact?.id),
      model: "text-embedding-3-small",
      embedding: [0.1, 0.2, 0.3]
    });
    store.upsertMemoryFactVectorNative({
      factId: Number(guildTwoFact?.id),
      model: "text-embedding-3-small",
      embedding: [0.4, 0.5, 0.6]
    });

    store.recordMessage({
      messageId: "msg-g1",
      guildId: "guild-1",
      channelId: "chan-1",
      authorId: "user-1",
      authorName: "Alice",
      isBot: false,
      content: "guild one remembers this"
    });
    store.recordMessage({
      messageId: "msg-g2",
      guildId: "guild-2",
      channelId: "chan-2",
      authorId: "user-2",
      authorName: "Bob",
      isBot: false,
      content: "guild two remembers this"
    });
    store.upsertMessageVectorNative({
      messageId: "msg-g1",
      model: "text-embedding-3-small",
      embedding: [0.1, 0.2, 0.3]
    });
    store.upsertMessageVectorNative({
      messageId: "msg-g2",
      model: "text-embedding-3-small",
      embedding: [0.4, 0.5, 0.6]
    });

    store.logAction({
      kind: "memory_reflection_start",
      guildId: "guild-1",
      content: "guild-1 reflection start",
      metadata: {
        runId: "run-g1",
        dateKey: "2026-03-10",
        guildId: "guild-1"
      }
    });
    store.logAction({
      kind: "memory_reflection_complete",
      guildId: "guild-1",
      content: "guild-1 reflection complete",
      metadata: {
        runId: "run-g1",
        dateKey: "2026-03-10",
        guildId: "guild-1"
      }
    });
    store.logAction({
      kind: "memory_reflection_start",
      guildId: "guild-2",
      content: "guild-2 reflection start",
      metadata: {
        runId: "run-g2",
        dateKey: "2026-03-10",
        guildId: "guild-2"
      }
    });
    store.logAction({
      kind: "memory_reflection_complete",
      guildId: "guild-2",
      content: "guild-2 reflection complete",
      metadata: {
        runId: "run-g2",
        dateKey: "2026-03-10",
        guildId: "guild-2"
      }
    });

    await memory.appendDailyLogEntry({
      messageId: "journal-g1",
      authorId: "user-1",
      authorName: "Alice",
      guildId: "guild-1",
      channelId: "chan-1",
      content: "journal entry for guild one"
    });
    await memory.appendDailyLogEntry({
      messageId: "journal-g2",
      authorId: "user-2",
      authorName: "Bob",
      guildId: "guild-2",
      channelId: "chan-2",
      content: "journal entry for guild two"
    });

    const fakeTimer = setTimeout(() => undefined, 60_000);
    memory.textMicroReflectionTimers.set("guild-1:chan-1", fakeTimer);
    memory.textMicroReflectionState.set("guild-1:chan-1", {
      guildId: "guild-1",
      channelId: "chan-1"
    });

    const result = await memory.purgeGuildMemory({ guildId: "guild-1" });
    clearTimeout(fakeTimer);

    assert.equal(result.ok, true);
    assert.equal(result.durableFactsDeleted, 1);
    assert.equal(result.durableFactVectorsDeleted, 1);
    assert.equal(result.conversationMessagesDeleted, 1);
    assert.equal(result.conversationVectorsDeleted, 1);
    assert.equal(result.reflectionEventsDeleted, 2);
    assert.equal(result.journalEntriesDeleted, 1);
    assert.equal(result.journalFilesTouched, 1);
    assert.equal(memory.textMicroReflectionTimers.has("guild-1:chan-1"), false);
    assert.equal(memory.textMicroReflectionState.has("guild-1:chan-1"), false);

    assert.equal(store.getFactsForScope({ guildId: "guild-1", limit: 10 }).length, 0);
    assert.equal(store.getFactsForScope({ guildId: "guild-2", limit: 10 }).length, 1);
    assert.equal(store.getMessagesInWindow({ guildId: "guild-1", limit: 10 }).length, 0);
    assert.equal(store.getMessagesInWindow({ guildId: "guild-2", limit: 10 }).length, 1);
    assert.equal(store.getRecentMemoryReflections(10, { guildId: "guild-1" }).length, 0);
    assert.equal(store.getRecentMemoryReflections(10, { guildId: "guild-2" }).length, 1);

    const factVectorCount = Number(
      store.db
        .prepare<{ count: number }, []>("SELECT COUNT(*) AS count FROM memory_fact_vectors_native")
        .get()?.count || 0
    );
    const messageVectorCount = Number(
      store.db
        .prepare<{ count: number }, []>("SELECT COUNT(*) AS count FROM message_vectors_native")
        .get()?.count || 0
    );
    assert.equal(factVectorCount, 1);
    assert.equal(messageVectorCount, 1);

    const date = new Date();
    const dateKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    const dailyFileText = await fs.readFile(path.join(tempDir, `${dateKey}.md`), "utf8");
    assert.equal(dailyFileText.includes("guild:guild-1"), false);
    assert.equal(dailyFileText.includes("journal entry for guild two"), true);
  } finally {
    store.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
