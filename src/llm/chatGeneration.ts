import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import { buildAnthropicImageParts, safeJsonParse } from "./llmClaudeCode.ts";
import {
  getRetryDelayMs,
  isRetryableFetchError,
  shouldRetryHttpStatus,
  withAttemptCount
} from "../retry.ts";
import {
  extractOpenAiResponseText,
  extractOpenAiResponseUsage,
  extractOpenAiToolCalls
} from "./llmHelpers.ts";
import {
  addAnthropicCacheBreakpointToLastItem,
  appendJsonSchemaInstruction,
  buildAnthropicCachedSystemPrompt,
  buildContextContentBlocks,
  buildOpenAiJsonSchemaTextFormat,
  buildOpenAiReasoningParam,
  buildOpenAiToolLoopInput,
  buildOpenAiTemperatureParam,
  type ContentBlock,
  type ChatModelStreamCallbacks,
  type ChatModelRequest,
  type ToolLoopContentBlock,
  type ToolLoopMessage
} from "./serviceShared.ts";
import { sleep } from "../utils.ts";

export type ChatGenerationDeps = {
  openai: OpenAI | null;
  xai: OpenAI | null;
  anthropic: Anthropic | null;
};

const ANTHROPIC_TRANSIENT_MAX_ATTEMPTS = 2;

type AnthropicErrorLike = {
  status?: unknown;
  message?: unknown;
  error?: {
    type?: unknown;
    message?: unknown;
  } | null;
};

function resolveAbortError(signal?: AbortSignal) {
  if (!signal?.aborted) return null;
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const normalizedReason = String(reason || "").trim();
  return new Error(normalizedReason || "Anthropic request aborted.");
}

function throwIfAborted(signal?: AbortSignal) {
  const error = resolveAbortError(signal);
  if (error) throw error;
}

function isRetryableAnthropicError(error: unknown) {
  const normalized = error && typeof error === "object"
    ? error as AnthropicErrorLike
    : null;
  const status = Number(normalized?.status);
  if (status === 529 || shouldRetryHttpStatus(status)) return true;
  if (isRetryableFetchError(error)) return true;

  const errorType = String(normalized?.error?.type || "").trim().toLowerCase();
  if (errorType === "overloaded_error" || errorType === "rate_limit_error" || errorType === "timeout_error") {
    return true;
  }

  const normalizedMessage = String(normalized?.message || normalized?.error?.message || "").trim().toLowerCase();
  return normalizedMessage.includes("overloaded") ||
    normalizedMessage.includes("rate limit") ||
    normalizedMessage.includes("rate_limit") ||
    normalizedMessage.includes("timed out") ||
    normalizedMessage.includes("timeout");
}

async function sleepForAnthropicRetry(attempt: number, signal?: AbortSignal) {
  throwIfAborted(signal);
  await sleep(getRetryDelayMs(attempt));
  throwIfAborted(signal);
}

