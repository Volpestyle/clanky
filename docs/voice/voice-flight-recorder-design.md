# Voice Flight Recorder — Visual Debugging System

Status: forward-looking design reference. The shipped debugger surfaces live in `dashboard/src/components/VoiceDebugger.tsx` and `dashboard/src/components/VoiceMonitor.tsx`; this doc is not canonical runtime truth.

References:
- [`docs/tmp/runtime-debugger-and-incident-replay-design.md`](../tmp/runtime-debugger-and-incident-replay-design.md)
- [`docs/voice/voice-capture-and-asr-pipeline.md`](voice-capture-and-asr-pipeline.md)
- [`docs/voice/voice-client-and-reply-orchestration.md`](voice-client-and-reply-orchestration.md)
- [`docs/voice/voice-output-and-barge-in.md`](voice-output-and-barge-in.md)
- [`docs/voice/voice-provider-abstraction.md`](voice-provider-abstraction.md)

## The Core Problem

The voice system has ~12 concurrent subsystems (capture, VAD, ASR, addressing,
admission, thought engine, generation, tool calls, TTS, output lock, barge-in,
music) all exchanging signals in real-time. The current VoiceMonitor shows
session state as cards and a flat event log, but it doesn't answer the two most
important questions:

1. **"Why didn't it respond?"** — requires stitching capture → ASR → admission
   → output lock causality
2. **"Why did it feel broken?"** — requires seeing how overlapping subsystem
   timings interfered

The runtime debugger design doc nails the thesis: **the product is causality
reconstruction, not more analytics.** What's missing is the visual language to
make that causality legible at a glance.

## Aesthetic Direction: Audio Engineering Control Room

Think Pro Tools session view meets NASA mission control. High-density,
multi-lane, time-synchronized visualization. Dark, utilitarian, designed for
operators who stare at this for hours. The existing dark green-tinted palette
(`--bg-0: #060d0f`, accent lime `#bef264`) already has this vibe — lean into it
hard.

Key visual principles:

- **Time is always the x-axis** — everything shares a synchronized horizontal
  timeline
- **Subsystems are lanes** — stacked vertically like DAW tracks
- **Color = health** — green flowing, amber degraded, red broken
- **Density over decoration** — show more data, less chrome

## Design 1: The Lane Timeline

The centerpiece. A horizontally-scrolling, vertically-stacked timeline where
each voice subsystem gets its own lane, all time-synchronized.

```
 TIME ───────────────────────────────────────────────────────────►

 CAPTURE    ▁▂▃▅▇█▇▅▃▁·····▁▃▅▇██▇▅▃▂▁··········▁▂▅▇▅▂▁
            James          James                   User2
            [promoted]     [promoted]              [silence-gated]

 ASR        ·····╌╌╌"Hey C"╌╌"Hey Clanky"·····╌╌╌"what time"╌╌"what time is it"
                  partial──────►final              partial─────────►final
                  conf: 0.94                       conf: 0.88

 DECISION   ·············●─────────────·············●──────────
                        ALLOW                      ALLOW
                    direct-addr 0.95            direct-addr 0.91

 GENERATE   ··············┈┈┈┈████████┈·············┈┈███████████┈
                           gpt-5.4-mini              gpt-5.4-mini
                              340ms                    520ms

 OUTPUT     ···················▓▓▓▓▓▓▓▓▓▓···················▓▓▓▓▓▓▓▓▓▓▓▓
                              SPEAKING                      SPEAKING
                              ↑lock                  ↓unlock↑lock    ↓unlock

 BARGE-IN   ··························✗···························
                                   User2
                                DENIED: insufficient signal

 MUSIC      ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
            idle                                              idle

 THOUGHT    ··········································◇─────◇─────→
                                                   queued  reconsider
                                                   "the weather..."
```

Each lane is collapsible. Operators expand only what they're investigating.
Collapsed lanes show a thin activity heat strip — just colored bars indicating
"something happened here."

Click any event marker to open the Turn Detail panel on the right with full
context.

The playhead — a vertical line you can drag or that auto-follows in live mode.
Everything snaps to it: the detail panel shows whatever turn/event the playhead
is on.

### Lane color scheme

| Lane      | Active Color          | Idle       | Error      |
|-----------|-----------------------|------------|------------|
| Capture   | `--accent` (lime)     | `--ink-3`  | `--danger` |
| ASR       | `#60a5fa` (blue)      | `--ink-3`  | `--danger` |
| Decision  | `--success`/`--danger` | `--ink-3` | `--warning` |
| Generate  | `#c084fc` (purple)    | `--ink-3`  | `--danger` |
| Output    | `--accent` (lime)     | `--ink-3`  | `--warning` |
| Barge-in  | `--warning` (amber)   | transparent | `--danger` |
| Music     | `#f472b6` (pink)      | `--ink-3`  | `--danger` |
| Thought   | `#34d399` (teal)      | `--ink-3`  | `--warning` |

