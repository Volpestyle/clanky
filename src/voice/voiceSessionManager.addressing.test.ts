import { test } from "bun:test";
import assert from "node:assert/strict";
import { ActiveReplyRegistry } from "../tools/activeReplyRegistry.ts";
import {
  VoiceSessionManager,
  resolveVoiceThoughtTopicalityBias
} from "./voiceSessionManager.ts";
import {
  FILE_ASR_TURN_QUEUE_MAX,
  VOICE_TURN_MIN_ASR_CLIP_MS
} from "./voiceSessionManager.constants.ts";
import {
  createVoiceTestManager as createManager,
  createVoiceTestSettings as baseSettings
} from "./voiceTestHarness.ts";

test("reply decider blocks turns when transcript is missing", async () => {
  const manager = createManager();
  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "guild-1",
      textChannelId: "chan-1",
      voiceChannelId: "voice-1",
      mode: "openai_realtime",
      botTurnOpen: false,
    },
    userId: "speaker-1",
    settings: baseSettings(),
    transcript: ""
  });

  assert.equal(decision.allow, false);
  assert.equal(decision.reason, "missing_transcript");
});

test("reply decider keeps representative low-signal turns on the generation path", async () => {
  const manager = createManager({
    generate: async () => {
      throw new Error("classifier should stay out of these low-signal cases");
    }
  });
  const settings = baseSettings({
    voice: {
      admission: {
        mode: "generation_decides"
      }
    }
  });
  settings.voice.admission.mode = "generation_decides";

  const cases = [
    {
      transcript: "hmm",
      session: {
        guildId: "guild-1",
        textChannelId: "chan-1",
        voiceChannelId: "voice-1",
        mode: "openai_realtime",
        botTurnOpen: false
      }
    },
    {
      transcript: "ماذا؟",
      session: {
        guildId: "guild-1",
        textChannelId: "chan-1",
        voiceChannelId: "voice-1",
        mode: "openai_realtime",
        botTurnOpen: false
      }
    },
    {
      transcript: "so much lag",
      session: {
        guildId: "guild-1",
        textChannelId: "chan-1",
        voiceChannelId: "voice-1",
        mode: "openai_realtime",
        botTurnOpen: false
      }
    }
  ];

  for (const row of cases) {
    const decision = await manager.evaluateVoiceReplyDecision({
      session: row.session,
      userId: "speaker-1",
      settings,
      transcript: row.transcript
    });

    assert.equal(decision.allow, true, row.transcript);
    assert.equal(decision.reason, "generation_decides", row.transcript);
  }
});

test("reply decider keeps greeting-like turns on the generation path across fresh-join windows", async () => {
  const manager = createManager({
    generate: async () => {
      throw new Error("classifier should stay out of greeting soft-admission cases");
    }
  });
  const settings = baseSettings({
    voice: {
      admission: {
        mode: "generation_decides"
      }
    }
  });
  settings.voice.admission.mode = "generation_decides";

  const cases = [
    {
      transcript: "what up",
      startedAt: Date.now() - 7_000
    },
    {
      transcript: "hola",
      startedAt: Date.now() - 90_000
    },
    {
      transcript: "what's up",
      startedAt: Date.now() - 90_000
    }
  ];

  for (const row of cases) {
    const decision = await manager.evaluateVoiceReplyDecision({
      session: {
        guildId: "guild-1",
        textChannelId: "chan-1",
        voiceChannelId: "voice-1",
        mode: "openai_realtime",
        botTurnOpen: false,
        startedAt: row.startedAt
      },
      userId: "speaker-1",
      settings,
      transcript: row.transcript
    });

    assert.equal(decision.allow, true, row.transcript);
    assert.equal(decision.reason, "generation_decides", row.transcript);
    assert.equal(decision.directAddressed, false, row.transcript);
  }
});

test("reply decider keeps recent-context soft followups on generation_decides", async () => {
  const manager = createManager({
    participantCount: 1,
    generate: async () => {
      throw new Error("classifier should stay out of recent-context soft followups");
    }
  });
  const settings = baseSettings({
    voice: {
      admission: {
        mode: "generation_decides"
      }
    }
  });
  settings.voice.admission.mode = "generation_decides";

  const cases = [
    {
      transcript: "show them you man",
      session: {
        guildId: "guild-1",
        textChannelId: "chan-1",
        voiceChannelId: "voice-1",
        mode: "openai_realtime",
        botTurnOpen: false,
        lastDirectAddressUserId: "speaker-1",
        lastDirectAddressAt: Date.now() - 4_000,
        lastAudioDeltaAt: Date.now() - 4_000
      }
    },
    {
      transcript: "hmm",
      session: {
        guildId: "guild-1",
        textChannelId: "chan-1",
        voiceChannelId: "voice-1",
        mode: "openai_realtime",
        botTurnOpen: false,
        lastDirectAddressUserId: "speaker-1",
        lastDirectAddressAt: Date.now()
      }
    },
    {
      transcript: "you hear this one?",
      session: {
        guildId: "guild-1",
        textChannelId: "chan-1",
        voiceChannelId: "voice-1",
        mode: "openai_realtime",
        botTurnOpen: false
      }
    }
  ];

  for (const row of cases) {
    const decision = await manager.evaluateVoiceReplyDecision({
      session: row.session,
      userId: "speaker-1",
      settings,
      transcript: row.transcript
    });

    assert.equal(decision.allow, true, row.transcript);
    assert.equal(decision.reason, "generation_decides", row.transcript);
  }
});

test("reply decider allows direct wake-word pings via classifier with directAddressed hint", async () => {
  let callCount = 0;
  const manager = createManager({
    generate: async () => {
      callCount += 1;
      return { text: "YES" };
    }
  });
  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "guild-1",
      textChannelId: "chan-1",
      voiceChannelId: "voice-1",
      mode: "openai_realtime",
      botTurnOpen: false,
    },
    userId: "speaker-1",
    settings: baseSettings(),
    transcript: "clanker"
  });

  assert.equal(decision.allow, true);
  assert.equal(decision.reason, "classifier_allow");
  assert.equal(decision.directAddressed, true);
  assert.equal(callCount, 1);
});

test("reply decider allows short clanker wake ping", async () => {
  let callCount = 0;
  const manager = createManager({
    generate: async () => {
      callCount += 1;
      return { text: "YES" };
    }
  });
  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "guild-1",
      textChannelId: "chan-1",
      voiceChannelId: "voice-1",
      mode: "openai_realtime",
      botTurnOpen: false,
    },
    userId: "speaker-1",
    settings: baseSettings(),
    transcript: "yo clanker"
  });

  assert.equal(decision.allow, true);
  assert.equal(decision.reason, "classifier_allow");
  assert.equal(decision.directAddressed, true);
  assert.equal(callCount, 1);
});

test("shouldPersistUserTranscriptTimelineTurn persists any non-empty transcript", () => {
  const manager = createManager();
  const session = {
    settingsSnapshot: baseSettings()
  };
  assert.equal(manager.shouldPersistUserTranscriptTimelineTurn({
    session,
    settings: session.settingsSnapshot,
    transcript: "Przyjaciele"
  }), true);
  assert.equal(manager.shouldPersistUserTranscriptTimelineTurn({
    session,
    settings: session.settingsSnapshot,
    transcript: "yo clanker"
  }), true);
  assert.equal(manager.shouldPersistUserTranscriptTimelineTurn({
    session,
    settings: session.settingsSnapshot,
    transcript: ""
  }), false);
});


test("reply decider in merged realtime mode allows short clips through classifier", async () => {
  let callCount = 0;
  const manager = createManager({
    generate: async () => {
      callCount += 1;
      return { text: "YES" };
    }
  });
  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "guild-1",
      textChannelId: "chan-1",
      voiceChannelId: "voice-1",
      mode: "openai_realtime",
      botTurnOpen: false,
      startedAt: Date.now() - 8_000,
      lastAudioDeltaAt: Date.now() - 1_400
    },
    userId: "speaker-1",
    settings: baseSettings({
      voice: {
        replyEagerness: 60,
        replyDecisionLlm: {
          provider: "anthropic",
          model: "claude-haiku-4-5"
        }
      }
    }),
    transcript: "Guten士",
    transcriptionContext: {
      captureReason: "speaking_end",
      clipDurationMs: 460,
      usedFallbackModel: false
    }
  });

  assert.equal(decision.allow, true);
  assert.equal(decision.reason, "classifier_allow");
  assert.equal(callCount, 1);
});

test("reply decider flows eagerness-0 unaddressed turns to classifier/generation (no hard reject)", async () => {
  const manager = createManager();
  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "guild-1",
      textChannelId: "chan-1",
      voiceChannelId: "voice-1",
      mode: "openai_realtime",
      botTurnOpen: false,
    },
    userId: "speaker-1",
    settings: baseSettings({
      voice: {
        replyEagerness: 0,
        replyDecisionLlm: {
          provider: "anthropic",
          model: "claude-haiku-4-5"
        }
      }
    }),
    transcript: "what do you think about this"
  });

  // Eagerness 0 no longer hard-rejects — it flows through to the classifier.
  // The default mock returns NO, so the classifier denies, but it was NOT a hard reject.
  assert.equal(decision.allow, false);
  assert.equal(decision.reason, "classifier_deny");
});

test("reply decider blocks unaddressed turns in command-only mode", async () => {
  const manager = createManager({
    participantCount: 1
  });
  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "guild-1",
      textChannelId: "chan-1",
      voiceChannelId: "voice-1",
      mode: "openai_realtime",
      botTurnOpen: false
    },
    userId: "speaker-1",
    settings: baseSettings({
      voice: {
        commandOnlyMode: true,
        replyEagerness: 60,
        replyDecisionLlm: {
          provider: "anthropic",
          model: "claude-haiku-4-5"
        }
      }
    }),
    transcript: "what do you think about this"
  });

  assert.equal(decision.allow, false);
  assert.equal(decision.reason, "command_only_not_addressed");
});

test("reply decider allows direct-addressed turns in command-only mode", async () => {
  const manager = createManager({
    participantCount: 1
  });
  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "guild-1",
      textChannelId: "chan-1",
      voiceChannelId: "voice-1",
      mode: "openai_realtime",
      botTurnOpen: false
    },
    userId: "speaker-1",
    settings: baseSettings({
      botName: "clanker conk",
      voice: {
        commandOnlyMode: true,
        replyEagerness: 60,
        replyDecisionLlm: {
          provider: "anthropic",
          model: "claude-haiku-4-5"
        }
      }
    }),
    transcript: "yo clanker what time is it"
  });

  assert.equal(decision.allow, true);
  assert.equal(decision.reason, "command_only_direct_address");
});

test("reply decider denies unaddressed turns while music is playing and wake latch is inactive", async () => {
  const manager = createManager({
    participantCount: 1
  });
  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "guild-1",
      textChannelId: "chan-1",
      voiceChannelId: "voice-1",
      mode: "openai_realtime",
      music: {
        phase: "playing",
        active: true,
        ducked: false,
        pauseReason: null
      },
      botTurnOpen: false
    },
    userId: "speaker-1",
    settings: baseSettings({
      voice: {
        replyEagerness: 60,
        replyDecisionLlm: {
          provider: "anthropic",
          model: "claude-haiku-4-5"
        }
      }
    }),
    transcript: "blah blah blah i'm gonna build a building"
  });

  assert.equal(decision.allow, false);
  assert.equal(decision.reason, "music_playing_not_awake");
});

test("reply decider lets generation decide unaddressed turns in realtime brain mode", async () => {
  const manager = createManager();
  const settings = baseSettings({
    voice: {
      admission: {
        mode: "generation_decides"
      }
    }
  });
  settings.voice.admission.mode = "generation_decides";
  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "guild-1",
      textChannelId: "chan-1",
      voiceChannelId: "voice-1",
      mode: "openai_realtime",
      botTurnOpen: false,
    },
    userId: "speaker-1",
    settings,
    transcript: "that reminds me of yesterday, what happened again?"
  });

  assert.equal(decision.allow, true);
  assert.equal(decision.reason, "generation_decides");
  assert.equal(decision.directAddressed, false);
});

test("reply decider routes wake-like variants through brain decides or classifier with directAddressed hint", async () => {
  const cases = [
    { text: "yo plink", expected: true },
    { text: "hi clunky", expected: true },
    { text: "yo clunker can you answer this?", expected: true },
    { text: "cleaner can you jump in?", expected: true }
  ];
  let callCount = 0;
  const manager = createManager({
    generate: async () => {
      callCount += 1;
      return { text: "NO" };
    }
  });
  const settings = baseSettings({
    voice: {
      admission: {
        mode: "generation_decides"
      }
    }
  });
  settings.voice.admission.mode = "generation_decides";

  for (const row of cases) {
    const decision = await manager.evaluateVoiceReplyDecision({
      session: {
        guildId: "guild-1",
        textChannelId: "chan-1",
        voiceChannelId: "voice-1",
        mode: "openai_realtime",
        botTurnOpen: false,
      },
      userId: "speaker-1",
      settings,
      transcript: row.text
    });

    assert.equal(decision.allow, row.expected, row.text);
    const reason = String(decision.reason || "");
    assert.equal(
      ["classifier_allow", "generation_decides"].includes(reason),
      true,
      row.text
    );
    if (reason === "classifier_allow") {
      assert.equal(decision.directAddressed, true, row.text);
    }
  }

  assert.equal(callCount, 0);
});

test("formatVoiceDecisionHistory keeps newest turns within total char budget", () => {
  const manager = createManager();
  const session = {
    guildId: "guild-1",
    textChannelId: "chan-1",
    voiceChannelId: "voice-1",
    botTurnOpen: false,
    settingsSnapshot: baseSettings(),
    recentVoiceTurns: Array.from({ length: 6 }, (_row, index) => ({
      role: "user",
      userId: `speaker-${index + 1}`,
      speakerName: `speaker-${index + 1}`,
      text: `turn-${index + 1} ${"x".repeat(220)}`,
      at: Date.now() - (6 - index) * 500
    }))
  };

  const history = manager.formatVoiceDecisionHistory(session, 6, 460);
  assert.equal(history.length <= 460, true);
  assert.equal(history.includes("turn-6"), true);
  assert.equal(history.includes("turn-1"), false);
  assert.equal(history.split("\n").filter(Boolean).length <= 6, true);
});

test("formatVoiceDecisionHistory interleaves membership events with voice turns in chronological order", () => {
  const manager = createManager();
  const now = Date.now();
  const session = {
    guildId: "guild-1",
    textChannelId: "chan-1",
    voiceChannelId: "voice-1",
    botTurnOpen: false,
    settingsSnapshot: baseSettings(),
    recentVoiceTurns: [
      { role: "user", userId: "u1", speakerName: "vuhlp", text: "Yo", at: now - 1000 }
    ],
    membershipEvents: [
      { userId: "bot-user", displayName: "clanker conk", eventType: "join", at: now - 3000 },
      { userId: "u1", displayName: "vuhlp", eventType: "join", at: now - 2000 }
    ]
  };

  const history = manager.formatVoiceDecisionHistory(session, 6, 900);
  const lines = history.split("\n").filter(Boolean);
  assert.equal(lines.length, 3);
  assert.equal(lines[0], "[YOU joined the voice channel]");
  assert.equal(lines[1], "[vuhlp joined the voice channel]");
  assert.equal(lines[2], 'vuhlp: "Yo"');
});

test("formatVoiceDecisionHistory shows membership events even with no voice turns", () => {
  const manager = createManager();
  const now = Date.now();
  const session = {
    guildId: "guild-1",
    textChannelId: "chan-1",
    voiceChannelId: "voice-1",
    botTurnOpen: false,
    settingsSnapshot: baseSettings(),
    recentVoiceTurns: [],
    membershipEvents: [
      { userId: "bot-user", displayName: "clanker conk", eventType: "join", at: now - 2000 },
      { userId: "u1", displayName: "vuhlp", eventType: "join", at: now - 1000 }
    ]
  };

  const history = manager.formatVoiceDecisionHistory(session, 6, 900);
  const lines = history.split("\n").filter(Boolean);
  assert.equal(lines.length, 2);
  assert.equal(lines[0], "[YOU joined the voice channel]");
  assert.equal(lines[1], "[vuhlp joined the voice channel]");
});

test("formatVoiceDecisionHistory includes recent voice channel effects", () => {
  const manager = createManager();
  const now = Date.now();
  const session = {
    guildId: "guild-1",
    textChannelId: "chan-1",
    voiceChannelId: "voice-1",
    botTurnOpen: false,
    settingsSnapshot: baseSettings(),
    recentVoiceTurns: [
      { role: "user", userId: "u1", speakerName: "vuhlp", text: "did you hear that", at: now - 1000 }
    ],
    membershipEvents: [],
    voiceChannelEffects: [
      {
        userId: "u2",
        displayName: "bob",
        channelId: "voice-1",
        guildId: "guild-1",
        effectType: "soundboard",
        soundId: "123",
        soundName: "airhorn",
        soundVolume: 0.8,
        emoji: null,
        animationType: null,
        animationId: null,
        at: now - 1500
      }
    ]
  };

  const history = manager.formatVoiceDecisionHistory(session, 6, 900);
  const lines = history.split("\n").filter(Boolean);
  assert.equal(lines[0], '[bob played soundboard "airhorn"]');
  assert.equal(lines[1], 'vuhlp: "did you hear that"');
});

test("resolveVoiceThoughtTopicalityBias starts anchored and drifts with silence age", () => {
  const anchored = resolveVoiceThoughtTopicalityBias({
    silenceMs: 10_000,
    minSilenceSeconds: 10,
    minSecondsBetweenThoughts: 20
  });
  assert.equal(anchored.topicTetherStrength, 100);
  assert.equal(anchored.randomInspirationStrength, 0);
  assert.equal(anchored.phase, "anchored");

  const blended = resolveVoiceThoughtTopicalityBias({
    silenceMs: 35_000,
    minSilenceSeconds: 10,
    minSecondsBetweenThoughts: 20
  });
  assert.equal(blended.topicTetherStrength > 35, true);
  assert.equal(blended.topicTetherStrength < 70, true);
  assert.equal(blended.phase, "blended");

  const ambient = resolveVoiceThoughtTopicalityBias({
    silenceMs: 120_000,
    minSilenceSeconds: 10,
    minSecondsBetweenThoughts: 20
  });
  assert.equal(ambient.topicTetherStrength, 0);
  assert.equal(ambient.randomInspirationStrength, 100);
  assert.equal(ambient.phase, "ambient");
});

