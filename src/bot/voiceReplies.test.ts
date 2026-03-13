import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  getResolvedOrchestratorBinding
} from "../settings/agentStack.ts";
import {
  composeVoiceOperationalMessage,
  generateVoiceTurnReply
} from "./voiceReplies.ts";
import {
  ACTIVE_MUSIC_REPLY_CONTEXT_LINE,
  MUSIC_REPLY_HANDOFF_POLICY_LINE
} from "../prompts/voiceLivePolicy.ts";
import { createTestSettings } from "../testSettings.ts";
import { createAbortError } from "../tools/browserTaskRuntime.ts";
import { deepMerge } from "../utils.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function countOccurrences(haystack: string, needle: string) {
  if (!needle) return 0;
  return haystack.split(needle).length - 1;
}

function baseSettings(overrides = {}) {
  const raw = isRecord(overrides) ? overrides : {};
  const llm = isRecord(raw.llm) ? raw.llm : {};
  const memory = isRecord(raw.memory) ? raw.memory : {};
  const webSearch = isRecord(raw.webSearch) ? raw.webSearch : {};
  const voice = isRecord(raw.voice) ? raw.voice : {};
  const generationLlm = isRecord(voice.generationLlm) ? voice.generationLlm : {};
  const soundboard = isRecord(voice.soundboard) ? voice.soundboard : {};
  const codeAgent = isRecord(raw.codeAgent) ? raw.codeAgent : {};
  const codeAgentProvider = String(codeAgent.provider || "").trim().toLowerCase();

  const base = {
    identity: {
      botName: "clanker conk"
    },
    persona: {
      flavor: "casual",
      hardLimits: []
    },
    agentStack: {
      overrides: {
        orchestrator: {
          provider: "openai",
          model: "claude-haiku-4-5"
        }
      },
      runtimeConfig: {
        research: {
          enabled: false
        },
        voice: {
          generation: {
            mode: "dedicated_model",
            model: {
              provider: "openai",
              model: "claude-haiku-4-5"
            }
          }
        }
      }
    },
    interaction: {
      replyGeneration: {
        temperature: 0.8,
        maxOutputTokens: 160
      }
    },
    memory: {
      enabled: false
    },
    permissions: {
      devTasks: {
        allowedUserIds: []
      }
    },
    voice: {
      conversationPolicy: {
        streaming: {
          enabled: true,
          minSentencesPerChunk: 2,
          eagerFirstChunkChars: 30,
          maxBufferChars: 300
        }
      },
      soundboard: {
        enabled: false
      }
    }
  };

  return createTestSettings(deepMerge(base, {
    identity: {
      botName: String(raw.botName || base.identity.botName)
    },
    persona: isRecord(raw.persona) ? raw.persona : {},
    interaction: {
      replyGeneration: {
        temperature: llm.temperature,
        maxOutputTokens: llm.maxOutputTokens
      }
    },
    memory: {
      enabled: memory.enabled
    },
    permissions: {
      devTasks: {
        allowedUserIds: codeAgent.allowedUserIds
      }
    },
    agentStack: {
      overrides: {
        orchestrator: {
          provider: llm.provider,
          model: llm.model
        }
      },
      runtimeConfig: {
        research: {
          enabled: webSearch.enabled
        },
        voice: {
          generation:
            generationLlm.useTextModel
              ? { mode: "inherit_orchestrator" }
              : {
                  mode: "dedicated_model",
                  model: {
                    provider: generationLlm.provider,
                    model: generationLlm.model
                  }
                }
        },
        devTeam: {
          codex: {
            enabled: codeAgentProvider === "codex"
          },
          codexCli: {
            enabled: codeAgentProvider === "codex-cli" || codeAgentProvider === "auto"
          },
          claudeCode: {
            enabled: codeAgentProvider === "claude-code" || codeAgentProvider === "auto"
          }
        }
      }
    },
    voice: {
      conversationPolicy: {
        streaming: {
          enabled: voice.streamingEnabled,
          minSentencesPerChunk: voice.streamingMinSentencesPerChunk,
          eagerFirstChunkChars: voice.streamingEagerFirstChunkChars,
          maxBufferChars: voice.streamingMaxBufferChars
        }
      },
      soundboard
    }
  }));
}

function structuredVoiceOutput(overrides: {
  text?: string;
  skip?: boolean;
} = {}) {
  if (overrides.skip) return "[SKIP]";
  return String(overrides.text || "all good");
}

