# Memory And Privacy

Clanky keeps personal state profile-local. That makes profiles the privacy and
isolation boundary.

## Profile State

Default home:

```text
~/.clanky
```

Important profile files:

| Path | Purpose |
| --- | --- |
| `profiles/<profile>/auth.json` | Profile-local credentials stored by Clanky auth commands. |
| `profiles/<profile>/models.json` | Model registry state for the profile. |
| `profiles/<profile>/sessions/` | Pi JSONL sessions for this Clanky profile. |
| `profiles/<profile>/memory/` | Source-grounded memory data. |
| `profiles/<profile>/SELF.md` | Profile-local self memory. |
| `profiles/<profile>/skills/` | Profile-local Clanky skills. |
| `profiles/<profile>/subagents/` | Discord and voice subagent state and sessions. |
| `profiles/<profile>/work-trackers/` | Provider-neutral tracker refs and outbox state. |
| `profiles/<profile>/discord-voice.json` | Stored voice settings. |
| `profiles/<profile>/discord-bridge.log` | Discord bridge log. |
| `profiles/<profile>/discord-voice.log` | Discord voice log. |

Use separate profiles for separate identities, rooms, experiments, or live
instances.

## Credential Rules

Interactive auth commands store credentials in the active profile's `auth.json`
with restricted file permissions:

- `/openai-login`
- `/discord-login`
- `/xai-login`
- `/elevenlabs-login`

Environment variables override stored profile credentials where supported. This
is useful for CI and launchers, but it also means `/setup status` or
`/openai-whoami` may report an env source instead of a stored source.

Do not paste tokens into docs, Discord, AgentRoom messages, or normal chat.
Prefer the interactive login commands so the secret is masked in the TUI and
stored in the active profile.

## Memory Policy

Clanky memory is intended for source-grounded facts, preferences, decisions,
commitments, lessons, and skill hints. It should not store secrets, credentials,
sensitive traits, unsupported guesses, or relationship inferences.

The model-facing `memory_remember` tool is instructed to store memories only
when the user explicitly asks for memory or confirms a proposed memory.

Clanky does not run a post-turn memory extractor. Memory writes are manual or
user-requested. For longer sessions, `/memory reflect` can queue a daily
reflection pass once there is enough transcript from the last 24 hours; that
pass asks Clanky to propose durable memories and to save only memories that
still meet the normal confirmation and privacy rules.

Accepted `memory_remember` and `memory_forget` tool results are also written
back into the Pi session as hidden `social_memory_op` audit breadcrumbs. Those
breadcrumbs make memory changes visible from the session tree without turning
stored memories into higher-priority instructions.

## Memory Commands

Inspect:

```text
/what_do_you_remember
/memory view
/why_did_you_say_that
/privacy
/who_are_you
```

Write:

```text
/memory remember <claim>
/memory reflect
```

Forget or disable:

```text
/memory forget <id>
/forget_me
/forget_this_channel <channel-id>
/memory off
/memory_off
```

Export:

```text
/memory export
/memory_export
```

## Discord Privacy Boundary

Agent-owned Discord uses Clanky's own profile credential. Room-owned Discord
uses AgentRoom's connector credential. Those credentials should not cross:

- Clanky must not read AgentRoom room connector tokens.
- AgentRoom must not read Clanky's profile token.
- One Discord conversation should not be owned by both at once.

Discord subagents are profile-local Clanky sessions. They are not AgentRoom
workers and do not create a separate credential boundary.

## Voice Privacy Boundary

Discord voice can record logs and transcript-derived context under the active
profile. Use:

```text
/voice-logs path
/voice-logs tail
/voice-logs clear
```

OpenAI Realtime and optional ElevenLabs receive the live audio/text needed for
voice operation. Native Go Live screen watching depends on user-token behavior
and should be treated as a live-gated capability.
