/**
 * MinecraftSession — extends BaseAgentSession for the Minecraft agent.
 *
 * Each session wraps a MinecraftRuntime (HTTP client to the MCP server) and
 * translates natural-language task strings into MCP tool calls.  The outer
 * LLM selects the `minecraft_task` tool with mode/task/constraints; the
 * handler serialises that as JSON input to `runTurn()`.  Followup turns
 * can be plain text or JSON.
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
import type { MinecraftConstraints, MinecraftMode, Position } from "./types.ts";
import { MinecraftRuntime, type McpStatusSnapshot } from "./minecraftRuntime.ts";
import { buildWorldSnapshot } from "./minecraftWorldModel.ts";
import { evaluateReflexes, executeReflex } from "./minecraftReflexes.ts";
import type { MinecraftChatMessage, MinecraftChatReplyFn } from "./minecraftChatBrain.ts";
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
  constraints?: MinecraftConstraints;
  operatorPlayerName?: string;
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
   * LLM-powered chat brain for responding to in-game Minecraft chat.
   * When set, the session monitors chat events and generates natural
   * conversational replies using the same persona as Discord text.
   */
  generateChatReply?: MinecraftChatReplyFn;
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

// ── Session ─────────────────────────────────────────────────────────────────

export class MinecraftSession extends BaseAgentSession {
  readonly runtime: MinecraftRuntime;
  private mode: MinecraftMode;
  private operatorPlayerName: string | null;
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

