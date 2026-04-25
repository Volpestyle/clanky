import { clampInt } from "../normalization/numbers.ts";
import { safeJsonParseFromString } from "../normalization/valueParsers.ts";

export function safeJsonParse(value, fallback = null) {
  return safeJsonParseFromString(value, fallback);
}

export function buildAnthropicImageParts(imageInputs) {
  const parts = (Array.isArray(imageInputs) ? imageInputs : [])
    .map((image) => {
      const mediaType = String(image?.mediaType || image?.contentType || "").trim().toLowerCase();
      const base64 = String(image?.dataBase64 || "").trim();
      const url = String(image?.url || "").trim();
      if (base64 && /^image\/[a-z0-9.+-]+$/i.test(mediaType)) {
        return {
          type: "image",
          source: {
            type: "base64",
            media_type: mediaType,
            data: base64
          }
        };
      }
      if (!url) return null;
      return {
        type: "image",
        source: {
          type: "url",
          url
        }
      };
    })
    .filter(Boolean);
  if (parts.length) {
    const urlParts = parts.filter((p) => p.source?.type === "url");
    if (urlParts.length) {
      console.log(`[buildAnthropicImageParts] url_image_inputs  count=${urlParts.length}  urls=${urlParts.map((p) => p.source.url).join(", ")}`);
    }
  }
  return parts;
}

export function buildClaudeCodeJsonCliArgs({
  model,
  systemPrompt = "",
  jsonSchema = "",
  prompt = ""
}) {
  const args = buildClaudeCodeBaseCliArgs({
    model,
    outputFormat: "json"
  });
  appendClaudeCodeOptionalCliArgs(args, { systemPrompt, jsonSchema, prompt });
  return args;
}

export function buildClaudeCodeTextCliArgs({
  model,
  systemPrompt = "",
  jsonSchema = "",
  prompt = ""
}) {
  const args = buildClaudeCodeBaseCliArgs({ model });
  appendClaudeCodeOptionalCliArgs(args, { systemPrompt, jsonSchema, prompt });
  return args;
}

export function buildClaudeCodeAgentArgs({ model, prompt = "", maxTurns = 30, mcpConfig = "" }: {
  model: string;
  prompt?: string;
  maxTurns?: number;
  mcpConfig?: string;
}) {
  const args = [
    "-p", String(prompt || "").trim(),
    "--model", String(model || "sonnet"),
    "--max-turns", String(clampInt(maxTurns, 1, 10000)),
    "--output-format", "stream-json",
    "--verbose",
    "--no-session-persistence"
  ];
  const normalizedMcpConfig = String(mcpConfig || "").trim();
  if (normalizedMcpConfig) {
    args.push("--strict-mcp-config", "--mcp-config", normalizedMcpConfig);
  }
  return args;
}

export function buildClaudeCodeFallbackPrompt({
  contextMessages = [],
  userPrompt = "",
  imageInputs = []
}) {
  const sections = [];
  const historyLines = [];
  for (const message of Array.isArray(contextMessages) ? contextMessages : []) {
    const role = message?.role === "assistant" ? "assistant" : "user";
    const text = String(message?.content || "").trim();
    if (!text) continue;
    historyLines.push(`${role}: ${text}`);
  }
  if (historyLines.length) {
    sections.push(`Conversation context:\n${historyLines.join("\n")}`);
  }

  const normalizedPrompt = String(userPrompt || "").trim();
  if (normalizedPrompt) {
    sections.push(`User request:\n${normalizedPrompt}`);
  }

  const imageLines = (Array.isArray(imageInputs) ? imageInputs : [])
    .map((image) => {
      const url = String(image?.url || "").trim();
      if (url) return `- ${url}`;

      const mediaType = String(image?.mediaType || image?.contentType || "").trim();
      const hasInlineImage = Boolean(String(image?.dataBase64 || "").trim());
      if (!hasInlineImage) return "";

      return mediaType ? `- inline image (${mediaType})` : "- inline image";
    })
    .filter(Boolean);
  if (imageLines.length) {
    sections.push(`Image references:\n${imageLines.join("\n")}`);
  }

  return sections.join("\n\n").trim();
}

