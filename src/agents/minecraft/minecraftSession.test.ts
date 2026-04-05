import { test } from "bun:test";
import assert from "node:assert/strict";
import { createMinecraftSession } from "./minecraftSession.ts";
import type { DiscordContextMessage, MinecraftBrain } from "./minecraftBrain.ts";
import type { MinecraftBrainAction, MinecraftGameEvent, MinecraftVisualScene } from "./types.ts";
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

function createFakeBrain(action: MinecraftBrainAction, summary = "Acting."): MinecraftBrain {
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

test("MinecraftSession normalizes snake_case constraints and downgrades guard to follow when avoid_combat is set", async () => {
  const brain = createFakeBrain(
    { kind: "guard", playerName: "Steve" },
    "Guarding Steve."
  );
  const session = createMinecraftSession({
    scopeKey: "guild-1:channel-1",
    baseUrl: "http://minecraft.test",
    ownerUserId: "user-1",
    knownIdentities: [{ mcUsername: "Steve", relationship: "friend" }],
    brain
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
      stay_near_player: "Steve",
      max_distance: 2
    }
  }));

  assert.equal(result.isError, false);
  assert.match(result.text, /Avoiding combat\./);
  assert.deepEqual(followCalls, [{ playerName: "Steve", distance: 2 }]);

  session.close();
});

