import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeDiscoveryUrl } from "../services/discovery.ts";
import { assertPublicUrl } from "../services/urlSafety.ts";
import { clamp } from "../utils.ts";
import { sleep } from "../normalization/time.ts";
import {
  dedupeTargets,
  extractTikTokIdFromUrl,
  extractUrls,
  isLikelyDirectVideoUrl,
  parseAttachmentTarget,
  parseEmbedTargets,
  parseVideoTarget,
  type VideoTarget
} from "./videoTargets.ts";
import {
  type ErrorWithAttempts,
  getRetryDelayMs,
  isRetryableFetchError,
  isRedirectStatus,
  shouldRetryHttpStatus,
  withAttemptCount
} from "../retry.ts";

// HTTP fetch and redirect retry limits for metadata/context requests.
const REQUEST_TIMEOUT_MS = 5_500;
const MAX_FETCH_ATTEMPTS = 3;
const MAX_FETCH_REDIRECTS = 5;
const CACHE_TTL_MS = 30 * 60 * 1000;

// External tool execution timeouts and log-capture bounds.
const YT_DLP_TIMEOUT_MS = 50_000;
const FFMPEG_TIMEOUT_MS = 45_000;
const FFPROBE_TIMEOUT_MS = 8_000;
const MAX_COMMAND_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_LOG_CONTENT_CHARS = 2000;

// Public API clamps for transcript/keyframe/ASR request parameters.
const DEFAULT_MAX_TRANSCRIPT_CHARS = 1200;
const MIN_MAX_TRANSCRIPT_CHARS = 200;
const MAX_MAX_TRANSCRIPT_CHARS = 4000;
const DEFAULT_KEYFRAME_INTERVAL_SECONDS = 0;
const MAX_KEYFRAME_INTERVAL_SECONDS = 120;
// Floor for adaptive sampling on very short clips: ~15 fps is dense enough to
// catch any meaningful motion in a sub-second loop without flooding the model.
const MIN_EFFECTIVE_KEYFRAME_INTERVAL_SECONDS = 1 / 15;
const DEFAULT_MAX_ASR_SECONDS = 120;
const MIN_MAX_ASR_SECONDS = 15;
const MAX_MAX_ASR_SECONDS = 600;

// Availability probing cache for yt-dlp/ffmpeg presence checks.
const COMMAND_AVAILABILITY_CACHE_TTL_MS = 5 * 60 * 1000;
const COMMAND_PROBE_TIMEOUT_MS = 10_000;

// ASR/transcript formatting limits used in extracted context payloads.
const ASR_AUDIO_SAMPLE_RATE_HZ = "16000";
const TEXT_SANITIZE_VIDEO_ID_MAX_CHARS = 80;
const TEXT_SANITIZE_TITLE_MAX_CHARS = 180;
const TEXT_SANITIZE_CHANNEL_MAX_CHARS = 120;
const TEXT_SANITIZE_DESCRIPTION_MAX_CHARS = 360;
const COMMAND_ERROR_MESSAGE_MAX_CHARS = 400;

// Explicit UA so upstream providers can identify this integration.
const VIDEO_USER_AGENT =
  "clanky/0.2 (+video-context; https://github.com/Volpestyle/clanky)";

type VideoTrace = {
  guildId?: string | null;
  channelId?: string | null;
  userId?: string | null;
  source?: string;
};

type VideoContextDependencyName = "ffmpeg" | "yt-dlp";
type VideoContextDependencyCode = "missing_ffmpeg" | "missing_yt_dlp";
type VideoContextDependencyFailure = {
  dependency: VideoContextDependencyName;
  code: VideoContextDependencyCode;
};

class VideoContextDependencyError extends Error {
  readonly dependency: VideoContextDependencyName;
  readonly code: VideoContextDependencyCode;

  constructor({ dependency, detail }: { dependency: VideoContextDependencyName; detail: string }) {
    super(
      `Local runtime dependency missing: ${dependency} is required to ${detail}. ` +
      `Install ${dependency} and restart the bot.`
    );
    this.name = "VideoContextDependencyError";
    this.dependency = dependency;
    this.code = dependency === "ffmpeg" ? "missing_ffmpeg" : "missing_yt_dlp";
  }
}

export class VideoContextService {
  store;
  llm;
  cache;
  toolAvailabilityPromise;
  toolAvailabilityCheckedAt;

  constructor({ store, llm }) {
    this.store = store;
    this.llm = llm;
    this.cache = new Map();
    this.toolAvailabilityPromise = null;
    this.toolAvailabilityCheckedAt = 0;
  }

  logCleanupError(scope: string, error: unknown, metadata: Record<string, unknown> | null = null) {
    const detail = error instanceof Error ? error.message : String(error);
    try {
        this.store.logAction({
          kind: "video_context_error",
          content: `${scope}: ${detail}`.slice(0, MAX_LOG_CONTENT_CHARS),
          metadata
        });
    } catch {
      console.warn(`[VideoContextService] ${scope}:`, error);
    }
  }

  extractVideoTargets(text, limit = 2) {
    const urls = extractUrls(String(text || ""));
    const maxTargets = clamp(Number(limit) || 2, 0, 8);
    const targets = [];
    const seen = new Set();

    for (const rawUrl of urls) {
      if (targets.length >= maxTargets) break;
      const target = parseVideoTarget(rawUrl, { source: "message_url" });
      if (!target || seen.has(target.key)) continue;
      seen.add(target.key);
      targets.push(target);
    }

    return targets;
  }

  extractMessageTargets(message, limit = 2) {
    const maxTargets = clamp(Number(limit) || 2, 0, 8);
    const candidates = [];
    const text = String(message?.content || "");
    if (text) {
      candidates.push(...this.extractVideoTargets(text, maxTargets));
    }

    if (message?.attachments?.size) {
      for (const attachment of message.attachments.values()) {
        if (candidates.length >= maxTargets) break;
        const target = parseAttachmentTarget(attachment);
        if (!target) continue;
        candidates.push(target);
      }
    }

    if (Array.isArray(message?.embeds) && message.embeds.length) {
      for (const embed of message.embeds) {
        if (candidates.length >= maxTargets) break;
        const embedTargets = parseEmbedTargets(embed);
        for (const target of embedTargets) {
          if (candidates.length >= maxTargets) break;
          candidates.push(target);
        }
      }
    }

    return dedupeTargets(candidates, maxTargets);
  }

