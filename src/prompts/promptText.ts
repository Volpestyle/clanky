import {
  buildVoiceSelfContextLines,
  getMediaPromptCraftGuidance,
  REPLY_JSON_SCHEMA
} from "./promptCore.ts";

import {
  formatBehaviorMemoryFacts,
  formatInitiativeChannelSummaries,
  formatInitiativeFeedCandidates,
  formatInitiativeInterestFacts,
  formatInitiativeSourcePerformance,
  formatRecentChat,
  formatConversationWindows,
  formatConversationParticipantMemory,
  formatEmojiChoices,
  formatDiscoveryFindings,
  formatWebSearchFindings,
  formatRecentLookupContext,
  formatVideoFindings,
  formatMemoryFacts,
  formatMemoryLookupResults,
  formatImageLookupCandidates,
  formatImageLookupResults
} from "./promptFormatters.ts";

function formatPromptTrackLabel(track) {
  const title = String(track?.title || "").trim();
  if (!title) return "";
  const artist = Array.isArray(track?.artists)
    ? track.artists.map((value) => String(value || "").trim()).filter(Boolean).join(", ")
    : String(track?.artist || "").trim();
  return artist ? `${title} by ${artist}` : title;
}

function formatPromptUpcomingTracks(tracks) {
  const rows = Array.isArray(tracks) ? tracks : [];
  return rows
    .slice(0, 3)
    .map((track, index) => {
      const label = formatPromptTrackLabel(track);
      return label ? `${index + 1}. ${label}` : "";
    })
    .filter(Boolean)
    .join(" | ");
}

function describeInitiativeEagerness(eagerness) {
  const normalized = Math.max(0, Math.min(100, Number(eagerness) || 0));
  if (normalized <= 15) {
    return "Very quiet. Only post when something clearly feels worth it.";
  }
  if (normalized <= 35) {
    return "Low-key. Stay selective and skip often unless something genuinely catches your eye.";
  }
  if (normalized <= 55) {
    return "Balanced. Post when there is a natural fit, otherwise keep lurking.";
  }
  if (normalized <= 75) {
    return "Engaged. You can start conversations or share finds when they fit the room.";
  }
  if (normalized <= 90) {
    return "Highly social. Lighter contributions are fine when they feel timely.";
  }
  return "Very proactive. Jump in freely when something seems fun, useful, or worth sharing.";
}

