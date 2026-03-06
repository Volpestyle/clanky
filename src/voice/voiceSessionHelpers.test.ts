import { test } from "bun:test";
import assert from "node:assert/strict";
import { createTestSettings } from "../testSettings.ts";
import {
  isBotNameAddressed,
  extractSoundboardDirective,
  parseSoundboardDirectiveSequence,
  getRealtimeCommitMinimumBytes,
  getRealtimeRuntimeLabel,
  isFinalRealtimeTranscriptEventType,
  isRecoverableRealtimeError,
  isVoiceTurnAddressedToBot,
  parseResponseDoneModel,
  parseResponseDoneUsage,
  resolveRealtimeProvider,
  resolveVoiceAsrLanguageGuidance,
  resolveVoiceRuntimeMode,
  transcriptSourceFromEventType
} from "./voiceSessionHelpers.ts";

test("isRecoverableRealtimeError matches OpenAI empty commit code", () => {
  const recoverable = isRecoverableRealtimeError({
    mode: "openai_realtime",
    code: "input_audio_buffer_commit_empty",
    message: ""
  });
  assert.equal(recoverable, true);
});

test("isRecoverableRealtimeError does not match unrelated realtime errors", () => {
  const recoverable = isRecoverableRealtimeError({
    mode: "openai_realtime",
    code: "unknown_parameter",
    message: "Unknown parameter: session.type"
  });
  assert.equal(recoverable, false);
});

test("isRecoverableRealtimeError matches active response collision code", () => {
  const recoverable = isRecoverableRealtimeError({
    mode: "openai_realtime",
    code: "conversation_already_has_active_response",
    message: "Conversation already has an active response in progress."
  });
  assert.equal(recoverable, true);
});

test("isRecoverableRealtimeError matches response cancel race code", () => {
  const recoverable = isRecoverableRealtimeError({
    mode: "openai_realtime",
    code: "response_cancel_not_active",
    message: "Cancellation failed: no active response found"
  });
  assert.equal(recoverable, true);
});

test("isRecoverableRealtimeError matches response cancel race message", () => {
  const recoverable = isRecoverableRealtimeError({
    mode: "openai_realtime",
    code: "unknown_error",
    message: "Cancellation failed: no active response found"
  });
  assert.equal(recoverable, true);
});

test("getRealtimeCommitMinimumBytes enforces OpenAI minimum audio window", () => {
  assert.equal(getRealtimeCommitMinimumBytes("openai_realtime", 24_000), 4_800);
  assert.equal(getRealtimeCommitMinimumBytes("openai_realtime", 16_000), 3_200);
});

test("getRealtimeCommitMinimumBytes uses passthrough minimum for non-openai modes", () => {
  assert.equal(getRealtimeCommitMinimumBytes("voice_agent", 24_000), 1);
  assert.equal(getRealtimeCommitMinimumBytes("gemini_realtime", 24_000), 1);
  assert.equal(getRealtimeCommitMinimumBytes("elevenlabs_realtime", 24_000), 1);
});

test("resolveVoiceAsrLanguageGuidance supports auto and fixed language modes", () => {
  const autoGuidance = resolveVoiceAsrLanguageGuidance(createTestSettings({
    voice: {
      asrLanguageMode: "auto",
      asrLanguageHint: "EN"
    }
  }));
  assert.equal(autoGuidance.mode, "auto");
  assert.equal(autoGuidance.hint, "en");
  assert.equal(autoGuidance.language, "");
  assert.equal(autoGuidance.prompt.includes("Language hint: en"), true);

  const fixedGuidance = resolveVoiceAsrLanguageGuidance(createTestSettings({
    voice: {
      asrLanguageMode: "fixed",
      asrLanguageHint: "en-US"
    }
  }));
  assert.equal(fixedGuidance.mode, "fixed");
  assert.equal(fixedGuidance.hint, "en-us");
  assert.equal(fixedGuidance.language, "en-us");
  assert.equal(fixedGuidance.prompt, "");
});

test("Gemini realtime mode resolves to gemini provider and label", () => {
  assert.equal(resolveVoiceRuntimeMode(createTestSettings({ voice: { mode: "gemini_realtime" } })), "gemini_realtime");
  assert.equal(resolveRealtimeProvider("gemini_realtime"), "gemini");
  assert.equal(getRealtimeRuntimeLabel("gemini_realtime"), "gemini_realtime");
});

test("ElevenLabs realtime mode resolves to elevenlabs provider and label", () => {
  assert.equal(resolveVoiceRuntimeMode(createTestSettings({ voice: { mode: "elevenlabs_realtime" } })), "elevenlabs_realtime");
  assert.equal(resolveRealtimeProvider("elevenlabs_realtime"), "elevenlabs");
  assert.equal(getRealtimeRuntimeLabel("elevenlabs_realtime"), "elevenlabs_realtime");
});

test("transcriptSourceFromEventType classifies Gemini transcription events", () => {
  assert.equal(transcriptSourceFromEventType("input_audio_transcription"), "input");
  assert.equal(transcriptSourceFromEventType("output_audio_transcription"), "output");
  assert.equal(transcriptSourceFromEventType("server_content_text"), "output");
  assert.equal(transcriptSourceFromEventType("user_transcript"), "input");
  assert.equal(transcriptSourceFromEventType("agent_response"), "output");
});

