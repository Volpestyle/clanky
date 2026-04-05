/**
 * Minecraft brain for the embodied in-world agent.
 *
 * Discord text, Discord voice, and Minecraft chat are all just input surfaces
 * into the same Minecraft session. This module owns the LLM-facing planning
 * and chat behavior for that session while Mineflayer remains the low-level
 * executor.
 */

import type { LLMService } from "../../llm.ts";
import type { ImageInput } from "../../llm/serviceShared.ts";
import { safeJsonParseFromString } from "../../normalization/valueParsers.ts";
import {
  applyOrchestratorOverrideSettings,
  getBotName,
  getBotNameAliases,
  getPersonaSettings,
  getPromptingSettings,
  getResolvedMinecraftBrainBinding
} from "../../settings/agentStack.ts";
import type {
  MinecraftBrainAction,
  MinecraftChatMessage,
  MinecraftConstraints,
  MinecraftLookCapture,
  MinecraftMode,
  MinecraftPlannerState,
  MinecraftPlayerIdentity,
  MinecraftServerCatalogEntry,
  MinecraftServerTarget,
  WorldSnapshot
} from "./types.ts";

export type { MinecraftChatMessage } from "./types.ts";

const ACTION_KINDS = [
  "wait",
  "connect",
  "disconnect",
  "status",
  "look",
  "follow",
  "guard",
  "collect",
  "go_to",
  "return_home",
  "stop",
  "chat",
  "attack",
  "look_at",
  "eat",
  "equip_offhand",
  "craft",
  "deposit",
  "withdraw",
  "place_block",
  "build",
  "project_start",
  "project_step",
  "project_pause",
  "project_resume",
  "project_abort"
] as const;

const SERVER_TARGET_JSON_SCHEMA = {
  type: "object",
  properties: {
    label: {
      type: "string",
      description: "Short human-facing world/server label, for example Survival SMP."
    },
    host: {
      type: "string",
      description: "Minecraft server hostname or IP when known."
    },
    port: {
      type: "integer",
      description: "Minecraft server port when it matters."
    },
    description: {
      type: "string",
      description: "Short note about this world/server."
    }
  },
  additionalProperties: false
};

const CHEST_COORD_JSON_SCHEMA = {
  type: "object",
  properties: {
    x: { type: "integer" },
    y: { type: "integer" },
    z: { type: "integer" }
  },
  required: ["x", "y", "z"],
  additionalProperties: false
};

const ITEM_REQUEST_JSON_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    count: { type: "integer" }
  },
  required: ["name", "count"],
  additionalProperties: false
};

const BUILD_PLAN_JSON_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    clearFirst: { type: "boolean" },
    blocks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          x: { type: "integer" },
          y: { type: "integer" },
          z: { type: "integer" },
          blockName: { type: "string" }
        },
        required: ["x", "y", "z", "blockName"],
        additionalProperties: false
      }
    }
  },
  required: ["title", "blocks"],
  additionalProperties: false
};

const ACTION_JSON_SCHEMA = {
  type: "object",
  properties: {
    kind: {
      type: "string",
      enum: [...ACTION_KINDS],
      description: "Structured next action for the embodied Minecraft teammate."
    },
    playerName: { type: "string" },
    distance: { type: "number" },
    radius: { type: "number" },
    followDistance: { type: "number" },
    blockName: { type: "string" },
    count: { type: "integer" },
    x: { type: "number" },
    y: { type: "number" },
    z: { type: "number" },
    message: { type: "string" },
    target: SERVER_TARGET_JSON_SCHEMA,
    itemName: { type: "string" },
    recipeName: { type: "string" },
    useCraftingTable: { type: "boolean" },
    chest: CHEST_COORD_JSON_SCHEMA,
    items: { type: "array", items: ITEM_REQUEST_JSON_SCHEMA },
    plan: BUILD_PLAN_JSON_SCHEMA,
    description: { type: "string" },
    origin: CHEST_COORD_JSON_SCHEMA,
    dimensions: {
      type: "object",
      properties: {
        width: { type: "integer" },
        height: { type: "integer" },
        depth: { type: "integer" }
      },
      required: ["width", "height", "depth"],
      additionalProperties: false
    },
    title: { type: "string" },
    checkpoints: { type: "array", items: { type: "string" } },
    actionBudget: { type: "integer" },
    summary: { type: "string" },
    reason: { type: "string" }
  },
  required: ["kind"],
  additionalProperties: false
};

const TURN_DECISION_JSON_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    goal: {
      type: "string",
      description: "Longer-horizon in-world goal. Use an empty string when unchanged or not needed."
    },
    subgoals: {
      type: "array",
      items: { type: "string" },
      description: "Current short subgoals/checkpoints for that goal."
    },
    progress: {
      type: "array",
      items: { type: "string" },
      description: "Important progress notes worth carrying across turns."
    },
    summary: {
      type: "string",
      description: "Short checkpoint summary for session memory. Use an empty string when unnecessary."
    },
    shouldContinue: {
      type: "boolean",
      description: "True only when the session should immediately re-checkpoint after this action in the same turn."
    },
    action: ACTION_JSON_SCHEMA
  },
  required: ["goal", "subgoals", "progress", "summary", "shouldContinue", "action"],
  additionalProperties: false
});

