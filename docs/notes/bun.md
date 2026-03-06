# Bun Compatibility Notes

Running clanker conk on Bun (v1.3.10) instead of Node.js.  This doc tracks
the bugs we hit, the root causes, and the workarounds we shipped.

---

## 1. `stream.pipeline()` is broken — Premature Close on fresh PassThrough

### Symptom
`createAudioResource(stream, { inputType: StreamType.Raw })` immediately throws
`ERR_STREAM_PREMATURE_CLOSE` and kills the process (no error listener on the
AudioPlayer).  Every audio chunk retries and fails in the same way.

### Root cause (Bun internals)
Bun's `stream.pipeline()` delegates to `end-of-stream.ts` which calls
`isClosed(stream)`.  On a brand-new PassThrough, Bun's `isClosed()` returns
`true` because `stream.closed` (or `_readableState.closed` /
`_writableState.closed`) reports `true` immediately after construction — a
state that should only be set after the `'close'` event fires.

When `isClosed()` returns `true`, `end-of-stream` does
`process.nextTick(onclose)` which raises `ERR_STREAM_PREMATURE_CLOSE` because
the readable/writable sides haven't finished yet.

### Bun-level fix (not applied — we bypass instead)
Two patch options if contributing upstream:

**Option A — Harden `isClosed()` in Bun source (src/js/internal/streams/utils.ts in the Bun repo):**
Refuse to believe `closed === true` when `destroyed`, `readableEnded`,
`writableEnded`, and `writableFinished` are all still false.

**Option B — Guard the fast-path in `end-of-stream.ts`:**
Only `nextTick(onclose)` when closure is corroborated by destroyed/ended state.

### Repro
```js
import { PassThrough, pipeline } from "node:stream";
const pt = new PassThrough();
console.log("initial:", {
  closed: pt.closed,
  destroyed: pt.destroyed,
  readableEnded: pt.readableEnded,
  writableEnded: pt.writableEnded,
});
pipeline(pt, new PassThrough(), (err) => {
  console.log("pipeline cb:", err?.code, err?.message);
});
```
Node: no error.  Bun 1.3.10: `ERR_STREAM_PREMATURE_CLOSE`.

### Our workaround — OpusPcmBridge
Instead of feeding a PassThrough to `createAudioResource` with `StreamType.Raw`
(which triggers pipeline internally), we:

