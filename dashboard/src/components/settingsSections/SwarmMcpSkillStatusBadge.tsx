import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api";

type SwarmMcpSkillCheck = {
  scope: "global" | "workspace";
  workspaceRoot: string | null;
  path: string;
  installed: boolean;
};

type SwarmMcpSkillStatus = {
  available: boolean;
  globalInstalled: boolean;
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

/**
 * Prompt above the code-agent enable toggle that shows whether the bundled
 * `swarm-mcp` skill is discoverable by Claude Code subagents. Renders before
 * the toggle (always visible) so operators install the skill before flipping
 * the code agent on. When missing, surfaces a one-click install button (uses
 * the vendored submodule at mcp-servers/swarm-mcp) and copy-pasteable symlink
 * commands.
 *
 * Skill install state only changes when an operator installs the skill (via
 * the button or `ln -s`), so this checks once on mount. A "Recheck" button
 * lets operators re-poll after a manual install.
 */
export function SwarmMcpSkillStatusBadge() {
  const [status, setStatus] = useState<SwarmMcpSkillStatus | null>(null);
  const [error, setError] = useState<string>("");
  const [rechecking, setRechecking] = useState(false);
  const [installing, setInstalling] = useState<null | "global" | string>(null);
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
    async (scope: "global" | "workspace", workspaceRoot?: string) => {
      const key = scope === "global" ? "global" : workspaceRoot || "";
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
    const installedPaths = status.checks
      .filter((check) => check.installed)
      .map((check) => check.path)
      .join(", ");
    return (
      <div
        className="swarm-server-status-badge swarm-server-status-badge--ok"
        title={installedPaths}
      >
        ✓ swarm-mcp skill installed{status.globalInstalled ? " (global)" : ""}
      </div>
    );
  }

  const installButtonStyle: React.CSSProperties = {
    marginRight: 6,
    padding: "3px 10px",
    fontSize: "0.74rem",
    fontWeight: 600,
    cursor: "pointer"
  };

  return (
    <div className="swarm-server-status-badge swarm-server-status-badge--warn">
      <strong>✗ swarm-mcp skill not installed.</strong> Install it before enabling
      the code agent so spawned Claude Code subagents pick up the bundled
      coordination playbook.
      {recheckButton}
      <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
        <button
          type="button"
          onClick={() => void install("global")}
          disabled={installing !== null}
          style={installButtonStyle}
        >
          {installing === "global" ? "Installing…" : "Install globally (~/.claude/skills/swarm-mcp)"}
        </button>
        {status?.missingWorkspaceRoots?.map((root) => (
          <button
            key={root}
            type="button"
            onClick={() => void install("workspace", root)}
            disabled={installing !== null}
            style={installButtonStyle}
            title={`Install symlinks at ${root}/.claude/skills and ${root}/.agents/skills`}
          >
            {installing === root ? "Installing…" : `Install in ${root}`}
          </button>
        ))}
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
{`# Global (one-time, applies to all projects)
mkdir -p ~/.claude/skills
ln -s /absolute/path/to/swarm-mcp/skills/swarm-mcp ~/.claude/skills/swarm-mcp

# Or per-workspace, run inside each allowed coding workspace root:
mkdir -p .agents/skills .claude/skills
ln -s /absolute/path/to/swarm-mcp/skills/swarm-mcp .agents/skills/swarm-mcp
ln -s ../../.agents/skills/swarm-mcp .claude/skills/swarm-mcp`}
        </pre>
      </details>
    </div>
  );
}
