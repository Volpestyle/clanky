import { test } from "bun:test";
import assert from "node:assert/strict";
import { GifService } from "./gif.ts";

function createService({
  apiKey = "test-giphy-key",
  rating = "pg-13"
} = {}) {
  const logs = [];
  const store = {
    logAction(entry) {
      logs.push(entry);
    }
  };
  const service = new GifService({
    appConfig: {
      giphyApiKey: apiKey,
      giphyRating: rating
    },
    store
  });
  return { service, logs };
}

async function withMockFetch(handler, run) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("pickGif searches giphy, deduplicates results, and logs successful pick", async () => {
  const { service, logs } = createService();
  const originalRandom = Math.random;
  Math.random = () => 0;

  await withMockFetch(
    async (url) => {
      const parsed = new URL(String(url));
      assert.equal(parsed.origin + parsed.pathname, "https://api.giphy.com/v1/gifs/search");
      assert.equal(parsed.searchParams.get("rating"), "pg-13");
      return {
        ok: true,
        async json() {
          return {
            data: [
              {
                id: "a",
                title: "alpha",
                images: { fixed_height: { url: "https://media.giphy.com/media/a/giphy.gif" } },
                url: "https://giphy.com/gifs/a"
              },
              {
                id: "dup",
                title: "duplicate",
                images: { fixed_height: { url: "https://media.giphy.com/media/a/giphy.gif" } },
                url: "https://giphy.com/gifs/a-dup"
              },
              {
                id: "http-only",
                title: "bad",
                images: { fixed_height: { url: "http://media.giphy.com/media/http/giphy.gif" } }
              }
            ]
          };
        }
      };
    },
    async () => {
      const result = await service.pickGif({
        query: "cats",
        trace: { guildId: "guild-1", channelId: "chan-1", userId: "user-1", source: "reply" }
      });
      assert.equal(result?.id, "a");
      assert.equal(result?.url, "https://media.giphy.com/media/a/giphy.gif");
    }
  );

  Math.random = originalRandom;

  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.kind, "gif_call");
  assert.equal(logs[0]?.metadata?.used, true);
});

test("pickGif logs error and throws on provider failure", async () => {
  const { service, logs } = createService();

  await withMockFetch(
    async () => ({ ok: false, status: 503 }),
    async () => {
      await assert.rejects(
        () => service.pickGif({ query: "something", trace: { source: "test-case" } }),
        /GIPHY HTTP 503/
      );
    }
  );

  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.kind, "gif_error");
  assert.match(String(logs[0]?.content || ""), /503/);
});
