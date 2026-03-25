# Rolling Context Compaction

Status: proposed

References:
- [`docs/voice/voice-client-and-reply-orchestration.md`](../../voice/voice-client-and-reply-orchestration.md)
- [`docs/voice/voice-capture-and-asr-pipeline.md`](../../voice/voice-capture-and-asr-pipeline.md)
- `src/voice/voiceReplyPipeline.ts` — `buildContextMessages()`
- `src/voice/instructionManager.ts` — `buildRealtimeInstructions()`
- `src/voice/voiceStreamWatch.ts` — screen-watch note accumulation

## Problem

Voice conversations and screen-share sessions lose context over time. The system maintains a 220-turn transcript timeline, but only sends the last 50 turns to the LLM. When turn 51 falls off the window, it's gone — the bot has no idea what was discussed earlier. Screen-watch notes are capped at 8-12 entries with the same drop-oldest strategy.

In practice, a 30-minute voice session easily exceeds 50 turns. The bot forgets the first half of the conversation. If someone references something discussed 10 minutes ago, the bot has zero context for it. The warm memory system helps with factual recall (names, preferences), but it doesn't preserve *conversational* context — the flow of what was discussed, in what order, by whom.

This is the difference between "I remember James likes Marvel Rivals" (durable memory) and "Earlier you were talking about trying a new team comp and Bob said he keeps dying as Hulk" (conversation continuity).

## Current State

### What the LLM sees today

| Source | Window | Pruning | Summarization |
|---|---|---|---|
| Transcript timeline (`transcriptTurns`) | Last 50 turns, 1200 chars each | `slice(-50)`, oldest dropped | None |
| Decider history (`recentVoiceTurns`) | Last 8 turns, 220 chars each | `slice(-8)`, oldest dropped | None |
| Realtime instructions | 5,200 char hard ceiling | Truncation | None |
| Screen-watch notes | Last 8-12 entries, 220 chars each | `slice(-N)`, oldest dropped | One-shot recap at session end only |
| Durable memory (warm cache) | Embedding-retrieved facts | Topic-drift invalidation | None (facts are already atomic) |

Everything is hard-truncated. No gradual degradation from "full fidelity" to "summary" to "forgotten." Turns either exist in full or are gone entirely.

### The gap

```
Turn 1-100:   [completely forgotten — no context at all]
Turn 101-150: [fully present as context messages, verbatim transcripts]
Turn 151:     [current turn being processed]
```

If someone at turn 151 says "go back to what we were talking about at the start," the bot has nothing before turn 101. In a long gaming session, that's the entire first hour gone.

## Design: Two-Layer Context Window

The LLM sees two layers of conversational context, with screen-share notes flowing through the same lifecycle as spoken turns:

| Context type | Fresh / live | Aging out | Older history |
|---|---|---|---|
| Spoken turns | Verbatim recent window | Wait until fully outside recent window | Fold into compacted summary |
| Screen-share notes | Live note buffer | Queue evicted entries in `pendingCompactionNotes` | Fold into compacted summary |

In practice this behaves like a three-stage lifecycle for both modalities: live now -> about to fall out -> compacted continuity.

The LLM sees two layers in the prompt:

```
┌─────────────────────────────────────────────────┐
│  Layer 1: Recent turns (full fidelity)          │
│  Last 50 turns, verbatim transcripts            │
│  Exact speaker attribution, timestamps          │
│  "Alice: let's try the new team comp"           │
│  "Bob: I keep dying as Hulk"                    │
│  "Alice: maybe try Jeff the land shark"         │
├─────────────────────────────────────────────────┤
│  Layer 2: Compacted history (rolling summary)   │
│  Everything before the recent window            │
│  Periodically re-summarized as turns accumulate │
│  "Earlier: Alice and Bob discussed Marvel       │
│   Rivals strategy. Bob struggled with Hulk.     │
│   James asked Clanky about weather. The group   │
│   debated team comps for ranked matches."        │
└─────────────────────────────────────────────────┘
```

### Key properties

