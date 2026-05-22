# Clanky

Always-on agent harness built on Pi, modeled on hermes-agent, and intended to act as a swarm-mcp gateway leader.

The workspace is pnpm-based and runs Clanky as a TypeScript daemon with embedded Pi sessions, profile-local state, cron, MCP/HTTP/UDS gateways, swarm hooks, and Linear outbox delivery. `pnpm-workspace.yaml` also delays newly published packages for 24 hours, enforces peer dependencies, verifies package store integrity, and allows dependency install scripts only for explicitly listed packages.

```bash
pnpm install
pnpm smoke
```

`pnpm smoke` covers local, non-paid behavior: pnpm-only package-manager guardrails, daemon boot, detached daemon start/stop, profile isolation and CLI profile commands, concurrent work/personal daemon isolation for sessions, Linear links, cron jobs, and local task rows, live-session idle TTL/LRU eviction and bounded shutdown drain, daemon-backed CLI and MCP skill/task/cron/Linear commands, model-backed MCP session send/fork/search and cron run-now, model-facing Clanky tools, gateway auto-loading of the bundled `swarm-leader` skill, swarm snapshot injection, task custom entries, write/edit swarm file-lock hook behavior, skill loading, Linear issue creation and outbox logic with mocked fetch, cron idempotency and stale lock recovery, model-backed cron skill expansion plus delivery to an existing session and to a local Linear GraphQL server, hard-kill daemon recovery for interrupted prompts, swarm leader lifecycle/idempotent dispatch/message/complete/file-lock behavior through a faux stdio MCP server, addressed swarm activity messages routed into durable session context, configured external stdio MCP server loading and tool calls, public Clanky MCP and HTTP swarm status/peers/tasks/snapshot/message/dispatch/complete/file-lock calls against that faux swarm server, public task ledger create/list/update routes, model-backed `clanky send --skill` through Pi's faux provider, session JSONL/HTML export, Pi RPC over UDS, MCP stdio including direct `clanky start --mcp`, chat TUI RPC, dashboard rendering with local task rows, cron next-fire countdowns, active swarm peer/task rows, and WebSocket-backed watch refresh, HTTP auth/status/session/skill/task/Linear/cron routes, HTTP token rejection, rotation, and alternate token transports, WebSocket events, model/Linear/swarm/launchd doctor preflights, and install template rendering. Live evidence has also verified the direct real `swarm_mcp` gate against `~/.clanky` with herdr worker spawn/claim/complete and the mounted Claude Code MCP `swarm.dispatch` path, while earlier temporary live preflights verified real `swarm-mcp` plus herdr worker spawning through CLI and public MCP paths, including daemon SIGKILL/restart idempotency. The remaining v1 gates need machine-service approval, real credentials/tooling, or persisted/default swarm service env:

