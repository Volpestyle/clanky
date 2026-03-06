export const PROVIDER_MODEL_FALLBACKS = {
  openai: ["gpt-5-mini", "gpt-5", "gpt-4.1-mini"],
  anthropic: ["claude-haiku-4-5", "claude-sonnet-4-6"],
  claude_code_session: ["max"],
  xai: ["grok-3-mini-latest"],
  "claude-code": ["sonnet"],
  codex: ["gpt-5-codex"]
} as const;

export const AGENT_STACK_PRESETS = [
  "openai_native",
  "anthropic_brain_openai_tools",
  "claude_code_max",
  "custom"
] as const;

export const AGENT_HARNESS_KINDS = ["internal", "openai_agents", "claude_code_session"] as const;

export const MODEL_PROVIDER_KINDS = [
  "openai",
  "anthropic",
  "ai_sdk_anthropic",
  "litellm",
  "claude_code_session",
  "xai",
  "claude-code",
  "codex"
] as const;

export const RESEARCH_RUNTIME_KINDS = [
  "openai_native_web_search",
  "local_external_search"
] as const;

export const BROWSER_RUNTIME_KINDS = [
  "openai_computer_use",
  "local_browser_agent"
] as const;

export const VOICE_RUNTIME_KINDS = [
  "openai_realtime",
  "voice_agent",
  "gemini_realtime",
  "elevenlabs_realtime",
  "stt_pipeline"
] as const;

export const VOICE_ADMISSION_MODES = [
  "deterministic_only",
  "classifier_gate",
  "generation_decides",
  "adaptive"
] as const;

export const CODING_WORKER_RUNTIME_KINDS = [
  "codex",
  "claude_code"
] as const;

type Primitive = string | number | boolean | bigint | symbol | null | undefined;

type WidenLiteral<T> =
  T extends string ? string :
  T extends number ? number :
  T extends boolean ? boolean :
  T;

type DeepWiden<T> =
  T extends Primitive ? WidenLiteral<T> :
  T extends readonly (infer U)[] ? readonly DeepWiden<[U] extends [never] ? string : U>[] :
  T extends object ? { [K in keyof T]: DeepWiden<T[K]> } :
  T;

type DeepPartial<T> =
  T extends Primitive ? T :
  T extends readonly (infer U)[] ? readonly DeepPartial<U>[] :
  T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } :
  T;

export type SettingsModelBinding = {
  provider: string;
  model: string;
};

type SettingsExecutionTuning = {
  temperature?: number;
  maxOutputTokens?: number;
  reasoningEffort?: string;
};

export type SettingsExecutionPolicy =
  | ({
      mode: "inherit_orchestrator";
    } & SettingsExecutionTuning)
  | ({
      mode: "dedicated_model";
      model: SettingsModelBinding;
    } & SettingsExecutionTuning);

