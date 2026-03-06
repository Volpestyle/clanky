/**
 * Main-process (Bun) client for the clankvox Rust voice engine.
 *
 * Spawns clankvox, relays IPC messages, proxies the Discord gateway
 * adapter so clankvox can join voice channels through the main
 * process's gateway connection, and emits events for the session manager.
 */

import { EventEmitter } from "node:events";
import path from "node:path";
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
type ConnectAsrOptions = {
  userId: string;
  apiKey: string;
  model: string;
  language?: string | null;
  prompt?: string | null;
};
export type ClankvoxIpcErrorCode =
  | "invalid_request"
  | "invalid_json"
  | "input_too_large"
  | "voice_connect_failed"
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
  | { type: "music_play"; url: string; resolvedDirectUrl: boolean }
  | { type: "music_stop" }
  | { type: "music_pause" }
  | { type: "music_resume" }
  | { type: "music_set_gain"; target: number; fadeMs: number }
  | {
      type: "connect_asr";
      userId: string;
      apiKey: string;
      model: string;
      language: string | null;
      prompt: string | null;
    }
  | { type: "disconnect_asr"; userId: string }
  | { type: "commit_asr"; userId: string }
  | { type: "clear_asr"; userId: string }
  | { type: "destroy" };

const AUDIO_DEBUG = !!process.env.AUDIO_DEBUG;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object";
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asClankvoxIpcErrorCode(value: unknown): ClankvoxIpcErrorCode | null {
  switch (value) {
    case "invalid_request":
    case "invalid_json":
    case "input_too_large":
    case "voice_connect_failed":
    case "voice_runtime_error":
      return value;
    default:
      return null;
  }
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
  private stdoutReaderController: AbortController | null = null;
  private _resolveExitWaiter: (() => void) | null = null;
  private _exitWaiterPromise: Promise<void> | null = null;

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
      case "asr_transcript": {
        const userId = asString(msg.userId);
        const text = asString(msg.text);
        if (userId && text !== null) {
          this.emit("asrTranscript", userId, text, msg.isFinal === true);
        }
        break;
      }
      case "asr_disconnected": {
        const userId = asString(msg.userId);
        const reason = asString(msg.reason);
        if (userId && reason !== null) {
          this.emit("asrDisconnected", userId, reason);
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
        this.lastTtsTelemetryAt = Date.now();
        this.ttsBufferDepthSamples = Math.max(0, ttsSamples);
        this.lastTtsPlaybackState =
          this.ttsBufferDepthSamples > 0 ? "buffered" : "idle";
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
  }

  getTtsPlaybackState(): TtsPlaybackState {
    return this.lastTtsPlaybackState;
  }

  getTtsBufferDepthSamples(): number {
    return Math.max(0, Number(this.ttsBufferDepthSamples || 0));
  }

  getTtsTelemetryUpdatedAt(): number {
    return Math.max(0, Number(this.lastTtsTelemetryAt || 0));
  }

  /** Returns the latest reported TTS buffer depth in seconds (48kHz sample rate). */
  getTtsBufferDepthSeconds(): number {
    return this.ttsBufferDepthSamples / 48_000;
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

  private _flushAudioBatch() {
    this.audioBatchTimer = null;
    if (this.audioBatchPcm.length === 0) return;

    // Buffer.concat can block the event loop if the array is huge
    // But sending multiple IPC messages also blocks. Let's chunk the IPC messages
    // to a maximum size if it gets too large, but 10ms of accumulation shouldn't be huge.
    const batchedPcm = Buffer.concat(this.audioBatchPcm);
    this.audioBatchPcm = [];

    this._send({
      type: "audio",
      pcmBase64: batchedPcm.toString("base64"),
      sampleRate: this.currentSampleRate
    });
  }

  sendAudio(pcmBase64: string, sampleRate: number = 24000) {
    this.currentSampleRate = sampleRate;
    try {
      const buf = Buffer.from(pcmBase64, "base64");
      if (buf.length) this.audioBatchPcm.push(buf);
    } catch {
      return;
    }

    if (!this.audioBatchTimer) {
      // Very fast flush to keep latency low, but batching sync event loop drops
      this.audioBatchTimer = setTimeout(() => this._flushAudioBatch(), 5);
    }
  }

  stopPlayback() {
    this._send({ type: "stop_playback" });
  }

  stopTtsPlayback() {
    this._send({ type: "stop_tts_playback" });
  }

  subscribeUser(userId: string, silenceDurationMs: number = 700, sampleRate: number = 24000) {
    this._send({ type: "subscribe_user", userId, silenceDurationMs, sampleRate });
  }

  unsubscribeUser(userId: string) {
    this._send({ type: "unsubscribe_user", userId });
  }

  musicPlay(url: string, resolvedDirectUrl = false) {
    this._send({ type: "music_play", url, resolvedDirectUrl });
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

  connectAsr({ userId, apiKey, model, language, prompt }: ConnectAsrOptions) {
    this._send({
      type: "connect_asr",
      userId,
      apiKey,
      model,
      language: language || null,
      prompt: prompt || null
    });
  }

  disconnectAsr(userId: string) {
    this._send({ type: "disconnect_asr", userId });
  }

  commitAsr(userId: string) {
    this._send({ type: "commit_asr", userId });
  }

  clearAsr(userId: string) {
    this._send({ type: "clear_asr", userId });
  }

  async destroy(): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise;
    this.destroyed = true;

    if (this.audioBatchTimer) {
      clearTimeout(this.audioBatchTimer);
      this.audioBatchTimer = null;
    }
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
