import type {
  VoiceTimelineTurn,
  VoiceTranscriptTimelineEntry
} from "./voiceSessionTypes.ts";

export function isVoiceSpeechTimelineEntry(entry: unknown): entry is VoiceTimelineTurn {
  if (!entry || typeof entry !== "object") return false;
  const row = entry as Partial<VoiceTranscriptTimelineEntry>;
  const kind = String(row.kind || "speech").trim().toLowerCase();
  if (kind !== "speech") return false;
  return row.role === "assistant" || row.role === "user";
}