  async fetchContexts({
    targets,
    maxTranscriptChars = DEFAULT_MAX_TRANSCRIPT_CHARS,
    keyframeIntervalSeconds = DEFAULT_KEYFRAME_INTERVAL_SECONDS,
    maxKeyframesPerVideo = 0,
    allowAsrFallback = false,
    maxAsrSeconds = DEFAULT_MAX_ASR_SECONDS,
    trace = {}
  }: {
    targets: VideoTarget[];
    maxTranscriptChars?: number;
    keyframeIntervalSeconds?: number;
    maxKeyframesPerVideo?: number;
    allowAsrFallback?: boolean;
    maxAsrSeconds?: number;
    trace?: VideoTrace;
  }) {
    const list = Array.isArray(targets) ? targets : [];
    const transcriptLimit = clamp(
      Number(maxTranscriptChars) || DEFAULT_MAX_TRANSCRIPT_CHARS,
      MIN_MAX_TRANSCRIPT_CHARS,
      MAX_MAX_TRANSCRIPT_CHARS
    );
    const keyframeInterval = clamp(
      Number(keyframeIntervalSeconds) || DEFAULT_KEYFRAME_INTERVAL_SECONDS,
      DEFAULT_KEYFRAME_INTERVAL_SECONDS,
      MAX_KEYFRAME_INTERVAL_SECONDS
    );
    const keyframeCount = clamp(Number(maxKeyframesPerVideo) || 0, 0, 8);
    const asrSeconds = clamp(
      Number(maxAsrSeconds) || DEFAULT_MAX_ASR_SECONDS,
      MIN_MAX_ASR_SECONDS,
      MAX_MAX_ASR_SECONDS
    );
    const asrEnabled = Boolean(allowAsrFallback);
    const videos = [];
    const errors = [];

    for (const target of list) {
      try {
        const context = await this.fetchVideoContext({
          target,
          maxTranscriptChars: transcriptLimit,
          keyframeIntervalSeconds: keyframeInterval,
          maxKeyframesPerVideo: keyframeCount,
          allowAsrFallback: asrEnabled,
          maxAsrSeconds: asrSeconds,
          trace
        });
        videos.push(context);
        this.store.logAction({
          kind: "video_context_call",
          guildId: trace.guildId,
          channelId: trace.channelId,
          userId: trace.userId,
          content: String(context.videoId || context.url || target.key || "").slice(0, MAX_LOG_CONTENT_CHARS),
          metadata: {
            source: trace.source || "unknown",
            provider: context.provider,
            kind: context.kind,
            videoId: context.videoId,
            url: context.url,
            title: context.title,
            channel: context.channel,
            hasTranscript: Boolean(context.transcript),
            transcriptSource: context.transcriptSource || null,
            transcriptChars: context.transcript ? context.transcript.length : 0,
            transcriptError: context.transcriptError || null,
            keyframeCount: Number(context.keyframeCount || 0),
            keyframeError: context.keyframeError || null,
            keyframeErrorCode: context.keyframeErrorCode || null,
            transcriptErrorCode: context.transcriptErrorCode || null,
            missingDependencies: Array.isArray(context.missingDependencies) ? context.missingDependencies : [],
            cacheHit: Boolean(context.cacheHit)
          }
        });
      } catch (error) {
        const message = String(error?.message || error);
        const dependencyFailure = getDependencyFailure(error);
        errors.push({
          key: target.key,
          url: target.url,
          error: message,
          errorCode: dependencyFailure?.code || null,
          missingDependency: dependencyFailure?.dependency || null
        });
        this.store.logAction({
          kind: "video_context_error",
          guildId: trace.guildId,
          channelId: trace.channelId,
          userId: trace.userId,
          content: `${target.key}: ${message}`.slice(0, MAX_LOG_CONTENT_CHARS),
          metadata: {
            source: trace.source || "unknown",
            kind: target.kind,
            key: target.key,
            url: target.url,
            errorCode: dependencyFailure?.code || null,
            missingDependency: dependencyFailure?.dependency || null,
            attempts: Number(error?.attempts || 1)
          }
        });
      }
    }

    return {
      videos,
      errors
    };
  }

