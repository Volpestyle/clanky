import { clamp } from "../utils.ts";
import { normalizeAutomationSchedule } from "./automation.ts";
import { normalizeMentionLookupKey } from "./mentionLookup.ts";
import { normalizeWhitespaceText } from "../normalization/text.ts";
import { extractJsonObjectFromText } from "../normalization/jsonExtraction.ts";
import { getDiscoverySettings } from "../settings/agentStack.ts";

const URL_IN_TEXT_RE = /https?:\/\/[^\s<>()]+/gi;
const STRUCTURED_REPLY_CODE_FENCE_OPEN_RE = /^```(?:json)?\s*/i;
const STRUCTURED_REPLY_TEXT_FIELD_RE = /"text"\s*:\s*"((?:\\.|[^"\\])*)"/s;
const STRUCTURED_REPLY_SKIP_TRUE_RE = /"skip"\s*:\s*true\b/i;

type ParseState = "json" | "recovered_json" | "unstructured";
// English-only fallback for explicit user opt-outs; normal prompt/tool policy remains the source of truth.
const EN_WEB_SEARCH_OPTOUT_RE = /\b(?:do\s*not|don't|dont|no)\b[\w\s,]{0,24}\b(?:google|search|look\s*up)\b/i;
const DEFAULT_MAX_MEDIA_PROMPT_LEN = 900;
const MAX_MEDIA_PROMPT_FLOOR = 120;
const MAX_MEDIA_PROMPT_CEILING = 2000;
export const MAX_WEB_QUERY_LEN = 220;
export const MAX_GIF_QUERY_LEN = 120;
export const MAX_IMAGE_LOOKUP_QUERY_LEN = 220;
export const MAX_BROWSER_BROWSE_QUERY_LEN = 500;
const MAX_REPLY_TEXT_LEN = 3600;
const MAX_INITIATIVE_TEXT_LEN = 3600;
const MAX_INITIATIVE_REASON_LEN = 240;
const MAX_INITIATIVE_CHANNEL_ID_LEN = 80;
const MAX_AUTOMATION_TITLE_LEN = 90;
const MAX_AUTOMATION_INSTRUCTION_LEN = 360;
const MAX_AUTOMATION_TARGET_QUERY_LEN = 180;

export function resolveMaxMediaPromptLen(settings) {
  const raw = Number(getDiscoverySettings(settings).maxMediaPromptChars);
  if (!Number.isFinite(raw)) return DEFAULT_MAX_MEDIA_PROMPT_LEN;
  return clamp(Math.floor(raw), MAX_MEDIA_PROMPT_FLOOR, MAX_MEDIA_PROMPT_CEILING);
}
const REPLY_MEDIA_TYPES = new Set(["image_simple", "image_complex", "video", "gif", "tool_images"]);
const REPLY_AUTOMATION_OPERATION_TYPES = new Set(["create", "pause", "resume", "delete", "list", "none"]);
const REPLY_SCREEN_SHARE_ACTION_TYPES = new Set(["start_watch", "none"]);
const MAX_SCREEN_SHARE_REASON_LEN = 180;
export const MAX_VIDEO_TARGET_SCAN = 8;
export const MAX_VIDEO_FALLBACK_MESSAGES = 18;
const MENTION_CANDIDATE_RE = /(?<![\w<])@([a-z0-9][a-z0-9 ._'-]{0,63})/gi;
export const MAX_MENTION_CANDIDATES = 8;
const MAX_MENTION_LOOKUP_VARIANTS = 8;

function emptyStructuredAutomationAction() {
  return {
    operation: null,
    title: null,
    instruction: null,
    schedule: null,
    targetQuery: null,
    automationId: null,
    runImmediately: false,
    targetChannelId: null
  };
}

function emptyStructuredScreenShareIntent() {
  return {
    action: null,
    confidence: 0,
    reason: null
  };
}

export const REPLY_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    text: { type: "string" },
    skip: { type: "boolean" },
    reactionEmoji: { type: ["string", "null"] },
    media: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            type: {
              type: "string",
              enum: ["image_simple", "image_complex", "video", "gif", "tool_images", "none"]
            },
            prompt: { type: ["string", "null"] }
          },
          required: ["type", "prompt"]
        }
      ]
    },
    automationAction: {
      type: "object",
      additionalProperties: false,
      properties: {
        operation: {
          type: "string",
          enum: ["create", "pause", "resume", "delete", "list", "none"]
        },
        title: { type: ["string", "null"] },
        instruction: { type: ["string", "null"] },
        schedule: {
          anyOf: [
            { type: "null" },
            {
              type: "object",
              additionalProperties: false,
              properties: {
                kind: { type: "string", enum: ["daily", "interval", "once"] },
                hour: { type: ["number", "null"] },
                minute: { type: ["number", "null"] },
                everyMinutes: { type: ["number", "null"] },
                atIso: { type: ["string", "null"] }
              },
              required: ["kind", "hour", "minute", "everyMinutes", "atIso"]
            }
          ]
        },
        targetQuery: { type: ["string", "null"] },
        automationId: { type: ["number", "null"] },
        runImmediately: { type: "boolean" },
        targetChannelId: { type: ["string", "null"] }
      },
      required: [
        "operation",
        "title",
        "instruction",
        "schedule",
        "targetQuery",
        "automationId",
        "runImmediately",
        "targetChannelId"
      ]
    },
    screenWatchIntent: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: ["start_watch", "none"] },
        confidence: { type: "number" },
        reason: { type: ["string", "null"] }
      },
      required: ["action", "confidence", "reason"]
    },
  },
  required: [
    "text",
    "skip",
    "reactionEmoji",
    "media",
    "automationAction",
    "screenWatchIntent"
  ]
};

export const REPLY_OUTPUT_JSON_SCHEMA = JSON.stringify(REPLY_OUTPUT_SCHEMA);

const INITIATIVE_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: {
      type: "string",
      enum: ["post_now", "hold", "drop"]
    },
    channelId: { type: ["string", "null"] },
    replyToMessageId: { type: ["string", "null"] },
    text: { type: "string" },
    mediaDirective: {
      type: "string",
      enum: ["none", "image", "video", "gif"]
    },
    mediaPrompt: { type: ["string", "null"] },
    reason: { type: "string" }
  },
  required: ["action", "channelId", "text", "mediaDirective", "mediaPrompt", "reason"]
};

export const INITIATIVE_OUTPUT_JSON_SCHEMA = JSON.stringify(INITIATIVE_OUTPUT_SCHEMA);

export function formatReactionSummary(message) {
  const cache = message?.reactions?.cache;
  if (!cache?.size) return "";

  const rows = [];
  for (const reaction of cache.values()) {
    const count = Number(reaction?.count || 0);
    if (!Number.isFinite(count) || count <= 0) continue;
    const label = normalizeReactionLabel(reaction?.emoji);
    if (!label) continue;
    rows.push({ label, count });
  }

  if (!rows.length) return "";

  rows.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.label.localeCompare(b.label);
  });

  return rows
    .slice(0, 6)
    .map((row) => `${row.label}x${row.count}`)
    .join(", ");
}

function normalizeReactionLabel(emoji) {
  const id = String(emoji?.id || "").trim();
  const rawName = String(emoji?.name || "").trim();
  if (id) {
    const safe = sanitizeReactionLabel(rawName);
    return safe ? `custom:${safe}` : `custom:${id}`;
  }
  if (!rawName) return "";

  const safe = sanitizeReactionLabel(rawName);
  if (safe) return safe;

  const codepoints = [...rawName]
    .map((char) => char.codePointAt(0))
    .filter((value) => Number.isFinite(value))
    .map((value) => value.toString(16));
  if (!codepoints.length) return "";
  return `u${codepoints.join("_")}`;
}

function sanitizeReactionLabel(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_+-]+/g, "")
    .slice(0, 32);
}

export function extractUrlsFromText(text) {
  URL_IN_TEXT_RE.lastIndex = 0;
  return [...String(text || "").matchAll(URL_IN_TEXT_RE)].map((match) => String(match[0] || ""));
}

export function emptyMentionResolution() {
  return {
    text: "",
    attemptedCount: 0,
    resolvedCount: 0,
    ambiguousCount: 0,
    unresolvedCount: 0
  };
}

export function extractMentionCandidates(text, maxItems = MAX_MENTION_CANDIDATES) {
  const source = String(text || "");
  if (!source.includes("@")) return [];

  const out = [];
  MENTION_CANDIDATE_RE.lastIndex = 0;
  let match;
  while ((match = MENTION_CANDIDATE_RE.exec(source)) && out.length < Math.max(1, Number(maxItems) || 1)) {
    const rawCandidate = String(match[1] || "");
    const withoutTrailingSpace = rawCandidate.replace(/\s+$/g, "");
    const withoutTrailingPunctuation = withoutTrailingSpace
      .replace(/[.,:;!?)\]}]+$/g, "")
      .replace(/\s+$/g, "");
    const start = match.index;
    const variants = buildMentionLookupVariants({
      mentionText: withoutTrailingPunctuation,
      mentionStart: start
    });
    if (!variants.length) continue;
    const end = variants[0].end;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start + 1) continue;

    out.push({
      start,
      end,
      variants
    });
  }

  return out;
}

function buildMentionLookupVariants({ mentionText, mentionStart }) {
  const source = String(mentionText || "").trim();
  if (!source) return [];

  const wordRe = /[a-z0-9][a-z0-9._'-]*/gi;
  const tokens = [];
  let token;
  while ((token = wordRe.exec(source))) {
    tokens.push({
      end: token.index + String(token[0] || "").length
    });
  }
  if (!tokens.length) return [];

  const variants = [];
  const seen = new Set();
  const maxTokens = Math.min(tokens.length, MAX_MENTION_LOOKUP_VARIANTS);
  for (let count = maxTokens; count >= 1; count -= 1) {
    const tokenEnd = tokens[count - 1]?.end;
    if (!Number.isFinite(tokenEnd) || tokenEnd <= 0) continue;
    const prefix = source.slice(0, tokenEnd).replace(/\s+$/g, "");
    if (!prefix) continue;
    if (/^\d{2,}$/.test(prefix)) continue;
    const lookupKey = normalizeMentionLookupKey(prefix);
    if (!lookupKey || lookupKey === "everyone" || lookupKey === "here") continue;
    if (seen.has(lookupKey)) continue;
    seen.add(lookupKey);
    variants.push({
      lookupKey,
      end: mentionStart + 1 + prefix.length
    });
  }

  return variants;
}

export function collectMemberLookupKeys(member) {
  const keys = new Set();
  const values = [
    member?.displayName,
    member?.nickname,
    member?.user?.globalName,
    member?.user?.username
  ];

  for (const value of values) {
    const normalized = normalizeMentionLookupKey(value);
    if (!normalized) continue;
    keys.add(normalized);
  }

  return keys;
}

export function looksLikeVideoFollowupMessage(rawText) {
  const text = String(rawText || "").trim();
  if (!text) return false;
  if (extractUrlsFromText(text).length) return false;

  const hasVideoTopic = /\b(?:video|clip|youtube|yt|tiktok|tt|reel|short)\b/i.test(text);
  if (!hasVideoTopic) return false;

  return /\b(?:watch|watched|watching|see|seen|view|check|open|play)\b/i.test(text);
}

export function extractRecentVideoTargets({
  videoService,
  recentMessages,
  maxMessages = MAX_VIDEO_FALLBACK_MESSAGES,
  maxTargets = MAX_VIDEO_TARGET_SCAN
}) {
  if (!videoService || !Array.isArray(recentMessages) || !recentMessages.length) return [];

  const normalizedMaxMessages = clamp(Number(maxMessages) || MAX_VIDEO_FALLBACK_MESSAGES, 1, 120);
  const normalizedMaxTargets = clamp(Number(maxTargets) || MAX_VIDEO_TARGET_SCAN, 1, 8);
  const targets = [];
  const seenKeys = new Set();

  for (const row of recentMessages.slice(0, normalizedMaxMessages)) {
    if (targets.length >= normalizedMaxTargets) break;
    if (Number(row?.is_bot || 0) === 1) continue;

    const content = String(row?.content || "");
    if (!content) continue;

    const rowTargets = videoService.extractVideoTargets(content, normalizedMaxTargets);
    for (const target of rowTargets) {
      if (targets.length >= normalizedMaxTargets) break;
      const key = String(target?.key || "").trim();
      if (!key || seenKeys.has(key)) continue;
      seenKeys.add(key);
      targets.push(target);
    }
  }

  return targets;
}

function normalizeMediaPromptContext(rawText) {
  URL_IN_TEXT_RE.lastIndex = 0;
  return String(rawText || "")
    .replace(URL_IN_TEXT_RE, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 260);
}

function composeMediaPrompt({
  promptText,
  contextText,
  maxLen = DEFAULT_MAX_MEDIA_PROMPT_LEN,
  memoryFacts = [],
  intro,
  contextLabel,
  fallbackScene,
  fallbackContext,
  styleGuidance = [],
  hardConstraints = []
}) {
  const requested = normalizeDirectiveText(promptText, maxLen);
  const memoryHints = formatMediaMemoryHints(memoryFacts, 5);

  return [
    intro,
    `Scene: ${requested || contextText || fallbackScene}.`,
    `${contextLabel}: ${contextText || fallbackContext}.`,
    memoryHints || null,
    "Style guidance:",
    ...styleGuidance,
    "Hard constraints:",
    ...hardConstraints
  ]
    .filter(Boolean)
    .join("\n");
}

export function composeDiscoveryImagePrompt(
  imagePrompt,
  postText,
  maxLen = DEFAULT_MAX_MEDIA_PROMPT_LEN,
  memoryFacts = []
) {
  const topic = normalizeMediaPromptContext(postText);
  return composeMediaPrompt({
    promptText: imagePrompt,
    contextText: topic,
    maxLen,
    memoryFacts,
    intro: "Create a vivid, shareable image for a Discord post.",
    contextLabel: "Mood/topic context (do not render as text)",
    fallbackScene: "general chat mood",
    fallbackContext: "general chat mood",
    styleGuidance: [
      "- Describe a concrete scene with a clear subject, action, and environment.",
      "- Use cinematic or editorial framing: strong focal point, depth of field, deliberate camera angle.",
      "- Include expressive lighting (golden hour, neon glow, dramatic chiaroscuro, soft diffused, etc.).",
      "- Choose a cohesive color palette that reinforces the mood.",
      "- Favor a specific visual medium when it fits (photo-realistic, illustration, 3D render, pixel art, watercolor, cel-shaded, collage)."
    ],
    hardConstraints: [
      "- Absolutely no visible text, letters, numbers, logos, subtitles, captions, UI elements, or watermarks anywhere in the image.",
      "- Do not render any words from the scene description or topic context as text inside the image.",
      "- Keep the composition clean with a single strong focal point."
    ]
  });
}

export function composeDiscoveryVideoPrompt(
  videoPrompt,
  postText,
  maxLen = DEFAULT_MAX_MEDIA_PROMPT_LEN,
  memoryFacts = []
) {
  const topic = normalizeMediaPromptContext(postText);
  return composeMediaPrompt({
    promptText: videoPrompt,
    contextText: topic,
    maxLen,
    memoryFacts,
    intro: "Create a short, dynamic, shareable video clip for a Discord post.",
    contextLabel: "Mood/topic context (do not render as text)",
    fallbackScene: "general chat mood",
    fallbackContext: "general chat mood",
    styleGuidance: [
      "- Describe a concrete motion arc: what the viewer sees at the start, what changes, and how it resolves.",
      "- Specify camera behavior (slow pan, tracking shot, static wide, zoom-in, dolly, handheld shake).",
      "- Include lighting mood and color palette.",
      "- Keep the action legible in a short social-clip format (3-6 seconds of clear motion)."
    ],
    hardConstraints: [
      "- No visible text, captions, subtitles, logos, watermarks, or UI overlays.",
      "- Smooth, continuous motion without abrupt jumps or flicker."
    ]
  });
}

function formatMediaMemoryHints(memoryFacts = [], maxItems = 5) {
  const out = collectMemoryFactHints(memoryFacts, maxItems);
  if (!out.length) return "";
  return `Relevant memory facts (use only when they match the scene): ${out.join(" | ")}`;
}

export function collectMemoryFactHints(memoryFacts = [], maxItems = 5) {
  const rows = Array.isArray(memoryFacts) ? memoryFacts : [];
  const out = [];
  const seen = new Set();
  const cap = Math.max(1, Math.floor(Number(maxItems) || 5));

  for (const row of rows) {
    const value = typeof row === "string" ? row : row?.fact;
    const normalized = String(value || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 140);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= cap) break;
  }

  return out;
}

export function composeReplyImagePrompt(
  imagePrompt,
  replyText,
  maxLen = DEFAULT_MAX_MEDIA_PROMPT_LEN,
  memoryFacts = []
) {
  const context = normalizeMediaPromptContext(replyText);
  return composeMediaPrompt({
    promptText: imagePrompt,
    contextText: context,
    maxLen,
    memoryFacts,
    intro: "Create a vivid image to accompany a Discord chat reply.",
    contextLabel: "Conversational context (do not render as text)",
    fallbackScene: "chat reaction",
    fallbackContext: "chat context",
    styleGuidance: [
      "- Describe a concrete scene with a clear subject, action, and setting.",
      "- Use expressive framing and lighting to sell the mood.",
      "- Pick a visual medium that fits the tone (photo, illustration, 3D render, pixel art, etc.)."
    ],
    hardConstraints: [
      "- No visible text, letters, numbers, logos, subtitles, captions, UI, or watermarks.",
      "- Keep the composition clean with one clear focal point."
    ]
  });
}

export function composeReplyVideoPrompt(
  videoPrompt,
  replyText,
  maxLen = DEFAULT_MAX_MEDIA_PROMPT_LEN,
  memoryFacts = []
) {
  const context = normalizeMediaPromptContext(replyText);
  return composeMediaPrompt({
    promptText: videoPrompt,
    contextText: context,
    maxLen,
    memoryFacts,
    intro: "Create a short, dynamic video clip to accompany a Discord chat reply.",
    contextLabel: "Conversational context (do not render as text)",
    fallbackScene: "chat reaction",
    fallbackContext: "chat context",
    styleGuidance: [
      "- Describe a concrete motion arc: what starts, what changes, how it ends.",
      "- Specify camera behavior (pan, tracking, zoom, static, handheld).",
      "- Include lighting and color palette.",
      "- Keep the action clear in a short social-clip format."
    ],
    hardConstraints: [
      "- No visible text, captions, subtitles, logos, watermarks, or UI overlays.",
      "- Smooth, continuous motion."
    ]
  });
}

export function parseStructuredReplyOutput(rawText, maxLen = DEFAULT_MAX_MEDIA_PROMPT_LEN) {
  const fallbackText = String(rawText || "").trim();
  const parsed = extractJsonObjectFromText(fallbackText);
  if (!parsed) {
    const recoveredText = recoverStructuredReplyText(fallbackText);
    if (recoveredText !== null) {
      return {
        text: recoveredText,
        imagePrompt: null,
        complexImagePrompt: null,
        videoPrompt: null,
        gifQuery: null,
        mediaDirective: null,
        reactionEmoji: null,
        automationAction: emptyStructuredAutomationAction(),

        screenWatchIntent: emptyStructuredScreenShareIntent(),
        parseState: "recovered_json" as ParseState
      };
    }

    return {
      text: "",
      imagePrompt: null,
      complexImagePrompt: null,
      videoPrompt: null,
      gifQuery: null,
      mediaDirective: null,
      reactionEmoji: null,
      automationAction: emptyStructuredAutomationAction(),
      screenWatchIntent: emptyStructuredScreenShareIntent(),
      parseState: "unstructured" as ParseState
    };
  }

  const baseText = normalizeDirectiveMessageText(parsed?.text, MAX_REPLY_TEXT_LEN);
  const skip = parsed?.skip === true;
  const text = skip ? "[SKIP]" : baseText;
  const reactionEmoji = normalizeDirectiveText(parsed?.reactionEmoji, 64) || null;
  const automationAction = normalizeStructuredAutomationAction(parsed?.automationAction);
  const mediaDirective = normalizeStructuredMediaDirective(parsed?.media, maxLen);
  const screenWatchIntent = normalizeStructuredScreenShareIntent(parsed?.screenWatchIntent);

  return {
    text: text || "",
    imagePrompt: mediaDirective?.type === "image_simple" ? mediaDirective.prompt : null,
    complexImagePrompt: mediaDirective?.type === "image_complex" ? mediaDirective.prompt : null,
    videoPrompt: mediaDirective?.type === "video" ? mediaDirective.prompt : null,
    gifQuery: mediaDirective?.type === "gif" ? mediaDirective.prompt : null,
    mediaDirective,
    reactionEmoji,
    automationAction,
    screenWatchIntent,
    parseState: "json" as ParseState
  };
}

export function parseStructuredInitiativeOutput(rawText, maxLen = DEFAULT_MAX_MEDIA_PROMPT_LEN) {
  const fallbackText = String(rawText || "").trim();
  const parsed = extractJsonObjectFromText(fallbackText);
  if (!parsed) {
    return {
      action: "drop",
      skip: true,
      channelId: null,
      replyToMessageId: null,
      text: "",
      mediaDirective: "none",
      mediaPrompt: null,
      reason: "",
      contractViolation: false,
      contractViolationReason: null,
      parseState: "unstructured" as ParseState
    };
  }

  const rawAction = String(
    parsed?.action ??
      (parsed?.skip === true ? "drop" : "post_now")
  )
    .trim()
    .toLowerCase();
  const action = rawAction === "post_now" || rawAction === "hold" || rawAction === "drop"
    ? rawAction
    : "drop";
  const skip = action === "drop";
  const channelId = skip
    ? null
    : normalizeDirectiveText(parsed?.channelId, MAX_INITIATIVE_CHANNEL_ID_LEN) || null;
  const replyToMessageId = skip
    ? null
    : normalizeDirectiveText(parsed?.replyToMessageId, MAX_INITIATIVE_CHANNEL_ID_LEN) || null;
  const text = skip
    ? ""
    : normalizeDirectiveMessageText(parsed?.text, MAX_INITIATIVE_TEXT_LEN) || "";
  const rawMediaDirective = String(parsed?.mediaDirective || "none").trim().toLowerCase();
  const mediaDirective: "none" | "image" | "video" | "gif" =
    rawMediaDirective === "image" || rawMediaDirective === "video" || rawMediaDirective === "gif"
      ? rawMediaDirective
      : "none";
  const mediaPrompt = mediaDirective === "none"
    ? null
    : normalizeDirectiveText(parsed?.mediaPrompt, maxLen) || null;
  const reason = normalizeDirectiveText(parsed?.reason, MAX_INITIATIVE_REASON_LEN) || "";
  const contractViolation =
    action !== "drop" &&
    (!channelId || !text);
  const contractViolationReason = !contractViolation
    ? null
    : !channelId && !text
      ? "missing_channel_id_and_text"
      : !channelId
        ? "missing_channel_id"
        : "missing_text";

  return {
    action,
    skip,
    channelId: skip ? null : channelId,
    replyToMessageId: skip ? null : replyToMessageId,
    text,
    mediaDirective,
    mediaPrompt,
    reason,
    contractViolation,
    contractViolationReason,
    parseState: "json" as ParseState
  };
}

function recoverStructuredReplyText(rawText) {
  const candidate = stripStructuredReplyCodeFence(rawText);
  if (!candidate) return null;
  // Only attempt recovery if the text was structurally trying to be JSON
  // (starts with '{'), not arbitrary prose that happens to contain "text": "..."
  const trimmed = candidate.trimStart();
  if (!trimmed.startsWith("{")) return null;
  if (STRUCTURED_REPLY_SKIP_TRUE_RE.test(candidate)) return "[SKIP]";
  const textMatch = candidate.match(STRUCTURED_REPLY_TEXT_FIELD_RE);
  if (!textMatch) return null;
  const decoded = decodeJsonStringField(textMatch[1]);
  return normalizeDirectiveMessageText(decoded, MAX_REPLY_TEXT_LEN) || null;
}

function stripStructuredReplyCodeFence(rawText) {
  const raw = String(rawText || "").trim();
  if (!raw) return "";
  if (!STRUCTURED_REPLY_CODE_FENCE_OPEN_RE.test(raw)) return raw;
  const withoutOpenFence = raw.replace(STRUCTURED_REPLY_CODE_FENCE_OPEN_RE, "");
  const closingFenceIndex = withoutOpenFence.lastIndexOf("```");
  if (closingFenceIndex < 0) return withoutOpenFence.trim();
  return withoutOpenFence.slice(0, closingFenceIndex).trim();
}

