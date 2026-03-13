import { getDiscordAuthorizationHeaderValue } from "../selfbot/selfbotPatches.ts";

const API_BASE = "https://discord.com/api/v10";

export class SoundboardDirector {
  client;
  store;
  appConfig;

  constructor({ client, store, appConfig }) {
    this.client = client;
    this.store = store;
    this.appConfig = appConfig;
  }

  async play({ session, settings, soundId, sourceGuildId = null, reason = "autonomous", triggerMessage = null }) {
    if (!session || !soundId) {
      return {
        ok: false,
        reason: "invalid_request",
        message: "missing session or sound id"
      };
    }

    const soundboardSettings = settings?.voice?.soundboard || {};
    if (!soundboardSettings.enabled) {
      return {
        ok: false,
        reason: "disabled",
        message: "voice soundboard is disabled"
      };
    }

    const allowExternalSounds = Boolean(soundboardSettings.allowExternalSounds);

    if (sourceGuildId && !allowExternalSounds) {
      return {
        ok: false,
        reason: "external_disabled",
        message: "external sounds are disabled in settings"
      };
    }

    session.soundboard = session.soundboard || {
      playCount: 0,
      lastPlayedAt: 0
    };

    const guild = this.client.guilds.cache.get(session.guildId);
    if (!guild) {
      return {
        ok: false,
        reason: "guild_missing",
        message: "guild not found"
      };
    }

    const voiceChannel = guild.channels.cache.get(session.voiceChannelId);
    if (!voiceChannel || !voiceChannel.isVoiceBased?.()) {
      return {
        ok: false,
        reason: "channel_missing",
        message: "voice channel not available"
      };
    }

    const me = guild.members.me;
    if (!me) {
      return {
        ok: false,
        reason: "bot_member_missing",
        message: "bot member state not available"
      };
    }

    const perms = voiceChannel.permissionsFor(me);
    if (!perms?.has("Speak") || !perms.has("UseSoundboard")) {
      return {
        ok: false,
        reason: "missing_permissions",
        message: "missing SPEAK or USE_SOUNDBOARD permission"
      };
    }

    if (sourceGuildId && !perms.has("UseExternalSounds")) {
      return {
        ok: false,
        reason: "missing_external_permissions",
        message: "missing USE_EXTERNAL_SOUNDS permission"
      };
    }

    const myVoice = me.voice;
    if (!myVoice?.channelId || String(myVoice.channelId) !== String(session.voiceChannelId)) {
      return {
        ok: false,
        reason: "not_in_voice",
        message: "bot is not currently connected to target voice channel"
      };
    }

    if (myVoice.serverMute || myVoice.selfMute || myVoice.serverDeaf || myVoice.selfDeaf) {
      return {
        ok: false,
        reason: "muted_or_deaf",
        message: "bot voice state is muted/deaf"
      };
    }

    if (!this.appConfig?.discordToken) {
      return {
        ok: false,
        reason: "token_missing",
        message: "discord token unavailable"
      };
    }

    const body: {
      sound_id: string;
      source_guild_id?: string;
    } = {
      sound_id: String(soundId)
    };

    if (sourceGuildId) {
      body.source_guild_id = String(sourceGuildId);
    }

    let response = null;
    let errorText = null;

    try {
      response = await fetch(`${API_BASE}/channels/${session.voiceChannelId}/send-soundboard-sound`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: getDiscordAuthorizationHeaderValue(this.appConfig.discordToken)
        },
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        errorText = `${response.status} ${response.statusText}`;
        let responseBody = "";
        try {
          responseBody = await response.text();
        } catch {
          // ignore
        }
        if (responseBody) errorText = `${errorText}: ${responseBody.slice(0, 240)}`;
      }
    } catch (error) {
      errorText = String(error?.message || error);
    }

    if (errorText) {
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        messageId: triggerMessage?.id || null,
        userId: triggerMessage?.author?.id || this.client.user?.id || null,
        content: `soundboard_play_failed: ${errorText}`,
        metadata: {
          reason,
          soundId,
          sourceGuildId,
          sessionId: session.id
        }
      });

      return {
        ok: false,
        reason: "api_error",
        message: errorText
      };
    }

    session.soundboard.playCount += 1;
    session.soundboard.lastPlayedAt = Date.now();

    this.store.logAction({
      kind: "voice_soundboard_play",
      guildId: session.guildId,
      channelId: session.textChannelId,
      messageId: triggerMessage?.id || null,
      userId: triggerMessage?.author?.id || this.client.user?.id || null,
      content: soundId,
      metadata: {
        reason,
        sourceGuildId,
        sessionId: session.id,
        playCount: session.soundboard.playCount
      }
    });

    return {
      ok: true,
      reason: "played",
      message: "played"
    };
  }

}

export function parseSoundboardReference(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  const [soundIdPart, sourceGuildPart] = raw.split("@");
  const soundId = String(soundIdPart || "").trim();
  const sourceGuildId = String(sourceGuildPart || "").trim() || null;
  if (!soundId) return null;

  const reference = sourceGuildId ? `${soundId}@${sourceGuildId}` : soundId;
  return {
    soundId,
    sourceGuildId,
    reference
  };
}
