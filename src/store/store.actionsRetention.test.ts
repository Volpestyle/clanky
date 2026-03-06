import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { Store } from "./store.ts";

async function withTempStore(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clanker-store-actions-retention-test-"));
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

test("pruneActionLog removes old rows, caps action count, and drops stale trigger references", async () => {
  await withTempStore(async (store) => {
    const insertAction = store.db.prepare(
      `INSERT INTO actions(
        created_at,
        guild_id,
        channel_id,
        message_id,
        user_id,
        kind,
        content,
        metadata,
        usd_cost
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertTrigger = store.db.prepare(
      `INSERT INTO response_triggers(trigger_message_id, action_id, created_at)
       VALUES (?, ?, ?)`
    );

    const actionRows = [
      { createdAt: "2026-02-20T00:00:00.000Z", kind: "bot_error" },
      { createdAt: "2026-02-27T00:00:00.000Z", kind: "voice_runtime" },
      { createdAt: "2026-02-28T00:00:00.000Z", kind: "voice_runtime" },
      { createdAt: "2026-03-01T00:00:00.000Z", kind: "voice_runtime" },
      { createdAt: "2026-03-01T01:00:00.000Z", kind: "voice_runtime" }
    ];
    const insertedIds = [];
    for (let index = 0; index < actionRows.length; index += 1) {
      const row = actionRows[index];
      const result = insertAction.run(
        row.createdAt,
        "guild-1",
        "chan-1",
        `msg-${index + 1}`,
        "user-1",
        row.kind,
        `content-${index + 1}`,
        null,
        0
      );
      const actionId = Number(result?.lastInsertRowid || 0);
      insertedIds.push(actionId);
      insertTrigger.run(`trigger-${index + 1}`, actionId, row.createdAt);
    }
    insertTrigger.run("trigger-orphan", 99_999_999, "2026-03-01T01:00:00.000Z");

    const pruneResult = store.pruneActionLog({
      now: "2026-03-01T02:00:00.000Z",
      maxAgeDays: 2,
      maxRows: 2
    });

    assert.equal(pruneResult.deletedActions > 0, true);
    assert.equal(pruneResult.deletedResponseTriggers > 0, true);

    const remainingActions = store.db
      .prepare("SELECT id FROM actions ORDER BY id ASC")
      .all()
      .map((row) => Number(row.id));
    assert.deepEqual(remainingActions, insertedIds.slice(-2));

    const remainingTriggers = store.db
      .prepare("SELECT action_id FROM response_triggers ORDER BY action_id ASC")
      .all()
      .map((row) => Number(row.action_id));
    assert.deepEqual(remainingTriggers, insertedIds.slice(-2));
  });
});

test("logAction auto-prunes when write interval threshold is reached", async () => {
  await withTempStore(async (store) => {
    store.actionLogPruneEveryWrites = 1;
    store.actionLogMaxRows = 3;
    store.actionLogRetentionDays = 3650;

    for (let index = 0; index < 6; index += 1) {
      store.logAction({
        kind: "voice_runtime",
        content: `event-${index + 1}`
      });
    }

    const rowCount = Number(store.db.prepare("SELECT COUNT(*) AS count FROM actions").get()?.count || 0);
    assert.equal(rowCount, 3);

    const recent = store.getRecentActions(10);
    assert.equal(recent.length, 3);
    const recentContents = recent.map((r) => r.content).sort();
    assert.deepEqual(recentContents, ["event-4", "event-5", "event-6"]);
  });
});
