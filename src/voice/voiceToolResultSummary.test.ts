import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  formatVoiceToolResultSummary,
  summarizeVoiceToolResult
} from "./voiceToolResultSummary.ts";

test("summarizeVoiceToolResult extracts structured start_screen_watch details", () => {
  const summary = summarizeVoiceToolResult("start_screen_watch", {
    ok: true,
    started: true,
    reused: false,
    transport: "native",
    reason: "single_active_discord_screen_share",
    targetUserId: "speaker-2",
    frameReady: false,
    expiresInMinutes: null
  });

  assert.equal(typeof summary, "object");
  assert.equal((summary as Record<string, unknown>)?.started, true);
  assert.equal((summary as Record<string, unknown>)?.transport, "native");
  assert.equal((summary as Record<string, unknown>)?.targetUserId, "speaker-2");
});

test("summarizeVoiceToolResult normalizes music disambiguation summaries", () => {
  const summary = summarizeVoiceToolResult("music_play", {
    ok: true,
    status: "needs_disambiguation",
    results: [
      { id: "track-1", title: "Genesis", artist: "Grimes", platform: "youtube" },
      { id: "track-2", title: "Oblivion", artist: "Grimes", platform: "youtube" }
    ]
  });

  assert.equal(typeof summary, "object");
  assert.equal((summary as Record<string, unknown>)?.status, "needs_disambiguation");
  assert.equal((summary as Record<string, unknown>)?.resultCount, 2);
});

test("formatVoiceToolResultSummary serializes structured summaries compactly", () => {
  const rendered = formatVoiceToolResultSummary({
    ok: true,
    resultCount: 2,
    resultTitles: ["one", "two"]
  }, 120);

  assert.equal(typeof rendered, "string");
  assert.equal(rendered?.includes("\"resultCount\":2"), true);
  assert.equal(rendered?.includes("\"resultTitles\""), true);
});
