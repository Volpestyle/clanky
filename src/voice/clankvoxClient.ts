/**
 * Main-process (Bun) client for the clankvox Rust voice engine.
 *
 * Spawns clankvox, relays IPC messages, proxies the Discord gateway
 * adapter so clankvox can join voice channels through the main
 * process's gateway connection, and emits events for the session manager.
 */

import { EventEmitter } from "node:events";
import path from "node:path";
import type { StreamWatchVisualizerMode } from "../settings/voiceDashboardMappings.ts";
import type { TtsPlaybackState } from "./assistantOutputState.ts";

type ClankvoxProcess = ReturnType<typeof Bun.spawn<"pipe", "pipe", "inherit">>;
type JsonRecord = Record<string, unknown>;
type VoiceServerUpdatePayload = JsonRecord & {
  endpoint?: string | null;
  token?: string | null;
};
type VoiceStateUpdatePayload = JsonRecord & {
  session_id?: string | null;
  channel_id?: string | null;
  user_id?: string | null;
};
export type ClankvoxTransportRole = "voice" | "stream_watch" | "stream_publish";
export type ClankvoxTransportState = {
  role: ClankvoxTransportRole;
  status: string;
  reason: string | null;
};
export type ClankvoxVideoResolution = {
  width: number | null;
  height: number | null;
  type: string | null;
};
export type ClankvoxVideoStreamDescriptor = {
  ssrc: number;
  rtxSsrc: number | null;
  rid: string | null;
  quality: number | null;
  streamType: string | null;
  active: boolean | null;
  maxBitrate: number | null;
  maxFramerate: number | null;
  maxResolution: ClankvoxVideoResolution | null;
};
export type ClankvoxUserVideoState = {
  userId: string;
  audioSsrc: number | null;
  videoSsrc: number | null;
  codec: string | null;
  streams: ClankvoxVideoStreamDescriptor[];
};
export type ClankvoxUserVideoFrame = {
  userId: string;
  ssrc: number;
  codec: string;
  keyframe: boolean;
  frameBase64: string;
  rtpTimestamp: number;
  streamType: string | null;
  rid: string | null;
};
export type ClankvoxUserVideoEnd = {
  userId: string;
  ssrc: number | null;
};
type ClankvoxGuildLike = {
  shard?: {
    send(payload: JsonRecord): void;
  };
  voiceAdapterCreator?: (callbacks: {
    onVoiceServerUpdate(data: VoiceServerUpdatePayload): void;
    onVoiceStateUpdate(data: VoiceStateUpdatePayload): void;
  }) => {
    destroy?: () => void;
  } | null | undefined;
} | null;
type ClankvoxSpawnOptions = {
  selfDeaf?: boolean;
  selfMute?: boolean;
  timeoutMs?: number;
};
type ClankvoxIpcErrorCode =
  | "invalid_request"
  | "invalid_json"
  | "input_too_large"
  | "voice_connect_failed"
  | "stream_watch_connect_failed"
  | "stream_publish_connect_failed"
  | "voice_runtime_error";
type ClankvoxIpcError = {
  code: ClankvoxIpcErrorCode | null;
  message: string;
};
type ClankvoxCommand =
  | {
      type: "join";
      guildId: string;
      channelId: string;
      selfDeaf: boolean;
      selfMute: boolean;
    }
  | { type: "voice_server"; data: VoiceServerUpdatePayload }
  | { type: "voice_state"; data: VoiceStateUpdatePayload }
  | {
      type: "stream_watch_connect";
      endpoint: string;
      token: string;
      serverId: string;
      sessionId: string;
      userId: string;
      daveChannelId: string;
    }
  | { type: "stream_watch_disconnect"; reason: string | null }
  | {
      type: "stream_publish_connect";
      endpoint: string;
      token: string;
      serverId: string;
      sessionId: string;
      userId: string;
      daveChannelId: string;
    }
  | { type: "stream_publish_disconnect"; reason: string | null }
  | { type: "audio"; pcmBase64: string; sampleRate: number }
  | { type: "stop_playback" }
  | { type: "stop_tts_playback" }
  | {
      type: "subscribe_user";
      userId: string;
      silenceDurationMs: number;
      sampleRate: number;
    }
  | { type: "unsubscribe_user"; userId: string }
  | {
      type: "subscribe_user_video";
      userId: string;
      maxFramesPerSecond: number;
      preferredQuality: number;
      preferredPixelCount: number | null;
      preferredStreamType: string | null;
    }
  | { type: "unsubscribe_user_video"; userId: string }
  | {
      type: "music_play";
      url: string;
      resolvedDirectUrl: boolean;
      visualizerMode?: StreamWatchVisualizerMode | null;
    }
  | { type: "music_stop" }
  | { type: "music_pause" }
  | { type: "music_resume" }
  | { type: "music_set_gain"; target: number; fadeMs: number }
  | { type: "stream_publish_play"; url: string; resolvedDirectUrl: boolean }
  | {
      type: "stream_publish_play_visualizer";
      url: string;
      resolvedDirectUrl: boolean;
      visualizerMode: Exclude<StreamWatchVisualizerMode, "off">;
    }
  | { type: "stream_publish_browser_start"; mimeType: string }
  | {
      type: "stream_publish_browser_frame";
      mimeType: string;
      frameBase64: string;
      capturedAtMs: number;
    }
  | { type: "stream_publish_stop" }
  | { type: "stream_publish_pause" }
  | { type: "stream_publish_resume" }
  | { type: "destroy" };

