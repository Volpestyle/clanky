import { test } from "bun:test";
import assert from "node:assert/strict";
import { buildReplyPrompt } from "./prompts.ts";

test("smoke: reply prompt surfaces interactive browser capability state", () => {
  const prompt = buildReplyPrompt({
    message: {
      authorName: "alice",
      content: "can you handle this?"
    },
    imageInputs: [],
    recentMessages: [],
    relevantMessages: [],
    userFacts: [],
    relevantFacts: [],
    emojiHints: [],
    reactionEmojiOptions: [],
    allowReplySimpleImages: false,
    allowReplyComplexImages: false,
    remainingReplyImages: 0,
    allowReplyVideos: false,
    remainingReplyVideos: 0,
    allowReplyGifs: false,
    remainingReplyGifs: 0,
    gifRepliesEnabled: true,
    gifsConfigured: false,
    replyEagerness: 50,
    reactionEagerness: 20,
    addressing: {
      directlyAddressed: true,
      responseRequired: true
    },
    webSearch: {
      requested: false,
      configured: true,
      enabled: false,
      used: false,
      blockedByBudget: false,
      optedOutByUser: false,
      error: null,
      query: "",
      results: [],
      fetchedPages: 0,
      providerUsed: null,
      providerFallbackUsed: false,
      budget: {
        canSearch: true
      }
    },
    browserBrowse: {
      requested: false,
      configured: true,
      enabled: false,
      used: false,
      blockedByBudget: false,
      error: null,
      query: "",
      text: "",
      steps: 0,
      hitStepLimit: false,
      budget: {
        canBrowse: true
      }
    },
    recentWebLookups: [],
    memoryLookup: {
      enabled: false
    },
    imageLookup: {
      enabled: false,
      candidates: []
    },
    allowWebSearchDirective: true,
    allowBrowserBrowseDirective: true,
    allowMemoryLookupDirective: true,
    allowImageLookupDirective: true,
    allowMemoryDirective: false,
    allowAutomationDirective: false,
    automationTimeZoneLabel: "UTC",
    voiceMode: {
      enabled: false,
      activeSession: false,
      participantRoster: []
    },
    screenShare: {
      supported: true,
      enabled: true,
      available: false,
      status: "starting",
      reason: "public_https_starting",
      publicUrl: "https://demo.trycloudflare.com"
    },
    videoContext: {
      requested: true,
      used: false,
      enabled: false,
      blockedByBudget: false,
      budget: {
        canLookup: true
      },
      error: null,
      videos: []
    },
    channelMode: "other_channel",
    maxMediaPromptChars: 900,
    mediaPromptCraftGuidance: "be specific"
  });

  assert.equal(
    prompt.includes("Interactive browser capability exists but is currently unavailable (disabled in settings)."),
    true
  );
  assert.equal(prompt.includes("Set browserBrowseQuery to null."), true);
});

test("smoke: reply prompt surfaces current voice music state", () => {
  const prompt = buildReplyPrompt({
    message: {
      authorName: "alice",
      content: "did you stop it?"
    },
    imageInputs: [],
    recentMessages: [],
    relevantMessages: [],
    userFacts: [],
    relevantFacts: [],
    emojiHints: [],
    reactionEmojiOptions: [],
    allowReplySimpleImages: false,
    allowReplyComplexImages: false,
    remainingReplyImages: 0,
    allowReplyVideos: false,
    remainingReplyVideos: 0,
    allowReplyGifs: false,
    remainingReplyGifs: 0,
    gifRepliesEnabled: false,
    gifsConfigured: false,
    replyEagerness: 50,
    reactionEagerness: 20,
    addressing: {
      directlyAddressed: true,
      responseRequired: true
    },
    webSearch: null,
    recentWebLookups: [],
    memoryLookup: {
      enabled: false
    },
    imageLookup: {
      enabled: false,
      candidates: []
    },
    allowWebSearchDirective: false,
    allowMemoryLookupDirective: false,
    allowImageLookupDirective: false,
    allowMemoryDirective: false,
    allowAutomationDirective: false,
    automationTimeZoneLabel: "UTC",
    voiceMode: {
      enabled: true,
      activeSession: true,
      participantRoster: ["alice", "bot"],
      musicState: {
        playbackState: "stopped",
        currentTrack: null,
        lastTrack: {
          title: "COME N GO",
          artists: ["Yeat"]
        },
        queueLength: 2,
        upcomingTracks: [
          {
            title: "Talk",
            artist: "Yeat"
          }
        ],
        lastAction: "stop",
        lastQuery: "play another Yeat song"
      },
      musicDisambiguation: null
    },
    screenShare: null,
    videoContext: null,
    channelMode: "other_channel",
    maxMediaPromptChars: 900,
    mediaPromptCraftGuidance: "be specific"
  });

  assert.equal(prompt.includes("Current voice music state:"), true);
  assert.equal(prompt.includes("- Playback: stopped"), true);
  assert.equal(prompt.includes("- Most recent track: COME N GO by Yeat"), true);
  assert.equal(prompt.includes("- Queue length: 2 total tracks"), true);
  assert.equal(prompt.includes("- Next queued tracks: 1. Talk by Yeat"), true);
  assert.equal(prompt.includes("- Most recent music action: stop"), true);
  assert.equal(prompt.includes("- Most recent music request: play another Yeat song"), true);
});