export const DEFAULT_SETTINGS = {
  identity: {
    botName: "clanker conk",
    botNameAliases: [
      "clank",
      "clanka",
      "klanker",
      "klinker",
      "clunk",
      "clunka",
      "clink",
      "clinka",
      "clenk",
      "clenka",
      "clunky",
      "clanky",
      "clinky",
      "clonky",
      "clinkerton",
      "clinkeroni",
      "clenker",
      "clonk",
      "clonker",
      "clay",
      "clayton",
      "plonka",
      "planker",
      "plinker"
    ]
  },
  persona: {
    flavor:
      "Starting template: Same vibes as 'Crush', the turtle from Findind Nemo. Laid back, playful and pretty heavily uses gen z and gen alpha slang. Says wild shit sometimes, no filter. Reflective and introspective when it calls for. Also open, honest, and exploratory. Likes to mess with people for laughs. Can be open, insightful and wise, thoughtful and considerate.",
    hardLimits: []
  },
  prompting: {
    global: {
      capabilityHonestyLine: "Try not to over exaggerate your actual capabilities as an AI",
      impossibleActionLine:
        "If asked to do something impossible, say it plainly and suggest a practical alternative.",
      memoryEnabledLine:
        "You have persistent memory across conversations via saved durable facts and logs. Do not claim each conversation starts from zero.",
      memoryDisabledLine:
        "Persistent memory is disabled right now. Do not claim long-term memory across separate conversations.",
      skipLine: "If you should not send a message, output exactly [SKIP]."
    },
    text: {
      guidance: [
        "Write like a person in chat, not like an assistant.",
        "If you don't know something, just say so. Ask questions when you're genuinely curious.",
        "Use server emoji tokens in text only when necessary and when they enhance the message."
      ]
    },
    voice: {
      guidance: [
        "Talk like a person hanging out, not like an assistant.",
        "Be open, direct, and helpful whenever it makes sense.",
        "Ask questions when you're curious or when it keeps the conversation moving.",
        "If the frame appears to be gameplay, react like live play-by-play with specific on-screen details.",
        "If the frame is not gameplay, give observational commentary about what the streamer is watching.",
        "Only describe what is visible right now; if uncertain, say that plainly."
      ],
      operationalGuidance: [
        "Keep it clear and simple. No overexplaining.",
        "Clearly state what happened and why, especially when a request is blocked.",
        "If relevant, mention required permissions/settings plainly.",
        "Avoid dramatic wording, blame, apology spirals, and long postmortems."
      ],
      lookupBusySystemPrompt:
        "Output one short spoken line only (4-12 words).\nLine must clearly indicate you're checking something on the web right now.\nKeep it natural and direct. No markdown, no tags, no directives."
    },
    media: {
      promptCraftGuidance:
        "Write media prompts as vivid scene descriptions, not abstract concepts. Include: subject/action, visual style or medium (photo, illustration, 3D render, pixel art, etc.), lighting/mood, camera angle or framing, and color palette when relevant. Be specific: 'a golden retriever leaping through autumn leaves, warm backlit sunset, low angle, film grain' beats 'a dog outside'. For video prompts, describe the motion arc: what starts, what changes, and how it ends. Never put text, words, or UI elements in media prompts."
    }
  },
  permissions: {
    replies: {
      allowReplies: true,
      allowUnsolicitedReplies: true,
      allowReactions: true,
      replyChannelIds: [
        "1475944808198574205",
        "1233219199070113882",
        "1052402898140667906",
        "1442040880017051769",
        "1214966391057162270",
        "1299162736583770166"
      ],
      allowedChannelIds: [],
      blockedChannelIds: [],
      blockedUserIds: [],
      maxMessagesPerHour: 20,
      maxReactionsPerHour: 24
    },
    devTasks: {
      allowedUserIds: []
    }
  },
  interaction: {
    activity: {
      replyEagerness: 20,
      reactionLevel: 40,
      minSecondsBetweenMessages: 5,
      replyCoalesceWindowSeconds: 6,
      replyCoalesceMaxMessages: 6
    },
    replyGeneration: {
      temperature: 0.9,
      maxOutputTokens: 2500,
      reasoningEffort: "minimal",
      pricing: {}
    },
    followup: {
      enabled: false,
      execution: {
        mode: "dedicated_model",
        model: {
          provider: "anthropic",
          model: "claude-haiku-4-5"
        }
      },
      toolBudget: {
        maxToolSteps: 2,
        maxTotalToolCalls: 3,
        maxWebSearchCalls: 2,
        maxMemoryLookupCalls: 2,
        maxImageLookupCalls: 2,
        toolTimeoutMs: 10_000
      }
    },
    startup: {
      catchupEnabled: true,
      catchupLookbackHours: 6,
      catchupMaxMessagesPerChannel: 20,
      maxCatchupRepliesPerChannel: 2
    },
    sessions: {
      sessionIdleTimeoutMs: 300_000,
      maxConcurrentSessions: 20
    }
  },
  agentStack: {
    preset: "openai_native",
    advancedOverridesEnabled: true,
    overrides: {
      orchestrator: {
        provider: "anthropic",
        model: "claude-sonnet-4-6"
      },
      devTeam: {
        codingWorkers: ["codex", "claude_code"],
        orchestrator: {
          provider: "anthropic",
          model: "claude-sonnet-4-6"
        }
      },
      voiceAdmissionClassifier: {
        mode: "dedicated_model",
        model: {
          provider: "anthropic",
          model: "claude-haiku-4-5"
        }
      }
    },
    runtimeConfig: {
      research: {
        enabled: true,
        maxSearchesPerHour: 20,
        openaiNativeWebSearch: {
          userLocation: "",
          allowedDomains: []
        },
        localExternalSearch: {
          safeSearch: false,
          providerOrder: ["brave", "serpapi"],
          maxResults: 5,
          maxPagesToRead: 3,
          maxCharsPerPage: 6000,
          recencyDaysDefault: 30,
          maxConcurrentFetches: 5
        }
      },
      browser: {
        enabled: true,
        openaiComputerUse: {
          model: "gpt-5.4"
        },
        localBrowserAgent: {
          execution: {
            mode: "dedicated_model",
            model: {
              provider: "anthropic",
              model: "claude-sonnet-4-5-20250929"
            }
          },
          maxBrowseCallsPerHour: 10,
          maxStepsPerTask: 10,
          stepTimeoutMs: 30_000,
          sessionTimeoutMs: 300_000
        }
      },
      voice: {
        runtimeMode: "openai_realtime",
        openaiRealtime: {
          model: "gpt-realtime",
          voice: "ash",
          inputAudioFormat: "pcm16",
          outputAudioFormat: "pcm16",
          transcriptionMethod: "realtime_bridge",
          inputTranscriptionModel: "gpt-4o-mini-transcribe",
          usePerUserAsrBridge: true
        },
        xai: {
          voice: "Rex",
          audioFormat: "audio/pcm",
          sampleRateHz: 24000,
          region: "us-east-1"
        },
        elevenLabsRealtime: {
          agentId: "",
          voiceId: "",
          apiBaseUrl: "https://api.elevenlabs.io",
          inputSampleRateHz: 16000,
          outputSampleRateHz: 16000
        },
        geminiRealtime: {
          model: "gemini-2.5-flash-native-audio-preview-12-2025",
          voice: "Aoede",
          apiBaseUrl: "https://generativelanguage.googleapis.com",
          inputSampleRateHz: 16000,
          outputSampleRateHz: 24000
        },
        sttPipeline: {
          transcriptionModel: "gpt-4o-mini-transcribe",
          ttsModel: "gpt-4o-mini-tts",
          ttsVoice: "alloy",
          ttsSpeed: 1
        },
        generation: {
          mode: "dedicated_model",
          model: {
            provider: "anthropic",
            model: "claude-haiku-4-5"
          }
        }
      },
      claudeCodeSession: {
        sessionScope: "guild",
        inactivityTimeoutMs: 1_800_000,
        contextPruningStrategy: "summarize",
        maxPinnedStateChars: 12_000,
        voiceToolPolicy: "fast_only",
        textToolPolicy: "full"
      },
      devTeam: {
        codex: {
          enabled: false,
          model: "codex-mini-latest",
          maxTurns: 30,
          timeoutMs: 300_000,
          maxBufferBytes: 2 * 1024 * 1024,
          defaultCwd: "",
          maxTasksPerHour: 10,
          maxParallelTasks: 2
        },
        claudeCode: {
          enabled: false,
          model: "sonnet",
          maxTurns: 30,
          timeoutMs: 300_000,
          maxBufferBytes: 2 * 1024 * 1024,
          defaultCwd: "",
          maxTasksPerHour: 10,
          maxParallelTasks: 2
        }
      }
    }
  },
  memory: {
    enabled: true,
    promptSlice: {
      maxRecentMessages: 35,
      maxHighlights: 16
    },
    execution: {
      mode: "dedicated_model",
      model: {
        provider: "anthropic",
        model: "claude-haiku-4-5"
      },
      temperature: 0,
      maxOutputTokens: 320
    },
    extraction: {
      enabled: true
    },
    embeddingModel: "text-embedding-3-small",
    reflection: {
      enabled: true,
      strategy: "two_pass_extract_then_main",
      hour: 4,
      minute: 0,
      maxFactsPerReflection: 20
    },
    dailyLogRetentionDays: 30
  },
  directives: {
    enabled: true
  },
  initiative: {
    text: {
      enabled: true,
      execution: {
        mode: "inherit_orchestrator"
      },
      eagerness: 20,
      minMinutesBetweenThoughts: 60,
      maxThoughtsPerDay: 2,
      lookbackMessages: 20
    },
    voice: {
      enabled: false,
      execution: {
        mode: "dedicated_model",
        model: {
          provider: "anthropic",
          model: "claude-sonnet-4-6"
        },
        temperature: 1
      },
      eagerness: 50,
      minSilenceSeconds: 45,
      minSecondsBetweenThoughts: 60
    },
    discovery: {
      enabled: true,
      channelIds: ["1475944808198574205"],
      maxPostsPerDay: 1,
      minMinutesBetweenPosts: 120,
      pacingMode: "even",
      spontaneity: 65,
      postOnStartup: false,
      allowImagePosts: true,
      allowVideoPosts: true,
      allowReplyImages: true,
      allowReplyVideos: true,
      allowReplyGifs: true,
      maxImagesPerDay: 10,
      maxVideosPerDay: 10,
      maxGifsPerDay: 60,
      simpleImageModel: "gpt-image-1.5",
      complexImageModel: "grok-imagine-image",
      videoModel: "grok-imagine-video",
      allowedImageModels: ["gpt-image-1.5", "grok-imagine-image", "grok-2-image-1212"],
      allowedVideoModels: ["grok-imagine-video", "grok-2-video"],
      maxMediaPromptChars: 900,
      linkChancePercent: 80,
      maxLinksPerPost: 2,
      maxCandidatesForPrompt: 6,
      freshnessHours: 96,
      dedupeHours: 168,
      randomness: 55,
      sourceFetchLimit: 10,
      allowNsfw: false,
      preferredTopics: [],
      redditSubreddits: ["technology", "programming", "games", "memes"],
      youtubeChannelIds: [],
      rssFeeds: [
        "https://www.theverge.com/rss/index.xml",
        "https://feeds.arstechnica.com/arstechnica/index"
      ],
      xHandles: [],
      xNitterBaseUrl: "https://nitter.net",
      sources: {
        reddit: true,
        hackerNews: true,
        youtube: true,
        rss: true,
        x: false
      }
    }
  },
  voice: {
    enabled: true,
    transcription: {
      enabled: true,
      languageMode: "auto",
      languageHint: "en"
    },
    channelPolicy: {
      allowedChannelIds: [],
      blockedChannelIds: [],
      blockedUserIds: []
    },
    sessionLimits: {
      maxSessionMinutes: 30,
      inactivityLeaveSeconds: 300,
      maxSessionsPerDay: 120,
      maxConcurrentSessions: 3
    },
    conversationPolicy: {
      replyEagerness: 50,
      commandOnlyMode: false,
      allowNsfwHumor: true,
      textOnlyMode: false,
      replyPath: "brain",
      ttsMode: "realtime",
      operationalMessages: "minimal"
    },
    admission: {
      mode: "classifier_gate",
      wakeSignals: [
        "direct_address",
        "followup_latch",
        "focused_speaker",
        "command_only",
        "music_wake"
      ],
      intentConfidenceThreshold: 0.75,
      musicWakeLatchSeconds: 15
    },
    streamWatch: {
      enabled: true,
      minCommentaryIntervalSeconds: 8,
      maxFramesPerMinute: 180,
      maxFrameBytes: 350000,
      commentaryPath: "auto",
      keyframeIntervalMs: 1200,
      autonomousCommentaryEnabled: true,
      brainContextEnabled: true,
      brainContextMinIntervalSeconds: 4,
      brainContextMaxEntries: 8,
      brainContextPrompt:
        "For each keyframe, classify it as gameplay or non-gameplay, then generate notes that support either play-by-play commentary or observational shout-out commentary.",
      sharePageMaxWidthPx: 960,
      sharePageJpegQuality: 0.6
    },
    soundboard: {
      enabled: true,
      allowExternalSounds: false,
      preferredSoundIds: []
    }
  },
  media: {
    vision: {
      enabled: true,
      execution: {
        mode: "dedicated_model",
        model: {
          provider: "anthropic",
          model: "claude-haiku-4-5"
        }
      },
      maxAutoIncludeImages: 3,
      maxCaptionsPerHour: 60
    },
    videoContext: {
      enabled: true,
      execution: {
        mode: "inherit_orchestrator"
      },
      maxLookupsPerHour: 12,
      maxVideosPerMessage: 2,
      maxTranscriptChars: 1200,
      keyframeIntervalSeconds: 8,
      maxKeyframesPerVideo: 3,
      allowAsrFallback: false,
      maxAsrSeconds: 120
    }
  },
  music: {
    ducking: {
      targetGain: 0.15,
      fadeMs: 300
    }
  },
  automations: {
    enabled: true
  }
} as const;

