/**
 * HTTP client for the Minecraft MCP server.
 *
 * All bot control flows through this runtime — it issues tool calls to the
 * MCP HTTP server (mcp-servers/minecraft/http-server.ts) and returns typed
 * results.  The runtime is stateless; the MCP server owns the actual bot
 * lifecycle and world state.
 */

// ── MCP server response types ───────────────────────────────────────────────

export type McpToolResult<T = unknown> = {
  ok: boolean;
  output: T;
  error?: string | null;
};

export type McpPosition = { x: number; y: number; z: number };

export type McpPlayerEntry = {
  username: string;
  online: boolean;
  distance?: number;
  position?: McpPosition;
};

export type McpInventoryEntry = {
  name: string;
  displayName?: string;
  count: number;
};

export type McpFollowState = {
  playerName: string;
  distance: number;
};

export type McpGuardState = {
  playerName: string;
  radius: number;
  followDistance: number;
};

export type McpStatusSnapshot = {
  connected: boolean;
  username?: string;
  version?: string;
  health?: number;
  food?: number;
  gameMode?: string;
  dimension?: string;
  timeOfDay?: number;
  position?: McpPosition;
  players?: McpPlayerEntry[];
  inventory?: McpInventoryEntry[];
  task: string;
  follow?: McpFollowState | null;
  guard?: McpGuardState | null;
  recentEvents: string[];
};

export type McpHealthResponse = {
  ok: boolean;
  connected: boolean;
  task: string;
};

// ── Connection options ──────────────────────────────────────────────────────

export type MinecraftConnectOptions = {
  host?: string;
  port?: number;
  username?: string;
  auth?: string;
  version?: string;
  profilesFolder?: string;
  connectTimeoutMs?: number;
};

// ── Runtime ─────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 35_000;
const HEALTH_TIMEOUT_MS = 5_000;

type LogAction = (entry: Record<string, unknown>) => void;

export class MinecraftRuntime {
  readonly baseUrl: string;
  private readonly logAction: LogAction;

  constructor(baseUrl: string, logAction?: LogAction) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.logAction = logAction ?? (() => {});
  }

  // ── Generic tool dispatch ───────────────────────────────────────────────

  async callTool<T = unknown>(
    toolName: string,
    args: Record<string, unknown> = {},
    timeoutMs = DEFAULT_TIMEOUT_MS
  ): Promise<McpToolResult<T>> {
    const url = `${this.baseUrl}/tools/call`;
    this.logAction({ kind: "minecraft_runtime_call", content: toolName, metadata: { args, url } });

    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ toolName, arguments: args }),
      signal: AbortSignal.timeout(timeoutMs)
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Minecraft MCP server returned HTTP ${response.status}: ${body}`);
    }

    const result = (await response.json()) as McpToolResult<T>;
    if (!result.ok && result.error) {
      this.logAction({ kind: "minecraft_runtime_tool_error", content: result.error, metadata: { toolName } });
    }
    return result;
  }

  // ── Health check ────────────────────────────────────────────────────────

  async health(): Promise<McpHealthResponse> {
    const response = await fetch(`${this.baseUrl}/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS)
    });
    return (await response.json()) as McpHealthResponse;
  }

  async isReachable(): Promise<boolean> {
    try {
      const h = await this.health();
      return h.ok !== false;
    } catch {
      return false;
    }
  }

  // ── Typed convenience methods ───────────────────────────────────────────

  async connect(options: MinecraftConnectOptions = {}): Promise<McpToolResult<McpStatusSnapshot>> {
    return this.callTool<McpStatusSnapshot>("minecraft_connect", options as Record<string, unknown>);
  }

  async disconnect(reason = "session ended"): Promise<McpToolResult<McpStatusSnapshot>> {
    return this.callTool<McpStatusSnapshot>("minecraft_disconnect", { reason });
  }

  async status(): Promise<McpToolResult<McpStatusSnapshot>> {
    return this.callTool<McpStatusSnapshot>("minecraft_status");
  }

  async chat(message: string): Promise<McpToolResult<{ ok: true; message: string }>> {
    return this.callTool("minecraft_chat", { message });
  }

  async followPlayer(
    playerName: string,
    distance = 3
  ): Promise<McpToolResult<{ ok: true; playerName: string; distance: number }>> {
    return this.callTool("minecraft_follow_player", { playerName, distance });
  }

  async guardPlayer(
    playerName: string,
    radius = 8,
    followDistance = 4
  ): Promise<McpToolResult<{ ok: true; playerName: string; radius: number; followDistance: number }>> {
    return this.callTool("minecraft_guard_player", { playerName, radius, followDistance });
  }

  async goTo(
    x: number,
    y: number,
    z: number,
    range = 1
  ): Promise<McpToolResult<{ ok: true; target: McpPosition; range: number }>> {
    return this.callTool("minecraft_go_to", { x, y, z, range });
  }

  async collectBlock(
    blockName: string,
    count = 1,
    maxDistance = 32
  ): Promise<McpToolResult<{
    ok: true;
    blockName: string;
    requested: number;
    attempted: number;
    inventoryBefore: number;
    inventoryAfter: number;
  }>> {
    return this.callTool("minecraft_collect_block", { blockName, count, maxDistance });
  }

  async attackNearestHostile(
    maxDistance = 8
  ): Promise<McpToolResult<{ ok: true; target: string }>> {
    return this.callTool("minecraft_attack_nearest_hostile", { maxDistance });
  }

  async lookAtPlayer(playerName: string): Promise<McpToolResult<{ ok: true; playerName: string }>> {
    return this.callTool("minecraft_look_at_player", { playerName });
  }

  async stop(): Promise<McpToolResult<{ ok: true }>> {
    return this.callTool("minecraft_stop");
  }

  async listPlayers(): Promise<McpToolResult<McpPlayerEntry[]>> {
    return this.callTool<McpPlayerEntry[]>("minecraft_list_players");
  }

  async inventory(): Promise<McpToolResult<McpInventoryEntry[]>> {
    return this.callTool<McpInventoryEntry[]>("minecraft_inventory");
  }

  async recentEvents(limit = 20): Promise<McpToolResult<string[]>> {
    return this.callTool<string[]>("minecraft_recent_events", { limit });
  }
}
