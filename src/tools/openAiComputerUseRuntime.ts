import type OpenAI from "openai";
import { estimateUsdCost } from "../pricing.ts";
import { extractOpenAiResponseText, extractOpenAiResponseUsage } from "../llm/llmHelpers.ts";
import type { BrowserManager } from "../services/BrowserManager.ts";
import { createAbortError, isAbortError, throwIfAborted } from "./browserTaskRuntime.ts";

const COMPUTER_USE_DEFAULT_MODEL = "computer-use-preview";
const COMPUTER_USE_DEFAULT_START_URL = "https://example.com";
const COMPUTER_USE_DISPLAY_WIDTH = 1024;
const COMPUTER_USE_DISPLAY_HEIGHT = 768;

type ComputerUseTrace = {
  guildId?: string | null;
  channelId?: string | null;
  userId?: string | null;
  source?: string | null;
};

type ComputerUseStore = {
  logAction: (entry: {
    kind: string;
    guildId?: string | null;
    channelId?: string | null;
    userId?: string | null;
    content?: string;
    metadata?: Record<string, unknown>;
    usdCost?: number;
  }) => void;
};

type ComputerUseOptions = {
  openai: OpenAI;
  browserManager: BrowserManager;
  store: ComputerUseStore;
  sessionKey: string;
  instruction: string;
  model?: string;
  maxSteps: number;
  stepTimeoutMs: number;
  trace: ComputerUseTrace;
  logSource?: string | null;
  signal?: AbortSignal;
};

type ComputerAction = {
  type?: string;
  x?: number;
  y?: number;
  button?: string;
  scroll_x?: number;
  scroll_y?: number;
  text?: string;
  keys?: unknown;
};

type SafetyCheck = {
  id?: string;
  code?: string;
  message?: string;
};

type ComputerCall = {
  id?: string;
  call_id?: string;
  action?: ComputerAction;
  pending_safety_checks?: SafetyCheck[];
};

export type OpenAiComputerUseResult = {
  text: string;
  steps: number;
  totalCostUsd: number;
  hitStepLimit: boolean;
};

function resolveInitialUrl(instruction: string) {
  const match = String(instruction || "").match(/\bhttps?:\/\/[^\s<>()]+/i);
  return match?.[0] || COMPUTER_USE_DEFAULT_START_URL;
}

function normalizeKeyToken(value: unknown) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return "";
  if (normalized === "ctrl") return "Control";
  if (normalized === "cmd") return "Meta";
  if (normalized === "esc") return "Escape";
  if (normalized === "pgup") return "PageUp";
  if (normalized === "pgdn") return "PageDown";
  if (normalized.length === 1) return normalized.toUpperCase();
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function normalizeShortcut(keys: unknown) {
  if (!Array.isArray(keys)) return "";
  return keys
    .map((entry) => normalizeKeyToken(entry))
    .filter(Boolean)
    .join("+");
}

function extractComputerCalls(output: unknown): ComputerCall[] {
  const items = Array.isArray(output) ? output : [];
  return items.filter((item): item is ComputerCall => {
    return Boolean(item) && typeof item === "object" && (item as { type?: unknown }).type === "computer_call";
  });
}

async function executeComputerAction(
  browserManager: BrowserManager,
  sessionKey: string,
  action: ComputerAction | undefined,
  stepTimeoutMs: number,
  signal?: AbortSignal
) {
  const type = String(action?.type || "").trim().toLowerCase();
  const x = Number(action?.x);
  const y = Number(action?.y);
  const button = String(action?.button || "left").trim().toLowerCase() || "left";

  if (type === "click") {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error("computer_use_click_missing_coordinates");
    }
    await browserManager.mouseClick(sessionKey, x, y, button as "left" | "middle" | "right", stepTimeoutMs, signal);
    return;
  }

  if (type === "double_click") {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error("computer_use_double_click_missing_coordinates");
    }
    await browserManager.mouseDoubleClick(sessionKey, x, y, button as "left" | "middle" | "right", stepTimeoutMs, signal);
    return;
  }

  if (type === "scroll") {
    await browserManager.mouseWheel(
      sessionKey,
      Number.isFinite(Number(action?.scroll_y)) ? Number(action?.scroll_y) : 0,
      Number.isFinite(Number(action?.scroll_x)) ? Number(action?.scroll_x) : 0,
      stepTimeoutMs,
      signal
    );
    return;
  }

  if (type === "keypress") {
    const shortcut = normalizeShortcut(action?.keys);
    if (!shortcut) {
      throw new Error("computer_use_keypress_missing_keys");
    }
    await browserManager.press(sessionKey, shortcut, stepTimeoutMs, signal);
    return;
  }

  if (type === "type") {
    const text = String(action?.text || "");
    if (!text) {
      throw new Error("computer_use_type_missing_text");
    }
    await browserManager.keyboardType(sessionKey, text, stepTimeoutMs, signal);
    return;
  }

  if (type === "wait") {
    await browserManager.wait(sessionKey, stepTimeoutMs, signal);
    return;
  }

  throw new Error(`computer_use_action_unsupported:${type || "unknown"}`);
}

