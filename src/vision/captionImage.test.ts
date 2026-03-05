import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
    captionImage,
    resolveVisionProviderSettings,
    fetchImageAsBase64
} from "./captionImage.ts";


// --- resolveVisionProviderSettings ---

describe("resolveVisionProviderSettings", () => {
    test("returns null when llm is null", () => {
        assert.equal(resolveVisionProviderSettings(null), null);
    });

    test("returns null when no providers are configured", () => {
        const llm = { isProviderConfigured: () => false };
        assert.equal(resolveVisionProviderSettings(llm), null);
    });

    test("returns anthropic haiku when anthropic is configured", () => {
        const llm = {
            isProviderConfigured: (provider) => provider === "anthropic"
        };
        const result = resolveVisionProviderSettings(llm);
        assert.equal(result.provider, "anthropic");
        assert.equal(result.model, "claude-haiku-4-5");
        assert.equal(result.temperature, 0.2);
    });

    test("falls back to xai when anthropic is not configured", () => {
        const llm = {
            isProviderConfigured: (provider) => provider === "xai"
        };
        const result = resolveVisionProviderSettings(llm);
        assert.equal(result.provider, "xai");
        assert.equal(result.model, "grok-2-vision-latest");
    });

    test("falls back to claude-code when anthropic and xai are not configured", () => {
        const llm = {
            isProviderConfigured: (provider) => provider === "claude-code"
        };
        const result = resolveVisionProviderSettings(llm);
        assert.equal(result.provider, "claude-code");
        assert.equal(result.model, "sonnet");
    });

    test("uses explicit vision settings when configured", () => {
        const llm = {
            isProviderConfigured: (provider) => provider === "anthropic" || provider === "openai"
        };
        const settings = {
            vision: {
                captionProvider: "anthropic",
                captionModel: "claude-sonnet-4-5-20250929"
            }
        };
        const result = resolveVisionProviderSettings(llm, settings);
        assert.equal(result.provider, "anthropic");
        assert.equal(result.model, "claude-sonnet-4-5-20250929");
    });

    test("ignores explicit vision settings when provider is not configured", () => {
        const llm = {
            isProviderConfigured: (provider) => provider === "anthropic"
        };
        const settings = {
            vision: {
                captionProvider: "xai",
                captionModel: "grok-2-vision-latest"
            }
        };
        const result = resolveVisionProviderSettings(llm, settings);
        assert.equal(result.provider, "anthropic");
        assert.equal(result.model, "claude-haiku-4-5");
    });
});


// --- captionImage ---

describe("captionImage", () => {
    test("returns null when llm is null", async () => {
        const result = await captionImage({ llm: null, url: "https://example.com/cat.jpg" });
        assert.equal(result, null);
    });

    test("returns null when no vision provider is available", async () => {
        const llm = {
            isProviderConfigured: () => false,
            generate: async () => ({ text: "a cat sitting on a keyboard" })
        };
        const result = await captionImage({ llm, url: "https://example.com/cat.jpg" });
        assert.equal(result, null);
    });

    test("returns null when no image source is provided", async () => {
        const llm = {
            isProviderConfigured: () => true,
            generate: async () => ({ text: "a cat sitting on a keyboard" })
        };
        const result = await captionImage({ llm });
        assert.equal(result, null);
    });

    test("captions image from url", async () => {
        let capturedCall = null;
        const llm = {
            isProviderConfigured: (provider) => provider === "anthropic",
            generate: async (params) => {
                capturedCall = params;
                return {
                    text: "An orange tabby cat sitting on a mechanical keyboard",
                    provider: "anthropic",
                    model: "claude-haiku-4-5"
                };
            }
        };

        const result = await captionImage({
            llm,
            url: "https://cdn.example.com/cat.jpg"
        });

        assert.ok(result);
        assert.equal(result.caption, "An orange tabby cat sitting on a mechanical keyboard");
        assert.equal(result.provider, "anthropic");
        assert.equal(result.model, "claude-haiku-4-5");

        // Verify the image was passed as a url input
        assert.equal(capturedCall.imageInputs.length, 1);
        assert.equal(capturedCall.imageInputs[0].url, "https://cdn.example.com/cat.jpg");
    });

    test("captions image from base64 data", async () => {
        let capturedCall = null;
        const llm = {
            isProviderConfigured: (provider) => provider === "anthropic",
            generate: async (params) => {
                capturedCall = params;
                return {
                    text: "A screenshot of a code editor",
                    provider: "anthropic",
                    model: "claude-haiku-4-5"
                };
            }
        };

        const result = await captionImage({
            llm,
            mimeType: "image/png",
            dataBase64: "iVBORw0KGgoAAAANS"
        });

        assert.ok(result);
        assert.equal(result.caption, "A screenshot of a code editor");
        assert.equal(capturedCall.imageInputs[0].mediaType, "image/png");
        assert.equal(capturedCall.imageInputs[0].dataBase64, "iVBORw0KGgoAAAANS");
    });

    test("uses custom prompt when provided", async () => {
        let capturedPrompt = "";
        const llm = {
            isProviderConfigured: () => true,
            generate: async (params) => {
                capturedPrompt = params.userPrompt;
                return { text: "Custom caption", provider: "anthropic", model: "claude-haiku-4-5" };
            }
        };

        await captionImage({
            llm,
            url: "https://example.com/img.jpg",
            prompt: "What text is visible in this image?"
        });

        assert.equal(capturedPrompt, "What text is visible in this image?");
    });

    test("returns null when LLM returns empty text", async () => {
        const llm = {
            isProviderConfigured: () => true,
            generate: async () => ({ text: "", provider: "anthropic", model: "claude-haiku-4-5" })
        };

        const result = await captionImage({ llm, url: "https://example.com/img.jpg" });
        assert.equal(result, null);
    });

    test("returns null when LLM throws", async () => {
        const llm = {
            isProviderConfigured: () => true,
            generate: async () => { throw new Error("API error"); }
        };

        const result = await captionImage({ llm, url: "https://example.com/img.jpg" });
        assert.equal(result, null);
    });

    test("passes trace to LLM generate call", async () => {
        let capturedTrace = null;
        const llm = {
            isProviderConfigured: () => true,
            generate: async (params) => {
                capturedTrace = params.trace;
                return { text: "A meme", provider: "anthropic", model: "claude-haiku-4-5" };
            }
        };

        await captionImage({
            llm,
            url: "https://example.com/meme.jpg",
            trace: { guildId: "g1", channelId: "c1", userId: "u1", source: "test_caption" }
        });

        assert.equal(capturedTrace.guildId, "g1");
        assert.equal(capturedTrace.source, "test_caption");
    });

    test("uses default trace when none provided", async () => {
        let capturedTrace = null;
        const llm = {
            isProviderConfigured: () => true,
            generate: async (params) => {
                capturedTrace = params.trace;
                return { text: "An image", provider: "anthropic", model: "claude-haiku-4-5" };
            }
        };

        await captionImage({ llm, url: "https://example.com/img.jpg" });
        assert.equal(capturedTrace.source, "image_caption");
    });
});


// --- fetchImageAsBase64 ---

describe("fetchImageAsBase64", () => {
    test("returns null for empty url", async () => {
        assert.equal(await fetchImageAsBase64(""), null);
        assert.equal(await fetchImageAsBase64(null), null);
    });

    test("returns null for unreachable url", async () => {
        const result = await fetchImageAsBase64("http://localhost:1/nonexistent.jpg", {
            timeoutMs: 500
        });
        assert.equal(result, null);
    });
});
