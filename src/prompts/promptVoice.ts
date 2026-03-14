import {
  buildVoiceSoundboardGuidanceLines,
} from "./promptCore.ts";

import {
  formatBehaviorMemoryFacts,
  formatWebSearchFindings,
  formatConversationWindows,
  formatConversationParticipantMemory
} from "./promptFormatters.ts";
import {
  buildWebSearchPolicyLine,
  buildWebToolRoutingPolicyLine,
  BROWSER_BROWSE_POLICY_LINE,
  CONVERSATION_SEARCH_POLICY_LINE,
  WEB_SCRAPE_POLICY_LINE
} from "./toolPolicy.ts";
import {
  buildActiveMusicReplyGuidanceLines,
  MUSIC_ACTIVE_AUTONOMY_POLICY_LINE,
  MUSIC_REPLY_HANDOFF_POLICY_LINE
} from "./voiceLivePolicy.ts";
import { hasBotNameCue } from "../bot/directAddressConfidence.ts";
import {
  formatVoiceChannelEffectSummary,
  normalizeVoiceRuntimeEventContext
} from "../voice/voiceSessionHelpers.ts";
import {
  buildVoiceAdmissionPolicyLines
} from "./voiceAdmissionPolicy.ts";
import { VOICE_TOOL_SCHEMAS } from "../tools/sharedToolSchemas.ts";
import type { VoiceSessionDurableContextEntry } from "../voice/voiceSessionTypes.ts";

type VoiceMusicPromptContext = {
  playbackState: "playing" | "paused" | "stopped" | "idle";
  replyHandoffMode: "duck" | "pause" | null;
  currentTrack: { id: string | null; title: string; artists: string[] } | null;
  lastTrack: { id: string | null; title: string; artists: string[] } | null;
  queueLength: number;
  upcomingTracks: Array<{ id: string | null; title: string; artist: string | null }>;
  lastAction: "play_now" | "stop" | "pause" | "resume" | "skip" | null;
  lastQuery: string | null;
};

const VOICE_CONTROL_TOOL_NAMES = VOICE_TOOL_SCHEMAS.map((schema) => schema.name);
const SESSION_CONTEXT_PROMPT_MAX_ENTRIES = 12;
const SESSION_CONTEXT_PROMPT_MAX_TOTAL_CHARS = 1_200;

function formatMusicPromptArtists(artists: string[] = []) {
  return artists.length ? artists.join(", ") : "unknown artist";
}

function areMusicPromptTracksEqual(
  left: VoiceMusicPromptContext["currentTrack"] | VoiceMusicPromptContext["lastTrack"],
  right: VoiceMusicPromptContext["currentTrack"] | VoiceMusicPromptContext["lastTrack"]
) {
  if (!left?.title || !right?.title) return false;
  const leftArtists = Array.isArray(left.artists) ? left.artists.join(" | ") : "";
  const rightArtists = Array.isArray(right.artists) ? right.artists.join(" | ") : "";
  return left.title === right.title && leftArtists === rightArtists;
}

function shouldRenderMusicPromptContext(musicContext: VoiceMusicPromptContext | null) {
  if (!musicContext) return false;
  return Boolean(
    musicContext.currentTrack?.title ||
    musicContext.lastTrack?.title ||
    musicContext.queueLength > 0 ||
    musicContext.lastAction ||
    musicContext.lastQuery
  );
}

function resolveMusicPromptDisplayState(musicContext: VoiceMusicPromptContext | null) {
  if (!musicContext) return "idle";
  if (
    musicContext.playbackState === "idle" &&
    (musicContext.currentTrack?.title || musicContext.lastTrack?.title)
  ) {
    return "stopped";
  }
  return musicContext.playbackState;
}

function collectAvailableVoiceToolNames({
  webSearchAvailable,
  browserBrowseAvailable,
  memoryAvailable,
  screenShareAvailable,
  voiceToolsAvailable
}: {
  webSearchAvailable: boolean;
  browserBrowseAvailable: boolean;
  memoryAvailable: boolean;
  screenShareAvailable: boolean;
  voiceToolsAvailable: boolean;
}): string[] {
  const names = new Set<string>(["conversation_search"]);

  if (webSearchAvailable) {
    names.add("web_search");
    names.add("web_scrape");
  }
  if (browserBrowseAvailable) names.add("browser_browse");
  if (memoryAvailable) {
    names.add("memory_write");
  }
  if (screenShareAvailable) names.add("start_screen_watch");
  if (voiceToolsAvailable) {
    for (const name of VOICE_CONTROL_TOOL_NAMES) names.add(name);
  }

  return Array.from(names);
}