  async fetchVideoContext({
    target,
    maxTranscriptChars,
    keyframeIntervalSeconds,
    maxKeyframesPerVideo,
    allowAsrFallback,
    maxAsrSeconds,
    trace = {}
  }: {
    target: VideoTarget;
    maxTranscriptChars: number;
    keyframeIntervalSeconds: number;
    maxKeyframesPerVideo: number;
    allowAsrFallback: boolean;
    maxAsrSeconds: number;
    trace?: VideoTrace;
  }) {
    this.pruneCache();
    const cached = this.cache.get(target.key);
    const hasFreshCache = cached && Date.now() - cached.cachedAt < CACHE_TTL_MS;
    let base = null;
    if (hasFreshCache) {
      base = {
        ...cached.value,
        cacheHit: true
      };
    } else {
      const fetched = await this.fetchBaseSummary({
        target,
        maxTranscriptChars
      });
      base = {
        ...fetched,
        cacheHit: false
      };
      this.cache.set(target.key, {
        cachedAt: Date.now(),
        value: {
          ...fetched,
          cacheHit: false
        }
      });
    }

    const needKeyframes = Number(keyframeIntervalSeconds) > 0 && Number(maxKeyframesPerVideo) > 0;
    const shouldAsr = Boolean(allowAsrFallback) && !String(base.transcript || "").trim();
    const context = {
      ...base,
      keyframeCount: 0,
      keyframeError: null,
      keyframeErrorCode: null,
      transcriptErrorCode: null,
      missingDependencies: [] as VideoContextDependencyName[],
      frameImages: []
    };
    if (!needKeyframes && !shouldAsr) return context;

    let media = null;
    let mediaError = null;
    let mediaFailure: unknown = null;
    try {
      media = await this.resolveMediaInput(target.url, target.forceDirect);
    } catch (error) {
      mediaFailure = error;
      mediaError = String(error?.message || error);
    }

    if (mediaError) {
      const dependencyFailure = getDependencyFailure(mediaFailure || mediaError);
      if (needKeyframes) {
        context.keyframeError = mediaError;
        if (dependencyFailure) {
          context.keyframeErrorCode = dependencyFailure.code;
          addMissingDependency(context, dependencyFailure.dependency);
        }
      }
      if (shouldAsr && !context.transcriptError) {
        context.transcriptError = mediaError;
        if (dependencyFailure) {
          context.transcriptErrorCode = dependencyFailure.code;
          addMissingDependency(context, dependencyFailure.dependency);
        }
      }
      return context;
    }

    try {
      if (needKeyframes && media) {
        try {
          const { frames, durationSeconds: probedDurationSeconds } = await this.extractKeyframesFromInput({
            input: media.input,
            keyframeIntervalSeconds,
            maxKeyframesPerVideo
          });
          context.frameImages = frames;
          context.keyframeCount = frames.length;
          // Direct/Tenor sources don't surface duration through their summary
          // path; fill it in from the ffprobe sidecar so downstream logs and
          // the model prompt stop reporting `durationSeconds: null`.
          if (
            (context.durationSeconds == null || !Number.isFinite(Number(context.durationSeconds)) || Number(context.durationSeconds) <= 0) &&
            probedDurationSeconds != null
          ) {
            context.durationSeconds = probedDurationSeconds;
          }
        } catch (error) {
          context.keyframeError = String(error?.message || error);
          const dependencyFailure = getDependencyFailure(error);
          if (dependencyFailure) {
            context.keyframeErrorCode = dependencyFailure.code;
            addMissingDependency(context, dependencyFailure.dependency);
          }
        }
      }

      if (shouldAsr && media) {
        try {
          const transcript = await this.transcribeFromInput({
            input: media.input,
            maxAsrSeconds,
            maxTranscriptChars,
            trace
          });
          if (transcript) {
            context.transcript = transcript;
            context.transcriptSource = "asr";
            context.transcriptError = null;
          }
        } catch (error) {
          if (!context.transcriptError) {
            context.transcriptError = String(error?.message || error);
          }
          const dependencyFailure = getDependencyFailure(error);
          if (dependencyFailure) {
            context.transcriptErrorCode = dependencyFailure.code;
            addMissingDependency(context, dependencyFailure.dependency);
          }
        }
      }
    } finally {
      if (media?.cleanup) {
        try {
          await media.cleanup();
        } catch (error) {
          this.logCleanupError("video_media_cleanup_failed", error, {
            source: trace.source || "unknown",
            key: target.key,
            url: target.url
          });
        }
      }
    }

    return context;
  }

