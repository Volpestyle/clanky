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
    "clunk",
    "clink",
    "clenk",
    "clunky",
    "clanky",
    "clinky",
    "clinkerton",
    "clinkeroni",
    "clenker",
    "clonk",
    "clonker"
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
    replyLevelInitiative: 50,
    replyLevelNonInitiative: 10,
    reactionLevel: 30,
    minSecondsBetweenMessages: 5,
    replyCoalesceWindowSeconds: 6,
    replyCoalesceMaxMessages: 6
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
      enabled: false,
      provider: "anthropic",
      model: "claude-haiku-4-5",
      reasoningEffort: "minimal",
      prompts: {
        wakeVariantHint: "Treat near-phonetic or misspelled tokens that appear to target the bot name as direct address. Short callouts like \"yo <name-ish-token>\" or \"hi <name-ish-token>\" usually indicate direct address. Questions like \"is that you <name-ish-token>?\" usually indicate direct address.",
        systemPromptCompact: "You decide if \"{{botName}}\" should reply right now in a live Discord voice chat.\nOutput exactly one token: YES or NO.\nInterpret second-person wording (\"you\", \"your\", \"show me\") as potentially aimed at {{botName}} unless another person is explicitly targeted.\nWhen reply eagerness is low, be conservative and prefer NO unless the turn clearly warrants interruption-free contribution.\nAt medium eagerness, balance responsiveness with restraint; only insert when it adds clear value.\nAt high eagerness, you can be more available for follow-ups while staying clear and grounded.\nAt near-max/absolute max eagerness (90-100), allow more proactive social inserts when context allows, while keeping claims accurate.\nPrefer YES for direct wake-word mentions and likely ASR variants of the bot name.\nTreat near-phonetic or misspelled tokens that appear to target the bot name as direct address.\nShort callouts like \"yo <name-ish-token>\" or \"hi <name-ish-token>\" should usually be YES.\nQuestions like \"is that you <name-ish-token>?\" should usually be YES.\nDo not use rhyme alone as evidence of direct address.\nGeneric chatter such as prank/stank/stinky phrasing without a clear name-like callout should usually be NO.\nPriority rule: when Join window active is yes, treat short greetings/check-ins as targeted at the bot unless another human target is explicit.\nExamples of join-window short greetings/check-ins: hi, hey, hello, yo, hola, what's up, what up, salam, marhaba, ciao, bonjour, こんにちは, مرحبا.\nIn join window, a single-token greeting/check-in should usually be YES, not filler.\nWhen Join window active is yes and the turn is a greeting/check-in, default to YES unless it is clearly aimed at another human.\nWhen conversation engagement state is engaged and current speaker matches engaged flow, lean YES for coherent follow-ups.\nPrefer YES for clear questions/requests that seem aimed at the bot or the current speaker flow.\nIf this sounds like a follow-up from an engaged speaker, lean YES.\nPrefer NO for filler/noise, pure acknowledgements, or turns clearly aimed at another human.\nWhen uncertain and the utterance is a clear question, prefer YES.\nNever output anything except YES or NO."
      }
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
    asrDuringMusic: true,
    asrEnabled: true,
    commandOnlyMode: false,
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
    allowInitiativeReplies: true,
    allowReactions: true,
    initiativeChannelIds: [],
    allowedChannelIds: [],
    blockedChannelIds: [],
    blockedUserIds: [],
    maxMessagesPerHour: 20,
    maxReactionsPerHour: 24
  },
  initiative: {
    enabled: true,
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
    discovery: {
      enabled: true,
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
  memoryLlm: {
    provider: "anthropic",
    model: "claude-haiku-4-5",
    temperature: 0,
    maxOutputTokens: 320
  },
  memory: {
    enabled: true,
    maxRecentMessages: 35,
    maxHighlights: 16,
    embeddingModel: "text-embedding-3-small"
  }
};
