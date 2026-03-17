# Voice Pipeline — Provider Abstraction and Stage Reference

> **Scope:** Current voice transport stack, runtime modes, and canonical settings surfaces.
> Shared attention model: [`../architecture/presence-and-attention.md`](../architecture/presence-and-attention.md)
> Activity model and knob map: [`../architecture/activity.md`](../architecture/activity.md)
> Cross-cutting settings contract: [`../reference/settings.md`](../reference/settings.md)
> Capture and ASR details: [`voice-capture-and-asr-pipeline.md`](voice-capture-and-asr-pipeline.md)
> Reply orchestration: [`voice-client-and-reply-orchestration.md`](voice-client-and-reply-orchestration.md)
> Output and barge-in: [`voice-output-and-barge-in.md`](voice-output-and-barge-in.md)
> Discord-native stream transport: [`discord-streaming.md`](discord-streaming.md)
> Historical stream-watch rollout: [`../archive/selfbot-stream-watch.md`](../archive/selfbot-stream-watch.md)
> `clankvox` local docs: [`../../src/voice/clankvox/README.md`](../../src/voice/clankvox/README.md)

This document describes the voice spoke under the shared attention contract: capture, transcription, admission, transport, output, and voice-side ambient delivery.

In this fork, the Discord voice transport is selfbot-owned. Bun owns the user-account gateway/session lifecycle and reply orchestration. `clankvox` is the Rust media plane that owns RTP, DAVE, Opus, mixer/output pacing, and the native Go Live stream-watch / stream-publish transport legs.

## 1. Canonical Settings Surface

Persistence, preset inheritance, dashboard envelope shape, and save/version semantics now live in [`../reference/settings.md`](../reference/settings.md).

This document keeps the voice-local settings surfaces that matter for voice transport and stage behavior.

Voice configuration is split across these live surfaces:

- `interaction.activity.*`: shared reactive text/voice behavior axes
- `agentStack.runtimeConfig.voice.*`: runtime/provider transport config
- `voice.conversationPolicy.*`: reply-path and conversation behavior
- `voice.admission.*`: public reply-admission policy
- `voice.transcription.*`: ASR enablement and language hinting
- `voice.channelPolicy.*`: channel/user access control
- `voice.sessionLimits.*`: session duration and concurrency limits
- `voice.soundboard.*`: Discord soundboard capability and catalog selection
- `initiative.voice.*`: proactive voice-thought cadence

Preset resolution also matters:

- `agentStack.preset`
- `agentStack.overrides.voiceAdmissionClassifier`

## 2. Runtime Overview

The voice stack keeps transport and behavior separate:

1. `runtime mode` chooses the realtime provider family
2. `reply path` chooses how turns are planned
3. `admission` decides whether a turn should reach generation
4. `generation` and `tools` run either in the provider-native loop or the orchestrator loop
5. `output` speaks through realtime or API TTS, then `clankvoxClient` paces generated PCM into the Rust mixer while preserving queued speech unless an interruption clears it

Shared continuity can inform this stack. Voice does not own the whole conversational mind; it owns how that continuity becomes audible in a live room.

Media-plane ownership:

- selfbot gateway/session: Discord control-plane identity, voice-state events, stream discovery dispatch
- `clankvox`: Discord media-plane transport, encryption/decryption, and frame/audio ingress/egress
- Bun voice runtime: turn lifecycle, tools, prompt assembly, commentary, and stream-watch decode/ingest after IPC

Current transport roles inside `clankvox`:

- `voice`: main bidirectional voice transport for audio send/receive
- `stream_watch`: inbound Go Live receive transport for native screen watch
- `stream_publish`: outbound Go Live sender transport for native self publish

Runtime mode values:

- `openai_realtime`
- `voice_agent`
- `gemini_realtime`
- `elevenlabs_realtime`

Reply-path values:

- `native`
- `bridge`
- `brain`

Base defaults from `settingsSchema.ts`:

- `agentStack.runtimeConfig.voice.runtimeMode = "openai_realtime"`
- `voice.conversationPolicy.replyPath = "brain"`
- `voice.conversationPolicy.ttsMode = "realtime"`
- `voice.admission.mode = "generation_decides"`

Voice runtime precedence is:

