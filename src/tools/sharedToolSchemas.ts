import type { VoiceRealtimeToolDescriptor } from "../voice/voiceSessionTypes.ts";

export interface SharedToolSchema {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

// ── 9 canonical shared tool schemas ──────────────────────────────────
// These are the single source of truth. Voice schemas are the tested
// superset so they are used as the canonical definition.

export const WEB_SEARCH_SCHEMA: SharedToolSchema = {
  name: "web_search",
  description: "Run live web search and return condensed results.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string" },
      recency_days: { type: "integer", minimum: 1, maximum: 3650 },
      max_results: { type: "integer", minimum: 1, maximum: 8 }
    },
    required: ["query"],
    additionalProperties: false
  }
};

export const WEB_SCRAPE_SCHEMA: SharedToolSchema = {
  name: "web_scrape",
  description: "Fetch and read a specific web page by URL. Returns extracted text content. Much faster than browser_browse. Only use browser_browse if this fails or the page needs JS/interaction.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "The full URL of the page to fetch and read." },
      max_chars: { type: "integer", description: "Maximum characters of page content to return (default 8000)." }
    },
    required: ["url"],
    additionalProperties: false
  }
};

export const BROWSER_BROWSE_SCHEMA: SharedToolSchema = {
  name: "browser_browse",
  description: "Browse a webpage interactively and report back with the result. Use only when web_scrape fails or you need to click, scroll, or interact with the page. Pass session_id to continue a previous session.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string" },
      session_id: { type: "string", description: "Session ID to continue a previous browser session." }
    },
    required: ["query"],
    additionalProperties: false
  }
};

export const MEMORY_SEARCH_SCHEMA: SharedToolSchema = {
  name: "memory_search",
  description: "Search durable memory facts. Use `namespace` = `speaker`, `self`, or `guild`.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string" },
      top_k: { type: "integer", minimum: 1, maximum: 20 },
      namespace: { type: "string" },
      filters: {
        type: "object",
        properties: {
          tags: {
            type: "array",
            items: { type: "string" }
          }
        },
        additionalProperties: false
      }
    },
    required: ["query"],
    additionalProperties: false
  }
};

export const MEMORY_WRITE_SCHEMA: SharedToolSchema = {
  name: "memory_write",
  description: "Store durable memory facts with dedupe and safety limits. Use `namespace` = `speaker`, `self`, or `guild`. Save only genuine long-lived facts, never insults, requests, or future-behavior rules.",
  parameters: {
    type: "object",
    properties: {
      namespace: { type: "string" },
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            text: { type: "string" }
          },
          required: ["text"],
          additionalProperties: false
        },
        minItems: 1,
        maxItems: 5
      },
      dedupe: {
        type: "object",
        properties: {
          strategy: { type: "string" },
          threshold: { type: "number", minimum: 0, maximum: 1 }
        },
        additionalProperties: false
      }
    },
    required: ["items"],
    additionalProperties: false
  }
};

export const ADAPTIVE_DIRECTIVE_ADD_SCHEMA: SharedToolSchema = {
  name: "adaptive_directive_add",
  description: "Persist a server-level adaptive directive for future conversations. Use for style guidance, operating guidance, or recurring trigger/action behavior, like how to talk or when to send a GIF/reaction.",
  parameters: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        enum: ["guidance", "behavior"]
      },
      note: { type: "string" }
    },
    required: ["note"],
    additionalProperties: false
  }
};

export const ADAPTIVE_DIRECTIVE_REMOVE_SCHEMA: SharedToolSchema = {
  name: "adaptive_directive_remove",
  description: "Remove a previously saved server-level adaptive directive when someone explicitly asks you to stop using it.",
  parameters: {
    type: "object",
    properties: {
      note_ref: { type: "string" },
      target: { type: "string" },
      reason: { type: "string" }
    },
    additionalProperties: false
  }
};

export const CONVERSATION_SEARCH_SCHEMA: SharedToolSchema = {
  name: "conversation_search",
  description: "Search past conversation history across saved text chat and voice transcripts. Use for recalling what was said earlier, not for durable facts.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string" },
      scope: {
        type: "string",
        enum: ["channel", "guild"]
      },
      top_k: { type: "integer", minimum: 1, maximum: 4 },
      max_age_hours: { type: "integer", minimum: 1, maximum: 720 }
    },
    required: ["query"],
    additionalProperties: false
  }
};

export const CODE_TASK_SCHEMA: SharedToolSchema = {
  name: "code_task",
  description: "Spawn Claude Code to perform a coding task. Can read/write files, run commands, use git, create PRs. Only available to allowed users. Pass session_id to continue a previous session.",
  parameters: {
    type: "object",
    properties: {
      task: { type: "string", description: "Detailed instruction for Claude Code." },
      cwd: { type: "string", description: "Working directory. Defaults to configured project root." },
      session_id: { type: "string", description: "Session ID to continue a previous code session." }
    },
    required: ["task"],
    additionalProperties: false
  }
};

export const SHARED_TOOL_SCHEMAS: SharedToolSchema[] = [
  WEB_SEARCH_SCHEMA,
  WEB_SCRAPE_SCHEMA,
  BROWSER_BROWSE_SCHEMA,
  MEMORY_SEARCH_SCHEMA,
  MEMORY_WRITE_SCHEMA,
  ADAPTIVE_DIRECTIVE_ADD_SCHEMA,
  ADAPTIVE_DIRECTIVE_REMOVE_SCHEMA,
  CONVERSATION_SEARCH_SCHEMA,
  CODE_TASK_SCHEMA
];

// ── Format adapters ──────────────────────────────────────────────────

/** Convert to Anthropic Claude API tool format (for replyTools.ts). */
export function toAnthropicTool(schema: SharedToolSchema): {
  name: string;
  description: string;
  input_schema: { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
} {
  return {
    name: schema.name,
    description: schema.description,
    input_schema: schema.parameters
  };
}

/** Convert to OpenAI/xAI realtime tool format (for voiceToolCalls.ts). */
export function toRealtimeTool(schema: SharedToolSchema): VoiceRealtimeToolDescriptor {
  return {
    toolType: "function",
    name: schema.name,
    description: schema.description,
    parameters: schema.parameters
  };
}