export async function runOpenAiComputerUseTask({
  openai,
  browserManager,
  store,
  sessionKey,
  instruction,
  model = COMPUTER_USE_DEFAULT_MODEL,
  maxSteps,
  stepTimeoutMs,
  trace,
  logSource,
  signal
}: ComputerUseOptions): Promise<OpenAiComputerUseResult> {
  throwIfAborted(signal, "Computer use task cancelled");

  const startedAt = Date.now();
  const initialUrl = resolveInitialUrl(instruction);
  const resolvedModel = String(model || COMPUTER_USE_DEFAULT_MODEL).trim() || COMPUTER_USE_DEFAULT_MODEL;
  let step = 0;
  let totalCostUsd = 0;
  let hitStepLimit = false;
  let finalText = "";

  try {
    await browserManager.open(sessionKey, initialUrl, stepTimeoutMs, signal);
    let screenshot = await browserManager.screenshot(sessionKey, stepTimeoutMs, signal);
    let currentUrl = await browserManager.currentUrl(sessionKey, stepTimeoutMs, signal).catch(() => initialUrl);

    let response = await openai.responses.create({
      model: resolvedModel,
      tools: [{
        type: "computer-preview",
        display_width: COMPUTER_USE_DISPLAY_WIDTH,
        display_height: COMPUTER_USE_DISPLAY_HEIGHT,
        environment: "browser"
      }],
      input: [{
        role: "user",
        content: [
          {
            type: "input_text",
            text: [
              `Current browser URL: ${currentUrl || initialUrl}`,
              `Task: ${instruction}`
            ].join("\n")
          },
          {
            type: "input_image",
            image_url: screenshot,
            detail: "auto"
          }
        ]
      }],
      reasoning: {
        summary: "concise"
      },
      truncation: "auto"
    }, { signal });

    while (step < maxSteps) {
      throwIfAborted(signal, "Computer use task cancelled");
      const usage = extractOpenAiResponseUsage(response);
      totalCostUsd += estimateUsdCost({
        provider: "openai",
        model: resolvedModel,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        cacheReadTokens: usage.cacheReadTokens
      });

      const computerCalls = extractComputerCalls(response.output);
      if (!computerCalls.length) {
        finalText = extractOpenAiResponseText(response) || "Computer use task completed.";
        break;
      }

      step += 1;
      const nextInputs = [];

      for (const computerCall of computerCalls) {
        const callId = String(computerCall.call_id || computerCall.id || "").trim();
        if (!callId) {
          throw new Error("computer_use_missing_call_id");
        }

        const pendingSafetyChecks = Array.isArray(computerCall.pending_safety_checks)
          ? computerCall.pending_safety_checks
          : [];
        if (pendingSafetyChecks.length) {
          const codes = pendingSafetyChecks
            .map((entry) => String(entry?.code || "").trim())
            .filter(Boolean)
            .join(", ");
          throw new Error(`computer_use_safety_check_required:${codes || "manual_review"}`);
        }

        await executeComputerAction(
          browserManager,
          sessionKey,
          computerCall.action,
          stepTimeoutMs,
          signal
        );

        screenshot = await browserManager.screenshot(sessionKey, stepTimeoutMs, signal);
        currentUrl = await browserManager.currentUrl(sessionKey, stepTimeoutMs, signal).catch(() => currentUrl);
        nextInputs.push({
          type: "computer_call_output",
          call_id: callId,
          acknowledged_safety_checks: [],
          output: {
            type: "computer_screenshot",
            image_url: screenshot
          },
          current_url: currentUrl || undefined
        });
      }

      response = await openai.responses.create({
        model: resolvedModel,
        previous_response_id: response.id,
        tools: [{
          type: "computer-preview",
          display_width: COMPUTER_USE_DISPLAY_WIDTH,
          display_height: COMPUTER_USE_DISPLAY_HEIGHT,
          environment: "browser"
        }],
        input: nextInputs,
        truncation: "auto"
      }, { signal });
    }

    if (!finalText) {
      hitStepLimit = true;
      finalText = "Computer use task reached the maximum step limit before finishing.";
    }

    store.logAction({
      kind: "browser_browse_call",
      guildId: trace.guildId || null,
      channelId: trace.channelId || null,
      userId: trace.userId || null,
      content: String(instruction || "").slice(0, 200),
      metadata: {
        runtime: "openai_computer_use",
        model: resolvedModel,
        steps: step,
        hitStepLimit,
        source: logSource ?? trace.source ?? null,
        durationMs: Math.max(0, Date.now() - startedAt)
      },
      usdCost: totalCostUsd
    });

    return {
      text: finalText,
      steps: step,
      totalCostUsd,
      hitStepLimit
    };
  } catch (error) {
    if (isAbortError(error) || signal?.aborted) {
      throw createAbortError(signal?.reason || error);
    }
    throw error;
  } finally {
    await browserManager.close(sessionKey).catch(() => undefined);
  }
}
