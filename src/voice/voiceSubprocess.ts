/**
 * Node.js subprocess entry point for Discord voice.
 *
 * Runs under `node --experimental-strip-types` and owns the entire
 * @discordjs/voice layer: VoiceConnection (UDP), AudioPlayer (20ms timer),
 * Opus encoding, and voice receiver (user audio).
 *
 * Communicates with the main Bun process exclusively via IPC
 * (process.send / process.on("message")).
 */

import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  EndBehaviorType,
  joinVoiceChannel,
  StreamType,
  VoiceConnectionStatus,
  entersState,
  type AudioPlayer,
  type VoiceConnection
} from "@discordjs/voice";
import { spawn as spawnChild, type ChildProcess } from "node:child_process";
import { Readable } from "node:stream";
import prism from "prism-media";
import { convertXaiOutputToDiscordPcm, convertDiscordPcmToXaiInput } from "./pcmAudio.ts";

const AUDIO_DEBUG = !!process.env.AUDIO_DEBUG;

// --- State ---

let connection: VoiceConnection | null = null;
let audioPlayer: AudioPlayer | null = null;
let botAudioStream: PcmJitterBuffer | null = null;
let adapterMethods: { onVoiceServerUpdate: (data: any) => void; onVoiceStateUpdate: (data: any) => void } | null = null;
const userSubscriptions = new Map<string, { opusStream: any; decoder: any; pcmStream: any }>();
let defaultSilenceDurationMs = 700;
let defaultSampleRate = 24000;

// Music child processes — tracked for explicit cleanup on stop/skip
let musicProcesses: { pid: number; kill: () => void }[] = [];

const FRAME_SIZE = 3840; // 20ms at 48kHz stereo s16le

// --- Pull-based jitter buffer ---
// Replaces the old PassThrough + setInterval silence pump.
// The AudioPlayer calls _read() every ~20ms to pull the next frame.

class PcmJitterBuffer extends Readable {
  private chunks: Buffer[] = [];
  private bufferedBytes = 0;
  private partial: Buffer | null = null; // leftover bytes < one frame
  private lastPushAt = 0;
  private _reading = false;

  constructor() {
    // High watermark here doesn't actually stop AudioPlayer from calling read
    // but we use it to cap the array growth just in case. 
    super({ highWaterMark: FRAME_SIZE * 250 }); // Allow 5 seconds of audio buffer
  }

  pushPcm(chunk: Buffer) {
    this.lastPushAt = Date.now();

    // Prepend any leftover partial frame from previous push
    if (this.partial) {
      chunk = Buffer.concat([this.partial, chunk]);
      this.partial = null;
    }

    // Slice into frame-aligned chunks for clean _read() pulls
    let offset = 0;
    while (offset + FRAME_SIZE <= chunk.length) {
      const frame = chunk.subarray(offset, offset + FRAME_SIZE);
      this.chunks.push(frame);
      this.bufferedBytes += FRAME_SIZE;
      offset += FRAME_SIZE;
    }

    // Stash any remainder for the next pushPcm call
    if (offset < chunk.length) {
      this.partial = Buffer.from(chunk.subarray(offset));
    }

    this._tryPush();

    // When the AudioPlayer is in Buffering state it does NOT call _read(),
    // so _reading stays false and _tryPush() is a no-op — the "readable"
    // event that Buffering→Playing depends on never fires.
    // Emit "readable" so the AudioPlayer can transition to Playing.
    if (!this._reading && this.chunks.length > 0) {
      this.emit("readable");
    }
  }

  private _tryPush() {
    while (this._reading && this.chunks.length > 0) {
      const frame = this.chunks.shift()!;
      this.bufferedBytes -= FRAME_SIZE;
      this._reading = this.push(frame);
    }
  }

  getBufferedChunks(): Buffer[] {
    const res = [...this.chunks];
    if (this.partial) res.push(this.partial);
    return res;
  }

  clearBufferedAudio() {
    this.chunks = [];
    this.bufferedBytes = 0;
    this.partial = null;
  }

