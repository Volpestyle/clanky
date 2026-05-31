---
name: clanky-log-dive
description: Inspect recent Clanky local sessions, Discord text subagent state, Discord voice chat sessions, voice-worker handoffs, duplicate voice replies, and performance/cost signals with the clanky logs CLI.
when_to_use: Use when debugging recent Clanky sessions, Discord voice chat, Discord text subagents, voice-worker handoffs, repeated voice responses, duplicate ask_pi calls, stuck Discord inbox items, or Clanky performance/cost regressions.
allowed_tools:
  - Bash
deps: []
---

# Clanky Log Dive

Use this skill for Clanky's own local logs and subagent state. It is for Clanky Discord text/voice subagents, not AgentRoom coordination activity.

## Boundaries

- Work from `/Users/jamesvolpe/dev/clanky-pi` unless the user gives another checkout.
- Use the default profile at `/Users/jamesvolpe/.clanky/profiles/default` unless the user asks for another profile.
- Do not reach for AgentRoom room tooling when debugging Clanky Discord voice/text subagents unless the user explicitly asks about the room.
- Do not delete or rewrite skills under `~/.claude` or `~/.agents` while debugging logs.
- Prefer the CLI output first; only open raw JSONL, SQLite, or log files when the CLI output is insufficient.

## Primary Commands

Recent overview:

```bash
pnpm exec tsx agents/clanky/src/bin.ts logs --limit 8 --tail 80
```

Latest Discord voice session:

```bash
pnpm exec tsx agents/clanky/src/bin.ts logs --session discord-voice --limit 8 --tail 80
```

Voice-worker handoff details:

```bash
pnpm exec tsx agents/clanky/src/bin.ts logs --session voice-worker --limit 8 --tail 40
```

Machine-readable report:

```bash
pnpm exec tsx agents/clanky/src/bin.ts logs --session discord-voice --json
```

Alternate profile or home:

```bash
pnpm exec tsx agents/clanky/src/bin.ts logs --profile default
pnpm exec tsx agents/clanky/src/bin.ts logs --home /path/to/.clanky
```

## What To Check First

1. Read `Subagents` for active `discord-voice`, `voice-worker`, and `discord-guild` state.
2. Read `Recent Discord Inbox` for stuck `queued` or `claimed` text messages.
3. In `Selected Session`, check:
   - `Duplicate tool calls`, especially repeated `ask_pi`.
   - `Duplicate assistant messages`, especially repeated spoken replies.
   - timeline ordering between user speech, tool calls, tool results, and assistant messages.
4. For a selected `discord-voice` session, inspect `Linked Voice Worker` for delegated work, token count, cost, and repeated worker requests.
5. Read `Discord Voice Log Tail` for realtime errors such as `conversation_already_has_active_response`, TTS buffering, media playback, and clankvox transport state.
6. Read `Discord Bridge Log Tail` for Discord text gateway acceptance, queueing, and reply send timings.

## Interpreting Common Findings

- Repeated `ask_pi x3` with matching args means Realtime emitted duplicate tool calls. Confirm whether only one Pi/worker request should have run.
- Duplicate assistant messages after tool results usually mean each duplicate tool result created another spoken follow-up.
- `conversation_already_has_active_response` means the voice bridge attempted a new Realtime response while another response was active.
- A `discord-guild` subagent with queue depth and a `claimed` inbox row can indicate a stuck text-chat worker.
- High linked `voice-worker` tokens/cost usually means duplicate delegations or long tool-heavy work.

## Reporting

When answering, include exact timestamps with timezone context, the selected session file path, the duplicate counts, and the smallest likely root cause. If a fix was made, mention the verification commands that passed.
