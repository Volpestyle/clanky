import type { VoiceRealtimeToolDescriptor } from "../voice/voiceSessionTypes.ts";

export type VoiceToolContinuationPolicy = "always" | "fire_and_forget";

export interface SharedToolSchema {
  name: string;
  description: string;
  strict?: boolean;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<Record<string, unknown>>;
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
  description: "Search durable memory facts. Namespace can target speaker/user, bot self, guild lore, or a specific user.",
  voiceContinuationPolicy: "always",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string" },
      top_k: { type: "integer", minimum: 1, maximum: 20 },
      namespace: {
        type: "string",
        description: "Optional. Examples: `speaker`, `self`, `guild`, `lore`, `user:<discord_user_id>`."
      },
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
  voiceContinuationPolicy: "fire_and_forget",
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

export const VIDEO_CONTEXT_SCHEMA: SharedToolSchema = {
  name: "video_context",
  description: "Extract metadata, transcript, and keyframes from a video URL (YouTube, TikTok, X/Twitter, Reddit, Twitch, Streamable, or any yt-dlp-supported source). Returns structured data including title, channel, duration, transcript text, and optional keyframe images. Prefer this over web_scrape or browser_browse when you want video-specific content like transcripts.",
  voiceContinuationPolicy: "always",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The full URL of the video to extract context from."
      },
      videoRef: {
        type: "string",
        description: "Video ref from the current message context, for example VID 1."
      }
    },
    additionalProperties: false
  }
};

export const SPAWN_CODE_WORKER_SCHEMA: SharedToolSchema = {
  name: "spawn_code_worker",
  description: "Spawn a swarm-backed coding worker and return the worker and task ids for coordination. Use worker_mode=inbox_loop for iterative followups or long-lived planner workers. Use review_after_completion only when the user asks for verification or the task is high-stakes.",
  voiceContinuationPolicy: "always",
  parameters: {
    type: "object",
    properties: {
      task: { type: "string", description: "Detailed instruction for the coding worker." },
      role: {
        type: "string",
        enum: ["design", "implementation", "review", "research"],
        description: "Optional worker role. Defaults to implementation."
      },
      harness: {
        type: "string",
        enum: ["claude-code", "codex-cli"],
        description: "Optional worker harness override."
      },
      cwd: { type: "string", description: "Working directory. Defaults to the selected worker's configured project root." },
      worker_mode: {
        type: "string",
        enum: ["one_shot", "inbox_loop"],
        description: "one_shot exits after the assigned task. inbox_loop stays alive for send_message followups and persists a session key in swarm KV. Defaults to one_shot."
      },
      review_after_completion: {
        type: "boolean",
        description: "When true, wait for the implementation task, then spawn a one-shot review worker against the same cwd and return both results. Use sparingly."
      },
      review_harness: {
        type: "string",
        enum: ["claude-code", "codex-cli"],
        description: "Optional harness override for the review worker. Defaults to review role routing, then the implementation harness."
      },
      wait_timeout_ms: {
        type: "integer",
        description: "Optional timeout when review_after_completion waits for implementation and review completion. Default 300000."
      }
    },
    required: ["task"],
    additionalProperties: false
  }
};

export const REQUEST_TASK_SCHEMA: SharedToolSchema = {
  name: "request_task",
  description: "Create a swarm task in the current repo scope.",
  parameters: {
    type: "object",
    properties: {
      type: { type: "string" },
      title: { type: "string" },
      description: { type: "string" },
      files: { type: "array", items: { type: "string" } },
      assignee: { type: "string" },
      priority: { type: "integer" },
      depends_on: { type: "array", items: { type: "string" } },
      idempotency_key: { type: "string" },
      parent_task_id: { type: "string" },
      approval_required: { type: "boolean" },
      cwd: { type: "string" }
    },
    required: ["type", "title"],
    additionalProperties: false
  }
};

export const GET_TASK_SCHEMA: SharedToolSchema = {
  name: "get_task",
  description: "Read one swarm task by id.",
  parameters: {
    type: "object",
    properties: {
      task_id: { type: "string" },
      cwd: { type: "string" }
    },
    required: ["task_id"],
    additionalProperties: false
  }
};

export const LIST_TASKS_SCHEMA: SharedToolSchema = {
  name: "list_tasks",
  description: "List swarm tasks in the current repo scope.",
  parameters: {
    type: "object",
    properties: {
      status: { type: "string" },
      assignee: { type: "string" },
      requester: { type: "string" },
      cwd: { type: "string" }
    },
    additionalProperties: false
  }
};

