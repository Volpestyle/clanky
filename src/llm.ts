import { readFile } from "node:fs/promises";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { estimateImageUsdCost, estimateUsdCost } from "./pricing.ts";
import {
  buildAnthropicImageParts,
  buildClaudeCodeCliArgs,
  buildClaudeCodeFallbackPrompt,
  buildClaudeCodeJsonCliArgs,
  buildClaudeCodeStreamInput,
  buildClaudeCodeSystemPrompt,
  buildClaudeCodeTextCliArgs,
  createClaudeCliStreamSession,
  type ClaudeCliStreamSessionLike,
  normalizeClaudeCodeCliError,
  parseClaudeCodeJsonOutput,
  parseClaudeCodeStreamOutput,
  runClaudeCli,
  safeJsonParse
} from "./llmClaudeCode.ts";
import { sleepMs } from "./normalization/time.ts";
import {
  MEMORY_FACT_SUBJECTS,
  MEMORY_FACT_TYPES,
  clampInt,
  clampNumber,
  extractOpenAiImageBase64,
  extractOpenAiResponseText,
  extractOpenAiResponseUsage,
  extractOpenAiToolCalls,
  extractXaiVideoUrl,
  inferProviderFromModel,
  isXaiVideoDone,
  normalizeClaudeCodeModel,
  normalizeDefaultModel,
  normalizeExtractedFacts,
  normalizeInlineText,
  normalizeLlmProvider,
  normalizeOpenAiReasoningEffort,
  normalizeModelAllowlist,
  normalizeOpenAiImageGenerationSize,
  normalizeXaiBaseUrl,
  parseMemoryExtractionJson,
  prioritizePreferredModel,
  resolveProviderFallbackOrder
} from "./llm/llmHelpers.ts";
import {
  getBotName,
  getDiscoverySettings,
  getReplyGenerationSettings,
  getResolvedMemoryBinding,
  getResolvedOrchestratorBinding
} from "./settings/agentStack.ts";

const CLAUDE_CODE_TIMEOUT_MS = 30_000;
const CLAUDE_CODE_MAX_BUFFER_BYTES = 1024 * 1024;
const CLAUDE_CODE_BRAIN_SESSION_MAX_TURNS = 10_000;
const CLAUDE_CODE_MEMORY_EXTRACTION_MAX_TURNS = 1;
const DEFAULT_MEMORY_EMBEDDING_MODEL = "text-embedding-3-small";
const CLAUDE_CODE_ISOLATED_WORKSPACE = join(tmpdir(), "clanker-conk-brain");

function ensureIsolatedWorkspace(): string {
  const gitDir = join(CLAUDE_CODE_ISOLATED_WORKSPACE, ".git");
  if (!existsSync(join(gitDir, "HEAD"))) {
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/main\n");
  }
  return CLAUDE_CODE_ISOLATED_WORKSPACE;
}

const XAI_VIDEO_POLL_INTERVAL_MS = 2500;
const XAI_VIDEO_TIMEOUT_MS = 4 * 60_000;
export const XAI_REQUEST_TIMEOUT_MS = 20_000;
const XAI_VIDEO_FAILED_STATUSES = new Set(["failed", "error", "cancelled", "canceled"]);
type XaiJsonPrimitive = string | number | boolean | null;
type XaiJsonValue = XaiJsonPrimitive | XaiJsonRecord | XaiJsonValue[];
type XaiJsonRecord = {
  [key: string]: XaiJsonValue;
};

export type ToolLoopTextBlock = {
  type: "text";
  text: string;
};

export type ToolLoopToolCall = {
  type: "tool_call";
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type ToolLoopToolResult = {
  type: "tool_result";
  toolCallId: string;
  content: string;
  isError?: boolean;
};

export type ToolLoopContentBlock = ToolLoopTextBlock | ToolLoopToolCall | ToolLoopToolResult;

export type ToolLoopMessage = {
  role: "user" | "assistant";
  content: string | ToolLoopContentBlock[];
};

export type XaiJsonRequestOptions = {
  method?: string;
  body?: XaiJsonRecord | null;
};
export const MEMORY_EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    facts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          subject: { type: "string", enum: MEMORY_FACT_SUBJECTS },
          fact: { type: "string", minLength: 1, maxLength: 190 },
          type: { type: "string", enum: MEMORY_FACT_TYPES },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          evidence: { type: "string", minLength: 1, maxLength: 220 }
        },
        required: ["subject", "fact", "type", "confidence", "evidence"]
      }
    }
  },
  required: ["facts"]
};

export function buildOpenAiTemperatureParam(model: string, temperature: number) {
  const normalizedModel = String(model || "")
    .trim()
    .toLowerCase();
  if (/^gpt-5(?:$|[-_])/u.test(normalizedModel)) {
    return {};
  }
  return {
    temperature
  };
}

export function buildOpenAiReasoningParam(model: string, reasoningEffort: unknown = "") {
  const normalizedModel = String(model || "")
    .trim()
    .toLowerCase();
  if (!/^gpt-5(?:$|[-_])/u.test(normalizedModel)) {
    return {};
  }
  const resolvedEffort = normalizeOpenAiReasoningEffort(reasoningEffort) || "low";
  return {
    reasoning: {
      effort: resolvedEffort
    }
  };
}

