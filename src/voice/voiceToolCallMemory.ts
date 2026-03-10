import {
  executeSharedMemoryToolSearch,
  executeSharedMemoryToolWrite
} from "../memory/memoryToolRuntime.ts";
import { clamp } from "../utils.ts";
import { MEMORY_SENSITIVE_PATTERN_RE, VOICE_MEMORY_WRITE_MAX_PER_MINUTE } from "./voiceSessionManager.constants.ts";
import { normalizeInlineText } from "./voiceSessionHelpers.ts";
import { ensureSessionToolRuntimeState } from "./voiceToolCallToolRegistry.ts";
import { throwIfAborted } from "../tools/browserTaskRuntime.ts";
import type { VoiceRealtimeToolSettings, VoiceSession, VoiceToolRuntimeSessionLike } from "./voiceSessionTypes.ts";
import type { VoiceToolCallArgs, VoiceToolCallManager } from "./voiceToolCallTypes.ts";

const SELF_SUBJECT = "__self__";
const LORE_SUBJECT = "__lore__";

type ToolRuntimeSession = VoiceSession | VoiceToolRuntimeSessionLike;

type VoiceMemoryToolOptions = {
  session?: ToolRuntimeSession | null;
  settings?: VoiceRealtimeToolSettings | null;
  args?: VoiceToolCallArgs;
  signal?: AbortSignal;
};

type VoiceConversationSearchToolOptions = {
  session?: ToolRuntimeSession | null;
  args?: VoiceToolCallArgs;
  signal?: AbortSignal;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export async function executeVoiceMemorySearchTool(
  manager: VoiceToolCallManager,
  { session, settings, args, signal }: VoiceMemoryToolOptions
) {
  throwIfAborted(signal, "Voice memory search cancelled");
  const filters = asRecord(args?.filters);
  if (!manager.memory || typeof manager.memory.searchDurableFacts !== "function") {
    return { ok: false, matches: [], error: "memory_unavailable" };
  }
  return executeSharedMemoryToolSearch({
    runtime: { memory: manager.memory },
    settings,
    guildId: String(session?.guildId || "").trim(),
    channelId: session?.textChannelId || null,
    actorUserId: session?.lastRealtimeToolCallerUserId || null,
    namespace: args?.namespace,
    queryText: normalizeInlineText(args?.query, 240),
    trace: {
      guildId: session?.guildId || null,
      channelId: session?.textChannelId || null,
      userId: session?.lastRealtimeToolCallerUserId || null,
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
  { session, args, signal }: VoiceConversationSearchToolOptions
) {
  throwIfAborted(signal, "Voice conversation search cancelled");
  if (
    (!manager.store || typeof manager.store.searchConversationWindows !== "function") &&
    typeof manager.memory?.searchConversationHistory !== "function"
  ) {
    return { ok: false, matches: [], error: "conversation_history_unavailable" };
  }
  const query = normalizeInlineText(args?.query, 220);
  if (!query) {
    return { ok: false, matches: [], error: "query_required" };
  }

  const scope = String(args?.scope || "channel").trim().toLowerCase();
  const matches = typeof manager.memory?.searchConversationHistory === "function"
    ? await manager.memory.searchConversationHistory({
      guildId: String(session?.guildId || "").trim(),
      channelId: scope === "guild" ? null : session?.textChannelId || null,
      queryText: query,
      settings: session?.settingsSnapshot || manager.store.getSettings?.() || {},
      trace: {
        guildId: session?.guildId || null,
        channelId: scope === "guild" ? null : session?.textChannelId || null,
        userId: session?.lastRealtimeToolCallerUserId || null,
        source: "voice_realtime_tool_conversation_search"
      },
      limit: clamp(Math.floor(Number(args?.top_k || 3)), 1, 4),
      maxAgeHours: clamp(Math.floor(Number(args?.max_age_hours || 24 * 7)), 1, 24 * 30),
      before: 1,
      after: 1
    })
    : manager.store.searchConversationWindows({
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
  { session, settings, args, signal }: VoiceMemoryToolOptions
) {
  throwIfAborted(signal, "Voice memory write cancelled");
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
    actorUserId: session?.lastRealtimeToolCallerUserId || null,
    namespace: args?.namespace,
    items: Array.isArray(args?.items) ? args.items : [],
    trace: {
      guildId: session?.guildId || null,
      channelId: session?.textChannelId || null,
      userId: session?.lastRealtimeToolCallerUserId || null,
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

    const writtenSubjects = new Set(
      result.written
        .map((entry) => String(entry?.subject || "").trim())
        .filter(Boolean)
    );
    if (writtenSubjects.has(SELF_SUBJECT) || writtenSubjects.has(LORE_SUBJECT)) {
      manager.refreshSessionGuildFactProfile?.(runtimeSession as VoiceSession);
    }
    for (const subject of writtenSubjects) {
      if (subject === SELF_SUBJECT || subject === LORE_SUBJECT) continue;
      manager.refreshSessionUserFactProfile?.(runtimeSession as VoiceSession, subject);
    }
  }

  return result;
}
