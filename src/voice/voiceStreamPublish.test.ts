import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  buildStreamKey,
  createStreamDiscoveryState,
  type GoLiveStream
} from "../selfbot/streamDiscovery.ts";
import {
  createStreamPublishState,
  startBrowserStreamPublish,
  startMusicStreamPublish
} from "./voiceStreamPublish.ts";

type StreamPublishManagerArg = Parameters<typeof startMusicStreamPublish>[0];
type StreamPublishSessionArg = StreamPublishManagerArg["sessions"] extends Map<string, infer Session>
  ? Session
  : never;

function createHarness({
  sourceUrl = "https://youtube.com/watch?v=abc123",
  playbackUrl = sourceUrl,
  playbackResolvedDirectUrl = false,
  visualizerMode = "cqt"
}: {
  sourceUrl?: string;
  playbackUrl?: string;
  playbackResolvedDirectUrl?: boolean;
  visualizerMode?: "off" | "cqt" | "spectrum" | "waves" | "vectorscope";
} = {}) {
  const gatewayPayloads: Array<{ shardId: number; payload: unknown }> = [];
  const client = {
    user: { id: "self-user" },
    guilds: { cache: new Map() },
    ws: {
      _ws: {
        send(shardId: number, payload: unknown) {
          gatewayPayloads.push({ shardId, payload });
        }
      },
      shards: {
        first() {
          return { id: 0 };
        }
      }
    }
  };

  const calls: Array<Record<string, string>> = [];
  const session: StreamPublishSessionArg = {
    id: "session-1",
    guildId: "guild-1",
    textChannelId: "text-1",
    voiceChannelId: "voice-1",
    ending: false,
    music: {
      provider: "youtube",
      lastTrackUrl: sourceUrl,
      lastPlaybackUrl: playbackUrl,
      lastPlaybackResolvedDirectUrl: playbackResolvedDirectUrl
    },
    streamPublish: createStreamPublishState(),
    voxClient: {
      streamPublishConnect(payload) {
        calls.push({ type: "connect", serverId: payload.serverId });
      },
      streamPublishDisconnect(reason) {
        calls.push({ type: "disconnect", reason: String(reason || "") });
      },
      streamPublishPlay(url, resolvedDirectUrl) {
        calls.push({ type: "play", url, resolvedDirectUrl: String(Boolean(resolvedDirectUrl)) });
      },
      streamPublishPlayVisualizer(url, resolvedDirectUrl, selectedVisualizerMode) {
        calls.push({
          type: "play_visualizer",
          url,
          resolvedDirectUrl: String(Boolean(resolvedDirectUrl)),
          visualizerMode: selectedVisualizerMode
        });
      },
      streamPublishBrowserStart(mimeType) {
        calls.push({ type: "browser_start", mimeType: String(mimeType || "") });
      },
      streamPublishStop() {
        calls.push({ type: "stop" });
      },
      streamPublishPause() {
        calls.push({ type: "pause" });
      },
      streamPublishResume() {
        calls.push({ type: "resume" });
      },
      getLastVoiceSessionId() {
        return "voice-session-1";
      }
    }
  };

  const streamDiscovery = createStreamDiscoveryState();
  const manager: StreamPublishManagerArg = {
    client: client as never,
    sessions: new Map([[session.guildId!, session]]),
    streamDiscovery,
    store: {
      getSettings() {
        return {
          voice: {
            streamWatch: {
              visualizerMode
            }
          }
        };
      },
      logAction() {
        return undefined;
      }
    }
  };

  return {
    manager,
    session,
    calls,
    gatewayPayloads,
    streamDiscovery
  };
}

function addDiscoveredSelfStream(
  harness: ReturnType<typeof createHarness>,
  overrides: Partial<GoLiveStream> = {}
) {
  const streamKey = buildStreamKey("guild-1", "voice-1", "self-user");
  const stream: GoLiveStream = {
    streamKey,
    userId: "self-user",
    guildId: "guild-1",
    channelId: "voice-1",
    rtcServerId: "999001",
    endpoint: "stream.discord.media",
    token: "publish-token",
    discoveredAt: 1,
    credentialsReceivedAt: 2,
    ...overrides
  };
  harness.streamDiscovery.streams.set(streamKey, stream);
  return stream;
}

