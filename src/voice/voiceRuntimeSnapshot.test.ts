import { test } from "bun:test";
import assert from "node:assert/strict";
import { createTestSettings } from "../testSettings.ts";
import { buildVoiceRuntimeSnapshot } from "./voiceRuntimeSnapshot.ts";

test("buildVoiceRuntimeSnapshot captures rich realtime and file-ASR session state", () => {
  const now = Date.parse("2026-03-06T18:00:00.000Z");
  const originalNow = Date.now;
  Date.now = () => now;

  try {
    const realtimeSession = {
      id: "session-1",
      guildId: "guild-1",
      voiceChannelId: "voice-1",
      textChannelId: "text-1",
      startedAt: now - 10_000,
      lastActivityAt: now - 2_000,
      maxEndsAt: now + 60_000,
      inactivityEndsAt: now + 30_000,
      userCaptures: new Map([
        ["user-2", { startedAt: now - 4_000 }],
        ["user-3", { startedAt: now - 8_000 }]
      ]),
      soundboard: {
        playCount: 2,
        lastPlayedAt: now - 9_000
      },
      mode: "openai_realtime",
      realtimeToolOwnership: "provider_native",
      botTurnOpen: true,
      assistantOutput: {
        reason: "replying",
        lastTrigger: "speech_detected",
        phaseEnteredAt: now - 1_500,
        requestId: 7.6,
        ttsPlaybackState: "playing",
        ttsBufferedSamples: 240
      },
      playbackArmed: true,
      playbackArmedReason: "connected",
      playbackArmedAt: now - 7_000,
      lastAssistantReplyAt: now - 7_500,
      lastDirectAddressAt: now - 4_500,
      lastDirectAddressUserId: "user-1",
      musicWakeLatchedUntil: now + 5_000,
      musicWakeLatchedByUserId: "user-2",
      thoughtLoopBusy: true,
      nextThoughtAt: now + 12_000,
      lastThoughtAttemptAt: now - 6_000,
      lastThoughtSpokenAt: now - 12_000,
      pendingAmbientThought: {
        id: "thought-1",
        status: "reconsider",
        trigger: "timer",
        draftText: "what if pigeons had rent",
        currentText: "what if pigeons had rent",
        createdAt: now - 15_000,
        updatedAt: now - 2_000,
        basisAt: now - 2_000,
        notBeforeAt: now + 5_000,
        expiresAt: now + 45_000,
        revision: 2,
        lastDecisionReason: "felt half-baked",
        lastDecisionAction: "hold",
        memoryFactCount: 1,
        usedMemory: false,
        invalidatedAt: now - 2_000,
        invalidatedByUserId: "user-1",
        invalidationReason: "new_user_turn"
      },
      recentVoiceTurns: [
        { role: "user", speakerName: "Alice", text: "hey bot", at: now - 2_000 }
      ],
      transcriptTurns: [
        {
          role: "user",
          speakerName: "Alice",
          text: "hey bot",
          at: now - 2_000,
          addressing: {
            talkingTo: "bot-1",
            directedConfidence: 1.2,
            source: "classifier",
            reason: "wake_word"
          }
        },
        {
          role: "assistant",
          speakerName: "clanky",
          text: "what's up",
          at: now - 1_000
        }
      ],
      durableContext: [
        {
          text: "Alice likes concise answers",
          category: "preference",
          at: now - 500
        }
      ],
      modelContextSummary: {
        generation: {
          summary: "generation summary"
        },
        decider: {
          summary: "decider summary"
        }
      },
      lastGenerationContext: {
        route: "voice_reply"
      },
      livePromptState: {
        classifier: {
          updatedAt: now - 550,
          source: "realtime",
          replyPrompts: {
            hiddenByDefault: true,
            systemPrompt: "Return exactly one token: YES or NO.",
            initialUserPrompt: "Transcript: \"hey bot\"",
            followupUserPrompts: [],
            followupSteps: 0
          }
        },
        generation: {
          updatedAt: now - 500,
          source: "realtime_transport",
          replyPrompts: {
            hiddenByDefault: true,
            systemPrompt: "You are speaking in live Discord voice chat.",
            initialUserPrompt: "Alice: hey bot",
            followupUserPrompts: ["Use the browser screenshot if it helps."],
            followupSteps: 1
          }
        },
        bridge: {
          updatedAt: now - 450,
          source: "openai_realtime_text_turn",
          replyPrompts: {
            hiddenByDefault: true,
            systemPrompt: "You are in bridge mode. Reply naturally.",
            initialUserPrompt: "(alice): where's lunch",
            followupUserPrompts: [],
            followupSteps: 0
          }
        }
      },
      streamWatch: {
        active: true,
        targetUserId: "user-2",
        requestedByUserId: "user-1",
        lastFrameAt: now - 900,
        lastCommentaryAt: now - 850,
        lastCommentaryNote: "frame looked busy",
        lastMemoryRecapAt: now - 800,
        lastMemoryRecapText: "saved a recap",
        lastMemoryRecapDurableSaved: true,
        lastMemoryRecapReason: "periodic",
        latestFrameAt: now - 700,
        latestFrameMimeType: "image/jpeg",
        latestFrameDataBase64: "abcdefgh",
        acceptedFrameCountInWindow: 4,
        frameWindowStartedAt: now - 20_000,
        lastNoteAt: now - 650,
        lastNoteProvider: "openai",
        lastNoteModel: "gpt-5.4-mini",
        noteEntries: [
          {
            text: "enemy spotted left side",
            at: now - 600,
            provider: "openai",
            model: "gpt-5.4-mini",
            speakerName: "Alice"
          }
        ],
        ingestedFrameCount: 5
      },
      openAiAsrSessions: new Map([
        [
          "user-1",
          {
            client: {
              ws: { readyState: 1 },
              sessionConfig: {
                inputTranscriptionModel: "gpt-4o-mini-transcribe"
              },
              sessionId: "asr-1"
            },
            phase: "streaming",
            connectedAt: now - 20_000,
            lastAudioAt: now - 1_100,
            lastTranscriptAt: now - 900,
            idleTimer: {},
            pendingAudioBytes: 128,
            pendingAudioChunks: [Buffer.from([1]), Buffer.from([2])],
            utterance: {
              partialText: "hello there",
              finalSegments: ["one"],
              bytesSent: 256
            }
          }
        ]
      ]),
      openAiSharedAsrState: {
        client: {
          ws: { readyState: 1 },
          sessionConfig: {
            inputTranscriptionModel: "gpt-4o-transcribe"
          },
          sessionId: "shared-1"
        },
        phase: "listening",
        userId: "user-2",
        connectedAt: now - 25_000,
        lastAudioAt: now - 2_000,
        lastTranscriptAt: now - 1_900,
        idleTimer: {},
        pendingAudioBytes: 64,
        pendingAudioChunks: [Buffer.from([3])],
        pendingCommitResolvers: [() => {}],
        pendingCommitRequests: [{}],
        finalTranscriptsByItemId: new Map([["item-1", "hello"]]),
        itemIdToUserId: new Map([["item-1", "user-2"]]),
        utterance: {
          partialText: "shared partial",
          finalSegments: ["one", "two"],
          bytesSent: 512
        }
      },
      realtimeToolDefinitions: [
        {
          name: "memory_write",
          toolType: "function",
          description: "Write durable memory"
        },
        {
          name: "lookup_docs",
          toolType: "mcp",
          description: "Lookup docs",
          serverName: "web"
        }
      ],
      toolCallEvents: [
        {
          callId: "call-1",
          toolName: "memory_write",
          toolType: "function",
          arguments: { namespace: "speaker", items: [{ text: "prefers short replies" }] },
          startedAt: "2026-03-06T17:59:50.000Z",
          completedAt: "2026-03-06T17:59:51.000Z",
          runtimeMs: 101.2,
          success: true,
          outputSummary: "found",
          error: null
        }
      ],
      mcpStatus: [
        {
          serverName: "web",
          connected: true,
          tools: [{ name: "lookup_docs", description: "Lookup docs" }],
          lastError: null,
          lastConnectedAt: "2026-03-06T17:30:00.000Z",
          lastCallAt: "2026-03-06T17:59:51.000Z"
        }
      ],
      factProfiles: new Map([
        [
          "user-1",
          {
            loadedAt: now - 1_200,
            userFacts: [
              {
                id: 11,
                created_at: "2026-03-05T12:00:00.000Z",
                updated_at: "2026-03-06T17:59:58.800Z",
                guild_id: "guild-1",
                channel_id: "text-1",
                subject: "user-1",
                fact: "Likes ramen.",
                fact_type: "preference",
                evidence_text: "I love ramen",
                source_message_id: "msg-1",
                confidence: 0.92
              }
            ]
          }
        ]
      ]),
      guildFactProfile: {
        loadedAt: now - 1_000,
        selfFacts: [
          {
            id: 21,
            created_at: "2026-03-01T12:00:00.000Z",
            updated_at: "2026-03-06T17:59:59.000Z",
            guild_id: "guild-1",
            channel_id: null,
            subject: "__self__",
            fact: "Bot likes concise replies.",
            fact_type: "profile",
            evidence_text: "Keep it tight",
            source_message_id: "msg-self",
            confidence: 0.88
          }
        ],
        loreFacts: [
          {
            id: 22,
            created_at: "2026-03-02T12:00:00.000Z",
            updated_at: "2026-03-06T17:59:59.100Z",
            guild_id: "guild-1",
            channel_id: null,
            subject: "__lore__",
            fact: "Guild runs Friday game night.",
            fact_type: "relationship",
            evidence_text: "We do game night Fridays",
            source_message_id: "msg-lore",
            confidence: 0.81
          }
        ]
      },
      realtimeProvider: "openai",
      baseVoiceInstructions: "Reply naturally in live voice chat.",
      lastRealtimeInstructions: "Use the latest voice context and stay concise.",
      lastRealtimeInstructionsAt: now - 400,
      realtimeInputSampleRateHz: 16_000,
      realtimeOutputSampleRateHz: 24_000,
      realtimeReplySupersededCount: 1,
      pendingRealtimeTurns: [{ id: "turn-1" }, { id: "turn-2" }],
      realtimeTurnDrainActive: true,
      realtimeTurnCoalesceTimer: {},
      realtimeClient: {
        getState() {
          return {
            phase: "connected"
          };
        }
      },
      latencyStages: [
        {
          at: now - 2_000,
          finalizedToAsrStartMs: 100,
          asrToGenerationStartMs: 200,
          generationToReplyRequestMs: 300,
          replyRequestToAudioStartMs: 400,
          totalMs: 1_000,
          queueWaitMs: 50,
          pendingQueueDepth: 1
        },
        {
          at: now - 1_000,
          finalizedToAsrStartMs: 200,
          asrToGenerationStartMs: 300,
          generationToReplyRequestMs: 400,
          replyRequestToAudioStartMs: 500,
          totalMs: 1_400,
          queueWaitMs: 60,
          pendingQueueDepth: 2
        }
      ],
      settingsSnapshot: createTestSettings({})
    };

    const sttSession = {
      id: "session-2",
      guildId: "guild-2",
      voiceChannelId: "voice-2",
      textChannelId: "text-2",
      startedAt: now - 40_000,
      lastActivityAt: now - 5_000,
      userCaptures: new Map(),
      soundboard: {
        playCount: 0,
        lastPlayedAt: 0
      },
      mode: "openai_realtime",
      realtimeProvider: "openai",
      botTurnOpen: false,
      recentVoiceTurns: [],
      transcriptTurns: [],
      thoughtLoopBusy: false,
      nextThoughtAt: 0,
      lastThoughtAttemptAt: 0,
      lastThoughtSpokenAt: 0,
      pendingFileAsrTurns: 3,
      latencyStages: [],
      settingsSnapshot: createTestSettings({})
    };

    const sessions = new Map([
      ["session-1", realtimeSession],
      ["session-2", sttSession]
    ]);

    const snapshot = buildVoiceRuntimeSnapshot(sessions, {
      client: {
        users: {
          cache: {
            get(userId: string) {
              if (userId === "user-3") {
                return {
                  username: "Charlie"
                };
              }
              return null;
            }
          }
        }
      },
      replyManager: {
        syncAssistantOutputState(session) {
          return {
            phase: session.id === "session-1" ? "speaking" : "idle"
          };
        }
      },
      deferredActionQueue: {
        getDeferredQueuedUserTurns(session) {
          return session.id === "session-1" ? [{ id: "queued-1" }, { id: "queued-2" }] : [];
        }
      },
      getVoiceChannelParticipants(session) {
        if (session.id === "session-1") {
          return [
            { userId: "user-1", displayName: "Alice" },
            { userId: "user-4", displayName: "Dana" }
          ];
        }
        return [{ userId: "user-9", displayName: "Eve" }];
      },
      getRecentVoiceMembershipEvents(session) {
        if (session.id === "session-1") {
          return [
            {
              userId: "user-2",
              displayName: "Bobby",
              eventType: "join",
              at: now - 30_000,
              ageMs: 30_000
            }
          ];
        }
        return [];
      },
      buildVoiceConversationContext(session) {
        if (session.id !== "session-1") return null;
        return {
          attentionMode: "ACTIVE",
          currentSpeakerActive: true,
          recentAssistantReply: true,
          recentDirectAddress: true,
          msSinceAssistantReply: 7_500,
          msSinceDirectAddress: 4_500
        };
      },
      buildVoiceAddressingState(session) {
        if (session.id !== "session-1") return null;
        return {
          currentSpeakerTarget: "bot-1",
          currentSpeakerDirectedConfidence: 0.91,
          lastDirectedToMe: {
            speakerName: "Alice",
            directedConfidence: 0.91,
            ageMs: 4_500
          },
          recentAddressingGuesses: [
            {
              speakerName: "Alice",
              talkingTo: "bot-1",
              directedConfidence: 0.91,
              ageMs: 4_500
            }
          ]
        };
      },
      getStreamWatchNotesForPrompt(session) {
        if (session.id !== "session-1") return null;
        return {
          prompt: "watch the left side",
          notes: ["enemy nearby", "", "watching doorway"],
          lastAt: now - 650,
          provider: "openai",
          model: "gpt-5.4-mini"
        };
      },
      snapshotMusicRuntimeState(session) {
        return session.id === "session-1"
          ? {
              active: true,
              queueState: {
                tracks: [{ title: "Current Song", artist: "Current Artist" }],
                nowPlayingIndex: 0,
                isPaused: false
              }
            }
          : {
              active: false
            };
      }
    });

    assert.equal(snapshot.activeCount, 2);

    const realtime = snapshot.sessions.find((entry) => entry.sessionId === "session-1");
    assert.ok(realtime);
    assert.equal(realtime?.participants.length, 2);
    assert.deepEqual(realtime?.activeCaptures, [
      {
        userId: "user-2",
        displayName: "Bobby",
        startedAt: "2026-03-06T17:59:56.000Z",
        ageMs: 4_000
      },
      {
        userId: "user-3",
        displayName: "Charlie",
        startedAt: "2026-03-06T17:59:52.000Z",
        ageMs: 8_000
      }
    ]);
    assert.equal(realtime?.assistantOutput.phase, "speaking");
    assert.equal(realtime?.assistantOutput.requestId, 8);
    assert.equal(realtime?.conversation.wake.windowMs, 35_000);
    assert.equal(realtime?.pendingDeferredTurns, 2);
    assert.equal(realtime?.recentTurns[0]?.addressing?.directedConfidence, 1);
    assert.deepEqual(realtime?.conversation.thoughtEngine.pendingThought, {
      id: "thought-1",
      status: "reconsider",
      text: "what if pigeons had rent",
      draftText: "what if pigeons had rent",
      trigger: "timer",
      createdAt: "2026-03-06T17:59:45.000Z",
      updatedAt: "2026-03-06T17:59:58.000Z",
      basisAt: "2026-03-06T17:59:58.000Z",
      notBeforeAt: "2026-03-06T18:00:05.000Z",
      expiresAt: "2026-03-06T18:00:45.000Z",
      ageMs: 15_000,
      revision: 2,
      lastDecisionReason: "felt half-baked",
      lastDecisionAction: "hold",
      memoryFactCount: 1,
      usedMemory: false,
      invalidatedAt: "2026-03-06T17:59:58.000Z",
      invalidatedByUserId: "user-1",
      invalidationReason: "new_user_turn"
    });
    assert.deepEqual(realtime?.durableContext, [
      {
        text: "Alice likes concise answers",
        category: "preference",
        at: "2026-03-06T17:59:59.500Z"
      }
    ]);
    assert.equal(realtime?.streamWatch.latestFrameApproxBytes, 6);
    assert.deepEqual(realtime?.streamWatch.notePayload, {
      prompt: "watch the left side",
      notes: ["enemy nearby", "watching doorway"],
      lastAt: "2026-03-06T17:59:59.350Z",
      provider: "openai",
      model: "gpt-5.4-mini"
    });
    assert.equal(
      realtime?.promptState?.instructions?.replyPrompts?.systemPrompt,
      "Use the latest voice context and stay concise."
    );
    assert.equal(realtime?.promptState?.classifier?.replyPrompts?.initialUserPrompt, "Transcript: \"hey bot\"");
    assert.deepEqual(realtime?.promptState?.generation?.replyPrompts?.followupUserPrompts, [
      "Use the browser screenshot if it helps."
    ]);
    assert.equal(realtime?.promptState?.bridge?.replyPrompts?.initialUserPrompt, "(alice): where's lunch");
    assert.deepEqual(realtime?.asrSessions, [
      {
        userId: "user-1",
        displayName: "Alice",
        connected: true,
        phase: "streaming",
        connectedAt: "2026-03-06T17:59:40.000Z",
        lastAudioAt: "2026-03-06T17:59:58.900Z",
        lastTranscriptAt: "2026-03-06T17:59:59.100Z",
        idleMs: 900,
        idleTtlMs: 60_000,
        hasIdleTimer: true,
        pendingAudioBytes: 128,
        pendingAudioChunks: 2,
        utterance: {
          partialText: "hello there",
          finalSegments: 1,
          bytesSent: 256
        },
        model: "gpt-4o-mini-transcribe",
        sessionId: "asr-1"
      }
    ]);
    assert.deepEqual(realtime?.sharedAsrSession, {
      connected: true,
      phase: "listening",
      userId: "user-2",
      displayName: null,
      connectedAt: "2026-03-06T17:59:35.000Z",
      lastAudioAt: "2026-03-06T17:59:58.000Z",
      lastTranscriptAt: "2026-03-06T17:59:58.100Z",
      idleMs: 1_900,
      idleTtlMs: 60_000,
      hasIdleTimer: true,
      pendingAudioBytes: 64,
      pendingAudioChunks: 1,
      pendingCommitResolvers: 1,
      pendingCommitRequests: 1,
      transcriptByItemIds: 1,
      speakerByItemIds: 1,
      utterance: {
        partialText: "shared partial",
        finalSegments: 2,
        bytesSent: 512
      },
      model: "gpt-4o-transcribe",
      sessionId: "shared-1"
    });
    assert.equal(realtime?.realtimeToolOwnership, "provider_native");
    assert.equal(realtime?.brainTools?.length, 2);
    assert.equal(realtime?.toolCalls?.[0]?.runtimeMs, 101);
    assert.equal(realtime?.mcpStatus?.[0]?.serverName, "web");
    assert.equal(realtime?.music?.active, true);
    assert.deepEqual(realtime?.memory, {
      factProfiles: [
        {
          userId: "user-1",
          displayName: "Alice",
          loadedAt: "2026-03-06T17:59:58.800Z",
          userFacts: [
            {
              id: 11,
              createdAt: "2026-03-05T12:00:00.000Z",
              updatedAt: "2026-03-06T17:59:58.800Z",
              guildId: "guild-1",
              channelId: "text-1",
              subject: "user-1",
              fact: "Likes ramen.",
              factType: "preference",
              evidenceText: "I love ramen",
              sourceMessageId: "msg-1",
              confidence: 0.92
            }
          ]
        }
      ],
      guildFactProfile: {
        loadedAt: "2026-03-06T17:59:59.000Z",
        selfFacts: [
          {
            id: 21,
            createdAt: "2026-03-01T12:00:00.000Z",
            updatedAt: "2026-03-06T17:59:59.000Z",
            guildId: "guild-1",
            channelId: null,
            subject: "__self__",
            fact: "Bot likes concise replies.",
            factType: "profile",
            evidenceText: "Keep it tight",
            sourceMessageId: "msg-self",
            confidence: 0.88
          }
        ],
        loreFacts: [
          {
            id: 22,
            createdAt: "2026-03-02T12:00:00.000Z",
            updatedAt: "2026-03-06T17:59:59.100Z",
            guildId: "guild-1",
            channelId: null,
            subject: "__lore__",
            fact: "Guild runs Friday game night.",
            factType: "relationship",
            evidenceText: "We do game night Fridays",
            sourceMessageId: "msg-lore",
            confidence: 0.81
          }
        ]
      }
    });
    assert.deepEqual(realtime?.realtime, {
      provider: "openai",
      inputSampleRateHz: 16_000,
      outputSampleRateHz: 24_000,
      recentVoiceTurns: 1,
      replySuperseded: 1,
      pendingTurns: 3,
      drainActive: true,
      coalesceActive: true,
      state: {
        phase: "connected"
      }
    });
    assert.deepEqual(realtime?.latency?.averages, {
      finalizedToAsrStartMs: 150,
      asrToGenerationStartMs: 250,
      generationToReplyRequestMs: 350,
      replyRequestToAudioStartMs: 450,
      totalMs: 1_200
    });

    const fileAsrSession = snapshot.sessions.find((entry) => entry.sessionId === "session-2");
    assert.ok(fileAsrSession);
    assert.deepEqual(fileAsrSession?.batchAsr, {
      pendingTurns: 3,
      contextMessages: 0
    });
    assert.equal(fileAsrSession?.realtime?.provider, "openai");
    assert.equal(fileAsrSession?.realtime?.state, null);
  } finally {
    Date.now = originalNow;
  }
});

