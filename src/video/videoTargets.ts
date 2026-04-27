import { normalizeDiscoveryUrl } from "../services/discovery.ts";

const URL_IN_TEXT_RE = /https?:\/\/[^\s<>()]+/gi;
const VIDEO_EXT_RE = /\.(mp4|m4v|mov|webm|mkv|avi|mpeg|mpg|gif)$/i;
const DISCORD_CDN_HOST_RE = /(?:^|\.)discordapp\.(?:com|net)$/i;
const VIDEO_HOST_HINTS = new Set([
  "giphy.com",
  "media.giphy.com",
  "media.tenor.com",
  "tenor.com",
  "v.redd.it",
  "streamable.com",
  "clips.twitch.tv",
  "twitch.tv",
  "x.com",
  "twitter.com"
]);

export type VideoTarget = {
  key: string;
  url: string;
  kind: string;
  videoId?: string | null;
  forceDirect?: boolean;
};

export function extractUrls(text) {
  URL_IN_TEXT_RE.lastIndex = 0;
  return [...String(text || "").matchAll(URL_IN_TEXT_RE)].map((match) => String(match[0] || ""));
}

export function dedupeTargets(targets, maxTargets) {
  const out = [];
  const seen = new Set();
  for (const target of targets) {
    if (!target) continue;
    if (seen.has(target.key)) continue;
    seen.add(target.key);
    out.push(target);
    if (out.length >= maxTargets) break;
  }
  return out;
}

export function parseAttachmentTarget(attachment) {
  const url = String(attachment?.url || attachment?.proxyURL || "").trim();
  if (!url) return null;

  const filename = String(attachment?.name || "").trim();
  const contentType = String(attachment?.contentType || "").toLowerCase();
  const isVideo =
    contentType.startsWith("video/") || VIDEO_EXT_RE.test(filename) || VIDEO_EXT_RE.test(url.split("?")[0] || "");
  if (!isVideo) return null;

  const target = parseVideoTarget(url, {
    source: "attachment",
    forceDirect: true
  });
  if (target) return target;

  return createDirectTargetFromUrl(url, "attachment");
}

export function parseEmbedTargets(embed) {
  const targets = [];
  const videoUrl = String(embed?.video?.url || embed?.video?.proxyURL || "").trim();
  if (videoUrl) {
    const target = parseVideoTarget(videoUrl, {
      source: "embed_video",
      forceDirect: true
    });
    if (target) targets.push(target);
  }

  const embedUrl = String(embed?.url || "").trim();
  if (embedUrl) {
    const parsedTarget = parseVideoTarget(embedUrl, {
      source: "embed_url"
    });
    if (parsedTarget) {
      targets.push(parsedTarget);
    } else if (String(embed?.type || "").toLowerCase() === "video") {
      const fallbackTarget = createGenericTargetFromUrl(embedUrl, "embed_url");
      if (fallbackTarget) targets.push(fallbackTarget);
    }
  }

  return targets;
}

