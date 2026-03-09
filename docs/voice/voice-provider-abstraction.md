# Voice Pipeline — Provider Abstraction and Stage Reference

> **Scope:** Voice pipeline architecture — what stages audio passes through, which providers are active, and what settings configure each stage.
> Operator-facing activity paths and setting map: [`clanker-activity.md`](../clanker-activity.md)
> Barge-in and noise rejection: [`barge-in.md`](barge-in.md)
> Assistant reply/output lifecycle: [`voice-output-state-machine.md`](voice-output-state-machine.md)
> Streaming reply behavior: [`voice-streaming-reply.md`](voice-streaming-reply.md)

This document describes the voice chat pipeline as a linear sequence of stages, from audio input to voice output. Each stage is independently configurable, and the active set of stages depends on which **reply path** is selected.

The pipeline gives the agent full context at each stage — tools are presented as available capabilities (never forced), conversation history flows through unfiltered, and the agent decides what to do via its generation output or `[SKIP]`. Provider swapping changes the transport, not the agent's autonomy. See `AGENTS.md` — Agent Autonomy section.

---

## 1. Overview

The system keeps voice chat split into independently swappable layers:

1. **Voice/TTS provider** — realtime audio model (OpenAI, xAI, Gemini, ElevenLabs)
2. **Brain provider** — reasoning/generation model (native realtime, OpenAI, Anthropic, xAI, Gemini)
3. **Transcriber provider** — ASR transcription (OpenAI)

Provider resolution (`src/voice/voiceSessionHelpers.ts`):

```
voiceProvider    = resolveVoiceProvider(settings)         // default: "openai"
brainProvider    = resolveBrainProvider(settings)          // default: "openai"
transcriberProvider = resolveTranscriberProvider(settings)  // default: "openai"
runtimeMode      = resolveVoiceRuntimeMode(settings)       // maps provider → runtime mode
```

Runtime modes (`src/voice/voiceModes.ts`): `openai_realtime`, `voice_agent`, `gemini_realtime`, `elevenlabs_realtime`

### Architecture Principles

The design goal is provider-swappable behavior without duplicate logic. The voice stack keeps three shared sources of truth and pushes provider differences to thin adapters:

- **One context/instruction service**: `instructionManager.ts` builds persona, continuity, memory, speaker, channel, and tool-policy context for provider-native sessions. `voiceReplyPipeline.ts` builds the full-brain generation payload for orchestrator-owned sessions.
- **One tool contract**: shared tool schemas live in `src/tools/sharedToolSchemas.ts`. `src/voice/voiceToolCallToolRegistry.ts` exports provider-safe realtime tool definitions from that shared contract instead of defining a second provider-specific tool set.
- **One tool executor**: `src/voice/voiceToolCallDispatch.ts` and the downstream tool implementations remain the canonical execution path whether the planner is the full brain or a provider-native realtime model.
- **Thin provider adapters**: `openaiRealtimeClient.ts`, `xaiRealtimeClient.ts`, `geminiRealtimeClient.ts`, and `elevenLabsRealtimeClient.ts` are responsible for protocol translation, not business logic.

That separation is what allows the same product behavior to run in multiple shapes:

- **Native**: provider owns ASR, response planning, and provider-native tool calls.
- **Bridge**: local ASR produces labeled text, but the provider still owns response planning and provider-native tool calls.
- **Brain**: the upstream orchestrator owns planning and tools; the realtime provider is only the speaking transport.

---

## 2. The Pipeline

![Voice Pipeline Stages](../diagrams/voice-pipeline-stages.png)

### Stage Visibility Matrix

| Stage | Native | Bridge | Brain |
|---|---|---|---|
| 1. Audio Input | yes | yes | yes |
| 2a. ASR (per-speaker) | — | yes | — |
| 2b. ASR (shared) | — | — | yes |
| 3. Noise Rejection | bypassed | yes | yes |
| 4a. Reply Admission (deterministic) | yes | yes | yes |
| 4b. Reply Admission (classifier) | — | yes (always on) | optional (off by default) |
| 5a. Brain (realtime end-to-end) | yes | — | — |
| 5b. Brain (text→realtime) | — | yes | — |
| 5c. Brain (text LLM) | — | — | yes |
| 6a. Voice Output (realtime stream) | yes | yes | yes |
| 6b. Voice Output (TTS API) | — | — | — |
| Thought Engine (parallel) | yes | yes | yes |

---

## 3. Reply Paths

