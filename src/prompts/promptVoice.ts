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
  buildActiveMusicReplyGuidanceLines
} from "./voiceLivePolicy.ts";
import { hasBotNameCue } from "../bot/directAddressConfidence.ts";
import {
  formatVoiceChannelEffectSummary,
  normalizeVoiceRuntimeEventContext
} from "../voice/voiceSessionHelpers.ts";
import {
  buildVoiceAdmissionPolicyLines,
  getScreenWatchCommentaryTier
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
  screenWatchStreamerName = "",
  screenWatchFrameReady = false,
  screenShareSnapshotAvailable = false,
  nativeDiscordSharers = [],
  allowMemoryToolCalls = false,
  allowSoundboardToolCall = false,
  allowInlineSoundboardDirectives = false,
  allowVoiceToolCalls = false,
  musicContext = null,
  hasDirectVisionFrame = false,
  durableContext = [],
  screenWatchCommentaryEagerness = 60,
  recentToolOutcomes = []
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
  const isScreenShareEvent =
    normalizedInputKind === "event" && normalizedRuntimeEventContext?.category === "screen_share";
  const normalizedConversationContext =
    conversationContext && typeof conversationContext === "object" ? conversationContext : null;
  const normalizedCompactedSessionSummary =
    normalizedConversationContext?.compactedSessionSummary && typeof normalizedConversationContext.compactedSessionSummary === "object"
      ? {
        text: String(normalizedConversationContext.compactedSessionSummary.text || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 1400),
        coveredThroughTurn: normalizedConversationContext.compactedSessionSummary.coveredThroughTurn != null && Number.isFinite(Number(normalizedConversationContext.compactedSessionSummary.coveredThroughTurn))
          ? Math.max(0, Math.round(Number(normalizedConversationContext.compactedSessionSummary.coveredThroughTurn)))
          : null
      }
      : null;
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
  const normalizedStreamWatchNotes =
    normalizedConversationContext?.streamWatchNotes &&
      typeof normalizedConversationContext.streamWatchNotes === "object"
      ? {
        prompt: String(normalizedConversationContext.streamWatchNotes.prompt || "").trim().slice(0, 420),
        notes: (
          Array.isArray(normalizedConversationContext.streamWatchNotes.notes)
            ? normalizedConversationContext.streamWatchNotes.notes
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
      } else if (normalizedRuntimeEventContext.eventType === "direct_frame") {
        parts.push(`Voice runtime event cue: A new frame from ${actorLabel}'s screen share.`);
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
    if (!isScreenShareEvent) {
      parts.push("This turn was not directly addressed to you.");
    }
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
    if (!isScreenShareEvent) {
      if (normalizedConversationContext.currentSpeakerActive) {
        recencyLines.push("This speaker is part of your current live thread.");
      } else if (normalizedAttentionMode !== "ACTIVE") {
        recencyLines.push("You do not currently have an active thread with this speaker.");
      }
    }

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
  const normalizedNativeDiscordSharers = (Array.isArray(nativeDiscordSharers) ? nativeDiscordSharers : [])
    .filter((entry) => entry?.displayName)
    .slice(0, 6);
  if (normalizedNativeDiscordSharers.length > 0 && !screenWatchActive) {
    parts.push(
      [
        "Active Discord screen shares:",
        ...normalizedNativeDiscordSharers.map((entry) => {
          const details = [
            entry.streamType,
            entry.codec,
            entry.width && entry.height ? `${entry.width}x${entry.height}` : null
          ].filter(Boolean).join(", ");
          return `- ${entry.displayName}${details ? ` (${details})` : ""}`;
        }),
        "You do not automatically see those shares just because they are active.",
        allowScreenShareToolCall
          ? "Use start_screen_watch to request frame context. Pass { target: \"display name\" } to watch a specific share."
          : ""
      ].filter(Boolean).join("\n")
    );
  }
  const normalizedScreenWatchStreamerName = String(screenWatchStreamerName || "").trim();
  if (screenWatchActive) {
    parts.push(
      normalizedScreenWatchStreamerName
        ? `Screen watch active — viewing ${normalizedScreenWatchStreamerName}'s screen.`
        : "Screen watch active."
    );
  }
  if (screenWatchActive && !hasDirectVisionFrame && !normalizedStreamWatchNotes?.notes?.length) {
    const frameParts = [
      screenWatchFrameReady
        ? "Receiving frames. You are already watching — do not call start_screen_watch again."
        : "Waiting for the first frame. Do not call start_screen_watch again — it is already running.",
      screenShareSnapshotAvailable
        ? "Use see_screenshare_snapshot to inspect the current frame directly."
        : null
    ].filter(Boolean);
    parts.push(frameParts.join(" "));
  }
  const normalizedCommentaryEagerness = Math.max(0, Math.min(100, Number(screenWatchCommentaryEagerness) || 60));
  if (hasDirectVisionFrame) {
    const screenContextParts = [
      `Live screen watch: You can see ${normalizedScreenWatchStreamerName ? normalizedScreenWatchStreamerName + "'s" : "the user's"} screen directly in the attached image.`,
      `Screen watch commentary eagerness: ${normalizedCommentaryEagerness}/100.`,
      getScreenWatchCommentaryTier(normalizedCommentaryEagerness),
      normalizedStreamWatchNotes?.prompt
        ? `- Guidance: ${normalizedStreamWatchNotes.prompt}`
        : null
    ];
    if (normalizedStreamWatchNotes?.notes?.length) {
      screenContextParts.push("Your previous observations:");
      screenContextParts.push(...normalizedStreamWatchNotes.notes.map((note) => `- ${note}`));
    }
    screenContextParts.push(
      "If you notice a fresh, notable visual beat, a short natural reaction is welcome."
    );
    screenContextParts.push(
      "You may end your reply with [[NOTE:your observation]] to record a private note about what you see. Notes are never spoken aloud. " +
      "Use notes to track the screen across future turns. " +
      "You can speak and note in the same turn, or skip speech and just note: [SKIP] [[NOTE:...]]."
    );
    parts.push(screenContextParts.filter(Boolean).join("\n"));
  } else if (normalizedStreamWatchNotes?.notes?.length) {
    parts.push(
      [
        "Recent screen-watch keyframe context:",
        normalizedStreamWatchNotes.prompt
          ? `- Guidance: ${normalizedStreamWatchNotes.prompt}`
          : null,
        ...normalizedStreamWatchNotes.notes.map((note) => `- ${note}`),
        "- These are sampled frame snapshots. Avoid overclaiming continuity between samples.",
        screenShareSnapshotAvailable
          ? "- If these notes are insufficient or you need to inspect the screen directly, use see_screenshare_snapshot."
          : null
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

  const normalizedRecentToolOutcomes = (Array.isArray(recentToolOutcomes) ? recentToolOutcomes : [])
    .map((entry) => String(entry || "").trim())
    .filter(Boolean)
    .slice(-4);
  if (normalizedRecentToolOutcomes.length) {
    parts.push(
      [
        "Recent tool outcomes:",
        ...normalizedRecentToolOutcomes.map((entry) => `- ${entry}`)
      ].join("\n")
    );
  }

  parts.push(`Tools: ${availableToolNames.join(", ")}.`);

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

  if (normalizedCompactedSessionSummary?.text) {
    parts.push(
      [
        "Earlier in this session:",
        `- ${normalizedCompactedSessionSummary.text}`,
        normalizedCompactedSessionSummary.coveredThroughTurn != null
          ? `- This summary covers everything before transcript turn ${normalizedCompactedSessionSummary.coveredThroughTurn + 1}.`
          : null
      ]
        .filter(Boolean)
        .join("\n")
    );
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

  // Per-turn inline markup allowances (soundboard, screen watch notes)
  const noteDirectiveAllowed = hasDirectVisionFrame;
  const inlineMarkupSuffix = [
    allowInlineSoundboardDirectives ? "[[SOUNDBOARD:<ref>]]" : null,
    noteDirectiveAllowed ? "[[NOTE:<observation>]]" : null
  ].filter(Boolean).join(", ");
  if (inlineMarkupSuffix) {
    parts.push(`Additional inline markup allowed this turn: ${inlineMarkupSuffix}.`);
  }

  return parts.join("\n\n");
}