  pruneCache() {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (!entry || now - entry.cachedAt >= CACHE_TTL_MS) {
        this.cache.delete(key);
      }
    }
  }

  async fetchBaseSummary({ target, maxTranscriptChars }) {
    if (target.kind === "youtube" && target.videoId) {
      return this.fetchYouTubeSummary({
        videoId: target.videoId,
        sourceUrl: target.url,
        maxTranscriptChars
      });
    }

    if (target.kind !== "direct" && (await this.hasYtDlp())) {
      try {
        return await this.fetchYtDlpSummary({ target, maxTranscriptChars });
      } catch {
        // Fall through to provider-specific fallback.
      }
    }

    if (target.kind === "tiktok") {
      return this.fetchTikTokSummary(target.url);
    }

    return this.fetchGenericSummary(target);
  }

  async fetchYouTubeSummary({ videoId, sourceUrl, maxTranscriptChars }) {
    const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
    const html = await fetchTextWithRetry({
      url: `${watchUrl}&hl=en`,
      accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.2"
    });
    const playerResponse = extractPlayerResponse(html);
    if (!playerResponse) {
      throw new Error("YouTube page did not expose playable metadata.");
    }

    const summary = summarizeYouTubeVideo({
      videoId,
      url: sourceUrl || watchUrl,
      playerResponse
    });
    let transcript = "";
    let transcriptError = null;
    try {
      transcript = await fetchYouTubeTranscriptText({
        playerResponse,
        maxTranscriptChars
      });
    } catch (error) {
      transcriptError = String(error?.message || error);
    }

    return {
      ...summary,
      provider: "youtube",
      kind: "youtube",
      transcript,
      transcriptSource: transcript ? "captions" : "",
      transcriptError
    };
  }

  async fetchYtDlpSummary({ target, maxTranscriptChars }) {
    const info = await this.fetchYtDlpInfo(target.url);
    const transcriptResult = await this.fetchTranscriptFromYtDlpInfo(info, maxTranscriptChars).catch((error) => ({
      text: "",
      source: "",
      error: String(error?.message || error)
    }));
    const provider = target.kind === "tiktok" ? "tiktok" : "generic";
    const fallbackHost = safeHostFromUrl(target.url);

    return {
      provider,
      kind: target.kind,
      videoId: sanitizeText(String(info?.id || target.videoId || ""), TEXT_SANITIZE_VIDEO_ID_MAX_CHARS) || null,
      url: normalizeDiscoveryUrl(info?.webpage_url || info?.original_url || target.url) || target.url,
      title: sanitizeText(info?.title || "", TEXT_SANITIZE_TITLE_MAX_CHARS) || "untitled video",
      channel:
        sanitizeText(
          info?.uploader || info?.channel || info?.creator || info?.channel_url || fallbackHost || "",
          TEXT_SANITIZE_CHANNEL_MAX_CHARS
        ) || "unknown channel",
      publishedAt: normalizeYtDlpDate(info?.upload_date) || normalizeDateIso(info?.release_timestamp),
      durationSeconds: safeNumber(info?.duration),
      viewCount: safeNumber(info?.view_count),
      description: sanitizeText(info?.description || "", TEXT_SANITIZE_DESCRIPTION_MAX_CHARS),
      transcript: transcriptResult.text || "",
      transcriptSource: transcriptResult.source || "",
      transcriptError: transcriptResult.error || null
    };
  }

  async fetchYtDlpInfo(url) {
    if (!(await this.hasYtDlp())) {
      throw new VideoContextDependencyError({
        dependency: "yt-dlp",
        detail: "extract metadata from yt-dlp-supported video pages"
      });
    }
    const { stdout } = await runCommand({
      command: "yt-dlp",
      args: [
        "--no-warnings",
        "--quiet",
        "--skip-download",
        "--no-playlist",
        "--dump-single-json",
        String(url)
      ],
      timeoutMs: YT_DLP_TIMEOUT_MS
    });

    const output = String(stdout || "").trim();
    if (!output) {
      throw new Error("yt-dlp returned empty metadata.");
    }

    try {
      return JSON.parse(output);
    } catch {
      const lastLine = output.split(/\r?\n/).filter(Boolean).at(-1) || "";
      try {
        return JSON.parse(lastLine);
      } catch {
        throw new Error("yt-dlp metadata JSON parse failed.");
      }
    }
  }

  async fetchTranscriptFromYtDlpInfo(info, maxTranscriptChars) {
    const subtitles = info?.subtitles && typeof info.subtitles === "object" ? info.subtitles : {};
    const autoCaptions =
      info?.automatic_captions && typeof info.automatic_captions === "object" ? info.automatic_captions : {};
    const preferred =
      pickSubtitleTrack(subtitles, { preferManual: true }) || pickSubtitleTrack(autoCaptions, { preferManual: false });
    if (!preferred?.url) {
      return { text: "", source: "", error: null };
    }

    const raw = await fetchTextWithRetry({
      url: preferred.url,
      accept: "application/xml,text/xml,text/vtt,text/plain;q=0.9,*/*;q=0.2"
    });
    const text = parseSubtitleText(raw, maxTranscriptChars);
    return {
      text,
      source: text ? "captions" : "",
      error: null
    };
  }

  async fetchTikTokSummary(url) {
    const oembedUrl = `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`;
    let data = null;
    try {
      const raw = await fetchTextWithRetry({
        url: oembedUrl,
        accept: "application/json,text/plain;q=0.9,*/*;q=0.2"
      });
      data = JSON.parse(raw);
    } catch {
      // Fall through to generic summary.
    }

    const host = safeHostFromUrl(url);
    return {
      provider: "tiktok",
      kind: "tiktok",
      videoId: sanitizeText(extractTikTokIdFromUrl(url) || "", TEXT_SANITIZE_VIDEO_ID_MAX_CHARS) || null,
      url,
      title: sanitizeText(data?.title || "", TEXT_SANITIZE_TITLE_MAX_CHARS) || "TikTok video",
      channel: sanitizeText(data?.author_name || host || "", TEXT_SANITIZE_CHANNEL_MAX_CHARS) || "unknown channel",
      publishedAt: null,
      durationSeconds: null,
      viewCount: null,
      description: sanitizeText(data?.title || "", TEXT_SANITIZE_DESCRIPTION_MAX_CHARS),
      transcript: "",
      transcriptSource: "",
      transcriptError: null
    };
  }

  async fetchGenericSummary(target) {
    const host = safeHostFromUrl(target.url);
    let title = "";
    let description = "";
    let publishedAt = null;
    if (target.kind === "generic") {
      try {
        const html = await fetchTextWithRetry({
          url: target.url,
          accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.2"
        });
        title =
          sanitizeText(
            readMetaTag(html, "og:title") || readMetaTag(html, "twitter:title") || readHtmlTitle(html) || "",
            TEXT_SANITIZE_TITLE_MAX_CHARS
          ) || "";
        description = sanitizeText(
          readMetaTag(html, "og:description") || readMetaTag(html, "twitter:description") || "",
          TEXT_SANITIZE_DESCRIPTION_MAX_CHARS
        );
        publishedAt =
          normalizeDateIso(readMetaTag(html, "article:published_time")) ||
          normalizeDateIso(readMetaTag(html, "og:pubdate"));
      } catch {
        // Keep host fallback.
      }
    }

    return {
      provider: target.kind === "direct" ? "direct" : "generic",
      kind: target.kind,
      videoId: null,
      url: target.url,
      title: title || `${host || "linked"} video`,
      channel: host || "unknown source",
      publishedAt,
      durationSeconds: null,
      viewCount: null,
      description,
      transcript: "",
      transcriptSource: "",
      transcriptError: null
    };
  }

  async resolveMediaInput(url, forceDirect = false) {
    if (forceDirect || isLikelyDirectVideoUrl(url)) {
      return {
        input: url,
        cleanup: null
      };
    }

    if (!(await this.hasYtDlp())) {
      throw new VideoContextDependencyError({
        dependency: "yt-dlp",
        detail: "download hosted video/GIF pages before frame extraction"
      });
    }

    return this.downloadMediaWithYtDlp(url);
  }

  async downloadMediaWithYtDlp(url) {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clanker-video-"));
    const outputPattern = path.join(tempDir, "source.%(ext)s");
    try {
      await runCommand({
        command: "yt-dlp",
        args: [
          "--no-warnings",
          "--quiet",
          "--no-playlist",
          "--socket-timeout",
          "8",
          "--retries",
          "2",
          "--max-filesize",
          "80M",
          "-f",
          "b",
          "-o",
          outputPattern,
          String(url)
        ],
        timeoutMs: YT_DLP_TIMEOUT_MS
      });

      const rows = await fs.readdir(tempDir);
      const files = [];
      for (const entry of rows) {
        const full = path.join(tempDir, entry);
        const stat = await fs.stat(full).catch(() => null);
        if (!stat || !stat.isFile()) continue;
        files.push({ full, size: stat.size });
      }
      if (!files.length) {
        throw new Error("yt-dlp produced no downloadable media file.");
      }

      files.sort((a, b) => b.size - a.size);
      const mediaPath = files[0].full;
      return {
        input: mediaPath,
        cleanup: async () => {
          await fs.rm(tempDir, { recursive: true, force: true });
        }
      };
    } catch (error) {
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch (cleanupError) {
        this.logCleanupError("video_download_tempdir_cleanup_failed", cleanupError, {
          url,
          tempDir
        });
      }
      throw error;
    }
  }

  async probeMediaDuration(input: string): Promise<number | null> {
    try {
      const { stdout } = await runCommand({
        command: "ffprobe",
        args: [
          "-v",
          "error",
          "-show_entries",
          "format=duration",
          "-of",
          "default=noprint_wrappers=1:nokey=1",
          String(input)
        ],
        timeoutMs: FFPROBE_TIMEOUT_MS
      });
      const value = Number(String(stdout || "").trim());
      return Number.isFinite(value) && value > 0 ? value : null;
    } catch (error) {
      console.warn(
        `[VideoContextService] ffprobe_duration_failed  input=${String(input).slice(0, 120)}  error=${error instanceof Error ? error.message : String(error)}`
      );
      return null;
    }
  }

  async extractKeyframesFromInput({ input, keyframeIntervalSeconds, maxKeyframesPerVideo }) {
    if (!(await this.hasFfmpeg())) {
      throw new VideoContextDependencyError({
        dependency: "ffmpeg",
        detail: "sample frames from GIF/video media"
      });
    }

    const configuredInterval = clamp(
      Number(keyframeIntervalSeconds) || DEFAULT_KEYFRAME_INTERVAL_SECONDS,
      1,
      MAX_KEYFRAME_INTERVAL_SECONDS
    );
    const maxFrames = clamp(Number(maxKeyframesPerVideo) || 0, 1, 8);
    // Looping GIFs and other short clips are sub-second; fixed `fps=1/1`
    // sampling collapses to a single frame and the maxFrames cap never bites.
    // Probe duration first so we can compress the interval into the clip's
    // actual length when needed.
    const probedDurationSeconds = await this.probeMediaDuration(String(input));
    const effectiveInterval = computeEffectiveKeyframeInterval(
      configuredInterval,
      maxFrames,
      probedDurationSeconds
    );
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clanker-frames-"));
    const outputPattern = path.join(tempDir, "frame-%03d.jpg");

    try {
      const ffmpegStartedAt = Date.now();
      const ffmpegArgs = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        String(input),
        "-vf",
        `fps=1/${effectiveInterval}`,
        "-frames:v",
        String(maxFrames),
        "-q:v",
        "5",
        outputPattern
      ];
      await runCommand({
        command: "ffmpeg",
        args: ffmpegArgs,
        timeoutMs: FFMPEG_TIMEOUT_MS
      });
      const ffmpegDurationMs = Date.now() - ffmpegStartedAt;

      const rows = await fs.readdir(tempDir);
      const frameFiles = rows.filter((name) => name.toLowerCase().endsWith(".jpg")).sort();
      const images = [];
      const frameSizes: number[] = [];
      for (const frame of frameFiles) {
        const fullPath = path.join(tempDir, frame);
        const stat = await fs.stat(fullPath);
        const dataBase64 = await fs.readFile(fullPath, { encoding: "base64" });
        if (!dataBase64) continue;
        frameSizes.push(stat.size);
        images.push({
          filename: frame,
          contentType: "image/jpeg",
          mediaType: "image/jpeg",
          dataBase64,
          source: "video_keyframe"
        });
      }
      const totalBytes = frameSizes.reduce((a, b) => a + b, 0);
      console.log(
        `[VideoContextService] keyframe_extraction_complete` +
        `  input=${String(input).slice(0, 120)}` +
        `  configuredIntervalSeconds=${configuredInterval}` +
        `  effectiveIntervalSeconds=${effectiveInterval}` +
        `  probedDurationSeconds=${probedDurationSeconds ?? "null"}` +
        `  maxFrames=${maxFrames}` +
        `  extractedFrames=${images.length}` +
        `  frameSizesBytes=[${frameSizes.join(",")}]` +
        `  totalBytes=${totalBytes}` +
        `  ffmpegDurationMs=${ffmpegDurationMs}`
      );
      return { frames: images, durationSeconds: probedDurationSeconds };
    } finally {
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch (error) {
        this.logCleanupError("video_keyframe_tempdir_cleanup_failed", error, {
          input,
          tempDir
        });
      }
    }
  }

  async transcribeFromInput({
    input,
    maxAsrSeconds,
    maxTranscriptChars,
    trace = {}
  }: {
    input: string;
    maxAsrSeconds: number;
    maxTranscriptChars: number;
    trace?: VideoTrace;
  }) {
    if (!(await this.hasFfmpeg())) {
      throw new VideoContextDependencyError({
        dependency: "ffmpeg",
        detail: "extract audio for ASR fallback"
      });
    }
    if (!this.llm?.isAsrReady?.()) {
      throw new Error("ASR fallback requires OPENAI_API_KEY.");
    }

    const segmentSeconds = clamp(
      Number(maxAsrSeconds) || DEFAULT_MAX_ASR_SECONDS,
      MIN_MAX_ASR_SECONDS,
      MAX_MAX_ASR_SECONDS
    );
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clanker-audio-"));
    const audioPath = path.join(tempDir, "audio.wav");

    try {
      await runCommand({
        command: "ffmpeg",
        args: [
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-i",
          String(input),
          "-vn",
          "-ac",
          "1",
          "-ar",
          ASR_AUDIO_SAMPLE_RATE_HZ,
          "-t",
          String(segmentSeconds),
          audioPath
        ],
        timeoutMs: FFMPEG_TIMEOUT_MS
      });

      const transcript = await this.llm.transcribeAudio({
        filePath: audioPath,
        trace: {
          ...trace,
          source: trace.source || "video_context_asr"
        }
      });
      return sanitizeText(transcript, maxTranscriptChars);
    } finally {
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch (error) {
        this.logCleanupError("video_asr_tempdir_cleanup_failed", error, {
          input,
          tempDir,
          source: trace.source || "video_context_asr"
        });
      }
    }
  }

  async getToolAvailability() {
    const now = Date.now();
    if (this.toolAvailabilityPromise && now - this.toolAvailabilityCheckedAt < COMMAND_AVAILABILITY_CACHE_TTL_MS) {
      return this.toolAvailabilityPromise;
    }
    this.toolAvailabilityCheckedAt = now;
    this.toolAvailabilityPromise = Promise.all([
      this.commandAvailable("ffmpeg", ["-version"]),
      this.commandAvailable("yt-dlp", ["--version"])
    ])
      .then(([ffmpeg, ytDlp]) => {
        console.log(`[VideoContextService] tool_availability  ffmpeg=${ffmpeg}  ytDlp=${ytDlp}`);
        const missingDependencies: VideoContextDependencyName[] = [];
        if (!ffmpeg) missingDependencies.push("ffmpeg");
        if (!ytDlp) missingDependencies.push("yt-dlp");
        if (missingDependencies.length) {
          try {
            this.store.logAction({
              kind: "runtime",
              content: "video_context_dependency_status",
              metadata: {
                ffmpegAvailable: ffmpeg,
                ytDlpAvailable: ytDlp,
                missingDependencies
              }
            });
          } catch {
            // Console availability already logged above; never fail media handling on diagnostics.
          }
        }
        return { ffmpeg, ytDlp };
      })
      .catch((error) => {
        this.toolAvailabilityPromise = null;
        this.toolAvailabilityCheckedAt = 0;
        this.logCleanupError("video_context_tool_availability_failed", error);
        return { ffmpeg: false, ytDlp: false };
      });
    return this.toolAvailabilityPromise;
  }

  async hasFfmpeg() {
    const tools = await this.getToolAvailability();
    return Boolean(tools.ffmpeg);
  }

  async hasYtDlp() {
    const tools = await this.getToolAvailability();
    return Boolean(tools.ytDlp);
  }

  async commandAvailable(command, args = ["--version"]) {
    try {
      await runCommand({
        command,
        args,
        timeoutMs: COMMAND_PROBE_TIMEOUT_MS,
        useShell: true
      });
      return true;
    } catch (error) {
      console.warn(`[VideoContextService] command_not_available  command=${command}  error=${error?.message || error}`);
      return false;
    }
  }
}

