import { createHash } from "node:crypto";
import type { BrowserManager } from "./BrowserManager.ts";

type BrowserSessionVideoFrameReason = "initial" | "activity" | "poll" | "heartbeat";

type BrowserSessionVideoFrame = {
  sessionKey: string;
  sequence: number;
  capturedAt: number;
  imageDataUrl: string;
  currentUrl: string | null;
  changed: boolean;
  reason: BrowserSessionVideoFrameReason;
};

type BrowserCaptureRuntime = Pick<BrowserManager, "screenshot" | "currentUrl">;

type BrowserSessionVideoSourceOptions = {
  browserManager: BrowserCaptureRuntime;
  sessionKey: string;
  onFrame: (frame: BrowserSessionVideoFrame) => void | Promise<void>;
  onError?: (error: unknown) => void | Promise<void>;
  stepTimeoutMs?: number;
  activeFramesPerSecond?: number;
  idleFramesPerSecond?: number;
  heartbeatIntervalMs?: number;
  activityBurstMs?: number;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

type BrowserSessionVideoSourceState = {
  sequence: number;
  lastFrameSignature: string | null;
  lastFrameUrl: string | null;
  lastEmitAt: number | null;
  lastActivityAt: number;
};

const DEFAULT_ACTIVE_FRAMES_PER_SECOND = 8;
const DEFAULT_IDLE_FRAMES_PER_SECOND = 2;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
const DEFAULT_ACTIVITY_BURST_MS = 2_500;
const DEFAULT_STEP_TIMEOUT_MS = 15_000;

function normalizeFramesPerSecond(value: number | undefined, fallback: number) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) return fallback;
  return Math.min(30, Math.max(1, Math.round(normalized)));
}

function normalizeDurationMs(value: number | undefined, fallback: number) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) return fallback;
  return Math.round(normalized);
}

function frameSignature(imageDataUrl: string) {
  return createHash("sha1").update(String(imageDataUrl || "")).digest("hex");
}

export function computeBrowserSessionCaptureDelayMs(
  now: number,
  lastActivityAt: number,
  {
    activeFramesPerSecond = DEFAULT_ACTIVE_FRAMES_PER_SECOND,
    idleFramesPerSecond = DEFAULT_IDLE_FRAMES_PER_SECOND,
    activityBurstMs = DEFAULT_ACTIVITY_BURST_MS
  }: {
    activeFramesPerSecond?: number;
    idleFramesPerSecond?: number;
    activityBurstMs?: number;
  } = {}
) {
  const burstWindowMs = normalizeDurationMs(activityBurstMs, DEFAULT_ACTIVITY_BURST_MS);
  const activeFps = normalizeFramesPerSecond(
    activeFramesPerSecond,
    DEFAULT_ACTIVE_FRAMES_PER_SECOND
  );
  const idleFps = normalizeFramesPerSecond(idleFramesPerSecond, DEFAULT_IDLE_FRAMES_PER_SECOND);
  const inBurst = now - lastActivityAt <= burstWindowMs;
  const fps = inBurst ? activeFps : idleFps;
  return Math.max(1, Math.round(1_000 / fps));
}

export function shouldEmitBrowserSessionVideoFrame(
  state: Pick<
    BrowserSessionVideoSourceState,
    "lastEmitAt" | "lastFrameSignature" | "lastFrameUrl" | "lastActivityAt"
  >,
  {
    capturedAt,
    signature,
    currentUrl,
    heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
    activityBurstMs = DEFAULT_ACTIVITY_BURST_MS
  }: {
    capturedAt: number;
    signature: string;
    currentUrl: string | null;
    heartbeatIntervalMs?: number;
    activityBurstMs?: number;
  }
): { emit: boolean; changed: boolean; reason: BrowserSessionVideoFrameReason } {
  const lastEmitAt = state.lastEmitAt;
  if (lastEmitAt === null) {
    return { emit: true, changed: true, reason: "initial" };
  }

  const changed = state.lastFrameSignature !== signature || state.lastFrameUrl !== currentUrl;
  if (changed) {
    const inBurst =
      capturedAt - state.lastActivityAt <=
      normalizeDurationMs(activityBurstMs, DEFAULT_ACTIVITY_BURST_MS);
    return {
      emit: true,
      changed: true,
      reason: inBurst ? "activity" : "poll"
    };
  }

  const heartbeatMs = normalizeDurationMs(
    heartbeatIntervalMs,
    DEFAULT_HEARTBEAT_INTERVAL_MS
  );
  if (capturedAt - lastEmitAt >= heartbeatMs) {
    return { emit: true, changed: false, reason: "heartbeat" };
  }

  return { emit: false, changed: false, reason: "poll" };
}

