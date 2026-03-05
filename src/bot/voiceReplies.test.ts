import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  composeVoiceOperationalMessage,
  generateVoiceTurnReply
} from "./voiceReplies.ts";

function baseSettings(overrides = {}) {
  const base = {
    botName: "clanker conk",
    persona: {
      flavor: "casual",
      hardLimits: []
    },
    llm: {
      provider: "openai",
      model: "claude-haiku-4-5",
      temperature: 0.8,
      maxOutputTokens: 160
    },
    memory: {
      enabled: false
    },
    webSearch: {
      enabled: false
    },
    voice: {
      generationLlm: {
        provider: "openai",
        model: "claude-haiku-4-5"
      },
      soundboard: {
        enabled: false
      }
    }
  };

  return {
    ...base,
    ...overrides,
    persona: {
      ...base.persona,
      ...(overrides.persona || {})
    },
    llm: {
      ...base.llm,
      ...(overrides.llm || {})
    },
    memory: {
      ...base.memory,
      ...(overrides.memory || {})
    },
    webSearch: {
      ...base.webSearch,
      ...(overrides.webSearch || {})
    },
    voice: {
      ...base.voice,
      ...(overrides.voice || {}),
      generationLlm: {
        ...base.voice.generationLlm,
        ...(overrides.voice?.generationLlm || {})
      },
      soundboard: {
        ...base.voice.soundboard,
        ...(overrides.voice?.soundboard || {})
      }
    }
  };
}

function structuredVoiceOutput(overrides: {
  text?: string;
  skip?: boolean;
  reactionEmoji?: string | null;
  media?: {
    type?: string | null;
    prompt?: string | null;
  } | null;
  soundboardRefs?: string[];
  leaveVoiceChannel?: boolean;
  automationAction?: {
    operation?: string;
    title?: string | null;
    instruction?: string | null;
    schedule?: Record<string, unknown> | null;
    targetQuery?: string | null;
    automationId?: number | null;
    runImmediately?: boolean;
    targetChannelId?: string | null;
  };
  voiceIntent?: {
    intent?: string;
    confidence?: number;
    reason?: string | null;
  };
  screenShareIntent?: {
    action?: string;
    confidence?: number;
    reason?: string | null;
  };
  voiceAddressing?: {
    talkingTo?: string | null;
    directedConfidence?: number;
  };
} = {}) {
  const base = {
    text: "all good",
    skip: false,
    reactionEmoji: null,
    media: null,
    soundboardRefs: [],
    leaveVoiceChannel: false,
    automationAction: {
      operation: "none",
      title: null,
      instruction: null,
      schedule: null,
      targetQuery: null,
      automationId: null,
      runImmediately: false,
      targetChannelId: null
    },
    voiceIntent: {
      intent: "none",
      confidence: 0,
      reason: null
    },
    screenShareIntent: {
      action: "none",
      confidence: 0,
      reason: null
    },
    voiceAddressing: {
      talkingTo: null,
      directedConfidence: 0
    }
  };

  const merged = {
    ...base,
    ...overrides,
    automationAction: {
      ...base.automationAction,
      ...(overrides.automationAction || {})
    },
    voiceIntent: {
      ...base.voiceIntent,
      ...(overrides.voiceIntent || {})
    },
    screenShareIntent: {
      ...base.screenShareIntent,
      ...(overrides.screenShareIntent || {})
    },
    voiceAddressing: {
      ...base.voiceAddressing,
      ...(overrides.voiceAddressing || {})
    }
  };

  return JSON.stringify(merged);
}