// Pick a sampling interval that still yields up to `maxFrames` evenly-spaced
// keyframes when the clip is shorter than `configuredInterval × maxFrames`.
// Returns the configured interval unchanged when duration is unknown or long
// enough that fixed-interval sampling already produces the requested count.
export function computeEffectiveKeyframeInterval(
  configuredInterval: number,
  maxFrames: number,
  durationSeconds: number | null | undefined
): number {
  const interval = Number(configuredInterval);
  const frames = Number(maxFrames);
  if (!Number.isFinite(interval) || interval <= 0 || !Number.isFinite(frames) || frames <= 0) {
    return interval;
  }
  if (
    durationSeconds == null ||
    !Number.isFinite(Number(durationSeconds)) ||
    Number(durationSeconds) <= 0 ||
    Number(durationSeconds) >= interval * frames
  ) {
    return interval;
  }
  return Math.max(Number(durationSeconds) / frames, MIN_EFFECTIVE_KEYFRAME_INTERVAL_SECONDS);
}

function getDependencyFailure(error: unknown): VideoContextDependencyFailure | null {
  if (error instanceof VideoContextDependencyError) {
    return {
      dependency: error.dependency,
      code: error.code
    };
  }

  const message = String(error instanceof Error ? error.message : error || "");
  if (!message) return null;
  const lower = message.toLowerCase();
  const isDependencyMessage =
    lower.includes("local runtime dependency missing") ||
    lower.includes("not installed") ||
    lower.includes("is required");
  if (!isDependencyMessage) return null;
  if (lower.includes("ffmpeg")) {
    return {
      dependency: "ffmpeg",
      code: "missing_ffmpeg"
    };
  }
  if (lower.includes("yt-dlp")) {
    return {
      dependency: "yt-dlp",
      code: "missing_yt_dlp"
    };
  }
  return null;
}

