---
name: clanky-work-tracker
description: Provider-neutral work tracker protocol for using configured tracker MCP servers, CLIs, or skills and binding tracker refs to Clanky sessions.
when_to_use: Use when CLANKY_WORK_TRACKER is configured and the user asks for durable work, implementation, debugging, review, status, issues, tickets, notifications, or follow-up.
allowed_tools:
  - mcp_list_tools
  - mcp_call
  - work_tracker_link
deps: []
---

# Clanky Work Tracker

Treat the configured work tracker as part of the working context. Do not wait for the user to remind you to use it when the task is durable work.

## Operating Model

- Use provider-specific MCP servers, CLIs, or skills for tracker actions such as creating issues, reading inboxes or notifications, commenting, assigning, and changing status.
- Use `work_tracker_link` only after an external tracker issue exists, so Clanky can remember which session maps to that provider issue.
- Prefer the same tracker provider and workspace/team that AgentRoom configured for this project when that context is available.
- If no tracker MCP/tool/skill is available, say `tracker_update_skipped` with the concrete reason. Do not pretend a tracker update happened.

## Native Behavior

- At the start of substantial implementation, debugging, review, or planning work, look for a relevant existing tracker issue before creating a new one.
- If the configured provider exposes inbox, notification, assigned-issue, or update-feed tools, check them at natural boundaries: when beginning work, before claiming status, and before finalizing. Do not busy-poll.
- Keep tracker comments short and useful: what changed, what was verified, and what risk remains.
- Preserve `providerKind`, `providerId`, external issue id, identifier, URL, session id, and relevant file scope when linking.

## MCP Pattern

Use `mcp_list_tools` first when exact server or tool names are unknown. Then call the provider tool through `mcp_call`, and finally call `work_tracker_link` with the issue returned by the provider.

## Provider: Linear

Linear is the active provider, reached through the Linear MCP/CLI/connector tool.

- Use the Linear MCP for issue creation, comments, and status changes; then call `work_tracker_link` with `providerKind: "linear"` to bind the issue to the Clanky session.
- Keep Linear comments concise and technical: the action taken, the verification performed, and any remaining risk.
- If Linear credentials or MCP tools are unavailable, report `tracker_update_skipped` with the reason.
