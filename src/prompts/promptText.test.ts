import { test } from "bun:test";
import assert from "node:assert/strict";
import { buildCodeTaskResultPrompt, buildMinecraftNarrationPrompt, buildReplyPrompt } from "./promptText.ts";

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

test("buildReplyPrompt renders curated memory as frozen background context", () => {
  const prompt = buildReplyPrompt({
    message: {
      authorName: "Alice",
      content: "what should we do next?"
    },
    recentMessages: [],
    curatedMemory: {
      mode: "text",
      loadedAt: "2026-01-01T00:00:00.000Z",
      ownerPrivate: false,
      collaborationContext: false,
      sections: [
        {
          key: "core",
          title: "Core Memory",
          fileName: "CORE.md",
          filePath: "memory/CORE.md",
          content: "Clanky keeps public social voice unless the context narrows it.",
          missing: false,
          blocked: false,
          warningIds: [],
          chars: 68,
          mtimeMs: 1,
          size: 68
        }
      ]
    }
  });

  assert.match(prompt, /=== CURATED ALWAYS-ON MEMORY ===/u);
  assert.match(prompt, /Frozen high-priority background/u);
  assert.match(prompt, /Clanky keeps public social voice/u);
});

test("buildMinecraftNarrationPrompt renders curated memory as ambient background context", () => {
  const prompt = buildMinecraftNarrationPrompt({
    botName: "Clanky",
    channelName: "minecraft",
    curatedMemory: {
      mode: "initiative",
      loadedAt: "2026-01-01T00:00:00.000Z",
      ownerPrivate: false,
      collaborationContext: false,
      sections: [
        {
          key: "core",
          title: "Core Memory",
          fileName: "CORE.md",
          filePath: "memory/CORE.md",
          content: "Narrate only moments the room would actually care about.",
          missing: false,
          blocked: false,
          warningIds: [],
          chars: 57,
          mtimeMs: 1,
          size: 57
        }
      ]
    }
  });

  assert.match(prompt, /=== CURATED ALWAYS-ON MEMORY ===/u);
  assert.match(prompt, /Narrate only moments the room would actually care about/u);
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
