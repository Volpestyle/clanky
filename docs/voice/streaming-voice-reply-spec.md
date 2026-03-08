# Streaming Voice Reply Pipeline

## Problem

Voice replies currently wait for the **entire LLM response** before speaking. The latency chain:

```
ASR settle (~700ms) → full LLM generation (~1500-3000ms) → TTS request (~200ms) → audio start (~300ms)
                      ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
                      this is the bottleneck
```

With streaming, the first sentence speaks while the rest is still generating:

```
ASR settle (~700ms) → TTFT (~400ms) → first sentence (~200ms) → TTS → audio (~300ms)
                                        rest streams in background while user hears first sentence
```

**Expected latency improvement: 1-2 seconds off every voice reply.**

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  Anthropic Messages API (streaming)                             │
│  content_block_start(text) → content_block_delta → ...          │
│  content_block_start(tool_use) → content_block_delta → ...      │
└──────────────┬──────────────────────────────────────────────────┘
               │ SSE events
               ▼
┌─────────────────────────────────────────────────────────────────┐
│  LLM Streaming Layer (chatGeneration.ts)                        │
│  callAnthropicStreaming() → yields typed events                 │
│  - text deltas → onTextDelta callback                           │
│  - tool_use blocks → buffered, returned at end                  │
│  - usage/stop_reason → captured at message_delta                │
└──────────────┬──────────────────────────────────────────────────┘
               │ onTextDelta(chunk), onComplete(full result)
               ▼
┌─────────────────────────────────────────────────────────────────┐
│  Sentence Accumulator (new: sentenceAccumulator.ts)             │
│  Buffers text deltas, fires callback at sentence boundaries     │
│  - First chunk: fires eagerly (partial OK for low latency)      │
│  - Subsequent: waits for clean sentence breaks (. ! ? \n)       │
│  - Final flush: emits any remaining text                        │
└──────────────┬──────────────────────────────────────────────────┘
               │ onSentence(text)
               ▼
┌─────────────────────────────────────────────────────────────────┐
│  Voice Reply Pipeline (voiceReplyPipeline.ts)                   │
│  Each sentence → requestRealtimeTextUtterance()                 │
│  Tool calls → execute after text blocks, then stream next gen   │
└──────────────┬──────────────────────────────────────────────────┘
               │ utterance prompts (sequential)
               ▼
