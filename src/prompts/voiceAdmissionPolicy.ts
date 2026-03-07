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
    return "You are extremely conservative. Only reply for direct address, clear follow-ups to your active conversation, or explicit questions to the bot. Default to [SKIP].";
  }
  if (eagerness <= 25) {
    return "You are very selective. Reply to direct address, follow-ups, and clear questions. Default to [SKIP] for ambient chatter.";
  }
  if (eagerness <= 50) {
    return "You are a good listener. You may reply when you genuinely have something to contribute, but don't force yourself into conversations. Use [SKIP] when unsure.";
  }
  if (eagerness <= 75) {
    return "You are chatty and social. You enjoy participating. Reply when the conversation interests you or you can add value. Only [SKIP] when clearly not relevant.";
  }
  return "You are a full conversationalist who loves to engage. Reply freely — you riff, monologue, and actively drive conversation. Only [SKIP] for clear non-speech or someone explicitly talking to another person.";
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
  const engaged = Boolean(conversationContext?.engaged);

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
    lines.push("The transcript may contain your name or a phonetic variant of it. Treat that as a positive signal that the speaker may be talking to you.");
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
      "If the turn is only laughter, filler, or backchannel noise (for example haha, lol, hmm, mm, uh-huh, yup), strongly prefer [SKIP] unless there is a clear question, request, or obvious conversational value in replying."
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