function selectPromptDurableContextEntries(durableContext: unknown): VoiceSessionDurableContextEntry[] {
  const normalizedEntries: VoiceSessionDurableContextEntry[] = (Array.isArray(durableContext) ? durableContext : [])
    .map((entry) => {
      const text = String(entry?.text || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 240);
      if (!text) return null;
      const rawCategory = String(entry?.category || "").trim().toLowerCase();
      const category =
        rawCategory === "plan" ||
          rawCategory === "preference" ||
          rawCategory === "relationship"
          ? rawCategory
          : "fact";
      return {
        text,
        category,
        at: Number.isFinite(Number(entry?.at)) ? Math.round(Number(entry.at)) : Date.now()
      } satisfies VoiceSessionDurableContextEntry;
    })
    .filter((entry): entry is VoiceSessionDurableContextEntry => entry !== null)
    .sort((left, right) => Number(left.at || 0) - Number(right.at || 0));

  let totalChars = 0;
  const selected: VoiceSessionDurableContextEntry[] = [];
  for (let index = normalizedEntries.length - 1; index >= 0; index -= 1) {
    const entry = normalizedEntries[index];
    const nextChars = totalChars + entry.text.length + String(entry.category || "").length + 8;
    if (selected.length >= SESSION_CONTEXT_PROMPT_MAX_ENTRIES) break;
    if (selected.length > 0 && nextChars > SESSION_CONTEXT_PROMPT_MAX_TOTAL_CHARS) break;
    selected.push(entry);
    totalChars = nextChars;
  }
  return selected.reverse();
}

