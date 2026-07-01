---
name: clanky-work-tracker
description: Provider-neutral work tracker protocol for using Clanky's configured work-tracker connection, CLIs, or skills.
when_to_use: Use when SELF.md, the project's AGENTS.md, or the user designates a work tracker (Linear, GitHub Issues, Jira) and the task involves durable work, implementation, debugging, review, status, issues, tickets, notifications, or follow-up.
allowed_tools: []
deps: []
---

# Clanky Work Tracker

Treat the configured work tracker as part of the working context. Do not wait for the user to remind you to use it when the task is durable work.

## Operating Model

- Use the configured work-tracker role first. The default is the curated Linear connection in `agent/connections/linear.ts`, exposed through eve connection tools, not the dynamic MCP bridge.
- Use provider-specific connection tools, CLIs, or skills for tracker actions such as creating issues, reading inboxes or notifications, commenting, assigning, and changing status.
- Prefer the tracker provider and workspace/team already configured for this project when that context is available.
- If no tracker connection/tool/skill is available, say `tracker_update_skipped` with the concrete reason. Do not pretend a tracker update happened.

## Native Behavior

- At the start of substantial implementation, debugging, review, or planning work, look for a relevant existing tracker issue before creating a new one.
- If the configured provider exposes inbox, notification, assigned-issue, or update-feed tools, check them at natural boundaries: when beginning work, before claiming status, and before finalizing. Do not busy-poll.
- Keep tracker comments short and useful: what changed, what was verified, and what risk remains.
- Preserve external issue id, identifier, URL, session id, and relevant file scope when reporting or cross-referencing tracker work.
- For tracker-backed fan-out, pair this with `clanky-herdr-operator`. The tracker owns issue discovery, DAG/wave ordering, assignment, status transitions, comments, and final closure; the terminal stage owns visible worker execution, live state, unblocking, harvest, and synthesis.
- Do not mark an issue done solely because a worker reports completion. The operator verifies the result first, then updates tracker status.

## Living Docs (evolution log)

- Some tracker artifacts are logs, not snapshots — demo recordings, status updates, decision records. Refresh them by appending a new dated entry, not by overwriting the prior content.
- Keep one running Linear document (or description) per artifact, newest entry on top, each under a `## YYYY-MM-DD — <label>` heading. Use actual ISO dates, never "now"/"earlier". Reframe a superseded entry as historical rather than deleting it.
- Before replacing any existing doc/description, capture its current content first so a prior version is never lost. Linear keeps document history, but do not treat it as your only copy.
- Media embedded in an older entry stays valid: keep the old `![alt](assetUrl)` embed. The underlying upload persists and Linear re-signs the URL on save.

## Connection Pattern

Use the configured role binding (`CLANKY_WORK_TRACKER` or `~/.clanky/integration-roles.json`) to identify the provider. If exact connection tools are unknown, discover them through eve's connection tool surface, then call the provider tool directly. Dynamic `mcp_list_tools` / `mcp_call` is only for runtime no-auth/static-token MCP servers, not OAuth work trackers.
