import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ImageCaptionCache } from "./imageCaptionCache.ts";


// --- Basic cache behavior ---

describe("ImageCaptionCache", () => {
    test("get returns null for uncached url", () => {
        const cache = new ImageCaptionCache();
        assert.equal(cache.get("https://example.com/img.jpg"), null);
    });

    test("has returns false for uncached url", () => {
        const cache = new ImageCaptionCache();
        assert.equal(cache.has("https://example.com/img.jpg"), false);
    });

    test("set and get round-trip", () => {
        const cache = new ImageCaptionCache();
        cache.set("https://example.com/cat.jpg", "An orange cat", "anthropic", "claude-haiku-4-5");

        const result = cache.get("https://example.com/cat.jpg");
        assert.ok(result);
        assert.equal(result.caption, "An orange cat");
        assert.equal(result.provider, "anthropic");
        assert.equal(result.model, "claude-haiku-4-5");
        assert.ok(result.captionedAt > 0);
    });

    test("has returns true after set", () => {
        const cache = new ImageCaptionCache();
        cache.set("https://example.com/cat.jpg", "A cat");
        assert.equal(cache.has("https://example.com/cat.jpg"), true);
    });

    test("normalizes URLs by stripping query params", () => {
        const cache = new ImageCaptionCache();
        cache.set("https://cdn.discord.com/attachments/123/img.jpg?token=abc123", "A dog");

        // Same path, different token
        const result = cache.get("https://cdn.discord.com/attachments/123/img.jpg?token=xyz789");
        assert.ok(result);
        assert.equal(result.caption, "A dog");
    });

    test("normalizes URLs case-insensitively", () => {
        const cache = new ImageCaptionCache();
        cache.set("https://Example.COM/Image.JPG", "An image");

        const result = cache.get("https://example.com/image.jpg");
        assert.ok(result);
        assert.equal(result.caption, "An image");
    });

    test("returns null for empty/null urls", () => {
        const cache = new ImageCaptionCache();
        assert.equal(cache.get(""), null);
        assert.equal(cache.get(null), null);
        assert.equal(cache.has(""), false);
    });

    test("set ignores empty caption", () => {
        const cache = new ImageCaptionCache();
        cache.set("https://example.com/img.jpg", "");
        assert.equal(cache.has("https://example.com/img.jpg"), false);
    });

    test("size tracks number of entries", () => {
        const cache = new ImageCaptionCache();
        assert.equal(cache.size, 0);
        cache.set("https://example.com/a.jpg", "Image A");
        assert.equal(cache.size, 1);
        cache.set("https://example.com/b.jpg", "Image B");
        assert.equal(cache.size, 2);
    });

    test("clear removes all entries", () => {
        const cache = new ImageCaptionCache();
        cache.set("https://example.com/a.jpg", "Image A");
        cache.set("https://example.com/b.jpg", "Image B");
        cache.clear();
        assert.equal(cache.size, 0);
        assert.equal(cache.get("https://example.com/a.jpg"), null);
    });
});


// --- Eviction ---

describe("ImageCaptionCache eviction", () => {
    test("evict removes entries older than TTL", () => {
        const cache = new ImageCaptionCache({ defaultTtlMs: 100 });

        // Insert an entry and force its timestamp to be very old
        cache.set("https://example.com/old.jpg", "Old image");
        const entry = cache.get("https://example.com/old.jpg");
        assert.ok(entry, "entry should exist after set");
        entry.captionedAt = Date.now() - 10_000; // 10s ago — well past 100ms TTL

        // Verify the mutation is visible through get()
        const verify = cache.get("https://example.com/old.jpg");
        assert.ok(verify.captionedAt < Date.now() - 5_000, "timestamp mutation should be visible");

        cache.set("https://example.com/new.jpg", "New image");

        const evicted = cache.evict();
        assert.equal(evicted, 1);
        assert.equal(cache.get("https://example.com/old.jpg"), null);
        assert.ok(cache.get("https://example.com/new.jpg"));
    });

    test("enforces max entries with LRU eviction", () => {
        const cache = new ImageCaptionCache({ maxEntries: 12 });

        for (let i = 0; i < 15; i++) {
            cache.set(`https://example.com/${i}.jpg`, `Image ${i}`);
        }

        // Should have evicted some entries
        assert.ok(cache.size <= 12);
        // Most recent entries should still be present
        assert.ok(cache.has("https://example.com/14.jpg"));
    });
});


// --- getOrCaption ---

