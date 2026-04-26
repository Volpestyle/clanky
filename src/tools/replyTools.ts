import type Anthropic from "@anthropic-ai/sdk";
import { normalizeDirectiveText } from "../bot/botHelpers.ts";
import type { ImageInput } from "../llm/serviceShared.ts";
import { throwIfAborted } from "./abortError.ts";
import {
  executeSharedMemoryToolSearch,
  executeSharedMemoryToolWrite
} from "../memory/memoryToolRuntime.ts";
import { formatConversationWindows } from "../prompts/promptFormatters.ts";
import type { SubAgentSessionManager, SubAgentSession } from "../agents/subAgentSession.ts";
import {
  resolveCodeAgentConfig
} from "../agents/codeAgentSettings.ts";
import {
  buildMinecraftSessionScopeKey,
  findConflictingMinecraftSession,
  findReusableMinecraftSession,
  isMinecraftSessionAuthorized,
  resolveMinecraftSessionById
} from "../agents/minecraft/minecraftSessionAccess.ts";
import { toAnthropicTool } from "./sharedToolSchemas.ts";
import { buildReplyToolSchemas, type ReplyToolAvailability } from "./toolRegistry.ts";
import {
  startBrowserSessionStreamPublish,
  type BrowserStreamPublishManager
} from "../voice/voiceBrowserStreamPublish.ts";
import {
  isResearchEnabled,
  isBrowserEnabled,
  getMemorySettings
} from "../settings/agentStack.ts";
import { resolveCodeAgentWorkspace } from "../agents/codeAgentWorkspace.ts";
import { waitForTaskCompletion } from "../agents/swarmTaskWaiter.ts";
import { resolveSwarmDbPath } from "../agents/swarmDbConnection.ts";
import type { ClankyPeer, SwarmTaskStatus, UpdateTaskOpts } from "../agents/swarmPeer.ts";
import type { ClankySwarmPeerManager } from "../agents/swarmPeerManager.ts";
import type { SwarmReservationKeeper } from "../agents/swarmReservationKeeper.ts";
import {
  cancelSpawnedWorkerForTask,
  spawnCodeWorker
} from "./spawnCodeWorker.ts";

// Default text budget for free-form tool queries unless a tool has stricter needs.
const MAX_TOOL_QUERY_LEN = 220;

// Research/web tool argument guards.
const MAX_WEB_SCRAPE_URL_LEN = 2000;
const MAX_WEB_SCRAPE_MAX_CHARS = 24000;
const MAX_WEB_SCRAPE_DEFAULT_CHARS = 8000;
const MAX_BROWSER_BROWSE_QUERY_LEN = 500;

// Agent execution/request payload guards.
const MAX_CODE_TASK_LEN = 2000;

// Voice/music/soundboard-specific payload bounds.
const MAX_VOICE_MUSIC_QUERY_LEN = 180;
const MAX_SCREEN_WATCH_TARGET_LEN = 120;
const MAX_SOUNDBOARD_REF_LEN = 180;
const MAX_SOUNDBOARD_REF_COUNT = 10;
const MAX_VIDEO_LOOKUP_REF_COUNT = 8;

// Music tool input clamps and defaults.
const MAX_MUSIC_PLATFORM_LEN = 32;
const MAX_MUSIC_TRACK_IDS = 12;
const MIN_MUSIC_RESULT_COUNT = 1;
const MAX_MUSIC_RESULT_COUNT = 10;
const DEFAULT_MUSIC_RESULT_COUNT = 5;

// Conversation search limits used by the memory/reply tooling path.
const MIN_CONVERSATION_TOP_K = 1;
const MAX_CONVERSATION_TOP_K = 4;
const DEFAULT_CONVERSATION_TOP_K = 3;
const MIN_CONVERSATION_MAX_AGE_HOURS = 1;
const DEFAULT_CONVERSATION_MAX_AGE_HOURS = 24 * 7;
const MAX_CONVERSATION_MAX_AGE_HOURS = 24 * 30;
const CONVERSATION_WINDOW_BEFORE_TURNS = 1;
const CONVERSATION_WINDOW_AFTER_TURNS = 1;

// Minimum scrape content budget and URL safety cap shared with video lookup.
const MIN_WEB_SCRAPE_MAX_CHARS = 350;
const MAX_VIDEO_CONTEXT_URL_LEN = 2000;

function appendBrowserScreenshotNote(content: string, imageInputs: ImageInput[] | undefined) {
  const imageCount = Array.isArray(imageInputs) ? imageInputs.length : 0;
  if (imageCount <= 0) return content;
  const note = imageCount === 1
    ? "Browser screenshot attached for visual inspection."
    : `${imageCount} browser screenshots attached for visual inspection.`;
  const normalizedContent = String(content || "").trim();
  return normalizedContent ? `${normalizedContent}\n\n${note}` : note;
}

function buildSessionNote(sessionId: string, sessionCompleted?: boolean) {
  if (!sessionId || sessionCompleted) return "";
  return `\n\n[session_id: ${sessionId}]`;
}

function maybeRemoveCompletedSession(manager: Pick<SubAgentSessionManager, "remove">, sessionId: string, sessionCompleted?: boolean) {
  if (!sessionCompleted) return;
  manager.remove(sessionId);
}

function buildMinecraftBusyMessage(conflictingSessionId: string): string {
  return `Minecraft companion is already active in session '${conflictingSessionId}' for another user.`;
}

interface ReplyToolDefinition {
  name: string;
  description: string;
  input_schema: Anthropic.Tool.InputSchema;
  strict?: boolean;
}

interface ReplyToolCallInput {
  [key: string]: unknown;
}

interface ReplyToolResult {
  content: string;
  imageInputs?: ImageInput[];
  isError?: boolean;
}

