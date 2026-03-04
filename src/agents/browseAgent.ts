import type { LLMService, ToolLoopContentBlock, ToolLoopMessage } from "../llm.ts";
import type { BrowserManager } from "../services/BrowserManager.ts";
import { BROWSER_AGENT_TOOL_DEFINITIONS, executeBrowserTool } from "../tools/browserTools.ts";
import { throwIfAborted } from "../tools/browserTaskRuntime.ts";
import type { SubAgentSession, SubAgentTurnResult } from "./subAgentSession.ts";
import { generateSessionId } from "./subAgentSession.ts";

const BROWSE_AGENT_SYSTEM_PROMPT = `You are a web browsing agent.
Your goal is to complete the user's instruction by navigating the web, interacting with pages, and extracting the final answer or result.

ALWAYS use the 'browser_open' tool first to start your session.
After opening or interacting with a page, you will receive a snapshot of the accessibility tree with references like @e1, @e2.
Use these references to click or type into elements.

When you have found the answer or completed the objective, communicate it clearly in your final response.
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
  maxSteps: number;
  stepTimeoutMs: number;
  trace: BrowseAgentTrace;
  signal?: AbortSignal;
}

interface BrowseAgentResult {
  text: string;
  steps: number;
  totalCostUsd: number;
  hitStepLimit: boolean;
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
    maxSteps,
    stepTimeoutMs,
    trace,
    signal
  } = options;

  const messages: ToolLoopMessage[] = [
    { role: "user", content: instruction }
  ];

  let step = 0;
  let totalCostUsd = 0;
  let finalText = "";
  let hitStepLimit = false;

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

      if (toolCalls.length === 0) {
        const textBlocks = response.content.filter((block) => block.type === "text");
        finalText = textBlocks
          .map((block) => block.text.trim())
          .filter(Boolean)
          .join("\n\n") || "The agent finished without returning text.";
        break;
      }

      const toolResults: ToolLoopContentBlock[] = [];

      for (const toolCall of toolCalls) {
        store.logAction({
          kind: "browser_tool_step",
          guildId: trace.guildId || null,
          channelId: trace.channelId || null,
          userId: trace.userId || null,
          content: toolCall.name,
          metadata: {
            step,
            tool: toolCall.name,
            sessionKey
          }
        });

        const result = await executeBrowserTool(
          browserManager,
          sessionKey,
          toolCall.name,
          toolCall.input as Record<string, unknown>,
          stepTimeoutMs,
          signal
        );

        toolResults.push({
          type: "tool_result",
          toolCallId: toolCall.id,
          content: result,
          isError: result.toLowerCase().startsWith("error:")
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
      console.warn(`[browseAgent] Error closing browser session ${sessionKey}:`, err);
    });
  }

  return {
    text: finalText,
    steps: step,
    totalCostUsd,
    hitStepLimit
  };
}

// ---------------------------------------------------------------------------
// BrowserAgentSession — persistent multi-turn wrapper around the browse agent
// ---------------------------------------------------------------------------

export interface BrowserAgentSessionOptions {
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
  maxSteps: number;
  stepTimeoutMs: number;
  trace: BrowseAgentTrace;
  signal?: AbortSignal;
}

const EMPTY_USAGE = { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 };

/**
 * BrowserAgentSession keeps the browser open and the conversation history
 * across multiple turns. Each `runTurn()` call runs the internal tool loop
 * until the LLM produces text without tool calls (the "yield" point), then
 * pauses and returns the result. Follow-up messages are injected as new user
 * turns and the loop resumes.
 */
export class BrowserAgentSession implements SubAgentSession {
  readonly id: string;
  readonly type = "browser" as const;
  readonly createdAt: number;
  readonly ownerUserId: string | null;
  lastUsedAt: number;
  status: SubAgentSession["status"];

  private readonly llm: LLMService;
  private readonly browserManager: BrowserManager;
  private readonly store: BrowserAgentSessionOptions["store"];
  private readonly sessionKey: string;
  private readonly provider: string;
  private readonly model: string;
  private readonly maxSteps: number;
  private readonly stepTimeoutMs: number;
  private readonly trace: BrowseAgentTrace;
  private readonly signal?: AbortSignal;

  private messages: ToolLoopMessage[];
  private stepCount: number;
  private totalCostUsd: number;
  private browserClosed: boolean;

  constructor(options: BrowserAgentSessionOptions) {
    this.id = generateSessionId("browser", options.scopeKey);
    this.createdAt = Date.now();
    this.lastUsedAt = Date.now();
    this.ownerUserId = options.trace.userId ?? null;
    this.status = "idle";

    this.llm = options.llm;
    this.browserManager = options.browserManager;
    this.store = options.store;
    this.sessionKey = options.sessionKey;
    this.provider = options.provider;
    this.model = options.model;
    this.maxSteps = options.maxSteps;
    this.stepTimeoutMs = options.stepTimeoutMs;
    this.trace = options.trace;
    this.signal = options.signal;

    this.messages = [];
    this.stepCount = 0;
    this.totalCostUsd = 0;
    this.browserClosed = false;
  }

  async runTurn(input: string): Promise<SubAgentTurnResult> {
    if (this.status === "cancelled" || this.status === "error") {
      return {
        text: `Session is ${this.status} and cannot accept new turns.`,
        costUsd: 0,
        isError: true,
        errorMessage: `Session ${this.status}`,
        usage: { ...EMPTY_USAGE }
      };
    }

    this.status = "running";
    this.lastUsedAt = Date.now();

    // Add the user's input as a new message
    this.messages.push({ role: "user", content: input });

    let turnCostUsd = 0;
    const turnStartMs = Date.now();
    const turnUsage = { ...EMPTY_USAGE };

    try {
      // Run the tool loop until we get text without tool calls (yield point)
      while (this.stepCount < this.maxSteps) {
        throwIfAborted(this.signal, "Browse agent session cancelled");
        this.stepCount++;

        const response = await this.llm.chatWithTools({
          provider: this.provider,
          model: this.model,
          systemPrompt: BROWSE_AGENT_SYSTEM_PROMPT,
          messages: this.messages,
          tools: BROWSER_AGENT_TOOL_DEFINITIONS,
          maxOutputTokens: 4096,
          temperature: 0.7,
          trace: this.trace,
          signal: this.signal
        });

        turnCostUsd += response.costUsd;
        this.totalCostUsd += response.costUsd;
        turnUsage.inputTokens += response.usage.inputTokens;
        turnUsage.outputTokens += response.usage.outputTokens;
        turnUsage.cacheWriteTokens += response.usage.cacheWriteTokens;
        turnUsage.cacheReadTokens += response.usage.cacheReadTokens;
        this.messages.push({ role: "assistant", content: response.content });

        const toolCalls = response.content.filter((block) => block.type === "tool_call");

        if (toolCalls.length === 0) {
          // No tool calls — this is the yield point
          const textBlocks = response.content.filter((block) => block.type === "text");
          const text = textBlocks
            .map((block) => block.text.trim())
            .filter(Boolean)
            .join("\n\n") || "The agent paused without returning text.";

          this.status = "idle";
          this.lastUsedAt = Date.now();

          this.store.logAction({
            kind: "browser_agent_session_turn",
            guildId: this.trace.guildId || null,
            channelId: this.trace.channelId || null,
            userId: this.trace.userId || null,
            content: input.slice(0, 200),
            metadata: {
              sessionId: this.id,
              steps: this.stepCount,
              turnCostUsd,
              source: this.trace.source,
              durationMs: Date.now() - turnStartMs
            },
            usdCost: turnCostUsd
          });

          return {
            text,
            costUsd: turnCostUsd,
            isError: false,
            errorMessage: "",
            usage: turnUsage
          };
        }

        // Execute tool calls
        const toolResults: ToolLoopContentBlock[] = [];
        for (const toolCall of toolCalls) {
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
              sessionId: this.id
            }
          });

          const result = await executeBrowserTool(
            this.browserManager,
            this.sessionKey,
            toolCall.name,
            toolCall.input as Record<string, unknown>,
            this.stepTimeoutMs,
            this.signal
          );

          toolResults.push({
            type: "tool_result",
            toolCallId: toolCall.id,
            content: result,
            isError: result.toLowerCase().startsWith("error:")
          });
        }

        this.messages.push({ role: "user", content: toolResults });
      }

      // Hit step limit
      this.status = "idle";
      this.lastUsedAt = Date.now();

      return {
        text: "Agent reached the maximum number of steps without finishing.",
        costUsd: turnCostUsd,
        isError: false,
        errorMessage: "",
        usage: turnUsage
      };
    } catch (error) {
      this.status = "error";
      this.lastUsedAt = Date.now();
      const message = error instanceof Error ? error.message : String(error);

      return {
        text: message,
        costUsd: turnCostUsd,
        isError: true,
        errorMessage: message,
        usage: turnUsage
      };
    }
  }

  close(): void {
    if (this.status === "cancelled") return;
    this.status = "cancelled";
    if (!this.browserClosed) {
      this.browserClosed = true;
      this.browserManager.close(this.sessionKey).catch((err) => {
        console.warn(`[BrowserAgentSession] Error closing session ${this.sessionKey}:`, err);
      });
    }
  }
}
