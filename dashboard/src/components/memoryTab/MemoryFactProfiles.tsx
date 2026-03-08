import { useEffect, useState, type FormEvent } from "react";
import { api } from "../../api";
import MemoryMessagesTable, { type RelevantMessage } from "./MemoryMessagesTable";
import { ChannelIdField, GuildSelectField } from "./MemoryFormFields";

interface Guild {
  id: string;
  name: string;
}

interface Props {
  guilds: Guild[];
  notify: (text: string, type?: string) => void;
}

interface FactProfileFact {
  id?: number | null;
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
  };
}

interface ActiveVoiceUserCache {
  userId: string | null;
  displayName: string | null;
  loadedAt: string | null;
  factCount: number;
  userFacts?: FactProfileFact[];
}

interface ActiveVoiceGuildCache {
  loadedAt: string | null;
  selfFacts: FactProfileFact[];
  loreFacts: FactProfileFact[];
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
  };
  promptContext: {
    relevantMessages: RelevantMessage[];
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
            <strong>{fact.subject || "unknown subject"}</strong>
            <span>{fact.factType || "general"}</span>
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

export default function MemoryFactProfiles({ guilds, notify }: Props) {
  const [guildId, setGuildId] = useState("");
  const [userId, setUserId] = useState("");
  const [channelId, setChannelId] = useState("");
  const [queryText, setQueryText] = useState("");
  const [result, setResult] = useState<FactProfileResponse | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!guildId && guilds.length > 0) {
      setGuildId(guilds[0].id);
    }
  }, [guildId, guilds]);

  const handleInspect = async (e: FormEvent) => {
    e.preventDefault();
    if (!guildId) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ guildId });
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
    loreFacts: []
  };
  const activeVoiceSession = result?.activeVoiceSession || null;
  const relevantMessages = Array.isArray(result?.promptContext?.relevantMessages)
    ? result?.promptContext?.relevantMessages
    : [];
  const totalDurableFacts = durable.userFacts.length + durable.selfFacts.length + durable.loreFacts.length;

  return (
    <div>
      <p className="memory-reflection-copy">
        Fact profiles come straight from durable SQLite memory. Query text does not change which facts load. It only
        affects the optional relevant-message lookup below.
      </p>

      <form className="memory-form" onSubmit={handleInspect}>
        <div className="memory-form-row">
          <GuildSelectField guilds={guilds} guildId={guildId} onGuildChange={setGuildId} />
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
            Query Text <span style={{ color: "var(--ink-3)" }}>(messages only)</span>
            <input
              type="text"
              value={queryText}
              onChange={(e) => setQueryText(e.target.value)}
              placeholder="Optional message lookup query"
            />
          </label>
          <div className="memory-form-action">
            <button type="submit" className="cta" disabled={loading || !guildId}>
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
                User Facts
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
                Guild Lore Facts
                <span className="memory-result-group-count">{durable.loreFacts.length}</span>
              </h4>
              <FactProfileFactList facts={durable.loreFacts} emptyLabel="No guild lore facts found for this guild." />
            </div>

            <div className="memory-result-group">
              <h4 className="memory-result-group-title">
                Relevant Messages
                <span className="memory-result-group-count">{relevantMessages.length}</span>
              </h4>
              {channelId.trim() && queryText.trim() ? (
                <MemoryMessagesTable messages={relevantMessages} />
              ) : (
                <p className="memory-reflection-empty">
                  Provide both channel ID and query text to inspect the message lookup that still feeds prompt context.
                </p>
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