const CHAT_DECISION_JSON_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    goal: {
      type: "string",
      description: "Longer-horizon in-world goal. Use an empty string when unchanged or not needed."
    },
    subgoals: {
      type: "array",
      items: { type: "string" }
    },
    progress: {
      type: "array",
      items: { type: "string" }
    },
    summary: {
      type: "string",
      description: "Short checkpoint summary for session memory. Use an empty string when unnecessary."
    },
    chatText: {
      type: "string",
      description:
        "Minecraft chat reply text. Use an empty string when you should stay silent."
    },
    action: ACTION_JSON_SCHEMA
  },
  required: ["goal", "subgoals", "progress", "summary", "chatText", "action"],
  additionalProperties: false
});

type MinecraftBrainLlm = Pick<LLMService, "generate">;

/**
 * A single Discord message lifted into the Minecraft brain's context.
 *
 * These are labeled and kept separate from `MinecraftChatMessage` so the
 * brain can reason about surface-of-origin (Discord channel vs MC chat)
 * when deciding whether/how to reply in Minecraft.
 */
export type DiscordContextMessage = {
  speaker: string;
  text: string;
  timestamp: string;
  isBot: boolean;
};

type MinecraftBrainSharedContext = {
  chatHistory: MinecraftChatMessage[];
  /**
   * Recent messages from the Discord channel/scope that owns this Minecraft
   * session. Empty when the session has no Discord channel (or when the
   * scope is owner-private and should not leak into MC chat).
   */
  discordContext: DiscordContextMessage[];
  worldSnapshot: WorldSnapshot | null;
  botUsername: string;
  mode: MinecraftMode;
  /**
   * Optional Discord↔Minecraft identity bridge the operator has configured.
   * Background context, not a permission list — the brain still forms its
   * own impressions from chat, behavior, and memory.
   */
  knownIdentities: MinecraftPlayerIdentity[];
  constraints: MinecraftConstraints;
  serverTarget: MinecraftServerTarget | null;
  serverCatalog: MinecraftServerCatalogEntry[];
  sessionState: MinecraftPlannerState;
};

export type MinecraftTurnContext = MinecraftBrainSharedContext & {
  instruction: string;
  lookCapture: MinecraftLookCapture | null;
  lookImageInputs: ImageInput[];
};

export type MinecraftTurnDecision = {
  goal: string | null;
  subgoals: string[];
  progress: string[];
  summary: string | null;
  shouldContinue: boolean;
  action: MinecraftBrainAction;
  costUsd: number;
};

export type MinecraftChatContext = MinecraftBrainSharedContext & {
  sender: string;
  message: string;
};

export type MinecraftChatResult = {
  goal: string | null;
  subgoals: string[];
  progress: string[];
  summary: string | null;
  chatText: string | null;
  action: MinecraftBrainAction;
  costUsd: number;
};

export type MinecraftBrain = {
  planTurn: (context: MinecraftTurnContext) => Promise<MinecraftTurnDecision>;
  replyToChat: (context: MinecraftChatContext) => Promise<MinecraftChatResult>;
};

function normalizeInlineText(value: unknown, maxLen = 240): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLen);
}

function normalizeTextArray(value: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(value)) return [];
  const unique = new Set<string>();
  for (const entry of value) {
    const normalized = normalizeInlineText(entry, maxLen);
    if (!normalized) continue;
    unique.add(normalized);
    if (unique.size >= maxItems) break;
  }
  return [...unique];
}

function normalizeBoundedNumber(
  value: unknown,
  min: number,
  max: number,
  round = false
): number | undefined {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return undefined;
  const bounded = Math.max(min, Math.min(max, numeric));
  return round ? Math.round(bounded) : bounded;
}

function normalizeServerTarget(value: unknown): MinecraftServerTarget | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const label = normalizeInlineText(record.label, 80);
  const host = normalizeInlineText(record.host, 200);
  const port = normalizeBoundedNumber(record.port, 1, 65535, true) ?? null;
  const description = normalizeInlineText(record.description, 160);
  if (!label && !host && !port && !description) return null;
  return {
    label,
    host,
    port,
    description
  };
}

function normalizeItemRequests(raw: unknown): Array<{ name: string; count: number }> {
  if (!Array.isArray(raw)) return [];
  const items: Array<{ name: string; count: number }> = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const name = normalizeInlineText(record.name, 80)?.replace(/\s+/g, "_");
    const count = normalizeBoundedNumber(record.count, 1, 512, true);
    if (name && count !== undefined) {
      items.push({ name, count });
    }
    if (items.length >= 16) break;
  }
  return items;
}

