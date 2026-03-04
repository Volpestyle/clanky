/**
 * Main-process (Bun) client for the Rust voice subprocess.
 *
 * Spawns the subprocess, relays IPC messages, proxies the Discord gateway
 * adapter so the subprocess can join voice channels through the main
 * process's gateway connection, and emits events for the session manager.
 */

import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

const AUDIO_DEBUG = !!process.env.AUDIO_DEBUG;

export class VoiceSubprocessClient extends EventEmitter {
  private static liveClients = new Set<VoiceSubprocessClient>();
  private static processExitHandlersInstalled = false;

  private child: ChildProcess | null = null;
  private guildId: string;
  private channelId: string;
  private guild: any;
  private destroyed = false;
  private destroyPromise: Promise<void> | null = null;
  private adapterCleanup: (() => void) | null = null;
  private stdoutBuffer: Buffer = Buffer.alloc(0);
  private lastPlaybackArmedReason: string | null = null;

  constructor(guildId: string, channelId: string, guild: any) {
    super();
    VoiceSubprocessClient.installProcessExitHandlers();
    this.guildId = guildId;
    this.channelId = channelId;
    this.guild = guild;
  }

  static async spawn(
    guildId: string,
    channelId: string,
    guild: any,
    opts: { selfDeaf?: boolean; selfMute?: boolean; timeoutMs?: number } = {}
  ): Promise<VoiceSubprocessClient> {
    const client = new VoiceSubprocessClient(guildId, channelId, guild);
    await client._spawn(opts);
    return client;
  }

