import {
  BROWSER_BROWSE_SCHEMA,
  MINECRAFT_TASK_SCHEMA,
  CONVERSATION_SEARCH_SCHEMA,
  IMAGE_LOOKUP_SCHEMA,
  MEMORY_SEARCH_SCHEMA,
  MEMORY_WRITE_SCHEMA,
  SEE_SCREENSHARE_SNAPSHOT_SCHEMA,
  SHARE_BROWSER_SESSION_SCHEMA,
  START_SCREEN_WATCH_SCHEMA,
  STOP_VIDEO_SHARE_SCHEMA,
  PLAY_SOUNDBOARD_SCHEMA,
  SPAWN_CODE_WORKER_SCHEMA,
  SWARM_TOOL_SCHEMAS,
  VIDEO_CONTEXT_SCHEMA,
  VOICE_TOOL_SCHEMAS,
  WEB_SCRAPE_SCHEMA,
  WEB_SEARCH_SCHEMA,
  type SharedToolSchema
} from "./sharedToolSchemas.ts";
import {
  getMemorySettings,
  getVideoContextSettings,
  isBrowserEnabled,
  isDevTaskEnabled,
  isResearchEnabled
} from "../settings/agentStack.ts";

type LocalToolSurface = "reply" | "voice_realtime";

export type ReplyToolAvailability = {
  webSearchAvailable?: boolean;
  webScrapeAvailable?: boolean;
  browserBrowseAvailable?: boolean;
  memoryAvailable?: boolean;
  conversationSearchAvailable?: boolean;
  imageLookupAvailable?: boolean;
  videoContextAvailable?: boolean;
  screenShareAvailable?: boolean;
  screenShareSnapshotAvailable?: boolean;
  soundboardAvailable?: boolean;
  swarmToolsAvailable?: boolean;
  voiceToolsAvailable?: boolean;
  minecraftAvailable?: boolean;
};

type VoiceRealtimeLocalToolAvailability = {
  browserAvailable: boolean;
  minecraftAvailable?: boolean;
  memoryAvailable: boolean;
  screenShareAvailable: boolean;
  screenShareSnapshotAvailable: boolean;
  soundboardAvailable: boolean;
  webSearchAvailable: boolean;
};

type ReplyToolResolverContext = {
  settings: Record<string, unknown>;
  capabilities: ReplyToolAvailability;
};

type VoiceRealtimeToolResolverContext = {
  capabilities: VoiceRealtimeLocalToolAvailability;
};

type LocalToolRegistryEntry = {
  name: string;
  surfaces: LocalToolSurface[];
  isReplyAvailable?: (context: ReplyToolResolverContext) => boolean;
  isVoiceRealtimeAvailable?: (context: VoiceRealtimeToolResolverContext) => boolean;
};

function areSwarmToolsAvailable(settings: Record<string, unknown>, capabilities: ReplyToolAvailability): boolean {
  return capabilities.swarmToolsAvailable === true && isDevTaskEnabled(settings);
}

const TOOL_SCHEMA_BY_NAME = new Map(
  [
    WEB_SEARCH_SCHEMA,
    WEB_SCRAPE_SCHEMA,
    BROWSER_BROWSE_SCHEMA,
    MEMORY_SEARCH_SCHEMA,
    MEMORY_WRITE_SCHEMA,
    CONVERSATION_SEARCH_SCHEMA,
    IMAGE_LOOKUP_SCHEMA,
    VIDEO_CONTEXT_SCHEMA,
    SPAWN_CODE_WORKER_SCHEMA,
    ...SWARM_TOOL_SCHEMAS,
    MINECRAFT_TASK_SCHEMA,
    START_SCREEN_WATCH_SCHEMA,
    SEE_SCREENSHARE_SNAPSHOT_SCHEMA,
    SHARE_BROWSER_SESSION_SCHEMA,
    STOP_VIDEO_SHARE_SCHEMA,
    PLAY_SOUNDBOARD_SCHEMA,
    ...VOICE_TOOL_SCHEMAS
  ].map((schema) => [schema.name, schema] as const)
);

function getRequiredToolSchema(toolName: string): SharedToolSchema {
  const schema = TOOL_SCHEMA_BY_NAME.get(toolName);
  if (!schema) {
    throw new Error(`Missing canonical tool schema for '${toolName}'.`);
  }
  return schema;
}

