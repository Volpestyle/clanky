import { useState } from "react";
import { SettingsSection } from "../SettingsSection";
import { api } from "../../api";

type ProviderStatus = {
  key: string;
  label: string;
  authed: boolean;
  authType: "api_key" | "oauth";
  oauthProvider?: "openai" | "claude";
};

function getProviderStatuses(form: Record<string, unknown>): ProviderStatus[] {
  return [
    { key: "anthropic", label: "Anthropic", authed: Boolean(form.providerAuthAnthropic), authType: "api_key" },
    { key: "claude-oauth", label: "Claude OAuth", authed: Boolean(form.providerAuthClaudeOauth), authType: "oauth", oauthProvider: "claude" },
    { key: "openai", label: "OpenAI", authed: Boolean(form.providerAuthOpenai), authType: "api_key" },
    { key: "openai-oauth", label: "OpenAI OAuth", authed: Boolean(form.providerAuthOpenaiOauth), authType: "oauth", oauthProvider: "openai" },
    { key: "xai", label: "xAI", authed: Boolean(form.providerAuthXai), authType: "api_key" }
  ];
}

export function ProviderAuthSettingsSection({
  id,
  form,
  onAuthChanged
}: {
  id: string;
  form: Record<string, unknown>;
  onAuthChanged?: () => void;
}) {
  const providers = getProviderStatuses(form);
  const [oauthStatus, setOauthStatus] = useState<{ text: string; type: "ok" | "error" | "" }>({ text: "", type: "" });
  const [busy, setBusy] = useState(false);
  const [claudeSessionKey, setClaudeSessionKey] = useState("");
  const [claudeCode, setClaudeCode] = useState("");
  const [showClaudeCodeInput, setShowClaudeCodeInput] = useState(false);

  const initiateOpenAiOAuth = async () => {
    setBusy(true);
    setOauthStatus({ text: "", type: "" });
    try {
      const result = await api<{ url: string; state: string }>("/api/oauth/openai/initiate", { method: "POST" });
      window.open(result.url, "_blank", "noopener");
      setOauthStatus({ text: "OpenAI auth page opened. Complete login in the new tab.", type: "ok" });
      // Poll for completion
      pollOAuthStatus("openai_oauth", "providerAuthOpenaiOauth");
    } catch (err) {
      setOauthStatus({ text: `Failed to start OpenAI OAuth: ${err instanceof Error ? err.message : err}`, type: "error" });
    } finally {
      setBusy(false);
    }
  };

  const initiateClaudeOAuth = async () => {
    setBusy(true);
    setOauthStatus({ text: "", type: "" });
    try {
      const result = await api<{ url: string; sessionKey: string }>("/api/oauth/claude/initiate", { method: "POST" });
      setClaudeSessionKey(result.sessionKey);
      setShowClaudeCodeInput(true);
      window.open(result.url, "_blank", "noopener");
      setOauthStatus({ text: "Claude auth page opened. After authorizing, copy the code and paste it below.", type: "ok" });
    } catch (err) {
      setOauthStatus({ text: `Failed to start Claude OAuth: ${err instanceof Error ? err.message : err}`, type: "error" });
    } finally {
      setBusy(false);
    }
  };

  const submitClaudeCode = async () => {
    if (!claudeCode.trim() || !claudeSessionKey) return;
    setBusy(true);
    setOauthStatus({ text: "", type: "" });
    try {
      await api("/api/oauth/claude/complete", {
        method: "POST",
        body: { code: claudeCode.trim(), sessionKey: claudeSessionKey }
      });
      setOauthStatus({ text: "Claude OAuth authenticated successfully. Provider is now active.", type: "ok" });
      setShowClaudeCodeInput(false);
      setClaudeCode("");
      setClaudeSessionKey("");
      onAuthChanged?.();
    } catch (err) {
      setOauthStatus({ text: `Claude code exchange failed: ${err instanceof Error ? err.message : err}`, type: "error" });
    } finally {
      setBusy(false);
    }
  };

  const pollOAuthStatus = (providerKey: string, _formKey: string) => {
    let attempts = 0;
    const maxAttempts = 60; // 2 minutes of polling
    const interval = setInterval(async () => {
      attempts++;
      if (attempts > maxAttempts) {
        clearInterval(interval);
        return;
      }
      try {
        const status = await api<Record<string, boolean>>("/api/oauth/status");
        if (status[providerKey]) {
          clearInterval(interval);
          setOauthStatus({ text: "Authentication successful. Provider is now active.", type: "ok" });
          onAuthChanged?.();
        }
      } catch {
        // ignore polling errors
      }
    }, 2000);
  };

  return (
    <SettingsSection id={id} title="Provider Authentication">
      <div className="provider-auth-table-wrap">
        <table className="provider-auth-table">
          <thead>
            <tr style={{ borderBottom: "1px solid var(--line)" }}>
              <th style={{ textAlign: "left", padding: "4px 8px", fontWeight: 600 }}>Provider</th>
              <th style={{ textAlign: "left", padding: "4px 8px", fontWeight: 600 }}>Type</th>
              <th style={{ textAlign: "left", padding: "4px 8px", fontWeight: 600 }}>Status</th>
              <th style={{ textAlign: "right", padding: "4px 8px", fontWeight: 600 }}></th>
            </tr>
          </thead>
          <tbody>
            {providers.map((p) => (
              <tr key={p.key} style={{ borderBottom: "1px solid var(--line)" }}>
                <td style={{ padding: "6px 8px" }}>{p.label}</td>
                <td style={{ padding: "6px 8px", color: "var(--ink-2)" }}>
                  {p.authType === "api_key" ? "API key" : "OAuth"}
                </td>
                <td style={{ padding: "6px 8px" }}>
                  {p.authed
                    ? <span style={{ color: "var(--success)" }}>Authenticated</span>
                    : <span style={{ color: "var(--danger)" }}>Not configured</span>
                  }
                </td>
                <td style={{ padding: "6px 8px", textAlign: "right" }}>
                  {!p.authed && p.authType === "oauth" && p.oauthProvider === "openai" && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={initiateOpenAiOAuth}
                      style={{
                        fontSize: "0.76rem",
                        padding: "3px 10px",
                        background: "transparent",
                        color: "var(--accent)",
                        border: "1px solid var(--accent)",
                        borderRadius: "var(--radius-sm)",
                        cursor: busy ? "wait" : "pointer"
                      }}
                    >
                      Authenticate
                    </button>
                  )}
                  {!p.authed && p.authType === "oauth" && p.oauthProvider === "claude" && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={initiateClaudeOAuth}
                      style={{
                        fontSize: "0.76rem",
                        padding: "3px 10px",
                        background: "transparent",
                        color: "var(--accent)",
                        border: "1px solid var(--accent)",
                        borderRadius: "var(--radius-sm)",
                        cursor: busy ? "wait" : "pointer"
                      }}
                    >
                      Authenticate
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showClaudeCodeInput && (
        <div style={{ marginTop: 12 }}>
          <label htmlFor="claude-oauth-code" style={{ fontSize: "0.84rem" }}>
            Paste the authorization code from Claude:
          </label>
          <div className="provider-auth-code-row">
            <input
              id="claude-oauth-code"
              type="text"
              value={claudeCode}
              onChange={(e) => setClaudeCode(e.target.value)}
              placeholder="Paste code here"
              style={{ flex: 1 }}
            />
            <button
              type="button"
              disabled={busy || !claudeCode.trim()}
              onClick={submitClaudeCode}
              style={{
                flex: "0 0 auto",
                padding: "6px 14px",
                fontSize: "0.8rem",
                fontWeight: 600
              }}
            >
              {busy ? "Exchanging..." : "Submit"}
            </button>
          </div>
        </div>
      )}

      {oauthStatus.text && (
        <p className={`status-msg ${oauthStatus.type}`} role="status" style={{ marginTop: 8 }}>
          {oauthStatus.text}
        </p>
      )}

      <p className="status-msg" role="status" style={{ marginTop: 8 }}>
        API key providers are configured via environment variables. OAuth providers can be authenticated here.
        After authenticating, restart the bot process to activate the new credentials.
      </p>
    </SettingsSection>
  );
}
