import type { LLMService, ToolLoopContentBlock, ToolLoopMessage } from "../llm.ts";
import type { ImageInput } from "../llm/serviceShared.ts";
import type { BrowserManager } from "../services/BrowserManager.ts";
import { BROWSER_AGENT_TOOL_DEFINITIONS, executeBrowserTool } from "../tools/browserTools.ts";
import { throwIfAborted } from "../tools/abortError.ts";
import { BaseAgentSession } from "./baseAgentSession.ts";
import type { SubAgentTurnOptions, SubAgentTurnResult } from "./subAgentSession.ts";
import { EMPTY_USAGE, generateSessionId } from "./subAgentSession.ts";

const BROWSE_AGENT_TOOL_RESULT_TRUNCATE_LEN = 800;
const BROWSE_AGENT_REASONING_TRUNCATE_LEN = 500;

function truncate(text: string, maxLen: number) {
  const s = String(text || "").trim();
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + `… (${s.length} chars total)`;
}

function extractTextContent(content: ToolLoopContentBlock[], separator = " ") {
  return (Array.isArray(content) ? content : [])
    .filter((block) => block.type === "text")
    .map((block) => String((block as { text?: string }).text || "").trim())
    .filter(Boolean)
    .join(separator);
}

const BROWSE_AGENT_SYSTEM_PROMPT = `You are a web browsing agent.
Your goal is to complete the user's instruction by navigating the web, interacting with pages, and extracting the final answer or result.

ALWAYS use the 'browser_open' tool first to start your session.
After opening or interacting with a page, you will receive a snapshot of the accessibility tree with references like @e1, @e2.
Use these references to click or type into elements.
When the task depends on visual appearance, layout, or non-text UI details, use 'browser_screenshot'. Screenshots are forwarded back to the parent brain for visual inspection.

When you have found the answer or completed the objective, communicate it clearly in your final response.
Use 'browser_close' only when you are fully done browsing and want to end this browser session.
Do NOT use tools indefinitely. If you are stuck or have the answer, stop using tools and explain what you found.`;

interface BrowseAgentTrace {
  guildId?: string | null;
  channelId?: string | null;
  userId?: string | null;
  source?: string | null;
}

interface BrowseAgentOptions {
  llm: LLMService;
  browserManager: BrowserManager;
  store: {
    logAction: (entry: {
      kind: string;
      guildId?: string | null;
      channelId?: string | null;
      userId?: string | null;
      content?: string;
      metadata?: Record<string, unknown>;
      usdCost?: number;
    }) => void
  };
  sessionKey: string;
  instruction: string;
  provider: string;
  model: string;
  headed?: boolean;
  profile?: string;
  maxSteps: number;
  stepTimeoutMs: number;
  sessionTimeoutMs?: number;
  trace: BrowseAgentTrace;
  signal?: AbortSignal;
}

interface BrowseAgentResult {
  text: string;
  steps: number;
  totalCostUsd: number;
  hitStepLimit: boolean;
  imageInputs?: ImageInput[];
}

function appendUniqueImageInputs(target: ImageInput[], extra: ImageInput[] | undefined) {
  const seen = new Set(
    target.map((input) => {
      const url = String(input?.url || "").trim();
      const mediaType = String(input?.mediaType || input?.contentType || "").trim().toLowerCase();
      const dataBase64 = String(input?.dataBase64 || "").trim();
      return url ? `url:${url}` : dataBase64 ? `inline:${mediaType}:${dataBase64.slice(0, 80)}` : "";
    })
  );

  for (const image of Array.isArray(extra) ? extra : []) {
    const url = String(image?.url || "").trim();
    const mediaType = String(image?.mediaType || image?.contentType || "").trim().toLowerCase();
    const dataBase64 = String(image?.dataBase64 || "").trim();
    const key = url ? `url:${url}` : dataBase64 ? `inline:${mediaType}:${dataBase64.slice(0, 80)}` : "";
    if (!key || seen.has(key)) continue;
    seen.add(key);
    target.push(image);
  }
}