function createVoiceBot({
  generationText = "all good",
  generationError = null,
  generationSequence = null,
  loadPromptMemorySlice = async () => ({
    userFacts: [],
    relevantFacts: []
  }),
  searchConfigured = true,
  openArticleRead = async (url) => ({
    title: "opened article",
    summary: `opened ${String(url || "")}`.trim(),
    extractionMethod: "fast"
  }),
  recentConversationHistory = [],
  recentLookupContext = [],
  screenShareCapability = {
    enabled: false,
    status: "disabled",
    publicUrl: ""
  },
  offerScreenShare = async () => ({ offered: true }),
  runWebSearch = async ({ webSearch, query }) => ({
    ...(webSearch || {}),
    requested: true,
    query: String(query || "").trim(),
    used: true,
    results: [
      {
        title: "sample result",
        url: "https://example.com",
        domain: "example.com",
        snippet: "sample",
        pageSummary: "sample summary"
      }
    ]
  })
} = {}) {
  const logs = [];
  const ingests = [];
  const remembers = [];
  const webSearchCalls = [];
  const openArticleCalls = [];
  const lookupMemorySearchCalls = [];
  const lookupMemoryWrites = [];
  const screenShareCalls = [];
  const generationPayloads = [];
  let generationCalls = 0;

  const guild = {
    members: {
      cache: new Map([
        [
          "user-1",
          {
            displayName: "alice",
            user: { username: "alice_user" }
          }
        ]
      ])
    }
  };

  const bot = {
    llm: {
      async generate(payload) {
        generationCalls += 1;
        generationPayloads.push(payload);
        if (generationError) throw generationError;
        if (Array.isArray(generationSequence) && generationCalls <= generationSequence.length) {
          const entry = generationSequence[generationCalls - 1];
          if (entry && typeof entry === "object" && "text" in entry) {
            return entry;
          }
          return {
            text: String(entry || "")
          };
        }
        return {
          text: generationText
        };
      }
    },
    memory: {
      async ingestMessage(payload) {
        ingests.push(payload);
      },
      async rememberDirectiveLine(payload) {
        remembers.push(payload);
      }
    },
    store: {
      logAction(entry) {
        logs.push(entry);
      }
    },
    async loadRelevantMemoryFacts() {
      return [];
    },
    buildMediaMemoryFacts() {
      return [];
    },
    async loadPromptMemorySlice(payload) {
      return await loadPromptMemorySlice(payload);
    },
    loadRecentConversationHistory() {
      return recentConversationHistory;
    },
    loadRecentLookupContext(payload) {
      lookupMemorySearchCalls.push(payload);
      return recentLookupContext;
    },
    rememberRecentLookupContext(payload) {
      lookupMemoryWrites.push(payload);
      return true;
    },
    buildWebSearchContext(settings) {
      return {
        requested: false,
        configured: true,
        enabled: Boolean(settings?.webSearch?.enabled),
        used: false,
        blockedByBudget: false,
        optedOutByUser: false,
        error: null,
        query: "",
        results: [],
        fetchedPages: 0,
        providerUsed: null,
        providerFallbackUsed: false,
        budget: {
          canSearch: true
        }
      };
    },
    async runModelRequestedWebSearch(payload) {
      webSearchCalls.push(payload);
      return await runWebSearch(payload);
    },
    getVoiceScreenShareCapability() {
      return screenShareCapability;
    },
    async offerVoiceScreenShareLink(payload) {
      screenShareCalls.push(payload);
      return await offerScreenShare(payload);
    },
    search: {
      isConfigured() {
        return Boolean(searchConfigured);
      },
      async searchAndRead({ query, settings, trace }) {
        webSearchCalls.push({ query, settings, trace });
        return {
          query: String(query || "").trim(),
          results: [
            {
              title: "sample result",
              url: "https://example.com",
              domain: "example.com",
              snippet: "sample",
              pageSummary: "sample summary"
            }
          ],
          fetchedPages: 1,
          providerUsed: "test"
        };
      },
      async readPageSummary(url, maxChars) {
        openArticleCalls.push({
          url,
          maxChars
        });
        return await openArticleRead(url, maxChars);
      }
    },
    client: {
      guilds: {
        cache: new Map([["guild-1", guild]])
      },
      users: {
        cache: new Map()
      }
    }
  };

  return {
    bot,
    logs,
    ingests,
    remembers,
    webSearchCalls,
    openArticleCalls,
    lookupMemorySearchCalls,
    lookupMemoryWrites,
    screenShareCalls,
    generationPayloads,
    getGenerationCalls() {
      return generationCalls;
    }
  };
}

