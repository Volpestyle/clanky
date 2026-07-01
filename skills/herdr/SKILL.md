---
name: herdr
description: "Control herdr from inside it. Manage workspaces and tabs, split panes, spawn agents, read output, and wait for state changes — all via CLI commands that talk to the running herdr instance over a local unix socket. Use when running inside herdr (HERDR_ENV=1)."
---

# herdr — agent skill

before using this skill, check that `HERDR_ENV=1`. if it is not set to `1`, say you are not running inside a herdr-managed pane and stop. do not inspect or control the focused herdr pane from outside herdr.

you are running inside herdr, a terminal-native agent multiplexer. herdr gives you workspaces, tabs, and panes — each pane is a real terminal with its own shell, agent, server, or log stream — and you can control all of it from the cli.

this means you can:

- see what other panes and agents are doing
- create tabs for separate subcontexts inside one workspace
- split panes and run commands in them
- start servers, watch logs, and run tests in sibling panes
- wait for specific output before continuing
- wait for another agent to finish
- spawn more agent instances

the `herdr` binary is available in your PATH. its workspace, tab, pane, and wait commands talk to the running herdr instance over a local unix socket.

if you need the raw protocol or full api reference, read the [socket api docs](https://herdr.dev/docs/socket-api/).

## concepts

**workspaces** are project contexts. each workspace has one or more tabs. unless manually renamed, a workspace's label follows the first tab's root pane — usually the repo name, otherwise the root pane's current folder name.

**tabs** are subcontexts inside a workspace. each tab has one or more panes.

**panes** are terminal splits inside a tab. each pane runs its own process — a shell, an agent, a server, anything.

**agent status** is detected automatically by herdr. the api exposes one public field for it:

- `agent_status` — `idle`, `working`, `blocked`, `done`, `unknown`

`done` means the agent finished, but you have not looked at that finished pane yet.

plain shells still exist as panes, but herdr's sidebar agent section intentionally focuses on detected agents rather than listing every shell.

**ids** — workspace ids look like `w1`, `w2`. tab ids look like `w1:t1`, `w1:t2E`. pane ids look like `w1:p1`, `w1:pG5`. the token after `t`/`p` is opaque, not a counter — copy ids verbatim from command output. numeric workspace refs (`--workspace w1`) are also accepted.

important: ids are compact public ids for the current live session and can compact when tabs, panes, or workspaces are closed. do not treat them as durable ids. re-read ids from `workspace list`, `tab list`, `pane list`, or create/split responses when you need a current id. do not guess that an older `w1:p3` is still the same pane later.

## discover yourself

see what panes exist and which one is focused:

```bash
herdr pane list
```

the focused pane is yours. other panes are your neighbors.

list workspaces:

```bash
herdr workspace list
```

## tab management

list tabs in the current workspace:

```bash
herdr tab list --workspace w1
```

create a new tab:

```bash
herdr tab create --workspace w1
```

without `--label`, the new tab keeps the default numbered tab name.

create and name it in one step:

```bash
herdr tab create --workspace w1 --label "logs"
```

rename it:

```bash
herdr tab rename w1:t2 "logs"
```

focus it:

```bash
herdr tab focus w1:t2
```

close it:

```bash
herdr tab close w1:t2
```

## read another pane

see what is on another pane's screen:

```bash
herdr pane read w1:p1 --source recent --lines 50
```

- `--source visible` = current viewport
- `--source recent` = recent scrollback as rendered in the pane
- `--source recent-unwrapped` = recent terminal text with soft wraps joined back together

`--lines` defaults to 80 and is clamped server-side at 1000. there is no full-history source — a pane's complete output can only be captured as it happens (the transcript seam), not read back later.

If the target is a Clanky-spawned worker and you need durable historical output
instead of current screen state, use:

```bash
clanky transcript read clanky:<slug> --lines 120
```

## split a pane and run a command

split your pane to the right and keep focus on your current pane:

```bash
herdr pane split w1:p2 --direction right --no-focus
```

that prints json with the new pane nested at `result.pane.pane_id`. parse that value, then run a command in that pane:

```bash
NEW_PANE=$(herdr pane split w1:p2 --direction right --no-focus | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["pane"]["pane_id"])')
herdr pane run "$NEW_PANE" "npm run dev"
```

split downward instead:

```bash
herdr pane split w1:p2 --direction down --no-focus
```

## wait for output

block until specific text appears in a pane. useful for waiting on servers, builds, and tests.

for `--source recent`, matching uses unwrapped recent terminal text, so pane width and soft wrapping do not break matches. `pane read --source recent` still shows the pane as rendered. if you want to inspect the same transcript that the waiter matches, use `pane read --source recent-unwrapped`.

```bash
herdr wait output w1:p3 --match "ready on port 3000" --timeout 30000
```

with regex:

```bash
herdr wait output w1:p3 --match "server.*ready" --regex --timeout 30000
```

if it times out, exit code is `1`.

## wait for an agent status

block until another agent reaches a specific status:

```bash
herdr wait agent-status w1:p1 --status done --timeout 60000
```

use this when you want the same `done` / `idle` distinction the UI shows.

## send text or keys to a pane

send text without pressing Enter:

```bash
herdr pane send-text w1:p1 "hello from claude"
```

press Enter or other keys:

```bash
herdr pane send-keys w1:p1 Enter
```

`pane run` sends the text and then a real `Enter` key in one request:

```bash
herdr pane run w1:p1 "echo hello"
```

## publish your own status (presence)

let other agents see what you are doing. report your own state so peers reading
`herdr agent list` / `herdr agent get` know whether you are free, busy, or stuck:

```bash
# --source is your own stable id; --agent is the label peers see
herdr pane report-agent <your-pane> --source me --agent "clanky:fix-auth" \
  --state working --message "running the auth suite"
```

set `--state blocked` with a `--message` when you need input, and back to
`idle` when done. richer metadata (title, custom status, per-state labels) goes
through `herdr pane report-metadata`. this is how a flat swarm coordinates: every
agent reports presence, anyone can discover and read everyone, no central
coordinator required.

## workspace management

create a new workspace:

```bash
herdr workspace create --cwd /path/to/project
```

without `--label`, the new workspace keeps the default cwd-based name.

create and name one in one step:

```bash
herdr workspace create --cwd /path/to/project --label "api server"
```

create one without focusing it:

```bash
herdr workspace create --no-focus
```

focus a workspace:

```bash
herdr workspace focus w2
```

rename:

```bash
herdr workspace rename w1 "api server"
```

close:

```bash
herdr workspace close w2
```

## close a pane

```bash
herdr pane close w1:p3
```

## target another session

one herdr server = one session. the default session's socket is `~/.config/herdr/herdr.sock`; named sessions live at `~/.config/herdr/sessions/<name>/herdr.sock`.

session resolution precedence: the `--session=<name>` global flag beats `HERDR_SOCKET_PATH`, which beats `HERDR_SESSION`. inside a herdr pane, `HERDR_SOCKET_PATH` is inherited pointing at the live session — so exporting `HERDR_SESSION=<other>` alone is silently ignored and your commands land in the live session. when targeting another session from inside a pane, pass `--session=<name>` on every invocation (or explicitly re-export `HERDR_SOCKET_PATH` to that session's socket):

```bash
herdr --session=rehearsal pane list
```

a named sandbox session is the safe way to rehearse risky operations (server binary upgrades, live handoff) without touching the live session: start a second headless server with the pane-inherited `HERDR_*` vars unset (`unset HERDR_ENV HERDR_PANE_ID HERDR_TAB_ID HERDR_WORKSPACE_ID HERDR_SOCKET_PATH; HERDR_SESSION=<name> herdr server`), rehearse against it with `--session=<name>` pinned on every call, and ping the live socket afterwards to confirm it was untouched.

## recipes

### run a server and wait until it is ready

```bash
NEW_PANE=$(herdr pane split w1:p2 --direction right --no-focus | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["pane"]["pane_id"])')
herdr pane run "$NEW_PANE" "npm run dev"
herdr wait output "$NEW_PANE" --match "ready" --timeout 30000
herdr pane read "$NEW_PANE" --source recent --lines 20
```

### run tests in a separate pane and inspect the result

```bash
herdr pane split w1:p2 --direction down --no-focus
herdr pane run w1:p3 "cargo test"
herdr wait output w1:p3 --match "test result" --timeout 60000
herdr pane read w1:p3 --source recent --lines 30
```

### check what another agent is working on

```bash
herdr pane list
herdr pane read w1:p1 --source recent --lines 80
```

### watch another pane robustly

use this pattern when you need to coordinate with a sibling pane:

```bash
# inspect what is already there
herdr pane read w1:p3 --source recent --lines 40

# wait only for the next output you expect
herdr wait output w1:p3 --match "ready" --timeout 30000

# if you need to inspect the same transcript the waiter matched,
# read the unwrapped recent text directly
herdr pane read w1:p3 --source recent-unwrapped --lines 40
```

### spawn a new agent and give it a task

For Clanky worker fan-out, do not use this raw recipe: use Clanky's `herdr_spawn`
tool or the `clanky-herdr-operator` skill so the worker is launched through the
transcript seam. Raw pane starts are only for generic ad hoc panes.

```bash
herdr pane split w1:p2 --direction right --no-focus
herdr pane run w1:p3 "claude"
herdr wait output w1:p3 --match ">" --timeout 15000
herdr pane run w1:p3 "review the test coverage in src/api/"
```

### coordinate with another agent

```bash
herdr wait agent-status w1:p1 --status done --timeout 120000
herdr pane read w1:p1 --source recent --lines 100
```

## notes

- `workspace list`, `workspace create`, `tab list`, `tab create`, `tab get`, `tab focus`, `tab rename`, `tab close`, `pane list`, `pane get`, `pane split`, `wait output`, and `wait agent-status` print json on success.
- `pane read` prints text, not json.
- `pane read --format ansi` or `pane read --ansi` returns a rendered ANSI snapshot for TUI feedback loops.
- `pane read --source recent-unwrapped` is useful when you want to inspect the same unwrapped transcript that `wait output --source recent` matches against.
- `pane send-text`, `pane send-keys`, and `pane run` print nothing on success.
- parse ids from `workspace create`, `tab create`, and `pane split` responses when you need new ids. `workspace create` returns `result.workspace`, `result.tab`, and `result.root_pane`. `tab create` returns `result.tab` and `result.root_pane`. for `pane split`, the new pane id is at `result.pane.pane_id`.
- use `pane read` for current output that already exists. use `wait output` for future output you expect next.
- `--no-focus` on split, tab create, and workspace create keeps your current terminal context focused.
- without `--label`, workspace create keeps cwd-based naming and tab create keeps numbered naming.
- `--label` on tab create and workspace create applies the custom name immediately.
- if you are running inside herdr, the `HERDR_ENV` environment variable is set to `1`.