test("reply decider skips memory retrieval for unaddressed turns", async () => {
  let memoryCallCount = 0;
  const manager = createManager({
    generate: async () => ({ text: "YES" }),
    memory: {
      loadFactProfile() {
        memoryCallCount += 1;
        return {
          userFacts: [],
          relevantFacts: []
        };
      }
    }
  });
  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "guild-1",
      textChannelId: "chan-1",
      voiceChannelId: "voice-1",
      mode: "openai_realtime",
      botTurnOpen: false,
    },
    userId: "speaker-1",
    settings: baseSettings({
      memory: {
        enabled: true
      }
    }),
    transcript: "can you jump in for this topic?"
  });

  assert.equal(decision.allow, true);
  assert.equal(decision.directAddressed, false);
  assert.equal(memoryCallCount, 0);
});

test("reply decider uses classifier with directAddressed hint without memory lookup", async () => {
  let memoryCallCount = 0;
  const manager = createManager({
    generate: async () => ({ text: "YES" }),
    memory: {
      loadFactProfile() {
        memoryCallCount += 1;
        return {
          userFacts: [{ fact: "likes hockey", fact_type: "preference" }],
          relevantFacts: []
        };
      }
    }
  });
  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "guild-1",
      textChannelId: "chan-1",
      voiceChannelId: "voice-1",
      mode: "openai_realtime",
      botTurnOpen: false,
    },
    userId: "speaker-1",
    settings: baseSettings({
      memory: {
        enabled: true
      }
    }),
    transcript: "clanker what do i usually watch?"
  });

  assert.equal(decision.allow, true);
  assert.equal(decision.directAddressed, true);
  assert.equal(decision.reason, "classifier_allow");
  assert.equal(memoryCallCount, 0);
});

test("reply decider keeps generation_decides when the classifier provider fails", async () => {
  const manager = createManager({
    generate: async () => {
      throw new Error("classifier provider error");
    }
  });
  const settings = baseSettings();
  settings.voice.admission.mode = "generation_decides";

  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "guild-1",
      textChannelId: "chan-1",
      voiceChannelId: "voice-1",
      mode: "openai_realtime",
      botTurnOpen: false
    },
    userId: "speaker-1",
    settings,
    transcript: "what's up with this queue?"
  });

  assert.equal(decision.allow, true);
  assert.equal(decision.reason, "generation_decides");
  assert.equal(decision.directAddressed, false);
});

test("reply decider keeps representative full-brain classifier-skip settings on generation_decides", async () => {
  const cases = [
    {
      name: "anthropic_decider",
      generate: async () => ({ text: '{"decision":"YES"}', provider: "anthropic", model: "claude-haiku-4-5" }),
      settings: baseSettings({
        voice: {
          admission: {
            mode: "generation_decides"
          },
          replyDecisionLlm: {
            provider: "anthropic",
            model: "claude-haiku-4-5"
          }
        }
      }),
      transcript: "what's up with this queue?"
    },
    {
      name: "openai_gpt5_decider",
      generate: async () => ({ text: "YES", provider: "openai", model: "gpt-5-mini" }),
      settings: baseSettings({
        llm: {
          provider: "claude-oauth",
          model: "claude-sonnet-4-5"
        },
        voice: {
          admission: {
            mode: "generation_decides"
          },
          replyDecisionLlm: {
            provider: "openai",
            model: "gpt-5-mini"
          }
        }
      }),
      transcript: "what should we do next?"
    }
  ];
  for (const row of cases) {
    row.settings.voice.admission.mode = "generation_decides";
  }

  for (const row of cases) {
    const manager = createManager({
      generate: row.generate
    });
    const decision = await manager.evaluateVoiceReplyDecision({
      session: {
        guildId: "guild-1",
        textChannelId: "chan-1",
        voiceChannelId: "voice-1",
        mode: "openai_realtime",
        botTurnOpen: false
      },
      userId: "speaker-1",
      settings: row.settings,
      transcript: row.transcript
    });

    assert.equal(decision.allow, true, row.name);
    assert.equal(decision.reason, "generation_decides", row.name);
  }
});

test("reply decider bypasses classifier in generation_only realtime admission mode", async () => {
  let callCount = 0;
  const manager = createManager({
    generate: async () => {
      callCount += 1;
      return { text: "YES" };
    }
  });
  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "guild-1",
      textChannelId: "chan-1",
      voiceChannelId: "voice-1",
      mode: "openai_realtime",
      botTurnOpen: false,
    },
    userId: "speaker-1",
    settings: baseSettings({
      voice: {
        replyEagerness: 60,
        replyDecisionLlm: {
          realtimeAdmissionMode: "generation_only",
          provider: "anthropic",
          model: "claude-haiku-4-5"
        }
      }
    }),
    transcript: "what should we do next?"
  });

  assert.equal(decision.allow, true);
  assert.equal(decision.reason, "generation_decides");
  assert.equal(callCount, 0);
});

test("reply decider routes single-human assistant followups through classifier", async () => {
  let callCount = 0;
  const now = Date.now();
  try {
    const manager = createManager({
      participantCount: 1,
      generate: async () => {
        callCount += 1;
        return { text: "YES" };
      }
    });
    const decision = await manager.evaluateVoiceReplyDecision({
      session: {
        guildId: "guild-1",
        textChannelId: "chan-1",
        voiceChannelId: "voice-1",
        mode: "openai_realtime",
        botTurnOpen: false,
        lastAudioDeltaAt: now - 4_000,
        recentVoiceTurns: [
          {
            role: "assistant",
            userId: null,
            text: "yo, what's up?",
            speakerName: "clanker conk",
            at: now - 4_000
          },
          {
            role: "user",
            userId: "speaker-1",
            text: "yo, what's up, man?",
            speakerName: "speaker 1",
            at: now
          }
        ]
      },
      userId: "speaker-1",
      settings: baseSettings({
        voice: {
          replyEagerness: 50,
          replyDecisionLlm: {
            realtimeAdmissionMode: "hard_classifier",
            provider: "anthropic",
            model: "claude-haiku-4-5"
          }
        }
      }),
      transcript: "yo, what's up, man?"
    });

    assert.equal(decision.allow, true);
    assert.equal(decision.reason, "classifier_allow");
    assert.equal(decision.conversationContext.engaged, true);
    assert.equal(decision.conversationContext.engagedWithCurrentSpeaker, true);
    assert.equal(decision.conversationContext.singleParticipantAssistantFollowup, true);
    assert.equal(callCount, 1);
  } finally {
    delete process.env.VOICE_SINGLE_PARTICIPANT_ASSISTANT_FOLLOWUP_FAST_PATH;
  }
});

test("reply decider still runs classifier when single-human assistant followup window is stale", async () => {
  let callCount = 0;
  const now = Date.now();
  const manager = createManager({
    participantCount: 1,
    generate: async () => {
      callCount += 1;
      return { text: "YES" };
    }
  });
  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "guild-1",
      textChannelId: "chan-1",
      voiceChannelId: "voice-1",
      mode: "openai_realtime",
      botTurnOpen: false,
      lastAudioDeltaAt: now - 45_000,
      recentVoiceTurns: [
        {
          role: "assistant",
          userId: null,
          text: "yo, what's up?",
          speakerName: "clanker conk",
          at: now - 45_000
        },
        {
          role: "user",
          userId: "speaker-1",
          text: "yo, what's up, man?",
          speakerName: "speaker 1",
          at: now
        }
      ]
    },
    userId: "speaker-1",
    settings: baseSettings({
      voice: {
        replyEagerness: 50,
        replyDecisionLlm: {
          realtimeAdmissionMode: "hard_classifier",
          provider: "anthropic",
          model: "claude-haiku-4-5"
        }
      }
    }),
    transcript: "yo, what's up, man?"
  });

  assert.equal(decision.allow, true);
  assert.equal(decision.reason, "classifier_allow");
  assert.equal(decision.conversationContext.singleParticipantAssistantFollowup, false);
  assert.equal(callCount, 1);
});

test("reply decider can disable single-human assistant followup fast path via env var", async () => {
  const previous = process.env.VOICE_SINGLE_PARTICIPANT_ASSISTANT_FOLLOWUP_FAST_PATH;
  process.env.VOICE_SINGLE_PARTICIPANT_ASSISTANT_FOLLOWUP_FAST_PATH = "false";
  try {
    let callCount = 0;
    const now = Date.now();
    const manager = createManager({
      participantCount: 1,
      generate: async () => {
        callCount += 1;
        return { text: "YES" };
      }
    });
    const decision = await manager.evaluateVoiceReplyDecision({
      session: {
        guildId: "guild-1",
        textChannelId: "chan-1",
        voiceChannelId: "voice-1",
        mode: "openai_realtime",
        botTurnOpen: false,
        lastAudioDeltaAt: now - 4_000,
        recentVoiceTurns: [
          {
            role: "assistant",
            userId: null,
            text: "yo, what's up?",
            speakerName: "clanker conk",
            at: now - 4_000
          },
          {
            role: "user",
            userId: "speaker-1",
            text: "yo, what's up, man?",
            speakerName: "speaker 1",
            at: now
          }
        ]
      },
      userId: "speaker-1",
      settings: baseSettings({
        voice: {
          replyEagerness: 50,
          replyDecisionLlm: {
            realtimeAdmissionMode: "hard_classifier",
            provider: "anthropic",
            model: "claude-haiku-4-5"
          }
        }
      }),
      transcript: "yo, what's up, man?"
    });

    assert.equal(decision.allow, true);
    assert.equal(decision.reason, "classifier_allow");
    assert.equal(decision.conversationContext.singleParticipantAssistantFollowup, true);
    assert.equal(callCount, 1);
  } finally {
    if (previous === undefined) {
      delete process.env.VOICE_SINGLE_PARTICIPANT_ASSISTANT_FOLLOWUP_FAST_PATH;
    } else {
      process.env.VOICE_SINGLE_PARTICIPANT_ASSISTANT_FOLLOWUP_FAST_PATH = previous;
    }
  }
});

test("reply decider runs classifier for non-direct multi-user realtime turns", async () => {
  let callCount = 0;
  const manager = createManager({
    generate: async () => {
      callCount += 1;
      return { text: "YES" };
    }
  });
  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "guild-1",
      textChannelId: "chan-1",
      voiceChannelId: "voice-1",
      mode: "openai_realtime",
      botTurnOpen: false,
      lastInboundAudioAt: Date.now() - 280,
    },
    userId: "speaker-1",
    settings: baseSettings({
      voice: {
        replyEagerness: 60,
        replyDecisionLlm: {
          provider: "anthropic",
          model: "claude-haiku-4-5"
        }
      }
    }),
    transcript: "what should we do next?"
  });

  assert.equal(decision.allow, true);
  assert.equal(decision.reason, "classifier_allow");
  assert.equal(callCount, 1);
});

test("reply decider fast-paths merged bot-name tokens as direct address", async () => {
  let callCount = 0;
  const manager = createManager({
    generate: async () => {
      callCount += 1;
      return { text: "YES" };
    }
  });
  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "guild-1",
      textChannelId: "chan-1",
      voiceChannelId: "voice-1",
      mode: "openai_realtime",
      botTurnOpen: false,
      lastInboundAudioAt: Date.now() - 220,
    },
    userId: "speaker-1",
    settings: baseSettings({
      voice: {
        replyEagerness: 60,
        replyDecisionLlm: {
          provider: "anthropic",
          model: "claude-haiku-4-5"
        }
      }
    }),
    transcript: "clanker conk you there?"
  });

  assert.equal(decision.allow, true);
  assert.equal(decision.reason, "classifier_allow");
  assert.equal(decision.directAddressed, true);
  assert.equal(callCount, 1);
});

test("reply decider keeps bot awake across speakers after a recent direct address", async () => {
  let callCount = 0;
  const manager = createManager({
    generate: async () => {
      callCount += 1;
      return { text: "YES" };
    }
  });
  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "guild-1",
      textChannelId: "chan-1",
      voiceChannelId: "voice-1",
      mode: "openai_realtime",
      botTurnOpen: false,
      lastInboundAudioAt: Date.now() - 320,
      lastAudioDeltaAt: Date.now() - 2_000,
      lastDirectAddressAt: Date.now() - 3_000,
      lastDirectAddressUserId: "speaker-2"
    },
    userId: "speaker-1",
    settings: baseSettings({
      voice: {
        replyEagerness: 60,
        replyDecisionLlm: {
          provider: "anthropic",
          model: "claude-haiku-4-5"
        }
      }
    }),
    transcript: "yeah that's what i meant"
  });

  assert.equal(decision.allow, true);
  assert.equal(decision.reason, "classifier_allow");
  assert.equal(callCount, 1);
});

test("reply decider runs classifier after wake context gets stale", async () => {
  let callCount = 0;
  const manager = createManager({
    generate: async () => {
      callCount += 1;
      return { text: "YES" };
    }
  });
  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "guild-1",
      textChannelId: "chan-1",
      voiceChannelId: "voice-1",
      mode: "openai_realtime",
      botTurnOpen: false,
      lastInboundAudioAt: Date.now() - 260,
      lastDirectAddressAt: Date.now() - 42_000,
      lastDirectAddressUserId: "speaker-2",
      lastAudioDeltaAt: Date.now() - 42_000
    },
    userId: "speaker-1",
    settings: baseSettings({
      voice: {
        replyEagerness: 60,
        replyDecisionLlm: {
          provider: "anthropic",
          model: "claude-haiku-4-5"
        }
      }
    }),
    transcript: "yeah that's what i meant"
  });

  assert.equal(decision.allow, true);
  assert.equal(decision.reason, "classifier_allow");
  assert.equal(callCount, 1);
});

test("reply decider hard-denies malformed classifier output", async () => {
  let callCount = 0;
  const manager = createManager({
    generate: async () => {
      callCount += 1;
      return { text: "MAYBE" };
    }
  });
  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "guild-1",
      textChannelId: "chan-1",
      voiceChannelId: "voice-1",
      mode: "openai_realtime",
      botTurnOpen: false,
      lastInboundAudioAt: Date.now() - 220
    },
    userId: "speaker-1",
    settings: baseSettings({
      voice: {
        replyEagerness: 60,
        admission: {
          mode: "generation_decides"
        },
        replyDecisionLlm: {
          provider: "anthropic",
          model: "claude-haiku-4-5",
          realtimeAdmissionMode: "hard_classifier"
        }
      }
    }),
    transcript: "yo what's up"
  });

  assert.equal(decision.allow, false);
  assert.equal(decision.reason, "classifier_deny");
  assert.equal(decision.classifierDecision, null);
  assert.equal(decision.classifierReason, "unparseable_classifier_output");
  assert.equal(String(decision.error || "").startsWith("unparseable_classifier_output:"), true);
  assert.equal(callCount, 1);
});

test("reply classifier prompt includes attributed history and current turn fields", async () => {
  let classifierPrompt = "";
  const manager = createManager({
    generate: async ({ userPrompt }) => {
      classifierPrompt = String(userPrompt || "");
      return { text: "YES" };
    }
  });
  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "guild-1",
      textChannelId: "chan-1",
      voiceChannelId: "voice-1",
      mode: "openai_realtime",
      botTurnOpen: false,
      lastInboundAudioAt: Date.now() - 240,
      recentVoiceTurns: [
        { role: "assistant", text: "yo what's good", speakerName: "clanker conk" },
        { role: "user", text: "i'm working on a project", speakerName: "vuhlp" }
      ]
    },
    userId: "speaker-1",
    settings: (() => {
      const settings = baseSettings({
        voice: {
          replyEagerness: 60,
          replyDecisionLlm: {
            provider: "anthropic",
            model: "claude-haiku-4-5",
            realtimeAdmissionMode: "hard_classifier"
          }
        }
      });
      settings.voice.conversationPolicy.replyEagerness = 60;
      return settings;
    })(),
    transcript: "yo what's up"
  });

  assert.equal(decision.allow, true);
  assert.equal(decision.reason, "classifier_allow");
  assert.equal(classifierPrompt.includes("Participants: speaker 1, speaker 2"), true);
  assert.equal(classifierPrompt.includes('Speaker: speaker 1'), true);
  assert.equal(classifierPrompt.includes('Transcript: "yo what\'s up"'), true);
  assert.equal(classifierPrompt.includes("Recent voice timeline:"), true);
  assert.equal(classifierPrompt.includes('YOU: "yo what\'s good"'), true);
  assert.equal(classifierPrompt.includes('vuhlp: "i\'m working on a project"'), true);
});

test("reply classifier prompt labels room events distinctly from spoken transcripts", async () => {
  let classifierPrompt = "";
  const manager = createManager({
    generate: async ({ userPrompt }) => {
      classifierPrompt = String(userPrompt || "");
      return { text: "YES" };
    }
  });

  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "guild-1",
      textChannelId: "chan-1",
      voiceChannelId: "voice-1",
      mode: "openai_realtime",
      botTurnOpen: false,
      recentVoiceTurns: [],
      membershipEvents: [{ userId: "speaker-1", displayName: "vuhlp", eventType: "join", at: Date.now() - 500 }]
    },
    userId: "speaker-1",
    settings: baseSettings({
      voice: {
        replyEagerness: 60,
        replyDecisionLlm: {
          provider: "anthropic",
          model: "claude-haiku-4-5",
          realtimeAdmissionMode: "hard_classifier"
        }
      }
    }),
    transcript: "[vuhlp joined the voice channel]",
    inputKind: "event"
  });

  assert.equal(decision.allow, true);
  assert.equal(classifierPrompt.includes("Participants: speaker 1, speaker 2"), true);
  assert.equal(classifierPrompt.includes('Event: "[vuhlp joined the voice channel]"'), true);
  assert.equal(classifierPrompt.includes("Triggering member: speaker 1"), true);
  assert.equal(classifierPrompt.includes("Someone joined or left. Consider greeting them if it feels natural."), true);
});

