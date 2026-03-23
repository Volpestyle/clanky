import { test } from "bun:test";
import assert from "node:assert/strict";
import { buildReplyPrompt } from "./promptText.ts";

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
