# Running Multiple Instances

Each clanky instance needs its own Discord identity, data directory, and dashboard port. The simplest way to achieve this is a local clone.

## Clone and configure

Clone from your local primary checkout (instant, no network round-trip):

```bash
git clone ~/web/clanky ~/web/clanky-2
cd ~/web/clanky-2
git remote set-url origin git@github.com:Volpestyle/clanky.git   # point at GitHub, not the local clone
git submodule update --init --recursive                           # pull clankvox submodule
bun install
cp .env.example .env
```

Edit the new `.env` with instance-specific values:

```bash
# A separate Discord account token (required — Discord allows one gateway session per token)
DISCORD_TOKEN=<instance-2-token>

# Unique instance label for Loki/Grafana log filtering
CLANKER_INSTANCE_ID=clanky-2

# Different dashboard port to avoid EADDRINUSE
DASHBOARD_PORT=8788
```

API keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.) can be shared across instances or set separately for independent billing.

## Keeping instance 2 up to date

When you push code changes from your primary clone, pull them into instance 2:

```bash
cd ~/web/clanky-2
git pull
git submodule update --init --recursive   # sync clankvox if it moved
bun install                               # pick up any dependency changes
```

If instance 2 is running via pm2, restart it after pulling:

```bash
pm2 restart clanky-2
```

Instance-specific files (`data/`, `memory/`, `.env`) are gitignored and untouched by `git pull` — only code changes come through. Settings, persona, memory, and runtime state are fully preserved across updates.

## What is isolated per clone

| Resource | Path (relative to clone root) | Why it matters |
|----------|-------------------------------|----------------|
| SQLite database | `data/clanker.db` | Settings, permissions, presets, personas, action logs |
| Memory | `memory/MEMORY.md`, `memory/YYYY-MM-DD.md` | Curated facts and daily journals |
| Runtime logs | `data/logs/runtime-actions.ndjson` | Structured ndjson for Promtail/Loki |
| OAuth token caches | `data/claude-oauth-tokens.json`, `data/openai-oauth-tokens.json` | Refresh token rotation |
| Browser profile | `~/.clanky/browser-profile` (shared by default) | Override via dashboard settings if needed |

## Start instance 2

```bash
cd ~/web/clanky-2
bun run start
```

Dashboard at `http://localhost:8788`. Configure persona, permissions, voice settings, etc. through the dashboard — each instance has its own settings database.

## Keep both running

```bash
pm2 start "bun run start" --name clanky   --cwd ~/web/clanky
pm2 start "bun run start" --name clanky-2 --cwd ~/web/clanky-2
pm2 save && pm2 startup
```

## Shared Loki/Grafana

Both instances can feed into a single Loki stack. The Loki stack runs from one clone — typically the primary one.

### 1. Mount instance 2's logs into Promtail

In `docker-compose.loki.yml`, add instance 2's log directory as a volume on the `promtail` service:

```yaml
promtail:
  volumes:
    - ./ops/loki/promtail-config.yml:/etc/promtail/config.yml:ro
    - ./data/logs:/var/log/clanker/default:ro
    - /absolute/path/to/clanky-2/data/logs:/var/log/clanker/clanky-2:ro
    - promtail-data:/tmp
```

The Promtail config uses `__path__: /var/log/clanker/*/runtime-actions.ndjson` so any new subdirectory is picked up automatically.

### 2. Set CLANKER_INSTANCE_ID in each instance

Each instance's `.env` should have a unique `CLANKER_INSTANCE_ID`. This value is written into every ndjson log line and promoted to a first-class Loki label.

### 3. Restart the Loki stack

```bash
cd ~/web/clanky    # primary clone
bun run logs:loki:down && bun run logs:loki:up
```

### 4. Query by instance in Grafana

```logql
{job="clanker_runtime",instance="clanky-2"}
{job="clanker_runtime",instance="clanky",agent="voice",level="error"}
```

## Adding more instances

For each additional instance, repeat the pattern:

1. Clone the repo to a new directory.
2. Set unique `DISCORD_TOKEN`, `CLANKER_INSTANCE_ID`, and `DASHBOARD_PORT` in `.env`.
3. Add a volume line to `docker-compose.loki.yml` mapping `<clone>/data/logs` to `/var/log/clanker/<instance-id>`.
4. Restart the Loki stack.
