import { test } from "bun:test";
import assert from "node:assert/strict";
import { WebSearchService } from "./search.ts";
import { createTestSettings } from "./testSettings.ts";

function createService() {
  const logs = [];
  const service = new WebSearchService({
    appConfig: {},
    store: {
      logAction(entry) {
        logs.push(entry);
      }
    }
  });
  return { service, logs };
}

test("searchAndRead falls back to secondary provider and reads pages", async () => {
  const { service, logs } = createService();
  service.providers = [
    {
      name: "brave",
      isConfigured() { return true; },
      async search() { throw new Error("primary offline"); }
    },
    {
      name: "serpapi",
      isConfigured() { return true; },
      async search() {
        return {
          results: [{
            title: "Space story",
            url: "https://example.com/space",
            domain: "example.com",
            snippet: "space"
          }]
        };
      }
    }
  ];
  service.readPageSummary = async () => ({
    title: "Space story",
    summary: "Readable summary",
    extractionMethod: "fast"
  });

  const result = await service.searchAndRead({
    settings: createTestSettings({
      webSearch: {
        maxResults: 3,
        maxPagesToRead: 1,
        providerOrder: ["brave", "serpapi"]
      }
    }),
    query: "  space cats ",
    trace: { guildId: "guild-1", channelId: "chan-1", userId: "user-1", source: "test" }
  });

  assert.equal(result.query, "space cats");
  assert.equal(result.providerUsed, "serpapi");
  assert.equal(result.providerFallbackUsed, true);
  assert.equal(result.fetchedPages, 1);
  assert.equal(result.results[0]?.pageSummary, "Readable summary");
  assert.equal(logs.some((entry) => entry.kind === "search_call"), true);
});

test("searchAndRead logs provider-stage errors and rethrows when all providers fail", async () => {
  const { service, logs } = createService();
  service.providers = [
    {
      name: "brave",
      isConfigured() { return true; },
      async search() { throw new Error("provider hard failure"); }
    }
  ];

  await assert.rejects(
    () => service.searchAndRead({
      settings: createTestSettings({ webSearch: { providerOrder: ["brave"] } }),
      query: "deep topic",
      trace: { guildId: "guild-1", channelId: "chan-2", userId: "user-9", source: "policy" }
    }),
    /provider hard failure/
  );

  assert.equal(
    logs.some((entry) => entry.kind === "search_error" && entry.metadata?.stage === "provider"),
    true
  );
});
