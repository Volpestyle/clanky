import { test } from "bun:test";
import assert from "node:assert/strict";
import { buildVoiceTurnPrompt } from "./index.ts";

test("buildVoiceTurnPrompt treats event cues as room context", () => {
  const prompt = buildVoiceTurnPrompt({
    speakerName: "alice",
    inputKind: "event",
    transcript: "[alice joined the voice channel]"
  });

  assert.equal(
    prompt.includes(
      "This is a voice-room event cue, not literal quoted speech."
    ),
    true
  );
  assert.equal(
    prompt.includes(
      "If a brief acknowledgement of the join/leave would feel natural, you may reply briefly. Otherwise use [SKIP]."
    ),
    true
  );
});

test("buildVoiceTurnPrompt biases low-information eager turns toward skip", () => {
  const prompt = buildVoiceTurnPrompt({
    speakerName: "alice",
    transcript: "haha",
    isEagerTurn: true,
    voiceEagerness: 50
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

  assert.equal(prompt.includes("Interactive browser browsing is available."), true);
  assert.equal(
    prompt.includes(
      "Use browser_browse only when you need actual site navigation or interaction, such as JS-rendered pages, clicking, typing, scrolling, dragging, or moving through a live page flow."
    ),
    true
  );
  assert.equal(prompt.includes("If interactive browsing is needed, call browser_browse in the same response."), true);
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

  assert.equal(prompt.includes("VC screen-share link offers are available."), true);
  assert.equal(
    prompt.includes("If the speaker asks you to see/watch their screen or stream, call offer_screen_share_link in the same response."),
    true
  );
  assert.equal(prompt.includes("offer_screen_share_link"), true);
  assert.equal(prompt.includes("Do not encode tool intent in JSON helper fields, helper refs, or placeholder control fields."), true);
  assert.equal(prompt.includes("voice JSON contract"), false);
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
        title: "Example Song",
        artists: ["Example Artist"]
      },
      lastTrack: null,
      queueLength: 2,
      upcomingTracks: [
        { title: "Next Song", artist: "Next Artist" }
      ],
      lastAction: "play_now",
      lastQuery: "example song"
    }
  });

  assert.equal(prompt.includes("Available tool calls this turn:"), true);
  assert.equal(prompt.includes("Always call the tool in the same response; never only say you will."), true);
  assert.equal(prompt.includes("call web_search in the same response."), true);
  assert.equal(prompt.includes("call open_article with one ref from this list."), true);
  assert.equal(prompt.includes("Use memory_write with namespace=speaker"), true);
  assert.equal(prompt.includes("Voice/session control tools are available."), true);
  assert.equal(prompt.includes("music_play_now"), true);
  assert.equal(prompt.includes("Music playback:"), true);
  assert.equal(prompt.includes("Do not emulate play-now by chaining music_queue_add and music_skip."), true);
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
  assert.equal(prompt.indexOf("Session context:") < prompt.indexOf("Relevant past conversation windows from shared text/voice history:"), true);
  assert.equal(prompt.includes("Use note_context to pin important session-scoped facts, plans, preferences, or relationships"), true);
});
