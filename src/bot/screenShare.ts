import { normalizeSkipSentinel } from "../botHelpers.ts";
import { sanitizeBotText } from "../utils.ts";
import type { BotContext } from "./botContext.ts";
import {
  resolveOperationalChannel as resolveOperationalChannelForVoiceOperationalMessaging,
  sendToChannel as sendToChannelForVoiceOperationalMessaging
} from "../voice/voiceOperationalMessaging.ts";

const SCREEN_SHARE_MESSAGE_MAX_CHARS = 420;
const SCREEN_SHARE_INTENT_THRESHOLD = 0.66;
const SCREEN_SHARE_EXPLICIT_REQUEST_RE =
  /\b(?:screen\s*share|share\s*(?:my|the)?\s*screen|watch\s*(?:my|the)?\s*screen|see\s*(?:my|the)?\s*screen|look\s*at\s*(?:my|the)?\s*screen|look\s*at\s*(?:my|the)?\s*stream|watch\s*(?:my|the)?\s*stream)\b/i;

export type ScreenShareLinkCapability = {
  enabled?: boolean;
  status?: string;
  publicUrl?: string;
  reason?: string | null;
};

export type ScreenShareSessionResult = {
  ok: boolean;
  reason?: string;
  shareUrl?: string;
  expiresInMinutes?: number;
  reused?: boolean;
};

export type ScreenShareSessionManagerLike = {
  getLinkCapability?: () => ScreenShareLinkCapability;
  createSession?: (payload: {
    guildId: string;
    channelId: string | null;
    requesterUserId: string;
    requesterDisplayName?: string;
    targetUserId?: string | null;
    source?: string;
  }) => Promise<ScreenShareSessionResult>;
};

type ScreenShareMessageLike = {
  guild?: {
    members?: {
      cache?: {
        get: (id: string) => {
          displayName?: string;
          user?: {
            username?: string;
          } | null;
        } | undefined;
      } | null;
    } | null;
  } | null;
  guildId?: string | null;
  channelId?: string | null;
  id?: string | null;
  content?: string | null;
  author?: {
    id?: string | null;
    username?: string | null;
  } | null;
  member?: {
    displayName?: string | null;
    user?: {
      username?: string | null;
    } | null;
  } | null;
};

export interface ScreenShareRuntime extends BotContext {
  readonly screenShareSessionManager: ScreenShareSessionManagerLike | null;
  composeVoiceOperationalMessage: (payload: {
    settings?: Record<string, unknown> | null;
    guildId?: string | null;
    channelId?: string | null;
    userId?: string | null;
    messageId?: string | null;
    event?: string;
    reason?: string | null;
    details?: Record<string, unknown>;
    maxOutputChars?: number;
    allowSkip?: boolean;
  }) => Promise<string>;
  composeScreenShareOfferMessage?: (payload: {
    message: ScreenShareMessageLike;
    settings?: Record<string, unknown> | null;
    linkUrl: string;
    expiresInMinutes?: number;
    explicitRequest?: boolean;
    intentRequested?: boolean;
    confidence?: number;
    source?: string;
  }) => Promise<string>;
  composeScreenShareUnavailableMessage?: (payload: {
    message: ScreenShareMessageLike;
    settings?: Record<string, unknown> | null;
    reason?: string;
    source?: string;
  }) => Promise<string>;
  resolveOperationalChannel?: (
    channel: unknown,
    channelId: string | null,
    meta?: {
      guildId?: string | null;
      userId?: string | null;
      messageId?: string | null;
      event?: string | null;
      reason?: string | null;
    }
  ) => Promise<unknown>;
  sendToChannel?: (
    channel: unknown,
    text: string,
    meta?: {
      guildId?: string | null;
      channelId?: string | null;
      userId?: string | null;
      messageId?: string | null;
      event?: string | null;
      reason?: string | null;
    }
  ) => Promise<boolean>;
}

function safeUrlHost(rawUrl: string) {
  const text = String(rawUrl || "").trim();
  if (!text) return "";
  try {
    return String(new URL(text).host || "").trim().slice(0, 160);
  } catch {
    return "";
  }
}