export async function runBrowseAgent(options: BrowseAgentOptions): Promise<BrowseAgentResult> {
  const {
    llm,
    browserManager,
    store,
    sessionKey,
    instruction,
    provider,
    model,
    headed,
    profile,
    maxSteps,
    stepTimeoutMs,
    sessionTimeoutMs,
    trace,
    signal
  } = options;

  browserManager.configureSession(sessionKey, {
    headed,
    sessionTimeoutMs,
    profile
  });

  if (profile) {
    store.logAction({kind: "browser_agent", content: "browser_persistent_profile", metadata: { profile, sessionKey }});
  }

  const messages: ToolLoopMessage[] = [
    { role: "user", content: instruction }
  ];

  let step = 0;
  let totalCostUsd = 0;
  let finalText = "";
  let hitStepLimit = false;
  const capturedImageInputs: ImageInput[] = [];

  try {
    while (step < maxSteps) {
      throwIfAborted(signal, "Browse agent run cancelled");
      step++;

      const response = await llm.chatWithTools({
        provider,
        model,
        systemPrompt: BROWSE_AGENT_SYSTEM_PROMPT,
        messages,
        tools: BROWSER_AGENT_TOOL_DEFINITIONS,
        maxOutputTokens: 4096,
        temperature: 0.7,
        trace,
        signal
      });

      totalCostUsd += response.costUsd;

      messages.push({ role: "assistant", content: response.content });

      const toolCalls = response.content.filter((block) => block.type === "tool_call");

      const reasoning = extractTextContent(response.content);
      if (toolCalls.length === 0) {
        finalText = extractTextContent(response.content, "\n\n") || "The agent finished without returning text.";
        store.logAction({
          kind: "browser_agent_final",
          guildId: trace.guildId || null,
          channelId: trace.channelId || null,
          userId: trace.userId || null,
          content: truncate(finalText, BROWSE_AGENT_REASONING_TRUNCATE_LEN),
          metadata: {
            step,
            sessionKey,
            fullLength: finalText.length
          }
        });
        break;
      }

      if (reasoning) {
        store.logAction({
          kind: "browser_agent_reasoning",
          guildId: trace.guildId || null,
          channelId: trace.channelId || null,
          userId: trace.userId || null,
          content: truncate(reasoning, BROWSE_AGENT_REASONING_TRUNCATE_LEN),
          metadata: {
            step,
            sessionKey,
            fullLength: reasoning.length
          }
        });
      }

      const toolResults: ToolLoopContentBlock[] = [];

      for (const toolCall of toolCalls) {
        const toolInput = toolCall.input as Record<string, unknown>;
        store.logAction({
          kind: "browser_tool_step",
          guildId: trace.guildId || null,
          channelId: trace.channelId || null,
          userId: trace.userId || null,
          content: toolCall.name,
          metadata: {
            step,
            tool: toolCall.name,
            sessionKey,
            input: toolInput
          }
        });

        const result = await executeBrowserTool(
          browserManager,
          sessionKey,
          toolCall.name,
          toolInput,
          stepTimeoutMs,
          signal
        );

        store.logAction({
          kind: "browser_tool_result",
          guildId: trace.guildId || null,
          channelId: trace.channelId || null,
          userId: trace.userId || null,
          content: truncate(result.text, BROWSE_AGENT_TOOL_RESULT_TRUNCATE_LEN),
          metadata: {
            step,
            tool: toolCall.name,
            sessionKey,
            isError: Boolean(result.isError),
            fullLength: result.text.length,
            imageCount: Array.isArray(result.imageInputs) ? result.imageInputs.length : 0
          }
        });

        appendUniqueImageInputs(capturedImageInputs, result.imageInputs);

        toolResults.push({
          type: "tool_result",
          toolCallId: toolCall.id,
          content: result.text,
          isError: Boolean(result.isError)
        });
      }

      messages.push({
        role: "user",
        content: toolResults
      });
    }

    if (!finalText) {
      finalText = "Agent reached the maximum number of steps without finishing.";
      hitStepLimit = true;
    }
  } finally {
    await browserManager.close(sessionKey).catch((err) => {
      store.logAction({kind: "browser_agent", content: "browser_session_close_error", metadata: { sessionKey, error: String(err?.message || err) }});
    });
  }

  return {
    text: finalText,
    steps: step,
    totalCostUsd,
    hitStepLimit,
    imageInputs: capturedImageInputs
  };
}

// ---------------------------------------------------------------------------
// BrowserAgentSession — persistent multi-turn wrapper around the browse agent
// ---------------------------------------------------------------------------

interface BrowserAgentSessionOptions {
  scopeKey: string;
  llm: LLMService;
  browserManager: BrowserManager;
  store: {
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
  sessionKey: string;
  provider: string;
  model: string;
  headed?: boolean;
  profile?: string;
  maxSteps: number;
  stepTimeoutMs: number;
  sessionTimeoutMs?: number;
  trace: BrowseAgentTrace;
  signal?: AbortSignal;
}

/**
 * BrowserAgentSession keeps the browser open and the conversation history
 * across multiple turns. Each `runTurn()` call runs the internal tool loop
 * until the LLM produces text without tool calls (the "yield" point), then
 * pauses and returns the result. Follow-up messages are injected as new user
 * turns and the loop resumes.
 */
export class BrowserAgentSession extends BaseAgentSession {
  private readonly llm: LLMService;
  private readonly browserManager: BrowserManager;
  private readonly store: BrowserAgentSessionOptions["store"];
  private readonly sessionKey: string;
  private readonly provider: string;
  private readonly model: string;
  private readonly maxSteps: number;
  private readonly stepTimeoutMs: number;
  private readonly trace: BrowseAgentTrace;

