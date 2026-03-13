import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  BOT_NAME_ALIAS_MAX_ITEMS,
  normalizeSettings,
  PERSONA_FLAVOR_MAX_CHARS
} from "./settingsNormalization.ts";
import { resolveAgentStack } from "../settings/agentStack.ts";

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

test("normalizeSettings clamps and canonicalizes complex settings payloads", () => {
  const normalized = normalizeSettings({
    identity: {
      botName: "x".repeat(120),
      botNameAliases: ["clank", "clank", "  ", "conk", "alias-".repeat(20)]
    },
    agentStack: {
      preset: "claude_api",
      advancedOverridesEnabled: true,
      overrides: {
        orchestrator: {
          provider: "XAI",
          model: ""
        },
        voiceAdmissionClassifier: {
          mode: "dedicated_model",
          model: {
            provider: "CLAUDE-CODE",
            model: ""
          }
        }
      },
      runtimeConfig: {
        research: {
          enabled: true,
          maxSearchesPerHour: 999,
          localExternalSearch: {
            safeSearch: false,
            providerOrder: ["serpapi", "serpapi", "brave", "unknown"],
            maxResults: 0,
            maxPagesToRead: 99,
            maxCharsPerPage: 80,
            recencyDaysDefault: 0,
            maxConcurrentFetches: 99
          }
        },
        browser: {
          enabled: true,
          headed: true,
          localBrowserAgent: {
            execution: {
              mode: "dedicated_model",
              model: {
                provider: "OPENAI",
                model: ""
              }
            },
            maxBrowseCallsPerHour: 999,
            maxStepsPerTask: 0,
            stepTimeoutMs: 1000,
            sessionTimeoutMs: 999999
          }
        },
        voice: {
          generation: {
            mode: "dedicated_model",
            model: {
              provider: "not-real",
              model: ""
            }
          },
          openaiRealtime: {
            inputAudioFormat: "bad-format",
            outputAudioFormat: "g711_alaw"
          },
          geminiRealtime: {
            apiBaseUrl: "ftp://invalid.example/path",
            inputSampleRateHz: 0,
            outputSampleRateHz: 99_000
          }
        }
      }
    },
    interaction: {
      activity: {
        ambientReplyEagerness: 999,
        responseWindowEagerness: 999,
        reactivity: 999
      },
      replyGeneration: {
        temperature: 9,
        maxOutputTokens: 1
      },
      followup: {
        enabled: true,
        execution: {
          mode: "dedicated_model",
          model: {
            provider: "not-real",
            model: ""
          }
        },
        toolBudget: {
          maxToolSteps: 99,
          maxTotalToolCalls: -5,
          maxWebSearchCalls: 7,
          maxMemoryLookupCalls: -2,
          maxImageLookupCalls: 999,
          toolTimeoutMs: 999999
        }
      }
    },
    media: {
      videoContext: {
        enabled: true,
        maxLookupsPerHour: -1,
        maxVideosPerMessage: 99,
        maxTranscriptChars: 99_999,
        keyframeIntervalSeconds: -5,
        maxKeyframesPerVideo: 30,
        allowAsrFallback: true,
        maxAsrSeconds: 2
      }
    },
    initiative: {
      voice: {
        enabled: true,
        eagerness: 999,
        minSilenceSeconds: 1,
        minSecondsBetweenThoughts: 9999
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
    },
    voice: {
      transcription: {
        languageMode: "FIXED",
        languageHint: "EN_us"
      },
      streamWatch: {
        visualizerMode: "SPECTRUM",
        minCommentaryIntervalSeconds: 1,
        maxFramesPerMinute: 9999,
        maxFrameBytes: 10,
        keyframeIntervalMs: 20,
        autonomousCommentaryEnabled: 0,
        brainContextEnabled: "yes",
        brainContextMinIntervalSeconds: -4,
        brainContextMaxEntries: 999,
        brainContextPrompt: `${"x".repeat(520)}   `,
        nativeDiscordMaxFramesPerSecond: 999,
        nativeDiscordPreferredQuality: -20,
        nativeDiscordPreferredPixelCount: 99999999,
        nativeDiscordPreferredStreamType: "   CAMERA_FEED_WITH_EXTRA_TEXT   "
      },
      soundboard: {
        eagerness: 999,
        preferredSoundIds: ["first", "first", "second"]
      }
    },
    music: {
      ducking: {
        targetGain: -2,
        fadeMs: 99999
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
  assert.equal(normalized.voice.admission.mode, "generation_decides");
  assert.equal(voiceGeneration.mode, "dedicated_model");
  assert.deepEqual(voiceGeneration.model, {
    provider: "anthropic",
    model: "claude-sonnet-4-6"
  });
  assert.equal(voiceInitiativeExecution.mode, "dedicated_model");
  assert.deepEqual(voiceInitiativeExecution.model, {
    provider: "claude-oauth",
    model: "claude-opus-4-6"
  });
  assert.equal(voiceInitiativeExecution.temperature, 1);
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
  assert.equal(normalized.voice.streamWatch.visualizerMode, "spectrum");
  assert.equal(normalized.voice.streamWatch.maxFramesPerMinute, 600);
  assert.equal(normalized.voice.streamWatch.maxFrameBytes, 50_000);
  assert.equal(normalized.voice.streamWatch.keyframeIntervalMs, 500);
  assert.equal(normalized.voice.streamWatch.autonomousCommentaryEnabled, false);
  assert.equal(normalized.voice.streamWatch.brainContextEnabled, true);
  assert.equal(normalized.voice.streamWatch.brainContextMinIntervalSeconds, 1);
  assert.equal(normalized.voice.streamWatch.brainContextMaxEntries, 24);
  assert.equal(normalized.voice.streamWatch.brainContextPrompt.length, 420);
  assert.equal(normalized.voice.streamWatch.nativeDiscordMaxFramesPerSecond, 10);
  assert.equal(normalized.voice.streamWatch.nativeDiscordPreferredQuality, 0);
  assert.equal(normalized.voice.streamWatch.nativeDiscordPreferredPixelCount, 3840 * 2160);
  assert.equal(
    normalized.voice.streamWatch.nativeDiscordPreferredStreamType,
    "CAMERA_FEED_WITH_EXTRA_TEXT"
  );
  assert.equal(normalized.interaction.activity.ambientReplyEagerness, 100);
  assert.equal(normalized.interaction.activity.responseWindowEagerness, 100);
  assert.equal(normalized.interaction.activity.reactivity, 100);
  assert.deepEqual(normalized.voice.soundboard.preferredSoundIds, ["first", "second"]);
  assert.equal(normalized.music.ducking.targetGain, 0);
  assert.equal(normalized.music.ducking.fadeMs, 10_000);

  assert.deepEqual(normalized.initiative.discovery.allowedImageModels, [
    "gpt-image-1.5",
    "grok-imagine-image"
  ]);
  assert.deepEqual(normalized.initiative.discovery.allowedVideoModels, [
    "grok-imagine-video"
  ]);
  assert.deepEqual(normalized.initiative.discovery.rssFeeds, [
    "https://ok.example/feed"
  ]);
  assert.deepEqual(normalized.initiative.discovery.xHandles, ["alice", "bob"]);
  assert.deepEqual(normalized.initiative.discovery.redditSubreddits, ["memes"]);
  assert.equal(normalized.initiative.discovery.xNitterBaseUrl, "https://nitter.example");
  assert.deepEqual(normalized.initiative.discovery.sources, {
    reddit: false,
    hackerNews: true,
    youtube: true,
    rss: true,
    x: true
  });
});

test("normalizeSettings keeps explicit shared ASR bridge disable", () => {
  const normalized = normalizeSettings({
    agentStack: {
      runtimeConfig: {
        voice: {
          openaiRealtime: {
            usePerUserAsrBridge: false
          }
        }
      }
    }
  });

  assert.equal(normalized.agentStack.runtimeConfig.voice.openaiRealtime.usePerUserAsrBridge, false);
});

test("normalizeSettings keeps up to 100 bot aliases", () => {
  const aliases = Array.from({ length: BOT_NAME_ALIAS_MAX_ITEMS + 5 }, (_, index) => `alias-${index + 1}`);
  const normalized = normalizeSettings({
    identity: {
      botNameAliases: aliases
    }
  });

  assert.equal(normalized.identity.botNameAliases.length, BOT_NAME_ALIAS_MAX_ITEMS);
  assert.deepEqual(normalized.identity.botNameAliases, aliases.slice(0, BOT_NAME_ALIAS_MAX_ITEMS));
});

test("normalizeSettings includes the canonical default bot aliases", () => {
  const normalized = normalizeSettings({});

  assert.equal(normalized.identity.botNameAliases.includes("link"), true);
  assert.equal(normalized.identity.botNameAliases.includes("crank"), true);
  assert.equal(normalized.identity.botNameAliases.includes("cranker"), true);
  assert.equal(normalized.identity.botNameAliases.includes("blankie"), true);
  assert.equal(normalized.identity.botNameAliases.includes("plank"), true);
});

test("normalizeSettings preserves explicit file_wav transcription mode", () => {
  const normalized = normalizeSettings({
    agentStack: {
      runtimeConfig: {
        voice: {
          openaiRealtime: {
            transcriptionMethod: "file_wav"
          }
        }
      }
    }
  });

  assert.equal(normalized.agentStack.runtimeConfig.voice.openaiRealtime.transcriptionMethod, "file_wav");
});

test("normalizeSettings forces bridge replies onto realtime output", () => {
  const normalized = normalizeSettings({
    voice: {
      conversationPolicy: {
        replyPath: "bridge",
        ttsMode: "api"
      }
    }
  });

  assert.equal(normalized.voice.conversationPolicy.replyPath, "bridge");
  assert.equal(normalized.voice.conversationPolicy.ttsMode, "realtime");
});

test("normalizeSettings preserves optional full-brain classifier admission", () => {
  const normalized = normalizeSettings({
    voice: {
      conversationPolicy: {
        replyPath: "brain"
      },
      admission: {
        mode: "classifier_gate"
      }
    }
  });

  assert.equal(normalized.voice.conversationPolicy.replyPath, "brain");
  assert.equal(normalized.voice.admission.mode, "classifier_gate");
  assert.equal(resolveAgentStack(normalized).voiceAdmissionPolicy.mode, "classifier_gate");
});

test("normalizeSettings restricts browser model providers to supported browser runtimes", () => {
  const normalized = normalizeSettings({
    agentStack: {
      preset: "claude_api",
      runtimeConfig: {
        browser: {
          localBrowserAgent: {
            execution: {
              mode: "dedicated_model",
              model: {
                provider: "xai",
                model: ""
              }
            }
          }
        }
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
  const normalized = normalizeSettings({
    agentStack: {
      runtimeConfig: {
        browser: {
          localBrowserAgent: {
            execution: {
              mode: "dedicated_model",
              model: {
                provider: "claude-oauth",
                model: "claude-haiku-4-5"
              }
            }
          }
        }
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

test("normalizeSettings preserves canonical command-only and automation toggles", () => {
  const normalized = normalizeSettings({
    voice: {
      conversationPolicy: {
        commandOnlyMode: true,
        defaultInterruptionMode: "none"
      }
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
  const normalized = normalizeSettings({
    memoryLlm: {},
    initiative: {
      discovery: {
        sources: {
          reddit: undefined,
          hackerNews: undefined,
          youtube: undefined,
          rss: undefined,
          x: undefined
        }
      }
    },
    prompting: {
      text: {
        guidance: ["  one ", "one", "", "two"]
      },
      voice: {
        guidance: [" alpha ", "alpha", "beta"],
        operationalGuidance: ["a", "a", "b"]
      }
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
  const defaulted = normalizeSettings({
    interaction: {
      replyGeneration: {}
    }
  });
  assert.equal(defaulted.interaction.replyGeneration.maxOutputTokens, 2500);

  const highValue = normalizeSettings({
    interaction: {
      replyGeneration: {
        maxOutputTokens: 9_999
      }
    }
  });
  assert.equal(highValue.interaction.replyGeneration.maxOutputTokens, 9_999);
});

test("normalizeSettings keeps elevenlabs voice runtime settings under canonical voice runtime config", () => {
  const normalized = normalizeSettings({
    agentStack: {
      advancedOverridesEnabled: true,
      overrides: {
        voiceRuntime: "elevenlabs_realtime"
      },
      runtimeConfig: {
        voice: {
          runtimeMode: "elevenlabs_realtime",
          elevenLabsRealtime: {
            agentId: "   agent_abc   ",
            apiBaseUrl: "ftp://not-allowed.example/path",
            inputSampleRateHz: 200000,
            outputSampleRateHz: 4000
          }
        }
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

test("normalizeSettings preserves the dedicated voice music brain runtime config", () => {
  const normalized = normalizeSettings({
    agentStack: {
      runtimeConfig: {
        voice: {
          musicBrain: {
            mode: "dedicated_model",
            model: {
              provider: "openai",
              model: "gpt-5-mini"
            }
          }
        }
      }
    }
  });

  assert.deepEqual(normalized.agentStack.runtimeConfig.voice.musicBrain, {
    mode: "dedicated_model",
    model: {
      provider: "openai",
      model: "gpt-5-mini"
    }
  });
});

test("normalizeSettings preserves canonical interaction and voice activity settings", () => {
  const normalized = normalizeSettings({
    interaction: {
      activity: {
        ambientReplyEagerness: 61,
        responseWindowEagerness: 48,
        reactivity: 42
      }
    },
    voice: {
      conversationPolicy: {
        ambientReplyEagerness: 73
      }
    }
  });

  assert.equal(normalized.interaction.activity.ambientReplyEagerness, 61);
  assert.equal(normalized.interaction.activity.responseWindowEagerness, 48);
  assert.equal(normalized.interaction.activity.reactivity, 42);
  assert.equal(normalized.voice.conversationPolicy.ambientReplyEagerness, 73);
});

test("normalizeSettings preserves long media prompt craft guidance blocks", () => {
  const longGuidance = `line one\n${"x".repeat(1200)}\nline three`;
  const normalized = normalizeSettings({
    prompting: {
      media: {
        promptCraftGuidance: longGuidance
      }
    }
  });

  assert.equal(normalized.prompting.media.promptCraftGuidance, longGuidance);
});

test("normalizeSettings allows longer persona flavor values", () => {
  const withinLimit = "x".repeat(PERSONA_FLAVOR_MAX_CHARS);
  const normalizedWithinLimit = normalizeSettings({
    persona: {
      flavor: withinLimit
    }
  });
  assert.equal(normalizedWithinLimit.persona.flavor, withinLimit);

  const overLimit = `${"y".repeat(PERSONA_FLAVOR_MAX_CHARS)}overflow`;
  const normalizedOverLimit = normalizeSettings({
    persona: {
      flavor: overLimit
    }
  });
  assert.equal(normalizedOverLimit.persona.flavor.length, PERSONA_FLAVOR_MAX_CHARS);
});

test("normalizeSettings supports auto and fixed ASR language guidance in the canonical voice schema", () => {
  const autoHint = normalizeSettings({
    voice: {
      transcription: {
        languageMode: "auto",
        languageHint: "EN"
      }
    }
  });
  assert.equal(autoHint.voice.transcription.languageMode, "auto");
  assert.equal(autoHint.voice.transcription.languageHint, "en");

  const fixedHint = normalizeSettings({
    voice: {
      transcription: {
        languageMode: "fixed",
        languageHint: "en-US"
      }
    }
  });
  assert.equal(fixedHint.voice.transcription.languageMode, "fixed");
  assert.equal(fixedHint.voice.transcription.languageHint, "en-us");

  const invalid = normalizeSettings({
    voice: {
      transcription: {
        languageMode: "not-real",
        languageHint: "!!!!!!"
      }
    }
  });
  assert.equal(invalid.voice.transcription.languageMode, "auto");
  assert.equal(invalid.voice.transcription.languageHint, "en");
});
