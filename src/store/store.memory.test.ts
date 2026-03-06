import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { getResolvedVoiceAdmissionClassifierBinding } from "../settings/agentStack.ts";
import { Store } from "../store.ts";
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

test("archiveOldFactsForSubject deactivates older facts", async () => {
  await withTempStore(async (store) => {
    store.addMemoryFact({
      guildId: "guild-a",
      channelId: "chan-1",
      subject: "user-2",
      fact: "Fact A.",
      factType: "other",
      sourceMessageId: "m1",
      confidence: 0.4
    });
    store.addMemoryFact({
      guildId: "guild-a",
      channelId: "chan-1",
      subject: "user-2",
      fact: "Fact B.",
      factType: "other",
      sourceMessageId: "m2",
      confidence: 0.5
    });
    store.addMemoryFact({
      guildId: "guild-a",
      channelId: "chan-1",
      subject: "user-2",
      fact: "Fact C.",
      factType: "other",
      sourceMessageId: "m3",
      confidence: 0.6
    });

    const archived = store.archiveOldFactsForSubject({
      guildId: "guild-a",
      subject: "user-2",
      keep: 2
    });
    assert.ok(archived >= 1);

    const activeFacts = store.getFactsForSubjects(["user-2"], 10, { guildId: "guild-a" });
    assert.equal(activeFacts.length, 2);
  });
});

test("voice reply decision llm settings normalize provider and model", async () => {
  await withTempStore(async (store) => {
    const patched = store.patchSettings(createTestSettingsPatch({
      voice: {
        replyDecisionLlm: {
          provider: "CLAUDE-CODE",
          model: " opus "
        }
      }
    }));

    const binding = getResolvedVoiceAdmissionClassifierBinding(patched);
    assert.equal(binding?.provider, "claude-code");
    assert.equal(binding?.model, "opus");
  });
});
