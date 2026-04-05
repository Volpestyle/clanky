/**
 * Shared types for the Minecraft agent subsystem.
 *
 * Three-loop architecture:
 *   Reflex loop  → deterministic, fast, survival/locomotion
 *   Skill loop   → durable behaviors with preconditions/recovery
 *   Planner loop → LLM decides at meaningful boundaries only
 */

// ── World model snapshot (what the planner sees) ──

export type Position = { x: number; y: number; z: number };

export type PlayerSnapshot = {
  name: string;
  distance: number;
  position: Position | null;
  visible: boolean;
  health?: number;
};

export type HazardSnapshot = {
  type: string;
  distance: number;
  position: Position;
};

export type SelfSnapshot = {
  position: Position;
  health: number;
  maxHealth: number;
  food: number;
  saturation: number;
  oxygen: number;
  isOnFire: boolean;
  dimension: string;
  gameMode: string;
  equipment: {
    hand: string | null;
    offhand: string | null;
    helmet: string | null;
    chestplate: string | null;
    leggings: string | null;
    boots: string | null;
  };
  inventoryFull: boolean;
  inventorySummary: Array<{ name: string; count: number }>;
};

export type TaskSnapshot = {
  goal: string;
  step: string;
  retries: number;
  startedAt: number;
};

export type MinecraftGameEvent =
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

export type MinecraftVisibleBlock = {
  name: string;
  displayName?: string;
  position: Position;
  relative: Position;
  distance: number;
};

export type MinecraftVisibleEntity = {
  name: string;
  type: string;
  position: Position;
  distance: number;
};

export type MinecraftVisualScene = {
  sampledFrom: Position;
  blocks: MinecraftVisibleBlock[];
  nearbyEntities: MinecraftVisibleEntity[];
  skyVisible: boolean;
  enclosed: boolean;
  notableFeatures: string[];
};

