import type { VoiceRealtimeToolDescriptor } from "../voice/voiceSessionTypes.ts";

export type VoiceToolContinuationPolicy = "always" | "if_no_spoken_text" | "never";

export interface SharedToolSchema {
  name: string;
  description: string;
  strict?: boolean;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{
      required: string[];
    }>;
    additionalProperties?: boolean;
  };
  voiceContinuationPolicy?: VoiceToolContinuationPolicy;
}

// ── 9 canonical shared tool schemas ──────────────────────────────────
// These are the single source of truth. Voice schemas are the tested
// superset so they are used as the canonical definition.

export const WEB_SEARCH_SCHEMA: SharedToolSchema = {
  name: "web_search",
  description: "Run live web search and return condensed results.",
  strict: true,
  voiceContinuationPolicy: "always",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query. Pull from the transcript or conversation context." },
      recency_days: { type: "integer", description: "Limit results to the last N days." },
      max_results: { type: "integer", description: "Maximum number of results to return (1-8)." }
    },
    required: ["query"],
    additionalProperties: false
  }
};

export const WEB_SCRAPE_SCHEMA: SharedToolSchema = {
  name: "web_scrape",
  description: "Fetch and read a specific web page by URL. Returns extracted text content. Much faster than browser_browse. Only use browser_browse if this fails or the page needs JS/interaction.",
  voiceContinuationPolicy: "always",
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
  description: "Browse a webpage interactively and report back with the result. Use only when web_scrape fails or you need to click, type, scroll, drag, or otherwise interact with the page. Pass session_id to continue a previous session.",
  voiceContinuationPolicy: "always",
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
  voiceContinuationPolicy: "always",
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
  description: "Store durable memory facts with dedupe and safety limits. Use `namespace` = `speaker`, `self`, or `guild`. Save only genuine long-lived facts, never insults, requests, or future-behavior rules. Set `type` when you know whether the fact is a preference, profile, relationship, project, or other durable fact.",
  voiceContinuationPolicy: "if_no_spoken_text",
  parameters: {
    type: "object",
    properties: {
      namespace: { type: "string" },
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            text: { type: "string" },
            type: {
              type: "string",
              enum: ["preference", "profile", "relationship", "project", "other"]
            }
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
  voiceContinuationPolicy: "if_no_spoken_text",
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
  voiceContinuationPolicy: "if_no_spoken_text",
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
  voiceContinuationPolicy: "always",
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
  voiceContinuationPolicy: "always",
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

// ── Voice-only tool schemas ─────────────────────────────────────────

export const MUSIC_SEARCH_SCHEMA: SharedToolSchema = {
  name: "music_search",
  description: "Search for candidate tracks without starting playback. Use this when the user wants options or when you need track IDs for queue operations. Do not use it when the user simply asked to play something now.",
  strict: true,
  voiceContinuationPolicy: "always",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Song, artist, or phrase to search for. Pull from the transcript or conversation context. Required."
      },
      max_results: { type: "integer" }
    },
    required: ["query"],
    additionalProperties: false
  }
};

export const MUSIC_QUEUE_ADD_SCHEMA: SharedToolSchema = {
  name: "music_queue_add",
  description: "Add one or more exact track IDs to the voice music queue. Use IDs returned by music_search or music_play disambiguation results, not a freeform query.",
  voiceContinuationPolicy: "if_no_spoken_text",
  parameters: {
    type: "object",
    properties: {
      tracks: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: 12
      },
      position: {
        type: "string",
        description: "Queue position: \"end\" to append, or a zero-based index as a string (e.g. \"0\" for front)"
      }
    },
    required: ["tracks"],
    additionalProperties: false
  }
};

export const MUSIC_PLAY_SCHEMA: SharedToolSchema = {
  name: "music_play",
  description: "Start playing music immediately from a natural-language query or a prior disambiguation selection. If the result is ambiguous, this tool returns clarification options for the same user to choose from.",
  strict: true,
  voiceContinuationPolicy: "always",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Song, artist, or phrase to play. Pull from the transcript or conversation context."
      },
      selection_id: {
        type: "string",
        description: "Exact selection id returned from a previous music_play or music_search result. Pass empty string when not selecting a prior result."
      },
      platform: {
        type: "string",
        enum: ["youtube", "soundcloud", "auto"]
      }
    },
    required: ["query"],
    additionalProperties: false
  }
};

