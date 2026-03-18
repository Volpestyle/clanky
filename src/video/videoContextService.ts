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

const REQUEST_TIMEOUT_MS = 5_500;
const MAX_FETCH_ATTEMPTS = 3;
const MAX_FETCH_REDIRECTS = 5;
const CACHE_TTL_MS = 30 * 60 * 1000;
const YT_DLP_TIMEOUT_MS = 50_000;
const FFMPEG_TIMEOUT_MS = 45_000;
const MAX_COMMAND_OUTPUT_BYTES = 8 * 1024 * 1024;
const VIDEO_USER_AGENT =
  "clanky/0.2 (+video-context; https://github.com/Volpestyle/clanky)";

type VideoTrace = {
  guildId?: string | null;
  channelId?: string | null;
  userId?: string | null;
  source?: string;
};

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
        content: `${scope}: ${detail}`.slice(0, 2000),
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
    maxTranscriptChars = 1200,
    keyframeIntervalSeconds = 0,
    maxKeyframesPerVideo = 0,
    allowAsrFallback = false,
    maxAsrSeconds = 120,
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
    const transcriptLimit = clamp(Number(maxTranscriptChars) || 1200, 200, 4000);
    const keyframeInterval = clamp(Number(keyframeIntervalSeconds) || 0, 0, 120);
    const keyframeCount = clamp(Number(maxKeyframesPerVideo) || 0, 0, 8);
    const asrSeconds = clamp(Number(maxAsrSeconds) || 120, 15, 600);
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
          content: String(context.videoId || context.url || target.key || "").slice(0, 2000),
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
            cacheHit: Boolean(context.cacheHit)
          }
        });
      } catch (error) {
        const message = String(error?.message || error);
        errors.push({
          key: target.key,
          url: target.url,
          error: message
        });
        this.store.logAction({
          kind: "video_context_error",
          guildId: trace.guildId,
          channelId: trace.channelId,
          userId: trace.userId,
          content: `${target.key}: ${message}`.slice(0, 2000),
          metadata: {
            source: trace.source || "unknown",
            kind: target.kind,
            key: target.key,
            url: target.url,
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
      frameImages: []
    };
    if (!needKeyframes && !shouldAsr) return context;

    let media = null;
    let mediaError = null;
    try {
      media = await this.resolveMediaInput(target.url, target.forceDirect);
    } catch (error) {
      mediaError = String(error?.message || error);
    }

    if (mediaError) {
      if (needKeyframes) {
        context.keyframeError = mediaError;
      }
      if (shouldAsr && !context.transcriptError) {
        context.transcriptError = mediaError;
      }
      return context;
    }

    try {
      if (needKeyframes && media) {
        try {
          const frames = await this.extractKeyframesFromInput({
            input: media.input,
            keyframeIntervalSeconds,
            maxKeyframesPerVideo
          });
          context.frameImages = frames;
          context.keyframeCount = frames.length;
        } catch (error) {
          context.keyframeError = String(error?.message || error);
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
      videoId: sanitizeText(String(info?.id || target.videoId || ""), 80) || null,
      url: normalizeDiscoveryUrl(info?.webpage_url || info?.original_url || target.url) || target.url,
      title: sanitizeText(info?.title || "", 180) || "untitled video",
      channel:
        sanitizeText(
          info?.uploader || info?.channel || info?.creator || info?.channel_url || fallbackHost || "",
          120
        ) || "unknown channel",
      publishedAt: normalizeYtDlpDate(info?.upload_date) || normalizeDateIso(info?.release_timestamp),
      durationSeconds: safeNumber(info?.duration),
      viewCount: safeNumber(info?.view_count),
      description: sanitizeText(info?.description || "", 360),
      transcript: transcriptResult.text || "",
      transcriptSource: transcriptResult.source || "",
      transcriptError: transcriptResult.error || null
    };
  }

  async fetchYtDlpInfo(url) {
    if (!(await this.hasYtDlp())) {
      throw new Error("yt-dlp is not installed.");
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
      videoId: sanitizeText(extractTikTokIdFromUrl(url) || "", 80) || null,
      url,
      title: sanitizeText(data?.title || "", 180) || "TikTok video",
      channel: sanitizeText(data?.author_name || host || "", 120) || "unknown channel",
      publishedAt: null,
      durationSeconds: null,
      viewCount: null,
      description: sanitizeText(data?.title || "", 360),
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
            180
          ) || "";
        description = sanitizeText(
          readMetaTag(html, "og:description") || readMetaTag(html, "twitter:description") || "",
          360
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
      throw new Error("yt-dlp is required for this video source.");
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

  async extractKeyframesFromInput({ input, keyframeIntervalSeconds, maxKeyframesPerVideo }) {
    if (!(await this.hasFfmpeg())) {
      throw new Error("ffmpeg is not installed.");
    }

    const interval = clamp(Number(keyframeIntervalSeconds) || 0, 1, 120);
    const maxFrames = clamp(Number(maxKeyframesPerVideo) || 0, 1, 8);
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clanker-frames-"));
    const outputPattern = path.join(tempDir, "frame-%03d.jpg");

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
          "-vf",
          `fps=1/${interval}`,
          "-frames:v",
          String(maxFrames),
          "-q:v",
          "5",
          outputPattern
        ],
        timeoutMs: FFMPEG_TIMEOUT_MS
      });

      const rows = await fs.readdir(tempDir);
      const frameFiles = rows.filter((name) => name.toLowerCase().endsWith(".jpg")).sort();
      const images = [];
      for (const frame of frameFiles) {
        const fullPath = path.join(tempDir, frame);
        const dataBase64 = await fs.readFile(fullPath, { encoding: "base64" });
        if (!dataBase64) continue;
        images.push({
          filename: frame,
          contentType: "image/jpeg",
          mediaType: "image/jpeg",
          dataBase64,
          source: "video_keyframe"
        });
      }
      return images;
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
      throw new Error("ffmpeg is not installed.");
    }
    if (!this.llm?.isAsrReady?.()) {
      throw new Error("ASR fallback requires OPENAI_API_KEY.");
    }

    const segmentSeconds = clamp(Number(maxAsrSeconds) || 120, 15, 600);
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
          "16000",
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
    const TOOL_CHECK_TTL_MS = 5 * 60 * 1000;
    const now = Date.now();
    if (this.toolAvailabilityPromise && now - this.toolAvailabilityCheckedAt < TOOL_CHECK_TTL_MS) {
      return this.toolAvailabilityPromise;
    }
    this.toolAvailabilityCheckedAt = now;
    this.toolAvailabilityPromise = Promise.all([
      this.commandAvailable("ffmpeg", ["-version"]),
      this.commandAvailable("yt-dlp", ["--version"])
    ])
      .then(([ffmpeg, ytDlp]) => {
        console.log(`[VideoContextService] tool_availability  ffmpeg=${ffmpeg}  ytDlp=${ytDlp}`);
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
        timeoutMs: 4_000,
        useShell: true
      });
      return true;
    } catch (error) {
      console.warn(`[VideoContextService] command_not_available  command=${command}  error=${error?.message || error}`);
      return false;
    }
  }
}

function summarizeYouTubeVideo({ videoId, url, playerResponse }) {
  const details = playerResponse?.videoDetails || {};
  const micro = playerResponse?.microformat?.playerMicroformatRenderer || {};

  const title =
    sanitizeText(details?.title || micro?.title?.simpleText || micro?.title || "", 180) || "untitled video";
  const channel =
    sanitizeText(details?.author || micro?.ownerChannelName || micro?.ownerChannel || "", 120) || "unknown channel";
  const description = sanitizeText(details?.shortDescription || micro?.description?.simpleText || "", 360);
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
        reject(new Error(`${command} exited with code ${code}${message ? `: ${message.slice(0, 400)}` : ""}`));
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
