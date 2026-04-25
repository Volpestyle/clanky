import { useEffect, useState } from "react";
import { api } from "../../api";

type SwarmServerStatus = {
  available: boolean;
  socketPath: string;
  hint?: string;
};

const POLL_INTERVAL_MS = 30_000;

/**
 * Lightweight pill showing whether `swarm-server` (the Rust daemon shipped
 * with `swarm-mcp`) is reachable. swarm-server is what gives Clanky-spawned
 * workers terminal visibility / takeover in `swarm-ui` and `swarm-ios`.
 *
 * When down, code workers still run — they just spawn headless. Operators
 * fix it by opening swarm-ui (which auto-starts the daemon) or running
 * `swarm-server` directly.
 */
export function SwarmServerStatusBadge() {
  const [status, setStatus] = useState<SwarmServerStatus | null>(null);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const data = await api<SwarmServerStatus>("/api/swarm-server-status");
        if (!cancelled) {
          setStatus(data);
          setError("");
        }
      } catch (err) {
        if (!cancelled) {
          setStatus(null);
          setError(String((err as Error)?.message || err));
        }
      }
    }

    void poll();
    const handle = window.setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, []);

  if (!status && !error) {
    return (
      <div className="swarm-server-status-badge swarm-server-status-badge--loading">
        Checking swarm-server…
      </div>
    );
  }

  if (error) {
    return (
      <div className="swarm-server-status-badge swarm-server-status-badge--error">
        swarm-server status unavailable: {error}
      </div>
    );
  }

  if (status?.available) {
    return (
      <div
        className="swarm-server-status-badge swarm-server-status-badge--ok"
        title={status.socketPath}
      >
        ✓ swarm-server running — code workers will be interactive in swarm-ui / swarm-ios
      </div>
    );
  }

  return (
    <div
      className="swarm-server-status-badge swarm-server-status-badge--warn"
      title={status?.socketPath}
    >
      <strong>✗ swarm-server not running.</strong>{" "}
      {status?.hint ||
        "Code workers will spawn headless (no terminal visibility in swarm-ui / swarm-ios)."}
    </div>
  );
}