1. Created `OpusPcmBridge` (in `voiceSessionHelpers.ts`) — a custom
   EventEmitter that accepts PCM `.write()` calls, encodes each 20ms frame to
   Opus via `opusscript`, and pushes packets into `OpusPacketReadable` (our
   custom Readable replacement — see bug #5 below).
2. Pass `bridge.readable` to `createAudioResource` with `StreamType.Opus`.
3. Discord.js sees a single stream with `StreamType.Opus` → `findPipeline()`
   returns an empty transforms array → `playStream = streams[0]` (no
   `pipeline()` call).

Key detail from Discord.js source (`@discordjs/voice/dist/index.mjs:2885`):
```js
this.playStream = streams.length > 1 ? pipeline(streams, noop) : streams[0];
```
With `StreamType.Opus` and one stream, it takes the `streams[0]` path,
completely bypassing Bun's broken `pipeline()`.

---

## 2. AudioPlayer destroys playStream on `play()` — mid-response audio gaps

### Symptom
Bot speaks the first word and last word of a response but the middle is silent.
Logs show a single clean `bot_audio_stream_lifecycle event=close` at the end
(no repeated close/reopen).

### Root cause
Discord.js AudioPlayer enters `AutoPaused` when the Readable buffer is
temporarily empty (normal during bursty OpenAI streaming).  Our
`ensureBotAudioPlaybackReady` was treating `AutoPaused` the same as `Idle` —
creating a new `AudioResource` from the same `bridge.readable` and calling
`audioPlayer.play(newResource)`.

Inside `play()`, Discord.js transitions through Idle, and the transition
handler runs:
```js
oldState.resource.playStream.on('error', noop);
oldState.resource.playStream.destroy();   // <-- destroys our playStream!
```
Since both the old and new AudioResource reference the **same** playStream,
this destroys the stream the new resource is about to read from.  All buffered
Opus packets are lost.  The OpusPcmBridge detects the close event, marks
itself `destroyed = true`, and subsequent writes create a brand-new bridge —
so only the tail-end audio plays from the fresh stream.

### Fix
Removed `AudioPlayerStatus.AutoPaused` from the restart condition in
`ensureBotAudioPlaybackReady`.  AutoPaused already auto-resumes: the
AudioPlayer's 20ms polling loop keeps calling `read()` and transitions back to
`Playing` as soon as data is available.

```ts
// Before (broken):
if (status === AudioPlayerStatus.Idle || status === AudioPlayerStatus.AutoPaused) {

// After (fixed):
if (status === AudioPlayerStatus.Idle) {
```

---

## 3. `maxMissedFrames` default is far too low — destroys stream on brief gaps

### Symptom
Same as #2 — mid-response audio skipping.  Even after fixing the AutoPaused
restart, audio still cuts out in the middle of responses.

### Root cause
Discord.js AudioPlayer's `_stepPrepare()` method reads one Opus packet every
~20ms.  When `read()` returns null (no data available), it increments
`missedFrames`.  When `missedFrames >= maxMissedFrames`, it calls `stop()`
which transitions to Idle and **destroys the playStream** (same destruction
path as bug #2).

The default `maxMissedFrames` is **5** — meaning just **100ms** of no audio
data triggers a full stream teardown.  With OpenAI's bursty audio delivery
over WebSocket, 100ms gaps are routine.

```js
// Discord.js _stepPrepare():
if (packet) {
  this._preparePacket(packet, playable, state);
  state.missedFrames = 0;
} else {
  this._preparePacket(SILENCE_FRAME, playable, state);
  state.missedFrames++;
  if (state.missedFrames >= this.behaviors.maxMissedFrames) {
    this.stop();   // destroys playStream!
  }
}
```

### Fix
Set `maxMissedFrames: 250` (5 seconds) when creating the AudioPlayer in
`voiceJoinFlow.ts`:

```ts
audioPlayer = createAudioPlayer({
  behaviors: { maxMissedFrames: 250 }
});
```

---

## 4. `setTimeout` negative delay — breaks AudioPlayer timing loop

### Symptom
`TimeoutNegativeWarning` from `@discordjs/voice` audio cycle.  Audio playback
breaks entirely because the 20ms dispatch loop receives negative timeout values.

### Root cause
Bun's timer loop drifts so `nextTime - Date.now()` can go negative inside
Discord.js voice's audio cycle
(see https://github.com/oven-sh/bun/issues/11313).

### Fix
Global `setTimeout` polyfill at the top of `src/app.ts` that clamps all delays
to `>= 0`:
```ts
const origSetTimeout = globalThis.setTimeout.bind(globalThis);
globalThis.setTimeout = ((handler, timeout = 0, ...args) =>
  origSetTimeout(handler, Math.max(0, timeout), ...args)
) as typeof setTimeout;
```
Must run **before** any `@discordjs/voice` imports.

---

## 5. Bun's `Readable` in object-mode — `read()` returns null with data buffered

### Symptom
Even with high `highWaterMark` and plenty of Opus packets pushed, the
AudioPlayer's `playStream.read()` intermittently returns `null`, causing
silence frames and triggering the `maxMissedFrames` stop path (bug #3).

### Root cause
Bun's `Readable` implementation in object-mode has bugs where `read()` can
return `null` when the internal buffer has data, and the `readable` property
may not accurately reflect buffer state.  This is a known class of issues in
Bun's Node.js stream compatibility layer.

### Fix — OpusPacketReadable
Replaced Bun's `Readable` with a minimal custom implementation that only
implements the interface Discord.js AudioPlayer actually uses:

```ts
class OpusPacketReadable extends EventEmitter {
  _queue: Buffer[] = [];
  readable = true;
  readableEnded = false;
  readableObjectMode = true;
  destroyed = false;

  get queuedPackets() {
    return this._queue.length;
  }

  read() {
    if (this.destroyed) return null;
    return this._queue.shift() ?? null;
  }

  push(packet: Buffer | null) {
    if (this.destroyed) return;
    if (packet === null) {
      this.readableEnded = true;
      this.readable = false;
      this.emit("end");
      return;
    }
    const wasEmpty = this._queue.length === 0;
    this._queue.push(packet);
    if (wasEmpty) this.emit("readable");
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.readable = false;
    this._queue.length = 0;
    this.emit("close");
  }
}
```

This is a plain array-backed queue with EventEmitter — zero dependency on
Bun's stream internals.  `read()` is a simple `shift()`, guaranteed to
return data when data exists.

---

## 6. Unhandled AudioPlayer error — process crash

### Symptom
Process exits immediately on first audio chunk with an unhandled error event.

### Root cause
`audioPlayer.emit("error", ...)` with no `'error'` listener.  Node.js
EventEmitter treats unhandled `'error'` as a fatal exception.

### Fix
Added `audioPlayer.on("error", ...)` handler in `bindAudioPlayerHandlers`
(`voiceSessionManager.ts`).

---

## 7. AudioPlayer starts with empty queue — silence frames at response start

### Symptom
Audio plays smoothly in bursts, but has periodic "snags" / brief silence gaps
mid-response.  The beginning of a response can also have a noticeable delay
before audio begins.

### Root cause
`enqueueDiscordPcmForPlayback` was calling `ensureBotAudioPlaybackReady()`
(which calls `audioPlayer.play()`) **before** writing PCM to the bridge.
When `play()` fires, Discord.js transitions the player to Playing and starts
its 20 ms read-loop.  The first `read()` happens on the next tick — but the
Opus queue is still empty because the PCM write hasn't executed yet (it runs
synchronously after the activation call).

In practice, JavaScript's single-threaded event loop ensures the write runs
before the first `setTimeout`-scheduled read.  The **real** problem is that
on the first audio delta there are only ~5 packets in the queue — a 100 ms
runway.  Any brief gap in OpenAI delivery (>100 ms between deltas) drains
the queue completely, and the player sends silence frames (`SILENCE_FRAME`)
until more packets arrive, producing an audible "snag".

### Fix — write-before-activate with pre-buffer threshold
Changed `enqueueDiscordPcmForPlayback` to a three-step flow:

1. **Ensure stream exists** — call `ensureBotAudioPlaybackReady({ activatePlayback: false })`.
2. **Write PCM** — synchronously encodes to Opus and fills the queue.
3. **Activate player** — call `ensureBotAudioPlaybackReady({ activatePlayback: true, minQueueDepth: 5 })`.

The player is only started once the Opus queue has ≥ 5 packets (100 ms
head-start).  A single OpenAI audio delta typically produces ~5 frames, so
activation usually happens on the first delta.  A 300 ms fallback timer
handles the degenerate case of a very short response that doesn't reach the
threshold.

```ts
// voiceSessionManager.constants.ts
export const AUDIO_PLAYBACK_PRE_BUFFER_PACKETS = 5;
export const AUDIO_PLAYBACK_PRE_BUFFER_FALLBACK_MS = 300;
```

**Critical detail — `resource.started` and the `readable` event:**
Discord.js `createAudioResource` attaches `stream.once("readable", () =>
this.started = true)` during construction.  `AudioPlayer.play()` then checks
`resource.started` to decide whether to skip Buffering.  Because our queue
is already filled when `createAudioResource` is constructed, the `readable`
event was emitted (during `push()`) *before* the listener was attached —
so `started` stays `false` and `play()` enters Buffering.  Buffering
attaches its own `once("readable")` listener, but the event won't fire
again (our stream only emits `readable` on empty→non-empty transitions).
Player stuck forever.

Fix: synchronously re-emit `readable` right after `play()`:
```ts
session.audioPlayer.play(resource);
if (queueDepth > 0 && !stream.destroyed) {
  stream.emit("readable");  // nudges both started flag and Buffering→Playing
}
```
Using synchronous emit (not `queueMicrotask`) avoids Bun event-loop timing
issues that caused garbled audio with deferred emission.

---

## 8. Audio cycle timing drift — mid-response audio skip

### Symptom
User hears beginning and end of a bot response but the middle is
skipped/garbled.  Pipeline stats are perfect: `pushed=330 read=330
underruns=250 peak=310 remaining=0`.  Zero mid-response underruns (all 250
are post-response `maxMissedFrames` timeout).

### Root cause
Two compounding issues:

**1. Bun WebSocket batching:** Bun delivers all buffered WebSocket messages
in a single synchronous event loop tick.  For a ~6 second audio response
this means ~300 `audio_delta` messages arrive at once.

**2. Synchronous processing blocks the event loop:** Each delta requires
base64 decode → resample (24kHz mono → 48kHz stereo) → Opus encode.
Processing all 300 synchronously blocks the event loop for 3+ seconds.

Discord.js's global audio cycle is a chained `setTimeout` (20ms interval).
While the event loop is blocked, it can't fire.  When it unblocks, rapid
catch-up cycles dispatch all queued packets in a few ms burst.  Discord's
jitter buffer drops or garbles the burst.

### Confirmed diagnosis (AUDIO_DEBUG=1)
```
readTiming={min=1 max=3143 avg=17.7 bursts=303 stalls=2}
pushTiming={bursts=298 gapMax=3144}
```
303/306 reads were burst reads (< 5ms apart).  3.1 second event loop
block.  298/306 pushes arrived < 2ms apart.

### Failed fix — `await setTimeout(0)` in async loop
First attempt: split processing into an async drain loop yielding every 3
chunks via `await new Promise(r => setTimeout(r, 0))`.

**Result: WORSE** — `max=6185` (6.2s stall), player starved and stopped.

**Why it failed:** `await setTimeout(0)` resolves as a microtask
continuation.  Microtasks drain completely before the event loop returns to
the timer phase.  The async loop effectively runs synchronously — the
"yield" never actually lets other timers fire.  This is spec-level
microtask starvation (see nodejs/promise-use-cases#25), not Bun-specific.

### Fix — callback-based chunking with setTimeout(fn, 1)
Replace the async drain with a pure callback pattern:

```ts
const drainAudioDeltaBatch = () => {
  let processed = 0;
  while (audioDeltaQueue.length > 0) {
    processOneAudioDelta(audioDeltaQueue.shift()!);
    processed++;
    if (processed >= AUDIO_DELTA_DRAIN_YIELD_INTERVAL) {
      setTimeout(drainAudioDeltaBatch, 1);  // real macrotask yield
      return;
    }
  }
  audioDeltaDraining = false;
};
```

Each batch continuation is a true macrotask (setTimeout callback), NOT a
microtask.  The event loop completes a full iteration between batches,
allowing the audio cycle's 20ms timer to fire and dispatch packets at a
steady pace.

**Why 1ms not 0ms:** Bun enforces a 1ms minimum for setTimeout anyway.
Using 1 explicitly avoids any ambiguity about same-tick coalescing.

**Latency cost:** ~1ms per yield × (totalChunks / 3) yields.  For a 300-
chunk response: ~100ms total overhead spread across 6+ seconds of audio.
Negligible vs the 3+ second block it replaces.

### Diagnostics (kept behind AUDIO_DEBUG=1)
**OpusPacketReadable timing** (logged on destroy):
- `readTiming.min / max / avg` — interval between consecutive `read()` calls
  (healthy: ~20ms).
- `readTiming.bursts` — reads < 5ms apart (indicates catch-up cycles).
- `readTiming.stalls` — reads > 50ms apart (indicates event loop blocking).
- `pushTiming.bursts` — pushes < 2ms apart (indicates WebSocket batching).
- `pushTiming.gapMax` — largest gap between pushes.

### Related
- [Bun #26415](https://github.com/oven-sh/bun/issues/26415) — Discord voice
  streaming 8-13× higher CPU on Bun vs Node.js
- [Bun #8972](https://github.com/oven-sh/bun/issues/8972) — event loop task
  ordering differs from Node.js (confirmed bug, open)
- [nodejs/promise-use-cases#25](https://github.com/nodejs/promise-use-cases/issues/25)
  — microtask starvation with async/await + setTimeout(0)

---

## Summary of changes

| File | What |
|---|---|
| `src/app.ts` | setTimeout polyfill (must be first) |
| `src/voice/voiceSessionHelpers.ts` | `OpusPacketReadable` (custom stream), `OpusPcmBridge` class, `createBotAudioPlaybackStream()`, `ensureBotAudioPlaybackReady()` uses `StreamType.Opus`, only restarts from Idle, supports `minQueueDepth` |
| `src/voice/voiceSessionManager.ts` | AudioPlayer error handler in `bindAudioPlayerHandlers`; write-before-activate + pre-buffer in `enqueueDiscordPcmForPlayback`; callback-based audio delta drain with macrotask yields in `bindRealtimeHandlers`; 1ms yield in STT TTS chunked playback |
| `src/voice/voiceSessionManager.constants.ts` | `AUDIO_PLAYBACK_PRE_BUFFER_PACKETS`, `AUDIO_PLAYBACK_PRE_BUFFER_FALLBACK_MS`, `AUDIO_DELTA_DRAIN_YIELD_INTERVAL` |
| `src/voice/voiceSessionManager.lifecycle.test.ts` | Updated test for pre-buffer behavior |
| `src/voice/voiceJoinFlow.ts` | `maxMissedFrames: 250`, pre-warm per-user ASR WebSocket at session start |

## OpusPcmBridge design

```
PCM write (3840 bytes = 20ms frame)
  │
  ▼
_drainFrames() ── opusscript.encode(frame, 960) ──▶ OpusPacketReadable._queue
                                                          │
                                                          ▼
                                              AudioPlayer calls read() ~20ms
                                              → queue.shift() → Opus packet
                                              (StreamType.Opus, no pipeline)
```

- **Encoder:** `opusscript` (pure JS/WASM, works in Bun) — 48kHz stereo,
  64kbps, FEC enabled.
- **Frame size:** 960 samples × 2 channels × 2 bytes = 3840 bytes PCM per
  20ms Opus frame.
- **OpusPacketReadable:** plain array queue with EventEmitter, bypasses Bun's
  buggy Readable entirely.  `read()` = `queue.shift()`.
- **writableLength:** returns only PCM remainder (`_pcmBuffer.length`), NOT
  Opus queue size.  The overflow guard in `enqueueDiscordPcmForPlayback` is
  calibrated for write-side backpressure; including the Opus queue would
  constantly trigger stream destruction.
- **Lifecycle:** OpusPacketReadable `close` propagates to bridge `destroyed`
  flag.  `destroy()` deletes the opusscript encoder to free WASM memory.
