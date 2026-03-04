// Extracted LLM Provider Methods
import {
  normalizeOpenAiReasoningEffort,
  parseMemoryExtractionJson,
  extractOpenAiResponseText,
  extractOpenAiResponseUsage
} from "./llmHelpers.ts";
import {
  buildOpenAiTemperatureParam,
  buildOpenAiReasoningParam,
  buildOpenAiJsonSchemaTextFormat,
  MEMORY_EXTRACTION_SCHEMA
} from "../llm.ts";

export async function callOpenAiMemoryExtraction(llm: any, { model, systemPrompt, userPrompt }) {
if (!llm.openai) {
  throw new Error("Memory fact extraction requires OPENAI_API_KEY when provider is openai.");
}

const response = await llm.openai.responses.create({
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

export async function callOpenAI(llm: any, {
    model,
    systemPrompt,
    userPrompt,
    imageInputs,
    contextMessages,
    temperature,
    maxOutputTokens,
    reasoningEffort,
    jsonSchema = ""
  }) {
if (!llm.openai) {
  throw new Error("OpenAI LLM calls require OPENAI_API_KEY.");
}

return llm.callOpenAiResponses({
  model,
  systemPrompt,
  userPrompt,
  imageInputs,
  contextMessages,
  temperature,
  maxOutputTokens,
  reasoningEffort,
  jsonSchema
});
}

export async function callOpenAiResponses(llm: any, {
    model,
    systemPrompt,
    userPrompt,
    imageInputs,
    contextMessages,
    temperature,
    maxOutputTokens,
    reasoningEffort,
    jsonSchema = ""
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

const responseFormat = buildOpenAiJsonSchemaTextFormat(jsonSchema);
const response = await llm.openai.responses.create({
  model,
  instructions: systemPrompt,
  ...buildOpenAiTemperatureParam(model, temperature),
  ...buildOpenAiReasoningParam(model, reasoningEffort),
  max_output_tokens: maxOutputTokens,
  ...(responseFormat ? { text: responseFormat } : {}),
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
});

return {
  text: extractOpenAiResponseText(response),
  usage: extractOpenAiResponseUsage(response)
};
}
