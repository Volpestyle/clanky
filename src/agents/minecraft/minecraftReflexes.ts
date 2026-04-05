/**
 * Deterministic reflex evaluation for the Minecraft agent.
 *
 * Reflexes are fast, hard-wired survival reactions evaluated against a
 * WorldSnapshot.  They run independently of the planner loop and preempt
 * active skills when triggered.
 *
 * Reflexes are infrastructure/safety, not personality. They fire on
 * threshold-triggered conditions (low food, low health + nearby hazard,
 * stuck while pathfinding) and execute deterministic recovery actions
 * (eat the best food, flee to a computed safe vector, equip shield, jump
 * + repath when stuck). All creative and conversational decisions remain
 * with the brain.
 */

import type { MinecraftConstraints, ReflexAction, SelfSnapshot, WorldSnapshot, Position } from "./types.ts";
import type { MinecraftRuntime } from "./minecraftRuntime.ts";

// ── Thresholds ──────────────────────────────────────────────────────────────

const LOW_HEALTH_THRESHOLD = 6;
const LOW_FOOD_THRESHOLD = 6;
const HAZARD_FLEE_DISTANCE = 6;
const HAZARD_ATTACK_DISTANCE = 4;
const FLEE_VECTOR_DISTANCE = 8;
const SHIELD_EQUIP_HEALTH_THRESHOLD = 14;

// ── Shield/offhand gear detection ───────────────────────────────────────────

const SHIELD_ITEMS = new Set(["shield"]);

function hasShieldInInventory(self: SelfSnapshot): boolean {
  return self.inventorySummary.some((entry) => SHIELD_ITEMS.has(entry.name));
}

function shieldAlreadyEquipped(self: SelfSnapshot): boolean {
  const offhand = self.equipment.offhand;
  return Boolean(offhand && SHIELD_ITEMS.has(offhand));
}

function computeFleeVector(from: Position, selfPosition: Position): Position {
  const dx = selfPosition.x - from.x;
  const dz = selfPosition.z - from.z;
  const magnitude = Math.sqrt(dx * dx + dz * dz);
  if (magnitude < 0.01) {
    // Hazard is on top of us; pick an arbitrary east vector.
    return {
      x: Math.round(selfPosition.x + FLEE_VECTOR_DISTANCE),
      y: Math.round(selfPosition.y),
      z: Math.round(selfPosition.z)
    };
  }
  const ux = dx / magnitude;
  const uz = dz / magnitude;
  return {
    x: Math.round(selfPosition.x + ux * FLEE_VECTOR_DISTANCE),
    y: Math.round(selfPosition.y),
    z: Math.round(selfPosition.z + uz * FLEE_VECTOR_DISTANCE)
  };
}

// ── Evaluate ────────────────────────────────────────────────────────────────

/**
 * Evaluate the current world state and return the highest-priority reflex
 * action.  Returns `{ type: "none" }` when no reflex should fire.
 *
 * Priority order:
 *   1. Eat when food is critically low
 *   2. Flee from adjacent hazards when health is critically low
 *   3. Equip shield when health is trending down and hazards are nearby
 *   4. Attack when a hazard is extremely close and combat is allowed
 */
