import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { assertPublicUrl } from "./urlSafety.ts";
import { createAbortError, isAbortError, throwIfAborted } from "../tools/abortError.ts";

const execFileAsync = promisify(execFile);

const DEFAULT_STEP_TIMEOUT_MS = 30_000;
const DEFAULT_SESSION_TIMEOUT_MS = 300_000;
const STALE_CHECK_INTERVAL_MS = 60_000;
const AGENT_BROWSER_SESSION_HASH_LEN = 16;
const AGENT_BROWSER_SESSION_TAIL_LEN = 8;

type BrowserSessionConfig = {
  headed?: boolean;
  sessionTimeoutMs?: number;
  profile?: string;
};

export function buildAgentBrowserSessionName(sessionKey: string): string {
  const normalizedSessionKey = String(sessionKey || "").trim() || "default";
  const digest = createHash("sha256")
    .update(normalizedSessionKey)
    .digest("hex")
    .slice(0, AGENT_BROWSER_SESSION_HASH_LEN);
  const readableTail = normalizedSessionKey
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(-AGENT_BROWSER_SESSION_TAIL_LEN);

  return readableTail ? `ab-${digest}-${readableTail}` : `ab-${digest}`;
}

function expandTilde(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

export function buildAgentBrowserArgs(
  sessionKey: string,
  args: string[],
  options?: Pick<BrowserSessionConfig, "headed" | "profile">
): string[] {
  const profilePath = options?.profile ? expandTilde(options.profile) : undefined;
  return [
    "--session",
    buildAgentBrowserSessionName(sessionKey),
    ...(options?.headed ? ["--headed"] : []),
    ...(profilePath
      ? [
          "--profile", profilePath,
          "--args", "--disable-blink-features=AutomationControlled"
        ]
      : []),
    ...args
  ];
}

interface BrowserSession {
  sessionKey: string;
  createdAt: number;
  lastActiveAt: number;
  headed: boolean;
  sessionTimeoutMs: number;
  profile?: string;
}

export class BrowserManager {
  private sessions: Map<string, BrowserSession> = new Map();
  private readonly maxConcurrentSessions: number;
  private readonly defaultSessionTimeoutMs: number;
  private readonly pendingSessionConfigs = new Map<string, BrowserSessionConfig>();
  private staleTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options?: { maxConcurrentSessions?: number; sessionTimeoutMs?: number }) {
    this.maxConcurrentSessions = options?.maxConcurrentSessions || 2;
    this.defaultSessionTimeoutMs = options?.sessionTimeoutMs || DEFAULT_SESSION_TIMEOUT_MS;

    this.staleTimer = setInterval(() => {
      this.cleanupStaleSessions();
    }, STALE_CHECK_INTERVAL_MS);
  }

  private logCleanupError(context: string, error: unknown): void {
    console.warn(`[BrowserManager] ${context}:`, error);
  }

  private normalizeSessionKey(sessionKey: string): string {
    return String(sessionKey || "").trim();
  }

  private normalizeSessionConfig(options?: BrowserSessionConfig): BrowserSessionConfig {
    const sessionTimeoutMs = Number(options?.sessionTimeoutMs);
    return {
      ...(options?.headed !== undefined ? { headed: Boolean(options.headed) } : {}),
      ...(Number.isFinite(sessionTimeoutMs) && sessionTimeoutMs > 0
        ? { sessionTimeoutMs: sessionTimeoutMs }
        : {}),
      ...(options?.profile !== undefined ? { profile: String(options.profile || "").trim() || undefined } : {})
    };
  }

  private getSessionConfig(sessionKey: string): BrowserSessionConfig {
    const normalizedSessionKey = this.normalizeSessionKey(sessionKey);
    const session = normalizedSessionKey ? this.sessions.get(normalizedSessionKey) : undefined;
    if (session) {
      return {
        headed: session.headed,
        sessionTimeoutMs: session.sessionTimeoutMs,
        profile: session.profile
      };
    }
    return this.pendingSessionConfigs.get(normalizedSessionKey) || {};
  }

  configureSession(sessionKey: string, options?: BrowserSessionConfig): void {
    const normalizedSessionKey = this.normalizeSessionKey(sessionKey);
    if (!normalizedSessionKey) return;

    const normalizedConfig = this.normalizeSessionConfig(options);
    const existingPending = this.pendingSessionConfigs.get(normalizedSessionKey) || {};
    this.pendingSessionConfigs.set(normalizedSessionKey, {
      ...existingPending,
      ...normalizedConfig
    });

    const existingSession = this.sessions.get(normalizedSessionKey);
    if (!existingSession) return;
    if (normalizedConfig.headed !== undefined) {
      existingSession.headed = normalizedConfig.headed;
    }
    if (normalizedConfig.sessionTimeoutMs !== undefined) {
      existingSession.sessionTimeoutMs = normalizedConfig.sessionTimeoutMs;
    }
    if (normalizedConfig.profile !== undefined) {
      existingSession.profile = normalizedConfig.profile;
    }
  }

  private getOrCreateSession(sessionKey: string): BrowserSession {
    const normalizedSessionKey = this.normalizeSessionKey(sessionKey);
    const existing = this.sessions.get(normalizedSessionKey);
    if (existing) {
      existing.lastActiveAt = Date.now();
      return existing;
    }
    if (this.sessions.size >= this.maxConcurrentSessions) {
      throw new Error(`Maximum concurrent browser sessions (${this.maxConcurrentSessions}) exceeded.`);
    }
    const config = this.getSessionConfig(normalizedSessionKey);
    const session: BrowserSession = {
      sessionKey: normalizedSessionKey,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      headed: Boolean(config.headed),
      sessionTimeoutMs:
        Number.isFinite(config.sessionTimeoutMs) && Number(config.sessionTimeoutMs) > 0
          ? Number(config.sessionTimeoutMs)
          : this.defaultSessionTimeoutMs,
      profile: config.profile || undefined
    };
    this.sessions.set(normalizedSessionKey, session);
    return session;
  }

  private touchSession(sessionKey: string): void {
    const session = this.sessions.get(this.normalizeSessionKey(sessionKey));
    if (session) session.lastActiveAt = Date.now();
  }

  private runAgentBrowser(
    sessionKey: string,
    args: string[],
    timeoutMs = DEFAULT_STEP_TIMEOUT_MS,
    signal?: AbortSignal
  ): Promise<{ stdout: string; stderr: string }> {
    throwIfAborted(signal, "Browser command cancelled");
    return execFileAsync("agent-browser", buildAgentBrowserArgs(sessionKey, args, this.getSessionConfig(sessionKey)), { timeout: timeoutMs, signal }).then(
      ({ stdout, stderr }) => ({ stdout: stdout.trim(), stderr: stderr.trim() }),
      (error: unknown) => {
        if (isAbortError(error) || signal?.aborted) {
          throw createAbortError(signal?.reason || error);
        }
        const err = error as { stderr?: string; stdout?: string; message?: string };
        const errMessage = err.stderr || err.stdout || err.message || "Unknown error executing agent-browser";
        throw new Error(`agent-browser error: ${errMessage}`);
      }
    );
  }

  async open(sessionKey: string, url: string, timeoutMs = DEFAULT_STEP_TIMEOUT_MS, signal?: AbortSignal): Promise<string> {
    await assertPublicUrl(url);
    this.getOrCreateSession(sessionKey);
    const { stdout } = await this.runAgentBrowser(sessionKey, ["open", url], timeoutMs, signal);
    return stdout;
  }

  async snapshot(sessionKey: string, interactiveOnly = true, timeoutMs = DEFAULT_STEP_TIMEOUT_MS, signal?: AbortSignal): Promise<string> {
    this.touchSession(sessionKey);
    const args = interactiveOnly ? ["snapshot", "-i"] : ["snapshot"];
    const { stdout } = await this.runAgentBrowser(sessionKey, args, timeoutMs, signal);
    return stdout;
  }

  async click(sessionKey: string, ref: string, timeoutMs = DEFAULT_STEP_TIMEOUT_MS, signal?: AbortSignal): Promise<string> {
    this.touchSession(sessionKey);
    const { stdout } = await this.runAgentBrowser(sessionKey, ["click", ref], timeoutMs, signal);
    return stdout;
  }

  async type(sessionKey: string, ref: string, text: string, pressEnter = true, timeoutMs = DEFAULT_STEP_TIMEOUT_MS, signal?: AbortSignal): Promise<string> {
    this.touchSession(sessionKey);
    const { stdout } = await this.runAgentBrowser(sessionKey, ["type", ref, text], timeoutMs, signal);
    if (pressEnter) {
      await this.runAgentBrowser(sessionKey, ["press", "Enter"], timeoutMs, signal);
    }
    return stdout;
  }

  async scroll(sessionKey: string, direction: "up" | "down", pixels?: number, timeoutMs = DEFAULT_STEP_TIMEOUT_MS, signal?: AbortSignal): Promise<string> {
    this.touchSession(sessionKey);
    const args = pixels ? ["scroll", direction, String(pixels)] : ["scroll", direction];
    const { stdout } = await this.runAgentBrowser(sessionKey, args, timeoutMs, signal);
    return stdout;
  }

  async press(sessionKey: string, key: string, timeoutMs = DEFAULT_STEP_TIMEOUT_MS, signal?: AbortSignal): Promise<string> {
    this.touchSession(sessionKey);
    const { stdout } = await this.runAgentBrowser(sessionKey, ["press", key], timeoutMs, signal);
    return stdout;
  }

  async keyboardType(sessionKey: string, text: string, timeoutMs = DEFAULT_STEP_TIMEOUT_MS, signal?: AbortSignal): Promise<string> {
    this.touchSession(sessionKey);
    const { stdout } = await this.runAgentBrowser(sessionKey, ["keyboard", "type", text], timeoutMs, signal);
    return stdout;
  }

  async mouseMove(sessionKey: string, x: number, y: number, timeoutMs = DEFAULT_STEP_TIMEOUT_MS, signal?: AbortSignal): Promise<string> {
    this.touchSession(sessionKey);
    const { stdout } = await this.runAgentBrowser(
      sessionKey,
      ["mouse", "move", String(Math.round(x)), String(Math.round(y))],
      timeoutMs,
      signal
    );
    return stdout;
  }

  async mouseClick(
    sessionKey: string,
    x: number,
    y: number,
    button: "left" | "middle" | "right" | "wheel" | "back" | "forward" = "left",
    timeoutMs = DEFAULT_STEP_TIMEOUT_MS,
    signal?: AbortSignal
  ): Promise<string> {
    this.touchSession(sessionKey);
    await this.mouseMove(sessionKey, x, y, timeoutMs, signal);
    await this.runAgentBrowser(sessionKey, ["mouse", "down", button], timeoutMs, signal);
    const { stdout } = await this.runAgentBrowser(sessionKey, ["mouse", "up", button], timeoutMs, signal);
    return stdout;
  }

  async mouseDoubleClick(
    sessionKey: string,
    x: number,
    y: number,
    button: "left" | "middle" | "right" | "wheel" | "back" | "forward" = "left",
    timeoutMs = DEFAULT_STEP_TIMEOUT_MS,
    signal?: AbortSignal
  ): Promise<string> {
    this.touchSession(sessionKey);
    await this.mouseClick(sessionKey, x, y, button, timeoutMs, signal);
    return await this.mouseClick(sessionKey, x, y, button, timeoutMs, signal);
  }

  async mouseDrag(
    sessionKey: string,
    path: Array<{ x: number; y: number }>,
    timeoutMs = DEFAULT_STEP_TIMEOUT_MS,
    signal?: AbortSignal
  ): Promise<string> {
    this.touchSession(sessionKey);
    const points = Array.isArray(path)
      ? path.filter((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y))
      : [];
    if (points.length < 2) {
      throw new Error("mouse_drag_requires_path");
    }

    await this.mouseMove(sessionKey, points[0]!.x, points[0]!.y, timeoutMs, signal);
    await this.runAgentBrowser(sessionKey, ["mouse", "down", "left"], timeoutMs, signal);

    let stdout = "";
    for (const point of points.slice(1)) {
      const result = await this.runAgentBrowser(
        sessionKey,
        ["mouse", "move", String(Math.round(point.x)), String(Math.round(point.y))],
        timeoutMs,
        signal
      );
      stdout = result.stdout;
    }

    const release = await this.runAgentBrowser(sessionKey, ["mouse", "up", "left"], timeoutMs, signal);
    return release.stdout || stdout;
  }

  async mouseWheel(
    sessionKey: string,
    deltaY: number,
    deltaX = 0,
    timeoutMs = DEFAULT_STEP_TIMEOUT_MS,
    signal?: AbortSignal
  ): Promise<string> {
    this.touchSession(sessionKey);
    const args = ["mouse", "wheel", String(Math.round(deltaY))];
    if (deltaX) {
      args.push(String(Math.round(deltaX)));
    }
    const { stdout } = await this.runAgentBrowser(sessionKey, args, timeoutMs, signal);
    return stdout;
  }

  async wait(sessionKey: string, timeoutMs = DEFAULT_STEP_TIMEOUT_MS, signal?: AbortSignal): Promise<string> {
    this.touchSession(sessionKey);
    const { stdout } = await this.runAgentBrowser(sessionKey, ["wait", String(Math.max(1, Math.round(timeoutMs)))], timeoutMs, signal);
    return stdout;
  }

  async extract(sessionKey: string, ref?: string, timeoutMs = DEFAULT_STEP_TIMEOUT_MS, signal?: AbortSignal): Promise<string> {
    this.touchSession(sessionKey);
    if (ref) {
      const { stdout } = await this.runAgentBrowser(sessionKey, ["extract", ref], timeoutMs, signal);
      return stdout;
    }
    return await this.snapshot(sessionKey, false, timeoutMs, signal);
  }

  async screenshot(sessionKey: string, timeoutMs = DEFAULT_STEP_TIMEOUT_MS, signal?: AbortSignal): Promise<string> {
    this.touchSession(sessionKey);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-browser-"));
    const screenshotPath = path.join(tempDir, "screenshot.png");
    try {
      await this.runAgentBrowser(sessionKey, ["screenshot", screenshotPath], timeoutMs, signal);
      const png = await readFile(screenshotPath);
      return `data:image/png;base64,${png.toString("base64")}`;
    } finally {
      try {
        await rm(tempDir, { recursive: true, force: true });
      } catch (error) {
        this.logCleanupError(`failed to remove screenshot temp dir ${tempDir}`, error);
      }
    }
  }

  async currentUrl(sessionKey: string, timeoutMs = DEFAULT_STEP_TIMEOUT_MS, signal?: AbortSignal): Promise<string> {
    this.touchSession(sessionKey);
    const { stdout } = await this.runAgentBrowser(sessionKey, ["get", "url"], timeoutMs, signal);
    return stdout;
  }

  async close(sessionKey: string): Promise<void> {
    const normalizedSessionKey = this.normalizeSessionKey(sessionKey);
    try {
      await this.runAgentBrowser(normalizedSessionKey, ["close"]);
    } catch {
      // ignore close errors
    } finally {
      this.sessions.delete(normalizedSessionKey);
      this.pendingSessionConfigs.delete(normalizedSessionKey);
    }
  }

  async closeAll(): Promise<void> {
    const keys = [...this.sessions.keys()];
    for (const key of keys) {
      await this.close(key);
    }
    if (this.staleTimer) {
      clearInterval(this.staleTimer);
      this.staleTimer = null;
    }
    this.pendingSessionConfigs.clear();
  }

  private cleanupStaleSessions(): void {
    const now = Date.now();
    for (const [key, session] of this.sessions) {
      if (now - session.lastActiveAt > session.sessionTimeoutMs) {
        void this.close(key);
      }
    }
  }
}
