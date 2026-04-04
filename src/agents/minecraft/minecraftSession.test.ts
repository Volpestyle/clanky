import { test } from "bun:test";
import assert from "node:assert/strict";
import { createMinecraftSession } from "./minecraftSession.ts";
import type { McpStatusSnapshot } from "./minecraftRuntime.ts";

function createConnectedStatus(overrides: Partial<McpStatusSnapshot> = {}): McpStatusSnapshot {
  return {
    connected: true,
    username: "ClankyBuddy",
    health: 20,
    food: 20,
    gameMode: "survival",
    dimension: "overworld",
    position: { x: 0, y: 64, z: 0 },
    players: [{ username: "Steve", online: true, distance: 2, position: { x: 1, y: 64, z: 1 } }],
    hazards: [],
    inventory: [],
    task: "idle",
    recentEvents: [],
    ...overrides
  };
}

test("MinecraftSession normalizes snake_case constraints and downgrades guard to follow when avoid_combat is set", async () => {
  const session = createMinecraftSession({
    scopeKey: "guild-1:channel-1",
    baseUrl: "http://minecraft.test",
    ownerUserId: "user-1",
    operatorPlayerName: "Steve"
  });

  const runtime = session.runtime as unknown as {
    connect: (options?: Record<string, unknown>, signal?: AbortSignal) => Promise<{ ok: true; output: McpStatusSnapshot }>;
    status: (signal?: AbortSignal) => Promise<{ ok: true; output: McpStatusSnapshot }>;
    followPlayer: (playerName: string, distance?: number, signal?: AbortSignal) => Promise<{ ok: true; output: { ok: true; playerName: string; distance: number } }>;
    guardPlayer: () => Promise<never>;
    stop: () => Promise<{ ok: true; output: { ok: true } }>;
  };

  const followCalls: Array<{ playerName: string; distance: number }> = [];
  runtime.connect = async () => ({ ok: true, output: createConnectedStatus() });
  runtime.status = async () => ({ ok: true, output: createConnectedStatus() });
  runtime.followPlayer = async (playerName, distance = 3) => {
    followCalls.push({ playerName, distance });
    return { ok: true, output: { ok: true, playerName, distance } };
  };
  runtime.guardPlayer = async () => {
    throw new Error("guard should not be called when avoid_combat is enabled");
  };
  runtime.stop = async () => ({ ok: true, output: { ok: true } });

  const result = await session.runTurn(JSON.stringify({
    task: "guard me",
    constraints: {
      avoid_combat: true,
      stay_near_player: true,
      max_distance: 2
    }
  }));

  assert.equal(result.isError, false);
  assert.match(result.text, /Avoiding combat\./);
  assert.deepEqual(followCalls, [{ playerName: "Steve", distance: 2 }]);

  session.close();
});

test("MinecraftSession uses max_distance to limit resource gathering range", async () => {
  const session = createMinecraftSession({
    scopeKey: "guild-1:channel-1",
    baseUrl: "http://minecraft.test",
    ownerUserId: "user-1",
    operatorPlayerName: "Steve"
  });

  const runtime = session.runtime as unknown as {
    connect: (options?: Record<string, unknown>, signal?: AbortSignal) => Promise<{ ok: true; output: McpStatusSnapshot }>;
    status: (signal?: AbortSignal) => Promise<{ ok: true; output: McpStatusSnapshot }>;
    collectBlock: (blockName: string, count?: number, maxDistance?: number, signal?: AbortSignal) => Promise<{
      ok: true;
      output: {
        attempted: number;
        requested: number;
        blockName: string;
        inventoryBefore: number;
        inventoryAfter: number;
      };
    }>;
    stop: () => Promise<{ ok: true; output: { ok: true } }>;
  };

  const collectCalls: Array<{ blockName: string; count: number; maxDistance: number }> = [];
  runtime.connect = async () => ({ ok: true, output: createConnectedStatus() });
  runtime.status = async () => ({ ok: true, output: createConnectedStatus() });
  runtime.collectBlock = async (blockName, count = 1, maxDistance = 32) => {
    collectCalls.push({ blockName, count, maxDistance });
    return {
      ok: true,
      output: {
        attempted: count,
        requested: count,
        blockName,
        inventoryBefore: 0,
        inventoryAfter: count
      }
    };
  };
  runtime.stop = async () => ({ ok: true, output: { ok: true } });

  const result = await session.runTurn(JSON.stringify({
    task: "collect 3 oak logs",
    constraints: {
      max_distance: 6
    }
  }));

  assert.equal(result.isError, false);
  assert.deepEqual(collectCalls, [{ blockName: "oak_logs", count: 3, maxDistance: 6 }]);

  session.close();
});
