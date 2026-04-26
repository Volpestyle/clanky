/**
 * Static capability documentation builders for the system prompt.
 *
 * These functions produce instructional text that describes *how* each tool
 * or feature works.  They are gated by settings (which change only on
 * config update, not per-turn) so the system prompt stays cacheable across
 * turns.  Per-turn availability / budget / state lines remain in the user
 * prompt.
 *
 * Design principle: the model always knows its full capability set.
 * Infrastructure enforces hard-fail guards at the tool execution layer
 * when a tool is temporarily unavailable (budget, runtime, etc.).
 */

import { REPLY_JSON_SCHEMA, getMediaPromptCraftGuidance } from "./promptCore.ts";
import {
  CONVERSATION_SEARCH_POLICY_LINE,
  WEB_SCRAPE_POLICY_LINE,
  BROWSER_BROWSE_POLICY_LINE,
  BROWSER_SCREENSHOT_POLICY_LINE,
  buildWebSearchPolicyLine,
  buildWebToolRoutingPolicyLine
} from "./toolPolicy.ts";
import {
  MUSIC_ACTIVE_AUTONOMY_POLICY_LINE,
  MUSIC_REPLY_HANDOFF_POLICY_LINE
} from "./voiceLivePolicy.ts";

// ---------------------------------------------------------------------------
// Tool summary block — compact quick-reference for the model
// ---------------------------------------------------------------------------

/**
 * One-line routing hints keyed by tool name. These complement the structured
 * tool schemas (which say *what* a tool does) with behavioral guidance
 * (*when* to reach for it).  Only tools present in the capability flags are
 * included, giving the model a scannable index before the detailed sections.
 */

const TEXT_TOOL_SUMMARIES: Record<string, string> = {
  conversation_search: "Recall earlier text or voice exchanges when someone asks what was said before.",
  web_search: "Fresh discovery or current facts when accuracy depends on live web info.",
  web_scrape: "Read a known URL's text, including one you just got from web_search.",
  browser_browse: "JS rendering, visual layout, screenshots, navigation, or interaction.",
  memory_search: "Look up durable memory facts (speaker, guild, self, lore).",
  memory_write: "Store long-lived useful facts or standing guidance, never secrets or chatter. Write from your own perspective (use 'me'/'my', not your name).",
  image_lookup: "Find a previously shared image from message history by ref or description.",
  spawn_code_worker: "Spawn a swarm-backed coding worker and get task/worker IDs for follow-up coordination.",
  request_task: "Create a swarm task in the current repo scope.",
  get_task: "Read the current status and result for a swarm task.",
  list_tasks: "List swarm tasks in the current repo scope.",
  update_task: "Update or cancel a swarm task.",
  claim_task: "Claim an open swarm task as Clanky's planner peer.",
  send_message: "Send a direct swarm message to a peer.",
  broadcast: "Broadcast a swarm message to all peers in scope.",
  wait_for_activity: "Wait for swarm task, message, or peer activity.",
  annotate: "Post progress or coordination notes for a file or task.",
  lock_file: "Lock a file before editing in a multi-worker coding task.",
  unlock_file: "Release a file lock held by Clanky's planner peer.",
  check_file: "Inspect swarm locks and annotations for a file.",
  list_instances: "List active swarm peers in the current repo scope.",
  whoami: "Return Clanky's current swarm planner peer identity.",
  kv_get: "Read from the swarm scoped key-value store.",
  kv_set: "Write to the swarm scoped key-value store.",
  kv_delete: "Delete from the swarm scoped key-value store.",
  kv_list: "List swarm scoped key-value entries.",
  minecraft_task: "Hand off Minecraft intent or relevant context to your embodied in-world self; use action=status when you need current world state.",
  join_voice_channel: "Join the requesting user's current voice channel.",
  leave_voice_channel: "Leave the voice channel.",
  music_search: "Browse track candidates without starting playback.",
  music_play: "Start audio playback from a query or prior selection_id.",
  video_search: "Browse YouTube video candidates without starting playback.",
  video_play: "Start YouTube video playback via Discord Go Live.",
  music_queue_add: "Append tracks to the end of the queue.",
  music_queue_next: "Insert tracks immediately after the current track.",
  media_stop: "Stop playback and clear the queue.",
  media_pause: "Pause current playback.",
  media_resume: "Resume paused playback.",
  media_reply_handoff: "Temporarily pause/duck playback while you speak.",
  media_skip: "Skip to the next queued item.",
  media_now_playing: "Read current playback and queue status.",
  start_screen_watch: "Watch the most relevant active stream for live visual context.",
  share_browser_session: "Share a persistent browser session into Discord Go Live.",
  stop_video_share: "Stop the current outbound video share.",
  stream_visualizer: "Start a Go Live audio visualizer for currently playing music.",
  play_soundboard: "Play one or more soundboard clips in the current voice session.",
  note_context: "Pin important session-scoped context for later in the conversation."
};

