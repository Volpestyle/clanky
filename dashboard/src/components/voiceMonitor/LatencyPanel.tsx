import type { LatencyTurnEntry, SessionLatency } from "../../hooks/useVoiceSSE";
import { Section } from "../ui";
import { LATENCY_STAGES, Stat } from "./shared";

export function LatencyPanel({ latency }: { latency: SessionLatency }) {
  if (!latency || latency.recentTurns.length === 0) return null;

  const { averages, turnCount } = latency;

  return (
    <Section
      title="Pipeline Latency"
      badge={`${turnCount} turn${turnCount !== 1 ? "s" : ""}`}
      defaultOpen={false}
    >
      <div className="vm-detail-grid">
        {LATENCY_STAGES.map((s) => {
          const val = averages[s.key];
          return val != null ? <Stat key={s.key} label={`Avg ${s.label}`} value={`${val}ms`} /> : null;
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

export function InlineLatencyBar({ entry }: { entry: LatencyTurnEntry }) {
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
