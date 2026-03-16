# Voice Session Log Dive — 2026-03-16

**Session:** `daa86a88-903f-4b6f-9b26-3b0007e00c19`
**Time:** 05:30 – 05:40 UTC (9 minutes 23 seconds)
**Mode:** `elevenlabs_realtime` (brain path with ElevenLabs TTS, Claude via `claude-oauth`)
**Participants:** 2 humans initially (`titty conk`, `CURSED conk`), later joined by `the lethal shooter`, plus clanky
**Turns (non-skip):** 13 spoken replies, 30 `[SKIP]` decisions
**Screen watch:** 1,037 native Discord Go Live frames ingested (~1.84 fps effective)
**Context compaction:** 2 successful rounds (cursor `0 -> 10 -> 20`)
**LLM calls:** 43 (`claude-sonnet-4-0`: 15, `claude-sonnet-4-5`: 14, `claude-sonnet-4-6`: 14)
**Cost:** $0.00 (OAuth-backed Claude)

## Conversation Timeline

Annotations: `[SKIP]` = clanky chose silence, `(soundboard)` = assistant-triggered soundboard play.

```
05:30:47 [event]: clanky joined VC while a Go Live stream was already active
05:30:59 [clanky]: Yooo what's good, what are we watching?
05:30:58 [tool]: start_screen_watch -> ok=true, started=true
05:31:26 [clanky] -> [SKIP]  (screen-share warmup turn)
05:31:37 [clanky] -> [SKIP]  (direct-frame turn)
05:31:39 [titty conk]: Are you ready?
05:31:50 [clanky]: Always ready for whatever chaos y'all are about to unleash
05:32:10 [clanky]: Yo Plantera just woke up, good luck with that
05:32:53 [clanky]: Oh snap, Plantera's actually moving in! Those tentacle hands
         are no joke, better keep your distance
05:33:17 [clanky]: Yeah I can see it crystal clear - Plantera's at about half
         health and those tentacles are going absolutely feral right now
05:33:41 [event]: first `input_audio_buffer_commit_empty` ASR error
05:33:56 [CURSED conk]: Planker, Planker, please, we need you to rub it in.
05:34:13 [clanky]: Oh you want me to rub salt in the wound? ...
05:34:15 [event]: assistant soundboard played (second soundboard use this session)
05:34:54 [clanky]: Bruh you're standing in your base with all that loot and
         don't know what to do? You literally just beat Plantera...
05:35:35 [clanky]: Just vibing, watching Joey sort through all that post-
         Plantera loot - man's got his whole base laid out like a museum exhibit
05:35:56 [clanky]: Yeah for sure, what do you need help with? You trying to
         take on Golem or something else?
05:38:04 [event]: `the lethal shooter` joined the room
05:38:17 [clanky]: Yo, lethal shooter, what's good!
05:38:32 [clanky]: Yo Lethal, what's good! Welcome back.
05:39:05 [error]: ASR connect timeout -> commit failed -> circuit breaker reconnect
05:39:10 [event]: ASR recovered and session continued
05:40:09 [event]: ASR WebSocket closed, session ending
```

---

## Issues Observed

1. **Generation latency remains the main bottleneck**
2. **ASR produced a noisy cluster of empty-buffer errors, plus one brief reconnect incident**
3. **Low-confidence gating dropped a lot of short human utterances**
4. **One notable screen-watch grounding drift after the Plantera fight**

---

## 1. Latency Breakdown

This session is still generation-bound. `generationToReplyRequestMs` dominates most turns, and screen-watch turns are the worst offenders.

| Metric | Range | Typical |
|--------|-------|---------|
| `generationToReplyRequestMs` | 4,980 - 25,861ms | ~7,000-9,500ms |
| Memory load (`totalLoadMs`) | 381 - 7,058ms | ~480ms median |
| ASR to generation start | 0 - 8,758ms | usually sub-1s, occasional multi-second spikes |
| Queue wait | 0 - 5,937ms | usually 0-1s |
| **Approx end-to-end** | **4,980 - 25,861ms** | **~9-10s median** |

Worst turn: **05:31:26** (`stream_watch_brain_turn:share_start`) at **25.9s** generation time right after screen watch came online.

