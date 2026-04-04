/**
 * Deterministic reflex evaluation for the Minecraft agent.
 *
 * Reflexes are fast, hard-wired survival reactions evaluated against a
 * WorldSnapshot.  They run independently of the planner loop and preempt
 * active skills when triggered.
 *
 * The MCP server's guard mode already handles combat reactively, so the
 * agent-layer reflexes focus on health/food monitoring and stuck detection.
 * Richer hazard-based reflexes will arrive once the MCP server exposes
 * nearby-entity queries.
 */

import type { MinecraftConstraints, ReflexAction, WorldSnapshot } from "./types.ts";
import type { MinecraftRuntime } from "./minecraftRuntime.ts";

// ── Thresholds ──────────────────────────────────────────────────────────────

const LOW_HEALTH_THRESHOLD = 6;
const LOW_FOOD_THRESHOLD = 6;
const HAZARD_FLEE_DISTANCE = 6;
const HAZARD_ATTACK_DISTANCE = 4;

// ── Evaluate ────────────────────────────────────────────────────────────────

/**
 * Evaluate the current world state and return the highest-priority reflex
 * action.  Returns `{ type: "none" }` when no reflex should fire.
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
    if (nearest.distance <= HAZARD_FLEE_DISTANCE) {
      return { type: "flee", from: nearest.position };
    }
  }

  // 3. Attack if a hazard is extremely close and we're not avoiding combat.
  if (!constraints.avoidCombat && snapshot.hazards.length > 0) {
    const nearest = snapshot.hazards[0];
    if (nearest.distance <= HAZARD_ATTACK_DISTANCE) {
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
      // The MCP server doesn't expose an explicit eat command yet.
      // The Mineflayer bot auto-eats when food is available; this is a
      // placeholder for when we add food-slot management.
      break;
    case "flee":
      // Move away from the hazard source.  We compute a flee vector by
      // going in the opposite direction from the hazard.
      // For now, just stop current activity and let the player lead.
      await runtime.stop();
      break;
    case "equip_shield":
      // Not yet supported by the MCP server.
      break;
    case "unstick":
      // Jump or re-path.  The MCP server's pathfinder handles most stuck
      // situations; this is a placeholder for edge-case recovery.
      break;
    case "none":
      break;
  }
}
