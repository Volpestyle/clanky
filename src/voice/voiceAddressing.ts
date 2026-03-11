import { clamp } from "../utils.ts";
import { hasBotNameCue } from "../bot/directAddressConfidence.ts";
import { getBotNameAliases } from "../settings/agentStack.ts";
import { getPromptBotName } from "../prompts/promptCore.ts";
import {
  normalizeInlineText,
  normalizeVoiceAddressingTargetToken,
  normalizeVoiceText
} from "./voiceSessionHelpers.ts";
import {
  STT_TRANSCRIPT_MAX_CHARS,
  VOICE_DECIDER_HISTORY_MAX_CHARS
} from "./voiceSessionManager.constants.ts";
import type {
  VoiceAddressingAnnotation,
  VoiceAddressingState,
  VoiceTimelineTurn,
  VoiceTranscriptTimelineEntry
} from "./voiceSessionTypes.ts";
import { isVoiceSpeechTimelineEntry } from "./voiceTimeline.ts";

type VoiceTimelineTurnLike = Partial<VoiceTranscriptTimelineEntry> | null | undefined;

type VoiceAddressingSessionLike = {
  ending?: boolean;
  recentVoiceTurns?: VoiceTimelineTurn[] | null;
  transcriptTurns?: VoiceTranscriptTimelineEntry[] | null;
};

type BuildVoiceAddressingStateRow = {
  role: "assistant" | "user";
  userId: string | null;
  speakerName: string;
  talkingTo: string | null;
  directedConfidence: number;
  ageMs: number | null;
};

function isVoiceTimelineTurn(row: VoiceTimelineTurnLike): row is Partial<VoiceTimelineTurn> {
  return isVoiceSpeechTimelineEntry(row);
}

export function normalizeVoiceAddressingAnnotation({
  rawAddressing = null,
  directAddressed = false,
  directedConfidence = Number.NaN,
  source = "",
  reason = null
} = {}): VoiceAddressingAnnotation | null {
  const input = rawAddressing && typeof rawAddressing === "object" ? rawAddressing : null;
  const talkingToToken = normalizeVoiceAddressingTargetToken(input?.talkingTo || "");
  let talkingTo = talkingToToken || null;

  const confidenceRaw = Number(input?.directedConfidence ?? directedConfidence);
  let normalizedDirectedConfidence = Number.isFinite(confidenceRaw)
    ? clamp(confidenceRaw, 0, 1)
    : 0;

  if (directAddressed && !talkingTo) {
    talkingTo = "ME";
  }
  if (directAddressed && talkingTo === "ME") {
    normalizedDirectedConfidence = Math.max(normalizedDirectedConfidence, 0.72);
  }

  if (!talkingTo && normalizedDirectedConfidence <= 0) return null;

  const normalizedSource = String(source || "")
    .replace(/\s+/g, "_")
    .trim()
    .toLowerCase()
    .slice(0, 48);
  const normalizedReason =
    String(reason || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 140) || null;

  return {
    talkingTo,
    directedConfidence: Number(normalizedDirectedConfidence.toFixed(3)),
    source: normalizedSource || null,
    reason: normalizedReason
  };
}