### Native

Direct audio passthrough to the realtime API. The provider handles ASR, reasoning, and audio generation end-to-end.

- **Latency**: lowest
- **ASR**: provider-internal (no local transcription)
- **Tool support**: provider-native function calling where the runtime supports `updateTools`
- **Provider requirement**: OpenAI only (requires `perUserAsr` or native audio input)
- **Code path**: `forwardRealtimeTurnAudio()` in `voiceSessionManager.ts`

### Bridge

Per-speaker ASR transcribes each user independently, producing labeled text. The text is forwarded to the realtime brain for reasoning + audio generation.

- **Latency**: moderate (ASR round-trip added)
- **ASR**: per-speaker via `OpenAiRealtimeTranscriptionClient` — logprobs confidence gate available
- **Tool support**: provider-native function calling where the runtime supports `updateTools`
- **Provider requirement**: any provider with `textInput` capability plus OpenAI-backed ASR for text-mediated voice today
- **Code path**: `forwardRealtimeTextTurnToBrain()` in `voiceSessionManager.ts`

### Brain

Shared ASR transcribes mixed audio. A text LLM (`generationLlm`) generates the response. The realtime provider speaks the generated text via utterance requests.

When `voice.conversationPolicy.streaming.enabled` is active and Brain is using
Realtime TTS, the generated text can be spoken incrementally before the full
LLM response finishes. The live chunking behavior is documented in
[`voice-streaming-reply.md`](voice-streaming-reply.md).

- **Latency**: high (ASR + text LLM + realtime utterance)
- **ASR**: shared/file transcription inside the realtime session when `voice.openaiRealtime.transcriptionMethod="file_wav"`
- **Tool support**: orchestrator-owned tools inside the text LLM loop
- **Provider requirement**: works with any provider combination
- **Code path**: `runRealtimeBrainReply()` → `generateVoiceTurn()` in `voiceSessionManager.ts`

---

## 4. Stage Reference

### Stage 1: Audio Input & ASR

Discord Opus audio is decoded to PCM 48kHz, downsampled to 24kHz, and routed based on the reply path.

**Per-speaker ASR (bridge path)**

Each active speaker gets a dedicated `OpenAiRealtimeTranscriptionClient` in `openAiAsrSessions: Map<userId, state>`.
Per-speaker audio now streams into ASR while the capture is still provisional. Local capture ownership stays per-user, but promotion to a real turn is hybrid:

- local provisional capture buffers PCM immediately
- per-user OpenAI Realtime transcription receives `input_audio_buffer.append` immediately
- OpenAI `server_vad` confirms speech boundaries for that utterance
- the capture promotes when either:
  - server VAD has fired for the current utterance and the local signal clears the normal promotion gate
  - or the local signal is strong enough to use the explicit strong-local fallback

This keeps Discord speaker attribution local while making speech promotion less dependent on fixed noise heuristics.

| Setting | Key Path | Default |
|---|---|---|
| Transcription method | `voice.openaiRealtime.transcriptionMethod` | `"realtime_bridge"` |
| ASR model | `voice.openaiRealtime.inputTranscriptionModel` | `"gpt-4o-transcribe"` |
| Per-user bridge | `voice.openaiRealtime.usePerUserAsrBridge` | `true` |
| Language mode | `voice.asrLanguageMode` | `"auto"` |
| Language hint | `voice.asrLanguageHint` | `"en"` |
| Turn detection | OpenAI realtime `audio.input.turn_detection` | `server_vad` |

Code: `ensureOpenAiAsrSessionConnected()`, `appendAudioToOpenAiAsr()`, `commitOpenAiAsrUtterance()` in `voiceSessionManager.ts`
Client: `src/voice/openaiRealtimeTranscriptionClient.ts`

**Shared ASR (brain path)**

Uses the realtime session's file-transcription model when `voice.openaiRealtime.transcriptionMethod="file_wav"`.

| Setting | Key Path | Default |
|---|---|---|
| Transcription model | `voice.openaiRealtime.inputTranscriptionModel` | `"gpt-4o-mini-transcribe"` |

**Logprobs**

OpenAI realtime transcription returns per-token logprobs on `completed` events. These flow through the ASR bridge into `AsrCommitResult.transcriptLogprobs` and are evaluated at the noise rejection stage.

---

### Stage 2: Turn Promotion and Noise Rejection Gates