function buildAnthropicMessagesRequest({
  model,
  systemPrompt,
  userPrompt,
  imageInputs = [],
  contextMessages = [],
  temperature,
  maxOutputTokens,
  thinking,
  thinkingBudgetTokens,
  jsonSchema = "",
  tools = []
}: ChatModelRequest) {
  const imageParts = buildAnthropicImageParts(imageInputs);
  const normalizedUserPrompt = String(userPrompt || "");
  const userContent: string | Array<Record<string, unknown>> = imageParts.length
    ? [
        ...(normalizedUserPrompt.trim()
          ? [{ type: "text", text: normalizedUserPrompt } as Record<string, unknown>]
          : []),
        ...imageParts
      ]
    : normalizedUserPrompt;

  const contextMapped = contextMessages.map((msg) => ({
    role: msg.role === "assistant" ? "assistant" : "user",
    content: msg.content
  }));
  // When userPrompt is empty and there are no images, skip the trailing user
  // message — avoids consecutive user turns in tool-loop re-prompts.
  const hasUserContent = typeof userContent === "string" ? userContent.trim().length > 0 : userContent.length > 0;
  const messages = hasUserContent
    ? [...contextMapped, { role: "user", content: userContent }]
    : contextMapped;

  const resolvedTemperature = Math.max(0, Math.min(Number(temperature) || 0, 1));
  const normalizedTools = Array.isArray(tools) ? tools : [];
  const effectiveSystemPrompt = appendJsonSchemaInstruction(systemPrompt, jsonSchema);
  const cachedSystemPrompt = buildAnthropicCachedSystemPrompt(effectiveSystemPrompt);
  // Strict tools are only supported by Claude models from Sonnet 4.5 onward.
  // Older models (Sonnet 4.0, 3.x, etc.) reject the parameter with a 400 error.
  const modelSupportsStrictTools = (() => {
    const m = String(model || "");
    if (!m) return true;
    // claude-3-* models (3.5, 3.7, etc.) don't support strict tools
    if (m.startsWith("claude-3")) return false;
    // claude-sonnet-4-0, claude-sonnet-4 (base, no point release) don't support strict tools
    if (m === "claude-sonnet-4" || m === "claude-sonnet-4-0" || m.startsWith("claude-sonnet-4-0-")) return false;
    if (m === "claude-opus-4" || m === "claude-opus-4-0" || m.startsWith("claude-opus-4-0-")) return false;
    // claude-haiku-3 doesn't support strict tools
    if (m.startsWith("claude-haiku-3")) return false;
    return true;
  })();
  const toolsParam = normalizedTools.length
    ? {
        tools: addAnthropicCacheBreakpointToLastItem(normalizedTools, !cachedSystemPrompt).map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.input_schema,
          ...(tool.cache_control ? { cache_control: tool.cache_control } : {}),
          ...(modelSupportsStrictTools && tool.strict ? { strict: true } : {})
        }))
      }
    : {};

  // The interleaved-thinking beta header (required by claude-oauth) mandates an
  // explicit thinking parameter on every request. Default to disabled when the
  // caller doesn't specify a thinking mode.
  const thinkingParam = (thinking === "enabled" || thinking === "think_aloud")
    ? {
        thinking: {
          type: "enabled" as const,
          budget_tokens: Math.max(128, Math.min(thinkingBudgetTokens || 1024, maxOutputTokens - 1))
        }
      }
    : { thinking: { type: "disabled" as const } };

  return {
    model,
    ...(cachedSystemPrompt ? { system: cachedSystemPrompt } : {}),
    temperature: resolvedTemperature,
    max_tokens: maxOutputTokens,
    messages,
    ...toolsParam,
    ...thinkingParam
  } as Parameters<Anthropic["messages"]["create"]>[0];
}

function buildAnthropicResponse(
  response: {
    content: Array<{
      type: string;
      text?: string;
      thinking?: string;
      id?: string;
      name?: string;
      input?: Record<string, unknown>;
    }>;
    stop_reason?: string | null;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  }
) {
  const text = response.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n")
    .trim();

  const thinkingText = response.content
    .filter((item) => item.type === "thinking")
    .map((item) => item.thinking || "")
    .join("\n")
    .trim();

  const toolCalls = response.content
    .filter((item) => item.type === "tool_use")
    .map((item) => ({
      id: String(item.id || ""),
      name: String(item.name || ""),
      input: item.input || {}
    }))
    .filter((item) => item.id && item.name);

  return {
    text,
    ...(thinkingText ? { thinkingText } : {}),
    toolCalls,
    rawContent: response.content,
    stopReason: response.stop_reason || "end_turn",
    usage: {
      inputTokens: Number(response.usage?.input_tokens || 0),
      outputTokens: Number(response.usage?.output_tokens || 0),
      cacheWriteTokens: Number(response.usage?.cache_creation_input_tokens || 0),
      cacheReadTokens: Number(response.usage?.cache_read_input_tokens || 0)
    }
  };
}

type OpenAiResponsesOutputItem = {
  id?: string;
  type?: string;
  role?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
  content?: Array<{
    type?: string;
    text?: string;
    refusal?: string;
    annotations?: unknown[];
  }>;
};

type OpenAiResponsesResponseLike = {
  status?: string;
  output_text?: string;
  output?: OpenAiResponsesOutputItem[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: {
      cached_tokens?: number;
    };
  };
};