test("composeVoiceOperationalMessage returns empty when llm or settings are unavailable", async () => {
  const noLlm = await composeVoiceOperationalMessage(
    {
      llm: null
    },
    {
      settings: baseSettings(),
      event: "voice_runtime"
    }
  );
  assert.equal(noLlm, "");

  const noSettings = await composeVoiceOperationalMessage(
    {
      llm: {
        async generate() {
          return { text: "hello" };
        }
      }
    },
    {
      settings: null,
      event: "voice_runtime"
    }
  );
  assert.equal(noSettings, "");
});

test("composeVoiceOperationalMessage honors [SKIP] only when allowSkip is enabled", async () => {
  const { bot } = createVoiceBot({
    generationText: "[SKIP]"
  });

  const hidden = await composeVoiceOperationalMessage(bot, {
    settings: baseSettings(),
    event: "voice_runtime",
    allowSkip: false
  });
  assert.equal(hidden, "");

  const explicitSkip = await composeVoiceOperationalMessage(bot, {
    settings: baseSettings(),
    event: "voice_runtime",
    allowSkip: true
  });
  assert.equal(explicitSkip, "[SKIP]");
});

test("composeVoiceOperationalMessage logs voice errors when llm generation throws", async () => {
  const { bot, logs } = createVoiceBot({
    generationError: new Error("llm exploded")
  });

  const text = await composeVoiceOperationalMessage(bot, {
    settings: baseSettings(),
    guildId: "guild-1",
    channelId: "text-1",
    userId: "user-1",
    messageId: "msg-1",
    event: "voice_runtime",
    reason: "join_failed"
  });

  assert.equal(text, "");
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.kind, "voice_error");
  assert.equal(String(logs[0]?.content || "").includes("voice_operational_llm_failed"), true);
});

test("composeVoiceOperationalMessage handles voice status request flow", async () => {
  const { bot, generationPayloads } = createVoiceBot({
    generationText: "yeah i'm in vc rn"
  });

  const text = await composeVoiceOperationalMessage(bot, {
    settings: baseSettings(),
    guildId: "guild-1",
    channelId: "text-1",
    userId: "user-1",
    messageId: "msg-1",
    event: "voice_status_request",
    reason: "online",
    details: {
      elapsedSeconds: 55,
      inactivitySeconds: 67,
      remainingSeconds: 1445,
      activeCaptures: 0,
      requestText: "clankie r u in vc rn?"
    }
  });

  assert.equal(text, "yeah i'm in vc rn");
  assert.equal(generationPayloads.length, 1);
});

test("generateVoiceTurnReply returns early for empty transcripts", async () => {
  const { bot, getGenerationCalls } = createVoiceBot();
  const reply = await generateVoiceTurnReply(bot, {
    settings: baseSettings(),
    guildId: "guild-1",
    channelId: "text-1",
    userId: "user-1",
    transcript: "   "
  });

  assert.deepEqual(reply, { text: "" });
  assert.equal(getGenerationCalls(), 0);
});


test("generateVoiceTurnReply parses soundboard tool-call fields and handles tool-based memory", async () => {
  const { bot } = createVoiceBot({
    generationText: structuredVoiceOutput({
      text: "bet",
      soundboardRefs: ["airhorn@123"]
    })
  });
  const reply = await generateVoiceTurnReply(bot, {
    settings: baseSettings({
      memory: {
        enabled: true
      },
      voice: {
        soundboard: {
          enabled: true
        }
      }
    }),
    guildId: "guild-1",
    channelId: "text-1",
    userId: "user-1",
    transcript: "drop the update",
    contextMessages: [
      {
        role: "user",
        content: "what happened?"
      }
    ],
    soundboardCandidates: ["airhorn@123"]
  });

  assert.equal(reply.text, "bet");
  assert.deepEqual(reply.soundboardRefs, ["airhorn@123"]);
});

