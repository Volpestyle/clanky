import {
  buildVoiceSelfContextLines,
  buildVoiceToneGuardrails,
} from "./promptCore.ts";

import {
  formatWebSearchFindings,
  formatConversationWindows,
  formatRecentLookupContext,
  formatOpenArticleCandidates,
  formatMemoryFacts
} from "./promptFormatters.ts";
import { hasBotNameCue } from "../bot/directAddressConfidence.ts";
import { formatVoiceChannelEffectSummary } from "../voice/voiceSessionHelpers.ts";
import {
  buildVoiceAdmissionPolicyLines
} from "./voiceAdmissionPolicy.ts";
import { VOICE_TOOL_SCHEMAS } from "../tools/sharedToolSchemas.ts";
import type { VoiceSessionDurableContextEntry } from "../voice/voiceSessionTypes.ts";

type VoiceMusicPromptContext = {
  playbackState: "playing" | "paused" | "stopped" | "idle";
  currentTrack: { title: string; artists: string[] } | null;
  lastTrack: { title: string; artists: string[] } | null;
  queueLength: number;
  upcomingTracks: Array<{ title: string; artist: string | null }>;
  lastAction: "play_now" | "stop" | "pause" | "resume" | "skip" | null;
  lastQuery: string | null;
};

const VOICE_CONTROL_TOOL_NAMES = VOICE_TOOL_SCHEMAS.map((schema) => schema.name);

function collectAvailableVoiceToolNames({
  webSearchAvailable,
  browserBrowseAvailable,
  memoryAvailable,
  adaptiveDirectivesAvailable,
  openArticleAvailable,
  screenShareAvailable,
  voiceToolsAvailable
}: {
  webSearchAvailable: boolean;
  browserBrowseAvailable: boolean;
  memoryAvailable: boolean;
  adaptiveDirectivesAvailable: boolean;
  openArticleAvailable: boolean;
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
    names.add("memory_search");
    names.add("memory_write");
  }
  if (adaptiveDirectivesAvailable) {
    names.add("adaptive_directive_add");
    names.add("adaptive_directive_remove");
  }
  if (openArticleAvailable) names.add("open_article");
  if (screenShareAvailable) names.add("offer_screen_share_link");
  if (voiceToolsAvailable) {
    for (const name of VOICE_CONTROL_TOOL_NAMES) names.add(name);
  }

  return Array.from(names);
}

