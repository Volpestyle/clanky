import { useEffect, useState } from "react";
import type { VoiceSession } from "../../hooks/useVoiceSSE";
import { Section } from "../ui";
import { relativeTime } from "./shared";

export function McpPanel({ session }: { session: VoiceSession }) {
  const servers = session.mcpStatus;
  const [, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 5000);
    return () => clearInterval(id);
  }, []);

  if (!servers || servers.length === 0) return null;

  const connectedCount = servers.filter((s) => s.connected).length;

  return (
    <Section title="MCP Servers" badge={`${connectedCount}/${servers.length}`} defaultOpen={false}>
      {servers.map((server) => (
        <div
          key={server.serverName}
          className={`vm-mcp-server ${server.connected ? "vm-mcp-connected" : "vm-mcp-disconnected"}`}
        >
          <div className="vm-mcp-header">
            <span className={`vm-mcp-dot ${server.connected ? "vm-mcp-dot-ok" : "vm-mcp-dot-err"}`} />
            <span className="vm-mcp-name">{server.serverName}</span>
            <span className="vm-mcp-tool-count">
              {server.tools.length} tool{server.tools.length !== 1 ? "s" : ""}
            </span>
          </div>
          {server.lastError && <div className="vm-mcp-error">{server.lastError}</div>}
          {server.tools.length > 0 && (
            <div className="vm-tools-list">
              {server.tools.map((tool) => (
                <span key={tool.name} className="vm-tool-chip vm-tool-mcp" title={tool.description}>
                  {tool.name}
                </span>
              ))}
            </div>
          )}
          <div className="vm-mcp-meta">
            {server.lastConnectedAt && (
              <span className="vm-mcp-meta-item">connected {relativeTime(server.lastConnectedAt)}</span>
            )}
            {server.lastCallAt && (
              <span className="vm-mcp-meta-item">last call {relativeTime(server.lastCallAt)}</span>
            )}
          </div>
        </div>
      ))}
    </Section>
  );
}
