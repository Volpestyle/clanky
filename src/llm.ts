import { spawnSync } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { estimateUsdCost } from "./llm/pricing.ts";
import {
  isAsrReady as isAsrReadyRequest,
  isSpeechSynthesisReady as isSpeechSynthesisReadyRequest,
  synthesizeSpeech as synthesizeSpeechRequest,
  transcribeAudio as transcribeAudioRequest,
  type AudioServiceDeps
} from "./llm/audioService.ts";
import {
  callAnthropic as callAnthropicRequest,
  callAnthropicStreaming as callAnthropicStreamingRequest,
  callOpenAI as callOpenAIRequest,
  callOpenAiResponses as callOpenAiResponsesRequest,
  callOpenAiResponsesStreaming as callOpenAiResponsesStreamingRequest,
  callXai as callXaiRequest,
  callXaiChatCompletions as callXaiChatCompletionsRequest,
  type ChatGenerationDeps
} from "./llm/chatGeneration.ts";
import {
  callCodexCli as callCodexCliRequest,
  closeCodexCliSession,
  runCodexCliBrainStream as runCodexCliBrainStreamRequest,
  type CodexCliServiceDeps
} from "./llm/codexCliService.ts";
import {
  isClaudeOAuthConfigured,
  createClaudeOAuthClient,
  type ClaudeOAuthState
} from "./llm/claudeOAuth.ts";
import {
  isCodexOAuthConfigured,
  createCodexOAuthClient,
  type CodexOAuthState
} from "./llm/codexOAuth.ts";
import {
  embedText as embedTextRequest,
  isEmbeddingReady as isEmbeddingReadyRequest,
  resolveEmbeddingModel as resolveEmbeddingModelRequest,
  createOpenAiEmbeddingProvider,
  createOllamaEmbeddingProvider,
  type EmbeddingServiceDeps,
  type EmbeddingProvider
} from "./llm/embeddingService.ts";
import {
  fetchXaiJson as fetchXaiJsonRequest,
  generateImage as generateImageRequest,
  generateVideo as generateVideoRequest,
  getMediaGenerationCapabilities as getMediaGenerationCapabilitiesRequest,
  isImageGenerationReady as isImageGenerationReadyRequest,
  isVideoGenerationReady as isVideoGenerationReadyRequest,
  resolveImageGenerationTarget as resolveImageGenerationTargetRequest,
  resolveVideoGenerationTarget as resolveVideoGenerationTargetRequest,
  type MediaGenerationDeps
} from "./llm/mediaGeneration.ts";
import {
  type ChatModelResponse,
  type ChatModelRequest,
  type ChatModelStreamCallbacks,
  type ContextMessage,
  type ImageInput,
  type LLMAppConfig,
  type LlmActionStore,
  type LlmTrace,
  type XaiJsonRequestOptions,
  XAI_REQUEST_TIMEOUT_MS
} from "./llm/serviceShared.ts";
import {
  chatWithTools as chatWithToolsRequest,
  type ToolLoopChatDeps
} from "./llm/toolLoopChat.ts";
import {
  normalizeOpenAiOAuthModel,
  normalizeDefaultModel,
  normalizeLlmProvider,
  normalizeXaiBaseUrl,
  resolveProviderFallbackOrder
} from "./llm/llmHelpers.ts";
import {
  getReplyGenerationSettings,
  getResolvedOrchestratorBinding
} from "./settings/agentStack.ts";
import type { CodexCliStreamSessionLike } from "./llm/llmCodexCli.ts";

export {
  type ToolLoopContentBlock,
  type ToolLoopMessage
} from "./llm/serviceShared.ts";

function summarizeToolCallNames(toolCalls: Array<{ name?: string | null }> = []) {
  const names = toolCalls
    .map((toolCall) => String(toolCall?.name || "").trim())
    .filter(Boolean)
    .slice(0, 8);
  return names.length > 0 ? names.join(", ") : null;
}

