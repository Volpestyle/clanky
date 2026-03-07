import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  SYSTEM_SPEECH_CLASS,
  SYSTEM_SPEECH_OPPORTUNITY,
  SYSTEM_SPEECH_SOURCE,
  isSystemSpeechOpportunitySource,
  resolveSystemSpeechClass,
  resolveSystemSpeechOpportunityType,
  resolveSystemSpeechReplyAccountingOnLocalPlayback,
  resolveSystemSpeechReplyAccountingOnRequest,
  shouldAllowSystemSpeechSkipAfterFire,
  shouldCancelSystemSpeechBeforeAudioOnPromotedUserSpeech,
  shouldSupersedeSystemSpeechBeforePlayback
} from "./systemSpeechOpportunity.ts";

test("resolveSystemSpeechOpportunityType identifies canonical system speech sources", () => {
  assert.equal(
    resolveSystemSpeechOpportunityType(SYSTEM_SPEECH_SOURCE.THOUGHT),
    SYSTEM_SPEECH_OPPORTUNITY.THOUGHT
  );
  assert.equal(
    resolveSystemSpeechOpportunityType(SYSTEM_SPEECH_SOURCE.THOUGHT_TTS),
    SYSTEM_SPEECH_OPPORTUNITY.THOUGHT
  );
  assert.equal(resolveSystemSpeechOpportunityType("realtime:user_turn"), null);
});

test("system speech source helpers only match system initiated reply sources", () => {
  assert.equal(isSystemSpeechOpportunitySource(SYSTEM_SPEECH_SOURCE.THOUGHT), true);
  assert.equal(isSystemSpeechOpportunitySource("stt_pipeline_reply"), false);
});

test("system speech sources yield to promoted user speech before audio begins", () => {
  assert.equal(
    shouldCancelSystemSpeechBeforeAudioOnPromotedUserSpeech(SYSTEM_SPEECH_SOURCE.THOUGHT),
    true
  );
  assert.equal(shouldCancelSystemSpeechBeforeAudioOnPromotedUserSpeech("realtime"), false);
  assert.equal(shouldSupersedeSystemSpeechBeforePlayback(SYSTEM_SPEECH_SOURCE.THOUGHT), true);
  assert.equal(shouldSupersedeSystemSpeechBeforePlayback("realtime"), false);
});

test("system speech reply accounting is explicit for request and local playback phases", () => {
  assert.equal(
    resolveSystemSpeechReplyAccountingOnRequest(SYSTEM_SPEECH_SOURCE.THOUGHT),
    "requested"
  );
  assert.equal(
    resolveSystemSpeechReplyAccountingOnLocalPlayback(SYSTEM_SPEECH_SOURCE.THOUGHT_TTS),
    "spoken"
  );
  assert.equal(resolveSystemSpeechReplyAccountingOnRequest("stt_pipeline_reply"), null);
  assert.equal(resolveSystemSpeechReplyAccountingOnLocalPlayback("stt_pipeline_reply"), null);
});

test("system speech definitions expose speech class and skip policy", () => {
  assert.equal(
    resolveSystemSpeechClass(SYSTEM_SPEECH_SOURCE.THOUGHT_TTS),
    SYSTEM_SPEECH_CLASS.SYSTEM_OPTIONAL
  );
  assert.equal(shouldAllowSystemSpeechSkipAfterFire(SYSTEM_SPEECH_SOURCE.THOUGHT), true);
  assert.equal(shouldAllowSystemSpeechSkipAfterFire("stt_pipeline_reply"), true);
});
