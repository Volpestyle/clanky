/**
 * Minecraft brain for the embodied in-world agent.
 *
 * Discord text, Discord voice, and Minecraft chat are all just input surfaces
 * into the same Minecraft session. This module owns the LLM-facing planning
 * and chat behavior for that session while Mineflayer remains the low-level
 * executor.
 */

import type { LLMService } from "../../llm.ts";
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
  MinecraftConstraints,
  MinecraftMode,
  MinecraftPlannerState,
  MinecraftServerTarget,
  WorldSnapshot
} from "./types.ts";

const ACTION_KINDS = [
  "wait",
  "connect",
  "disconnect",
  "status",
  "follow",
  "guard",
  "collect",
  "go_to",
  "return_home",
  "stop",
  "chat",
  "attack",
  "look_at"
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
    target: SERVER_TARGET_JSON_SCHEMA
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

export type MinecraftChatMessage = {
  sender: string;
  text: string;
  timestamp: string;
  isBot: boolean;
};

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
  operatorPlayerName: string | null;
  constraints: MinecraftConstraints;
  serverTarget: MinecraftServerTarget | null;
  sessionState: MinecraftPlannerState;
};

export type MinecraftTurnContext = MinecraftBrainSharedContext & {
  instruction: string;
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

function normalizeBrainAction(
  value: unknown,
  operatorPlayerName: string | null,
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
    case "follow": {
      const playerName = normalizeInlineText(record.playerName, 80) || operatorPlayerName || "";
      return playerName
        ? {
            kind: "follow",
            playerName,
            distance: normalizeBoundedNumber(record.distance, 1, 32, true)
          }
        : { kind: fallbackKind };
    }
    case "guard": {
      const playerName = normalizeInlineText(record.playerName, 80) || operatorPlayerName || "";
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
      const playerName = normalizeInlineText(record.playerName, 80) || operatorPlayerName || "";
      return playerName ? { kind: "look_at", playerName } : { kind: fallbackKind };
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

function formatPlannerState(sessionState: MinecraftPlannerState): string {
  return [
    `[Planner state]`,
    `Goal: ${sessionState.activeGoal || "none"}.`,
    `Subgoals: ${sessionState.subgoals.length > 0 ? sessionState.subgoals.join(" | ") : "none"}.`,
    `Progress: ${sessionState.progress.length > 0 ? sessionState.progress.join(" | ") : "none"}.`,
    `Last instruction: ${sessionState.lastInstruction || "none"}.`,
    `Last planner summary: ${sessionState.lastDecisionSummary || "none"}.`,
    `Last action result: ${sessionState.lastActionResult || "none"}.`
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

  if (snapshot.recentEvents.length > 0) {
    parts.push(`Recent events: ${snapshot.recentEvents.slice(-5).join("; ")}.`);
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
  if (constraints.stayNearPlayer) parts.push("stay near the player");
  if (constraints.maxDistance !== undefined) parts.push(`max distance ${constraints.maxDistance} blocks`);
  if (constraints.avoidCombat) parts.push("avoid combat");
  if (Array.isArray(constraints.allowedChests) && constraints.allowedChests.length > 0) {
    parts.push(`allowed chests: ${constraints.allowedChests.join(", ")}`);
  }
  return parts.length > 0 ? parts.join("; ") : "none";
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
    ``,
    textGuidance ? `=== GUIDANCE ===\n${textGuidance}\n` : "",
    `=== AVAILABLE STRUCTURED ACTIONS ===`,
    `wait`,
    `connect { target? }`,
    `disconnect`,
    `status`,
    `follow { playerName, distance? }`,
    `guard { playerName, radius?, followDistance? }`,
    `collect { blockName, count? }`,
    `go_to { x, y, z }`,
    `return_home`,
    `stop`,
    `attack`,
    `look_at { playerName }`,
    `chat { message }`,
    ``,
    `Only choose actions the runtime already supports. Do not invent crafting, building, chest management, or vision abilities that do not exist yet.`
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
    `Prefer a concrete in-world action over vague commentary.`,
    `If the operator is asking what is happening, what you see, or for an update, use status.`,
    `Return JSON only.`
  ].join("\n");
}

function buildTurnUserPrompt(context: MinecraftTurnContext): string {
  return [
    formatWorldContext(context.worldSnapshot, context.botUsername),
    ``,
    `[Session state]`,
    `Mode: ${context.mode}.`,
    `Operator player: ${context.operatorPlayerName || "unknown"}.`,
    `Constraints: ${formatConstraints(context.constraints)}.`,
    `Preferred server target: ${formatServerTarget(context.serverTarget)}.`,
    ``,
    formatPlannerState(context.sessionState),
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
    `Operator player: ${context.operatorPlayerName || "unknown"}.`,
    `Constraints: ${formatConstraints(context.constraints)}.`,
    `Preferred server target: ${formatServerTarget(context.serverTarget)}.`,
    ``,
    formatPlannerState(context.sessionState),
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
        action: normalizeBrainAction(parsed?.action, context.operatorPlayerName, "status"),
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
        action: normalizeBrainAction(parsed?.action, context.operatorPlayerName, "wait"),
        costUsd: generation.costUsd ?? 0
      };
    }
  };
}
