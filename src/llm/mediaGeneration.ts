import type OpenAI from "openai";
import { estimateImageUsdCost } from "../pricing.ts";
import { sleepMs } from "../normalization/time.ts";
import {
  extractOpenAiImageBase64,
  extractXaiVideoUrl,
  inferProviderFromModel,
  isXaiVideoDone,
  normalizeInlineText,
  normalizeModelAllowlist,
  normalizeOpenAiImageGenerationSize,
  normalizeXaiBaseUrl,
  prioritizePreferredModel
} from "./llmHelpers.ts";
import { safeJsonParse } from "../llmClaudeCode.ts";
import { getDiscoverySettings, getReplyGenerationSettings } from "../settings/agentStack.ts";
import type {
  LLMAppConfig,
  LlmActionStore,
  LlmTrace,
  XaiJsonRecord,
  XaiJsonRequestOptions
} from "./serviceShared.ts";
import { XAI_REQUEST_TIMEOUT_MS } from "./serviceShared.ts";

const XAI_VIDEO_POLL_INTERVAL_MS = 2500;
const XAI_VIDEO_TIMEOUT_MS = 4 * 60_000;
const XAI_VIDEO_FAILED_STATUSES = new Set(["failed", "error", "cancelled", "canceled"]);

export type MediaGenerationDeps = {
  openai: OpenAI | null;
  xai: OpenAI | null;
  appConfig: Pick<LLMAppConfig, "xaiApiKey" | "xaiBaseUrl">;
  store: LlmActionStore;
};

