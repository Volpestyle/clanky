import { useEffect, useState, type FormEvent } from "react";
import { api } from "../../api";
import { PanelHead } from "../ui";
import MemoryMessagesTable, { type RelevantMessage } from "./MemoryMessagesTable";
import { ChannelIdField } from "./MemoryFormFields";
import { useDashboardGuildScope } from "../../guildScope";

interface FactRow {
  id?: number | null;
  scope?: string | null;
  userId?: string | null;
  subject?: string | null;
  factType?: string | null;
  fact?: string | null;
  confidence?: number | null;
  metadata?: {
    createdAt?: string | null;
    updatedAt?: string | null;
    guildId?: string | null;
      channelId?: string | null;
      evidenceText?: string | null;
      sourceMessageId?: string | null;
      isLegacy?: boolean | null;
    };
}

function getSubjectLabel(subject: string | null | undefined) {
  if (subject === "__lore__") return "Community";
  if (subject === "__self__") return "Clanky";
  if (subject === "__owner__") return "Owner Private";
  return subject || "unknown subject";
}

function getScopeLabel(scope: string | null | undefined, subject: string | null | undefined) {
  if (subject === "__lore__") return "community";
  if (subject === "__self__") return "self";
  if (subject === "__owner__" || scope === "owner") return "owner private";
  if (scope === "user") return "person";
  if (scope === "guild") return "community";
  return "memory";
}

interface ParticipantProfile {
  userId?: string | null;
  displayName?: string | null;
  isPrimary?: boolean;
  facts?: FactRow[];
}

interface ConversationWindow {
  anchorMessageId?: string | null;
  createdAt?: string | null;
  score?: number | null;
  semanticScore?: number | null;
  ageMinutes?: number | null;
  messages?: RelevantMessage[];
}

interface RecentVoiceSessionContext {
  sessionId?: string | null;
  guildId?: string | null;
  channelId?: string | null;
  endedAt?: string | null;
  ageMinutes?: number | null;
  summaryText?: string | null;
}

interface RuntimeSnapshotResponse {
  guildId: string;
  channelId: string | null;
  userId: string | null;
  queryText: string;
  mode: "text" | "voice";
  participants: Array<{
    userId: string;
    displayName: string;
    source: string;
  }>;
  counts: {
    participantCount: number;
    participantProfileCount: number;
    userFactCount: number;
    relevantFactCount: number;
    selfFactCount: number;
    loreFactCount: number;
    guidanceFactCount: number;
    behavioralFactCount: number;
    conversationWindowCount: number;
    recentVoiceSessionCount: number;
  };
  slice: {
    participantProfiles: ParticipantProfile[];
    userFacts: FactRow[];
    relevantFacts: FactRow[];
    selfFacts: FactRow[];
    loreFacts: FactRow[];
    guidanceFacts: FactRow[];
    behavioralFacts: FactRow[];
  };
  promptContext: {
    recentConversationHistory: ConversationWindow[];
    recentVoiceSessionContext: RecentVoiceSessionContext[];
  };
  activeVoiceSession: {
    sessionId?: string | null;
    voiceChannelId?: string | null;
    textChannelId?: string | null;
    participantCount?: number;
    participants?: Array<{
      userId?: string | null;
      displayName?: string | null;
    }>;
  } | null;
}

function formatTimestamp(value: string | null | undefined) {
  if (!value) return "Unknown";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
}

function buildFactMeta(fact: FactRow) {
  const parts = [
    fact.metadata?.updatedAt ? `Updated ${formatTimestamp(fact.metadata.updatedAt)}` : null,
    fact.metadata?.channelId ? `Channel ${fact.metadata.channelId}` : null,
    fact.metadata?.sourceMessageId ? `Source ${fact.metadata.sourceMessageId}` : null
  ].filter(Boolean);
  return parts.join(" | ");
}