type OpenAiResponsesStreamEvent = {
  type: string;
  delta?: string;
  item_id?: string;
  output_index?: number;
  item?: OpenAiResponsesOutputItem;
  response?: OpenAiResponsesResponseLike;
  error?: { message?: string } | string | null;
};

function buildOpenAiImageParts(imageInputs: ChatModelRequest["imageInputs"] = []) {
  return imageInputs
    .map((image) => {
      const mediaType = String(image?.mediaType || image?.contentType || "").trim().toLowerCase();
      const base64 = String(image?.dataBase64 || "").trim();
      const url = String(image?.url || "").trim();
      const imageUrl = base64 && /^image\/[a-z0-9.+-]+$/i.test(mediaType) ? `data:${mediaType};base64,${base64}` : url;
      if (!imageUrl) return null;
      return {
        type: "input_image" as const,
        image_url: imageUrl,
        detail: "auto" as const
      };
    })
    .filter((image): image is { type: "input_image"; image_url: string; detail: "auto" } => image !== null);
}

function buildOpenAiUserContent({
  userPrompt,
  imageInputs = []
}: Pick<ChatModelRequest, "userPrompt" | "imageInputs">) {
  const normalizedUserPrompt = String(userPrompt || "");
  const userContent: Array<Record<string, unknown>> = [];
  if (normalizedUserPrompt.trim()) {
    userContent.push({
      type: "input_text",
      text: normalizedUserPrompt
    });
  }
  userContent.push(...buildOpenAiImageParts(imageInputs));
  return userContent;
}

function buildOpenAiResponsesInput({
  contextMessages = [],
  userPrompt,
  imageInputs = []
}: Pick<ChatModelRequest, "contextMessages" | "userPrompt" | "imageInputs">) {
  const normalizedContextMessages = Array.isArray(contextMessages) ? contextMessages : [];
  const hasStructuredContext = normalizedContextMessages.some((msg) => Array.isArray(msg?.content));
  const contextInput = hasStructuredContext
    ? buildOpenAiToolLoopInput(
      normalizedContextMessages.map((msg) => ({
        role: msg.role === "assistant" ? "assistant" : "user",
        content: toToolLoopMessageContent(msg.content)
      }))
    )
    : normalizedContextMessages.map((msg) => ({
      role: msg.role === "assistant" ? "assistant" : "user",
      content: String(msg.content || "")
    }));
  const userContent = buildOpenAiUserContent({ userPrompt, imageInputs });

  return userContent.length
    ? [
      ...contextInput,
      {
        role: "user",
        content: userContent
      }
    ]
    : contextInput;
}

function toToolLoopMessageContent(content: string | ContentBlock[] | null | undefined): ToolLoopMessage["content"] {
  if (!Array.isArray(content)) {
    return String(content || "");
  }

  const blocks: ToolLoopContentBlock[] = [];
  for (const block of content) {
    if (block.type === "text") {
      blocks.push({
        type: "text",
        text: block.text
      });
      continue;
    }
    if (block.type === "tool_use") {
      blocks.push({
        type: "tool_call",
        id: block.id,
        name: block.name,
        input: block.input
      });
      continue;
    }
    blocks.push({
      type: "tool_result",
      toolCallId: block.tool_use_id,
      content: block.content
    });
  }
  return blocks;
}

function isAsyncIterable<T>(value: object): value is AsyncIterable<T> {
  return typeof Reflect.get(value, Symbol.asyncIterator) === "function";
}

