import type OpenAI from "openai";
import { estimateUsdCost } from "../pricing.ts";
import { normalizeInlineText } from "./llmHelpers.ts";
import { getMemorySettings, getReplyGenerationSettings } from "../settings/agentStack.ts";
import type { LlmActionStore, LlmTrace } from "./serviceShared.ts";

const DEFAULT_MEMORY_EMBEDDING_MODEL = "text-embedding-3-small";

export type EmbeddingServiceDeps = {
  openai: OpenAI | null;
  store: LlmActionStore;
  defaultMemoryEmbeddingModel?: string | null;
};

export function isEmbeddingReady(deps: EmbeddingServiceDeps) {
  return Boolean(deps.openai);
}

export function resolveEmbeddingModel(
  deps: Pick<EmbeddingServiceDeps, "defaultMemoryEmbeddingModel">,
  settings: unknown
) {
  const fromSettings = String(getMemorySettings(settings).embeddingModel || "").trim();
  if (fromSettings) return fromSettings.slice(0, 120);
  const fromEnv = String(deps.defaultMemoryEmbeddingModel || "").trim();
  if (fromEnv) return fromEnv.slice(0, 120);
  return DEFAULT_MEMORY_EMBEDDING_MODEL;
}

export async function embedText(
  deps: EmbeddingServiceDeps,
  {
    settings,
    text,
    trace = { guildId: null, channelId: null, userId: null, source: null }
  }: {
    settings: unknown;
    text: unknown;
    trace?: LlmTrace;
  }
) {
  if (!deps.openai) {
    throw new Error("Embeddings require OPENAI_API_KEY.");
  }

  const input = normalizeInlineText(text, 8000);
  if (!input) {
    return {
      embedding: [],
      model: resolveEmbeddingModel(deps, settings),
      usage: { inputTokens: 0, outputTokens: 0 },
      costUsd: 0
    };
  }

  const model = resolveEmbeddingModel(deps, settings);
  try {
    const response = await deps.openai.embeddings.create({
      model,
      input
    });

    const embedding = Array.isArray(response?.data?.[0]?.embedding)
      ? response.data[0].embedding.map((value) => Number(value))
      : [];
    if (!embedding.length) {
      throw new Error("Embedding API returned no vector.");
    }

    const inputTokens = Number(response?.usage?.prompt_tokens || response?.usage?.total_tokens || 0);
    const costUsd = estimateUsdCost({
      provider: "openai",
      model,
      inputTokens,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      customPricing: getReplyGenerationSettings(settings).pricing
    });

    deps.store.logAction({
      kind: "memory_embedding_call",
      guildId: trace.guildId,
      channelId: trace.channelId,
      userId: trace.userId,
      content: model,
      metadata: {
        model,
        inputChars: input.length,
        vectorDims: embedding.length,
        usage: { inputTokens, outputTokens: 0 }
      },
      usdCost: costUsd
    });

    return {
      embedding,
      model,
      usage: { inputTokens, outputTokens: 0 },
      costUsd
    };
  } catch (error) {
    deps.store.logAction({
      kind: "memory_embedding_error",
      guildId: trace.guildId,
      channelId: trace.channelId,
      userId: trace.userId,
      content: String(error?.message || error),
      metadata: {
        model
      }
    });
    throw error;
  }
}
