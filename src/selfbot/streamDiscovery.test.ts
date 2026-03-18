import { describe, it, expect, beforeEach } from "bun:test";
import {
  createStreamDiscoveryState,
  getActiveStreams,
  getStreamByUserId,
  getStreamByUserAndGuild,
  getWatchedStream,
  streamHasCredentials,
  parseStreamKey,
  buildStreamKey,
  requestStreamCreate,
  requestStreamDelete,
  requestStreamWatch,
  setStreamPaused,
  type StreamDiscoveryState,
  type StreamDiscoveryCallbacks,
  type GoLiveStream,
} from "./streamDiscovery.ts";

// ---------------------------------------------------------------------------
// Simulated dispatch handlers (extracted from module internals for testing)
// We test through the public setupStreamDiscovery flow by simulating the
// raw gateway events via a fake client.
// ---------------------------------------------------------------------------

import { setupStreamDiscovery } from "./streamDiscovery.ts";

function createFakeClient() {
  const listeners = new Map<string, Array<(data: unknown) => void>>();
  const gatewayPayloads: unknown[] = [];
  return {
    on(event: string, cb: (data: unknown, extra?: unknown) => void) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event)!.push(cb as (data: unknown) => void);
    },
    off(event: string, cb: (data: unknown, extra?: unknown) => void) {
      const existing = listeners.get(event) ?? [];
      listeners.set(event, existing.filter((entry) => entry !== cb));
    },
    removeListener(event: string, cb: (data: unknown, extra?: unknown) => void) {
      const existing = listeners.get(event) ?? [];
      listeners.set(event, existing.filter((entry) => entry !== cb));
    },
    emit(event: string, data: unknown) {
      for (const cb of listeners.get(event) ?? []) cb(data);
    },
    ws: {
      _ws: {
        send(_shardId: number, payload: unknown) {
          gatewayPayloads.push(payload);
        },
        options: { identifyProperties: {}, rest: {} },
        gatewayInformation: null,
        fetchGatewayInformation: async () => ({}),
      },
      shards: {
        first() {
          return { id: 0 };
        },
      },
    },
    gatewayPayloads,
  };
}

