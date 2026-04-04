/**
 * MinecraftSession — extends BaseAgentSession for the Minecraft agent.
 *
 * Each session wraps a MinecraftRuntime (HTTP client to the MCP server) and
 * an embodied Minecraft brain. Discord text, Discord voice, and Minecraft
 * chat all feed intent/context into the same session brain, which decides the
 * next high-level Minecraft command. The runtime then executes that command
 * deterministically through the MCP/Mineflayer stack.
 *
 * The session is long-lived — it stays alive across multiple turns until the
 * user disconnects or cancels.
 *
 * Key runtime behaviors:
 *   - **Auto-connect**: Commands that need a bot auto-connect to the
 *     Minecraft server on first use (host resolved by MCP server via
 *     S3 discovery / MC_HOST env / localhost fallback).
 *   - **Reflex tick**: A background loop polls status every few seconds,
 *     evaluates deterministic reflexes (eat, flee, attack), and fires them.
 *   - **Event tracking**: New game events (chat, death, combat) are diffed
 *     against the last-seen watermark and forwarded via an optional
 *     `onGameEvent` callback for proactive narration.
 */

import { BaseAgentSession } from "../baseAgentSession.ts";
import { EMPTY_USAGE, generateSessionId } from "../subAgentSession.ts";
import type { SubAgentTurnOptions, SubAgentTurnResult } from "../subAgentSession.ts";
import type {
  MinecraftBrainAction,
  MinecraftConstraints,
  MinecraftMode,
  MinecraftPlannerState,
  MinecraftServerTarget,
  Position
} from "./types.ts";
import { MinecraftRuntime, type McpStatusSnapshot } from "./minecraftRuntime.ts";
import { buildWorldSnapshot } from "./minecraftWorldModel.ts";
import { evaluateReflexes, executeReflex } from "./minecraftReflexes.ts";
import type { MinecraftBrain, MinecraftChatMessage } from "./minecraftBrain.ts";
import { FollowPlayerSkill } from "./skills/followPlayer.ts";
import { GuardPlayerSkill } from "./skills/guardPlayer.ts";
import { CollectBlockSkill } from "./skills/collectBlock.ts";
import { ReturnHomeSkill } from "./skills/returnHome.ts";

// ── Constants ───────────────────────────────────────────────────────────────

/** How often the background reflex/event loop ticks (ms). */
const REFLEX_TICK_INTERVAL_MS = 5_000;

/** Max consecutive tick failures before the loop self-disables. */
const MAX_TICK_FAILURES = 5;

/** Max chat history entries kept for brain context. */
const MAX_CHAT_HISTORY = 30;

/** Minimum ms between brain-generated chat replies to avoid spam. */
const CHAT_REPLY_COOLDOWN_MS = 2_000;

/** Max planner checkpoints the embodied brain can take in one turn. */
const MAX_PLANNER_CHECKPOINTS_PER_TURN = 3;

/** Max remembered subgoals in the long-horizon planner state. */
const MAX_PLANNER_SUBGOALS = 6;

/** Max remembered progress notes in the long-horizon planner state. */
const MAX_PLANNER_PROGRESS = 10;

/** Minecraft chat message hard limit. We target slightly under for safety. */
const MC_CHAT_MAX_LEN = 240;

/** Delay between multi-line chat messages (ms). */
const MC_MULTI_LINE_DELAY_MS = 400;

/** Regex to extract chat events from the MCP server's event log.
 *  Format: `<ISO timestamp> chat<Username> message text` */
const CHAT_EVENT_RE = /^\S+\s+chat<(\w+)>\s+(.+)$/;

// ── Turn input ──────────────────────────────────────────────────────────────

type TurnInput = {
  task?: string;
  command?: string;
  mode?: MinecraftMode;
  constraints?: MinecraftConstraints | Record<string, unknown>;
  operatorPlayerName?: string;
  server?: Partial<MinecraftServerTarget> | Record<string, unknown>;
  serverTarget?: Partial<MinecraftServerTarget> | Record<string, unknown>;
};

function parseTurnInput(raw: string): TurnInput {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed) as TurnInput;
    } catch {
      // Not valid JSON — treat as plain text task.
    }
  }
  return { task: trimmed };
}

function toPositiveFiniteNumber(value: unknown): number | undefined {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
  return numeric;
}

function normalizeConstraints(raw: MinecraftConstraints | Record<string, unknown> | undefined): MinecraftConstraints | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const stayNearPlayer = typeof record.stayNearPlayer === "boolean"
    ? record.stayNearPlayer
    : typeof record.stay_near_player === "boolean"
      ? record.stay_near_player
      : undefined;
  const avoidCombat = typeof record.avoidCombat === "boolean"
    ? record.avoidCombat
    : typeof record.avoid_combat === "boolean"
      ? record.avoid_combat
      : undefined;
  const maxDistance = toPositiveFiniteNumber(record.maxDistance ?? record.max_distance);
  const allowedChestsRaw = Array.isArray(record.allowedChests)
    ? record.allowedChests
    : Array.isArray(record.allowed_chests)
      ? record.allowed_chests
      : null;
  const allowedChests = allowedChestsRaw
    ?.map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);

  return {
    ...(stayNearPlayer !== undefined ? { stayNearPlayer } : {}),
    ...(maxDistance !== undefined ? { maxDistance } : {}),
    ...(avoidCombat !== undefined ? { avoidCombat } : {}),
    ...(allowedChests && allowedChests.length > 0 ? { allowedChests } : {})
  };
}

