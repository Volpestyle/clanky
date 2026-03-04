import {
  buildHardLimitsSection,
  buildVoiceSelfContextLines,
  buildVoiceToneGuardrails,
  DEFAULT_PROMPT_TEXT_GUIDANCE,
  getMediaPromptCraftGuidance,
  getPromptBotName,
  getPromptCapabilityHonestyLine,
  getPromptImpossibleActionLine,
  getPromptMemoryDisabledLine,
  getPromptMemoryEnabledLine,
  getPromptSkipLine,
  getPromptStyle,
  getPromptTextGuidance,
  REPLY_JSON_SCHEMA
} from "../promptCore.ts";

import {
  buildSystemPrompt,
  stripEmojiForPrompt,
  formatRecentChat,
  formatEmojiChoices,
  formatDiscoveryFindings,
  formatWebSearchFindings,
  formatRecentLookupContext,
  formatOpenArticleCandidates,
  formatVideoFindings,
  renderPromptMemoryFact,
  formatMemoryFacts,
  formatMemoryLookupResults,
  formatImageLookupCandidates,
  formatImageLookupResults
} from "./promptFormatters.ts";

export function buildVoiceTurnPrompt({
  speakerName = "unknown",
  transcript = "",
  directAddressed = false,
  userFacts = [],
  relevantFacts = [],
  isEagerTurn = false,
  voiceEagerness = 0,
  conversationContext = null,
  sessionTiming = null,
  joinWindowActive = false,
  joinWindowAgeMs = null,
  botName = "the bot",
  participantRoster = [],
  recentMembershipEvents = [],
  soundboardCandidates = [],
  webSearch = null,
  recentWebLookups = [],
  openArticleCandidates = [],
  openedArticle = null,
  allowWebSearchToolCall = false,
  allowOpenArticleToolCall = false,
  screenShare = null,
  allowScreenShareToolCall = false,
  allowMemoryToolCalls = false,
  allowSoundboardToolCall = false
}) {
  const parts = [];
  const voiceToneGuardrails = buildVoiceToneGuardrails();
  const speaker = String(speakerName || "unknown").trim() || "unknown";
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

  parts.push(`Incoming live voice transcript from ${speaker}: ${text || "(empty)"}`);
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

  if (normalizedConversationContext) {
    parts.push(
      [
        "Conversation attention context:",
        `- State: ${String(normalizedConversationContext.engagementState || "wake_word_biased")}`,
        `- Engaged with current speaker: ${normalizedConversationContext.engagedWithCurrentSpeaker ? "yes" : "no"}`,
        `- Current speaker matches last direct-address speaker: ${normalizedConversationContext.sameAsRecentDirectAddress ? "yes" : "no"}`,
        `- Recent bot reply ms ago: ${
          Number.isFinite(normalizedConversationContext.msSinceAssistantReply)
            ? Math.round(normalizedConversationContext.msSinceAssistantReply)
            : "none"
        }`,
        `- Recent direct address ms ago: ${
          Number.isFinite(normalizedConversationContext.msSinceDirectAddress)
            ? Math.round(normalizedConversationContext.msSinceDirectAddress)
            : "none"
        }`
      ].join("\n")
    );
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

  if (normalizedStreamWatchBrainContext?.notes?.length) {
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

  if (joinWindowActive) {
    parts.push(
      `Join window active: yes${
        Number.isFinite(joinWindowAgeMs) ? ` (${Math.max(0, Math.round(Number(joinWindowAgeMs)))}ms since join)` : ""
      }.`
    );
    parts.push(
      "Join-window bias: if this turn is a short greeting/check-in (for example hi/hey/yo/sup/what's up), default to a brief acknowledgement instead of [SKIP] even in multi-participant channels, unless clearly aimed at another human."
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
        "If this feels naturally wrapped up, you may set leaveVoiceChannel=true to end your VC session after this turn."
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

  if (allowMemoryToolCalls) {
    parts.push("Optional memory tool calls:");
    parts.push("- Set memoryLine to a durable fact from the speaker turn when genuinely stable and useful.");
    parts.push("- Set selfMemoryLine to a durable fact about your own stable identity/preference/commitment in your reply when genuinely stable and useful.");
    parts.push("- Do not save requests, insults, jokes, toxic phrasing, or rules about how you should talk/behave later.");
    parts.push("- Use your own judgment: if it is not a genuine durable memory, leave memoryLine and selfMemoryLine null.");
    parts.push("If not needed, set memoryLine and selfMemoryLine to null.");
  } else {
    parts.push("Memory tool calls are unavailable this turn. Set memoryLine and selfMemoryLine to null.");
  }

  if (allowSoundboardToolCall && normalizedSoundboardCandidates.length) {
    parts.push("Soundboard tool call is available.");
    parts.push("Use soundboardRefs as an ordered array of 0-10 refs from this list:");
    parts.push(normalizedSoundboardCandidates.join("\n"));
    parts.push("If no soundboard effect should play, set soundboardRefs to [].");
  } else {
    parts.push("Soundboard tool call is unavailable this turn. Set soundboardRefs to [].");
  }

  if (recentWebLookups?.length) {
    parts.push("Short-term lookup memory from recent successful web searches (may be stale):");
    parts.push(formatRecentLookupContext(recentWebLookups));
    parts.push("If the speaker asks what source you used earlier, mention these cached domains/URLs.");
    parts.push("Use this only as lightweight context. For fresh facts, request a new web lookup.");
  }

  if (allowOpenArticleToolCall) {
    if (normalizedOpenArticleCandidates.length) {
      parts.push("Opening cached articles is available for this turn.");
      parts.push("If the speaker asks to open/read/click a previously found article, set openArticleRef.");
      parts.push("Valid cached article refs:");
      parts.push(formatOpenArticleCandidates(normalizedOpenArticleCandidates));
      parts.push("Use one ref exactly as listed (or set openArticleRef to first for the top cached article).");
    } else {
      parts.push("No cached article refs are available right now.");
      parts.push("Set openArticleRef to null.");
    }
  } else {
    parts.push("Open-article tool call is unavailable this turn. Set openArticleRef to null.");
  }

  if (allowWebSearchToolCall) {
    if (webSearch?.optedOutByUser) {
      parts.push("The user asked not to use web search.");
      parts.push("Set webSearchQuery to null.");
    } else if (!webSearch?.enabled) {
      parts.push("Live web lookup capability exists but is currently unavailable (disabled in settings).");
      parts.push("Set webSearchQuery to null.");
    } else if (!webSearch?.configured) {
      parts.push("Live web lookup capability exists but is currently unavailable (provider not configured).");
      parts.push("Set webSearchQuery to null.");
    } else if (webSearch?.blockedByBudget || !webSearch?.budget?.canSearch) {
      parts.push("Live web lookup capability exists but is currently unavailable (budget exhausted).");
      parts.push("Set webSearchQuery to null.");
    } else {
      parts.push("Live web lookup is available.");
      parts.push("If your spoken response needs fresh web info for accuracy, set webSearchQuery to a concise query.");
      parts.push("Only request one web lookup when needed.");
    }
  } else {
    parts.push("Web-search tool call is unavailable this turn. Set webSearchQuery to null.");
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
    parts.push("If the speaker asks you to see/watch their screen or stream, set screenShareIntent.action=offer_link.");
    parts.push("Only use one screen-share tool call when it is clearly useful.");
  } else if (screenShareSupported && !screenShareAvailable) {
    parts.push(`VC screen-share link capability exists but is currently unavailable (reason: ${screenShareReason}).`);
    parts.push("If asked, acknowledge the capability exists but is unavailable right now.");
    parts.push("Set screenShareIntent.action=none.");
  } else {
    parts.push("Screen-share tool call is unavailable this turn. Set screenShareIntent.action=none.");
  }

  parts.push(
    "If you intentionally want to leave VC after this turn, set leaveVoiceChannel=true."
  );
  parts.push(
    "Another person's goodbye does not require you to leave. You may say goodbye and stay; set leaveVoiceChannel=true only when you intentionally choose to end your own VC session."
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

  if (isEagerTurn) {
    const eagerness = Math.max(0, Math.min(100, Number(voiceEagerness) || 0));
    parts.push(`You were NOT directly addressed. You're considering whether to chime in.`);
    parts.push(`Voice reply eagerness: ${eagerness}/100.`);
    if (normalizedConversationContext?.engagedWithCurrentSpeaker) {
      parts.push("You are actively in this speaker's thread. Lean toward a short helpful reply over [SKIP].");
    }
    parts.push(
      "If the turn is only laughter, filler, or backchannel noise (for example haha, lol, hmm, mm, uh-huh, yup), strongly prefer [SKIP] unless there is a clear question, request, or obvious conversational value in replying."
    );
    parts.push("Only speak up if you can genuinely add value. If not, output exactly [SKIP].");

    parts.push(...voiceToneGuardrails);
    parts.push("Task: respond as a natural spoken VC reply, or skip if you have nothing to add.");
  } else if (!normalizedDirectAddressed) {
    parts.push(
      "If the turn is only laughter, filler, or backchannel noise with no clear ask or meaningful new content, prefer [SKIP]."
    );
    parts.push(...voiceToneGuardrails);
    parts.push("Task: decide whether to respond now or output [SKIP] if a reply would be interruptive, low-value, or likely not meant for you.");
  } else {
    parts.push(...voiceToneGuardrails);
    parts.push("Task: respond as a natural spoken VC reply.");
  }

  parts.push(
    "Always set voiceAddressing as your best addressing guess for the incoming speaker turn: talkingTo should be \"ME\" when the speaker is likely talking to you, otherwise a participant name when reasonably clear, otherwise null."
  );
  parts.push("Set voiceAddressing.directedConfidence to a 0..1 confidence score for that talkingTo guess.");

  parts.push("Return strict JSON only.");
  parts.push("JSON format:");
  parts.push(
    "{\"text\":\"spoken response or [SKIP]\",\"skip\":false,\"reactionEmoji\":null,\"media\":null,\"webSearchQuery\":null,\"memoryLookupQuery\":null,\"imageLookupQuery\":null,\"openArticleRef\":null,\"memoryLine\":null,\"selfMemoryLine\":null,\"soundboardRefs\":[],\"leaveVoiceChannel\":false,\"automationAction\":{\"operation\":\"none\",\"title\":null,\"instruction\":null,\"schedule\":null,\"targetQuery\":null,\"automationId\":null,\"runImmediately\":false,\"targetChannelId\":null},\"voiceIntent\":{\"intent\":\"none\",\"confidence\":0,\"reason\":null,\"query\":null,\"platform\":null,\"searchResults\":null,\"selectedResultId\":null},\"screenShareIntent\":{\"action\":\"none\",\"confidence\":0,\"reason\":null},\"voiceAddressing\":{\"talkingTo\":null,\"directedConfidence\":0}}"
    );
  parts.push("Keep reactionEmoji null, media null, memoryLookupQuery null, imageLookupQuery null, and voiceIntent intent none for voice-turn generation.");
  parts.push("Always include voiceAddressing with both fields.");
  parts.push("If you are skipping, set skip=true and text to [SKIP]. Otherwise set skip=false and provide natural spoken text.");
  parts.push("Never output markdown, tags, or directive syntax like [[...]].");

  return parts.join("\n\n");
}