/** Helper: emit a raw dispatch event to the fake client. */
function emitDispatch(
  client: ReturnType<typeof createFakeClient>,
  type: string,
  data: Record<string, unknown>
) {
  client.emit("raw", { t: type, d: data });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("streamDiscovery", () => {
  let state: StreamDiscoveryState;
  let client: ReturnType<typeof createFakeClient>;
  let logs: Array<{ action: string; detail: Record<string, unknown> }>;
  let discoveredStreams: GoLiveStream[];
  let credentialStreams: GoLiveStream[];
  let deletedStreams: GoLiveStream[];
  let goLiveDetected: Array<{ userId: string; guildId: string; channelId: string }>;
  let goLiveEnded: Array<{ userId: string; guildId: string; channelId: string | null }>;
  let cleanup: (() => void) | null;

  beforeEach(() => {
    state = createStreamDiscoveryState();
    client = createFakeClient();
    logs = [];
    discoveredStreams = [];
    credentialStreams = [];
    deletedStreams = [];
    goLiveDetected = [];
    goLiveEnded = [];
    cleanup = null;

    cleanup = setupStreamDiscovery(client as never, state, {
      onGoLiveDetected: (info) => goLiveDetected.push(info),
      onGoLiveEnded: (info) => goLiveEnded.push(info),
      onStreamDiscovered: (s) => discoveredStreams.push(s),
      onStreamCredentialsReceived: (s) => credentialStreams.push(s),
      onStreamDeleted: (s) => deletedStreams.push(s),
      onLog: (action, detail) => logs.push({ action, detail }),
    });
  });

  describe("createStreamDiscoveryState", () => {
    it("returns empty initial state", () => {
      const fresh = createStreamDiscoveryState();
      expect(fresh.streams.size).toBe(0);
      expect(fresh.watchingStreamKey).toBeNull();
      expect(fresh.watchRequestedAt).toBeNull();
    });

    it("cleanup detaches raw listeners and clears stream-watch state", () => {
      emitDispatch(client, "STREAM_CREATE", {
        stream_key: "guild:222:333:111",
        rtc_server_id: "rtc_1"
      });
      expect(state.streams.size).toBe(1);

      cleanup?.();

      expect(state.streams.size).toBe(0);
      expect(state.watchingStreamKey).toBeNull();
      expect(state.watchRequestedAt).toBeNull();

      emitDispatch(client, "STREAM_CREATE", {
        stream_key: "guild:222:333:222",
        rtc_server_id: "rtc_2"
      });
      expect(state.streams.size).toBe(0);
    });
  });

  describe("gateway control helpers", () => {
    it("sends STREAM_CREATE for self publish", () => {
      const ok = requestStreamCreate(client as never, {
        guildId: "222",
        channelId: "333"
      });

      expect(ok).toBe(true);
      expect(client.gatewayPayloads).toEqual([
        {
          op: 18,
          d: {
            type: "guild",
            guild_id: "222",
            channel_id: "333",
            preferred_region: null
          }
        }
      ]);
    });

    it("sends STREAM_DELETE for self publish", () => {
      const ok = requestStreamDelete(client as never, "guild:222:333:111");

      expect(ok).toBe(true);
      expect(client.gatewayPayloads).toEqual([
        {
          op: 19,
          d: {
            stream_key: "guild:222:333:111"
          }
        }
      ]);
    });
  });

  describe("VOICE_STATE_UPDATE with self_stream", () => {
    it("logs when a user starts Go Live", () => {
      emitDispatch(client, "VOICE_STATE_UPDATE", {
        user_id: "111",
        guild_id: "222",
        channel_id: "333",
        self_stream: true,
      });

      expect(logs).toHaveLength(1);
      expect(logs[0].action).toBe("stream_discovery_user_go_live");
      expect(logs[0].detail.userId).toBe("111");
      expect(goLiveDetected).toEqual([
        {
          userId: "111",
          guildId: "222",
          channelId: "333",
        }
      ]);
    });

    it("logs when a user stops Go Live", () => {
      // First create a stream
      emitDispatch(client, "STREAM_CREATE", {
        stream_key: "guild:222:333:111",
        rtc_server_id: "rtc_1",
      });

      emitDispatch(client, "VOICE_STATE_UPDATE", {
        user_id: "111",
        guild_id: "222",
        self_stream: false,
      });

      const endLog = logs.find(
        (l) => l.action === "stream_discovery_user_go_live_ended"
      );
      expect(endLog).toBeDefined();
      expect(endLog!.detail.userId).toBe("111");
      expect(goLiveEnded).toEqual([
        {
          userId: "111",
          guildId: "222",
          channelId: null,
        }
      ]);
    });

    it("ignores updates without self_stream", () => {
      emitDispatch(client, "VOICE_STATE_UPDATE", {
        user_id: "111",
        guild_id: "222",
        channel_id: "333",
      });

      expect(logs).toHaveLength(0);
    });
  });

  describe("STREAM_CREATE", () => {
    it("registers a new stream", () => {
      emitDispatch(client, "STREAM_CREATE", {
        stream_key: "guild:222:333:111",
        rtc_server_id: "rtc_abc",
        region: "us-east",
      });

      expect(state.streams.size).toBe(1);
      const stream = state.streams.get("guild:222:333:111")!;
      expect(stream.userId).toBe("111");
      expect(stream.guildId).toBe("222");
      expect(stream.channelId).toBe("333");
      expect(stream.rtcServerId).toBe("rtc_abc");
      expect(stream.endpoint).toBeNull();
      expect(stream.token).toBeNull();
      expect(stream.discoveredAt).toBeGreaterThan(0);
    });

    it("fires onStreamDiscovered callback", () => {
      emitDispatch(client, "STREAM_CREATE", {
        stream_key: "guild:222:333:111",
        rtc_server_id: "rtc_abc",
      });

      expect(discoveredStreams).toHaveLength(1);
      expect(discoveredStreams[0].streamKey).toBe("guild:222:333:111");
    });

    it("rejects invalid stream keys", () => {
      emitDispatch(client, "STREAM_CREATE", {
        stream_key: "invalid_key",
      });

      expect(state.streams.size).toBe(0);
      expect(logs.some((l) => l.action === "stream_discovery_invalid_stream_key")).toBe(true);
    });
  });

  describe("STREAM_SERVER_UPDATE", () => {
    it("updates stream with credentials", () => {
      emitDispatch(client, "STREAM_CREATE", {
        stream_key: "guild:222:333:111",
        rtc_server_id: "rtc_abc",
      });

      emitDispatch(client, "STREAM_SERVER_UPDATE", {
        stream_key: "guild:222:333:111",
        endpoint: "us-east-1.discord.media:443",
        token: "stream_token_xyz",
      });

      const stream = state.streams.get("guild:222:333:111")!;
      expect(stream.endpoint).toBe("us-east-1.discord.media:443");
      expect(stream.token).toBe("stream_token_xyz");
      expect(stream.credentialsReceivedAt).toBeGreaterThan(0);
    });

    it("fires onStreamCredentialsReceived callback", () => {
      emitDispatch(client, "STREAM_CREATE", {
        stream_key: "guild:222:333:111",
        rtc_server_id: "rtc_abc",
      });

      emitDispatch(client, "STREAM_SERVER_UPDATE", {
        stream_key: "guild:222:333:111",
        endpoint: "us-east-1.discord.media:443",
        token: "stream_token_xyz",
      });

      expect(credentialStreams).toHaveLength(1);
      expect(credentialStreams[0].endpoint).toBe("us-east-1.discord.media:443");
    });

    it("logs warning when no matching stream exists", () => {
      emitDispatch(client, "STREAM_SERVER_UPDATE", {
        stream_key: "guild:222:333:999",
        endpoint: "some-endpoint",
        token: "some-token",
      });

      expect(
        logs.some((l) => l.action === "stream_discovery_server_update_no_stream")
      ).toBe(true);
    });
  });

  describe("STREAM_DELETE", () => {
    it("removes the stream from state", () => {
      emitDispatch(client, "STREAM_CREATE", {
        stream_key: "guild:222:333:111",
        rtc_server_id: "rtc_abc",
      });

      expect(state.streams.size).toBe(1);

      emitDispatch(client, "STREAM_DELETE", {
        stream_key: "guild:222:333:111",
      });

      expect(state.streams.size).toBe(0);
    });

    it("fires onStreamDeleted callback", () => {
      emitDispatch(client, "STREAM_CREATE", {
        stream_key: "guild:222:333:111",
        rtc_server_id: "rtc_abc",
      });

      emitDispatch(client, "STREAM_DELETE", {
        stream_key: "guild:222:333:111",
        reason: "stream_ended",
      });

      expect(deletedStreams).toHaveLength(1);
      expect(deletedStreams[0].streamKey).toBe("guild:222:333:111");
    });

    it("clears watchingStreamKey when the watched stream is deleted", () => {
      emitDispatch(client, "STREAM_CREATE", {
        stream_key: "guild:222:333:111",
        rtc_server_id: "rtc_abc",
      });

      state.watchingStreamKey = "guild:222:333:111";
      state.watchRequestedAt = Date.now();

      emitDispatch(client, "STREAM_DELETE", {
        stream_key: "guild:222:333:111",
      });

      expect(state.watchingStreamKey).toBeNull();
      expect(state.watchRequestedAt).toBeNull();
    });
  });

  describe("requestStreamWatch", () => {
    it("sends OP20 and updates watch state", () => {
      const sent: unknown[] = [];
      client.ws._ws.send = (_id: number, payload: unknown) => {
        sent.push(payload);
      };

      const ok = requestStreamWatch(
        client as never,
        state,
        "guild:222:333:111"
      );

      expect(ok).toBe(true);
      expect(state.watchingStreamKey).toBe("guild:222:333:111");
      expect(state.watchRequestedAt).toBeGreaterThan(0);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toEqual({
        op: 20,
        d: { stream_key: "guild:222:333:111" },
      });
    });

    it("returns false for empty stream key", () => {
      const ok = requestStreamWatch(client as never, state, "");
      expect(ok).toBe(false);
      expect(state.watchingStreamKey).toBeNull();
    });
  });

  describe("setStreamPaused", () => {
    it("sends OP22 with paused flag", () => {
      const sent: unknown[] = [];
      client.ws._ws.send = (_id: number, payload: unknown) => {
        sent.push(payload);
      };

      setStreamPaused(client as never, "guild:222:333:111", true);

      expect(sent).toHaveLength(1);
      expect(sent[0]).toEqual({
        op: 22,
        d: { stream_key: "guild:222:333:111", paused: true },
      });
    });
  });

  describe("query helpers", () => {
    beforeEach(() => {
      emitDispatch(client, "STREAM_CREATE", {
        stream_key: "guild:222:333:111",
        rtc_server_id: "rtc_1",
      });
      emitDispatch(client, "STREAM_CREATE", {
        stream_key: "guild:222:333:444",
        rtc_server_id: "rtc_2",
      });
    });

    it("getActiveStreams returns all streams", () => {
      const streams = getActiveStreams(state);
      expect(streams).toHaveLength(2);
    });

    it("getStreamByUserId finds the right stream", () => {
      const stream = getStreamByUserId(state, "111");
      expect(stream).not.toBeNull();
      expect(stream!.streamKey).toBe("guild:222:333:111");
    });

    it("getStreamByUserId returns null for unknown user", () => {
      expect(getStreamByUserId(state, "999")).toBeNull();
    });

    it("getStreamByUserAndGuild matches both", () => {
      const stream = getStreamByUserAndGuild(state, "111", "222");
      expect(stream).not.toBeNull();

      const noMatch = getStreamByUserAndGuild(state, "111", "999");
      expect(noMatch).toBeNull();
    });

    it("streamHasCredentials checks all required fields", () => {
      const stream = state.streams.get("guild:222:333:111")!;
      expect(streamHasCredentials(stream)).toBe(false);

      stream.endpoint = "endpoint";
      stream.token = "token";
      expect(streamHasCredentials(stream)).toBe(true);
    });

    it("getWatchedStream returns the watched stream", () => {
      expect(getWatchedStream(state)).toBeNull();

      state.watchingStreamKey = "guild:222:333:111";
      const watched = getWatchedStream(state);
      expect(watched).not.toBeNull();
      expect(watched!.userId).toBe("111");
    });
  });

  describe("parseStreamKey", () => {
    it("parses valid guild stream key", () => {
      const result = parseStreamKey("guild:111:222:333");
      expect(result).toEqual({
        guildId: "111",
        channelId: "222",
        userId: "333",
      });
    });

    it("returns null for invalid keys", () => {
      expect(parseStreamKey("")).toBeNull();
      expect(parseStreamKey("dm:123")).toBeNull();
      expect(parseStreamKey("guild:123")).toBeNull();
      expect(parseStreamKey("guild:123:456")).toBeNull();
    });
  });

  describe("buildStreamKey", () => {
    it("builds a valid stream key", () => {
      expect(buildStreamKey("111", "222", "333")).toBe("guild:111:222:333");
    });
  });

  describe("GUILD_CREATE existing streamer detection", () => {
    it("detects users with self_stream=true in voice_states", () => {
      emitDispatch(client, "GUILD_CREATE", {
        id: "222",
        voice_states: [
          { user_id: "111", channel_id: "333", self_stream: true },
          { user_id: "444", channel_id: "333", self_stream: false },
          { user_id: "555", channel_id: "333" }, // no self_stream
        ],
      });

      // Only user 111 should trigger onGoLiveDetected
      expect(goLiveDetected).toHaveLength(1);
      expect(goLiveDetected[0]).toEqual({
        userId: "111",
        guildId: "222",
        channelId: "333",
      });
    });

    it("detects multiple existing streamers", () => {
      emitDispatch(client, "GUILD_CREATE", {
        id: "222",
        voice_states: [
          { user_id: "111", channel_id: "333", self_stream: true },
          { user_id: "444", channel_id: "555", self_stream: true },
          { user_id: "666", channel_id: "333" },
        ],
      });

      expect(goLiveDetected).toHaveLength(2);
      expect(goLiveDetected[0].userId).toBe("111");
      expect(goLiveDetected[1].userId).toBe("444");
    });

    it("logs scan completion with streamer count", () => {
      emitDispatch(client, "GUILD_CREATE", {
        id: "222",
        voice_states: [
          { user_id: "111", channel_id: "333", self_stream: true },
          { user_id: "444", channel_id: "333" },
        ],
      });

      const scanLog = logs.find(
        (l) => l.action === "stream_discovery_guild_create_scan_complete"
      );
      expect(scanLog).toBeDefined();
      expect(scanLog!.detail.guildId).toBe("222");
      expect(scanLog!.detail.totalVoiceStates).toBe(2);
      expect(scanLog!.detail.existingStreamers).toBe(1);
    });

    it("skips guilds with no voice states", () => {
      emitDispatch(client, "GUILD_CREATE", {
        id: "222",
        voice_states: [],
      });

      expect(goLiveDetected).toHaveLength(0);
      expect(logs).toHaveLength(0);
    });

    it("skips guilds with missing voice_states field", () => {
      emitDispatch(client, "GUILD_CREATE", {
        id: "222",
      });

      expect(goLiveDetected).toHaveLength(0);
    });

    it("skips voice states with missing channel_id", () => {
      emitDispatch(client, "GUILD_CREATE", {
        id: "222",
        voice_states: [
          { user_id: "111", self_stream: true }, // no channel_id
        ],
      });

      expect(goLiveDetected).toHaveLength(0);
    });

    it("does not fire when no users are streaming", () => {
      emitDispatch(client, "GUILD_CREATE", {
        id: "222",
        voice_states: [
          { user_id: "111", channel_id: "333", self_stream: false },
          { user_id: "444", channel_id: "333" },
        ],
      });

      expect(goLiveDetected).toHaveLength(0);
      // No scan completion log when no streamers found
      const scanLog = logs.find(
        (l) => l.action === "stream_discovery_guild_create_scan_complete"
      );
      expect(scanLog).toBeUndefined();
    });
  });

  describe("full lifecycle", () => {
    it("handles complete stream lifecycle: create -> credentials -> watch -> delete", () => {
      const sent: unknown[] = [];
      client.ws._ws.send = (_id: number, payload: unknown) => {
        sent.push(payload);
      };

      // User starts Go Live
      emitDispatch(client, "VOICE_STATE_UPDATE", {
        user_id: "111",
        guild_id: "222",
        channel_id: "333",
        self_stream: true,
      });

      // We send STREAM_WATCH
      requestStreamWatch(client as never, state, "guild:222:333:111");
      expect(sent).toHaveLength(1);

      // Discord responds with STREAM_CREATE
      emitDispatch(client, "STREAM_CREATE", {
        stream_key: "guild:222:333:111",
        rtc_server_id: "rtc_server_abc",
        region: "us-east",
      });

      const stream = state.streams.get("guild:222:333:111")!;
      expect(stream.rtcServerId).toBe("rtc_server_abc");
      expect(streamHasCredentials(stream)).toBe(false);

      // Discord sends STREAM_SERVER_UPDATE with credentials
      emitDispatch(client, "STREAM_SERVER_UPDATE", {
        stream_key: "guild:222:333:111",
        endpoint: "us-east-12345.discord.media:443",
        token: "secret_stream_token",
      });

      expect(streamHasCredentials(stream)).toBe(true);
      expect(stream.endpoint).toBe("us-east-12345.discord.media:443");
      expect(stream.token).toBe("secret_stream_token");

      // Verify callbacks fired in order
      expect(discoveredStreams).toHaveLength(1);
      expect(credentialStreams).toHaveLength(1);

      // User stops Go Live
      emitDispatch(client, "STREAM_DELETE", {
        stream_key: "guild:222:333:111",
        reason: "stream_ended",
      });

      expect(state.streams.size).toBe(0);
      expect(state.watchingStreamKey).toBeNull();
      expect(deletedStreams).toHaveLength(1);
    });
  });
});