const LOCAL_TOOL_REGISTRY: LocalToolRegistryEntry[] = [
  {
    name: "web_search",
    surfaces: ["reply", "voice_realtime"],
    isReplyAvailable: ({ settings, capabilities }) =>
      capabilities.webSearchAvailable !== false && isResearchEnabled(settings),
    isVoiceRealtimeAvailable: ({ capabilities }) => capabilities.webSearchAvailable
  },
  {
    name: "web_scrape",
    surfaces: ["reply", "voice_realtime"],
    isReplyAvailable: ({ settings, capabilities }) => {
      const webSearchToolAvailable = capabilities.webSearchAvailable !== false;
      const webScrapeToolAvailable =
        capabilities.webScrapeAvailable !== undefined
          ? capabilities.webScrapeAvailable !== false
          : webSearchToolAvailable;
      return webScrapeToolAvailable && isResearchEnabled(settings);
    },
    isVoiceRealtimeAvailable: ({ capabilities }) => capabilities.webSearchAvailable
  },
  {
    name: "browser_browse",
    surfaces: ["reply", "voice_realtime"],
    isReplyAvailable: ({ settings, capabilities }) =>
      capabilities.browserBrowseAvailable !== false && isBrowserEnabled(settings),
    isVoiceRealtimeAvailable: ({ capabilities }) => capabilities.browserAvailable
  },
  {
    name: "memory_search",
    surfaces: ["reply"],
    isReplyAvailable: ({ settings, capabilities }) =>
      capabilities.memoryAvailable !== false && Boolean(getMemorySettings(settings).enabled)
  },
  {
    name: "memory_write",
    surfaces: ["reply", "voice_realtime"],
    isReplyAvailable: ({ settings, capabilities }) =>
      capabilities.memoryAvailable !== false && Boolean(getMemorySettings(settings).enabled),
    isVoiceRealtimeAvailable: ({ capabilities }) => capabilities.memoryAvailable
  },
  {
    name: "conversation_search",
    surfaces: ["reply", "voice_realtime"],
    isReplyAvailable: ({ capabilities }) => capabilities.conversationSearchAvailable !== false,
    isVoiceRealtimeAvailable: () => true
  },
  {
    name: "image_lookup",
    surfaces: ["reply"],
    isReplyAvailable: ({ capabilities }) => Boolean(capabilities.imageLookupAvailable)
  },
  {
    name: "video_context",
    surfaces: ["reply"],
    isReplyAvailable: ({ settings, capabilities }) =>
      capabilities.videoContextAvailable !== false && Boolean(getVideoContextSettings(settings).enabled)
  },
  {
    name: "start_screen_watch",
    surfaces: ["reply", "voice_realtime"],
    isReplyAvailable: ({ capabilities }) => Boolean(capabilities.screenShareAvailable),
    isVoiceRealtimeAvailable: ({ capabilities }) => capabilities.screenShareAvailable
  },
  {
    name: "see_screenshare_snapshot",
    surfaces: ["reply", "voice_realtime"],
    isReplyAvailable: ({ capabilities }) => Boolean(capabilities.screenShareSnapshotAvailable),
    isVoiceRealtimeAvailable: ({ capabilities }) => Boolean(capabilities.screenShareSnapshotAvailable)
  },
  {
    name: "share_browser_session",
    surfaces: ["reply", "voice_realtime"],
    isReplyAvailable: ({ capabilities }) =>
      Boolean(capabilities.voiceToolsAvailable) && capabilities.browserBrowseAvailable !== false,
    isVoiceRealtimeAvailable: ({ capabilities }) => capabilities.browserAvailable
  },
  {
    name: "stop_video_share",
    surfaces: ["reply", "voice_realtime"],
    isReplyAvailable: ({ capabilities }) => Boolean(capabilities.voiceToolsAvailable),
    isVoiceRealtimeAvailable: () => true
  },
  {
    name: "spawn_code_worker",
    surfaces: ["reply"],
    isReplyAvailable: ({ settings, capabilities }) => areSwarmToolsAvailable(settings, capabilities)
  },
  ...SWARM_TOOL_SCHEMAS.map((schema): LocalToolRegistryEntry => ({
    name: schema.name,
    surfaces: ["reply"],
    isReplyAvailable: ({ settings, capabilities }) => areSwarmToolsAvailable(settings, capabilities)
  })),
  {
    name: "minecraft_task",
    surfaces: ["reply", "voice_realtime"],
    isReplyAvailable: ({ capabilities }) => Boolean(capabilities.minecraftAvailable),
    isVoiceRealtimeAvailable: ({ capabilities }) => Boolean(capabilities.minecraftAvailable)
  },
  {
    name: "music_search",
    surfaces: ["reply", "voice_realtime"],
    isReplyAvailable: ({ capabilities }) => Boolean(capabilities.voiceToolsAvailable),
    isVoiceRealtimeAvailable: () => true
  },
  {
    name: "music_play",
    surfaces: ["reply", "voice_realtime"],
    isReplyAvailable: ({ capabilities }) => Boolean(capabilities.voiceToolsAvailable),
    isVoiceRealtimeAvailable: () => true
  },
  {
    name: "video_search",
    surfaces: ["reply", "voice_realtime"],
    isReplyAvailable: ({ capabilities }) => Boolean(capabilities.voiceToolsAvailable),
    isVoiceRealtimeAvailable: () => true
  },
  {
    name: "video_play",
    surfaces: ["reply", "voice_realtime"],
    isReplyAvailable: ({ capabilities }) => Boolean(capabilities.voiceToolsAvailable),
    isVoiceRealtimeAvailable: () => true
  },
  {
    name: "music_queue_add",
    surfaces: ["reply", "voice_realtime"],
    isReplyAvailable: ({ capabilities }) => Boolean(capabilities.voiceToolsAvailable),
    isVoiceRealtimeAvailable: () => true
  },
  {
    name: "music_queue_next",
    surfaces: ["reply", "voice_realtime"],
    isReplyAvailable: ({ capabilities }) => Boolean(capabilities.voiceToolsAvailable),
    isVoiceRealtimeAvailable: () => true
  },
  {
    name: "media_stop",
    surfaces: ["reply", "voice_realtime"],
    isReplyAvailable: ({ capabilities }) => Boolean(capabilities.voiceToolsAvailable),
    isVoiceRealtimeAvailable: () => true
  },
  {
    name: "media_pause",
    surfaces: ["reply", "voice_realtime"],
    isReplyAvailable: ({ capabilities }) => Boolean(capabilities.voiceToolsAvailable),
    isVoiceRealtimeAvailable: () => true
  },
  {
    name: "media_resume",
    surfaces: ["reply", "voice_realtime"],
    isReplyAvailable: ({ capabilities }) => Boolean(capabilities.voiceToolsAvailable),
    isVoiceRealtimeAvailable: () => true
  },
  {
    name: "media_reply_handoff",
    surfaces: ["reply", "voice_realtime"],
    isReplyAvailable: ({ capabilities }) => Boolean(capabilities.voiceToolsAvailable),
    isVoiceRealtimeAvailable: () => true
  },
  {
    name: "media_skip",
    surfaces: ["reply", "voice_realtime"],
    isReplyAvailable: ({ capabilities }) => Boolean(capabilities.voiceToolsAvailable),
    isVoiceRealtimeAvailable: () => true
  },
  {
    name: "media_now_playing",
    surfaces: ["reply", "voice_realtime"],
    isReplyAvailable: ({ capabilities }) => Boolean(capabilities.voiceToolsAvailable),
    isVoiceRealtimeAvailable: () => true
  },
  {
    name: "stream_visualizer",
    surfaces: ["reply", "voice_realtime"],
    isReplyAvailable: ({ capabilities }) => Boolean(capabilities.voiceToolsAvailable),
    isVoiceRealtimeAvailable: () => true
  },
  {
    name: "play_soundboard",
    surfaces: ["reply", "voice_realtime"],
    isReplyAvailable: ({ capabilities }) =>
      Boolean(capabilities.voiceToolsAvailable) && capabilities.soundboardAvailable !== false,
    isVoiceRealtimeAvailable: ({ capabilities }) => capabilities.soundboardAvailable
  },
  {
    name: "note_context",
    surfaces: ["reply"],
    isReplyAvailable: ({ capabilities }) => Boolean(capabilities.voiceToolsAvailable)
  },
  {
    name: "join_voice_channel",
    surfaces: ["reply"],
    isReplyAvailable: ({ capabilities }) => Boolean(capabilities.voiceToolsAvailable)
  },
  {
    name: "leave_voice_channel",
    surfaces: ["reply", "voice_realtime"],
    isReplyAvailable: ({ capabilities }) => Boolean(capabilities.voiceToolsAvailable),
    isVoiceRealtimeAvailable: () => true
  }
];

function resolveToolSchemas(
  surface: LocalToolSurface,
  predicate: (entry: LocalToolRegistryEntry) => boolean
): SharedToolSchema[] {
  return LOCAL_TOOL_REGISTRY
    .filter((entry) => entry.surfaces.includes(surface))
    .filter((entry) => predicate(entry))
    .map((entry) => getRequiredToolSchema(entry.name));
}

export function buildReplyToolSchemas(
  settings: Record<string, unknown>,
  capabilities: ReplyToolAvailability = {}
): SharedToolSchema[] {
  return resolveToolSchemas(
    "reply",
    (entry) => entry.isReplyAvailable?.({ settings, capabilities }) === true
  );
}

export function buildVoiceRealtimeLocalToolSchemas(
  capabilities: VoiceRealtimeLocalToolAvailability
): SharedToolSchema[] {
  return resolveToolSchemas(
    "voice_realtime",
    (entry) => entry.isVoiceRealtimeAvailable?.({ capabilities }) === true
  );
}
