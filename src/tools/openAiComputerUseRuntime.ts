import type OpenAI from "openai";
import { estimateUsdCost } from "../llm/pricing.ts";
import { extractOpenAiResponseText, extractOpenAiResponseUsage } from "../llm/llmHelpers.ts";
import type { ImageInput } from "../llm/serviceShared.ts";
import type { BrowserManager } from "../services/BrowserManager.ts";
import { createAbortError, isAbortError, throwIfAborted } from "./browserTaskRuntime.ts";

const COMPUTER_USE_DEFAULT_MODEL = "gpt-5.4";
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
  headed?: boolean;
  maxSteps: number;
  stepTimeoutMs: number;
  sessionTimeoutMs?: number;
  trace: ComputerUseTrace;
  logSource?: string | null;
  signal?: AbortSignal;
};

type ComputerActionPoint = {
  x: number;
  y: number;
};

type ComputerAction =
  | {
      type: "click";
      x: number;
      y: number;
      button?: "left" | "right" | "wheel" | "back" | "forward";
    }
  | {
      type: "double_click";
      x: number;
      y: number;
    }
  | {
      type: "scroll";
      x?: number;
      y?: number;
      scroll_x?: number;
      scroll_y?: number;
    }
  | {
      type: "type";
      text: string;
    }
  | {
      type: "wait";
    }
  | {
      type: "keypress";
      keys: string[];
    }
  | {
      type: "drag";
      path: ComputerActionPoint[];
    }
  | {
      type: "move";
      x: number;
      y: number;
    }
  | {
      type: "screenshot";
    };

type SafetyCheck = {
  id?: string;
  code?: string;
  message?: string;
};

type ComputerCall = {
  id?: string;
  call_id?: string;
  actions?: ComputerAction[];
  pending_safety_checks?: SafetyCheck[];
  type?: string;
};

type ComputerToolDefinition = {
  type: "computer";
  display_width: number;
  display_height: number;
  environment: "browser";
};

type ResponseImageInput = {
  type: "input_image";
  image_url: string;
  detail: "original";
};

type ResponseTextInput = {
  type: "input_text";
  text: string;
};

type ResponseUserMessage = {
  role: "user";
  content: Array<ResponseTextInput | ResponseImageInput>;
};

type ComputerCallOutputItem = {
  type: "computer_call_output";
  call_id: string;
  acknowledged_safety_checks?: Array<{
    id: string;
    code: string;
    message: string;
  }>;
  output: {
    type: "computer_screenshot";
    image_url: string;
  };
};

type OpenAiComputerRequest = {
  model: string;
  tools: [ComputerToolDefinition];
  input: Array<ResponseUserMessage | ComputerCallOutputItem>;
  previous_response_id?: string;
  reasoning?: {
    summary: "concise";
  };
};

type OpenAiComputerResponse = {
  id?: string;
  output?: Array<ComputerCall | Record<string, unknown>>;
  output_text?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: {
      cached_tokens?: number;
    };
  };
};

