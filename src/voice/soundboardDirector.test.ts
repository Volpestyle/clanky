import { describe, expect, it } from "bun:test";
import { SoundboardDirector } from "./soundboardDirector.ts";

function createDirectorHost() {
  const fetchCalls: Array<{
    input: string | URL | Request;
    init?: RequestInit;
  }> = [];
  const logEntries: Array<Record<string, unknown>> = [];

  const voiceChannel = {
    isVoiceBased() {
      return true;
    },
    permissionsFor() {
      return {
        has() {
          return true;
        }
      };
    }
  };

  const guild = {
    channels: {
      cache: {
        get() {
          return voiceChannel;
        }
      }
    },
    members: {
      me: {
        voice: {
          channelId: "voice-1",
          serverMute: false,
          selfMute: false,
          serverDeaf: false,
          selfDeaf: false
        }
      }
    }
  };

  const client = {
    user: { id: "self-1" },
    guilds: {
      cache: {
        get() {
          return guild;
        }
      }
    }
  };

  const director = new SoundboardDirector({
    client,
    store: {
      logAction(entry: Record<string, unknown>) {
        logEntries.push(entry);
      }
    },
    appConfig: {
      discordToken: "user_token_123"
    }
  });

  return {
    director,
    fetchCalls,
    logEntries
  };
}

describe("SoundboardDirector", () => {
  it("uses a bare Discord user token when calling the soundboard REST endpoint", async () => {
    const originalFetch = globalThis.fetch;
    const { director, fetchCalls, logEntries } = createDirectorHost();

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ input, init });
      return {
        ok: true,
        status: 204,
        statusText: "No Content",
        async text() {
          return "";
        }
      } as Response;
    }) as typeof globalThis.fetch;

    try {
      const session = {
        id: "session-1",
        guildId: "guild-1",
        voiceChannelId: "voice-1",
        textChannelId: "text-1",
        soundboard: {
          playCount: 0,
          lastPlayedAt: 0
        }
      };

      const result = await director.play({
        session,
        settings: {
          voice: {
            soundboard: {
              enabled: true
            }
          }
        },
        soundId: "airhorn"
      });

      expect(result).toEqual({
        ok: true,
        reason: "played",
        message: "played"
      });
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0]?.init?.headers).toEqual({
        "Content-Type": "application/json",
        Authorization: "user_token_123"
      });
      expect(logEntries[0]?.kind).toBe("voice_soundboard_play");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
