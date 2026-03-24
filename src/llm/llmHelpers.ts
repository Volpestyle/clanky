const XAI_DEFAULT_BASE_URL = "https://api.x.ai/v1";
const XAI_VIDEO_DONE_STATUSES = new Set(["done", "completed", "succeeded", "success", "ready"]);
import { clamp01, clampInt, clampNumber } from "../normalization/numbers.ts";
import { extractJsonObjectFromText } from "../normalization/jsonExtraction.ts";
import { normalizeBoundedStringList } from "../settings/listNormalization.ts";
import { normalizeWhitespaceText } from "../normalization/text.ts";
export { clamp01, clampInt, clampNumber };

export function extractOpenAiResponseText(response) {
  const direct = String(response?.output_text || "").trim();
  if (direct) return direct;

  const output = Array.isArray(response?.output) ? response.output : [];
  const textParts = [];

  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    if (item.type !== "message") continue;
    const contentParts = Array.isArray(item.content) ? item.content : [];
    for (const part of contentParts) {
      if (!part || typeof part !== "object") continue;
      if (part.type !== "output_text") continue;
      const text = String(part.text || "").trim();
      if (text) textParts.push(text);
    }
  }

  return textParts.join("\n").trim();
}

export function extractOpenAiResponseUsage(response) {
  const usage = response?.usage && typeof response.usage === "object" ? response.usage : null;
  return {
    inputTokens: Number(usage?.input_tokens || 0),
    outputTokens: Number(usage?.output_tokens || 0),
    cacheWriteTokens: 0,
    cacheReadTokens: Number(usage?.input_tokens_details?.cached_tokens || 0)
  };
}

export function extractOpenAiToolCalls(response) {
  const output = Array.isArray(response?.output) ? response.output : [];
  const toolCalls = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    if (item.type !== "function_call") continue;
    const name = String(item.name || "").trim();
    const callId = String(item.call_id || item.id || "").trim();
    let input = {};
    if (typeof item.arguments === "string") {
      try {
        input = JSON.parse(item.arguments);
      } catch {
        input = {};
      }
    } else if (item.arguments && typeof item.arguments === "object") {
      input = item.arguments;
    }
    if (name) {
      toolCalls.push({ id: callId, name, input });
    }
  }
  return toolCalls;
}

export function extractOpenAiImageBase64(response) {
  const output = Array.isArray(response?.output) ? response.output : [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    if (item.type !== "image_generation_call") continue;
    const result = String(item.result || "").trim();
    if (result) return result;
  }
  return "";
}

export function normalizeOpenAiImageGenerationSize(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "1024x1024") return "1024x1024";
  if (normalized === "1024x1536") return "1024x1536";
  if (normalized === "1536x1024") return "1536x1024";
  return "auto";
}

export function normalizeInlineText(value, maxLen) {
  return normalizeWhitespaceText(value, { maxLen });
}

export function parseMemoryExtractionJson(rawText) {
  const raw = String(rawText || "").trim();
  if (!raw) return { facts: [] };

  return extractJsonObjectFromText(raw) || { facts: [] };
}

export function normalizeXaiBaseUrl(value) {
  const raw = String(value || XAI_DEFAULT_BASE_URL).trim();
  const normalized = raw || XAI_DEFAULT_BASE_URL;
  return normalized.replace(/\/+$/, "");
}

export function normalizeModelAllowlist(input, maxItems = 20) {
  if (!Array.isArray(input)) return [];
  return normalizeBoundedStringList(input, { maxItems, maxLen: 120 });
}

export function prioritizePreferredModel(allowedModels, preferredModel) {
  const preferred = String(preferredModel || "").trim();
  if (!preferred || !allowedModels.includes(preferred)) return allowedModels;
  return [preferred, ...allowedModels.filter((entry) => entry !== preferred)];
}

export function normalizeLlmProvider(value, fallback = "openai") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "openai") return "openai";
  if (normalized === "anthropic") return "anthropic";
  if (normalized === "ai_sdk_anthropic") return "ai_sdk_anthropic";
  if (normalized === "litellm") return "litellm";
  if (normalized === "claude-oauth") return "claude-oauth";
  if (normalized === "openai-oauth" || normalized === "codex-oauth") return "openai-oauth";
  if (normalized === "codex_cli_session") return "codex_cli_session";
  if (normalized === "xai") return "xai";
  if (normalized === "codex") return "codex";
  if (normalized === "codex-cli") return "codex-cli";

  const fallbackProvider = String(fallback || "")
    .trim()
    .toLowerCase();
  if (fallbackProvider === "openai") return "openai";
  if (fallbackProvider === "anthropic") return "anthropic";
  if (fallbackProvider === "ai_sdk_anthropic") return "ai_sdk_anthropic";
  if (fallbackProvider === "litellm") return "litellm";
  if (fallbackProvider === "claude-oauth") return "claude-oauth";
  if (fallbackProvider === "openai-oauth" || fallbackProvider === "codex-oauth") return "openai-oauth";
  if (fallbackProvider === "codex_cli_session") return "codex_cli_session";
  if (fallbackProvider === "xai") return "xai";
  if (fallbackProvider === "codex") return "codex";
  if (fallbackProvider === "codex-cli") return "codex-cli";
  return "openai";
}

