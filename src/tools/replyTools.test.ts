import { test } from "bun:test";
import assert from "node:assert/strict";
import { buildReplyToolSet, executeReplyTool } from "./replyTools.ts";

test("buildReplyToolSet includes browser_browse when browser agent is enabled and available", () => {
  const tools = buildReplyToolSet({
    browser: { enabled: true },
    webSearch: { enabled: false },
    memory: { enabled: false },
    adaptiveDirectives: { enabled: false }
  }, {
    browserBrowseAvailable: true,
    conversationSearchAvailable: false
  });

  assert.equal(tools.some((tool) => tool.name === "browser_browse"), true);
});

test("buildReplyToolSet excludes browser_browse when caller opts out", () => {
  const tools = buildReplyToolSet({
    browser: { enabled: true },
    webSearch: { enabled: false },
    memory: { enabled: false },
    adaptiveDirectives: { enabled: false }
  }, {
    browserBrowseAvailable: false,
    conversationSearchAvailable: false
  });

  assert.equal(tools.some((tool) => tool.name === "browser_browse"), false);
});

test("buildReplyToolSet includes web_scrape when web search is enabled", () => {
  const tools = buildReplyToolSet({
    browser: { enabled: false },
    webSearch: { enabled: true },
    memory: { enabled: false },
    adaptiveDirectives: { enabled: false }
  }, {
    conversationSearchAvailable: false
  });

  assert.equal(tools.some((tool) => tool.name === "web_scrape"), true);
});

test("buildReplyToolSet excludes web_scrape when caller opts out", () => {
  const tools = buildReplyToolSet({
    browser: { enabled: false },
    webSearch: { enabled: true },
    memory: { enabled: false },
    adaptiveDirectives: { enabled: false }
  }, {
    webScrapeAvailable: false,
    conversationSearchAvailable: false
  });

  assert.equal(tools.some((tool) => tool.name === "web_scrape"), false);
});

test("executeReplyTool delegates web_scrape to readPageSummary", async () => {
  const calls: Array<{ url: string; maxChars: number }> = [];

  const result = await executeReplyTool(
    "web_scrape",
    { url: "https://example.com/article" },
    {
      search: {
        searchAndRead: async () => ({ query: "", results: [] }),
        readPageSummary: async (url, maxChars) => {
          calls.push({ url, maxChars });
          return {
            title: "Example Article",
            summary: "This is the article content.",
            extractionMethod: "fast"
          };
        }
      }
    },
    {
      settings: {},
      guildId: "guild-1",
      channelId: "channel-1",
      userId: "user-1",
      sourceMessageId: "msg-1",
      sourceText: "read this",
      trace: { source: "reply_message" }
    }
  );

  assert.equal(result.isError, undefined);
  assert.match(result.content, /Example Article/);
  assert.match(result.content, /This is the article content\./);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://example.com/article");
});

test("executeReplyTool web_scrape suggests browser_browse on failure", async () => {
  const result = await executeReplyTool(
    "web_scrape",
    { url: "https://example.com/spa" },
    {
      search: {
        searchAndRead: async () => ({ query: "", results: [] }),
        readPageSummary: async () => {
          throw new Error("HTML page had no usable text");
        }
      }
    },
    {
      settings: {},
      guildId: "guild-1",
      channelId: "channel-1",
      userId: "user-1",
      sourceMessageId: "msg-1",
      sourceText: "read this",
      trace: { source: "reply_message" }
    }
  );

  assert.equal(result.isError, true);
  assert.match(result.content, /browser_browse/);
});

test("executeReplyTool delegates browser_browse to runtime", async () => {
  const calls: Array<Record<string, unknown>> = [];

  const result = await executeReplyTool(
    "browser_browse",
    { query: "check the latest post" },
    {
      browser: {
        async browse(opts) {
          calls.push(opts);
          return {
            text: "Found the latest post.",
            steps: 3,
            hitStepLimit: false
          };
        }
      }
    },
    {
      settings: {},
      guildId: "guild-1",
      channelId: "channel-1",
      userId: "user-1",
      sourceMessageId: "msg-1",
      sourceText: "browse it",
      trace: {
        source: "reply_message"
      }
    }
  );

  assert.equal(result.isError, undefined);
  assert.match(result.content, /Found the latest post\./);
  assert.match(result.content, /Steps: 3/);
  assert.deepEqual(calls, [{
    settings: {},
    query: "check the latest post",
    guildId: "guild-1",
    channelId: "channel-1",
    userId: "user-1",
    source: "reply_message"
  }]);
});
