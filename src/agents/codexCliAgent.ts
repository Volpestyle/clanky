import { createCodexCliStreamSession, type CodexCliStreamSessionLike, normalizeCodexCliError, parseCodexCliJsonlOutput } from "../llm/llmCodexCli.ts";
import { throwIfAborted } from "../tools/browserTaskRuntime.ts";
import { BaseAgentSession } from "./baseAgentSession.ts";
import type { SubAgentTurnOptions, SubAgentTurnResult } from "./subAgentSession.ts";
import { EMPTY_USAGE, generateSessionId } from "./subAgentSession.ts";
import type { CodeAgentWorkspaceLease } from "./codeAgentWorkspace.ts";

interface CodeAgentTrace {
  guildId?: string | null;
  channelId?: string | null;
  userId?: string | null;
  source?: string | null;
}

const activeCodexCliTaskCount = { current: 0 };

export function getActiveCodexCliAgentTaskCount(): number {
  return activeCodexCliTaskCount.current;
}

interface CodexCliAgentSessionOptions {
  scopeKey: string;
  cwd: string;
  model: string;
  timeoutMs: number;
  maxBufferBytes: number;
  trace: CodeAgentTrace;
  store: {
    logAction: (entry: Record<string, unknown>) => void;
  };
  workspace?: CodeAgentWorkspaceLease | null;
}

export class CodexCliAgentSession extends BaseAgentSession {
  private readonly streamSession: CodexCliStreamSessionLike;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly trace: CodeAgentTrace;
  private readonly store: { logAction: (entry: Record<string, unknown>) => void };
  private readonly workspace: CodeAgentWorkspaceLease | null;
  private turnCount: number;
  private workspaceReleased: boolean;
  private lastTurnInput: string;
  private lastTurnStartedAtMs: number;

  constructor(options: CodexCliAgentSessionOptions) {
    const { scopeKey, cwd, model, timeoutMs, maxBufferBytes, trace, store, workspace = null } = options;
    super({
      id: generateSessionId("code", scopeKey),
      type: "code",
      ownerUserId: trace.userId ?? null,
      logAction: store.logAction
    });
    this.model = String(model || "").trim();
    this.timeoutMs = timeoutMs;
    this.trace = trace;
    this.store = store;
    this.workspace = workspace;
    this.turnCount = 0;
    this.workspaceReleased = false;
    this.lastTurnInput = "";
    this.lastTurnStartedAtMs = 0;
    this.streamSession = createCodexCliStreamSession({ model: this.model, maxBufferBytes, cwd });
  }

  protected async executeTurn(input: string, options: SubAgentTurnOptions): Promise<SubAgentTurnResult> {
    this.turnCount += 1;
    this.lastTurnInput = String(input || "");
    this.lastTurnStartedAtMs = Date.now();
    const turnSignal = options.signal;

    try {
      throwIfAborted(turnSignal, "Codex CLI session cancelled");
      activeCodexCliTaskCount.current += 1;
      const result = await this.streamSession.run({
        input,
        timeoutMs: this.timeoutMs,
        signal: turnSignal
      });
      const parsed = parseCodexCliJsonlOutput(result.stdout, this.model);
      const turnResult: SubAgentTurnResult = parsed
        ? {
            text: parsed.text,
            costUsd: parsed.costUsd,
            isError: parsed.isError,
            errorMessage: parsed.isError ? parsed.errorMessage : "",
            usage: parsed.usage
          }
        : {
            text: result.stdout.slice(0, 2000) || "Code agent turn completed with no parseable output.",
            costUsd: 0,
            isError: false,
            errorMessage: "",
            usage: { ...EMPTY_USAGE }
          };

      this.store.logAction({
        kind: "code_agent_call",
        guildId: this.trace.guildId || null,
        channelId: this.trace.channelId || null,
        userId: this.trace.userId || null,
        content: input.slice(0, 200),
        metadata: {
          provider: "codex-cli",
          model: this.model,
          sessionId: this.id,
          turnNumber: this.turnCount,
          workspaceMode: this.workspace?.mode || null,
          workspaceBranch: this.workspace?.branch || null,
          workspaceBaseRef: this.workspace?.baseRef || null,
          workspaceRepoRoot: this.workspace?.repoRoot || null,
          workspaceCwd: this.workspace?.cwd || null,
          isError: turnResult.isError,
          usage: turnResult.usage,
          source: this.trace.source,
          durationMs: Date.now() - this.lastTurnStartedAtMs
        },
        usdCost: turnResult.costUsd
      });
      return turnResult;
    } finally {
      activeCodexCliTaskCount.current = Math.max(0, activeCodexCliTaskCount.current - 1);
    }
  }

  protected onCancelled(_reason: string): void {
    this.streamSession.close();
    this.releaseWorkspace();
  }

  protected handleTurnError(error: unknown, _input: string): SubAgentTurnResult {
    const normalized = normalizeCodexCliError(error, {
      timeoutPrefix: "Code agent session turn timed out",
      timeoutMs: this.timeoutMs
    });
    this.store.logAction({
      kind: "code_agent_error",
      guildId: this.trace.guildId || null,
      channelId: this.trace.channelId || null,
      userId: this.trace.userId || null,
      content: this.lastTurnInput.slice(0, 200),
      metadata: {
        provider: "codex-cli",
        model: this.model,
        sessionId: this.id,
        turnNumber: this.turnCount,
        workspaceMode: this.workspace?.mode || null,
        workspaceBranch: this.workspace?.branch || null,
        workspaceBaseRef: this.workspace?.baseRef || null,
        workspaceRepoRoot: this.workspace?.repoRoot || null,
        workspaceCwd: this.workspace?.cwd || null,
        isTimeout: normalized.isTimeout,
        errorMessage: normalized.message,
        source: this.trace.source,
        durationMs: Date.now() - this.lastTurnStartedAtMs
      }
    });
    this.releaseWorkspace();
    return {
      text: normalized.message,
      costUsd: 0,
      isError: true,
      errorMessage: normalized.message,
      usage: { ...EMPTY_USAGE }
    };
  }

  private releaseWorkspace() {
    if (this.workspaceReleased) return;
    this.workspaceReleased = true;
    this.workspace?.cleanup();
  }
}