export function buildReplyPrompt({
  message,
  triggerMessageIds = [],
  imageInputs,
  recentMessages,
  userFacts,
  relevantFacts,
  participantProfiles = [],
  selfFacts = [],
  loreFacts = [],
  guidanceFacts = [],
  behavioralFacts = [],
  emojiHints,
  reactionEmojiOptions = [],
  allowReplySimpleImages = false,
  allowReplyComplexImages = false,
  remainingReplyImages = 0,
  allowReplyVideos = false,
  remainingReplyVideos = 0,
  allowReplyGifs = false,
  remainingReplyGifs = 0,
  gifRepliesEnabled = false,
  gifsConfigured = false,
  replyEagerness = 35,
  reactionEagerness = 20,
  addressing = null,
  webSearch = null,
  browserBrowse = null,
  recentConversationHistory = [],
  recentWebLookups = [],
  memoryLookup = null,
  imageLookup = null,
  allowWebSearchDirective = false,
  allowBrowserBrowseDirective = false,
  allowMemoryLookupDirective = false,
  allowImageLookupDirective = false,
  allowMemoryDirective = false,
  allowAutomationDirective = false,
  automationTimeZoneLabel = "",
  voiceMode = null,
  screenShare = null,
  videoContext = null,
  channelMode = "other_channel",
  maxMediaPromptChars = 900,
  mediaPromptCraftGuidance = null
}) {
  const parts = [];
  const mediaGuidance = String(mediaPromptCraftGuidance || "").trim() || getMediaPromptCraftGuidance(null);
  const normalizedChannelMode = channelMode === "reply_channel" ? "reply_channel" : "other_channel";
  const triggerCount = Array.isArray(triggerMessageIds) ? triggerMessageIds.length : 0;

  parts.push("=== LATEST MESSAGE (TURN ANCHOR) ===");
  parts.push(`Message from ${message.authorName}: ${message.content}`);
  if (triggerCount > 1) {
    parts.push(`This reply turn was coalesced from ${triggerCount} recent messages in a short burst.`);
    parts.push(
      "You may respond to only the latest message or combine multiple recent messages when they are clearly part of one thread."
    );
  }
  if (imageInputs?.length) {
    parts.push(
      [
        "Current message attachments:",
        ...imageInputs.map((image) => {
          const name = image.filename || "(unnamed)";
          const type = image.contentType || "unknown";
          return `- ${name} (${type})`;
        })
      ].join("\n")
    );
  }
  parts.push("=== RECENT MESSAGES ===");
  parts.push(formatRecentChat(recentMessages, { imageCandidates: imageLookup?.candidates }));

  if (recentConversationHistory?.length) {
    parts.push("=== RECENT CONVERSATION CONTINUITY ===");
    parts.push("Relevant past conversation windows (each labeled with age and source type — voice chat or text):");
    parts.push(formatConversationWindows(recentConversationHistory));
    parts.push("Use this for continuity ONLY when it clearly matches the current topic AND is recent. Old windows (hours/days ago) are background context, not active conversation — do not treat them as ongoing. A voice chat transcript from hours ago is not the same as someone just saying something to you now.");
  }
  parts.push("Conversation-history lookup is available for recalling prior text/voice exchanges. If the user asks what was said earlier or what you talked about before, use conversation_search.");

  if (participantProfiles?.length || selfFacts?.length || loreFacts?.length) {
    parts.push("=== PEOPLE IN THIS CONVERSATION ===");
    parts.push(
      formatConversationParticipantMemory({
        participantProfiles,
        selfFacts,
        loreFacts
      })
    );
  }

  if (guidanceFacts?.length) {
    parts.push("=== BEHAVIOR GUIDANCE ===");
    parts.push("Standing guidance memory that should shape how you act in this conversation:");
    parts.push(formatBehaviorMemoryFacts(guidanceFacts, 10));
  }

  if (behavioralFacts?.length) {
    parts.push("=== RELEVANT BEHAVIORAL MEMORY ===");
    parts.push("These behavior memories were retrieved because they match this turn. Follow them when relevant.");
    parts.push(formatBehaviorMemoryFacts(behavioralFacts, 8));
  }

  if (memoryLookup?.requested) {
    if (memoryLookup.error) {
      parts.push(`Memory lookup failed: ${memoryLookup.error}`);
      parts.push("Answer from currently available context and avoid inventing memory.");
    } else if (!memoryLookup.results?.length) {
      parts.push(`Memory lookup for "${memoryLookup.query || message?.content || ""}" found no durable matches.`);
      parts.push("Say that no strong memory match was found if the user asked what you remember.");
    } else {
      const isFullMemory = memoryLookup.query === "__ALL__";
      if (isFullMemory) {
        parts.push("Stored memory dump (capped view of stored facts):");
      } else {
        parts.push(`Memory lookup results for "${memoryLookup.query || message?.content || ""}":`);
      }
      parts.push(formatMemoryLookupResults(memoryLookup.results));
      if (!isFullMemory) {
        parts.push("Reference memory naturally without source tags by default.");
        parts.push(
          "Only cite memory hits inline as [M1], [M2], etc. when the user explicitly asks for memory citations, sources, or proof."
        );
      }
    }
  }

  if (imageLookup?.requested) {
    parts.push("=== IMAGE LOOKUP RESULTS ===");
    if (imageLookup.error) {
      parts.push(`History image lookup failed: ${imageLookup.error}`);
      parts.push("Answer from currently available context and avoid pretending you saw an older image.");
    } else if (!imageLookup.results?.length) {
      parts.push(`History image lookup for "${imageLookup.query || message?.content || ""}" found no matches.`);
      parts.push("Say briefly that no matching prior image was found if the user asked about one.");
    } else {
      parts.push(`History image lookup results for "${imageLookup.query || message?.content || ""}":`);
      parts.push(formatImageLookupResults(imageLookup.results));
      parts.push("Use this visual context directly and avoid guessing details not present.");
    }
  }

  if (recentWebLookups?.length) {
    parts.push("=== RECENT LOOKUP MEMORY ===");
    parts.push("Recent successful web searches (may be stale):");
    parts.push(formatRecentLookupContext(recentWebLookups));
    parts.push("If the user asks what source you used earlier, reference these cached domains/URLs directly.");
    parts.push("Use this as background context only. If freshness matters, run a new live web lookup.");
  }

  if (emojiHints?.length) {
    parts.push(`=== EMOJI OPTIONS ===`);
    parts.push(`Server emoji: ${emojiHints.join(", ")}`);
  }
  if (reactionEmojiOptions?.length) {
    parts.push("Allowed reactions:");
    parts.push(formatEmojiChoices(reactionEmojiOptions));
  }

  parts.push("=== RESPONSE DECISION ===");

  const directlyAddressed = Boolean(addressing?.directlyAddressed);
  const directAddressConfidence = Number(addressing?.directAddressConfidence);
  const directAddressThreshold = Number(addressing?.directAddressThreshold);
  const responseRequired = Boolean(addressing?.responseRequired);
  if (Number.isFinite(directAddressConfidence)) {
    const boundedConfidence = Math.max(0, Math.min(1, directAddressConfidence));
    const boundedThreshold = Number.isFinite(directAddressThreshold)
      ? Math.max(0.4, Math.min(0.95, directAddressThreshold))
      : 0.62;
    parts.push(
      `Direct-address confidence: ${boundedConfidence.toFixed(3)} (threshold ${boundedThreshold.toFixed(2)}).`
    );
  }
  if (directlyAddressed) {
    parts.push("This message directly addressed you.");
  }
  parts.push(
    "If something you can do is currently disabled or budget-blocked, say it is currently unavailable with the reason. Do not claim a supported feature can never work."
  );
  if (responseRequired) {
    parts.push("A reply is required for this turn unless safety policy requires refusing.");
    parts.push("Do not output [SKIP] except for safety refusals.");
  } else {
    const eagerness = Math.max(0, Math.min(100, Number(replyEagerness) || 0));
    parts.push(`Your reply eagerness is ${eagerness}/100.`);

    // Core eagerness personality
    if (eagerness <= 15) {
      parts.push("You are mostly a lurker. Only speak when someone is clearly talking to you or you have something genuinely important to say.");
    } else if (eagerness <= 35) {
      parts.push("You tend to observe more than talk. Only chime in when you genuinely have something to say or someone is clearly engaging with you.");
    } else if (eagerness <= 55) {
      parts.push("Be selective about when you jump in. If you do not have something genuinely useful, interesting, or funny to add, output [SKIP].");
    } else if (eagerness <= 75) {
      parts.push("You are fairly engaged. Contribute when you have something that fits the flow, but still pick your moments.");
    } else if (eagerness <= 90) {
      parts.push("You are an active participant. Jump in when you have something — even lighter contributions are fine if they fit naturally.");
    } else {
      parts.push("You are very social and love riffing with people. Jump in freely when you have something, even casual reactions and banter.");
    }

    // Directed-at-someone-else signal (scaled by eagerness)
    const directedAtSomeoneElse = Boolean(addressing?.mentionsOtherUsers) || Boolean(addressing?.repliesToOtherUser);
    if (directedAtSomeoneElse) {
      if (eagerness <= 75) {
        parts.push("This message is directed at another user (via @mention or reply). It is not for you. Output [SKIP] unless the message also clearly invites you to participate.");
      } else {
        parts.push("This message is directed at another user (via @mention or reply). Strongly prefer [SKIP] — only jump in if you have something genuinely worth adding to their exchange.");
      }
    }

    // Conversational awareness (always present, strength scales with eagerness)
    if (eagerness <= 60) {
      parts.push("If people are talking to each other (using names, replying back and forth, making plans together), output [SKIP]. Do not insert yourself into someone else's conversation.");
    } else {
      parts.push("If people are clearly having a private or directed exchange with each other, prefer [SKIP] unless you can genuinely add to the conversation.");
    }

    // Channel mode
    if (normalizedChannelMode === "reply_channel") {
      parts.push("This is one of your reply/lurk channels. Short riffs and acknowledgements are fine when they fit naturally.");
      parts.push("If your reply would derail, interrupt, or just repeat what was said, output [SKIP].");
    } else {
      parts.push("This is not one of your reply/lurk channels. Only jump in if your message is worth the interruption.");
    }
  }

  const reactionLevel = Math.max(0, Math.min(100, Number(reactionEagerness) || 0));
  if (reactionLevel <= 25) {
    parts.push("React sparingly — only when it genuinely adds something.");
  } else if (reactionLevel >= 75) {
    parts.push("Feel free to react when it naturally fits the tone.");
  } else {
    parts.push("React when it feels right, not by default.");
  }
  parts.push("If a reaction fits, set reactionEmoji to exactly one allowed emoji. Otherwise set reactionEmoji to null.");

  parts.push("=== VOICE CONTROL ===");
  const voiceEnabled = Boolean(voiceMode?.enabled);
  const inVoiceChannel = voiceEnabled && Boolean(voiceMode?.activeSession);
  const voiceParticipantRoster = Array.isArray(voiceMode?.participantRoster) ? voiceMode.participantRoster : [];
  parts.push(
    ...buildVoiceSelfContextLines({
      voiceEnabled,
      inVoiceChannel,
      participantRoster: voiceParticipantRoster
    })
  );
  if (voiceEnabled) {
    parts.push("You have voice channel capability. Use join_voice_channel / leave_voice_channel tools to manage your VC presence.");
    if (inVoiceChannel) {
      parts.push("You are currently in a voice channel.");
    } else {
      parts.push("You are not currently in a voice channel. To play music or interact in VC, call join_voice_channel first.");
    }
    parts.push("Music commands (play, queue, stop, pause, skip, search) are available as tool calls. If you are not in a voice channel, call join_voice_channel first, then call the music tool.");
    if (voiceMode?.musicState) {
      const musicPlaybackState = String(voiceMode.musicState.playbackState || "idle").trim().toLowerCase() || "idle";
      const currentTrackLabel = formatPromptTrackLabel(voiceMode.musicState.currentTrack);
      const lastTrackLabel = formatPromptTrackLabel(voiceMode.musicState.lastTrack);
      const queueLength = Math.max(0, Math.floor(Number(voiceMode.musicState.queueLength) || 0));
      const upcomingTracksLabel = formatPromptUpcomingTracks(voiceMode.musicState.upcomingTracks);
      const lastAction = String(voiceMode.musicState.lastAction || "").trim().toLowerCase() || null;
      const lastQuery = String(voiceMode.musicState.lastQuery || "").trim() || null;
      parts.push(
        [
          "Current voice music state:",
          `- Playback: ${musicPlaybackState}`,
          currentTrackLabel ? `- Current track: ${currentTrackLabel}` : null,
          !currentTrackLabel && lastTrackLabel ? `- Most recent track: ${lastTrackLabel}` : null,
          `- Queue length: ${queueLength} total track${queueLength === 1 ? "" : "s"}`,
          upcomingTracksLabel ? `- Next queued tracks: ${upcomingTracksLabel}` : null,
          lastAction ? `- Most recent music action: ${lastAction}` : null,
          lastQuery ? `- Most recent music request: ${lastQuery}` : null,
          "- If the user asks what is playing, what was stopped, or what is queued, answer from this state directly."
        ]
          .filter(Boolean)
          .join("\n")
      );
    }
    const musicDisambiguationActive = Boolean(voiceMode?.musicDisambiguation?.active);
    const musicDisambiguationOptions = Array.isArray(voiceMode?.musicDisambiguation?.options)
      ? voiceMode.musicDisambiguation.options
      : [];
    if (musicDisambiguationActive && musicDisambiguationOptions.length > 0) {
      const pendingQuery = String(voiceMode?.musicDisambiguation?.query || "").trim() || null;
      const pendingPlatform = String(voiceMode?.musicDisambiguation?.platform || "auto").trim().toLowerCase() || "auto";
      const pendingAction = voiceMode.musicDisambiguation.action === "queue_next" ? "music_queue_next" : voiceMode.musicDisambiguation.action === "queue_add" ? "music_queue_add" : "music_play";
      parts.push(
        `There is a pending music disambiguation request${pendingQuery ? ` for query "${pendingQuery}"` : ""} on platform ${pendingPlatform}.`
      );
      parts.push(
        [
          "Pending music options:",
          ...musicDisambiguationOptions.slice(0, 5).map((entry, index) => {
            const id = String(entry?.id || "").trim();
            const title = String(entry?.title || "").trim() || "unknown";
            const artist = String(entry?.artist || "").trim() || "unknown";
            const platform = String(entry?.platform || "").trim().toLowerCase() || "unknown";
            return `${index + 1}. id=${id}; title=${title}; artist=${artist}; platform=${platform}`;
          })
        ].join("\n")
      );
      parts.push(
        `If the user picks one of those options (by number or by naming it), call ${pendingAction} with the selection_id set to that exact id.`
      );
    }
  } else {
    parts.push("Voice control capability exists but is currently disabled in settings.");
    parts.push("If asked to join VC or play music, say voice mode is currently disabled.");
  }

  parts.push("=== SCREEN SHARE ===");

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
  if (screenShareAvailable) {
    parts.push("You can offer a secure temporary screen-share link when useful.");
    parts.push(
      "If the user asks you to see/watch their screen or stream, set screenShareIntent.action to offer_link."
    );
    parts.push(
      "If visual context would materially improve troubleshooting/help, you may proactively set screenShareIntent.action to offer_link."
    );
    parts.push(
      "Set screenShareIntent.confidence from 0 to 1. Use high confidence only when a share link is clearly useful."
    );
  } else if (screenShareSupported) {
    parts.push(`Screen-share link capability exists but is currently unavailable (reason: ${screenShareReason}).`);
    parts.push("If asked, explain it can work when available, but do not claim you can watch a screen right now.");
    parts.push("Set screenShareIntent.action to none.");
  } else {
    parts.push("Screen-share links are not available in this runtime.");
    parts.push("Set screenShareIntent.action to none.");
  }

  parts.push("=== AUTOMATION ===");

  if (allowAutomationDirective) {
    const tzLabel = String(automationTimeZoneLabel || "").trim() || "local server time";
    parts.push(`Automations are available for this guild. Scheduler timezone: ${tzLabel}.`);
    parts.push("If the user asks to schedule/start recurring tasks, set automationAction.operation=create.");
    parts.push("For create, set automationAction.schedule with one of:");
    parts.push("- daily: {\"kind\":\"daily\",\"hour\":0-23,\"minute\":0-59}");
    parts.push("- interval: {\"kind\":\"interval\",\"everyMinutes\":integer}");
    parts.push("- once: {\"kind\":\"once\",\"atIso\":\"ISO-8601 timestamp\"}");
    parts.push("For create, set automationAction.instruction to the exact task instruction (what to do each run).");
    parts.push("Use automationAction.runImmediately=true only when user asks for immediate first run.");
    parts.push("If user asks to stop/pause a recurring task, set automationAction.operation=pause with targetQuery.");
    parts.push("If user asks to resume/re-enable, set automationAction.operation=resume with targetQuery.");
    parts.push("If user asks to remove/delete permanently, set automationAction.operation=delete with targetQuery.");
    parts.push("If user asks to see what is scheduled, set automationAction.operation=list.");
    parts.push("When no automation control is requested, set automationAction.operation=none.");
  }

  parts.push("=== WEB SEARCH ===");

  if (allowWebSearchDirective) {
    if (webSearch?.optedOutByUser) {
      parts.push("The user explicitly asked not to use web search.");
      parts.push("Set webSearchQuery to null and do not claim live lookup.");
    } else if (!webSearch?.enabled) {
      parts.push("Live web lookup capability exists but is currently unavailable (disabled in settings).");
      parts.push("Set webSearchQuery to null.");
      parts.push("Do not claim you searched the web.");
    } else if (!webSearch?.configured) {
      parts.push("Live web lookup capability exists but is currently unavailable (no search provider is configured).");
      parts.push("Set webSearchQuery to null.");
      parts.push("Do not claim you searched the web.");
    } else if (webSearch?.blockedByBudget || !webSearch?.budget?.canSearch) {
      parts.push("Live web lookup capability exists but is currently unavailable (hourly search budget exhausted).");
      parts.push("Set webSearchQuery to null.");
      parts.push("Do not claim you searched the web.");
    } else {
      parts.push("Live web lookup is available.");
      parts.push("Web search is supported right now.");
      parts.push("Do not claim you cannot search the web.");
      parts.push(
        "If better accuracy depends on live web info, set webSearchQuery to a concise query."
      );
      parts.push("Use webSearchQuery only when needed and keep it under 220 characters.");
    }
  }

  parts.push("=== BROWSER ===");

  if (allowBrowserBrowseDirective) {
    if (!browserBrowse?.enabled) {
      parts.push("Interactive browser capability exists but is currently unavailable (disabled in settings).");
      parts.push("Set browserBrowseQuery to null.");
      parts.push("Do not claim you can browse sites interactively right now.");
    } else if (!browserBrowse?.configured) {
      parts.push("Interactive browser capability exists but is currently unavailable (browser runtime is not configured).");
      parts.push("Set browserBrowseQuery to null.");
      parts.push("Do not claim you can browse sites interactively right now.");
    } else if (browserBrowse?.blockedByBudget || !browserBrowse?.budget?.canBrowse) {
      parts.push("Interactive browser capability exists but is currently unavailable (hourly browser budget exhausted).");
      parts.push("Set browserBrowseQuery to null.");
      parts.push("Do not claim you browsed the site.");
    } else {
      parts.push("Interactive browser browsing is available.");
      parts.push("Prefer webSearchQuery for simple current facts.");
      parts.push(
        "Use browserBrowseQuery only when you need actual site navigation or interaction, such as checking listings, moving through a live page flow, or extracting page-specific details."
      );
      parts.push("If interactive browsing is needed, set browserBrowseQuery to a concise task under 500 characters.");
    }
  }

  parts.push("=== MEMORY LOOKUP ===");

  if (allowMemoryLookupDirective) {
    if (!memoryLookup?.enabled) {
      parts.push("Durable memory lookup capability exists but is currently unavailable for this turn.");
      parts.push("Set memoryLookupQuery to null.");
    } else {
      parts.push("Durable memory lookup is available for this turn.");
      parts.push(
        "If the user asks what you remember (or asks for stored facts) and current memory context is insufficient, set memoryLookupQuery to a concise lookup query."
      );
      parts.push("If the user asks for a broad dump of stored memory or everything you remember, set memoryLookupQuery to \"__ALL__\".");
      parts.push("`__ALL__` requests a capped stored-memory dump, not a ranked topical lookup.");
      parts.push("Use memoryLookupQuery only when needed and keep it under 220 characters.");
    }
  }

  if (allowImageLookupDirective) {
    if (!imageLookup?.enabled) {
      parts.push("History image lookup capability exists but is currently unavailable for this turn.");
      parts.push("Set imageLookupQuery to null.");
    } else if (!imageLookup?.candidates?.length) {
      parts.push("History image lookup capability is available, but no recent image references were found.");
      parts.push("Set imageLookupQuery to null.");
    } else {
      parts.push("History image lookup is available for this turn.");
      parts.push("Recent image references from message history:");
      parts.push(formatImageLookupCandidates(imageLookup.candidates));
      parts.push(
        "If the user refers to an earlier image/photo and current message attachments are insufficient, set imageLookupQuery to a concise lookup query or a specific image ref like IMG 3."
      );
      parts.push("The [IMG n] markers in recent chat are historical images, not fresh attachments on the latest user message.");
      parts.push("Use imageLookupQuery only when needed and keep it under 220 characters.");
      parts.push("If no historical image lookup is needed, set imageLookupQuery to null.");
      parts.push("Do not claim you cannot review earlier shared images when history lookup is available.");
    }
  }

  parts.push("=== WEB SEARCH RESULTS ===");

  if (webSearch?.requested && !webSearch.used) {
    if (webSearch.optedOutByUser) {
      parts.push("The user asked not to use web search. Respond without web lookup.");
    } else if (!webSearch.enabled) {
      parts.push("A web lookup was requested, but live search is disabled in settings.");
      parts.push("Acknowledge briefly and answer from known context only.");
    } else if (!webSearch.configured) {
      parts.push(
        "The user asked for a web lookup, but live search is unavailable (no search provider is configured)."
      );
      parts.push("Acknowledge briefly and answer from known context only.");
    } else if (webSearch.blockedByBudget) {
      parts.push("The user asked for a web lookup, but the hourly search budget is exhausted.");
      parts.push("Acknowledge the limit briefly and answer without claiming live lookup.");
    } else if (webSearch.error) {
      parts.push(`The web lookup failed: ${webSearch.error}`);
      parts.push("Do not claim you successfully searched the web.");
    } else if (!webSearch.results?.length) {
      parts.push("A web lookup was attempted, but no useful results were found.");
      parts.push("Answer carefully and avoid invented specifics.");
    }
  }

  if (webSearch?.used && webSearch.results?.length) {
    parts.push(`Live web findings for query: "${webSearch.query}"`);
    parts.push(formatWebSearchFindings(webSearch));
    parts.push(
      "Decide whether to cite sources based on the user's message and the claim sensitivity."
    );
    parts.push(
      "If citations would help (for example user asked for proof/sources or the claim is precise), use source IDs inline like [1] or [2]."
    );
    parts.push("If citations are not needed, answer naturally without citation clutter.");
  }

  parts.push("=== BROWSER RESULTS ===");

  if (browserBrowse?.requested) {
    if (browserBrowse.error) {
      parts.push(`Interactive browser task failed: ${browserBrowse.error}`);
      parts.push("Do not claim you successfully browsed the site.");
    } else if (!browserBrowse.used || !browserBrowse.text) {
      parts.push("An interactive browser task was attempted, but it did not return a useful result.");
      parts.push("Answer carefully and avoid invented browsing details.");
    } else {
      parts.push(`Interactive browser result for "${browserBrowse.query || message?.content || ""}":`);
      parts.push(String(browserBrowse.text || ""));
      parts.push("Use this result directly and mention uncertainty if the browsing result was incomplete.");
    }
  }

  parts.push("=== VIDEO CONTEXT ===");

  if (videoContext?.requested && !videoContext.used) {
    if (!videoContext.enabled) {
      parts.push("Video link understanding capability exists but is currently unavailable (disabled in settings).");
    } else if (videoContext.blockedByBudget || !videoContext.budget?.canLookup) {
      parts.push(
        "Video link understanding capability exists but is currently unavailable (hourly video context budget exhausted)."
      );
    } else if (videoContext.error) {
      parts.push(`Video link context fetch failed: ${videoContext.error}`);
    } else {
      parts.push("Video links/attachments were detected, but no usable metadata/transcript was extracted.");
    }
    parts.push("Do not claim you watched or fully understood the video when context is missing.");
  }

  if (videoContext?.used && videoContext.videos?.length) {
    parts.push("Video context from linked or embedded videos:");
    parts.push(formatVideoFindings(videoContext));
    parts.push("If you reference video details, cite source IDs inline like [V1] or [V2].");
    parts.push("Treat transcripts and keyframes as partial context. Avoid overclaiming what happened in the full video.");
  }

  parts.push("=== MEDIA GENERATION ===");

  const remainingImages = Math.max(0, Math.floor(Number(remainingReplyImages) || 0));
  const remainingVideos = Math.max(0, Math.floor(Number(remainingReplyVideos) || 0));
  const simpleImageAvailable = allowReplySimpleImages && remainingImages > 0;
  const complexImageAvailable = allowReplyComplexImages && remainingImages > 0;
  const videoGenerationAvailable = allowReplyVideos && remainingVideos > 0;
  const anyVisualGeneration = simpleImageAvailable || complexImageAvailable || videoGenerationAvailable;

  if (anyVisualGeneration) {
    parts.push(
      `Visual generation is available (${remainingImages} image slot(s), ${remainingVideos} video slot(s) left where enabled in the rolling 24h budgets).`
    );
    if (simpleImageAvailable) {
      parts.push("For a simple/quick visual, set media to {\"type\":\"image_simple\",\"prompt\":\"...\"}.");
      parts.push("Use image_simple for straightforward concepts or fast meme-style visuals.");
    }
    if (complexImageAvailable) {
      parts.push("For a detailed/composition-heavy visual, set media to {\"type\":\"image_complex\",\"prompt\":\"...\"}.");
      parts.push("Use image_complex for cinematic/detail-rich scenes or harder visual requests.");
    }
    if (videoGenerationAvailable) {
      parts.push("If a generated clip is best, set media to {\"type\":\"video\",\"prompt\":\"...\"}.");
      parts.push("Use video when motion/animation is meaningfully better than a still image.");
    }
    parts.push(`Keep image/video media prompts under ${maxMediaPromptChars} chars, and always include normal reply text.`);
    parts.push(mediaGuidance);
  } else {
    parts.push("Reply image/video generation capability exists but is currently unavailable for this turn.");
    parts.push("Respond with text only.");
    parts.push("Set media to null.");
  }

  parts.push("=== GIFS ===");
  const remainingGifs = Math.max(0, Math.floor(Number(remainingReplyGifs) || 0));
  if (allowReplyGifs && remainingGifs > 0) {
    parts.push(`Reply GIF lookup is available (${remainingGifs} GIF lookup(s) left in the rolling 24h budget).`);
    parts.push("GIF replies are supported right now.");
    parts.push("Do not claim you cannot send GIFs and do not claim you are text-only.");
    parts.push("If a GIF should be sent, set media to {\"type\":\"gif\",\"prompt\":\"short search query\"}.");
    parts.push("Use media.type=gif only when a reaction GIF genuinely improves the reply.");
    parts.push("Keep GIF media prompts concise (under 120 chars), and always include normal reply text.");
  } else if (gifRepliesEnabled && !gifsConfigured) {
    parts.push("Reply GIF lookup capability exists but is currently unavailable (missing GIPHY configuration).");
    parts.push("Do not set media.type=gif.");
  } else if (gifRepliesEnabled) {
    parts.push("Reply GIF lookup capability exists but is currently unavailable (24h GIF budget exhausted).");
    parts.push("Do not set media.type=gif.");
  }

  if (anyVisualGeneration || (allowReplyGifs && remainingGifs > 0)) {
    parts.push("Set at most one media object for this reply.");
  }

  parts.push("=== OUTPUT FORMAT ===");
  parts.push("Task: write one natural Discord reply for this turn.");
  parts.push("If recent messages are one coherent thread, you may combine and answer multiple messages in one reply.");
  parts.push("If recent messages are unrelated, prioritize the latest message and keep the reply focused.");
  parts.push("Return strict JSON only. Do not output markdown or code fences.");
  parts.push("JSON format:");
  parts.push(REPLY_JSON_SCHEMA);
  parts.push("Set skip=true only when no response should be sent. If skip=true, set text to [SKIP].");
  parts.push("When no reaction is needed, set reactionEmoji to null.");
  parts.push("When no media should be generated, set media to null.");
  parts.push(
    "When no lookup is needed, set webSearchQuery, browserBrowseQuery, memoryLookupQuery, imageLookupQuery, and openArticleRef to null."
  );
  parts.push("Set soundboardRefs to [] and leaveVoiceChannel to false for text-channel replies.");
  parts.push("When no automation command is intended, set automationAction.operation=none and other automationAction fields to null/false.");
  parts.push("Set screenShareIntent.action to one of offer_link|none.");
  parts.push("When not offering a share link, set screenShareIntent.action=none, screenShareIntent.confidence=0, screenShareIntent.reason=null.");

  return parts.join("\n\n");
}