  // Finish is no longer called by an idle timer.
  // We keep the stream open indefinitely.
  finish() {
    // Flush any partial frame padded with silence
    if (this.partial && this.partial.length > 0) {
      const padded = Buffer.alloc(FRAME_SIZE, 0);
      this.partial.copy(padded);
      this.chunks.push(padded);
      this.bufferedBytes += FRAME_SIZE;
      this.partial = null;
    }
    // Push remaining buffered frames, then EOF
    while (this.chunks.length > 0) {
      const frame = this.chunks.shift()!;
      this.bufferedBytes -= FRAME_SIZE;
      this.push(frame); // force push to clear the buffer
    }
    this.push(null);
  }

  override _read() {
    this._reading = true;
    this._tryPush();
  }

  override _destroy(err: Error | null, cb: (err: Error | null) => void) {
    this.chunks = [];
    this.bufferedBytes = 0;
    this.partial = null;
    this._reading = false;
    cb(err);
  }
}

// --- IPC helpers ---

function send(msg: any) {
  if (typeof process.send === "function") {
    process.send(msg);
  }
}

function sendError(message: string) {
  send({ type: "error", message });
}

// --- Audio playback pipeline ---

function killMusicProcesses() {
  for (const proc of musicProcesses) {
    try { proc.kill(); } catch { /* ignore */ }
  }
  musicProcesses = [];
}

function resetPlayback() {
  // Remove stale .once(Idle) listeners before stopping, so a forced idle
  // transition doesn't fire handlers from the previous track.
  if (audioPlayer) {
    try { audioPlayer.removeAllListeners(AudioPlayerStatus.Idle); } catch { /* ignore */ }
  }
  killMusicProcesses();
  if (botAudioStream) {
    try { botAudioStream.destroy(); } catch { /* ignore */ }
    botAudioStream = null;
  }
  if (audioPlayer) {
    try { audioPlayer.stop(true); } catch { /* ignore */ }
  }
}

function ensurePlaybackStream() {
  if (botAudioStream && !botAudioStream.destroyed && !botAudioStream.readableEnded) {
    if (audioPlayer && audioPlayer.state.status === AudioPlayerStatus.Idle) {
      const oldChunks = botAudioStream.getBufferedChunks();
      try { botAudioStream.destroy(); } catch { /* ignore */ }
      
      botAudioStream = new PcmJitterBuffer();
      for (const chunk of oldChunks) {
        botAudioStream.pushPcm(chunk);
      }
      const resource = createAudioResource(botAudioStream, {
        inputType: StreamType.Raw,
        silencePaddingFrames: 250
      });
      audioPlayer.play(resource);
      if (AUDIO_DEBUG) {
        const ts = new Date().toISOString().slice(11, 23);
        console.log(`[subprocess:audio] ${ts} player.play() called (recycled stream)  oldChunks=${oldChunks.length}  playerStatus=${audioPlayer.state.status}`);
      }
    }
    return true;
  }
  if (!audioPlayer || !connection) return false;

  if (AUDIO_DEBUG && !firstAudioPlayedAt) {
    const ts = new Date().toISOString().slice(11, 23);
    console.log(`[subprocess:audio] ${ts} ensurePlaybackStream: creating fresh stream...`);
  }
  botAudioStream = new PcmJitterBuffer();
  if (AUDIO_DEBUG && !firstAudioPlayedAt) {
    const ts = new Date().toISOString().slice(11, 23);
    console.log(`[subprocess:audio] ${ts} ensurePlaybackStream: PcmJitterBuffer created, calling createAudioResource...`);
  }
  const resource = createAudioResource(botAudioStream, {
    inputType: StreamType.Raw,
    silencePaddingFrames: 250
  });
  if (AUDIO_DEBUG && !firstAudioPlayedAt) {
    const ts = new Date().toISOString().slice(11, 23);
    console.log(`[subprocess:audio] ${ts} ensurePlaybackStream: resource created, calling audioPlayer.play()...`);
  }
  audioPlayer.play(resource);
  if (AUDIO_DEBUG) {
    const ts = new Date().toISOString().slice(11, 23);
    console.log(`[subprocess:audio] ${ts} player.play() called (fresh stream)  playerStatus=${audioPlayer.state.status}`);
  }
  return true;
}

