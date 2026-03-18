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
  formatMemoryFacts,
  formatImageLookupCandidates
} from "./promptFormatters.ts";
import {
  buildActiveCuriosityCapabilityLine
} from "./toolPolicy.ts";

function buildWebSearchStateLine(webSearch: unknown): string {
  const ws = webSearch as Record<string, unknown> | null;
  if (ws?.optedOutByUser) return "Web search: unavailable (user opted out this turn).";
  if (!ws?.enabled) return "Web search: unavailable (disabled in settings).";
  if (!ws?.configured) return "Web search: unavailable (no search provider configured).";
  if (ws?.blockedByBudget || !(ws?.budget as Record<string, unknown>)?.canSearch)
    return "Web search: unavailable (hourly budget exhausted).";
  return "Web search: available.";
}

function buildBrowserStateLine(browserBrowse: unknown): string {
  const bb = browserBrowse as Record<string, unknown> | null;
  if (!bb?.enabled) return "Browser: unavailable (disabled in settings).";
  if (!bb?.configured) return "Browser: unavailable (runtime not configured).";
  if (bb?.blockedByBudget || !(bb?.budget as Record<string, unknown>)?.canBrowse)
    return "Browser: unavailable (hourly budget exhausted).";
  return "Browser: available.";
}

function buildMemoryLookupStateLine(memoryLookup: unknown): string {
  const ml = memoryLookup as Record<string, unknown> | null;
  if (!ml?.enabled) return "Memory lookup: unavailable this turn.";
  return "Memory lookup: available.";
}

