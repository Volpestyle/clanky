import type { BrowserManager } from "../services/BrowserManager.ts";
import { BrowserSessionVideoSource } from "../services/browserSessionVideoSource.ts";
import { isAbortError, throwIfAborted } from "../tools/browserTaskRuntime.ts";
import { ensureStreamPublishState, startBrowserStreamPublish, stopBrowserStreamPublish } from "./voiceStreamPublish.ts";
import type { VoiceSessionStreamPublishState } from "./voiceSessionTypes.ts";

type BrowserStreamPublishSession = {
  id?: string | null;
  guildId?: string | null;
  textChannelId?: string | null;
  voiceChannelId?: string | null;
  ending?: boolean;
  cleanupHandlers?: Array<() => void>;
  streamPublish?: VoiceSessionStreamPublishState | null;
  voxClient?: {
    streamPublishBrowserFrame?: (payload: {
      mimeType?: string;
      frameBase64: string;
      capturedAtMs?: number;
    }) => void;
  } | null;
};

export type BrowserStreamPublishManager = {
  browserManager?: BrowserManager | null;
  subAgentSessions?: {
    get: (sessionId: string) => {
      ownerUserId?: string | null;
      getBrowserSessionKey?: () => string | null;
    } | null | undefined;
  } | null;
  sessions: Map<string, BrowserStreamPublishSession>;
  client: {
    user?: {
      id?: string | null;
    } | null;
  };
  store: {
    getSettings?: () => Record<string, unknown> | null;
    logAction: (entry: Record<string, unknown>) => void;
  };
};

type ActiveBrowserStreamPublishRuntime = {
  guildId: string;
  browserSessionId: string;
  browserSessionKey: string;
  abortController: AbortController;
  runPromise: Promise<void>;
};

const STREAM_PUBLISH_READY_TIMEOUT_MS = 15_000;
const STREAM_PUBLISH_READY_POLL_MS = 100;
const BROWSER_STREAM_PUBLISH_RUNTIME_MAP = new WeakMap<object, Map<string, ActiveBrowserStreamPublishRuntime>>();

function getBrowserStreamPublishRuntimeMap(manager: object) {
  let runtimeMap = BROWSER_STREAM_PUBLISH_RUNTIME_MAP.get(manager);
  if (!runtimeMap) {
    runtimeMap = new Map();
    BROWSER_STREAM_PUBLISH_RUNTIME_MAP.set(manager, runtimeMap);
  }
  return runtimeMap;
}

function parseInlineImageDataUrl(imageDataUrl: string) {
  const normalized = String(imageDataUrl || "").trim();
  const commaIndex = normalized.indexOf(",");
  if (!normalized.startsWith("data:") || commaIndex <= 5) {
    return {
      ok: false as const,
      error: "browser_stream_publish_frame_invalid_data_url"
    };
  }
  const header = normalized.slice(5, commaIndex).trim();
  const payload = normalized.slice(commaIndex + 1).trim();
  const [mimeTypeRaw, ...directives] = header.split(";");
  const mimeType = String(mimeTypeRaw || "").trim().toLowerCase();
  if (!mimeType || mimeType !== "image/png") {
    return {
      ok: false as const,
      error: "browser_stream_publish_only_supports_png"
    };
  }
  if (!directives.some((directive) => directive.trim().toLowerCase() === "base64")) {
    return {
      ok: false as const,
      error: "browser_stream_publish_frame_missing_base64"
    };
  }
  if (!payload) {
    return {
      ok: false as const,
      error: "browser_stream_publish_frame_empty"
    };
  }
  return {
    ok: true as const,
    mimeType,
    frameBase64: payload
  };
}