function normalizeChestCoords(raw: unknown): { x: number; y: number; z: number } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const x = normalizeBoundedNumber(record.x, -30_000_000, 30_000_000, true);
  const y = normalizeBoundedNumber(record.y, -256, 512, true);
  const z = normalizeBoundedNumber(record.z, -30_000_000, 30_000_000, true);
  if (x === undefined || y === undefined || z === undefined) return null;
  return { x, y, z };
}

function normalizeBuildPlan(raw: unknown): {
  title: string;
  blocks: Array<{ x: number; y: number; z: number; blockName: string }>;
  clearFirst?: boolean;
} | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const title = normalizeInlineText(record.title, 80) || "build";
  const clearFirst = record.clearFirst === true;
  const rawBlocks = Array.isArray(record.blocks) ? record.blocks : [];
  const blocks: Array<{ x: number; y: number; z: number; blockName: string }> = [];
  for (const entry of rawBlocks) {
    if (!entry || typeof entry !== "object") continue;
    const blockRecord = entry as Record<string, unknown>;
    const x = normalizeBoundedNumber(blockRecord.x, -30_000_000, 30_000_000, true);
    const y = normalizeBoundedNumber(blockRecord.y, -256, 512, true);
    const z = normalizeBoundedNumber(blockRecord.z, -30_000_000, 30_000_000, true);
    const blockName = normalizeInlineText(blockRecord.blockName, 80)?.replace(/\s+/g, "_");
    if (x === undefined || y === undefined || z === undefined || !blockName) continue;
    blocks.push({ x, y, z, blockName });
    if (blocks.length >= 256) break;
  }
  if (blocks.length === 0) return null;
  return { title, blocks, ...(clearFirst ? { clearFirst: true } : {}) };
}

function normalizeDimensions(raw: unknown): { width: number; height: number; depth: number } | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const width = normalizeBoundedNumber(record.width, 1, 32, true);
  const height = normalizeBoundedNumber(record.height, 1, 32, true);
  const depth = normalizeBoundedNumber(record.depth, 1, 32, true);
  if (width === undefined || height === undefined || depth === undefined) return undefined;
  return { width, height, depth };
}

