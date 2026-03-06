import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { clamp } from "./utils.ts";
import { getVoiceStreamWatchSettings } from "./settings/agentStack.ts";

const DEFAULT_SESSION_TTL_MINUTES = 12;
const MIN_SESSION_TTL_MINUTES = 2;
const MAX_SESSION_TTL_MINUTES = 30;
const MAX_ACTIVE_SESSIONS = 240;
const DEFAULT_SHARE_KEYFRAME_INTERVAL_MS = 1200;
const MIN_SHARE_KEYFRAME_INTERVAL_MS = 500;
const MAX_SHARE_KEYFRAME_INTERVAL_MS = 2000;
const DEFAULT_SHARE_CAPTURE_MAX_WIDTH_PX = 960;
const MIN_SHARE_CAPTURE_MAX_WIDTH_PX = 640;
const MAX_SHARE_CAPTURE_MAX_WIDTH_PX = 1920;
const DEFAULT_SHARE_CAPTURE_JPEG_QUALITY = 0.62;
const MIN_SHARE_CAPTURE_JPEG_QUALITY = 0.5;
const MAX_SHARE_CAPTURE_JPEG_QUALITY = 0.75;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DASHBOARD_ASSET_DIR = path.resolve(__dirname, "../dashboard/dist/assets");
const DASHBOARD_STYLESHEET_PREFIX = "index-";
const DASHBOARD_STYLESHEET_SUFFIX = ".css";
const DASHBOARD_STYLE_TAG_ID = "share-dashboard-theme";
const SHARE_PAGE_FALLBACK_FONT_IMPORT = "https://fonts.googleapis.com/css2?family=Manrope:wght@500;600;700;800&family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap";
let cachedDashboardThemeHref = "";
let dashboardThemeResolved = false;

export class ScreenShareSessionManager {
  appConfig;
  store;
  bot;
  publicHttpsEntrypoint;
  sessions;
  dashboardThemeHref;

  constructor({ appConfig, store, bot, publicHttpsEntrypoint }) {
    this.appConfig = appConfig || {};
    this.store = store;
    this.bot = bot;
    this.publicHttpsEntrypoint = publicHttpsEntrypoint;
    this.sessions = new Map();
    this.dashboardThemeHref = resolveDashboardThemeHref();
  }

  getRuntimeState() {
    this.cleanupExpiredSessions();
    const activeCount = this.sessions.size;
    let newestExpiresAt = null;
    for (const session of this.sessions.values()) {
      if (!newestExpiresAt || session.expiresAt > newestExpiresAt) {
        newestExpiresAt = session.expiresAt;
      }
    }
    return {
      activeCount,
      newestExpiresAt: newestExpiresAt ? new Date(newestExpiresAt).toISOString() : null
    };
  }

  getLinkCapability() {
    const publicState = this.publicHttpsEntrypoint?.getState?.() || null;
    const publicUrl = normalizeShareBaseUrl(publicState?.publicUrl);
    if (publicUrl) {
      return {
        enabled: true,
        status: String(publicState?.status || "ready"),
        publicUrl
      };
    }

    const localUrl = getLocalShareBaseUrl(this.appConfig);
    if (localUrl) {
      return {
        enabled: true,
        status: "ready",
        publicUrl: localUrl
      };
    }

    return {
      enabled: false,
      status: String(publicState?.status || "disabled"),
      publicUrl: ""
    };
  }

  cleanupExpiredSessions(nowMs = Date.now()) {
    for (const [token, session] of this.sessions.entries()) {
      if (Number(session.expiresAt || 0) <= nowMs) {
        this.sessions.delete(token);
      }
    }
    if (this.sessions.size <= MAX_ACTIVE_SESSIONS) return;
    const entries = [...this.sessions.entries()].sort(
      (a, b) => Number(a[1]?.createdAt || 0) - Number(b[1]?.createdAt || 0)
    );
    for (const [token] of entries) {
      if (this.sessions.size <= MAX_ACTIVE_SESSIONS) break;
      this.sessions.delete(token);
    }
  }

  getSessionByToken(rawToken) {
    this.cleanupExpiredSessions();
    const token = String(rawToken || "").trim();
    if (!token) return null;
    return this.sessions.get(token) || null;
  }

  getPublicShareUrlForToken(token) {
    const shareBaseUrl = normalizeShareBaseUrl(this.getLinkCapability()?.publicUrl);
    if (!shareBaseUrl || !token) return "";
    return `${shareBaseUrl}/share/${encodeURIComponent(token)}`;
  }

  findReusableSession({
    guildId,
    channelId,
    requesterUserId,
    targetUserId = null
  }) {
    this.cleanupExpiredSessions();
    const normalizedGuildId = String(guildId || "").trim();
    const normalizedChannelId = String(channelId || "").trim() || null;
    const normalizedRequesterUserId = String(requesterUserId || "").trim();
    const normalizedTargetUserId = String(targetUserId || normalizedRequesterUserId).trim();
    if (!normalizedGuildId || !normalizedRequesterUserId) return null;

    let newestMatch = null;
    for (const session of this.sessions.values()) {
      if (String(session?.guildId || "").trim() !== normalizedGuildId) continue;
      if (String(session?.requesterUserId || "").trim() !== normalizedRequesterUserId) continue;
      if (normalizedChannelId && String(session?.channelId || "").trim() !== normalizedChannelId) continue;
      if (normalizedTargetUserId && String(session?.targetUserId || "").trim() !== normalizedTargetUserId) continue;
      if (!newestMatch || Number(session?.createdAt || 0) > Number(newestMatch?.createdAt || 0)) {
        newestMatch = session;
      }
    }
    return newestMatch;
  }

