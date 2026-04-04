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
import type { MinecraftConstraints, MinecraftMode, WorldSnapshot } from "./types.ts";

const TURN_DECISION_JSON_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    command: {
      type: "string",
      description:
        "Exactly one high-level Minecraft command to execute next. Examples: " +
        "connect, disconnect, status, follow Volpestyle, guard Volpestyle, collect 16 oak_log, " +
        "go to 100 64 200, return home, stop, attack, look at Volpestyle, chat On my way."
    }
  },
  required: ["command"],
  additionalProperties: false
});

const CHAT_DECISION_JSON_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    chatText: {
      type: "string",
      description:
        "Minecraft chat reply text. Use an empty string when you should stay silent."
    },
    command: {
      type: "string",
      description:
        "Optional high-level Minecraft command to execute because of the message. Use an empty string when no action is needed."
    }
  },
  required: ["chatText", "command"],
  additionalProperties: false
});

type MinecraftBrainLlm = Pick<LLMService, "generate">;

export type MinecraftChatMessage = {
  sender: string;
  text: string;
  timestamp: string;
  isBot: boolean;
};

type MinecraftBrainSharedContext = {
  chatHistory: MinecraftChatMessage[];
  worldSnapshot: WorldSnapshot | null;
  botUsername: string;
  mode: MinecraftMode;
  operatorPlayerName: string | null;
  constraints: MinecraftConstraints;
};

export type MinecraftTurnContext = MinecraftBrainSharedContext & {
  instruction: string;
};

export type MinecraftTurnDecision = {
  command: string | null;
  costUsd: number;
};

export type MinecraftChatContext = MinecraftBrainSharedContext & {
  sender: string;
  message: string;
};

export type MinecraftChatResult = {
  chatText: string | null;
  gameCommand: string | null;
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
    `Use high-level Minecraft commands when action is useful. Low-level movement, pathfinding, combat mechanics, and block interaction are handled by the runtime tools.`,
    `Do not narrate from outside the game. Behave like a real participant who is there with the players.`,
    ``,
    textGuidance ? `=== GUIDANCE ===\n${textGuidance}\n` : "",
    `=== AVAILABLE HIGH-LEVEL COMMANDS ===`,
    `connect`,
    `disconnect`,
    `status`,
    `follow <player>`,
    `guard <player>`,
    `collect <count> <block>`,
    `go to <x> <y> <z>`,
    `return home`,
    `stop`,
    `attack`,
    `look at <player>`,
    `chat <message>`,
    ``,
    `Only choose commands the runtime already supports. Do not invent crafting, building, chest management, or vision abilities that do not exist yet.`
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
    `Choose the single best next high-level command to execute for the current operator instruction.`,
    `Prefer a concrete action over vague commentary.`,
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
    ``,
    formatChatHistory(context.chatHistory, context.botUsername),
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
    `Decide whether to reply in Minecraft chat, take a high-level Minecraft action, both, or neither.`,
    `Keep chat replies short and natural for Minecraft.`,
    `Use an empty string for chatText when you should stay silent.`,
    `Use an empty string for command when no game action is needed.`,
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
    ``,
    formatChatHistory(context.chatHistory, context.botUsername),
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
      const parsed = safeJsonParseFromString(generation.text, null) as { command?: unknown } | null;
      return {
        command: normalizeInlineText(parsed?.command, 220) || "status",
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
        chatText?: unknown;
        command?: unknown;
      } | null;
      return {
        chatText: normalizeInlineText(parsed?.chatText),
        gameCommand: normalizeInlineText(parsed?.command, 220),
        costUsd: generation.costUsd ?? 0
      };
    }
  };
}