## Design 2: The Pipeline Waterfall

When you click into a specific turn, the detail panel shows a waterfall chart —
like Chrome DevTools network waterfall, but for voice pipeline stages.

```
 Turn #7 — James: "Hey Clanky, what time is it?"

 ┌─ PIPELINE ──────────────────────────────────────────────┐
 │                                                         │
 │  Capture    ████████░░░░░░░░░░░░░░░░░░░░░  1.2s        │
 │  Finalize        ░░██░░░░░░░░░░░░░░░░░░░░  80ms        │
 │  ASR              ░░████░░░░░░░░░░░░░░░░░  180ms       │
 │  Admission            ░░█░░░░░░░░░░░░░░░░  40ms        │
 │  Queue wait              ░██░░░░░░░░░░░░░  120ms       │
 │  Generation                 ░░████████░░░  340ms       │
 │  TTS start                           ░██░  90ms        │
 │  First audio                            █  10ms        │
 │  ──────────────────────────────────────────             │
 │  TOTAL                                       860ms     │
 │                                                         │
 │  ● Avg for session: 720ms                              │
 │  ● Avg for last hour: 680ms                            │
 │  ▲ 26% slower than average                             │
 └─────────────────────────────────────────────────────────┘
```

Color the bars: green < p50, amber p50-p90, red > p90 relative to session
averages. This immediately shows which stage is the bottleneck.

Below the waterfall, show the causality chain as a compact flow:

```
 ┌─────────┐    ┌─────────────┐    ┌────────────────────┐    ┌──────────┐
 │ CAPTURE  │───▶│ ASR          │───▶│ ADMISSION          │───▶│ GENERATE │
 │ 1.2s     │    │ "Hey Clanky, │    │ ● ALLOW            │    │gpt-5.4-mini│
 │ promoted │    │  what time   │    │ direct-addr: 0.95  │    │ 340ms    │
 │ strong   │    │  is it?"     │    │ output: unlocked   │    │ 42 tok   │
 │ local    │    │ conf: 0.94   │    │ wake: ACTIVE       │    │          │
 └─────────┘    └─────────────┘    └────────────────────┘    └──────────┘
                                                                   │
 ┌──────────┐    ┌──────────────┐                                  │
 │ PLAYING  │◀───│ OUTPUT LOCK  │◀─────────────────────────────────┘
 │ 2.1s     │    │ locked: bot  │
 │ complete │    │ policy: any  │
 └──────────┘    └──────────────┘
```

## Design 3: Real-Time Signal Dashboard

A persistent strip showing live meters for all active participants. Think audio
mixing console VU meters.

```
 ┌─ SIGNAL METERS ─────────────────────────────────────────────────────┐
 │                                                                     │
 │  James         User2          Bot                                   │
 │  ▐████████░░▌  ▐██░░░░░░░░▌  ▐░░░░░░░░░░▌  ← Peak amplitude      │
 │  ▐█████░░░░░▌  ▐█░░░░░░░░░▌  ▐░░░░░░░░░░▌  ← RMS energy          │
 │  VAD: ■■■■□□   VAD: □□□□□□   OUT: IDLE                             │
 │  Active: 72%   Active: 3%    Lock: ○                               │
 │  Addr: →🤖95%  Addr: →James  Phase: IDLE                           │
 │  Capture: 1.4s              Thought: ◇ queued                       │
 │                                                                     │
 │  ASR Health: ● connected     Gen Health: ● ready                   │
 │  Transport:  ● ws open       Music:      ○ idle                    │
 └─────────────────────────────────────────────────────────────────────┘
```

The meters animate continuously in live mode — CSS animations for the bar
fills, pulsing dots for active VAD. Immediate "is anything happening" feedback
without reading text.

## Design 4: The Anomaly Sidebar

A persistent narrow panel that auto-detects and flags patterns. Each anomaly is
a card you can click to jump to the relevant timeline position.

