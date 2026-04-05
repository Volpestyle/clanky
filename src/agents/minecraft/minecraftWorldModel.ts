/**
 * Transforms the MCP server's StatusSnapshot into the agent-layer WorldSnapshot.
 *
 * The MCP server returns raw bot telemetry; this module maps it into the
 * structured WorldSnapshot that the planner and reflex systems consume.
 */

import type {
  HazardSnapshot,
  MinecraftMode,
  MinecraftVisualScene,
  PlayerSnapshot,
  Position,
  SelfSnapshot,
  TaskSnapshot,
  WorldSnapshot
} from "./types.ts";
import type { McpStatusSnapshot, McpPlayerEntry, McpHazardEntry } from "./minecraftRuntime.ts";

// ── Helpers ─────────────────────────────────────────────────────────────────

function toPosition(raw: { x: number; y: number; z: number } | undefined | null): Position | null {
  if (!raw) return null;
  return { x: raw.x, y: raw.y, z: raw.z };
}

function buildPlayerSnapshot(entry: McpPlayerEntry, _botPosition: Position | null): PlayerSnapshot {
  return {
    name: entry.username,
    distance: entry.distance ?? Infinity,
    position: toPosition(entry.position),
    visible: entry.online && entry.position != null
  };
}

function buildSelfSnapshot(status: McpStatusSnapshot): SelfSnapshot | null {
  if (!status.connected || !status.position) return null;
  const equipment = status.equipment ?? {
    hand: null,
    offhand: null,
    helmet: null,
    chestplate: null,
    leggings: null,
    boots: null
  };
  return {
    position: toPosition(status.position)!,
    health: status.health ?? 20,
    maxHealth: 20,
    food: status.food ?? 20,
    saturation: 0,
    oxygen: 20,
    isOnFire: false,
    dimension: status.dimension ?? "overworld",
    gameMode: status.gameMode ?? "survival",
    equipment: {
      hand: equipment.hand,
      offhand: equipment.offhand,
      helmet: equipment.helmet,
      chestplate: equipment.chestplate,
      leggings: equipment.leggings,
      boots: equipment.boots
    },
    inventoryFull: (status.inventory?.length ?? 0) >= 36,
    inventorySummary: (status.inventory ?? []).map((item) => ({
      name: item.name,
      count: item.count
    }))
  };
}

function buildHazardSnapshot(entry: McpHazardEntry): HazardSnapshot | null {
  const position = toPosition(entry.position);
  if (!position) return null;
  return {
    type: entry.type,
    distance: entry.distance,
    position
  };
}

function buildTaskSnapshot(taskString: string): TaskSnapshot | null {
  if (!taskString || taskString === "idle" || taskString === "disconnected") return null;
  return {
    goal: taskString,
    step: taskString,
    retries: 0,
    startedAt: Date.now()
  };
}

// ── Public ───────────────────────────────────────────────────────────────────

/**
 * Build a WorldSnapshot from MCP server status.
 *
 * @param sessionId          The agent session owning this snapshot.
 * @param mode               Current operating mode.
 * @param status             Raw StatusSnapshot from the MCP server.
 * @param knownMcUsernames   Optional list of MC usernames the operator has
 *                           configured as known identities. If any visible
 *                           player matches, the closest one is promoted to
 *                           `primaryPlayer` as a focus hint. When empty (or
 *                           no matches), `primaryPlayer` is null and every
 *                           player shows up in `nearbyPlayers` — Clanky
 *                           forms impressions organically.
 */
export function buildWorldSnapshot(
  sessionId: string,
  mode: MinecraftMode,
  status: McpStatusSnapshot,
  knownMcUsernames: readonly string[] | null = [],
  visualScene: MinecraftVisualScene | null = null
): WorldSnapshot {
  const self = buildSelfSnapshot(status);
  const allPlayers = (status.players ?? [])
    .filter((p) => p.username !== status.username)
    .map((p) => buildPlayerSnapshot(p, self?.position ?? null));

  // Promote the closest visible known identity to primaryPlayer when one is
  // present. No arbitrary "closest visible player" fallback — without known
  // identities, everyone is a peer and the brain reasons about them equally.
  const knownSet = new Set((knownMcUsernames ?? []).map((name) => name.toLowerCase()));
  let primaryPlayer: PlayerSnapshot | null = null;
  const nearbyPlayers: PlayerSnapshot[] = [];
  if (knownSet.size > 0) {
    const visibleKnown = allPlayers
      .filter((p) => p.visible && knownSet.has(p.name.toLowerCase()))
      .sort((a, b) => a.distance - b.distance);
    primaryPlayer = visibleKnown[0] ?? null;
  }
  for (const p of allPlayers) {
    if (p === primaryPlayer) continue;
    nearbyPlayers.push(p);
  }

  const hazards = (status.hazards ?? [])
    .map((entry) => buildHazardSnapshot(entry))
    .filter((entry): entry is HazardSnapshot => Boolean(entry));

  return {
    sessionId,
    mode,
    connected: status.connected,
    self,
    player: primaryPlayer,
    nearbyPlayers,
    hazards,
    task: buildTaskSnapshot(status.task),
    recentEvents: status.recentEvents ?? [],
    visualScene,
    timeOfDay: status.timeOfDay ?? null,
    isRaining: false,
    reflexStatus: "idle"
  };
}