export class LLMService {
  appConfig: LLMAppConfig;
  store: LlmActionStore;
  openai: OpenAI | null;
  xai: OpenAI | null;
  anthropic: Anthropic | null;
  claudeOAuth: ClaudeOAuthState | null;
  codexOAuth: CodexOAuthState | null;
  codexCliAvailable: boolean;
  codexCliBrainSession: CodexCliStreamSessionLike | null;
  codexCliBrainModel: string;

  constructor({ appConfig, store }: { appConfig: LLMAppConfig; store: LlmActionStore }) {
    this.appConfig = appConfig;
    this.store = store;

    this.openai = appConfig.openaiApiKey ? new OpenAI({ apiKey: appConfig.openaiApiKey }) : null;
    this.xai = appConfig.xaiApiKey
      ? new OpenAI({
          apiKey: appConfig.xaiApiKey,
          baseURL: normalizeXaiBaseUrl(appConfig.xaiBaseUrl)
        })
      : null;
    this.anthropic = appConfig.anthropicApiKey
      ? new Anthropic({ apiKey: appConfig.anthropicApiKey })
      : null;

    this.claudeOAuth = null;
    if (isClaudeOAuthConfigured(appConfig.claudeOAuthRefreshToken || "")) {
      try {
        this.claudeOAuth = createClaudeOAuthClient(appConfig.claudeOAuthRefreshToken || "");
      } catch (error) {
        this.store.logAction({kind: "llm_lifecycle", content: "claude_oauth_init_failed", metadata: { error: String(error?.message || error) }});
      }
    }

    this.codexOAuth = null;
    if (isCodexOAuthConfigured(appConfig.openaiOAuthRefreshToken || "")) {
      try {
        this.codexOAuth = createCodexOAuthClient(appConfig.openaiOAuthRefreshToken || "");
      } catch (error) {
        this.store.logAction({kind: "llm_lifecycle", content: "openai_oauth_init_failed", metadata: { error: String(error?.message || error) }});
      }
    }

    this.codexCliAvailable = false;
    try {
      const result = spawnSync("codex", ["--version"], { encoding: "utf8", timeout: 5000 });
      const versionOutput = String(result?.stdout || result?.stderr || "").trim();
      this.codexCliAvailable = result?.status === 0 && Boolean(versionOutput);
    } catch {
      this.codexCliAvailable = false;
    }
    this.codexCliBrainSession = null;
    this.codexCliBrainModel = "";
  }

  /**
   * Re-check the filesystem for OAuth tokens and reinitialize clients that
   * were previously null. Called after the dashboard OAuth flow saves new tokens.
   */
  async reloadOAuthProviders(): Promise<{ claudeOAuth: boolean; codexOAuth: boolean }> {
    let claudeOAuthReloaded = false;
    let codexOAuthReloaded = false;

    if (!this.claudeOAuth && isClaudeOAuthConfigured(this.appConfig.claudeOAuthRefreshToken || "")) {
      try {
        this.claudeOAuth = createClaudeOAuthClient(this.appConfig.claudeOAuthRefreshToken || "");
        await this.claudeOAuth.warmup();
        claudeOAuthReloaded = true;
        this.store.logAction({ kind: "llm_lifecycle", content: "claude_oauth_hot_reload", metadata: { source: "dashboard" } });
      } catch (error) {
        this.store.logAction({ kind: "llm_lifecycle", content: "claude_oauth_hot_reload_failed", metadata: { error: String(error?.message || error) } });
      }
    }

    if (!this.codexOAuth && isCodexOAuthConfigured(this.appConfig.openaiOAuthRefreshToken || "")) {
      try {
        this.codexOAuth = createCodexOAuthClient(this.appConfig.openaiOAuthRefreshToken || "");
        await this.codexOAuth.warmup();
        codexOAuthReloaded = true;
        this.store.logAction({ kind: "llm_lifecycle", content: "openai_oauth_hot_reload", metadata: { source: "dashboard" } });
      } catch (error) {
        this.store.logAction({ kind: "llm_lifecycle", content: "openai_oauth_hot_reload_failed", metadata: { error: String(error?.message || error) } });
      }
    }

    return { claudeOAuth: claudeOAuthReloaded, codexOAuth: codexOAuthReloaded };
  }

