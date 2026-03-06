import {
  composeVoiceOperationalMessage as composeVoiceOperationalMessageForVoiceReplies,
  generateVoiceTurnReply as generateVoiceTurnReplyForVoiceReplies
} from "./voiceReplies.ts";
import type { BotContext, VoiceReplyRuntime } from "./botContext.ts";

type ComposeVoiceOperationalMessageParams = Parameters<
  typeof composeVoiceOperationalMessageForVoiceReplies
>[1];
type GenerateVoiceTurnReplyParams = Parameters<
  typeof generateVoiceTurnReplyForVoiceReplies
>[1];

type DashboardVoiceChannelLike = {
  id?: string | null;
};

type DashboardGuildMemberLike = {
  id?: string | null;
  displayName?: string | null;
  user?: {
    username?: string | null;
    bot?: boolean | null;
  } | null;
  voice?: {
    channel?: DashboardVoiceChannelLike | null;
  } | null;
};

type DashboardVoiceStateLike = {
  member?: DashboardGuildMemberLike | null;
  channel?: DashboardVoiceChannelLike | null;
};

type DashboardTextChannelLike = {
  id?: string | null;
  send?: (payload: unknown) => Promise<unknown>;
  isTextBased?: () => boolean;
  permissionsFor?: (member: unknown) => {
    has: (permission: string) => boolean;
  } | null;
};

type DashboardGuildLike = {
  id?: string | null;
  systemChannelId?: string | null;
  members?: {
    me?: unknown;
    cache?: {
      get: (id: string) => DashboardGuildMemberLike | undefined;
    } | null;
  } | null;
  channels?: {
    cache?: {
      get: (id: string) => DashboardTextChannelLike | undefined;
      values: () => IterableIterator<DashboardTextChannelLike>;
    } | null;
  } | null;
  voiceStates?: {
    cache?: {
      get: (id: string) => DashboardVoiceStateLike | undefined;
      values: () => IterableIterator<DashboardVoiceStateLike>;
    } | null;
  } | null;
};

type DashboardClientLike = BotContext["client"] & {
  user?: {
    id?: string;
  } | null;
  guilds: {
    cache: {
      get: (id: string) => DashboardGuildLike | undefined;
      values: () => IterableIterator<DashboardGuildLike>;
    };
  };
};

type DashboardJoinSyntheticMessage = {
  guild: DashboardGuildLike;
  guildId: string;
  channel: DashboardTextChannelLike;
  channelId: string;
  id: null;
  author: {
    id: string;
    username: string;
  };
  member: DashboardGuildMemberLike;
};

type VoiceSessionLike = {
  ending?: boolean;
  voiceChannelId?: string | null;
  textChannelId?: string | null;
};

type VoiceSessionManagerLike = {
  sessions: Map<string, VoiceSessionLike>;
  requestJoin: (payload: {
    message: DashboardJoinSyntheticMessage;
    settings: Record<string, unknown>;
    intentConfidence: number;
  }) => Promise<boolean>;
};

export type VoiceCoordinationRuntime = BotContext & {
  readonly client: DashboardClientLike;
  readonly voiceSessionManager: VoiceSessionManagerLike;
  toVoiceReplyRuntime: () => VoiceReplyRuntime;
};

export async function composeVoiceOperationalMessage(
  runtime: VoiceCoordinationRuntime,
  payload: ComposeVoiceOperationalMessageParams
) {
  return await composeVoiceOperationalMessageForVoiceReplies(runtime.toVoiceReplyRuntime(), payload);
}

export async function generateVoiceTurnReply(
  runtime: VoiceCoordinationRuntime,
  payload: GenerateVoiceTurnReplyParams
) {
  return await generateVoiceTurnReplyForVoiceReplies(runtime.toVoiceReplyRuntime(), payload);
}

