/**
 * MinecraftChatBrain — LLM-powered conversational reply for in-game chat.
 *
 * When another player sends a chat message in Minecraft, the session detects
 * it and delegates to the brain.  The brain builds a prompt with the bot's
 * persona, the current world snapshot, and recent chat history, then calls
 * the same LLM used for Discord text replies.
 *
 * The model can:
 *   - Reply with text  → sent via minecraft_chat
 *   - Emit a game action via [ACTION: ...] prefix → routed to the session's
 *     command parser (follow, guard, collect, go_to, stop, etc.)
 *   - Stay silent via [SKIP] → no chat sent
 *
 * This keeps the agent's behavior in Minecraft chat identical in spirit to
 * Discord text chat — same persona, same reasoning — just with additional
 * game context and the constraint of text-only 256-char messages.
 */

import type { LLMService } from "../../llm.ts";
import type { WorldSnapshot } from "./types.ts";
import { getBotName, getBotNameAliases, getPersonaSettings, getPromptingSettings } from "../../settings/agentStack.ts";

// ── Types ───────────────────────────────────────────────────────────────────

export type MinecraftChatMessage = {
  sender: string;
  text: string;
  timestamp: string;
  isBot: boolean;
};

export type MinecraftChatContext = {
  sender: string;
  message: string;
  chatHistory: MinecraftChatMessage[];
  worldSnapshot: WorldSnapshot | null;
  botUsername: string;
};

export type MinecraftChatResult = {
  /** Text to send as Minecraft chat.  null = stay silent. */
  chatText: string | null;
  /** Optional game command to execute (e.g. "follow Steve", "collect 16 oak_log"). */
  gameCommand: string | null;
  costUsd: number;
};

export type MinecraftChatReplyFn = (context: MinecraftChatContext) => Promise<MinecraftChatResult>;

// ── Prompt building ─────────────────────────────────────────────────────────

function buildSystemPrompt(settings: Record<string, unknown>, botUsername: string): string {
  const botName = getBotName(settings);
  const aliases = getBotNameAliases(settings);
  const persona = getPersonaSettings(settings);
  const prompting = getPromptingSettings(settings);
  const flavor = String(persona?.flavor || "");
  const rawHardLimits = persona?.hardLimits;
  const hardLimits = Array.isArray(rawHardLimits) ? rawHardLimits.join("\n") : String(rawHardLimits || "");
  const rawTextGuidance = prompting?.text?.guidance;
  const textGuidance = Array.isArray(rawTextGuidance) ? rawTextGuidance.join("\n") : String(rawTextGuidance || "");

  const nameList = [botName, ...aliases, botUsername]
    .filter(Boolean)
    .map((n) => n.toLowerCase());
  const nameStr = [...new Set(nameList)].join(", ");

  const sections: string[] = [];

  sections.push(
    `=== IDENTITY ===`,
    `You are ${botName}, playing Minecraft as "${botUsername}".`,
    `You respond to: ${nameStr}.`,
    flavor ? `Style: ${flavor}` : "",
    "",
    `=== MINECRAFT CONTEXT ===`,
    `You are an autonomous companion inside a Minecraft Java world. You see`,
    `the game through structured world state (position, health, inventory,`,
    `nearby players) rather than first-person vision.`,
    ``,
    `You are a REAL participant in this world — you move, fight, build, and`,
    `chat alongside other players. Respond naturally as someone who is`,
    `actually there, not as an AI assistant observing from outside.`,
    ""
  );

  if (textGuidance) {
    sections.push(`=== GUIDANCE ===`, textGuidance, "");
  }

  sections.push(
    `=== CAPABILITIES ===`,
    `In Minecraft chat you can:`,
    `• Respond conversationally to players`,
    `• Take game actions by prefixing your response with [ACTION: <command>]`,
    `  Available commands: follow <player>, guard <player>, collect <count> <block>,`,
    `  go to <x> <y> <z>, stop, attack, return home, chat <message>`,
    `  Example: [ACTION: follow Steve] Sure, I'm right behind you!`,
    `• Stay silent by responding with exactly [SKIP]`,
    ``,
    `You CANNOT: send images, play music, share files, or use Discord-specific features.`,
    ""
  );

  if (hardLimits) {
    sections.push(`=== LIMITS ===`, hardLimits, "");
  }

  sections.push(
    `=== OUTPUT FORMAT ===`,
    `Respond with ONLY the text to send in Minecraft chat.`,
    `Keep responses concise — ideally under 200 characters. Minecraft chat`,
    `is casual and fast. Multi-paragraph essays feel wrong here.`,
    ``,
    `If a game action is warranted, prefix your message with [ACTION: <command>].`,
    `The action prefix is stripped before sending; only the text after it is chatted.`,
    ``,
    `If the message is not directed at you, is not interesting, or does not`,
    `need a reply, respond with exactly: [SKIP]`,
    ``,
    `NEVER prefix your response with your own name (e.g. "Clanky: ...").`,
    `The game client adds the username automatically.`
  );

  return sections.filter(Boolean).join("\n");
}

