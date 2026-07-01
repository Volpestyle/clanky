# Clanky skills

Bundled skills loaded from disk by the eve Clanky agent. Each is a directory with
a `SKILL.md` (frontmatter + protocol) and optional `scripts/`. A skill is just a
disk-loaded play-this-way document plus its allowed tools and deps — eve gates
each one behind a `when_to_use` trigger and the listed `allowed_tools`.

Two kinds live here: the current mux adapter skill (`herdr`, every agent gets it,
no fork) and Clanky-authored `clanky-*` operator/worker protocols. See
[SPEC.md](../SPEC.md) §4.5 (skills model) and §5.5 (fan-out / swarm
orchestration) for the authoritative design; the rule of thumb is a new skill
only when both the trigger and the audience differ from an existing one.

## Swarm coordination

How Clanky and his performers see each other and fan work out across visible
terminal-stage panes. Herdr is the current/default mux adapter, but the protocol
should stay mux-agnostic so tmux, Zellij, or other adapters can expose equivalent
status/read/send/spawn semantics. The operator/worker pair splits on role: the
coordinator drives the fan-out, each worker follows inside its own pane.

| Skill | Audience | What it does |
| --- | --- | --- |
| [`herdr`](herdr/SKILL.md) | every agent (current adapter) | Control the current Herdr-backed stage: manage workspaces/tabs, split panes, spawn agents, read output, wait for state changes, and report presence — over the local unix socket. The flat "everyone sees everyone" layer. |
| [`clanky-herdr-operator`](clanky-herdr-operator/SKILL.md) | coordinator only | Run parallel subagents as named terminal-stage panes through the Herdr adapter: spawn workers into a tagged run tab, monitor and unblock them, harvest per-worker results, synthesize, and clean up. |
| [`clanky-herdr-worker`](clanky-herdr-worker/SKILL.md) | worker pane | The worker side of the mux-agnostic protocol: how an agent spawned by Clanky as `clanky:<slug>` reports status and coordinates from inside its visible pane. |

## Channels and trackers

Operators for Clanky's curated external surfaces. Each routes to the configured
connection, CLI, or official upstream skill rather than guessing an API.

| Skill | What it does |
| --- | --- |
| [`clanky-discord-operator`](clanky-discord-operator/SKILL.md) | Native Discord tools: inspect guilds/channels, read recent activity and media, send messages, upload attachments, add reactions, and go live. |
| [`clanky-work-tracker`](clanky-work-tracker/SKILL.md) | Provider-neutral work-tracker protocol over Clanky's configured tracker connection, CLI, or skill (Linear, GitHub Issues, Jira). |
| [`clanky-figma-operator`](clanky-figma-operator/SKILL.md) | Conventions for the curated Figma connection, routing to Figma's official `figma-*` skills for Plugin API depth. |

## Web and browser

Live lookup and real-browser automation, in preference order.

| Skill | What it does |
| --- | --- |
| [`clanky-web-operator`](clanky-web-operator/SKILL.md) | Power-user policy for live lookup, URL inspection, rendered pages, `browser_control`, and Playwright fallback. The entry point for "what's current" web work. |
| [`clanky-playwright-browser`](clanky-playwright-browser/SKILL.md) | Playwright from Clanky's local CLI for general browsing, page extraction, screenshots, and repeatable automation. |
| [`clanky-chrome-cdp`](clanky-chrome-cdp/SKILL.md) | Legacy fallback for Chrome DevTools Protocol work when the user already supplies a running CDP endpoint. Prefer `browser_control` or Playwright otherwise. |

## Media

| Skill | What it does |
| --- | --- |
| [`clanky-media-operator`](clanky-media-operator/SKILL.md) | Route image and video generation across OpenAI Images, Gemini (Nano Banana), and xAI Grok Imagine image/video. |

## Diagnostics

| Skill | What it does |
| --- | --- |
| [`clanky-log-dive`](clanky-log-dive/SKILL.md) | Inspect Clanky's local eve/herdr runtime status, Discord presence panes, voice symptoms, and performance/cost signals when debugging recent sessions. |

> Skills inherited from the host Codex/Claude skill roots are advertised
> separately at runtime through `/skills` and relay `list-skills`; only the
> Clanky-bundled skills above live in this directory.
