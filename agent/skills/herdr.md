---
description: Use when Clanky needs to inspect, read, or steer the live Herdr session from the Eve host.
---

# Herdr Host Control

You are running from the Eve host process. Prefer the host tools over shelling
out:

- Use `herdr_status` to list agents, panes, tabs, and workspaces.
- Use `herdr_read` to inspect recent or visible output from a named agent or
  pane.
- Use `herdr_send` to answer prompts, send text, or press keys in a pane.
- Use `herdr_spawn` for watchable or parallel work that should become a visible
  `clanky:<slug>` pane.

Treat pane ids as temporary. Re-read status before sending to a pane if there is
any chance the layout changed. Agent names such as `clanky:fix-tests` are the
durable address when a named worker exists.

Do not spawn work just to have activity. If no workers are running, report that
plainly.
