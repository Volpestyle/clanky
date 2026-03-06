// Pricing tables are manually maintained in this file.
// Last updated: 2026-02-26.
const DEFAULT_PRICING = {
  openai: {
    "gpt-5.2": { inputPer1M: 1.75, cacheReadPer1M: 0.175, outputPer1M: 14.0 },
    "gpt-5.1": { inputPer1M: 1.25, cacheReadPer1M: 0.125, outputPer1M: 10.0 },
    "gpt-5.4": { inputPer1M: 1.25, cacheReadPer1M: 0.125, outputPer1M: 10.0 },
    "gpt-5": { inputPer1M: 1.25, cacheReadPer1M: 0.125, outputPer1M: 10.0 },
    "gpt-5-mini": { inputPer1M: 0.25, cacheReadPer1M: 0.025, outputPer1M: 2.0 },
    "gpt-5-nano": { inputPer1M: 0.05, cacheReadPer1M: 0.005, outputPer1M: 0.4 },
    "gpt-5.2-chat-latest": { inputPer1M: 1.75, cacheReadPer1M: 0.175, outputPer1M: 14.0 },
    "gpt-5.1-chat-latest": { inputPer1M: 1.25, cacheReadPer1M: 0.125, outputPer1M: 10.0 },
    "gpt-5-chat-latest": { inputPer1M: 1.25, cacheReadPer1M: 0.125, outputPer1M: 10.0 },
    "gpt-5.3-codex": { inputPer1M: 1.75, cacheReadPer1M: 0.175, outputPer1M: 14.0 },
    "gpt-5.2-codex": { inputPer1M: 1.75, cacheReadPer1M: 0.175, outputPer1M: 14.0 },
    "gpt-5.1-codex-max": { inputPer1M: 1.25, cacheReadPer1M: 0.125, outputPer1M: 10.0 },
    "gpt-5.1-codex": { inputPer1M: 1.25, cacheReadPer1M: 0.125, outputPer1M: 10.0 },
    "gpt-5-codex": { inputPer1M: 1.25, cacheReadPer1M: 0.125, outputPer1M: 10.0 },
    "gpt-5.1-codex-mini": { inputPer1M: 0.25, cacheReadPer1M: 0.025, outputPer1M: 2.0 },
    "codex-mini-latest": { inputPer1M: 1.5, cacheReadPer1M: 0.375, outputPer1M: 6.0 },
    "gpt-5.2-pro": { inputPer1M: 21.0, outputPer1M: 168.0 },
    "gpt-5-pro": { inputPer1M: 15.0, outputPer1M: 120.0 },
    "gpt-4.1": { inputPer1M: 2.0, cacheReadPer1M: 0.5, outputPer1M: 8.0 },
    "gpt-4.1-mini": { inputPer1M: 0.4, cacheReadPer1M: 0.1, outputPer1M: 1.6 },
    "gpt-4.1-nano": { inputPer1M: 0.1, cacheReadPer1M: 0.025, outputPer1M: 0.4 },
    "gpt-4o": { inputPer1M: 2.5, cacheReadPer1M: 1.25, outputPer1M: 10.0 },
    "gpt-4o-2024-05-13": { inputPer1M: 5.0, outputPer1M: 15.0 },
    "gpt-4o-mini": { inputPer1M: 0.15, cacheReadPer1M: 0.075, outputPer1M: 0.6 },
    "gpt-realtime": { inputPer1M: 4.0, cacheReadPer1M: 0.4, outputPer1M: 16.0 },
    "gpt-realtime-1.5": { inputPer1M: 4.0, cacheReadPer1M: 0.4, outputPer1M: 16.0 },
    "gpt-realtime-mini": { inputPer1M: 0.6, cacheReadPer1M: 0.06, outputPer1M: 2.4 },
    "gpt-4o-realtime-preview": { inputPer1M: 5.0, cacheReadPer1M: 2.5, outputPer1M: 20.0 },
    "gpt-4o-mini-realtime-preview": { inputPer1M: 0.6, cacheReadPer1M: 0.3, outputPer1M: 2.4 },
    "gpt-audio": { inputPer1M: 2.5, outputPer1M: 10.0 },
    "gpt-audio-1.5": { inputPer1M: 2.5, outputPer1M: 10.0 },
    "gpt-audio-mini": { inputPer1M: 0.6, outputPer1M: 2.4 },
    "gpt-4o-audio-preview": { inputPer1M: 2.5, outputPer1M: 10.0 },
    "gpt-4o-mini-audio-preview": { inputPer1M: 0.15, outputPer1M: 0.6 },
    "o1": { inputPer1M: 15.0, cacheReadPer1M: 7.5, outputPer1M: 60.0 },
    "o1-pro": { inputPer1M: 150.0, outputPer1M: 600.0 },
    "o3-pro": { inputPer1M: 20.0, outputPer1M: 80.0 },
    "o3": { inputPer1M: 2.0, cacheReadPer1M: 0.5, outputPer1M: 8.0 },
    "o3-deep-research": { inputPer1M: 10.0, cacheReadPer1M: 2.5, outputPer1M: 40.0 },
    "o4-mini": { inputPer1M: 1.1, cacheReadPer1M: 0.275, outputPer1M: 4.4 },
    "o4-mini-deep-research": { inputPer1M: 2.0, cacheReadPer1M: 0.5, outputPer1M: 8.0 },
    "o3-mini": { inputPer1M: 1.1, cacheReadPer1M: 0.55, outputPer1M: 4.4 },
    "o1-mini": { inputPer1M: 1.1, cacheReadPer1M: 0.55, outputPer1M: 4.4 },
    "gpt-5-search-api": { inputPer1M: 1.25, cacheReadPer1M: 0.125, outputPer1M: 10.0 },
    "gpt-4o-mini-search-preview": { inputPer1M: 0.15, outputPer1M: 0.6 },
    "gpt-4o-search-preview": { inputPer1M: 2.5, outputPer1M: 10.0 },
    "text-embedding-3-small": { inputPer1M: 0.02, outputPer1M: 0 },
    "text-embedding-3-large": { inputPer1M: 0.13, outputPer1M: 0 },
    "text-embedding-ada-002": { inputPer1M: 0.1, outputPer1M: 0 }
  },
  openaiImages: {
    "gpt-image-1.5": {
      "1024x1024": 0.04
    }
  },
  anthropic: {
    "claude-opus-4-6": {
      inputPer1M: 5.0,
      cacheWritePer1M: 6.25,
      cacheWrite1hPer1M: 10.0,
      cacheReadPer1M: 0.5,
      outputPer1M: 25.0
    },
    "claude-opus-4-5": {
      inputPer1M: 5.0,
      cacheWritePer1M: 6.25,
      cacheWrite1hPer1M: 10.0,
      cacheReadPer1M: 0.5,
      outputPer1M: 25.0
    },
    "claude-opus-4-1": {
      inputPer1M: 15.0,
      cacheWritePer1M: 18.75,
      cacheWrite1hPer1M: 30.0,
      cacheReadPer1M: 1.5,
      outputPer1M: 75.0
    },
    "claude-opus-4": {
      inputPer1M: 15.0,
      cacheWritePer1M: 18.75,
      cacheWrite1hPer1M: 30.0,
      cacheReadPer1M: 1.5,
      outputPer1M: 75.0
    },
    "claude-sonnet-4-6": {
      inputPer1M: 3.0,
      cacheWritePer1M: 3.75,
      cacheWrite1hPer1M: 6.0,
      cacheReadPer1M: 0.3,
      outputPer1M: 15.0
    },
    "claude-sonnet-4-5": {
      inputPer1M: 3.0,
      cacheWritePer1M: 3.75,
      cacheWrite1hPer1M: 6.0,
      cacheReadPer1M: 0.3,
      outputPer1M: 15.0
    },
    "claude-sonnet-4": {
      inputPer1M: 3.0,
      cacheWritePer1M: 3.75,
      cacheWrite1hPer1M: 6.0,
      cacheReadPer1M: 0.3,
      outputPer1M: 15.0
    },
    "claude-3-7-sonnet-latest": {
      inputPer1M: 3.0,
      cacheWritePer1M: 3.75,
      cacheWrite1hPer1M: 6.0,
      cacheReadPer1M: 0.3,
      outputPer1M: 15.0
    },
    "claude-haiku-4-5": {
      inputPer1M: 1.0,
      cacheWritePer1M: 1.25,
      cacheWrite1hPer1M: 2.0,
      cacheReadPer1M: 0.1,
      outputPer1M: 5.0
    },
    "claude-3-5-sonnet-latest": {
      inputPer1M: 3.0,
      cacheWritePer1M: 3.75,
      cacheWrite1hPer1M: 6.0,
      cacheReadPer1M: 0.3,
      outputPer1M: 15.0
    },
    "claude-opus-3": {
      inputPer1M: 15.0,
      cacheWritePer1M: 18.75,
      cacheWrite1hPer1M: 30.0,
      cacheReadPer1M: 1.5,
      outputPer1M: 75.0
    },
    "claude-haiku-3": {
      inputPer1M: 0.25,
      cacheWritePer1M: 0.3,
      cacheWrite1hPer1M: 0.5,
      cacheReadPer1M: 0.03,
      outputPer1M: 1.25
    }
  },
  xai: {
    "grok-4-latest": { inputPer1M: 3.0, outputPer1M: 15.0 },
    "grok-4-0709": { inputPer1M: 3.0, outputPer1M: 15.0 },
    "grok-4": { inputPer1M: 3.0, outputPer1M: 15.0 },
    "grok-4-fast-reasoning-latest": { inputPer1M: 0.2, outputPer1M: 0.5, cacheWritePer1M: 0.05 },
    "grok-4-fast-reasoning": { inputPer1M: 0.2, outputPer1M: 0.5, cacheWritePer1M: 0.05 },
    "grok-4-fast-reasoning:free": { inputPer1M: 0, outputPer1M: 0 },
    "grok-code-fast-1-latest": { inputPer1M: 0.2, outputPer1M: 1.5, cacheWritePer1M: 0.05 },
    "grok-code-fast-1": { inputPer1M: 0.2, outputPer1M: 1.5, cacheWritePer1M: 0.05 },
    "grok-code-fast-1:free": { inputPer1M: 0, outputPer1M: 0 },
    "grok-3-fast-latest": { inputPer1M: 5.0, outputPer1M: 25.0 },
    "grok-3-fast": { inputPer1M: 5.0, outputPer1M: 25.0 },
    "grok-3-fast-beta": { inputPer1M: 5.0, outputPer1M: 25.0 },
    "grok-3-latest": { inputPer1M: 3.0, outputPer1M: 15.0 },
    "grok-3": { inputPer1M: 3.0, outputPer1M: 15.0 },
    "grok-3-beta": { inputPer1M: 3.0, outputPer1M: 15.0 },
    "grok-3-mini-latest": { inputPer1M: 0.3, outputPer1M: 0.5 },
    "grok-3-mini": { inputPer1M: 0.3, outputPer1M: 0.5 },
    "grok-3-mini-beta": { inputPer1M: 0.3, outputPer1M: 0.5 },
    "grok-3-mini-fast-latest": { inputPer1M: 0.3, outputPer1M: 0.5 },
    "grok-3-mini-fast": { inputPer1M: 0.3, outputPer1M: 0.5 },
    "grok-3-mini-fast-beta": { inputPer1M: 0.3, outputPer1M: 0.5 },
    "grok-2-latest": { inputPer1M: 2.0, outputPer1M: 10.0 },
    "grok-2-1212": { inputPer1M: 2.0, outputPer1M: 10.0 },
    "grok-2": { inputPer1M: 2.0, outputPer1M: 10.0 },
    "grok-2-vision-latest": { inputPer1M: 2.0, outputPer1M: 10.0 },
    "grok-2-vision-1212": { inputPer1M: 2.0, outputPer1M: 10.0 },
    "grok-2-vision": { inputPer1M: 2.0, outputPer1M: 10.0 },
    "grok-beta": { inputPer1M: 5.0, outputPer1M: 15.0 },
    "grok-vision-beta": { inputPer1M: 5.0, outputPer1M: 15.0 }
  },
  "claude-code": {
    sonnet: { inputPer1M: 0, outputPer1M: 0 },
    haiku: { inputPer1M: 0, outputPer1M: 0 },
    opus: { inputPer1M: 0, outputPer1M: 0 }
  },
  xaiImages: {
    "grok-2-image-latest": { default: 0.07 },
    "grok-2-image-1212": { default: 0.07 },
    "grok-2-image": { default: 0.07 }
  }
};

