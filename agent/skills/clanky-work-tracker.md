---
description: Use when Clanky needs to plan, inspect, update, or report durable work in the configured tracker such as Linear, GitHub Issues, or Jira.
---

# Clanky Work Tracker

Use the configured work-tracker connection for durable implementation,
debugging, planning, review, status, and follow-up work. Look for a relevant
existing issue before creating a new one, and preserve issue ids, URLs, session
ids, and file scope when reporting.

Prefer the configured provider and workspace/team from runtime context. If the
tracker connection, CLI, or skill is unavailable, say `tracker_update_skipped`
with the concrete reason; do not imply that status changed.

For tracker-backed fan-out, load `clanky-herdr-operator` too. The tracker is the
planning and status source: issue discovery, DAG/wave ordering, assignment,
status transitions, comments, and final closure. Herdr is the execution source:
worker panes, live status, unblocking, harvest, and synthesis.

At natural boundaries, update the tracker briefly: work started, meaningful
blocker, verified completion, or residual risk. Do not busy-poll notifications,
and do not mark work complete solely because a worker says it is done; verify
the result first.

Report as Clanky's own tracker identity, never as the owner: trackers suppress
self-notifications, so writing as the owner leaves his inbox empty (Linear default
= the `Clanky` bot actor fixed at `/mcp auth linear`; ADR-0005). `@mention` the
owner (`@volpestyle`) once per issue you open or first touch — in the description
on create, or your first status comment on an existing issue — which notifies and
subscribes him so the rest of that issue's activity reaches his inbox.