function addMissingDependency(
  context: { missingDependencies?: VideoContextDependencyName[] },
  dependency: VideoContextDependencyName
) {
  const dependencies = Array.isArray(context.missingDependencies) ? context.missingDependencies : [];
  if (!dependencies.includes(dependency)) dependencies.push(dependency);
  context.missingDependencies = dependencies;
}

function summarizeYouTubeVideo({ videoId, url, playerResponse }) {
  const details = playerResponse?.videoDetails || {};
  const micro = playerResponse?.microformat?.playerMicroformatRenderer || {};

  const title =
    sanitizeText(details?.title || micro?.title?.simpleText || micro?.title || "", TEXT_SANITIZE_TITLE_MAX_CHARS) || "untitled video";
  const channel =
    sanitizeText(details?.author || micro?.ownerChannelName || micro?.ownerChannel || "", TEXT_SANITIZE_CHANNEL_MAX_CHARS) || "unknown channel";
  const description = sanitizeText(details?.shortDescription || micro?.description?.simpleText || "", TEXT_SANITIZE_DESCRIPTION_MAX_CHARS);
  const publishedAt = normalizeDateIso(micro?.publishDate || micro?.uploadDate || "");
  const durationSeconds = safeNumber(details?.lengthSeconds);
  const viewCount = safeNumber(details?.viewCount);

  return {
    videoId,
    url: String(url || `https://www.youtube.com/watch?v=${videoId}`),
    title,
    channel,
    publishedAt,
    durationSeconds,
    viewCount,
    description
  };
}

