/**
 * Shared tool definitions and dispatch logic.
 * Used by both the stdio MCP server (index.ts) and the HTTP server (http-server.ts).
 */

import { MinecraftBotController } from "./minecraftBot.js";

type JsonSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
};

type ArgumentsRecord = Record<string, unknown>;

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "minecraft_connect",
    description:
      "Connect a Mineflayer bot to a Minecraft Java server. Prefer local/private servers first. Use this before other minecraft_* tools.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        host: { type: "string", description: "Minecraft host or IP. Defaults to MC_HOST or 127.0.0.1." },
        port: { type: "number", description: "Minecraft port. Defaults to MC_PORT or 25565." },
        username: { type: "string", description: "Bot username or Microsoft account identifier." },
        auth: {
          type: "string",
          description: "Authentication mode. Usually 'offline' for local servers or 'microsoft' for online auth."
        },
        version: { type: "string", description: "Optional explicit Minecraft protocol version." },
        profilesFolder: { type: "string", description: "Optional auth profile/token cache directory." },
        connectTimeoutMs: { type: "number", description: "Optional connection timeout in milliseconds." }
      }
    }
  },
  {
    name: "minecraft_disconnect",
    description: "Disconnect the bot cleanly from the current server.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        reason: { type: "string", description: "Optional quit reason." }
      }
    }
  },
  {
    name: "minecraft_status",
    description:
      "Get the bot's current world state snapshot: health, food, position, visible players, inventory, and current task.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {}
    }
  },
  {
    name: "minecraft_chat",
    description: "Send a plain chat message into the current Minecraft server.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["message"],
      properties: {
        message: { type: "string", description: "The chat message to send." }
      }
    }
  },
  {
    name: "minecraft_list_players",
    description: "List currently known players and their approximate distance from the bot.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {}
    }
  },
  {
    name: "minecraft_follow_player",
    description:
      "Start following a visible player. This is a durable behavior and stays active until minecraft_stop or another movement mode replaces it.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["playerName"],
      properties: {
        playerName: { type: "string", description: "Minecraft username to follow." },
        distance: { type: "number", description: "Desired follow distance. Default: 3." }
      }
    }
  },
  {
    name: "minecraft_guard_player",
    description:
      "Guard a visible player. The bot follows them and attacks nearby hostile mobs within the configured radius until minecraft_stop.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["playerName"],
      properties: {
        playerName: { type: "string", description: "Minecraft username to guard." },
        radius: { type: "number", description: "Hostile detection radius around the player. Default: 8." },
        followDistance: { type: "number", description: "How closely to shadow the guarded player. Default: 4." }
      }
    }
  },
  {
    name: "minecraft_go_to",
    description: "Pathfind to a target coordinate using mineflayer-pathfinder.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["x", "y", "z"],
      properties: {
        x: { type: "number", description: "Target x coordinate." },
        y: { type: "number", description: "Target y coordinate." },
        z: { type: "number", description: "Target z coordinate." },
        range: { type: "number", description: "How close is close enough. Default: 1." }
      }
    }
  },
  {
    name: "minecraft_look_at_player",
    description: "Turn to face a visible player immediately.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["playerName"],
      properties: {
        playerName: { type: "string", description: "Minecraft username to look at." }
      }
    }
  },
  {
    name: "minecraft_collect_block",
    description:
      "Collect one or more nearby blocks by canonical Minecraft block id, like oak_log, cobblestone, or coal_ore.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["blockName"],
      properties: {
        blockName: { type: "string", description: "Canonical Minecraft block id." },
        count: { type: "number", description: "Number of blocks to attempt. Default: 1." },
        maxDistance: { type: "number", description: "Search radius in blocks. Default: 32." }
      }
    }
  },
  {
    name: "minecraft_attack_nearest_hostile",
    description: "Attack the nearest hostile mob near the bot right now.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        maxDistance: { type: "number", description: "Maximum hostile search radius. Default: 8." }
      }
    }
  },
  {
    name: "minecraft_inventory",
    description: "List the bot's carried inventory items and counts.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {}
    }
  },
  {
    name: "minecraft_recent_events",
    description: "Return recent internal bot events like spawn, kicks, deaths, chat observations, and errors.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        limit: { type: "number", description: "How many recent events to return. Default: 20." }
      }
    }
  },
  {
    name: "minecraft_stop",
    description: "Stop the current follow/guard/pathfinding/combat behavior and return to idle.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {}
    }
  }
];

function asRecord(input: unknown): ArgumentsRecord {
  return (input ?? {}) as ArgumentsRecord;
}