test("reply decider routes garbled bot-name requests through runtime admission", async () => {
  let callCount = 0;
  let classifierPrompt = "";
  const manager = createManager({
    generate: async ({ userPrompt }) => {
      callCount += 1;
      classifierPrompt = String(userPrompt || "");
      return { text: "YES" };
    }
  });

  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "guild-1",
      textChannelId: "chan-1",
      voiceChannelId: "voice-1",
      mode: "openai_realtime",
      botTurnOpen: false,
      lastInboundAudioAt: Date.now() - 240
    },
    userId: "speaker-1",
    settings: baseSettings({
      voice: {
        replyEagerness: 60,
        replyDecisionLlm: {
          provider: "anthropic",
          model: "claude-haiku-4-5",
          realtimeAdmissionMode: "hard_classifier"
        }
      }
    }),
    transcript: "Yo, can you play me some Migos planka?"
  });

  assert.equal(decision.allow, true);
  assert.equal(decision.reason, "classifier_allow");
  assert.equal(decision.directAddressed, false);
  assert.equal(callCount, 1);
  assert.equal(
    classifierPrompt.includes('Transcript: "Yo, can you play me some Migos planka?"'),
    true
  );
});

test("reply decider denies music turns when wake latch is inactive", async () => {
  const manager = createManager();
  const session = {
    guildId: "guild-1",
    textChannelId: "chan-1",
    voiceChannelId: "voice-1",
    mode: "openai_realtime",
    botTurnOpen: false,
    musicWakeLatchedUntil: 0,
    musicWakeLatchedByUserId: null,
    music: {
      phase: "playing",
      active: true,
      ducked: false
    }
  };
  const decision = await manager.evaluateVoiceReplyDecision({
    session,
    userId: "speaker-1",
    settings: baseSettings({
      voice: {
        replyEagerness: 60
      }
    }),
    transcript: "yo what's up"
  });

  assert.equal(decision.allow, false);
  assert.equal(decision.reason, "music_playing_not_awake");
  assert.equal(session.music.ducked, false);
});

test("reply decider opens music wake latch on deterministic wake", async () => {
  const manager = createManager();
  const session = {
    guildId: "guild-1",
    textChannelId: "chan-1",
    voiceChannelId: "voice-1",
    mode: "openai_realtime",
    botTurnOpen: false,
    musicWakeLatchedUntil: 0,
    musicWakeLatchedByUserId: null,
    music: {
      phase: "playing",
      active: true,
      ducked: true
    }
  };
  const before = Date.now();
  const decision = await manager.evaluateVoiceReplyDecision({
    session,
    userId: "speaker-1",
    settings: baseSettings({
      voice: {
        replyEagerness: 60
      }
    }),
    transcript: "clanker pause the music"
  });

  assert.equal(decision.allow, true);
  assert.equal(decision.reason, "command_only_direct_address");
  assert.equal(Number(session.musicWakeLatchedUntil || 0) > before, true);
  assert.equal(session.musicWakeLatchedByUserId, "speaker-1");
  assert.equal(session.music.ducked, true);
});

test("reply decider applies music wake latch across speakers and extends on admitted turn", async () => {
  let callCount = 0;
  const manager = createManager({
    participantCount: 3,
    generate: async () => {
      callCount += 1;
      return { text: "YES" };
    }
  });
  const existingLatch = Date.now() + 5_000;
  const session = {
    guildId: "guild-1",
    textChannelId: "chan-1",
    voiceChannelId: "voice-1",
    mode: "openai_realtime",
    botTurnOpen: false,
    musicWakeLatchedUntil: existingLatch,
    musicWakeLatchedByUserId: "speaker-1",
    music: {
      phase: "playing",
      active: true,
      ducked: false
    }
  };
  const decision = await manager.evaluateVoiceReplyDecision({
    session,
    userId: "speaker-2",
    settings: baseSettings({
      voice: {
        replyEagerness: 60,
        replyDecisionLlm: {
          provider: "anthropic",
          model: "claude-haiku-4-5",
          realtimeAdmissionMode: "hard_classifier"
        }
      }
    }),
    transcript: "what are we listening to"
  });

  assert.equal(decision.allow, true);
  assert.equal(decision.reason, "classifier_allow");
  assert.equal(callCount, 1);
  assert.equal(Number(session.musicWakeLatchedUntil || 0) > existingLatch, true);
  assert.equal(session.musicWakeLatchedByUserId, "speaker-2");
  assert.equal(session.music.ducked, false);
});

test("reply decider clears expired music wake latch and denies until new wake", async () => {
  let callCount = 0;
  const manager = createManager({
    generate: async () => {
      callCount += 1;
      return { text: "YES" };
    }
  });
  const session = {
    guildId: "guild-1",
    textChannelId: "chan-1",
    voiceChannelId: "voice-1",
    mode: "openai_realtime",
    botTurnOpen: false,
    musicWakeLatchedUntil: Date.now() - 1_000,
    musicWakeLatchedByUserId: "speaker-1",
    music: {
      phase: "playing",
      active: true,
      ducked: false
    }
  };
  const decision = await manager.evaluateVoiceReplyDecision({
    session,
    userId: "speaker-2",
    settings: baseSettings({
      voice: {
        replyEagerness: 60
      }
    }),
    transcript: "can you queue something else"
  });

  assert.equal(decision.allow, false);
  assert.equal(decision.reason, "music_playing_not_awake");
  assert.equal(callCount, 0);
  assert.equal(Number(session.musicWakeLatchedUntil || 0), 0);
  assert.equal(session.musicWakeLatchedByUserId, null);
});

test("classifier sees participant list so it can infer addressing from transcript context", async () => {
  let callCount = 0;
  let classifierPrompt = "";
  const manager = createManager({
    generate: async ({ userPrompt }) => {
      callCount += 1;
      classifierPrompt = String(userPrompt || "");
      return { text: "NO" };
    }
  });
  manager.getVoiceChannelParticipants = () => [
    { userId: "speaker-1", displayName: "speaker one" },
    { userId: "speaker-2", displayName: "smelly" }
  ];
  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "guild-1",
      textChannelId: "chan-1",
      voiceChannelId: "voice-1",
      mode: "openai_realtime",
      botTurnOpen: false,
      lastInboundAudioAt: Date.now() - 220
    },
    userId: "speaker-1",
    settings: baseSettings({
      voice: {
        replyEagerness: 60,
        admission: {
          mode: "generation_decides"
        },
        replyDecisionLlm: {
          provider: "anthropic",
          model: "claude-haiku-4-5"
        }
      }
    }),
    transcript: "yo smelly can you check that"
  });

  assert.equal(decision.allow, false);
  assert.equal(decision.reason, "classifier_deny");
  assert.equal(callCount, 1);
  // The classifier LLM infers addressing from the transcript and participant list directly.
  // Verify it sees the participant list so it can make that inference.
  assert.equal(classifierPrompt.includes("smelly"), true);
});

test("reply decider blocks ambiguous realtime native turns without brain path", async () => {
  let callCount = 0;
  const manager = createManager({
    generate: async () => {
      callCount += 1;
      return { text: "YES" };
    }
  });
  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "guild-1",
      textChannelId: "chan-1",
      voiceChannelId: "voice-1",
      mode: "openai_realtime",
      botTurnOpen: false,
      lastInboundAudioAt: Date.now() - 220
    },
    userId: "speaker-1",
    settings: baseSettings({
      voice: {
        replyEagerness: 60,
        replyPath: "native",
        replyDecisionLlm: {
          provider: "anthropic",
          model: "claude-haiku-4-5"
        }
      }
    }),
    transcript: "what should we do next?"
  });

  assert.equal(decision.allow, true);
  assert.equal(decision.reason, "native_realtime");
  assert.equal(callCount, 0);
});

test("reply decider routes direct-addressed turns through classifier", async () => {
  let callCount = 0;
  const manager = createManager({
    generate: async () => {
      callCount += 1;
      return { text: "YES", provider: "anthropic", model: "claude-haiku-4-5" };
    }
  });
  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "guild-1",
      textChannelId: "chan-1",
      voiceChannelId: "voice-1",
      mode: "openai_realtime",
      botTurnOpen: false,
    },
    userId: "speaker-1",
    settings: baseSettings({
      voice: {
        replyEagerness: 60,
        replyDecisionLlm: {
          provider: "anthropic",
          model: "claude-haiku-4-5",

        }
      }
    }),
    transcript: "clanker can you help with this"
  });

  assert.equal(decision.allow, true);
  assert.equal(decision.reason, "classifier_allow");
  assert.equal(decision.directAddressed, true);
  assert.equal(callCount, 1);
});

test("reply decider allows through native realtime mode (model decides)", async () => {
  let callCount = 0;
  const manager = createManager({
    generate: async () => {
      callCount += 1;
      return { text: "YES", provider: "anthropic", model: "claude-haiku-4-5" };
    }
  });
  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "guild-1",
      textChannelId: "chan-1",
      voiceChannelId: "voice-1",
      mode: "openai_realtime",
      botTurnOpen: false,
    },
    userId: "speaker-1",
    settings: baseSettings({
      voice: {
        replyEagerness: 60,
        replyPath: "native",
        replyDecisionLlm: {
          provider: "anthropic",
          model: "claude-haiku-4-5",

        }
      }
    }),
    transcript: "clanker can you help with this"
  });

  assert.equal(decision.allow, true);
  assert.equal(decision.reason, "native_realtime");
  assert.equal(callCount, 0);
});

test("reply decider keeps merged bot-name token turns on the classifier with directAddressed hint", async () => {
  let callCount = 0;
  const manager = createManager({
    generate: async () => {
      callCount += 1;
      return { text: "YES", provider: "anthropic", model: "claude-haiku-4-5" };
    }
  });
  const settings = baseSettings({
    voice: {
      replyEagerness: 60,
      replyDecisionLlm: {
        provider: "anthropic",
        model: "claude-haiku-4-5",

      }
    }
  });
  settings.voice.admission.mode = "generation_decides";
  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "guild-1",
      textChannelId: "chan-1",
      voiceChannelId: "voice-1",
      mode: "openai_realtime",
      botTurnOpen: false,
    },
    userId: "speaker-1",
    settings,
    transcript: "clanker conk can you help with this"
  });

  assert.equal(decision.allow, true);
  assert.equal(decision.reason, "generation_decides");
  assert.equal(decision.directAddressed, true);
  assert.equal(callCount, 0);
});

test("reply decider lets generation decide turns that previously triggered contract violations", async () => {
  let callCount = 0;
  const manager = createManager({
    generate: async () => {
      callCount += 1;
      return { text: "maybe later" };
    }
  });
  const settings = baseSettings({
    voice: {
      replyEagerness: 60,
      replyDecisionLlm: {
        provider: "anthropic",
        model: "claude-haiku-4-5"
      }
    }
  });
  settings.voice.admission.mode = "generation_decides";
  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "guild-1",
      textChannelId: "chan-1",
      voiceChannelId: "voice-1",
      mode: "openai_realtime",
      botTurnOpen: false,
    },
    userId: "speaker-1",
    settings,
    transcript: "maybe later maybe not"
  });

  assert.equal(decision.allow, true);
  assert.equal(decision.reason, "generation_decides");
  assert.equal(decision.directAddressed, false);
  assert.equal(callCount, 0);
});

test("reply decider does not gate unaddressed turns behind cooldown", async () => {
  const manager = createManager();
  const settings = baseSettings();
  settings.voice.admission.mode = "generation_decides";
  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "guild-1",
      textChannelId: "chan-1",
      voiceChannelId: "voice-1",
      mode: "openai_realtime",
      botTurnOpen: false,
    },
    userId: "speaker-1",
    settings,
    transcript: "can you jump in on this"
  });

  assert.equal(decision.allow, true);
  assert.equal(decision.reason, "generation_decides");
  assert.equal(decision.directAddressed, false);
});

test("direct address denied when classifier LLM is unavailable", async () => {
  const fakeClient = {
    on() {},
    off() {},
    guilds: { cache: new Map() },
    users: { cache: new Map() },
    user: { id: "bot-user", username: "clanker conk" }
  };
  const fakeStore = {
    logAction() {},
    getSettings() {
      return { botName: "clanker conk" };
    }
  };
  const manager = new VoiceSessionManager({
    client: fakeClient,
    store: fakeStore,
    appConfig: {},
    llm: {}
  });
  manager.countHumanVoiceParticipants = () => 3;

  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "guild-1",
      textChannelId: "chan-1",
      voiceChannelId: "voice-1",
      mode: "openai_realtime",
      botTurnOpen: false,
    },
    userId: "speaker-1",
    settings: baseSettings(),
    transcript: "clanker can you explain that"
  });

  assert.equal(decision.allow, false);
  assert.equal(decision.reason, "classifier_deny");
  assert.equal(decision.directAddressed, true);
});

test("reply decider allows same-speaker pending command followup before command-only rejection", async () => {
  const manager = createManager();
  const now = Date.now();
  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "guild-1",
      textChannelId: "chan-1",
      voiceChannelId: "voice-1",
      mode: "openai_realtime",
      botTurnOpen: false,
      voiceCommandState: {
        userId: "speaker-1",
        domain: "music",
        intent: "music_disambiguation",
        startedAt: now - 1_000,
        expiresAt: now + 10_000
      },
      music: {
        active: true,
        pendingQuery: "all caps",
        pendingPlatform: "auto",
        pendingAction: "play_now",
        pendingRequestedByUserId: "speaker-1",
        pendingRequestedAt: now,
        pendingResults: [
          {
            id: "youtube:abc111",
            title: "all caps",
            artist: "mf doom",
            platform: "youtube",
            externalUrl: "https://youtube.com/watch?v=abc111",
            durationSeconds: 140
          },
          {
            id: "youtube:def222",
            title: "all caps",
            artist: "madvillain",
            platform: "youtube",
            externalUrl: "https://youtube.com/watch?v=def222",
            durationSeconds: 150
          }
        ]
      }
    },
    userId: "speaker-1",
    settings: baseSettings({
      voice: {
        replyEagerness: 0,
        commandOnlyMode: true,
        replyDecisionLlm: {
          provider: "anthropic",
          model: "claude-haiku-4-5"
        }
      }
    }),
    transcript: "2"
  });

  assert.equal(decision.allow, true);
  assert.equal(decision.reason, "pending_command_followup");
});

test("reply decider allows active music command followup before eagerness rejection", async () => {
  const manager = createManager();
  const now = Date.now();
  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "guild-1",
      textChannelId: "chan-1",
      voiceChannelId: "voice-1",
      mode: "openai_realtime",
      botTurnOpen: false,
      voiceCommandState: {
        userId: "speaker-1",
        domain: "music",
        intent: "music_disambiguation",
        startedAt: now - 1_000,
        expiresAt: now + 10_000
      },
      music: {
        pendingQuery: "all caps",
        pendingPlatform: "auto",
        pendingAction: "play_now",
        pendingRequestedByUserId: "speaker-1",
        pendingRequestedAt: now,
        pendingResults: [
          {
            id: "youtube:abc111",
            title: "all caps",
            artist: "mf doom",
            platform: "youtube",
            externalUrl: "https://youtube.com/watch?v=abc111",
            durationSeconds: 140
          },
          {
            id: "youtube:def222",
            title: "all caps",
            artist: "madvillain",
            platform: "youtube",
            externalUrl: "https://youtube.com/watch?v=def222",
            durationSeconds: 150
          }
        ]
      }
    },
    userId: "speaker-1",
    settings: baseSettings({
      voice: {
        replyEagerness: 0,
        replyDecisionLlm: {
          provider: "anthropic",
          model: "claude-haiku-4-5"
        }
      }
    }),
    transcript: "the second one"
  });

  assert.equal(decision.allow, true);
  assert.equal(decision.reason, "pending_command_followup");
});

test("reply decider allows the command owner through an active tool followup lease before classifier", async () => {
  const manager = createManager({
    generate: async () => {
      throw new Error("classifier should stay out of owned tool followup turns");
    }
  });
  const now = Date.now();
  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "guild-1",
      textChannelId: "chan-1",
      voiceChannelId: "voice-1",
      mode: "openai_realtime",
      botTurnOpen: false,
      voiceCommandState: {
        userId: "speaker-1",
        domain: "tool",
        intent: "tool_followup",
        startedAt: now - 1_000,
        expiresAt: now + 10_000
      }
    },
    userId: "speaker-1",
    settings: baseSettings({
      voice: {
        replyPath: "bridge",
        replyDecisionLlm: {
          provider: "anthropic",
          model: "claude-haiku-4-5"
        }
      }
    }),
    transcript: "yeah do that"
  });

  assert.equal(decision.allow, true);
  assert.equal(decision.reason, "owned_tool_followup");
});

test("reply decider blocks other speakers during an active tool followup lease before classifier", async () => {
  const manager = createManager({
    generate: async () => {
      throw new Error("classifier should stay out of other-speaker owned tool followup turns");
    }
  });
  const now = Date.now();
  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "guild-1",
      textChannelId: "chan-1",
      voiceChannelId: "voice-1",
      mode: "openai_realtime",
      botTurnOpen: false,
      voiceCommandState: {
        userId: "speaker-1",
        domain: "tool",
        intent: "tool_followup",
        startedAt: now - 1_000,
        expiresAt: now + 10_000
      }
    },
    userId: "speaker-2",
    settings: baseSettings({
      voice: {
        replyPath: "bridge",
        replyDecisionLlm: {
          provider: "anthropic",
          model: "claude-haiku-4-5"
        }
      }
    }),
    transcript: "wait what"
  });

  assert.equal(decision.allow, false);
  assert.equal(decision.reason, "owned_tool_followup_other_speaker_blocked");
});

