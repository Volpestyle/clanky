import { test, expect } from "bun:test";
import {
  createOpenAiEmbeddingProvider,
  createOllamaEmbeddingProvider,
  isEmbeddingReady,
  resolveEmbeddingModel,
  embedText,
  type EmbeddingProvider,
  type EmbeddingServiceDeps
} from "./embeddingService.ts";

function createMockProvider(overrides: Partial<EmbeddingProvider> = {}): EmbeddingProvider {
  return {
    name: overrides.name || "mock",
    isReady: overrides.isReady || (() => true),
    defaultModel: overrides.defaultModel || (() => "mock-model"),
    embed: overrides.embed || (async ({ model, input }) => ({
      embedding: [0.1, 0.2, 0.3],
      model,
      inputTokens: input.length
    }))
  };
}

function createMockStore() {
  const actions: Array<Record<string, unknown>> = [];
  return {
    actions,
    logAction(payload: Record<string, unknown>) {
      actions.push(payload);
    }
  };
}

test("isEmbeddingReady returns true when at least one provider is ready", () => {
  const readyProvider = createMockProvider({ isReady: () => true });
  const notReadyProvider = createMockProvider({ name: "down", isReady: () => false });
  expect(isEmbeddingReady({ store: createMockStore(), providers: [notReadyProvider, readyProvider] })).toBe(true);
});

test("isEmbeddingReady returns false when no providers are ready", () => {
  const notReady = createMockProvider({ isReady: () => false });
  expect(isEmbeddingReady({ store: createMockStore(), providers: [notReady] })).toBe(false);
});

test("isEmbeddingReady legacy path uses openai presence", () => {
  expect(isEmbeddingReady({ store: createMockStore(), openai: {} as never })).toBe(true);
  expect(isEmbeddingReady({ store: createMockStore(), openai: null })).toBe(false);
});

test("resolveEmbeddingModel uses settings over provider default", () => {
  const provider = createMockProvider({ defaultModel: () => "provider-default" });
  const model = resolveEmbeddingModel(
    { providers: [provider] },
    { memory: { embeddingModel: "settings-model" } }
  );
  expect(model).toBe("settings-model");
});

test("resolveEmbeddingModel falls back to first ready provider's default when settings and env are empty", () => {
  const notReady = createMockProvider({ name: "down", isReady: () => false, defaultModel: () => "down-model" });
  const ready = createMockProvider({ isReady: () => true, defaultModel: () => "ready-model" });
  // Pass empty string for both settings and env so provider default is used.
  const model = resolveEmbeddingModel(
    { providers: [notReady, ready], defaultMemoryEmbeddingModel: "" },
    { memory: { embeddingModel: "" } }
  );
  expect(model).toBe("ready-model");
});

test("embedText uses first ready provider and logs success", async () => {
  const store = createMockStore();
  const primary = createMockProvider({
    name: "primary",
    embed: async ({ model }) => ({ embedding: [1, 2, 3], model, inputTokens: 5 })
  });
  const fallback = createMockProvider({
    name: "fallback",
    embed: async () => { throw new Error("should not be called"); }
  });

  const result = await embedText(
    { store, providers: [primary, fallback] },
    { settings: { memory: { embeddingModel: "test-model" } }, text: "hello world" }
  );

  expect(result.embedding).toEqual([1, 2, 3]);
  expect(result.model).toBe("test-model");
  expect(store.actions.some((action) => action.kind === "memory_embedding_call" && action.metadata?.provider === "primary")).toBe(true);
});

test("embedText falls back to next provider on failure", async () => {
  const store = createMockStore();
  const primary = createMockProvider({
    name: "primary",
    embed: async () => { throw new Error("primary down"); }
  });
  const fallback = createMockProvider({
    name: "fallback",
    embed: async ({ model }) => ({ embedding: [4, 5, 6], model, inputTokens: 3 })
  });

  const result = await embedText(
    { store, providers: [primary, fallback] },
    { settings: {}, text: "hello world" }
  );

  expect(result.embedding).toEqual([4, 5, 6]);
  expect(store.actions.some((action) => action.kind === "memory_embedding_error" && action.metadata?.provider === "primary")).toBe(true);
  expect(store.actions.some((action) => action.kind === "memory_embedding_call" && action.metadata?.provider === "fallback")).toBe(true);
});

test("embedText throws when all providers fail", async () => {
  const store = createMockStore();
  const failing = createMockProvider({
    name: "failing",
    embed: async () => { throw new Error("all down"); }
  });

  await expect(
    embedText(
      { store, providers: [failing] },
      { settings: {}, text: "hello" }
    )
  ).rejects.toThrow("all down");
});

test("embedText returns empty embedding for empty input", async () => {
  const store = createMockStore();
  const provider = createMockProvider();
  const result = await embedText(
    { store, providers: [provider] },
    { settings: {}, text: "" }
  );
  expect(result.embedding).toEqual([]);
});

test("embedText tries non-ready providers as last resort", async () => {
  const store = createMockStore();
  const readyButFailing = createMockProvider({
    name: "primary",
    isReady: () => true,
    embed: async () => { throw new Error("primary down"); }
  });
  const notReadyButWorks = createMockProvider({
    name: "ollama",
    isReady: () => false,
    embed: async ({ model }) => ({ embedding: [7, 8, 9], model, inputTokens: 2 })
  });

  const result = await embedText(
    { store, providers: [readyButFailing, notReadyButWorks] },
    { settings: {}, text: "try fallback" }
  );

  expect(result.embedding).toEqual([7, 8, 9]);
  expect(store.actions.some((action) => action.metadata?.lastResortFallback === true)).toBe(true);
});

test("createOpenAiEmbeddingProvider is not ready without client", () => {
  const provider = createOpenAiEmbeddingProvider(null);
  expect(provider.isReady()).toBe(false);
  expect(provider.name).toBe("openai");
  expect(provider.defaultModel()).toBe("text-embedding-3-small");
});

test("createOllamaEmbeddingProvider has correct defaults", () => {
  const provider = createOllamaEmbeddingProvider(null);
  expect(provider.name).toBe("ollama");
  expect(provider.defaultModel()).toBe("nomic-embed-text");
});
