import { SYSTEM_SPEECH_SOURCE } from "./systemSpeechOpportunity.ts";
import { JOIN_GREETING_LLM_WINDOW_MS } from "./voiceSessionManager.constants.ts";
import { isRealtimeMode } from "./voiceSessionHelpers.ts";
import type {
  JoinGreetingOpportunityState,
  OutputChannelState,
  VoiceConversationContext,
  VoiceSession
} from "./voiceSessionTypes.ts";

type GreetingSettings = Record<string, unknown> | null;

type GreetingStoreLike = {
  getSettings: () => GreetingSettings;
  logAction: (entry: {
    kind: string;
    guildId?: string | null;
    channelId?: string | null;
    userId?: string | null;
    content: string;
    metadata?: Record<string, unknown>;
  }) => void;
};

export interface GreetingManagerHost {
  client: {
    user?: {
      id?: string | null;
    } | null;
  };
  store: GreetingStoreLike;
  getOutputChannelState: (session: VoiceSession) => OutputChannelState;
  shouldUseNativeRealtimeReply: (args: {
    session: VoiceSession;
    settings?: GreetingSettings;
  }) => boolean;
  createTrackedAudioResponse: (args: {
    session: VoiceSession;
    source?: string;
    emitCreateEvent?: boolean;
    resetRetryState?: boolean;
  }) => boolean;
  runRealtimeBrainReply: (args: {
    session: VoiceSession;
    settings: GreetingSettings;
    userId: string | null;
    transcript: string;
    inputKind?: string;
    directAddressed?: boolean;
    directAddressConfidence?: number;
    conversationContext?: VoiceConversationContext | null;
    source?: string;
    forceSpokenOutput?: boolean;
  }) => Promise<boolean>;
  buildVoiceConversationContext: (args: {
    session: VoiceSession;
    userId?: string | null;
    directAddressed?: boolean;
  }) => VoiceConversationContext;
}

export class GreetingManager {
  constructor(private readonly host: GreetingManagerHost) {}

  getJoinGreetingOpportunity(session: VoiceSession | null | undefined) {
    const opportunity = session?.joinGreetingOpportunity;
    return opportunity && typeof opportunity === "object" ? opportunity : null;
  }

  clearJoinGreetingTimer(session: VoiceSession | null | undefined) {
    if (!session) return;
    if (session.joinGreetingTimer) {
      clearTimeout(session.joinGreetingTimer);
    }
    session.joinGreetingTimer = null;
  }

  clearJoinGreetingOpportunity(session: VoiceSession | null | undefined) {
    if (!session) return;
    this.clearJoinGreetingTimer(session);
    session.joinGreetingOpportunity = null;
  }

  armJoinGreetingOpportunity(
    session: VoiceSession,
    {
      trigger = "connection_ready"
    }: {
      trigger?: string | null;
    } = {}
  ) {
    if (!session || session.ending) return null;
    if (!isRealtimeMode(session.mode)) return null;

    const now = Date.now();
    const expiresAt = Math.max(0, Number(session.startedAt || 0)) + JOIN_GREETING_LLM_WINDOW_MS;
    if (expiresAt > 0 && now >= expiresAt) {
      this.clearJoinGreetingOpportunity(session);
      return null;
    }

    session.joinGreetingOpportunity = {
      trigger: String(trigger || "connection_ready").trim() || "connection_ready",
      armedAt: now,
      fireAt: now + 2500,
      expiresAt
    };

    if (session.lastOpenAiRealtimeInstructions && !session.lastAssistantReplyAt) {
      const delayMs = Math.max(0, Number(session.joinGreetingOpportunity.fireAt || 0) - now);
      this.scheduleJoinGreetingOpportunity(session, {
        delayMs,
        reason: "join_greeting_grace"
      });
    }

    return session.joinGreetingOpportunity;
  }