const VOICE_TOOL_SUMMARIES: Record<string, string> = {
  ...TEXT_TOOL_SUMMARIES,
  // voice-surface overrides / additions (none currently differ)
};

function buildToolSummaryBlock(
  toolNames: string[],
  summaryMap: Record<string, string> = TEXT_TOOL_SUMMARIES
): string[] {
  const lines = toolNames
    .map((name) => {
      const hint = summaryMap[name];
      return hint ? `- ${name}: ${hint}` : null;
    })
    .filter(Boolean) as string[];

  if (!lines.length) return [];
  return ["Tool capability reference:", ...lines];
}

// ---------------------------------------------------------------------------
// Text output format (fully static)
// ---------------------------------------------------------------------------

function buildTextOutputFormatDocs(): string[] {
  return [
    "=== OUTPUT FORMAT ===",
    "Task: write one natural Discord reply for this turn.",
    "If recent messages are one coherent thread, you may combine and answer multiple messages in one reply.",
    "If recent messages are unrelated, prioritize the latest message and keep the reply focused.",
    "Return strict JSON only. Do not output markdown or code fences.",
    "JSON format:",
    REPLY_JSON_SCHEMA,
    "In text, prefer readability: short paragraphs; when listing multiple sources/items, put one per line.",
    "Set skip=true only when no response should be sent. If skip=true, set text to [SKIP].",
    "When no reaction is needed, set reactionEmoji to null.",
    "When no media should be generated, set media to null.",
    "If a previous tool call returned images and you want to include those exact images in the final Discord reply, set media to {\"type\":\"tool_images\",\"prompt\":null}.",
    "Use tool calls for web search, browser browsing, durable memory search, image lookup, voice control, and other supported capabilities.",
    "Do not encode tool requests inside the JSON reply body.",
    "When no automation command is intended, set automationAction.operation=none and other automationAction fields to null/false.",
    "Set screenWatchIntent.action to one of start_watch|none.",
    "When not starting screen watch, set screenWatchIntent.action=none, screenWatchIntent.confidence=0, screenWatchIntent.reason=null."
  ];
}

// ---------------------------------------------------------------------------
// Automation
// ---------------------------------------------------------------------------

function buildAutomationDocs(): string[] {
  return [
    "=== AUTOMATION ===",
    "You can create and manage scheduled automations for users.",
    "If the user asks to schedule/start recurring tasks, set automationAction.operation=create.",
    "For create, set automationAction.schedule with one of:",
    "- daily: {\"kind\":\"daily\",\"hour\":0-23,\"minute\":0-59}",
    "- interval: {\"kind\":\"interval\",\"everyMinutes\":integer}",
    "- once: {\"kind\":\"once\",\"atIso\":\"ISO-8601 timestamp\"}",
    "For create, set automationAction.instruction to the exact task instruction (what to do each run).",
    "Use automationAction.runImmediately=true only when user asks for immediate first run.",
    "If user asks to stop/pause a recurring task, set automationAction.operation=pause with targetQuery.",
    "If user asks to resume/re-enable, set automationAction.operation=resume with targetQuery.",
    "If user asks to remove/delete permanently, set automationAction.operation=delete with targetQuery.",
    "If user asks to see what is scheduled, set automationAction.operation=list.",
    "When no automation control is requested, set automationAction.operation=none."
  ];
}

