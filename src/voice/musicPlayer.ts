/**
 * Music player that delegates playback to the Node.js voice subprocess
 * via the VoiceSubprocessClient IPC layer.
 *
 * The subprocess owns yt-dlp/ffmpeg pipelines and the AudioPlayer; this
 * class tracks state and proxies commands.
 */
import type { VoiceSubprocessClient } from "./voiceSubprocessClient.ts";
import type { MusicSearchResult } from "./musicSearch.ts";

export type MusicPlayerStatus = {
  playing: boolean;
  paused: boolean;
  currentTrack: MusicSearchResult | null;
  position: number;
};

export type MusicPlayerResult = {
  ok: boolean;
  error: string | null;
  track: MusicSearchResult | null;
};

export class DiscordMusicPlayer {
  private subprocessClient: VoiceSubprocessClient | null = null;
  private currentTrack: MusicSearchResult | null = null;
  private _playing = false;
  private _paused = false;
  private _ducked = false;

  constructor() {}

  /** Bind to the current session's subprocess client. */
  setSubprocessClient(client: VoiceSubprocessClient | null): void {
    // Clean up old listeners
    if (this.subprocessClient) {
      this.subprocessClient.off("musicIdle", this._onMusicIdle);
      this.subprocessClient.off("musicError", this._onMusicError);
    }

    this.subprocessClient = client;

    if (client) {
      client.on("musicIdle", this._onMusicIdle);
      client.on("musicError", this._onMusicError);
    }
  }

  private _onMusicIdle = () => {
    this._playing = false;
    this._paused = false;
    this._ducked = false;
    this.currentTrack = null;
  };

  private _onMusicError = (message: string) => {
    console.error(`[musicPlayer] subprocess error: ${message}`);
    this._playing = false;
    this._paused = false;
    this._ducked = false;
    this.currentTrack = null;
  };

  isPlaying(): boolean {
    return this._playing && !this._paused;
  }

  isPaused(): boolean {
    return this._paused;
  }

  getStatus(): MusicPlayerStatus {
    return {
      playing: this.isPlaying(),
      paused: this.isPaused(),
      currentTrack: this.currentTrack,
      position: 0
    };
  }

  async play(track: MusicSearchResult): Promise<MusicPlayerResult> {
    if (!this.subprocessClient?.isAlive) {
      return { ok: false, error: "no voice connection", track: null };
    }

    try {
      const streamUrl = this.getStreamUrl(track);
      if (!streamUrl) {
        return { ok: false, error: "could not resolve stream URL", track };
      }

      // Delegate to subprocess — it handles yt-dlp, ffmpeg, and AudioPlayer.
      // The subprocess calls resetPlayback() internally before starting.
      this.subprocessClient.musicPlay(streamUrl);
      this.currentTrack = track;
      this._playing = true;
      this._paused = false;

      console.log(`[musicPlayer] Now playing via subprocess: ${track.title} (${track.platform})`);
      return { ok: true, error: null, track };
    } catch (error) {
      return { ok: false, error: String((error as any)?.message || error), track };
    }
  }

  stop(): void {
    if (this.subprocessClient?.isAlive) {
      try {
        this.subprocessClient.musicStop();
      } catch {
        // ignore
      }
    }
    this._playing = false;
    this._paused = false;
    this._ducked = false;
    this.currentTrack = null;
  }

  pause(): void {
    if (this.subprocessClient?.isAlive) {
      try {
        this.subprocessClient.musicPause();
        this._paused = true;
      } catch {
        // ignore
      }
    }
  }

  resume(): void {
    if (this.subprocessClient?.isAlive) {
      try {
        this.subprocessClient.musicResume();
        this._paused = false;
      } catch {
        // ignore
      }
    }
  }

  async duck(fadeMs = 300): Promise<void> {
    if (!this.subprocessClient?.isAlive || !this._playing) return;
    this.subprocessClient.musicSetGain(0.15, fadeMs);
    this._ducked = true;
    await new Promise(resolve => setTimeout(resolve, fadeMs));
  }

  unduck(fadeMs = 300): void {
    if (!this.subprocessClient?.isAlive || !this._playing) return;
    this.subprocessClient.musicSetGain(1.0, fadeMs);
    this._ducked = false;
  }

  setGain(target: number, fadeMs = 0): void {
    if (!this.subprocessClient?.isAlive) return;
    this.subprocessClient.musicSetGain(target, fadeMs);
  }

  isDucked(): boolean {
    return this._ducked;
  }

  private getStreamUrl(track: MusicSearchResult): string | null {
    if (track.streamUrl) {
      return track.streamUrl;
    }

    if (track.platform === "youtube" && track.id.startsWith("youtube:")) {
      const videoId = track.id.replace("youtube:", "");
      return `https://www.youtube.com/watch?v=${videoId}`;
    }

    if (track.platform === "soundcloud") {
      return track.externalUrl;
    }

    return track.externalUrl;
  }
}

export function createDiscordMusicPlayer(): DiscordMusicPlayer {
  return new DiscordMusicPlayer();
}
