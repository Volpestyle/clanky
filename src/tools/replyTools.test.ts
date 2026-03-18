import { test } from "bun:test";
import assert from "node:assert/strict";
import { SubAgentSessionManager } from "../agents/subAgentSession.ts";
import { buildReplyToolSet, executeReplyTool } from "./replyTools.ts";

test("buildReplyToolSet includes browser_browse when browser agent is enabled and available", () => {
  const tools = buildReplyToolSet({
    browser: { enabled: true },
    webSearch: { enabled: false },
    memory: { enabled: false }
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
    memory: { enabled: false }
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
    memory: { enabled: false }
  }, {
    conversationSearchAvailable: false
  });

  assert.equal(tools.some((tool) => tool.name === "web_scrape"), true);
});

test("buildReplyToolSet excludes web_scrape when caller opts out", () => {
  const tools = buildReplyToolSet({
    browser: { enabled: false },
    webSearch: { enabled: true },
    memory: { enabled: false }
  }, {
    webScrapeAvailable: false,
    conversationSearchAvailable: false
  });

  assert.equal(tools.some((tool) => tool.name === "web_scrape"), false);
});

test("buildReplyToolSet excludes web_scrape when web search is unavailable for the turn", () => {
  const tools = buildReplyToolSet({
    browser: { enabled: false },
    webSearch: { enabled: true },
    memory: { enabled: false }
  }, {
    webSearchAvailable: false,
    conversationSearchAvailable: false
  });

  assert.equal(tools.some((tool) => tool.name === "web_scrape"), false);
});

