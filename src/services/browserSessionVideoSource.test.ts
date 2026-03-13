import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  BrowserSessionVideoSource,
  computeBrowserSessionCaptureDelayMs,
  shouldEmitBrowserSessionVideoFrame
} from "./browserSessionVideoSource.ts";

test("computeBrowserSessionCaptureDelayMs prefers active cadence during the activity burst", () => {
  const activeDelay = computeBrowserSessionCaptureDelayMs(2_000, 1_500, {
    activeFramesPerSecond: 10,
    idleFramesPerSecond: 2,
    activityBurstMs: 1_000
  });
  const idleDelay = computeBrowserSessionCaptureDelayMs(4_000, 1_500, {
    activeFramesPerSecond: 10,
    idleFramesPerSecond: 2,
    activityBurstMs: 1_000
  });

  assert.equal(activeDelay, 100);
  assert.equal(idleDelay, 500);
});

test("shouldEmitBrowserSessionVideoFrame emits initial, changed, and heartbeat frames", () => {
  const initial = shouldEmitBrowserSessionVideoFrame(
    {
      lastEmitAt: null,
      lastFrameSignature: null,
      lastFrameUrl: null,
      lastActivityAt: 0
    },
    {
      capturedAt: 100,
      signature: "a",
      currentUrl: "https://example.com"
    }
  );
  assert.deepEqual(initial, {
    emit: true,
    changed: true,
    reason: "initial"
  });

  const unchanged = shouldEmitBrowserSessionVideoFrame(
    {
      lastEmitAt: 100,
      lastFrameSignature: "a",
      lastFrameUrl: "https://example.com",
      lastActivityAt: 0
    },
    {
      capturedAt: 1_000,
      signature: "a",
      currentUrl: "https://example.com",
      heartbeatIntervalMs: 5_000
    }
  );
  assert.deepEqual(unchanged, {
    emit: false,
    changed: false,
    reason: "poll"
  });

  const heartbeat = shouldEmitBrowserSessionVideoFrame(
    {
      lastEmitAt: 100,
      lastFrameSignature: "a",
      lastFrameUrl: "https://example.com",
      lastActivityAt: 0
    },
    {
      capturedAt: 5_200,
      signature: "a",
      currentUrl: "https://example.com",
      heartbeatIntervalMs: 5_000
    }
  );
  assert.deepEqual(heartbeat, {
    emit: true,
    changed: false,
    reason: "heartbeat"
  });

  const changed = shouldEmitBrowserSessionVideoFrame(
    {
      lastEmitAt: 100,
      lastFrameSignature: "a",
      lastFrameUrl: "https://example.com",
      lastActivityAt: 4_700
    },
    {
      capturedAt: 5_000,
      signature: "b",
      currentUrl: "https://example.com",
      activityBurstMs: 500
    }
  );
  assert.deepEqual(changed, {
    emit: true,
    changed: true,
    reason: "activity"
  });
});

test("BrowserSessionVideoSource emits the initial frame and dedupes unchanged polls", async () => {
  let now = 1_000;
  let screenshotCalls = 0;
  let currentUrlCalls = 0;
  const frames: Array<{ reason: string; changed: boolean; currentUrl: string | null }> = [];

  const source = new BrowserSessionVideoSource({
    sessionKey: "browser-1",
    browserManager: {
      screenshot: async () => {
        screenshotCalls += 1;
        return screenshotCalls === 1 ? "data:image/png;base64,first" : "data:image/png;base64,first";
      },
      currentUrl: async () => {
        currentUrlCalls += 1;
        return "https://example.com";
      }
    },
    onFrame: (frame) => {
      frames.push({
        reason: frame.reason,
        changed: frame.changed,
        currentUrl: frame.currentUrl
      });
    },
    now: () => now
  });

  const initial = await source.pollOnce();
  now = 2_000;
  const second = await source.pollOnce();

  assert.ok(initial);
  assert.equal(second, null);
  assert.equal(screenshotCalls, 2);
  assert.equal(currentUrlCalls, 2);
  assert.deepEqual(frames, [
    {
      reason: "initial",
      changed: true,
      currentUrl: "https://example.com"
    }
  ]);
});

test("BrowserSessionVideoSource upgrades changed frames to activity after noteActivity", async () => {
  let now = 0;
  let screenshot = "data:image/png;base64,first";
  const reasons: string[] = [];

  const source = new BrowserSessionVideoSource({
    sessionKey: "browser-1",
    browserManager: {
      screenshot: async () => screenshot,
      currentUrl: async () => "https://example.com"
    },
    onFrame: (frame) => {
      reasons.push(frame.reason);
    },
    now: () => now,
    activityBurstMs: 2_000
  });

  await source.pollOnce();
  now = 5_000;
  source.noteActivity();
  screenshot = "data:image/png;base64,second";
  now = 5_100;
  await source.pollOnce();

  assert.deepEqual(reasons, ["initial", "activity"]);
});