export const MUSIC_QUEUE_NEXT_SCHEMA: SharedToolSchema = {
  name: "music_queue_next",
  description: "Insert one or more exact track IDs immediately after the current track. Use IDs returned by music_search or music_play disambiguation results, not a freeform query.",
  voiceContinuationPolicy: "if_no_spoken_text",
  parameters: {
    type: "object",
    properties: {
      tracks: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: 12
      }
    },
    required: ["tracks"],
    additionalProperties: false
  }
};

export const MUSIC_STOP_SCHEMA: SharedToolSchema = {
  name: "music_stop",
  description: "Stop playback and clear the active queue.",
  voiceContinuationPolicy: "if_no_spoken_text",
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false
  }
};

export const MUSIC_PAUSE_SCHEMA: SharedToolSchema = {
  name: "music_pause",
  description: "Pause music playback.",
  voiceContinuationPolicy: "if_no_spoken_text",
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false
  }
};

export const MUSIC_RESUME_SCHEMA: SharedToolSchema = {
  name: "music_resume",
  description: "Resume paused music playback.",
  voiceContinuationPolicy: "if_no_spoken_text",
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false
  }
};

export const MUSIC_SKIP_SCHEMA: SharedToolSchema = {
  name: "music_skip",
  description: "Skip current track and advance to next queued track.",
  voiceContinuationPolicy: "if_no_spoken_text",
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false
  }
};

export const MUSIC_NOW_PLAYING_SCHEMA: SharedToolSchema = {
  name: "music_now_playing",
  description: "Read now-playing and queue status.",
  voiceContinuationPolicy: "always",
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false
  }
};

export const LEAVE_VOICE_CHANNEL_SCHEMA: SharedToolSchema = {
  name: "leave_voice_channel",
  description: "Leave the voice channel and end this session. Only call this when you intentionally choose to end your own VC session — another person saying goodbye does not require you to leave.",
  voiceContinuationPolicy: "if_no_spoken_text",
  parameters: { type: "object", properties: {}, required: [], additionalProperties: false }
};

export const OFFER_SCREEN_SHARE_LINK_SCHEMA: SharedToolSchema = {
  name: "offer_screen_share_link",
  description: "Send the active speaker a temporary screen-share link in the text channel so they can start sharing their screen.",
  voiceContinuationPolicy: "if_no_spoken_text",
  parameters: { type: "object", properties: {}, required: [], additionalProperties: false }
};

export const PLAY_SOUNDBOARD_SCHEMA: SharedToolSchema = {
  name: "play_soundboard",
  description: "Play one or more soundboard refs in the current voice session, in order.",
  voiceContinuationPolicy: "if_no_spoken_text",
  parameters: {
    type: "object",
    properties: {
      refs: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: 10
      }
    },
    required: ["refs"],
    additionalProperties: false
  }
};

export const SCREEN_NOTE_SCHEMA: SharedToolSchema = {
  name: "screen_note",
  description: "Save a brief private factual note about the current visible screen state.",
  voiceContinuationPolicy: "if_no_spoken_text",
  parameters: {
    type: "object",
    properties: {
      note: {
        type: "string",
        minLength: 1,
        maxLength: 220
      }
    },
    required: ["note"],
    additionalProperties: false
  }
};

export const SCREEN_MOMENT_SCHEMA: SharedToolSchema = {
  name: "screen_moment",
  description: "Save a brief noteworthy screen moment that should persist in session memory.",
  voiceContinuationPolicy: "if_no_spoken_text",
  parameters: {
    type: "object",
    properties: {
      moment: {
        type: "string",
        minLength: 1,
        maxLength: 220
      }
    },
    required: ["moment"],
    additionalProperties: false
  }
};

