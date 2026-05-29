---
name: linear-bridge
description: Rules for mirroring Clanky or swarm task state into Linear. Use when creating, updating, or commenting on Linear issues from agent work.
when_to_use: Rules for mirroring Clanky or swarm task state into Linear. Use when creating, updating, or commenting on Linear issues from agent work.
allowed_tools:
  - mcp_list_tools
  - mcp_call
  - work_tracker_link
deps: []
---

# Linear Bridge

Keep Linear comments concise and technical. Include the action taken, verification performed, and any remaining risk. Use the installed Linear MCP, CLI, or connector tool for Linear-specific issue creation, comments, and status changes. Use Clanky's provider-neutral `work_tracker_link` tool only to bind the resulting Linear issue to the Clanky session, with `providerKind: "linear"`. When linking agent work, preserve the originating session id and relevant file scope.

If Linear credentials or MCP tools are not available, report `tracker_update_skipped` with the reason.
