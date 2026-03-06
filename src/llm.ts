import { spawnSync } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { estimateUsdCost } from "./pricing.ts";
import {
  isAsrReady as isAsrReadyRequest,
  isSpeechSynthesisReady as isSpeechSynthesisReadyRequest,
  synthesizeSpeech as synthesizeSpeechRequest,
  transcribeAudio as transcribeAudioRequest,
  type AudioServiceDeps
} from "./llm/audioService.ts";
import {
  callAnthropic as callAnthropicRequest,
  callOpenAI as callOpenAIRequest,
  callOpenAiResponses as callOpenAiResponsesRequest,
  callXai as callXaiRequest,
  callXaiChatCompletions as callXaiChatCompletionsRequest,
  type ChatGenerationDeps
} from "./llm/chatGeneration.ts";
import {
  callClaudeCode as callClaudeCodeRequest,
  callClaudeCodeMemoryExtraction as callClaudeCodeMemoryExtractionRequest,
  closeClaudeCodeSession,
  runClaudeCodeBrainStream as runClaudeCodeBrainStreamRequest,
  type ClaudeCodeServiceDeps
} from "./llm/claudeCodeService.ts";
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
  normalizeClaudeCodeModel,
  normalizeDefaultModel,
  normalizeLlmProvider,
  normalizeXaiBaseUrl,
  resolveProviderFallbackOrder
} from "./llm/llmHelpers.ts";
import {
  getReplyGenerationSettings,
  getResolvedOrchestratorBinding
} from "./settings/agentStack.ts";
import type { ClaudeCliStreamSessionLike } from "./llmClaudeCode.ts";

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
  claudeCodeAvailable: boolean;
  claudeCodeBrainSession: ClaudeCliStreamSessionLike | null;
  claudeCodeBrainModel: string;

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

    this.claudeCodeAvailable = false;
    try {
      const result = spawnSync("claude", ["--version"], { encoding: "utf8", timeout: 5000 });
      const versionOutput = String(result?.stdout || result?.stderr || "").trim();
      this.claudeCodeAvailable = result?.status === 0 && Boolean(versionOutput);
    } catch {
      this.claudeCodeAvailable = false;
    }

    this.claudeCodeBrainSession = null;
    this.claudeCodeBrainModel = "";
  }

  private chatDeps(): ChatGenerationDeps {
    return {
      openai: this.openai,
      xai: this.xai,
      anthropic: this.anthropic
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

  private claudeCodeDeps(): ClaudeCodeServiceDeps {
    return {
      claudeCodeAvailable: this.claudeCodeAvailable,
      getBrainSession: () => this.claudeCodeBrainSession,
      setBrainSession: (session) => {
        this.claudeCodeBrainSession = session;
      },
      getBrainModel: () => this.claudeCodeBrainModel,
      setBrainModel: (model) => {
        this.claudeCodeBrainModel = model;
      }
    };
  }

  private memoryExtractionDeps(): MemoryExtractionDeps {
    return {
      openai: this.openai,
      xai: this.xai,
      anthropic: this.anthropic,
      store: this.store,
      resolveProviderAndModel: (llmSettings) => this.resolveProviderAndModel(llmSettings),
      callClaudeCodeMemoryExtraction: (request) =>
        callClaudeCodeMemoryExtractionRequest(this.claudeCodeDeps(), request)
    };
  }

  private toolLoopDeps(): ToolLoopChatDeps {
    return {
      openai: this.openai,
      anthropic: this.anthropic,
      store: this.store
    };
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
    tools = []
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
      normalizedJsonSchema && provider !== "claude-code" && provider !== "openai"
        ? appendJsonSchemaInstruction(systemPrompt, normalizedJsonSchema)
        : systemPrompt;

    try {
      const response = await this.callChatModel(provider, {
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
        tools: normalizedTools
      });
      const toolCalls = "toolCalls" in response && Array.isArray(response.toolCalls) ? response.toolCalls : [];
      const rawContent = "rawContent" in response ? response.rawContent || null : null;

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
          messageId: normalizedTrace.messageId || null
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
          model
        }
      });
      throw error;
    }
  }

  async callChatModel(
    provider: string,
    payload: ChatModelRequest & { trace?: LlmTrace }
  ) {
    if (provider === "claude-code") {
      return callClaudeCodeRequest(this.claudeCodeDeps(), payload);
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

  async callClaudeCode(payload: ChatModelRequest & { trace?: LlmTrace }) {
    return callClaudeCodeRequest(this.claudeCodeDeps(), payload);
  }

  async callClaudeCodeMemoryExtraction(payload: MemoryExtractionRequest): Promise<MemoryExtractionResponse> {
    return callClaudeCodeMemoryExtractionRequest(this.claudeCodeDeps(), payload);
  }

  async runClaudeCodeBrainStream(args: {
    model: string;
    input: string;
    timeoutMs: number;
    maxBufferBytes: number;
  }) {
    return runClaudeCodeBrainStreamRequest(this.claudeCodeDeps(), args);
  }

  close() {
    closeClaudeCodeSession(this.claudeCodeDeps());
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

    if (desiredProvider === "claude-code" && !this.isProviderConfigured("claude-code")) {
      throw new Error(
        "LLM provider is set to claude-code, but the `claude` CLI is not available on PATH for this process. Ensure `which claude` works in the same shell/service environment that starts the bot, then restart."
      );
    }

    const fallbackProviders = resolveProviderFallbackOrder(desiredProvider);

    for (const provider of fallbackProviders) {
      if (!this.isProviderConfigured(provider)) continue;
      let model = provider === desiredProvider && desiredModel ? desiredModel : this.resolveDefaultModel(provider);
      if (provider === "claude-code") {
        const normalizedClaudeCodeModel = normalizeClaudeCodeModel(model);
        if (!normalizedClaudeCodeModel) {
          throw new Error(
            `Invalid claude-code model '${model}'. Use one of: sonnet, opus, haiku.`
          );
        }
        model = normalizedClaudeCodeModel;
      }
      return {
        provider,
        model
      };
    }

    throw new Error("No LLM provider available. Add OPENAI_API_KEY, ANTHROPIC_API_KEY, XAI_API_KEY, or install the claude CLI.");
  }

  isProviderConfigured(provider: string) {
    if (provider === "claude-code") return Boolean(this.claudeCodeAvailable);
    if (provider === "anthropic") return Boolean(this.anthropic);
    if (provider === "xai") return Boolean(this.xai);
    return Boolean(this.openai);
  }

  resolveDefaultModel(provider: string) {
    if (provider === "claude-code") {
      return normalizeDefaultModel(this.appConfig?.defaultClaudeCodeModel, "sonnet");
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

  async chatWithTools(args: Parameters<typeof chatWithToolsRequest>[1]) {
    return chatWithToolsRequest(this.toolLoopDeps(), args);
  }
}

export {
  buildClaudeCodeCliArgs,
  buildClaudeCodeFallbackPrompt,
  buildClaudeCodeJsonCliArgs,
  buildClaudeCodeStreamInput,
  buildClaudeCodeSystemPrompt,
  buildClaudeCodeTextCliArgs,
  createClaudeCliStreamSession,
  parseClaudeCodeJsonOutput,
  parseClaudeCodeStreamOutput
} from "./llmClaudeCode.ts";