function normalizeMinecraftServerTarget(
  raw: Partial<MinecraftServerTarget> | Record<string, unknown> | undefined | null
): MinecraftServerTarget | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const label = typeof record.label === "string" ? record.label.trim().slice(0, 80) : "";
  const host = typeof record.host === "string" ? record.host.trim().slice(0, 200) : "";
  const description = typeof record.description === "string" ? record.description.trim().slice(0, 160) : "";
  const rawPort = typeof record.port === "number" ? record.port : Number(record.port);
  const port = Number.isFinite(rawPort) && rawPort >= 1 && rawPort <= 65535 ? Math.round(rawPort) : null;
  if (!label && !host && !description && !port) return null;
  return {
    label: label || null,
    host: host || null,
    port,
    description: description || null
  };
}

function mergeServerTargets(
  base: MinecraftServerTarget | null,
  update: MinecraftServerTarget | null
): MinecraftServerTarget | null {
  if (!base) return update;
  if (!update) return base;
  return {
    label: update.label ?? base.label,
    host: update.host ?? base.host,
    port: update.port ?? base.port,
    description: update.description ?? base.description
  };
}

function formatServerTarget(serverTarget: MinecraftServerTarget | null): string {
  if (!serverTarget) return "none configured";
  const parts = [serverTarget.label, serverTarget.host].filter(Boolean);
  if (serverTarget.port) parts.push(`port ${serverTarget.port}`);
  if (serverTarget.description) parts.push(serverTarget.description);
  return parts.length > 0 ? parts.join("; ") : "none configured";
}

function mergePlannerTextEntries(current: string[], next: string[], limit: number): string[] {
  const merged = [...current];
  for (const entry of next) {
    const normalized = String(entry || "").trim();
    if (!normalized) continue;
    if (merged.includes(normalized)) continue;
    merged.push(normalized);
    if (merged.length > limit) {
      merged.splice(0, merged.length - limit);
    }
  }
  return merged;
}

function joinPlannerSummaries(parts: string[]): string {
  const normalized = parts
    .map((part) => String(part || "").trim())
    .filter(Boolean);
  const deduped: string[] = [];
  for (const part of normalized) {
    if (deduped[deduped.length - 1] === part) continue;
    deduped.push(part);
  }
  return deduped.join(" ").trim();
}

function canContinueAfterBrainAction(action: MinecraftBrainAction): boolean {
  return action.kind === "wait"
    || action.kind === "connect"
    || action.kind === "status"
    || action.kind === "chat"
    || action.kind === "look_at";
}

// ── Command parsing ─────────────────────────────────────────────────────────

type ParsedCommand =
  | { kind: "connect"; host?: string; port?: number; username?: string; auth?: string }
  | { kind: "disconnect" }
  | { kind: "status" }
  | { kind: "follow"; playerName: string; distance?: number }
  | { kind: "guard"; playerName: string; radius?: number; followDistance?: number }
  | { kind: "collect"; blockName: string; count: number }
  | { kind: "go_to"; x: number; y: number; z: number }
  | { kind: "return_home" }
  | { kind: "stop" }
  | { kind: "chat"; message: string }
  | { kind: "attack" }
  | { kind: "look_at"; playerName: string };

type CommandExecutionResult = {
  text: string;
  ok: boolean;
};

