import {
  emptyPromptMemorySlice,
  normalizePromptMemorySlice
} from "../memory/promptMemorySlice.ts";
import { getMemorySettings } from "../settings/agentStack.ts";
import {
  CONVERSATION_HISTORY_PROMPT_LIMIT,
  CONVERSATION_HISTORY_PROMPT_MAX_AGE_HOURS,
  LOOKUP_CONTEXT_PROMPT_LIMIT,
  LOOKUP_CONTEXT_PROMPT_MAX_AGE_HOURS
} from "./replyPipelineShared.ts";

export type ConversationContinuityPayload = {
  settings: Record<string, unknown>;
  guildId?: string | null;
  channelId?: string | null;
  userId?: string | null;
  queryText?: string;
  source?: string;
  trace?: Record<string, unknown>;
};

type ContinuityLoaderArgs = {
  settings: Record<string, unknown>;
  guildId?: string | null;
  channelId?: string | null;
  userId?: string | null;
  queryText?: string;
  source?: string;
  trace?: Record<string, unknown>;
  recentMessages?: Array<Record<string, unknown>>;
  memoryTimeoutMs?: number;
  loadPromptMemorySlice?: ((payload: ConversationContinuityPayload) => Promise<unknown>) | null;
  loadRecentLookupContext?: ((payload: Record<string, unknown>) => unknown) | null;
  loadRecentConversationHistory?: ((payload: Record<string, unknown>) => unknown) | null;
  loadAdaptiveDirectives?: ((payload: Record<string, unknown>) => unknown) | null;
};

function normalizeQueryText(value: unknown, maxChars = 420) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}

function isMemoryEnabled(settings: Record<string, unknown>) {
  return Boolean(getMemorySettings(settings).enabled);
}

async function resolvePromptMemorySlice({
  settings,
  guildId,
  channelId,
  userId,
  queryText,
  source,
  trace,
  loadPromptMemorySlice,
  memoryTimeoutMs = 0
}: {
  settings: Record<string, unknown>;
  guildId: string;
  channelId: string | null;
  userId: string | null;
  queryText: string;
  source: string;
  trace: Record<string, unknown>;
  loadPromptMemorySlice?: ((payload: Record<string, unknown>) => Promise<unknown>) | null;
  memoryTimeoutMs?: number;
}) {
  const empty = emptyPromptMemorySlice();
  if (!isMemoryEnabled(settings)) return empty;
  if (!guildId || !userId || !queryText || typeof loadPromptMemorySlice !== "function") {
    return empty;
  }

  const slicePromise = loadPromptMemorySlice({
    settings,
    userId,
    guildId,
    channelId,
    queryText,
    trace,
    source
  })
    .then((slice) => normalizePromptMemorySlice(slice))
    .catch(() => empty);

  const boundedTimeoutMs = Math.max(0, Math.floor(Number(memoryTimeoutMs) || 0));
  if (!boundedTimeoutMs) {
    return await slicePromise;
  }

  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      slicePromise,
      new Promise<ReturnType<typeof emptyPromptMemorySlice>>((resolve) => {
        timeoutHandle = setTimeout(() => resolve(empty), boundedTimeoutMs);
      })
    ]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

export function filterConversationWindowsAgainstRecentMessages(
  windows: unknown,
  recentMessages: Array<Record<string, unknown>> = []
) {
  const normalizedWindows = Array.isArray(windows) ? windows : [];
  if (!normalizedWindows.length) return [];
  const recentMessageIds = new Set(
    (Array.isArray(recentMessages) ? recentMessages : [])
      .map((row) => String(row?.message_id || "").trim())
      .filter(Boolean)
  );
  if (!recentMessageIds.size) return normalizedWindows;

  return normalizedWindows.filter((window) => {
    const windowRecord =
      window && typeof window === "object" && !Array.isArray(window)
        ? window as { messages?: Array<Record<string, unknown>> }
        : null;
    const windowMessageIds = (Array.isArray(windowRecord?.messages) ? windowRecord.messages : [])
      .map((row) => String(row?.message_id || "").trim())
      .filter(Boolean);
    if (!windowMessageIds.length) return false;
    return windowMessageIds.some((messageId) => !recentMessageIds.has(messageId));
  });
}

export async function loadConversationContinuityContext({
  settings,
  guildId = null,
  channelId = null,
  userId = null,
  queryText = "",
  source = "conversation_continuity",
  trace = {},
  recentMessages = [],
  memoryTimeoutMs = 0,
  loadPromptMemorySlice = null,
  loadRecentLookupContext = null,
  loadRecentConversationHistory = null,
  loadAdaptiveDirectives = null
}: ContinuityLoaderArgs) {
  const normalizedGuildId = String(guildId || "").trim();
  const normalizedChannelId = String(channelId || "").trim() || null;
  const normalizedUserId = String(userId || "").trim() || null;
  const normalizedQueryText = normalizeQueryText(queryText);
  const normalizedSource = String(source || "conversation_continuity").trim() || "conversation_continuity";
  const normalizedTrace =
    trace && typeof trace === "object"
      ? trace
      : {};

  const memorySlice = await resolvePromptMemorySlice({
    settings,
    guildId: normalizedGuildId,
    channelId: normalizedChannelId,
    userId: normalizedUserId,
    queryText: normalizedQueryText,
    source: normalizedSource,
    trace: normalizedTrace,
    loadPromptMemorySlice,
    memoryTimeoutMs
  });

  const recentWebLookupsRaw =
    normalizedGuildId &&
    normalizedQueryText &&
    typeof loadRecentLookupContext === "function"
      ? loadRecentLookupContext({
        guildId: normalizedGuildId,
        channelId: normalizedChannelId,
        queryText: normalizedQueryText,
        limit: LOOKUP_CONTEXT_PROMPT_LIMIT,
        maxAgeHours: LOOKUP_CONTEXT_PROMPT_MAX_AGE_HOURS
      })
      : [];
  const recentWebLookups = Array.isArray(recentWebLookupsRaw)
    ? recentWebLookupsRaw
    : [];

  const recentConversationHistoryRaw =
    normalizedGuildId &&
    normalizedQueryText &&
    typeof loadRecentConversationHistory === "function"
      ? loadRecentConversationHistory({
        guildId: normalizedGuildId,
        channelId: normalizedChannelId,
        queryText: normalizedQueryText,
        limit: CONVERSATION_HISTORY_PROMPT_LIMIT,
        maxAgeHours: CONVERSATION_HISTORY_PROMPT_MAX_AGE_HOURS
      })
      : [];
  const recentConversationHistory = filterConversationWindowsAgainstRecentMessages(
    recentConversationHistoryRaw,
    recentMessages
  );
  const adaptiveDirectivesRaw =
    normalizedGuildId &&
    typeof loadAdaptiveDirectives === "function"
      ? loadAdaptiveDirectives({
        guildId: normalizedGuildId,
        queryText: normalizedQueryText
      })
      : [];
  const adaptiveDirectives = Array.isArray(adaptiveDirectivesRaw)
    ? adaptiveDirectivesRaw
    : [];

  return {
    memorySlice,
    recentWebLookups,
    recentConversationHistory,
    adaptiveDirectives
  };
}