export type ReplyToolRuntime = {
  search?: {
    searchAndRead: (opts: {
      settings: Record<string, unknown>;
      query: string;
      trace: Record<string, unknown>;
      signal?: AbortSignal;
    }) => Promise<{
      query: string;
      results: Array<Record<string, unknown>>;
      fetchedPages?: number;
      providerUsed?: string | null;
      providerFallbackUsed?: boolean;
      summaryText?: string;
    }>;
    readPageSummary?: (url: string, maxChars: number, signal?: AbortSignal) => Promise<{
      title?: string;
      summary?: string;
      extractionMethod?: string;
    }>;
  };
  browser?: {
    browse: (opts: {
      settings: Record<string, unknown>;
      query: string;
      guildId: string;
      channelId: string | null;
      userId: string | null;
      source: string;
      signal?: AbortSignal;
    }) => Promise<{
      used?: boolean;
      text?: string;
      imageInputs?: ImageInput[];
      steps?: number;
      hitStepLimit?: boolean;
      error?: string | null;
      blockedByBudget?: boolean;
    }>;
  };
  screenShare?: {
    startWatch?: (opts: {
      settings: Record<string, unknown>;
      guildId: string;
      channelId: string | null;
      requesterUserId: string;
      target?: string;
      transcript: string;
      source: string;
      signal?: AbortSignal;
    }) => Promise<{
      started?: boolean;
      reused?: boolean;
      transport?: "native" | "link" | null;
      reason?: string | null;
      targetUserId?: string | null;
      frameReady?: boolean;
      linkUrl?: string | null;
      expiresInMinutes?: number | null;
    }>;
    getSnapshot?: () => {
      mimeType: string;
      dataBase64: string;
      streamerName: string | null;
      frameAgeMs: number;
    } | null;
  };
  voiceSessionControl?: {
    requestLeaveVoiceChannel?: () => Promise<{ ok: boolean }>;
  };
  memory?: {
    searchDurableFacts: (opts: {
      guildId?: string | null;
      scope?: "user" | "guild" | "all";
      channelId: string | null;
      queryText: string;
      subjectIds?: string[] | null;
      factTypes?: string[] | null;
      settings: Record<string, unknown>;
      trace: Record<string, unknown>;
      limit?: number;
    }) => Promise<Array<Record<string, unknown>>>;
    searchConversationHistory?: (opts: {
      guildId?: string | null;
      channelId?: string | null;
      queryText: string;
      settings?: Record<string, unknown>;
      trace?: Record<string, unknown>;
      limit?: number;
      maxAgeHours?: number;
      before?: number;
      after?: number;
    }) => Promise<Array<Record<string, unknown>>>;
    rememberDirectiveLineDetailed: (opts: {
      line: string;
      sourceMessageId: string;
      userId: string;
      guildId?: string | null;
      channelId: string | null;
      sourceText: string;
      scope: "lore" | "self" | "user";
      subjectOverride?: string;
      factType?: string | null;
      validationMode?: "strict" | "minimal";
    }) => Promise<{
      ok: boolean;
      reason?: string;
      factText?: string;
    }>;
  };
  store?: {
    logAction: (opts: Record<string, unknown>) => void;
    searchConversationWindows?: (opts: {
      guildId?: string | null;
      channelId?: string | null;
      queryText: string;
      limit?: number;
      maxAgeHours?: number;
      before?: number;
      after?: number;
    }) => Array<Record<string, unknown>>;
  };
  subAgentSessions?: {
    manager: SubAgentSessionManager;
    createBrowserSession: (opts: {
      settings: Record<string, unknown>;
      guildId: string;
      channelId: string | null;
      userId: string | null;
      source: string;
    }) => SubAgentSession | null;
    createMinecraftSession?: (opts: {
      settings: Record<string, unknown>;
      guildId?: string | null;
      channelId?: string | null;
      userId?: string | null;
      source?: string;
    }) => Promise<SubAgentSession | null> | SubAgentSession | null;
  };
  swarm?: {
    peerManager: ClankySwarmPeerManager;
    reservationKeeper: SwarmReservationKeeper;
    activityBridge?: {
      trackTask: (peer: import("../agents/swarmPeer.ts").ClankyPeer, context: {
        taskId: string;
        workerId: string;
        scope: string;
        guildId: string | null;
        channelId: string | null;
        userId: string | null;
        triggerMessageId: string | null;
        source: string;
      }) => void;
    };
  };
  voiceSessionManager?: BrowserStreamPublishManager & {
    stopMusicStreamPublish?: (opts: {
      guildId: string;
      reason?: string | null;
    }) => { ok?: boolean; reason?: string | null };
  };
  voiceSession?: {
    musicSearch: (query: string, limit: number) => Promise<Record<string, unknown>>;
    musicPlay: (query: string, selectionId?: string | null, platform?: string | null) => Promise<Record<string, unknown>>;
    videoSearch: (query: string, limit: number) => Promise<Record<string, unknown>>;
    videoPlay: (query: string, selectionId?: string | null) => Promise<Record<string, unknown>>;
    musicQueueAdd: (args: {
      tracks?: string[];
      query?: string;
      selection_id?: string | null;
      position?: number | "end";
      platform?: string | null;
      max_results?: number;
    }) => Promise<Record<string, unknown>>;
    musicQueueNext: (args: {
      tracks?: string[];
      query?: string;
      selection_id?: string | null;
      platform?: string | null;
      max_results?: number;
    }) => Promise<Record<string, unknown>>;
    musicStop: () => Promise<Record<string, unknown>>;
    musicPause: () => Promise<Record<string, unknown>>;
    musicResume: () => Promise<Record<string, unknown>>;
    musicReplyHandoff: (mode: "pause" | "duck" | "none") => Promise<Record<string, unknown>>;
    musicSkip: () => Promise<Record<string, unknown>>;
    musicNowPlaying: () => Promise<Record<string, unknown>>;
    streamVisualizer?: (mode?: string | null) => Promise<Record<string, unknown>>;
    stopVideoShare?: () => Promise<Record<string, unknown>>;
    playSoundboard: (refs: string[], transcript: string) => Promise<Record<string, unknown>>;
    leaveVoiceChannel: () => Promise<Record<string, unknown>>;
  };
  video?: {
    fetchContext: (opts: {
      url: string;
      settings: Record<string, unknown>;
      trace: Record<string, unknown>;
    }) => Promise<{
      text: string;
      imageInputs?: ImageInput[];
      isError?: boolean;
    }>;
  };
  voiceJoin?: () => Promise<{
    ok: boolean;
    reason?: string;
    voiceChannelName?: string;
    voiceSession?: ReplyToolRuntime["voiceSession"];
  }>;
};

export type ReplyToolContext = {
  settings: Record<string, unknown>;
  guildId: string | null;
  channelId: string | null;
  userId: string;
  sourceMessageId: string;
  sourceText: string;
  botUserId?: string;
  actorName?: string;
  trace?: Record<string, unknown>;
  videoLookup?: {
    refs?: Record<string, string> | null;
  } | null;
  signal?: AbortSignal;
};

export function buildReplyToolSet(
  settings: Record<string, unknown>,
  capabilities: ReplyToolAvailability = {}
): ReplyToolDefinition[] {
  return buildReplyToolSchemas(settings, capabilities).map((schema) => toAnthropicTool(schema));
}

// --- Tool executor ---

const REPLY_TOOL_HANDLERS: Record<
  string,
  (input: ReplyToolCallInput, runtime: ReplyToolRuntime, context: ReplyToolContext) => Promise<ReplyToolResult>
> = {
  web_search: executeWebSearch,
  web_scrape: executeWebScrape,
  video_context: executeVideoContext,
  browser_browse: executeBrowserBrowse,
  memory_search: executeMemorySearch,
  memory_write: executeMemoryWrite,
  conversation_search: executeConversationSearch,
  image_lookup: async (input, runtime, context) => await executeImageLookup(input, runtime, context),
  start_screen_watch: async (input, runtime, context) => await executeStartScreenWatch(input, runtime, context),
  see_screenshare_snapshot: async (_input, runtime, context) => await executeSeeScreenshareSnapshot(runtime, context),
  share_browser_session: async (input, runtime, context) => await executeShareBrowserSession(input, runtime, context),
  play_soundboard: executePlaySoundboard,


  join_voice_channel: async (_input, runtime, context) => await executeJoinVoiceChannel(runtime, context),
  leave_voice_channel: async (_input, runtime, context) => await executeLeaveVoiceChannel(runtime, context.signal),
  spawn_code_worker: executeSpawnCodeWorker,
  request_task: async (input, runtime, context) => await executeSwarmTool("request_task", input, runtime, context),
  get_task: async (input, runtime, context) => await executeSwarmTool("get_task", input, runtime, context),
  list_tasks: async (input, runtime, context) => await executeSwarmTool("list_tasks", input, runtime, context),
  update_task: async (input, runtime, context) => await executeSwarmTool("update_task", input, runtime, context),
  claim_task: async (input, runtime, context) => await executeSwarmTool("claim_task", input, runtime, context),
  send_message: async (input, runtime, context) => await executeSwarmTool("send_message", input, runtime, context),
  broadcast: async (input, runtime, context) => await executeSwarmTool("broadcast", input, runtime, context),
  wait_for_activity: async (input, runtime, context) => await executeSwarmTool("wait_for_activity", input, runtime, context),
  annotate: async (input, runtime, context) => await executeSwarmTool("annotate", input, runtime, context),
  lock_file: async (input, runtime, context) => await executeSwarmTool("lock_file", input, runtime, context),
  unlock_file: async (input, runtime, context) => await executeSwarmTool("unlock_file", input, runtime, context),
  check_file: async (input, runtime, context) => await executeSwarmTool("check_file", input, runtime, context),
  list_instances: async (input, runtime, context) => await executeSwarmTool("list_instances", input, runtime, context),
  whoami: async (input, runtime, context) => await executeSwarmTool("whoami", input, runtime, context),
  kv_get: async (input, runtime, context) => await executeSwarmTool("kv_get", input, runtime, context),
  kv_set: async (input, runtime, context) => await executeSwarmTool("kv_set", input, runtime, context),
  kv_delete: async (input, runtime, context) => await executeSwarmTool("kv_delete", input, runtime, context),
  kv_list: async (input, runtime, context) => await executeSwarmTool("kv_list", input, runtime, context),
  minecraft_task: executeMinecraftTask,
  music_search: async (input, runtime, context) => await executeVoiceTool("music_search", input, runtime, context),
  music_play: async (input, runtime, context) => await executeVoiceTool("music_play", input, runtime, context),
  video_search: async (input, runtime, context) => await executeVoiceTool("video_search", input, runtime, context),
  video_play: async (input, runtime, context) => await executeVoiceTool("video_play", input, runtime, context),
  music_queue_add: async (input, runtime, context) => await executeVoiceTool("music_queue_add", input, runtime, context),
  music_queue_next: async (input, runtime, context) => await executeVoiceTool("music_queue_next", input, runtime, context),
  media_stop: async (input, runtime, context) => await executeVoiceTool("media_stop", input, runtime, context),
  media_pause: async (input, runtime, context) => await executeVoiceTool("media_pause", input, runtime, context),
  media_resume: async (input, runtime, context) => await executeVoiceTool("media_resume", input, runtime, context),
  media_reply_handoff: async (input, runtime, context) => await executeVoiceTool("media_reply_handoff", input, runtime, context),
  media_skip: async (input, runtime, context) => await executeVoiceTool("media_skip", input, runtime, context),
  media_now_playing: async (input, runtime, context) => await executeVoiceTool("media_now_playing", input, runtime, context),
  stream_visualizer: async (input, runtime, context) => await executeVoiceTool("stream_visualizer", input, runtime, context),
  stop_video_share: async (input, runtime, context) => await executeVoiceTool("stop_video_share", input, runtime, context)
};