  private async _spawn(opts: {
    selfDeaf?: boolean;
    selfMute?: boolean;
    timeoutMs?: number;
  }) {
    const moduleDir = path.dirname(decodeURIComponent(new URL(import.meta.url).pathname));
    const subprocessDir = path.resolve(
      moduleDir,
      "rust_subprocess"
    );

    // Prefer the pre-built Rust binary; fall back to cargo run for development.
    const releaseBin = path.join(subprocessDir, "target", "release", "voice_subprocess");
    const fs = await import("node:fs");
    const usePrebuilt = fs.existsSync(releaseBin);

    const spawnEnv = {
      ...process.env,
      // audiopus_sys needs these to build opus from source on arm64 macOS
      // (the homebrew x86 opus won't link). These are no-ops if opus is already
      // linked or the binary is pre-built.
      OPUS_STATIC: "1",
      OPUS_NO_PKG: "1",
    };

    if (usePrebuilt) {
      this.child = spawn(releaseBin, [], {
        cwd: subprocessDir,
        stdio: ["pipe", "pipe", "inherit"],
        env: spawnEnv
      });
    } else {
      console.warn(
        "[voiceSubprocessClient] Pre-built binary not found, using cargo run --release (slow first start)"
      );
      this.child = spawn("cargo", ["run", "--release"], {
        cwd: subprocessDir,
        stdio: ["pipe", "pipe", "inherit"],
        env: spawnEnv
      });
    }
    VoiceSubprocessClient.liveClients.add(this);

    this.child.stdout?.on("data", (data: Buffer) => {
      this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, data]);

      while (this.stdoutBuffer.length >= 5) {
        const format = this.stdoutBuffer.readUInt8(0);
        const length = this.stdoutBuffer.readUInt32LE(1);

        if (this.stdoutBuffer.length >= 5 + length) {
          const payload = this.stdoutBuffer.subarray(5, 5 + length);
          this.stdoutBuffer = this.stdoutBuffer.subarray(5 + length);

          if (format === 0) {
            try {
              const msg = JSON.parse(payload.toString("utf8"));
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
                pcmBuffer, // Passing raw Buffer now instead of base64 string
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
    });

    this.child.on("exit", (code, signal) => {
      if (!this.destroyed) {
        console.error(
          `[voiceSubprocessClient] subprocess exited unexpectedly code=${code} signal=${signal}`
        );
        this.emit("crashed", { code, signal });
      }
      VoiceSubprocessClient.liveClients.delete(this);
      this._cleanupAdapter();
      this.child = null;
    });

    this.child.on("error", (err) => {
      console.error("[voiceSubprocessClient] subprocess spawn error:", err);
      this.emit("error", `spawn_error: ${String(err?.message || err)}`);
    });

    this._setupAdapterProxy();

    const timeoutMs = opts.timeoutMs ?? 15_000;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        void this.destroy();
        reject(new Error(`voice subprocess ready timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      this.once("ready", () => {
        clearTimeout(timer);
        resolve();
      });

      this.once("crashed", ({ code, signal }) => {
        clearTimeout(timer);
        reject(
          new Error(
            `voice subprocess crashed before ready code=${code} signal=${signal}`
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

  private adapterCallbackCount = { voiceState: 0, voiceServer: 0, op4Forward: 0 };

  private _setupAdapterProxy() {
    const guild = this.guild;
    if (!guild?.voiceAdapterCreator) return;

    const adapter = guild.voiceAdapterCreator({
      onVoiceServerUpdate: (data: any) => {
        this.adapterCallbackCount.voiceServer++;
        if (AUDIO_DEBUG) {
          console.log(
            `[voiceSubprocessClient] adapter onVoiceServerUpdate #${this.adapterCallbackCount.voiceServer}`,
            `endpoint=${data?.endpoint ?? "null"} token=${data?.token ? "present" : "missing"}`
          );
        }
        this._send({ type: "voice_server", data });
      },
      onVoiceStateUpdate: (data: any) => {
        this.adapterCallbackCount.voiceState++;
        if (AUDIO_DEBUG) {
          console.log(
            `[voiceSubprocessClient] adapter onVoiceStateUpdate #${this.adapterCallbackCount.voiceState}`,
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

  private _handleMessage(msg: any) {
    if (!msg || typeof msg !== "object") return;

    switch (msg.type) {
      case "ready":
        this.emit("ready");
        break;
      case "adapter_send":
        this._forwardToGateway(msg.payload);
        break;
      case "connection_state":
        this.emit("connectionState", msg.status);
        break;
      case "player_state":
        this.emit("playerState", msg.status);
        break;
      case "playback_armed":
        this.lastPlaybackArmedReason = String(msg.reason || "").trim() || null;
        this.emit("playbackArmed", msg.reason);
        break;
      case "speaking_start":
        this.emit("speakingStart", msg.userId);
        break;
      case "speaking_end":
        this.emit("speakingEnd", msg.userId);
        break;
      // "user_audio" (JSON) is bypassed above in the binary fast path, but kept here for fallback or tests
      case "user_audio":
        this.emit(
          "userAudio",
          msg.userId,
          msg.pcmBase64,
          msg.signalPeakAbs,
          msg.signalActiveSampleCount,
          msg.signalSampleCount
        );
        break;
      case "user_audio_end":
        this.emit("userAudioEnd", msg.userId);
        break;
      case "asr_transcript":
        this.emit("asrTranscript", msg.userId, msg.text, msg.isFinal);
        break;
      case "asr_disconnected":
        this.emit("asrDisconnected", msg.userId, msg.reason);
        break;
      case "client_disconnect":
        this.emit("clientDisconnect", msg.userId);
        break;
      case "music_idle":
        this.emit("musicIdle");
        break;
      case "music_error":
        this.emit("musicError", msg.message);
        break;
      case "music_gain_reached":
        this.emit("musicGainReached", msg.gain);
        break;
      case "error":
        this.emit("error", msg.message);
        break;
      default:
        if (AUDIO_DEBUG) {
          console.log(
            `[voiceSubprocessClient] unknown message from subprocess: ${msg.type}`
          );
        }
        break;
    }
  }

  getPlaybackArmedReason(): string | null {
    return this.lastPlaybackArmedReason;
  }

  private _forwardToGateway(payload: any) {
    if (!payload || !this.guild) return;
    this.adapterCallbackCount.op4Forward++;
    if (AUDIO_DEBUG) {
      console.log(
        `[voiceSubprocessClient] _forwardToGateway OP4 #${this.adapterCallbackCount.op4Forward}`,
        `guild_id=${payload?.d?.guild_id ?? "null"} channel_id=${payload?.d?.channel_id ?? "null"}`
      );
    }
    try {
      const shard = this.guild.shard;
      if (shard && typeof shard.send === "function") {
        shard.send(payload);
      }
    } catch (err) {
      console.error(
        "[voiceSubprocessClient] failed to forward OP4 to gateway:",
        err
      );
    }
  }

  private _send(msg: any) {
    if (!this.child || this.child.killed || !this.child.stdin) return;
    try {
      this.child.stdin.write(JSON.stringify(msg) + "\n");
    } catch (err) {
      if (AUDIO_DEBUG) {
        console.error("[voiceSubprocessClient] IPC send error:", err);
      }
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

  connectAsr({ userId, apiKey, model, language, prompt }) {
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

    const child = this.child;
    if (!child) {
      VoiceSubprocessClient.liveClients.delete(this);
      return;
    }

    this.destroyPromise = new Promise<void>((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(termTimer);
        clearTimeout(killTimer);
        VoiceSubprocessClient.liveClients.delete(this);
        resolve();
      };

      child.once("exit", finish);
      child.once("error", finish);

      this._send({ type: "destroy" });
      try {
        child.stdin?.end();
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
    if (VoiceSubprocessClient.processExitHandlersInstalled) return;
    VoiceSubprocessClient.processExitHandlersInstalled = true;

    const killLiveChildren = () => {
      for (const client of VoiceSubprocessClient.liveClients) {
        client.killChild("SIGKILL");
      }
      VoiceSubprocessClient.liveClients.clear();
    };

    process.once("exit", killLiveChildren);
  }
}
