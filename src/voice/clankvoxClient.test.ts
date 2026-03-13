import { test } from "bun:test";
import assert from "node:assert/strict";
import { ClankvoxClient } from "./clankvoxClient.ts";

class FakeSubprocess {
  exitCode: number | null = null;
  signalCode: number | null = null;
  killed = false;
  commands: Array<Record<string, unknown>> = [];
  stdin = {
    end: () => undefined,
    write: (raw: string) => {
      const normalized = String(raw || "").trim();
      if (normalized) {
        this.commands.push(JSON.parse(normalized) as Record<string, unknown>);
      }
      return true;
    },
    flush: () => undefined,
  };
  stdout = {
    getReader: () => ({
      read: () => new Promise<{ done: true; value: undefined }>((resolve) => {
        // Never resolves until cancelled — simulates an idle stream
        this._cancelStdoutReader = () => resolve({ done: true, value: undefined });
      }),
      releaseLock: () => undefined,
    }),
  };

  private _resolveExitWaiter: (() => void) | null = null;
  private _cancelStdoutReader: (() => void) | null = null;

  _injectExitWaiter(resolve: () => void) {
    this._resolveExitWaiter = resolve;
  }

  kill(signal: NodeJS.Signals): void {
    this.killed = true;
    this.signalCode = signal;
    // Simulate async exit notification
    queueMicrotask(() => {
      this._cancelStdoutReader?.();
      this._resolveExitWaiter?.();
    });
  }
}

type GatewayPayload = {
  op: number;
  d: {
    guild_id: string;
    channel_id: string | null;
    self_mute: boolean;
    self_deaf: boolean;
  };
};

function attachFakeChild(client: ClankvoxClient, child: FakeSubprocess) {
  let resolveExitWaiter!: () => void;
  const exitWaiterPromise = new Promise<void>((resolve) => {
    resolveExitWaiter = resolve;
  });
  child._injectExitWaiter(resolveExitWaiter);

  Reflect.set(client, "child", child);
  Reflect.set(client, "_resolveExitWaiter", resolveExitWaiter);
  Reflect.set(client, "_exitWaiterPromise", exitWaiterPromise);
}

test("ClankvoxClient destroy waits for child exit", async () => {
  const client = new ClankvoxClient("guild-1", "channel-1", null);
  const child = new FakeSubprocess();
  attachFakeChild(client, child);

  const startedAt = Date.now();
  await client.destroy();
  const elapsedMs = Date.now() - startedAt;

  assert.equal(client.isAlive, false);
  assert.equal(child.signalCode, "SIGTERM");
  assert.equal(child.killed, true);
  assert.equal(elapsedMs >= 200, true);
  assert.equal(elapsedMs < 5_000, true);
});

test("ClankvoxClient destroy sends gateway leave before exit", async () => {
  const sentPayloads: GatewayPayload[] = [];
  const guild = {
    shard: {
      send(payload: GatewayPayload) {
        sentPayloads.push(payload);
      }
    }
  };
  const client = new ClankvoxClient("guild-1", "channel-1", guild);
  const child = new FakeSubprocess();
  attachFakeChild(client, child);

  await client.destroy();

  assert.deepEqual(sentPayloads, [
    {
      op: 4,
      d: {
        guild_id: "guild-1",
        channel_id: null,
        self_mute: false,
        self_deaf: false
      }
    }
  ]);
});

test("ClankvoxClient buffer depth telemetry clears buffered playback state at zero depth", () => {
  const client = new ClankvoxClient("guild-1", "channel-1", null);
  const handleMessage = Reflect.get(client, "_handleMessage").bind(client);

  handleMessage({
    type: "buffer_depth",
    ttsSamples: 24_000,
    musicSamples: 0
  });

  const firstUpdatedAt = client.getTtsTelemetryUpdatedAt();
  assert.equal(client.getTtsBufferDepthSamples() > 23_000, true);
  assert.equal(client.getTtsBufferDepthSamples() <= 24_000, true);
  assert.equal(client.getTtsPlaybackState(), "buffered");
  assert.equal(firstUpdatedAt > 0, true);

  handleMessage({
    type: "buffer_depth",
    ttsSamples: 0,
    musicSamples: 0
  });

  assert.equal(client.getTtsBufferDepthSamples(), 0);
  assert.equal(client.getTtsPlaybackState(), "idle");
  assert.equal(client.getTtsTelemetryUpdatedAt() >= firstUpdatedAt, true);
});

