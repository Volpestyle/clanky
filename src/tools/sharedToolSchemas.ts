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

// ── Canonical shared tool schemas ────────────────────────────────────
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
  description: "Fetch readable page text from a known URL, including a URL you just got from web_search. Prefer browser_browse when layout, screenshots, JS, or interaction matter.",
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
  description: "Browse a webpage interactively, including JS rendering, navigation, and screenshots. Pass session_id to continue a prior session.",
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
  description: "Search durable memory facts. Use namespace to scope to speaker, self, guild, or lore.",
  voiceContinuationPolicy: "always",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string" },
      top_k: { type: "integer", minimum: 1, maximum: 20 },
      namespace: { type: "string", description: "`speaker`, `self`, `guild`, or `lore`." },
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
  description: "Store durable memory facts. Save only long-lived useful facts or standing guidance, never secrets or throwaway chatter.",
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
              enum: ["preference", "profile", "relationship", "project", "guidance", "behavioral", "other"]
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

export const CONVERSATION_SEARCH_SCHEMA: SharedToolSchema = {
  name: "conversation_search",
  description: "Search saved conversation history to recall earlier exchanges, not durable facts.",
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

export const IMAGE_LOOKUP_SCHEMA: SharedToolSchema = {
  name: "image_lookup",
  description:
    "Look up a previously shared image from message history. Use a specific image ref like IMG 3 or a short query when the user refers to an earlier image/photo.",
  parameters: {
    type: "object",
    properties: {
      imageId: {
        type: "string",
        description: "Specific history image ref from chat context, for example IMG 3"
      },
      query: {
        type: "string",
        description: "Concise description of the image to find, or the image ref itself (max 220 chars). Provide imageId OR query."
      }
    },
    required: ["query"],
    additionalProperties: false
  }
};

export const CODE_TASK_SCHEMA: SharedToolSchema = {
  name: "code_task",
  description: "Run the configured coding worker on a coding task. Supports optional role routing and session continuation.",
  voiceContinuationPolicy: "always",
  parameters: {
    type: "object",
    properties: {
      task: { type: "string", description: "Detailed instruction for the configured coding worker." },
      role: {
        type: "string",
        enum: ["design", "implementation", "review", "research"],
        description: "Optional worker role to target. Defaults to implementation."
      },
      cwd: { type: "string", description: "Working directory. Defaults to configured project root." },
      session_id: { type: "string", description: "Session ID to continue a previous code session." }
    },
    required: ["task"],
    additionalProperties: false
  }
};

export const DISCOVERY_SOURCE_LIST_SCHEMA: SharedToolSchema = {
  name: "discovery_source_list",
  description: "List current discovery feed subscriptions and source-type capacity.",
  voiceContinuationPolicy: "always",
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false
  }
};

export const DISCOVERY_SOURCE_ADD_SCHEMA: SharedToolSchema = {
  name: "discovery_source_add",
  description: "Subscribe the passive discovery feed to a new source such as a subreddit, RSS feed, YouTube channel ID, or X handle.",
  voiceContinuationPolicy: "always",
  parameters: {
    type: "object",
    properties: {
      sourceType: {
        type: "string",
        enum: ["reddit", "rss", "youtube", "x"]
      },
      value: {
        type: "string",
        description: "Subreddit name, RSS feed URL, YouTube channel ID, or X handle."
      }
    },
    required: ["sourceType", "value"],
    additionalProperties: false
  }
};

export const DISCOVERY_SOURCE_REMOVE_SCHEMA: SharedToolSchema = {
  name: "discovery_source_remove",
  description: "Remove a current passive discovery source subscription.",
  voiceContinuationPolicy: "always",
  parameters: {
    type: "object",
    properties: {
      sourceType: {
        type: "string",
        enum: ["reddit", "rss", "youtube", "x"]
      },
      value: {
        type: "string",
        description: "Subreddit name, RSS feed URL, YouTube channel ID, or X handle."
      }
    },
    required: ["sourceType", "value"],
    additionalProperties: false
  }
};

const SHARED_TOOL_SCHEMAS: SharedToolSchema[] = [
  WEB_SEARCH_SCHEMA,
  WEB_SCRAPE_SCHEMA,
  BROWSER_BROWSE_SCHEMA,
  MEMORY_SEARCH_SCHEMA,
  MEMORY_WRITE_SCHEMA,
  CONVERSATION_SEARCH_SCHEMA,
  CODE_TASK_SCHEMA
];