function normalizeBrainAction(
  value: unknown,
  fallbackKind: "status" | "wait" = "status"
): MinecraftBrainAction {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const kind = normalizeInlineText(record.kind, 40)?.toLowerCase();

  switch (kind) {
    case "wait":
      return { kind: "wait" };
    case "connect": {
      const target = normalizeServerTarget(record.target);
      return target ? { kind: "connect", target } : { kind: "connect" };
    }
    case "disconnect":
      return { kind: "disconnect" };
    case "status":
      return { kind: "status" };
    case "look":
      return { kind: "look" };
    case "follow": {
      // No operator fallback — the brain must name a player explicitly.
      // Without a name the action becomes a status/wait so the brain can
      // re-ground and ask who, instead of silently targeting an "operator".
      const playerName = normalizeInlineText(record.playerName, 80) || "";
      return playerName
        ? {
            kind: "follow",
            playerName,
            distance: normalizeBoundedNumber(record.distance, 1, 32, true)
          }
        : { kind: fallbackKind };
    }
    case "guard": {
      const playerName = normalizeInlineText(record.playerName, 80) || "";
      return playerName
        ? {
            kind: "guard",
            playerName,
            radius: normalizeBoundedNumber(record.radius, 1, 32, true),
            followDistance: normalizeBoundedNumber(record.followDistance, 1, 32, true)
          }
        : { kind: fallbackKind };
    }
    case "collect": {
      const blockName = normalizeInlineText(record.blockName, 80)?.replace(/\s+/g, "_") || "";
      return blockName
        ? {
            kind: "collect",
            blockName,
            count: normalizeBoundedNumber(record.count, 1, 512, true)
          }
        : { kind: fallbackKind };
    }
    case "go_to": {
      const x = normalizeBoundedNumber(record.x, -30_000_000, 30_000_000);
      const y = normalizeBoundedNumber(record.y, -256, 512);
      const z = normalizeBoundedNumber(record.z, -30_000_000, 30_000_000);
      return x !== undefined && y !== undefined && z !== undefined
        ? { kind: "go_to", x, y, z }
        : { kind: fallbackKind };
    }
    case "return_home":
      return { kind: "return_home" };
    case "stop":
      return { kind: "stop" };
    case "chat": {
      const message = normalizeInlineText(record.message, 240);
      return message ? { kind: "chat", message } : { kind: fallbackKind };
    }
    case "attack":
      return { kind: "attack" };
    case "look_at": {
      const playerName = normalizeInlineText(record.playerName, 80) || "";
      return playerName ? { kind: "look_at", playerName } : { kind: fallbackKind };
    }
    case "eat":
      return { kind: "eat" };
    case "equip_offhand": {
      const itemName = normalizeInlineText(record.itemName, 80)?.replace(/\s+/g, "_") || "";
      return itemName ? { kind: "equip_offhand", itemName } : { kind: fallbackKind };
    }
    case "craft": {
      const recipeName = normalizeInlineText(record.recipeName, 80)?.replace(/\s+/g, "_") || "";
      if (!recipeName) return { kind: fallbackKind };
      const count = normalizeBoundedNumber(record.count, 1, 128, true);
      const useCraftingTable = record.useCraftingTable === true;
      return {
        kind: "craft",
        recipeName,
        ...(count !== undefined ? { count } : {}),
        useCraftingTable
      };
    }
    case "deposit":
    case "withdraw": {
      const chest = normalizeChestCoords(record.chest);
      const items = normalizeItemRequests(record.items);
      if (!chest || items.length === 0) return { kind: fallbackKind };
      return kind === "deposit"
        ? { kind: "deposit", chest, items }
        : { kind: "withdraw", chest, items };
    }
    case "place_block": {
      const x = normalizeBoundedNumber(record.x, -30_000_000, 30_000_000, true);
      const y = normalizeBoundedNumber(record.y, -256, 512, true);
      const z = normalizeBoundedNumber(record.z, -30_000_000, 30_000_000, true);
      const blockName = normalizeInlineText(record.blockName, 80)?.replace(/\s+/g, "_");
      if (x === undefined || y === undefined || z === undefined || !blockName) {
        return { kind: fallbackKind };
      }
      return { kind: "place_block", x, y, z, blockName };
    }
    case "build": {
      const plan = normalizeBuildPlan(record.plan);
      const description = normalizeInlineText(record.description, 200);
      if (!plan && !description) return { kind: fallbackKind };
      const origin = normalizeChestCoords(record.origin);
      const dimensions = normalizeDimensions(record.dimensions);
      return {
        kind: "build",
        ...(plan ? { plan } : {}),
        ...(description ? { description } : {}),
        ...(origin ? { origin } : {}),
        ...(dimensions ? { dimensions } : {})
      };
    }
    case "project_start": {
      const title = normalizeInlineText(record.title, 80) || "project";
      const description = normalizeInlineText(record.description, 400) || "";
      const checkpointsRaw = Array.isArray(record.checkpoints) ? record.checkpoints : [];
      const checkpoints: string[] = [];
      for (const entry of checkpointsRaw) {
        const checkpoint = normalizeInlineText(entry, 120);
        if (checkpoint) checkpoints.push(checkpoint);
        if (checkpoints.length >= 8) break;
      }
      const actionBudget = normalizeBoundedNumber(record.actionBudget, 1, 200, true);
      return {
        kind: "project_start",
        title,
        description,
        checkpoints,
        ...(actionBudget !== undefined ? { actionBudget } : {})
      };
    }
    case "project_step": {
      const summary = normalizeInlineText(record.summary, 200);
      return { kind: "project_step", ...(summary ? { summary } : {}) };
    }
    case "project_pause": {
      const reason = normalizeInlineText(record.reason, 200);
      return { kind: "project_pause", ...(reason ? { reason } : {}) };
    }
    case "project_resume":
      return { kind: "project_resume" };
    case "project_abort": {
      const reason = normalizeInlineText(record.reason, 200);
      return { kind: "project_abort", ...(reason ? { reason } : {}) };
    }
    default:
      return { kind: fallbackKind };
  }
}

function formatServerTarget(serverTarget: MinecraftServerTarget | null): string {
  if (!serverTarget) return "none configured";
  const parts = [serverTarget.label, serverTarget.host].filter(Boolean);
  if (serverTarget.port) parts.push(`port ${serverTarget.port}`);
  if (serverTarget.description) parts.push(serverTarget.description);
  return parts.length > 0 ? parts.join("; ") : "none configured";
}

function formatServerCatalog(catalog: MinecraftServerCatalogEntry[]): string {
  if (!Array.isArray(catalog) || catalog.length === 0) return "none";
  return catalog
    .slice(0, 8)
    .map((entry) => {
      const parts = [entry.label];
      if (entry.host) parts.push(entry.host);
      if (entry.port) parts.push(`port ${entry.port}`);
      if (entry.description) parts.push(entry.description);
      return parts.join("; ");
    })
    .join(" || ");
}

function formatPlannerState(sessionState: MinecraftPlannerState): string {
  const failure = sessionState.lastActionFailure;
  const project = sessionState.activeProject;
  const projectLine = project
    ? `Active project: "${project.title}" (${project.status}, ${project.actionsUsed}/${project.actionBudget} actions, ${project.completedCheckpoints.length}/${project.checkpoints.length} checkpoints).${project.description ? ` Desc: ${project.description}` : ""}${project.lastStepSummary ? ` Last step: ${project.lastStepSummary}` : ""}`
    : `Active project: none.`;
  return [
    `[Planner state]`,
    `Goal: ${sessionState.activeGoal || "none"}.`,
    `Subgoals: ${sessionState.subgoals.length > 0 ? sessionState.subgoals.join(" | ") : "none"}.`,
    `Progress: ${sessionState.progress.length > 0 ? sessionState.progress.join(" | ") : "none"}.`,
    `Last instruction: ${sessionState.lastInstruction || "none"}.`,
    `Last planner summary: ${sessionState.lastDecisionSummary || "none"}.`,
    `Last action result: ${sessionState.lastActionResult || "none"}.`,
    `Pending in-game messages: ${sessionState.pendingInGameMessages.length}.`,
    failure
      ? `Last action failure: ${failure.actionKind} -> ${failure.reason}. Message: ${failure.message}${failure.didYouMeanPlayerName ? ` Did you mean player: ${failure.didYouMeanPlayerName}.` : ""}`
      : `Last action failure: none.`,
    projectLine
  ].join("\n");
}