export function buildDiscoveryPrompt({
  channelName,
  recentMessages,
  relevantFacts = [],
  emojiHints,
  allowSimpleImagePosts,
  allowComplexImagePosts,
  allowVideoPosts,
  remainingDiscoveryImages = 0,
  remainingDiscoveryVideos = 0,
  discoveryFindings = [],
  maxLinksPerPost = 2,
  requireDiscoveryLink = false,
  maxMediaPromptChars = 900,
  mediaPromptCraftGuidance = null
}) {
  const parts = [];
  const mediaGuidance = String(mediaPromptCraftGuidance || "").trim() || getMediaPromptCraftGuidance(null);

  parts.push(
    `You are posting proactively in #${channelName}. No one directly asked you to respond.`
  );
  parts.push("Recent channel messages:");
  parts.push(formatRecentChat(recentMessages));
  if (relevantFacts?.length) {
    parts.push("Relevant durable memory:");
    parts.push(formatMemoryFacts(relevantFacts, { includeType: true, includeProvenance: false, maxItems: 8 }));
  }

  if (emojiHints?.length) {
    parts.push(`Server emoji options: ${emojiHints.join(", ")}`);
  }

  const remainingImages = Math.max(0, Math.floor(Number(remainingDiscoveryImages) || 0));
  const remainingVideos = Math.max(0, Math.floor(Number(remainingDiscoveryVideos) || 0));
  const simpleImageAvailable = allowSimpleImagePosts && remainingImages > 0;
  const complexImageAvailable = allowComplexImagePosts && remainingImages > 0;
  const videoAvailable = allowVideoPosts && remainingVideos > 0;
  const anyVisualAvailable = simpleImageAvailable || complexImageAvailable || videoAvailable;

  if (anyVisualAvailable) {
    parts.push(
      "You may include visual or meme-friendly ideas in your post text; an image or short video may be generated separately."
    );
    parts.push(
      `Visual generation is available for this post (${remainingImages} image slot(s), ${remainingVideos} video slot(s) left where enabled in the rolling 24h budgets).`
    );
    if (simpleImageAvailable) {
      parts.push("For a simple/quick visual, append: [[IMAGE_PROMPT: your prompt here]]");
    }
    if (complexImageAvailable) {
      parts.push("For a detailed/composition-heavy visual, append: [[COMPLEX_IMAGE_PROMPT: your prompt here]]");
    }
    if (videoAvailable) {
      parts.push("If this post should include motion, append: [[VIDEO_PROMPT: your prompt here]]");
    }
    parts.push(
      `Keep IMAGE_PROMPT, COMPLEX_IMAGE_PROMPT, and VIDEO_PROMPT under ${maxMediaPromptChars} chars.`
    );
    parts.push(
      "Any visual prompt must avoid visible text, letters, numbers, logos, subtitles, captions, UI, or watermarks."
    );
    parts.push(mediaGuidance);
    parts.push(
      "If no media is needed, output only the post text. If media is needed, output at most one media directive."
    );
  } else {
    parts.push("Image/video generation for discovery posts is unavailable right now. Output text only.");
  }

  if (discoveryFindings?.length) {
    parts.push("Fresh external findings (optional inspiration):");
    parts.push(formatDiscoveryFindings(discoveryFindings));
    parts.push(
      `If you include links, use URLs exactly as listed above and keep it to at most ${maxLinksPerPost} links.`
    );
    if (requireDiscoveryLink) {
      parts.push(
        "Include at least one of the listed URLs if possible. If none fit naturally, output exactly [SKIP]."
      );
    }
  }

  parts.push("Task: write one standalone Discord message that feels timely and human.");
  parts.push("Keep it open, honest, non-spammy, and slightly surprising.");
  parts.push("If there is genuinely nothing good to post, output exactly [SKIP].");

  return parts.join("\n\n");
}

