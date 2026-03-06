import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildClaudeCodeCliArgs,
  buildClaudeCodeFallbackPrompt,
  buildClaudeCodeJsonCliArgs,
  buildClaudeCodeStreamInput,
  buildClaudeCodeSystemPrompt,
  buildClaudeCodeTextCliArgs,
  createClaudeCliStreamSession,
  type ClaudeCliStreamSessionLike,
  normalizeClaudeCodeCliError,
  parseClaudeCodeJsonOutput,
  parseClaudeCodeStreamOutput,
  runClaudeCli
} from "../llmClaudeCode.ts";
import type {
  ChatModelRequest,
  LlmTrace,
  MemoryExtractionRequest,
  MemoryExtractionResponse,
  UsageMetrics
} from "./serviceShared.ts";
import { MEMORY_EXTRACTION_SCHEMA } from "./serviceShared.ts";

const CLAUDE_CODE_TIMEOUT_MS = 30_000;
const CLAUDE_CODE_MAX_BUFFER_BYTES = 1024 * 1024;
const CLAUDE_CODE_BRAIN_SESSION_MAX_TURNS = 10_000;
const CLAUDE_CODE_MEMORY_EXTRACTION_MAX_TURNS = 1;
const CLAUDE_CODE_ISOLATED_WORKSPACE = join(tmpdir(), "clanker-conk-brain");

function ensureIsolatedWorkspace(): string {
  const gitDir = join(CLAUDE_CODE_ISOLATED_WORKSPACE, ".git");
  if (!existsSync(join(gitDir, "HEAD"))) {
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/main\n");
  }
  return CLAUDE_CODE_ISOLATED_WORKSPACE;
}