const MODEL_ALIASES = {
  "claude opus 4.6": "claude-opus-4-6",
  "claude opus 4.5": "claude-opus-4-5",
  "claude opus 4.1": "claude-opus-4-1",
  "claude opus 4": "claude-opus-4",
  "claude sonnet 4.6": "claude-sonnet-4-6",
  "claude sonnet 4.5": "claude-sonnet-4-5",
  "claude sonnet 4": "claude-sonnet-4",
  "claude sonnet 3.7": "claude-3-7-sonnet-latest",
  "claude haiku 4.5": "claude-haiku-4-5",
  "claude opus 3": "claude-opus-3",
  "claude haiku 3": "claude-haiku-3",
  "grok 4": "grok-4-latest",
  "grok 4 fast reasoning": "grok-4-fast-reasoning-latest",
  "grok code fast 1": "grok-code-fast-1-latest",
  "grok 3": "grok-3-latest",
  "grok 3 fast": "grok-3-fast-latest",
    "grok 3 mini": "grok-3-mini-latest",
    "grok 3 mini fast": "grok-3-mini-fast-latest",
    "grok 2": "grok-2-latest",
    "grok 2 vision": "grok-2-vision-latest",
    "grok beta": "grok-beta",
    "gpt 5.4": "gpt-5.4",
    "grok vision beta": "grok-vision-beta"
  };