export function buildInitiativePrompt({
  botName,
  persona = "",
  initiativeEagerness = 20,
  channelSummaries = [],
  discoveryCandidates = [],
  sourcePerformance = [],
  communityInterestFacts = [],
  relevantFacts = [],
  guidanceFacts = [],
  behavioralFacts = [],
  allowActiveCuriosity = false,
  allowMemorySearch = false,
  allowSelfCuration = false,
  allowImagePosts = false,
  allowVideoPosts = false,
  allowGifPosts = false,
  remainingImages = 0,
  remainingVideos = 0,
  remainingGifs = 0,
  maxMediaPromptChars = 900,
  mediaPromptCraftGuidance = null
}) {
  const parts = [];
  const mediaGuidance = String(mediaPromptCraftGuidance || "").trim() || getMediaPromptCraftGuidance(null);

  parts.push("=== INITIATIVE MODE ===");
  parts.push(`You are ${String(botName || "the bot").trim() || "the bot"}. You have a moment to look around your Discord channels and decide whether you want to post something.`);
  parts.push(`Persona: ${String(persona || "").trim() || "playful slang, open, honest, exploratory"}`);
  parts.push(`Social mode: ${describeInitiativeEagerness(initiativeEagerness)} (initiative eagerness ${Math.max(0, Math.min(100, Number(initiativeEagerness) || 0))}/100)`);

  parts.push("=== CHANNELS ===");
  parts.push(formatInitiativeChannelSummaries(channelSummaries));

  parts.push("=== YOUR FEED ===");
  parts.push(formatInitiativeFeedCandidates(discoveryCandidates));

  parts.push("=== FEED SOURCES ===");
  parts.push(formatInitiativeSourcePerformance(sourcePerformance));

  parts.push("=== WHAT THIS COMMUNITY IS INTO ===");
  parts.push(formatInitiativeInterestFacts(communityInterestFacts));

  if (relevantFacts?.length) {
    parts.push("=== MEMORY ===");
    parts.push(formatMemoryFacts(relevantFacts, { includeType: true, includeProvenance: true, maxItems: 10 }));
  }

  if (guidanceFacts?.length) {
    parts.push("=== BEHAVIOR GUIDANCE ===");
    parts.push(formatBehaviorMemoryFacts(guidanceFacts, 8));
  }

  if (behavioralFacts?.length) {
    parts.push("=== RELEVANT BEHAVIORAL MEMORY ===");
    parts.push(formatBehaviorMemoryFacts(behavioralFacts, 6));
  }

  parts.push("=== CAPABILITIES ===");
  if (allowActiveCuriosity) {
    parts.push("You can use web_search to look something up, or browser_browse to actually visit a site, inspect how a page looks, capture browser screenshots for visual inspection, or move through it interactively — if you're curious about something or want to check if a feed item is actually worth sharing.");
  } else {
    parts.push("web_search and browser_browse are unavailable right now. Reason from the feed, memory, and channel context unless another tool is listed below.");
  }
  if (allowMemorySearch) {
    parts.push("You can use memory_search to recall durable community context when it helps you read the room.");
  } else {
    parts.push("memory_search is unavailable right now.");
  }
  if (allowSelfCuration) {
    parts.push("You can manage your own feed:");
    parts.push("- discovery_source_add: subscribe to a new subreddit, RSS feed, YouTube channel, or X handle");
    parts.push("- discovery_source_remove: drop a source that is not working");
    parts.push("- discovery_source_list: see your current subscriptions");
  } else {
    parts.push("Feed self-curation is disabled right now. Do not attempt to change feed subscriptions.");
  }

  const boundedImages = Math.max(0, Math.floor(Number(remainingImages) || 0));
  const boundedVideos = Math.max(0, Math.floor(Number(remainingVideos) || 0));
  const boundedGifs = Math.max(0, Math.floor(Number(remainingGifs) || 0));
  const mediaOptions = [
    allowImagePosts && boundedImages > 0 ? `image (${boundedImages} left)` : "",
    allowVideoPosts && boundedVideos > 0 ? `video (${boundedVideos} left)` : "",
    allowGifPosts && boundedGifs > 0 ? `gif (${boundedGifs} left)` : ""
  ].filter(Boolean);
  if (mediaOptions.length) {
    parts.push("You can request media (image, video, GIF) if the moment calls for it.");
    parts.push(`Media is available if it genuinely fits the moment: ${mediaOptions.join(", ")}.`);
    parts.push(`If you request media, keep mediaPrompt under ${maxMediaPromptChars} chars.`);
    parts.push("Media prompt hard constraints: no visible text, letters, numbers, logos, captions, subtitles, UI, or watermarks.");
    parts.push(mediaGuidance);
  } else {
    parts.push("Media generation is unavailable for this initiative cycle. Use mediaDirective=\"none\".");
  }

  parts.push("=== TASK ===");
  parts.push("Look around. If something catches your eye — a conversation you can add to, a feed item worth sharing, a topic you want to explore — pick a channel and post. Otherwise, [SKIP] and check back later.");
  parts.push("That can mean reacting to a live conversation, sharing something from your feed, or following your own curiosity.");
  parts.push("If you notice a source consistently is not producing anything useful, or the community's interests point toward sources you do not have yet, you can adjust your feed.");
  parts.push("Choose the channel that best fits what you want to say. Do not pick a channel at random.");
  parts.push("Check when you last posted in each channel. If you posted recently, consider whether another message so soon would feel spammy or natural.");
  parts.push("Use exact channelId values from the CHANNELS section.");
  parts.push("Keep the text natural, non-spammy, and like a real community member.");
  parts.push("If you mention a feed item or web result, include the link only if it feels natural. Never force a link.");
  parts.push("Return strict JSON only with shape: {\"skip\":boolean,\"channelId\":string|null,\"text\":string,\"mediaDirective\":\"none\"|\"image\"|\"video\"|\"gif\",\"mediaPrompt\":string|null,\"reason\":string}.");
  parts.push("If skip=true, set channelId to null, text to an empty string, mediaDirective to \"none\", and mediaPrompt to null.");
  parts.push("If mediaDirective is \"none\", set mediaPrompt to null.");

  return parts.join("\n\n");
}