test("generateVoiceTurnReply returns voice addressing annotation from model output", async () => {
  const { bot } = createVoiceBot({
    generationText: structuredVoiceOutput({
      text: "yo",
      voiceAddressing: {
        talkingTo: "assistant",
        directedConfidence: 0.91
      }
    })
  });

  const reply = await generateVoiceTurnReply(bot, {
    settings: baseSettings(),
    guildId: "guild-1",
    channelId: "text-1",
    userId: "user-1",
    transcript: "quick check"
  });

  assert.equal(reply.text, "yo");
  assert.equal(reply.voiceAddressing?.talkingTo, "assistant");
  assert.equal(reply.voiceAddressing?.directedConfidence, 0.91);
});

test("generateVoiceTurnReply preserves ordered soundboard refs from tool-call payload", async () => {
  const { bot } = createVoiceBot({
    generationText: structuredVoiceOutput({
      text: "bet",
      soundboardRefs: ["airhorn@123", "rimshot@456"]
    })
  });
  const reply = await generateVoiceTurnReply(bot, {
    settings: baseSettings({
      voice: {
        soundboard: {
          enabled: true
        }
      }
    }),
    guildId: "guild-1",
    channelId: "text-1",
    userId: "user-1",
    transcript: "drop both",
    soundboardCandidates: ["airhorn@123", "rimshot@456"]
  });

  assert.equal(reply.text, "bet");
  assert.deepEqual(reply.soundboardRefs, ["airhorn@123", "rimshot@456"]);
});

test("generateVoiceTurnReply injects recent conversation history into the prompt", async () => {
  const { bot, generationPayloads } = createVoiceBot({
    generationText: structuredVoiceOutput({
      text: "nvda was around 181"
    }),
    recentConversationHistory: [
      {
        ageMinutes: 5,
        messages: [
          {
            author_name: "alice",
            content: "what was nvda at earlier today?",
            is_bot: 0
          },
          {
            author_name: "clanker conk",
            content: "NVDA was around 181 earlier.",
            is_bot: 1
          }
        ]
      }
    ]
  });

  await generateVoiceTurnReply(bot, {
    settings: baseSettings(),
    guildId: "guild-1",
    channelId: "text-1",
    userId: "user-1",
    transcript: "what do you think about that nvidia stock price"
  });

  assert.equal(generationPayloads.length > 0, true);
  assert.equal(
    String(generationPayloads[0]?.userPrompt || "").includes("Relevant past conversation windows from shared text/voice history:"),
    true
  );
  assert.equal(
    String(generationPayloads[0]?.userPrompt || "").includes("NVDA was around 181 earlier."),
    true
  );
});

test("generateVoiceTurnReply drops soundboard refs when soundboard is disabled", async () => {
  const { bot } = createVoiceBot({
    generationText: structuredVoiceOutput({
      text: "copy that",
      soundboardRefs: ["airhorn@123"]
    })
  });
  const reply = await generateVoiceTurnReply(bot, {
    settings: baseSettings({
      voice: {
        soundboard: {
          enabled: false
        }
      }
    }),
    guildId: "guild-1",
    channelId: "text-1",
    userId: "user-1",
    transcript: "say something",
    soundboardCandidates: ["airhorn@123"]
  });

  assert.equal(reply.text, "copy that");
  assert.deepEqual(reply.soundboardRefs, []);
});

test("generateVoiceTurnReply keeps spoken text and ignores soundboard refs when disabled", async () => {
  const { bot } = createVoiceBot({
    generationText: structuredVoiceOutput({
      text: "copy that",
      soundboardRefs: ["airhorn@123"]
    })
  });
  const reply = await generateVoiceTurnReply(bot, {
    settings: baseSettings({
      voice: {
        soundboard: {
          enabled: false
        }
      }
    }),
    guildId: "guild-1",
    channelId: "text-1",
    userId: "user-1",
    transcript: "say something",
    soundboardCandidates: ["airhorn@123"]
  });

  assert.equal(reply.text, "copy that");
  assert.deepEqual(reply.soundboardRefs, []);
});