export async function executeReplyTool(
  toolName: string,
  input: ReplyToolCallInput,
  runtime: ReplyToolRuntime,
  context: ReplyToolContext
): Promise<ReplyToolResult> {
  throwIfAborted(context.signal, "Reply tool cancelled");
  const handler = REPLY_TOOL_HANDLERS[toolName];
  if (!handler) {
    return { content: `Unknown tool: ${toolName}`, isError: true };
  }
  return await handler(input, runtime, context);
}

async function executeConversationSearch(
  input: ReplyToolCallInput,
  runtime: ReplyToolRuntime,
  context: ReplyToolContext
): Promise<ReplyToolResult> {
  throwIfAborted(context.signal, "Reply tool cancelled");
  if (!runtime.store?.searchConversationWindows && !runtime.memory?.searchConversationHistory) {
    return { content: "Conversation history search is not available.", isError: true };
  }

  const query = normalizeDirectiveText(
    String(input?.query || ""),
    MAX_TOOL_QUERY_LEN
  );
  if (!query) {
    return { content: "Missing or empty conversation search query.", isError: true };
  }

  const scope = String(input?.scope || "channel").trim().toLowerCase();
  const searchChannelId = scope === "guild" ? null : context.channelId;
  const topK = Math.max(
    MIN_CONVERSATION_TOP_K,
    Math.min(MAX_CONVERSATION_TOP_K, Math.floor(Number(input?.top_k) || DEFAULT_CONVERSATION_TOP_K))
  );
  const maxAgeHours = Math.max(
    MIN_CONVERSATION_MAX_AGE_HOURS,
    Math.min(MAX_CONVERSATION_MAX_AGE_HOURS, Math.floor(Number(input?.max_age_hours) || DEFAULT_CONVERSATION_MAX_AGE_HOURS))
  );

  try {
    const windows = runtime.memory?.searchConversationHistory
      ? await runtime.memory.searchConversationHistory({
        guildId: context.guildId,
        channelId: searchChannelId,
        queryText: query,
        settings: context.settings,
        trace: {
          ...context.trace,
          source: "reply_tool_conversation_search"
        },
        limit: topK,
        maxAgeHours,
        before: CONVERSATION_WINDOW_BEFORE_TURNS,
        after: CONVERSATION_WINDOW_AFTER_TURNS
      })
      : runtime.store.searchConversationWindows({
        guildId: context.guildId,
        channelId: searchChannelId,
        queryText: query,
        limit: topK,
        maxAgeHours,
        before: CONVERSATION_WINDOW_BEFORE_TURNS,
        after: CONVERSATION_WINDOW_AFTER_TURNS
      });
    if (!Array.isArray(windows) || !windows.length) {
      return { content: `No conversation history found for: "${query}"` };
    }
    return {
      content: `Conversation history for "${query}":\n${formatConversationWindows(windows)}`
    };
  } catch (error) {
    return {
      content: `Conversation history search failed: ${String((error as Error)?.message || error)}`,
      isError: true
    };
  }
}

async function executeWebSearch(
  input: ReplyToolCallInput,
  runtime: ReplyToolRuntime,
  context: ReplyToolContext
): Promise<ReplyToolResult> {
  throwIfAborted(context.signal, "Reply tool cancelled");
  if (!isResearchEnabled(context.settings)) {
    return { content: "Web search is currently unavailable (disabled in settings).", isError: true };
  }
  const query = normalizeDirectiveText(
    String(input?.query || ""),
    MAX_TOOL_QUERY_LEN
  );
  if (!query) {
    return { content: "Missing or empty search query.", isError: true };
  }
  if (!runtime.search?.searchAndRead) {
    return { content: "Web search is not available (no search provider configured).", isError: true };
  }

  try {
    const result = await runtime.search.searchAndRead({
      settings: context.settings,
      query,
      trace: {
        ...context.trace,
        source: "reply_tool_web_search"
      },
      signal: context.signal
    });

    const summary = String(result.summaryText || "").trim();
    if (!result.results?.length && !summary) {
      return { content: `No results found for: "${query}"` };
    }

    const formatted = result.results
      .map((item, i) => {
        const title = String(item.title || "untitled").trim();
        const url = String(item.url || "").trim();
        const domain = String(item.domain || "").trim();
        const snippet = String(item.snippet || "").trim();
        const pageSummary = String(item.pageSummary || "").trim();
        const domainLabel = domain ? ` (${domain})` : "";
        const snippetLine = snippet ? `\nSnippet: ${snippet}` : "";
        const pageLine = pageSummary ? `\nPage: ${pageSummary}` : "";
        return `[${i + 1}] ${title}${domainLabel}\nURL: ${url}${snippetLine}${pageLine}`;
      })
      .join("\n\n");

    const summaryBlock = summary ? `Summary:\n${summary}\n\n` : "";
    return { content: `Web results for "${query}":\n\n${summaryBlock}${formatted}` };
  } catch (error) {
    return {
      content: `Web search failed: ${String((error as Error)?.message || error)}`,
      isError: true
    };
  }
}

async function executeWebScrape(
  input: ReplyToolCallInput,
  runtime: ReplyToolRuntime,
  context: ReplyToolContext
): Promise<ReplyToolResult> {
  throwIfAborted(context.signal, "Reply tool cancelled");
  if (!isResearchEnabled(context.settings)) {
    return { content: "Web scraping is currently unavailable (disabled in settings).", isError: true };
  }
  const url = String(input?.url || "").trim().slice(0, MAX_WEB_SCRAPE_URL_LEN);
  if (!url) {
    return { content: "Missing or empty URL.", isError: true };
  }
  if (!runtime.search?.readPageSummary) {
    return { content: "Web scraping is not available (no search provider configured).", isError: true };
  }

  const maxChars = Math.min(
    MAX_WEB_SCRAPE_MAX_CHARS,
    Math.max(MIN_WEB_SCRAPE_MAX_CHARS, Math.floor(Number(input?.max_chars) || MAX_WEB_SCRAPE_DEFAULT_CHARS))
  );

  try {
    const result = await runtime.search.readPageSummary(url, maxChars, context.signal);
    const title = result?.title ? `Title: ${result.title}\n` : "";
    const body = String(result?.summary || "").trim();
    if (!body) {
      return { content: `Page at ${url} returned no readable content. Try browser_browse for JS-rendered pages.` };
    }
    return { content: `${title}URL: ${url}\n\n${body}` };
  } catch (error) {
    const message = String((error as Error)?.message || error);
    return {
      content: `Web scrape failed for ${url}: ${message}. If the page requires JavaScript or interaction, try browser_browse instead.`,
      isError: true
    };
  }
}

function normalizeVideoLookupRef(value: unknown) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase();
}