function FactCardList({
  facts,
  emptyLabel
}: {
  facts: FactRow[];
  emptyLabel: string;
}) {
  if (!facts.length) {
    return <p className="memory-reflection-empty">{emptyLabel}</p>;
  }

  return (
    <div className="memory-reflection-facts">
      {facts.map((fact, index) => (
        <article
          key={`${String(fact.id || "fact")}:${String(fact.subject || "")}:${String(fact.fact || "")}:${index}`}
          className="memory-reflection-fact"
        >
          <div className="memory-reflection-fact-head">
            <strong>{getSubjectLabel(fact.subject)}</strong>
            <span>{getScopeLabel(fact.scope, fact.subject)}</span>
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

function ParticipantProfileList({ profiles }: { profiles: ParticipantProfile[] }) {
  if (!profiles.length) {
    return <p className="memory-reflection-empty">No participant profiles loaded.</p>;
  }

  return (
    <div className="memory-style-audit-list">
      {profiles.map((profile, index) => (
        <article
          key={`${String(profile.userId || "participant")}:${index}`}
          className="memory-style-audit-card"
        >
          <div className="memory-style-audit-meta">
            <strong>{profile.displayName || profile.userId || "unknown participant"}</strong>
            <span>{profile.userId || "unknown id"}</span>
            <span>{profile.isPrimary ? "primary user" : "participant"}</span>
          </div>
          <FactCardList
            facts={Array.isArray(profile.facts) ? profile.facts : []}
            emptyLabel="No durable facts loaded for this participant."
          />
        </article>
      ))}
    </div>
  );
}

export default function MemoryRuntimeSnapshot({
  notify
}: {
  notify: (text: string, type?: string) => void;
}) {
  const { selectedGuildId } = useDashboardGuildScope();
  const [mode, setMode] = useState<"text" | "voice">("text");
  const [channelId, setChannelId] = useState("");
  const [userId, setUserId] = useState("");
  const [queryText, setQueryText] = useState("");
  const [participantIdsText, setParticipantIdsText] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<RuntimeSnapshotResponse | null>(null);

  useEffect(() => {
    setResult(null);
  }, [selectedGuildId]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedGuildId) return;
    setLoading(true);
    try {
      const participantIds = [...new Set(
        participantIdsText
          .split(/[\s,]+/u)
          .map((value) => value.trim())
          .filter(Boolean)
      )];
      const data = await api<RuntimeSnapshotResponse>("/api/memory/runtime-snapshot", {
        method: "POST",
        body: {
          guildId: selectedGuildId,
          mode,
          channelId: channelId.trim() || null,
          userId: userId.trim() || null,
          queryText: queryText.trim(),
          participantIds
        }
      });
      setResult(data);
    } catch (error: unknown) {
      notify(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setLoading(false);
    }
  };

  const counts = result?.counts;

  return (
    <div>
      <PanelHead title="Runtime Snapshot" />

      <p className="memory-reflection-copy">
        Preview the actual turn-scoped memory slice the bot would assemble for a reply. This uses the real participant
        fact profiles, contextual behavioral retrieval, and conversation recall instead of `memory/MEMORY.md`.
      </p>

      <form className="memory-form" onSubmit={handleSubmit}>
        <div className="memory-form-row">
          <label>
            Mode
            <select value={mode} onChange={(event) => setMode(event.target.value === "voice" ? "voice" : "text")}>
              <option value="text">Text</option>
              <option value="voice">Voice</option>
            </select>
          </label>
          <label>
            User ID <span style={{ color: "var(--ink-3)" }}>(optional)</span>
            <input
              type="text"
              value={userId}
              onChange={(event) => setUserId(event.target.value)}
              placeholder="Primary speaker / user"
            />
          </label>
        </div>

        <div className="memory-form-row">
          <ChannelIdField channelId={channelId} onChannelIdChange={setChannelId} />
          <label>
            Query Text <span style={{ color: "var(--ink-3)" }}>(optional but recommended)</span>
            <input
              type="text"
              value={queryText}
              onChange={(event) => setQueryText(event.target.value)}
              placeholder="What the current turn is about"
            />
          </label>
        </div>

        <div className="memory-form-row">
          <label style={{ flex: 1 }}>
            Participant IDs <span style={{ color: "var(--ink-3)" }}>(optional, comma or space separated)</span>
            <input
              type="text"
              value={participantIdsText}
              onChange={(event) => setParticipantIdsText(event.target.value)}
              placeholder="user-1, user-2, user-3"
            />
          </label>
          <div className="memory-form-action">
            <button type="submit" className="cta" disabled={loading || !selectedGuildId}>
              {loading ? "Generating..." : "Generate Snapshot"}
            </button>
          </div>
        </div>
      </form>

      {result ? (
        <div className="memory-style-sections" style={{ marginTop: 14 }}>
          <section className="memory-style-section">
            <div className="memory-style-section-head">
              <h4>Slice Overview</h4>
              <span className="memory-result-count">{result.mode === "voice" ? "Voice" : "Text"} mode</span>
            </div>

            <div className="memory-reflection-grid" style={{ marginBottom: 14 }}>
              <div className="memory-reflection-meta">
                <div><span>Guild</span><strong>{result.guildId}</strong></div>
                <div><span>Channel</span><strong>{result.channelId || "none"}</strong></div>
                <div><span>Primary user</span><strong>{result.userId || "none"}</strong></div>
                <div><span>Query</span><strong>{result.queryText || "none"}</strong></div>
                <div><span>Participants</span><strong>{counts?.participantCount || 0}</strong></div>
                <div><span>Profiles loaded</span><strong>{counts?.participantProfileCount || 0}</strong></div>
              </div>

              <div className="memory-reflection-usage">
               <div><span>People facts</span><strong>{counts?.userFactCount || 0}</strong></div>
                <div><span>Relevant facts</span><strong>{counts?.relevantFactCount || 0}</strong></div>
                <div><span>Guidance</span><strong>{counts?.guidanceFactCount || 0}</strong></div>
                <div><span>Behavioral</span><strong>{counts?.behavioralFactCount || 0}</strong></div>
                <div><span>Conversation windows</span><strong>{counts?.conversationWindowCount || 0}</strong></div>
                <div><span>Recent voice context</span><strong>{counts?.recentVoiceSessionCount || 0}</strong></div>
              </div>
            </div>

            {Array.isArray(result.participants) && result.participants.length > 0 ? (
              <div className="memory-reflection-chip-row">
                {result.participants.map((participant) => (
                  <span
                    key={`${participant.userId}:${participant.source}`}
                    className="memory-reflection-chip"
                  >
                    {participant.displayName} · {participant.source.replace(/_/g, " ")}
                  </span>
                ))}
              </div>
            ) : (
              <p className="memory-reflection-empty">No participants resolved for this snapshot.</p>
            )}
          </section>

          <section className="memory-style-section">
            <div className="memory-style-section-head">
              <h4>People In Context</h4>
              <span className="memory-result-count">{result.slice.participantProfiles.length}</span>
            </div>
            <ParticipantProfileList profiles={result.slice.participantProfiles} />
          </section>

          <section className="memory-style-section">
            <div className="memory-style-section-head">
              <h4>Primary Person Facts</h4>
              <span className="memory-result-count">{result.slice.userFacts.length}</span>
            </div>
            <FactCardList facts={result.slice.userFacts} emptyLabel="No primary-person durable facts loaded." />
          </section>

          <section className="memory-style-section">
            <div className="memory-style-section-head">
              <h4>Relevant Supporting Facts</h4>
              <span className="memory-result-count">{result.slice.relevantFacts.length}</span>
            </div>
            <FactCardList
              facts={result.slice.relevantFacts}
              emptyLabel="No additional relevant facts were surfaced for this slice."
            />
          </section>

          <section className="memory-style-section">
            <div className="memory-style-section-head">
              <h4>Bot Self Facts</h4>
              <span className="memory-result-count">{result.slice.selfFacts.length}</span>
            </div>
            <FactCardList facts={result.slice.selfFacts} emptyLabel="No bot self facts loaded." />
          </section>

          <section className="memory-style-section">
            <div className="memory-style-section-head">
              <h4>Community Facts</h4>
              <span className="memory-result-count">{result.slice.loreFacts.length}</span>
            </div>
            <FactCardList facts={result.slice.loreFacts} emptyLabel="No community facts loaded." />
          </section>

          <section className="memory-style-section">
            <div className="memory-style-section-head">
              <h4>Guidance Facts</h4>
              <span className="memory-result-count">{result.slice.guidanceFacts.length}</span>
            </div>
            <FactCardList facts={result.slice.guidanceFacts} emptyLabel="No guidance facts were included." />
          </section>

          <section className="memory-style-section">
            <div className="memory-style-section-head">
              <h4>Behavioral Facts</h4>
              <span className="memory-result-count">{result.slice.behavioralFacts.length}</span>
            </div>
            <FactCardList
              facts={result.slice.behavioralFacts}
              emptyLabel="No contextual behavioral facts matched this turn."
            />
          </section>

          <section className="memory-style-section">
            <div className="memory-style-section-head">
              <h4>Auto-Retrieved Conversation Windows</h4>
              <span className="memory-result-count">{result.promptContext.recentConversationHistory.length}</span>
            </div>
            {result.promptContext.recentConversationHistory.length > 0 ? (
              <div className="memory-style-audit-list">
                {result.promptContext.recentConversationHistory.map((window, index) => (
                  <article
                    key={`${String(window.anchorMessageId || "window")}:${index}`}
                    className="memory-style-audit-card"
                  >
                    <div className="memory-style-audit-meta">
                      <strong>Window {index + 1}</strong>
                      <span>{formatTimestamp(window.createdAt)}</span>
                      {window.ageMinutes != null ? <span>{window.ageMinutes}m ago</span> : null}
                      {window.score != null ? <span>score {Number(window.score).toFixed(3)}</span> : null}
                    </div>
                    <MemoryMessagesTable messages={Array.isArray(window.messages) ? window.messages : []} />
                  </article>
                ))}
              </div>
            ) : (
              <p className="memory-reflection-empty">No conversation windows matched this snapshot.</p>
            )}
          </section>

          <section className="memory-style-section">
            <div className="memory-style-section-head">
              <h4>Recent Voice Session Context</h4>
              <span className="memory-result-count">{result.promptContext.recentVoiceSessionContext.length}</span>
            </div>
            {result.promptContext.recentVoiceSessionContext.length > 0 ? (
              <div className="memory-style-audit-list">
                {result.promptContext.recentVoiceSessionContext.map((entry, index) => (
                  <article
                    key={`${String(entry.sessionId || "voice-summary")}:${index}`}
                    className="memory-style-audit-card"
                  >
                    <div className="memory-style-audit-meta">
                      <strong>{entry.sessionId || "recent voice session"}</strong>
                      {entry.ageMinutes != null ? <span>{entry.ageMinutes}m ago</span> : null}
                      <span>{formatTimestamp(entry.endedAt)}</span>
                    </div>
                    <p>{entry.summaryText || "(empty summary)"}</p>
                  </article>
                ))}
              </div>
            ) : (
              <p className="memory-reflection-empty">No recent persisted voice session summaries for this channel.</p>
            )}
          </section>

          <section className="memory-style-section">
            <div className="memory-style-section-head">
              <h4>Active Voice Cache</h4>
              <span className="memory-result-count">
                {result.activeVoiceSession ? `Session ${result.activeVoiceSession.sessionId || "unknown"}` : "No active session"}
              </span>
            </div>
            {result.activeVoiceSession ? (
              <div className="memory-style-audit-list">
                <article className="memory-style-audit-card">
                  <div className="memory-style-audit-meta">
                    <strong>{result.activeVoiceSession.voiceChannelId || "unknown voice channel"}</strong>
                    <span>text {result.activeVoiceSession.textChannelId || "none"}</span>
                    <span>{result.activeVoiceSession.participantCount || 0} participants</span>
                  </div>
                  {Array.isArray(result.activeVoiceSession.participants) && result.activeVoiceSession.participants.length > 0 ? (
                    <ul className="memory-style-note-list">
                      {result.activeVoiceSession.participants.map((participant, index) => (
                        <li key={`${String(participant.userId || "participant")}:${index}`}>
                          {participant.displayName || participant.userId || "unknown participant"}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="memory-reflection-empty">No active voice participants exposed.</p>
                  )}
                </article>
              </div>
            ) : (
              <p className="memory-reflection-empty">No active voice session for this guild.</p>
            )}
          </section>
        </div>
      ) : null}
    </div>
  );
}
