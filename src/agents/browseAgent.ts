import type { LLMService, ToolLoopContentBlock, ToolLoopMessage } from "../llm.ts";
import type { BrowserManager } from "../services/BrowserManager.ts";
import { BROWSER_AGENT_TOOL_DEFINITIONS, executeBrowserTool } from "../tools/browserTools.ts";

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
  store: { logAction: (entry: {
    kind: string;
    guildId?: string | null;
    channelId?: string | null;
    userId?: string | null;
    content?: string;
    metadata?: Record<string, unknown>;
    usdCost?: number;
  }) => void };
  sessionKey: string;
  instruction: string;
  provider: string;
  model: string;
  maxSteps: number;
  stepTimeoutMs: number;
  trace: BrowseAgentTrace;
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
    trace
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
      step++;

      const response = await llm.chatWithTools({
        provider,
        model,
        systemPrompt: BROWSE_AGENT_SYSTEM_PROMPT,
        messages,
        tools: BROWSER_AGENT_TOOL_DEFINITIONS,
        maxOutputTokens: 4096,
        temperature: 0.7,
        trace
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
          stepTimeoutMs
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
    await browserManager.close(sessionKey).catch(() => undefined);
  }

  return {
    text: finalText,
    steps: step,
    totalCostUsd,
    hitStepLimit
  };
}
