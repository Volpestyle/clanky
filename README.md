# Clanky (v2-vanilla)

Always-on agent harness built on Pi, modeled on hermes-agent. This branch (`v2-vanilla`) is the swarm-free flavor of Clanky v2: the gateway leader / swarm-mcp surface has been pruned, leaving Telegram/Discord messaging, cron, Linear, memory, and the daemon/gateway/CLI/TUI core.

The workspace is pnpm-based and runs Clanky as a TypeScript daemon with embedded Pi sessions, profile-local state, cron, MCP/HTTP/UDS gateways, Linear outbox delivery, a privacy-gated memory system, and messaging adapters for Telegram (grammY) and Discord (discord.js). `pnpm-workspace.yaml` delays newly published packages for 24 hours, enforces peer dependencies, verifies package store integrity, and allows dependency install scripts only for explicitly listed packages.

```bash
pnpm install
pnpm smoke
```

`pnpm smoke` covers local, non-paid behavior: pnpm-only package-manager guardrails, daemon boot, detached daemon start/stop, profile isolation and CLI profile commands, concurrent work/personal daemon isolation for sessions and Linear links and cron jobs and local task rows, live-session idle TTL/LRU eviction and bounded shutdown drain, daemon-backed CLI and MCP skill/task/cron/Linear/memory/messaging commands, model-backed MCP session send/fork/search and cron run-now, model-facing Clanky tools, Linear issue creation and outbox logic with mocked fetch, cron idempotency and stale lock recovery, model-backed cron skill expansion plus delivery to an existing session and to a local Linear GraphQL server, hard-kill daemon recovery for interrupted prompts, configured external stdio MCP server loading and tool calls, public task ledger create/list/update routes, model-backed `clanky send --skill` through Pi's faux provider, session JSONL/HTML export, Pi RPC over UDS, MCP stdio including direct `clanky start --mcp`, chat TUI RPC, dashboard rendering with local task rows, cron next-fire countdowns, and WebSocket-backed watch refresh, HTTP auth/status/session/skill/task/Linear/cron/memory/messaging routes, HTTP token rejection, rotation, and alternate token transports, WebSocket events, install template rendering, and messaging foundation/Telegram/Discord/polish coverage (broker streaming, format helpers, allowlists, pairing, mirror, footer, sticker cache, hooks).

## Foreground daemon

```bash
pnpm clanky start --home ./.clanky
pnpm clanky start --home ./.clanky --detach --bind 127.0.0.1:7766
CLANKY_PORT=7766 pnpm clanky start --home ./.clanky --http
pnpm clanky start --home ./.clanky --http 127.0.0.1:7766 --new-token
```

From another terminal:

```bash
pnpm clanky status --home ./.clanky
pnpm clanky profile new --home ./.clanky work
pnpm clanky profile use --home ./.clanky work
pnpm clanky profile list --home ./.clanky
pnpm clanky send --home ./.clanky "Say hello in one sentence."
pnpm clanky send --home ./.clanky --provider anthropic --model claude-opus-4-5 "Say hello."
pnpm clanky session list --home ./.clanky
pnpm clanky session resume --home ./.clanky <id> "Continue that session."
pnpm clanky session fork --home ./.clanky <id>
pnpm clanky session search --home ./.clanky "deployment notes"
pnpm clanky session export --home ./.clanky --html session.html <id>
pnpm clanky send --home ./.clanky --session <id> "Continue that session."
pnpm clanky send --home ./.clanky --skill daily-digest "Summarize recent work."
pnpm clanky skill list --home ./.clanky
pnpm clanky skill usage --home ./.clanky
pnpm clanky skill add --home ./.clanky --description "Use for repo-specific release notes." release-notes
pnpm clanky skill remove --home ./.clanky release-notes
pnpm clanky task add --home ./.clanky --status open --priority high --linear-issue PROJ-123 "Follow up on the release notes"
pnpm clanky task update --home ./.clanky --status done <task-id> "Release notes follow-up complete"
pnpm clanky task list --home ./.clanky --status open --priority high --linear-issue PROJ-123
pnpm clanky linear link --home ./.clanky --session <id> PROJ-123
pnpm clanky linear create --home ./.clanky <team-id> "Follow up on the release notes"
pnpm clanky linear list --home ./.clanky
pnpm clanky linear outbox --home ./.clanky
pnpm clanky linear flush --home ./.clanky
pnpm clanky messaging status --home ./.clanky
pnpm clanky messaging sessions --home ./.clanky --platform telegram
pnpm clanky messaging reset --home ./.clanky --platform telegram --chat <chat-id>
pnpm clanky tui --home ./.clanky
pnpm clanky tui --home ./.clanky --watch
pnpm clanky tui --home ./.clanky --session <id>
pnpm clanky mcp config --home ./.clanky
pnpm --silent clanky mcp --home ./.clanky
pnpm --silent clanky start --home ./.clanky --mcp
pnpm clanky cron add --home ./.clanky "every 1h" "Summarize recent sessions."
pnpm clanky cron add --home ./.clanky --deliver linear:PROJ-123 "every 1h" "Scan recent commits and post a summary."
pnpm clanky cron list --home ./.clanky
pnpm clanky cron run-now --home ./.clanky <job-id>
pnpm clanky install --launchd --home ./.clanky --print
pnpm clanky uninstall --launchd --home ./.clanky --print
pnpm clanky install --systemd --home ./.clanky --print
pnpm clanky stop --home ./.clanky
```

