/**
 * Auto-spawns the Minecraft MCP HTTP server as a child process.
 *
 * The MCP server lives in mcp-servers/minecraft/ and provides the HTTP
 * bridge (POST /tools/call) that MinecraftRuntime talks to.  This module
 * manages the full lifecycle: spawn → health-poll → ready, and clean
 * shutdown on dispose.
 *
 * When MINECRAFT_MCP_URL is set explicitly the bot skips auto-spawn and
 * connects to the external server directly.
 */

import { resolve } from "node:path";

// ── Types ───────────────────────────────────────────────────────────────────

export type MinecraftMcpProcessOptions = {
  /** Port for the HTTP server. Default: 3847 */
  port?: number;
  /** Host to bind. Default: 127.0.0.1 */
  host?: string;
  /** Minecraft server defaults forwarded as MC_* env vars. */
  mcHost?: string;
  mcPort?: number;
  mcUsername?: string;
  mcAuth?: string;
  mcVersion?: string;
  /** Absolute path to the MCP server source root. */
  mcpServerDir?: string;
  /** Log callback for lifecycle events. */
  logAction?: (entry: Record<string, unknown>) => void;
};

type BunProcess = ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>;

const DEFAULT_PORT = 3847;
const DEFAULT_HOST = "127.0.0.1";
const HEALTH_POLL_INTERVAL_MS = 300;
const HEALTH_POLL_TIMEOUT_MS = 15_000;

// ── Process manager ─────────────────────────────────────────────────────────

export class MinecraftMcpProcess {
  private child: BunProcess | null = null;
  private readonly port: number;
  private readonly host: string;
  private readonly mcpServerDir: string;
  private readonly env: Record<string, string>;
  private readonly logAction: (entry: Record<string, unknown>) => void;
  private disposed = false;

  /** The HTTP base URL the runtime should connect to. */
  get baseUrl(): string {
    return `http://${this.host}:${this.port}`;
  }

  constructor(options: MinecraftMcpProcessOptions = {}) {
    this.port = options.port ?? DEFAULT_PORT;
    this.host = options.host ?? DEFAULT_HOST;
    this.logAction = options.logAction ?? (() => {});
    this.mcpServerDir =
      options.mcpServerDir ??
      resolve(import.meta.dir, "..", "..", "..", "mcp-servers", "minecraft");

    // Forward MC_* env vars so the MCP server picks up connection defaults.
    this.env = {
      ...process.env as Record<string, string>,
      MC_HTTP_PORT: String(this.port),
      MC_HTTP_HOST: this.host,
      ...(options.mcHost ? { MC_HOST: options.mcHost } : {}),
      ...(options.mcPort ? { MC_PORT: String(options.mcPort) } : {}),
      ...(options.mcUsername ? { MC_USERNAME: options.mcUsername } : {}),
      ...(options.mcAuth ? { MC_AUTH: options.mcAuth } : {}),
      ...(options.mcVersion ? { MC_VERSION: options.mcVersion } : {})
    };
  }

  /**
   * Spawn the MCP server and wait for it to become healthy.
   * Resolves with the base URL once /health responds.
   */
  async start(): Promise<string> {
    if (this.disposed) throw new Error("MinecraftMcpProcess already disposed");
    if (this.child) return this.baseUrl;

    // Check if something is already listening on the port.
    if (await this.isHealthy()) {
      this.logAction({ kind: "minecraft_mcp_process", content: "reusing_existing_server", metadata: { baseUrl: this.baseUrl } });
      return this.baseUrl;
    }

    const entryPoint = resolve(this.mcpServerDir, "src", "http-server.ts");
    this.logAction({ kind: "minecraft_mcp_process", content: "spawning", metadata: { entryPoint, port: this.port } });

    this.child = Bun.spawn(["bun", "run", entryPoint], {
      cwd: this.mcpServerDir,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: this.env,
      onExit: (_proc, exitCode, signalCode) => {
        this.logAction({
          kind: "minecraft_mcp_process",
          content: "exited",
          metadata: { exitCode, signalCode }
        });
        this.child = null;
      }
    });

    // Drain stdout/stderr in background so the pipes don't block.
    this.drainStream(this.child.stdout, "stdout");
    this.drainStream(this.child.stderr, "stderr");

    // Poll /health until the server is ready.
    await this.waitForHealthy();
    this.logAction({ kind: "minecraft_mcp_process", content: "ready", metadata: { baseUrl: this.baseUrl } });
    return this.baseUrl;
  }

  /** Gracefully stop the MCP server. */
  async stop(): Promise<void> {
    this.disposed = true;
    if (!this.child) return;
    const proc = this.child;
    this.child = null;

    try {
      proc.kill("SIGTERM");
      // Give it a moment to shut down gracefully.
      await Promise.race([
        proc.exited,
        new Promise((r) => setTimeout(r, 3_000))
      ]);
    } catch {
      // Force kill if still alive.
      try { proc.kill("SIGKILL"); } catch { /* already dead */ }
    }
    this.logAction({ kind: "minecraft_mcp_process", content: "stopped" });
  }

  /** Whether the process is currently running. */
  get running(): boolean {
    return this.child != null;
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private async isHealthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(2_000)
      });
      const body = await res.json() as { ok?: boolean };
      return body.ok !== false;
    } catch {
      return false;
    }
  }

  private async waitForHealthy(): Promise<void> {
    const deadline = Date.now() + HEALTH_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.disposed || !this.child) {
        throw new Error("Minecraft MCP server process exited before becoming healthy");
      }
      if (await this.isHealthy()) return;
      await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL_MS));
    }
    throw new Error(`Minecraft MCP server did not become healthy within ${HEALTH_POLL_TIMEOUT_MS}ms`);
  }

  private async drainStream(
    stream: ReadableStream<Uint8Array> | null,
    label: string
  ): Promise<void> {
    if (!stream) return;
    const decoder = new TextDecoder();
    try {
      for await (const chunk of stream) {
        const text = decoder.decode(chunk, { stream: true }).trim();
        if (text) {
          this.logAction({
            kind: "minecraft_mcp_process_output",
            content: text,
            metadata: { stream: label }
          });
        }
      }
    } catch {
      // Stream closed — expected on shutdown.
    }
  }
}

// ── Convenience ─────────────────────────────────────────────────────────────

/**
 * Resolve the MCP server URL, auto-spawning if needed.
 *
 * - If MINECRAFT_MCP_URL is set → use it (external server).
 * - Otherwise → spawn a local MCP server and return its URL.
 *
 * Returns `{ baseUrl, process }` where `process` is null when using an
 * external server.
 */
export async function resolveMinecraftMcpServer(options: {
  explicitUrl?: string | null;
  logAction?: (entry: Record<string, unknown>) => void;
  mcHost?: string;
  mcPort?: number;
  mcUsername?: string;
  mcAuth?: string;
  mcVersion?: string;
}): Promise<{ baseUrl: string; process: MinecraftMcpProcess | null }> {
  if (options.explicitUrl) {
    return { baseUrl: options.explicitUrl.replace(/\/+$/, ""), process: null };
  }

  const proc = new MinecraftMcpProcess({
    logAction: options.logAction,
    mcHost: options.mcHost,
    mcPort: options.mcPort,
    mcUsername: options.mcUsername,
    mcAuth: options.mcAuth,
    mcVersion: options.mcVersion
  });
  const baseUrl = await proc.start();
  return { baseUrl, process: proc };
}
