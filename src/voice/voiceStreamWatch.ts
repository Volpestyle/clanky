import { clamp } from "../utils.ts";
import { getPromptBotName } from "../promptCore.ts";
import { safeJsonParseFromString } from "../normalization/valueParsers.ts";
import {
  getBotName,
  getResolvedOrchestratorBinding,
  getVoiceStreamWatchSettings
} from "../settings/agentStack.ts";
import { buildRealtimeTextUtterancePrompt, isRealtimeMode, normalizeVoiceText } from "./voiceSessionHelpers.ts";

const STREAM_WATCH_AUDIO_QUIET_WINDOW_MS = 2200;
const STREAM_WATCH_COMMENTARY_PROMPT_MAX_CHARS = 220;
const STREAM_WATCH_COMMENTARY_LINE_MAX_CHARS = 160;
const STREAM_WATCH_BRAIN_CONTEXT_PROMPT_MAX_CHARS = 420;
const STREAM_WATCH_BRAIN_CONTEXT_LINE_MAX_CHARS = 220;
const STREAM_WATCH_VISION_MAX_OUTPUT_TOKENS = 72;
const STREAM_WATCH_COMMENTARY_PATH_AUTO = "auto";
const STREAM_WATCH_COMMENTARY_PATH_ANTHROPIC_KEYFRAMES = "anthropic_keyframes";
const DEFAULT_STREAM_WATCH_BRAIN_CONTEXT_PROMPT =
  "For each keyframe, classify it as gameplay or non-gameplay, then generate notes that support either play-by-play commentary or observational shout-out commentary.";
const STREAM_WATCH_FRAME_ANALYSIS_JSON_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    note: { type: "string" },
    sceneChanged: { type: "boolean" },
    shouldComment: { type: "boolean" }
  },
  required: ["note", "sceneChanged", "shouldComment"],
  additionalProperties: false
});
const STREAM_WATCH_MEMORY_RECAP_JSON_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    shouldStore: { type: "boolean" },
    recap: { type: "string" }
  },
  required: ["shouldStore", "recap"],
  additionalProperties: false
});

function normalizeStreamWatchCommentaryPath(value, fallback = STREAM_WATCH_COMMENTARY_PATH_AUTO) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === STREAM_WATCH_COMMENTARY_PATH_ANTHROPIC_KEYFRAMES) {
    return STREAM_WATCH_COMMENTARY_PATH_ANTHROPIC_KEYFRAMES;
  }
  if (normalized === STREAM_WATCH_COMMENTARY_PATH_AUTO) {
    return STREAM_WATCH_COMMENTARY_PATH_AUTO;
  }
  return fallback;
}

function resolveStreamWatchCommentaryPath(settings = null) {
  const configured = getVoiceStreamWatchSettings(settings).commentaryPath;
  return normalizeStreamWatchCommentaryPath(configured, STREAM_WATCH_COMMENTARY_PATH_AUTO);
}

function resolveStreamWatchBrainContextSettings(settings = null) {
  const streamWatchSettings = getVoiceStreamWatchSettings(settings);
  const prompt = normalizeVoiceText(
    String(streamWatchSettings.brainContextPrompt || ""),
    STREAM_WATCH_BRAIN_CONTEXT_PROMPT_MAX_CHARS
  );

  return {
    enabled:
      streamWatchSettings.brainContextEnabled !== undefined
        ? Boolean(streamWatchSettings.brainContextEnabled)
        : true,
    minIntervalSeconds: clamp(
      Number(streamWatchSettings.brainContextMinIntervalSeconds) || 4,
      1,
      120
    ),
    maxEntries: clamp(
      Number(streamWatchSettings.brainContextMaxEntries) || 8,
      1,
      24
    ),
    prompt: prompt || DEFAULT_STREAM_WATCH_BRAIN_CONTEXT_PROMPT
  };
}

function getStreamWatchBrainContextEntries(session, maxEntries = 8) {
  const streamWatch = session?.streamWatch && typeof session.streamWatch === "object" ? session.streamWatch : {};
  const entries = Array.isArray(streamWatch.brainContextEntries) ? streamWatch.brainContextEntries : [];
  const boundedMax = clamp(Number(maxEntries) || 8, 1, 24);
  return entries
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const text = normalizeVoiceText(entry.text, STREAM_WATCH_BRAIN_CONTEXT_LINE_MAX_CHARS);
      if (!text) return null;
      const atRaw = Number(entry.at);
      return {
        text,
        at: Number.isFinite(atRaw) ? Math.max(0, Math.round(atRaw)) : 0,
        provider: String(entry.provider || "").trim() || null,
        model: String(entry.model || "").trim() || null,
        speakerName: String(entry.speakerName || "").trim() || null
      };
    })
    .filter(Boolean)
    .slice(-boundedMax);
}

function getLatestStreamWatchBrainContextEntry(session) {
  const entries = getStreamWatchBrainContextEntries(session, 24);
  return entries[entries.length - 1] || null;
}

function buildStreamWatchNotesText(session, maxEntries = 6) {
  return getStreamWatchBrainContextEntries(session, maxEntries)
    .slice(-Math.max(1, Number(maxEntries) || 6))
    .map((entry, index) => {
      const speakerPrefix = entry.speakerName ? `${entry.speakerName}: ` : "";
      return `${index + 1}. ${speakerPrefix}${entry.text}`;
    })
    .join("\n");
}

