import { once } from "node:events";
import mineflayerPkg from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";
import collectBlockPkg from "mineflayer-collectblock";
import pvpPkg from "mineflayer-pvp";
import toolPkg from "mineflayer-tool";
import { Vec3 } from "vec3";

import { log } from "./logger.js";

const mineflayer = mineflayerPkg;
const { pathfinder, Movements, goals } = pathfinderPkg as unknown as {
  pathfinder: (bot: unknown) => void;
  Movements: new (bot: unknown) => PathfinderMovements;
  goals: {
    GoalNear: new (x: number, y: number, z: number, range: number) => unknown;
    GoalFollow: new (entity: EntityLike, range: number) => unknown;
  };
};
const { plugin: collectBlockPlugin } = collectBlockPkg as unknown as {
  plugin: (bot: unknown) => void;
};
const { plugin: pvpPlugin } = pvpPkg as unknown as {
  plugin: (bot: unknown) => void;
};
const { plugin: toolPlugin } = toolPkg as unknown as {
  plugin: (bot: unknown) => void;
};

type UnknownRecord = Record<string, unknown>;

type ConnectOptions = {
  host?: string | undefined;
  port?: number | undefined;
  username?: string | undefined;
  auth?: "offline" | "microsoft" | string | undefined;
  version?: string | undefined;
  profilesFolder?: string | undefined;
  connectTimeoutMs?: number | undefined;
};

type Position = {
  x: number;
  y: number;
  z: number;
};

type EntityLike = {
  id: number;
  type: string;
  name?: string;
  displayName?: string;
  username?: string;
  position: Vec3;
};

type PlayerLike = {
  username?: string;
  entity?: EntityLike;
};

type ItemLike = {
  name: string;
  displayName?: string;
  count: number;
};

type InventoryLike = {
  items(): ItemLike[];
};

type BlockLike = {
  name: string;
  displayName?: string;
  position: Vec3;
};

type ToolPluginLike = {
  equipForBlock(block: BlockLike, options?: { requireHarvest?: boolean }): Promise<void>;
};

type CollectBlockPluginLike = {
  collect(block: BlockLike): Promise<void>;
};

type PvpPluginLike = {
  target?: EntityLike | null;
  attack(entity: EntityLike): void;
  stop(): void;
};

type PathfinderLike = {
  setMovements(movements: PathfinderMovements): void;
  setGoal(goal: unknown, dynamic?: boolean): void;
};

type RegistryLike = {
  blocksByName: Record<string, { id: number }>;
};

type GameLike = {
  gameMode?: string;
  dimension?: string;
};

type TimeLike = {
  timeOfDay?: number;
};

type MinecraftBotLike = {
  username: string;
  version?: string;
  players: Record<string, PlayerLike>;
  entity: { position: Vec3 };
  inventory: InventoryLike;
  registry: RegistryLike;
  game: GameLike;
  time: TimeLike;
  health?: number;
  food?: number;
  pathfinder: PathfinderLike;
  pvp: PvpPluginLike;
  tool: ToolPluginLike;
  collectBlock: CollectBlockPluginLike;
  loadPlugin(plugin: (bot: unknown) => void): void;
  findBlocks(options: { matching: number; maxDistance: number; count: number }): Vec3[];
  blockAt(position: Vec3): BlockLike | null;
  nearestEntity(predicate?: (entity: EntityLike) => boolean): EntityLike | null;
  lookAt(position: Vec3, force?: boolean): Promise<void>;
  chat(message: string): void;
  quit(reason?: string): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
  once(event: string, listener: (...args: unknown[]) => void): void;
  removeListener(event: string, listener: (...args: unknown[]) => void): void;
};

type PathfinderMovements = {
  canDig?: boolean;
};
type EventEmitterLike = {
  on(event: string, listener: (...args: unknown[]) => void): void;
  once(event: string, listener: (...args: unknown[]) => void): void;
};


type GuardState = {
  playerName: string;
  radius: number;
  followDistance: number;
};

type FollowState = {
  playerName: string;
  distance: number;
};

