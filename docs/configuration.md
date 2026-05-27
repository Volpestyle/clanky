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

- `<profileDir>/auth.json` stores profile credentials such as OpenAI, Discord,
  xAI, and ElevenLabs with `0600` permissions.
- `<profileDir>/discord-voice.json` stores non-secret Discord voice settings
  edited by `/discord-voice`.
- `<profileDir>/models.json` stores custom model registry entries used by Pi's
  model selector.
- `<profileDir>/SELF.md`, `memory/`, `sessions/`, `subagents/`, `linear/`, and
  `cron/` store profile-local memory, session, multitasking, work, and scheduled
  job state.

The TUI setup and status commands edit or report these stores:

```text
/setup
/openai-login
/discord-login
/discord-voice
/xai-login
/elevenlabs-login
/profile
```

They should not write hidden state outside the resolved Clanky home/profile.

## Environment Overrides

Environment variables are launch-time overrides. They are useful for CI,
AgentRoom launches, and temporary sessions, but they do not replace the profile
store.

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

## AgentRoom Boundary

Clanky profile config and AgentRoom room config are separate:

- Clanky owns personal credentials, profile memory, persona state, sessions,
  skills, and agent-owned chat gateway settings.
- AgentRoom owns `.agentroom/config.yaml`, runtime topology, room-owned chat
  gateways, room routes, and audited room coordination.

When Clanky is launched in AgentRoom, `AGENTROOM=1` means room participation
only. It does not move Clanky's profile credentials into AgentRoom and it does
not make Clanky read a room-owned connector token.

## Rule For New Settings

Every new durable Clanky setting should answer four questions in code and docs:

1. Which profile file or database owns it?
2. Which parser/validator owns the schema?
3. Which TUI command edits and reports it?
4. Which env vars, if any, override it?

If a value is only kept in process memory, treat it as a session-local runtime
control. Do not describe it as durable profile configuration until it has a
profile-backed store and status output.