Before a capture becomes a real voice turn, it must first promote out of provisional state. After promotion, sequential rejection gates can still drop the turn before it consumes brain resources. Each gate fires independently — a turn is dropped at the first gate that rejects it.

Applied in `runRealtimeTurn()` in `src/voice/turnProcessor.ts`:

Promotion signals:

- `voice_activity_started` now means a provisional capture promoted to a real turn
- `promotionReason=server_vad_confirmed` means OpenAI VAD confirmed speech for the same utterance
- `promotionReason=strong_local_audio` means the local fallback path promoted without waiting for VAD
- `voice_turn_dropped_provisional_capture` means the capture never promoted and was discarded as noise / near-silence

The hybrid design is deliberate:

- OpenAI VAD helps reject ambient TV / room noise better than fixed local thresholds alone
- local fallback still exists so clearly strong speech can promote even if server VAD is delayed
- shared ASR stays promotion-gated, while per-user ASR buffers provisional audio so VAD has enough context to help

| Order | Gate | Drop Reason | Threshold / Constants | Applies To |
|---|---|---|---|---|
| 1 | Silence gate | `voice_turn_dropped_silence_gate` | `VOICE_SILENCE_GATE_MIN_CLIP_MS=280`, `RMS_MAX=0.003`, `PEAK_MAX=0.012`, `ACTIVE_RATIO_MAX=0.01` | all captures |
| 2 | Short clip filter | `realtime_turn_transcription_skipped_short_clip` | `VOICE_TURN_MIN_ASR_CLIP_MS=100` | `speaking_end` captures |
| 3 | ASR logprob confidence | `voice_turn_dropped_asr_low_confidence` | `VOICE_ASR_LOGPROB_CONFIDENCE_THRESHOLD=-1.0` (mean logprob, log-base-e; -1.0 ≈ 37% per-token) | bridge path only (`hasTranscriptOverride`) |
| 4 | Bridge fallback hallucination | `voice_turn_dropped_asr_bridge_fallback_hallucination` | same as low signal fallback | bridge active but returned empty |

Code: `evaluatePcmSilenceGate()` in `src/voice/voiceSessionManager.ts`
Confidence: `computeAsrTranscriptConfidence()` in `src/voice/voiceDecisionRuntime.ts`

---

### Stage 3: Reply Admission

Two layers: deterministic gates (fast, no LLM call) and an optional LLM classifier (bridge path only).

#### Deterministic Gates

Evaluated in order by `evaluateVoiceReplyDecision()` in `voiceReplyDecision.ts`:

| Order | Gate | Reason | Result |
|---|---|---|---|
| 1 | Missing transcript | `missing_transcript` | deny |
| 2 | Pending command followup | `pending_command_followup` | allow |
| 3 | Output lock (assistant output phase, non-music) | `bot_turn_open` (coarse) / `outputLockReason` (authoritative) | deny (retry after 1400ms) |
| 4 | Owned tool followup by same speaker | `owned_tool_followup` / `owned_tool_followup_cancel` | allow |
| 5 | Other-speaker cross-talk during owned tool followup | `owned_tool_followup_other_speaker_blocked` | deny |
| 6 | Command-only + direct address | `command_only_direct_address` | allow |
| 7 | Command-only + not addressed outside latch window | `command_only_not_addressed` | deny |
| 8 | Music playing + wake latch inactive | `music_playing_not_awake` | deny |
| 9 | Native realtime path | `native_realtime` | allow |
| 10 | Generation-decides mode | `generation_decides` | allow |
| 11 | Classifier mode | `classifier_allow` / `classifier_deny` | YES/NO LLM gate |

#### LLM Classifier (bridge path)

When the canonical admission mode is `classifier_gate` (runtime internal value: `hard_classifier`) and the turn survived deterministic gates, `runVoiceReplyClassifier()` makes a YES/NO call.

Direct address and eagerness still shape the decision, but no longer as hard deterministic gates for normal bridge turns. Direct address is classifier/generation context and can arm the short music wake latch when music is active. Eagerness `0` now flows through the same decision stack instead of forcing an immediate deny.

| Setting | Key Path | Default |
|---|---|---|
| Provider | `voice.replyDecisionLlm.provider` | `"anthropic"` |
| Model | `voice.replyDecisionLlm.model` | `"claude-haiku-4-5"` |
| Reasoning effort | `voice.replyDecisionLlm.reasoningEffort` | `"minimal"` |
| Admission mode | `voice.admission.mode` | `"classifier_gate"` |
| Music wake latch | `voice.replyDecisionLlm.musicWakeLatchSeconds` | `15` |