export const UPDATE_TASK_SCHEMA: SharedToolSchema = {
  name: "update_task",
  description: "Update a swarm task status or result.",
  parameters: {
    type: "object",
    properties: {
      task_id: { type: "string" },
      status: { type: "string", enum: ["in_progress", "done", "failed", "cancelled"] },
      result: { type: "string" },
      metadata: { type: "object", additionalProperties: true },
      cwd: { type: "string" }
    },
    required: ["task_id", "status"],
    additionalProperties: false
  }
};

export const CLAIM_TASK_SCHEMA: SharedToolSchema = {
  name: "claim_task",
  description: "Claim an open swarm task for Clanky's planner peer.",
  parameters: {
    type: "object",
    properties: {
      task_id: { type: "string" },
      cwd: { type: "string" }
    },
    required: ["task_id"],
    additionalProperties: false
  }
};

export const SEND_MESSAGE_SCHEMA: SharedToolSchema = {
  name: "send_message",
  description: "Send a swarm message to a peer in the current repo scope. Pass recipient directly, or session_key from an inbox-loop spawn_code_worker result.",
  parameters: {
    type: "object",
    properties: {
      recipient: { type: "string", description: "Target swarm peer id." },
      session_key: { type: "string", description: "KV session key returned by spawn_code_worker for an inbox-loop worker." },
      content: { type: "string" },
      cwd: { type: "string" }
    },
    required: ["content"],
    additionalProperties: false
  }
};

export const BROADCAST_SCHEMA: SharedToolSchema = {
  name: "broadcast",
  description: "Broadcast a swarm message to peers in the current repo scope.",
  parameters: {
    type: "object",
    properties: {
      content: { type: "string" },
      cwd: { type: "string" }
    },
    required: ["content"],
    additionalProperties: false
  }
};

export const WAIT_FOR_ACTIVITY_SCHEMA: SharedToolSchema = {
  name: "wait_for_activity",
  description: "Wait for swarm messages, task updates, instance changes, or a specific task to finish.",
  voiceContinuationPolicy: "always",
  parameters: {
    type: "object",
    properties: {
      task_id: { type: "string" },
      timeout_ms: { type: "integer" },
      cwd: { type: "string" }
    },
    additionalProperties: false
  }
};

export const ANNOTATE_SCHEMA: SharedToolSchema = {
  name: "annotate",
  description: "Add a swarm annotation, including progress notes, for a file or task id.",
  parameters: {
    type: "object",
    properties: {
      file: { type: "string" },
      kind: { type: "string" },
      content: { type: "string" },
      cwd: { type: "string" }
    },
    required: ["file", "kind", "content"],
    additionalProperties: false
  }
};

export const LOCK_FILE_SCHEMA: SharedToolSchema = {
  name: "lock_file",
  description: "Lock a file in the swarm coordination DB before editing.",
  parameters: {
    type: "object",
    properties: {
      file: { type: "string" },
      reason: { type: "string" },
      cwd: { type: "string" }
    },
    required: ["file"],
    additionalProperties: false
  }
};

export const UNLOCK_FILE_SCHEMA: SharedToolSchema = {
  name: "unlock_file",
  description: "Release a file lock owned by Clanky's planner peer.",
  parameters: {
    type: "object",
    properties: {
      file: { type: "string" },
      cwd: { type: "string" }
    },
    required: ["file"],
    additionalProperties: false
  }
};

export const CHECK_FILE_SCHEMA: SharedToolSchema = {
  name: "check_file",
  description: "Read swarm locks and annotations for a file.",
  parameters: {
    type: "object",
    properties: {
      file: { type: "string" },
      cwd: { type: "string" }
    },
    required: ["file"],
    additionalProperties: false
  }
};

export const LIST_INSTANCES_SCHEMA: SharedToolSchema = {
  name: "list_instances",
  description: "List active swarm peers in the current repo scope.",
  parameters: {
    type: "object",
    properties: {
      label_contains: { type: "string" },
      cwd: { type: "string" }
    },
    additionalProperties: false
  }
};

export const WHOAMI_SCHEMA: SharedToolSchema = {
  name: "whoami",
  description: "Return Clanky's current planner peer identity.",
  parameters: {
    type: "object",
    properties: {
      cwd: { type: "string" }
    },
    additionalProperties: false
  }
};

export const KV_GET_SCHEMA: SharedToolSchema = {
  name: "kv_get",
  description: "Read a value from the swarm scoped key-value store.",
  parameters: {
    type: "object",
    properties: {
      key: { type: "string" },
      cwd: { type: "string" }
    },
    required: ["key"],
    additionalProperties: false
  }
};

