import { normalizeBoundedStringList } from "../settings/listNormalization.ts";
import { getBotName, getPersonaSettings, getPromptingSettings } from "../settings/agentStack.ts";
import { clamp } from "../utils.ts";

const DEFAULT_BOT_NAME = "clanker conk";
const PROMPT_TEMPLATE_TOKEN_RE = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;
export const DEFAULT_PROMPT_STYLE = "playful slang, open, honest, exploratory";
export const DEFAULT_PROMPT_TEXT_GUIDANCE = [
  "Write like a person in chat, not like an assistant.",
  "Be open and direct; avoid roleplaying or performative banter.",
  "If you don't know something, just say so. Ask questions when you're genuinely curious.",
  "Default to short messages but go longer when the conversation calls for it.",
  "Use server emoji tokens in text only when necessary and when they enhance the message."
];
export const DEFAULT_PROMPT_VOICE_GUIDANCE = [
  "Talk like a person hanging out, not like an assistant.",
  "Be open, direct, and helpful whenever it makes sense.",
  "Ask questions when you're curious or when it keeps the conversation moving."
];
export const DEFAULT_PROMPT_VOICE_OPERATIONAL_GUIDANCE = [
  "Keep it clear and simple. No overexplaining.",
  "Clearly state what happened and why, especially when a request is blocked.",
  "If relevant, mention required permissions/settings plainly.",
  "Avoid dramatic wording, blame, apology spirals, and long postmortems."
];

const PROMPT_CAPABILITY_HONESTY_LINE = "Never claim capabilities you do not have.";
export const DEFAULT_PROMPT_IMPOSSIBLE_ACTION_LINE =
  "If asked to do something impossible, say it plainly and suggest a practical text-only alternative.";
const DEFAULT_MEMORY_ENABLED_LINE =
  "You have persistent memory across conversations via saved durable facts and logs. Do not claim each conversation starts from zero.";
const DEFAULT_MEMORY_DISABLED_LINE =
  "Persistent memory is disabled right now. Do not claim long-term memory across separate conversations.";
const DEFAULT_SKIP_LINE = "If you should not send a message, output exactly [SKIP].";
const DEFAULT_MEDIA_PROMPT_CRAFT_GUIDANCE = [
  "Write media prompts as vivid scene descriptions, not abstract concepts.",
  "Include: subject/action, visual style or medium (photo, illustration, 3D render, pixel art, etc.), lighting/mood, camera angle or framing, and color palette when relevant.",
  "Be specific: 'a golden retriever leaping through autumn leaves, warm backlit sunset, low angle, film grain' beats 'a dog outside'.",
  "For video prompts, describe the motion arc: what starts, what changes, and how it ends.",
  "Never put text, words, or UI elements in media prompts."
].join(" ");
export function interpolatePromptTemplate(template, variables = {}) {
  const input = String(template || "");
  if (!input) return "";
  const normalizedVariables = normalizeTemplateVariables(variables);

  return input.replace(PROMPT_TEMPLATE_TOKEN_RE, (match, key) => {
    const normalizedKey = String(key || "")
      .trim()
      .toLowerCase();
    if (!normalizedKey || !Object.prototype.hasOwnProperty.call(normalizedVariables, normalizedKey)) {
      return match;
    }
    return normalizedVariables[normalizedKey];
  });
}

export function getPromptBotName(settings, fallback = DEFAULT_BOT_NAME) {
  const configured = getBotName(settings).trim();
  return configured || String(fallback || DEFAULT_BOT_NAME);
}

export function getPromptStyle(settings, fallback = DEFAULT_PROMPT_STYLE) {
  const configured = String(getPersonaSettings(settings).flavor || "").trim();
  const resolved = configured || String(fallback || DEFAULT_PROMPT_STYLE);
  return interpolatePromptTemplate(resolved, {
    botName: getPromptBotName(settings)
  });
}

export function getPromptCapabilityHonestyLine(settings, fallback = PROMPT_CAPABILITY_HONESTY_LINE) {
  const raw = getPromptingSettings(settings).global.capabilityHonestyLine;
  if (typeof raw === "string" && raw.trim() === "") return "";
  const resolved = String(raw || "").trim() || String(fallback || PROMPT_CAPABILITY_HONESTY_LINE);
  return interpolatePromptTemplate(resolved, {
    botName: getPromptBotName(settings)
  });
}

