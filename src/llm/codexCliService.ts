import {
  buildClaudeCodeFallbackPrompt,
  buildClaudeCodeSystemPrompt
} from "./llmClaudeCode.ts";
import {
  buildCodexCliBrainArgs,
  buildCodexCliMemoryExtractionPrompt,
  buildCodexCliTextArgs,
  createCodexCliOutputSchemaFile,
  createCodexCliStreamSession,
  type CodexCliStreamSessionLike,
  normalizeCodexCliError,
  parseCodexCliJsonlOutput,
  runCodexCli
} from "./llmCodexCli.ts";
import type {
  ChatModelRequest,
  LlmTrace,
  MemoryExtractionRequest,
  MemoryExtractionResponse,
  UsageMetrics
} from "./serviceShared.ts";
import { MEMORY_EXTRACTION_SCHEMA } from "./serviceShared.ts";

const CODEX_CLI_TIMEOUT_MS = 30_000;
const CODEX_CLI_MAX_BUFFER_BYTES = 1024 * 1024;

function buildCodexCliTurnPreamble({
  systemPrompt,
  trace = {}
}: {
  systemPrompt: string;
  trace?: LlmTrace;
}) {
  const normalizedSystemPrompt = String(systemPrompt || "").trim();
  const scope = [
    `guild:${trace?.guildId ? String(trace.guildId) : "none"}`,
    `channel:${trace?.channelId ? String(trace.channelId) : "none"}`,
    `user:${trace?.userId ? String(trace.userId) : "none"}`,
    `source:${trace?.source ? String(trace.source) : "unknown"}`,
    `event:${trace?.event ? String(trace.event) : "unknown"}`,
    `reason:${trace?.reason ? String(trace.reason) : "unknown"}`,
    `message:${trace?.messageId ? String(trace.messageId) : "none"}`
  ].join(" | ");

  return [
    "Runtime turn packet for a single serialized bot brain.",
    `Turn scope: ${scope}`,
    "Privacy boundary: keep continuity/persona across turns, but do not disclose user-specific or channel-specific details from prior turns unless they are present in the current prompt/context.",
    normalizedSystemPrompt
  ].filter(Boolean).join("\n\n");
}

function buildCodexCliPrompt({
  systemPrompt,
  userPrompt,
  contextMessages = [],
  imageInputs = [],
  trace,
  injectTurnPreamble = false
}: ChatModelRequest & { trace?: LlmTrace; injectTurnPreamble?: boolean }) {
  const turnPreamble = injectTurnPreamble
    ? buildCodexCliTurnPreamble({ systemPrompt, trace })
    : "";
  const promptUserText = [turnPreamble, String(userPrompt || "").trim()].filter(Boolean).join("\n\n");
  return buildClaudeCodeFallbackPrompt({
    contextMessages,
    userPrompt: promptUserText,
    imageInputs
  });
}

export type CodexCliServiceDeps = {
  codexCliAvailable: boolean;
  getBrainSession: () => CodexCliStreamSessionLike | null;
  setBrainSession: (session: CodexCliStreamSessionLike | null) => void;
  getBrainModel: () => string;
  setBrainModel: (model: string) => void;
};

export async function runCodexCliBrainStream(
  deps: CodexCliServiceDeps,
  {
    model,
    input,
    timeoutMs,
    maxBufferBytes
  }: {
    model: string;
    input: string;
    timeoutMs: number;
    maxBufferBytes: number;
  }
) {
  const normalizedModel = String(model || "").trim();
  if (!normalizedModel) {
    throw new Error("codex-cli brain stream requires a model");
  }

  if (!deps.getBrainSession() || deps.getBrainModel() !== normalizedModel) {
    const existingSession = deps.getBrainSession();
    if (existingSession) {
      existingSession.close();
    }
    deps.setBrainSession(createCodexCliStreamSession({
      model: normalizedModel,
      maxBufferBytes
    }));
    deps.setBrainModel(normalizedModel);
  }

  return await deps.getBrainSession()!.run({
    input,
    timeoutMs
  });
}

