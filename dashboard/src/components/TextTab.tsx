import { useState, useMemo } from "react";

// ---- Types ----

type ActivityAction = {
  id?: number;
  created_at?: string;
  guild_id?: string;
  channel_id?: string;
  message_id?: string;
  user_id?: string;
  usd_cost?: number;
  kind?: string;
  content?: string;
  metadata?: unknown;
};

type Addressing = {
  triggered?: boolean;
  reason?: string;
  confidence?: number;
  threshold?: number;
  confidenceSource?: string;
  direct?: boolean;
  inferred?: boolean;
};

type Performance = {
  totalMs?: number | null;
  queueMs?: number | null;
  processingMs?: number | null;
  ingestMs?: number | null;
  memorySliceMs?: number | null;
  llm1Ms?: number | null;
  followupMs?: number | null;
  typingDelayMs?: number | null;
  sendMs?: number | null;
};

type LLMInfo = {
  provider?: string;
  model?: string;
  costUsd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  usedWebSearchFollowup?: boolean;
  usedMemoryLookupFollowup?: boolean;
  usedImageLookupFollowup?: boolean;
};

type ReplyPrompts = {
  systemPrompt?: string;
  initialUserPrompt?: string;
  followupUserPrompts?: string[];
  followupSteps?: number;
};

// ---- Helpers ----

function safeRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function getCardKey(action: ActivityAction, index: number): string {
  return String(action.id ?? `${action.created_at || "u"}-${index}`);
}

// ---- CopyButton ----

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  function copy(e: React.MouseEvent) {
    e.stopPropagation();
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <button type="button" className="tt-copy-btn" onClick={copy} title="Copy to clipboard">
      {copied ? "\u2713 Copied" : "Copy"}
    </button>
  );
}

// ---- Section (collapsible) ----

function Section({ title, badge, children, defaultOpen = false }: {
  title: string;
  badge?: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="tt-section">
      <button
        type="button"
        className="tt-section-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className={`tt-section-arrow${open ? " tt-section-arrow-open" : ""}`}>&#x25B8;</span>
        <span className="tt-section-title">{title}</span>
        {badge && <span className="tt-section-badge">{badge}</span>}
      </button>
      {open && <div className="tt-section-body">{children}</div>}
    </div>
  );
}

// ---- AddressingRow ----

function AddressingRow({ addressing }: { addressing: Addressing }) {
  const triggered = addressing.triggered ?? false;
  const reason = addressing.reason || "-";
  const confidence = num(addressing.confidence);
  const threshold = num(addressing.threshold);

  return (
    <div className="tt-addressing">
      <span className="tt-addressing-label">ADDRESSING</span>
      <span className={`tt-addressing-status ${triggered ? "tt-addressing-triggered" : "tt-addressing-skipped"}`}>
        {triggered ? "triggered" : "skipped"}
      </span>
      <span className="tt-addressing-detail">reason: {reason}</span>
      <span className="tt-addressing-detail">
        confidence: {confidence.toFixed(2)}/{threshold.toFixed(2)}
      </span>
      {addressing.confidenceSource && (
        <span className="tt-addressing-detail">source: {addressing.confidenceSource}</span>
      )}
    </div>
  );
}

// ---- ToolCallsSection ----