// ---------------------------------------------------------------------------
// Media generation (images, video, GIFs)
// ---------------------------------------------------------------------------

function buildMediaGenerationDocs(settings: unknown, maxMediaPromptChars = 900): string[] {
  const mediaGuidance = getMediaPromptCraftGuidance(settings);
  const limit = Math.max(100, Math.floor(Number(maxMediaPromptChars) || 900));
  return [
    "=== MEDIA GENERATION ===",
    "You can generate images and short videos when the moment calls for it.",
    "For a simple/quick visual, set media to {\"type\":\"image_simple\",\"prompt\":\"...\"}.",
    "Use image_simple for straightforward concepts or fast meme-style visuals.",
    "For a detailed/composition-heavy visual, set media to {\"type\":\"image_complex\",\"prompt\":\"...\"}.",
    "Use image_complex for cinematic/detail-rich scenes or harder visual requests.",
    "If a generated clip is best, set media to {\"type\":\"video\",\"prompt\":\"...\"}.",
    "Use video when motion/animation is meaningfully better than a still image.",
    `Keep image/video media prompts under ${limit} chars, and always include normal reply text.`,
    mediaGuidance,
    "Set at most one media object per reply.",
    "When media generation is unavailable for a turn, set media to null and respond with text only."
  ];
}

function buildGifDocs(): string[] {
  return [
    "=== GIFS ===",
    "Reply GIF lookup is available via a search-based GIF tool.",
    "If a GIF should be sent, set media to {\"type\":\"gif\",\"prompt\":\"short search query\"}.",
    "Use media.type=gif only when a reaction GIF genuinely improves the reply.",
    "Keep GIF media prompts concise (under 120 chars), and always include normal reply text.",
    "When GIF lookup is unavailable for a turn, do not set media.type=gif."
  ];
}

// ---------------------------------------------------------------------------
// Web search + browser
// ---------------------------------------------------------------------------

function buildWebSearchDocs({ includeBrowserBrowse = false }: { includeBrowserBrowse?: boolean } = {}): string[] {
  return [
    buildWebToolRoutingPolicyLine({ includeBrowserBrowse }),
    buildWebSearchPolicyLine(),
    WEB_SCRAPE_POLICY_LINE,
    "Use the web tools only when they materially help."
  ];
}

function buildBrowserDocs(): string[] {
  return [
    BROWSER_BROWSE_POLICY_LINE,
    BROWSER_SCREENSHOT_POLICY_LINE
  ];
}

// ---------------------------------------------------------------------------
// Memory lookup + image lookup
// ---------------------------------------------------------------------------

function buildMemoryLookupDocs(): string[] {
  return [
    "If the user asks what you remember (or asks for stored facts) and current memory context is insufficient, call memory_search with a concise query.",
    "If the user asks for a broad dump of stored memory or everything you remember, use query \"__ALL__\".",
    "`__ALL__` requests a capped stored-memory dump, not a ranked topical lookup."
  ];
}

function buildImageLookupDocs(): string[] {
  return [
    "If the user refers to an earlier image/photo and current message attachments are insufficient, call image_lookup with a short query or a specific image ref like IMG 3.",
    "The [IMG n] markers in recent chat are historical images, not fresh attachments on the latest user message.",
    "Do not claim you cannot review earlier shared images when history lookup is available."
  ];
}

function buildMinecraftDocs(): string[] {
  return [
    "=== MINECRAFT ===",
    "You have an embodied Minecraft self with a dedicated in-world brain.",
    "Use minecraft_task when someone wants you to do something in Minecraft or when Minecraft context matters to the conversation.",
    "Hand over the user's intent or relevant context, not translated low-level commands; the Minecraft brain decides the in-world action.",
    "Use minecraft_task with action=status when you need current world state, task progress, or hazards before deciding what to say or do."
  ];
}

