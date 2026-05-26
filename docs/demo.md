# Clanky Demo Script

This is the current local demo path for Clanky as a standalone personal Pi
agent. It avoids paid/live services unless you explicitly run the credentialed
checks in `docs/live-gates.md`.

## Setup

```bash
cd /Users/jamesvolpe/web/clanky-pi
pnpm install
pnpm check
pnpm smoke
```

Use an isolated profile for repeatable demos:

```bash
export CLANKY_DEMO_HOME="$(mktemp -d /tmp/clanky-demo.XXXXXX)"
pnpm clanky --home "$CLANKY_DEMO_HOME" --profile demo --help
```

## Interactive Run

```bash
pnpm clanky --home "$CLANKY_DEMO_HOME" --profile demo --cwd .
```

Useful in-TUI commands:

```text
/openai-whoami
/discord-whoami
/discord-status
/discord-voice status
/effort
```

Without stored or environment model credentials, OpenAI-backed features should
report credential guidance instead of silently falling back.

## Non-Live Smoke Checks

```bash
pnpm smoke:clanky
pnpm smoke:voice
pnpm smoke:agent-tools
pnpm smoke:subagents
pnpm voice:native:test
```

The smoke suite uses temporary profile state and does not require real Discord,
OpenAI, Linear, xAI, or ElevenLabs credentials.

## Optional Credentialed Checks

After the user approves live service use, run the relevant runbook:

- OpenAI model auth: `/openai-login`, then `/openai-whoami`.
- Agent-owned Discord text: `/discord-login`, restart Clanky, then
  `/discord-status`.
- Discord voice: `docs/discord-voice-live-runbook.md`.
- AgentRoom launch: initialize an AgentRoom room and run
  `agent-room launch clanky --harness pi --command "pnpm --dir /Users/jamesvolpe/web/clanky-pi clanky --home ./.clanky-room --profile demo" --cwd .`.

## Cleanup

```bash
rm -rf "$CLANKY_DEMO_HOME"
```