`send` and `cron run-now` require configured Pi model credentials. Session text is indexed into profile-local SQLite FTS at `<home>/profiles/<profile>/index.db`; `clanky session search <query>` also scans persisted JSONL sessions before querying. Cron jobs support `--provider`, `--model`, and `--idempotency-key`, including date tokens like `${YYYYMMDD}`. Idempotency keys are hashed before they are recorded in the profile `index.db` `cron_runs` ledger. Bundled, user, and profile skill directories are watched with `chokidar`; live sessions reload their resource loaders when `SKILL.md` files change.

`clanky linear create` creates a new Linear issue with configured Linear credentials. `clanky linear link` persists profile-local issue links for sessions; `linear:<issue>` cron delivery writes pending updates to the Linear outbox. When `LINEAR_API_KEY` or `LINEAR_ACCESS_TOKEN` is configured, Clanky posts those comments immediately; `clanky linear flush` retries pending comments manually.

## Messaging (Telegram, Discord)

Set `TELEGRAM_BOT_TOKEN` and/or `DISCORD_BOT_TOKEN` before `clanky start` to auto-boot the messaging adapters. Optional environment variables: `MESSAGING_TELEGRAM_ALLOWED_USERS`, `MESSAGING_TELEGRAM_ALLOWED_CHATS`, `MESSAGING_TELEGRAM_REQUIRE_MENTION`, `MESSAGING_DISCORD_ALLOWED_GUILDS`, `MESSAGING_DISCORD_ALLOWED_USERS`, `MESSAGING_DISCORD_COMMAND_SYNC`. Each incoming chat gets its own Pi session keyed by `(platform, chatId, threadId?, userId?)`; the streaming broker subscribes to `text_delta` and forwards chunks through the platform adapter with edit/segment-break semantics ported from hermes's `stream_consumer.py`. Slash commands `/new`, `/reset`, `/stop`, `/abort` reset or interrupt the chat's session. Voice messages on Telegram are downloaded and transcribed through an `AdapterContext.transcribeAudio` callback (wire it to an MCP transcription tool via `MESSAGING_TELEGRAM_TRANSCRIBE=<server>:<tool>`). The `clanky messaging status` CLI reports adapter state; `clanky messaging sessions` lists active chat→session mappings; `clanky messaging reset --platform <p> --chat <id>` clears a mapping.

## Memory

Clanky records source-grounded memory atoms under a privacy gate. Memories carry scope (`user`/`dm`/`guild`/`channel`/`project`/`agent`), sensitivity (`public`/`personal`/`sensitive`/`secret`), confidence, source events, and TTL. Slash commands available in interactive sessions: `/who_are_you`, `/what_do_you_remember`, `/why_did_you_say_that`, `/forget_me`, `/forget_this_channel`, `/memory`, `/memory_export`, `/memory_off`, `/privacy`. Model-facing tools: `memory_remember`, `memory_search`, `memory_forget`. CLI: `clanky memory status|search|remember|forget|export|consent`.

## Daemon, MCP, transports

HTTP mode writes an auth token to `<home>/.token`; pass it as `Authorization: Bearer <token>` or `X-Clanky-Token`. `--http` or `--bind` without a value binds the default profile to `127.0.0.1:7766`; named profiles get deterministic profile-local ports. Set `CLANKY_PORT` or pass `--http <host:port>` to override the derived port. Use `clanky start --new-token --http <host:port>` to rotate it on startup.

MCP clients can either mount `clanky mcp` against an already-running daemon or mount `clanky start --mcp`, which starts a foreground gateway in the same stdio process. `clanky mcp config --home <path>` prints a Claude Code-ready `mcpServers` fragment. For Claude Code, mount a `mcpServers.clanky` entry with command `pnpm`, args `["--silent", "clanky", "mcp", "--home", "/Users/jamesvolpe/.clanky"]`, and cwd `/Users/jamesvolpe/clanky`.

`clanky install` writes the launchd plist or systemd unit and prints the enable command. Add `--enable` only after explicitly approving the user-service enable/start command. `clanky uninstall` disables the matching managed service and removes the plist/unit. Use `--env NAME=value` or `--env-from-current NAME` to give the managed service credentials; `CLANKY_HOME` and `CLANKY_PROFILE` come from `--home` and `--profile`. Profile-managed services use separate names (`com.clanky.daemon.<profile>` and `clanky-<profile>.service`) so `work` and `personal` daemons can be installed side by side.

WebSocket events stream from `/events` with the same token, including session deltas, cron changes, `cron.fired`, and `messaging.{received,sent,error,policy}`; unauthenticated event sockets are rejected. Add `sessionId=<id>` to filter session events while keeping cron/messaging events global. In a real terminal, `clanky tui` renders the dashboard through Pi TUI with local task ledger rows, cron, sessions, and model auth status; numbered persisted session rows can be selected to resume directly into chat.

Configured external stdio MCP servers are loaded from `CLANKY_MCP_SERVERS_JSON`, either as an array of `{ "name": "...", "command": "...", "args": [], "cwd": "...", "env": {} }` or an object keyed by server name. They appear in `clanky status`, the public MCP tools `mcp.list`/`mcp.call`, HTTP `/mcp/servers` and `/mcp/call`, and the model-facing `mcp_call` tool.

Daemon-backed agent sessions expose Clanky tools to the model: `schedule_cron`, `mcp_call`, `linear_create_issue`, `linear_link`, `task_create`, `memory_remember`, `memory_search`, and `memory_forget`. Public MCP tools also accept client-friendly aliases such as `session_id`, `source_session_id`, session search `q`, and cron `job_id`. Interactive sessions also get `/cron`, `/mcp`, `/skills`, `/skill add <name>`, `/memory`, and `/profile` Clanky slash commands; invoke loaded Pi skills with `/skill:<name>`.
