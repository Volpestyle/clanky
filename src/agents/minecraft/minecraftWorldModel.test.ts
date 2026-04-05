import { test } from "bun:test";
import assert from "node:assert/strict";
import { evaluateReflexes } from "./minecraftReflexes.ts";
import { buildWorldSnapshot } from "./minecraftWorldModel.ts";

test("buildWorldSnapshot carries MCP hazards into reflex evaluation", () => {
  const snapshot = buildWorldSnapshot("minecraft:guild-1:channel-1:1:1", "guard", {
    connected: true,
    username: "ClankyBuddy",
    health: 20,
    food: 20,
    gameMode: "survival",
    dimension: "overworld",
    position: { x: 0, y: 64, z: 0 },
    players: [],
    hazards: [{ type: "zombie", distance: 2, position: { x: 2, y: 64, z: 0 } }],
    inventory: [],
    task: "idle",
    recentEvents: []
  });

  assert.deepEqual(snapshot.hazards, [{
    type: "zombie",
    distance: 2,
    position: { x: 2, y: 64, z: 0 }
  }]);
  assert.deepEqual(evaluateReflexes(snapshot), { type: "attack", target: "zombie" });
  assert.deepEqual(evaluateReflexes(snapshot, { avoidCombat: true }), { type: "none" });
});

test("buildWorldSnapshot preserves typed events and visible scene context", () => {
  const visualScene = {
    sampledFrom: { x: 0, y: 64, z: 0 },
    blocks: [
      { name: "stone", position: { x: 0, y: 63, z: -1 }, relative: { x: 0, y: -1, z: -1 }, distance: 1.4 }
    ],
    nearbyEntities: [
      { name: "Steve", type: "player", position: { x: 1, y: 64, z: -2 }, distance: 2.2 }
    ],
    skyVisible: false,
    enclosed: true,
    notableFeatures: ["cave-like enclosure"]
  };
  const snapshot = buildWorldSnapshot("minecraft:guild-1:channel-1:1:1", "companion", {
    connected: true,
    username: "ClankyBuddy",
    health: 20,
    food: 20,
    gameMode: "survival",
    dimension: "overworld",
    position: { x: 0, y: 64, z: 0 },
    players: [],
    hazards: [],
    inventory: [],
    task: "idle",
    recentEvents: [
      { type: "player_join", timestamp: "2026-04-04T12:00:00Z", summary: "player joined: Alice", playerName: "Alice" }
    ]
  }, null, visualScene);

  assert.equal(snapshot.recentEvents[0]?.type, "player_join");
  assert.equal(snapshot.recentEvents[0]?.summary, "player joined: Alice");
  assert.deepEqual(snapshot.visualScene, visualScene);
});
