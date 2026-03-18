import type OpenAI from "openai";
import {
  extractOpenAiResponseText,
  extractOpenAiResponseUsage
} from "./llmHelpers.ts";
import { sleepMs } from "../normalization/time.ts";
import { estimateUsdCost } from "./pricing.ts";
import { createAbortError, throwIfAborted } from "../tools/browserTaskRuntime.ts";
import type { SubAgentProgressEvent } from "../agents/subAgentSession.ts";

const CODEX_POLL_INTERVAL_MS = 1200;
const CODEX_PENDING_STATUSES = new Set(["queued", "in_progress"]);
const CODEX_FAILED_STATUSES = new Set(["failed", "cancelled", "canceled", "incomplete", "expired"]);

type CodexUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
};

interface CodexRunResult {
  responseId: string;
  text: string;
  usage: CodexUsage;
  costUsd: number;
  isError: boolean;
  errorMessage: string;
  status: string;
}

interface RunCodexTaskOptions {
  openai: OpenAI;
  instruction: string;
  model: string;
  costProvider?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface RunCodexSessionTurnOptions {
  openai: OpenAI;
  previousResponseId?: string | null;
  input: string;
  model: string;
  costProvider?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (event: SubAgentProgressEvent) => void;
}

function normalizeStatus(status: unknown): string {
  return String(status || "")
    .trim()
    .toLowerCase();
}

function normalizeTimeoutMs(timeoutMs: unknown): number {
  return Math.max(10_000, Math.min(1_800_000, Number(timeoutMs) || 300_000));
}

function readFieldString(source: unknown, key: string): string {
  if (!source || typeof source !== "object") return "";
  const value = (source as Record<string, unknown>)[key];
  return String(value || "").trim();
}

function resolveCodexErrorMessage(response: unknown, status: string): string {
  const errorMessage = readFieldString((response as { error?: unknown })?.error, "message");
  if (errorMessage) return errorMessage;

  const incompleteReason = readFieldString((response as { incomplete_details?: unknown })?.incomplete_details, "reason");
  if (incompleteReason) return `Codex response ${status}: ${incompleteReason}`;

  if (status) return `Codex response ended with status '${status}'.`;
  return "Codex request failed.";
}

async function waitForTerminalResponse({
  openai,
  initialResponse,
  timeoutMs,
  signal,
  onProgress
}: {
  openai: OpenAI;
  initialResponse: unknown;
  timeoutMs: number;
  signal?: AbortSignal;
  onProgress?: (event: SubAgentProgressEvent) => void;
}) {
  const responseId = String((initialResponse as { id?: unknown })?.id || "").trim();
  let response = initialResponse;
  const deadlineMs = Date.now() + timeoutMs;
  const startedAtMs = Date.now();
  let pollCount = 0;

  const emitProgress = (event: SubAgentProgressEvent) => {
    if (typeof onProgress !== "function") return;
    try {
      onProgress(event);
    } catch {
      // Best-effort: progress callbacks must not break Codex polling.
    }
  };

  while (CODEX_PENDING_STATUSES.has(normalizeStatus((response as { status?: unknown })?.status))) {
    throwIfAborted(signal, "Codex request cancelled");
    if (!responseId) {
      throw new Error("Codex response is still running but no response id was returned.");
    }
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) {
      throw new Error(`Codex request timed out after ${timeoutMs}ms.`);
    }
    pollCount += 1;
    const status = normalizeStatus((response as { status?: unknown })?.status) || "in_progress";
    emitProgress({
      kind: "assistant_message",
      summary: `Codex status: ${status} (poll ${pollCount})`,
      elapsedMs: Math.max(0, Date.now() - startedAtMs),
      timestamp: Date.now()
    });
    await waitForCodexPoll(Math.min(CODEX_POLL_INTERVAL_MS, remainingMs), signal);
    response = await openai.responses.retrieve(responseId, undefined, signal ? { signal } : undefined);
  }

  const finalStatus = normalizeStatus((response as { status?: unknown })?.status) || "completed";
  emitProgress({
    kind: "turn_complete",
    summary: `Codex status: ${finalStatus}`,
    elapsedMs: Math.max(0, Date.now() - startedAtMs),
    timestamp: Date.now()
  });

  return response;
}