type SettingsFromDefaults = DeepWiden<typeof DEFAULT_SETTINGS>;

type SettingsInteraction = Omit<SettingsFromDefaults["interaction"], "replyGeneration" | "followup"> & {
  replyGeneration: Omit<SettingsFromDefaults["interaction"]["replyGeneration"], "pricing"> & {
    pricing: Record<string, unknown>;
  };
  followup: Omit<SettingsFromDefaults["interaction"]["followup"], "execution"> & {
    execution: SettingsExecutionPolicy;
  };
};

type SettingsAgentStack = Omit<SettingsFromDefaults["agentStack"], "overrides" | "runtimeConfig"> & {
  overrides: {
    orchestrator?: SettingsModelBinding;
    harness?: string;
    researchRuntime?: string;
    browserRuntime?: string;
    voiceRuntime?: string;
    voiceAdmissionClassifier?: SettingsExecutionPolicy;
    devTeam?: {
      orchestrator?: SettingsModelBinding;
      codingWorkers?: readonly string[];
    };
  };
  runtimeConfig: Omit<SettingsFromDefaults["agentStack"]["runtimeConfig"], "browser" | "voice"> & {
    browser: Omit<SettingsFromDefaults["agentStack"]["runtimeConfig"]["browser"], "localBrowserAgent"> & {
      localBrowserAgent: Omit<
        SettingsFromDefaults["agentStack"]["runtimeConfig"]["browser"]["localBrowserAgent"],
        "execution"
      > & {
        execution: SettingsExecutionPolicy;
      };
    };
    voice: Omit<SettingsFromDefaults["agentStack"]["runtimeConfig"]["voice"], "generation"> & {
      generation: SettingsExecutionPolicy;
    };
  };
};

