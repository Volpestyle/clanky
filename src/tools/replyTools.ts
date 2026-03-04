import type Anthropic from "@anthropic-ai/sdk";
import { normalizeDirectiveText } from "../botHelpers.ts";
import {
  executeSharedAdaptiveDirectiveAdd,
  executeSharedAdaptiveDirectiveRemove
} from "../adaptiveDirectives/adaptiveDirectiveToolRuntime.ts";
import {
  executeSharedMemoryToolSearch,
  executeSharedMemoryToolWrite
} from "../memory/memoryToolRuntime.ts";
import { formatConversationWindows } from "../prompts/promptFormatters.ts";
import type { SubAgentSessionManager, SubAgentSession } from "../agents/subAgentSession.ts";

const MAX_WEB_QUERY_LEN = 220;
const MAX_MEMORY_LOOKUP_QUERY_LEN = 220;
const MAX_CONVERSATION_LOOKUP_QUERY_LEN = 220;
const MAX_IMAGE_LOOKUP_QUERY_LEN = 220;
const MAX_BROWSER_BROWSE_QUERY_LEN = 500;
const MAX_CODE_TASK_LEN = 2000;
const MAX_OPEN_ARTICLE_REF_LEN = 260;

interface ReplyToolDefinition {
  name: string;
  description: string;
  input_schema: Anthropic.Tool.InputSchema;
}

interface ReplyToolCallInput {
  [key: string]: unknown;
}

interface ReplyToolResult {
  content: string;
  isError?: boolean;
}

type ReplyToolRuntime = {
  search?: {
    searchAndRead: (opts: {
      settings: Record<string, unknown>;
      query: string;
      trace: Record<string, unknown>;
    }) => Promise<{
      query: string;
      results: Array<Record<string, unknown>>;
      fetchedPages?: number;
      providerUsed?: string | null;
      providerFallbackUsed?: boolean;
    }>;
    readPageSummary?: (url: string, maxChars: number) => Promise<{
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
    }) => Promise<{
      used?: boolean;
      text?: string;
      steps?: number;
      hitStepLimit?: boolean;
      error?: string | null;
      blockedByBudget?: boolean;
    }>;
  };
  codeAgent?: {
    runTask: (opts: {
      settings: Record<string, unknown>;
      task: string;
      cwd?: string;
      guildId: string;
      channelId: string | null;
      userId: string | null;
      source: string;
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
      settings: Record<string, unknown>;
      trace: Record<string, unknown>;
      limit?: number;
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
    getActiveAdaptiveStyleNotes?: (guildId: string, limit?: number) => Array<Record<string, unknown>>;
    searchAdaptiveStyleNotesForPrompt?: (opts: {
      guildId: string;
      queryText?: string;
      limit?: number;
    }) => Array<Record<string, unknown>>;
    addAdaptiveStyleNote?: (opts: {
      guildId: string;
      directiveKind?: string;
      noteText: string;
      actorUserId?: string | null;
      actorName?: string | null;
      sourceMessageId?: string | null;
      sourceText?: string | null;
      source?: string;
    }) => {
      ok: boolean;
      error?: string;
      status?: string;
      note?: Record<string, unknown> | null;
    };
    removeAdaptiveStyleNote?: (opts: {
      noteId: number;
      guildId: string;
      actorUserId?: string | null;
      actorName?: string | null;
      removalReason?: string | null;
      source?: string;
    }) => {
      ok: boolean;
      error?: string;
      status?: string;
      note?: Record<string, unknown> | null;
    };
  };
  subAgentSessions?: {
    manager: SubAgentSessionManager;
    createCodeSession: (opts: {
      settings: Record<string, unknown>;
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
};

type ReplyToolContext = {
  settings: Record<string, unknown>;
  guildId: string;
  channelId: string | null;
  userId: string;
  sourceMessageId: string;
  sourceText: string;
  botUserId?: string;
  actorName?: string;
  trace?: Record<string, unknown>;
};

// --- Tool definitions ---

const WEB_SEARCH_TOOL: ReplyToolDefinition = {
  name: "web_search",
  description:
    "Search the live web for current information. Returns condensed search results with titles, snippets, and page summaries. Use when the reply needs fresh or factual web info.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Concise search query (max 220 chars)"
      }
    },
    required: ["query"]
  }
};

const BROWSER_BROWSE_TOOL: ReplyToolDefinition = {
  name: "browser_browse",
  description:
    "Browse the web interactively with a headless browser agent and report back with the result. Use for tasks that need clicking, navigating, scrolling, or reading dynamic page content beyond normal web search. Pass session_id to continue a previous interactive session.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Instruction for what to browse and find out (max 500 chars). For follow-up turns, this is the continuation message."
      },
      session_id: {
        type: "string",
        description: "Session ID from a previous browser_browse result. Pass this to continue an interactive multi-turn session instead of starting a new one."
      }
    },
    required: ["query"]
  }
};

