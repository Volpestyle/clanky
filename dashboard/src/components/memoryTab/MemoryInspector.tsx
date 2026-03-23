import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../api";
import { useDashboardGuildScope } from "../../guildScope";

interface SubjectRow {
  scope: "user" | "guild" | "owner";
  guild_id: string;
  user_id?: string | null;
  subject: string;
  last_seen_at: string;
  fact_count: number;
}

interface FactRow {
  id: number;
  created_at: string;
  updated_at: string;
  scope?: "user" | "guild" | "owner";
  guild_id: string;
  channel_id: string | null;
  user_id?: string | null;
  subject: string;
  fact: string;
  fact_type: string;
  evidence_text: string | null;
  source_message_id: string | null;
  confidence: number;
  metadata?: {
    isLegacy?: boolean;
  };
}

interface FactEditorState {
  subject: string;
  factType: string;
  fact: string;
  evidenceText: string;
  confidencePercent: string;
}

interface Props {
  onMemoryMutated?: () => void;
}

type StatusState = {
  text: string;
  tone: "error" | "info";
} | null;

type FactMutationResponse = {
  ok: boolean;
  fact?: FactRow;
  deleted?: number;
};

const FACT_TYPE_OPTIONS = [
  "preference",
  "profile",
  "relationship",
  "project",
  "guidance",
  "behavioral",
  "other"
] as const;

function timeAgo(isoDate: string): string {
  const ms = Date.now() - new Date(isoDate).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatTimestamp(value: string | null | undefined) {
  const raw = String(value || "").trim();
  if (!raw) return "unknown time";
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return raw;
  return parsed.toLocaleString();
}

function buildEditorState(fact: FactRow): FactEditorState {
  return {
    subject: String(fact.subject || ""),
    factType: String(fact.fact_type || "other"),
    fact: String(fact.fact || ""),
    evidenceText: String(fact.evidence_text || ""),
    confidencePercent: String(Math.round(Number(fact.confidence || 0) * 100))
  };
}

function normalizeFactEditorText(value: string, maxChars: number) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}

function normalizeConfidencePercent(value: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.min(100, Math.round(parsed)));
}

function formatApiError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const jsonMatch = message.match(/^API\s+\d+:\s+([\s\S]+)$/u);
  if (!jsonMatch) return message;
  try {
    const parsed = JSON.parse(jsonMatch[1]) as { error?: unknown };
    const normalized = String(parsed?.error || "").trim();
    if (!normalized) return message;
    return normalized.replace(/_/g, " ");
  } catch {
    return message;
  }
}

function getScopeLabel(scope: string | null | undefined, subject?: string | null) {
  if (subject === "__lore__") return "community";
  if (subject === "__self__") return "self";
  if (subject === "__owner__" || scope === "owner") return "owner private";
  if (scope === "user") return "person";
  if (scope === "guild") return "community";
  return "memory";
}

function getSubjectLabel(subject: string | null | undefined) {
  if (subject === "__lore__") return "Community";
  if (subject === "__self__") return "Clanky";
  if (subject === "__owner__") return "Owner Private";
  return String(subject || "").trim() || "unknown subject";
}