test("MinecraftSession uses max_distance to limit resource gathering range", async () => {
  const brain = createFakeBrain(
    { kind: "collect", blockName: "oak_logs", count: 3 },
    "Gathering oak logs."
  );
  const session = createMinecraftSession({
    scopeKey: "guild-1:channel-1",
    baseUrl: "http://minecraft.test",
    ownerUserId: "user-1",
    knownIdentities: [{ mcUsername: "Steve", relationship: "friend" }],
    brain
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
    knownIdentities: [{ mcUsername: "Steve", relationship: "friend" }],
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

test("MinecraftSession retries within the same turn after a failed follow and surfaces a did-you-mean player name", async () => {
  const plannerStates: Array<{
    instruction: string;
    lastActionResult: string | null;
    lastActionFailure: unknown;
  }> = [];
  let planTurnCount = 0;
  const brain: MinecraftBrain = {
    async planTurn(context) {
      plannerStates.push({
        instruction: context.instruction,
        lastActionResult: context.sessionState.lastActionResult,
        lastActionFailure: context.sessionState.lastActionFailure
      });
      planTurnCount += 1;

      if (planTurnCount === 1) {
        return {
          goal: "Find and follow Volpestyle",
          subgoals: ["locate the correct player name"],
          progress: [],
          summary: "Trying the requested follow first.",
          shouldContinue: false,
          action: { kind: "follow", playerName: "Volpe" },
          costUsd: 0.04
        };
      }

      return {
        goal: null,
        subgoals: ["follow Volpestyle"],
        progress: ["Resolved the visible player name."],
        summary: "Retrying with the visible player name.",
        shouldContinue: false,
        action: { kind: "follow", playerName: "Volpestyle" },
        costUsd: 0.03
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
    knownIdentities: [{ mcUsername: "Volpestyle", relationship: "operator" }],
    brain
  });

  const runtime = session.runtime as unknown as {
    connect: (options?: Record<string, unknown>, signal?: AbortSignal) => Promise<{ ok: true; output: McpStatusSnapshot }>;
    status: (signal?: AbortSignal) => Promise<{ ok: true; output: McpStatusSnapshot }>;
    followPlayer: (playerName: string, distance?: number, signal?: AbortSignal) => Promise<{ ok: true; output: { ok: true; playerName: string; distance: number } }>;
    stop: () => Promise<{ ok: true; output: { ok: true } }>;
  };

  const visiblePlayers = [{ username: "Volpestyle", online: true, distance: 2, position: { x: 1, y: 64, z: 1 } }];
  const followCalls: string[] = [];

  runtime.connect = async () => ({ ok: true, output: createConnectedStatus({ players: visiblePlayers }) });
  runtime.status = async () => ({ ok: true, output: createConnectedStatus({ players: visiblePlayers }) });
  runtime.followPlayer = async (playerName, distance = 3) => {
    followCalls.push(playerName);
    if (playerName === "Volpe") {
      throw new Error("Player 'Volpe' is not known in the current world state.");
    }
    return { ok: true, output: { ok: true, playerName, distance } };
  };
  runtime.stop = async () => ({ ok: true, output: { ok: true } });

  const result = await session.runTurn("follow Volpe");

  assert.equal(result.isError, false);
  assert.equal(plannerStates.length, 2);
  assert.equal(plannerStates[0]?.lastActionFailure, null);
  assert.equal(plannerStates[1]?.lastActionResult, "Player 'Volpe' is not known in the current world state.");
  assert.deepEqual(plannerStates[1]?.lastActionFailure, {
    actionKind: "follow",
    reason: "player_not_visible",
    message: "Player 'Volpe' is not known in the current world state.",
    didYouMeanPlayerName: "Volpestyle"
  });
  assert.deepEqual(followCalls, ["Volpe", "Volpestyle"]);
  assert.match(result.text, /Player 'Volpe' is not known in the current world state\./);
  assert.match(result.text, /Now following Volpestyle/);

  session.close();
});

test("MinecraftSession rejects natural-language turns when the brain is unavailable", async () => {
  const session = createMinecraftSession({
    scopeKey: "guild-1:channel-1",
    baseUrl: "http://minecraft.test",
    ownerUserId: "user-1",
    knownIdentities: [{ mcUsername: "Steve", relationship: "friend" }]
  });

  const result = await session.runTurn("follow me");

  assert.equal(result.isError, true);
  assert.match(result.text, /Minecraft brain is unavailable/i);

  session.close();
});

test("MinecraftSession keeps explicit structured commands working when the brain is unavailable", async () => {
  const session = createMinecraftSession({
    scopeKey: "guild-1:channel-1",
    baseUrl: "http://minecraft.test",
    ownerUserId: "user-1",
    knownIdentities: [{ mcUsername: "Steve", relationship: "friend" }]
  });

  const runtime = session.runtime as unknown as {
    connect: (options?: Record<string, unknown>, signal?: AbortSignal) => Promise<{ ok: true; output: McpStatusSnapshot }>;
    status: (signal?: AbortSignal) => Promise<{ ok: true; output: McpStatusSnapshot }>;
    stop: () => Promise<{ ok: true; output: { ok: true } }>;
  };

  runtime.connect = async () => ({ ok: true, output: createConnectedStatus() });
  runtime.status = async () => ({ ok: true, output: createConnectedStatus() });
  runtime.stop = async () => ({ ok: true, output: { ok: true } });

  const result = await session.runTurn(JSON.stringify({ command: "status" }));

  assert.equal(result.isError, false);
  assert.match(result.text, /Connected as ClankyBuddy\./);

  session.close();
});

test("MinecraftSession logs server target deltas when the brain rewrites the server target", async () => {
  const lifecycleLogs: Array<Record<string, unknown>> = [];
  const brain = createFakeBrain(
    {
      kind: "connect",
      target: {
        host: "new.example.test"
      }
    },
    "Switching worlds."
  );
  const session = createMinecraftSession({
    scopeKey: "guild-1:channel-1",
    baseUrl: "http://minecraft.test",
    ownerUserId: "user-1",
    knownIdentities: [{ mcUsername: "Steve", relationship: "friend" }],
    serverTarget: {
      label: "Survival SMP",
      host: "old.example.test",
      port: 25565,
      description: "Primary operator world"
    },
    brain,
    logAction(entry) {
      lifecycleLogs.push(entry);
    }
  });

  const runtime = session.runtime as unknown as {
    connect: (options?: Record<string, unknown>, signal?: AbortSignal) => Promise<{ ok: true; output: McpStatusSnapshot }>;
    status: (signal?: AbortSignal) => Promise<{ ok: true; output: McpStatusSnapshot }>;
    stop: () => Promise<{ ok: true; output: { ok: true } }>;
  };

  runtime.connect = async () => ({ ok: true, output: createConnectedStatus() });
  runtime.status = async () => ({
    ok: true,
    output: createConnectedStatus({
      connected: false,
      username: undefined,
      position: undefined,
      task: "disconnected"
    })
  });
  runtime.stop = async () => ({ ok: true, output: { ok: true } });

  const result = await session.runTurn("connect to the updated world");

  assert.equal(result.isError, false);
  const updateLog = lifecycleLogs.find((entry) =>
    entry.content === "minecraft_server_target_updated" &&
    typeof entry.metadata === "object" &&
    entry.metadata !== null &&
    (entry.metadata as { source?: string }).source === "brain_action"
  ) as { metadata?: Record<string, unknown> } | undefined;
  assert.ok(updateLog, "expected minecraft_server_target_updated log");
  assert.deepEqual(updateLog?.metadata?.previousServerTarget, {
    label: "Survival SMP",
    host: "old.example.test",
    port: 25565,
    description: "Primary operator world"
  });
  assert.deepEqual(updateLog?.metadata?.serverTarget, {
    label: "Survival SMP",
    host: "new.example.test",
    port: 25565,
    description: "Primary operator world"
  });
  assert.deepEqual(updateLog?.metadata?.changedFields, ["host"]);

  session.close();
});

test("MinecraftSession flows Discord context into brain planTurn and replyToChat via getRecentDiscordContext callback", async () => {
  const plannerDiscordContexts: DiscordContextMessage[][] = [];
  const chatDiscordContexts: DiscordContextMessage[][] = [];
  const brain: MinecraftBrain = {
    async planTurn(context) {
      plannerDiscordContexts.push([...context.discordContext]);
      return {
        goal: null,
        subgoals: [],
        progress: [],
        summary: "Standing by.",
        shouldContinue: false,
        action: { kind: "wait" },
        costUsd: 0
      };
    },
    async replyToChat(context) {
      chatDiscordContexts.push([...context.discordContext]);
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

  let callCount = 0;
  const session = createMinecraftSession({
    scopeKey: "guild-1:channel-1",
    baseUrl: "http://minecraft.test",
    ownerUserId: "user-1",
    knownIdentities: [{ mcUsername: "Steve", relationship: "friend" }],
    getRecentDiscordContext: () => {
      callCount += 1;
      return [
        { speaker: "Volpe", text: "help Alice get wood", timestamp: "2026-04-04T12:00:00Z", isBot: false },
        { speaker: "Alice", text: "ok cool", timestamp: "2026-04-04T12:00:05Z", isBot: false }
      ];
    },
    brain
  });

  const result = await session.runTurn("status check");
  assert.equal(result.isError, false);

  // Planner saw the Discord context on its first (and only) checkpoint.
  assert.equal(plannerDiscordContexts.length, 1);
  assert.equal(plannerDiscordContexts[0]?.length, 2);
  assert.equal(plannerDiscordContexts[0]?.[0]?.speaker, "Volpe");
  assert.equal(plannerDiscordContexts[0]?.[0]?.text, "help Alice get wood");
  assert.equal(plannerDiscordContexts[0]?.[1]?.speaker, "Alice");

  // Callback was pulled once per brain invocation.
  assert.equal(callCount, 1);
  assert.equal(chatDiscordContexts.length, 0);

  session.close();
});

test("MinecraftSession tolerates missing or throwing getRecentDiscordContext by passing an empty array to the brain", async () => {
  const seenContexts: DiscordContextMessage[][] = [];
  const brain: MinecraftBrain = {
    async planTurn(context) {
      seenContexts.push([...context.discordContext]);
      return {
        goal: null,
        subgoals: [],
        progress: [],
        summary: "Standing by.",
        shouldContinue: false,
        action: { kind: "wait" },
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

  // No callback at all — brain still gets an empty array, not undefined.
  const sessionA = createMinecraftSession({
    scopeKey: "guild-1:channel-1",
    baseUrl: "http://minecraft.test",
    ownerUserId: "user-1",
    knownIdentities: [{ mcUsername: "Steve", relationship: "friend" }],
    brain
  });
  await sessionA.runTurn("status");
  assert.equal(seenContexts.length, 1);
  assert.deepEqual(seenContexts[0], []);
  sessionA.close();

  // Throwing callback — brain still gets an empty array.
  const sessionB = createMinecraftSession({
    scopeKey: "guild-1:channel-2",
    baseUrl: "http://minecraft.test",
    ownerUserId: "user-1",
    knownIdentities: [{ mcUsername: "Steve", relationship: "friend" }],
    getRecentDiscordContext: () => {
      throw new Error("store unavailable");
    },
    brain
  });
  await sessionB.runTurn("status");
  assert.equal(seenContexts.length, 2);
  assert.deepEqual(seenContexts[1], []);
  sessionB.close();
});

test("MinecraftSession queues in-game chat during cooldown and later flushes the backlog to the brain", async () => {
  const seenChatContexts: Array<{
    sender: string;
    message: string;
    pendingTexts: string[];
  }> = [];
  const brain: MinecraftBrain = {
    async planTurn() {
      return {
        goal: null,
        subgoals: [],
        progress: [],
        summary: "Standing by.",
        shouldContinue: false,
        action: { kind: "wait" },
        costUsd: 0
      };
    },
    async replyToChat(context) {
      seenChatContexts.push({
        sender: context.sender,
        message: context.message,
        pendingTexts: context.sessionState.pendingInGameMessages.map((entry) => entry.text)
      });
      return {
        goal: null,
        subgoals: [],
        progress: ["Caught up on queued in-game chat."],
        summary: "Processed queued chat.",
        chatText: "caught up",
        action: { kind: "wait" },
        costUsd: 0
      };
    }
  };

  const session = createMinecraftSession({
    scopeKey: "guild-1:channel-1",
    baseUrl: "http://minecraft.test",
    ownerUserId: "user-1",
    knownIdentities: [{ mcUsername: "Steve", relationship: "friend" }],
    brain
  });

  const runtime = session.runtime as unknown as {
    status: (signal?: AbortSignal) => Promise<{ ok: true; output: McpStatusSnapshot }>;
    chat: (message: string, signal?: AbortSignal) => Promise<{ ok: true; output: { ok: true; message: string } }>;
    stop: () => Promise<{ ok: true; output: { ok: true } }>;
  };

  const sentChats: string[] = [];
  runtime.status = async () => ({ ok: true, output: createConnectedStatus() });
  runtime.chat = async (message) => {
    sentChats.push(message);
    return { ok: true, output: { ok: true, message } };
  };
  runtime.stop = async () => ({ ok: true, output: { ok: true } });

  (session as unknown as { lastChatReplyMs: number }).lastChatReplyMs = Date.now();

  await (session as unknown as {
    handleIncomingChat: (message: { sender: string; text: string; timestamp: string; isBot: boolean }) => Promise<void>;
  }).handleIncomingChat({
    sender: "Alice",
    text: "hey clanky",
    timestamp: "2026-04-04T12:00:00Z",
    isBot: false
  });
  await (session as unknown as {
    handleIncomingChat: (message: { sender: string; text: string; timestamp: string; isBot: boolean }) => Promise<void>;
  }).handleIncomingChat({
    sender: "Bob",
    text: "come here",
    timestamp: "2026-04-04T12:00:01Z",
    isBot: false
  });

  assert.equal(seenChatContexts.length, 0);
  assert.deepEqual(
    (session as unknown as { getPlannerStateSnapshot: () => { pendingInGameMessages: Array<{ text: string }> } })
      .getPlannerStateSnapshot()
      .pendingInGameMessages
      .map((entry) => entry.text),
    ["hey clanky", "come here"]
  );

  (session as unknown as { lastChatReplyMs: number }).lastChatReplyMs = 0;
  await (session as unknown as { flushPendingInGameMessages: () => Promise<void> }).flushPendingInGameMessages();

  assert.equal(seenChatContexts.length, 1);
  assert.deepEqual(seenChatContexts[0], {
    sender: "Bob",
    message: "come here",
    pendingTexts: ["hey clanky", "come here"]
  });
  assert.deepEqual(sentChats, ["caught up"]);
  assert.deepEqual(
    (session as unknown as { getPlannerStateSnapshot: () => { pendingInGameMessages: Array<{ text: string }> } })
      .getPlannerStateSnapshot()
      .pendingInGameMessages,
    []
  );

  session.close();
});

test("MinecraftSession forwards typed game events and routes typed chat events into the brain", async () => {
  const seenGameEvents: MinecraftGameEvent[][] = [];
  const seenChatInvocations: Array<{ sender: string; message: string }> = [];
  const brain: MinecraftBrain = {
    async planTurn() {
      return {
        goal: null,
        subgoals: [],
        progress: [],
        summary: "Standing by.",
        shouldContinue: false,
        action: { kind: "wait" },
        costUsd: 0
      };
    },
    async replyToChat(context) {
      seenChatInvocations.push({ sender: context.sender, message: context.message });
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
    knownIdentities: [{ mcUsername: "Steve", relationship: "friend" }],
    brain,
    onGameEvent(events) {
      seenGameEvents.push(events);
    }
  });

  const runtime = session.runtime as unknown as {
    status: (signal?: AbortSignal) => Promise<{ ok: true; output: McpStatusSnapshot }>;
    stop: () => Promise<{ ok: true; output: { ok: true } }>;
  };

  const recentEvents: MinecraftGameEvent[] = [
    { type: "player_join", timestamp: "2026-04-04T12:00:00Z", summary: "player joined: Alice", playerName: "Alice" },
    { type: "chat", timestamp: "2026-04-04T12:00:01Z", summary: "chat<Alice> hey clanky", sender: "Alice", message: "hey clanky", isBot: false }
  ];
  runtime.status = async () => ({ ok: true, output: createConnectedStatus({ recentEvents }) });
  runtime.stop = async () => ({ ok: true, output: { ok: true } });

  await (session as unknown as { tickReflexesAndEvents: () => Promise<void> }).tickReflexesAndEvents();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(seenGameEvents.length, 1);
  assert.equal(seenGameEvents[0]?.[0]?.type, "player_join");
  assert.equal(seenGameEvents[0]?.[1]?.type, "chat");
  assert.deepEqual(seenChatInvocations, [{ sender: "Alice", message: "hey clanky" }]);

  session.close();
});

test("MinecraftSession enriches planner world snapshots with visible block projection", async () => {
  const seenVisualScenes: Array<MinecraftVisualScene | null> = [];
  const brain: MinecraftBrain = {
    async planTurn(context) {
      seenVisualScenes.push(context.worldSnapshot?.visualScene ?? null);
      return {
        goal: null,
        subgoals: [],
        progress: [],
        summary: "Reading the surroundings.",
        shouldContinue: false,
        action: { kind: "wait" },
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

  const session = createMinecraftSession({
    scopeKey: "guild-1:channel-1",
    baseUrl: "http://minecraft.test",
    ownerUserId: "user-1",
    knownIdentities: [{ mcUsername: "Steve", relationship: "friend" }],
    brain
  });

  const runtime = session.runtime as unknown as {
    status: (signal?: AbortSignal) => Promise<{ ok: true; output: McpStatusSnapshot }>;
    visibleBlocks: (maxDistance?: number, maxBlocks?: number, signal?: AbortSignal) => Promise<{ ok: true; output: MinecraftVisualScene }>;
    stop: () => Promise<{ ok: true; output: { ok: true } }>;
  };

  const visualScene: MinecraftVisualScene = {
    sampledFrom: { x: 0, y: 64, z: 0 },
    blocks: [
      { name: "oak_log", position: { x: 1, y: 64, z: -2 }, relative: { x: 1, y: 0, z: -2 }, distance: 2.2 }
    ],
    nearbyEntities: [
      { name: "Steve", type: "player", position: { x: 1, y: 64, z: -3 }, distance: 3.1 }
    ],
    skyVisible: true,
    enclosed: false,
    notableFeatures: ["trees nearby", "open sky"]
  };
  runtime.status = async () => ({ ok: true, output: createConnectedStatus() });
  runtime.visibleBlocks = async () => ({ ok: true, output: visualScene });
  runtime.stop = async () => ({ ok: true, output: { ok: true } });

  const result = await session.runTurn("what's ahead");

  assert.equal(result.isError, false);
  assert.equal(seenVisualScenes.length, 1);
  assert.deepEqual(seenVisualScenes[0], visualScene);

  session.close();
});

test("MinecraftSession lets the same planner capture a rendered glance and inspect it on the next checkpoint", async () => {
  const seenLookImageCounts: number[] = [];
  const seenLookCaptureWidths: Array<number | null> = [];
  let checkpointCount = 0;
  const brain: MinecraftBrain = {
    async planTurn(context) {
      checkpointCount += 1;
      seenLookImageCounts.push(context.lookImageInputs.length);
      seenLookCaptureWidths.push(context.lookCapture?.width ?? null);

      if (checkpointCount === 1) {
        return {
          goal: "Check what the build actually looks like",
          subgoals: ["take a rendered glance"],
          progress: [],
          summary: "Taking a rendered look first.",
          shouldContinue: true,
          action: { kind: "look" },
          costUsd: 0.02
        };
      }

      return {
        goal: null,
        subgoals: ["react to the scene"],
        progress: ["Saw the rendered scene."],
        summary: "Judging the scene from that glance.",
        shouldContinue: false,
        action: { kind: "wait" },
        costUsd: 0.01
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
    knownIdentities: [{ mcUsername: "Steve", relationship: "friend" }],
    brain
  });

  const runtime = session.runtime as unknown as {
    connect: (options?: Record<string, unknown>, signal?: AbortSignal) => Promise<{ ok: true; output: McpStatusSnapshot }>;
    status: (signal?: AbortSignal) => Promise<{ ok: true; output: McpStatusSnapshot }>;
    visibleBlocks: (maxDistance?: number, maxBlocks?: number, signal?: AbortSignal) => Promise<{ ok: false; output: never }>;
    look: (width?: number, height?: number, viewDistance?: number, signal?: AbortSignal) => Promise<{
      ok: true;
      output: {
        mediaType: string;
        dataBase64: string;
        width: number;
        height: number;
        capturedAt: string;
        viewpoint: {
          position: { x: number; y: number; z: number };
          yaw: number | null;
          pitch: number | null;
        };
      };
    }>;
    stop: () => Promise<{ ok: true; output: { ok: true } }>;
  };

  runtime.connect = async () => ({ ok: true, output: createConnectedStatus() });
  runtime.status = async () => ({ ok: true, output: createConnectedStatus() });
  runtime.visibleBlocks = async () => ({ ok: false, output: null as never });
  runtime.look = async (width = 640, height = 360) => ({
    ok: true,
    output: {
      mediaType: "image/jpeg",
      dataBase64: "Zm9v",
      width,
      height,
      capturedAt: "2026-04-04T12:00:15Z",
      viewpoint: {
        position: { x: 0, y: 64, z: 0 },
        yaw: 0,
        pitch: 0
      }
    }
  });
  runtime.stop = async () => ({ ok: true, output: { ok: true } });

  const result = await session.runTurn("look at the build");

  assert.equal(result.isError, false);
  assert.deepEqual(seenLookImageCounts, [0, 1]);
  assert.deepEqual(seenLookCaptureWidths, [null, 640]);
  assert.match(result.text, /Taking a rendered look first\./);
  assert.match(result.text, /Captured a rendered first-person glance/);
  assert.match(result.text, /Judging the scene from that glance\./);

  session.close();
});