test("generateVoiceTurnReply strips selected soundboard id and name from spoken text", async () => {
  const { bot } = createVoiceBot({
    generationText: structuredVoiceOutput({
      text: "playing airhorn@123 now airhorn",
      soundboardRefs: ["airhorn@123"]
    })
  });
  const reply = await generateVoiceTurnReply(bot, {
    settings: baseSettings({
      voice: {
        soundboard: {
          enabled: true
        }
      }
    }),
    guildId: "guild-1",
    channelId: "text-1",
    userId: "user-1",
    transcript: "drop a sound",
    soundboardCandidates: ["airhorn@123 | airhorn"]
  });

  assert.equal(reply.text, "playing now");
  assert.deepEqual(reply.soundboardRefs, ["airhorn@123"]);
});

test("generateVoiceTurnReply preserves soundboard ref when scrubbed speech becomes empty", async () => {
  const { bot } = createVoiceBot({
    generationText: structuredVoiceOutput({
      text: "airhorn@123",
      soundboardRefs: ["airhorn@123"]
    })
  });
  const reply = await generateVoiceTurnReply(bot, {
    settings: baseSettings({
      voice: {
        soundboard: {
          enabled: true
        }
      }
    }),
    guildId: "guild-1",
    channelId: "text-1",
    userId: "user-1",
    transcript: "drop a sound",
    soundboardCandidates: ["airhorn@123 | airhorn"]
  });

  assert.equal(reply.text, "");
  assert.deepEqual(reply.soundboardRefs, ["airhorn@123"]);
});

test("generateVoiceTurnReply logs voice errors when generation fails", async () => {
  const { bot, logs } = createVoiceBot({
    generationError: new Error("generation failed")
  });
  const reply = await generateVoiceTurnReply(bot, {
    settings: baseSettings(),
    guildId: "guild-1",
    channelId: "text-1",
    userId: "user-1",
    transcript: "hello there"
  });

  assert.deepEqual(reply, { text: "", generationContextSnapshot: null });
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.kind, "voice_error");
  assert.equal(String(logs[0]?.content || "").includes("voice_stt_generation_failed"), true);
});

test("generateVoiceTurnReply uses voice generation llm provider/model instead of text llm provider/model", async () => {
  const { bot, generationPayloads } = createVoiceBot({
    generationText: "copy that"
  });
  await generateVoiceTurnReply(bot, {
    settings: baseSettings({
      llm: {
        provider: "openai",
        model: "claude-haiku-4-5"
      },
      voice: {
        generationLlm: {
          provider: "anthropic",
          model: "claude-haiku-4-5"
        }
      }
    }),
    guildId: "guild-1",
    channelId: "text-1",
    userId: "user-1",
    transcript: "quick status?"
  });

  assert.equal(generationPayloads.length > 0, true);
  assert.equal(generationPayloads[0]?.settings?.llm?.provider, "anthropic");
  assert.equal(generationPayloads[0]?.settings?.llm?.model, "claude-haiku-4-5");
});

test("generateVoiceTurnReply uses text llm provider/model when voice generation useTextModel is enabled", async () => {
  const { bot, generationPayloads } = createVoiceBot({
    generationText: "copy that"
  });
  await generateVoiceTurnReply(bot, {
    settings: baseSettings({
      llm: {
        provider: "claude-code",
        model: "sonnet"
      },
      voice: {
        generationLlm: {
          useTextModel: true,
          provider: "anthropic",
          model: "claude-haiku-4-5"
        }
      }
    }),
    guildId: "guild-1",
    channelId: "text-1",
    userId: "user-1",
    transcript: "quick status?"
  });

  assert.equal(generationPayloads.length > 0, true);
  assert.equal(generationPayloads[0]?.settings?.llm?.provider, "claude-code");
  assert.equal(generationPayloads[0]?.settings?.llm?.model, "sonnet");
});

