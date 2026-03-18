import { useEffect, useState } from "react";
import type { RealtimeState, VoiceMembershipEvent, VoiceSession } from "../../hooks/useVoiceSSE";
import { deriveBotState, elapsed } from "../../utils/voiceHelpers";
import { Section } from "../ui";
import { ConversationContext } from "./ConversationContext";
import { LatencyPanel } from "./LatencyPanel";
import { McpPanel } from "./McpPanel";
import { MusicDetail } from "./MusicDetail";
import { ParticipantList } from "./ParticipantList";
import { PromptStateViewer } from "./PromptStateViewer";
import { StreamWatchDetail } from "./StreamWatchDetail";
import { ToolCallLog } from "./ToolCallLog";
import {
  MODE_LABELS,
  STATE_LABELS,
  formatApproxBytes,
  relativeTime,
  resolveCaptureTargetName,
  resolveWakeIndicator,
  snippet,
  Stat,
  timeUntil
} from "./shared";

function PipelineBadge({ session }: { session: VoiceSession }) {
  const rt = session.realtime;
  const context = session.conversation?.modelContext;
  const generationContext = context?.generation;
  const trackedTurns = Number(context?.trackedTurns || 0);
  const sentTurns = Number(generationContext?.sentTurns || 0);
  const hasContextCoverage = trackedTurns > 0;

  if (!rt) return null;

  const state = rt.state as RealtimeState | null;
  const connected = state?.connected !== false;
  return (
    <div className="vm-pipeline-row">
      <span className={`vm-pipe-dot ${connected ? "vm-pipe-ok" : "vm-pipe-err"}`} />
      <span className="vm-pipe-label">{rt.provider}</span>
      <span className="vm-pipe-detail">
        {rt.inputSampleRateHz / 1000}kHz in / {rt.outputSampleRateHz / 1000}kHz out
      </span>
      {hasContextCoverage && <span className="vm-pipe-detail">ctx {sentTurns}/{trackedTurns}</span>}
      {rt.drainActive && <span className="vm-pipe-tag vm-pipe-draining">draining</span>}
      {state?.activeResponseId && <span className="vm-pipe-tag vm-pipe-responding">responding</span>}
    </div>
  );
}

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
          const idlePct = asr.idleMs != null && asr.idleTtlMs > 0 ? Math.min(1, asr.idleMs / asr.idleTtlMs) : 0;
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
                <span className="vm-asr-name" title={asr.userId}>
                  {name}
                </span>
                {asr.model && <span className="vm-asr-model">{asr.model}</span>}
              </div>
              {asr.utterance && asr.utterance.partialText && (
                <div className="vm-asr-partial" title={asr.utterance.partialText}>
                  {snippet(asr.utterance.partialText, 80)}
                </div>
              )}
              <div className="vm-asr-stats">
                {asr.connectedAt && <span className="vm-asr-stat">up {elapsed(asr.connectedAt)}</span>}
                {asr.lastTranscriptAt && <span className="vm-asr-stat">last {relativeTime(asr.lastTranscriptAt)}</span>}
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
                  <div className="vm-asr-idle-bar" style={{ width: `${Math.round(idlePct * 100)}%` }} />
                  <span className="vm-asr-idle-label">
                    idle {idleLabel} / {(asr.idleTtlMs / 1000).toFixed(0)}s
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Section>
  );
}

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
            {state.lastOutboundEventType && <Stat label="Last Sent" value={state.lastOutboundEventType} />}
            {state.lastOutboundEventAt && <Stat label="Sent At" value={relativeTime(state.lastOutboundEventAt)} />}
            {state.activeResponseId && (
              <Stat label="Active Response" value={state.activeResponseId.slice(0, 12) + "..."} />
            )}
            {state.activeResponseStatus && <Stat label="Response Status" value={state.activeResponseStatus} />}
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
              <span className="vm-membership-name">{entry.displayName || entry.userId.slice(0, 8)}</span>
              <span className="vm-membership-time">{relativeTime(entry.at)}</span>
            </div>
          );
        })}
      </div>
    </Section>
  );
}

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

export function SessionCard({ session }: { session: VoiceSession }) {
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
  const transcribingSummary =
    activeCaptures.length > 0
      ? activeCaptures
          .slice(0, 3)
          .map((capture) => resolveCaptureTargetName(capture))
          .join(", ")
      : "";
  const transcribingSummaryWithOverflow =
    activeCaptures.length <= 3 ? transcribingSummary : `${transcribingSummary} +${activeCaptures.length - 3}`;

  return (
    <div className={`vm-card panel vm-card-${state}`}>
      <div className="vm-card-header" onClick={() => setExpanded(!expanded)}>
        <span className={`vm-mode-badge vm-mode-${session.mode}`}>{MODE_LABELS[session.mode] || session.mode}</span>
        <span className={`vm-state-dot vm-state-${state}`} title={STATE_LABELS[state]} />
        <span className="vm-state-label">{STATE_LABELS[state]}</span>
        <span className="vm-card-expand">{expanded ? "▴" : "▾"}</span>
      </div>

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

      <PipelineBadge session={session} />

      <div className="vm-turn-state">
        <span className={`vm-ts-pill ${wakeIndicator.active ? "vm-ts-wake-active" : "vm-ts-wake-ambient"}`}>
          Wake: {wakeIndicator.stateLabel}
        </span>
        {session.playbackArm != null && (
          <span className={`vm-ts-pill ${session.playbackArm.armed ? "vm-ts-dave-armed" : "vm-ts-dave-pending"}`}>
            DAVE: {session.playbackArm.armed ? "Armed" : "Handshake"}
          </span>
        )}
        {session.realtime?.coalesceActive && <span className="vm-ts-pill vm-ts-coalescing">Coalescing</span>}
        {session.botTurnOpen && <span className="vm-ts-pill vm-ts-speaking">Bot Speaking</span>}
        {session.activeInputStreams > 0 && (
          <span className="vm-ts-pill vm-ts-capturing">
            Transcribing: {transcribingSummaryWithOverflow || `${session.activeInputStreams} capture(s)`}
          </span>
        )}
        {session.realtime?.drainActive && <span className="vm-ts-pill vm-ts-draining">Turn Draining</span>}
        {session.pendingDeferredTurns > 0 && (
          <span className="vm-ts-pill vm-ts-deferred">{session.pendingDeferredTurns} Deferred</span>
        )}
        {session.music?.active && <span className="vm-ts-pill vm-ts-music-playing">Music: Playing</span>}
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

      {expanded && (
        <div className="vm-card-detail">
          <LatencyPanel latency={session.latency} />

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

          <RealtimeDetail session={session} />
          <AsrSessionsPanel session={session} />
          <ParticipantList session={session} />
          <MembershipChanges session={session} />
          <ConversationContext session={session} latencyTurns={session.latency?.recentTurns || []} />
          <PromptStateViewer session={session} />
          <BrainToolsConfig session={session} />
          <ToolCallLog session={session} />
          <McpPanel session={session} />
          <StreamWatchDetail session={session} />
          <MusicDetail session={session} />
        </div>
      )}

      <div className="vm-card-footer">
        <span className="vm-card-id" title={session.guildId}>
          {session.guildId.slice(0, 8)}...
        </span>
        <span className="vm-card-id" title={session.voiceChannelId}>
          vc:{session.voiceChannelId.slice(0, 6)}
        </span>
        {session.realtime?.provider && <span className="vm-card-provider">{session.realtime.provider}</span>}
      </div>
    </div>
  );
}