export function getVoiceScreenShareCapability(
  runtime: ScreenShareRuntime,
  {
    settings: _settings = null,
    guildId: _guildId = null,
    channelId: _channelId = null,
    requesterUserId: _requesterUserId = null
  }: {
    settings?: Record<string, unknown> | null;
    guildId?: string | null;
    channelId?: string | null;
    requesterUserId?: string | null;
  } = {}
) {
  const manager = runtime.screenShareSessionManager;
  if (!manager || typeof manager.getLinkCapability !== "function") {
    return {
      supported: false,
      enabled: false,
      available: false,
      status: "disabled",
      publicUrl: "",
      reason: "screen_share_manager_unavailable"
    };
  }

  const capability = manager.getLinkCapability();
  const status = String(capability?.status || "disabled").trim().toLowerCase() || "disabled";
  const enabled = Boolean(capability?.enabled);
  const available = enabled && status === "ready";
  const rawReason = String(capability?.reason || "").trim().toLowerCase();
  return {
    supported: true,
    enabled,
    available,
    status,
    publicUrl: String(capability?.publicUrl || "").trim(),
    reason: available ? null : rawReason || status || "unavailable"
  };
}

export async function offerVoiceScreenShareLink(
  runtime: ScreenShareRuntime,
  {
    settings = null,
    guildId = null,
    channelId = null,
    requesterUserId = null,
    transcript = "",
    source = "voice_turn_directive"
  }: {
    settings?: Record<string, unknown> | null;
    guildId?: string | null;
    channelId?: string | null;
    requesterUserId?: string | null;
    transcript?: string;
    source?: string;
  } = {}
) {
  const manager = runtime.screenShareSessionManager;
  const normalizedGuildId = String(guildId || "").trim();
  const normalizedChannelId = String(channelId || "").trim();
  const normalizedRequesterUserId = String(requesterUserId || "").trim();
  if (!normalizedGuildId || !normalizedChannelId || !normalizedRequesterUserId) {
    return {
      offered: false,
      reason: "invalid_context"
    };
  }

  const resolvedSettings = settings || runtime.store.getSettings();
  const guild = runtime.client.guilds.cache.get(normalizedGuildId) || null;
  const requesterDisplayName =
    guild?.members?.cache?.get(normalizedRequesterUserId)?.displayName ||
    guild?.members?.cache?.get(normalizedRequesterUserId)?.user?.username ||
    runtime.client.users?.cache?.get(normalizedRequesterUserId)?.username ||
    "unknown";
  const syntheticMessage: ScreenShareMessageLike = {
    guildId: normalizedGuildId,
    channelId: normalizedChannelId,
    id: null,
    author: {
      id: normalizedRequesterUserId,
      username: requesterDisplayName
    },
    member: {
      displayName: requesterDisplayName
    }
  };
  const eventSource = String(source || "voice_turn_directive").trim().slice(0, 80) || "voice_turn_directive";
  const resolveChannel =
    runtime.resolveOperationalChannel ||
    ((channel: unknown, resolvedChannelId: string | null, meta) =>
      resolveOperationalChannel(runtime, channel, resolvedChannelId, meta));
  const sendMessage =
    runtime.sendToChannel ||
    ((channel: unknown, text: string, meta) => sendToChannel(runtime, channel, text, meta));
  const composeUnavailableMessage =
    runtime.composeScreenShareUnavailableMessage ||
    ((payload) => composeScreenShareUnavailableMessage(runtime, payload));
  const composeOfferMessage =
    runtime.composeScreenShareOfferMessage ||
    ((payload) => composeScreenShareOfferMessage(runtime, payload));

  const channel = await resolveChannel(null, normalizedChannelId, {
    guildId: normalizedGuildId,
    userId: normalizedRequesterUserId,
    messageId: null,
    event: "voice_screen_share_offer",
    reason: "voice_directive"
  });
  if (!channel) {
    return {
      offered: false,
      reason: "channel_unavailable"
    };
  }

  if (!manager || typeof manager.createSession !== "function") {
    const unavailableMessage = await composeUnavailableMessage({
      message: syntheticMessage,
      settings: resolvedSettings,
      reason: "screen_share_manager_unavailable",
      source: eventSource
    });
    if (unavailableMessage) {
      await sendMessage(channel, unavailableMessage, {
        guildId: normalizedGuildId,
        channelId: normalizedChannelId,
        userId: normalizedRequesterUserId,
        event: "voice_screen_share_offer",
        reason: "screen_share_manager_unavailable"
      });
    }
    return {
      offered: false,
      reason: "screen_share_manager_unavailable"
    };
  }

  const created = await manager.createSession({
    guildId: normalizedGuildId,
    channelId: normalizedChannelId,
    requesterUserId: normalizedRequesterUserId,
    requesterDisplayName,
    targetUserId: normalizedRequesterUserId,
    source: eventSource
  });
  if (!created?.ok) {
    const unavailableReason = String(created?.reason || "unknown");
    const unavailableMessage = await composeUnavailableMessage({
      message: syntheticMessage,
      settings: resolvedSettings,
      reason: unavailableReason,
      source: eventSource
    });
    if (unavailableMessage) {
      await sendMessage(channel, unavailableMessage, {
        guildId: normalizedGuildId,
        channelId: normalizedChannelId,
        userId: normalizedRequesterUserId,
        event: "voice_screen_share_offer",
        reason: unavailableReason
      });
    }
    return {
      offered: false,
      reason: unavailableReason
    };
  }

  const linkUrl = String(created?.shareUrl || "").trim();
  const expiresInMinutes = Number(created?.expiresInMinutes || 0);
  if (!linkUrl) {
    return {
      offered: false,
      reason: "missing_share_url"
    };
  }
  if (created?.reused) {
    runtime.store.logAction({
      kind: "voice_runtime",
      guildId: normalizedGuildId,
      channelId: normalizedChannelId,
      userId: normalizedRequesterUserId,
      content: "screen_share_offer_suppressed_existing_session",
      metadata: {
        source: eventSource,
        transcript: String(transcript || "").slice(0, 220),
        expiresInMinutes: Number.isFinite(expiresInMinutes) ? expiresInMinutes : null,
        linkHost: safeUrlHost(linkUrl)
      }
    });
    return {
      offered: false,
      reused: true,
      reason: "already_active_session",
      linkUrl,
      expiresInMinutes
    };
  }

  const offerMessage = await composeOfferMessage({
    message: syntheticMessage,
    settings: resolvedSettings,
    linkUrl,
    expiresInMinutes,
    explicitRequest: true,
    intentRequested: true,
    confidence: 1,
    source: eventSource
  });
  if (!offerMessage) {
    return {
      offered: false,
      reason: "offer_message_empty"
    };
  }

  const sent = await sendMessage(channel, offerMessage, {
    guildId: normalizedGuildId,
    channelId: normalizedChannelId,
    userId: normalizedRequesterUserId,
    event: "voice_screen_share_offer",
    reason: "voice_directive"
  });
  if (!sent) {
    return {
      offered: false,
      reason: "offer_message_send_failed"
    };
  }

  runtime.store.logAction({
    kind: "voice_runtime",
    guildId: normalizedGuildId,
    channelId: normalizedChannelId,
    userId: normalizedRequesterUserId,
    content: "screen_share_offer_sent_from_voice",
    metadata: {
      source: eventSource,
      transcript: String(transcript || "").slice(0, 220),
      expiresInMinutes: Number.isFinite(expiresInMinutes) ? expiresInMinutes : null,
      linkHost: safeUrlHost(linkUrl)
    }
  });

  return {
    offered: true,
    reason: "offered",
    linkUrl,
    expiresInMinutes
  };
}

