import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  composeDiscoveryImagePrompt,
  composeDiscoveryVideoPrompt,
  composeReplyImagePrompt,
  composeReplyVideoPrompt,
  parseStructuredReplyOutput
} from "./botHelpers.ts";

test("parseStructuredReplyOutput reads structured reply JSON", () => {
  const parsed = parseStructuredReplyOutput(
    JSON.stringify({
      text: "here you go",
      skip: false,
      reactionEmoji: "🔥",
      media: { type: "gif", prompt: "cat dance" },
      voiceIntent: {
        intent: "join",
        confidence: 0.92,
        reason: "explicit join request"
      }
    })
  );

  assert.equal(parsed.text, "here you go");
  assert.equal(parsed.reactionEmoji, "🔥");
  assert.equal(parsed.gifQuery, "cat dance");
  assert.equal(parsed.mediaDirective?.type, "gif");
  assert.equal(parsed.automationAction.operation, null);
  assert.equal(parsed.voiceIntent.intent, "join");
  assert.equal(parsed.voiceIntent.confidence, 0.92);
  assert.equal(parsed.voiceIntent.reason, "explicit join request");
});

test("parseStructuredReplyOutput rejects unstructured plain text", () => {
  const parsed = parseStructuredReplyOutput("just reply text");

  assert.equal(parsed.text, "");
  assert.equal(parsed.mediaDirective, null);
  assert.equal(parsed.automationAction.operation, null);
  assert.equal(parsed.voiceIntent.intent, null);
  assert.equal(parsed.voiceIntent.confidence, 0);
  assert.equal(parsed.voiceIntent.reason, null);
  assert.equal(parsed.voiceAddressing.talkingTo, null);
  assert.equal(parsed.voiceAddressing.directedConfidence, 0);
  assert.equal(parsed.parseState, "unstructured");
});

test("compose media prompts fall back to contextual defaults when no prompt is provided", () => {
  const initiativeImage = composeDiscoveryImagePrompt("", "", 900, []);
  const initiativeVideo = composeDiscoveryVideoPrompt("", "", 900, []);
  const replyImage = composeReplyImagePrompt("", "", 900, []);
  const replyVideo = composeReplyVideoPrompt("", "", 900, []);

  assert.match(initiativeImage, /Scene: general chat mood\./);
  assert.match(initiativeVideo, /Scene: general chat mood\./);
  assert.match(replyImage, /Scene: chat reaction\./);
  assert.match(replyImage, /Conversational context \(do not render as text\): chat context\./);
  assert.match(replyVideo, /Scene: chat reaction\./);
  assert.match(replyVideo, /Conversational context \(do not render as text\): chat context\./);
});

test("parseStructuredReplyOutput recovers text from truncated fenced JSON", () => {
  const parsed = parseStructuredReplyOutput(`\`\`\`json
{
  "text": "nah corbexx you're actually unhinged and i respect it lmaooo. 'penjamin' mode activated.\\n\\ncan't be grinding your brain 24/7",
  "skip": false,
  "reactionEmoji": "lmao:1063357443737931876",
  "automationAction": {
    "operation": "none",
`);

  assert.equal(
    parsed.text,
    "nah corbexx you're actually unhinged and i respect it lmaooo. 'penjamin' mode activated. can't be grinding your brain 24/7"
  );
  assert.equal(parsed.parseState, "recovered_json");
});

test("parseStructuredReplyOutput recovers skip from truncated fenced JSON", () => {
  const parsed = parseStructuredReplyOutput(`\`\`\`json
{
  "text": "ignored",
  "skip": true,
  "reactionEmoji": null,
`);

  assert.equal(parsed.text, "[SKIP]");
  assert.equal(parsed.parseState, "recovered_json");
});

test("parseStructuredReplyOutput rejects reasoning text containing JSON-like field patterns", () => {
  const reasoning = `I need to consider the "text": "something" field in the response before deciding.`;
  const parsed = parseStructuredReplyOutput(reasoning);
  assert.equal(parsed.text, "");
  assert.equal(parsed.parseState, "unstructured");
});

test("parseStructuredReplyOutput rejects prose with embedded skip pattern", () => {
  const reasoning = `Let me think about whether "skip": true is appropriate here.`;
  const parsed = parseStructuredReplyOutput(reasoning);
  assert.equal(parsed.text, "");
  assert.equal(parsed.parseState, "unstructured");
});