function formatPendingInGameMessages(messages: MinecraftChatMessage[], botUsername: string): string {
  if (messages.length <= 0) return "[Pending in-game messages]\n(none)";
  return [
    `[Pending in-game messages]`,
    ...messages.map((message) => {
      const speaker = message.isBot ? botUsername : message.sender;
      return `<${speaker}> ${message.text}`;
    })
  ].join("\n");
}

function formatWorldContext(snapshot: WorldSnapshot | null, botUsername: string): string {
  if (!snapshot || !snapshot.connected || !snapshot.self) {
    return `[World state]\nConnected as ${botUsername} status unavailable or not yet in world.`;
  }

  const self = snapshot.self;
  const parts: string[] = [
    `[World state]`,
    `Connected as ${botUsername}.`,
    `Position: ${self.position.x.toFixed(0)}, ${self.position.y.toFixed(0)}, ${self.position.z.toFixed(0)}.`,
    `Health: ${self.health}/${self.maxHealth}. Food: ${self.food}/20.`,
    `Dimension: ${self.dimension}. Mode: ${snapshot.mode}.`
  ];

  if (snapshot.player) {
    parts.push(`Primary player: ${snapshot.player.name} (${snapshot.player.distance.toFixed(0)}m).`);
  }

  if (snapshot.nearbyPlayers.length > 0) {
    const nearby = snapshot.nearbyPlayers
      .slice(0, 6)
      .map((player) => `${player.name} (${player.distance.toFixed(0)}m)`)
      .join(", ");
    parts.push(`Nearby players: ${nearby}.`);
  }

  if (snapshot.hazards.length > 0) {
    const hazards = snapshot.hazards
      .slice(0, 4)
      .map((hazard) => `${hazard.type} (${hazard.distance.toFixed(0)}m)`)
      .join(", ");
    parts.push(`Hazards: ${hazards}.`);
  }

  if (snapshot.task) {
    parts.push(`Current task: ${snapshot.task.goal}.`);
  }

  if (self.inventorySummary.length > 0) {
    const items = self.inventorySummary
      .slice(0, 8)
      .map((item) => `${item.count}x ${item.name}`)
      .join(", ");
    parts.push(`Inventory: ${items}${self.inventorySummary.length > 8 ? " ..." : ""}.`);
  }

  if (snapshot.visualScene) {
    const scene = snapshot.visualScene;
    if (scene.blocks.length > 0) {
      const visibleBlocks = scene.blocks
        .slice(0, 8)
        .map((block) => `${block.name} (${block.relative.x >= 0 ? "+" : ""}${block.relative.x},${block.relative.y >= 0 ? "+" : ""}${block.relative.y},${block.relative.z >= 0 ? "+" : ""}${block.relative.z})`)
        .join(", ");
      parts.push(`Visible blocks ahead: ${visibleBlocks}.`);
    }
    if (scene.nearbyEntities.length > 0) {
      const entities = scene.nearbyEntities
        .slice(0, 6)
        .map((entity) => `${entity.name} [${entity.type}] (${entity.distance.toFixed(0)}m)`)
        .join(", ");
      parts.push(`Entities in view: ${entities}.`);
    }
    parts.push(`Sky visible: ${scene.skyVisible ? "yes" : "no"}. Enclosed: ${scene.enclosed ? "yes" : "no"}.`);
    if (scene.notableFeatures.length > 0) {
      parts.push(`Notable scene features: ${scene.notableFeatures.join(", ")}.`);
    }
  }

  if (snapshot.recentEvents.length > 0) {
    parts.push(`Recent events: ${snapshot.recentEvents.slice(-5).map((event) => `[${event.type}] ${event.summary}`).join("; ")}.`);
  }

  return parts.join(" ");
}

function formatChatHistory(chatHistory: MinecraftChatMessage[], botUsername: string): string {
  if (chatHistory.length <= 0) return "[Recent in-game chat]\n(none)";
  return [
    `[Recent in-game chat]`,
    ...chatHistory.slice(-15).map((message) => {
      const speaker = message.isBot ? botUsername : message.sender;
      return `<${speaker}> ${message.text}`;
    })
  ].join("\n");
}