export async function maybeHandleScreenShareOfferIntent(
  runtime: ScreenShareRuntime,
  {
    message,
    settings,
    replyDirective,
    source = "message_event"
  }: {
    message: ScreenShareMessageLike;
    settings?: Record<string, unknown> | null;
    replyDirective?: {
      screenShareIntent?: {
        action?: string;
        confidence?: number;
      } | null;
    } | null;
    source?: string;
  }
) {
  const empty = {
    offered: false,
    appendText: "",
    linkUrl: null,
    explicitRequest: false,
    intentRequested: false,
    confidence: 0,
    reason: null
  };

  const explicitRequest = SCREEN_SHARE_EXPLICIT_REQUEST_RE.test(String(message?.content || ""));
  const manager = runtime.screenShareSessionManager;
  const resolvedSettings = settings || runtime.store.getSettings();
  const composeUnavailableMessage =
    runtime.composeScreenShareUnavailableMessage ||
    ((payload) => composeScreenShareUnavailableMessage(runtime, payload));
  const composeOfferMessage =
    runtime.composeScreenShareOfferMessage ||
    ((payload) => composeScreenShareOfferMessage(runtime, payload));
  if (!message?.guildId || !message?.channelId) return empty;
  if (!manager) {
    if (!explicitRequest) return empty;
    const appendText = await composeUnavailableMessage({
      message,
      settings: resolvedSettings,
      reason: "screen_share_manager_unavailable",
      source
    });
    return {
      ...empty,
      explicitRequest: true,
      appendText
    };
  }

  const intent = replyDirective?.screenShareIntent || {};
  const intentRequested = intent?.action === "offer_link";
  const confidence = Number(intent?.confidence || 0);
  const intentAllowed = intentRequested && confidence >= SCREEN_SHARE_INTENT_THRESHOLD;
  if (!explicitRequest && !intentAllowed) return empty;

  const created = await manager.createSession?.({
    guildId: String(message.guildId || ""),
    channelId: String(message.channelId || ""),
    requesterUserId: String(message.author?.id || ""),
    requesterDisplayName: String(message.member?.displayName || message.author?.username || ""),
    targetUserId: String(message.author?.id || ""),
    source
  });

  if (!created?.ok) {
    runtime.store.logAction({
      kind: "voice_runtime",
      guildId: message.guildId,
      channelId: message.channelId,
      messageId: message.id || null,
      userId: message.author?.id || null,
      content: "screen_share_offer_unavailable",
      metadata: {
        reason: created?.reason || "unknown",
        explicitRequest,
        intentRequested,
        confidence,
        source
      }
    });
    if (!explicitRequest) {
      return {
        ...empty,
        explicitRequest,
        intentRequested,
        confidence,
        reason: created?.reason || "unknown"
      };
    }
    const appendText = await composeUnavailableMessage({
      message,
      settings: resolvedSettings,
      reason: created?.reason || "unknown",
      source
    });
    return {
      ...empty,
      explicitRequest,
      intentRequested,
      confidence,
      reason: created?.reason || "unknown",
      appendText
    };
  }

  const linkUrl = String(created.shareUrl || "").trim();
  const expiresInMinutes = Number(created.expiresInMinutes || 0);
  if (!linkUrl) return empty;
  if (created?.reused) {
    runtime.store.logAction({
      kind: "voice_runtime",
      guildId: message.guildId,
      channelId: message.channelId,
      messageId: message.id || null,
      userId: message.author?.id || null,
      content: "screen_share_offer_suppressed_existing_session",
      metadata: {
        explicitRequest,
        intentRequested,
        confidence,
        expiresInMinutes,
        linkHost: safeUrlHost(linkUrl),
        source
      }
    });
    return {
      ...empty,
      explicitRequest,
      intentRequested,
      confidence,
      linkUrl,
      reason: "already_active_session"
    };
  }

  runtime.store.logAction({
    kind: "voice_runtime",
    guildId: message.guildId,
    channelId: message.channelId,
    messageId: message.id || null,
    userId: message.author?.id || null,
    content: "screen_share_offer_prepared",
    metadata: {
      explicitRequest,
      intentRequested,
      confidence,
      expiresInMinutes,
      linkHost: safeUrlHost(linkUrl),
      source
    }
  });

  const appendText = await composeOfferMessage({
    message,
    settings: resolvedSettings,
    linkUrl,
    expiresInMinutes,
    explicitRequest,
    intentRequested,
    confidence,
    source
  });

  return {
    offered: true,
    appendText,
    linkUrl,
    explicitRequest,
    intentRequested,
    confidence,
    reason: "offered"
  };
}