test("reply decider keeps unrelated chatter blocked during pending music followup", async () => {
  const manager = createManager();
  const now = Date.now();
  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "guild-1",
      textChannelId: "chan-1",
      voiceChannelId: "voice-1",
      mode: "openai_realtime",
      botTurnOpen: false,
      voiceCommandState: {
        userId: "speaker-1",
        domain: "music",
        intent: "music_disambiguation",
        startedAt: now - 1_000,
        expiresAt: now + 10_000
      },
      music: {
        phase: "playing",
        active: true,
        ducked: false,
        pauseReason: null,
        pendingQuery: "all caps",
        pendingPlatform: "auto",
        pendingAction: "play_now",
        pendingRequestedByUserId: "speaker-1",
        pendingRequestedAt: now,
        pendingResults: [
          {
            id: "youtube:abc111",
            title: "all caps",
            artist: "mf doom",
            platform: "youtube",
            externalUrl: "https://youtube.com/watch?v=abc111",
            durationSeconds: 140
          },
          {
            id: "youtube:def222",
            title: "all caps",
            artist: "madvillain",
            platform: "youtube",
            externalUrl: "https://youtube.com/watch?v=def222",
            durationSeconds: 150
          }
        ]
      }
    },
    userId: "speaker-1",
    settings: baseSettings({
      voice: {
        replyEagerness: 0,
        commandOnlyMode: true,
        replyDecisionLlm: {
          provider: "anthropic",
          model: "claude-haiku-4-5"
        }
      }
    }),
    transcript: "that song is crazy"
  });

  // Unrelated chatter is denied because music is active and wake latch is not armed.
  assert.equal(decision.allow, false);
  assert.equal(decision.reason, "music_playing_not_awake");
});

test("reply decider ignores other speakers during pending command followup in command-only mode", async () => {
  const manager = createManager();
  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "guild-1",
      textChannelId: "chan-1",
      voiceChannelId: "voice-1",
      mode: "openai_realtime",
      botTurnOpen: false,
      music: {
        phase: "playing",
        active: true,
        ducked: false,
        pauseReason: null,
        pendingQuery: "all caps",
        pendingPlatform: "auto",
        pendingAction: "play_now",
        pendingRequestedByUserId: "speaker-1",
        pendingRequestedAt: Date.now(),
        pendingResults: [
          {
            id: "youtube:abc111",
            title: "all caps",
            artist: "mf doom",
            platform: "youtube",
            externalUrl: "https://youtube.com/watch?v=abc111",
            durationSeconds: 140
          }
        ]
      }
    },
    userId: "speaker-2",
    settings: baseSettings({
      voice: {
        replyEagerness: 0,
        commandOnlyMode: true,
        replyDecisionLlm: {
          provider: "anthropic",
          model: "claude-haiku-4-5"
        }
      }
    }),
    transcript: "2"
  });

  // Other speakers stay blocked while music is active and wake latch is not armed.
  // The disambiguation followup only allows through the same speaker who initiated
  // the music request.
  assert.equal(decision.allow, false);
  assert.equal(decision.reason, "music_playing_not_awake");
});

test("reply decider drops expired command followup sessions", async () => {
  const manager = createManager();
  const now = Date.now();
  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "guild-1",
      textChannelId: "chan-1",
      voiceChannelId: "voice-1",
      mode: "openai_realtime",
      botTurnOpen: false,
      voiceCommandState: {
        userId: "speaker-1",
        domain: "music",
        intent: "music_disambiguation",
        startedAt: now - 30_000,
        expiresAt: now - 1
      },
      music: {
        pendingQuery: "all caps",
        pendingPlatform: "auto",
        pendingAction: "play_now",
        pendingRequestedByUserId: "speaker-1",
        pendingRequestedAt: now,
        pendingResults: [
          {
            id: "youtube:abc111",
            title: "all caps",
            artist: "mf doom",
            platform: "youtube",
            externalUrl: "https://youtube.com/watch?v=abc111",
            durationSeconds: 140
          }
        ]
      }
    },
    userId: "speaker-1",
    settings: baseSettings({
      voice: {
        replyEagerness: 0,
        commandOnlyMode: true,
        replyDecisionLlm: {
          provider: "anthropic",
          model: "claude-haiku-4-5"
        }
      }
    }),
    transcript: "the second one"
  });

  assert.equal(decision.allow, false);
  assert.equal(decision.reason, "command_only_not_addressed");
});

test("runRealtimeTurn in voice_agent retries full ASR model after empty mini transcript", async () => {
  const runtimeLogs = [];
  const attemptedModels = [];
  const manager = createManager();
  manager.store.logAction = (row) => {
    runtimeLogs.push(row);
  };
  manager.llm.isAsrReady = () => true;
  manager.llm.transcribeAudio = async () => ({ text: "unused" });
  manager.transcribePcmTurn = async ({ model }) => {
    attemptedModels.push(String(model || ""));
    if (model === "gpt-4o-mini-transcribe") return "";
    return "fallback transcript";
  };
  manager.evaluateVoiceReplyDecision = async ({ transcript }) => ({
    allow: true,
    reason: "native_realtime",
    participantCount: 2,
    directAddressed: false,
    transcript
  });

  const session = {
    id: "session-voice-agent-fallback-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "voice_agent",
    ending: false,
    pendingRealtimeInputBytes: 0,
    realtimeInputSampleRateHz: 24000,
    realtimeClient: {
      appendInputAudioPcm() {}
    },
    settingsSnapshot: baseSettings()
  };

  await manager.turnProcessor.runRealtimeTurn({
    session,
    userId: "speaker-1",
    pcmBuffer: Buffer.alloc(96_000, 1),
    captureReason: "stream_end"
  });

  assert.deepEqual(attemptedModels, ["gpt-4o-mini-transcribe", "whisper-1"]);
  const addressingLog = runtimeLogs.find(
    (row) => row?.kind === "voice_runtime" && row?.content === "voice_turn_addressing"
  );
  assert.equal(Boolean(addressingLog), true);
  assert.equal(addressingLog?.metadata?.transcriptionModelFallback, "whisper-1");
  assert.equal(addressingLog?.metadata?.transcriptionPlanReason, "mini_with_full_fallback_runtime");
  assert.equal(addressingLog?.metadata?.transcript, "fallback transcript");
});

test("runRealtimeTurn skips ASR on very short speaking_end clips", async () => {
  const runtimeLogs = [];
  let transcribeCalls = 0;
  const manager = createManager();
  manager.store.logAction = (row) => {
    runtimeLogs.push(row);
  };
  manager.llm.isAsrReady = () => true;
  manager.llm.transcribeAudio = async () => ({ text: "unused" });
  manager.transcribePcmTurn = async () => {
    transcribeCalls += 1;
    return "should-not-happen";
  };
  manager.evaluateVoiceReplyDecision = async ({ transcript }) => ({
    allow: transcript ? true : false,
    reason: transcript ? "native_realtime" : "missing_transcript",
    participantCount: 2,
    directAddressed: false,
    transcript
  });

  const session = {
    id: "session-short-clip-skip-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "voice_agent",
    ending: false,
    pendingRealtimeInputBytes: 0,
    realtimeInputSampleRateHz: 24000,
    realtimeClient: {
      appendInputAudioPcm() {}
    },
    settingsSnapshot: baseSettings()
  };

  await manager.turnProcessor.runRealtimeTurn({
    session,
    userId: "speaker-1",
    pcmBuffer: Buffer.from([1, 2, 3, 4]),
    captureReason: "speaking_end"
  });

  assert.equal(transcribeCalls, 0);
  assert.equal(
    runtimeLogs.some(
      (row) => row?.kind === "voice_runtime" && row?.content === "realtime_turn_transcription_skipped_short_clip"
    ),
    true
  );
  const addressingLog = runtimeLogs.find(
    (row) => row?.kind === "voice_runtime" && row?.content === "voice_turn_addressing"
  );
  assert.equal(Boolean(addressingLog), true);
  assert.equal(addressingLog?.metadata?.asrSkippedShortClip, true);
});

test("runRealtimeTurn transcribes speaking_end clips above minimum duration threshold", async () => {
  const runtimeLogs = [];
  let transcribeCalls = 0;
  const manager = createManager();
  manager.store.logAction = (row) => {
    runtimeLogs.push(row);
  };
  manager.llm.isAsrReady = () => true;
  manager.llm.transcribeAudio = async () => ({ text: "unused" });
  manager.transcribePcmTurn = async () => {
    transcribeCalls += 1;
    return "yo";
  };
  manager.evaluateVoiceReplyDecision = async ({ transcript }) => ({
    allow: transcript ? true : false,
    reason: transcript ? "native_realtime" : "missing_transcript",
    participantCount: 2,
    directAddressed: false,
    transcript
  });

  const session = {
    id: "session-short-clip-strong-signal-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "voice_agent",
    ending: false,
    pendingRealtimeInputBytes: 0,
    realtimeInputSampleRateHz: 24000,
    realtimeClient: {
      appendInputAudioPcm() {}
    },
    settingsSnapshot: baseSettings()
  };

  const sampleRateHz = 24000;
  const minAsrClipBytes = Math.max(
    2,
    Math.ceil(((VOICE_TURN_MIN_ASR_CLIP_MS / 1000) * sampleRateHz * 2))
  );
  const aboveThresholdClip = Buffer.alloc(minAsrClipBytes + 2, 10);

  await manager.turnProcessor.runRealtimeTurn({
    session,
    userId: "speaker-1",
    pcmBuffer: aboveThresholdClip,
    captureReason: "speaking_end"
  });

  assert.equal(transcribeCalls, 1);
  assert.equal(
    runtimeLogs.some(
      (row) => row?.kind === "voice_runtime" && row?.content === "realtime_turn_transcription_skipped_short_clip"
    ),
    false
  );
  const addressingLog = runtimeLogs.find(
    (row) => row?.kind === "voice_runtime" && row?.content === "voice_turn_addressing"
  );
  assert.equal(Boolean(addressingLog), true);
  assert.equal(addressingLog?.metadata?.asrSkippedShortClip, false);
  assert.equal(addressingLog?.metadata?.transcript, "yo");
});

test("runRealtimeTurn forwards short post-reply clips through merged realtime generation", async () => {
  const runtimeLogs = [];
  let transcribeCalls = 0;
  let replyCalls = 0;
  const manager = createManager({
    generate: async () => ({ text: "YES" })
  });
  manager.store.logAction = (row) => {
    runtimeLogs.push(row);
  };
  manager.llm.isAsrReady = () => true;
  manager.llm.transcribeAudio = async () => ({ text: "unused" });
  manager.transcribePcmTurn = async () => {
    transcribeCalls += 1;
    return "Guten士";
  };
  manager.runRealtimeBrainReply = async () => {
    replyCalls += 1;
  };

  const session = {
    id: "session-low-signal-recent-reply-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false,
    pendingRealtimeInputBytes: 0,
    realtimeInputSampleRateHz: 24000,
    startedAt: Date.now() - 8_000,
    lastAudioDeltaAt: Date.now() - 1_500,
    realtimeClient: {
      appendInputAudioPcm() {}
    },
    settingsSnapshot: baseSettings({
      voice: {
        replyEagerness: 60,
        replyDecisionLlm: {
          provider: "anthropic",
          model: "claude-haiku-4-5"
        }
      }
    })
  };

  await manager.turnProcessor.runRealtimeTurn({
    session,
    userId: "speaker-1",
    pcmBuffer: Buffer.alloc(22_080, 1),
    captureReason: "speaking_end"
  });

  assert.equal(transcribeCalls, 1);
  assert.equal(replyCalls, 1);
  const addressingLog = runtimeLogs.find(
    (row) => row?.kind === "voice_runtime" && row?.content === "voice_turn_addressing"
  );
  assert.equal(Boolean(addressingLog), true);
  assert.equal(addressingLog?.metadata?.reason, "classifier_allow");
});

test("runRealtimeTurn drops near-silent clips before ASR", async () => {
  const runtimeLogs = [];
  let transcribeCalls = 0;
  let decisionCalls = 0;
  const manager = createManager();
  manager.store.logAction = (row) => {
    runtimeLogs.push(row);
  };
  manager.llm.isAsrReady = () => true;
  manager.llm.transcribeAudio = async () => ({ text: "unused" });
  manager.transcribePcmTurn = async () => {
    transcribeCalls += 1;
    return "hello";
  };
  manager.evaluateVoiceReplyDecision = async () => {
    decisionCalls += 1;
    return {
      allow: true,
      reason: "native_realtime",
      participantCount: 2,
      directAddressed: false,
      transcript: "hello"
    };
  };

  const session = {
    id: "session-silence-gate-rt-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "voice_agent",
    ending: false,
    pendingRealtimeInputBytes: 0,
    realtimeInputSampleRateHz: 24000,
    realtimeClient: {
      appendInputAudioPcm() {}
    },
    settingsSnapshot: baseSettings()
  };

  await manager.turnProcessor.runRealtimeTurn({
    session,
    userId: "speaker-1",
    pcmBuffer: Buffer.alloc(96_000, 0),
    captureReason: "speaking_end"
  });

  assert.equal(transcribeCalls, 0);
  assert.equal(decisionCalls, 0);
  const silenceDrop = runtimeLogs.find(
    (row) => row?.kind === "voice_runtime" && row?.content === "voice_turn_dropped_silence_gate"
  );
  assert.equal(Boolean(silenceDrop), true);
  assert.equal(silenceDrop?.metadata?.source, "realtime");
});

test("transcribePcmTurn escalates repeated empty transcripts after configured threshold", async () => {
  const runtimeLogs = [];
  const errorLogs = [];
  const manager = createManager();
  manager.store.logAction = (row) => {
    if (row?.kind === "voice_runtime") runtimeLogs.push(row);
    if (row?.kind === "voice_error") errorLogs.push(row);
  };
  manager.llm.transcribeAudio = async () => {
    throw new Error("ASR returned empty transcript.");
  };

  const session = {
    id: "session-empty-streak-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "voice_agent",
    ending: false
  };

  for (let index = 0; index < 3; index += 1) {
    const transcript = await manager.transcribePcmTurn({
      session,
      userId: "speaker-1",
      pcmBuffer: Buffer.alloc(48_000, 1),
      model: "gpt-4o-mini-transcribe",
      sampleRateHz: 24000,
      captureReason: "speaking_end",
      traceSource: "voice_realtime_turn_decider",
      errorPrefix: "voice_realtime_transcription_failed",
      emptyTranscriptRuntimeEvent: "voice_realtime_transcription_empty",
      emptyTranscriptErrorStreakThreshold: 3
    });
    assert.equal(transcript, "");
  }

  assert.equal(
    runtimeLogs.filter((row) => row?.content === "voice_realtime_transcription_empty").length,
    2
  );
  const escalated = errorLogs.filter((row) =>
    String(row?.content || "").startsWith("voice_realtime_transcription_failed:")
  );
  assert.equal(escalated.length, 1);
  assert.equal(escalated[0]?.metadata?.emptyTranscriptStreak, 3);
});

test("runRealtimeTurn does not forward audio when reply decision denies turn", async () => {
  const runtimeLogs = [];
  let appendedAudioCalls = 0;
  let releaseMemoryIngest = () => undefined;
  let memoryIngestCalls = 0;
  const manager = createManager({
    memory: {
      async ingestMessage() {
        memoryIngestCalls += 1;
        await new Promise((resolve) => {
          releaseMemoryIngest = resolve;
        });
      }
    }
  });
  manager.store.logAction = (row) => {
    runtimeLogs.push(row);
  };
  manager.llm.isAsrReady = () => true;
  manager.llm.transcribeAudio = async () => ({ text: "side chatter" });
  manager.transcribePcmTurn = async () => "side chatter";
  manager.evaluateVoiceReplyDecision = async () => ({
    allow: false,
    reason: "classifier_deny",
    participantCount: 2,
    directAddressed: false,
    transcript: "side chatter"
  });

  const session = {
    id: "session-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "voice_agent",
    ending: false,
    pendingRealtimeInputBytes: 0,
    settingsSnapshot: baseSettings({
      memory: {
        enabled: true
      }
    }),
    realtimeClient: {
      appendInputAudioPcm() {
        appendedAudioCalls += 1;
      }
    }
  };

  const turnRun = manager.turnProcessor.runRealtimeTurn({
    session,
    userId: "speaker-1",
    pcmBuffer: Buffer.from([1, 2, 3, 4]),
    captureReason: "stream_end"
  });
  const runOutcome = await Promise.race([
    turnRun.then(() => "done"),
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 80))
  ]);

  assert.equal(runOutcome, "done");
  releaseMemoryIngest();
  assert.equal(appendedAudioCalls, 0);
  const addressingLog = runtimeLogs.find(
    (row) => row?.kind === "voice_runtime" && row?.content === "voice_turn_addressing"
  );
  assert.equal(Boolean(addressingLog), true);
  assert.equal(Boolean(addressingLog?.metadata?.allow), false);
  assert.equal(addressingLog?.metadata?.reason, "classifier_deny");
  assert.equal(memoryIngestCalls, 1);
});