export function resolveDashboardVoiceJoinRequester(
  guild: DashboardGuildLike | null | undefined,
  requesterUserId = ""
) {
  if (!guild?.voiceStates?.cache) {
    return {
      member: null,
      voiceChannel: null,
      reason: "no_voice_members_found"
    };
  }

  const normalizedRequesterUserId = String(requesterUserId || "").trim();
  if (normalizedRequesterUserId) {
    const explicitVoiceState = guild.voiceStates.cache.get(normalizedRequesterUserId) || null;
    const explicitMember = explicitVoiceState?.member || guild.members?.cache?.get(normalizedRequesterUserId) || null;
    const explicitVoiceChannel = explicitVoiceState?.channel || explicitMember?.voice?.channel || null;
    if (explicitMember?.user?.bot) {
      return {
        member: null,
        voiceChannel: null,
        reason: "requester_is_bot"
      };
    }
    if (explicitMember && explicitVoiceChannel) {
      return {
        member: explicitMember,
        voiceChannel: explicitVoiceChannel,
        reason: "ok"
      };
    }
    return {
      member: null,
      voiceChannel: null,
      reason: "requester_not_in_voice"
    };
  }

  for (const voiceState of guild.voiceStates.cache.values()) {
    const member = voiceState?.member || null;
    if (!member || member.user?.bot) continue;
    const voiceChannel = voiceState?.channel || member.voice?.channel || null;
    if (!voiceChannel) continue;
    return {
      member,
      voiceChannel,
      reason: "ok"
    };
  }

  return {
    member: null,
    voiceChannel: null,
    reason: "no_voice_members_found"
  };
}

export function resolveDashboardVoiceJoinTextChannel(
  runtime: VoiceCoordinationRuntime,
  {
    guild,
    textChannelId = ""
  }: {
    guild: DashboardGuildLike | null | undefined;
    textChannelId?: string;
  }
) {
  if (!guild?.channels?.cache) return null;

  const normalizedTextChannelId = String(textChannelId || "").trim();
  const existingSession = runtime.voiceSessionManager.sessions.get(String(guild.id || ""));
  const botMember = guild.members?.me || guild.members?.cache?.get(runtime.client.user?.id || "");
  const candidateIds = [
    normalizedTextChannelId,
    String(existingSession?.textChannelId || "").trim(),
    String(guild.systemChannelId || "").trim()
  ];
  const seenIds = new Set<string>();

  const canSendInChannel = (channel: DashboardTextChannelLike | null | undefined) => {
    if (!channel || typeof channel.send !== "function") return false;
    if (typeof channel.isTextBased === "function" && !channel.isTextBased()) return false;
    if (botMember && typeof channel.permissionsFor === "function") {
      const permissions = channel.permissionsFor(botMember);
      if (permissions && typeof permissions.has === "function" && !permissions.has("SendMessages")) {
        return false;
      }
    }
    return true;
  };

  for (const candidateId of candidateIds) {
    if (!candidateId || seenIds.has(candidateId)) continue;
    seenIds.add(candidateId);
    const channel = guild.channels.cache.get(candidateId) || null;
    if (canSendInChannel(channel)) return channel;
  }

  for (const channel of guild.channels.cache.values()) {
    if (canSendInChannel(channel)) return channel;
  }

  return null;
}