describe("ImageCaptionCache getOrCaption", () => {
    test("returns cached entry on hit", async () => {
        const cache = new ImageCaptionCache();
        cache.set("https://example.com/cat.jpg", "A cat sitting");

        const llm = {
            isProviderConfigured: () => true,
            generate: async () => {
                throw new Error("Should not be called");
            }
        };

        const result = await cache.getOrCaption({
            url: "https://example.com/cat.jpg",
            llm
        });

        assert.ok(result);
        assert.equal(result.caption, "A cat sitting");
    });

    test("generates and caches on miss", async () => {
        const cache = new ImageCaptionCache();
        let generateCalls = 0;

        const llm = {
            isProviderConfigured: () => true,
            generate: async () => {
                generateCalls++;
                return {
                    text: "A fiery sunset over mountains",
                    provider: "anthropic",
                    model: "claude-haiku-4-5"
                };
            }
        };

        const result = await cache.getOrCaption({
            url: "https://example.com/sunset.jpg",
            llm
        });

        assert.ok(result);
        assert.equal(result.caption, "A fiery sunset over mountains");
        assert.equal(generateCalls, 1);

        // Second call should use cached value
        const result2 = await cache.getOrCaption({
            url: "https://example.com/sunset.jpg",
            llm
        });
        assert.equal(result2.caption, "A fiery sunset over mountains");
        assert.equal(generateCalls, 1); // Still 1 — no new call
    });

    test("coalesces concurrent requests for the same URL", async () => {
        const cache = new ImageCaptionCache();
        let generateCalls = 0;

        const llm = {
            isProviderConfigured: () => true,
            generate: async () => {
                generateCalls++;
                // Small delay to simulate API call
                await new Promise((resolve) => setTimeout(resolve, 50));
                return {
                    text: "A red sports car",
                    provider: "anthropic",
                    model: "claude-haiku-4-5"
                };
            }
        };

        // Fire two requests concurrently
        const [r1, r2] = await Promise.all([
            cache.getOrCaption({ url: "https://example.com/car.jpg", llm }),
            cache.getOrCaption({ url: "https://example.com/car.jpg", llm })
        ]);

        assert.equal(generateCalls, 1); // Only one API call fired
        assert.equal(r1?.caption, "A red sports car");
        assert.equal(r2?.caption, "A red sports car");
    });

    test("returns null when captioning fails", async () => {
        const cache = new ImageCaptionCache();

        const llm = {
            isProviderConfigured: () => true,
            generate: async () => ({ text: "" })
        };

        const result = await cache.getOrCaption({
            url: "https://example.com/broken.jpg",
            llm
        });

        assert.equal(result, null);
        // Should not cache a failed caption
        assert.equal(cache.has("https://example.com/broken.jpg"), false);
    });

    test("returns null for empty url", async () => {
        const cache = new ImageCaptionCache();
        const llm = {
            isProviderConfigured: () => true,
            generate: async () => ({ text: "nope" })
        };

        assert.equal(await cache.getOrCaption({ url: "", llm }), null);
    });
});


// --- hasOrInflight ---

describe("ImageCaptionCache hasOrInflight", () => {
    test("returns false for unknown URL", () => {
        const cache = new ImageCaptionCache();
        assert.equal(cache.hasOrInflight("https://example.com/unknown.jpg"), false);
    });

    test("returns true for cached URL", () => {
        const cache = new ImageCaptionCache();
        cache.set("https://example.com/cached.jpg", "A cached image");
        assert.equal(cache.hasOrInflight("https://example.com/cached.jpg"), true);
    });

    test("returns true while caption is in-flight", async () => {
        const cache = new ImageCaptionCache();
        let resolveGenerate;
        const llm = {
            isProviderConfigured: () => true,
            generate: () => new Promise((resolve) => {
                resolveGenerate = resolve;
            })
        };

        // Start captioning but don't await — it's now in-flight
        const captionPromise = cache.getOrCaption({
            url: "https://example.com/inflight.jpg",
            llm
        });

        // While in-flight, hasOrInflight should return true
        assert.equal(cache.hasOrInflight("https://example.com/inflight.jpg"), true);
        // But has() should still return false (not yet cached)
        assert.equal(cache.has("https://example.com/inflight.jpg"), false);

        // Resolve and clean up
        resolveGenerate({ text: "Done", provider: "anthropic", model: "claude-haiku-4-5" });
        await captionPromise;

        // Now both should be true (cached)
        assert.equal(cache.hasOrInflight("https://example.com/inflight.jpg"), true);
        assert.equal(cache.has("https://example.com/inflight.jpg"), true);
    });
});
