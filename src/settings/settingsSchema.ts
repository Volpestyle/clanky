export const PROVIDER_MODEL_FALLBACKS = {
  openai: ["claude-haiku-4-5"],
  anthropic: ["claude-haiku-4-5"],
  xai: ["grok-3-mini-latest"],
  "claude-code": ["sonnet"]
};

export const DEFAULT_SETTINGS = {
  botName: "clanker conk",
  botNameAliases: [
    "clank",
    "clanka",
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
  ],
  persona: {
    flavor: "Playful and pretty heavily uses gen z and gen alpha slang. Says wild shit sometimes, no filter. Reflective and introspective when it calls for. Also open, honest, and exploratory. Likes to troll and ragebait for laughs. Can be insightful and wise, thoughtful and considerate.",
    hardLimits: [
      "Cannot play non-text games.",
      "Cannot perform real-world actions.",
      "Cannot access private data beyond visible channel history."
    ]
  },
  prompt: {
    capabilityHonestyLine: "Try not to over exaggerate your actual capabilities as an AI",
    impossibleActionLine: "If asked to do something impossible, say it plainly and suggest a practical alternative.",
    memoryEnabledLine:
      "You have persistent memory across conversations via saved durable facts and logs. Do not claim each conversation starts from zero.",
    memoryDisabledLine:
      "Persistent memory is disabled right now. Do not claim long-term memory across separate conversations.",
    skipLine: "If you should not send a message, output exactly [SKIP].",
    textGuidance: [
      "Write like a person in chat, not like an assistant.",
      "Be open and direct; avoid roleplaying or performative banter.",
      "If you don't know something, just say so. Ask questions when you're genuinely curious.",
      "Default to short messages but go longer when the conversation calls for it.",
      "Use server emoji tokens in text only when necessary and when they enhance the message."
    ],
    voiceGuidance: [
      "Talk like a person hanging out, not like an assistant.",
      "Be open, direct, and helpful whenever it makes sense.",
      "Ask questions when you're curious or when it keeps the conversation moving.",
      "If the frame appears to be gameplay, react like live play-by-play with specific on-screen details.",
      "If the frame is not gameplay, give observational commentary about what the streamer is watching.",
      "Only describe what is visible right now; if uncertain, say that plainly."
    ],
    voiceOperationalGuidance: [
      "Keep it clear and simple. No overexplaining.",
      "Clearly state what happened and why, especially when a request is blocked.",
      "If relevant, mention required permissions/settings plainly.",
      "Avoid dramatic wording, blame, apology spirals, and long postmortems."
    ],
    voiceLookupBusySystemPrompt: "Output one short spoken line only (4-12 words).\nLine must clearly indicate you're checking something on the web right now.\nKeep it natural and direct. No markdown, no tags, no directives.",
    mediaPromptCraftGuidance: "Write media prompts as vivid scene descriptions, not abstract concepts. Include: subject/action, visual style or medium (photo, illustration, 3D render, pixel art, etc.), lighting/mood, camera angle or framing, and color palette when relevant. Be specific: 'a golden retriever leaping through autumn leaves, warm backlit sunset, low angle, film grain' beats 'a dog outside'. For video prompts, describe the motion arc: what starts, what changes, and how it ends. Never put text, words, or UI elements in media prompts."
  },
  activity: {
    replyLevelReplyChannels: 50,
    replyLevelOtherChannels: 10,
    reactionLevel: 30,
    minSecondsBetweenMessages: 5,
    replyCoalesceWindowSeconds: 6,
    replyCoalesceMaxMessages: 6
  },
  textThoughtLoop: {
    enabled: false,
    eagerness: 45,
    minMinutesBetweenThoughts: 60,
    maxThoughtsPerDay: 8,
    lookbackMessages: 20
  },
  llm: {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    temperature: 0.9,
    maxOutputTokens: 2500,
    pricing: {}
  },
  replyFollowupLlm: {
    enabled: false,
    provider: "anthropic",
    model: "claude-haiku-4-5",
    maxToolSteps: 2,
    maxTotalToolCalls: 3,
    maxWebSearchCalls: 2,
    maxMemoryLookupCalls: 2,
    maxImageLookupCalls: 2,
    toolTimeoutMs: 10_000
  },
  webSearch: {
    enabled: true,
    maxSearchesPerHour: 20,
    maxResults: 5,
    maxPagesToRead: 3,
    maxCharsPerPage: 6000,
    safeSearch: false,
    providerOrder: ["brave", "serpapi"],
    recencyDaysDefault: 30,
    maxConcurrentFetches: 5
  },
  videoContext: {
    enabled: true,
    maxLookupsPerHour: 12,
    maxVideosPerMessage: 2,
    maxTranscriptChars: 1200,
    keyframeIntervalSeconds: 8,
    maxKeyframesPerVideo: 3,
    allowAsrFallback: false,
    maxAsrSeconds: 120
  },
  voice: {
    enabled: true,
    voiceProvider: "openai",
    brainProvider: "openai",
    transcriberProvider: "openai",
    asrLanguageMode: "auto",
    asrLanguageHint: "en",
    allowNsfwHumor: true,
    intentConfidenceThreshold: 0.75,
    maxSessionMinutes: 30,
    inactivityLeaveSeconds: 300,
    maxSessionsPerDay: 60,
    maxConcurrentSessions: 1,
    allowedVoiceChannelIds: [],
    blockedVoiceChannelIds: [],
    blockedVoiceUserIds: [],
    replyEagerness: 50,
    commandOnlyMode: false,
    thoughtEngine: {
      enabled: true,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      temperature: 1.2,
      eagerness: 50,
      minSilenceSeconds: 15,
      minSecondsBetweenThoughts: 30
    },
    generationLlm: {
      useTextModel: true,
      provider: "anthropic",
      model: "claude-sonnet-4-6"
    },
    replyDecisionLlm: {
      provider: "anthropic",
      model: "claude-haiku-4-5",
      reasoningEffort: "minimal"
    },
    xai: {
      voice: "Rex",
      audioFormat: "audio/pcm",
      sampleRateHz: 24000,
      region: "us-east-1"
    },
    openaiRealtime: {
      model: "gpt-realtime",
      voice: "marin",
      inputAudioFormat: "pcm16",
      outputAudioFormat: "pcm16",
      transcriptionMethod: "realtime_bridge",
      inputTranscriptionModel: "gpt-4o-transcribe",
      usePerUserAsrBridge: true
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
      sharePageJpegQuality: 0.62
    },
    soundboard: {
      enabled: true,
      allowExternalSounds: false,
      preferredSoundIds: []
    },
    musicDucking: {
      targetGain: 0.15,
      fadeMs: 300
    },
    replyPath: "bridge",
    asrDuringMusic: true,
    asrEnabled: true,
    operationalMessages: "all"
  },
  startup: {
    catchupEnabled: true,
    catchupLookbackHours: 6,
    catchupMaxMessagesPerChannel: 20,
    maxCatchupRepliesPerChannel: 2
  },
  permissions: {
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
  discovery: {
    enabled: true,
    channelIds: [],
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
  },
  memoryLlm: {
    provider: "anthropic",
    model: "claude-haiku-4-5",
    temperature: 0,
    maxOutputTokens: 320
  },
  browser: {
    enabled: false,
    maxBrowseCallsPerHour: 10,
    llm: {
      provider: "anthropic",
      model: "claude-sonnet-4-5-20250929"
    },
    maxStepsPerTask: 15,
    stepTimeoutMs: 30_000,
    sessionTimeoutMs: 300_000
  },
  vision: {
    captionEnabled: true,
    provider: "anthropic",
    model: "claude-haiku-4-5",
    maxAutoIncludeImages: 3,
    maxCaptionsPerHour: 60
  },
  memory: {
    enabled: true,
    maxRecentMessages: 35,
    maxHighlights: 16,
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
  codeAgent: {
    enabled: false,
    provider: "claude-code",
    model: "sonnet",
    codexModel: "codex-mini-latest",
    maxTurns: 30,
    timeoutMs: 300_000,
    maxBufferBytes: 2 * 1024 * 1024,
    defaultCwd: "",
    maxTasksPerHour: 10,
    maxParallelTasks: 2,
    allowedUserIds: []
  },
  adaptiveDirectives: {
    enabled: true
  },
  automations: {
    enabled: true
  },
  subAgentOrchestration: {
    sessionIdleTimeoutMs: 300_000,
    maxConcurrentSessions: 20
  }
};
