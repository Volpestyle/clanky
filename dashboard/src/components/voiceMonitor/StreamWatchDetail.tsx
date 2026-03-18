import type { VoiceSession } from "../../hooks/useVoiceSSE";
import { CopyButton, Section } from "../ui";
import { formatApproxBytes, relativeTime, Stat } from "./shared";

export function StreamWatchDetail({ session }: { session: VoiceSession }) {
  const sw = session.streamWatch;
  const visualFeed = Array.isArray(sw.visualFeed) ? sw.visualFeed : [];
  const notePayload = sw.notePayload;
  const hasBrainPayloadNotes =
    Boolean(notePayload && Array.isArray(notePayload.notes) && notePayload.notes.length > 0);
  const hasAnyStreamWatchData =
    Boolean(sw.active) ||
    Number(sw.ingestedFrameCount || 0) > 0 ||
    Boolean(sw.lastCommentaryNote) ||
    Boolean(sw.lastMemoryRecapText) ||
    visualFeed.length > 0 ||
    hasBrainPayloadNotes;
  if (!hasAnyStreamWatchData) return null;

  return (
    <Section title="Screen Watch" badge={sw.active ? "active" : "idle"} defaultOpen>
      <div className="vm-detail-grid">
        <Stat label="Target" value={sw.targetUserId?.slice(0, 8) || "none"} />
        <Stat label="Requested By" value={sw.requestedByUserId?.slice(0, 8) || "none"} />
        <Stat label="Frames" value={sw.ingestedFrameCount} />
        <Stat label="Window Frames" value={Number(sw.acceptedFrameCountInWindow || 0)} />
        {sw.frameWindowStartedAt && <Stat label="Window Started" value={relativeTime(sw.frameWindowStartedAt)} />}
        {sw.lastFrameAt && <Stat label="Last Frame" value={relativeTime(sw.lastFrameAt)} />}
        {sw.latestFrameAt && <Stat label="Latest Frame" value={relativeTime(sw.latestFrameAt)} />}
        {sw.latestFrameMimeType && <Stat label="Frame Mime" value={sw.latestFrameMimeType} />}
        {Number(sw.latestFrameApproxBytes || 0) > 0 && (
          <Stat label="Frame Size" value={formatApproxBytes(sw.latestFrameApproxBytes)} />
        )}
        {sw.lastCommentaryAt && <Stat label="Last Commentary" value={relativeTime(sw.lastCommentaryAt)} />}
        {sw.lastMemoryRecapAt && <Stat label="Last Recap" value={relativeTime(sw.lastMemoryRecapAt)} />}
        {sw.lastNoteAt && <Stat label="Last Screen Note" value={relativeTime(sw.lastNoteAt)} />}
        <Stat label="Screen Notes" value={Number(sw.noteCount || visualFeed.length)} />
        {(sw.lastMemoryRecapText || sw.lastMemoryRecapAt) && (
          <Stat label="Recap Saved" value={sw.lastMemoryRecapDurableSaved ? "durable" : "journal only"} />
        )}
        {(sw.lastNoteProvider || sw.lastNoteModel) && (
          <Stat
            label="Note Model"
            value={[sw.lastNoteProvider, sw.lastNoteModel].filter(Boolean).join(" / ")}
          />
        )}
      </div>

      {(sw.lastCommentaryNote || sw.lastCommentaryAt) && (
        <>
          <span className="vm-mini-label">Last Spoken Screen Commentary</span>
          <div className="vm-convo-context-summary">
            <div className="vm-convo-meta">
              <span className="vm-convo-role vm-convo-role-assistant">spoken</span>
              {sw.lastCommentaryAt && <span className="vm-convo-time">{relativeTime(sw.lastCommentaryAt)}</span>}
            </div>
            <div className="vm-convo-text">{sw.lastCommentaryNote || "(no saved line)"}</div>
          </div>
        </>
      )}

      {(sw.lastMemoryRecapText || sw.lastMemoryRecapAt || sw.lastMemoryRecapReason) && (
        <>
          <span className="vm-mini-label">Persisted Screen-Share Recap</span>
          <div className="vm-convo-context-summary">
            <div className="vm-convo-meta">
              <span className="vm-convo-role vm-convo-role-assistant">memory recap</span>
              {sw.lastMemoryRecapAt && <span className="vm-convo-time">{relativeTime(sw.lastMemoryRecapAt)}</span>}
              {sw.lastMemoryRecapReason && <span className="vm-convo-time">{sw.lastMemoryRecapReason}</span>}
              <span className="vm-convo-time">
                {sw.lastMemoryRecapDurableSaved ? "durable fact saved" : "journaled only"}
              </span>
            </div>
            <div className="vm-convo-text">{sw.lastMemoryRecapText || "(no recap text)"}</div>
          </div>
        </>
      )}

      {visualFeed.length > 0 && (
        <>
          <span className="vm-mini-label">Screen Note Feed</span>
          <div className="vm-convo-feed">
            {visualFeed
              .slice(-10)
              .reverse()
              .map((entry, index) => (
                <div key={`${entry.at || "na"}-${index}`} className="vm-convo-msg vm-convo-user">
                  <div className="vm-convo-meta">
                    <span className="vm-convo-role vm-convo-role-user">{entry.speakerName || "note loop"}</span>
                    {(entry.provider || entry.model) && (
                      <span className="vm-convo-time">
                        {[entry.provider, entry.model].filter(Boolean).join(" / ")}
                      </span>
                    )}
                    {entry.at && <span className="vm-convo-time">{relativeTime(entry.at)}</span>}
                  </div>
                  <div className="vm-convo-text">{entry.text}</div>
                </div>
              ))}
          </div>
        </>
      )}

      {notePayload?.prompt && (
        <>
          <span className="vm-mini-label">Prompt Note Context</span>
          <div className="vm-prompt-card">
            <div className="vm-prompt-card-header">
              <div className="vm-prompt-card-title">
                <span className="vm-prompt-title">Note Instruction</span>
                <span className="vm-prompt-meta">
                  {notePayload.lastAt ? relativeTime(notePayload.lastAt) : "no updates yet"}
                  {notePayload.provider || notePayload.model
                    ? ` · ${[notePayload.provider, notePayload.model].filter(Boolean).join(" / ")}`
                    : ""}
                </span>
              </div>
              <CopyButton text={notePayload.prompt || "(none)"} label />
            </div>
            <pre className="vm-prompt-pre">{notePayload.prompt || "(none)"}</pre>
          </div>
        </>
      )}

      {notePayload && Array.isArray(notePayload.notes) && notePayload.notes.length > 0 && (
        <>
          <span className="vm-mini-label">Injected Prompt Notes</span>
          <div className="vm-convo-feed">
            {notePayload.notes.map((note, index) => (
              <div key={`${index}-${note.slice(0, 18)}`} className="vm-convo-msg vm-convo-assistant">
                <div className="vm-convo-meta">
                  <span className="vm-convo-role vm-convo-role-assistant">context</span>
                </div>
                <div className="vm-convo-text">{note}</div>
              </div>
            ))}
          </div>
        </>
      )}
    </Section>
  );
}
