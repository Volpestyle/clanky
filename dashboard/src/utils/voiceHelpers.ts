import type { VoiceSession } from "../hooks/useVoiceSSE";

type DashboardVoiceBotState = "processing" | "speaking" | "listening" | "idle" | "disconnected";

export function deriveBotState(session: VoiceSession): DashboardVoiceBotState {
  const pendingTurns = (session.batchAsr?.pendingTurns || 0) + (session.realtime?.pendingTurns || 0);
  if (session.botTurnOpen) return "speaking";
  if (pendingTurns > 0) return "processing";
  if (session.activeInputStreams > 0) return "listening";

  const connected = session.realtime?.state
    ? (session.realtime.state as { connected?: boolean })?.connected !== false
    : true;
  if (!connected) return "disconnected";
  return "idle";
}

export function elapsed(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

export function normalizePromptText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

export function normalizeFollowupPrompts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => normalizePromptText(entry));
}

export type PromptTierSnapshot = {
  key: string;
  label: string;
  present: boolean;
  sources: string[];
  details: Record<string, unknown> | null;
};

export function normalizePromptTiers(value: unknown): PromptTierSnapshot[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
      const record = entry as Record<string, unknown>;
      const key = String(record.key || "").trim();
      if (!key) return null;
      const label = String(record.label || key).trim() || key;
      const sources = Array.isArray(record.sources)
        ? record.sources.map((source) => String(source || "").trim()).filter(Boolean)
        : [];
      const details = record.details && typeof record.details === "object" && !Array.isArray(record.details)
        ? record.details as Record<string, unknown>
        : null;
      return {
        key,
        label,
        present: record.present !== false,
        sources,
        details
      } satisfies PromptTierSnapshot;
    })
    .filter((entry): entry is PromptTierSnapshot => entry !== null);
}
