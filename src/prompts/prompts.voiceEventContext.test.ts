import { test } from "bun:test";
import assert from "node:assert/strict";
import { buildVoiceTurnPrompt } from "./index.ts";

test("buildVoiceTurnPrompt treats event cues as room context", () => {
  const prompt = buildVoiceTurnPrompt({
    speakerName: "alice",
    inputKind: "event",
    transcript: "[alice joined the voice channel]",
    runtimeEventContext: {
      category: "membership",
      eventType: "join",
      actorUserId: "user-1",
      actorDisplayName: "alice",
      actorRole: "other"
    }
  });

  assert.equal(
    prompt.includes(
      "This is a voice-room event cue, not literal quoted speech."
    ),
    true
  );
  assert.equal(
    prompt.includes(
      "If a brief acknowledgement of the join would feel natural, you may reply briefly. Otherwise use [SKIP]."
    ),
    true
  );
});

test("buildVoiceTurnPrompt treats structured self-join events as the bot's own arrival", () => {
  const prompt = buildVoiceTurnPrompt({
    speakerName: "clanker conk",
    inputKind: "event",
    transcript: "[YOU joined the voice channel]",
    runtimeEventContext: {
      category: "membership",
      eventType: "join",
      actorUserId: "bot-1",
      actorDisplayName: "clanker conk",
      actorRole: "self"
    }
  });

  assert.equal(prompt.includes("Voice runtime event cue: you joined the voice channel."), true);
  assert.equal(prompt.includes("Structured event type: membership.join."), true);
  assert.equal(
    prompt.includes(
      "If you just entered the channel and a quick hello would feel natural, you may reply briefly. Otherwise use [SKIP]."
    ),
    true
  );
});

test("buildVoiceTurnPrompt uses structured screen-share event context instead of generic room-event guidance", () => {
  const prompt = buildVoiceTurnPrompt({
    speakerName: "alice",
    inputKind: "event",
    transcript: "[alice started screen sharing. You can see the latest frame.]",
    runtimeEventContext: {
      category: "screen_share",
      eventType: "share_start",
      actorUserId: "user-1",
      actorDisplayName: "alice",
      actorRole: "other",
      hasVisibleFrame: true
    }
  });

  assert.equal(prompt.includes("Voice runtime event cue: alice started screen sharing."), true);
  assert.equal(prompt.includes("Structured event type: screen_share.share_start."), true);
  assert.equal(prompt.includes("A visible screen frame is attached for this event."), true);
  assert.equal(prompt.includes("This is a screen-share state cue, not a spoken request."), true);
  assert.equal(prompt.includes("If a brief acknowledgement of the join/leave would feel natural"), false);
});

test("buildVoiceTurnPrompt biases low-information eager turns toward skip", () => {
  const prompt = buildVoiceTurnPrompt({
    speakerName: "alice",
    transcript: "haha",
    isEagerTurn: true,
    voiceAmbientReplyEagerness: 50
  });

  assert.equal(
    prompt.includes(
      "If the turn is laughter, filler, backchannel noise (haha, lol, hmm, mm, uh-huh, yup), or self-talk/thinking out loud"
    ),
    true
  );
});

test("buildVoiceTurnPrompt treats fuzzy bot-name cues as a positive signal", () => {
  const prompt = buildVoiceTurnPrompt({
    speakerName: "alice",
    transcript: "hey clanker play some music",
    botName: "clanker conk",
    directAddressed: false
  });

  assert.equal(
    prompt.includes(
      "The transcript may be using clanker conk's name or a phonetic variation of it. Treat that as a positive signal that the speaker may be talking to you."
    ),
    true
  );
  assert.equal(
    prompt.includes(
      "The transcript contains your name or a phonetic variant of it. This is a strong signal the speaker is talking to you"
    ),
    true
  );
});

test("buildVoiceTurnPrompt explains browser tool usage when interactive browsing is available", () => {
  const prompt = buildVoiceTurnPrompt({
    speakerName: "alice",
    transcript: "can you check that website for me",
    allowBrowserBrowseToolCall: true,
    browserBrowse: {
      enabled: true,
      configured: true,
      blockedByBudget: false,
      budget: {
        canBrowse: true
      }
    }
  });

  assert.equal(prompt.includes("browser_browse:"), true);
  assert.equal(prompt.includes("interactive browsing"), true);
  assert.equal(prompt.includes("screenshots"), true);
});

test("buildVoiceTurnPrompt explains screen-share tool usage when link offers are available", () => {
  const prompt = buildVoiceTurnPrompt({
    speakerName: "alice",
    transcript: "can you watch my screen",
    allowScreenShareToolCall: true,
    screenShare: {
      enabled: true,
      available: true,
      status: "ready",
      reason: null
    }
  });

  assert.equal(prompt.includes("offer_screen_share_link"), true);
  assert.equal(prompt.includes("watch their screen"), true);
  assert.equal(prompt.includes("voice JSON contract"), false);
});