export function normalizeOpenAiReasoningEffort(value, fallback = "") {
  const normalized = String(value || fallback || "")
    .trim()
    .toLowerCase();
  if (normalized === "none") return "none";
  if (normalized === "minimal") return "low";
  if (normalized === "low") return "low";
  if (normalized === "medium") return "medium";
  if (normalized === "high") return "high";
  if (normalized === "xhigh" || normalized === "x-high" || normalized === "x_high") return "xhigh";
  return "";
}

export function isGpt5FamilyModel(model) {
  const normalized = String(model || "")
    .trim()
    .toLowerCase();
  return /^gpt-5(?:$|[._-])/u.test(normalized);
}

export function defaultModelForLlmProvider(provider) {
  if (provider === "anthropic") return "claude-haiku-4-5";
  if (provider === "ai_sdk_anthropic") return "claude-haiku-4-5";
  if (provider === "litellm") return "claude-haiku-4-5";
  if (provider === "claude-oauth") return "claude-sonnet-4-6";
  if (provider === "openai-oauth") return "gpt-5.4";
  if (provider === "codex_cli_session") return "gpt-5.4";
  if (provider === "xai") return "grok-3-mini-latest";
  if (provider === "codex") return "gpt-5.4";
  if (provider === "codex-cli") return "gpt-5.4";
  return "claude-haiku-4-5";
}

export function resolveProviderFallbackOrder(provider) {
  if (provider === "claude-oauth") return ["claude-oauth", "anthropic", "openai", "xai"];
  if (provider === "openai-oauth" || provider === "codex-oauth") return ["openai-oauth", "openai", "anthropic", "claude-oauth", "xai"];
  if (provider === "codex_cli_session") return ["codex_cli_session", "codex-cli", "openai-oauth", "openai", "anthropic", "claude-oauth", "xai"];
  if (provider === "codex-cli") return ["codex-cli", "codex_cli_session", "openai-oauth", "openai", "anthropic", "claude-oauth", "xai"];
  if (provider === "codex") return ["codex", "openai-oauth", "openai", "anthropic", "claude-oauth", "xai"];
  if (provider === "ai_sdk_anthropic") return ["ai_sdk_anthropic", "anthropic", "openai", "xai", "claude-oauth", "openai-oauth"];
  if (provider === "litellm") return ["litellm", "openai", "anthropic", "xai", "claude-oauth", "openai-oauth"];
  if (provider === "anthropic") return ["anthropic", "openai", "xai", "claude-oauth", "openai-oauth"];
  if (provider === "xai") return ["xai", "openai", "anthropic", "claude-oauth", "openai-oauth"];
  return ["openai", "openai-oauth", "anthropic", "xai", "claude-oauth"];
}

export function normalizeOpenAiOAuthModel(model, fallback = "gpt-5.4") {
  const normalized = String(model || "").trim();
  return normalized || String(fallback || "gpt-5.4").trim() || "gpt-5.4";
}

export function normalizeDefaultModel(value, fallback) {
  const normalized = String(value || "").trim();
  if (normalized) return normalized.slice(0, 120);
  return String(fallback || "").trim().slice(0, 120);
}

export function inferProviderFromModel(model) {
  const normalized = String(model || "").trim().toLowerCase();
  if (!normalized) return "openai";
  if (normalized.startsWith("xai/")) return "xai";
  if (normalized.includes("grok")) return "xai";
  return "openai";
}

export function isXaiVideoDone(status, payload) {
  const normalizedStatus = String(status || "").trim().toLowerCase();
  if (XAI_VIDEO_DONE_STATUSES.has(normalizedStatus)) return true;
  return Boolean(extractXaiVideoUrl(payload));
}

export function extractXaiVideoUrl(payload) {
  const directUrl = String(payload?.video?.url || payload?.url || "").trim();
  if (directUrl) return directUrl;

  if (Array.isArray(payload?.videos)) {
    for (const item of payload.videos) {
      const url = String(item?.url || item?.video?.url || "").trim();
      if (url) return url;
    }
  }

  return "";
}