async function waitForStreamPublishReady(
  session: BrowserStreamPublishSession,
  signal?: AbortSignal,
  timeoutMs = STREAM_PUBLISH_READY_TIMEOUT_MS
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    throwIfAborted(signal, "Browser stream publish cancelled");
    const state = ensureStreamPublishState(session);
    const status = String(state?.transportStatus || "").trim().toLowerCase();
    if (
      Number(state?.transportConnectedAt || 0) > 0 &&
      status !== "failed" &&
      status !== "disconnected" &&
      status !== "stream_create_failed"
    ) {
      return { ok: true as const };
    }
    if (status === "failed" || status === "disconnected" || status === "stream_create_failed") {
      return {
        ok: false as const,
        error: String(state?.transportReason || status || "stream_publish_transport_failed")
      };
    }
    await new Promise((resolve) => setTimeout(resolve, STREAM_PUBLISH_READY_POLL_MS));
  }
  return {
    ok: false as const,
    error: "stream_publish_transport_ready_timeout"
  };
}

async function stopBrowserStreamPublishRuntime(
  manager: BrowserStreamPublishManager,
  guildId: string
) {
  const runtimeMap = getBrowserStreamPublishRuntimeMap(manager);
  const runtime = runtimeMap.get(guildId);
  if (!runtime) return false;
  runtimeMap.delete(guildId);
  if (!runtime.abortController.signal.aborted) {
    runtime.abortController.abort("browser_stream_publish_runtime_stopped");
  }
  await runtime.runPromise.catch(() => undefined);
  return true;
}

