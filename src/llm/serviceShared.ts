import type Anthropic from "@anthropic-ai/sdk";
import { safeJsonParse } from "../llmClaudeCode.ts";
import {
  MEMORY_FACT_SUBJECTS,
  MEMORY_FACT_TYPES,
  normalizeOpenAiReasoningEffort
} from "./llmHelpers.ts";

export const XAI_REQUEST_TIMEOUT_MS = 20_000;

export type UsageMetrics = {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
};

export type LlmTrace = {
  guildId?: string | null;
  channelId?: string | null;
  userId?: string | null;
  source?: string | null;
  event?: string | null;
  reason?: string | null;
  messageId?: string | null;
};

export type ImageInput = {
  mediaType?: string | null;
  contentType?: string | null;
  dataBase64?: string | null;
  url?: string | null;
};

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };

export type ContextMessage = {
  role?: string | null;
  content?: string | null | ContentBlock[];
};

export type ChatTool = {
  name: string;
  description: string;
  input_schema: Anthropic.Tool.InputSchema;
};

export type LlmToolCall = {
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type ChatModelRequest = {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  imageInputs?: ImageInput[];
  contextMessages?: ContextMessage[];
  temperature: number;
  maxOutputTokens: number;
  reasoningEffort?: unknown;
  jsonSchema?: string;
  tools?: ChatTool[];
};

export type ChatModelResponse = {
  text: string;
  toolCalls?: LlmToolCall[];
  rawContent?: unknown;
  stopReason?: string;
  usage: UsageMetrics;
  costUsd?: number;
};

export type MemoryExtractionRequest = {
  model: string;
  systemPrompt: string;
  userPrompt: string;
};

export type MemoryExtractionResponse = {
  text: string;
  usage: UsageMetrics;
  costUsd?: number;
};

export type LlmActionStore = {
  logAction: (entry: {
    kind: string;
    guildId?: string | null;
    channelId?: string | null;
    userId?: string | null;
    content?: string;
    metadata?: Record<string, unknown>;
    usdCost?: number;
  }) => void;
};

export type LLMAppConfig = {
  openaiApiKey?: string | null;
  xaiApiKey?: string | null;
  xaiBaseUrl?: string | null;
  anthropicApiKey?: string | null;
  defaultProvider?: string | null;
  defaultOpenAiModel?: string | null;
  defaultAnthropicModel?: string | null;
  defaultXaiModel?: string | null;
  defaultClaudeCodeModel?: string | null;
  defaultMemoryEmbeddingModel?: string | null;
};

type ToolLoopTextBlock = {
  type: "text";
  text: string;
};

type ToolLoopToolCall = {
  type: "tool_call";
  id: string;
  name: string;
  input: Record<string, unknown>;
};

type ToolLoopToolResult = {
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

export type XaiJsonPrimitive = string | number | boolean | null;
export type XaiJsonValue = XaiJsonPrimitive | XaiJsonRecord | XaiJsonValue[];
export type XaiJsonRecord = {
  [key: string]: XaiJsonValue;
};

export type XaiJsonRequestOptions = {
  method?: string;
  body?: XaiJsonRecord | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeContextText(value: unknown) {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

function normalizeContentBlockInput(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = safeJsonParse(value, null);
    if (isRecord(parsed)) {
      return parsed;
    }
  }
  return {};
}

function normalizeCanonicalContentBlocks(value: unknown): ContentBlock[] {
  if (!Array.isArray(value)) return [];

  const blocks: ContentBlock[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;

    if (item.type === "text") {
      const text = normalizeContextText(item.text);
      if (text) {
        blocks.push({ type: "text", text });
      }
      continue;
    }

    if (item.type === "tool_use" || item.type === "tool_call") {
      const id = normalizeContextText(item.id);
      const name = normalizeContextText(item.name);
      if (!id || !name) continue;
      blocks.push({
        type: "tool_use",
        id,
        name,
        input: normalizeContentBlockInput(item.input)
      });
      continue;
    }

    if (item.type === "tool_result") {
      const toolUseId = normalizeContextText(item.tool_use_id ?? item.toolCallId);
      const content = normalizeContextText(item.content);
      if (!toolUseId || !content) continue;
      blocks.push({
        type: "tool_result",
        tool_use_id: toolUseId,
        content
      });
    }
  }

  return blocks;
}

function normalizeOpenAiRawContent(value: unknown): ContentBlock[] {
  if (!Array.isArray(value)) return [];

  const blocks: ContentBlock[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;

    if (item.type === "message" && item.role === "assistant") {
      const contentParts = Array.isArray(item.content) ? item.content : [];
      for (const part of contentParts) {
        if (!isRecord(part)) continue;
        if (part.type === "output_text") {
          const text = normalizeContextText(part.text);
          if (text) {
            blocks.push({ type: "text", text });
          }
          continue;
        }
        if (part.type === "refusal") {
          const text = normalizeContextText(part.refusal);
          if (text) {
            blocks.push({ type: "text", text });
          }
        }
      }
      continue;
    }

    if (item.type !== "function_call") continue;
    const id = normalizeContextText(item.call_id ?? item.id);
    const name = normalizeContextText(item.name);
    if (!id || !name) continue;
    blocks.push({
      type: "tool_use",
      id,
      name,
      input: normalizeContentBlockInput(item.arguments)
    });
  }

  return blocks;
}

function normalizeXaiRawContent(value: unknown): ContentBlock[] {
  if (!isRecord(value)) return [];

  const blocks: ContentBlock[] = [];
  const text = normalizeContextText(value.content);
  if (text) {
    blocks.push({ type: "text", text });
  }

  const toolCalls = Array.isArray(value.tool_calls) ? value.tool_calls : [];
  for (const toolCall of toolCalls) {
    if (!isRecord(toolCall)) continue;
    const id = normalizeContextText(toolCall.id);
    const functionPayload = isRecord(toolCall.function) ? toolCall.function : {};
    const name = normalizeContextText(functionPayload.name);
    if (!id || !name) continue;
    blocks.push({
      type: "tool_use",
      id,
      name,
      input: normalizeContentBlockInput(functionPayload.arguments)
    });
  }

  return blocks;
}

export function buildContextContentBlocks(rawContent: unknown, fallbackText = ""): ContentBlock[] {
  const canonicalBlocks = normalizeCanonicalContentBlocks(rawContent);
  if (canonicalBlocks.length > 0) return canonicalBlocks;

  const openAiBlocks = normalizeOpenAiRawContent(rawContent);
  if (openAiBlocks.length > 0) return openAiBlocks;

  const xaiBlocks = normalizeXaiRawContent(rawContent);
  if (xaiBlocks.length > 0) return xaiBlocks;

  const text = normalizeContextText(fallbackText);
  return text ? [{ type: "text", text }] : [];
}

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

export function appendJsonSchemaInstruction(systemPrompt: string, jsonSchema: string) {
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

export function buildAnthropicToolLoopMessages(messages: ToolLoopMessage[]): Anthropic.MessageParam[] {
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

export function buildOpenAiToolLoopInput(messages: ToolLoopMessage[]) {
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

export function buildToolLoopContentFromOpenAiOutput(output: unknown): ToolLoopContentBlock[] {
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