function appendJsonSchemaInstruction(systemPrompt: string, jsonSchema: string) {
  const normalizedSchema = String(jsonSchema || "").trim();
  if (!normalizedSchema) return String(systemPrompt || "");

  const normalizedPrompt = String(systemPrompt || "").trim();
  return [
    normalizedPrompt,
    "Return strict JSON only. Do not output prose or code fences.",
    `JSON schema:\n${normalizedSchema}`
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function buildOpenAiJsonSchemaTextFormat(jsonSchema: string) {
  const normalizedSchema = String(jsonSchema || "").trim();
  if (!normalizedSchema) return null;

  const parsedSchema = safeJsonParse(normalizedSchema, null);
  if (!parsedSchema || typeof parsedSchema !== "object" || Array.isArray(parsedSchema)) {
    return null;
  }

  return {
    format: {
      type: "json_schema" as const,
      name: "reply_output",
      strict: true,
      schema: parsedSchema
    }
  };
}

function normalizeToolLoopTextBlocks(content: string | ToolLoopContentBlock[]): ToolLoopTextBlock[] {
  if (typeof content === "string") {
    const text = String(content || "").trim();
    return text ? [{ type: "text", text }] : [];
  }
  if (!Array.isArray(content)) return [];
  return content.filter((block): block is ToolLoopTextBlock => block?.type === "text");
}

function normalizeToolLoopCallBlocks(content: string | ToolLoopContentBlock[]): ToolLoopToolCall[] {
  if (!Array.isArray(content)) return [];
  return content.filter((block): block is ToolLoopToolCall => block?.type === "tool_call");
}

function normalizeToolLoopResultBlocks(content: string | ToolLoopContentBlock[]): ToolLoopToolResult[] {
  if (!Array.isArray(content)) return [];
  return content.filter((block): block is ToolLoopToolResult => block?.type === "tool_result");
}

function buildAnthropicToolLoopMessages(messages: ToolLoopMessage[]): Anthropic.MessageParam[] {
  return messages.map((message) => {
    if (typeof message.content === "string") {
      return {
        role: message.role,
        content: message.content
      };
    }

    const content: Anthropic.ContentBlockParam[] = [];
    for (const block of message.content) {
      if (block.type === "text") {
        content.push({
          type: "text",
          text: block.text
        });
        continue;
      }
      if (block.type === "tool_call") {
        content.push({
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.input
        });
        continue;
      }
      content.push({
        type: "tool_result",
        tool_use_id: block.toolCallId,
        content: block.content,
        is_error: Boolean(block.isError)
      });
    }

    return {
      role: message.role,
      content
    };
  });
}

function buildOpenAiToolLoopInput(messages: ToolLoopMessage[]) {
  const input = [];

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const textBlocks = normalizeToolLoopTextBlocks(message.content);
    const toolCallBlocks = normalizeToolLoopCallBlocks(message.content);
    const toolResultBlocks = normalizeToolLoopResultBlocks(message.content);

    if (message.role === "assistant") {
      if (textBlocks.length) {
        input.push({
          id: `assistant-message-${index}`,
          type: "message",
          role: "assistant",
          status: "completed",
          content: textBlocks.map((block) => ({
            type: "output_text" as const,
            text: block.text,
            annotations: []
          }))
        });
      }

      for (const block of toolCallBlocks) {
        input.push({
          id: `assistant-tool-${block.id}`,
          type: "function_call",
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
          status: "completed"
        });
      }

      continue;
    }

    if (textBlocks.length) {
      input.push({
        type: "message",
        role: "user",
        content: textBlocks.map((block) => ({
          type: "input_text" as const,
          text: block.text
        }))
      });
    }

    for (const block of toolResultBlocks) {
      input.push({
        type: "function_call_output",
        call_id: block.toolCallId,
        output: block.content
      });
    }
  }

  return input;
}

function buildToolLoopContentFromOpenAiOutput(output: unknown): ToolLoopContentBlock[] {
  const items = Array.isArray(output) ? output : [];
  const blocks: ToolLoopContentBlock[] = [];

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "message" && item.role === "assistant") {
      const contentParts = Array.isArray(item.content) ? item.content : [];
      for (const part of contentParts) {
        if (!part || typeof part !== "object") continue;
        if (part.type === "output_text") {
          const text = String(part.text || "").trim();
          if (text) blocks.push({ type: "text", text });
        } else if (part.type === "refusal") {
          const text = String(part.refusal || "").trim();
          if (text) blocks.push({ type: "text", text });
        }
      }
      continue;
    }

    if (item.type !== "function_call") continue;
    const name = String(item.name || "").trim();
    const toolCallId = String(item.call_id || item.id || "").trim();
    const input =
      typeof item.arguments === "string"
        ? safeJsonParse(item.arguments, {})
        : item.arguments && typeof item.arguments === "object"
          ? item.arguments
          : {};
    if (!name || !toolCallId) continue;
    blocks.push({
      type: "tool_call",
      id: toolCallId,
      name,
      input
    });
  }

  return blocks;
}

function buildClaudeCodeTurnPreamble({
  systemPrompt,
  trace = {}
}: {
  systemPrompt: string;
  trace?: {
    guildId?: string | null;
    channelId?: string | null;
    userId?: string | null;
    source?: string | null;
    event?: string | null;
    reason?: string | null;
    messageId?: string | null;
  };
}) {
  const normalizedSystemPrompt = String(systemPrompt || "").trim();
  const scope = [
    `guild:${trace?.guildId ? String(trace.guildId) : "none"}`,
    `channel:${trace?.channelId ? String(trace.channelId) : "none"}`,
    `user:${trace?.userId ? String(trace.userId) : "none"}`,
    `source:${trace?.source ? String(trace.source) : "unknown"}`,
    `event:${trace?.event ? String(trace.event) : "unknown"}`,
    `reason:${trace?.reason ? String(trace.reason) : "unknown"}`,
    `message:${trace?.messageId ? String(trace.messageId) : "none"}`
  ].join(" | ");

  const sections = [
    "Runtime turn packet for a single serialized bot brain.",
    `Turn scope: ${scope}`,
    "Privacy boundary: keep continuity/persona across turns, but do not disclose user-specific or channel-specific details from prior turns unless they are present in the current prompt/context.",
    normalizedSystemPrompt
  ].filter(Boolean);
  return sections.join("\n\n");
}

export class LLMService {
  appConfig;
  store;
  openai;
  xai;
  anthropic;
  claudeCodeAvailable;
  claudeCodeBrainSession: ClaudeCliStreamSessionLike | null;
  claudeCodeBrainModel: string;