function resolveVideoLookupUrl(videoRef: unknown, context: ReplyToolContext) {
  const normalizedRef = normalizeVideoLookupRef(videoRef);
  if (!normalizedRef) return "";
  const refs =
    context.videoLookup?.refs && typeof context.videoLookup.refs === "object" && !Array.isArray(context.videoLookup.refs)
      ? context.videoLookup.refs
      : null;
  if (!refs) return "";

  for (const [rawRef, rawUrl] of Object.entries(refs)) {
    if (normalizeVideoLookupRef(rawRef) !== normalizedRef) continue;
    const normalizedUrl = String(rawUrl || "").trim().slice(0, MAX_VIDEO_CONTEXT_URL_LEN);
    if (normalizedUrl) return normalizedUrl;
  }
  return "";
}

function listAvailableVideoRefs(context: ReplyToolContext) {
  const refs =
    context.videoLookup?.refs && typeof context.videoLookup.refs === "object" && !Array.isArray(context.videoLookup.refs)
      ? context.videoLookup.refs
      : null;
  if (!refs) return [];
  return Object.keys(refs)
    .map((key) => String(key || "").trim())
    .filter(Boolean)
    .slice(0, MAX_VIDEO_LOOKUP_REF_COUNT);
}

async function executeVideoContext(
  input: ReplyToolCallInput,
  runtime: ReplyToolRuntime,
  context: ReplyToolContext
): Promise<ReplyToolResult> {
  throwIfAborted(context.signal, "Reply tool cancelled");
  const inputUrl = String(input?.url || "").trim().slice(0, MAX_VIDEO_CONTEXT_URL_LEN);
  const videoRef = String(input?.videoRef || input?.videoId || "").trim();
  const url = inputUrl || resolveVideoLookupUrl(videoRef, context);
  if (!url) {
    if (videoRef) {
      const refs = listAvailableVideoRefs(context);
      if (refs.length) {
        return {
          content: `Unknown video ref "${videoRef}". Available refs: ${refs.join(", ")}.`,
          isError: true
        };
      }
      return {
        content: `Unknown video ref "${videoRef}". No current message video refs are available in this turn context.`,
        isError: true
      };
    }
    return { content: "Missing or empty URL/videoRef.", isError: true };
  }
  if (!runtime.video?.fetchContext) {
    return { content: "Video context extraction is not available.", isError: true };
  }

  try {
    const result = await runtime.video.fetchContext({
      url,
      settings: context.settings,
      trace: {
        guildId: context.guildId,
        channelId: context.channelId,
        userId: context.userId,
        source: "video_context_tool"
      }
    });
    if (result.isError) {
      return { content: result.text, isError: true };
    }
    return {
      content: result.text,
      imageInputs: result.imageInputs
    };
  } catch (error) {
    const message = String((error as Error)?.message || error);
    return {
      content: `Video context extraction failed for ${url}: ${message}. Try web_scrape or browser_browse as fallback.`,
      isError: true
    };
  }
}

async function executeBrowserBrowse(
  input: ReplyToolCallInput,
  runtime: ReplyToolRuntime,
  context: ReplyToolContext
): Promise<ReplyToolResult> {
  throwIfAborted(context.signal, "Reply tool cancelled");
  if (!isBrowserEnabled(context.settings)) {
    return { content: "Browser browsing is currently unavailable (disabled in settings).", isError: true };
  }
  const query = normalizeDirectiveText(
    String(input?.query || ""),
    MAX_BROWSER_BROWSE_QUERY_LEN
  );
  if (!query) {
    return { content: "Missing or empty browser browse query.", isError: true };
  }

  const sessionId = typeof input?.session_id === "string" ? String(input.session_id).trim() : "";

  // --- Multi-turn session continuation ---
  if (sessionId && runtime.subAgentSessions) {
    const session = runtime.subAgentSessions.manager.get(sessionId);
    if (!session) {
      return { content: `Browser session '${sessionId}' not found or expired.`, isError: true };
    }
    // Verify the caller owns this session
    if (session.ownerUserId && session.ownerUserId !== context.userId) {
      return { content: `Not authorized to continue browser session '${sessionId}'.`, isError: true };
    }
    try {
      const turnResult = await session.runTurn(query, { signal: context.signal });
      maybeRemoveCompletedSession(runtime.subAgentSessions.manager, session.id, turnResult.sessionCompleted);
      const sessionNote = buildSessionNote(session.id, turnResult.sessionCompleted);
      if (turnResult.isError) {
        return { content: `Browser browse failed: ${turnResult.errorMessage}${sessionNote}`, isError: true };
      }
      return {
        content: appendBrowserScreenshotNote(
          (turnResult.text.trim() || "Browser browse completed.") + sessionNote,
          turnResult.imageInputs
        ),
        imageInputs: turnResult.imageInputs
      };
    } catch (error) {
      return { content: `Browser browse session failed: ${String((error as Error)?.message || error)}`, isError: true };
    }
  }

  // --- New interactive session (if session manager is available) ---
  if (runtime.subAgentSessions?.createBrowserSession) {
    const session = runtime.subAgentSessions.createBrowserSession({
      settings: context.settings,
      guildId: context.guildId,
      channelId: context.channelId,
      userId: context.userId,
      source: String(context.trace?.source || "reply_tool_browser_browse")
    });

    if (session) {
      runtime.subAgentSessions.manager.register(session);
      try {
        const turnResult = await session.runTurn(query, { signal: context.signal });
        maybeRemoveCompletedSession(runtime.subAgentSessions.manager, session.id, turnResult.sessionCompleted);
        const sessionNote = buildSessionNote(session.id, turnResult.sessionCompleted);
        if (turnResult.isError) {
          return { content: `Browser browse failed: ${turnResult.errorMessage}${sessionNote}`, isError: true };
        }
        return {
          content: appendBrowserScreenshotNote(
            (turnResult.text.trim() || "Browser browse completed.") + sessionNote,
            turnResult.imageInputs
          ),
          imageInputs: turnResult.imageInputs
        };
      } catch (error) {
        return { content: `Browser browse failed: ${String((error as Error)?.message || error)}`, isError: true };
      }
    }
    // Fallback to one-shot if session creation returned null
  }

  // --- One-shot fallback when session orchestration is unavailable ---
  if (!runtime.browser?.browse) {
    return { content: "Browser browsing is not available.", isError: true };
  }

  try {
    const result = await runtime.browser.browse({
      settings: context.settings,
      query,
      guildId: context.guildId,
      channelId: context.channelId,
      userId: context.userId,
      source: String(context.trace?.source || "reply_tool_browser_browse"),
      signal: context.signal
    });

    if (result?.blockedByBudget) {
      return {
        content: "Browser browsing is currently blocked by budget limits.",
        isError: true
      };
    }
    if (result?.error) {
      return {
        content: `Browser browse failed: ${String(result.error)}`,
        isError: true
      };
    }

    const summary = String(result?.text || "").trim();
    const steps = Number(result?.steps || 0);
    const hitStepLimit = Boolean(result?.hitStepLimit);
    const suffix = [
      steps > 0 ? `Steps: ${steps}` : "",
      hitStepLimit ? "Hit step limit." : ""
    ]
      .filter(Boolean)
      .join(" ");

    return {
      content: appendBrowserScreenshotNote(
        suffix ? `${summary}\n\n${suffix}` : summary || "Browser browse completed with no text result.",
        result.imageInputs
      ),
      imageInputs: result.imageInputs
    };
  } catch (error) {
    return {
      content: `Browser browse failed: ${String((error as Error)?.message || error)}`,
      isError: true
    };
  }
}

async function executeMemorySearch(
  input: ReplyToolCallInput,
  runtime: ReplyToolRuntime,
  context: ReplyToolContext
): Promise<ReplyToolResult> {
  throwIfAborted(context.signal, "Reply tool cancelled");
  if (!getMemorySettings(context.settings).enabled) {
    return { content: "Memory search is currently unavailable (disabled in settings).", isError: true };
  }
  if (!runtime.memory?.searchDurableFacts) {
    return { content: "Memory search is not available (memory runtime not configured).", isError: true };
  }

  try {
    const result = await executeSharedMemoryToolSearch({
      runtime: {
        memory: runtime.memory
      },
      settings: context.settings,
      guildId: context.guildId,
      channelId: context.channelId,
      actorUserId: context.userId,
      namespace: input?.namespace,
      queryText: normalizeDirectiveText(String(input?.query || ""), MAX_TOOL_QUERY_LEN),
      trace: {
        ...context.trace,
        source: "reply_tool_memory_search"
      },
      limit: 10
    });
    if (!result.ok) {
      return {
        content: `Memory search failed: ${String(result.error || "unknown_error")}`,
        isError: true
      };
    }

    if (!result.matches?.length) {
      return { content: `No memory facts found for: "${String(input?.query || "").trim()}"` };
    }

    const formatted = result.matches
      .map((fact) => {
        const text = String(fact.text || "").trim();
        return `- ${text}`;
      })
      .join("\n");

    return {
      content: `Memory facts (${result.namespace || "unknown"}):\n${formatted}`
    };
  } catch (error) {
    return {
      content: `Memory search failed: ${String((error as Error)?.message || error)}`,
      isError: true
    };
  }
}

