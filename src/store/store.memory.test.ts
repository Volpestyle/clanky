import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { getResolvedVoiceAdmissionClassifierBinding } from "../settings/agentStack.ts";
import { Store } from "./store.ts";
import { createTestSettingsPatch } from "../testSettings.ts";

async function withTempStore(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clanker-store-test-"));
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

test("memory facts support user scope across guilds and guild scope partitioning", async () => {
  await withTempStore(async (store) => {
    const userFactPayload = {
      channelId: "channel-1",
      subject: "user-1",
      fact: "User likes pineapple pizza.",
      factType: "preference",
      evidenceText: "likes pineapple pizza",
      sourceMessageId: "msg-1",
      confidence: 0.7
    };

    const insertedUser = store.addMemoryFact({
      ...userFactPayload,
      scope: "user",
      guildId: null,
      userId: "user-1"
    });
    const insertedGuildA = store.addMemoryFact({
      scope: "guild",
      guildId: "guild-a",
      channelId: "channel-1",
      subject: "__lore__",
      fact: "Guild A runs a Friday meme competition.",
      factType: "other",
      sourceMessageId: "msg-guild-a",
      confidence: 0.75
    });
    const insertedGuildB = store.addMemoryFact({
      scope: "guild",
      guildId: "guild-b",
      channelId: "channel-1",
      subject: "__lore__",
      fact: "Guild B runs a Friday meme competition.",
      factType: "other",
      sourceMessageId: "msg-guild-b",
      confidence: 0.75
    });

    assert.equal(insertedUser, true);
    assert.equal(insertedGuildA, true);
    assert.equal(insertedGuildB, true);

    const userFacts = store.getFactsForSubjects(["user-1"], 10, { scope: "user" });
    assert.equal(userFacts.length, 1);
    assert.equal(userFacts[0]?.scope, "user");
    assert.equal(userFacts[0]?.guild_id, null);
    assert.equal(userFacts[0]?.user_id, "user-1");

    const guildAFacts = store.getFactsForSubjects(["__lore__"], 10, { scope: "guild", guildId: "guild-a" });
    const guildBFacts = store.getFactsForSubjects(["__lore__"], 10, { scope: "guild", guildId: "guild-b" });
    assert.equal(guildAFacts.length, 1);
    assert.equal(guildBFacts.length, 1);
    assert.equal(guildAFacts[0].guild_id, "guild-a");
    assert.equal(guildBFacts[0].guild_id, "guild-b");
  });
});

test("memory facts support owner scope", async () => {
  await withTempStore(async (store) => {
    const inserted = store.addMemoryFact({
      scope: "owner",
      guildId: null,
      userId: "owner-1",
      channelId: "dm-owner",
      subject: "__owner__",
      fact: "Remember to renew passport in May.",
      factType: "project",
      sourceMessageId: "owner-msg-1",
      confidence: 0.9
    });

    assert.equal(inserted, true);
    const rows = store.getFactsForScope({ scope: "owner", subjectIds: ["__owner__"], limit: 10 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.scope, "owner");
    assert.equal(rows[0]?.user_id, "owner-1");
    assert.equal(rows[0]?.subject, "__owner__");
  });
});

test("session summaries persist, filter by channel, and order by most recent end time", async () => {
  await withTempStore(async (store) => {
    const insertedA = store.upsertSessionSummary({
      sessionId: "voice-session-a",
      guildId: "guild-a",
      channelId: "chan-1",
      summaryText: "Alice and Bob planned the build.",
      endedAt: "2026-03-22T12:00:00.000Z"
    });
    const insertedB = store.upsertSessionSummary({
      sessionId: "voice-session-b",
      guildId: "guild-a",
      channelId: "chan-1",
      summaryText: "They narrowed the rollout to Friday.",
      endedAt: "2026-03-22T12:10:00.000Z"
    });
    store.upsertSessionSummary({
      sessionId: "voice-session-c",
      guildId: "guild-a",
      channelId: "chan-2",
      summaryText: "Other channel summary.",
      endedAt: "2026-03-22T12:05:00.000Z"
    });

    assert.equal(insertedA, true);
    assert.equal(insertedB, true);

    const rows = store.getRecentSessionSummaries({
      guildId: "guild-a",
      channelId: "chan-1",
      sinceIso: "2026-03-22T11:30:00.000Z",
      beforeIso: "2026-03-22T12:30:00.000Z",
      limit: 5
    });
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.session_id, "voice-session-b");
    assert.equal(rows[1]?.session_id, "voice-session-a");
  });
});

test("memory facts canonicalize legacy fact wrappers and legacy fact types on write", async () => {
  await withTempStore(async (store) => {
    const inserted = store.addMemoryFact({
      scope: "guild",
      guildId: "guild-a",
      channelId: "chan-1",
      subject: "__lore__",
      fact: "Memory line: Friday game night gets loud.",
      factType: "lore",
      sourceMessageId: "msg-legacy",
      confidence: 0.7
    });

    assert.equal(inserted, true);
    const [row] = store.getFactsForScope({ guildId: "guild-a", limit: 10, subjectIds: ["__lore__"] });
    assert.equal(row?.fact, "Friday game night gets loud.");
    assert.equal(row?.fact_type, "other");
  });
});

test("archiveOldFactsForSubject evicts contextual facts before core facts", async () => {
  await withTempStore(async (store) => {
    const addFact = (subject: string, fact: string, factType: string, sourceMessageId: string) => {
      store.addMemoryFact({
        guildId: "guild-a",
        channelId: "chan-1",
        subject,
        fact,
        factType,
        sourceMessageId,
        confidence: 0.6
      });
    };

    for (let i = 1; i <= 19; i += 1) {
      addFact("user-context-first", `Core ${i}.`, i % 2 === 0 ? "relationship" : "profile", `core-a-${i}`);
    }
    addFact("user-context-first", "Context 1.", "preference", "ctx-a-1");
    addFact("user-context-first", "Context 2.", "preference", "ctx-a-2");
    addFact("user-context-first", "Context 3.", "preference", "ctx-a-3");

    const archivedContextual = store.archiveOldFactsForSubject({
      guildId: "guild-a",
      subject: "user-context-first",
      keep: 20
    });
    assert.equal(archivedContextual, 2);
    const contextFirstFacts = store.getFactsForSubjects(["user-context-first"], 30, { guildId: "guild-a" });
    assert.equal(contextFirstFacts.filter((row) => row.fact_type === "profile" || row.fact_type === "relationship").length, 19);
    assert.equal(contextFirstFacts.filter((row) => row.fact_type === "preference").length, 1);

    // Create enough core facts to exceed the core cap (35) plus some contextual,
    // so the eviction path must archive contextual first, then overflow into core.
    for (let i = 1; i <= 38; i += 1) {
      addFact("user-core-cap", `Core cap ${i}.`, i % 2 === 0 ? "relationship" : "profile", `core-b-${i}`);
    }
    addFact("user-core-cap", "Context survivor.", "preference", "ctx-b-1");

    const archivedMixed = store.archiveOldFactsForSubject({
      guildId: "guild-a",
      subject: "user-core-cap",
      keep: 36
    });
    // 39 total, keep 36 → 3 to archive. 1 contextual archived first, then 2 oldest core.
    assert.equal(archivedMixed, 3);
    const coreCapFacts = store.getFactsForSubjects(["user-core-cap"], 50, { guildId: "guild-a" });
    assert.equal(coreCapFacts.filter((row) => row.fact_type === "preference").length, 0);
    assert.equal(coreCapFacts.filter((row) => row.fact_type === "profile" || row.fact_type === "relationship").length, 36);
  });
});

test("memory facts support query filtering and scope filters", async () => {
  await withTempStore(async (store) => {
    store.addMemoryFact({
      guildId: "guild-a",
      channelId: "chan-1",
      subject: "user-1",
      fact: "User likes old school DS hardware.",
      factType: "preference",
      evidenceText: "Mentioned old school DS hardware.",
      sourceMessageId: "msg-1",
      confidence: 0.77
    });
    store.addMemoryFact({
      guildId: "guild-a",
      channelId: "chan-2",
      subject: "user-2",
      fact: "User likes tea.",
      factType: "preference",
      evidenceText: "Mentioned tea.",
      sourceMessageId: "msg-2",
      confidence: 0.61
    });

    const matching = store.getFactsForScope({
      guildId: "guild-a",
      limit: 10,
      queryText: "old school ds"
    });
    assert.equal(matching.length, 1);
    assert.equal(matching[0]?.subject, "user-1");

    const subjectFiltered = store.getFactsForScope({
      guildId: "guild-a",
      limit: 10,
      subjectIds: ["user-2"]
    });
    assert.equal(subjectFiltered.length, 1);
    assert.equal(subjectFiltered[0]?.subject, "user-2");

    const typeFiltered = store.getFactsForScope({
      guildId: "guild-a",
      limit: 10,
      factTypes: ["preference"]
    });
    assert.equal(typeFiltered.length, 2);
  });
});

test("searchMemoryFactsLexical uses BM25/FTS for exact technical tokens", async () => {
  await withTempStore(async (store) => {
    store.addMemoryFact({
      scope: "guild",
      guildId: "guild-a",
      channelId: "chan-1",
      subject: "__lore__",
      fact: "The fix involves ERR_MODULE_NOT_FOUND in vite-node.",
      factType: "other",
      sourceMessageId: "msg-fts-1",
      confidence: 0.7
    });
    store.addMemoryFact({
      scope: "guild",
      guildId: "guild-a",
      channelId: "chan-1",
      subject: "__lore__",
      fact: "People were talking about tea and snacks.",
      factType: "other",
      sourceMessageId: "msg-fts-2",
      confidence: 0.7
    });

    const rows = store.searchMemoryFactsLexical({
      guildId: "guild-a",
      scope: "guild",
      queryText: "ERR_MODULE_NOT_FOUND vite-node",
      queryTokens: ["ERR_MODULE_NOT_FOUND", "vite-node"],
      limit: 5
    });

    assert.equal(rows.length >= 1, true);
    assert.equal(rows[0]?.fact, "The fix involves ERR_MODULE_NOT_FOUND in vite-node.");
    assert.equal(Number(rows[0]?.lexical_score || 0) > 0, true);
  });
});

test("guild-scoped memory views can include portable user facts", async () => {
  await withTempStore(async (store) => {
    store.addMemoryFact({
      scope: "user",
      guildId: null,
      userId: "user-1",
      channelId: "chan-user",
      subject: "user-1",
      fact: "User likes old school DS hardware.",
      factType: "preference",
      sourceMessageId: "msg-user",
      confidence: 0.8
    });
    store.addMemoryFact({
      scope: "guild",
      guildId: "guild-a",
      channelId: "chan-guild",
      subject: "__lore__",
      fact: "Guild A has a recurring game night.",
      factType: "other",
      sourceMessageId: "msg-guild",
      confidence: 0.7
    });

    const subjects = store.getMemorySubjects(20, {
      guildId: "guild-a",
      includePortableUserScope: true
    });
    assert.equal(subjects.some((row) => row.subject === "user-1"), true);
    assert.equal(subjects.some((row) => row.subject === "__lore__"), true);

    const facts = store.getFactsForScope({
      guildId: "guild-a",
      includePortableUserScope: true,
      limit: 20
    });
    assert.equal(facts.some((row) => row.subject === "user-1"), true);
    assert.equal(facts.some((row) => row.subject === "__lore__"), true);
  });
});

test("reflection completion survives pruned action logs via durable checkpoints", async () => {
  await withTempStore(async (store) => {
    store.markReflectionCompleted("2026-03-09", "guild-a", {
      runId: "reflection_2026-03-09_guild-a"
    });

    store.db.prepare("DELETE FROM actions WHERE kind IN ('memory_reflection_start', 'memory_reflection_complete', 'memory_reflection_error')").run();

    assert.equal(store.hasReflectionBeenCompleted("2026-03-09", "guild-a"), true);
  });
});

test("memory facts can be updated and soft-deleted while clearing stale vectors", async () => {
  await withTempStore(async (store) => {
    store.addMemoryFact({
      guildId: "guild-a",
      channelId: "chan-1",
      subject: "user-1",
      fact: "User likes handhelds.",
      factType: "preference",
      evidenceText: "Mentioned handhelds.",
      sourceMessageId: "msg-1",
      confidence: 0.66
    });

    const inserted = store.getMemoryFactBySubjectAndFact({
      scope: "guild",
      guildId: "guild-a",
      subject: "user-1",
      fact: "User likes handhelds."
    });
    assert.ok(inserted);

    const factId = Number(inserted?.id);
    store.upsertMemoryFactVectorNative({
      factId,
      model: "text-embedding-3-small",
      embedding: [0.1, 0.2, 0.3]
    });
    const vector = store.getMemoryFactVectorNative(factId, "text-embedding-3-small");
    assert.ok(vector);
    assert.equal(vector?.length, 3);

    const updated = store.updateMemoryFact({
      scope: "guild",
      guildId: "guild-a",
      factId,
      subject: "user-1",
      fact: "User likes handheld PCs.",
      factType: "project",
      evidenceText: "Updated by operator.",
      confidence: 0.91
    });

    assert.equal(updated.ok, true);
    assert.equal(updated.row?.fact, "User likes handheld PCs.");
    assert.equal(updated.row?.fact_type, "project");
    assert.equal(updated.row?.evidence_text, "Updated by operator.");
    assert.equal(updated.row?.confidence, 0.91);
    assert.equal(store.getMemoryFactVectorNative(factId, "text-embedding-3-small"), null);

    const deleted = store.deleteMemoryFact({
      scope: "guild",
      guildId: "guild-a",
      factId
    });

    assert.equal(deleted.ok, true);
    assert.equal(deleted.deleted, 1);
    assert.equal(store.getMemoryFactById(factId, "guild-a", "guild"), null);
    assert.equal(
      store.getFactsForScope({
        guildId: "guild-a",
        limit: 10,
        subjectIds: ["user-1"]
      }).length,
      0
    );
  });
});

test("store init performs one-time legacy memory canonicalization", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clanker-store-legacy-test-"));
  const dbPath = path.join(dir, "clanker.db");

  try {
    const store = new Store(dbPath);
    store.init();
    const now = new Date().toISOString();
    store.db.prepare(
      `INSERT INTO memory_facts (
        created_at, updated_at, scope, guild_id, channel_id, user_id, subject, fact, fact_type, evidence_text, source_message_id, confidence, is_active
      ) VALUES (?, ?, 'guild', 'guild-a', 'chan-1', NULL, '__lore__', 'Memory line: Friday game night gets loud.', 'lore', 'legacy lore', 'legacy-1', 0.7, 1)`
    ).run(now, now);
    store.db.prepare(
      `INSERT INTO memory_facts (
        created_at, updated_at, scope, guild_id, channel_id, user_id, subject, fact, fact_type, evidence_text, source_message_id, confidence, is_active
      ) VALUES (?, ?, 'guild', 'guild-a', 'chan-1', NULL, '__lore__', 'Friday game night gets loud.', 'other', '', 'legacy-2', 0.8, 1)`
    ).run(now, now);
    store.db.prepare(
      `INSERT INTO memory_facts (
        created_at, updated_at, scope, guild_id, channel_id, user_id, subject, fact, fact_type, evidence_text, source_message_id, confidence, is_active
      ) VALUES (?, ?, 'user', NULL, 'chan-2', 'user-1', 'user-1', 'Self memory: Likes handhelds.', 'general', 'legacy self', 'legacy-3', 0.6, 1)`
    ).run(now, now);
    store.db.prepare(
      `INSERT INTO memory_facts (
        created_at, updated_at, scope, guild_id, channel_id, user_id, subject, fact, fact_type, evidence_text, source_message_id, confidence, is_active
      ) VALUES (?, ?, 'guild', 'guild-a', 'chan-3', NULL, '123456789', 'They build rhythm game controllers.', 'other', 'legacy scoped person fact', 'legacy-4', 0.65, 1)`
    ).run(now, now);
    store.close();

    const reopened = new Store(dbPath);
    reopened.init();

    const guildFacts = reopened.getFactsForScope({ guildId: "guild-a", limit: 10, subjectIds: ["__lore__"] });
    assert.equal(guildFacts.length, 1);
    assert.equal(guildFacts[0]?.fact, "Friday game night gets loud.");
    assert.equal(guildFacts[0]?.fact_type, "other");

    const userFacts = reopened.getFactsForScope({ guildId: "guild-a", includePortableUserScope: true, limit: 10, subjectIds: ["user-1"] });
    assert.equal(userFacts.length, 1);
    assert.equal(userFacts[0]?.fact, "Likes handhelds.");
    assert.equal(userFacts[0]?.fact_type, "other");

    const migratedPersonFacts = reopened.getFactsForScope({ guildId: "guild-a", includePortableUserScope: true, limit: 10, subjectIds: ["123456789"] });
    assert.equal(migratedPersonFacts.length, 1);
    assert.equal(migratedPersonFacts[0]?.scope, "user");
    assert.equal(migratedPersonFacts[0]?.guild_id, null);
    assert.equal(migratedPersonFacts[0]?.user_id, "123456789");
    assert.equal(migratedPersonFacts[0]?.subject, "123456789");
    reopened.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("voice reply decision llm settings normalize provider and model", async () => {
  await withTempStore(async (store) => {
    const patched = store.patchSettings(createTestSettingsPatch({
      voice: {
        conversationPolicy: {
          replyPath: "bridge"
        },
        admission: {
          mode: "classifier_gate"
        }
      },
      agentStack: {
        advancedOverridesEnabled: true,
        overrides: {
          voiceAdmissionClassifier: {
            mode: "dedicated_model",
            model: {
              provider: "CLAUDE-OAUTH",
              model: " claude-opus-4-6 "
            }
          }
        }
      }
    }));

    const binding = getResolvedVoiceAdmissionClassifierBinding(patched);
    assert.equal(binding?.provider, "claude-oauth");
    assert.equal(binding?.model, "claude-opus-4-6");
  });
});
