import { useState, useEffect, useMemo, useRef, lazy, Suspense, type ReactNode } from "react";
import { api } from "../api";
import {
  useVoiceSSE,
  type PromptLogBundle,
  type PromptSnapshot,
  type VoiceSession,
  type VoiceEvent,
  type RealtimeState,
  type VoiceMembershipEvent,
  type SessionLatency,
  type LatencyTurnEntry
} from "../hooks/useVoiceSSE";

const VoiceDebugger = lazy(() => import("./VoiceDebugger"));
import { useVoiceHistory } from "../hooks/useVoiceHistory";
import { useDashboardGuildScope } from "../guildScope";
import { CopyButton, Section } from "./ui";
import {
  deriveBotState,
  elapsed,
  normalizeFollowupPrompts,
  normalizePromptText
} from "../utils/voiceHelpers";

// ---- helpers ----

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

function timeUntil(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "expired";
  const s = Math.ceil(ms / 1000);
  const m = Math.floor(s / 60);
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

const MODE_LABELS: Record<string, string> = {
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

const STATE_LABELS: Record<string, string> = {
  speaking: "Speaking",
  processing: "Processing",
  listening: "Listening",
  idle: "Idle",
  disconnected: "Disconnected"
};

const WAKE_WINDOW_FALLBACK_MS = 35_000;

function parseIsoMs(iso?: string | null): number | null {
  const normalized = String(iso || "").trim();
  if (!normalized) return null;
  const parsed = new Date(normalized).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}


function formatApproxBytes(bytes: number | null | undefined): string {
  const normalized = Math.max(0, Number(bytes) || 0);
  if (normalized < 1024) return `${normalized} B`;
  if (normalized < 1024 * 1024) return `${(normalized / 1024).toFixed(1)} KB`;
  return `${(normalized / (1024 * 1024)).toFixed(2)} MB`;
}

function resolveWakeIndicator(session: VoiceSession): {
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
  const msSinceAssistantReply = lastAssistantReplyAtMs != null ? Math.max(0, now - lastAssistantReplyAtMs) : null;
  const msSinceDirectAddress = lastDirectAddressAtMs != null ? Math.max(0, now - lastDirectAddressAtMs) : null;
  const active =
    Boolean(session.focusedSpeaker) ||
    (msSinceAssistantReply != null && msSinceAssistantReply <= WAKE_WINDOW_FALLBACK_MS) ||
    (msSinceDirectAddress != null && msSinceDirectAddress <= WAKE_WINDOW_FALLBACK_MS);
  return {
    active,
    stateLabel: active ? "Active" : "Ambient"
  };
}

function snippet(text?: string, max = 120): string {
  if (!text) return "";
  return text.length > max ? text.slice(0, max) + "..." : text;
}

function getPromptBundle(snapshot: PromptSnapshot): Exclude<PromptLogBundle, null> | null {
  if (!snapshot || typeof snapshot !== "object") return null;
  const bundle = snapshot.replyPrompts;
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) return null;
  return bundle;
}

function hasPromptSnapshot(snapshot: PromptSnapshot): boolean {
  const bundle = getPromptBundle(snapshot);
  if (!bundle) return false;
  if (normalizePromptText(bundle.systemPrompt)) return true;
  if (normalizePromptText(bundle.initialUserPrompt)) return true;
  return normalizeFollowupPrompts(bundle.followupUserPrompts).length > 0;
}

function formatPromptBundleForCopy(bundle: Exclude<PromptLogBundle, null> | null): string {
  if (!bundle) return "";
  const parts = [
    `System Prompt:\n${normalizePromptText(bundle.systemPrompt) || "(empty)"}`,
    `Initial User Prompt:\n${normalizePromptText(bundle.initialUserPrompt) || "(empty)"}`
  ];
  const followups = normalizeFollowupPrompts(bundle.followupUserPrompts);
  if (followups.length > 0) {
    parts.push(
      `Follow-up User Prompts (${followups.length}):\n${followups.map((prompt, index) => `Step ${index + 1}:\n${prompt || "(empty)"}`).join("\n\n")}`
    );
  }
  return parts.join("\n\n");
}

function resolveCaptureTargetName(capture: { userId: string; displayName: string | null }): string {
  const displayName = String(capture?.displayName || "").trim();
  if (displayName) return displayName;
  const userId = String(capture?.userId || "").trim();
  return userId ? userId.slice(0, 8) : "unknown";
}

function isFinalHistoryTranscriptEventType(eventType: unknown, source: unknown): boolean {
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

type VoiceJoinResponse = {
  ok: boolean;
  reason: string;
  guildId: string | null;
  voiceChannelId: string | null;
  textChannelId: string | null;
  requesterUserId: string | null;
};

function resolveVoiceJoinStatusMessage(result: VoiceJoinResponse): {
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

// ---- Stat Pill ----

function Stat({ label, value, warn }: { label: string; value: ReactNode; warn?: boolean }) {
  return (
    <div className={`vm-stat ${warn ? "vm-stat-warn" : ""}`}>
      <span className="vm-stat-label">{label}</span>
      <span className="vm-stat-value">{value}</span>
    </div>
  );
}

// ---- Pipeline Badge ----

function PipelineBadge({ session }: { session: VoiceSession }) {
  const rt = session.realtime;
  const context = session.conversation?.modelContext;
  const generationContext = context?.generation;
  const trackedTurns = Number(context?.trackedTurns || 0);
  const sentTurns = Number(generationContext?.sentTurns || 0);
  const hasContextCoverage = trackedTurns > 0;

  if (rt) {
    const state = rt.state as RealtimeState | null;
    const connected = state?.connected !== false;
    return (
      <div className="vm-pipeline-row">
        <span className={`vm-pipe-dot ${connected ? "vm-pipe-ok" : "vm-pipe-err"}`} />
        <span className="vm-pipe-label">{rt.provider}</span>
        <span className="vm-pipe-detail">
          {rt.inputSampleRateHz / 1000}kHz in / {rt.outputSampleRateHz / 1000}kHz out
        </span>
        {hasContextCoverage && (
          <span className="vm-pipe-detail">
            ctx {sentTurns}/{trackedTurns}
          </span>
        )}
        {rt.drainActive && <span className="vm-pipe-tag vm-pipe-draining">draining</span>}
        {state?.activeResponseId && (
          <span className="vm-pipe-tag vm-pipe-responding">responding</span>
        )}
      </div>
    );
  }

  return null;
}

// ---- Latency Panel ----

const LATENCY_STAGES = [
  { key: "finalizedToAsrStartMs" as const, label: "ASR Wait", color: "#60a5fa" },
  { key: "asrToGenerationStartMs" as const, label: "LLM Think", color: "#fbbf24" },
  { key: "generationToReplyRequestMs" as const, label: "Reply Prep", color: "#c084fc" },
  { key: "replyRequestToAudioStartMs" as const, label: "TTS", color: "#4ade80" }
];

function LatencyPanel({ latency }: { latency: SessionLatency }) {
  if (!latency || latency.recentTurns.length === 0) return null;

  const { averages, turnCount } = latency;

  return (
    <Section title="Pipeline Latency" badge={`${turnCount} turn${turnCount !== 1 ? "s" : ""}`} defaultOpen={false}>
      <div className="vm-detail-grid">
        {LATENCY_STAGES.map((s) => {
          const val = averages[s.key];
          return val != null ? (
            <Stat key={s.key} label={`Avg ${s.label}`} value={`${val}ms`} />
          ) : null;
        })}
        <Stat
          label="Avg Total"
          value={averages.totalMs != null ? `${averages.totalMs}ms` : "–"}
          warn={averages.totalMs != null && averages.totalMs > 2000}
        />
      </div>
      <div className="vm-latency-legend">
        {LATENCY_STAGES.map((s) => (
          <span key={s.key} className="vm-latency-legend-item">
            <span className="vm-latency-swatch" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
    </Section>
  );
}

function InlineLatencyBar({ entry }: { entry: LatencyTurnEntry }) {
  const total = Number(entry.totalMs) || 0;
  return (
    <div className="vm-latency-inline">
      <div className="vm-latency-bar-track">
        {LATENCY_STAGES.map((s) => {
          const val = Number(entry[s.key]) || 0;
          if (val <= 0) return null;
          const pct = (val / Math.max(total, 1)) * 100;
          return (
            <div
              key={s.key}
              className="vm-latency-segment"
              style={{ width: `${pct}%`, background: s.color }}
              title={`${s.label}: ${val}ms`}
            />
          );
        })}
      </div>
      <div className="vm-latency-inline-labels">
        {LATENCY_STAGES.map((s) => {
          const val = Number(entry[s.key]) || 0;
          if (val <= 0) return null;
          return (
            <span key={s.key} className="vm-latency-inline-label" style={{ color: s.color }}>
              {s.label} {val}ms
            </span>
          );
        })}
        <span className={`vm-latency-inline-total ${total > 2000 ? "vm-latency-total-warn" : ""}`}>
          = {total}ms
        </span>
      </div>
    </div>
  );
}

function matchLatencyToTurns(
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
      if (diff < bestDiff && diff < 30_000) {
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

// ---- Per-User ASR Sessions ----

function AsrSessionsPanel({ session }: { session: VoiceSession }) {
  const asrSessions = session.asrSessions;
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  if (!asrSessions || asrSessions.length === 0) return null;

  return (
    <Section
      title="Per-User ASR"
      badge={`${asrSessions.filter((a) => a.connected).length}/${asrSessions.length}`}
      defaultOpen
    >
      <div className="vm-asr-grid">
        {asrSessions.map((asr) => {
          const name = asr.displayName || asr.userId.slice(0, 8);
          const idlePct = asr.idleMs != null && asr.idleTtlMs > 0
            ? Math.min(1, asr.idleMs / asr.idleTtlMs)
            : 0;
          const idleLabel = asr.idleMs != null ? `${(asr.idleMs / 1000).toFixed(1)}s` : null;
          const statusClass = asr.closing
            ? "vm-asr-closing"
            : asr.connected
              ? "vm-asr-connected"
              : "vm-asr-disconnected";

          return (
            <div key={asr.userId} className={`vm-asr-card ${statusClass}`}>
              <div className="vm-asr-header">
                <span className={`vm-asr-dot ${statusClass}`} />
                <span className="vm-asr-name" title={asr.userId}>{name}</span>
                {asr.model && <span className="vm-asr-model">{asr.model}</span>}
              </div>
              {asr.utterance && asr.utterance.partialText && (
                <div className="vm-asr-partial" title={asr.utterance.partialText}>
                  {snippet(asr.utterance.partialText, 80)}
                </div>
              )}
              <div className="vm-asr-stats">
                {asr.connectedAt && (
                  <span className="vm-asr-stat">up {elapsed(asr.connectedAt)}</span>
                )}
                {asr.lastTranscriptAt && (
                  <span className="vm-asr-stat">last {relativeTime(asr.lastTranscriptAt)}</span>
                )}
                {asr.pendingAudioChunks > 0 && (
                  <span className="vm-asr-stat vm-asr-stat-warn">
                    buf {asr.pendingAudioChunks} ({formatApproxBytes(asr.pendingAudioBytes)})
                  </span>
                )}
                {asr.utterance && asr.utterance.finalSegments > 0 && (
                  <span className="vm-asr-stat">{asr.utterance.finalSegments} seg</span>
                )}
              </div>
              {asr.hasIdleTimer && idleLabel && (
                <div className="vm-asr-idle-bar-wrap">
                  <div
                    className="vm-asr-idle-bar"
                    style={{ width: `${Math.round(idlePct * 100)}%` }}
                  />
                  <span className="vm-asr-idle-label">idle {idleLabel} / {(asr.idleTtlMs / 1000).toFixed(0)}s</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Section>
  );
}

// ---- Realtime Connection Detail ----

function RealtimeDetail({ session }: { session: VoiceSession }) {
  const rt = session.realtime;
  const [showDebug, setShowDebug] = useState(false);
  if (!rt) return null;
  const state = rt.state as RealtimeState | null;
  if (!state) return null;

  return (
    <Section title="Realtime Connection" badge={state.connected ? "connected" : "disconnected"} defaultOpen={false}>
      <div className="vm-detail-grid">
        <Stat
          label="Superseded"
          value={Number(rt.replySuperseded || 0)}
          warn={Number(rt.replySuperseded || 0) > 0}
        />
        {state.lastError && <Stat label="Last Error" value={state.lastError} warn />}
        {state.lastCloseCode != null && (
          <Stat label="Close Code" value={`${state.lastCloseCode} ${state.lastCloseReason || ""}`} warn />
        )}
      </div>
      <button className="vm-debug-toggle" onClick={() => setShowDebug(!showDebug)}>
        {showDebug ? "− hide debug" : "+ show debug"}
      </button>
      {showDebug && (
        <>
          <div className="vm-detail-grid">
            {state.sessionId && <Stat label="Session" value={state.sessionId.slice(0, 12) + "..."} />}
            {state.connectedAt && <Stat label="Connected" value={relativeTime(state.connectedAt)} />}
            {state.lastEventAt && <Stat label="Last Event" value={relativeTime(state.lastEventAt)} />}
            {state.lastOutboundEventType && (
              <Stat label="Last Sent" value={state.lastOutboundEventType} />
            )}
            {state.lastOutboundEventAt && (
              <Stat label="Sent At" value={relativeTime(state.lastOutboundEventAt)} />
            )}
            {state.activeResponseId && (
              <Stat label="Active Response" value={state.activeResponseId.slice(0, 12) + "..."} />
            )}
            {state.activeResponseStatus && (
              <Stat label="Response Status" value={state.activeResponseStatus} />
            )}
          </div>
          {state.recentOutboundEvents && state.recentOutboundEvents.length > 0 && (
            <div className="vm-outbound-events">
              <span className="vm-mini-label">Recent outbound</span>
              {state.recentOutboundEvents.map((evt, i) => (
                <div key={i} className="vm-outbound-row">
                  <span className="vm-outbound-type">{evt.type}</span>
                  <span className="vm-outbound-time">{relativeTime(evt.at)}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </Section>
  );
}

// ---- Participants ----

function ParticipantList({ session }: { session: VoiceSession }) {
  const ps = session.participants || [];
  if (ps.length === 0) return null;

  return (
    <Section title="Participants" badge={session.participantCount} defaultOpen>
      <div className="vm-participant-list">
        {ps.map((p) => (
          <div
            key={p.userId}
            className={`vm-participant ${
              session.focusedSpeaker?.userId === p.userId ? "vm-participant-focused" : ""
            }`}
          >
            <span className="vm-participant-name">{p.displayName}</span>
            {session.focusedSpeaker?.userId === p.userId && (
              <span className="vm-participant-tag">focused</span>
            )}
            <span className="vm-participant-id">{p.userId.slice(0, 6)}</span>
          </div>
        ))}
      </div>
    </Section>
  );
}

// ---- Membership Changes ----

function MembershipChanges({ session }: { session: VoiceSession }) {
  const allEvents = Array.isArray(session.membershipEvents) ? session.membershipEvents : [];
  const events = allEvents.slice(-8).reverse();
  if (events.length === 0) return null;

  return (
    <Section title="Membership Changes" badge={allEvents.length} defaultOpen={false}>
      <div className="vm-membership-list">
        {events.map((entry: VoiceMembershipEvent, index) => {
          const eventType = String(entry.eventType || "").toLowerCase() === "join" ? "join" : "leave";
          return (
            <div key={`${entry.userId}-${entry.at}-${index}`} className="vm-membership-row">
              <span
                className={`vm-membership-type ${
                  eventType === "join" ? "vm-membership-join" : "vm-membership-leave"
                }`}
              >
                {eventType}
              </span>
              <span className="vm-membership-name">
                {entry.displayName || entry.userId.slice(0, 8)}
              </span>
              <span className="vm-membership-time">{relativeTime(entry.at)}</span>
            </div>
          );
        })}
      </div>
    </Section>
  );
}

// ---- Conversation Context ----

function ConversationContext({ session, latencyTurns }: { session: VoiceSession; latencyTurns: LatencyTurnEntry[] }) {
  const turns = useMemo(
    () => (Array.isArray(session.recentTurns) ? session.recentTurns : []),
    [session.recentTurns]
  );
  const modelContext = session.conversation?.modelContext || null;
  const generation = modelContext?.generation || null;
  const decider = modelContext?.decider || null;
  const trackedTurns = Number(modelContext?.trackedTurns || 0);
  const trackedTurnLimit = Number(modelContext?.trackedTurnLimit || 0);
  const trackedTranscriptTurns = Number(modelContext?.trackedTranscriptTurns || turns.length);
  const generationAvailableTurns = Number(generation?.availableTurns || trackedTurns);
  const generationSentTurns = Number(generation?.sentTurns || 0);
  const deciderAvailableTurns = Number(decider?.availableTurns || trackedTurns);
  const deciderMaxTurns = Number(decider?.maxTurns || 0);
  const deciderSentTurns = Math.min(deciderAvailableTurns, deciderMaxTurns || deciderAvailableTurns);
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 5000);
    return () => clearInterval(id);
  }, []);

  const [expandedLatency, setExpandedLatency] = useState<Set<number>>(new Set());
  const latencyMap = useMemo(() => matchLatencyToTurns(turns, latencyTurns), [turns, latencyTurns]);

  if (turns.length === 0) return null;

  const toggleLatency = (idx: number) => {
    setExpandedLatency((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  return (
    <Section title="Conversation" badge={turns.length}>
      <div className="vm-convo-context-summary">
        <div className="vm-convo-context-row">
          <span>gen {generationSentTurns}/{generationAvailableTurns || 0} | dec {deciderSentTurns}/{deciderAvailableTurns || 0}</span>
          <span>
            tracked {trackedTurns}{trackedTurnLimit > 0 ? `/${trackedTurnLimit}` : ""} / transcript {trackedTranscriptTurns}
          </span>
        </div>
      </div>
      <div className="vm-convo-feed">
        {turns.map((t, i) => {
          const latencyEntry = latencyMap.get(i) || null;
          const showBar = expandedLatency.has(i);
          return (
            <div key={i} className={`vm-convo-msg vm-convo-${t.role}`}>
              <div className="vm-convo-meta">
                <span className={`vm-convo-role vm-convo-role-${t.role}`}>
                  {t.role === "assistant" ? "bot" : t.speakerName || t.role}
                </span>
                {t.at && <span className="vm-convo-time">{relativeTime(t.at)}</span>}
                {latencyEntry && (
                  <button className="vm-latency-toggle" onClick={() => toggleLatency(i)}>
                    {showBar ? "hide latency" : `${Number(latencyEntry.totalMs) || 0}ms`}
                  </button>
                )}
              </div>
              <div className="vm-convo-text">{t.text || "(empty)"}</div>
              {showBar && latencyEntry && <InlineLatencyBar entry={latencyEntry} />}
            </div>
          );
        })}
      </div>
    </Section>
  );
}

// ---- Live Prompt Snapshot ----

function PromptSnapshotCard({
  title,
  snapshot
}: {
  title: string;
  snapshot: PromptSnapshot;
}) {
  const bundle = getPromptBundle(snapshot);
  const systemPrompt = normalizePromptText(bundle?.systemPrompt);
  const initialUserPrompt = normalizePromptText(bundle?.initialUserPrompt);
  const followups = normalizeFollowupPrompts(bundle?.followupUserPrompts);
  const followupSteps = Math.max(0, Math.floor(Number(bundle?.followupSteps) || followups.length));
  const tools = Array.isArray(bundle?.tools) ? bundle.tools.filter((t) => t.name) : [];
  const [selectedTool, setSelectedTool] = useState<string | null>(null);
  const activeTool = tools.find((t) => t.name === selectedTool) || null;
  const hasData = hasPromptSnapshot(snapshot);

  const meta = snapshot?.source
    ? `${snapshot.source}${snapshot.updatedAt ? ` · ${relativeTime(snapshot.updatedAt)}` : ""}`
    : undefined;

  return (
    <Section title={title} badge={meta} defaultOpen={hasData} disabled={!hasData}>
      <div className="vm-prompt-card">
        <div className="vm-prompt-card-header">
          <CopyButton text={formatPromptBundleForCopy(bundle)} label />
        </div>

        <div className="vm-prompt-body">
          <div className="vm-prompt-block">
            <div className="vm-prompt-block-header">
              <span className="vm-mini-label">System Prompt</span>
              <CopyButton text={systemPrompt || "(empty)"} />
            </div>
            <pre className="vm-prompt-pre">{systemPrompt || "(empty)"}</pre>
          </div>

          {(initialUserPrompt || followups.length > 0) && (
            <div className="vm-prompt-block">
              <div className="vm-prompt-block-header">
                <span className="vm-mini-label">Initial User Prompt</span>
                <CopyButton text={initialUserPrompt || "(empty)"} />
              </div>
              <pre className="vm-prompt-pre">{initialUserPrompt || "(empty)"}</pre>
            </div>
          )}

          {followups.length > 0 && (
            <div className="vm-prompt-block">
              <span className="vm-mini-label">Follow-up User Prompts ({Math.max(followupSteps, followups.length)})</span>
              <div className="vm-prompt-followups">
                {followups.map((prompt, index) => (
                  <div key={`${title}-followup-${index}`} className="vm-prompt-followup">
                    <div className="vm-prompt-block-header">
                      <span className="vm-prompt-step">Step {index + 1}</span>
                      <CopyButton text={prompt || "(empty)"} />
                    </div>
                    <pre className="vm-prompt-pre">{prompt || "(empty)"}</pre>
                  </div>
                ))}
              </div>
            </div>
          )}

          {tools.length > 0 && (
            <div className="vm-prompt-block">
              <span className="vm-mini-label">Tools ({tools.length})</span>
              <div className="vm-tools-list">
                {tools.map((t) => (
                  <span
                    key={t.name}
                    className={`vm-tool-chip vm-tool-fn${selectedTool === t.name ? " vm-tool-chip-active" : ""}`}
                    onClick={() => setSelectedTool(selectedTool === t.name ? null : t.name)}
                    style={{ cursor: "pointer" }}
                  >
                    {t.name}
                  </span>
                ))}
              </div>
              {activeTool && (
                <div className="vm-tool-detail">
                  <p className="vm-tool-detail-desc">{activeTool.description}</p>
                  {activeTool.parameters && (
                    <pre className="vm-prompt-pre">{JSON.stringify(activeTool.parameters, null, 2)}</pre>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </Section>
  );
}

function PromptStateViewer({ session }: { session: VoiceSession }) {
  const promptState = session.promptState || null;
  const cards = [
    {
      key: "instructions",
      title: "Current Realtime Instructions",
      snapshot: promptState?.instructions || null,
    },
    {
      key: "generation",
      title: "Latest VC Brain Prompt",
      snapshot: promptState?.generation || null,
    },
    {
      key: "classifier",
      title: "Latest Classifier Prompt",
      snapshot: promptState?.classifier || null,
    },
    {
      key: "bridge",
      title: "Latest Bridge Forwarded Turn",
      snapshot: promptState?.bridge || null,
    }
  ];
  const activeCount = cards.filter((card) => hasPromptSnapshot(card.snapshot)).length;

  return (
    <Section title="Live Prompt Snapshot" badge={activeCount > 0 ? activeCount : null}>
      {cards.map((card) => (
        <PromptSnapshotCard
          key={card.key}
          title={card.title}
          snapshot={card.snapshot}
        />
      ))}
    </Section>
  );
}

// ---- Brain Tools Config ----

function BrainToolsConfig({ session }: { session: VoiceSession }) {
  const tools = session.brainTools;
  if (!tools || tools.length === 0) return null;

  const fnTools = tools.filter((t) => t.toolType === "function");
  const mcpTools = tools.filter((t) => t.toolType === "mcp");

  return (
    <Section title="Brain Tools" badge={tools.length} defaultOpen={false}>
      {fnTools.length > 0 && (
        <div className="vm-tools-group">
          <span className="vm-mini-label">Function Tools ({fnTools.length})</span>
          <div className="vm-tools-list">
            {fnTools.map((t) => (
              <span key={t.name} className="vm-tool-chip vm-tool-fn" title={t.description}>
                {t.name}
              </span>
            ))}
          </div>
        </div>
      )}
      {mcpTools.length > 0 && (
        <div className="vm-tools-group">
          <span className="vm-mini-label">MCP Tools ({mcpTools.length})</span>
          <div className="vm-tools-list">
            {mcpTools.map((t) => (
              <span
                key={`${t.serverName || "mcp"}-${t.name}`}
                className="vm-tool-chip vm-tool-mcp"
                title={`${t.serverName ? `[${t.serverName}] ` : ""}${t.description}`}
              >
                {t.serverName ? `${t.serverName}/${t.name}` : t.name}
              </span>
            ))}
          </div>
        </div>
      )}
    </Section>
  );
}

// ---- Tool Call Log ----

function ToolCallLog({ session }: { session: VoiceSession }) {
  const calls = session.toolCalls;
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 2000);
    return () => clearInterval(id);
  }, []);

  if (!calls || calls.length === 0) return null;

  return (
    <Section title="Tool Calls" badge={calls.length} defaultOpen={false}>
      <div className="vm-toolcall-list">
        {calls.slice().reverse().map((call) => {
          const argsPreview = (() => {
            try {
              const raw = JSON.stringify(call.arguments);
              return raw.length > 80 ? raw.slice(0, 80) + "..." : raw;
            } catch {
              return "{}";
            }
          })();

          return (
            <div key={call.callId} className={`vm-toolcall-row ${call.success ? "" : "vm-toolcall-fail"}`}>
              <div className="vm-toolcall-header">
                <span className={`vm-toolcall-dot ${call.success ? "vm-toolcall-ok" : "vm-toolcall-err"}`} />
                <span className="vm-toolcall-name">{call.toolName}</span>
                <span className={`vm-tool-chip ${call.toolType === "mcp" ? "vm-tool-mcp" : "vm-tool-fn"}`}>
                  {call.toolType}
                </span>
                {call.runtimeMs != null && (
                  <span className={`vm-toolcall-runtime ${call.runtimeMs > 3000 ? "vm-toolcall-slow" : ""}`}>
                    {call.runtimeMs}ms
                  </span>
                )}
                {call.startedAt && (
                  <span className="vm-toolcall-time">{relativeTime(call.startedAt)}</span>
                )}
              </div>
              <div className="vm-toolcall-args">{argsPreview}</div>
              {call.error && <div className="vm-toolcall-error">{call.error}</div>}
              {call.outputSummary && !call.error && (
                <div className="vm-toolcall-output">{snippet(call.outputSummary, 120)}</div>
              )}
            </div>
          );
        })}
      </div>
    </Section>
  );
}

// ---- MCP Panel ----

function McpPanel({ session }: { session: VoiceSession }) {
  const servers = session.mcpStatus;
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 5000);
    return () => clearInterval(id);
  }, []);

  if (!servers || servers.length === 0) return null;

  const connectedCount = servers.filter((s) => s.connected).length;

  return (
    <Section title="MCP Servers" badge={`${connectedCount}/${servers.length}`} defaultOpen={false}>
      {servers.map((server) => (
        <div key={server.serverName} className={`vm-mcp-server ${server.connected ? "vm-mcp-connected" : "vm-mcp-disconnected"}`}>
          <div className="vm-mcp-header">
            <span className={`vm-mcp-dot ${server.connected ? "vm-mcp-dot-ok" : "vm-mcp-dot-err"}`} />
            <span className="vm-mcp-name">{server.serverName}</span>
            <span className="vm-mcp-tool-count">{server.tools.length} tool{server.tools.length !== 1 ? "s" : ""}</span>
          </div>
          {server.lastError && <div className="vm-mcp-error">{server.lastError}</div>}
          {server.tools.length > 0 && (
            <div className="vm-tools-list">
              {server.tools.map((tool) => (
                <span key={tool.name} className="vm-tool-chip vm-tool-mcp" title={tool.description}>
                  {tool.name}
                </span>
              ))}
            </div>
          )}
          <div className="vm-mcp-meta">
            {server.lastConnectedAt && <span className="vm-mcp-meta-item">connected {relativeTime(server.lastConnectedAt)}</span>}
            {server.lastCallAt && <span className="vm-mcp-meta-item">last call {relativeTime(server.lastCallAt)}</span>}
          </div>
        </div>
      ))}
    </Section>
  );
}

// ---- Screen Watch ----

function StreamWatchDetail({ session }: { session: VoiceSession }) {
  const sw = session.streamWatch;
  const visualFeed = Array.isArray(sw.visualFeed) ? sw.visualFeed : [];
  const notePayload = sw.notePayload;
  const hasBrainPayloadNotes = Boolean(
    notePayload &&
      Array.isArray(notePayload.notes) &&
      notePayload.notes.length > 0
  );
  const hasAnyStreamWatchData =
    Boolean(sw.active) ||
    Number(sw.ingestedFrameCount || 0) > 0 ||
    Boolean(sw.lastCommentaryNote) ||
    Boolean(sw.lastMemoryRecapText) ||
    visualFeed.length > 0 ||
    hasBrainPayloadNotes;
  if (!hasAnyStreamWatchData) return null;

  return (
    <Section title="Screen Watch" badge={sw.active ? "active" : "idle"} defaultOpen>
      <div className="vm-detail-grid">
        <Stat label="Target" value={sw.targetUserId?.slice(0, 8) || "none"} />
        <Stat label="Requested By" value={sw.requestedByUserId?.slice(0, 8) || "none"} />
        <Stat label="Frames" value={sw.ingestedFrameCount} />
        <Stat label="Window Frames" value={Number(sw.acceptedFrameCountInWindow || 0)} />
        {sw.frameWindowStartedAt && <Stat label="Window Started" value={relativeTime(sw.frameWindowStartedAt)} />}
        {sw.lastFrameAt && <Stat label="Last Frame" value={relativeTime(sw.lastFrameAt)} />}
        {sw.latestFrameAt && <Stat label="Latest Frame" value={relativeTime(sw.latestFrameAt)} />}
        {sw.latestFrameMimeType && <Stat label="Frame Mime" value={sw.latestFrameMimeType} />}
        {Number(sw.latestFrameApproxBytes || 0) > 0 && (
          <Stat label="Frame Size" value={formatApproxBytes(sw.latestFrameApproxBytes)} />
        )}
        {sw.lastCommentaryAt && <Stat label="Last Commentary" value={relativeTime(sw.lastCommentaryAt)} />}
        {sw.lastMemoryRecapAt && <Stat label="Last Recap" value={relativeTime(sw.lastMemoryRecapAt)} />}
        {sw.lastNoteAt && <Stat label="Last Screen Note" value={relativeTime(sw.lastNoteAt)} />}
        <Stat label="Screen Notes" value={Number(sw.noteCount || visualFeed.length)} />
        {(sw.lastMemoryRecapText || sw.lastMemoryRecapAt) && (
          <Stat label="Recap Saved" value={sw.lastMemoryRecapDurableSaved ? "durable" : "journal only"} />
        )}
        {(sw.lastNoteProvider || sw.lastNoteModel) && (
          <Stat
            label="Note Model"
            value={[sw.lastNoteProvider, sw.lastNoteModel].filter(Boolean).join(" / ")}
          />
        )}
      </div>

      {(sw.lastCommentaryNote || sw.lastCommentaryAt) && (
        <>
          <span className="vm-mini-label">Last Spoken Screen Commentary</span>
          <div className="vm-convo-context-summary">
            <div className="vm-convo-meta">
              <span className="vm-convo-role vm-convo-role-assistant">spoken</span>
              {sw.lastCommentaryAt && <span className="vm-convo-time">{relativeTime(sw.lastCommentaryAt)}</span>}
            </div>
            <div className="vm-convo-text">{sw.lastCommentaryNote || "(no saved line)"}</div>
          </div>
        </>
      )}

      {(sw.lastMemoryRecapText || sw.lastMemoryRecapAt || sw.lastMemoryRecapReason) && (
        <>
          <span className="vm-mini-label">Persisted Screen-Share Recap</span>
          <div className="vm-convo-context-summary">
            <div className="vm-convo-meta">
              <span className="vm-convo-role vm-convo-role-assistant">memory recap</span>
              {sw.lastMemoryRecapAt && <span className="vm-convo-time">{relativeTime(sw.lastMemoryRecapAt)}</span>}
              {sw.lastMemoryRecapReason && <span className="vm-convo-time">{sw.lastMemoryRecapReason}</span>}
              <span className="vm-convo-time">
                {sw.lastMemoryRecapDurableSaved ? "durable fact saved" : "journaled only"}
              </span>
            </div>
            <div className="vm-convo-text">{sw.lastMemoryRecapText || "(no recap text)"}</div>
          </div>
        </>
      )}

      {visualFeed.length > 0 && (
        <>
          <span className="vm-mini-label">Screen Note Feed</span>
          <div className="vm-convo-feed">
            {visualFeed.slice(-10).reverse().map((entry, index) => (
              <div key={`${entry.at || "na"}-${index}`} className="vm-convo-msg vm-convo-user">
                <div className="vm-convo-meta">
                  <span className="vm-convo-role vm-convo-role-user">
                    {entry.speakerName || "note loop"}
                  </span>
                  {(entry.provider || entry.model) && (
                    <span className="vm-convo-time">
                      {[entry.provider, entry.model].filter(Boolean).join(" / ")}
                    </span>
                  )}
                  {entry.at && <span className="vm-convo-time">{relativeTime(entry.at)}</span>}
                </div>
                <div className="vm-convo-text">{entry.text}</div>
              </div>
            ))}
          </div>
        </>
      )}

      {notePayload?.prompt && (
        <>
          <span className="vm-mini-label">Prompt Note Context</span>
          <div className="vm-prompt-card">
            <div className="vm-prompt-card-header">
              <div className="vm-prompt-card-title">
                <span className="vm-prompt-title">Note Instruction</span>
                <span className="vm-prompt-meta">
                  {notePayload.lastAt ? relativeTime(notePayload.lastAt) : "no updates yet"}
                  {(notePayload.provider || notePayload.model)
                    ? ` · ${[notePayload.provider, notePayload.model].filter(Boolean).join(" / ")}`
                    : ""}
                </span>
              </div>
              <CopyButton text={notePayload.prompt || "(none)"} label />
            </div>
            <pre className="vm-prompt-pre">{notePayload.prompt || "(none)"}</pre>
          </div>
        </>
      )}

      {notePayload && Array.isArray(notePayload.notes) && notePayload.notes.length > 0 && (
        <>
          <span className="vm-mini-label">Injected Prompt Notes</span>
          <div className="vm-convo-feed">
            {notePayload.notes.map((note, index) => (
              <div key={`${index}-${note.slice(0, 18)}`} className="vm-convo-msg vm-convo-assistant">
                <div className="vm-convo-meta">
                  <span className="vm-convo-role vm-convo-role-assistant">context</span>
                </div>
                <div className="vm-convo-text">{note}</div>
              </div>
            ))}
          </div>
        </>
      )}

    </Section>
  );
}

// ---- Music Detail ----

function formatTrackDuration(seconds: number | null): string {
  if (!Number.isFinite(seconds) || seconds == null || seconds < 0) return "--:--";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function MusicDetail({ session }: { session: VoiceSession }) {
  const music = session.music;
  if (!music) return null;

  const hasNowPlaying = music.active && music.lastTrackTitle;
  const hasDisambiguation = music.disambiguationActive && music.pendingResults.length > 0;
  const hasPendingSearch = Boolean(music.pendingQuery) && !hasDisambiguation;
  const hasAnyData = hasNowPlaying || hasDisambiguation || hasPendingSearch ||
    music.lastTrackTitle || music.lastCommandAt;

  if (!hasAnyData) return null;

  return (
    <Section title="Music" badge={music.active ? "playing" : music.disambiguationActive ? "choosing" : "idle"} defaultOpen>
      {/* Now playing */}
      {music.lastTrackTitle && (
        <div className="vm-music-now-playing">
          <div>
            <div className="vm-music-track-title">
              {music.lastTrackUrl ? (
                <a href={music.lastTrackUrl} target="_blank" rel="noopener noreferrer">{music.lastTrackTitle}</a>
              ) : (
                music.lastTrackTitle
              )}
            </div>
            {music.lastTrackArtists.length > 0 && (
              <div className="vm-music-track-artists">{music.lastTrackArtists.join(", ")}</div>
            )}
          </div>
          {music.provider && <span className="vm-music-provider-badge">{music.provider}</span>}
        </div>
      )}

      {/* Disambiguation */}
      {hasDisambiguation && (
        <div className="vm-music-disambiguation">
          <div className="vm-music-disambiguation-query">
            Choosing: &ldquo;{music.pendingQuery}&rdquo;
            {music.pendingPlatform && ` on ${music.pendingPlatform}`}
          </div>
          <div className="vm-music-disambiguation-list">
            {music.pendingResults.map((r) => (
              <div key={r.id} className="vm-music-result-row">
                <span className="vm-music-result-title">{r.title}</span>
                <span className="vm-music-result-artist">{r.artist}</span>
                <span className="vm-music-result-duration">{formatTrackDuration(r.durationSeconds)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Pending search */}
      {hasPendingSearch && (
        <div className="vm-music-pending">
          <span className="vm-music-pending-label">Searching</span>
          &ldquo;{music.pendingQuery}&rdquo;
          {music.pendingPlatform && ` on ${music.pendingPlatform}`}
        </div>
      )}

      {/* Stats grid */}
      <div className="vm-detail-grid">
        {music.lastCommandAt && <Stat label="Last Command" value={relativeTime(music.lastCommandAt)} />}
        {music.lastCommandReason && <Stat label="Reason" value={music.lastCommandReason} />}
        {music.source && <Stat label="Source" value={music.source} />}
        {music.lastRequestText && <Stat label="Request" value={snippet(music.lastRequestText, 60)} />}
        {music.startedAt && <Stat label="Started" value={relativeTime(music.startedAt)} />}
        {music.stoppedAt && <Stat label="Stopped" value={relativeTime(music.stoppedAt)} />}
      </div>
    </Section>
  );
}

// ---- Expanded Session Card ----

function SessionCard({ session }: { session: VoiceSession }) {
  const [, setTick] = useState(0);
  const [expanded, setExpanded] = useState(true);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const state = deriveBotState(session);
  const pendingTurns = (session.batchAsr?.pendingTurns || 0) + (session.realtime?.pendingTurns || 0);
  const totalPending = pendingTurns + session.pendingDeferredTurns;
  const wakeIndicator = resolveWakeIndicator(session);
  const activeCaptures = Array.isArray(session.activeCaptures) ? session.activeCaptures : [];
  const transcribingSummary = activeCaptures.length > 0
    ? activeCaptures
        .slice(0, 3)
        .map((capture) => resolveCaptureTargetName(capture))
        .join(", ")
    : "";
  const transcribingSummaryWithOverflow =
    activeCaptures.length <= 3
      ? transcribingSummary
      : `${transcribingSummary} +${activeCaptures.length - 3}`;

  return (
    <div className={`vm-card panel vm-card-${state}`}>
      {/* Header */}
      <div className="vm-card-header" onClick={() => setExpanded(!expanded)}>
        <span className={`vm-mode-badge vm-mode-${session.mode}`}>
          {MODE_LABELS[session.mode] || session.mode}
        </span>
        <span className={`vm-state-dot vm-state-${state}`} title={STATE_LABELS[state]} />
        <span className="vm-state-label">{STATE_LABELS[state]}</span>
        <span className="vm-card-expand">{expanded ? "\u25B4" : "\u25BE"}</span>
      </div>

      {/* Quick stats row - always visible */}
      <div className="vm-card-quick">
        <Stat label="Duration" value={elapsed(session.startedAt)} />
        <Stat label="Humans" value={session.participantCount} />
        <Stat label="Inputs" value={session.activeInputStreams} />
        <Stat label="Pending" value={totalPending} warn={totalPending > 2} />
        {session.realtime && (
          <Stat
            label="Superseded"
            value={Number(session.realtime.replySuperseded || 0)}
            warn={Number(session.realtime.replySuperseded || 0) > 0}
          />
        )}
        <Stat label="Soundboard" value={session.soundboard.playCount} />
      </div>

      {/* Pipeline bar */}
      <PipelineBadge session={session} />

      {/* Turn state indicators */}
      <div className="vm-turn-state">
          <span
            className={`vm-ts-pill ${
            wakeIndicator.active ? "vm-ts-wake-active" : "vm-ts-wake-ambient"
          }`}
        >
          Wake: {wakeIndicator.stateLabel}
        </span>
        {session.playbackArm != null && (
          <span className={`vm-ts-pill ${session.playbackArm.armed ? "vm-ts-dave-armed" : "vm-ts-dave-pending"}`}>
            DAVE: {session.playbackArm.armed ? "Armed" : "Handshake"}
          </span>
        )}
        {session.realtime?.coalesceActive && (
          <span className="vm-ts-pill vm-ts-coalescing">Coalescing</span>
        )}
        {session.botTurnOpen && <span className="vm-ts-pill vm-ts-speaking">Bot Speaking</span>}
        {session.activeInputStreams > 0 && (
          <span className="vm-ts-pill vm-ts-capturing">
            Transcribing: {transcribingSummaryWithOverflow || `${session.activeInputStreams} capture(s)`}
          </span>
        )}
        {session.realtime?.drainActive && (
          <span className="vm-ts-pill vm-ts-draining">Turn Draining</span>
        )}
        {session.pendingDeferredTurns > 0 && (
          <span className="vm-ts-pill vm-ts-deferred">
            {session.pendingDeferredTurns} Deferred
          </span>
        )}
        {session.music?.active && (
          <span className="vm-ts-pill vm-ts-music-playing">Music: Playing</span>
        )}
        {!session.music?.active && session.music?.disambiguationActive && (
          <span className="vm-ts-pill vm-ts-music-searching">Music: Choosing</span>
        )}
        {!session.music?.active && !session.music?.disambiguationActive && session.music?.pendingQuery && (
          <span className="vm-ts-pill vm-ts-music-searching">Music: Searching</span>
        )}
        {session.focusedSpeaker && (
          <span className="vm-ts-pill vm-ts-focus">
            Focus: {session.focusedSpeaker.displayName || session.focusedSpeaker.userId.slice(0, 8)}
          </span>
        )}
      </div>

      {/* Expanded detail sections */}
      {expanded && (
        <div className="vm-card-detail">
          {/* Pipeline latency */}
          <LatencyPanel latency={session.latency} />

          {/* Timers */}
          <Section title="Session Timers" defaultOpen={false}>
            <div className="vm-detail-grid">
              <Stat label="Started" value={relativeTime(session.startedAt)} />
              <Stat label="Last Activity" value={relativeTime(session.lastActivityAt)} />
              {session.maxEndsAt && <Stat label="Max Duration" value={timeUntil(session.maxEndsAt)} />}
              {session.inactivityEndsAt && (
                <Stat label="Inactivity Timeout" value={timeUntil(session.inactivityEndsAt)} warn />
              )}
              {session.soundboard.lastPlayedAt && (
                <Stat label="Last Soundboard" value={relativeTime(session.soundboard.lastPlayedAt)} />
              )}
            </div>
          </Section>

          {/* Realtime connection */}
          <RealtimeDetail session={session} />

          {/* Per-User ASR Sessions */}
          <AsrSessionsPanel session={session} />

          {/* Participants */}
          <ParticipantList session={session} />

          {/* Membership changes */}
          <MembershipChanges session={session} />

          {/* Conversation context */}
          <ConversationContext session={session} latencyTurns={session.latency?.recentTurns || []} />

          {/* Live Prompt Snapshot */}
          <PromptStateViewer session={session} />

          {/* Brain Tools */}
          <BrainToolsConfig session={session} />

          {/* Tool Call Log */}
          <ToolCallLog session={session} />

          {/* MCP Servers */}
          <McpPanel session={session} />

          {/* Screen Watch */}
          <StreamWatchDetail session={session} />

          {/* Music */}
          <MusicDetail session={session} />
        </div>
      )}

      {/* Footer */}
      <div className="vm-card-footer">
        <span className="vm-card-id" title={session.guildId}>
          {session.guildId.slice(0, 8)}...
        </span>
        <span className="vm-card-id" title={session.voiceChannelId}>
          vc:{session.voiceChannelId.slice(0, 6)}
        </span>
        {session.realtime?.provider && (
          <span className="vm-card-provider">{session.realtime.provider}</span>
        )}
      </div>
    </div>
  );
}

// ---- Event Row ----

const EVENT_KIND_COLORS: Record<string, string> = {
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

function EventRow({ event, defaultExpanded }: { event: VoiceEvent; defaultExpanded?: boolean }) {
  const [, setTick] = useState(0);
  const [expanded, setExpanded] = useState(defaultExpanded || false);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 5000);
    return () => clearInterval(id);
  }, []);

  const kindShort = (event.kind || "").replace(/^voice_/, "");
  const meta = event.metadata as Record<string, unknown> | undefined;

  return (
    <div className="vm-event-row-wrap">
      <div className="vm-event-row" onClick={() => meta && setExpanded(!expanded)}>
        <span className="vm-event-time">{relativeTime(event.createdAt)}</span>
        <span
          className="vm-event-badge"
          style={{
            background: `${EVENT_KIND_COLORS[kindShort] || "#64748b"}18`,
            color: EVENT_KIND_COLORS[kindShort] || "#64748b"
          }}
        >
          {kindShort}
        </span>
        <span className="vm-event-content">{snippet(event.content)}</span>
        {meta && <span className="vm-event-expand-hint">{expanded ? "\u25B4" : "\u22EF"}</span>}
      </div>
      {expanded && meta && (
        <div className="vm-event-meta">
          {Object.entries(meta).map(([k, v]) => (
            <div key={k} className="vm-meta-row">
              <span className="vm-meta-key">{k}</span>
              <span className="vm-meta-val">
                {typeof v === "object" ? JSON.stringify(v) : String(v ?? "")}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Event Kind Filter ----

const EVENT_KINDS = [
  "session_start", "session_end", "turn_in", "turn_out",
  "turn_addressing", "soundboard_play", "error", "runtime", "intent_detected"
];

function EventFilter({
  active,
  onToggle,
  showRuntime,
  onToggleRuntime
}: {
  active: Set<string>;
  onToggle: (kind: string) => void;
  showRuntime: boolean;
  onToggleRuntime: () => void;
}) {
  return (
    <div className="vm-event-filters">
      {EVENT_KINDS.map((kind) => {
        if (kind === "runtime" && !showRuntime) return null;
        const isActive = active.has(kind);
        return (
          <button
            key={kind}
            className={`vm-filter-chip ${isActive ? "vm-filter-active" : "vm-filter-inactive"}`}
            style={{
              borderColor: isActive ? (EVENT_KIND_COLORS[kind] || "#64748b") : undefined,
              color: isActive ? (EVENT_KIND_COLORS[kind] || "#64748b") : undefined
            }}
            onClick={() => onToggle(kind)}
          >
            {kind.replace(/_/g, " ")}
          </button>
        );
      })}
      <label className="vm-runtime-toggle">
        <input type="checkbox" checked={showRuntime} onChange={onToggleRuntime} />
        runtime
      </label>
    </div>
  );
}

// ---- Voice History Viewer ----

function HistoryTranscript({ events }: { events: VoiceEvent[] }) {
  const turns = events
    .filter((e) => {
      const meta = e.metadata as Record<string, unknown> | undefined;
      if (e.kind !== "voice_runtime" || !meta?.transcript) return false;
      return isFinalHistoryTranscriptEventType(meta.transcriptEventType, meta.transcriptSource);
    })
    .map((e) => {
      const meta = e.metadata as Record<string, unknown>;
      return {
        role: String(meta.transcriptSource || "user").includes("output") ? "output" : "user",
        text: String(meta.transcript || ""),
        at: e.createdAt
      };
    });

  if (turns.length === 0) return null;

  return (
    <Section title="Transcript" badge={turns.length} defaultOpen>
      <div className="vm-convo-feed">
        {turns.map((t, i) => (
          <div key={i} className={`vm-convo-msg vm-convo-${t.role}`}>
            <div className="vm-convo-meta">
              <span className={`vm-convo-role vm-convo-role-${t.role}`}>
                {t.role === "assistant" ? "bot" : t.role}
              </span>
              {t.at && <span className="vm-convo-time">{relativeTime(t.at)}</span>}
            </div>
            <div className="vm-convo-text">{t.text || "(empty)"}</div>
          </div>
        ))}
      </div>
    </Section>
  );
}

function VoiceHistoryViewer({
  history
}: {
  history: ReturnType<typeof useVoiceHistory>;
}) {
  const { sessions, selectedSessionId, events, loading, error, toggle } = history;
  const [historyActiveKinds, setHistoryActiveKinds] = useState<Set<string>>(
    () => new Set(EVENT_KINDS)
  );
  const [historyShowRuntime, setHistoryShowRuntime] = useState(true);

  if (sessions.length === 0) return null;

  const selected = sessions.find((s) => s.sessionId === selectedSessionId) || null;

  const filteredEvents = events.filter((e) => {
    const kindShort = (e.kind || "").replace(/^voice_/, "");
    if (kindShort === "runtime" && !historyShowRuntime) return false;
    return historyActiveKinds.has(kindShort);
  });

  return (
    <section className="vm-history panel">
      <h3>Past Sessions</h3>
      <div className="vm-history-picker">
        {sessions.map((s) => (
          <button
            key={s.sessionId}
            className={`vm-history-pill ${s.sessionId === selectedSessionId ? "vm-history-pill-active" : ""}`}
            onClick={() => toggle(s.sessionId)}
          >
            <span className="vm-history-pill-mode">{MODE_LABELS[s.mode] || s.mode}</span>
            <span className="vm-history-pill-time">{relativeTime(s.startedAt)}</span>
            <span className="vm-history-pill-dur">{formatDuration(s.durationSeconds)}</span>
          </button>
        ))}
      </div>

      {selectedSessionId && (
        <div className="vm-history-detail">
          {loading && <p className="vm-empty">Loading session...</p>}
          {error && <p className="vm-empty" style={{ color: "var(--danger)" }}>{error}</p>}

          {selected && !loading && (
            <>
              <div className="vm-detail-grid">
                <Stat label="Mode" value={MODE_LABELS[selected.mode] || selected.mode} />
                <Stat label="Duration" value={formatDuration(selected.durationSeconds)} />
                <Stat label="End Reason" value={selected.endReason} />
              </div>

              <HistoryTranscript events={events} />

              <Section title="Events" badge={filteredEvents.length} defaultOpen={false}>
                <EventFilter
                  active={historyActiveKinds}
                  onToggle={(kind) =>
                    setHistoryActiveKinds((prev) => {
                      const next = new Set(prev);
                      if (next.has(kind)) next.delete(kind);
                      else next.add(kind);
                      return next;
                    })
                  }
                  showRuntime={historyShowRuntime}
                  onToggleRuntime={() => setHistoryShowRuntime(!historyShowRuntime)}
                />
                <div className="vm-timeline-feed">
                  {filteredEvents.length === 0 ? (
                    <p className="vm-empty">No events</p>
                  ) : (
                    filteredEvents.map((e, i) => (
                      <EventRow key={`${e.createdAt}-${i}`} event={e} />
                    ))
                  )}
                </div>
              </Section>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// ---- Main Component ----

export default function VoiceMonitor() {
  const { voiceState, events, status } = useVoiceSSE();
  const { guilds, selectedGuildId } = useDashboardGuildScope();
  const history = useVoiceHistory(selectedGuildId || null);
  const { refresh: refreshHistory, ingestLiveEvent } = history;
  const [joinTextChannelId, setJoinTextChannelId] = useState("");
  const [joinPending, setJoinPending] = useState(false);
  const [joinStatus, setJoinStatus] = useState<{
    text: string;
    type: "ok" | "error" | "";
  }>({
    text: "",
    type: ""
  });
  const [showRuntime, setShowRuntime] = useState(true);
  const [showDebugger, setShowDebugger] = useState(false);
  const [activeKinds, setActiveKinds] = useState<Set<string>>(
    () => new Set(EVENT_KINDS)
  );
  const timelineRef = useRef<HTMLDivElement>(null);
  const prevSessionIdsRef = useRef<Set<string>>(new Set());
  const lastProcessedLiveEventKeyRef = useRef("");

  const sessions = useMemo(
    () =>
      (voiceState?.sessions || []).filter((session) => {
        if (!selectedGuildId) return true;
        return String(session.guildId || "").trim() === selectedGuildId;
      }),
    [selectedGuildId, voiceState?.sessions]
  );

  // Auto-refresh history when a live session disappears
  useEffect(() => {
    const currentIds = new Set(sessions.map((s) => s.sessionId));
    const prevIds = prevSessionIdsRef.current;
    if (prevIds.size > 0 && currentIds.size < prevIds.size) {
      refreshHistory();
    }
    prevSessionIdsRef.current = currentIds;
  }, [sessions, refreshHistory]);

  // Keep history panels synced with live voice events.
  useEffect(() => {
    const latestEvent = events[0];
    if (!latestEvent) return;
    const key = `${String(latestEvent.createdAt || "")}|${String(latestEvent.kind || "")}|${String(latestEvent.content || "")}`;
    if (!key || key === lastProcessedLiveEventKeyRef.current) return;
    lastProcessedLiveEventKeyRef.current = key;

    ingestLiveEvent(latestEvent);
    const normalizedKind = String(latestEvent.kind || "").trim().toLowerCase();
    if (normalizedKind === "voice_session_start" || normalizedKind === "voice_session_end") {
      refreshHistory();
    }
  }, [events, ingestLiveEvent, refreshHistory]);

  const toggleKind = (kind: string) => {
    setActiveKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  };

  const filteredEvents = events.filter((e) => {
    const eventGuildId = String(e.guildId || "").trim();
    if (selectedGuildId && eventGuildId && eventGuildId !== selectedGuildId) return false;
    const kindShort = (e.kind || "").replace(/^voice_/, "");
    if (kindShort === "runtime" && !showRuntime) return false;
    return activeKinds.has(kindShort);
  });

  const requestVoiceJoin = async () => {
    setJoinPending(true);
    try {
      const payload: Record<string, string> = {
        source: "dashboard_voice_tab",
        requesterUserId: "830574404453793842"
      };
      if (selectedGuildId) payload.guildId = selectedGuildId;
      const normalizedTextChannelId = joinTextChannelId.trim();
      if (normalizedTextChannelId) payload.textChannelId = normalizedTextChannelId;

      const result = await api<VoiceJoinResponse>("/api/voice/join", {
        method: "POST",
        body: payload
      });
      setJoinStatus(resolveVoiceJoinStatusMessage(result));
    } catch (error: unknown) {
      setJoinStatus({
        type: "error",
        text: error instanceof Error ? error.message : String(error)
      });
    } finally {
      setJoinPending(false);
    }
  };

  if (showDebugger) {
    return (
      <Suspense fallback={<div style={{ padding: 20, color: "var(--ink-3)" }}>Loading debugger...</div>}>
        <VoiceDebugger
          sessions={sessions}
          events={events}
          sseStatus={status}
          onBack={() => setShowDebugger(false)}
        />
      </Suspense>
    );
  }

  return (
    <div className="vm-container">
      {/* Connection status */}
      <div className="vm-connection-bar">
        <span className={`vm-conn-dot vm-conn-${status}`} />
        <span className="vm-conn-label">
          {status === "open" ? "Live" : status === "connecting" ? "Connecting..." : "Disconnected"}
        </span>
        {voiceState && (
          <span className="vm-conn-count">
            {voiceState.activeCount} active session{voiceState.activeCount !== 1 ? "s" : ""}
          </span>
        )}
        <button
          type="button"
          className="vm-debugger-toggle"
          onClick={() => setShowDebugger(true)}
        >
          FLIGHT RECORDER
        </button>
      </div>

      <section className="vm-join panel">
        <div className="vm-join-row">
          <div className="vm-join-field">
            <label className="vm-join-label">Guild</label>
            <div className="vm-join-static-field">
              {guilds.find((guild) => guild.id === selectedGuildId)?.name || selectedGuildId || "No guild selected"}
            </div>
          </div>
          <div className="vm-join-field">
            <label className="vm-join-label" htmlFor="vm-join-source-channel">
              Summoned From Channel ID
            </label>
            <input
              id="vm-join-source-channel"
              type="text"
              value={joinTextChannelId}
              onChange={(event) => setJoinTextChannelId(event.target.value)}
              disabled={joinPending}
              placeholder="Optional text channel ID"
            />
          </div>
          <button type="button" onClick={requestVoiceJoin} disabled={joinPending}>
            {joinPending ? "Joining..." : "Join VC"}
          </button>
        </div>
        {joinStatus.text && (
          <p className={`vm-join-status ${joinStatus.type}`} role="status" aria-live="polite">
            {joinStatus.text}
          </p>
        )}
      </section>

      {/* Session panels */}
      <section className="vm-sessions">
        {sessions.length === 0 ? (
          <p className="vm-empty">No active voice sessions</p>
        ) : (
          <div className="vm-card-stack">
            {sessions.map((s) => (
              <SessionCard key={s.sessionId} session={s} />
            ))}
          </div>
        )}
      </section>

      {/* Past session history */}
      <VoiceHistoryViewer history={history} />

      {/* Event timeline */}
      <section className="vm-timeline panel">
        <div className="vm-timeline-header">
          <h3>Event Timeline</h3>
          <span className="vm-event-count">{filteredEvents.length} events</span>
        </div>
        <EventFilter
          active={activeKinds}
          onToggle={toggleKind}
          showRuntime={showRuntime}
          onToggleRuntime={() => setShowRuntime(!showRuntime)}
        />
        <div className="vm-timeline-feed" ref={timelineRef}>
          {filteredEvents.length === 0 ? (
            <p className="vm-empty">No voice events yet</p>
          ) : (
            filteredEvents.map((e, i) => (
              <EventRow key={`${e.createdAt}-${i}`} event={e} />
            ))
          )}
        </div>
      </section>
    </div>
  );
}
