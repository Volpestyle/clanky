import { test } from "bun:test";
import assert from "node:assert/strict";
import { estimateUsdCost } from "./pricing.ts";

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
