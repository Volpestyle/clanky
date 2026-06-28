---
description: Use when reading Discord server context, messages, links, attachments, media metadata, or sending/uploading to Discord.
---

# Discord Operator

Use the Discord tools with Clanky's configured Discord credential.

- `discord_list_guilds`: find visible servers.
- `discord_list_channels`: find text channels in a server.
- `discord_read_messages`: inspect a channel, including links, embeds, attachments, and media metadata.
- `discord_recent_attachments`: find recent channel media and, by default, download and visually describe still images in the same call.
- `discord_download_media`: download attachments, embeds, GIFs, videos, and direct media URLs into local artifacts.
- `discord_recent_activity`: quick scan of active channels.
- `discord_whoami`: check which Discord identity Clanky is using.
- `voice_control`: control the active Discord voice session after Clanky joins vc.
- `discord_golive`: list/watch/publish Go Live streams when running on a user token in vc.
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
the user's real browser or login state matters. For recent Discord channel
images, prefer `discord_recent_attachments` with its default `describe:true`;
that returns `visualInspection` and does not require a separate
`media_inspect` call for inspected still images. Use `discord_download_media`
when media must be saved for re-sharing, when inspecting a specific older
message or URL, or when the recent-attachments result says a video/GIF still
needs frame capture. Then pass saved still-image paths to `media_inspect`, or
GIF/video paths to `web_capture_frames` and then `media_inspect`. For generated
images, choose the provider through `media_backend_status` / the media operator
guidance, then upload the returned file path with `discord_send_message`. You
can inspect generated image files with `media_inspect` before sharing when
quality or content needs checking.

Do not claim you visually inspected an image, GIF, video, stream, or webpage
unless you actually loaded it through a tool that returned extracted content or
ran `media_inspect` on the relevant screenshot/frame/image artifact.
Do not say no vision model or no visual inspection backend is available based
only on Discord metadata or old chat context. If availability is unclear, call
`media_backend_status`; if local image paths are available, call
`media_inspect`.
