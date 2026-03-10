import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  BOT_NAME_ALIAS_MAX_ITEMS,
  normalizeSettings,
  PERSONA_FLAVOR_MAX_CHARS
} from "./settingsNormalization.ts";
import { resolveAgentStack } from "../settings/agentStack.ts";
import { normalizeTestSettingsInput } from "../testSettings.ts";

function normalizeLegacyView(input: unknown): ReturnType<typeof normalizeSettings> {
  return normalizeSettings(normalizeTestSettingsInput(input));
}

test("normalizeSettings interprets string booleans from form-style payloads correctly", () => {
  const normalized = normalizeSettings({
    permissions: {
      replies: {
        allowReplies: "false",
        allowUnsolicitedReplies: "0",
        allowReactions: "true"
      }
    }
  });

  assert.equal(normalized.permissions.replies.allowReplies, false);
  assert.equal(normalized.permissions.replies.allowUnsolicitedReplies, false);
  assert.equal(normalized.permissions.replies.allowReactions, true);
});

test("normalizeSettings migrates and clamps complex legacy settings into the canonical schema", () => {
  const normalized = normalizeLegacyView({
    botName: "x".repeat(120),
    botNameAliases: ["clank", "clank", "  ", "conk", "alias-".repeat(20)],
    llm: {
      provider: "XAI",
      model: "",
      temperature: 9,
      maxOutputTokens: 1
    },
    replyFollowupLlm: {
      enabled: true,
      provider: "not-real",
      model: "",
      maxToolSteps: 99,
      maxTotalToolCalls: -5,
      maxWebSearchCalls: 7,
      maxMemoryLookupCalls: -2,
      maxImageLookupCalls: 999,
      toolTimeoutMs: 999999
    },
    webSearch: {
      enabled: true,
      maxSearchesPerHour: 999,
      maxResults: 0,
      maxPagesToRead: 99,
      maxCharsPerPage: 80,
      safeSearch: false,
      providerOrder: ["serpapi", "serpapi", "brave", "unknown"],
      recencyDaysDefault: 0,
      maxConcurrentFetches: 99
    },
    browser: {
      enabled: true,
      headed: true,
      llm: {
        provider: "OPENAI",
        model: ""
      },
      maxBrowseCallsPerHour: 999,
      maxStepsPerTask: 0,
      stepTimeoutMs: 1000,
      sessionTimeoutMs: 999999
    },
    videoContext: {
      enabled: true,
      maxLookupsPerHour: -1,
      maxVideosPerMessage: 99,
      maxTranscriptChars: 99_999,
      keyframeIntervalSeconds: -5,
      maxKeyframesPerVideo: 30,
      allowAsrFallback: true,
      maxAsrSeconds: 2
    },
    voice: {
      voiceProvider: "openai",
      brainProvider: "native",
      asrLanguageMode: "FIXED",
      asrLanguageHint: "EN_us",
      generationLlm: {
        provider: "not-real",
        model: ""
      },
      thoughtEngine: {
        enabled: "yes",
        provider: "NOT-REAL",
        model: "",
        temperature: 9,
        eagerness: 999,
        minSilenceSeconds: 1,
        minSecondsBetweenThoughts: 9999
      },
      replyDecisionLlm: {
        provider: "CLAUDE-CODE",
        model: "",
        reasoningEffort: "HIGH"
      },
      openaiRealtime: {
        inputAudioFormat: "bad-format",
        outputAudioFormat: "g711_alaw"
      },
      geminiRealtime: {
        apiBaseUrl: "ftp://invalid.example/path",
        inputSampleRateHz: 0,
        outputSampleRateHz: 99_000
      },
      streamWatch: {
        minCommentaryIntervalSeconds: 1,
        maxFramesPerMinute: 9999,
        maxFrameBytes: 10,
        keyframeIntervalMs: 20,
        autonomousCommentaryEnabled: 0,
        brainContextEnabled: "yes",
        brainContextMinIntervalSeconds: -4,
        brainContextMaxEntries: 999,
        brainContextPrompt: `${"x".repeat(520)}   `
      },
      soundboard: {
        eagerness: 999,
        preferredSoundIds: ["first", "first", "second"]
      },
      musicDucking: {
        targetGain: -2,
        fadeMs: 99999
      }
    },
    discovery: {
      allowedImageModels: "gpt-image-1.5, gpt-image-1.5, grok-imagine-image",
      allowedVideoModels: ["grok-imagine-video", "grok-imagine-video"],
      rssFeeds: ["https://ok.example/feed", "not-a-url"],
      xHandles: ["@alice", "@alice", "bob"],
      redditSubreddits: ["r/memes", "memes"],
      xNitterBaseUrl: "https://nitter.example/path",
      sources: {
        reddit: false,
        x: true
      }
    }
  });

  const followupExecution = normalized.interaction.followup.execution as {
    mode: string;
    model?: { provider: string; model: string };
  };
  const browserExecution = normalized.agentStack.runtimeConfig.browser.localBrowserAgent.execution as {
    mode: string;
    model?: { provider: string; model: string };
  };
  const voiceGeneration = normalized.agentStack.runtimeConfig.voice.generation as {
    mode: string;
    model?: { provider: string; model: string };
  };
  const voiceInitiativeExecution = normalized.initiative.voice.execution as {
    mode: string;
    model?: { provider: string; model: string };
    temperature?: number;
  };

  assert.equal(normalized.identity.botName.length, 50);
  assert.deepEqual(
    normalized.identity.botNameAliases,
    ["clank", "conk", "alias-alias-alias-alias-alias-alias-alias-alias-al"]
  );

  assert.deepEqual(normalized.agentStack.overrides.orchestrator, {
    provider: "xai",
    model: "grok-3-mini-latest"
  });
  assert.equal(normalized.interaction.replyGeneration.temperature, 2);
  assert.equal(normalized.interaction.replyGeneration.maxOutputTokens, 32);

  assert.equal(normalized.interaction.followup.enabled, true);
  assert.equal(followupExecution.mode, "dedicated_model");
  assert.deepEqual(followupExecution.model, {
    provider: "xai",
    model: "grok-3-mini-latest"
  });
  assert.equal(normalized.interaction.followup.toolBudget.maxToolSteps, 6);
  assert.equal(normalized.interaction.followup.toolBudget.maxTotalToolCalls, 0);
  assert.equal(normalized.interaction.followup.toolBudget.maxWebSearchCalls, 7);
  assert.equal(normalized.interaction.followup.toolBudget.maxMemoryLookupCalls, 0);
  assert.equal(normalized.interaction.followup.toolBudget.maxImageLookupCalls, 8);
  assert.equal(normalized.interaction.followup.toolBudget.toolTimeoutMs, 120_000);

  assert.equal(normalized.agentStack.runtimeConfig.research.enabled, true);
  assert.equal(normalized.agentStack.runtimeConfig.research.maxSearchesPerHour, 120);
  assert.equal(normalized.agentStack.runtimeConfig.research.localExternalSearch.maxResults, 1);
  assert.equal(normalized.agentStack.runtimeConfig.research.localExternalSearch.maxPagesToRead, 5);
  assert.equal(normalized.agentStack.runtimeConfig.research.localExternalSearch.maxCharsPerPage, 350);
  assert.equal(normalized.agentStack.runtimeConfig.research.localExternalSearch.safeSearch, false);
  assert.equal(normalized.agentStack.runtimeConfig.research.localExternalSearch.recencyDaysDefault, 1);
  assert.equal(normalized.agentStack.runtimeConfig.research.localExternalSearch.maxConcurrentFetches, 10);
  assert.deepEqual(
    normalized.agentStack.runtimeConfig.research.localExternalSearch.providerOrder,
    ["serpapi", "brave"]
  );

  assert.equal(normalized.agentStack.runtimeConfig.browser.enabled, true);
  assert.equal(normalized.agentStack.runtimeConfig.browser.headed, true);
  assert.equal(browserExecution.mode, "dedicated_model");
  assert.deepEqual(browserExecution.model, {
    provider: "openai",
    model: "gpt-5-mini"
  });
  assert.equal(normalized.agentStack.runtimeConfig.browser.localBrowserAgent.maxBrowseCallsPerHour, 60);
  assert.equal(normalized.agentStack.runtimeConfig.browser.localBrowserAgent.maxStepsPerTask, 1);
  assert.equal(normalized.agentStack.runtimeConfig.browser.localBrowserAgent.stepTimeoutMs, 5_000);
  assert.equal(normalized.agentStack.runtimeConfig.browser.localBrowserAgent.sessionTimeoutMs, 999_999);

  assert.equal(normalized.media.videoContext.maxLookupsPerHour, 0);
  assert.equal(normalized.media.videoContext.maxVideosPerMessage, 6);
  assert.equal(normalized.media.videoContext.maxTranscriptChars, 4000);
  assert.equal(normalized.media.videoContext.keyframeIntervalSeconds, 0);
  assert.equal(normalized.media.videoContext.maxKeyframesPerVideo, 8);
  assert.equal(normalized.media.videoContext.maxAsrSeconds, 15);

  assert.equal(normalized.voice.transcription.languageMode, "fixed");
  assert.equal(normalized.voice.transcription.languageHint, "en-us");
  assert.equal(voiceGeneration.mode, "dedicated_model");
  assert.deepEqual(voiceGeneration.model, {
    provider: "anthropic",
    model: "claude-sonnet-4-6"
  });
  assert.equal(voiceInitiativeExecution.mode, "dedicated_model");
  assert.deepEqual(voiceInitiativeExecution.model, {
    provider: "anthropic",
    model: "claude-sonnet-4-6"
  });
  assert.equal(voiceInitiativeExecution.temperature, 2);
  assert.equal(normalized.initiative.voice.enabled, true);
  assert.equal(normalized.initiative.voice.eagerness, 100);
  assert.equal(normalized.initiative.voice.minSilenceSeconds, 1);
  assert.equal(normalized.initiative.voice.minSecondsBetweenThoughts, 600);
  assert.deepEqual(normalized.agentStack.overrides.voiceAdmissionClassifier, {
    mode: "dedicated_model",
    model: {
      provider: "anthropic",
      model: "claude-haiku-4-5"
    }
  });
  assert.equal(normalized.agentStack.runtimeConfig.voice.openaiRealtime.inputAudioFormat, "pcm16");
  assert.equal(normalized.agentStack.runtimeConfig.voice.openaiRealtime.outputAudioFormat, "g711_alaw");
  assert.equal(
    normalized.agentStack.runtimeConfig.voice.geminiRealtime.apiBaseUrl,
    "https://generativelanguage.googleapis.com"
  );
  assert.equal(normalized.agentStack.runtimeConfig.voice.geminiRealtime.inputSampleRateHz, 8000);
  assert.equal(normalized.agentStack.runtimeConfig.voice.geminiRealtime.outputSampleRateHz, 96000);
  assert.equal(normalized.voice.streamWatch.minCommentaryIntervalSeconds, 3);
  assert.equal(normalized.voice.streamWatch.maxFramesPerMinute, 600);
  assert.equal(normalized.voice.streamWatch.maxFrameBytes, 50_000);
  assert.equal(normalized.voice.streamWatch.keyframeIntervalMs, 500);
  assert.equal(normalized.voice.streamWatch.autonomousCommentaryEnabled, false);
  assert.equal(normalized.voice.streamWatch.brainContextEnabled, true);
  assert.equal(normalized.voice.streamWatch.brainContextMinIntervalSeconds, 1);
  assert.equal(normalized.voice.streamWatch.brainContextMaxEntries, 24);
  assert.equal(normalized.voice.streamWatch.brainContextPrompt.length, 420);
  assert.equal(normalized.voice.soundboard.eagerness, 100);
  assert.deepEqual(normalized.voice.soundboard.preferredSoundIds, ["first", "second"]);
  assert.equal(normalized.music.ducking.targetGain, 0);
  assert.equal(normalized.music.ducking.fadeMs, 10_000);

  assert.deepEqual(normalized.initiative.discovery.allowedImageModels, ["gpt-image-1.5", "grok-imagine-image"]);
  assert.deepEqual(normalized.initiative.discovery.allowedVideoModels, ["grok-imagine-video"]);
  assert.deepEqual(normalized.initiative.discovery.rssFeeds, ["https://ok.example/feed"]);
  assert.deepEqual(normalized.initiative.discovery.xHandles, ["alice", "bob"]);
  assert.deepEqual(normalized.initiative.discovery.redditSubreddits, ["memes", "memes"]);
  assert.equal(normalized.initiative.discovery.xNitterBaseUrl, "https://nitter.example");
  assert.equal(normalized.initiative.discovery.sources.reddit, false);
  assert.equal(normalized.initiative.discovery.sources.x, true);
});