test("runRealtimeTurn queues direct-addressed bot-turn-open turns for deferred flush", async () => {
  const runtimeLogs = [];
  const deferredTurns = [];
  let appendedAudioCalls = 0;
  const manager = createManager();
  manager.store.logAction = (row) => {
    runtimeLogs.push(row);
  };
  manager.queueDeferredBotTurnOpenTurn = (payload) => {
    deferredTurns.push(payload);
  };
  manager.evaluateVoiceReplyDecision = async () => ({
    allow: false,
    reason: "bot_turn_open",
    participantCount: 2,
    directAddressed: true,
    transcript: "clanker are you there"
  });

  const session = {
    id: "session-defer-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false,
    pendingRealtimeInputBytes: 0,
    realtimeClient: {
      appendInputAudioPcm() {
        appendedAudioCalls += 1;
      }
    },
    settingsSnapshot: baseSettings()
  };

  await manager.turnProcessor.runRealtimeTurn({
    session,
    userId: "speaker-1",
    pcmBuffer: Buffer.from([1, 2, 3, 4]),
    captureReason: "stream_end"
  });

  assert.equal(appendedAudioCalls, 0);
  assert.equal(deferredTurns.length, 1);
  assert.equal(deferredTurns[0]?.session, session);
  assert.equal(Boolean(deferredTurns[0]?.directAddressed), true);
  const addressingLog = runtimeLogs.find(
    (row) => row?.kind === "voice_runtime" && row?.content === "voice_turn_addressing"
  );
  assert.equal(Boolean(addressingLog), true);
  assert.equal(Boolean(addressingLog?.metadata?.allow), false);
  assert.equal(addressingLog?.metadata?.reason, "bot_turn_open");
  assert.equal(Boolean(addressingLog?.metadata?.directAddressed), true);
});

test("runRealtimeTurn queues non-direct bot-turn-open turns for deferred flush", async () => {
  const deferredTurns = [];
  const manager = createManager();
  manager.queueDeferredBotTurnOpenTurn = (payload) => {
    deferredTurns.push(payload);
  };
  manager.evaluateVoiceReplyDecision = async () => ({
    allow: false,
    reason: "bot_turn_open",
    participantCount: 2,
    directAddressed: false,
    transcript: "hold up, one sec"
  });

  const session = {
    id: "session-defer-2",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false,
    pendingRealtimeInputBytes: 0,
    realtimeClient: {
      appendInputAudioPcm() {}
    },
    settingsSnapshot: baseSettings()
  };

  await manager.turnProcessor.runRealtimeTurn({
    session,
    userId: "speaker-1",
    pcmBuffer: Buffer.from([8, 9, 10, 11]),
    captureReason: "stream_end"
  });

  assert.equal(deferredTurns.length, 1);
  assert.equal(Boolean(deferredTurns[0]?.directAddressed), false);
});

test("runRealtimeTurn logs buffered output-lock telemetry when deferring a turn", async () => {
  const runtimeLogs = [];
  const manager = createManager();
  manager.store.logAction = (row) => {
    runtimeLogs.push(row);
  };
  manager.evaluateVoiceReplyDecision = async () => ({
    allow: false,
    reason: "bot_turn_open",
    outputLockReason: "bot_audio_buffered",
    participantCount: 2,
    directAddressed: false,
    transcript: "yo what's good"
  });

  const session = {
    id: "session-defer-buffered-debug",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false,
    pendingRealtimeInputBytes: 0,
    voxClient: {
      getTtsBufferDepthSamples() {
        return 48_000;
      },
      getTtsPlaybackState() {
        return "buffered";
      },
      getTtsTelemetryUpdatedAt() {
        return Date.now() - 120;
      }
    },
    realtimeClient: {
      appendInputAudioPcm() {}
    },
    settingsSnapshot: baseSettings()
  };

  await manager.turnProcessor.runRealtimeTurn({
    session,
    userId: "speaker-1",
    pcmBuffer: Buffer.from([21, 22, 23, 24]),
    captureReason: "stream_end"
  });

  const addressingLog = runtimeLogs.find(
    (row) => row?.kind === "voice_runtime" && row?.content === "voice_turn_addressing"
  );
  assert.equal(addressingLog?.metadata?.outputLockReason, "bot_audio_buffered");
  assert.equal(addressingLog?.metadata?.outputLockTtsPlaybackState, "buffered");
  assert.equal(addressingLog?.metadata?.outputLockTtsBufferedSamples, 48_000);
  assert.equal(typeof addressingLog?.metadata?.outputLockTtsTelemetryAgeMs, "number");
  assert.equal(addressingLog?.metadata?.outputLockTtsTelemetryFresh, true);

  const deferredLog = runtimeLogs.find(
    (row) => row?.kind === "voice_runtime" && row?.content === "voice_turn_deferred_bot_turn_open"
  );
  assert.equal(deferredLog?.metadata?.outputLockReason, "bot_audio_buffered");
  assert.equal(deferredLog?.metadata?.outputLockTtsPlaybackState, "buffered");
  assert.equal(deferredLog?.metadata?.outputLockTtsBufferedSamples, 48_000);
});

test("runRealtimeTurn drops classifier_deny turns without deferral", async () => {
  const runtimeLogs = [];
  const deferredTurns = [];
  const manager = createManager();
  manager.store.logAction = (row) => {
    runtimeLogs.push(row);
  };
  manager.queueDeferredBotTurnOpenTurn = (payload) => {
    deferredTurns.push(payload);
  };
  manager.evaluateVoiceReplyDecision = async () => ({
    allow: false,
    reason: "classifier_deny",
    participantCount: 2,
    directAddressed: false,
    transcript: "hold up, one sec"
  });

  const session = {
    id: "session-defer-3",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false,
    pendingRealtimeInputBytes: 0,
    realtimeClient: {
      appendInputAudioPcm() {}
    },
    settingsSnapshot: baseSettings()
  };

  await manager.turnProcessor.runRealtimeTurn({
    session,
    userId: "speaker-1",
    pcmBuffer: Buffer.from([12, 13, 14, 15]),
    captureReason: "stream_end"
  });

  assert.equal(deferredTurns.length, 0);
  const addressingLog = runtimeLogs.find(
    (row) => row?.kind === "voice_runtime" && row?.content === "voice_turn_addressing"
  );
  assert.equal(Boolean(addressingLog), true);
  assert.equal(addressingLog?.metadata?.reason, "classifier_deny");
});

test("runRealtimeTurn acknowledges voice cancel intent after clearing pending work", async () => {
  const runtimeLogs = [];
  const clearedSessions = [];
  const cancelAckRequests = [];
  const manager = createManager();
  manager.store.logAction = (row) => {
    runtimeLogs.push(row);
  };
  manager.replyManager.clearPendingResponse = (session) => {
    clearedSessions.push(session?.id || null);
  };
  manager.requestRealtimePromptUtterance = (payload) => {
    cancelAckRequests.push(payload);
    return true;
  };

  let cancelActiveResponseCalls = 0;
  const session = {
    id: "session-cancel-intent-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false,
    realtimeClient: {
      cancelActiveResponse() {
        cancelActiveResponseCalls += 1;
        return true;
      }
    },
    settingsSnapshot: baseSettings()
  };

  await manager.turnProcessor.runRealtimeTurn({
    session,
    userId: "speaker-1",
    transcriptOverride: "never mind"
  });

  assert.equal(cancelActiveResponseCalls, 1);
  assert.deepEqual(clearedSessions, ["session-cancel-intent-1"]);
  assert.equal(cancelAckRequests.length, 1);
  assert.equal(cancelAckRequests[0]?.source, "voice_turn_cancel_acknowledgement");
  assert.equal(cancelAckRequests[0]?.userId, "speaker-1");
  assert.match(String(cancelAckRequests[0]?.prompt || ""), /Acknowledge briefly/i);
  const cancelLog = runtimeLogs.find(
    (row) => row?.kind === "voice_runtime" && row?.content === "voice_turn_cancel_intent"
  );
  assert.equal(cancelLog?.metadata?.responseCancelSucceeded, true);
  assert.equal(cancelLog?.metadata?.cancelAcknowledgementQueued, true);
});

test("runRealtimeTurn uses brain reply generation when admission allows turn", async () => {
  const brainPayloads = [];
  const manager = createManager();
  manager.evaluateVoiceReplyDecision = async () => ({
    allow: true,
    reason: "brain_decides",
    participantCount: 2,
    directAddressed: false,
    transcript: "tell me more"
  });
  manager.runRealtimeBrainReply = async (payload) => {
    brainPayloads.push(payload);
    return true;
  };

  const session = {
    id: "session-2",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false,
    pendingRealtimeInputBytes: 0,
    realtimeClient: {},
    settingsSnapshot: baseSettings()
  };

  await manager.turnProcessor.runRealtimeTurn({
    session,
    userId: "speaker-1",
    pcmBuffer: Buffer.from([8, 9, 10, 11]),
    captureReason: "stream_end"
  });

  assert.equal(brainPayloads.length, 1);
  assert.equal(brainPayloads[0]?.session, session);
  assert.equal(brainPayloads[0]?.transcript, "");
  assert.equal(brainPayloads[0]?.directAddressed, false);
  assert.equal(brainPayloads[0]?.source, "realtime");
});

test("smoke: runRealtimeBrainReply passes membership context into generation without special join gating flags", async () => {
  const generationPayloads = [];
  const manager = createManager();
  manager.resolveSoundboardCandidates = async () => ({
    candidates: []
  });
  manager.getVoiceChannelParticipants = () => [
    { userId: "speaker-1", displayName: "alice" },
    { userId: "speaker-2", displayName: "bob" }
  ];
  manager.instructionManager.prepareRealtimeTurnContext = async () => {};
  manager.requestRealtimeTextUtterance = () => true;
  manager.generateVoiceTurn = async (payload) => {
    generationPayloads.push(payload);
    return {
      text: "yo what's good"
    };
  };

  const settingsSnapshot = baseSettings();
  settingsSnapshot.voice.conversationPolicy.replyEagerness = 60;
  settingsSnapshot.voice.streamWatch = {
    enabled: true,
    commentaryPath: "anthropic_keyframes",
    brainContextEnabled: true,
    brainContextPrompt: "Use stream keyframes for continuity."
  };

  const session = {
    id: "session-join-greeting-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false,
    startedAt: Date.now() - 2_000,
    realtimeClient: {},
    streamWatch: {
      active: true,
      targetUserId: "speaker-1",
      lastBrainContextAt: Date.now() - 1500,
      brainContextEntries: [
        {
          text: "scoreboard is visible and timer is low",
          at: Date.now() - 1_500,
          provider: "anthropic",
          model: "claude-haiku-4-5",
          speakerName: "alice"
        }
      ]
    },
    recentVoiceTurns: [],
    membershipEvents: [
      {
        userId: "speaker-2",
        displayName: "bob",
        eventType: "join",
        at: Date.now() - 1_200
      }
    ],
    settingsSnapshot
  };

  const result = await manager.runRealtimeBrainReply({
    session,
    settings: session.settingsSnapshot,
    userId: "speaker-1",
    transcript: "yo, what's up?",
    directAddressed: false,
    source: "realtime"
  });

  assert.equal(result, true);
  assert.equal(generationPayloads.length, 1);
  assert.equal(Boolean(generationPayloads[0]?.isEagerTurn), true);
  assert.equal(generationPayloads[0]?.voiceEagerness, 60);
  assert.deepEqual(
    generationPayloads[0]?.participantRoster?.map((entry) => entry?.displayName),
    ["alice", "bob"]
  );
  assert.equal(generationPayloads[0]?.recentMembershipEvents?.length, 1);
  assert.equal(generationPayloads[0]?.recentMembershipEvents?.[0]?.eventType, "join");
  assert.equal(generationPayloads[0]?.recentMembershipEvents?.[0]?.displayName, "bob");
  assert.equal(
    Array.isArray(generationPayloads[0]?.conversationContext?.streamWatchBrainContext?.notes),
    true
  );
  assert.equal(generationPayloads[0]?.conversationContext?.streamWatchBrainContext?.notes?.length, 1);
});

test("runRealtimeBrainReply keeps older join events in transcript timeline context after fresh membership prompts expire", async () => {
  const generationPayloads = [];
  const manager = createManager();
  manager.resolveSoundboardCandidates = async () => ({
    candidates: []
  });
  manager.getVoiceChannelParticipants = () => [
    { userId: "speaker-1", displayName: "alice" }
  ];
  manager.instructionManager.prepareRealtimeTurnContext = async () => {};
  manager.requestRealtimeTextUtterance = () => true;
  manager.generateVoiceTurn = async (payload) => {
    generationPayloads.push(payload);
    return {
      text: "yo what's good"
    };
  };

  const settingsSnapshot = baseSettings();
  const session = {
    id: "session-older-join-context-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false,
    startedAt: Date.now() - 180_000,
    realtimeClient: {},
    recentVoiceTurns: [],
    transcriptTurns: [],
    membershipEvents: [],
    settingsSnapshot
  };

  manager.recordVoiceMembershipEvent({
    session,
    userId: "speaker-1",
    eventType: "join",
    displayName: "alice",
    at: Date.now() - 120_000
  });

  const result = await manager.runRealtimeBrainReply({
    session,
    settings: session.settingsSnapshot,
    userId: "speaker-1",
    transcript: "yo, what's up?",
    directAddressed: false,
    source: "realtime"
  });

  assert.equal(result, true);
  assert.equal(generationPayloads.length, 1);
  assert.equal(generationPayloads[0]?.recentMembershipEvents?.length || 0, 0);
  assert.equal(
    generationPayloads[0]?.contextMessages?.some(
      (row) => row?.content === "[alice joined the voice channel]"
    ),
    true
  );
});

test("runRealtimeBrainReply supersedes stale reply when newer realtime input is queued", async () => {
  const runtimeLogs = [];
  let requestedRealtimeUtterances = 0;
  const manager = createManager();
  manager.store.logAction = (row) => {
    runtimeLogs.push(row);
  };
  manager.resolveSoundboardCandidates = async () => ({
    candidates: []
  });
  manager.getVoiceChannelParticipants = () => [{ userId: "speaker-1", displayName: "alice" }];
  manager.instructionManager.prepareRealtimeTurnContext = async () => {};
  manager.requestRealtimeTextUtterance = () => {
    requestedRealtimeUtterances += 1;
    return true;
  };
  manager.generateVoiceTurn = async () => ({
    text: "this should be superseded"
  });

  const session = {
    id: "session-realtime-supersede-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false,
    startedAt: Date.now() - 8_000,
    realtimeClient: {},
    userCaptures: new Map(),
    pendingRealtimeTurns: [
      {
        session: null,
        userId: "speaker-2",
        pcmBuffer: Buffer.from([1, 2, 3]),
        captureReason: "stream_end",
        queuedAt: Date.now() - 250
      }
    ],
    realtimeReplySupersededCount: 0,
    recentVoiceTurns: [],
    membershipEvents: [],
    settingsSnapshot: baseSettings()
  };

  const result = await manager.runRealtimeBrainReply({
    session,
    settings: session.settingsSnapshot,
    userId: "speaker-1",
    transcript: "older transcript",
    directAddressed: false,
    source: "realtime"
  });

  assert.equal(result, true);
  assert.equal(requestedRealtimeUtterances, 1);
  const supersededLog = runtimeLogs.find(
    (row) => row?.kind === "voice_runtime" && row?.content === "realtime_reply_superseded_newer_input"
  );
  assert.equal(Boolean(supersededLog), false);
  assert.equal(session.realtimeReplySupersededCount, 0);
});

test("runRealtimeBrainReply ignores raw newer inbound timestamps without queued speech", async () => {
  const runtimeLogs = [];
  let requestedRealtimeUtterances = 0;
  const manager = createManager();
  manager.store.logAction = (row) => {
    runtimeLogs.push(row);
  };
  manager.resolveSoundboardCandidates = async () => ({
    candidates: []
  });
  manager.getVoiceChannelParticipants = () => [{ userId: "speaker-1", displayName: "alice" }];
  manager.instructionManager.prepareRealtimeTurnContext = async () => {};
  manager.requestRealtimeTextUtterance = () => {
    requestedRealtimeUtterances += 1;
    return true;
  };
  manager.generateVoiceTurn = async () => ({
    text: "reply should continue"
  });

  const session = {
    id: "session-realtime-ignore-raw-inbound-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false,
    startedAt: Date.now() - 8_000,
    realtimeClient: {},
    userCaptures: new Map(),
    pendingRealtimeTurns: [],
    lastInboundAudioAt: Date.now() + 60_000,
    realtimeReplySupersededCount: 0,
    recentVoiceTurns: [],
    membershipEvents: [],
    settingsSnapshot: baseSettings()
  };

  const result = await manager.runRealtimeBrainReply({
    session,
    settings: session.settingsSnapshot,
    userId: "speaker-1",
    transcript: "hello there",
    directAddressed: false,
    source: "realtime"
  });

  assert.equal(result, true);
  assert.equal(requestedRealtimeUtterances, 1);
  const supersededLog = runtimeLogs.find(
    (row) => row?.kind === "voice_runtime" && row?.content === "realtime_reply_superseded_newer_input"
  );
  assert.equal(Boolean(supersededLog), false);
  assert.equal(session.realtimeReplySupersededCount, 0);
});

test("runRealtimeBrainReply keeps assertive direct-address reply when queued speaker is outside interruption policy", async () => {
  const runtimeLogs = [];
  let requestedRealtimeUtterances = 0;
  const manager = createManager();
  manager.store.logAction = (row) => {
    runtimeLogs.push(row);
  };
  manager.resolveSoundboardCandidates = async () => ({
    candidates: []
  });
  manager.getVoiceChannelParticipants = () => [
    { userId: "speaker-1", displayName: "alice" },
    { userId: "speaker-2", displayName: "bob" }
  ];
  manager.instructionManager.prepareRealtimeTurnContext = async () => {};
  manager.requestRealtimeTextUtterance = () => {
    requestedRealtimeUtterances += 1;
    return true;
  };
  manager.generateVoiceTurn = async () => ({
    text: "continuing this answer"
  });

  const session = {
    id: "session-realtime-assertive-keep-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false,
    startedAt: Date.now() - 8_000,
    realtimeClient: {},
    userCaptures: new Map(),
    pendingRealtimeTurns: [
      {
        session: null,
        userId: "speaker-2",
        pcmBuffer: Buffer.from([1, 2, 3]),
        captureReason: "stream_end",
        queuedAt: Date.now() - 250
      }
    ],
    realtimeReplySupersededCount: 0,
    recentVoiceTurns: [],
    membershipEvents: [],
    settingsSnapshot: baseSettings()
  };

  const result = await manager.runRealtimeBrainReply({
    session,
    settings: session.settingsSnapshot,
    userId: "speaker-1",
    transcript: "yo clanker keep going",
    directAddressed: true,
    conversationContext: {
      engagementState: "engaged",
      engaged: true,
      engagedWithCurrentSpeaker: true
    },
    source: "realtime"
  });

  assert.equal(result, true);
  assert.equal(requestedRealtimeUtterances, 1);
  const supersededLog = runtimeLogs.find(
    (row) => row?.kind === "voice_runtime" && row?.content === "realtime_reply_superseded_newer_input"
  );
  assert.equal(Boolean(supersededLog), false);
  assert.equal(session.realtimeReplySupersededCount, 0);
});

