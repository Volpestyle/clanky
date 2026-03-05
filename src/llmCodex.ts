import type OpenAI from "openai";
import {
  extractOpenAiResponseText,
  extractOpenAiResponseUsage
} from "./llm/llmHelpers.ts";
import { sleepMs } from "./normalization/time.ts";
import { estimateUsdCost } from "./pricing.ts";

const CODEX_POLL_INTERVAL_MS = 1200;
const CODEX_PENDING_STATUSES = new Set(["queued", "in_progress"]);
const CODEX_FAILED_STATUSES = new Set(["failed", "cancelled", "canceled", "incomplete", "expired"]);

type CodexUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
};

export interface CodexRunResult {
  responseId: string;
  text: string;
  usage: CodexUsage;
  costUsd: number;
  isError: boolean;
  errorMessage: string;
  status: string;
}

export interface RunCodexTaskOptions {
  openai: OpenAI;
  instruction: string;
  model: string;
  timeoutMs?: number;
}

export interface RunCodexSessionTurnOptions {
  openai: OpenAI;
  previousResponseId?: string | null;
  input: string;
  model: string;
  timeoutMs?: number;
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
  timeoutMs
}: {
  openai: OpenAI;
  initialResponse: unknown;
  timeoutMs: number;
}) {
  const responseId = String((initialResponse as { id?: unknown })?.id || "").trim();
  let response = initialResponse;
  const deadlineMs = Date.now() + timeoutMs;

  while (CODEX_PENDING_STATUSES.has(normalizeStatus((response as { status?: unknown })?.status))) {
    if (!responseId) {
      throw new Error("Codex response is still running but no response id was returned.");
    }
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) {
      throw new Error(`Codex request timed out after ${timeoutMs}ms.`);
    }
    await sleepMs(Math.min(CODEX_POLL_INTERVAL_MS, remainingMs));
    response = await openai.responses.retrieve(responseId);
  }

  return response;
}

function parseCodexResponse({ response, model }: { response: unknown; model: string }): CodexRunResult {
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
    provider: "openai",
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
  timeoutMs = 300_000
}: {
  openai: OpenAI;
  model: string;
  input: string;
  previousResponseId?: string | null;
  timeoutMs?: number;
}): Promise<CodexRunResult> {
  const normalizedTimeoutMs = normalizeTimeoutMs(timeoutMs);
  const normalizedModel = String(model || "").trim();
  const normalizedInput = String(input || "");
  const normalizedPreviousResponseId = String(previousResponseId || "").trim();

  const initialResponse = await openai.responses.create({
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
  });

  const terminalResponse = await waitForTerminalResponse({
    openai,
    initialResponse,
    timeoutMs: normalizedTimeoutMs
  });

  return parseCodexResponse({
    response: terminalResponse,
    model: normalizedModel
  });
}

export async function runCodexTask({
  openai,
  instruction,
  model,
  timeoutMs = 300_000
}: RunCodexTaskOptions): Promise<CodexRunResult> {
  return runCodexInput({
    openai,
    model,
    input: instruction,
    timeoutMs
  });
}

export async function runCodexSessionTurn({
  openai,
  previousResponseId = null,
  input,
  model,
  timeoutMs = 300_000
}: RunCodexSessionTurnOptions): Promise<CodexRunResult> {
  return runCodexInput({
    openai,
    model,
    input,
    previousResponseId,
    timeoutMs
  });
}