test("isFinalRealtimeTranscriptEventType filters partial transcript events", () => {
  assert.equal(
    isFinalRealtimeTranscriptEventType("response.output_audio_transcript.delta", "output"),
    false
  );
  assert.equal(
    isFinalRealtimeTranscriptEventType("response.output_audio_transcript.done", "output"),
    true
  );
  assert.equal(
    isFinalRealtimeTranscriptEventType("response.output_text.delta", "output"),
    false
  );
  assert.equal(
    isFinalRealtimeTranscriptEventType("response.output_text.done", "output"),
    true
  );
  assert.equal(
    isFinalRealtimeTranscriptEventType("server_content_text", "output"),
    false
  );
  assert.equal(
    isFinalRealtimeTranscriptEventType("output_audio_transcription", "output"),
    true
  );
});

test("extractSoundboardDirective strips directive and returns selected reference", () => {
  const parsed = extractSoundboardDirective("that was crazy [[SOUNDBOARD:1234567890@111222333]]");
  assert.equal(parsed.text, "that was crazy");
  assert.equal(parsed.reference, "1234567890@111222333");
});

test("parseSoundboardDirectiveSequence preserves ordered inline directives", () => {
  const parsed = parseSoundboardDirectiveSequence(
    "yo [[SOUNDBOARD:airhorn@123]] hold up [[SOUNDBOARD:rimshot@456]] done"
  );
  assert.equal(parsed.text, "yo hold up done");
  assert.deepEqual(parsed.references, ["airhorn@123", "rimshot@456"]);
  assert.deepEqual(parsed.sequence, [
    { type: "speech", text: "yo " },
    { type: "soundboard", reference: "airhorn@123" },
    { type: "speech", text: " hold up " },
    { type: "soundboard", reference: "rimshot@456" },
    { type: "speech", text: " done" }
  ]);
});

test("parseResponseDoneModel extracts response model from response.done events", () => {
  const model = parseResponseDoneModel({
    type: "response.done",
    response: {
      id: "resp_123",
      model: "gpt-realtime-mini"
    }
  });
  assert.equal(model, "gpt-realtime-mini");
});

test("parseResponseDoneUsage extracts realtime token totals and detail counts", () => {
  const usage = parseResponseDoneUsage({
    type: "response.done",
    response: {
      id: "resp_123",
      usage: {
        input_tokens: 2000,
        output_tokens: 800,
        total_tokens: 2800,
        input_token_details: {
          cached_tokens: 500,
          audio_tokens: 1200,
          text_tokens: 800
        },
        output_token_details: {
          audio_tokens: 400,
          text_tokens: 400
        }
      }
    }
  });

  assert.deepEqual(usage, {
    inputTokens: 2000,
    outputTokens: 800,
    totalTokens: 2800,
    cacheReadTokens: 500,
    inputAudioTokens: 1200,
    inputTextTokens: 800,
    outputAudioTokens: 400,
    outputTextTokens: 400
  });
});

test("isVoiceTurnAddressedToBot matches exact bot-name phrase and primary wake token", () => {
  const settings = createTestSettings({ botName: "clanker conk" });
  const cases = [
    { text: "yo clanker conk can you answer this?", expected: true },
    { text: "clankerconk can you answer this?", expected: true },
    { text: "yo clanker can you answer this?", expected: true },
    { text: "clanker?", expected: true },
    { text: "yo conk can you answer this?", expected: false },
    { text: "yo clunker can you answer this?", expected: false },
    { text: "clankerton can you jump in?", expected: false },
    { text: "i sent you a link yesterday", expected: false }
  ];

  for (const row of cases) {
    assert.equal(isVoiceTurnAddressedToBot(row.text, settings), row.expected, row.text);
  }
});

test("isVoiceTurnAddressedToBot follows configured botName without fuzzy fallbacks", () => {
  const settings = createTestSettings({ botName: "sparky bot" });
  assert.equal(isVoiceTurnAddressedToBot("sparky bot can you help me with this?", settings), true);
  assert.equal(isVoiceTurnAddressedToBot("sparky can you help me with this?", settings), true);
  assert.equal(isVoiceTurnAddressedToBot("sporky can you help me with this?", settings), false);
  assert.equal(isVoiceTurnAddressedToBot("that bot is broken again", settings), false);
});

test("isBotNameAddressed normalizes punctuation and accents for exact matching", () => {
  assert.equal(
    isBotNameAddressed({
      transcript: "clánker!!!",
      botName: "clanker conk"
    }),
    true
  );
  assert.equal(
    isBotNameAddressed({
      transcript: "clanker's still here",
      botName: "clanker conk"
    }),
    true
  );
  assert.equal(
    isBotNameAddressed({
      transcript: "clankerconk can you help me with this?",
      botName: "clanker conk"
    }),
    true
  );
  assert.equal(
    isBotNameAddressed({
      transcript: "clunker can you help me with this?",
      botName: "clanker conk"
    }),
    false
  );
});