async function executeMemoryWrite(
  input: ReplyToolCallInput,
  runtime: ReplyToolRuntime,
  context: ReplyToolContext
): Promise<ReplyToolResult> {
  throwIfAborted(context.signal, "Reply tool cancelled");
  if (!getMemorySettings(context.settings).enabled) {
    return { content: "Memory write is currently unavailable (disabled in settings).", isError: true };
  }
  if (
    !runtime.memory?.searchDurableFacts ||
    !runtime.memory?.rememberDirectiveLineDetailed
  ) {
    return { content: "Memory write is not available (memory runtime not configured).", isError: true };
  }

  try {
    const result = await executeSharedMemoryToolWrite({
      runtime: {
        memory: runtime.memory
      },
      settings: context.settings,
      guildId: context.guildId,
      channelId: context.channelId,
      actorUserId: context.userId,
      namespace: input?.namespace,
      items: Array.isArray(input?.items) ? input.items : [],
      trace: {
        ...context.trace,
        source: "reply_tool_memory_write"
      },
      sourceMessageIdPrefix: context.sourceMessageId,
      sourceText: context.sourceText,
      limit: 5
    });
    if (!result.ok) {
      return {
        content: `Memory write failed: ${String(result.error || "unknown_error")}`,
        isError: true
      };
    }

    const lines = [
      ...result.written.map((entry) => `Saved: ${String(entry.text || "").trim()}`),
      ...result.skipped.map((entry) => `Skipped (${entry.reason}): ${String(entry.text || "").trim()}`)
    ];
    return {
      content: lines.length ? lines.join("\n") : "No durable facts were saved."
    };
  } catch (error) {
    return {
      content: `Memory write failed: ${String((error as Error)?.message || error)}`,
      isError: true
    };
  }
}

async function executeImageLookup(
  input: ReplyToolCallInput,
  _runtime: ReplyToolRuntime,
  context: ReplyToolContext
): Promise<ReplyToolResult> {
  throwIfAborted(context.signal, "Reply tool cancelled");
  // Image lookup works on message history, not durable memory.
  // No settings gate needed — availability is determined by whether
  // history image candidates exist (checked at the prompt layer).
  const imageId = normalizeDirectiveText(
    String(input?.imageId || ""),
    MAX_TOOL_QUERY_LEN
  );
  const query = normalizeDirectiveText(
    String(input?.query || ""),
    MAX_TOOL_QUERY_LEN
  );
  const request = imageId || query;
  if (!request) {
    return { content: "Missing image lookup request.", isError: true };
  }
  // Image lookup is handled by the caller since it needs access to
  // message history image candidates which are passed at the call site.
  // This tool returns a placeholder that the caller intercepts.
  return {
    content: `__IMAGE_LOOKUP_REQUEST__:${request}`
  };
}

async function executeStartScreenWatch(
  input: ReplyToolCallInput,
  runtime: ReplyToolRuntime,
  context: ReplyToolContext
): Promise<ReplyToolResult> {
  throwIfAborted(context.signal, "Reply tool cancelled");
  if (!runtime.screenShare?.startWatch) {
    return { content: "Screen watch is not available.", isError: true };
  }
  if (!context.guildId || !context.userId) {
    return { content: "Screen watch context is incomplete.", isError: true };
  }
  const target = normalizeDirectiveText(
    String(input?.target || ""),
    MAX_SCREEN_WATCH_TARGET_LEN
  );

  try {
    const result = await runtime.screenShare.startWatch({
      settings: context.settings,
      guildId: context.guildId,
      channelId: context.channelId,
      requesterUserId: context.userId,
      target: target || undefined,
      transcript: context.sourceText,
      source: String(context.trace?.source || "reply_tool_start_screen_watch"),
      signal: context.signal
    });
    return {
      content: JSON.stringify({
        ok: Boolean(result?.started || result?.reused),
        started: Boolean(result?.started || result?.reused),
        reused: Boolean(result?.reused),
        transport:
          result?.transport === "native" || result?.transport === "link"
            ? result.transport
            : null,
        reason: result?.reason ? String(result.reason) : null,
        targetUserId: result?.targetUserId ? String(result.targetUserId) : null,
        frameReady: Boolean(result?.frameReady),
        linkUrl: result?.linkUrl ? String(result.linkUrl) : null,
        expiresInMinutes: Number.isFinite(Number(result?.expiresInMinutes))
          ? Math.max(0, Math.round(Number(result.expiresInMinutes)))
          : null
      })
    };
  } catch (error) {
    return {
      content: `Screen watch start failed: ${String((error as Error)?.message || error)}`,
      isError: true
    };
  }
}

async function executeSeeScreenshareSnapshot(
  runtime: ReplyToolRuntime,
  context: ReplyToolContext
): Promise<ReplyToolResult> {
  throwIfAborted(context.signal, "Reply tool cancelled");
  if (!runtime.screenShare?.getSnapshot) {
    return { content: "Screen share snapshot is not available.", isError: true };
  }
  const snapshot = runtime.screenShare.getSnapshot();
  if (!snapshot || !snapshot.dataBase64) {
    return { content: "No recent frame available from the active screen share.", isError: true };
  }
  return {
    content: JSON.stringify({
      ok: true,
      streamerName: snapshot.streamerName || null,
      frameAgeMs: snapshot.frameAgeMs
    }),
    imageInputs: [
      {
        mediaType: snapshot.mimeType || "image/jpeg",
        dataBase64: snapshot.dataBase64
      }
    ]
  };
}

async function executeShareBrowserSession(
  input: ReplyToolCallInput,
  runtime: ReplyToolRuntime,
  context: ReplyToolContext
): Promise<ReplyToolResult> {
  throwIfAborted(context.signal, "Reply tool cancelled");
  if (!runtime.voiceSession) {
    return { content: "Not in a voice channel. Join voice first, then share the browser session.", isError: true };
  }
  if (!runtime.voiceSessionManager || !runtime.subAgentSessions) {
    return { content: "Browser session sharing is not available.", isError: true };
  }

  const sessionId = String(input?.session_id || "").trim().slice(0, MAX_TOOL_QUERY_LEN);
  if (!sessionId) {
    return { content: "Missing browser session_id.", isError: true };
  }

  try {
    const result = await startBrowserSessionStreamPublish({
      ...runtime.voiceSessionManager,
      subAgentSessions: runtime.subAgentSessions.manager
    }, {
      guildId: context.guildId,
      browserSessionId: sessionId,
      requesterUserId: context.userId,
      source: String(context.trace?.source || "reply_tool_share_browser_session"),
      signal: context.signal
    });
    return {
      content: JSON.stringify({
        ok: Boolean(result?.ok),
        started: Boolean(result?.started),
        reused: Boolean(result?.reused),
        session_id: sessionId,
        error: result?.error ? String(result.error) : null
      }),
      isError: result?.ok === false
    };
  } catch (error) {
    return {
      content: `Browser session share failed: ${String((error as Error)?.message || error)}`,
      isError: true
    };
  }
}

