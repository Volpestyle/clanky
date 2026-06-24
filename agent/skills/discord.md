---
description: Use when reading Discord server context, messages, links, attachments, media metadata, or sending/uploading to Discord.
---

# Discord Operator

Use the Discord tools with Clanky's configured Discord credential.

- `discord_list_guilds`: find visible servers.
- `discord_list_channels`: find text channels in a server.
- `discord_read_messages`: inspect a channel, including links, embeds, attachments, and media metadata.
- `discord_recent_attachments`: find recent channel media and optionally download it for inspection.
- `discord_download_media`: download attachments, embeds, GIFs, videos, and direct media URLs into local artifacts.
- `discord_recent_activity`: quick scan of active channels.
- `discord_whoami`: check which Discord identity Clanky is using.
- `discord_list_emojis`: list guild custom emojis and reaction strings.
- `discord_add_reaction`: react to a message with Unicode or custom emoji.
- `discord_send_message`: post text or upload local files.

Accepted live Discord messages can include small image/GIF attachments inline in
the turn payload, plus attachment and embed metadata in the prompt. Older
messages, large files, videos, and non-inline media still need explicit tool
inspection.

When a message contains links to YouTube, X, web pages, GIFs, or other media,
inspect static pages with `web_fetch` and rendered/social/video preview pages
with `web_render` or `web_capture_frames`. Use `web_capture_frames` for GIFs,
videos, and links where motion/timing matters. Use `browser_control` only when
the user's real browser or login state matters. Use `discord_download_media`
when the message has an image, GIF, video, or Discord CDN attachment that needs
to be saved locally for inspection or re-sharing; then pass the saved local path
to `media_inspect` for still images, or to `web_capture_frames` and then
`media_inspect` for GIF/video visual sampling. For generated images, call
`openai_image_generate` first, then upload the returned file path with
`discord_send_message`. You can inspect generated image files with
`media_inspect` before sharing when quality or content needs checking.

Do not claim you visually inspected an image, GIF, video, stream, or webpage
unless you actually loaded it through a tool that returned extracted content or
ran `media_inspect` on the relevant screenshot/frame/image artifact.
Do not say no vision model or no visual inspection backend is available based
only on Discord metadata or old chat context. If availability is unclear, call
`media_backend_status`; if local image paths are available, call
`media_inspect`.
