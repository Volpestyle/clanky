import { test } from "bun:test";
import assert from "node:assert/strict";
import { DiscoveryService, normalizeDiscoveryUrl } from "./discovery.ts";
import { normalizeSettings } from "./store/settingsNormalization.ts";

function withFrozenTimeAndRandom({ nowMs, randomValue }, run) {
  const originalNow = Date.now;
  const originalRandom = Math.random;
  Date.now = () => nowMs;
  Math.random = () => randomValue;
  return Promise.resolve()
    .then(run)
    .finally(() => {
      Date.now = originalNow;
      Math.random = originalRandom;
    });
}

test("normalizeDiscoveryUrl strips trackers, hash, and default ports", () => {
  const normalized = normalizeDiscoveryUrl(
    "https://Example.com:443/path/?utm_source=abc&fbclid=123&x=1#section"
  );
  assert.equal(normalized, "https://example.com/path/?x=1");
  assert.equal(normalizeDiscoveryUrl("javascript:alert(1)"), null);
  assert.equal(normalizeDiscoveryUrl(""), null);
});

test("DiscoveryService.collect returns disabled payload when discovery is off", async () => {
  const service = new DiscoveryService({
    store: {
      wasLinkSharedSince() {
        return false;
      }
    }
  });

  const result = await service.collect({
    settings: normalizeSettings({
      discovery: {
        enabled: false,
        sources: {
          reddit: false,
          hackerNews: false,
          youtube: false,
          rss: false,
          x: false
        }
      }
    }),
    guildId: "guild-1",
    channelId: "chan-1",
    channelName: "general",
    recentMessages: []
  });

  assert.equal(result.enabled, false);
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.selected, []);
});

test("DiscoveryService.collect dedupes, filters, and aggregates source errors", async () => {
  const nowMs = Date.parse("2026-02-27T20:00:00.000Z");
  const service = new DiscoveryService({
    store: {
      wasLinkSharedSince(url) {
        return String(url).includes("/shared");
      }
    }
  });

  service.fetchReddit = async () => ({
    report: {
      source: "reddit",
      fetched: 5,
      accepted: 5,
      error: null
    },
    items: [
      {
        source: "reddit",
        sourceLabel: "r/space",
        title: "Space launch update",
        url: "https://example.com/launch?utm_source=reddit",
        excerpt: "fresh update",
        popularity: 120,
        publishedAt: new Date(nowMs - 2 * 60 * 60_000).toISOString(),
        nsfw: false
      },
      {
        source: "reddit",
        sourceLabel: "r/space",
        title: "Duplicate by tracker variant",
        url: "https://example.com/launch?gclid=abc",
        excerpt: "same target",
        popularity: 130,
        publishedAt: new Date(nowMs - 60 * 60_000).toISOString(),
        nsfw: false
      },
      {
        source: "reddit",
        sourceLabel: "r/space",
        title: "Old item",
        url: "https://example.com/old",
        excerpt: "too old",
        popularity: 8,
        publishedAt: new Date(nowMs - 10 * 24 * 60 * 60_000).toISOString(),
        nsfw: false
      },
      {
        source: "reddit",
        sourceLabel: "r/space",
        title: "Nsfw item",
        url: "https://example.com/nsfw",
        excerpt: "nsfw",
        popularity: 99,
        publishedAt: new Date(nowMs - 60 * 60_000).toISOString(),
        nsfw: true
      },
      {
        source: "reddit",
        sourceLabel: "r/space",
        title: "Already shared",
        url: "https://example.com/shared",
        excerpt: "already posted",
        popularity: 99,
        publishedAt: new Date(nowMs - 60 * 60_000).toISOString(),
        nsfw: false
      }
    ]
  });

  service.fetchRss = async () => ({
    report: {
      source: "rss",
      fetched: 1,
      accepted: 1,
      error: null
    },
    items: [
      {
        source: "rss",
        sourceLabel: "Tech Feed",
        title: "Rocket engineering deep dive",
        url: "https://news.example.org/story",
        excerpt: "analysis",
        popularity: 0,
        publishedAt: new Date(nowMs - 30 * 60_000).toISOString(),
        nsfw: false
      }
    ]
  });

  service.fetchHackerNews = async () => {
    throw new Error("hn fetch failed");
  };

  await withFrozenTimeAndRandom({ nowMs, randomValue: 0.5 }, async () => {
    const result = await service.collect({
      settings: normalizeSettings({
        discovery: {
          maxLinksPerPost: 2,
          maxCandidatesForPrompt: 6,
          freshnessHours: 48,
          dedupeHours: 24,
          randomness: 0,
          allowNsfw: false,
          preferredTopics: ["space"],
          redditSubreddits: ["r/space"],
          rssFeeds: ["https://feeds.example.org/rss"],
          sources: {
            reddit: true,
            hackerNews: true,
            youtube: false,
            rss: true,
            x: false
          }
        }
      }),
      guildId: "guild-1",
      channelId: "chan-1",
      channelName: "space-lounge",
      recentMessages: [{ content: "rockets and launches today" }]
    });

    assert.equal(result.enabled, true);
    assert.equal(result.summary.sourceCount, 3);
    assert.equal(result.summary.selectedCount, 2);
    assert.equal(result.candidates.length, 2);
    assert.equal(result.selected.length, 2);
    assert.equal(result.candidates[0].url.includes("utm_"), false);
    assert.equal(result.errors.some((entry) => entry.includes("hn fetch failed")), true);
    assert.equal(result.reportBySource.reddit.source, "reddit");
    assert.equal(result.reportBySource.rss.source, "rss");
    assert.equal(result.reportBySource.unknown.source, "unknown");
    assert.equal(result.topics.some((topic) => String(topic).toLowerCase() === "space"), true);
    assert.equal(result.topics.some((topic) => String(topic).toLowerCase() === "rockets"), true);
  });
});
