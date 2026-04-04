import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { Store } from "./store.ts";
import { rmTempDir } from "../testHelpers.ts";

async function withTempStore(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clanker-automation-store-test-"));
  const dbPath = path.join(dir, "clanker.db");
  const store = new Store(dbPath);
  store.init();

  try {
    await run(store);
  } finally {
    store.close();
    await rmTempDir(dir);
  }
}

test("claimDueAutomations marks only due active jobs as running", async () => {
  await withTempStore(async (store) => {
    const nowIso = "2026-02-26T16:00:00.000Z";
    const dueIso = "2026-02-26T15:50:00.000Z";
    const futureIso = "2026-02-26T16:30:00.000Z";

    const dueA = store.createAutomation({
      guildId: "guild-a",
      channelId: "chan-1",
      createdByUserId: "user-1",
      createdByName: "alice",
      title: "due-a",
      instruction: "post update a",
      schedule: { kind: "interval", everyMinutes: 15 },
      nextRunAt: dueIso
    });
    const dueB = store.createAutomation({
      guildId: "guild-a",
      channelId: "chan-1",
      createdByUserId: "user-1",
      createdByName: "alice",
      title: "due-b",
      instruction: "post update b",
      schedule: { kind: "interval", everyMinutes: 15 },
      nextRunAt: dueIso
    });
    const future = store.createAutomation({
      guildId: "guild-a",
      channelId: "chan-1",
      createdByUserId: "user-1",
      createdByName: "alice",
      title: "future",
      instruction: "post update c",
      schedule: { kind: "interval", everyMinutes: 15 },
      nextRunAt: futureIso
    });

    assert.ok(dueA?.id);
    assert.ok(dueB?.id);
    assert.ok(future?.id);

    const claimed = store.claimDueAutomations({
      now: nowIso,
      limit: 5
    });
    const claimedIds = claimed.map((row) => row.id).sort((a, b) => a - b);
    assert.deepEqual(claimedIds, [dueA.id, dueB.id].sort((a, b) => a - b));
    assert.equal(claimed.every((row) => row.is_running), true);

    const secondClaim = store.claimDueAutomations({
      now: nowIso,
      limit: 5
    });
    assert.equal(secondClaim.length, 0);
  });
});
