# Improvements Roadmap

## Part 1: Rust Boundary Expansion

The Rust subprocess already handles Discord voice transport (UDP, RTP, AEAD crypto, DAVE E2EE, Opus codec, 20ms timing). These changes expand it to eliminate waste on the audio hot path.

### 1.1 Move Per-User ASR WebSocket into Rust

**Problem:** Every 20ms audio frame per user goes through 4 base64 conversions and a full process hop just to relay audio Rust already has in hand:

```
Rust (raw PCM) → base64 → JSON → pipe → Bun base64 decode → Bun base64 re-encode → JSON → WebSocket → OpenAI
```

**Change:** Rust opens the OpenAI Realtime Transcription WebSocket directly per user. Transcript text (low frequency, small payload) comes back via IPC.

**Target path:**
```
Rust (raw PCM) → base64 → WebSocket → OpenAI ASR
Rust ← transcript text ← WebSocket
Rust → {transcript JSON} → pipe → Bun
```

**Why it's clean:** Rust already tracks per-user audio state (`UserCaptureState`) with sample rate and silence duration. It already has `tokio-tungstenite`. The ASR client (`openaiRealtimeTranscriptionClient.ts`) is a simple WebSocket client — connect, send audio, receive transcript events.

**Estimate:** ~1 week

### 1.2 Switch IPC to Binary Framing for Audio

**Problem:** `user_audio` messages fire ~50 times/sec/user as JSON with base64 payloads. Base64 inflates data 33%. With 5 users, that's ~1.6 MB/s of redundant encoding overhead.

**Change:** Binary frame protocol for audio messages: `[4-byte msg_type][4-byte length][raw PCM bytes]`. Keep JSON for infrequent control messages (join, destroy, music commands, transcripts).

**Estimate:** ~3 days

### 1.3 Piggyback Signal Stats in Rust

**Problem:** The session manager iterates every PCM sample in JavaScript for peak detection and active sample counting:

```typescript
for (let offset = 0; offset < normalizedPcm.length; offset += 2) {
  const sample = normalizedPcm.readInt16LE(offset);
  // peak, active sample count...
}
```

Rust is already touching every sample during `convert_decoded_to_llm()`.

**Change:** Compute `signalPeakAbs`, `signalActiveSampleCount`, `signalSampleCount` in Rust during the existing conversion pass. Include them in the IPC message (or binary frame header). Eliminate the JS loop.

**Estimate:** ~1 day

### 1.4 What Stays in TypeScript

These should NOT move to Rust — the complexity is in control flow and policy, not throughput:

- LLM realtime clients (OpenAI, xAI, Gemini, ElevenLabs) — session management, tool calls, context refreshes
- Reply decision logic — LLM-driven, changes frequently
- Music queue/search — human-timescale operations
- Conversation state machine — 15K lines of policy that needs fast iteration

---

## Part 2: Code Decomposition

### 2.1 `voiceSessionManager.ts` — 15,029 lines (CRITICAL)

The single biggest maintainability problem. A god class with 100+ methods spanning 8+ unrelated domains. Session state is an untyped plain object with 50+ ad-hoc properties mutated from everywhere.

#### 2.1.1 Define `VoiceSession` type

The highest-impact single change. Create a typed `VoiceSession` interface (or class) that replaces the untyped session object. Every downstream refactor becomes easier once the shape is explicit.

#### 2.1.2 Extract `voiceAsr.ts`

`ensureOpenAiAsrSessionConnected` and `ensureOpenAiSharedAsrSessionConnected` are ~300 lines of nearly identical code (connect, transcript handling, error recovery). Deduplicate into a single factory parameterized by mode (per-user vs shared).

**~1,200 lines out.**

#### 2.1.3 Extract `voiceMusicPlayback.ts`

`requestPlayMusic` (~380 lines), `handleMusicDisambiguation`, `playNextInQueue`, queue state management, external playback, Discord streaming integration.

**~1,500 lines out.**

#### 2.1.4 Extract `voiceReplyDecision.ts`

`evaluateVoiceReplyDecision` (~350+ lines), addressing detection, barge-in logic, wake-word handling, reply cooldown management.

