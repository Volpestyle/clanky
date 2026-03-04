import {
  runClaudeCli,
  buildCodeAgentCliArgs,
  parseClaudeCodeStreamOutput,
  normalizeClaudeCodeCliError
} from "../llmClaudeCode.ts";
import path from "node:path";

interface CodeAgentTrace {
  guildId?: string | null;
  channelId?: string | null;
  userId?: string | null;
  source?: string | null;
}

interface CodeAgentOptions {
  instruction: string;
  cwd: string;
  maxTurns: number;
  timeoutMs: number;
  maxBufferBytes: number;
  model: string;
  trace: CodeAgentTrace;
  store: {
    logAction: (entry: Record<string, unknown>) => void;
  };
}

interface CodeAgentResult {
  text: string;
  costUsd: number;
  isError: boolean;
  errorMessage: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheWriteTokens: number;
    cacheReadTokens: number;
  };
}

const activeTaskCount = { current: 0 };

export function getActiveCodeAgentTaskCount(): number {
  return activeTaskCount.current;
}

export function isCodeAgentUserAllowed(userId: string, settings: Record<string, unknown>): boolean {
  const codeAgent = settings?.codeAgent as Record<string, unknown> | undefined;
  if (!codeAgent?.enabled) return false;
  const allowedUserIds = codeAgent?.allowedUserIds;
  if (!Array.isArray(allowedUserIds) || allowedUserIds.length === 0) return false;
  return allowedUserIds.includes(String(userId || ""));
}

export function resolveCodeAgentCwd(settingsCwd: string, fallbackBaseDir: string): string {
  const raw = String(settingsCwd || "").trim();
  if (raw) return raw;
  // Default: "web" directory one level above the app root
  return path.resolve(fallbackBaseDir, "..", "web");
}

export async function runCodeAgent(options: CodeAgentOptions): Promise<CodeAgentResult> {
  const {
    instruction,
    cwd,
    maxTurns,
    timeoutMs,
    maxBufferBytes,
    model,
    trace,
    store
  } = options;

  const args = buildCodeAgentCliArgs({
    model,
    maxTurns,
    instruction
  });

  activeTaskCount.current++;
  const startMs = Date.now();

  try {
    const result = await runClaudeCli({
      args,
      input: "",
      timeoutMs,
      maxBufferBytes,
      cwd
    });

    const parsed = parseClaudeCodeStreamOutput(result.stdout);
    const agentResult: CodeAgentResult = parsed
      ? {
          text: parsed.text,
          costUsd: parsed.costUsd,
          isError: parsed.isError,
          errorMessage: parsed.isError ? parsed.errorMessage : "",
          usage: parsed.usage
        }
      : {
          text: result.stdout.slice(0, 2000) || "Code agent completed with no parseable output.",
          costUsd: 0,
          isError: false,
          errorMessage: "",
          usage: { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 }
        };

    store.logAction({
      kind: "code_agent_call",
      guildId: trace.guildId || null,
      channelId: trace.channelId || null,
      userId: trace.userId || null,
      content: instruction.slice(0, 200),
      metadata: {
        model,
        maxTurns,
        cwd,
        isError: agentResult.isError,
        usage: agentResult.usage,
        source: trace.source,
        durationMs: Date.now() - startMs
      },
      usdCost: agentResult.costUsd
    });

    return agentResult;
  } catch (error) {
    const normalized = normalizeClaudeCodeCliError(error, {
      timeoutPrefix: "Code agent timed out",
      timeoutMs
    });

    store.logAction({
      kind: "code_agent_error",
      guildId: trace.guildId || null,
      channelId: trace.channelId || null,
      userId: trace.userId || null,
      content: instruction.slice(0, 200),
      metadata: {
        model,
        maxTurns,
        cwd,
        isTimeout: normalized.isTimeout,
        errorMessage: normalized.message,
        source: trace.source,
        durationMs: Date.now() - startMs
      }
    });

    return {
      text: normalized.message,
      costUsd: 0,
      isError: true,
      errorMessage: normalized.message,
      usage: { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 }
    };
  } finally {
    activeTaskCount.current = Math.max(0, activeTaskCount.current - 1);
  }
}