test("generateVoiceTurnReply does not advertise code_task when runtime cannot execute code tasks", async () => {
  const { bot, generationPayloads } = createVoiceBot({
    generationText: structuredVoiceOutput({
      text: "all good"
    })
  });

  await generateVoiceTurnReply(bot, {
    settings: baseSettings({
      codeAgent: {
        enabled: true
      }
    }),
    guildId: "guild-1",
    channelId: "text-1",
    userId: "user-1",
    transcript: "can you patch that file?"
  });

  const firstTools = Array.isArray(generationPayloads[0]?.tools) ? generationPayloads[0].tools : [];
  const toolNames = firstTools.map((entry) => String(entry?.name || ""));
  assert.ok(!toolNames.includes("code_task"), "code_task should be excluded when runtime hook is missing");
});

test("generateVoiceTurnReply advertises code_task when runtime can execute code tasks", async () => {
  const { bot, generationPayloads } = createVoiceBot({
    generationText: structuredVoiceOutput({
      text: "all good"
    })
  });
  bot.runModelRequestedCodeTask = async () => ({ text: "done", isError: false, costUsd: 0, error: null });

  await generateVoiceTurnReply(bot, {
    settings: baseSettings({
      codeAgent: {
        enabled: true
      }
    }),
    guildId: "guild-1",
    channelId: "text-1",
    userId: "user-1",
    transcript: "can you patch that file?"
  });

  const firstTools = Array.isArray(generationPayloads[0]?.tools) ? generationPayloads[0].tools : [];
  const toolNames = firstTools.map((entry) => String(entry?.name || ""));
  assert.ok(toolNames.includes("code_task"), "code_task should be included when runtime hook exists");
});

test("generateVoiceTurnReply runs web lookup follow-up with start/complete callbacks via tool calls", async () => {
  const { bot, webSearchCalls, getGenerationCalls } = createVoiceBot({
    generationSequence: [
      {
        text: "",
        toolCalls: [
          {
            id: "tc_1",
            name: "web_search",
            input: { query: "latest rust stable version" }
          }
        ],
        rawContent: [
          { type: "text", text: "" },
          { type: "tool_use", id: "tc_1", name: "web_search", input: { query: "latest rust stable version" } }
        ]
      },
      {
        text: structuredVoiceOutput({
          text: "latest stable rust is 1.90"
        })
      }
    ]
  });

  const callbackEvents: string[] = [];
  const reply = await generateVoiceTurnReply(bot, {
    settings: baseSettings({
      webSearch: {
        enabled: true
      }
    }),
    guildId: "guild-1",
    channelId: "text-1",
    userId: "user-1",
    transcript: "what's the latest rust stable?",
    onWebLookupStart: async (payload) => {
      callbackEvents.push(`start:${String(payload?.query || "")}`);
    },
    onWebLookupComplete: async (_payload) => {
      callbackEvents.push("done");
    }
  });

  assert.equal(getGenerationCalls(), 2);
  assert.equal(webSearchCalls.length, 1);
  assert.equal(callbackEvents.length, 2);
  assert.equal(callbackEvents[0], "start:latest rust stable version");
  assert.equal(callbackEvents[1], "done");
  assert.equal(reply.text, "latest stable rust is 1.90");
  assert.equal(reply.usedWebSearchFollowup, true);
});

test("generateVoiceTurnReply fires web lookup callbacks via tool call loop", async () => {
  const eventOrder: string[] = [];
  const { bot } = createVoiceBot({
    generationSequence: [
      {
        text: "",
        toolCalls: [
          {
            id: "tc_1",
            name: "web_search",
            input: { query: "latest rust stable version" }
          }
        ],
        rawContent: [
          { type: "text", text: "" },
          { type: "tool_use", id: "tc_1", name: "web_search", input: { query: "latest rust stable version" } }
        ]
      },
      {
        text: structuredVoiceOutput({
          text: "latest stable rust is 1.90"
        })
      }
    ]
  });

  const reply = await generateVoiceTurnReply(bot, {
    settings: baseSettings({
      webSearch: {
        enabled: true
      }
    }),
    guildId: "guild-1",
    channelId: "text-1",
    userId: "user-1",
    transcript: "what's the latest rust stable?",
    onWebLookupStart: async () => {
      eventOrder.push("start");
    },
    onWebLookupComplete: async () => {
      eventOrder.push("done");
    }
  });

  assert.equal(reply.usedWebSearchFollowup, true);
  assert.equal(eventOrder.includes("start"), true);
  assert.equal(eventOrder.includes("done"), true);
});