function buildCodeAgentDocs(): string[] {
  return [
    "=== CODE AGENT SWARM ===",
    "Use spawn_code_worker for coding work that should run in a local checkout. Keep ordinary conversational coding explanations in your own reply unless the user wants files changed or a real repo task handled.",
    "Every spawned worker stays briefly available after completing its assigned task — it listens for follow-up `send_message` for ~60s before exiting. spawn_code_worker returns a sessionKey and persists the live worker in swarm KV. On a later turn, decide per-turn whether to drive more work: if you do, send_message with the session_key (or worker_id) to prompt the same worker. If send_message reports the peer is inactive, the listen window already elapsed — spawn a fresh worker instead. There is no upfront 'one_shot vs inbox_loop' decision; the orchestrator drives followups when it wants them, the worker just stays available briefly.",
    "For a long-lived planner pattern, spawn role=design and continuously drive it with send_message during its listen windows. The planner can request its own subtasks through swarm-mcp.",
    "For high-stakes code work, or when the user asks for verification, set review_after_completion=true or spawn a role=review worker after the implementation completes. Treat reviewer output as findings to resolve or report, not as a decorative summary.",
    "Important — request_task vs spawn_code_worker: spawn_code_worker is the only call that actually creates a worker process. request_task alone only writes a row in the swarm task ledger; nothing claims it unless an existing peer matches and picks it up. Do not call request_task standalone expecting a worker to materialize from nowhere.",
    "When delegating swarm work, the swarm can include peers other than your own spawned workers — e.g. a human-launched claude-code or codex session that registered itself via the swarm-mcp skill. Before spawning a fresh worker, you may consult list_instances to see if a matching role:implementer / role:reviewer / role:researcher peer is already active in the scope. If one is, request_task with assignee=<that-peer-id> delegates the work to them instead of starting a new process. Use spawn_code_worker when no suitable peer exists, when the existing peers are busy, or when you specifically want a fresh sandboxed worker."
  ];
}

// ---------------------------------------------------------------------------
// Conversation search
// ---------------------------------------------------------------------------

function buildConversationSearchDocs(): string[] {
  return [CONVERSATION_SEARCH_POLICY_LINE];
}

// ---------------------------------------------------------------------------
// Voice control (text-channel perspective)
// ---------------------------------------------------------------------------

function buildVoiceControlDocs(_settings: unknown): string[] {
  return [
    "If not in a voice channel, call join_voice_channel first, then call the music tool.",
    "If the user asks what is playing, what was stopped, or what is queued, answer from the current music state directly.",
    "If there is a pending music disambiguation request, and the user picks one of the options (by number or by naming it), call the pending action with the selection_id set to that exact id."
  ];
}

// ---------------------------------------------------------------------------
// Screen watch (text-channel perspective)
// ---------------------------------------------------------------------------

function buildScreenWatchDocs(): string[] {
  return [
    "If the user asks you to see/watch their screen or stream, set screenWatchIntent.action to start_watch.",
    "If visual context would materially improve troubleshooting/help, you may proactively set screenWatchIntent.action to start_watch.",
    "Set screenWatchIntent.confidence from 0 to 1. Use high confidence only when live visual context is clearly useful."
  ];
}

// ---------------------------------------------------------------------------
// Video context
// ---------------------------------------------------------------------------

function buildVideoContextDocs(): string[] {
  return [
    "=== VIDEO CONTEXT (video_context tool) ===",
    "Use the video_context tool to extract metadata, transcripts, and keyframe images from video URLs.",
    "For current message uploads, you may pass a video ref (for example VID 1) instead of a raw URL.",
    "Supports YouTube, TikTok, X/Twitter, Reddit, Twitch, Streamable, and other video hosts.",
    "Prefer video_context over web_scrape or browser_browse when you want video-specific content like transcripts.",
    "Treat transcripts and keyframes as partial context. Avoid overclaiming what happened in the full video.",
    "For pages that need JS rendering or interaction, fall back to browser_browse."
  ];
}

// ---------------------------------------------------------------------------
// Composite: build the full TOOLS section for text system prompt
// ---------------------------------------------------------------------------

