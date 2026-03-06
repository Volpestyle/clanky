import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  evaluateDiscoverySchedule,
  evaluateSpontaneousDiscoverySchedule,
  getDiscoveryAverageIntervalMs,
  getDiscoveryMinGapMs,
  getDiscoveryPacingMode,
  getDiscoveryPostingIntervalMs,
  pickDiscoveryChannel
} from "./discoverySchedule.ts";
import { createTestSettings } from "../testSettings.ts";

function baseSettings(overrides = {}) {
  const base = {
    discovery: {
      maxPostsPerDay: 12,
      minMinutesBetweenPosts: 30,
      pacingMode: "even",
      postOnStartup: true,
      spontaneity: 40,
      channelIds: []
    },
    permissions: {}
  };

  return createTestSettings({
    ...base,
    ...overrides,
    discovery: {
      ...base.discovery,
      ...(overrides.discovery || {})
    },
    permissions: {
      ...base.permissions,
      ...(overrides.permissions || {})
    }
  });
}

test("discovery interval uses the larger of min-gap and even pacing", () => {
  const gapDominant = getDiscoveryPostingIntervalMs(
    baseSettings({
      discovery: {
        maxPostsPerDay: 999,
        minMinutesBetweenPosts: 60
      }
    })
  );
  assert.equal(gapDominant, 60 * 60 * 1000);

  const pacingDominant = getDiscoveryPostingIntervalMs(
    baseSettings({
      discovery: {
        maxPostsPerDay: 2,
        minMinutesBetweenPosts: 1
      }
    })
  );
  assert.equal(pacingDominant, 12 * 60 * 60 * 1000);
});

test("discovery helper accessors normalize mode and timing values", () => {
  const settings = baseSettings({
    discovery: {
      maxPostsPerDay: 6,
      minMinutesBetweenPosts: 7,
      pacingMode: "SpOnTaNeOuS"
    }
  });
  assert.equal(getDiscoveryAverageIntervalMs(settings), 4 * 60 * 60 * 1000);
  assert.equal(getDiscoveryPacingMode(settings), "spontaneous");
  assert.equal(getDiscoveryMinGapMs(settings), 7 * 60 * 1000);
});

test("evaluateDiscoverySchedule blocks startup posting when disabled", () => {
  const result = evaluateDiscoverySchedule({
    settings: baseSettings({
      discovery: {
        postOnStartup: false
      }
    }),
    startup: true,
    lastPostTs: null,
    elapsedMs: null,
    posts24h: 0
  });

  assert.equal(result.shouldPost, false);
  assert.equal(result.trigger, "startup_disabled");
});

test("evaluateDiscoverySchedule bootstraps first startup post when enabled", () => {
  const result = evaluateDiscoverySchedule({
    settings: baseSettings(),
    startup: true,
    lastPostTs: null,
    elapsedMs: null,
    posts24h: 0
  });

  assert.equal(result.shouldPost, true);
  assert.equal(result.trigger, "startup_bootstrap");
});

test("evaluateDiscoverySchedule enforces min-gap before any non-startup post", () => {
  const settings = baseSettings({
    discovery: {
      minMinutesBetweenPosts: 15
    }
  });
  const result = evaluateDiscoverySchedule({
    settings,
    startup: false,
    lastPostTs: Date.now() - 120_000,
    elapsedMs: 120_000,
    posts24h: 0
  });

  assert.equal(result.shouldPost, false);
  assert.equal(result.trigger, "min_gap_block");
  assert.equal(result.requiredIntervalMs, 15 * 60 * 1000);
});

test("evaluateDiscoverySchedule supports even pacing wait and due transitions", () => {
  const settings = baseSettings({
    discovery: {
      maxPostsPerDay: 8,
      minMinutesBetweenPosts: 30,
      pacingMode: "even"
    }
  });
  const required = getDiscoveryPostingIntervalMs(settings);

  const waiting = evaluateDiscoverySchedule({
    settings,
    startup: false,
    lastPostTs: Date.now() - (required - 10_000),
    elapsedMs: required - 10_000,
    posts24h: 1
  });
  assert.equal(waiting.shouldPost, false);
  assert.equal(waiting.trigger, "even_wait");

  const due = evaluateDiscoverySchedule({
    settings,
    startup: false,
    lastPostTs: Date.now() - (required + 1_000),
    elapsedMs: required + 1_000,
    posts24h: 1
  });
  assert.equal(due.shouldPost, true);
  assert.equal(due.trigger, "even_due");
});

test("evaluateSpontaneousDiscoverySchedule forces a post after force window", () => {
  const settings = baseSettings({
    discovery: {
      pacingMode: "spontaneous",
      maxPostsPerDay: 10,
      minMinutesBetweenPosts: 20,
      spontaneity: 80
    }
  });
  const average = getDiscoveryAverageIntervalMs(settings);
  const minGap = getDiscoveryMinGapMs(settings);
  const forceAfterMs = Math.max(minGap, Math.round(average * (1.6 - 0.8 * 0.55)));

  const result = evaluateSpontaneousDiscoverySchedule({
    settings,
    lastPostTs: Date.now() - (forceAfterMs + 5_000),
    elapsedMs: forceAfterMs + 5_000,
    posts24h: 1,
    minGapMs: minGap
  });

  assert.equal(result.shouldPost, true);
  assert.equal(result.trigger, "spontaneous_force_due");
  assert.equal(result.requiredIntervalMs, forceAfterMs);
});

test("pickDiscoveryChannel skips unavailable and disallowed channels", () => {
  const channels = new Map();
  channels.set("voice-1", {
    id: "voice-1",
    isTextBased() {
      return false;
    }
  });
  channels.set("text-2", {
    id: "text-2",
    isTextBased() {
      return true;
    },
    async send() {}
  });

  const picked = pickDiscoveryChannel({
    settings: baseSettings({
      discovery: {
        channelIds: ["voice-1", "text-2"]
      }
    }),
    client: {
      channels: {
        cache: channels
      }
    },
    isChannelAllowed(_settings, channelId) {
      return channelId === "text-2";
    }
  });

  assert.equal(picked?.id, "text-2");

  const none = pickDiscoveryChannel({
    settings: baseSettings({
      discovery: {
        channelIds: ["text-2"]
      }
    }),
    client: {
      channels: {
        cache: channels
      }
    },
    isChannelAllowed() {
      return false;
    }
  });
  assert.equal(none, null);
});
