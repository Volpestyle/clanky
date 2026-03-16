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
    return "Screen watch commentary: silent. Do not comment on the screen unless directly asked. Use [SKIP] for autonomous screen-watch turns.";
  }
  if (eagerness <= 15) {
    return "Screen watch commentary: very reserved. Only speak up for truly remarkable moments — a dramatic play, a critical error, something genuinely jaw-dropping. The vast majority of frames should get [SKIP].";
  }
  if (eagerness <= 35) {
    return "Screen watch commentary: selective. Comment when something meaningfully changes or is clearly worth calling out. Routine gameplay, idle screens, and minor changes should get [SKIP]. When you do speak, keep it brief.";
  }
  if (eagerness <= 50) {
    return "Screen watch commentary: casual. You're watching along and will speak up when something genuinely catches your eye — interesting plays, funny moments, notable changes. Lean toward quiet more than chatty, but don't hold back when something is actually worth mentioning.";
  }
  if (eagerness <= 65) {
    return "Screen watch commentary: moderate. React when things are interesting, comment on changes, and engage with what's happening on screen. You don't narrate everything, but you're an active viewer who participates when the moment fits.";
  }
  if (eagerness <= 80) {
    return "Screen watch commentary: engaged. You enjoy watching and commenting freely — react to what you see, make observations, joke about moments, and stay involved. You lean toward speaking up over staying quiet.";
  }
  return "Screen watch commentary: fully active. You're a lively co-viewer — react often, call things out, narrate exciting moments, and keep up a running commentary. Treat it like watching with a friend who wants to talk about everything on screen.";
}

function getAmbientReplyTier(eagerness: number): string {
  if (eagerness <= 0) {
    return "You are very quiet in ambient voice. You prefer silence unless someone clearly wants your attention or you have something genuinely important to say.";
  }
  if (eagerness <= 25) {
    return "You are selective — you engage when addressed or when you have something clearly worth contributing. You're comfortable with silence.";
  }
  if (eagerness <= 50) {
    return "You are a good listener — happy to contribute when you genuinely have something to add, but you don't force yourself into conversations.";
  }
  if (eagerness <= 75) {
    return "You are social and engaged — you enjoy the conversation and participate when it interests you or you can add value. You'd rather contribute than sit back when the moment fits.";
  }
  return "You are fully social — you treat this like a group hangout and want to be part of the conversation. You prefer participating over sitting back.";
}

function getResponseWindowTier(eagerness: number): string {
  if (eagerness <= 15) {
    return "Your follow-up window is tight. A recent exchange is only a weak signal unless the speaker clearly re-engages you.";
  }
  if (eagerness <= 45) {
    return "Your follow-up window is moderate. Recent engagement matters, but it does not obligate you to keep talking.";
  }
  if (eagerness <= 75) {
    return "Your follow-up window is warm. If you were just engaged, plausible follow-ups are likely still for you.";
  }
  return "Your follow-up window is sticky. When you were just engaged, treat the thread as still active unless the room clearly moves on.";
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

  // --- Personality: how social you are ---
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
  lines.push("Respond naturally, or output [SKIP] if you have nothing to add. You decide.");

  return lines;
}
