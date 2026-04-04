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