function decodeJsonStringField(rawValue) {
  const encoded = String(rawValue || "");
  if (!encoded) return "";
  try {
    const decoded = JSON.parse(`"${encoded}"`);
    return typeof decoded === "string" ? decoded : encoded;
  } catch {
    return encoded
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, "\"")
      .replace(/\\\\/g, "\\");
  }
}

function normalizeStructuredMediaDirective(rawMedia, maxLen = DEFAULT_MAX_MEDIA_PROMPT_LEN) {
  if (!rawMedia || typeof rawMedia !== "object") return null;
  const rawType = String(rawMedia.type || "")
    .trim()
    .toLowerCase();
  if (!rawType || rawType === "none") return null;
  if (!REPLY_MEDIA_TYPES.has(rawType)) return null;
  if (rawType === "tool_images") {
    return {
      type: rawType,
      prompt: null
    };
  }
  const prompt = normalizeDirectiveText(rawMedia.prompt, rawType === "gif" ? MAX_GIF_QUERY_LEN : maxLen);
  if (!prompt) return null;
  return {
    type: rawType,
    prompt
  };
}

function normalizeStructuredScreenShareIntent(rawIntent) {
  if (!rawIntent || typeof rawIntent !== "object") {
    return {
      action: null,
      confidence: 0,
      reason: null
    };
  }

  const actionLabel = String(rawIntent.action || rawIntent.intent || "")
    .trim()
    .toLowerCase();
  if (!REPLY_SCREEN_SHARE_ACTION_TYPES.has(actionLabel)) {
    return {
      action: null,
      confidence: 0,
      reason: null
    };
  }

  const confidenceRaw = Number(rawIntent.confidence);
  const confidence = Number.isFinite(confidenceRaw) ? clamp(confidenceRaw, 0, 1) : 0;
  const reason = normalizeDirectiveText(rawIntent.reason, MAX_SCREEN_SHARE_REASON_LEN) || null;

  return {
    action: actionLabel === "none" ? null : actionLabel,
    confidence,
    reason
  };
}