export const KV_SET_SCHEMA: SharedToolSchema = {
  name: "kv_set",
  description: "Write a value to the swarm scoped key-value store.",
  parameters: {
    type: "object",
    properties: {
      key: { type: "string" },
      value: { type: "string" },
      cwd: { type: "string" }
    },
    required: ["key", "value"],
    additionalProperties: false
  }
};

export const KV_DELETE_SCHEMA: SharedToolSchema = {
  name: "kv_delete",
  description: "Delete a value from the swarm scoped key-value store.",
  parameters: {
    type: "object",
    properties: {
      key: { type: "string" },
      cwd: { type: "string" }
    },
    required: ["key"],
    additionalProperties: false
  }
};

export const KV_LIST_SCHEMA: SharedToolSchema = {
  name: "kv_list",
  description: "List values from the swarm scoped key-value store.",
  parameters: {
    type: "object",
    properties: {
      prefix: { type: "string" },
      cwd: { type: "string" }
    },
    additionalProperties: false
  }
};

export const SWARM_TOOL_SCHEMAS: SharedToolSchema[] = [
  REQUEST_TASK_SCHEMA,
  GET_TASK_SCHEMA,
  LIST_TASKS_SCHEMA,
  UPDATE_TASK_SCHEMA,
  CLAIM_TASK_SCHEMA,
  SEND_MESSAGE_SCHEMA,
  BROADCAST_SCHEMA,
  WAIT_FOR_ACTIVITY_SCHEMA,
  ANNOTATE_SCHEMA,
  LOCK_FILE_SCHEMA,
  UNLOCK_FILE_SCHEMA,
  CHECK_FILE_SCHEMA,
  LIST_INSTANCES_SCHEMA,
  WHOAMI_SCHEMA,
  KV_GET_SCHEMA,
  KV_SET_SCHEMA,
  KV_DELETE_SCHEMA,
  KV_LIST_SCHEMA
];

export const MINECRAFT_TASK_SCHEMA: SharedToolSchema = {
  name: "minecraft_task",
  description:
    "Send intent or relevant context to Clanky's embodied Minecraft self. " +
    "action=run starts or continues a Minecraft session and lets the Minecraft brain decide the next in-world action. " +
    "action=followup sends additional intent or context to an active session. " +
    "action=status returns the bot's current world state, task progress, and hazards. " +
    "action=cancel stops the current behavior and returns to idle.",
  voiceContinuationPolicy: "always",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["run", "followup", "cancel", "status"],
        description: "Action to perform. Defaults to run."
      },
      task: {
        type: "string",
        description:
          "Natural-language intent or relevant context for Clanky's embodied Minecraft self. " +
          "Describe what the user wants or what is happening around the Minecraft session; the Minecraft brain decides the in-world action. " +
          "Required for run and followup."
      },
      mode: {
        type: "string",
        enum: ["companion", "gather", "guard", "idle"],
        description:
          "Operating mode. companion=follow and assist, guard=follow and fight hostiles, " +
          "gather=collect resources, idle=stand still. " +
          "Only used with action=run. Defaults to companion."
      },
      session_id: {
        type: "string",
        description: "Session ID for continuation (run) or explicit management (followup, cancel, status)."
      },
      constraints: {
        type: "object",
        description: "Optional behavioral constraints for the bot.",
        properties: {
          stay_near_player: {
            type: "string",
            description: "MC username to keep close to (within max_distance). Omit for no leash."
          },
          max_distance: { type: "number", description: "Maximum distance from stay_near_player in blocks." },
          avoid_combat: { type: "boolean", description: "Do not engage hostiles." }
        }
      },
      server: {
        type: "object",
        description: "Optional preferred Minecraft world/server target for this embodied session.",
        properties: {
          label: { type: "string", description: "Human-facing world/server label." },
          host: { type: "string", description: "Minecraft server host or IP." },
          port: { type: "integer", description: "Minecraft server port." },
          description: { type: "string", description: "Short note about this world/server." }
        },
        additionalProperties: false
      }
    },
    anyOf: [
      { required: ["task"] },
      { required: ["session_id"] }
    ],
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
  SPAWN_CODE_WORKER_SCHEMA,
  ...SWARM_TOOL_SCHEMAS
];

// ── Voice-only tool schemas ─────────────────────────────────────────

const MUSIC_SEARCH_SCHEMA: SharedToolSchema = {
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

const VIDEO_SEARCH_SCHEMA: SharedToolSchema = {
  name: "video_search",
  description: "Search YouTube video candidates without starting playback. Prefer this when the user wants options; use browser_browse when thumbnails or page layout matter.",
  strict: true,
  voiceContinuationPolicy: "always",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "YouTube video title, topic, or phrase to search for. Pull from the transcript or conversation context. Required."
      },
      max_results: { type: "integer" }
    },
    required: ["query"],
    additionalProperties: false
  }
};

