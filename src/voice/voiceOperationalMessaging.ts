/**
 * Operational message verbosity tiers.
 *
 * "user_response" — direct reply to a user request (join, leave, status, music command).
 *                   Always sent regardless of verbosity (except "none").
 * "lifecycle"     — autonomous session lifecycle (session end, connection drop,
 *                   music started/paused/stopped, stream watch state changes).
 *                   Sent at "all", LLM-skippable at "essential", suppressed at "minimal"/"none".
 * "error"         — runtime errors, crashes, failures.
 *                   Sent at "all"/"essential", LLM-skippable at "minimal", suppressed at "none".
 */
type OperationalMessageTier = "user_response" | "lifecycle" | "error";

const VALID_VERBOSITY_LEVELS = ["all", "essential", "minimal", "none"] as const;
type OperationalMessageVerbosity = (typeof VALID_VERBOSITY_LEVELS)[number];

/** Map (event, reason) to a tier so the verbosity setting can decide what to suppress. */
export function classifyOperationalMessageTier(
  event: string,
  reason: string | null
): OperationalMessageTier {
  const e = String(event || "").trim().toLowerCase();
  const r = String(reason || "").trim().toLowerCase();

  // --- user_response: the user explicitly asked for something ---
  if (e === "voice_join_request") return "user_response";
  if (e === "voice_leave_request") return "user_response";
  if (e === "voice_status_request") return "user_response";
  if (e === "voice_screen_share_offer") return "user_response";

  // Music: commands that come from a user request
  if (e === "voice_music_request") {
    // "started" / "paused" / "stopped" / "already_stopped" are the result of the user's
    // command — still a user_response.  Failures too (user asked, we owe them an answer).
    // "disambiguation_required" / "disambiguation_cancelled" — user interaction.
    return "user_response";
  }

  // Stream-watch: user-issued commands
  if (e === "voice_stream_watch_request") {
    // watching_started, watching_stopped, status, already_stopped — user asked.
    // offline, requester_not_in_same_vc, disabled, unavailable — user asked but denied.
    return "user_response";
  }

  // --- error: runtime failures, crashes ---
  if (e === "voice_session_end") {
    const errorReasons = [
      "realtime_runtime_error",
      "realtime_socket_closed",
      "connection_lost",
      "subprocess_crashed",
      "response_stalled"
    ];
    if (errorReasons.includes(r)) return "error";
    // Everything else is lifecycle (inactivity, max_duration, nl_leave, assistant_leave_directive, etc.)
    return "lifecycle";
  }

  // Catch-all: treat unknown events as lifecycle
  return "lifecycle";
}

/**
 * Given the per-call mustNotify flag, the event tier, and the verbosity setting,
 * resolve whether the message should be force-sent, LLM-skippable, or suppressed entirely.
 *
 * Returns:
 *   "send"     — compose + send (mustNotify=true to LLM, no [SKIP] allowed)
 *   "allow_skip" — compose + send but LLM may return [SKIP]
 *   "suppress" — skip entirely, no LLM call, no channel message (just log)
 */
export function resolveMessageDisposition(
  mustNotify: boolean,
  tier: OperationalMessageTier,
  verbosity: OperationalMessageVerbosity
): "send" | "allow_skip" | "suppress" {
  if (verbosity === "none") return "suppress";

  if (verbosity === "all") {
    // Original behavior: respect the per-call mustNotify flag exactly.
    return mustNotify ? "send" : "allow_skip";
  }

  if (verbosity === "essential") {
    // user_response: always send
    if (tier === "user_response") return mustNotify ? "send" : "allow_skip";
    // error: always send
    if (tier === "error") return "send";
    // lifecycle: LLM decides
    return "allow_skip";
  }

  // verbosity === "minimal"
  // user_response: always send
  if (tier === "user_response") return mustNotify ? "send" : "allow_skip";
  // error: LLM decides
  if (tier === "error") return "allow_skip";
  // lifecycle: suppress entirely
  return "suppress";
}

function normalizeVerbosity(raw: unknown): OperationalMessageVerbosity {
  const s = String(raw || "").trim().toLowerCase();
  if ((VALID_VERBOSITY_LEVELS as readonly string[]).includes(s))
    return s as OperationalMessageVerbosity;
  return "all";
}

