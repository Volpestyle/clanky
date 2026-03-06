import {
  BARGE_IN_FULL_OVERRIDE_MIN_MS,
  BARGE_IN_RETRY_MAX_AGE_MS,
  STT_REPLY_MAX_CHARS
} from "./voiceSessionManager.constants.ts";
import { isRealtimeMode, normalizeVoiceText } from "./voiceSessionHelpers.ts";
import type {
  DeferredQueuedUserTurn,
  DeferredQueuedUserTurnsAction,
  DeferredVoiceAction,
  DeferredVoiceActionType,
  OutputChannelState,
  VoiceSession
} from "./voiceSessionTypes.ts";

interface DeferredActionInput {
  type?: string;
  goal?: string;
  freshnessPolicy?: string;
  status?: string;
  notBeforeAt?: number;
  expiresAt?: number;
  reason?: string;
  payload?: Record<string, unknown>;
}

interface DeferredInterruptedReplyContext {
  userId?: string | null;
  pcmBuffer?: Buffer | Uint8Array | null;
  captureReason?: string | null;
}

type DeferredQueueStoreLike = {
  logAction: (entry: {
    kind: string;
    guildId?: string | null;
    channelId?: string | null;
    userId?: string | null;
    content: string;
    metadata?: Record<string, unknown>;
  }) => void;
};

export interface DeferredActionQueueHost {
  client: {
    user?: {
      id?: string | null;
    } | null;
  };
  store: DeferredQueueStoreLike;
  getOutputChannelState: (session: VoiceSession) => OutputChannelState;
  scheduleDeferredBotTurnOpenFlush: (args: {
    session: VoiceSession;
    delayMs?: number;
    reason?: string;
  }) => void;
  flushDeferredBotTurnOpenTurns: (args: {
    session: VoiceSession;
    deferredTurns?: DeferredQueuedUserTurn[] | null;
    reason?: string;
  }) => Promise<void> | void;
  normalizeReplyInterruptionPolicy: (rawPolicy?: unknown) => unknown;
  requestRealtimeTextUtterance: (args: {
    session: VoiceSession;
    text: string;
    userId?: string | null;
    source?: string;
    interruptionPolicy?: unknown;
    latencyContext?: Record<string, unknown> | null;
  }) => boolean;
  estimatePcm16MonoDurationMs: (pcmByteLength: number, sampleRateHz?: number) => number;
}

export class DeferredActionQueue {
  constructor(private readonly host: DeferredActionQueueHost) {}

  getDeferredOutputChannelBlockReason(session: VoiceSession | null | undefined) {
    return this.host.getOutputChannelState(session as VoiceSession).deferredBlockReason;
  }

  getDeferredVoiceActions(session: VoiceSession | null | undefined) {
    if (!session || typeof session !== "object") return {};
    const existing = session.deferredVoiceActions;
    if (existing && typeof existing === "object") {
      return existing;
    }
    const actions = {};
    session.deferredVoiceActions = actions;
    return actions;
  }

  getDeferredVoiceActionTimers(session: VoiceSession | null | undefined) {
    if (!session || typeof session !== "object") return {};
    const existing = session.deferredVoiceActionTimers;
    if (existing && typeof existing === "object") {
      return existing;
    }
    const timers = {};
    session.deferredVoiceActionTimers = timers;
    return timers;
  }

  getDeferredVoiceAction(session: VoiceSession | null | undefined, type: string) {
    if (!session) return null;
    const actions = this.getDeferredVoiceActions(session);
    const action = actions[type];
    return action && typeof action === "object" ? action : null;
  }

  upsertDeferredVoiceAction(session: VoiceSession, actionInput: DeferredActionInput = {}) {
    if (!session || session.ending) return null;
    const normalizedType = String(actionInput.type || "").trim();
    if (!normalizedType) return null;
    const now = Date.now();
    const actions = this.getDeferredVoiceActions(session);
    const existing = this.getDeferredVoiceAction(session, normalizedType);
    const action = {
      type: normalizedType,
      goal: String(actionInput.goal || existing?.goal || "").trim() || normalizedType,
      freshnessPolicy: String(actionInput.freshnessPolicy || existing?.freshnessPolicy || "regenerate_from_goal").trim(),
      status: actionInput.status === "scheduled" ? "scheduled" : "deferred",
      createdAt: Math.max(0, Number(existing?.createdAt || 0)) || now,
      updatedAt: now,
      notBeforeAt: Math.max(0, Number(actionInput.notBeforeAt ?? existing?.notBeforeAt ?? 0)),
      expiresAt: Math.max(0, Number(actionInput.expiresAt ?? existing?.expiresAt ?? 0)),
      reason: String(actionInput.reason || existing?.reason || "deferred").trim() || "deferred",
      revision: Math.max(0, Number(existing?.revision || 0)) + 1,
      payload:
        actionInput.payload && typeof actionInput.payload === "object"
          ? actionInput.payload
          : existing?.payload && typeof existing.payload === "object"
            ? existing.payload
            : {}
    };
    actions[normalizedType] = action;
    return action;
  }