  async createSession({
    guildId,
    channelId,
    requesterUserId,
    requesterDisplayName = "",
    targetUserId = null,
    source = "screen_share_offer"
  }) {
    this.cleanupExpiredSessions();
    const normalizedGuildId = String(guildId || "").trim();
    const normalizedChannelId = String(channelId || "").trim() || null;
    const normalizedRequesterUserId = String(requesterUserId || "").trim();
    const normalizedTargetUserId = String(targetUserId || normalizedRequesterUserId).trim();
    const normalizedSource = String(source || "screen_share_offer").trim().slice(0, 80) || "screen_share_offer";

    if (!normalizedGuildId || !normalizedRequesterUserId) {
      return {
        ok: false,
        reason: "invalid_share_request",
        message: "can't create a share link from this context."
      };
    }

    const shareBaseUrl = normalizeShareBaseUrl(this.getLinkCapability()?.publicUrl);
    if (!shareBaseUrl) {
      return {
        ok: false,
        reason: "share_link_unavailable",
        message: "share link is unavailable right now."
      };
    }

    const reusableSession = this.findReusableSession({
      guildId: normalizedGuildId,
      channelId: normalizedChannelId,
      requesterUserId: normalizedRequesterUserId,
      targetUserId: normalizedTargetUserId
    });
    if (reusableSession) {
      const voicePresence = this.validateSessionVoicePresence(reusableSession);
      if (voicePresence.ok) {
        const shareUrl = `${shareBaseUrl}/share/${encodeURIComponent(reusableSession.token)}`;
        const remainingMs = Math.max(0, Number(reusableSession.expiresAt || 0) - Date.now());
        const expiresInMinutes = remainingMs > 0 ? Math.max(1, Math.ceil(remainingMs / 60_000)) : 0;
        this.store.logAction({
          kind: "voice_runtime",
          guildId: reusableSession.guildId,
          channelId: reusableSession.channelId,
          userId: reusableSession.requesterUserId,
          content: "screen_share_session_reused",
          metadata: {
            tokenSuffix: String(reusableSession.token || "").slice(-8),
            source: normalizedSource,
            expiresAt: new Date(reusableSession.expiresAt).toISOString(),
            targetUserId: reusableSession.targetUserId,
            shareHost: safeUrlHost(shareUrl)
          }
        });
        return {
          ok: true,
          reused: true,
          token: reusableSession.token,
          shareUrl,
          expiresAt: new Date(reusableSession.expiresAt).toISOString(),
          expiresInMinutes,
          targetUserId: reusableSession.targetUserId
        };
      }
      await this.stopSessionByToken({
        token: reusableSession.token,
        reason: String(voicePresence.reason || "session_reuse_invalid").slice(0, 80)
      });
    }

    const settings = this.store.getSettings();
    const watchResult = await this.bot?.voiceSessionManager?.enableWatchStreamForUser?.({
      guildId: normalizedGuildId,
      requesterUserId: normalizedRequesterUserId,
      targetUserId: normalizedTargetUserId,
      settings,
      source: normalizedSource
    });
    if (!watchResult?.ok) {
      return {
        ok: false,
        reason: String(watchResult?.reason || "stream_watch_unavailable"),
        message: String(
          watchResult?.fallback ||
            "can't start screen-share watching right now. make sure we're in vc together and stream watch is enabled."
        )
      };
    }

    const sessionTtlMinutes = clamp(
      Number(this.appConfig?.publicShareSessionTtlMinutes) || DEFAULT_SESSION_TTL_MINUTES,
      MIN_SESSION_TTL_MINUTES,
      MAX_SESSION_TTL_MINUTES
    );
    const nowMs = Date.now();
    const token = crypto.randomBytes(18).toString("base64url");
    const expiresAt = nowMs + sessionTtlMinutes * 60_000;
    const session = {
      token,
      guildId: normalizedGuildId,
      channelId: normalizedChannelId,
      requesterUserId: normalizedRequesterUserId,
      requesterDisplayName: String(requesterDisplayName || "").trim().slice(0, 80) || null,
      targetUserId: normalizedTargetUserId,
      source: normalizedSource,
      createdAt: nowMs,
      expiresAt,
      lastFrameAt: 0
    };
    this.sessions.set(token, session);

    const shareUrl = `${shareBaseUrl}/share/${encodeURIComponent(token)}`;
    this.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.channelId,
      userId: session.requesterUserId,
      content: "screen_share_session_created",
      metadata: {
        tokenSuffix: token.slice(-8),
        source: session.source,
        expiresAt: new Date(expiresAt).toISOString(),
        targetUserId: session.targetUserId,
        shareHost: safeUrlHost(shareUrl)
      }
    });

    return {
      ok: true,
      token,
      shareUrl,
      expiresAt: new Date(expiresAt).toISOString(),
      expiresInMinutes: sessionTtlMinutes,
      targetUserId: session.targetUserId
    };
  }

  async ingestFrameByToken({ token, mimeType = "image/jpeg", dataBase64 = "", source = "screen_share_page" }) {
    const session = this.getSessionByToken(token);
    if (!session) {
      return {
        accepted: false,
        reason: "share_session_not_found"
      };
    }

    const voicePresence = this.validateSessionVoicePresence(session);
    if (!voicePresence.ok) {
      await this.stopSessionByToken({
        token: session.token,
        reason: voicePresence.reason
      });
      return {
        accepted: false,
        reason: voicePresence.reason
      };
    }

    let result = await this.bot.ingestVoiceStreamFrame({
      guildId: session.guildId,
      streamerUserId: session.targetUserId,
      mimeType,
      dataBase64,
      source
    });

    if (!result?.accepted && result?.reason === "watch_not_active") {
      const settings = this.store.getSettings();
      const watchResult = await this.bot?.voiceSessionManager?.enableWatchStreamForUser?.({
        guildId: session.guildId,
        requesterUserId: session.requesterUserId,
        targetUserId: session.targetUserId,
        settings,
        source: "screen_share_frame_rearm"
      });
      if (watchResult?.ok) {
        result = await this.bot.ingestVoiceStreamFrame({
          guildId: session.guildId,
          streamerUserId: session.targetUserId,
          mimeType,
          dataBase64,
          source
        });
      }
    }

    if (result?.accepted) {
      session.lastFrameAt = Date.now();
    }
    return result || { accepted: false, reason: "unknown" };
  }

  validateSessionVoicePresence(session) {
    const voiceManager = this.bot?.voiceSessionManager || null;
    if (!voiceManager || typeof voiceManager.getSession !== "function") {
      return {
        ok: false,
        reason: "voice_session_not_found"
      };
    }

    const voiceSession = voiceManager.getSession(String(session?.guildId || "").trim());
    if (!voiceSession || voiceSession.ending) {
      return {
        ok: false,
        reason: "voice_session_not_found"
      };
    }

    if (typeof voiceManager.isUserInSessionVoiceChannel === "function") {
      const requesterPresent = voiceManager.isUserInSessionVoiceChannel({
        session: voiceSession,
        userId: session.requesterUserId
      });
      if (!requesterPresent) {
        return {
          ok: false,
          reason: "requester_not_in_same_vc"
        };
      }

      if (session.targetUserId) {
        const targetPresent = voiceManager.isUserInSessionVoiceChannel({
          session: voiceSession,
          userId: session.targetUserId
        });
        if (!targetPresent) {
          return {
            ok: false,
            reason: "target_user_not_in_same_vc"
          };
        }
      }
    }

    return { ok: true };
  }

  async stopSessionByToken({ token, reason = "stopped_by_user" }) {
    const session = this.getSessionByToken(token);
    if (!session) return false;
    this.sessions.delete(session.token);
    const settings = this.store.getSettings();
    const voiceStopResult = typeof this.bot?.voiceSessionManager?.stopWatchStreamForUser === "function"
      ? await this.bot.voiceSessionManager.stopWatchStreamForUser({
          guildId: session.guildId,
          requesterUserId: session.requesterUserId,
          targetUserId: session.targetUserId,
          settings,
          reason: String(reason || "stopped_by_user")
        }).catch(() => null)
      : null;
    this.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.channelId,
      userId: session.requesterUserId,
      content: "screen_share_session_stopped",
      metadata: {
        tokenSuffix: String(session.token || "").slice(-8),
        reason: String(reason || "stopped_by_user").slice(0, 80),
        voiceWatchStopReason: voiceStopResult?.reason || null
      }
    });
    return true;
  }

  renderSharePage(token) {
    const session = this.getSessionByToken(token);
    if (!session) {
      return {
        statusCode: 404,
        html: buildInvalidSharePageHtml("This share link is invalid or expired.", this.dashboardThemeHref)
      };
    }

    const settings = this.store.getSettings();
    const streamWatchSettings = getVoiceStreamWatchSettings(settings);
    const keyframeIntervalMs = clamp(
      Number(streamWatchSettings.keyframeIntervalMs) || DEFAULT_SHARE_KEYFRAME_INTERVAL_MS,
      MIN_SHARE_KEYFRAME_INTERVAL_MS,
      MAX_SHARE_KEYFRAME_INTERVAL_MS
    );
    const captureMaxWidthPx = clamp(
      Number(streamWatchSettings.sharePageMaxWidthPx) || DEFAULT_SHARE_CAPTURE_MAX_WIDTH_PX,
      MIN_SHARE_CAPTURE_MAX_WIDTH_PX,
      MAX_SHARE_CAPTURE_MAX_WIDTH_PX
    );
    const captureJpegQuality = clamp(
      Number(streamWatchSettings.sharePageJpegQuality) || DEFAULT_SHARE_CAPTURE_JPEG_QUALITY,
      MIN_SHARE_CAPTURE_JPEG_QUALITY,
      MAX_SHARE_CAPTURE_JPEG_QUALITY
    );
    const frameApiPath = `/api/voice/share-session/${encodeURIComponent(session.token)}/frame`;
    const stopApiPath = `/api/voice/share-session/${encodeURIComponent(session.token)}/stop`;
    return {
      statusCode: 200,
      html: buildSharePageHtml({
        expiresAtIso: new Date(session.expiresAt).toISOString(),
        frameApiPath,
        stopApiPath,
        keyframeIntervalMs,
        captureMaxWidthPx,
        captureJpegQuality,
        dashboardThemeHref: this.dashboardThemeHref
      })
    };
  }
}

