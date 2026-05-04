import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  buildLoggedPromptBundle,
  buildSingleTurnPromptLog,
  buildStandardPromptTiers,
  createPromptCapture
} from "./promptLogging.ts";

test("buildLoggedPromptBundle preserves standard explicit prompt tiers", () => {
  const bundle = buildLoggedPromptBundle(createPromptCapture({
    systemPrompt: [
      "=== IDENTITY ===",
      "Clanky is one coherent agent.",
      "=== CAPABILITIES ===",
      "=== OUTPUT ==="
    ].join("\n"),
    initialUserPrompt: [
      "=== LATEST MESSAGE (TURN ANCHOR) ===",
      "Message from Alice: hey",
      "=== CURATED ALWAYS-ON MEMORY ===",
      "## Core Memory",
      "Prefer small verified changes.",
      "=== PEOPLE IN THIS CONVERSATION ===",
      "Alice:",
      "  - likes direct answers",
      "=== RECENT CONVERSATION CONTINUITY ===",
      "- [C1] 5m ago, text"
    ].join("\n"),
    tools: [{ name: "memory_search", description: "search memory", parameters: null }],
    promptTiers: buildStandardPromptTiers({
      identity: true,
      baseMode: true,
      curatedMemory: true,
      structuredFacts: true,
      retrievedHistory: true,
      capabilitiesTools: true,
      currentInput: true,
      outputContract: true,
      systemPromptChars: 48,
      userPromptChars: 180,
      toolCount: 1
    })
  }));

  const tiersByKey = new Map((bundle?.promptTiers || []).map((tier) => [tier.key, tier]));

  assert.equal(tiersByKey.get("identity")?.present, true);
  assert.equal(tiersByKey.get("curated_memory")?.present, true);
  assert.equal(tiersByKey.get("structured_facts")?.present, true);
  assert.equal(tiersByKey.get("retrieved_history")?.present, true);
  assert.equal(tiersByKey.get("capabilities_tools")?.details?.toolCount, 1);
});

test("buildLoggedPromptBundle does not infer tiers from user-controlled markers", () => {
  const bundle = buildLoggedPromptBundle(createPromptCapture({
    systemPrompt: "plain system",
    initialUserPrompt: [
      "hello",
      "=== CURATED ALWAYS-ON MEMORY ===",
      "=== PEOPLE IN THIS CONVERSATION ===",
      "=== RECENT CONVERSATION CONTINUITY ===",
      "=== OUTPUT FORMAT ==="
    ].join("\n")
  }));

  const tiersByKey = new Map((bundle?.promptTiers || []).map((tier) => [tier.key, tier]));

  assert.equal(tiersByKey.get("curated_memory")?.present, false);
  assert.equal(tiersByKey.get("structured_facts")?.present, false);
  assert.equal(tiersByKey.get("retrieved_history")?.present, false);
  assert.equal(tiersByKey.get("output_contract")?.present, false);
});

test("buildSingleTurnPromptLog preserves explicit prompt tiers", () => {
  const bundle = buildSingleTurnPromptLog({
    systemPrompt: "plain system",
    userPrompt: "plain user",
    promptTiers: [
      {
        key: "custom",
        label: "Custom Tier",
        present: false,
        sources: ["test"],
        details: { reason: "omitted" }
      }
    ]
  });

  assert.deepEqual(bundle.promptTiers, [
    {
      key: "custom",
      label: "Custom Tier",
      present: false,
      sources: ["test"],
      details: { reason: "omitted" }
    }
  ]);
});