  scheduleJoinGreetingOpportunity(
    session: VoiceSession,
    {
      delayMs = 0,
      reason = "scheduled_recheck"
    }: {
      delayMs?: number;
      reason?: string;
    } = {}
  ) {
    if (!session || session.ending) return;
    if (!this.getJoinGreetingOpportunity(session)) return;
    this.clearJoinGreetingTimer(session);
    session.joinGreetingTimer = setTimeout(() => {
      session.joinGreetingTimer = null;
      this.maybeFireJoinGreetingOpportunity(session, reason);
    }, Math.max(0, Number(delayMs) || 0));
  }

  canFireJoinGreetingOpportunity(
    session: VoiceSession | null | undefined,
    opportunity: JoinGreetingOpportunityState | null = null
  ): string | null {
    if (!session || session.ending) return "session_inactive";
    if (!isRealtimeMode(session.mode)) return "wrong_mode";
    const pendingOpportunity = opportunity && typeof opportunity === "object"
      ? opportunity
      : this.getJoinGreetingOpportunity(session);
    if (!pendingOpportunity) return "no_opportunity";

    const now = Date.now();
    const expiresAt = Math.max(0, Number(pendingOpportunity.expiresAt || 0));
    if (expiresAt > 0 && now >= expiresAt) return "expired";
    if (!session.playbackArmed) return "playback_not_armed";
    if (session.lastAssistantReplyAt) return "assistant_reply_already_sent";
    if (!session.lastOpenAiRealtimeInstructions) return "instructions_not_ready";

    const fireAt = Math.max(0, Number(pendingOpportunity.fireAt || 0));
    if (fireAt > now) return "not_before_at";

    return this.host.getOutputChannelState(session).deferredBlockReason;
  }

  maybeFireJoinGreetingOpportunity(session: VoiceSession, reason = "manual") {
    const opportunity = this.getJoinGreetingOpportunity(session);
    const blockReason = this.canFireJoinGreetingOpportunity(session, opportunity);
    if (blockReason === "not_before_at") {
      const delayMs = Math.max(0, Number(opportunity?.fireAt || 0) - Date.now());
      this.scheduleJoinGreetingOpportunity(session, {
        delayMs,
        reason
      });
      return false;
    }
    if (blockReason === "instructions_not_ready") {
      return false;
    }
    if (blockReason) {
      this.clearJoinGreetingOpportunity(session);
      return false;
    }

    const resolvedSettings = session.settingsSnapshot || this.host.store.getSettings();
    const useNativeRealtimeReply = this.host.shouldUseNativeRealtimeReply({
      session,
      settings: resolvedSettings
    });
    if (useNativeRealtimeReply) {
      this.host.createTrackedAudioResponse({
        session,
        source: SYSTEM_SPEECH_SOURCE.JOIN_GREETING,
        emitCreateEvent: true,
        resetRetryState: true
      });
    } else {
      const joinGreetingTrigger = String(
        opportunity?.trigger || "join_greeting"
      )
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120);
      const joinGreetingBrainEventText = [
        "Join greeting opportunity.",
        `Trigger: ${joinGreetingTrigger || "join_greeting"}.`,
        "Say one brief natural spoken greeting line now."
      ].join(" ");
      void this.host.runRealtimeBrainReply({
        session,
        settings: resolvedSettings,
        userId: null,
        transcript: joinGreetingBrainEventText,
        inputKind: "event",
        directAddressed: false,
        directAddressConfidence: 0,
        conversationContext: this.host.buildVoiceConversationContext({
          session,
          userId: null,
          directAddressed: false
        }),
        source: SYSTEM_SPEECH_SOURCE.JOIN_GREETING,
        forceSpokenOutput: true
      }).catch((error) => {
        this.host.store.logAction({
          kind: "voice_error",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: this.host.client.user?.id || null,
          content: `voice_join_greeting_brain_failed: ${String(error?.message || error)}`,
          metadata: {
            sessionId: session.id,
            mode: session.mode
          }
        });
      });
    }
    this.clearJoinGreetingOpportunity(session);
    this.host.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: this.host.client.user?.id || null,
      content: "voice_join_greeting_fired",
      metadata: {
        sessionId: session.id,
        mode: session.mode,
        strategy: useNativeRealtimeReply ? "native" : "brain",
        trigger: String(opportunity?.trigger || "join_greeting"),
        fireReason: String(reason || "manual")
      }
    });
    return true;
  }
}