function buildImageLookupStateLine(imageLookup: unknown): string {
  const il = imageLookup as Record<string, unknown> | null;
  if (!il?.enabled) return "Image lookup: unavailable this turn.";
  const candidates = Array.isArray((il as Record<string, unknown>)?.candidates)
    ? ((il as Record<string, unknown>).candidates as unknown[])
    : [];
  if (!candidates.length) return "Image lookup: available, but no recent image references found.";
  return `Image lookup: available (${candidates.length} recent image reference(s)).`;
}

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
    return "Balanced. Surface an ambient text thought when there is a natural fit, otherwise stay quiet.";
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
  videoInputs = [],
  recentMessages,
  userFacts: _userFacts,
  relevantFacts: _relevantFacts,
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
  ambientReplyEagerness = 35,
  responseWindowEagerness = 55,
  recentReplyWindowActive = false,
  textAttentionMode = "AMBIENT",
  textAttentionReason = "cold_ambient",
  reactivity = 20,
  addressing = null,
  webSearch = null,
  browserBrowse = null,
  recentConversationHistory = [],
  memoryLookup = null,
  imageLookup = null,
  allowMemoryDirective: _allowMemoryDirective = false,
  allowAutomationDirective = false,
  automationTimeZoneLabel = "",
  voiceMode = null,
  screenShare = null,
  channelMode = "other_channel" as "reply_channel" | "discovery_channel" | "other_channel",
  maxMediaPromptChars = 900,
  mediaPromptCraftGuidance = null
}) {
  const parts = [];
  const normalizedChannelMode = channelMode === "reply_channel"
    ? "reply_channel"
    : channelMode === "discovery_channel"
      ? "discovery_channel"
      : "other_channel";
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
  if (Array.isArray(videoInputs) && videoInputs.length) {
    parts.push(
      [
        "Current message video attachments:",
        ...videoInputs.map((video, index) => {
          const ref = String(video?.videoRef || `VID ${index + 1}`).trim();
          const name = String(video?.filename || "(unnamed)").trim() || "(unnamed)";
          const type = String(video?.contentType || "unknown").trim() || "unknown";
          const url = String(video?.url || "").trim();
          return url
            ? `- ${ref}: ${name} (${type}) — ${url}`
            : `- ${ref}: ${name} (${type})`;
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
  const normalizedTextAttentionMode = String(textAttentionMode || "").trim().toUpperCase() === "ACTIVE"
    ? "ACTIVE"
    : "AMBIENT";
  const normalizedTextAttentionReason = String(textAttentionReason || "").trim().toLowerCase() || "cold_ambient";
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
  const ambientEagerness = Math.max(0, Math.min(100, Number(ambientReplyEagerness) || 0));
  const followupEagerness = Math.max(0, Math.min(100, Number(responseWindowEagerness) || 0));
  parts.push(`Current text continuity state: ${normalizedTextAttentionMode}.`);
  if (normalizedTextAttentionMode === "ACTIVE") {
    if (normalizedTextAttentionReason === "direct_address") {
      parts.push("You were directly pulled into this thread, so treat it as an active conversation unless the best answer is still [SKIP].");
    } else {
      parts.push("This looks like an active follow-up thread, not a cold ambient chime-in.");
    }
  } else {
    parts.push("This is an ambient text moment. You can still chime in, but only if you genuinely fit the room.");
  }
  parts.push("Use continuity as context, not as blanket permission. Activity elsewhere, including VC, does not by itself make this text thread yours.");
  parts.push(`Your text ambient-reply eagerness is ${ambientEagerness}/100.`);
  parts.push(`Your response-window eagerness is ${followupEagerness}/100.`);

  if (ambientEagerness <= 15) {
    parts.push("You are very quiet in ambient text. Only speak when someone is clearly pulling you in or you have something genuinely worth adding.");
  } else if (ambientEagerness <= 35) {
    parts.push("You tend to observe more than talk. Only surface an ambient text reply when you genuinely have something to say or someone is clearly engaging with you.");
  } else if (ambientEagerness <= 55) {
    parts.push("Be selective about when you jump in. If you do not have something genuinely useful, interesting, or funny to add, output [SKIP].");
  } else if (ambientEagerness <= 75) {
    parts.push("You are fairly engaged. Contribute when you have something that fits the flow, but still pick your ambient moments.");
  } else if (ambientEagerness <= 90) {
    parts.push("You are an active participant. Jump in when you have something — even lighter contributions are fine if they fit naturally.");
  } else {
    parts.push("You are very social and love riffing with people. Jump in freely when you have something, even casual reactions and banter.");
  }

  if (recentReplyWindowActive) {
    if (followupEagerness <= 15) {
      parts.push("You replied recently, but your follow-up window is tight. Do not assume the thread still belongs to you unless the new message clearly re-engages you.");
    } else if (followupEagerness <= 45) {
      parts.push("You replied recently. Treat that as a light continuity signal, not an obligation to keep talking.");
    } else if (followupEagerness <= 75) {
      parts.push("You replied recently, so this may still be an active back-and-forth. Continue naturally when the next turn plausibly connects to you.");
    } else {
      parts.push("You replied recently and your response window is sticky. Treat plausible follow-ups as part of the same thread unless the room clearly moved on.");
    }
  }

  // Directed-at-someone-else signal (scaled by ambient initiative)
  const directedAtSomeoneElse = Boolean(addressing?.mentionsOtherUsers) || Boolean(addressing?.repliesToOtherUser);
  if (directedAtSomeoneElse) {
    if (ambientEagerness <= 75) {
      parts.push("This message is directed at another user (via @mention or reply). It is not for you. Output [SKIP] unless the message also clearly invites you to participate.");
    } else {
      parts.push("This message is directed at another user (via @mention or reply). Strongly prefer [SKIP] — only jump in if you have something genuinely worth adding to their exchange.");
    }
  }

  // Conversational awareness (always present, strength scales with ambient initiative)
  if (ambientEagerness <= 60) {
    parts.push("If people are talking to each other (using names, replying back and forth, making plans together), output [SKIP]. Do not insert yourself into someone else's conversation.");
  } else {
    parts.push("If people are clearly having a private or directed exchange with each other, prefer [SKIP] unless you can genuinely add to the conversation.");
  }

  // Channel mode
  if (normalizedChannelMode === "reply_channel") {
    parts.push("This channel is in your unsolicited reply pool — you can vibe here. Short riffs and acknowledgements are fine when they fit naturally.");
    parts.push("If your reply would derail, interrupt, or just repeat what was said, output [SKIP].");
  } else if (normalizedChannelMode === "discovery_channel") {
    parts.push("This channel is in your discovery pool — you can post freely here, but this is not your vibe channel. Only jump into existing conversations if your message is worth the interruption.");
  } else {
    parts.push("This channel is outside your ambient text and discovery pools. Only jump in if your message is worth the interruption.");
  }

  const normalizedReactivity = Math.max(0, Math.min(100, Number(reactivity) || 0));
  if (normalizedReactivity <= 25) {
    parts.push("React sparingly — only when it genuinely adds something.");
  } else if (normalizedReactivity >= 75) {
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
      parts.push("That VC activity is continuity context, not blanket permission to jump into unrelated text conversations.");
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
    parts.push("Screen watch: available.");
  } else if (screenShareSupported) {
    parts.push(`Screen watch: unavailable (${screenShareReason}).`);
  } else {
    parts.push("Screen watch: not available in this runtime.");
  }

  if (allowAutomationDirective) {
    const tzLabel = String(automationTimeZoneLabel || "").trim() || "local server time";
    parts.push(`Automations: available. Scheduler timezone: ${tzLabel}.`);
  }

  parts.push(buildWebSearchStateLine(webSearch));
  parts.push(buildBrowserStateLine(browserBrowse));

  parts.push(buildMemoryLookupStateLine(memoryLookup));
  parts.push(buildImageLookupStateLine(imageLookup));
  if (imageLookup?.enabled && imageLookup?.candidates?.length) {
    parts.push("Recent image references from message history:");
    parts.push(formatImageLookupCandidates(imageLookup.candidates));
  }

  const remainingImages = Math.max(0, Math.floor(Number(remainingReplyImages) || 0));
  const remainingVideos = Math.max(0, Math.floor(Number(remainingReplyVideos) || 0));
  const simpleImageAvailable = allowReplySimpleImages && remainingImages > 0;
  const complexImageAvailable = allowReplyComplexImages && remainingImages > 0;
  const videoGenerationAvailable = allowReplyVideos && remainingVideos > 0;
  const anyVisualGeneration = simpleImageAvailable || complexImageAvailable || videoGenerationAvailable;
  const remainingGifs = Math.max(0, Math.floor(Number(remainingReplyGifs) || 0));

  if (anyVisualGeneration) {
    const mediaSlots: string[] = [];
    if (simpleImageAvailable || complexImageAvailable) mediaSlots.push(`${remainingImages} image slot(s)`);
    if (videoGenerationAvailable) mediaSlots.push(`${remainingVideos} video slot(s)`);
    parts.push(`Media generation: available (${mediaSlots.join(", ")} remaining).`);
  } else {
    parts.push("Media generation: unavailable this turn. Set media to null.");
  }

  if (allowReplyGifs && remainingGifs > 0) {
    parts.push(`GIF lookup: available (${remainingGifs} remaining).`);
  } else if (gifRepliesEnabled) {
    const gifReason = !gifsConfigured ? "missing GIPHY configuration" : "24h budget exhausted";
    parts.push(`GIF lookup: unavailable (${gifReason}).`);
  }

  return parts.join("\n\n");
}

export function buildInitiativePrompt({
  botName,
  persona = "",
  initiativeEagerness = 20,
  channelSummaries = [],
  pendingThought = null,
  discoveryCandidates = [],
  sourcePerformance = [],
  communityInterestFacts = [],
  relevantFacts = [],
  guidanceFacts = [],
  behavioralFacts = [],
  allowActiveCuriosity = false,
  allowWebSearch = false,
  allowWebScrape = false,
  allowBrowserBrowse = false,
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

  parts.push("=== AMBIENT TEXT MODE ===");
  parts.push(`You are ${String(botName || "the bot").trim() || "the bot"}. You have a moment to look around your Discord channels and decide whether you want to surface an ambient text thought.`);
  parts.push("This ambient action is always a normal text-channel post into one of the eligible text channels below.");
  parts.push("Some recent lines may be marked [vc], meaning they are transcripts from voice chat linked to that text channel. Use them as room context, but the action you choose here is still a text post in the linked text channel.");
  parts.push(`Persona: ${String(persona || "").trim() || "playful slang, open, honest, exploratory"}`);
  parts.push(`Social mode: ${describeInitiativeEagerness(initiativeEagerness)} (ambient text eagerness ${Math.max(0, Math.min(100, Number(initiativeEagerness) || 0))}/100)`);

  if (pendingThought && typeof pendingThought === "object" && String(pendingThought.currentText || "").trim()) {
    parts.push("=== YOUR CURRENT THOUGHT ===");
    parts.push(`Your current thought: "${String(pendingThought.currentText || "").trim()}"`);
    parts.push(`Thought status: ${pendingThought.status === "reconsider" ? "reconsider" : "queued"}.`);
    parts.push(`Thought revision: ${Math.max(1, Number(pendingThought.revision || 1))}.`);
    parts.push(`Thought age ms: ${Math.max(0, Math.round(Number(pendingThought.ageMs || 0)))}.`);
    if (String(pendingThought.channelName || "").trim()) {
      parts.push(`Original target channel: #${String(pendingThought.channelName || "").trim()}.`);
    }
    if (String(pendingThought.lastDecisionReason || "").trim()) {
      parts.push(`Why you kept it: ${String(pendingThought.lastDecisionReason || "").trim()}`);
    }
    const heldMediaDirective = String(pendingThought.mediaDirective || "").trim().toLowerCase();
    if (heldMediaDirective === "image" || heldMediaDirective === "video" || heldMediaDirective === "gif") {
      parts.push(`Held media idea: ${heldMediaDirective}.`);
      if (String(pendingThought.mediaPrompt || "").trim()) {
        parts.push(`Held media prompt: ${String(pendingThought.mediaPrompt || "").trim()}`);
      }
    }
    if (pendingThought.status === "reconsider") {
      parts.push("Something changed since you formed that thought. Refresh it instead of repeating yourself.");
    }
  }

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
  if (allowActiveCuriosity && (allowWebSearch || allowWebScrape || allowBrowserBrowse)) {
    parts.push(buildActiveCuriosityCapabilityLine({
      includeWebSearch: allowWebSearch,
      includeWebScrape: allowWebScrape,
      includeBrowserBrowse: allowBrowserBrowse
    }));
  } else {
    parts.push("web_search, web_scrape, and browser_browse are unavailable right now. Reason from the feed, memory, and channel context unless another tool is listed below.");
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
    parts.push("Media generation is unavailable for this ambient text cycle. Use mediaDirective=\"none\".");
  }

  parts.push("=== TASK ===");
  parts.push(
    pendingThought && typeof pendingThought === "object" && String(pendingThought.currentText || "").trim()
      ? "Look around again and answer the question: what are you thinking right now? You can post the thought now, keep holding a refined version for later, or drop it."
      : "Look around. If something catches your eye — a conversation you can add to, a feed item worth sharing, a topic you want to explore — pick a channel and post. Otherwise, stay ambient."
  );
  parts.push("That can mean reacting to a live conversation, sharing something from your feed, or following your own curiosity.");
  parts.push("If you notice someone said something and you never responded — especially if you were mid-conversation with them — follow up. Don't leave people hanging. Set replyToMessageId to the message you're replying to so it threads properly.");
  parts.push("If you notice a source consistently is not producing anything useful, or the community's interests point toward sources you do not have yet, you can adjust your feed.");
  parts.push("Choose the channel that best fits what you want to say. Do not pick a channel at random.");
  parts.push("Check when you last posted in each channel. If you posted recently, consider whether another message so soon would feel spammy or natural.");
  parts.push("Use exact channelId values from the CHANNELS section.");
  parts.push("Keep the text natural, non-spammy, and like a real community member.");
  parts.push("If you mention a feed item or web result, include the link only if it feels natural. Never force a link.");
  parts.push("Return strict JSON only with shape: {\"action\":\"post_now\"|\"hold\"|\"drop\",\"channelId\":string|null,\"replyToMessageId\":string|null,\"text\":string,\"mediaDirective\":\"none\"|\"image\"|\"video\"|\"gif\",\"mediaPrompt\":string|null,\"reason\":string}.");
  parts.push("If you are following up on a specific message, set replyToMessageId to that message's ID (from the recent messages list). Otherwise set it to null.");
  parts.push("If action is \"post_now\", channelId and text must contain the post you want to send now.");
  parts.push("If action is \"hold\", channelId and text must contain the thought you want to keep holding for later. It can be refined or replaced.");
  parts.push("If action is \"drop\", set channelId to null, text to an empty string, mediaDirective to \"none\", and mediaPrompt to null.");
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
  parts.push("When the task references a person (like 'me'), use durable memory facts if they are relevant.");
  if (!memoryLookup?.enabled) {
    parts.push("Durable memory lookup capability is unavailable for this run.");
  } else {
    parts.push("Durable memory lookup is available via the memory_search tool.");
    parts.push("If current memory context is insufficient for the task, call memory_search with a concise query.");
  }

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
  parts.push("Use tool calls for durable memory search and other supported capabilities.");
  parts.push("Do not encode tool requests inside the JSON reply body.");
  parts.push("Set automationAction.operation=none.");
  parts.push("Set screenWatchIntent.action=none, screenWatchIntent.confidence=0, screenWatchIntent.reason=null.");
  parts.push("Use [SKIP] only when sending nothing is clearly best.");

  return parts.join("\n\n");
}

function formatCodeTaskDuration(durationMs: number) {
  const boundedMs = Math.max(0, Math.floor(Number(durationMs) || 0));
  const totalSeconds = Math.floor(boundedMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

export function buildCodeTaskResultPrompt({
  mode = "completion",
  sessionId,
  role = "implementation",
  status = "completed",
  durationMs = 0,
  costUsd = 0,
  resultText = "",
  filesTouched = [],
  triggerMessageId = null,
  recentEvents = []
}: {
  mode?: "completion" | "progress" | "cancelled";
  sessionId: string;
  role?: string;
  status?: string;
  durationMs?: number;
  costUsd?: number;
  resultText?: string;
  filesTouched?: string[];
  triggerMessageId?: string | null;
  recentEvents?: Array<{ summary?: string | null }>;
}) {
  const normalizedMode = mode === "progress" ? "progress" : mode === "cancelled" ? "cancelled" : "completion";
  const lines: string[] = [];

  if (normalizedMode === "progress") {
    lines.push("[CODE TASK PROGRESS]");
  } else if (normalizedMode === "cancelled") {
    lines.push("[CODE TASK CANCELLED]");
  } else {
    lines.push("[CODE TASK COMPLETED]");
  }

  lines.push(`Session: ${String(sessionId || "").trim() || "unknown"}`);
  lines.push(`Role: ${String(role || "implementation").trim() || "implementation"}`);
  lines.push(`Status: ${String(status || "").trim() || "unknown"}`);
  lines.push(`Duration: ${formatCodeTaskDuration(durationMs)}`);
  if (Number(costUsd || 0) > 0) {
    lines.push(`Cost: $${Number(costUsd || 0).toFixed(4)}`);
  }
  if (triggerMessageId) {
    lines.push(`Requested via message: ${String(triggerMessageId).trim()}`);
  }

  const normalizedFilesTouched = Array.isArray(filesTouched)
    ? filesTouched.map((value) => String(value || "").trim()).filter(Boolean)
    : [];
  if (normalizedFilesTouched.length > 0) {
    lines.push(`Files touched: ${normalizedFilesTouched.join(", ")}`);
  }

  if (normalizedMode === "progress") {
    const items = Array.isArray(recentEvents)
      ? recentEvents
        .map((event) => String(event?.summary || "").trim())
        .filter(Boolean)
        .slice(-6)
      : [];
    if (items.length > 0) {
      lines.push("Recent activity:");
      for (const item of items) {
        lines.push(`- ${item}`);
      }
    }
    lines.push("");
    lines.push("This is a progress update for an active async code task.");
    lines.push("Compose a brief natural update for the requester, or output [SKIP] if unnecessary.");
    return lines.join("\n");
  }

  const normalizedResultText = String(resultText || "").trim();
  if (normalizedResultText) {
    lines.push("");
    lines.push("Result:");
    lines.push(normalizedResultText);
  }
  lines.push("");
  lines.push("This is an async code task completion event, not a chat message.");
  lines.push("Compose a natural follow-up for the user who requested this task.");
  return lines.join("\n");
}