test("parseStructuredReplyOutput honors skip flag", () => {
  const parsed = parseStructuredReplyOutput(
    JSON.stringify({
      text: "ignored",
      skip: true,
      reactionEmoji: null,
      media: null,
      webSearchQuery: null,
      memoryLookupQuery: null,
      memoryLine: null,
      voiceIntent: {
        intent: "none",
        confidence: 0.2,
        reason: "not a voice command"
      }
    })
  );

  assert.equal(parsed.text, "[SKIP]");
  assert.equal(parsed.voiceIntent.intent, null);
});

test("parseStructuredReplyOutput accepts stream watch voice intents", () => {
  const parsed = parseStructuredReplyOutput(
    JSON.stringify({
      text: "bet",
      skip: false,
      reactionEmoji: null,
      media: null,
      webSearchQuery: null,
      memoryLookupQuery: null,
      memoryLine: null,
      voiceIntent: {
        intent: "watch_stream",
        confidence: 0.95,
        reason: "explicit stream watch request"
      }
    })
  );

  assert.equal(parsed.voiceIntent.intent, "watch_stream");
  assert.equal(parsed.voiceIntent.confidence, 0.95);
  assert.equal(parsed.voiceIntent.reason, "explicit stream watch request");
});

test("parseStructuredReplyOutput accepts music control voice intents", () => {
  const play = parseStructuredReplyOutput(
    JSON.stringify({
      text: "playing now",
      skip: false,
      voiceIntent: {
        intent: "music_play",
        confidence: 0.96,
        reason: "explicit play request",
        query: "mf doom all caps",
        platform: "youtube",
        selectedResultId: "track:123"
      }
    })
  );
  assert.equal(play.voiceIntent.intent, "music_play");
  assert.equal(play.voiceIntent.confidence, 0.96);
  assert.equal(play.voiceIntent.reason, "explicit play request");
  assert.equal(play.voiceIntent.query, "mf doom all caps");
  assert.equal(play.voiceIntent.platform, "youtube");
  assert.equal(play.voiceIntent.selectedResultId, "track:123");

  const queueNext = parseStructuredReplyOutput(
    JSON.stringify({
      text: "queued next",
      skip: false,
      voiceIntent: {
        intent: "music_queue_next",
        confidence: 0.91,
        reason: "explicit queue-next request",
        query: "accordion",
        platform: "soundcloud",
        selectedResultId: "track:456"
      }
    })
  );
  assert.equal(queueNext.voiceIntent.intent, "music_queue_next");
  assert.equal(queueNext.voiceIntent.query, "accordion");
  assert.equal(queueNext.voiceIntent.platform, "soundcloud");
  assert.equal(queueNext.voiceIntent.selectedResultId, "track:456");

  const pause = parseStructuredReplyOutput(
    JSON.stringify({
      text: "paused",
      skip: false,
      voiceIntent: {
        intent: "music_pause",
        confidence: 0.9,
        reason: "explicit pause request"
      }
    })
  );
  assert.equal(pause.voiceIntent.intent, "music_pause");
  assert.equal(pause.voiceIntent.confidence, 0.9);
  assert.equal(pause.voiceIntent.reason, "explicit pause request");
  assert.equal(pause.voiceIntent.query, null);
  assert.equal(pause.voiceIntent.platform, null);
  assert.equal(pause.voiceIntent.selectedResultId, null);
});

test("parseStructuredReplyOutput accepts screen share offer intent", () => {
  const parsed = parseStructuredReplyOutput(
    JSON.stringify({
      text: "i can peek your setup",
      skip: false,
      reactionEmoji: null,
      media: null,
      webSearchQuery: null,
      memoryLookupQuery: null,
      memoryLine: null,
      voiceIntent: {
        intent: "none",
        confidence: 0,
        reason: null
      },
      screenShareIntent: {
        action: "offer_link",
        confidence: 0.88,
        reason: "needs visual context"
      }
    })
  );

  assert.equal(parsed.screenShareIntent.action, "offer_link");
  assert.equal(parsed.screenShareIntent.confidence, 0.88);
  assert.equal(parsed.screenShareIntent.reason, "needs visual context");
});

test("parseStructuredReplyOutput ignores deprecated screen share aliases", () => {
  const parsed = parseStructuredReplyOutput(
    JSON.stringify({
      text: "old payload",
      skip: false,
      screenShare: {
        action: "offer_link",
        confidence: 1,
        reason: "deprecated alias"
      },
      screenShareLinkRequested: true
    })
  );

  assert.equal(parsed.screenShareIntent.action, null);
  assert.equal(parsed.screenShareIntent.confidence, 0);
  assert.equal(parsed.screenShareIntent.reason, null);
});