export function getPromptImpossibleActionLine(settings, fallback = DEFAULT_PROMPT_IMPOSSIBLE_ACTION_LINE) {
  const raw = getPromptingSettings(settings).global.impossibleActionLine;
  if (typeof raw === "string" && raw.trim() === "") return "";
  const resolved = String(raw || "").trim() || String(fallback || DEFAULT_PROMPT_IMPOSSIBLE_ACTION_LINE);
  return interpolatePromptTemplate(resolved, {
    botName: getPromptBotName(settings)
  });
}

export function getPromptMemoryEnabledLine(settings, fallback = DEFAULT_MEMORY_ENABLED_LINE) {
  const raw = getPromptingSettings(settings).global.memoryEnabledLine;
  if (typeof raw === "string" && raw.trim() === "") return "";
  const resolved = String(raw || "").trim() || String(fallback || DEFAULT_MEMORY_ENABLED_LINE);
  return interpolatePromptTemplate(resolved, {
    botName: getPromptBotName(settings)
  });
}

export function getPromptMemoryDisabledLine(settings, fallback = DEFAULT_MEMORY_DISABLED_LINE) {
  const raw = getPromptingSettings(settings).global.memoryDisabledLine;
  if (typeof raw === "string" && raw.trim() === "") return "";
  const resolved = String(raw || "").trim() || String(fallback || DEFAULT_MEMORY_DISABLED_LINE);
  return interpolatePromptTemplate(resolved, {
    botName: getPromptBotName(settings)
  });
}

export function getPromptSkipLine(settings, fallback = DEFAULT_SKIP_LINE) {
  const raw = getPromptingSettings(settings).global.skipLine;
  if (typeof raw === "string" && raw.trim() === "") return "";
  const resolved = String(raw || "").trim() || String(fallback || DEFAULT_SKIP_LINE);
  return interpolatePromptTemplate(resolved, {
    botName: getPromptBotName(settings)
  });
}

export function getPromptTextGuidance(settings, fallback = []) {
  const botName = getPromptBotName(settings);
  return normalizePromptLineList(getPromptingSettings(settings).text.guidance, fallback).map((line) =>
    interpolatePromptTemplate(line, { botName })
  );
}

export function getPromptVoiceGuidance(settings, fallback = []) {
  const botName = getPromptBotName(settings);
  return normalizePromptLineList(getPromptingSettings(settings).voice.guidance, fallback).map((line) =>
    interpolatePromptTemplate(line, { botName })
  );
}

export function getPromptVoiceOperationalGuidance(settings, fallback = []) {
  const botName = getPromptBotName(settings);
  return normalizePromptLineList(getPromptingSettings(settings).voice.operationalGuidance, fallback).map((line) =>
    interpolatePromptTemplate(line, { botName })
  );
}

export function getMediaPromptCraftGuidance(settings, fallback = DEFAULT_MEDIA_PROMPT_CRAFT_GUIDANCE) {
  const configured = String(getPromptingSettings(settings).media.promptCraftGuidance || "").trim();
  const resolved = configured || String(fallback || DEFAULT_MEDIA_PROMPT_CRAFT_GUIDANCE);
  return interpolatePromptTemplate(resolved, {
    botName: getPromptBotName(settings)
  });
}

function getPromptHardLimits(settings, { maxItems = null } = {}) {
  const botName = getPromptBotName(settings);
  const source = Array.isArray(getPersonaSettings(settings).hardLimits)
    ? getPersonaSettings(settings).hardLimits
    : [];
  const limits = source
    .map((line) => String(line || "").trim())
    .filter(Boolean)
    .map((line) => interpolatePromptTemplate(line, { botName }));
  if (!Number.isFinite(Number(maxItems))) return limits;
  const count = Math.max(0, Math.floor(Number(maxItems)));
  return limits.slice(0, count);
}

export function buildHardLimitsSection(settings, { maxItems = null } = {}) {
  const limits = getPromptHardLimits(settings, { maxItems });
  if (!limits.length) return [];
  return [
    "Hard limitations:",
    ...limits.map((line) => `- ${line}`)
  ];
}

function normalizeVoiceParticipantRoster(participantRoster, maxItems = 12) {
  const limit = Number.isFinite(Number(maxItems)) ? Math.max(0, Math.floor(Number(maxItems))) : 12;
  return (Array.isArray(participantRoster) ? participantRoster : [])
    .map((entry) => {
      if (typeof entry === "string") return String(entry).trim();
      return String(entry?.displayName || entry?.name || "").trim();
    })
    .filter(Boolean)
    .slice(0, limit);
}

