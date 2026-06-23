---
description: Use when the user mentions MCP servers or external MCP-powered capabilities such as Minecraft.
---

# MCP

Use `mcp_list_tools` to discover configured MCP servers and exact tool schemas.
Use `mcp_call` only after the target server and tool are known. `mcp_call` is
approval-gated because MCP tools can affect external systems.

This dynamic MCP layer is only for runtime-added no-auth or static-token servers:
local tools, automations, Minecraft, and throwaway experiments. Do not use it for
OAuth or shared-credential SaaS such as Linear, Figma, Robinhood, finance, or work
trackers; those must be eve connections in `agent/connections/<name>.ts`.

Configured servers come from:

- `~/.clanky/mcp-servers.json`
- `CLANKY_MCP_SERVERS` JSON in the process environment

Use `mcp_configure` only when the user asks to add or update a server. For a
Minecraft MCP, configure the server the user provides, then list tools before
trying to move, chat, mine, craft, or interact in-world.