const COORD_RE = /(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/;

function parseCommand(task: string, mode: MinecraftMode | undefined, operatorPlayerName: string | null): ParsedCommand {
  const lower = task.toLowerCase().trim();

  // Explicit commands
  if (/^connect\b/.test(lower)) return { kind: "connect" };
  if (/^disconnect\b/.test(lower)) return { kind: "disconnect" };
  if (/^status\b/.test(lower)) return { kind: "status" };
  if (/^stop\b|^halt\b|^idle\b/.test(lower)) return { kind: "stop" };

  // Chat
  if (/^(?:chat|say)\s+/.test(lower)) {
    return { kind: "chat", message: task.replace(/^(?:chat|say)\s+/i, "").trim() };
  }

  // Go-to coordinates
  const coordMatch = task.match(COORD_RE);
  if (/^(?:go\s*to|move\s*to|walk\s*to|navigate\s*to)\b/.test(lower) && coordMatch) {
    return {
      kind: "go_to",
      x: Number(coordMatch[1]),
      y: Number(coordMatch[2]),
      z: Number(coordMatch[3])
    };
  }

  // Return home
  if (/\b(?:come\s*home|go\s*home|return\s*home|return)\b/.test(lower)) {
    return { kind: "return_home" };
  }

  // Attack
  if (/^attack\b/.test(lower)) return { kind: "attack" };

  // Look at
  if (/^look\s*at\b/.test(lower)) {
    const name = task.replace(/^look\s*at\s*/i, "").trim();
    return { kind: "look_at", playerName: name || operatorPlayerName || "" };
  }

  // Collect / gather / mine
  const collectMatch = lower.match(/^(?:collect|gather|mine|get)\s+(\d+)?\s*(.+)/);
  if (collectMatch) {
    const count = collectMatch[1] ? Number(collectMatch[1]) : 1;
    const blockName = collectMatch[2].trim().replace(/\s+/g, "_");
    return { kind: "collect", blockName, count };
  }

  // Follow
  if (/\bfollow\b/.test(lower)) {
    const name = extractPlayerName(task, /\bfollow\s+/i, operatorPlayerName);
    return { kind: "follow", playerName: name };
  }

  // Guard / protect / defend
  if (/\b(?:guard|protect|defend)\b/.test(lower)) {
    const name = extractPlayerName(task, /\b(?:guard|protect|defend)\s+/i, operatorPlayerName);
    return { kind: "guard", playerName: name };
  }

  // Mode-based fallback
  if (mode === "companion" || mode === "idle") {
    if (operatorPlayerName) return { kind: "follow", playerName: operatorPlayerName };
    return { kind: "status" };
  }
  if (mode === "guard") {
    if (operatorPlayerName) return { kind: "guard", playerName: operatorPlayerName };
    return { kind: "status" };
  }
  if (mode === "gather") {
    // Try to extract block name from the task
    const words = task.split(/\s+/).filter(Boolean);
    if (words.length > 0) {
      return { kind: "collect", blockName: words.join("_"), count: 1 };
    }
    return { kind: "status" };
  }

  // Unknown — treat as status query
  return { kind: "status" };
}

function extractPlayerName(task: string, prefix: RegExp, fallback: string | null): string {
  const cleaned = task.replace(prefix, "").replace(/\bme\b/gi, "").trim();
  const name = cleaned.split(/\s+/)[0];
  if (name && name.length > 0 && name !== "me") return name;
  return fallback || "";
}

// ── Status formatting ───────────────────────────────────────────────────────

/**
 * Format a status snapshot into a human-readable summary.
 *
 * @param newEvents  If provided, only these events are shown (for incremental
 *                   status updates).  Falls back to the last 3 events from the
 *                   full snapshot when omitted.
 */
function formatStatus(status: McpStatusSnapshot, mode: MinecraftMode, newEvents?: string[]): string {
  if (!status.connected) return "Bot is not connected to any Minecraft server.";

  const parts: string[] = [];
  parts.push(`Connected as ${status.username ?? "unknown"}.`);
  if (status.position) {
    parts.push(`Position: ${status.position.x.toFixed(0)}, ${status.position.y.toFixed(0)}, ${status.position.z.toFixed(0)}.`);
  }
  parts.push(`Mode: ${mode}. Task: ${status.task}.`);
  if (status.health !== undefined) parts.push(`Health: ${status.health}/20.`);
  if (status.food !== undefined) parts.push(`Food: ${status.food}/20.`);
  if (status.dimension) parts.push(`Dimension: ${status.dimension}.`);
  if (status.follow) parts.push(`Following: ${status.follow.playerName}.`);
  if (status.guard) parts.push(`Guarding: ${status.guard.playerName}.`);
  if (status.players && status.players.length > 0) {
    const visible = status.players.filter((p) => p.online && p.username !== status.username);
    if (visible.length > 0) {
      parts.push(`Nearby players: ${visible.map((p) => `${p.username} (${p.distance?.toFixed(0) ?? "?"}m)`).join(", ")}.`);
    }
  }
  const events = newEvents ?? status.recentEvents.slice(-3);
  if (events.length > 0) {
    parts.push(`Recent: ${events.slice(-5).join("; ")}.`);
  }
  return parts.join(" ");
}

// ── Session options ─────────────────────────────────────────────────────────

export type MinecraftSessionOptions = {
  scopeKey: string;
  baseUrl: string;
  ownerUserId: string | null;
  operatorPlayerName?: string | null;
  serverTarget?: MinecraftServerTarget | null;
  mode?: MinecraftMode;
  constraints?: MinecraftConstraints;
  homePosition?: Position | null;
  logAction?: (entry: Record<string, unknown>) => void;
  /**
   * Called when new game events are detected (chat, death, combat, etc.).
   * The outer system can use this for proactive narration in Discord.
   */
  onGameEvent?: (events: string[]) => void;
  /**
   * LLM-powered embodied Minecraft brain.
   * It owns both operator-turn planning and in-game chat behavior.
   */
  brain?: MinecraftBrain;
};

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Split a long message into Minecraft-safe chunks.  Prefers splitting on
 * sentence boundaries, then word boundaries, then hard-truncates.
 */
function splitMinecraftMessage(text: string, maxLen = MC_CHAT_MAX_LEN): string[] {
  if (text.length <= maxLen) return [text];

  const lines: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      lines.push(remaining);
      break;
    }

    // Try sentence boundary (. ! ?) within the limit.
    let splitIdx = -1;
    for (let i = maxLen; i > maxLen * 0.4; i--) {
      if (".!?".includes(remaining[i]) && (i + 1 >= remaining.length || remaining[i + 1] === " ")) {
        splitIdx = i + 1;
        break;
      }
    }

    // Fall back to word boundary.
    if (splitIdx === -1) {
      splitIdx = remaining.lastIndexOf(" ", maxLen);
    }

    // Hard truncate as last resort.
    if (splitIdx <= 0) {
      splitIdx = maxLen;
    }

    lines.push(remaining.slice(0, splitIdx).trimEnd());
    remaining = remaining.slice(splitIdx).trimStart();
  }

  return lines;
}

function clampDistance(value: number | undefined, fallback: number, max = 32): number {
  const normalized = toPositiveFiniteNumber(value);
  if (normalized === undefined) return fallback;
  return Math.max(1, Math.min(max, Math.round(normalized)));
}

