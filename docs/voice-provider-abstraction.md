# V2 Voice Chat System — Provider Abstraction and Runtime Architecture

This document now covers both:
1. provider abstraction and swappability
2. how the shipped runtime actually delivers end-to-end voice chat (source of truth: code in `src/voice/*`)

## Design Philosophy

The v2 system keeps voice chat split into independently swappable layers:
1. `Voice/TTS provider`
2. `Brain provider`
3. `Transcriber provider` (currently OpenAI)

This is encoded in:
- `src/voice/voiceModes.ts`
- `src/voice/voiceSessionHelpers.ts`

Provider resolution path:

```ts
voiceProvider = resolveVoiceProvider(settings)        // default: "openai"
brainProvider = resolveBrainProvider(settings)        // default: "openai"
transcriberProvider = resolveTranscriberProvider(...) // default: "openai"
runtimeMode = resolveVoiceRuntimeMode(settings)       // openai/xai/gemini/elevenlabs + legacy mode fallback
```

## Runtime Modes and Brain Strategy

`src/voice/voiceModes.ts` defines runtime modes:
- `voice_agent`
- `openai_realtime`
- `gemini_realtime`
- `elevenlabs_realtime`
- `stt_pipeline`

`src/voice/voiceSessionManager.ts` decides reply strategy via `resolveRealtimeReplyStrategy()`:
- `voice.replyPath == "native"` => `native` strategy
- `voice.replyPath == "bridge"` or `"brain"` => `brain` strategy
- Falls back to legacy `brainProvider` check if `replyPath` is not set

Key implication:
- In any realtime mode + `brain` strategy, we can run per-speaker ASR transcription fan-out, inject labeled text into the realtime session, and let that brain do tool calling. This works with any provider that supports `textInput` (OpenAI, xAI, Gemini, ElevenLabs).
- In `native`, we forward audio and let provider-native realtime flow handle response generation.

Provider capabilities are declared in `REALTIME_PROVIDER_CAPABILITIES` in `src/voice/voiceModes.ts`. Guards use `providerSupports(mode, capability)` instead of hardcoded provider checks.

## How Overall Voice Chat Is Achieved (Code-Backed)

### 1) Session bootstrap and wiring

In `src/voice/voiceJoinFlow.ts`, join flow does all of the following in one place:
- Resolves runtime mode and provider clients.
- Connects provider realtime client.
- For OpenAI, sets `turnDetection: null` and initializes tool schema via `buildRealtimeFunctionTools(...)`.
- Joins Discord voice, creates audio player and raw bot audio stream.
- Initializes per-session runtime state:
  - `openAiAsrSessions` (per-user ASR map)
  - `openAiPendingToolCalls` / `openAiToolCallExecutions`
  - `mcpStatus`
  - `memoryWriteWindow`
  - `musicQueueState`
  - barge-in suppression counters
- Binds realtime handlers and schedules instruction/tool refresh.

### 2) Per-speaker transcription (Option B, no mixed mono)

In `src/voice/voiceSessionManager.ts`:
- `onSpeakingStart` calls `beginOpenAiAsrUtterance(...)` when per-user ASR bridge is active.
- `startInboundCapture(...)` subscribes to Discord receiver per user (`connection.receiver.subscribe(userId)`), decodes Opus to PCM, normalizes/resamples PCM, and streams chunks.
- Each speaker has one ASR state in `openAiAsrSessions: Map<userId, state>`.
- `ensureOpenAiAsrSessionConnected(...)` creates one `OpenAiRealtimeTranscriptionClient` per active speaker and keeps it warm briefly.
- `appendAudioToOpenAiAsr(...)` streams audio.
- `commitOpenAiAsrUtterance(...)` commits utterance, waits for transcript settle window, and returns transcript metadata.
- The finalized transcript is forwarded into turn processing through `queueRealtimeTurn(..., transcriptOverride: ...)`.

ASR session client details are in `src/voice/openaiRealtimeTranscriptionClient.ts`:
- uses OpenAI realtime transcription websocket
- emits partial/final transcript from `conversation.item.input_audio_transcription.*`

### 3) Turn manager and routing

`runRealtimeTurn(...)` in `src/voice/voiceSessionManager.ts` performs:
- silence/short-clip gating
- transcription (or uses transcript override from per-user ASR)
- reply admission decision (`evaluateVoiceReplyDecision(...)`)
- branch:
  - `native` strategy => `forwardRealtimeTurnAudio(...)`
  - `brain` strategy + transcript bridge active => `forwardRealtimeTextTurnToBrain(...)`
  - `brain` strategy without transcript bridge => `runRealtimeBrainReply(...)`

### 4) Brain session input format and instruction refresh

`forwardRealtimeTextTurnToBrain(...)`:
- labels transcript as `(<speakerName>): <text>`
- refreshes context-aware instructions and tool config before request
- sends turn into the realtime provider via `realtimeClient.requestTextUtterance(...)`

`refreshRealtimeInstructions(...)` and `prepareRealtimeTurnContext(...)` refresh:
- participant/membership context
- memory slice
- tool policy context

### 5) Tool calling loop (Realtime brain)

OpenAI realtime client (`src/voice/openaiRealtimeClient.ts`) supports:
- `conversation.item.create` for user text
- `response.create` for explicit generation
- `conversation.item.create` `function_call_output` for tool results

