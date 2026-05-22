# Clanky: Plan

An always-on agent harness built on **Pi**, modeled on **hermes-agent**, capable of acting as the **gateway/leader** of **swarm-mcp**.

---

## 1. Goal & framing

| | |
|---|---|
| **What** | A long-lived process (`clanky` daemon) that runs the Pi agent loop continuously, accepts inbound prompts from external clients (CLI/TUI/HTTP/MCP), runs cron-scheduled jobs, persists sessions, and coordinates swarm-mcp workers. |
| **Why** | Hermes solves this for its own bespoke Python agent. Pi is cleaner, TypeScript-native, has a better TUI, better provider abstraction, and an event-driven core loop already decoupled from UI. Rebuilding hermes' surface on top of Pi gives us all of Pi's quality with hermes' "always-on, scheduled, swarm-leading" affordances. |
| **Won't do (v1)** | Multi-platform adapters (Telegram/Discord/Slack). Public dataset publishing. Skill curator auto-archive. Web dashboard. These are all post-MVP. |
| **Language** | TypeScript end-to-end. Same toolchain as Pi, but using pnpm workspaces with biome and tsgo. Sits as a sibling package, not a fork. |

### Non-goals
- Don't fork Pi. Embed it as published packages (`@earendil-works/pi-agent-core`, `pi-ai`, `pi-tui`, `pi-coding-agent`) so we ride upstream improvements.
- Don't replicate hermes' Python AIAgent. Pi's agent loop is the runtime; we wrap, don't rewrite.
- Don't reinvent swarm-mcp. Mount it as a subprocess MCP server; speak its tool API.

---

## 2. System map (target architecture)

```
┌──────────────────────────────────────────────────────────────────────┐
│ clanky daemon  (single Node.js process, asyncio-style event loop)    │
│                                                                       │
│  ┌──────────────────────────┐    ┌─────────────────────────────────┐ │
│  │ Gateway                  │    │ Cron scheduler                  │ │
│  │  - HTTP API (Hono)       │    │  - tick() every 60s             │ │
│  │  - MCP stdio server      │◄──▶│  - fcntl lock on .tick.lock     │ │
│  │  - WebSocket events      │    │  - spawns transient AgentSession│ │
│  └────────────┬─────────────┘    └─────────────────────────────────┘ │
│               │                                                       │
│               ▼                                                       │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ SessionRegistry (LRU, idle-TTL=1h, ≤128 live)                │   │
│  │   key=sessionId → AgentSession (pi-coding-agent)             │   │
│  │   each session: Pi agent loop + tools + hooks + persistence  │   │
│  └────────────┬─────────────────────────────────────────────────┘   │
│               │                                                       │
│  ┌────────────▼──────────────┐  ┌──────────────────────────────┐    │
│  │ Skills loader             │  │ SwarmLeader (clanky-specific)│    │
│  │  ~/.clanky/skills/        │  │  - mounts swarm-mcp subproc  │    │
│  │  + ./skills/ (bundled)    │  │  - register/bootstrap on boot│    │
│  │  injected as user msgs    │  │  - lifecycle plugin (locks)  │    │
│  │  (caching-friendly)       │  │  - dispatch / wait loop      │    │
│  └───────────────────────────┘  │  - Linear bridge             │    │
│                                  └──────────────────────────────┘    │
│                                                                       │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ State (~/.clanky/)                                            │   │
│  │   sessions/<id>.jsonl   ← Pi-native SessionManager           │   │
│  │   index.db (SQLite/FTS5) ← cross-session search, cron jobs,  │   │
│  │                            kanban, task ledger               │   │
│  │   cron/jobs.json + .outputs/                                  │   │
│  │   profiles/<name>/    ← isolated home (like hermes profiles) │   │
│  │   skills/.usage.json                                          │   │
│  └──────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────┘
              ▲                                       ▲
              │ JSON-RPC stdio                        │ stdio MCP
              │                                       │
┌─────────────┴───────────────┐         ┌────────────┴───────────────┐
│ clanky-tui (Pi TUI, dashboard│         │ swarm-mcp (bun subprocess) │
│ + chat mode). Connects to    │         │ shared SQLite, ~/.swarm-mcp│
│ daemon over local socket.    │         │ peers: Claude Code panes…  │
└──────────────────────────────┘         └────────────────────────────┘
```

