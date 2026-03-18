import { test } from "bun:test";
import assert from "node:assert/strict";
import { estimateUsdCost, getLlmModelCatalog } from "./pricing.ts";

test("estimateUsdCost prices gpt-5.4 browser tasks", () => {
  const cost = estimateUsdCost({
    provider: "openai",
    model: "gpt-5.4",
    inputTokens: 1_000,
    outputTokens: 500,
    cacheWriteTokens: 0,
    cacheReadTokens: 0
  });

  assert.equal(cost, 0.00625);
});

test("estimateUsdCost resolves spaced gpt 5.4 alias", () => {
  const cost = estimateUsdCost({
    provider: "openai",
    model: "gpt 5.4",
    inputTokens: 1_000,
    outputTokens: 500,
    cacheWriteTokens: 0,
    cacheReadTokens: 0
  });

  assert.equal(cost, 0.00625);
});

test("estimateUsdCost treats openai-oauth models as zero-cost subscription usage", () => {
  const cost = estimateUsdCost({
    provider: "openai-oauth",
    model: "gpt-5.4",
    inputTokens: 1_000,
    outputTokens: 500,
    cacheWriteTokens: 0,
    cacheReadTokens: 0
  });

  assert.equal(cost, 0);
});

test("getLlmModelCatalog exposes only the curated openai-oauth models", () => {
  const catalog = getLlmModelCatalog();
  assert.deepEqual(catalog["openai-oauth"], ["gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.3-codex", "gpt-5.1-codex-mini"]);
});