export async function startBrowserSessionStreamPublish(
  manager: BrowserStreamPublishManager,
  {
    guildId,
    browserSessionId,
    requesterUserId = null,
    source = "browser_session_stream_publish",
    signal
  }: {
    guildId: string;
    browserSessionId: string;
    requesterUserId?: string | null;
    source?: string | null;
    signal?: AbortSignal;
  }
) {
  throwIfAborted(signal, "Browser stream publish cancelled");

  const normalizedGuildId = String(guildId || "").trim();
  const normalizedBrowserSessionId = String(browserSessionId || "").trim();
  if (!normalizedGuildId) {
    return { ok: false, started: false, error: "voice_session_missing" };
  }
  if (!normalizedBrowserSessionId) {
    return { ok: false, started: false, error: "browser_session_id_required" };
  }
  if (!manager.browserManager) {
    return { ok: false, started: false, error: "browser_unavailable" };
  }

  const session = manager.sessions.get(normalizedGuildId) || null;
  if (!session || session.ending) {
    return { ok: false, started: false, error: "voice_session_missing" };
  }
  if (!session.voxClient || typeof session.voxClient.streamPublishBrowserFrame !== "function") {
    return { ok: false, started: false, error: "stream_publish_browser_transport_unavailable" };
  }

  const browserSession = manager.subAgentSessions?.get(normalizedBrowserSessionId) || null;
  if (!browserSession) {
    return { ok: false, started: false, error: "browser_session_not_found" };
  }
  if (browserSession.ownerUserId && requesterUserId && browserSession.ownerUserId !== requesterUserId) {
    return { ok: false, started: false, error: "browser_session_not_owned_by_requester" };
  }

  const browserSessionKey = String(browserSession.getBrowserSessionKey?.() || "").trim();
  if (!browserSessionKey) {
    return { ok: false, started: false, error: "browser_session_share_source_unavailable" };
  }

  const runtimeMap = getBrowserStreamPublishRuntimeMap(manager);
  const existingRuntime = runtimeMap.get(normalizedGuildId) || null;
  if (existingRuntime?.browserSessionId === normalizedBrowserSessionId) {
    return {
      ok: true,
      started: true,
      reused: true,
      browserSessionId: normalizedBrowserSessionId
    };
  }
  if (existingRuntime) {
    await stopBrowserStreamPublishRuntime(manager, normalizedGuildId);
  }

  const startResult = startBrowserStreamPublish(manager, {
    guildId: normalizedGuildId,
    browserSessionId: normalizedBrowserSessionId,
    source
  });
  if (!startResult?.ok) {
    return {
      ok: false,
      started: false,
      error: String(startResult?.reason || "stream_publish_start_failed")
    };
  }

  const readyResult = await waitForStreamPublishReady(session, signal);
  if (!readyResult.ok) {
    stopBrowserStreamPublish(manager, {
      guildId: normalizedGuildId,
      reason: readyResult.error
    });
    return {
      ok: false,
      started: false,
      error: readyResult.error
    };
  }

  const abortController = new AbortController();
  const runtimeSignal = signal
    ? AbortSignal.any([abortController.signal, signal])
    : abortController.signal;
  let emittedFrameCount = 0;

  const videoSource = new BrowserSessionVideoSource({
    browserManager: manager.browserManager,
    sessionKey: browserSessionKey,
    signal: runtimeSignal,
    onFrame: async (frame) => {
      const decodedFrame = parseInlineImageDataUrl(frame.imageDataUrl);
      if (!decodedFrame.ok) {
        throw new Error(decodedFrame.error);
      }
      session.voxClient?.streamPublishBrowserFrame?.({
        mimeType: decodedFrame.mimeType,
        frameBase64: decodedFrame.frameBase64,
        capturedAtMs: frame.capturedAt
      });
      const state = ensureStreamPublishState(session);
      if (state) {
        state.sourceUrl = frame.currentUrl || null;
        state.sourceLabel = frame.currentUrl || state.sourceLabel || normalizedBrowserSessionId;
      }
      emittedFrameCount += 1;
      if (emittedFrameCount === 1) {
        manager.store.logAction({
          kind: "voice_runtime",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: manager.client.user?.id || null,
          content: "browser_stream_publish_first_frame_forwarded",
          metadata: {
            sessionId: session.id,
            browserSessionId: normalizedBrowserSessionId,
            currentUrl: frame.currentUrl,
            source
          }
        });
      }
    },
    onError: async (error) => {
      throw error instanceof Error ? error : new Error(String(error));
    }
  });

  const runtime: ActiveBrowserStreamPublishRuntime = {
    guildId: normalizedGuildId,
    browserSessionId: normalizedBrowserSessionId,
    browserSessionKey,
    abortController,
    runPromise: Promise.resolve()
  };

  runtime.runPromise = videoSource.run()
    .catch(async (error: unknown) => {
      if (isAbortError(error) || runtimeSignal.aborted) return;
      manager.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: manager.client.user?.id || null,
        content: `browser_stream_publish_capture_failed: ${String(error instanceof Error ? error.message : error)}`,
        metadata: {
          sessionId: session.id,
          browserSessionId: normalizedBrowserSessionId,
          source
        }
      });
      await stopBrowserSessionStreamPublish(manager, {
        guildId: normalizedGuildId,
        reason: "browser_stream_publish_capture_failed"
      });
    })
    .finally(() => {
      const currentRuntime = runtimeMap.get(normalizedGuildId);
      if (currentRuntime === runtime) {
        runtimeMap.delete(normalizedGuildId);
      }
    });

  runtimeMap.set(normalizedGuildId, runtime);
  if (Array.isArray(session.cleanupHandlers)) {
    session.cleanupHandlers.push(() => {
      void stopBrowserSessionStreamPublish(manager, {
        guildId: normalizedGuildId,
        reason: "voice_session_cleanup"
      });
    });
  }

  manager.store.logAction({
    kind: "voice_runtime",
    guildId: session.guildId,
    channelId: session.textChannelId,
    userId: manager.client.user?.id || null,
    content: "browser_stream_publish_started",
    metadata: {
      sessionId: session.id,
      browserSessionId: normalizedBrowserSessionId,
      source,
      reused: false
    }
  });

  return {
    ok: true,
    started: true,
    reused: false,
    browserSessionId: normalizedBrowserSessionId
  };
}

export async function stopBrowserSessionStreamPublish(
  manager: BrowserStreamPublishManager,
  {
    guildId,
    reason = "browser_stream_share_stopped"
  }: {
    guildId: string;
    reason?: string | null;
  }
) {
  const normalizedGuildId = String(guildId || "").trim();
  if (!normalizedGuildId) {
    return { ok: false, reason: "voice_session_missing" };
  }

  const session = manager.sessions.get(normalizedGuildId) || null;
  await stopBrowserStreamPublishRuntime(manager, normalizedGuildId);
  const stopResult = stopBrowserStreamPublish(manager, {
    guildId: normalizedGuildId,
    reason
  });

  if (session) {
    manager.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: manager.client.user?.id || null,
      content: "browser_stream_publish_share_stopped",
      metadata: {
        sessionId: session.id,
        reason
      }
    });
  }

  return stopResult;
}