export function parseVideoTarget(rawUrl, { source = "message_url", forceDirect = false } = {}) {
  const safeUrl = normalizeDiscoveryUrl(rawUrl);
  if (!safeUrl) return null;

  let parsed = null;
  try {
    parsed = new URL(safeUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

  const host = String(parsed.hostname || "").toLowerCase();
  const compactHost = host.replace(/^www\./, "");

  const youtube = parseYoutubeTargetFromUrl(parsed);
  if (youtube) {
    return {
      key: `youtube:${youtube.videoId}`,
      kind: "youtube",
      provider: "youtube",
      videoId: youtube.videoId,
      url: youtube.url,
      source,
      forceDirect: false
    };
  }

  if (isTikTokHost(compactHost)) {
    const tiktokId = extractTikTokIdFromParsedUrl(parsed);
    return {
      key: tiktokId ? `tiktok:${tiktokId}` : `tiktok:${buildHostPathKey(parsed)}`,
      kind: "tiktok",
      provider: "tiktok",
      videoId: tiktokId || null,
      url: safeUrl,
      source,
      forceDirect: false
    };
  }

  const direct = forceDirect || isLikelyDirectVideoUrl(safeUrl);
  if (direct) {
    return {
      key: `direct:${buildHostPathKey(parsed)}`,
      kind: "direct",
      provider: "direct",
      videoId: null,
      url: safeUrl,
      source,
      forceDirect: true
    };
  }

  if (VIDEO_HOST_HINTS.has(compactHost) || compactHost.includes("reddit.com")) {
    return {
      key: `generic:${buildHostPathKey(parsed)}`,
      kind: "generic",
      provider: "generic",
      videoId: null,
      url: safeUrl,
      source,
      forceDirect: false
    };
  }

  return null;
}

function createDirectTargetFromUrl(rawUrl, source) {
  const safeUrl = normalizeDiscoveryUrl(rawUrl);
  if (!safeUrl) return null;

  let parsed = null;
  try {
    parsed = new URL(safeUrl);
  } catch {
    return null;
  }

  return {
    key: `direct:${buildHostPathKey(parsed)}`,
    kind: "direct",
    provider: "direct",
    videoId: null,
    url: safeUrl,
    source,
    forceDirect: true
  };
}

function createGenericTargetFromUrl(rawUrl, source) {
  const safeUrl = normalizeDiscoveryUrl(rawUrl);
  if (!safeUrl) return null;

  let parsed = null;
  try {
    parsed = new URL(safeUrl);
  } catch {
    return null;
  }

  return {
    key: `generic:${buildHostPathKey(parsed)}`,
    kind: "generic",
    provider: "generic",
    videoId: null,
    url: safeUrl,
    source,
    forceDirect: false
  };
}

function parseYoutubeTargetFromUrl(parsed) {
  const host = String(parsed.hostname || "").toLowerCase();
  const compactHost = host.replace(/^www\./, "");
  let videoId = "";
  if (compactHost === "youtu.be") {
    videoId = parsed.pathname.split("/").filter(Boolean)[0] || "";
  } else if (compactHost.endsWith("youtube.com") || compactHost === "youtube-nocookie.com") {
    if (parsed.pathname === "/watch" || parsed.pathname === "/watch/") {
      videoId = parsed.searchParams.get("v") || "";
    } else {
      const pathParts = parsed.pathname.split("/").filter(Boolean);
      if (pathParts[0] === "shorts" || pathParts[0] === "embed" || pathParts[0] === "live") {
        videoId = pathParts[1] || "";
      }
    }
  }

  videoId = String(videoId || "").trim();
  if (!/^[a-zA-Z0-9_-]{6,20}$/.test(videoId)) return null;
  return {
    videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`
  };
}

function isTikTokHost(compactHost) {
  return (
    compactHost === "tiktok.com" ||
    compactHost.endsWith(".tiktok.com") ||
    compactHost === "vm.tiktok.com" ||
    compactHost === "vt.tiktok.com"
  );
}

export function extractTikTokIdFromUrl(rawUrl) {
  try {
    return extractTikTokIdFromParsedUrl(new URL(String(rawUrl)));
  } catch {
    return "";
  }
}

function extractTikTokIdFromParsedUrl(parsed) {
  const parts = parsed.pathname.split("/").filter(Boolean);
  const videoIndex = parts.findIndex((part) => part.toLowerCase() === "video");
  if (videoIndex >= 0 && parts[videoIndex + 1]) {
    return String(parts[videoIndex + 1]).replace(/[^0-9]/g, "");
  }
  const itemId = parsed.searchParams.get("item_id");
  if (itemId) return String(itemId).replace(/[^0-9]/g, "");
  return "";
}

function buildHostPathKey(parsed) {
  const host = String(parsed.hostname || "").toLowerCase().replace(/^www\./, "");
  const pathname = String(parsed.pathname || "/").replace(/\/+$/, "") || "/";
  return `${host}${pathname}`;
}

export function isLikelyDirectVideoUrl(rawUrl) {
  let parsed = null;
  try {
    parsed = new URL(String(rawUrl));
  } catch {
    return false;
  }
  const pathname = String(parsed.pathname || "");
  if (VIDEO_EXT_RE.test(pathname)) return true;
  if (DISCORD_CDN_HOST_RE.test(String(parsed.hostname || "").toLowerCase()) && pathname.includes("/attachments/")) {
    return true;
  }
  return false;
}