test("ClankvoxClient queues TTS locally until clankvox has headroom, then drains in paced chunks", () => {
  const client = new ClankvoxClient("guild-1", "channel-1", null);
  const child = new FakeSubprocess();
  const handleMessage = Reflect.get(client, "_handleMessage").bind(client);
  const flushAudioBatch = Reflect.get(client, "_flushAudioBatch").bind(client);
  const drainQueuedTtsIngress = Reflect.get(client, "_drainQueuedTtsIngress").bind(client);

  attachFakeChild(client, child);

  handleMessage({
    type: "buffer_depth",
    ttsSamples: 120_000,
    musicSamples: 0
  });

  const pcm = Buffer.alloc(48_000, 7);
  client.sendAudio(pcm.toString("base64"), 24_000);
  flushAudioBatch();

  assert.equal(child.commands.some((command) => command.type === "audio"), false);
  assert.equal(client.getTtsBufferDepthSamples() > 120_000, true);

  handleMessage({
    type: "buffer_depth",
    ttsSamples: 0,
    musicSamples: 0
  });
  drainQueuedTtsIngress();

  const audioCommands = child.commands.filter((command) => command.type === "audio");
  assert.equal(audioCommands.length > 1, true);
  const audioBytesSent = audioCommands.reduce((total, command) => {
    return total + Buffer.from(String(command.pcmBase64 || ""), "base64").length;
  }, 0);
  assert.equal(audioBytesSent, pcm.length);
  assert.equal(Reflect.get(client, "queuedTtsOutputSamples"), 0);
});

test("ClankvoxClient stopTtsPlayback clears queued local TTS backlog", () => {
  const client = new ClankvoxClient("guild-1", "channel-1", null);
  const child = new FakeSubprocess();
  const handleMessage = Reflect.get(client, "_handleMessage").bind(client);
  const flushAudioBatch = Reflect.get(client, "_flushAudioBatch").bind(client);

  attachFakeChild(client, child);

  handleMessage({
    type: "buffer_depth",
    ttsSamples: 120_000,
    musicSamples: 0
  });

  const pcm = Buffer.alloc(144_000, 5);
  client.sendAudio(pcm.toString("base64"), 24_000);
  flushAudioBatch();

  assert.equal(child.commands.some((command) => command.type === "audio"), false);
  assert.equal(client.getTtsBufferDepthSamples() > 120_000, true);

  client.stopTtsPlayback();

  assert.equal(client.getTtsBufferDepthSamples(), 0);
  assert.equal(client.getTtsPlaybackState(), "idle");
  assert.deepEqual(child.commands.at(-1), { type: "stop_tts_playback" });
});

test("ClankvoxClient emits structured IPC errors while preserving error message listeners", () => {
  const client = new ClankvoxClient("guild-1", "channel-1", null);
  const handleMessage = Reflect.get(client, "_handleMessage").bind(client);
  const errorEvents: Array<{ message: string; code: string | undefined }> = [];
  const ipcErrors: Array<{ message: string; code: string | null }> = [];

  client.on("error", (message: string, code?: string) => {
    errorEvents.push({ message, code });
  });
  client.on("ipcError", (error: { message: string; code: string | null }) => {
    ipcErrors.push(error);
  });

  handleMessage({
    type: "error",
    code: "voice_connect_failed",
    message: "Voice connect failed: websocket closed"
  });

  assert.deepEqual(errorEvents, [
    {
      message: "Voice connect failed: websocket closed",
      code: "voice_connect_failed"
    }
  ]);
  assert.deepEqual(ipcErrors, [
    {
      message: "Voice connect failed: websocket closed",
      code: "voice_connect_failed"
    }
  ]);
});

test("ClankvoxClient subscribeUserVideo forwards the native video subscription command", () => {
  const client = new ClankvoxClient("guild-1", "channel-1", null);
  const child = new FakeSubprocess();
  attachFakeChild(client, child);

  client.subscribeUserVideo({
    userId: "user-1",
    maxFramesPerSecond: 3,
    preferredQuality: 80,
    preferredPixelCount: 1_920 * 1_080,
    preferredStreamType: "screen"
  });
  client.unsubscribeUserVideo("user-1");

  assert.deepEqual(child.commands, [
    {
      type: "subscribe_user_video",
      userId: "user-1",
      maxFramesPerSecond: 3,
      preferredQuality: 80,
      preferredPixelCount: 2_073_600,
      preferredStreamType: "screen"
    },
    {
      type: "unsubscribe_user_video",
      userId: "user-1"
    }
  ]);
});

test("ClankvoxClient forwards stream watch connect and disconnect commands", () => {
  const client = new ClankvoxClient("guild-1", "channel-1", null);
  const child = new FakeSubprocess();
  attachFakeChild(client, child);

  client.streamWatchConnect({
    endpoint: "wss://stream.discord.media/",
    token: "stream-token",
    serverId: "999001",
    sessionId: "session-123",
    userId: "user-1",
    daveChannelId: "999000"
  });
  client.streamWatchDisconnect("test_done");

  assert.deepEqual(child.commands, [
    {
      type: "stream_watch_connect",
      endpoint: "wss://stream.discord.media/",
      token: "stream-token",
      serverId: "999001",
      sessionId: "session-123",
      userId: "user-1",
      daveChannelId: "999000"
    },
    {
      type: "stream_watch_disconnect",
      reason: "test_done"
    }
  ]);
});

