import {
  BARGE_IN_LEASE_IMMUNITY_ASSERTIVE_MS,
  BARGE_IN_LEASE_IMMUNITY_ATOMIC_MS,
  VOICE_OUTPUT_LEASE_ASSERTIVE_MS,
  VOICE_OUTPUT_LEASE_ATOMIC_MS
} from "./voiceSessionManager.constants.ts";
import type {
  VoiceOutputLease,
  VoiceOutputLeaseMode,
  VoicePendingResponse,
  VoiceSession
} from "./voiceSessionTypes.ts";

function normalizePositiveInteger(value: unknown) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) return null;
  return Math.round(normalized);
}

export function normalizeVoiceOutputLeaseMode(rawMode: unknown): VoiceOutputLeaseMode {
  const normalized = String(rawMode || "").trim().toLowerCase();
  if (normalized === "atomic") return "atomic";
  if (normalized === "assertive") return "assertive";
  return "ambient";
}

export function voiceOutputLeaseModesMatch(leftMode: unknown, rightMode: unknown) {
  return normalizeVoiceOutputLeaseMode(leftMode) === normalizeVoiceOutputLeaseMode(rightMode);
}

function getVoiceOutputLeaseDurationMs(rawMode: unknown) {
  switch (normalizeVoiceOutputLeaseMode(rawMode)) {
    case "atomic":
      return VOICE_OUTPUT_LEASE_ATOMIC_MS;
    case "assertive":
      return VOICE_OUTPUT_LEASE_ASSERTIVE_MS;
    default:
      return 0;
  }
}

export function getBargeInLeaseImmunityMs(rawMode: unknown) {
  switch (normalizeVoiceOutputLeaseMode(rawMode)) {
    case "atomic":
      return BARGE_IN_LEASE_IMMUNITY_ATOMIC_MS;
    case "assertive":
      return BARGE_IN_LEASE_IMMUNITY_ASSERTIVE_MS;
    default:
      return 0;
  }
}

export function createVoiceOutputLease({
  mode,
  requestId = null,
  source = "voice_reply",
  now = Date.now()
}: {
  mode?: unknown;
  requestId?: number | null;
  source?: string | null;
  now?: number;
} = {}): VoiceOutputLease | null {
  const normalizedMode = normalizeVoiceOutputLeaseMode(mode);
  if (normalizedMode === "ambient") return null;
  const durationMs = getVoiceOutputLeaseDurationMs(normalizedMode);
  if (durationMs <= 0) return null;
  return {
    mode: normalizedMode,
    requestId: normalizePositiveInteger(requestId),
    grantedAt: Math.max(0, Math.round(Number(now) || 0)),
    expiresAt: Math.max(0, Math.round(Number(now) || 0)) + durationMs,
    source: String(source || "voice_reply").trim() || "voice_reply"
  };
}

function clearExpiredVoiceOutputLease(
  session: VoiceSession | null | undefined,
  now = Date.now()
) {
  if (!session?.outputLease) return null;
  if (Number(session.outputLease.expiresAt || 0) > Math.max(0, Number(now) || 0)) {
    return session.outputLease;
  }
  session.outputLease = null;
  return null;
}

export function hasActiveVoiceOutputLease({
  session = null,
  pendingResponse = session?.pendingResponse || null,
  requestId = null,
  now = Date.now()
}: {
  session?: VoiceSession | null;
  pendingResponse?: VoicePendingResponse | null;
  requestId?: number | null;
  now?: number;
} = {}) {
  const lease = clearExpiredVoiceOutputLease(session, now);
  if (!lease) return false;
  if (normalizePositiveInteger(requestId) !== null && lease.requestId !== normalizePositiveInteger(requestId)) {
    return false;
  }
  const activePending =
    pendingResponse && typeof pendingResponse === "object"
      ? pendingResponse
      : session?.pendingResponse && typeof session.pendingResponse === "object"
        ? session.pendingResponse
        : null;
  if (
    lease.requestId &&
    activePending &&
    normalizePositiveInteger(activePending.requestId) !== null &&
    lease.requestId !== normalizePositiveInteger(activePending.requestId)
  ) {
    return false;
  }
  if (Math.max(0, Number(activePending?.audioReceivedAt || 0)) > 0) {
    return false;
  }
  return true;
}