type StatusSnapshot = {
  connected: boolean;
  username?: string;
  version?: string;
  health?: number;
  food?: number;
  gameMode?: string;
  dimension?: string;
  timeOfDay?: number;
  position?: Position;
  players?: Array<{
    username: string;
    online: boolean;
    distance?: number;
    position?: Position;
  }>;
  inventory?: Array<{
    name: string;
    displayName?: string;
    count: number;
  }>;
  task: string;
  follow?: FollowState | null;
  guard?: GuardState | null;
  recentEvents: string[];
};

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const MAX_EVENT_LOG = 100;
const GUARDED_HOSTILE_NAMES = new Set([
  "blaze",
  "bogged",
  "breeze",
  "cave_spider",
  "creeper",
  "drowned",
  "elder_guardian",
  "endermite",
  "evoker",
  "ghast",
  "guardian",
  "hoglin",
  "husk",
  "illusioner",
  "magma_cube",
  "phantom",
  "piglin_brute",
  "pillager",
  "ravager",
  "shulker",
  "silverfish",
  "skeleton",
  "slime",
  "spider",
  "stray",
  "vex",
  "vindicator",
  "witch",
  "wither_skeleton",
  "zoglin",
  "zombie",
  "zombie_villager"
]);

function envString(name: string): string | undefined {
  const value = process.env[name];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function envNumber(name: string): number | undefined {
  const value = envString(name);
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function clampPositiveInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  const normalized = Math.floor(value as number);
  return normalized > 0 ? normalized : fallback;
}

function normalizeBlockName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "_");
}

function distanceBetween(a: Vec3, b: Vec3): number {
  return a.distanceTo(b);
}

function toPosition(position: Vec3): Position {
  return {
    x: Number(position.x.toFixed(2)),
    y: Number(position.y.toFixed(2)),
    z: Number(position.z.toFixed(2))
  };
}

function describeEntity(entity: EntityLike | null): string {
  if (!entity) return "none";
  return entity.username ?? entity.displayName ?? entity.name ?? `${entity.type}#${entity.id}`;
}

export class MinecraftBotController {
  private bot: MinecraftBotLike | null = null;
  private currentTask = "idle";
  private followState: FollowState | null = null;
  private guardState: GuardState | null = null;
  private recentEvents: string[] = [];
  private movements: PathfinderMovements | null = null;
  private guardTickCounter = 0;
  private readonly onPhysicTick = (): void => {
    this.guardTickCounter += 1;
    if (this.guardTickCounter % 10 !== 0) return;
    void this.tickGuard();
  };

  async connect(options: ConnectOptions = {}): Promise<StatusSnapshot> {
    if (this.bot) {
      throw new Error("Bot is already connected. Use minecraft_disconnect first.");
    }

    const host = options.host ?? envString("MC_HOST") ?? "127.0.0.1";
    const port = clampPositiveInteger(options.port ?? envNumber("MC_PORT"), 25565);
    const username = options.username ?? envString("MC_USERNAME") ?? "ClankyBuddy";
    const auth = options.auth ?? envString("MC_AUTH") ?? "offline";
    const version = options.version ?? envString("MC_VERSION");
    const profilesFolder = options.profilesFolder ?? envString("MC_PROFILES_FOLDER");
    const connectTimeoutMs = clampPositiveInteger(
      options.connectTimeoutMs ?? envNumber("MC_CONNECT_TIMEOUT_MS"),
      DEFAULT_CONNECT_TIMEOUT_MS
    );

    log("info", "Connecting minecraft bot", {
      host,
      port,
      username,
      auth,
      version: version ?? null
    });

    const bot = mineflayer.createBot({
      host,
      port,
      username,
      auth,
      ...(version ? { version } : {}),
      ...(profilesFolder ? { profilesFolder } : {})
    }) as unknown as MinecraftBotLike;

    bot.loadPlugin(pathfinder);
    bot.loadPlugin(toolPlugin);
    bot.loadPlugin(collectBlockPlugin);
    bot.loadPlugin(pvpPlugin);

    this.attachListeners(bot);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mineflayer bot is untyped
    const emitter = bot as any;
    const spawnPromise = once(emitter, "spawn");
    const endPromise = once(emitter, "end").then(() => {
      throw new Error("Minecraft bot connection ended before spawn.");
    });
    const kickedPromise = once(emitter, "kicked").then((args: unknown[]) => {
      throw new Error(`Minecraft bot was kicked before spawn: ${String(args[0] ?? "")}`);
    });
    const errorPromise = once(emitter, "error").then((args: unknown[]) => {
      const err = args[0];
      throw err instanceof Error ? err : new Error(String(err));
    });
    const timeoutPromise = new Promise<never>((_, reject) => {
      const handle = setTimeout(() => {
        clearTimeout(handle);
        reject(new Error(`Timed out waiting for Minecraft spawn after ${connectTimeoutMs}ms.`));
      }, connectTimeoutMs);
    });

    try {
      await Promise.race([spawnPromise, endPromise, kickedPromise, errorPromise, timeoutPromise]);
    } catch (error) {
      try {
        bot.quit("connect failed");
      } catch {
        // ignore
      }
      throw error;
    }

    this.bot = bot;
    this.movements = new Movements(bot as unknown as object);
    this.movements.canDig = true;
    bot.pathfinder.setMovements(this.movements);
    this.currentTask = "idle";
    this.appendEvent(`spawned as ${username}@${host}:${port}`);
    return this.status();
  }