function buildClaudeCodeTurnPreamble({
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

  const sections = [
    "Runtime turn packet for a single serialized bot brain.",
    `Turn scope: ${scope}`,
    "Privacy boundary: keep continuity/persona across turns, but do not disclose user-specific or channel-specific details from prior turns unless they are present in the current prompt/context.",
    normalizedSystemPrompt
  ].filter(Boolean);
  return sections.join("\n\n");
}

export type ClaudeCodeServiceDeps = {
  claudeCodeAvailable: boolean;
  getBrainSession: () => ClaudeCliStreamSessionLike | null;
  setBrainSession: (session: ClaudeCliStreamSessionLike | null) => void;
  getBrainModel: () => string;
  setBrainModel: (model: string) => void;
};

type ClaudeCodeStreamResult = {
  stdout: string;
};

export async function runClaudeCodeBrainStream(
  deps: ClaudeCodeServiceDeps,
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
): Promise<ClaudeCodeStreamResult> {
  const normalizedModel = String(model || "").trim();
  if (!normalizedModel) {
    throw new Error("claude-code brain stream requires a model");
  }

  if (!deps.getBrainSession() || deps.getBrainModel() !== normalizedModel) {
    const existingSession = deps.getBrainSession();
    if (existingSession) {
      existingSession.close();
    }
    deps.setBrainSession(createClaudeCliStreamSession({
      args: buildClaudeCodeCliArgs({
        model: normalizedModel,
        maxTurns: CLAUDE_CODE_BRAIN_SESSION_MAX_TURNS
      }),
      maxBufferBytes,
      cwd: ensureIsolatedWorkspace()
    }));
    deps.setBrainModel(normalizedModel);
  }

  return await deps.getBrainSession()!.run({
    input,
    timeoutMs
  });
}

export async function callClaudeCode(
  deps: ClaudeCodeServiceDeps,
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
  if (!deps.claudeCodeAvailable) {
    throw new Error("claude-code provider requires the 'claude' CLI to be installed.");
  }

  const normalizedJsonSchema = String(jsonSchema || "").trim();
  const usePersistentBrainStream = !normalizedJsonSchema;
  const turnPreamble = buildClaudeCodeTurnPreamble({
    systemPrompt,
    trace
  });
  const streamInput = buildClaudeCodeStreamInput({
    contextMessages,
    userPrompt,
    imageInputs,
    turnPreamble: usePersistentBrainStream ? turnPreamble : ""
  });
  const fallbackSystemPrompt = buildClaudeCodeSystemPrompt({
    systemPrompt,
    maxOutputTokens
  });
  let streamFailure = "";

  try {
    const { stdout } = usePersistentBrainStream
      ? await runClaudeCodeBrainStream(deps, {
          model,
          input: streamInput,
          timeoutMs: CLAUDE_CODE_TIMEOUT_MS,
          maxBufferBytes: CLAUDE_CODE_MAX_BUFFER_BYTES
        })
      : await runClaudeCli({
          args: buildClaudeCodeCliArgs({
            model,
            systemPrompt: fallbackSystemPrompt,
            jsonSchema: normalizedJsonSchema,
            maxTurns: 1
          }),
          input: streamInput,
          timeoutMs: CLAUDE_CODE_TIMEOUT_MS,
          maxBufferBytes: CLAUDE_CODE_MAX_BUFFER_BYTES
        });

    const parsed = parseClaudeCodeStreamOutput(stdout);
    if (parsed?.isError) {
      throw new Error(parsed.errorMessage || "claude-code returned an error result.");
    }
    if (parsed && String(parsed.text || "").trim()) {
      return {
        text: parsed.text,
        usage: parsed.usage,
        costUsd: parsed.costUsd
      };
    }

    streamFailure = "claude-code returned an empty or invalid stream response.";
  } catch (error) {
    const normalizedError = normalizeClaudeCodeCliError(error, {
      timeoutPrefix: "claude-code timed out"
    });
    if (normalizedError.isTimeout) {
      throw new Error(normalizedError.message);
    }
    streamFailure = normalizedError.message;
  }

  const fallbackPrompt = buildClaudeCodeFallbackPrompt({
    contextMessages,
    userPrompt,
    imageInputs
  });
  const fallbackArgs = buildClaudeCodeJsonCliArgs({
    model,
    systemPrompt: fallbackSystemPrompt,
    jsonSchema: normalizedJsonSchema,
    prompt: fallbackPrompt
  });
  let jsonFallbackFailure = "";

  try {
    const { stdout } = await runClaudeCli({
      args: fallbackArgs,
      input: "",
      timeoutMs: CLAUDE_CODE_TIMEOUT_MS,
      maxBufferBytes: CLAUDE_CODE_MAX_BUFFER_BYTES
    });
    const parsed = parseClaudeCodeJsonOutput(stdout);
    if (parsed?.isError) {
      throw new Error(parsed.errorMessage || "claude-code returned an error result.");
    }
    if (!parsed || !String(parsed.text || "").trim()) {
      throw new Error("claude-code returned an empty or invalid fallback response.");
    }

    return {
      text: parsed.text,
      usage: parsed.usage,
      costUsd: parsed.costUsd
    };
  } catch (error) {
    const normalizedError = normalizeClaudeCodeCliError(error, {
      timeoutPrefix: "claude-code fallback timed out"
    });
    if (normalizedError.isTimeout) {
      throw new Error(
        streamFailure
          ? `${streamFailure} | fallback: ${normalizedError.message}`
          : normalizedError.message
      );
    }
    jsonFallbackFailure = normalizedError.message;
  }

  const textFallbackArgs = buildClaudeCodeTextCliArgs({
    model,
    systemPrompt: fallbackSystemPrompt,
    jsonSchema: normalizedJsonSchema,
    prompt: fallbackPrompt
  });
  try {
    const { stdout } = await runClaudeCli({
      args: textFallbackArgs,
      input: "",
      timeoutMs: CLAUDE_CODE_TIMEOUT_MS,
      maxBufferBytes: CLAUDE_CODE_MAX_BUFFER_BYTES
    });
    const text = String(stdout || "").trim();
    if (!text) {
      throw new Error("claude-code returned an empty or invalid text fallback response.");
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
    const normalizedError = normalizeClaudeCodeCliError(error, {
      timeoutPrefix: "claude-code text fallback timed out"
    });
    const messageParts = [streamFailure, jsonFallbackFailure, normalizedError.message].filter(Boolean);
    throw new Error(messageParts.join(" | "));
  }
}

export async function callClaudeCodeMemoryExtraction(
  deps: ClaudeCodeServiceDeps,
  { model, systemPrompt, userPrompt }: MemoryExtractionRequest
) {
  if (!deps.claudeCodeAvailable) {
    throw new Error("claude-code provider requires the 'claude' CLI to be installed.");
  }

  const schemaJson = JSON.stringify(MEMORY_EXTRACTION_SCHEMA);
  const streamInput = buildClaudeCodeStreamInput({
    contextMessages: [],
    userPrompt,
    imageInputs: []
  });

  try {
    const { stdout } = await runClaudeCli({
      args: buildClaudeCodeCliArgs({
        model,
        systemPrompt,
        jsonSchema: schemaJson,
        maxTurns: CLAUDE_CODE_MEMORY_EXTRACTION_MAX_TURNS
      }),
      input: streamInput,
      timeoutMs: CLAUDE_CODE_TIMEOUT_MS,
      maxBufferBytes: CLAUDE_CODE_MAX_BUFFER_BYTES,
      cwd: ensureIsolatedWorkspace()
    });

    const parsed = parseClaudeCodeStreamOutput(stdout);
    if (!parsed || !String(parsed.text || "").trim()) {
      throw new Error("claude-code returned an empty or invalid stream response.");
    }
    if (parsed.isError) {
      throw new Error(parsed.errorMessage || "claude-code returned an error result.");
    }

    return {
      text: parsed.text,
      usage: parsed.usage
    } satisfies MemoryExtractionResponse;
  } catch (error) {
    const normalizedError = normalizeClaudeCodeCliError(error, {
      timeoutPrefix: "claude-code memory extraction timed out"
    });
    throw new Error(normalizedError.message);
  }
}

export function closeClaudeCodeSession(deps: ClaudeCodeServiceDeps) {
  const session = deps.getBrainSession();
  if (!session || typeof session.close !== "function") return;
  session.close();
  deps.setBrainSession(null);
  deps.setBrainModel("");
}
