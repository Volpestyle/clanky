import type { VoiceSession } from "../../hooks/useVoiceSSE";
import { Section } from "../ui";

export function ParticipantList({ session }: { session: VoiceSession }) {
  const ps = session.participants || [];
  if (ps.length === 0) return null;

  return (
    <Section title="Participants" badge={session.participantCount} defaultOpen>
      <div className="vm-participant-list">
        {ps.map((p) => (
          <div
            key={p.userId}
            className={`vm-participant ${session.focusedSpeaker?.userId === p.userId ? "vm-participant-focused" : ""}`}
          >
            <span className="vm-participant-name">{p.displayName}</span>
            {session.focusedSpeaker?.userId === p.userId && (
              <span className="vm-participant-tag">focused</span>
            )}
            <span className="vm-participant-id">{p.userId.slice(0, 6)}</span>
          </div>
        ))}
      </div>
    </Section>
  );
}