test("buildVoiceTurnPrompt keeps active-music pass-through replies short by default", () => {
  const prompt = buildVoiceTurnPrompt({
    speakerName: "alice",
    transcript: "yo do you like minecraft",
    musicContext: {
      playbackState: "playing",
      replyHandoffMode: null,
      currentTrack: {
        id: "track-1",
        title: "Subwoofer Lullaby",
        artists: ["C418"]
      },
      lastTrack: null,
      queueLength: 1,
      upcomingTracks: [],
      lastAction: "play_now",
      lastQuery: "minecraft music"
    },
    allowVoiceToolCalls: true
  });

  assert.equal(
    prompt.includes("If you answer without a pause/duck handoff, keep it brief by default: usually one or two short sentences."),
    true
  );
  assert.equal(
    prompt.includes("If you want to say more than a quick reaction while music is playing, call music_reply_handoff with mode=duck or mode=pause first."),
    true
  );
  assert.equal(
    prompt.includes("If music is currently playing and you have not claimed the floor with music_reply_handoff, keep spoken replies short by default."),
    true
  );
});

test("buildVoiceTurnPrompt prefers tool calls over stale helper fields", () => {
  const prompt = buildVoiceTurnPrompt({
    speakerName: "alice",
    transcript: "can you open that article and search the web",
    allowMemoryToolCalls: true,
    allowWebSearchToolCall: true,
    allowOpenArticleToolCall: true,
    allowVoiceToolCalls: true,
    openArticleCandidates: [
      {
        ref: "r1:1",
        title: "Example",
        url: "https://example.com/article",
        domain: "example.com",
        query: "example"
      }
    ],
    webSearch: {
      enabled: true,
      configured: true,
      blockedByBudget: false,
      budget: {
        canSearch: true
      }
    },
    musicContext: {
      playbackState: "playing",
      currentTrack: {
        id: "track-current",
        title: "Example Song",
        artists: ["Example Artist"]
      },
      lastTrack: null,
      queueLength: 2,
      upcomingTracks: [
        { id: "track-next", title: "Next Song", artist: "Next Artist" }
      ],
      lastAction: "play_now",
      lastQuery: "example song"
    }
  });

  assert.equal(prompt.includes("Tools:"), true);
  assert.equal(prompt.includes("Speak first on casual turns"), true);
  assert.equal(prompt.includes("never claim success before a tool returns"), true);
  assert.equal(prompt.includes("web_search"), true);
  assert.equal(prompt.includes("open_article"), true);
  assert.equal(prompt.includes("memory_write"), true);
  assert.equal(prompt.includes("memory_search"), false);
  assert.equal(prompt.includes("note_context"), true);
  assert.equal(prompt.includes("music_play"), true);
  assert.equal(prompt.includes("set_addressing"), false);
  assert.equal(prompt.includes("Music:"), true);
  assert.equal(prompt.includes("Now: Example Song by Example Artist"), true);
  assert.equal(prompt.includes("selection_id: track-current"), true);
  assert.equal(prompt.includes("Next Song - Next Artist"), true);
  assert.equal(prompt.includes("selection_id: track-next"), true);
  assert.equal(prompt.includes("queue_add+skip"), true);
  assert.equal(prompt.includes("set webSearchQuery"), false);
  assert.equal(prompt.includes("set openArticleRef"), false);
  assert.equal(prompt.includes("Set memoryLine"), false);
});

test("buildVoiceTurnPrompt renders durable session context above conversation history", () => {
  const prompt = buildVoiceTurnPrompt({
    speakerName: "alice",
    transcript: "what were we saying earlier?",
    allowVoiceToolCalls: true,
    durableContext: [
      {
        text: "Alice prefers concise answers in this session",
        category: "preference",
        at: Date.now()
      }
    ],
    recentConversationHistory: [
      {
        ageMinutes: 3,
        messages: [
          {
            author_name: "alice",
            content: "keep it short",
            is_bot: 0
          }
        ]
      }
    ]
  });

  assert.equal(prompt.includes("Session context:"), true);
  assert.equal(prompt.includes("- [preference] Alice prefers concise answers in this session"), true);
  assert.equal(prompt.indexOf("Session context:") < prompt.indexOf("Past conversation:"), true);
  assert.equal(prompt.includes("note_context"), true);
});