  // ── Chat brain ──
  private readonly generateChatReply: MinecraftChatReplyFn | undefined;
  private readonly chatHistory: MinecraftChatMessage[] = [];
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
    this.constraints = options.constraints ?? {};
    this.homePosition = options.homePosition ?? null;
    this.onGameEvent = options.onGameEvent;
    this.generateChatReply = options.generateChatReply;
  }

  // ── Auto-connect ────────────────────────────────────────────────────────

  /**
   * Ensure the Mineflayer bot is connected to a Minecraft server.
   *
   * If not connected, issues a connect call to the MCP server which resolves
   * the target host via S3 server-info discovery, MC_HOST env, or localhost.
   * Saves the spawn position as home and starts the background reflex loop.
   */
  private async ensureConnected(): Promise<void> {
    if (this.botConnected) {
      // Cheap fast-path — we think we're connected.  Verify with a quick
      // status probe to catch kicked/crashed states.
      try {
        const probe = await this.runtime.status();
        if (probe.ok && probe.output.connected) return;
        // Bot disconnected underneath us (kicked, server restart, etc.)
        this.botConnected = false;
        this.logLifecycle("minecraft_connection_lost", {});
      } catch {
        // MCP server unreachable — fall through to reconnect attempt.
        this.botConnected = false;
      }
    }

    this.logLifecycle("minecraft_auto_connect", { mode: this.mode });
    const result = await this.runtime.connect({});
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
      dimension: status.dimension
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

        // Detect chat messages and route to the brain.
        if (this.generateChatReply) {
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
      const action = evaluateReflexes(snapshot);
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

  // ── Chat brain ────────────────────────────────────────────────────────────

  private pushChatHistory(msg: MinecraftChatMessage): void {
    this.chatHistory.push(msg);
    if (this.chatHistory.length > MAX_CHAT_HISTORY) {
      this.chatHistory.splice(0, this.chatHistory.length - MAX_CHAT_HISTORY);
    }
  }

  /**
   * Process an incoming Minecraft chat message through the LLM brain.
   *
   * Applies a cooldown to avoid rapid-fire responses and serializes
   * concurrent calls so only one brain invocation runs at a time.
   */
  private async handleIncomingChat(sender: string, message: string): Promise<void> {
    if (!this.generateChatReply) return;
    if (this.chatReplyInFlight) return; // one at a time

    const now = Date.now();
    if (now - this.lastChatReplyMs < CHAT_REPLY_COOLDOWN_MS) return;

    this.chatReplyInFlight = true;
    try {
      const snapshot = await this.getWorldSnapshot();

      const result = await this.generateChatReply({
        sender,
        message,
        chatHistory: this.chatHistory.slice(-20),
        worldSnapshot: snapshot,
        botUsername: this.botUsername || "ClankyBuddy"
      });

      this.lastChatReplyMs = Date.now();

      // Send chat reply.
      if (result.chatText) {
        await this.sendMinecraftChat(result.chatText);
      }

      // Execute game command if the brain requested one.
      if (result.gameCommand) {
        const command = parseCommand(result.gameCommand, this.mode, this.operatorPlayerName);
        this.logLifecycle("minecraft_chat_brain_action", {
          sender,
          gameCommand: result.gameCommand,
          parsedKind: command.kind
        });
        try {
          await this.executeCommand(command, { signal: AbortSignal.timeout(30_000) });
        } catch (error) {
          this.logLifecycle("minecraft_chat_brain_action_error", {
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      if (result.costUsd > 0) {
        this.logLifecycle("minecraft_chat_brain_cost", {
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

  // ── Turn execution ────────────────────────────────────────────────────────

  protected async executeTurn(input: string, options: SubAgentTurnOptions): Promise<SubAgentTurnResult> {
    this.turnCount += 1;
    const parsed = parseTurnInput(input);

    // Apply structured fields if present
    if (parsed.mode) this.mode = parsed.mode;
    if (parsed.constraints) this.constraints = { ...this.constraints, ...parsed.constraints };
    if (parsed.operatorPlayerName) this.operatorPlayerName = parsed.operatorPlayerName;

    const task = parsed.task || parsed.command || "";
    const command = task ? parseCommand(task, this.mode, this.operatorPlayerName) : { kind: "status" as const };

    const startMs = Date.now();
    this.logLifecycle("minecraft_turn_start", {
      turnCount: this.turnCount,
      command: command.kind,
      mode: this.mode,
      task
    });

    try {
      const result = await this.executeCommand(command, options);
      const durationMs = Date.now() - startMs;
      this.logLifecycle("minecraft_turn_complete", {
        turnCount: this.turnCount,
        command: command.kind,
        durationMs,
        resultLength: result.length
      });
      return {
        text: result,
        costUsd: 0,
        isError: false,
        errorMessage: "",
        sessionCompleted: false,
        usage: { ...EMPTY_USAGE }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logLifecycle("minecraft_turn_error", {
        turnCount: this.turnCount,
        command: command.kind,
        error: message
      });
      return {
        text: `Minecraft command failed: ${message}`,
        costUsd: 0,
        isError: true,
        errorMessage: message,
        usage: { ...EMPTY_USAGE }
      };
    }
  }

  private async executeCommand(command: ParsedCommand, options: SubAgentTurnOptions): Promise<string> {
    // Auto-connect for any command that needs a live bot.
    // connect/disconnect manage the connection explicitly.
    if (command.kind !== "connect" && command.kind !== "disconnect") {
      await this.ensureConnected();
    }

    switch (command.kind) {
      case "connect": {
        const result = await this.runtime.connect({
          host: command.host,
          port: command.port,
          username: command.username,
          auth: command.auth
        });
        if (!result.ok) return `Connection failed: ${result.error || "unknown error"}`;
        const status = result.output;
        this.botConnected = true;
        this.botUsername = status.username ?? null;
        // Save spawn position as home
        if (status.position && !this.homePosition) {
          this.homePosition = { x: status.position.x, y: status.position.y, z: status.position.z };
        }
        this.seenEventCount = status.recentEvents.length;
        this.startReflexLoop();
        return formatStatus(status, this.mode);
      }

      case "disconnect": {
        this.stopReflexLoop();
        const result = await this.runtime.disconnect("user requested");
        this.botConnected = false;
        this.mode = "idle";
        return result.ok ? "Disconnected from Minecraft server." : `Disconnect failed: ${result.error}`;
      }

      case "status": {
        const result = await this.runtime.status();
        if (!result.ok) return `Status check failed: ${result.error}`;
        // Include only new events in the status report.
        const allEvents = result.output.recentEvents ?? [];
        const newEvents = allEvents.slice(this.seenEventCount);
        this.seenEventCount = allEvents.length;
        return formatStatus(result.output, this.mode, newEvents);
      }

      case "follow": {
        if (!command.playerName) return "Cannot follow — no player name specified.";
        const skill = new FollowPlayerSkill(this.runtime, command.playerName, command.distance);
        const preconditions = skill.checkPreconditions();
        if (!preconditions.ok) return `Cannot follow: ${preconditions.reason}`;
        const skillResult = await skill.execute({
          signal: options.signal ?? AbortSignal.timeout(30_000),
          onProgress: (msg) => options.onProgress?.({ summary: msg })
        });
        this.mode = "companion";
        return skillResult.summary;
      }

      case "guard": {
        if (!command.playerName) return "Cannot guard — no player name specified.";
        const skill = new GuardPlayerSkill(this.runtime, command.playerName, command.radius, command.followDistance);
        const preconditions = skill.checkPreconditions();
        if (!preconditions.ok) return `Cannot guard: ${preconditions.reason}`;
        const skillResult = await skill.execute({
          signal: options.signal ?? AbortSignal.timeout(30_000),
          onProgress: (msg) => options.onProgress?.({ summary: msg })
        });
        this.mode = "guard";
        return skillResult.summary;
      }

      case "collect": {
        const skill = new CollectBlockSkill(this.runtime, command.blockName, command.count);
        const preconditions = skill.checkPreconditions();
        if (!preconditions.ok) return `Cannot collect: ${preconditions.reason}`;
        const skillResult = await skill.execute({
          signal: options.signal ?? AbortSignal.timeout(60_000),
          onProgress: (msg) => options.onProgress?.({ summary: msg })
        });
        return skillResult.summary;
      }

      case "go_to": {
        const result = await this.runtime.goTo(command.x, command.y, command.z);
        if (!result.ok) return `Navigation failed: ${result.error}`;
        return `Pathfinding to ${command.x}, ${command.y}, ${command.z}.`;
      }

      case "return_home": {
        const skill = new ReturnHomeSkill(this.runtime, this.homePosition);
        const preconditions = skill.checkPreconditions();
        if (!preconditions.ok) return `Cannot return home: ${preconditions.reason}`;
        const skillResult = await skill.execute({
          signal: options.signal ?? AbortSignal.timeout(30_000),
          onProgress: (msg) => options.onProgress?.({ summary: msg })
        });
        return skillResult.summary;
      }

      case "stop": {
        await this.runtime.stop();
        this.mode = "idle";
        return "Stopped. Standing idle.";
      }

      case "chat": {
        const result = await this.runtime.chat(command.message);
        if (!result.ok) return `Chat failed: ${result.error}`;
        return `Sent: ${command.message}`;
      }

      case "attack": {
        const result = await this.runtime.attackNearestHostile();
        if (!result.ok) return `Attack failed: ${result.error}`;
        return `Attacking ${result.output.target}.`;
      }

      case "look_at": {
        if (!command.playerName) return "Cannot look — no player name specified.";
        const result = await this.runtime.lookAtPlayer(command.playerName);
        if (!result.ok) return `Look failed: ${result.error}`;
        return `Looking at ${command.playerName}.`;
      }

      default:
        return "Unknown command.";
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