- **Recent turns are never summarized.** The last 50 turns remain verbatim. This covers most sessions entirely — compaction is a long-session feature.
- **The summary grows and re-compacts.** As new turns push older ones past the recent window, they're folded into the running summary. The summary itself is periodically re-condensed to stay within budget.
- **Speaker attribution is preserved in summaries.** "Bob talked about dying as Hulk" not "someone discussed gameplay difficulties."
- **Screen-watch notes fold into the same summary.** Visual context from earlier in the session ("James was playing as Winter Soldier on the Tokyo map") becomes part of the running summary rather than being dropped entirely.

## Architecture

### Session state

```typescript
interface VoiceSession {
  // ... existing fields ...

  /** Rolling summary of conversation history beyond the recent window.
   *  Re-compacted periodically as new turns are folded in. */
  compactedContextSummary?: string | null;

  /** Timestamp of the last compaction run. */
  compactedContextLastAt?: number;

  /** Highest transcript turn index included in the latest successful
   *  compaction output. Useful for debugging stale summaries. */
  compactedContextCoveredThroughTurn?: number;

  /** The turn index (into transcriptTurns) up to which the summary covers.
   *  Everything at or after this index is "recent" and shown verbatim.
   *  This is the boundary marker — not a count of total compacted turns. */
  compactedContextCursor?: number;

  /** True while a compaction call is in flight. Prevents concurrent runs. */
  compactedContextInFlight?: boolean;

  /** Screen-watch notes evicted from the live buffer and waiting to be
   *  folded into the next compaction batch. */
  pendingCompactionNotes?: string[];
}
```

### Constants

```typescript
/** Number of recent turns to keep at full fidelity. The LLM sees these
 *  verbatim as context messages. 50 turns covers most short/medium sessions
 *  entirely — compaction is a long-session feature for 90+ minute calls. */
const CONTEXT_COMPACTION_RECENT_WINDOW = 50;

/** Number of new turns that must accumulate beyond the recent window
 *  before triggering a compaction run. Prevents summarizing on every turn. */
const CONTEXT_COMPACTION_BATCH_SIZE = 10;

/** Max chars for the compacted summary. Controls the budget the summary
 *  competes for in the prompt. */
const CONTEXT_COMPACTION_MAX_SUMMARY_CHARS = 1200;

/** Max chars for screen-watch notes folded into the summary. */
const CONTEXT_COMPACTION_MAX_NOTE_CHARS = 400;
```

### Trigger mechanism

Compaction is generation-driven: it is evaluated when we are already about to build model context in `buildContextMessages()`. That means the feature only spends work on sessions where the bot is actively participating, which is the right default for Clanky. We are not trying to summarize every transcript mutation in real time; we are trying to preserve enough continuity for the next model call.

Compaction runs when:

1. `transcriptTurns.length - (compactedContextCursor || 0) > CONTEXT_COMPACTION_RECENT_WINDOW + CONTEXT_COMPACTION_BATCH_SIZE`
2. AND `compactedContextInFlight !== true`

This means compaction first fires once there are more than 60 turns since the cursor (50 recent + 10 batched older turns), then again whenever another 10 old-enough turns accumulate. Most sessions never hit this — it's a long-session feature.

### Exact batch selection

At trigger time:

```typescript
const cursor = session.compactedContextCursor ?? 0;
const totalTurns = transcriptTurns.length;
const recentStart = Math.max(cursor, totalTurns - CONTEXT_COMPACTION_RECENT_WINDOW);
const turnsEligibleToCompact = recentStart - cursor;

if (turnsEligibleToCompact >= CONTEXT_COMPACTION_BATCH_SIZE) {
  const batchEnd = cursor + CONTEXT_COMPACTION_BATCH_SIZE;
  const turnsToCompact = transcriptTurns.slice(cursor, batchEnd);
}
```

The invariant is simple: everything before `cursor` is already compacted, everything from `cursor` onward remains verbatim. A compaction run only folds the oldest turns that have fully fallen outside the recent window. It never summarizes anything still inside the protected recent window.

This keeps the progression predictable:

- At `cursor=0`, `totalTurns=61`, `recentStart=11`, compact turns `0..9`, then advance `cursor` to `10`
- At `cursor=10`, compaction waits until `totalTurns=71`, `recentStart=21`, compact turns `10..19`, then advance `cursor` to `20`
- During an in-flight run, the recent window can temporarily grow beyond 50 turns; once the run lands, the boundary snaps forward again

### Where it runs