```bash
pnpm clanky doctor --home ~/.clanky
pnpm --silent clanky doctor --home ~/.clanky --json

# launchd restart gate on macOS; dry-run without secret env values
export CLANKY_NODE="${CLANKY_NODE:-/Users/jamesvolpe/.n/bin/node}"
pnpm clanky install --launchd --home ~/.clanky \
  --env CLANKY_SWARM_ENABLED=1 \
  --env "CLANKY_SWARM_COMMAND=${CLANKY_NODE}" \
  --env 'CLANKY_SWARM_ARGS_JSON=["/Users/jamesvolpe/web/swarm-mcp/dist/index.js"]' \
  --print

# after explicit approval to bootstrap com.clanky.daemon
export LINEAR_API_KEY="..."
pnpm clanky install --launchd --home ~/.clanky \
  --env CLANKY_SWARM_ENABLED=1 \
  --env "CLANKY_SWARM_COMMAND=${CLANKY_NODE}" \
  --env 'CLANKY_SWARM_ARGS_JSON=["/Users/jamesvolpe/web/swarm-mcp/dist/index.js"]' \
  --env-from-current LINEAR_API_KEY \
  --enable
launchctl print gui/$(id -u)/com.clanky.daemon
launchctl kill SIGKILL gui/$(id -u)/com.clanky.daemon
pnpm clanky status --home ~/.clanky
# log out and back in, then rerun launchctl print and status
launchctl print gui/$(id -u)/com.clanky.daemon
pnpm clanky status --home ~/.clanky
pnpm clanky uninstall --launchd --home ~/.clanky

# model-backed send and TUI resume
pnpm clanky send --home ~/.clanky "what's on the calendar"
pnpm clanky session list --home ~/.clanky
pnpm clanky session search --home ~/.clanky "calendar"
pnpm clanky session export --home ~/.clanky --output /tmp/clanky-calendar-session.jsonl <session-id>
pnpm clanky session export --home ~/.clanky --html /tmp/clanky-calendar-session.html <session-id>
pnpm clanky tui --home ~/.clanky --session <id>

# unattended Linear delivery
pnpm clanky doctor --home ~/.clanky
pnpm clanky cron add --home ~/.clanky --deliver linear:PROJ-123 "every 1h" "scan recent commits and post a summary to Linear PROJ-123"
pnpm clanky cron run-now --home ~/.clanky <job-id>
pnpm clanky linear outbox --home ~/.clanky
pnpm clanky linear flush --home ~/.clanky
# leave the job enabled through its next natural hourly fire, then rerun:
pnpm clanky cron list --home ~/.clanky
pnpm clanky linear outbox --home ~/.clanky
pnpm clanky cron rm --home ~/.clanky <job-id>

# direct real swarm/herdr gate; already captured, rerun only when revalidating
export CLANKY_NODE="${CLANKY_NODE:-/Users/jamesvolpe/.n/bin/node}"
CLANKY_SWARM_ENABLED=1 CLANKY_SWARM_COMMAND="${CLANKY_NODE}" CLANKY_SWARM_ARGS_JSON='["/Users/jamesvolpe/web/swarm-mcp/dist/index.js"]' HERDR_PANE_ID="$HERDR_PANE_ID" HERDR_SOCKET_PATH="$HERDR_SOCKET_PATH" pnpm clanky start --home ~/.clanky
pnpm clanky status --home ~/.clanky
pnpm clanky swarm status --home ~/.clanky
pnpm clanky swarm snapshot --home ~/.clanky
pnpm clanky swarm dispatch --home ~/.clanky --type implement --file README.md "real swarm live gate smoke"
pnpm clanky swarm tasks --home ~/.clanky

# Claude Code MCP mounted-client gate; already captured, rerun only when revalidating
pnpm clanky mcp config --home ~/.clanky
pnpm --silent clanky mcp --home ~/.clanky
pnpm --silent clanky start --home ~/.clanky --mcp
pnpm clanky stop --home ~/.clanky

# profile-daemon isolation after explicit bootstrap approval, using one home with separate profiles
pnpm clanky install --launchd --profile work --home ~/.clanky --enable
pnpm clanky install --launchd --profile personal --home ~/.clanky --enable
pnpm clanky task add --home ~/.clanky --profile work "work profile daemon smoke"
pnpm clanky task add --home ~/.clanky --profile personal "personal profile daemon smoke"
pnpm clanky task list --home ~/.clanky --profile work
pnpm clanky task list --home ~/.clanky --profile personal
pnpm clanky uninstall --launchd --profile work --home ~/.clanky
pnpm clanky uninstall --launchd --profile personal --home ~/.clanky
```

See `docs/live-gates.md` for the approval-safe runbook, expected evidence, waiver format, and cleanup commands for each remaining gate.

Run the foreground daemon locally:

```bash
pnpm clanky start --home ./.clanky
pnpm clanky start --home ./.clanky --detach --bind 127.0.0.1:7766
CLANKY_PORT=7766 pnpm clanky start --home ./.clanky --http
pnpm clanky start --home ./.clanky --http 127.0.0.1:7766 --new-token
```

From another terminal:

```bash
pnpm clanky status --home ./.clanky
pnpm clanky status --home ./.clanky --http 127.0.0.1:7766
pnpm clanky profile new --home ./.clanky work
pnpm clanky profile use --home ./.clanky work
pnpm clanky profile list --home ./.clanky
pnpm clanky send --home ./.clanky "Say hello in one sentence."
pnpm clanky send --home ./.clanky --http 127.0.0.1:7766 "Say hello over HTTP."
pnpm clanky send --home ./.clanky --provider anthropic --model claude-opus-4-5 "Say hello in one sentence."
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
pnpm clanky tui --home ./.clanky
# in the dashboard, press `a` to store or remove profile-local OpenAI auth
pnpm clanky tui --home ./.clanky --watch
pnpm clanky tui --home ./.clanky --watch --http 127.0.0.1:7766
pnpm clanky tui --home ./.clanky --session <id>
pnpm clanky tui --home ./.clanky --session <id> --http 127.0.0.1:7766
pnpm clanky swarm status --home ./.clanky
pnpm clanky swarm peers --home ./.clanky
pnpm clanky swarm tasks --home ./.clanky
pnpm clanky swarm snapshot --home ./.clanky
pnpm clanky swarm lock --home ./.clanky README.md
pnpm clanky swarm message --home ./.clanky <peer-id> "Cron summary is ready."
pnpm clanky swarm complete --home ./.clanky <task-id> --description "Implemented the requested change." --file README.md
pnpm clanky swarm dispatch --home ./.clanky --type implement --provider anthropic --model claude-opus-4-5 --file README.md "Update the README"
pnpm clanky swarm dispatch --home ./.clanky --type implement --no-spawn "Record a task without spawning a worker"
pnpm clanky mcp config --home ./.clanky
pnpm --silent clanky mcp --home ./.clanky
pnpm --silent clanky start --home ./.clanky --mcp
pnpm clanky memory status --home ./.clanky
pnpm clanky memory remember --home ./.clanky "Project prefers source-grounded implementation notes."
pnpm clanky memory search --home ./.clanky "source-grounded"
pnpm clanky memory export --home ./.clanky
pnpm clanky cron add --home ./.clanky "every 1h" "Summarize recent sessions."
pnpm clanky cron add --home ./.clanky --provider anthropic --model claude-opus-4-5 "every 1h" "Summarize recent sessions."
pnpm clanky cron add --home ./.clanky --deliver swarm:<peer-id> "every 1h" "Summarize recent sessions for a peer."
pnpm clanky cron list --home ./.clanky
pnpm clanky cron run-now --home ./.clanky <job-id>
pnpm clanky install --launchd --home ./.clanky --print
pnpm clanky uninstall --launchd --home ./.clanky --print
pnpm clanky install --systemd --home ./.clanky --print
pnpm clanky stop --home ./.clanky
```

