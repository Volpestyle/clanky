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

test("formatPrettyLine keeps speech and debugging context visible", () => {
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

test("formatPrettyLine shows high precision for tiny usd costs", () => {
  const line = formatPrettyLine({
    ts: "2026-03-01T10:11:12.000Z",
    level: "info",
    kind: "memory_embedding_call",
    event: "text-embedding-3-small",
    agent: "memory",
    usd_cost: 0.00000156,
    metadata: {
      traceSource: "memory_user_ingest"
    }
  });

  assert.match(line, /\$0\.00000156/);
});