┌─────────────────────────────────────────────────────────────────┐
│  OpenAI Realtime API                                            │
│  conversation.item.create → response.create → audio deltas      │
│  Multiple utterances queue naturally in order                   │
└─────────────────────────────────────────────────────────────────┘
```

## Phases

### Phase 0: Kill the JSON Schema — Tools-Only Output

**Goal:** Eliminate the `REPLY_OUTPUT_JSON_SCHEMA` code path so every LLM
call uses tool calls for structured side-effects and plain text for speech.
This is a prerequisite for streaming — you cannot stream partial JSON and
speak it, but you *can* stream text blocks while tool_use blocks buffer.

#### Why the JSON schema exists today

The `REPLY_OUTPUT_SCHEMA` forces the model to return a single JSON object
with every possible side-effect packed in:

```json
{
  "text": "spoken reply",
  "skip": false,
  "reactionEmoji": "🔥",
  "media": { "type": "image_simple", "prompt": "a cat" },
  "webSearchQuery": "...",
  "soundboardRefs": ["airhorn"],
  "leaveVoiceChannel": false,
  "automationAction": { "operation": "create", ... },
  "voiceIntent": { "intent": "music_play_now", ... },
  "voiceAddressing": { "talkingTo": "James", "directedConfidence": 0.9 },
  "screenNote": "...",
  "screenMoment": "..."
}
```

This was the original design before tool calling existed. Most fields now
have tool equivalents; the rest need small new tools.

#### Current state: two code paths

| Pipeline | JSON Schema | Tools | Behavior |
|----------|-------------|-------|----------|
| **Voice** (`voiceReplies.ts:726`) | Only when `voiceReplyTools.length === 0` | Yes (common case) | Schema is fallback |
| **Text** (`replyPipeline.ts:694`) | **Always** | Yes (supplements) | Schema + tools together |
| **Automation** (`automationEngine.ts:452`) | Only when no tools | Yes | Same as voice |

#### Migration: JSON schema fields → tools

**Already covered by existing tools (no work needed):**
- `webSearchQuery` → `web_search`
- `browserBrowseQuery` → `browser_browse`
- `memoryLookupQuery` → `memory_search`
- `memoryLine` / `selfMemoryLine` → `memory_write`
- `imageLookupQuery` → `image_lookup`
- `openArticleRef` → `open_article` (voice only)
- `leaveVoiceChannel` → `leave_voice_channel`
- `voiceIntent` (music) → `music_search`, `music_play_now`, etc.
- `screenShareIntent` → `offer_screen_share_link`

**Need new tools:**

| JSON Field | New Tool | Scope | Schema |
|------------|----------|-------|--------|
| `reactionEmoji` | `react` | text | `{ emoji: string }` |
| `media` | `generate_media` | text | `{ type: "image"\|"video"\|"gif", prompt: string }` |
| `automationAction` | `manage_automation` | text | `{ operation, title, instruction, schedule, ... }` |
| `soundboardRefs` | `play_soundboard` | voice | `{ refs: string[] }` |
| `voiceAddressing` | `set_addressing` | voice | `{ talkingTo: string\|null, confidence: number }` |
| `screenNote` | `screen_note` | voice | `{ note: string }` |
| `screenMoment` | `screen_moment` | voice | `{ moment: string }` |

**Handled without tools:**
- `text` → model's plain text output (the text content blocks)
- `skip` → model outputs empty text or `[SKIP]` sentinel (already handled)

#### Migration plan

1. Create the new tool schemas in `sharedToolSchemas.ts`
2. Register them in `buildReplyToolSet()` with appropriate capability gates
3. Add tool result handlers in the voice and text reply pipelines
4. Update system prompts to remove JSON output instructions
5. Remove `REPLY_OUTPUT_SCHEMA`, `REPLY_OUTPUT_JSON_SCHEMA`,
   `parseStructuredReplyOutput`, and all `jsonSchema` parameters
6. Remove `appendJsonSchemaInstruction` in `llm.ts`
7. Ensure `voiceReplyTools.length` is always > 0 (it will be, since
   `leave_voice_channel` is always registered for voice)

#### Text pipeline consideration

The text pipeline (`replyPipeline.ts`) currently sends JSON schema on
**every** call, even alongside tools. This is the bigger migration surface:
the reply followup loop (`replyFollowup.ts`) reads parsed JSON fields as
fallback triggers for web search, browser browse, etc. With tools-only,
these become direct tool calls — the model calls `web_search` instead of
setting `webSearchQuery` in JSON.

This is actually simpler and more reliable. The model explicitly calls the
tool it wants rather than hoping the pipeline will notice a JSON field.

---

### Phase 1: LLM Streaming Layer

**Files:** `src/llm/chatGeneration.ts`, `src/llm/serviceShared.ts`, `src/llm.ts`

#### New streaming interface

```typescript
interface StreamCallbacks {
  /** Fired for each text delta within a text content block. */
  onTextDelta: (delta: string) => void;
  /** Fired when a complete content block finishes (text or tool_use). */
  onContentBlockComplete?: (block: ContentBlock) => void;
  /** Fired when the stream ends or errors. */
  onComplete: (result: ChatModelResponse) => void;
  /** Optional AbortSignal for cancellation. */
  signal?: AbortSignal;
}
```

#### New function: `callAnthropicStreaming()`

```typescript
async function callAnthropicStreaming(
  deps: AnthropicDeps,
  request: ChatModelRequest,
  callbacks: StreamCallbacks
): Promise<ChatModelResponse> {
  const stream = deps.anthropic.messages.stream({
    model: request.model,
    system: request.systemPrompt,
    messages: buildMessages(request),
    max_tokens: request.maxOutputTokens,
    temperature: request.temperature,
    tools: request.tools,
    // signal handled by MessageStream.abort()
  });

  // Stream text deltas immediately
  stream.on('text', (delta) => {
    callbacks.onTextDelta(delta);
  });

  // Wait for completion, collect full result
  const finalMessage = await stream.finalMessage();

  // Build standard ChatModelResponse from finalMessage
  return buildResponseFromMessage(finalMessage);
}
```

#### Key details

- Uses the Anthropic SDK's `MessageStream` which provides typed events
- The `text` event fires for every text delta — perfect for sentence accumulation
- Tool use blocks are automatically collected in the `finalMessage`
- The custom OAuth fetch wrapper (`claudeOAuth.ts:212-234`) already handles
  streaming transparently — it wraps the response body in a `ReadableStream`
  that strips tool name prefixes on each chunk
- AbortSignal support: `MessageStream` has `.abort()`, wire to the existing
  `generationSignal` from `activeReplies`

#### Expose on LLMService

```typescript
// src/llm.ts — new method alongside existing generate()
async generateStreaming({
  settings,
  systemPrompt,
  userPrompt,
  contextMessages,
  tools,
  trace,
  signal,
  onTextDelta,
}: GenerateStreamingParams): Promise<GenerateResult> {
  // Same provider resolution as generate()
  // Route to callAnthropicStreaming for anthropic/claude_oauth
  // Fall back to non-streaming generate() for other providers
}
```

Non-Anthropic providers (OpenAI, xAI) fall back to batch `generate()` —
streaming is an optimization, not a requirement. This keeps the blast
radius small.

---

### Phase 2: Sentence Accumulator

**New file:** `src/voice/sentenceAccumulator.ts`

Buffers streamed text deltas and fires a callback at sentence boundaries.

#### Interface

```typescript
interface SentenceAccumulatorOptions {
  /** Called with each complete sentence or sentence group. */
  onSentence: (text: string, index: number) => void;
  /** Eagerly fire the first chunk for lowest latency. */
  eagerFirstChunk?: boolean;
  /** Minimum chars before first eager fire (default: 60). */
  eagerMinChars?: number;
  /** Maximum chars to buffer before forcing a fire (default: 300). */
  maxBufferChars?: number;
}