export type MinecraftLookCapture = {
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

export type WorldSnapshot = {
  sessionId: string;
  mode: MinecraftMode;
  connected: boolean;
  self: SelfSnapshot | null;
  player: PlayerSnapshot | null;
  nearbyPlayers: PlayerSnapshot[];
  hazards: HazardSnapshot[];
  task: TaskSnapshot | null;
  recentEvents: MinecraftGameEvent[];
  visualScene: MinecraftVisualScene | null;
  timeOfDay: number | null;
  isRaining: boolean;
  reflexStatus: string;
};

// ── Modes ──

export type MinecraftMode = "companion" | "gather" | "guard" | "idle";

// ── Skill interface ──

export type SkillStatus = "pending" | "running" | "succeeded" | "failed" | "interrupted";

export type SkillResult = {
  status: SkillStatus;
  summary: string;
  retries: number;
};

export type SkillContext = {
  signal: AbortSignal;
  onProgress?: (message: string) => void;
};

export interface MinecraftSkill {
  readonly name: string;
  readonly description: string;

  /** Check if this skill can run right now. */
  checkPreconditions(): { ok: boolean; reason?: string };

  /** Execute the skill. Resolves when done, rejects on unrecoverable failure. */
  execute(context: SkillContext): Promise<SkillResult>;

  /** Interrupt a running skill (e.g. hard interrupt from reflexes). */
  interrupt(reason: string): void;

  /** Compact status for the planner snapshot. */
  getStatus(): string;
}

// ── Reflex types ──

export type ReflexAction =
  | { type: "eat" }
  | { type: "flee"; from: Position; away: Position }
  | { type: "attack"; target: string }
  | { type: "unstick" }
  | { type: "equip_shield" }
  | { type: "none" };

// ── Session constraints (from the planner) ──

export type MinecraftAllowedChest = {
  label?: string;
  x: number;
  y: number;
  z: number;
};

export type MinecraftConstraints = {
  /**
   * MC username to stay close to (paired with `maxDistance`).
   *
   * Explicit player name rather than a boolean so the brain decides WHO the
   * leash applies to per turn. Cleared by omission (undefined = no leash).
   */
  stayNearPlayer?: string;
  maxDistance?: number;
  avoidCombat?: boolean;
  allowedChests?: MinecraftAllowedChest[];
};

/**
 * A Discord↔Minecraft identity bridge entry the operator has configured.
 *
 * These are context for the brain, not permission gates. Clanky can still
 * interact with any player by name; these entries just let the brain resolve
 * "Volpe said follow me in voice" to a specific MC username, carry social
 * context (relationship, notes), and prefer known people as primary focus.
 *
 * The operator is just one entry in this list, typically with
 * `relationship: "operator"`. There is no privileged single-operator slot.
 */
export type MinecraftPlayerIdentity = {
  /** Required: the player's in-game MC username. */
  mcUsername: string;
  /** Optional: Discord display name used in channel/voice context. */
  discordUsername?: string;
  /** Optional: human-facing label (e.g. "Volpe (owner)"). */
  label?: string;
  /** Optional freeform role, e.g. "operator", "trusted collab", "friend". */
  relationship?: string;
  /** Optional freeform additional context. */
  notes?: string;
};

export type MinecraftServerTarget = {
  label: string | null;
  host: string | null;
  port: number | null;
  description: string | null;
};

export type MinecraftServerCatalogEntry = {
  label: string;
  host: string | null;
  port: number | null;
  description: string | null;
};

export type MinecraftChatMessage = {
  sender: string;
  text: string;
  timestamp: string;
  isBot: boolean;
};

export type MinecraftItemRequest = {
  name: string;
  count: number;
};

export type MinecraftBuildBlockPlacement = {
  x: number;
  y: number;
  z: number;
  blockName: string;
};

export type MinecraftBuildPlan = {
  title: string;
  blocks: MinecraftBuildBlockPlacement[];
  clearFirst?: boolean;
};

export type MinecraftProject = {
  id: string;
  title: string;
  description: string;
  checkpoints: string[];
  completedCheckpoints: string[];
  status: "planning" | "executing" | "paused" | "completed" | "abandoned";
  actionsUsed: number;
  actionBudget: number;
  startedAt: string;
  lastStepAt: string | null;
  lastStepSummary: string | null;
};

export type MinecraftBrainAction =
  | { kind: "wait" }
  | { kind: "connect"; target?: Partial<MinecraftServerTarget> }
  | { kind: "disconnect" }
  | { kind: "status" }
  | { kind: "look" }
  | { kind: "follow"; playerName: string; distance?: number }
  | { kind: "guard"; playerName: string; radius?: number; followDistance?: number }
  | { kind: "collect"; blockName: string; count?: number }
  | { kind: "go_to"; x: number; y: number; z: number }
  | { kind: "return_home" }
  | { kind: "stop" }
  | { kind: "chat"; message: string }
  | { kind: "attack" }
  | { kind: "look_at"; playerName: string }
  | { kind: "eat" }
  | { kind: "equip_offhand"; itemName: string }
  | { kind: "craft"; recipeName: string; count?: number; useCraftingTable?: boolean }
  | { kind: "deposit"; chest: { x: number; y: number; z: number }; items: MinecraftItemRequest[] }
  | { kind: "withdraw"; chest: { x: number; y: number; z: number }; items: MinecraftItemRequest[] }
  | { kind: "place_block"; x: number; y: number; z: number; blockName: string }
  | { kind: "build"; plan?: MinecraftBuildPlan; description?: string; origin?: Position; dimensions?: { width: number; height: number; depth: number } }
  | { kind: "project_start"; title: string; description: string; checkpoints?: string[]; actionBudget?: number }
  | { kind: "project_step"; summary?: string }
  | { kind: "project_pause"; reason?: string }
  | { kind: "project_resume" }
  | { kind: "project_abort"; reason?: string };

export type MinecraftActionFailureReason =
  | "player_not_visible"
  | "path_blocked"
  | "inventory_full"
  | "out_of_range"
  | "constraint_violation"
  | "invalid_target"
  | "not_connected"
  | "rejected_by_server"
  | "missing_ingredients"
  | "no_recipe"
  | "no_crafting_table"
  | "chest_not_allowed"
  | "placement_blocked"
  | "budget_exceeded"
  | "no_active_project"
  | "project_already_active"
  | "project_not_executing"
  | "unknown";

export type MinecraftActionFailure = {
  actionKind: MinecraftBrainAction["kind"];
  reason: MinecraftActionFailureReason;
  message: string;
  didYouMeanPlayerName?: string;
};

export type MinecraftPlannerState = {
  activeGoal: string | null;
  subgoals: string[];
  progress: string[];
  lastInstruction: string | null;
  lastDecisionSummary: string | null;
  lastActionResult: string | null;
  lastActionFailure: MinecraftActionFailure | null;
  pendingInGameMessages: MinecraftChatMessage[];
  activeProject: MinecraftProject | null;
};

// ── minecraft_task tool arguments ──

export type MinecraftTaskAction = "run" | "followup" | "status" | "cancel";

export type MinecraftTaskArgs = {
  action?: MinecraftTaskAction;
  task?: string;
  session_id?: string;
  mode?: MinecraftMode;
  constraints?: MinecraftConstraints;
  server?: Partial<MinecraftServerTarget>;
};