const LLM_PROVIDER_KEYS = ["openai", "anthropic", "xai", "claude-code"];
const NON_TEXT_MODEL_PATTERNS = [
  /embedding/i,
  /image/i,
  /video/i,
  /realtime/i,
  /audio/i,
  /(^|[-_])search([:_-]|$)/i
];

export function estimateUsdCost({
  provider,
  model,
  inputTokens,
  outputTokens,
  cacheWriteTokens,
  cacheReadTokens,
  customPricing = {}
}) {
  const merged = mergePricing(customPricing);
  const providerPricing = merged[provider] ?? {};
  const pricing = resolvePricing(providerPricing, model);
  if (!pricing) return 0;

  const inputCost = toCost(inputTokens, pricing.inputPer1M);
  const outputCost = toCost(outputTokens, pricing.outputPer1M);
  const cacheWriteRate = Number(pricing.cacheWritePer1M ?? pricing.inputPer1M ?? 0);
  const cacheReadRate = Number(pricing.cacheReadPer1M ?? 0);
  const cacheWriteCost = toCost(cacheWriteTokens, cacheWriteRate);
  const cacheReadCost = toCost(cacheReadTokens, cacheReadRate);
  return Number((inputCost + outputCost + cacheWriteCost + cacheReadCost).toFixed(6));
}