export function buildAutomationPrompt({
  instruction,
  channelName = "channel",
  recentMessages = [],
  userFacts = [],
  relevantFacts = [],
  guidanceFacts = [],
  behavioralFacts = [],
  memoryLookup = null,
  allowMemoryLookupDirective = false,
  allowSimpleImagePosts = false,
  allowComplexImagePosts = false,
  allowVideoPosts = false,
  allowGifs = false,
  remainingImages = 0,
  remainingVideos = 0,
  remainingGifs = 0,
  maxMediaPromptChars = 900,
  mediaPromptCraftGuidance = null
}) {
  const parts = [];
  const mediaGuidance = String(mediaPromptCraftGuidance || "").trim() || getMediaPromptCraftGuidance(null);
  const taskInstruction = String(instruction || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 360);

  parts.push("=== AUTOMATION TASK ===");
  parts.push("You are executing a scheduled automation task.");
  parts.push(`Target channel: #${String(channelName || "channel").trim() || "channel"}.`);
  parts.push(`Task instruction: ${taskInstruction || "(missing instruction)"}`);
  parts.push("Keep the output in normal persona voice. No robotic framing.");
  parts.push("=== RECENT MESSAGES ===");
  parts.push(formatRecentChat(recentMessages));
  if (userFacts?.length) {
    parts.push("=== USER FACTS ===");
    parts.push(formatMemoryFacts(userFacts, { includeType: false, includeProvenance: true, maxItems: 8 }));
  }
  if (relevantFacts?.length) {
    parts.push("=== DURABLE MEMORY ===");
    parts.push(formatMemoryFacts(relevantFacts, { includeType: true, includeProvenance: true, maxItems: 10 }));
  }
  if (guidanceFacts?.length) {
    parts.push("=== BEHAVIOR GUIDANCE ===");
    parts.push(formatBehaviorMemoryFacts(guidanceFacts, 8));
  }
  if (behavioralFacts?.length) {
    parts.push("=== RELEVANT BEHAVIORAL MEMORY ===");
    parts.push(formatBehaviorMemoryFacts(behavioralFacts, 6));
  }
  if (memoryLookup?.requested) {
    if (memoryLookup.error) {
      parts.push(`Memory lookup failed: ${memoryLookup.error}`);
      parts.push("Continue using currently available context.");
    } else if (!memoryLookup.results?.length) {
      parts.push(`Memory lookup for "${memoryLookup.query || taskInstruction}" found no durable matches.`);
    } else {
      const isFullMemory = memoryLookup.query === "__ALL__";
      if (isFullMemory) {
        parts.push("Stored memory dump (capped view of stored facts):");
      } else {
        parts.push(`Memory lookup results for "${memoryLookup.query || taskInstruction}":`);
      }
      parts.push(formatMemoryLookupResults(memoryLookup.results));
      if (!isFullMemory) {
        parts.push("If useful, reference these facts naturally in output/media.");
      }
    }
  }
  parts.push("When the task references a person (like 'me'), use durable memory facts if they are relevant.");

  const imageSlots = Math.max(0, Math.floor(Number(remainingImages) || 0));
  const videoSlots = Math.max(0, Math.floor(Number(remainingVideos) || 0));
  const gifSlots = Math.max(0, Math.floor(Number(remainingGifs) || 0));

  parts.push("=== MEDIA GENERATION ===");

  if ((allowSimpleImagePosts || allowComplexImagePosts || allowVideoPosts) && (imageSlots > 0 || videoSlots > 0)) {
    parts.push("Media generation is available for this automation run.");
    if (allowSimpleImagePosts && imageSlots > 0) {
      parts.push("For simple image output, set media to {\"type\":\"image_simple\",\"prompt\":\"...\"}.");
    }
    if (allowComplexImagePosts && imageSlots > 0) {
      parts.push("For detailed image output, set media to {\"type\":\"image_complex\",\"prompt\":\"...\"}.");
    }
    if (allowVideoPosts && videoSlots > 0) {
      parts.push("For short generated video, set media to {\"type\":\"video\",\"prompt\":\"...\"}.");
    }
    parts.push(`Keep image/video prompts under ${maxMediaPromptChars} chars.`);
    parts.push(mediaGuidance);
  } else {
    parts.push("Generated image/video is unavailable this run. Set media to null.");
  }

  if (allowGifs && gifSlots > 0) {
    parts.push("GIF lookup is available this run. Use media {\"type\":\"gif\",\"prompt\":\"short query\"} when it helps.");
  }

  parts.push("=== OUTPUT FORMAT ===");
  parts.push("Return strict JSON only.");
  parts.push("JSON format:");
  parts.push(REPLY_JSON_SCHEMA);
  parts.push(
    "Set webSearchQuery, browserBrowseQuery, imageLookupQuery, and openArticleRef to null when unused."
  );
  parts.push("Set soundboardRefs to [] and leaveVoiceChannel to false.");
  if (allowMemoryLookupDirective) {
    if (!memoryLookup?.enabled) {
      parts.push("Durable memory lookup is unavailable for this run. Set memoryLookupQuery to null.");
    } else {
      parts.push("Durable memory lookup is available.");
      parts.push("If memory context is insufficient for the task, set memoryLookupQuery to a concise query.");
      parts.push("If not needed, set memoryLookupQuery to null.");
    }
  } else {
    parts.push("Set memoryLookupQuery to null.");
  }
  parts.push("Set automationAction.operation=none.");
  parts.push("Set screenShareIntent.action=none, screenShareIntent.confidence=0, screenShareIntent.reason=null.");
  parts.push("Use [SKIP] only when sending nothing is clearly best.");

  return parts.join("\n\n");
}