Compaction is triggered from `buildContextMessages()` in `voiceReplyPipeline.ts` — the same place that currently slices the transcript timeline. Before building the context array, check whether compaction is needed. If so, fire it async (non-blocking — the current turn uses whatever summary exists; the next turn benefits from the updated one).

For realtime mode, `buildRealtimeInstructions()` in `instructionManager.ts` injects the compacted summary as a section alongside (or replacing) "Recent conversation continuity."

If we later find other model-entry points that need the same continuity, they should call the same helper rather than re-implementing trigger math. The trigger should live in one place even if multiple prompt-builders consume the result.

### Async boundary and cursor semantics

Compaction runs in parallel with the conversation. The cursor-based design handles this naturally:

```
Timeline at compaction start (turn count = 61):
  [0..9]   → batch to compact (oldest turns outside recent window)
  [10..60] → verbatim window (51 turns until compaction completes)
  cursor=0, compaction target becomes 10

Compaction takes 3 seconds. During that time, 3 more turns arrive:
  [0..9]     → being compacted right now
  [10..63]   → verbatim window is temporarily oversized

Compaction finishes, cursor advances to 10:
  [0..9]     → folded into summary
  [10..63]   → verbatim window (54 turns, still elastic)

Next compaction does not fire again until there are at least 10 turns outside
the recent window relative to `cursor=10`:
  at total turn count 71, compact [10..19]
  cursor advances to 20
```

The recent window is elastic — it stretches while compaction is in flight and contracts when the next batch is folded. This is the right behavior: the bot never loses context during a compaction run. The window is "at least 50 turns" rather than "exactly 50 turns."

**What the LLM sees at any given moment:**

```
[compacted summary: everything before cursor]
[verbatim turns: cursor through current]
[current turn]
```

If no compaction has ever run (`cursor=0`, no summary), the LLM sees just the last 50 verbatim turns — identical to today's behavior. The summary only appears once the first compaction completes.

### Compaction prompt

The summarizer call is cheap and fast — a small model (the configured default text model) with a tight output budget:

```
Summarize the following voice conversation context into a concise running summary
for an autonomous Discord participant re-entering the ongoing session.

Preserve, in priority order:
1. Who said what, with speaker names when material
2. The current shared activity or scene (game, task, topic, stream context)
3. Open questions, requests, and unresolved threads the bot may want to pick back up
4. Decisions, commitments, plans, and preferences that still matter in-session
5. Important screen-watch context tied to the people involved

Do not preserve filler chatter, greetings, laughter, backchannels, repeated
rephrasings, or small talk that does not change the conversational state.

Previous summary (incorporate and condense):
{existingCompactedSummary || "None — first compaction."}

New turns to fold in:
{batchOfTurnsBeingFolded}

Screen-watch notes from this period (if any):
{droppedScreenWatchNotes}

Output:
- A single compact paragraph in plain prose
- Max {CONTEXT_COMPACTION_MAX_SUMMARY_CHARS} characters
- Keep the newest still-relevant details if forced to compress
- Do not invent facts or motivations
```

Internally, it is still useful to think of the summary as carrying five conceptual slots even if the serialized output is one paragraph: active people, current activity, unresolved threads, decisions/commitments, and important older background. That mental model should guide prompt tuning and evaluation.

### How the summary is consumed

#### Brain generation path (`buildContextMessages`)

```
System prompt
  [compacted summary injected as first message or system context section]
  "Earlier in this session: {compactedContextSummary}"
Context messages (cursor through current, verbatim — at least 50 turns)
Current user turn
```

In long sessions, the summary provides continuity for everything before the 50-turn window. The LLM sees the full recent conversation plus a condensed history of everything earlier.

#### Realtime instructions path (`buildRealtimeInstructions`)

Injected as a section between participant memory and conversation continuity:

```
Session conversation summary:
{compactedContextSummary}
```

This competes for space within the 5,200 char budget. At ~1,200 chars max, it's a meaningful but bounded addition.

### Prompt budget priority

When prompt budget gets tight, keep information in this order:

1. Current turn
2. Most recent verbatim turns
3. Participant memory / durable facts
4. Compacted session summary
5. Older or lower-signal realtime continuity sections

The compacted summary should never crowd out the freshest verbatim conversation. It exists to restore long-range continuity, not to replace the immediate moment.