  setDeferredVoiceAction(session: VoiceSession, payload: DeferredActionInput = {}) {
    return this.upsertDeferredVoiceAction(session, payload);
  }

  getDeferredQueuedUserTurnsAction(session: VoiceSession): DeferredQueuedUserTurnsAction | null {
    const action = this.getDeferredVoiceAction(session, "queued_user_turns");
    if (!action || typeof action !== "object") return null;
    const payload = action.payload && typeof action.payload === "object" ? action.payload : null;
    if (!payload || !Array.isArray(payload.turns)) return null;
    return action as DeferredQueuedUserTurnsAction;
  }

  getDeferredQueuedUserTurns(session: VoiceSession): DeferredQueuedUserTurn[] {
    const action = this.getDeferredQueuedUserTurnsAction(session);
    return Array.isArray(action?.payload?.turns) ? action.payload.turns : [];
  }

  clearDeferredVoiceActionTimer(session: VoiceSession, type: string) {
    if (!session) return;
    const timers = this.getDeferredVoiceActionTimers(session);
    const timer = timers[type];
    if (timer) {
      clearTimeout(timer);
    }
    timers[type] = null;
  }

  clearDeferredVoiceAction(session: VoiceSession, type: string) {
    if (!session) return;
    const normalizedType = String(type || "").trim();
    if (!normalizedType) return;
    this.clearDeferredVoiceActionTimer(session, normalizedType);
    const actions = this.getDeferredVoiceActions(session);
    delete actions[normalizedType];
  }

  clearAllDeferredVoiceActions(session: VoiceSession) {
    if (!session) return;
    const actions = this.getDeferredVoiceActions(session);
    for (const type of Object.keys(actions)) {
      this.clearDeferredVoiceAction(session, type);
    }
  }

  scheduleDeferredVoiceActionRecheck(
    session: VoiceSession,
    {
      type,
      delayMs = 0,
      reason = "scheduled_recheck"
    }: {
      type: DeferredVoiceActionType;
      delayMs?: number;
      reason?: string;
    }
  ) {
    if (!session || session.ending) return;
    const normalizedType = type;
    const action = this.getDeferredVoiceAction(session, normalizedType);
    if (!action) return;
    this.clearDeferredVoiceActionTimer(session, normalizedType);
    const timers = this.getDeferredVoiceActionTimers(session);
    timers[normalizedType] = setTimeout(() => {
      timers[normalizedType] = null;
      this.recheckDeferredVoiceActions({
        session,
        reason,
        preferredTypes: [normalizedType]
      });
    }, Math.max(0, Number(delayMs) || 0));
  }

  canFireDeferredAction(session: VoiceSession | null, action: DeferredVoiceAction | null): string | null {
    if (!session || session.ending) return "session_inactive";
    if (!action) return "no_action";

    const now = Date.now();
    const expiresAt = Math.max(0, Number(action.expiresAt || 0));
    if (expiresAt > 0 && now >= expiresAt) return "expired";

    const notBeforeAt = Math.max(0, Number(action.notBeforeAt || 0));
    if (notBeforeAt > now) return "not_before_at";

    return this.host.getOutputChannelState(session).deferredBlockReason;
  }

  recheckDeferredVoiceActions({
    session,
    reason = "manual",
    preferredTypes = null,
    context = null
  }: {
    session: VoiceSession;
    reason?: string;
    preferredTypes?: DeferredVoiceActionType[] | null;
    context?: DeferredInterruptedReplyContext | null;
  }) {
    if (!session || session.ending) return false;
    const actionPriority: DeferredVoiceActionType[] = ["interrupted_reply", "queued_user_turns"];
    const knownActions = this.getDeferredVoiceActions(session);
    const types = Array.isArray(preferredTypes) && preferredTypes.length > 0
      ? preferredTypes
      : actionPriority.filter((type) => Boolean(knownActions[type]));

    for (const type of types) {
      const action = type === "queued_user_turns"
        ? this.getDeferredQueuedUserTurnsAction(session)
        : this.getDeferredVoiceAction(session, type);
      if (!action) continue;

      const blockReason = this.canFireDeferredAction(session, action as DeferredVoiceAction);

      if (blockReason === "not_before_at") {
        const delayMs = Math.max(0, Number(action.notBeforeAt || 0) - Date.now());
        if (type === "queued_user_turns") {
          this.host.scheduleDeferredBotTurnOpenFlush({ session, delayMs, reason });
        } else {
          this.scheduleDeferredVoiceActionRecheck(session, { type, delayMs, reason });
        }
        continue;
      }

      if (blockReason === "expired") {
        this.clearDeferredVoiceAction(session, type);
        continue;
      }

      if (blockReason) {
        if (type === "queued_user_turns") {
          this.host.scheduleDeferredBotTurnOpenFlush({ session, reason });
        }
        continue;
      }

      switch (type) {
        case "queued_user_turns":
          if (this.fireDeferredQueuedUserTurns(session, action as DeferredQueuedUserTurnsAction, reason)) return true;
          break;
        case "interrupted_reply":
          if (this.fireDeferredInterruptedReply(session, action as DeferredVoiceAction, reason, context)) return true;
          break;
      }
    }
    return false;
  }

