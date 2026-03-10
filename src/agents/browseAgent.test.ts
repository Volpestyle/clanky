import { test } from "bun:test";
import assert from "node:assert/strict";
import type { LLMService } from "../llm.ts";
import type { BrowserManager } from "../services/BrowserManager.ts";
import { BrowserAgentSession, runBrowseAgent } from "./browseAgent.ts";

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

test("BrowserAgentSession marks the session completed after browser_close and rejects follow-ups", async () => {
  const closeCalls: string[] = [];
  let llmCallCount = 0;

  const llm = {
    async chatWithTools() {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return {
          content: [{ type: "tool_call", id: "t1", name: "browser_open", input: { url: "https://example.com" } }],
          stopReason: "tool_use",
          usage: { inputTokens: 1, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0 },
          costUsd: 0.01
        };
      }
      if (llmCallCount === 2) {
        return {
          content: [{ type: "tool_call", id: "t2", name: "browser_close", input: {} }],
          stopReason: "tool_use",
          usage: { inputTokens: 1, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0 },
          costUsd: 0.01
        };
      }
      return {
        content: [{ type: "text", text: "Finished browsing." }],
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0 },
        costUsd: 0.01
      };
    }
  } as LLMService;

  const browserManager = {
    configureSession() {
      return undefined;
    },
    async open() {
      return "opened";
    },
    async close(sessionKey: string) {
      closeCalls.push(sessionKey);
    }
  } as BrowserManager;

  const session = new BrowserAgentSession({
    scopeKey: "guild-1:channel-1",
    llm,
    browserManager,
    store: { logAction() { return undefined; } },
    sessionKey: "browser-session-1",
    provider: "anthropic",
    model: "claude-sonnet-4-5-20250929",
    maxSteps: 5,
    stepTimeoutMs: 5_000,
    trace: {
      guildId: "guild-1",
      channelId: "channel-1",
      userId: "user-1",
      source: "test"
    }
  });

  const result = await session.runTurn("inspect example.com");
  assert.equal(result.isError, false);
  assert.equal(result.sessionCompleted, true);
  assert.equal(session.status, "completed");
  assert.equal(result.text, "Finished browsing.");
  assert.deepEqual(closeCalls, ["browser-session-1"]);

  const followUp = await session.runTurn("continue");
  assert.equal(followUp.isError, true);
  assert.equal(followUp.sessionCompleted, true);
  assert.equal(followUp.errorMessage, "Session completed");

  session.close();
  assert.equal(session.status, "completed");
  assert.deepEqual(closeCalls, ["browser-session-1"]);
});

test("BrowserAgentSession allows a final text turn after browser_close even when maxSteps is reached", async () => {
  const closeCalls: string[] = [];
  let llmCallCount = 0;

  const llm = {
    async chatWithTools() {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return {
          content: [{ type: "tool_call", id: "t1", name: "browser_close", input: {} }],
          stopReason: "tool_use",
          usage: { inputTokens: 1, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0 },
          costUsd: 0.01
        };
      }
      return {
        content: [{ type: "text", text: "All done." }],
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0 },
        costUsd: 0.01
      };
    }
  } as LLMService;

  const browserManager = {
    configureSession() {
      return undefined;
    },
    async close(sessionKey: string) {
      closeCalls.push(sessionKey);
    }
  } as BrowserManager;

  const session = new BrowserAgentSession({
    scopeKey: "guild-1:channel-1",
    llm,
    browserManager,
    store: { logAction() { return undefined; } },
    sessionKey: "browser-session-2",
    provider: "anthropic",
    model: "claude-sonnet-4-5-20250929",
    maxSteps: 1,
    stepTimeoutMs: 5_000,
    trace: {
      guildId: "guild-1",
      channelId: "channel-1",
      userId: "user-1",
      source: "test"
    }
  });

  const result = await session.runTurn("finish up");
  assert.equal(result.isError, false);
  assert.equal(result.sessionCompleted, true);
  assert.equal(result.text, "All done.");
  assert.equal(session.status, "completed");
  assert.deepEqual(closeCalls, ["browser-session-2"]);
});

test("BrowserAgentSession stops dispatching later tool calls after browser_close in the same response", async () => {
  const executedTools: string[] = [];
  let llmCallCount = 0;

  const llm = {
    async chatWithTools() {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return {
          content: [
            { type: "tool_call", id: "t1", name: "browser_open", input: { url: "https://example.com" } },
            { type: "tool_call", id: "t2", name: "browser_close", input: {} },
            { type: "tool_call", id: "t3", name: "browser_screenshot", input: {} }
          ],
          stopReason: "tool_use",
          usage: { inputTokens: 1, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0 },
          costUsd: 0.01
        };
      }
      return {
        content: [{ type: "text", text: "Finished browsing." }],
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0 },
        costUsd: 0.01
      };
    }
  } as LLMService;

  const browserManager = {
    configureSession() {
      return undefined;
    },
    async open() {
      executedTools.push("browser_open");
      return "opened";
    },
    async close() {
      executedTools.push("browser_close");
    },
    async screenshot() {
      executedTools.push("browser_screenshot");
      return "";
    }
  } as BrowserManager;

  const session = new BrowserAgentSession({
    scopeKey: "guild-1:channel-1",
    llm,
    browserManager,
    store: { logAction() { return undefined; } },
    sessionKey: "browser-session-3",
    provider: "anthropic",
    model: "claude-sonnet-4-5-20250929",
    maxSteps: 4,
    stepTimeoutMs: 5_000,
    trace: {
      guildId: "guild-1",
      channelId: "channel-1",
      userId: "user-1",
      source: "test"
    }
  });

  const result = await session.runTurn("finish up");
  assert.equal(result.isError, false);
  assert.equal(result.sessionCompleted, true);
  assert.equal(result.text, "Finished browsing.");
  assert.deepEqual(executedTools, ["browser_open", "browser_close"]);
});
