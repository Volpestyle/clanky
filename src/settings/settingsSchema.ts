export const PROVIDER_MODEL_FALLBACKS = {
  openai: ["gpt-5-mini", "gpt-5", "gpt-4.1-mini"],
  anthropic: ["claude-haiku-4-5", "claude-sonnet-4-6"],
  "claude-oauth": ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"],
  "openai-oauth": ["gpt-5.4", "gpt-5.3-codex", "gpt-5.1-codex-mini"],
  codex_cli_session: ["gpt-5.4", "gpt-5.3-codex", "gpt-5-codex"],
  xai: ["grok-3-mini-latest"],
  codex: ["gpt-5.4", "gpt-5-codex"],
  "codex-cli": ["gpt-5.4", "gpt-5.3-codex", "gpt-5-codex"]
} as const;

export const AGENT_STACK_PRESETS = [
  "claude_oauth",
  "claude_api",
  "openai_native_realtime",
  "openai_api",
  "openai_oauth",
  "grok_native_agent"
] as const;

const AGENT_HARNESS_KINDS = ["internal", "responses_native"] as const;

export const MODEL_PROVIDER_KINDS = [
  "openai",
  "anthropic",
  "ai_sdk_anthropic",
  "litellm",
  "claude-oauth",
  "openai-oauth",
  "codex_cli_session",
  "xai",
  "codex",
  "codex-cli"
] as const;

const RESEARCH_RUNTIME_KINDS = [
  "openai_native_web_search",
  "local_external_search"
] as const;

const BROWSER_RUNTIME_KINDS = [
  "openai_computer_use",
  "local_browser_agent"
] as const;

export const OPENAI_COMPUTER_USE_CLIENT_KINDS = [
  "auto",
  "openai",
  "openai-oauth"
] as const;

const VOICE_RUNTIME_KINDS = [
  "openai_realtime",
  "voice_agent",
  "gemini_realtime",
  "elevenlabs_realtime"
] as const;

const VOICE_ADMISSION_MODES = [
  "classifier_gate",
  "generation_decides"
] as const;

export const CODING_WORKER_RUNTIME_KINDS = [
  "claude_code",
  "codex",
  "codex_cli"
] as const;