function appendStreamWatchBrainContextEntry({
  session,
  text,
  at,
  provider = null,
  model = null,
  speakerName = null,
  maxEntries = 8
}) {
  if (!session) return null;
  const normalizedText = normalizeVoiceText(text, STREAM_WATCH_BRAIN_CONTEXT_LINE_MAX_CHARS);
  if (!normalizedText) return null;
  const normalizedAt = Number.isFinite(Number(at)) ? Math.max(0, Math.round(Number(at))) : Date.now();
  const boundedMax = clamp(Number(maxEntries) || 8, 1, 24);
  const current = getStreamWatchBrainContextEntries(session, boundedMax);
  const last = current[current.length - 1] || null;
  const normalizedProvider = String(provider || "").trim() || null;
  const normalizedModel = String(model || "").trim() || null;
  const normalizedSpeakerName = String(speakerName || "").trim() || null;
  let nextEntries = current;

  if (last && last.text.toLowerCase() === normalizedText.toLowerCase()) {
    nextEntries = [
      ...current.slice(0, -1),
      {
        ...last,
        at: normalizedAt,
        provider: normalizedProvider || last.provider || null,
        model: normalizedModel || last.model || null,
        speakerName: normalizedSpeakerName || last.speakerName || null
      }
    ];
  } else {
    nextEntries = [
      ...current,
      {
        text: normalizedText,
        at: normalizedAt,
        provider: normalizedProvider,
        model: normalizedModel,
        speakerName: normalizedSpeakerName
      }
    ].slice(-boundedMax);
  }

  session.streamWatch = session.streamWatch || {};
  session.streamWatch.brainContextEntries = nextEntries;
  session.streamWatch.lastBrainContextAt = normalizedAt;
  session.streamWatch.lastBrainContextProvider = normalizedProvider;
  session.streamWatch.lastBrainContextModel = normalizedModel;
  return nextEntries[nextEntries.length - 1] || null;
}

function isStreamWatchPlaybackBusy(session) {
  if (!session || session.ending) return false;
  if (session.botTurnOpen) return true;
  const streamBuffered = Math.max(0, Number(session.botAudioStream?.writableLength || 0));
  return streamBuffered > 0;
}

async function sendStreamWatchOfflineMessage(manager, { message, settings, guildId, requesterId }) {
  await manager.sendOperationalMessage({
    channel: message.channel,
    settings,
    guildId,
    channelId: message.channelId,
    userId: requesterId,
    messageId: message.id,
    event: "voice_stream_watch_request",
    reason: "offline",
    details: {}
  });
}

async function resolveStreamWatchRequestContext(manager, { message, settings }) {
  if (!message?.guild || !message?.channel) return null;
  const guildId = String(message.guild.id);
  const requesterId = String(message.author?.id || "").trim() || null;
  const session = manager.sessions.get(guildId);
  if (!session) {
    await sendStreamWatchOfflineMessage(manager, {
      message,
      settings,
      guildId,
      requesterId
    });
    return {
      handled: true
    };
  }
  return {
    handled: false,
    guildId,
    requesterId,
    session
  };
}

export async function requestWatchStream(manager, { message, settings, targetUserId = null }) {
  const context = await resolveStreamWatchRequestContext(manager, { message, settings });
  if (!context) return false;
  if (context.handled) return true;
  const { guildId, session, requesterId } = context;

  if (String(message.member?.voice?.channelId || "") !== String(session.voiceChannelId || "")) {
    await manager.sendOperationalMessage({
      channel: message.channel,
      settings,
      guildId,
      channelId: message.channelId,
      userId: requesterId,
      messageId: message.id,
      event: "voice_stream_watch_request",
      reason: "requester_not_in_same_vc",
      details: {
        voiceChannelId: session.voiceChannelId
      }
    });
    return true;
  }

  const streamWatchSettings = settings?.voice?.streamWatch || {};
  if (!streamWatchSettings.enabled) {
    await manager.sendOperationalMessage({
      channel: message.channel,
      settings,
      guildId,
      channelId: message.channelId,
      userId: requesterId,
      messageId: message.id,
      event: "voice_stream_watch_request",
      reason: "stream_watch_disabled",
      details: {}
    });
    return true;
  }

  if (!supportsStreamWatchCommentary(manager, session, settings)) {
    await manager.sendOperationalMessage({
      channel: message.channel,
      settings,
      guildId,
      channelId: message.channelId,
      userId: requesterId,
      messageId: message.id,
      event: "voice_stream_watch_request",
      reason: "stream_watch_provider_unavailable",
      details: {
        mode: session.mode,
        realtimeProvider: session.realtimeProvider
      }
    });
    return true;
  }

  initializeStreamWatchState(manager, {
    session,
    requesterUserId: requesterId,
    targetUserId: String(targetUserId || requesterId || "").trim() || null
  });

  await manager.sendOperationalMessage({
    channel: message.channel,
    settings,
    guildId,
    channelId: message.channelId,
    userId: requesterId,
    messageId: message.id,
    event: "voice_stream_watch_request",
    reason: "watching_started",
    details: {
      targetUserId: session.streamWatch.targetUserId
    },
    mustNotify: false
  });
  return true;
}

export function initializeStreamWatchState(manager, { session, requesterUserId, targetUserId = null }) {
  if (!session) return;
  session.streamWatch = session.streamWatch || {};
  session.streamWatch.active = true;
  session.streamWatch.targetUserId = String(targetUserId || requesterUserId || "").trim() || null;
  session.streamWatch.requestedByUserId = String(requesterUserId || "").trim() || null;
  session.streamWatch.lastFrameAt = 0;
  session.streamWatch.lastCommentaryAt = 0;
  session.streamWatch.lastCommentaryNote = null;
  session.streamWatch.lastMemoryRecapAt = 0;
  session.streamWatch.lastMemoryRecapText = null;
  session.streamWatch.lastMemoryRecapDurableSaved = false;
  session.streamWatch.lastMemoryRecapReason = null;
  session.streamWatch.lastBrainContextAt = 0;
  session.streamWatch.lastBrainContextProvider = null;
  session.streamWatch.lastBrainContextModel = null;
  session.streamWatch.brainContextEntries = [];
  session.streamWatch.ingestedFrameCount = 0;
  session.streamWatch.acceptedFrameCountInWindow = 0;
  session.streamWatch.frameWindowStartedAt = 0;
  session.streamWatch.latestFrameMimeType = null;
  session.streamWatch.latestFrameDataBase64 = "";
  session.streamWatch.latestFrameAt = 0;
}