### Process model
- **One** clanky daemon process. Async, single-threaded event loop (Node). No forking.
- **Worker pool**: a small `worker_threads` or `Piscina` pool for any CPU-heavy work (token counting, html export). The agent loop itself is I/O bound.
- **Subprocesses**: only for (a) `swarm-mcp` (stdio MCP), (b) any external MCP servers configured by user, (c) `bash` tool executions (already handled by Pi).
- **Cron**: in-process timer, not a separate process. File lock prevents two daemons stomping each other.
- **TUI**: separate process, attaches via local UDS / named pipe (same JSON-RPC protocol Pi's RPC mode uses).

---

## 3. Package layout

```
clanky/                           ← new repo, sibling of ~/pi
├── packages/
│   ├── clanky-core/              ← agent + cron + session registry + skills
│   │   ├── src/
│   │   │   ├── daemon.ts         ← entry: spin gateway+cron+swarm
│   │   │   ├── session-registry.ts
│   │   │   ├── cron/
│   │   │   │   ├── scheduler.ts  ← tick(), file-lock, fan-out
│   │   │   │   ├── jobs.ts       ← json store, idempotency
│   │   │   │   └── delivery.ts   ← deliver outputs back to caller
│   │   │   ├── skills/
│   │   │   │   ├── loader.ts     ← scan dirs, parse SKILL.md frontmatter
│   │   │   │   └── injector.ts   ← injects skill md as user message
│   │   │   ├── state/
│   │   │   │   ├── sessions.ts   ← wraps Pi SessionManager
│   │   │   │   └── index-db.ts   ← better-sqlite3 + FTS5 (search/cron/kanban)
│   │   │   ├── profiles.ts       ← active profile resolution
│   │   │   └── extension/
│   │   │       └── clanky-ext.ts ← Pi extension that wires our tools/hooks
│   │   └── package.json
│   │
│   ├── clanky-gateway/           ← HTTP + MCP server, WebSocket events
│   │   ├── src/
│   │   │   ├── server.ts         ← Hono app
│   │   │   ├── mcp.ts            ← @modelcontextprotocol/sdk server export
│   │   │   ├── ws.ts             ← session event stream
│   │   │   └── routes/
│   │   │       ├── sessions.ts   ← /sessions, /sessions/:id/messages
│   │   │       ├── cron.ts       ← list/create/run-now/disable
│   │   │       └── swarm.ts      ← passthrough to SwarmLeader
│   │   └── package.json
│   │
│   ├── clanky-swarm/             ← swarm-mcp leader
│   │   ├── src/
│   │   │   ├── client.ts         ← MCP client for swarm-mcp subprocess
│   │   │   ├── lifecycle.ts      ← register/bootstrap/deregister, ref-count
│   │   │   ├── lock-hook.ts      ← Pi tool_call hook → get_file_lock
│   │   │   ├── dispatch.ts       ← request_task → dispatch → wait
│   │   │   ├── poller.ts         ← wait_for_activity loop
│   │   │   ├── linear.ts         ← create issue, mirror status, post comment
│   │   │   └── skill/SOUL.md     ← gateway prompt (analog to hermes SOUL.md)
│   │   └── package.json
│   │
│   ├── clanky-tui/               ← TUI client (uses pi-tui)
│   │   ├── src/
│   │   │   ├── main.ts           ← attaches to daemon via UDS
│   │   │   ├── views/
│   │   │   │   ├── dashboard.ts  ← cron, swarm, recent sessions, tasks
│   │   │   │   ├── chat.ts       ← drop into a session (delegates to Pi TUI)
│   │   │   │   └── swarm.ts      ← peer list, task board, file locks
│   │   │   └── rpc-client.ts     ← reuses pi-coding-agent rpc-client
│   │   └── package.json
│   │
│   └── clanky-cli/               ← `clanky` binary (start, stop, status, …)
│       └── src/
│           ├── bin.ts            ← argparse entry
│           ├── commands/
│           │   ├── start.ts      ← spawn daemon (foreground or detached)
│           │   ├── install.ts    ← write launchd plist / systemd unit
│           │   ├── send.ts       ← one-shot prompt → daemon → stdout
│           │   ├── cron.ts       ← `clanky cron add/list/rm/run-now`
│           │   ├── session.ts    ← list/resume/fork/export
│           │   └── swarm.ts      ← status/dispatch passthrough
│           └── package.json
│
├── skills/                       ← bundled skills (swarm-leader, daily-digest, …)
├── docs/
├── package.json                  ← pnpm workspaces, lockstep versions
├── tsconfig.base.json
├── biome.json
└── AGENTS.md                     ← copy Pi's quality bar + clanky specifics
```

**Dependency direction**: `cli` → `gateway` + `swarm` + `tui` → `core` → Pi packages.
`core` is the only thing that talks to `pi-agent-core` directly. Everyone else talks to `core`'s `SessionRegistry`.

---

## 4. How clanky uses Pi (extension points)

Pi gives us five clean integration surfaces. We use all five:

1. **`AgentSession`** (`@earendil-works/pi-coding-agent`) is the per-conversation facade. `SessionRegistry` stores these by id, with idle-TTL eviction. Each session has its own JSONL file under `~/.clanky/sessions/<id>.jsonl` — we reuse Pi's `SessionManager` verbatim, only changing the base directory.

2. **Extension API** (`packages/coding-agent/src/core/extensions/types.ts`) — clanky ships one extension, `clanky-ext`, that registers:
   - Custom tools (`schedule_cron`, `swarm_dispatch`, `swarm_status`, `linear_link`, `task_create`, …).
   - Custom slash commands (`/cron`, `/swarm`, `/skills`, `/profile`).
   - Hooks: `before_agent_start` (inject swarm snapshot when leader skill active), `tool_call` (check swarm file locks), `tool_result` (mirror to Linear), `message_end` (index for FTS5 search).
   - One extra `CustomEntry` writer for non-LLM state we want to persist alongside the JSONL (e.g. the swarm task IDs touched in this session).

3. **RPC mode** (`packages/coding-agent/src/modes/rpc/`) — clanky's TUI client speaks the *exact same JSON-RPC over stdio* protocol Pi already supports. The TUI can be a thin wrapper that pipes between a Unix socket and an `AgentSession` running inside the daemon. We don't reinvent the protocol; we just multiplex it over a UDS so multiple TUI clients can attach.

4. **Hook system** (`packages/agent/docs/hooks.md`) — `tool_call`, `tool_result`, `before_agent_start`, `before_provider_request` all return a result, so we can mutate or block. This is exactly how hermes' `pre_tool_call` blocks writes when a swarm peer holds a file lock — we port that behavior 1:1 in `clanky-swarm/lock-hook.ts`.

5. **Provider abstraction** (`@earendil-works/pi-ai`) — no changes. Clanky users get the same `--provider`/`--model` flags. Cron jobs and swarm dispatch can override per-task.

What we **don't** do:
- We don't patch Pi. If we need new lifecycle events, we open PRs upstream and pin a version.
- We don't replace the TUI renderer. `pi-tui` is excellent; we add views, not primitives.

---

## 5. Daemon lifecycle

```
clanky start
 ├─ acquire ~/.clanky/.daemon.lock (flock; refuse second instance)
 ├─ resolve active profile → CLANKY_HOME = ~/.clanky/profiles/<name>/
 ├─ open index.db (better-sqlite3, WAL, FTS5)
 ├─ load configured MCP servers (swarm-mcp first if `swarm.enabled`)
 ├─ start SwarmLeader.boot():
 │     register() with label "clanky mode:gateway role:planner identity:<profile>"
 │     bootstrap() → cache peers + unread messages
 │     publish workspace handle if HERDR_PANE_ID set
 ├─ start CronScheduler.start() → setInterval(tick, 60_000)
 ├─ start Gateway.listen():
 │     HTTP on 127.0.0.1:CLANKY_PORT (default 7766)
 │     MCP stdio if --mcp (lets Claude Code mount us)
 │     UDS at ~/.clanky/.sock for TUI clients
 │     WS at /events for live stream
 ├─ register SIGTERM/SIGINT → graceful shutdown:
 │     stop cron, drain in-flight sessions, swarm deregister, fsync state
 └─ idle in event loop
```

**Graceful restart**: SIGUSR1 swaps the gateway listener to a new process via SO_REUSEADDR, hands off open WebSockets via SCM_RIGHTS (or simpler: drain + restart). Stretch goal; not v1.

**Crash recovery**: on boot, if `~/.clanky/.daemon.lock` is stale (PID not alive), reclaim it. Replay any cron jobs whose `last_fire < scheduled_fire` and `enabled=true`.

---

## 6. Cron design (lifted from hermes, adapted)

```jsonc
// ~/.clanky/cron/jobs.json
{
  "jobs": [
    {
      "id": "uuid",
      "schedule": "0 9 * * *",         // 5-field cron OR "every 2h" OR ISO timestamp (one-shot)
      "prompt": "Summarize yesterday's swarm tasks and post to Linear",
      "skill": "swarm-leader",         // pulled into context
      "provider": "anthropic",         // optional override
      "model": "claude-opus-4-7",
      "workdir": "/Users/.../pi",      // sets cwd; AGENTS.md/CLAUDE.md picked up
      "deliver": "stdout",             // stdout | session:<id> | swarm:<peer> | linear:<issue>
      "enabled": true,
      "idempotency_key": "daily-digest-${YYYYMMDD}",  // optional, prevents double-fire
      "timeout_seconds": 600
    }
  ]
}
```

`scheduler.tick()`:
1. `flock(~/.clanky/cron/.tick.lock)` (advisory; non-blocking). Skip if held.
2. Compute due jobs (`next_fire <= now && enabled`).
3. For each: spawn an `AgentSession` with `{ skipMemory: true, prompt, model, skill, workdir, timeout }`.
4. On completion: write result to `~/.clanky/cron/.outputs/<job_id>` (rotate to 3), advance `next_fire`, route via `deliver`.
5. Release lock.

**Idempotency**: if `idempotency_key` present, hash and store in `index.db.cron_runs (key UNIQUE)`. Skip if already recorded for this scheduled instant.

**Hard timeout** (3 min default like hermes) wraps the agent loop with an AbortSignal; runaway tool loops die cleanly.

---

## 7. Swarm-leader integration

This is the load-bearing piece. We replicate hermes' lifecycle plugin pattern but in TypeScript, plugged into Pi's hook system.

### 7.1 Boot
```ts
// clanky-swarm/lifecycle.ts
export async function boot(ctx: ClankyCtx) {
  const swarm = await ctx.mcp.spawn("swarm-mcp", {
    command: "bun",
    args: ["run", "/Users/.../web/swarm-mcp/src/index.ts"],
    env: { AGENT_IDENTITY: ctx.profile, SWARM_DB_PATH: ctx.swarmDbPath },
  });

  const me = await swarm.call("register", {
    directory: process.cwd(),
    scope: gitRoot() ?? process.cwd(),
    label: `clanky mode:gateway role:planner identity:${ctx.profile}`,
  });
  ctx.swarmInstanceId = me.instance_id;

  const snap = await swarm.call("bootstrap", {});
  ctx.swarmSnapshot = snap;

  if (process.env.HERDR_PANE_ID) {
    await swarm.call("kv_set", {
      key: `identity/workspace/herdr/${me.instance_id}`,
      value: JSON.stringify({ backend: "herdr", handle_kind: "pane",
                              handle: process.env.HERDR_PANE_ID,
                              socket_path: process.env.HERDR_SOCKET }),
    });
  }
}
```

### 7.2 File-lock hook (mirrors hermes `pre_tool_call`)
```ts
// clanky-swarm/lock-hook.ts
export const swarmLockHook: HookHandler<"tool_call"> = async (event, ctx) => {
  if (!writeLikeTools.has(event.tool.name)) return;
  const path = extractPath(event.tool.input);
  if (!path) return;
  const state = await ctx.swarm.call("get_file_lock", { path });
  if (state.active && state.instance_id !== ctx.swarmInstanceId) {
    return {
      block: true,
      reason: `swarm lock held by ${state.label}; aborting write to ${path}`,
    };
  }
};
```

### 7.3 Dispatch tool (exposed to the LLM)
```ts
// clanky-swarm/tools/swarm_dispatch.ts
export const swarm_dispatch: AgentTool = {
  name: "swarm_dispatch",
  description: "Delegate a coding task to a swarm worker. Use for non-trivial work.",
  schema: Type.Object({
    title: Type.String(),
    type: Type.Union([Type.Literal("implement"), Type.Literal("fix"),
                      Type.Literal("review"), Type.Literal("research")]),
    files: Type.Optional(Type.Array(Type.String())),
    description: Type.String(),
    wait_for_completion: Type.Optional(Type.Boolean()),
    linear_issue: Type.Optional(Type.String()),
  }),
  async execute(input, ctx) {
    const idem = `${input.linear_issue ?? ctx.sessionId}:${input.type}:${stableHash(input.title)}`;
    const task = await ctx.swarm.call("request_task", { ...input, idempotency_key: idem });
    if (input.linear_issue) {
      await ctx.swarm.call("kv_set", {
        key: `tracker/linear/${ctx.profile}/${task.id}`,
        value: JSON.stringify({ identifier: input.linear_issue, linked_at: now() }),
      });
    }
    const res = await ctx.swarm.call("dispatch", {
      title: input.title, type: input.type, role: "implementer",
      files: input.files, idempotency_key: idem,
      placement: { workspace: "reuse_scope", split_direction: "right" },
      completion_wait_seconds: input.wait_for_completion ? 1800 : 0,
    });
    return { task_id: task.id, ...res };
  },
};
```

### 7.4 Background poller
A single async loop running `swarm.call("wait_for_activity", { timeout: 60 })` and routing events to:
- task completion → Linear bridge (mirror status, post comment) + notify any session awaiting this `task_id`.
- inbox message → if addressed to a session, append as user message; if a wake/dispatch, route via Gateway.
- planner ownership change → re-elect if we should be planner.

### 7.5 Gateway/leader prompt
Bundled skill `skills/swarm-leader/SKILL.md` is the analog of hermes' `SOUL.md`. Loaded automatically when daemon starts in gateway mode. Tells the agent: "prefer `swarm_dispatch` over native subagents for non-trivial coding work; use `linear_link` to bind tasks before completing them; honor the Linear-backed swarm work contract (`tracker_update` or `tracker_update_skipped` in the final result)."

This satisfies the CLAUDE.md requirement that workers without a same-identity Linear MCP must explicitly skip rather than silently drop tracker updates.

---

## 8. Gateway surface (external API)

| Transport | Surface | Consumers |
|---|---|---|
| **MCP stdio** | `session.send`, `session.list`, `session.fork`, `cron.list`, `cron.run_now`, `swarm.dispatch`, `swarm.status`, `linear.link` | Claude Code, Codex, other MCP clients mount clanky as a server (mirror of hermes' `mcp_serve.py`) |
| **HTTP** (Hono, 127.0.0.1:7766) | `POST /sessions/:id/messages`, `GET /sessions`, `POST /cron/jobs`, `GET /swarm/status`, `POST /swarm/dispatch` | Scripts, automations, browser dashboard (post-MVP) |
| **WebSocket** (`/events`) | Streams `AgentSessionEvent` for the subscribed session id; streams `cron.fired`, `swarm.task_changed`, `swarm.message` globally | TUI, future dashboard |
| **Unix socket** (`~/.clanky/.sock`) | Pi RPC protocol unmodified | clanky-tui |
| **CLI shim** (`clanky send …`) | Wraps HTTP for terminal usage | humans, shell scripts |

Authentication v1: local-only sockets (no listen on 0.0.0.0). HTTP requires a token at `~/.clanky/.token` (auto-generated). When run on a server (`--bind 0.0.0.0`) the token is mandatory.

---

## 9. Skills

Same shape as hermes / Claude Code:

```
~/.clanky/skills/<name>/SKILL.md
├── frontmatter: name, description, when_to_use, allowed_tools, deps
└── markdown body (injected as user message at session start when activated)
```

Loader scans on boot, watches with `chokidar` for hot-reload. Activation is per-session (slash command `/skill add <name>`) or per-cron-job (the job spec lists `skill:`).

Bundled skills shipped with clanky:
- `swarm-leader` — gateway/planner prompt (the SOUL.md analog).
- `daily-digest` — cron-friendly summarizer.
- `linear-bridge` — work-tracker rules.
- `pi-tui-coder` — reminds the agent of Pi's house style when editing the codebase.

Skill usage is tracked in `~/.clanky/skills/.usage.json` (timestamp last used). Auto-archive is a post-MVP feature; we record but don't act.

---

## 10. State & storage

| Path | Format | Purpose |
|---|---|---|
| `~/.clanky/sessions/<id>.jsonl` | Pi's `SessionEntry` JSONL | Per-session conversation, branches, compaction (use Pi's `SessionManager` unchanged) |
| `~/.clanky/index.db` | SQLite (better-sqlite3) | Cross-session search (FTS5 on assistant/user content), cron job ledger, kanban board, idempotency keys, task↔session map |
| `~/.clanky/cron/jobs.json` | JSON | Cron job specs (human-editable; tools also write it) |
| `~/.clanky/cron/.outputs/<job_id>` | Text | Last 3 outputs per job |
| `~/.clanky/skills/` | Filesystem | User + agent-created skills |
| `~/.clanky/profiles/<name>/` | Same tree, isolated | Multi-identity (work / personal). Selected via `CLANKY_PROFILE` env or `--profile` flag. |
| `~/.clanky/.daemon.lock` | flock pidfile | Singleton enforcement |
| `~/.clanky/.token` | Plaintext | HTTP auth |
| `~/.clanky/.sock` | UDS | TUI attach |

The JSONL/SQLite split mirrors hermes (JSON outputs vs SQLite state) but uses Pi's native session format so we get compaction, branching, and tree forks for free. SQLite is just an *index* and a place for cron/swarm-specific tabular state — sessions are still source-of-truth in JSONL.

---

## 11. CLI surface

```
clanky start [--detach] [--profile <name>] [--bind 127.0.0.1:7766] [--mcp]
clanky stop
clanky status                                # daemon health, cron, swarm peers
clanky install [--launchd | --systemd]       # writes plist/unit, enables on login
clanky send "<prompt>" [--session <id>] [--skill <name>] [--model …]
clanky session list | resume <id> | fork <id> | export <id> [--html out.html]
clanky cron add | list | rm <id> | enable <id> | disable <id> | run-now <id>
clanky swarm status | peers | tasks | dispatch "<title>" --type implement --files …
clanky skill list | add <name> | remove <name>
clanky profile list | use <name> | new <name>
clanky tui                                   # spawns clanky-tui attached to daemon
```

`clanky tui` without a running daemon is a UX trap; print a helpful "daemon not running, start it with `clanky start`?" and offer to launch it.

---

## 12. TUI design

Two modes:

1. **Dashboard** (`clanky tui` with no session arg): a `pi-tui` view with panes for
   - active swarm peers and their tasks (live, via WS),
   - cron schedule with next-fire countdowns,
   - recent sessions (with quick-resume),
   - file lock map (current `swarm.context` table).
2. **Chat** (`clanky tui --session <id>`): drops directly into Pi's existing interactive mode, but rendered as a remote view of the daemon-side `AgentSession`. The TUI is a thin client; the daemon owns state.

Implementation: TUI side uses `pi-coding-agent`'s RPC client unchanged. Daemon side adapts the existing RPC mode to multiplex over a UDS rather than parent stdio.

---

## 13. Profiles & identity

Direct port of hermes' profiles. Each profile gets:
- `~/.clanky/profiles/<name>/` (everything above, scoped)
- `AGENT_IDENTITY=<name>` env when spawning swarm-mcp → identity-isolated `~/.swarm-mcp-<name>/swarm.db`
- Distinct daemon (different lock file → distinct ports)

This is how we satisfy the Linear-backed swarm CLAUDE.md rule cleanly: each profile's MCP env decides which Linear team / API key is in play; tasks never cross identities.

---

## 14. Phased roadmap

### Phase 0 — scaffolding (1 day)
- New `~/clanky` repo, pnpm workspaces, biome, tsgo.
- Vendor Pi packages as dependencies (`@earendil-works/pi-*`).
- Empty `clanky start` that boots a `SessionRegistry` and exits. Smoke test the embed.

### Phase 1 — daemon + RPC TUI (2–3 days)
- `clanky-core` SessionRegistry with idle TTL.
- `clanky-gateway` UDS server speaking Pi RPC protocol.
- `clanky-tui` (initially just a thin RPC client = Pi interactive mode over UDS).
- `clanky send` CLI command for one-shot prompts.
- Profile resolution + `~/.clanky/sessions/` JSONL.

### Phase 2 — gateway HTTP + MCP (2 days)
- Hono HTTP API with the routes in §8.
- MCP stdio server exposing send/list/fork/cron tools. Validate by mounting in Claude Code.
- WebSocket events stream.

### Phase 3 — cron (2 days)
- `clanky cron add/list/rm/run-now`.
- `cron/scheduler.ts` tick loop with file lock, idempotency, hard timeout.
- Delivery to stdout/session/file. (Telegram/Discord deferred.)

### Phase 4 — skills (1–2 days)
- Skill loader (filesystem + frontmatter).
- `/skill add` slash command.
- Bundled `swarm-leader`, `linear-bridge`, `daily-digest`.

### Phase 5 — swarm-leader (3–5 days)
- `clanky-swarm` MCP client to swarm-mcp subprocess.
- Lifecycle (register/bootstrap/deregister, workspace identity publish).
- `tool_call` hook for peer lock enforcement.
- `swarm_dispatch`, `swarm_status`, `swarm_message`, `swarm_complete` tools.
- Background `wait_for_activity` poller.
- Linear bridge (create issue, mirror status, post completion comment) — uses any Linear MCP already configured in the daemon.
- End-to-end test: `clanky send "Fix the typo in pi/README.md"` → dispatches to a herdr-spawned worker → completes → comment posted.

### Phase 6 — dashboard TUI (2 days)
- `clanky-tui` dashboard view (swarm peers, cron, sessions, locks).
- Live updates over WS.

### Phase 7 — install scripts + docs (1 day)
- `clanky install` writes launchd plist (`~/Library/LaunchAgents/com.clanky.daemon.plist`) or systemd user unit.
- AGENTS.md, README, demo recording.

Total: ~3 weeks of focused work; usable end of Phase 5 (~2 weeks).

---

## 15. Open decisions to make before Phase 1

| Decision | Options | Default recommendation |
|---|---|---|
| Embed Pi as published packages or git submodule? | published pkg / git submodule / monorepo fork | **Published packages** — clean upgrades, less coupling |
| TS runtime for daemon | Node 22 / Bun | **Node 22** — Pi is already Node-native, fewer surprises |
| Daemon process supervision in dev | manual / `tsx watch` / `pm2` | **`tsx watch`** for dev, launchd/systemd for prod |
| HTTP framework | Hono / Fastify / raw http | **Hono** — small, TS-first, MCP-friendly |
| SQLite driver | better-sqlite3 / node:sqlite (Node 22) | **node:sqlite** if it has FTS5 in your runtime; else better-sqlite3 |
| MCP SDK | `@modelcontextprotocol/sdk` | **yes** — both as client (to swarm) and server (to Claude Code) |
| Skill activation default for cron | implicit allowlist / explicit per-job | **explicit per-job `skill:` field** |
| Multi-tenancy on the gateway | none / per-profile / per-user | **per-profile only** (single user, multiple identities) |

---

## 16. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Pi's RPC protocol evolves and breaks our TUI multiplexer | Pin Pi version; integration tests on every bump; PR upstream if we need new events |
| swarm-mcp tool surface drifts | Wrap behind `clanky-swarm/client.ts` so all callsites are typed; one place to update |
| Long-running daemon leaks (sessions never evict) | Idle TTL + max-live-sessions ceiling; expose `clanky status` for observability |
| Cron job runs simultaneously across two daemons | File lock on `.tick.lock`; also `idempotency_key` in index.db |
| Linear MCP not mounted on the daemon → silent tracker drop | Enforce contract from CLAUDE.md: every swarm dispatch with `linear_issue` must produce either `tracker_update` or explicit `tracker_update_skipped` in the final tool result; surface as a warning in `clanky status` |
| Single-process bottleneck (one heavy session blocks others) | Pi agent loop is already async; tool execution can be parallel. Only a synchronous tool (`bash`) blocks the event loop — keep bash spawns truly async |
| Token security | UDS for local, mandatory token for HTTP, never log token, rotate on `clanky start --new-token` |
| Profile/identity bleed (work tools used in personal session) | Profile is set at daemon-boot; can't be switched per-session; separate daemons for separate profiles |

---

## 17. Success criteria (definition of done for v1)

1. `clanky start` runs as a launchd agent; survives logout, restarts on crash.
2. `clanky send "what's on the calendar"` returns an answer; same session resumable via `clanky tui --session <id>`.
3. Cron job `every 1h "scan recent commits and post a summary to Linear PROJ-123"` runs unattended and Linear receives the comment.
4. From a Claude Code instance with clanky mounted as MCP, calling `clanky.swarm.dispatch` spawns a herdr worker pane, the worker registers, claims, completes; clanky daemon mirrors status to Linear and notifies the originating session.
5. Two clanky daemons under different profiles (`work` / `personal`) cannot see each other's tasks or sessions.
6. Killing the daemon mid-task does not corrupt JSONL or SQLite; restart resumes cleanly and a re-dispatched task with the same `idempotency_key` is a no-op if already done.

---

## 18. What we explicitly steal vs invent

| Source | What we take | What we change |
|---|---|---|
| **Pi** | agent loop, providers, TUI primitives, RPC protocol, session JSONL, hook system, extension API | Wrap in daemon; add multiplexed RPC over UDS |
| **hermes-agent** | gateway pattern, cron design, profiles, skill loading model, swarm lifecycle pattern, dual-process TUI idea, mcp_serve.py shape | Reimplement in TypeScript on Pi's loop; drop platform adapters from v1 |
| **swarm-mcp** | the entire coordinator (mounted as subprocess MCP) | Nothing — consume its public tool API |
| **Claude Code skills** | filesystem layout + SKILL.md frontmatter | None |

The clanky-specific surface — gateway routing, TUI dashboard, Linear bridge, swarm-leader skill prompt — is the only new code that isn't an obvious port.

---

## Next action

Phase 0 is small enough to do in one sitting: scaffold `~/clanky`, install Pi packages, boot a `SessionRegistry` that creates and answers one prompt, end. Once that runs, Phase 1 (UDS + RPC TUI + `clanky send`) is the first user-facing milestone.