export async function sendOperationalMessage(manager, {
  channel,
  settings = null,
  guildId = null,
  channelId = null,
  userId = null,
  messageId = null,
  event = "voice_runtime",
  reason = null,
  details = {},
  mustNotify = false
}) {
  const resolvedSettings =
    settings || (typeof manager.store?.getSettings === "function" ? manager.store.getSettings() : null);
  const detailsPayload =
    details && typeof details === "object" && !Array.isArray(details)
      ? details
      : { detail: String(details || "") };

  // --- Verbosity gate ---
  const verbosity = normalizeVerbosity(resolvedSettings?.voice?.operationalMessages);
  const tier = classifyOperationalMessageTier(String(event || ""), reason);
  const disposition = resolveMessageDisposition(mustNotify, tier, verbosity);

  if (disposition === "suppress") {
    manager.store.logAction({
      kind: "voice_info",
      guildId: guildId || null,
      channelId: channelId || channel?.id || null,
      messageId: messageId || null,
      userId: userId || manager.client.user?.id || null,
      content: "voice_message_suppressed_by_verbosity",
      metadata: { event, reason, verbosity, tier }
    });
    return true;
  }

  const effectiveAllowSkip = disposition === "allow_skip";

  const resolvedChannel = await resolveOperationalChannel(manager, channel, channelId, {
    guildId,
    userId,
    messageId,
    event,
    reason
  });
  if (!resolvedChannel) {
    manager.store.logAction({
      kind: "voice_error",
      guildId: guildId || null,
      channelId: channelId || channel?.id || null,
      messageId: messageId || null,
      userId: userId || manager.client.user?.id || null,
      content: "voice_message_channel_unavailable",
      metadata: {
        event,
        reason
      }
    });
    return false;
  }

  let composedText = "";
  if (!manager.composeOperationalMessage || !resolvedSettings) {
    manager.store.logAction({
      kind: "voice_error",
      guildId: guildId || null,
      channelId: channelId || channel?.id || null,
      messageId: messageId || null,
      userId: userId || manager.client.user?.id || null,
      content: "voice_message_compose_unavailable",
      metadata: {
        event,
        reason,
        hasComposeOperationalMessage: Boolean(manager.composeOperationalMessage),
        hasResolvedSettings: Boolean(resolvedSettings)
      }
    });
    return false;
  }

  try {
    composedText = String(
      (await manager.composeOperationalMessage({
        settings: resolvedSettings,
        guildId: guildId || null,
        channelId: channelId || channel?.id || null,
        userId: userId || null,
        messageId: messageId || null,
        event: String(event || "voice_runtime"),
        reason: reason ? String(reason) : null,
        details: detailsPayload,
        allowSkip: effectiveAllowSkip
      })) || ""
    ).trim();
  } catch (error) {
    manager.store.logAction({
      kind: "voice_error",
      guildId: guildId || null,
      channelId: channelId || channel?.id || null,
      messageId: messageId || null,
      userId: userId || manager.client.user?.id || null,
      content: `voice_message_compose_failed: ${String(error?.message || error)}`,
      metadata: {
        event,
        reason
      }
    });
    return false;
  }

  const normalizedComposedText = String(composedText || "").trim();
  const skipRequested = /^\[SKIP\]$/i.test(normalizedComposedText);
  if (skipRequested) return true;

  if (!normalizedComposedText) {
    manager.store.logAction({
      kind: "voice_error",
      guildId: guildId || null,
      channelId: channelId || resolvedChannel?.id || channel?.id || null,
      messageId: messageId || null,
      userId: userId || manager.client.user?.id || null,
      content: "voice_message_model_empty",
      metadata: {
        event,
        reason
      }
    });
    return false;
  }

  return await sendToChannel(manager, resolvedChannel, normalizedComposedText, {
    guildId,
    channelId: channelId || resolvedChannel?.id || null,
    userId,
    messageId,
    event,
    reason
  });
}

export async function resolveOperationalChannel(
  manager,
  channel,
  channelId,
  { guildId = null, userId = null, messageId = null, event = null, reason = null } = {}
) {
  if (channel && typeof channel.send === "function") return channel;

  const resolvedChannelId = String(channelId || channel?.id || "").trim();
  if (!resolvedChannelId) return null;

  try {
    const fetched = await manager.client.channels.fetch(resolvedChannelId);
    if (fetched && typeof fetched.send === "function") return fetched;
    return null;
  } catch (error) {
    manager.store.logAction({
      kind: "voice_error",
      guildId: guildId || null,
      channelId: resolvedChannelId || null,
      messageId: messageId || null,
      userId: userId || manager.client.user?.id || null,
      content: `voice_message_channel_fetch_failed: ${String(error?.message || error)}`,
      metadata: {
        event,
        reason
      }
    });
    return null;
  }
}

export async function sendToChannel(
  manager,
  channel,
  text,
  { guildId = null, channelId = null, userId = null, messageId = null, event = null, reason = null } = {}
) {
  if (!channel || typeof channel.send !== "function") return false;
  const content = String(text || "").trim();
  if (!content) return false;

  try {
    await channel.send(content);
    return true;
  } catch (error) {
    manager.store.logAction({
      kind: "voice_error",
      guildId: guildId || null,
      channelId: channelId || channel?.id || null,
      messageId: messageId || null,
      userId: userId || manager.client.user?.id || null,
      content: `voice_message_send_failed: ${String(error?.message || error)}`,
      metadata: {
        event,
        reason
      }
    });
    return false;
  }
}