async function defaultSleep(ms: number, signal?: AbortSignal) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("browser_session_video_aborted");
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      reject(
        signal?.reason instanceof Error
          ? signal.reason
          : new Error("browser_session_video_aborted")
      );
    };

    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class BrowserSessionVideoSource {
  private readonly browserManager: BrowserCaptureRuntime;
  private readonly sessionKey: string;
  private readonly onFrame: BrowserSessionVideoSourceOptions["onFrame"];
  private readonly onError: BrowserSessionVideoSourceOptions["onError"];
  private readonly stepTimeoutMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly activityBurstMs: number;
  private readonly activeFramesPerSecond: number;
  private readonly idleFramesPerSecond: number;
  private readonly signal?: AbortSignal;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly state: BrowserSessionVideoSourceState;

  constructor(options: BrowserSessionVideoSourceOptions) {
    this.browserManager = options.browserManager;
    this.sessionKey = String(options.sessionKey || "").trim();
    this.onFrame = options.onFrame;
    this.onError = options.onError;
    this.stepTimeoutMs = normalizeDurationMs(
      options.stepTimeoutMs,
      DEFAULT_STEP_TIMEOUT_MS
    );
    this.heartbeatIntervalMs = normalizeDurationMs(
      options.heartbeatIntervalMs,
      DEFAULT_HEARTBEAT_INTERVAL_MS
    );
    this.activityBurstMs = normalizeDurationMs(
      options.activityBurstMs,
      DEFAULT_ACTIVITY_BURST_MS
    );
    this.activeFramesPerSecond = normalizeFramesPerSecond(
      options.activeFramesPerSecond,
      DEFAULT_ACTIVE_FRAMES_PER_SECOND
    );
    this.idleFramesPerSecond = normalizeFramesPerSecond(
      options.idleFramesPerSecond,
      DEFAULT_IDLE_FRAMES_PER_SECOND
    );
    this.signal = options.signal;
    this.now = options.now || Date.now;
    this.sleep = options.sleep || defaultSleep;
    this.state = {
      sequence: 0,
      lastFrameSignature: null,
      lastFrameUrl: null,
      lastEmitAt: null,
      lastActivityAt: this.now()
    };
  }

  noteActivity() {
    this.state.lastActivityAt = this.now();
  }

  getState() {
    return {
      ...this.state
    };
  }

  async pollOnce() {
    this.throwIfAborted();

    const capturedAt = this.now();
    const [imageDataUrl, currentUrlResult] = await Promise.all([
      this.browserManager.screenshot(this.sessionKey, this.stepTimeoutMs, this.signal),
      this.browserManager
        .currentUrl(this.sessionKey, this.stepTimeoutMs, this.signal)
        .catch(() => "")
    ]);
    const currentUrl = String(currentUrlResult || "").trim() || null;
    const signature = frameSignature(imageDataUrl);
    const decision = shouldEmitBrowserSessionVideoFrame(this.state, {
      capturedAt,
      signature,
      currentUrl,
      heartbeatIntervalMs: this.heartbeatIntervalMs,
      activityBurstMs: this.activityBurstMs
    });

    if (!decision.emit) {
      return null;
    }

    const frame: BrowserSessionVideoFrame = {
      sessionKey: this.sessionKey,
      sequence: ++this.state.sequence,
      capturedAt,
      imageDataUrl,
      currentUrl,
      changed: decision.changed,
      reason: decision.reason
    };

    this.state.lastFrameSignature = signature;
    this.state.lastFrameUrl = currentUrl;
    this.state.lastEmitAt = capturedAt;

    await this.onFrame(frame);
    return frame;
  }

  async run() {
    while (!this.signal?.aborted) {
      try {
        await this.pollOnce();
      } catch (error) {
        if (this.signal?.aborted) break;
        if (this.onError) {
          await this.onError(error);
        } else {
          throw error;
        }
      }

      const delayMs = computeBrowserSessionCaptureDelayMs(this.now(), this.state.lastActivityAt, {
        activeFramesPerSecond: this.activeFramesPerSecond,
        idleFramesPerSecond: this.idleFramesPerSecond,
        activityBurstMs: this.activityBurstMs
      });
      await this.sleep(delayMs, this.signal);
    }
  }

  private throwIfAborted() {
    if (!this.signal?.aborted) return;
    throw this.signal.reason instanceof Error
      ? this.signal.reason
      : new Error("browser_session_video_aborted");
  }
}
