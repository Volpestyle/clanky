import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  buildSystemPrompt,
  formatBehaviorMemoryFacts,
  formatInitiativeChannelSummaries,
  formatInitiativeSourcePerformance
} from "./promptFormatters.ts";

test("formatBehaviorMemoryFacts renders fact type and subject labels", () => {
  const rendered = formatBehaviorMemoryFacts([
    {
      fact_type: "behavioral",
      subjectLabel: "Shared lore",
      fact: "Send a GIF to Tiny Conk whenever they say what the heli."
    },
    {
      fact_type: "guidance",
      subjectLabel: "__self__",
      fact: "Use type shit occasionally in casual replies."
    }
  ]);

  assert.equal(rendered.includes("[behavioral] Shared lore"), true);
  assert.equal(rendered.includes("[guidance] __self__"), true);
});

test("buildSystemPrompt uses the unified base memory instructions", () => {
  const prompt = buildSystemPrompt({
    botName: "clanker conk",
    memory: { enabled: true }
  });

  assert.equal(prompt.includes("=== PERSONA ==="), true);
  assert.equal(prompt.includes("=== CAPABILITIES ==="), true);
  assert.equal(prompt.includes("=== ADAPTIVE DIRECTIVES ==="), false);
});

test("formatInitiativeChannelSummaries matches the unified initiative channel summary shape", () => {
  const now = Date.now();
  const rendered = formatInitiativeChannelSummaries([
    {
      channelId: "general-1",
      channelName: "general",
      lastHumanAt: new Date(now - 8 * 60_000).toISOString(),
      lastHumanAuthorName: "james",
      lastHumanSnippet: "anyone want to play tonight?",
      lastBotAt: new Date(now - 2 * 60 * 60_000).toISOString(),
      recentHumanMessageCount: 3,
      recentMessages: [
        {
          message_id: "discord-1",
          author_name: "james",
          content: "anyone want to play tonight?"
        }
      ]
    },
    {
      channelId: "tech-1",
      channelName: "tech",
      recentHumanMessageCount: 0,
      recentMessages: []
    }
  ]);

  assert.equal(rendered.startsWith("Eligible channels:"), true);
  assert.equal(rendered.includes("#general (text)"), true);
  assert.equal(rendered.includes("channelId: general-1"), true);
  assert.equal(rendered.includes('Last human message: 8m ago — "anyone want to play tonight?" (user: james)'), true);
  assert.equal(rendered.includes("Recent activity: 3 messages in the last hour"), true);
  assert.equal(rendered.includes("#tech (text)"), true);
  assert.equal(rendered.includes("Last human message: quiet"), true);
  assert.equal(rendered.includes("Recent activity: idle"), true);
  assert.equal(
    rendered.includes("Recent messages ([text]=typed in channel, [vc]=transcript from linked voice chat):"),
    true
  );
  assert.equal(rendered.includes("  - [text] james: anyone want to play tonight?"), true);
});

test("formatInitiativeChannelSummaries labels linked voice transcript context", () => {
  const now = Date.now();
  const rendered = formatInitiativeChannelSummaries([
    {
      channelId: "general-1",
      channelName: "general",
      lastHumanAt: new Date(now - 3 * 60_000).toISOString(),
      lastHumanMessageId: "voice-guild-1-abc123",
      lastHumanAuthorName: "vuhlp",
      lastHumanSnippet: "which sound effect you want though?",
      recentHumanMessageCount: 2,
      recentMessages: [
        {
          message_id: "voice-guild-1-abc123",
          author_name: "vuhlp",
          content: "which sound effect you want though?"
        }
      ]
    }
  ]);

  assert.equal(
    rendered.includes('Last human message: 3m ago [vc transcript] — "which sound effect you want though?" (user: vuhlp)'),
    true
  );
  assert.equal(rendered.includes("  - [vc] vuhlp: which sound effect you want though?"), true);
});

test("formatInitiativeSourcePerformance includes the spec wording for source stats", () => {
  const rendered = formatInitiativeSourcePerformance([
    {
      label: "r/games",
      sharedCount: 5,
      fetchedCount: 6,
      engagementCount: 12,
      lastUsedAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString()
    }
  ]);

  assert.equal(rendered.startsWith("Your feed sources:"), true);
  assert.equal(rendered.includes("r/games — 5/6 candidates shared in last 2 weeks, 12 community engagement"), true);
  assert.equal(rendered.includes("last used 2h ago"), true);
});
