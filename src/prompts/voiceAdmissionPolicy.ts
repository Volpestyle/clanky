import { normalizeVoiceRuntimeEventContext } from "../voice/voiceSessionHelpers.ts";
import { VOICE_TINY_REPLY_POLICY_LINE } from "./voiceLivePolicy.ts";

type VoiceAdmissionPolicyContext = {
  attentionMode?: "ACTIVE" | "AMBIENT";
  currentSpeakerActive?: boolean;
};

type VoiceAdmissionPolicyOptions = {
  inputKind?: "transcript" | "event";
  speakerName?: string;
  directAddressed?: boolean;
  nameCueDetected?: boolean;
  isEagerTurn?: boolean;
  ambientReplyEagerness?: number;
  responseWindowEagerness?: number;
  participantCount?: number;
  conversationContext?: VoiceAdmissionPolicyContext | null;
  runtimeEventContext?: unknown;
  pendingCommandFollowupSignal?: boolean;
  musicActive?: boolean;
  musicWakeLatched?: boolean;
};


export function getScreenWatchCommentaryTier(eagerness: number): string {
  if (eagerness <= 0) {
    return "Screen watch commentary bias: minimal. Prefer silence unless the moment clearly calls for a reaction or someone directly asks for one.";
  }
  if (eagerness <= 15) {
    return "Screen watch commentary bias: very low. Wait for unusually clear, notable, or surprising visual moments before reacting.";
  }
  if (eagerness <= 35) {
    return "Screen watch commentary bias: selective. Favor reacting to meaningful changes or clearly notable moments over routine visual churn.";
  }
  if (eagerness <= 50) {
    return "Screen watch commentary bias: moderate-low. A visible moment that is interesting, funny, or newly notable is often worth a short reaction.";
  }
  if (eagerness <= 65) {
    return "Screen watch commentary bias: moderate. Fresh visual developments are reasonably likely to merit a short reaction, without turning into constant narration.";
  }
  if (eagerness <= 80) {
    return "Screen watch commentary bias: high. When the screen presents a fresh watchable moment, lean toward reacting rather than staying silent.";
  }
  return "Screen watch commentary bias: very high. Frequent short reactions are appropriate when the screen keeps presenting fresh moments worth calling out.";
}

function getAmbientReplyTier(eagerness: number): string {
  if (eagerness <= 0) {
    return "Ambient reply bias: minimal. Prefer silence unless someone clearly engages you or the moment strongly warrants a reply.";
  }
  if (eagerness <= 25) {
    return "Ambient reply bias: low. Favor replies when directly engaged or when you have something clearly worth adding.";
  }
  if (eagerness <= 50) {
    return "Ambient reply bias: moderate. Contribute when you genuinely have something to add, without treating every room moment as a prompt to speak.";
  }
  if (eagerness <= 75) {
    return "Ambient reply bias: high. Lean toward joining room conversation when the moment plausibly invites your participation.";
  }
  return "Ambient reply bias: very high. In shared room conversation, participation is strongly favored unless silence is clearly better.";
}

function getResponseWindowTier(eagerness: number): string {
  if (eagerness <= 15) {
    return "Response-window bias: narrow. Recent engagement is only a weak follow-up signal unless the speaker clearly reconnects to you.";
  }
  if (eagerness <= 45) {
    return "Response-window bias: moderate. Recent engagement matters, but it does not by itself make the next turn yours.";
  }
  if (eagerness <= 75) {
    return "Response-window bias: warm. If you were just engaged, plausible follow-ups are often still for you.";
  }
  return "Response-window bias: sticky. Recent engagement remains a strong signal that nearby follow-ups may still be for you.";
}