**~1,200 lines out.**

#### 2.1.5 Extract `voiceToolCalls.ts`

Memory search/write tool handling, web search dispatch, MCP tool execution, tool result formatting.

**~800 lines out.**

#### 2.1.6 Extract `voiceRuntimeState.ts`

`getRuntimeState()` (~430 lines) and dashboard snapshot building. Pure data assembly, no side effects.

**~500 lines out.**

**Result:** `voiceSessionManager.ts` drops to ~7,000 lines as an orchestrator. A second pass can then extract the realtime audio pipeline and thought engine.

### 2.2 `bot.ts` — 5,177 lines (HIGH)

#### 2.2.1 Extract `bot/replyPipeline.ts`

Break `maybeReplyToMessage` (~400 lines) into pipeline stages: context assembly → LLM call → response parsing → action dispatch → message sending. Each stage independently testable.

**~800 lines out.**

#### 2.2.2 Extract `bot/mediaGeneration.ts`

Image generation (OpenAI, xAI), video generation (xAI poll-based), GIF search (GIPHY). Unrelated to core message handling.

**~400 lines out.**

#### 2.2.3 Extract `bot/eventWiring.ts`

All Discord.js event listener registration, currently mixed into the constructor.

**~300 lines out.**

**Result:** `bot.ts` drops to ~3,500 lines focused on orchestration.

### 2.3 `store.ts` — 1,940 lines (MEDIUM)

#### 2.3.1 Extract `store/schema.ts`

All `CREATE TABLE`, `ALTER TABLE`, migration logic. Currently mixed with runtime queries.

**~300 lines out.**

#### 2.3.2 Extract domain-specific stores

`store/messageStore.ts` (message CRUD, history, pruning — ~400 lines) and `store/memoryStore.ts` (memory fact CRUD, embedding queries, search — ~300 lines).

**Result:** `store.ts` becomes ~900 lines as a thin facade.

### 2.4 `llm.ts` — 1,698 lines (MEDIUM)

#### 2.4.1 Extract provider implementations

Create an `LLMProvider` interface. Extract `llm/openaiProvider.ts` (~400 lines), `llm/anthropicProvider.ts` (~400 lines). Complete the partial extraction of Claude Code into `llmClaudeCode.ts` (~300 lines).

**Result:** `llm.ts` becomes a ~500-line router/facade.

### 2.5 `prompts.ts` — 1,545 lines (LOW)

Break `buildReplyPrompt` (~500 lines) into composable section builders: `buildContextSection`, `buildMemorySection`, `buildPersonalitySection`, etc. Each section becomes independently testable.

### 2.6 Lower Priority

| File | Lines | Recommendation |
|---|---|---|
| `dashboard.ts` (939) | Group routes into `dashboard/voiceRoutes.ts`, `dashboard/settingsRoutes.ts` |
| `screenShareSessionManager.ts` (911) | Extract HTML templates into `screenShareTemplates.ts` |
| `memory.ts` (1,082) | Extract embedding/search into `memory/search.ts` |

---

## Sequencing

**Phase 1 — Type the session object (prerequisite for everything else)**
1. Define `VoiceSession` interface
2. Add golden tests for voice session behavior before refactoring

**Phase 2 — Quick wins**
3. Deduplicate ASR code (2.1.2) — ~300 lines removed, low risk
4. Extract `voiceRuntimeState.ts` (2.1.6) — pure data assembly, no side effects
5. Piggyback signal stats in Rust (1.3) — 1 day, isolated change

**Phase 3 — Rust audio path**
6. Binary IPC framing (1.2)
7. ASR WebSocket in Rust (1.1)

**Phase 4 — Major extractions**
8. Extract music playback (2.1.3)
9. Extract reply decision (2.1.4)
10. Extract reply pipeline from bot.ts (2.2.1)
11. Extract tool calls (2.1.5)

**Phase 5 — Structural cleanup**
12. Store decomposition (2.3)
13. LLM provider extraction (2.4)
14. Prompt decomposition (2.5)
15. Dashboard route grouping (2.6)