export const NOTE_CONTEXT_SCHEMA: SharedToolSchema = {
  name: "note_context",
  description: "Pin important session-scoped context that should stay available later in this conversation even after older turns scroll out. Do not duplicate notes already pinned.",
  voiceContinuationPolicy: "if_no_spoken_text",
  parameters: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "The important fact or context to pin for the rest of this session."
      },
      category: {
        type: "string",
        enum: ["fact", "plan", "preference", "relationship"],
        description: "What kind of session context this note represents."
      }
    },
    required: ["text"],
    additionalProperties: false
  }
};

export const VOICE_TOOL_SCHEMAS: SharedToolSchema[] = [
  MUSIC_SEARCH_SCHEMA,
  MUSIC_PLAY_SCHEMA,
  MUSIC_QUEUE_ADD_SCHEMA,
  MUSIC_QUEUE_NEXT_SCHEMA,
  MUSIC_STOP_SCHEMA,
  MUSIC_PAUSE_SCHEMA,
  MUSIC_RESUME_SCHEMA,
  MUSIC_SKIP_SCHEMA,
  MUSIC_NOW_PLAYING_SCHEMA,
  PLAY_SOUNDBOARD_SCHEMA,
  SCREEN_NOTE_SCHEMA,
  SCREEN_MOMENT_SCHEMA,
  NOTE_CONTEXT_SCHEMA,
  LEAVE_VOICE_CHANNEL_SCHEMA
];

export const OPEN_ARTICLE_SCHEMA: SharedToolSchema = {
  name: "open_article",
  description: "Open and read a previously found web article. Use when the user asks to read/open/click a cached article from a prior web search.",
  voiceContinuationPolicy: "always",
  parameters: {
    type: "object",
    properties: {
      ref: {
        type: "string",
        description: "Article reference — a row:col ref (e.g. r1:2), an index number, or a URL from cached results"
      }
    },
    required: ["ref"],
    additionalProperties: false
  }
};

const LOCAL_VOICE_CONTINUATION_SCHEMAS: SharedToolSchema[] = [
  ...SHARED_TOOL_SCHEMAS,
  ...VOICE_TOOL_SCHEMAS,
  OPEN_ARTICLE_SCHEMA
];

const LOCAL_VOICE_CONTINUATION_SCHEMA_BY_NAME = new Map(
  LOCAL_VOICE_CONTINUATION_SCHEMAS.map((schema) => [schema.name, schema] as const)
);

export function getLocalVoiceToolSchema(toolName: unknown): SharedToolSchema | null {
  const normalizedName = String(toolName || "").trim().toLowerCase();
  if (!normalizedName) return null;
  return LOCAL_VOICE_CONTINUATION_SCHEMA_BY_NAME.get(normalizedName) || null;
}

export function resolveVoiceToolContinuationPolicy(
  toolName: unknown,
  { toolType = "function" }: { toolType?: "function" | "mcp" } = {}
): VoiceToolContinuationPolicy {
  if (toolType === "mcp") return "always";
  return getLocalVoiceToolSchema(toolName)?.voiceContinuationPolicy || "if_no_spoken_text";
}

export function shouldRequestVoiceToolFollowup(
  toolName: unknown,
  {
    toolType = "function",
    hasSpokenText = false
  }: {
    toolType?: "function" | "mcp";
    hasSpokenText?: boolean;
  } = {}
): boolean {
  const continuationPolicy = resolveVoiceToolContinuationPolicy(toolName, { toolType });
  if (continuationPolicy === "always") return true;
  if (continuationPolicy === "never") return false;
  return !hasSpokenText;
}

// ── Format adapters ──────────────────────────────────────────────────

/** Convert to Anthropic Claude API tool format (for replyTools.ts). */
export function toAnthropicTool(schema: SharedToolSchema): {
  name: string;
  description: string;
  strict?: boolean;
  input_schema: { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
} {
  return {
    name: schema.name,
    description: schema.description,
    ...(schema.strict ? { strict: true } : {}),
    input_schema: schema.parameters
  };
}

/** Convert to OpenAI/xAI realtime tool format (for voiceToolCalls.ts). */
export function toRealtimeTool(schema: SharedToolSchema): VoiceRealtimeToolDescriptor {
  return {
    toolType: "function",
    name: schema.name,
    description: schema.description,
    parameters: schema.parameters,
    continuationPolicy: schema.voiceContinuationPolicy || "if_no_spoken_text"
  };
}
