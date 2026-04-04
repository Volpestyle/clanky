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
 */

import { BaseAgentSession } from "../baseAgentSession.ts";
import { EMPTY_USAGE, generateSessionId } from "../subAgentSession.ts";
import type { SubAgentTurnOptions, SubAgentTurnResult } from "../subAgentSession.ts";
import type { MinecraftConstraints, MinecraftMode, Position } from "./types.ts";
import { MinecraftRuntime, type McpStatusSnapshot } from "./minecraftRuntime.ts";
import { buildWorldSnapshot } from "./minecraftWorldModel.ts";
import { FollowPlayerSkill } from "./skills/followPlayer.ts";
import { GuardPlayerSkill } from "./skills/guardPlayer.ts";
import { CollectBlockSkill } from "./skills/collectBlock.ts";
import { ReturnHomeSkill } from "./skills/returnHome.ts";

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

function formatStatus(status: McpStatusSnapshot, mode: MinecraftMode): string {
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
  if (status.recentEvents.length > 0) {
    parts.push(`Recent: ${status.recentEvents.slice(-3).join("; ")}.`);
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
};

// ── Session ─────────────────────────────────────────────────────────────────

export class MinecraftSession extends BaseAgentSession {
  readonly runtime: MinecraftRuntime;
  private mode: MinecraftMode;
  private operatorPlayerName: string | null;
  private constraints: MinecraftConstraints;
  private homePosition: Position | null;
  private turnCount = 0;

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
  }

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
        // Save spawn position as home
        if (status.position && !this.homePosition) {
          this.homePosition = { x: status.position.x, y: status.position.y, z: status.position.z };
        }
        return formatStatus(status, this.mode);
      }

      case "disconnect": {
        const result = await this.runtime.disconnect("user requested");
        this.mode = "idle";
        return result.ok ? "Disconnected from Minecraft server." : `Disconnect failed: ${result.error}`;
      }

      case "status": {
        const result = await this.runtime.status();
        if (!result.ok) return `Status check failed: ${result.error}`;
        return formatStatus(result.output, this.mode);
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
    // Best-effort stop the bot when the session is cancelled.
    void this.runtime.stop().catch(() => {});
  }

  protected onClosed(): void {
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
