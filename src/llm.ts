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
  callCodexCliMemoryExtraction as callCodexCliMemoryExtractionRequest,
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
  type EmbeddingServiceDeps
} from "./llm/embeddingService.ts";
import {
  callAnthropicMemoryExtraction as callAnthropicMemoryExtractionRequest,
  callMemoryExtractionModel as callMemoryExtractionModelRequest,
  callOpenAiMemoryExtraction as callOpenAiMemoryExtractionRequest,
  callXaiMemoryExtraction as callXaiMemoryExtractionRequest,
  extractMemoryFacts as extractMemoryFactsRequest,
  type MemoryExtractionDeps
} from "./llm/memoryExtraction.ts";
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
  appendJsonSchemaInstruction,
  type ChatModelRequest,
  type ChatModelStreamCallbacks,
  type ContextMessage,
  type ImageInput,
  type LLMAppConfig,
  type LlmActionStore,
  type LlmTrace,
  type MemoryExtractionRequest,
  type MemoryExtractionResponse,
  type XaiJsonRequestOptions,
  XAI_REQUEST_TIMEOUT_MS
} from "./llm/serviceShared.ts";
import {
  chatWithTools as chatWithToolsRequest,
  type ToolLoopChatDeps
} from "./llm/toolLoopChat.ts";
import {
  normalizeCodexOAuthModel,
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
  buildOpenAiJsonSchemaTextFormat,
  buildOpenAiReasoningParam,
  buildOpenAiTemperatureParam,
  MEMORY_EXTRACTION_SCHEMA,
  XAI_REQUEST_TIMEOUT_MS,
  type ToolLoopContentBlock,
  type ToolLoopMessage
} from "./llm/serviceShared.ts";

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
        console.error("[claude-oauth] Failed to initialize:", error);
      }
    }

    this.codexOAuth = null;
    if (isCodexOAuthConfigured(appConfig.codexOAuthRefreshToken || "")) {
      try {
        this.codexOAuth = createCodexOAuthClient(appConfig.codexOAuthRefreshToken || "");
      } catch (error) {
        console.error("[codex-oauth] Failed to initialize:", error);
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

  private chatDeps(provider?: string): ChatGenerationDeps {
    return {
      openai: provider === "codex-oauth"
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
      defaultMemoryEmbeddingModel: this.appConfig.defaultMemoryEmbeddingModel
    };
  }

  private audioDeps(): AudioServiceDeps {
    return {
      openai: this.openai,
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

  private memoryExtractionDeps(): MemoryExtractionDeps {
    return {
      openai: this.openai,
      xai: this.xai,
      anthropic: this.anthropic,
      claudeOAuthClient: this.claudeOAuth?.client ?? null,
      codexOAuthClient: this.codexOAuth?.client ?? null,
      store: this.store,
      resolveProviderAndModel: (llmSettings) => this.resolveProviderAndModel(llmSettings),
      callCodexCliMemoryExtraction: (request) =>
        callCodexCliMemoryExtractionRequest(this.codexCliDeps(), request)
    };
  }

  private toolLoopDeps(): ToolLoopChatDeps {
    return {
      openai: this.openai,
      anthropic: this.anthropic,
      claudeOAuthClient: this.claudeOAuth?.client ?? null,
      codexOAuthClient: this.codexOAuth?.client ?? null,
      store: this.store
    };
  }

  getCodexCompatibleClient() {
    return this.openai || this.codexOAuth?.client || null;
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
      messageId: null
    },
    jsonSchema = "",
    tools = [],
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
    };
    jsonSchema?: string;
    tools?: ChatModelRequest["tools"];
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
      messageId: null
    },
    jsonSchema = "",
    tools = [],
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
    };
    jsonSchema?: string;
    tools?: ChatModelRequest["tools"];
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
      messageId: trace.messageId == null ? null : String(trace.messageId)
    };
    const effectiveSystemPrompt =
      normalizedJsonSchema && provider !== "codex-cli" && provider !== "codex_cli_session" && provider !== "openai" && provider !== "codex-oauth"
        ? appendJsonSchemaInstruction(systemPrompt, normalizedJsonSchema)
        : systemPrompt;
    const streamingTransportSupported =
      provider === "anthropic" ||
      provider === "claude-oauth" ||
      provider === "openai" ||
      provider === "codex-oauth";
    const streamingTransportAllowed =
      streamingTransportSupported &&
      (!normalizedJsonSchema || provider === "openai" || provider === "codex-oauth");
    let usedStreamingTransport = false;
    try {
      const response = streamingTransportAllowed
        ? await this.callChatModelStreaming(provider, {
          model,
          systemPrompt: effectiveSystemPrompt,
          userPrompt,
          imageInputs,
          contextMessages,
          temperature,
          maxOutputTokens,
          reasoningEffort: orchestrator.reasoningEffort,
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
          systemPrompt: effectiveSystemPrompt,
          userPrompt,
          imageInputs,
          contextMessages,
          temperature,
          maxOutputTokens,
          reasoningEffort: orchestrator.reasoningEffort,
          jsonSchema: normalizedJsonSchema,
          trace: normalizedTrace,
          tools: normalizedTools,
          signal
        });
      usedStreamingTransport = streamingTransportAllowed;
      if (!streamingTransportAllowed && response.text) {
        onTextDelta(response.text);
      }
      const toolCalls = Array.isArray(response.toolCalls) ? response.toolCalls : [];
      const rawContent = response.rawContent || null;

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
          source: normalizedTrace.source || null,
          event: normalizedTrace.event || null,
          reason: normalizedTrace.reason || null,
          messageId: normalizedTrace.messageId || null,
          streaming: usedStreamingTransport
        },
        usdCost: costUsd
      });

      return {
        text: response.text,
        toolCalls,
        rawContent,
        provider,
        model,
        usage: response.usage,
        costUsd
      };
    } catch (error) {
      this.store.logAction({
        kind: "llm_error",
        guildId: normalizedTrace.guildId,
        channelId: normalizedTrace.channelId,
        userId: normalizedTrace.userId,
        content: String(error?.message || error),
        metadata: {
          provider,
          model,
          streaming: usedStreamingTransport
        }
      });
      throw error;
    }
  }

  async callChatModel(
    provider: string,
    payload: ChatModelRequest & { trace?: LlmTrace }
  ) {
    if (provider === "claude-oauth") {
      return callAnthropicRequest(this.chatDeps("claude-oauth"), payload);
    }
    if (provider === "codex-oauth") {
      return callOpenAIRequest(this.chatDeps("codex-oauth"), payload);
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
  ) {
    if (provider === "claude-oauth") {
      return callAnthropicStreamingRequest(this.chatDeps("claude-oauth"), payload, callbacks);
    }
    if (provider === "anthropic") {
      return callAnthropicStreamingRequest(this.chatDeps(), payload, callbacks);
    }
    if (provider === "codex-oauth") {
      return callOpenAiResponsesStreamingRequest(this.chatDeps("codex-oauth"), payload, callbacks);
    }
    if (provider === "openai") {
      return callOpenAiResponsesStreamingRequest(this.chatDeps(), payload, callbacks);
    }
    throw new Error(`Streaming is not supported for LLM provider '${provider}'.`);
  }

  async callMemoryExtractionModel(provider: string, payload: MemoryExtractionRequest) {
    return callMemoryExtractionModelRequest(this.memoryExtractionDeps(), provider, payload);
  }

  async extractMemoryFacts(args: {
    settings: unknown;
    authorName: unknown;
    messageContent: unknown;
    maxFacts?: number;
    trace?: LlmTrace;
  }) {
    return extractMemoryFactsRequest(this.memoryExtractionDeps(), args);
  }

  async callOpenAiMemoryExtraction(payload: MemoryExtractionRequest): Promise<MemoryExtractionResponse> {
    return callOpenAiMemoryExtractionRequest(this.memoryExtractionDeps(), payload);
  }

  async callXaiMemoryExtraction(payload: MemoryExtractionRequest): Promise<MemoryExtractionResponse> {
    return callXaiMemoryExtractionRequest(this.memoryExtractionDeps(), payload);
  }

  async callAnthropicMemoryExtraction(payload: MemoryExtractionRequest): Promise<MemoryExtractionResponse> {
    return callAnthropicMemoryExtractionRequest(this.memoryExtractionDeps(), payload);
  }

  async callCodexCli(payload: ChatModelRequest & { trace?: LlmTrace }) {
    return callCodexCliRequest(this.codexCliDeps(), payload);
  }

  async callCodexCliMemoryExtraction(payload: MemoryExtractionRequest): Promise<MemoryExtractionResponse> {
    return callCodexCliMemoryExtractionRequest(this.codexCliDeps(), payload);
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

  isAsrReady() {
    return isAsrReadyRequest(this.audioDeps());
  }

  isSpeechSynthesisReady() {
    return isSpeechSynthesisReadyRequest(this.audioDeps());
  }

  async transcribeAudio(args: {
    filePath?: string | null;
    audioBytes?: Buffer | Uint8Array | ArrayBuffer | null;
    fileName?: string;
    model?: string;
    language?: string;
    prompt?: string;
    trace?: LlmTrace;
  }) {
    return transcribeAudioRequest(this.audioDeps(), args);
  }

  async synthesizeSpeech(args: {
    text: unknown;
    model?: string;
    voice?: string;
    speed?: number;
    responseFormat?: string;
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
        "LLM provider is set to claude-oauth, but no OAuth tokens are configured. Set CLAUDE_OAUTH_REFRESH_TOKEN or create data/claude-oauth-tokens.json."
      );
    }
    if (desiredProvider === "codex-oauth" && !this.isProviderConfigured("codex-oauth")) {
      throw new Error(
        "LLM provider is set to codex-oauth, but no OAuth tokens are configured. Set CODEX_OAUTH_REFRESH_TOKEN or create data/codex-oauth-tokens.json."
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
      const model = provider === "codex-oauth"
        ? normalizeCodexOAuthModel(
            provider === desiredProvider && desiredModel
              ? desiredModel
              : this.resolveDefaultModel(provider)
          )
        : provider === desiredProvider && desiredModel
          ? desiredModel
          : this.resolveDefaultModel(provider);
      return {
        provider,
        model
      };
    }

    throw new Error(
      "No LLM provider available. Add OPENAI_API_KEY, ANTHROPIC_API_KEY, XAI_API_KEY, CLAUDE_OAUTH_REFRESH_TOKEN, or CODEX_OAUTH_REFRESH_TOKEN."
    );
  }

  isProviderConfigured(provider: string) {
    if (provider === "claude-oauth") return Boolean(this.claudeOAuth);
    if (provider === "codex-oauth") return Boolean(this.codexOAuth);
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
    if (provider === "codex-oauth") {
      return normalizeCodexOAuthModel(
        normalizeDefaultModel(this.appConfig?.defaultCodexOAuthModel, "gpt-5.4")
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
  isClaudeOAuthConfigured,
  createClaudeOAuthClient,
  buildAuthorizeUrl as buildClaudeOAuthAuthorizeUrl,
  exchangeCodeForTokens as exchangeClaudeOAuthCode
} from "./llm/claudeOAuth.ts";

export {
  isCodexOAuthConfigured,
  createCodexOAuthClient,
  buildAuthorizeUrl as buildCodexOAuthAuthorizeUrl,
  exchangeCodeForTokens as exchangeCodexOAuthCode
} from "./llm/codexOAuth.ts";

export {
  buildCodexCliBrainArgs,
  buildCodexCliCodeAgentArgs,
  buildCodexCliResumeArgs,
  buildCodexCliTextArgs,
  createCodexCliStreamSession,
  parseCodexCliJsonlOutput
} from "./llm/llmCodexCli.ts";