export function buildVoiceTurnPrompt({
  speakerName = "unknown",
  transcript = "",
  inputKind = "transcript",
  directAddressed = false,
  userFacts = [],
  relevantFacts = [],
  isEagerTurn = false,
  voiceEagerness = 0,
  conversationContext = null,
  sessionTiming = null,
  botName = "the bot",
  participantRoster = [],
  recentMembershipEvents = [],
  recentVoiceEffectEvents = [],
  soundboardCandidates = [],
  webSearch = null,
  browserBrowse = null,
  recentConversationHistory = [],
  recentWebLookups = [],
  openArticleCandidates = [],
  openedArticle = null,
  allowWebSearchToolCall = false,
  allowBrowserBrowseToolCall = false,
  allowOpenArticleToolCall = false,
  screenShare = null,
  allowScreenShareToolCall = false,
  allowMemoryToolCalls = false,
  allowAdaptiveDirectiveToolCalls = false,
  allowSoundboardToolCall = false,
  allowVoiceToolCalls = false,
  musicContext = null,
  hasDirectVisionFrame = false,
  durableScreenNotes = [],
  durableContext = []
}) {
  const parts = [];
  const voiceToneGuardrails = buildVoiceToneGuardrails();
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
    Boolean(text) &&
    hasBotNameCue({
      transcript: text,
      botName: normalizedBotName
    });
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
  const normalizedOpenArticleCandidates = (Array.isArray(openArticleCandidates) ? openArticleCandidates : [])
    .map((entry) => ({
      ref: String(entry?.ref || "").trim(),
      title: String(entry?.title || "").trim(),
      url: String(entry?.url || "").trim(),
      domain: String(entry?.domain || "").trim(),
      query: String(entry?.query || "").trim()
    }))
    .filter((entry) => entry.ref && entry.url)
    .slice(0, 12);
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
          currentTrack:
            musicContext?.currentTrack && typeof musicContext.currentTrack === "object"
              ? {
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
  const normalizedVoiceAddressingState =
    normalizedConversationContext?.voiceAddressingState &&
    typeof normalizedConversationContext.voiceAddressingState === "object"
      ? {
          currentSpeakerTarget:
            String(normalizedConversationContext.voiceAddressingState.currentSpeakerTarget || "")
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 80) || null,
          currentSpeakerDirectedConfidence: Number.isFinite(
            Number(normalizedConversationContext.voiceAddressingState.currentSpeakerDirectedConfidence)
          )
            ? Math.max(
                0,
                Math.min(1, Number(normalizedConversationContext.voiceAddressingState.currentSpeakerDirectedConfidence))
              )
            : 0,
          lastDirectedToMe:
            normalizedConversationContext.voiceAddressingState.lastDirectedToMe &&
            typeof normalizedConversationContext.voiceAddressingState.lastDirectedToMe === "object"
              ? {
                  speakerName:
                    String(normalizedConversationContext.voiceAddressingState.lastDirectedToMe.speakerName || "")
                      .replace(/\s+/g, " ")
                      .trim()
                      .slice(0, 80) || "someone",
                  ageMs: Number.isFinite(
                    Number(normalizedConversationContext.voiceAddressingState.lastDirectedToMe.ageMs)
                  )
                    ? Math.max(0, Math.round(Number(normalizedConversationContext.voiceAddressingState.lastDirectedToMe.ageMs)))
                    : null,
                  directedConfidence: Number.isFinite(
                    Number(normalizedConversationContext.voiceAddressingState.lastDirectedToMe.directedConfidence)
                  )
                    ? Math.max(
                        0,
                        Math.min(
                          1,
                          Number(normalizedConversationContext.voiceAddressingState.lastDirectedToMe.directedConfidence)
                        )
                      )
                    : 0
                }
              : null,
          recentAddressingGuesses: (
            Array.isArray(normalizedConversationContext.voiceAddressingState.recentAddressingGuesses)
              ? normalizedConversationContext.voiceAddressingState.recentAddressingGuesses
              : []
          )
            .map((entry) => ({
              speakerName:
                String(entry?.speakerName || "")
                  .replace(/\s+/g, " ")
                  .trim()
                  .slice(0, 80) || "someone",
              talkingTo:
                String(entry?.talkingTo || "")
                  .replace(/\s+/g, " ")
                  .trim()
                  .slice(0, 80) || null,
              directedConfidence: Number.isFinite(Number(entry?.directedConfidence))
                ? Math.max(0, Math.min(1, Number(entry.directedConfidence)))
                : 0,
              ageMs: Number.isFinite(Number(entry?.ageMs)) ? Math.max(0, Math.round(Number(entry.ageMs))) : null
            }))
            .slice(-6)
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
  const openArticleToolAvailable = Boolean(allowOpenArticleToolCall && normalizedOpenArticleCandidates.length > 0);
  const availableToolNames = collectAvailableVoiceToolNames({
    webSearchAvailable: webSearchToolAvailable,
    browserBrowseAvailable: browserBrowseToolAvailable,
    memoryAvailable: allowMemoryToolCalls,
    adaptiveDirectivesAvailable: allowAdaptiveDirectiveToolCalls,
    openArticleAvailable: openArticleToolAvailable,
    screenShareAvailable: allowScreenShareToolCall,
    voiceToolsAvailable: allowVoiceToolCalls
  });

  if (normalizedInputKind === "event") {
    parts.push(`Voice runtime event cue: ${text || "(empty)"}`);
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
  parts.push(
    ...buildVoiceSelfContextLines({
      voiceEnabled: true,
      inVoiceChannel: true,
      participantRoster: normalizedParticipantRoster
    })
  );
  parts.push(
    "Capability state rule: distinguish unsupported features from currently unavailable features. When disabled/unconfigured/budget-blocked, treat the feature as currently unavailable with the specific reason."
  );
  parts.push("Avoid absolute claims that a supported feature can never work.");

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

    if (normalizedConversationContext.engagementState === "command_only_engaged") {
      recencyLines.push("You have a pending command from another speaker. This speaker is not part of that exchange — do not treat their speech as a command response.");
    }

    parts.push(recencyLines.join("\n"));
  }

  if (normalizedVoiceAddressingState) {
    parts.push(
      [
        "Conversational addressing state (best-effort guesses from recent turns):",
        `- Current speaker likely talking to: ${normalizedVoiceAddressingState.currentSpeakerTarget || "unknown"}`,
        `- Current speaker directed-confidence: ${normalizedVoiceAddressingState.currentSpeakerDirectedConfidence.toFixed(2)}`,
        normalizedVoiceAddressingState.lastDirectedToMe
          ? `- Last turn directed to you: ${normalizedVoiceAddressingState.lastDirectedToMe.speakerName} (${normalizedVoiceAddressingState.lastDirectedToMe.ageMs ?? "unknown"}ms ago, confidence ${normalizedVoiceAddressingState.lastDirectedToMe.directedConfidence.toFixed(2)})`
          : "- Last turn directed to you: none in recent context",
        normalizedVoiceAddressingState.recentAddressingGuesses.length
          ? "- Recent addressing guesses:\n" +
            normalizedVoiceAddressingState.recentAddressingGuesses
              .map(
                (entry) =>
                  `  - ${entry.speakerName} -> ${entry.talkingTo || "unknown"} (confidence ${entry.directedConfidence.toFixed(2)}, ${entry.ageMs ?? "unknown"}ms ago)`
              )
              .join("\n")
          : "- Recent addressing guesses: none"
      ].join("\n")
    );
  }

  const normalizedDurableScreenNotes = (Array.isArray(durableScreenNotes) ? durableScreenNotes : [])
    .map((note) => String(note || "").replace(/\s+/g, " ").trim().slice(0, 240))
    .filter(Boolean)
    .slice(-20);
  const normalizedDurableContext: VoiceSessionDurableContextEntry[] = (Array.isArray(durableContext) ? durableContext : [])
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
        at: Number(entry?.at || 0)
      } satisfies VoiceSessionDurableContextEntry;
    })
    .filter((entry): entry is VoiceSessionDurableContextEntry => entry !== null)
    .slice(-50);
  if (hasDirectVisionFrame) {
    const screenContextParts = [
      "Live screen share: You can see the user's screen directly in the attached image.",
      "Comment on what you see whenever it feels natural. React to interesting moments, changes, or anything worth noting.",
      "If there is a brief factual screen observation worth saving privately, call screen_note with it (max 20 words). Do not speak the note aloud unless it also belongs in your spoken reply.",
      "If something genuinely noteworthy happens that is not already in the key moments list below, call screen_moment with a brief description. Otherwise do not call it.",
      normalizedStreamWatchBrainContext?.prompt
        ? `- Guidance: ${normalizedStreamWatchBrainContext.prompt}`
        : null
    ];
    if (normalizedStreamWatchBrainContext?.notes?.length) {
      screenContextParts.push("Recent screen observations:");
      screenContextParts.push(...normalizedStreamWatchBrainContext.notes.map((note) => `- ${note}`));
    }
    if (normalizedDurableScreenNotes.length) {
      screenContextParts.push("Key moments this session:");
      screenContextParts.push(...normalizedDurableScreenNotes.map((note) => `- ${note}`));
    }
    parts.push(screenContextParts.filter(Boolean).join("\n"));
  } else if (normalizedStreamWatchBrainContext?.notes?.length) {
    parts.push(
      [
        "Live stream-watch keyframe context:",
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
  if (normalizedSessionTiming) {
    parts.push(
      [
        "Session timing context:",
        `- Session timeout warning flag: ${normalizedSessionTiming.timeoutWarningActive ? "true" : "false"}`,
        `- Warning reason: ${normalizedSessionTiming.timeoutWarningReason}`,
        `- Max-session seconds remaining: ${
          Number.isFinite(normalizedSessionTiming.maxSecondsRemaining)
            ? normalizedSessionTiming.maxSecondsRemaining
            : "unknown"
        }`,
        `- Inactivity seconds remaining: ${
          Number.isFinite(normalizedSessionTiming.inactivitySecondsRemaining)
            ? normalizedSessionTiming.inactivitySecondsRemaining
            : "unknown"
        }`
      ].join("\n")
    );
    if (normalizedSessionTiming.timeoutWarningActive) {
      parts.push(
        "If this feels naturally wrapped up, you may call leave_voice_channel to end your VC session after this turn."
      );
    }
  }

  if (userFacts?.length) {
    parts.push("Known facts about this user:");
    parts.push(formatMemoryFacts(userFacts, { includeType: false, includeProvenance: false, maxItems: 8 }));
  }

  if (relevantFacts?.length) {
    parts.push("Relevant durable memory:");
    parts.push(formatMemoryFacts(relevantFacts, { includeType: true, includeProvenance: false, maxItems: 8 }));
  }

  parts.push("Tooling policy:");
  parts.push(`- Available tool calls this turn: ${availableToolNames.join(", ")}.`);
  parts.push("- Use tools whenever they materially improve factuality or execute a requested action. Always call the tool in the same response; never only say you will.");
  parts.push("- Use the exact tool name. Do not encode tool intent in JSON helper fields, helper refs, or placeholder control fields.");
  parts.push("- Ground your spoken reply in the tool result. Do not claim a tool succeeded, opened something, searched something, or sent something before the tool actually returns.");
  parts.push("- When available, prefer the lightest sufficient tool: conversation_search for prior exchanges, web_search for general current info, web_scrape for a known URL, browser_browse only for JS rendering or interaction.");
  parts.push("- If the speaker asks you to look something up, find current facts, check prices, verify something online, open a found article, share a screen link, control music, or leave VC, call the relevant tool immediately instead of narrating intent.");
  parts.push("- If a tool fails or is unavailable, say that briefly and continue naturally without pretending it worked.");

  if (allowMemoryToolCalls) {
    parts.push("Durable memory tools are available.");
    parts.push("- Use memory_write with namespace=speaker to save a durable fact from the speaker turn when genuinely stable and useful.");
    parts.push("- Use memory_write with namespace=self only for a durable fact about your own stable identity/preference/commitment in your reply.");
    parts.push("- Use memory_search only when you need to query durable memory beyond the supplied context.");
    parts.push("- Do not save requests, insults, jokes, toxic phrasing, or rules about how you should talk/behave later.");
    parts.push("- Persistent style/tone requests, standing operating guidance, and recurring trigger/action behaviors belong in adaptive_directive_add / adaptive_directive_remove, not memory_write.");
  } else {
    parts.push("Durable memory tools are unavailable this turn. Do not imply you can save or query durable memory right now.");
  }

  if (allowSoundboardToolCall && normalizedSoundboardCandidates.length) {
    parts.push("Soundboard tool call is available.");
    parts.push("If a sound effect would genuinely improve the moment, call play_soundboard with refs from this list in the order they should fire:");
    parts.push(normalizedSoundboardCandidates.join("\n"));
    parts.push("Do not mention internal refs in spoken text.");
  } else {
    parts.push("Soundboard tool call is unavailable this turn. Do not imply you played a sound effect.");
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
    parts.push("Relevant past conversation windows from shared text/voice history:");
    parts.push(formatConversationWindows(recentConversationHistory));
    parts.push("Use this for continuity when it clearly matches the current turn.");
  }

  if (recentWebLookups?.length) {
    parts.push("Short-term lookup memory from recent successful web searches (may be stale):");
    parts.push(formatRecentLookupContext(recentWebLookups));
    parts.push("If the speaker asks what source you used earlier, mention these cached domains/URLs.");
    parts.push("Use this only as lightweight context. For fresh facts, request a new web lookup.");
  }

  if (normalizedMusicContext && normalizedMusicContext.playbackState !== "idle") {
    const musicLines = ["Music playback:"];
    musicLines.push(`- Status: ${normalizedMusicContext.playbackState}`);
    if (normalizedMusicContext.currentTrack?.title) {
      const artists = normalizedMusicContext.currentTrack.artists.length
        ? normalizedMusicContext.currentTrack.artists.join(", ")
        : "unknown artist";
      musicLines.push(`- Now playing: ${normalizedMusicContext.currentTrack.title} by ${artists}`);
    } else if (normalizedMusicContext.lastTrack?.title && normalizedMusicContext.playbackState === "stopped") {
      const artists = normalizedMusicContext.lastTrack.artists.length
        ? normalizedMusicContext.lastTrack.artists.join(", ")
        : "unknown artist";
      musicLines.push(`- Last played: ${normalizedMusicContext.lastTrack.title} by ${artists}`);
    }
    if (normalizedMusicContext.queueLength > 0) {
      musicLines.push(`- Queue: ${normalizedMusicContext.queueLength} track(s)`);
    }
    if (normalizedMusicContext.lastAction) {
      musicLines.push(`- Last action: ${normalizedMusicContext.lastAction}`);
    }
    if (normalizedMusicContext.lastQuery) {
      musicLines.push(`- Last music query: ${normalizedMusicContext.lastQuery}`);
    }
    parts.push(musicLines.join("\n"));
  }

  parts.push("Conversation-history lookup is available.");
  parts.push("If the speaker asks what was said earlier, what you talked about before, or asks you to remember a past exchange, use conversation_search.");
  if (allowAdaptiveDirectiveToolCalls) {
    parts.push("If someone explicitly asks you to change how you talk, follow a standing instruction, or perform a recurring trigger/action behavior in future conversations, use adaptive_directive_add or adaptive_directive_remove.");
  } else {
    parts.push("Adaptive directives are unavailable this turn. Do not imply you can save standing behavior changes right now.");
  }

  if (allowOpenArticleToolCall) {
    if (normalizedOpenArticleCandidates.length) {
      parts.push("Opening cached articles is available for this turn.");
      parts.push("If the speaker asks to open/read/click a previously found article, call open_article with one ref from this list.");
      parts.push("Valid cached article refs:");
      parts.push(formatOpenArticleCandidates(normalizedOpenArticleCandidates));
      parts.push("Use one ref exactly as listed (or call open_article with ref=first for the top cached article).");
    } else {
      parts.push("No cached article refs are available right now.");
      parts.push("Do not claim you opened a cached article.");
    }
  } else {
    parts.push("Open-article tool call is unavailable this turn. Do not claim you opened a cached article.");
  }

  if (allowWebSearchToolCall) {
    if (webSearch?.optedOutByUser) {
      parts.push("The user asked not to use web search.");
      parts.push("Do not call web_search.");
    } else if (!webSearch?.enabled) {
      parts.push("Live web lookup capability exists but is currently unavailable (disabled in settings).");
      parts.push("Do not call web_search.");
    } else if (!webSearch?.configured) {
      parts.push("Live web lookup capability exists but is currently unavailable (provider not configured).");
      parts.push("Do not call web_search.");
    } else if (webSearch?.blockedByBudget || !webSearch?.budget?.canSearch) {
      parts.push("Live web lookup capability exists but is currently unavailable (budget exhausted).");
      parts.push("Do not call web_search.");
    } else {
      parts.push("Live web lookup is available.");
      parts.push("If your spoken response needs fresh web info for accuracy, call web_search in the same response.");
      parts.push("Only call one web_search when needed.");
    }
  } else {
    parts.push("Web-search tool call is unavailable this turn. Do not call web_search.");
  }

  if (allowBrowserBrowseToolCall) {
    if (!browserBrowse?.enabled) {
      parts.push("Interactive browser capability exists but is currently unavailable (disabled in settings).");
      parts.push("Do not claim you can browse sites interactively right now.");
    } else if (!browserBrowse?.configured) {
      parts.push("Interactive browser capability exists but is currently unavailable (browser runtime is not configured).");
      parts.push("Do not claim you can browse sites interactively right now.");
    } else if (browserBrowse?.blockedByBudget || !browserBrowse?.budget?.canBrowse) {
      parts.push("Interactive browser capability exists but is currently unavailable (hourly browser budget exhausted).");
      parts.push("Do not claim you browsed the site.");
    } else {
      parts.push("Interactive browser browsing is available.");
      parts.push("Prefer web_search for general fresh facts and web_scrape for reading a known URL.");
      parts.push(
        "Use browser_browse only when you need actual site navigation or interaction, such as JS-rendered pages, clicking, typing, scrolling, dragging, or moving through a live page flow."
      );
      parts.push("If interactive browsing is needed, call browser_browse in the same response.");
    }
  } else {
    parts.push("Interactive browser tool call is unavailable this turn. Do not claim you can browse sites interactively right now.");
  }

  if (allowVoiceToolCalls) {
    parts.push("Voice/session control tools are available.");
    parts.push("- For music controls, use music_play_now for immediate playback, music_queue_next to place a track after the current one, music_queue_add to append, music_stop to stop playback, music_pause to pause, music_resume to resume, music_skip to skip, and music_now_playing to inspect status.");
    parts.push("- Use music_search when the speaker wants you to find candidate tracks first instead of starting playback immediately.");
    parts.push("- Do not emulate play-now by chaining music_queue_add and music_skip.");
    parts.push("- Do not use music_skip as a substitute for music_stop.");
    parts.push("- Use note_context to pin important session-scoped facts, plans, preferences, or relationships that should stay available later in this conversation. Do not duplicate something already pinned.");
    parts.push("- Call set_addressing once per turn with your best guess for who the current speaker was talking to: talkingTo should be \"ME\" when they were likely addressing you, otherwise a participant name when reasonably clear, otherwise null. Set confidence to 0..1.");
  } else {
    parts.push("Voice/session control tools are unavailable this turn. Do not claim you changed music playback or left VC via a tool.");
  }

  const screenShareStatus = String(screenShare?.status || "disabled").trim().toLowerCase() || "disabled";
  const screenShareEnabled = Boolean(screenShare?.enabled);
  const screenShareAvailable =
    screenShare?.available === undefined
      ? screenShareEnabled && screenShareStatus === "ready"
      : Boolean(screenShare.available);
  const screenShareSupported =
    screenShare?.supported === undefined
      ? Boolean(screenShare) &&
        String(screenShare?.reason || "").trim().toLowerCase() !== "screen_share_manager_unavailable"
      : Boolean(screenShare.supported);
  const screenShareReason =
    String(screenShare?.reason || "").trim().toLowerCase() || screenShareStatus || "unavailable";

  if (allowScreenShareToolCall) {
    parts.push("VC screen-share link offers are available.");
    parts.push("If the speaker asks you to see/watch their screen or stream, call offer_screen_share_link in the same response.");
    parts.push("Only call offer_screen_share_link once when it is clearly useful.");
  } else if (screenShareSupported && !screenShareAvailable) {
    parts.push(`VC screen-share link capability exists but is currently unavailable (reason: ${screenShareReason}).`);
    parts.push("If asked, acknowledge the capability exists but is unavailable right now.");
    parts.push("Do not claim you sent a screen-share link.");
  } else {
    parts.push("Screen-share tool call is unavailable this turn. Do not claim you sent a screen-share link.");
  }

  parts.push(
    "If you intentionally want to leave VC after this turn, call leave_voice_channel."
  );
  parts.push(
    "Another person's goodbye does not require you to leave. You may say goodbye and stay; call leave_voice_channel only when you intentionally choose to end your own VC session."
  );

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

  if (openedArticle && typeof openedArticle === "object") {
    const openRef = String(openedArticle?.ref || "").trim();
    const openTitle = String(openedArticle?.title || "").trim();
    const openUrl = String(openedArticle?.url || "").trim();
    const openDomain = String(openedArticle?.domain || "").trim();
    const openQuery = String(openedArticle?.query || "").trim();
    const openMethod = String(openedArticle?.extractionMethod || "").trim();
    const openContent = String(openedArticle?.content || "").trim();
    const openError = String(openedArticle?.error || "").trim();

    if (openError) {
      parts.push(`Open-article request failed: ${openError}`);
      parts.push("Respond naturally without claiming full-article read succeeded.");
    } else if (openContent) {
      parts.push("Opened cached article context for this turn:");
      parts.push(
        [
          openRef ? `- ref: ${openRef}` : null,
          openTitle ? `- title: ${openTitle}` : null,
          openDomain ? `- domain: ${openDomain}` : null,
          openUrl ? `- url: ${openUrl}` : null,
          openQuery ? `- source query: ${openQuery}` : null,
          openMethod ? `- extraction: ${openMethod}` : null
        ]
          .filter(Boolean)
          .join("\n")
      );
      parts.push("Opened article extracted text:");
      parts.push(openContent);
    }
  }

  parts.push(
    ...buildVoiceAdmissionPolicyLines({
      inputKind: normalizedInputKind,
      speakerName: speaker,
      directAddressed: normalizedDirectAddressed,
      nameCueDetected: normalizedNameCueDetected,
      isEagerTurn,
      replyEagerness: voiceEagerness,
      participantCount: normalizedParticipantRoster.length,
      conversationContext: normalizedConversationContext,
      pendingCommandFollowupSignal: Boolean(normalizedConversationContext?.pendingCommandFollowupSignal),
      musicActive: Boolean(normalizedConversationContext?.musicActive),
      musicWakeLatched: Boolean(normalizedConversationContext?.musicWakeLatched)
    })
  );
  parts.push(...voiceToneGuardrails);

  parts.push("Return only the spoken reply text for this turn.");
  parts.push("If you should skip the turn, output exactly [SKIP].");
  parts.push("Do not output JSON, markdown, tags, directive syntax like [[...]], or tool names in prose.");
  parts.push("Use tool calls for actions, lookup, voice addressing, screen notes, screen moments, soundboard playback, music control, screen-share links, and leaving VC.");

  return parts.join("\n\n");
}