// ── Voice-only tool schemas ─────────────────────────────────────────

export const MUSIC_SEARCH_SCHEMA: SharedToolSchema = {
  name: "music_search",
  description: "Search track candidates without starting playback. Prefer this for explicit browsing or when the user asks for options; ordinary play/queue requests can resolve directly from query.",
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
  description: "Append one or more tracks to the queue. You may pass direct query text, a prior selection_id, or exact track IDs from music_search/music_play.",
  voiceContinuationPolicy: "always",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Song, artist, or phrase to queue. Prefer this for ordinary queue requests."
      },
      selection_id: {
        type: "string",
        description: "Exact selection id returned from a previous music_play/music_search result. Leave empty when not reusing a prior selection."
      },
      tracks: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: 12
      },
      platform: {
        type: "string",
        enum: ["youtube", "soundcloud", "auto"]
      },
      max_results: {
        type: "integer"
      },
      position: {
        type: "string",
        description: "Queue position: \"end\" to append, or a zero-based index as a string (e.g. \"0\" for front)"
      }
    },
    additionalProperties: false
  }
};

export const MUSIC_PLAY_SCHEMA: SharedToolSchema = {
  name: "music_play",
  description: "Start playback from a query or prior selection_id. May return clarification choices when the request is ambiguous.",
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
  description: "Insert one or more tracks immediately after the current track. You may pass direct query text, a prior selection_id, or exact track IDs from music_search/music_play.",
  voiceContinuationPolicy: "always",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Song, artist, or phrase to queue next. Prefer this for ordinary queue-next requests."
      },
      selection_id: {
        type: "string",
        description: "Exact selection id returned from a previous music_play/music_search result. Leave empty when not reusing a prior selection."
      },
      tracks: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: 12
      },
      platform: {
        type: "string",
        enum: ["youtube", "soundcloud", "auto"]
      },
      max_results: {
        type: "integer"
      }
    },
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

export const MUSIC_REPLY_HANDOFF_SCHEMA: SharedToolSchema = {
  name: "music_reply_handoff",
  description: "Temporarily claim the floor for the current spoken reply by pausing or ducking active music. Runtime auto-restores playback when you finish. This is not a persistent playback command.",
  voiceContinuationPolicy: "always",
  parameters: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["pause", "duck", "none"],
        description: "\"pause\" fully pauses music for this reply, \"duck\" lowers music under this reply, \"none\" clears any pending temporary handoff."
      }
    },
    required: ["mode"],
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

const JOIN_VOICE_CHANNEL_SCHEMA: SharedToolSchema = {
  name: "join_voice_channel",
  description: "Join the requesting user's current voice channel.",
  voiceContinuationPolicy: "if_no_spoken_text",
  parameters: { type: "object", properties: {}, required: [], additionalProperties: false }
};

export const LEAVE_VOICE_CHANNEL_SCHEMA: SharedToolSchema = {
  name: "leave_voice_channel",
  description: "Leave the voice channel and end the current voice session.",
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

const NOTE_CONTEXT_SCHEMA: SharedToolSchema = {
  name: "note_context",
  description: "Pin important session-scoped context for later in the conversation. Avoid duplicates.",
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
  MUSIC_REPLY_HANDOFF_SCHEMA,
  MUSIC_SKIP_SCHEMA,
  MUSIC_NOW_PLAYING_SCHEMA,
  PLAY_SOUNDBOARD_SCHEMA,
  SCREEN_NOTE_SCHEMA,
  SCREEN_MOMENT_SCHEMA,
  NOTE_CONTEXT_SCHEMA,
  JOIN_VOICE_CHANNEL_SCHEMA,
  LEAVE_VOICE_CHANNEL_SCHEMA
];

const LOCAL_VOICE_CONTINUATION_SCHEMAS: SharedToolSchema[] = [
  ...SHARED_TOOL_SCHEMAS,
  ...VOICE_TOOL_SCHEMAS
];

const LOCAL_VOICE_CONTINUATION_SCHEMA_BY_NAME = new Map(
  LOCAL_VOICE_CONTINUATION_SCHEMAS.map((schema) => [schema.name, schema] as const)
);

function getLocalVoiceToolSchema(toolName: unknown): SharedToolSchema | null {
  const normalizedName = String(toolName || "").trim().toLowerCase();
  if (!normalizedName) return null;
  return LOCAL_VOICE_CONTINUATION_SCHEMA_BY_NAME.get(normalizedName) || null;
}

function resolveVoiceToolContinuationPolicy(
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