export function getStreamWatchBrainContextForPrompt(session, settings = null) {
  if (!session || session.ending) return null;
  const streamWatch = session.streamWatch || {};

  const brainContextSettings = resolveStreamWatchBrainContextSettings(settings);
  if (!brainContextSettings.enabled) return null;

  const entries = getStreamWatchBrainContextEntries(session, brainContextSettings.maxEntries);
  if (!entries.length) return null;

  const now = Date.now();
  const notes = entries
    .map((entry) => {
      const ageMs = Math.max(0, now - Number(entry.at || 0));
      const ageSeconds = Math.floor(ageMs / 1000);
      const ageLabel = ageSeconds <= 1 ? "just now" : `${ageSeconds}s ago`;
      const speakerLabel = entry.speakerName ? `${entry.speakerName}: ` : "";
      return `${speakerLabel}${entry.text} (${ageLabel})`;
    })
    .slice(-brainContextSettings.maxEntries);

  if (!notes.length) return null;

  const last = entries[entries.length - 1] || null;
  return {
    prompt: brainContextSettings.prompt,
    notes,
    lastAt: Number(last?.at || 0) || null,
    provider: last?.provider || streamWatch.lastBrainContextProvider || null,
    model: last?.model || streamWatch.lastBrainContextModel || null,
    active: Boolean(streamWatch.active)
  };
}

export function supportsStreamWatchCommentary(manager, session, settings = null) {
  if (!session || session.ending) return false;
  const resolvedSettings = settings || session.settingsSnapshot || manager.store.getSettings();
  if (!isRealtimeMode(session.mode)) return false;
  const realtimeClient = session.realtimeClient;
  const streamWatchSettings = resolvedSettings?.voice?.streamWatch || {};
  const autonomousCommentaryEnabled =
    streamWatchSettings.autonomousCommentaryEnabled !== undefined
      ? Boolean(streamWatchSettings.autonomousCommentaryEnabled)
      : true;
  const brainContextSettings = resolveStreamWatchBrainContextSettings(resolvedSettings);
  const brainContextReady =
    brainContextSettings.enabled &&
    supportsStreamWatchBrainContext(manager, { session, settings: resolvedSettings });

  if (!autonomousCommentaryEnabled) return brainContextReady;

  const commentaryPath = resolveStreamWatchCommentaryPath(resolvedSettings);
  if (commentaryPath === STREAM_WATCH_COMMENTARY_PATH_ANTHROPIC_KEYFRAMES) {
    return (
      supportsVisionFallbackStreamWatchCommentary(manager, { session, settings: resolvedSettings }) ||
      brainContextReady
    );
  }
  const hasNativeVideoCommentary = Boolean(
    realtimeClient &&
      typeof realtimeClient.appendInputVideoFrame === "function" &&
      typeof realtimeClient.requestVideoCommentary === "function"
  );
  if (hasNativeVideoCommentary) return true;
  return supportsVisionFallbackStreamWatchCommentary(manager, { session, settings: resolvedSettings });
}

export function supportsVisionFallbackStreamWatchCommentary(manager, { session = null, settings = null } = {}) {
  if (!session || session.ending) return false;
  const realtimeClient = session.realtimeClient;
  if (!realtimeClient || typeof realtimeClient.requestTextUtterance !== "function") return false;
  if (!manager.llm || typeof manager.llm.generate !== "function") return false;
  return Boolean(resolveStreamWatchVisionProviderSettings(manager, settings));
}

export function supportsStreamWatchBrainContext(manager, { session = null, settings = null } = {}) {
  if (!session || session.ending) return false;
  if (!manager.llm || typeof manager.llm.generate !== "function") return false;
  return Boolean(resolveStreamWatchVisionProviderSettings(manager, settings));
}

export function resolveStreamWatchVisionProviderSettings(manager, settings = null) {
  const commentaryPath = resolveStreamWatchCommentaryPath(settings);
  const llmSettings = getResolvedOrchestratorBinding(settings);
  const fallbackCandidates = [
    {
      provider: "anthropic",
      model: "claude-haiku-4-5"
    },
    {
      provider: "xai",
      model: "grok-2-vision-latest"
    },
    {
      provider: "claude-code",
      model: "sonnet"
    }
  ];
  const candidates = commentaryPath === STREAM_WATCH_COMMENTARY_PATH_ANTHROPIC_KEYFRAMES
    ? fallbackCandidates.filter((candidate) => candidate.provider === "anthropic")
    : fallbackCandidates;

  for (const candidate of candidates) {
    const configured = manager.llm?.isProviderConfigured?.(candidate.provider);
    if (!configured) continue;
    return {
      ...llmSettings,
      provider: candidate.provider,
      model: candidate.model,
      temperature: 0.3,
      maxOutputTokens: STREAM_WATCH_VISION_MAX_OUTPUT_TOKENS
    };
  }

  return null;
}

export async function generateVisionFallbackStreamWatchCommentary(manager, {
  session,
  settings,
  streamerUserId = null,
  frameMimeType = "image/jpeg",
  frameDataBase64 = ""
}) {
  if (!session || session.ending) return null;
  if (!manager.llm || typeof manager.llm.generate !== "function") return null;
  const normalizedFrame = String(frameDataBase64 || "").trim();
  if (!normalizedFrame) return null;

  const providerSettings = resolveStreamWatchVisionProviderSettings(manager, settings);
  if (!providerSettings) return null;
  const speakerName = manager.resolveVoiceSpeakerName(session, streamerUserId) || "the streamer";
  const systemPrompt = [
    `You are ${getPromptBotName(settings)} in Discord VC.`,
    "You are looking at one still frame from a live stream.",
    "You can see the provided frame.",
    "Never say you cannot see the screen or ask for a stream link.",
    "Return exactly one short spoken commentary line (max 12 words).",
    "No lists, no quotes, no stage directions."
  ].join(" ");
  const userPrompt = [
    `Latest frame from ${speakerName}'s stream.`,
    "Comment on only what is visible in this frame.",
    "If uncertain about details, say that briefly without denying visibility."
  ].join(" ");

  const generated = await manager.llm.generate({
    settings: {
      ...(settings || {}),
      llm: providerSettings
    },
    systemPrompt,
    userPrompt,
    imageInputs: [
      {
        mediaType: String(frameMimeType || "image/jpeg"),
        dataBase64: normalizedFrame
      }
    ],
    trace: {
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: manager.client.user?.id || null,
      source: "voice_stream_watch_vision_fallback"
    }
  });

  const rawText = String(generated?.text || "").trim();
  const oneLine = rawText.split(/\r?\n/)[0] || "";
  const text = normalizeVoiceText(oneLine, STREAM_WATCH_COMMENTARY_LINE_MAX_CHARS);
  if (!text) return null;
  return {
    text,
    provider: generated?.provider || providerSettings.provider || null,
    model: generated?.model || providerSettings.model || null
  };
}

