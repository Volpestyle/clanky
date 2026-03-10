import { test } from "bun:test";
import assert from "node:assert/strict";
import { buildInitiativePrompt } from "./promptText.ts";

test("buildInitiativePrompt includes the unified initiative spec structure and wording", () => {
  const prompt = buildInitiativePrompt({
    botName: "clanker conk",
    persona: "playful slang, open, honest, exploratory",
    initiativeEagerness: 20,
    channelSummaries: [
      {
        channelId: "general-1",
        channelName: "general",
        recentHumanMessageCount: 3,
        lastHumanAt: new Date(Date.now() - 8 * 60_000).toISOString(),
        lastHumanAuthorName: "james",
        lastHumanSnippet: "anyone want to play tonight?",
        recentMessages: []
      }
    ],
    discoveryCandidates: [
      {
        title: "New benchmark shows Claude 4.6 outperforming on coding tasks",
        sourceLabel: "Hacker News",
        publishedAt: new Date(Date.now() - 4 * 60 * 60_000).toISOString(),
        url: "https://example.com/article"
      }
    ],
    sourcePerformance: [
      {
        label: "r/games",
        sharedCount: 5,
        fetchedCount: 6,
        engagementCount: 12
      }
    ],
    communityInterestFacts: [
      "Gaming content gets the most engagement"
    ],
    relevantFacts: [
      {
        fact: "The server has been talking about Rust a lot lately",
        fact_type: "other"
      }
    ],
    guidanceFacts: [
      {
        fact: "Keep posts natural and non-spammy.",
        fact_type: "guidance",
        subjectLabel: "Shared lore"
      }
    ],
    behavioralFacts: [
      {
        fact: "If Tiny Conk says what the heli, send a GIF.",
        fact_type: "behavioral",
        subjectLabel: "Shared lore"
      }
    ],
    allowActiveCuriosity: true,
    allowSelfCuration: true,
    allowImagePosts: true,
    remainingImages: 2
  });

  assert.equal(prompt.includes("=== INITIATIVE MODE ==="), true);
  assert.equal(prompt.includes("Persona: playful slang, open, honest, exploratory"), true);
  assert.equal(prompt.includes("=== CHANNELS ==="), true);
  assert.equal(prompt.includes("Eligible channels:"), true);
  assert.equal(prompt.includes("=== YOUR FEED ==="), true);
  assert.equal(prompt.includes("Things from your feed (share if any catch your eye):"), true);
  assert.equal(prompt.includes("=== FEED SOURCES ==="), true);
  assert.equal(prompt.includes("Your feed sources:"), true);
  assert.equal(prompt.includes("=== WHAT THIS COMMUNITY IS INTO ==="), true);
  assert.equal(prompt.includes("=== MEMORY ==="), true);
  assert.equal(prompt.includes("=== BEHAVIOR GUIDANCE ==="), true);
  assert.equal(prompt.includes("=== RELEVANT BEHAVIORAL MEMORY ==="), true);
  assert.equal(
    prompt.includes("You can use web_search to look something up, or browser_browse to actually visit a site, inspect how a page looks, capture browser screenshots for visual inspection, or move through it interactively"),
    true
  );
  assert.equal(prompt.includes("You can request media (image, video, GIF) if the moment calls for it."), true);
  assert.equal(prompt.includes("- discovery_source_add: subscribe to a new subreddit, RSS feed, YouTube channel, or X handle"), true);
  assert.equal(
    prompt.includes("Look around. If something catches your eye — a conversation you can add to, a feed item worth sharing, a topic you want to explore — pick a channel and post. Otherwise, [SKIP] and check back later."),
    true
  );
  assert.equal(
    prompt.includes("If you notice a source consistently is not producing anything useful, or the community's interests point toward sources you do not have yet, you can adjust your feed."),
    true
  );
});