- explicit `agentStack.runtimeConfig.voice.runtimeMode`
- preset default

## 3. Reply Paths

### Native

The provider owns audio input, planning, tool calls, and audio output end to end.

Properties:

- lowest orchestration overhead
- provider-native tool loop when the runtime supports it
- no local text-generation stage

Native is available on runtimes that support provider-native planning, including `openai_realtime` and `voice_agent`.

### Bridge

The runtime transcribes speech locally, then forwards labeled text to the realtime provider. The provider still owns response planning and provider-native tool calls.

Properties:

- text-mediated realtime turn handling
- classifier-first admission in practice
- provider-native tool loop when supported

### Brain

The orchestrator owns text generation and tool calling. The realtime provider is used as TTS transport (WebSocket streaming for OpenAI/xAI/Gemini/ElevenLabs), or OpenAI Audio API is used as TTS when `voice.conversationPolicy.ttsMode = "api"`.

Properties:

- works with all runtime/provider combinations
- shared text/voice tool loop behavior
- generation binding comes from `agentStack.runtimeConfig.voice.generation`

## 4. Stage Visibility Matrix

| Stage | Native | Bridge | Brain |
|---|---|---|---|
| Audio capture | yes | yes | yes |
| Transcription | provider-native or bypassed | yes | yes |
| Noise rejection / promotion gates | yes | yes | yes |
| Deterministic admission | yes | yes | yes |
| Classifier admission | no text classifier path | effectively yes | optional |
| Provider-native planning | yes | yes | no |
| Orchestrator text generation | no | no | yes |
| Realtime output transport | yes | yes | yes |
| API TTS override | no | no | yes |
| Voice thought engine | yes | yes | yes |

## 5. Stage Reference

### Stage 1: Capture And Transcription

Canonical public ASR settings:

- `voice.transcription.enabled`
- `voice.transcription.languageMode`
- `voice.transcription.languageHint`

Canonical runtime transport/transcription settings:

- `agentStack.runtimeConfig.voice.openaiRealtime.inputAudioFormat`
- `agentStack.runtimeConfig.voice.openaiRealtime.outputAudioFormat`
- `agentStack.runtimeConfig.voice.openaiRealtime.transcriptionMethod`
- `agentStack.runtimeConfig.voice.openaiRealtime.inputTranscriptionModel`
- `agentStack.runtimeConfig.voice.openaiRealtime.usePerUserAsrBridge`

These runtime settings configure bridge and file-turn transcription behavior. OpenAI transport maps configured audio formats onto the nested realtime media descriptors used in `session.update` payloads: `pcm16` becomes `audio/pcm`, `g711_ulaw` becomes `audio/pcmu`, and `g711_alaw` becomes `audio/pcma`.

### Stage 2: Turn Promotion And Noise Rejection

Before a turn reaches admission, the runtime applies:

- provisional capture promotion
- silence and short-clip filters
- bridge hallucination and ASR-confidence guards where applicable

Relevant modules:

- `src/voice/captureManager.ts`
- `src/voice/turnProcessor.ts`
- `src/voice/voiceDecisionRuntime.ts`

### Stage 3: Reply Admission

The public admission surface is:

- `voice.admission.mode`
- `voice.admission.musicWakeLatchSeconds`

Canonical music playback / wake-latch semantics live in [`music.md`](music.md).

This stage is the voice spoke's cost and floor gate. It is not a second conversational policy layer separate from the shared continuity contract. Its job is to decide when a voice turn is eligible to reach the main reply brain under live-room constraints.

Classifier binding is resolved through:

- preset defaults in `src/settings/agentStack.ts`
- `agentStack.overrides.voiceAdmissionClassifier`

Important runtime behavior:

- if `replyPath = "bridge"`, the runtime always behaves as classifier-first
- if `replyPath = "brain"`, the public admission mode preserves `generation_decides` or `classifier_gate`; `generation_decides` is the default and `classifier_gate` is an optional classifier-first cost gate before the main brain
- if `replyPath = "native"`, the canonical public admission mode normalizes to `generation_decides`
- surviving `brain` turns are generation-owned by default and the model decides reply vs `[SKIP]`
- `classifier_gate` and `generation_decides` are the canonical public settings values
- internal labels like `hard_classifier` and `generation_only` are implementation details used by `voiceReplyDecision.ts`