function armVoicePlayback(reason: string) {
  if (!audioPlayer || !connection) return false;
  const armed = ensurePlaybackStream();
  if (armed && AUDIO_DEBUG) {
    const ts = new Date().toISOString().slice(11, 23);
    console.log(`[subprocess:audio] ${ts} voice playback armed  reason=${reason}  playerStatus=${audioPlayer.state.status}`);
  }
  return armed;
}

// --- Async Audio Processing Queue ---
// Process audio chunks asynchronously to avoid blocking the event loop
// during large burst arrivals (e.g., from OpenAI/xAI).
const audioDeltaQueue: { pcmBase64: string; sampleRate: number }[] = [];
let isDrainingAudio = false;

function drainAudioQueue() {
  if (AUDIO_DEBUG && !firstAudioPlayedAt) {
    const ts = new Date().toISOString().slice(11, 23);
    console.log(`[subprocess:audio] ${ts} drainAudioQueue ENTER  queueDepth=${audioDeltaQueue.length}`);
  }
  let processed = 0;
  while (audioDeltaQueue.length > 0) {
    const { pcmBase64, sampleRate } = audioDeltaQueue.shift()!;
    
    let rawPcm: Buffer;
    try {
      rawPcm = Buffer.from(pcmBase64, "base64");
    } catch {
      continue;
    }
    if (rawPcm.length) {
      if (AUDIO_DEBUG && !firstAudioPlayedAt) {
        const ts = new Date().toISOString().slice(11, 23);
        console.log(`[subprocess:audio] ${ts} pre-convert  rawBytes=${rawPcm.length}  sampleRate=${sampleRate}`);
      }
      const discordPcm = convertXaiOutputToDiscordPcm(rawPcm, sampleRate);
      if (AUDIO_DEBUG && !firstAudioPlayedAt) {
        const ts = new Date().toISOString().slice(11, 23);
        console.log(`[subprocess:audio] ${ts} post-convert  discordPcmBytes=${discordPcm.length}`);
      }
      if (discordPcm.length) {
        if (AUDIO_DEBUG && !firstAudioPlayedAt) {
          const ts = new Date().toISOString().slice(11, 23);
          console.log(`[subprocess:audio] ${ts} pre-ensurePlaybackStream  hasStream=${!!botAudioStream}  hasPlayer=${!!audioPlayer}  hasConn=${!!connection}`);
        }
        if (ensurePlaybackStream()) {
          if (botAudioStream && !botAudioStream.destroyed && !botAudioStream.readableEnded) {
            botAudioStream.pushPcm(discordPcm);
            if (AUDIO_DEBUG && !firstAudioPlayedAt) {
              firstAudioPlayedAt = Date.now();
              const ts = new Date().toISOString().slice(11, 23);
              const ipcToPlayMs = firstAudioReceivedAt ? firstAudioPlayedAt - firstAudioReceivedAt : -1;
              console.log(`[subprocess:audio] ${ts} first chunk pushed to jitter buffer  pcmBytes=${discordPcm.length}  ipcToPlayMs=${ipcToPlayMs}  playerStatus=${audioPlayer?.state.status}`);
            }
          }
        }
      }
    }

    processed++;
    if (processed >= 10) {
      setTimeout(drainAudioQueue, 1);
      return;
    }
  }
  isDrainingAudio = false;
}

let firstAudioReceivedAt = 0;
let firstAudioPlayedAt = 0;

let audioChunksReceived = 0;