type PendingTtsIngressChunk = {
  pcm: Buffer;
  sampleRate: number;
  offsetBytes: number;
  remainingOutputSamples: number;
};

const AUDIO_DEBUG = !!process.env.AUDIO_DEBUG;
const TTS_INGRESS_TARGET_SAMPLES = 48_000 * 2; // Keep clankvox's live TTS buffer around 2s.
const TTS_INGRESS_CHUNK_MS = 240;
const TTS_INGRESS_RECHECK_MS = 60;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object";
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function asClankvoxIpcErrorCode(value: unknown): ClankvoxIpcErrorCode | null {
  switch (value) {
    case "invalid_request":
    case "invalid_json":
    case "input_too_large":
    case "voice_connect_failed":
    case "stream_watch_connect_failed":
    case "stream_publish_connect_failed":
    case "voice_runtime_error":
      return value;
    default:
      return null;
  }
}

function asTransportRole(value: unknown): ClankvoxTransportRole | null {
  switch (value) {
    case "voice":
    case "stream_watch":
    case "stream_publish":
      return value;
    default:
      return null;
  }
}

function normalizeSampleRate(sampleRate: number): number {
  return Math.max(8_000, Math.floor(Number(sampleRate) || 24_000));
}

function clampEvenPcmByteLength(byteLength: number): number {
  const normalized = Math.max(0, Math.floor(Number(byteLength) || 0));
  return normalized - (normalized % 2);
}

function estimateOutputSamplesFromPcmBytes(byteLength: number, sampleRate: number): number {
  const normalizedRate = normalizeSampleRate(sampleRate);
  const normalizedBytes = clampEvenPcmByteLength(byteLength);
  if (normalizedBytes <= 0) return 0;
  const inputSamples = normalizedBytes / 2;
  return Math.max(0, Math.round((inputSamples * 48_000) / normalizedRate));
}

function estimatePcmBytesForOutputSamples(outputSamples: number, sampleRate: number): number {
  const normalizedRate = normalizeSampleRate(sampleRate);
  const normalizedOutputSamples = Math.max(0, Math.floor(Number(outputSamples) || 0));
  if (normalizedOutputSamples <= 0) return 0;
  const inputSamples = Math.max(1, Math.floor((normalizedOutputSamples * normalizedRate) / 48_000));
  return clampEvenPcmByteLength(inputSamples * 2);
}

function estimatePcmBytesForDurationMs(durationMs: number, sampleRate: number): number {
  const normalizedRate = normalizeSampleRate(sampleRate);
  const normalizedDurationMs = Math.max(0, Math.floor(Number(durationMs) || 0));
  if (normalizedDurationMs <= 0) return 0;
  const inputSamples = Math.max(1, Math.floor((normalizedRate * normalizedDurationMs) / 1000));
  return clampEvenPcmByteLength(inputSamples * 2);
}

function parseVideoResolution(value: unknown): ClankvoxVideoResolution | null {
  if (!isRecord(value)) return null;
  return {
    width: asNumber(value.width),
    height: asNumber(value.height),
    type: asString(value.type)
  };
}

function parseVideoStreamDescriptor(value: unknown): ClankvoxVideoStreamDescriptor | null {
  if (!isRecord(value)) return null;
  const ssrc = asNumber(value.ssrc);
  if (ssrc === null) return null;
  return {
    ssrc,
    rtxSsrc: asNumber(value.rtxSsrc),
    rid: asString(value.rid),
    quality: asNumber(value.quality),
    streamType: asString(value.streamType),
    active: asBoolean(value.active),
    maxBitrate: asNumber(value.maxBitrate),
    maxFramerate: asNumber(value.maxFramerate),
    maxResolution: parseVideoResolution(value.maxResolution)
  };
}

function parseUserVideoState(msg: JsonRecord): ClankvoxUserVideoState | null {
  const userId = asString(msg.userId);
  if (!userId) return null;
  return {
    userId,
    audioSsrc: asNumber(msg.audioSsrc),
    videoSsrc: asNumber(msg.videoSsrc),
    codec: asString(msg.codec),
    streams: Array.isArray(msg.streams)
      ? msg.streams
        .map((entry) => parseVideoStreamDescriptor(entry))
        .filter((entry): entry is ClankvoxVideoStreamDescriptor => Boolean(entry))
      : []
  };
}

function parseUserVideoFrame(msg: JsonRecord): ClankvoxUserVideoFrame | null {
  const userId = asString(msg.userId);
  const ssrc = asNumber(msg.ssrc);
  const codec = asString(msg.codec);
  const frameBase64 = asString(msg.frameBase64);
  const rtpTimestamp = asNumber(msg.rtpTimestamp);
  const keyframe = asBoolean(msg.keyframe);
  if (!userId || ssrc === null || !codec || !frameBase64 || rtpTimestamp === null || keyframe === null) {
    return null;
  }
  return {
    userId,
    ssrc,
    codec,
    keyframe,
    frameBase64,
    rtpTimestamp,
    streamType: asString(msg.streamType),
    rid: asString(msg.rid)
  };
}

export class ClankvoxClient extends EventEmitter {
  private static liveClients = new Set<ClankvoxClient>();
  private static processExitHandlersInstalled = false;