### Key latency observations

- **Screen-watch startup is still expensive.** The first share-start commentary turn took 25.9s end-to-end and ended in `[SKIP]`, so the room paid the cost without audible value.
- **Steady-state voice turns are still slow.** Median end-to-end latency is about 9.5s, with median generation alone about 7.6s.
- **Memory spikes compound the pain.** The worst memory load was 7.1s at 05:31:17, with later spikes at 4.3s and 2.3s.
- **Late-session queueing shows backpressure.** 05:39:22 hit 8.8s ASR-to-generation plus 4.0s queue wait before a `[SKIP]` decision.

### Per-turn latency timeline

```
05:30:59 | src=bot_join_greeting               | total~6354ms  | gen2reply=6354ms
05:31:26 | src=stream_watch_brain_turn:share_start | total~25861ms | gen2reply=25861ms [SKIP]
05:31:37 | src=stream_watch_brain_turn:direct_frame | total~10398ms | gen2reply=10398ms [SKIP]
05:31:50 | src=realtime                        | total~11044ms | gen2reply=7559ms  asr2gen=2449ms queueWait=1036ms
05:32:10 | src=stream_watch_brain_turn:direct_frame | total~10309ms | gen2reply=10309ms
05:32:53 | src=realtime                        | total~13143ms | gen2reply=7283ms  asr2gen=4495ms queueWait=1365ms
05:33:17 | src=realtime                        | total~7887ms  | gen2reply=6076ms  asr2gen=1558ms
05:34:23 | src=realtime                        | total~7808ms  | gen2reply=6459ms  asr2gen=1255ms
05:34:54 | src=realtime                        | total~7599ms  | gen2reply=6664ms  asr2gen=935ms
05:35:35 | src=realtime                        | total~13113ms | gen2reply=8241ms  asr2gen=4198ms queueWait=674ms
05:35:56 | src=bot_turn_open_deferred_flush   | total~9997ms  | gen2reply=9997ms
05:38:17 | src=member_join_greeting           | total~11907ms | gen2reply=11907ms
05:38:32 | src=realtime                        | total~10515ms | gen2reply=9621ms
05:39:22 | src=realtime                        | total~20723ms | gen2reply=7976ms  asr2gen=8758ms queueWait=3989ms [SKIP]
05:40:03 | src=stream_watch_brain_turn:direct_frame | total~10504ms | gen2reply=10504ms [SKIP]
```

---

## 2. ASR Error Events

### Empty-buffer errors

17 `openai_realtime_asr_error_event` occurrences, all the same underlying failure:

```
Error committing input audio buffer: buffer too small.
Expected at least 100ms of audio, but buffer only has 0.00ms of audio.
code: input_audio_buffer_commit_empty
```

Related counts in the same session:

- `openai_realtime_asr_commit_empty`: 17
- `voice_realtime_transcription_empty`: 44
- `openai_realtime_asr_bridge_empty_dropped`: 46

### Brief reconnect incident

At **05:39:05** the session hit:

- `openai_realtime_asr_connect_failed` (10s timeout)
- `openai_realtime_asr_commit_failed` (socket not open)
- `openai_realtime_asr_circuit_breaker_reconnect`

The pipeline recovered by **05:39:10** and the session continued normally. This was a transient outage, not a full session collapse.

### Assessment

- The empty-buffer errors are still mostly noise from tiny/empty commits.
- The reconnect is more interesting than the empties, but recovery was fast and automatic.
- Operator experience is still too noisy here; the circuit breaker did its job, but the log volume makes real ASR incidents harder to spot.

---

## 3. Low-Confidence and Dropped Human Turns

16 turns were dropped by `voice_turn_dropped_asr_low_confidence`.

Representative dropped transcripts:

- `whatever Hi. It can shatter as well.`
- `I love`
- `We didn't get far.`
- `I am not sure.`
- `Yeah Can I get your name?`
- `The circle, but Hello meneer. Are`
- `Absolutely Hey, how are you?`

### Assessment

- Many of these are correctly disposable fragments.
- A few look like legitimate social turns that might deserve a reply if ambient eagerness is supposed to feel highly conversational.
- The system is erring on the side of silence under noisy, overlapping group speech.