  constructor({ appConfig, store }) {
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
  }) {
    const orchestrator = getResolvedOrchestratorBinding(settings);
    const replyGeneration = getReplyGenerationSettings(settings);
    const { provider, model } = this.resolveProviderAndModel(orchestrator);
    const temperature = Number(orchestrator.temperature) || 0.9;
    const maxOutputTokens = Number(orchestrator.maxOutputTokens) || 800;
    const normalizedJsonSchema = String(jsonSchema || "").trim();
    const normalizedTools = Array.isArray(tools) ? tools : [];
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
        trace,
        tools: normalizedTools
      });

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
        guildId: trace.guildId,
        channelId: trace.channelId,
        userId: trace.userId,
        content: `${provider}:${model}`,
        metadata: {
          provider,
          model,
          usage: response.usage,
          inputImages: imageInputs.length,
          toolCallCount: (response.toolCalls || []).length,
          source: trace.source ? String(trace.source) : null,
          event: trace.event ? String(trace.event) : null,
          reason: trace.reason ? String(trace.reason) : null,
          messageId: trace.messageId ? String(trace.messageId) : null
        },
        usdCost: costUsd
      });

      return {
        text: response.text,
        toolCalls: response.toolCalls || [],
        rawContent: response.rawContent || null,
        provider,
        model,
        usage: response.usage,
        costUsd
      };
    } catch (error) {
      this.store.logAction({
        kind: "llm_error",
        guildId: trace.guildId,
        channelId: trace.channelId,
        userId: trace.userId,
        content: String(error?.message || error),
        metadata: {
          provider,
          model
        }
      });
      throw error;
    }
  }

  async callChatModel(provider, payload) {
    const handlers = {
      "claude-code": (args) => this.callClaudeCode(args),
      anthropic: (args) => this.callAnthropic(args),
      xai: (args) => this.callXai(args),
      openai: (args) => this.callOpenAI(args)
    };
    const handler = handlers[provider];
    if (!handler) {
      throw new Error(`Unsupported LLM provider '${provider}'.`);
    }
    return handler(payload);
  }

  async callMemoryExtractionModel(provider, payload) {
    const handlers = {
      "claude-code": (args) => this.callClaudeCodeMemoryExtraction(args),
      anthropic: (args) => this.callAnthropicMemoryExtraction(args),
      xai: (args) => this.callXaiMemoryExtraction(args),
      openai: (args) => this.callOpenAiMemoryExtraction(args)
    };
    const handler = handlers[provider];
    if (!handler) {
      throw new Error(`Unsupported LLM provider '${provider}'.`);
    }
    return handler(payload);
  }

  async extractMemoryFacts({
    settings,
    authorName,
    messageContent,
    maxFacts = 3,
    trace = {
      guildId: null,
      channelId: null,
      userId: null,
      source: null,
      event: null,
      reason: null,
      messageId: null
    }
  }) {
    const inputText = normalizeInlineText(messageContent, 900);
    if (!inputText || inputText.length < 4) return [];

    const memoryBinding = getResolvedMemoryBinding(settings);
    const { provider, model } = this.resolveProviderAndModel(memoryBinding);
    const boundedMaxFacts = clampInt(maxFacts, 1, 6);
    const normalizedBotName = normalizeInlineText(getBotName(settings) || "the bot", 80) || "the bot";
    const systemPrompt = [
      "You extract durable memory facts from one Discord user message.",
      "Only keep long-lived facts worth remembering later (preferences, identity, recurring relationships, ongoing projects).",
      "Ignore requests, one-off chatter, jokes, threats, instructions, and ephemeral context.",
      "Do not store insults, toxic phrasing, or rules about how the bot should talk or behave in future situations.",
      "Every fact must be grounded directly in the message text.",
      "Classify each fact subject as one of: author, bot, lore.",
      "Use subject=author for facts about the message author.",
      `Use subject=bot only for explicit durable facts about ${normalizedBotName} (identity, alias, stable preference, standing commitment).`,
      `Do not store insults, commands, or one-off taunts about ${normalizedBotName} as bot facts.`,
      "Use subject=lore for stable shared context not tied to a single person.",
      "If subject is unclear, omit that fact.",
      `Return strict JSON only with shape: {"facts":[{"subject":"author|bot|lore","fact":"...","type":"preference|profile|relationship|project|other","confidence":0..1,"evidence":"exact short quote"}]}.`,
      "If there are no durable facts, return {\"facts\":[]}."
    ].join("\n");
    const userPrompt = [
      `Author: ${normalizeInlineText(authorName || "unknown", 80)}`,
      `Max facts: ${boundedMaxFacts}`,
      `Message: ${inputText}`
    ].join("\n");

    try {
      const response = await this.callMemoryExtractionModel(provider, {
        model,
        systemPrompt,
        userPrompt
      });

      const costUsd = estimateUsdCost({
        provider,
        model,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        cacheWriteTokens: response.usage.cacheWriteTokens,
        cacheReadTokens: response.usage.cacheReadTokens,
        customPricing: getReplyGenerationSettings(settings).pricing
      });
      const parsed = parseMemoryExtractionJson(response.text);
      const facts = normalizeExtractedFacts(parsed, boundedMaxFacts);

      this.store.logAction({
        kind: "memory_extract_call",
        guildId: trace.guildId,
        channelId: trace.channelId,
        userId: trace.userId,
        content: `${provider}:${model}`,
        metadata: {
          provider,
          model,
          usage: response.usage,
          maxFacts: boundedMaxFacts,
          extractedFacts: facts.length
        },
        usdCost: costUsd
      });

      return facts;
    } catch (error) {
      this.store.logAction({
        kind: "memory_extract_error",
        guildId: trace.guildId,
        channelId: trace.channelId,
        userId: trace.userId,
        content: String(error?.message || error),
        metadata: {
          provider,
          model
        }
      });
      throw error;
    }
  }

  async callOpenAiMemoryExtraction({ model, systemPrompt, userPrompt }) {
    if (!this.openai) {
      throw new Error("Memory fact extraction requires OPENAI_API_KEY when provider is openai.");
    }

    const response = await this.openai.responses.create({
      model,
      instructions: systemPrompt,
      ...buildOpenAiTemperatureParam(model, 0),
      ...buildOpenAiReasoningParam(model, "minimal"),
      max_output_tokens: 320,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: userPrompt
            }
          ]
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "memory_fact_extraction",
          strict: true,
          schema: MEMORY_EXTRACTION_SCHEMA
        }
      },
    });

    const text = extractOpenAiResponseText(response) || '{"facts":[]}';

    return {
      text,
      usage: extractOpenAiResponseUsage(response)
    };
  }

  async callXaiMemoryExtraction({ model, systemPrompt, userPrompt }) {
    if (!this.xai) {
      throw new Error("Memory fact extraction requires XAI_API_KEY when provider is xai.");
    }

    const response = await this.xai.chat.completions.create({
      model,
      temperature: 0,
      max_tokens: 320,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ]
    });

    const text = response.choices?.[0]?.message?.content?.trim() || '{"facts":[]}';

    return {
      text,
      usage: {
        inputTokens: Number(response.usage?.prompt_tokens || 0),
        outputTokens: Number(response.usage?.completion_tokens || 0),
        cacheWriteTokens: 0,
        cacheReadTokens: 0
      }
    };
  }

  async callAnthropicMemoryExtraction({ model, systemPrompt, userPrompt }) {
    const response = await this.anthropic.messages.create({
      model,
      system: systemPrompt,
      temperature: 0,
      max_tokens: 320,
      messages: [{ role: "user", content: userPrompt }]
    });

    const text = response.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n")
      .trim();

    return {
      text,
      usage: {
        inputTokens: Number(response.usage?.input_tokens || 0),
        outputTokens: Number(response.usage?.output_tokens || 0),
        cacheWriteTokens: Number(response.usage?.cache_creation_input_tokens || 0),
        cacheReadTokens: Number(response.usage?.cache_read_input_tokens || 0)
      }
    };
  }

  async callClaudeCode({
    model,
    systemPrompt,
    userPrompt,
    imageInputs = [],
    contextMessages = [],
    maxOutputTokens,
    jsonSchema = "",
    trace = {
      guildId: null,
      channelId: null,
      userId: null,
      source: null,
      event: null,
      reason: null,
      messageId: null
    }
  }) {
    if (!this.claudeCodeAvailable) {
      throw new Error("claude-code provider requires the 'claude' CLI to be installed.");
    }

    const normalizedJsonSchema = String(jsonSchema || "").trim();
    const usePersistentBrainStream = !normalizedJsonSchema;
    const turnPreamble = buildClaudeCodeTurnPreamble({
      systemPrompt,
      trace
    });
    const streamInput = buildClaudeCodeStreamInput({
      contextMessages,
      userPrompt,
      imageInputs,
      turnPreamble: usePersistentBrainStream ? turnPreamble : ""
    });
    const fallbackSystemPrompt = buildClaudeCodeSystemPrompt({
      systemPrompt,
      maxOutputTokens
    });
    let streamFailure = "";

    try {
      const { stdout } = usePersistentBrainStream
        ? await this.runClaudeCodeBrainStream({
          model,
          input: streamInput,
          timeoutMs: CLAUDE_CODE_TIMEOUT_MS,
          maxBufferBytes: CLAUDE_CODE_MAX_BUFFER_BYTES
        })
        : await runClaudeCli({
          args: buildClaudeCodeCliArgs({
            model,
            systemPrompt: fallbackSystemPrompt,
            jsonSchema: normalizedJsonSchema,
            maxTurns: 1
          }),
          input: streamInput,
          timeoutMs: CLAUDE_CODE_TIMEOUT_MS,
          maxBufferBytes: CLAUDE_CODE_MAX_BUFFER_BYTES
        });

      const parsed = parseClaudeCodeStreamOutput(stdout);
      if (parsed?.isError) {
        throw new Error(parsed.errorMessage || "claude-code returned an error result.");
      }
      if (parsed && String(parsed.text || "").trim()) {
        return {
          text: parsed.text,
          usage: parsed.usage,
          costUsd: parsed.costUsd
        };
      }

      streamFailure = "claude-code returned an empty or invalid stream response.";
    } catch (error) {
      const normalizedError = normalizeClaudeCodeCliError(error, {
        timeoutPrefix: "claude-code timed out"
      });
      if (normalizedError.isTimeout) {
        throw new Error(normalizedError.message);
      }
      streamFailure = normalizedError.message;
    }

    const fallbackPrompt = buildClaudeCodeFallbackPrompt({
      contextMessages,
      userPrompt,
      imageInputs
    });
    const fallbackArgs = buildClaudeCodeJsonCliArgs({
      model,
      systemPrompt: fallbackSystemPrompt,
      jsonSchema: normalizedJsonSchema,
      prompt: fallbackPrompt
    });
    let jsonFallbackFailure = "";

    try {
      const { stdout } = await runClaudeCli({
        args: fallbackArgs,
        input: "",
        timeoutMs: CLAUDE_CODE_TIMEOUT_MS,
        maxBufferBytes: CLAUDE_CODE_MAX_BUFFER_BYTES
      });
      const parsed = parseClaudeCodeJsonOutput(stdout);
      if (parsed?.isError) {
        throw new Error(parsed.errorMessage || "claude-code returned an error result.");
      }
      if (!parsed || !String(parsed.text || "").trim()) {
        throw new Error("claude-code returned an empty or invalid fallback response.");
      }

      return {
        text: parsed.text,
        usage: parsed.usage,
        costUsd: parsed.costUsd
      };
    } catch (error) {
      const normalizedError = normalizeClaudeCodeCliError(error, {
        timeoutPrefix: "claude-code fallback timed out"
      });
      if (normalizedError.isTimeout) {
        throw new Error(
          streamFailure
            ? `${streamFailure} | fallback: ${normalizedError.message}`
            : normalizedError.message
        );
      }
      jsonFallbackFailure = normalizedError.message;
    }

    const textFallbackArgs = buildClaudeCodeTextCliArgs({
      model,
      systemPrompt: fallbackSystemPrompt,
      jsonSchema: normalizedJsonSchema,
      prompt: fallbackPrompt
    });
    try {
      const { stdout } = await runClaudeCli({
        args: textFallbackArgs,
        input: "",
        timeoutMs: CLAUDE_CODE_TIMEOUT_MS,
        maxBufferBytes: CLAUDE_CODE_MAX_BUFFER_BYTES
      });
      const text = String(stdout || "").trim();
      if (!text) {
        throw new Error("claude-code returned an empty or invalid text fallback response.");
      }

      return {
        text,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheWriteTokens: 0,
          cacheReadTokens: 0
        },
        costUsd: 0
      };
    } catch (error) {
      const normalizedError = normalizeClaudeCodeCliError(error, {
        timeoutPrefix: "claude-code text fallback timed out"
      });
      const messageParts = [streamFailure, jsonFallbackFailure, normalizedError.message].filter(Boolean);
      throw new Error(messageParts.join(" | "));
    }
  }

  async callClaudeCodeMemoryExtraction({ model, systemPrompt, userPrompt }) {
    if (!this.claudeCodeAvailable) {
      throw new Error("claude-code provider requires the 'claude' CLI to be installed.");
    }

    const schemaJson = JSON.stringify(MEMORY_EXTRACTION_SCHEMA);
    const streamInput = buildClaudeCodeStreamInput({
      contextMessages: [],
      userPrompt,
      imageInputs: []
    });

    try {
      const { stdout } = await runClaudeCli({
        args: buildClaudeCodeCliArgs({
          model,
          systemPrompt,
          jsonSchema: schemaJson,
          maxTurns: CLAUDE_CODE_MEMORY_EXTRACTION_MAX_TURNS
        }),
        input: streamInput,
        timeoutMs: CLAUDE_CODE_TIMEOUT_MS,
        maxBufferBytes: CLAUDE_CODE_MAX_BUFFER_BYTES,
        cwd: ensureIsolatedWorkspace()
      });

      const parsed = parseClaudeCodeStreamOutput(stdout);
      if (!parsed || !String(parsed.text || "").trim()) {
        throw new Error("claude-code returned an empty or invalid stream response.");
      }
      if (parsed.isError) {
        throw new Error(parsed.errorMessage || "claude-code returned an error result.");
      }

      return {
        text: parsed.text,
        usage: parsed.usage
      };
    } catch (error) {
      const normalizedError = normalizeClaudeCodeCliError(error, {
        timeoutPrefix: "claude-code memory extraction timed out"
      });
      throw new Error(normalizedError.message);
    }
  }

  async runClaudeCodeBrainStream({ model, input, timeoutMs, maxBufferBytes }) {
    const normalizedModel = String(model || "").trim();
    if (!normalizedModel) {
      throw new Error("claude-code brain stream requires a model");
    }

    if (
      !this.claudeCodeBrainSession ||
      this.claudeCodeBrainModel !== normalizedModel
    ) {
      if (this.claudeCodeBrainSession) {
        this.claudeCodeBrainSession.close();
      }
      this.claudeCodeBrainSession = createClaudeCliStreamSession({
        args: buildClaudeCodeCliArgs({
          model: normalizedModel,
          maxTurns: CLAUDE_CODE_BRAIN_SESSION_MAX_TURNS
        }),
        maxBufferBytes,
        cwd: ensureIsolatedWorkspace()
      });
      this.claudeCodeBrainModel = normalizedModel;
    }

    return await this.claudeCodeBrainSession.run({
      input,
      timeoutMs
    });
  }

  close() {
    if (!this.claudeCodeBrainSession || typeof this.claudeCodeBrainSession.close !== "function") return;
    this.claudeCodeBrainSession.close();
    this.claudeCodeBrainSession = null;
    this.claudeCodeBrainModel = "";
  }

  isEmbeddingReady() {
    return Boolean(this.openai);
  }

  async embedText({
    settings,
    text,
    trace = { guildId: null, channelId: null, userId: null, source: null }
  }) {
    if (!this.openai) {
      throw new Error("Embeddings require OPENAI_API_KEY.");
    }

    const input = normalizeInlineText(text, 8000);
    if (!input) {
      return {
        embedding: [],
        model: this.resolveEmbeddingModel(settings),
        usage: { inputTokens: 0, outputTokens: 0 },
        costUsd: 0
      };
    }

    const model = this.resolveEmbeddingModel(settings);
    try {
      const response = await this.openai.embeddings.create({
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

      this.store.logAction({
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
      this.store.logAction({
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

  resolveEmbeddingModel(settings) {
    const fromSettings = String(settings?.memory?.embeddingModel || "").trim();
    if (fromSettings) return fromSettings.slice(0, 120);
    const fromEnv = String(this.appConfig?.defaultMemoryEmbeddingModel || "").trim();
    if (fromEnv) return fromEnv.slice(0, 120);
    return DEFAULT_MEMORY_EMBEDDING_MODEL;
  }

  async generateImage({
    settings,
    prompt,
    variant = "simple",
    trace = { guildId: null, channelId: null, userId: null, source: null }
  }) {
    const target = this.resolveImageGenerationTarget(settings, variant);
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
        if (!this.openai) {
          throw new Error("OpenAI image generation requires OPENAI_API_KEY.");
        }
        const response = await this.openai.responses.create({
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
        if (!this.xai) {
          throw new Error("xAI image generation requires XAI_API_KEY.");
        }
        const response = await this.xai.images.generate({
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

      this.store.logAction({
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
      this.store.logAction({
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

  async generateVideo({
    settings,
    prompt,
    trace = { guildId: null, channelId: null, userId: null, source: null }
  }) {
    const target = this.resolveVideoGenerationTarget(settings);
    if (!target) {
      throw new Error("Video generation is unavailable (missing XAI_API_KEY or no allowed xAI video model).");
    }

    const model = target.model;
    const baseUrl = normalizeXaiBaseUrl(this.appConfig?.xaiBaseUrl);
    const payload = {
      model,
      prompt: String(prompt || "").slice(0, 3200)
    };

    try {
      const createResponse = await this.fetchXaiJson(
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
      let statusResponse = null;

      while (Date.now() - startedAt < XAI_VIDEO_TIMEOUT_MS) {
        await sleepMs(XAI_VIDEO_POLL_INTERVAL_MS);
        pollAttempts += 1;

        const poll = await this.fetchXaiJson(
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

      const durationSeconds = Number(
        statusResponse?.video?.duration_seconds ??
        statusResponse?.video?.duration ??
        statusResponse?.duration_seconds ??
        statusResponse?.duration ??
        0
      );
      const normalizedDuration = Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : null;
      const costUsd = 0;

      this.store.logAction({
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
      this.store.logAction({
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

  async fetchXaiJson(url, options: XaiJsonRequestOptions = {}, timeoutMs = XAI_REQUEST_TIMEOUT_MS) {
    const { method = "GET", body } = options;
    if (!this.appConfig?.xaiApiKey) {
      throw new Error("Missing XAI_API_KEY.");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.appConfig.xaiApiKey}`,
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

      if (parsed && typeof parsed === "object") return parsed;
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

  getMediaGenerationCapabilities(settings) {
    const simpleImageTarget = this.resolveImageGenerationTarget(settings, "simple");
    const complexImageTarget = this.resolveImageGenerationTarget(settings, "complex");
    const videoTarget = this.resolveVideoGenerationTarget(settings);
    return {
      simpleImageReady: Boolean(simpleImageTarget),
      complexImageReady: Boolean(complexImageTarget),
      videoReady: Boolean(videoTarget),
      simpleImageModel: simpleImageTarget?.model || null,
      complexImageModel: complexImageTarget?.model || null,
      videoModel: videoTarget?.model || null
    };
  }

  isImageGenerationReady(settings, variant = "any") {
    if (variant === "simple") {
      return Boolean(this.resolveImageGenerationTarget(settings, "simple"));
    }
    if (variant === "complex") {
      return Boolean(this.resolveImageGenerationTarget(settings, "complex"));
    }
    return Boolean(
      this.resolveImageGenerationTarget(settings, "simple") ||
      this.resolveImageGenerationTarget(settings, "complex")
    );
  }

  isVideoGenerationReady(settings) {
    return Boolean(this.resolveVideoGenerationTarget(settings));
  }

  resolveImageGenerationTarget(settings, variant = "simple") {
    const discovery = getDiscoverySettings(settings);
    const allowedModels = normalizeModelAllowlist(discovery.allowedImageModels);
    if (!allowedModels.length) return null;

    const preferredModel = String(
      variant === "complex" ? discovery.complexImageModel : discovery.simpleImageModel
    ).trim();
    const candidates = prioritizePreferredModel(allowedModels, preferredModel);

    for (const model of candidates) {
      const provider = inferProviderFromModel(model);
      if (provider === "openai" && this.openai) return { provider, model };
      if (provider === "xai" && this.xai) return { provider, model };
    }

    return null;
  }

  resolveVideoGenerationTarget(settings) {
    if (!this.xai) return null;

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

  isAsrReady() {
    return Boolean(this.openai);
  }

  isSpeechSynthesisReady() {
    return Boolean(this.openai);
  }

  async transcribeAudio({
    filePath,
    audioBytes = null,
    fileName = "audio.wav",
    model = "gpt-4o-mini-transcribe",
    language = "",
    prompt = "",
    trace = { guildId: null, channelId: null, userId: null, source: null }
  }) {
    if (!this.openai) {
      throw new Error("ASR fallback requires OPENAI_API_KEY.");
    }

    const resolvedModel = String(model || "gpt-4o-mini-transcribe").trim() || "gpt-4o-mini-transcribe";
    const resolvedLanguage = String(language || "")
      .trim()
      .toLowerCase()
      .replace(/_/g, "-")
      .slice(0, 24);
    const resolvedPrompt = String(prompt || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 280);
    try {
      const filePathText = String(filePath || "").trim();
      const resolvedFileName = String(fileName || "").trim() || "audio.wav";
      const resolvedAudioBytes = Buffer.isBuffer(audioBytes)
        ? audioBytes
        : audioBytes
          ? Buffer.from(audioBytes)
          : filePathText
            ? await readFile(filePathText)
            : null;
      if (!resolvedAudioBytes?.length) {
        throw new Error("ASR transcription requires non-empty audio bytes or file path.");
      }
      const response = await this.openai.audio.transcriptions.create({
        model: resolvedModel,
        file: new File([resolvedAudioBytes], basename(filePathText) || resolvedFileName),
        response_format: "text",
        ...(resolvedLanguage ? { language: resolvedLanguage } : {}),
        ...(resolvedPrompt ? { prompt: resolvedPrompt } : {})
      });

      const text =
        typeof response === "string"
          ? response.trim()
          : String(response?.text || response?.transcript || "").trim();
      if (!text) {
        throw new Error("ASR returned empty transcript.");
      }

      this.store.logAction({
        kind: "asr_call",
        guildId: trace.guildId,
        channelId: trace.channelId,
        userId: trace.userId,
        content: resolvedModel,
        metadata: {
          model: resolvedModel,
          language: resolvedLanguage || null,
          prompt: resolvedPrompt || null,
          source: trace.source || "unknown"
        }
      });

      return text;
    } catch (error) {
      this.store.logAction({
        kind: "asr_error",
        guildId: trace.guildId,
        channelId: trace.channelId,
        userId: trace.userId,
        content: String(error?.message || error),
        metadata: {
          model: resolvedModel,
          language: resolvedLanguage || null,
          prompt: resolvedPrompt || null,
          source: trace.source || "unknown"
        }
      });
      throw error;
    }
  }

  async synthesizeSpeech({
    text,
    model = "gpt-4o-mini-tts",
    voice = "alloy",
    speed = 1,
    responseFormat = "pcm",
    trace = { guildId: null, channelId: null, userId: null, source: null }
  }) {
    if (!this.openai) {
      throw new Error("Speech synthesis requires OPENAI_API_KEY.");
    }

    const resolvedText = normalizeInlineText(text, 4000);
    if (!resolvedText) {
      throw new Error("Speech synthesis requires non-empty text.");
    }

    const resolvedModel = String(model || "gpt-4o-mini-tts").trim() || "gpt-4o-mini-tts";
    const resolvedVoice = String(voice || "alloy").trim() || "alloy";
    const resolvedFormat = String(responseFormat || "pcm").trim().toLowerCase() || "pcm";
    const resolvedSpeed = clampNumber(speed, 0.25, 2, 1);

    try {
      const response = await this.openai.audio.speech.create({
        model: resolvedModel,
        voice: resolvedVoice,
        input: resolvedText,
        speed: resolvedSpeed,
        response_format: resolvedFormat
      });
      const audioBuffer = Buffer.from(await response.arrayBuffer());
      if (!audioBuffer.length) {
        throw new Error("Speech synthesis returned empty audio.");
      }

      this.store.logAction({
        kind: "tts_call",
        guildId: trace.guildId,
        channelId: trace.channelId,
        userId: trace.userId,
        content: resolvedModel,
        metadata: {
          model: resolvedModel,
          voice: resolvedVoice,
          speed: resolvedSpeed,
          responseFormat: resolvedFormat,
          textChars: resolvedText.length,
          source: trace.source || "unknown"
        }
      });

      return {
        audioBuffer,
        model: resolvedModel,
        voice: resolvedVoice,
        speed: resolvedSpeed,
        responseFormat: resolvedFormat
      };
    } catch (error) {
      this.store.logAction({
        kind: "tts_error",
        guildId: trace.guildId,
        channelId: trace.channelId,
        userId: trace.userId,
        content: String(error?.message || error),
        metadata: {
          model: resolvedModel,
          voice: resolvedVoice,
          speed: resolvedSpeed,
          responseFormat: resolvedFormat,
          source: trace.source || "unknown"
        }
      });
      throw error;
    }
  }

  resolveProviderAndModel(llmSettings) {
    const desiredProvider = normalizeLlmProvider(llmSettings?.provider, this.appConfig?.defaultProvider);
    const desiredModel = String(llmSettings?.model || "")
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

  isProviderConfigured(provider) {
    if (provider === "claude-code") return Boolean(this.claudeCodeAvailable);
    if (provider === "anthropic") return Boolean(this.anthropic);
    if (provider === "xai") return Boolean(this.xai);
    return Boolean(this.openai);
  }

  resolveDefaultModel(provider) {
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

  async callOpenAI({
    model,
    systemPrompt,
    userPrompt,
    imageInputs,
    contextMessages,
    temperature,
    maxOutputTokens,
    reasoningEffort,
    jsonSchema = "",
    tools = []
  }) {
    if (!this.openai) {
      throw new Error("OpenAI LLM calls require OPENAI_API_KEY.");
    }

    return this.callOpenAiResponses({
      model,
      systemPrompt,
      userPrompt,
      imageInputs,
      contextMessages,
      temperature,
      maxOutputTokens,
      reasoningEffort,
      jsonSchema,
      tools
    });
  }

  async callXai({
    model,
    systemPrompt,
    userPrompt,
    imageInputs,
    contextMessages,
    temperature,
    maxOutputTokens,
    tools = []
  }) {
    if (!this.xai) {
      throw new Error("xAI LLM calls require XAI_API_KEY.");
    }

    return this.callXaiChatCompletions({
      model,
      systemPrompt,
      userPrompt,
      imageInputs,
      contextMessages,
      temperature,
      maxOutputTokens,
      tools
    });
  }

  async callOpenAiResponses({
    model,
    systemPrompt,
    userPrompt,
    imageInputs,
    contextMessages,
    temperature,
    maxOutputTokens,
    reasoningEffort,
    jsonSchema = "",
    tools = []
  }) {
    const imageParts = imageInputs
      .map((image) => {
        const mediaType = String(image?.mediaType || image?.contentType || "").trim().toLowerCase();
        const base64 = String(image?.dataBase64 || "").trim();
        const url = String(image?.url || "").trim();
        const imageUrl = base64 && /^image\/[a-z0-9.+-]+$/i.test(mediaType) ? `data:${mediaType};base64,${base64}` : url;
        if (!imageUrl) return null;
        return {
          type: "input_image",
          image_url: imageUrl,
          detail: "auto"
        };
      })
      .filter(Boolean);
    const userContent = [
      {
        type: "input_text",
        text: userPrompt
      },
      ...imageParts
    ];

    const normalizedTools = Array.isArray(tools) ? tools : [];
    const openAiTools = normalizedTools.length
      ? normalizedTools.map((t) => ({
        type: "function" as const,
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
        strict: false
      }))
      : [];
    const responseFormat = !openAiTools.length ? buildOpenAiJsonSchemaTextFormat(jsonSchema) : null;
    const response = await this.openai.responses.create({
      model,
      instructions: systemPrompt,
      ...buildOpenAiTemperatureParam(model, temperature),
      ...buildOpenAiReasoningParam(model, reasoningEffort),
      max_output_tokens: maxOutputTokens,
      ...(responseFormat ? { text: responseFormat } : {}),
      ...(openAiTools.length ? { tools: openAiTools } : {}),
      input: [
        ...(contextMessages || []).map((msg) => ({
          role: msg.role === "assistant" ? "assistant" : "user",
          content: String(msg.content || "")
        })),
        {
          role: "user",
          content: userContent
        }
      ]
    });

    const text = extractOpenAiResponseText(response);
    const toolCalls = extractOpenAiToolCalls(response);

    return {
      text,
      toolCalls,
      rawContent: toolCalls.length ? response.output : null,
      usage: extractOpenAiResponseUsage(response)
    };
  }

  async callXaiChatCompletions({
    model,
    systemPrompt,
    userPrompt,
    imageInputs,
    contextMessages,
    temperature,
    maxOutputTokens,
    tools = []
  }) {
    const imageParts = imageInputs
      .map((image) => {
        const mediaType = String(image?.mediaType || image?.contentType || "").trim().toLowerCase();
        const base64 = String(image?.dataBase64 || "").trim();
        const url = String(image?.url || "").trim();
        const imageUrl = base64 && /^image\/[a-z0-9.+-]+$/i.test(mediaType) ? `data:${mediaType};base64,${base64}` : url;
        if (!imageUrl) return null;
        return {
          type: "image_url",
          image_url: {
            url: imageUrl,
            detail: "auto"
          }
        };
      })
      .filter(Boolean);
    const userContent = imageParts.length
      ? [
        { type: "text", text: userPrompt },
        ...imageParts
      ]
      : userPrompt;

    const messages = [
      { role: "system", content: systemPrompt },
      ...(contextMessages || []).map((msg) => ({
        role: msg.role === "assistant" ? "assistant" : "user",
        content: msg.content
      })),
      { role: "user", content: userContent }
    ];

    const normalizedTools = Array.isArray(tools) ? tools : [];
    const xaiTools = normalizedTools.length
      ? normalizedTools.map((t) => ({
        type: "function" as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.input_schema
        }
      }))
      : [];
    const response = await this.xai.chat.completions.create({
      model,
      temperature,
      max_tokens: maxOutputTokens,
      messages,
      ...(xaiTools.length ? { tools: xaiTools } : {})
    });

    const choice = response.choices?.[0];
    const text = choice?.message?.content?.trim() || "";
    const toolCalls = (choice?.message?.tool_calls || []).map((tc) => ({
      id: tc.id || `xai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: tc.function?.name || "",
      input: safeJsonParse(tc.function?.arguments || "{}", {})
    }));

    return {
      text,
      toolCalls,
      rawContent: toolCalls.length ? choice?.message : null,
      usage: {
        inputTokens: Number(response.usage?.prompt_tokens || 0),
        outputTokens: Number(response.usage?.completion_tokens || 0),
        cacheWriteTokens: 0,
        cacheReadTokens: 0
      }
    };
  }

  async callAnthropic({
    model,
    systemPrompt,
    userPrompt,
    imageInputs,
    contextMessages,
    temperature,
    maxOutputTokens,
    tools = []
  }) {
    const imageParts = buildAnthropicImageParts(imageInputs);
    const userContent = imageParts.length
      ? [
        { type: "text", text: userPrompt },
        ...imageParts
      ]
      : userPrompt;

    const messages = [
      ...(contextMessages || []).map((msg) => ({
        role: msg.role === "assistant" ? "assistant" : "user",
        content: msg.content
      })),
      { role: "user", content: userContent }
    ];

    const resolvedTemperature = Math.max(0, Math.min(Number(temperature) || 0, 1));
    const normalizedTools = Array.isArray(tools) ? tools : [];
    const toolsParam = normalizedTools.length
      ? {
        tools: normalizedTools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.input_schema
        }))
      }
      : {};
    const response = await this.anthropic.messages.create({
      model,
      system: systemPrompt,
      temperature: resolvedTemperature,
      max_tokens: maxOutputTokens,
      messages,
      ...toolsParam
    });

    const text = response.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n")
      .trim();

    const toolCalls = response.content
      .filter((item) => item.type === "tool_use")
      .map((item) => ({
        id: item.id,
        name: item.name,
        input: item.input
      }));

    return {
      text,
      toolCalls,
      rawContent: toolCalls.length ? response.content : null,
      stopReason: response.stop_reason || "end_turn",
      usage: {
        inputTokens: Number(response.usage?.input_tokens || 0),
        outputTokens: Number(response.usage?.output_tokens || 0),
        cacheWriteTokens: Number(response.usage?.cache_creation_input_tokens || 0),
        cacheReadTokens: Number(response.usage?.cache_read_input_tokens || 0)
      }
    };
  }

  async chatWithTools({
    provider = "anthropic",
    model = "claude-sonnet-4-5-20250929",
    systemPrompt,
    messages,
    tools,
    maxOutputTokens = 4096,
    temperature = 0.7,
    trace = {
      guildId: null as string | null,
      channelId: null as string | null,
      userId: null as string | null,
      source: null as string | null
    },
    signal
  }: {
    provider?: string;
    model?: string;
    systemPrompt: string;
    messages: ToolLoopMessage[];
    tools: Array<{
      name: string;
      description: string;
      input_schema: Anthropic.Tool.InputSchema;
    }>;
    maxOutputTokens?: number;
    temperature?: number;
    trace?: {
      guildId?: string | null;
      channelId?: string | null;
      userId?: string | null;
      source?: string | null;
    };
    signal?: AbortSignal;
  }): Promise<{
    content: ToolLoopContentBlock[];
    stopReason: string;
    usage: { inputTokens: number; outputTokens: number; cacheWriteTokens: number; cacheReadTokens: number };
    costUsd: number;
  }> {
    const resolvedProvider = normalizeLlmProvider(provider, "anthropic");
    const resolvedModel = String(model || "claude-sonnet-4-5-20250929").trim();
    const resolvedTemperature = Math.max(0, Math.min(Number(temperature) || 0, 1));
    let content: ToolLoopContentBlock[] = [];
    let stopReason = "end_turn";
    let usage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0
    };

    if (resolvedProvider === "anthropic") {
      if (!this.anthropic) {
        throw new Error("chatWithTools requires ANTHROPIC_API_KEY.");
      }

      const response = await this.anthropic.messages.create({
        model: resolvedModel,
        system: systemPrompt,
        temperature: resolvedTemperature,
        max_tokens: maxOutputTokens,
        messages: buildAnthropicToolLoopMessages(messages),
        tools
      }, { signal });

      content = response.content.flatMap((block) => {
        if (block.type === "text") {
          const text = String(block.text || "").trim();
          return text ? [{ type: "text" as const, text }] : [];
        }
        if (block.type === "tool_use") {
          return [{
            type: "tool_call" as const,
            id: block.id,
            name: block.name,
            input: block.input as Record<string, unknown>
          }];
        }
        return [];
      });
      stopReason = response.stop_reason || "end_turn";
      usage = {
        inputTokens: Number(response.usage?.input_tokens || 0),
        outputTokens: Number(response.usage?.output_tokens || 0),
        cacheWriteTokens: Number(response.usage?.cache_creation_input_tokens || 0),
        cacheReadTokens: Number(response.usage?.cache_read_input_tokens || 0)
      };
    } else if (resolvedProvider === "openai") {
      if (!this.openai) {
        throw new Error("chatWithTools requires OPENAI_API_KEY.");
      }

      const response = await this.openai.responses.create({
        model: resolvedModel,
        instructions: systemPrompt,
        ...buildOpenAiTemperatureParam(resolvedModel, resolvedTemperature),
        ...buildOpenAiReasoningParam(resolvedModel, "minimal"),
        max_output_tokens: maxOutputTokens,
        tools: tools.map((tool) => ({
          type: "function" as const,
          name: tool.name,
          description: tool.description,
          parameters: tool.input_schema,
          strict: false
        })),
        input: buildOpenAiToolLoopInput(messages)
      }, { signal });

      content = buildToolLoopContentFromOpenAiOutput(response.output);
      usage = extractOpenAiResponseUsage(response);
    } else {
      throw new Error(`Browser agent tool loop does not support provider '${resolvedProvider}'.`);
    }

    const costUsd = estimateUsdCost({
      provider: resolvedProvider,
      model: resolvedModel,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      cacheReadTokens: usage.cacheReadTokens
    });

    this.store.logAction({
      kind: "llm_tool_call",
      guildId: trace.guildId || null,
      channelId: trace.channelId || null,
      userId: trace.userId || null,
      content: `${resolvedProvider}:${resolvedModel}`,
      metadata: {
        provider: resolvedProvider,
        model: resolvedModel,
        usage,
        source: trace.source || null
      },
      usdCost: costUsd
    });

    return {
      content,
      stopReason,
      usage,
      costUsd
    };
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