  async disconnect(reason = "disconnect requested"): Promise<StatusSnapshot> {
    if (!this.bot) {
      return this.status();
    }

    const bot = this.bot;
    this.stopInternal();
    this.appendEvent(`disconnecting: ${reason}`);
    try {
      bot.quit(reason);
    } catch {
      // ignore
    }

    this.bot = null;
    this.movements = null;
    this.currentTask = "disconnected";
    return this.status();
  }

  status(): StatusSnapshot {
    if (!this.bot) {
      return {
        connected: false,
        task: this.currentTask,
        recentEvents: [...this.recentEvents]
      };
    }

    const bot = this.bot;
    return {
      connected: true,
      username: bot.username,
      ...(bot.version ? { version: bot.version } : {}),
      ...(bot.health !== undefined ? { health: bot.health } : {}),
      ...(bot.food !== undefined ? { food: bot.food } : {}),
      ...(bot.game.gameMode ? { gameMode: bot.game.gameMode } : {}),
      ...(bot.game.dimension ? { dimension: bot.game.dimension } : {}),
      ...(bot.time.timeOfDay !== undefined ? { timeOfDay: bot.time.timeOfDay } : {}),
      position: toPosition(bot.entity.position),
      players: this.listPlayersInternal(),
      inventory: this.listInventoryInternal(),
      task: this.currentTask,
      ...(this.followState ? { follow: this.followState } : {}),
      ...(this.guardState ? { guard: this.guardState } : {}),
      recentEvents: [...this.recentEvents]
    };
  }

  listPlayers(): Array<{
    username: string;
    online: boolean;
    distance?: number;
    position?: Position;
  }> {
    this.ensureBot();
    return this.listPlayersInternal();
  }

  inventory(): Array<{
    name: string;
    displayName?: string;
    count: number;
  }> {
    this.ensureBot();
    return this.listInventoryInternal();
  }

  recentEventLog(limit = 20): string[] {
    return this.recentEvents.slice(-Math.max(1, Math.min(limit, MAX_EVENT_LOG)));
  }

  async chat(message: string): Promise<{ ok: true; message: string }> {
    const bot = this.ensureBot();
    const normalized = message.trim();
    if (!normalized) {
      throw new Error("message is required");
    }

    bot.chat(normalized);
    this.currentTask = "chatting";
    this.appendEvent(`sent chat: ${normalized}`);
    this.currentTask = "idle";
    return { ok: true, message: normalized };
  }

  async goTo(x: number, y: number, z: number, range = 1): Promise<{ ok: true; target: Position; range: number }> {
    const bot = this.ensureBot();
    this.clearModes();
    this.currentTask = `moving to ${x},${y},${z}`;
    bot.pathfinder.setGoal(new goals.GoalNear(x, y, z, range), false);
    this.appendEvent(`pathfinding to ${x},${y},${z} (range=${range})`);
    return {
      ok: true,
      target: { x, y, z },
      range
    };
  }

  async followPlayer(playerName: string, distance = 3): Promise<{ ok: true; playerName: string; distance: number }> {
    const bot = this.ensureBot();
    const player = this.requirePlayer(playerName);
    if (!player.entity) {
      throw new Error(`Player '${playerName}' is not currently visible to the bot.`);
    }

    this.guardState = null;
    this.followState = {
      playerName,
      distance
    };
    this.currentTask = `following ${playerName}`;
    bot.pathfinder.setGoal(new goals.GoalFollow(player.entity, distance), true);
    this.appendEvent(`following ${playerName} (distance=${distance})`);
    return {
      ok: true,
      playerName,
      distance
    };
  }