async function waitForCodexPoll(delayMs: number, signal?: AbortSignal) {
  throwIfAborted(signal, "Codex request cancelled");
  if (!signal) {
    await sleepMs(delayMs);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, Math.floor(Number(delayMs) || 0)));
    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      reject(createAbortError(signal.reason || "Codex request cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function maybeCancelCodexResponse(openai: OpenAI, responseId: string) {
  const normalizedResponseId = String(responseId || "").trim();
  if (!normalizedResponseId) return;
  const cancel = (openai.responses as OpenAI["responses"] & {
    cancel?: (id: string) => Promise<unknown>;
  }).cancel;
  if (typeof cancel !== "function") return;
  try {
    await cancel.call(openai.responses, normalizedResponseId);
  } catch {
    // ignore
  }
}

function parseCodexResponse({
  response,
  model,
  costProvider = "openai"
}: {
  response: unknown;
  model: string;
  costProvider?: string;
}): CodexRunResult {
  const normalizedResponseId = String((response as { id?: unknown })?.id || "").trim();
  const status = normalizeStatus((response as { status?: unknown })?.status) || "completed";
  const text = extractOpenAiResponseText(response);
  const usage = extractOpenAiResponseUsage(response);
  const normalizedUsage: CodexUsage = {
    inputTokens: Number(usage?.inputTokens || 0),
    outputTokens: Number(usage?.outputTokens || 0),
    cacheWriteTokens: Number(usage?.cacheWriteTokens || 0),
    cacheReadTokens: Number(usage?.cacheReadTokens || 0)
  };
  const costUsd = estimateUsdCost({
    provider: costProvider,
    model,
    inputTokens: normalizedUsage.inputTokens,
    outputTokens: normalizedUsage.outputTokens,
    cacheWriteTokens: normalizedUsage.cacheWriteTokens,
    cacheReadTokens: normalizedUsage.cacheReadTokens
  });
  const isError = CODEX_FAILED_STATUSES.has(status);
  const errorMessage = isError ? resolveCodexErrorMessage(response, status) : "";

  return {
    responseId: normalizedResponseId,
    text,
    usage: normalizedUsage,
    costUsd,
    isError,
    errorMessage,
    status
  };
}

async function runCodexInput({
  openai,
  model,
  input,
  previousResponseId = "",
  costProvider = "openai",
  timeoutMs = 300_000,
  signal,
  onProgress
}: {
  openai: OpenAI;
  model: string;
  input: string;
  previousResponseId?: string | null;
  costProvider?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (event: SubAgentProgressEvent) => void;
}): Promise<CodexRunResult> {
  const normalizedTimeoutMs = normalizeTimeoutMs(timeoutMs);
  const normalizedModel = String(model || "").trim();
  const normalizedInput = String(input || "");
  const normalizedPreviousResponseId = String(previousResponseId || "").trim();
  throwIfAborted(signal, "Codex request cancelled");

  let initialResponse: unknown = null;
  try {
    initialResponse = await openai.responses.create({
      model: normalizedModel,
      ...(normalizedPreviousResponseId ? { previous_response_id: normalizedPreviousResponseId } : {}),
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: normalizedInput
            }
          ]
        }
      ]
    }, signal ? { signal } : undefined);

    const terminalResponse = await waitForTerminalResponse({
      openai,
      initialResponse,
      timeoutMs: normalizedTimeoutMs,
      signal,
      onProgress
    });

    return parseCodexResponse({
      response: terminalResponse,
      model: normalizedModel,
      costProvider
    });
  } catch (error) {
    if (signal?.aborted) {
      const responseId = String((initialResponse as { id?: unknown })?.id || "").trim();
      await maybeCancelCodexResponse(openai, responseId);
      throw createAbortError(signal.reason || error);
    }
    throw error;
  }
}

export async function runCodexTask({
  openai,
  instruction,
  model,
  costProvider = "openai",
  timeoutMs = 300_000,
  signal
}: RunCodexTaskOptions): Promise<CodexRunResult> {
  return runCodexInput({
    openai,
    model,
    input: instruction,
    costProvider,
    timeoutMs,
    signal
  });
}

export async function runCodexSessionTurn({
  openai,
  previousResponseId = null,
  input,
  model,
  costProvider = "openai",
  timeoutMs = 300_000,
  signal,
  onProgress
}: RunCodexSessionTurnOptions): Promise<CodexRunResult> {
  return runCodexInput({
    openai,
    model,
    input,
    previousResponseId,
    costProvider,
    timeoutMs,
    signal,
    onProgress
  });
}
