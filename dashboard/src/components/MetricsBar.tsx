import React from "react";
import Skeleton from "./Skeleton";
import { formatUptime } from "../utils";

export default function MetricsBar({ stats }) {
  if (!stats) {
    return (
      <section className="metrics-wrap">
        <div className="runtime-banner panel">
          <Skeleton width="200px" height="1.1em" />
        </div>
        <div className="metrics-clusters">
          {[0, 1, 2].map((i) => (
            <div key={i} className="metric-cluster">
              <Skeleton width="80px" height="0.7em" style={{ marginBottom: 8 }} />
              <div className="cluster-cards">
                {[0, 1, 2].map((j) => (
                  <div key={j} className="metric panel">
                    <Skeleton width="60%" height="0.7em" />
                    <Skeleton width="40%" height="1.2em" style={{ marginTop: 6 }} />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>
    );
  }

  const runtime = stats?.runtime;
  const s = stats?.stats;
  const isOnline = runtime?.isReady;
  const publicHttps = runtime?.publicHttps;
  const publicHttpsValue = formatPublicHttpsValue(publicHttps);
  const screenShareActive = Number(runtime?.screenShare?.activeCount || 0);
  const uptimeMs = Number(runtime?.uptimeMs || 0);

  const clusters = [
    {
      label: "Text Activity",
      cards: [
        { label: "Replies (24h)", value: String(s?.last24h?.sent_reply || 0) },
        { label: "Drop-ins (24h)", value: String(Number(s?.last24h?.sent_message || 0) + Number(s?.last24h?.discovery_post || 0)) },
        { label: "Reactions (24h)", value: String(s?.last24h?.reacted || 0) },
        { label: "Searches (24h)", value: String(s?.last24h?.search_call || 0) },
        { label: "Memory (24h)", value: String(s?.last24h?.memory_extract_call || 0) },
      ]
    },
    {
      label: "Voice Activity",
      cards: [
        { label: "Sessions (24h)", value: String(s?.last24h?.voice_session_start || 0) },
        { label: "Sounds (24h)", value: String(s?.last24h?.voice_soundboard_play || 0) },
        { label: "Errors (24h)", value: String(s?.last24h?.voice_error || 0) },
      ]
    },
    {
      label: "System",
      cards: [
        { label: "Total Cost", value: `$${Number(s?.totalCostUsd || 0).toFixed(6)}` },
        { label: "Video Ctx (24h)", value: String(s?.last24h?.video_context_call || 0) },
        { label: "GIFs (24h)", value: String(s?.last24h?.gif_call || 0) },
        { label: "Images (24h)", value: String(s?.last24h?.image_call || 0) },
        { label: "Public HTTPS", value: publicHttpsValue },
        { label: "Share Sessions", value: String(screenShareActive) },
      ]
    }
  ];

  return (
    <section className="metrics-wrap">
      <div className="runtime-banner panel">
        <span className={`status-dot${isOnline ? " online" : ""}`} />
        <span className="runtime-label">
          {isOnline
            ? `Online — ${runtime.guildCount} guild${runtime.guildCount !== 1 ? "s" : ""}`
            : "Connecting..."}
        </span>
        {isOnline && uptimeMs > 0 && (
          <span className="runtime-uptime">uptime {formatUptime(uptimeMs)}</span>
        )}
      </div>

      <div className="metrics-clusters">
        {clusters.map((cluster) => (
          <div key={cluster.label} className="metric-cluster">
            <p className="cluster-label">{cluster.label}</p>
            <div className="cluster-cards">
              {cluster.cards.map((c) => (
                <article key={c.label} className="metric panel">
                  <p className="label">{c.label}</p>
                  <p className="value">{c.value}</p>
                </article>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function formatPublicHttpsValue(publicHttps) {
  if (!publicHttps?.enabled) return "disabled";
  const url = String(publicHttps?.publicUrl || "").trim();
  if (url) return url.replace(/^https?:\/\//, "");
  const status = String(publicHttps?.status || "").trim().toLowerCase();
  if (!status) return "starting";
  if (status === "error") return "error";
  if (status === "ready") return "ready";
  if (status === "stopped") return "stopped";
  return "starting";
}
