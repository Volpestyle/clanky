// Extracted LLM Provider Methods
import {
  normalizeOpenAiReasoningEffort,
  parseMemoryExtractionJson
} from "./llmHelpers.ts";
import {
  buildOpenAiTemperatureParam,
  buildOpenAiReasoningParam,
  buildOpenAiJsonSchemaTextFormat
} from "../llm.ts";
import { buildAnthropicImageParts } from "../llmClaudeCode.ts";

export async function callAnthropicMemoryExtraction(llm: any, { model, systemPrompt, userPrompt }) {
const response = await llm.anthropic.messages.create({
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

export async function callAnthropic(llm: any, {
    model,
    systemPrompt,
    userPrompt,
    imageInputs,
    contextMessages,
    temperature,
    maxOutputTokens
  }) {
const imageParts = buildAnthropicImageParts(imageInputs);
const userContent = imageParts.length
  ? [
      { type: "text", text: userPrompt },
      ...imageParts
    ]
  : userPrompt;

const messages = [
  ...contextMessages.map((msg) => ({
    role: msg.role === "assistant" ? "assistant" : "user",
    content: msg.content
  })),
  { role: "user", content: userContent }
];

const resolvedTemperature = Math.max(0, Math.min(Number(temperature) || 0, 1));
const response = await llm.anthropic.messages.create({
  model,
  system: systemPrompt,
  temperature: resolvedTemperature,
  max_tokens: maxOutputTokens,
  messages
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
