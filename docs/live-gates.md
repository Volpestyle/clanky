# Clanky Live Gates

These gates require user approval, local credentials/tooling, a real client mount, or persisted swarm service environment. Run the non-mutating preflight first and do not bootstrap launchd until the user explicitly approves it.

```bash
cd /Users/jamesvolpe/clanky
pnpm clanky doctor --home ~/.clanky
pnpm --silent clanky doctor --home ~/.clanky --json
```

Use `--json` when a script needs stable key/value gate states instead of terminal text. When invoking through pnpm, include `--silent` so stdout is parseable JSON. JSON mode includes a stable `warnings` array, a grouped `live_gates` object, a grouped `live_gate_blockers` object containing only gates not in a ready state, and split path probe keys such as `launchd_plist_path` / `launchd_plist_state` and `swarm_mcp_dist_path` / `swarm_mcp_dist_state`.

Current expected blockers on an unconfigured machine:

- `launchd_service: missing`
- `launchd_plist: /Users/<you>/Library/LaunchAgents/com.clanky.daemon.plist	missing`
- `model_credentials: missing`
- `model_available_models: 0`
- `calendar_tooling: missing`
- `linear_credentials: missing`
- `swarm_enabled: false`
- `swarm_command: missing`
- `swarm_args_json: missing`
- `claude_code_mcp_mount: missing`
- `profile_daemon_work: missing`
- `profile_daemon_work_label: com.clanky.daemon.work`
- `profile_daemon_work_plist_path: /Users/<you>/Library/LaunchAgents/com.clanky.daemon.work.plist`
- `profile_daemon_work_plist_state: missing`
- `profile_daemon_personal: missing`
- `profile_daemon_personal_label: com.clanky.daemon.personal`
- `profile_daemon_personal_plist_path: /Users/<you>/Library/LaunchAgents/com.clanky.daemon.personal.plist`
- `profile_daemon_personal_plist_state: missing`
- `herdr_socket_file: present` when the configured herdr socket path exists
- `herdr_socket_file: missing` if `HERDR_SOCKET_PATH` / `HERDR_SOCKET` points at a missing path
- `herdr_context: missing_pane` when `HERDR_PANE_ID` is not set
- `herdr_context: missing_socket` when `HERDR_PANE_ID` is set but no herdr socket path is configured
- `herdr_context: ready_preflight` when `HERDR_PANE_ID` is set and the herdr socket path exists
- `herdr_context: blocked_socket_missing` if `HERDR_SOCKET_PATH` / `HERDR_SOCKET` points at a missing path
- `live_gate_launchd_restart: approval_required`
- `live_gate_launchd_restart: installed` after the default launchd service is loaded
- `live_gate_launchd_restart: not_applicable` on non-launchd platforms
- `live_gate_model_calendar: blocked_model_credentials`
- `live_gate_model_calendar: blocked_calendar_config` if `CLANKY_MCP_SERVERS_JSON` is invalid
- `live_gate_model_calendar: requires_calendar_tooling` after model credentials are configured but calendar tooling is missing
- `live_gate_model_calendar: ready_preflight` after model credentials and calendar MCP tooling are configured
- `live_gate_linear_cron: blocked_credentials`
- `live_gate_linear_cron: ready_credentials` after Linear credentials are configured
- `live_gate_swarm_mcp: disabled`
- `live_gate_swarm_mcp: blocked_command_missing` if swarm is enabled without `CLANKY_SWARM_COMMAND`
- `live_gate_swarm_mcp: blocked_command_not_found` if `CLANKY_SWARM_COMMAND` cannot be found or executed
- `live_gate_swarm_mcp: blocked_args_config` if `CLANKY_SWARM_ARGS_JSON` is set but is not a JSON string array
- `live_gate_swarm_mcp: ready_preflight` when swarm is enabled and the command/args preflight is valid
- `live_gate_claude_code_mcp: requires_client_mount`
- `live_gate_claude_code_mcp: mounted` after a Claude Code MCP client config includes Clanky
- `live_gate_profile_daemons: approval_required`
- `live_gate_profile_daemons: installed` after the `work` and `personal` launchd profile services are both loaded
- `live_gate_profile_daemons: not_applicable` on non-launchd platforms

Current audit note: the direct `swarm_mcp` live gate and mounted Claude Code MCP dispatch path have been captured against `~/.clanky` with real `swarm-mcp` and herdr worker completion. The default doctor output still reports `swarm_mcp: disabled` unless those swarm environment variables are supplied to the current process or a managed service.

If launchd is the only gate you want to run next, ask for approval once: `Approve bootstrapping com.clanky.daemon?`

## Waiving A Gate