async function executePlaySoundboard(
  input: ReplyToolCallInput,
  runtime: ReplyToolRuntime,
  context: ReplyToolContext
): Promise<ReplyToolResult> {
  throwIfAborted(context.signal, "Reply tool cancelled");
  if (!runtime.voiceSession?.playSoundboard) {
    return { content: "Soundboard playback is not available.", isError: true };
  }

  const refs = Array.isArray(input?.refs)
    ? input.refs
      .map((entry) => String(entry || "").trim().slice(0, MAX_SOUNDBOARD_REF_LEN))
      .filter(Boolean)
      .slice(0, MAX_SOUNDBOARD_REF_COUNT)
    : [];
  if (!refs.length) {
    return { content: "No soundboard refs provided.", isError: true };
  }

  try {
    const result = await runtime.voiceSession.playSoundboard(refs, context.sourceText);
    return {
      content: JSON.stringify({
        ok: Boolean(result?.ok),
        played: Array.isArray(result?.played) ? result.played : [],
        rejected: Array.isArray(result?.rejected) ? result.rejected : []
      }),
      isError: result?.ok === false
    };
  } catch (error) {
    return {
      content: `Soundboard playback failed: ${String((error as Error)?.message || error)}`,
      isError: true
    };
  }
}

async function executeJoinVoiceChannel(
  runtime: ReplyToolRuntime,
  context: ReplyToolContext
): Promise<ReplyToolResult> {
  throwIfAborted(context.signal, "Reply tool cancelled");
  if (!runtime.voiceJoin) {
    return { content: "Voice join is not available.", isError: true };
  }
  if (runtime.voiceSession) {
    return { content: JSON.stringify({ ok: true, already_connected: true }) };
  }
  try {
    const result = await runtime.voiceJoin();
    if (!result.ok) {
      return {
        content: `Could not join voice channel: ${result.reason || "unknown"}`,
        isError: true
      };
    }
    runtime.voiceSession = result.voiceSession;
    const channelLabel = result.voiceChannelName || "voice channel";
    return { content: JSON.stringify({ ok: true, joined: channelLabel }) };
  } catch (error) {
    return {
      content: `Voice tool join_voice_channel failed: ${String((error as Error)?.message || error)}`,
      isError: true
    };
  }
}

async function executeLeaveVoiceChannel(
  runtime: ReplyToolRuntime,
  signal?: AbortSignal
): Promise<ReplyToolResult> {
  throwIfAborted(signal, "Reply tool cancelled");
  try {
    if (typeof runtime.voiceSessionControl?.requestLeaveVoiceChannel === "function") {
      const result = await runtime.voiceSessionControl.requestLeaveVoiceChannel();
      return { content: JSON.stringify(result) };
    }
    if (runtime.voiceSession?.leaveVoiceChannel) {
      const result = await runtime.voiceSession.leaveVoiceChannel();
      return { content: JSON.stringify(result) };
    }
    return { content: "Voice session leave is not available.", isError: true };
  } catch (error) {
    return {
      content: `Voice tool leave_voice_channel failed: ${String((error as Error)?.message || error)}`,
      isError: true
    };
  }
}

function jsonToolResult(value: unknown): ReplyToolResult {
  return { content: JSON.stringify(value, null, 2) };
}

function getStringInput(input: ReplyToolCallInput, key: string): string {
  return typeof input?.[key] === "string" ? String(input[key]).trim() : "";
}

function getStringArrayInput(input: ReplyToolCallInput, key: string): string[] {
  const value = input?.[key];
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").trim()).filter(Boolean);
}