function distanceBetweenPositions(left: Position, right: Position): number {
  const dx = left.x - right.x;
  const dy = left.y - right.y;
  const dz = left.z - right.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// ── Session ─────────────────────────────────────────────────────────────────

export class MinecraftSession extends BaseAgentSession {
  readonly runtime: MinecraftRuntime;
  private mode: MinecraftMode;
  private operatorPlayerName: string | null;
  private serverTarget: MinecraftServerTarget | null;
  private constraints: MinecraftConstraints;
  private homePosition: Position | null;
  private turnCount = 0;

  // ── Auto-connect state ──
  private botConnected = false;
  private botUsername: string | null = null;

  // ── Reflex tick loop ──
  private reflexTimer: ReturnType<typeof setInterval> | null = null;
  private reflexTickFailures = 0;

  // ── Event tracking ──
  private seenEventCount = 0;
  private readonly onGameEvent: ((events: string[]) => void) | undefined;

  // ── Minecraft brain ──
  private readonly brain: MinecraftBrain | undefined;
  private readonly chatHistory: MinecraftChatMessage[] = [];
  private plannerState: MinecraftPlannerState;
  private lastChatReplyMs = 0;
  private chatReplyInFlight = false;

  constructor(options: MinecraftSessionOptions) {
    super({
      id: generateSessionId("minecraft", options.scopeKey),
      type: "minecraft",
      ownerUserId: options.ownerUserId,
      logAction: options.logAction
    });
    this.runtime = new MinecraftRuntime(options.baseUrl, options.logAction);
    this.mode = options.mode ?? "companion";
    this.operatorPlayerName = options.operatorPlayerName ?? null;
    this.serverTarget = options.serverTarget ?? null;
    this.constraints = options.constraints ?? {};
    this.homePosition = options.homePosition ?? null;
    this.onGameEvent = options.onGameEvent;
    this.brain = options.brain;
    this.plannerState = {
      activeGoal: null,
      subgoals: [],
      progress: [],
      lastInstruction: null,
      lastDecisionSummary: null,
      lastActionResult: null
    };
  }

  // ── Auto-connect ────────────────────────────────────────────────────────

  /**
   * Ensure the Mineflayer bot is connected to a Minecraft server.
   *
   * If not connected, issues a connect call to the MCP server which resolves
   * the target host via S3 server-info discovery, MC_HOST env, or localhost.
   * Saves the spawn position as home and starts the background reflex loop.
   */
  private async ensureConnected(signal?: AbortSignal): Promise<void> {
    if (this.botConnected) {
      // Cheap fast-path — we think we're connected.  Verify with a quick
      // status probe to catch kicked/crashed states.
      try {
        const probe = await this.runtime.status(signal);
        if (probe.ok && probe.output.connected) return;
        // Bot disconnected underneath us (kicked, server restart, etc.)
        this.botConnected = false;
        this.logLifecycle("minecraft_connection_lost", {});
      } catch {
        // MCP server unreachable — fall through to reconnect attempt.
        this.botConnected = false;
      }
    }

    this.logLifecycle("minecraft_auto_connect", {
      mode: this.mode,
      serverTarget: this.serverTarget
    });
    const result = await this.runtime.connect({
      host: this.serverTarget?.host ?? undefined,
      port: this.serverTarget?.port ?? undefined
    }, signal);
    if (!result.ok) {
      throw new Error(`Auto-connect to Minecraft server failed: ${result.error || "unknown error"}`);
    }

    const status = result.output;
    this.botConnected = true;
    this.botUsername = status.username ?? null;

    // Save spawn position as home.
    if (status.position && !this.homePosition) {
      this.homePosition = { x: status.position.x, y: status.position.y, z: status.position.z };
    }

    // Sync event watermark so we don't replay pre-connect events.
    this.seenEventCount = status.recentEvents.length;

    // Start the background reflex/event loop now that we have a live bot.
    this.startReflexLoop();

    this.logLifecycle("minecraft_auto_connect_ok", {
      username: status.username,
      position: status.position,
      dimension: status.dimension,
      serverTarget: this.serverTarget
    });
  }

  // ── Reflex tick loop ──────────────────────────────────────────────────────

  private startReflexLoop(): void {
    if (this.reflexTimer) return;
    this.reflexTickFailures = 0;
    this.reflexTimer = setInterval(() => {
      void this.tickReflexesAndEvents();
    }, REFLEX_TICK_INTERVAL_MS);
  }

  private stopReflexLoop(): void {
    if (this.reflexTimer) {
      clearInterval(this.reflexTimer);
      this.reflexTimer = null;
    }
  }

  /**
   * Background tick: polls status, evaluates reflexes, and forwards new
   * game events.  Failures are non-fatal but self-disable after too many
   * consecutive errors to avoid log spam on a dead MCP server.
   */
  private async tickReflexesAndEvents(): Promise<void> {
    try {
      const statusResult = await this.runtime.status();
      if (!statusResult.ok || !statusResult.output.connected) {
        this.botConnected = false;
        return;
      }
      this.botConnected = true;
      this.reflexTickFailures = 0;

      const status = statusResult.output;

      // ── Forward new game events + detect chat ──
      const allEvents = status.recentEvents ?? [];
      if (allEvents.length > this.seenEventCount) {
        const newEvents = allEvents.slice(this.seenEventCount);
        this.seenEventCount = allEvents.length;

        // Forward raw events to the outer system.
        if (newEvents.length > 0 && this.onGameEvent) {
          try {
            this.onGameEvent(newEvents);
          } catch {
            // Callback errors are non-fatal.
          }
        }

        // Detect chat messages and route to the session brain.
        if (this.brain) {
          for (const event of newEvents) {
            const chatMatch = event.match(CHAT_EVENT_RE);
            if (chatMatch) {
              const sender = chatMatch[1];
              const text = chatMatch[2];
              const isBot = sender === this.botUsername;
              const timestamp = event.split(" ")[0] || new Date().toISOString();

              // Record ALL messages (including own) for history context.
              this.pushChatHistory({ sender, text, timestamp, isBot });

              // Only trigger the brain for OTHER players' messages.
              if (!isBot) {
                void this.handleIncomingChat(sender, text);
              }
            }
          }
        }
      }

      // ── Evaluate reflexes ──
      const snapshot = buildWorldSnapshot(this.id, this.mode, status, this.operatorPlayerName);
      const action = evaluateReflexes(snapshot, this.constraints);
      if (action.type !== "none") {
        this.logLifecycle("minecraft_reflex_fire", { action: action.type, mode: this.mode });
        await executeReflex(this.runtime, action);
      }
    } catch {
      this.reflexTickFailures += 1;
      if (this.reflexTickFailures >= MAX_TICK_FAILURES) {
        this.logLifecycle("minecraft_reflex_loop_disabled", {
          reason: "too many consecutive failures",
          failures: this.reflexTickFailures
        });
        this.stopReflexLoop();
      }
    }
  }

  // ── Minecraft brain ──────────────────────────────────────────────────────

  private pushChatHistory(msg: MinecraftChatMessage): void {
    this.chatHistory.push(msg);
    if (this.chatHistory.length > MAX_CHAT_HISTORY) {
      this.chatHistory.splice(0, this.chatHistory.length - MAX_CHAT_HISTORY);
    }
  }

  /**
   * Process an incoming Minecraft chat message through the session brain.
   *
   * Applies a cooldown to avoid rapid-fire responses and serializes
   * concurrent calls so only one brain invocation runs at a time.
   */
  private async handleIncomingChat(sender: string, message: string): Promise<void> {
    if (!this.brain) return;
    if (this.chatReplyInFlight) return; // one at a time

    const now = Date.now();
    if (now - this.lastChatReplyMs < CHAT_REPLY_COOLDOWN_MS) return;

    this.chatReplyInFlight = true;
    try {
      const snapshot = await this.getWorldSnapshot();

      const result = await this.brain.replyToChat({
        sender,
        message,
        chatHistory: this.chatHistory.slice(-20),
        worldSnapshot: snapshot,
        botUsername: this.botUsername || "ClankyBuddy",
        mode: this.mode,
        operatorPlayerName: this.operatorPlayerName,
        constraints: { ...this.constraints },
        serverTarget: this.serverTarget,
        sessionState: this.getPlannerStateSnapshot()
      });

      this.applyPlannerDecision({
        goal: result.goal,
        subgoals: result.subgoals,
        progress: result.progress,
        summary: result.summary,
        instruction: message
      });

      this.lastChatReplyMs = Date.now();

      // Send chat reply.
      if (result.chatText) {
        await this.sendMinecraftChat(result.chatText);
      }

      // Execute structured in-world action if the brain requested one.
      if (result.action.kind !== "wait") {
        this.logLifecycle("minecraft_brain_chat_action", {
          sender,
          action: result.action
        });
        try {
          const execution = await this.executeBrainAction(result.action, {
            signal: AbortSignal.timeout(30_000)
          });
          this.recordPlannerActionResult(execution.text, result.action);
        } catch (error) {
          this.logLifecycle("minecraft_brain_chat_action_error", {
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      if (result.costUsd > 0) {
        this.logLifecycle("minecraft_brain_chat_cost", {
          sender,
          costUsd: result.costUsd
        });
      }
    } catch (error) {
      this.logLifecycle("minecraft_chat_reply_error", {
        sender,
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      this.chatReplyInFlight = false;
    }
  }

  /**
   * Send a message in Minecraft chat, splitting for the 256-char limit.
   */
  private async sendMinecraftChat(text: string): Promise<void> {
    const lines = splitMinecraftMessage(text);
    for (let i = 0; i < lines.length; i++) {
      await this.runtime.chat(lines[i]);
      // Record own messages in history for context.
      this.pushChatHistory({
        sender: this.botUsername || "ClankyBuddy",
        text: lines[i],
        timestamp: new Date().toISOString(),
        isBot: true
      });
      // Small delay between multi-line messages so they render in order.
      if (i < lines.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, MC_MULTI_LINE_DELAY_MS));
      }
    }
  }

  private getPlannerStateSnapshot(): MinecraftPlannerState {
    return {
      activeGoal: this.plannerState.activeGoal,
      subgoals: [...this.plannerState.subgoals],
      progress: [...this.plannerState.progress],
      lastInstruction: this.plannerState.lastInstruction,
      lastDecisionSummary: this.plannerState.lastDecisionSummary,
      lastActionResult: this.plannerState.lastActionResult
    };
  }

  private applyPlannerDecision(update: {
    goal?: string | null;
    subgoals?: string[];
    progress?: string[];
    summary?: string | null;
    instruction?: string | null;
  }): void {
    if (update.instruction) {
      this.plannerState.lastInstruction = update.instruction;
    }
    if (update.goal) {
      this.plannerState.activeGoal = update.goal;
    }
    if (Array.isArray(update.subgoals) && update.subgoals.length > 0) {
      this.plannerState.subgoals = update.subgoals.slice(0, MAX_PLANNER_SUBGOALS);
    }
    if (Array.isArray(update.progress) && update.progress.length > 0) {
      this.plannerState.progress = mergePlannerTextEntries(
        this.plannerState.progress,
        update.progress,
        MAX_PLANNER_PROGRESS
      );
    }
    if (update.summary) {
      this.plannerState.lastDecisionSummary = update.summary;
    }
  }

  private clearPlannerGoal(): void {
    this.plannerState.activeGoal = null;
    this.plannerState.subgoals = [];
  }

  private recordPlannerActionResult(resultText: string, action: MinecraftBrainAction): void {
    const normalized = String(resultText || "").trim().slice(0, 220);
    if (normalized) {
      this.plannerState.lastActionResult = normalized;
      this.plannerState.progress = mergePlannerTextEntries(
        this.plannerState.progress,
        [normalized],
        MAX_PLANNER_PROGRESS
      );
    }
    if (action.kind === "stop" || action.kind === "disconnect") {
      this.clearPlannerGoal();
    }
  }

  private buildPlannerStateSummary(): string {
    const parts: string[] = [];
    if (this.serverTarget) {
      parts.push(`Server target: ${formatServerTarget(this.serverTarget)}.`);
    }
    if (this.plannerState.activeGoal) {
      parts.push(`Goal: ${this.plannerState.activeGoal}.`);
    }
    if (this.plannerState.subgoals.length > 0) {
      parts.push(`Subgoals: ${this.plannerState.subgoals.slice(-3).join(" | ")}.`);
    }
    if (this.plannerState.progress.length > 0) {
      parts.push(`Progress: ${this.plannerState.progress.slice(-3).join(" | ")}.`);
    }
    return parts.join(" ").trim();
  }

  private resolveBrainActionCommand(action: MinecraftBrainAction): ParsedCommand {
    switch (action.kind) {
      case "connect": {
        const target = mergeServerTargets(this.serverTarget, normalizeMinecraftServerTarget(action.target));
        return {
          kind: "connect",
          host: target?.host ?? undefined,
          port: target?.port ?? undefined
        };
      }
      case "disconnect":
        return { kind: "disconnect" };
      case "status":
        return { kind: "status" };
      case "follow":
        return { kind: "follow", playerName: action.playerName, distance: action.distance };
      case "guard":
        return {
          kind: "guard",
          playerName: action.playerName,
          radius: action.radius,
          followDistance: action.followDistance
        };
      case "collect":
        return { kind: "collect", blockName: action.blockName, count: action.count ?? 1 };
      case "go_to":
        return { kind: "go_to", x: action.x, y: action.y, z: action.z };
      case "return_home":
        return { kind: "return_home" };
      case "stop":
        return { kind: "stop" };
      case "chat":
        return { kind: "chat", message: action.message };
      case "attack":
        return { kind: "attack" };
      case "look_at":
        return { kind: "look_at", playerName: action.playerName };
      case "wait":
      default:
        return { kind: "status" };
    }
  }

  private async executeBrainAction(
    action: MinecraftBrainAction,
    options: SubAgentTurnOptions
  ): Promise<CommandExecutionResult> {
    if (action.kind === "wait") {
      return {
        text: this.buildPlannerStateSummary() || "Standing by in Minecraft.",
        ok: true
      };
    }

    if (action.kind === "connect") {
      const updatedTarget = mergeServerTargets(this.serverTarget, normalizeMinecraftServerTarget(action.target));
      if (updatedTarget) {
        this.serverTarget = updatedTarget;
        this.logLifecycle("minecraft_server_target_updated", {
          source: "brain_action",
          serverTarget: this.serverTarget
        });
      }
    }

    return this.executeCommand(this.resolveBrainActionCommand(action), options);
  }

  private async runPlannerLoop(
    task: string,
    options: SubAgentTurnOptions
  ): Promise<{ text: string; costUsd: number }> {
    if (!this.brain) {
      return { text: task, costUsd: 0 };
    }

    const instruction = task.trim();
    if (instruction) {
      this.plannerState.lastInstruction = instruction;
    }

    let checkpointInstruction = instruction || this.plannerState.lastInstruction || "status";
    let costUsd = 0;
    const summaries: string[] = [];

    for (let checkpoint = 1; checkpoint <= MAX_PLANNER_CHECKPOINTS_PER_TURN; checkpoint += 1) {
      const snapshot = await this.getWorldSnapshot();
      const decision = await this.brain.planTurn({
        instruction: checkpointInstruction,
        chatHistory: this.chatHistory.slice(-20),
        worldSnapshot: snapshot,
        botUsername: this.botUsername || "ClankyBuddy",
        mode: this.mode,
        operatorPlayerName: this.operatorPlayerName,
        constraints: { ...this.constraints },
        serverTarget: this.serverTarget,
        sessionState: this.getPlannerStateSnapshot()
      });

      costUsd += decision.costUsd;
      this.applyPlannerDecision({
        goal: decision.goal,
        subgoals: decision.subgoals,
        progress: decision.progress,
        summary: decision.summary,
        instruction: checkpoint === 1 ? instruction : undefined
      });
      this.logLifecycle("minecraft_planner_checkpoint", {
        checkpoint,
        instruction: checkpointInstruction,
        action: decision.action,
        shouldContinue: decision.shouldContinue,
        costUsd: decision.costUsd,
        plannerState: this.getPlannerStateSnapshot(),
        serverTarget: this.serverTarget
      });

      if (decision.summary) {
        summaries.push(decision.summary);
      }

      if (decision.action.kind === "wait") {
        break;
      }

      const execution = await this.executeBrainAction(decision.action, options);
      summaries.push(execution.text);
      this.recordPlannerActionResult(execution.text, decision.action);

      if (!execution.ok || !decision.shouldContinue || !canContinueAfterBrainAction(decision.action)) {
        break;
      }

      checkpointInstruction = "Continue the current Minecraft goal using the updated world state and planner state.";
    }

    return {
      text: joinPlannerSummaries(summaries) || this.buildPlannerStateSummary() || "Standing by in Minecraft.",
      costUsd
    };
  }

  // ── Turn execution ────────────────────────────────────────────────────────

  protected async executeTurn(input: string, options: SubAgentTurnOptions): Promise<SubAgentTurnResult> {
    this.turnCount += 1;
    const parsed = parseTurnInput(input);
    const normalizedConstraints = normalizeConstraints(parsed.constraints);
    const normalizedServerTarget = normalizeMinecraftServerTarget(parsed.serverTarget ?? parsed.server);

    // Apply structured fields if present
    if (parsed.mode) this.mode = parsed.mode;
    if (normalizedConstraints) this.constraints = { ...this.constraints, ...normalizedConstraints };
    if (parsed.operatorPlayerName) this.operatorPlayerName = parsed.operatorPlayerName;
    if (normalizedServerTarget) {
      this.serverTarget = mergeServerTargets(this.serverTarget, normalizedServerTarget);
      this.logLifecycle("minecraft_server_target_updated", {
        source: "turn_input",
        serverTarget: this.serverTarget
      });
    }

    const task = parsed.task || "";
    let command = parsed.command ? parseCommand(parsed.command, this.mode, this.operatorPlayerName) : null;
    let costUsd = 0;
    if (!command && !task) {
      command = { kind: "status" };
    }
    if (!command && task && !this.brain) {
      command = parseCommand(task, this.mode, this.operatorPlayerName);
    }

    const startMs = Date.now();
    this.logLifecycle("minecraft_turn_start", {
      turnCount: this.turnCount,
      command: command?.kind || "planner",
      mode: this.mode,
      task,
      serverTarget: this.serverTarget,
      plannerState: this.getPlannerStateSnapshot()
    });

    try {
      let resultText = "";
      let resultCostUsd = 0;

      if (command) {
        const execution = await this.executeCommand(command, options);
        resultText = execution.text;
        if (task.trim()) {
          this.plannerState.lastInstruction = task.trim();
        }
        this.plannerState.lastActionResult = execution.text.trim().slice(0, 220) || this.plannerState.lastActionResult;
        if (command.kind === "stop" || command.kind === "disconnect") {
          this.clearPlannerGoal();
        }
      } else {
        const planned = await this.runPlannerLoop(task, options);
        resultText = planned.text;
        resultCostUsd = planned.costUsd;
      }

      const durationMs = Date.now() - startMs;
      this.logLifecycle("minecraft_turn_complete", {
        turnCount: this.turnCount,
        command: command?.kind || "planner",
        durationMs,
        resultLength: resultText.length,
        plannerState: this.getPlannerStateSnapshot()
      });
      return {
        text: resultText,
        costUsd: costUsd + resultCostUsd,
        isError: false,
        errorMessage: "",
        sessionCompleted: false,
        usage: { ...EMPTY_USAGE }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logLifecycle("minecraft_turn_error", {
        turnCount: this.turnCount,
        command: command?.kind || "planner",
        error: message
      });
      return {
        text: `Minecraft command failed: ${message}`,
        costUsd,
        isError: true,
        errorMessage: message,
        usage: { ...EMPTY_USAGE }
      };
    }
  }

  private async executeCommand(
    command: ParsedCommand,
    options: SubAgentTurnOptions
  ): Promise<CommandExecutionResult> {
    // Auto-connect for any command that needs a live bot.
    // connect/disconnect manage the connection explicitly.
    if (command.kind !== "connect" && command.kind !== "disconnect") {
      await this.ensureConnected(options.signal);
    }

    const withPlannerContext = (text: string) => {
      const plannerSummary = this.buildPlannerStateSummary();
      return plannerSummary ? `${text} ${plannerSummary}`.trim() : text;
    };

    const commandResult = (text: string, ok = true): CommandExecutionResult => ({ text, ok });

    const resolveFollowDistance = (explicitDistance?: number) => {
      const constrainedDistance = this.constraints.maxDistance;
      return clampDistance(explicitDistance ?? constrainedDistance, 3, 16);
    };

    const resolveCollectDistance = () => {
      if (this.constraints.maxDistance === undefined) return 32;
      return clampDistance(this.constraints.maxDistance, 32, 32);
    };

    const violatesStayNearConstraint = async (target: Position): Promise<{ distance: number; maxDistance: number } | null> => {
      if (!this.constraints.stayNearPlayer || !this.operatorPlayerName || this.constraints.maxDistance === undefined) {
        return null;
      }
      const status = await this.runtime.status(options.signal);
      if (!status.ok) return null;
      const operator = (status.output.players ?? []).find(
        (player) => player.username === this.operatorPlayerName && player.position
      );
      if (!operator?.position) return null;
      const distance = distanceBetweenPositions(target, operator.position);
      return distance > this.constraints.maxDistance
        ? { distance, maxDistance: this.constraints.maxDistance }
        : null;
    };

    switch (command.kind) {
      case "connect": {
        const result = await this.runtime.connect({
          host: command.host ?? this.serverTarget?.host ?? undefined,
          port: command.port ?? this.serverTarget?.port ?? undefined,
          username: command.username,
          auth: command.auth
        }, options.signal);
        if (!result.ok) return commandResult(`Connection failed: ${result.error || "unknown error"}`, false);
        const status = result.output;
        this.botConnected = true;
        this.botUsername = status.username ?? null;
        // Save spawn position as home
        if (status.position && !this.homePosition) {
          this.homePosition = { x: status.position.x, y: status.position.y, z: status.position.z };
        }
        this.seenEventCount = status.recentEvents.length;
        this.startReflexLoop();
        return commandResult(withPlannerContext(formatStatus(status, this.mode)));
      }

      case "disconnect": {
        this.stopReflexLoop();
        const result = await this.runtime.disconnect("user requested", options.signal);
        this.botConnected = false;
        this.mode = "idle";
        return result.ok
          ? commandResult("Disconnected from Minecraft server.")
          : commandResult(`Disconnect failed: ${result.error}`, false);
      }

      case "status": {
        const result = await this.runtime.status(options.signal);
        if (!result.ok) return commandResult(`Status check failed: ${result.error}`, false);
        // Include only new events in the status report.
        const allEvents = result.output.recentEvents ?? [];
        const newEvents = allEvents.slice(this.seenEventCount);
        this.seenEventCount = allEvents.length;
        return commandResult(withPlannerContext(formatStatus(result.output, this.mode, newEvents)));
      }

      case "follow": {
        if (!command.playerName) return commandResult("Cannot follow — no player name specified.", false);
        const skill = new FollowPlayerSkill(this.runtime, command.playerName, resolveFollowDistance(command.distance));
        const preconditions = skill.checkPreconditions();
        if (!preconditions.ok) return commandResult(`Cannot follow: ${preconditions.reason}`, false);
        const skillResult = await skill.execute({
          signal: options.signal ?? AbortSignal.timeout(30_000),
          onProgress: (msg) => options.onProgress?.({ summary: msg })
        });
        this.mode = "companion";
        return commandResult(skillResult.summary, skillResult.status === "succeeded");
      }

      case "guard": {
        if (!command.playerName) return commandResult("Cannot guard — no player name specified.", false);
        if (this.constraints.avoidCombat) {
          const skill = new FollowPlayerSkill(this.runtime, command.playerName, resolveFollowDistance(command.followDistance));
          const skillResult = await skill.execute({
            signal: options.signal ?? AbortSignal.timeout(30_000),
            onProgress: (msg) => options.onProgress?.({ summary: msg })
          });
          this.mode = "companion";
          return commandResult(`Avoiding combat. ${skillResult.summary}`, skillResult.status === "succeeded");
        }
        const guardRadius = this.constraints.maxDistance !== undefined
          ? clampDistance(Math.min(command.radius ?? 8, this.constraints.maxDistance), 8, 16)
          : command.radius;
        const skill = new GuardPlayerSkill(
          this.runtime,
          command.playerName,
          guardRadius,
          resolveFollowDistance(command.followDistance)
        );
        const preconditions = skill.checkPreconditions();
        if (!preconditions.ok) return commandResult(`Cannot guard: ${preconditions.reason}`, false);
        const skillResult = await skill.execute({
          signal: options.signal ?? AbortSignal.timeout(30_000),
          onProgress: (msg) => options.onProgress?.({ summary: msg })
        });
        this.mode = "guard";
        return commandResult(skillResult.summary, skillResult.status === "succeeded");
      }

      case "collect": {
        const skill = new CollectBlockSkill(this.runtime, command.blockName, command.count, resolveCollectDistance());
        const preconditions = skill.checkPreconditions();
        if (!preconditions.ok) return commandResult(`Cannot collect: ${preconditions.reason}`, false);
        const skillResult = await skill.execute({
          signal: options.signal ?? AbortSignal.timeout(60_000),
          onProgress: (msg) => options.onProgress?.({ summary: msg })
        });
        return commandResult(skillResult.summary, skillResult.status === "succeeded");
      }

      case "go_to": {
        const constrainedTarget = await violatesStayNearConstraint({ x: command.x, y: command.y, z: command.z });
        if (constrainedTarget) {
          return commandResult(
            `Cannot move there while staying near ${this.operatorPlayerName}. Target is ${constrainedTarget.distance.toFixed(1)} blocks away (max ${constrainedTarget.maxDistance}).`,
            false
          );
        }
        const result = await this.runtime.goTo(command.x, command.y, command.z, 1, options.signal);
        if (!result.ok) return commandResult(`Navigation failed: ${result.error}`, false);
        return commandResult(`Pathfinding to ${command.x}, ${command.y}, ${command.z}.`);
      }

      case "return_home": {
        const skill = new ReturnHomeSkill(this.runtime, this.homePosition);
        const preconditions = skill.checkPreconditions();
        if (!preconditions.ok) return commandResult(`Cannot return home: ${preconditions.reason}`, false);
        const skillResult = await skill.execute({
          signal: options.signal ?? AbortSignal.timeout(30_000),
          onProgress: (msg) => options.onProgress?.({ summary: msg })
        });
        return commandResult(skillResult.summary, skillResult.status === "succeeded");
      }

      case "stop": {
        await this.runtime.stop(options.signal);
        this.mode = "idle";
        return commandResult("Stopped. Standing idle.");
      }

      case "chat": {
        const result = await this.runtime.chat(command.message, options.signal);
        if (!result.ok) return commandResult(`Chat failed: ${result.error}`, false);
        return commandResult(`Sent: ${command.message}`);
      }

      case "attack": {
        if (this.constraints.avoidCombat) {
          return commandResult("Combat is disabled by current constraints.", false);
        }
        const result = await this.runtime.attackNearestHostile(undefined, options.signal);
        if (!result.ok) return commandResult(`Attack failed: ${result.error}`, false);
        return commandResult(`Attacking ${result.output.target}.`);
      }

      case "look_at": {
        if (!command.playerName) return commandResult("Cannot look — no player name specified.", false);
        const result = await this.runtime.lookAtPlayer(command.playerName, options.signal);
        if (!result.ok) return commandResult(`Look failed: ${result.error}`, false);
        return commandResult(`Looking at ${command.playerName}.`);
      }

      default:
        return commandResult("Unknown command.", false);
    }
  }

  protected onCancelled(_reason: string): void {
    this.stopReflexLoop();
    // Best-effort stop the bot when the session is cancelled.
    void this.runtime.stop().catch(() => {});
  }

  protected onClosed(): void {
    this.stopReflexLoop();
    // Best-effort stop on close.
    void this.runtime.stop().catch(() => {});
  }

  /**
   * Get a compressed world snapshot for status reporting.
   */
  async getWorldSnapshot() {
    try {
      const result = await this.runtime.status();
      if (!result.ok) return null;
      return buildWorldSnapshot(this.id, this.mode, result.output, this.operatorPlayerName);
    } catch {
      return null;
    }
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────

export function createMinecraftSession(options: MinecraftSessionOptions): MinecraftSession {
  return new MinecraftSession(options);
}
