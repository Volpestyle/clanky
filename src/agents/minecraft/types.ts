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

export type WorldSnapshot = {
  sessionId: string;
  mode: MinecraftMode;
  connected: boolean;
  self: SelfSnapshot | null;
  player: PlayerSnapshot | null;
  nearbyPlayers: PlayerSnapshot[];
  hazards: HazardSnapshot[];
  task: TaskSnapshot | null;
  recentEvents: string[];
  timeOfDay: number | null;
  isRaining: boolean;
  reflexStatus: string;
};

// ── Modes ──

export type MinecraftMode = "companion" | "gather" | "guard" | "builder" | "idle";

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
  | { type: "flee"; from: Position }
  | { type: "attack"; target: string }
  | { type: "unstick" }
  | { type: "equip_shield" }
  | { type: "none" };

// ── Session constraints (from the planner) ──

export type MinecraftConstraints = {
  stayNearPlayer?: boolean;
  maxDistance?: number;
  avoidCombat?: boolean;
  allowedChests?: string[];
};

// ── minecraft_task tool arguments ──

export type MinecraftTaskAction = "run" | "followup" | "status" | "cancel";

export type MinecraftTaskArgs = {
  action?: MinecraftTaskAction;
  task?: string;
  session_id?: string;
  mode?: MinecraftMode;
  constraints?: MinecraftConstraints;
};
