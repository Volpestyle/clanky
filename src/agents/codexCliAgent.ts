import { createCodexCliStreamSession, type CodexCliStreamSessionLike, normalizeCodexCliError, parseCodexCliJsonlOutput } from "../llm/llmCodexCli.ts";
import { createAbortError, isAbortError, throwIfAborted } from "../tools/browserTaskRuntime.ts";
import type { SubAgentRunTurnOptions, SubAgentSession, SubAgentTurnResult } from "./subAgentSession.ts";
import { generateSessionId } from "./subAgentSession.ts";
import type { CodeAgentWorkspaceLease } from "./codeAgentWorkspace.ts";

interface CodeAgentTrace {
  guildId?: string | null;
  channelId?: string | null;
  userId?: string | null;
  source?: string | null;
}

const EMPTY_USAGE = { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 };
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

export class CodexCliAgentSession implements SubAgentSession {
  readonly id: string;
  readonly type = "code" as const;
  readonly createdAt: number;
  readonly ownerUserId: string | null;
  lastUsedAt: number;
  status: SubAgentSession["status"];

  private readonly streamSession: CodexCliStreamSessionLike;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly trace: CodeAgentTrace;
  private readonly store: { logAction: (entry: Record<string, unknown>) => void };
  private readonly workspace: CodeAgentWorkspaceLease | null;
  private turnCount: number;
  private activeAbortController: AbortController | null;
  private workspaceReleased: boolean;

  constructor(options: CodexCliAgentSessionOptions) {
    const { scopeKey, cwd, model, timeoutMs, maxBufferBytes, trace, store, workspace = null } = options;
    this.id = generateSessionId("code", scopeKey);
    this.createdAt = Date.now();
    this.lastUsedAt = Date.now();
    this.ownerUserId = trace.userId ?? null;
    this.status = "idle";
    this.model = String(model || "").trim();
    this.timeoutMs = timeoutMs;
    this.trace = trace;
    this.store = store;
    this.workspace = workspace;
    this.turnCount = 0;
    this.activeAbortController = null;
    this.workspaceReleased = false;
    this.streamSession = createCodexCliStreamSession({ model: this.model, maxBufferBytes, cwd });
  }

  async runTurn(input: string, options: SubAgentRunTurnOptions = {}): Promise<SubAgentTurnResult> {
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
    this.turnCount += 1;
    const turnStartMs = Date.now();
    this.activeAbortController = new AbortController();
    const turnSignal = options.signal
      ? AbortSignal.any([this.activeAbortController.signal, options.signal])
      : this.activeAbortController.signal;

    try {
      throwIfAborted(turnSignal, "Codex CLI session cancelled");
      activeCodexCliTaskCount.current += 1;
      const result = await this.streamSession.run({
        input,
        timeoutMs: this.timeoutMs,
        signal: turnSignal,
        onEvent: options.onProgress
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

      this.status = "idle";
      this.lastUsedAt = Date.now();
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
          durationMs: Date.now() - turnStartMs
        },
        usdCost: turnResult.costUsd
      });
      return turnResult;
    } catch (error) {
      if (isAbortError(error) || turnSignal.aborted) {
        this.status = "cancelled";
        this.lastUsedAt = Date.now();
        this.releaseWorkspace();
        throw createAbortError(turnSignal.reason || error);
      }
      const normalized = normalizeCodexCliError(error, {
        timeoutPrefix: "Code agent session turn timed out",
        timeoutMs: this.timeoutMs
      });
      this.status = "error";
      this.lastUsedAt = Date.now();
      this.store.logAction({
        kind: "code_agent_error",
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
          isTimeout: normalized.isTimeout,
          errorMessage: normalized.message,
          source: this.trace.source,
          durationMs: Date.now() - turnStartMs
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
    } finally {
      this.activeAbortController = null;
      activeCodexCliTaskCount.current = Math.max(0, activeCodexCliTaskCount.current - 1);
    }
  }

  cancel(reason = "Codex CLI session cancelled"): void {
    if (this.status === "cancelled") return;
    this.status = "cancelled";
    try {
      this.activeAbortController?.abort(reason);
    } catch {
      // ignore
    }
    this.streamSession.close();
    this.releaseWorkspace();
  }

  close(): void {
    this.cancel("Codex CLI session closed");
  }

  private releaseWorkspace() {
    if (this.workspaceReleased) return;
    this.workspaceReleased = true;
    this.workspace?.cleanup();
  }
}