### Stage 4: Generation And Tool Ownership

`native` and `bridge` use provider-native planning when the runtime supports it.

`brain` uses:

- `agentStack.runtimeConfig.voice.generation`

Tool ownership:

- canonical local tool definitions come from `src/tools/toolRegistry.ts` and `src/tools/sharedToolSchemas.ts`
- provider-native voice exports are assembled in `src/voice/voiceToolCallToolRegistry.ts`
- execution is still centralized in `src/voice/voiceToolCallDispatch.ts`
- full-brain replies use the shared orchestrator tool loop instead of provider-native replanning
- provider-native sessions emit `realtime_tool_call_*` events; brain/transport-only sessions emit `voice_brain_*` events

Turn-context parity:

- `src/voice/voiceTurnContext.ts` is the shared live-room context builder for both full-brain replies and provider-native realtime instruction refresh
- that shared context normalizes participant roster, recent membership/effect events, native Discord sharers, screen-watch capability, stream-watch notes, compacted session summary, music state, and recent tool outcomes into one prompt-facing shape
- `src/voice/voiceMemoryContext.ts` applies the same continuity and behavioral-memory loading policy to provider-native instruction refreshes and brain-path generation turns
- `src/voice/voiceToolResultSummary.ts` is the canonical compact tool-result summary shape for both brain and provider-native tool loops, so follow-up reasoning sees the same post-tool facts even when the transport differs
- provider-native tool completion schedules a live instruction refresh after execution, so the realtime model sees the updated tool outcome summary and room state instead of reasoning from stale pre-tool instructions

Voice tool continuation policy (`voiceContinuationPolicy` in `sharedToolSchemas.ts`):

Each tool declares whether the LLM gets a follow-up generation turn after the tool executes. This controls whether tool results are fed back to the LLM for a spoken follow-up.

| Policy | Behavior | Typical tools |
|---|---|---|
| `always` | Tool result is always fed back to the LLM for follow-up speech. The LLM sees the result (including errors) and can respond. | `video_play`, `music_play`, `web_search`, `browser_open`, `code_execute`, `memory_write` |
| `fire_and_forget` | No follow-up generation. The tool is a silent side-effect; the LLM's speech from the same generation is the complete response. If the LLM needs to say something, it must include text alongside the tool call. | `play_soundboard`, `music_skip`, `note_context`, `leave_voice_channel`, `start_screen_watch` |

When speech is dispatched before tools execute (pre-tool flush or sentence streaming), `fire_and_forget` tools will not produce additional speech on failure. This is intentional — these tools are low-failure side effects where the preamble speech is the complete user-facing response.

### Stage 5: Output

Conversation-policy output knobs:

- `voice.conversationPolicy.replyPath`
- `voice.conversationPolicy.ttsMode`
- `voice.conversationPolicy.streaming.*`

API TTS config:

- `agentStack.runtimeConfig.voice.openaiAudioApi.ttsModel`
- `agentStack.runtimeConfig.voice.openaiAudioApi.ttsVoice`
- `agentStack.runtimeConfig.voice.openaiAudioApi.ttsSpeed`

### Stage 6: Voice Thought Engine

Canonical cadence settings:

- `initiative.voice.enabled`
- `initiative.voice.eagerness`
- `initiative.voice.minSilenceSeconds`
- `initiative.voice.minSecondsBetweenThoughts`

This is the voice transport for ambient attention. It is the spoken counterpart to the ambient text cycle, not a separate behavioral system.

Implementation note:

- the thought generator resolves provider/model from the resolved voice-initiative binding (`initiative.voice.execution`)

Relevant modules:

- `src/voice/thoughtEngine.ts`
- `src/voice/voiceThoughtGeneration.ts`

### Stage 7: Soundboard Behavior

Canonical soundboard settings:

- `voice.soundboard.eagerness`
- `voice.soundboard.enabled`
- `voice.soundboard.allowExternalSounds`
- `voice.soundboard.preferredSoundIds`

Implementation note:

- `voice.soundboard.eagerness` is prompt context, not a hard gate. Lower values push the runtime toward restraint; higher values let it use Discord sound effects more playfully when the joke lands.
- `play_soundboard` is the canonical soundboard mechanism on provider-native `native` and `bridge` sessions. Those sessions should not emit `[[SOUNDBOARD:...]]` markup in spoken replies.
- The canonical precise timing mechanism on the `brain` path is inline `[[SOUNDBOARD:<sound_ref>]]` control markup in the model text. The runtime parses those directives into an ordered speech/soundboard sequence.
- Buffered brain playback routes the whole reply through that ordered sequencer.
- Streamed brain playback reuses the same ordered sequencer chunk-by-chunk. This supports `speech -> soundboard -> speech` timing inside streamed replies, but playback remains serialized rather than mixed.
- Normal streamed chunk emission waits for the configured minimum completed sentences per chunk before dispatch. `maxBufferChars` and final flush still force delivery so long run-ons and short tails do not stall playback.
- The default brain streaming settings are intentionally prosody-biased, not minimum-latency-biased. `minSentencesPerChunk=2` and a sentence-coherent first chunk exist so realtime exact-line playback sounds like one continuous thought instead of a run of tiny restarty utterances.
- If a deployment needs faster first-byte latency on slow model/tool turns, prefer a per-turn timeout fallback that relaxes chunking after a latency budget rather than lowering these defaults globally.
- In realtime streaming, any chunk that contains inline soundboard directives is treated as a strict output barrier. Earlier queued or buffered assistant speech must finish before that chunk continues, so the soundboard beat cannot jump ahead of the speech it belongs to.
- When a streamed realtime speech step precedes an inline soundboard beat, the completion wait is request-scoped. Tail flags like `botTurnOpen` do not hold the beat after that specific utterance has already finished draining.
- Parsing inline refs out of provider-native output transcripts remains a compatibility fallback, not the primary timing path.

## 6. Settings Reference

### Shared Activity Axes

| Setting | Default | Meaning |
|---|---|---|
| `interaction.activity.responseWindowEagerness` | `55` | How strongly recent engagement is framed to voice follow-up prompting/classification; the core voice recency window is still runtime-owned |
| `interaction.activity.reactivity` | `40` | Shared tendency for emoji beats and other lightweight reactions |

### Conversation Policy

| Setting | Default | Meaning |
|---|---|---|
| `voice.conversationPolicy.ambientReplyEagerness` | `50` | Ambient voice reply willingness when not directly addressed |
| `voice.conversationPolicy.commandOnlyMode` | `false` | Restrict replies toward command/wake interactions |
| `voice.conversationPolicy.allowNsfwHumor` | `true` | Voice tone guardrail input |
| `voice.conversationPolicy.textOnlyMode` | `false` | Disable voice output while still processing turns |
| `voice.conversationPolicy.defaultInterruptionMode` | `"speaker"` | Default barge-in target |
| `voice.conversationPolicy.replyPath` | `"brain"` | `native`, `bridge`, or `brain` |
| `voice.conversationPolicy.ttsMode` | `"realtime"` | `realtime` or `api` output |
| `voice.conversationPolicy.streaming.enabled` | `true` | Enables streamed speech chunks on brain path |
| `voice.conversationPolicy.streaming.minSentencesPerChunk` | `2` | Minimum completed sentences before a normal streamed chunk emits |
| `voice.conversationPolicy.streaming.eagerFirstChunkChars` | `30` | Minimum buffered chars before the first streamed chunk can emit eagerly |
| `voice.conversationPolicy.streaming.maxBufferChars` | `300` | Forced break size when streaming text grows too large without a clean chunk boundary |

### Soundboard Policy

| Setting | Default | Meaning |
|---|---|---|
| `voice.soundboard.eagerness` | `40` | How readily the bot should use Discord soundboard beats when they fit |
| `voice.soundboard.enabled` | `true` | Enable Discord soundboard playback in live voice sessions |
| `voice.soundboard.allowExternalSounds` | `false` | Allow refs that target sounds from another guild |
| `voice.soundboard.preferredSoundIds` | `[]` | Preferred refs to expose before falling back to the live guild catalog |

### Admission

| Setting | Default | Meaning |
|---|---|---|
| `voice.admission.mode` | `"generation_decides"` | Public admission mode |
| `voice.admission.musicWakeLatchSeconds` | `30` | Wake follow-up window during music playback |

