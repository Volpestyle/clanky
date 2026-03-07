import {
  executeSharedMemoryToolSearch,
  executeSharedMemoryToolWrite
} from "../memory/memoryToolRuntime.ts";
import { clamp } from "../utils.ts";
import { MEMORY_SENSITIVE_PATTERN_RE, VOICE_MEMORY_WRITE_MAX_PER_MINUTE } from "./voiceSessionManager.constants.ts";
import { normalizeInlineText } from "./voiceSessionHelpers.ts";
import { ensureSessionToolRuntimeState } from "./voiceToolCallToolRegistry.ts";
import type { VoiceRealtimeToolSettings, VoiceSession, VoiceToolRuntimeSessionLike } from "./voiceSessionTypes.ts";
import type { VoiceToolCallArgs, VoiceToolCallManager } from "./voiceToolCallTypes.ts";

type ToolRuntimeSession = VoiceSession | VoiceToolRuntimeSessionLike;

type VoiceMemoryToolOptions = {
  session?: ToolRuntimeSession | null;
  settings?: VoiceRealtimeToolSettings | null;
  args?: VoiceToolCallArgs;
};

type VoiceConversationSearchToolOptions = {
  session?: ToolRuntimeSession | null;
  args?: VoiceToolCallArgs;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export async function executeVoiceMemorySearchTool(
  manager: VoiceToolCallManager,
  { session, settings, args }: VoiceMemoryToolOptions
) {
  const filters = asRecord(args?.filters);
  if (!manager.memory || typeof manager.memory.searchDurableFacts !== "function") {
    return { ok: false, matches: [], error: "memory_unavailable" };
  }
  return executeSharedMemoryToolSearch({
    runtime: { memory: manager.memory },
    settings,
    guildId: String(session?.guildId || "").trim(),
    channelId: session?.textChannelId || null,
    actorUserId: session?.lastOpenAiToolCallerUserId || null,
    namespace: args?.namespace,
    queryText: normalizeInlineText(args?.query, 240),
    trace: {
      guildId: session?.guildId || null,
      channelId: session?.textChannelId || null,
      userId: session?.lastOpenAiToolCallerUserId || null,
      source: "voice_realtime_tool_memory_search"
    },
    limit: clamp(Math.floor(Number(args?.top_k || 6)), 1, 20),
    tags: Array.isArray(filters?.tags)
      ? filters.tags.map((entry) => normalizeInlineText(entry, 40)).filter(Boolean)
      : []
  });
}

export async function executeVoiceConversationSearchTool(
  manager: VoiceToolCallManager,
  { session, args }: VoiceConversationSearchToolOptions
) {
  if (!manager.store || typeof manager.store.searchConversationWindows !== "function") {
    return { ok: false, matches: [], error: "conversation_history_unavailable" };
  }
  const query = normalizeInlineText(args?.query, 220);
  if (!query) {
    return { ok: false, matches: [], error: "query_required" };
  }

  const scope = String(args?.scope || "channel").trim().toLowerCase();
  const matches = manager.store.searchConversationWindows({
    guildId: String(session?.guildId || "").trim(),
    channelId: scope === "guild" ? null : session?.textChannelId || null,
    queryText: query,
    limit: clamp(Math.floor(Number(args?.top_k || 3)), 1, 4),
    maxAgeHours: clamp(Math.floor(Number(args?.max_age_hours || 24 * 7)), 1, 24 * 30),
    before: 1,
    after: 1
  });

  return { ok: true, matches: Array.isArray(matches) ? matches : [] };
}

export async function executeVoiceMemoryWriteTool(
  manager: VoiceToolCallManager,
  { session, settings, args }: VoiceMemoryToolOptions
) {
  const dedupe = asRecord(args?.dedupe);
  if (
    !manager.memory ||
    typeof manager.memory.searchDurableFacts !== "function" ||
    typeof manager.memory.rememberDirectiveLineDetailed !== "function"
  ) {
    return { ok: false, written: [], skipped: [], error: "memory_unavailable" };
  }

  const runtimeSession = ensureSessionToolRuntimeState(manager, session);
  if (!runtimeSession) {
    return { ok: false, written: [], skipped: [], error: "session_unavailable" };
  }

  const now = Date.now();
  const recentWindow = (Array.isArray(runtimeSession.memoryWriteWindow) ? runtimeSession.memoryWriteWindow : [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && now - value <= 60_000);
  runtimeSession.memoryWriteWindow = recentWindow;

  const remainingWriteCapacity = Math.max(0, VOICE_MEMORY_WRITE_MAX_PER_MINUTE - recentWindow.length);
  if (remainingWriteCapacity <= 0) {
    return { ok: false, written: [], skipped: [], error: "write_rate_limited" };
  }

  const result = await executeSharedMemoryToolWrite({
    runtime: { memory: manager.memory },
    settings,
    guildId: String(session?.guildId || "").trim(),
    channelId: session?.textChannelId || null,
    actorUserId: session?.lastOpenAiToolCallerUserId || null,
    namespace: args?.namespace,
    items: Array.isArray(args?.items) ? args.items : [],
    trace: {
      guildId: session?.guildId || null,
      channelId: session?.textChannelId || null,
      userId: session?.lastOpenAiToolCallerUserId || null,
      source: "voice_realtime_tool_memory_write"
    },
    sourceMessageIdPrefix: `voice-tool-${String(session?.id || "session")}`,
    sourceText: "",
    limit: remainingWriteCapacity,
    dedupeThreshold: clamp(Number(dedupe?.threshold), 0, 1) || 0.9,
    sensitivePattern: MEMORY_SENSITIVE_PATTERN_RE
  });

  if (result.ok && result.written.length > 0) {
    for (let i = 0; i < result.written.length; i += 1) {
      runtimeSession.memoryWriteWindow.push(now);
    }
    runtimeSession.memoryWriteWindow = runtimeSession.memoryWriteWindow
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && now - value <= 60_000);
  }

  return result;
}
