import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import { buildAnthropicImageParts, safeJsonParse } from "./llmClaudeCode.ts";
import {
  extractOpenAiResponseText,
  extractOpenAiResponseUsage,
  extractOpenAiToolCalls
} from "./llmHelpers.ts";
import {
  buildContextContentBlocks,
  buildOpenAiJsonSchemaTextFormat,
  buildOpenAiReasoningParam,
  buildOpenAiToolLoopInput,
  buildOpenAiTemperatureParam,
  type ChatModelStreamCallbacks,
  type ChatModelRequest
} from "./serviceShared.ts";

export type ChatGenerationDeps = {
  openai: OpenAI | null;
  xai: OpenAI | null;
  anthropic: Anthropic | null;
};

function buildAnthropicMessagesRequest({
  model,
  systemPrompt,
  userPrompt,
  imageInputs = [],
  contextMessages = [],
  temperature,
  maxOutputTokens,
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

  const messages = [
    ...contextMessages.map((msg) => ({
      role: msg.role === "assistant" ? "assistant" : "user",
      content: msg.content
    })),
    { role: "user", content: userContent }
  ];

  const resolvedTemperature = Math.max(0, Math.min(Number(temperature) || 0, 1));
  const normalizedTools = Array.isArray(tools) ? tools : [];
  const toolsParam = normalizedTools.length
    ? {
        tools: normalizedTools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.input_schema
        }))
      }
    : {};

  return {
    model,
    system: systemPrompt,
    temperature: resolvedTemperature,
    max_tokens: maxOutputTokens,
    messages,
    ...toolsParam
  } as Parameters<Anthropic["messages"]["create"]>[0];
}

function buildAnthropicResponse(
  response: {
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
  }
) {
  const text = response.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
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
        content: msg.content ?? ""
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
    instructions: systemPrompt,
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
  const stream = await deps.openai.responses.create(
    requestBody as never,
    abortSignal ? { signal: abortSignal } : undefined
  ) as AsyncIterable<OpenAiResponsesStreamEvent>;
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
    tools = [],
    signal
  }: ChatModelRequest
) {
  if (!deps.xai) {
    throw new Error("xAI LLM calls require XAI_API_KEY.");
  }

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
    { role: "system", content: systemPrompt },
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
  const stream = deps.anthropic.messages.stream(requestBody as never);
  const abortSignal = callbacks.signal || request.signal;
  let removeAbortListener: (() => void) | null = null;

  if (abortSignal) {
    if (abortSignal.aborted) {
      stream.abort();
      throw abortSignal.reason ?? new Error("Anthropic stream aborted before start.");
    }
    const abortListener = () => {
      stream.abort();
    };
    abortSignal.addEventListener("abort", abortListener, { once: true });
    removeAbortListener = () => {
      abortSignal.removeEventListener("abort", abortListener);
    };
  }

  stream.on("text", (delta) => {
    callbacks.onTextDelta(String(delta || ""));
  });

  try {
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
  } finally {
    removeAbortListener?.();
  }
}
