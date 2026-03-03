/**
 * Main-process (Bun) client for the Node.js voice subprocess.
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
  private child: ChildProcess | null = null;
  private guildId: string;
  private channelId: string;
  private guild: any;
  private destroyed = false;
  private adapterCleanup: (() => void) | null = null;

  constructor(guildId: string, channelId: string, guild: any) {
    super();
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
    const subprocessDir = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      "rust_subprocess"
    );

    // Prefer pre-built release binary; fall back to cargo run for development
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
        env: spawnEnv,
      });
    } else {
      console.warn(
        "[voiceSubprocessClient] Pre-built binary not found, using cargo run --release (slow first start)"
      );
      this.child = spawn("cargo", ["run", "--release"], {
        cwd: subprocessDir,
        stdio: ["pipe", "pipe", "inherit"],
        env: spawnEnv,
      });
    }

    this.child.stdout?.on("data", (data: Buffer) => {
      const lines = data.toString().split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          this._handleMessage(msg);
        } catch (e) {
          // ignore non-json stdout (e.g. cargo build logs)
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
        this.destroy();
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

  private _setupAdapterProxy() {
    const guild = this.guild;
    if (!guild?.voiceAdapterCreator) return;

    const adapter = guild.voiceAdapterCreator({
      onVoiceServerUpdate: (data: any) => {
        this._send({ type: "voice_server", data });
      },
      onVoiceStateUpdate: (data: any) => {
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
        this.emit("playbackArmed", msg.reason);
        break;
      case "speaking_start":
        this.emit("speakingStart", msg.userId);
        break;
      case "speaking_end":
        this.emit("speakingEnd", msg.userId);
        break;
      case "user_audio":
        this.emit("userAudio", msg.userId, msg.pcmBase64);
        break;
      case "user_audio_end":
        this.emit("userAudioEnd", msg.userId);
        break;
      case "music_idle":
        this.emit("musicIdle");
        break;
      case "music_error":
        this.emit("musicError", msg.message);
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

  private _forwardToGateway(payload: any) {
    if (!payload || !this.guild) return;
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

  musicPlay(url: string) {
    this._send({ type: "music_play", url });
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

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;

    if (this.audioBatchTimer) {
      clearTimeout(this.audioBatchTimer);
      this.audioBatchTimer = null;
    }

    this._send({ type: "destroy" });
    this._cleanupAdapter();

    const killTimer = setTimeout(() => {
      if (this.child) {
        try { this.child.kill("SIGKILL"); } catch { /* ignore */ }
        this.child = null;
      }
    }, 5000);

    if (this.child) {
      this.child.once("exit", () => {
        clearTimeout(killTimer);
        this.child = null;
      });
    } else {
      clearTimeout(killTimer);
    }
  }

  get isAlive(): boolean {
    return !this.destroyed && this.child !== null && this.child.connected;
  }
}
