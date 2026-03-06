import { spawn } from "node:child_process";
import readline from "node:readline";
import { nowIso } from "../utils.ts";

const CLOUDFLARED_PUBLIC_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i;
const CLOUDFLARED_READY_RE = /\b(registered tunnel connection|connection established)\b/i;
const CLOUDFLARED_RETRY_DELAY_MS = 5_000;
const CLOUDFLARED_DEFAULT_BIN = "cloudflared";
const CLOUDFLARED_PROVIDER = "cloudflared";

export function extractCloudflaredPublicUrl(line) {
  const text = String(line || "");
  const match = text.match(CLOUDFLARED_PUBLIC_URL_RE);
  return match ? String(match[0]) : "";
}

export function resolvePublicHttpsTargetUrl(rawTargetUrl, dashboardPort) {
  const fallbackPort = Number.isFinite(Number(dashboardPort)) ? Number(dashboardPort) : 8787;
  const fallbackUrl = `http://127.0.0.1:${fallbackPort}`;
  const normalizedRaw = String(rawTargetUrl || "").trim();
  if (!normalizedRaw) return fallbackUrl;

  try {
    const parsed = new URL(normalizedRaw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return fallbackUrl;
    parsed.hash = "";
    parsed.search = "";
    const normalized = parsed.toString().replace(/\/$/, "");
    return normalized || fallbackUrl;
  } catch {
    return fallbackUrl;
  }
}

export class PublicHttpsEntrypoint {
  appConfig;
  store;
  child;
  stdoutReader;
  stderrReader;
  isStopping;
  preventAutoRetry;
  retryTimer;
  state;

  constructor({ appConfig, store }) {
    this.appConfig = appConfig || {};
    this.store = store;
    this.child = null;
    this.stdoutReader = null;
    this.stderrReader = null;
    this.isStopping = false;
    this.preventAutoRetry = false;
    this.retryTimer = null;
    this.state = {
      enabled: Boolean(this.appConfig?.publicHttpsEnabled),
      provider: CLOUDFLARED_PROVIDER,
      status: this.appConfig?.publicHttpsEnabled ? "idle" : "disabled",
      targetUrl: resolvePublicHttpsTargetUrl(
        this.appConfig?.publicHttpsTargetUrl,
        this.appConfig?.dashboardPort
      ),
      publicUrl: "",
      pid: null,
      startedAt: null,
      lastError: ""
    };
  }

  getState() {
    return { ...this.state };
  }

  async start() {
    if (!this.state.enabled) {
      this.state.status = "disabled";
      return this.getState();
    }
    if (this.child) return this.getState();

    this.isStopping = false;
    this.preventAutoRetry = false;
    this.startCloudflared();
    return this.getState();
  }

  async stop() {
    this.isStopping = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }

    const child = this.child;
    if (!child) {
      this.state.status = this.state.enabled ? "stopped" : "disabled";
      this.state.pid = null;
      return this.getState();
    }

    await new Promise<void>((resolve) => {
      let forceKillTimer = null;
      const done = () => {
        if (forceKillTimer) {
          clearTimeout(forceKillTimer);
          forceKillTimer = null;
        }
        this.cleanupChildHandles();
        resolve();
      };
      child.once("close", done);
      try {
        child.kill("SIGTERM");
      } catch {
        done();
      }
      forceKillTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill("SIGKILL");
          } catch {
            // ignore
          }
        }
      }, 3_000);
    });

    this.state.status = this.state.enabled ? "stopped" : "disabled";
    this.state.pid = null;
    this.state.startedAt = null;
    return this.getState();
  }

  startCloudflared() {
    const binary = String(this.appConfig?.publicHttpsCloudflaredBin || CLOUDFLARED_DEFAULT_BIN).trim() || CLOUDFLARED_DEFAULT_BIN;
    const args = ["tunnel", "--url", this.state.targetUrl, "--no-autoupdate"];

    this.state.status = "starting";
    this.state.lastError = "";
    this.state.publicUrl = "";
    this.state.startedAt = null;

    this.logAction({
      kind: "bot_runtime",
      content: "public_https_entrypoint_starting",
      metadata: {
        provider: this.state.provider,
        targetUrl: this.state.targetUrl,
        binary
      }
    });

    const child = spawn(binary, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    this.child = child;
    this.state.pid = child.pid || null;

    this.stdoutReader = readline.createInterface({ input: child.stdout });
    this.stderrReader = readline.createInterface({ input: child.stderr });
    this.stdoutReader.on("line", (line) => this.handleCloudflaredLine(line, "stdout"));
    this.stderrReader.on("line", (line) => this.handleCloudflaredLine(line, "stderr"));

    child.on("error", (error: NodeJS.ErrnoException) => {
      const message = String(error?.message || error || "unknown");
      if (String(error?.code || "").trim().toUpperCase() === "ENOENT") {
        this.preventAutoRetry = true;
      }
      this.state.status = "error";
      this.state.lastError = message;
      this.logAction({
        kind: "bot_error",
        content: `public_https_entrypoint_spawn_failed: ${message}`,
        metadata: {
          provider: this.state.provider,
          targetUrl: this.state.targetUrl,
          binary
        }
      });
    });

    child.on("close", (code, signal) => {
      const stoppedByOperator = this.isStopping;
      const retryBlocked = this.preventAutoRetry;
      this.cleanupChildHandles();
      if (stoppedByOperator) return;

      this.state.status = "error";
      this.state.startedAt = null;
      this.state.lastError = `cloudflared_exited: code=${code ?? "null"} signal=${signal || "null"}`;
      this.logAction({
        kind: "bot_error",
        content: "public_https_entrypoint_exited",
        metadata: {
          provider: this.state.provider,
          targetUrl: this.state.targetUrl,
          code: code ?? null,
          signal: signal || null,
          retryMs: CLOUDFLARED_RETRY_DELAY_MS
        }
      });

      if (retryBlocked) return;

      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        if (!this.state.enabled || this.isStopping) return;
        this.startCloudflared();
      }, CLOUDFLARED_RETRY_DELAY_MS);
    });
  }

  cleanupChildHandles() {
    if (this.stdoutReader) {
      this.stdoutReader.removeAllListeners();
      this.stdoutReader.close();
      this.stdoutReader = null;
    }
    if (this.stderrReader) {
      this.stderrReader.removeAllListeners();
      this.stderrReader.close();
      this.stderrReader = null;
    }
    this.child = null;
    this.state.pid = null;
  }

  handleCloudflaredLine(rawLine, streamName = "stdout") {
    const line = String(rawLine || "").trim();
    if (!line) return;

    const publicUrl = extractCloudflaredPublicUrl(line);
    if (publicUrl && publicUrl !== this.state.publicUrl) {
      this.state.publicUrl = publicUrl;
      this.state.status = "ready";
      this.state.startedAt = nowIso();
      this.state.lastError = "";
      this.logAction({
        kind: "bot_runtime",
        content: "public_https_entrypoint_ready",
        metadata: {
          provider: this.state.provider,
          targetUrl: this.state.targetUrl,
          publicUrl: this.state.publicUrl
        }
      });
      return;
    }

    if (CLOUDFLARED_READY_RE.test(line) && !this.state.publicUrl) {
      this.state.status = "starting";
      return;
    }

    if (/\b(error|failed)\b/i.test(line)) {
      this.state.lastError = line.slice(0, 300);
      this.state.status = "error";
      this.logAction({
        kind: "bot_error",
        content: `public_https_entrypoint_log_${streamName}`,
        metadata: {
          provider: this.state.provider,
          line: this.state.lastError
        }
      });
    }
  }

  logAction(action) {
    if (!this.store?.logAction || !action) return;
    this.store.logAction({
      kind: String(action.kind || "bot_runtime"),
      content: String(action.content || "").slice(0, 400),
      metadata: action.metadata && typeof action.metadata === "object" ? action.metadata : undefined
    });
  }
}