export function buildVoiceSelfContextLines({
  voiceEnabled = false,
  inVoiceChannel = false,
  participantRoster = []
} = {}) {
  if (!voiceEnabled) {
    return ["Voice mode is disabled right now."];
  }

  const lines = [
    "Voice mode is enabled right now.",
    "Do not claim you are text-only or unable to join voice channels."
  ];
  if (!inVoiceChannel) {
    lines.push("You are currently not in VC.");
    return lines;
  }

  lines.push("You are currently in VC right now.");
  const participants = normalizeVoiceParticipantRoster(participantRoster, 12);
  if (participants.length) {
    lines.push(`Humans currently in channel: ${participants.join(", ")}.`);
  }
  lines.push("You do have member-list context for this VC; do not claim you can't see who is in channel.");
  lines.push("Continuity rule: while in VC, do not claim you are outside VC.");
  return lines;
}

export function buildVoiceToneGuardrails() {
  return [
    "Match your normal text-chat persona in voice: same directness, honesty, and exploratory mindset.",
    "Keep turns tight: one clear idea, usually one short sentence.",
    "Use a second short sentence only when needed for clarity or when asked for detail.",
    "In voice, avoid chat-only shorthand acronyms (for example lmao, fr, ngl); use natural spoken phrasing instead.",
    "Avoid assistant-like preambles, disclaimers, and over-explaining.",
    "Avoid bullet lists and rigid formatting unless someone explicitly asks for structured steps."
  ];
}

export function buildVoiceSoundboardGuidanceLines(eagerness: unknown) {
  const normalizedEagerness = Math.round(clamp(Number(eagerness) || 0, 0, 100));
  const lines = [`Discord soundboard tendency: ${normalizedEagerness}/100.`];

  if (normalizedEagerness <= 10) {
    lines.push(
      "Stay extremely restrained with Discord sound effects. Prefer spoken reactions unless someone directly asks for a sound or a single obvious sting is too perfect to ignore."
    );
  } else if (normalizedEagerness <= 35) {
    lines.push(
      "Stay conservative with Discord sound effects. Use them only when a quick reaction sting is an especially clean fit."
    );
  } else if (normalizedEagerness <= 70) {
    lines.push(
      "You can occasionally use Discord sound effects as humorous punctuation or reaction beats when the timing is clean."
    );
  } else if (normalizedEagerness <= 90) {
    lines.push(
      "You can lean into playful soundboard bits and comedic punctuation when they genuinely make the moment funnier, but keep it intentional."
    );
  } else {
    lines.push(
      "You can be very willing to use Discord sound effects as part of the bit when the timing is sharp, while still avoiding spam or random noise."
    );
  }

  return {
    eagerness: normalizedEagerness,
    lines
  };
}

function normalizePromptLineList(source, fallback = []) {
  const list = Array.isArray(source) ? source : Array.isArray(fallback) ? fallback : [];
  return normalizeBoundedStringList(list, {
    maxItems: Number.MAX_SAFE_INTEGER,
    maxLen: Number.MAX_SAFE_INTEGER
  });
}

function normalizeTemplateVariables(variables = {}) {
  const out = Object.create(null);
  if (!variables || typeof variables !== "object") return out;
  for (const [rawKey, rawValue] of Object.entries(variables)) {
    const key = String(rawKey || "")
      .trim()
      .toLowerCase();
    if (!key) continue;
    out[key] = String(rawValue || "");
  }
  return out;
}

export const REPLY_JSON_SCHEMA = `{
  "text": "reply text or [SKIP]",
  "skip": false,
  "reactionEmoji": "emoji or null",
  "media": "media object or null",
  "webSearchQuery": "string or null",
  "browserBrowseQuery": "string or null",
  "memoryLookupQuery": "string or null",
  "imageLookupQuery": "string or null",
  "openArticleRef": "string or null",
  "soundboardRefs": [],
  "leaveVoiceChannel": false,
  "automationAction": {
    "operation": "none|create|pause|resume|delete|list",
    "title": "string or null",
    "instruction": "string or null",
    "schedule": "schedule object or null",
    "targetQuery": "string or null",
    "automationId": "string or null",
    "runImmediately": false,
    "targetChannelId": "string or null"
  },
  "screenShareIntent": {
    "action": "offer_link|none",
    "confidence": 0,
    "reason": "string or null"
  }
}`;
