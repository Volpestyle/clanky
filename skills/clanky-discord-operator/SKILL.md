---
name: clanky-discord-operator
description: Use Clanky's Discord MCP integration to inspect guilds/channels, read recent channel activity and media, send channel messages, upload attachments, and add reactions.
when_to_use: Use when the user asks what Discord servers or channels Clanky can see, asks Clanky to send or read a Discord message, wants recent Discord media or a digest, provides Discord IDs, or wants a reaction added.
allowed_tools:
  - mcp_list_tools
  - mcp_call
deps: []
---

# Clanky Discord Operator

Use the `discord` MCP server through `mcp_call`. Clanky auto-registers this server from the local `discord-mcp` package unless `CLANKY_DISCORD_MCP=0`.

## MCP tools

- `discord_whoami`
- `discord_list_guilds`
- `discord_list_channels`
- `discord_read_messages`
- `discord_recent_activity`
- `discord_recent_attachments`
- `discord_send_message`
- `discord_list_emojis`
- `discord_add_reaction`

Example:

```json
{
  "server": "discord",
  "tool": "discord_recent_attachments",
  "arguments": {
    "channelId": "123",
    "messageId": "456",
    "mediaLimit": 4,
    "load": true
  }
}
```

## Preferred workflow

- In the dedicated Discord subagent, rely on your own session continuity first. Use MCP when the current turn points at Discord history outside your context window, another channel, exact message IDs, media, or a send/reaction action.
- For "what happened recently", "what's going on in the server", or Discord digests, prefer `discord_recent_activity`.
- For Discord media lookup, use `discord_recent_attachments` for recent images, GIF previews, image links, embeds, or video keyframes.
- If the user references a specific Discord message, call `discord_recent_attachments` with both `channelId` and `messageId`.
- Only say you visually inspected media when `discord_recent_attachments` returns `loadedImages` or image blocks. Metadata-only media is not visual inspection.
- Keep reads bounded with `since`, `limit`, `messageLimit`, and `mediaLimit`.

## ID handling

- A guild/server ID is not a text channel ID. If the user gives only a guild ID, call `discord_list_channels` and pick or ask for a type `0` text channel.
- A Discord user ID is not a DM channel ID. Do not pass a user ID to `discord_send_message` as `channelId`.
- For channel sends, use a real text channel, thread, or DM channel ID.
- If the target is ambiguous, list available guilds/channels or ask one concise clarifying question.

## Messaging policy

- Send exactly the user-requested content when clear.
- For vague requests like "send me a message," use a short harmless test message only after the destination is clear.
- Do not claim a message was sent unless the tool returns success; include the message ID when available.

## AgentRoom boundary

AgentRoom owns room state and Discord projection semantics. Use AgentRoom MCP tools for room coordination, and use Discord MCP tools only for Discord-specific reads/actions.