type SettingsMemory = Omit<SettingsFromDefaults["memory"], "execution"> & {
  execution: SettingsExecutionPolicy;
};

type SettingsInitiative = Omit<SettingsFromDefaults["initiative"], "text" | "voice"> & {
  text: Omit<SettingsFromDefaults["initiative"]["text"], "execution"> & {
    execution: SettingsExecutionPolicy;
  };
  voice: Omit<SettingsFromDefaults["initiative"]["voice"], "execution"> & {
    execution: SettingsExecutionPolicy;
  };
};

type SettingsMedia = Omit<SettingsFromDefaults["media"], "vision" | "videoContext"> & {
  vision: Omit<SettingsFromDefaults["media"]["vision"], "execution"> & {
    execution: SettingsExecutionPolicy;
  };
  videoContext: Omit<SettingsFromDefaults["media"]["videoContext"], "execution"> & {
    execution: SettingsExecutionPolicy;
  };
};

export type Settings = Omit<
  SettingsFromDefaults,
  "interaction" | "agentStack" | "memory" | "initiative" | "media"
> & {
  interaction: SettingsInteraction;
  agentStack: SettingsAgentStack;
  memory: SettingsMemory;
  initiative: SettingsInitiative;
  media: SettingsMedia;
};

export type SettingsInput = DeepPartial<Settings>;
