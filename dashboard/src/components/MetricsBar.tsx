import Skeleton from "./Skeleton";
import { formatUptime } from "../utils";
import { StatusDot } from "./ui";

interface MetricTile {
  label: string;
  value: string;
  category: "text" | "voice" | "system";
}

export default function MetricsBar({ stats }) {
  if (!stats) {
    return (
      <section className="metrics-wrap">
        <div className="runtime-banner panel">
          <Skeleton width="200px" height="1.1em" />
        </div>
        <div className="metrics-grid">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="metric-tile panel">
              <Skeleton width="60%" height="0.7em" />
              <Skeleton width="40%" height="1.2em" style={{ marginTop: 6 }} />
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

  const tiles: MetricTile[] = [
    { label: "Replies", value: String(s?.last24h?.sent_reply || 0), category: "text" },
    { label: "Drop-ins", value: String(Number(s?.last24h?.sent_message || 0) + Number(s?.last24h?.initiative_post || 0)), category: "text" },
    { label: "Reactions", value: String(s?.last24h?.reacted || 0), category: "text" },
    { label: "Searches", value: String(s?.last24h?.search_call || 0), category: "text" },
    { label: "Memory", value: String(s?.last24h?.memory_extract_call || 0), category: "text" },
    { label: "VC Sessions", value: String(s?.last24h?.voice_session_start || 0), category: "voice" },
    { label: "Sounds", value: String(s?.last24h?.voice_soundboard_play || 0), category: "voice" },
    { label: "VC Errors", value: String(s?.last24h?.voice_error || 0), category: "voice" },
    { label: "Total Cost", value: `$${Number(s?.totalCostUsd || 0).toFixed(2)}`, category: "system" },
    { label: "Video Ctx", value: String(s?.last24h?.video_context_call || 0), category: "system" },
    { label: "GIFs", value: String(s?.last24h?.gif_call || 0), category: "system" },
    { label: "Images", value: String(s?.last24h?.image_call || 0), category: "system" },
  ];

  const extraTiles: { label: string; value: string }[] = [];
  if (publicHttpsValue !== "disabled") {
    extraTiles.push({ label: "Public HTTPS", value: publicHttpsValue });
  }
  if (screenShareActive > 0) {
    extraTiles.push({ label: "Screen Watch", value: String(screenShareActive) });
  }

  return (
    <section className="metrics-wrap">
      <div className="runtime-banner panel">
        <div className="runtime-banner-left">
          <StatusDot online={isOnline} />
          <span className="runtime-label">
            {isOnline
              ? `Online — ${runtime.guildCount} guild${runtime.guildCount !== 1 ? "s" : ""}`
              : "Connecting..."}
          </span>
        </div>
        {isOnline && uptimeMs > 0 && (
          <span className="runtime-uptime">uptime {formatUptime(uptimeMs)}</span>
        )}
      </div>

      <div className="metrics-grid">
        {tiles.map((tile) => (
          <article key={tile.label} className={`metric-tile metric-tile-${tile.category}`}>
            <span className="metric-tile-cat">{tile.category}</span>
            <p className="metric-tile-label">{tile.label}</p>
            <p className="metric-tile-value">{tile.value}</p>
          </article>
        ))}
      </div>

      {extraTiles.length > 0 && (
        <div className="metrics-extras">
          {extraTiles.map((t) => (
            <div key={t.label} className="metrics-extra-item">
              <span className="metrics-extra-label">{t.label}</span>
              <span className="metrics-extra-value">{t.value}</span>
            </div>
          ))}
        </div>
      )}
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