```
 ┌─ ANOMALIES ────────────────┐
 │                             │
 │  ● 2 issues detected       │
 │                             │
 │  ┌── 🔴 CRITICAL ────────┐ │
 │  │ Empty ASR after        │ │
 │  │ promotion              │ │
 │  │                        │ │
 │  │ User2 spoke for 1.8s, │ │
 │  │ promoted via strong    │ │
 │  │ local signal, but ASR  │ │
 │  │ returned empty text.   │ │
 │  │                        │ │
 │  │ 14:32:07 ── jump →     │ │
 │  └────────────────────────┘ │
 │                             │
 │  ┌── 🟡 WARNING ─────────┐ │
 │  │ Output lock held 6.2s │ │
 │  │                        │ │
 │  │ Lock entered at        │ │
 │  │ RESPONSE_PENDING but   │ │
 │  │ no audio produced for  │ │
 │  │ 6.2s. Cleared by       │ │
 │  │ stale response sweep.  │ │
 │  │                        │ │
 │  │ 14:33:41 ── jump →     │ │
 │  └────────────────────────┘ │
 │                             │
 │  SESSION HEALTH             │
 │  ┌────────────────────────┐ │
 │  │ Turns: 12              │ │
 │  │ Avg latency: 720ms    │ │
 │  │ Barge-in deny: 3      │ │
 │  │ Empty ASR: 1           │ │
 │  │ Silence-gated: 4      │ │
 │  │ Stale locks: 1         │ │
 │  └────────────────────────┘ │
 └─────────────────────────────┘
```

### Anomaly rules (first set)

| Anomaly | Severity | Detection |
|---------|----------|-----------|
| Empty ASR after promotion | Critical | Promoted capture → finalized with empty text |
| Direct address denied by lock | Critical | Addressing confidence > 0.8 + output locked |
| Output lock stuck | Warning | Lock held > 5s without audio produced |
| Repeated silence-gate drops | Warning | Same user dropped 3+ times in 60s |
| Generation succeeded, no output | Critical | LLM returned text but output never started |
| Tool call stalled | Warning | Tool call > 10s without result |
| Barge-in storm | Warning | 3+ barge-in denials in 10s |
| Stale realtime response | Warning | Active response > 8s without audio delta |
| High latency turn | Info | Total pipeline > 2x session average |
| ASR confidence degraded | Warning | Mean logprob below threshold for 3+ turns |

## Design 5: The "Why Didn't It Respond?" Drilldown

The killer feature. When a user spoke but the bot didn't respond, one click
explains why. A focused single-screen view:

```
 ┌─ WHY NO RESPONSE ─────────────────────────────────────────────────┐
 │                                                                    │
 │  User2 spoke at 14:32:07 — "so what do you guys think about..."  │
 │                                                                    │
 │  PIPELINE TRACE                                                    │
 │                                                                    │
 │  ✅ 1. Capture promoted                                           │
 │     │  Via: strong_local_audio                                    │
 │     │  Duration: 2.1s  Peak: 0.34  Active: 68%                   │
 │     │                                                              │
 │  ✅ 2. ASR transcribed                                            │
 │     │  Text: "so what do you guys think about that"               │
 │     │  Confidence: 0.91  Model: gpt-4o-transcribe                 │
 │     │                                                              │
 │  ✅ 3. Addressing evaluated                                       │
 │     │  Target: other_users  Confidence: 0.12                      │
 │     │  Reason: no bot name, no prior direct thread                │
 │     │                                                              │
 │  ❌ 4. Admission DENIED                          ← STOP POINT    │
 │     │  Reason: ambient_below_threshold                            │
 │     │  Wake state: AMBIENT (no recent direct address)             │
 │     │  Thought engine: not triggered (addressing too low)         │
 │     │                                                              │
 │  ░░ 5. Generation — skipped                                       │
 │  ░░ 6. Output — skipped                                           │
 │                                                                    │
 │  ┌─ CONTEXT AT DECISION TIME ─────────────────────────────────┐   │
 │  │ Attention: AMBIENT (last direct: 4m 12s ago)               │   │
 │  │ Output lock: unlocked                                       │   │
 │  │ Music: idle                                                 │   │
 │  │ Pending thought: none                                       │   │
 │  │ Recent turns: 3 (last bot reply: 2m 8s ago)                │   │
 │  └─────────────────────────────────────────────────────────────┘   │
 │                                                                    │
 │  VERDICT: Not addressed to bot, ambient engagement too low.       │
 └────────────────────────────────────────────────────────────────────┘
```

The pipeline as a checklist that stops at the first failure. Green checkmarks
for stages that passed, red X for the stop point, gray for stages that never
ran. The operator immediately sees exactly where and why the pipeline stopped.

