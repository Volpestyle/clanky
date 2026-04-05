import { once } from "node:events";
import { createServer } from "node:net";
import mineflayerPkg from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";
import collectBlockPkg from "mineflayer-collectblock";
import pvpPkg from "mineflayer-pvp";
import toolPkg from "mineflayer-tool";
import prismarineViewerPkg from "prismarine-viewer";
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
const { headless: prismarineViewerHeadless } = prismarineViewerPkg as unknown as {
  headless: (
    bot: unknown,
    settings: {
      viewDistance?: number;
      output?: string;
      frames?: number;
      width?: number;
      height?: number;
      logFFMPEG?: boolean;
      jpegOptions?: Record<string, unknown>;
    }
  ) => { destroy?: () => void; end?: () => void } | false;
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
  slot?: number;
  type?: number;
  metadata?: number;
};

type InventoryLike = {
  items(): ItemLike[];
  emptySlotCount(): number;
  slots: Array<ItemLike | null>;
};

type BlockLike = {
  name: string;
  displayName?: string;
  position: Vec3;
};

type ChestWindowLike = {
  items(): ItemLike[];
  containerItems(): ItemLike[];
  close(): void;
  deposit(itemType: number, metadata: number | null, count: number): Promise<void>;
  withdraw(itemType: number, metadata: number | null, count: number): Promise<void>;
};

type FoodLike = {
  name: string;
  foodPoints?: number;
  saturation?: number;
  stackSize?: number;
};

type RecipeLike = {
  result: { id: number; count: number; metadata?: number };
  inShape?: Array<Array<{ id: number; count: number } | null>>;
  ingredients?: Array<{ id: number; count: number }>;
  requiresTable?: boolean;
  delta?: Array<{ id: number; count: number }>;
};

type RegistryItemEntry = {
  id: number;
  name: string;
  displayName?: string;
  stackSize?: number;
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
  blocksByName: Record<string, { id: number; displayName?: string }>;
  itemsByName: Record<string, RegistryItemEntry>;
  itemsArray?: RegistryItemEntry[];
  foods?: Record<number, FoodLike>;
  foodsByName?: Record<string, FoodLike>;
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
  world: unknown;
  players: Record<string, PlayerLike>;
  entities: Record<string, EntityLike>;
  entity: { position: Vec3; yaw?: number; pitch?: number; id?: number };
  inventory: InventoryLike;
  registry: RegistryLike;
  game: GameLike;
  time: TimeLike;
  health?: number;
  food?: number;
  heldItem?: ItemLike | null;
  pathfinder: PathfinderLike;
  pvp: PvpPluginLike;
  tool: ToolPluginLike;
  collectBlock: CollectBlockPluginLike;
  loadPlugin(plugin: (bot: unknown) => void): void;
  findBlocks(options: { matching: number | number[]; maxDistance: number; count: number }): Vec3[];
  blockAt(position: Vec3): BlockLike | null;
  nearestEntity(predicate?: (entity: EntityLike) => boolean): EntityLike | null;
  lookAt(position: Vec3, force?: boolean): Promise<void>;
  chat(message: string): void;
  quit(reason?: string): void;
  setControlState(control: string, state: boolean): void;
  equip(item: ItemLike, destination: "hand" | "head" | "torso" | "legs" | "feet" | "off-hand"): Promise<void>;
  unequip(destination: "hand" | "head" | "torso" | "legs" | "feet" | "off-hand"): Promise<void>;
  placeBlock(referenceBlock: BlockLike, faceVector: Vec3): Promise<void>;
  dig(block: BlockLike): Promise<void>;
  activateItem(): void;
  deactivateItem(): void;
  consume(): Promise<void>;
  openContainer(block: BlockLike): Promise<ChestWindowLike>;
  craft(recipe: RecipeLike, count: number, craftingTable?: BlockLike | null): Promise<void>;
  recipesFor(itemId: number, metadata: number | null, minResultCount: number, craftingTable: BlockLike | boolean | null): RecipeLike[];
  recipesAll(itemId: number, metadata: number | null, craftingTable: BlockLike | boolean | null): RecipeLike[];
  on(event: string, listener: (...args: unknown[]) => void): void;
  once(event: string, listener: (...args: unknown[]) => void): void;
  removeListener(event: string, listener: (...args: unknown[]) => void): void;
  eventNames(): string[];
  listeners(event: string): Array<(...args: unknown[]) => void>;
};

type PathfinderMovements = {
  canDig?: boolean;
};
type EventEmitterLike = {
  on(event: string, listener: (...args: unknown[]) => void): void;
  once(event: string, listener: (...args: unknown[]) => void): void;
};

type BotListenerSnapshot = Map<string, Array<(...args: unknown[]) => void>>;


type GuardState = {
  playerName: string;
  radius: number;
  followDistance: number;
};

type FollowState = {
  playerName: string;
  distance: number;
};

type NavigationState = {
  x: number;
  y: number;
  z: number;
  range: number;
};

type EquipmentSnapshot = {
  hand: string | null;
  offhand: string | null;
  helmet: string | null;
  chestplate: string | null;
  leggings: string | null;
  boots: string | null;
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
  yaw?: number;
  pitch?: number;
  players?: Array<{
    username: string;
    online: boolean;
    distance?: number;
    position?: Position;
  }>;
  hazards?: Array<{
    type: string;
    distance: number;
    position: Position;
  }>;
  inventory?: Array<{
    name: string;
    displayName?: string;
    count: number;
  }>;
  equipment?: EquipmentSnapshot;
  task: string;
  follow?: FollowState | null;
  guard?: GuardState | null;
  recentEvents: MinecraftGameEvent[];
};