### Screen-watch note integration

When screen-watch notes are about to be dropped (the buffer is full and oldest entries are being evicted), those evicted notes are included in the next compaction batch. This way visual context like "James was spectating a match on the Tokyo map" persists as part of the running summary rather than disappearing entirely.

Implementation: `appendStreamWatchBrainContextEntry` currently does `slice(-maxEntries)`. Before slicing, collect the entries that will be evicted and stash them in `session.pendingCompactionNotes`. The next compaction run includes them, then clears the queue on success.

Where possible, preserve note provenance in the serialized text that gets queued: who was sharing, what was on screen, and why it mattered. "James was screen-sharing Marvel Rivals on Tokyo as Winter Soldier" is much better than "Tokyo map visible."

## Edge Cases

### Short and medium sessions
Sessions under ~60 turns never trigger compaction. No overhead, no change from current behavior. This covers the vast majority of sessions.

### Very long sessions (hours)
The summary itself would grow unbounded without re-compaction. Each compaction run includes the existing summary in the prompt and asks the model to "incorporate and condense." This naturally compresses older context — details from 2 hours ago get condensed more aggressively than details from 20 minutes ago, because the model prioritizes recency when forced to compress.

If the summary exceeds `CONTEXT_COMPACTION_MAX_SUMMARY_CHARS`, do not blindly truncate the string. Prefer this order instead:

1. Set a hard model output cap that is already below the character budget
2. If violated anyway, run one re-compaction pass using the overlong output as `Previous summary`
3. Only as a last-resort safety clamp, trim to the nearest sentence boundary

### Compaction fails (model error, timeout)
Non-fatal. The session continues with whatever summary existed before. The cursor doesn't advance and `compactedContextInFlight` is cleared, so the next trigger check retries. Log `voice_context_compaction_failed` with error details.

### Multiple speakers, rapid-fire turns
Room-aware coalescing (the feature we just built) means the bot already processes group moments as single merged turns. The compaction summarizer sees "Alice said X, Bob said Y" as one entry rather than fragmented individual sentences.

### Race with ongoing generation
Compaction runs async. If a generation call is in flight when compaction completes, the generation uses the old summary. The next generation gets the updated one. This is fine — the compacted summary is supplementary context, not critical for the current turn's coherence (the recent window handles that).

## What This Does Not Solve

- **Cross-session continuity.** This is within-session only. Cross-session context is handled by durable memory (facts, lore, conversation windows). The compacted summary is ephemeral — it lives in session state and dies when the session ends.
- **Perfect recall.** The summary is lossy by design. If someone asks "what exactly did Bob say 45 minutes ago word for word," the bot won't have it. It'll have "Bob discussed team comps and complained about dying as Hulk." That's the tradeoff.
- **Token budget optimization.** This doesn't reduce total tokens sent to the model — it adds a summary on top of the existing 50-turn context window. The goal is broader temporal context for long sessions, not cost reduction.

## Observability

This feature will be hard to tune without strong logs. In addition to start/completion/failure, log why a check did not run:

- `voice_context_compaction_skipped` with reason such as `below_threshold`, `already_in_flight`, `no_eligible_batch`, or `session_ending`
- `voice_context_compaction_started` with `cursor`, `batch_size`, `recent_start`, `pending_note_count`
- `voice_context_compaction_completed` with old/new cursor, covered-through turn, summary char count, and latency
- `voice_context_compaction_failed` with model, timeout/error class, and retryable status

These logs should make it obvious, from a single session trace, what the model could see and why.

## Implementation Order

1. Add `compactedContextSummary` / `compactedContextCursor` / `compactedContextInFlight` / `compactedContextCoveredThroughTurn` / `pendingCompactionNotes` to session state
2. Build a shared helper that computes `recentStart`, eligible batch range, and skip reasons
3. Build the compaction prompt and summarizer call (reuse existing LLM infra)
4. Wire trigger into `buildContextMessages` — check threshold, fire async
5. Inject summary into brain generation context (first context message or system section)
6. Inject summary into realtime instructions (new section)
7. Wire screen-watch note eviction into pending compaction notes
8. Add observability logs for started/completed/failed/skipped paths
9. Tune constants and summary quality against real long-session transcripts