export type TextSystemCapabilityFlags = {
  voiceEnabled: boolean;
  webSearchEnabled: boolean;
  browserEnabled: boolean;
  memoryEnabled: boolean;
  codeAgentEnabled: boolean;
  minecraftEnabled: boolean;
  mediaGenerationEnabled: boolean;
  gifsEnabled: boolean;
  automationEnabled: boolean;
  screenShareEnabled: boolean;
  videoContextEnabled: boolean;
  maxMediaPromptChars: number;
};

export function buildTextCapabilitiesDocs(
  settings: unknown,
  flags: TextSystemCapabilityFlags
): string[] {
  const sections: string[] = [];

  // -- Compact tool quick-reference ------------------------------------
  const availableToolNames: string[] = ["conversation_search"];
  if (flags.webSearchEnabled) availableToolNames.push("web_search", "web_scrape");
  if (flags.browserEnabled) availableToolNames.push("browser_browse");
  if (flags.memoryEnabled) availableToolNames.push("memory_search", "memory_write");
  availableToolNames.push("image_lookup");
  if (flags.codeAgentEnabled) {
    availableToolNames.push(
      "spawn_code_worker", "request_task", "get_task", "list_tasks", "update_task",
      "send_message", "wait_for_activity", "list_instances", "kv_get", "kv_set", "kv_list"
    );
  }
  if (flags.minecraftEnabled) availableToolNames.push("minecraft_task");
  if (flags.voiceEnabled) {
    availableToolNames.push(
      "join_voice_channel", "leave_voice_channel",
      "music_play", "music_search", "music_queue_add", "music_queue_next",
      "video_play", "video_search",
      "media_stop", "media_pause", "media_resume", "media_skip", "media_now_playing",
      "media_reply_handoff", "stream_visualizer", "play_soundboard", "note_context"
    );
  }
  if (flags.voiceEnabled && flags.browserEnabled) availableToolNames.push("share_browser_session");
  if (flags.voiceEnabled) availableToolNames.push("stop_video_share");
  if (flags.screenShareEnabled) availableToolNames.push("start_screen_watch");

  sections.push(...buildToolSummaryBlock(availableToolNames));

  // -- Detailed behavioral guidance per capability ---------------------
  // Conversation search is always available (no settings gate)
  sections.push(...buildConversationSearchDocs());

  if (flags.webSearchEnabled) {
    sections.push(...buildWebSearchDocs({ includeBrowserBrowse: flags.browserEnabled }));
  }

  if (flags.browserEnabled) {
    sections.push(...buildBrowserDocs());
  }

  if (flags.memoryEnabled) {
    sections.push(...buildMemoryLookupDocs());
  }

  if (flags.codeAgentEnabled) {
    sections.push(...buildCodeAgentDocs());
  }

  // Image lookup works on message history, not durable memory — always include docs
  sections.push(...buildImageLookupDocs());

  if (flags.minecraftEnabled) {
    sections.push(...buildMinecraftDocs());
  }

  if (flags.voiceEnabled) {
    sections.push(...buildVoiceControlDocs(settings));
  }

  if (flags.screenShareEnabled) {
    sections.push(...buildScreenWatchDocs());
  }

  if (flags.automationEnabled) {
    sections.push(...buildAutomationDocs());
  }

  if (flags.videoContextEnabled) {
    availableToolNames.push("video_context");
    sections.push(...buildVideoContextDocs());
  }

  if (flags.mediaGenerationEnabled) {
    sections.push(...buildMediaGenerationDocs(settings, flags.maxMediaPromptChars));
  }

  if (flags.gifsEnabled) {
    sections.push(...buildGifDocs());
  }

  sections.push(...buildTextOutputFormatDocs());

  return sections;
}

// ===========================================================================
// Voice-specific capability docs
// ===========================================================================

// ---------------------------------------------------------------------------
// Voice tool usage philosophy (static guidance)
// ---------------------------------------------------------------------------

function buildVoiceToolUsageDocs(): string[] {
  return [
    "Speak first on casual turns. Use tools to improve accuracy or execute requested actions. Always include a brief spoken acknowledgment before calling tools (e.g., 'Sure, one sec' or 'Let me pull that up') — tool calls can take several seconds and the user hears silence until you speak. Ground factual or success claims in tool results — never claim success before a tool returns."
  ];
}