export async function composeScreenShareOfferMessage(
  runtime: ScreenShareRuntime,
  {
    message,
    settings,
    linkUrl,
    expiresInMinutes,
    explicitRequest = false,
    intentRequested = false,
    confidence = 0,
    source = "message_event"
  }: {
    message: ScreenShareMessageLike;
    settings?: Record<string, unknown> | null;
    linkUrl: string;
    expiresInMinutes?: number;
    explicitRequest?: boolean;
    intentRequested?: boolean;
    confidence?: number;
    source?: string;
  }
) {
  const composed = await runtime.composeVoiceOperationalMessage({
    settings,
    guildId: message.guildId || null,
    channelId: message.channelId || null,
    userId: message.author?.id || null,
    messageId: message.id || null,
    event: "voice_screen_share_offer",
    reason: explicitRequest ? "explicit_request" : "proactive_offer",
    details: {
      linkUrl,
      expiresInMinutes,
      explicitRequest,
      intentRequested,
      confidence: Number(confidence || 0),
      source: String(source || "message_event")
    },
    maxOutputChars: SCREEN_SHARE_MESSAGE_MAX_CHARS
  });

  const normalized = sanitizeBotText(
    normalizeSkipSentinel(String(composed || "")),
    SCREEN_SHARE_MESSAGE_MAX_CHARS
  );
  if (!normalized || normalized === "[SKIP]") {
    runtime.store.logAction({
      kind: "voice_error",
      guildId: message.guildId || null,
      channelId: message.channelId || null,
      messageId: message.id || null,
      userId: message.author?.id || null,
      content: "screen_share_offer_message_empty",
      metadata: {
        explicitRequest,
        intentRequested,
        confidence: Number(confidence || 0),
        source: String(source || "message_event")
      }
    });
    return "";
  }
  if (!String(normalized).includes(linkUrl)) {
    runtime.store.logAction({
      kind: "voice_error",
      guildId: message.guildId || null,
      channelId: message.channelId || null,
      messageId: message.id || null,
      userId: message.author?.id || null,
      content: "screen_share_offer_message_missing_link",
      metadata: {
        explicitRequest,
        intentRequested,
        confidence: Number(confidence || 0),
        source: String(source || "message_event")
      }
    });
    return "";
  }
  return normalized;
}