  private child: ClankvoxProcess | null = null;
  private guildId: string;
  private channelId: string;
  private guild: ClankvoxGuildLike;
  private destroyed = false;
  private destroyPromise: Promise<void> | null = null;
  private adapterCleanup: (() => void) | null = null;
  private stdoutBuffer: Buffer = Buffer.alloc(0);
  private lastPlaybackArmedReason: string | null = null;
  private lastTtsPlaybackState: TtsPlaybackState = "idle";
  private lastTtsTelemetryAt = 0;
  /** Latest TTS buffer depth reported by clankvox (samples @ 48kHz) */
  ttsBufferDepthSamples: number = 0;
  private estimatedBufferedTtsSamples = 0;
  private estimatedBufferedTtsSamplesAt = 0;
  private queuedTtsOutputSamples = 0;
  private queuedTtsIngress: PendingTtsIngressChunk[] = [];
  private ttsDrainTimer: ReturnType<typeof setTimeout> | null = null;
  private stdoutReaderController: AbortController | null = null;
  private _resolveExitWaiter: (() => void) | null = null;
  private _exitWaiterPromise: Promise<void> | null = null;
  private lastVoiceSessionId: string | null = null;
  private lastVoiceStateUserId: string | null = null;

  constructor(guildId: string, channelId: string, guild: ClankvoxGuildLike) {
    super();
    ClankvoxClient.installProcessExitHandlers();
    this.guildId = guildId;
    this.channelId = channelId;
    this.guild = guild;
  }

  static async spawn(
    guildId: string,
    channelId: string,
    guild: ClankvoxGuildLike,
    opts: ClankvoxSpawnOptions = {}
  ): Promise<ClankvoxClient> {
    const client = new ClankvoxClient(guildId, channelId, guild);
    await client._spawn(opts);
    return client;
  }