Runtime loop in `src/voice/voiceSessionManager.ts`:
- `bindRealtimeHandlers(...)` routes raw provider events to the function-call handler.
- Function-call envelopes are parsed from OpenAI function-call delta/done events.
- Arguments are accumulated until done.
- Tool execution dispatch:
  - local function tools via `executeLocalVoiceToolCall(...)`
  - MCP tools via `executeMcpVoiceToolCall(...)`
- Output is returned with `sendFunctionCallOutput(...)`.
- Follow-up response is scheduled via `scheduleOpenAiRealtimeToolFollowupResponse(...)`.

### 6) Local tool surface: memory + music + web

`resolveVoiceRealtimeToolDescriptors(...)` defines local function tools:
- `memory_search`
- `memory_write`
- `music_search`
- `music_queue_add`
- `music_play`
- `music_pause`
- `music_resume`
- `music_skip`
- `music_now_playing`
- `web_search` (when enabled)

### 7) Vector memory write behavior (no approvals)

`memory_write` is a local function tool (not gated by MCP approval flow). In `executeVoiceMemoryWriteTool(...)`:
- rate limit: `VOICE_MEMORY_WRITE_MAX_PER_MINUTE = 5`
- dedupe threshold default: `0.9`
- namespace guardrails enforced by `resolveVoiceMemoryNamespaceScope(...)`
  - `user:<id>` and `guild:<id>` validation
  - mismatch rejection
- sensitive-pattern rejection (`MEMORY_SENSITIVE_PATTERN_RE`)
- writes fact row + ensures vector embedding (`memory.ensureFactVector(...)`)
- records write window for rate limiting

This matches the "read + write, no human approval" requirement while still enforcing technical guardrails.

### 8) MCP integration for governance and extensions

MCP servers are represented as runtime server status rows in `mcpStatus`.
`resolveVoiceRealtimeToolDescriptors(...)` merges MCP-discovered tools into the effective tool list with `toolType: "mcp"`.

MCP call path:
- `executeMcpVoiceToolCall(...)` posts `{ toolName, arguments }` to configured MCP server tool endpoint.
- Success/failure updates per-server health (`lastError`, `lastCallAt`, `connected`).

### 9) Music queue controls and output routing

Queue/tool behavior in `src/voice/voiceSessionManager.ts`:
- queue state in `musicQueueState`
- search/catalog in `executeVoiceMusicSearchTool(...)`
- enqueue in `executeVoiceMusicQueueAddTool(...)`
- playback in `playVoiceQueueTrackByIndex(...)`
- pause/resume/skip/now-playing in `executeLocalVoiceToolCall(...)`

When music playback starts, `haltSessionOutputForMusicPlayback(...)`:
- clears pending assistant response/output queue
- stops/destroys bot speech stream
- aborts inbound captures while music is active

### 10) Barge-in and interruption behavior

When a human starts speaking and bot output is active:
- `interruptBotSpeechForBargeIn(...)` cancels active response if possible
- clears queued audio and stops player immediately
- stores retry candidate (`pendingBargeInRetry`) when appropriate
- starts suppression window (`BARGE_IN_SUPPRESSION_MAX_MS`)

If conditions allow, `maybeHandleInterruptedReplyRecovery(...)` can retry the interrupted assistant utterance for brief interruptions.

## Mapping to the Original Iterated Spec

Status against the spec in this repo:

1. `Option B per-speaker transcription`: implemented for OpenAI realtime brain path via per-user ASR sessions (`openAiAsrSessions` + `OpenAiRealtimeTranscriptionClient`).
2. `Queue controls`: implemented as local tools (`music_search`, `music_queue_add`, `music_play`, `music_pause`, `music_resume`, `music_skip`, `music_now_playing`).
3. `Vector memory read + write, no approvals`: implemented as local function tools (`memory_search`, `memory_write`) with guardrails.
4. `MCP tool surface + governance`: implemented via merged MCP tool descriptors and explicit MCP call runtime.
5. `Realtime brain session does tool calling`: implemented in OpenAI realtime event/tool loop.
6. `One transcription session per speaker`: implemented in per-user ASR map lifecycle and capture integration.

## Backwards Compatibility

Compatibility behavior is still preserved:
1. `resolveVoiceRuntimeMode()` honors legacy `settings.voice.mode`.
2. Older mode values continue to map to equivalent runtime behavior.
3. `voice.replyPath` supersedes `realtimeReplyStrategy` and `brainProvider` for reply routing. Legacy values are migrated automatically in `settingsNormalization.ts`.

## Screen Share Integration

Screen share stays provider-agnostic and is layered onto the same brain/runtime path:
- frame ingestion and context handling: `src/voice/voiceStreamWatch.ts`
- realtime commentary uses existing `requestTextUtterance` flow when available
- works across current realtime providers through shared session orchestration

## Extensibility

- Add voice providers in `src/voice/voiceModes.ts`: add an entry to `REALTIME_PROVIDER_CAPABILITIES` and map runtime in `resolveVoiceRuntimeMode(...)`.
- Add brain providers by extending provider resolution and reply strategy handling.
- Add transcriber providers by extending `TRANSCRIBER_PROVIDERS` and per-turn transcription plumbing.
- Add new local or MCP tools by extending `resolveVoiceRealtimeToolDescriptors(...)`.
