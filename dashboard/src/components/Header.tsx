import { useState } from "react";
import { ApiError, createDashboardSession, destroyDashboardSession, type DashboardAuthState } from "../api";
import { StatusDot } from "./ui";
import type { DashboardGuild } from "../guildScope";

type HeaderProps = {
  isReady?: boolean;
  authState?: DashboardAuthState | null;
  onAuthChanged?: () => Promise<void> | void;
  guilds?: DashboardGuild[];
  selectedGuildId?: string;
  onGuildChange?: (guildId: string) => void;
};

export default function Header({
  isReady,
  authState = null,
  onAuthChanged,
  guilds = [],
  selectedGuildId = "",
  onGuildChange
}: HeaderProps) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [notice, setNotice] = useState("");
  const [noticeType, setNoticeType] = useState<"" | "ok" | "error">("");

  const requiresToken = Boolean(authState?.requiresToken);
  const authenticated = Boolean(authState?.authenticated);
  const dashboardUnlocked = !requiresToken || authenticated;
  const configurationError = String(authState?.configurationError || "").trim();
  const statusText =
    requiresToken && !authenticated
      ? "AUTH REQUIRED"
      : isReady
        ? "SYSTEMS NOMINAL"
        : "CONNECTING";

  async function authenticate() {
    const token = value.trim();
    if (!token) {
      setNotice("Enter the dashboard token.");
      setNoticeType("error");
      return;
    }

    setBusy(true);
    try {
      await createDashboardSession(token);
      setValue("");
      setShowToken(false);
      setNotice("Session active on this browser.");
      setNoticeType("ok");
      await onAuthChanged?.();
    } catch (error) {
      const message =
        error instanceof ApiError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error);
      setNotice(message);
      setNoticeType("error");
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    setBusy(true);
    try {
      await destroyDashboardSession();
      setShowToken(false);
      setNotice("Session cleared.");
      setNoticeType("ok");
      await onAuthChanged?.();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setNotice(message);
      setNoticeType("error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <header className="hero">
      <div className="hero-strip">
        <div className="hero-left">
          <div className="hero-sigil">
            <StatusDot online={isReady} />
          </div>
          <div className="hero-ident">
            <span className="hero-tag">CLANKY</span>
            <span className="hero-divider" />
            <span className="hero-label">CONTROL ROOM</span>
          </div>
        </div>
        <div className="hero-right">
          {dashboardUnlocked && guilds.length > 0 && onGuildChange ? (
            <label className="hero-guild-scope">
              <span className="hero-guild-label">Guild</span>
              <select
                className="hero-guild-select"
                value={selectedGuildId}
                onChange={(event) => onGuildChange(event.target.value)}
                disabled={guilds.length <= 1}
                aria-label="Selected guild"
              >
                {guilds.map((guild) => (
                  <option key={guild.id} value={guild.id}>
                    {guild.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <span className={`hero-status${isReady && (!requiresToken || authenticated) ? " online" : ""}`}>
            {statusText}
          </span>
          {requiresToken && (
            <button
              type="button"
              className="gear-btn"
              onClick={() => setShowToken((current) => !current)}
              aria-label="Dashboard access"
              title="Dashboard access"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
          )}
        </div>
      </div>
      {showToken && requiresToken && (
        <div className="token-dropdown">
          {configurationError ? (
            <p className="status-msg error" role="status">
              Dashboard auth is misconfigured: {configurationError}
            </p>
          ) : authenticated ? (
            <div className="stack">
              <p className="status-msg ok" role="status">
                Dashboard session active on this browser.
              </p>
              <div className="token-row">
                <button type="button" onClick={logout} disabled={busy}>
                  {busy ? "Signing out..." : "Log out"}
                </button>
              </div>
            </div>
          ) : (
            <>
              <label htmlFor="dashboard-token">Dashboard token</label>
              <div className="token-row">
                <input
                  id="dashboard-token"
                  type="password"
                  placeholder="required"
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  style={{ width: "220px" }}
                />
                <button type="button" onClick={authenticate} disabled={busy}>
                  {busy ? "Unlocking..." : "Unlock"}
                </button>
              </div>
            </>
          )}
          {notice && !configurationError && (
            <p className={`status-msg ${noticeType || "ok"}`} role="status">
              {notice}
            </p>
          )}
        </div>
      )}
    </header>
  );
}