test("startMusicStreamPublish creates a self stream on first YouTube start", () => {
  const harness = createHarness();

  const result = startMusicStreamPublish(harness.manager, {
    guildId: "guild-1",
    source: "music_player_state_playing"
  });

  assert.deepEqual(result, {
    ok: true,
    reason: "stream_publish_requested"
  });
  assert.deepEqual(harness.calls, [
    {
      type: "play_visualizer",
      url: "https://youtube.com/watch?v=abc123",
      resolvedDirectUrl: "false",
      visualizerMode: "cqt"
    }
  ]);
  assert.deepEqual(harness.gatewayPayloads, [
    {
      shardId: 0,
      payload: {
        op: 18,
        d: {
          type: "guild",
          guild_id: "guild-1",
          channel_id: "voice-1",
          preferred_region: null
        }
      }
    },
    {
      shardId: 0,
      payload: {
        op: 22,
        d: {
          stream_key: "guild:guild-1:voice-1:self-user",
          paused: false
        }
      }
    }
  ]);
  assert.equal(harness.session.streamPublish?.transportStatus, "stream_requested");
  assert.equal(harness.session.streamPublish?.sourceKind, "music");
  assert.equal(harness.session.streamPublish?.visualizerMode, "cqt");
});

test("startMusicStreamPublish resumes an existing paused self stream without recreating it", () => {
  const harness = createHarness();
  const discoveredStream = addDiscoveredSelfStream(harness);

  harness.session.streamPublish = {
    ...createStreamPublishState(),
    active: true,
    paused: true,
    streamKey: discoveredStream.streamKey,
    guildId: discoveredStream.guildId,
    channelId: discoveredStream.channelId,
    rtcServerId: discoveredStream.rtcServerId,
    endpoint: discoveredStream.endpoint,
    token: discoveredStream.token,
    sourceKind: "music",
    visualizerMode: "cqt",
    sourceKey: "https://youtube.com/watch?v=abc123",
    sourceUrl: "https://youtube.com/watch?v=abc123",
    sourceLabel: "https://youtube.com/watch?v=abc123",
    lastVoiceSessionId: "voice-session-1",
    transportStatus: "paused"
  };

  const result = startMusicStreamPublish(harness.manager, {
    guildId: "guild-1",
    source: "music_player_state_playing"
  });

  assert.deepEqual(result, {
    ok: true,
    reason: "stream_publish_resumed"
  });
  assert.deepEqual(harness.calls, [{ type: "resume" }]);
  assert.deepEqual(harness.gatewayPayloads, [
    {
      shardId: 0,
      payload: {
        op: 22,
        d: {
          stream_key: discoveredStream.streamKey,
          paused: false
        }
      }
    }
  ]);
  assert.equal(harness.session.streamPublish?.transportStatus, "resume_requested");
});

test("startMusicStreamPublish switches sources on an active self stream without recreating it", () => {
  const harness = createHarness({
    sourceUrl: "https://youtube.com/watch?v=next-track"
  });
  const discoveredStream = addDiscoveredSelfStream(harness);

  harness.session.streamPublish = {
    ...createStreamPublishState(),
    active: true,
    paused: false,
    streamKey: discoveredStream.streamKey,
    guildId: discoveredStream.guildId,
    channelId: discoveredStream.channelId,
    rtcServerId: discoveredStream.rtcServerId,
    endpoint: discoveredStream.endpoint,
    token: discoveredStream.token,
    sourceKind: "music",
    visualizerMode: "cqt",
    sourceKey: "https://youtube.com/watch?v=abc123",
    sourceUrl: "https://youtube.com/watch?v=abc123",
    sourceLabel: "https://youtube.com/watch?v=abc123",
    lastVoiceSessionId: "voice-session-1",
    transportStatus: "ready"
  };

  const result = startMusicStreamPublish(harness.manager, {
    guildId: "guild-1",
    source: "music_player_state_playing"
  });

  assert.deepEqual(result, {
    ok: true,
    reason: "stream_publish_requested"
  });
  assert.deepEqual(harness.calls, [
    {
      type: "play_visualizer",
      url: "https://youtube.com/watch?v=next-track",
      resolvedDirectUrl: "false",
      visualizerMode: "cqt"
    }
  ]);
  assert.deepEqual(harness.gatewayPayloads, []);
  assert.equal(harness.session.streamPublish?.transportStatus, "ready");
  assert.equal(
    harness.session.streamPublish?.sourceUrl,
    "https://youtube.com/watch?v=next-track"
  );
});