async function generateVisionFallbackStreamWatchBrainContext(manager, {
  session,
  settings,
  streamerUserId = null,
  frameMimeType = "image/jpeg",
  frameDataBase64 = ""
}) {
  if (!session || session.ending) return null;
  if (!manager.llm || typeof manager.llm.generate !== "function") return null;
  const normalizedFrame = String(frameDataBase64 || "").trim();
  if (!normalizedFrame) return null;

  const providerSettings = resolveStreamWatchVisionProviderSettings(manager, settings);
  if (!providerSettings) return null;
  const speakerName = manager.resolveVoiceSpeakerName(session, streamerUserId) || "the streamer";
  const brainContextSettings = resolveStreamWatchBrainContextSettings(settings);
  const previousNote = getLatestStreamWatchBrainContextEntry(session)?.text || "";
  const systemPrompt = [
    `You are ${getPromptBotName(settings)} preparing private stream-watch notes for your own voice brain.`,
    "You are looking at one still frame from a live stream.",
    "Never claim you cannot see the stream.",
    "Return strict JSON only.",
    "The note must be one short factual private note, max 16 words.",
    "sceneChanged should be true only when the visible scene meaningfully changed from the previous private note.",
    "shouldComment should be true only if an unsolicited casual spoken comment would feel natural and useful right now.",
    "Menus, static HUDs, unchanged desktop views, and near-identical frames should usually set both booleans false.",
    "Do not write dialogue or commands."
  ].join(" ");
  const userPrompt = [
    `Frame from ${speakerName}'s stream.`,
    previousNote ? `Previous private note: ${previousNote}` : "Previous private note: none.",
    String(brainContextSettings.prompt || DEFAULT_STREAM_WATCH_BRAIN_CONTEXT_PROMPT),
    "Focus only on what is visible now. Mention uncertainty briefly if needed."
  ].join(" ");

  const generated = await manager.llm.generate({
    settings: {
      ...(settings || {}),
      llm: providerSettings
    },
    systemPrompt,
    userPrompt,
    imageInputs: [
      {
        mediaType: String(frameMimeType || "image/jpeg"),
        dataBase64: normalizedFrame
      }
    ],
    trace: {
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: manager.client.user?.id || null,
      source: "voice_stream_watch_brain_context"
    },
    jsonSchema: STREAM_WATCH_FRAME_ANALYSIS_JSON_SCHEMA
  });

  const rawText = String(generated?.text || "").trim();
  const parsed = safeJsonParseFromString(rawText, null);
  const parsedNote = parsed && typeof parsed === "object" ? parsed.note : "";
  const oneLine = String(parsedNote || rawText).split(/\r?\n/)[0] || "";
  const text = normalizeVoiceText(oneLine, STREAM_WATCH_BRAIN_CONTEXT_LINE_MAX_CHARS);
  if (!text) return null;
  const sceneChanged = parsed && typeof parsed === "object" && typeof parsed.sceneChanged === "boolean"
    ? parsed.sceneChanged
    : !previousNote || previousNote.toLowerCase() !== text.toLowerCase();
  const shouldComment = parsed && typeof parsed === "object" && typeof parsed.shouldComment === "boolean"
    ? parsed.shouldComment
    : sceneChanged;
  return {
    text,
    sceneChanged,
    shouldComment,
    provider: generated?.provider || providerSettings.provider || null,
    model: generated?.model || providerSettings.model || null
  };
}

async function maybeRefreshStreamWatchBrainContext(manager, {
  session,
  settings,
  streamerUserId = null,
  source = "api_stream_ingest"
}) {
  if (!session || session.ending) return null;
  if (!session.streamWatch?.active) return null;
  const brainContextSettings = resolveStreamWatchBrainContextSettings(settings);
  if (!brainContextSettings.enabled) return null;
  const now = Date.now();
  const minIntervalMs = brainContextSettings.minIntervalSeconds * 1000;
  if (now - Number(session.streamWatch.lastBrainContextAt || 0) < minIntervalMs) return null;

  const bufferedFrame = String(session.streamWatch?.latestFrameDataBase64 || "").trim();
  if (!bufferedFrame) return null;
  const previousEntries = getStreamWatchBrainContextEntries(session, brainContextSettings.maxEntries);
  const previousLast = previousEntries[previousEntries.length - 1] || null;
  const generated = await generateVisionFallbackStreamWatchBrainContext(manager, {
    session,
    settings,
    streamerUserId,
    frameMimeType: session.streamWatch?.latestFrameMimeType || "image/jpeg",
    frameDataBase64: bufferedFrame
  });
  const note = normalizeVoiceText(generated?.text || "", STREAM_WATCH_BRAIN_CONTEXT_LINE_MAX_CHARS);
  if (!note) return null;
  const speakerName = manager.resolveVoiceSpeakerName(session, streamerUserId) || null;
  const stored = appendStreamWatchBrainContextEntry({
    session,
    text: note,
    at: now,
    provider: generated?.provider || null,
    model: generated?.model || null,
    speakerName,
    maxEntries: brainContextSettings.maxEntries
  });
  if (!stored) return null;

  manager.store.logAction({
    kind: "voice_runtime",
    guildId: session.guildId,
    channelId: session.textChannelId,
    userId: manager.client.user?.id || null,
    content: "stream_watch_brain_context_updated",
    metadata: {
      sessionId: session.id,
      source: String(source || "api_stream_ingest"),
      streamerUserId: streamerUserId || null,
      provider: generated?.provider || null,
      model: generated?.model || null,
      note: stored.text
    }
  });

  return {
    note: stored.text,
    changed: !previousLast || previousLast.text.toLowerCase() !== stored.text.toLowerCase(),
    shouldComment: generated?.shouldComment !== undefined ? Boolean(generated.shouldComment) : true,
    sceneChanged: generated?.sceneChanged !== undefined
      ? Boolean(generated.sceneChanged)
      : !previousLast || previousLast.text.toLowerCase() !== stored.text.toLowerCase(),
    provider: generated?.provider || null,
    model: generated?.model || null
  };
}