type MinecraftGameEvent =
  | {
      type: "chat";
      timestamp: string;
      summary: string;
      sender: string;
      message: string;
      isBot: boolean;
    }
  | {
      type: "death";
      timestamp: string;
      summary: string;
    }
  | {
      type: "player_join" | "player_leave";
      timestamp: string;
      summary: string;
      playerName: string;
    }
  | {
      type: "combat";
      timestamp: string;
      summary: string;
      combatKind: "attack" | "guard_engage";
      target: string;
      source?: string | null;
    }
  | {
      type: "block_break";
      timestamp: string;
      summary: string;
      blockName: string;
      count: number;
    }
  | {
      type: "item_pickup";
      timestamp: string;
      summary: string;
      itemName: string;
      count: number;
    }
  | {
      type: "server";
      timestamp: string;
      summary: string;
      serverEvent:
        | "spawned_as"
        | "disconnecting"
        | "logged_in"
        | "spawn"
        | "connection_ended"
        | "kicked"
        | "error";
      detail?: string;
    }
  | {
      type: "navigation";
      timestamp: string;
      summary: string;
      x: number;
      y: number;
      z: number;
      range: number;
    }
  | {
      type: "follow";
      timestamp: string;
      summary: string;
      playerName: string;
      distance: number;
    }
  | {
      type: "guard";
      timestamp: string;
      summary: string;
      playerName: string;
      radius: number;
      followDistance: number;
    }
  | {
      type: "look_at";
      timestamp: string;
      summary: string;
      playerName: string;
    }
  | {
      type: "rendered_look";
      timestamp: string;
      summary: string;
      width: number;
      height: number;
      viewDistance: number;
      bytes: number;
    }
  | {
      type: "system";
      timestamp: string;
      summary: string;
      detail?: string;
    };

type VisibleBlock = {
  name: string;
  displayName?: string;
  position: Position;
  relative: Position;
  distance: number;
};

type VisibleEntity = {
  name: string;
  type: string;
  position: Position;
  distance: number;
};

type VisibleScene = {
  sampledFrom: Position;
  blocks: VisibleBlock[];
  nearbyEntities: VisibleEntity[];
  skyVisible: boolean;
  enclosed: boolean;
  notableFeatures: string[];
};

type LookCapture = {
  mediaType: string;
  dataBase64: string;
  width: number;
  height: number;
  capturedAt: string;
  viewpoint: {
    position: Position;
    yaw: number | null;
    pitch: number | null;
  };
};

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_HAZARD_DISTANCE = 16;
const MAX_EVENT_LOG = 100;
// prismarine-viewer headless renders frames back-to-back. The first couple
// frames may land while chunks are still streaming into the WorldView, so
// we keep the last of several frames as the final capture.
const LOOK_FRAME_COUNT = 6;
const LOOK_CAPTURE_TIMEOUT_MS = 15_000;
const LOOK_JPEG_QUALITY = 0.95;
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

function roundDistance(value: number): number {
  return Number(value.toFixed(2));
}

function roundAngle(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Number(value.toFixed(4))
    : null;
}

function isAirBlockName(name: string | undefined): boolean {
  return name === "air" || name === "cave_air" || name === "void_air";
}

function getForwardVector(yaw = 0, pitch = 0): Position {
  const cosPitch = Math.cos(pitch);
  const x = -Math.sin(yaw) * cosPitch;
  const y = Math.sin(pitch);
  const z = -Math.cos(yaw) * cosPitch;
  const magnitude = Math.sqrt(x * x + y * y + z * z) || 1;
  return {
    x: x / magnitude,
    y: y / magnitude,
    z: z / magnitude
  };
}

function dotProduct(left: Position, right: Position): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

/**
 * Snapshot every current listener identity on the given bot (EventEmitter).
 *
 * Used to clean up listeners that prismarine-viewer's headless API attaches
 * to the bot during a capture — `lib/headless.js` wires `bot.on('move', ...)`,
 * `bot.on('end', ...)` and `worldView.listenToBot(bot)` with no cleanup path,
 * so without this we leak listeners (and retained WorldView/WebGLRenderer
 * instances) on every minecraft_look call.
 */
function snapshotBotListeners(bot: MinecraftBotLike): BotListenerSnapshot {
  const snapshot: BotListenerSnapshot = new Map();
  for (const name of bot.eventNames()) {
    snapshot.set(name, [...bot.listeners(name)]);
  }
  return snapshot;
}

/**
 * Remove any listeners on `bot` that were not present in the snapshot.
 * Returns the number of listeners removed.
 */
function removeListenersAddedSince(bot: MinecraftBotLike, snapshot: BotListenerSnapshot): number {
  let removed = 0;
  for (const name of bot.eventNames()) {
    const before = snapshot.get(name) ?? [];
    const beforeSet = new Set(before);
    for (const fn of bot.listeners(name)) {
      if (!beforeSet.has(fn)) {
        bot.removeListener(name, fn);
        removed += 1;
      }
    }
  }
  return removed;
}

function buildSceneFeatures(blocks: VisibleBlock[], entities: VisibleEntity[], skyVisible: boolean): string[] {
  const features = new Set<string>();
  const names = new Set(blocks.map((block) => block.name));

  if (skyVisible) features.add("open sky");
  if (!skyVisible && blocks.length >= 6) features.add("cave-like enclosure");
  if ([...names].some((name) => name.includes("water"))) features.add("water nearby");
  if ([...names].some((name) => name.includes("lava"))) features.add("lava nearby");
  if ([...names].some((name) => name.includes("log") || name.includes("leaves"))) features.add("trees nearby");
  if ([...names].some((name) => name.includes("ore"))) features.add("ore visible");
  if ([...names].some((name) => name === "crafting_table" || name.includes("chest") || name.includes("furnace"))) {
    features.add("workstation nearby");
  }
  if (entities.some((entity) => entity.type === "mob")) features.add("entities ahead");

  return [...features].slice(0, 6);
}

