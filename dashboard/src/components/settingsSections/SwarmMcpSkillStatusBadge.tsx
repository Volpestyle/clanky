import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api";

type SwarmMcpSkillCheck = {
  scope: "user" | "workspace";
  workspaceRoot: string | null;
  resolvedAt: string | null;
  searched: string[];
  installed: boolean;
};

type SwarmMcpSkillStatus = {
  available: boolean;
  userInstalled: boolean;
  checks: SwarmMcpSkillCheck[];
  missingWorkspaceRoots: string[];
  hint?: string;
};

type SkillInstallResult = {
  ok: boolean;
  reason?: string;
  source?: string;
  created: string[];
  skipped: string[];
};

type InstallScope = "user" | "workspace";

/**
 * Prompt above the code-agent enable toggle that shows whether the bundled
 * `swarm-mcp` skill is discoverable by Claude Code subagents. Renders before
 * the toggle (always visible) so operators install the skill before flipping
 * the code agent on.
 *
 * Discovery walks up each allowed workspace root to home, mirroring Claude
 * Code's own skill resolution. When missing, the prompt presents a scope
 * choice — install for the current user or for a specific workspace — backed
 * by one-click symlink creation against the vendored mcp-servers/swarm-mcp
 * submodule. Manual symlink commands are shown as a fallback.
 */
export function SwarmMcpSkillStatusBadge() {
  const [status, setStatus] = useState<SwarmMcpSkillStatus | null>(null);
  const [error, setError] = useState<string>("");
  const [rechecking, setRechecking] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const [installMessage, setInstallMessage] = useState<string>("");
  const cancelledRef = useRef(false);

  const fetchStatus = useCallback(async () => {
    setRechecking(true);
    try {
      const data = await api<SwarmMcpSkillStatus>("/api/swarm-mcp-skill-status");
      if (!cancelledRef.current) {
        setStatus(data);
        setError("");
      }
    } catch (err) {
      if (!cancelledRef.current) {
        setStatus(null);
        setError(String((err as Error)?.message || err));
      }
    } finally {
      if (!cancelledRef.current) setRechecking(false);
    }
  }, []);

  const install = useCallback(
    async (scope: InstallScope, workspaceRoot?: string) => {
      const key = scope === "user" ? "user" : workspaceRoot || "";
      setInstalling(key);
      setInstallMessage("");
      try {
        const result = await api<SkillInstallResult>("/api/swarm-mcp-skill-install", {
          method: "POST",
          body: { scope, workspaceRoot }
        });
        if (cancelledRef.current) return;
        if (!result.ok) {
          setInstallMessage(`Install failed: ${result.reason || "unknown error"}`);
        } else if (result.created.length === 0) {
          setInstallMessage("Already installed.");
        } else {
          setInstallMessage(`Installed: ${result.created.join(", ")}`);
        }
        await fetchStatus();
      } catch (err) {
        if (!cancelledRef.current) {
          setInstallMessage(`Install failed: ${(err as Error)?.message || String(err)}`);
        }
      } finally {
        if (!cancelledRef.current) setInstalling(null);
      }
    },
    [fetchStatus]
  );

  useEffect(() => {
    cancelledRef.current = false;
    void fetchStatus();
    return () => {
      cancelledRef.current = true;
    };
  }, [fetchStatus]);

  if (!status && !error) {
    return (
      <div className="swarm-server-status-badge swarm-server-status-badge--loading">
        Checking swarm-mcp skill…
      </div>
    );
  }

  const recheckButton = (
    <button
      type="button"
      onClick={() => void fetchStatus()}
      disabled={rechecking}
      style={{
        marginLeft: 8,
        padding: "2px 8px",
        fontSize: "0.72rem",
        fontWeight: 600,
        cursor: rechecking ? "default" : "pointer"
      }}
    >
      {rechecking ? "Rechecking…" : "Recheck"}
    </button>
  );

  if (error) {
    return (
      <div className="swarm-server-status-badge swarm-server-status-badge--error">
        swarm-mcp skill status unavailable: {error}
        {recheckButton}
      </div>
    );
  }

  if (status?.available) {
    const resolved = status.checks
      .filter((check) => check.installed && check.resolvedAt)
      .map((check) => check.resolvedAt as string)
      .join(", ");
    const summary = status.userInstalled
      ? "user-level"
      : "via workspace ancestor";
    return (
      <div
        className="swarm-server-status-badge swarm-server-status-badge--ok"
        title={resolved}
      >
        ✓ swarm-mcp skill installed ({summary})
      </div>
    );
  }

  const installButtonStyle: React.CSSProperties = {
    padding: "4px 10px",
    fontSize: "0.74rem",
    fontWeight: 600,
    cursor: "pointer"
  };

  const missingRoots = status?.missingWorkspaceRoots || [];
  const userBusy = installing === "user";

  return (
    <div className="swarm-server-status-badge swarm-server-status-badge--warn">
      <strong>✗ swarm-mcp skill not installed.</strong> Not found at any allowed
      workspace root, its ancestors, or the user-level skills directory. Install
      it before enabling the code agent so spawned Claude Code subagents pick up
      the bundled coordination playbook.
      {recheckButton}
      <div style={{ marginTop: 10 }}>
        <p style={{ fontSize: "0.76rem", margin: "0 0 6px", fontWeight: 600 }}>
          Choose install scope:
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          <button
            type="button"
            onClick={() => void install("user")}
            disabled={installing !== null}
            style={installButtonStyle}
            title="Symlink into ~/.claude/skills/swarm-mcp — applies to every project on this machine"
          >
            {userBusy ? "Installing…" : "User-level (~/.claude/skills/swarm-mcp)"}
          </button>
          {missingRoots.map((root) => {
            const busy = installing === root;
            return (
              <button
                key={root}
                type="button"
                onClick={() => void install("workspace", root)}
                disabled={installing !== null}
                style={installButtonStyle}
                title={`Symlink into ${root}/.claude/skills and ${root}/.agents/skills — applies only to that workspace`}
              >
                {busy ? "Installing…" : `Workspace (${root})`}
              </button>
            );
          })}
        </div>
        <p style={{ fontSize: "0.72rem", marginTop: 6, opacity: 0.8 }}>
          User-level applies everywhere. Workspace-level only applies to one root and its descendants.
        </p>
      </div>
      {installMessage && (
        <p style={{ fontSize: "0.74rem", marginTop: 6 }}>{installMessage}</p>
      )}
      <details style={{ marginTop: 6 }}>
        <summary style={{ cursor: "pointer", fontSize: "0.78rem" }}>
          Or install manually
        </summary>
        <pre
          style={{
            marginTop: 6,
            padding: "8px 10px",
            fontSize: "0.74rem",
            lineHeight: 1.4,
            overflowX: "auto",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all"
          }}
        >
{`# User-level (one-time, applies to every project)
mkdir -p ~/.claude/skills
ln -s /absolute/path/to/swarm-mcp/skills/swarm-mcp ~/.claude/skills/swarm-mcp

# Or workspace-level, run inside the workspace root:
mkdir -p .agents/skills .claude/skills
ln -s /absolute/path/to/swarm-mcp/skills/swarm-mcp .agents/skills/swarm-mcp
ln -s ../../.agents/skills/swarm-mcp .claude/skills/swarm-mcp`}
        </pre>
      </details>
    </div>
  );
}
