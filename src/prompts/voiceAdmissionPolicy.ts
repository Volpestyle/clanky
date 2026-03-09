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
  replyEagerness?: number;
  participantCount?: number;
  conversationContext?: VoiceAdmissionPolicyContext | null;
  pendingCommandFollowupSignal?: boolean;
  musicActive?: boolean;
  musicWakeLatched?: boolean;
};


function getEagernessGenerationTier(eagerness: number): string {
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
  return "You are fully social — you treat this like a group hangout and want to be part of the conversation. You riff, react, and actively engage. Only [SKIP] for clear non-speech or someone explicitly talking to another person.";
}

export function buildVoiceAdmissionPolicyLines({
  inputKind = "transcript",
  speakerName = "unknown",
  directAddressed = false,
  nameCueDetected = false,
  isEagerTurn = false,
  replyEagerness = 0,
  participantCount = 0,
  conversationContext = null,
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
  const normalizedEagerness = Math.max(0, Math.min(100, Number(replyEagerness) || 0));
  const engagedWithCurrentSpeaker = Boolean(conversationContext?.engagedWithCurrentSpeaker);
  const _engaged = Boolean(conversationContext?.engaged);

  lines.push(`Voice reply eagerness: ${normalizedEagerness}/100.`);
  lines.push(getEagernessGenerationTier(normalizedEagerness));

  if (normalizedParticipantCount <= 1) {
    lines.push("Single-human voice-room prior: default toward engagement unless the turn is clearly non-speech, self-talk, or low-value filler.");
  } else if (normalizedParticipantCount > 1) {
    lines.push("Multi-human room: avoid barging in without clear conversational value.");
  }

  if (normalizedInputKind === "event") {
    lines.push("This is a voice-room event cue, not literal quoted speech.");
    if (normalizedSpeakerName.toUpperCase() === "YOU") {
      lines.push("If you just entered the channel and a quick hello would feel natural, you may reply briefly. Otherwise use [SKIP].");
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
      lines.push("You are actively in this speaker's thread. Lean toward a short helpful reply over [SKIP].");
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
