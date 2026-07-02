---
name: clanky-log-dive
description: Inspect Clanky's local eve/herdr runtime status, Discord presence panes, voice runtime symptoms, and performance/cost signals.
when_to_use: Use when debugging recent Clanky sessions, Discord text or voice presence, repeated voice responses, stuck herdr panes, missing Discord replies, or Clanky performance/cost regressions.
allowed_tools:
  - Bash
deps: []
---

# Clanky Log Dive

Use this skill for Clanky's own local runtime state, covering the eve brain,
herdr panes, and Discord text/voice presence mirrors.

## Boundaries

- Work from `/Users/james/dev/clanky/clanky-agent` unless the user gives another checkout.
- Use the configured `CLANKY_HOME` when set; otherwise inspect `~/.clanky`.
- Do not delete or rewrite skills under `~/.claude` or `~/.agents` while debugging logs.
- Prefer lifecycle status and herdr pane output first; only open raw JSONL,
  SQLite, or state files when the command output is insufficient.

## Primary Commands

Lifecycle overview:

```bash
pnpm clanky status
```

Herdr stage overview:

```bash
herdr --session clankies agent list
```

Read the active panes, choosing exact names from `agent list`:

```bash
herdr --session clankies agent read <agent-name>
```

Common pane prefixes to inspect when present:

```bash
herdr --session clankies agent list
herdr --session clankies agent read clanky:discord-<suffix>
herdr --session clankies agent read clanky:voice-<slug>
```

Start the runtime if status shows no brain:

```bash
pnpm clanky up
```

## What To Check First

1. Check `pnpm clanky status` for the herdr session, brain pane, and serving
   state.
   If you are already inside Herdr (`HERDR_ENV=1`) and `pnpm clanky status`
   reports the persistent `clankies` session is down, also check the current
   workspace with `herdr pane list`; live dev instances may be running outside
   the persistent session.
2. Read `herdr agent list` for the face pane, Discord presence mirrors, voice
   mirror, and delegated worker panes.
3. Read the relevant pane tail and check ordering between user input, tool calls,
   tool results, and assistant messages.
4. For Discord text, inspect the gateway/presence pane for acceptance decisions,
   `[SKIP]`, REST reply failures, and bridge commands.
5. For voice, inspect the voice pane for realtime errors such as
   `conversation_already_has_active_response`, TTS buffering, media playback, and
   ClankVox transport state.
6. If panes are silent, inspect `.env.local` and `~/.clanky` state paths for
   missing credentials or stale runtime state without printing secret values.

## Interpreting Common Findings

- Missing brain pane or `serving: false` usually means the eve service is down;
  run `pnpm clanky up` and re-check status.
- Duplicate assistant messages after tool results usually mean each duplicate
  tool result created another spoken follow-up.
- `conversation_already_has_active_response` means the voice bridge attempted a new Realtime response while another response was active.
- Missing Discord mirror panes can mean the gateway is not running, no message
  has been accepted into a presence session yet, or pane spawning failed.
- High token/cost signals usually mean duplicate delegations or long tool-heavy
  work.

## Reporting

When answering, include exact timestamps with timezone context, the selected session file path, the duplicate counts, and the smallest likely root cause. If a fix was made, mention the verification commands that passed.