const MEMORY_SEARCH_TOOL: ReplyToolDefinition = {
  name: "memory_search",
  description:
    'Search durable memory. Set `namespace` to `speaker`, `self`, or `guild` (or `user:<current speaker id>` / `guild:<current guild id>`). Use `query="__ALL__"` to list everything in that namespace.',
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          'Concise lookup query (max 220 chars). Use "__ALL__" to retrieve everything remembered.'
      },
      namespace: {
        type: "string",
        description: "Memory namespace: `speaker`, `self`, `guild`, `user:<current speaker id>`, or `guild:<current guild id>`."
      }
    },
    required: ["query"]
  }
};

const MEMORY_WRITE_TOOL: ReplyToolDefinition = {
  name: "memory_write",
  description:
    "Store one or more durable facts to long-term memory. Set `namespace` to `speaker`, `self`, or `guild`. Only store genuinely durable facts, not throwaway chatter, requests, insults, or future-behavior rules.",
  input_schema: {
    type: "object",
    properties: {
      namespace: {
        type: "string",
        description: "Memory namespace: `speaker`, `self`, `guild`, `user:<current speaker id>`, or `guild:<current guild id>`."
      },
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description: "The fact to remember (max 180 chars)"
            }
          },
          required: ["text"]
        },
        minItems: 1,
        maxItems: 5
      }
    },
    required: ["items"]
  }
};

const CONVERSATION_SEARCH_TOOL: ReplyToolDefinition = {
  name: "conversation_search",
  description:
    "Search past conversation history across saved text chat and voice transcripts. Returns short windows of what people previously said. Use for continuity and recall of prior exchanges, not for durable facts.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Concise lookup query describing the earlier conversation to find (max 220 chars)"
      },
      scope: {
        type: "string",
        description: "Search scope: `channel` for the current channel history or `guild` for all saved channels in this server."
      },
      top_k: {
        type: "integer",
        description: "Number of conversation windows to return (1-4)"
      },
      max_age_hours: {
        type: "integer",
        description: "Maximum age of messages to consider in hours (1-720)"
      }
    },
    required: ["query"]
  }
};

const ADAPTIVE_STYLE_ADD_TOOL: ReplyToolDefinition = {
  name: "adaptive_directive_add",
  description:
    "Persist a server-level adaptive directive for future conversations. Use for style guidance, operating guidance, or recurring trigger/action behavior, like how to talk or when to send a GIF/reaction. Keep the directive concise, usually 1-2 sentences max.",
  input_schema: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        description: "Directive kind: `guidance` for style/tone/persona guidance, or `behavior` for recurring trigger/action behavior."
      },
      note: {
        type: "string",
        description: "The persistent directive to save (max 420 chars)."
      }
    },
    required: ["note"]
  }
};

const ADAPTIVE_STYLE_REMOVE_TOOL: ReplyToolDefinition = {
  name: "adaptive_directive_remove",
  description:
    "Remove an active server-level adaptive directive when someone explicitly asks you to stop using it or undo a prior recurring behavior. Prefer `note_ref` from the prompt when available.",
  input_schema: {
    type: "object",
    properties: {
      note_ref: {
        type: "string",
        description: "Preferred exact note reference from prompt context, like `S12`."
      },
      target: {
        type: "string",
        description: "Fallback text describing the directive to remove."
      },
      reason: {
        type: "string",
        description: "Short reason or quoted request for removal."
      }
    }
  }
};

const IMAGE_LOOKUP_TOOL: ReplyToolDefinition = {
  name: "image_lookup",
  description:
    "Look up a previously shared image from message history. Use when the user refers to an earlier image/photo.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Concise description of the image to find (max 220 chars)"
      }
    },
    required: ["query"]
  }
};

const OPEN_ARTICLE_TOOL: ReplyToolDefinition = {
  name: "open_article",
  description:
    "Open and read a previously found web article. Use when the user asks to read/open/click a cached article from a prior web search.",
  input_schema: {
    type: "object",
    properties: {
      ref: {
        type: "string",
        description:
          "Article reference — a row:col ref (e.g. r1:2), an index number, or a URL from cached results"
      }
    },
    required: ["ref"]
  }
};

