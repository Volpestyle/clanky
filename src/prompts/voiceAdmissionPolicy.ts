import { normalizeVoiceRuntimeEventContext } from "../voice/voiceSessionHelpers.ts";

type VoiceAdmissionPolicyContext = {
  engaged?: boolean;
  engagedWithCurrentSpeaker?: boolean;
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


function getAmbientReplyTier(eagerness: number): string {
  if (eagerness <= 0) {
    return "You are in lurker mode — you prefer to stay quiet unless someone clearly wants your attention or you have something genuinely important to say. Default to [SKIP].";
  }
  if (eagerness <= 25) {
    return "You are selective — you engage when addressed or when you have something clearly worth contributing. You're comfortable with silence and default to [SKIP] for ambient chatter.";
  }
  if (eagerness <= 50) {
    return "You are a good listener — happy to contribute when you genuinely have something to add, but you don't force yourself into conversations. Use [SKIP] when you're not sure you'd be adding value.";
  }
  if (eagerness <= 75) {
    return "You are social and engaged — you enjoy the conversation and participate when it interests you or you can add value. You'd rather contribute than sit back when the moment fits.";
  }
  return "You are fully social — you treat this like a group hangout and want to be part of the conversation. You prefer participating over sitting back, while still skipping clear non-speech or turns meant for someone else.";
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
  isEagerTurn = false,
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
  const normalizedIsEagerTurn = Boolean(isEagerTurn);
  const normalizedParticipantCount = Math.max(0, Math.floor(Number(participantCount) || 0));
  const normalizedAmbientEagerness = Math.max(0, Math.min(100, Number(ambientReplyEagerness) || 0));
  const normalizedResponseWindowEagerness = Math.max(
    0,
    Math.min(100, Number(responseWindowEagerness) || 0)
  );
  const normalizedRuntimeEventContext = normalizeVoiceRuntimeEventContext(runtimeEventContext);
  const engagedWithCurrentSpeaker = Boolean(conversationContext?.engagedWithCurrentSpeaker);
  const _engaged = Boolean(conversationContext?.engaged);

  lines.push(`Voice ambient-reply eagerness: ${normalizedAmbientEagerness}/100.`);
  lines.push(getAmbientReplyTier(normalizedAmbientEagerness));
  lines.push(`Response-window eagerness: ${normalizedResponseWindowEagerness}/100.`);
  lines.push(getResponseWindowTier(normalizedResponseWindowEagerness));

  if (normalizedParticipantCount <= 1) {
    lines.push("Single-human voice-room prior: default toward engagement unless the turn is clearly non-speech, self-talk, or low-value filler.");
  } else if (normalizedParticipantCount > 1) {
    lines.push("Multi-human room: avoid barging in without clear conversational value.");
  }

  if (normalizedInputKind === "event") {
    lines.push("This is a voice-room event cue, not literal quoted speech.");
    if (
      normalizedRuntimeEventContext?.category === "membership" &&
      normalizedRuntimeEventContext.eventType === "join" &&
      normalizedRuntimeEventContext.actorRole === "self"
    ) {
      lines.push("If you just entered the channel and a quick hello would feel natural, you may reply briefly. Otherwise use [SKIP].");
    } else if (
      normalizedRuntimeEventContext?.category === "membership" &&
      normalizedRuntimeEventContext.eventType === "join"
    ) {
      lines.push("If a brief acknowledgement of the join would feel natural, you may reply briefly. Otherwise use [SKIP].");
    } else if (
      normalizedRuntimeEventContext?.category === "membership" &&
      normalizedRuntimeEventContext.eventType === "leave"
    ) {
      lines.push("If a brief goodbye or acknowledgement of the leave would feel natural, you may reply briefly. Otherwise use [SKIP].");
    } else if (normalizedRuntimeEventContext?.category === "screen_share") {
      lines.push("This is a screen-share state cue, not a spoken request.");
      if (normalizedRuntimeEventContext.hasVisibleFrame) {
        lines.push("A visible screen frame is attached, so you may react to what is on-screen if there is a natural short comment.");
      }
      lines.push("If the screen-share moment gives you a real reaction or observation, reply briefly. Otherwise use [SKIP].");
    } else {
      lines.push("If a brief acknowledgement of the join/leave would feel natural, you may reply briefly. Otherwise use [SKIP].");
    }
  }

  if (!normalizedDirectAddressed && normalizedNameCueDetected) {
    lines.push("The transcript contains your name or a phonetic variant of it. This is a strong signal the speaker is talking to you — prefer responding unless the context clearly shows otherwise.");
  }

  if (musicActive) {
    lines.push("Music is currently active.");
    if (musicWakeLatched || normalizedDirectAddressed) {
      lines.push("Music wake latch is active for follow-ups, so no repeated wake word is required right now.");
    } else {
      lines.push("Music wake latch is not active; non-wake chatter during music should be denied.");
    }
  }

  if (pendingCommandFollowupSignal) {
    lines.push("Signal: this may be a same-speaker command follow-up. Treat as a strong positive context signal and prefer YES unless the transcript is unusable.");
  }

  if (normalizedIsEagerTurn) {
    lines.push("You were NOT directly addressed. You're considering whether to chime in.");
    if (engagedWithCurrentSpeaker) {
      if (normalizedResponseWindowEagerness <= 25) {
        lines.push("You are actively in this speaker's thread, but do not force a reply unless the continuation is clearly for you.");
      } else if (normalizedResponseWindowEagerness <= 70) {
        lines.push("You are actively in this speaker's thread. Lean toward a short helpful reply over [SKIP] when the continuation plausibly connects to you.");
      } else {
        lines.push("You are actively in this speaker's thread. Treat likely continuations as a live back-and-forth and reply naturally when you can add something.");
      }
    }
    lines.push(
      "If the turn is laughter, filler, backchannel noise (haha, lol, hmm, mm, uh-huh, yup), or self-talk/thinking out loud (for example 'where did I put my keys', 'hmm let me think', 'wait what was I doing'), strongly prefer [SKIP]. These are not directed at you even in a 1:1 room."
    );
    lines.push("Only speak up if you can genuinely add value. If not, output exactly [SKIP].");
    lines.push("Task: respond as a natural spoken VC reply, or skip if you have nothing to add.");
    return lines;
  }

  if (!normalizedDirectAddressed) {
    lines.push(
      "If the turn is only laughter, filler, or backchannel noise with no clear ask or meaningful new content, prefer [SKIP]."
    );
    lines.push("Task: decide whether to respond now or output [SKIP] if a reply would be interruptive, low-value, or likely not meant for you.");
    return lines;
  }

  lines.push("Task: respond as a natural spoken VC reply.");
  return lines;
}