export function estimateImageUsdCost({
  provider,
  model,
  size = "1024x1024",
  imageCount = 1,
  customPricing = {}
}) {
  const imageProviderKey = resolveImageProvider(provider);
  if (!imageProviderKey) return 0;

  const merged = mergePricing(customPricing);
  const resolvedModel = resolveImageModelPricing(merged[imageProviderKey] ?? {}, model);
  if (!resolvedModel) return 0;

  const normalizedSize = normalizeImageSize(size);
  const perImage = Number(resolvedModel[normalizedSize] ?? resolvedModel.default ?? 0);
  if (!perImage) return 0;

  const count = Math.max(1, Math.floor(Number(imageCount) || 1));
  return Number((perImage * count).toFixed(6));
}

export function getLlmModelCatalog(customPricing = {}) {
  const merged = mergePricing(customPricing);
  return {
    openai: listLlmModelsForProvider(merged.openai, "openai"),
    anthropic: listLlmModelsForProvider(merged.anthropic, "anthropic"),
    xai: listLlmModelsForProvider(merged.xai, "xai"),
    "claude-code": listLlmModelsForProvider(merged["claude-code"], "claude-code")
  };
}

function mergePricing(customPricing) {
  const custom = customPricing && typeof customPricing === "object" ? customPricing : {};
  return {
    openai: {
      ...DEFAULT_PRICING.openai,
      ...(custom.openai && typeof custom.openai === "object" ? custom.openai : {})
    },
    openaiImages: {
      ...DEFAULT_PRICING.openaiImages,
      ...(custom.openaiImages && typeof custom.openaiImages === "object" ? custom.openaiImages : {})
    },
    anthropic: {
      ...DEFAULT_PRICING.anthropic,
      ...(custom.anthropic && typeof custom.anthropic === "object" ? custom.anthropic : {})
    },
    xai: {
      ...DEFAULT_PRICING.xai,
      ...(custom.xai && typeof custom.xai === "object" ? custom.xai : {})
    },
    xaiImages: {
      ...DEFAULT_PRICING.xaiImages,
      ...(custom.xaiImages && typeof custom.xaiImages === "object" ? custom.xaiImages : {})
    },
    "claude-code": {
      ...DEFAULT_PRICING["claude-code"],
      ...(custom["claude-code"] && typeof custom["claude-code"] === "object" ? custom["claude-code"] : {})
    }
  };
}