test("generateVoiceTurnReply queries short-term lookup memory during generation", async () => {
  const { bot, lookupMemorySearchCalls } = createVoiceBot({
    generationText: "[SKIP]",
    recentLookupContext: [
      {
        query: "rust stable release date",
        provider: "brave",
        ageMinutes: 20,
        results: [
          {
            domain: "blog.rust-lang.org",
            url: "https://blog.rust-lang.org/releases/"
          }
        ]
      }
    ]
  });

  const reply = await generateVoiceTurnReply(bot, {
    settings: baseSettings(),
    guildId: "guild-1",
    channelId: "text-1",
    userId: "user-1",
    transcript: "what source did you use before?"
  });

  assert.equal(reply.text, "");
  assert.equal(lookupMemorySearchCalls.length, 1);
});

test("generateVoiceTurnReply handles open_article tool call", async () => {
  const { bot, getGenerationCalls } = createVoiceBot({
    generationSequence: [
      {
        text: "",
        toolCalls: [
          {
            id: "tc_1",
            name: "open_article",
            input: { ref: "first" }
          }
        ],
        rawContent: [
          { type: "text", text: "" },
          { type: "tool_use", id: "tc_1", name: "open_article", input: { ref: "first" } }
        ]
      },
      {
        text: structuredVoiceOutput({
          text: "here's what it says"
        })
      }
    ],
    recentLookupContext: [
      {
        query: "top news today",
        provider: "brave",
        ageMinutes: 1,
        results: [
          {
            title: "example headline",
            url: "https://example.com/news-1",
            domain: "example.com"
          }
        ]
      }
    ]
  });

  const reply = await generateVoiceTurnReply(bot, {
    settings: baseSettings(),
    guildId: "guild-1",
    channelId: "text-1",
    userId: "user-1",
    transcript: "open that first article"
  });

  assert.equal(getGenerationCalls(), 2);
  assert.equal(reply.text, "here's what it says");
  assert.equal(reply.usedOpenArticleFollowup, true);
});

test("generateVoiceTurnReply does not block on unresolved memory lookup", async () => {
  const { bot } = createVoiceBot({
    generationText: structuredVoiceOutput({
      text: "quick reply"
    }),
    loadPromptMemorySlice: async () => await new Promise(() => undefined)
  });

  const completed = await Promise.race([
    generateVoiceTurnReply(bot, {
      settings: baseSettings({
        memory: {
          enabled: true
        }
      }),
      guildId: "guild-1",
      channelId: "text-1",
      userId: "user-1",
      transcript: "what do you remember?"
    }).then((reply) => String(reply?.text || "")),
    new Promise<string>((resolve) => setTimeout(() => resolve("__timeout__"), 350))
  ]);

  assert.equal(completed, "quick reply");
});