  async guardPlayer(
    playerName: string,
    radius = 8,
    followDistance = 4
  ): Promise<{ ok: true; playerName: string; radius: number; followDistance: number }> {
    this.ensureBot();
    this.requirePlayer(playerName);

    this.followState = null;
    this.guardState = {
      playerName,
      radius,
      followDistance
    };
    this.currentTask = `guarding ${playerName}`;
    this.appendEvent(`guarding ${playerName} (radius=${radius}, followDistance=${followDistance})`);
    await this.tickGuard();
    return {
      ok: true,
      playerName,
      radius,
      followDistance
    };
  }

  async stop(): Promise<{ ok: true }> {
    this.ensureBot();
    this.stopInternal();
    this.currentTask = "idle";
    this.appendEvent("stopped current autonomous action");
    return { ok: true };
  }

  async attackNearestHostile(maxDistance = 8): Promise<{ ok: true; target: string }> {
    const bot = this.ensureBot();
    const hostile = bot.nearestEntity((entity) =>
      this.isHostileMob(entity) && distanceBetween(entity.position, bot.entity.position) <= maxDistance
    );

    if (!hostile) {
      throw new Error(`No hostile entity found within ${maxDistance} blocks.`);
    }

    this.clearModes();
    this.currentTask = `attacking ${describeEntity(hostile)}`;
    bot.pvp.attack(hostile);
    this.appendEvent(`attacking ${describeEntity(hostile)}`);
    return {
      ok: true,
      target: describeEntity(hostile)
    };
  }

  async lookAtPlayer(playerName: string): Promise<{ ok: true; playerName: string }> {
    const bot = this.ensureBot();
    const player = this.requirePlayer(playerName);
    if (!player.entity) {
      throw new Error(`Player '${playerName}' is not currently visible to the bot.`);
    }

    await bot.lookAt(player.entity.position, true);
    this.appendEvent(`looking at ${playerName}`);
    return {
      ok: true,
      playerName
    };
  }

  async collectBlock(
    blockName: string,
    count = 1,
    maxDistance = 32
  ): Promise<{
    ok: true;
    blockName: string;
    requested: number;
    attempted: number;
    inventoryBefore: number;
    inventoryAfter: number;
  }> {
    const bot = this.ensureBot();
    this.clearModes();

    const normalizedBlockName = normalizeBlockName(blockName);
    const targetBlockData = bot.registry.blocksByName[normalizedBlockName];
    if (!targetBlockData) {
      throw new Error(`Unknown block '${blockName}'. Use canonical Minecraft block ids like oak_log or cobblestone.`);
    }

    const desiredCount = clampPositiveInteger(count, 1);
    const searchDistance = clampPositiveInteger(maxDistance, 32);
    const positions = bot.findBlocks({
      matching: targetBlockData.id,
      maxDistance: searchDistance,
      count: desiredCount
    });

    if (positions.length === 0) {
      throw new Error(`No '${normalizedBlockName}' blocks found within ${searchDistance} blocks.`);
    }

    const blocks = positions
      .map((position) => bot.blockAt(position))
      .filter((block): block is BlockLike => Boolean(block));

    const inventoryBefore = this.countInventoryItem(normalizedBlockName);
    let attempted = 0;
    this.currentTask = `collecting ${desiredCount} ${normalizedBlockName}`;

    for (const block of blocks.slice(0, desiredCount)) {
      await bot.tool.equipForBlock(block, { requireHarvest: false });
      await bot.collectBlock.collect(block);
      attempted += 1;
    }

    const inventoryAfter = this.countInventoryItem(normalizedBlockName);
    this.appendEvent(`collected ${attempted} block(s) of ${normalizedBlockName}`);
    this.currentTask = "idle";

    return {
      ok: true,
      blockName: normalizedBlockName,
      requested: desiredCount,
      attempted,
      inventoryBefore,
      inventoryAfter
    };
  }