function handleAudio(pcmBase64: string, sampleRate: number) {
  audioChunksReceived++;
  if (AUDIO_DEBUG && audioChunksReceived <= 3) {
    if (!firstAudioReceivedAt) firstAudioReceivedAt = Date.now();
    const ts = new Date().toISOString().slice(11, 23);
    console.log(`[subprocess:audio] ${ts} IPC audio #${audioChunksReceived}  isDraining=${isDrainingAudio}  queueDepth=${audioDeltaQueue.length}  hasPlayer=${!!audioPlayer}  hasConnection=${!!connection}  playerStatus=${audioPlayer?.state?.status ?? "null"}`);
  }
  audioDeltaQueue.push({ pcmBase64, sampleRate });
  if (!isDrainingAudio) {
    isDrainingAudio = true;
    // Drain synchronously on the IPC message tick — setTimeout(…, 1)
    // gets starved for 10-20s when the DAVE E2EE handshake is running
    // synchronous native crypto on the event loop.
    drainAudioQueue();
  }
}

function handleStopPlayback() {
  resetPlayback();
  armVoicePlayback("stop_playback");
  firstAudioReceivedAt = 0;
  firstAudioPlayedAt = 0;
  audioChunksReceived = 0;
  send({ type: "player_state", status: "idle" });
}

// --- Voice connection via adapter proxy ---

function createProxyAdapterCreator(guildId: string, channelId: string) {
  return (methods: any) => {
    adapterMethods = methods;
    return {
      sendPayload(payload: any) {
        // Forward OP4 (voice state update) to main process → Discord gateway
        send({ type: "adapter_send", payload });
        return true;
      },
      destroy() {
        adapterMethods = null;
      }
    };
  };
}

function handleJoin(msg: any) {
  const { guildId, channelId, selfDeaf, selfMute } = msg;

  try {
    connection = joinVoiceChannel({
      channelId,
      guildId,
      adapterCreator: createProxyAdapterCreator(guildId, channelId),
      selfDeaf: selfDeaf ?? false,
      selfMute: selfMute ?? false,
      // Higher tolerance for DAVE decryption failures during the E2EE
      // handshake — the default (36) can be exceeded before the session
      // negotiation completes on slower connections.
      decryptionFailureTolerance: 200
    });

    audioPlayer = createAudioPlayer({
      behaviors: { maxMissedFrames: 250 }
    });
    connection.subscribe(audioPlayer);

    // Audio player state tracking
    audioPlayer.on("stateChange", (oldState, newState) => {
      if (AUDIO_DEBUG && oldState.status !== newState.status) {
        const ts = new Date().toISOString().slice(11, 23);
        console.log(`[subprocess:audio-player] ${ts} ${oldState.status} → ${newState.status}`);
      }
      send({ type: "player_state", status: newState.status });
    });

    audioPlayer.on("error", (error) => {
      sendError(`audio_player_error: ${String(error?.message || error)}`);
      resetPlayback();
    });

    // Connection state tracking
    connection.on("stateChange", (_oldState, newState) => {
      send({ type: "connection_state", status: newState.status });

      if (newState.status === VoiceConnectionStatus.Ready) {
        send({ type: "ready" });
        armVoicePlayback("connection_ready");
      }
    });

    // Speaking events from voice receiver — auto-subscribe immediately so
    // there is no IPC round-trip delay before audio starts flowing.
    const speaking = connection.receiver?.speaking;
    if (speaking) {
      speaking.on("start", (userId: string) => {
        send({ type: "speaking_start", userId: String(userId) });
        // Auto-subscribe: eliminates the IPC round-trip that caused
        // subscribe_user to arrive too late (after the user's speech).
        handleSubscribeUser(String(userId), defaultSilenceDurationMs, defaultSampleRate);
      });
      speaking.on("end", (userId: string) => {
        send({ type: "speaking_end", userId: String(userId) });
      });
    }

    // Wait for Ready state
    entersState(connection, VoiceConnectionStatus.Ready, 15_000).catch((err) => {
      sendError(`connection_ready_timeout: ${String(err?.message || err)}`);
    });
  } catch (error) {
    sendError(`join_failed: ${String(error?.message || error)}`);
  }
}

// --- Voice events from main process (gateway → adapter) ---

function handleVoiceServer(data: any) {
  if (adapterMethods) {
    adapterMethods.onVoiceServerUpdate(data);
  }
}