export function buildVoiceAdmissionPolicyLines({
  inputKind = "transcript",
  speakerName = "unknown",
  directAddressed = false,
  nameCueDetected = false,
  isEagerTurn: _isEagerTurn = false,
  ambientReplyEagerness = 0,
  responseWindowEagerness = 0,
  participantCount = 0,
  conversationContext = null,
  runtimeEventContext = null,
  pendingCommandFollowupSignal = false,
  musicActive = false,
  musicWakeLatched = false
}: VoiceAdmissionPolicyOptions = {}) {
  const lines: string[] = [];
  const normalizedInputKind = String(inputKind || "").trim().toLowerCase() === "event"
    ? "event"
    : "transcript";
  const normalizedSpeakerName = String(speakerName || "").trim() || "unknown";
  const normalizedDirectAddressed = Boolean(directAddressed);
  const normalizedNameCueDetected = Boolean(nameCueDetected);
  const normalizedParticipantCount = Math.max(0, Math.floor(Number(participantCount) || 0));
  const normalizedAmbientEagerness = Math.max(0, Math.min(100, Number(ambientReplyEagerness) || 0));
  const normalizedResponseWindowEagerness = Math.max(
    0,
    Math.min(100, Number(responseWindowEagerness) || 0)
  );
  const normalizedRuntimeEventContext = normalizeVoiceRuntimeEventContext(runtimeEventContext);
  const currentSpeakerActive = Boolean(conversationContext?.currentSpeakerActive);

  // --- Eagerness settings ---
  lines.push(`Voice ambient-reply eagerness: ${normalizedAmbientEagerness}/100.`);
  lines.push(getAmbientReplyTier(normalizedAmbientEagerness));
  lines.push(`Response-window eagerness: ${normalizedResponseWindowEagerness}/100.`);
  lines.push(getResponseWindowTier(normalizedResponseWindowEagerness));

  // --- Room context signals ---
  if (normalizedParticipantCount <= 1) {
    lines.push("Room: 1:1 — you are the only other presence, so speech is more likely meant for you.");
  } else {
    lines.push(`Room: ${normalizedParticipantCount} humans present.`);
  }

  if (normalizedDirectAddressed) {
    lines.push(`Addressing: ${normalizedSpeakerName} used your name or wake phrase directly.`);
  } else if (normalizedNameCueDetected) {
    lines.push(`Addressing: your name appeared in ${normalizedSpeakerName}'s transcript, though not as a direct wake phrase.`);
  } else {
    lines.push(`Addressing: no direct address or name cue detected from ${normalizedSpeakerName}.`);
  }

  if (currentSpeakerActive) {
    lines.push("Thread state: you are actively in a thread with this speaker.");
  }

  if (musicActive) {
    lines.push("Music is currently playing. Music audio often bleeds into the mic and produces garbled or nonsensical transcripts.");
    if (musicWakeLatched) {
      lines.push("Music wake latch is active — someone recently addressed you over music.");
    }
  }

  if (pendingCommandFollowupSignal) {
    lines.push("Signal: this may be a same-speaker command follow-up (e.g. music disambiguation).");
  }

  // --- Input type context ---
  if (normalizedInputKind === "event") {
    lines.push("This is a voice-room event cue, not literal quoted speech.");
    if (
      normalizedRuntimeEventContext?.category === "membership" &&
      normalizedRuntimeEventContext.eventType === "join" &&
      normalizedRuntimeEventContext.actorRole === "self"
    ) {
      lines.push("Event: you just entered the channel.");
    } else if (
      normalizedRuntimeEventContext?.category === "membership" &&
      normalizedRuntimeEventContext.eventType === "join"
    ) {
      lines.push("Event: someone joined the channel.");
    } else if (
      normalizedRuntimeEventContext?.category === "membership" &&
      normalizedRuntimeEventContext.eventType === "leave"
    ) {
      lines.push("Event: someone left the channel.");
    } else if (normalizedRuntimeEventContext?.category === "screen_share") {
      lines.push("Event: screen-watch state change.");
      if (normalizedRuntimeEventContext.hasVisibleFrame) {
        lines.push("A visible screen frame is attached.");
      }
    }
  }

  // --- Transcript quality reminder ---
  lines.push("Transcripts come from speech-to-text and can be garbled, nonsensical, or misheard.");

  // --- Output guidance ---
  lines.push(VOICE_TINY_REPLY_POLICY_LINE);
  lines.push("Output exactly [SKIP] when silence is best.");

  return lines;
}