  fireDeferredQueuedUserTurns(session: VoiceSession, action: DeferredQueuedUserTurnsAction, reason: string) {
    const pendingQueue = Array.isArray(action?.payload?.turns)
      ? action.payload.turns
      : [];
    if (!pendingQueue.length) {
      this.clearDeferredVoiceAction(session, "queued_user_turns");
      return false;
    }

    const outputChannelState = this.host.getOutputChannelState(session);
    if (outputChannelState.locked) {
      this.host.scheduleDeferredBotTurnOpenFlush({ session, reason });
      return false;
    }

    this.clearDeferredVoiceAction(session, "queued_user_turns");
    void Promise.resolve(this.host.flushDeferredBotTurnOpenTurns({
      session,
      deferredTurns: pendingQueue,
      reason
    })).catch(() => undefined);
    return true;
  }

  fireDeferredInterruptedReply(
    session: VoiceSession,
    action: DeferredVoiceAction,
    _reason: string,
    context: DeferredInterruptedReplyContext | null | undefined
  ) {
    if (!isRealtimeMode(session.mode)) {
      this.clearDeferredVoiceAction(session, "interrupted_reply");
      return false;
    }

    const interruptedPayload =
      action?.type === "interrupted_reply" && action.payload && typeof action.payload === "object"
        ? action.payload
        : null;
    if (!interruptedPayload) {
      this.clearDeferredVoiceAction(session, "interrupted_reply");
      return false;
    }

    const interruptedAt = Math.max(0, Number(interruptedPayload.interruptedAt || 0));
    const now = Date.now();
    if (!interruptedAt || now - interruptedAt > BARGE_IN_RETRY_MAX_AGE_MS) {
      this.clearDeferredVoiceAction(session, "interrupted_reply");
      return false;
    }

    const normalizedUserId = String(context?.userId || "").trim();
    const interruptedByUserId = String(interruptedPayload.interruptedByUserId || "").trim();
    if (!normalizedUserId || !interruptedByUserId || normalizedUserId !== interruptedByUserId) {
      return false;
    }

    const sampleRateHz = Number(session.realtimeInputSampleRateHz) || 24000;
    const captureByteLength = Buffer.isBuffer(context?.pcmBuffer)
      ? context.pcmBuffer.length
      : Buffer.from(context?.pcmBuffer || []).length;
    const bargeDurationMs = this.host.estimatePcm16MonoDurationMs(captureByteLength, sampleRateHz);
    const fullOverride = bargeDurationMs >= BARGE_IN_FULL_OVERRIDE_MIN_MS;
    if (fullOverride) {
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: normalizedUserId,
        content: "voice_barge_in_retry_skipped_full_override",
        metadata: {
          sessionId: session.id,
          captureReason: String(context?.captureReason || "stream_end"),
          bargeDurationMs,
          fullOverrideMinMs: BARGE_IN_FULL_OVERRIDE_MIN_MS
        }
      });
      this.clearDeferredVoiceAction(session, "interrupted_reply");
      return false;
    }

    const retryText = normalizeVoiceText(interruptedPayload.utteranceText || "", STT_REPLY_MAX_CHARS);
    const interruptionPolicy = this.host.normalizeReplyInterruptionPolicy(
      interruptedPayload.interruptionPolicy
    );
    if (!retryText) {
      this.clearDeferredVoiceAction(session, "interrupted_reply");
      return false;
    }

    const retried = this.host.requestRealtimeTextUtterance({
      session,
      text: retryText,
      userId: this.host.client.user?.id || null,
      source: "barge_in_retry",
      interruptionPolicy
    });
    if (!retried) return false;

    this.clearDeferredVoiceAction(session, "interrupted_reply");
    this.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: normalizedUserId,
      content: "voice_barge_in_retry_requested",
      metadata: {
        sessionId: session.id,
        captureReason: String(context?.captureReason || "stream_end"),
        bargeDurationMs
      }
    });
    return true;
  }

  private get store() {
    return this.host.store;
  }
}