async function fetchYouTubeTranscriptText({ playerResponse, maxTranscriptChars }) {
  const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!Array.isArray(tracks) || !tracks.length) return "";

  const preferred =
    tracks.find((track) => /^en(?:-|$)/i.test(String(track?.languageCode || "")) && track?.kind !== "asr") ||
    tracks.find((track) => /^en(?:-|$)/i.test(String(track?.languageCode || ""))) ||
    tracks.find((track) => track?.kind !== "asr") ||
    tracks[0];
  const baseUrl = String(preferred?.baseUrl || "").trim();
  if (!baseUrl) return "";

  const transcriptUrl = new URL(baseUrl);
  transcriptUrl.searchParams.set("fmt", "srv3");
  transcriptUrl.searchParams.set("xorb", "2");
  transcriptUrl.searchParams.set("hl", "en");

  const raw = await fetchTextWithRetry({
    url: transcriptUrl.toString(),
    accept: "application/xml,text/xml,text/plain;q=0.9,*/*;q=0.2"
  });
  return parseSubtitleText(raw, maxTranscriptChars);
}

function extractPlayerResponse(html) {
  const source = String(html || "");
  const markers = [
    "var ytInitialPlayerResponse = ",
    'window["ytInitialPlayerResponse"] = ',
    "window['ytInitialPlayerResponse'] = ",
    '"ytInitialPlayerResponse":'
  ];

  for (const marker of markers) {
    const markerIndex = source.indexOf(marker);
    if (markerIndex < 0) continue;
    const startIndex = source.indexOf("{", markerIndex + marker.length);
    if (startIndex < 0) continue;
    const json = extractBalancedJsonObject(source, startIndex);
    if (!json) continue;
    try {
      return JSON.parse(json);
    } catch {
      // Try next marker.
    }
  }

  return null;
}

function extractBalancedJsonObject(text, startIndex) {
  if (!text || startIndex < 0 || text[startIndex] !== "{") return null;

  let depth = 0;
  let inString = false;
  let escaping = false;
  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(startIndex, index + 1);
      }
    }
  }

  return null;
}

function pickSubtitleTrack(tracksByLang, { preferManual } = { preferManual: true }) {
  if (!tracksByLang || typeof tracksByLang !== "object") return null;
  const keys = Object.keys(tracksByLang);
  if (!keys.length) return null;

  const orderedKeys = [
    ...keys.filter((key) => /^en(?:[-_]|$)/i.test(key)),
    ...keys.filter((key) => /english/i.test(key)),
    ...keys.filter((key) => !/^en(?:[-_]|$)/i.test(key) && !/english/i.test(key))
  ];
  const uniqueKeys = [...new Set(orderedKeys)];
  const extPriority = ["vtt", "srv3", "ttml", "json3", "srt"];

  for (const lang of uniqueKeys) {
    const rows = Array.isArray(tracksByLang[lang]) ? tracksByLang[lang] : [];
    if (!rows.length) continue;
    const orderedTracks = rows
      .slice()
      .sort((a, b) => extPriority.indexOf(String(a?.ext || "").toLowerCase()) -
        extPriority.indexOf(String(b?.ext || "").toLowerCase()));
    for (const row of orderedTracks) {
      const url = String(row?.url || row?.data || "").trim();
      if (!url) continue;
      const ext = String(row?.ext || "").toLowerCase();
      const appearsAuto = /\bauto(?:matic)?\b/i.test(String(row?.name || ""));
      if (preferManual && appearsAuto) continue;
      return { url, ext };
    }
  }

  for (const lang of uniqueKeys) {
    const rows = Array.isArray(tracksByLang[lang]) ? tracksByLang[lang] : [];
    for (const row of rows) {
      const url = String(row?.url || row?.data || "").trim();
      if (!url) continue;
      return { url, ext: String(row?.ext || "").toLowerCase() };
    }
  }

  return null;
}

function parseSubtitleText(raw, maxTranscriptChars) {
  const source = String(raw || "");
  if (!source) return "";
  const xmlBlocks = [...source.matchAll(/<(?:text|p)\b[^>]*>([\s\S]*?)<\/(?:text|p)>/gi)];
  if (xmlBlocks.length) {
    const joined = xmlBlocks
      .map((match) =>
        decodeHtmlEntities(
          String(match?.[1] || "")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim()
        )
      )
      .filter(Boolean)
      .join(" ");
    return sanitizeText(joined, maxTranscriptChars);
  }

  const lines = source
    .split(/\r?\n/g)
    .map((line) => decodeHtmlEntities(String(line || "").replace(/<[^>]+>/g, " ").trim()))
    .filter(Boolean)
    .filter((line) => !/^WEBVTT$/i.test(line))
    .filter((line) => !/^\d+$/.test(line))
    .filter((line) => !/^(NOTE|STYLE|REGION)\b/i.test(line))
    .filter((line) => !/^\d{1,2}:\d{2}(?::\d{2})?[.,]\d{2,3}\s*-->\s*\d{1,2}:\d{2}(?::\d{2})?[.,]\d{2,3}/.test(line))
    .filter((line) => !/^\d{1,2}:\d{2}(?::\d{2})?[.,]\d{2,3}$/.test(line))
    .map((line) => line.replace(/\s+/g, " ").trim());
  return sanitizeText(lines.join(" "), maxTranscriptChars);
}

function readMetaTag(html, propertyOrName) {
  const escaped = escapeRegExp(propertyOrName);
  const pattern = new RegExp(
    `<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`,
    "i"
  );
  const match = String(html || "").match(pattern);
  return decodeHtmlEntities(String(match?.[1] || "").trim());
}

function readHtmlTitle(html) {
  const match = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return decodeHtmlEntities(String(match?.[1] || "").replace(/\s+/g, " ").trim());
}