  private messages: ToolLoopMessage[];
  private stepCount: number;
  private totalCostUsd: number;
  private browserClosed: boolean;
  private lastTurnInput: string;
  private lastTurnStartedAtMs: number;
  private lastTurnCostUsd: number;
  private lastTurnUsage: SubAgentTurnResult["usage"];
  private lastTurnImageInputs: ImageInput[];

  constructor(options: BrowserAgentSessionOptions) {
    super({
      id: generateSessionId("browser", options.scopeKey),
      type: "browser",
      ownerUserId: options.trace.userId ?? null,
      baseSignal: options.signal,
      logAction: (entry) => options.store.logAction(entry)
    });

    this.llm = options.llm;
    this.browserManager = options.browserManager;
    this.store = options.store;
    this.sessionKey = options.sessionKey;
    this.provider = options.provider;
    this.model = options.model;
    this.maxSteps = options.maxSteps;
    this.stepTimeoutMs = options.stepTimeoutMs;
    this.trace = options.trace;

    this.browserManager.configureSession(this.sessionKey, {
      headed: options.headed,
      sessionTimeoutMs: options.sessionTimeoutMs,
      profile: options.profile
    });

    this.messages = [];
    this.stepCount = 0;
    this.totalCostUsd = 0;
    this.browserClosed = false;
    this.lastTurnInput = "";
    this.lastTurnStartedAtMs = 0;
    this.lastTurnCostUsd = 0;
    this.lastTurnUsage = { ...EMPTY_USAGE };
    this.lastTurnImageInputs = [];
  }

  getBrowserSessionKey() {
    return this.sessionKey;
  }

