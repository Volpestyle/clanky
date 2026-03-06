import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appConfig } from "../config.ts";
import { LLMService } from "../llm.ts";
import { MemoryManager } from "../memory.ts";
import { Store } from "../store.ts";
import { createTestSettings } from "../testSettings.ts";
import type { BotContext } from "./botContext.ts";
import {
  buildMediaMemoryFacts,
  getScopedFallbackFacts,
  loadPromptMemorySlice,
  loadRelevantMemoryFacts
} from "./memorySlice.ts";

async function withTempMemoryContext(
  run: (ctx: BotContext & { store: Store; memory: MemoryManager }) => Promise<void>
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clanker-bot-memory-slice-test-"));
  const dbPath = path.join(dir, "clanker.db");
  const store = new Store(dbPath);
  store.init();

  const llm = new LLMService({ appConfig, store });
  const memory = new MemoryManager({
    store,
    llm,
    memoryFilePath: path.join(dir, "memory.md")
  });
  const ctx: BotContext & { store: Store; memory: MemoryManager } = {
    appConfig,
    store,
    llm,
    memory,
    client: {
      user: {
        id: "bot-1"
      },
      guilds: {
        cache: new Map()
      }
    },
    botUserId: "bot-1"
  };

  try {
    await run(ctx);
  } finally {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function getLastLoggedAction(store: Store) {
  return store.db
    .prepare(
      `SELECT kind, content, metadata
       FROM actions
       ORDER BY id DESC
       LIMIT 1`
    )
    .get() as {
    kind: string;
    content: string;
    metadata: string | null;
  };
}

test("buildMediaMemoryFacts merges facts, dedupes them, and clamps max items", () => {
  const facts = buildMediaMemoryFacts({
    userFacts: [
      { fact: "likes tea" },
      { fact: "likes tea" },
      "keeps receipts"
    ],
    relevantFacts: [
      { fact: "prefers synthwave" },
      { fact: "answers in lowercase" }
    ],
    maxItems: 3
  });

  assert.deepEqual(facts, ["likes tea", "keeps receipts", "prefers synthwave"]);
});

test("getScopedFallbackFacts prioritizes same-channel facts before wider guild facts", async () => {
  await withTempMemoryContext(async (ctx) => {
    ctx.store.addMemoryFact({
      guildId: "guild-1",
      channelId: "chan-2",
      subject: "topic-other",
      fact: "other channel fact"
    });
    ctx.store.addMemoryFact({
      guildId: "guild-1",
      subject: "topic-global",
      fact: "guild wide fact"
    });
    ctx.store.addMemoryFact({
      guildId: "guild-1",
      channelId: "chan-1",
      subject: "topic-same",
      fact: "same channel fact"
    });

    const rows = getScopedFallbackFacts(ctx, {
      guildId: "guild-1",
      channelId: "chan-1",
      limit: 3
    });

    assert.deepEqual(
      rows.map((row) => row.fact),
      ["same channel fact", "guild wide fact", "other channel fact"]
    );
  });
});

test("loadPromptMemorySlice normalizes partial memory slices from memory manager", async () => {
  await withTempMemoryContext(async (ctx) => {
    const settings = createTestSettings({
      memory: {
        enabled: true
      }
    });
    let capturedSource = "";
    let capturedQuery = "";

    ctx.memory.buildPromptMemorySlice = async (payload) => {
      capturedSource = String(payload.trace?.source || "");
      capturedQuery = String(payload.queryText || "");
      return {
        userFacts: [{ fact: "likes tea" }],
        relevantMessages: [{ content: "hello there" }]
      };
    };

    const slice = await loadPromptMemorySlice(ctx, {
      settings,
      userId: "user-1",
      guildId: "guild-1",
      channelId: "chan-1",
      queryText: "  hello there  ",
      source: "reply_memory_slice"
    });

    assert.equal(capturedSource, "reply_memory_slice");
    assert.equal(capturedQuery, "hello there");
    assert.deepEqual(slice.userFacts, [{ fact: "likes tea" }]);
    assert.deepEqual(slice.relevantFacts, []);
    assert.deepEqual(slice.relevantMessages, [{ content: "hello there" }]);
  });
});

test("loadPromptMemorySlice logs and returns empty slice when memory manager throws", async () => {
  await withTempMemoryContext(async (ctx) => {
    const settings = createTestSettings({
      memory: {
        enabled: true
      }
    });

    ctx.memory.buildPromptMemorySlice = async () => {
      throw new Error("prompt slice failed");
    };

    const slice = await loadPromptMemorySlice(ctx, {
      settings,
      userId: "user-1",
      guildId: "guild-1",
      channelId: "chan-1",
      queryText: "hi",
      source: "reply_memory_slice"
    });

    assert.deepEqual(slice, {
      userFacts: [],
      relevantFacts: [],
      relevantMessages: []
    });

    const action = getLastLoggedAction(ctx.store);
    assert.equal(action.kind, "bot_error");
    assert.equal(action.content, "reply_memory_slice: prompt slice failed");
  });
});

test("loadRelevantMemoryFacts returns durable matches when memory search succeeds", async () => {
  await withTempMemoryContext(async (ctx) => {
    const settings = createTestSettings({
      memory: {
        enabled: true
      }
    });
    let capturedQuery = "";
    let capturedSource = "";

    ctx.memory.searchDurableFacts = async (payload) => {
      capturedQuery = String(payload.queryText || "");
      capturedSource = String(payload.trace?.source || "");
      return [{ fact: "prefers tea", channel_id: "chan-1" }];
    };

    const facts = await loadRelevantMemoryFacts(ctx, {
      settings,
      guildId: "guild-1",
      channelId: "chan-1",
      queryText: "  what does this person prefer  "
    });

    assert.deepEqual(facts, [{ fact: "prefers tea", channel_id: "chan-1" }]);
    assert.equal(capturedQuery, "what does this person prefer");
    assert.equal(capturedSource, "memory_context");
  });
});

test("loadRelevantMemoryFacts logs and falls back to scoped facts on durable search failure", async () => {
  await withTempMemoryContext(async (ctx) => {
    const settings = createTestSettings({
      memory: {
        enabled: true
      }
    });

    ctx.store.addMemoryFact({
      guildId: "guild-1",
      channelId: "chan-1",
      subject: "topic-same",
      fact: "same channel fallback"
    });
    ctx.store.addMemoryFact({
      guildId: "guild-1",
      subject: "topic-global",
      fact: "guild fallback"
    });

    ctx.memory.searchDurableFacts = async () => {
      throw new Error("vector index offline");
    };

    const facts = await loadRelevantMemoryFacts(ctx, {
      settings,
      guildId: "guild-1",
      channelId: "chan-1",
      queryText: "  tell me the memory context  ",
      trace: {
        source: "voice_operational_message"
      },
      limit: 2
    });

    assert.deepEqual(
      facts.map((row) => row.fact),
      ["same channel fallback", "guild fallback"]
    );

    const action = getLastLoggedAction(ctx.store);
    assert.equal(action.kind, "bot_error");
    assert.equal(action.content, "memory_context: vector index offline");
    assert.deepEqual(JSON.parse(String(action.metadata || "{}")), {
      queryText: "tell me the memory context",
      source: "voice_operational_message"
    });
  });
});