const MUSIC_QUEUE_ADD_SCHEMA: SharedToolSchema = {
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

const MUSIC_PLAY_SCHEMA: SharedToolSchema = {
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

const VIDEO_PLAY_SCHEMA: SharedToolSchema = {
  name: "video_play",
  description: "Start YouTube video playback from a query or prior selection_id. May return clarification choices when the request is ambiguous.",
  strict: true,
  voiceContinuationPolicy: "always",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "YouTube video title, topic, or phrase to play. Pull from the transcript or conversation context."
      },
      selection_id: {
        type: "string",
        description: "Exact selection id returned from a previous video_play or video_search result. Pass empty string when not selecting a prior result."
      }
    },
    required: ["query"],
    additionalProperties: false
  }
};

const MUSIC_QUEUE_NEXT_SCHEMA: SharedToolSchema = {
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

const MUSIC_STOP_SCHEMA: SharedToolSchema = {
  name: "media_stop",
  description: "Stop the current playback item and clear the active queue. Applies to the shared music/video playback stack.",
  voiceContinuationPolicy: "fire_and_forget",
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false
  }
};

const MUSIC_PAUSE_SCHEMA: SharedToolSchema = {
  name: "media_pause",
  description: "Pause the current playback item. Applies to the shared music/video playback stack.",
  voiceContinuationPolicy: "fire_and_forget",
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false
  }
};

const MUSIC_RESUME_SCHEMA: SharedToolSchema = {
  name: "media_resume",
  description: "Resume paused playback. Applies to the shared music/video playback stack.",
  voiceContinuationPolicy: "fire_and_forget",
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false
  }
};

const MUSIC_REPLY_HANDOFF_SCHEMA: SharedToolSchema = {
  name: "media_reply_handoff",
  description: "Temporarily claim the floor for the current spoken reply by pausing or ducking active playback. Runtime auto-restores playback when you finish. This is not a persistent playback command.",
  voiceContinuationPolicy: "always",
  parameters: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["pause", "duck", "none"],
        description: "\"pause\" fully pauses playback for this reply, \"duck\" lowers playback under this reply, \"none\" clears any pending temporary handoff."
      }
    },
    required: ["mode"],
    additionalProperties: false
  }
};

const MUSIC_SKIP_SCHEMA: SharedToolSchema = {
  name: "media_skip",
  description: "Skip the current playback item and advance to the next queued item.",
  voiceContinuationPolicy: "fire_and_forget",
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false
  }
};

const MUSIC_NOW_PLAYING_SCHEMA: SharedToolSchema = {
  name: "media_now_playing",
  description: "Read current playback and queue status.",
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
  voiceContinuationPolicy: "fire_and_forget",
  parameters: { type: "object", properties: {}, required: [], additionalProperties: false }
};

const LEAVE_VOICE_CHANNEL_SCHEMA: SharedToolSchema = {
  name: "leave_voice_channel",
  description: "Leave the voice channel and end the current voice session.",
  voiceContinuationPolicy: "fire_and_forget",
  parameters: { type: "object", properties: {}, required: [], additionalProperties: false }
};

export const START_SCREEN_WATCH_SCHEMA: SharedToolSchema = {
  name: "start_screen_watch",
  description: "Start watching the most relevant active stream using the best available runtime path. Optionally specify a target name or Discord user id when you want a specific sharer. The runtime may bind to an already-live Discord sharer or fall back to a capture-link flow.",
  voiceContinuationPolicy: "fire_and_forget",
  parameters: {
    type: "object",
    properties: {
      target: {
        type: "string",
        description: "Optional sharer to watch. Prefer the active Discord display name from current voice context when multiple people are sharing."
      }
    },
    required: [],
    additionalProperties: false
  }
};

export const SEE_SCREENSHARE_SNAPSHOT_SCHEMA: SharedToolSchema = {
  name: "see_screenshare_snapshot",
  description: "Retrieve the latest frame from the active screen share so you can see what is on screen right now. Use this when your screen-watch notes are insufficient to answer a question or when you want to inspect the current visual state directly.",
  voiceContinuationPolicy: "always",
  parameters: {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false
  }
};

export const SHARE_BROWSER_SESSION_SCHEMA: SharedToolSchema = {
  name: "share_browser_session",
  description: "Share an existing persistent browser session into Discord Go Live. Pass the session_id returned from browser_browse when you want to show the page while deciding or demonstrating.",
  voiceContinuationPolicy: "fire_and_forget",
  parameters: {
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description: "Browser session ID previously returned from browser_browse."
      }
    },
    required: ["session_id"],
    additionalProperties: false
  }
};