Classifier config: `temperature: 0`, `maxOutputTokens: 4`, history window: `CLASSIFIER_HISTORY_MAX_TURNS=6` / `CLASSIFIER_HISTORY_MAX_CHARS=900`

Decision reasons: `classifier_allow` (YES), `classifier_deny` (NO), `unparseable_classifier_output` (deny), `classifier_runtime_error` (deny), `llm_unavailable` (deny)

Admission policy prompt: `buildVoiceAdmissionPolicyLines()` in `src/prompts/voiceAdmissionPolicy.ts` — generates contextual policy lines based on mode (`"classifier"` or `"generation"`), direct address, eagerness, participant count, music state.

---

### Stage 4: Brain

#### Native (Stage 5a)

Raw PCM is forwarded to the realtime API. The provider handles reasoning and audio generation end-to-end.

Code: `forwardRealtimeTurnAudio()` in `voiceSessionManager.ts`

#### Bridge (Stage 5b — text→realtime)

Labeled transcript `(speakerName): text` is sent to the realtime provider via `realtimeClient.requestTextUtterance()`. Context-aware instructions and tools are refreshed before each request.

Code: `forwardRealtimeTextTurnToBrain()`, `refreshRealtimeInstructions()`, `prepareRealtimeTurnContext()` in `voiceSessionManager.ts`

Context includes: participant/membership context, durable memory facts, recent conversation history (text + voice), web-search cache, adaptive directives (guidance + behavior), active speaker context, and current tool policy. This is the same product persona/continuity layer used for provider-native bridge sessions even though the bridge input itself is labeled text instead of raw provider ASR.

#### Brain (Stage 5c — text LLM)

The orchestrator LLM generates the text response and owns the tool loop. A speech transport then renders the final line, either through a realtime voice client (`requestPlaybackUtterance()`) or an API TTS path.

| Setting | Key Path | Default |
|---|---|---|
| Use text model | `voice.generationLlm.useTextModel` | `true` |
| Provider | `voice.generationLlm.provider` | `"anthropic"` |
| Model | `voice.generationLlm.model` | `"claude-sonnet-4-6"` |

Code: `runRealtimeBrainReply()` → `generateVoiceTurn()` in `voiceSessionManager.ts`

#### Tool Calling

Realtime-native planning (native + bridge) supports provider-native tool calling through the provider event loop:

- provider emits function-call event
- `handleRealtimeFunctionCallEvent()` accumulates arguments and latches runtime state
- `executeLocalVoiceToolCall()` or `executeMcpVoiceToolCall()` performs the canonical tool execution
- the result is returned via `sendFunctionCallOutput()`
- `scheduleRealtimeToolFollowupResponse()` requests a follow-up provider response when the tool policy says one is needed

Full-brain replies keep tool ownership in the upstream orchestrator loop. Realtime output transport is tool-disabled or exact-line constrained in that path so upstream-generated speech cannot start a second provider tool/reasoning pass.

Code: event binding in `src/voice/sessionLifecycle.ts`, tool export in `src/voice/voiceToolCallToolRegistry.ts`, execution in `src/voice/voiceToolCallDispatch.ts`, orchestration in `src/voice/voiceToolCallInfra.ts`

**Local tools** (`resolveVoiceRealtimeToolDescriptors()` in `voiceToolCalls.ts`):

- `conversation_search`, `memory_search`, `memory_write`
- `adaptive_directive_add`, `adaptive_directive_remove`
- `music_search`, `music_play`, `music_queue_next`, `music_queue_add`, `music_stop`, `music_pause`, `music_resume`, `music_skip`, `music_now_playing`
- `web_search`, `browser_browse` (when enabled)

**MCP tools**: merged from configured MCP servers, dispatched via `executeMcpVoiceToolCall()`

---

### Stage 5: Voice Output

#### Realtime Audio Stream (native + bridge + brain)

The realtime provider streams audio deltas. PCM 24kHz is upsampled to 48kHz, encoded to Opus, and sent to Discord.

When realtime sessions use the full-brain path, the text LLM still generates the reply text, but delivery can stay on this realtime output transport. All providers expose a playback-oriented `requestPlaybackUtterance()` surface. The transport implementation is provider-specific:

- OpenAI uses an out-of-band audio response with tools disabled.
- xAI currently uses the normal text conversation path with an exact-line constraint.