function buildOpenAiResponsesRequestBody({
  model,
  systemPrompt,
  userPrompt,
  imageInputs = [],
  contextMessages = [],
  temperature,
  maxOutputTokens,
  reasoningEffort,
  jsonSchema = "",
  tools = []
}: ChatModelRequest) {
  const effectiveSystemPrompt = appendJsonSchemaInstruction(systemPrompt, jsonSchema);
  const normalizedTools = Array.isArray(tools) ? tools : [];
  const openAiTools = normalizedTools.length
    ? normalizedTools.map((tool) => ({
      type: "function" as const,
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
      strict: false
    }))
    : [];
  const responseFormat = !openAiTools.length ? buildOpenAiJsonSchemaTextFormat(jsonSchema) : null;

  return {
    model,
    instructions: effectiveSystemPrompt,
    ...buildOpenAiTemperatureParam(model, temperature),
    ...buildOpenAiReasoningParam(model, reasoningEffort),
    max_output_tokens: maxOutputTokens,
    ...(responseFormat ? { text: responseFormat } : {}),
    ...(openAiTools.length ? { tools: openAiTools } : {}),
    input: buildOpenAiResponsesInput({
      contextMessages,
      userPrompt,
      imageInputs
    })
  };
}

function getOpenAiStreamEventErrorMessage(error: OpenAiResponsesStreamEvent["error"]) {
  if (!error) return "";
  if (typeof error === "string") return error;
  return String(error.message || "").trim();
}

export async function callOpenAI(deps: ChatGenerationDeps, request: ChatModelRequest) {
  if (!deps.openai) {
    throw new Error("OpenAI LLM calls require OPENAI_API_KEY.");
  }

  return callOpenAiResponses(deps, request);
}

export async function callXai(deps: ChatGenerationDeps, request: ChatModelRequest) {
  if (!deps.xai) {
    throw new Error("xAI LLM calls require XAI_API_KEY.");
  }

  return callXaiChatCompletions(deps, request);
}

export async function callOpenAiResponses(
  deps: Pick<ChatGenerationDeps, "openai">,
  {
    model,
    systemPrompt,
    userPrompt,
    imageInputs = [],
    contextMessages = [],
    temperature,
    maxOutputTokens,
    reasoningEffort,
    jsonSchema = "",
    tools = [],
    signal
  }: ChatModelRequest
) {
  if (!deps.openai) {
    throw new Error("OpenAI LLM calls require OPENAI_API_KEY.");
  }

  const requestBody = buildOpenAiResponsesRequestBody({
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
  }) as Parameters<typeof deps.openai.responses.create>[0];
  const response = await deps.openai.responses.create(requestBody as never, signal ? { signal } : undefined);
  const responseWithOutput = response as OpenAiResponsesResponseLike;

  const text = extractOpenAiResponseText(response);
  const toolCalls = extractOpenAiToolCalls(response);

  return {
    text,
    toolCalls,
    rawContent: responseWithOutput.output || null,
    stopReason: String(responseWithOutput.status || "").trim() || undefined,
    usage: extractOpenAiResponseUsage(response)
  };
}

export async function callOpenAiResponsesStreaming(
  deps: Pick<ChatGenerationDeps, "openai">,
  request: ChatModelRequest,
  callbacks: ChatModelStreamCallbacks
) {
  if (!deps.openai) {
    throw new Error("OpenAI LLM calls require OPENAI_API_KEY.");
  }

  const abortSignal = callbacks.signal || request.signal;
  const requestBody = {
    ...buildOpenAiResponsesRequestBody(request),
    stream: true as const
  } as Parameters<typeof deps.openai.responses.create>[0];
  const streamResponse = await deps.openai.responses.create(
    requestBody as never,
    abortSignal ? { signal: abortSignal } : undefined
  );
  if (!streamResponse || typeof streamResponse !== "object" || !isAsyncIterable<OpenAiResponsesStreamEvent>(streamResponse)) {
    throw new Error("OpenAI streaming response did not expose an async iterator.");
  }
  const stream = streamResponse;
  let finalResponse: OpenAiResponsesResponseLike | null = null;
  let streamErrorMessage = "";

  for await (const event of stream) {
    if (event.type === "response.output_text.delta") {
      callbacks.onTextDelta(String(event.delta || ""));
      continue;
    }
    if (event.type === "response.function_call_arguments.delta") {
      continue;
    }
    if (event.type === "response.completed") {
      finalResponse = event.response || null;
      continue;
    }
    if (event.type === "error") {
      streamErrorMessage = getOpenAiStreamEventErrorMessage(event.error);
    }
  }

  if (!finalResponse) {
    throw new Error(streamErrorMessage || "OpenAI response stream ended without a completed response.");
  }

  const normalized = {
    text: extractOpenAiResponseText(finalResponse),
    toolCalls: extractOpenAiToolCalls(finalResponse),
    rawContent: finalResponse.output || null,
    stopReason: String(finalResponse.status || "").trim() || undefined,
    usage: extractOpenAiResponseUsage(finalResponse)
  };
  if (typeof callbacks.onContentBlockComplete === "function") {
    const completedBlocks = buildContextContentBlocks(finalResponse.output || null, normalized.text);
    for (const block of completedBlocks) {
      if (block.type === "text" || block.type === "tool_use") {
        callbacks.onContentBlockComplete(block);
      }
    }
  }
  callbacks.onComplete?.(normalized);
  return normalized;
}

