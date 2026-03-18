import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import type {
  VoiceSession,
  VoiceEvent,
  LatencyTurnEntry,
  SessionLatency,
} from "../hooks/useVoiceSSE";
import { deriveBotState, elapsed } from "../utils/voiceHelpers";

// ── Types ──────────────────────────────────────────────────────

type VoiceDebuggerProps = {
  sessions: VoiceSession[];
  events: VoiceEvent[];
  sseStatus: "connecting" | "open" | "closed";
  onBack: () => void;
};

type LaneId =
  | "capture"
  | "asr"
  | "decision"
  | "generate"
  | "output"
  | "bargein"
  | "music"
  | "thought";

type LaneConfig = {
  id: LaneId;
  label: string;
  color: string;
  patterns: RegExp[];
};

type ClassifiedEvent = {
  event: VoiceEvent;
  lane: LaneId;
  ts: number;
};

type Anomaly = {
  id: string;
  type: "warn" | "danger" | "info";
  label: string;
  description: string;
  at: string;
  eventIndex: number | null;
};

/** Persisted flight log stored in localStorage. */
type FlightLog = {
  id: string;
  sessionId: string;
  mode: string;
  startedAt: string;
  endedAt: string;
  eventCount: number;
  participantCount: number;
  durationLabel: string;
  events: VoiceEvent[];
  latency: SessionLatency;
};

const FLIGHT_LOG_STORAGE_KEY = "clanky_flight_logs";
const MAX_FLIGHT_LOGS = 3;

