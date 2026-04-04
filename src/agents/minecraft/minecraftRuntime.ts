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

export type McpHazardEntry = {
  type: string;
  distance: number;
  position: McpPosition;
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
  hazards?: McpHazardEntry[];
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

function buildTimeoutSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

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
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal?: AbortSignal
  ): Promise<McpToolResult<T>> {
    const url = `${this.baseUrl}/tools/call`;
    this.logAction({ kind: "minecraft_runtime_call", content: toolName, metadata: { args, url } });

    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ toolName, arguments: args }),
      signal: buildTimeoutSignal(timeoutMs, signal)
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
      signal: buildTimeoutSignal(HEALTH_TIMEOUT_MS)
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

  async connect(options: MinecraftConnectOptions = {}, signal?: AbortSignal): Promise<McpToolResult<McpStatusSnapshot>> {
    return this.callTool<McpStatusSnapshot>("minecraft_connect", options as Record<string, unknown>, DEFAULT_TIMEOUT_MS, signal);
  }

  async disconnect(reason = "session ended", signal?: AbortSignal): Promise<McpToolResult<McpStatusSnapshot>> {
    return this.callTool<McpStatusSnapshot>("minecraft_disconnect", { reason }, DEFAULT_TIMEOUT_MS, signal);
  }

  async status(signal?: AbortSignal): Promise<McpToolResult<McpStatusSnapshot>> {
    return this.callTool<McpStatusSnapshot>("minecraft_status", {}, DEFAULT_TIMEOUT_MS, signal);
  }

  async chat(message: string, signal?: AbortSignal): Promise<McpToolResult<{ ok: true; message: string }>> {
    return this.callTool("minecraft_chat", { message }, DEFAULT_TIMEOUT_MS, signal);
  }

  async followPlayer(
    playerName: string,
    distance = 3,
    signal?: AbortSignal
  ): Promise<McpToolResult<{ ok: true; playerName: string; distance: number }>> {
    return this.callTool("minecraft_follow_player", { playerName, distance }, DEFAULT_TIMEOUT_MS, signal);
  }

  async guardPlayer(
    playerName: string,
    radius = 8,
    followDistance = 4,
    signal?: AbortSignal
  ): Promise<McpToolResult<{ ok: true; playerName: string; radius: number; followDistance: number }>> {
    return this.callTool("minecraft_guard_player", { playerName, radius, followDistance }, DEFAULT_TIMEOUT_MS, signal);
  }

  async goTo(
    x: number,
    y: number,
    z: number,
    range = 1,
    signal?: AbortSignal
  ): Promise<McpToolResult<{ ok: true; target: McpPosition; range: number }>> {
    return this.callTool("minecraft_go_to", { x, y, z, range }, DEFAULT_TIMEOUT_MS, signal);
  }

  async collectBlock(
    blockName: string,
    count = 1,
    maxDistance = 32,
    signal?: AbortSignal
  ): Promise<McpToolResult<{
    ok: true;
    blockName: string;
    requested: number;
    attempted: number;
    inventoryBefore: number;
    inventoryAfter: number;
  }>> {
    return this.callTool("minecraft_collect_block", { blockName, count, maxDistance }, DEFAULT_TIMEOUT_MS, signal);
  }

  async attackNearestHostile(
    maxDistance = 8,
    signal?: AbortSignal
  ): Promise<McpToolResult<{ ok: true; target: string }>> {
    return this.callTool("minecraft_attack_nearest_hostile", { maxDistance }, DEFAULT_TIMEOUT_MS, signal);
  }

  async lookAtPlayer(playerName: string, signal?: AbortSignal): Promise<McpToolResult<{ ok: true; playerName: string }>> {
    return this.callTool("minecraft_look_at_player", { playerName }, DEFAULT_TIMEOUT_MS, signal);
  }

  async stop(signal?: AbortSignal): Promise<McpToolResult<{ ok: true }>> {
    return this.callTool("minecraft_stop", {}, DEFAULT_TIMEOUT_MS, signal);
  }

  async listPlayers(signal?: AbortSignal): Promise<McpToolResult<McpPlayerEntry[]>> {
    return this.callTool<McpPlayerEntry[]>("minecraft_list_players", {}, DEFAULT_TIMEOUT_MS, signal);
  }

  async inventory(signal?: AbortSignal): Promise<McpToolResult<McpInventoryEntry[]>> {
    return this.callTool<McpInventoryEntry[]>("minecraft_inventory", {}, DEFAULT_TIMEOUT_MS, signal);
  }

  async recentEvents(limit = 20, signal?: AbortSignal): Promise<McpToolResult<string[]>> {
    return this.callTool<string[]>("minecraft_recent_events", { limit }, DEFAULT_TIMEOUT_MS, signal);
  }
}