export async function callXaiChatCompletions(
  deps: Pick<ChatGenerationDeps, "xai">,
  {
    model,
    systemPrompt,
    userPrompt,
    imageInputs = [],
    contextMessages = [],
    temperature,
    maxOutputTokens,
    jsonSchema = "",
    tools = [],
    signal
  }: ChatModelRequest
) {
  if (!deps.xai) {
    throw new Error("xAI LLM calls require XAI_API_KEY.");
  }

  const effectiveSystemPrompt = appendJsonSchemaInstruction(systemPrompt, jsonSchema);
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
  const normalizedUserPrompt = String(userPrompt || "");
  const userContent = imageParts.length
    ? [
        ...(normalizedUserPrompt.trim()
          ? [{ type: "text", text: normalizedUserPrompt } as Record<string, unknown>]
          : []),
        ...imageParts
      ]
    : normalizedUserPrompt;

  const messages = [
    { role: "system", content: effectiveSystemPrompt },
    ...contextMessages.map((msg) => ({
      role: msg.role === "assistant" ? "assistant" : "user",
      content: msg.content
    })),
    { role: "user", content: userContent }
  ];

  const normalizedTools = Array.isArray(tools) ? tools : [];
  const xaiTools = normalizedTools.length
    ? normalizedTools.map((tool) => ({
        type: "function" as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.input_schema
        }
      }))
    : [];
  const requestBody = {
    model,
    temperature,
    max_tokens: maxOutputTokens,
    messages,
    ...(xaiTools.length ? { tools: xaiTools } : {})
  } as Parameters<typeof deps.xai.chat.completions.create>[0];
  const response = await deps.xai.chat.completions.create(requestBody as never, signal ? { signal } : undefined) as {
    choices?: Array<{
      finish_reason?: string | null;
      message?: {
        content?: string;
        tool_calls?: Array<{
          id?: string;
          function?: {
            name?: string;
            arguments?: string;
          };
        }>;
      };
    }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
    };
  };

  const choice = response.choices?.[0];
  const text = choice?.message?.content?.trim() || "";
  const toolCalls = (choice?.message?.tool_calls || []).map((toolCall) => ({
    id: toolCall.id || `xai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: toolCall.function?.name || "",
    input: safeJsonParse(toolCall.function?.arguments || "{}", {})
  }));

  return {
    text,
    toolCalls,
    rawContent: toolCalls.length ? choice?.message : null,
    stopReason: String(choice?.finish_reason || "").trim() || undefined,
    usage: {
      inputTokens: Number(response.usage?.prompt_tokens || 0),
      outputTokens: Number(response.usage?.completion_tokens || 0),
      cacheWriteTokens: 0,
      cacheReadTokens: 0
    }
  };
}

export async function callAnthropic(
  deps: Pick<ChatGenerationDeps, "anthropic">,
  request: ChatModelRequest
) {
  if (!deps.anthropic) {
    throw new Error("Anthropic LLM calls require ANTHROPIC_API_KEY.");
  }

  const requestBody = buildAnthropicMessagesRequest(request);
  for (let attempt = 1; attempt <= ANTHROPIC_TRANSIENT_MAX_ATTEMPTS; attempt += 1) {
    throwIfAborted(request.signal);
    try {
      const response = await deps.anthropic.messages.create(
        requestBody as never,
        request.signal ? { signal: request.signal } : undefined
      ) as {
        content: Array<{
          type: string;
          text?: string;
          id?: string;
          name?: string;
          input?: Record<string, unknown>;
        }>;
        stop_reason?: string | null;
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_creation_input_tokens?: number;
          cache_read_input_tokens?: number;
        };
      };

      return buildAnthropicResponse(response);
    } catch (error) {
      const shouldRetry =
        !request.signal?.aborted &&
        attempt < ANTHROPIC_TRANSIENT_MAX_ATTEMPTS &&
        isRetryableAnthropicError(error);
      if (!shouldRetry) {
        throw withAttemptCount(error, attempt);
      }
      await sleepForAnthropicRetry(attempt, request.signal);
    }
  }

  throw withAttemptCount(new Error("Anthropic request failed after retries."), ANTHROPIC_TRANSIENT_MAX_ATTEMPTS);
}

export async function callAnthropicStreaming(
  deps: Pick<ChatGenerationDeps, "anthropic">,
  request: ChatModelRequest,
  callbacks: ChatModelStreamCallbacks
) {
  if (!deps.anthropic) {
    throw new Error("Anthropic LLM calls require ANTHROPIC_API_KEY.");
  }

  const requestBody = buildAnthropicMessagesRequest(request);
  const abortSignal = callbacks.signal || request.signal;
  for (let attempt = 1; attempt <= ANTHROPIC_TRANSIENT_MAX_ATTEMPTS; attempt += 1) {
    throwIfAborted(abortSignal);
    let removeAbortListener: (() => void) | null = null;
    let observedTextDelta = false;
    let stream: ReturnType<Anthropic["messages"]["stream"]> | null = null;
    try {
      stream = deps.anthropic.messages.stream(requestBody as never);

      // Claude streams can emit abort/error events when the caller clears a pending
      // reply before finalMessage() settles. Attach listeners up front so those
      // supersede aborts stay on the normal promise path instead of surfacing as an
      // unhandled stream-level rejection.
      stream.on("abort", () => {});
      stream.on("error", () => {});

      if (abortSignal) {
        if (abortSignal.aborted) {
          stream.abort();
          throw resolveAbortError(abortSignal) ?? new Error("Anthropic stream aborted before start.");
        }
        const abortListener = () => {
          stream?.abort();
        };
        abortSignal.addEventListener("abort", abortListener, { once: true });
        removeAbortListener = () => {
          abortSignal.removeEventListener("abort", abortListener);
        };
      }

      stream.on("text", (delta) => {
        const normalizedDelta = String(delta || "");
        if (normalizedDelta) observedTextDelta = true;
        callbacks.onTextDelta(normalizedDelta);
      });

      const response = await stream.finalMessage() as {
        content: Array<{
          type: string;
          text?: string;
          id?: string;
          name?: string;
          input?: Record<string, unknown>;
        }>;
        stop_reason?: string | null;
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_creation_input_tokens?: number;
          cache_read_input_tokens?: number;
        };
      };
      const normalized = buildAnthropicResponse(response);
      if (typeof callbacks.onContentBlockComplete === "function") {
        for (const block of response.content) {
          if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
            callbacks.onContentBlockComplete({ type: "text", text: block.text });
            continue;
          }
          if (block.type === "tool_use" && block.id && block.name) {
            callbacks.onContentBlockComplete({
              type: "tool_use",
              id: block.id,
              name: block.name,
              input: block.input || {}
            });
          }
        }
      }
      callbacks.onComplete?.(normalized);
      return normalized;
    } catch (error) {
      const shouldRetry =
        !abortSignal?.aborted &&
        !observedTextDelta &&
        attempt < ANTHROPIC_TRANSIENT_MAX_ATTEMPTS &&
        isRetryableAnthropicError(error);
      if (!shouldRetry) {
        throw withAttemptCount(error, attempt);
      }
      try {
        stream?.abort();
      } catch {}
      await sleepForAnthropicRetry(attempt, abortSignal);
    } finally {
      removeAbortListener?.();
    }
  }

  throw withAttemptCount(new Error("Anthropic stream failed after retries."), ANTHROPIC_TRANSIENT_MAX_ATTEMPTS);
}
