import { test } from "bun:test";
import assert from "node:assert/strict";
import { createMinecraftSession } from "./minecraftSession.ts";
import type { MinecraftBrain } from "./minecraftBrain.ts";
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

test("MinecraftSession runs a bounded planner checkpoint loop and carries goal state across checkpoints", async () => {
  const plannerContexts: Array<{
    instruction: string;
    connected: boolean;
    goal: string | null;
    progress: string[];
    serverTarget: unknown;
  }> = [];
  const brain: MinecraftBrain = {
    async planTurn(context) {
      plannerContexts.push({
        instruction: context.instruction,
        connected: context.worldSnapshot?.connected ?? false,
        goal: context.sessionState.activeGoal,
        progress: [...context.sessionState.progress],
        serverTarget: context.serverTarget
      });

      if (plannerContexts.length === 1) {
        return {
          goal: "Join the operator's world and stay with Steve",
          subgoals: ["join Survival SMP", "follow Steve"],
          progress: ["Need to connect before escorting"],
          summary: "Joining the configured world first.",
          shouldContinue: true,
          action: { kind: "connect" },
          costUsd: 0.12
        };
      }

      return {
        goal: null,
        subgoals: ["follow Steve"],
        progress: ["Connected and ready to escort"],
        summary: "Switching from join to follow.",
        shouldContinue: false,
        action: { kind: "follow", playerName: "Steve" },
        costUsd: 0.08
      };
    },
    async replyToChat() {
      return {
        goal: null,
        subgoals: [],
        progress: [],
        summary: null,
        chatText: null,
        action: { kind: "wait" },
        costUsd: 0
      };
    }
  };

  const session = createMinecraftSession({
    scopeKey: "guild-1:channel-1",
    baseUrl: "http://minecraft.test",
    ownerUserId: "user-1",
    operatorPlayerName: "Steve",
    serverTarget: {
      label: "Survival SMP",
      host: "mc.example.test",
      port: 25570,
      description: "Primary operator world"
    },
    brain
  });

  const runtime = session.runtime as unknown as {
    connect: (options?: Record<string, unknown>, signal?: AbortSignal) => Promise<{ ok: true; output: McpStatusSnapshot }>;
    status: (signal?: AbortSignal) => Promise<{ ok: true; output: McpStatusSnapshot }>;
    followPlayer: (playerName: string, distance?: number, signal?: AbortSignal) => Promise<{ ok: true; output: { ok: true; playerName: string; distance: number } }>;
    stop: () => Promise<{ ok: true; output: { ok: true } }>;
  };

  let connected = false;
  const connectCalls: Array<Record<string, unknown>> = [];
  const followCalls: Array<{ playerName: string; distance: number }> = [];

  runtime.connect = async (options = {}) => {
    connectCalls.push(options);
    connected = true;
    return { ok: true, output: createConnectedStatus() };
  };
  runtime.status = async () => ({
    ok: true,
    output: connected
      ? createConnectedStatus({ task: "connected" })
      : createConnectedStatus({ connected: false, username: undefined, position: undefined, task: "disconnected" })
  });
  runtime.followPlayer = async (playerName, distance = 3) => {
    followCalls.push({ playerName, distance });
    return { ok: true, output: { ok: true, playerName, distance } };
  };
  runtime.stop = async () => ({ ok: true, output: { ok: true } });

  const result = await session.runTurn("follow me");

  assert.equal(result.isError, false);
  assert.match(result.text, /Joining the configured world first\./);
  assert.match(result.text, /Now following Steve/);
  assert.deepEqual(connectCalls, [{ host: "mc.example.test", port: 25570, username: undefined, auth: undefined }]);
  assert.deepEqual(followCalls, [{ playerName: "Steve", distance: 3 }]);
  assert.equal(plannerContexts.length, 2);
  assert.equal(plannerContexts[0]?.connected, false);
  assert.equal(plannerContexts[1]?.connected, true);
  assert.equal(plannerContexts[1]?.goal, "Join the operator's world and stay with Steve");
  const secondProgress = plannerContexts[1]?.progress || [];
  assert.equal(secondProgress.includes("Need to connect before escorting"), true);
  assert.equal(secondProgress.some((entry) => /Connected as ClankyBuddy\./.test(entry)), true);

  session.close();
});