function getObjectInput(input: ReplyToolCallInput, key: string): Record<string, unknown> | undefined {
  const value = input?.[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function resolveSwarmPlannerPeer(
  input: ReplyToolCallInput,
  runtime: ReplyToolRuntime,
  context: ReplyToolContext
): ClankyPeer {
  if (!runtime.swarm?.peerManager) {
    throw new Error("Swarm runtime is not available.");
  }
  const cwd = getStringInput(input, "cwd") || resolveCodeAgentConfig(context.settings, undefined, "implementation").cwd;
  const workspace = resolveCodeAgentWorkspace({ cwd });
  return runtime.swarm.peerManager.ensurePeer(workspace.repoRoot, workspace.repoRoot, workspace.canonicalCwd);
}

async function executeSpawnCodeWorker(
  input: ReplyToolCallInput,
  runtime: ReplyToolRuntime,
  context: ReplyToolContext
): Promise<ReplyToolResult> {
  throwIfAborted(context.signal, "Reply tool cancelled");
  if (!runtime.swarm?.peerManager || !runtime.swarm?.reservationKeeper || !runtime.store?.logAction) {
    return { content: "Swarm worker runtime is not available.", isError: true };
  }

  try {
    const result = await spawnCodeWorker(
      {
        settings: context.settings,
        task: normalizeDirectiveText(String(input?.task || ""), MAX_CODE_TASK_LEN),
        role: getStringInput(input, "role"),
        harness: getStringInput(input, "harness"),
        cwd: getStringInput(input, "cwd") || undefined,
        guildId: context.guildId,
        channelId: context.channelId,
        userId: context.userId,
        triggerMessageId: context.sourceMessageId,
        source: String(context.trace?.source || "reply_tool_spawn_code_worker"),
        signal: context.signal
      },
      {
        store: runtime.store,
        peerManager: runtime.swarm.peerManager,
        reservationKeeper: runtime.swarm.reservationKeeper,
        activityBridge: runtime.swarm.activityBridge
      }
    );
    return jsonToolResult(result);
  } catch (error) {
    return { content: `spawn_code_worker failed: ${String((error as Error)?.message || error)}`, isError: true };
  }
}

async function executeSwarmTool(
  toolName: string,
  input: ReplyToolCallInput,
  runtime: ReplyToolRuntime,
  context: ReplyToolContext
): Promise<ReplyToolResult> {
  throwIfAborted(context.signal, "Reply tool cancelled");
  try {
    const peer = resolveSwarmPlannerPeer(input, runtime, context);
    const taskId = getStringInput(input, "task_id");
    switch (toolName) {
      case "request_task":
        return jsonToolResult(await peer.requestTask({
          type: getStringInput(input, "type") || "other",
          title: getStringInput(input, "title"),
          description: getStringInput(input, "description") || undefined,
          files: getStringArrayInput(input, "files"),
          assignee: getStringInput(input, "assignee") || undefined,
          priority: Math.floor(Number(input?.priority) || 0),
          dependsOn: getStringArrayInput(input, "depends_on"),
          idempotencyKey: getStringInput(input, "idempotency_key") || undefined,
          parentTaskId: getStringInput(input, "parent_task_id") || undefined,
          approvalRequired: Boolean(input?.approval_required)
        }));
      case "get_task":
        return jsonToolResult(await peer.getTask(taskId));
      case "list_tasks": {
        const statusInput = getStringInput(input, "status");
        return jsonToolResult(await peer.listTasks({
          status: statusInput ? (statusInput as SwarmTaskStatus) : undefined,
          assignee: getStringInput(input, "assignee") || undefined,
          requester: getStringInput(input, "requester") || undefined
        }));
      }
      case "update_task": {
        const status = getStringInput(input, "status") as UpdateTaskOpts["status"];
        const updated = await peer.updateTask(taskId, {
          status,
          result: getStringInput(input, "result") || undefined,
          metadata: getObjectInput(input, "metadata")
        });
        if (status === "cancelled") {
          await cancelSpawnedWorkerForTask(taskId, "Cancelled by orchestrator via update_task").catch(() => false);
        }
        return jsonToolResult(updated);
      }
      case "claim_task":
        return jsonToolResult(await peer.claimTask(taskId));
      case "send_message":
        await peer.sendMessage(getStringInput(input, "recipient"), getStringInput(input, "content"));
        return jsonToolResult({ ok: true });
      case "broadcast":
        return jsonToolResult({ recipients: await peer.broadcast(getStringInput(input, "content")) });
      case "wait_for_activity": {
        const timeoutMs = Math.max(1000, Math.floor(Number(input?.timeout_ms) || 300_000));
        if (taskId) {
          const result = await waitForTaskCompletion(peer, taskId, {
            dbPath: resolveSwarmDbPath(resolveCodeAgentConfig(context.settings).swarm?.dbPath || ""),
            timeoutMs,
            signal: context.signal
          });
          return jsonToolResult(result);
        }
        return jsonToolResult(await peer.waitForActivity({ timeoutMs }));
      }
      case "annotate":
        await peer.annotate({
          file: getStringInput(input, "file"),
          kind: getStringInput(input, "kind"),
          content: getStringInput(input, "content")
        });
        return jsonToolResult({ ok: true });
      case "lock_file":
        return jsonToolResult(await peer.lockFile(getStringInput(input, "file"), getStringInput(input, "reason")));
      case "unlock_file":
        return jsonToolResult({ unlocked: await peer.unlockFile(getStringInput(input, "file")) });
      case "check_file":
        return jsonToolResult(await peer.checkFile(getStringInput(input, "file")));
      case "list_instances":
        return jsonToolResult(await peer.listInstances(getStringInput(input, "label_contains")));
      case "whoami":
        return jsonToolResult(await peer.whoami());
      case "kv_get":
        return jsonToolResult(await peer.kvGet(getStringInput(input, "key")));
      case "kv_set":
        return jsonToolResult(await peer.kvSet(getStringInput(input, "key"), String(input?.value ?? "")));
      case "kv_delete":
        return jsonToolResult({ deleted: await peer.kvDelete(getStringInput(input, "key")) });
      case "kv_list":
        return jsonToolResult(await peer.kvList(getStringInput(input, "prefix")));
      default:
        return { content: `Unknown swarm tool: ${toolName}`, isError: true };
    }
  } catch (error) {
    return { content: `${toolName} failed: ${String((error as Error)?.message || error)}`, isError: true };
  }
}

async function executeVoiceTool(
  toolName: string,
  input: ReplyToolCallInput,
  runtime: ReplyToolRuntime,
  context: ReplyToolContext
): Promise<ReplyToolResult> {
  throwIfAborted(context.signal, "Reply tool cancelled");
  if (!runtime.voiceSession) {
    return { content: "Not in a voice channel. Call join_voice_channel first, then retry this command.", isError: true };
  }
  try {
    let result: Record<string, unknown>;
    switch (toolName) {
      case "music_search": {
        const query = String(input?.query || "").trim().slice(0, MAX_VOICE_MUSIC_QUERY_LEN);
        if (!query) return { content: "Failed: query was empty. You must provide the song/artist name in the query argument.", isError: true };
        const limit = Math.max(
          MIN_MUSIC_RESULT_COUNT,
          Math.min(MAX_MUSIC_RESULT_COUNT, Math.floor(Number(input?.max_results) || DEFAULT_MUSIC_RESULT_COUNT))
        );
        throwIfAborted(context.signal, "Reply tool cancelled");
        result = await runtime.voiceSession.musicSearch(query, limit);
        break;
      }
      case "music_play": {
        const query = String(input?.query || "").trim().slice(0, MAX_VOICE_MUSIC_QUERY_LEN);
        const selectionId = String(input?.selection_id || "").trim().slice(0, MAX_VOICE_MUSIC_QUERY_LEN) || null;
        const platform = String(input?.platform || "").trim().slice(0, MAX_MUSIC_PLATFORM_LEN) || null;
        if (!query && !selectionId) {
          return { content: "Failed: query was empty. You must provide the song/artist name in the query argument.", isError: true };
        }
        throwIfAborted(context.signal, "Reply tool cancelled");
        result = await runtime.voiceSession.musicPlay(query, selectionId, platform);
        break;
      }
      case "video_search": {
        const query = String(input?.query || "").trim().slice(0, MAX_VOICE_MUSIC_QUERY_LEN);
        if (!query) return { content: "Failed: query was empty. You must provide the video/topic in the query argument.", isError: true };
        const limit = Math.max(
          MIN_MUSIC_RESULT_COUNT,
          Math.min(MAX_MUSIC_RESULT_COUNT, Math.floor(Number(input?.max_results) || DEFAULT_MUSIC_RESULT_COUNT))
        );
        throwIfAborted(context.signal, "Reply tool cancelled");
        result = await runtime.voiceSession.videoSearch(query, limit);
        break;
      }
      case "video_play": {
        const query = String(input?.query || "").trim().slice(0, MAX_VOICE_MUSIC_QUERY_LEN);
        const selectionId = String(input?.selection_id || "").trim().slice(0, MAX_VOICE_MUSIC_QUERY_LEN) || null;
        if (!query && !selectionId) {
          return { content: "Failed: query was empty. You must provide the video/topic in the query argument.", isError: true };
        }
        throwIfAborted(context.signal, "Reply tool cancelled");
        result = await runtime.voiceSession.videoPlay(query, selectionId);
        break;
      }
      case "music_queue_add": {
        const tracks = Array.isArray(input?.tracks)
          ? (input.tracks as string[]).map((t) => String(t).trim()).filter(Boolean).slice(0, MAX_MUSIC_TRACK_IDS)
          : [];
        const query = String(input?.query || "").trim().slice(0, MAX_VOICE_MUSIC_QUERY_LEN);
        const selectionId = String(input?.selection_id || "").trim().slice(0, MAX_VOICE_MUSIC_QUERY_LEN) || null;
        const platform = String(input?.platform || "").trim().slice(0, MAX_MUSIC_PLATFORM_LEN) || null;
        const maxResults = Math.max(
          MIN_MUSIC_RESULT_COUNT,
          Math.min(MAX_MUSIC_RESULT_COUNT, Math.floor(Number(input?.max_results) || DEFAULT_MUSIC_RESULT_COUNT))
        );
        if (!tracks.length && !query && !selectionId) {
          return { content: "No queue target provided. Use query, selection_id, or track IDs.", isError: true };
        }
        const rawPos = input?.position;
        const position = rawPos === "end"
          ? "end"
          : typeof rawPos === "string" && /^\d+$/.test(rawPos)
            ? Math.max(0, parseInt(rawPos, 10))
            : typeof rawPos === "number"
              ? Math.max(0, Math.floor(rawPos))
              : undefined;
        throwIfAborted(context.signal, "Reply tool cancelled");
        result = await runtime.voiceSession.musicQueueAdd({
          tracks,
          query: query || undefined,
          selection_id: selectionId,
          position,
          platform,
          max_results: maxResults
        });
        break;
      }
      case "music_queue_next": {
        const tracks = Array.isArray(input?.tracks)
          ? (input.tracks as string[]).map((t) => String(t).trim()).filter(Boolean).slice(0, MAX_MUSIC_TRACK_IDS)
          : [];
        const query = String(input?.query || "").trim().slice(0, MAX_VOICE_MUSIC_QUERY_LEN);
        const selectionId = String(input?.selection_id || "").trim().slice(0, MAX_VOICE_MUSIC_QUERY_LEN) || null;
        const platform = String(input?.platform || "").trim().slice(0, MAX_MUSIC_PLATFORM_LEN) || null;
        const maxResults = Math.max(
          MIN_MUSIC_RESULT_COUNT,
          Math.min(MAX_MUSIC_RESULT_COUNT, Math.floor(Number(input?.max_results) || DEFAULT_MUSIC_RESULT_COUNT))
        );
        if (!tracks.length && !query && !selectionId) {
          return { content: "No queue target provided. Use query, selection_id, or track IDs.", isError: true };
        }
        throwIfAborted(context.signal, "Reply tool cancelled");
        result = await runtime.voiceSession.musicQueueNext({
          tracks,
          query: query || undefined,
          selection_id: selectionId,
          platform,
          max_results: maxResults
        });
        break;
      }
      case "media_stop":
        throwIfAborted(context.signal, "Reply tool cancelled");
        result = await runtime.voiceSession.musicStop();
        break;
      case "media_pause":
        throwIfAborted(context.signal, "Reply tool cancelled");
        result = await runtime.voiceSession.musicPause();
        break;
      case "media_resume":
        throwIfAborted(context.signal, "Reply tool cancelled");
        result = await runtime.voiceSession.musicResume();
        break;
      case "media_reply_handoff": {
        const rawMode = String(input?.mode || "").trim().toLowerCase();
        const mode =
          rawMode === "pause" || rawMode === "duck" || rawMode === "none"
            ? rawMode
            : null;
        if (!mode) {
          return { content: "Invalid media reply handoff mode. Use pause, duck, or none.", isError: true };
        }
        throwIfAborted(context.signal, "Reply tool cancelled");
        result = await runtime.voiceSession.musicReplyHandoff(mode);
        break;
      }
      case "media_skip":
        throwIfAborted(context.signal, "Reply tool cancelled");
        result = await runtime.voiceSession.musicSkip();
        break;
      case "media_now_playing":
        throwIfAborted(context.signal, "Reply tool cancelled");
        result = await runtime.voiceSession.musicNowPlaying();
        break;
      case "stream_visualizer": {
        throwIfAborted(context.signal, "Reply tool cancelled");
        if (typeof runtime.voiceSession.streamVisualizer !== "function") {
          return { content: "Stream visualizer is not available.", isError: true };
        }
        const modeArg = String(input?.mode || "").trim().slice(0, 32) || null;
        result = await runtime.voiceSession.streamVisualizer(modeArg);
        break;
      }
      case "stop_video_share":
        throwIfAborted(context.signal, "Reply tool cancelled");
        if (typeof runtime.voiceSession.stopVideoShare !== "function") {
          return { content: "Video share stop is not available.", isError: true };
        }
        result = await runtime.voiceSession.stopVideoShare();
        break;
      case "leave_voice_channel":
        throwIfAborted(context.signal, "Reply tool cancelled");
        result = await runtime.voiceSession.leaveVoiceChannel();
        break;
      default:
        return { content: `Unknown voice tool: ${toolName}`, isError: true };
    }
    return { content: JSON.stringify(result) };
  } catch (error) {
    return {
      content: `Voice tool ${toolName} failed: ${String((error as Error)?.message || error)}`,
      isError: true
    };
  }
}
// ── Minecraft Task ──

async function executeMinecraftTask(
  input: ReplyToolCallInput,
  runtime: ReplyToolRuntime,
  context: ReplyToolContext
): Promise<ReplyToolResult> {
  throwIfAborted(context.signal, "Reply tool cancelled");
  const action = String(input?.action || "run").trim().toLowerCase();
  const sessionId = typeof input?.session_id === "string" ? String(input.session_id).trim() : "";
  const scopeKey = buildMinecraftSessionScopeKey({
    guildId: context.guildId,
    channelId: context.channelId
  });

  const resolveExistingSession = () => {
    if (!runtime.subAgentSessions) return null;
    if (sessionId) {
      const requested = resolveMinecraftSessionById(runtime.subAgentSessions.manager, sessionId);
      if (!requested) return { session: null, error: `Minecraft session '${sessionId}' not found or expired.` };
      if (!isMinecraftSessionAuthorized(requested, context.userId)) {
        return { session: null, error: `Not authorized to continue Minecraft session '${sessionId}'.` };
      }
      return { session: requested, error: null };
    }
    const reusable = findReusableMinecraftSession(runtime.subAgentSessions.manager, {
      ownerUserId: context.userId,
      scopeKey
    });
    return { session: reusable, error: null };
  };

  // --- action: status ---
  if (action === "status") {
    const resolved = resolveExistingSession();
    if (resolved?.error) return { content: resolved.error, isError: true };
    const session = resolved?.session;
    if (!session) {
      return { content: "No active Minecraft session. Use action=run with a task to start one." };
    }
    try {
      const result = await session.runTurn(JSON.stringify({ command: "status" }), { signal: context.signal });
      return { content: result.text };
    } catch (error) {
      return { content: `Status check failed: ${String((error as Error)?.message || error)}`, isError: true };
    }
  }

  // --- action: cancel ---
  if (action === "cancel") {
    if (!runtime.subAgentSessions) return { content: "Session management unavailable.", isError: true };
    const resolved = resolveExistingSession();
    if (resolved?.error) return { content: resolved.error, isError: true };
    const session = resolved?.session;
    if (!session) return { content: "No active Minecraft session to cancel.", isError: true };
    session.cancel?.("Cancelled by user via minecraft_task action");
    runtime.subAgentSessions.manager.remove(session.id);
    return { content: `Minecraft session '${session.id}' cancelled.` };
  }

  // --- action: followup ---
  if (action === "followup") {
    const task = normalizeDirectiveText(String(input?.task || ""), MAX_CODE_TASK_LEN);
    if (!task) return { content: "Missing or empty follow-up instruction.", isError: true };
    if (!sessionId) return { content: "Missing session_id for follow-up.", isError: true };
    if (!runtime.subAgentSessions) return { content: "Session management unavailable.", isError: true };
    const resolved = resolveExistingSession();
    if (resolved?.error) return { content: resolved.error, isError: true };
    const session = resolved?.session;
    if (!session) return { content: `Minecraft session '${sessionId}' not found or expired.`, isError: true };
    try {
      const turnResult = await session.runTurn(task, { signal: context.signal });
      maybeRemoveCompletedSession(runtime.subAgentSessions.manager, session.id, turnResult.sessionCompleted);
      const sessionNote = buildSessionNote(session.id, turnResult.sessionCompleted);
      if (turnResult.isError) {
        return { content: `Minecraft task failed: ${turnResult.errorMessage}${sessionNote}`, isError: true };
      }
      return { content: (turnResult.text.trim() || "Minecraft follow-up completed.") + sessionNote };
    } catch (error) {
      return { content: `Minecraft follow-up failed: ${String((error as Error)?.message || error)}`, isError: true };
    }
  }

  // --- action: run (default) ---
  const task = normalizeDirectiveText(String(input?.task || ""), MAX_CODE_TASK_LEN);
  if (!task) return { content: "Missing or empty Minecraft task instruction.", isError: true };
  const mode = typeof input?.mode === "string" ? String(input.mode).trim() : undefined;
  const constraints = input?.constraints && typeof input.constraints === "object" ? input.constraints as Record<string, unknown> : undefined;
  const server = input?.server && typeof input.server === "object" ? input.server as Record<string, unknown> : undefined;

  // Session continuation
  if (runtime.subAgentSessions) {
    const resolved = resolveExistingSession();
    if (resolved?.error) return { content: resolved.error, isError: true };
    const session = resolved?.session;
    if (session) {
      try {
        const turnInput = JSON.stringify({ task, mode, constraints, server });
        const turnResult = await session.runTurn(turnInput, { signal: context.signal });
        maybeRemoveCompletedSession(runtime.subAgentSessions.manager, session.id, turnResult.sessionCompleted);
        const sessionNote = buildSessionNote(session.id, turnResult.sessionCompleted);
        if (turnResult.isError) {
          return { content: `Minecraft task failed: ${turnResult.errorMessage}${sessionNote}`, isError: true };
        }
        return { content: (turnResult.text.trim() || "Minecraft task completed.") + sessionNote };
      } catch (error) {
        return { content: `Minecraft task failed: ${String((error as Error)?.message || error)}`, isError: true };
      }
    }

    const conflictingSession = findConflictingMinecraftSession(runtime.subAgentSessions.manager, {
      ownerUserId: context.userId,
      scopeKey
    });
    if (conflictingSession) {
      return { content: buildMinecraftBusyMessage(conflictingSession.id), isError: true };
    }
  }

  // New session
  if (runtime.subAgentSessions?.createMinecraftSession) {
    const session = await runtime.subAgentSessions.createMinecraftSession({
      settings: context.settings,
      guildId: context.guildId,
      channelId: context.channelId,
      userId: context.userId,
      source: String(context.trace?.source || "reply_tool_minecraft_task")
    });
    if (session) {
      runtime.subAgentSessions.manager.register(session);
      try {
        const turnInput = JSON.stringify({ task, mode, constraints, server });
        const turnResult = await session.runTurn(turnInput, { signal: context.signal });
        maybeRemoveCompletedSession(runtime.subAgentSessions.manager, session.id, turnResult.sessionCompleted);
        const sessionNote = buildSessionNote(session.id, turnResult.sessionCompleted);
        if (turnResult.isError) {
          return { content: `Minecraft task failed: ${turnResult.errorMessage}${sessionNote}`, isError: true };
        }
        return { content: (turnResult.text.trim() || "Minecraft task completed.") + sessionNote };
      } catch (error) {
        return { content: `Minecraft task failed: ${String((error as Error)?.message || error)}`, isError: true };
      }
    }
  }

  return { content: "Minecraft agent is not available. Ensure Minecraft is enabled and the MCP server can start.", isError: true };
}

export type {
  ReplyToolDefinition
};