  protected async executeTurn(input: string, options: SubAgentTurnOptions): Promise<SubAgentTurnResult> {
    const turnSignal = options.signal;
    this.lastTurnInput = String(input || "");
    this.lastTurnStartedAtMs = Date.now();
    this.lastTurnCostUsd = 0;
    this.lastTurnUsage = { ...EMPTY_USAGE };
    this.lastTurnImageInputs = [];

    // Add the user's input as a new message
    this.messages.push({ role: "user", content: input });

    const turnUsage = this.lastTurnUsage;
    let allowPostCloseFinalizationTurn = false;

    // Run the tool loop until we get text without tool calls (yield point)
    while (this.stepCount < this.maxSteps || allowPostCloseFinalizationTurn) {
      throwIfAborted(turnSignal, "Browse agent session cancelled");
      if (allowPostCloseFinalizationTurn) {
        allowPostCloseFinalizationTurn = false;
      } else {
        this.stepCount++;
      }

      const response = await this.llm.chatWithTools({
        provider: this.provider,
        model: this.model,
        systemPrompt: BROWSE_AGENT_SYSTEM_PROMPT,
        messages: this.messages,
        tools: BROWSER_AGENT_TOOL_DEFINITIONS,
        maxOutputTokens: 4096,
        temperature: 0.7,
        trace: this.trace,
        signal: turnSignal
      });

      this.lastTurnCostUsd += response.costUsd;
      this.totalCostUsd += response.costUsd;
      turnUsage.inputTokens += response.usage.inputTokens;
      turnUsage.outputTokens += response.usage.outputTokens;
      turnUsage.cacheWriteTokens += response.usage.cacheWriteTokens;
      turnUsage.cacheReadTokens += response.usage.cacheReadTokens;
      this.messages.push({ role: "assistant", content: response.content });

      const toolCalls = response.content.filter((block) => block.type === "tool_call");
      const sessionReasoning = extractTextContent(response.content);

      if (toolCalls.length === 0) {
        // No tool calls — this is the yield point
        const text = extractTextContent(response.content, "\n\n") || "The agent paused without returning text.";

        const sessionCompleted = this.browserClosed;

        this.store.logAction({
          kind: "browser_agent_session_turn",
          guildId: this.trace.guildId || null,
          channelId: this.trace.channelId || null,
          userId: this.trace.userId || null,
          content: input.slice(0, 200),
          metadata: {
            sessionId: this.id,
            steps: this.stepCount,
            turnCostUsd: this.lastTurnCostUsd,
            imageInputCount: this.lastTurnImageInputs.length,
            source: this.trace.source,
            durationMs: Date.now() - this.lastTurnStartedAtMs
          },
          usdCost: this.lastTurnCostUsd
        });

        return {
          text,
          costUsd: this.lastTurnCostUsd,
          imageInputs: this.lastTurnImageInputs,
          isError: false,
          errorMessage: "",
          sessionCompleted,
          usage: turnUsage
        };
      }

      if (this.browserClosed) {
        const textBlocks = response.content.filter((block) => block.type === "text");
        const text = textBlocks
          .map((block) => block.text.trim())
          .filter(Boolean)
          .join("\n\n");
        return {
          text: text || "Browser session closed before the agent produced a final answer.",
          costUsd: this.lastTurnCostUsd,
          imageInputs: this.lastTurnImageInputs,
          isError: !text,
          errorMessage: text ? "" : "Browser session closed before final answer",
          sessionCompleted: false,
          usage: turnUsage
        };
      }

      if (sessionReasoning) {
        this.store.logAction({
          kind: "browser_agent_reasoning",
          guildId: this.trace.guildId || null,
          channelId: this.trace.channelId || null,
          userId: this.trace.userId || null,
          content: truncate(sessionReasoning, BROWSE_AGENT_REASONING_TRUNCATE_LEN),
          metadata: {
            step: this.stepCount,
            sessionKey: this.sessionKey,
            sessionId: this.id,
            fullLength: sessionReasoning.length
          }
        });
      }

      // Execute tool calls
      const toolResults: ToolLoopContentBlock[] = [];
      let browserClosedThisResponse = false;
      for (const toolCall of toolCalls) {
        const sessionToolInput = toolCall.input as Record<string, unknown>;
        this.store.logAction({
          kind: "browser_tool_step",
          guildId: this.trace.guildId || null,
          channelId: this.trace.channelId || null,
          userId: this.trace.userId || null,
          content: toolCall.name,
          metadata: {
            step: this.stepCount,
            tool: toolCall.name,
            sessionKey: this.sessionKey,
            sessionId: this.id,
            input: sessionToolInput
          }
        });

        const result = await executeBrowserTool(
          this.browserManager,
          this.sessionKey,
          toolCall.name,
          sessionToolInput,
          this.stepTimeoutMs,
          turnSignal
        );

        this.store.logAction({
          kind: "browser_tool_result",
          guildId: this.trace.guildId || null,
          channelId: this.trace.channelId || null,
          userId: this.trace.userId || null,
          content: truncate(result.text, BROWSE_AGENT_TOOL_RESULT_TRUNCATE_LEN),
          metadata: {
            step: this.stepCount,
            tool: toolCall.name,
            sessionKey: this.sessionKey,
            sessionId: this.id,
            isError: Boolean(result.isError),
            fullLength: result.text.length,
            imageCount: Array.isArray(result.imageInputs) ? result.imageInputs.length : 0
          }
        });

        if (toolCall.name === "browser_close" && !result.isError) {
          this.browserClosed = true;
          browserClosedThisResponse = true;
        }

        appendUniqueImageInputs(this.lastTurnImageInputs, result.imageInputs);

        toolResults.push({
          type: "tool_result",
          toolCallId: toolCall.id,
          content: result.text,
          isError: Boolean(result.isError)
        });

        if (browserClosedThisResponse) break;
      }

      this.messages.push({ role: "user", content: toolResults });
      if (browserClosedThisResponse) {
        allowPostCloseFinalizationTurn = true;
      }
    }

    return {
      text: "Agent reached the maximum number of steps without finishing.",
      costUsd: this.lastTurnCostUsd,
      imageInputs: this.lastTurnImageInputs,
      isError: false,
      errorMessage: "",
      sessionCompleted: false,
      usage: turnUsage
    };
  }

  protected handleTurnError(error: unknown, _input: string): SubAgentTurnResult {
    const message = error instanceof Error ? error.message : String(error);
    return {
      text: message,
      costUsd: this.lastTurnCostUsd,
      imageInputs: this.lastTurnImageInputs,
      isError: true,
      errorMessage: message,
      sessionCompleted: false,
      usage: this.lastTurnUsage
    };
  }

  protected onCancelled(_reason: string): void {
    if (!this.browserClosed) {
      this.browserClosed = true;
      this.browserManager.close(this.sessionKey).catch((err) => {
        this.store.logAction({kind: "browser_agent", content: "browser_agent_session_close_error", metadata: { sessionKey: this.sessionKey, error: String(err?.message || err) }});
      });
    }
  }
}
