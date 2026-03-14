import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  SYSTEM_SPEECH_CLASS,
  SYSTEM_SPEECH_SOURCE,
  isSystemSpeechOpportunitySource,
  resolveSystemSpeechClass,
  resolveSystemSpeechReplyAccountingOnLocalPlayback,
  resolveSystemSpeechReplyAccountingOnRequest,
  shouldAllowSystemSpeechSkipAfterFire
} from "./systemSpeechOpportunity.ts";

test("system speech source helpers only match system initiated reply sources", () => {
  assert.equal(isSystemSpeechOpportunitySource(SYSTEM_SPEECH_SOURCE.THOUGHT), true);
  assert.equal(isSystemSpeechOpportunitySource(`${SYSTEM_SPEECH_SOURCE.STREAM_WATCH}:share_start`), true);
  assert.equal(isSystemSpeechOpportunitySource("file_asr_reply"), false);
});

test("system speech reply accounting is explicit for request and local playback phases", () => {
  assert.equal(
    resolveSystemSpeechReplyAccountingOnRequest(SYSTEM_SPEECH_SOURCE.THOUGHT),
    "requested"
  );
  assert.equal(
    resolveSystemSpeechReplyAccountingOnRequest(`${SYSTEM_SPEECH_SOURCE.STREAM_WATCH}:share_start`),
    "requested"
  );
  assert.equal(
    resolveSystemSpeechReplyAccountingOnLocalPlayback(SYSTEM_SPEECH_SOURCE.THOUGHT_TTS),
    "spoken"
  );
  assert.equal(
    resolveSystemSpeechReplyAccountingOnLocalPlayback(`${SYSTEM_SPEECH_SOURCE.STREAM_WATCH}:urgent`),
    "spoken"
  );
  assert.equal(resolveSystemSpeechReplyAccountingOnRequest("file_asr_reply"), null);
  assert.equal(resolveSystemSpeechReplyAccountingOnLocalPlayback("file_asr_reply"), null);
});

test("system speech definitions expose speech class and skip policy", () => {
  assert.equal(
    resolveSystemSpeechClass(SYSTEM_SPEECH_SOURCE.THOUGHT_TTS),
    SYSTEM_SPEECH_CLASS.SYSTEM_OPTIONAL
  );
  assert.equal(
    resolveSystemSpeechClass(`${SYSTEM_SPEECH_SOURCE.STREAM_WATCH}:urgent`),
    SYSTEM_SPEECH_CLASS.SYSTEM_OPTIONAL
  );
  assert.equal(shouldAllowSystemSpeechSkipAfterFire(SYSTEM_SPEECH_SOURCE.THOUGHT), true);
  assert.equal(shouldAllowSystemSpeechSkipAfterFire(`${SYSTEM_SPEECH_SOURCE.STREAM_WATCH}:urgent`), true);
  assert.equal(shouldAllowSystemSpeechSkipAfterFire("file_asr_reply"), true);
});