function handleVoiceState(data: any) {
  if (adapterMethods) {
    adapterMethods.onVoiceStateUpdate(data);
  }
}

// --- User audio capture (voice receiver) ---

function handleSubscribeUser(userId: string, silenceDurationMs: number, sampleRate: number = 24000) {
  if (!connection) return;
  if (userSubscriptions.has(userId)) return;

  const opusStream = connection.receiver.subscribe(userId, {
    end: {
      behavior: EndBehaviorType.AfterSilence,
      duration: silenceDurationMs || 700
    }
  });

  const decoder = new prism.opus.Decoder({
    rate: 48000,
    channels: 2,
    frameSize: 960
  });

  const pcmStream = opusStream.pipe(decoder);

  // DAVE decryption failures destroy the opus stream with an error.
  // Without a handler this becomes an uncaught exception crashing the process.
  opusStream.on("error", () => {
    cleanupUserSubscription(userId);
    send({ type: "user_audio_end", userId });
  });

  pcmStream.on("data", (chunk: Buffer) => {
    // Convert to mono and send to main process at the requested sample rate
    const monoChunk = convertDiscordPcmToXaiInput(chunk, sampleRate);
    if (monoChunk.length) {
      send({
        type: "user_audio",
        userId,
        pcmBase64: monoChunk.toString("base64")
      });
    }
  });

  pcmStream.on("end", () => {
    cleanupUserSubscription(userId);
    send({ type: "user_audio_end", userId });
  });

  pcmStream.on("error", () => {
    cleanupUserSubscription(userId);
    send({ type: "user_audio_end", userId });
  });

  userSubscriptions.set(userId, { opusStream, decoder, pcmStream });
}

function handleUnsubscribeUser(userId: string) {
  cleanupUserSubscription(userId);
}

function cleanupUserSubscription(userId: string) {
  const sub = userSubscriptions.get(userId);
  if (!sub) return;
  userSubscriptions.delete(userId);
  try { sub.opusStream.destroy(); } catch { /* ignore */ }
  try { sub.decoder.destroy?.(); } catch { /* ignore */ }
  try { sub.pcmStream.destroy(); } catch { /* ignore */ }
}

// --- Music playback (yt-dlp/ffmpeg pipeline in subprocess) ---

function trackMusicProcess(proc: ChildProcess) {
  const entry = { pid: proc.pid ?? 0, kill: () => { try { proc.kill(); } catch { /* ignore */ } } };
  musicProcesses.push(entry);
  proc.once("exit", () => {
    musicProcesses = musicProcesses.filter((p) => p !== entry);
  });
}

function handleMusicPlay(msg: any) {
  const { url } = msg;
  if (!connection || !url) {
    send({ type: "music_error", message: "no connection or URL" });
    return;
  }

  resetPlayback();

  try {
    const isYouTube = url.includes("youtube.com") || url.includes("youtu.be");

    if (isYouTube) {
      const ytdlp = spawnChild("yt-dlp", [
        "--no-warnings", "--quiet", "--no-playlist",
        "--extractor-args", "youtube:player_client=android",
        "-f", "bestaudio/best",
        "-o", "-", url
      ]);

      const ffmpeg = spawnChild("ffmpeg", [
        "-hide_banner", "-loglevel", "error",
        "-i", "pipe:0",
        "-f", "opus", "-ac", "2", "-ar", "48000", "-b:a", "128k",
        "pipe:1"
      ]);

      trackMusicProcess(ytdlp);
      trackMusicProcess(ffmpeg);

      ytdlp.stdout.pipe(ffmpeg.stdin);

      const resource = createAudioResource(ffmpeg.stdout, {
        inputType: StreamType.OggOpus
      });

      if (!audioPlayer) {
        audioPlayer = createAudioPlayer({
      behaviors: { maxMissedFrames: 250 }
    });
        connection.subscribe(audioPlayer);
      }
      audioPlayer.play(resource);

      audioPlayer.once(AudioPlayerStatus.Idle, () => {
        send({ type: "music_idle" });
        armVoicePlayback("music_idle");
      });

      ytdlp.on("error", (err: any) => {
        send({ type: "music_error", message: `yt-dlp: ${err?.message || err}` });
      });
      ffmpeg.on("error", (err: any) => {
        send({ type: "music_error", message: `ffmpeg: ${err?.message || err}` });
      });
    } else {
      const ffmpeg = spawnChild("ffmpeg", [
        "-hide_banner", "-loglevel", "error",
        "-i", url,
        "-f", "opus", "-ac", "2", "-ar", "48000", "-b:a", "128k",
        "pipe:1"
      ]);

      trackMusicProcess(ffmpeg);

      const resource = createAudioResource(ffmpeg.stdout, {
        inputType: StreamType.OggOpus
      });

      if (!audioPlayer) {
        audioPlayer = createAudioPlayer({
      behaviors: { maxMissedFrames: 250 }
    });
        connection.subscribe(audioPlayer);
      }
      audioPlayer.play(resource);

      audioPlayer.once(AudioPlayerStatus.Idle, () => {
        send({ type: "music_idle" });
        armVoicePlayback("music_idle");
      });

      ffmpeg.on("error", (err: any) => {
        send({ type: "music_error", message: `ffmpeg: ${err?.message || err}` });
      });
    }
  } catch (error) {
    send({ type: "music_error", message: String(error?.message || error) });
  }
}

