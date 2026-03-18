import { useEffect, useMemo, useState } from "react";
import type { LatencyTurnEntry, VoiceSession } from "../../hooks/useVoiceSSE";
import { Section } from "../ui";
import { InlineLatencyBar } from "./LatencyPanel";
import { matchLatencyToTurns, relativeTime } from "./shared";

export function ConversationContext({
  session,
  latencyTurns
}: {
  session: VoiceSession;
  latencyTurns: LatencyTurnEntry[];
}) {
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
          <span>
            gen {generationSentTurns}/{generationAvailableTurns || 0} | dec {deciderSentTurns}/
            {deciderAvailableTurns || 0}
          </span>
          <span>
            tracked {trackedTurns}
            {trackedTurnLimit > 0 ? `/${trackedTurnLimit}` : ""} / transcript {trackedTranscriptTurns}
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
