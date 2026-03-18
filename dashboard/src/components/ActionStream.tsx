import React, { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Skeleton from "./Skeleton";
import { CopyButton, PanelHead } from "./ui";
import { normalizeFollowupPrompts, normalizePromptText } from "../utils/voiceHelpers";

const STORAGE_KEY = "actionStreamColWidths";
const COLUMNS = ["time", "kind", "channel", "content", "cost"] as const;
const DEFAULT_WIDTHS: Record<string, number> = {
  time: 210,
  kind: 196,
  channel: 210,
  content: 400,
  cost: 122,
};
const MIN_COL_WIDTH = 60;

function loadColWidths(): Record<string, number> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const result: Record<string, number> = {};
      for (const col of COLUMNS) {
        const v = parsed[col];
        result[col] = typeof v === "number" && v >= MIN_COL_WIDTH ? v : DEFAULT_WIDTHS[col];
      }
      return result;
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_WIDTHS };
}

function saveColWidths(widths: Record<string, number>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(widths));
  } catch { /* ignore */ }
}

const PRIMARY_PILLS = [
  "all",
  "sent_reply",
  "sent_message",
  "initiative_post",
  "llm_call",
  "reacted",
  "voice_session_start",
  "gif_call",
  "search_call",
] as const;

const ALL_FILTERS = [
  "all",
  "sent_reply",
  "sent_message",
  "initiative_post",
  "reply_skipped",
  "reacted",
  "llm_call",
  "image_call",
  "gif_call",
  "gif_error",
  "search_call",
  "search_error",
  "video_context_call",
  "video_context_error",
  "asr_call",
  "asr_error",
  "voice_session_start",
  "voice_session_end",
  "voice_intent_detected",
  "voice_turn_in",
  "voice_turn_out",
  "voice_soundboard_play",
  "voice_runtime",
  "voice_error",
  "bot_runtime",
  "bot_error"
];

const OVERFLOW_FILTERS = ALL_FILTERS.filter(
  (f) => !(PRIMARY_PILLS as readonly string[]).includes(f)
);

function getReplyPrompts(metadata: unknown) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const candidate = (metadata as { replyPrompts?: unknown }).replyPrompts;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  return candidate as {
    hiddenByDefault?: unknown;
    systemPrompt?: unknown;
    initialUserPrompt?: unknown;
    followupUserPrompts?: unknown;
    followupSteps?: unknown;
  };
}

function withoutReplyPrompts(metadata: unknown) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return metadata;
  const { replyPrompts: _replyPrompts, ...rest } = metadata as Record<string, unknown>;
  return rest;
}

function ToolBadges({ metadata }: { metadata: unknown }) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const m = metadata as Record<string, unknown>;
  const badges: { label: string; cls: string }[] = [];

  const webSearchUsed = Boolean((m.webSearch as Record<string, unknown>)?.used);
  const memoryUsed = Boolean(
    (m.memory as Record<string, unknown>)?.saved ||
    (m.memory as Record<string, unknown>)?.lookupUsed
  );
  const imageUsed = Boolean((m.imageLookup as Record<string, unknown>)?.used);
  const gifUsed = Boolean((m.gif as Record<string, unknown>)?.used);
  const videoUsed = Boolean((m.video as Record<string, unknown>)?.used);

  const llm = (m.llm || {}) as Record<string, unknown>;

  if (webSearchUsed) badges.push({ label: "Web Search", cls: "as-tool-badge-web" });
  else if (llm.usedWebSearchFollowup) badges.push({ label: "Web Followup", cls: "as-tool-badge-web" });

  if (memoryUsed) badges.push({ label: "Memory", cls: "as-tool-badge-memory" });
  else if (llm.usedMemoryLookupFollowup) badges.push({ label: "Memory Followup", cls: "as-tool-badge-memory" });

  if (imageUsed) badges.push({ label: "Image", cls: "as-tool-badge-image" });
  else if (llm.usedImageLookupFollowup) badges.push({ label: "Image Followup", cls: "as-tool-badge-image" });

  if (gifUsed) badges.push({ label: "GIF", cls: "as-tool-badge-gif" });
  if (videoUsed) badges.push({ label: "Video", cls: "as-tool-badge-video" });

  if (badges.length === 0) return null;
  return (
    <span className="as-tool-badges">
      {badges.map((b) => (
        <span key={b.label} className={`as-tool-badge ${b.cls}`}>{b.label}</span>
      ))}
    </span>
  );
}

