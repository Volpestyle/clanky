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
} from "./promptCore.ts";

function stripEmojiForPrompt(text) {
  let value = String(text || "");
  value = value.replace(/<a?:[a-zA-Z0-9_~]+:\d+>/g, "");
  value = value.replace(/:[a-zA-Z0-9_+-]+:/g, "");
  value = value.replace(/[\p{Extended_Pictographic}\uFE0F]/gu, "");
  return value.replace(/\s+/g, " ").trim();
}

function formatRecentChat(messages) {
  if (!messages?.length) return "(no recent messages available)";

  return messages
    .slice()
    .reverse()
    .map((msg) => {
      const isBot = msg.is_bot === 1 || msg.is_bot === true || msg.is_bot === "1";
      const rawText = String(msg.content || "");
      const normalized = isBot ? stripEmojiForPrompt(rawText) : rawText;
      const text = normalized.replace(/\s+/g, " ").trim();
      return `- ${msg.author_name}: ${text || "(empty)"}`;
    })
    .join("\n");
}

function formatEmojiChoices(emojiOptions) {
  if (!emojiOptions?.length) return "(no emoji options available)";
  return emojiOptions.map((emoji) => `- ${emoji}`).join("\n");
}

function formatDiscoveryFindings(findings) {
  if (!findings?.length) return "(no fresh links found)";

  return findings
    .map((item) => {
      const source = item.sourceLabel || item.source || "web";
      const title = String(item.title || "untitled").trim();
      const url = String(item.url || "").trim();
      const excerpt = String(item.excerpt || "").trim();
      const excerptLine = excerpt ? ` | ${excerpt}` : "";
      return `- [${source}] ${title} -> ${url}${excerptLine}`;
    })
    .join("\n");
}

function formatWebSearchFindings(webSearch) {
  if (!webSearch?.results?.length) return "(no web results available)";

  return webSearch.results
    .map((item, index) => {
      const sourceId = String(index + 1);
      const title = String(item.title || "untitled").trim();
      const url = String(item.url || "").trim();
      const domain = String(item.domain || "").trim();
      const snippet = String(item.snippet || "").trim();
      const pageSummary = String(item.pageSummary || "").trim();
      const pageLine = pageSummary ? ` | page: ${pageSummary}` : "";
      const snippetLine = snippet ? ` | snippet: ${snippet}` : "";
      const domainLabel = domain ? ` (${domain})` : "";
      return `- [${sourceId}] ${title}${domainLabel} -> ${url}${snippetLine}${pageLine}`;
    })
    .join("\n");
}

function formatRecentLookupContext(recentWebLookups) {
  const rows = Array.isArray(recentWebLookups) ? recentWebLookups : [];
  if (!rows.length) return "(no recent lookup cache)";

  return rows
    .slice(0, 6)
    .map((item, index) => {
      const query = String(item?.query || "").trim() || "unknown query";
      const provider = String(item?.provider || "").trim();
      const ageMinutes = Number(item?.ageMinutes);
      const ageLabel = Number.isFinite(ageMinutes)
        ? ageMinutes < 60
          ? `${Math.max(0, Math.round(ageMinutes))}m ago`
          : `${Math.max(1, Math.round(ageMinutes / 60))}h ago`
        : "recent";
      const sourceHints = (Array.isArray(item?.results) ? item.results : [])
        .slice(0, 3)
        .map((row) => String(row?.domain || row?.url || "").trim())
        .filter(Boolean);
      const sourceLabel = sourceHints.length
        ? ` | sources: ${sourceHints.join(", ")}`
        : "";
      const providerLabel = provider ? ` | provider: ${provider}` : "";
      return `- [R${index + 1}] "${query}" (${ageLabel})${providerLabel}${sourceLabel}`;
    })
    .join("\n");
}

function formatOpenArticleCandidates(candidates) {
  const rows = Array.isArray(candidates) ? candidates : [];
  if (!rows.length) return "(no cached lookup articles available)";

  return rows
    .slice(0, 12)
    .map((item) => {
      const ref = String(item?.ref || "").trim() || "first";
      const title = String(item?.title || "untitled").trim() || "untitled";
      const url = String(item?.url || "").trim();
      const domain = String(item?.domain || "").trim();
      const query = String(item?.query || "").trim();
      const domainLabel = domain ? ` (${domain})` : "";
      const queryLabel = query ? ` | from query: "${query}"` : "";
      return `- [${ref}] ${title}${domainLabel} -> ${url}${queryLabel}`;
    })
    .join("\n");
}

