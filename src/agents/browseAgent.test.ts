import { test } from "bun:test";
import assert from "node:assert/strict";
import type { LLMService } from "../llm.ts";
import type { BrowserManager } from "../services/BrowserManager.ts";
import { runBrowseAgent } from "./browseAgent.ts";

test("runBrowseAgent forwards step timeout to browser tools and preserves multi-block final text", async () => {
  const browserCalls: Array<{ sessionKey: string; url: string; timeoutMs: number }> = [];
  const closeCalls: string[] = [];
  const llmCalls: Array<{ provider: string; model: string }> = [];
  let llmCallCount = 0;

  const llm = {
    async chatWithTools(args: { provider: string; model: string }) {
      llmCalls.push({ provider: args.provider, model: args.model });
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return {
          content: [
            {
              type: "tool_call",
              id: "toolu_1",
              name: "browser_open",
              input: { url: "https://example.com" }
            }
          ],
          stopReason: "tool_use",
          usage: { inputTokens: 1, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0 },
          costUsd: 0.01
        };
      }
      return {
        content: [
          { type: "text", text: "First answer block." },
          { type: "text", text: "Second answer block." }
        ],
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0 },
        costUsd: 0.02
      };
    }
  } as LLMService;

  const browserManager = {
    async open(sessionKey: string, url: string, timeoutMs = 0) {
      browserCalls.push({ sessionKey, url, timeoutMs });
      return "opened";
    },
    async close(sessionKey: string) {
      closeCalls.push(sessionKey);
    }
  } as BrowserManager;

  const store = {
    logAction() {
      return undefined;
    }
  };

  const result = await runBrowseAgent({
    llm,
    browserManager,
    store,
    sessionKey: "guild-1",
    instruction: "open example.com",
    provider: "anthropic",
    model: "claude-sonnet-4-5-20250929",
    maxSteps: 3,
    stepTimeoutMs: 6_789,
    trace: {
      guildId: "guild-1",
      channelId: "channel-1",
      userId: "user-1",
      source: "test"
    }
  });

  assert.deepEqual(browserCalls, [
    { sessionKey: "guild-1", url: "https://example.com", timeoutMs: 6_789 }
  ]);
  assert.deepEqual(llmCalls, [
    { provider: "anthropic", model: "claude-sonnet-4-5-20250929" },
    { provider: "anthropic", model: "claude-sonnet-4-5-20250929" }
  ]);
  assert.deepEqual(closeCalls, ["guild-1"]);
  assert.equal(result.text, "First answer block.\n\nSecond answer block.");
  assert.equal(result.totalCostUsd, 0.03);
  assert.equal(result.hitStepLimit, false);
});