export function buildVoiceTurnPrompt({
  speakerName = "unknown",
  transcript = "",
  inputKind = "transcript",
  directAddressed = false,
  participantProfiles = [],
  selfFacts = [],
  loreFacts = [],
  userFacts: _userFacts = [],
  relevantFacts: _relevantFacts = [],
  guidanceFacts = [],
  behavioralFacts = [],
  isEagerTurn: _isEagerTurn = false,
  voiceAmbientReplyEagerness = 0,
  responseWindowEagerness = 0,
  conversationContext = null,
  runtimeEventContext = null,
  sessionTiming = null,
  botName = "the bot",
  participantRoster = [],
  recentMembershipEvents = [],
  recentVoiceEffectEvents = [],
  soundboardCandidates = [],
  soundboardEagerness = 0,
  webSearch = null,
  browserBrowse = null,
  recentConversationHistory = [],
  allowWebSearchToolCall = false,
  allowBrowserBrowseToolCall = false,
  screenShare: _screenShare = null,
  allowScreenShareToolCall = false,
  screenWatchActive = false,
  screenWatchFrameReady = false,
  allowMemoryToolCalls = false,
  allowSoundboardToolCall = false,
  allowInlineSoundboardDirectives = false,
  allowVoiceToolCalls = false,
  musicContext = null,
  hasDirectVisionFrame = false,
  durableContext = []
}) {
  const parts = [];
  const speaker = String(speakerName || "unknown").trim() || "unknown";
  const normalizedInputKind = String(inputKind || "").trim().toLowerCase() === "event"
    ? "event"
    : "transcript";
  const text = String(transcript || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 700);
  const normalizedSoundboardCandidates = (Array.isArray(soundboardCandidates) ? soundboardCandidates : [])
    .map((line) => String(line || "").trim())
    .filter(Boolean)
    .slice(0, 40);
  const normalizedBotName = String(botName || "the bot").trim() || "the bot";
  const normalizedDirectAddressed = Boolean(directAddressed);
  const normalizedNameCueDetected =
    !normalizedDirectAddressed &&
    normalizedInputKind !== "event" &&
    Boolean(text) &&
    hasBotNameCue({
      transcript: text,
      botName: normalizedBotName
    });
  const normalizedRuntimeEventContext = normalizeVoiceRuntimeEventContext(runtimeEventContext);
  const normalizedConversationContext =
    conversationContext && typeof conversationContext === "object" ? conversationContext : null;
  const normalizedSessionTiming =
    sessionTiming && typeof sessionTiming === "object"
      ? {
        maxSecondsRemaining: Number.isFinite(Number(sessionTiming.maxSecondsRemaining))
          ? Math.max(0, Math.round(Number(sessionTiming.maxSecondsRemaining)))
          : null,
        inactivitySecondsRemaining: Number.isFinite(Number(sessionTiming.inactivitySecondsRemaining))
          ? Math.max(0, Math.round(Number(sessionTiming.inactivitySecondsRemaining)))
          : null,
        timeoutWarningActive: Boolean(sessionTiming.timeoutWarningActive),
        timeoutWarningReason:
          String(sessionTiming.timeoutWarningReason || "").trim().toLowerCase() === "max_duration"
            ? "max_duration"
            : String(sessionTiming.timeoutWarningReason || "").trim().toLowerCase() === "inactivity"
              ? "inactivity"
              : "none"
      }
      : null;
  const normalizedParticipantRoster = (Array.isArray(participantRoster) ? participantRoster : [])
    .map((entry) => {
      if (typeof entry === "string") {
        return String(entry).trim();
      }
      return String(entry?.displayName || entry?.name || "").trim();
    })
    .filter(Boolean)
    .slice(0, 12);
  const normalizedMembershipEvents = (Array.isArray(recentMembershipEvents) ? recentMembershipEvents : [])
    .map((entry) => {
      const eventType = String(entry?.eventType || entry?.event || "")
        .trim()
        .toLowerCase();
      if (eventType !== "join" && eventType !== "leave") return null;
      const displayName = String(entry?.displayName || entry?.name || "").trim().slice(0, 80);
      if (!displayName) return null;
      const ageMsRaw = Number(entry?.ageMs);
      const ageMs = Number.isFinite(ageMsRaw) ? Math.max(0, Math.round(ageMsRaw)) : null;
      return {
        eventType,
        displayName,
        ageMs
      };
    })
    .filter(Boolean)
    .slice(-6);
  const normalizedVoiceEffectEvents = (Array.isArray(recentVoiceEffectEvents) ? recentVoiceEffectEvents : [])
    .map((entry) => {
      const summary = formatVoiceChannelEffectSummary(entry, { includeTiming: true });
      if (!summary) return null;
      return {
        summary
      };
    })
    .filter(Boolean)
    .slice(-6);
  const normalizedMusicContext: VoiceMusicPromptContext | null =
    musicContext && typeof musicContext === "object"
      ? {
        playbackState:
          String(musicContext?.playbackState || "").trim().toLowerCase() === "playing"
            ? "playing"
            : String(musicContext?.playbackState || "").trim().toLowerCase() === "paused"
              ? "paused"
              : String(musicContext?.playbackState || "").trim().toLowerCase() === "stopped"
                ? "stopped"
                : "idle",
        replyHandoffMode:
          String(musicContext?.replyHandoffMode || "").trim().toLowerCase() === "pause"
            ? "pause"
            : String(musicContext?.replyHandoffMode || "").trim().toLowerCase() === "duck"
              ? "duck"
              : null,
        currentTrack:
          musicContext?.currentTrack && typeof musicContext.currentTrack === "object"
            ? {
              id: String(musicContext.currentTrack.id || "").trim().slice(0, 180) || null,
              title: String(musicContext.currentTrack.title || "").trim().slice(0, 140),
              artists: (
                Array.isArray(musicContext.currentTrack.artists)
                  ? musicContext.currentTrack.artists
                  : []
              )
                .map((artist) => String(artist || "").trim().slice(0, 80))
                .filter(Boolean)
                .slice(0, 6)
            }
            : null,
        lastTrack:
          musicContext?.lastTrack && typeof musicContext.lastTrack === "object"
            ? {
              id: String(musicContext.lastTrack.id || "").trim().slice(0, 180) || null,
              title: String(musicContext.lastTrack.title || "").trim().slice(0, 140),
              artists: (
                Array.isArray(musicContext.lastTrack.artists)
                  ? musicContext.lastTrack.artists
                  : []
              )
                .map((artist) => String(artist || "").trim().slice(0, 80))
                .filter(Boolean)
                .slice(0, 6)
            }
            : null,
        queueLength: Number.isFinite(Number(musicContext?.queueLength))
          ? Math.max(0, Math.round(Number(musicContext.queueLength)))
          : 0,
        upcomingTracks: (
          Array.isArray(musicContext?.upcomingTracks)
            ? musicContext.upcomingTracks
            : []
        )
          .map((entry) => ({
            id: String(entry?.id || "").trim().slice(0, 180) || null,
            title: String(entry?.title || "").trim().slice(0, 140),
            artist: String(entry?.artist || "").trim().slice(0, 80) || null
          }))
          .filter((entry) => entry.title)
          .slice(0, 3),
        lastAction:
          String(musicContext?.lastAction || "").trim().toLowerCase() === "play_now"
            ? "play_now"
            : String(musicContext?.lastAction || "").trim().toLowerCase() === "stop"
              ? "stop"
              : String(musicContext?.lastAction || "").trim().toLowerCase() === "pause"
                ? "pause"
                : String(musicContext?.lastAction || "").trim().toLowerCase() === "resume"
                  ? "resume"
                  : String(musicContext?.lastAction || "").trim().toLowerCase() === "skip"
                    ? "skip"
                    : null,
        lastQuery: String(musicContext?.lastQuery || "").trim().slice(0, 180) || null
      }
      : null;
  const normalizedStreamWatchBrainContext =
    normalizedConversationContext?.streamWatchBrainContext &&
      typeof normalizedConversationContext.streamWatchBrainContext === "object"
      ? {
        prompt: String(normalizedConversationContext.streamWatchBrainContext.prompt || "").trim().slice(0, 420),
        notes: (
          Array.isArray(normalizedConversationContext.streamWatchBrainContext.notes)
            ? normalizedConversationContext.streamWatchBrainContext.notes
            : []
        )
          .map((note) =>
            String(note || "")
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 240)
          )
          .filter(Boolean)
          .slice(-12)
      }
      : null;
  const webSearchToolAvailable = Boolean(
    allowWebSearchToolCall &&
    webSearch?.enabled &&
    webSearch?.configured &&
    !webSearch?.optedOutByUser &&
    !webSearch?.blockedByBudget &&
    webSearch?.budget?.canSearch !== false
  );
  const browserBrowseToolAvailable = Boolean(
    allowBrowserBrowseToolCall &&
    browserBrowse?.enabled &&
    browserBrowse?.configured &&
    !browserBrowse?.blockedByBudget &&
    browserBrowse?.budget?.canBrowse !== false
  );
  const availableToolNames = collectAvailableVoiceToolNames({
    webSearchAvailable: webSearchToolAvailable,
    browserBrowseAvailable: browserBrowseToolAvailable,
    memoryAvailable: allowMemoryToolCalls,
    screenShareAvailable: allowScreenShareToolCall,
    voiceToolsAvailable: allowVoiceToolCalls
  });

  if (normalizedInputKind === "event") {
    if (normalizedRuntimeEventContext?.category === "membership") {
      const actorLabel = normalizedRuntimeEventContext.actorRole === "self"
        ? "you"
        : normalizedRuntimeEventContext.actorDisplayName || speaker;
      const action = normalizedRuntimeEventContext.eventType === "leave" ? "left" : "joined";
      parts.push(`Voice runtime event cue: ${actorLabel} ${action} the voice channel.`);
      parts.push(`Structured event type: membership.${normalizedRuntimeEventContext.eventType}.`);
    } else if (normalizedRuntimeEventContext?.category === "screen_share") {
      const actorLabel = normalizedRuntimeEventContext.actorDisplayName || speaker;
      if (normalizedRuntimeEventContext.eventType === "share_start") {
        parts.push(`Voice runtime event cue: ${actorLabel} started sharing their screen.`);
      } else {
        parts.push(`Voice runtime event cue: Something notable just happened on ${actorLabel}'s screen.`);
      }
      parts.push(`Structured event type: screen_share.${normalizedRuntimeEventContext.eventType}.`);
      if (normalizedRuntimeEventContext.hasVisibleFrame) {
        parts.push("A visible screen frame is attached for this event.");
      }
    } else {
      parts.push(`Voice runtime event cue: ${text || "(empty)"}`);
    }
  } else {
    parts.push(`Incoming live voice transcript from ${speaker}: ${text || "(empty)"}`);
  }
  if (normalizedDirectAddressed) {
    parts.push("This turn appears directly addressed to you.");
    parts.push(
      `Interpret second-person references like "you"/"your" as likely referring to ${normalizedBotName}.`
    );
  } else if (normalizedParticipantRoster.length > 1) {
    parts.push("This turn was not directly addressed to you.");
    parts.push(
      `In multi-user voice chat, treat second-person references like "you"/"your" as ambiguous by default; do not assume they refer to ${normalizedBotName} unless context is strong.`
    );
  } else {
    parts.push(
      `Interpret second-person references like "you"/"your" as likely referring to ${normalizedBotName} unless another human target is explicit.`
    );
  }
  if (normalizedNameCueDetected) {
    parts.push(
      `The transcript may be using ${normalizedBotName}'s name or a phonetic variation of it. Treat that as a positive signal that the speaker may be talking to you.`
    );
  }
  if (normalizedParticipantRoster.length) {
    parts.push(`In VC. Participants: ${normalizedParticipantRoster.join(", ")}.`);
  } else {
    parts.push("In VC.");
  }

  if (normalizedMembershipEvents.length) {
    parts.push("Recent voice membership changes:");
    parts.push(
      normalizedMembershipEvents
        .map((entry) => {
          const action = entry.eventType === "join" ? "joined" : "left";
          const timing = Number.isFinite(entry.ageMs) ? ` (${entry.ageMs}ms ago)` : "";
          return `- ${entry.displayName} ${action} the voice channel${timing}.`;
        })
        .join("\n")
    );
    parts.push(
      "When it fits naturally, prefer a quick greeting for recent joiners and a brief goodbye/acknowledgement for recent leavers."
    );
  }

  if (normalizedVoiceEffectEvents.length) {
    parts.push("Recent voice effects:");
    parts.push(
      normalizedVoiceEffectEvents
        .map((entry) => `- ${entry.summary}.`)
        .join("\n")
    );
    parts.push("Treat soundboard and emoji effects as room context signals, not spoken words.");
  }

  if (normalizedConversationContext) {
    const recencyLines: string[] = [];
    const msSinceReply = normalizedConversationContext.msSinceAssistantReply;
    const msSinceAddress = normalizedConversationContext.msSinceDirectAddress;
    const secsSinceReply = Number.isFinite(msSinceReply) ? Math.round(msSinceReply / 1000) : null;
    const secsSinceAddress = Number.isFinite(msSinceAddress) ? Math.round(msSinceAddress / 1000) : null;

    if (secsSinceReply != null) {
      recencyLines.push(`You last spoke ${secsSinceReply}s ago.`);
    } else {
      recencyLines.push("You have not spoken recently.");
    }

    if (secsSinceAddress != null) {
      if (normalizedConversationContext.sameAsRecentDirectAddress) {
        recencyLines.push(`This is the same speaker who addressed you by name ${secsSinceAddress}s ago.`);
      } else {
        recencyLines.push(`Last addressed by name ${secsSinceAddress}s ago by a different speaker.`);
      }
    }

    const normalizedAttentionMode = String(normalizedConversationContext.attentionMode || "").trim().toUpperCase();
    if (normalizedConversationContext.currentSpeakerActive) {
      recencyLines.push("This speaker is part of your current live thread.");
    } else if (normalizedAttentionMode === "ACTIVE") {
      recencyLines.push("You are generally engaged in the room, but this speaker is not clearly part of your current thread.");
    } else {
      recencyLines.push("You do not currently have an active thread with this speaker.");
    }
    recencyLines.push("Use room continuity as context, not as a reason to force yourself into the turn.");

    if (
      normalizedConversationContext.activeCommandSpeaker &&
      !normalizedConversationContext.currentSpeakerActive
    ) {
      recencyLines.push("You have a pending command from another speaker. This speaker is not part of that exchange — do not treat their speech as a command response.");
    }

    parts.push(recencyLines.join("\n"));
  }

  const normalizedInterruptedAssistantReply =
    normalizedConversationContext?.interruptedAssistantReply &&
      typeof normalizedConversationContext.interruptedAssistantReply === "object"
      ? {
        utteranceText:
          String(normalizedConversationContext.interruptedAssistantReply.utteranceText || "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 240),
        interruptedBySpeakerName:
          String(normalizedConversationContext.interruptedAssistantReply.interruptedBySpeakerName || "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 80) || speaker,
        ageMs: Number.isFinite(Number(normalizedConversationContext.interruptedAssistantReply.ageMs))
          ? Math.max(0, Math.round(Number(normalizedConversationContext.interruptedAssistantReply.ageMs)))
          : null
      }
      : null;
  if (normalizedInterruptedAssistantReply?.utteranceText) {
    const interruptionAgeSeconds = Number.isFinite(normalizedInterruptedAssistantReply.ageMs)
      ? Math.round(Number(normalizedInterruptedAssistantReply.ageMs) / 1000)
      : null;
    parts.push(
      [
        "Interruption recovery context:",
        interruptionAgeSeconds != null
          ? `- ${normalizedInterruptedAssistantReply.interruptedBySpeakerName} interrupted you ${interruptionAgeSeconds}s ago while you were saying: "${normalizedInterruptedAssistantReply.utteranceText}"`
          : `- ${normalizedInterruptedAssistantReply.interruptedBySpeakerName} interrupted you while you were saying: "${normalizedInterruptedAssistantReply.utteranceText}"`,
        `- They then said: "${text || "(empty)"}"`,
        "- Decide conversationally whether to resume, adapt, or drop the interrupted reply based on what they said now.",
        "- Do not mechanically continue the old answer if the new turn changes direction."
      ].join("\n")
    );
  }

  const normalizedDurableContext = selectPromptDurableContextEntries(durableContext);
  if (screenWatchActive && !hasDirectVisionFrame && !normalizedStreamWatchBrainContext?.notes?.length) {
    parts.push(
      screenWatchFrameReady
        ? "Screen watch: active and receiving frames. You are already watching their screen — do not call start_screen_watch again."
        : "Screen watch: active, waiting for the first frame. Do not call start_screen_watch again — it is already running."
    );
  }
  if (hasDirectVisionFrame) {
    const screenContextParts = [
      "Live screen watch: You can see the user's screen directly in the attached image.",
      "Comment on what you see when it feels natural — react to interesting moments, changes, or anything worth noting aloud.",
      "If nothing warrants a spoken comment right now, say nothing.",
      normalizedStreamWatchBrainContext?.prompt
        ? `- Guidance: ${normalizedStreamWatchBrainContext.prompt}`
        : null
    ];
    if (normalizedStreamWatchBrainContext?.notes?.length) {
      screenContextParts.push("Recent screen observations:");
      screenContextParts.push(...normalizedStreamWatchBrainContext.notes.map((note) => `- ${note}`));
    }
    parts.push(screenContextParts.filter(Boolean).join("\n"));
  } else if (normalizedStreamWatchBrainContext?.notes?.length) {
    parts.push(
      [
        "Recent screen-watch keyframe context:",
        normalizedStreamWatchBrainContext.prompt
          ? `- Guidance: ${normalizedStreamWatchBrainContext.prompt}`
          : null,
        ...normalizedStreamWatchBrainContext.notes.map((note) => `- ${note}`),
        "- These are sampled frame snapshots. Avoid overclaiming continuity between samples."
      ]
        .filter(Boolean)
        .join("\n")
    );
  }
  if (normalizedSessionTiming?.timeoutWarningActive) {
    const reason = normalizedSessionTiming.timeoutWarningReason === "inactivity"
      ? `${normalizedSessionTiming.inactivitySecondsRemaining ?? "?"}s inactivity remaining`
      : `${normalizedSessionTiming.maxSecondsRemaining ?? "?"}s remaining`;
    parts.push(`Session ending soon (${reason}). You may call leave_voice_channel if this feels wrapped up.`);
  }

  if (participantProfiles?.length || selfFacts?.length || loreFacts?.length) {
    parts.push("People in this conversation:");
    parts.push(
      formatConversationParticipantMemory({
        participantProfiles,
        selfFacts,
        loreFacts
      })
    );
  }

  if (guidanceFacts?.length) {
    parts.push("Behavior guidance:\n" + formatBehaviorMemoryFacts(guidanceFacts, 10));
  }

  if (behavioralFacts?.length) {
    parts.push("Behavioral memory (follow when relevant):\n" + formatBehaviorMemoryFacts(behavioralFacts, 8));
  }

  parts.push(`Tools: ${availableToolNames.join(", ")}.`);
  parts.push("Speak first on casual turns. Use tools to improve accuracy or execute requested actions. Always include a brief spoken acknowledgment before calling tools (e.g., 'Sure, one sec' or 'Let me pull that up') — tool calls can take several seconds and the user hears silence until you speak. Ground factual or success claims in tool results — never claim success before a tool returns.");

  if (allowMemoryToolCalls) {
    const memLines = [];
    if (allowVoiceToolCalls) {
      memLines.push("note_context: session-scoped facts, preferences, or plans for this conversation.");
    }
    memLines.push(
      "memory_write: long-term durable facts only (namespace=speaker/guild/self, type=preference/profile/relationship/guidance/behavioral/other). Don't save chatter, prompt instructions, or session-only info."
    );
    parts.push(memLines.join("\n"));
  }

  if (allowSoundboardToolCall && normalizedSoundboardCandidates.length) {
    const soundboardGuidance = buildVoiceSoundboardGuidanceLines(soundboardEagerness);
    const sbLines = [...soundboardGuidance.lines];
    if (allowInlineSoundboardDirectives) {
      sbLines.push(
        "Inline [[SOUNDBOARD:<ref>]] for precise timing relative to speech. Refs:",
        ...normalizedSoundboardCandidates,
        "play_soundboard for standalone effects only. Don't both inline and tool-call the same sound."
      );
    } else {
      sbLines.push(
        "Inline directives unavailable. Use play_soundboard with refs:",
        ...normalizedSoundboardCandidates,
        "Don't output [[SOUNDBOARD:...]] markup."
      );
    }
    sbLines.push("Don't mention refs in spoken text.");
    parts.push(sbLines.join("\n"));
  }

  if (normalizedDurableContext.length) {
    parts.push("Session context:");
    parts.push(
      normalizedDurableContext
        .map((entry) => `- [${entry.category}] ${entry.text}`)
        .join("\n")
    );
  }

  if (recentConversationHistory?.length) {
    parts.push("Past conversation:\n" + formatConversationWindows(recentConversationHistory));
  }

  if (shouldRenderMusicPromptContext(normalizedMusicContext)) {
    const musicDisplayState = resolveMusicPromptDisplayState(normalizedMusicContext);
    const musicLines = [`Music: ${musicDisplayState}`];
    if (normalizedMusicContext.currentTrack?.title) {
      musicLines.push(
        `- Now: ${normalizedMusicContext.currentTrack.title} by ${formatMusicPromptArtists(normalizedMusicContext.currentTrack.artists)}${normalizedMusicContext.currentTrack.id ? ` [selection_id: ${normalizedMusicContext.currentTrack.id}]` : ""}`
      );
    }
    if (
      normalizedMusicContext.lastTrack?.title &&
      !areMusicPromptTracksEqual(normalizedMusicContext.currentTrack, normalizedMusicContext.lastTrack)
    ) {
      musicLines.push(
        `- Last: ${normalizedMusicContext.lastTrack.title} by ${formatMusicPromptArtists(normalizedMusicContext.lastTrack.artists)}${normalizedMusicContext.lastTrack.id ? ` [selection_id: ${normalizedMusicContext.lastTrack.id}]` : ""}`
      );
    }
    if (normalizedMusicContext.queueLength > 0) {
      musicLines.push(`- Queue: ${normalizedMusicContext.queueLength} track(s)`);
      for (const [index, track] of normalizedMusicContext.upcomingTracks.entries()) {
        musicLines.push(
          `  ${index + 1}. ${track.title}${track.artist ? ` - ${track.artist}` : ""}${track.id ? ` [selection_id: ${track.id}]` : ""}`
        );
      }
    }
    if (normalizedMusicContext.lastAction) musicLines.push(`- Last action: ${normalizedMusicContext.lastAction}`);
    if (normalizedMusicContext.lastQuery) musicLines.push(`- Last query: ${normalizedMusicContext.lastQuery}`);
    if (normalizedMusicContext.replyHandoffMode === "pause") {
      musicLines.push("- Your next spoken reply can take the floor: music is already paused and auto-resumes when you finish or stay silent.");
    } else if (normalizedMusicContext.replyHandoffMode === "duck") {
      musicLines.push("- Your next spoken reply can take the floor: music stays live, ducks under your voice, then unducks when you finish.");
    }
    musicLines.push(...buildActiveMusicReplyGuidanceLines(normalizedMusicContext));
    parts.push(musicLines.join("\n"));
  }

  parts.push(CONVERSATION_SEARCH_POLICY_LINE);

  if (webSearchToolAvailable) {
    parts.push(buildWebToolRoutingPolicyLine({ includeBrowserBrowse: browserBrowseToolAvailable }));
    parts.push(buildWebSearchPolicyLine({ onePerTurn: true }));
    parts.push(WEB_SCRAPE_POLICY_LINE);
  }

  if (browserBrowseToolAvailable) {
    parts.push(BROWSER_BROWSE_POLICY_LINE);
  }

  if (allowVoiceToolCalls) {
    parts.push([
      "Music: music_play starts audio-only playback (no Go Live stream). Re-call with selection_id only when reusing an exact prior id. Omit selection_id unless you already have the exact id from prompt context or a prior tool result. Never invent placeholder or markup tokens.",
      "Video: video_play starts YouTube video playback and shows it via Discord Go Live. Re-call with selection_id only when reusing an exact prior id.",
      "Visualizer: stream_visualizer starts a Go Live audio visualizer for currently playing music. Optional mode: cqt, spectrum, waves, vectorscope.",
      "Use video_search only when the user explicitly wants video options. If seeing the site, thumbnails, or layout would help you decide, browser_browse can be the better tool.",
      "Queue: music_queue_next (after current) and music_queue_add (append) can take either direct query text or exact prior IDs. Prefer direct query for ordinary queue requests; use music_search only when the user explicitly wants options or browsing.",
      "For a request like \"play X, then queue Y\", emit music_play for X first and music_queue_next for Y second in the same tool response. Do not say Y is queued unless music_queue_next or music_queue_add succeeds.",
      "Other playback controls: media_stop, media_pause, media_resume, media_skip, media_now_playing. Don't chain queue_add+skip to emulate play-now.",
      `Floor control: ${MUSIC_ACTIVE_AUTONOMY_POLICY_LINE}`,
      MUSIC_REPLY_HANDOFF_POLICY_LINE
    ].join("\n"));
  }

  if (allowScreenShareToolCall) {
    parts.push("start_screen_watch: begin screen watch when live visual context would help. If multiple Discord shares are live and you want a specific one, pass { target: \"display name\" }. The runtime binds to an active Discord sharer when possible and falls back automatically when needed.");
    parts.push("A successful start_screen_watch does not always mean live pixels are ready yet. If the tool result says frameReady=false, do not claim to see the screen yet.");
    parts.push("If start_screen_watch falls back to a link or returns linkUrl, treat that as off-screen coordination. In spoken replies, tell them to open the link you sent or the screen-share link. Do not read the full URL aloud unless they explicitly ask you to spell it out.");
  }

  if (allowVoiceToolCalls) {
    parts.push("leave_voice_channel: only when you choose to end your VC session. Goodbyes alone don't force exit.");
  }

  if (webSearch?.requested && !webSearch?.used) {
    if (webSearch.error) {
      parts.push(`Web lookup failed: ${webSearch.error}`);
      parts.push("Answer without claiming live lookup succeeded.");
    } else if (!webSearch.results?.length) {
      parts.push("A web lookup was attempted, but no useful results were found.");
      parts.push("Answer carefully and avoid invented specifics.");
    }
  }

  if (webSearch?.used && webSearch.results?.length) {
    parts.push(`Live web findings for query: "${webSearch.query}"`);
    parts.push(formatWebSearchFindings(webSearch));
  }

  parts.push(
    ...buildVoiceAdmissionPolicyLines({
      inputKind: normalizedInputKind,
      speakerName: speaker,
      directAddressed: normalizedDirectAddressed,
      nameCueDetected: normalizedNameCueDetected,
      ambientReplyEagerness: voiceAmbientReplyEagerness,
      responseWindowEagerness,
      participantCount: normalizedParticipantRoster.length,
      conversationContext: normalizedConversationContext,
      runtimeEventContext: normalizedRuntimeEventContext,
      pendingCommandFollowupSignal: Boolean(normalizedConversationContext?.pendingCommandFollowupSignal),
      musicActive: Boolean(normalizedConversationContext?.musicActive),
      musicWakeLatched: Boolean(normalizedConversationContext?.musicWakeLatched)
    })
  );

  parts.push(
    "If you speak, begin with one hidden audience prefix: [[TO:SPEAKER]], [[TO:ALL]], or [[TO:<participant display name>]]. This prefix is metadata only and is not spoken aloud.",
  );

  parts.push(
    [
      "You may optionally add a lease prefix immediately after [[TO:...]]: [[LEASE:ASSERTIVE]] or [[LEASE:ATOMIC]].",
      "A lease gives your reply a brief protected runway: it resists being pushed aside by newer chatter before you start speaking, and briefly resists interruption after you start so your point can land.",
      "ASSERTIVE: use when your reply directly answers a question, confirms an action, or delivers a tool result. The listener asked for this and should hear it.",
      "ATOMIC: use when the reply is safety-relevant, completes a multi-step action, or corrects a dangerous misunderstanding. Rare.",
      "No lease: ambient commentary, greetings, reactions, jokes, voluntary observations. Most replies need no lease.",
      "Do not lease a reply just because you find it interesting. Lease it because the listener needs it."
    ].join("\n")
  );

  parts.push(
    allowInlineSoundboardDirectives
      ? "Reply with [SKIP] or the hidden [[TO:...]] prefix, optional [[LEASE:...]] prefix, then spoken text. No JSON/markdown/tags. Only other markup allowed after those leading prefixes: [[SOUNDBOARD:<ref>]]."
      : "Reply with [SKIP] or the hidden [[TO:...]] prefix, optional [[LEASE:...]] prefix, then spoken text. No JSON/markdown/tags/[[...]] directives beyond those leading metadata prefixes."
  );

  return parts.join("\n\n");
}
