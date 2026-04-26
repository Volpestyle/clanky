import { test } from "bun:test";
import assert from "node:assert/strict";
import { buildCodeTaskResultPrompt, buildReplyPrompt } from "./promptText.ts";

test("buildReplyPrompt includes recent voice session context when provided", () => {
  const prompt = buildReplyPrompt({
    message: {
      authorName: "Alice",
      content: "what were we doing earlier?"
    },
    recentMessages: [],
    recentVoiceSessionContext: [
      {
        summaryText: "Alice and Bob narrowed the rollout to Friday and agreed to revisit the test harness.",
        ageMinutes: 6
      }
    ]
  });

  assert.match(prompt, /=== RECENT VOICE SESSION CONTEXT ===/u);
  assert.match(prompt, /6m ago: Alice and Bob narrowed the rollout to Friday/u);
});

test("buildCodeTaskResultPrompt requires completion followups", () => {
  const prompt = buildCodeTaskResultPrompt({
    sessionId: "task-1",
    status: "done",
    resultText: "Fixed the issue and ran tests."
  });

  assert.match(prompt, /\[CODE TASK COMPLETED\]/u);
  assert.match(prompt, /Fixed the issue and ran tests\./u);
  assert.match(prompt, /Do not output \[SKIP\]/u);
});
