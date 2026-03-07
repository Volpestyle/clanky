export const MIN_MAX_SESSION_MINUTES = 1;
export const MAX_MAX_SESSION_MINUTES = 120;
export const OPENAI_REALTIME_MAX_SESSION_MINUTES = 60;
export const MIN_INACTIVITY_SECONDS = 20;
export const MAX_INACTIVITY_SECONDS = 3600;
export const VOICE_MAX_DURATION_WARNING_SECONDS = 120;
export const VOICE_INACTIVITY_WARNING_SECONDS = 45;
export const INPUT_SPEECH_END_SILENCE_MS = 700;
export const SPEAKING_END_MICRO_CAPTURE_MS = 260;
export const SPEAKING_END_SHORT_CAPTURE_MS = 900;
export const SPEAKING_END_FINALIZE_MICRO_MS = 420;
export const SPEAKING_END_FINALIZE_SHORT_MS = 220;
// Keep a pause window for normal turns, but cap it tighter for lower end-of-turn latency.
export const SPEAKING_END_FINALIZE_QUICK_MS = 800;
export const SPEAKING_END_FINALIZE_MIN_MS = 100;
export const SPEAKING_END_ADAPTIVE_BUSY_CAPTURE_COUNT = 3;
export const SPEAKING_END_ADAPTIVE_HEAVY_CAPTURE_COUNT = 5;
export const SPEAKING_END_ADAPTIVE_BUSY_BACKLOG = 2;
export const SPEAKING_END_ADAPTIVE_HEAVY_BACKLOG = 4;
export const SPEAKING_END_ADAPTIVE_BUSY_SCALE = 0.7;
export const SPEAKING_END_ADAPTIVE_HEAVY_SCALE = 0.5;
export const CAPTURE_IDLE_FLUSH_MS = INPUT_SPEECH_END_SILENCE_MS + 120;
export const CAPTURE_MAX_DURATION_MS = 8_000;
export const CAPTURE_NEAR_SILENCE_ABORT_MIN_AGE_MS = 1_000;
export const CAPTURE_NEAR_SILENCE_ABORT_ACTIVE_RATIO_MAX = 0.009;
export const CAPTURE_NEAR_SILENCE_ABORT_PEAK_MAX = 0.011;
export const BOT_TURN_SILENCE_RESET_MS = 1200;
// clankvox reports TTS depth every 500ms; if positive buffered telemetry stops
// updating for this long, treat it as stale rather than durable truth.
export const CLANKVOX_TTS_TELEMETRY_STALE_MS = 1600;
// Make barge-in intentionally stubborn so brief talk-over/echo does not cut bot playback.
export const BARGE_IN_MIN_SPEECH_MS = 700;
// STT pipeline captures must be at least this old before barge-in fires, replacing
// the old timer-based armAssertiveBargeIn delay.
export const BARGE_IN_STT_MIN_CAPTURE_AGE_MS = 500;
export const BARGE_IN_SUPPRESSION_MAX_MS = 12_000;
// Grace period after bot TTS audio starts before barge-in is accepted.
// Prevents false barge-in from echo of the bot's own voice through user mic.
export const BARGE_IN_BOT_AUDIO_ECHO_GUARD_MS = 1500;
// Stricter assertiveness thresholds while bot is speaking (echo rejection).
// Normal gate: activeSampleRatio > 0.01, peak > 0.012 (anything above silence).
// Bot-speaking gate: require clearly audible speech, not just faint echo leak.
export const BARGE_IN_BOT_SPEAKING_ACTIVE_RATIO_MIN = 0.06;
export const BARGE_IN_BOT_SPEAKING_PEAK_MIN = 0.05;
export const BARGE_IN_FULL_OVERRIDE_MIN_MS = 2200;
export const BARGE_IN_RETRY_MAX_AGE_MS = 10_000;
export const ACTIVITY_TOUCH_THROTTLE_MS = 2000;
export const ACTIVITY_TOUCH_MIN_SPEECH_MS = 120;
export const RESPONSE_FLUSH_DEBOUNCE_MS = 280;
export const OPENAI_ACTIVE_RESPONSE_RETRY_MS = 260;
export const MIN_RESPONSE_REQUEST_GAP_MS = 700;
export const RESPONSE_SILENCE_RETRY_DELAY_MS = 5200;
export const MAX_RESPONSE_SILENCE_RETRIES = 2;
export const RESPONSE_DONE_SILENCE_GRACE_MS = 1400;
// Keep ASR sessions warm longer to avoid reconnect penalties between turns.
export const OPENAI_ASR_SESSION_IDLE_TTL_MS = 60_000;
// Return ASR text sooner once transcript updates settle.
export const OPENAI_ASR_TRANSCRIPT_STABLE_MS = 120;
export const OPENAI_ASR_TRANSCRIPT_WAIT_MAX_MS = 700;
// Deadline for waiting on per-user/shared ASR bridge before falling back to
// local turn processing so first-reply latency is not blocked by slow ASR.
export const OPENAI_ASR_BRIDGE_MAX_WAIT_MS = 700;
// Promotion fallback when server VAD has not confirmed speech yet. This should
// only pass obviously voiced local speech, not quiet background chatter.
export const VOICE_TURN_PROMOTION_STRONG_LOCAL_RMS_MIN = 0.004;
export const VOICE_TURN_PROMOTION_STRONG_LOCAL_PEAK_MIN = 0.04;
export const VOICE_TURN_PROMOTION_STRONG_LOCAL_ACTIVE_RATIO_MIN = 0.06;
export const OPENAI_TOOL_CALL_EVENT_MAX = 180;
export const OPENAI_TOOL_CALL_ARGUMENTS_MAX_CHARS = 24_000;
export const OPENAI_TOOL_RESPONSE_DEBOUNCE_MS = 140;
export const VOICE_MEMORY_WRITE_MAX_PER_MINUTE = 5;
export const LEAVE_DIRECTIVE_PLAYBACK_POLL_MS = 40;
export const LEAVE_DIRECTIVE_PLAYBACK_NO_SIGNAL_GRACE_MS = 400;
export const LEAVE_DIRECTIVE_REALTIME_AUDIO_START_WAIT_MS = 2200;
export const LEAVE_DIRECTIVE_PLAYBACK_MAX_WAIT_MS = 5000;
// Hold a finalized realtime turn for this window before dispatching, so a
// mid-sentence pause ("Play a Future song… like the rapper") can be
// coalesced into a single turn instead of splitting into two responses.
export const REALTIME_TURN_COALESCE_WINDOW_MS = 1100;
// Maximum PCM bytes allowed in a coalesced multi-segment turn.
export const REALTIME_TURN_COALESCE_MAX_BYTES = 24_000 * 2 * 12;
// Keep only one pending realtime turn; newer finalized captures are merged into it.
export const REALTIME_TURN_QUEUE_MAX = 1;
export const REALTIME_TURN_STALE_SKIP_MS = 2200;
export const REALTIME_TURN_PENDING_MERGE_MAX_BYTES = 24_000 * 2 * 30;
// Skip trivial micro-clips from speaking_end that frequently hallucinate transcript junk.
export const VOICE_TURN_MIN_ASR_CLIP_MS = 100;
// Drop near-silent captures before ASR so Discord speaking blips do not become random transcripts.
export const VOICE_SILENCE_GATE_MIN_CLIP_MS = 280;
export const VOICE_SILENCE_GATE_RMS_MAX = 0.003;
export const VOICE_SILENCE_GATE_PEAK_MAX = 0.012;
export const VOICE_SILENCE_GATE_ACTIVE_SAMPLE_MIN_ABS = 180;
export const VOICE_SILENCE_GATE_ACTIVE_RATIO_MAX = 0.01;
export const VOICE_TURN_PROMOTION_MIN_CLIP_MS = 420;
export const VOICE_TURN_PROMOTION_PEAK_MIN = 0.016;
export const VOICE_TURN_PROMOTION_ACTIVE_RATIO_MIN = 0.02;
export const VOICE_FALLBACK_NOISE_GATE_MAX_CLIP_MS = 1800;
export const VOICE_FALLBACK_NOISE_GATE_RMS_MAX = 0.0065;
export const VOICE_FALLBACK_NOISE_GATE_PEAK_MAX = 0.02;
export const VOICE_FALLBACK_NOISE_GATE_ACTIVE_RATIO_MAX = 0.03;
export const VOICE_EMPTY_TRANSCRIPT_ERROR_STREAK = 3;
export const BOT_TURN_DEFERRED_FLUSH_DELAY_MS = BOT_TURN_SILENCE_RESET_MS + 120;
export const BOT_TURN_DEFERRED_QUEUE_MAX = 8;
export const BOT_TURN_DEFERRED_COALESCE_MAX = 5;
export const NON_DIRECT_REPLY_MIN_SILENCE_MS = 2300;
export const VOICE_THOUGHT_LOOP_MIN_SILENCE_SECONDS = 8;
export const VOICE_THOUGHT_LOOP_MAX_SILENCE_SECONDS = 300;
export const VOICE_THOUGHT_LOOP_MIN_INTERVAL_SECONDS = 8;
export const VOICE_THOUGHT_LOOP_MAX_INTERVAL_SECONDS = 600;
export const VOICE_THOUGHT_LOOP_BUSY_RETRY_MS = 1400;
export const VOICE_THOUGHT_MAX_CHARS = 220;
export const VOICE_THOUGHT_MEMORY_SEARCH_LIMIT = 8;
export const VOICE_THOUGHT_DECISION_MAX_OUTPUT_TOKENS = 220;
export const BOT_DISCONNECT_GRACE_MS = 2500;
export const STT_CONTEXT_MAX_MESSAGES = 10;
export const STT_TRANSCRIPT_MAX_CHARS = 700;
export const STT_REPLY_MAX_CHARS = 1200;
export const STT_TURN_QUEUE_MAX = 1;
export const STT_TURN_STALE_SKIP_MS = 4500;
export const STT_TURN_COALESCE_WINDOW_MS = 1200;
export const STT_TURN_COALESCE_MAX_BYTES = 24_000 * 2 * 8;
export const VOICE_LOOKUP_BUSY_MAX_CHARS = 120;
export const VOICE_LOOKUP_BUSY_LOG_COOLDOWN_MS = 1500;
export const VOICE_LOOKUP_BUSY_ANNOUNCE_DELAY_MS = 120;
export const VOICE_TURN_ADDRESSING_TRANSCRIPT_MAX_CHARS = 260;
export const VOICE_DECIDER_HISTORY_MAX_TURNS = 8;
export const VOICE_TRANSCRIPT_TIMELINE_MAX_TURNS = 220;
export const VOICE_DECIDER_HISTORY_MAX_CHARS = 220;
export const VOICE_DECIDER_PROMPT_HISTORY_MAX_CHARS = 900;
export const REALTIME_INSTRUCTION_REFRESH_DEBOUNCE_MS = 220;
export const REALTIME_CONTEXT_TRANSCRIPT_MAX_CHARS = 420;
export const REALTIME_CONTEXT_MEMBER_LIMIT = 12;
export const VOICE_MEMBERSHIP_EVENT_MAX_TRACKED = 18;
export const VOICE_MEMBERSHIP_EVENT_PROMPT_LIMIT = 6;
export const VOICE_MEMBERSHIP_EVENT_FRESH_MS = 60_000;
export const VOICE_CHANNEL_EFFECT_EVENT_MAX_TRACKED = 18;
export const VOICE_CHANNEL_EFFECT_EVENT_PROMPT_LIMIT = 6;
export const VOICE_CHANNEL_EFFECT_EVENT_FRESH_MS = 60_000;
export const RECENT_ENGAGEMENT_WINDOW_MS = 35_000;
export const SOUNDBOARD_DECISION_TRANSCRIPT_MAX_CHARS = 280;
export const SOUNDBOARD_CATALOG_REFRESH_MS = 60_000;
// Mean logprob threshold for ASR transcript confidence gate.
// OpenAI logprobs are log-base-e: -1.0 ≈ 37% per-token confidence.
// Hallucinations on noise/breathing typically score well below -2.0.
export const VOICE_ASR_LOGPROB_CONFIDENCE_THRESHOLD = -1.0;
export const MEMORY_SENSITIVE_PATTERN_RE =
  /\b(?:sk-[a-z0-9]{20,}|api[_-]?key|token|password|passphrase|authorization|secret)\b/i;
