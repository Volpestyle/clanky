import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { Store } from "./store.ts";

async function withTempStore(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clanker-style-store-test-"));
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

test("adaptive directives can be added, edited, removed, and audited", async () => {
  await withTempStore(async (store) => {
    const added = store.addAdaptiveStyleNote({
      guildId: "guild-1",
      directiveKind: "behavior",
      noteText: "Use \"type shit\" occasionally in casual replies.",
      actorUserId: "user-1",
      actorName: "vuhlp",
      source: "test"
    });
    assert.equal(added.ok, true);
    assert.equal(added.status, "added");
    const noteId = Number(added.note?.id);

    const duplicate = store.addAdaptiveStyleNote({
      guildId: "guild-1",
      directiveKind: "behavior",
      noteText: "Use \"type shit\" occasionally in casual replies.",
      actorUserId: "user-2",
      actorName: "other",
      source: "test"
    });
    assert.equal(duplicate.ok, true);
    assert.equal(duplicate.status, "duplicate_active");

    const edited = store.updateAdaptiveStyleNote({
      noteId,
      guildId: "guild-1",
      directiveKind: "guidance",
      noteText: "Use \"type shit\" occasionally in casual replies. Keep it natural and not every message.",
      actorUserId: "user-1",
      actorName: "vuhlp",
      source: "test"
    });
    assert.equal(edited.ok, true);
    assert.equal(edited.status, "edited");

    const activeNotes = store.getActiveAdaptiveStyleNotes("guild-1", 10);
    assert.equal(activeNotes.length, 1);
    assert.equal(activeNotes[0]?.directiveKind, "guidance");
    assert.equal(String(activeNotes[0]?.noteText).includes("Keep it natural"), true);

    const removed = store.removeAdaptiveStyleNote({
      noteId,
      guildId: "guild-1",
      actorUserId: "user-1",
      actorName: "vuhlp",
      removalReason: "user changed mind",
      source: "test"
    });
    assert.equal(removed.ok, true);
    assert.equal(removed.status, "removed");

    const noActiveNotes = store.getActiveAdaptiveStyleNotes("guild-1", 10);
    assert.equal(noActiveNotes.length, 0);

    const auditLog = store.getAdaptiveStyleNoteAuditLog("guild-1", 10);
    assert.equal(auditLog.length, 3);
    assert.deepEqual(
      auditLog.map((row) => row.eventType),
      ["removed", "edited", "added"]
    );
    assert.equal(auditLog[0]?.directiveKind, "guidance");
    assert.equal(auditLog[1]?.detailText, "Use \"type shit\" occasionally in casual replies.");
  });
});

test("adaptive directives are scoped by guild", async () => {
  await withTempStore(async (store) => {
    store.addAdaptiveStyleNote({
      guildId: "guild-a",
      noteText: "Be more clipped.",
      actorName: "alice",
      source: "test"
    });
    store.addAdaptiveStyleNote({
      guildId: "guild-b",
      noteText: "Be more reflective.",
      actorName: "bob",
      source: "test"
    });

    const guildA = store.getActiveAdaptiveStyleNotes("guild-a", 10);
    const guildB = store.getActiveAdaptiveStyleNotes("guild-b", 10);
    assert.equal(guildA.length, 1);
    assert.equal(guildB.length, 1);
    assert.equal(guildA[0]?.guildId, "guild-a");
    assert.equal(guildB[0]?.guildId, "guild-b");
  });
});

test("prompt directive search keeps guidance global and behavior query-scoped", async () => {
  await withTempStore(async (store) => {
    store.addAdaptiveStyleNote({
      guildId: "guild-1",
      directiveKind: "guidance",
      noteText: "Use \"type shit\" occasionally in casual replies.",
      actorName: "vuhlp",
      source: "test"
    });
    store.addAdaptiveStyleNote({
      guildId: "guild-1",
      directiveKind: "behavior",
      noteText: "Send a GIF to Tiny Conk whenever they say \"what the heli.\"",
      actorName: "vuhlp",
      source: "test"
    });

    const defaultPromptDirectives = store.searchAdaptiveStyleNotesForPrompt({
      guildId: "guild-1",
      queryText: "",
      limit: 8
    });
    assert.equal(defaultPromptDirectives.length, 1);
    assert.equal(defaultPromptDirectives[0]?.directiveKind, "guidance");

    const matchedPromptDirectives = store.searchAdaptiveStyleNotesForPrompt({
      guildId: "guild-1",
      queryText: "Tiny Conk just said what the heli",
      limit: 8
    });
    assert.equal(matchedPromptDirectives.length, 2);
    assert.equal(
      matchedPromptDirectives.some((row) => row.directiveKind === "behavior"),
      true
    );
  });
});