function normalizeStructuredAutomationAction(rawAction) {
  const empty = {
    operation: null,
    title: null,
    instruction: null,
    schedule: null,
    targetQuery: null,
    automationId: null,
    runImmediately: false,
    targetChannelId: null
  };
  if (!rawAction || typeof rawAction !== "object") return empty;

  const operation = normalizeAutomationOperation(rawAction.operation ?? rawAction.op);
  if (!operation || operation === "none") return empty;

  const automationIdRaw = Number(rawAction.automationId ?? rawAction.id);
  const automationId = Number.isInteger(automationIdRaw) && automationIdRaw > 0 ? automationIdRaw : null;
  const targetQuery = normalizeDirectiveText(
    rawAction.targetQuery ?? rawAction.query ?? rawAction.target,
    MAX_AUTOMATION_TARGET_QUERY_LEN
  );
  const targetChannelId = normalizeDirectiveText(rawAction.targetChannelId ?? rawAction.channelId, 40);
  const runImmediately = rawAction.runImmediately === true;

  if (operation === "create") {
    const title = normalizeDirectiveText(rawAction.title, MAX_AUTOMATION_TITLE_LEN) || null;
    const instruction =
      normalizeDirectiveText(rawAction.instruction ?? rawAction.task ?? rawAction.prompt, MAX_AUTOMATION_INSTRUCTION_LEN) ||
      null;
    const schedule = normalizeAutomationSchedule(rawAction.schedule, {
      nowMs: Date.now(),
      allowPastOnce: false
    });

    if (!instruction || !schedule) return empty;

    return {
      operation,
      title,
      instruction,
      schedule,
      targetQuery: targetQuery || null,
      automationId: null,
      runImmediately,
      targetChannelId: targetChannelId || null
    };
  }

  return {
    operation,
    title: null,
    instruction: null,
    schedule: null,
    targetQuery: targetQuery || null,
    automationId,
    runImmediately: false,
    targetChannelId: targetChannelId || null
  };
}