class SentenceAccumulator {
  constructor(options: SentenceAccumulatorOptions);
  /** Feed a text delta from the stream. */
  push(delta: string): void;
  /** Flush any remaining buffered text (call at stream end). */
  flush(): void;
}
```

#### Sentence boundary detection

```typescript
// Sentence-ending patterns that indicate a good TTS break point
const SENTENCE_BREAK = /[.!?]\s+|[.!?]$/;
// Also break on natural pause patterns
const CLAUSE_BREAK = /[;:—]\s+/;
// Force break on newlines
const LINE_BREAK = /\n/;
```

#### First-chunk eagerness

For the very first sentence, we optimize for latency over completeness:
- Fire as soon as we have 60+ chars AND hit any punctuation
- This gets "Let me look that up." or "Sure, here's what I found." out
  fast, even if it's not a full sentence
- Subsequent chunks wait for proper sentence breaks

#### Soundboard directive handling

The model may emit inline soundboard directives like `[sfx:airhorn]` in
the text. The accumulator should NOT send these to TTS — they should be
stripped and forwarded to the soundboard handler. (Once Phase 0 migrates
soundboardRefs to a tool call, this becomes unnecessary.)

---

### Phase 3: Voice Reply Pipeline Integration

**Files:** `src/bot/voiceReplies.ts`, `src/voice/voiceReplyPipeline.ts`

#### Streaming generation path

Replace the batch `await runtime.llm.generate()` with:

```typescript
// voiceReplies.ts — inside generateVoiceTurn()
const sentenceIndex = { current: 0 };

