import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import {
  useVoiceSSE,
  type VoiceEvent
} from "../hooks/useVoiceSSE";
const VoiceDebugger = lazy(() => import("./VoiceDebugger"));
import { useVoiceHistory } from "../hooks/useVoiceHistory";
import { useDashboardGuildScope } from "../guildScope";
import { Section } from "./ui";
import { SessionCard } from "./voiceMonitor/SessionCard";
import {
  EVENT_KIND_COLORS,
  EVENT_KINDS,
  MODE_LABELS,
  VoiceJoinResponse,
  formatDuration,
  isFinalHistoryTranscriptEventType,
  relativeTime,
  resolveVoiceJoinStatusMessage,
  snippet,
  Stat
} from "./voiceMonitor/shared";

// ---- Event Row ----

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
        {meta && <span className="vm-event-expand-hint">{expanded ? "▴" : "⋯"}</span>}
      </div>
      {expanded && meta && (
        <div className="vm-event-meta">
          {Object.entries(meta).map(([k, v]) => (
            <div key={k} className="vm-meta-row">
              <span className="vm-meta-key">{k}</span>
              <span className="vm-meta-val">{typeof v === "object" ? JSON.stringify(v) : String(v ?? "")}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Event Kind Filter ----

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
  const [historyActiveKinds, setHistoryActiveKinds] = useState<Set<string>>(() => new Set(EVENT_KINDS));
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
          {error && (
            <p className="vm-empty" style={{ color: "var(--danger)" }}>
              {error}
            </p>
          )}

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
                    filteredEvents.map((e, i) => <EventRow key={`${e.createdAt}-${i}`} event={e} />)
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
  const [activeKinds, setActiveKinds] = useState<Set<string>>(() => new Set(EVENT_KINDS));
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

  useEffect(() => {
    const currentIds = new Set(sessions.map((s) => s.sessionId));
    const prevIds = prevSessionIdsRef.current;
    if (prevIds.size > 0 && currentIds.size < prevIds.size) {
      refreshHistory();
    }
    prevSessionIdsRef.current = currentIds;
  }, [sessions, refreshHistory]);

  useEffect(() => {
    const latestEvent = events[0];
    if (!latestEvent) return;
    const key = `${String(latestEvent.createdAt || "")}|${String(latestEvent.kind || "")}|${String(
      latestEvent.content || ""
    )}`;
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
        <VoiceDebugger sessions={sessions} events={events} sseStatus={status} onBack={() => setShowDebugger(false)} />
      </Suspense>
    );
  }

  return (
    <div className="vm-container">
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
        <button type="button" className="vm-debugger-toggle" onClick={() => setShowDebugger(true)}>
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

      <VoiceHistoryViewer history={history} />

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
            filteredEvents.map((e, i) => <EventRow key={`${e.createdAt}-${i}`} event={e} />)
          )}
        </div>
      </section>
    </div>
  );
}
