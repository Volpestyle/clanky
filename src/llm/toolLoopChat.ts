import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import { estimateUsdCost } from "./pricing.ts";
import { extractOpenAiResponseUsage, normalizeLlmProvider } from "./llmHelpers.ts";
import {
  addAnthropicCacheBreakpointToLastItem,
  buildAnthropicCachedSystemPrompt,
  buildAnthropicToolLoopMessages,
  buildOpenAiReasoningParam,
  buildOpenAiTemperatureParam,
  buildOpenAiToolLoopInput,
  buildToolLoopContentFromOpenAiOutput,
  type LlmActionStore,
  type LlmTrace,
  type ToolLoopContentBlock,
  type ToolLoopMessage
} from "./serviceShared.ts";

export type ToolLoopChatDeps = {
  openai: OpenAI | null;
  xai: OpenAI | null;
  anthropic: Anthropic | null;
  claudeOAuthClient: Anthropic | null;
  codexOAuthClient: OpenAI | null;
  store: LlmActionStore;
};

function parseToolLoopJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export async function chatWithTools(
  deps: ToolLoopChatDeps,
  {
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
    trace?: LlmTrace;
    signal?: AbortSignal;
  }
): Promise<{
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

  if (resolvedProvider === "anthropic" || resolvedProvider === "claude-oauth") {
    const anthropicClient = resolvedProvider === "claude-oauth" ? deps.claudeOAuthClient : deps.anthropic;
    if (!anthropicClient) {
      throw new Error(
        resolvedProvider === "claude-oauth"
          ? "chatWithTools requires CLAUDE_OAUTH_REFRESH_TOKEN."
          : "chatWithTools requires ANTHROPIC_API_KEY."
      );
    }

    const cachedSystemPrompt = buildAnthropicCachedSystemPrompt(systemPrompt);
    const requestBody = {
      model: resolvedModel,
      ...(cachedSystemPrompt ? { system: cachedSystemPrompt } : {}),
      temperature: resolvedTemperature,
      max_tokens: maxOutputTokens,
      messages: buildAnthropicToolLoopMessages(messages),
      tools: addAnthropicCacheBreakpointToLastItem(tools, !cachedSystemPrompt)
    } as Parameters<typeof anthropicClient.messages.create>[0];
    const response = await anthropicClient.messages.create(requestBody as never, { signal }) as {
      content: Array<{
        type: string;
        text?: string;
        id?: string;
        name?: string;
        input?: Record<string, unknown>;
      }>;
      stop_reason?: string;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
      };
    };

    const nextContent: ToolLoopContentBlock[] = [];
    for (const block of response.content) {
      if (block.type === "text") {
        const text = String(block.text || "").trim();
        if (text) {
          nextContent.push({ type: "text", text });
        }
        continue;
      }
      if (block.type === "tool_use") {
        nextContent.push({
          type: "tool_call",
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>
        });
      }
    }
    content = nextContent;
    stopReason = response.stop_reason || "end_turn";
    usage = {
      inputTokens: Number(response.usage?.input_tokens || 0),
      outputTokens: Number(response.usage?.output_tokens || 0),
      cacheWriteTokens: Number(response.usage?.cache_creation_input_tokens || 0),
      cacheReadTokens: Number(response.usage?.cache_read_input_tokens || 0)
    };
  } else if (resolvedProvider === "openai" || resolvedProvider === "openai-oauth") {
    const openAiClient = resolvedProvider === "openai-oauth" ? deps.codexOAuthClient : deps.openai;
    if (!openAiClient) {
      throw new Error(
        resolvedProvider === "openai-oauth"
          ? "chatWithTools requires OPENAI_OAUTH_REFRESH_TOKEN."
          : "chatWithTools requires OPENAI_API_KEY."
      );
    }

    const requestBody = {
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
    } as Parameters<typeof openAiClient.responses.create>[0];
    const response = await openAiClient.responses.create(requestBody as never, { signal });
    const responseWithOutput = response as { output?: unknown };

    content = buildToolLoopContentFromOpenAiOutput(responseWithOutput.output);
    usage = extractOpenAiResponseUsage(response);
  } else if (resolvedProvider === "xai") {
    if (!deps.xai) {
      throw new Error("chatWithTools requires XAI_API_KEY.");
    }

    type XaiChatRequest = Parameters<typeof deps.xai.chat.completions.create>[0];
    type XaiChatMessage = NonNullable<XaiChatRequest["messages"]>[number];

    const xaiMessages: XaiChatMessage[] = [
      { role: "system", content: systemPrompt }
    ];
    for (const message of messages) {
      if (typeof message.content === "string") {
        xaiMessages.push({
          role: message.role,
          content: message.content
        });
        continue;
      }
      const textBlocks = message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text.trim())
        .filter(Boolean);
      if (message.role === "assistant") {
        const toolCalls = message.content
          .filter((block) => block.type === "tool_call")
          .map((block) => ({
            id: block.id,
            type: "function" as const,
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input || {})
            }
          }));
        if (textBlocks.length > 0 || toolCalls.length > 0) {
          xaiMessages.push({
            role: "assistant",
            content: textBlocks.join("\n\n"),
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
          });
        }
        continue;
      }
      if (textBlocks.length > 0) {
        xaiMessages.push({
          role: "user",
          content: textBlocks.join("\n\n")
        });
      }
      for (const block of message.content) {
        if (block.type !== "tool_result") continue;
        xaiMessages.push({
          role: "tool",
          tool_call_id: block.toolCallId,
          content: block.content
        });
      }
    }

    const requestBody: XaiChatRequest = {
      model: resolvedModel,
      temperature: resolvedTemperature,
      max_tokens: maxOutputTokens,
      messages: xaiMessages,
      tools: tools.map((tool) => ({
        type: "function" as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.input_schema
        }
      }))
    };
    const response = await deps.xai.chat.completions.create(requestBody as never, signal ? { signal } : undefined) as {
      choices?: Array<{
        finish_reason?: string | null;
        message?: {
          content?: string | null;
          tool_calls?: Array<{
            id?: string | null;
            function?: {
              name?: string | null;
              arguments?: string | null;
            } | null;
          }> | null;
        } | null;
      }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
      };
    };
    const choice = response.choices?.[0];
    const nextContent: ToolLoopContentBlock[] = [];
    const responseText = String(choice?.message?.content || "").trim();
    if (responseText) {
      nextContent.push({ type: "text", text: responseText });
    }
    for (const toolCall of choice?.message?.tool_calls || []) {
      const name = String(toolCall?.function?.name || "").trim();
      if (!name) continue;
      nextContent.push({
        type: "tool_call",
        id: String(toolCall?.id || `xai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
        name,
        input: parseToolLoopJsonObject(toolCall?.function?.arguments)
      });
    }
    content = nextContent;
    stopReason = String(choice?.finish_reason || "").trim() || "end_turn";
    usage = {
      inputTokens: Number(response.usage?.prompt_tokens || 0),
      outputTokens: Number(response.usage?.completion_tokens || 0),
      cacheWriteTokens: 0,
      cacheReadTokens: 0
    };
  } else {
    throw new Error(`Tool loop does not support provider '${resolvedProvider}'.`);
  }

  const costUsd = estimateUsdCost({
    provider: resolvedProvider,
    model: resolvedModel,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    cacheReadTokens: usage.cacheReadTokens
  });

  deps.store.logAction({
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
