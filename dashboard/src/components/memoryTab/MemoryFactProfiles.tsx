import { useEffect, useState, type FormEvent } from "react";
import { api } from "../../api";
import MemoryMessagesTable, { type RelevantMessage } from "./MemoryMessagesTable";
import { ChannelIdField } from "./MemoryFormFields";
import { useDashboardGuildScope } from "../../guildScope";

interface Props {
  notify: (text: string, type?: string) => void;
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

interface ActiveVoiceUserCache {
  userId: string | null;
  displayName: string | null;
  loadedAt: string | null;
  factCount: number;
  userFacts?: FactProfileFact[];
  guidanceFacts?: FactProfileFact[];
}

interface ActiveVoiceGuildCache {
  loadedAt: string | null;
  selfFacts: FactProfileFact[];
  loreFacts: FactProfileFact[];
  guidanceFacts: FactProfileFact[];
}

interface ActiveVoiceSessionProfile {
  sessionId: string | null;
  voiceChannelId: string | null;
  textChannelId: string | null;
  participantCount: number;
  participants: Array<{
    userId: string | null;
    displayName: string | null;
  }>;
  cachedUsers: ActiveVoiceUserCache[];
  userFactProfile: ActiveVoiceUserCache | null;
  guildFactProfile: ActiveVoiceGuildCache | null;
}

interface FactProfileResponse {
  guildId: string;
  userId: string | null;
  channelId: string | null;
  queryText: string;
  durableProfile: {
    userFacts: FactProfileFact[];
    selfFacts: FactProfileFact[];
    loreFacts: FactProfileFact[];
    guidanceFacts: FactProfileFact[];
  };
  promptContext: {
    recentConversationHistory: Array<{
      anchorMessageId?: string | null;
      createdAt?: string | null;
      score?: number | null;
      semanticScore?: number | null;
      ageMinutes?: number | null;
      messages: RelevantMessage[];
    }>;
    recentVoiceSessionContext: Array<{
      sessionId?: string | null;
      guildId?: string | null;
      channelId?: string | null;
      endedAt?: string | null;
      ageMinutes?: number | null;
      summaryText?: string | null;
    }>;
  };
  activeVoiceSession: ActiveVoiceSessionProfile | null;
}

function formatTimestamp(value: string | null | undefined) {
  if (!value) return "never";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
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

export default function MemoryFactProfiles({ notify }: Props) {
  const { selectedGuildId } = useDashboardGuildScope();
  const [userId, setUserId] = useState("");
  const [channelId, setChannelId] = useState("");
  const [queryText, setQueryText] = useState("");
  const [result, setResult] = useState<FactProfileResponse | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setResult(null);
  }, [selectedGuildId]);