  async warmup(): Promise<void> {
    if (this.claudeOAuth) {
      const startedAt = Date.now();
      try {
        await this.claudeOAuth.warmup();
        this.store.logAction({kind: "llm_lifecycle", content: "claude_oauth_warmup_completed", metadata: { durationMs: Date.now() - startedAt }});
      } catch (error) {
        this.store.logAction({kind: "llm_lifecycle", content: "claude_oauth_warmup_failed", metadata: { durationMs: Date.now() - startedAt, error: String(error?.message || error) }});
      }
    }

    if (this.codexOAuth) {
      const startedAt = Date.now();
      try {
        await this.codexOAuth.warmup();
        this.store.logAction({kind: "llm_lifecycle", content: "openai_oauth_warmup_completed", metadata: { durationMs: Date.now() - startedAt }});
      } catch (error) {
        this.store.logAction({kind: "llm_lifecycle", content: "openai_oauth_warmup_failed", metadata: { durationMs: Date.now() - startedAt, error: String(error?.message || error) }});
      }
    }

    // Log provider readiness summary so operators can diagnose missing providers at startup.
    const allProviders = ["anthropic", "claude-oauth", "openai", "openai-oauth", "xai"] as const;
    const available = allProviders.filter((p) => this.isProviderConfigured(p));
    const unavailable = allProviders.filter((p) => !this.isProviderConfigured(p));
    this.store.logAction({
      kind: "llm_lifecycle",
      content: "provider_readiness_summary",
      metadata: { available, unavailable }
    });

    // Probe Ollama health so its isReady() returns true if reachable.
    const chain = this.buildEmbeddingProviderChain();
    const ollamaProvider = chain.find((provider) => provider.name === "ollama");
    if (ollamaProvider) {
      const { probeOllamaHealth } = await import("./llm/embeddingService.ts");
      const healthy = await probeOllamaHealth(ollamaProvider);
      const readyProviders = chain.filter((provider) => provider.isReady()).map((provider) => provider.name);
      this.store.logAction({
        kind: "llm_lifecycle",
        content: "embedding_provider_chain_ready",
        metadata: {
          providers: chain.map((provider) => provider.name),
          readyProviders,
          ollamaHealthy: healthy
        }
      });
    }
  }

  private chatDeps(provider?: string): ChatGenerationDeps {
    return {
      openai: provider === "openai-oauth"
        ? this.codexOAuth?.client ?? null
        : this.openai,
      xai: this.xai,
      anthropic: provider === "claude-oauth" && this.claudeOAuth
        ? this.claudeOAuth.client
        : this.anthropic
    };
  }

  private mediaDeps(): MediaGenerationDeps {
    return {
      openai: this.openai,
      xai: this.xai,
      appConfig: this.appConfig,
      store: this.store
    };
  }

  private embeddingDeps(): EmbeddingServiceDeps {
    return {
      openai: this.openai,
      store: this.store,
      defaultMemoryEmbeddingModel: this.appConfig.defaultMemoryEmbeddingModel,
      providers: this.buildEmbeddingProviderChain()
    };
  }

  private embeddingProviderChainCache: EmbeddingProvider[] | null = null;

  private buildEmbeddingProviderChain(): EmbeddingProvider[] {
    if (this.embeddingProviderChainCache) return this.embeddingProviderChainCache;
    const chain: EmbeddingProvider[] = [];
    // Primary: OpenAI (requires API key).
    if (this.openai) {
      chain.push(createOpenAiEmbeddingProvider(this.openai));
    }
    // Fallback: local Ollama (no API key needed; health-probed on startup).
    const ollamaBaseUrl = String(this.appConfig.ollamaBaseUrl || "").trim() || null;
    chain.push(createOllamaEmbeddingProvider(ollamaBaseUrl));
    this.embeddingProviderChainCache = chain;
    return chain;
  }

