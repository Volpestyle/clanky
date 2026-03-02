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
import type { IVoiceClient, VoiceClientOptions } from "./voiceClient.ts";

const AUDIO_DEBUG = !!process.env.AUDIO_DEBUG;

export class VoiceSubprocessClient extends EventEmitter implements IVoiceClient {
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
    const nodeExec = process.env.NODE_EXEC_PATH || "node";
    const subprocessPath = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      "voiceSubprocess.ts"
    );

    this.child = spawn(
      nodeExec,
      ["--experimental-strip-types", subprocessPath],
      {
        stdio: ["ignore", "inherit", "inherit", "ipc"]
      }
    );

    this.child.on("message", (msg: any) => {
      this._handleMessage(msg);
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
    if (!this.child || !this.child.connected) return;
    try {
      this.child.send(msg);
    } catch (err) {
      if (AUDIO_DEBUG) {
        console.error("[voiceSubprocessClient] IPC send error:", err);
      }
    }
  }

  // --- Public API ---

  sendAudio(pcmBase64: string, sampleRate: number = 24000) {
    this._send({ type: "audio", pcmBase64, sampleRate });
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
