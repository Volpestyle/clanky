import { usePolling } from "../hooks/usePolling";
import { api } from "../api";
import { useDashboardGuildScope } from "../guildScope";

// ---- Types ----

interface ToolStep {
  tool: string;
  step: number;
  timestamp: string;
}

interface BrowserSession {
  sessionId: string;
  startedAt: string;
  lastActiveAt: string;
  source: string | null;
  guildId: string | null;
  channelId: string | null;
  userId: string | null;
  instruction: string | null;
  totalCostUsd: number;
  totalSteps: number;
  hitStepLimit: boolean;
  durationMs: number | null;
  runtime: string | null;
  provider: string | null;
  model: string | null;
  currentUrl: string | null;
  failed: boolean;
  errorName: string | null;
  errorMessage: string | null;
  toolSteps: ToolStep[];
}

interface BrowserSessionsResponse {
  sessions: BrowserSession[];
}

// ---- Helpers ----

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return "-";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "...";
}

function formatStepTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit"
  });
}

// ---- SessionCard ----

function SessionCard({ session }: { session: BrowserSession }) {
  const hasToolSteps = session.toolSteps.length > 0;
  const hasMetadata = session.guildId || session.channelId || session.userId;
  const hasRuntimeMetadata = session.runtime || session.provider || session.model || session.currentUrl;

  return (
    <details className="ag-card">
      <summary className="ag-card-summary">
        <span className="ag-card-expand-arrow">&#x25B8;</span>
        <span className="ag-session-id" title={session.sessionId}>
          {truncate(session.sessionId, 12)}
        </span>
        <span className="ag-session-time">{formatTimestamp(session.startedAt)}</span>
        {session.source && (
          <span className="ag-source-badge">{session.source}</span>
        )}
        <span className="ag-instruction-preview">
          {session.instruction ? truncate(session.instruction, 80) : "(no instruction)"}
        </span>
        <span className="ag-steps-count">{session.totalSteps} step{session.totalSteps !== 1 ? "s" : ""}</span>
        <span className="ag-duration">{formatDuration(session.durationMs)}</span>
        <span className="ag-cost">${session.totalCostUsd.toFixed(4)}</span>
        {session.failed && <span className="ag-chip-failed">FAILED</span>}
        {session.hitStepLimit && <span className="ag-chip-limit">HIT LIMIT</span>}
      </summary>

      <div className="ag-detail">
        {session.failed && session.errorMessage && (
          <div>
            <div className="ag-detail-section-label">ERROR</div>
            <p className="ag-error-message">
              {session.errorName ? `${session.errorName}: ` : ""}
              {session.errorMessage}
            </p>
          </div>
        )}

        {/* Full instruction */}
        {session.instruction && (
          <div>
            <div className="ag-detail-section-label">INSTRUCTION</div>
            <p className="ag-instruction-full">{session.instruction}</p>
          </div>
        )}

        {/* Tool steps timeline */}
        {hasToolSteps && (
          <div>
            <div className="ag-detail-section-label">TOOL STEPS ({session.toolSteps.length})</div>
            <div className="ag-steps-list">
              {session.toolSteps.map((step, i) => (
                <div key={`${step.step}-${i}`} className="ag-step-row">
                  <span className="ag-step-num">#{step.step}</span>
                  <span className="ag-step-tool">{step.tool}</span>
                  <span className="ag-step-time">{formatStepTime(step.timestamp)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {hasRuntimeMetadata && (
          <div>
            <div className="ag-detail-section-label">RUNTIME</div>
            <div className="ag-meta-grid">
              {session.runtime && (
                <div className="ag-meta-item">
                  <span className="ag-meta-label">Runtime</span>
                  <span className="ag-meta-value">{session.runtime}</span>
                </div>
              )}
              {session.provider && (
                <div className="ag-meta-item">
                  <span className="ag-meta-label">Provider</span>
                  <span className="ag-meta-value">{session.provider}</span>
                </div>
              )}
              {session.model && (
                <div className="ag-meta-item">
                  <span className="ag-meta-label">Model</span>
                  <span className="ag-meta-value">{session.model}</span>
                </div>
              )}
              {session.currentUrl && (
                <div className="ag-meta-item">
                  <span className="ag-meta-label">URL</span>
                  <span className="ag-meta-value">{session.currentUrl}</span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Session metadata */}
        {hasMetadata && (
          <div>
            <div className="ag-detail-section-label">SESSION METADATA</div>
            <div className="ag-meta-grid">
              {session.guildId && (
                <div className="ag-meta-item">
                  <span className="ag-meta-label">Guild</span>
                  <span className="ag-meta-value">{session.guildId}</span>
                </div>
              )}
              {session.channelId && (
                <div className="ag-meta-item">
                  <span className="ag-meta-label">Channel</span>
                  <span className="ag-meta-value">{session.channelId}</span>
                </div>
              )}
              {session.userId && (
                <div className="ag-meta-item">
                  <span className="ag-meta-label">User</span>
                  <span className="ag-meta-value">{session.userId}</span>
                </div>
              )}
              <div className="ag-meta-item">
                <span className="ag-meta-label">Session ID</span>
                <span className="ag-meta-value">{session.sessionId}</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </details>
  );
}

// ---- AgentsTab (main) ----

export default function AgentsTab() {
  const { selectedGuildId, selectedGuild } = useDashboardGuildScope();
  const { data } = usePolling(
    () => {
      const params = new URLSearchParams({
        sinceHours: "24",
        limit: "50"
      });
      if (selectedGuildId) params.set("guildId", selectedGuildId);
      return api<BrowserSessionsResponse>(`/api/agents/browser-sessions?${params.toString()}`);
    },
    30_000
  );

  const sessions = Array.isArray(data?.sessions) ? data.sessions : [];

  if (sessions.length === 0) {
    return (
      <section className="ag-container">
        <div className="ag-empty">
          <span className="ag-empty-icon">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="2" y1="12" x2="22" y2="12" />
              <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
            </svg>
          </span>
          <p>
            {selectedGuild?.name
              ? `No browser sessions for ${selectedGuild.name} in the last 24 hours.`
              : "No browser sessions in the last 24 hours."}
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="ag-container">
      <div className="ag-header-bar">
        <span className="ag-header-bar-label">BROWSER SESSIONS</span>
        <span className="ag-header-bar-count">{sessions.length}</span>
      </div>
      <div className="ag-feed">
        {sessions.map((session) => (
          <SessionCard key={session.sessionId} session={session} />
        ))}
      </div>
    </section>
  );
}