export default function ActionStream({ actions }) {
  const [filter, setFilter] = useState("all");
  const [expandedRowKey, setExpandedRowKey] = useState("");
  const [colWidths, setColWidths] = useState(loadColWidths);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ col: string; startX: number; startW: number } | null>(null);

  // Close overflow dropdown on outside click
  useEffect(() => {
    if (!moreOpen) return;
    function handleClick(e: MouseEvent) {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) {
        setMoreOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [moreOpen]);

  const onResizeStart = useCallback((col: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = colWidths[col];
    dragRef.current = { col, startX, startW };

    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const delta = ev.clientX - dragRef.current.startX;
      const newW = Math.max(MIN_COL_WIDTH, dragRef.current.startW + delta);
      setColWidths((prev) => {
        const next = { ...prev, [dragRef.current!.col]: newW };
        return next;
      });
    };

    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setColWidths((prev) => {
        saveColWidths(prev);
        return prev;
      });
      dragRef.current = null;
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [colWidths]);

  const rows = useMemo(
    () => (filter === "all" ? actions : actions.filter((a) => a.kind === filter)),
    [actions, filter]
  );

  const usedWebSearchFollowup = (action) => Boolean(action?.metadata?.llm?.usedWebSearchFollowup);
  const getRowKey = (action, index) => String(action?.id ?? `${action?.created_at || "unknown"}-${index}`);

  const toggleRow = (rowKey) => {
    setExpandedRowKey((current) => (current === rowKey ? "" : rowKey));
  };

  const toPrettyJson = (value) => {
    if (value === null || value === undefined || value === "") return "(none)";
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  };

  const formatMetaValue = (value) => {
    if (value === null || value === undefined || value === "") return "-";
    return String(value);
  };

  if (!actions || actions.length === 0) {
    return (
      <section className="panel">
        <PanelHead title="Action Stream" />
        {actions === undefined || actions === null ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {[0, 1, 2, 3].map((i) => (
              <div key={i}>
                <Skeleton height="32px" />
              </div>
            ))}
          </div>
        ) : (
          <p style={{ color: "var(--ink-3)", fontSize: "0.84rem" }}>No actions yet</p>
        )}
      </section>
    );
  }

  return (
    <section className="panel">
      <PanelHead title="Action Stream" />

      <div className="filter-pills">
        {PRIMARY_PILLS.map((f) => (
          <button
            key={f}
            type="button"
            className={`filter-pill${filter === f ? " active" : ""}`}
            onClick={() => setFilter(f)}
          >
            {f === "all" ? "All" : f}
          </button>
        ))}
        <div className="filter-more-wrap" ref={moreRef}>
          <button
            type="button"
            className={`filter-pill${OVERFLOW_FILTERS.includes(filter) ? " active" : ""}`}
            onClick={() => setMoreOpen((v) => !v)}
          >
            More &#x25BE;
          </button>
          {moreOpen && (
            <div className="filter-dropdown">
              {OVERFLOW_FILTERS.map((f) => (
                <button
                  key={f}
                  type="button"
                  className={`filter-dropdown-item${filter === f ? " active" : ""}`}
                  onClick={() => { setFilter(f); setMoreOpen(false); }}
                >
                  {f}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="table-wrap">
        <table className="action-table">
          <colgroup>
            {COLUMNS.map((col) => (
              <col key={col} className={`col-${col}`} style={{ width: colWidths[col] }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {COLUMNS.map((col) => (
                <th key={col} className={`col-${col}`}>
                  <div className="th-resizable">
                    <span>{col === "content" ? "Content" : col.charAt(0).toUpperCase() + col.slice(1)}</span>
                    <div
                      className="col-resize-handle"
                      onMouseDown={(e) => onResizeStart(col, e)}
                      role="separator"
                      aria-orientation="vertical"
                    />
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((action, i) => {
              const rowKey = getRowKey(action, i);
              const isExpanded = expandedRowKey === rowKey;
              const replyPrompts = getReplyPrompts(action.metadata);
              const metadataWithoutPrompts = withoutReplyPrompts(action.metadata);
              const systemPrompt = normalizePromptText(replyPrompts?.systemPrompt);
              const initialUserPrompt = normalizePromptText(replyPrompts?.initialUserPrompt);
              const followupUserPrompts = normalizeFollowupPrompts(replyPrompts?.followupUserPrompts);
              const followupSteps = Math.max(0, Math.floor(Number(replyPrompts?.followupSteps) || 0));
              const hasPromptLog = Boolean(replyPrompts);

              return (
                <Fragment key={rowKey}>
                  <tr
                    className={`action-row${isExpanded ? " action-row-expanded" : ""}`}
                    onClick={() => toggleRow(rowKey)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        toggleRow(rowKey);
                      }
                    }}
                    tabIndex={0}
                    aria-expanded={isExpanded}
                  >
                    <td className="action-time-cell col-time">
                      <span className="action-time-inner">
                        <span className={`expand-indicator${isExpanded ? " open" : ""}`} aria-hidden="true">
                          &#x25B8;
                        </span>
                        {new Date(action.created_at).toLocaleString()}
                      </span>
                    </td>
                    <td className="col-kind">
                      <span className={`kind-badge kind-${action.kind}`}>
                        {action.kind}
                      </span>
                      {usedWebSearchFollowup(action) && (
                        <span className="kind-badge kind-web-followup">web-followup</span>
                      )}
                    </td>
                    <td className="col-channel">{action.channel_id || "-"}</td>
                    <td className="col-content">
                      {String(action.content || "").slice(0, 180) || "-"}
                      <ToolBadges metadata={action.metadata} />
                    </td>
                    <td className="col-cost">${Number(action.usd_cost || 0).toFixed(6)}</td>
                  </tr>
                  {isExpanded && (
                    <tr className="action-detail-row">
                      <td colSpan={5}>
                        <div className="action-detail">
                          <div className="action-detail-grid">
                            <p>
                              <span>Event ID</span>
                              <code>{formatMetaValue(action.id)}</code>
                              {action.id && <CopyButton text={String(action.id)} />}
                            </p>
                            <p>
                              <span>Guild</span>
                              <code>{formatMetaValue(action.guild_id)}</code>
                              {action.guild_id && <CopyButton text={String(action.guild_id)} />}
                            </p>
                            <p>
                              <span>Channel</span>
                              <code>{formatMetaValue(action.channel_id)}</code>
                              {action.channel_id && <CopyButton text={String(action.channel_id)} />}
                            </p>
                            <p>
                              <span>User</span>
                              <code>{formatMetaValue(action.user_id)}</code>
                              {action.user_id && <CopyButton text={String(action.user_id)} />}
                            </p>
                            <p>
                              <span>Message</span>
                              <code>{formatMetaValue(action.message_id)}</code>
                              {action.message_id && <CopyButton text={String(action.message_id)} />}
                            </p>
                            <p><span>Cost</span><code>${Number(action.usd_cost || 0).toFixed(6)}</code></p>
                          </div>

                          <div className="action-detail-block">
                            <h4>Content</h4>
                            <pre>{String(action.content || "(empty)")}</pre>
                          </div>

                          <div className="action-detail-block">
                            <h4>Metadata</h4>
                            <pre>{toPrettyJson(metadataWithoutPrompts)}</pre>
                          </div>

                          {hasPromptLog && (
                            <details className="action-detail-block">
                              <summary>Prompt log (hidden by default)</summary>
                              <div className="action-detail-block">
                                <h4>System Prompt</h4>
                                <pre>{systemPrompt || "(empty)"}</pre>
                              </div>
                              <div className="action-detail-block">
                                <h4>Initial User Prompt</h4>
                                <pre>{initialUserPrompt || "(empty)"}</pre>
                              </div>
                              <div className="action-detail-block">
                                <h4>Follow-up User Prompts ({Math.max(followupSteps, followupUserPrompts.length)})</h4>
                                {followupUserPrompts.length === 0 ? (
                                  <pre>(none)</pre>
                                ) : (
                                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                                    {followupUserPrompts.map((prompt, index) => (
                                      <div key={`${rowKey}-followup-${index}`}>
                                        <h4>Step {index + 1}</h4>
                                        <pre>{prompt || "(empty)"}</pre>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            </details>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} style={{ textAlign: "center", color: "var(--ink-3)" }}>
                  No actions match filter
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
