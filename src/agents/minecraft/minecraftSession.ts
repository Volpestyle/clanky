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
import type { ImageInput } from "../../llm/serviceShared.ts";
import { EMPTY_USAGE, generateSessionId } from "../subAgentSession.ts";
import type { SubAgentTurnOptions, SubAgentTurnResult } from "../subAgentSession.ts";
import type {
  MinecraftActionFailure,
  MinecraftActionFailureReason,
  MinecraftAllowedChest,
  MinecraftBrainAction,
  MinecraftBuildPlan,
  MinecraftGameEvent,
  MinecraftConstraints,
  MinecraftItemRequest,
  MinecraftLookCapture,
  MinecraftMode,
  MinecraftPlannerState,
  MinecraftPlayerIdentity,
  MinecraftProject,
  MinecraftServerCatalogEntry,
  MinecraftServerTarget,
  MinecraftVisualScene,
  Position
} from "./types.ts";
import { MinecraftRuntime, type McpStatusSnapshot } from "./minecraftRuntime.ts";
import { buildWorldSnapshot } from "./minecraftWorldModel.ts";
import { detectStuck, evaluateReflexes, executeReflex } from "./minecraftReflexes.ts";
import type { DiscordContextMessage, MinecraftBrain, MinecraftChatMessage } from "./minecraftBrain.ts";
import { FollowPlayerSkill } from "./skills/followPlayer.ts";
import { GuardPlayerSkill } from "./skills/guardPlayer.ts";
import { CollectBlockSkill } from "./skills/collectBlock.ts";
import { ReturnHomeSkill } from "./skills/returnHome.ts";
import { CraftItemSkill } from "./skills/craftItem.ts";
import { DepositItemsSkill } from "./skills/depositItems.ts";
import { WithdrawItemsSkill } from "./skills/withdrawItems.ts";
import { BuildStructureSkill } from "./skills/buildStructure.ts";
import type { MinecraftBuilder } from "./minecraftBuilder.ts";

// ── Constants ───────────────────────────────────────────────────────────────

/** How often the background reflex/event loop ticks (ms). */
const REFLEX_TICK_INTERVAL_MS = 5_000;

/** Max consecutive tick failures before the loop self-disables. */
const MAX_TICK_FAILURES = 5;

/** Max chat history entries kept for brain context. */
const MAX_CHAT_HISTORY = 30;

/** Max queued in-game chat messages waiting for a brain decision. */
const MAX_PENDING_IN_GAME_MESSAGES = 10;

/** Minimum ms between brain-generated chat replies to avoid spam. */
const CHAT_REPLY_COOLDOWN_MS = 2_000;

/** Max planner checkpoints the embodied brain can take in one turn. */
const MAX_PLANNER_CHECKPOINTS_PER_TURN = 3;

/**
 * How long a captured rendered glance remains usable for the next checkpoint.
 *
 * The planner loop stashes the image between checkpoint N (where the brain
 * picks `look`) and checkpoint N+1 (where the brain reasons over it). If the
 * session sits idle between turns, the stashed capture ages out here so we
 * never feed the brain a stale view of the world.
 */
const PENDING_LOOK_CAPTURE_TTL_MS = 45_000;

/** Max remembered subgoals in the long-horizon planner state. */
const MAX_PLANNER_SUBGOALS = 6;

/** Max remembered progress notes in the long-horizon planner state. */
const MAX_PLANNER_PROGRESS = 10;

/** Minecraft chat message hard limit. We target slightly under for safety. */
const MC_CHAT_MAX_LEN = 240;

/** Delay between multi-line chat messages (ms). */
const MC_MULTI_LINE_DELAY_MS = 400;

// ── Turn input ──────────────────────────────────────────────────────────────

type TurnInput = {
  task?: string;
  command?: string;
  mode?: MinecraftMode;
  constraints?: MinecraftConstraints | Record<string, unknown>;
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
  // stayNearPlayer is now a string MC username (or omitted). The brain or
  // orchestrator specifies WHO to stay near; there's no implicit operator.
  const rawStayNear = record.stayNearPlayer ?? record.stay_near_player;
  const stayNearPlayer = typeof rawStayNear === "string" && rawStayNear.trim().length > 0
    ? rawStayNear.trim().slice(0, 40)
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
    ?.map((entry) => normalizeAllowedChest(entry))
    .filter((entry): entry is MinecraftAllowedChest => Boolean(entry));

  return {
    ...(stayNearPlayer !== undefined ? { stayNearPlayer } : {}),
    ...(maxDistance !== undefined ? { maxDistance } : {}),
    ...(avoidCombat !== undefined ? { avoidCombat } : {}),
    ...(allowedChests && allowedChests.length > 0 ? { allowedChests } : {})
  };
}

