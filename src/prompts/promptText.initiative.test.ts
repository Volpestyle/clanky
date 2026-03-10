import { test } from "bun:test";
import assert from "node:assert/strict";

import { buildInitiativePrompt } from "./promptText.ts";

test("buildInitiativePrompt matches the unified initiative tool and task contract", () => {
  const prompt = buildInitiativePrompt({
    botName: "clanker",
    persona: "laid back, playful, and curious",
    initiativeEagerness: 20,
    channelSummaries: [
      {
        channelId: "general-1",
        channelName: "general"
      }
    ],
    discoveryCandidates: [],
    sourcePerformance: [],
    communityInterestFacts: [],
    relevantFacts: [],
    guidanceFacts: [],
    behavioralFacts: [],
    allowActiveCuriosity: false,
    allowMemorySearch: true,
    allowSelfCuration: true
  });

  assert.equal(prompt.includes("Persona: laid back, playful, and curious"), true);
  assert.equal(prompt.includes("This initiative action is always a normal text-channel post"), true);
  assert.equal(prompt.includes("Some recent lines may be marked [vc]"), true);
  assert.equal(prompt.includes("web_search and browser_browse are unavailable right now."), true);
  assert.equal(prompt.includes("You can use memory_search to recall durable community context"), true);
  assert.equal(prompt.includes("- discovery_source_add: subscribe to a new subreddit, RSS feed, YouTube channel, or X handle"), true);
  assert.equal(prompt.includes("If you notice a source consistently is not producing anything useful"), true);
  assert.equal(prompt.includes("Use exact channelId values from the CHANNELS section."), true);
  assert.equal(prompt.includes("\"mediaDirective\":\"none\"|\"image\"|\"video\"|\"gif\""), true);
});
