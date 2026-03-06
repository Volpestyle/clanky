import { clamp } from "../utils.ts";
import { VOICE_THOUGHT_LOOP_BUSY_RETRY_MS, VOICE_THOUGHT_MAX_CHARS } from "./voiceSessionManager.constants.ts";
import { normalizeVoiceText } from "./voiceSessionHelpers.ts";
import type { DeferredActionQueue } from "./deferredActionQueue.ts";
import type { TurnProcessor } from "./turnProcessor.ts";
import type {
  MusicPlaybackPhase,
  VoiceSession
} from "./voiceSessionTypes.ts";
import { musicPhaseIsActive } from "./voiceSessionTypes.ts";

type ThoughtSettings = Record<string, unknown> | null;

interface ThoughtConfigLike {
  enabled: boolean;
  eagerness: number;
  minSilenceSeconds: number;
  minSecondsBetweenThoughts: number;
}

interface ThoughtTopicalityBias {
  topicTetherStrength: number;
  randomInspirationStrength: number;
  phase: string;
  promptHint: string;
}

interface VoiceThoughtDecision {
  allow: boolean;
  reason: string;
  finalThought?: string | null;
  memoryFactCount?: number;
  usedMemory?: boolean;
  llmResponse?: string | null;
  llmProvider?: string | null;
  llmModel?: string | null;
  error?: string | null;
}

type ThoughtStoreLike = {
  getSettings: () => ThoughtSettings;
  logAction: (entry: {
    kind: string;
    guildId?: string | null;
    channelId?: string | null;
    userId?: string | null;
    content: string;
    metadata?: Record<string, unknown>;
  }) => void;
};

export interface ThoughtEngineHost {
  client: {
    user?: {
      id?: string | null;
    } | null;
  };
  store: ThoughtStoreLike;
  resolveVoiceThoughtEngineConfig: (settings: ThoughtSettings) => ThoughtConfigLike;
  isCommandOnlyActive: (session: VoiceSession, settings?: ThoughtSettings) => boolean;
  getMusicPhase: (session: VoiceSession) => MusicPlaybackPhase;
  getOutputChannelState: (session: VoiceSession) => {
    locked: boolean;
    lockReason?: string | null;
  };
  hasReplayBlockingActiveCapture: (session: VoiceSession) => boolean;
  turnProcessor: Pick<TurnProcessor, "getRealtimeTurnBacklogSize">;
  deferredActionQueue: Pick<DeferredActionQueue, "getDeferredQueuedUserTurns">;
  countHumanVoiceParticipants: (session: VoiceSession) => number;
  generateVoiceThoughtCandidate: (args: {
    session: VoiceSession;
    settings: ThoughtSettings;
    config: ThoughtConfigLike;
    trigger?: string;
  }) => Promise<string>;
  loadVoiceThoughtMemoryFacts: (args: {
    session: VoiceSession;
    settings: ThoughtSettings;
    thoughtCandidate: string;
  }) => Promise<unknown[]>;
  evaluateVoiceThoughtDecision: (args: {
    session: VoiceSession;
    settings: ThoughtSettings;
    thoughtCandidate: string;
    memoryFacts: unknown[];
    topicalityBias: ThoughtTopicalityBias;
  }) => Promise<VoiceThoughtDecision>;
  deliverVoiceThoughtCandidate: (args: {
    session: VoiceSession;
    settings: ThoughtSettings;
    thoughtCandidate: string;
    trigger?: string;
  }) => Promise<boolean>;
  resolveVoiceThoughtTopicalityBias: (args: {
    silenceMs?: number;
    minSilenceSeconds?: number;
    minSecondsBetweenThoughts?: number;
  }) => ThoughtTopicalityBias;
}

export class ThoughtEngine {
  constructor(private readonly host: ThoughtEngineHost) {}

  clearVoiceThoughtLoopTimer(session: VoiceSession) {
    if (!session) return;
    if (session.thoughtLoopTimer) {
      clearTimeout(session.thoughtLoopTimer);
      session.thoughtLoopTimer = null;
    }
    session.nextThoughtAt = 0;
  }

  scheduleVoiceThoughtLoop({
    session,
    settings = null,
    delayMs = null
  }: {
    session: VoiceSession;
    settings?: ThoughtSettings;
    delayMs?: number | null;
  }) {
    if (!session || session.ending) return;
    const resolvedSettings = settings || session.settingsSnapshot || this.store.getSettings();
    const thoughtConfig = this.host.resolveVoiceThoughtEngineConfig(resolvedSettings);
    this.clearVoiceThoughtLoopTimer(session);
    if (!thoughtConfig.enabled) return;

    const defaultDelayMs = thoughtConfig.minSilenceSeconds * 1000;
    const requestedDelayMs = Number(delayMs);
    const waitMs = Math.max(
      120,
      Number.isFinite(requestedDelayMs) ? Math.round(Number(delayMs)) : defaultDelayMs
    );
    session.nextThoughtAt = Date.now() + waitMs;
    session.thoughtLoopTimer = setTimeout(() => {
      session.thoughtLoopTimer = null;
      session.nextThoughtAt = 0;
      void this.maybeRunVoiceThoughtLoop({
        session,
        settings: session.settingsSnapshot || this.store.getSettings(),
        trigger: "timer"
      }).catch(() => undefined);
    }, waitMs);
  }