export async function fetchXaiJson(
  deps: Pick<MediaGenerationDeps, "appConfig">,
  url: string,
  options: XaiJsonRequestOptions = {},
  timeoutMs = XAI_REQUEST_TIMEOUT_MS
) {
  const { method = "GET", body } = options;
  if (!deps.appConfig?.xaiApiKey) {
    throw new Error("Missing XAI_API_KEY.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${deps.appConfig.xaiApiKey}`,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {})
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });

    const raw = await response.text();
    const parsed = raw ? safeJsonParse(raw, null) : {};
    if (!response.ok) {
      const message = normalizeInlineText(
        parsed?.error?.message || parsed?.message || raw || response.statusText,
        240
      );
      throw new Error(`xAI request failed (${response.status})${message ? `: ${message}` : ""}`);
    }

    if (parsed && typeof parsed === "object") return parsed as XaiJsonRecord;
    throw new Error("xAI returned an invalid JSON payload.");
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`xAI request timed out after ${Math.floor(timeoutMs / 1000)}s.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function resolveImageGenerationTarget(
  deps: Pick<MediaGenerationDeps, "openai" | "xai">,
  settings: unknown,
  variant = "simple"
) {
  const discovery = getDiscoverySettings(settings);
  const allowedModels = normalizeModelAllowlist(discovery.allowedImageModels);
  if (!allowedModels.length) return null;

  const preferredModel = String(
    variant === "complex" ? discovery.complexImageModel : discovery.simpleImageModel
  ).trim();
  const candidates = prioritizePreferredModel(allowedModels, preferredModel);

  for (const model of candidates) {
    const provider = inferProviderFromModel(model);
    if (provider === "openai" && deps.openai) return { provider, model };
    if (provider === "xai" && deps.xai) return { provider, model };
  }

  return null;
}

export function resolveVideoGenerationTarget(
  deps: Pick<MediaGenerationDeps, "xai">,
  settings: unknown
) {
  if (!deps.xai) return null;

  const discovery = getDiscoverySettings(settings);
  const allowedModels = normalizeModelAllowlist(discovery.allowedVideoModels);
  if (!allowedModels.length) return null;

  const preferredModel = String(discovery.videoModel || "").trim();
  const candidates = prioritizePreferredModel(allowedModels, preferredModel);
  for (const model of candidates) {
    if (inferProviderFromModel(model) === "xai") {
      return { provider: "xai", model };
    }
  }

  return null;
}

export function getMediaGenerationCapabilities(deps: Pick<MediaGenerationDeps, "openai" | "xai">, settings: unknown) {
  const simpleImageTarget = resolveImageGenerationTarget(deps, settings, "simple");
  const complexImageTarget = resolveImageGenerationTarget(deps, settings, "complex");
  const videoTarget = resolveVideoGenerationTarget(deps, settings);
  return {
    simpleImageReady: Boolean(simpleImageTarget),
    complexImageReady: Boolean(complexImageTarget),
    videoReady: Boolean(videoTarget),
    simpleImageModel: simpleImageTarget?.model || null,
    complexImageModel: complexImageTarget?.model || null,
    videoModel: videoTarget?.model || null
  };
}

export function isImageGenerationReady(
  deps: Pick<MediaGenerationDeps, "openai" | "xai">,
  settings: unknown,
  variant = "any"
) {
  if (variant === "simple") {
    return Boolean(resolveImageGenerationTarget(deps, settings, "simple"));
  }
  if (variant === "complex") {
    return Boolean(resolveImageGenerationTarget(deps, settings, "complex"));
  }
  return Boolean(
    resolveImageGenerationTarget(deps, settings, "simple") ||
    resolveImageGenerationTarget(deps, settings, "complex")
  );
}

export function isVideoGenerationReady(
  deps: Pick<MediaGenerationDeps, "xai">,
  settings: unknown
) {
  return Boolean(resolveVideoGenerationTarget(deps, settings));
}

export async function generateImage(
  deps: MediaGenerationDeps,
  {
    settings,
    prompt,
    variant = "simple",
    trace = { guildId: null, channelId: null, userId: null, source: null }
  }: {
    settings: unknown;
    prompt: unknown;
    variant?: string;
    trace?: LlmTrace;
  }
) {
  const target = resolveImageGenerationTarget(deps, settings, variant);
  if (!target) {
    throw new Error("Image generation is unavailable (missing API key or no allowed image model).");
  }

  const { provider, model } = target;
  const normalizedPrompt = String(prompt || "").slice(0, 3200);
  const size = provider === "openai" ? "1024x1024" : null;

  try {
    let imageBuffer = null;
    let imageUrl = null;

    if (provider === "openai") {
      if (!deps.openai) {
        throw new Error("OpenAI image generation requires OPENAI_API_KEY.");
      }
      const response = await deps.openai.responses.create({
        model,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: normalizedPrompt
              }
            ]
          }
        ],
        tool_choice: "required",
        tools: [
          {
            type: "image_generation",
            output_format: "png",
            size: normalizeOpenAiImageGenerationSize(size)
          }
        ]
      });
      const imageBase64 = extractOpenAiImageBase64(response);
      if (!imageBase64) {
        throw new Error("Image API returned no image data.");
      }
      imageBuffer = Buffer.from(imageBase64, "base64");
    } else {
      if (!deps.xai) {
        throw new Error("xAI image generation requires XAI_API_KEY.");
      }
      const response = await deps.xai.images.generate({
        model,
        prompt: normalizedPrompt
      });
      const first = response?.data?.[0];
      if (!first) {
        throw new Error("Image API returned no image data.");
      }

      if (first.b64_json) {
        imageBuffer = Buffer.from(first.b64_json, "base64");
      }
      imageUrl = first.url ? String(first.url) : null;
      if (!imageBuffer && !imageUrl) {
        throw new Error("Image API response had neither b64 nor URL.");
      }
    }

    const costUsd = estimateImageUsdCost({
      provider,
      model,
      size,
      imageCount: 1,
      customPricing: getReplyGenerationSettings(settings).pricing
    });

    deps.store.logAction({
      kind: "image_call",
      guildId: trace.guildId,
      channelId: trace.channelId,
      userId: trace.userId,
      content: `${provider}:${model}`,
      metadata: {
        provider,
        model,
        size,
        variant,
        source: trace.source || "unknown"
      },
      usdCost: costUsd
    });

    return {
      provider,
      model,
      size,
      variant,
      costUsd,
      imageBuffer,
      imageUrl
    };
  } catch (error) {
    deps.store.logAction({
      kind: "image_error",
      guildId: trace.guildId,
      channelId: trace.channelId,
      userId: trace.userId,
      content: String(error?.message || error),
      metadata: {
        provider,
        model,
        variant,
        source: trace.source || "unknown"
      }
    });
    throw error;
  }
}

export async function generateVideo(
  deps: MediaGenerationDeps,
  {
    settings,
    prompt,
    trace = { guildId: null, channelId: null, userId: null, source: null }
  }: {
    settings: unknown;
    prompt: unknown;
    trace?: LlmTrace;
  }
) {
  const target = resolveVideoGenerationTarget(deps, settings);
  if (!target) {
    throw new Error("Video generation is unavailable (missing XAI_API_KEY or no allowed xAI video model).");
  }

  const model = target.model;
  const baseUrl = normalizeXaiBaseUrl(deps.appConfig?.xaiBaseUrl);
  const payload = {
    model,
    prompt: String(prompt || "").slice(0, 3200)
  };

  try {
    const createResponse = await fetchXaiJson(
      deps,
      `${baseUrl}/videos/generations`,
      {
        method: "POST",
        body: payload
      },
      XAI_REQUEST_TIMEOUT_MS
    );

    const requestId = String(createResponse?.id || createResponse?.request_id || "").trim();
    if (!requestId) {
      throw new Error("xAI video API returned no request id.");
    }

    const startedAt = Date.now();
    let pollAttempts = 0;
    let statusResponse: XaiJsonRecord | null = null;

    while (Date.now() - startedAt < XAI_VIDEO_TIMEOUT_MS) {
      await sleepMs(XAI_VIDEO_POLL_INTERVAL_MS);
      pollAttempts += 1;

      const poll = await fetchXaiJson(
        deps,
        `${baseUrl}/videos/${encodeURIComponent(requestId)}`,
        { method: "GET" },
        XAI_REQUEST_TIMEOUT_MS
      );
      const status = String(poll?.status || "").trim().toLowerCase();

      if (isXaiVideoDone(status, poll)) {
        statusResponse = poll;
        break;
      }
      if (XAI_VIDEO_FAILED_STATUSES.has(status)) {
        throw new Error(`xAI video generation failed with status "${status}".`);
      }
    }

    if (!statusResponse) {
      throw new Error(`xAI video generation timed out after ${Math.floor(XAI_VIDEO_TIMEOUT_MS / 1000)}s.`);
    }

    const status = String(statusResponse?.status || "").trim().toLowerCase() || "done";
    const videoUrl = extractXaiVideoUrl(statusResponse);
    if (!videoUrl) {
      throw new Error("xAI video generation completed but returned no video URL.");
    }

    const videoRecord =
      statusResponse.video && typeof statusResponse.video === "object" && !Array.isArray(statusResponse.video)
        ? (statusResponse.video as Record<string, unknown>)
        : null;
    const durationSeconds = Number(
      videoRecord?.duration_seconds ??
      videoRecord?.duration ??
      statusResponse?.duration_seconds ??
      statusResponse?.duration ??
      0
    );
    const normalizedDuration = Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : null;
    const costUsd = 0;

    deps.store.logAction({
      kind: "video_call",
      guildId: trace.guildId,
      channelId: trace.channelId,
      userId: trace.userId,
      content: `xai:${model}`,
      metadata: {
        provider: "xai",
        model,
        requestId,
        status,
        pollAttempts,
        durationSeconds: normalizedDuration,
        source: trace.source || "unknown"
      },
      usdCost: costUsd
    });

    return {
      provider: "xai",
      model,
      requestId,
      status,
      pollAttempts,
      durationSeconds: normalizedDuration,
      videoUrl,
      costUsd
    };
  } catch (error) {
    deps.store.logAction({
      kind: "video_error",
      guildId: trace.guildId,
      channelId: trace.channelId,
      userId: trace.userId,
      content: String(error?.message || error),
      metadata: {
        provider: "xai",
        model,
        source: trace.source || "unknown"
      }
    });
    throw error;
  }
}