async function generateStreamWatchMemoryRecap(manager, {
  session,
  settings,
  reason = "watching_stopped"
}) {
  const notesText = buildStreamWatchNotesText(session, 6);
  if (!notesText) return null;
  const speakerName = manager.resolveVoiceSpeakerName(session, session.streamWatch?.targetUserId) || "the streamer";
  const systemPrompt = [
    `You are ${getPromptBotName(settings)} summarizing an ended screen share for memory.`,
    "You will receive private notes captured during one screen-share session.",
    "Return strict JSON only.",
    "recap must be one concise grounded sentence, max 22 words.",
    "shouldStore should be true if the recap is useful future continuity for this conversation or likely relevant later.",
    "Avoid filler, speculation, and talk about the bot."
  ].join(" ");
  const userPrompt = [
    `Speaker: ${speakerName}`,
    `Stop reason: ${String(reason || "watching_stopped")}`,
    "Screen-share notes:",
    notesText
  ].join("\n");

  try {
    const generated = await manager.llm.generate({
      settings,
      systemPrompt,
      userPrompt,
      trace: {
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: manager.client.user?.id || null,
        source: "voice_stream_watch_memory_recap"
      },
      jsonSchema: STREAM_WATCH_MEMORY_RECAP_JSON_SCHEMA
    });
    const parsed = safeJsonParseFromString(String(generated?.text || ""), null);
    const recap = normalizeVoiceText(parsed?.recap || "", 190);
    if (!recap) return null;
    return {
      recap,
      shouldStore: parsed?.shouldStore !== undefined ? Boolean(parsed.shouldStore) : true
    };
  } catch {
    const latestNote = getLatestStreamWatchBrainContextEntry(session)?.text || "";
    const recap = normalizeVoiceText(
      `${speakerName} recently screen-shared ${latestNote || "their current screen context"}.`,
      190
    );
    return recap
      ? {
          recap,
          shouldStore: true
        }
      : null;
  }
}

async function persistStreamWatchRecapToMemory(manager, {
  session,
  settings,
  reason = "watching_stopped"
}) {
  if (!session || session.ending) return null;
  if (!settings?.memory?.enabled) return null;
  if (!manager.memory || typeof manager.memory !== "object") return null;
  if (typeof manager.memory.ingestMessage !== "function") return null;

  const recap = await generateStreamWatchMemoryRecap(manager, {
    session,
    settings,
    reason
  });
  if (!recap?.recap) return null;

  const messageId = `voice-screen-share-recap-${session.id}-${Date.now()}`;
  const authorId = String(manager.client.user?.id || "bot");
  const authorName = String(getBotName(settings) || manager.client.user?.username || "bot");
  const logContent = normalizeVoiceText(`Screen share recap: ${recap.recap}`, 320);
  if (logContent) {
    await manager.memory.ingestMessage({
      messageId,
      authorId,
      authorName,
      content: logContent,
      settings,
      trace: {
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: authorId,
        source: "voice_stream_watch_memory_recap"
      }
    });
  }

  let durableSaved = false;
  if (recap.shouldStore && typeof manager.memory.rememberDirectiveLineDetailed === "function") {
    const saved = await manager.memory.rememberDirectiveLineDetailed({
      line: recap.recap,
      sourceMessageId: messageId,
      userId: authorId,
      guildId: session.guildId,
      channelId: session.textChannelId,
      sourceText: recap.recap,
      scope: "lore",
      validationMode: "strict"
    });
    durableSaved = Boolean(saved?.ok);
  }

  manager.store.logAction({
    kind: "voice_runtime",
    guildId: session.guildId,
    channelId: session.textChannelId,
    userId: authorId,
    content: "stream_watch_memory_recap_saved",
    metadata: {
      sessionId: session.id,
      reason: String(reason || "watching_stopped"),
      recap: recap.recap,
      durableSaved
    }
  });

  session.streamWatch.lastMemoryRecapAt = Date.now();
  session.streamWatch.lastMemoryRecapText = recap.recap;
  session.streamWatch.lastMemoryRecapDurableSaved = durableSaved;
  session.streamWatch.lastMemoryRecapReason = String(reason || "watching_stopped");

  return {
    recap: recap.recap,
    durableSaved
  };
}

async function finalizeStreamWatchState(manager, {
  session,
  settings,
  reason = "watching_stopped",
  preserveBrainContext = true,
  persistMemory = true
}) {
  if (!session || session.ending) {
    return {
      ok: false,
      reason: "session_not_found"
    };
  }
  const resolvedSettings = settings || session.settingsSnapshot || manager.store.getSettings();
  const memoryRecap = persistMemory
    ? await persistStreamWatchRecapToMemory(manager, {
        session,
        settings: resolvedSettings,
        reason
      })
    : null;

  session.streamWatch.active = false;
  session.streamWatch.targetUserId = null;
  session.streamWatch.requestedByUserId = null;
  session.streamWatch.latestFrameMimeType = null;
  session.streamWatch.latestFrameDataBase64 = "";
  session.streamWatch.latestFrameAt = 0;

  if (!preserveBrainContext) {
    session.streamWatch.lastBrainContextAt = 0;
    session.streamWatch.lastBrainContextProvider = null;
    session.streamWatch.lastBrainContextModel = null;
    session.streamWatch.brainContextEntries = [];
  }

  return {
    ok: true,
    reason: "watching_stopped",
    memoryRecap
  };
}

