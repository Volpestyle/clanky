import type { ReactNode } from "react";
import type {
  LatencyTurnEntry,
  PromptLogBundle,
  PromptSnapshot,
  SessionLatency,
  VoiceMembershipEvent,
  VoiceSession
} from "../../hooks/useVoiceSSE";
import {
  normalizeFollowupPrompts,
  normalizePromptText
} from "../../utils/voiceHelpers";

// Human-readable labels for session modes surfaced in Voice Monitor cards/history.
export const MODE_LABELS: Record<string, string> = {
  voice_agent: "Voice Agent",
  openai: "OpenAI",
  openai_realtime: "OpenAI RT",
  gemini: "Gemini",
  gemini_realtime: "Gemini RT",
  elevenlabs: "ElevenLabs",
  elevenlabs_realtime: "ElevenLabs API",
  xai: "xAI",
  xai_realtime: "xAI RT"
};

// Human-readable labels for synthesized bot/session state.
export const STATE_LABELS: Record<string, string> = {
  speaking: "Speaking",
  processing: "Processing",
  listening: "Listening",
  idle: "Idle",
  disconnected: "Disconnected"
};

// Consistent timeline color mapping by event kind.
export const EVENT_KIND_COLORS: Record<string, string> = {
  session_start: "#4ade80",
  session_end: "#f87171",
  turn_in: "#60a5fa",
  turn_out: "#bef264",
  turn_addressing: "#c084fc",
  soundboard_play: "#fb923c",
  error: "#f87171",
  runtime: "#64748b",
  intent_detected: "#22d3ee"
};

// Event kinds available in timeline/history filter chips.
export const EVENT_KINDS = [
  "session_start",
  "session_end",
  "turn_in",
  "turn_out",
  "turn_addressing",
  "soundboard_play",
  "error",
  "runtime",
  "intent_detected"
];

// If explicit wake state is missing, treat recent direct-address/reply as active wake.
const WAKE_WINDOW_FALLBACK_MS = 35_000;
// Assistant turns and latency samples within this delta are considered the same turn.
const LATENCY_MATCH_MAX_DIFF_MS = 30_000;

// Stage order and colors for latency bars/legends.
export const LATENCY_STAGES = [
  { key: "finalizedToAsrStartMs" as const, label: "ASR Wait", color: "#60a5fa" },
  { key: "asrToGenerationStartMs" as const, label: "LLM Think", color: "#fbbf24" },
  { key: "generationToReplyRequestMs" as const, label: "Reply Prep", color: "#c084fc" },
  { key: "replyRequestToAudioStartMs" as const, label: "TTS", color: "#4ade80" }
];

export function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

