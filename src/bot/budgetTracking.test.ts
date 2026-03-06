import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appConfig } from "../config.ts";
import { LLMService } from "../llm.ts";
import { MemoryManager } from "../memory.ts";
import { BrowserManager } from "../services/BrowserManager.ts";
import { WebSearchService } from "../search.ts";
import { Store } from "../store.ts";
import { createTestSettings } from "../testSettings.ts";
import { VideoContextService } from "../video.ts";
import { ImageCaptionCache } from "../vision/imageCaptionCache.ts";
import type { BudgetContext } from "./botContext.ts";
import {
  buildBrowserBrowseContext,
  buildImageLookupContext,
  buildVideoReplyContext,
  buildWebSearchContext,
  getImageBudgetState,
  getWebSearchBudgetState
} from "./budgetTracking.ts";

async function withTempBudgetContext(
  optionsOrRun:
    | {
        browserManager?: BrowserManager | null;
      }
    | ((ctx: BudgetContext & { browserManager: BrowserManager | null }) => Promise<void>),
  maybeRun?: (ctx: BudgetContext & { browserManager: BrowserManager | null }) => Promise<void>
) {
  const options = typeof optionsOrRun === "function" ? {} : optionsOrRun;
  const run = typeof optionsOrRun === "function" ? optionsOrRun : maybeRun;
  const browserManager = options.browserManager || null;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clanker-bot-budget-tracking-test-"));
  const dbPath = path.join(dir, "clanker.db");
  const store = new Store(dbPath);
  store.init();

  const llm = new LLMService({ appConfig, store });
  const memory = new MemoryManager({
    store,
    llm,
    memoryFilePath: path.join(dir, "memory.md")
  });
  const ctx: BudgetContext & { browserManager: BrowserManager | null } = {
    appConfig,
    store,
    llm,
    memory,
    client: {
      user: {
        id: "bot-1"
      },
      guilds: {
        cache: new Map()
      }
    },
    botUserId: "bot-1",
    search: new WebSearchService({ appConfig, store }),
    video: new VideoContextService({ store, llm }),
    browserManager,
    imageCaptionCache: new ImageCaptionCache()
  };

  try {
    if (typeof run !== "function") {
      throw new Error("missing_budget_test_runner");
    }
    await run(ctx);
  } finally {
    await browserManager?.closeAll();
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("getImageBudgetState counts recent image calls and clamps remaining budget", async () => {
  await withTempBudgetContext(async (ctx) => {
    const settings = createTestSettings({
      discovery: {
        maxImagesPerDay: 2
      }
    });

    ctx.store.logAction({ kind: "image_call" });
    ctx.store.logAction({ kind: "image_call" });
    ctx.store.logAction({ kind: "image_call" });

    const budget = getImageBudgetState(ctx, settings);

    assert.deepEqual(budget, {
      maxPerDay: 2,
      used: 3,
      remaining: 0,
      canGenerate: false
    });
  });
});

test("getWebSearchBudgetState counts successful and failed searches in the hourly window", async () => {
  await withTempBudgetContext(async (ctx) => {
    const settings = createTestSettings({
      webSearch: {
        enabled: true,
        maxSearchesPerHour: 3
      }
    });

    ctx.store.logAction({ kind: "search_call" });
    ctx.store.logAction({ kind: "search_error" });

    const budget = getWebSearchBudgetState(ctx, settings);

    assert.equal(budget.maxPerHour, 3);
    assert.equal(budget.successCount, 1);
    assert.equal(budget.errorCount, 1);
    assert.equal(budget.used, 2);
    assert.equal(budget.remaining, 1);
    assert.equal(budget.canSearch, true);
  });
});

test("buildWebSearchContext carries opt-out state and search configuration", async () => {
  await withTempBudgetContext(async (ctx) => {
    ctx.search.isConfigured = () => false;
    const settings = createTestSettings({
      webSearch: {
        enabled: true,
        maxSearchesPerHour: 4
      }
    });

    const webSearch = buildWebSearchContext(ctx, settings, "no web search for this one");

    assert.equal(webSearch.enabled, true);
    assert.equal(webSearch.configured, false);
    assert.equal(webSearch.optedOutByUser, true);
    assert.equal(webSearch.budget.maxPerHour, 4);
    assert.equal(webSearch.budget.canSearch, true);
  });
});

test("buildBrowserBrowseContext disables openai computer use when no OpenAI client is available", async () => {
  await withTempBudgetContext(
    {
      browserManager: new BrowserManager()
    },
    async (ctx) => {
      ctx.llm.openai = null;
      const settings = createTestSettings({
        browser: {
          enabled: true,
          maxBrowseCallsPerHour: 5
        }
      });
      const patchedSettings = {
        ...settings,
        agentStack: {
          ...settings.agentStack,
          overrides: {
            ...settings.agentStack.overrides,
            browserRuntime: "openai_computer_use"
          }
        }
      };

      const browserBrowse = buildBrowserBrowseContext(ctx, patchedSettings);

      assert.equal(browserBrowse.enabled, true);
      assert.equal(browserBrowse.configured, false);
      assert.equal(browserBrowse.budget.maxPerHour, 5);
      assert.equal(browserBrowse.budget.canBrowse, true);
    }
  );
});

test("buildVideoReplyContext reports budget blocking before fetching video context", async () => {
  await withTempBudgetContext(async (ctx) => {
    const settings = createTestSettings({
      videoContext: {
        enabled: true,
        maxLookupsPerHour: 1,
        maxVideosPerMessage: 1
      }
    });
    ctx.store.logAction({ kind: "video_context_call" });

    const videoContext = await buildVideoReplyContext(ctx, {
      settings,
      message: {
        content: "can you summarize https://youtu.be/dQw4w9WgXcQ"
      }
    });

    assert.equal(videoContext.requested, true);
    assert.equal(videoContext.used, false);
    assert.equal(videoContext.blockedByBudget, true);
    assert.equal(videoContext.detectedVideos, 1);
    assert.equal(videoContext.budget.remaining, 0);
  });
});

test("buildImageLookupContext filters excluded URLs and includes cached caption context", async () => {
  await withTempBudgetContext(async (ctx) => {
    const keepUrl = "https://cdn.example.com/cat.png";
    const skipUrl = "https://cdn.example.com/skip.png";
    ctx.imageCaptionCache.set(keepUrl, "sleepy orange cat");

    const imageLookup = buildImageLookupContext(ctx, {
      recentMessages: [
        {
          message_id: "msg-1",
          author_name: "alice",
          created_at: new Date().toISOString(),
          content: `look at this ${keepUrl}`
        },
        {
          message_id: "msg-2",
          author_name: "bob",
          created_at: new Date().toISOString(),
          content: `ignore this ${skipUrl}`
        }
      ],
      excludedUrls: [skipUrl]
    });

    assert.equal(imageLookup.enabled, true);
    assert.equal(imageLookup.candidates.length, 1);
    assert.equal(imageLookup.candidates[0]?.url, keepUrl);
    assert.match(String(imageLookup.candidates[0]?.context || ""), /sleepy orange cat/);
  });
});
