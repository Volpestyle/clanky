/**
 * Shared vision utility for captioning images via a vision-capable LLM.
 *
 * Used by:
 * - Image caption cache (message history images)
 * - Browser agent (page screenshots)
 * - Embed thumbnail captioning
 */

import {
    applyOrchestratorOverrideSettings,
    getResolvedVisionBinding
} from "../settings/agentStack.ts";

const DEFAULT_CAPTION_PROMPT =
    "Describe this image in one concise sentence for search and conversation context. Focus on the main subject, action, and any text visible.";

const DEFAULT_CAPTION_MAX_OUTPUT_TOKENS = 150;

const IMAGE_FETCH_TIMEOUT_MS = 8_000;
const IMAGE_FETCH_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

const VISION_PROVIDER_CANDIDATES = [
    { provider: "anthropic", model: "claude-haiku-4-5" },
    { provider: "xai", model: "grok-2-vision-latest" },
    { provider: "claude-code", model: "sonnet" }
];

/**
 * Resolve the best available vision provider from the LLM service.
 * Mirrors the pattern in voiceStreamWatch.ts resolveStreamWatchVisionProviderSettings.
 */
export function resolveVisionProviderSettings(llm, settings = null) {
    if (!llm || typeof llm.isProviderConfigured !== "function") return null;

    const visionSettings = getResolvedVisionBinding(settings);
    const preferredProvider = String(visionSettings.provider || "").trim().toLowerCase();
    const preferredModel = String(visionSettings.model || "").trim();

    if (preferredProvider && preferredModel && llm.isProviderConfigured(preferredProvider)) {
        return {
            provider: preferredProvider,
            model: preferredModel,
            temperature: 0.2,
            maxOutputTokens: DEFAULT_CAPTION_MAX_OUTPUT_TOKENS
        };
    }

    for (const candidate of VISION_PROVIDER_CANDIDATES) {
        if (!llm.isProviderConfigured(candidate.provider)) continue;
        return {
            provider: candidate.provider,
            model: candidate.model,
            temperature: 0.2,
            maxOutputTokens: DEFAULT_CAPTION_MAX_OUTPUT_TOKENS
        };
    }

    return null;
}

/**
 * Fetch image bytes from a URL with timeout and size limit.
 * Returns { dataBase64, mimeType } or null on failure.
 */
export async function fetchImageAsBase64(url, {
    timeoutMs = IMAGE_FETCH_TIMEOUT_MS,
    maxBytes = IMAGE_FETCH_MAX_BYTES
} = {}) {
    const normalizedUrl = String(url || "").trim();
    if (!normalizedUrl) return null;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(normalizedUrl, {
            signal: controller.signal,
            headers: {
                Accept: "image/*"
            }
        });
        if (!response.ok) return null;

        const contentType = String(response.headers.get("content-type") || "").toLowerCase();
        const contentLength = Number(response.headers.get("content-length") || 0);
        if (contentLength > maxBytes) return null;

        const arrayBuffer = await response.arrayBuffer();
        if (arrayBuffer.byteLength > maxBytes) return null;

        const dataBase64 = Buffer.from(arrayBuffer).toString("base64");
        const mimeType = contentType.startsWith("image/") ? contentType.split(";")[0].trim() : "image/jpeg";

        return { dataBase64, mimeType };
    } catch {
        return null;
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Caption an image using a vision-capable LLM.
 *
 * Accepts either:
 * - url: image URL (will be fetched and converted to base64, or passed directly)
 * - dataBase64 + mimeType: raw image data
 *
 * Returns { caption, provider, model } or null if captioning failed.
 */
export async function captionImage({
    llm,
    settings = null,
    mimeType = "",
    dataBase64 = "",
    url = "",
    prompt = "",
    maxOutputTokens = 0,
    trace = null
}) {
    if (!llm || typeof llm.generate !== "function") return null;

    const providerSettings = resolveVisionProviderSettings(llm, settings);
    if (!providerSettings) return null;

    // Build image input — prefer dataBase64 if provided, otherwise use url
    const normalizedBase64 = String(dataBase64 || "").trim();
    const normalizedUrl = String(url || "").trim();
    const normalizedMimeType = String(mimeType || "").trim().toLowerCase() || "image/jpeg";

    let imageInput;
    if (normalizedBase64) {
        imageInput = {
            mediaType: normalizedMimeType,
            dataBase64: normalizedBase64
        };
    } else if (normalizedUrl) {
        // Pass url directly — the LLM providers handle URL-based image inputs
        imageInput = { url: normalizedUrl };
    } else {
        return null;
    }

    const resolvedPrompt = String(prompt || DEFAULT_CAPTION_PROMPT).trim();
    const resolvedMaxTokens = Math.max(
        50,
        Number(maxOutputTokens) || DEFAULT_CAPTION_MAX_OUTPUT_TOKENS
    );

    try {
        const tunedSettings = applyOrchestratorOverrideSettings(settings, {
            provider: providerSettings.provider,
            model: providerSettings.model,
            temperature: providerSettings.temperature,
            maxOutputTokens: resolvedMaxTokens
        });

        const generated = await llm.generate({
            settings: tunedSettings,
            systemPrompt:
                "You are an image captioning assistant. Respond with only the description, no preamble.",
            userPrompt: resolvedPrompt,
            imageInputs: [imageInput],
            contextMessages: [],
            trace: trace || {
                guildId: null,
                channelId: null,
                userId: null,
                source: "image_caption"
            }
        });

        const caption = String(generated?.text || "").trim();
        if (!caption) return null;

        return {
            caption,
            provider: generated?.provider || providerSettings.provider || null,
            model: generated?.model || providerSettings.model || null
        };
    } catch {
        return null;
    }
}