test("buildVoiceTurnPrompt trims session context to the most recent prompt-safe entries", () => {
  const durableContext = Array.from({ length: 16 }, (_, index) => ({
    text: `Context item ${String(index + 1).padStart(2, "0")}`,
    category: index % 2 === 0 ? "fact" : "plan",
    at: index + 1
  }));

  const prompt = buildVoiceTurnPrompt({
    speakerName: "alice",
    transcript: "keep going",
    allowVoiceToolCalls: true,
    durableContext
  });

  assert.equal(prompt.includes("Session context:"), true);
  assert.equal(prompt.includes("Context item 01"), false);
  assert.equal(prompt.includes("Context item 04"), false);
  assert.equal(prompt.includes("Context item 05"), true);
  assert.equal(prompt.includes("Context item 16"), true);
});

test("buildVoiceTurnPrompt includes interruption recovery context for the next turn", () => {
  const prompt = buildVoiceTurnPrompt({
    speakerName: "alice",
    transcript: "actually make it rock instead",
    conversationContext: {
      engagementState: "engaged",
      engaged: true,
      engagedWithCurrentSpeaker: true,
      recentAssistantReply: true,
      recentDirectAddress: true,
      sameAsRecentDirectAddress: true,
      msSinceAssistantReply: 800,
      msSinceDirectAddress: 800,
      interruptedAssistantReply: {
        utteranceText: "let me explain the jazz playlist options",
        interruptedByUserId: "user-1",
        interruptedBySpeakerName: "alice",
        interruptedAt: Date.now() - 1200,
        ageMs: 1200,
        source: "barge_in_interrupt"
      }
    }
  });

  assert.equal(prompt.includes("Interruption recovery context:"), true);
  assert.equal(prompt.includes("alice interrupted you"), true);
  assert.equal(prompt.includes("let me explain the jazz playlist options"), true);
  assert.equal(prompt.includes('They then said: "actually make it rock instead"'), true);
  assert.equal(prompt.includes("Do not mechanically continue the old answer if the new turn changes direction."), true);
});

test("buildVoiceTurnPrompt keeps soft addressing guesses out of the prompt", () => {
  const prompt = buildVoiceTurnPrompt({
    speakerName: "alice",
    transcript: "can you queue that up",
    conversationContext: {
      engagementState: "engaged",
      engaged: true,
      engagedWithCurrentSpeaker: true,
      recentAssistantReply: true,
      recentDirectAddress: true,
      sameAsRecentDirectAddress: true,
      msSinceAssistantReply: 900,
      msSinceDirectAddress: 900,
      voiceAddressingState: {
        currentSpeakerTarget: "ME",
        currentSpeakerDirectedConfidence: 0.91,
        lastDirectedToMe: {
          speakerName: "alice",
          directedConfidence: 0.91,
          ageMs: 900
        },
        recentAddressingGuesses: [
          {
            speakerName: "alice",
            talkingTo: "ME",
            directedConfidence: 0.91,
            ageMs: 900
          }
        ]
      }
    }
  });

  assert.equal(prompt.includes("Conversational addressing state"), false);
  assert.equal(prompt.includes("Current speaker likely talking to"), false);
  assert.equal(prompt.includes("Recent addressing guesses"), false);
  assert.equal(prompt.includes("Last turn directed to you"), false);
});

test("buildVoiceTurnPrompt teaches inline soundboard directives when ordered soundboard sequencing is available", () => {
  const prompt = buildVoiceTurnPrompt({
    speakerName: "alice",
    transcript: "that was brutal",
    allowSoundboardToolCall: true,
    allowInlineSoundboardDirectives: true,
    soundboardCandidates: ["rimshot@123"],
    soundboardEagerness: 82
  });

  assert.equal(prompt.includes("Soundboard eagerness: 82/100"), true);
  assert.equal(prompt.includes("playful soundboard bits and comedic punctuation"), true);
  assert.equal(prompt.includes("[[TO:SPEAKER]]"), true);
  assert.equal(prompt.includes("[[TO:ALL]]"), true);
  assert.equal(prompt.includes("[[SOUNDBOARD:<ref>]]"), true);
  assert.equal(prompt.includes("inline and tool-call the same sound"), true);
});

test("buildVoiceTurnPrompt keeps play_soundboard as the fallback when inline directives are unavailable", () => {
  const prompt = buildVoiceTurnPrompt({
    speakerName: "alice",
    transcript: "hit the rimshot",
    allowSoundboardToolCall: true,
    allowInlineSoundboardDirectives: false,
    soundboardCandidates: ["rimshot@123"],
    soundboardEagerness: 82
  });

  assert.equal(prompt.includes("Inline directives unavailable"), true);
  assert.equal(prompt.includes("play_soundboard"), true);
  assert.equal(prompt.includes("Don't output [[SOUNDBOARD:...]] markup"), true);
});