A live gate is waived only when the user explicitly names the gate and accepts the remaining risk. Record the waiver before treating v1 as complete:

```text
Waive live gate: <gate-name>
Reason: <why this gate is not being run>
Residual risk: <what remains unverified>
Approved by: <user>
Date: <YYYY-MM-DD>
```

Valid gate names are `launchd_restart`, `model_calendar`, `linear_cron`, `swarm_mcp`, `claude_code_mcp`, and `profile_daemons`.

## Current Gate Manifest

Use this as the checklist for the next live run. Do not mark a gate passed from a `ready_*` doctor state alone; the live evidence column must be captured, or the gate must be explicitly waived. The direct `swarm_mcp` and `claude_code_mcp` rows have current audit evidence, but remain useful as revalidation runbooks.

| Gate | Current unconfigured state | Required live evidence | Cleanup |
|---|---|---|---|
| `launchd_restart` | `approval_required` | default launchd service loaded, daemon restarts after `launchctl kill SIGKILL`, survives logout/login, status reports `running: true` | `pnpm clanky uninstall --launchd --home ~/.clanky` |
| `model_calendar` | `blocked_model_credentials` | doctor reports model credentials and calendar tooling configured, live calendar answer returned, session search/export/TUI resume all show the answer | remove `/tmp/clanky-calendar-session.jsonl` and `/tmp/clanky-calendar-session.html` if created |
| `linear_cron` | `blocked_credentials` | Linear receives both deterministic `cron run-now` comment and natural hourly scheduled comment | `pnpm clanky cron rm --home ~/.clanky <job-id>` |
| `swarm_mcp` | `disabled` by default; current audit evidence captured | real swarm leader boots, status/snapshot show herdr workspace and planner ownership, dispatch spawns/claims/completes through herdr | `pnpm clanky stop --home ~/.clanky` |
| `claude_code_mcp` | `requires_client_mount` on an unmounted machine; current audit evidence captured | Claude Code config mounts Clanky, doctor reports `mounted`, MCP client lists Clanky tools, `clanky.swarm.dispatch` works through the mounted client | remove or keep the client mount intentionally; stop any foreground daemon |
| `profile_daemons` | `approval_required` | work and personal launchd services loaded, both statuses running, task rows remain profile-isolated | uninstall both profile services |

## 1. Launchd Restart Gate

Requires approval to bootstrap `com.clanky.daemon`.

Dry-run the service file first without secret environment values:

```bash
export CLANKY_NODE="${CLANKY_NODE:-/Users/jamesvolpe/.n/bin/node}"
pnpm clanky install --launchd --home ~/.clanky \
  --env CLANKY_SWARM_ENABLED=1 \
  --env "CLANKY_SWARM_COMMAND=${CLANKY_NODE}" \
  --env 'CLANKY_SWARM_ARGS_JSON=["/Users/jamesvolpe/web/swarm-mcp/dist/index.js"]' \
  --print
```

After approval, enable it:

```bash
pnpm clanky install --launchd --home ~/.clanky \
  --env CLANKY_SWARM_ENABLED=1 \
  --env "CLANKY_SWARM_COMMAND=${CLANKY_NODE}" \
  --env 'CLANKY_SWARM_ARGS_JSON=["/Users/jamesvolpe/web/swarm-mcp/dist/index.js"]' \
  --enable
launchctl print gui/$(id -u)/com.clanky.daemon
launchctl kill SIGKILL gui/$(id -u)/com.clanky.daemon
pnpm clanky status --home ~/.clanky
# For logout survival, log out and back in, then rerun:
launchctl print gui/$(id -u)/com.clanky.daemon
pnpm clanky status --home ~/.clanky
pnpm clanky uninstall --launchd --home ~/.clanky
```

Evidence to capture:

- doctor reports whether the launchd plist is `present` or `missing`
- launchd reports `com.clanky.daemon` loaded
- daemon restarts after `launchctl kill SIGKILL`
- after logout/login, launchd still reports `com.clanky.daemon` loaded
- after logout/login, `pnpm clanky status --home ~/.clanky` reports `running: true`
- `pnpm clanky status --home ~/.clanky` reports `running: true`
- cleanup removes the service

## 2. Model And Calendar Gate

Requires configured Pi model credentials and calendar tooling in the selected profile.
If `CLANKY_MCP_SERVERS_JSON` is malformed, `doctor` should report `calendar_tooling_error` and `live_gate_model_calendar: blocked_calendar_config`.
If model credentials are configured but calendar tooling is not, `doctor` should report `live_gate_model_calendar: requires_calendar_tooling`.
If both model credentials and calendar MCP tooling are configured, `doctor` should report `live_gate_model_calendar: ready_preflight`; the gate still passes only after the live send returns a calendar-backed answer.