test("normalizeSettings keeps explicit shared ASR bridge disable", () => {
  const normalized = normalizeLegacyView({
    voice: {
      openaiRealtime: {
        usePerUserAsrBridge: false
      }
    }
  });

  assert.equal(normalized.agentStack.runtimeConfig.voice.openaiRealtime.usePerUserAsrBridge, false);
});

test("normalizeSettings keeps up to 100 bot aliases", () => {
  const aliases = Array.from({ length: BOT_NAME_ALIAS_MAX_ITEMS + 5 }, (_, index) => `alias-${index + 1}`);
  const normalized = normalizeLegacyView({
    botNameAliases: aliases
  });

  assert.equal(normalized.identity.botNameAliases.length, BOT_NAME_ALIAS_MAX_ITEMS);
  assert.deepEqual(normalized.identity.botNameAliases, aliases.slice(0, BOT_NAME_ALIAS_MAX_ITEMS));
});

test("normalizeSettings includes the canonical default bot aliases", () => {
  const normalized = normalizeLegacyView({});

  assert.equal(normalized.identity.botNameAliases.includes("link"), true);
  assert.equal(normalized.identity.botNameAliases.includes("crank"), true);
  assert.equal(normalized.identity.botNameAliases.includes("cranker"), true);
});

test("normalizeSettings preserves explicit file_wav transcription mode", () => {
  const normalized = normalizeLegacyView({
    voice: {
      openaiRealtime: {
        transcriptionMethod: "file_wav"
      }
    }
  });

  assert.equal(normalized.agentStack.runtimeConfig.voice.openaiRealtime.transcriptionMethod, "file_wav");
});