  private audioDeps(): AudioServiceDeps {
    return {
      openai: this.openai,
      elevenLabsApiKey: this.appConfig.elevenLabsApiKey,
      store: this.store
    };
  }

  private codexCliDeps(): CodexCliServiceDeps {
    return {
      codexCliAvailable: this.codexCliAvailable,
      getBrainSession: () => this.codexCliBrainSession,
      setBrainSession: (session) => {
        this.codexCliBrainSession = session;
      },
      getBrainModel: () => this.codexCliBrainModel,
      setBrainModel: (model) => {
        this.codexCliBrainModel = model;
      }
    };
  }

  private toolLoopDeps(): ToolLoopChatDeps {
    return {
      openai: this.openai,
      xai: this.xai,
      anthropic: this.anthropic,
      claudeOAuthClient: this.claudeOAuth?.client ?? null,
      codexOAuthClient: this.codexOAuth?.client ?? null,
      store: this.store
    };
  }

  getCodexCompatibleClient() {
    return this.openai || this.codexOAuth?.client || null;
  }

  getComputerUseClient(preferredClient: unknown = "auto") {
    const normalized = String(preferredClient || "auto").trim().toLowerCase();
    if (normalized === "openai") {
      return {
        client: this.openai,
        provider: this.openai ? "openai" : null
      } as const;
    }
    if (normalized === "openai-oauth") {
      return {
        client: this.codexOAuth?.client ?? null,
        provider: this.codexOAuth?.client ? "openai-oauth" : null
      } as const;
    }
    if (this.openai) {
      return {
        client: this.openai,
        provider: "openai"
      } as const;
    }
    if (this.codexOAuth?.client) {
      return {
        client: this.codexOAuth.client,
        provider: "openai-oauth"
      } as const;
    }
    return {
      client: null,
      provider: null
    } as const;
  }

  async generate({
    settings,
    systemPrompt,
    userPrompt,
    imageInputs = [],
    contextMessages = [],
    trace = {
      guildId: null,
      channelId: null,
      userId: null,
      source: null,
      event: null,
      reason: null,
      messageId: null,
      sessionId: null
    },
    jsonSchema = "",
    tools = [],
    thinking,
    thinkingBudgetTokens,
    signal
  }: {
    settings: unknown;
    systemPrompt: string;
    userPrompt: string;
    imageInputs?: ImageInput[];
    contextMessages?: ContextMessage[];
    trace?: {
      guildId?: unknown;
      channelId?: unknown;
      userId?: unknown;
      source?: unknown;
      event?: unknown;
      reason?: unknown;
      messageId?: unknown;
      sessionId?: unknown;
    };
    jsonSchema?: string;
    tools?: ChatModelRequest["tools"];
    thinking?: ChatModelRequest["thinking"];
    thinkingBudgetTokens?: number;
    signal?: AbortSignal;
  }) {
    return await this.generateStreaming({
      settings,
      systemPrompt,
      userPrompt,
      imageInputs,
      contextMessages,
      trace,
      jsonSchema,
      tools,
      thinking,
      thinkingBudgetTokens,
      signal,
      onTextDelta() {}
    });
  }

