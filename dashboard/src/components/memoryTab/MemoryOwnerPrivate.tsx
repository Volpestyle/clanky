import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../api";

interface FactRow {
  id: number;
  created_at: string;
  updated_at: string;
  scope?: "owner" | "user" | "guild";
  guild_id: string | null;
  channel_id: string | null;
  user_id?: string | null;
  subject: string;
  fact: string;
  fact_type: string;
  evidence_text: string | null;
  source_message_id: string | null;
  confidence: number;
}

interface FactProfileFact {
  id?: number | null;
  scope?: string | null;
  userId?: string | null;
  subject?: string | null;
  factType?: string | null;
  fact?: string | null;
  confidence?: number | null;
  metadata?: {
    updatedAt?: string | null;
    channelId?: string | null;
    evidenceText?: string | null;
    sourceMessageId?: string | null;
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

function formatTimestamp(value: string | null | undefined) {
  const raw = String(value || "").trim();
  if (!raw) return "unknown time";
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return raw;
  return parsed.toLocaleString();
}

function buildFactMeta(fact: FactProfileFact) {
  const parts = [
    fact.metadata?.updatedAt ? `Updated ${formatTimestamp(fact.metadata.updatedAt)}` : null,
    fact.metadata?.channelId ? `Channel ${fact.metadata.channelId}` : null,
    fact.metadata?.sourceMessageId ? `Source ${fact.metadata.sourceMessageId}` : null
  ].filter(Boolean);
  return parts.join(" | ");
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
    return normalized || message;
  } catch {
    return message;
  }
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

function FactProfileFactList({
  facts,
  emptyLabel
}: {
  facts: FactProfileFact[];
  emptyLabel: string;
}) {
  if (!facts.length) {
    return <p className="memory-reflection-empty">{emptyLabel}</p>;
  }

  return (
    <div className="memory-reflection-facts">
      {facts.map((fact, index) => (
        <article
          key={`${String(fact.id || "fact")}:${String(fact.fact || "")}:${index}`}
          className="memory-reflection-fact"
        >
          <div className="memory-reflection-fact-head">
            <strong>Owner Private</strong>
            <span>{fact.factType || "other"}</span>
            {fact.confidence != null ? <span>{Math.round(Number(fact.confidence) * 100)}%</span> : null}
          </div>
          <p>{fact.fact || "(empty fact)"}</p>
          {fact.metadata?.evidenceText ? <blockquote>{fact.metadata.evidenceText}</blockquote> : null}
          {buildFactMeta(fact) ? <div className="memory-reflection-footnote">{buildFactMeta(fact)}</div> : null}
        </article>
      ))}
    </div>
  );
}

export default function MemoryOwnerPrivate({ onMemoryMutated }: Props) {
  const [profile, setProfile] = useState<{ ownerFacts: FactProfileFact[]; guidanceFacts: FactProfileFact[] }>({
    ownerFacts: [],
    guidanceFacts: []
  });
  const [facts, setFacts] = useState<FactRow[]>([]);
  const [status, setStatus] = useState<StatusState>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [factLimit, setFactLimit] = useState(120);
  const [expandedFactId, setExpandedFactId] = useState<number | null>(null);
  const [editor, setEditor] = useState<FactEditorState | null>(null);
  const [savingFactId, setSavingFactId] = useState<number | null>(null);
  const [deletingFactId, setDeletingFactId] = useState<number | null>(null);

  const loadOwnerPrivate = useCallback(async () => {
    setLoading(true);
    setStatus(null);
    try {
      const [profileData, factsData] = await Promise.all([
        api<{ ownerProfile: { ownerFacts: FactProfileFact[]; guidanceFacts: FactProfileFact[] } }>("/api/memory/owner-private"),
        api<{ facts: FactRow[] }>(`/api/memory/owner-private/facts?${new URLSearchParams({
          limit: String(factLimit),
          ...(query.trim() ? { q: query.trim() } : {})
        }).toString()}`)
      ]);
      setProfile({
        ownerFacts: Array.isArray(profileData.ownerProfile?.ownerFacts) ? profileData.ownerProfile.ownerFacts : [],
        guidanceFacts: Array.isArray(profileData.ownerProfile?.guidanceFacts) ? profileData.ownerProfile.guidanceFacts : []
      });
      setFacts(Array.isArray(factsData.facts) ? factsData.facts : []);
    } catch (error: unknown) {
      setStatus({
        text: formatApiError(error),
        tone: "error"
      });
      setProfile({ ownerFacts: [], guidanceFacts: [] });
      setFacts([]);
    } finally {
      setLoading(false);
    }
  }, [factLimit, query]);

  useEffect(() => {
    void loadOwnerPrivate();
  }, [loadOwnerPrivate]);

  useEffect(() => {
    if (expandedFactId === null) {
      setEditor(null);
      return;
    }
    const fact = facts.find((entry) => entry.id === expandedFactId) || null;
    if (!fact) {
      setExpandedFactId(null);
      setEditor(null);
      return;
    }
    setEditor(buildEditorState(fact));
  }, [expandedFactId, facts]);

  const totalFactCount = profile.ownerFacts.length + profile.guidanceFacts.length;

  const filteredFacts = useMemo(() => facts, [facts]);

  const handleSaveFact = useCallback(async (fact: FactRow) => {
    if (!editor) return;

    const normalizedSubject = normalizeFactEditorText(editor.subject, 120);
    const normalizedFact = normalizeFactEditorText(editor.fact, 400);
    const normalizedFactType = normalizeFactEditorText(editor.factType, 40).toLowerCase() || "other";
    const normalizedEvidenceText = normalizeFactEditorText(editor.evidenceText, 240);
    const normalizedConfidence = normalizeConfidencePercent(editor.confidencePercent);
    if (!normalizedSubject || !normalizedFact || normalizedConfidence === null) {
      setStatus({
        text: "Subject, fact, and confidence are required.",
        tone: "error"
      });
      return;
    }

    setSavingFactId(fact.id);
    setStatus(null);
    try {
      await api(`/api/memory/owner-private/facts/${fact.id}`, {
        method: "PUT",
        body: {
          subject: normalizedSubject,
          fact: normalizedFact,
          factType: normalizedFactType,
          evidenceText: normalizedEvidenceText || null,
          confidence: normalizedConfidence / 100
        }
      });
      await loadOwnerPrivate();
      await onMemoryMutated?.();
      setStatus({
        text: "Owner-private fact updated.",
        tone: "info"
      });
    } catch (error: unknown) {
      setStatus({
        text: formatApiError(error),
        tone: "error"
      });
    } finally {
      setSavingFactId(null);
    }
  }, [editor, loadOwnerPrivate, onMemoryMutated]);

  const handleDeleteFact = useCallback(async (fact: FactRow) => {
    setDeletingFactId(fact.id);
    setStatus(null);
    try {
      await api(`/api/memory/owner-private/facts/${fact.id}`, {
        method: "DELETE"
      });
      await loadOwnerPrivate();
      await onMemoryMutated?.();
      setExpandedFactId((current) => (current === fact.id ? null : current));
      setStatus({
        text: "Owner-private fact deleted.",
        tone: "info"
      });
    } catch (error: unknown) {
      setStatus({
        text: formatApiError(error),
        tone: "error"
      });
    } finally {
      setDeletingFactId(null);
    }
  }, [loadOwnerPrivate, onMemoryMutated]);

  return (
    <div>
      <p className="memory-reflection-copy">
        Owner Private is the operator-only assistant lane. It stays separate from people and community memory on purpose.
      </p>

      <div className="memory-form">
        <div className="memory-form-row">
          <label>
            Filter Facts
            <input
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search owner-private facts"
            />
          </label>
          <label>
            Limit
            <input
              type="number"
              min={20}
              max={500}
              step={20}
              value={factLimit}
              onChange={(event) => setFactLimit(Math.max(20, Math.min(500, Number(event.target.value) || 120)))}
            />
          </label>
          <div className="memory-form-action">
            <button type="button" className="cta" onClick={() => void loadOwnerPrivate()} disabled={loading}>
              {loading ? "Loading..." : "Refresh"}
            </button>
          </div>
        </div>
      </div>

      {status ? (
        <p className={`status-msg ${status.tone === "error" ? "error" : "ok"}`} role="status">
          {status.text}
        </p>
      ) : null}

      <div className="memory-style-sections" style={{ marginTop: 14 }}>
        <section className="memory-style-section">
          <div className="memory-style-section-head">
            <h4>Owner Private Profile</h4>
            <span className="memory-result-count">{totalFactCount} facts</span>
          </div>

          <div className="memory-result-group">
            <h4 className="memory-result-group-title">
              Owner Facts
              <span className="memory-result-group-count">{profile.ownerFacts.length}</span>
            </h4>
            <FactProfileFactList
              facts={profile.ownerFacts}
              emptyLabel="No owner-private facts stored yet."
            />
          </div>

          <div className="memory-result-group">
            <h4 className="memory-result-group-title">
              Guidance Facts
              <span className="memory-result-group-count">{profile.guidanceFacts.length}</span>
            </h4>
            <FactProfileFactList
              facts={profile.guidanceFacts}
              emptyLabel="No owner-private guidance facts stored yet."
            />
          </div>
        </section>

        <section className="memory-style-section">
          <div className="memory-style-section-head">
            <h4>Editable Facts</h4>
            <span className="memory-result-count">{filteredFacts.length}</span>
          </div>

          {filteredFacts.length > 0 ? (
            <div className="memory-style-audit-list">
              {filteredFacts.map((fact) => {
                const expanded = expandedFactId === fact.id;
                const saving = savingFactId === fact.id;
                const deleting = deletingFactId === fact.id;
                return (
                  <article key={fact.id} className="memory-style-audit-card">
                    <div className="memory-style-audit-meta">
                      <strong>{fact.fact}</strong>
                      <span>{fact.fact_type}</span>
                      <span>{Math.round(Number(fact.confidence || 0) * 100)}%</span>
                      <span>{formatTimestamp(fact.updated_at)}</span>
                    </div>

                    <div className="memory-form-action" style={{ marginTop: 10 }}>
                      <button type="button" className="secondary" onClick={() => setExpandedFactId(expanded ? null : fact.id)}>
                        {expanded ? "Collapse" : "Edit"}
                      </button>
                    </div>

                    {expanded ? (
                      <div className="memory-form" style={{ marginTop: 12 }}>
                        <div className="memory-form-row">
                          <label>
                            Subject
                            <input
                              type="text"
                              value={editor?.subject || ""}
                              onChange={(event) => setEditor((current) => current ? { ...current, subject: event.target.value } : current)}
                            />
                          </label>
                          <label>
                            Fact Type
                            <input
                              type="text"
                              value={editor?.factType || ""}
                              onChange={(event) => setEditor((current) => current ? { ...current, factType: event.target.value } : current)}
                            />
                          </label>
                          <label>
                            Confidence %
                            <input
                              type="number"
                              min={0}
                              max={100}
                              value={editor?.confidencePercent || ""}
                              onChange={(event) => setEditor((current) => current ? { ...current, confidencePercent: event.target.value } : current)}
                            />
                          </label>
                        </div>

                        <div className="memory-form-row">
                          <label>
                            Fact
                            <input
                              type="text"
                              value={editor?.fact || ""}
                              onChange={(event) => setEditor((current) => current ? { ...current, fact: event.target.value } : current)}
                            />
                          </label>
                        </div>

                        <div className="memory-form-row">
                          <label>
                            Evidence Text
                            <input
                              type="text"
                              value={editor?.evidenceText || ""}
                              onChange={(event) => setEditor((current) => current ? { ...current, evidenceText: event.target.value } : current)}
                            />
                          </label>
                        </div>

                        <div className="memory-form-action">
                          <button type="button" className="cta" onClick={() => void handleSaveFact(fact)} disabled={saving || deleting}>
                            {saving ? "Saving..." : "Save"}
                          </button>
                          <button type="button" className="secondary" onClick={() => setEditor(buildEditorState(fact))} disabled={saving || deleting}>
                            Reset
                          </button>
                          <button type="button" className="danger" onClick={() => void handleDeleteFact(fact)} disabled={saving || deleting}>
                            {deleting ? "Deleting..." : "Delete"}
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </div>
          ) : (
            <p className="memory-reflection-empty">No owner-private facts match the current filter.</p>
          )}
        </section>
      </div>
    </div>
  );
}