function formatLookCapture(capture: MinecraftLookCapture | null): string {
  if (!capture) {
    return "[Rendered first-person glance]\n(none attached)";
  }

  return [
    `[Rendered first-person glance]`,
    `A rendered first-person Minecraft scene image is attached for this checkpoint.`,
    `Captured at ${capture.capturedAt}. Resolution: ${capture.width}x${capture.height}.`,
    `Viewpoint: ${capture.viewpoint.position.x.toFixed(0)}, ${capture.viewpoint.position.y.toFixed(0)}, ${capture.viewpoint.position.z.toFixed(0)}.`,
    `Use it for aesthetic or social judgment of what the scene actually looks like. Do not rely on it for OCR or exact block counts.`
  ].join("\n");
}

/**
 * Render recent Discord channel messages as a labeled prompt section.
 *
 * Kept separate from in-game chat so the brain can reason about where each
 * message came from (Discord channel vs Minecraft chat) when deciding how to
 * respond in-world.
 */
function formatDiscordContext(discordContext: DiscordContextMessage[], botUsername: string): string {
  if (!discordContext || discordContext.length <= 0) {
    return "[Recent Discord channel context]\n(none)";
  }
  return [
    `[Recent Discord channel context]`,
    ...discordContext.slice(-10).map((message) => {
      const speaker = message.isBot ? botUsername : message.speaker;
      return `<${speaker}> ${message.text}`;
    })
  ].join("\n");
}

function formatConstraints(constraints: MinecraftConstraints): string {
  const parts: string[] = [];
  if (constraints.stayNearPlayer) parts.push(`stay near ${constraints.stayNearPlayer}`);
  if (constraints.maxDistance !== undefined) parts.push(`max distance ${constraints.maxDistance} blocks`);
  if (constraints.avoidCombat) parts.push("avoid combat");
  if (Array.isArray(constraints.allowedChests) && constraints.allowedChests.length > 0) {
    const chestSummary = constraints.allowedChests
      .slice(0, 4)
      .map((chest) => `${chest.label ? `${chest.label}:` : ""}${chest.x},${chest.y},${chest.z}`)
      .join(", ");
    parts.push(`allowed chests: ${chestSummary}`);
  }
  return parts.length > 0 ? parts.join("; ") : "none";
}

/**
 * Render the optional Discord↔Minecraft identity bridge.
 *
 * Framed as background context, not a permission list. Empty is a first-class
 * mode — Clanky forms opinions about MC players organically from chat, memory,
 * and behavior when the operator hasn't pre-configured anyone.
 */
function formatKnownIdentities(identities: MinecraftPlayerIdentity[]): string {
  if (!identities || identities.length === 0) {
    return "[Known identities] none configured — treat every MC player as a peer and form your own impressions from what they say, how they act, and memory.";
  }
  const lines = identities.slice(0, 32).map((entry) => {
    const pieces = [`${entry.label || entry.mcUsername}`];
    if (entry.relationship) pieces.push(`(${entry.relationship})`);
    const suffix: string[] = [`MC: ${entry.mcUsername}`];
    if (entry.discordUsername) suffix.push(`Discord: ${entry.discordUsername}`);
    let line = `- ${pieces.join(" ")} — ${suffix.join(", ")}`;
    if (entry.notes) line += `. ${entry.notes}`;
    return line;
  });
  return [
    "[Known identities] background address book from your operator (not a permission list; decide trust from behavior)",
    ...lines
  ].join("\n");
}

