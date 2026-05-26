---
name: clanky-discord-operator
description: Use Clanky's agent-owned Discord tools to inspect guilds/channels, read recent channel activity and media, send channel messages, upload attachments, and add reactions.
when_to_use: Use when the user asks what Discord servers or channels Clanky can see, asks Clanky to send or read a Discord message, wants recent Discord media or a digest, provides Discord IDs, or wants a reaction added.
allowed_tools:
  - discord_list_guilds
  - discord_list_channels
  - discord_read_messages
  - discord_recent_activity
  - discord_recent_attachments
  - discord_send_message
  - discord_list_emojis
  - discord_add_reaction
deps: []
---

# Clanky Discord Operator

Use the Discord tools directly when the user asks for ordinary Discord actions.

## Preferred workflow

- In the dedicated Discord subagent, rely on your own session continuity first. Use these tools when the current turn points at Discord history outside your context window, another channel, exact message IDs, or a send/reaction action.
- For questions like "what happened recently", "what's going on in the server", or "give me a Discord digest", prefer `discord_recent_activity` over manually reading many channels.
- For Discord media lookup, use `discord_recent_attachments` when the conversation context calls for finding or visually loading recent images, GIF previews, image links, embeds, or video keyframes.
- If the user references a specific Discord message, call `discord_recent_attachments` with both `channelId` and `messageId` so the lookup is pinned to that message instead of recent history.
- Treat "recently" as a short time window by default. If the user does not specify one, use a reasonable window such as the last 24 hours or 7 days depending on the question.
- Use `discord_list_channels` when you need channel IDs, channel names, or `lastMessageAt` metadata before deciding what to read.
- Use `discord_read_messages` when the user wants a specific channel, exact raw messages, or a tighter time-bounded read with `since` / `until`.
- Ignore stale channels by default. If a channel's newest visible activity is outside the requested time window, do not surface it unless the user asks for a fuller history.
- Only say you visually inspected media when `discord_recent_attachments` returns `loadedImages` / image blocks. If it only returns media metadata, say that you found media but did not inspect the pixels.

## ID handling

- A guild/server ID is not a text channel ID. If the user gives only a guild ID, call `discord_list_channels` and pick or ask for a type `0` text channel.
- A Discord user ID is not a DM channel ID. Do not pass a user ID to `discord_send_message` as `channelId`; it will fail with `Unknown Channel` unless a tool explicitly exposes DM-channel creation or lookup.
- For channel sends, use `discord_send_message` with a real text channel, thread, or DM channel ID.
- If the target is ambiguous, list available guilds/channels or ask one concise clarifying question.
- If only one visible guild obviously matches the request, use it instead of forcing the user to repeat the guild ID.

## Messaging policy

- Send exactly the user-requested content when clear.
- For vague requests like "send me a message," use a short harmless test message only after the destination is clear.
- Mention when a send target was resolved from a guild to a channel.
- Do not claim a message was sent unless the tool returns success; include the message ID when available.

## Response style

- Summarize active channels first, then expand into message details only if needed.
- When using `discord_recent_activity`, prefer concise per-channel takeaways over dumping raw logs.
- If nothing recent happened, say that plainly instead of surfacing old messages from months or years ago.
