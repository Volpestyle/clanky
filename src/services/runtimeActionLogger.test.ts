import { test } from "bun:test";
import assert from "node:assert/strict";
import { RuntimeActionLogger, formatPrettyLine, normalizeRuntimeActionEvent } from "./runtimeActionLogger.ts";

test("normalizeRuntimeActionEvent redacts secrets but keeps operational keys", () => {
  const event = normalizeRuntimeActionEvent({
    kind: "voice_runtime",
    content: "voice_turn_addressing",
    metadata: {
      apiKey: "secret-key-value",
      nested: {
        authorization: "Bearer abc",
        ok: "safe"
      },
      rows: [{ token: "xyz" }],
      sessionId: "sess-123",
      tokens: 245
    }
  });

  assert.equal(event.kind, "voice_runtime");
  assert.equal(event.agent, "voice");
  assert.equal(event.metadata.apiKey, "[REDACTED]");
  assert.equal(event.metadata.nested.authorization, "[REDACTED]");
  assert.equal(event.metadata.nested.ok, "safe");
  assert.equal(event.metadata.rows[0].token, "xyz");
  assert.equal(event.metadata.sessionId, "sess-123");
  assert.equal(event.metadata.tokens, 245);
});

test("RuntimeActionLogger.attachToStore preserves prior listener and emits JSON line", () => {
  const lines = [];
  const priorActions = [];
  const logger = new RuntimeActionLogger({
    enabled: true,
    writeToStdout: false,
    logFilePath: "",
    writeLine(line) {
      lines.push(line);
    }
  });

  const store = {
    onActionLogged(action) {
      priorActions.push(action);
    }
  };
  logger.attachToStore(store);

  store.onActionLogged({
    createdAt: "2026-03-01T10:11:12.000Z",
    kind: "bot_runtime",
    content: "runtime_started",
    metadata: {
      agent: "main"
    }
  });

  assert.equal(priorActions.length, 1);
  assert.equal(lines.length, 1);

  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.ts, "2026-03-01T10:11:12.000Z");
  assert.equal(parsed.kind, "bot_runtime");
  assert.equal(parsed.event, "runtime_started");
  assert.equal(parsed.agent, "main");

  logger.close();
});

test("formatPrettyLine highlights heard transcripts before generic metadata", () => {
  const line = formatPrettyLine({
    ts: "2026-03-01T10:11:12.000Z",
    level: "info",
    kind: "voice_runtime",
    event: "voice_turn_addressing",
    agent: "voice",
    usd_cost: 0,
    metadata: {
      sessionId: "sess-123",
      transcript: "can you look that up for me",
      directedConfidence: 0.95
    }
  });

  assert.match(line, /voice_turn_addressing/);
  assert.match(line, /heard/);
  assert.match(line, /can you look that up for me/);
  assert.ok(line.indexOf("heard") < line.indexOf("sessionId"));
});

test("formatPrettyLine highlights spoken transcripts for output events", () => {
  const line = formatPrettyLine({
    ts: "2026-03-01T10:11:12.000Z",
    level: "info",
    kind: "voice_runtime",
    event: "openai_realtime_transcript",
    agent: "voice",
    usd_cost: 0,
    metadata: {
      sessionId: "sess-123",
      transcript: "yeah for sure, what do you want me to look up?",
      transcriptSource: "output"
    }
  });

  assert.match(line, /openai_realtime_transcript/);
  assert.match(line, /said/);
  assert.match(line, /yeah for sure, what do you want me to look up\?/);
});

test("formatPrettyLine keeps replyText visible without speech-style emphasis on request logs", () => {
  const line = formatPrettyLine({
    ts: "2026-03-01T10:11:12.000Z",
    level: "info",
    kind: "voice_runtime",
    event: "realtime_reply_requested",
    agent: "voice",
    usd_cost: 0,
    metadata: {
      sessionId: "sess-123",
      replyText: "yeah for sure, what do you want me to look up?"
    }
  });

  assert.match(line, /realtime_reply_requested/);
  assert.match(line, /replyText/);
  assert.match(line, /yeah for sure, what do you want me to look up\?/);
});

test("formatPrettyLine surfaces drop reasons and signal metrics for provisional captures", () => {
  const line = formatPrettyLine({
    ts: "2026-03-01T10:11:12.000Z",
    level: "info",
    kind: "voice_runtime",
    event: "voice_turn_dropped_provisional_capture",
    agent: "voice",
    usd_cost: 0,
    metadata: {
      sessionId: "sess-123",
      reason: "near_silence_early_abort",
      peak: 0.009,
      rms: 0.001,
      activeSampleRatio: 0.004
    }
  });

  assert.match(line, /voice_turn_dropped_provisional_capture/);
  assert.match(line, /near_silence_early_abort/);
  assert.match(line, /peak=/);
  assert.match(line, /rms=/);
  assert.match(line, /active=/);
});

test("formatPrettyLine highlights llm call returned text for runtime debugging", () => {
  const line = formatPrettyLine({
    ts: "2026-03-01T10:11:12.000Z",
    level: "info",
    kind: "llm_call",
    event: "claude-oauth:claude-sonnet-4-6",
    agent: "runtime",
    usd_cost: 0.0039,
    metadata: {
      transcript: "yo, give me some sound effects",
      transcriptSource: "output",
      toolNames: "play_soundboard",
      toolCallCount: 1,
      responseChars: 31,
      stopReason: "tool_calls",
      source: "voice_realtime_generation"
    }
  });

  assert.match(line, /claude-oauth:claude-sonnet-4-6/);
  assert.match(line, /said/);
  assert.match(line, /yo, give me some sound effects/);
  assert.match(line, /toolNames/);
  assert.match(line, /play_soundboard/);
  assert.match(line, /stopReason/);
});
