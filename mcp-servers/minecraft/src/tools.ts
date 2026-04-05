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
    description: "Return recent typed bot events like spawn, kicks, deaths, chat observations, combat, and player joins/leaves.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        limit: { type: "number", description: "How many recent events to return. Default: 20." }
      }
    }
  },
  {
    name: "minecraft_visible_blocks",
    description:
      "Return a bounded projection of blocks and entities in front of the bot for short-range environmental reasoning.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        maxDistance: { type: "number", description: "Maximum sample distance in blocks. Default: 8." },
        maxBlocks: { type: "number", description: "Maximum returned non-air blocks. Default: 24." }
      }
    }
  },
  {
    name: "minecraft_look",
    description:
      "Capture a rendered first-person scene image from the bot's current perspective for aesthetic or social inspection.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        width: { type: "number", description: "Image width in pixels. Default: 640." },
        height: { type: "number", description: "Image height in pixels. Default: 360." },
        viewDistance: { type: "number", description: "Viewer chunk radius. Default: 4." }
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
  },
  {
    name: "minecraft_equip_offhand",
    description: "Equip an item from the bot's inventory to the off-hand slot (e.g. shield).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["itemName"],
      properties: {
        itemName: { type: "string", description: "Canonical item id to equip, e.g. shield, totem_of_undying." }
      }
    }
  },
  {
    name: "minecraft_unequip_offhand",
    description: "Unequip the item currently in the bot's off-hand slot.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {}
    }
  },
  {
    name: "minecraft_eat_best_food",
    description: "Select the highest-value food in inventory and eat it to restore hunger and saturation.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {}
    }
  },
  {
    name: "minecraft_jump",
    description: "Trigger a short jump. Useful for unstick recovery or stepping onto a single block.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {}
    }
  },
  {
    name: "minecraft_repath",
    description: "Clear and re-assert the current pathfinding goal to recover from stuck navigation.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {}
    }
  },
  {
    name: "minecraft_flee_toward",
    description: "Pathfind to a safe coordinate vector away from a hazard. Used as a reflex recovery.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["x", "y", "z"],
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        z: { type: "number" },
        range: { type: "number", description: "How close is close enough. Default: 2." }
      }
    }
  },
  {
    name: "minecraft_craft",
    description: "Craft an item using known recipes. Requires a crafting table for 3x3 recipes.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["recipeName"],
      properties: {
        recipeName: { type: "string", description: "Canonical item id to craft, e.g. crafting_table, wooden_pickaxe." },
        count: { type: "number", description: "How many result items to craft. Default: 1." },
        useCraftingTable: {
          type: "boolean",
          description: "Whether to use a nearby crafting table for 3x3 recipes. Default: false (2x2 inventory)."
        }
      }
    }
  },
  {
    name: "minecraft_recipe_check",
    description: "Report whether a recipe is known and craftable right now, with missing ingredients if not.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["recipeName"],
      properties: {
        recipeName: { type: "string", description: "Canonical item id to check." },
        useCraftingTable: { type: "boolean", description: "Consider the nearby crafting table. Default: false." }
      }
    }
  },
  {
    name: "minecraft_find_crafting_table",
    description: "Find the nearest crafting table within maxDistance blocks.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        maxDistance: { type: "number", description: "Search radius in blocks. Default: 16." }
      }
    }
  },
  {
    name: "minecraft_find_chests",
    description: "Find nearby chests, trapped chests, ender chests, and barrels.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        maxDistance: { type: "number", description: "Search radius in blocks. Default: 16." },
        maxChests: { type: "number", description: "Maximum chests to return. Default: 8." }
      }
    }
  },
  {
    name: "minecraft_deposit_items",
    description: "Deposit items from the bot's inventory into a chest at the given coordinates.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["x", "y", "z", "items"],
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        z: { type: "number" },
        items: {
          type: "array",
          description: "List of {name, count} pairs to deposit.",
          items: {
            type: "object",
            required: ["name", "count"],
            properties: {
              name: { type: "string" },
              count: { type: "number" }
            }
          }
        }
      }
    }
  },
  {
    name: "minecraft_withdraw_items",
    description: "Withdraw items from a chest at the given coordinates into the bot's inventory.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["x", "y", "z", "items"],
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        z: { type: "number" },
        items: {
          type: "array",
          description: "List of {name, count} pairs to withdraw.",
          items: {
            type: "object",
            required: ["name", "count"],
            properties: {
              name: { type: "string" },
              count: { type: "number" }
            }
          }
        }
      }
    }
  },
  {
    name: "minecraft_place_block",
    description: "Place a single block from inventory at the given coordinates. Requires an adjacent solid face.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["x", "y", "z", "blockName"],
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        z: { type: "number" },
        blockName: { type: "string", description: "Canonical Minecraft block id to place." }
      }
    }
  },
  {
    name: "minecraft_dig_block",
    description: "Dig a single block at the given coordinates. Low-level action used by the building planner.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["x", "y", "z"],
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        z: { type: "number" }
      }
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

    case "minecraft_visible_blocks":
      return {
        ok: true,
        output: controller.visibleBlocks(optionalNumber(a, "maxDistance") ?? 8, optionalNumber(a, "maxBlocks") ?? 24)
      };

    case "minecraft_look":
      return {
        ok: true,
        output: await controller.look({
          width: optionalNumber(a, "width") ?? 640,
          height: optionalNumber(a, "height") ?? 360,
          viewDistance: optionalNumber(a, "viewDistance") ?? 4
        })
      };

    case "minecraft_stop":
      return { ok: true, output: await controller.stop() };

    case "minecraft_equip_offhand":
      return { ok: true, output: await controller.equipOffhand(requiredString(a, "itemName")) };

    case "minecraft_unequip_offhand":
      return { ok: true, output: await controller.unequipOffhand() };

    case "minecraft_eat_best_food":
      return { ok: true, output: await controller.eatBestFood() };

    case "minecraft_jump":
      return { ok: true, output: await controller.jump() };

    case "minecraft_repath":
      return { ok: true, output: await controller.repath() };

    case "minecraft_flee_toward":
      return {
        ok: true,
        output: await controller.fleeToward(
          optionalNumber(a, "x") ?? (() => { throw new Error("x is required"); })(),
          optionalNumber(a, "y") ?? (() => { throw new Error("y is required"); })(),
          optionalNumber(a, "z") ?? (() => { throw new Error("z is required"); })(),
          optionalNumber(a, "range") ?? 2
        )
      };

    case "minecraft_craft":
      return {
        ok: true,
        output: await controller.craftItem(
          requiredString(a, "recipeName"),
          optionalNumber(a, "count") ?? 1,
          Boolean(a["useCraftingTable"])
        )
      };

    case "minecraft_recipe_check":
      return {
        ok: true,
        output: controller.checkRecipe(
          requiredString(a, "recipeName"),
          Boolean(a["useCraftingTable"])
        )
      };

    case "minecraft_find_crafting_table":
      return { ok: true, output: controller.findCraftingTable(optionalNumber(a, "maxDistance") ?? 16) };

    case "minecraft_find_chests":
      return {
        ok: true,
        output: controller.findNearbyChests(
          optionalNumber(a, "maxDistance") ?? 16,
          optionalNumber(a, "maxChests") ?? 8
        )
      };

    case "minecraft_deposit_items":
      return {
        ok: true,
        output: await controller.depositToChest(
          optionalNumber(a, "x") ?? (() => { throw new Error("x is required"); })(),
          optionalNumber(a, "y") ?? (() => { throw new Error("y is required"); })(),
          optionalNumber(a, "z") ?? (() => { throw new Error("z is required"); })(),
          asItemList(a["items"])
        )
      };

    case "minecraft_withdraw_items":
      return {
        ok: true,
        output: await controller.withdrawFromChest(
          optionalNumber(a, "x") ?? (() => { throw new Error("x is required"); })(),
          optionalNumber(a, "y") ?? (() => { throw new Error("y is required"); })(),
          optionalNumber(a, "z") ?? (() => { throw new Error("z is required"); })(),
          asItemList(a["items"])
        )
      };

    case "minecraft_place_block":
      return {
        ok: true,
        output: await controller.placeBlockAt(
          optionalNumber(a, "x") ?? (() => { throw new Error("x is required"); })(),
          optionalNumber(a, "y") ?? (() => { throw new Error("y is required"); })(),
          optionalNumber(a, "z") ?? (() => { throw new Error("z is required"); })(),
          requiredString(a, "blockName")
        )
      };

    case "minecraft_dig_block":
      return {
        ok: true,
        output: await controller.digBlockAt(
          optionalNumber(a, "x") ?? (() => { throw new Error("x is required"); })(),
          optionalNumber(a, "y") ?? (() => { throw new Error("y is required"); })(),
          optionalNumber(a, "z") ?? (() => { throw new Error("z is required"); })()
        )
      };

    default:
      throw new Error(`Unknown tool '${toolName}'`);
  }
}

function asItemList(raw: unknown): Array<{ name: string; count: number }> {
  if (!Array.isArray(raw)) throw new Error("items must be an array");
  const items: Array<{ name: string; count: number }> = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const name = String(record.name || "").trim();
    const count = Number(record.count);
    if (!name || !Number.isFinite(count) || count < 1) continue;
    items.push({ name, count: Math.floor(count) });
  }
  return items;
}