const generation = await runtime.llm.generateStreaming({
  settings: tunedSettings,
  systemPrompt,
  userPrompt: initialUserPrompt,
  contextMessages: voiceContextMessages,
  tools: voiceReplyTools, // always non-empty after Phase 0
  trace: voiceTrace,
  signal,
  onTextDelta: (delta) => {
    accumulator.push(delta);
  },
});

accumulator.flush(); // emit any remaining text
```

The `onSentence` callback (set up on the accumulator) fires
`requestRealtimeTextUtterance()` for each sentence:

```typescript
const accumulator = new SentenceAccumulator({
  onSentence: (text, index) => {
    if (signal?.aborted) return;
    host.requestRealtimeTextUtterance({
      session,
      text,
      userId: host.client.user?.id || null,
      source: `${source}:stream_chunk_${index}`,
      interruptionPolicy,
      latencyContext: index === 0 ? replyLatencyContext : null,
    });
  },
  eagerFirstChunk: true,
});
```

#### Tool call handling (streaming)

The Anthropic streaming API sends typed content blocks:

```
content_block_start → { type: "text" }          ← stream via accumulator
content_block_delta → text deltas...
content_block_stop
content_block_start → { type: "tool_use" }       ← buffer silently
content_block_delta → JSON input deltas...
content_block_stop
message_stop → { stop_reason: "tool_use" }
```

Text blocks stream immediately. Tool use blocks are collected by the SDK
in `finalMessage`. After the stream completes:

1. Flush the sentence accumulator (speaks any remaining text)
2. Execute tool calls (web search, memory write, etc.)
3. Feed tool results back into a **new streaming generation**
4. That generation also streams text → TTS

The existing tool loop structure in `voiceReplies.ts` (lines 732-798)
stays the same — each iteration just uses `generateStreaming` instead of
`generate`.

#### Example flow: web search reply

```
User: "What year did the Nintendo DS come out?"

Stream generation 1:
  text: "Let me look that up."  → TTS immediately (user hears this ~600ms after TTFT)
  tool_use: web_search({ query: "Nintendo DS release year" })

Execute web_search tool (~800ms)

Stream generation 2 (with tool results):
  text: "The Nintendo DS was released in 2004 in North America."  → TTS
  text: "It was actually one of Nintendo's best-selling consoles."  → TTS

Total perceived latency: ~1.3s (vs ~3.5s today)
```

#### Fallback for non-streaming providers

If the LLM provider doesn't support streaming (xAI, codex, etc.), fall
back to the existing batch path. The pipeline should work identically in
both modes — streaming is a latency optimization, not a behavior change.

#### Barge-in during streaming

The existing barge-in system works naturally:
- Each `requestRealtimeTextUtterance` creates an audio response
- Barge-in cancels the current response
- The `generationSignal` (AbortSignal) propagates to the stream
- `MessageStream.abort()` kills the in-flight LLM request
- Remaining sentences are never emitted

This is actually **better** than today — currently barge-in can only cancel
after the full generation completes. With streaming, barge-in cancels the
LLM request mid-generation, saving tokens and API cost.

---

### Phase 4: Durable Session Context

**Goal:** The generation model sees 100 turns of conversation history, but
important context from earlier in the session should never be lost just
because old turns scroll off. The model emits "pinned" context notes
as it goes, creating a persistent knowledge layer above the rolling
conversation window.

This generalizes the existing `brainContextEntries` / `durableScreenNotes`
pattern from stream watch to all voice conversations.

#### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  System prompt                                                   │
│                                                                  │
│  📌 DURABLE SESSION CONTEXT (pinned, survives turn truncation)   │
│  - "James's favorite game is Smash Bros Melee"                   │
│  - "Group is planning a camping trip next weekend"               │
│  - "Alice just got a new job at Google"                          │
│                                                                  │
│  💬 CONVERSATION HISTORY (rolling window, last ~100 turns)       │
│  - [turn 1] ... [turn 2] ... [turn 100]                         │
│  - older turns silently drop off                                 │
│                                                                  │
│  🎤 CURRENT TURN                                                 │
│  - transcript + context                                          │
└─────────────────────────────────────────────────────────────────┘
```

