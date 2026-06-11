# Memory And Privacy

Clanky keeps personal state profile-local. That makes profiles the privacy and
isolation boundary.

## Profile State

Default home:

```text
~/.clanky
```

Important profile stores include credentials, model registry entries, sessions,
memory, skills, subagent state, tracker refs, voice settings, and local
gateway/voice logs. The [Configuration Model](configuration.md) explains the
profile resolver and active profile paths.

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

Do not paste tokens into docs, Discord, or normal chat. Prefer the interactive
login commands so the secret is masked in the TUI and stored in the active
profile.

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

## Gateway Privacy Boundary

Gateways use Clanky's own profile credential, stored in the active profile's
`auth.json`. Gateway subagents are profile-local Clanky sessions; they share
the profile credential boundary and do not create a separate one.

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