const CODE_TASK_TOOL: ReplyToolDefinition = {
  name: "code_task",
  description:
    "Spawn Claude Code to perform a coding task in a project directory. Can read/write files, run commands, use git, create PRs. Only available to allowed users. Pass session_id to continue a previous interactive session.",
  input_schema: {
    type: "object",
    properties: {
      task: {
        type: "string",
        description: "Detailed instruction for what Claude Code should do. Be specific — include repo context, file paths, issue numbers, expected behavior. For follow-up turns, this is the continuation message."
      },
      cwd: {
        type: "string",
        description: "Working directory for the task. Defaults to the configured project root if omitted."
      },
      session_id: {
        type: "string",
        description: "Session ID from a previous code_task result. Pass this to continue an interactive multi-turn session instead of starting a new one."
      }
    },
    required: ["task"]
  }
};

const ALL_REPLY_TOOLS: ReplyToolDefinition[] = [
  WEB_SEARCH_TOOL,
  BROWSER_BROWSE_TOOL,
  MEMORY_SEARCH_TOOL,
  MEMORY_WRITE_TOOL,
  ADAPTIVE_STYLE_ADD_TOOL,
  ADAPTIVE_STYLE_REMOVE_TOOL,
  CONVERSATION_SEARCH_TOOL,
  IMAGE_LOOKUP_TOOL,
  OPEN_ARTICLE_TOOL,
  CODE_TASK_TOOL
];

// --- Settings-gated tool set builder ---

function isMemoryEnabled(settings: Record<string, unknown>): boolean {
  const memory = settings?.memory as Record<string, unknown> | undefined;
  return Boolean(memory?.enabled);
}

function isAdaptiveDirectivesEnabled(settings: Record<string, unknown>): boolean {
  const adaptiveDirectives = settings?.adaptiveDirectives as Record<string, unknown> | undefined;
  return Boolean(adaptiveDirectives?.enabled);
}

function isWebSearchEnabled(settings: Record<string, unknown>): boolean {
  const webSearch = settings?.webSearch as Record<string, unknown> | undefined;
  return Boolean(webSearch?.enabled);
}

function isBrowserBrowseEnabled(settings: Record<string, unknown>): boolean {
  const browser = settings?.browser as Record<string, unknown> | undefined;
  return Boolean(browser?.enabled);
}

function isCodeAgentEnabled(settings: Record<string, unknown>): boolean {
  const codeAgent = settings?.codeAgent as Record<string, unknown> | undefined;
  return Boolean(codeAgent?.enabled);
}

export function buildReplyToolSet(
  settings: Record<string, unknown>,
  capabilities: {
    webSearchAvailable?: boolean;
    browserBrowseAvailable?: boolean;
    memoryAvailable?: boolean;
    adaptiveDirectivesAvailable?: boolean;
    conversationSearchAvailable?: boolean;
    imageLookupAvailable?: boolean;
    openArticleAvailable?: boolean;
    codeAgentAvailable?: boolean;
  } = {}
): ReplyToolDefinition[] {
  const tools: ReplyToolDefinition[] = [];

  if (
    capabilities.webSearchAvailable !== false &&
    isWebSearchEnabled(settings)
  ) {
    tools.push(WEB_SEARCH_TOOL);
  }

  if (
    capabilities.browserBrowseAvailable !== false &&
    isBrowserBrowseEnabled(settings)
  ) {
    tools.push(BROWSER_BROWSE_TOOL);
  }

  const memoryEnabled = isMemoryEnabled(settings);
  if (capabilities.memoryAvailable !== false && memoryEnabled) {
    tools.push(MEMORY_SEARCH_TOOL);
    tools.push(MEMORY_WRITE_TOOL);
  }

  const adaptiveDirectivesEnabled = isAdaptiveDirectivesEnabled(settings);
  if (capabilities.adaptiveDirectivesAvailable !== false && adaptiveDirectivesEnabled) {
    tools.push(ADAPTIVE_STYLE_ADD_TOOL);
    tools.push(ADAPTIVE_STYLE_REMOVE_TOOL);
  }

  if (capabilities.conversationSearchAvailable !== false) {
    tools.push(CONVERSATION_SEARCH_TOOL);
  }

  if (capabilities.imageLookupAvailable) {
    tools.push(IMAGE_LOOKUP_TOOL);
  }

  if (capabilities.openArticleAvailable) {
    tools.push(OPEN_ARTICLE_TOOL);
  }

  if (
    capabilities.codeAgentAvailable !== false &&
    isCodeAgentEnabled(settings)
  ) {
    tools.push(CODE_TASK_TOOL);
  }

  return tools;
}

// --- Tool executor ---