```bash
pnpm clanky doctor --home ~/.clanky
pnpm clanky send --home ~/.clanky "what's on the calendar"
pnpm clanky session list --home ~/.clanky
pnpm clanky session search --home ~/.clanky "calendar"
pnpm clanky session export --home ~/.clanky --output /tmp/clanky-calendar-session.jsonl <session-id>
pnpm clanky session export --home ~/.clanky --html /tmp/clanky-calendar-session.html <session-id>
pnpm clanky tui --home ~/.clanky --session <session-id>
```

Evidence to capture:

- doctor reports `model_credentials: set`
- doctor reports `calendar_tooling: configured`
- if doctor reports `live_gate_model_calendar: blocked_calendar_config`, fix `CLANKY_MCP_SERVERS_JSON`
- if doctor reports `live_gate_model_calendar: requires_calendar_tooling`, configure the calendar tool before treating the gate as passed
- if doctor reports `live_gate_model_calendar: ready_preflight`, run the live send before treating the gate as passed
- send returns a calendar-backed answer
- session list includes the new session
- session search finds the calendar-backed answer
- JSONL and HTML exports contain the calendar-backed answer
- TUI resumes that session

## 3. Linear Cron Gate

Requires `LINEAR_API_KEY` or `LINEAR_ACCESS_TOKEN` and a real issue such as `PROJ-123`.

```bash
export LINEAR_API_KEY="..."
pnpm clanky doctor --home ~/.clanky
pnpm clanky cron add --home ~/.clanky --deliver linear:PROJ-123 "every 1h" "scan recent commits and post a summary to Linear PROJ-123"
pnpm clanky cron run-now --home ~/.clanky <job-id>
pnpm clanky linear outbox --home ~/.clanky
pnpm clanky linear flush --home ~/.clanky
pnpm clanky cron list --home ~/.clanky
# To satisfy the unattended gate, leave the job enabled through its next natural hourly fire,
# then rerun:
pnpm clanky cron list --home ~/.clanky
pnpm clanky linear outbox --home ~/.clanky
pnpm clanky cron rm --home ~/.clanky <job-id>
```

Evidence to capture:

- doctor reports `live_gate_linear_cron: ready_credentials`
- deterministic `cron run-now` completes successfully
- Linear receives the run-now comment
- outbox entry is posted or flushed
- after the next natural hourly fire, cron history/status shows another successful run
- Linear receives the unattended scheduled comment
- cleanup removes the cron job

## 4. Swarm MCP Gate

Requires real `swarm-mcp` and herdr. This gate can be run without a Claude Code client mount; it proves Clanky can boot the real swarm leader and dispatch through herdr from the direct CLI/gateway path.

Start Clanky with real swarm enabled:

```bash
CLANKY_SWARM_ENABLED=1 \
CLANKY_SWARM_COMMAND="${CLANKY_NODE:-/Users/jamesvolpe/.n/bin/node}" \
CLANKY_SWARM_ARGS_JSON='["/Users/jamesvolpe/web/swarm-mcp/dist/index.js"]' \
HERDR_PANE_ID="$HERDR_PANE_ID" \
HERDR_SOCKET_PATH="$HERDR_SOCKET_PATH" \
pnpm clanky start --home ~/.clanky
```

`CLANKY_SWARM_COMMAND` must point at the Node binary compatible with the installed `swarm-mcp` native dependencies. If swarm boot fails with `MCP error -32000: Connection closed`, run the server command directly and check for a native module version mismatch before retrying.

In another terminal, verify the booted swarm leader before dispatching:

```bash
pnpm clanky status --home ~/.clanky
pnpm clanky swarm status --home ~/.clanky
pnpm clanky swarm snapshot --home ~/.clanky
```

If doctor reports `live_gate_swarm_mcp: blocked_command_missing`, set `CLANKY_SWARM_COMMAND`.
If doctor reports `live_gate_swarm_mcp: blocked_command_not_found`, set `CLANKY_SWARM_COMMAND` to an executable path.
If doctor reports `swarm_args_json: invalid`, fix `CLANKY_SWARM_ARGS_JSON` before starting the live gate.
If doctor reports `herdr_context: missing_pane`, run the gate from a herdr pane so `HERDR_PANE_ID` is set.
If doctor reports `herdr_context: missing_socket`, export `HERDR_SOCKET_PATH` before dispatching.
If both `HERDR_SOCKET_PATH` and legacy `HERDR_SOCKET` are set, Clanky uses `HERDR_SOCKET_PATH`.
If doctor reports `herdr_socket_file: missing` or `herdr_context: blocked_socket_missing`, restart herdr or correct `HERDR_SOCKET_PATH` before dispatching.

Dispatch through the direct CLI path:

```bash
pnpm clanky swarm dispatch --home ~/.clanky --type implement --file README.md "real swarm live gate smoke"
pnpm clanky swarm tasks --home ~/.clanky
```

Evidence to capture:

- doctor reports `live_gate_swarm_mcp: ready_preflight` before the foreground daemon starts
- `clanky status` reports `swarm_state: booted`
- `clanky swarm status` reports the herdr workspace handle
- `clanky swarm snapshot` reports planner ownership for the gateway
- `clanky swarm dispatch` spawns a herdr worker pane
- worker registers, claims, and completes the task
- `clanky swarm tasks` shows the task in a terminal state
- cleanup stops the foreground Clanky daemon with Ctrl-C or `pnpm clanky stop --home ~/.clanky`

## 5. Claude Code MCP Mount Gate

Requires a Claude Code MCP client mount. Current audit evidence has been captured on this machine; rerun this section only when revalidating the mounted-client path. Run this after or alongside a booted Swarm MCP gate if validating `clanky.swarm.dispatch`; Linear credentials are required only if the mounted-client flow must mirror completion to a real Linear issue.

Mount one of these from the MCP client:

```bash
pnpm clanky mcp config --home ~/.clanky
pnpm --silent clanky mcp --home ~/.clanky
pnpm --silent clanky start --home ~/.clanky --mcp
```

`clanky mcp config` prints a Claude Code-ready fragment for the selected home/profile. For Claude Code, a minimal config fragment is:

```json
{
  "mcpServers": {
    "clanky": {
      "command": "pnpm",
      "args": ["--silent", "clanky", "mcp", "--home", "/Users/jamesvolpe/.clanky"],
      "cwd": "/Users/jamesvolpe/clanky"
    }
  }
}
```

Clanky registers the public MCP tool as `swarm.dispatch`; Claude Code may display it with the mounted server prefix as `clanky.swarm.dispatch`.

After mounting, rerun doctor. It should report:

- `claude_code_mcp_mount: mounted`
- `live_gate_claude_code_mcp: mounted`

Evidence to capture:

- MCP client lists Clanky tools
- public `swarm.dispatch` (shown as `clanky.swarm.dispatch` under a `clanky` mount) spawns a herdr worker pane
- worker registers, claims, and completes the task
- Clanky mirrors completion to Linear or records `tracker_update_skipped`
- originating session receives completion context
- cleanup stops the foreground Clanky daemon with Ctrl-C or `pnpm clanky stop --home ~/.clanky`

## 6. Concurrent Launchd Profile Gate

Optional live evidence for profile-isolated managed daemons. Use one Clanky home so the gate exercises
`~/.clanky/profiles/work` and `~/.clanky/profiles/personal`, matching the v1 profile model.

```bash
pnpm clanky install --launchd --profile work --home ~/.clanky --print
pnpm clanky install --launchd --profile personal --home ~/.clanky --print
```

After approval, rerun with `--enable`, then verify:

```bash
pnpm clanky install --launchd --profile work --home ~/.clanky --enable
pnpm clanky install --launchd --profile personal --home ~/.clanky --enable
launchctl print gui/$(id -u)/com.clanky.daemon.work
launchctl print gui/$(id -u)/com.clanky.daemon.personal
pnpm clanky status --home ~/.clanky --profile work
pnpm clanky status --home ~/.clanky --profile personal
pnpm clanky task add --home ~/.clanky --profile work "work profile daemon smoke"
pnpm clanky task add --home ~/.clanky --profile personal "personal profile daemon smoke"
pnpm clanky task list --home ~/.clanky --profile work
pnpm clanky task list --home ~/.clanky --profile personal
pnpm clanky uninstall --launchd --profile work --home ~/.clanky
pnpm clanky uninstall --launchd --profile personal --home ~/.clanky
```

- `pnpm clanky doctor --home ~/.clanky` reports `profile_daemon_work: installed`
- `pnpm --silent clanky doctor --home ~/.clanky --json` reports `profile_daemon_work_plist_path` and `profile_daemon_work_plist_state`
- `pnpm clanky doctor --home ~/.clanky` reports `profile_daemon_personal: installed`
- `pnpm --silent clanky doctor --home ~/.clanky --json` reports `profile_daemon_personal_plist_path` and `profile_daemon_personal_plist_state`
- `pnpm clanky doctor --home ~/.clanky` reports `live_gate_profile_daemons: installed`

- `com.clanky.daemon.work` and `com.clanky.daemon.personal` are distinct launchd labels
- sockets, locks, sessions, cron jobs, Linear links, and swarm DB paths do not overlap
- work task output appears only under the work profile
- personal task output appears only under the personal profile
- both services uninstall cleanly