  evaluateVoiceThoughtLoopGate({
    session,
    settings = null,
    config = null,
    now = Date.now()
  }: {
    session: VoiceSession;
    settings?: ThoughtSettings;
    config?: ThoughtConfigLike | null;
    now?: number;
  }) {
    if (!session || session.ending) {
      return {
        allow: false,
        reason: "session_inactive",
        retryAfterMs: VOICE_THOUGHT_LOOP_BUSY_RETRY_MS
      };
    }

    const thoughtConfig = config || this.host.resolveVoiceThoughtEngineConfig(settings);
    if (!thoughtConfig.enabled) {
      return {
        allow: false,
        reason: "thought_engine_disabled",
        retryAfterMs: thoughtConfig.minSilenceSeconds * 1000
      };
    }

    if (this.host.isCommandOnlyActive(session, settings)) {
      return {
        allow: false,
        reason: "command_only_mode",
        retryAfterMs: thoughtConfig.minSilenceSeconds * 1000
      };
    }

    if (musicPhaseIsActive(this.host.getMusicPhase(session))) {
      return {
        allow: false,
        reason: "music_playback_active",
        retryAfterMs: thoughtConfig.minSilenceSeconds * 1000
      };
    }

    const minSilenceMs = thoughtConfig.minSilenceSeconds * 1000;
    const minIntervalMs = thoughtConfig.minSecondsBetweenThoughts * 1000;
    const silentDurationMs = Math.max(0, now - Number(session.lastActivityAt || 0));
    if (silentDurationMs < minSilenceMs) {
      return {
        allow: false,
        reason: "silence_window_not_met",
        retryAfterMs: Math.max(200, minSilenceMs - silentDurationMs)
      };
    }

    const sinceLastAttemptMs = Math.max(0, now - Number(session.lastThoughtAttemptAt || 0));
    if (sinceLastAttemptMs < minIntervalMs) {
      return {
        allow: false,
        reason: "thought_attempt_cooldown",
        retryAfterMs: Math.max(300, minIntervalMs - sinceLastAttemptMs)
      };
    }

    if (session.thoughtLoopBusy) {
      return {
        allow: false,
        reason: "thought_loop_busy",
        retryAfterMs: VOICE_THOUGHT_LOOP_BUSY_RETRY_MS
      };
    }
    const outputChannelState = this.host.getOutputChannelState(session);
    if (outputChannelState.locked) {
      return {
        allow: false,
        reason: "bot_turn_open",
        retryAfterMs: VOICE_THOUGHT_LOOP_BUSY_RETRY_MS,
        outputLockReason: outputChannelState.lockReason
      };
    }
    if (Number(session.voiceLookupBusyCount || 0) > 0) {
      return {
        allow: false,
        reason: "voice_lookup_busy",
        retryAfterMs: VOICE_THOUGHT_LOOP_BUSY_RETRY_MS
      };
    }
    if (this.host.hasReplayBlockingActiveCapture(session)) {
      return {
        allow: false,
        reason: "active_user_capture",
        retryAfterMs: VOICE_THOUGHT_LOOP_BUSY_RETRY_MS
      };
    }
    if (Number(session.pendingSttTurns || 0) > 0) {
      return {
        allow: false,
        reason: "pending_stt_turns",
        retryAfterMs: VOICE_THOUGHT_LOOP_BUSY_RETRY_MS
      };
    }
    if (this.host.turnProcessor.getRealtimeTurnBacklogSize(session) > 0) {
      return {
        allow: false,
        reason: "pending_realtime_turns",
        retryAfterMs: VOICE_THOUGHT_LOOP_BUSY_RETRY_MS
      };
    }
    if (this.host.deferredActionQueue.getDeferredQueuedUserTurns(session).length > 0) {
      return {
        allow: false,
        reason: "pending_deferred_turns",
        retryAfterMs: VOICE_THOUGHT_LOOP_BUSY_RETRY_MS
      };
    }
    if (this.host.countHumanVoiceParticipants(session) <= 0) {
      return {
        allow: false,
        reason: "no_human_participants",
        retryAfterMs: minSilenceMs
      };
    }

    return {
      allow: true,
      reason: "ok",
      retryAfterMs: minIntervalMs
    };
  }