test("normalizeSettings forces bridge replies onto realtime output", () => {
  const normalized = normalizeLegacyView({
    voice: {
      replyPath: "bridge",
      ttsMode: "api"
    }
  });

  assert.equal(normalized.voice.conversationPolicy.replyPath, "bridge");
  assert.equal(normalized.voice.conversationPolicy.ttsMode, "realtime");
});

test("normalizeSettings restricts browser model providers to supported browser runtimes", () => {
  const normalized = normalizeLegacyView({
    browser: {
      llm: {
        provider: "xai",
        model: ""
      }
    }
  });

  const browserExecution = normalized.agentStack.runtimeConfig.browser.localBrowserAgent.execution as {
    model?: { provider: string; model: string };
  };
  assert.deepEqual(browserExecution.model, {
    provider: "anthropic",
    model: "claude-sonnet-4-5-20250929"
  });
});

test("normalizeSettings preserves claude oauth browser model providers", () => {
  const normalized = normalizeLegacyView({
    browser: {
      llm: {
        provider: "claude-oauth",
        model: "claude-haiku-4-5"
      }
    }
  });

  const browserExecution = normalized.agentStack.runtimeConfig.browser.localBrowserAgent.execution as {
    model?: { provider: string; model: string };
  };
  assert.deepEqual(browserExecution.model, {
    provider: "claude-oauth",
    model: "claude-haiku-4-5"
  });
});