test("generateVoiceTurnReply fetches fresh memory context each turn", async () => {
  let memoryLoadCalls = 0;
  const { bot, generationPayloads } = createVoiceBot({
    generationSequence: [
      structuredVoiceOutput({
        text: "first pass"
      }),
      structuredVoiceOutput({
        text: "second pass"
      })
    ],
    loadPromptMemorySlice: async () => {
      memoryLoadCalls += 1;
      if (memoryLoadCalls === 1) {
        return {
          userFacts: [{ subject: "author", fact: "likes ramen" }],
          relevantFacts: []
        };
      }
      return await new Promise(() => undefined);
    }
  });

  await generateVoiceTurnReply(bot, {
    settings: baseSettings({
      memory: {
        enabled: true
      }
    }),
    sessionId: "voice-session-1",
    guildId: "guild-1",
    channelId: "text-1",
    userId: "user-1",
    transcript: "anything i like?"
  });

  const secondReply = await Promise.race([
    generateVoiceTurnReply(bot, {
      settings: baseSettings({
        memory: {
          enabled: true
        }
      }),
      sessionId: "voice-session-1",
      guildId: "guild-1",
      channelId: "text-1",
      userId: "user-1",
      transcript: "and now?"
    }),
    new Promise<{ text: string }>((resolve) => setTimeout(() => resolve({ text: "__timeout__" }), 350))
  ]);

  assert.equal(String(secondReply?.text || ""), "second pass");
  const firstPrompt = String(generationPayloads[0]?.userPrompt || "");
  const secondPrompt = String(generationPayloads[1]?.userPrompt || "");
  assert.equal(memoryLoadCalls, 2);
  assert.equal(firstPrompt.toLowerCase().includes("likes ramen"), true);
  assert.equal(secondPrompt.toLowerCase().includes("likes ramen"), false);
});

test("generateVoiceTurnReply triggers voice screen-share link offer from tool-call field", async () => {
  const { bot, screenShareCalls } = createVoiceBot({
    generationText: structuredVoiceOutput({
      text: "i can check it",
      screenShareIntent: {
        action: "offer_link",
        confidence: 0.93,
        reason: "needs visual context"
      }
    }),
    screenShareCapability: {
      enabled: true,
      available: true,
      status: "ready",
      publicUrl: "https://fancy-cat.trycloudflare.com"
    },
    offerScreenShare: async () => ({ offered: true })
  });

  const reply = await generateVoiceTurnReply(bot, {
    settings: baseSettings(),
    guildId: "guild-1",
    channelId: "text-1",
    userId: "user-1",
    transcript: "can you look at my screen?"
  });

  assert.equal(reply.text, "i can check it");
  assert.equal(reply.usedScreenShareOffer, true);
  assert.equal(screenShareCalls.length, 1);
  assert.equal(screenShareCalls[0]?.guildId, "guild-1");
  assert.equal(screenShareCalls[0]?.channelId, "text-1");
  assert.equal(screenShareCalls[0]?.requesterUserId, "user-1");
});

test("generateVoiceTurnReply describes supported-but-unavailable screen-share capability in prompt", async () => {
  const { bot, generationPayloads, screenShareCalls } = createVoiceBot({
    generationText: structuredVoiceOutput({
      text: "can't pull it up rn"
    }),
    screenShareCapability: {
      supported: true,
      enabled: true,
      available: false,
      status: "starting",
      publicUrl: "https://fancy-cat.trycloudflare.com",
      reason: "public_https_starting"
    }
  });

  const reply = await generateVoiceTurnReply(bot, {
    settings: baseSettings(),
    guildId: "guild-1",
    channelId: "text-1",
    userId: "user-1",
    transcript: "can you watch my screen right now?"
  });

  assert.equal(reply.text, "can't pull it up rn");
  assert.equal(screenShareCalls.length, 0);
  const userPrompt = String(generationPayloads[0]?.userPrompt || "");
  assert.equal(
    userPrompt.includes("VC screen-share link capability exists but is currently unavailable (reason: public_https_starting)."),
    true
  );
  assert.equal(userPrompt.includes("Set screenShareIntent.action=none."), true);
});

test("generateVoiceTurnReply returns leave request when model sets leaveVoiceChannel", async () => {
  const { bot } = createVoiceBot({
    generationText: structuredVoiceOutput({
      text: "aight i'ma bounce",
      leaveVoiceChannel: true
    })
  });

  const reply = await generateVoiceTurnReply(bot, {
    settings: baseSettings(),
    guildId: "guild-1",
    channelId: "text-1",
    userId: "user-1",
    transcript: "you good to keep chilling?"
  });

  assert.equal(reply.text, "aight i'ma bounce");
  assert.equal(reply.leaveVoiceChannelRequested, true);
});