export function isUserInSessionVoiceChannel(manager, { session, userId }) {
  const normalizedUserId = String(userId || "").trim();
  if (!session || !normalizedUserId) return false;
  const guild = manager.client.guilds.cache.get(String(session.guildId || "")) || null;
  const voiceChannel = guild?.channels?.cache?.get(String(session.voiceChannelId || "")) || null;
  return Boolean(voiceChannel?.members?.has?.(normalizedUserId));
}

export async function enableWatchStreamForUser(manager, {
  guildId,
  requesterUserId,
  targetUserId = null,
  settings = null,
  source = "screen_share_link"
}) {
  const normalizedGuildId = String(guildId || "").trim();
  const normalizedRequesterId = String(requesterUserId || "").trim();
  if (!normalizedGuildId || !normalizedRequesterId) {
    return {
      ok: false,
      reason: "invalid_request"
    };
  }

  const session = manager.sessions.get(normalizedGuildId);
  if (!session) {
    return {
      ok: false,
      reason: "session_not_found"
    };
  }

  if (!isUserInSessionVoiceChannel(manager, { session, userId: normalizedRequesterId })) {
    return {
      ok: false,
      reason: "requester_not_in_same_vc"
    };
  }

  const resolvedSettings = settings || session.settingsSnapshot || manager.store.getSettings();
  const streamWatchSettings = resolvedSettings?.voice?.streamWatch || {};
  if (!streamWatchSettings.enabled) {
    return {
      ok: false,
      reason: "stream_watch_disabled"
    };
  }

  if (!supportsStreamWatchCommentary(manager, session, resolvedSettings)) {
    return {
      ok: false,
      reason: "stream_watch_provider_unavailable"
    };
  }

  const resolvedTarget = String(targetUserId || normalizedRequesterId).trim() || normalizedRequesterId;
  initializeStreamWatchState(manager, {
    session,
    requesterUserId: normalizedRequesterId,
    targetUserId: resolvedTarget
  });
  manager.store.logAction({
    kind: "voice_runtime",
    guildId: session.guildId,
    channelId: session.textChannelId,
    userId: normalizedRequesterId,
    content: "stream_watch_enabled_programmatic",
    metadata: {
      sessionId: session.id,
      source: String(source || "screen_share_link"),
      targetUserId: resolvedTarget
    }
  });

  return {
    ok: true,
    reason: "watching_started",
    targetUserId: session.streamWatch?.targetUserId || resolvedTarget
  };
}

export async function requestStopWatchingStream(manager, { message, settings }) {
  const context = await resolveStreamWatchRequestContext(manager, { message, settings });
  if (!context) return false;
  if (context.handled) return true;
  const { guildId, session, requesterId } = context;

  if (!session.streamWatch?.active) {
    await manager.sendOperationalMessage({
      channel: message.channel,
      settings,
      guildId,
      channelId: message.channelId,
      userId: requesterId,
      messageId: message.id,
      event: "voice_stream_watch_request",
      reason: "already_stopped",
      details: {},
      mustNotify: false
    });
    return true;
  }

  const stopResult = await finalizeStreamWatchState(manager, {
    session,
    settings,
    reason: "watching_stopped",
    preserveBrainContext: true,
    persistMemory: true
  });

  await manager.sendOperationalMessage({
    channel: message.channel,
    settings,
    guildId,
    channelId: message.channelId,
    userId: requesterId,
    messageId: message.id,
    event: "voice_stream_watch_request",
    reason: "watching_stopped",
    details: {},
    mustNotify: false
  });
  return Boolean(stopResult?.ok);
}

export async function stopWatchStreamForUser(manager, {
  guildId,
  requesterUserId = null,
  targetUserId = null,
  settings = null,
  reason = "screen_share_session_stopped"
}) {
  const normalizedGuildId = String(guildId || "").trim();
  if (!normalizedGuildId) {
    return {
      ok: false,
      reason: "guild_id_required"
    };
  }

  const session = manager.sessions.get(normalizedGuildId);
  if (!session || session.ending) {
    return {
      ok: false,
      reason: "session_not_found"
    };
  }
  if (!session.streamWatch?.active) {
    return {
      ok: false,
      reason: "already_stopped"
    };
  }

  const normalizedRequesterId = String(requesterUserId || "").trim();
  const normalizedTargetUserId = String(targetUserId || "").trim();
  if (
    normalizedRequesterId &&
    session.streamWatch?.requestedByUserId &&
    String(session.streamWatch.requestedByUserId) !== normalizedRequesterId
  ) {
    return {
      ok: false,
      reason: "requester_mismatch"
    };
  }
  if (
    normalizedTargetUserId &&
    session.streamWatch?.targetUserId &&
    String(session.streamWatch.targetUserId) !== normalizedTargetUserId
  ) {
    return {
      ok: false,
      reason: "target_user_mismatch"
    };
  }

  return await finalizeStreamWatchState(manager, {
    session,
    settings,
    reason,
    preserveBrainContext: true,
    persistMemory: true
  });
}

export async function requestStreamWatchStatus(manager, { message, settings }) {
  const context = await resolveStreamWatchRequestContext(manager, { message, settings });
  if (!context) return false;
  if (context.handled) return true;
  const { guildId, session, requesterId } = context;

  const streamWatch = session.streamWatch || {};
  const lastFrameAgoSec = Number(streamWatch.lastFrameAt || 0)
    ? Math.max(0, Math.floor((Date.now() - Number(streamWatch.lastFrameAt || 0)) / 1000))
    : null;
  const lastCommentaryAgoSec = Number(streamWatch.lastCommentaryAt || 0)
    ? Math.max(0, Math.floor((Date.now() - Number(streamWatch.lastCommentaryAt || 0)) / 1000))
    : null;
  const lastBrainContextAgoSec = Number(streamWatch.lastBrainContextAt || 0)
    ? Math.max(0, Math.floor((Date.now() - Number(streamWatch.lastBrainContextAt || 0)) / 1000))
    : null;

  await manager.sendOperationalMessage({
    channel: message.channel,
    settings,
    guildId,
    channelId: message.channelId,
    userId: requesterId,
    messageId: message.id,
    event: "voice_stream_watch_request",
    reason: "status",
    details: {
      active: Boolean(streamWatch.active),
      mode: session.mode,
      targetUserId: streamWatch.targetUserId || null,
      lastFrameAgoSec,
      lastCommentaryAgoSec,
      lastBrainContextAgoSec,
      ingestedFrameCount: Number(streamWatch.ingestedFrameCount || 0)
    }
  });
  return true;
}