test("normalizeSettings migrates legacy code agent provider fields into dev-team runtime settings", () => {
  const fallback = normalizeLegacyView({
    codeAgent: {
      provider: "not-real",
      model: "",
      codexModel: ""
    }
  });

  assert.equal(fallback.agentStack.runtimeConfig.devTeam.codex.enabled, false);
  assert.equal(fallback.agentStack.runtimeConfig.devTeam.codex.model, "gpt-5.4");
  assert.equal(fallback.agentStack.runtimeConfig.devTeam.codexCli.enabled, false);
  assert.equal(fallback.agentStack.runtimeConfig.devTeam.claudeCode.enabled, false);
  assert.equal(fallback.agentStack.runtimeConfig.devTeam.claudeCode.model, "sonnet");

  const codex = normalizeLegacyView({
    codeAgent: {
      provider: "CODEX",
      model: "opus",
      codexModel: "gpt-5-codex"
    }
  });

  assert.equal(codex.agentStack.runtimeConfig.devTeam.codex.enabled, true);
  assert.equal(codex.agentStack.runtimeConfig.devTeam.codex.model, "gpt-5-codex");
  assert.equal(codex.agentStack.runtimeConfig.devTeam.claudeCode.enabled, false);
});

test("normalizeSettings keeps valid coding worker role overrides and drops invalid ones", () => {
  const normalized = normalizeSettings({
    agentStack: {
      advancedOverridesEnabled: true,
      overrides: {
        devTeam: {
          roles: {
            implementation: "codex_cli",
            review: "claude_code",
            research: "not-a-worker"
          }
        }
      }
    }
  });

  assert.deepEqual(normalized.agentStack.overrides.devTeam?.roles, {
    implementation: "codex_cli",
    review: "claude_code"
  });
});