export function timeUntil(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "expired";
  const s = Math.ceil(ms / 1000);
  const m = Math.floor(s / 60);
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function parseIsoMs(iso?: string | null): number | null {
  const normalized = String(iso || "").trim();
  if (!normalized) return null;
  const parsed = new Date(normalized).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatApproxBytes(bytes: number | null | undefined): string {
  const normalized = Math.max(0, Number(bytes) || 0);
  if (normalized < 1024) return `${normalized} B`;
  if (normalized < 1024 * 1024) return `${(normalized / 1024).toFixed(1)} KB`;
  return `${(normalized / (1024 * 1024)).toFixed(2)} MB`;
}

export function resolveWakeIndicator(session: VoiceSession): {
  active: boolean;
  stateLabel: "Active" | "Ambient";
} {
  const wake = session.conversation?.wake || null;
  if (wake && typeof wake === "object") {
    const active = Boolean(wake.active);
    return {
      active,
      stateLabel: active ? "Active" : "Ambient"
    };
  }

  const now = Date.now();
  const lastAssistantReplyAtMs = parseIsoMs(session.conversation?.lastAssistantReplyAt);
  const lastDirectAddressAtMs = parseIsoMs(session.conversation?.lastDirectAddressAt);
  const msSinceAssistantReply =
    lastAssistantReplyAtMs != null ? Math.max(0, now - lastAssistantReplyAtMs) : null;
  const msSinceDirectAddress =
    lastDirectAddressAtMs != null ? Math.max(0, now - lastDirectAddressAtMs) : null;
  const active =
    Boolean(session.focusedSpeaker) ||
    (msSinceAssistantReply != null && msSinceAssistantReply <= WAKE_WINDOW_FALLBACK_MS) ||
    (msSinceDirectAddress != null && msSinceDirectAddress <= WAKE_WINDOW_FALLBACK_MS);
  return {
    active,
    stateLabel: active ? "Active" : "Ambient"
  };
}

export function snippet(text?: string, max = 120): string {
  if (!text) return "";
  return text.length > max ? text.slice(0, max) + "..." : text;
}

function getPromptBundle(snapshot: PromptSnapshot): Exclude<PromptLogBundle, null> | null {
  if (!snapshot || typeof snapshot !== "object") return null;
  const bundle = snapshot.replyPrompts;
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) return null;
  return bundle;
}

export function hasPromptSnapshot(snapshot: PromptSnapshot): boolean {
  const bundle = getPromptBundle(snapshot);
  if (!bundle) return false;
  if (normalizePromptText(bundle.systemPrompt)) return true;
  if (normalizePromptText(bundle.initialUserPrompt)) return true;
  return normalizeFollowupPrompts(bundle.followupUserPrompts).length > 0;
}

export function toPromptBundle(snapshot: PromptSnapshot): Exclude<PromptLogBundle, null> | null {
  return getPromptBundle(snapshot);
}

export function formatPromptBundleForCopy(bundle: Exclude<PromptLogBundle, null> | null): string {
  if (!bundle) return "";
  const parts = [
    `System Prompt:\n${normalizePromptText(bundle.systemPrompt) || "(empty)"}`,
    `Initial User Prompt:\n${normalizePromptText(bundle.initialUserPrompt) || "(empty)"}`
  ];
  const followups = normalizeFollowupPrompts(bundle.followupUserPrompts);
  if (followups.length > 0) {
    parts.push(
      `Follow-up User Prompts (${followups.length}):\n${followups
        .map((prompt, index) => `Step ${index + 1}:\n${prompt || "(empty)"}`)
        .join("\n\n")}`
    );
  }
  return parts.join("\n\n");
}

export function resolveCaptureTargetName(capture: {
  userId: string;
  displayName: string | null;
}): string {
  const displayName = String(capture?.displayName || "").trim();
  if (displayName) return displayName;
  const userId = String(capture?.userId || "").trim();
  return userId ? userId.slice(0, 8) : "unknown";
}

export function isFinalHistoryTranscriptEventType(eventType: unknown, source: unknown): boolean {
  const normalized = String(eventType || "")
    .trim()
    .toLowerCase();
  const normalizedSource = String(source || "")
    .trim()
    .toLowerCase();

  if (!normalized) {
    return normalizedSource !== "output";
  }
  if (normalized.includes("delta") || normalized.includes("partial")) return false;
  if (normalized === "server_content_text") return false;

  if (normalized.includes("input_audio_transcription")) {
    return normalized.includes("completed") || normalized === "input_audio_transcription";
  }
  if (normalized.includes("output_audio_transcription")) {
    return (
      normalized.includes("done") ||
      normalized.includes("completed") ||
      normalized === "output_audio_transcription"
    );
  }
  if (normalized.includes("output_audio_transcript")) {
    return normalized.includes("done") || normalized.includes("completed");
  }
  if (normalized.includes("response.output_text")) {
    return normalized.endsWith(".done") || normalized.includes("completed");
  }
  if (normalized.includes("response.text")) {
    return normalized.includes("done") || normalized.includes("completed");
  }
  if (/audio_transcript/u.test(normalized)) {
    return !normalized.includes("delta");
  }
  if (/transcript/u.test(normalized)) {
    return !normalized.includes("delta");
  }
  return true;
}

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function formatTrackDuration(seconds: number | null): string {
  if (!Number.isFinite(seconds) || seconds == null || seconds < 0) return "--:--";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function matchLatencyToTurns(
  turns: { role: string; at: string | null }[],
  latencyTurns: LatencyTurnEntry[]
): Map<number, LatencyTurnEntry> {
  const result = new Map<number, LatencyTurnEntry>();
  if (latencyTurns.length === 0) return result;
  const used = new Set<number>();

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    if (turn.role !== "assistant" || !turn.at) continue;
    const turnMs = new Date(turn.at).getTime();
    if (!Number.isFinite(turnMs)) continue;

    let bestIdx = -1;
    let bestDiff = Infinity;
    for (let j = 0; j < latencyTurns.length; j++) {
      if (used.has(j)) continue;
      const entryMs = new Date(latencyTurns[j].at).getTime();
      const diff = Math.abs(entryMs - turnMs);
      if (diff < bestDiff && diff < LATENCY_MATCH_MAX_DIFF_MS) {
        bestDiff = diff;
        bestIdx = j;
      }
    }
    if (bestIdx >= 0) {
      result.set(i, latencyTurns[bestIdx]);
      used.add(bestIdx);
    }
  }
  return result;
}

export function Stat({
  label,
  value,
  warn
}: {
  label: string;
  value: ReactNode;
  warn?: boolean;
}) {
  return (
    <div className={`vm-stat ${warn ? "vm-stat-warn" : ""}`}>
      <span className="vm-stat-label">{label}</span>
      <span className="vm-stat-value">{value}</span>
    </div>
  );
}

export type VoiceJoinResponse = {
  ok: boolean;
  reason: string;
  guildId: string | null;
  voiceChannelId: string | null;
  textChannelId: string | null;
  requesterUserId: string | null;
};

export function resolveVoiceJoinStatusMessage(result: VoiceJoinResponse): {
  text: string;
  type: "ok" | "error";
} {
  if (result.ok) {
    if (result.reason === "already_in_channel") {
      return {
        type: "ok",
        text: "Already in the target voice channel."
      };
    }
    return {
      type: "ok",
      text: "Voice join completed."
    };
  }

  if (result.reason === "no_guild_available") {
    return {
      type: "error",
      text: "No guild is available for voice join."
    };
  }
  if (result.reason === "guild_not_found") {
    return {
      type: "error",
      text: "The selected guild was not found."
    };
  }
  if (result.reason === "requester_not_in_voice") {
    return {
      type: "error",
      text: "No matching requester is currently in voice."
    };
  }
  if (result.reason === "requester_is_bot") {
    return {
      type: "error",
      text: "Requester must be a non-bot user in voice."
    };
  }
  if (result.reason === "no_voice_members_found") {
    return {
      type: "error",
      text: "No non-bot members are currently in voice."
    };
  }
  if (result.reason === "text_channel_unavailable") {
    return {
      type: "error",
      text: "No writable text channel was found for voice operations."
    };
  }
  if (result.reason === "join_not_handled" || result.reason === "voice_join_unconfirmed") {
    return {
      type: "error",
      text: "Voice join was requested but did not complete."
    };
  }

  return {
    type: "error",
    text: "Voice join failed."
  };
}

export type { SessionLatency, VoiceMembershipEvent };