export async function executeReplyTool(
  toolName: string,
  input: ReplyToolCallInput,
  runtime: ReplyToolRuntime,
  context: ReplyToolContext
): Promise<ReplyToolResult> {
  switch (toolName) {
    case "web_search":
      return executeWebSearch(input, runtime, context);
    case "browser_browse":
      return executeBrowserBrowse(input, runtime, context);
    case "memory_search":
      return executeMemorySearch(input, runtime, context);
    case "memory_write":
      return executeMemoryWrite(input, runtime, context);
    case "conversation_search":
      return executeConversationSearch(input, runtime, context);
    case "adaptive_directive_add":
      return executeAdaptiveStyleAdd(input, runtime, context);
    case "adaptive_directive_remove":
      return executeAdaptiveStyleRemove(input, runtime, context);
    case "image_lookup":
      return executeImageLookup(input, context);
    case "open_article":
      return executeOpenArticle(input, runtime, context);
    case "code_task":
      return executeCodeTask(input, runtime, context);
    default:
      return { content: `Unknown tool: ${toolName}`, isError: true };
  }
}

async function executeConversationSearch(
  input: ReplyToolCallInput,
  runtime: ReplyToolRuntime,
  context: ReplyToolContext
): Promise<ReplyToolResult> {
  if (!runtime.store?.searchConversationWindows) {
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
    const windows = runtime.store.searchConversationWindows({
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
      }
    });

    if (!result.results?.length) {
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

    return { content: `Web results for "${query}":\n\n${formatted}` };
  } catch (error) {
    return {
      content: `Web search failed: ${String((error as Error)?.message || error)}`,
      isError: true
    };
  }
}

async function executeBrowserBrowse(
  input: ReplyToolCallInput,
  runtime: ReplyToolRuntime,
  context: ReplyToolContext
): Promise<ReplyToolResult> {
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
    try {
      const turnResult = await session.runTurn(query);
      const sessionNote = `\n\n[session_id: ${session.id}]`;
      if (turnResult.isError) {
        return { content: `Browser browse failed: ${turnResult.errorMessage}${sessionNote}`, isError: true };
      }
      return { content: (turnResult.text.trim() || "Browser browse completed.") + sessionNote };
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
        const turnResult = await session.runTurn(query);
        const sessionNote = `\n\n[session_id: ${session.id}]`;
        if (turnResult.isError) {
          return { content: `Browser browse failed: ${turnResult.errorMessage}${sessionNote}`, isError: true };
        }
        return { content: (turnResult.text.trim() || "Browser browse completed.") + sessionNote };
      } catch (error) {
        return { content: `Browser browse failed: ${String((error as Error)?.message || error)}`, isError: true };
      }
    }
    // Fallback to one-shot if session creation returned null
  }

  // --- Legacy one-shot fallback ---
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
      source: String(context.trace?.source || "reply_tool_browser_browse")
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
      content: suffix ? `${summary}\n\n${suffix}` : summary || "Browser browse completed with no text result."
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

async function executeAdaptiveStyleAdd(
  input: ReplyToolCallInput,
  runtime: ReplyToolRuntime,
  context: ReplyToolContext
): Promise<ReplyToolResult> {
  if (!runtime.store?.getActiveAdaptiveStyleNotes || !runtime.store?.addAdaptiveStyleNote) {
    return { content: "Adaptive directives are not available.", isError: true };
  }
  const result = await executeSharedAdaptiveDirectiveAdd({
    runtime: {
      store: {
        getActiveAdaptiveStyleNotes: runtime.store.getActiveAdaptiveStyleNotes,
        addAdaptiveStyleNote: runtime.store.addAdaptiveStyleNote,
        removeAdaptiveStyleNote: runtime.store.removeAdaptiveStyleNote || (() => ({ ok: false, error: "unavailable" }))
      }
    },
    guildId: context.guildId,
    actorUserId: context.userId,
    actorName: context.actorName || null,
    sourceMessageId: context.sourceMessageId,
    sourceText: context.sourceText,
    directiveKind: typeof input?.kind === "string" ? input.kind : null,
    noteText: input?.note,
    source: "reply_tool"
  });
  if (!result.ok) {
    return {
      content: `Adaptive directive add failed: ${String(result.error || "unknown_error")}`,
      isError: true
    };
  }
  const noteText = String(result.note?.noteText || input?.note || "").trim();
  const kindLabel = String(result.note?.directiveKind || input?.kind || "guidance").trim();
  if (result.status === "duplicate_active") {
    return { content: `Adaptive directive already active [${kindLabel}]: ${noteText}` };
  }
  if (result.status === "reactivated") {
    return { content: `Reactivated adaptive directive [${kindLabel}]: ${noteText}` };
  }
  return { content: `Saved adaptive directive [${kindLabel}]: ${noteText}` };
}