export async function ingestStreamFrame(manager, {
  guildId,
  streamerUserId = null,
  mimeType = "image/jpeg",
  dataBase64 = "",
  source = "api_stream_ingest",
  settings = null
}) {
  const normalizedGuildId = String(guildId || "").trim();
  if (!normalizedGuildId) {
    return {
      accepted: false,
      reason: "guild_id_required"
    };
  }

  const session = manager.sessions.get(normalizedGuildId);
  if (!session || session.ending) {
    return {
      accepted: false,
      reason: "session_not_found"
    };
  }

  const resolvedSettings = settings || session.settingsSnapshot || manager.store.getSettings();
  const streamWatchSettings = resolvedSettings?.voice?.streamWatch || {};
  if (!streamWatchSettings.enabled) {
    return {
      accepted: false,
      reason: "stream_watch_disabled"
    };
  }
  if (!supportsStreamWatchCommentary(manager, session, resolvedSettings)) {
    return {
      accepted: false,
      reason: "provider_video_ingest_unavailable"
    };
  }

  const streamWatch = session.streamWatch || {};
  if (!streamWatch.active) {
    return {
      accepted: false,
      reason: "watch_not_active"
    };
  }

  const normalizedStreamerId = String(streamerUserId || "").trim() || null;
  if (streamWatch.targetUserId && !normalizedStreamerId) {
    return {
      accepted: false,
      reason: "streamer_user_id_required",
      targetUserId: streamWatch.targetUserId
    };
  }

  if (streamWatch.targetUserId && streamWatch.targetUserId !== normalizedStreamerId) {
    return {
      accepted: false,
      reason: "target_user_mismatch",
      targetUserId: streamWatch.targetUserId
    };
  }

  const normalizedMimeType = String(mimeType || "").trim().toLowerCase();
  const allowedMimeType =
    normalizedMimeType === "image/jpeg" ||
    normalizedMimeType === "image/jpg" ||
    normalizedMimeType === "image/png" ||
    normalizedMimeType === "image/webp";
  if (!allowedMimeType) {
    return {
      accepted: false,
      reason: "invalid_mime_type"
    };
  }

  const normalizedFrame = String(dataBase64 || "").trim();
  if (!normalizedFrame) {
    return {
      accepted: false,
      reason: "frame_data_required"
    };
  }

  const maxFrameBytes = clamp(
    Number(streamWatchSettings.maxFrameBytes) || 350000,
    50_000,
    4_000_000
  );
  const approxBytes = Math.floor((normalizedFrame.length * 3) / 4);
  if (approxBytes > maxFrameBytes) {
    return {
      accepted: false,
      reason: "frame_too_large",
      maxFrameBytes
    };
  }

  const maxFramesPerMinute = clamp(
    Number(streamWatchSettings.maxFramesPerMinute) || 180,
    6,
    600
  );
  const now = Date.now();
  if (!streamWatch.frameWindowStartedAt || now - Number(streamWatch.frameWindowStartedAt) >= 60_000) {
    streamWatch.frameWindowStartedAt = now;
    streamWatch.acceptedFrameCountInWindow = 0;
  }
  if (Number(streamWatch.acceptedFrameCountInWindow || 0) >= maxFramesPerMinute) {
    return {
      accepted: false,
      reason: "frame_rate_limited",
      maxFramesPerMinute
    };
  }

  const realtimeClient = session.realtimeClient;
  const resolvedMimeType = normalizedMimeType === "image/jpg" ? "image/jpeg" : normalizedMimeType;
  if (realtimeClient && typeof realtimeClient.appendInputVideoFrame === "function") {
    try {
      realtimeClient.appendInputVideoFrame({
        mimeType: resolvedMimeType,
        dataBase64: normalizedFrame
      });
    } catch (error) {
      manager.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: normalizedStreamerId || manager.client.user?.id || null,
        content: `stream_watch_frame_ingest_failed: ${String(error?.message || error)}`,
        metadata: {
          sessionId: session.id,
          source: String(source || "api_stream_ingest")
        }
      });
      return {
        accepted: false,
        reason: "frame_ingest_failed"
      };
    }
  }
  streamWatch.latestFrameMimeType = resolvedMimeType;
  streamWatch.latestFrameDataBase64 = normalizedFrame;
  streamWatch.latestFrameAt = now;

  streamWatch.lastFrameAt = now;
  streamWatch.ingestedFrameCount = Number(streamWatch.ingestedFrameCount || 0) + 1;
  streamWatch.acceptedFrameCountInWindow = Number(streamWatch.acceptedFrameCountInWindow || 0) + 1;
  manager.touchActivity(session.guildId, resolvedSettings);

  manager.store.logAction({
    kind: "voice_runtime",
    guildId: session.guildId,
    channelId: session.textChannelId,
    userId: normalizedStreamerId || manager.client.user?.id || null,
    content: "stream_watch_frame_ingested",
    metadata: {
      sessionId: session.id,
      source: String(source || "api_stream_ingest"),
      mimeType: resolvedMimeType,
      frameBytes: approxBytes,
      totalFrames: streamWatch.ingestedFrameCount
    }
  });

  await maybeTriggerStreamWatchCommentary(manager, {
    session,
    settings: resolvedSettings,
    streamerUserId: normalizedStreamerId,
    source
  });

  return {
    accepted: true,
    reason: "ok",
    targetUserId: streamWatch.targetUserId || null
  };
}