  async maybeRunVoiceThoughtLoop({
    session,
    settings = null,
    trigger = "timer"
  }: {
    session: VoiceSession;
    settings?: ThoughtSettings;
    trigger?: string;
  }) {
    if (!session || session.ending) return false;
    const resolvedSettings = settings || session.settingsSnapshot || this.store.getSettings();
    const thoughtConfig = this.host.resolveVoiceThoughtEngineConfig(resolvedSettings);
    if (!thoughtConfig.enabled) {
      this.clearVoiceThoughtLoopTimer(session);
      return false;
    }

    const gate = this.evaluateVoiceThoughtLoopGate({
      session,
      settings: resolvedSettings,
      config: thoughtConfig
    });
    if (!gate.allow) {
      this.scheduleVoiceThoughtLoop({
        session,
        settings: resolvedSettings,
        delayMs: gate.retryAfterMs
      });
      return false;
    }

    const thoughtChance = clamp(Number(thoughtConfig?.eagerness) || 0, 0, 100) / 100;
    const now = Date.now();
    session.lastThoughtAttemptAt = now;
    if (thoughtChance <= 0) {
      this.scheduleVoiceThoughtLoop({
        session,
        settings: resolvedSettings,
        delayMs: thoughtConfig.minSecondsBetweenThoughts * 1000
      });
      return false;
    }

    const roll = Math.random();
    if (roll > thoughtChance) {
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.botUserId,
        content: "voice_thought_skipped_probability",
        metadata: {
          sessionId: session.id,
          mode: session.mode,
          trigger: String(trigger || "timer"),
          thoughtEagerness: Math.round(thoughtChance * 100),
          roll: Number(roll.toFixed(5))
        }
      });
      this.scheduleVoiceThoughtLoop({
        session,
        settings: resolvedSettings,
        delayMs: thoughtConfig.minSecondsBetweenThoughts * 1000
      });
      return false;
    }

    session.thoughtLoopBusy = true;
    try {
      const thoughtDraft = await this.host.generateVoiceThoughtCandidate({
        session,
        settings: resolvedSettings,
        config: thoughtConfig,
        trigger
      });
      if (!thoughtDraft) {
        this.store.logAction({
          kind: "voice_runtime",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: this.botUserId,
          content: "voice_thought_generation_skip",
          metadata: {
            sessionId: session.id,
            mode: session.mode,
            trigger: String(trigger || "timer")
          }
        });
        return false;
      }

      const thoughtMemoryFacts = await this.host.loadVoiceThoughtMemoryFacts({
        session,
        settings: resolvedSettings,
        thoughtCandidate: thoughtDraft
      });
      const thoughtTopicalityBias = this.host.resolveVoiceThoughtTopicalityBias({
        silenceMs: Math.max(0, Date.now() - Number(session.lastActivityAt || 0)),
        minSilenceSeconds: thoughtConfig.minSilenceSeconds,
        minSecondsBetweenThoughts: thoughtConfig.minSecondsBetweenThoughts
      });
      const decision = await this.host.evaluateVoiceThoughtDecision({
        session,
        settings: resolvedSettings,
        thoughtCandidate: thoughtDraft,
        memoryFacts: thoughtMemoryFacts,
        topicalityBias: thoughtTopicalityBias
      });
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.botUserId,
        content: "voice_thought_decision",
        metadata: {
          sessionId: session.id,
          mode: session.mode,
          trigger: String(trigger || "timer"),
          allow: Boolean(decision.allow),
          reason: decision.reason,
          thoughtDraft,
          finalThought: decision.finalThought || null,
          memoryFactCount: Number(decision.memoryFactCount || 0),
          usedMemory: Boolean(decision.usedMemory),
          topicTetherStrength: thoughtTopicalityBias.topicTetherStrength,
          randomInspirationStrength: thoughtTopicalityBias.randomInspirationStrength,
          topicDriftPhase: thoughtTopicalityBias.phase,
          topicDriftHint: thoughtTopicalityBias.promptHint,
          llmResponse: decision.llmResponse || null,
          llmProvider: decision.llmProvider || null,
          llmModel: decision.llmModel || null,
          error: decision.error || null
        }
      });
      if (!decision.allow) return false;
      const finalThought = normalizeVoiceText(
        decision.finalThought || thoughtDraft,
        VOICE_THOUGHT_MAX_CHARS
      );
      if (!finalThought) return false;

      const spoken = await this.host.deliverVoiceThoughtCandidate({
        session,
        settings: resolvedSettings,
        thoughtCandidate: finalThought,
        trigger
      });
      if (spoken) {
        session.lastThoughtSpokenAt = Date.now();
      }
      return spoken;
    } catch (error) {
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.botUserId,
        content: `voice_thought_loop_failed: ${String(error?.message || error)}`,
        metadata: {
          sessionId: session.id,
          mode: session.mode,
          trigger: String(trigger || "timer")
        }
      });
      return false;
    } finally {
      session.thoughtLoopBusy = false;
      this.scheduleVoiceThoughtLoop({
        session,
        settings: resolvedSettings,
        delayMs: thoughtConfig.minSecondsBetweenThoughts * 1000
      });
    }
  }

  private get botUserId() {
    return this.host.client.user?.id || null;
  }

  private get store() {
    return this.host.store;
  }
}