export default function MemoryInspector({ onMemoryMutated }: Props) {
  const { selectedGuildId } = useDashboardGuildScope();
  const [subjects, setSubjects] = useState<SubjectRow[]>([]);
  const [selectedSubject, setSelectedSubject] = useState<string | null>(null);
  const [facts, setFacts] = useState<FactRow[]>([]);
  const [subjectFilter, setSubjectFilter] = useState("");
  const [factQuery, setFactQuery] = useState("");
  const [loadingSubjects, setLoadingSubjects] = useState(false);
  const [loadingFacts, setLoadingFacts] = useState(false);
  const [status, setStatus] = useState<StatusState>(null);
  const [factLimit, setFactLimit] = useState(120);
  const [expandedFactId, setExpandedFactId] = useState<number | null>(null);
  const [editor, setEditor] = useState<FactEditorState | null>(null);
  const [savingFactId, setSavingFactId] = useState<number | null>(null);
  const [deletingFactId, setDeletingFactId] = useState<number | null>(null);

  const loadSubjects = useCallback(async () => {
    if (!selectedGuildId) return;
    setLoadingSubjects(true);
    setStatus(null);
    try {
      const data = await api<{ subjects: SubjectRow[] }>(
        `/api/memory/subjects?guildId=${encodeURIComponent(selectedGuildId)}&limit=300`
      );
      setSubjects(Array.isArray(data.subjects) ? data.subjects : []);
    } catch (error: unknown) {
      setSubjects([]);
      setStatus({
        text: formatApiError(error),
        tone: "error"
      });
    } finally {
      setLoadingSubjects(false);
    }
  }, [selectedGuildId]);

  const loadFacts = useCallback(async (subject: string | null) => {
    if (!selectedGuildId) return;
    setLoadingFacts(true);
    setStatus(null);
    try {
      const params = new URLSearchParams({ guildId: selectedGuildId, limit: String(factLimit) });
      if (subject) params.set("subject", subject);
      if (factQuery.trim()) params.set("q", factQuery.trim());
      const data = await api<{ facts: FactRow[] }>(`/api/memory/facts?${params}`);
      setFacts(Array.isArray(data.facts) ? data.facts : []);
    } catch (error: unknown) {
      setFacts([]);
      setStatus({
        text: formatApiError(error),
        tone: "error"
      });
    } finally {
      setLoadingFacts(false);
    }
  }, [factLimit, factQuery, selectedGuildId]);

  const refreshInspector = useCallback(async (subjectOverride: string | null = selectedSubject) => {
    await Promise.all([loadSubjects(), loadFacts(subjectOverride)]);
  }, [loadFacts, loadSubjects, selectedSubject]);

  useEffect(() => {
    if (!selectedGuildId) return;
    setSelectedSubject(null);
    setFacts([]);
    setExpandedFactId(null);
    setEditor(null);
    setStatus(null);
    void loadSubjects();
  }, [loadSubjects, selectedGuildId]);

  useEffect(() => {
    if (!selectedGuildId) return;
    void loadFacts(selectedSubject);
  }, [loadFacts, selectedGuildId, selectedSubject]);

  useEffect(() => {
    if (expandedFactId === null) {
      setEditor(null);
      return;
    }
    if (facts.some((fact) => fact.id === expandedFactId)) return;
    setExpandedFactId(null);
    setEditor(null);
  }, [expandedFactId, facts]);

  const filteredSubjects = useMemo(() => {
    const query = subjectFilter.trim().toLowerCase();
    if (!query) return subjects;
    return subjects.filter((subject) => String(subject.subject || "").toLowerCase().includes(query));
  }, [subjectFilter, subjects]);

  const totalFactCount = useMemo(
    () => subjects.reduce((sum, subject) => sum + Number(subject.fact_count || 0), 0),
    [subjects]
  );

  const handleToggleFact = useCallback((fact: FactRow) => {
    setStatus(null);
    setExpandedFactId((current) => {
      if (current === fact.id) {
        setEditor(null);
        return null;
      }
      setEditor(buildEditorState(fact));
      return fact.id;
    });
  }, []);

  const handleResetEditor = useCallback((fact: FactRow) => {
    setEditor(buildEditorState(fact));
    setStatus(null);
  }, []);

  const handleSaveFact = useCallback(async (fact: FactRow) => {
    if (!selectedGuildId || !editor) return;

    const normalizedSubject = normalizeFactEditorText(editor.subject, 120);
    const normalizedFact = normalizeFactEditorText(editor.fact, 400);
    const normalizedFactType = normalizeFactEditorText(editor.factType, 40).toLowerCase() || "other";
    const normalizedEvidenceText = normalizeFactEditorText(editor.evidenceText, 240);
    const confidencePercent = normalizeConfidencePercent(editor.confidencePercent);

    if (!normalizedSubject) {
      setStatus({ text: "subject required", tone: "error" });
      return;
    }
    if (!normalizedFact) {
      setStatus({ text: "fact required", tone: "error" });
      return;
    }
    if (confidencePercent === null) {
      setStatus({ text: "confidence must be a number from 0 to 100", tone: "error" });
      return;
    }

    setSavingFactId(fact.id);
    setStatus(null);
    try {
      await api<FactMutationResponse>(`/api/memory/facts/${encodeURIComponent(String(fact.id))}`, {
        method: "PUT",
        body: {
          guildId: selectedGuildId,
          subject: normalizedSubject,
          fact: normalizedFact,
          factType: normalizedFactType,
          evidenceText: normalizedEvidenceText,
          confidence: confidencePercent / 100
        }
      });

      setEditor({
        subject: normalizedSubject,
        factType: normalizedFactType,
        fact: normalizedFact,
        evidenceText: normalizedEvidenceText,
        confidencePercent: String(confidencePercent)
      });

      await refreshInspector(selectedSubject);
      if (selectedSubject && normalizedSubject !== selectedSubject) {
        setExpandedFactId(null);
        setEditor(null);
      }
      setStatus({ text: `Updated fact #${fact.id}.`, tone: "info" });
      onMemoryMutated?.();
    } catch (error: unknown) {
      setStatus({
        text: formatApiError(error),
        tone: "error"
      });
    } finally {
      setSavingFactId(null);
    }
  }, [editor, onMemoryMutated, refreshInspector, selectedGuildId, selectedSubject]);

  const handleDeleteFact = useCallback(async (fact: FactRow) => {
    if (!selectedGuildId) return;
    if (!globalThis.confirm(`Delete durable fact #${fact.id}?`)) return;

    setDeletingFactId(fact.id);
    setStatus(null);
    try {
      await api<FactMutationResponse>(`/api/memory/facts/${encodeURIComponent(String(fact.id))}`, {
        method: "DELETE",
        body: {
          guildId: selectedGuildId
        }
      });

      setExpandedFactId(null);
      setEditor(null);
      await refreshInspector(selectedSubject);
      setStatus({ text: `Deleted fact #${fact.id}.`, tone: "info" });
      onMemoryMutated?.();
    } catch (error: unknown) {
      setStatus({
        text: formatApiError(error),
        tone: "error"
      });
    } finally {
      setDeletingFactId(null);
    }
  }, [onMemoryMutated, refreshInspector, selectedGuildId, selectedSubject]);

  return (
    <div className="inspector-layout">
      <div className="inspector-toolbar">
        <div className="inspector-toolbar-right">
          <span className="inspector-stat">
            {loadingSubjects ? "Loading subjects..." : `${filteredSubjects.length} subjects`}
          </span>
          <span className="inspector-stat-sep" />
          <span className="inspector-stat">
            {loadingFacts ? "Loading facts..." : `${facts.length} visible`}
          </span>
          <span className="inspector-stat-sep" />
          <span className="inspector-stat">{totalFactCount} total facts</span>
        </div>
      </div>

      <p className="memory-reflection-copy">
        Browse canonical durable memory by person, community, and self. Snapshot markdown refreshes automatically after a
        save or delete.
      </p>

      {status ? (
        <p className={`memory-reflection-inline-status${status.tone === "error" ? " error" : ""}`} role="status">
          {status.text}
        </p>
      ) : null}

      <div className="inspector-body">
        <aside className="inspector-subjects">
          <div className="inspector-subjects-header">
            <span className="inspector-subjects-title">Subjects</span>
            <span className="inspector-subjects-count">{filteredSubjects.length}</span>
          </div>
          <input
            className="inspector-subjects-filter"
            type="text"
            value={subjectFilter}
            onChange={(event) => setSubjectFilter(event.target.value)}
            placeholder="Filter subjects"
          />
          <div className="inspector-subjects-list">
            <button
              type="button"
              className={`inspector-subject-item${!selectedSubject ? " active" : ""}`}
              onClick={() => setSelectedSubject(null)}
            >
                <span className="inspector-subject-name">All memory</span>
                <span className="inspector-subject-count">{totalFactCount}</span>
              </button>
              {filteredSubjects.map((subject) => (
              <button
                key={`${subject.guild_id}:${subject.subject}`}
                type="button"
                className={`inspector-subject-item${selectedSubject === subject.subject ? " active" : ""}`}
                onClick={() => setSelectedSubject(subject.subject)}
                title={`${getScopeLabel(subject.scope, subject.subject)} · ${formatTimestamp(subject.last_seen_at)}`}
              >
                <span className="inspector-subject-name">{getSubjectLabel(subject.subject)}</span>
                <span className="inspector-type-badge">{getScopeLabel(subject.scope, subject.subject)}</span>
                <span className="inspector-subject-count">{subject.fact_count}</span>
              </button>
            ))}
          </div>
        </aside>

        <section className="inspector-facts">
          <div className="inspector-facts-header">
            <div className="inspector-facts-title">
              {selectedSubject ? `Memory: ${getSubjectLabel(selectedSubject)}` : "Memory"}
            </div>
            <div className="inspector-facts-controls">
              <input
                className="inspector-facts-filter"
                type="text"
                value={factQuery}
                onChange={(event) => setFactQuery(event.target.value)}
                placeholder="Filter fact text, evidence, source, or channel"
              />
              <label className="inspector-limit-label">
                Limit
                <select value={factLimit} onChange={(event) => setFactLimit(Number(event.target.value))}>
                  {[60, 120, 250, 500].map((value) => (
                    <option key={value} value={value}>{value}</option>
                  ))}
                </select>
              </label>
              <span className="inspector-facts-count">
                {loadingFacts ? "Loading..." : `${facts.length} shown`}
              </span>
            </div>
          </div>

          {facts.length === 0 && !loadingFacts ? (
            <p className="inspector-empty">No matching facts found.</p>
          ) : (
            <div className="inspector-facts-table-wrap">
              <table className="inspector-table">
                <thead>
                  <tr>
                    <th className="inspector-th-id">ID</th>
                    <th className="inspector-th-subject">Subject</th>
                    <th className="inspector-th-type">Scope</th>
                    <th className="inspector-th-type">Type</th>
                    <th className="inspector-th-fact">Fact</th>
                    <th className="inspector-th-conf">Conf</th>
                    <th className="inspector-th-updated">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {facts.map((fact) => {
                    const isOpen = expandedFactId === fact.id;
                    const isSaving = savingFactId === fact.id;
                    const isDeleting = deletingFactId === fact.id;
                    return (
                      <Fragment key={fact.id}>
                        <tr
                          className={`inspector-row${isOpen ? " inspector-row-open" : ""}`}
                          onClick={() => handleToggleFact(fact)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              handleToggleFact(fact);
                            }
                          }}
                          tabIndex={0}
                        >
                          <td className="inspector-td-id">
                            <span className={`inspector-expand${isOpen ? " open" : ""}`}>&#9654;</span>
                            {fact.id}
                          </td>
                            <td className="inspector-td-subject">{getSubjectLabel(fact.subject)}</td>
                            <td className="inspector-td-type">
                              <span className="inspector-type-badge">{getScopeLabel(fact.scope, fact.subject)}</span>
                            </td>
                            <td className="inspector-td-type">
                              <span className="inspector-type-badge">{fact.fact_type}</span>
                            </td>
                          <td className="inspector-td-fact">{fact.fact}</td>
                          <td className="inspector-td-conf">{Math.round(Number(fact.confidence || 0) * 100)}%</td>
                          <td className="inspector-td-updated">{timeAgo(fact.updated_at)}</td>
                        </tr>
                        {isOpen ? (
                          <tr className="inspector-detail-row">
                            <td colSpan={7}>
                              <div className="inspector-detail">
                                <div className="inspector-detail-grid">
                                  <div>
                                    <span className="inspector-detail-label">Scope</span>
                                    <span className="inspector-detail-value">{getScopeLabel(fact.scope, fact.subject)}</span>
                                  </div>
                                  <div>
                                    <span className="inspector-detail-label">Created</span>
                                    <span className="inspector-detail-value">{formatTimestamp(fact.created_at)}</span>
                                  </div>
                                  <div>
                                    <span className="inspector-detail-label">Updated</span>
                                    <span className="inspector-detail-value">{formatTimestamp(fact.updated_at)}</span>
                                  </div>
                                  <div>
                                    <span className="inspector-detail-label">Channel</span>
                                    <span className="inspector-detail-value">{fact.channel_id || "none"}</span>
                                  </div>
                                  <div>
                                    <span className="inspector-detail-label">Portable Owner</span>
                                    <span className="inspector-detail-value">{fact.user_id || "none"}</span>
                                  </div>
                                  <div>
                                    <span className="inspector-detail-label">Source Message</span>
                                    <span className="inspector-detail-value">{fact.source_message_id || "none"}</span>
                                  </div>
                                  <div>
                                    <span className="inspector-detail-label">Legacy</span>
                                    <span className="inspector-detail-value">{fact.metadata?.isLegacy ? "yes" : "no"}</span>
                                  </div>
                                </div>

                                <div className="inspector-detail-section">
                                  <div className="inspector-editor-grid">
                                    <label>
                                      Subject
                                      <input
                                        type="text"
                                        value={editor?.subject || ""}
                                        onChange={(event) => setEditor((current) => current
                                          ? { ...current, subject: event.target.value }
                                          : current)}
                                        disabled={isSaving || isDeleting}
                                      />
                                    </label>
                                    <label>
                                      Type
                                      <select
                                        value={editor?.factType || "other"}
                                        onChange={(event) => setEditor((current) => current
                                          ? { ...current, factType: event.target.value }
                                          : current)}
                                        disabled={isSaving || isDeleting}
                                      >
                                        {FACT_TYPE_OPTIONS.map((option) => (
                                          <option key={option} value={option}>{option}</option>
                                        ))}
                                      </select>
                                    </label>
                                    <label>
                                      Confidence (%)
                                      <input
                                        type="number"
                                        min={0}
                                        max={100}
                                        step={1}
                                        value={editor?.confidencePercent || ""}
                                        onChange={(event) => setEditor((current) => current
                                          ? { ...current, confidencePercent: event.target.value }
                                          : current)}
                                        disabled={isSaving || isDeleting}
                                      />
                                    </label>
                                  </div>

                                  <label>
                                    Fact
                                    <textarea
                                      className="inspector-editor-textarea"
                                      value={editor?.fact || ""}
                                      onChange={(event) => setEditor((current) => current
                                        ? { ...current, fact: event.target.value }
                                        : current)}
                                      disabled={isSaving || isDeleting}
                                    />
                                  </label>

                                  <label>
                                    Evidence
                                    <textarea
                                      className="inspector-editor-textarea inspector-editor-textarea-subtle"
                                      value={editor?.evidenceText || ""}
                                      onChange={(event) => setEditor((current) => current
                                        ? { ...current, evidenceText: event.target.value }
                                        : current)}
                                      disabled={isSaving || isDeleting}
                                    />
                                  </label>
                                </div>

                                <div className="inspector-detail-actions">
                                  <button
                                    type="button"
                                    onClick={() => void handleSaveFact(fact)}
                                    disabled={isSaving || isDeleting}
                                  >
                                    {isSaving ? "Saving..." : "Save"}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleResetEditor(fact)}
                                    disabled={isSaving || isDeleting}
                                  >
                                    Reset
                                  </button>
                                  <button
                                    type="button"
                                    className="memory-reflection-delete-btn"
                                    onClick={() => void handleDeleteFact(fact)}
                                    disabled={isSaving || isDeleting}
                                  >
                                    {isDeleting ? "Deleting..." : "Delete"}
                                  </button>
                                </div>
                              </div>
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
