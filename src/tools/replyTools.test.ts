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

test("buildReplyToolSet includes memory tools and conversation search when memory is enabled", () => {
  const toolNames = buildReplyToolSet({
    browser: { enabled: false },
    webSearch: { enabled: false },
    memory: { enabled: true },
    adaptiveDirectives: { enabled: false }
  }).map((tool) => tool.name);

  assert.equal(toolNames.includes("memory_search"), true);
  assert.equal(toolNames.includes("memory_write"), true);
  assert.equal(toolNames.includes("conversation_search"), true);
});

test("buildReplyToolSet includes code_task when dev task runtime and permissions are enabled", () => {
  const toolNames = buildReplyToolSet({
    browser: { enabled: false },
    webSearch: { enabled: false },
    memory: { enabled: false },
    adaptiveDirectives: { enabled: false },
    permissions: {
      devTasks: {
        allowedUserIds: ["user-1"]
      }
    },
    agentStack: {
      runtimeConfig: {
        devTeam: {
          codexCli: {
            enabled: true
          }
        }
      }
    }
  }).map((tool) => tool.name);

  assert.equal(toolNames.includes("code_task"), true);
});

test("buildReplyToolSet includes note_context when voice tools are available", () => {
  const toolNames = buildReplyToolSet({
    browser: { enabled: false },
    webSearch: { enabled: false },
    memory: { enabled: false },
    adaptiveDirectives: { enabled: false }
  }, {
    voiceToolsAvailable: true,
    conversationSearchAvailable: false
  }).map((tool) => tool.name);

  assert.equal(toolNames.includes("note_context"), true);
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

test("executeReplyTool delegates conversation_search to store history search", async () => {
  const queries: Array<Record<string, unknown>> = [];

  const result = await executeReplyTool(
    "conversation_search",
    { query: "starter roguelikes", scope: "guild", top_k: 1, max_age_hours: 48 },
    {
      store: {
        logAction() {},
        searchConversationWindows(opts) {
          queries.push(opts);
          return [
            {
              ageMinutes: 90,
              messages: [
                { author_name: "alice", content: "you said spelunky 2 was the cleanest starter pick", is_bot: 0 }
              ]
            }
          ];
        }
      }
    },
    {
      settings: {},
      guildId: "guild-1",
      channelId: "channel-1",
      userId: "user-1",
      sourceMessageId: "msg-1",
      sourceText: "what did we say earlier",
      trace: { source: "reply_message" }
    }
  );

  assert.equal(result.isError, undefined);
  assert.match(result.content, /Conversation history for "starter roguelikes"/);
  assert.match(result.content, /spelunky 2 was the cleanest starter pick/i);
  assert.deepEqual(queries, [{
    guildId: "guild-1",
    channelId: null,
    queryText: "starter roguelikes",
    limit: 1,
    maxAgeHours: 48,
    before: 1,
    after: 1
  }]);
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
    source: "reply_message",
    signal: undefined
  }]);
});