  async generateStreaming({
    settings,
    systemPrompt,
    userPrompt,
    imageInputs = [],
    contextMessages = [],
    trace = {
      guildId: null,
      channelId: null,
      userId: null,
      source: null,
      event: null,
      reason: null,
      messageId: null,
      sessionId: null
    },
    jsonSchema = "",
    tools = [],
    thinking,
    thinkingBudgetTokens,
    signal,
    onTextDelta
  }: {
    settings: unknown;
    systemPrompt: string;
    userPrompt: string;
    imageInputs?: ImageInput[];
    contextMessages?: ContextMessage[];
    trace?: {
      guildId?: unknown;
      channelId?: unknown;
      userId?: unknown;
      source?: unknown;
      event?: unknown;
      reason?: unknown;
      messageId?: unknown;
      sessionId?: unknown;
    };
    jsonSchema?: string;
    tools?: ChatModelRequest["tools"];
    thinking?: ChatModelRequest["thinking"];
    thinkingBudgetTokens?: number;
    signal?: AbortSignal;
    onTextDelta: (delta: string) => void;
  }) {
    const orchestrator = getResolvedOrchestratorBinding(settings);
    const replyGeneration = getReplyGenerationSettings(settings);
    const { provider, model } = this.resolveProviderAndModel(orchestrator);
    const temperature = Number(orchestrator.temperature) || 0.9;
    const maxOutputTokens = Number(orchestrator.maxOutputTokens) || 800;
    const normalizedJsonSchema = String(jsonSchema || "").trim();
    const normalizedTools = Array.isArray(tools) ? tools : [];
    const normalizedTrace: LlmTrace = {
      guildId: trace.guildId == null ? null : String(trace.guildId),
      channelId: trace.channelId == null ? null : String(trace.channelId),
      userId: trace.userId == null ? null : String(trace.userId),
      source: trace.source == null ? null : String(trace.source),
      event: trace.event == null ? null : String(trace.event),
      reason: trace.reason == null ? null : String(trace.reason),
      messageId: trace.messageId == null ? null : String(trace.messageId),
      sessionId: trace.sessionId == null ? null : String(trace.sessionId)
    };
    // JSON schema instructions are appended inside each provider's request
    // builder (buildAnthropicMessagesRequest, buildOpenAiResponsesRequestBody,
    // callXaiChatCompletions). Do NOT pre-append here to avoid duplication.
    const streamingTransportSupported =
      provider === "anthropic" ||
      provider === "claude-oauth" ||
      provider === "openai" ||
      provider === "openai-oauth";
    const streamingTransportAllowed = streamingTransportSupported;
    const usedStreamingTransport = streamingTransportAllowed;
    try {
      const response = streamingTransportAllowed
        ? await this.callChatModelStreaming(provider, {
          model,
          systemPrompt,
          userPrompt,
          imageInputs,
          contextMessages,
          temperature,
          maxOutputTokens,
          reasoningEffort: orchestrator.reasoningEffort,
          thinking,
          thinkingBudgetTokens,
          jsonSchema: normalizedJsonSchema,
          trace: normalizedTrace,
          tools: normalizedTools,
          signal
        }, {
          onTextDelta,
          signal
        })
        : await this.callChatModel(provider, {
          model,
          systemPrompt,
          userPrompt,
          imageInputs,
          contextMessages,
          temperature,
          maxOutputTokens,
          reasoningEffort: orchestrator.reasoningEffort,
          thinking,
          thinkingBudgetTokens,
          jsonSchema: normalizedJsonSchema,
          trace: normalizedTrace,
          tools: normalizedTools,
          signal
        });
      if (!streamingTransportAllowed && response.text) {
        onTextDelta(response.text);
      }
      const toolCalls = Array.isArray(response.toolCalls) ? response.toolCalls : [];
      const rawContent = response.rawContent || null;
      const stopReason = String(response.stopReason || "").trim() || null;
      const responseText = String(response.text || "");
      const toolNames = summarizeToolCallNames(toolCalls);

      const costUsd = estimateUsdCost({
        provider,
        model,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        cacheWriteTokens: Number(response.usage.cacheWriteTokens || 0),
        cacheReadTokens: Number(response.usage.cacheReadTokens || 0),
        customPricing: replyGeneration.pricing
      });

      this.store.logAction({
        kind: "llm_call",
        guildId: normalizedTrace.guildId,
        channelId: normalizedTrace.channelId,
        userId: normalizedTrace.userId,
        content: `${provider}:${model}`,
        metadata: {
          provider,
          model,
          usage: response.usage,
          inputImages: imageInputs.length,
          toolCallCount: toolCalls.length,
          toolNames,
          stopReason,
          responseChars: responseText.length,
          transcript: responseText || null,
          transcriptSource: "output",
          source: normalizedTrace.source || null,
          event: normalizedTrace.event || null,
          reason: normalizedTrace.reason || null,
          messageId: normalizedTrace.messageId || null,
          sessionId: normalizedTrace.sessionId || null,
          streaming: usedStreamingTransport,
          systemPrompt: systemPrompt || null,
          userPrompt: userPrompt || null,
          contextMessageCount: contextMessages.length
        },
        usdCost: costUsd
      });

      return {
        text: response.text,
        ...(response.thinkingText ? { thinkingText: response.thinkingText } : {}),
        toolCalls,
        rawContent,
        provider,
        model,
        stopReason,
        usage: response.usage,
        costUsd
      };
    } catch (error) {
      const errObj = error && typeof error === "object" ? error as Record<string, unknown> : null;
      this.store.logAction({
        kind: "llm_error",
        guildId: normalizedTrace.guildId,
        channelId: normalizedTrace.channelId,
        userId: normalizedTrace.userId,
        content: String(error?.message || error),
        metadata: {
          provider,
          model,
          streaming: usedStreamingTransport,
          status: errObj?.status ?? null,
          errorType: (errObj?.error as Record<string, unknown>)?.type ?? null,
          requestId: errObj?.request_id ?? (errObj?.headers as Record<string, unknown>)?.["request-id"] ?? null
        }
      });
      throw error;
    }
  }