function buildInvalidSharePageHtml(message, dashboardThemeHref) {
  const text = String(message || "Invalid link.").slice(0, 220);
  const safeDashboardThemeHref = String(dashboardThemeHref || cachedDashboardThemeHref || "").trim();
  return [
    "<!doctype html>",
    "<html lang=\"en\">",
    "<head>",
    "<meta charset=\"utf-8\" />",
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />",
    "<title>clanker conk - link unavailable</title>",
    "<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\" />",
    "<link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin />",
    "<link href=\"" + SHARE_PAGE_FALLBACK_FONT_IMPORT + "\" rel=\"stylesheet\" />",
    safeDashboardThemeHref ? `<link id="${DASHBOARD_STYLE_TAG_ID}" rel="stylesheet" href="${escapeHtmlAttr(safeDashboardThemeHref)}" />` : "",
    "<style>",
    "html,body{margin:0;min-height:100vh;background:radial-gradient(ellipse at 18% 0%, rgba(25,55,45,.35) 0%, transparent 55%),radial-gradient(ellipse at 85% 90%, rgba(18,35,38,.3) 0%, transparent 50%),linear-gradient(165deg,#060d0f,#0c1a1e 50%,#152822);background-attachment:fixed;color:var(--ink-0,#e8ede2);}",
    ".share-shell{min-height:100vh;font-family:'Plus Jakarta Sans',system-ui,sans-serif;display:grid;place-items:center;padding:24px 14px;}",
    ".share-shell .shell{width:min(640px,100%)}",
    ".share-shell .eyebrow{color:var(--accent,#bef264);font-family:'Manrope','Plus Jakarta Sans',sans-serif;text-transform:uppercase;font-size:.68rem;letter-spacing:.16em;margin:0 0 4px}",
    ".share-shell .hero{display:flex;flex-direction:column;gap:4px;padding:20px 22px 16px;border-top:2px solid var(--accent,#bef264)}",
    ".share-shell .hero-top-row{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}",
    ".share-shell .hero h1{margin:0;font-family:'Manrope','Plus Jakarta Sans',sans-serif;font-size:clamp(1.5rem,3vw,2.1rem);font-weight:700;letter-spacing:-0.02em;text-transform:lowercase;background:linear-gradient(135deg,var(--ink-0,#e8ede2) 50%,var(--accent,#bef264));-webkit-background-clip:text;-webkit-text-fill-color:transparent;display:flex;align-items:center;gap:10px}",
    ".share-shell .sub{color:var(--ink-2,#7b8f82);font-size:.88rem;margin:0}",
    ".share-shell .panel{background:rgba(8,16,15,.65);border:1px solid rgba(255,255,255,.06);border-radius:12px;padding:20px;box-shadow:var(--shadow,0 4px 24px rgba(0,0,0,.35));backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px)}",
    ".share-shell .panel-head{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:10px}.share-shell .panel-head h3{margin:0;font-size:1rem}",
    ".share-shell .status-msg{margin:8px 0 0;padding:9px 11px;border:1px solid rgba(255,255,255,.08);border-radius:8px;background:rgba(10,20,18,.58);color:var(--ink-1,#bcc8be);min-height:38px;white-space:pre-wrap}",
    ".share-shell .runtime-uptime{color:var(--ink-3,#4f6459);font-size:.78rem;margin-left:auto;letter-spacing:.02em}",
    ".share-shell .header-status-dot{width:10px;height:10px;min-width:10px;border-radius:50%;background:var(--danger,#f87171);display:inline-block;-webkit-text-fill-color:initial}.share-shell .header-status-dot.online{background:var(--success,#4ade80);box-shadow:0 0 8px rgba(74,222,128,.5);animation:pulse 2s ease-in-out infinite}",
    ".share-shell button{font:inherit;background:rgba(20,38,36,.8);color:var(--ink-0,#e8ede2);border:1px solid rgba(255,255,255,.06);border-radius:8px;padding:7px 14px;cursor:pointer;font-size:.84rem;font-weight:500;transition:background var(--transition,160ms),border-color var(--transition,160ms)}",
    ".share-shell button:hover{background:rgba(28,50,46,.8);border-color:rgba(255,255,255,.1)}",
    "</style>",
    "</head>",
    "<body class=\"share-shell\">",
    "<main class=\"shell\">",
    "<header class=\"hero panel\">",
    "<div class=\"hero-top-row\">",
    "<div>",
    "<p class=\"eyebrow\">Discord Persona Ops</p>",
    "<h1><span class=\"header-status-dot\"></span>screen share</h1>",
    "<p class=\"sub\">Screen share link unavailable.</p>",
    "</div>",
    "</div>",
    "</header>",
    "<section class=\"panel\">",
    `<div class="activity-status-msg error">${escapeHtml(text)}</div>`,
    "</section>",
    "</main>",
    "</body>",
    "</html>"
  ].join("");
}