test("buildVoiceRuntimeSnapshot hides native tool registry in transport-only sessions but keeps shared tool state", () => {
  const now = Date.parse("2026-03-06T18:00:00.000Z");
  const originalNow = Date.now;
  Date.now = () => now;

  try {
    const snapshot = buildVoiceRuntimeSnapshot(new Map([
      ["session-transport-1", {
        id: "session-transport-1",
        guildId: "guild-1",
        voiceChannelId: "voice-1",
        textChannelId: "text-1",
        startedAt: Date.now() - 5_000,
        lastActivityAt: Date.now() - 500,
        mode: "openai_realtime",
        realtimeToolOwnership: "transport_only",
        realtimeToolDefinitions: [
          {
            name: "memory_write",
            toolType: "function",
            description: "Write durable memory"
          }
        ],
        toolCallEvents: [
          {
            callId: "call-1",
            toolName: "memory_write",
            toolType: "function",
            arguments: { namespace: "speaker", items: [{ text: "prefers short replies" }] },
            startedAt: "2026-03-06T17:59:50.000Z",
            completedAt: "2026-03-06T17:59:51.000Z",
            runtimeMs: 101.2,
            success: true,
            outputSummary: "found",
            error: null
          }
        ],
        mcpStatus: [
          {
            serverName: "web",
            connected: true,
            tools: [{ name: "lookup_docs", description: "Lookup docs" }],
            lastError: null,
            lastConnectedAt: null,
            lastCallAt: null
          }
        ],
        userCaptures: new Map(),
        recentVoiceTurns: [],
        transcriptTurns: [],
        durableContext: [],
        modelContextSummary: { generation: null, decider: null },
        factProfiles: new Map(),
        guildFactProfile: null,
        streamWatch: { active: false }
      }]
    ]), {
      client: {
        users: {
          cache: {
            get() {
              return null;
            }
          }
        }
      },
      replyManager: {
        syncAssistantOutputState() {
          return { phase: "idle" };
        }
      },
      deferredActionQueue: {
        getDeferredQueuedUserTurns() {
          return [];
        }
      },
      getVoiceChannelParticipants() {
        return [];
      },
      getRecentVoiceMembershipEvents() {
        return [];
      },
      buildVoiceConversationContext() {
        return null;
      },
      buildVoiceAddressingState() {
        return null;
      },
      getStreamWatchNotesForPrompt() {
        return null;
      },
      snapshotMusicRuntimeState() {
        return { active: false };
      },
      guildMemberDisplayNames: new Map()
    });

    const session = snapshot.sessions?.[0];
    assert.equal(session?.realtimeToolOwnership, "transport_only");
    assert.equal(session?.brainTools, null);
    assert.equal(session?.toolCalls?.length, 1);
    assert.equal(session?.mcpStatus?.[0]?.serverName, "web");
  } finally {
    Date.now = originalNow;
  }
});