  async callChatModel(
    provider: string,
    payload: ChatModelRequest & { trace?: LlmTrace }
  ): Promise<ChatModelResponse> {
    if (provider === "claude-oauth") {
      await this.claudeOAuth?.ensureFresh();
      return callAnthropicRequest(this.chatDeps("claude-oauth"), payload);
    }
    if (provider === "openai-oauth") {
      await this.codexOAuth?.ensureFresh();
      return callOpenAIRequest(this.chatDeps("openai-oauth"), payload);
    }
    if (provider === "codex-cli" || provider === "codex_cli_session") {
      return callCodexCliRequest(this.codexCliDeps(), payload);
    }
    if (provider === "anthropic") {
      return callAnthropicRequest(this.chatDeps(), payload);
    }
    if (provider === "xai") {
      return callXaiRequest(this.chatDeps(), payload);
    }
    if (provider === "openai") {
      return callOpenAIRequest(this.chatDeps(), payload);
    }
    throw new Error(`Unsupported LLM provider '${provider}'.`);
  }

  async callChatModelStreaming(
    provider: string,
    payload: ChatModelRequest & { trace?: LlmTrace },
    callbacks: ChatModelStreamCallbacks
  ): Promise<ChatModelResponse> {
    if (provider === "claude-oauth") {
      await this.claudeOAuth?.ensureFresh();
      return callAnthropicStreamingRequest(this.chatDeps("claude-oauth"), payload, callbacks);
    }
    if (provider === "anthropic") {
      return callAnthropicStreamingRequest(this.chatDeps(), payload, callbacks);
    }
    if (provider === "openai-oauth") {
      await this.codexOAuth?.ensureFresh();
      return callOpenAiResponsesStreamingRequest(this.chatDeps("openai-oauth"), payload, callbacks);
    }
    if (provider === "openai") {
      return callOpenAiResponsesStreamingRequest(this.chatDeps(), payload, callbacks);
    }
    throw new Error(`Streaming is not supported for LLM provider '${provider}'.`);
  }

  async callCodexCli(payload: ChatModelRequest & { trace?: LlmTrace }) {
    return callCodexCliRequest(this.codexCliDeps(), payload);
  }

  async runCodexCliBrainStream(args: {
    model: string;
    input: string;
    timeoutMs: number;
    maxBufferBytes: number;
  }) {
    return runCodexCliBrainStreamRequest(this.codexCliDeps(), args);
  }

  close() {
    closeCodexCliSession(this.codexCliDeps());
  }

  isEmbeddingReady() {
    return isEmbeddingReadyRequest(this.embeddingDeps());
  }

  async embedText(args: { settings: unknown; text: unknown; trace?: LlmTrace }) {
    return embedTextRequest(this.embeddingDeps(), args);
  }