test("runRealtimeBrainReply keeps ALL-target replies when queued speaker cannot interrupt", async () => {
  const runtimeLogs = [];
  let requestedRealtimeUtterances = 0;
  const manager = createManager();
  manager.store.logAction = (row) => {
    runtimeLogs.push(row);
  };
  manager.resolveSoundboardCandidates = async () => ({
    candidates: []
  });
  manager.getVoiceChannelParticipants = () => [
    { userId: "speaker-1", displayName: "alice" },
    { userId: "speaker-2", displayName: "bob" }
  ];
  manager.instructionManager.prepareRealtimeTurnContext = async () => {};
  manager.requestRealtimeTextUtterance = () => {
    requestedRealtimeUtterances += 1;
    return true;
  };
  manager.generateVoiceTurn = async () => ({
    text: "quick callout to everyone",
    voiceAddressing: {
      talkingTo: "ALL",
      directedConfidence: 0.9
    }
  });

  const session = {
    id: "session-realtime-assertive-all-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false,
    startedAt: Date.now() - 8_000,
    realtimeClient: {},
    userCaptures: new Map(),
    pendingRealtimeTurns: [
      {
        session: null,
        userId: "speaker-2",
        pcmBuffer: Buffer.from([1, 2, 3]),
        captureReason: "stream_end",
        queuedAt: Date.now() - 250
      }
    ],
    realtimeReplySupersededCount: 0,
    recentVoiceTurns: [],
    membershipEvents: [],
    settingsSnapshot: baseSettings()
  };

  const result = await manager.runRealtimeBrainReply({
    session,
    settings: session.settingsSnapshot,
    userId: "speaker-1",
    transcript: "clanker tell everyone",
    directAddressed: true,
    conversationContext: {
      engagementState: "engaged",
      engaged: true,
      engagedWithCurrentSpeaker: true
    },
    source: "realtime"
  });

  assert.equal(result, true);
  assert.equal(requestedRealtimeUtterances, 1);
  const supersededLog = runtimeLogs.find(
    (row) => row?.kind === "voice_runtime" && row?.content === "realtime_reply_superseded_newer_input"
  );
  assert.equal(Boolean(supersededLog), false);
  assert.equal(session.realtimeReplySupersededCount, 0);
});

test("runRealtimeBrainReply ignores near-silent queued turns for supersede checks", async () => {
  const runtimeLogs = [];
  let requestedRealtimeUtterances = 0;
  const manager = createManager();
  manager.store.logAction = (row) => {
    runtimeLogs.push(row);
  };
  manager.resolveSoundboardCandidates = async () => ({
    candidates: []
  });
  manager.getVoiceChannelParticipants = () => [{ userId: "speaker-1", displayName: "alice" }];
  manager.instructionManager.prepareRealtimeTurnContext = async () => {};
  manager.requestRealtimeTextUtterance = () => {
    requestedRealtimeUtterances += 1;
    return true;
  };
  manager.generateVoiceTurn = async () => ({
    text: "hello back"
  });

  const session = {
    id: "session-realtime-supersede-silent-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false,
    startedAt: Date.now() - 8_000,
    realtimeClient: {},
    realtimeInputSampleRateHz: 24_000,
    userCaptures: new Map(),
    pendingRealtimeTurns: [
      {
        session: null,
        userId: "speaker-2",
        pcmBuffer: Buffer.alloc(24_000, 0),
        captureReason: "speaking_end",
        queuedAt: Date.now() - 250
      }
    ],
    realtimeReplySupersededCount: 0,
    recentVoiceTurns: [],
    membershipEvents: [],
    settingsSnapshot: baseSettings()
  };

  const result = await manager.runRealtimeBrainReply({
    session,
    settings: session.settingsSnapshot,
    userId: "speaker-1",
    transcript: "hello",
    directAddressed: false,
    source: "realtime"
  });

  assert.equal(result, true);
  assert.equal(requestedRealtimeUtterances, 1);
  const supersededLog = runtimeLogs.find(
    (row) => row?.kind === "voice_runtime" && row?.content === "realtime_reply_superseded_newer_input"
  );
  assert.equal(Boolean(supersededLog), false);
  assert.equal(session.realtimeReplySupersededCount, 0);
});

test("runRealtimeBrainReply does not supersede stale playback on active capture alone", async () => {
  const runtimeLogs = [];
  let requestedRealtimeUtterances = 0;
  const manager = createManager();
  manager.store.logAction = (row) => {
    runtimeLogs.push(row);
  };
  manager.resolveSoundboardCandidates = async () => ({
    candidates: []
  });
  manager.getVoiceChannelParticipants = () => [{ userId: "speaker-1", displayName: "alice" }];
  manager.instructionManager.prepareRealtimeTurnContext = async () => {};
  manager.requestRealtimeTextUtterance = () => {
    requestedRealtimeUtterances += 1;
    return true;
  };
  manager.generateVoiceTurn = async () => ({
    text: "old reply should not play"
  });

  const session = {
    id: "session-realtime-supersede-active-capture-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false,
    startedAt: Date.now() - 8_000,
    realtimeClient: {},
    realtimeInputSampleRateHz: 24_000,
    userCaptures: new Map([
      [
        "speaker-2",
        {
          startedAt: Date.now() - 320,
          bytesSent: 4800,
          signalSampleCount: 2400,
          signalActiveSampleCount: 1800,
          signalPeakAbs: 12000
        }
      ]
    ]),
    pendingRealtimeTurns: [],
    realtimeReplySupersededCount: 0,
    recentVoiceTurns: [],
    membershipEvents: [],
    settingsSnapshot: baseSettings()
  };

  const result = await manager.runRealtimeBrainReply({
    session,
    settings: session.settingsSnapshot,
    userId: "speaker-1",
    transcript: "older transcript",
    directAddressed: false,
    source: "realtime"
  });

  assert.equal(result, true);
  assert.equal(requestedRealtimeUtterances, 1);
  const supersededLog = runtimeLogs.find(
    (row) => row?.kind === "voice_runtime" && row?.content === "realtime_reply_superseded_newer_input"
  );
  assert.equal(Boolean(supersededLog), false);
  assert.equal(session.realtimeReplySupersededCount, 0);
});

test("runRealtimeBrainReply supersedes stale playback when a newer finalized realtime turn is queued", async () => {
  const runtimeLogs = [];
  let requestedRealtimeUtterances = 0;
  const manager = createManager();
  manager.store.logAction = (row) => {
    runtimeLogs.push(row);
  };
  manager.resolveSoundboardCandidates = async () => ({
    candidates: []
  });
  manager.getVoiceChannelParticipants = () => [{ userId: "speaker-1", displayName: "alice" }];
  manager.instructionManager.prepareRealtimeTurnContext = async () => {};
  manager.requestRealtimeTextUtterance = () => {
    requestedRealtimeUtterances += 1;
    return true;
  };
  manager.generateVoiceTurn = async (_payload) => {
    session.pendingRealtimeTurns.push({
      session: null,
      userId: "speaker-2",
      pcmBuffer: Buffer.alloc(6_000, 0x7f),
      captureReason: "stream_end",
      queuedAt: Date.now(),
      finalizedAt: Date.now() + 5
    });
    return {
      text: "old reply should be superseded"
    };
  };

  const session = {
    id: "session-realtime-supersede-finalized-turn-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false,
    startedAt: Date.now() - 8_000,
    realtimeClient: {},
    realtimeInputSampleRateHz: 24_000,
    userCaptures: new Map(),
    pendingRealtimeTurns: [],
    realtimeReplySupersededCount: 0,
    recentVoiceTurns: [],
    membershipEvents: [],
    settingsSnapshot: baseSettings()
  };

  const result = await manager.runRealtimeBrainReply({
    session,
    settings: session.settingsSnapshot,
    userId: "speaker-1",
    transcript: "older transcript",
    directAddressed: false,
    source: "realtime"
  });

  assert.equal(result, false);
  assert.equal(requestedRealtimeUtterances, 0);
  const supersededLog = runtimeLogs.find(
    (row) => row?.kind === "voice_runtime" && row?.content === "realtime_reply_superseded_newer_input"
  );
  assert.equal(Boolean(supersededLog), true);
  assert.equal(supersededLog?.metadata?.supersedeReason, "newer_finalized_realtime_turn");
  assert.equal(session.realtimeReplySupersededCount, 1);
});

test("runRealtimeBrainReply exits before generation when a newer promoted capture already exists", async () => {
  const runtimeLogs = [];
  let requestedRealtimeUtterances = 0;
  let generateVoiceTurnCalls = 0;
  const manager = createManager();
  manager.store.logAction = (row) => {
    runtimeLogs.push(row);
  };
  manager.resolveSoundboardCandidates = async () => ({
    candidates: []
  });
  manager.getVoiceChannelParticipants = () => [{ userId: "speaker-1", displayName: "alice" }];
  manager.instructionManager.prepareRealtimeTurnContext = async () => {};
  manager.requestRealtimeTextUtterance = () => {
    requestedRealtimeUtterances += 1;
    return true;
  };
  manager.generateVoiceTurn = async () => {
    generateVoiceTurnCalls += 1;
    return {
      text: "should not be generated"
    };
  };
  manager.isCaptureConfirmedLiveSpeech = () => true;

  const finalizedAtMs = Date.now() - 1_000;
  const session = {
    id: "session-realtime-supersede-live-capture-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false,
    startedAt: Date.now() - 8_000,
    realtimeClient: {},
    realtimeInputSampleRateHz: 24_000,
    userCaptures: new Map([
      [
        "speaker-1",
        {
          userId: "speaker-1",
          startedAt: finalizedAtMs + 100,
          promotedAt: finalizedAtMs + 150,
          bytesSent: 24_000,
          signalSampleCount: 12_000,
          signalActiveSampleCount: 6_000,
          signalPeakAbs: 12_000,
          signalSumSquares: 12_000 * 12_000 * 12_000
        }
      ]
    ]),
    pendingRealtimeTurns: [],
    realtimeReplySupersededCount: 0,
    recentVoiceTurns: [],
    membershipEvents: [],
    settingsSnapshot: baseSettings()
  };

  const result = await manager.runRealtimeBrainReply({
    session,
    settings: session.settingsSnapshot,
    userId: "speaker-1",
    transcript: "older transcript",
    directAddressed: false,
    source: "realtime",
    latencyContext: {
      finalizedAtMs,
      asrStartedAtMs: finalizedAtMs - 100,
      asrCompletedAtMs: finalizedAtMs - 50,
      queueWaitMs: 0,
      pendingQueueDepth: 0,
      captureReason: "max_duration"
    }
  });

  assert.equal(result, false);
  assert.equal(generateVoiceTurnCalls, 0);
  assert.equal(requestedRealtimeUtterances, 0);
  const supersededLog = runtimeLogs.find(
    (row) => row?.kind === "voice_runtime" && row?.content === "realtime_reply_superseded_newer_input"
  );
  assert.equal(Boolean(supersededLog), true);
  assert.equal(supersededLog?.metadata?.supersedeReason, "newer_live_promoted_capture");
});

test("runRealtimeBrainReply ends VC when model requests leave directive", async () => {
  const manager = createManager();
  const endCalls = [];
  const waitCalls = [];
  manager.resolveSoundboardCandidates = async () => ({
    candidates: []
  });
  manager.getVoiceChannelParticipants = () => [{ userId: "speaker-1", displayName: "alice" }];
  manager.instructionManager.prepareRealtimeTurnContext = async () => {};
  manager.requestRealtimeTextUtterance = () => true;
  manager.generateVoiceTurn = async () => ({
    text: "aight, peace out",
    leaveVoiceChannelRequested: true
  });
  manager.waitForLeaveDirectivePlayback = async (payload) => {
    waitCalls.push(payload);
  };
  manager.endSession = async (payload) => {
    endCalls.push(payload);
    return true;
  };

  const session = {
    id: "session-realtime-leave-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false,
    startedAt: Date.now() - 5_000,
    maxEndsAt: Date.now() + 90_000,
    inactivityEndsAt: Date.now() + 25_000,
    realtimeClient: {},
    recentVoiceTurns: [],
    membershipEvents: [],
    settingsSnapshot: baseSettings()
  };

  const result = await manager.runRealtimeBrainReply({
    session,
    settings: session.settingsSnapshot,
    userId: "speaker-1",
    transcript: "we can wrap this up now",
    directAddressed: true,
    source: "realtime"
  });

  assert.equal(result, true);
  assert.equal(waitCalls.length, 1);
  assert.equal(waitCalls[0]?.expectRealtimeAudio, true);
  assert.equal(endCalls.length, 1);
  assert.equal(endCalls[0]?.reason, "assistant_leave_directive");
});

test("runRealtimeBrainReply keeps accepted turn stashed through the non-streaming playback boundary", async () => {
  const manager = createManager();
  manager.activeReplies = new ActiveReplyRegistry();
  const playbackPhases: Array<string | null> = [];
  manager.resolveSoundboardCandidates = async () => ({
    candidates: []
  });
  manager.getVoiceChannelParticipants = () => [{ userId: "speaker-1", displayName: "alice" }];
  manager.instructionManager.prepareRealtimeTurnContext = async () => {};
  manager.generateVoiceTurn = async () => ({
    text: "yo what's good"
  });
  manager.playVoiceReplyInOrder = async ({ session }) => {
    playbackPhases.push(session.inFlightAcceptedBrainTurn?.phase || null);
    assert.equal(session.inFlightAcceptedBrainTurn?.transcript, "say something");
    return {
      completed: true,
      spokeLine: true,
      requestedRealtimeUtterance: false,
      playedSoundboardCount: 0
    };
  };

  const session = {
    id: "session-realtime-preplay-stash-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false,
    startedAt: Date.now() - 4_000,
    maxEndsAt: Date.now() + 90_000,
    inactivityEndsAt: Date.now() + 25_000,
    realtimeClient: {},
    recentVoiceTurns: [],
    membershipEvents: [],
    settingsSnapshot: baseSettings()
  };

  const result = await manager.runRealtimeBrainReply({
    session,
    settings: session.settingsSnapshot,
    userId: "speaker-1",
    transcript: "say something",
    directAddressed: true,
    source: "realtime"
  });

  assert.equal(result, true);
  assert.deepEqual(playbackPhases, ["playback_requested"]);
  assert.equal(session.inFlightAcceptedBrainTurn, null);
});

test("runRealtimeBrainReply does not replay soundboard refs that were already executed during generation", async () => {
  const manager = createManager();
  const eventOrder = [];
  manager.getVoiceChannelParticipants = () => [{ userId: "speaker-1", displayName: "alice" }];
  manager.instructionManager.prepareRealtimeTurnContext = async () => {};
  manager.generateVoiceTurn = async () => ({
    text: "yo done",
    playedSoundboardRefs: ["airhorn@123", "rimshot@456"]
  });
  manager.requestRealtimeTextUtterance = ({ text }) => {
    eventOrder.push(`speech:${String(text)}`);
    return true;
  };
  manager.waitForLeaveDirectivePlayback = async () => {
    eventOrder.push("wait");
  };
  manager.soundboardDirector.play = async ({ soundId, sourceGuildId }) => {
    eventOrder.push(`sound:${sourceGuildId ? `${soundId}@${sourceGuildId}` : soundId}`);
    return { ok: true };
  };

  const session = {
    id: "session-realtime-inline-order-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false,
    startedAt: Date.now() - 8_000,
    maxEndsAt: Date.now() + 90_000,
    inactivityEndsAt: Date.now() + 25_000,
    realtimeClient: {},
    recentVoiceTurns: [],
    membershipEvents: [],
    settingsSnapshot: baseSettings({
      voice: {
        soundboard: {
          enabled: true,
          preferredSoundIds: ["airhorn@123", "rimshot@456"]
        }
      }
    })
  };

  const result = await manager.runRealtimeBrainReply({
    session,
    settings: session.settingsSnapshot,
    userId: "speaker-1",
    transcript: "sequence test",
    directAddressed: true,
    source: "realtime"
  });

  assert.equal(result, true);
  assert.deepEqual(eventOrder, [
    "speech:yo done"
  ]);
});

test("runRealtimeBrainReply treats engaged thread turns as non-eager even without direct address", async () => {
  const generationPayloads = [];
  const manager = createManager();
  manager.resolveSoundboardCandidates = async () => ({
    candidates: []
  });
  manager.getVoiceChannelParticipants = () => [{ userId: "speaker-1", displayName: "alice" }];
  manager.instructionManager.prepareRealtimeTurnContext = async () => {};
  manager.requestRealtimeTextUtterance = () => true;
  manager.generateVoiceTurn = async (payload) => {
    generationPayloads.push(payload);
    return {
      text: "on it"
    };
  };

  const session = {
    id: "session-engaged-thread-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false,
    startedAt: Date.now() - 28_000,
    realtimeClient: {},
    recentVoiceTurns: [],
    membershipEvents: [],
    settingsSnapshot: baseSettings()
  };

  const result = await manager.runRealtimeBrainReply({
    session,
    settings: session.settingsSnapshot,
    userId: "speaker-1",
    transcript: "open that first article",
    directAddressed: false,
    conversationContext: {
      engagementState: "engaged",
      engaged: true,
      engagedWithCurrentSpeaker: false
    },
    source: "realtime"
  });

  assert.equal(result, true);
  assert.equal(generationPayloads.length, 1);
  assert.equal(Boolean(generationPayloads[0]?.isEagerTurn), false);
});

