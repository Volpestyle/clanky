# Handoff: Generalize the Deferred Voice Action System

## Context

The codebase has a **deferred voice action** system in `voiceSessionManager.ts` that schedules bot-initiated speech for when the output channel is clear (no one talking, no pending responses, no tool calls running). It currently handles 3 action types:

- `join_greeting`
- `interrupted_reply`
- `queued_user_turns`

### The Problem

The recheck dispatch is **hardcoded** — `recheckDeferredVoiceActions()` (line 2740) has an `if/else` chain that calls a dedicated `recheckDeferredXxx()` method per type. Adding a new action type means:

- Another branch in the dispatch chain
- Another bespoke recheck method
- More scattered trigger points

---

## What to Do

### 1. Extract a Generic Gating Layer

All three `recheckDeferred*` methods share the same pattern:

1. Validate action exists and session is valid
2. Check expiry / time windows
3. Check `notBeforeAt` floor and reschedule if too early
4. Check output channel is clear (captures, `pendingResponse`, active response, tool calls)
5. If blocked → downgrade to `"deferred"` status
6. If clear → execute the action-specific fire logic

**Steps 1–5 are identical across all three.** Extract them into a single method:

```typescript
canFireDeferredAction(session, action): { canFire: boolean; blockReason?: string }
```

### 2. Make Action Types Register Their Own Fire Logic

Replace the `if (type === "join_greeting")` dispatch chain with a **registry map**:

```typescript
type DeferredActionHandler = (
  session: VoiceSession,
  action: DeferredVoiceAction,
  reason: string
) => boolean;
```

The three existing handlers (`recheckDeferredJoinGreeting`, `recheckDeferredInterruptedReply`, `recheckDeferredQueuedUserTurns`) get refactored to contain **only their action-specific fire logic**, with shared gating extracted out.

### 3. Clean Up Join-Greeting-Specific Trigger Points

The join greeting has bespoke trigger points scattered across the manager. These should all funnel through the generic `recheckDeferredVoiceActions()` rather than directly naming `join_greeting`:

| Location | Current Behavior |
|----------|-----------------|
| `voiceSessionManager.ts:7680` | Capture resolved with no speech → recheck join greeting |
| `voiceSessionManager.ts:8368` | Empty ASR drop → recheck join greeting |
| `voiceSessionManager.ts:10817` | Instructions updated → schedule join greeting grace |
| `voiceSessionManager.ts:2525–2545` | Playback armed → schedule join greeting |

> Each trigger point should say **"something changed, recheck all pending actions"** — the priority ordering already handles which fires first.

### 4. Delete Dead Dashboard Vestiges

| File | What to Remove |
|------|---------------|
| `dashboard/src/hooks/useVoiceSSE.ts` (lines 220–221) | Dead `greetingScheduled` and `greetingTimerActive` type fields |
| `dashboard/src/components/VoiceMonitor.tsx` (lines 1409–1416) | Two dead greeting pills that never render |
| `docs/diagrams/voice-subprocess-architecture.mmd` | Stale `"3s timer"` reference |

After deleting vestiges, run:

```bash
bun run diagrams
```

---

## Key Files

### Type Definitions

- `src/voice/voiceSessionTypes.ts` — Lines 287–356

### Core Logic (all in `voiceSessionManager.ts`)

| Lines | Contents |
|-------|----------|
| 2595–2774 | Core CRUD + scheduler + recheck dispatch |
| 2776–2832 | `recheckDeferredQueuedUserTurns` |
| 2834–2958 | `recheckDeferredJoinGreeting` |
| 2961–3040 | `recheckDeferredInterruptedReply` |
| 7680, 8368, 10817 | Join-greeting-specific trigger points |

### Dashboard (dead code)

- `dashboard/src/hooks/useVoiceSSE.ts` (lines 220–221)
- `dashboard/src/components/VoiceMonitor.tsx` (lines 1409–1416)

---

## Constraints

- **Do NOT touch** `voiceReplyDecision.ts`, `voiceMusicPlayback.ts`, or any music-related code — being worked on in parallel by another agent
- Run `bun run typecheck` after changes
- Run `bun test` after changes — **do NOT run smoke or live tests**
- Use **Bun**, not Node/NPM
- **No backward-compatibility shims** — delete dead code, don't wrap it
- Priority ordering in recheck must be preserved: `interrupted_reply` > `queued_user_turns` > `join_greeting`
- The `interrupted_reply` handler has extra context-dependent logic (barge-in user matching, capture duration check) — this is **fire-logic that stays in the handler**, not in the generic gating layer