function formatVideoFindings(videoContext) {
  if (!videoContext?.videos?.length) return "(no video context available)";

  return videoContext.videos
    .map((item, index) => {
      const sourceId = `V${index + 1}`;
      const provider = String(item.provider || item.kind || "video").trim();
      const title = String(item.title || "untitled video").trim();
      const channel = String(item.channel || "unknown channel").trim();
      const url = String(item.url || "").trim();
      const description = String(item.description || "").trim();
      const transcript = String(item.transcript || "").trim();
      const transcriptSource = String(item.transcriptSource || "").trim();
      const keyframeCount = Number(item.keyframeCount);
      const publishedAt = String(item.publishedAt || "").trim();
      const durationSeconds = Number(item.durationSeconds);
      const durationLabel = Number.isFinite(durationSeconds) && durationSeconds > 0
        ? ` | duration: ${durationSeconds}s`
        : "";
      const publishedLabel = publishedAt ? ` | published: ${publishedAt}` : "";
      const summaryLabel = description ? ` | summary: ${description}` : "";
      const transcriptSourceLabel = transcriptSource ? ` | transcript_source: ${transcriptSource}` : "";
      const transcriptLabel = transcript ? ` | transcript: ${transcript}` : "";
      const keyframeLabel = Number.isFinite(keyframeCount) && keyframeCount > 0 ? ` | keyframes: ${keyframeCount}` : "";
      return `- [${sourceId}] (${provider}) ${title} by ${channel} -> ${url}${durationLabel}${publishedLabel}${summaryLabel}${transcriptSourceLabel}${transcriptLabel}${keyframeLabel}`;
    })
    .join("\n");
}

function renderPromptMemoryFact(row, { includeType = true, includeProvenance = true } = {}) {
  const fact = String(row?.fact || "").replace(/\s+/g, " ").trim();
  if (!fact) return "";

  const type = String(row?.fact_type || "").trim().toLowerCase();
  const label = includeType && type && type !== "other" ? `${type}: ` : "";
  if (!includeProvenance) return `${label}${fact}`;

  const evidence = String(row?.evidence_text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90);
  const source = String(row?.source_message_id || "").trim().slice(0, 28);
  const createdAt = String(row?.created_at || "").trim().slice(0, 10);
  const confidence = Number(row?.confidence);
  const confidenceLabel = Number.isFinite(confidence) ? ` | conf:${confidence.toFixed(2)}` : "";
  const evidenceLabel = evidence ? ` | evidence: "${evidence}"` : "";
  const sourceLabel = source ? ` | source:${source}` : "";
  const dateLabel = createdAt ? ` | date:${createdAt}` : "";

  return `${label}${fact}${evidenceLabel}${sourceLabel}${dateLabel}${confidenceLabel}`;
}

function formatMemoryFacts(facts, { includeType = true, includeProvenance = true, maxItems = 12 } = {}) {
  if (!facts?.length) return "(no durable memory hits)";

  return facts
    .slice(0, Math.max(1, Number(maxItems) || 12))
    .map((row) => {
      const rendered = renderPromptMemoryFact(row, { includeType, includeProvenance });
      return rendered ? `- ${rendered}` : "";
    })
    .filter(Boolean)
    .join("\n");
}

function formatMemoryLookupResults(results) {
  if (!results?.length) return "(no matching durable memory found)";
  return results
    .map((row, index) => {
      const rendered = renderPromptMemoryFact(row, { includeType: true, includeProvenance: true });
      return rendered ? `- [M${index + 1}] ${rendered}` : "";
    })
    .filter(Boolean)
    .join("\n");
}