function buildSharePageHtml({
  expiresAtIso,
  frameApiPath,
  stopApiPath,
  keyframeIntervalMs,
  captureMaxWidthPx,
  captureJpegQuality,
  dashboardThemeHref
}) {
  const safeExpiresAtIso = escapeJsString(String(expiresAtIso || ""));
  const safeFrameApiPath = escapeJsString(String(frameApiPath || ""));
  const safeStopApiPath = escapeJsString(String(stopApiPath || ""));
  const resolvedKeyframeIntervalMs = clamp(
    Number(keyframeIntervalMs) || DEFAULT_SHARE_KEYFRAME_INTERVAL_MS,
    MIN_SHARE_KEYFRAME_INTERVAL_MS,
    MAX_SHARE_KEYFRAME_INTERVAL_MS
  );
  const resolvedCaptureMaxWidthPx = clamp(
    Number(captureMaxWidthPx) || DEFAULT_SHARE_CAPTURE_MAX_WIDTH_PX,
    MIN_SHARE_CAPTURE_MAX_WIDTH_PX,
    MAX_SHARE_CAPTURE_MAX_WIDTH_PX
  );
  const resolvedCaptureJpegQuality = clamp(
    Number(captureJpegQuality) || DEFAULT_SHARE_CAPTURE_JPEG_QUALITY,
    MIN_SHARE_CAPTURE_JPEG_QUALITY,
    MAX_SHARE_CAPTURE_JPEG_QUALITY
  );
  const resolvedCaptureJpegPercent = Math.round(resolvedCaptureJpegQuality * 100);
  const resolvedTargetFps = Number(
    (1000 / resolvedKeyframeIntervalMs).toFixed(resolvedKeyframeIntervalMs >= 1000 ? 1 : 2)
  );
  const safeDashboardThemeHref = String(dashboardThemeHref || "").trim();
  const safeFpsTarget = escapeHtml(String(resolvedTargetFps));
  const safeFramePayload = escapeHtml(`JPEG ${resolvedCaptureJpegPercent}% · max ${resolvedCaptureMaxWidthPx}px`);

  return [
    "<!doctype html>",
    "<html lang=\"en\">",
    "<head>",
    "<meta charset=\"utf-8\" />",
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />",
    "<title>clanker conk - screen share</title>",
    "<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\" />",
    "<link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin />",
    "<link href=\"" + SHARE_PAGE_FALLBACK_FONT_IMPORT + "\" rel=\"stylesheet\" />",
    safeDashboardThemeHref ? `<link id="${DASHBOARD_STYLE_TAG_ID}" rel="stylesheet" href="${escapeHtmlAttr(safeDashboardThemeHref)}" />` : "",
    "<style>",
    ":root{--bg-0:#060d0f;--bg-1:#0c1a1e;--bg-2:#152822;--ink-0:#e8ede2;--ink-1:#bcc8be;--ink-2:#7b8f82;--ink-3:#4f6459;--line:rgba(255,255,255,.06);--line-strong:rgba(255,255,255,.1);--panel:rgba(8,16,15,.65);--panel-solid:rgba(10,20,18,.92);--accent:#bef264;--accent-soft:#a3d944;--accent-dim:rgba(190,242,100,.08);--accent-glow:rgba(190,242,100,.15);--danger:#f87171;--danger-dim:rgba(248,113,113,.08);--success:#4ade80;--success-dim:rgba(74,222,128,.06);--warning:#fbbf24;--radius:12px;--radius-sm:8px;--radius-xs:4px;--shadow:0 4px 24px rgba(0,0,0,.35);--shadow-lg:0 12px 40px rgba(0,0,0,.45);--transition:160ms cubic-bezier(0.4,0,0.2,1);--ease-out:cubic-bezier(0,0.2,1);}",
    "html,body{margin:0;min-height:100vh;background:radial-gradient(ellipse at 18% 0%, rgba(25,55,45,.35) 0%, transparent 55%),radial-gradient(ellipse at 85% 90%, rgba(18,35,38,.3) 0%, transparent 50%),linear-gradient(165deg,var(--bg-0),var(--bg-1) 50%,var(--bg-2));background-attachment:fixed;color:var(--ink-0)}",
    "*{box-sizing:border-box}",
    "body{font-family:'Plus Jakarta Sans',system-ui,sans-serif;}",
    ".shell{width:min(1340px,94vw);margin:0 auto;padding:24px 0 56px;display:flex;flex-direction:column;gap:14px;position:relative;z-index:1}",
    ".hero{display:flex;flex-direction:column;gap:4px;padding:24px 24px 20px;border-top:2px solid var(--accent)}",
    ".hero-top-row{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}",
    ".eyebrow{color:var(--accent);font-family:'Manrope','Plus Jakarta Sans',sans-serif;text-transform:uppercase;font-weight:600;font-size:.68rem;letter-spacing:.16em;margin:0}",
    ".hero h1{margin:0;font-family:'Manrope','Plus Jakarta Sans',sans-serif;font-size:clamp(1.5rem,3vw,2.1rem);font-weight:700;letter-spacing:-.02em;text-transform:lowercase;background:linear-gradient(135deg,var(--ink-0) 50%,var(--accent));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;display:flex;align-items:center;gap:10px}",
    ".sub{color:var(--ink-2);font-size:.88rem;margin:0}",
    ".panel{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:20px;box-shadow:var(--shadow);display:flex;flex-direction:column;gap:12px;backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px)}",
    ".panel-head{display:flex;justify-content:space-between;align-items:center;gap:12px}.panel-head h3{margin:0;font-size:1rem}",
    ".runtime-label{font-weight:600;font-size:.9rem;color:var(--ink-0)}",
    ".runtime-uptime{color:var(--ink-3);font-size:.78rem;font-variant-numeric:tabular-nums}",
    ".grid-main{display:grid;grid-template-columns:1.1fr 1fr;gap:14px}",
    ".status-dot{width:10px;height:10px;min-width:10px;border-radius:50%;background:var(--ink-3);flex-shrink:0;transition:background 300ms ease,box-shadow 300ms ease}.status-dot.online{background:var(--success);box-shadow:0 0 8px rgba(74,222,128,.5);animation:pulse 2s ease-in-out infinite}",
    ".header-status-dot{width:10px;height:10px;min-width:10px;border-radius:50%;background:var(--danger);display:inline-block;transition:background 300ms ease,box-shadow 300ms ease;-webkit-text-fill-color:initial}.header-status-dot.online{background:var(--success);box-shadow:0 0 8px rgba(74,222,128,.5);animation:pulse 2s ease-in-out infinite}",
    ".status-msg{margin:8px 0 0;min-height:1.2rem;font-size:.84rem;color:var(--ink-2);transition:color var(--transition)}",
    ".share-state{display:flex;align-items:center;gap:8px}.share-state .status-dot{display:block}",
    ".share-preview{position:relative;min-height:220px;background:var(--bg-2);border:1px solid var(--line);border-radius:var(--radius-sm);display:grid;place-items:center;overflow:hidden}",
    ".share-preview video{display:block;width:100%;height:auto;max-height:440px;object-fit:contain;background:transparent}",
    ".share-preview .share-placeholder{position:absolute;inset:0;display:grid;place-items:center;color:var(--ink-3);font-size:.85rem;letter-spacing:.12em;text-transform:uppercase;text-align:center;padding:24px}",
    ".share-preview .share-rec-pill{position:absolute;top:10px;right:10px;background:var(--danger);color:#fff;border-radius:4px;padding:2px 9px;font-size:9px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;display:none;align-items:center;gap:5px}",
    "[data-state=sharing] .share-rec-pill{display:flex}",
    ".share-rec-pill .share-rec-dot{width:6px;height:6px;border-radius:50%;background:#fff;animation:pulse 1.2s ease-in-out infinite}",
    ".share-actions{display:flex;gap:8px;flex-wrap:wrap}",
    ".share-actions .cta{min-width:140px}",
    ".metric-cluster{display:flex;flex-direction:column;gap:6px}",
    ".cluster-label{margin:0;color:var(--ink-3);font-size:.66rem;text-transform:uppercase;letter-spacing:.12em;font-weight:600;padding-left:2px}",
    ".cluster-cards{display:flex;flex-direction:column;gap:6px}",
    ".metric{padding:12px 14px;border:1px solid var(--line);background:rgba(2,12,11,.3);border-radius:var(--radius-sm)}",
    ".metric .label{margin:0;color:var(--ink-3);font-size:.66rem;text-transform:uppercase;letter-spacing:.12em;font-weight:600}",
    ".metric .value{margin:4px 0 0;font-size:1.1rem;font-weight:700;line-height:1;font-variant-numeric:tabular-nums}",
    ".share-progress{height:3px;background:var(--panel-solid);border-radius:2px;overflow:hidden}",
    ".share-progress-fill{height:100%;background:var(--accent);transition:width 1s linear,background .5s;width:100%}",
    ".share-progress-fill.warn{background:var(--warning)}",
    ".share-progress-fill.crit{background:var(--danger)}",
    "button{font:inherit;border:1px solid var(--line);background:rgba(20,38,36,.8);color:var(--ink-0);border-radius:var(--radius-sm);padding:7px 14px;cursor:pointer;font-size:.84rem;font-weight:500;transition:background var(--transition),border-color var(--transition),box-shadow var(--transition)}",
    "button:hover{background:rgba(28,50,46,.8);border-color:var(--line-strong)}",
    "button:active{transform:none}",
    "button:focus-visible{outline:none;box-shadow:0 0 0 2px var(--accent-dim)}",
    ".share-footer{display:flex;align-items:center;gap:10px;flex-wrap:wrap}",
    ".share-time{display:flex;align-items:center;gap:6px;flex:1;min-width:0}",
    ".share-time .label{color:var(--ink-3);font-size:.78rem}",
    ".share-time .value{color:var(--ink-2);font-variant-numeric:tabular-nums}",
    "@keyframes pulse{0%,100%{opacity:1}50%{opacity:.25}}",
    "@media (max-width: 980px){.grid-main{grid-template-columns:1fr}}",
    "@media (max-width: 640px){.shell{padding:18px 0 32px;width:min(940px,92vw)}.share-preview{min-height:190px}}",
    "</style>",
    "</head>",
    "<body data-state=\"idle\">",
    "<main class=\"shell\">",
    "<header class=\"hero panel\">",
    "<div class=\"hero-top-row\">",
    "<div>",
    "<p class=\"eyebrow\">Discord Persona Ops</p>",
    "<h1><span class=\"header-status-dot\" id=\"header-dot\"></span>screen share</h1>",
    "<p class=\"sub\">Start a capture, keep this tab active, and share context from the same Discord voice session.</p>",
    "</div>",
    "</div>",
    "</header>",
    "<section class=\"runtime-banner panel\">",
    "<span class=\"status-dot\" id=\"ind-dot\"></span>",
    "<span class=\"runtime-label\" id=\"mode-lbl\">ready</span>",
    "<span class=\"runtime-uptime\" id=\"countdown\">--:--</span>",
    "</section>",
    "<div class=\"grid-main\">",
    "<section class=\"panel\">",
    "<div class=\"panel-head\">",
    "<h3>Screen feed</h3>",
    "<span class=\"runtime-label\">session controls</span>",
    "</div>",
    "<div class=\"share-preview\">",
    "<div class=\"share-placeholder\" id=\"vid-ph\">select a screen to begin</div>",
    "<div class=\"share-rec-pill\"><span class=\"share-rec-dot\"></span>REC</div>",
    "<video id=\"preview\" autoplay muted playsinline></video>",
    "</div>",
    "<div class=\"share-actions\">",
    "<button id=\"start\" class=\"cta\">Start Sharing</button>",
    "<button id=\"stop\" disabled>Stop</button>",
    "</div>",
    "<p id=\"status\" class=\"status-msg\">waiting to start</p>",
    "<div class=\"share-footer\">",
    "<div class=\"share-time\"><span class=\"label\">frames</span><span class=\"value\" id=\"fcnt\">0</span></div>",
    "<div class=\"share-time\"><span class=\"label\">status</span><span class=\"value\" id=\"state-lbl\">ready</span></div>",
    "</div>",
    "<div class=\"share-progress\"><div class=\"share-progress-fill\" id=\"tbar\" style=\"width:100%\"></div></div>",
    "</section>",
    "<section class=\"panel\">",
    "<div class=\"panel-head\">",
    "<h3>Session details</h3>",
    "</div>",
    "<div class=\"metric-cluster\">",
    "<p class=\"cluster-label\">capture settings</p>",
    "<div class=\"cluster-cards\">",
    `<article class="metric"><p class="label">FPS target</p><p class="value">${safeFpsTarget}</p></article>`,
    `<article class="metric"><p class="label">Frame payload</p><p class="value">${safeFramePayload}</p></article>`,
    "</div>",
    "</div>",
    "<div class=\"metric-cluster\">",
    "<p class=\"cluster-label\">instructions</p>",
    "<div class=\"cluster-cards\">",
    "<article class=\"metric\"><p class=\"label\">Tip</p><p class=\"value\">Choose one source, then keep this tab open.</p></article>",
    "</div>",
    "</div>",
    "</section>",
    "</div>",
    "</main>",
    "<script>",
    `const EXPIRES_AT='${safeExpiresAtIso}';`,
    `const FRAME_API_PATH='${safeFrameApiPath}';`,
    `const STOP_API_PATH='${safeStopApiPath}';`,
    `const FRAME_INTERVAL_MS=${Math.floor(resolvedKeyframeIntervalMs)};`,
    `const MAX_WIDTH=${Math.floor(resolvedCaptureMaxWidthPx)};`,
    `const JPEG_QUALITY=${Number(resolvedCaptureJpegQuality.toFixed(2))};`,
    "const MIN_DYNAMIC_WIDTH=480;",
    "const MIN_DYNAMIC_JPEG_QUALITY=0.5;",
    "const DOWNSCALE_MULTIPLIER=0.82;",
    "const UPSCALE_MULTIPLIER=1.08;",
    "const UPSCALE_SUCCESS_FRAMES=20;",
    "const TERMINAL_REASONS=new Set(['share_session_not_found','voice_session_not_found','requester_not_in_same_vc','target_user_not_in_same_vc']);",
    "const startBtn=document.getElementById('start');",
    "const stopBtn=document.getElementById('stop');",
    "const preview=document.getElementById('preview');",
    "const headerDot=document.getElementById('header-dot');",
    "const modeLbl=document.getElementById('mode-lbl');",
    "const stateLbl=document.getElementById('state-lbl');",
    "const statusEl=document.getElementById('status');",
    "const indDot=document.getElementById('ind-dot');",
    "const placeholder=document.getElementById('vid-ph');",
    "const countdownEl=document.getElementById('countdown');",
    "const fcntEl=document.getElementById('fcnt');",
    "const tbar=document.getElementById('tbar');",
    "const expiresMs=new Date(EXPIRES_AT).getTime();",
    "const pageLoadMs=Date.now();",
    "const totalMs=Math.max(1,expiresMs-pageLoadMs);",
    "let stream=null;",
    "let timer=null;",
    "let sending=false;",
    "let frameCount=0;",
    "let dynamicMaxWidth=MAX_WIDTH;",
    "let dynamicJpegQuality=JPEG_QUALITY;",
    "let adaptiveSuccessFrames=0;",
    "let canvas=document.createElement('canvas');",
    "let ctx=canvas.getContext('2d');",
    "function setStatus(t){statusEl.textContent=String(t||'');}",
    "function setState(s){",
    "document.body.dataset.state=s;",
    "const isLive=s==='sharing';",
    "if (indDot) {",
    "  indDot.className='status-dot'+(isLive?' online':'');",
    "}",
    "if (headerDot) {",
    "  headerDot.className='header-status-dot'+(isLive?' online':'');",
    "}",
    "if (modeLbl) {",
    "  modeLbl.textContent=s==='sharing'?'live':s==='stopped'?'stopped':s==='expired'?'expired':'ready';",
    "}",
    "if (stateLbl) {",
    "  stateLbl.textContent=s==='sharing'?'live':s==='stopped'?'stopped':s==='expired'?'expired':'ready';",
    "}",
    "}",
    "function updateCountdown(){",
    "const rem=Math.max(0,expiresMs-Date.now());",
    "const pct=Math.max(0,rem/totalMs*100);",
    "const m=Math.floor(rem/60000);const s=Math.floor((rem%60000)/1000);",
    "countdownEl.textContent=String(m).padStart(2,'0')+':'+String(s).padStart(2,'0');",
    "tbar.style.width=pct+'%';",
    "tbar.className='share-progress-fill'+(pct<15?' crit':pct<33?' warn':'');",
    "if(rem<=0&&stream){stopShare('session_expired',{allowRestart:false,nextState:'expired'});}",
    "if(rem<=0&&!stream){setState('expired');setStatus('session expired');startBtn.disabled=true;stopBtn.disabled=true;}",
    "}",
    "setState('idle');",
    "setInterval(updateCountdown,1000);updateCountdown();",
    "function stopTracks(){if(!stream)return;for(const t of stream.getTracks())t.stop();}",
    "async function stopShare(reason='user_stop',opts={}){",
    "const allowRestart=opts&&typeof opts==='object'&&opts.allowRestart===false?false:true;",
    "const nextState=opts&&typeof opts==='object'&&typeof opts.nextState==='string'?opts.nextState:'';",
    "if(timer){clearInterval(timer);timer=null;}",
    "stopTracks();",
    "stream=null;",
    "preview.srcObject=null;",
    "if (placeholder) {",
    "  placeholder.style.display='grid';",
    "}",
    "startBtn.disabled=!allowRestart;",
    "stopBtn.disabled=true;",
    "if(nextState){setState(nextState);}else if(reason!=='session_expired'){setState('stopped');}",
    "try{await fetch(STOP_API_PATH,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reason})});}catch{}",
    "setStatus('stopped \\u00b7 '+reason);",
    "}",
    "async function sendCurrentFrame(){",
    "if(!stream||sending)return;",
    "const videoTrack=stream.getVideoTracks()[0];",
    "if(!videoTrack)return;",
    "const vw=preview.videoWidth||0;const vh=preview.videoHeight||0;",
    "if(vw<2||vh<2)return;",
    "const effectiveMaxWidth=Math.max(MIN_DYNAMIC_WIDTH,Math.floor(dynamicMaxWidth));",
    "const scale=Math.min(1,effectiveMaxWidth/vw);",
    "canvas.width=Math.max(2,Math.floor(vw*scale));",
    "canvas.height=Math.max(2,Math.floor(vh*scale));",
    "ctx.drawImage(preview,0,0,canvas.width,canvas.height);",
    "sending=true;",
    "try{",
    "const blob=await new Promise((r)=>canvas.toBlob(r,'image/jpeg',dynamicJpegQuality));",
    "if(!blob)throw new Error('frame_encode_failed');",
    "const dataUrl=await new Promise((r,j)=>{const f=new FileReader();f.onload=()=>r(String(f.result||''));f.onerror=()=>j(new Error('read_failed'));f.readAsDataURL(blob);});",
    "const base64=String(dataUrl).split(',')[1]||'';",
    "const res=await fetch(FRAME_API_PATH,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mimeType:'image/jpeg',dataBase64:base64,source:'share_page'})});",
    "let body={};try{body=await res.json();}catch{}",
    "if(!res.ok||body.accepted===false){",
    "const rejectionReason=String(body.reason||res.status||'unknown').trim();",
    "if(TERMINAL_REASONS.has(rejectionReason)){",
    "await stopShare('session_closed_'+rejectionReason,{allowRestart:false,nextState:'expired'});",
    "setStatus('session ended \\u00b7 '+rejectionReason);",
    "return;",
    "}",
    "if(rejectionReason==='frame_too_large'){",
    "const previousWidth=Math.max(MIN_DYNAMIC_WIDTH,Math.floor(dynamicMaxWidth));",
    "const previousQuality=dynamicJpegQuality;",
    "dynamicMaxWidth=Math.max(MIN_DYNAMIC_WIDTH,Math.floor(dynamicMaxWidth*DOWNSCALE_MULTIPLIER));",
    "dynamicJpegQuality=Math.max(MIN_DYNAMIC_JPEG_QUALITY,Number((dynamicJpegQuality-0.04).toFixed(2)));",
    "adaptiveSuccessFrames=0;",
    "const widthChanged=dynamicMaxWidth<previousWidth;",
    "const qualityChanged=dynamicJpegQuality<previousQuality;",
    "if(widthChanged||qualityChanged){",
    "setStatus('frame too large \\u00b7 auto downscaled to '+String(dynamicMaxWidth)+'px @ q'+String(dynamicJpegQuality));",
    "}else{",
    "setStatus('frame too large \\u00b7 already at minimum scale');",
    "}",
    "return;",
    "}",
    "setStatus('frame rejected \\u00b7 '+rejectionReason);",
    "return;",
    "}",
    "frameCount++;fcntEl.textContent=String(frameCount);",
    "adaptiveSuccessFrames++;",
    "if(adaptiveSuccessFrames>=UPSCALE_SUCCESS_FRAMES&&(dynamicMaxWidth<MAX_WIDTH||dynamicJpegQuality<JPEG_QUALITY)){",
    "const nextWidth=Math.min(MAX_WIDTH,Math.floor(dynamicMaxWidth*UPSCALE_MULTIPLIER));",
    "const nextQuality=Math.min(JPEG_QUALITY,Number((dynamicJpegQuality+0.02).toFixed(2)));",
    "if(nextWidth>dynamicMaxWidth||nextQuality>dynamicJpegQuality){",
    "dynamicMaxWidth=nextWidth;",
    "dynamicJpegQuality=nextQuality;",
    "}",
    "adaptiveSuccessFrames=0;",
    "}",
    "setStatus('sharing live \\u00b7 '+new Date().toLocaleTimeString());",
    "}catch(err){setStatus('send error \\u00b7 '+(err&&err.message?err.message:String(err)));}",
    "finally{sending=false;}",
    "}",
    "startBtn.addEventListener('click',async()=>{",
    "if(stream)return;",
    "try{",
    "stream=await navigator.mediaDevices.getDisplayMedia({video:{frameRate:2},audio:false});",
    "preview.srcObject=stream;",
    "if (placeholder) {",
    "  placeholder.style.display='none';",
    "}",
    "await preview.play();",
    "for(const track of stream.getVideoTracks()){track.addEventListener('ended',()=>{stopShare('browser_stream_ended');});}",
    "startBtn.disabled=true;",
    "stopBtn.disabled=false;",
    "dynamicMaxWidth=MAX_WIDTH;",
    "dynamicJpegQuality=JPEG_QUALITY;",
    "adaptiveSuccessFrames=0;",
    "setState('sharing');",
    "setStatus('capturing screen...');",
    "timer=setInterval(sendCurrentFrame,FRAME_INTERVAL_MS);",
    "sendCurrentFrame();",
    "}catch(err){",
    "stream=null;",
    "setStatus('start failed \\u00b7 '+(err&&err.message?err.message:String(err)));",
    "}",
    "});",
    "stopBtn.addEventListener('click',()=>stopShare('manual_stop'));",
    "</script>",
    "</body>",
    "</html>"
  ].join("");
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeJsString(value) {
  return String(value || "")
    .replaceAll("\\", "\\\\")
    .replaceAll("'", "\\'")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("</", "<\\/");
}

function safeUrlHost(rawUrl) {
  const text = String(rawUrl || "").trim();
  if (!text) return "";
  try {
    return String(new URL(text).host || "").trim().slice(0, 160);
  } catch {
    return "";
  }
}

function normalizeShareBaseUrl(rawUrl) {
  const text = String(rawUrl || "").trim().replace(/\/$/, "");
  if (!text) return "";
  try {
    const parsed = new URL(text);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "";
  }
}

function getLocalShareBaseUrl(appConfig) {
  const configuredPort = Number(appConfig?.dashboardPort);
  const port =
    Number.isFinite(configuredPort) && configuredPort >= 1 && configuredPort <= 65535
      ? Math.floor(configuredPort)
      : 8787;
  return `http://127.0.0.1:${port}`;
}

function escapeHtmlAttr(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("\"", "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("'", "&#39;");
}

function resolveDashboardThemeHref() {
  if (dashboardThemeResolved) {
    return cachedDashboardThemeHref;
  }
  dashboardThemeResolved = true;
  cachedDashboardThemeHref = resolveDashboardThemeHrefFromDist();
  return cachedDashboardThemeHref;
}

function resolveDashboardThemeHrefFromDist() {
  try {
    const entries = fs.readdirSync(DASHBOARD_ASSET_DIR);
    for (const filename of entries) {
      if (
        String(filename).startsWith(DASHBOARD_STYLESHEET_PREFIX) &&
        String(filename).endsWith(DASHBOARD_STYLESHEET_SUFFIX)
      ) {
        return `/assets/${filename}`;
      }
    }
  } catch {
    /* ignore */
  }
  return "";
}
