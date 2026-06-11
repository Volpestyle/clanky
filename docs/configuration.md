# Configuration Model

Clanky uses profile-local durable stores with TUI editors, not a room-level YAML
topology file. The active profile is the source of truth for personal Clanky
state.

## Active Profile

Profile resolution is explicit and portable:

```text
--home / CLANKY_HOME       selects the Clanky home, default ~/.clanky
--profile / CLANKY_PROFILE selects the active profile
~/.clanky/.profile        remembers the active profile when no override is set
```

Use `/profile` or `/setup status` inside the TUI to see which home and profile
you are editing.

## Durable Stores

The active profile owns durable personal Clanky configuration and state:

- `<profileDir>/auth.json` stores profile credentials such as OpenAI,
  agent-owned communication gateway adapters, xAI, and ElevenLabs with `0600`
  permissions.
- `<profileDir>/discord-voice.json` stores non-secret Discord voice settings
  edited by `/discord-voice`.
- `<profileDir>/models.json` stores custom model registry entries used by Pi's
  model selector.
- `<profileDir>/SELF.md`, `memory/`, `sessions/`, `subagents/`, and
  `work-trackers/` store profile-local memory, sessions, subagent state, and
  external tracker issue refs.

The TUI setup and status commands edit or report these stores:

```text
/setup
/openai-login
/auth
/discord-login
/discord-voice
/xai-login
/elevenlabs-login
/profile
```

They should not write hidden state outside the resolved Clanky home/profile.
Use `/auth remove <provider>` or `/auth remove all` to delete stored provider
credentials from the active profile without touching launch environment
variables.

## Environment Overrides

Environment variables are launch-time overrides. They are useful for CI and
temporary sessions, but they do not replace the profile store.

Credential precedence follows the existing pattern:

```text
Clanky-scoped env var -> generic provider env var -> profile auth store
```

For example, `CLANKY_DISCORD_TOKEN` wins over the stored `clanky-discord`
credential, and `CLANKY_OPENAI_API_KEY` wins over `OPENAI_API_KEY` and stored
OpenAI auth where that resolver is used. Voice settings also allow documented
env overrides for one-off launches.

If a new setting supports env overrides, document the exact precedence and show
the active source in status output.

## Gateway Ownership

Clanky's canonical conversation is the Pi session thread. The Discord chat
gateway is agent-owned: Clanky holds the credential in the active profile and
owns the gateway lifecycle. A gateway can be absent entirely and Clanky still
works as a local Pi agent.

A chat gateway delivers inbound messages, receives replies, and routes accepted
side requests to profile-local subagents so the foreground session stays
useful. The voice/media gateway (ClankVox) is a separate live media path with
its own settings; it is not coupled to chat.

Work-tracker creation, comments, and status updates go through the installed
MCP server, CLI, or skill for that provider; Clanky stores only issue refs in
the profile.

## Rule For New Settings

Every new durable Clanky setting should answer four questions in code and docs:

1. Which profile file or database owns it?
2. Which parser/validator owns the schema?
3. Which TUI command edits and reports it?
4. Which env vars, if any, override it?

If a value is only kept in process memory, treat it as a session-local runtime
control. Do not describe it as durable profile configuration until it has a
profile-backed store and status output.
