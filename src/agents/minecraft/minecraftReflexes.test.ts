/**
 * Unit tests for deterministic reflex evaluation.
 *
 * Reflexes are infrastructure-level survival actions, so these tests cover
 * the threshold logic (eat on low food, flee on low health near hazards,
 * equip shield when threatened, stuck detection) rather than LLM behavior.
 */

import { describe, expect, test } from "bun:test";
import { detectStuck, evaluateReflexes } from "./minecraftReflexes.ts";
import type { SelfSnapshot, WorldSnapshot } from "./types.ts";

function makeSelf(partial: Partial<SelfSnapshot> = {}): SelfSnapshot {
  return {
    position: { x: 0, y: 64, z: 0 },
    health: 20,
    maxHealth: 20,
    food: 20,
    saturation: 20,
    oxygen: 20,
    isOnFire: false,
    dimension: "overworld",
    gameMode: "survival",
    equipment: {
      hand: null,
      offhand: null,
      helmet: null,
      chestplate: null,
      leggings: null,
      boots: null
    },
    inventoryFull: false,
    inventorySummary: [],
    ...partial
  };
}

function makeSnapshot(partial: Partial<WorldSnapshot> = {}): WorldSnapshot {
  return {
    sessionId: "test",
    mode: "companion",
    connected: true,
    self: makeSelf(),
    player: null,
    nearbyPlayers: [],
    hazards: [],
    task: null,
    recentEvents: [],
    visualScene: null,
    timeOfDay: null,
    isRaining: false,
    reflexStatus: "idle",
    ...partial
  };
}

describe("evaluateReflexes", () => {
  test("returns none when disconnected", () => {
    const snapshot = makeSnapshot({ connected: false, self: null });
    expect(evaluateReflexes(snapshot).type).toBe("none");
  });

  test("fires eat when food is critically low in survival mode", () => {
    const snapshot = makeSnapshot({
      self: makeSelf({ food: 4, gameMode: "survival" })
    });
    expect(evaluateReflexes(snapshot).type).toBe("eat");
  });

  test("does not fire eat in creative mode even when food is zero", () => {
    const snapshot = makeSnapshot({
      self: makeSelf({ food: 0, gameMode: "creative" })
    });
    expect(evaluateReflexes(snapshot).type).toBe("none");
  });

  test("fires flee when health is low and a hazard is adjacent", () => {
    const snapshot = makeSnapshot({
      self: makeSelf({ health: 4 }),
      hazards: [
        { type: "zombie", distance: 3, position: { x: 3, y: 64, z: 0 } }
      ]
    });
    const action = evaluateReflexes(snapshot);
    expect(action.type).toBe("flee");
    if (action.type === "flee") {
      // Flee vector should point opposite of the hazard (-x direction).
      expect(action.away.x).toBeLessThan(0);
    }
  });

  test("does not fire flee when health is low but no hazard is close", () => {
    const snapshot = makeSnapshot({
      self: makeSelf({ health: 4 }),
      hazards: [
        { type: "zombie", distance: 20, position: { x: 20, y: 64, z: 0 } }
      ]
    });
    expect(evaluateReflexes(snapshot).type).toBe("none");
  });

  test("fires equip_shield when health is dropping, hazards are nearby, and shield is in inventory", () => {
    const snapshot = makeSnapshot({
      self: makeSelf({
        health: 12,
        inventorySummary: [{ name: "shield", count: 1 }]
      }),
      hazards: [
        { type: "skeleton", distance: 7, position: { x: 7, y: 64, z: 0 } }
      ]
    });
    expect(evaluateReflexes(snapshot).type).toBe("equip_shield");
  });

  test("does not fire equip_shield when shield already in off-hand", () => {
    const snapshot = makeSnapshot({
      self: makeSelf({
        health: 12,
        inventorySummary: [{ name: "shield", count: 1 }],
        equipment: {
          hand: null,
          offhand: "shield",
          helmet: null,
          chestplate: null,
          leggings: null,
          boots: null
        }
      }),
      hazards: [
        { type: "skeleton", distance: 7, position: { x: 7, y: 64, z: 0 } }
      ]
    });
    // Should skip shield reflex since it's already equipped.
    expect(evaluateReflexes(snapshot).type).not.toBe("equip_shield");
  });

  test("fires attack when hazard is extremely close and combat allowed", () => {
    const snapshot = makeSnapshot({
      hazards: [
        { type: "zombie", distance: 2, position: { x: 2, y: 64, z: 0 } }
      ]
    });
    const action = evaluateReflexes(snapshot, { avoidCombat: false });
    expect(action.type).toBe("attack");
  });

  test("does not fire attack when avoidCombat constraint is set", () => {
    const snapshot = makeSnapshot({
      hazards: [
        { type: "zombie", distance: 2, position: { x: 2, y: 64, z: 0 } }
      ]
    });
    expect(evaluateReflexes(snapshot, { avoidCombat: true }).type).toBe("none");
  });

  test("flee vector falls back to east when hazard is on top of self", () => {
    const snapshot = makeSnapshot({
      self: makeSelf({ health: 4, position: { x: 0, y: 64, z: 0 } }),
      hazards: [
        { type: "spider", distance: 0, position: { x: 0, y: 64, z: 0 } }
      ]
    });
    const action = evaluateReflexes(snapshot);
    expect(action.type).toBe("flee");
    if (action.type === "flee") {
      expect(action.away.x).toBeGreaterThan(0);
    }
  });
});

describe("detectStuck", () => {
  test("returns false when there is no previous sample", () => {
    const snapshot = makeSnapshot({ task: { goal: "moving to 10,64,0", step: "moving to 10,64,0", retries: 0, startedAt: 0 } });
    expect(detectStuck(snapshot, null)).toBe(false);
  });

  test("returns false when no navigation task is active", () => {
    const snapshot = makeSnapshot({ task: null });
    expect(detectStuck(snapshot, { x: 0, y: 64, z: 0 })).toBe(false);
  });

  test("detects stuck when position delta is below threshold with active task", () => {
    const snapshot = makeSnapshot({
      self: makeSelf({ position: { x: 0.1, y: 64, z: 0 } }),
      task: { goal: "moving", step: "moving", retries: 0, startedAt: 0 }
    });
    expect(detectStuck(snapshot, { x: 0, y: 64, z: 0 })).toBe(true);
  });

  test("does not detect stuck for non-navigation tasks", () => {
    const snapshot = makeSnapshot({
      self: makeSelf({ position: { x: 0.1, y: 64, z: 0 } }),
      task: { goal: "crafting 1x torch", step: "crafting 1x torch", retries: 0, startedAt: 0 }
    });
    expect(detectStuck(snapshot, { x: 0, y: 64, z: 0 })).toBe(false);
  });

  test("does not detect stuck when position has moved meaningfully", () => {
    const snapshot = makeSnapshot({
      self: makeSelf({ position: { x: 3, y: 64, z: 0 } }),
      task: { goal: "moving", step: "moving", retries: 0, startedAt: 0 }
    });
    expect(detectStuck(snapshot, { x: 0, y: 64, z: 0 })).toBe(false);
  });
});