test("buildReplyToolSet includes memory tools and conversation search when memory is enabled", () => {
  const toolNames = buildReplyToolSet({
    browser: { enabled: false },
    webSearch: { enabled: false },
    memory: { enabled: true }
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

test("executeReplyTool forwards code_task role to the code agent runtime", async () => {
  const calls: Array<Record<string, unknown>> = [];

  const result = await executeReplyTool(
    "code_task",
    { task: "review this patch", role: "review" },
    {
      codeAgent: {
        async runTask(opts) {
          calls.push(opts);
          return {
            text: "Reviewed.",
            costUsd: 0.12
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
      sourceText: "please review this",
      trace: { source: "reply_message" }
    }
  );

  assert.equal(result.isError, undefined);
  assert.match(result.content, /Reviewed\./);
  assert.deepEqual(calls, [{
    settings: {},
    task: "review this patch",
    role: "review",
    cwd: undefined,
    guildId: "guild-1",
    channelId: "channel-1",
    userId: "user-1",
    source: "reply_message",
    signal: undefined
  }]);
});

test("executeReplyTool dispatches async code_task when background runner is available", async () => {
  const manager = new SubAgentSessionManager();
  let runTurnCalled = false;
  const dispatchedCalls: Array<Record<string, unknown>> = [];
  const mockSession = {
    id: "code:impl:1",
    type: "code" as const,
    createdAt: Date.now(),
    ownerUserId: "user-1",
    lastUsedAt: Date.now(),
    status: "idle" as "idle" | "running" | "completed" | "error" | "cancelled",
    async runTurn() {
      runTurnCalled = true;
      return {
        text: "done",
        costUsd: 0,
        isError: false,
        errorMessage: "",
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheWriteTokens: 0,
          cacheReadTokens: 0
        }
      };
    },
    cancel() {
      this.status = "cancelled";
    },
    close() {
      this.status = "cancelled";
    }
  };

  const result = await executeReplyTool(
    "code_task",
    { task: "refactor auth flow" },
    {
      subAgentSessions: {
        manager,
        createCodeSession() {
          return mockSession;
        },
        createBrowserSession() {
          return null;
        }
      },
      backgroundCodeTasks: {
        dispatch(args) {
          dispatchedCalls.push(args as Record<string, unknown>);
          return {
            id: "code:impl:1",
            sessionId: "code:impl:1",
            progress: { events: [] }
          };
        }
      }
    },
    {
      settings: {
        agentStack: {
          runtimeConfig: {
            devTeam: {
              codexCli: {
                enabled: true,
                asyncDispatch: {
                  enabled: true,
                  thresholdMs: 0,
                  progressReports: {
                    enabled: true,
                    intervalMs: 60_000,
                    maxReportsPerTask: 5
                  }
                }
              }
            }
          }
        }
      },
      guildId: "guild-1",
      channelId: "channel-1",
      userId: "user-1",
      sourceMessageId: "msg-1",
      sourceText: "please run this task",
      trace: { source: "reply_message" }
    }
  );

  assert.equal(result.isError, false);
  assert.match(result.content, /Code task dispatched\./);
  assert.equal(dispatchedCalls.length, 1);
  assert.equal(runTurnCalled, false);
});

test("buildReplyToolSet includes note_context when voice tools are available", () => {
  const toolNames = buildReplyToolSet({
    browser: { enabled: false },
    webSearch: { enabled: false },
    memory: { enabled: false }
  }, {
    voiceToolsAvailable: true,
    conversationSearchAvailable: false
  }).map((tool) => tool.name);

  assert.equal(toolNames.includes("note_context"), true);
  assert.equal(toolNames.includes("video_search"), true);
  assert.equal(toolNames.includes("video_play"), true);
  assert.equal(toolNames.includes("set_addressing"), false);
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

test("executeReplyTool resolves video_context by VID ref from current message attachments", async () => {
  const calls: Array<Record<string, unknown>> = [];

  const result = await executeReplyTool(
    "video_context",
    { videoRef: "VID 1" },
    {
      video: {
        async fetchContext(opts) {
          calls.push(opts);
          return {
            text: "Title: direct upload",
            imageInputs: []
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
      sourceText: "check this upload",
      trace: { source: "reply_message" },
      videoLookup: {
        refs: {
          "VID 1": "https://cdn.discordapp.com/attachments/1/2/demo.mp4"
        }
      }
    }
  );

  assert.equal(result.isError, undefined);
  assert.match(result.content, /Title: direct upload/);
  assert.deepEqual(calls, [{
    url: "https://cdn.discordapp.com/attachments/1/2/demo.mp4",
    settings: {},
    trace: {
      guildId: "guild-1",
      channelId: "channel-1",
      userId: "user-1",
      source: "video_context_tool"
    }
  }]);
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
            imageInputs: [
              {
                mediaType: "image/png",
                dataBase64: "Zm9v"
              }
            ],
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
  assert.match(result.content, /Browser screenshot attached for visual inspection\./);
  assert.match(result.content, /Steps: 3/);
  assert.deepEqual(result.imageInputs, [
    {
      mediaType: "image/png",
      dataBase64: "Zm9v"
    }
  ]);
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

test("executeReplyTool omits session_id when a browser session completes itself", async () => {
  const manager = new SubAgentSessionManager();
  const completedSession = {
    id: "browser:completed:1",
    type: "browser" as const,
    createdAt: Date.now(),
    ownerUserId: "user-1",
    lastUsedAt: Date.now(),
    status: "idle" as const,
    async runTurn() {
      this.status = "completed";
      return {
        text: "Finished browsing.",
        costUsd: 0,
        isError: false,
        errorMessage: "",
        sessionCompleted: true,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheWriteTokens: 0,
          cacheReadTokens: 0
        }
      };
    },
    cancel() {
      this.status = "cancelled";
    },
    close() {
      if (this.status === "idle" || this.status === "running") {
        this.status = "cancelled";
      }
    }
  };

  const result = await executeReplyTool(
    "browser_browse",
    { query: "finish and close" },
    {
      subAgentSessions: {
        manager,
        createCodeSession() {
          return null;
        },
        createBrowserSession() {
          return completedSession;
        }
      }
    },
    {
      settings: {},
      guildId: "guild-1",
      channelId: "channel-1",
      userId: "user-1",
      sourceMessageId: "msg-1",
      sourceText: "finish this",
      trace: { source: "reply_message" }
    }
  );

  assert.equal(result.isError, undefined);
  assert.equal(result.content.includes("[session_id:"), false);
  assert.match(result.content, /Finished browsing\./);
  assert.equal(manager.has(completedSession.id), false);
});

test("executeReplyTool fails music_play with empty query", async () => {
  const result = await executeReplyTool(
    "music_play",
    {},
    {
      voiceSession: {
        async musicSearch() { throw new Error("not used"); },
        async musicPlay() { throw new Error("should not be called"); },
        async videoSearch() { throw new Error("not used"); },
        async videoPlay() { throw new Error("not used"); },
        async musicQueueAdd() { throw new Error("not used"); },
        async musicQueueNext() { throw new Error("not used"); },
        async musicStop() { throw new Error("not used"); },
        async musicPause() { throw new Error("not used"); },
        async musicResume() { throw new Error("not used"); },
        async musicReplyHandoff() { throw new Error("not used"); },
        async musicSkip() { throw new Error("not used"); },
        async musicNowPlaying() { throw new Error("not used"); },
        async playSoundboard() { throw new Error("not used"); },
        async leaveVoiceChannel() { throw new Error("not used"); }
      }
    },
    {
      settings: {},
      guildId: "guild-1",
      channelId: "channel-1",
      userId: "user-1",
      sourceMessageId: "msg-1",
      sourceText: "Yo, can you play me, um... Some yeet.",
      trace: { source: "voice_turn" }
    }
  );

  assert.equal(result.isError, true);
  assert.match(result.content, /query was empty/);
});

test("executeReplyTool fails video_play with empty query", async () => {
  const result = await executeReplyTool(
    "video_play",
    {},
    {
      voiceSession: {
        async musicSearch() { throw new Error("not used"); },
        async musicPlay() { throw new Error("not used"); },
        async videoSearch() { throw new Error("not used"); },
        async videoPlay() { throw new Error("should not be called"); },
        async musicQueueAdd() { throw new Error("not used"); },
        async musicQueueNext() { throw new Error("not used"); },
        async musicStop() { throw new Error("not used"); },
        async musicPause() { throw new Error("not used"); },
        async musicResume() { throw new Error("not used"); },
        async musicReplyHandoff() { throw new Error("not used"); },
        async musicSkip() { throw new Error("not used"); },
        async musicNowPlaying() { throw new Error("not used"); },
        async playSoundboard() { throw new Error("not used"); },
        async leaveVoiceChannel() { throw new Error("not used"); }
      }
    },
    {
      settings: {},
      guildId: "guild-1",
      channelId: "channel-1",
      userId: "user-1",
      sourceMessageId: "msg-1",
      sourceText: "play some youtube video",
      trace: { source: "voice_turn" }
    }
  );

  assert.equal(result.isError, true);
  assert.match(result.content, /query was empty/);
});

test("executeReplyTool fails music_search with empty query", async () => {
  const result = await executeReplyTool(
    "music_search",
    {},
    {
      voiceSession: {
        async musicSearch() { throw new Error("should not be called"); },
        async musicPlay() { throw new Error("not used"); },
        async videoSearch() { throw new Error("not used"); },
        async videoPlay() { throw new Error("not used"); },
        async musicQueueAdd() { throw new Error("not used"); },
        async musicQueueNext() { throw new Error("not used"); },
        async musicStop() { throw new Error("not used"); },
        async musicPause() { throw new Error("not used"); },
        async musicResume() { throw new Error("not used"); },
        async musicReplyHandoff() { throw new Error("not used"); },
        async musicSkip() { throw new Error("not used"); },
        async musicNowPlaying() { throw new Error("not used"); },
        async playSoundboard() { throw new Error("not used"); },
        async leaveVoiceChannel() { throw new Error("not used"); }
      }
    },
    {
      settings: {},
      guildId: "guild-1",
      channelId: "channel-1",
      userId: "user-1",
      sourceMessageId: "msg-1",
      sourceText: "Search for Yeat",
      trace: { source: "voice_turn" }
    }
  );

  assert.equal(result.isError, true);
  assert.match(result.content, /query was empty/);
});

test("executeReplyTool delegates media_reply_handoff to the voice runtime", async () => {
  const calls: string[] = [];

  const result = await executeReplyTool(
    "media_reply_handoff",
    { mode: "duck" },
    {
      voiceSession: {
        async musicSearch() { throw new Error("not used"); },
        async musicPlay() { throw new Error("not used"); },
        async videoSearch() { throw new Error("not used"); },
        async videoPlay() { throw new Error("not used"); },
        async musicQueueAdd() { throw new Error("not used"); },
        async musicQueueNext() { throw new Error("not used"); },
        async musicStop() { throw new Error("not used"); },
        async musicPause() { throw new Error("not used"); },
        async musicResume() { throw new Error("not used"); },
        async musicReplyHandoff(mode) {
          calls.push(mode);
          return { ok: true, mode, applied: true };
        },
        async musicSkip() { throw new Error("not used"); },
        async musicNowPlaying() { throw new Error("not used"); },
        async playSoundboard() { throw new Error("not used"); },
        async leaveVoiceChannel() { throw new Error("not used"); }
      }
    },
    {
      settings: {},
      guildId: "guild-1",
      channelId: "channel-1",
      userId: "user-1",
      sourceMessageId: "msg-1",
      sourceText: "talk over the song for a second",
      trace: { source: "voice_turn" }
    }
  );

  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, ["duck"]);
  assert.match(result.content, /"mode":"duck"/);
});
