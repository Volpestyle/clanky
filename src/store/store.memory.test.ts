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

test("memory facts are scoped by guild", async () => {
  await withTempStore(async (store) => {
    const factPayload = {
      channelId: "channel-1",
      subject: "user-1",
      fact: "User likes pineapple pizza.",
      factType: "preference",
      evidenceText: "likes pineapple pizza",
      sourceMessageId: "msg-1",
      confidence: 0.7
    };

    const insertedA = store.addMemoryFact({
      ...factPayload,
      guildId: "guild-a"
    });
    const insertedB = store.addMemoryFact({
      ...factPayload,
      guildId: "guild-b",
      sourceMessageId: "msg-2"
    });

    assert.equal(insertedA, true);
    assert.equal(insertedB, true);

    const guildAFacts = store.getFactsForSubjects(["user-1"], 10, { guildId: "guild-a" });
    const guildBFacts = store.getFactsForSubjects(["user-1"], 10, { guildId: "guild-b" });
    assert.equal(guildAFacts.length, 1);
    assert.equal(guildBFacts.length, 1);
    assert.equal(guildAFacts[0].guild_id, "guild-a");
    assert.equal(guildBFacts[0].guild_id, "guild-b");
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

    for (let i = 1; i <= 22; i += 1) {
      addFact("user-core-cap", `Core cap ${i}.`, i % 2 === 0 ? "relationship" : "profile", `core-b-${i}`);
    }
    addFact("user-core-cap", "Context survivor.", "preference", "ctx-b-1");

    const archivedMixed = store.archiveOldFactsForSubject({
      guildId: "guild-a",
      subject: "user-core-cap",
      keep: 20
    });
    assert.equal(archivedMixed, 3);
    const coreCapFacts = store.getFactsForSubjects(["user-core-cap"], 30, { guildId: "guild-a" });
    assert.equal(coreCapFacts.filter((row) => row.fact_type === "preference").length, 0);
    assert.equal(coreCapFacts.filter((row) => row.fact_type === "profile" || row.fact_type === "relationship").length, 20);
  });
});

test("memory facts support query filtering, updates, and removal", async () => {
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

    const factId = Number(matching[0]?.id);
    const updated = store.updateMemoryFact({
      factId,
      guildId: "guild-a",
      channelId: "chan-1",
      subject: "user-1",
      fact: "User collects old school DS hardware and games.",
      factType: "profile",
      evidenceText: "Updated after audit.",
      sourceMessageId: "msg-1",
      confidence: 0.92
    });
    assert.equal(updated.ok, true);
    assert.equal(updated.fact?.fact, "User collects old school DS hardware and games.");
    assert.equal(updated.fact?.fact_type, "profile");

    const updatedSearch = store.getFactsForScope({
      guildId: "guild-a",
      limit: 10,
      queryText: "hardware and games"
    });
    assert.equal(updatedSearch.length, 1);
    assert.equal(updatedSearch[0]?.id, factId);

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
      factTypes: ["profile"]
    });
    assert.equal(typeFiltered.length, 1);
    assert.equal(typeFiltered[0]?.id, factId);

    const removed = store.removeMemoryFact({
      factId,
      guildId: "guild-a"
    });
    assert.equal(removed.ok, true);
    assert.equal(store.getMemoryFactById(factId, { guildId: "guild-a" }), null);
    assert.equal(store.getMemoryFactById(factId, { guildId: "guild-a", includeInactive: true })?.fact, removed.fact?.fact);
  });
});

test("voice reply decision llm settings normalize provider and model", async () => {
  await withTempStore(async (store) => {
    const patched = store.patchSettings(createTestSettingsPatch({
      voice: {
        replyDecisionLlm: {
          provider: "CLAUDE-OAUTH",
          model: " claude-opus-4-6 ",
          realtimeAdmissionMode: "classifier_gate"
        }
      }
    }));

    const binding = getResolvedVoiceAdmissionClassifierBinding(patched);
    assert.equal(binding?.provider, "claude-oauth");
    assert.equal(binding?.model, "claude-opus-4-6");
  });
});