`send` and `cron run-now` require configured Pi model credentials. OpenAI auth can be configured from the TUI dashboard; press `a` in `clanky tui` to store or remove the selected profile's OpenAI API key without echoing it.
`clanky doctor` reports whether any Pi model credentials are available without printing secret values and includes `live_gate_*` summary lines for launchd, model/calendar, Linear cron, swarm MCP, Claude Code MCP, and profile-daemon gates. Use `--json` for automation; when invoking through a package script, use `pnpm --silent` so stdout is parseable JSON. JSON mode also includes a stable `warnings` array, a grouped `live_gates` object, a grouped `live_gate_blockers` object containing only gates not in a ready state, and split path probe keys such as `launchd_plist_path` / `launchd_plist_state`, `profile_daemon_work_plist_path` / `profile_daemon_work_plist_state`, and `profile_daemon_personal_plist_path` / `profile_daemon_personal_plist_state`. It inspects `CLANKY_MCP_SERVERS_JSON` for calendar-looking MCP tooling and scans Claude Code's local MCP config, reporting `claude_code_mcp_mount: mounted` when a Clanky MCP server is configured.
Session text is indexed into profile-local SQLite FTS at `<home>/profiles/<profile>/index.db`; `clanky session search <query>` also scans persisted JSONL sessions before querying.
Profile memory is stored under `<home>/profiles/<profile>/memory` with atoms, source events, consent state, and `SELF.md` backed by the profile SQLite database. `clanky memory status|search|remember|forget|export|consent` mirrors the daemon memory API; personal memories require confirmation, channel/server memories require opt-in consent, and sensitive data or credentials are rejected. In chat, `/who_are_you`, `/what_do_you_remember`, `/why_did_you_say_that`, `/forget_me`, `/forget_this_channel`, `/memory_export`, `/memory_off`, `/privacy`, and `/memory` expose the same auditable memory surface.
Cron jobs support `--provider`, `--model`, and `--idempotency-key`, including date tokens like `${YYYYMMDD}`. Idempotency keys are hashed before they are recorded in the profile `index.db` `cron_runs` ledger. Human-edited `cron/jobs.json` files can use the documented snake_case fields `timeout_seconds` and `idempotency_key`; Clanky normalizes them to its internal camelCase job shape when reading.
Missed cron fires are checked immediately when the daemon starts, then every 60 seconds.
Bundled, user, and profile skill directories are watched with `chokidar`; live sessions reload their resource loaders when `SKILL.md` files change.
Cron skill runs update `<home>/profiles/<profile>/skills/.usage.json`; inspect it with `clanky skill usage`.
The local task ledger lives in profile `index.db`. Agents can write it with `task_create`; humans and MCP/HTTP clients can create, update, and filter tasks by status, priority, session, and Linear issue with `clanky task add|update|list`, `task.add|task.update|task.list`, and `/tasks`.
HTTP mode writes an auth token to `<home>/.token`; pass it as `Authorization: Bearer <token>` or `X-Clanky-Token`. `--http` or `--bind` without a value binds the default profile to `127.0.0.1:7766`; named profiles get deterministic profile-local ports so profile daemons can run side by side. Set `CLANKY_PORT` or pass `--http <host:port>` to override the derived port. Use `clanky start --new-token --http <host:port>` to rotate it on startup.
MCP clients can either mount `clanky mcp` against an already-running daemon or mount `clanky start --mcp`, which starts a foreground gateway in the same stdio process. `clanky mcp config --home <path>` prints a Claude Code-ready `mcpServers` fragment for the selected home/profile. For Claude Code, mount a `mcpServers.clanky` entry with command `pnpm`, args `["--silent", "clanky", "mcp", "--home", "/Users/jamesvolpe/.clanky"]`, and cwd `/Users/jamesvolpe/clanky`.
`clanky install` writes the launchd plist or systemd unit and prints the enable command. Add `--enable` only after explicitly approving the user-service enable/start command. `clanky uninstall` disables the matching managed service and removes the plist/unit. Use `--env NAME=value` or `--env-from-current NAME` to give the managed service credentials and swarm settings; `CLANKY_HOME` and `CLANKY_PROFILE` come from `--home` and `--profile`. Avoid `--print` with secret environment values unless you intend to inspect the rendered plist/unit.
Profile-managed services use separate names (`com.clanky.daemon.<profile>` and `clanky-<profile>.service`) so `work` and `personal` daemons can be installed side by side.
WebSocket events stream from `/events` with the same token, including session deltas, cron changes, `cron.fired`, swarm activity, `swarm.task_changed`, and `swarm.message`; unauthenticated event sockets are rejected. Add `sessionId=<id>` to filter session events while keeping cron/swarm events global. In a real terminal, `clanky tui` renders the dashboard through Pi TUI with local task ledger rows, cron, model auth status, sessions, swarm peers/tasks, and lock state; press `a` to store or remove OpenAI auth in `<home>/profiles/<profile>/auth.json`, and numbered persisted session rows can be selected to resume directly into chat. If no daemon is running, an interactive terminal is offered a temporary daemon start while noninteractive output prints the `clanky start` guidance and exits. When accepted, the temporary daemon is closed after the TUI exits. When stdout is piped, it prints the same dashboard text for scripts and tests. `clanky tui --watch --http <host:port>` uses the event stream for live dashboard refreshes.
The Unix socket accepts both Clanky gateway requests and persistent Pi-style JSONL RPC commands such as `get_state`, `get_messages`, `prompt`, `abort`, and model/session state operations. Chat TUI sessions attach through that persistent UDS RPC stream.
Prompt sends and cron runs write a pending prompt checkpoint before entering the model call. If the daemon is killed before Pi writes the first assistant message, the next daemon boot promotes that checkpoint into valid Pi JSONL so the session list, search index, and resume path remain usable.
Configured external stdio MCP servers are loaded from `CLANKY_MCP_SERVERS_JSON`, either as an array of `{ "name": "...", "command": "...", "args": [], "cwd": "...", "env": {} }` or an object keyed by server name. They appear in `clanky status`, the public MCP tools `mcp.list`/`mcp.call`, HTTP `/mcp/servers` and `/mcp/call`, and the model-facing `mcp_call` tool.
`clanky status` includes swarm peer/task counts when swarm is booted. `clanky swarm status` reports the leader state and any herdr workspace handle, `clanky swarm lock <path>` reads active file locks, `clanky swarm message <peer-id> <message>` sends durable peer messages, `clanky swarm complete <task-id>` completes claimed tasks with structured handoff details, and `clanky swarm dispatch` routes gateway handoff requests to a booted `swarm-mcp` subprocess. Dispatch can carry `--provider` and `--model` into the worker instructions for per-task model selection. Dispatch output includes `dispatch_status` from `swarm-mcp`; for example, `--no-spawn` with no live worker reports `no_worker`. `--no-spawn` records an open, claimable task without placing a worker; completing it still requires a claimed task, and spawned/claimed handoff is the resumable path across daemon restarts. Swarm boot is disabled by default; set `CLANKY_SWARM_ENABLED=1`, `CLANKY_SWARM_COMMAND`, and optional JSON string array `CLANKY_SWARM_ARGS_JSON` to opt in. Use an absolute executable path for launchd services, and make sure it is the Node binary compatible with the installed `swarm-mcp` native dependencies; on this machine the captured real-swarm evidence used `CLANKY_SWARM_COMMAND=/Users/jamesvolpe/.n/bin/node`. `clanky doctor` reports `swarm_args_json: invalid` and blocks the swarm live gate if that value is malformed. If `HERDR_PANE_ID` is set, Clanky publishes `identity/workspace/herdr/<instance-id>` into swarm KV with the pane handle and optional `HERDR_SOCKET_PATH`; the legacy `HERDR_SOCKET` alias is also accepted, but `HERDR_SOCKET_PATH` wins when both are set, and doctor reports `herdr_context` plus whether the selected socket path exists. Clanky also forwards herdr and swarm harness environment such as `HERDR_SOCKET_PATH`, `SWARM_HERDR_PARENT_PANE`, and `SWARM_WORKER_HARNESS` into the `swarm-mcp` child process so real spawned workers inherit the placement context.
When swarm activity reports KV or instance changes, a gateway leader with `role:planner` repairs a missing `owner/planner` KV row so planner duties are re-elected after stale ownership is cleared.
`swarm:<peer-id>` cron delivery sends a durable swarm message through `prompt_peer`.
`clanky linear create` creates a new Linear issue with configured Linear credentials. `clanky linear link` persists profile-local issue links for sessions and swarm tasks; `linear:<issue>` cron delivery and completed linked swarm tasks write pending updates to the Linear outbox. Completed swarm activity also appends a durable `clanky.swarm_completion` entry to linked sessions so originators can see the handoff when they resume. If a Linear-linked swarm completion omits both `tracker_update` and `tracker_update_skipped`, Clanky records an explicit tracker skip before mirroring it. When `LINEAR_API_KEY` or `LINEAR_ACCESS_TOKEN` is configured, Clanky posts those comments immediately; `clanky linear flush` retries pending comments manually.
Daemon-backed agent sessions expose Clanky tools to the model: `schedule_cron`, `swarm_dispatch`, `swarm_status`, `swarm_file_lock`, `swarm_message`, `swarm_complete`, `mcp_call`, `linear_create_issue`, `linear_link`, `task_create`, `memory_remember`, `memory_search`, and `memory_forget`. Model-facing tools accept the plan's snake_case aliases where applicable: `timeout_seconds`, `idempotency_key`, `wait_for_completion`, `linear_issue`, `task_id`, `files_changed`, `tracker_update`, `tracker_update_skipped`, `team_id`, `assignee_id`, `project_id`, `state_id`, `label_ids`, `issue_id`, and `session_id`. Public MCP tools also accept client-friendly aliases such as `session_id`, `source_session_id`, session search `q`, cron `job_id`, and swarm file-lock `path`. Interactive sessions also get `/swarm`, `/cron`, `/mcp`, `/skills`, `/skill add <name>`, `/memory`, and `/profile` Clanky slash commands; invoke loaded Pi skills with `/skill:<name>`. Gateway sessions auto-load the bundled `swarm-leader` skill body, inject a hidden swarm snapshot message and hidden memory packet before relevant agent turns, and append custom task entries for touched swarm task IDs. When swarm is booted, Pi `write` and `edit` calls are blocked if another swarm peer holds the file lock.