function buildSharedSystemPrompt(settings: Record<string, unknown>, botUsername: string): string {
  const botName = getBotName(settings);
  const aliases = getBotNameAliases(settings);
  const persona = getPersonaSettings(settings);
  const prompting = getPromptingSettings(settings);
  const flavor = String(persona?.flavor || "").trim();
  const rawHardLimits = persona?.hardLimits;
  const hardLimits = Array.isArray(rawHardLimits) ? rawHardLimits.join("\n") : String(rawHardLimits || "");
  const rawTextGuidance = prompting?.text?.guidance;
  const textGuidance = Array.isArray(rawTextGuidance) ? rawTextGuidance.join("\n") : String(rawTextGuidance || "");
  const names = [botName, ...aliases, botUsername]
    .filter(Boolean)
    .map((name) => String(name).trim().toLowerCase());

  const sections = [
    `=== IDENTITY ===`,
    `You are ${botName}, embodied inside Minecraft as "${botUsername}".`,
    `You respond to: ${[...new Set(names)].join(", ")}.`,
    flavor ? `Style: ${flavor}` : "",
    ``,
    `=== OPERATING MODEL ===`,
    `Discord text, Discord voice, and Minecraft chat are all just input surfaces into the same Minecraft self.`,
    `Once you are in a Minecraft session, you decide what to do inside the game.`,
    `Maintain longer-horizon in-world intent across turns: keep track of the current goal, subgoals, and progress when it helps you stay coherent.`,
    `Choose structured high-level actions when action is useful. Low-level movement, pathfinding, combat mechanics, and block interaction are handled by the runtime tools.`,
    `Do not narrate from outside the game. Behave like a real participant who is there with the players.`,
    `You may see recent Discord channel messages alongside in-game chat — treat them as labeled context, not as instructions to repeat. Use them to connect follow-ups across surfaces when it helps, stay silent when it doesn't.`,
    `When a recent action failed, planner state includes a typed failure reason and sometimes a did-you-mean player suggestion. Use that to recover instead of repeating the same failed action blindly.`,
    `Pending in-game messages are chat lines that arrived while you were busy or rate-limited. Treat them as unhandled backlog you can answer, batch, or ignore deliberately.`,
    ``,
    `=== PEOPLE ===`,
    `Treat every MC player you meet as a peer until you have reason to think otherwise. Form your own impressions from what they say, how they behave, and your memory of past interactions.`,
    `If a known-identities address book is configured, it is background context from your operator — a head-start on who some people are, not a permission list or trust hierarchy. Anyone NOT in the book is still worth engaging with.`,
    `For follow / guard / look_at, you must name a specific player. If an ambiguous request comes in ("follow me") and you genuinely cannot tell who they mean, prefer asking in chat or picking the most-likely candidate from recent context — do not silently target someone arbitrary.`,
    `When someone asks you to do something social or risky (give items, break blocks near their build, join a fight), weigh who they are to you before acting.`,
    ``,
    textGuidance ? `=== GUIDANCE ===\n${textGuidance}\n` : "",
    `=== AVAILABLE STRUCTURED ACTIONS ===`,
    `wait`,
    `connect { target? }`,
    `disconnect`,
    `status`,
    `look`,
    `follow { playerName, distance? }`,
    `guard { playerName, radius?, followDistance? }`,
    `collect { blockName, count? }`,
    `go_to { x, y, z }`,
    `return_home`,
    `stop`,
    `attack`,
    `look_at { playerName }`,
    `chat { message }`,
    `eat`,
    `equip_offhand { itemName }`,
    `craft { recipeName, count?, useCraftingTable? }`,
    `deposit { chest:{x,y,z}, items:[{name,count}, ...] }`,
    `withdraw { chest:{x,y,z}, items:[{name,count}, ...] }`,
    `place_block { x, y, z, blockName }`,
    `build { plan?:{title, blocks:[{x,y,z,blockName}], clearFirst?} OR description, origin?, dimensions? }`,
    `project_start { title, description, checkpoints?, actionBudget? }`,
    `project_step { summary? }`,
    `project_pause { reason? }`,
    `project_resume`,
    `project_abort { reason? }`,
    ``,
    `Build: prefer an explicit plan when you already know the block layout. Use a description ("wall 5x3", "floor 4x4", "pillar 5", "box 3x3x3", "hollow_box 4x4x4", or a short freeform sketch) when you want the sub-planner to expand it. Keep builds small — the skill caps at 256 blocks per plan.`,
    `Project loop: use project_start to begin a long-horizon goal, project_step after each concrete action to log progress (match checkpoint names to tick them off), and project_abort when you decide to stop. Budget is a cost cap; when it trips, the project auto-pauses.`,
    `Chest workflows honor constraints.allowedChests — if a chest isn't in the allowed list, the skill rejects the action.`,
    `Use look for an actual rendered first-person glance when someone wants your reaction to what a build, landscape, or scene looks like. Use look_at first if you need to face a person or focal point before capturing that glance.`,
    `You may still pass on crafting/building when it isn't the right moment — wait and [SKIP] are first-class.`
  ];

  if (hardLimits) {
    sections.push("", `=== LIMITS ===`, hardLimits);
  }

  return sections.filter(Boolean).join("\n");
}

function buildTurnSystemPrompt(settings: Record<string, unknown>, botUsername: string): string {
  return [
    buildSharedSystemPrompt(settings, botUsername),
    ``,
    `=== TASK ===`,
    `Choose the best next structured action for the current operator instruction and current planner checkpoint.`,
    `Update goal, subgoals, and progress when that improves continuity.`,
    `Set shouldContinue=true only when the session should immediately checkpoint again after this action in the same turn. Typical examples: connect first, then follow; status first, then decide.`,
    `When planner state shows a lastActionFailure, prefer a direct recovery step: retry with the suggested player name, use status to re-ground, or choose a better alternative action.`,
    `Use look when you need an actual rendered first-person glance. After look, usually set shouldContinue=true so the next checkpoint can inspect the attached image.`,
    `Prefer a concrete in-world action over vague commentary.`,
    `If the operator is asking what is happening, what you see, or for an update, use status.`,
    `Return JSON only.`
  ].join("\n");
}

function buildTurnUserPrompt(context: MinecraftTurnContext): string {
  return [
    formatWorldContext(context.worldSnapshot, context.botUsername),
    ``,
    formatLookCapture(context.lookCapture),
    ``,
    `[Session state]`,
    `Mode: ${context.mode}.`,
    `Constraints: ${formatConstraints(context.constraints)}.`,
    `Preferred server target: ${formatServerTarget(context.serverTarget)}.`,
    `Server catalog: ${formatServerCatalog(context.serverCatalog)}.`,
    ``,
    formatKnownIdentities(context.knownIdentities),
    ``,
    formatPlannerState(context.sessionState),
    ``,
    formatPendingInGameMessages(context.sessionState.pendingInGameMessages, context.botUsername),
    ``,
    formatChatHistory(context.chatHistory, context.botUsername),
    ``,
    formatDiscordContext(context.discordContext, context.botUsername),
    ``,
    `[New instruction from Discord/community]`,
    context.instruction
  ].join("\n");
}