#### New tool: `note_context`

```typescript
{
  name: "note_context",
  description: "Pin an important fact or context from this conversation that should be remembered for the rest of the session. Use when you notice something worth keeping even after older turns scroll out of the conversation window. Do not duplicate things already pinned.",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "The fact or context to pin." },
      category: {
        type: "string",
        enum: ["fact", "plan", "preference", "relationship"],
        description: "What kind of context this is."
      }
    },
    required: ["text"],
    additionalProperties: false
  }
}
```

#### Storage: `session.durableContext`

- Array of `{ text, category, at }` entries on the session object
- Rolling window of ~50 entries, deduped by text similarity (same
  pattern as `appendStreamWatchBrainContextEntry` which dedupes by
  exact lowercase match)
- Injected into the system prompt as a "Session context" section
- Dies with the session — this is ephemeral, not permanent memory

#### Token budget

- ~50 entries × ~100 chars = ~5K chars (~1.5K tokens)
- Negligible compared to 100 turns of conversation history

#### Why not just save to memory?

- `memory_write` is for **permanent** durable facts across sessions
- `note_context` is for **session-scoped** context: things that matter
  right now but may not be worth permanent storage
- No write pressure, no rate limits, no embedding cost
- The daily reflection pipeline handles permanent extraction later —
  it reads the full journal (which now includes bot replies) and decides
  what's truly worth keeping

#### Relationship to daily reflection

The daily journal files already capture the full conversation (user
turns + bot replies, after the journal ingest fix). Daily reflection
reads those journals and extracts permanent facts. `note_context` fills
a different role: keeping the model sharp **during** a long conversation,
not after.

---

### Phase 5: Text Reply Pipeline (Future)

Lower priority — text replies don't have the same latency sensitivity.
But the Phase 0 tools-only migration benefits text replies too:

- Cleaner code (one output mode, not JSON+tools hybrid)
- Model explicitly calls the tools it wants
- Removes the fragile `replyFollowup.ts` JSON-field-to-tool-call bridge
- Enables future streaming for text (typing indicator while generating)

---

## Rollout Strategy

1. **Phase 0** first — this is a refactor with no behavior change.
   Ship it, verify all voice and text reply features still work.

2. **Phase 1** next — add streaming to LLM layer behind a feature flag
   (`voice.streaming.enabled`, default false). No behavior change when off.

3. **Phase 2 + 3** together — sentence accumulator + pipeline wiring.
   Gate behind the same feature flag. A/B test latency in real sessions.

4. **Phase 4** after streaming is stable — durable session context layer.
   Independent of streaming but improves quality for long sessions.

5. **Phase 5** later — text pipeline migration, independent timeline.

## Settings

```typescript
// In voice conversation policy settings
streaming: {
  enabled: boolean;           // default: false (feature flag)
  eagerFirstChunkChars: number; // default: 60
  maxBufferChars: number;       // default: 300
}
```

## Metrics to Track

- `voice_reply_ttft_ms` — time from ASR commit to first audio delta
- `voice_reply_first_sentence_ms` — time from ASR commit to first TTS request
- `voice_reply_total_ms` — full reply latency (for comparison with batch)
- `voice_reply_stream_chunks` — number of sentence chunks per reply
- `voice_reply_stream_cancelled` — barge-in during streaming (tokens saved)

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Sentence boundaries mid-word cause choppy TTS | Accumulator waits for clean breaks; first chunk has minimum char threshold |
| Tool calls interleaved with text (rare) | Stream text blocks eagerly, buffer post-tool text and speak after tool execution |
| OAuth fetch wrapper breaks streaming | Already tested — `claudeOAuth.ts` wraps response body in streaming `ReadableStream` |
| Multiple utterances queue incorrectly | OpenAI realtime processes `conversation.item.create` sequentially; tested in existing codebase |
| Barge-in races with streaming | `generationSignal.abort()` propagates to `MessageStream.abort()` — clean cancellation |