const STREAM_VISUALIZER_SCHEMA: SharedToolSchema = {
  name: "stream_visualizer",
  description: "Start Discord Go Live with an audio visualizer for currently playing music.",
  voiceContinuationPolicy: "fire_and_forget",
  parameters: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["cqt", "spectrum", "waves", "vectorscope"],
        description: "Visualizer style. Uses dashboard default if omitted."
      }
    },
    additionalProperties: false
  }
};

export const STOP_VIDEO_SHARE_SCHEMA: SharedToolSchema = {
  name: "stop_video_share",
  description: "Stop the current outbound video share, whether it is a browser session or a published video stream.",
  voiceContinuationPolicy: "fire_and_forget",
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false
  }
};

export const PLAY_SOUNDBOARD_SCHEMA: SharedToolSchema = {
  name: "play_soundboard",
  description: "Play one or more soundboard refs in the current voice session, in order.",
  voiceContinuationPolicy: "fire_and_forget",
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

const NOTE_CONTEXT_SCHEMA: SharedToolSchema = {
  name: "note_context",
  description: "Pin important session-scoped context for later in the conversation. Avoid duplicates.",
  voiceContinuationPolicy: "fire_and_forget",
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
  VIDEO_SEARCH_SCHEMA,
  VIDEO_PLAY_SCHEMA,
  MUSIC_QUEUE_ADD_SCHEMA,
  MUSIC_QUEUE_NEXT_SCHEMA,
  MUSIC_STOP_SCHEMA,
  MUSIC_PAUSE_SCHEMA,
  MUSIC_RESUME_SCHEMA,
  MUSIC_REPLY_HANDOFF_SCHEMA,
  MUSIC_SKIP_SCHEMA,
  MUSIC_NOW_PLAYING_SCHEMA,
  SHARE_BROWSER_SESSION_SCHEMA,
  STREAM_VISUALIZER_SCHEMA,
  STOP_VIDEO_SHARE_SCHEMA,
  PLAY_SOUNDBOARD_SCHEMA,
  NOTE_CONTEXT_SCHEMA,
  JOIN_VOICE_CHANNEL_SCHEMA,
  LEAVE_VOICE_CHANNEL_SCHEMA
];

const LOCAL_VOICE_CONTINUATION_SCHEMAS: SharedToolSchema[] = [
  ...SHARED_TOOL_SCHEMAS,
  ...VOICE_TOOL_SCHEMAS,
  START_SCREEN_WATCH_SCHEMA,
  SEE_SCREENSHARE_SNAPSHOT_SCHEMA,
  SHARE_BROWSER_SESSION_SCHEMA,
  STOP_VIDEO_SHARE_SCHEMA,
  STREAM_VISUALIZER_SCHEMA
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
  return getLocalVoiceToolSchema(toolName)?.voiceContinuationPolicy || "fire_and_forget";
}

export function shouldRequestVoiceToolFollowup(
  toolName: unknown,
  {
    toolType = "function"
  }: {
    toolType?: "function" | "mcp";
    /** @deprecated No longer used — retained for call-site compatibility. */
    hasSpokenText?: boolean;
  } = {}
): boolean {
  const continuationPolicy = resolveVoiceToolContinuationPolicy(toolName, { toolType });
  return continuationPolicy === "always";
}

// ── Format adapters ──────────────────────────────────────────────────

/** Convert to Anthropic Claude API tool format (for replyTools.ts). */
export function toAnthropicTool(schema: SharedToolSchema): {
  name: string;
  description: string;
  strict?: boolean;
  input_schema: { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
} {
  // Claude API rejects oneOf/allOf/anyOf/not at the top level of input_schema.
  // Strip them defensively (mirrors sanitizeProviderNativeRealtimeParameters in voice path).
  const { anyOf: _anyOf, oneOf: _oneOf, allOf: _allOf, not: _not, ...sanitizedParameters } = schema.parameters as Record<string, unknown>;
  return {
    name: schema.name,
    description: schema.description,
    ...(schema.strict ? { strict: true } : {}),
    input_schema: sanitizedParameters as typeof schema.parameters
  };
}

/** Convert to OpenAI/xAI realtime tool format (for the voice tool-call runtime). */
export function toRealtimeTool(schema: SharedToolSchema): VoiceRealtimeToolDescriptor {
  return {
    toolType: "function",
    name: schema.name,
    description: schema.description,
    parameters: schema.parameters,
    continuationPolicy: schema.voiceContinuationPolicy || "fire_and_forget"
  };
}