function normalizeAutomationOperation(rawValue) {
  const normalized = String(rawValue || "")
    .trim()
    .toLowerCase();
  if (!normalized) return "none";
  if (normalized === "stop" || normalized === "disable") return "pause";
  if (normalized === "start" || normalized === "enable" || normalized === "unpause") return "resume";
  if (normalized === "remove" || normalized === "cancel") return "delete";
  if (!REPLY_AUTOMATION_OPERATION_TYPES.has(normalized)) return "none";
  return normalized;
}

export function pickReplyMediaDirective(parsed) {
  return parsed?.mediaDirective || null;
}

export function normalizeDirectiveText(text, maxLen) {
  return normalizeWhitespaceText(text, { maxLen });
}

export function normalizeDirectiveMessageText(text, maxLen) {
  let normalized = String(text || "").replace(/\r\n?/g, "\n");
  normalized = normalized
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const maxCandidate = Number(maxLen);
  if (!Number.isFinite(maxCandidate)) return normalized;
  const boundedMax = Math.max(0, Math.floor(maxCandidate));
  if (!boundedMax || normalized.length <= boundedMax) return normalized;
  return normalized.slice(0, boundedMax).trimEnd();
}

export function serializeForPrompt(value, maxLen = 1200) {
  try {
    return String(JSON.stringify(value ?? {}, null, 2)).slice(0, Math.max(40, Number(maxLen) || 1200));
  } catch {
    return "{}";
  }
}

