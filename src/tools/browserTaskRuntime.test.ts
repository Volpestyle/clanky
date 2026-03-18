import { test } from "bun:test";
import assert from "node:assert/strict";
import type { BrowserManager } from "../services/BrowserManager.ts";
import type { LLMService } from "../llm.ts";
import { BrowserTaskRegistry, buildBrowserTaskScopeKey, isAbortError, runBrowserBrowseTask } from "./browserTaskRuntime.ts";

test("BrowserTaskRegistry scopes active browser tasks to the channel and does not clear newer tasks", () => {
  const registry = new BrowserTaskRegistry();
  const scopeKey = buildBrowserTaskScopeKey({
    guildId: "guild-1",
    channelId: "channel-1"
  });

  const firstTask = registry.beginTask(scopeKey);
  assert.equal(firstTask.abortController.signal.aborted, false);

  const secondTask = registry.beginTask(scopeKey);
  assert.equal(firstTask.abortController.signal.aborted, true);
  assert.equal(Boolean(registry.get(scopeKey)), true);
  assert.equal(registry.get(scopeKey)?.taskId, secondTask.taskId);

  registry.clear(firstTask);
  assert.equal(registry.get(scopeKey)?.taskId, secondTask.taskId);

  registry.clear(secondTask);
  assert.equal(registry.get(scopeKey), undefined);
});

test("BrowserTaskRegistry aborts only the matching channel scope", () => {
  const registry = new BrowserTaskRegistry();
  const firstScopeKey = buildBrowserTaskScopeKey({
    guildId: "guild-1",
    channelId: "channel-1"
  });
  const secondScopeKey = buildBrowserTaskScopeKey({
    guildId: "guild-1",
    channelId: "channel-2"
  });

  registry.beginTask(firstScopeKey);
  const secondTask = registry.beginTask(secondScopeKey);

  const cancelled = registry.abort(firstScopeKey, "cancel first");
  assert.equal(cancelled, true);
  assert.equal(registry.get(firstScopeKey), undefined);
  assert.equal(registry.get(secondScopeKey)?.taskId, secondTask.taskId);
});

test("isAbortError recognizes native and wrapped abort failures", () => {
  assert.equal(isAbortError(Object.assign(new Error("The operation was aborted"), { name: "AbortError" })), true);
  assert.equal(isAbortError(new Error("AbortError: Browse agent run cancelled")), true);
  assert.equal(isAbortError(new Error("ordinary failure")), false);
});

test("runBrowserBrowseTask logs structured failures for the local browser runtime", async () => {
  const logs: Array<Record<string, unknown>> = [];
  const llm = {
    async chatWithTools() {
      throw new Error("browse_llm_failed");
    }
  } as LLMService;

  const browserManager = {
    configureSession() {
      return undefined;
    },
    async currentUrl() {
      return "https://example.com/local-failure";
    },
    async close() {
      return undefined;
    }
  } as BrowserManager;

  await assert.rejects(
    runBrowserBrowseTask({
      llm,
      browserManager,
      store: {
        logAction(entry) {
          logs.push(entry);
        }
      },
      sessionKey: "browser-local-1",
      instruction: "Open https://example.com/local-failure",
      provider: "openai",
      model: "gpt-5.4",
      maxSteps: 2,
      stepTimeoutMs: 5_000,
      trace: {
        guildId: "guild-1",
        channelId: "channel-1",
        userId: "user-1",
        source: "test"
      }
    }),
    /browse_llm_failed/
  );

  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.kind, "browser_browse_failed");
  assert.equal((logs[0]?.metadata as Record<string, unknown>)?.runtime, "local_browser_agent");
  assert.equal((logs[0]?.metadata as Record<string, unknown>)?.sessionKey, "browser-local-1");
  assert.equal((logs[0]?.metadata as Record<string, unknown>)?.errorMessage, "browse_llm_failed");
  assert.equal((logs[0]?.metadata as Record<string, unknown>)?.currentUrl, "https://example.com/local-failure");
});