async function fetchTextWithRetry({ url, accept = "*/*", maxAttempts = MAX_FETCH_ATTEMPTS }) {
  const safeUrl = normalizeDiscoveryUrl(url);
  if (!safeUrl) {
    throw new Error(`blocked or invalid video URL: ${url}`);
  }

  const attemptLimit = Math.max(1, Number(maxAttempts) || MAX_FETCH_ATTEMPTS);
  let attempt = 0;
  while (attempt < attemptLimit) {
    attempt += 1;
    try {
      const { response, finalUrl } = await fetchPublicResponseWithRedirects({
        url: safeUrl,
        accept
      });

      if (!response.ok) {
        if (shouldRetryHttpStatus(response.status) && attempt < attemptLimit) {
          await sleep(getRetryDelayMs(attempt));
          continue;
        }
        const error: ErrorWithAttempts = new Error(`Video HTTP ${response.status} for ${finalUrl}`);
        error.attempts = attempt;
        throw error;
      }

      let text = "";
      try {
        text = await response.text();
      } catch (error) {
        throw withAttemptCount(error, attempt);
      }
      if (!text) {
        const error: ErrorWithAttempts = new Error("Video source returned empty response.");
        error.attempts = attempt;
        throw error;
      }

      return text;
    } catch (error) {
      if (isRetryableFetchError(error) && attempt < attemptLimit) {
        await sleep(getRetryDelayMs(attempt));
        continue;
      }
      throw withAttemptCount(error, attempt);
    }
  }

  throw withAttemptCount(new Error("Video fetch failed after retries."), attemptLimit);
}

async function fetchPublicResponseWithRedirects({ url, accept, maxRedirects = MAX_FETCH_REDIRECTS }) {
  let currentUrl = String(url || "");
  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    await assertPublicUrl(currentUrl);
    const response = await fetch(currentUrl, {
      method: "GET",
      redirect: "manual",
      headers: {
        "user-agent": VIDEO_USER_AGENT,
        accept
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });

    if (isRedirectStatus(response.status)) {
      const location = String(response.headers.get("location") || "").trim();
      if (!location) {
        throw new Error(`video redirect missing location for ${currentUrl}`);
      }
      const nextUrl = normalizeDiscoveryUrl(new URL(location, currentUrl).toString());
      if (!nextUrl) {
        throw new Error(`blocked or invalid video redirect URL: ${location}`);
      }
      currentUrl = nextUrl;
      continue;
    }

    const finalUrl = normalizeDiscoveryUrl(response.url || currentUrl);
    if (!finalUrl) {
      throw new Error(`blocked or invalid video URL: ${response.url || currentUrl}`);
    }
    await assertPublicUrl(finalUrl);
    return {
      response,
      finalUrl
    };
  }

  throw new Error(`too many redirects for video URL: ${url}`);
}

async function runCommand({ command, args, timeoutMs = 30_000, useShell = false }: { command: string; args: string[]; timeoutMs?: number; useShell?: boolean }) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...(useShell ? { shell: true } : {})
    });

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, Math.max(1, timeoutMs));

    child.stdout.on("data", (chunk) => {
      const text = String(chunk || "");
      const nextBytes = Buffer.byteLength(text);
      if (stdoutBytes < MAX_COMMAND_OUTPUT_BYTES) {
        stdout += text;
        if (Buffer.byteLength(stdout) > MAX_COMMAND_OUTPUT_BYTES) {
          stdout = stdout.slice(0, MAX_COMMAND_OUTPUT_BYTES);
        }
      }
      stdoutBytes += nextBytes;
    });

    child.stderr.on("data", (chunk) => {
      const text = String(chunk || "");
      const nextBytes = Buffer.byteLength(text);
      if (stderrBytes < MAX_COMMAND_OUTPUT_BYTES) {
        stderr += text;
        if (Buffer.byteLength(stderr) > MAX_COMMAND_OUTPUT_BYTES) {
          stderr = stderr.slice(0, MAX_COMMAND_OUTPUT_BYTES);
        }
      }
      stderrBytes += nextBytes;
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`${command} timed out after ${timeoutMs}ms.`));
        return;
      }
      if (code !== 0) {
        const message = String(stderr || stdout || "").replace(/\s+/g, " ").trim();
        reject(new Error(`${command} exited with code ${code}${message ? `: ${message.slice(0, COMMAND_ERROR_MESSAGE_MAX_CHARS)}` : ""}`));
        return;
      }
      resolve({
        stdout: String(stdout || "").trim(),
        stderr: String(stderr || "").trim()
      });
    });
  });
}

function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeDateIso(value) {
  if (value === null || value === undefined || value === "") return null;
  const timestamp = Number(value);
  if (Number.isFinite(timestamp) && timestamp > 0) {
    const ms = timestamp > 9_999_999_999 ? timestamp : timestamp * 1000;
    const parsed = new Date(ms);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }

  const text = String(value || "").trim();
  if (!text) return null;
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

function normalizeYtDlpDate(value) {
  const text = String(value || "").trim();
  if (!/^\d{8}$/.test(text)) return null;
  const year = text.slice(0, 4);
  const month = text.slice(4, 6);
  const day = text.slice(6, 8);
  const iso = `${year}-${month}-${day}T00:00:00.000Z`;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function sanitizeText(value, maxLen = 240) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) return "";
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(0, maxLen - 3)).trimEnd()}...`;
}

function safeHostFromUrl(url) {
  try {
    return String(new URL(String(url)).hostname || "")
      .toLowerCase()
      .replace(/^www\./, "");
  } catch {
    return "";
  }
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#(\d+);/g, (_match, numberText) => {
      const number = Number(numberText);
      return Number.isFinite(number) ? String.fromCharCode(number) : "";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_match, hexText) => {
      const number = Number.parseInt(hexText, 16);
      return Number.isFinite(number) ? String.fromCharCode(number) : "";
    });
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