export async function composeScreenShareUnavailableMessage(
  runtime: ScreenShareRuntime,
  {
    message,
    settings,
    reason = "unavailable",
    source = "message_event"
  }: {
    message: ScreenShareMessageLike;
    settings?: Record<string, unknown> | null;
    reason?: string;
    source?: string;
  }
) {
  const composed = await runtime.composeVoiceOperationalMessage({
    settings,
    guildId: message.guildId || null,
    channelId: message.channelId || null,
    userId: message.author?.id || null,
    messageId: message.id || null,
    event: "voice_screen_share_offer",
    reason: String(reason || "unavailable"),
    details: {
      source: String(source || "message_event"),
      unavailable: true
    },
    maxOutputChars: SCREEN_SHARE_MESSAGE_MAX_CHARS
  });

  const normalized = sanitizeBotText(
    normalizeSkipSentinel(String(composed || "")),
    SCREEN_SHARE_MESSAGE_MAX_CHARS
  );
  if (!normalized || normalized === "[SKIP]") {
    runtime.store.logAction({
      kind: "voice_error",
      guildId: message.guildId || null,
      channelId: message.channelId || null,
      messageId: message.id || null,
      userId: message.author?.id || null,
      content: "screen_share_unavailable_message_empty",
      metadata: {
        reason: String(reason || "unavailable"),
        source: String(source || "message_event")
      }
    });
    return "";
  }
  return normalized;
}

export async function resolveOperationalChannel(
  runtime: ScreenShareRuntime,
  channel: unknown,
  channelId: string | null,
  {
    guildId = null,
    userId = null,
    messageId = null,
    event = null,
    reason = null
  }: {
    guildId?: string | null;
    userId?: string | null;
    messageId?: string | null;
    event?: string | null;
    reason?: string | null;
  } = {}
) {
  return await resolveOperationalChannelForVoiceOperationalMessaging(runtime, channel, channelId, {
    guildId,
    userId,
    messageId,
    event,
    reason
  });
}

export async function sendToChannel(
  runtime: ScreenShareRuntime,
  channel: unknown,
  text: string,
  {
    guildId = null,
    channelId = null,
    userId = null,
    messageId = null,
    event = null,
    reason = null
  }: {
    guildId?: string | null;
    channelId?: string | null;
    userId?: string | null;
    messageId?: string | null;
    event?: string | null;
    reason?: string | null;
  } = {}
) {
  return await sendToChannelForVoiceOperationalMessaging(runtime, channel, text, {
    guildId,
    channelId,
    userId,
    messageId,
    event,
    reason
  });
}