function normalizeAllowedChest(raw: unknown): MinecraftAllowedChest | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const x = Number(record.x);
  const y = Number(record.y);
  const z = Number(record.z);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  const label = typeof record.label === "string" ? record.label.trim().slice(0, 40) : "";
  return {
    x: Math.round(x),
    y: Math.round(y),
    z: Math.round(z),
    ...(label ? { label } : {})
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

function normalizePromptHintPart(value: unknown, fallback: string, maxLen: number): string {
  const normalized = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return fallback;
  return normalized.slice(0, Math.max(1, maxLen));
}

function cloneServerTarget(serverTarget: MinecraftServerTarget | null): MinecraftServerTarget | null {
  return serverTarget ? { ...serverTarget } : null;
}

function diffServerTargetFields(
  previousTarget: MinecraftServerTarget | null,
  nextTarget: MinecraftServerTarget | null
): Array<keyof MinecraftServerTarget> {
  const changedFields: Array<keyof MinecraftServerTarget> = [];
  for (const field of ["label", "host", "port", "description"] as const) {
    if ((previousTarget?.[field] ?? null) !== (nextTarget?.[field] ?? null)) {
      changedFields.push(field);
    }
  }
  return changedFields;
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

function canContinueAfterBrainAction(
  action: MinecraftBrainAction,
  execution: CommandExecutionResult,
  plannerRequestedContinue: boolean
): boolean {
  if (!execution.ok) return true;
  if (!plannerRequestedContinue) return false;
  return action.kind === "wait"
    || action.kind === "connect"
    || action.kind === "status"
    || action.kind === "look"
    || action.kind === "chat"
    || action.kind === "look_at"
    || action.kind === "eat"
    || action.kind === "equip_offhand"
    || action.kind === "place_block"
    || action.kind === "project_start"
    || action.kind === "project_step"
    || action.kind === "project_pause"
    || action.kind === "project_resume"
    || action.kind === "project_abort";
}

function toLookImageInputs(capture: MinecraftLookCapture | null | undefined): ImageInput[] {
  if (!capture?.dataBase64) return [];
  return [{ mediaType: capture.mediaType, dataBase64: capture.dataBase64 }];
}

// ── Structured command routing ──────────────────────────────────────────────
//
// The session has exactly one decision-maker: the embodied Minecraft brain.
// Callers hand over intent via `task` and the brain picks the in-world
// action.  A narrow set of bare read/teardown commands can bypass the brain
// directly via `parsed.command` — they are deterministic, argument-free, and
// safe to route without reasoning.  Anything else falls through to the brain.

type ParsedCommand =
  | { kind: "connect"; host?: string; port?: number; username?: string; auth?: string }
  | { kind: "disconnect" }
  | { kind: "status" }
  | { kind: "look" }
  | { kind: "follow"; playerName: string; distance?: number }
  | { kind: "guard"; playerName: string; radius?: number; followDistance?: number }
  | { kind: "collect"; blockName: string; count: number }
  | { kind: "go_to"; x: number; y: number; z: number }
  | { kind: "return_home" }
  | { kind: "stop" }
  | { kind: "chat"; message: string }
  | { kind: "attack" }
  | { kind: "look_at"; playerName: string }
  | { kind: "eat" }
  | { kind: "equip_offhand"; itemName: string }
  | { kind: "craft"; recipeName: string; count: number; useCraftingTable: boolean }
  | { kind: "deposit"; chest: { x: number; y: number; z: number }; items: MinecraftItemRequest[] }
  | { kind: "withdraw"; chest: { x: number; y: number; z: number }; items: MinecraftItemRequest[] }
  | { kind: "place_block"; x: number; y: number; z: number; blockName: string }
  | { kind: "build"; plan: MinecraftBuildPlan };

type CommandExecutionResult = {
  text: string;
  ok: boolean;
  failure: MinecraftActionFailure | null;
  imageInputs?: ImageInput[];
  lookCapture?: MinecraftLookCapture | null;
};

function parseStructuredCommand(raw: string): ParsedCommand | null {
  const command = String(raw || "").trim().toLowerCase();
  if (!command) return null;
  switch (command) {
    case "status": return { kind: "status" };
    case "stop":
    case "halt":
    case "idle": return { kind: "stop" };
    case "disconnect": return { kind: "disconnect" };
    case "attack": return { kind: "attack" };
    case "return_home":
    case "return": return { kind: "return_home" };
    default: return null;
  }
}

// ── Status formatting ───────────────────────────────────────────────────────

/**
 * Format a status snapshot into a human-readable summary.
 *
 * @param newEvents  If provided, only these events are shown (for incremental
 *                   status updates).  Falls back to the last 3 events from the
 *                   full snapshot when omitted.
 */
function formatStatus(status: McpStatusSnapshot, mode: MinecraftMode, newEvents?: MinecraftGameEvent[]): string {
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
    parts.push(`Recent: ${events.slice(-5).map((event) => `[${event.type}] ${event.summary}`).join("; ")}.`);
  }
  return parts.join(" ");
}

// ── Session options ─────────────────────────────────────────────────────────

export type MinecraftSessionOptions = {
  scopeKey: string;
  baseUrl: string;
  ownerUserId: string | null;
  /**
   * Optional Discord↔Minecraft identity bridge the operator has configured.
   * Empty (default) means Clanky forms impressions about every MC player
   * organically — no one is pre-designated as special. When populated, these
   * act as background context, not a permission list.
   */
  knownIdentities?: MinecraftPlayerIdentity[];
  serverTarget?: MinecraftServerTarget | null;
  /**
   * Multi-world catalog of known server targets. The brain sees these in
   * planner state as labeled choices and can connect to any of them by
   * name. The `serverTarget` remains the primary/default.
   */
  serverCatalog?: MinecraftServerCatalogEntry[];
  mode?: MinecraftMode;
  constraints?: MinecraftConstraints;
  homePosition?: Position | null;
  logAction?: (entry: Record<string, unknown>) => void;
  /**
   * Called when new game events are detected (chat, death, combat, etc.).
   * The outer system can use this for proactive narration in Discord.
   *
   * The second `context` argument carries a snapshot of recent in-game chat
   * history so the narration pipeline can reason about what's already been
   * said in MC chat when deciding whether/how to surface an event in Discord.
   * Labeled and kept separate from Discord context at the prompt layer
   * (same pattern as Phase 2's cross-surface design).
   */
  onGameEvent?: (
    events: MinecraftGameEvent[],
    context?: { chatHistory: MinecraftChatMessage[] }
  ) => void;
  /**
   * Returns recent Discord channel messages tied to this session's scope,
   * so the Minecraft brain can reason about cross-surface follow-ups.
   *
   * Pull-style on purpose: the session only calls this when it is about to
   * invoke the brain, so Discord reads stay cheap and fresh. Returns an empty
   * array (or `undefined`) when there's nothing to share — the outer layer is
   * responsible for filtering owner-private / DM context out at the boundary.
   */
  getRecentDiscordContext?: () => DiscordContextMessage[];
  /**
   * LLM-powered embodied Minecraft brain.
   * It owns both operator-turn planning and in-game chat behavior.
   */
  brain?: MinecraftBrain;
  /**
   * Sub-planner that expands short build descriptions into concrete
   * placement plans. Only consulted when the brain emits a `build` action
   * without an explicit plan.
   */
  builder?: MinecraftBuilder;
  /**
   * Default per-project action budget. The brain can override per project
   * when calling project_start. Infrastructure cap, not a relevance gate.
   */
  projectActionBudget?: number;
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

function normalizePlayerNameForMatch(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function levenshteinDistance(left: string, right: string): number {
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;

  const previous = new Array(right.length + 1).fill(0);
  const current = new Array(right.length + 1).fill(0);

  for (let col = 0; col <= right.length; col += 1) {
    previous[col] = col;
  }

  for (let row = 1; row <= left.length; row += 1) {
    current[0] = row;
    for (let col = 1; col <= right.length; col += 1) {
      const cost = left[row - 1] === right[col - 1] ? 0 : 1;
      current[col] = Math.min(
        previous[col] + 1,
        current[col - 1] + 1,
        previous[col - 1] + cost
      );
    }
    for (let col = 0; col <= right.length; col += 1) {
      previous[col] = current[col];
    }
  }

  return previous[right.length] ?? Math.max(left.length, right.length);
}

function findSuggestedPlayerName(requestedPlayerName: string, candidateNames: string[]): string | null {
  const requested = normalizePlayerNameForMatch(requestedPlayerName);
  if (!requested) return null;

  let bestMatch: { name: string; score: number } | null = null;

  for (const rawCandidate of candidateNames) {
    const candidateName = String(rawCandidate || "").trim();
    const candidate = normalizePlayerNameForMatch(candidateName);
    if (!candidate || candidate === requested) continue;

    const substringMatch = candidate.startsWith(requested)
      || requested.startsWith(candidate)
      || candidate.includes(requested)
      || requested.includes(candidate);
    const score = substringMatch ? 0 : levenshteinDistance(requested, candidate);
    const maxScore = substringMatch ? 0 : Math.max(2, Math.floor(Math.max(requested.length, candidate.length) / 3));
    if (score > maxScore) continue;

    if (!bestMatch
      || score < bestMatch.score
      || (score === bestMatch.score && candidateName.length < bestMatch.name.length)
      || (score === bestMatch.score && candidateName.length === bestMatch.name.length && candidateName.localeCompare(bestMatch.name) < 0)) {
      bestMatch = { name: candidateName, score };
    }
  }

  return bestMatch?.name ?? null;
}

function classifyActionFailureReason(message: string): MinecraftActionFailureReason {
  const normalized = String(message || "").toLowerCase();
  if (!normalized) return "unknown";
  if (normalized.includes("not currently visible") || normalized.includes("not known in the current world state")) {
    return "player_not_visible";
  }
  if (normalized.includes("inventory full") || normalized.includes("inventory is full")) {
    return "inventory_full";
  }
  if (normalized.includes("missing ingredients")) {
    return "missing_ingredients";
  }
  if (normalized.includes("no recipe known")) {
    return "no_recipe";
  }
  if (normalized.includes("no crafting table")) {
    return "no_crafting_table";
  }
  if (normalized.includes("not in allowedchests") || normalized.includes("not allowed")) {
    return "chest_not_allowed";
  }
  if (normalized.includes("already occupied") || normalized.includes("no adjacent solid block")) {
    return "placement_blocked";
  }
  if (normalized.includes("budget")) {
    return "budget_exceeded";
  }
  if (normalized.includes("resume it first") || normalized.includes("project status:")) {
    return "project_not_executing";
  }
  if (normalized.includes("no active project")) {
    return "no_active_project";
  }
  if (normalized.includes("project is already active") || normalized.includes("already active")) {
    return "project_already_active";
  }
  if (normalized.includes("while staying near") || normalized.includes("disabled by current constraints")) {
    return "constraint_violation";
  }
  if (normalized.includes("no player name specified") || normalized.includes("unknown block") || normalized.includes("no home position set")) {
    return "invalid_target";
  }
  if (normalized.includes("not connected")) {
    return "not_connected";
  }
  if (normalized.includes("path blocked") || normalized.includes("no path") || normalized.includes("cannot find path") || normalized.includes("navigation failed")) {
    return "path_blocked";
  }
  if (normalized.includes("within") || normalized.includes("blocks away") || normalized.includes("out of range")) {
    return "out_of_range";
  }
  if (normalized.includes("failed") || normalized.includes("rejected") || normalized.includes("kicked")) {
    return "rejected_by_server";
  }
  return "unknown";
}

// ── Session ─────────────────────────────────────────────────────────────────

export class MinecraftSession extends BaseAgentSession {
  readonly runtime: MinecraftRuntime;
  private mode: MinecraftMode;
  private knownIdentities: MinecraftPlayerIdentity[];
  private serverTarget: MinecraftServerTarget | null;
  private serverCatalog: MinecraftServerCatalogEntry[];
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
  private readonly onGameEvent:
    | ((
        events: MinecraftGameEvent[],
        context?: { chatHistory: MinecraftChatMessage[] }
      ) => void)
    | undefined;

  // ── Cross-surface context ──
  private readonly getRecentDiscordContext:
    | (() => DiscordContextMessage[])
    | undefined;

  // ── Minecraft brain ──
  private readonly brain: MinecraftBrain | undefined;
  private readonly builder: MinecraftBuilder | undefined;
  private readonly defaultProjectBudget: number;
  private readonly chatHistory: MinecraftChatMessage[] = [];
  private plannerState: MinecraftPlannerState;
  private pendingLookCapture: MinecraftLookCapture | null = null;
  private pendingLookCapturedAtMs: number | null = null;
  private lastChatReplyMs = 0;
  private chatReplyInFlight = false;
  private chatReplyFlushTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Stuck detection ──
  private lastPositionSample: Position | null = null;
  private stuckTickCount = 0;

  constructor(options: MinecraftSessionOptions) {
    super({
      id: generateSessionId("minecraft", options.scopeKey),
      type: "minecraft",
      ownerUserId: options.ownerUserId,
      logAction: options.logAction
    });
    this.runtime = new MinecraftRuntime(options.baseUrl, options.logAction);
    this.mode = options.mode ?? "companion";
    this.knownIdentities = Array.isArray(options.knownIdentities)
      ? options.knownIdentities.map((entry) => ({ ...entry }))
      : [];
    this.serverTarget = options.serverTarget ?? null;
    this.serverCatalog = Array.isArray(options.serverCatalog) ? [...options.serverCatalog] : [];
    this.constraints = options.constraints ?? {};
    this.homePosition = options.homePosition ?? null;
    this.onGameEvent = options.onGameEvent;
    this.getRecentDiscordContext = options.getRecentDiscordContext;
    this.brain = options.brain;
    this.builder = options.builder;
    this.defaultProjectBudget = Math.max(5, Math.min(200, Number(options.projectActionBudget) || 40));
    this.plannerState = {
      activeGoal: null,
      subgoals: [],
      progress: [],
      lastInstruction: null,
      lastDecisionSummary: null,
      lastActionResult: null,
      lastActionFailure: null,
      pendingInGameMessages: [],
      activeProject: null
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

        // Forward raw events to the outer system, with a chat-history
        // snapshot so downstream narration has matching in-game context.
        if (newEvents.length > 0 && this.onGameEvent) {
          try {
            this.onGameEvent(newEvents, {
              chatHistory: this.chatHistory.slice()
            });
          } catch {
            // Callback errors are non-fatal.
          }
        }

        // Detect chat messages and route to the session brain.
        if (this.brain) {
          for (const event of newEvents) {
            if (event.type !== "chat") continue;

            const chatMessage = {
              sender: event.sender,
              text: event.message,
              timestamp: event.timestamp,
              isBot: event.isBot
            };

            // Record ALL messages (including own) for history context.
            this.pushChatHistory(chatMessage);

            // Only trigger the brain for OTHER players' messages.
            if (!event.isBot) {
              void this.handleIncomingChat(chatMessage);
            }
          }
        }
      }

      // ── Evaluate reflexes ──
      const snapshot = buildWorldSnapshot(
        this.id,
        this.mode,
        status,
        this.knownIdentities.map((entry) => entry.mcUsername)
      );

      // Stuck detection: if we've moved <0.25 blocks across two consecutive
      // ticks while a navigation task is active, kick an unstick reflex.
      let stuckOverride = false;
      if (snapshot.self) {
        const currentPosition: Position = {
          x: snapshot.self.position.x,
          y: snapshot.self.position.y,
          z: snapshot.self.position.z
        };
        const stuck = detectStuck(snapshot, this.lastPositionSample);
        this.lastPositionSample = currentPosition;
        if (stuck) {
          this.stuckTickCount += 1;
          if (this.stuckTickCount >= 2) {
            stuckOverride = true;
            this.stuckTickCount = 0;
            this.logLifecycle("minecraft_reflex_fire", { action: "unstick", mode: this.mode });
            await executeReflex(this.runtime, { type: "unstick" });
          }
        } else {
          this.stuckTickCount = 0;
        }
      }

      if (!stuckOverride) {
        const action = evaluateReflexes(snapshot, this.constraints);
        if (action.type !== "none") {
          this.logLifecycle("minecraft_reflex_fire", { action: action.type, mode: this.mode });
          await executeReflex(this.runtime, action);
        }
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

  private enqueuePendingInGameMessage(message: MinecraftChatMessage): void {
    this.plannerState.pendingInGameMessages.push(message);
    if (this.plannerState.pendingInGameMessages.length > MAX_PENDING_IN_GAME_MESSAGES) {
      this.plannerState.pendingInGameMessages.splice(
        0,
        this.plannerState.pendingInGameMessages.length - MAX_PENDING_IN_GAME_MESSAGES
      );
    }
    this.logLifecycle("minecraft_chat_backlog_updated", {
      pendingCount: this.plannerState.pendingInGameMessages.length,
      latestSender: message.sender,
      latestMessage: message.text
    });
  }

  private drainPendingInGameMessages(): MinecraftChatMessage[] {
    const pending = this.plannerState.pendingInGameMessages.slice();
    this.plannerState.pendingInGameMessages = [];
    return pending;
  }

  private restorePendingInGameMessages(messages: MinecraftChatMessage[]): void {
    if (messages.length <= 0) return;
    this.plannerState.pendingInGameMessages = [
      ...messages,
      ...this.plannerState.pendingInGameMessages
    ].slice(-MAX_PENDING_IN_GAME_MESSAGES);
  }

  private clearChatReplyFlushTimer(): void {
    if (this.chatReplyFlushTimer) {
      clearTimeout(this.chatReplyFlushTimer);
      this.chatReplyFlushTimer = null;
    }
  }

  private schedulePendingChatFlush(delayMs = 0): void {
    if (!this.brain || this.plannerState.pendingInGameMessages.length <= 0) return;
    this.clearChatReplyFlushTimer();
    this.chatReplyFlushTimer = setTimeout(() => {
      this.chatReplyFlushTimer = null;
      void this.flushPendingInGameMessages();
    }, Math.max(0, delayMs));
  }

  /**
   * Pull recent Discord channel context (if the outer layer provided a
   * callback). Failures never break the brain — we just drop to an empty
   * array and log once per failure.
   */
  private resolveDiscordContext(): DiscordContextMessage[] {
    if (!this.getRecentDiscordContext) return [];
    try {
      const entries = this.getRecentDiscordContext();
      return Array.isArray(entries) ? entries : [];
    } catch (error) {
      this.logLifecycle("minecraft_discord_context_error", {
        error: error instanceof Error ? error.message : String(error)
      });
      return [];
    }
  }

  /**
   * Process an incoming Minecraft chat message through the session brain.
   *
   * Applies a cooldown to avoid rapid-fire responses and serializes
   * concurrent calls so only one brain invocation runs at a time.
   */
  private async handleIncomingChat(message: MinecraftChatMessage): Promise<void> {
    if (!this.brain) return;
    this.enqueuePendingInGameMessage(message);
    await this.flushPendingInGameMessages();
  }

  private async flushPendingInGameMessages(): Promise<void> {
    if (!this.brain) return;
    if (this.chatReplyInFlight) return;
    if (this.plannerState.pendingInGameMessages.length <= 0) return;

    const now = Date.now();
    const remainingCooldown = CHAT_REPLY_COOLDOWN_MS - (now - this.lastChatReplyMs);
    if (remainingCooldown > 0) {
      this.logLifecycle("minecraft_chat_backlog_deferred", {
        pendingCount: this.plannerState.pendingInGameMessages.length,
        remainingCooldownMs: remainingCooldown
      });
      this.schedulePendingChatFlush(remainingCooldown);
      return;
    }

    const pendingBatch = this.drainPendingInGameMessages();
    const latestMessage = pendingBatch[pendingBatch.length - 1];
    if (!latestMessage) return;

    const sessionState = this.getPlannerStateSnapshot();
    sessionState.pendingInGameMessages = pendingBatch.map((entry) => ({ ...entry }));

    this.chatReplyInFlight = true;
    try {
      const snapshot = await this.getWorldSnapshot();
      this.logLifecycle("minecraft_chat_backlog_flush", {
        pendingCount: pendingBatch.length,
        primarySender: latestMessage.sender,
        primaryMessage: latestMessage.text
      });

      const result = await this.brain.replyToChat({
        sender: latestMessage.sender,
        message: latestMessage.text,
        chatHistory: this.chatHistory.slice(-20),
        discordContext: this.resolveDiscordContext(),
        worldSnapshot: snapshot,
        botUsername: this.botUsername || "ClankyBuddy",
        mode: this.mode,
        knownIdentities: this.knownIdentities.map((entry) => ({ ...entry })),
        constraints: { ...this.constraints },
        serverTarget: this.serverTarget,
        serverCatalog: [...this.serverCatalog],
        sessionState
      });

      this.applyPlannerDecision({
        goal: result.goal,
        subgoals: result.subgoals,
        progress: result.progress,
        summary: result.summary,
        instruction: latestMessage.text
      });

      this.lastChatReplyMs = Date.now();

      // Send chat reply.
      if (result.chatText) {
        await this.sendMinecraftChat(result.chatText);
      }

      // Execute structured in-world action if the brain requested one.
      if (result.action.kind !== "wait") {
        this.logLifecycle("minecraft_brain_chat_action", {
          sender: latestMessage.sender,
          pendingCount: pendingBatch.length,
          action: result.action
        });
        try {
          const execution = await this.executeBrainAction(result.action, {
            signal: AbortSignal.timeout(30_000)
          });
          this.recordPlannerActionResult(execution, result.action.kind);
        } catch (error) {
          this.logLifecycle("minecraft_brain_chat_action_error", {
            error: error instanceof Error ? error.message : String(error)
          });
        }
        // Chat-driven actions don't get a follow-up reasoning checkpoint,
        // so any rendered glance captured here would become a stale leftover
        // for the next operator turn. Drop it explicitly.
        if (result.action.kind === "look") {
          this.clearPendingLookCapture("chat_flow_has_no_followup_checkpoint");
        }
      }

      if (result.costUsd > 0) {
        this.logLifecycle("minecraft_brain_chat_cost", {
          sender: latestMessage.sender,
          pendingCount: pendingBatch.length,
          costUsd: result.costUsd
        });
      }
    } catch (error) {
      this.restorePendingInGameMessages(pendingBatch);
      this.logLifecycle("minecraft_chat_reply_error", {
        sender: latestMessage.sender,
        pendingCount: pendingBatch.length,
        error: error instanceof Error ? error.message : String(error)
      });
      this.schedulePendingChatFlush(250);
    } finally {
      this.chatReplyInFlight = false;
      if (this.plannerState.pendingInGameMessages.length > 0) {
        const nextDelay = Math.max(0, CHAT_REPLY_COOLDOWN_MS - (Date.now() - this.lastChatReplyMs));
        this.schedulePendingChatFlush(nextDelay);
      }
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
      lastActionResult: this.plannerState.lastActionResult,
      lastActionFailure: this.plannerState.lastActionFailure ? { ...this.plannerState.lastActionFailure } : null,
      pendingInGameMessages: this.plannerState.pendingInGameMessages.map((message) => ({ ...message })),
      activeProject: this.plannerState.activeProject
        ? {
            ...this.plannerState.activeProject,
            checkpoints: [...this.plannerState.activeProject.checkpoints],
            completedCheckpoints: [...this.plannerState.activeProject.completedCheckpoints]
          }
        : null
    };
  }

  getActiveProject(): MinecraftProject | null {
    return this.getPlannerStateSnapshot().activeProject;
  }

  getServerTargetSnapshot(): MinecraftServerTarget | null {
    return cloneServerTarget(this.serverTarget);
  }

  private consumePendingLookCapture(): MinecraftLookCapture | null {
    const capture = this.pendingLookCapture;
    const capturedAtMs = this.pendingLookCapturedAtMs;
    this.pendingLookCapture = null;
    this.pendingLookCapturedAtMs = null;
    if (!capture || capturedAtMs === null) return null;
    const ageMs = Date.now() - capturedAtMs;
    if (ageMs > PENDING_LOOK_CAPTURE_TTL_MS) {
      this.logLifecycle("minecraft_look_capture_expired", {
        ageMs,
        ttlMs: PENDING_LOOK_CAPTURE_TTL_MS
      });
      return null;
    }
    return capture;
  }

  private clearPendingLookCapture(reason: string): void {
    if (!this.pendingLookCapture) return;
    this.logLifecycle("minecraft_look_capture_dropped", { reason });
    this.pendingLookCapture = null;
    this.pendingLookCapturedAtMs = null;
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

  private async resolvePlayerNameSuggestion(requestedPlayerName: string, signal?: AbortSignal): Promise<string | null> {
    const normalized = String(requestedPlayerName || "").trim();
    if (!normalized) return null;
    try {
      const status = await this.runtime.status(signal);
      if (!status.ok) return null;
      return findSuggestedPlayerName(
        normalized,
        (status.output.players ?? [])
          .map((player) => String(player.username || "").trim())
          .filter(Boolean)
      );
    } catch {
      return null;
    }
  }

  private async buildActionFailure(
    command: ParsedCommand,
    resultText: string,
    signal?: AbortSignal
  ): Promise<MinecraftActionFailure> {
    const message = String(resultText || "").trim().slice(0, 220) || "Minecraft action failed.";
    const failure: MinecraftActionFailure = {
      actionKind: command.kind,
      reason: classifyActionFailureReason(message),
      message
    };

    if (failure.reason === "player_not_visible"
      && (command.kind === "follow" || command.kind === "guard" || command.kind === "look_at")) {
      const didYouMeanPlayerName = await this.resolvePlayerNameSuggestion(command.playerName, signal);
      if (didYouMeanPlayerName) {
        failure.didYouMeanPlayerName = didYouMeanPlayerName;
      }
    }

    return failure;
  }

  private recordPlannerActionResult(
    execution: CommandExecutionResult,
    actionKind: ParsedCommand["kind"] | MinecraftBrainAction["kind"]
  ): void {
    const normalized = String(execution.text || "").trim().slice(0, 220);
    if (normalized) {
      this.plannerState.lastActionResult = normalized;
      this.plannerState.progress = mergePlannerTextEntries(
        this.plannerState.progress,
        [normalized],
        MAX_PLANNER_PROGRESS
      );
    }
    this.plannerState.lastActionFailure = execution.ok
      ? null
      : execution.failure ?? {
          actionKind,
          reason: "unknown",
          message: normalized || "Minecraft action failed."
        };
    if (this.plannerState.lastActionFailure) {
      this.logLifecycle("minecraft_action_failure_classified", {
        failure: this.plannerState.lastActionFailure
      });
    }
    if (actionKind === "stop" || actionKind === "disconnect") {
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

  getPromptStateHint(): string {
    const goal = normalizePromptHintPart(this.plannerState.activeGoal, "none", 120);
    const mode = normalizePromptHintPart(this.mode, "idle", 32);
    const server = normalizePromptHintPart(formatServerTarget(this.serverTarget), "none configured", 120);
    const lastAction = normalizePromptHintPart(this.plannerState.lastActionResult, "none", 140);
    return `[Minecraft] Active session - goal: "${goal}" | mode: ${mode} | server: ${server} | connected: ${this.botConnected ? "yes" : "no"} | last action: ${lastAction}`;
  }

  private logServerTargetUpdate(
    source: "brain_action" | "turn_input",
    previousTarget: MinecraftServerTarget | null,
    nextTarget: MinecraftServerTarget | null
  ): void {
    this.logLifecycle("minecraft_server_target_updated", {
      source,
      previousServerTarget: cloneServerTarget(previousTarget),
      serverTarget: cloneServerTarget(nextTarget),
      changedFields: diffServerTargetFields(previousTarget, nextTarget)
    });
  }

  private resolveCatalogEntryByLabel(label: string | null | undefined): MinecraftServerCatalogEntry | null {
    const normalized = String(label || "").trim().toLowerCase();
    if (!normalized) return null;
    return this.serverCatalog.find((entry) => entry.label.toLowerCase() === normalized) ?? null;
  }

  private resolveBrainActionCommand(action: MinecraftBrainAction): ParsedCommand | null {
    switch (action.kind) {
      case "connect": {
        const target = this.serverTarget;
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
      case "look":
        return { kind: "look" };
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
      case "eat":
        return { kind: "eat" };
      case "equip_offhand":
        return { kind: "equip_offhand", itemName: action.itemName };
      case "craft":
        return {
          kind: "craft",
          recipeName: action.recipeName,
          count: action.count ?? 1,
          useCraftingTable: action.useCraftingTable ?? false
        };
      case "deposit":
        return { kind: "deposit", chest: action.chest, items: action.items };
      case "withdraw":
        return { kind: "withdraw", chest: action.chest, items: action.items };
      case "place_block":
        return {
          kind: "place_block",
          x: action.x,
          y: action.y,
          z: action.z,
          blockName: action.blockName
        };
      case "build":
        // Build requires plan expansion — handled in executeBrainAction.
        return null;
      case "wait":
      case "project_start":
      case "project_step":
      case "project_pause":
      case "project_resume":
      case "project_abort":
        // No direct world action; handled by executeBrainAction.
        return null;
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
        ok: true,
        failure: null
      };
    }

    if (action.kind === "connect") {
      const previousTarget = cloneServerTarget(this.serverTarget);
      const rawTarget = normalizeMinecraftServerTarget(action.target);
      const catalogEntry = this.resolveCatalogEntryByLabel(rawTarget?.label);
      const enrichedTarget: MinecraftServerTarget | null = rawTarget
        ? {
            label: rawTarget.label,
            host: rawTarget.host ?? catalogEntry?.host ?? null,
            port: rawTarget.port ?? catalogEntry?.port ?? null,
            description: rawTarget.description ?? catalogEntry?.description ?? null
          }
        : null;
      const updatedTarget = mergeServerTargets(this.serverTarget, enrichedTarget);
      if (updatedTarget) {
        this.serverTarget = updatedTarget;
        this.logServerTargetUpdate("brain_action", previousTarget, this.serverTarget);
      }
    }

    // Project actions mutate planner state but don't touch the MCP runtime.
    if (action.kind === "project_start"
      || action.kind === "project_step"
      || action.kind === "project_pause"
      || action.kind === "project_resume"
      || action.kind === "project_abort") {
      return this.executeProjectAction(action);
    }

    // Build actions expand via the sub-planner before dispatching to the
    // BuildStructureSkill. The expansion may involve an LLM call for
    // freeform descriptions.
    let execution: CommandExecutionResult;
    if (action.kind === "build") {
      execution = await this.executeBuildAction(action, options);
    } else {
      const command = this.resolveBrainActionCommand(action);
      if (!command) {
        return {
          text: `No-op Minecraft action: ${action.kind}.`,
          ok: true,
          failure: null
        };
      }
      execution = await this.executeCommand(command, options);
    }

    // Auto-deduct from the active project budget when a concrete in-world
    // action ran during project execution. project_step remains the
    // brain-explicit path for ticking checkpoints.
    this.maybeAccrueProjectAction(action, execution);
    return execution;
  }

  private maybeAccrueProjectAction(
    action: MinecraftBrainAction,
    execution: CommandExecutionResult
  ): void {
    const project = this.plannerState.activeProject;
    if (!project || project.status !== "executing") return;
    if (!execution.ok) return;
    // These action kinds don't cost a project action — they're reads,
    // teardown, or session plumbing.
    const nonAccruing: ReadonlySet<MinecraftBrainAction["kind"]> = new Set([
      "wait",
      "status",
      "stop",
      "connect",
      "disconnect",
      "chat",
      "look",
      "look_at"
    ]);
    if (nonAccruing.has(action.kind)) return;
    project.actionsUsed += 1;
    project.lastStepAt = new Date().toISOString();
    if (project.actionsUsed >= project.actionBudget) {
      project.status = "paused";
      this.logLifecycle("minecraft_project_budget_exceeded", {
        projectId: project.id,
        actionsUsed: project.actionsUsed,
        budget: project.actionBudget,
        triggerKind: action.kind
      });
    }
  }

  // ── Project lifecycle ────────────────────────────────────────────────────

  private async executeProjectAction(action: MinecraftBrainAction & {
    kind: "project_start" | "project_step" | "project_pause" | "project_resume" | "project_abort";
  }): Promise<CommandExecutionResult> {
    if (action.kind === "project_start") {
      if (this.plannerState.activeProject
        && this.plannerState.activeProject.status !== "completed"
        && this.plannerState.activeProject.status !== "abandoned") {
        return {
          text: `A project is already active: "${this.plannerState.activeProject.title}". Abort or complete it first.`,
          ok: false,
          failure: {
            actionKind: "project_start",
            reason: "project_already_active",
            message: `Active project: ${this.plannerState.activeProject.title}`
          }
        };
      }
      const title = String(action.title || "").trim().slice(0, 80) || "Untitled project";
      const description = String(action.description || "").trim().slice(0, 400);
      const checkpoints = Array.isArray(action.checkpoints)
        ? action.checkpoints
            .map((entry) => String(entry || "").trim())
            .filter(Boolean)
            .slice(0, 8)
        : [];
      const budget = Math.max(
        1,
        Math.min(200, Math.round(Number(action.actionBudget) || this.defaultProjectBudget))
      );
      const project: MinecraftProject = {
        id: `proj_${Date.now().toString(36)}`,
        title,
        description,
        checkpoints,
        completedCheckpoints: [],
        status: "executing",
        actionsUsed: 0,
        actionBudget: budget,
        startedAt: new Date().toISOString(),
        lastStepAt: null,
        lastStepSummary: null
      };
      this.plannerState.activeProject = project;
      this.logLifecycle("minecraft_project_started", {
        projectId: project.id,
        title,
        checkpoints,
        budget
      });
      return {
        text: `Started project "${title}" with budget ${budget} actions and ${checkpoints.length} checkpoints.`,
        ok: true,
        failure: null
      };
    }

    const project = this.plannerState.activeProject;
    if (!project) {
      return {
        text: "No active project to operate on.",
        ok: false,
        failure: {
          actionKind: action.kind,
          reason: "no_active_project",
          message: "No active project"
        }
      };
    }

    if (action.kind === "project_step") {
      if (project.status !== "executing") {
        this.logLifecycle("minecraft_project_step_rejected", {
          projectId: project.id,
          status: project.status
        });
        return {
          text: `Project "${project.title}" is ${project.status}. Resume it first.`,
          ok: false,
          failure: {
            actionKind: "project_step",
            reason: "project_not_executing",
            message: `project status: ${project.status}`
          }
        };
      }
      const summary = String(action.summary || "").trim().slice(0, 200);
      project.actionsUsed += 1;
      project.lastStepAt = new Date().toISOString();
      project.lastStepSummary = summary || null;
      if (summary) {
        const checkpointIndex = project.checkpoints.findIndex(
          (cp) => cp === summary || cp.toLowerCase() === summary.toLowerCase()
        );
        if (checkpointIndex >= 0 && !project.completedCheckpoints.includes(project.checkpoints[checkpointIndex]!)) {
          project.completedCheckpoints.push(project.checkpoints[checkpointIndex]!);
        }
      }
      const budgetExceeded = project.actionsUsed >= project.actionBudget;
      if (budgetExceeded) {
        project.status = "paused";
        this.logLifecycle("minecraft_project_budget_exceeded", {
          projectId: project.id,
          actionsUsed: project.actionsUsed,
          budget: project.actionBudget
        });
        return {
          text: `Project "${project.title}" hit its ${project.actionBudget}-action budget. Paused.`,
          ok: false,
          failure: {
            actionKind: "project_step",
            reason: "budget_exceeded",
            message: `${project.actionsUsed}/${project.actionBudget} actions used`
          }
        };
      }
      this.logLifecycle("minecraft_project_step", {
        projectId: project.id,
        actionsUsed: project.actionsUsed,
        summary
      });
      return {
        text: `Project step ${project.actionsUsed}/${project.actionBudget} logged${summary ? `: ${summary}` : ""}.`,
        ok: true,
        failure: null
      };
    }

    if (action.kind === "project_pause") {
      project.status = "paused";
      this.logLifecycle("minecraft_project_paused", {
        projectId: project.id,
        reason: action.reason || null
      });
      return {
        text: `Project "${project.title}" paused.`,
        ok: true,
        failure: null
      };
    }

    if (action.kind === "project_resume") {
      if (project.status === "abandoned") {
        return {
          text: `Project "${project.title}" was abandoned and cannot be resumed. Start a new project instead.`,
          ok: false,
          failure: {
            actionKind: "project_resume",
            reason: "project_not_executing",
            message: "project status: abandoned"
          }
        };
      }
      if (project.actionsUsed >= project.actionBudget) {
        return {
          text: `Project "${project.title}" already exhausted its ${project.actionBudget}-action budget and cannot resume. Start a new project instead.`,
          ok: false,
          failure: {
            actionKind: "project_resume",
            reason: "budget_exceeded",
            message: `${project.actionsUsed}/${project.actionBudget} actions used`
          }
        };
      }
      project.status = "executing";
      this.logLifecycle("minecraft_project_resumed", {
        projectId: project.id
      });
      return {
        text: `Project "${project.title}" resumed.`,
        ok: true,
        failure: null
      };
    }

    if (action.kind === "project_abort") {
      project.status = "abandoned";
      this.logLifecycle("minecraft_project_aborted", {
        projectId: project.id,
        reason: action.reason || null,
        actionsUsed: project.actionsUsed
      });
      return {
        text: `Project "${project.title}" aborted after ${project.actionsUsed} actions.`,
        ok: true,
        failure: null
      };
    }

    return {
      text: `Unknown project action.`,
      ok: false,
      failure: {
        actionKind: "project_step",
        reason: "unknown",
        message: "unknown project action"
      }
    };
  }

  // ── Build expansion ──────────────────────────────────────────────────────

  private async executeBuildAction(
    action: MinecraftBrainAction & { kind: "build" },
    options: SubAgentTurnOptions
  ): Promise<CommandExecutionResult> {
    let plan = action.plan ?? null;
    if (!plan) {
      if (!this.builder) {
        return {
          text: "Build sub-planner is unavailable.",
          ok: false,
          failure: {
            actionKind: "build",
            reason: "invalid_target",
            message: "no build sub-planner"
          }
        };
      }
      const description = String(action.description || "").trim();
      if (!description) {
        return {
          text: "Build action needs either a plan or a description.",
          ok: false,
          failure: {
            actionKind: "build",
            reason: "invalid_target",
            message: "no description or plan"
          }
        };
      }
      // Pull a sensible origin — either the supplied one or the bot's position.
      let origin: Position | null = action.origin ?? null;
      if (!origin) {
        await this.ensureConnected(options.signal);
        const statusResult = await this.runtime.status(options.signal).catch(() => null);
        if (statusResult?.ok && statusResult.output.position) {
          origin = {
            x: Math.round(statusResult.output.position.x),
            y: Math.round(statusResult.output.position.y),
            z: Math.round(statusResult.output.position.z)
          };
        }
      }
      if (!origin) {
        return {
          text: "Cannot plan build — no origin position available.",
          ok: false,
          failure: {
            actionKind: "build",
            reason: "invalid_target",
            message: "no origin"
          }
        };
      }
      try {
        plan = await this.builder.buildPlan({
          description,
          origin,
          ...(action.dimensions ? { dimensions: action.dimensions } : {})
        });
      } catch (error) {
        return {
          text: `Build planning failed: ${error instanceof Error ? error.message : String(error)}`,
          ok: false,
          failure: {
            actionKind: "build",
            reason: "unknown",
            message: error instanceof Error ? error.message : String(error)
          }
        };
      }
      if (!plan || plan.blocks.length === 0) {
        return {
          text: "Build sub-planner returned an empty plan.",
          ok: false,
          failure: {
            actionKind: "build",
            reason: "invalid_target",
            message: "empty plan"
          }
        };
      }
      this.logLifecycle("minecraft_build_plan_expanded", {
        title: plan.title,
        blockCount: plan.blocks.length
      });
    }

    return this.executeCommand({ kind: "build", plan }, options);
  }

  private async runPlannerLoop(
    task: string,
    options: SubAgentTurnOptions
  ): Promise<{ text: string; costUsd: number; imageInputs?: ImageInput[] }> {
    if (!this.brain) {
      throw new Error("Minecraft brain is unavailable for natural-language planning.");
    }

    const instruction = task.trim();
    if (instruction) {
      this.plannerState.lastInstruction = instruction;
    }

    let checkpointInstruction = instruction || this.plannerState.lastInstruction || "status";
    let costUsd = 0;
    const summaries: string[] = [];
    let latestImageInputs: ImageInput[] | undefined;

    for (let checkpoint = 1; checkpoint <= MAX_PLANNER_CHECKPOINTS_PER_TURN; checkpoint += 1) {
      const snapshot = await this.getWorldSnapshot();
      const lookCapture = this.consumePendingLookCapture();
      const decision = await this.brain.planTurn({
        instruction: checkpointInstruction,
        chatHistory: this.chatHistory.slice(-20),
        discordContext: this.resolveDiscordContext(),
        worldSnapshot: snapshot,
        botUsername: this.botUsername || "ClankyBuddy",
        mode: this.mode,
        knownIdentities: this.knownIdentities.map((entry) => ({ ...entry })),
        constraints: { ...this.constraints },
        serverTarget: this.serverTarget,
        serverCatalog: [...this.serverCatalog],
        sessionState: this.getPlannerStateSnapshot(),
        lookCapture,
        lookImageInputs: toLookImageInputs(lookCapture)
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
      this.recordPlannerActionResult(execution, decision.action.kind);
      if (execution.imageInputs?.length) {
        latestImageInputs = execution.imageInputs;
      }

      if (!canContinueAfterBrainAction(decision.action, execution, decision.shouldContinue)) {
        break;
      }

      checkpointInstruction = execution.lookCapture
        ? "Continue the current Minecraft goal using the attached rendered first-person glance, plus the updated world state and planner state."
        : "Continue the current Minecraft goal using the updated world state and planner state.";
    }

    return {
      text: joinPlannerSummaries(summaries) || this.buildPlannerStateSummary() || "Standing by in Minecraft.",
      costUsd,
      ...(latestImageInputs?.length ? { imageInputs: latestImageInputs } : {})
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
    if (normalizedServerTarget) {
      const previousTarget = cloneServerTarget(this.serverTarget);
      this.serverTarget = mergeServerTargets(this.serverTarget, normalizedServerTarget);
      this.logServerTargetUpdate("turn_input", previousTarget, this.serverTarget);
    }

    const task = parsed.task || "";
    let command: ParsedCommand | null = parsed.command ? parseStructuredCommand(parsed.command) : null;
    let costUsd = 0;
    if (!command && !task) {
      // No task and no recognizable structured command — default to a status read.
      command = { kind: "status" };
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

    if (!command && !this.brain) {
      const message = "Minecraft brain is unavailable for natural-language planning.";
      this.logLifecycle("minecraft_turn_error", {
        turnCount: this.turnCount,
        command: "planner",
        error: message
      });
      return {
        text: `Minecraft task failed: ${message}`,
        costUsd,
        isError: true,
        errorMessage: message,
        usage: { ...EMPTY_USAGE }
      };
    }

    try {
      let resultText = "";
      let resultCostUsd = 0;
      let resultImageInputs: ImageInput[] | undefined;

      if (command) {
        const execution = await this.executeCommand(command, options);
        resultText = execution.text;
        resultImageInputs = execution.imageInputs;
        if (task.trim()) {
          this.plannerState.lastInstruction = task.trim();
        }
        this.recordPlannerActionResult(execution, command.kind);
      } else {
        const planned = await this.runPlannerLoop(task, options);
        resultText = planned.text;
        resultCostUsd = planned.costUsd;
        resultImageInputs = planned.imageInputs;
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
        ...(resultImageInputs?.length ? { imageInputs: resultImageInputs } : {}),
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

    const commandResult = async (
      text: string,
      ok = true,
      extra: Pick<CommandExecutionResult, "imageInputs" | "lookCapture"> = {}
    ): Promise<CommandExecutionResult> => ({
      text,
      ok,
      failure: ok ? null : await this.buildActionFailure(command, text, options.signal),
      ...extra
    });

    const resolveFollowDistance = (explicitDistance?: number) => {
      const constrainedDistance = this.constraints.maxDistance;
      return clampDistance(explicitDistance ?? constrainedDistance, 3, 16);
    };

    const resolveCollectDistance = () => {
      if (this.constraints.maxDistance === undefined) return 32;
      return clampDistance(this.constraints.maxDistance, 32, 32);
    };

    const violatesStayNearConstraint = async (target: Position): Promise<{ distance: number; maxDistance: number } | null> => {
      const leashTarget = this.constraints.stayNearPlayer;
      if (!leashTarget || this.constraints.maxDistance === undefined) {
        return null;
      }
      const status = await this.runtime.status(options.signal);
      if (!status.ok) return null;
      const leashPlayer = (status.output.players ?? []).find(
        (player) => player.username === leashTarget && player.position
      );
      if (!leashPlayer?.position) return null;
      const distance = distanceBetweenPositions(target, leashPlayer.position);
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

      case "look": {
        // No clearModes() call here — a rendered glance is a read-only
        // action and must not drop an ongoing follow/guard/path task.
        const result = await this.runtime.look(640, 360, 4, options.signal);
        if (!result.ok) return commandResult(`Look capture failed: ${result.error}`, false);
        this.pendingLookCapture = result.output;
        this.pendingLookCapturedAtMs = Date.now();
        return commandResult(
          `Captured a rendered first-person glance from the current view.`,
          true,
          {
            lookCapture: result.output,
            imageInputs: toLookImageInputs(result.output)
          }
        );
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
            `Cannot move there while staying near ${this.constraints.stayNearPlayer}. Target is ${constrainedTarget.distance.toFixed(1)} blocks away (max ${constrainedTarget.maxDistance}).`,
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

      case "eat": {
        const result = await this.runtime.eatBestFood(options.signal);
        if (!result.ok) return commandResult(`Eat failed: ${result.error}`, false);
        const output = result.output;
        return commandResult(`Ate ${output.foodName} (food ${output.foodBefore ?? "?"} -> ${output.foodAfter ?? "?"}).`);
      }

      case "equip_offhand": {
        if (!command.itemName) return commandResult("Cannot equip — no item specified.", false);
        const result = await this.runtime.equipOffhand(command.itemName, options.signal);
        if (!result.ok) return commandResult(`Equip failed: ${result.error}`, false);
        return commandResult(`Equipped ${result.output.itemName} to off-hand.`);
      }

      case "craft": {
        const skill = new CraftItemSkill(
          this.runtime,
          command.recipeName,
          command.count,
          command.useCraftingTable
        );
        const preconditions = skill.checkPreconditions();
        if (!preconditions.ok) return commandResult(`Cannot craft: ${preconditions.reason}`, false);
        const skillResult = await skill.execute({
          signal: options.signal ?? AbortSignal.timeout(60_000),
          onProgress: (msg) => options.onProgress?.({ summary: msg })
        });
        return commandResult(skillResult.summary, skillResult.status === "succeeded");
      }

      case "deposit": {
        const chestViolation = this.checkChestConstraint(command.chest);
        if (chestViolation) return commandResult(chestViolation, false);
        const skill = new DepositItemsSkill(this.runtime, command.chest, command.items);
        const preconditions = skill.checkPreconditions();
        if (!preconditions.ok) return commandResult(`Cannot deposit: ${preconditions.reason}`, false);
        const skillResult = await skill.execute({
          signal: options.signal ?? AbortSignal.timeout(30_000),
          onProgress: (msg) => options.onProgress?.({ summary: msg })
        });
        return commandResult(skillResult.summary, skillResult.status === "succeeded");
      }

      case "withdraw": {
        const chestViolation = this.checkChestConstraint(command.chest);
        if (chestViolation) return commandResult(chestViolation, false);
        const skill = new WithdrawItemsSkill(this.runtime, command.chest, command.items);
        const preconditions = skill.checkPreconditions();
        if (!preconditions.ok) return commandResult(`Cannot withdraw: ${preconditions.reason}`, false);
        const skillResult = await skill.execute({
          signal: options.signal ?? AbortSignal.timeout(30_000),
          onProgress: (msg) => options.onProgress?.({ summary: msg })
        });
        return commandResult(skillResult.summary, skillResult.status === "succeeded");
      }

      case "place_block": {
        const result = await this.runtime.placeBlock(
          command.x,
          command.y,
          command.z,
          command.blockName,
          options.signal
        );
        if (!result.ok) return commandResult(`Place failed: ${result.error}`, false);
        return commandResult(`Placed ${result.output.blockName} at ${command.x},${command.y},${command.z}.`);
      }

      case "build": {
        const skill = new BuildStructureSkill(this.runtime, command.plan);
        const preconditions = skill.checkPreconditions();
        if (!preconditions.ok) return commandResult(`Cannot build: ${preconditions.reason}`, false);
        const skillResult = await skill.execute({
          signal: options.signal ?? AbortSignal.timeout(180_000),
          onProgress: (msg) => options.onProgress?.({ summary: msg })
        });
        return commandResult(skillResult.summary, skillResult.status === "succeeded");
      }

      default:
        return commandResult("Unknown command.", false);
    }
  }

  private checkChestConstraint(chest: { x: number; y: number; z: number }): string | null {
    const allowed = this.constraints.allowedChests;
    if (!Array.isArray(allowed) || allowed.length === 0) return null;
    const match = allowed.some((entry) =>
      entry.x === chest.x && entry.y === chest.y && entry.z === chest.z
    );
    if (match) return null;
    const allowedSummary = allowed
      .slice(0, 4)
      .map((entry) => `${entry.label ? `${entry.label}:` : ""}${entry.x},${entry.y},${entry.z}`)
      .join(" | ");
    return `Chest ${chest.x},${chest.y},${chest.z} is not in allowedChests (${allowedSummary}).`;
  }

  protected onCancelled(_reason: string): void {
    this.stopReflexLoop();
    this.clearChatReplyFlushTimer();
    // Best-effort stop the bot when the session is cancelled.
    void this.runtime.stop().catch(() => {});
  }

  protected onClosed(): void {
    this.stopReflexLoop();
    this.clearChatReplyFlushTimer();
    // Best-effort stop on close.
    void this.runtime.stop().catch(() => {});
  }

  /**
   * Get a compressed world snapshot for status reporting.
   */
  async getWorldSnapshot() {
    try {
      const maybeVisibleBlocks = this.runtime as MinecraftRuntime & {
        visibleBlocks?: () => Promise<{ ok: boolean; output: MinecraftVisualScene }>;
      };
      const [statusResult, visibleBlocksResult] = await Promise.all([
        this.runtime.status(),
        typeof maybeVisibleBlocks.visibleBlocks === "function"
          ? maybeVisibleBlocks.visibleBlocks().catch(() => ({ ok: false, output: null as never }))
          : Promise.resolve({ ok: false, output: null as never })
      ]);
      if (!statusResult.ok) return null;
      return buildWorldSnapshot(
        this.id,
        this.mode,
        statusResult.output,
        this.knownIdentities.map((entry) => entry.mcUsername),
        visibleBlocksResult.ok ? visibleBlocksResult.output : null
      );
    } catch {
      return null;
    }
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────

export function createMinecraftSession(options: MinecraftSessionOptions): MinecraftSession {
  return new MinecraftSession(options);
}