## Full Page Layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│  VOICE DEBUGGER          [● LIVE]  [⏮ REPLAY]  [🔍 SEARCH]     session │
│                                                                  picker │
├──────────────────────────────────────────────────────────────────────────┤
│ ┌─ STATUS BAR ─────────────────────────────────────────────────────────┐│
│ │ SESSION abc12  MODE openai_realtime  PROVIDER gpt-4o-realtime       ││
│ │ UPTIME 42m     PARTICIPANTS 3        OUTPUT IDLE  ASR ● TRANSPORT ● ││
│ └──────────────────────────────────────────────────────────────────────┘│
├────────────────────────────────────────────────────────┬─────────────────┤
│                                                        │                 │
│  ┌─ SIGNAL METERS ──────────────────────────────────┐  │  TURN DETAIL    │
│  │ James ▐████░░▌ 0.4  User2 ▐█░░░░░▌ 0.1  Bot ○  │  │  or             │
│  │ VAD ■■■□  Addr →🤖   VAD □□□□  Addr →James     │  │  WHY NO REPLY   │
│  └──────────────────────────────────────────────────┘  │  or              │
│                                                        │  ANOMALY DETAIL  │
│  ┌─ LANE TIMELINE ─── [−][+] zoom ── ◀ ●▌ ▶ ─────┐  │                  │
│  │ CAPTURE  ▂▃▅▇▅▃▁·····▁▃▅▇██▇▅▃▂▁···▁▂▅▇▅▂   │  │  ┌────────────┐ │
│  │ ASR      ···"Hey C"···"Hey Clanky"···"what t   │  │  │ Pipeline   │ │
│  │ DECISION ·········●allow···········●allow···   │  │  │ waterfall  │ │
│  │ GENERATE ··········████████·········██████··   │  │  │            │ │
│  │ OUTPUT   ·············▓▓▓▓▓▓▓▓▓·····▓▓▓▓▓▓   │  │  │ Causality  │ │
│  │ BARGE-IN ····················✗··············   │  │  │ chain      │ │
│  │ THOUGHT  ··································   │  │  │            │ │
│  │ MUSIC    ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   │  │  │ Context    │ │
│  │                    ▼ playhead                   │  │  │ snapshot   │ │
│  └────────────────────────────────────────────────┘  │  └────────────┘ │
│                                                        │                 │
│  ┌─ EVENT LOG ─── [filter: ▾ all] ────────────────┐  │  ANOMALIES (2)   │
│  │ 14:32:07 capture_promoted James strong_local   │  │  🔴 Empty ASR   │
│  │ 14:32:08 asr_final "Hey Clanky..."  conf:0.94  │  │  🟡 Lock > 5s   │
│  │ 14:32:08 admission_allow direct_addr:0.95      │  │                  │
│  │ 14:32:08 generation_start gpt-5.4-mini          │  │  HEALTH          │
│  │ 14:32:09 output_lock reason:bot_audio_live     │  │  Turns: 12       │
│  └────────────────────────────────────────────────┘  │  Avg: 720ms      │
├────────────────────────────────────────────────────────┴─────────────────┤
│  ┌─ LATENCY TREND ── last 12 turns ─────────────────────────────────┐   │
│  │  ▃ ▅ ▃ ▂ ▇ ▃ ▂ ▃ █ ▃ ▅ ▃                                       │   │
│  │  avg 720ms  p90 1.1s  worst 1.4s                                 │   │
│  └──────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────┘
```

## Implementation Plan

### Phase 1: Lane Timeline + Turn Waterfall

New component `VoiceDebugger.tsx` as a new view mode within the Voice tab
(toggle between current monitor view and debugger view). Uses the same
`useVoiceSSE` hook but renders events into time-synchronized lanes. Click a turn
in the timeline → shows pipeline waterfall + causality chain in detail panel.
The lane data is already in the SSE stream — it just needs visual
restructuring.

### Phase 2: "Why No Response?" Drilldown

Requires backend work: add explicit "no reply because X" terminal markers to
the action log (the runtime debugger design doc calls this out as a logging
gap). Frontend: pipeline checklist view that stops at the failure point.

### Phase 3: Anomaly Detection

Client-side anomaly rules that scan the event stream. Pattern matching on event
sequences (promoted → empty ASR, lock held too long, etc.). Persistent sidebar
with jump-to-timeline links.

### Phase 4: Signal Meters

Requires backend to expose per-user audio metrics via SSE (capture signal stats
are already computed but not streamed to dashboard). CSS-animated meter bars
with real-time updates.

## Data Availability

| Feature | Data Available? | Gap |
|---------|----------------|-----|
| Lane timeline events | Yes — SSE `voice_event` stream | Need to categorize by lane |
| Latency waterfall | Yes — `latency.recentTurns` | Already have all 4 stages |
| Causality chain | Partial — turns + events exist | Need `turnId` correlation |
| Signal meters | Partial — capture metrics in barge-in | Not streamed to dashboard live |
| Anomaly detection | Yes — all events available | Client-side rule engine needed |
| "Why no response" | Partial — admission events exist | Missing explicit terminal events |
| Addressing confidence | Yes — in timeline entries | Not surfaced in current UI |
| Thought engine state | Yes — in session snapshot | Partially shown, needs timeline lane |
