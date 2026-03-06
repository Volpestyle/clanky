import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import { buildAnthropicImageParts, safeJsonParse } from "../llmClaudeCode.ts";
import {
  extractOpenAiResponseText,
  extractOpenAiResponseUsage,
  extractOpenAiToolCalls
} from "./llmHelpers.ts";
import {
  buildOpenAiJsonSchemaTextFormat,
  buildOpenAiReasoningParam,
  buildOpenAiTemperatureParam,
  type ChatModelRequest
} from "./serviceShared.ts";

export type ChatGenerationDeps = {
  openai: OpenAI | null;
  xai: OpenAI | null;
  anthropic: Anthropic | null;
};

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
    tools = []
  }: ChatModelRequest
) {
  if (!deps.openai) {
    throw new Error("OpenAI LLM calls require OPENAI_API_KEY.");
  }

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
  const normalizedUserPrompt = String(userPrompt || "");
  const userContent: Array<Record<string, unknown>> = [];
  if (normalizedUserPrompt.trim()) {
    userContent.push({
      type: "input_text",
      text: normalizedUserPrompt
    });
  }
  userContent.push(...imageParts);

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
  const requestBody = {
    model,
    instructions: systemPrompt,
    ...buildOpenAiTemperatureParam(model, temperature),
    ...buildOpenAiReasoningParam(model, reasoningEffort),
    max_output_tokens: maxOutputTokens,
    ...(responseFormat ? { text: responseFormat } : {}),
    ...(openAiTools.length ? { tools: openAiTools } : {}),
    input: [
      ...contextMessages.map((msg) => ({
        role: msg.role === "assistant" ? "assistant" : "user",
        content: String(msg.content || "")
      })),
      {
        role: "user",
        content: userContent
      }
    ]
  } as Parameters<typeof deps.openai.responses.create>[0];
  const response = await deps.openai.responses.create(requestBody as never);
  const responseWithOutput = response as { output?: unknown };

  const text = extractOpenAiResponseText(response);
  const toolCalls = extractOpenAiToolCalls(response);

  return {
    text,
    toolCalls,
    rawContent: toolCalls.length ? responseWithOutput.output : null,
    usage: extractOpenAiResponseUsage(response)
  };
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
    tools = []
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
  const response = await deps.xai.chat.completions.create(requestBody as never) as {
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
  {
    model,
    systemPrompt,
    userPrompt,
    imageInputs = [],
    contextMessages = [],
    temperature,
    maxOutputTokens,
    tools = []
  }: ChatModelRequest
) {
  if (!deps.anthropic) {
    throw new Error("Anthropic LLM calls require ANTHROPIC_API_KEY.");
  }

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
  const requestBody = {
    model,
    system: systemPrompt,
    temperature: resolvedTemperature,
    max_tokens: maxOutputTokens,
    messages,
    ...toolsParam
  } as Parameters<typeof deps.anthropic.messages.create>[0];
  const response = await deps.anthropic.messages.create(requestBody as never) as {
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
