import { test } from "bun:test";
import assert from "node:assert/strict";
import type { LLMService } from "../llm.ts";
import type { BrowserManager } from "../services/BrowserManager.ts";
import { runBrowseAgent } from "./browseAgent.ts";

test("runBrowseAgent forwards step timeout to browser tools and preserves multi-block final text", async () => {
  const browserCalls: Array<{ sessionKey: string; url: string; timeoutMs: number }> = [];
  const closeCalls: string[] = [];
  const configureCalls: Array<Record<string, unknown>> = [];
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
    configureSession(sessionKey: string, options?: Record<string, unknown>) {
      configureCalls.push({ sessionKey, options });
    },
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
    headed: true,
    maxSteps: 3,
    stepTimeoutMs: 6_789,
    sessionTimeoutMs: 54_321,
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
  assert.deepEqual(configureCalls, [{
    sessionKey: "guild-1",
    options: {
      headed: true,
      sessionTimeoutMs: 54_321
    }
  }]);
  assert.deepEqual(llmCalls, [
    { provider: "anthropic", model: "claude-sonnet-4-5-20250929" },
    { provider: "anthropic", model: "claude-sonnet-4-5-20250929" }
  ]);
  assert.deepEqual(closeCalls, ["guild-1"]);
  assert.equal(result.text, "First answer block.\n\nSecond answer block.");
  assert.equal(result.totalCostUsd, 0.03);
  assert.equal(result.hitStepLimit, false);
});

test("runBrowseAgent throws AbortError when signal is aborted before or during loop", async () => {
  const browserManager = {
    configureSession() { return undefined; },
    async open() { return "opened"; },
    async close() { }
  // eslint-disable-next-line no-restricted-syntax
  } as unknown as BrowserManager;

  const store = { logAction() { } };
  const controller = new AbortController();

  const llm = {
    async chatWithTools() {
      controller.abort(); // Abort during the first LLM chat
      return {
        content: [{ type: "tool_call", id: "t1", name: "browser_open", input: { url: "foo" } }],
        stopReason: "tool_use",
        usage: { inputTokens: 1, outputTokens: 1 },
        costUsd: 0.01
      };
    }
  // eslint-disable-next-line no-restricted-syntax
  } as unknown as LLMService;

  const agentPromise = runBrowseAgent({
    llm,
    browserManager,
    store,
    sessionKey: "session-2",
    instruction: "test abort",
    provider: "anthropic",
    model: "claude",
    maxSteps: 3,
    stepTimeoutMs: 1000,
    trace: {},
    signal: controller.signal
  });

  await assert.rejects(agentPromise, /AbortError/);
});

test("runBrowseAgent propagates AbortError when a browser tool is cancelled in flight", async () => {
  const controller = new AbortController();
  const closeCalls: string[] = [];

  const llm = {
    async chatWithTools() {
      return {
        content: [{ type: "tool_call", id: "t1", name: "browser_open", input: { url: "https://example.com" } }],
        stopReason: "tool_use",
        usage: { inputTokens: 1, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0 },
        costUsd: 0.01
      };
    }
  // eslint-disable-next-line no-restricted-syntax
  } as unknown as LLMService;

  const browserManager = {
    configureSession() {
      return undefined;
    },
    async open(_sessionKey: string, _url: string, _timeoutMs = 0, signal?: AbortSignal) {
      return await new Promise<string>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          reject(new Error("AbortError: browser_open cancelled"));
        }, { once: true });
        controller.abort("cancel browser_open");
      });
    },
    async close(sessionKey: string) {
      closeCalls.push(sessionKey);
    }
  // eslint-disable-next-line no-restricted-syntax
  } as unknown as BrowserManager;

  const store = { logAction() { } };

  const agentPromise = runBrowseAgent({
    llm,
    browserManager,
    store,
    sessionKey: "session-3",
    instruction: "open example.com",
    provider: "anthropic",
    model: "claude",
    maxSteps: 3,
    stepTimeoutMs: 1000,
    trace: {},
    signal: controller.signal
  });

  await assert.rejects(agentPromise, /AbortError/);
  assert.deepEqual(closeCalls, ["session-3"]);
});