test("resolveAgentStack routes implementation through available workers", () => {
  const normalized = normalizeSettings({
    agentStack: {
      preset: "openai_oauth",
      advancedOverridesEnabled: true,
      overrides: {
        devTeam: {
          roles: {
            implementation: "claude_code",
            review: "codex_cli"
          }
        }
      },
      runtimeConfig: {
        devTeam: {
          codex: {
            enabled: false
          },
          codexCli: {
            enabled: true
          },
          claudeCode: {
            enabled: true
          }
        }
      }
    }
  });

  const resolved = resolveAgentStack(normalized);
  assert.deepEqual(resolved.devTeam.codingWorkers, ["codex_cli", "claude_code"]);
  assert.deepEqual(resolved.devTeam.roles, {
    design: "codex_cli",
    implementation: "claude_code",
    review: "codex_cli",
    research: "codex_cli"
  });

  const onlyClaudeEnabled = normalizeSettings({
    agentStack: {
      preset: "openai_oauth",
      runtimeConfig: {
        devTeam: {
          codex: {
            enabled: false
          },
          codexCli: {
            enabled: false
          },
          claudeCode: {
            enabled: true
          }
        }
      }
    }
  });

  const resolvedOnlyClaude = resolveAgentStack(onlyClaudeEnabled);
  assert.deepEqual(resolvedOnlyClaude.devTeam.codingWorkers, ["claude_code"]);
  assert.equal(resolvedOnlyClaude.devTeam.roles.implementation, "claude_code");
  assert.equal(resolvedOnlyClaude.devTeam.roles.review, "claude_code");
});

test("normalizeSettings migrates claude_oauth_local_tools to claude_oauth and preserves session config", () => {
  const normalized = normalizeSettings({
    agentStack: {
      preset: "claude_oauth_local_tools",
      runtimeConfig: {
        claudeOAuthSession: {
          sessionScope: "channel",
          inactivityTimeoutMs: 45_000,
          contextPruningStrategy: "sliding_window",
          maxPinnedStateChars: 18_000,
          voiceToolPolicy: "fast_only",
          textToolPolicy: "full"
        }
      }
    }
  });

  assert.equal(normalized.agentStack.preset, "claude_oauth");
  assert.equal(normalized.agentStack.runtimeConfig.claudeOAuthSession.sessionScope, "channel");
  assert.equal(normalized.agentStack.runtimeConfig.claudeOAuthSession.inactivityTimeoutMs, 45_000);
  assert.equal(normalized.agentStack.runtimeConfig.claudeOAuthSession.contextPruningStrategy, "sliding_window");
  assert.equal(normalized.agentStack.runtimeConfig.claudeOAuthSession.maxPinnedStateChars, 18_000);
  assert.equal(normalized.agentStack.runtimeConfig.claudeOAuthSession.voiceToolPolicy, "fast_only");
  assert.equal(normalized.agentStack.runtimeConfig.claudeOAuthSession.textToolPolicy, "full");
  assert.equal(normalized.voice.admission.mode, "generation_decides");
  assert.equal(normalized.agentStack.overrides.voiceAdmissionClassifier, undefined);
  assert.deepEqual(normalized.agentStack.runtimeConfig.voice.generation, {
    mode: "dedicated_model",
    model: {
      provider: "claude-oauth",
      model: "claude-sonnet-4-6"
    }
  });
});