export function isWebSearchOptOutText(rawText) {
  return EN_WEB_SEARCH_OPTOUT_RE.test(String(rawText || ""));
}

const DISCORD_MSG_SPLIT_LIMIT = 1900;

export function splitDiscordMessage(text, maxLen = DISCORD_MSG_SPLIT_LIMIT) {
  if (!text || text.length <= maxLen) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let idx = remaining.lastIndexOf("\n\n", maxLen);
    if (idx <= 0) idx = remaining.lastIndexOf(". ", maxLen);
    if (idx > 0 && remaining[idx] === ".") idx += 1;
    if (idx <= 0) idx = remaining.lastIndexOf("\n", maxLen);
    if (idx <= 0) idx = remaining.lastIndexOf(" ", maxLen);
    if (idx <= 0) idx = maxLen;
    chunks.push(remaining.slice(0, idx).trimEnd());
    remaining = remaining.slice(idx).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export function normalizeReactionEmojiToken(emojiToken) {
  const token = String(emojiToken || "").trim();
  const custom = token.match(/^<a?:([^:>]+):(\d+)>$/);
  if (custom) {
    return `${custom[1]}:${custom[2]}`;
  }
  return token;
}

export function embedWebSearchSources(text, webSearch) {
  const base = String(text || "").trim();
  if (!base) return "";
  if (!webSearch?.used) return base;

  const results = Array.isArray(webSearch?.results) ? webSearch.results : [];
  if (!results.length) return base;

  const textWithPlainCitations = base.replace(/\[(\d{1,2})\]\(\s*<?https?:\/\/[^)\s>]+[^)]*\)/g, "[$1]");
  const citedIndices = [...new Set(
    [...textWithPlainCitations.matchAll(/\[(\d{1,2})\]/g)]
      .map((match) => Number(match[1]) - 1)
      .filter((index) => Number.isInteger(index) && index >= 0 && index < results.length)
  )].sort((a, b) => a - b);

  if (!citedIndices.length) return textWithPlainCitations;

  const urlLines = [];
  const domainLines = [];
  for (const index of citedIndices) {
    const row = results[index];
    const url = String(row?.url || "").trim();
    if (!url) continue;
    const domain = String(row?.domain || extractDomainForSourceLabel(url) || "source");
    urlLines.push(`[${index + 1}] ${domain} - <${url}>`);
    domainLines.push(`[${index + 1}] ${domain}`);
  }
  if (!urlLines.length) return textWithPlainCitations;

  const inlineLinked = textWithPlainCitations.replace(/\[(\d{1,2})\]/g, (full, rawIndex) => {
    const index = Number(rawIndex) - 1;
    const row = results[index];
    const url = String(row?.url || "").trim();
    if (!url) return full;
    return `[${index + 1}](<${url}>)`;
  });

  const MAX_CONTENT_LEN = 1900;
  const withUrls = `${inlineLinked}\n\nSources:\n${urlLines.join("\n")}`;
  if (withUrls.length <= MAX_CONTENT_LEN) return withUrls;

  const withDomains = `${inlineLinked}\n\nSources:\n${domainLines.join("\n")}`;
  if (withDomains.length <= MAX_CONTENT_LEN) return withDomains;

  const plainWithUrls = `${textWithPlainCitations}\n\nSources:\n${urlLines.join("\n")}`;
  if (plainWithUrls.length <= MAX_CONTENT_LEN) return plainWithUrls;

  const plainWithDomains = `${textWithPlainCitations}\n\nSources:\n${domainLines.join("\n")}`;
  if (plainWithDomains.length <= MAX_CONTENT_LEN) return plainWithDomains;

  return textWithPlainCitations;
}

export function normalizeSkipSentinel(text) {
  const value = String(text || "").trim();
  if (!value) return "";
  if (/^\[SKIP\]$/i.test(value)) return "[SKIP]";

  const withoutTrailingSkip = value.replace(/\s*\[SKIP\]\s*$/i, "").trim();
  return withoutTrailingSkip || "[SKIP]";
}

function extractDomainForSourceLabel(rawUrl) {
  try {
    return new URL(String(rawUrl || "")).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}
