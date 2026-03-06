import {
  buildHardLimitsSection,
  DEFAULT_PROMPT_TEXT_GUIDANCE,
  getPromptBotName,
  getPromptCapabilityHonestyLine,
  getPromptImpossibleActionLine,
  getPromptMemoryDisabledLine,
  getPromptMemoryEnabledLine,
  getPromptSkipLine,
  getPromptStyle,
  getPromptTextGuidance
} from "./promptCore.ts";
import { extractUrlsFromText } from "../bot/botHelpers.ts";

const IMAGE_URL_RE = /\.(?:jpe?g|png|gif|webp|bmp|heic)(?:$|[?#])/i;

export function formatAdaptiveDirectives(notes, maxItems = 8) {
  const rows = Array.isArray(notes) ? notes : [];
  if (!rows.length) return "(no adaptive directives)";
  return rows
    .slice(0, Math.max(1, Number(maxItems) || 8))
    .map((row) => {
      const noteId = Number(row?.id);
      const directiveKind = String(row?.directiveKind || row?.directive_kind || "guidance").trim().toLowerCase() || "guidance";
      const noteText = String(row?.noteText || row?.note_text || "")
        .replace(/\s+/g, " ")
        .trim();
      if (!noteText) return "";
      const ref = Number.isInteger(noteId) ? ` [S${noteId}]` : "";
      return `-${ref} [${directiveKind}] ${noteText}`;
    })
    .filter(Boolean)
    .join("\n");
}

export function buildSystemPrompt(settings, { adaptiveDirectives = [] } = {}) {
  const memoryEnabled = Boolean(settings?.memory?.enabled);
  const textGuidance = getPromptTextGuidance(settings, DEFAULT_PROMPT_TEXT_GUIDANCE);

  return [
    `=== PERSONA ===`,
    `You are ${getPromptBotName(settings)}, a real-feeling regular in a Discord server.`,
    `Style: ${getPromptStyle(settings)}.`,
    ...textGuidance,
    adaptiveDirectives.length > 0 ? `=== ADAPTIVE DIRECTIVES ===` : null,
    adaptiveDirectives.length > 0
      ? "These are active persistent server-level directives saved from prior conversation or dashboard edits. Guidance directives shape tone/persona. Behavior directives describe recurring trigger/action behavior. Follow them when relevant unless they conflict with hard limits or the current request."
      : null,
    adaptiveDirectives.length > 0 ? formatAdaptiveDirectives(adaptiveDirectives, 8) : null,
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

export function stripEmojiForPrompt(text) {
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
      const lines = (Array.isArray(window?.messages) ? window.messages : [])
        .slice(0, 5)
        .map((message) => {
          const authorName = String(message?.author_name || message?.authorName || "unknown").trim() || "unknown";
          const rawText = String(message?.content || "").trim();
          const normalizedText =
            message?.is_bot === 1 || message?.is_bot === true ? stripEmojiForPrompt(rawText) : rawText;
          const text = normalizedText.replace(/\s+/g, " ").trim() || "(empty)";
          return `  - ${authorName}: ${text}`;
        })
        .join("\n");
      return `- [C${index + 1}] ${ageLabel}\n${lines}`;
    })
    .join("\n");
}

export function formatEmojiChoices(emojiOptions) {
  if (!emojiOptions?.length) return "(no emoji options available)";
  return emojiOptions.map((emoji) => `- ${emoji}`).join("\n");
}

export function formatDiscoveryFindings(findings) {
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

export function formatRecentLookupContext(recentWebLookups) {
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

export function formatOpenArticleCandidates(candidates) {
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

export function formatVideoFindings(videoContext) {
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

export function renderPromptMemoryFact(row, { includeType = true, includeProvenance = true } = {}) {
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

export function formatMemoryLookupResults(results) {
  if (!results?.length) return "(no matching durable memory found)";
  return results
    .map((row, index) => {
      const rendered = renderPromptMemoryFact(row, { includeType: true, includeProvenance: true });
      return rendered ? `- [M${index + 1}] ${rendered}` : "";
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

export function formatImageLookupResults(results) {
  if (!results?.length) return "(no matching history images found)";
  return results
    .map((row, index) => {
      const filename = String(row?.filename || "(unnamed)").trim();
      const author = String(row?.authorName || "unknown").trim();
      const when = formatRelativePromptAge(row?.createdAt) || String(row?.createdAt || "").trim();
      const reason = String(row?.matchReason || "").trim();
      const ref = String(row?.imageRef || `IMG ${index + 1}`).trim();
      const whenLabel = when ? `, ${when}` : "";
      const reasonLabel = reason ? ` | match: ${reason}` : "";
      return `- [${ref}] ${filename} by ${author}${whenLabel}${reasonLabel}`;
    })
    .join("\n");
}
