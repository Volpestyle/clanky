// Extracted LLM Provider Methods
import {
  normalizeOpenAiReasoningEffort,
  normalizeInlineText,
  parseMemoryExtractionJson
} from "./llmHelpers.ts";
import {
  buildOpenAiTemperatureParam,
  buildOpenAiReasoningParam,
  buildOpenAiJsonSchemaTextFormat,
  type XaiJsonRequestOptions,
  XAI_REQUEST_TIMEOUT_MS
} from "../llm.ts";
import { safeJsonParse } from "../llmClaudeCode.ts";

export async function fetchXaiJson(llm: any, url, options: XaiJsonRequestOptions = {}, timeoutMs = XAI_REQUEST_TIMEOUT_MS) {
const { method = "GET", body } = options;
if (!llm.appConfig?.xaiApiKey) {
  throw new Error("Missing XAI_API_KEY.");
}

const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), timeoutMs);
try {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${llm.appConfig.xaiApiKey}`,
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

export async function callXaiMemoryExtraction(llm: any, { model, systemPrompt, userPrompt }) {
if (!llm.xai) {
  throw new Error("Memory fact extraction requires XAI_API_KEY when provider is xai.");
}

const response = await llm.xai.chat.completions.create({
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

export async function callXai(llm: any, {
    model,
    systemPrompt,
    userPrompt,
    imageInputs,
    contextMessages,
    temperature,
    maxOutputTokens
  }) {
if (!llm.xai) {
  throw new Error("xAI LLM calls require XAI_API_KEY.");
}

return llm.callXaiChatCompletions({
  model,
  systemPrompt,
  userPrompt,
  imageInputs,
  contextMessages,
  temperature,
  maxOutputTokens
});
}

export async function callXaiChatCompletions(llm: any, {
    model,
    systemPrompt,
    userPrompt,
    imageInputs,
    contextMessages,
    temperature,
    maxOutputTokens
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
  ...contextMessages.map((msg) => ({
    role: msg.role === "assistant" ? "assistant" : "user",
    content: msg.content
  })),
  { role: "user", content: userContent }
];

const response = await llm.xai.chat.completions.create({
  model,
  temperature,
  max_tokens: maxOutputTokens,
  messages
});

const text = response.choices?.[0]?.message?.content?.trim() || "";

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
