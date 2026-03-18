import type { VoiceSession } from "../hooks/useVoiceSSE";

export type DashboardVoiceBotState = "processing" | "speaking" | "listening" | "idle" | "disconnected";

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
