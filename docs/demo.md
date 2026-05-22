# Clanky Demo Script

This is the v1 demo script for recording the local, non-paid Clanky flow. It avoids launchd bootstrap, real model credentials, real Linear credentials, and real swarm/herdr dispatch so the local path stays non-mutating and non-paid. The Claude Code MCP mounted-client path has separate captured live-gate evidence and remains documented below for revalidation.

## Setup

```bash
cd /Users/jamesvolpe/clanky
pnpm install
pnpm check
pnpm smoke
```

Use a throwaway home so the demo is repeatable:

```bash
export CLANKY_DEMO_HOME="$(mktemp -d /tmp/clanky-demo.XXXXXX)"
```

## Local Daemon

```bash
pnpm clanky start --home "$CLANKY_DEMO_HOME" --detach
pnpm clanky status --home "$CLANKY_DEMO_HOME"
pnpm --silent clanky doctor --home "$CLANKY_DEMO_HOME" --json
```

Expected beats:

- `running: true`
- a profile-local socket and lock under `$CLANKY_DEMO_HOME/profiles/default`
- stable JSON live-gate preflight keys
- grouped `live_gates` JSON state for automation
- grouped `live_gate_blockers` JSON state for automation
- zero live-gate credentials unless the environment intentionally provides them

## Sessions And Skills

```bash
pnpm clanky skill list --home "$CLANKY_DEMO_HOME"
pnpm clanky send --home "$CLANKY_DEMO_HOME" --skill daily-digest "Summarize this demo in one sentence."
pnpm clanky session list --home "$CLANKY_DEMO_HOME"
pnpm clanky session search --home "$CLANKY_DEMO_HOME" demo
```

With no real model credentials, `send` should fail early with configured-model guidance. The smoke suite covers the same flow with Pi's faux provider.

## Cron

```bash
pnpm clanky cron add --home "$CLANKY_DEMO_HOME" --deliver file "2099-01-01T00:00:00.000Z" "Prepare a demo digest."
pnpm clanky cron list --home "$CLANKY_DEMO_HOME"
```

Expected beats:

- the cron job is persisted in the profile-local cron store
- the next-fire timestamp is visible in CLI and dashboard output

## TUI

```bash
pnpm clanky tui --home "$CLANKY_DEMO_HOME"
```

Expected beats:

- dashboard renders through Pi TUI in a real terminal
- persisted sessions appear as numbered quick-resume rows
- `q` exits the dashboard

## MCP And Swarm Shape

```bash
pnpm clanky mcp config --home "$CLANKY_DEMO_HOME"
pnpm --silent clanky mcp --home "$CLANKY_DEMO_HOME"
pnpm clanky swarm status --home "$CLANKY_DEMO_HOME"
```

Expected beats:

- MCP config prints a Claude Code-ready `mcpServers` fragment without editing client files
- MCP starts as a stdio server against the running daemon
- swarm status reports disabled or missing command unless `CLANKY_SWARM_ENABLED` and `CLANKY_SWARM_COMMAND` are configured

## Cleanup

```bash
pnpm clanky stop --home "$CLANKY_DEMO_HOME"
rm -rf "$CLANKY_DEMO_HOME"
```

## Live-Gate Recording Beats

Record these only after the user approves the needed credentials/services:

- detailed runbook: `docs/live-gates.md`
- launchd restart/logout: dry-run without secret env values with `pnpm clanky install --launchd --print`, then after explicit bootstrap approval run `pnpm clanky install --launchd --enable`, `launchctl print`, `launchctl kill SIGKILL`, `pnpm clanky status`, log out and back in, rerun `launchctl print` and `pnpm clanky status`, then `pnpm clanky uninstall --launchd`
- model/calendar: `pnpm clanky send --home ~/.clanky "what's on the calendar"`, search/export the resulting session, and resume it with `pnpm clanky tui --home ~/.clanky --session <id>`
- Linear cron: add/run a `linear:PROJ-123` cron job, confirm Linear receives the `run-now` comment, leave the job enabled through the next natural hourly fire to prove unattended execution, then remove the cron job
- real swarm/herdr: start Clanky with real swarm enabled, verify `clanky status`, `clanky swarm status`, and `clanky swarm snapshot`, run direct `clanky swarm dispatch`, verify `clanky swarm tasks` shows the completed task, then stop the daemon
- Claude Code MCP: after the swarm daemon is booted, run `pnpm clanky mcp config --home ~/.clanky`, mount Clanky as MCP, call public `swarm.dispatch` (shown as `clanky.swarm.dispatch` under a `clanky` mount), verify herdr worker claim/complete and Linear mirroring or `tracker_update_skipped`, then stop the daemon
- profile daemons: after explicit bootstrap approval, install `work` and `personal` launchd services, verify both `launchctl print` labels, compare `clanky task list` output for each profile, then uninstall both services