  const handleInspect = async (e: FormEvent) => {
    e.preventDefault();
    if (!selectedGuildId) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ guildId: selectedGuildId });
      if (userId.trim()) params.set("userId", userId.trim());
      if (channelId.trim()) params.set("channelId", channelId.trim());
      if (queryText.trim()) params.set("queryText", queryText.trim());
      const data = await api<FactProfileResponse>(`/api/memory/fact-profile?${params}`);
      setResult(data);
    } catch (error: unknown) {
      notify(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setLoading(false);
    }
  };

  const durable = result?.durableProfile || {
    userFacts: [],
    selfFacts: [],
    loreFacts: [],
    guidanceFacts: []
  };
  const activeVoiceSession = result?.activeVoiceSession || null;
  const recentConversationHistory = Array.isArray(result?.promptContext?.recentConversationHistory)
    ? result?.promptContext?.recentConversationHistory
    : [];
  const recentVoiceSessionContext = Array.isArray(result?.promptContext?.recentVoiceSessionContext)
    ? result?.promptContext?.recentVoiceSessionContext
    : [];
  const totalDurableFacts =
    durable.userFacts.length +
    durable.selfFacts.length +
    durable.loreFacts.length +
    durable.guidanceFacts.length;

  return (
    <div>
      <p className="memory-reflection-copy">
        Fact profiles come straight from canonical durable SQLite memory. Query text does not change which facts load. It only
        affects the optional conversation-recall preview below.
      </p>

      <form className="memory-form" onSubmit={handleInspect}>
        <div className="memory-form-row">
          <label>
            User ID <span style={{ color: "var(--ink-3)" }}>(optional)</span>
            <input
              type="text"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              placeholder="Speaker user ID"
            />
          </label>
        </div>

        <div className="memory-form-row">
          <ChannelIdField channelId={channelId} onChannelIdChange={setChannelId} />
          <label>
            Query Text <span style={{ color: "var(--ink-3)" }}>(conversation recall)</span>
            <input
              type="text"
              value={queryText}
              onChange={(e) => setQueryText(e.target.value)}
              placeholder="Optional message lookup query"
            />
          </label>
          <div className="memory-form-action">
            <button type="submit" className="cta" disabled={loading || !selectedGuildId}>
              {loading ? "Loading..." : "Inspect"}
            </button>
          </div>
        </div>
      </form>

      {result ? (
        <div className="memory-style-sections" style={{ marginTop: 14 }}>
          <section className="memory-style-section">
            <div className="memory-style-section-head">
              <h4>Durable Fact Profile</h4>
              <span className="memory-result-count">{totalDurableFacts} fact{totalDurableFacts !== 1 ? "s" : ""}</span>
            </div>

            <div className="memory-result-group">
              <h4 className="memory-result-group-title">
                Person Facts
                <span className="memory-result-group-count">{durable.userFacts.length}</span>
              </h4>
              <FactProfileFactList
                facts={durable.userFacts}
                emptyLabel={userId.trim() ? "No durable facts for that user." : "Enter a user ID to inspect speaker facts."}
              />
            </div>

            <div className="memory-result-group">
              <h4 className="memory-result-group-title">
                Bot Self Facts
                <span className="memory-result-group-count">{durable.selfFacts.length}</span>
              </h4>
              <FactProfileFactList facts={durable.selfFacts} emptyLabel="No bot self facts found for this guild." />
            </div>

            <div className="memory-result-group">
              <h4 className="memory-result-group-title">
                Community Facts
                <span className="memory-result-group-count">{durable.loreFacts.length}</span>
              </h4>
              <FactProfileFactList facts={durable.loreFacts} emptyLabel="No community facts found for this guild." />
            </div>

            <div className="memory-result-group">
              <h4 className="memory-result-group-title">
                Guidance Facts
                <span className="memory-result-group-count">{durable.guidanceFacts.length}</span>
              </h4>
              <FactProfileFactList
                facts={durable.guidanceFacts}
                emptyLabel="No guidance facts found for this guild/user scope."
              />
            </div>

            <div className="memory-result-group">
              <h4 className="memory-result-group-title">
                Auto-Retrieved Conversation Windows
                <span className="memory-result-group-count">{recentConversationHistory.length}</span>
              </h4>
              {channelId.trim() && queryText.trim() ? (
                recentConversationHistory.length > 0 ? (
                  <div className="memory-style-audit-list">
                    {recentConversationHistory.map((window, index) => (
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
                  <p className="memory-reflection-empty">No semantically relevant past conversation windows found.</p>
                )
              ) : (
                <p className="memory-reflection-empty">
                  Provide both channel ID and query text to inspect the auto-retrieved conversation history that feeds prompt context.
                </p>
              )}
            </div>

            <div className="memory-result-group">
              <h4 className="memory-result-group-title">
                Recent Voice Session Context
                <span className="memory-result-group-count">{recentVoiceSessionContext.length}</span>
              </h4>
              {channelId.trim() ? (
                recentVoiceSessionContext.length > 0 ? (
                  <div className="memory-style-audit-list">
                    {recentVoiceSessionContext.map((entry, index) => (
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
                )
              ) : (
                <p className="memory-reflection-empty">Provide a channel ID to inspect recent cross-modal voice continuity.</p>
              )}
            </div>
          </section>

          <section className="memory-style-section">
            <div className="memory-style-section-head">
              <h4>Active Voice Cache</h4>
              <span className="memory-result-count">
                {activeVoiceSession ? `Session ${activeVoiceSession.sessionId || "unknown"}` : "No active session"}
              </span>
            </div>

            {activeVoiceSession ? (
              <>
                <div className="memory-reflection-grid" style={{ marginBottom: 14 }}>
                  <div className="memory-reflection-meta">
                    <div>
                      <span>Voice Channel</span>
                      <strong>{activeVoiceSession.voiceChannelId || "unknown"}</strong>
                    </div>
                    <div>
                      <span>Text Channel</span>
                      <strong>{activeVoiceSession.textChannelId || "unknown"}</strong>
                    </div>
                    <div>
                      <span>Participants</span>
                      <strong>{activeVoiceSession.participantCount}</strong>
                    </div>
                    <div>
                      <span>Guild Cache Loaded</span>
                      <strong>{formatTimestamp(activeVoiceSession.guildFactProfile?.loadedAt)}</strong>
                    </div>
                  </div>
                </div>

                <div className="memory-result-group">
                  <h4 className="memory-result-group-title">
                    Cached Users
                    <span className="memory-result-group-count">{activeVoiceSession.cachedUsers.length}</span>
                  </h4>
                  {activeVoiceSession.cachedUsers.length > 0 ? (
                    <div className="memory-reflection-chip-row">
                      {activeVoiceSession.cachedUsers.map((entry) => (
                        <span
                          key={`${String(entry.userId || "user")}:${String(entry.loadedAt || "")}`}
                          className="memory-reflection-chip"
                          title={entry.loadedAt ? `Loaded ${formatTimestamp(entry.loadedAt)}` : "No load timestamp"}
                        >
                          {(entry.displayName || entry.userId || "unknown user") + ` (${entry.factCount})`}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p className="memory-reflection-empty">No cached speaker profiles are loaded on the active session.</p>
                  )}
                </div>

                <div className="memory-result-group">
                  <h4 className="memory-result-group-title">
                    Cached User Facts
                    <span className="memory-result-group-count">
                      {activeVoiceSession.userFactProfile?.userFacts?.length || 0}
                    </span>
                  </h4>
                  <FactProfileFactList
                    facts={activeVoiceSession.userFactProfile?.userFacts || []}
                    emptyLabel={
                      userId.trim()
                        ? "That user is not currently cached on the active voice session."
                        : "Enter a user ID to inspect the cached speaker profile."
                    }
                  />
                </div>

                <div className="memory-result-group">
                  <h4 className="memory-result-group-title">
                    Cached User Guidance Facts
                    <span className="memory-result-group-count">
                      {activeVoiceSession.userFactProfile?.guidanceFacts?.length || 0}
                    </span>
                  </h4>
                  <FactProfileFactList
                    facts={activeVoiceSession.userFactProfile?.guidanceFacts || []}
                    emptyLabel="No cached user guidance facts are loaded on the active session."
                  />
                </div>

                <div className="memory-result-group">
                  <h4 className="memory-result-group-title">
                    Cached Bot Self Facts
                    <span className="memory-result-group-count">
                      {activeVoiceSession.guildFactProfile?.selfFacts?.length || 0}
                    </span>
                  </h4>
                  <FactProfileFactList
                    facts={activeVoiceSession.guildFactProfile?.selfFacts || []}
                    emptyLabel="No cached bot self facts are loaded on the active session."
                  />
                </div>

                <div className="memory-result-group">
                  <h4 className="memory-result-group-title">
                    Cached Guild Lore Facts
                    <span className="memory-result-group-count">
                      {activeVoiceSession.guildFactProfile?.loreFacts?.length || 0}
                    </span>
                  </h4>
                  <FactProfileFactList
                    facts={activeVoiceSession.guildFactProfile?.loreFacts || []}
                    emptyLabel="No cached guild lore facts are loaded on the active session."
                  />
                </div>

                <div className="memory-result-group">
                  <h4 className="memory-result-group-title">
                    Cached Guidance Facts
                    <span className="memory-result-group-count">
                      {activeVoiceSession.guildFactProfile?.guidanceFacts?.length || 0}
                    </span>
                  </h4>
                  <FactProfileFactList
                    facts={activeVoiceSession.guildFactProfile?.guidanceFacts || []}
                    emptyLabel="No cached guidance facts are loaded on the active session."
                  />
                </div>
              </>
            ) : (
              <p className="memory-reflection-empty">
                There is no active voice session for this guild, so only the durable fact profile is available.
              </p>
            )}
          </section>
        </div>
      ) : null}
    </div>
  );
}