test("ClankvoxClient forwards stream publish transport and playback commands", () => {
  const client = new ClankvoxClient("guild-1", "channel-1", null);
  const child = new FakeSubprocess();
  attachFakeChild(client, child);

  client.streamPublishConnect({
    endpoint: "wss://stream.discord.media/",
    token: "publish-token",
    serverId: "999001",
    sessionId: "session-456",
    userId: "user-1",
    daveChannelId: "999000"
  });
  client.streamPublishPlay("https://youtube.com/watch?v=abc123", false);
  client.streamPublishPlayVisualizer("https://youtube.com/watch?v=abc123", false, "cqt");
  client.streamPublishBrowserStart("image/png");
  client.streamPublishBrowserFrame({
    mimeType: "image/png",
    frameBase64: Buffer.from("browser-frame").toString("base64"),
    capturedAtMs: 1234
  });
  client.streamPublishPause();
  client.streamPublishResume();
  client.streamPublishStop();
  client.streamPublishDisconnect("stream_publish_done");

  assert.deepEqual(child.commands, [
    {
      type: "stream_publish_connect",
      endpoint: "wss://stream.discord.media/",
      token: "publish-token",
      serverId: "999001",
      sessionId: "session-456",
      userId: "user-1",
      daveChannelId: "999000"
    },
    {
      type: "stream_publish_play",
      url: "https://youtube.com/watch?v=abc123",
      resolvedDirectUrl: false
    },
    {
      type: "stream_publish_play_visualizer",
      url: "https://youtube.com/watch?v=abc123",
      resolvedDirectUrl: false,
      visualizerMode: "cqt"
    },
    {
      type: "stream_publish_browser_start",
      mimeType: "image/png"
    },
    {
      type: "stream_publish_browser_frame",
      mimeType: "image/png",
      frameBase64: Buffer.from("browser-frame").toString("base64"),
      capturedAtMs: 1234
    },
    {
      type: "stream_publish_pause"
    },
    {
      type: "stream_publish_resume"
    },
    {
      type: "stream_publish_stop"
    },
    {
      type: "stream_publish_disconnect",
      reason: "stream_publish_done"
    }
  ]);
});

test("ClankvoxClient emits parsed transport state events", () => {
  const client = new ClankvoxClient("guild-1", "channel-1", null);
  const handleMessage = Reflect.get(client, "_handleMessage").bind(client);
  const transportStates: unknown[] = [];

  client.on("transportState", (payload) => {
    transportStates.push(payload);
  });

  handleMessage({
    type: "transport_state",
    role: "stream_watch",
    status: "failed",
    reason: "websocket_closed"
  });
  handleMessage({
    type: "transport_state",
    role: "stream_publish",
    status: "ready",
    reason: null
  });

  assert.deepEqual(transportStates, [
    {
      role: "stream_watch",
      status: "failed",
      reason: "websocket_closed"
    },
    {
      role: "stream_publish",
      status: "ready",
      reason: null
    }
  ]);
});

test("ClankvoxClient emits parsed native video state, frame, and end events", () => {
  const client = new ClankvoxClient("guild-1", "channel-1", null);
  const handleMessage = Reflect.get(client, "_handleMessage").bind(client);
  const stateEvents: unknown[] = [];
  const frameEvents: unknown[] = [];
  const endEvents: unknown[] = [];

  client.on("userVideoState", (payload) => {
    stateEvents.push(payload);
  });
  client.on("userVideoFrame", (payload) => {
    frameEvents.push(payload);
  });
  client.on("userVideoEnd", (payload) => {
    endEvents.push(payload);
  });

  handleMessage({
    type: "user_video_state",
    userId: "user-1",
    audioSsrc: 111,
    videoSsrc: 222,
    codec: "h264",
    streams: [
      {
        ssrc: 222,
        rtxSsrc: 333,
        rid: "50",
        quality: 100,
        streamType: "screen",
        active: true,
        maxBitrate: 2_000_000,
        maxFramerate: 30,
        maxResolution: {
          width: 1280,
          height: 720,
          type: "fixed"
        }
      }
    ]
  });
  handleMessage({
    type: "user_video_frame",
    userId: "user-1",
    ssrc: 222,
    codec: "vp8",
    keyframe: true,
    frameBase64: "AAAA",
    rtpTimestamp: 444,
    streamType: "screen",
    rid: "100"
  });
  handleMessage({
    type: "user_video_end",
    userId: "user-1",
    ssrc: 222
  });

  assert.deepEqual(stateEvents, [
    {
      userId: "user-1",
      audioSsrc: 111,
      videoSsrc: 222,
      codec: "h264",
      streams: [
        {
          ssrc: 222,
          rtxSsrc: 333,
          rid: "50",
          quality: 100,
          streamType: "screen",
          active: true,
          maxBitrate: 2_000_000,
          maxFramerate: 30,
          maxResolution: {
            width: 1280,
            height: 720,
            type: "fixed"
          }
        }
      ]
    }
  ]);
  assert.deepEqual(frameEvents, [
    {
      userId: "user-1",
      ssrc: 222,
      codec: "vp8",
      keyframe: true,
      frameBase64: "AAAA",
      rtpTimestamp: 444,
      streamType: "screen",
      rid: "100"
    }
  ]);
  assert.deepEqual(endEvents, [
    {
      userId: "user-1",
      ssrc: 222
    }
  ]);
});