The product contract is the same in both cases: the upstream brain already decided the words, and the speech transport should render that line instead of replanning.

#### TTS API Override (brain path)

Text response can be sent to the OpenAI audio API for synthesis when realtime sessions use `voice.ttsMode="api"`. Output is then played via `playVoiceReplyInOrder()`.

| Setting | Key Path | Default |
|---|---|---|
| TTS model | `voice.openaiAudioApi.ttsModel` | `"gpt-4o-mini-tts"` |
| TTS voice | `voice.openaiAudioApi.ttsVoice` | `"alloy"` |
| TTS speed | `voice.openaiAudioApi.ttsSpeed` | `1` |

#### Music Output

When music playback starts, `haltSessionOutputForMusicPlayback()` clears pending bot output and stops speech. Music audio (yt-dlp → ffmpeg) shares the same AudioPlayer — calling `audioPlayer.play()` replaces the current resource.

#### Output Lock & Barge-in

Bot turn tracking relies on the canonical `assistantOutput` state machine (see `docs/voice/voice-output-state-machine.md`). When a human speaks during bot output, `interruptBotSpeechForBargeIn()` cancels the active response, clears queued audio, and stores interruption context for the next turn's prompt. See `docs/voice/barge-in.md`.

System-initiated speech uses a separate opportunity lifecycle:

- thought-engine utterances can be cancelled before `bot_audio_started` if promoted user speech takes the floor first

---

## 5. Thought Engine

The thought engine generates ambient thoughts during silence — a parallel pipeline that feeds into voice output. It uses a system-speech opportunity lifecycle, and remains skippable after fire.

### Flow

1. **Silence timer**: waits `minSilenceSeconds` after last voice activity
2. **Eagerness roll**: random `[0,100)` vs `thoughtEngine.eagerness` — skip if roll fails
3. **Generate candidate**: thought engine LLM produces a candidate (max `VOICE_THOUGHT_MAX_CHARS=220` chars)
4. **Decision gate**: separate LLM call evaluates relevance — allow/reject + optional memory enrichment (`VOICE_THOUGHT_MEMORY_SEARCH_LIMIT=8` facts retrieved)
5. **Delivery**: realtime utterance by default in realtime sessions; OpenAI audio API TTS when `voice.ttsMode="api"`

### Topicality Bias

As silence grows, the topicality anchor drifts: anchored (recent conversation) → blended → ambient (general/memory-driven).

### Settings

| Setting | Key Path | Default |
|---|---|---|
| Enabled | `voice.thoughtEngine.enabled` | `true` |
| Provider | `voice.thoughtEngine.provider` | `"anthropic"` |
| Model | `voice.thoughtEngine.model` | `"claude-sonnet-4-6"` |
| Temperature | `voice.thoughtEngine.temperature` | `1.2` |
| Eagerness | `voice.thoughtEngine.eagerness` | `50` |
| Min silence | `voice.thoughtEngine.minSilenceSeconds` | `15` |
| Min interval | `voice.thoughtEngine.minSecondsBetweenThoughts` | `30` |

### Constants

| Constant | Value |
|---|---|
| `VOICE_THOUGHT_LOOP_MIN_SILENCE_SECONDS` | `8` |
| `VOICE_THOUGHT_LOOP_MAX_SILENCE_SECONDS` | `300` |
| `VOICE_THOUGHT_LOOP_MIN_INTERVAL_SECONDS` | `8` |
| `VOICE_THOUGHT_LOOP_MAX_INTERVAL_SECONDS` | `600` |
| `VOICE_THOUGHT_LOOP_BUSY_RETRY_MS` | `1400` |
| `VOICE_THOUGHT_MAX_CHARS` | `220` |
| `VOICE_THOUGHT_DECISION_MAX_OUTPUT_TOKENS` | `220` |

---

## 6. Provider Capabilities

From `REALTIME_PROVIDER_CAPABILITIES` in `src/voice/voiceModes.ts`:

| Capability | OpenAI (`openai_realtime`) | xAI (`voice_agent`) | Gemini (`gemini_realtime`) | ElevenLabs (`elevenlabs_realtime`) |
|---|---|---|---|---|
| `textInput` | yes | yes | yes | yes |
| `updateInstructions` | yes | yes | yes | — |
| `updateTools` | yes | yes | — | — |
| `cancelResponse` | yes | yes | — | — |
| `perUserAsr` | yes | yes | — | — |
| `sharedAsr` | yes | yes | yes | yes |

