import type Anthropic from "@anthropic-ai/sdk";
import { normalizeDirectiveText } from "../bot/botHelpers.ts";
import type { ImageInput } from "../llm/serviceShared.ts";
import { throwIfAborted } from "./browserTaskRuntime.ts";
import {
  executeSharedMemoryToolSearch,
  executeSharedMemoryToolWrite
} from "../memory/memoryToolRuntime.ts";
import { formatConversationWindows } from "../prompts/promptFormatters.ts";
import type { SubAgentSessionManager, SubAgentSession } from "../agents/subAgentSession.ts";
import {
  normalizeCodeAgentRole,
  type CodeAgentRole
} from "../agents/codeAgent.ts";
import { toAnthropicTool } from "./sharedToolSchemas.ts";
import { buildReplyToolSchemas, type ReplyToolAvailability } from "./toolRegistry.ts";

const MAX_WEB_QUERY_LEN = 220;
const MAX_MEMORY_LOOKUP_QUERY_LEN = 220;
const MAX_CONVERSATION_LOOKUP_QUERY_LEN = 220;
const MAX_IMAGE_LOOKUP_QUERY_LEN = 220;
const MAX_WEB_SCRAPE_URL_LEN = 2000;
const MAX_WEB_SCRAPE_MAX_CHARS = 24000;
const MAX_WEB_SCRAPE_DEFAULT_CHARS = 8000;
const MAX_BROWSER_BROWSE_QUERY_LEN = 500;
const MAX_CODE_TASK_LEN = 2000;
const MAX_VOICE_MUSIC_QUERY_LEN = 180;

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
    offerLink: (opts: {
      settings: Record<string, unknown>;
      guildId: string;
      channelId: string | null;
      requesterUserId: string;
      transcript: string;
      source: string;
      signal?: AbortSignal;
    }) => Promise<{
      offered?: boolean;
      reused?: boolean;
      reason?: string | null;
      linkUrl?: string | null;
      expiresInMinutes?: number | null;
    }>;
  };
  voiceSessionControl?: {
    requestLeaveVoiceChannel?: () => Promise<{ ok: boolean }>;
  };
  codeAgent?: {
    runTask: (opts: {
      settings: Record<string, unknown>;
      task: string;
      role?: CodeAgentRole;
      cwd?: string;
      guildId: string;
      channelId: string | null;
      userId: string | null;
      source: string;
      signal?: AbortSignal;
    }) => Promise<{
      text?: string;
      isError?: boolean;
      costUsd?: number;
      error?: string | null;
      blockedByBudget?: boolean;
      blockedByPermission?: boolean;
      blockedByParallelLimit?: boolean;
    }>;
  };
  memory?: {
    searchDurableFacts: (opts: {
      guildId: string;
      channelId: string | null;
      queryText: string;
      subjectIds?: string[] | null;
      factTypes?: string[] | null;
      settings: Record<string, unknown>;
      trace: Record<string, unknown>;
      limit?: number;
    }) => Promise<Array<Record<string, unknown>>>;
    searchConversationHistory?: (opts: {
      guildId: string;
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
      guildId: string;
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
      guildId: string;
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
    createCodeSession: (opts: {
      settings: Record<string, unknown>;
      role?: CodeAgentRole;
      cwd?: string;
      guildId: string;
      channelId: string | null;
      userId: string | null;
      source: string;
    }) => SubAgentSession | null;
    createBrowserSession: (opts: {
      settings: Record<string, unknown>;
      guildId: string;
      channelId: string | null;
      userId: string | null;
      source: string;
    }) => SubAgentSession | null;
  };
  voiceSession?: {
    musicSearch: (query: string, limit: number) => Promise<Record<string, unknown>>;
    musicPlay: (query: string, selectionId?: string | null, platform?: string | null) => Promise<Record<string, unknown>>;
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
    playSoundboard: (refs: string[], transcript: string) => Promise<Record<string, unknown>>;
    setScreenNote: (note: string) => Promise<Record<string, unknown>>;
    setScreenMoment: (moment: string) => Promise<Record<string, unknown>>;
    leaveVoiceChannel: () => Promise<Record<string, unknown>>;
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
  guildId: string;
  channelId: string | null;
  userId: string;
  sourceMessageId: string;
  sourceText: string;
  botUserId?: string;
  actorName?: string;
  trace?: Record<string, unknown>;
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
  browser_browse: executeBrowserBrowse,
  memory_search: executeMemorySearch,
  memory_write: executeMemoryWrite,
  conversation_search: executeConversationSearch,
  image_lookup: async (input, _runtime, context) => await executeImageLookup(input, context),
  offer_screen_share_link: async (_input, runtime, context) => await executeOfferScreenShareLink(runtime, context),
  play_soundboard: executePlaySoundboard,
  screen_note: executeScreenNote,
  screen_moment: executeScreenMoment,
  join_voice_channel: async (_input, runtime, context) => await executeJoinVoiceChannel(runtime, context),
  leave_voice_channel: async (_input, runtime, context) => await executeLeaveVoiceChannel(runtime, context.signal),
  code_task: executeCodeTask,
  music_search: async (input, runtime, context) => await executeVoiceTool("music_search", input, runtime, context),
  music_play: async (input, runtime, context) => await executeVoiceTool("music_play", input, runtime, context),
  music_queue_add: async (input, runtime, context) => await executeVoiceTool("music_queue_add", input, runtime, context),
  music_queue_next: async (input, runtime, context) => await executeVoiceTool("music_queue_next", input, runtime, context),
  music_stop: async (input, runtime, context) => await executeVoiceTool("music_stop", input, runtime, context),
  music_pause: async (input, runtime, context) => await executeVoiceTool("music_pause", input, runtime, context),
  music_resume: async (input, runtime, context) => await executeVoiceTool("music_resume", input, runtime, context),
  music_reply_handoff: async (input, runtime, context) => await executeVoiceTool("music_reply_handoff", input, runtime, context),
  music_skip: async (input, runtime, context) => await executeVoiceTool("music_skip", input, runtime, context),
  music_now_playing: async (input, runtime, context) => await executeVoiceTool("music_now_playing", input, runtime, context)
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
    MAX_CONVERSATION_LOOKUP_QUERY_LEN
  );
  if (!query) {
    return { content: "Missing or empty conversation search query.", isError: true };
  }

  const scope = String(input?.scope || "channel").trim().toLowerCase();
  const searchChannelId = scope === "guild" ? null : context.channelId;
  const topK = Math.max(1, Math.min(4, Math.floor(Number(input?.top_k) || 3)));
  const maxAgeHours = Math.max(1, Math.min(24 * 30, Math.floor(Number(input?.max_age_hours) || 24 * 7)));

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
        before: 1,
        after: 1
      })
      : runtime.store.searchConversationWindows({
        guildId: context.guildId,
        channelId: searchChannelId,
        queryText: query,
        limit: topK,
        maxAgeHours,
        before: 1,
        after: 1
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
  const query = normalizeDirectiveText(
    String(input?.query || ""),
    MAX_WEB_QUERY_LEN
  );
  if (!query) {
    return { content: "Missing or empty search query.", isError: true };
  }
  if (!runtime.search?.searchAndRead) {
    return { content: "Web search is not available.", isError: true };
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
  const url = String(input?.url || "").trim().slice(0, MAX_WEB_SCRAPE_URL_LEN);
  if (!url) {
    return { content: "Missing or empty URL.", isError: true };
  }
  if (!runtime.search?.readPageSummary) {
    return { content: "Web scraping is not available.", isError: true };
  }

  const maxChars = Math.min(
    MAX_WEB_SCRAPE_MAX_CHARS,
    Math.max(350, Math.floor(Number(input?.max_chars) || MAX_WEB_SCRAPE_DEFAULT_CHARS))
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

async function executeBrowserBrowse(
  input: ReplyToolCallInput,
  runtime: ReplyToolRuntime,
  context: ReplyToolContext
): Promise<ReplyToolResult> {
  throwIfAborted(context.signal, "Reply tool cancelled");
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
  if (!runtime.memory?.searchDurableFacts) {
    return { content: "Memory search is not available.", isError: true };
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
      queryText: normalizeDirectiveText(String(input?.query || ""), MAX_MEMORY_LOOKUP_QUERY_LEN),
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
  if (
    !runtime.memory?.searchDurableFacts ||
    !runtime.memory?.rememberDirectiveLineDetailed
  ) {
    return { content: "Memory write is not available.", isError: true };
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
  context: ReplyToolContext
): Promise<ReplyToolResult> {
  throwIfAborted(context.signal, "Reply tool cancelled");
  const imageId = normalizeDirectiveText(
    String(input?.imageId || ""),
    MAX_IMAGE_LOOKUP_QUERY_LEN
  );
  const query = normalizeDirectiveText(
    String(input?.query || ""),
    MAX_IMAGE_LOOKUP_QUERY_LEN
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

async function executeOfferScreenShareLink(
  runtime: ReplyToolRuntime,
  context: ReplyToolContext
): Promise<ReplyToolResult> {
  throwIfAborted(context.signal, "Reply tool cancelled");
  if (!runtime.screenShare?.offerLink) {
    return { content: "Screen-share link offers are not available.", isError: true };
  }
  if (!context.guildId || !context.channelId || !context.userId) {
    return { content: "Screen-share context is incomplete.", isError: true };
  }

  try {
    const result = await runtime.screenShare.offerLink({
      settings: context.settings,
      guildId: context.guildId,
      channelId: context.channelId,
      requesterUserId: context.userId,
      transcript: context.sourceText,
      source: String(context.trace?.source || "reply_tool_offer_screen_share_link"),
      signal: context.signal
    });
    return {
      content: JSON.stringify({
        ok: Boolean(result?.offered || result?.reused),
        offered: Boolean(result?.offered),
        reused: Boolean(result?.reused),
        reason: result?.reason ? String(result.reason) : null,
        linkUrl: result?.linkUrl ? String(result.linkUrl) : null,
        expiresInMinutes: Number.isFinite(Number(result?.expiresInMinutes))
          ? Math.max(0, Math.round(Number(result.expiresInMinutes)))
          : null
      })
    };
  } catch (error) {
    return {
      content: `Screen-share link offer failed: ${String((error as Error)?.message || error)}`,
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
      .map((entry) => String(entry || "").trim().slice(0, 180))
      .filter(Boolean)
      .slice(0, 10)
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

async function executeScreenNote(
  input: ReplyToolCallInput,
  runtime: ReplyToolRuntime,
  context: ReplyToolContext
): Promise<ReplyToolResult> {
  throwIfAborted(context.signal, "Reply tool cancelled");
  if (!runtime.voiceSession?.setScreenNote) {
    return { content: "Screen notes are not available.", isError: true };
  }

  const note = String(input?.note || "").replace(/\s+/g, " ").trim().slice(0, 220);
  if (!note) {
    return { content: "Missing screen note.", isError: true };
  }

  try {
    const result = await runtime.voiceSession.setScreenNote(note);
    return {
      content: JSON.stringify({
        ok: Boolean(result?.ok),
        note: String(result?.note || note)
      }),
      isError: result?.ok === false
    };
  } catch (error) {
    return {
      content: `Screen note failed: ${String((error as Error)?.message || error)}`,
      isError: true
    };
  }
}

async function executeScreenMoment(
  input: ReplyToolCallInput,
  runtime: ReplyToolRuntime,
  context: ReplyToolContext
): Promise<ReplyToolResult> {
  throwIfAborted(context.signal, "Reply tool cancelled");
  if (!runtime.voiceSession?.setScreenMoment) {
    return { content: "Screen moments are not available.", isError: true };
  }

  const moment = String(input?.moment || "").replace(/\s+/g, " ").trim().slice(0, 220);
  if (!moment) {
    return { content: "Missing screen moment.", isError: true };
  }

  try {
    const result = await runtime.voiceSession.setScreenMoment(moment);
    return {
      content: JSON.stringify({
        ok: Boolean(result?.ok),
        moment: String(result?.moment || moment)
      }),
      isError: result?.ok === false
    };
  } catch (error) {
    return {
      content: `Screen moment failed: ${String((error as Error)?.message || error)}`,
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

async function executeCodeTask(
  input: ReplyToolCallInput,
  runtime: ReplyToolRuntime,
  context: ReplyToolContext
): Promise<ReplyToolResult> {
  throwIfAborted(context.signal, "Reply tool cancelled");
  const task = normalizeDirectiveText(
    String(input?.task || ""),
    MAX_CODE_TASK_LEN
  );
  const role = normalizeCodeAgentRole(input?.role, "implementation");
  if (!task) {
    return { content: "Missing or empty code task instruction.", isError: true };
  }

  const sessionId = typeof input?.session_id === "string" ? String(input.session_id).trim() : "";

  // --- Multi-turn session continuation ---
  if (sessionId && runtime.subAgentSessions) {
    const session = runtime.subAgentSessions.manager.get(sessionId);
    if (!session) {
      return { content: `Code session '${sessionId}' not found or expired.`, isError: true };
    }
    // Verify the caller owns this session
    if (session.ownerUserId && session.ownerUserId !== context.userId) {
      return { content: `Not authorized to continue code session '${sessionId}'.`, isError: true };
    }
    try {
      const turnResult = await session.runTurn(task, { signal: context.signal });
      const costNote = turnResult.costUsd ? ` (cost: $${turnResult.costUsd.toFixed(4)})` : "";
      const sessionNote = `\n\n[session_id: ${session.id}]`;
      if (turnResult.isError) {
        return { content: `Code task failed: ${turnResult.errorMessage}${costNote}${sessionNote}`, isError: true };
      }
      const text = turnResult.text.trim();
      return {
        content: (text ? `${text}${costNote}` : `Code task completed with no text result.${costNote}`) + sessionNote
      };
    } catch (error) {
      return { content: `Code task session failed: ${String((error as Error)?.message || error)}`, isError: true };
    }
  }

  // --- New interactive session (if session manager is available) ---
  if (runtime.subAgentSessions?.createCodeSession) {
    const session = runtime.subAgentSessions.createCodeSession({
      settings: context.settings,
      role,
      cwd: typeof input?.cwd === "string" ? String(input.cwd).trim() : undefined,
      guildId: context.guildId,
      channelId: context.channelId,
      userId: context.userId,
      source: String(context.trace?.source || "reply_tool_code_task")
    });

    if (session) {
      runtime.subAgentSessions.manager.register(session);
      try {
        const turnResult = await session.runTurn(task, { signal: context.signal });
        const costNote = turnResult.costUsd ? ` (cost: $${turnResult.costUsd.toFixed(4)})` : "";
        const sessionNote = `\n\n[session_id: ${session.id}]`;
        if (turnResult.isError) {
          return { content: `Code task failed: ${turnResult.errorMessage}${costNote}${sessionNote}`, isError: true };
        }
        const text = turnResult.text.trim();
        return {
          content: (text ? `${text}${costNote}` : `Code task completed with no text result.${costNote}`) + sessionNote
        };
      } catch (error) {
        return { content: `Code task failed: ${String((error as Error)?.message || error)}`, isError: true };
      }
    }
    // Fallback to one-shot if session creation returned null (e.g. blocked)
  }

  // --- One-shot fallback when session orchestration is unavailable ---
  if (!runtime.codeAgent?.runTask) {
    return { content: "Code agent is not available.", isError: true };
  }

  try {
    const result = await runtime.codeAgent.runTask({
      settings: context.settings,
      task,
      role,
      cwd: typeof input?.cwd === "string" ? String(input.cwd).trim() : undefined,
      guildId: context.guildId,
      channelId: context.channelId,
      userId: context.userId,
      source: String(context.trace?.source || "reply_tool_code_task"),
      signal: context.signal
    });

    if (result?.blockedByPermission) {
      return { content: "This capability is restricted to allowed users.", isError: true };
    }
    if (result?.blockedByBudget) {
      return { content: "Code agent is currently blocked by rate limits.", isError: true };
    }
    if (result?.blockedByParallelLimit) {
      return { content: "Too many code agent tasks are already running. Try again shortly.", isError: true };
    }
    if (result?.error) {
      return { content: `Code task failed: ${String(result.error)}`, isError: true };
    }

    const text = String(result?.text || "").trim();
    const costNote = result?.costUsd ? ` (cost: $${result.costUsd.toFixed(4)})` : "";
    return {
      content: text ? `${text}${costNote}` : `Code task completed with no text result.${costNote}`
    };
  } catch (error) {
    return {
      content: `Code task failed: ${String((error as Error)?.message || error)}`,
      isError: true
    };
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
        const limit = Math.max(1, Math.min(10, Math.floor(Number(input?.max_results) || 5)));
        throwIfAborted(context.signal, "Reply tool cancelled");
        result = await runtime.voiceSession.musicSearch(query, limit);
        break;
      }
      case "music_play": {
        const query = String(input?.query || "").trim().slice(0, MAX_VOICE_MUSIC_QUERY_LEN);
        const selectionId = String(input?.selection_id || "").trim().slice(0, MAX_VOICE_MUSIC_QUERY_LEN) || null;
        const platform = String(input?.platform || "").trim().slice(0, 32) || null;
        if (!query && !selectionId) {
          return { content: "Failed: query was empty. You must provide the song/artist name in the query argument.", isError: true };
        }
        throwIfAborted(context.signal, "Reply tool cancelled");
        result = await runtime.voiceSession.musicPlay(query, selectionId, platform);
        break;
      }
      case "music_queue_add": {
        const tracks = Array.isArray(input?.tracks)
          ? (input.tracks as string[]).map((t) => String(t).trim()).filter(Boolean).slice(0, 12)
          : [];
        const query = String(input?.query || "").trim().slice(0, MAX_VOICE_MUSIC_QUERY_LEN);
        const selectionId = String(input?.selection_id || "").trim().slice(0, MAX_VOICE_MUSIC_QUERY_LEN) || null;
        const platform = String(input?.platform || "").trim().slice(0, 32) || null;
        const maxResults = Math.max(1, Math.min(10, Math.floor(Number(input?.max_results) || 5)));
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
          ? (input.tracks as string[]).map((t) => String(t).trim()).filter(Boolean).slice(0, 12)
          : [];
        const query = String(input?.query || "").trim().slice(0, MAX_VOICE_MUSIC_QUERY_LEN);
        const selectionId = String(input?.selection_id || "").trim().slice(0, MAX_VOICE_MUSIC_QUERY_LEN) || null;
        const platform = String(input?.platform || "").trim().slice(0, 32) || null;
        const maxResults = Math.max(1, Math.min(10, Math.floor(Number(input?.max_results) || 5)));
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
      case "music_stop":
        throwIfAborted(context.signal, "Reply tool cancelled");
        result = await runtime.voiceSession.musicStop();
        break;
      case "music_pause":
        throwIfAborted(context.signal, "Reply tool cancelled");
        result = await runtime.voiceSession.musicPause();
        break;
      case "music_resume":
        throwIfAborted(context.signal, "Reply tool cancelled");
        result = await runtime.voiceSession.musicResume();
        break;
      case "music_reply_handoff": {
        const rawMode = String(input?.mode || "").trim().toLowerCase();
        const mode =
          rawMode === "pause" || rawMode === "duck" || rawMode === "none"
            ? rawMode
            : null;
        if (!mode) {
          return { content: "Invalid music reply handoff mode. Use pause, duck, or none.", isError: true };
        }
        throwIfAborted(context.signal, "Reply tool cancelled");
        result = await runtime.voiceSession.musicReplyHandoff(mode);
        break;
      }
      case "music_skip":
        throwIfAborted(context.signal, "Reply tool cancelled");
        result = await runtime.voiceSession.musicSkip();
        break;
      case "music_now_playing":
        throwIfAborted(context.signal, "Reply tool cancelled");
        result = await runtime.voiceSession.musicNowPlaying();
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
export type {
  ReplyToolDefinition,
  ReplyToolCallInput,
  ReplyToolResult
};