Classifier provider/model are resolved from preset defaults or `agentStack.overrides.voiceAdmissionClassifier`.

### Transcription

| Setting | Default | Meaning |
|---|---|---|
| `voice.transcription.enabled` | `true` | Master ASR toggle |
| `voice.transcription.languageMode` | `"auto"` | Auto or fixed language mode |
| `voice.transcription.languageHint` | `"en"` | Language hint for fixed/biased transcription |

### Voice Runtime Config

| Setting | Default | Meaning |
|---|---|---|
| `agentStack.runtimeConfig.voice.runtimeMode` | `"openai_realtime"` | Realtime runtime family |
| `agentStack.runtimeConfig.voice.openaiRealtime.model` | `"gpt-realtime"` | OpenAI realtime model |
| `agentStack.runtimeConfig.voice.openaiRealtime.voice` | `"ash"` | OpenAI realtime voice |
| `agentStack.runtimeConfig.voice.openaiRealtime.inputAudioFormat` | `"pcm16"` | OpenAI realtime input transport format |
| `agentStack.runtimeConfig.voice.openaiRealtime.outputAudioFormat` | `"pcm16"` | OpenAI realtime output transport format |
| `agentStack.runtimeConfig.voice.openaiRealtime.transcriptionMethod` | `"realtime_bridge"` | Bridge vs file-turn transcription mode |
| `agentStack.runtimeConfig.voice.openaiRealtime.inputTranscriptionModel` | `"gpt-4o-mini-transcribe"` | Realtime ASR model |
| `agentStack.runtimeConfig.voice.openaiRealtime.usePerUserAsrBridge` | `true` | Per-speaker bridge mode |
| `agentStack.runtimeConfig.voice.openaiAudioApi.ttsModel` | `"gpt-4o-mini-tts"` | API TTS model |
| `agentStack.runtimeConfig.voice.openaiAudioApi.ttsVoice` | `"alloy"` | API TTS voice |
| `agentStack.runtimeConfig.voice.openaiAudioApi.ttsSpeed` | `1` | API TTS speed |
| `agentStack.runtimeConfig.voice.generation` | dedicated model policy | Brain-path text generation binding |

### Session Limits

| Setting | Default | Meaning |
|---|---|---|
| `voice.sessionLimits.maxSessionMinutes` | `30` | Max session duration |
| `voice.sessionLimits.inactivityLeaveSeconds` | `300` | Auto-leave inactivity timer |
| `voice.sessionLimits.maxSessionsPerDay` | `120` | Daily session cap |
| `voice.sessionLimits.maxConcurrentSessions` | `3` | Concurrency cap |

### Voice Thought Engine

| Setting | Default | Meaning |
|---|---|---|
| `initiative.voice.enabled` | `true` | Enable proactive voice thoughts |
| `initiative.voice.eagerness` | `50` | Probability gate before thought generation |
| `initiative.voice.minSilenceSeconds` | `45` | Required silence before a thought attempt |
| `initiative.voice.minSecondsBetweenThoughts` | `60` | Minimum spacing between thought attempts |

## 7. Provider Capabilities

Current runtime families:

| Runtime | Typical provider | Notes |
|---|---|---|
| `openai_realtime` | OpenAI | Supports native, bridge, and brain transports |
| `voice_agent` | xAI | Shipped native path via `grok_native_agent` preset |
| `gemini_realtime` | Gemini | Realtime transport/runtime family |
| `elevenlabs_realtime` | ElevenLabs | Full-brain runtime with WebSocket streaming TTS (`ElevenLabsRealtimeClient`), shared ASR bridge, and optional file-turn transcription |

Provider differences live in thin adapters. The higher-level product behavior stays in shared orchestration, prompts, and tool execution.

## 8. Source Files

- `src/settings/agentStack.ts`
- `src/settings/settingsSchema.ts`
- `src/voice/voiceConfigResolver.ts`
- `src/voice/voiceReplyDecision.ts`
- `src/voice/turnProcessor.ts`
- `src/voice/sessionLifecycle.ts`
- `src/voice/voiceToolCallDispatch.ts`
- `src/voice/voiceThoughtGeneration.ts`
- `src/voice/elevenLabsRealtimeClient.ts`