This is not a correctness bug, but it is a product-shaping tradeoff: fewer bad replies, but also fewer playful pickups.

---

## 4. Screen Watch Performance and Grounding

### Transport health

- Native Discord Go Live screen watch came up cleanly from a pre-existing stream.
- `start_screen_watch` succeeded on the very first turn.
- 1,037 frames were ingested with no decode failures logged under this session.
- 16 screen-watch commentary requests were evaluated, but only **1** became spoken commentary; **13** ended as `[SKIP]` and the rest stayed silent through other paths.

### Commentary quality

Early commentary was strong:

- correctly identified **Plantera** waking up
- tracked **tentacle hands** and boss-health state
- understood the room was spectating a live Terraria fight

### Grounding drift

There is one notable factual wobble after the death sequence:

- **05:33:41**: clanky says `Plantera got you!`
- **05:34:54**: clanky says `You literally just beat Plantera`

That second line appears wrong given the immediately preceding death commentary. This looks like a screen/context grounding slip rather than an ASR issue.

---

## 5. Prompt Size and Memory

| Metric | Start (05:30) | End (05:40) | Growth |
|--------|---------------|-------------|--------|
| System prompt | 9,318ch | 9,318ch | 0 |
| User prompt | 2,751ch | 7,163ch | +160% |
| Context turns sent | 1 | 51 | +50 turns |
| **Total prompt chars** | **22,769ch** | **28,947ch** | **+27%** |
| Tool definitions | 10,667ch | 10,667ch | 0 |

### Assessment

- System prompt is stable and cached.
- Dynamic user/context growth is the main bloat source.
- Tool JSON is now a very large fixed tax: **10.7K chars every turn**.
- Compaction is helping, but only modestly in a 9-minute session.

### Context compaction detail

```
05:38:13 compaction_started  cursor=0   batch=10 -> completed at 05:38:22 (newCursor=10)
05:39:45 compaction_started  cursor=10  batch=10 -> completed at 05:39:53 (newCursor=20)
```

Average compaction time: ~8-9 seconds. Both rounds completed successfully.

### Memory load spikes

| Time | totalLoadMs | continuityMs | behavioralMs | Note |
|------|-------------|--------------|--------------|------|
| 05:31:17 | 7,058ms | 6,364ms | 693ms | Worst spike, right after screen-watch startup |
| 05:38:08 | 4,263ms | 3,174ms | 1,089ms | Late-session spike before member join greeting |
| 05:30:50 | 2,886ms | 2,571ms | 315ms | Early cold-ish load |
| 05:39:17 | 2,251ms | 2,058ms | 193ms | Late-session continuity spike |
| 05:32:25 | 2,058ms | 1,869ms | 189ms | Mid-session spike |

---

## 6. UX Observations

### A. No directive leak regressions

No spoken reply text in this session contained inline `[SKIP]`, `[[NOTE:...]]`, or `[[SOUNDBOARD:...]]` leakage. The fixes from the earlier voice session still appear to be holding.

### B. Soundboard directives worked

Two soundboard plays landed successfully:

- join greeting at **05:30:58**
- taunting Plantera reply at **05:34:15**

Both were intentional assistant directives, not accidental leakage.

### C. Reply mix felt conservative despite active room context

43 generation turns produced only 13 spoken replies. That is a **70% skip rate**. For a noisy shared-game session, this is understandable, but it also means clanky often watched and reasoned without contributing audible value.

---

## Open Items / Future Considerations

- **Screen-watch startup latency** is still too high. Spending 25.9s on the first share-start brain turn only to `[SKIP]` is expensive and feels bad.
- **ASR noise needs suppression at the source.** The empty-buffer errors are still cluttering incident review, and the single reconnect incident gets buried inside them.
- **Tool payload size remains expensive.** 25 tools / 10.7K chars per turn is a major fixed prompt tax.
- **Low-confidence gating may be a little too aggressive** for highly social rooms where short fragments are part of the vibe.
- **Screen grounding needs a tighter post-event memory of boss outcomes.** The Plantera death -> victory contradiction is the clearest product-quality miss in this session.