  private attachListeners(bot: MinecraftBotLike): void {
    bot.on("login", () => {
      this.appendEvent("logged in");
    });

    bot.on("spawn", () => {
      this.appendEvent("spawn");
    });

    bot.on("end", () => {
      this.appendEvent("connection ended");
      this.currentTask = "disconnected";
      this.bot = null;
      this.followState = null;
      this.guardState = null;
      this.movements = null;
    });

    bot.on("kicked", (reason) => {
      this.appendEvent(`kicked: ${String(reason)}`);
    });

    bot.on("error", (error) => {
      this.appendEvent(`error: ${error instanceof Error ? error.message : String(error)}`);
    });

    bot.on("death", () => {
      this.appendEvent("death");
    });

    bot.on("chat", (username, message) => {
      if (typeof username === "string" && typeof message === "string") {
        this.appendEvent(`chat<${username}> ${message}`);
      }
    });

    bot.on("physicTick", this.onPhysicTick);
  }

  private async tickGuard(): Promise<void> {
    const bot = this.ensureBot();
    const state = this.guardState;
    if (!state) return;

    const player = bot.players[state.playerName];
    const friend = player?.entity;
    if (!friend) {
      this.appendEvent(`guard target '${state.playerName}' not visible`);
      return;
    }

    const hostile = bot.nearestEntity((entity) => {
      if (!this.isHostileMob(entity)) return false;
      return distanceBetween(entity.position, friend.position) <= state.radius;
    });

    if (hostile) {
      if (bot.pvp.target?.id !== hostile.id) {
        bot.pvp.attack(hostile);
        this.appendEvent(`guard engaging ${describeEntity(hostile)} near ${state.playerName}`);
      }
      this.currentTask = `guarding ${state.playerName}`;
      return;
    }

    if (bot.pvp.target) {
      bot.pvp.stop();
    }

    bot.pathfinder.setGoal(new goals.GoalFollow(friend, state.followDistance), true);
    this.currentTask = `guarding ${state.playerName}`;
  }

  private isHostileMob(entity: EntityLike): boolean {
    if (entity.type !== "mob") return false;
    const normalized = String(entity.name ?? entity.displayName ?? "").trim().toLowerCase();
    return GUARDED_HOSTILE_NAMES.has(normalized);
  }

  private countInventoryItem(itemName: string): number {
    const bot = this.bot;
    if (!bot) return 0;
    return bot.inventory
      .items()
      .filter((item) => item.name === itemName)
      .reduce((sum, item) => sum + item.count, 0);
  }

  private listPlayersInternal(): Array<{
    username: string;
    online: boolean;
    distance?: number;
    position?: Position;
  }> {
    const bot = this.ensureBot();
    const selfPosition = bot.entity.position;

    return Object.entries(bot.players)
      .map(([username, player]) => {
        const entity = player.entity;
        return {
          username,
          online: Boolean(entity),
          ...(entity
            ? {
                distance: Number(distanceBetween(selfPosition, entity.position).toFixed(2)),
                position: toPosition(entity.position)
              }
            : {})
        };
      })
      .sort((a, b) => {
        const left = a.distance ?? Number.POSITIVE_INFINITY;
        const right = b.distance ?? Number.POSITIVE_INFINITY;
        return left - right;
      });
  }

  private listInventoryInternal(): Array<{
    name: string;
    displayName?: string;
    count: number;
  }> {
    const bot = this.ensureBot();
    return bot.inventory
      .items()
      .map((item) => ({
        name: item.name,
        ...(item.displayName ? { displayName: item.displayName } : {}),
        count: item.count
      }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }

  private requirePlayer(playerName: string): PlayerLike {
    const bot = this.ensureBot();
    const player = bot.players[playerName];
    if (!player) {
      throw new Error(`Player '${playerName}' is not known in the current world state.`);
    }
    return player;
  }

  private clearModes(): void {
    this.followState = null;
    this.guardState = null;
  }

  private stopInternal(): void {
    const bot = this.bot;
    if (!bot) return;

    this.clearModes();
    try {
      bot.pathfinder.setGoal(null);
    } catch {
      // ignore
    }

    try {
      bot.pvp.stop();
    } catch {
      // ignore
    }
  }

  private appendEvent(message: string): void {
    const line = `${new Date().toISOString()} ${message}`;
    this.recentEvents.push(line);
    if (this.recentEvents.length > MAX_EVENT_LOG) {
      this.recentEvents = this.recentEvents.slice(-MAX_EVENT_LOG);
    }
    log("info", "minecraft-event", { message });
  }

  private ensureBot(): MinecraftBotLike {
    if (!this.bot) {
      throw new Error("Bot is not connected. Use minecraft_connect first.");
    }
    return this.bot;
  }
}