export function hasBotNameCueForTranscript({
  transcript = "",
  settings = null
}: {
  transcript?: string;
  settings?: unknown;
} = {}) {
  const normalizedTranscript = normalizeInlineText(transcript, STT_TRANSCRIPT_MAX_CHARS);
  if (!normalizedTranscript) return false;

  const botName = getPromptBotName(settings);
  const aliases = getBotNameAliases(settings);
  const primaryToken = String(botName || "")
    .replace(/[^a-z0-9\s]+/gi, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .at(0) || "";
  const shortPrimaryToken = primaryToken.length >= 5 ? primaryToken.slice(0, 5) : "";
  const candidateNames = [
    botName,
    ...aliases,
    primaryToken,
    shortPrimaryToken
  ]
    .map((entry) => String(entry || "").trim())
    .filter(Boolean);

  for (const candidate of candidateNames) {
    if (hasBotNameCue({ transcript: normalizedTranscript, botName: candidate })) {
      return true;
    }
  }
  return false;
}

export function mergeVoiceAddressingAnnotation(
  existing: VoiceAddressingAnnotation | null = null,
  incoming: VoiceAddressingAnnotation | null = null
): VoiceAddressingAnnotation | null {
  const current = existing && typeof existing === "object" ? existing : null;
  const next = incoming && typeof incoming === "object" ? incoming : null;
  if (!next) return current;
  if (!current) return next;

  const currentTarget = String(current.talkingTo || "").trim();
  const nextTarget = String(next.talkingTo || "").trim();
  const currentConfidence = Number.isFinite(Number(current.directedConfidence))
    ? clamp(Number(current.directedConfidence), 0, 1)
    : 0;
  const nextConfidence = Number.isFinite(Number(next.directedConfidence))
    ? clamp(Number(next.directedConfidence), 0, 1)
    : 0;
  const nextSource = String(next.source || "").trim().toLowerCase();
  const shouldReplace =
    (nextTarget && !currentTarget) ||
    nextConfidence > currentConfidence + 0.02 ||
    (nextSource === "generation" && nextTarget && nextConfidence >= currentConfidence - 0.05);

  return shouldReplace
    ? {
      ...current,
      ...next
    }
    : current;
}

export function findLatestVoiceTurnIndex(
  rows: VoiceTimelineTurnLike[],
  {
    role = "user",
    userId = null,
    text = null,
    textMaxChars = STT_TRANSCRIPT_MAX_CHARS
  }: {
    role?: string;
    userId?: string | null;
    text?: string | null;
    textMaxChars?: number;
  } = {}
) {
  const source = Array.isArray(rows) ? rows : [];
  if (!source.length) return -1;
  const normalizedRole = role === "assistant" ? "assistant" : "user";
  const normalizedUserId = String(userId || "").trim() || null;
  const normalizedText = text ? normalizeVoiceText(text, textMaxChars) : "";

  for (let index = source.length - 1; index >= 0; index -= 1) {
    const row = source[index];
    if (!isVoiceTimelineTurn(row)) continue;
    const rowRole = row.role === "assistant" ? "assistant" : "user";
    if (rowRole !== normalizedRole) continue;
    if (String(row.userId || "") !== String(normalizedUserId || "")) continue;
    if (normalizedText) {
      const rowText = normalizeVoiceText(row.text || "", textMaxChars);
      if (!rowText || rowText !== normalizedText) continue;
    }
    return index;
  }
  return -1;
}

export function annotateLatestVoiceTurnAddressing({
  session = null,
  role = "user",
  userId = null,
  text = "",
  addressing = null
}: {
  session?: VoiceAddressingSessionLike | null;
  role?: string;
  userId?: string | null;
  text?: string;
  addressing?: VoiceAddressingAnnotation | Record<string, unknown> | null;
} = {}) {
  if (!session || session.ending) return false;
  const normalizedAddressing =
    addressing && typeof addressing === "object"
      ? normalizeVoiceAddressingAnnotation({ rawAddressing: addressing })
      : null;
  if (!normalizedAddressing) return false;

  const modelTurns = Array.isArray(session.recentVoiceTurns) ? session.recentVoiceTurns : [];
  const transcriptTurns = Array.isArray(session.transcriptTurns) ? session.transcriptTurns : [];
  const modelTurnIndex = findLatestVoiceTurnIndex(modelTurns, {
    role,
    userId,
    text,
    textMaxChars: VOICE_DECIDER_HISTORY_MAX_CHARS
  });
  const transcriptTurnIndex = findLatestVoiceTurnIndex(transcriptTurns, {
    role,
    userId,
    text,
    textMaxChars: STT_TRANSCRIPT_MAX_CHARS
  });
  if (modelTurnIndex < 0 && transcriptTurnIndex < 0) return false;

  if (modelTurnIndex >= 0) {
    const current = modelTurns[modelTurnIndex]?.addressing || null;
    modelTurns[modelTurnIndex] = {
      ...modelTurns[modelTurnIndex],
      addressing: mergeVoiceAddressingAnnotation(current, normalizedAddressing)
    };
  }
  if (transcriptTurnIndex >= 0) {
    const current = transcriptTurns[transcriptTurnIndex]?.addressing || null;
    transcriptTurns[transcriptTurnIndex] = {
      ...transcriptTurns[transcriptTurnIndex],
      addressing: mergeVoiceAddressingAnnotation(current, normalizedAddressing)
    };
  }

  return true;
}

export function buildVoiceAddressingState({
  session = null,
  userId = null,
  now = Date.now(),
  maxItems = 6
}: {
  session?: VoiceAddressingSessionLike | null;
  userId?: string | null;
  now?: number;
  maxItems?: number;
} = {}): VoiceAddressingState | null {
  const sourceTurns = Array.isArray(session?.transcriptTurns) ? session.transcriptTurns : [];
  if (!sourceTurns.length) return null;

  const normalizedUserId = String(userId || "").trim();
  const normalizedMaxItems = Math.max(1, Math.min(12, Math.floor(Number(maxItems) || 6)));
  const annotatedRows: BuildVoiceAddressingStateRow[] = sourceTurns
    .filter((row): row is VoiceTimelineTurn => isVoiceSpeechTimelineEntry(row))
    .map((row) => {
      const normalized = normalizeVoiceAddressingAnnotation({
        rawAddressing: row.addressing
      });
      if (!normalized) return null;
      const atRaw = Number(row.at || 0);
      const at = atRaw > 0 ? atRaw : null;
      const ageMs = at ? Math.max(0, now - at) : null;
      return {
        role: row.role === "assistant" ? "assistant" : "user",
        userId: String(row.userId || "").trim() || null,
        speakerName: String(row.speakerName || "").trim() || "someone",
        talkingTo: normalized.talkingTo || null,
        directedConfidence: Number(normalized.directedConfidence || 0),
        ageMs
      };
    })
    .filter((row): row is BuildVoiceAddressingStateRow => row !== null);
  if (!annotatedRows.length) return null;

  const recentAddressingGuesses = annotatedRows
    .slice(-normalizedMaxItems)
    .map((row) => ({
      speakerName: row.speakerName,
      talkingTo: row.talkingTo || null,
      directedConfidence: Number(clamp(Number(row.directedConfidence) || 0, 0, 1).toFixed(3)),
      ageMs: Number.isFinite(row.ageMs) ? Math.round(row.ageMs) : null
    }));

  const currentSpeakerRow = normalizedUserId
    ? [...annotatedRows]
      .reverse()
      .find((row) => row.role === "user" && String(row.userId || "") === normalizedUserId) || null
    : null;
  const lastDirectedToMeRow =
    [...annotatedRows]
      .reverse()
      .find((row) => row.role === "user" && row.talkingTo === "ME" && Number(row.directedConfidence || 0) > 0) ||
    null;

  return {
    currentSpeakerTarget: currentSpeakerRow?.talkingTo || null,
    currentSpeakerDirectedConfidence: Number(
      clamp(Number(currentSpeakerRow?.directedConfidence) || 0, 0, 1).toFixed(3)
    ),
    lastDirectedToMe: lastDirectedToMeRow
      ? {
        speakerName: lastDirectedToMeRow.speakerName,
        directedConfidence: Number(clamp(Number(lastDirectedToMeRow.directedConfidence) || 0, 0, 1).toFixed(3)),
        ageMs: Number.isFinite(lastDirectedToMeRow.ageMs) ? Math.round(lastDirectedToMeRow.ageMs) : null
      }
      : null,
    recentAddressingGuesses
  };
}