function handleMusicStop() {
  resetPlayback();
  armVoicePlayback("music_stop");
  send({ type: "music_idle" });
}

function handleMusicPause() {
  audioPlayer?.pause();
}

function handleMusicResume() {
  audioPlayer?.unpause();
}

// --- Destroy ---

function handleDestroy() {
  for (const userId of userSubscriptions.keys()) {
    cleanupUserSubscription(userId);
  }

  resetPlayback();
  if (connection) {
    try { connection.destroy(); } catch { /* ignore */ }
    connection = null;
  }

  adapterMethods = null;
  setTimeout(() => process.exit(0), 100);
}

// --- IPC message router ---

process.on("message", (msg: any) => {
  if (!msg || typeof msg !== "object") return;

  switch (msg.type) {
    case "join":
      handleJoin(msg);
      break;
    case "voice_server":
      handleVoiceServer(msg.data);
      break;
    case "voice_state":
      handleVoiceState(msg.data);
      break;
    case "audio":
      handleAudio(msg.pcmBase64, Number(msg.sampleRate) || 24000);
      break;
    case "stop_playback":
      handleStopPlayback();
      break;
    case "subscribe_user":
      // Update defaults for future auto-subscriptions
      defaultSilenceDurationMs = Number(msg.silenceDurationMs) || 700;
      defaultSampleRate = Number(msg.sampleRate) || 24000;
      handleSubscribeUser(msg.userId, defaultSilenceDurationMs, defaultSampleRate);
      break;
    case "unsubscribe_user":
      handleUnsubscribeUser(msg.userId);
      break;
    case "music_play":
      handleMusicPlay(msg);
      break;
    case "music_stop":
      handleMusicStop();
      break;
    case "music_pause":
      handleMusicPause();
      break;
    case "music_resume":
      handleMusicResume();
      break;
    case "destroy":
      handleDestroy();
      break;
    default:
      if (AUDIO_DEBUG) {
        console.log(`[subprocess] unknown message type: ${msg.type}`);
      }
      break;
  }
});

process.on("disconnect", () => {
  handleDestroy();
});

process.on("uncaughtException", (err: any) => {
  const msg = String(err?.message || err);
  console.error("[subprocess] uncaught exception:", err);
  sendError(`uncaught_exception: ${msg}`);
  // DAVE decryption errors are transient during the E2EE handshake —
  // don't crash the subprocess for these.
  if (/decrypt/i.test(msg)) return;
  handleDestroy();
});

process.on("unhandledRejection", (err: any) => {
  console.error("[subprocess] unhandled rejection:", err);
  sendError(`unhandled_rejection: ${String(err?.message || err)}`);
});

console.log("[subprocess] voice subprocess started, waiting for IPC messages");
