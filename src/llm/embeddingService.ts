import type OpenAI from "openai";
import { estimateUsdCost } from "./pricing.ts";
import { normalizeInlineText } from "./llmHelpers.ts";
import { getMemorySettings, getReplyGenerationSettings } from "../settings/agentStack.ts";
import type { LlmActionStore, LlmTrace } from "./serviceShared.ts";

const DEFAULT_MEMORY_EMBEDDING_MODEL = "text-embedding-3-small";
const DEFAULT_OLLAMA_EMBEDDING_MODEL = "nomic-embed-text";
const OLLAMA_DEFAULT_BASE_URL = "http://127.0.0.1:11434";

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

export type EmbeddingProviderResult = {
  embedding: number[];
  model: string;
  inputTokens: number;
};

export type EmbeddingProvider = {
  name: string;
  isReady(): boolean;
  defaultModel(): string;
  embed(args: { model: string; input: string }): Promise<EmbeddingProviderResult>;
};

// ---------------------------------------------------------------------------
// OpenAI provider
// ---------------------------------------------------------------------------

export function createOpenAiEmbeddingProvider(openai: OpenAI | null): EmbeddingProvider {
  return {
    name: "openai",
    isReady() {
      return Boolean(openai);
    },
    defaultModel() {
      return DEFAULT_MEMORY_EMBEDDING_MODEL;
    },
    async embed({ model, input }) {
      if (!openai) throw new Error("OpenAI client not available for embeddings.");
      const response = await openai.embeddings.create({ model, input });
      const embedding = Array.isArray(response?.data?.[0]?.embedding)
        ? response.data[0].embedding.map((value) => Number(value))
        : [];
      if (!embedding.length) throw new Error("OpenAI embedding API returned no vector.");
      const inputTokens = Number(response?.usage?.prompt_tokens || response?.usage?.total_tokens || 0);
      return { embedding, model, inputTokens };
    }
  };
}

// ---------------------------------------------------------------------------
// Ollama provider (local, no API key needed)
// ---------------------------------------------------------------------------

export function createOllamaEmbeddingProvider(baseUrl?: string | null): EmbeddingProvider {
  const normalizedBaseUrl = String(baseUrl || OLLAMA_DEFAULT_BASE_URL).replace(/\/+$/, "");
  let lastHealthy = false;

  return {
    name: "ollama",
    isReady() {
      // Optimistic: assume ready and let embed() fail gracefully.
      // Cache last known state to avoid blocking callers.
      return lastHealthy;
    },
    defaultModel() {
      return DEFAULT_OLLAMA_EMBEDDING_MODEL;
    },
    async embed({ model, input }) {
      const url = `${normalizedBaseUrl}/api/embed`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, input }),
        signal: AbortSignal.timeout(15_000)
      });
      if (!response.ok) {
        lastHealthy = false;
        throw new Error(`Ollama embedding failed: ${response.status} ${response.statusText}`);
      }
      const body = await response.json();
      // Ollama returns { embeddings: [[...]] } for the /api/embed endpoint.
      const embeddings = Array.isArray(body?.embeddings) ? body.embeddings : [];
      const embedding = Array.isArray(embeddings[0])
        ? embeddings[0].map((value: unknown) => Number(value))
        : [];
      if (!embedding.length) {
        lastHealthy = false;
        throw new Error("Ollama embedding API returned no vector.");
      }
      lastHealthy = true;
      const inputTokens = Number(body?.prompt_eval_count || 0);
      return { embedding, model, inputTokens };
    }
  };
}

// ---------------------------------------------------------------------------
// Provider health check (async, updates isReady state for Ollama)
// ---------------------------------------------------------------------------