Guards use `providerSupports(mode, capability)` for capability routing.

---

## 7. Settings Reference

### Reply Path & Eagerness

| Setting | Key Path | Type | Default |
|---|---|---|---|
| Reply path | `voice.replyPath` | `"native" \| "bridge" \| "brain"` | `"bridge"` |
| Reply eagerness | `voice.replyEagerness` | `0-100` | `50` |
| Command-only mode | `voice.commandOnlyMode` | `boolean` | `false` |

### Providers

| Setting | Key Path | Default |
|---|---|---|
| Voice provider | `voice.voiceProvider` | `"openai"` |
| Brain provider | `voice.brainProvider` | `"openai"` |
| Transcriber provider | `voice.transcriberProvider` | `"openai"` |

### Generation LLM (brain path)

| Setting | Key Path | Default |
|---|---|---|
| Use text model | `voice.generationLlm.useTextModel` | `true` |
| Provider | `voice.generationLlm.provider` | `"anthropic"` |
| Model | `voice.generationLlm.model` | `"claude-sonnet-4-6"` |

### Reply Decision LLM (bridge classifier)

| Setting | Key Path | Default |
|---|---|---|
| Provider | `voice.replyDecisionLlm.provider` | `"anthropic"` |
| Model | `voice.replyDecisionLlm.model` | `"claude-haiku-4-5"` |
| Reasoning effort | `voice.replyDecisionLlm.reasoningEffort` | `"minimal"` |
| Admission mode | `voice.admission.mode` | `"classifier_gate"` |
| Music wake latch | `voice.replyDecisionLlm.musicWakeLatchSeconds` | `15` |

### Thought Engine

| Setting | Key Path | Default |
|---|---|---|
| Enabled | `voice.thoughtEngine.enabled` | `true` |
| Provider | `voice.thoughtEngine.provider` | `"anthropic"` |
| Model | `voice.thoughtEngine.model` | `"claude-sonnet-4-6"` |
| Temperature | `voice.thoughtEngine.temperature` | `1.2` |
| Eagerness | `voice.thoughtEngine.eagerness` | `50` |
| Min silence | `voice.thoughtEngine.minSilenceSeconds` | `15` |
| Min between thoughts | `voice.thoughtEngine.minSecondsBetweenThoughts` | `30` |

### ASR & Speech Output

| Setting | Key Path | Default |
|---|---|---|
| ASR model (bridge) | `voice.openaiRealtime.inputTranscriptionModel` | `"gpt-4o-transcribe"` |
| Per-user bridge | `voice.openaiRealtime.usePerUserAsrBridge` | `true` |
| Transcription method | `voice.openaiRealtime.transcriptionMethod` | `"realtime_bridge"` |
| Language mode | `voice.asrLanguageMode` | `"auto"` |
| Language hint | `voice.asrLanguageHint` | `"en"` |
| ASR model (file) | `voice.openaiRealtime.inputTranscriptionModel` | `"gpt-4o-mini-transcribe"` |
| TTS model | `voice.openaiAudioApi.ttsModel` | `"gpt-4o-mini-tts"` |
| TTS voice | `voice.openaiAudioApi.ttsVoice` | `"alloy"` |
| TTS speed | `voice.openaiAudioApi.ttsSpeed` | `1` |

### Session

| Setting | Key Path | Default |
|---|---|---|
| Max session minutes | `voice.maxSessionMinutes` | `30` |
| Inactivity leave | `voice.inactivityLeaveSeconds` | `300` |

---

## 8. Screen Share Integration

Screen share is layered onto the same brain/runtime path:
- Frame ingestion: `src/voice/voiceStreamWatch.ts`
- Commentary uses `requestTextUtterance` flow when available
- Works across realtime providers through shared session orchestration
- Commentary responses tracked separately via `pendingCommentaryResponseId` to prevent stacking (staleness valve at 30s)

---

## 9. Extensibility

- **Add voice providers**: add entry to `REALTIME_PROVIDER_CAPABILITIES` in `src/voice/voiceModes.ts`, map runtime in `resolveVoiceRuntimeMode()`
- **Add brain providers**: extend provider resolution in `voiceSessionHelpers.ts` and reply strategy handling
- **Add transcriber providers**: extend `TRANSCRIBER_PROVIDERS` and per-turn transcription plumbing
- **Add tools**: extend `resolveVoiceRealtimeToolDescriptors()` in `src/voice/voiceToolCalls.ts`
