import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { assertPublicUrl } from "../urlSafety.ts";
import { createAbortError, isAbortError, throwIfAborted } from "../tools/browserTaskRuntime.ts";

const execFileAsync = promisify(execFile);

const DEFAULT_STEP_TIMEOUT_MS = 30_000;
const DEFAULT_SESSION_TIMEOUT_MS = 300_000;
const STALE_CHECK_INTERVAL_MS = 60_000;

export function buildAgentBrowserArgs(sessionKey: string, args: string[]): string[] {
  return ["--session", sessionKey, ...args];
}

interface BrowserSession {
  sessionKey: string;
  createdAt: number;
  lastActiveAt: number;
}

export class BrowserManager {
  private sessions: Map<string, BrowserSession> = new Map();
  private readonly maxConcurrentSessions: number;
  private readonly sessionTimeoutMs: number;
  private staleTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options?: { maxConcurrentSessions?: number; sessionTimeoutMs?: number }) {
    this.maxConcurrentSessions = options?.maxConcurrentSessions || 2;
    this.sessionTimeoutMs = options?.sessionTimeoutMs || DEFAULT_SESSION_TIMEOUT_MS;

    this.staleTimer = setInterval(() => {
      this.cleanupStaleSessions();
    }, STALE_CHECK_INTERVAL_MS);
  }

  private getOrCreateSession(sessionKey: string): BrowserSession {
    const existing = this.sessions.get(sessionKey);
    if (existing) {
      existing.lastActiveAt = Date.now();
      return existing;
    }
    if (this.sessions.size >= this.maxConcurrentSessions) {
      throw new Error(`Maximum concurrent browser sessions (${this.maxConcurrentSessions}) exceeded.`);
    }
    const session: BrowserSession = {
      sessionKey,
      createdAt: Date.now(),
      lastActiveAt: Date.now()
    };
    this.sessions.set(sessionKey, session);
    return session;
  }

  private touchSession(sessionKey: string): void {
    const session = this.sessions.get(sessionKey);
    if (session) session.lastActiveAt = Date.now();
  }

  private runAgentBrowser(
    sessionKey: string,
    args: string[],
    timeoutMs = DEFAULT_STEP_TIMEOUT_MS,
    signal?: AbortSignal
  ): Promise<{ stdout: string; stderr: string }> {
    throwIfAborted(signal, "Browser command cancelled");
    return execFileAsync("agent-browser", buildAgentBrowserArgs(sessionKey, args), { timeout: timeoutMs, signal }).then(
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
    button: "left" | "middle" | "right" = "left",
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
    button: "left" | "middle" | "right" = "left",
    timeoutMs = DEFAULT_STEP_TIMEOUT_MS,
    signal?: AbortSignal
  ): Promise<string> {
    this.touchSession(sessionKey);
    await this.mouseClick(sessionKey, x, y, button, timeoutMs, signal);
    return await this.mouseClick(sessionKey, x, y, button, timeoutMs, signal);
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
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async currentUrl(sessionKey: string, timeoutMs = DEFAULT_STEP_TIMEOUT_MS, signal?: AbortSignal): Promise<string> {
    this.touchSession(sessionKey);
    const { stdout } = await this.runAgentBrowser(sessionKey, ["get", "url"], timeoutMs, signal);
    return stdout;
  }

  async close(sessionKey: string): Promise<void> {
    try {
      await this.runAgentBrowser(sessionKey, ["close"]);
    } catch {
      // ignore close errors
    } finally {
      this.sessions.delete(sessionKey);
    }
  }

  async closeAll(): Promise<void> {
    const keys = [...this.sessions.keys()];
    for (const key of keys) {
      await this.close(key).catch(() => undefined);
    }
    if (this.staleTimer) {
      clearInterval(this.staleTimer);
      this.staleTimer = null;
    }
  }

  private cleanupStaleSessions(): void {
    const now = Date.now();
    for (const [key, session] of this.sessions) {
      if (now - session.lastActiveAt > this.sessionTimeoutMs) {
        this.close(key).catch(() => undefined);
      }
    }
  }
}