function ToolCallsSection({ metadata }: { metadata: Record<string, unknown> }) {
  const tools: { label: string; cls: string; details: string }[] = [];

  const webSearch = safeRecord(metadata.webSearch);
  const memory = safeRecord(metadata.memory);
  const imageLookup = safeRecord(metadata.imageLookup);
  const gif = safeRecord(metadata.gif);
  const video = safeRecord(metadata.video);
  const llm = safeRecord(metadata.llm) as LLMInfo;

  const webSearchResults: { title: string; url: string; domain: string }[] =
    Array.isArray(webSearch.results) ? webSearch.results : [];

  const memoryResults: { fact: string; fact_type: string; subject: string; confidence: number }[] =
    Array.isArray(memory.results) ? memory.results : [];

  const imageLookupResults: { filename: string; authorName: string; url: string; matchReason: string }[] =
    Array.isArray(imageLookup.results) ? imageLookup.results : [];

  const videoResults: { title: string; url: string; provider: string; channel: string }[] =
    Array.isArray(video.videos) ? video.videos : [];

  if (webSearch.used) {
    const query = String(webSearch.query || "");
    const results = num(webSearch.resultCount);
    const pages = num(webSearch.fetchedPages);
    tools.push({
      label: "Web Search",
      cls: "tt-tool-web",
      details: `query: "${query.slice(0, 60)}" \u2014 ${results} result${results !== 1 ? "s" : ""}, ${pages} page${pages !== 1 ? "s" : ""}`
    });
  } else if (llm.usedWebSearchFollowup) {
    tools.push({ label: "Web Followup", cls: "tt-tool-web", details: "followup search used" });
  }

  if (memory.saved || memory.toolCallsUsed) {
    const parts: string[] = [];
    if (memory.toolCallsUsed) {
      const query = String(memory.query || "");
      parts.push(query ? `query: "${query.slice(0, 40)}"` : "lookup used");
      if (memoryResults.length) parts.push(`${memoryResults.length} fact${memoryResults.length !== 1 ? "s" : ""}`);
    }
    if (memory.saved) parts.push("fact saved");
    tools.push({ label: "Memory", cls: "tt-tool-memory", details: parts.join(" \u2014 ") });
  } else if (llm.usedMemoryLookupFollowup) {
    tools.push({ label: "Memory Followup", cls: "tt-tool-memory", details: "followup lookup used" });
  }

  if (imageLookup.used) {
    const query = String(imageLookup.query || "");
    const count = num(imageLookup.resultCount);
    tools.push({
      label: "Image Lookup",
      cls: "tt-tool-image",
      details: `query: "${query.slice(0, 40)}" \u2014 ${count} result${count !== 1 ? "s" : ""}`
    });
  } else if (llm.usedImageLookupFollowup) {
    tools.push({ label: "Image Followup", cls: "tt-tool-image", details: "followup used" });
  }

  if (gif.used) {
    tools.push({ label: "GIF", cls: "tt-tool-gif", details: "generated" });
  }
  if (video.used) {
    const fetched = num(video.fetchedVideos);
    const keyframes = num(video.extractedKeyframes);
    tools.push({
      label: "Video",
      cls: "tt-tool-video",
      details: `${fetched} fetched, ${keyframes} keyframe${keyframes !== 1 ? "s" : ""}`
    });
  }

  if (tools.length === 0) return null;

  return (
    <Section title="TOOLS USED" badge={String(tools.length)}>
      <div className="tt-tools-grid">
        {tools.map((t) => (
          <div key={t.label} className={`tt-tool-card ${t.cls}`}>
            <span className="tt-tool-label">{t.label}</span>
            <span className="tt-tool-details">{t.details}</span>
          </div>
        ))}
      </div>
      {webSearchResults.length > 0 && (
        <div className="tt-tool-results tt-tool-results-web">
          {webSearchResults.map((r, i) => (
            <a key={i} className="tt-tool-result-row" href={r.url} target="_blank" rel="noopener noreferrer">
              <span className="tt-tool-result-badge">{r.domain}</span>
              <span className="tt-tool-result-text">{r.title}</span>
            </a>
          ))}
        </div>
      )}
      {memoryResults.length > 0 && (
        <div className="tt-tool-results tt-tool-results-memory">
          {memoryResults.map((r, i) => (
            <div key={i} className="tt-tool-result-row">
              <span className="tt-tool-result-badge">{r.fact_type || "fact"}</span>
              <span className="tt-tool-result-text">
                {r.subject ? <strong>{r.subject}:</strong> : null} {r.fact}
              </span>
              {r.confidence != null && (
                <span className="tt-tool-result-meta">{Number(r.confidence).toFixed(2)}</span>
              )}
            </div>
          ))}
        </div>
      )}
      {imageLookupResults.length > 0 && (
        <div className="tt-tool-results tt-tool-results-image">
          {imageLookupResults.map((r, i) => (
            <div key={i} className="tt-tool-result-row">
              <span className="tt-tool-result-badge">{r.authorName || "unknown"}</span>
              <span className="tt-tool-result-text">{r.filename || "(unnamed)"}</span>
              {r.matchReason && (
                <span className="tt-tool-result-meta">{r.matchReason}</span>
              )}
            </div>
          ))}
        </div>
      )}
      {videoResults.length > 0 && (
        <div className="tt-tool-results tt-tool-results-video">
          {videoResults.map((r, i) => (
            <div key={i} className="tt-tool-result-row">
              <span className="tt-tool-result-badge">{r.provider || "video"}</span>
              {r.url ? (
                <a className="tt-tool-result-text tt-tool-result-link" href={r.url} target="_blank" rel="noopener noreferrer">
                  {r.title || "(untitled)"}
                </a>
              ) : (
                <span className="tt-tool-result-text">{r.title || "(untitled)"}</span>
              )}
              {r.channel && (
                <span className="tt-tool-result-meta">{r.channel}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

// ---- PerformanceSection ----

const PERF_SEGMENTS: { key: keyof Performance; label: string; color: string }[] = [
  { key: "queueMs", label: "Queue", color: "rgba(251,191,36,0.6)" },
  { key: "ingestMs", label: "Ingest", color: "rgba(96,165,250,0.6)" },
  { key: "memorySliceMs", label: "Memory", color: "rgba(168,130,255,0.6)" },
  { key: "llm1Ms", label: "LLM", color: "rgba(74,222,128,0.6)" },
  { key: "followupMs", label: "Followup", color: "rgba(147,130,255,0.6)" },
  { key: "typingDelayMs", label: "Typing", color: "rgba(255,255,255,0.15)" },
  { key: "sendMs", label: "Send", color: "rgba(251,146,60,0.6)" },
];

function PerformanceSection({ perf }: { perf: Performance }) {
  const total = num(perf.totalMs);
  if (total <= 0) return null;

  const segments = PERF_SEGMENTS
    .map((s) => ({ ...s, ms: num(perf[s.key]) }))
    .filter((s) => s.ms > 0);

  const segmentTotal = segments.reduce((sum, s) => sum + s.ms, 0);

  return (
    <Section title="PERFORMANCE" badge={`${total}ms`}>
      <div className="tt-perf">
        {segmentTotal > 0 && (
          <div className="tt-perf-bar">
            {segments.map((s) => (
              <div
                key={s.key}
                className="tt-perf-segment"
                style={{ flex: s.ms / segmentTotal, background: s.color }}
                title={`${s.label}: ${s.ms}ms`}
              />
            ))}
          </div>
        )}
        <div className="tt-perf-legend">
          {segments.map((s) => (
            <div key={s.key} className="tt-perf-legend-item">
              <span className="tt-perf-legend-swatch" style={{ background: s.color }} />
              <span className="tt-perf-legend-label">{s.label}</span>
              <span className="tt-perf-legend-value">{s.ms}ms</span>
            </div>
          ))}
        </div>
        <div className="tt-perf-stats">
          <div className="tt-perf-stat">
            <span className="tt-perf-stat-label">Total</span>
            <span className="tt-perf-stat-value">{total}ms</span>
          </div>
          {num(perf.processingMs) > 0 && (
            <div className="tt-perf-stat">
              <span className="tt-perf-stat-label">Processing</span>
              <span className="tt-perf-stat-value">{num(perf.processingMs)}ms</span>
            </div>
          )}
        </div>
      </div>
    </Section>
  );
}

// ---- PromptBreakdownSection ----

function PromptBreakdownSection({ prompts }: { prompts: ReplyPrompts }) {
  const system = prompts.systemPrompt || "";
  const user = prompts.initialUserPrompt || "";
  const followups = Array.isArray(prompts.followupUserPrompts) ? prompts.followupUserPrompts : [];
  const steps = Math.max(0, Math.floor(Number(prompts.followupSteps) || 0));

  if (!system && !user && followups.length === 0) return null;

  return (
    <Section title="PROMPTS">
      {system && (
        <div className="tt-prompt-block">
          <div className="tt-prompt-header">
            <span className="tt-prompt-label">SYSTEM PROMPT</span>
            <CopyButton text={system} />
          </div>
          <pre className="tt-prompt-pre">{system}</pre>
        </div>
      )}
      {user && (
        <div className="tt-prompt-block">
          <div className="tt-prompt-header">
            <span className="tt-prompt-label">USER PROMPT</span>
            <CopyButton text={user} />
          </div>
          <pre className="tt-prompt-pre">{user}</pre>
        </div>
      )}
      {followups.length > 0 && (
        <div className="tt-prompt-block">
          <div className="tt-prompt-header">
            <span className="tt-prompt-label">FOLLOWUP PROMPTS ({Math.max(steps, followups.length)})</span>
          </div>
          {followups.map((prompt, i) => (
            <div key={i} className="tt-prompt-followup">
              <div className="tt-prompt-header">
                <span className="tt-prompt-label-sm">Step {i + 1}</span>
                <CopyButton text={String(prompt || "")} />
              </div>
              <pre className="tt-prompt-pre">{String(prompt || "(empty)")}</pre>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

// ---- FullMetadataSection ----

function FullMetadataSection({ metadata }: { metadata: Record<string, unknown> }) {
  const { replyPrompts: _rp, ...rest } = metadata;
  const json = JSON.stringify(rest, null, 2);

  return (
    <Section title="FULL METADATA">
      <div className="tt-meta-block">
        <div className="tt-meta-header">
          <CopyButton text={json} />
        </div>
        <pre className="tt-prompt-pre">{json}</pre>
      </div>
    </Section>
  );
}

// ---- TextMessageCard ----

function TextMessageCard({ action }: { action: ActivityAction }) {
  const metadata = safeRecord(action.metadata);
  const addressing = safeRecord(metadata.addressing) as Addressing;
  const perf = safeRecord(metadata.performance) as Performance;
  const llm = safeRecord(metadata.llm) as LLMInfo;
  const replyPrompts = safeRecord(metadata.replyPrompts) as ReplyPrompts;
  const hasPrompts = Boolean(replyPrompts.systemPrompt || replyPrompts.initialUserPrompt);
  const hasPerf = num(perf.totalMs) > 0;
  const cost = num(action.usd_cost);
  const model = llm.model || llm.provider || "-";
  const content = String(action.content || "");

  const kindLabel = action.kind === "sent_reply" ? "sent_reply" : "sent_message";
  const kindCls = action.kind === "sent_reply" ? "tt-kind-reply" : "tt-kind-message";

  const timestamp = action.created_at
    ? new Date(action.created_at).toLocaleString(undefined, {
        month: "short", day: "numeric", hour: "numeric", minute: "2-digit"
      })
    : "-";

  const tokenInfo = llm.usage
    ? `${num(llm.usage.input_tokens).toLocaleString()}in / ${num(llm.usage.output_tokens).toLocaleString()}out`
    : null;

  return (
    <div className="tt-card">
      {/* Header */}
      <div className="tt-card-header">
        <span className={`tt-kind-badge ${kindCls}`}>{kindLabel}</span>
        <span className="tt-header-time">{timestamp}</span>
        {action.channel_id && <span className="tt-header-channel">#{action.channel_id}</span>}
        <span className="tt-header-model">{model}</span>
        {tokenInfo && <span className="tt-header-tokens">{tokenInfo}</span>}
        <span className="tt-header-cost">${cost.toFixed(4)}</span>
      </div>

      {/* Content preview */}
      <div className="tt-card-content">
        <p className="tt-content-text">{content || "(empty)"}</p>
      </div>

      {/* Addressing */}
      {addressing.triggered !== undefined && <AddressingRow addressing={addressing} />}

      {/* Tool calls */}
      <ToolCallsSection metadata={metadata} />

      {/* Performance */}
      {hasPerf && <PerformanceSection perf={perf} />}

      {/* Prompts */}
      {hasPrompts && <PromptBreakdownSection prompts={replyPrompts} />}

      {/* Full metadata */}
      <FullMetadataSection metadata={metadata} />
    </div>
  );
}

// ---- TextTab (main) ----

export default function TextTab({ actions }: { actions: ActivityAction[] }) {
  const textActions = useMemo(
    () => actions.filter((a) => a.kind === "sent_reply" || a.kind === "sent_message"),
    [actions]
  );

  if (textActions.length === 0) {
    return (
      <section className="tt-container">
        <div className="tt-empty">
          <span className="tt-empty-icon">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          </span>
          <p>No text messages yet</p>
        </div>
      </section>
    );
  }

  return (
    <section className="tt-container">
      <div className="tt-header-bar">
        <span className="tt-header-bar-label">TEXT MESSAGES</span>
        <span className="tt-header-bar-count">{textActions.length}</span>
      </div>
      <div className="tt-feed">
        {textActions.map((action, i) => (
          <TextMessageCard key={getCardKey(action, i)} action={action} />
        ))}
      </div>
    </section>
  );
}