test("normalizeSettings preserves canonical command-only and automation toggles", () => {
  const normalized = normalizeLegacyView({
    voice: {
      commandOnlyMode: true,
      defaultInterruptionMode: "uninterruptible"
    },
    automations: {
      enabled: false
    }
  });

  assert.equal(normalized.voice.conversationPolicy.commandOnlyMode, true);
  assert.equal(normalized.voice.conversationPolicy.defaultInterruptionMode, "none");
  assert.equal(normalized.automations.enabled, false);
});

test("normalizeSettings dedupes guidance and preserves discovery source booleans", () => {
  const normalized = normalizeLegacyView({
    memoryLlm: {},
    discovery: {
      sources: {
        reddit: undefined,
        hackerNews: undefined,
        youtube: undefined,
        rss: undefined,
        x: undefined
      }
    },
    prompt: {
      textGuidance: ["  one ", "one", "", "two"],
      voiceGuidance: [" alpha ", "alpha", "beta"],
      voiceOperationalGuidance: ["a", "a", "b"]
    }
  });

  assert.deepEqual(normalized.prompting.text.guidance, ["one", "two"]);
  assert.deepEqual(normalized.prompting.voice.guidance, ["alpha", "beta"]);
  assert.deepEqual(normalized.prompting.voice.operationalGuidance, ["a", "b"]);
  assert.equal(typeof normalized.initiative.discovery.sources.reddit, "boolean");
  assert.equal(typeof normalized.initiative.discovery.sources.hackerNews, "boolean");
  assert.equal(typeof normalized.initiative.discovery.sources.youtube, "boolean");
  assert.equal(typeof normalized.initiative.discovery.sources.rss, "boolean");
  assert.equal(typeof normalized.initiative.discovery.sources.x, "boolean");
});

test("normalizeSettings leaves memoryLlm empty when no explicit override is configured", () => {
  const normalized = normalizeSettings({
    memoryLlm: {}
  });

  assert.deepEqual(normalized.memoryLlm, {});
});

test("normalizeSettings defaults reply max output tokens to 2500 and preserves higher values", () => {
  const defaulted = normalizeLegacyView({
    llm: {}
  });
  assert.equal(defaulted.interaction.replyGeneration.maxOutputTokens, 2500);

  const highValue = normalizeLegacyView({
    llm: {
      maxOutputTokens: 9_999
    }
  });
  assert.equal(highValue.interaction.replyGeneration.maxOutputTokens, 9_999);
});

test("normalizeSettings migrates voice generation useTextModel to inherit orchestrator", () => {
  const normalized = normalizeLegacyView({
    llm: {
      provider: "openai",
      model: "gpt-5"
    },
    voice: {
      generationLlm: {
        useTextModel: true,
        provider: "anthropic",
        model: "grok-3-mini-latest"
      }
    },
    replyFollowupLlm: {
      enabled: true,
      useTextModel: true,
      provider: "anthropic",
      model: "grok-3-mini-latest"
    }
  });

  const generation = normalized.agentStack.runtimeConfig.voice.generation as {
    mode: string;
    model?: { provider: string; model: string };
  };
  assert.equal(generation.mode, "inherit_orchestrator");
  assert.equal("useTextModel" in normalized.interaction.followup.execution, false);
});

test("normalizeSettings keeps elevenlabs voice runtime settings under canonical voice runtime config", () => {
  const normalized = normalizeLegacyView({
    voice: {
      voiceProvider: "elevenlabs",
      elevenLabsRealtime: {
        agentId: "   agent_abc   ",
        apiBaseUrl: "ftp://not-allowed.example/path",
        inputSampleRateHz: 200000,
        outputSampleRateHz: 4000
      }
    }
  });

  assert.equal(resolveAgentStack(normalized).voiceRuntime, "elevenlabs_realtime");
  assert.equal(normalized.agentStack.runtimeConfig.voice.runtimeMode, "elevenlabs_realtime");
  assert.equal(normalized.agentStack.runtimeConfig.voice.elevenLabsRealtime.agentId, "agent_abc");
  assert.equal(
    normalized.agentStack.runtimeConfig.voice.elevenLabsRealtime.apiBaseUrl,
    "https://api.elevenlabs.io"
  );
  assert.equal(normalized.agentStack.runtimeConfig.voice.elevenLabsRealtime.inputSampleRateHz, 96000);
  assert.equal(normalized.agentStack.runtimeConfig.voice.elevenLabsRealtime.outputSampleRateHz, 8000);
});

