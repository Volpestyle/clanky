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

const DEFERRED_FLUSH_RETRY_DELAY_MS = 250;

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
    preferredTypes = null
  }: {
    session: VoiceSession;
    reason?: string;
    preferredTypes?: DeferredVoiceActionType[] | null;
  }) {
    if (!session || session.ending) return false;
    const actionPriority: DeferredVoiceActionType[] = ["queued_user_turns"];
    const knownActions = this.getDeferredVoiceActions(session);
    const types = Array.isArray(preferredTypes) && preferredTypes.length > 0
      ? preferredTypes
      : actionPriority.filter((type) => Boolean(knownActions[type]));

    for (const type of types) {
      const action = this.getDeferredQueuedUserTurnsAction(session);
      if (!action) continue;

      const blockReason = this.canFireDeferredAction(session, action as DeferredVoiceAction);

      if (blockReason === "not_before_at") {
        const delayMs = Math.max(0, Number(action.notBeforeAt || 0) - Date.now());
        this.host.scheduleDeferredBotTurnOpenFlush({ session, delayMs, reason });
        continue;
      }

      if (blockReason === "expired") {
        this.clearDeferredVoiceAction(session, type);
        continue;
      }

      if (blockReason) {
        this.host.scheduleDeferredBotTurnOpenFlush({ session, reason });
        continue;
      }

      if (this.fireDeferredQueuedUserTurns(session, action as DeferredQueuedUserTurnsAction, reason)) return true;
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
    this.spawnDeferredQueuedTurnsFlush(session, pendingQueue, reason);
    return true;
  }

  private spawnDeferredQueuedTurnsFlush(
    session: VoiceSession,
    pendingQueue: DeferredQueuedUserTurn[],
    reason: string
  ) {
    const deferredTurns = pendingQueue.slice();
    void Promise.resolve(this.host.flushDeferredBotTurnOpenTurns({
      session,
      deferredTurns,
      reason
    })).catch((error: unknown) => {
      const restoredTurns = [...deferredTurns, ...this.getDeferredQueuedUserTurns(session)];
      const nextFlushAt = Date.now() + DEFERRED_FLUSH_RETRY_DELAY_MS;
      const latestTurn = deferredTurns[deferredTurns.length - 1] || null;
      this.host.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: latestTurn?.userId || this.host.client.user?.id || null,
        content: `deferred_voice_turn_flush_failed: ${String((error as Error)?.message || error)}`,
        metadata: {
          sessionId: session.id,
          reason,
          deferredTurnCount: deferredTurns.length,
          restoredTurnCount: restoredTurns.length
        }
      });
      if (session.ending || !restoredTurns.length) return;
      this.setDeferredVoiceAction(session, {
        type: "queued_user_turns",
        goal: "respond_to_deferred_user_turns",
        freshnessPolicy: "regenerate_from_goal",
        status: "scheduled",
        reason,
        notBeforeAt: nextFlushAt,
        payload: {
          turns: restoredTurns,
          nextFlushAt
        }
      });
      this.scheduleDeferredVoiceActionRecheck(session, {
        type: "queued_user_turns",
        delayMs: DEFERRED_FLUSH_RETRY_DELAY_MS,
        reason: "queued_user_turns_flush_retry_after_error"
      });
    });
  }

  private get store() {
    return this.host.store;
  }
}
