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

test("summarizeVoiceToolResult includes disambiguation option selection ids", () => {
  const summary = summarizeVoiceToolResult("music_play", {
    ok: true,
    status: "needs_disambiguation",
    options: [
      {
        selection_id: "track-101",
        id: "track-101",
        title: "Classic Down South Atlanta Trap Mix",
        artist: "DJ Kno It All",
        platform: "youtube"
      },
      {
        selection_id: "track-102",
        id: "track-102",
        title: "TRAP MIX VOL 1",
        artist: "Unknown",
        platform: "youtube"
      }
    ]
  });

  assert.equal(typeof summary, "object");
  const summaryRecord = summary as Record<string, unknown>;
  assert.equal(summaryRecord.status, "needs_disambiguation");
  assert.equal(summaryRecord.resultCount, 0);
  assert.equal(summaryRecord.optionCount, 2);
  const options = Array.isArray(summaryRecord.disambiguationOptions)
    ? summaryRecord.disambiguationOptions as Array<Record<string, unknown>>
    : [];
  assert.equal(options.length, 2);
  assert.equal(options[0]?.selectionId, "track-101");
  assert.equal(options[1]?.selectionId, "track-102");
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