export class MinecraftBotController {
  private bot: MinecraftBotLike | null = null;
  private currentTask = "idle";
  private followState: FollowState | null = null;
  private guardState: GuardState | null = null;
  private navigationState: NavigationState | null = null;
  private recentEvents: MinecraftGameEvent[] = [];
  private movements: PathfinderMovements | null = null;
  private guardTickCounter = 0;
  private lookInFlight = false;
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
    this.appendEvent({
      type: "server",
      timestamp: new Date().toISOString(),
      summary: `spawned as ${username}@${host}:${port}`,
      serverEvent: "spawned_as",
      detail: `${host}:${port}`
    });
    return this.status();
  }

  async disconnect(reason = "disconnect requested"): Promise<StatusSnapshot> {
    if (!this.bot) {
      return this.status();
    }

    const bot = this.bot;
    this.stopInternal();
    this.appendEvent({
      type: "server",
      timestamp: new Date().toISOString(),
      summary: `disconnecting: ${reason}`,
      serverEvent: "disconnecting",
      detail: reason
    });
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
      ...(bot.entity.yaw !== undefined ? { yaw: bot.entity.yaw } : {}),
      ...(bot.entity.pitch !== undefined ? { pitch: bot.entity.pitch } : {}),
      players: this.listPlayersInternal(),
      hazards: this.listHazardsInternal(),
      inventory: this.listInventoryInternal(),
      equipment: this.listEquipmentInternal(),
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

  recentEventLog(limit = 20): MinecraftGameEvent[] {
    return this.recentEvents.slice(-Math.max(1, Math.min(limit, MAX_EVENT_LOG)));
  }

  visibleBlocks(maxDistance = 8, maxBlocks = 24): VisibleScene {
    const bot = this.ensureBot();
    const clampedMaxDistance = Math.max(2, Math.min(12, clampPositiveInteger(maxDistance, 8)));
    const clampedMaxBlocks = Math.max(4, Math.min(40, clampPositiveInteger(maxBlocks, 24)));
    const origin = bot.entity.position;
    const eyePosition = new Vec3(origin.x, origin.y + 1.62, origin.z);
    const forward = getForwardVector(bot.entity.yaw ?? 0, bot.entity.pitch ?? 0);
    const centerX = Math.floor(origin.x);
    const centerY = Math.floor(origin.y);
    const centerZ = Math.floor(origin.z);
    const sampledBlocks: Array<VisibleBlock & { alignment: number }> = [];
    const seenBlockPositions = new Set<string>();

    for (let x = centerX - clampedMaxDistance; x <= centerX + clampedMaxDistance; x += 1) {
      for (let y = centerY - 2; y <= centerY + 3; y += 1) {
        for (let z = centerZ - clampedMaxDistance; z <= centerZ + clampedMaxDistance; z += 1) {
          const block = bot.blockAt(new Vec3(x, y, z));
          if (!block || isAirBlockName(block.name)) continue;

          const blockCenter = new Vec3(x + 0.5, y + 0.5, z + 0.5);
          const delta = {
            x: blockCenter.x - eyePosition.x,
            y: blockCenter.y - eyePosition.y,
            z: blockCenter.z - eyePosition.z
          };
          const distance = Math.sqrt(delta.x * delta.x + delta.y * delta.y + delta.z * delta.z);
          if (distance < 0.75 || distance > clampedMaxDistance + 0.75) continue;

          const alignment = dotProduct(
            { x: delta.x / distance, y: delta.y / distance, z: delta.z / distance },
            forward
          );
          if (alignment < 0.2) continue;

          const key = `${x}:${y}:${z}`;
          if (seenBlockPositions.has(key)) continue;
          seenBlockPositions.add(key);
          sampledBlocks.push({
            name: block.name,
            ...(block.displayName ? { displayName: block.displayName } : {}),
            position: { x, y, z },
            relative: {
              x: x - centerX,
              y: y - centerY,
              z: z - centerZ
            },
            distance: roundDistance(distance),
            alignment
          });
        }
      }
    }

    const blocks = sampledBlocks
      .sort((left, right) => right.alignment - left.alignment || left.distance - right.distance)
      .slice(0, clampedMaxBlocks)
      .map(({ alignment: _alignment, ...block }) => block);

    const nearbyEntities = Object.values(bot.entities)
      .filter((entity) => entity.id !== bot.entity.id)
      .map((entity) => {
        const distance = distanceBetween(origin, entity.position);
        if (distance > clampedMaxDistance) return null;

        const delta = {
          x: entity.position.x - eyePosition.x,
          y: entity.position.y - eyePosition.y,
          z: entity.position.z - eyePosition.z
        };
        const magnitude = Math.sqrt(delta.x * delta.x + delta.y * delta.y + delta.z * delta.z) || 1;
        const alignment = dotProduct(
          { x: delta.x / magnitude, y: delta.y / magnitude, z: delta.z / magnitude },
          forward
        );
        if (alignment < 0.1) return null;

        return {
          name: describeEntity(entity),
          type: entity.type,
          position: toPosition(entity.position),
          distance: roundDistance(distance),
          alignment
        };
      })
      .filter((entity): entity is VisibleEntity & { alignment: number } => Boolean(entity))
      .sort((left, right) => right.alignment - left.alignment || left.distance - right.distance)
      .slice(0, 8)
      .map(({ alignment: _alignment, ...entity }) => entity);

    let skyVisible = true;
    for (let y = centerY + 2; y <= centerY + 10; y += 1) {
      const blockAbove = bot.blockAt(new Vec3(centerX, y, centerZ));
      if (blockAbove && !isAirBlockName(blockAbove.name)) {
        skyVisible = false;
        break;
      }
    }

    const notableFeatures = buildSceneFeatures(blocks, nearbyEntities, skyVisible);

    return {
      sampledFrom: toPosition(origin),
      blocks,
      nearbyEntities,
      skyVisible,
      enclosed: !skyVisible && blocks.length >= 6,
      notableFeatures
    };
  }

  async look(
    {
      width,
      height,
      viewDistance
    }: {
      width?: number;
      height?: number;
      viewDistance?: number;
    } = {}
  ): Promise<LookCapture> {
    const bot = this.ensureBot();
    if (this.lookInFlight) {
      throw new Error("minecraft_look is already in progress. Wait for the previous capture to finish.");
    }
    this.lookInFlight = true;

    const clampedWidth = Math.max(256, Math.min(1280, clampPositiveInteger(width, 640)));
    const clampedHeight = Math.max(256, Math.min(720, clampPositiveInteger(height, 360)));
    const clampedViewDistance = Math.max(2, Math.min(8, clampPositiveInteger(viewDistance, 4)));

    log("info", "Capturing rendered minecraft scene", {
      width: clampedWidth,
      height: clampedHeight,
      viewDistance: clampedViewDistance,
      frames: LOOK_FRAME_COUNT,
      version: bot.version ?? null
    });

    const listenerSnapshot = snapshotBotListeners(bot);

    try {
      const finalFrame = await new Promise<Buffer>((resolve, reject) => {
        const server = createServer();
        let settled = false;
        let viewerClient: { destroy?: () => void } | null = null;
        let buffered = Buffer.alloc(0);
        let expectedFrameBytes: number | null = null;
        let lastFrame: Buffer | null = null;
        const timeoutHandle = setTimeout(() => {
          fail(new Error(`minecraft_look timed out after ${LOOK_CAPTURE_TIMEOUT_MS}ms.`));
        }, LOOK_CAPTURE_TIMEOUT_MS);

        const cleanup = () => {
          clearTimeout(timeoutHandle);
          try {
            server.close();
          } catch {
            // ignore cleanup errors
          }
          try {
            viewerClient?.destroy?.();
          } catch {
            // ignore cleanup errors
          }
        };

        const succeed = (frame: Buffer) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(frame);
        };

        const fail = (error: Error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        };

        const drainFrames = () => {
          while (true) {
            if (expectedFrameBytes === null) {
              if (buffered.length < 4) return;
              expectedFrameBytes = buffered.readUInt32LE(0);
              buffered = buffered.subarray(4);
            }
            if (buffered.length < expectedFrameBytes) return;
            lastFrame = Buffer.from(buffered.subarray(0, expectedFrameBytes));
            buffered = buffered.subarray(expectedFrameBytes);
            expectedFrameBytes = null;
          }
        };

        server.on("error", (error) => {
          fail(error instanceof Error ? error : new Error(String(error)));
        });

        server.on("connection", (socket) => {
          socket.on("data", (chunk) => {
            buffered = Buffer.concat([buffered, Buffer.from(chunk)]);
            drainFrames();
          });
          socket.on("error", (error) => {
            fail(error instanceof Error ? error : new Error(String(error)));
          });
          socket.on("close", () => {
            if (lastFrame) {
              succeed(lastFrame);
              return;
            }
            fail(new Error("minecraft_look produced no image frame."));
          });
        });

        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          if (!address || typeof address === "string") {
            fail(new Error("minecraft_look could not bind a local capture port."));
            return;
          }

          try {
            const client = prismarineViewerHeadless(bot, {
              viewDistance: clampedViewDistance,
              output: `127.0.0.1:${address.port}`,
              frames: LOOK_FRAME_COUNT,
              width: clampedWidth,
              height: clampedHeight,
              jpegOptions: {
                quality: LOOK_JPEG_QUALITY,
                progressive: false
              }
            });
            if (client === false) {
              fail(new Error(`prismarine-viewer does not support Minecraft version '${bot.version ?? "unknown"}'.`));
              return;
            }
            viewerClient = client;
          } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)));
          }
        });
      });

      const capture: LookCapture = {
        mediaType: "image/jpeg",
        dataBase64: finalFrame.toString("base64"),
        width: clampedWidth,
        height: clampedHeight,
        capturedAt: new Date().toISOString(),
        viewpoint: {
          position: toPosition(bot.entity.position),
          yaw: roundAngle(bot.entity.yaw),
          pitch: roundAngle(bot.entity.pitch)
        }
      };

      log("info", "Captured rendered minecraft scene", {
        width: capture.width,
        height: capture.height,
        viewDistance: clampedViewDistance,
        bytes: finalFrame.length
      });

      this.appendEvent({
        type: "rendered_look",
        timestamp: capture.capturedAt,
        summary: `captured rendered glance ${capture.width}x${capture.height} (${finalFrame.length} bytes)`,
        width: capture.width,
        height: capture.height,
        viewDistance: clampedViewDistance,
        bytes: finalFrame.length
      });

      return capture;
    } finally {
      const removedListeners = removeListenersAddedSince(bot, listenerSnapshot);
      if (removedListeners > 0) {
        log("info", "minecraft_look cleaned up viewer listeners", { removed: removedListeners });
      }
      this.lookInFlight = false;
    }
  }

  async chat(message: string): Promise<{ ok: true; message: string }> {
    const bot = this.ensureBot();
    const normalized = message.trim();
    if (!normalized) {
      throw new Error("message is required");
    }

    bot.chat(normalized);
    this.currentTask = "chatting";
    this.appendEvent({
      type: "chat",
      timestamp: new Date().toISOString(),
      summary: `sent chat: ${normalized}`,
      sender: bot.username,
      message: normalized,
      isBot: true
    });
    this.currentTask = "idle";
    return { ok: true, message: normalized };
  }

  async goTo(x: number, y: number, z: number, range = 1): Promise<{ ok: true; target: Position; range: number }> {
    const bot = this.ensureBot();
    this.clearModes();
    this.navigationState = { x, y, z, range };
    this.currentTask = `moving to ${x},${y},${z}`;
    bot.pathfinder.setGoal(new goals.GoalNear(x, y, z, range), false);
    this.appendEvent({
      type: "navigation",
      timestamp: new Date().toISOString(),
      summary: `pathfinding to ${x},${y},${z} (range=${range})`,
      x,
      y,
      z,
      range
    });
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
    this.navigationState = null;
    this.followState = {
      playerName,
      distance
    };
    this.currentTask = `following ${playerName}`;
    bot.pathfinder.setGoal(new goals.GoalFollow(player.entity, distance), true);
    this.appendEvent({
      type: "follow",
      timestamp: new Date().toISOString(),
      summary: `following ${playerName} (distance=${distance})`,
      playerName,
      distance
    });
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
    this.navigationState = null;
    this.guardState = {
      playerName,
      radius,
      followDistance
    };
    this.currentTask = `guarding ${playerName}`;
    this.appendEvent({
      type: "guard",
      timestamp: new Date().toISOString(),
      summary: `guarding ${playerName} (radius=${radius}, followDistance=${followDistance})`,
      playerName,
      radius,
      followDistance
    });
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
    this.appendEvent({
      type: "system",
      timestamp: new Date().toISOString(),
      summary: "stopped current autonomous action"
    });
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
    this.appendEvent({
      type: "combat",
      timestamp: new Date().toISOString(),
      summary: `attacking ${describeEntity(hostile)}`,
      combatKind: "attack",
      target: describeEntity(hostile),
      source: bot.username
    });
    return {
      ok: true,
      target: describeEntity(hostile)
    };
  }

  // ── Phase 6: Reflex completion ─────────────────────────────────────────────

  async equipOffhand(itemName: string): Promise<{ ok: true; itemName: string }> {
    const bot = this.ensureBot();
    const normalized = normalizeBlockName(itemName);
    const item = bot.inventory.items().find((candidate) => candidate.name === normalized);
    if (!item) {
      throw new Error(`Item '${normalized}' is not in inventory.`);
    }
    try {
      await bot.equip(item, "off-hand");
    } catch (error) {
      throw new Error(`Failed to equip '${normalized}' to off-hand: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.appendEvent({
      type: "system",
      timestamp: new Date().toISOString(),
      summary: `equipped ${normalized} to off-hand`
    });
    return { ok: true, itemName: normalized };
  }

  async unequipOffhand(): Promise<{ ok: true }> {
    const bot = this.ensureBot();
    try {
      await bot.unequip("off-hand");
    } catch (error) {
      throw new Error(`Failed to unequip off-hand: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.appendEvent({
      type: "system",
      timestamp: new Date().toISOString(),
      summary: "unequipped off-hand"
    });
    return { ok: true };
  }

  async eatBestFood(): Promise<{ ok: true; foodName: string; foodBefore: number | null; foodAfter: number | null }> {
    const bot = this.ensureBot();
    const foodsByName = bot.registry.foodsByName ?? {};
    const foods = bot.registry.foods ?? {};
    const isFoodName = (name: string): FoodLike | undefined => {
      const direct = foodsByName[name];
      if (direct) return direct;
      for (const food of Object.values(foods)) {
        if (food?.name === name) return food;
      }
      return undefined;
    };

    const candidates = bot.inventory
      .items()
      .map((item) => {
        const foodData = isFoodName(item.name);
        if (!foodData) return null;
        const score = (foodData.foodPoints ?? 0) + (foodData.saturation ?? 0) * 2;
        return { item, foodData, score };
      })
      .filter((entry): entry is { item: ItemLike; foodData: FoodLike; score: number } => Boolean(entry))
      .sort((left, right) => right.score - left.score);

    const chosen = candidates[0];
    if (!chosen) {
      throw new Error("No food items in inventory.");
    }
    const foodBefore = typeof bot.food === "number" ? bot.food : null;
    try {
      await bot.equip(chosen.item, "hand");
      await bot.consume();
    } catch (error) {
      throw new Error(`Failed to eat ${chosen.item.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const foodAfter = typeof bot.food === "number" ? bot.food : null;
    this.appendEvent({
      type: "system",
      timestamp: new Date().toISOString(),
      summary: `ate ${chosen.item.name} (food ${foodBefore ?? "?"} -> ${foodAfter ?? "?"})`,
      detail: chosen.item.name
    });
    return {
      ok: true,
      foodName: chosen.item.name,
      foodBefore,
      foodAfter
    };
  }

  async jump(): Promise<{ ok: true }> {
    const bot = this.ensureBot();
    bot.setControlState("jump", true);
    setTimeout(() => {
      try {
        bot.setControlState("jump", false);
      } catch {
        // ignore
      }
    }, 400);
    return { ok: true };
  }

  async repath(): Promise<{ ok: true; mode: string }> {
    const bot = this.ensureBot();
    if (this.followState) {
      const player = bot.players[this.followState.playerName];
      if (player?.entity) {
        bot.pathfinder.setGoal(null);
        bot.pathfinder.setGoal(new goals.GoalFollow(player.entity, this.followState.distance), true);
        return { ok: true, mode: "follow" };
      }
    }
    if (this.guardState) {
      const player = bot.players[this.guardState.playerName];
      if (player?.entity) {
        bot.pathfinder.setGoal(null);
        bot.pathfinder.setGoal(new goals.GoalFollow(player.entity, this.guardState.followDistance), true);
        return { ok: true, mode: "guard" };
      }
    }
    if (this.navigationState) {
      bot.pathfinder.setGoal(null);
      bot.pathfinder.setGoal(
        new goals.GoalNear(
          this.navigationState.x,
          this.navigationState.y,
          this.navigationState.z,
          this.navigationState.range
        ),
        false
      );
      return { ok: true, mode: "navigate" };
    }
    bot.pathfinder.setGoal(null);
    return { ok: true, mode: "none" };
  }

  async fleeToward(x: number, y: number, z: number, range = 2): Promise<{ ok: true; target: Position; range: number }> {
    const bot = this.ensureBot();
    this.clearModes();
    this.navigationState = { x, y, z, range };
    this.currentTask = `fleeing toward ${x},${y},${z}`;
    bot.pathfinder.setGoal(new goals.GoalNear(x, y, z, range), false);
    this.appendEvent({
      type: "navigation",
      timestamp: new Date().toISOString(),
      summary: `fleeing toward ${x},${y},${z} (range=${range})`,
      x,
      y,
      z,
      range
    });
    return {
      ok: true,
      target: { x, y, z },
      range
    };
  }

  async lookAtPlayer(playerName: string): Promise<{ ok: true; playerName: string }> {
    const bot = this.ensureBot();
    const player = this.requirePlayer(playerName);
    if (!player.entity) {
      throw new Error(`Player '${playerName}' is not currently visible to the bot.`);
    }

    await bot.lookAt(player.entity.position, true);
    this.appendEvent({
      type: "look_at",
      timestamp: new Date().toISOString(),
      summary: `looking at ${playerName}`,
      playerName
    });
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
    this.appendEvent({
      type: "block_break",
      timestamp: new Date().toISOString(),
      summary: `broke ${attempted} block(s) of ${normalizedBlockName}`,
      blockName: normalizedBlockName,
      count: attempted
    });
    this.appendEvent({
      type: "item_pickup",
      timestamp: new Date().toISOString(),
      summary: `collected ${attempted} block(s) of ${normalizedBlockName}`,
      itemName: normalizedBlockName,
      count: attempted
    });
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

  // ── Phase 7.1: Crafting ────────────────────────────────────────────────────

  async craftItem(
    recipeName: string,
    count: number,
    useCraftingTable: boolean
  ): Promise<{ ok: true; recipeName: string; crafted: number; requested: number }> {
    const bot = this.ensureBot();
    const normalizedName = normalizeBlockName(recipeName);
    const itemEntry = bot.registry.itemsByName[normalizedName];
    if (!itemEntry) {
      throw new Error(`Unknown item '${recipeName}'. Use canonical Minecraft item ids.`);
    }

    let craftingTableBlock: BlockLike | null = null;
    if (useCraftingTable) {
      craftingTableBlock = this.findNearbyCraftingTableInternal(5) ?? null;
      if (!craftingTableBlock) {
        throw new Error("No crafting table found within 5 blocks.");
      }
    }

    const desiredCount = clampPositiveInteger(count, 1);
    const recipes = bot.recipesFor(itemEntry.id, null, 1, craftingTableBlock ?? (useCraftingTable ? true : false));
    if (!recipes || recipes.length === 0) {
      const allRecipes = bot.recipesAll(itemEntry.id, null, craftingTableBlock ?? (useCraftingTable ? true : false));
      if (allRecipes && allRecipes.length > 0) {
        throw new Error(`Missing ingredients to craft '${normalizedName}'.`);
      }
      throw new Error(`No recipe known for '${normalizedName}'${useCraftingTable ? " at this crafting table" : ""}.`);
    }

    const chosen = recipes[0];
    if (!chosen) {
      throw new Error(`No recipe known for '${normalizedName}'.`);
    }
    const perCraft = chosen.result?.count ?? 1;
    const iterations = Math.max(1, Math.ceil(desiredCount / Math.max(1, perCraft)));

    this.currentTask = `crafting ${desiredCount}x ${normalizedName}`;
    try {
      await bot.craft(chosen, iterations, craftingTableBlock);
    } catch (error) {
      this.currentTask = "idle";
      throw new Error(`Craft failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.currentTask = "idle";

    const crafted = iterations * perCraft;
    this.appendEvent({
      type: "item_pickup",
      timestamp: new Date().toISOString(),
      summary: `crafted ${crafted}x ${normalizedName}`,
      itemName: normalizedName,
      count: crafted
    });

    return {
      ok: true,
      recipeName: normalizedName,
      crafted,
      requested: desiredCount
    };
  }

  checkRecipe(
    recipeName: string,
    useCraftingTable: boolean
  ): { ok: true; recipeName: string; canCraft: boolean; known: boolean; missingIngredients: string[] } {
    const bot = this.ensureBot();
    const normalizedName = normalizeBlockName(recipeName);
    const itemEntry = bot.registry.itemsByName[normalizedName];
    if (!itemEntry) {
      return {
        ok: true,
        recipeName: normalizedName,
        canCraft: false,
        known: false,
        missingIngredients: []
      };
    }

    const craftingSource: BlockLike | boolean | null = useCraftingTable
      ? this.findNearbyCraftingTableInternal(5) ?? true
      : false;

    const craftable = bot.recipesFor(itemEntry.id, null, 1, craftingSource);
    if (craftable && craftable.length > 0) {
      return {
        ok: true,
        recipeName: normalizedName,
        canCraft: true,
        known: true,
        missingIngredients: []
      };
    }

    const allRecipes = bot.recipesAll(itemEntry.id, null, craftingSource);
    const known = Boolean(allRecipes && allRecipes.length > 0);
    const missingIngredients: string[] = [];
    if (known && allRecipes[0]) {
      const delta = allRecipes[0].delta ?? [];
      const itemsArray = bot.registry.itemsArray;
      for (const entry of delta) {
        if (entry.count >= 0) continue;
        const needed = Math.abs(entry.count);
        const resolved = itemsArray?.find((row) => row.id === entry.id);
        const name = resolved?.name ?? `id_${entry.id}`;
        const have = this.countInventoryItem(name);
        if (have < needed) {
          missingIngredients.push(`${name} (need ${needed}, have ${have})`);
        }
      }
    }

    return {
      ok: true,
      recipeName: normalizedName,
      canCraft: false,
      known,
      missingIngredients
    };
  }

  findCraftingTable(maxDistance: number): { ok: true; found: boolean; position: Position | null; distance: number | null } {
    this.ensureBot();
    const block = this.findNearbyCraftingTableInternal(maxDistance);
    if (!block) {
      return { ok: true, found: false, position: null, distance: null };
    }
    const selfPos = this.bot!.entity.position;
    return {
      ok: true,
      found: true,
      position: toPosition(block.position),
      distance: roundDistance(distanceBetween(selfPos, block.position))
    };
  }

  // ── Phase 7.2: Chest workflows ─────────────────────────────────────────────

  async depositToChest(
    chestX: number,
    chestY: number,
    chestZ: number,
    items: Array<{ name: string; count: number }>
  ): Promise<{ ok: true; chest: Position; deposited: Array<{ name: string; count: number }>; skipped: Array<{ name: string; reason: string }> }> {
    const bot = this.ensureBot();
    const chestBlock = bot.blockAt(new Vec3(chestX, chestY, chestZ));
    if (!chestBlock || !this.isChestBlock(chestBlock)) {
      throw new Error(`No chest at ${chestX},${chestY},${chestZ}.`);
    }
    const distance = distanceBetween(bot.entity.position, chestBlock.position);
    if (distance > 6) {
      throw new Error(`Chest at ${chestX},${chestY},${chestZ} is ${distance.toFixed(1)} blocks away (max 6).`);
    }

    const window = await bot.openContainer(chestBlock);
    const deposited: Array<{ name: string; count: number }> = [];
    const skipped: Array<{ name: string; reason: string }> = [];
    try {
      for (const request of items) {
        const normalized = normalizeBlockName(request.name);
        const wanted = clampPositiveInteger(request.count, 1);
        const entry = bot.registry.itemsByName[normalized];
        if (!entry) {
          skipped.push({ name: normalized, reason: "unknown item" });
          continue;
        }
        const available = this.countInventoryItem(normalized);
        if (available <= 0) {
          skipped.push({ name: normalized, reason: "not in inventory" });
          continue;
        }
        const moveCount = Math.min(wanted, available);
        try {
          await window.deposit(entry.id, null, moveCount);
          deposited.push({ name: normalized, count: moveCount });
        } catch (error) {
          skipped.push({ name: normalized, reason: error instanceof Error ? error.message : String(error) });
        }
      }
    } finally {
      try {
        window.close();
      } catch {
        // ignore
      }
    }

    this.appendEvent({
      type: "system",
      timestamp: new Date().toISOString(),
      summary: `deposited ${deposited.length} stack(s) to chest at ${chestX},${chestY},${chestZ}`,
      detail: deposited.map((entry) => `${entry.count}x ${entry.name}`).join(", ")
    });

    return {
      ok: true,
      chest: { x: chestX, y: chestY, z: chestZ },
      deposited,
      skipped
    };
  }

  async withdrawFromChest(
    chestX: number,
    chestY: number,
    chestZ: number,
    items: Array<{ name: string; count: number }>
  ): Promise<{ ok: true; chest: Position; withdrawn: Array<{ name: string; count: number }>; skipped: Array<{ name: string; reason: string }> }> {
    const bot = this.ensureBot();
    const chestBlock = bot.blockAt(new Vec3(chestX, chestY, chestZ));
    if (!chestBlock || !this.isChestBlock(chestBlock)) {
      throw new Error(`No chest at ${chestX},${chestY},${chestZ}.`);
    }
    const distance = distanceBetween(bot.entity.position, chestBlock.position);
    if (distance > 6) {
      throw new Error(`Chest at ${chestX},${chestY},${chestZ} is ${distance.toFixed(1)} blocks away (max 6).`);
    }

    const window = await bot.openContainer(chestBlock);
    const withdrawn: Array<{ name: string; count: number }> = [];
    const skipped: Array<{ name: string; reason: string }> = [];
    try {
      for (const request of items) {
        const normalized = normalizeBlockName(request.name);
        const wanted = clampPositiveInteger(request.count, 1);
        const entry = bot.registry.itemsByName[normalized];
        if (!entry) {
          skipped.push({ name: normalized, reason: "unknown item" });
          continue;
        }
        const chestItems = window.containerItems();
        const have = chestItems
          .filter((item) => item.name === normalized)
          .reduce((sum, item) => sum + item.count, 0);
        if (have <= 0) {
          skipped.push({ name: normalized, reason: "not in chest" });
          continue;
        }
        const moveCount = Math.min(wanted, have);
        try {
          await window.withdraw(entry.id, null, moveCount);
          withdrawn.push({ name: normalized, count: moveCount });
        } catch (error) {
          skipped.push({ name: normalized, reason: error instanceof Error ? error.message : String(error) });
        }
      }
    } finally {
      try {
        window.close();
      } catch {
        // ignore
      }
    }

    this.appendEvent({
      type: "system",
      timestamp: new Date().toISOString(),
      summary: `withdrew ${withdrawn.length} stack(s) from chest at ${chestX},${chestY},${chestZ}`,
      detail: withdrawn.map((entry) => `${entry.count}x ${entry.name}`).join(", ")
    });

    return {
      ok: true,
      chest: { x: chestX, y: chestY, z: chestZ },
      withdrawn,
      skipped
    };
  }

  findNearbyChests(
    maxDistance: number,
    maxChests: number
  ): { ok: true; chests: Array<{ position: Position; distance: number }> } {
    const bot = this.ensureBot();
    const clampedMax = Math.max(2, Math.min(64, clampPositiveInteger(maxDistance, 16)));
    const clampedCount = Math.max(1, Math.min(16, clampPositiveInteger(maxChests, 8)));
    const chestNames = ["chest", "trapped_chest", "ender_chest", "barrel"];
    const chestIds: number[] = [];
    for (const name of chestNames) {
      const entry = bot.registry.blocksByName[name];
      if (entry) chestIds.push(entry.id);
    }
    if (chestIds.length === 0) {
      return { ok: true, chests: [] };
    }
    const positions = bot.findBlocks({
      matching: chestIds,
      maxDistance: clampedMax,
      count: clampedCount
    });
    const origin = bot.entity.position;
    return {
      ok: true,
      chests: positions.map((pos) => ({
        position: { x: pos.x, y: pos.y, z: pos.z },
        distance: roundDistance(distanceBetween(origin, pos))
      }))
    };
  }

  // ── Phase 7.3: Block placement ─────────────────────────────────────────────

  async placeBlockAt(
    x: number,
    y: number,
    z: number,
    blockName: string
  ): Promise<{ ok: true; placed: boolean; position: Position; blockName: string }> {
    const bot = this.ensureBot();
    const normalized = normalizeBlockName(blockName);
    const itemEntry = bot.registry.itemsByName[normalized];
    if (!itemEntry) {
      throw new Error(`Unknown block '${blockName}'. Use canonical Minecraft block ids.`);
    }
    const item = bot.inventory.items().find((candidate) => candidate.name === normalized);
    if (!item) {
      throw new Error(`No '${normalized}' in inventory to place.`);
    }

    const target = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));
    const existing = bot.blockAt(target);
    if (existing && !isAirBlockName(existing.name)) {
      throw new Error(`Target ${x},${y},${z} is already occupied by '${existing.name}'.`);
    }

    // Find a solid face to place against.
    const faces: Array<{ offset: Vec3; face: Vec3 }> = [
      { offset: new Vec3(0, -1, 0), face: new Vec3(0, 1, 0) },
      { offset: new Vec3(0, 1, 0), face: new Vec3(0, -1, 0) },
      { offset: new Vec3(-1, 0, 0), face: new Vec3(1, 0, 0) },
      { offset: new Vec3(1, 0, 0), face: new Vec3(-1, 0, 0) },
      { offset: new Vec3(0, 0, -1), face: new Vec3(0, 0, 1) },
      { offset: new Vec3(0, 0, 1), face: new Vec3(0, 0, -1) }
    ];
    let referenceBlock: BlockLike | null = null;
    let faceVector: Vec3 | null = null;
    for (const candidate of faces) {
      const refPos = new Vec3(
        target.x + candidate.offset.x,
        target.y + candidate.offset.y,
        target.z + candidate.offset.z
      );
      const refBlock = bot.blockAt(refPos);
      if (refBlock && !isAirBlockName(refBlock.name) && !this.isChestBlock(refBlock)) {
        referenceBlock = refBlock;
        faceVector = candidate.face;
        break;
      }
    }

    if (!referenceBlock || !faceVector) {
      throw new Error(`Cannot place at ${x},${y},${z} — no adjacent solid block to place against.`);
    }

    const distance = distanceBetween(bot.entity.position, target);
    if (distance > 5) {
      throw new Error(`Target ${x},${y},${z} is ${distance.toFixed(1)} blocks away (max 5).`);
    }

    try {
      await bot.equip(item, "hand");
      await bot.placeBlock(referenceBlock, faceVector);
    } catch (error) {
      throw new Error(`Placement failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    this.appendEvent({
      type: "system",
      timestamp: new Date().toISOString(),
      summary: `placed ${normalized} at ${x},${y},${z}`,
      detail: normalized
    });

    return {
      ok: true,
      placed: true,
      position: { x: target.x, y: target.y, z: target.z },
      blockName: normalized
    };
  }

  async digBlockAt(
    x: number,
    y: number,
    z: number
  ): Promise<{ ok: true; dug: boolean; position: Position; blockName: string }> {
    const bot = this.ensureBot();
    const target = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));
    const block = bot.blockAt(target);
    if (!block || isAirBlockName(block.name)) {
      throw new Error(`No block to dig at ${x},${y},${z}.`);
    }
    const distance = distanceBetween(bot.entity.position, target);
    if (distance > 5) {
      throw new Error(`Target ${x},${y},${z} is ${distance.toFixed(1)} blocks away (max 5).`);
    }
    try {
      await bot.tool.equipForBlock(block, { requireHarvest: false });
      await bot.dig(block);
    } catch (error) {
      throw new Error(`Dig failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.appendEvent({
      type: "block_break",
      timestamp: new Date().toISOString(),
      summary: `dug ${block.name} at ${x},${y},${z}`,
      blockName: block.name,
      count: 1
    });
    return {
      ok: true,
      dug: true,
      position: { x: target.x, y: target.y, z: target.z },
      blockName: block.name
    };
  }

  private findNearbyCraftingTableInternal(maxDistance: number): BlockLike | null {
    const bot = this.bot;
    if (!bot) return null;
    const entry = bot.registry.blocksByName["crafting_table"];
    if (!entry) return null;
    const clampedMax = Math.max(2, Math.min(32, clampPositiveInteger(maxDistance, 5)));
    const positions = bot.findBlocks({ matching: entry.id, maxDistance: clampedMax, count: 1 });
    const chosen = positions[0];
    if (!chosen) return null;
    return bot.blockAt(chosen);
  }

  private isChestBlock(block: BlockLike): boolean {
    const name = String(block.name || "").toLowerCase();
    return name === "chest" || name === "trapped_chest" || name === "ender_chest" || name === "barrel";
  }

  private attachListeners(bot: MinecraftBotLike): void {
    bot.on("login", () => {
      this.appendEvent({
        type: "server",
        timestamp: new Date().toISOString(),
        summary: "logged in",
        serverEvent: "logged_in"
      });
    });

    bot.on("spawn", () => {
      this.appendEvent({
        type: "server",
        timestamp: new Date().toISOString(),
        summary: "spawn",
        serverEvent: "spawn"
      });
    });

    bot.on("end", () => {
      this.appendEvent({
        type: "server",
        timestamp: new Date().toISOString(),
        summary: "connection ended",
        serverEvent: "connection_ended"
      });
      this.currentTask = "disconnected";
      this.bot = null;
      this.followState = null;
      this.guardState = null;
      this.movements = null;
    });

    bot.on("kicked", (reason) => {
      this.appendEvent({
        type: "server",
        timestamp: new Date().toISOString(),
        summary: `kicked: ${String(reason)}`,
        serverEvent: "kicked",
        detail: String(reason)
      });
    });

    bot.on("error", (error) => {
      this.appendEvent({
        type: "server",
        timestamp: new Date().toISOString(),
        summary: `error: ${error instanceof Error ? error.message : String(error)}`,
        serverEvent: "error",
        detail: error instanceof Error ? error.message : String(error)
      });
    });

    bot.on("death", () => {
      this.appendEvent({
        type: "death",
        timestamp: new Date().toISOString(),
        summary: "death"
      });
    });

    bot.on("chat", (username, message) => {
      if (typeof username === "string" && typeof message === "string") {
        this.appendEvent({
          type: "chat",
          timestamp: new Date().toISOString(),
          summary: `chat<${username}> ${message}`,
          sender: username,
          message,
          isBot: username === bot.username
        });
      }
    });

    bot.on("playerJoined", (player) => {
      const username = String((player as PlayerLike | undefined)?.username || "").trim();
      if (!username || username === bot.username) return;
      this.appendEvent({
        type: "player_join",
        timestamp: new Date().toISOString(),
        summary: `player joined: ${username}`,
        playerName: username
      });
    });

    bot.on("playerLeft", (player) => {
      const username = String((player as PlayerLike | undefined)?.username || "").trim();
      if (!username || username === bot.username) return;
      this.appendEvent({
        type: "player_leave",
        timestamp: new Date().toISOString(),
        summary: `player left: ${username}`,
        playerName: username
      });
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
      this.appendEvent({
        type: "system",
        timestamp: new Date().toISOString(),
        summary: `guard target '${state.playerName}' not visible`
      });
      return;
    }

    const hostile = bot.nearestEntity((entity) => {
      if (!this.isHostileMob(entity)) return false;
      return distanceBetween(entity.position, friend.position) <= state.radius;
    });

    if (hostile) {
      if (bot.pvp.target?.id !== hostile.id) {
        bot.pvp.attack(hostile);
        this.appendEvent({
          type: "combat",
          timestamp: new Date().toISOString(),
          summary: `guard engaging ${describeEntity(hostile)} near ${state.playerName}`,
          combatKind: "guard_engage",
          target: describeEntity(hostile),
          source: state.playerName
        });
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

  private listEquipmentInternal(): EquipmentSnapshot {
    const bot = this.bot;
    if (!bot) {
      return {
        hand: null,
        offhand: null,
        helmet: null,
        chestplate: null,
        leggings: null,
        boots: null
      };
    }
    // Minecraft inventory slot constants:
    //   5 = helmet, 6 = chestplate, 7 = leggings, 8 = boots, 45 = offhand
    const slots = bot.inventory.slots || [];
    const slotName = (index: number): string | null => {
      const item = slots[index];
      return item ? item.name : null;
    };
    return {
      hand: bot.heldItem ? bot.heldItem.name : null,
      offhand: slotName(45),
      helmet: slotName(5),
      chestplate: slotName(6),
      leggings: slotName(7),
      boots: slotName(8)
    };
  }

  private listHazardsInternal(maxDistance = DEFAULT_HAZARD_DISTANCE): Array<{
    type: string;
    distance: number;
    position: Position;
  }> {
    const bot = this.ensureBot();
    const selfPosition = bot.entity.position;

    return Object.values(bot.entities)
      .filter((entity) => this.isHostileMob(entity))
      .map((entity) => ({
        type: String(entity.name ?? entity.displayName ?? entity.type ?? "hostile"),
        distance: Number(distanceBetween(selfPosition, entity.position).toFixed(2)),
        position: toPosition(entity.position)
      }))
      .filter((entity) => entity.distance <= maxDistance)
      .sort((left, right) => left.distance - right.distance)
      .slice(0, 8);
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
    this.navigationState = null;
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

  private appendEvent(event: MinecraftGameEvent | string): void {
    const normalizedEvent = typeof event === "string"
      ? {
          type: "system" as const,
          timestamp: new Date().toISOString(),
          summary: event
        }
      : event;
    this.recentEvents.push(normalizedEvent);
    if (this.recentEvents.length > MAX_EVENT_LOG) {
      this.recentEvents = this.recentEvents.slice(-MAX_EVENT_LOG);
    }
    log("info", "minecraft-event", normalizedEvent);
  }

  private ensureBot(): MinecraftBotLike {
    if (!this.bot) {
      throw new Error("Bot is not connected. Use minecraft_connect first.");
    }
    return this.bot;
  }
}
