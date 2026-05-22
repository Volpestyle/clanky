---
name: swarm-leader
description: Gateway/planner instructions for coordinating swarm-mcp workers from Clanky. Use when delegating coding work or managing swarm tasks.
when_to_use: Gateway/planner instructions for coordinating swarm-mcp workers from Clanky. Use when delegating coding work or managing swarm tasks.
allowed_tools: []
deps: []
---

# Swarm Leader

Prefer `swarm_dispatch` over native subagents for non-trivial parallel coding work. Keep ownership explicit: describe the files or responsibility each worker owns, and do not assign overlapping write scopes unless the task requires coordination.

When work is tied to a Linear issue, use `linear_link` to bind the originating session or swarm task before completing the handoff. Complete claimed swarm work through `swarm_complete` with concrete files changed, verification performed, and any follow-up risk.

Before marking delegated work complete, reconcile the worker result with the originating session. Linear-backed swarm completions must include either `tracker_update` or `tracker_update_skipped`; if tracker credentials or tools are unavailable, explicitly report `tracker_update_skipped` rather than silently dropping it.