test("startMusicStreamPublish no-ops when the same source is already actively streaming", () => {
  const harness = createHarness();
  const discoveredStream = addDiscoveredSelfStream(harness);

  harness.session.streamPublish = {
    ...createStreamPublishState(),
    active: true,
    paused: false,
    streamKey: discoveredStream.streamKey,
    guildId: discoveredStream.guildId,
    channelId: discoveredStream.channelId,
    rtcServerId: discoveredStream.rtcServerId,
    endpoint: discoveredStream.endpoint,
    token: discoveredStream.token,
    sourceKind: "music",
    visualizerMode: "cqt",
    sourceKey: "https://youtube.com/watch?v=abc123",
    sourceUrl: "https://youtube.com/watch?v=abc123",
    sourceLabel: "https://youtube.com/watch?v=abc123",
    lastVoiceSessionId: "voice-session-1",
    transportStatus: "ready"
  };

  const result = startMusicStreamPublish(harness.manager, {
    guildId: "guild-1",
    source: "music_player_state_playing"
  });

  assert.deepEqual(result, {
    ok: true,
    reason: "stream_publish_already_active"
  });
  assert.deepEqual(harness.calls, []);
  assert.deepEqual(harness.gatewayPayloads, []);
  assert.equal(harness.session.streamPublish?.transportStatus, "ready");
});

test("startMusicStreamPublish preserves legacy video-track publish when visualizer mode is off", () => {
  const harness = createHarness({
    visualizerMode: "off"
  });

  const result = startMusicStreamPublish(harness.manager, {
    guildId: "guild-1",
    source: "music_player_state_playing"
  });

  assert.deepEqual(result, {
    ok: true,
    reason: "stream_publish_requested"
  });
  assert.deepEqual(harness.calls, [
    {
      type: "play",
      url: "https://youtube.com/watch?v=abc123",
      resolvedDirectUrl: "false"
    }
  ]);
  assert.equal(harness.session.streamPublish?.visualizerMode, "off");
});

test("startBrowserStreamPublish reuses an active self stream and switches the media source to browser frames", () => {
  const harness = createHarness();
  const discoveredStream = addDiscoveredSelfStream(harness);

  harness.session.streamPublish = {
    ...createStreamPublishState(),
    active: true,
    paused: false,
    streamKey: discoveredStream.streamKey,
    guildId: discoveredStream.guildId,
    channelId: discoveredStream.channelId,
    rtcServerId: discoveredStream.rtcServerId,
    endpoint: discoveredStream.endpoint,
    token: discoveredStream.token,
    sourceKind: "music",
    visualizerMode: "cqt",
    sourceKey: "https://youtube.com/watch?v=abc123",
    sourceUrl: "https://youtube.com/watch?v=abc123",
    sourceLabel: "https://youtube.com/watch?v=abc123",
    lastVoiceSessionId: "voice-session-1",
    transportStatus: "ready",
    transportConnectedAt: 1
  };

  const result = startBrowserStreamPublish(harness.manager, {
    guildId: "guild-1",
    browserSessionId: "browser:session:1",
    source: "voice_realtime_tool_share_browser_session"
  });

  assert.deepEqual(result, {
    ok: true,
    reason: "stream_publish_requested"
  });
  assert.deepEqual(harness.calls, [
    { type: "browser_start", mimeType: "image/png" }
  ]);
  assert.equal(harness.gatewayPayloads.length, 0);
  assert.equal(harness.session.streamPublish?.sourceKind, "browser_session");
  assert.equal(harness.session.streamPublish?.sourceKey, "browser:session:1");
});