async function executeAdaptiveStyleRemove(
  input: ReplyToolCallInput,
  runtime: ReplyToolRuntime,
  context: ReplyToolContext
): Promise<ReplyToolResult> {
  if (!runtime.store?.getActiveAdaptiveStyleNotes || !runtime.store?.removeAdaptiveStyleNote) {
    return { content: "Adaptive directives are not available.", isError: true };
  }
  const result = await executeSharedAdaptiveDirectiveRemove({
    runtime: {
      store: {
        getActiveAdaptiveStyleNotes: runtime.store.getActiveAdaptiveStyleNotes,
        addAdaptiveStyleNote: runtime.store.addAdaptiveStyleNote || (() => ({ ok: false, error: "unavailable" })),
        removeAdaptiveStyleNote: runtime.store.removeAdaptiveStyleNote
      }
    },
    guildId: context.guildId,
    actorUserId: context.userId,
    actorName: context.actorName || null,
    sourceMessageId: context.sourceMessageId,
    sourceText: context.sourceText,
    noteRef: input?.note_ref,
    target: input?.target,
    removalReason: input?.reason,
    source: "reply_tool"
  });
  if (!result.ok) {
    return {
      content: `Adaptive directive remove failed: ${String(result.error || "unknown_error")}`,
      isError: true
    };
  }
  return {
    content: `Removed adaptive directive (${String(result.matchReason || "match")}): ${String(result.note?.noteText || "").trim()}`
  };
}

async function executeImageLookup(
  input: ReplyToolCallInput,
  _context: ReplyToolContext
): Promise<ReplyToolResult> {
  const query = normalizeDirectiveText(
    String(input?.query || ""),
    MAX_IMAGE_LOOKUP_QUERY_LEN
  );
  if (!query) {
    return { content: "Missing or empty image lookup query.", isError: true };
  }
  // Image lookup is handled by the caller since it needs access to
  // message history image candidates which are passed at the call site.
  // This tool returns a placeholder that the caller intercepts.
  return {
    content: `__IMAGE_LOOKUP_REQUEST__:${query}`
  };
}

async function executeOpenArticle(
  input: ReplyToolCallInput,
  runtime: ReplyToolRuntime,
  _context: ReplyToolContext
): Promise<ReplyToolResult> {
  const ref = normalizeDirectiveText(
    String(input?.ref || ""),
    MAX_OPEN_ARTICLE_REF_LEN
  );
  if (!ref) {
    return { content: "Missing or empty article reference.", isError: true };
  }
  if (!runtime.search?.readPageSummary) {
    return { content: "Article reading is not available.", isError: true };
  }
  // Open article also needs the caller to resolve the ref from cached
  // candidates. Return a placeholder.
  return {
    content: `__OPEN_ARTICLE_REQUEST__:${ref}`
  };
}

async function executeCodeTask(
  input: ReplyToolCallInput,
  runtime: ReplyToolRuntime,
  context: ReplyToolContext
): Promise<ReplyToolResult> {
  const task = normalizeDirectiveText(
    String(input?.task || ""),
    MAX_CODE_TASK_LEN
  );
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
    try {
      const turnResult = await session.runTurn(task);
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
      cwd: typeof input?.cwd === "string" ? String(input.cwd).trim() : undefined,
      guildId: context.guildId,
      channelId: context.channelId,
      userId: context.userId,
      source: String(context.trace?.source || "reply_tool_code_task")
    });

    if (session) {
      runtime.subAgentSessions.manager.register(session);
      try {
        const turnResult = await session.runTurn(task);
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

  // --- Legacy one-shot fallback ---
  if (!runtime.codeAgent?.runTask) {
    return { content: "Code agent is not available.", isError: true };
  }

  try {
    const result = await runtime.codeAgent.runTask({
      settings: context.settings,
      task,
      cwd: typeof input?.cwd === "string" ? String(input.cwd).trim() : undefined,
      guildId: context.guildId,
      channelId: context.channelId,
      userId: context.userId,
      source: String(context.trace?.source || "reply_tool_code_task")
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

export {
  ALL_REPLY_TOOLS,
  WEB_SEARCH_TOOL,
  MEMORY_SEARCH_TOOL,
  MEMORY_WRITE_TOOL,
  IMAGE_LOOKUP_TOOL,
  OPEN_ARTICLE_TOOL,
  CODE_TASK_TOOL
};

export type {
  ReplyToolDefinition,
  ReplyToolCallInput,
  ReplyToolResult,
  ReplyToolRuntime,
  ReplyToolContext
};