export function buildClaudeCodeSystemPrompt({ systemPrompt = "", maxOutputTokens = 0 }) {
  const normalizedSystemPrompt = String(systemPrompt || "").trim();
  if (!normalizedSystemPrompt) return "";

  const requestedMaxOutputTokens = Number(maxOutputTokens || 0);
  if (!Number.isFinite(requestedMaxOutputTokens) || requestedMaxOutputTokens <= 0) {
    return normalizedSystemPrompt;
  }

  const boundedMaxOutputTokens = clampInt(maxOutputTokens, 1, 32000);

  return [
    normalizedSystemPrompt,
    `Keep the final answer under ${boundedMaxOutputTokens} tokens.`
  ].join("\n\n");
}

function serializeClaudeCodeStructuredOutput(rawValue) {
  if (rawValue == null) return "";
  if (typeof rawValue === "string") {
    return String(rawValue || "").trim();
  }

  try {
    return JSON.stringify(rawValue);
  } catch {
    return "";
  }
}

export function parseClaudeCodeJsonOutput(rawOutput) {
  const rawText = String(rawOutput || "").trim();
  if (!rawText) return null;

  const parsedWhole = safeJsonParse(rawText, null);
  let lastResult =
    parsedWhole && typeof parsedWhole === "object" && !Array.isArray(parsedWhole)
      ? parsedWhole
      : null;

  if (!lastResult || (!lastResult.type && lastResult.result === undefined)) {
    const lines = rawText
      .split(/\r?\n/g)
      .map((line) => line.trim())
      .filter(Boolean);
    lastResult = null;
    for (const line of lines) {
      const event = safeJsonParse(line, null);
      if (!event || typeof event !== "object") continue;
      if (event.type === "result") {
        lastResult = event;
      }
    }
  }
  if (!lastResult) return null;

  const usage = lastResult.usage || {};
  const resultText =
    serializeClaudeCodeStructuredOutput(lastResult.structured_output) || String(lastResult.result || "").trim();
  return buildClaudeCodeParsedResult({
    result: lastResult,
    usage,
    resultText
  });
}

function buildClaudeCodeBaseCliArgs({
  model,
  verbose = false,
  inputFormat = "",
  outputFormat = "",
  maxTurns = 1
}) {
  const args = ["-p"];
  if (verbose) args.push("--verbose");
  args.push(
    "--no-session-persistence",
    "--strict-mcp-config",
    "--tools", "",
    "--plugin-dir", "",
    "--setting-sources", "project,local"
  );
  if (String(inputFormat || "").trim()) {
    args.push("--input-format", String(inputFormat).trim());
  }
  if (String(outputFormat || "").trim()) {
    args.push("--output-format", String(outputFormat).trim());
  }
  args.push("--model", model, "--max-turns", String(clampInt(maxTurns, 1, 10000)));
  return args;
}

function appendClaudeCodeOptionalCliArgs(args, {
  systemPrompt = "",
  jsonSchema = "",
  prompt = ""
}) {
  const normalizedSystemPrompt = String(systemPrompt || "").trim();
  if (normalizedSystemPrompt) {
    args.push("--system-prompt", normalizedSystemPrompt);
  }

  const normalizedSchema = String(jsonSchema || "").trim();
  if (normalizedSchema) {
    args.push("--json-schema", normalizedSchema);
  }

  const normalizedPrompt = String(prompt || "").trim();
  if (normalizedPrompt) {
    args.push(normalizedPrompt);
  }
}

function buildClaudeCodeParsedResult({ result, usage, resultText = "" }) {
  const errors = Array.isArray(result?.errors) ? result.errors : [];
  const normalizedResultText = String(resultText || "").trim();
  const errorMessage =
    normalizedResultText || errors.map((item) => String(item || "").trim()).filter(Boolean).join(" | ");
  return {
    text: normalizedResultText,
    isError: Boolean(result?.is_error),
    errorMessage,
    usage: {
      inputTokens: Number(usage.input_tokens || 0),
      outputTokens: Number(usage.output_tokens || 0),
      cacheWriteTokens: Number(usage.cache_creation_input_tokens || 0),
      cacheReadTokens: Number(usage.cache_read_input_tokens || 0)
    },
    costUsd: Number(result?.total_cost_usd || 0)
  };
}
