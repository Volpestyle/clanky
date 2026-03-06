import { test } from "bun:test";
import assert from "node:assert/strict";
import { RuntimeActionLogger, normalizeRuntimeActionEvent } from "./runtimeActionLogger.ts";

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