function formatImageLookupCandidates(candidates) {
  if (!candidates?.length) return "(no recent image references found)";
  return candidates
    .slice(0, 12)
    .map((row, index) => {
      const filename = String(row?.filename || "(unnamed)").trim();
      const author = String(row?.authorName || "unknown").trim();
      const when = String(row?.createdAt || "").trim();
      const context = String(row?.context || "").trim();
      const whenLabel = when ? ` at ${when}` : "";
      const contextLabel = context ? ` | context: ${context}` : "";
      return `- [I${index + 1}] ${filename} by ${author}${whenLabel}${contextLabel}`;
    })
    .join("\n");
}

function formatImageLookupResults(results) {
  if (!results?.length) return "(no matching history images found)";
  return results
    .map((row, index) => {
      const filename = String(row?.filename || "(unnamed)").trim();
      const author = String(row?.authorName || "unknown").trim();
      const when = String(row?.createdAt || "").trim();
      const reason = String(row?.matchReason || "").trim();
      const whenLabel = when ? ` at ${when}` : "";
      const reasonLabel = reason ? ` | match: ${reason}` : "";
      return `- [I${index + 1}] ${filename} by ${author}${whenLabel}${reasonLabel}`;
    })
    .join("\n");
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

export function buildSystemPrompt(settings) {
  const memoryEnabled = Boolean(settings?.memory?.enabled);
  const textGuidance = getPromptTextGuidance(settings, DEFAULT_PROMPT_TEXT_GUIDANCE);

  return [
    `=== PERSONA ===`,
    `You are ${getPromptBotName(settings)}, a real-feeling regular in a Discord server.`,
    `Style: ${getPromptStyle(settings)}.`,
    ...textGuidance,
    `=== CAPABILITIES ===`,
    getPromptCapabilityHonestyLine(settings),
    memoryEnabled
      ? getPromptMemoryEnabledLine(settings)
      : getPromptMemoryDisabledLine(settings),
    getPromptImpossibleActionLine(settings),
    `=== LIMITS ===`,
    `Discord messages cap at ~1800 characters. Keep replies under that when possible; if you genuinely need more space your message will be automatically split across multiple posts.`,
    ...buildHardLimitsSection(settings),
    `=== OUTPUT ===`,
    getPromptSkipLine(settings)
  ].join("\n");
}

export function buildReplyPrompt({
  message,
  triggerMessageIds = [],
  imageInputs,
  recentMessages,
  relevantMessages,
  userFacts,
  relevantFacts,
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
  recentWebLookups = [],
  memoryLookup = null,
  imageLookup = null,
  allowWebSearchDirective = false,
  allowMemoryLookupDirective = false,
  allowImageLookupDirective = false,
  allowMemoryDirective = false,
  allowAutomationDirective = false,
  automationTimeZoneLabel = "",
  voiceMode = null,
  screenShare = null,
  videoContext = null,
  channelMode = "non_initiative",
  maxMediaPromptChars = 900,
  mediaPromptCraftGuidance = null
}) {
  const parts = [];
  const mediaGuidance = String(mediaPromptCraftGuidance || "").trim() || getMediaPromptCraftGuidance(null);
  const normalizedChannelMode = channelMode === "initiative" ? "initiative" : "non_initiative";
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
        "Attachments:",
        ...imageInputs.map((image) => {
          const name = image.filename || "(unnamed)";
          const type = image.contentType || "unknown";
          return `- ${name} (${type})`;
        })
      ].join("\n")
    );
  }
  parts.push("=== RECENT MESSAGES ===");
  parts.push(formatRecentChat(recentMessages));

  if (relevantMessages?.length) {
    parts.push("=== RELEVANT PAST MESSAGES ===");
    parts.push(formatRecentChat(relevantMessages));
  }

  if (userFacts?.length) {
    parts.push("=== USER FACTS ===");
    parts.push(formatMemoryFacts(userFacts, { includeType: false, includeProvenance: true, maxItems: 8 }));
  }

  if (relevantFacts?.length) {
    parts.push("=== DURABLE MEMORY ===");
    parts.push(formatMemoryFacts(relevantFacts, { includeType: true, includeProvenance: true, maxItems: 10 }));
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
        parts.push("Full memory dump (all stored facts):");
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
    if (eagerness <= 25) {
      parts.push("You tend to observe more than talk. Only chime in when you genuinely have something to say or someone is clearly talking to you.");
    } else if (eagerness >= 90) {
      parts.push("You are an active, social participant who enjoys riffing with people. Jump in when you have something — even lighter contributions are fine.");
    } else if (eagerness >= 75) {
      parts.push("You are pretty engaged in this server. Contribute when you have something that fits the flow.");
    } else {
      parts.push("Be selective about when you jump in. If you do not have something genuinely useful, interesting, or funny to add, output [SKIP].");
    }
    if (normalizedChannelMode === "initiative") {
      parts.push("This is one of your active channels. Short riffs and acknowledgements are fine when they fit naturally.");
      parts.push("If your reply would derail, interrupt, or just repeat what was said, output [SKIP].");
    } else {
      parts.push("This is not one of your main channels. Only jump in if your message is worth the interruption.");
      parts.push("If this message is not meant for you or you would be inserting yourself into someone else's conversation, output [SKIP].");
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
    parts.push("If users mention VC/voice requests, stay consistent with voice being available.");
    if (inVoiceChannel) {
      parts.push("If users ask whether you're in VC, acknowledge that you're already in VC.");
    } else {
      parts.push("If users ask whether you're in VC, acknowledge that you're not currently in VC.");
    }
    parts.push(
      "Hard rule: if a message is an explicit VC command aimed at you (for example: 'join vc', 'join voice', 'hop in vc', 'rejoin vc', 'join again', 'come back'), set voiceIntent.intent=join."
    );
    parts.push(
      "For explicit VC join commands aimed at you, set voiceIntent.confidence to at least 0.9 and do not leave voiceIntent as none."
    );
    parts.push(
      "Do not output text-only deflection for explicit VC join commands; route through voiceIntent."
    );
    parts.push(
      "Use conversational continuity: follow-up VC control requests can still be aimed at you even if the user does not repeat your name."
    );
    parts.push(
      "Use recent turn history to resolve target: if someone just addressed you and follows with a short imperative like 'get in vc now', treat it as likely directed at you unless another explicit target is present."
    );
    parts.push(
      "Prioritize who the current message is addressed to over older context when deciding voiceIntent."
    );
    parts.push(
      "If the incoming message is clearly asking you to join, leave, or report VC status, set voiceIntent.intent to join, leave, or status."
    );
    parts.push(
      "If the user clearly asks you to watch their stream in VC, set voiceIntent.intent to watch_stream."
    );
    parts.push(
      "If the user clearly asks you to stop watching stream, set voiceIntent.intent to stop_watching_stream."
    );
    parts.push(
      "If the user asks whether stream watch is on/off, set voiceIntent.intent to stream_status."
    );
    parts.push(
      "If the user clearly asks you to play music immediately, replace the current track, or start a song now in VC, set voiceIntent.intent to music_play_now."
    );
    parts.push(
      "If the user clearly asks you to queue a song next in VC, set voiceIntent.intent to music_queue_next."
    );
    parts.push(
      "If the user clearly asks you to add a song to the queue without interrupting current playback in VC, set voiceIntent.intent to music_queue_add."
    );
    parts.push(
      "If the user clearly asks you to stop music, set voiceIntent.intent to music_stop."
    );
    parts.push(
      "If the user clearly asks you to pause music, set voiceIntent.intent to music_pause."
    );
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
      parts.push(
        `There is a pending music disambiguation request${pendingQuery ? ` for query "${pendingQuery}"` : ""} on platform ${pendingPlatform} for action ${voiceMode.musicDisambiguation.action === "queue_next" ? "music_queue_next" : voiceMode.musicDisambiguation.action === "queue_add" ? "music_queue_add" : "music_play_now"}.`
      );
      parts.push(
        [
          "Pending music options (use exact ids for selectedResultId):",
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
        `If the user picks one of those options (by number or by naming it), set voiceIntent.intent=${voiceMode.musicDisambiguation.action === "queue_next" ? "music_queue_next" : voiceMode.musicDisambiguation.action === "queue_add" ? "music_queue_add" : "music_play_now"} and voiceIntent.selectedResultId to that exact id.`
      );
    }
    parts.push(
      "Set voiceIntent.confidence from 0 to 1. Use high confidence only for explicit voice-control requests aimed at you."
    );
    parts.push(
      "If the message is clearly aimed at someone else (for example, only tagging another user with no clear reference to you), set voiceIntent.intent to none."
    );
    parts.push(
      "Example: if a message tags another user and says 'come back' without clearly addressing you, set voiceIntent.intent=none."
    );
    parts.push("If intent target is ambiguous, prefer voiceIntent.intent=none with lower confidence.");
    parts.push("For normal chat or ambiguous requests, set voiceIntent.intent to none and keep confidence low.");
  } else {
    parts.push("Voice control capability exists but is currently disabled in settings.");
    parts.push("If asked to join VC, say voice mode is currently disabled.");
    parts.push("Set voiceIntent.intent to none.");
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

  parts.push("=== AVAILABLE TOOLS ===");
  parts.push("You have tools available for web search, memory search, memory storage, and image lookup. Call them when needed before producing your final reply.");
  if (webSearch?.optedOutByUser) {
    parts.push("The user explicitly asked not to use web search. Do not use the web_search tool.");
  } else if (!webSearch?.enabled || !webSearch?.configured) {
    parts.push("Web search is currently unavailable. Do not claim you searched the web.");
  } else if (webSearch?.blockedByBudget || !webSearch?.budget?.canSearch) {
    parts.push("Web search budget is exhausted. Do not claim you searched the web.");
  }

  if (imageLookup?.enabled && imageLookup?.candidates?.length) {
    parts.push("Recent image references from message history:");
    parts.push(formatImageLookupCandidates(imageLookup.candidates));
    parts.push("Use the image_lookup tool if the user refers to an earlier image/photo.");
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
  parts.push("Use tools (web_search, memory_search, memory_write) as needed before producing your final JSON reply.");
  parts.push(
    "Use memory_write sparingly and with judgment: save only genuine durable facts, never requests, insults, toxic phrasing, or future-behavior rules."
  );
  parts.push("Return strict JSON only. Do not output markdown or code fences.");
  parts.push("JSON format:");
  parts.push(REPLY_JSON_SCHEMA);
  parts.push("Set skip=true only when no response should be sent. If skip=true, set text to [SKIP].");
  parts.push("When no reaction is needed, set reactionEmoji to null.");
  parts.push("When no media should be generated, set media to null.");
  parts.push("Set soundboardRefs to [] and leaveVoiceChannel to false for text-channel replies.");
  parts.push("When no automation command is intended, set automationAction.operation=none and other automationAction fields to null/false.");
  parts.push(
    "Set voiceIntent.intent to one of join|leave|status|watch_stream|stop_watching_stream|stream_status|music_play_now|music_queue_next|music_queue_add|music_stop|music_pause|none."
  );
  parts.push("When voiceIntent.intent is music_play_now, music_queue_next, or music_queue_add, set voiceIntent.query to the song name the user wants.");
  parts.push("Set voiceIntent.platform to youtube|soundcloud|auto when intent is music_play_now, music_queue_next, or music_queue_add. Use auto to search all platforms.");
  parts.push("When searchResults are provided (from a previous music search), set voiceIntent.selectedResultId to the ID of the track to use for music_play_now, music_queue_next, or music_queue_add.");
  parts.push("When not issuing voice control, set voiceIntent.intent=none, voiceIntent.confidence=0, voiceIntent.reason=null, and other voiceIntent fields to null.");
  parts.push("Set screenShareIntent.action to one of offer_link|none.");
  parts.push("When not offering a share link, set screenShareIntent.action=none, screenShareIntent.confidence=0, screenShareIntent.reason=null.");

  return parts.join("\n\n");
}

export function buildAutomationPrompt({
  instruction,
  channelName = "channel",
  recentMessages = [],
  relevantMessages = [],
  userFacts = [],
  relevantFacts = [],
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
  if (relevantMessages?.length) {
    parts.push("=== RELEVANT PAST MESSAGES ===");
    parts.push(formatRecentChat(relevantMessages));
  }
  if (userFacts?.length) {
    parts.push("=== USER FACTS ===");
    parts.push(formatMemoryFacts(userFacts, { includeType: false, includeProvenance: true, maxItems: 8 }));
  }
  if (relevantFacts?.length) {
    parts.push("=== DURABLE MEMORY ===");
    parts.push(formatMemoryFacts(relevantFacts, { includeType: true, includeProvenance: true, maxItems: 10 }));
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
        parts.push("Full memory dump (all stored facts):");
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
  parts.push("Set soundboardRefs to [] and leaveVoiceChannel to false.");
  parts.push("Set automationAction.operation=none.");
  parts.push("Set voiceIntent.intent=none, voiceIntent.confidence=0, voiceIntent.reason=null, and other voiceIntent fields to null.");
  parts.push("Set screenShareIntent.action=none, screenShareIntent.confidence=0, screenShareIntent.reason=null.");
  parts.push("Use [SKIP] only when sending nothing is clearly best.");

  return parts.join("\n\n");
}

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
    parts.push("Memory tools (memory_search, memory_write) are available. Use them as tool calls when needed.");
    parts.push(
      "Use memory_write only for genuine durable facts. Do not save requests, insults, toxic phrasing, or rules for future behavior."
    );
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

  if (allowOpenArticleToolCall && normalizedOpenArticleCandidates.length) {
    parts.push("Opening cached articles is available via the open_article tool.");
    parts.push("Valid cached article refs:");
    parts.push(formatOpenArticleCandidates(normalizedOpenArticleCandidates));
  }

  if (allowWebSearchToolCall) {
    if (webSearch?.optedOutByUser) {
      parts.push("The user asked not to use web search. Do not use the web_search tool.");
    } else if (!webSearch?.enabled || !webSearch?.configured) {
      parts.push("Web search is currently unavailable.");
    } else if (webSearch?.blockedByBudget || !webSearch?.budget?.canSearch) {
      parts.push("Web search budget is exhausted.");
    } else {
      parts.push("Live web lookup is available via the web_search tool. Use it when your spoken response needs fresh web info.");
    }
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
    parts.push("Only speak up if you can genuinely add value. If not, output exactly [SKIP].");

    parts.push(...voiceToneGuardrails);
    parts.push("Task: respond as a natural spoken VC reply, or skip if you have nothing to add.");
  } else if (!normalizedDirectAddressed) {
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

  parts.push("Use tools (web_search, memory_search, memory_write, open_article) as needed before producing your final JSON reply.");
  parts.push("Return strict JSON only.");
  parts.push("JSON format:");
  parts.push(
    "{\"text\":\"spoken response or [SKIP]\",\"skip\":false,\"reactionEmoji\":null,\"media\":null,\"soundboardRefs\":[],\"leaveVoiceChannel\":false,\"automationAction\":{\"operation\":\"none\",\"title\":null,\"instruction\":null,\"schedule\":null,\"targetQuery\":null,\"automationId\":null,\"runImmediately\":false,\"targetChannelId\":null},\"voiceIntent\":{\"intent\":\"none\",\"confidence\":0,\"reason\":null,\"query\":null,\"platform\":null,\"searchResults\":null,\"selectedResultId\":null},\"screenShareIntent\":{\"action\":\"none\",\"confidence\":0,\"reason\":null},\"voiceAddressing\":{\"talkingTo\":null,\"directedConfidence\":0}}"
    );
  parts.push("Keep reactionEmoji null, media null, and voiceIntent intent none for voice-turn generation.");
  parts.push("Always include voiceAddressing with both fields.");
  parts.push("If you are skipping, set skip=true and text to [SKIP]. Otherwise set skip=false and provide natural spoken text.");
  parts.push("Never output markdown, tags, or directive syntax like [[...]].");

  return parts.join("\n\n");
}

export function buildInitiativePrompt({
  channelName,
  recentMessages,
  relevantFacts = [],
  emojiHints,
  allowSimpleImagePosts,
  allowComplexImagePosts,
  allowVideoPosts,
  remainingInitiativeImages = 0,
  remainingInitiativeVideos = 0,
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

  const remainingImages = Math.max(0, Math.floor(Number(remainingInitiativeImages) || 0));
  const remainingVideos = Math.max(0, Math.floor(Number(remainingInitiativeVideos) || 0));
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
    parts.push("Image/video generation for initiative posts is unavailable right now. Output text only.");
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