function formatWorldContext(snapshot: WorldSnapshot | null, botUsername: string): string {
  if (!snapshot || !snapshot.connected || !snapshot.self) {
    return `[World: connected as ${botUsername}, details unavailable]`;
  }

  const s = snapshot.self;
  const parts: string[] = [];
  parts.push(`Connected as ${botUsername}.`);
  parts.push(`Position: ${s.position.x.toFixed(0)}, ${s.position.y.toFixed(0)}, ${s.position.z.toFixed(0)}.`);
  parts.push(`Health: ${s.health}/${s.maxHealth}. Food: ${s.food}/20.`);
  parts.push(`Dimension: ${s.dimension}. Mode: ${snapshot.mode}.`);

  if (snapshot.player) {
    parts.push(`Primary player: ${snapshot.player.name} (${snapshot.player.distance.toFixed(0)}m).`);
  }
  if (snapshot.nearbyPlayers.length > 0) {
    const others = snapshot.nearbyPlayers
      .slice(0, 5)
      .map((p) => `${p.name} (${p.distance.toFixed(0)}m)`)
      .join(", ");
    parts.push(`Other nearby: ${others}.`);
  }

  if (snapshot.task) {
    parts.push(`Current task: ${snapshot.task.goal}.`);
  }

  if (s.inventorySummary.length > 0) {
    const items = s.inventorySummary
      .slice(0, 8)
      .map((i) => `${i.count}x ${i.name}`)
      .join(", ");
    parts.push(`Inventory: ${items}${s.inventorySummary.length > 8 ? " ..." : ""}.`);
  }

  if (snapshot.timeOfDay !== null) {
    parts.push(`Time of day: ${snapshot.timeOfDay}.`);
  }

  return parts.join(" ");
}

function buildUserPrompt(context: MinecraftChatContext): string {
  const parts: string[] = [];

  // World state
  parts.push(`[Current world state]`);
  parts.push(formatWorldContext(context.worldSnapshot, context.botUsername));
  parts.push("");

  // Recent chat history (last N messages for context)
  if (context.chatHistory.length > 0) {
    parts.push(`[Recent chat history]`);
    for (const msg of context.chatHistory.slice(-15)) {
      const prefix = msg.isBot ? `${context.botUsername}` : msg.sender;
      parts.push(`<${prefix}> ${msg.text}`);
    }
    parts.push("");
  }

  // The incoming message to respond to
  parts.push(`[New message to respond to]`);
  parts.push(`<${context.sender}> ${context.message}`);

  return parts.join("\n");
}

// ── Response parsing ────────────────────────────────────────────────────────

const ACTION_RE = /^\[ACTION:\s*(.+?)\]\s*/i;
const SKIP_RE = /^\[SKIP\]\s*$/i;

function parseResponse(raw: string): { chatText: string | null; gameCommand: string | null } {
  const trimmed = raw.trim();

  // [SKIP] → silence
  if (SKIP_RE.test(trimmed)) {
    return { chatText: null, gameCommand: null };
  }

  // [ACTION: <command>] <text>
  const actionMatch = trimmed.match(ACTION_RE);
  if (actionMatch) {
    const gameCommand = actionMatch[1].trim();
    const chatText = trimmed.slice(actionMatch[0].length).trim() || null;
    return { chatText, gameCommand };
  }

  // Plain text response
  return { chatText: trimmed || null, gameCommand: null };
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a Minecraft chat reply function bound to an LLM service and settings.
 *
 * The returned function is safe to call concurrently — each call is a fresh
 * LLM generation with no shared mutable state.
 */
export function createMinecraftChatBrain(
  llm: LLMService,
  getSettings: () => Record<string, unknown>
): MinecraftChatReplyFn {
  return async (context: MinecraftChatContext): Promise<MinecraftChatResult> => {
    const settings = getSettings();
    const systemPrompt = buildSystemPrompt(settings, context.botUsername);
    const userPrompt = buildUserPrompt(context);

    const generation = await llm.generate({
      settings,
      systemPrompt,
      userPrompt,
      trace: {
        source: "minecraft_chat_brain",
        sessionId: undefined
      }
    });

    const parsed = parseResponse(generation.text);

    return {
      chatText: parsed.chatText,
      gameCommand: parsed.gameCommand,
      costUsd: generation.costUsd ?? 0
    };
  };
}