  resolveEmbeddingModel(settings: unknown) {
    return resolveEmbeddingModelRequest(this.embeddingDeps(), settings);
  }

  async generateImage(args: { settings: unknown; prompt: unknown; variant?: string; trace?: LlmTrace }) {
    return generateImageRequest(this.mediaDeps(), args);
  }

  async generateVideo(args: { settings: unknown; prompt: unknown; trace?: LlmTrace }) {
    return generateVideoRequest(this.mediaDeps(), args);
  }

  async fetchXaiJson(url: string, options: XaiJsonRequestOptions = {}, timeoutMs = XAI_REQUEST_TIMEOUT_MS) {
    return fetchXaiJsonRequest(this.mediaDeps(), url, options, timeoutMs);
  }

  getMediaGenerationCapabilities(settings: unknown) {
    return getMediaGenerationCapabilitiesRequest(this.mediaDeps(), settings);
  }

  isImageGenerationReady(settings: unknown, variant = "any") {
    return isImageGenerationReadyRequest(this.mediaDeps(), settings, variant);
  }

  isVideoGenerationReady(settings: unknown) {
    return isVideoGenerationReadyRequest(this.mediaDeps(), settings);
  }

  resolveImageGenerationTarget(settings: unknown, variant = "simple") {
    return resolveImageGenerationTargetRequest(this.mediaDeps(), settings, variant);
  }

  resolveVideoGenerationTarget(settings: unknown) {
    return resolveVideoGenerationTargetRequest(this.mediaDeps(), settings);
  }

  isAsrReady(provider?: string) {
    return isAsrReadyRequest(this.audioDeps(), { provider });
  }

  isSpeechSynthesisReady(provider?: string) {
    return isSpeechSynthesisReadyRequest(this.audioDeps(), { provider });
  }

  async transcribeAudio(args: {
    filePath?: string | null;
    audioBytes?: Buffer | Uint8Array | ArrayBuffer | null;
    fileName?: string;
    provider?: string;
    model?: string;
    language?: string;
    prompt?: string;
    sampleRateHz?: number;
    baseUrl?: string;
    trace?: LlmTrace;
  }) {
    return transcribeAudioRequest(this.audioDeps(), args);
  }

  async synthesizeSpeech(args: {
    text: unknown;
    provider?: string;
    model?: string;
    voice?: string;
    speed?: number;
    responseFormat?: string;
    sampleRateHz?: number;
    baseUrl?: string;
    trace?: LlmTrace;
  }) {
    return synthesizeSpeechRequest(this.audioDeps(), args);
  }

  resolveProviderAndModel(llmSettings: unknown) {
    const binding =
      llmSettings && typeof llmSettings === "object"
        ? (llmSettings as Record<string, unknown>)
        : {};
    const desiredProvider = normalizeLlmProvider(binding.provider, this.appConfig?.defaultProvider);
    const desiredModel = String(binding.model || "")
      .trim()
      .slice(0, 120);

    if (desiredProvider === "claude-oauth" && !this.isProviderConfigured("claude-oauth")) {
      throw new Error(
        "LLM provider is set to claude-oauth, but no OAuth tokens are configured. Set CLAUDE_OAUTH_REFRESH_TOKEN, create data/claude-oauth-tokens.json, or sign in via opencode so clanky can bootstrap its own local OAuth token cache."
      );
    }
    if (desiredProvider === "openai-oauth" && !this.isProviderConfigured("openai-oauth")) {
      throw new Error(
        "LLM provider is set to openai-oauth, but no OAuth tokens are configured. Set OPENAI_OAUTH_REFRESH_TOKEN, create data/openai-oauth-tokens.json, run `codex login`, or provide ~/.codex/auth.json."
      );
    }
    if ((desiredProvider === "codex-cli" || desiredProvider === "codex_cli_session") && !this.isProviderConfigured(desiredProvider)) {
      throw new Error(
        "LLM provider is set to codex-cli, but the `codex` CLI is not available on PATH for this process. Ensure `which codex` works in the same shell/service environment that starts the bot, then restart."
      );
    }

    const fallbackProviders = resolveProviderFallbackOrder(desiredProvider);

    for (const provider of fallbackProviders) {
      if (!this.isProviderConfigured(provider)) continue;
      const model = provider === "openai-oauth"
        ? normalizeOpenAiOAuthModel(
            provider === desiredProvider && desiredModel
              ? desiredModel
              : this.resolveDefaultModel(provider)
          )
        : provider === desiredProvider && desiredModel
          ? desiredModel
          : this.resolveDefaultModel(provider);
      if (provider !== desiredProvider) {
        this.store.logAction({
          kind: "llm_lifecycle",
          content: "provider_fallback",
          metadata: {
            desired: desiredProvider,
            actual: provider,
            reason: `${desiredProvider} not configured`
          }
        });
      }
      return {
        provider,
        model
      };
    }

    throw new Error(
      "No LLM provider available. Add OPENAI_API_KEY, ANTHROPIC_API_KEY, XAI_API_KEY, CLAUDE_OAUTH_REFRESH_TOKEN, or OPENAI_OAUTH_REFRESH_TOKEN."
    );
  }

