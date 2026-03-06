import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import { estimateUsdCost } from "../pricing.ts";
import { extractOpenAiResponseUsage, normalizeLlmProvider } from "./llmHelpers.ts";
import {
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
  anthropic: Anthropic | null;
  store: LlmActionStore;
};

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

  if (resolvedProvider === "anthropic") {
    if (!deps.anthropic) {
      throw new Error("chatWithTools requires ANTHROPIC_API_KEY.");
    }

    const requestBody = {
      model: resolvedModel,
      system: systemPrompt,
      temperature: resolvedTemperature,
      max_tokens: maxOutputTokens,
      messages: buildAnthropicToolLoopMessages(messages),
      tools
    } as Parameters<typeof deps.anthropic.messages.create>[0];
    const response = await deps.anthropic.messages.create(requestBody as never, { signal }) as {
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
  } else if (resolvedProvider === "openai") {
    if (!deps.openai) {
      throw new Error("chatWithTools requires OPENAI_API_KEY.");
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
    } as Parameters<typeof deps.openai.responses.create>[0];
    const response = await deps.openai.responses.create(requestBody as never, { signal });
    const responseWithOutput = response as { output?: unknown };

    content = buildToolLoopContentFromOpenAiOutput(responseWithOutput.output);
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