export async function callCodexCli(
  deps: CodexCliServiceDeps,
  {
    model,
    systemPrompt,
    userPrompt,
    imageInputs = [],
    contextMessages = [],
    maxOutputTokens,
    jsonSchema = "",
    trace = {
      guildId: null,
      channelId: null,
      userId: null,
      source: null,
      event: null,
      reason: null,
      messageId: null
    }
  }: ChatModelRequest & { trace?: LlmTrace }
) {
  if (!deps.codexCliAvailable) {
    throw new Error("codex-cli provider requires the 'codex' CLI to be installed.");
  }

  const normalizedJsonSchema = String(jsonSchema || "").trim();
  const fallbackSystemPrompt = buildClaudeCodeSystemPrompt({
    systemPrompt,
    maxOutputTokens
  });
  const prompt = buildCodexCliPrompt({
    model,
    systemPrompt,
    userPrompt,
    imageInputs,
    contextMessages,
    temperature: 0,
    maxOutputTokens,
    reasoningEffort: "",
    jsonSchema,
    trace,
    injectTurnPreamble: !normalizedJsonSchema
  });
  const outputSchema = createCodexCliOutputSchemaFile(normalizedJsonSchema);
  let streamFailure = "";

  try {
    const { stdout } = !normalizedJsonSchema
      ? await runCodexCliBrainStream(deps, {
          model,
          input: prompt,
          timeoutMs: CODEX_CLI_TIMEOUT_MS,
          maxBufferBytes: CODEX_CLI_MAX_BUFFER_BYTES
        })
      : await runCodexCli({
          args: buildCodexCliBrainArgs({
            model,
            prompt: [fallbackSystemPrompt, prompt].filter(Boolean).join("\n\n"),
            outputSchemaPath: outputSchema?.path || ""
          }),
          input: "",
          timeoutMs: CODEX_CLI_TIMEOUT_MS,
          maxBufferBytes: CODEX_CLI_MAX_BUFFER_BYTES
        });

    const parsed = parseCodexCliJsonlOutput(stdout);
    if (parsed?.isError) {
      throw new Error(parsed.errorMessage || "codex-cli returned an error result.");
    }
    if (parsed && String(parsed.text || "").trim()) {
      return {
        text: parsed.text,
        usage: parsed.usage,
        costUsd: parsed.costUsd
      };
    }

    streamFailure = "codex-cli returned an empty or invalid stream response.";
  } catch (error) {
    const normalizedError = normalizeCodexCliError(error, {
      timeoutPrefix: "codex-cli timed out"
    });
    if (normalizedError.isTimeout) {
      throw new Error(normalizedError.message);
    }
    streamFailure = normalizedError.message;
  } finally {
    outputSchema?.cleanup();
  }

  const jsonFallbackSchema = createCodexCliOutputSchemaFile(normalizedJsonSchema);
  let jsonFallbackFailure = "";
  try {
    const { stdout } = await runCodexCli({
      args: buildCodexCliBrainArgs({
        model,
        prompt: [fallbackSystemPrompt, buildCodexCliPrompt({
          model,
          systemPrompt,
          userPrompt,
          imageInputs,
          contextMessages,
          temperature: 0,
          maxOutputTokens,
          reasoningEffort: "",
          jsonSchema,
          trace,
          injectTurnPreamble: false
        })].filter(Boolean).join("\n\n"),
        outputSchemaPath: jsonFallbackSchema?.path || ""
      }),
      input: "",
      timeoutMs: CODEX_CLI_TIMEOUT_MS,
      maxBufferBytes: CODEX_CLI_MAX_BUFFER_BYTES
    });
    const parsed = parseCodexCliJsonlOutput(stdout);
    if (parsed?.isError) {
      throw new Error(parsed.errorMessage || "codex-cli returned an error result.");
    }
    if (!parsed || !String(parsed.text || "").trim()) {
      throw new Error("codex-cli returned an empty or invalid fallback response.");
    }

    return {
      text: parsed.text,
      usage: parsed.usage,
      costUsd: parsed.costUsd
    };
  } catch (error) {
    const normalizedError = normalizeCodexCliError(error, {
      timeoutPrefix: "codex-cli fallback timed out"
    });
    if (normalizedError.isTimeout) {
      throw new Error(streamFailure ? `${streamFailure} | fallback: ${normalizedError.message}` : normalizedError.message);
    }
    jsonFallbackFailure = normalizedError.message;
  } finally {
    jsonFallbackSchema?.cleanup();
  }

  try {
    const { stdout } = await runCodexCli({
      args: buildCodexCliTextArgs({
        model,
        prompt: [fallbackSystemPrompt, buildCodexCliPrompt({
          model,
          systemPrompt,
          userPrompt,
          imageInputs,
          contextMessages,
          temperature: 0,
          maxOutputTokens,
          reasoningEffort: "",
          jsonSchema,
          trace,
          injectTurnPreamble: false
        })].filter(Boolean).join("\n\n")
      }),
      input: "",
      timeoutMs: CODEX_CLI_TIMEOUT_MS,
      maxBufferBytes: CODEX_CLI_MAX_BUFFER_BYTES
    });
    const text = String(stdout || "").trim();
    if (!text) {
      throw new Error("codex-cli returned an empty or invalid text fallback response.");
    }
    return {
      text,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0
      } satisfies UsageMetrics,
      costUsd: 0
    };
  } catch (error) {
    const normalizedError = normalizeCodexCliError(error, {
      timeoutPrefix: "codex-cli text fallback timed out"
    });
    throw new Error([streamFailure, jsonFallbackFailure, normalizedError.message].filter(Boolean).join(" | "));
  }
}

export async function callCodexCliMemoryExtraction(
  deps: CodexCliServiceDeps,
  { model, systemPrompt, userPrompt }: MemoryExtractionRequest
) {
  if (!deps.codexCliAvailable) {
    throw new Error("codex-cli provider requires the 'codex' CLI to be installed.");
  }

  const schemaJson = JSON.stringify(MEMORY_EXTRACTION_SCHEMA);
  const outputSchema = createCodexCliOutputSchemaFile(schemaJson);
  try {
    const { stdout } = await runCodexCli({
      args: buildCodexCliBrainArgs({
        model,
        prompt: buildCodexCliMemoryExtractionPrompt({ systemPrompt, userPrompt }),
        outputSchemaPath: outputSchema?.path || ""
      }),
      input: "",
      timeoutMs: CODEX_CLI_TIMEOUT_MS,
      maxBufferBytes: CODEX_CLI_MAX_BUFFER_BYTES
    });

    const parsed = parseCodexCliJsonlOutput(stdout);
    if (!parsed || !String(parsed.text || "").trim()) {
      throw new Error("codex-cli returned an empty or invalid stream response.");
    }
    if (parsed.isError) {
      throw new Error(parsed.errorMessage || "codex-cli returned an error result.");
    }

    return {
      text: parsed.text,
      usage: parsed.usage
    } satisfies MemoryExtractionResponse;
  } catch (error) {
    const normalizedError = normalizeCodexCliError(error, {
      timeoutPrefix: "codex-cli memory extraction timed out"
    });
    throw new Error(normalizedError.message);
  } finally {
    outputSchema?.cleanup();
  }
}

export function closeCodexCliSession(deps: CodexCliServiceDeps) {
  const session = deps.getBrainSession();
  if (!session || typeof session.close !== "function") return;
  session.close();
  deps.setBrainSession(null);
  deps.setBrainModel("");
}