  isProviderConfigured(provider: string) {
    if (provider === "claude-oauth") return Boolean(this.claudeOAuth);
    if (provider === "openai-oauth") return Boolean(this.codexOAuth);
    if (provider === "codex-cli") return Boolean(this.codexCliAvailable);
    if (provider === "codex_cli_session") return Boolean(this.codexCliAvailable);
    if (provider === "anthropic") return Boolean(this.anthropic);
    if (provider === "xai") return Boolean(this.xai);
    return Boolean(this.openai);
  }

  resolveDefaultModel(provider: string) {
    if (provider === "claude-oauth") {
      return normalizeDefaultModel(this.appConfig?.defaultClaudeOAuthModel, "claude-sonnet-4-6");
    }
    if (provider === "openai-oauth") {
      return normalizeOpenAiOAuthModel(
        normalizeDefaultModel(this.appConfig?.defaultOpenAiOAuthModel, "gpt-5.4")
      );
    }
    if (provider === "codex-cli" || provider === "codex_cli_session") {
      return normalizeDefaultModel(this.appConfig?.defaultCodexCliModel, "gpt-5.4");
    }
    if (provider === "anthropic") {
      return normalizeDefaultModel(this.appConfig?.defaultAnthropicModel, "claude-haiku-4-5");
    }
    if (provider === "xai") {
      return normalizeDefaultModel(this.appConfig?.defaultXaiModel, "grok-3-mini-latest");
    }
    return normalizeDefaultModel(this.appConfig?.defaultOpenAiModel, "claude-haiku-4-5");
  }

  async callOpenAI(request: ChatModelRequest) {
    return callOpenAIRequest(this.chatDeps(), request);
  }

  async callXai(request: ChatModelRequest) {
    return callXaiRequest(this.chatDeps(), request);
  }

  async callOpenAiResponses(request: ChatModelRequest) {
    return callOpenAiResponsesRequest(this.chatDeps(), request);
  }

  async callXaiChatCompletions(request: ChatModelRequest) {
    return callXaiChatCompletionsRequest(this.chatDeps(), request);
  }

  async callAnthropic(request: ChatModelRequest) {
    return callAnthropicRequest(this.chatDeps(), request);
  }

  async callAnthropicStreaming(request: ChatModelRequest, callbacks: ChatModelStreamCallbacks) {
    return callAnthropicStreamingRequest(this.chatDeps(), request, callbacks);
  }

  async chatWithTools(args: Parameters<typeof chatWithToolsRequest>[1]) {
    return chatWithToolsRequest(this.toolLoopDeps(), args);
  }
}

export {
  buildCodexCliBrainArgs,
  buildCodexCliCodeAgentArgs,
  buildCodexCliResumeArgs,
  createCodexCliStreamSession,
  parseCodexCliJsonlOutput
} from "./llm/llmCodexCli.ts";
