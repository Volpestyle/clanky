import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appConfig } from "../config.ts";
import { LLMService } from "../llm.ts";
import { MemoryManager } from "../memory/memoryManager.ts";
import { Store } from "../store/store.ts";
import type { BotContext } from "./botContext.ts";
import {
  captionRecentHistoryImages,
  extractHistoryImageCandidates,
  mergeImageInputs,
  rankImageLookupCandidates,
  runModelRequestedImageLookup,
  type ImageCaptionCacheLike
} from "./imageAnalysis.ts";

async function withTempImageContext(run: (ctx: BotContext) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clanker-bot-image-analysis-test-"));
  const dbPath = path.join(dir, "clanker.db");
  const store = new Store(dbPath);
  store.init();

  const llm = new LLMService({ appConfig, store });
  const memory = new MemoryManager({
    store,
    llm,
    memoryFilePath: path.join(dir, "memory.md")
  });
  const ctx: BotContext = {
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
    botUserId: "bot-1"
  };

  try {
    await run(ctx);
  } finally {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("extractHistoryImageCandidates keeps image URLs, skips excluded URLs, and enriches cached captions", () => {
  const imageCaptionCache: ImageCaptionCacheLike = {
    get(url) {
      if (url === "https://cdn.example.com/cat.png") {
        return { caption: "a sleeping cat" };
      }
      return null;
    }
  };

  const candidates = extractHistoryImageCandidates({
    recentMessages: [
      {
        message_id: "m1",
        author_name: "alice",
        created_at: "2026-03-06T12:00:00.000Z",
        content:
          "check this out https://cdn.example.com/cat.png https://cdn.example.com/skip.png https://example.com/readme.pdf"
      }
    ],
    excluded: new Set(["https://cdn.example.com/skip.png"]),
    imageCaptionCache
  });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.url, "https://cdn.example.com/cat.png");
  assert.equal(candidates[0]?.imageRef, "IMG 1");
  assert.equal(candidates[0]?.filename, "cat.png");
  assert.equal(candidates[0]?.contentType, "image/png");
  assert.equal(candidates[0]?.hasCachedCaption, true);
  assert.equal(candidates[0]?.context, "check this out https://cdn.example.com/skip.png https://example.com/readme.pdf [caption: a sleeping cat]");
});

test("rankImageLookupCandidates prefers phrase and token matches over recency fallback", () => {
  const ranked = rankImageLookupCandidates({
    candidates: [
      {
        url: "https://cdn.example.com/cat.png",
        context: "orange cat on the sofa",
        filename: "cat.png",
        authorName: "alice",
        recencyRank: 1
      },
      {
        url: "https://cdn.example.com/receipt.png",
        context: "grocery receipt on the table",
        filename: "receipt.png",
        authorName: "bob",
        recencyRank: 0
      }
    ],
    query: "orange cat"
  });

  assert.equal(ranked[0]?.url, "https://cdn.example.com/cat.png");
  assert.equal(String(ranked[0]?.matchReason || "").includes("phrase match"), true);
});

test("mergeImageInputs clamps and dedupes image inputs", () => {
  const merged = mergeImageInputs({
    baseInputs: [
      { url: "https://cdn.example.com/one.png", contentType: "image/png" },
      { dataBase64: "aaa", mediaType: "image/png" }
    ],
    extraInputs: [
      { url: "https://cdn.example.com/one.png", contentType: "image/png" },
      { dataBase64: "aaa", mediaType: "image/png" },
      { url: "https://cdn.example.com/two.png", contentType: "image/png" }
    ],
    maxInputs: 3
  });

  assert.deepEqual(merged, [
    { url: "https://cdn.example.com/one.png", contentType: "image/png" },
    { dataBase64: "aaa", mediaType: "image/png" },
    { url: "https://cdn.example.com/two.png", contentType: "image/png" }
  ]);
});

test("runModelRequestedImageLookup normalizes the query and selects matching history images", async () => {
  const lookup = await runModelRequestedImageLookup({
    imageLookup: {
      enabled: true,
      candidates: [
        {
          url: "https://cdn.example.com/cat.png",
          filename: "cat.png",
          contentType: "image/png",
          context: "orange cat on the sofa",
          authorName: "alice",
          recencyRank: 1
        },
        {
          url: "https://cdn.example.com/receipt.png",
          filename: "receipt.png",
          contentType: "image/png",
          context: "grocery receipt on the table",
          authorName: "bob",
          recencyRank: 0
        }
      ]
    },
    query: "  orange cat  "
  });

  assert.equal(lookup.query, "orange cat");
  assert.equal(lookup.used, true);
  assert.equal(lookup.results[0]?.url, "https://cdn.example.com/cat.png");
  assert.deepEqual(lookup.selectedImageInputs[0], {
    url: "https://cdn.example.com/cat.png",
    filename: "cat.png",
    contentType: "image/png"
  });
});

test("runModelRequestedImageLookup resolves direct IMG refs", async () => {
  const lookup = await runModelRequestedImageLookup({
    imageLookup: {
      enabled: true,
      candidates: [
        {
          imageRef: "IMG 1",
          url: "https://cdn.example.com/cat.png",
          filename: "cat.png",
          contentType: "image/png",
          context: "orange cat on the sofa",
          authorName: "alice",
          recencyRank: 1
        }
      ]
    },
    query: "img 1"
  });

  assert.equal(lookup.used, true);
  assert.equal(lookup.results[0]?.matchReason, "direct image ref");
  assert.equal(lookup.selectedImageInputs[0]?.filename, "cat.png");
});

test("captionRecentHistoryImages respects hourly budget and skips inflight URLs", async () => {
  await withTempImageContext(async (ctx) => {
    const captionTimestamps = [Date.now() - 2 * 60 * 60 * 1000, Date.now() - 1000];
    const scheduledUrls: string[] = [];
    const imageCaptionCache: ImageCaptionCacheLike = {
      hasOrInflight(url) {
        return url === "https://cdn.example.com/busy.png";
      },
      async getOrCaption(payload) {
        scheduledUrls.push(payload.url);
        return null;
      }
    };

    captionRecentHistoryImages(ctx, {
      imageCaptionCache,
      captionTimestamps,
      settings: {
        vision: {
          maxCaptionsPerHour: 2
        }
      },
      candidates: [
        {
          url: "https://cdn.example.com/busy.png",
          contentType: "image/png"
        },
        {
          url: "https://cdn.example.com/free.png",
          contentType: "image/png"
        },
        {
          url: "https://cdn.example.com/free-2.png",
          contentType: "image/png"
        }
      ]
    });

    await Promise.resolve();

    assert.deepEqual(scheduledUrls, ["https://cdn.example.com/free.png"]);
    assert.equal(captionTimestamps.length, 2);
  });
});