export type OpenAiComputerUseResult = {
  text: string;
  steps: number;
  totalCostUsd: number;
  hitStepLimit: boolean;
  imageInputs?: ImageInput[];
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

function normalizeShortcut(keys: string[]) {
  return keys.map((entry) => normalizeKeyToken(entry)).filter(Boolean).join("+");
}

function extractComputerCalls(output: unknown): ComputerCall[] {
  const items = Array.isArray(output) ? output : [];
  return items.filter((item): item is ComputerCall => {
    return Boolean(item) && typeof item === "object" && (item as { type?: unknown }).type === "computer_call";
  });
}

function getComputerToolDefinition(): ComputerToolDefinition {
  return {
    type: "computer",
    display_width: COMPUTER_USE_DISPLAY_WIDTH,
    display_height: COMPUTER_USE_DISPLAY_HEIGHT,
    environment: "browser"
  };
}

async function sendComputerRequest(
  openai: OpenAI,
  body: OpenAiComputerRequest,
  signal?: AbortSignal
): Promise<OpenAiComputerResponse> {
  return await openai.post<OpenAiComputerRequest, OpenAiComputerResponse>("/responses", {
    body,
    signal
  });
}

async function executeComputerAction(
  browserManager: BrowserManager,
  sessionKey: string,
  action: ComputerAction,
  stepTimeoutMs: number,
  signal?: AbortSignal
) {
  if (action.type === "click") {
    if (!Number.isFinite(action.x) || !Number.isFinite(action.y)) {
      throw new Error("computer_use_click_missing_coordinates");
    }
    const button = action.button === "wheel" ? "middle" : action.button || "left";
    await browserManager.mouseClick(sessionKey, action.x, action.y, button, stepTimeoutMs, signal);
    return false;
  }

  if (action.type === "double_click") {
    if (!Number.isFinite(action.x) || !Number.isFinite(action.y)) {
      throw new Error("computer_use_double_click_missing_coordinates");
    }
    await browserManager.mouseDoubleClick(sessionKey, action.x, action.y, "left", stepTimeoutMs, signal);
    return false;
  }

  if (action.type === "scroll") {
    if (Number.isFinite(action.x) && Number.isFinite(action.y)) {
      await browserManager.mouseMove(sessionKey, action.x, action.y, stepTimeoutMs, signal);
    }
    await browserManager.mouseWheel(
      sessionKey,
      Number.isFinite(Number(action.scroll_y)) ? Number(action.scroll_y) : 0,
      Number.isFinite(Number(action.scroll_x)) ? Number(action.scroll_x) : 0,
      stepTimeoutMs,
      signal
    );
    return false;
  }

  if (action.type === "keypress") {
    const shortcut = normalizeShortcut(Array.isArray(action.keys) ? action.keys : []);
    if (!shortcut) {
      throw new Error("computer_use_keypress_missing_keys");
    }
    await browserManager.press(sessionKey, shortcut, stepTimeoutMs, signal);
    return false;
  }

  if (action.type === "type") {
    const text = String(action.text || "");
    if (!text) {
      throw new Error("computer_use_type_missing_text");
    }
    await browserManager.keyboardType(sessionKey, text, stepTimeoutMs, signal);
    return false;
  }

  if (action.type === "wait") {
    await browserManager.wait(sessionKey, stepTimeoutMs, signal);
    return false;
  }

  if (action.type === "move") {
    if (!Number.isFinite(action.x) || !Number.isFinite(action.y)) {
      throw new Error("computer_use_move_missing_coordinates");
    }
    await browserManager.mouseMove(sessionKey, action.x, action.y, stepTimeoutMs, signal);
    return false;
  }

  if (action.type === "drag") {
    const path = Array.isArray(action.path)
      ? action.path.filter((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y))
      : [];
    if (path.length < 2) {
      throw new Error("computer_use_drag_missing_path");
    }
    await browserManager.mouseDrag(sessionKey, path, stepTimeoutMs, signal);
    return false;
  }

  if (action.type === "screenshot") {
    return true;
  }

  const actionType = (action as { type?: string }).type || "unknown";
  throw new Error(`computer_use_action_unsupported:${actionType}`);
}

export async function runOpenAiComputerUseTask({
  openai,
  browserManager,
  store,
  sessionKey,
  instruction,
  model = COMPUTER_USE_DEFAULT_MODEL,
  headed,
  maxSteps,
  stepTimeoutMs,
  sessionTimeoutMs,
  trace,
  logSource,
  signal
}: ComputerUseOptions): Promise<OpenAiComputerUseResult> {
  throwIfAborted(signal, "Computer use task cancelled");
  browserManager.configureSession(sessionKey, {
    headed,
    sessionTimeoutMs
  });

  const startedAt = Date.now();
  const initialUrl = resolveInitialUrl(instruction);
  const resolvedModel = String(model || COMPUTER_USE_DEFAULT_MODEL).trim() || COMPUTER_USE_DEFAULT_MODEL;
  const toolDefinition = getComputerToolDefinition();
  let step = 0;
  let totalCostUsd = 0;
  let hitStepLimit = false;
  let finalText = "";

  try {
    await browserManager.open(sessionKey, initialUrl, stepTimeoutMs, signal);
    let screenshot = await browserManager.screenshot(sessionKey, stepTimeoutMs, signal);
    let currentUrl = await browserManager.currentUrl(sessionKey, stepTimeoutMs, signal).catch(() => initialUrl);

    let response = await sendComputerRequest(
      openai,
      {
        model: resolvedModel,
        tools: [toolDefinition],
        input: [{
          role: "user",
          content: [
            {
              type: "input_text",
              text: [`Current browser URL: ${currentUrl || initialUrl}`, `Task: ${instruction}`].join("\n")
            },
            {
              type: "input_image",
              image_url: screenshot,
              detail: "original"
            }
          ]
        }],
        reasoning: {
          summary: "concise"
        }
      },
      signal
    );

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
      const nextInputs: ComputerCallOutputItem[] = [];

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

        const actions = Array.isArray(computerCall.actions) ? computerCall.actions : [];
        for (const action of actions) {
          await executeComputerAction(browserManager, sessionKey, action, stepTimeoutMs, signal);
        }

        screenshot = await browserManager.screenshot(sessionKey, stepTimeoutMs, signal);
        currentUrl = await browserManager.currentUrl(sessionKey, stepTimeoutMs, signal).catch(() => currentUrl);
        nextInputs.push({
          type: "computer_call_output",
          call_id: callId,
          acknowledged_safety_checks: [],
          output: {
            type: "computer_screenshot",
            image_url: screenshot
          }
        });
      }

      response = await sendComputerRequest(
        openai,
        {
          model: resolvedModel,
          previous_response_id: response.id,
          tools: [toolDefinition],
          input: nextInputs
        },
        signal
      );
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
        currentUrl: currentUrl || null,
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
    await browserManager.close(sessionKey);
  }
}