test("parseStructuredReplyOutput preserves model-provided voice addressing target", () => {
  const parsed = parseStructuredReplyOutput(
    JSON.stringify({
      text: "yup",
      skip: false,
      voiceAddressing: {
        talkingTo: "assistant",
        directedConfidence: 1.4
      }
    })
  );

  assert.equal(parsed.voiceAddressing.talkingTo, "assistant");
  assert.equal(parsed.voiceAddressing.directedConfidence, 1);
});

test("parseStructuredReplyOutput normalizes invalid voice intent payload", () => {
  const parsed = parseStructuredReplyOutput(
    JSON.stringify({
      text: "hello",
      skip: false,
      reactionEmoji: null,
      media: null,
      webSearchQuery: null,
      memoryLookupQuery: null,
      memoryLine: null,
      voiceIntent: {
        intent: "teleport",
        confidence: 3,
        reason: "invalid"
      }
    })
  );

  assert.equal(parsed.voiceIntent.intent, null);
  assert.equal(parsed.voiceIntent.confidence, 0);
  assert.equal(parsed.voiceIntent.reason, null);
});

test("parseStructuredReplyOutput normalizes automation create payload", () => {
  const parsed = parseStructuredReplyOutput(
    JSON.stringify({
      text: "bet i got you",
      skip: false,
      reactionEmoji: null,
      media: null,
      webSearchQuery: null,
      memoryLookupQuery: null,
      memoryLine: null,
      automationAction: {
        operation: "create",
        title: "giraffe drip",
        instruction: "post a giraffe picture",
        schedule: {
          kind: "daily",
          hour: 13,
          minute: 0
        },
        runImmediately: true
      },
      voiceIntent: {
        intent: "none",
        confidence: 0,
        reason: null
      }
    })
  );

  assert.equal(parsed.automationAction.operation, "create");
  assert.equal(parsed.automationAction.title, "giraffe drip");
  assert.equal(parsed.automationAction.instruction, "post a giraffe picture");
  assert.equal(parsed.automationAction.schedule?.kind, "daily");
  assert.equal(parsed.automationAction.schedule?.hour, 13);
  assert.equal(parsed.automationAction.schedule?.minute, 0);
  assert.equal(parsed.automationAction.runImmediately, true);
});

test("parseStructuredReplyOutput maps automation stop to pause", () => {
  const parsed = parseStructuredReplyOutput(
    JSON.stringify({
      text: "say less",
      automationAction: {
        operation: "stop",
        targetQuery: "giraffe"
      }
    })
  );

  assert.equal(parsed.automationAction.operation, "pause");
  assert.equal(parsed.automationAction.targetQuery, "giraffe");
});

test("parseStructuredReplyOutput parses voice tool-call fields", () => {
  const parsed = parseStructuredReplyOutput(
    JSON.stringify({
      text: "say less",
      skip: false,
      reactionEmoji: null,
      media: null,
      soundboardRefs: ["1234567890@555666777", "111222333@444555666"],
      leaveVoiceChannel: true,
      automationAction: { operation: "none" },
      voiceIntent: { intent: "none", confidence: 0, reason: null },
      screenShareIntent: { action: "offer_link", confidence: 0.88, reason: "needs visual context" }
    })
  );

  assert.equal(parsed.text, "say less");
  assert.deepEqual(parsed.soundboardRefs, ["1234567890@555666777", "111222333@444555666"]);
  assert.equal(parsed.leaveVoiceChannel, true);
  assert.equal(parsed.screenShareIntent.action, "offer_link");
});

test("parseStructuredReplyOutput normalizes missing voice tool-call fields to safe defaults", () => {
  const parsed = parseStructuredReplyOutput("just plain text");
  assert.equal(parsed.parseState, "unstructured");
  assert.deepEqual(parsed.soundboardRefs, []);
  assert.equal(parsed.leaveVoiceChannel, false);
  assert.equal(parsed.voiceIntent.query, null);
  assert.equal(parsed.voiceIntent.platform, null);
  assert.equal(parsed.voiceIntent.searchResults, null);
  assert.equal(parsed.voiceIntent.selectedResultId, null);
});
