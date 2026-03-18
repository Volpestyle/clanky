import { PanelHead } from "./ui";
const PHASE_ROWS = [
  { key: "queueMs", label: "Queue" },
  { key: "ingestMs", label: "Ingest" },
  { key: "memorySliceMs", label: "Memory Slice" },
  { key: "llm1Ms", label: "LLM #1" },
  { key: "followupMs", label: "Follow-up" },
  { key: "typingDelayMs", label: "Typing Delay" },
  { key: "sendMs", label: "Send" }
];

export default function PerformancePanel({ performance }) {
  const sampleCount = Number(performance?.sampleCount || 0);
  const total = performance?.totalMs || {};
  const processing = performance?.processingMs || {};
  const phases = performance?.phases || {};
  const byKind = performance?.byKind || {};

  return (
    <section className="panel performance-panel">
      <PanelHead title="Reply Latency (24h)">
        <span className="performance-samples">
          samples: {sampleCount}
        </span>
      </PanelHead>

      {sampleCount <= 0 ? (
        <p className="cost-empty">No timing samples yet. Trigger a few replies to populate p50/p95.</p>
      ) : (
        <>
          <div className="performance-summary-grid">
            <article className="performance-card">
              <p className="label">Total p50</p>
              <p className="value">{formatMs(total.p50Ms)}</p>
            </article>
            <article className="performance-card">
              <p className="label">Total p95</p>
              <p className="value">{formatMs(total.p95Ms)}</p>
            </article>
            <article className="performance-card">
              <p className="label">Processing p50</p>
              <p className="value">{formatMs(processing.p50Ms)}</p>
            </article>
            <article className="performance-card">
              <p className="label">Processing p95</p>
              <p className="value">{formatMs(processing.p95Ms)}</p>
            </article>
          </div>

          <div className="performance-row-meta">
            <span>Replies: {Number(byKind.sent_reply || 0)}</span>
            <span>Standalone: {Number(byKind.sent_message || 0)}</span>
            <span>Skipped: {Number(byKind.reply_skipped || 0)}</span>
          </div>

          <div className="performance-phase-table">
            <div className="performance-phase-header">
              <span>Phase</span>
              <span>p50</span>
              <span>p95</span>
              <span>avg</span>
              <span>n</span>
            </div>
            {PHASE_ROWS.map((row) => {
              const metric = phases?.[row.key] || {};
              return (
                <div key={row.key} className="performance-phase-row">
                  <span>{row.label}</span>
                  <span>{formatMs(metric.p50Ms)}</span>
                  <span>{formatMs(metric.p95Ms)}</span>
                  <span>{formatMs(metric.avgMs)}</span>
                  <span>{Number(metric.count || 0)}</span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}

function formatMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return "-";
  if (parsed < 1) return "<1ms";
  return `${Math.round(parsed)}ms`;
}