export async function requestVoiceJoinFromDashboard(
  runtime: VoiceCoordinationRuntime,
  {
    guildId = null,
    requesterUserId = null,
    textChannelId = null,
    source = "dashboard_voice_tab"
  }: {
    guildId?: string | null;
    requesterUserId?: string | null;
    textChannelId?: string | null;
    source?: string;
  } = {}
) {
  const settings = runtime.store.getSettings();
  const normalizedGuildId = String(guildId || "").trim();
  const normalizedRequesterUserId = String(requesterUserId || "").trim();
  const normalizedTextChannelId = String(textChannelId || "").trim();
  const normalizedSource = String(source || "dashboard_voice_tab").trim() || "dashboard_voice_tab";

  const guilds = [...runtime.client.guilds.cache.values()];
  let targetGuild = null;
  if (normalizedGuildId) {
    targetGuild = runtime.client.guilds.cache.get(normalizedGuildId) || null;
  } else {
    for (const guild of guilds) {
      const resolution = resolveDashboardVoiceJoinRequester(guild, normalizedRequesterUserId);
      if (resolution.member && resolution.voiceChannel) {
        targetGuild = guild;
        break;
      }
    }
    if (!targetGuild && guilds.length > 0) {
      targetGuild = guilds[0];
    }
  }

  if (!targetGuild) {
    return {
      ok: false,
      reason: normalizedGuildId ? "guild_not_found" : "no_guild_available",
      guildId: normalizedGuildId || null,
      voiceChannelId: null,
      textChannelId: null,
      requesterUserId: normalizedRequesterUserId || null
    };
  }

  const requesterResolution = resolveDashboardVoiceJoinRequester(targetGuild, normalizedRequesterUserId);
  const targetMember = requesterResolution.member;
  const targetVoiceChannel = requesterResolution.voiceChannel;
  if (!targetMember || !targetVoiceChannel) {
    return {
      ok: false,
      reason: requesterResolution.reason || "requester_not_in_voice",
      guildId: String(targetGuild.id || "") || null,
      voiceChannelId: null,
      textChannelId: null,
      requesterUserId: normalizedRequesterUserId || null
    };
  }

  const targetTextChannel = resolveDashboardVoiceJoinTextChannel(runtime, {
    guild: targetGuild,
    textChannelId: normalizedTextChannelId
  });
  if (!targetTextChannel) {
    return {
      ok: false,
      reason: "text_channel_unavailable",
      guildId: String(targetGuild.id || "") || null,
      voiceChannelId: String(targetVoiceChannel.id || "") || null,
      textChannelId: normalizedTextChannelId || null,
      requesterUserId: String(targetMember.id || "") || null
    };
  }

  const targetVoiceChannelId = String(targetVoiceChannel.id || "").trim();
  const existingSession = runtime.voiceSessionManager.sessions.get(String(targetGuild.id || ""));
  const alreadyInTargetChannel =
    Boolean(existingSession) &&
    existingSession.ending !== true &&
    String(existingSession.voiceChannelId || "") === targetVoiceChannelId;

  const syntheticMessage: DashboardJoinSyntheticMessage = {
    guild: targetGuild,
    guildId: String(targetGuild.id || ""),
    channel: targetTextChannel,
    channelId: String(targetTextChannel.id || ""),
    id: null,
    author: {
      id: String(targetMember.id || ""),
      username: String(targetMember.user?.username || targetMember.displayName || targetMember.id || "")
    },
    member: targetMember
  };

  const handled = await runtime.voiceSessionManager.requestJoin({
    message: syntheticMessage,
    settings,
    intentConfidence: 1
  });

  const activeSession = runtime.voiceSessionManager.sessions.get(String(targetGuild.id || ""));
  const joinedTargetChannel =
    Boolean(activeSession) &&
    activeSession.ending !== true &&
    String(activeSession.voiceChannelId || "") === targetVoiceChannelId;

  const reason = !handled
    ? "join_not_handled"
    : joinedTargetChannel
      ? alreadyInTargetChannel
        ? "already_in_channel"
        : "joined"
      : "voice_join_unconfirmed";

  runtime.store.logAction({
    kind: "voice_runtime",
    guildId: String(targetGuild.id || "") || null,
    channelId: String(targetTextChannel.id || "") || null,
    userId: String(targetMember.id || "") || null,
    content: "dashboard_voice_join",
    metadata: {
      source: normalizedSource,
      reason,
      requestedGuildId: normalizedGuildId || null,
      requestedRequesterUserId: normalizedRequesterUserId || null,
      requestedTextChannelId: normalizedTextChannelId || null,
      voiceChannelId: targetVoiceChannelId || null,
      handled: Boolean(handled),
      joinedTargetChannel: Boolean(joinedTargetChannel)
    }
  });

  return {
    ok: joinedTargetChannel,
    reason,
    guildId: String(targetGuild.id || "") || null,
    voiceChannelId: targetVoiceChannelId || null,
    textChannelId: String(targetTextChannel.id || "") || null,
    requesterUserId: String(targetMember.id || "") || null
  };
}
