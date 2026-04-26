# Cancel System

> **Scope:** How the bot detects and handles explicit cancellation commands ("stop", "cancel", "nevermind") across text and voice.
> Voice barge-in (acoustic interruption): [`../voice/voice-output-and-barge-in.md`](../voice/voice-output-and-barge-in.md)
> Signal threading and abort plumbing: [`../tmp/archive/tool-call-cancellation-design.md`](../tmp/archive/tool-call-cancellation-design.md)

## Design Philosophy

Cancel sits at the same intersection as barge-in: fast execution vs. agent autonomy.

**Stopping must be immediate.** When someone says "stop", they need the bot to stop *now*. Adding 1-2 seconds of LLM reasoning while the bot keeps talking or working defeats the purpose. This is an infrastructure concern — same principle as acoustic barge-in gating.

**Everything after the stop is the agent's job.** What to say, what was lost, whether to offer a summary of partial results — these are conversational decisions the model should own. No hardcoded `"Cancelled."` responses.

**Cancel is only valid when the speaker has standing.** In a group voice channel, user B saying "stop" should not cancel user A's web search. The system checks ownership before firing.

## Detection

### Keyword Matching

`isCancelIntent()` in `src/tools/cancelDetection.ts`:

```
^(ok|oh|actually|just|please|yeah|hey)?\s*(stop|cancel|never mind|nevermind|nvm|forget it|abort|quit)\s*(it|that|this|please|now)?[.!]?$
```

Deliberately strict:
- Matches: "stop", "cancel", "ok nvm", "just stop it", "please cancel"
- Does NOT match: "stop the music", "don't stop", "can you cancel my subscription", "stop worrying about it"

The regex only catches short, unambiguous imperative commands. Anything longer or more nuanced flows to the LLM, which can reason about intent.

### Where Detection Runs

| Path | Location | When |
|------|----------|------|
| Text message | `bot.ts` message handler | After permission checks, before reply pipeline |
| Voice (ASR bridge) | `turnProcessor.ts` early in `runRealtimeTurn()` | When transcript override is available |
| Voice (post-ASR) | `turnProcessor.ts` after transcription | After silence gate and logprob confidence check |
| Voice (file ASR) | `turnProcessor.ts` in `runFileAsrTurn()` | After transcription |
| Music disambiguation | `voiceMusicDisambiguation.ts` | During active music selection flow |

## Execution: Stop Fast

When `isCancelIntent()` matches and the speaker has standing:

### Voice
1. Cancel active realtime response (`response.cancel` to provider)
2. Clear pending response from reply manager
3. Clear voice command session (music selection, tool followups)
4. Abort pending tool call controllers

### Text
1. Abort all active replies for this guild:channel scope (`activeReplies.abortAll()`)
2. Abort active browser tasks (`activeBrowserTasks.abort()`)
3. Cancel active code-orchestration swarm workers in scope: for each task with `requester=<this scope's planner peer>` not yet in a terminal status, update it to `status="cancelled"`. Clanky then stops the backing worker by closing its swarm-server PTY when available or SIGTERMing the fallback child process.

This all happens synchronously in ~1ms. The bot stops working immediately.

## Recovery: Agent Reasons About the Aftermath

After the immediate stop, the model generates the response — never hardcoded text.

### Voice (current)

A prompt utterance is queued with context about what was happening:

```
You were [doing X] when [speaker] said "[transcript]".
Active work: [web search for Y / generating a response about Z / playing music].
Acknowledge briefly. Do not continue the cancelled task.
```

The model writes the acknowledgement naturally: "Sure, I'll stop" or "Okay, cancelled that search" — adapting to what was actually happening.

### Text

After aborting active work, a lightweight generation call is queued with the interrupted context. The model writes the acknowledgement. If the LLM call fails or is too slow, the fallback is a reaction emoji.

## Speaker Ownership

### The Problem

In a multi-speaker voice channel, any user saying "stop" currently cancels all active work for the session — even if someone else initiated it.

### The Rule

Before firing cancel in voice:

1. **Check initiator match.** Is the speaker the one who started the active work? Compare against `pendingResponse.userId`, `lastRealtimeToolCallerUserId`, or `voiceCommandState.userId`.
2. **Check direct address.** Is the speaker talking to the bot? Use the same addressing confidence signal from the reply admission system.
3. **If neither:** Don't cancel. Let the transcript flow through normal turn processing. The model sees "stop" in context and can reason about whether it was directed at the bot, at another person, or was conversational.

This prevents user B from accidentally cancelling user A's request when they say "oh stop" to something funny in the conversation.

### Text Channel

Text cancel scoped to guild:channel is fine — in a text channel, "stop" directed at the bot is unambiguous since the bot's reply is visible in the same channel. No ownership check needed.

## No-Op Passthrough

If cancel intent is detected but **nothing is active to cancel:**

- **Don't swallow the message.** Let it flow through to the LLM as a normal turn.
- The user might be saying "stop" to someone else, or "nevermind" as part of a thought. The model should see it and respond naturally.

Text and voice both fall through correctly when nothing is active or when the voice speaker does not have standing to cancel current work.

## Cancel Boundaries

- **Already-completed work stays.** If a web search finished and results are in context, "cancel" preserves them.
- **Cooperative termination.** Tool calls receive an `AbortSignal` and check it cooperatively.
- **Immediate availability.** After cancelling, the bot is immediately available for new requests.
- **Independent from barge-in.** Barge-in is acoustic (user talks over bot audio). Cancel is semantic (user says a cancel keyword). They solve different problems and operate independently.

## Implementation Files

| File | Role |
|------|------|
| `src/tools/cancelDetection.ts` | `isCancelIntent()` regex |
| `src/tools/activeReplyRegistry.ts` | Scope-keyed abort controller registry |
| `src/bot.ts` | Text cancel handler |
| `src/voice/turnProcessor.ts` | Voice cancel detection + `cancelRealtimeSessionWork()` |
| `src/voice/voiceMusicDisambiguation.ts` | Music selection cancel |
| `src/voice/voiceReplyDecision.ts` | Tool followup cancel decision |

## Planned Improvements

- **AbortSignal threading**: Thread signals through all tool execution paths. See archived design doc for implementation plan.
- **AbortError distinction in tool output**: Return `{ cancelled: true }` instead of generic error when a tool is aborted, so the provider can skip retry.