test("runRealtimeTurn uses native realtime forwarding when strategy is native", async () => {
  const brainPayloads = [];
  const forwardedPayloads = [];
  const manager = createManager();
  manager.evaluateVoiceReplyDecision = async () => ({
    allow: true,
    reason: "brain_decides",
    participantCount: 2,
    directAddressed: false,
    transcript: "say it native"
  });
  manager.runRealtimeBrainReply = async (payload) => {
    brainPayloads.push(payload);
    return true;
  };
  manager.forwardRealtimeTurnAudio = async (payload) => {
    forwardedPayloads.push(payload);
    return true;
  };

  const session = {
    id: "session-native-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false,
    pendingRealtimeInputBytes: 0,
    realtimeClient: {},
    settingsSnapshot: baseSettings({
      voice: {
        replyEagerness: 60,
        replyPath: "native",
        replyDecisionLlm: {
          provider: "anthropic",
          model: "claude-haiku-4-5"
        }
      }
    })
  };

  const pcmBuffer = Buffer.from([8, 9, 10, 11]);
  await manager.turnProcessor.runRealtimeTurn({
    session,
    userId: "speaker-1",
    pcmBuffer,
    captureReason: "stream_end"
  });

  assert.equal(brainPayloads.length, 0);
  assert.equal(forwardedPayloads.length, 1);
  assert.equal(forwardedPayloads[0]?.session, session);
  assert.equal(forwardedPayloads[0]?.pcmBuffer, pcmBuffer);
  assert.equal(forwardedPayloads[0]?.transcript, "");
});

test("runRealtimeTurn keeps native strategy when soundboard is enabled", async () => {
  const brainPayloads = [];
  const forwardedPayloads = [];
  const manager = createManager();
  manager.evaluateVoiceReplyDecision = async () => ({
    allow: true,
    reason: "brain_decides",
    participantCount: 2,
    directAddressed: false,
    transcript: "say it native"
  });
  manager.runRealtimeBrainReply = async (payload) => {
    brainPayloads.push(payload);
    return true;
  };
  manager.forwardRealtimeTurnAudio = async (payload) => {
    forwardedPayloads.push(payload);
    return true;
  };

  const session = {
    id: "session-native-soundboard-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false,
    pendingRealtimeInputBytes: 0,
    realtimeClient: {},
    settingsSnapshot: baseSettings({
      voice: {
        replyEagerness: 60,
        replyPath: "native",
        soundboard: {
          enabled: true
        },
        replyDecisionLlm: {
          provider: "anthropic",
          model: "claude-haiku-4-5"
        }
      }
    })
  };

  const pcmBuffer = Buffer.from([8, 9, 10, 11]);
  await manager.turnProcessor.runRealtimeTurn({
    session,
    userId: "speaker-1",
    pcmBuffer,
    captureReason: "stream_end"
  });

  assert.equal(brainPayloads.length, 0);
  assert.equal(forwardedPayloads.length, 1);
  assert.equal(forwardedPayloads[0]?.session, session);
  assert.equal(forwardedPayloads[0]?.pcmBuffer, pcmBuffer);
  assert.equal(forwardedPayloads[0]?.transcript, "");
});

test("runRealtimeTurn forwards per-user ASR transcript turns into OpenAI room-brain text flow", async () => {
  const brainPayloads = [];
  const audioForwardPayloads = [];
  const textForwardPayloads = [];
  const manager = createManager();
  manager.appConfig.openaiApiKey = "test-key";
  manager.evaluateVoiceReplyDecision = async () => ({
    allow: true,
    reason: "brain_decides",
    participantCount: 2,
    directAddressed: true,
    directAddressConfidence: 0.94,
    transcript: "we should ship tonight",
    conversationContext: {
      engagementState: "engaged",
      engaged: true,
      engagedWithCurrentSpeaker: true
    }
  });
  manager.runRealtimeBrainReply = async (payload) => {
    brainPayloads.push(payload);
    return true;
  };
  manager.forwardRealtimeTurnAudio = async (payload) => {
    audioForwardPayloads.push(payload);
    return true;
  };
  manager.forwardRealtimeTextTurnToBrain = async (payload) => {
    textForwardPayloads.push(payload);
    return true;
  };

  const session = {
    id: "session-openai-text-turn-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false,
    perUserAsrEnabled: true,
    pendingRealtimeInputBytes: 0,
    realtimeClient: {},
    settingsSnapshot: baseSettings({
      voice: {
        replyEagerness: 60,
        replyPath: "bridge",
        replyDecisionLlm: {
          provider: "anthropic",
          model: "claude-haiku-4-5"
        }
      }
    })
  };

  await manager.turnProcessor.runRealtimeTurn({
    session,
    userId: "speaker-1",
    pcmBuffer: null,
    transcriptOverride: "we should ship tonight",
    captureReason: "speaking_end",
    transcriptionModelPrimaryOverride: "gpt-4o-mini-transcribe",
    transcriptionPlanReasonOverride: "openai_realtime_per_user_transcription"
  });

  assert.equal(textForwardPayloads.length, 1);
  assert.equal(textForwardPayloads[0]?.transcript, "we should ship tonight");
  assert.equal(textForwardPayloads[0]?.source, "realtime_transcript_turn");
  assert.equal(brainPayloads.length, 0);
  assert.equal(audioForwardPayloads.length, 0);
});

test("runRealtimeTurn forwards shared ASR transcript turns into OpenAI room-brain text flow", async () => {
  const brainPayloads = [];
  const audioForwardPayloads = [];
  const textForwardPayloads = [];
  const manager = createManager();
  manager.appConfig.openaiApiKey = "test-key";
  manager.evaluateVoiceReplyDecision = async () => ({
    allow: true,
    reason: "brain_decides",
    participantCount: 2,
    directAddressed: true,
    directAddressConfidence: 0.94,
    transcript: "shared mode transcript",
    conversationContext: {
      engagementState: "engaged",
      engaged: true,
      engagedWithCurrentSpeaker: true
    }
  });
  manager.runRealtimeBrainReply = async (payload) => {
    brainPayloads.push(payload);
    return true;
  };
  manager.forwardRealtimeTurnAudio = async (payload) => {
    audioForwardPayloads.push(payload);
    return true;
  };
  manager.forwardRealtimeTextTurnToBrain = async (payload) => {
    textForwardPayloads.push(payload);
    return true;
  };

  const session = {
    id: "session-openai-shared-text-turn-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false,
    pendingRealtimeInputBytes: 0,
    realtimeClient: {},
    settingsSnapshot: baseSettings({
      voice: {
        replyEagerness: 60,
        replyPath: "bridge",
        openaiRealtime: {
          usePerUserAsrBridge: false
        },
        replyDecisionLlm: {
          provider: "anthropic",
          model: "claude-haiku-4-5"
        }
      }
    })
  };

  await manager.turnProcessor.runRealtimeTurn({
    session,
    userId: "speaker-1",
    pcmBuffer: null,
    transcriptOverride: "shared mode transcript",
    captureReason: "speaking_end",
    transcriptionModelPrimaryOverride: "gpt-4o-mini-transcribe",
    transcriptionPlanReasonOverride: "openai_realtime_shared_transcription"
  });

  assert.equal(textForwardPayloads.length, 1);
  assert.equal(textForwardPayloads[0]?.transcript, "shared mode transcript");
  assert.equal(textForwardPayloads[0]?.source, "realtime_transcript_turn");
  assert.equal(brainPayloads.length, 0);
  assert.equal(audioForwardPayloads.length, 0);
});

test("runFileAsrTurn exits before generation when turn admission denies speaking", async () => {
  const runtimeLogs = [];
  let generateVoiceTurnCalls = 0;
  let releaseMemoryIngest = () => undefined;
  let memoryIngestCalls = 0;
  const manager = createManager({
    memory: {
      async ingestMessage() {
        memoryIngestCalls += 1;
        await new Promise((resolve) => {
          releaseMemoryIngest = resolve;
        });
      }
    }
  });
  manager.store.logAction = (row) => {
    runtimeLogs.push(row);
  };
  manager.llm.transcribeAudio = async () => ({ text: "any update?" });
  manager.llm.synthesizeSpeech = async () => ({ audioBuffer: Buffer.from([1, 2, 3]) });
  manager.transcribePcmTurn = async () => "any update?";
  manager.evaluateVoiceReplyDecision = async () => ({
    allow: false,
    reason: "classifier_deny",
    participantCount: 2,
    directAddressed: false,
    transcript: "any update?"
  });
  manager.generateVoiceTurn = async () => {
    generateVoiceTurnCalls += 1;
    return { text: "should not run" };
  };
  manager.touchActivity = () => {};

  const session = {
    id: "session-3",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false,
    settingsSnapshot: baseSettings({
      memory: {
        enabled: true
      }
    })
  };

  const turnRun = manager.turnProcessor.runFileAsrTurn({
    session,
    userId: "speaker-1",
    pcmBuffer: Buffer.from([4, 5, 6, 7]),
    captureReason: "stream_end"
  });
  const runOutcome = await Promise.race([
    turnRun.then(() => "done"),
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 80))
  ]);

  assert.equal(runOutcome, "done");
  releaseMemoryIngest();
  assert.equal(generateVoiceTurnCalls, 0);
  assert.equal(memoryIngestCalls, 1);
  const addressingLog = runtimeLogs.find(
    (row) => row?.kind === "voice_runtime" && row?.content === "voice_turn_addressing"
  );
  assert.equal(Boolean(addressingLog), true);
  assert.equal(Boolean(addressingLog?.metadata?.allow), false);
  assert.equal(addressingLog?.metadata?.reason, "classifier_deny");
});


test("runFileAsrTurn queues bot-turn-open transcripts for deferred flush", async () => {
  const queuedTurns = [];
  let runRealtimeBrainReplyCalls = 0;
  const manager = createManager();
  manager.llm.transcribeAudio = async () => ({ text: "clanker wait for this point" });
  manager.llm.synthesizeSpeech = async () => ({ audioBuffer: Buffer.from([1, 2, 3]) });
  manager.transcribePcmTurn = async () => "clanker wait for this point";
  manager.evaluateVoiceReplyDecision = async () => ({
    allow: false,
    reason: "bot_turn_open",
    participantCount: 2,
    directAddressed: true,
    transcript: "clanker wait for this point"
  });
  manager.queueDeferredBotTurnOpenTurn = (payload) => {
    queuedTurns.push(payload);
  };
  manager.runRealtimeBrainReply = async () => {
    runRealtimeBrainReplyCalls += 1;
  };
  manager.touchActivity = () => {};

  const session = {
    id: "session-stt-defer-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false,
    settingsSnapshot: baseSettings()
  };

  await manager.turnProcessor.runFileAsrTurn({
    session,
    userId: "speaker-1",
    pcmBuffer: Buffer.from([4, 5, 6, 7]),
    captureReason: "stream_end"
  });

  assert.equal(runRealtimeBrainReplyCalls, 0);
  assert.equal(queuedTurns.length, 1);
  assert.equal(queuedTurns[0]?.source, "file_asr");
  assert.equal(queuedTurns[0]?.transcript, "clanker wait for this point");
});

test("runFileAsrTurn retries full ASR model after empty mini transcript", async () => {
  const runtimeLogs = [];
  const attemptedModels = [];
  const manager = createManager();
  manager.store.logAction = (row) => {
    runtimeLogs.push(row);
  };
  manager.llm.transcribeAudio = async () => ({ text: "unused" });
  manager.llm.synthesizeSpeech = async () => ({ audioBuffer: Buffer.from([1, 2, 3]) });
  manager.transcribePcmTurn = async ({ model }) => {
    attemptedModels.push(String(model || ""));
    if (model === "gpt-4o-mini-transcribe") return "";
    return "fallback stt transcript";
  };
  manager.evaluateVoiceReplyDecision = async ({ transcript }) => ({
    allow: true,
    reason: "native_realtime",
    participantCount: 2,
    directAddressed: false,
    transcript
  });

  const session = {
    id: "session-stt-fallback-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false,
    recentVoiceTurns: [],
    settingsSnapshot: baseSettings()
  };

  await manager.turnProcessor.runFileAsrTurn({
    session,
    userId: "speaker-1",
    pcmBuffer: Buffer.alloc(96_000, 1),
    captureReason: "stream_end"
  });

  assert.deepEqual(attemptedModels, ["gpt-4o-mini-transcribe", "whisper-1"]);
  const addressingLog = runtimeLogs.find(
    (row) => row?.kind === "voice_runtime" && row?.content === "voice_turn_addressing"
  );
  assert.equal(Boolean(addressingLog), true);
  assert.equal(addressingLog?.metadata?.mode, "openai_realtime");
  assert.equal(addressingLog?.metadata?.transcriptionModelFallback, "whisper-1");
  assert.equal(addressingLog?.metadata?.transcriptionPlanReason, "mini_with_full_fallback_runtime");
  assert.equal(addressingLog?.metadata?.transcript, "fallback stt transcript");
});

test("runFileAsrTurn drops near-silent clips before ASR", async () => {
  const runtimeLogs = [];
  let transcribeCalls = 0;
  let decisionCalls = 0;
  const manager = createManager();
  manager.store.logAction = (row) => {
    runtimeLogs.push(row);
  };
  manager.llm.transcribeAudio = async () => ({ text: "unused" });
  manager.llm.synthesizeSpeech = async () => ({ audioBuffer: Buffer.from([1, 2, 3]) });
  manager.transcribePcmTurn = async () => {
    transcribeCalls += 1;
    return "hello";
  };
  manager.evaluateVoiceReplyDecision = async () => {
    decisionCalls += 1;
    return {
      allow: true,
      reason: "native_realtime",
      participantCount: 2,
      directAddressed: false,
      transcript: "hello"
    };
  };

  const session = {
    id: "session-silence-gate-stt-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false,
    recentVoiceTurns: [],
    settingsSnapshot: baseSettings()
  };

  await manager.turnProcessor.runFileAsrTurn({
    session,
    userId: "speaker-1",
    pcmBuffer: Buffer.alloc(96_000, 0),
    captureReason: "speaking_end"
  });

  assert.equal(transcribeCalls, 0);
  assert.equal(decisionCalls, 0);
  const silenceDrop = runtimeLogs.find(
    (row) => row?.kind === "voice_runtime" && row?.content === "voice_turn_dropped_silence_gate"
  );
  assert.equal(Boolean(silenceDrop), true);
  assert.equal(silenceDrop?.metadata?.source, "file_asr");
});

test("runFileAsrTurn empty transcripts escalate after streak threshold", async () => {
  const runtimeLogs = [];
  const errorLogs = [];
  const manager = createManager();
  manager.store.logAction = (row) => {
    if (row?.kind === "voice_runtime") runtimeLogs.push(row);
    if (row?.kind === "voice_error") errorLogs.push(row);
  };
  manager.llm.transcribeAudio = async () => {
    throw new Error("ASR returned empty transcript.");
  };
  manager.llm.synthesizeSpeech = async () => ({ audioBuffer: Buffer.from([1, 2, 3]) });

  const session = {
    id: "session-stt-empty-streak-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false,
    recentVoiceTurns: [],
    settingsSnapshot: baseSettings()
  };

  for (let index = 0; index < 3; index += 1) {
    await manager.turnProcessor.runFileAsrTurn({
      session,
      userId: "speaker-1",
      pcmBuffer: Buffer.alloc(48_000, 1),
      captureReason: "speaking_end"
    });
  }

  assert.equal(
    runtimeLogs.filter((row) => row?.content === "voice_stt_transcription_empty").length,
    2
  );
  const escalated = errorLogs.filter((row) =>
    String(row?.content || "").startsWith("file_asr_transcription_failed:")
  );
  assert.equal(escalated.length, 1);
  assert.equal(escalated[0]?.metadata?.emptyTranscriptStreak, 3);
});

