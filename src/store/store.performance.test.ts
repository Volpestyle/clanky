import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { Store } from "./store.ts";

async function withTempStore(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clanker-store-perf-test-"));
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

test("getReplyPerformanceStats reports p50/p95 aggregates from action metadata", async () => {
  await withTempStore(async (store) => {
    const samples = [100, 200, 300, 400, 500];
    for (const [index, totalMs] of samples.entries()) {
      store.logAction({
        kind: index % 2 === 0 ? "sent_reply" : "sent_message",
        content: `sample-${index}`,
        metadata: {
          performance: {
            version: 1,
            totalMs,
            processingMs: totalMs - 20,
            queueMs: 20,
            ingestMs: 5,
            memorySliceMs: 15,
            llm1Ms: 40,
            followupMs: 0,
            typingDelayMs: 10,
            sendMs: 8
          }
        }
      });
    }

    store.logAction({
      kind: "reply_skipped",
      content: "no-performance-payload",
      metadata: {
        reason: "gate"
      }
    });

    const perf = store.getReplyPerformanceStats({ windowHours: 24, maxSamples: 50 });
    assert.equal(perf.sampleCount, 5);
    assert.equal(perf.totalMs.count, 5);
    assert.equal(perf.totalMs.p50Ms, 300);
    assert.equal(perf.totalMs.p95Ms, 500);
    assert.equal(perf.totalMs.minMs, 100);
    assert.equal(perf.totalMs.maxMs, 500);
    assert.equal(perf.byKind.sent_reply, 3);
    assert.equal(perf.byKind.sent_message, 2);
    assert.equal(perf.byKind.reply_skipped, 0);
    assert.equal(perf.phases.queueMs.p50Ms, 20);
    assert.equal(perf.phases.memorySliceMs.p95Ms, 15);
  });
});

test("getStats includes reply performance summary", async () => {
  await withTempStore(async (store) => {
    store.logAction({
      kind: "sent_reply",
      content: "timed reply",
      metadata: {
        performance: {
          version: 1,
          totalMs: 240,
          processingMs: 180,
          queueMs: 60,
          ingestMs: 14,
          memorySliceMs: 19,
          llm1Ms: 82,
          followupMs: 11,
          typingDelayMs: 40,
          sendMs: 6
        }
      }
    });

    const stats = store.getStats();
    assert.equal(typeof stats.performance, "object");
    assert.equal(stats.performance.sampleCount, 1);
    assert.equal(stats.performance.totalMs.p50Ms, 240);
    assert.equal(stats.performance.phases.llm1Ms.p50Ms, 82);
  });
});