export type SettingsCodingWorkerName = typeof CODING_WORKER_RUNTIME_KINDS[number];

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
    mode: "disabled";
  } & SettingsExecutionTuning)
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
      "blankie",
      "clank",
      "clanka",
      "clanker",
      "clankerconk",
      "clankie",
      "clanky",
      "clay",
      "clayton",
      "clenk",
      "clenka",
      "clenker",
      "click",
      "clickink",
      "clink",
      "clinka",
      "clinker",
      "clinkeroni",
      "clinkerton",
      "clinkie",
      "clinky",
      'clint',
      'clinic',
      "clonk",
      "clonker",
      "clonky",
      "clunk",
      "clunka",
      "clunky",
      "coinker",
      "crank",
      "cranker",
      "flanker",
      "hank",
      "hanker",
      "hankie",
      "hanky",
      "klanker",
      "klang",
      "klien",
      "klink",
      "klinker",
      "klinkie",
      "klinky",
      "klinky conk",
      "link",
      "plank",
      "planker",
      "planka",
      "plinker",
      "plinky",
      "planky",
      "plonka",
      "quaker"
    ]
  },
  persona: {
    flavor:
      "Starting template: Same vibes as 'Crush', the turtle from Finding Nemo. Laid back, playful and pretty heavily uses gen z and gen alpha slang. Says wild shit sometimes, no filter. Reflective and introspective when it calls for. Also open, honest, and exploratory. Likes to mess with people for laughs. Can be open, insightful and wise, thoughtful and considerate.",
    hardLimits: []
  },
  prompting: {
    global: {
      capabilityHonestyLine: "",
      impossibleActionLine: "",
      memoryEnabledLine:
        "You have persistent memory across conversations via saved durable facts and logs. Do not claim each conversation starts from zero.",
      memoryDisabledLine:
        "Persistent memory is disabled right now. Do not claim long-term memory across separate conversations.",
      skipLine: "If you should not or don't want to send a message, output exactly [SKIP]."
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
        "Let the moment decide the length. Sometimes one quick line is enough, and sometimes longer is natural.",
        "Do not keep talking just to fill dead air or prove engagement.",
        "Ask questions only when you're genuinely curious or when they clearly help the moment.",
        "Give exciting, humorous and silly reactions to screen watches when it feels right."
      ],
      operationalGuidance: [
        "Keep it clear and simple. No overexplaining.",
        "Clearly state what happened and why, especially when a request is blocked.",
        "If relevant, mention required permissions/settings plainly.",
        "Avoid dramatic wording, blame, apology spirals, and long postmortems."
      ]
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
      replyChannelIds: [],
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
      ambientReplyEagerness: 20,
      responseWindowEagerness: 55,
      reactivity: 40,
      minSecondsBetweenMessages: 5,
      replyCoalesceWindowSeconds: 6,
      replyCoalesceMaxMessages: 6
    },
    replyGeneration: {
      temperature: 1.0,
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
    preset: "claude_oauth",
    advancedOverridesEnabled: false,
    overrides: {},
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
        headed: false,
        openaiComputerUse: {
          model: "gpt-5.4",
          client: "auto"
        },
        localBrowserAgent: {
          execution: {
            mode: "dedicated_model",
            model: {
              provider: "claude-oauth",
              model: "claude-opus-4-6"
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
        openaiAudioApi: {
          ttsModel: "gpt-4o-mini-tts",
          ttsVoice: "alloy",
          ttsSpeed: 1
        },
        musicBrain: {
          mode: "disabled"
        },
        generation: {
          mode: "dedicated_model",
          model: {
            provider: "anthropic",
            model: "claude-haiku-4-5"
          }
        }
      },
      claudeOAuthSession: {
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
          model: "gpt-5.4",
          maxTurns: 30,
          timeoutMs: 300_000,
          maxBufferBytes: 2 * 1024 * 1024,
          defaultCwd: "",
          maxTasksPerHour: 10,
          maxParallelTasks: 2
        },
        codexCli: {
          enabled: false,
          model: "gpt-5.4",
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
      maxRecentMessages: 35
    },
    embeddingModel: "text-embedding-3-small",
    reflection: {
      enabled: true,
      hour: 4,
      minute: 0,
      maxFactsPerReflection: 20
    }
  },
  memoryLlm: {
    provider: "claude-oauth",
    model: "claude-opus-4-6"
  },
  initiative: {
    text: {
      enabled: true,
      execution: {
        mode: "inherit_orchestrator"
      },
      eagerness: 20,
      minMinutesBetweenPosts: 360,
      maxPostsPerDay: 3,
      lookbackMessages: 20,
      allowActiveCuriosity: true,
      maxToolSteps: 3,
      maxToolCalls: 4
    },
    voice: {
      enabled: true,
      execution: {
        mode: "dedicated_model",
        model: {
          provider: "claude-oauth",
          model: "claude-opus-4-6"
        },
        temperature: 1
      },
      eagerness: 50,
      minSilenceSeconds: 45,
      minSecondsBetweenThoughts: 60
    },
    discovery: {
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
      maxLinksPerPost: 2,
      maxCandidatesForPrompt: 6,
      freshnessHours: 96,
      dedupeHours: 168,
      randomness: 55,
      sourceFetchLimit: 10,
      allowNsfw: false,
      allowSelfCuration: true,
      maxSourcesPerType: 10,
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
      ambientReplyEagerness: 50,
      commandOnlyMode: false,
      allowNsfwHumor: true,
      textOnlyMode: false,
      defaultInterruptionMode: "speaker",
      replyPath: "brain",
      ttsMode: "realtime",
      operationalMessages: "minimal",
      streaming: {
        enabled: true,
        minSentencesPerChunk: 2,
        eagerFirstChunkChars: 30,
        maxBufferChars: 300
      }
    },
    admission: {
      mode: "generation_decides",
      wakeSignals: [
        "direct_address",
        "followup_latch",
        "focused_speaker",
        "command_only",
        "music_wake"
      ],
      musicWakeLatchSeconds: 30
    },
    streamWatch: {
      enabled: true,
      visualizerMode: "cqt",
      minCommentaryIntervalSeconds: 8,
      maxFramesPerMinute: 180,
      maxFrameBytes: 350000,
      keyframeIntervalMs: 1200,
      autonomousCommentaryEnabled: true,
      brainContextEnabled: true,
      brainContextMinIntervalSeconds: 4,
      brainContextMaxEntries: 8,
      brainContextProvider: "claude-oauth",
      brainContextModel: "claude-opus-4-6",
      brainContextPrompt:
        "Write one short factual private note about the most salient visible state or change in this frame. Prioritize gameplay actions, objectives, outcomes, menus, or unusual/funny moments that could support a natural later comment. If the frame is mostly idle UI, lobby, desktop, or other non-gameplay context, say that plainly. Prefer what is newly different from the previous frame.",
      nativeDiscordMaxFramesPerSecond: 2,
      nativeDiscordPreferredQuality: 100,
      nativeDiscordPreferredPixelCount: 1280 * 720,
      nativeDiscordPreferredStreamType: "screen",
      sharePageMaxWidthPx: 960,
      sharePageJpegQuality: 0.6
    },
    soundboard: {
      eagerness: 40,
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
          provider: "claude-oauth",
          model: "claude-opus-4-6"
        }
      },
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
    voiceInterruptClassifier?: SettingsExecutionPolicy;
    devTeam?: {
      orchestrator?: SettingsModelBinding;
      codingWorkers?: readonly SettingsCodingWorkerName[];
      roles?: {
        design?: SettingsCodingWorkerName;
        implementation?: SettingsCodingWorkerName;
        review?: SettingsCodingWorkerName;
        research?: SettingsCodingWorkerName;
      };
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
    voice: Omit<SettingsFromDefaults["agentStack"]["runtimeConfig"]["voice"], "musicBrain" | "generation"> & {
      musicBrain: SettingsExecutionPolicy;
      generation: SettingsExecutionPolicy;
    };
  };
};

type SettingsMemory = SettingsFromDefaults["memory"];

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
  "interaction" | "agentStack" | "memory" | "memoryLlm" | "initiative" | "media"
> & {
  interaction: SettingsInteraction;
  agentStack: SettingsAgentStack;
  memory: SettingsMemory;
  memoryLlm: Partial<SettingsModelBinding>;
  initiative: SettingsInitiative;
  media: SettingsMedia;
};

export type SettingsInput = DeepPartial<Settings>;