function createVoiceBot({
  generationText = "all good",
  generationError = null,
  generationSequence = null,
  loadFactProfile = () => ({
    userFacts: [],
    relevantFacts: []
  }),
  searchConfigured = true,
  webScrapeRead = async (url) => ({
    title: "scraped article",
    summary: `scraped ${String(url || "")}`.trim(),
    extractionMethod: "fast"
  }),
  recentConversationHistory = [],
  webSearchOverride = null as { results: unknown[]; query: string } | null,
  screenShareCapability = {
    enabled: false,
    status: "disabled",
    publicUrl: ""
  },
  activeVoiceSession = null,
  musicDisambiguation = null,
  offerScreenShare = async () => ({ started: true }),
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
  const webScrapeCalls = [];
  const screenShareCalls = [];
  const browserBrowseCalls = [];
  const requestPlayMusicCalls = [];
  const requestStopMusicCalls = [];
  const requestPauseMusicCalls = [];
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
      },
      async generateStreaming(payload) {
        generationCalls += 1;
        generationPayloads.push(payload);
        if (generationError) throw generationError;
        const entry =
          Array.isArray(generationSequence) && generationCalls <= generationSequence.length
            ? generationSequence[generationCalls - 1]
            : { text: generationText };
        if (entry && typeof entry === "object" && "text" in entry) {
          const deltas = Array.isArray(entry.textDeltas)
            ? entry.textDeltas
            : [String(entry.text || "")];
          for (const delta of deltas) {
            payload.onTextDelta?.(String(delta || ""));
          }
          return entry;
        }
        const text = String(entry || "");
        payload.onTextDelta?.(text);
        return {
          text
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
    loadFactProfile(payload) {
      return loadFactProfile(payload);
    },
    loadRecentConversationHistory() {
      return recentConversationHistory;
    },
    buildWebSearchContext(settings) {
      return {
        requested: false,
        configured: true,
        enabled: Boolean(settings?.webSearch?.enabled),
        used: Boolean(webSearchOverride?.results?.length),
        blockedByBudget: false,
        optedOutByUser: false,
        error: null,
        query: webSearchOverride?.query || "",
        results: webSearchOverride?.results || [],
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
    getVoiceScreenWatchCapability() {
      return screenShareCapability;
    },
    async startVoiceScreenWatch(payload) {
      screenShareCalls.push(payload);
      return await offerScreenShare(payload);
    },
    buildSubAgentSessionsRuntime() {
      return {
        manager: {
          get() {
            return null;
          },
          register() {},
          remove() {}
        },
        createCodeSession() {
          return null;
        },
        createBrowserSession() {
          return null;
        }
      };
    },
    async runModelRequestedBrowserBrowse(payload) {
      browserBrowseCalls.push(payload);
      return {
        requested: true,
        configured: true,
        enabled: true,
        used: true,
        blockedByBudget: false,
        error: null,
        query: String(payload?.query || "").trim(),
        text: "",
        imageInputs: [],
        steps: 0,
        hitStepLimit: false
      };
    },
    voiceSessionManager: activeVoiceSession || musicDisambiguation ? {
      getSessionById(sessionId) {
        return sessionId ? activeVoiceSession : null;
      },
      getMusicPromptContext() {
        return null;
      },
      getMusicDisambiguationPromptContext() {
        return musicDisambiguation;
      },
      async requestPlayMusic(payload = {}) {
        requestPlayMusicCalls.push(payload);
        return true;
      },
      async requestStopMusic(payload = {}) {
        requestStopMusicCalls.push(payload);
        return true;
      },
      async requestPauseMusic(payload = {}) {
        requestPauseMusicCalls.push(payload);
        return true;
      }
    } : null,

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
        webScrapeCalls.push({
          url,
          maxChars
        });
        return await webScrapeRead(url, maxChars);
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
    webScrapeCalls,
    screenShareCalls,
    browserBrowseCalls,
    requestPlayMusicCalls,
    requestStopMusicCalls,
    requestPauseMusicCalls,
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

test("generateVoiceTurnReply voice prompt warns against reading long links aloud", async () => {
  const { bot, generationPayloads } = createVoiceBot({
    generationText: structuredVoiceOutput({
      text: "open the link i sent"
    })
  });

  const reply = await generateVoiceTurnReply(bot, {
    settings: baseSettings(),
    guildId: "guild-1",
    channelId: "text-1",
    userId: "user-1",
    transcript: "can you send me the screen share link?"
  });

  assert.equal(reply.text, "open the link i sent");
  assert.equal(generationPayloads.length > 0, true);
  const systemPrompt = String(generationPayloads[0]?.systemPrompt || "");
  assert.equal(systemPrompt.includes("optimize for how it sounds out loud"), true);
  assert.equal(
    systemPrompt.includes("Do not read long URLs, invite links, screen-share links, IDs, hashes, or access tokens aloud"),
    true
  );
  assert.equal(
    systemPrompt.includes("refer to it naturally"),
    true
  );
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

test("generateVoiceTurnReply passes abort signal into llm generation", async () => {
  const { bot, generationPayloads } = createVoiceBot({
    generationText: structuredVoiceOutput({
      text: "all good"
    })
  });
  const controller = new AbortController();

  await generateVoiceTurnReply(bot, {
    settings: baseSettings(),
    guildId: "guild-1",
    channelId: "text-1",
    userId: "user-1",
    transcript: "play something",
    signal: controller.signal
  });

  assert.equal(generationPayloads.length, 1);
  assert.equal(generationPayloads[0]?.signal, controller.signal);
});

test("generateVoiceTurnReply forwards the latest screen-share frame into the model on normal turns", async () => {
  const { bot, generationPayloads } = createVoiceBot({
    generationText: structuredVoiceOutput({
      text: "i can see the error banner"
    })
  });

  await generateVoiceTurnReply(bot, {
    settings: baseSettings(),
    guildId: "guild-1",
    channelId: "text-1",
    userId: "user-1",
    transcript: "what error is that",
    streamWatchLatestFrame: {
      mimeType: "image/png",
      dataBase64: "AAAA"
    }
  });

  assert.equal(generationPayloads.length, 1);
  assert.deepEqual(generationPayloads[0]?.imageInputs, [
    {
      mediaType: "image/png",
      dataBase64: "AAAA"
    }
  ]);
});

test("generateVoiceTurnReply waits for the configured minimum sentences before streaming a chunk", async () => {
  const streamed: string[] = [];
  const { bot } = createVoiceBot({
    generationSequence: [
      {
        text: "this is the first sentence. second sentence.",
        textDeltas: ["this is the first sentence. ", "second sentence."]
      }
    ]
  });

  const reply = await generateVoiceTurnReply(bot, {
    settings: baseSettings({
      voice: {
        streamingEnabled: true,
        streamingMinSentencesPerChunk: 2,
        streamingEagerFirstChunkChars: 10,
        streamingMaxBufferChars: 120
      }
    }),
    guildId: "guild-1",
    channelId: "text-1",
    userId: "user-1",
    transcript: "say it cleanly",
    onSpokenSentence: ({ text }) => {
      streamed.push(text);
    }
  });

  assert.deepEqual(streamed, ["this is the first sentence. second sentence."]);
  assert.equal(reply.text, "this is the first sentence. second sentence.");
  assert.equal(reply.streamedSentenceCount, 1);
});

test("generateVoiceTurnReply keeps the first streamed chunk intact until punctuation arrives", async () => {
  const streamed: string[] = [];
  const { bot } = createVoiceBot({
    generationSequence: [
      {
        text: "yo vuhlp, what's good right now",
        textDeltas: ["yo vuhlp, what's good ", "right now"]
      }
    ]
  });

  const reply = await generateVoiceTurnReply(bot, {
    settings: baseSettings({
      voice: {
        streamingEnabled: true,
        streamingEagerFirstChunkChars: 16,
        streamingMaxBufferChars: 120
      }
    }),
    guildId: "guild-1",
    channelId: "text-1",
    userId: "user-1",
    transcript: "say it fast",
    onSpokenSentence: ({ text }) => {
      streamed.push(text);
    }
  });

  assert.deepEqual(streamed, ["yo vuhlp, what's good right now"]);
  assert.equal(reply.text, "yo vuhlp, what's good right now");
  assert.equal(reply.streamedSentenceCount, 1);
});

test("generateVoiceTurnReply preserves inline soundboard directives for streamed playback sequencing", async () => {
  const streamed: string[] = [];
  const { bot } = createVoiceBot({
    generationSequence: [
      {
        text: "yo [[SOUNDBOARD:airhorn@123]] done",
        textDeltas: ["yo [[SOUNDBOARD:airhorn@123]] done"]
      }
    ]
  });

  const reply = await generateVoiceTurnReply(bot, {
    settings: baseSettings({
      voice: {
        streamingEnabled: true,
        streamingEagerFirstChunkChars: 10,
        streamingMaxBufferChars: 120,
        soundboard: {
          enabled: true
        }
      }
    }),
    guildId: "guild-1",
    channelId: "text-1",
    userId: "user-1",
    transcript: "hit the airhorn",
    soundboardCandidates: ["airhorn@123"],
    onSpokenSentence: async ({ text }) => {
      streamed.push(text);
      return {
        accepted: true,
        playedSoundboardRefs: ["airhorn@123"],
        requestedRealtimeUtterance: true
      };
    }
  });

  assert.deepEqual(streamed, ["yo [[SOUNDBOARD:airhorn@123]] done"]);
  assert.equal(reply.text, "yo [[SOUNDBOARD:airhorn@123]] done");
  assert.deepEqual(reply.playedSoundboardRefs, ["airhorn@123"]);
  assert.equal(reply.streamedSentenceCount, 1);
  assert.equal(reply.streamedRequestedRealtimeUtterance, true);
});

test("generateVoiceTurnReply strips a leading reply-addressing directive from non-streaming speech", async () => {
  const { bot } = createVoiceBot({
    generationSequence: [
      {
        text: "[[TO:ALL]] alright everybody, lock in"
      }
    ]
  });

  const reply = await generateVoiceTurnReply(bot, {
    settings: baseSettings(),
    guildId: "guild-1",
    channelId: "text-1",
    userId: "user-1",
    transcript: "say it to the whole room"
  });

  assert.equal(reply.text, "alright everybody, lock in");
  assert.equal(reply.voiceAddressing?.talkingTo, "ALL");
});

test("generateVoiceTurnReply parses a leading reply-addressing directive before streaming speech dispatch", async () => {
  const streamed: string[] = [];
  const streamedTargets: Array<string | null> = [];
  const { bot } = createVoiceBot({
    generationSequence: [
      {
        text: "[[TO:SPEAKER]] nah, the other one",
        textDeltas: ["[[TO:SPEAKER]] nah, ", "the other one"]
      }
    ]
  });

  const reply = await generateVoiceTurnReply(bot, {
    settings: baseSettings({
      voice: {
        streamingEnabled: true,
        streamingEagerFirstChunkChars: 12,
        streamingMaxBufferChars: 120
      }
    }),
    guildId: "guild-1",
    channelId: "text-1",
    userId: "user-1",
    transcript: "correct that",
    onSpokenSentence: ({ text, voiceAddressing }) => {
      streamed.push(text);
      streamedTargets.push(voiceAddressing?.talkingTo || null);
    }
  });

  assert.deepEqual(streamed, ["nah, the other one"]);
  assert.deepEqual(streamedTargets, ["alice"]);
  assert.equal(reply.text, "nah, the other one");
  assert.equal(reply.voiceAddressing?.talkingTo, "alice");
});

test("generateVoiceTurnReply preserves spoken text across tool-loop turns", async () => {
  const { bot } = createVoiceBot({
    generationSequence: [
      {
        text: "let me check that.",
        toolCalls: [
          {
            id: "tc_1",
            name: "web_search",
            input: { query: "nintendo ds release year" }
          }
        ],
        rawContent: [
          { type: "text", text: "let me check that." },
          { type: "tool_use", id: "tc_1", name: "web_search", input: { query: "nintendo ds release year" } }
        ]
      },
      {
        text: "it shipped in 2004."
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
    transcript: "when did the ds come out?"
  });

  assert.equal(reply.usedWebSearchFollowup, true);
  assert.equal(reply.text, "let me check that.\nit shipped in 2004.");
});

test("generateVoiceTurnReply handles note_context continuation based on whether spoken text already exists", async () => {
  const cases = [
    {
      name: "continues_without_spoken_text",
      sessionId: "voice-session-1",
      initialContext: [
        {
          text: "Existing plan",
          category: "plan",
          at: 1
        }
      ],
      generationSequence: [
        {
          text: "",
          toolCalls: [
            {
              id: "tc_1",
              name: "note_context",
              input: {
                text: "Alice prefers concise answers",
                category: "preference"
              }
            },
            {
              id: "tc_2",
              name: "note_context",
              input: {
                text: "alice prefers concise answers",
                category: "fact"
              }
            }
          ],
          rawContent: [
            { type: "tool_use", id: "tc_1", name: "note_context", input: { text: "Alice prefers concise answers", category: "preference" } },
            { type: "tool_use", id: "tc_2", name: "note_context", input: { text: "alice prefers concise answers", category: "fact" } }
          ]
        },
        {
          text: "noted"
        }
      ],
      transcript: "keep it short later too",
      expectedGenerationCalls: 2,
      expectedText: "noted",
      expectedContextText: "alice prefers concise answers",
      expectedContextLength: 2
    },
    {
      name: "stops_after_first_pass_when_spoken_text_exists",
      sessionId: "voice-session-2",
      initialContext: [],
      generationSequence: [
        {
          text: "noted",
          toolCalls: [
            {
              id: "tc_1",
              name: "note_context",
              input: {
                text: "Alice prefers concise answers",
                category: "preference"
              }
            }
          ],
          rawContent: [
            { type: "text", text: "noted" },
            {
              type: "tool_use",
              id: "tc_1",
              name: "note_context",
              input: { text: "Alice prefers concise answers", category: "preference" }
            }
          ]
        }
      ],
      transcript: "remember this",
      expectedGenerationCalls: 1,
      expectedText: "noted",
      expectedContextText: "Alice prefers concise answers",
      expectedContextLength: 1
    }
  ];

  for (const row of cases) {
    const session = {
      id: row.sessionId,
      durableContext: [...row.initialContext]
    };
    const { bot, getGenerationCalls } = createVoiceBot({
      generationSequence: row.generationSequence
    });
    bot.voiceSessionManager = {
      getSessionById(sessionId: string) {
        return sessionId === row.sessionId ? session : null;
      }
    };

    const reply = await generateVoiceTurnReply(bot, {
      settings: baseSettings(),
      sessionId: row.sessionId,
      guildId: "guild-1",
      channelId: "text-1",
      userId: "user-1",
      transcript: row.transcript,
      voiceToolCallbacks: {}
    });

    assert.equal(reply.text, row.expectedText, row.name);
    assert.equal(getGenerationCalls(), row.expectedGenerationCalls, row.name);
    assert.equal(session.durableContext.length, row.expectedContextLength, row.name);
    assert.equal(session.durableContext.at(-1)?.text, row.expectedContextText, row.name);
  }
});

test("generateVoiceTurnReply handles representative soundboard permutations", async () => {
  const cases = [
    {
      name: "disabled",
      buildBot: () =>
        createVoiceBot({
          generationText: structuredVoiceOutput({
            text: "copy that"
          })
        }),
      settings: baseSettings({
        voice: {
          soundboard: {
            enabled: false
          }
        }
      }),
      transcript: "say something",
      soundboardCandidates: ["airhorn@123"],
      expectedText: "copy that",
      expectedPlayedRefs: [],
      assertTools(generationPayloads) {
        const toolNames = (Array.isArray(generationPayloads[0]?.tools) ? generationPayloads[0].tools : [])
          .map((entry) => String(entry?.name || ""));
        assert.equal(toolNames.includes("play_soundboard"), false);
      }
    },
    {
      name: "speech_plus_soundboard",
      buildBot: () =>
        createVoiceBot({
          generationSequence: [
            {
              text: "playing it now",
              toolCalls: [
                {
                  id: "tc_1",
                  name: "play_soundboard",
                  input: { refs: ["airhorn@123", "rimshot@456"] }
                }
              ],
              rawContent: [
                { type: "text", text: "playing it now" },
                {
                  type: "tool_use",
                  id: "tc_1",
                  name: "play_soundboard",
                  input: { refs: ["airhorn@123", "rimshot@456"] }
                }
              ]
            },
            {
              text: ""
            }
          ]
        }),
      settings: baseSettings({
        voice: {
          soundboard: {
            enabled: true
          }
        }
      }),
      transcript: "drop both",
      soundboardCandidates: ["airhorn@123", "rimshot@456"],
      expectedText: "playing it now",
      expectedPlayedRefs: ["airhorn@123", "rimshot@456"]
    },
    {
      name: "soundboard_only",
      buildBot: () =>
        createVoiceBot({
          generationSequence: [
            {
              text: "",
              toolCalls: [
                {
                  id: "tc_1",
                  name: "play_soundboard",
                  input: { refs: ["airhorn@123"] }
                }
              ],
              rawContent: [
                { type: "tool_use", id: "tc_1", name: "play_soundboard", input: { refs: ["airhorn@123"] } }
              ]
            },
            {
              text: ""
            }
          ]
        }),
      settings: baseSettings({
        voice: {
          soundboard: {
            enabled: true
          }
        }
      }),
      transcript: "drop a sound",
      soundboardCandidates: ["airhorn@123 | airhorn"],
      expectedText: "",
      expectedPlayedRefs: ["airhorn@123"]
    }
  ];

  for (const row of cases) {
    const { bot, generationPayloads } = row.buildBot();
    const reply = await generateVoiceTurnReply(bot, {
      settings: row.settings,
      guildId: "guild-1",
      channelId: "text-1",
      userId: "user-1",
      transcript: row.transcript,
      soundboardCandidates: row.soundboardCandidates,
      voiceToolCallbacks: {
        playSoundboard: async (refs) => ({ ok: true, played: refs }),
        setScreenNote: async (note) => ({ ok: true, note }),
        setScreenMoment: async (moment) => ({ ok: true, moment }),
        leaveVoiceChannel: async () => ({ ok: true })
      }
    });

    assert.equal(reply.text, row.expectedText, row.name);
    assert.deepEqual(reply.playedSoundboardRefs || [], row.expectedPlayedRefs, row.name);
    row.assertTools?.(generationPayloads);
  }
});

test("generateVoiceTurnReply leaves assistant reply targeting unset when the hidden audience prefix is missing", async () => {
  const { bot, getGenerationCalls } = createVoiceBot({
    generationSequence: [
      {
        text: "yo"
      }
    ]
  });

  const reply = await generateVoiceTurnReply(bot, {
    settings: baseSettings(),
    guildId: "guild-1",
    channelId: "text-1",
    userId: "user-1",
    transcript: "quick check",
    directAddressed: true
  });

  assert.equal(reply.text, "yo");
  assert.equal(reply.voiceAddressing, null);
  assert.equal(getGenerationCalls(), 1);
});

test("generateVoiceTurnReply screen_note continuation depends on whether the first pass already yielded spoken output", async () => {
  const cases = [
    {
      name: "accepted_streamed_speech_stops_continuation",
      generationSequence: [
        {
          text: "",
          textDeltas: ["yo vuhlp, what's good "],
          toolCalls: [
            {
              id: "tc_1",
              name: "screen_note",
              input: {
                note: "health bar flashing red"
              }
            }
          ],
          rawContent: [
            {
              type: "tool_use",
              id: "tc_1",
              name: "screen_note",
              input: { note: "health bar flashing red" }
            }
          ]
        }
      ],
      settings: baseSettings({
        voice: {
          streamingEnabled: true,
          streamingEagerFirstChunkChars: 16,
          streamingMaxBufferChars: 120
        }
      }),
      onSpokenSentence: ({ text }) => text,
      expectedText: "yo vuhlp, what's good",
      expectedGenerationCalls: 1
    },
    {
      name: "rejected_streamed_speech_continues",
      generationSequence: [
        {
          text: "",
          textDeltas: ["yo vuhlp, what's good "],
          toolCalls: [
            {
              id: "tc_1",
              name: "screen_note",
              input: {
                note: "health bar flashing red"
              }
            }
          ],
          rawContent: [
            {
              type: "tool_use",
              id: "tc_1",
              name: "screen_note",
              input: { note: "health bar flashing red" }
            }
          ]
        },
        {
          text: "yo"
        }
      ],
      settings: baseSettings({
        voice: {
          streamingEnabled: true,
          streamingEagerFirstChunkChars: 16,
          streamingMaxBufferChars: 120
        }
      }),
      onSpokenSentence: () => false,
      expectedText: "yo",
      expectedGenerationCalls: 2
    },
    {
      name: "no_first_pass_speech_continues",
      generationSequence: [
        {
          text: "",
          toolCalls: [
            {
              id: "tc_1",
              name: "screen_note",
              input: {
                note: "health bar flashing red"
              }
            }
          ],
          rawContent: [
            {
              type: "tool_use",
              id: "tc_1",
              name: "screen_note",
              input: { note: "health bar flashing red" }
            }
          ]
        },
        {
          text: "yo"
        }
      ],
      settings: baseSettings(),
      onSpokenSentence: null,
      expectedText: "yo",
      expectedGenerationCalls: 2
    }
  ];

  for (const row of cases) {
    const streamed: string[] = [];
    const { bot, getGenerationCalls } = createVoiceBot({
      generationSequence: row.generationSequence
    });

    const reply = await generateVoiceTurnReply(bot, {
      settings: row.settings,
      guildId: "guild-1",
      channelId: "text-1",
      userId: "user-1",
      transcript: "quick check",
      onSpokenSentence: row.onSpokenSentence
        ? ({ text }) => {
            const result = row.onSpokenSentence({ text });
            if (result) {
              streamed.push(String(text));
              return true;
            }
            return false;
          }
        : undefined,
      voiceToolCallbacks: {
        playSoundboard: async (refs) => ({ ok: true, played: refs }),
        setScreenNote: async (note) => ({ ok: true, note }),
        setScreenMoment: async (moment) => ({ ok: true, moment }),
        leaveVoiceChannel: async () => ({ ok: true })
      }
    });

    assert.equal(reply.text, row.expectedText, row.name);
    assert.equal(reply.screenNote, "health bar flashing red", row.name);
    assert.equal(getGenerationCalls(), row.expectedGenerationCalls, row.name);
    if (row.name === "accepted_streamed_speech_stops_continuation") {
      assert.deepEqual(streamed, ["yo vuhlp, what's good"]);
    }
  }
});

test("generateVoiceTurnReply includes all tool results when a continuation-required tool is mixed with a side-effect tool", async () => {
  const { bot, generationPayloads, getGenerationCalls } = createVoiceBot({
    generationSequence: [
      {
        text: "checking now",
        toolCalls: [
          {
            id: "tc_1",
            name: "screen_note",
            input: {
              note: "health bar flashing red"
            }
          },
          {
            id: "tc_2",
            name: "web_search",
            input: {
              query: "latest rust stable version"
            }
          }
        ],
        rawContent: [
          { type: "text", text: "checking now" },
          {
            type: "tool_use",
            id: "tc_1",
            name: "screen_note",
            input: { note: "health bar flashing red" }
          },
          {
            type: "tool_use",
            id: "tc_2",
            name: "web_search",
            input: { query: "latest rust stable version" }
          }
        ]
      },
      {
        text: "latest stable rust is 1.90"
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
    transcript: "check rust",
    voiceToolCallbacks: {
      playSoundboard: async (refs) => ({ ok: true, played: refs }),
      setScreenNote: async (note) => ({ ok: true, note }),
      setScreenMoment: async (moment) => ({ ok: true, moment }),
      leaveVoiceChannel: async () => ({ ok: true })
    }
  });

  const secondCallMessages = Array.isArray(generationPayloads[1]?.contextMessages)
    ? generationPayloads[1].contextMessages
    : [];
  const toolResultMessage = secondCallMessages[secondCallMessages.length - 1];
  const toolResults = Array.isArray(toolResultMessage?.content) ? toolResultMessage.content : [];

  assert.equal(reply.text, "checking now\nlatest stable rust is 1.90");
  assert.equal(reply.screenNote, "health bar flashing red");
  assert.equal(getGenerationCalls(), 2);
  assert.deepEqual(
    toolResults.map((entry) => entry?.tool_use_id),
    ["tc_1", "tc_2"]
  );
});

test("generateVoiceTurnReply marks music disambiguation tool followups as replay-safe on the in-flight turn", async () => {
  const activeVoiceSession = {
    id: "voice-session-tool-recovery-safe",
    durableContext: [],
    inFlightAcceptedBrainTurn: {
      transcript: "play some minecraft music",
      userId: "user-1",
      pcmBuffer: null,
      source: "realtime",
      acceptedAt: Date.now(),
      phase: "generation_only",
      captureReason: "stream_end",
      directAddressed: true,
      toolPhaseRecoveryEligible: false,
      toolPhaseRecoveryReason: null,
      toolPhaseLastToolName: null
    }
  };
  const { bot } = createVoiceBot({
    activeVoiceSession
  });
  let generationCalls = 0;
  const runGeneration = async (payload) => {
    generationCalls += 1;
    if (generationCalls === 1) {
      payload?.onTextDelta?.("");
      return {
        text: "",
        toolCalls: [
          {
            id: "tc_1",
            name: "music_play",
            input: {
              query: "Minecraft calm relaxing music",
              platform: "youtube"
            }
          }
        ],
        rawContent: [
          {
            type: "tool_use",
            id: "tc_1",
            name: "music_play",
            input: {
              query: "Minecraft calm relaxing music",
              platform: "youtube"
            }
          }
        ]
      };
    }
    throw createAbortError("superseded by newer capture");
  };
  bot.llm.generate = runGeneration;
  bot.llm.generateStreaming = runGeneration;

  const reply = await generateVoiceTurnReply(bot, {
    settings: baseSettings(),
    guildId: "guild-1",
    channelId: "text-1",
    userId: "user-1",
    transcript: "play some minecraft music",
    sessionId: "voice-session-tool-recovery-safe",
    voiceToolCallbacks: {
      musicPlay: async () => ({
        ok: true,
        status: "needs_disambiguation",
        query: "Minecraft calm relaxing music",
        options: [
          { id: "track-1", title: "Minecraft Calm", artist: "C418", platform: "youtube" }
        ]
      })
    }
  });

  assert.equal(reply.text, "");
  assert.equal(activeVoiceSession.inFlightAcceptedBrainTurn.phase, "tool_call_started");
  assert.equal(activeVoiceSession.inFlightAcceptedBrainTurn.toolPhaseRecoveryEligible, true);
  assert.equal(
    activeVoiceSession.inFlightAcceptedBrainTurn.toolPhaseRecoveryReason,
    "music_play_needs_disambiguation"
  );
  assert.equal(activeVoiceSession.inFlightAcceptedBrainTurn.toolPhaseLastToolName, "music_play");
});

test("generateVoiceTurnReply keeps playback-starting music tool followups non-recoverable", async () => {
  const activeVoiceSession = {
    id: "voice-session-tool-recovery-unsafe",
    durableContext: [],
    inFlightAcceptedBrainTurn: {
      transcript: "play some minecraft music",
      userId: "user-1",
      pcmBuffer: null,
      source: "realtime",
      acceptedAt: Date.now(),
      phase: "generation_only",
      captureReason: "stream_end",
      directAddressed: true,
      toolPhaseRecoveryEligible: false,
      toolPhaseRecoveryReason: null,
      toolPhaseLastToolName: null
    }
  };
  const { bot } = createVoiceBot({
    activeVoiceSession
  });
  let generationCalls = 0;
  const runGeneration = async (payload) => {
    generationCalls += 1;
    if (generationCalls === 1) {
      payload?.onTextDelta?.("");
      return {
        text: "",
        toolCalls: [
          {
            id: "tc_1",
            name: "music_play",
            input: {
              query: "Minecraft calm relaxing music",
              platform: "youtube"
            }
          }
        ],
        rawContent: [
          {
            type: "tool_use",
            id: "tc_1",
            name: "music_play",
            input: {
              query: "Minecraft calm relaxing music",
              platform: "youtube"
            }
          }
        ]
      };
    }
    throw createAbortError("superseded by newer capture");
  };
  bot.llm.generate = runGeneration;
  bot.llm.generateStreaming = runGeneration;

  const reply = await generateVoiceTurnReply(bot, {
    settings: baseSettings(),
    guildId: "guild-1",
    channelId: "text-1",
    userId: "user-1",
    transcript: "play some minecraft music",
    sessionId: "voice-session-tool-recovery-unsafe",
    voiceToolCallbacks: {
      musicPlay: async () => ({
        ok: true,
        status: "loading",
        query: "Minecraft calm relaxing music"
      })
    }
  });

  assert.equal(reply.text, "");
  assert.equal(activeVoiceSession.inFlightAcceptedBrainTurn.phase, "tool_call_started");
  assert.equal(activeVoiceSession.inFlightAcceptedBrainTurn.toolPhaseRecoveryEligible, false);
  assert.equal(
    activeVoiceSession.inFlightAcceptedBrainTurn.toolPhaseRecoveryReason,
    "music_play_started_loading"
  );
  assert.equal(activeVoiceSession.inFlightAcceptedBrainTurn.toolPhaseLastToolName, "music_play");
  assert.equal(generationCalls, 1);
});

test("generateVoiceTurnReply forwards browser screenshots from tool results into the continuation model call", async () => {
  const { bot, generationPayloads, getGenerationCalls } = createVoiceBot({
    generationSequence: [
      {
        text: "let me look at it.",
        toolCalls: [
          {
            id: "tc_1",
            name: "browser_browse",
            input: {
              query: "inspect the page visually"
            }
          }
        ],
        rawContent: [
          { type: "text", text: "let me look at it." },
          {
            type: "tool_use",
            id: "tc_1",
            name: "browser_browse",
            input: { query: "inspect the page visually" }
          }
        ]
      },
      {
        text: "yeah the banner says sold out."
      }
    ]
  });

  bot.buildBrowserBrowseContext = () => ({
    requested: false,
    configured: true,
    enabled: true,
    used: false,
    blockedByBudget: false,
    error: null,
    query: "",
    text: "",
    imageInputs: [],
    steps: 0,
    hitStepLimit: false,
    budget: {
      canBrowse: true
    }
  });
  bot.runModelRequestedBrowserBrowse = async () => ({
    used: true,
    text: "I checked the page.",
    imageInputs: [
      {
        mediaType: "image/png",
        dataBase64: "Zm9v"
      }
    ],
    steps: 2,
    hitStepLimit: false,
    error: null,
    blockedByBudget: false
  });

  const reply = await generateVoiceTurnReply(bot, {
    settings: baseSettings(),
    guildId: "guild-1",
    channelId: "text-1",
    userId: "user-1",
    transcript: "what does the page look like"
  });

  assert.equal(reply.text, "let me look at it.\nyeah the banner says sold out.");
  assert.equal(getGenerationCalls(), 2);
  assert.equal(reply.replyPrompts?.hiddenByDefault, true);
  assert.match(String(reply.replyPrompts?.initialUserPrompt || ""), /what does the page look like/i);
  assert.deepEqual(reply.replyPrompts?.followupUserPrompts, [
    "Attached are images returned by the previous tool call. Use them if they help."
  ]);
  assert.equal(generationPayloads[1]?.userPrompt, "Attached are images returned by the previous tool call. Use them if they help.");
  assert.deepEqual(generationPayloads[1]?.imageInputs, [
    {
      mediaType: "image/png",
      dataBase64: "Zm9v"
    }
  ]);
});

test("generateVoiceTurnReply forwards the abort signal into browser tool execution", async () => {
  const { bot, browserBrowseCalls, getGenerationCalls } = createVoiceBot({
    generationSequence: [
      {
        text: "checking now",
        toolCalls: [
          {
            id: "tc_1",
            name: "browser_browse",
            input: {
              query: "inspect ebay"
            }
          }
        ],
        rawContent: [
          { type: "text", text: "checking now" },
          {
            type: "tool_use",
            id: "tc_1",
            name: "browser_browse",
            input: { query: "inspect ebay" }
          }
        ]
      },
      {
        text: "done"
      }
    ]
  });

  bot.buildBrowserBrowseContext = () => ({
    requested: false,
    configured: true,
    enabled: true,
    used: false,
    blockedByBudget: false,
    error: null,
    query: "",
    text: "",
    imageInputs: [],
    steps: 0,
    hitStepLimit: false,
    budget: {
      canBrowse: true
    }
  });

  const controller = new AbortController();
  const reply = await generateVoiceTurnReply(bot, {
    settings: baseSettings(),
    guildId: "guild-1",
    channelId: "text-1",
    userId: "user-1",
    transcript: "show me ebay",
    signal: controller.signal
  });

  assert.equal(reply.text, "checking now\ndone");
  assert.equal(getGenerationCalls(), 2);
  assert.equal(browserBrowseCalls.length, 1);
  assert.equal(browserBrowseCalls[0]?.signal, controller.signal);
});

test("generateVoiceTurnReply uses browser sub-agent sessions before one-shot browser browse", async () => {
  const { bot, browserBrowseCalls, getGenerationCalls } = createVoiceBot({
    generationSequence: [
      {
        text: "let me work through that",
        toolCalls: [
          {
            id: "tc_1",
            name: "browser_browse",
            input: {
              query: "search ebay for pokemon diamond ds"
            }
          }
        ],
        rawContent: [
          { type: "text", text: "let me work through that" },
          {
            type: "tool_use",
            id: "tc_1",
            name: "browser_browse",
            input: { query: "search ebay for pokemon diamond ds" }
          }
        ]
      },
      {
        text: "I found the cheapest ones."
      }
    ]
  });

  bot.buildBrowserBrowseContext = () => ({
    requested: false,
    configured: true,
    enabled: true,
    used: false,
    blockedByBudget: false,
    error: null,
    query: "",
    text: "",
    imageInputs: [],
    steps: 0,
    hitStepLimit: false,
    budget: {
      canBrowse: true
    }
  });

  const registeredSessions = [];
  const removedSessions = [];
  bot.buildSubAgentSessionsRuntime = () => ({
    manager: {
      get() {
        return null;
      },
      register(session) {
        registeredSessions.push(session.id);
      },
      remove(sessionId) {
        removedSessions.push(sessionId);
      }
    },
    createCodeSession() {
      return null;
    },
    createBrowserSession() {
      return {
        id: "browser-session-1",
        ownerUserId: "user-1",
        async runTurn(query, options = {}) {
          assert.equal(query, "search ebay for pokemon diamond ds");
          assert.ok(options.signal instanceof AbortSignal);
          return {
            text: "I searched eBay.\n\n[session_id: browser-session-1]",
            imageInputs: [],
            isError: false,
            errorMessage: "",
            sessionCompleted: false,
            costUsd: 0,
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              cacheWriteTokens: 0,
              cacheReadTokens: 0
            }
          };
        }
      };
    }
  });
  bot.runModelRequestedBrowserBrowse = async () => {
    throw new Error("one-shot browse should not run when browser sub-agent sessions are available");
  };

  const reply = await generateVoiceTurnReply(bot, {
    settings: baseSettings(),
    guildId: "guild-1",
    channelId: "text-1",
    userId: "user-1",
    transcript: "find the cheapest pokemon diamond ds on ebay"
  });

  assert.equal(reply.text, "let me work through that\nI found the cheapest ones.");
  assert.equal(getGenerationCalls(), 2);
  assert.deepEqual(registeredSessions, ["browser-session-1"]);
  assert.deepEqual(removedSessions, []);
  assert.equal(browserBrowseCalls.length, 0);
});

test("generateVoiceTurnReply logs failed brain tool errors with the returned tool message", async () => {
  const { bot, logs } = createVoiceBot({
    generationSequence: [
      {
        text: "trying to share it",
        toolCalls: [
          {
            id: "tc_1",
            name: "share_browser_session",
            input: {
              session_id: "browser-session-1"
            }
          }
        ],
        rawContent: [
          { type: "text", text: "trying to share it" },
          {
            type: "tool_use",
            id: "tc_1",
            name: "share_browser_session",
            input: { session_id: "browser-session-1" }
          }
        ]
      },
      {
        text: "share still failed"
      }
    ]
  });

  bot.buildBrowserBrowseContext = () => ({
    requested: false,
    configured: true,
    enabled: true,
    used: false,
    blockedByBudget: false,
    error: null,
    query: "",
    text: "",
    imageInputs: [],
    steps: 0,
    hitStepLimit: false,
    budget: {
      canBrowse: true
    }
  });

  const reply = await generateVoiceTurnReply(bot, {
    settings: baseSettings(),
    guildId: "guild-1",
    channelId: "text-1",
    userId: "user-1",
    transcript: "show me your browser",
    voiceToolCallbacks: {}
  });

  assert.equal(reply.text, "trying to share it");

  const toolLog = logs.find((entry) =>
    entry?.content === "voice_brain_tool_call" &&
    isRecord(entry?.metadata) &&
    entry.metadata.toolName === "share_browser_session"
  );

  assert.ok(toolLog);
  assert.equal(toolLog?.metadata?.isError, true);
  assert.equal(toolLog?.metadata?.error, "Browser session sharing is not available.");
});

test("generateVoiceTurnReply carries resolved streamed speech into the continuation context when generation.text is empty", async () => {
  const { bot, generationPayloads, getGenerationCalls } = createVoiceBot({
    generationSequence: [
      {
        text: "",
        textDeltas: ["yo vuhlp, what's good "],
        toolCalls: [
          {
            id: "tc_1",
            name: "web_search",
            input: {
              query: "latest rust stable version"
            }
          }
        ],
        rawContent: [
          {
            type: "tool_use",
            id: "tc_1",
            name: "web_search",
            input: { query: "latest rust stable version" }
          }
        ]
      },
      {
        text: "latest stable rust is 1.90"
      }
    ]
  });

  const reply = await generateVoiceTurnReply(bot, {
    settings: baseSettings({
      webSearch: {
        enabled: true
      },
      voice: {
        streamingEnabled: true,
        streamingEagerFirstChunkChars: 16,
        streamingMaxBufferChars: 120
      }
    }),
    guildId: "guild-1",
    channelId: "text-1",
    userId: "user-1",
    transcript: "check rust",
    onSpokenSentence: () => true,
    voiceToolCallbacks: {
      playSoundboard: async (refs) => ({ ok: true, played: refs }),
      setScreenNote: async (note) => ({ ok: true, note }),
      setScreenMoment: async (moment) => ({ ok: true, moment }),
      leaveVoiceChannel: async () => ({ ok: true })
    }
  });

  const secondCallMessages = Array.isArray(generationPayloads[1]?.contextMessages)
    ? generationPayloads[1].contextMessages
    : [];
  const assistantMessage = secondCallMessages[secondCallMessages.length - 2];
  const assistantContent = Array.isArray(assistantMessage?.content) ? assistantMessage.content : [];

  assert.equal(reply.text, "yo vuhlp, what's good\nlatest stable rust is 1.90");
  assert.equal(getGenerationCalls(), 2);
  assert.deepEqual(assistantContent, [
    { type: "text", text: "yo vuhlp, what's good" },
    {
      type: "tool_use",
      id: "tc_1",
      name: "web_search",
      input: { query: "latest rust stable version" }
    }
  ]);
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
    String(generationPayloads[0]?.userPrompt || "").includes("Past conversation:"),
    true
  );
  assert.equal(
    String(generationPayloads[0]?.userPrompt || "").includes("NVDA was around 181 earlier."),
    true
  );
});

test("generateVoiceTurnReply injects recent voice effects into the prompt", async () => {
  const { bot, generationPayloads } = createVoiceBot({
    generationText: structuredVoiceOutput({
      text: "yeah that was loud"
    })
  });

  await generateVoiceTurnReply(bot, {
    settings: baseSettings(),
    guildId: "guild-1",
    channelId: "text-1",
    userId: "user-1",
    transcript: "did you hear that one",
    recentVoiceEffectEvents: [
      {
        displayName: "bob",
        effectType: "soundboard",
        soundName: "airhorn",
        emoji: null,
        ageMs: 850
      }
    ]
  });

  assert.equal(generationPayloads.length > 0, true);
  assert.equal(
    String(generationPayloads[0]?.userPrompt || "").includes("Recent voice effects:"),
    true
  );
  assert.equal(
    String(generationPayloads[0]?.userPrompt || "").includes("bob played soundboard \"airhorn\" (850ms ago)"),
    true
  );
});

test("generateVoiceTurnReply includes active-music guidance only once per prompt", async () => {
  const activeVoiceSession = {
    id: "voice-session-1",
    mode: "openai_realtime"
  };
  const { bot, generationPayloads } = createVoiceBot({
    generationText: structuredVoiceOutput({
      text: "yeah probably"
    }),
    activeVoiceSession
  });
  assert.ok(bot.voiceSessionManager);
  bot.voiceSessionManager.getMusicPromptContext = () => ({
    playbackState: "playing",
    replyHandoffMode: null,
    currentTrack: {
      id: "track-1",
      title: "Subwoofer Lullaby",
      artists: ["C418"]
    },
    lastTrack: null,
    queueLength: 0,
    upcomingTracks: [],
    lastAction: "play_now",
    lastQuery: "minecraft soundtrack"
  });

  await generateVoiceTurnReply(bot, {
    settings: baseSettings(),
    guildId: "guild-1",
    channelId: "text-1",
    userId: "user-1",
    sessionId: "voice-session-1",
    transcript: "if you could play gta would you",
    voiceToolCallbacks: {}
  });

  const userPrompt = String(generationPayloads[0]?.userPrompt || "");
  assert.equal(countOccurrences(userPrompt, ACTIVE_MUSIC_REPLY_CONTEXT_LINE), 1);
  assert.equal(countOccurrences(userPrompt, MUSIC_REPLY_HANDOFF_POLICY_LINE), 1);
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

  assert.deepEqual(reply, { text: "", generationContextSnapshot: null, replyPrompts: null });
  const errorLogs = logs.filter((entry) => entry?.kind === "voice_error");
  assert.equal(errorLogs.length, 1);
  assert.equal(String(errorLogs[0]?.content || "").includes("voice_brain_generation_failed"), true);
  assert.equal(errorLogs[0]?.metadata?.replyPath, "brain");
  assert.equal(errorLogs[0]?.metadata?.realtimeToolOwnership, "transport_only");
});

test("generateVoiceTurnReply treats aborted generation as a supersede, not a voice error", async () => {
  const { bot, logs } = createVoiceBot({
    generationError: createAbortError("Pending response cleared")
  });

  const reply = await generateVoiceTurnReply(bot, {
    settings: baseSettings(),
    guildId: "guild-1",
    channelId: "text-1",
    userId: "user-1",
    transcript: "hello there"
  });

  assert.deepEqual(reply, { text: "", generationContextSnapshot: null, replyPrompts: null });
  assert.equal(logs.some((entry) => entry?.kind === "voice_error"), false);
});

test("generateVoiceTurnReply treats Anthropic-style aborted generation as a supersede, not a voice error", async () => {
  const generationError = new Error("Request was aborted.");
  generationError.name = "APIUserAbortError";
  const { bot, logs } = createVoiceBot({
    generationError
  });

  const reply = await generateVoiceTurnReply(bot, {
    settings: baseSettings(),
    guildId: "guild-1",
    channelId: "text-1",
    userId: "user-1",
    transcript: "hello there"
  });

  assert.deepEqual(reply, { text: "", generationContextSnapshot: null, replyPrompts: null });
  assert.equal(logs.some((entry) => entry?.kind === "voice_error"), false);
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
  assert.equal(getResolvedOrchestratorBinding(generationPayloads[0]?.settings).provider, "anthropic");
  assert.equal(getResolvedOrchestratorBinding(generationPayloads[0]?.settings).model, "claude-haiku-4-5");
});

test("generateVoiceTurnReply uses text llm provider/model when voice generation useTextModel is enabled", async () => {
  const { bot, generationPayloads } = createVoiceBot({
    generationText: "copy that"
  });
  await generateVoiceTurnReply(bot, {
    settings: baseSettings({
      llm: {
        provider: "claude-oauth",
        model: "claude-sonnet-4-6"
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
  assert.equal(getResolvedOrchestratorBinding(generationPayloads[0]?.settings).provider, "claude-oauth");
  assert.equal(getResolvedOrchestratorBinding(generationPayloads[0]?.settings).model, "claude-sonnet-4-6");
});

test("generateVoiceTurnReply advertises tool runtimes only when the capability exists", async () => {
  const cases = [
    {
      name: "missing_code_task_runtime",
      transcript: "can you patch that file?",
      settings: baseSettings({
        codeAgent: {
          provider: "claude-code",
          allowedUserIds: ["user-1"]
        }
      }),
      configure() {},
      expectedToolName: "code_task",
      expectedPresent: false
    },
    {
      name: "present_code_task_runtime",
      transcript: "can you patch that file?",
      settings: baseSettings({
        codeAgent: {
          provider: "claude-code",
          allowedUserIds: ["user-1"]
        }
      }),
      configure(bot) {
        bot.runModelRequestedCodeTask = async () => ({ text: "done", isError: false, costUsd: 0, error: null });
      },
      expectedToolName: "code_task",
      expectedPresent: true
    },
    {
      name: "present_browser_runtime",
      transcript: "check that website",
      settings: baseSettings(),
      configure(bot) {
        bot.buildBrowserBrowseContext = () => ({
          requested: false,
          configured: true,
          enabled: true,
          used: false,
          blockedByBudget: false,
          error: null,
          query: "",
          text: "",
          steps: 0,
          hitStepLimit: false,
          budget: {
            canBrowse: true
          }
        });
        bot.runModelRequestedBrowserBrowse = async () => ({
          used: true,
          text: "done",
          steps: 1,
          hitStepLimit: false,
          error: null,
          blockedByBudget: false
        });
      },
      expectedToolName: "browser_browse",
      expectedPresent: true
    }
  ];

  for (const row of cases) {
    const { bot, generationPayloads } = createVoiceBot({
      generationText: structuredVoiceOutput({
        text: "all good"
      })
    });
    row.configure(bot);

    await generateVoiceTurnReply(bot, {
      settings: row.settings,
      guildId: "guild-1",
      channelId: "text-1",
      userId: "user-1",
      transcript: row.transcript
    });

    const firstTools = Array.isArray(generationPayloads[0]?.tools) ? generationPayloads[0].tools : [];
    const toolNames = firstTools.map((entry) => String(entry?.name || ""));
    assert.equal(toolNames.includes(row.expectedToolName), row.expectedPresent, row.name);
  }
});

test("generateVoiceTurnReply runs web lookup follow-up via tool calls", async () => {
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

  const reply = await generateVoiceTurnReply(bot, {
    settings: baseSettings({
      webSearch: {
        enabled: true
      }
    }),
    guildId: "guild-1",
    channelId: "text-1",
    userId: "user-1",
    transcript: "what's the latest rust stable?"
  });

  assert.equal(getGenerationCalls(), 2);
  assert.equal(webSearchCalls.length, 1);
  assert.equal(reply.text, "latest stable rust is 1.90");
  assert.equal(reply.usedWebSearchFollowup, true);
});

test("generateVoiceTurnReply handles web_scrape tool call", async () => {
  const { bot, getGenerationCalls, webScrapeCalls } = createVoiceBot({
    generationSequence: [
      {
        text: "",
        toolCalls: [
          {
            id: "tc_1",
            name: "web_scrape",
            input: { url: "https://example.com/news-1" }
          }
        ],
        rawContent: [
          { type: "text", text: "" },
          { type: "tool_use", id: "tc_1", name: "web_scrape", input: { url: "https://example.com/news-1" } }
        ]
      },
      {
        text: structuredVoiceOutput({
          text: "here's what it says"
        })
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
  assert.equal(webScrapeCalls.length, 1);
  assert.equal(webScrapeCalls[0].url, "https://example.com/news-1");
  assert.equal(reply.text, "here's what it says");
  assert.equal(reply.usedWebSearchFollowup, false);
});

test("generateVoiceTurnReply tolerates empty fact profiles", async () => {
  const { bot } = createVoiceBot({
    generationText: structuredVoiceOutput({
      text: "quick reply"
    }),
    loadFactProfile: () => ({ userFacts: [], relevantFacts: [] })
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
    loadFactProfile: () => {
      memoryLoadCalls += 1;
      if (memoryLoadCalls === 1) {
        return {
          participantProfiles: [
            {
              userId: "user-1",
              displayName: "user-1",
              facts: [{ subject: "author", fact: "likes ramen" }]
            }
          ],
          userFacts: [{ subject: "author", fact: "likes ramen" }],
          relevantFacts: []
        };
      }
      return { participantProfiles: [], userFacts: [], relevantFacts: [] };
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

test("generateVoiceTurnReply triggers voice screen watch start from tool-call field", async () => {
  const { bot, generationPayloads, screenShareCalls } = createVoiceBot({
    generationSequence: [
      {
        text: "",
        toolCalls: [
          {
            id: "tc_1",
            name: "start_screen_watch",
            input: { target: "casey" }
          }
        ],
        rawContent: [
          { type: "text", text: "" },
          { type: "tool_use", id: "tc_1", name: "start_screen_watch", input: { target: "casey" } }
        ]
      },
      {
        text: structuredVoiceOutput({
          text: "i can check it"
        })
      }
    ],
    screenShareCapability: {
      enabled: true,
      available: true,
      status: "ready",
      publicUrl: "https://fancy-cat.trycloudflare.com"
    },
    offerScreenShare: async () => ({ started: true, transport: "native", targetUserId: "user-3" })
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
  const firstTools = Array.isArray(generationPayloads[0]?.tools) ? generationPayloads[0].tools : [];
  const toolNames = firstTools.map((entry) => String(entry?.name || ""));
  assert.ok(toolNames.includes("start_screen_watch"));
  assert.equal(screenShareCalls.length, 1);
  assert.equal(screenShareCalls[0]?.guildId, "guild-1");
  assert.equal(screenShareCalls[0]?.channelId, "text-1");
  assert.equal(screenShareCalls[0]?.requesterUserId, "user-1");
  assert.equal(screenShareCalls[0]?.target, "casey");
});

test("generateVoiceTurnReply exposes start_screen_watch before native watch is already ready and logs the capability snapshot", async () => {
  const { bot, generationPayloads, logs } = createVoiceBot({
    generationText: structuredVoiceOutput({
      text: "i can try it"
    }),
    screenShareCapability: {
      supported: true,
      enabled: true,
      available: false,
      status: "unavailable",
      reason: "no_active_discord_screen_share",
      nativeSupported: true,
      nativeEnabled: true,
      nativeAvailable: false,
      nativeStatus: "unavailable",
      nativeReason: "no_active_discord_screen_share",
      linkSupported: true,
      linkEnabled: true,
      linkFallbackAvailable: false,
      linkStatus: "starting",
      linkReason: "starting",
      publicUrl: "https://fancy-cat.trycloudflare.com"
    }
  });

  const reply = await generateVoiceTurnReply(bot, {
    settings: baseSettings(),
    guildId: "guild-1",
    channelId: "text-1",
    userId: "user-1",
    transcript: "can you see my stream right now?"
  });

  assert.equal(reply.text, "i can try it");
  const firstTools = Array.isArray(generationPayloads[0]?.tools) ? generationPayloads[0].tools : [];
  const toolNames = firstTools.map((entry) => String(entry?.name || ""));
  assert.equal(toolNames.includes("start_screen_watch"), true);

  const capabilityLog = logs.find((entry) =>
    entry?.content === "voice_screen_watch_capability" &&
    isRecord(entry?.metadata)
  );
  assert.ok(capabilityLog);
  assert.equal(capabilityLog?.metadata?.supported, true);
  assert.equal(capabilityLog?.metadata?.enabled, true);
  assert.equal(capabilityLog?.metadata?.available, false);
  assert.equal(capabilityLog?.metadata?.nativeSupported, true);
  assert.equal(capabilityLog?.metadata?.nativeEnabled, true);
  assert.equal(capabilityLog?.metadata?.nativeAvailable, false);
  assert.equal(capabilityLog?.metadata?.nativeReason, "no_active_discord_screen_share");
  assert.equal(capabilityLog?.metadata?.toolExposed, true);
});

test("generateVoiceTurnReply screen-watch prompt says not to read share links aloud", async () => {
  const { bot, generationPayloads } = createVoiceBot({
    generationText: structuredVoiceOutput({
      text: "open the link i sent"
    }),
    screenShareCapability: {
      enabled: true,
      available: true,
      status: "ready",
      publicUrl: "https://fancy-cat.trycloudflare.com"
    }
  });

  const reply = await generateVoiceTurnReply(bot, {
    settings: baseSettings(),
    guildId: "guild-1",
    channelId: "text-1",
    userId: "user-1",
    transcript: "can you see my screen?"
  });

  assert.equal(reply.text, "open the link i sent");
  const userPrompt = String(generationPayloads[0]?.userPrompt || "");
  assert.equal(
    userPrompt.includes("Do not read the full URL aloud unless they explicitly ask you to spell it out."),
    true
  );
  assert.equal(
    userPrompt.includes("tell them to open the link you sent or the screen-share link"),
    true
  );
});

test("generateVoiceTurnReply hides start_screen_watch when native screen watch is hard-blocked", async () => {
  const { bot, generationPayloads, screenShareCalls } = createVoiceBot({
    generationText: structuredVoiceOutput({
      text: "can't pull it up rn"
    }),
    screenShareCapability: {
      supported: true,
      enabled: true,
      available: false,
      status: "unavailable",
      publicUrl: "https://fancy-cat.trycloudflare.com",
      reason: "native_discord_video_decode_unavailable",
      nativeSupported: true,
      nativeEnabled: true,
      nativeAvailable: false,
      nativeStatus: "unavailable",
      nativeReason: "native_discord_video_decode_unavailable",
      linkSupported: true,
      linkEnabled: true,
      linkFallbackAvailable: true,
      linkStatus: "ready",
      linkReason: null
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
  assert.equal(userPrompt.includes("start_screen_watch"), false);
  assert.equal(userPrompt.includes("screenWatchIntent.action"), false);
});

test("generateVoiceTurnReply returns leave request when model calls leave_voice_channel", async () => {
  let leaveCalls = 0;
  const { bot } = createVoiceBot({
    generationSequence: [
      {
        text: "",
        toolCalls: [
          {
            id: "tc_1",
            name: "leave_voice_channel",
            input: {}
          }
        ],
        rawContent: [
          { type: "text", text: "" },
          { type: "tool_use", id: "tc_1", name: "leave_voice_channel", input: {} }
        ]
      },
      {
        text: structuredVoiceOutput({
          text: "aight i'ma bounce"
        })
      }
    ]
  });

  const reply = await generateVoiceTurnReply(bot, {
    settings: baseSettings(),
    guildId: "guild-1",
    channelId: "text-1",
    userId: "user-1",
    transcript: "you good to keep chilling?",
    voiceToolCallbacks: {
      leaveVoiceChannel: async () => {
        leaveCalls += 1;
        return { ok: true };
      }
    }
  });

  assert.equal(reply.text, "aight i'ma bounce");
  assert.equal(reply.leaveVoiceChannelRequested, true);
  assert.equal(leaveCalls, 0);
});