// ---------------------------------------------------------------------------
// Voice memory tool docs
// ---------------------------------------------------------------------------

function buildVoiceMemoryToolDocs(): string[] {
  return [
    "note_context: session-scoped facts, preferences, or plans for this conversation.",
    "memory_write: long-term durable facts only (namespace=speaker/guild/self, type=preference/profile/relationship/guidance/behavioral/other). Don't save chatter, prompt instructions, or session-only info. Write facts from your own perspective — use 'me'/'my' instead of your name."
  ];
}

// ---------------------------------------------------------------------------
// Voice music/media tool docs
// ---------------------------------------------------------------------------

function buildVoiceMusicToolDocs(): string[] {
  return [
    "Music: music_play starts audio-only playback (no Go Live stream). Re-call with selection_id only when reusing an exact prior id. Omit selection_id unless you already have the exact id from prompt context or a prior tool result. Never invent placeholder or markup tokens.",
    "Video: video_play starts YouTube video playback and shows it via Discord Go Live. Re-call with selection_id only when reusing an exact prior id.",
    "Visualizer: stream_visualizer starts a Go Live audio visualizer for currently playing music. Optional mode: cqt, spectrum, waves, vectorscope.",
    "Use video_search only when the user explicitly wants video options. If seeing the site, thumbnails, or layout would help you decide, browser_browse can be the better tool.",
    "Queue: music_queue_next (after current) and music_queue_add (append) can take either direct query text or exact prior IDs. Prefer direct query for ordinary queue requests; use music_search only when the user explicitly wants options or browsing.",
    "For a request like \"play X, then queue Y\", emit music_play for X first and music_queue_next for Y second in the same tool response. Do not say Y is queued unless music_queue_next or music_queue_add succeeds.",
    "Other playback controls: media_stop, media_pause, media_resume, media_skip, media_now_playing. Don't chain queue_add+skip to emulate play-now.",
    `Floor control: ${MUSIC_ACTIVE_AUTONOMY_POLICY_LINE}`,
    MUSIC_REPLY_HANDOFF_POLICY_LINE
  ];
}

// ---------------------------------------------------------------------------
// Voice screen share tool docs
// ---------------------------------------------------------------------------

function buildVoiceScreenShareToolDocs(): string[] {
  return [
    "start_screen_watch: begin screen watch when live visual context would help. If multiple Discord shares are live and you want a specific one, pass { target: \"display name\" }. The runtime binds to an active Discord sharer when possible and falls back automatically when needed.",
    "A successful start_screen_watch does not always mean live pixels are ready yet. If the tool result says frameReady=false, do not claim to see the screen yet.",
    "If start_screen_watch falls back to a link or returns linkUrl, treat that as off-screen coordination. In spoken replies, tell them to open the link you sent or the screen-share link. Do not read the full URL aloud unless they explicitly ask you to spell it out."
  ];
}

// ---------------------------------------------------------------------------
// Voice leave channel docs
// ---------------------------------------------------------------------------

function buildVoiceLeaveChannelDocs(): string[] {
  return [
    "leave_voice_channel: only when you choose to end your VC session. Goodbyes alone don't force exit."
  ];
}

// ---------------------------------------------------------------------------
// Voice output format (spoken text rules)
// ---------------------------------------------------------------------------