function optionalString(args: ArgumentsRecord, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function requiredString(args: ArgumentsRecord, key: string): string {
  const value = optionalString(args, key);
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function optionalNumber(args: ArgumentsRecord, key: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${key} must be a finite number`);
  }
  return value;
}

const SERVER_INFO_URL =
  process.env.MC_SERVER_INFO_URL ||
  "https://volpestyle-minecraft-worlds.s3.amazonaws.com/server-info.json";

/**
 * Resolve the Minecraft server host.
 * If the user provided a host explicitly, use that.
 * Otherwise, try fetching the current server IP from S3 (written by the deploy workflow).
 * Falls back to MC_HOST env var or 127.0.0.1.
 */
async function resolveHost(explicitHost: string | undefined): Promise<string> {
  if (explicitHost) return explicitHost;

  // Try S3 server-info
  try {
    const response = await fetch(SERVER_INFO_URL, { signal: AbortSignal.timeout(3000) });
    if (response.ok) {
      const info = (await response.json()) as { host?: string };
      if (info?.host) return info.host;
    }
  } catch {
    // S3 not available or server not deployed — fall through
  }

  return process.env.MC_HOST || "127.0.0.1";
}

/**
 * Execute a tool call against a MinecraftBotController.
 * Returns a structured result with { ok, output } or throws on unknown tool.
 */
export async function dispatchToolCall(
  controller: MinecraftBotController,
  toolName: string,
  args: unknown
): Promise<{ ok: boolean; output: unknown }> {
  const a = asRecord(args);

  switch (toolName) {
    case "minecraft_connect": {
      const host = await resolveHost(optionalString(a, "host"));
      return {
        ok: true,
        output: await controller.connect({
          host,
          ...(optionalNumber(a, "port") !== undefined ? { port: optionalNumber(a, "port") } : {}),
          ...(optionalString(a, "username") ? { username: optionalString(a, "username") } : {}),
          ...(optionalString(a, "auth") ? { auth: optionalString(a, "auth") } : {}),
          ...(optionalString(a, "version") ? { version: optionalString(a, "version") } : {}),
          ...(optionalString(a, "profilesFolder") ? { profilesFolder: optionalString(a, "profilesFolder") } : {}),
          ...(optionalNumber(a, "connectTimeoutMs") !== undefined
            ? { connectTimeoutMs: optionalNumber(a, "connectTimeoutMs") }
            : {})
        })
      };
    }

    case "minecraft_disconnect":
      return { ok: true, output: await controller.disconnect(optionalString(a, "reason") ?? "disconnect requested") };

    case "minecraft_status":
      return { ok: true, output: controller.status() };

    case "minecraft_chat":
      return { ok: true, output: await controller.chat(requiredString(a, "message")) };

    case "minecraft_list_players":
      return { ok: true, output: controller.listPlayers() };

    case "minecraft_follow_player":
      return {
        ok: true,
        output: await controller.followPlayer(requiredString(a, "playerName"), optionalNumber(a, "distance") ?? 3)
      };

    case "minecraft_guard_player":
      return {
        ok: true,
        output: await controller.guardPlayer(
          requiredString(a, "playerName"),
          optionalNumber(a, "radius") ?? 8,
          optionalNumber(a, "followDistance") ?? 4
        )
      };

    case "minecraft_go_to":
      return {
        ok: true,
        output: await controller.goTo(
          optionalNumber(a, "x") ?? (() => { throw new Error("x is required"); })(),
          optionalNumber(a, "y") ?? (() => { throw new Error("y is required"); })(),
          optionalNumber(a, "z") ?? (() => { throw new Error("z is required"); })(),
          optionalNumber(a, "range") ?? 1
        )
      };

    case "minecraft_look_at_player":
      return { ok: true, output: await controller.lookAtPlayer(requiredString(a, "playerName")) };

    case "minecraft_collect_block":
      return {
        ok: true,
        output: await controller.collectBlock(
          requiredString(a, "blockName"),
          optionalNumber(a, "count") ?? 1,
          optionalNumber(a, "maxDistance") ?? 32
        )
      };

    case "minecraft_attack_nearest_hostile":
      return { ok: true, output: await controller.attackNearestHostile(optionalNumber(a, "maxDistance") ?? 8) };

    case "minecraft_inventory":
      return { ok: true, output: controller.inventory() };

    case "minecraft_recent_events":
      return { ok: true, output: controller.recentEventLog(optionalNumber(a, "limit") ?? 20) };

    case "minecraft_stop":
      return { ok: true, output: await controller.stop() };

    default:
      throw new Error(`Unknown tool '${toolName}'`);
  }
}