export async function maybeTriggerStreamWatchCommentary(manager, {
  session,
  settings,
  streamerUserId = null,
  source = "api_stream_ingest"
}) {
  if (!session || session.ending) return;
  if (!supportsStreamWatchCommentary(manager, session, settings)) return;
  if (!session.streamWatch?.active) return;

  const resolvedSettings = settings || session.settingsSnapshot || manager.store.getSettings();
  const streamWatchSettings = resolvedSettings?.voice?.streamWatch || {};
  const commentaryPath = resolveStreamWatchCommentaryPath(resolvedSettings);
  const forceAnthropicKeyframes = commentaryPath === STREAM_WATCH_COMMENTARY_PATH_ANTHROPIC_KEYFRAMES;
  let brainContextUpdate = null;

  if (supportsStreamWatchBrainContext(manager, { session, settings: resolvedSettings })) {
    try {
      brainContextUpdate = await maybeRefreshStreamWatchBrainContext(manager, {
        session,
        settings: resolvedSettings,
        streamerUserId,
        source
      });
    } catch (error) {
      manager.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: manager.client.user?.id || null,
        content: `stream_watch_brain_context_failed: ${String(error?.message || error)}`,
        metadata: {
          sessionId: session.id,
          source: String(source || "api_stream_ingest")
        }
      });
    }
  }

  const autonomousCommentaryEnabled =
    streamWatchSettings.autonomousCommentaryEnabled !== undefined
      ? Boolean(streamWatchSettings.autonomousCommentaryEnabled)
      : true;
  if (!autonomousCommentaryEnabled) return;
  if (brainContextUpdate && (brainContextUpdate.sceneChanged === false || brainContextUpdate.shouldComment === false)) {
    return;
  }

  if (session.userCaptures.size > 0) return;
  if (session.pendingResponse) return;
  if (isStreamWatchPlaybackBusy(session)) return;

  const quietWindowMs = STREAM_WATCH_AUDIO_QUIET_WINDOW_MS;
  const sinceLastInboundAudio = Date.now() - Number(session.lastInboundAudioAt || 0);
  if (Number(session.lastInboundAudioAt || 0) > 0 && sinceLastInboundAudio < quietWindowMs) return;

  const minCommentaryIntervalSeconds = clamp(
    Number(streamWatchSettings.minCommentaryIntervalSeconds) || 8,
    3,
    120
  );
  const now = Date.now();
  if (now - Number(session.streamWatch.lastCommentaryAt || 0) < minCommentaryIntervalSeconds * 1000) return;

  const realtimeClient = session.realtimeClient;
  if (!realtimeClient) return;

  if (typeof realtimeClient.isCommentaryResponsePending === "function"
    && realtimeClient.isCommentaryResponsePending()) {
    return;
  }

  const speakerName = manager.resolveVoiceSpeakerName(session, streamerUserId) || "the streamer";
  const nativePrompt = normalizeVoiceText(
    [
      `You're in Discord VC watching ${speakerName}'s live stream.`,
      "Give one short in-character spoken commentary line about the latest frame.",
      "If unclear, say that briefly without pretending certainty."
    ].join(" "),
    STREAM_WATCH_COMMENTARY_PROMPT_MAX_CHARS
  );

  try {
    let fallbackVisionMeta = null;
    const latestContextNote = normalizeVoiceText(
      brainContextUpdate?.note || session.streamWatch?.brainContextEntries?.[session.streamWatch.brainContextEntries.length - 1]?.text || "",
      STREAM_WATCH_BRAIN_CONTEXT_LINE_MAX_CHARS
    );
    if (
      latestContextNote &&
      String(session.streamWatch?.lastCommentaryNote || "").trim().toLowerCase() === latestContextNote.toLowerCase()
    ) {
      return;
    }
    if (!forceAnthropicKeyframes && typeof realtimeClient.requestVideoCommentary === "function") {
      realtimeClient.requestVideoCommentary(nativePrompt);
    } else if (typeof realtimeClient.requestTextUtterance === "function") {
      const bufferedFrame = String(session.streamWatch?.latestFrameDataBase64 || "").trim();
      if (!bufferedFrame) return;
      const generated = await generateVisionFallbackStreamWatchCommentary(manager, {
        session,
        settings: resolvedSettings,
        streamerUserId,
        frameMimeType: session.streamWatch?.latestFrameMimeType || "image/jpeg",
        frameDataBase64: bufferedFrame
      });
      const line = normalizeVoiceText(generated?.text || "", STREAM_WATCH_COMMENTARY_LINE_MAX_CHARS);
      if (!line) return;
      const utterancePrompt = buildRealtimeTextUtterancePrompt(line, STREAM_WATCH_COMMENTARY_LINE_MAX_CHARS);
      realtimeClient.requestTextUtterance(utterancePrompt);
      fallbackVisionMeta = {
        provider: generated?.provider || null,
        model: generated?.model || null
      };
    } else {
      return;
    }

    const created = manager.createTrackedAudioResponse({
      session,
      userId: session.streamWatch.targetUserId || streamerUserId || manager.client.user?.id || null,
      source: "stream_watch_commentary",
      resetRetryState: true,
      emitCreateEvent: false
    });
    if (!created) return;
    session.streamWatch.lastCommentaryAt = now;
    session.streamWatch.lastCommentaryNote = latestContextNote || null;
    manager.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: manager.client.user?.id || null,
      content: "stream_watch_commentary_requested",
      metadata: {
        sessionId: session.id,
        source: String(source || "api_stream_ingest"),
        streamerUserId: streamerUserId || null,
        commentaryPath: fallbackVisionMeta ? "vision_fallback_text_utterance" : "provider_native_video",
        configuredCommentaryPath: commentaryPath,
        visionProvider: fallbackVisionMeta?.provider || null,
        visionModel: fallbackVisionMeta?.model || null
      }
    });
  } catch (error) {
    manager.store.logAction({
      kind: "voice_error",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: manager.client.user?.id || null,
      content: `stream_watch_commentary_request_failed: ${String(error?.message || error)}`,
      metadata: {
        sessionId: session.id,
        source: String(source || "api_stream_ingest")
      }
    });
  }
}