test("normalizeSettings uses provider-specific memory model fallbacks", () => {
  const normalized = normalizeSettings({
    memoryLlm: {
      provider: "openai",
      model: ""
    }
  });

  assert.deepEqual(normalized.memoryLlm, {
    provider: "openai",
    model: "gpt-5-mini"
  });
});

test("normalizeSettings drops removed replyDecisionLlm prompts and migrates enabled false to generation_decides", () => {
  const normalized = normalizeLegacyView({
    voice: {
      replyDecisionLlm: {
        enabled: false,
        prompts: {
          wakeVariantHint: "custom wake rule",
          systemPromptCompact: "compact prompt"
        }
      }
    }
  });

  assert.equal(normalized.voice.admission.mode, "generation_decides");
  assert.equal(normalized.voice.admission.musicWakeLatchSeconds, 15);
});

test("normalizeSettings preserves long media prompt craft guidance blocks", () => {
  const longGuidance = `line one\n${"x".repeat(1200)}\nline three`;
  const normalized = normalizeLegacyView({
    prompt: {
      mediaPromptCraftGuidance: longGuidance
    }
  });

  assert.equal(normalized.prompting.media.promptCraftGuidance, longGuidance);
});

test("normalizeSettings allows longer persona flavor values", () => {
  const withinLimit = "x".repeat(PERSONA_FLAVOR_MAX_CHARS);
  const normalizedWithinLimit = normalizeLegacyView({
    persona: {
      flavor: withinLimit
    }
  });
  assert.equal(normalizedWithinLimit.persona.flavor, withinLimit);

  const overLimit = `${"y".repeat(PERSONA_FLAVOR_MAX_CHARS)}overflow`;
  const normalizedOverLimit = normalizeLegacyView({
    persona: {
      flavor: overLimit
    }
  });
  assert.equal(normalizedOverLimit.persona.flavor.length, PERSONA_FLAVOR_MAX_CHARS);
});

test("normalizeSettings supports auto and fixed ASR language guidance in the canonical voice schema", () => {
  const autoHint = normalizeLegacyView({
    voice: {
      asrLanguageMode: "auto",
      asrLanguageHint: "EN"
    }
  });
  assert.equal(autoHint.voice.transcription.languageMode, "auto");
  assert.equal(autoHint.voice.transcription.languageHint, "en");

  const fixedHint = normalizeLegacyView({
    voice: {
      asrLanguageMode: "fixed",
      asrLanguageHint: "en-US"
    }
  });
  assert.equal(fixedHint.voice.transcription.languageMode, "fixed");
  assert.equal(fixedHint.voice.transcription.languageHint, "en-us");

  const invalid = normalizeLegacyView({
    voice: {
      asrLanguageMode: "not-real",
      asrLanguageHint: "!!!!!!"
    }
  });
  assert.equal(invalid.voice.transcription.languageMode, "auto");
  assert.equal(invalid.voice.transcription.languageHint, "en");
});

test("normalizeSettings migrates legacy split initiative pacing and channels into the unified initiative model", () => {
  const normalized = normalizeSettings({
    permissions: {
      replies: {
        replyChannelIds: ["reply-1"]
      }
    },
    initiative: {
      text: {
        minMinutesBetweenThoughts: 15,
        maxThoughtsPerDay: 2
      },
      discovery: {
        channelIds: ["disc-1"],
        minMinutesBetweenPosts: 45,
        maxPostsPerDay: 5,
        enabled: false,
        sources: {
          reddit: true,
          hackerNews: true,
          youtube: true,
          rss: true,
          x: true
        }
      }
    }
  });

  assert.deepEqual(normalized.permissions.replies.replyChannelIds, ["reply-1", "disc-1"]);
  assert.equal(normalized.initiative.text.minMinutesBetweenPosts, 45);
  assert.equal(normalized.initiative.text.maxPostsPerDay, 5);
  assert.deepEqual(normalized.initiative.discovery.sources, {
    reddit: false,
    hackerNews: false,
    youtube: false,
    rss: false,
    x: false
  });
});
