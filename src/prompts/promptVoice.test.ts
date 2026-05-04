import { test } from "bun:test";
import assert from "node:assert/strict";
import { buildVoiceTurnPrompt } from "./promptVoice.ts";

test("buildVoiceTurnPrompt trims thread-caution lines for screen-share events", () => {
  const prompt = buildVoiceTurnPrompt({
    speakerName: "alice",
    transcript: "screen-share state change",
    inputKind: "event",
    botName: "clanky",
    participantRoster: ["alice", "bob", "clanky"],
    hasDirectVisionFrame: true,
    screenWatchCommentaryEagerness: 80,
    runtimeEventContext: {
      category: "screen_share",
      eventType: "share_start",
      actorUserId: "user-1",
      actorDisplayName: "alice",
      actorRole: "other",
      hasVisibleFrame: true
    },
    conversationContext: {
      attentionMode: "ACTIVE",
      currentSpeakerActive: false,
      recentAssistantReply: true,
      recentDirectAddress: false,
      sameAsRecentDirectAddress: false,
      msSinceAssistantReply: 18_000,
      msSinceDirectAddress: null
    }
  });

  assert.match(prompt, /Voice runtime event cue: alice started sharing their screen\./);
  assert.match(prompt, /Live screen watch: You can see the user's screen directly in the attached image\./);
  assert.match(prompt, /Screen watch commentary bias: high\./);
  assert.match(prompt, /If you notice a fresh, notable visual beat, a short natural reaction is welcome\./);
  assert.match(prompt, /If you speak, a short natural reply is enough\./);
  assert.match(prompt, /Output exactly \[SKIP\] when silence is best\./);
  assert.match(prompt, /Ambient reply bias: minimal\.|Ambient reply bias: low\.|Ambient reply bias: moderate\.|Ambient reply bias: high\.|Ambient reply bias: very high\./);
  assert.doesNotMatch(prompt, /This turn was not directly addressed to you\./);
  assert.doesNotMatch(prompt, /not clearly part of your current thread/i);
  assert.doesNotMatch(prompt, /Use room continuity as context, not as a reason to force yourself into the turn\./);
  assert.doesNotMatch(prompt, /Respond naturally, or output \[SKIP\] if you have nothing to add\. You decide\./);
  assert.doesNotMatch(prompt, /A valid spoken reply can be tiny\. Do not inflate admitted turns by default\./);
  assert.doesNotMatch(prompt, /You are social and engaged|You are a good listener|You are fully social/);
});

test("buildVoiceTurnPrompt keeps direct-address ambiguity guidance for multi-user transcript turns", () => {
  const prompt = buildVoiceTurnPrompt({
    speakerName: "alice",
    transcript: "you should look at this",
    inputKind: "transcript",
    botName: "clanky",
    participantRoster: ["alice", "bob", "clanky"],
    conversationContext: {
      attentionMode: "ACTIVE",
      currentSpeakerActive: false,
      recentAssistantReply: true,
      recentDirectAddress: false,
      sameAsRecentDirectAddress: false,
      msSinceAssistantReply: 8_000,
      msSinceDirectAddress: null
    }
  });

  assert.match(prompt, /This turn was not directly addressed to you\./);
  assert.match(prompt, /treat second-person references like "you"\/"your" as ambiguous by default/i);
  assert.match(prompt, /Ambient reply bias: minimal\.|Ambient reply bias: low\.|Ambient reply bias: moderate\.|Ambient reply bias: high\.|Ambient reply bias: very high\./);
  assert.match(prompt, /Response-window bias: narrow\.|Response-window bias: moderate\.|Response-window bias: warm\.|Response-window bias: sticky\./);
  assert.match(prompt, /Output exactly \[SKIP\] when silence is best\./);
  assert.doesNotMatch(prompt, /not clearly part of your current thread/i);
  assert.doesNotMatch(prompt, /Use room continuity as context, not as a reason to force yourself into the turn\./);
  assert.doesNotMatch(prompt, /You are social and engaged|You are a good listener|You are fully social/);
});

test("buildVoiceTurnPrompt uses the selected per-turn tool list when provided", () => {
  const prompt = buildVoiceTurnPrompt({
    speakerName: "alice",
    transcript: "hi",
    inputKind: "transcript",
    botName: "clanky",
    availableToolNames: ["conversation_search", "music_play", "music_play"]
  });

  assert.match(prompt, /Tools: conversation_search, music_play\./);
  assert.doesNotMatch(prompt, /join_voice_channel/);
});

test("buildVoiceTurnPrompt renders curated memory as voice background context", () => {
  const prompt = buildVoiceTurnPrompt({
    speakerName: "alice",
    transcript: "what now?",
    inputKind: "transcript",
    botName: "clanky",
    curatedMemory: {
      mode: "voice",
      loadedAt: "2026-01-01T00:00:00.000Z",
      ownerPrivate: false,
      collaborationContext: false,
      sections: [
        {
          key: "core",
          title: "Core Memory",
          fileName: "CORE.md",
          filePath: "memory/CORE.md",
          content: "Keep replies direct and socially natural.",
          missing: false,
          blocked: false,
          warningIds: [],
          chars: 41,
          mtimeMs: 1,
          size: 41
        }
      ]
    }
  });

  assert.match(prompt, /Curated always-on memory:/u);
  assert.match(prompt, /not as something just spoken in VC/u);
  assert.match(prompt, /Keep replies direct and socially natural/u);
});