function buildChatSystemPrompt(settings: Record<string, unknown>, botUsername: string): string {
  return [
    buildSharedSystemPrompt(settings, botUsername),
    ``,
    `=== TASK ===`,
    `Decide whether to reply in Minecraft chat, take a structured Minecraft action, both, or neither.`,
    `Update goal, subgoals, and progress when that improves continuity.`,
    `Keep chat replies short and natural for Minecraft.`,
    `Use an empty string for chatText when you should stay silent.`,
    `Use action.kind="wait" when no game action is needed.`,
    `Return JSON only.`
  ].join("\n");
}

function buildChatUserPrompt(context: MinecraftChatContext): string {
  return [
    formatWorldContext(context.worldSnapshot, context.botUsername),
    ``,
    `[Session state]`,
    `Mode: ${context.mode}.`,
    `Constraints: ${formatConstraints(context.constraints)}.`,
    `Preferred server target: ${formatServerTarget(context.serverTarget)}.`,
    `Server catalog: ${formatServerCatalog(context.serverCatalog)}.`,
    ``,
    formatKnownIdentities(context.knownIdentities),
    ``,
    formatPlannerState(context.sessionState),
    ``,
    formatPendingInGameMessages(context.sessionState.pendingInGameMessages, context.botUsername),
    ``,
    formatChatHistory(context.chatHistory, context.botUsername),
    ``,
    formatDiscordContext(context.discordContext, context.botUsername),
    ``,
    `[New in-game chat message]`,
    `<${context.sender}> ${context.message}`
  ].join("\n");
}

function buildBrainSettings(settings: Record<string, unknown>) {
  const binding = getResolvedMinecraftBrainBinding(settings);
  return applyOrchestratorOverrideSettings(settings, {
    provider: binding.provider,
    model: binding.model,
    temperature: binding.temperature,
    maxOutputTokens: binding.maxOutputTokens,
    reasoningEffort: binding.reasoningEffort
  });
}

export function createMinecraftBrain(
  llm: MinecraftBrainLlm,
  getSettings: () => Record<string, unknown>
): MinecraftBrain {
  return {
    async planTurn(context: MinecraftTurnContext): Promise<MinecraftTurnDecision> {
      const settings = getSettings();
      const generation = await llm.generate({
        settings: buildBrainSettings(settings),
        systemPrompt: buildTurnSystemPrompt(settings, context.botUsername),
        userPrompt: buildTurnUserPrompt(context),
        imageInputs: context.lookImageInputs,
        jsonSchema: TURN_DECISION_JSON_SCHEMA,
        trace: {
          source: "minecraft_brain_turn",
          sessionId: context.worldSnapshot?.sessionId
        }
      });
      const parsed = safeJsonParseFromString(generation.text, null) as {
        goal?: unknown;
        subgoals?: unknown;
        progress?: unknown;
        summary?: unknown;
        shouldContinue?: unknown;
        action?: unknown;
      } | null;
      return {
        goal: normalizeInlineText(parsed?.goal, 160),
        subgoals: normalizeTextArray(parsed?.subgoals, 6, 120),
        progress: normalizeTextArray(parsed?.progress, 8, 160),
        summary: normalizeInlineText(parsed?.summary, 220),
        shouldContinue: parsed?.shouldContinue === true,
        action: normalizeBrainAction(parsed?.action, "status"),
        costUsd: generation.costUsd ?? 0
      };
    },

    async replyToChat(context: MinecraftChatContext): Promise<MinecraftChatResult> {
      const settings = getSettings();
      const generation = await llm.generate({
        settings: buildBrainSettings(settings),
        systemPrompt: buildChatSystemPrompt(settings, context.botUsername),
        userPrompt: buildChatUserPrompt(context),
        jsonSchema: CHAT_DECISION_JSON_SCHEMA,
        trace: {
          source: "minecraft_brain_chat",
          sessionId: context.worldSnapshot?.sessionId
        }
      });
      const parsed = safeJsonParseFromString(generation.text, null) as {
        goal?: unknown;
        subgoals?: unknown;
        progress?: unknown;
        summary?: unknown;
        chatText?: unknown;
        action?: unknown;
      } | null;
      return {
        goal: normalizeInlineText(parsed?.goal, 160),
        subgoals: normalizeTextArray(parsed?.subgoals, 6, 120),
        progress: normalizeTextArray(parsed?.progress, 8, 160),
        summary: normalizeInlineText(parsed?.summary, 220),
        chatText: normalizeInlineText(parsed?.chatText),
        action: normalizeBrainAction(parsed?.action, "wait"),
        costUsd: generation.costUsd ?? 0
      };
    }
  };
}