function loadFlightLogs(): FlightLog[] {
  try {
    const raw = localStorage.getItem(FLIGHT_LOG_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as FlightLog[];
    return Array.isArray(parsed) ? parsed.slice(0, MAX_FLIGHT_LOGS) : [];
  } catch {
    return [];
  }
}

function saveFlightLog(log: FlightLog) {
  const existing = loadFlightLogs();
  // Deduplicate by sessionId
  const filtered = existing.filter((l) => l.sessionId !== log.sessionId);
  const updated = [log, ...filtered].slice(0, MAX_FLIGHT_LOGS);
  try {
    localStorage.setItem(FLIGHT_LOG_STORAGE_KEY, JSON.stringify(updated));
  } catch {
    // localStorage full — drop oldest
    try {
      localStorage.setItem(
        FLIGHT_LOG_STORAGE_KEY,
        JSON.stringify(updated.slice(0, 1))
      );
    } catch {
      // give up
    }
  }
}

// ── Lane definitions ────────────────────────────────────────────

const LANES: LaneConfig[] = [
  {
    id: "capture",
    label: "CAPTURE",
    color: "#bef264",
    patterns: [
      /^voice_activity_started$/,
      /^voice_turn_finalized$/,
      /^voice_turn_dropped/,
      /^voice_turn_skipped/,
      /^voice_barge_in_gate$/,
      /^voice_turn_in$/,
    ],
  },
  {
    id: "asr",
    label: "ASR",
    color: "#60a5fa",
    patterns: [/^openai_realtime_asr_/],
  },
  {
    id: "decision",
    label: "DECISION",
    color: "#4ade80",
    patterns: [
      /^voice_runtime_event_decision$/,
      /^voice_turn_addressing$/,
      /^voice_thought_decision$/,
      /^voice_interrupt_/,
    ],
  },
  {
    id: "generate",
    label: "GENERATE",
    color: "#c084fc",
    patterns: [
      /^voice_generation_/,
      /^openai_realtime_instructions_updated$/,
    ],
  },
  {
    id: "output",
    label: "OUTPUT",
    color: "#bef264",
    patterns: [
      /^bot_audio_started$/,
      /^response_/,
      /^openai_realtime_active_response_cleared_stale$/,
      /^openai_realtime_text_turn_forwarded$/,
      /^voice_turn_out$/,
    ],
  },
  {
    id: "bargein",
    label: "BARGE-IN",
    color: "#fbbf24",
    patterns: [/^voice_barge_in_/],
  },
  {
    id: "music",
    label: "MUSIC",
    color: "#f472b6",
    patterns: [/^voice_music_/, /^voice_tool_music_/],
  },
  {
    id: "thought",
    label: "THOUGHT",
    color: "#34d399",
    patterns: [/^voice_thought_/, /^voice_pending_thought_/],
  },
];

// Catch-all patterns checked after lane patterns fail — maps sentinel kinds
// to lanes so session start/end, errors, and soundboard events are captured.
const SENTINEL_KIND_LANE: [RegExp, LaneId][] = [
  [/^voice_session_start$/, "capture"],
  [/^voice_session_end$/, "capture"],
  [/^voice_error$/, "output"],
  [/^voice_soundboard_play$/, "music"],
  [/^voice_latency_stage$/, "output"],
  [/^voice_membership_changed$/, "decision"],
];

const LANE_MAP = new Map(LANES.map((l) => [l.id, l]));

// ── Zoom presets (seconds visible) ─────────────────────────────

const ZOOM_LEVELS = [15, 30, 60, 120, 300] as const;
type ZoomLevel = (typeof ZOOM_LEVELS)[number];

// ── Helpers ─────────────────────────────────────────────────────

function parseTs(iso: string): number {
  return new Date(iso).getTime();
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function fmtTimeMs(ts: number): string {
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${h}:${m}:${s}.${ms}`;
}

function classifyEvent(evt: VoiceEvent): LaneId | null {
  // Voice events have kind like "voice_runtime" / "voice_error" with the
  // specific event type in the `content` field.  Some sentinel kinds
  // (voice_turn_in, voice_turn_out, voice_session_start, etc.) carry meaning
  // in `kind` itself.  Try content first, then fall back to kind.
  const content = typeof evt.content === "string" ? evt.content : "";
  const kind = evt.kind ?? "";
  const candidates = content ? [content, kind] : [kind];

  for (const candidate of candidates) {
    for (const lane of LANES) {
      for (const pat of lane.patterns) {
        if (pat.test(candidate)) return lane.id;
      }
    }
  }
  // Check sentinel kinds (voice_session_start, voice_error, etc.)
  for (const [pat, laneId] of SENTINEL_KIND_LANE) {
    if (pat.test(kind)) return laneId;
    if (content && pat.test(content)) return laneId;
  }
  return null;
}

function shortLabel(evt: VoiceEvent): string {
  const content = typeof evt.content === "string" ? evt.content : "";
  const src = content || evt.kind;
  return src
    .replace(/^voice_/, "")
    .replace(/^openai_realtime_/, "rt:")
    .replace(/^bot_/, "b:")
    .replace(/^response_/, "r:");
}

/** Human-readable one-liner for the event log. */
function eventSummary(evt: VoiceEvent): string {
  const content = typeof evt.content === "string" ? evt.content : "";
  const meta = evt.metadata as Record<string, unknown> | undefined;

  // Pull useful metadata fields for context
  const speaker = meta?.speakerName ?? meta?.displayName ?? meta?.userId;
  const speakerStr = speaker ? ` (${String(speaker).slice(0, 16)})` : "";
  const transcript = meta?.transcript ?? meta?.text ?? meta?.utteranceText;
  const transcriptStr = transcript
    ? `: "${String(transcript).slice(0, 60)}${String(transcript).length > 60 ? "..." : ""}"`
    : "";
  const reason = meta?.reason ?? meta?.denialReason ?? meta?.promotionReason;
  const reasonStr = reason ? ` [${String(reason)}]` : "";

  if (content) {
    return `${content}${speakerStr}${transcriptStr}${reasonStr}`;
  }
  return `${evt.kind}${speakerStr}${transcriptStr}${reasonStr}`;
}

function latencyBarClass(
  ms: number | null,
  avg: number | null
): "good" | "ok" | "bad" {
  if (ms === null) return "good";
  if (avg === null || avg === 0) return "good";
  const ratio = ms / avg;
  if (ratio <= 1.3) return "good";
  if (ratio <= 2.0) return "ok";
  return "bad";
}

function trendBarClass(totalMs: number, avgMs: number): "good" | "ok" | "bad" {
  if (avgMs === 0) return "good";
  const ratio = totalMs / avgMs;
  if (ratio <= 1.3) return "good";
  if (ratio <= 2.0) return "ok";
  return "bad";
}

function safeJsonString(val: unknown): string {
  if (val === null || val === undefined) return "";
  if (typeof val === "string") return val;
  try {
    return JSON.stringify(val, null, 2);
  } catch {
    return String(val);
  }
}

// ── Turn reconstruction ───────────────────────────────────────

type TurnStageStatus = "passed" | "failed" | "skipped" | "pending";

type TurnStage = {
  id: string;
  label: string;
  status: TurnStageStatus;
  detail: string;
  meta: Record<string, unknown>;
  event: ClassifiedEvent | null;
};

type ReconstructedTurn = {
  id: number;
  startTs: number;
  endTs: number;
  speaker: string;
  transcript: string;
  outcome: "responded" | "denied" | "dropped" | "interrupted" | "pending";
  outcomeReason: string;
  stages: TurnStage[];
  events: ClassifiedEvent[];
};

const TURN_WINDOW_MS = 12_000;

function metaStr(evt: VoiceEvent, key: string): string {
  const meta = evt.metadata as Record<string, unknown> | undefined;
  const val = meta?.[key];
  return val !== undefined && val !== null ? String(val) : "";
}

function metaNum(evt: VoiceEvent, key: string): number | null {
  const meta = evt.metadata as Record<string, unknown> | undefined;
  const val = meta?.[key];
  return typeof val === "number" ? val : null;
}

function metaObj(evt: VoiceEvent): Record<string, unknown> {
  const meta = evt.metadata;
  return meta && typeof meta === "object" && !Array.isArray(meta)
    ? (meta as Record<string, unknown>)
    : {};
}

function evtContent(ce: ClassifiedEvent): string {
  return typeof ce.event.content === "string" ? ce.event.content : ce.event.kind;
}

function reconstructTurns(classified: ClassifiedEvent[]): ReconstructedTurn[] {
  const turns: ReconstructedTurn[] = [];

  // Find turn-start anchors: voice_activity_started or voice_turn_in kind
  const anchors: number[] = [];
  for (let i = 0; i < classified.length; i++) {
    const c = evtContent(classified[i]);
    if (
      c === "voice_activity_started" ||
      classified[i].event.kind === "voice_turn_in"
    ) {
      anchors.push(i);
    }
  }

  for (let ai = 0; ai < anchors.length; ai++) {
    const anchorIdx = anchors[ai];
    const anchor = classified[anchorIdx];
    const nextAnchorTs =
      ai + 1 < anchors.length
        ? classified[anchors[ai + 1]].ts
        : anchor.ts + TURN_WINDOW_MS;
    const windowEnd = Math.min(anchor.ts + TURN_WINDOW_MS, nextAnchorTs);

    // Gather all events in this turn's window
    const turnEvents: ClassifiedEvent[] = [];
    for (let j = anchorIdx; j < classified.length; j++) {
      if (classified[j].ts > windowEnd) break;
      turnEvents.push(classified[j]);
    }

    const speaker =
      metaStr(anchor.event, "speakerName") ||
      metaStr(anchor.event, "displayName") ||
      metaStr(anchor.event, "userId") ||
      "unknown";

    // -- Build stages --
    const stages: TurnStage[] = [];

    // 1. CAPTURE
    const promotionReason = metaStr(anchor.event, "promotionReason");
    const captureBytes = metaNum(anchor.event, "promotionBytes");
    const capturePeak = metaNum(anchor.event, "promotionPeak");
    const captureActive = metaNum(anchor.event, "promotionActiveSampleRatio");
    const captureDetail = [
      promotionReason ? `Via: ${promotionReason}` : null,
      captureBytes !== null ? `${captureBytes} bytes` : null,
      capturePeak !== null ? `Peak: ${capturePeak.toFixed(3)}` : null,
      captureActive !== null ? `Active: ${(captureActive * 100).toFixed(0)}%` : null,
    ]
      .filter(Boolean)
      .join("  ");

    stages.push({
      id: "capture",
      label: "Capture promoted",
      status: "passed",
      detail: captureDetail || "Audio captured",
      meta: metaObj(anchor.event),
      event: anchor,
    });

    // 2. ASR — look for final transcript or drop
    const asrFinal = turnEvents.find(
      (e) => evtContent(e) === "openai_realtime_asr_final_segment"
    );
    const turnDropped = turnEvents.find((e) =>
      evtContent(e).startsWith("voice_turn_dropped")
    );
    const turnSkipped = turnEvents.find((e) =>
      evtContent(e).startsWith("voice_turn_skipped")
    );

    let transcript = "";
    if (asrFinal) {
      transcript = metaStr(asrFinal.event, "transcript");
      const conf = metaNum(asrFinal.event, "confidence");
      stages.push({
        id: "asr",
        label: "ASR transcribed",
        status: "passed",
        detail: transcript
          ? `"${transcript.slice(0, 80)}${transcript.length > 80 ? "..." : ""}"${conf !== null ? `  Conf: ${conf.toFixed(2)}` : ""}`
          : "Transcription received",
        meta: metaObj(asrFinal.event),
        event: asrFinal,
      });
    } else if (turnDropped || turnSkipped) {
      const dropEvt = turnDropped ?? turnSkipped!;
      const dropReason =
        metaStr(dropEvt.event, "reason") || evtContent(dropEvt).replace("voice_turn_dropped_", "").replace("voice_turn_skipped_", "");
      stages.push({
        id: "asr",
        label: "ASR / Capture",
        status: "failed",
        detail: `Dropped: ${dropReason}`,
        meta: metaObj(dropEvt.event),
        event: dropEvt,
      });
      // Early exit — no further stages
      stages.push(
        { id: "decision", label: "Admission", status: "skipped", detail: "", meta: {}, event: null },
        { id: "generation", label: "Generation", status: "skipped", detail: "", meta: {}, event: null },
        { id: "output", label: "Output", status: "skipped", detail: "", meta: {}, event: null }
      );
      turns.push({
        id: turns.length,
        startTs: anchor.ts,
        endTs: (turnDropped ?? turnSkipped ?? anchor).ts,
        speaker,
        transcript: "",
        outcome: "dropped",
        outcomeReason: dropReason,
        stages,
        events: turnEvents,
      });
      continue;
    } else {
      stages.push({
        id: "asr",
        label: "ASR",
        status: "pending",
        detail: "No transcript event found in window",
        meta: {},
        event: null,
      });
    }

    // 3. ADDRESSING / ADMISSION
    const addressing = turnEvents.find(
      (e) => evtContent(e) === "voice_turn_addressing"
    );
    const decisionEvt = turnEvents.find(
      (e) =>
        evtContent(e) === "voice_runtime_event_decision" ||
        evtContent(e) === "voice_reply_classifier_debug"
    );
    const bargeInGate = turnEvents.find(
      (e) => evtContent(e) === "voice_barge_in_gate"
    );

    if (addressing || decisionEvt) {
      const evt = decisionEvt ?? addressing!;
      const allow = (metaObj(evt.event).allow as boolean | undefined) ?? null;
      const reason = metaStr(evt.event, "reason");
      const addrTarget = metaStr(evt.event, "talkingTo");
      const addrConf = metaNum(evt.event, "confidence") ?? metaNum(evt.event, "directedConfidence");

      if (allow === false) {
        stages.push({
          id: "decision",
          label: "Admission DENIED",
          status: "failed",
          detail: [
            reason ? `Reason: ${reason}` : null,
            addrTarget ? `Target: ${addrTarget}` : null,
            addrConf !== null ? `Confidence: ${addrConf.toFixed(2)}` : null,
          ]
            .filter(Boolean)
            .join("  "),
          meta: metaObj(evt.event),
          event: evt,
        });
        stages.push(
          { id: "generation", label: "Generation", status: "skipped", detail: "", meta: {}, event: null },
          { id: "output", label: "Output", status: "skipped", detail: "", meta: {}, event: null }
        );
        turns.push({
          id: turns.length,
          startTs: anchor.ts,
          endTs: evt.ts,
          speaker,
          transcript,
          outcome: "denied",
          outcomeReason: reason || "admission denied",
          stages,
          events: turnEvents,
        });
        continue;
      }

      stages.push({
        id: "decision",
        label: "Admission ALLOWED",
        status: "passed",
        detail: [
          reason ? `Reason: ${reason}` : null,
          addrTarget ? `Directed to: ${addrTarget}` : null,
          addrConf !== null ? `Confidence: ${addrConf.toFixed(2)}` : null,
        ]
          .filter(Boolean)
          .join("  "),
        meta: metaObj(evt.event),
        event: evt,
      });
    } else if (bargeInGate) {
      const allow = (metaObj(bargeInGate.event).allow as boolean | undefined) ?? null;
      const reason = metaStr(bargeInGate.event, "reason");
      stages.push({
        id: "decision",
        label: allow ? "Barge-in ALLOWED" : "Barge-in DENIED",
        status: allow ? "passed" : "failed",
        detail: reason ? `Reason: ${reason}` : "",
        meta: metaObj(bargeInGate.event),
        event: bargeInGate,
      });
      if (!allow) {
        stages.push(
          { id: "generation", label: "Generation", status: "skipped", detail: "", meta: {}, event: null },
          { id: "output", label: "Output", status: "skipped", detail: "", meta: {}, event: null }
        );
        turns.push({
          id: turns.length,
          startTs: anchor.ts,
          endTs: bargeInGate.ts,
          speaker,
          transcript,
          outcome: "denied",
          outcomeReason: reason || "barge-in denied",
          stages,
          events: turnEvents,
        });
        continue;
      }
    } else {
      stages.push({
        id: "decision",
        label: "Admission",
        status: "pending",
        detail: "No admission event in window",
        meta: {},
        event: null,
      });
    }

    // 4. GENERATION
    const genPrep = turnEvents.find(
      (e) => evtContent(e) === "voice_generation_prep_stage"
    );
    const genTimeout = turnEvents.find(
      (e) => evtContent(e) === "voice_generation_watchdog_timeout"
    );
    const thoughtDecision = turnEvents.find(
      (e) => evtContent(e) === "voice_thought_decision"
    );
    const instructionsUpdated = turnEvents.find(
      (e) => evtContent(e).includes("instructions_updated")
    );

    if (genTimeout) {
      stages.push({
        id: "generation",
        label: "Generation TIMEOUT",
        status: "failed",
        detail: `Watchdog fired after ${metaNum(genTimeout.event, "timeoutMs") ?? "?"}ms`,
        meta: metaObj(genTimeout.event),
        event: genTimeout,
      });
    } else if (genPrep || instructionsUpdated || thoughtDecision) {
      const evt = genPrep ?? instructionsUpdated ?? thoughtDecision!;
      stages.push({
        id: "generation",
        label: "Generation",
        status: "passed",
        detail: genPrep
          ? `Stage: ${metaStr(genPrep.event, "stage")} (${metaStr(genPrep.event, "state")})`
          : thoughtDecision
            ? `Thought: ${metaStr(thoughtDecision.event, "action")}`
            : "Instructions updated",
        meta: metaObj(evt.event),
        event: evt,
      });
    } else {
      stages.push({
        id: "generation",
        label: "Generation",
        status: "pending",
        detail: "No generation event in window",
        meta: {},
        event: null,
      });
    }

    // 5. OUTPUT
    const audioStarted = turnEvents.find(
      (e) =>
        evtContent(e) === "bot_audio_started" ||
        e.event.kind === "voice_turn_out"
    );
    const silentFallback = turnEvents.find(
      (e) =>
        evtContent(e) === "response_silent_fallback" ||
        evtContent(e) === "response_silent_hard_recovery"
    );
    const bargeIn = turnEvents.find(
      (e) => evtContent(e) === "voice_barge_in_suppression_cleared"
    );

    if (audioStarted) {
      stages.push({
        id: "output",
        label: "Audio playing",
        status: "passed",
        detail: bargeIn ? "Played (interrupted by barge-in)" : "Audio sent to channel",
        meta: metaObj(audioStarted.event),
        event: audioStarted,
      });
    } else if (silentFallback) {
      stages.push({
        id: "output",
        label: "Output SILENT",
        status: "failed",
        detail: `Silent: ${evtContent(silentFallback)}`,
        meta: metaObj(silentFallback.event),
        event: silentFallback,
      });
    } else {
      stages.push({
        id: "output",
        label: "Output",
        status: "pending",
        detail: "No output event in window",
        meta: {},
        event: null,
      });
    }

    // Determine outcome
    const lastFailed = [...stages].reverse().find((s) => s.status === "failed");
    const allPassed = stages.every(
      (s) => s.status === "passed" || s.status === "pending"
    );
    const hasPending = stages.some((s) => s.status === "pending");

    let outcome: ReconstructedTurn["outcome"] = "responded";
    let outcomeReason = "";
    if (lastFailed) {
      outcome = bargeIn ? "interrupted" : "denied";
      outcomeReason = lastFailed.detail;
    } else if (hasPending) {
      outcome = "pending";
      outcomeReason = "Turn still in progress or events missing";
    } else {
      outcomeReason = "Full pipeline completed";
    }

    turns.push({
      id: turns.length,
      startTs: anchor.ts,
      endTs: turnEvents[turnEvents.length - 1].ts,
      speaker,
      transcript,
      outcome,
      outcomeReason,
      stages,
      events: turnEvents,
    });
  }

  return turns;
}

// ── Anomaly detection ──────────────────────────────────────────

function detectAnomalies(
  classified: ClassifiedEvent[],
  latency: SessionLatency
): Anomaly[] {
  const anomalies: Anomaly[] = [];
  let idCounter = 0;

  // 1. Empty ASR after promotion
  for (let i = 0; i < classified.length - 1; i++) {
    const cur = classified[i];
    const next = classified[i + 1];
    if (
      cur.event.kind === "voice_activity_started" &&
      next.event.kind.startsWith("voice_turn_dropped") &&
      next.ts - cur.ts < 5000
    ) {
      anomalies.push({
        id: String(idCounter++),
        type: "warn",
        label: "Empty ASR",
        description: "Voice activity started but turn dropped with no transcript",
        at: cur.event.createdAt,
        eventIndex: i,
      });
    }
  }

  // 2. Output lock stuck (long gap between bot_audio_started events)
  const audioStarts = classified.filter(
    (e) => e.event.kind === "bot_audio_started"
  );
  for (let i = 1; i < audioStarts.length; i++) {
    const gap = audioStarts[i].ts - audioStarts[i - 1].ts;
    if (gap > 30_000) {
      anomalies.push({
        id: String(idCounter++),
        type: "danger",
        label: "Output Gap",
        description: `${Math.round(gap / 1000)}s gap between audio outputs`,
        at: audioStarts[i].event.createdAt,
        eventIndex: null,
      });
    }
  }

  // 3. High latency turns
  if (latency) {
    const avg = latency.averages.totalMs;
    for (const turn of latency.recentTurns) {
      if (
        turn.totalMs !== null &&
        avg !== null &&
        avg > 0 &&
        turn.totalMs > avg * 2
      ) {
        anomalies.push({
          id: String(idCounter++),
          type: "danger",
          label: "High Latency",
          description: `Turn took ${turn.totalMs}ms (avg ${Math.round(avg)}ms)`,
          at: turn.at,
          eventIndex: null,
        });
      }
    }
  }

  return anomalies;
}

// ── Sub-components ─────────────────────────────────────────────

function StatusBar({
  session,
  sseStatus,
  sessions,
  selectedIdx,
  onSelectSession,
  onBack,
}: {
  session: VoiceSession | null;
  sseStatus: "connecting" | "open" | "closed";
  sessions: VoiceSession[];
  selectedIdx: number;
  onSelectSession: (i: number) => void;
  onBack: () => void;
}) {
  const botState = session ? deriveBotState(session) : null;
  const sseClass =
    sseStatus === "open"
      ? "vd-health-ok"
      : sseStatus === "connecting"
        ? "vd-health-warn"
        : "vd-health-err";

  const asrHealthy = session?.asrSessions?.some((a) => a.connected) ?? false;
  const rtConnected = session?.realtime?.state
    ? (session.realtime.state as { connected?: boolean }).connected !== false
    : false;

  return (
    <div className="vd-status">
      <button className="vd-back-btn" onClick={onBack} type="button">
        ← BACK
      </button>

      <div className="vd-status-sep" />

      <div className="vd-status-item">
        <div className={`vd-health-dot ${sseClass}`} />
        <span className="vd-status-label">SSE</span>
        <span className="vd-status-value">{sseStatus}</span>
      </div>

      {sessions.length > 1 && (
        <>
          <div className="vd-status-sep" />
          <div className="vd-session-selector">
            {sessions.map((s, i) => (
              <button
                key={s.sessionId}
                type="button"
                className={`vd-session-pill${i === selectedIdx ? " vd-session-pill-active" : ""}`}
                onClick={() => onSelectSession(i)}
              >
                {s.sessionId.slice(0, 6)}
              </button>
            ))}
          </div>
        </>
      )}

      {session && (
        <>
          <div className="vd-status-sep" />

          <div className="vd-status-item">
            <span className="vd-status-label">ID</span>
            <span className="vd-status-value">
              {session.sessionId.slice(0, 8)}
            </span>
          </div>

          <div className="vd-status-item">
            <span className="vd-status-label">MODE</span>
            <span className="vd-status-value">{session.mode}</span>
          </div>

          {session.realtime && (
            <div className="vd-status-item">
              <span className="vd-status-label">PROVIDER</span>
              <span className="vd-status-value">
                {session.realtime.provider}
              </span>
            </div>
          )}

          <div className="vd-status-item">
            <span className="vd-status-label">UP</span>
            <span className="vd-status-value">
              {elapsed(session.startedAt)}
            </span>
          </div>

          <div className="vd-status-item">
            <span className="vd-status-label">USERS</span>
            <span className="vd-status-value">
              {session.participantCount}
            </span>
          </div>

          <div className="vd-status-sep" />

          {botState && (
            <span className={`vd-state-badge vd-state-${botState}`}>
              {botState.toUpperCase()}
            </span>
          )}

          <div className="vd-status-item">
            <div
              className={`vd-health-dot ${asrHealthy ? "vd-health-ok" : "vd-health-err"}`}
            />
            <span className="vd-status-label">ASR</span>
          </div>

          <div className="vd-status-item">
            <div
              className={`vd-health-dot ${rtConnected ? "vd-health-ok" : "vd-health-err"}`}
            />
            <span className="vd-status-label">RT</span>
          </div>
        </>
      )}
    </div>
  );
}

function TimeAxis({
  windowStartMs,
  windowEndMs,
  trackWidth,
}: {
  windowStartMs: number;
  windowEndMs: number;
  trackWidth: number;
}) {
  const durationMs = windowEndMs - windowStartMs;
  if (durationMs <= 0 || trackWidth <= 0) return <div className="vd-time-axis" />;

  const intervalMs = durationMs <= 30_000 ? 5_000 : durationMs <= 120_000 ? 10_000 : 30_000;
  const ticks: { left: number; label: string }[] = [];
  const firstTick =
    Math.ceil(windowStartMs / intervalMs) * intervalMs;

  for (let t = firstTick; t <= windowEndMs; t += intervalMs) {
    const left = ((t - windowStartMs) / durationMs) * trackWidth;
    ticks.push({ left, label: fmtTime(t) });
  }

  return (
    <div className="vd-time-axis">
      {ticks.map((tick) => (
        <div
          key={tick.left}
          className="vd-time-tick"
          style={{ left: tick.left }}
        >
          <span className="vd-time-tick-label">{tick.label}</span>
        </div>
      ))}
    </div>
  );
}

function LaneTrack({
  events,
  lane,
  expanded,
  windowStartMs,
  windowEndMs,
  trackWidth,
  selectedEventIdx,
  onSelectEvent,
}: {
  events: ClassifiedEvent[];
  lane: LaneConfig;
  expanded: boolean;
  windowStartMs: number;
  windowEndMs: number;
  trackWidth: number;
  selectedEventIdx: number | null;
  onSelectEvent: (idx: number) => void;
}) {
  const durationMs = windowEndMs - windowStartMs;
  if (durationMs <= 0 || trackWidth <= 0) return <div className="vd-lane-track" />;

  const visible = events.filter(
    (e) => e.ts >= windowStartMs && e.ts <= windowEndMs
  );

  return (
    <div
      className={`vd-lane-track ${expanded ? "" : "vd-lane-track-collapsed"}`}
    >
      {visible.map((ce, i) => {
        const leftPx = ((ce.ts - windowStartMs) / durationMs) * trackWidth;
        const globalIdx = events.indexOf(ce);
        const isSelected = selectedEventIdx === globalIdx;

        return (
          <div
            key={`${ce.event.kind}-${ce.ts}-${i}`}
            className={`vd-event-marker ${isSelected ? "vd-marker-selected" : ""}`}
            style={{ left: leftPx, color: lane.color }}
            onClick={(e) => {
              e.stopPropagation();
              onSelectEvent(globalIdx);
            }}
          >
            <div
              className="vd-marker-dot"
              style={{ background: lane.color }}
            />
            {/* Tooltip shown on hover only — no persistent labels */}
            <div className="vd-marker-tooltip">
              <span className="vd-marker-tooltip-time">{fmtTimeMs(ce.ts)}</span>
              <span className="vd-marker-tooltip-label">{shortLabel(ce.event)}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function PipelineWaterfall({
  turn,
  averages,
}: {
  turn: LatencyTurnEntry;
  averages: SessionLatency extends null ? never : NonNullable<SessionLatency>["averages"];
}) {
  const stages: {
    label: string;
    ms: number | null;
    avgMs: number | null;
  }[] = [
    {
      label: "Capture",
      ms: turn.finalizedToAsrStartMs,
      avgMs: averages.finalizedToAsrStartMs,
    },
    {
      label: "ASR",
      ms: turn.asrToGenerationStartMs,
      avgMs: averages.asrToGenerationStartMs,
    },
    {
      label: "Generate",
      ms: turn.generationToReplyRequestMs,
      avgMs: averages.generationToReplyRequestMs,
    },
    {
      label: "Reply Req",
      ms: turn.replyRequestToAudioStartMs,
      avgMs: averages.replyRequestToAudioStartMs,
    },
  ];

  const maxMs = Math.max(
    ...stages.map((s) => s.ms ?? 0),
    ...stages.map((s) => s.avgMs ?? 0),
    1
  );

  return (
    <div className="vd-waterfall">
      <div className="vd-waterfall-title">PIPELINE WATERFALL</div>
      {stages.map((s) => {
        const barClass = latencyBarClass(s.ms, s.avgMs);
        const widthPct = s.ms !== null ? Math.max(2, (s.ms / maxMs) * 100) : 0;
        return (
          <div key={s.label} className="vd-wf-row">
            <span className="vd-wf-label">{s.label}</span>
            <div className="vd-wf-bar-track">
              <div
                className={`vd-wf-bar vd-wf-bar-${barClass}`}
                style={{ width: `${widthPct}%` }}
              />
            </div>
            <span className="vd-wf-ms">
              {s.ms !== null ? `${s.ms}ms` : "--"}
            </span>
          </div>
        );
      })}
      {turn.totalMs !== null && (
        <div className="vd-wf-row">
          <span className="vd-wf-label" style={{ fontWeight: 700 }}>
            TOTAL
          </span>
          <div className="vd-wf-bar-track">
            <div
              className={`vd-wf-bar vd-wf-bar-${latencyBarClass(turn.totalMs, averages.totalMs)}`}
              style={{
                width: `${Math.max(2, (turn.totalMs / maxMs) * 100)}%`,
              }}
            />
          </div>
          <span className="vd-wf-ms" style={{ fontWeight: 700 }}>
            {turn.totalMs}ms
          </span>
        </div>
      )}
    </div>
  );
}

function EventDetail({ event }: { event: VoiceEvent }) {
  const { kind, createdAt, content, guildId, channelId, metadata, ...rest } =
    event;

  const extraKeys = Object.keys(rest).filter(
    (k) => rest[k] !== undefined && rest[k] !== null
  );

  return (
    <div className="vd-evt-section">
      <div className="vd-evt-section-title">EVENT DETAIL</div>
      <div className="vd-evt-kv">
        <span className="vd-evt-key">KIND</span>
        <span className="vd-evt-val">{kind}</span>
        <span className="vd-evt-key">TIME</span>
        <span className="vd-evt-val">{fmtTimeMs(parseTs(createdAt))}</span>
        {guildId && (
          <>
            <span className="vd-evt-key">GUILD</span>
            <span className="vd-evt-val">{guildId}</span>
          </>
        )}
        {channelId && (
          <>
            <span className="vd-evt-key">CHANNEL</span>
            <span className="vd-evt-val">{channelId}</span>
          </>
        )}
        {extraKeys.map((k) => (
          <span key={k}>
            <span className="vd-evt-key">{k}</span>
            <span className="vd-evt-val">{safeJsonString(rest[k])}</span>
          </span>
        ))}
      </div>
      {content && (
        <>
          <div className="vd-evt-section-title" style={{ marginTop: 8 }}>
            CONTENT
          </div>
          <div className="vd-evt-content-block">{content}</div>
        </>
      )}
      {metadata !== undefined && metadata !== null && (
        <>
          <div className="vd-evt-section-title" style={{ marginTop: 8 }}>
            METADATA
          </div>
          <pre className="vd-evt-meta-pre">{safeJsonString(metadata)}</pre>
        </>
      )}
    </div>
  );
}

// ── Turn Drilldown ────────────────────────────────────────────

const STAGE_ICONS: Record<TurnStageStatus, string> = {
  passed: "\u2705",   // green check
  failed: "\u274C",   // red X
  skipped: "\u2591",  // light shade block
  pending: "\u23F3",  // hourglass
};

const OUTCOME_COLORS: Record<ReconstructedTurn["outcome"], string> = {
  responded: "var(--success)",
  denied: "var(--danger)",
  dropped: "var(--warning)",
  interrupted: "var(--warning)",
  pending: "var(--ink-3)",
};

function TurnDrilldown({
  turn,
  latencyTurn,
  onSelectEvent,
}: {
  turn: ReconstructedTurn;
  latencyTurn: LatencyTurnEntry | null;
  onSelectEvent: (ce: ClassifiedEvent) => void;
}) {
  return (
    <div className="vd-drilldown">
      {/* Header */}
      <div className="vd-dd-header">
        <span className="vd-dd-speaker">{turn.speaker}</span>
        <span className="vd-dd-time">{fmtTimeMs(turn.startTs)}</span>
        <span
          className="vd-dd-outcome"
          style={{ color: OUTCOME_COLORS[turn.outcome] }}
        >
          {turn.outcome.toUpperCase()}
        </span>
      </div>

      {/* Transcript */}
      {turn.transcript && (
        <div className="vd-dd-transcript">
          &ldquo;{turn.transcript}&rdquo;
        </div>
      )}

      {/* Pipeline trace */}
      <div className="vd-dd-stages">
        <div className="vd-dd-stages-title">PIPELINE TRACE</div>
        {turn.stages.map((stage, i) => {
          const isStopPoint =
            stage.status === "failed" &&
            turn.stages.slice(i + 1).every((s) => s.status === "skipped");

          return (
            <div
              key={stage.id}
              className={`vd-dd-stage vd-dd-stage-${stage.status} ${isStopPoint ? "vd-dd-stage-stop" : ""}`}
              onClick={() => {
                if (stage.event) onSelectEvent(stage.event);
              }}
              style={{ cursor: stage.event ? "pointer" : "default" }}
            >
              <div className="vd-dd-stage-row">
                <span className="vd-dd-stage-icon">
                  {STAGE_ICONS[stage.status]}
                </span>
                <span className="vd-dd-stage-num">{i + 1}.</span>
                <span className="vd-dd-stage-label">{stage.label}</span>
                {isStopPoint && (
                  <span className="vd-dd-stop-badge">STOP POINT</span>
                )}
              </div>
              {stage.detail && stage.status !== "skipped" && (
                <div className="vd-dd-stage-detail">{stage.detail}</div>
              )}
            </div>
          );
        })}
      </div>

      {/* Latency breakdown */}
      {latencyTurn && latencyTurn.totalMs !== null && (
        <div className="vd-dd-latency">
          <div className="vd-dd-latency-title">LATENCY BREAKDOWN</div>
          <div className="vd-dd-latency-grid">
            {[
              { label: "Capture", ms: latencyTurn.finalizedToAsrStartMs, color: STAGE_COLORS.capture },
              { label: "ASR", ms: latencyTurn.asrToGenerationStartMs, color: STAGE_COLORS.asr },
              { label: "Generate", ms: latencyTurn.generationToReplyRequestMs, color: STAGE_COLORS.generate },
              { label: "Reply", ms: latencyTurn.replyRequestToAudioStartMs, color: STAGE_COLORS.reply },
            ].map((s) => (
              <div key={s.label} className="vd-dd-lat-row">
                <span className="vd-dd-lat-dot" style={{ background: s.color }} />
                <span className="vd-dd-lat-label">{s.label}</span>
                <span className="vd-dd-lat-ms">{s.ms !== null ? `${s.ms}ms` : "--"}</span>
              </div>
            ))}
            <div className="vd-dd-lat-row vd-dd-lat-total">
              <span className="vd-dd-lat-dot" style={{ background: "var(--ink-1)" }} />
              <span className="vd-dd-lat-label">TOTAL</span>
              <span className="vd-dd-lat-ms">{latencyTurn.totalMs}ms</span>
            </div>
          </div>
          {latencyTurn.queueWaitMs !== null && latencyTurn.queueWaitMs > 0 && (
            <div className="vd-dd-lat-queue">
              Queue wait: {latencyTurn.queueWaitMs}ms (depth: {latencyTurn.pendingQueueDepth ?? "?"})
            </div>
          )}
        </div>
      )}

      {/* Verdict */}
      <div className="vd-dd-verdict">
        <span className="vd-dd-verdict-label">VERDICT</span>
        <span className="vd-dd-verdict-text">{turn.outcomeReason}</span>
      </div>

      {/* Related events count */}
      <div className="vd-dd-meta">
        {turn.events.length} events in turn window ({Math.round((turn.endTs - turn.startTs) / 1000)}s)
      </div>
    </div>
  );
}

function TurnList({
  turns,
  selectedTurnId,
  onSelectTurn,
}: {
  turns: ReconstructedTurn[];
  selectedTurnId: number | null;
  onSelectTurn: (id: number) => void;
}) {
  return (
    <div className="vd-turn-list">
      {turns.length === 0 ? (
        <div className="vd-turn-list-empty">
          No turns reconstructed from events
        </div>
      ) : (
        [...turns].reverse().map((turn) => (
          <div
            key={turn.id}
            className={`vd-turn-row ${selectedTurnId === turn.id ? "vd-turn-row-selected" : ""}`}
            onClick={() => onSelectTurn(turn.id)}
          >
            <span className="vd-turn-time">{fmtTimeMs(turn.startTs)}</span>
            <span
              className="vd-turn-outcome-dot"
              style={{ background: OUTCOME_COLORS[turn.outcome] }}
            />
            <span className="vd-turn-speaker">{turn.speaker}</span>
            <span className="vd-turn-transcript">
              {turn.transcript
                ? `"${turn.transcript.slice(0, 50)}${turn.transcript.length > 50 ? "..." : ""}"`
                : turn.outcomeReason.slice(0, 40)}
            </span>
            <span
              className="vd-turn-outcome-badge"
              style={{ color: OUTCOME_COLORS[turn.outcome] }}
            >
              {turn.outcome}
            </span>
          </div>
        ))
      )}
    </div>
  );
}

const STAGE_COLORS: Record<string, string> = {
  capture: "#bef264",
  asr: "#60a5fa",
  generate: "#c084fc",
  reply: "#34d399",
};

function LatencyTrend({
  latency,
  onSelectTurnAt,
}: {
  latency: SessionLatency;
  onSelectTurnAt: (at: string) => void;
}) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  if (!latency || latency.recentTurns.length === 0) {
    return (
      <div className="vd-latency-trend">
        <span className="vd-trend-label">LATENCY</span>
        <span style={{ fontSize: "0.68rem", color: "var(--ink-3)" }}>
          No turn data
        </span>
      </div>
    );
  }

  const turns = latency.recentTurns.slice(-12);
  const avg = latency.averages.totalMs ?? 0;
  const maxMs = Math.max(...turns.map((t) => t.totalMs ?? 0), 1);
  const hovered = hoveredIdx !== null ? turns[hoveredIdx] : null;

  return (
    <div className="vd-latency-trend">
      <span className="vd-trend-label">LATENCY</span>

      {/* Stacked bars */}
      <div className="vd-trend-bars">
        {turns.map((turn, i) => {
          const total = turn.totalMs ?? 0;
          const heightPct = Math.max(4, (total / maxMs) * 100);
          const cap = turn.finalizedToAsrStartMs ?? 0;
          const asr = turn.asrToGenerationStartMs ?? 0;
          const gen = turn.generationToReplyRequestMs ?? 0;
          const reply = turn.replyRequestToAudioStartMs ?? 0;
          const sum = cap + asr + gen + reply || 1;

          return (
            <div
              key={`${turn.at}-${i}`}
              className={`vd-trend-bar-wrap ${hoveredIdx === i ? "vd-trend-bar-hovered" : ""}`}
              onMouseEnter={() => setHoveredIdx(i)}
              onMouseLeave={() => setHoveredIdx(null)}
              onClick={() => onSelectTurnAt(turn.at)}
              style={{ cursor: "pointer" }}
            >
              <div className="vd-trend-stack" style={{ height: `${heightPct}%` }}>
                <div
                  className="vd-trend-seg"
                  style={{ flex: cap / sum, background: STAGE_COLORS.capture }}
                />
                <div
                  className="vd-trend-seg"
                  style={{ flex: asr / sum, background: STAGE_COLORS.asr }}
                />
                <div
                  className="vd-trend-seg"
                  style={{ flex: gen / sum, background: STAGE_COLORS.generate }}
                />
                <div
                  className="vd-trend-seg"
                  style={{ flex: reply / sum, background: STAGE_COLORS.reply }}
                />
              </div>
              <span className="vd-trend-ms">
                {total > 0 ? `${total}` : "--"}
              </span>
            </div>
          );
        })}
      </div>

      {/* Summary stats */}
      <div className="vd-trend-summary">
        {hovered ? (
          <>
            <span className="vd-trend-stat">
              <span className="vd-trend-stat-dot" style={{ background: STAGE_COLORS.capture }} />
              CAP {hovered.finalizedToAsrStartMs ?? "--"}ms
            </span>
            <span className="vd-trend-stat">
              <span className="vd-trend-stat-dot" style={{ background: STAGE_COLORS.asr }} />
              ASR {hovered.asrToGenerationStartMs ?? "--"}ms
            </span>
            <span className="vd-trend-stat">
              <span className="vd-trend-stat-dot" style={{ background: STAGE_COLORS.generate }} />
              GEN {hovered.generationToReplyRequestMs ?? "--"}ms
            </span>
            <span className="vd-trend-stat">
              <span className="vd-trend-stat-dot" style={{ background: STAGE_COLORS.reply }} />
              REPLY {hovered.replyRequestToAudioStartMs ?? "--"}ms
            </span>
            <span className="vd-trend-stat" style={{ fontWeight: 700 }}>
              TOTAL {hovered.totalMs ?? "--"}ms
            </span>
          </>
        ) : (
          <>
            <span className="vd-trend-stat">
              AVG {avg > 0 ? `${Math.round(avg)}ms` : "--"}
            </span>
            <span className="vd-trend-stat">
              BEST {Math.min(...turns.map((t) => t.totalMs ?? Infinity))}ms
            </span>
            <span className="vd-trend-stat">
              WORST {Math.max(...turns.map((t) => t.totalMs ?? 0))}ms
            </span>
            <span className="vd-trend-stat">
              {turns.length} turns
            </span>
          </>
        )}
      </div>
    </div>
  );
}

function FlightLogPicker({
  onSelect,
  onClose,
  activeLogId,
}: {
  onSelect: (log: FlightLog) => void;
  onClose: () => void;
  activeLogId: string | null;
}) {
  const logs = useMemo(() => loadFlightLogs(), []);

  return (
    <div className="vd-log-picker-dropdown">
      <div className="vd-log-picker-header">
        <span>SAVED RECORDINGS</span>
        <button type="button" className="vd-log-picker-close" onClick={onClose}>
          x
        </button>
      </div>
      {logs.length === 0 ? (
        <div className="vd-log-picker-empty">
          No saved recordings yet. Sessions are automatically saved when they end.
        </div>
      ) : (
        logs.map((log) => (
          <div
            key={log.id}
            className={`vd-log-picker-row ${activeLogId === log.id ? "vd-log-picker-row-active" : ""}`}
            onClick={() => onSelect(log)}
          >
            <div className="vd-log-picker-row-top">
              <span className="vd-log-picker-sid">{log.sessionId.slice(0, 8)}</span>
              <span className="vd-log-picker-mode">{log.mode}</span>
              <span className="vd-log-picker-dur">{log.durationLabel}</span>
            </div>
            <div className="vd-log-picker-row-bot">
              <span>{log.eventCount} events</span>
              <span>{log.participantCount} users</span>
              <span>{new Date(log.startedAt).toLocaleString()}</span>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

// ── Main Component ──────────────────────────────────────────────

export default function VoiceDebugger({
  sessions,
  events,
  sseStatus,
  onBack,
}: VoiceDebuggerProps) {
  // -- state --
  const [selectedSessionIdx, setSelectedSessionIdx] = useState(0);
  const [collapsedLanes, setCollapsedLanes] = useState<Set<LaneId>>(
    () => new Set()
  );
  const [following, setFollowing] = useState(true);
  const [zoom, setZoom] = useState<ZoomLevel>(60);
  const [selectedEventGlobalIdx, setSelectedEventGlobalIdx] = useState<
    number | null
  >(null);
  const [playheadMs, setPlayheadMs] = useState<number | null>(null);
  const [logLaneFilter, setLogLaneFilter] = useState<LaneId | "all">("all");
  const [loadedFlightLog, setLoadedFlightLog] = useState<FlightLog | null>(null);
  const [showLogPicker, setShowLogPicker] = useState(false);
  const [bottomMode, setBottomMode] = useState<"events" | "turns">("events");
  const [selectedTurnId, setSelectedTurnId] = useState<number | null>(null);

  // -- refs --
  const trackRef = useRef<HTMLDivElement>(null);
  const logFeedRef = useRef<HTMLDivElement>(null);
  const lanesRef = useRef<HTMLDivElement>(null);
  const [trackWidth, setTrackWidth] = useState(600);
  const hadSessionRef = useRef(false);
  const savedSessionIdRef = useRef<string | null>(null);

  // -- drag-to-pan state (refs to avoid re-renders during drag) --
  const dragRef = useRef<{
    active: boolean;
    startX: number;
    startPlayheadMs: number;
  } | null>(null);

  // -- derived session --
  const session: VoiceSession | null =
    sessions[selectedSessionIdx] ?? sessions[0] ?? null;

  // Track whether we ever had a session so we can detect when it ends
  const sessionEnded = hadSessionRef.current && !session;
  if (session) hadSessionRef.current = true;

  // -- event source: live SSE events or loaded flight log --
  const effectiveEvents = loadedFlightLog ? loadedFlightLog.events : events;
  const effectiveLatency = loadedFlightLog
    ? loadedFlightLog.latency
    : session?.latency ?? null;

  // -- classify events into lanes --
  const classified = useMemo<ClassifiedEvent[]>(() => {
    const sessionGuild = loadedFlightLog ? null : session?.guildId;
    return effectiveEvents
      .filter((e) => !sessionGuild || !e.guildId || e.guildId === sessionGuild)
      .map((e) => {
        const lane = classifyEvent(e);
        if (!lane) return null;
        return { event: e, lane, ts: parseTs(e.createdAt) };
      })
      .filter((x): x is ClassifiedEvent => x !== null)
      .sort((a, b) => a.ts - b.ts);
  }, [effectiveEvents, session?.guildId, loadedFlightLog]);

  // -- events per lane --
  const eventsByLane = useMemo(() => {
    const map = new Map<LaneId, ClassifiedEvent[]>();
    for (const lane of LANES) {
      map.set(lane.id, []);
    }
    for (const ce of classified) {
      map.get(ce.lane)!.push(ce);
    }
    return map;
  }, [classified]);

  // -- time window --
  const windowDurationMs = zoom * 1000;
  const windowEndMs = following
    ? Date.now()
    : (playheadMs ?? (classified.length > 0 ? classified[classified.length - 1].ts + 2000 : Date.now()));
  const windowStartMs = windowEndMs - windowDurationMs;

  // -- reconstruct turns --
  const turns = useMemo(() => reconstructTurns(classified), [classified]);
  const selectedTurn = selectedTurnId !== null
    ? turns.find((t) => t.id === selectedTurnId) ?? null
    : null;

  // -- anomalies --
  const anomalies = useMemo(
    () => detectAnomalies(classified, effectiveLatency),
    [classified, effectiveLatency]
  );

  // -- find closest latency turn to selected event --
  const selectedEvent =
    selectedEventGlobalIdx !== null
      ? classified[selectedEventGlobalIdx] ?? null
      : null;

  const closestTurn = useMemo<LatencyTurnEntry | null>(() => {
    if (!selectedEvent || !effectiveLatency) return null;
    const targetTs = selectedEvent.ts;
    let best: LatencyTurnEntry | null = null;
    let bestDist = Infinity;
    for (const turn of effectiveLatency.recentTurns) {
      const dist = Math.abs(parseTs(turn.at) - targetTs);
      if (dist < bestDist) {
        bestDist = dist;
        best = turn;
      }
    }
    return bestDist < 10_000 ? best : null;
  }, [selectedEvent, effectiveLatency]);

  // -- measure track width --
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const obs = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setTrackWidth(entry.contentRect.width);
      }
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // -- auto-pause when session ends — freeze at last event --
  useEffect(() => {
    if (sessionEnded && following) {
      const lastEvent = classified[classified.length - 1];
      setFollowing(false);
      setPlayheadMs(lastEvent ? lastEvent.ts : Date.now());
    }
  }, [sessionEnded, following, classified]);

  // -- auto-save flight log when session ends --
  useEffect(() => {
    if (!sessionEnded || loadedFlightLog) return;
    if (classified.length === 0) return;
    // Only save once per session
    const firstEvent = classified[0];
    const lastEvent = classified[classified.length - 1];
    const sessionId = (firstEvent.event.metadata as Record<string, unknown> | undefined)?.sessionId;
    const sid = typeof sessionId === "string" ? sessionId : `rec-${firstEvent.ts}`;
    if (savedSessionIdRef.current === sid) return;
    savedSessionIdRef.current = sid;

    const durationMs = lastEvent.ts - firstEvent.ts;
    const durationSec = Math.round(durationMs / 1000);
    const durationLabel = durationSec >= 60
      ? `${Math.floor(durationSec / 60)}m ${durationSec % 60}s`
      : `${durationSec}s`;

    saveFlightLog({
      id: sid,
      sessionId: sid,
      mode: session?.mode ?? "unknown",
      startedAt: firstEvent.event.createdAt,
      endedAt: lastEvent.event.createdAt,
      eventCount: classified.length,
      participantCount: session?.participantCount ?? 0,
      durationLabel,
      events: classified.map((ce) => ce.event),
      latency: effectiveLatency,
    });
  }, [sessionEnded, classified, loadedFlightLog, session?.mode, session?.participantCount, effectiveLatency]);

  // -- auto-scroll event log --
  useEffect(() => {
    if (following && logFeedRef.current) {
      logFeedRef.current.scrollTop = 0;
    }
  }, [events.length, following]);

  // -- drag-to-pan handlers --
  const handleDragStart = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      // Only start drag on background clicks (not on event markers)
      if ((e.target as HTMLElement).closest(".vd-event-marker")) return;
      const currentEnd = following
        ? Date.now()
        : (playheadMs ?? Date.now());
      dragRef.current = {
        active: true,
        startX: e.clientX,
        startPlayheadMs: currentEnd,
      };
      // Pause following on drag start
      if (following) {
        setFollowing(false);
        setPlayheadMs(currentEnd);
      }
    },
    [following, playheadMs]
  );

  const handleDragMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag?.active) return;
      const dx = e.clientX - drag.startX;
      // Convert px delta to time delta: negative dx = move earlier in time
      const pxPerMs = trackWidth / windowDurationMs;
      const deltaMs = dx / pxPerMs;
      setPlayheadMs(drag.startPlayheadMs - deltaMs);
    },
    [trackWidth, windowDurationMs]
  );

  const handleDragEnd = useCallback(() => {
    if (dragRef.current) {
      dragRef.current = null;
    }
  }, []);

  // -- lane toggle --
  const toggleLane = useCallback((id: LaneId) => {
    setCollapsedLanes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  // -- zoom --
  const zoomIn = useCallback(() => {
    setZoom((prev) => {
      const idx = ZOOM_LEVELS.indexOf(prev);
      return idx > 0 ? ZOOM_LEVELS[idx - 1] : prev;
    });
  }, []);

  const zoomOut = useCallback(() => {
    setZoom((prev) => {
      const idx = ZOOM_LEVELS.indexOf(prev);
      return idx < ZOOM_LEVELS.length - 1 ? ZOOM_LEVELS[idx + 1] : prev;
    });
  }, []);

  // -- snap to live --
  const snapToLive = useCallback(() => {
    setFollowing(true);
    setPlayheadMs(null);
    setSelectedEventGlobalIdx(null);
  }, []);

  // -- load a saved flight log --
  const loadLog = useCallback((log: FlightLog) => {
    setLoadedFlightLog(log);
    setFollowing(false);
    setSelectedEventGlobalIdx(null);
    // Set playhead to the end of the recording
    setPlayheadMs(parseTs(log.endedAt) + 2000);
    setShowLogPicker(false);
    hadSessionRef.current = false;
    savedSessionIdRef.current = null;
  }, []);

  // -- unload flight log and return to live --
  const unloadLog = useCallback(() => {
    setLoadedFlightLog(null);
    setFollowing(true);
    setPlayheadMs(null);
    setSelectedEventGlobalIdx(null);
    hadSessionRef.current = false;
    savedSessionIdRef.current = null;
  }, []);

  // -- filtered log events --
  const logEvents = useMemo(() => {
    if (logLaneFilter === "all") return classified;
    return classified.filter((ce) => ce.lane === logLaneFilter);
  }, [classified, logLaneFilter]);

  // ── Render ────────────────────────────────────────────────────

  return (
    <div className="vd">
      {/* STATUS BAR */}
      <StatusBar
        session={session}
        sseStatus={sseStatus}
        sessions={sessions}
        selectedIdx={selectedSessionIdx}
        onSelectSession={setSelectedSessionIdx}
        onBack={onBack}
      />

      {!session && classified.length === 0 ? (
        <div className="vd-no-session">
          <span>No active voice session</span>
          <span className="vd-no-session-sub">
            Waiting for session data from SSE stream
          </span>
        </div>
      ) : (
        <>
          {/* LANE TIMELINE */}
          <div className="vd-timeline">
            {/* Toolbar */}
            <div className="vd-timeline-toolbar">
              <span className="vd-toolbar-label">TIMELINE</span>

              {loadedFlightLog && (
                <span className="vd-toolbar-loaded-tag">
                  RECORDING: {loadedFlightLog.sessionId.slice(0, 8)} ({loadedFlightLog.durationLabel}, {loadedFlightLog.eventCount} events)
                  <button
                    type="button"
                    className="vd-toolbar-unload"
                    onClick={unloadLog}
                    title="Return to live"
                  >
                    x
                  </button>
                </span>
              )}

              {!loadedFlightLog && sessionEnded && (
                <span className="vd-toolbar-ended">SESSION ENDED</span>
              )}

              <span className="vd-toolbar-spacer" />

              {/* Flight log picker */}
              <div className="vd-log-picker-wrap">
                <button
                  type="button"
                  className="vd-toolbar-btn"
                  onClick={() => setShowLogPicker((v) => !v)}
                >
                  RECORDINGS
                </button>
                {showLogPicker && (
                  <FlightLogPicker
                    onSelect={loadLog}
                    onClose={() => setShowLogPicker(false)}
                    activeLogId={loadedFlightLog?.id ?? null}
                  />
                )}
              </div>

              {!loadedFlightLog && !following && (
                <button
                  type="button"
                  className="vd-snap-live-btn"
                  onClick={snapToLive}
                >
                  SNAP TO LIVE
                </button>
              )}

              {!loadedFlightLog && (
                <button
                  type="button"
                  className={`vd-toolbar-btn ${following ? "vd-toolbar-btn-active" : ""}`}
                  onClick={() => {
                    if (!following) {
                      snapToLive();
                    } else {
                      setFollowing(false);
                      setPlayheadMs(Date.now());
                    }
                  }}
                >
                  {following ? "LIVE" : "PAUSED"}
                </button>
              )}

              <div className="vd-zoom-controls">
                <button
                  type="button"
                  className="vd-zoom-btn"
                  onClick={zoomIn}
                  title="Zoom in"
                >
                  +
                </button>
                <span className="vd-zoom-label">{zoom}s</span>
                <button
                  type="button"
                  className="vd-zoom-btn"
                  onClick={zoomOut}
                  title="Zoom out"
                >
                  -
                </button>
              </div>
            </div>

            {/* Time axis */}
            <TimeAxis
              windowStartMs={windowStartMs}
              windowEndMs={windowEndMs}
              trackWidth={trackWidth}
            />

            {/* Lanes — drag to pan */}
            <div
              className="vd-lanes"
              ref={lanesRef}
              onMouseDown={handleDragStart}
              onMouseMove={handleDragMove}
              onMouseUp={handleDragEnd}
              onMouseLeave={handleDragEnd}
            >
              {LANES.map((lane) => {
                const laneEvents = eventsByLane.get(lane.id) ?? [];
                const isExpanded = !collapsedLanes.has(lane.id);

                return (
                  <div
                    key={lane.id}
                    className={`vd-lane ${isExpanded ? "vd-lane-expanded" : ""}`}
                  >
                    <div className="vd-lane-row">
                      <div
                        className="vd-lane-header"
                        onClick={() => toggleLane(lane.id)}
                      >
                        <div
                          className="vd-lane-color-bar"
                          style={{ background: lane.color }}
                        />
                        <span className="vd-lane-name">{lane.label}</span>
                        <span className="vd-lane-count">
                          {laneEvents.length}
                        </span>
                        <span
                          className={`vd-lane-expand ${isExpanded ? "vd-lane-expand-open" : ""}`}
                        >
                          &#x25B8;
                        </span>
                      </div>

                      <div
                        ref={lane.id === "capture" ? trackRef : undefined}
                        style={{ flex: 1, position: "relative", overflow: "hidden" }}
                      >
                        <LaneTrack
                          events={laneEvents}
                          lane={lane}
                          expanded={isExpanded}
                          windowStartMs={windowStartMs}
                          windowEndMs={windowEndMs}
                          trackWidth={trackWidth}
                          selectedEventIdx={
                            selectedEvent && selectedEvent.lane === lane.id
                              ? (eventsByLane.get(lane.id) ?? []).indexOf(
                                  selectedEvent
                                )
                              : null
                          }
                          onSelectEvent={(laneLocalIdx) => {
                            const ce = (eventsByLane.get(lane.id) ?? [])[
                              laneLocalIdx
                            ];
                            if (ce) {
                              const globalIdx = classified.indexOf(ce);
                              setSelectedEventGlobalIdx(globalIdx);
                              setPlayheadMs(ce.ts);
                            }
                          }}
                        />

                        {/* Playhead */}
                        {playheadMs !== null &&
                          playheadMs >= windowStartMs &&
                          playheadMs <= windowEndMs && (
                            <div
                              className="vd-playhead"
                              style={{
                                left: `${((playheadMs - windowStartMs) / windowDurationMs) * 100}%`,
                              }}
                            />
                          )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* TURN DETAIL PANEL */}
          <div className="vd-detail">
            <div className="vd-detail-header">
              <span className="vd-detail-title">
                {selectedTurn ? "TURN DRILLDOWN" : "DETAIL"}
              </span>
              {!selectedTurn && selectedEvent && (
                <span
                  className="vd-detail-lane-tag"
                  style={{ color: LANE_MAP.get(selectedEvent.lane)?.color }}
                >
                  {LANE_MAP.get(selectedEvent.lane)?.label}
                </span>
              )}
              {selectedTurn && (
                <button
                  type="button"
                  className="vd-detail-close-btn"
                  onClick={() => setSelectedTurnId(null)}
                >
                  x
                </button>
              )}
            </div>

            {selectedTurn ? (
              <div className="vd-detail-body">
                <TurnDrilldown
                  turn={selectedTurn}
                  latencyTurn={(() => {
                    if (!effectiveLatency) return null;
                    let best: LatencyTurnEntry | null = null;
                    let bestDist = Infinity;
                    for (const lt of effectiveLatency.recentTurns) {
                      const dist = Math.abs(parseTs(lt.at) - selectedTurn.startTs);
                      if (dist < bestDist) { bestDist = dist; best = lt; }
                    }
                    return bestDist < 15_000 ? best : null;
                  })()}
                  onSelectEvent={(ce) => {
                    const idx = classified.indexOf(ce);
                    if (idx >= 0) {
                      setSelectedTurnId(null);
                      setSelectedEventGlobalIdx(idx);
                      setPlayheadMs(ce.ts);
                      setFollowing(false);
                    }
                  }}
                />
              </div>
            ) : selectedEvent ? (
              <div className="vd-detail-body">
                {/* Summary line */}
                <div className="vd-detail-summary">
                  {eventSummary(selectedEvent.event)}
                </div>

                {/* Pipeline waterfall (when a matching latency turn exists) */}
                {closestTurn && effectiveLatency && (
                  <PipelineWaterfall
                    turn={closestTurn}
                    averages={effectiveLatency.averages}
                  />
                )}

                {/* Raw event detail */}
                <EventDetail event={selectedEvent.event} />
              </div>
            ) : (
              <div className="vd-detail-empty">
                Click an event or turn to inspect
              </div>
            )}
          </div>

          {/* ANOMALY SIDEBAR */}
          <div className="vd-anomalies">
            <div className="vd-anomalies-header">
              <div className="vd-anomalies-title">
                ANOMALIES ({anomalies.length})
              </div>
            </div>
            <div className="vd-anomalies-body">
              {anomalies.length === 0 ? (
                <div className="vd-anomaly-empty">No anomalies detected</div>
              ) : (
                anomalies.map((a) => (
                  <div
                    key={a.id}
                    className={`vd-anomaly-card vd-anomaly-card-${a.type}`}
                    onClick={() => {
                      if (a.eventIndex !== null) {
                        setSelectedEventGlobalIdx(a.eventIndex);
                        const ce = classified[a.eventIndex];
                        if (ce) {
                          setPlayheadMs(ce.ts);
                          setFollowing(false);
                        }
                      } else {
                        setPlayheadMs(parseTs(a.at));
                        setFollowing(false);
                      }
                    }}
                  >
                    <span className={`vd-anomaly-type vd-anomaly-type-${a.type}`}>
                      {a.label}
                    </span>
                    <span className="vd-anomaly-desc">{a.description}</span>
                    <span className="vd-anomaly-time">
                      {fmtTimeMs(parseTs(a.at))}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* BOTTOM PANEL: EVENT LOG / TURNS */}
          <div className="vd-event-log">
            <div className="vd-log-toolbar">
              {/* Mode toggle */}
              <button
                type="button"
                className={`vd-log-mode-btn ${bottomMode === "events" ? "vd-log-mode-active" : ""}`}
                onClick={() => setBottomMode("events")}
              >
                EVENTS
                <span className="vd-log-mode-count">{classified.length}</span>
              </button>
              <button
                type="button"
                className={`vd-log-mode-btn ${bottomMode === "turns" ? "vd-log-mode-active" : ""}`}
                onClick={() => setBottomMode("turns")}
              >
                TURNS
                <span className="vd-log-mode-count">{turns.length}</span>
              </button>

              {bottomMode === "events" && (
                <>
                  <div className="vd-status-sep" style={{ height: 14 }} />
                  <button
                    type="button"
                    className={`vd-log-filter-chip ${logLaneFilter === "all" ? "vd-log-filter-active" : "vd-log-filter-inactive"}`}
                    style={{ color: logLaneFilter === "all" ? "var(--ink-1)" : undefined }}
                    onClick={() => setLogLaneFilter("all")}
                  >
                    ALL
                  </button>
                  {LANES.map((lane) => (
                    <button
                      key={lane.id}
                      type="button"
                      className={`vd-log-filter-chip ${logLaneFilter === lane.id ? "vd-log-filter-active" : "vd-log-filter-inactive"}`}
                      style={{
                        color:
                          logLaneFilter === lane.id ? lane.color : undefined,
                        borderColor:
                          logLaneFilter === lane.id ? lane.color : undefined,
                      }}
                      onClick={() => setLogLaneFilter(lane.id)}
                    >
                      <span
                        className="vd-log-chip-dot"
                        style={{ background: lane.color }}
                      />
                      {lane.label}
                    </button>
                  ))}
                </>
              )}
            </div>

            {bottomMode === "events" ? (
              <div className="vd-log-feed" ref={logFeedRef}>
                {[...logEvents].reverse().map((ce, i) => {
                  const laneConfig = LANE_MAP.get(ce.lane);
                  const globalIdx = classified.indexOf(ce);
                  const isSelected = globalIdx === selectedEventGlobalIdx;

                  return (
                    <div
                      key={`${ce.event.kind}-${ce.ts}-${i}`}
                      className={`vd-log-row ${isSelected ? "vd-log-row-selected" : ""}`}
                      onClick={() => {
                        setSelectedTurnId(null);
                        setSelectedEventGlobalIdx(globalIdx);
                        setPlayheadMs(ce.ts);
                        setFollowing(false);
                      }}
                    >
                      <span className="vd-log-time">{fmtTimeMs(ce.ts)}</span>
                      <span
                        className="vd-log-dot"
                        style={{ background: laneConfig?.color ?? "var(--ink-3)" }}
                      />
                      <span className="vd-log-content">
                        {eventSummary(ce.event)}
                      </span>
                      <span className="vd-log-lane-badge" style={{ color: laneConfig?.color }}>
                        {laneConfig?.label ?? ce.lane}
                      </span>
                    </div>
                  );
                })}
                {logEvents.length === 0 && (
                  <div
                    style={{
                      padding: "16px",
                      textAlign: "center",
                      color: "var(--ink-3)",
                      fontSize: "0.72rem",
                    }}
                  >
                    No events in this lane
                  </div>
                )}
              </div>
            ) : (
              <TurnList
                turns={turns}
                selectedTurnId={selectedTurnId}
                onSelectTurn={(id) => {
                  setSelectedTurnId(id);
                  setSelectedEventGlobalIdx(null);
                  const turn = turns.find((t) => t.id === id);
                  if (turn) {
                    setPlayheadMs(turn.startTs);
                    setFollowing(false);
                  }
                }}
              />
            )}
          </div>

          {/* LATENCY TREND */}
          <LatencyTrend
            latency={effectiveLatency}
            onSelectTurnAt={(at) => {
              const ts = parseTs(at);
              setPlayheadMs(ts);
              setFollowing(false);
              // Find the closest turn to this latency entry
              const closest = turns.reduce<ReconstructedTurn | null>((best, t) => {
                const dist = Math.abs(t.startTs - ts);
                const bestDist = best ? Math.abs(best.startTs - ts) : Infinity;
                return dist < bestDist ? t : best;
              }, null);
              if (closest && Math.abs(closest.startTs - ts) < 15_000) {
                setSelectedTurnId(closest.id);
                setSelectedEventGlobalIdx(null);
                setBottomMode("turns");
              }
            }}
          />
        </>
      )}
    </div>
  );
}