export async function probeOllamaHealth(provider: EmbeddingProvider): Promise<boolean> {
  if (provider.name !== "ollama") return provider.isReady();
  try {
    await provider.embed({ model: provider.defaultModel(), input: "health check" });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Deps, resolution, and embedding entry points (existing API surface)
// ---------------------------------------------------------------------------

function buildEmbeddingTraceMetadata(trace: LlmTrace | null | undefined) {
  const traceSource = normalizeInlineText(trace?.source, 120);
  const traceEvent = normalizeInlineText(trace?.event, 120);
  const traceReason = normalizeInlineText(trace?.reason, 120);
  const traceMessageId = normalizeInlineText(trace?.messageId, 160);
  return {
    traceSource: traceSource || null,
    traceEvent: traceEvent || null,
    traceReason: traceReason || null,
    traceMessageId: traceMessageId || null
  };
}

export type EmbeddingServiceDeps = {
  /** @deprecated — retained for backward compat; prefer `providers`. */
  openai?: OpenAI | null;
  store: LlmActionStore;
  defaultMemoryEmbeddingModel?: string | null;
  providers?: EmbeddingProvider[];
};

function resolveProviderChain(deps: EmbeddingServiceDeps): EmbeddingProvider[] {
  if (Array.isArray(deps.providers) && deps.providers.length) return deps.providers;
  // Legacy path: wrap the raw OpenAI client.
  if (deps.openai) return [createOpenAiEmbeddingProvider(deps.openai)];
  return [];
}

export function isEmbeddingReady(deps: EmbeddingServiceDeps) {
  const chain = resolveProviderChain(deps);
  return chain.some((provider) => provider.isReady());
}

export function resolveEmbeddingModel(
  deps: Pick<EmbeddingServiceDeps, "defaultMemoryEmbeddingModel" | "providers">,
  settings: unknown
) {
  const fromSettings = String(getMemorySettings(settings).embeddingModel || "").trim();
  if (fromSettings) return fromSettings.slice(0, 120);
  const fromEnv = String(deps.defaultMemoryEmbeddingModel || "").trim();
  if (fromEnv) return fromEnv.slice(0, 120);
  // Use the first ready provider's default model.
  const providers = Array.isArray(deps.providers) ? deps.providers : [];
  for (const provider of providers) {
    if (provider.isReady()) return provider.defaultModel();
  }
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
  const chain = resolveProviderChain(deps);
  if (!chain.length) {
    throw new Error("No embedding providers available. Configure OPENAI_API_KEY or a local Ollama instance.");
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
  let lastError: Error | null = null;

  for (const provider of chain) {
    if (!provider.isReady()) continue;
    try {
      const result = await provider.embed({ model, input });
      const costUsd = estimateUsdCost({
        provider: provider.name,
        model: result.model,
        inputTokens: result.inputTokens,
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
        content: result.model,
        metadata: {
          provider: provider.name,
          model: result.model,
          inputChars: input.length,
          vectorDims: result.embedding.length,
          usage: { inputTokens: result.inputTokens, outputTokens: 0 },
          ...buildEmbeddingTraceMetadata(trace)
        },
        usdCost: costUsd
      });

      return {
        embedding: result.embedding,
        model: result.model,
        usage: { inputTokens: result.inputTokens, outputTokens: 0 },
        costUsd
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      deps.store.logAction({
        kind: "memory_embedding_error",
        guildId: trace.guildId,
        channelId: trace.channelId,
        userId: trace.userId,
        content: `[${provider.name}] ${String(lastError.message || lastError)}`,
        metadata: {
          provider: provider.name,
          model,
          fallbackAttempt: true,
          ...buildEmbeddingTraceMetadata(trace)
        }
      });
      // Try next provider in the chain.
      continue;
    }
  }

  // All providers failed — try any non-ready providers as a last resort.
  for (const provider of chain) {
    if (provider.isReady()) continue;
    try {
      const result = await provider.embed({ model, input });
      const costUsd = estimateUsdCost({
        provider: provider.name,
        model: result.model,
        inputTokens: result.inputTokens,
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
        content: result.model,
        metadata: {
          provider: provider.name,
          model: result.model,
          inputChars: input.length,
          vectorDims: result.embedding.length,
          usage: { inputTokens: result.inputTokens, outputTokens: 0 },
          lastResortFallback: true,
          ...buildEmbeddingTraceMetadata(trace)
        },
        usdCost: costUsd
      });
      return {
        embedding: result.embedding,
        model: result.model,
        usage: { inputTokens: result.inputTokens, outputTokens: 0 },
        costUsd
      };
    } catch {
      // Swallow — we'll throw the original error below.
    }
  }

  // Total failure — rethrow last error so callers degrade to FTS-only.
  throw lastError || new Error("All embedding providers failed.");
}
