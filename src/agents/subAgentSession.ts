import type { ImageInput } from "../llm/serviceShared.ts";

/**
 * Unified SubAgentSession framework
 *
 * Provides a common interface for interactive, multi-turn sub-agent sessions
 * (code agent, browser agent, future agents). The brain's tool loop sends a
 * first turn, gets a result, and can optionally continue the conversation by
 * passing follow-up messages using the same session_id.
 *
 * Sessions are kept alive with idle timeouts — the brain (LLM) decides when to
 * continue vs accept the result, no explicit `needs_input` signal is required
 * from sub-agents.
 */

export interface SubAgentTurnResult {
  text: string;
  costUsd: number;
  imageInputs?: ImageInput[];
  isError: boolean;
  errorMessage: string;
  /** True when the sub-agent intentionally ended the session during this turn. */
  sessionCompleted?: boolean;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheWriteTokens: number;
    cacheReadTokens: number;
  };
}

export interface SubAgentProgressEvent {
  kind: "tool_use" | "file_edit" | "assistant_message" | "turn_complete" | "error";
  summary: string;
  turnNumber?: number;
  elapsedMs: number;
  timestamp: number;
  filePath?: string;
}

export interface SubAgentRunTurnOptions {
  signal?: AbortSignal;
  onProgress?: (event: SubAgentProgressEvent) => void;
}

export interface SubAgentSession {
  readonly id: string;
  readonly type: "code" | "browser";
  readonly createdAt: number;
  /** The userId that created this session (for authorization checks). */
  readonly ownerUserId: string | null;
  lastUsedAt: number;
  status: "idle" | "running" | "completed" | "error" | "cancelled";
  getBrowserSessionKey?(): string | null;

  /** Send a turn (initial instruction or follow-up) and get the result. */
  runTurn(input: string, options?: SubAgentRunTurnOptions): Promise<SubAgentTurnResult>;

  /** Cancel any in-flight work and reject future turns. */
  cancel(reason?: string): void;

  /** Close the session and free resources. */
  close(): void;
}

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_MAX_SESSIONS = 20;
const SWEEP_INTERVAL_MS = 60_000; // 1 minute

export class SubAgentSessionManager {
  private readonly sessions = new Map<string, SubAgentSession>();
  private readonly idleTimeoutMs: number;
  private readonly maxSessions: number;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor({
    idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
    maxSessions = DEFAULT_MAX_SESSIONS
  } = {}) {
    this.idleTimeoutMs = Math.max(10_000, idleTimeoutMs);
    this.maxSessions = Math.max(1, maxSessions);
  }

  /** Start periodic cleanup of idle sessions. */
  startSweep() {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweepIdle(), SWEEP_INTERVAL_MS);
    if (this.sweepTimer.unref) this.sweepTimer.unref();
  }

  /** Stop periodic cleanup. */
  stopSweep() {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /** Register a new session. Evicts the oldest idle session if at capacity. */
  register(session: SubAgentSession): void {
    // If a session with this ID already exists, close the old one
    const existing = this.sessions.get(session.id);
    if (existing) {
      existing.close();
    }

    // Evict oldest idle session if at capacity
    if (this.sessions.size >= this.maxSessions) {
      this.evictOldest();
    }

    this.sessions.set(session.id, session);
  }

  /** Get a session by ID. Returns undefined if expired or not found. */
  get(sessionId: string): SubAgentSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;

    // Check idle timeout
    if (Date.now() - session.lastUsedAt > this.idleTimeoutMs) {
      session.close();
      this.sessions.delete(sessionId);
      return undefined;
    }

    return session;
  }

  /** Check if a session exists and is alive. */
  has(sessionId: string): boolean {
    return this.get(sessionId) !== undefined;
  }

  /** Close and remove a specific session. */
  remove(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.close();
    this.sessions.delete(sessionId);
    return true;
  }

  /** Cancel a specific session without evicting unrelated sessions. */
  cancel(sessionId: string, reason?: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.cancel(reason);
    return true;
  }

  /** Close all sessions and stop the sweep timer. */
  closeAll(): void {
    for (const session of this.sessions.values()) {
      session.close();
    }
    this.sessions.clear();
    this.stopSweep();
  }

  /** Number of active sessions. */
  get size(): number {
    return this.sessions.size;
  }

  /** List active session IDs and types. */
  list(): Array<{ id: string; type: string; status: string; lastUsedAt: number }> {
    const result: Array<{ id: string; type: string; status: string; lastUsedAt: number }> = [];
    for (const session of this.sessions.values()) {
      result.push({
        id: session.id,
        type: session.type,
        status: session.status,
        lastUsedAt: session.lastUsedAt
      });
    }
    return result;
  }

  /** Remove idle sessions that have exceeded the timeout. */
  private sweepIdle(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastUsedAt > this.idleTimeoutMs) {
        session.close();
        this.sessions.delete(id);
      }
    }
  }

  /** Evict the oldest idle session. If all are running, evict the oldest overall. */
  private evictOldest(): void {
    let oldestIdle: SubAgentSession | null = null;
    let oldestOverall: SubAgentSession | null = null;

    for (const session of this.sessions.values()) {
      if (session.status !== "running") {
        if (!oldestIdle || session.lastUsedAt < oldestIdle.lastUsedAt) {
          oldestIdle = session;
        }
      }
      if (!oldestOverall || session.lastUsedAt < oldestOverall.lastUsedAt) {
        oldestOverall = session;
      }
    }

    const toEvict = oldestIdle || oldestOverall;
    if (toEvict) {
      toEvict.close();
      this.sessions.delete(toEvict.id);
    }
  }
}

/**
 * Generate a session ID from a scope key and optional suffix.
 * Format: `{type}:{scopeKey}:{timestamp}:{counter}`
 */
let sessionCounter = 0;

export function generateSessionId(type: string, scopeKey: string): string {
  sessionCounter += 1;
  return `${type}:${scopeKey}:${Date.now()}:${sessionCounter}`;
}
