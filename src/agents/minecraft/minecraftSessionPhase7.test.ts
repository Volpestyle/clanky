/**
 * Phase 6/7 session behavior tests.
 *
 * Covers the new action kinds added for reflex completion and capability
 * expansion: eat, equip_offhand, craft, deposit, withdraw, place_block,
 * build (with inline plan), and the long-horizon project loop.
 *
 * These tests focus on session dispatch + state mutation rather than the
 * MCP runtime itself — the runtime is mocked.
 */

import { test } from "bun:test";
import assert from "node:assert/strict";
import { createMinecraftSession } from "./minecraftSession.ts";
import type { MinecraftBrain } from "./minecraftBrain.ts";
import type { MinecraftBrainAction } from "./types.ts";
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
    players: [],
    hazards: [],
    inventory: [],
    task: "idle",
    recentEvents: [],
    ...overrides
  };
}

function createDisconnectedStatus(overrides: Partial<McpStatusSnapshot> = {}): McpStatusSnapshot {
  return createConnectedStatus({
    connected: false,
    username: undefined,
    position: undefined,
    task: "disconnected",
    ...overrides
  });
}

function createBrainReturning(action: MinecraftBrainAction, summary = "Acting."): MinecraftBrain {
  return {
    async planTurn() {
      return {
        goal: null,
        subgoals: [],
        progress: [],
        summary,
        shouldContinue: false,
        action,
        costUsd: 0
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
}

function createBrainSequence(actions: MinecraftBrainAction[], summary = "Acting."): MinecraftBrain {
  let callIdx = 0;
  return {
    async planTurn() {
      return {
        goal: null,
        subgoals: [],
        progress: [],
        summary,
        shouldContinue: false,
        action: actions[callIdx++] ?? { kind: "wait" },
        costUsd: 0
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
}

function mockRuntime(session: ReturnType<typeof createMinecraftSession>) {
  return session.runtime as Record<string, (...args: unknown[]) => Promise<unknown>>;
}

test("eat action dispatches to eatBestFood and reports food delta", async () => {
  const brain = createBrainReturning({ kind: "eat" });
  const session = createMinecraftSession({
    scopeKey: "guild-1:channel-1",
    baseUrl: "http://minecraft.test",
    ownerUserId: "user-1",
    brain
  });
  const runtime = mockRuntime(session);
  let eatCalls = 0;
  runtime.connect = async () => ({ ok: true, output: createConnectedStatus() });
  runtime.status = async () => ({ ok: true, output: createConnectedStatus({ food: 10 }) });
  runtime.eatBestFood = async () => {
    eatCalls += 1;
    return { ok: true, output: { ok: true, foodName: "cooked_beef", foodBefore: 10, foodAfter: 20 } };
  };
  runtime.stop = async () => ({ ok: true, output: { ok: true } });

  const result = await session.runTurn("eat something");
  assert.equal(result.isError, false);
  assert.equal(eatCalls, 1);
  assert.match(result.text, /cooked_beef/);
  session.close();
});

test("equip_offhand action equips the requested item", async () => {
  const brain = createBrainReturning({ kind: "equip_offhand", itemName: "shield" });
  const session = createMinecraftSession({
    scopeKey: "guild-1:channel-1",
    baseUrl: "http://minecraft.test",
    ownerUserId: "user-1",
    brain
  });
  const runtime = mockRuntime(session);
  const equipCalls: Array<{ itemName: string }> = [];
  runtime.connect = async () => ({ ok: true, output: createConnectedStatus() });
  runtime.status = async () => ({ ok: true, output: createConnectedStatus() });
  runtime.equipOffhand = async (itemName: unknown) => {
    equipCalls.push({ itemName: String(itemName) });
    return { ok: true, output: { ok: true, itemName: "shield" } };
  };
  runtime.stop = async () => ({ ok: true, output: { ok: true } });

  const result = await session.runTurn("grab shield");
  assert.equal(result.isError, false);
  assert.deepEqual(equipCalls, [{ itemName: "shield" }]);
  session.close();
});

test("craft action dispatches with count and crafting-table flag", async () => {
  const brain = createBrainReturning({
    kind: "craft",
    recipeName: "wooden_pickaxe",
    count: 1,
    useCraftingTable: true
  });
  const session = createMinecraftSession({
    scopeKey: "guild-1:channel-1",
    baseUrl: "http://minecraft.test",
    ownerUserId: "user-1",
    brain
  });
  const runtime = mockRuntime(session);
  const craftArgs: Array<{ recipeName: string; count: number; useCraftingTable: boolean }> = [];
  runtime.connect = async () => ({ ok: true, output: createConnectedStatus() });
  runtime.status = async () => ({ ok: true, output: createConnectedStatus() });
  runtime.craftItem = async (recipeName: unknown, count: unknown, useCraftingTable: unknown) => {
    craftArgs.push({
      recipeName: String(recipeName),
      count: Number(count),
      useCraftingTable: Boolean(useCraftingTable)
    });
    return { ok: true, output: { ok: true, recipeName: "wooden_pickaxe", crafted: 1, requested: 1 } };
  };
  runtime.stop = async () => ({ ok: true, output: { ok: true } });

  const result = await session.runTurn("craft pickaxe");
  assert.equal(result.isError, false);
  assert.equal(craftArgs.length, 1);
  assert.equal(craftArgs[0]?.recipeName, "wooden_pickaxe");
  assert.equal(craftArgs[0]?.useCraftingTable, true);
  assert.match(result.text, /wooden_pickaxe/);
  session.close();
});

test("deposit action enforces allowedChests constraint", async () => {
  const brain = createBrainReturning({
    kind: "deposit",
    chest: { x: 10, y: 64, z: 10 },
    items: [{ name: "cobblestone", count: 32 }]
  });
  const session = createMinecraftSession({
    scopeKey: "guild-1:channel-1",
    baseUrl: "http://minecraft.test",
    ownerUserId: "user-1",
    brain,
    constraints: {
      // Only chest at (0,64,0) is allowed — brain-requested chest at 10,64,10 is NOT.
      allowedChests: [{ x: 0, y: 64, z: 0, label: "home" }]
    }
  });
  const runtime = mockRuntime(session);
  let depositCalls = 0;
  runtime.connect = async () => ({ ok: true, output: createConnectedStatus() });
  runtime.status = async () => ({ ok: true, output: createConnectedStatus() });
  runtime.depositItems = async () => {
    depositCalls += 1;
    return { ok: true, output: { ok: true, chest: { x: 10, y: 64, z: 10 }, deposited: [], skipped: [] } };
  };
  runtime.stop = async () => ({ ok: true, output: { ok: true } });

  const result = await session.runTurn("deposit");
  // Depositing to disallowed chest is rejected; runtime is never called.
  assert.equal(depositCalls, 0);
  assert.match(result.text, /not in allowedChests/);
  session.close();
});

test("place_block action dispatches to runtime.placeBlock", async () => {
  const brain = createBrainReturning({
    kind: "place_block",
    x: 5,
    y: 64,
    z: 5,
    blockName: "oak_planks"
  });
  const session = createMinecraftSession({
    scopeKey: "guild-1:channel-1",
    baseUrl: "http://minecraft.test",
    ownerUserId: "user-1",
    brain
  });
  const runtime = mockRuntime(session);
  const placeArgs: Array<{ x: number; y: number; z: number; blockName: string }> = [];
  runtime.connect = async () => ({ ok: true, output: createConnectedStatus() });
  runtime.status = async () => ({ ok: true, output: createConnectedStatus() });
  runtime.placeBlock = async (x: unknown, y: unknown, z: unknown, blockName: unknown) => {
    placeArgs.push({ x: Number(x), y: Number(y), z: Number(z), blockName: String(blockName) });
    return {
      ok: true,
      output: { ok: true, placed: true, position: { x: Number(x), y: Number(y), z: Number(z) }, blockName: String(blockName) }
    };
  };
  runtime.stop = async () => ({ ok: true, output: { ok: true } });

  const result = await session.runTurn("place block");
  assert.equal(result.isError, false);
  assert.deepEqual(placeArgs, [{ x: 5, y: 64, z: 5, blockName: "oak_planks" }]);
  session.close();
});

test("build action with inline plan dispatches placements in order", async () => {
  const brain = createBrainReturning({
    kind: "build",
    plan: {
      title: "mini wall",
      blocks: [
        { x: 0, y: 64, z: 0, blockName: "cobblestone" },
        { x: 0, y: 65, z: 0, blockName: "cobblestone" }
      ]
    }
  });
  const session = createMinecraftSession({
    scopeKey: "guild-1:channel-1",
    baseUrl: "http://minecraft.test",
    ownerUserId: "user-1",
    brain
  });
  const runtime = mockRuntime(session);
  const placements: Array<{ x: number; y: number; z: number }> = [];
  runtime.connect = async () => ({ ok: true, output: createConnectedStatus() });
  runtime.status = async () => ({ ok: true, output: createConnectedStatus() });
  runtime.goTo = async () => ({ ok: true, output: { ok: true, target: { x: 0, y: 64, z: 0 }, range: 2 } });
  runtime.placeBlock = async (x: unknown, y: unknown, z: unknown, blockName: unknown) => {
    placements.push({ x: Number(x), y: Number(y), z: Number(z) });
    return {
      ok: true,
      output: {
        ok: true,
        placed: true,
        position: { x: Number(x), y: Number(y), z: Number(z) },
        blockName: String(blockName)
      }
    };
  };
  runtime.digBlock = async () => ({ ok: true, output: { ok: true, dug: false, position: { x: 0, y: 64, z: 0 }, blockName: "air" } });
  runtime.stop = async () => ({ ok: true, output: { ok: true } });

  const result = await session.runTurn("build mini wall");
  assert.equal(result.isError, false);
  assert.equal(placements.length, 2);
  assert.match(result.text, /mini wall/);
  session.close();
});

test("project_start initializes planner state with budget and checkpoints", async () => {
  const brain = createBrainReturning({
    kind: "project_start",
    title: "get wood",
    description: "gather 32 oak logs",
    checkpoints: ["find forest", "chop 32 logs", "return home"],
    actionBudget: 25
  });
  const session = createMinecraftSession({
    scopeKey: "guild-1:channel-1",
    baseUrl: "http://minecraft.test",
    ownerUserId: "user-1",
    brain
  });
  const runtime = mockRuntime(session);
  runtime.connect = async () => ({ ok: true, output: createConnectedStatus() });
  runtime.status = async () => ({ ok: true, output: createConnectedStatus() });
  runtime.stop = async () => ({ ok: true, output: { ok: true } });

  const result = await session.runTurn("start project");
  assert.equal(result.isError, false);
  assert.match(result.text, /get wood/);
  assert.match(result.text, /budget 25/);
  assert.match(result.text, /3 checkpoints/);
  session.close();
});

test("project_step auto-ticks checkpoint when summary matches", async () => {
  let callIdx = 0;
  const actions: MinecraftBrainAction[] = [
    {
      kind: "project_start",
      title: "stone collector",
      description: "collect 16 cobblestone",
      checkpoints: ["find stone", "mine 16"]
    },
    { kind: "project_step", summary: "find stone" }
  ];
  const brain: MinecraftBrain = {
    async planTurn() {
      const action = actions[callIdx++];
      return {
        goal: null,
        subgoals: [],
        progress: [],
        summary: "",
        shouldContinue: false,
        action: action ?? { kind: "wait" },
        costUsd: 0
      };
    },
    async replyToChat() {
      return { goal: null, subgoals: [], progress: [], summary: null, chatText: null, action: { kind: "wait" }, costUsd: 0 };
    }
  };
  const session = createMinecraftSession({
    scopeKey: "guild-1:channel-1",
    baseUrl: "http://minecraft.test",
    ownerUserId: "user-1",
    brain
  });
  const runtime = mockRuntime(session);
  runtime.connect = async () => ({ ok: true, output: createConnectedStatus() });
  runtime.status = async () => ({ ok: true, output: createConnectedStatus() });
  runtime.stop = async () => ({ ok: true, output: { ok: true } });

  await session.runTurn("start");
  const stepResult = await session.runTurn("step");
  assert.equal(stepResult.isError, false);
  assert.match(stepResult.text, /logged: find stone/);
  session.close();
});

test("project auto-pauses when action budget is exhausted", async () => {
  let callIdx = 0;
  const actions: MinecraftBrainAction[] = [
    { kind: "project_start", title: "tiny", description: "", actionBudget: 2 },
    { kind: "project_step" },
    { kind: "project_step" },
    { kind: "project_step" }
  ];
  const brain: MinecraftBrain = {
    async planTurn() {
      const action = actions[callIdx++];
      return {
        goal: null,
        subgoals: [],
        progress: [],
        summary: "",
        shouldContinue: false,
        action: action ?? { kind: "wait" },
        costUsd: 0
      };
    },
    async replyToChat() {
      return { goal: null, subgoals: [], progress: [], summary: null, chatText: null, action: { kind: "wait" }, costUsd: 0 };
    }
  };
  const session = createMinecraftSession({
    scopeKey: "guild-1:channel-1",
    baseUrl: "http://minecraft.test",
    ownerUserId: "user-1",
    brain
  });
  const runtime = mockRuntime(session);
  runtime.connect = async () => ({ ok: true, output: createConnectedStatus() });
  runtime.status = async () => ({ ok: true, output: createConnectedStatus() });
  runtime.stop = async () => ({ ok: true, output: { ok: true } });

  await session.runTurn("start");
  await session.runTurn("step");
  const budgetResult = await session.runTurn("step");
  // The third step should trip the budget (budget=2, used=2).
  assert.match(budgetResult.text, /budget/i);
  session.close();
});

test("project_start rejects when another project is already active", async () => {
  let callIdx = 0;
  const actions: MinecraftBrainAction[] = [
    { kind: "project_start", title: "first", description: "" },
    { kind: "project_start", title: "second", description: "" }
  ];
  const brain: MinecraftBrain = {
    async planTurn() {
      const action = actions[callIdx++];
      return {
        goal: null,
        subgoals: [],
        progress: [],
        summary: "",
        shouldContinue: false,
        action: action ?? { kind: "wait" },
        costUsd: 0
      };
    },
    async replyToChat() {
      return { goal: null, subgoals: [], progress: [], summary: null, chatText: null, action: { kind: "wait" }, costUsd: 0 };
    }
  };
  const session = createMinecraftSession({
    scopeKey: "guild-1:channel-1",
    baseUrl: "http://minecraft.test",
    ownerUserId: "user-1",
    brain
  });
  const runtime = mockRuntime(session);
  runtime.connect = async () => ({ ok: true, output: createConnectedStatus() });
  runtime.status = async () => ({ ok: true, output: createConnectedStatus() });
  runtime.stop = async () => ({ ok: true, output: { ok: true } });

  await session.runTurn("start first");
  const secondResult = await session.runTurn("start second");
  assert.match(secondResult.text, /already active/i);
  session.close();
});

test("project auto-accrues budget on concrete in-world actions", async () => {
  const brain = createBrainSequence([
    { kind: "project_start", title: "gather", description: "", actionBudget: 3 },
    { kind: "collect", blockName: "oak_log", count: 1 },
    { kind: "collect", blockName: "oak_log", count: 1 },
    { kind: "collect", blockName: "oak_log", count: 1 },
    { kind: "collect", blockName: "oak_log", count: 1 }
  ]);
  const session = createMinecraftSession({
    scopeKey: "guild-1:channel-1",
    baseUrl: "http://minecraft.test",
    ownerUserId: "user-1",
    brain
  });
  const runtime = mockRuntime(session);
  runtime.connect = async () => ({ ok: true, output: createConnectedStatus() });
  runtime.status = async () => ({ ok: true, output: createConnectedStatus() });
  runtime.collectBlock = async () => ({
    ok: true,
    output: { ok: true, blockName: "oak_log", requested: 1, attempted: 1, inventoryBefore: 0, inventoryAfter: 1 }
  });
  runtime.stop = async () => ({ ok: true, output: { ok: true } });

  await session.runTurn("start project");
  assert.equal(session.getActiveProject()?.actionsUsed, 0);
  assert.equal(session.getActiveProject()?.status, "executing");

  await session.runTurn("collect 1");
  assert.equal(session.getActiveProject()?.actionsUsed, 1);
  assert.equal(session.getActiveProject()?.status, "executing");

  await session.runTurn("collect 2");
  assert.equal(session.getActiveProject()?.actionsUsed, 2);
  assert.equal(session.getActiveProject()?.status, "executing");

  await session.runTurn("collect 3");
  assert.equal(session.getActiveProject()?.actionsUsed, 3);
  assert.equal(session.getActiveProject()?.status, "paused");

  await session.runTurn("collect 4");
  assert.equal(session.getActiveProject()?.actionsUsed, 3);
  assert.equal(session.getActiveProject()?.status, "paused");
  session.close();
});

test("project budget ignores look status and connect actions", async () => {
  const brain = createBrainSequence([
    { kind: "project_start", title: "survey", description: "", actionBudget: 3 },
    { kind: "look" },
    { kind: "status" },
    { kind: "connect" }
  ]);
  const session = createMinecraftSession({
    scopeKey: "guild-1:channel-1",
    baseUrl: "http://minecraft.test",
    ownerUserId: "user-1",
    brain,
    serverTarget: {
      label: "Survival",
      host: "survival.example",
      port: 25565,
      description: "Default world"
    }
  });
  const runtime = mockRuntime(session);
  let connected = false;
  runtime.connect = async () => {
    connected = true;
    return { ok: true, output: createConnectedStatus() };
  };
  runtime.status = async () => ({
    ok: true,
    output: connected ? createConnectedStatus() : createDisconnectedStatus()
  });
  runtime.look = async () => ({
    ok: true,
    output: {
      mediaType: "image/png",
      dataBase64: "AA==",
      width: 1,
      height: 1,
      capturedAt: new Date().toISOString(),
      viewpoint: {
        position: { x: 0, y: 64, z: 0 },
        yaw: 0,
        pitch: 0
      }
    }
  });
  runtime.stop = async () => ({ ok: true, output: { ok: true } });

  await session.runTurn("start project");
  await session.runTurn("look around");
  assert.equal(session.getActiveProject()?.actionsUsed, 0);

  await session.runTurn("status");
  assert.equal(session.getActiveProject()?.actionsUsed, 0);

  await session.runTurn("reconnect");
  assert.equal(session.getActiveProject()?.actionsUsed, 0);
  session.close();
});

test("project_step rejects while project is paused", async () => {
  const brain = createBrainSequence([
    { kind: "project_start", title: "tiny", description: "", actionBudget: 1 },
    { kind: "project_step", summary: "first checkpoint" },
    { kind: "wait" },
    { kind: "project_step", summary: "second checkpoint" }
  ]);
  const session = createMinecraftSession({
    scopeKey: "guild-1:channel-1",
    baseUrl: "http://minecraft.test",
    ownerUserId: "user-1",
    brain
  });
  const runtime = mockRuntime(session);
  runtime.connect = async () => ({ ok: true, output: createConnectedStatus() });
  runtime.status = async () => ({ ok: true, output: createConnectedStatus() });
  runtime.stop = async () => ({ ok: true, output: { ok: true } });

  await session.runTurn("start project");
  const budgetResult = await session.runTurn("step once");
  assert.match(budgetResult.text, /hit its 1-action budget/i);
  assert.equal(session.getActiveProject()?.actionsUsed, 1);
  assert.equal(session.getActiveProject()?.status, "paused");

  const pausedResult = await session.runTurn("step again");
  assert.match(pausedResult.text, /resume it first/i);
  assert.equal(session.getActiveProject()?.actionsUsed, 1);
  assert.equal(session.getActiveProject()?.status, "paused");
  session.close();
});

test("project_resume rejects after the project budget is exhausted", async () => {
  const brain = createBrainSequence([
    { kind: "project_start", title: "tiny", description: "", actionBudget: 1 },
    { kind: "project_step", summary: "first checkpoint" },
    { kind: "wait" },
    { kind: "project_resume" }
  ]);
  const session = createMinecraftSession({
    scopeKey: "guild-1:channel-1",
    baseUrl: "http://minecraft.test",
    ownerUserId: "user-1",
    brain
  });
  const runtime = mockRuntime(session);
  runtime.connect = async () => ({ ok: true, output: createConnectedStatus() });
  runtime.status = async () => ({ ok: true, output: createConnectedStatus() });
  runtime.stop = async () => ({ ok: true, output: { ok: true } });

  await session.runTurn("start project");
  const budgetResult = await session.runTurn("step once");
  assert.match(budgetResult.text, /hit its 1-action budget/i);
  assert.equal(session.getActiveProject()?.status, "paused");

  const resumeResult = await session.runTurn("resume project");
  assert.match(resumeResult.text, /budget/i);
  assert.equal(session.getActiveProject()?.status, "paused");
  session.close();
});

test("project_resume rejects after the project is abandoned", async () => {
  const brain = createBrainSequence([
    { kind: "project_start", title: "tiny", description: "" },
    { kind: "project_abort", reason: "done" },
    { kind: "project_resume" }
  ]);
  const session = createMinecraftSession({
    scopeKey: "guild-1:channel-1",
    baseUrl: "http://minecraft.test",
    ownerUserId: "user-1",
    brain
  });
  const runtime = mockRuntime(session);
  runtime.connect = async () => ({ ok: true, output: createConnectedStatus() });
  runtime.status = async () => ({ ok: true, output: createConnectedStatus() });
  runtime.stop = async () => ({ ok: true, output: { ok: true } });

  await session.runTurn("start project");
  const abortResult = await session.runTurn("abort project");
  assert.match(abortResult.text, /aborted/i);
  assert.equal(session.getActiveProject()?.status, "abandoned");

  const resumeResult = await session.runTurn("resume project");
  assert.match(resumeResult.text, /abandoned/i);
  assert.equal(session.getActiveProject()?.status, "abandoned");
  session.close();
});

test("build description auto-connects before deriving an origin", async () => {
  const plannerOrigins: Array<{ x: number; y: number; z: number }> = [];
  const session = createMinecraftSession({
    scopeKey: "guild-1:channel-1",
    baseUrl: "http://minecraft.test",
    ownerUserId: "user-1",
    brain: createBrainReturning({ kind: "build", description: "pillar 1" }),
    builder: {
      async buildPlan(descriptor) {
        plannerOrigins.push(descriptor.origin);
        return {
          title: "pillar",
          blocks: [{ x: descriptor.origin.x, y: descriptor.origin.y, z: descriptor.origin.z, blockName: "cobblestone" }]
        };
      }
    }
  });
  const runtime = mockRuntime(session);
  let connected = false;
  let connectCalls = 0;
  runtime.connect = async (_options: unknown, _signal?: AbortSignal) => {
    connectCalls += 1;
    connected = true;
    return { ok: true, output: createConnectedStatus() };
  };
  runtime.status = async () => ({
    ok: true,
    output: connected ? createConnectedStatus() : createDisconnectedStatus()
  });
  runtime.placeBlock = async (x: unknown, y: unknown, z: unknown, blockName: unknown) => ({
    ok: true,
    output: {
      ok: true,
      placed: true,
      position: { x: Number(x), y: Number(y), z: Number(z) },
      blockName: String(blockName)
    }
  });
  runtime.stop = async () => ({ ok: true, output: { ok: true } });

  const result = await session.runTurn("build a pillar");
  assert.equal(result.isError, false);
  assert.equal(connectCalls, 1);
  assert.deepEqual(plannerOrigins, [{ x: 0, y: 64, z: 0 }]);
  session.close();
});

test("connect resolves catalog label and persists it for reconnect", async () => {
  const brain = createBrainSequence([
    { kind: "connect", target: { label: "Creative" } },
    { kind: "collect", blockName: "oak_log", count: 1 }
  ]);
  const session = createMinecraftSession({
    scopeKey: "guild-1:channel-1",
    baseUrl: "http://minecraft.test",
    ownerUserId: "user-1",
    brain,
    serverTarget: {
      label: "Survival",
      host: "survival.example",
      port: 25565,
      description: "Default world"
    },
    serverCatalog: [{
      label: "Creative",
      host: "creative.example",
      port: 25566,
      description: "Creative world"
    }]
  });
  const runtime = mockRuntime(session);
  const connectCalls: Array<Record<string, unknown>> = [];
  let connected = false;
  let kicked = false;
  runtime.connect = async (options: unknown) => {
    connectCalls.push((options as Record<string, unknown>) ?? {});
    connected = true;
    kicked = false;
    return { ok: true, output: createConnectedStatus() };
  };
  runtime.status = async () => {
    if (!connected || kicked) {
      connected = false;
      return { ok: true, output: createDisconnectedStatus() };
    }
    return { ok: true, output: createConnectedStatus() };
  };
  runtime.collectBlock = async () => ({
    ok: true,
    output: { ok: true, blockName: "oak_log", requested: 1, attempted: 1, inventoryBefore: 0, inventoryAfter: 1 }
  });
  runtime.stop = async () => ({ ok: true, output: { ok: true } });

  await session.runTurn("connect to Creative");
  assert.deepEqual(connectCalls[0], {
    host: "creative.example",
    port: 25566,
    username: undefined,
    auth: undefined
  });
  assert.deepEqual(session.getServerTargetSnapshot(), {
    label: "Creative",
    host: "creative.example",
    port: 25566,
    description: "Creative world"
  });

  kicked = true;
  await session.runTurn("collect after reconnect");
  assert.deepEqual(connectCalls[1], {
    host: "creative.example",
    port: 25566
  });
  session.close();
});

test("connect falls back to the configured server when catalog label is unknown", async () => {
  const brain = createBrainReturning({ kind: "connect", target: { label: "Unknown" } });
  const session = createMinecraftSession({
    scopeKey: "guild-1:channel-1",
    baseUrl: "http://minecraft.test",
    ownerUserId: "user-1",
    brain,
    serverTarget: {
      label: "Survival",
      host: "survival.example",
      port: 25565,
      description: "Default world"
    },
    serverCatalog: [{
      label: "Creative",
      host: "creative.example",
      port: 25566,
      description: "Creative world"
    }]
  });
  const runtime = mockRuntime(session);
  const connectCalls: Array<Record<string, unknown>> = [];
  runtime.connect = async (options: unknown) => {
    connectCalls.push((options as Record<string, unknown>) ?? {});
    return { ok: true, output: createConnectedStatus() };
  };
  runtime.status = async () => ({ ok: true, output: createDisconnectedStatus() });
  runtime.stop = async () => ({ ok: true, output: { ok: true } });

  await session.runTurn("connect to unknown");
  assert.deepEqual(connectCalls[0], {
    host: "survival.example",
    port: 25565,
    username: undefined,
    auth: undefined
  });
  session.close();
});

test("connect prefers explicit host over catalog backfill", async () => {
  const brain = createBrainReturning({
    kind: "connect",
    target: {
      label: "Creative",
      host: "override.example"
    }
  });
  const session = createMinecraftSession({
    scopeKey: "guild-1:channel-1",
    baseUrl: "http://minecraft.test",
    ownerUserId: "user-1",
    brain,
    serverTarget: {
      label: "Survival",
      host: "survival.example",
      port: 25565,
      description: "Default world"
    },
    serverCatalog: [{
      label: "Creative",
      host: "creative.example",
      port: 25566,
      description: "Creative world"
    }]
  });
  const runtime = mockRuntime(session);
  const connectCalls: Array<Record<string, unknown>> = [];
  runtime.connect = async (options: unknown) => {
    connectCalls.push((options as Record<string, unknown>) ?? {});
    return { ok: true, output: createConnectedStatus() };
  };
  runtime.status = async () => ({ ok: true, output: createDisconnectedStatus() });
  runtime.stop = async () => ({ ok: true, output: { ok: true } });

  await session.runTurn("connect with override");
  assert.deepEqual(connectCalls[0], {
    host: "override.example",
    port: 25566,
    username: undefined,
    auth: undefined
  });
  assert.deepEqual(session.getServerTargetSnapshot(), {
    label: "Creative",
    host: "override.example",
    port: 25566,
    description: "Creative world"
  });
  session.close();
});
