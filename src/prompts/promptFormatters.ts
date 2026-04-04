import {
  buildHardLimitsSection,
  DEFAULT_PROMPT_TEXT_GUIDANCE,
  DEFAULT_PROMPT_VOICE_GUIDANCE,
  getPromptBotName,
  getPromptCapabilityHonestyLine,
  getPromptImpossibleActionLine,
  getPromptMemoryDisabledLine,
  getPromptMemoryEnabledLine,
  getPromptSkipLine,
  getPromptStyle,
  getPromptTextGuidance,
  getPromptVoiceGuidance,
  buildVoiceToneGuardrails
} from "./promptCore.ts";
import { buildTextCapabilitiesDocs, buildVoiceCapabilitiesDocs, type TextSystemCapabilityFlags, type VoiceSystemCapabilityFlags } from "./promptCapabilities.ts";
import {
  getMemorySettings,
  getVoiceSettings,
  getAutomationsSettings,
  getDiscoverySettings,
  getVideoContextSettings,
  getVoiceStreamWatchSettings,
  isBrowserEnabled,
  isMinecraftEnabled,
  isResearchEnabled
} from "../settings/agentStack.ts";
import { extractUrlsFromText } from "../bot/botHelpers.ts";

const IMAGE_URL_RE = /\.(?:jpe?g|png|gif|webp|bmp|heic)(?:$|[?#])/i;

export function formatBehaviorMemoryFacts(facts, maxItems = 8) {
  const rows = Array.isArray(facts) ? facts : [];
  if (!rows.length) return "(no behavioral memory)";
  return rows
    .slice(0, Math.max(1, Number(maxItems) || 8))
    .map((row) => {
      const factType = String(row?.factType || row?.fact_type || "guidance").trim().toLowerCase() || "guidance";
      const subjectLabel = String(row?.subjectLabel || row?.subject_label || row?.subject || "unknown").trim() || "unknown";
      const factText = String(row?.fact || row?.noteText || row?.note_text || "")
        .replace(/\s+/g, " ")
        .trim();
      if (!factText) return "";
      return `- [${factType}] ${subjectLabel}: ${factText}`;
    })
    .filter(Boolean)
    .join("\n");
}

export function buildSystemPrompt(settings) {
  const memoryEnabled = Boolean(getMemorySettings(settings).enabled);
  const textGuidance = getPromptTextGuidance(settings, DEFAULT_PROMPT_TEXT_GUIDANCE);
  const discovery = getDiscoverySettings(settings);

  const maxMediaPromptChars = Math.max(100, Math.floor(Number(discovery.maxMediaPromptChars) || 900));

  const capabilityFlags: TextSystemCapabilityFlags = {
    voiceEnabled: Boolean(getVoiceSettings(settings).enabled),
    webSearchEnabled: isResearchEnabled(settings),
    browserEnabled: isBrowserEnabled(settings),
    memoryEnabled,
    minecraftEnabled: isMinecraftEnabled(settings),
    mediaGenerationEnabled: Boolean(discovery.allowReplyImages || discovery.allowReplyVideos),
    gifsEnabled: Boolean(discovery.allowReplyGifs),
    automationEnabled: Boolean(getAutomationsSettings(settings).enabled),
    screenShareEnabled: Boolean(getVoiceStreamWatchSettings(settings).enabled),
    videoContextEnabled: Boolean(getVideoContextSettings(settings).enabled),
    maxMediaPromptChars
  };

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
    `=== TOOLS ===`,
    "If something you can do is currently disabled or budget-blocked, say it is currently unavailable with the reason. Do not claim a supported feature can never work.",
    ...buildTextCapabilitiesDocs(settings, capabilityFlags),
    `=== LIMITS ===`,
    `Discord messages cap at ~1800 characters. Keep replies under that when possible; if you genuinely need more space your message will be automatically split across multiple posts.`,
    ...buildHardLimitsSection(settings),
    `=== OUTPUT ===`,
    getPromptSkipLine(settings)
  ].join("\n");
}

export function buildVoiceSystemPrompt(settings) {
  const memoryEnabled = Boolean(getMemorySettings(settings).enabled);
  const voiceGuidance = getPromptVoiceGuidance(settings, DEFAULT_PROMPT_VOICE_GUIDANCE);

  const capabilityFlags: VoiceSystemCapabilityFlags = {
    webSearchEnabled: isResearchEnabled(settings),
    browserEnabled: isBrowserEnabled(settings),
    memoryEnabled,
    minecraftEnabled: isMinecraftEnabled(settings),
    screenShareEnabled: Boolean(getVoiceStreamWatchSettings(settings).enabled)
  };

  return [
    `=== PERSONA ===`,
    `You are ${getPromptBotName(settings)}, a real-feeling regular in a Discord server speaking in live voice chat.`,
    `Style: ${getPromptStyle(settings)}.`,
    ...voiceGuidance,
    ...buildVoiceToneGuardrails(),
    `=== CAPABILITIES ===`,
    getPromptCapabilityHonestyLine(settings),
    memoryEnabled
      ? getPromptMemoryEnabledLine(settings)
      : getPromptMemoryDisabledLine(settings),
    getPromptImpossibleActionLine(settings),
    `=== TOOLS ===`,
    "If something you can do is currently disabled or budget-blocked, say it is currently unavailable with the reason. Do not claim a supported feature can never work.",
    ...buildVoiceCapabilitiesDocs(capabilityFlags),
    `=== LIMITS ===`,
    `Voice replies should feel like live conversation. A short acknowledgement is often enough; go longer only when you genuinely have more to add.`,
    ...buildHardLimitsSection(settings),
    `=== OUTPUT ===`,
    getPromptSkipLine(settings)
  ].join("\n");
}

function stripEmojiForPrompt(text) {
  let value = String(text || "");
  value = value.replace(/<a?:[a-zA-Z0-9_~]+:\d+>/g, "");
  value = value.replace(/:[a-zA-Z0-9_+-]+:/g, "");
  value = value.replace(/[\p{Extended_Pictographic}\uFE0F]/gu, "");
  return value.replace(/\s+/g, " ").trim();
}

export function formatRecentChat(messages, options = {}) {
  if (!messages?.length) return "(no recent messages available)";

  const imageCandidates =
    options && typeof options === "object" && !Array.isArray(options)
      ? (options as { imageCandidates?: unknown }).imageCandidates
      : [];
  const imageRefMap = buildHistoryImageReferenceMap(imageCandidates);

  return messages
    .slice()
    .reverse()
    .map((msg) => {
      const isBot = msg.is_bot === 1 || msg.is_bot === true || msg.is_bot === "1";
      const rawText = String(msg.content || "");
      const normalized = isBot ? stripEmojiForPrompt(rawText) : rawText;
      const text = replaceHistoryImageUrlsWithRefs(normalized, imageRefMap).replace(/\s+/g, " ").trim();
      return `- ${msg.author_name}: ${text || "(empty)"}`;
    })
    .join("\n");
}

function buildHistoryImageReferenceMap(candidates) {
  const rows = Array.isArray(candidates) ? candidates : [];
  const map = new Map();
  for (const row of rows) {
    const url = String(row?.url || "").trim();
    const imageRef = String(row?.imageRef || "").trim();
    if (!url || !imageRef) continue;
    map.set(url, {
      imageRef,
      authorName: String(row?.authorName || "unknown").trim() || "unknown",
      when: formatRelativePromptAge(row?.createdAt)
    });
  }
  return map;
}

function replaceHistoryImageUrlsWithRefs(text, imageRefMap) {
  const source = String(text || "");
  if (!source || !(imageRefMap instanceof Map) || imageRefMap.size === 0) return source;

  let replaced = source;
  for (const rawUrl of extractUrlsFromText(source)) {
    const url = String(rawUrl || "").trim();
    if (!url || !isLikelyPromptImageUrl(url)) continue;
    const ref = imageRefMap.get(url);
    if (!ref) continue;
    const whenLabel = ref.when ? `, ${ref.when}` : "";
    const replacement = `[${ref.imageRef} by ${ref.authorName}${whenLabel}]`;
    replaced = replaced.split(url).join(replacement);
  }

  return replaced;
}

function isLikelyPromptImageUrl(rawUrl) {
  const text = String(rawUrl || "").trim();
  if (!text) return false;
  return IMAGE_URL_RE.test(text);
}

function formatRelativePromptAge(createdAt) {
  const createdAtMs = Date.parse(String(createdAt || ""));
  if (!Number.isFinite(createdAtMs)) return "";
  const deltaMinutes = Math.max(0, Math.round((Date.now() - createdAtMs) / 60000));
  if (deltaMinutes < 1) return "just now";
  if (deltaMinutes < 60) return `${deltaMinutes}m ago`;
  const deltaHours = Math.round(deltaMinutes / 60);
  if (deltaHours < 24) return `${deltaHours}h ago`;
  const deltaDays = Math.round(deltaHours / 24);
  return `${deltaDays}d ago`;
}

function formatConversationWindowAge(ageMinutes) {
  const normalizedAge = Number(ageMinutes);
  if (!Number.isFinite(normalizedAge)) return "recent";
  if (normalizedAge < 60) return `${Math.max(0, Math.round(normalizedAge))}m ago`;
  if (normalizedAge < 24 * 60) return `${Math.max(1, Math.round(normalizedAge / 60))}h ago`;
  return `${Math.max(1, Math.round(normalizedAge / (24 * 60)))}d ago`;
}

export function formatConversationWindows(windows) {
  const rows = Array.isArray(windows) ? windows : [];
  if (!rows.length) return "(no matching conversation history)";

  return rows
    .slice(0, 4)
    .map((window, index) => {
      const ageLabel = formatConversationWindowAge(window?.ageMinutes);
      const messages = Array.isArray(window?.messages) ? window.messages : [];
      const isVoiceWindow = messages.some(
        (msg) => String(msg?.message_id || "").startsWith("voice-")
      );
      const sourceLabel = isVoiceWindow ? "voice chat" : "text";
      const lines = messages
        .slice(0, 5)
        .map((message) => {
          const authorName = String(message?.author_name || message?.authorName || "unknown").trim() || "unknown";
          const rawText = String(message?.content || "").trim();
          const normalizedText =
            message?.is_bot === 1 || message?.is_bot === true ? stripEmojiForPrompt(rawText) : rawText;
          const text = normalizedText.replace(/\s+/g, " ").trim() || "(empty)";
          const msgAge = formatRelativePromptAge(message?.created_at || message?.createdAt);
          const msgAgeLabel = msgAge ? ` (${msgAge})` : "";
          return `  - ${authorName}${msgAgeLabel}: ${text}`;
        })
        .join("\n");
      return `- [C${index + 1}] ${ageLabel}, ${sourceLabel}\n${lines}`;
    })
    .join("\n");
}

export function formatConversationParticipantMemory({
  participantProfiles = [],
  selfFacts = [],
  loreFacts = []
}: {
  participantProfiles?: Array<Record<string, unknown>>;
  selfFacts?: Array<Record<string, unknown>>;
  loreFacts?: Array<Record<string, unknown>>;
}) {
  const participants = Array.isArray(participantProfiles) ? participantProfiles : [];
  const lines = participants
    .slice(0, 8)
    .map((participant) => {
      const displayName = String(participant?.displayName || participant?.userId || "unknown").trim() || "unknown";
      const facts = Array.isArray(participant?.facts) ? participant.facts : [];
      if (!facts.length) return "";
      const factLines = formatMemoryFacts(facts, {
        includeType: false,
        includeProvenance: false,
        maxItems: participant?.isPrimary ? 8 : 3
      })
        .split("\n")
        .map((line) => `  ${line}`);
      const roleLabel = participant?.isPrimary ? " (current speaker)" : "";
      return [`${displayName}${roleLabel}:`, ...factLines].join("\n");
    })
    .filter(Boolean);

  if (Array.isArray(selfFacts) && selfFacts.length > 0) {
    lines.push(
      [
        "Bot self:",
        ...formatMemoryFacts(selfFacts, {
          includeType: false,
          includeProvenance: false,
          maxItems: 6
        })
          .split("\n")
          .map((line) => `  ${line}`)
      ].join("\n")
    );
  }

  if (Array.isArray(loreFacts) && loreFacts.length > 0) {
    lines.push(
      [
        "Shared lore:",
        ...formatMemoryFacts(loreFacts, {
          includeType: false,
          includeProvenance: false,
          maxItems: 6
        })
          .split("\n")
          .map((line) => `  ${line}`)
      ].join("\n")
    );
  }

  return lines.length ? lines.join("\n") : "(no participant memory)";
}

export function formatEmojiChoices(emojiOptions) {
  if (!emojiOptions?.length) return "(no emoji options available)";
  return emojiOptions.map((emoji) => `- ${emoji}`).join("\n");
}


export function formatWebSearchFindings(webSearch) {
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

function formatPromptRelativeAge(rawValue) {
  return formatRelativePromptAge(rawValue) || "unknown";
}

type InitiativePromptMessage = {
  message_id?: string;
  author_name?: string;
  authorName?: string;
  content?: string;
};

type InitiativePromptChannel = {
  channelId?: string;
  channelName?: string;
  name?: string;
  lastHumanAt?: string | null;
  lastHumanMessageId?: string | null;
  lastHumanAuthorName?: string | null;
  lastHumanSnippet?: string | null;
  lastBotAt?: string | null;
  recentHumanMessageCount?: number;
  recentMessages?: InitiativePromptMessage[];
};

function getInitiativeHistorySourceTag(messageId: unknown) {
  const normalizedMessageId = String(messageId || "").trim();
  if (normalizedMessageId.startsWith("voice-") || normalizedMessageId.startsWith("voice-assistant-")) {
    return "vc";
  }
  return "text";
}

export function formatInitiativeChannelSummaries(channels) {
  const rows = (Array.isArray(channels) ? channels : []) as InitiativePromptChannel[];
  if (!rows.length) return "Eligible channels:\n(no eligible channels)";

  const summaries = rows
    .map((channel) => {
      const channelName = String(channel?.channelName || channel?.name || "channel").trim() || "channel";
      const lastHumanSnippet = String(channel?.lastHumanSnippet || "").trim();
      const lastHumanAt = String(channel?.lastHumanAt || "").trim();
      const lastHumanSourceTag = getInitiativeHistorySourceTag(channel?.lastHumanMessageId);
      const lastHumanSourceLabel = lastHumanSourceTag === "vc" ? " [vc transcript]" : "";
      const lastHumanAuthorName = String(channel?.lastHumanAuthorName || "").trim();
      const lastHumanWho = lastHumanAuthorName ? ` (user: ${lastHumanAuthorName})` : "";
      const lastHumanLine = lastHumanSnippet && lastHumanAt
        ? `Last human message: ${formatPromptRelativeAge(lastHumanAt)}${lastHumanSourceLabel} — "${lastHumanSnippet}"${lastHumanWho}`
        : "Last human message: quiet";
      const lastBotAt = String(channel?.lastBotAt || "").trim();
      const botLine = lastBotAt
        ? `Your last message: ${formatPromptRelativeAge(lastBotAt)}`
        : "Your last message: never";
      const recentActivity = Number(channel?.recentHumanMessageCount || 0);
      const activityLine =
        recentActivity > 0
          ? `Recent activity: ${recentActivity} message${recentActivity === 1 ? "" : "s"} in the last hour`
          : "Recent activity: idle";
      const recentMessages = Array.isArray(channel?.recentMessages)
        ? channel.recentMessages
        : [];
      const messageLines = recentMessages.length
        ? recentMessages
          .slice(-5)
          .map((message) => {
            const sourceTag = getInitiativeHistorySourceTag(message?.message_id);
            const author = String(message?.author_name || message?.authorName || "unknown").trim() || "unknown";
            const text = stripEmojiForPrompt(String(message?.content || ""))
              .replace(/\s+/g, " ")
              .trim() || "(empty)";
            const msgId = String(message?.message_id || "").trim();
            const idLabel = msgId ? ` [id:${msgId}]` : "";
            return `  - [${sourceTag}] ${author}: ${text}${idLabel}`;
          })
          .join("\n")
        : "  - (no recent messages captured)";
      return [
        `#${channelName} (text)`,
        `  channelId: ${String(channel?.channelId || "").trim() || "(missing)"}`,
        `  ${lastHumanLine}`,
        `  ${botLine}`,
        `  ${activityLine}`,
        "  Recent messages ([text]=typed in channel, [vc]=transcript from linked voice chat):",
        messageLines
      ].join("\n");
    })
    .join("\n\n");

  return `Eligible channels:\n\n${summaries}`;
}

export function formatInitiativeFeedCandidates(candidates) {
  const rows = Array.isArray(candidates) ? candidates : [];
  if (!rows.length) return "Nothing new in your feed right now.";

  const formattedRows = rows
    .slice(0, 8)
    .map((item, index) => {
      const title = String(item?.title || "untitled").trim() || "untitled";
      const source = String(item?.sourceLabel || item?.source || "web").trim() || "web";
      const publishedAt = String(item?.publishedAt || "").trim();
      const ageLabel = publishedAt ? formatPromptRelativeAge(publishedAt) : "recent";
      const excerpt = String(item?.excerpt || "").trim();
      const excerptLine = excerpt ? `\n   Note: ${excerpt}` : "";
      const url = String(item?.url || "").trim();
      return `${index + 1}. "${title}"\n   Source: ${source} · ${ageLabel}\n   Link: ${url}${excerptLine}`;
    })
    .join("\n\n");

  return `Things from your feed (share if any catch your eye):\n\n${formattedRows}`;
}

export function formatInitiativeSourcePerformance(sources) {
  const rows = Array.isArray(sources) ? sources : [];
  if (!rows.length) return "No source performance data yet.";

  const formattedRows = rows
    .map((entry) => {
      const label = String(entry?.label || entry?.source || "source").trim() || "source";
      const shared = Math.max(0, Number(entry?.sharedCount || 0));
      const fetched = Math.max(0, Number(entry?.fetchedCount || 0));
      const engagement = Math.max(0, Number(entry?.engagementCount || 0));
      const lastUsedAt = String(entry?.lastUsedAt || "").trim();
      const lastUsedLabel = lastUsedAt ? `, last used ${formatPromptRelativeAge(lastUsedAt)}` : "";
      return `- ${label} — ${shared}/${fetched} candidates shared in last 2 weeks, ${engagement} community engagement${lastUsedLabel}`;
    })
    .join("\n");

  return `Your feed sources:\n${formattedRows}`;
}

export function formatInitiativeInterestFacts(facts) {
  const rows = Array.isArray(facts) ? facts : [];
  if (!rows.length) return "You're still getting to know this community.";

  return rows
    .slice(0, 8)
    .map((fact) => `- ${String(fact || "").replace(/\s+/g, " ").trim()}`)
    .filter(Boolean)
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

export function formatMemoryFacts(facts, { includeType = true, includeProvenance = true, maxItems = 12 } = {}) {
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

export function formatImageLookupCandidates(candidates) {
  if (!candidates?.length) return "(no recent image references found)";
  return candidates
    .slice(0, 12)
    .map((row, index) => {
      const filename = String(row?.filename || "(unnamed)").trim();
      const author = String(row?.authorName || "unknown").trim();
      const when = formatRelativePromptAge(row?.createdAt) || String(row?.createdAt || "").trim();
      const context = String(row?.context || "").trim();
      const ref = String(row?.imageRef || `IMG ${index + 1}`).trim();
      const whenLabel = when ? `, ${when}` : "";
      const contextLabel = context ? ` | context: ${context}` : "";
      return `- [${ref}] ${filename} by ${author}${whenLabel}${contextLabel}`;
    })
    .join("\n");
}