function resolvePricing(providerPricing, model) {
  const exact = providerPricing[model];
  if (exact) return exact;

  const normalized = normalizeModelKey(model);
  if (!normalized) return null;

  const alias = MODEL_ALIASES[normalized];
  if (alias && providerPricing[alias]) return providerPricing[alias];
  return providerPricing[normalized] ?? null;
}

function resolveImageModelPricing(providerPricing, model) {
  const exact = providerPricing[model];
  if (exact && typeof exact === "object") return exact;

  const normalized = normalizeModelKey(model);
  if (!normalized) return null;

  return providerPricing[normalized] ?? null;
}

function normalizeModelKey(model) {
  return String(model || "")
    .trim()
    .toLowerCase()
    .replace(/^anthropic:/, "")
    .replace(/^xai:/, "")
    .replace(/\s*\(deprecated\)\s*/g, "")
    .replace(/\s+/g, " ");
}

function resolveImageProvider(provider) {
  if (provider === "openai") return "openaiImages";
  if (provider === "xai") return "xaiImages";
  return null;
}

function toCost(tokens, per1M) {
  return ((Number(tokens) || 0) / 1_000_000) * (Number(per1M) || 0);
}

function normalizeImageSize(size) {
  return String(size || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

function listLlmModelsForProvider(providerPricing, provider) {
  if (!providerPricing || typeof providerPricing !== "object") return [];
  if (!LLM_PROVIDER_KEYS.includes(provider)) return [];

  return Object.keys(providerPricing).filter((model) => isTextLlmModel(model, provider));
}

function isTextLlmModel(model, provider) {
  const normalized = String(model || "").trim().toLowerCase();
  if (!normalized) return false;
  if (NON_TEXT_MODEL_PATTERNS.some((pattern) => pattern.test(normalized))) return false;
  return true;
}