  private async _spawn(opts: ClankvoxSpawnOptions) {
    const moduleDir = path.dirname(decodeURIComponent(new URL(import.meta.url).pathname));
    const clankvoxDir = path.resolve(
      moduleDir,
      "clankvox"
    );

    // Prefer the pre-built Rust binary; fall back to cargo run for development.
    const releaseBin = path.join(clankvoxDir, "target", "release", "clankvox");
    const usePrebuilt = await Bun.file(releaseBin).exists();

    const spawnEnv = {
      ...process.env,
      // audiopus_sys needs these to build opus from source on arm64 macOS
      // (the homebrew x86 opus won't link). These are no-ops if opus is already
      // linked or the binary is pre-built.
      OPUS_STATIC: "1",
      OPUS_NO_PKG: "1",
    };

    // Set up exit-waiter before spawning so _handleExit can resolve it
    this._exitWaiterPromise = new Promise<void>((resolve) => {
      this._resolveExitWaiter = resolve;
    });

    try {
      if (usePrebuilt) {
        this.child = Bun.spawn([releaseBin], {
          cwd: clankvoxDir,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "inherit",
          env: spawnEnv,
          onExit: (_proc, exitCode, signalCode) => {
            this._handleExit(exitCode, signalCode);
          },
        });
      } else {
        console.warn(
          "[clankvox] Pre-built binary not found, using cargo run --release (slow first start)"
        );
        this.child = Bun.spawn(["cargo", "run", "--release"], {
          cwd: clankvoxDir,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "inherit",
          env: spawnEnv,
          onExit: (_proc, exitCode, signalCode) => {
            this._handleExit(exitCode, signalCode);
          },
        });
      }
    } catch (err) {
      console.error("[clankvox] spawn error:", err);
      this.emit("error", `spawn_error: ${String((err as Error)?.message || err)}`);
      this._resolveExitWaiter?.();
      throw err;
    }

    ClankvoxClient.liveClients.add(this);

    this._startStdoutReader();

    this._setupAdapterProxy();

    const timeoutMs = opts.timeoutMs ?? 15_000;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        void this.destroy();
        reject(new Error(`clankvox ready timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      this.once("ready", () => {
        clearTimeout(timer);
        resolve();
      });

      this.once("crashed", ({ code, signal }) => {
        clearTimeout(timer);
        reject(
          new Error(
            `clankvox crashed before ready code=${code} signal=${signal}`
          )
        );
      });

      this._send({
        type: "join",
        guildId: this.guildId,
        channelId: this.channelId,
        selfDeaf: opts.selfDeaf ?? false,
        selfMute: opts.selfMute ?? false
      });
    });
  }

  private _handleExit(exitCode: number | null, signalCode: number | null) {
    if (!this.destroyed) {
      console.error(
        `[clankvox] exited unexpectedly code=${exitCode} signal=${signalCode}`
      );
      this.emit("crashed", { code: exitCode, signal: signalCode });
    }
    ClankvoxClient.liveClients.delete(this);
    this._cleanupAdapter();
    this._clearQueuedTtsIngress();
    this._setEstimatedBufferedTtsSamples(0, Date.now());
    this.ttsBufferDepthSamples = 0;
    this.lastTtsPlaybackState = "idle";
    this.child = null;
    this._resolveExitWaiter?.();
  }

  private _startStdoutReader() {
    const child = this.child;
    if (!child) return;

    this.stdoutReaderController = new AbortController();
    const signal = this.stdoutReaderController.signal;
    const reader = child.stdout.getReader();

    const read = async () => {
      try {
        while (!signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            const buf = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
            this._processStdoutChunk(buf);
          }
        }
      } catch {
        // reader cancelled or stream closed — expected during destroy
      } finally {
        try { reader.releaseLock(); } catch { /* ignore */ }
      }
    };

    // Fire-and-forget — errors are caught inside
    void read();
  }

  private _processStdoutChunk(data: Buffer) {
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, data]);

    while (this.stdoutBuffer.length >= 5) {
      const format = this.stdoutBuffer.readUInt8(0);
      const length = this.stdoutBuffer.readUInt32LE(1);

      if (this.stdoutBuffer.length >= 5 + length) {
        const payload = this.stdoutBuffer.subarray(5, 5 + length);
        this.stdoutBuffer = this.stdoutBuffer.subarray(5 + length);

        if (format === 0) {
          try {
            const msg: unknown = JSON.parse(payload.toString("utf8"));
            this._handleMessage(msg);
          } catch {
            // ignore non-json payload
          }
        } else if (format === 1) {
          // Binary audio frame: [8-byte user_id][2-byte peak][4-byte active][4-byte total][PCM...]
          if (payload.length >= 18) {
            const audioUserId = payload.readBigUInt64LE(0).toString();
            const signalPeakAbs = payload.readUInt16LE(8);
            const signalActiveSampleCount = payload.readUInt32LE(10);
            const signalSampleCount = payload.readUInt32LE(14);
            const pcmBuffer = payload.subarray(18);

            this.emit(
              "userAudio",
              audioUserId,
              pcmBuffer,
              signalPeakAbs,
              signalActiveSampleCount,
              signalSampleCount
            );
          }
        }
      } else {
        break;
      }
    }
  }

  private adapterCallbackCount = { voiceState: 0, voiceServer: 0, op4Forward: 0 };

  private _setupAdapterProxy() {
    const guild = this.guild;
    if (!guild?.voiceAdapterCreator) return;

    const adapter = guild.voiceAdapterCreator({
      onVoiceServerUpdate: (data) => {
        this.adapterCallbackCount.voiceServer++;
        if (AUDIO_DEBUG) {
          console.log(
            `[clankvox] adapter onVoiceServerUpdate #${this.adapterCallbackCount.voiceServer}`,
            `endpoint=${data?.endpoint ?? "null"} token=${data?.token ? "present" : "missing"}`
          );
        }
        this._send({ type: "voice_server", data });
      },
      onVoiceStateUpdate: (data) => {
        this.adapterCallbackCount.voiceState++;
        this.lastVoiceSessionId = asString(data?.session_id)?.trim() || null;
        this.lastVoiceStateUserId = asString(data?.user_id)?.trim() || null;
        if (AUDIO_DEBUG) {
          console.log(
            `[clankvox] adapter onVoiceStateUpdate #${this.adapterCallbackCount.voiceState}`,
            `session_id=${data?.session_id ?? "null"} channel_id=${data?.channel_id ?? "null"} user_id=${data?.user_id ?? "null"}`
          );
        }
        this._send({ type: "voice_state", data });
      }
    });

    this.adapterCleanup = () => {
      try { adapter?.destroy?.(); } catch { /* ignore */ }
    };
  }

  private _cleanupAdapter() {
    if (this.adapterCleanup) {
      this.adapterCleanup();
      this.adapterCleanup = null;
    }
  }

  private _handleMessage(msg: unknown) {
    if (!isRecord(msg)) return;

    const msgType = asString(msg.type);
    if (!msgType) return;

    switch (msgType) {
      case "ready":
        this.emit("ready");
        break;
      case "adapter_send":
        if (isRecord(msg.payload)) {
          this._forwardToGateway(msg.payload);
        }
        break;
      case "connection_state": {
        const status = asString(msg.status);
        if (status) {
          this.emit("connectionState", status);
        }
        break;
      }
      case "transport_state": {
        const role = asTransportRole(msg.role);
        const status = asString(msg.status);
        if (role && status) {
          this.emit("transportState", {
            role,
            status,
            reason: asString(msg.reason)
          } satisfies ClankvoxTransportState);
        }
        break;
      }
      case "player_state": {
        const status = asString(msg.status);
        if (status) {
          this.emit("playerState", status);
        }
        break;
      }
      case "playback_armed": {
        const reason = asString(msg.reason);
        this.lastPlaybackArmedReason = reason?.trim() || null;
        this.emit("playbackArmed", reason ?? undefined);
        break;
      }
      case "tts_playback_state": {
        const status = asString(msg.status)?.trim().toLowerCase() === "buffered" ? "buffered" : "idle";
        this.lastTtsTelemetryAt = Date.now();
        this.lastTtsPlaybackState = status;
        if (status === "idle" && this.ttsBufferDepthSamples <= 0) {
          this._setEstimatedBufferedTtsSamples(0, Date.now());
        }
        this._scheduleTtsDrain(0);
        this.emit("ttsPlaybackState", status);
        break;
      }
      case "speaking_start": {
        const userId = asString(msg.userId);
        if (userId) {
          this.emit("speakingStart", userId);
        }
        break;
      }
      case "speaking_end": {
        const userId = asString(msg.userId);
        if (userId) {
          this.emit("speakingEnd", userId);
        }
        break;
      }
      // "user_audio" (JSON) is bypassed above in the binary fast path, but kept here for fallback or tests
      case "user_audio": {
        const userId = asString(msg.userId);
        const pcmBase64 = asString(msg.pcmBase64);
        const signalPeakAbs = asNumber(msg.signalPeakAbs);
        const signalActiveSampleCount = asNumber(msg.signalActiveSampleCount);
        const signalSampleCount = asNumber(msg.signalSampleCount);
        if (
          userId &&
          pcmBase64 &&
          signalPeakAbs !== null &&
          signalActiveSampleCount !== null &&
          signalSampleCount !== null
        ) {
          this.emit(
            "userAudio",
            userId,
            pcmBase64,
            signalPeakAbs,
            signalActiveSampleCount,
            signalSampleCount
          );
        }
        break;
      }
      case "user_audio_end": {
        const userId = asString(msg.userId);
        if (userId) {
          this.emit("userAudioEnd", userId);
        }
        break;
      }
      case "user_video_state": {
        const state = parseUserVideoState(msg);
        if (state) {
          this.emit("userVideoState", state);
        }
        break;
      }
      case "user_video_frame": {
        const frame = parseUserVideoFrame(msg);
        if (frame) {
          this.emit("userVideoFrame", frame);
        }
        break;
      }
      case "user_video_end": {
        const userId = asString(msg.userId);
        if (userId) {
          this.emit("userVideoEnd", {
            userId,
            ssrc: asNumber(msg.ssrc)
          } satisfies ClankvoxUserVideoEnd);
        }
        break;
      }
      case "client_disconnect": {
        const userId = asString(msg.userId);
        if (userId) {
          this.emit("clientDisconnect", userId);
        }
        break;
      }
      case "music_idle":
        this.emit("musicIdle");
        break;
      case "music_error": {
        const message = asString(msg.message);
        if (message !== null) {
          this.emit("musicError", message);
        }
        break;
      }
      case "music_gain_reached": {
        const gain = asNumber(msg.gain);
        if (gain !== null) {
          this.emit("musicGainReached", gain);
        }
        break;
      }
      case "buffer_depth": {
        const ttsSamples = asNumber(msg.ttsSamples) ?? 0;
        const musicSamples = asNumber(msg.musicSamples) ?? 0;
        const now = Date.now();
        this.lastTtsTelemetryAt = now;
        this.ttsBufferDepthSamples = Math.max(0, ttsSamples);
        this.lastTtsPlaybackState =
          this.ttsBufferDepthSamples > 0 ? "buffered" : "idle";
        this._setEstimatedBufferedTtsSamples(this.ttsBufferDepthSamples, now);
        this._scheduleTtsDrain(0);
        this.emit("bufferDepth", ttsSamples, musicSamples);
        break;
      }
      case "error": {
        const message = asString(msg.message);
        const code = asClankvoxIpcErrorCode(msg.code);
        if (message !== null) {
          const ipcError: ClankvoxIpcError = { message, code };
          this.emit("ipcError", ipcError);
          this.emit("error", message, code ?? undefined);
        }
        break;
      }
      default:
        if (AUDIO_DEBUG) {
          console.log(
            `[clankvox] unknown message: ${msgType}`
          );
        }
        break;
    }
  }

  getPlaybackArmedReason(): string | null {
    return this.lastPlaybackArmedReason;
  }

  clearTtsPlaybackTelemetry(): void {
    this.lastTtsTelemetryAt = Date.now();
    this.lastTtsPlaybackState = "idle";
    this.ttsBufferDepthSamples = 0;
    this._clearQueuedTtsIngress();
    this._setEstimatedBufferedTtsSamples(0, Date.now());
  }

  getTtsPlaybackState(): TtsPlaybackState {
    return this.getTtsBufferDepthSamples() > 0 ? "buffered" : this.lastTtsPlaybackState;
  }

  getTtsBufferDepthSamples(): number {
    return Math.max(
      0,
      Math.round(
        this._getEstimatedBufferedTtsSamples() +
        this.queuedTtsOutputSamples +
        this.getBatchedTtsOutputSamples()
      )
    );
  }

  getTtsTelemetryUpdatedAt(): number {
    if (this.getTtsBufferDepthSamples() > 0) {
      return Math.max(0, Date.now());
    }
    return Math.max(0, Number(this.lastTtsTelemetryAt || 0));
  }

  /** Returns the latest reported TTS buffer depth in seconds (48kHz sample rate). */
  getTtsBufferDepthSeconds(): number {
    return this.getTtsBufferDepthSamples() / 48_000;
  }

  private _forwardToGateway(payload: JsonRecord) {
    if (!payload || !this.guild) return;
    this.adapterCallbackCount.op4Forward++;
    const payloadData = isRecord(payload.d) ? payload.d : null;
    if (AUDIO_DEBUG) {
      console.log(
        `[clankvox] _forwardToGateway OP4 #${this.adapterCallbackCount.op4Forward}`,
        `guild_id=${payloadData?.guild_id ?? "null"} channel_id=${payloadData?.channel_id ?? "null"}`
      );
    }
    try {
      const shard = this.guild.shard;
      if (shard && typeof shard.send === "function") {
        shard.send(payload);
      }
    } catch (err) {
      console.error(
        "[clankvox] failed to forward OP4 to gateway:",
        err
      );
    }
  }

  private _sendGatewayVoiceStateUpdate(channelId: string | null) {
    this._forwardToGateway({
      op: 4,
      d: {
        guild_id: this.guildId,
        channel_id: channelId,
        self_mute: false,
        self_deaf: false
      }
    });
  }

  private _send(msg: ClankvoxCommand) {
    if (!this.child || this.destroyed || this.child.killed || this.child.exitCode !== null) return;
    try {
      this.child.stdin.write(JSON.stringify(msg) + "\n");
      this.child.stdin.flush();
    } catch {
      // EPIPE expected during shutdown — silently ignore
    }
  }

  // --- Public API ---

  private audioBatchPcm: Buffer[] = [];
  private audioBatchTimer: ReturnType<typeof setTimeout> | null = null;
  private currentSampleRate: number = 24000;

  private getBatchedTtsOutputSamples(): number {
    if (this.audioBatchPcm.length <= 0) return 0;
    return this.audioBatchPcm.reduce((total, chunk) => {
      return total + estimateOutputSamplesFromPcmBytes(chunk.length, this.currentSampleRate);
    }, 0);
  }

  private _getEstimatedBufferedTtsSamples(now = Date.now()): number {
    const normalizedEstimate = Math.max(0, Number(this.estimatedBufferedTtsSamples || 0));
    if (normalizedEstimate <= 0) return 0;
    const elapsedMs = Math.max(0, now - Math.max(0, Number(this.estimatedBufferedTtsSamplesAt || 0)));
    return Math.max(0, Math.round(normalizedEstimate - (elapsedMs * 48)));
  }

  private _setEstimatedBufferedTtsSamples(samples: number, now = Date.now()) {
    this.estimatedBufferedTtsSamples = Math.max(0, Math.round(Number(samples) || 0));
    this.estimatedBufferedTtsSamplesAt = now;
    if (this.estimatedBufferedTtsSamples > 0 || this.queuedTtsOutputSamples > 0 || this.getBatchedTtsOutputSamples() > 0) {
      this.lastTtsTelemetryAt = now;
      this.lastTtsPlaybackState = "buffered";
    } else if (this.ttsBufferDepthSamples <= 0) {
      this.lastTtsPlaybackState = "idle";
    }
  }

  private _clearQueuedTtsIngress() {
    if (this.audioBatchTimer) {
      clearTimeout(this.audioBatchTimer);
      this.audioBatchTimer = null;
    }
    if (this.ttsDrainTimer) {
      clearTimeout(this.ttsDrainTimer);
      this.ttsDrainTimer = null;
    }
    this.audioBatchPcm = [];
    this.queuedTtsIngress = [];
    this.queuedTtsOutputSamples = 0;
  }

  private _scheduleTtsDrain(delayMs = TTS_INGRESS_RECHECK_MS) {
    const normalizedDelayMs = Math.max(0, Math.floor(Number(delayMs) || 0));
    if (this.ttsDrainTimer) {
      if (normalizedDelayMs > 0) return;
      clearTimeout(this.ttsDrainTimer);
      this.ttsDrainTimer = null;
    }
    this.ttsDrainTimer = setTimeout(() => {
      this.ttsDrainTimer = null;
      this._drainQueuedTtsIngress();
    }, normalizedDelayMs);
  }

  private _enqueueTtsIngressChunk(pcm: Buffer, sampleRate: number) {
    const normalizedSampleRate = normalizeSampleRate(sampleRate);
    const normalizedByteLength = clampEvenPcmByteLength(pcm.length);
    if (normalizedByteLength <= 0) return;
    const chunk = normalizedByteLength === pcm.length ? pcm : pcm.subarray(0, normalizedByteLength);
    const outputSamples = estimateOutputSamplesFromPcmBytes(chunk.length, normalizedSampleRate);
    if (outputSamples <= 0) return;
    this.queuedTtsIngress.push({
      pcm: chunk,
      sampleRate: normalizedSampleRate,
      offsetBytes: 0,
      remainingOutputSamples: outputSamples
    });
    this.queuedTtsOutputSamples += outputSamples;
    this.lastTtsTelemetryAt = Date.now();
    this.lastTtsPlaybackState = "buffered";
  }

  private _drainQueuedTtsIngress() {
    if (!this.isAlive) {
      this._clearQueuedTtsIngress();
      return;
    }

    let estimatedBufferedSamples = this._getEstimatedBufferedTtsSamples();
    const targetSamples = TTS_INGRESS_TARGET_SAMPLES;

    while (this.queuedTtsIngress.length > 0 && estimatedBufferedSamples < targetSamples) {
      const head = this.queuedTtsIngress[0];
      const remainingBytes = clampEvenPcmByteLength(head.pcm.length - head.offsetBytes);
      if (remainingBytes <= 0 || head.remainingOutputSamples <= 0) {
        this.queuedTtsIngress.shift();
        continue;
      }

      const headroomSamples = Math.max(0, targetSamples - estimatedBufferedSamples);
      const byteBudgetByDuration = estimatePcmBytesForDurationMs(TTS_INGRESS_CHUNK_MS, head.sampleRate);
      const byteBudgetByHeadroom = estimatePcmBytesForOutputSamples(headroomSamples, head.sampleRate);
      const chunkByteLength = clampEvenPcmByteLength(
        Math.min(
          remainingBytes,
          byteBudgetByDuration > 0 ? byteBudgetByDuration : remainingBytes,
          byteBudgetByHeadroom > 0 ? byteBudgetByHeadroom : remainingBytes
        )
      );
      if (chunkByteLength <= 0) break;

      const chunk = head.pcm.subarray(head.offsetBytes, head.offsetBytes + chunkByteLength);
      const outputSamples = estimateOutputSamplesFromPcmBytes(chunk.length, head.sampleRate);
      if (outputSamples <= 0) break;

      this._send({
        type: "audio",
        pcmBase64: chunk.toString("base64"),
        sampleRate: head.sampleRate
      });

      head.offsetBytes += chunkByteLength;
      head.remainingOutputSamples = Math.max(0, head.remainingOutputSamples - outputSamples);
      this.queuedTtsOutputSamples = Math.max(0, this.queuedTtsOutputSamples - outputSamples);
      if (head.offsetBytes >= head.pcm.length || head.remainingOutputSamples <= 0) {
        this.queuedTtsIngress.shift();
      }

      estimatedBufferedSamples += outputSamples;
      this._setEstimatedBufferedTtsSamples(estimatedBufferedSamples, Date.now());
    }

    if (this.queuedTtsIngress.length > 0) {
      this._scheduleTtsDrain(TTS_INGRESS_RECHECK_MS);
    } else if (this._getEstimatedBufferedTtsSamples() <= 0 && this.ttsBufferDepthSamples <= 0) {
      this.lastTtsPlaybackState = "idle";
    }
  }

  private _flushAudioBatch() {
    this.audioBatchTimer = null;
    if (this.audioBatchPcm.length === 0) return;

    // Buffer.concat can block the event loop if the array is huge
    // But sending multiple IPC messages also blocks. Let's chunk the IPC messages
    // to a maximum size if it gets too large, but 10ms of accumulation shouldn't be huge.
    const batchedPcm = Buffer.concat(this.audioBatchPcm);
    this.audioBatchPcm = [];
    this._enqueueTtsIngressChunk(batchedPcm, this.currentSampleRate);
    this._drainQueuedTtsIngress();
  }

  sendAudio(pcmBase64: string, sampleRate: number = 24000) {
    const normalizedSampleRate = normalizeSampleRate(sampleRate);
    if (this.audioBatchPcm.length > 0 && normalizedSampleRate !== this.currentSampleRate) {
      this._flushAudioBatch();
    }
    this.currentSampleRate = normalizedSampleRate;
    try {
      const buf = Buffer.from(pcmBase64, "base64");
      if (buf.length) this.audioBatchPcm.push(buf);
    } catch {
      return;
    }

    this.lastTtsTelemetryAt = Date.now();
    this.lastTtsPlaybackState = "buffered";

    if (!this.audioBatchTimer) {
      // Very fast flush to keep latency low, but batching sync event loop drops
      this.audioBatchTimer = setTimeout(() => this._flushAudioBatch(), 5);
    }
  }

  stopPlayback() {
    this.clearTtsPlaybackTelemetry();
    this._send({ type: "stop_playback" });
  }

  stopTtsPlayback() {
    this.clearTtsPlaybackTelemetry();
    this._send({ type: "stop_tts_playback" });
  }

  subscribeUser(userId: string, silenceDurationMs: number = 700, sampleRate: number = 24000) {
    this._send({ type: "subscribe_user", userId, silenceDurationMs, sampleRate });
  }

  unsubscribeUser(userId: string) {
    this._send({ type: "unsubscribe_user", userId });
  }

  subscribeUserVideo({
    userId,
    maxFramesPerSecond = 2,
    preferredQuality = 100,
    preferredPixelCount = 1280 * 720,
    preferredStreamType = "screen"
  }: {
    userId: string;
    maxFramesPerSecond?: number;
    preferredQuality?: number;
    preferredPixelCount?: number | null;
    preferredStreamType?: string | null;
  }) {
    this._send({
      type: "subscribe_user_video",
      userId,
      maxFramesPerSecond: Math.max(1, Math.floor(Number(maxFramesPerSecond) || 2)),
      preferredQuality: Math.max(0, Math.min(100, Math.floor(Number(preferredQuality) || 100))),
      preferredPixelCount:
        preferredPixelCount === null || preferredPixelCount === undefined
          ? null
          : Math.max(1, Math.floor(Number(preferredPixelCount) || 0)),
      preferredStreamType: String(preferredStreamType || "").trim() || null
    });
  }

  unsubscribeUserVideo(userId: string) {
    this._send({ type: "unsubscribe_user_video", userId });
  }

  getLastVoiceSessionId() {
    return this.lastVoiceSessionId;
  }

  getLastVoiceStateUserId() {
    return this.lastVoiceStateUserId;
  }

  streamWatchConnect({
    endpoint,
    token,
    serverId,
    sessionId,
    userId,
    daveChannelId
  }: {
    endpoint: string;
    token: string;
    serverId: string;
    sessionId: string;
    userId: string;
    daveChannelId: string;
  }) {
    this._send({
      type: "stream_watch_connect",
      endpoint: String(endpoint || "").trim(),
      token: String(token || "").trim(),
      serverId: String(serverId || "").trim(),
      sessionId: String(sessionId || "").trim(),
      userId: String(userId || "").trim(),
      daveChannelId: String(daveChannelId || "").trim()
    });
  }

  streamWatchDisconnect(reason: string | null = null) {
    const normalizedReason = String(reason || "").trim();
    this._send({
      type: "stream_watch_disconnect",
      reason: normalizedReason || null
    });
  }

  streamPublishConnect({
    endpoint,
    token,
    serverId,
    sessionId,
    userId,
    daveChannelId
  }: {
    endpoint: string;
    token: string;
    serverId: string;
    sessionId: string;
    userId: string;
    daveChannelId: string;
  }) {
    this._send({
      type: "stream_publish_connect",
      endpoint: String(endpoint || "").trim(),
      token: String(token || "").trim(),
      serverId: String(serverId || "").trim(),
      sessionId: String(sessionId || "").trim(),
      userId: String(userId || "").trim(),
      daveChannelId: String(daveChannelId || "").trim()
    });
  }

  streamPublishDisconnect(reason: string | null = null) {
    const normalizedReason = String(reason || "").trim();
    this._send({
      type: "stream_publish_disconnect",
      reason: normalizedReason || null
    });
  }

  musicPlay(
    url: string,
    resolvedDirectUrl = false,
    visualizerMode: StreamWatchVisualizerMode | null = null
  ) {
    this._send({
      type: "music_play",
      url,
      resolvedDirectUrl,
      visualizerMode: visualizerMode || undefined
    });
  }

  musicStop() {
    this._send({ type: "music_stop" });
  }

  musicPause() {
    this._send({ type: "music_pause" });
  }

  musicResume() {
    this._send({ type: "music_resume" });
  }

  musicSetGain(target: number, fadeMs: number) {
    this._send({ type: "music_set_gain", target, fadeMs });
  }

  streamPublishPlay(url: string, resolvedDirectUrl: boolean) {
    this._send({
      type: "stream_publish_play",
      url: String(url || "").trim(),
      resolvedDirectUrl
    });
  }

  streamPublishPlayVisualizer(
    url: string,
    resolvedDirectUrl: boolean,
    visualizerMode: Exclude<StreamWatchVisualizerMode, "off">
  ) {
    this._send({
      type: "stream_publish_play_visualizer",
      url: String(url || "").trim(),
      resolvedDirectUrl,
      visualizerMode
    });
  }

  streamPublishBrowserStart(mimeType = "image/png") {
    this._send({
      type: "stream_publish_browser_start",
      mimeType: String(mimeType || "").trim() || "image/png"
    });
  }

  streamPublishBrowserFrame({
    mimeType = "image/png",
    frameBase64,
    capturedAtMs
  }: {
    mimeType?: string;
    frameBase64: string;
    capturedAtMs?: number;
  }) {
    this._send({
      type: "stream_publish_browser_frame",
      mimeType: String(mimeType || "").trim() || "image/png",
      frameBase64: String(frameBase64 || "").trim(),
      capturedAtMs: Math.max(0, Math.round(Number(capturedAtMs) || 0))
    });
  }

  streamPublishStop() {
    this._send({ type: "stream_publish_stop" });
  }

  streamPublishPause() {
    this._send({ type: "stream_publish_pause" });
  }

  streamPublishResume() {
    this._send({ type: "stream_publish_resume" });
  }

  async destroy(): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise;
    this.destroyed = true;

    this._clearQueuedTtsIngress();
    this.stdoutBuffer = Buffer.alloc(0);
    this._cleanupAdapter();

    // Abort the stdout reader loop
    this.stdoutReaderController?.abort();

    const child = this.child;
    if (!child) {
      ClankvoxClient.liveClients.delete(this);
      return;
    }

    // Explicitly leave the voice channel through the main gateway before
    // clankvox exits. Killing clankvox alone does not send OP4 with
    // channel_id=null, so Discord can keep the bot shown in VC until the
    // session times out.
    this._sendGatewayVoiceStateUpdate(null);

    this.destroyPromise = new Promise<void>((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(termTimer);
        clearTimeout(killTimer);
        ClankvoxClient.liveClients.delete(this);
        resolve();
      };

      // Wait for the onExit callback to fire (via _handleExit -> _resolveExitWaiter)
      this._exitWaiterPromise?.then(finish);

      this._send({ type: "destroy" });
      try {
        child.stdin.end();
      } catch {
        // ignore
      }

      const termTimer = setTimeout(() => {
        this.killChild("SIGTERM");
      }, 250);

      const killTimer = setTimeout(() => {
        this.killChild("SIGKILL");
      }, 5_000);
    });

    return this.destroyPromise;
  }

  get isAlive(): boolean {
    if (this.destroyed || this.child === null) return false;
    if (this.child.exitCode !== null) return false;
    if (this.child.signalCode !== null) return false;
    return !this.child.killed;
  }

  private killChild(signal: NodeJS.Signals): void {
    const child = this.child;
    if (!child) return;
    if (child.exitCode !== null || child.signalCode !== null || child.killed) return;
    try {
      child.kill(signal);
    } catch {
      // ignore
    }
  }

  private static installProcessExitHandlers(): void {
    if (ClankvoxClient.processExitHandlersInstalled) return;
    ClankvoxClient.processExitHandlersInstalled = true;

    const killLiveChildren = () => {
      for (const client of ClankvoxClient.liveClients) {
        client.killChild("SIGKILL");
      }
      ClankvoxClient.liveClients.clear();
    };

    process.once("exit", killLiveChildren);
  }
}
