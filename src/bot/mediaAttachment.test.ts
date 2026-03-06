import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appConfig } from "../config.ts";
import { GifService } from "../gif.ts";
import { LLMService } from "../llm.ts";
import { MemoryManager } from "../memory.ts";
import { WebSearchService } from "../search.ts";
import { Store } from "../store.ts";
import { createTestSettings } from "../testSettings.ts";
import { VideoContextService } from "../video.ts";
import { ImageCaptionCache } from "../vision/imageCaptionCache.ts";
import type { MediaAttachmentContext } from "./botContext.ts";
import {
  buildMessagePayloadWithImage,
  maybeAttachReplyGif,
  resolveMediaAttachment
} from "./mediaAttachment.ts";

async function withTempMediaAttachmentContext(
  run: (ctx: MediaAttachmentContext) => Promise<void>
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clanker-bot-media-attachment-test-"));
  const dbPath = path.join(dir, "clanker.db");
  const store = new Store(dbPath);
  store.init();

  const llm = new LLMService({ appConfig, store });
  const memory = new MemoryManager({
    store,
    llm,
    memoryFilePath: path.join(dir, "memory.md")
  });
  const ctx: MediaAttachmentContext = {
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
    browserManager: null,
    imageCaptionCache: new ImageCaptionCache(),
    gifs: new GifService({ appConfig, store })
  };

  try {
    await run(ctx);
  } finally {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("buildMessagePayloadWithImage attaches a generated buffer as a file", () => {
  const result = buildMessagePayloadWithImage("hello", {
    imageBuffer: Buffer.from("png-bytes")
  });

  assert.equal(result.imageUsed, true);
  assert.equal(result.payload.content, "hello");
  assert.equal(result.payload.files?.length, 1);
  assert.match(String(result.payload.files?.[0]?.name || ""), /^clanker-\d+\.png$/);
});

test("maybeAttachReplyGif reports configuration blocking when GIF search is unavailable", async () => {
  await withTempMediaAttachmentContext(async (ctx) => {
    ctx.gifs.isConfigured = () => false;
    const settings = createTestSettings({
      discovery: {
        allowReplyGifs: true,
        maxGifsPerDay: 3
      }
    });

    const result = await maybeAttachReplyGif(ctx, {
      settings,
      text: "hello",
      query: "party parrot"
    });

    assert.equal(result.gifUsed, false);
    assert.equal(result.blockedByConfiguration, true);
    assert.equal(result.blockedByBudget, false);
  });
});

test("resolveMediaAttachment handles simple image directives through the shared cascade", async () => {
  await withTempMediaAttachmentContext(async (ctx) => {
    ctx.llm.isImageGenerationReady = () => true;
    ctx.llm.generateImage = async ({ variant = "simple" }) => ({
      variant,
      imageUrl: "https://cdn.example.com/generated.png"
    });
    const settings = createTestSettings({
      discovery: {
        maxImagesPerDay: 2
      }
    });

    const result = await resolveMediaAttachment(ctx, {
      settings,
      text: "hello world",
      directive: {
        type: "image_simple",
        imagePrompt: "draw a robot"
      }
    });

    assert.equal(result.media?.type, "image_simple");
    assert.equal(result.imageUsed, true);
    assert.equal(result.imageBudgetBlocked, false);
    assert.equal(result.imageCapabilityBlocked, false);
    assert.equal(result.imageVariantUsed, "simple");
    assert.match(result.payload.content, /generated\.png/);
  });
});

test("resolveMediaAttachment propagates video capability blocking through the shared cascade", async () => {
  await withTempMediaAttachmentContext(async (ctx) => {
    ctx.llm.isVideoGenerationReady = () => false;
    const settings = createTestSettings({
      discovery: {
        maxVideosPerDay: 2
      }
    });

    const result = await resolveMediaAttachment(ctx, {
      settings,
      text: "hello world",
      directive: {
        type: "video",
        videoPrompt: "animate this"
      }
    });

    assert.equal(result.media, null);
    assert.equal(result.videoUsed, false);
    assert.equal(result.videoCapabilityBlocked, true);
    assert.equal(result.videoBudgetBlocked, false);
  });
});

test("resolveMediaAttachment handles GIF directives through the shared cascade", async () => {
  await withTempMediaAttachmentContext(async (ctx) => {
    ctx.gifs.isConfigured = () => true;
    ctx.gifs.pickGif = async () => ({
      url: "https://media.example.com/party.gif"
    });
    const settings = createTestSettings({
      discovery: {
        allowReplyGifs: true,
        maxGifsPerDay: 2
      }
    });

    const result = await resolveMediaAttachment(ctx, {
      settings,
      text: "hello world",
      directive: {
        type: "gif",
        gifQuery: "party"
      }
    });

    assert.equal(result.media?.type, "gif");
    assert.equal(result.gifUsed, true);
    assert.equal(result.gifBudgetBlocked, false);
    assert.equal(result.gifConfigBlocked, false);
    assert.match(result.payload.content, /party\.gif/);
  });
});
