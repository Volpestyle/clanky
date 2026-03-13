/**
 * Stateless IPC proxy for music playback commands.
 *
 * The subprocess owns yt-dlp/ffmpeg pipelines and the AudioPlayer.
 * This class sends commands and resolves stream URLs — it does NOT
 * track playback state. All state lives on the session's
 * `VoiceSessionMusicState.phase` enum (single source of truth).
 *
 * Callers should query music state via `musicPhase*` helpers from
 * voiceSessionTypes.ts, not through this class.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { StreamWatchVisualizerMode } from "../settings/voiceDashboardMappings.ts";
import type { ClankvoxClient } from "./clankvoxClient.ts";
import type { MusicSearchResult } from "./musicSearch.ts";

const execFileAsync = promisify(execFile);

const STREAM_RESOLVE_TIMEOUT_MS = 15_000;
const STREAM_RESOLVE_CACHE_TTL_MS = 5 * 60_000;
const STREAM_RESOLVE_MAX_BUFFER_BYTES = 256 * 1024;

type StreamResolutionSource = "cache" | "track" | "yt_dlp" | "fallback";

type ResolvedPlaybackUrl = {
  url: string;
  resolvedDirectUrl: boolean;
  source: StreamResolutionSource;
};

type StreamUrlCacheEntry = {
  url: string;
  cachedAt: number;
  expiresAt: number;
};

type MusicPlayerStatus = {
  playing: boolean;
  paused: boolean;
  currentTrack: MusicSearchResult | null;
  position: number;
};

type MusicPlayerResult = {
  ok: boolean;
  error: string | null;
  track: MusicSearchResult | null;
  playbackUrl: string | null;
  resolvedDirectUrl: boolean;
};

export class DiscordMusicPlayer {
  private static readonly resolvedStreamUrlCache = new Map<string, StreamUrlCacheEntry>();
  private static readonly inFlightStreamResolutions = new Map<string, Promise<ResolvedPlaybackUrl | null>>();

  private voxClient: ClankvoxClient | null = null;
  private currentTrack: MusicSearchResult | null = null;

  constructor() {}

  /** Bind to the current session's subprocess client. */
  setVoxClient(client: ClankvoxClient | null): void {
    this.voxClient = client;
  }

  /** Get the current track metadata (not playback state). */
  getCurrentTrack(): MusicSearchResult | null {
    return this.currentTrack;
  }

  /** Clear track metadata (called on stop/idle/error). */
  clearCurrentTrack(): void {
    this.currentTrack = null;
  }

  async play(
    track: MusicSearchResult,
    options: {
      visualizerMode?: StreamWatchVisualizerMode | null;
    } = {}
  ): Promise<MusicPlayerResult> {
    if (!this.voxClient?.isAlive) {
      return {
        ok: false,
        error: "no voice connection",
        track: null,
        playbackUrl: null,
        resolvedDirectUrl: false
      };
    }

    try {
      const resolutionStartedAt = Date.now();
      const resolvedPlaybackUrl = await this.resolvePlaybackUrl(track);
      if (!resolvedPlaybackUrl?.url) {
        return {
          ok: false,
          error: "could not resolve stream URL",
          track,
          playbackUrl: null,
          resolvedDirectUrl: false
        };
      }

      // Delegate to subprocess — it handles yt-dlp, ffmpeg, and AudioPlayer.
      // The subprocess calls resetPlayback() internally before starting.
      this.voxClient.musicPlay(
        resolvedPlaybackUrl.url,
        resolvedPlaybackUrl.resolvedDirectUrl,
        options.visualizerMode
      );
      this.currentTrack = track;

      console.info(
        `[musicPlayer] queued subprocess playback title=${JSON.stringify(track.title)} platform=${track.platform} resolveMs=${Date.now() - resolutionStartedAt} source=${resolvedPlaybackUrl.source} direct=${resolvedPlaybackUrl.resolvedDirectUrl}`
      );
      return {
        ok: true,
        error: null,
        track,
        playbackUrl: resolvedPlaybackUrl.url,
        resolvedDirectUrl: resolvedPlaybackUrl.resolvedDirectUrl
      };
    } catch (error) {
      return {
        ok: false,
        error: getErrorMessage(error),
        track,
        playbackUrl: null,
        resolvedDirectUrl: false
      };
    }
  }

  stop(): void {
    if (this.voxClient?.isAlive) {
      try {
        this.voxClient.musicStop();
      } catch {
        // ignore
      }
    }
    this.currentTrack = null;
  }

  pause(): void {
    if (this.voxClient?.isAlive) {
      try {
        this.voxClient.musicPause();
      } catch {
        // ignore
      }
    }
  }

  resume(): void {
    if (this.voxClient?.isAlive) {
      try {
        this.voxClient.musicResume();
      } catch {
        // ignore
      }
    }
  }

  async duck(options: { targetGain?: number; fadeMs?: number } | number = 300): Promise<void> {
    if (!this.voxClient?.isAlive) return;
    const fadeMs =
      typeof options === "number"
        ? options
        : Number.isFinite(Number(options?.fadeMs))
          ? Number(options.fadeMs)
          : 300;
    const targetGain =
      typeof options === "number"
        ? 0.15
        : Number.isFinite(Number(options?.targetGain))
          ? Number(options.targetGain)
          : 0.15;
    this.voxClient.musicSetGain(targetGain, fadeMs);
    await new Promise(resolve => setTimeout(resolve, fadeMs));
  }

  unduck(options: { targetGain?: number; fadeMs?: number } | number = 300): void {
    if (!this.voxClient?.isAlive) return;
    const fadeMs =
      typeof options === "number"
        ? options
        : Number.isFinite(Number(options?.fadeMs))
          ? Number(options.fadeMs)
          : 300;
    const targetGain =
      typeof options === "number"
        ? 1.0
        : Number.isFinite(Number(options?.targetGain))
          ? Number(options.targetGain)
          : 1.0;
    this.voxClient.musicSetGain(targetGain, fadeMs);
  }

  setGain(target: number, fadeMs = 0): void {
    if (!this.voxClient?.isAlive) return;
    this.voxClient.musicSetGain(target, fadeMs);
  }

  private async resolvePlaybackUrl(track: MusicSearchResult): Promise<ResolvedPlaybackUrl | null> {
    const cacheKey = this.getStreamCacheKey(track);
    if (cacheKey) {
      const cached = DiscordMusicPlayer.resolvedStreamUrlCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return {
          url: cached.url,
          resolvedDirectUrl: true,
          source: "cache"
        };
      }
      DiscordMusicPlayer.resolvedStreamUrlCache.delete(cacheKey);

      const inFlight = DiscordMusicPlayer.inFlightStreamResolutions.get(cacheKey);
      if (inFlight) {
        return inFlight;
      }
    }

    const resolutionPromise = this.resolvePlaybackUrlUncached(track)
      .then((resolved) => {
        if (cacheKey && resolved?.resolvedDirectUrl) {
          DiscordMusicPlayer.resolvedStreamUrlCache.set(cacheKey, {
            url: resolved.url,
            cachedAt: Date.now(),
            expiresAt: Date.now() + STREAM_RESOLVE_CACHE_TTL_MS
          });
        }
        return resolved;
      })
      .finally(() => {
        if (cacheKey) {
          DiscordMusicPlayer.inFlightStreamResolutions.delete(cacheKey);
        }
      });

    if (cacheKey) {
      DiscordMusicPlayer.inFlightStreamResolutions.set(cacheKey, resolutionPromise);
    }

    return resolutionPromise;
  }

  private async resolvePlaybackUrlUncached(track: MusicSearchResult): Promise<ResolvedPlaybackUrl | null> {
    const knownDirectUrl = this.getKnownDirectStreamUrl(track);
    if (knownDirectUrl) {
      return {
        url: knownDirectUrl,
        resolvedDirectUrl: true,
        source: "track"
      };
    }

    const fallbackUrl = this.getFallbackPlaybackUrl(track);
    if (!fallbackUrl) {
      return null;
    }

    if (track.platform === "youtube" || track.platform === "soundcloud") {
      const directUrl = await this.resolveDirectStreamUrl(track, fallbackUrl);
      if (directUrl) {
        return {
          url: directUrl,
          resolvedDirectUrl: true,
          source: "yt_dlp"
        };
      }
    }

    return {
      url: fallbackUrl,
      resolvedDirectUrl: false,
      source: "fallback"
    };
  }

  private getStreamCacheKey(track: MusicSearchResult): string | null {
    const id = String(track.id || "").trim();
    if (id) return `${track.platform}:${id}`;
    const externalUrl = String(track.externalUrl || "").trim();
    if (externalUrl) return `${track.platform}:${externalUrl}`;
    return null;
  }

  private getKnownDirectStreamUrl(track: MusicSearchResult): string | null {
    if (track.streamUrl) {
      return track.streamUrl;
    }

    return null;
  }

  private getFallbackPlaybackUrl(track: MusicSearchResult): string | null {
    if (track.platform === "youtube" && track.id.startsWith("youtube:")) {
      const videoId = track.id.replace("youtube:", "");
      return `https://www.youtube.com/watch?v=${videoId}`;
    }

    if (track.platform === "soundcloud") {
      return track.externalUrl;
    }

    return track.externalUrl;
  }

  private async resolveDirectStreamUrl(track: MusicSearchResult, playbackUrl: string): Promise<string | null> {
    const args = this.getYtDlpArgs(track.platform, playbackUrl);
    const resolveStartedAt = Date.now();

    try {
      const { stdout } = await execFileAsync("yt-dlp", args, {
        timeout: STREAM_RESOLVE_TIMEOUT_MS,
        maxBuffer: STREAM_RESOLVE_MAX_BUFFER_BYTES,
        encoding: "utf8"
      });
      const resolvedUrl = String(stdout || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);

      if (!resolvedUrl) {
        console.warn(
          `[musicPlayer] yt-dlp returned no direct URL title=${JSON.stringify(track.title)} platform=${track.platform} resolveMs=${Date.now() - resolveStartedAt}`
        );
        return null;
      }

      console.info(
        `[musicPlayer] yt-dlp resolved direct stream title=${JSON.stringify(track.title)} platform=${track.platform} resolveMs=${Date.now() - resolveStartedAt}`
      );
      return resolvedUrl;
    } catch (error) {
      console.warn(
        `[musicPlayer] yt-dlp resolution failed title=${JSON.stringify(track.title)} platform=${track.platform} resolveMs=${Date.now() - resolveStartedAt} error=${JSON.stringify(getErrorMessage(error))}`
      );
      return null;
    }
  }

  private getYtDlpArgs(platform: MusicSearchResult["platform"], playbackUrl: string): string[] {
    const args = [
      "--no-warnings",
      "--quiet",
      "--no-playlist",
      "-f",
      "bestaudio/best",
      "-g"
    ];
    if (platform === "youtube") {
      args.push("--extractor-args", "youtube:player_client=android");
    }
    args.push(playbackUrl);
    return args;
  }
}

export function createDiscordMusicPlayer(): DiscordMusicPlayer {
  return new DiscordMusicPlayer();
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (error && typeof error === "object" && "message" in error) {
    const message = error.message;
    if (typeof message === "string" && message.trim()) {
      return message;
    }
  }
  return String(error);
}