function buildVoiceOutputFormatDocs(): string[] {
  return [
    "=== OUTPUT FORMAT ===",
    "If you speak, begin with one hidden audience prefix: [[TO:SPEAKER]], [[TO:ALL]], or [[TO:<participant display name>]]. This prefix is metadata only and is not spoken aloud.",
    "You may optionally add a lease prefix immediately after [[TO:...]]: [[LEASE:ASSERTIVE]] or [[LEASE:ATOMIC]].",
    "A lease gives your reply a brief protected runway: it resists being pushed aside by newer chatter before you start speaking, and briefly resists interruption after you start so your point can land.",
    "ASSERTIVE: use when your reply directly answers a question, confirms an action, or delivers a tool result. The listener asked for this and should hear it.",
    "ATOMIC: use when the reply is safety-relevant, completes a multi-step action, or corrects a dangerous misunderstanding. Rare.",
    "No lease: ambient commentary, greetings, reactions, jokes, voluntary observations. Most replies need no lease.",
    "Do not lease a reply just because you find it interesting. Lease it because the listener needs it.",
    "Reply with [SKIP] or the hidden [[TO:...]] prefix, optional [[LEASE:...]] prefix, then spoken text. No JSON/markdown/tags.",
    "Your text is read aloud by TTS. Avoid text shorthand that sounds wrong when spoken (lmao, fr, omg, brb, imo, ngl, idk, smh, tbh, lol). Use the full phrase or a natural spoken equivalent instead."
  ];
}

// ---------------------------------------------------------------------------
// Voice web search docs (voice-specific variant with onePerTurn)
// ---------------------------------------------------------------------------

function buildVoiceWebSearchDocs({ includeBrowserBrowse = false }: { includeBrowserBrowse?: boolean } = {}): string[] {
  return [
    buildWebToolRoutingPolicyLine({ includeBrowserBrowse }),
    buildWebSearchPolicyLine({ onePerTurn: true }),
    WEB_SCRAPE_POLICY_LINE
  ];
}

function buildVoiceBrowserDocs(): string[] {
  return [BROWSER_BROWSE_POLICY_LINE];
}

// ---------------------------------------------------------------------------
// Composite: build the full TOOLS section for voice system prompt
// ---------------------------------------------------------------------------

export type VoiceSystemCapabilityFlags = {
  webSearchEnabled: boolean;
  browserEnabled: boolean;
  memoryEnabled: boolean;
  minecraftEnabled: boolean;
  screenShareEnabled: boolean;
};

export function buildVoiceCapabilitiesDocs(
  flags: VoiceSystemCapabilityFlags
): string[] {
  const sections: string[] = [];

  // -- Compact tool quick-reference ------------------------------------
  const availableToolNames: string[] = ["conversation_search"];
  if (flags.memoryEnabled) availableToolNames.push("memory_write", "note_context");
  availableToolNames.push(
    "music_play", "music_search", "music_queue_add", "music_queue_next",
    "video_play", "video_search",
    "media_stop", "media_pause", "media_resume", "media_skip", "media_now_playing",
    "media_reply_handoff", "stream_visualizer", "play_soundboard",
    "leave_voice_channel"
  );
  if (flags.minecraftEnabled) availableToolNames.push("minecraft_task");
  if (flags.webSearchEnabled) availableToolNames.push("web_search", "web_scrape");
  if (flags.browserEnabled) availableToolNames.push("browser_browse");
  if (flags.screenShareEnabled) availableToolNames.push("start_screen_watch");

  sections.push(...buildToolSummaryBlock(availableToolNames, VOICE_TOOL_SUMMARIES));

  // -- Detailed behavioral guidance per capability ---------------------
  // Tool usage philosophy (always present in voice)
  sections.push(...buildVoiceToolUsageDocs());

  // Conversation search is always available
  sections.push(...buildConversationSearchDocs());

  if (flags.memoryEnabled) {
    sections.push(...buildVoiceMemoryToolDocs());
  }

  if (flags.minecraftEnabled) {
    sections.push(...buildMinecraftDocs());
  }

  // Voice/music tools are always present in voice sessions
  sections.push(...buildVoiceMusicToolDocs());
  sections.push(...buildVoiceLeaveChannelDocs());

  if (flags.webSearchEnabled) {
    sections.push(...buildVoiceWebSearchDocs({ includeBrowserBrowse: flags.browserEnabled }));
  }

  if (flags.browserEnabled) {
    sections.push(...buildVoiceBrowserDocs());
  }

  if (flags.screenShareEnabled) {
    sections.push(...buildVoiceScreenShareToolDocs());
  }

  sections.push(...buildVoiceOutputFormatDocs());

  return sections;
}
