import type { VoiceSession } from "../../hooks/useVoiceSSE";
import { Section } from "../ui";
import { formatTrackDuration, relativeTime, snippet, Stat } from "./shared";

export function MusicDetail({ session }: { session: VoiceSession }) {
  const music = session.music;
  if (!music) return null;

  const hasNowPlaying = music.active && music.lastTrackTitle;
  const hasDisambiguation = music.disambiguationActive && music.pendingResults.length > 0;
  const hasPendingSearch = Boolean(music.pendingQuery) && !hasDisambiguation;
  const hasAnyData =
    hasNowPlaying ||
    hasDisambiguation ||
    hasPendingSearch ||
    music.lastTrackTitle ||
    music.lastCommandAt;

  if (!hasAnyData) return null;

  return (
    <Section
      title="Music"
      badge={music.active ? "playing" : music.disambiguationActive ? "choosing" : "idle"}
      defaultOpen
    >
      {music.lastTrackTitle && (
        <div className="vm-music-now-playing">
          <div>
            <div className="vm-music-track-title">
              {music.lastTrackUrl ? (
                <a href={music.lastTrackUrl} target="_blank" rel="noopener noreferrer">
                  {music.lastTrackTitle}
                </a>
              ) : (
                music.lastTrackTitle
              )}
            </div>
            {music.lastTrackArtists.length > 0 && (
              <div className="vm-music-track-artists">{music.lastTrackArtists.join(", ")}</div>
            )}
          </div>
          {music.provider && <span className="vm-music-provider-badge">{music.provider}</span>}
        </div>
      )}

      {hasDisambiguation && (
        <div className="vm-music-disambiguation">
          <div className="vm-music-disambiguation-query">
            Choosing: &ldquo;{music.pendingQuery}&rdquo;
            {music.pendingPlatform && ` on ${music.pendingPlatform}`}
          </div>
          <div className="vm-music-disambiguation-list">
            {music.pendingResults.map((r) => (
              <div key={r.id} className="vm-music-result-row">
                <span className="vm-music-result-title">{r.title}</span>
                <span className="vm-music-result-artist">{r.artist}</span>
                <span className="vm-music-result-duration">{formatTrackDuration(r.durationSeconds)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {hasPendingSearch && (
        <div className="vm-music-pending">
          <span className="vm-music-pending-label">Searching</span>
          &ldquo;{music.pendingQuery}&rdquo;
          {music.pendingPlatform && ` on ${music.pendingPlatform}`}
        </div>
      )}

      <div className="vm-detail-grid">
        {music.lastCommandAt && <Stat label="Last Command" value={relativeTime(music.lastCommandAt)} />}
        {music.lastCommandReason && <Stat label="Reason" value={music.lastCommandReason} />}
        {music.source && <Stat label="Source" value={music.source} />}
        {music.lastRequestText && <Stat label="Request" value={snippet(music.lastRequestText, 60)} />}
        {music.startedAt && <Stat label="Started" value={relativeTime(music.startedAt)} />}
        {music.stoppedAt && <Stat label="Stopped" value={relativeTime(music.stoppedAt)} />}
      </div>
    </Section>
  );
}