test("queueFileAsrTurn keeps a bounded FIFO backlog while a turn is running", async () => {
  const runtimeLogs = [];
  const seenCaptureReasons = [];
  let releaseFirstTurn = () => undefined;
  let firstTurnStarted = false;
  const manager = createManager();
  manager.store.logAction = (row) => {
    runtimeLogs.push(row);
  };
  manager.turnProcessor.runFileAsrTurn = async ({ captureReason }) => {
    seenCaptureReasons.push(captureReason);
    if (!firstTurnStarted) {
      firstTurnStarted = true;
      await new Promise((resolve) => {
        releaseFirstTurn = resolve;
      });
    }
  };

  const session = {
    id: "session-stt-queue-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false,
    pendingFileAsrTurns: 0,
    fileAsrTurnDrainActive: false,
    pendingFileAsrTurnsQueue: []
  };

  manager.turnProcessor.queueFileAsrTurn({
    session,
    userId: "speaker-1",
    pcmBuffer: Buffer.from([1, 2, 3]),
    captureReason: "first"
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const queuedCount = FILE_ASR_TURN_QUEUE_MAX + 2;
  for (let index = 0; index < queuedCount; index += 1) {
    manager.turnProcessor.queueFileAsrTurn({
      session,
      userId: "speaker-1",
      pcmBuffer: Buffer.from([4 + index, 5 + index, 6 + index]),
      captureReason: `queued-${index + 1}`
    });
  }
  const expectedQueuedReasons = Array.from({ length: queuedCount }, (_row, index) => `queued-${index + 1}`).slice(
    -FILE_ASR_TURN_QUEUE_MAX
  );

  assert.deepEqual(
    session.pendingFileAsrTurnsQueue.map((turn) => turn.captureReason),
    expectedQueuedReasons
  );
  assert.equal(session.pendingFileAsrTurns, 1 + FILE_ASR_TURN_QUEUE_MAX);
  const supersededLogs = runtimeLogs.filter((row) => row?.content === "file_asr_turn_superseded");
  assert.equal(
    supersededLogs.length,
    2
  );
  assert.equal(supersededLogs[0]?.metadata?.replacedCaptureReason, "queued-1");
  assert.equal(supersededLogs[1]?.metadata?.replacedCaptureReason, "queued-2");
  assert.equal(supersededLogs[0]?.metadata?.maxQueueDepth, FILE_ASR_TURN_QUEUE_MAX);

  releaseFirstTurn();
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.deepEqual(seenCaptureReasons, ["first", ...expectedQueuedReasons]);
  assert.equal(session.pendingFileAsrTurns, 0);
});

test("queueFileAsrTurn coalesces adjacent queued turns from the same speaker", () => {
  const runtimeLogs = [];
  const manager = createManager();
  manager.store.logAction = (row) => {
    runtimeLogs.push(row);
  };

  const now = Date.now();
  const session = {
    id: "session-stt-coalesce-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false,
    pendingFileAsrTurns: 2,
    fileAsrTurnDrainActive: true,
    pendingFileAsrTurnsQueue: [
      {
        session: null,
        userId: "speaker-1",
        pcmBuffer: Buffer.from([1, 2, 3]),
        captureReason: "speaking_end",
        queuedAt: now - 200
      }
    ]
  };
  session.pendingFileAsrTurnsQueue[0].session = session;

  manager.turnProcessor.queueFileAsrTurn({
    session,
    userId: "speaker-1",
    pcmBuffer: Buffer.from([4, 5, 6, 7]),
    captureReason: "speaking_end"
  });

  assert.equal(session.pendingFileAsrTurnsQueue.length, 1);
  assert.equal(
    session.pendingFileAsrTurnsQueue[0]?.pcmBuffer.equals(Buffer.from([1, 2, 3, 4, 5, 6, 7])),
    true
  );
  assert.equal(
    runtimeLogs.some((row) => row?.kind === "voice_runtime" && row?.content === "file_asr_turn_coalesced"),
    true
  );
});

test("runFileAsrTurn drops stale queued turns before ASR when backlog exists", async () => {
  const runtimeLogs = [];
  let transcribeCalls = 0;
  let decisionCalls = 0;
  let runReplyCalls = 0;
  const manager = createManager();
  manager.store.logAction = (row) => {
    runtimeLogs.push(row);
  };
  manager.llm.transcribeAudio = async () => ({ text: "old turn" });
  manager.llm.synthesizeSpeech = async () => ({ audioBuffer: Buffer.from([1, 2, 3]) });
  manager.transcribePcmTurn = async () => {
    transcribeCalls += 1;
    return "old turn";
  };
  manager.evaluateVoiceReplyDecision = async () => {
    decisionCalls += 1;
    return {
      allow: true,
      reason: "brain_decides",
      participantCount: 2,
      directAddressed: false,
      transcript: "old turn"
    };
  };
  manager.runRealtimeBrainReply = async () => {
    runReplyCalls += 1;
  };

  const session = {
    id: "session-stt-stale-backlog-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false,
    recentVoiceTurns: [],
    pendingFileAsrTurnsQueue: [
      { userId: "speaker-2", pcmBuffer: Buffer.from([9]), captureReason: "speaking_end" },
      { userId: "speaker-3", pcmBuffer: Buffer.from([10]), captureReason: "speaking_end" }
    ],
    settingsSnapshot: baseSettings()
  };

  await manager.turnProcessor.runFileAsrTurn({
    session,
    userId: "speaker-1",
    pcmBuffer: Buffer.from([1, 2, 3, 4]),
    captureReason: "stream_end",
    queuedAt: Date.now() - 5_200
  });

  assert.equal(transcribeCalls, 0);
  assert.equal(decisionCalls, 0);
  assert.equal(runReplyCalls, 0);
  assert.equal(session.recentVoiceTurns.length, 0);
  const staleLog = runtimeLogs.find(
    (row) => row?.kind === "voice_runtime" && row?.content === "file_asr_turn_skipped_stale"
  );
  assert.equal(Boolean(staleLog), true);
  assert.equal(staleLog?.metadata?.droppedBeforeAsr, true);
});

test("runFileAsrTurn transcribes stale queued turns for context but skips reply generation", async () => {
  const runtimeLogs = [];
  let transcribeCalls = 0;
  let decisionCalls = 0;
  let runReplyCalls = 0;
  const manager = createManager();
  manager.store.logAction = (row) => {
    runtimeLogs.push(row);
  };
  manager.llm.transcribeAudio = async () => ({ text: "stale context turn" });
  manager.llm.synthesizeSpeech = async () => ({ audioBuffer: Buffer.from([1, 2, 3]) });
  manager.transcribePcmTurn = async () => {
    transcribeCalls += 1;
    return "stale context turn";
  };
  manager.evaluateVoiceReplyDecision = async () => {
    decisionCalls += 1;
    return {
      allow: true,
      reason: "brain_decides",
      participantCount: 2,
      directAddressed: false,
      transcript: "stale context turn"
    };
  };
  manager.runRealtimeBrainReply = async () => {
    runReplyCalls += 1;
  };

  const session = {
    id: "session-stt-stale-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false,
    recentVoiceTurns: [],
    settingsSnapshot: baseSettings()
  };

  await manager.turnProcessor.runFileAsrTurn({
    session,
    userId: "speaker-1",
    pcmBuffer: Buffer.from([1, 2, 3, 4]),
    captureReason: "stream_end",
    queuedAt: Date.now() - 5_200
  });

  assert.equal(transcribeCalls, 1);
  assert.equal(decisionCalls, 0);
  assert.equal(runReplyCalls, 0);
  assert.equal(session.recentVoiceTurns.length, 1);
  assert.equal(session.recentVoiceTurns[0]?.role, "user");
  assert.equal(session.recentVoiceTurns[0]?.text, "stale context turn");
  assert.equal(
    runtimeLogs.some((row) => row?.kind === "voice_runtime" && row?.content === "file_asr_turn_skipped_stale"),
    true
  );
});

test("flushDeferredBotTurnOpenTurns waits for silence before admission", async () => {
  let decisionCalls = 0;
  let scheduledFlushCalls = 0;
  const manager = createManager();
  manager.scheduleDeferredBotTurnOpenFlush = () => {
    scheduledFlushCalls += 1;
  };
  manager.evaluateVoiceReplyDecision = async () => {
    decisionCalls += 1;
    return {
      allow: true,
      reason: "native_realtime",
      participantCount: 2,
      directAddressed: false,
      transcript: "ignored"
    };
  };
  const session = {
    id: "session-stt-defer-2",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false,
    botTurnOpen: false,
    userCaptures: new Map([["speaker-1", {}]]),
    deferredVoiceActions: {
      queued_user_turns: {
        type: "queued_user_turns",
        goal: "respond_to_deferred_user_turns",
        freshnessPolicy: "regenerate_from_goal",
        status: "scheduled",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        notBeforeAt: Date.now(),
        expiresAt: 0,
        reason: "bot_turn_open",
        revision: 1,
        payload: {
          turns: [
            {
              userId: "speaker-1",
              transcript: "clanker what about this",
              pcmBuffer: null,
              captureReason: "speaking_end",
              source: "file_asr",
              directAddressed: true,
              queuedAt: Date.now()
            }
          ],
          nextFlushAt: Date.now()
        }
      }
    },
    deferredVoiceActionTimers: {}
  };

  await manager.flushDeferredBotTurnOpenTurns({ session });

  assert.equal(decisionCalls, 0);
  assert.equal(scheduledFlushCalls, 1);
  assert.equal(manager.deferredActionQueue.getDeferredQueuedUserTurns(session).length, 1);
});

test("flushDeferredBotTurnOpenTurns coalesces deferred transcripts into one admission", async () => {
  const decisionPayloads = [];
  const replyPayloads = [];
  const manager = createManager();
  manager.evaluateVoiceReplyDecision = async (payload) => {
    decisionPayloads.push(payload);
    return {
      allow: true,
      reason: "brain_decides",
      participantCount: 2,
      directAddressed: true,
      transcript: payload.transcript
    };
  };
  manager.runRealtimeBrainReply = async (payload) => {
    replyPayloads.push(payload);
  };
  const session = {
    id: "session-stt-defer-3",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false,
    botTurnOpen: false,
    userCaptures: new Map(),
    settingsSnapshot: baseSettings(),
    deferredVoiceActions: {
      queued_user_turns: {
        type: "queued_user_turns",
        goal: "respond_to_deferred_user_turns",
        freshnessPolicy: "regenerate_from_goal",
        status: "scheduled",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        notBeforeAt: Date.now(),
        expiresAt: 0,
        reason: "bot_turn_open",
        revision: 1,
        payload: {
          turns: [
            {
              userId: "speaker-1",
              transcript: "clanker hold on",
              pcmBuffer: null,
              captureReason: "speaking_end",
              source: "file_asr",
              directAddressed: true,
              queuedAt: Date.now() - 20
            },
            {
              userId: "speaker-2",
              transcript: "what about the rust panic trace",
              pcmBuffer: null,
              captureReason: "speaking_end",
              source: "file_asr",
              directAddressed: false,
              queuedAt: Date.now()
            }
          ],
          nextFlushAt: Date.now()
        }
      }
    },
    deferredVoiceActionTimers: {}
  };

  await manager.flushDeferredBotTurnOpenTurns({ session });

  assert.equal(decisionPayloads.length, 1);
  assert.equal(
    decisionPayloads[0]?.transcript,
    "clanker hold on what about the rust panic trace"
  );
  assert.equal(replyPayloads.length, 1);
  assert.equal(
    replyPayloads[0]?.transcript,
    "clanker hold on what about the rust panic trace"
  );
  assert.equal(manager.deferredActionQueue.getDeferredQueuedUserTurns(session).length, 0);
});

test("flushDeferredBotTurnOpenTurns runs brain realtime reply after one admission", async () => {
  const decisionPayloads = [];
  const realtimeReplyPayloads = [];
  const manager = createManager();
  manager.evaluateVoiceReplyDecision = async (payload) => {
    decisionPayloads.push(payload);
    return {
      allow: true,
      reason: "brain_decides",
      participantCount: 2,
      directAddressed: false,
      transcript: payload.transcript
    };
  };
  manager.runRealtimeBrainReply = async (payload) => {
    realtimeReplyPayloads.push(payload);
    return true;
  };
  const session = {
    id: "session-realtime-defer-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false,
    botTurnOpen: false,
    userCaptures: new Map(),
    settingsSnapshot: baseSettings(),
    deferredVoiceActions: {
      queued_user_turns: {
        type: "queued_user_turns",
        goal: "respond_to_deferred_user_turns",
        freshnessPolicy: "regenerate_from_goal",
        status: "scheduled",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        notBeforeAt: Date.now(),
        expiresAt: 0,
        reason: "bot_turn_open",
        revision: 1,
        payload: {
          turns: [
            {
              userId: "speaker-1",
              transcript: "clanker hold up",
              pcmBuffer: Buffer.from([1, 2]),
              captureReason: "speaking_end",
              source: "realtime",
              directAddressed: true,
              queuedAt: Date.now() - 30
            },
            {
              userId: "speaker-2",
              transcript: "add this too",
              pcmBuffer: Buffer.from([3, 4, 5]),
              captureReason: "speaking_end",
              source: "realtime",
              directAddressed: false,
              queuedAt: Date.now()
            }
          ],
          nextFlushAt: Date.now()
        }
      }
    },
    deferredVoiceActionTimers: {}
  };

  await manager.flushDeferredBotTurnOpenTurns({ session });

  assert.equal(decisionPayloads.length, 1);
  assert.equal(decisionPayloads[0]?.transcript, "clanker hold up add this too");
  assert.equal(realtimeReplyPayloads.length, 1);
  assert.equal(realtimeReplyPayloads[0]?.transcript, "clanker hold up add this too");
  assert.equal(realtimeReplyPayloads[0]?.source, "bot_turn_open_deferred_flush");
  assert.equal(realtimeReplyPayloads[0]?.directAddressed, false);
  assert.equal(manager.deferredActionQueue.getDeferredQueuedUserTurns(session).length, 0);
});

test("flushDeferredBotTurnOpenTurns forwards native realtime audio after one admission", async () => {
  const decisionPayloads = [];
  const forwardedPayloads = [];
  const manager = createManager();
  manager.evaluateVoiceReplyDecision = async (payload) => {
    decisionPayloads.push(payload);
    return {
      allow: true,
      reason: "brain_decides",
      participantCount: 2,
      directAddressed: false,
      transcript: payload.transcript
    };
  };
  manager.forwardRealtimeTurnAudio = async (payload) => {
    forwardedPayloads.push(payload);
    return true;
  };
  manager.runRealtimeBrainReply = async () => {
    throw new Error("should_not_use_brain_path");
  };

  const firstPcm = Buffer.from([1, 2]);
  const secondPcm = Buffer.from([3, 4, 5]);
  const session = {
    id: "session-realtime-native-defer-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false,
    botTurnOpen: false,
    userCaptures: new Map(),
    settingsSnapshot: baseSettings({
      voice: {
        replyEagerness: 60,
        replyPath: "native",
        replyDecisionLlm: {
          provider: "anthropic",
          model: "claude-haiku-4-5"
        }
      }
    }),
    deferredVoiceActions: {
      queued_user_turns: {
        type: "queued_user_turns",
        goal: "respond_to_deferred_user_turns",
        freshnessPolicy: "regenerate_from_goal",
        status: "scheduled",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        notBeforeAt: Date.now(),
        expiresAt: 0,
        reason: "bot_turn_open",
        revision: 1,
        payload: {
          turns: [
            {
              userId: "speaker-1",
              transcript: "clanker hold up",
              pcmBuffer: firstPcm,
              captureReason: "speaking_end",
              source: "realtime",
              directAddressed: true,
              queuedAt: Date.now() - 30
            },
            {
              userId: "speaker-2",
              transcript: "add this too",
              pcmBuffer: secondPcm,
              captureReason: "speaking_end",
              source: "realtime",
              directAddressed: false,
              queuedAt: Date.now()
            }
          ],
          nextFlushAt: Date.now()
        }
      }
    },
    deferredVoiceActionTimers: {}
  };

  await manager.flushDeferredBotTurnOpenTurns({ session });

  assert.equal(decisionPayloads.length, 1);
  assert.equal(decisionPayloads[0]?.transcript, "clanker hold up add this too");
  assert.equal(forwardedPayloads.length, 1);
  assert.equal(forwardedPayloads[0]?.transcript, "clanker hold up add this too");
  const forwardedPcm = Buffer.isBuffer(forwardedPayloads[0]?.pcmBuffer)
    ? forwardedPayloads[0].pcmBuffer
    : Buffer.alloc(0);
  assert.deepEqual([...forwardedPcm], [...Buffer.concat([firstPcm, secondPcm])]);
  assert.equal(forwardedPayloads[0]?.captureReason, "bot_turn_open_deferred_flush");
  assert.equal(manager.deferredActionQueue.getDeferredQueuedUserTurns(session).length, 0);
});

test("voice decision history deduplicates consecutive identical turns", () => {
  const manager = createManager();
  const session = {
    id: "session-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    voiceChannelId: "voice-1",
    mode: "openai_realtime",
    ending: false,
    recentVoiceTurns: [],
    settingsSnapshot: { botName: "clanker conk" }
  };

  manager.resolveVoiceSpeakerName = (_session, userId) => `user-${String(userId || "")}`;
  manager.recordVoiceTurn(session, { role: "user", userId: "a", text: "first turn" });
  manager.recordVoiceTurn(session, { role: "user", userId: "a", text: "first turn" });
  manager.recordVoiceTurn(session, { role: "assistant", text: "second turn" });

  assert.equal(session.recentVoiceTurns.length, 2);
  const formatted = manager.formatVoiceDecisionHistory(session, 6);
  assert.equal(formatted.includes("user-a"), true);
  assert.equal(formatted.includes("YOU"), true);
});

test("buildRealtimeInstructions forbids claiming screen vision before frame context exists", () => {
  const manager = createManager();
  manager.getVoiceScreenShareCapability = () => ({
    supported: true,
    enabled: true,
    available: true,
    status: "ready",
    publicUrl: "https://screen.example",
    reason: null
  });

  const instructions = manager.instructionManager.buildRealtimeInstructions({
    session: {
      id: "session-screen-vision-1",
      guildId: "guild-1",
      textChannelId: "chan-1",
      voiceChannelId: "voice-1",
      mode: "openai_realtime",
      startedAt: Date.now() - 5_000,
      membershipEvents: [],
      voiceChannelEffects: [
        {
          userId: "speaker-2",
          displayName: "bob",
          channelId: "voice-1",
          guildId: "guild-1",
          effectType: "soundboard",
          soundId: "123",
          soundName: "rimshot",
          soundVolume: 0.9,
          emoji: null,
          animationType: null,
          animationId: null,
          at: Date.now() - 1_000
        }
      ]
    },
    settings: baseSettings(),
    speakerUserId: "speaker-1",
    transcript: "can i share my screen with you"
  });

  assert.equal(instructions.includes("You do not currently see the user's screen."), true);
  assert.equal(instructions.includes("Do not claim to see, watch, or react to on-screen content until actual frame context is provided."), true);
  assert.equal(instructions.includes("call offer_screen_share_link"), true);
  assert.equal(instructions.includes("Recent voice effects: bob played soundboard \"rimshot\""), true);
});

test("buildRealtimeInstructions omits native tooling policy for transport-only sessions", () => {
  const manager = createManager();

  const instructions = manager.instructionManager.buildRealtimeInstructions({
    session: {
      id: "session-transport-tools-1",
      guildId: "guild-1",
      textChannelId: "chan-1",
      voiceChannelId: "voice-1",
      mode: "openai_realtime",
      realtimeToolOwnership: "transport_only",
      startedAt: Date.now() - 5_000,
      membershipEvents: [],
      openAiToolDefinitions: [
        {
          name: "memory_search",
          toolType: "function",
          description: "Search memory"
        }
      ]
    },
    settings: baseSettings({
      voice: {
        mode: "openai_realtime",
        replyPath: "brain"
      }
    })
  });

  assert.equal(instructions.includes("Tooling policy:"), false);
  assert.equal(instructions.includes("Local tools:"), false);
});