export function evaluateReflexes(
  snapshot: WorldSnapshot,
  constraints: MinecraftConstraints = {}
): ReflexAction {
  if (!snapshot.connected || !snapshot.self) {
    return { type: "none" };
  }

  const self = snapshot.self;

  // 1. Eat when food is critically low (survival priority).
  if (self.food <= LOW_FOOD_THRESHOLD && self.gameMode === "survival") {
    return { type: "eat" };
  }

  // 2. Flee when health is low and hazards are nearby.
  if (self.health <= LOW_HEALTH_THRESHOLD && snapshot.hazards.length > 0) {
    const nearest = snapshot.hazards.reduce(
      (closest, h) => (h.distance < closest.distance ? h : closest),
      snapshot.hazards[0]
    );
    if (nearest && nearest.distance <= HAZARD_FLEE_DISTANCE) {
      const away = computeFleeVector(nearest.position, self.position);
      return { type: "flee", from: nearest.position, away };
    }
  }

  // 3. Equip shield as a precaution when health has dropped and we aren't avoiding combat.
  if (!constraints.avoidCombat
    && self.health <= SHIELD_EQUIP_HEALTH_THRESHOLD
    && snapshot.hazards.length > 0
    && snapshot.hazards.some((hazard) => hazard.distance <= HAZARD_FLEE_DISTANCE * 1.5)
    && hasShieldInInventory(self)
    && !shieldAlreadyEquipped(self)) {
    return { type: "equip_shield" };
  }

  // 4. Attack if a hazard is extremely close and we're not avoiding combat.
  if (!constraints.avoidCombat && snapshot.hazards.length > 0) {
    const nearest = snapshot.hazards[0];
    if (nearest && nearest.distance <= HAZARD_ATTACK_DISTANCE) {
      return { type: "attack", target: nearest.type };
    }
  }

  return { type: "none" };
}

// ── Execute ─────────────────────────────────────────────────────────────────

/**
 * Dispatch a reflex action against the MCP server.
 *
 * This is intentionally fire-and-forget — reflex failures are logged but
 * never propagated to the planner.
 */
export async function executeReflex(
  runtime: MinecraftRuntime,
  action: ReflexAction
): Promise<void> {
  switch (action.type) {
    case "attack":
      await runtime.attackNearestHostile(HAZARD_ATTACK_DISTANCE);
      break;
    case "eat":
      // Eat the highest-value food in inventory. Falls back silently if
      // there's no food — the brain will still see low-food in planner state.
      try {
        await runtime.eatBestFood();
      } catch {
        // No food available; swallow and let the planner react.
      }
      break;
    case "flee":
      // Move away from the hazard along the computed flee vector.
      try {
        await runtime.fleeToward(action.away.x, action.away.y, action.away.z, 2);
      } catch {
        // Fall back to stopping current activity.
        await runtime.stop().catch(() => {});
      }
      break;
    case "equip_shield":
      try {
        await runtime.equipOffhand("shield");
      } catch {
        // Shield unavailable or slot locked; swallow.
      }
      break;
    case "unstick":
      // Jump to clear a small obstacle, then re-assert the current goal.
      try {
        await runtime.jump();
        await runtime.repath();
      } catch {
        // Best-effort recovery only.
      }
      break;
    case "none":
      break;
  }
}

// ── Stuck detection ─────────────────────────────────────────────────────────

const STUCK_POSITION_DELTA_THRESHOLD = 0.25;

function isNavigationTask(taskGoal: string | null | undefined): boolean {
  const normalized = String(taskGoal || "").trim().toLowerCase();
  return normalized.startsWith("moving")
    || normalized.startsWith("following")
    || normalized.startsWith("guarding")
    || normalized.startsWith("fleeing")
    || normalized.startsWith("pathfinding");
}

/**
 * Detect whether the bot is stuck while pathfinding.
 *
 * Returns true when the bot has an active navigation task but has moved
 * less than `STUCK_POSITION_DELTA_THRESHOLD` blocks since the last tick
 * sample. Intended to be called from the session's reflex tick with the
 * previously-sampled position as `previousPosition`.
 */
export function detectStuck(
  snapshot: WorldSnapshot,
  previousPosition: Position | null
): boolean {
  if (!snapshot.connected || !snapshot.self) return false;
  if (!snapshot.task) return false;
  if (!isNavigationTask(snapshot.task.goal)) return false;
  if (!previousPosition) return false;
  const dx = snapshot.self.position.x - previousPosition.x;
  const dy = snapshot.self.position.y - previousPosition.y;
  const dz = snapshot.self.position.z - previousPosition.z;
  const delta = Math.sqrt(dx * dx + dy * dy + dz * dz);
  return delta < STUCK_POSITION_DELTA_THRESHOLD;
}
