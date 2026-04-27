# Media

This document is the canonical product-level guide to media in the selfbot:
what the agent can do, how those capabilities fit together, and which deep-dive
docs own the transport internals.

Media is one system here, not a pile of separate modes. The same autonomous
brain can decide to:

- play music
- play a YouTube video
- search for options first
- browse the web visually before deciding
- start watching a live Discord screen share

The product contract is capability-first: the brain sees available context and
tools, then decides what helps most.

## Media Surfaces

### Music playback

Core tools:

- `music_play`
- `music_search`
- `music_queue_next`
- `music_queue_add`
- `media_stop`
- `media_pause`
- `media_resume`
- `media_skip`
- `media_now_playing`
- `media_reply_handoff`

Use this surface for ordinary audio-first listening and queue control.

Deep dive: [`../voice/music.md`](../voice/music.md)

### Video playback

Core tools:

- `video_play`
- `video_search`

This surface reuses the same underlying playback/disambiguation machinery as
music, but it constrains lookup to YouTube and is intended for “put a video on”
requests.

If the request is specific enough, `video_play` should resolve and start
playback directly. If the request is ambiguous, the brain can use
`video_search`, ask a follow-up question, or use `browser_browse` when seeing
the YouTube page/thumbnails would help.

Outbound native self publish is a runtime capability behind this surface. The
model does not need a separate “start stream publish” tool for ordinary video
playback.

Deep dives:

- [`../voice/music.md`](../voice/music.md)
- [`../voice/discord-streaming.md`](../voice/discord-streaming.md)

### Video context extraction

Core tool:

- `video_context`

Agent-initiated tool for extracting metadata, transcripts, and keyframe images
from video URLs and animated GIFs. Supports YouTube (custom scraper, no
external deps), plus TikTok, X/Twitter, Reddit, Twitch, Streamable, Tenor/Giphy
GIF pages, and any other yt-dlp-supported source when yt-dlp and ffmpeg are
available on the host.

The agent decides when to call this tool. It is preferred over `web_scrape` or
`browser_browse` when the goal is video-specific content like transcripts or
metadata. For pages requiring JS rendering or interaction, the agent falls back
to `browser_browse`.

Current-turn Discord video uploads, animated GIF uploads, and coalesced
video/GIF links are surfaced to the model as `VID n` references in prompt
context. The model may call `video_context` with a direct `url` or with a
`videoRef` like `VID 1`.

When a user explicitly asks what is in a GIF/video and a current-turn `VID n`
reference exists, the reply pipeline pre-inspects the media with
`video_context` and attaches sampled keyframes before the first reply model
call. If extraction is unavailable or fails, the prompt says that no visual
evidence is available so the model should not bluff from the URL or filename.

Direct video URLs (for example Discord CDN `.mp4`/`.webm`) and direct `.gif`
URLs are processed without `yt-dlp`. Non-direct hosts can use `yt-dlp` when
available. Keyframe and ASR fallback extraction rely on `ffmpeg`.

Keyframe sampling is duration-aware. Before running `ffmpeg`, the service
probes clip duration with `ffprobe`; if the clip is shorter than
`keyframeIntervalSeconds × maxKeyframesPerVideo` the interval is compressed to
`duration / maxKeyframesPerVideo` (floored at ~1/15s) so a short looping GIF
still yields up to `maxKeyframesPerVideo` evenly-spaced frames instead of one.
The probed duration also backfills `durationSeconds` on direct sources whose
summary path doesn't expose it, so logs and prompts no longer report
`durationSeconds: null` for Tenor/Giphy MP4s once frames are extracted.

Missing `ffmpeg` or `yt-dlp` is reported as a local runtime dependency blocker,
not as weak visual evidence. The context payload and logs include
`missingDependencies` plus `keyframeErrorCode` / `transcriptErrorCode`, and the
prompt/tool result says that no GIF/video pixels were inspected until the
operator installs the dependency and restarts the bot.

Settings: `media.videoContext` controls enablement and extraction parameters
(transcript length, keyframe interval, ASR fallback).

Current tool surface: `video_context` is available to the text/reply-loop
orchestrator. Voice prompts can still include video links and playback context,
but provider-native realtime does not expose `video_context` until there is a
voice executor for the extraction flow.

### Screen watch

Core tool:

- `start_screen_watch`

This is the inbound visual-context surface. The model does not choose between
native Discord watch and the share-link fallback directly. Runtime does.

Deep dives:

- [`../voice/screen-share-system.md`](../voice/screen-share-system.md)
- [`../voice/discord-streaming.md`](../voice/discord-streaming.md)

### Browser visual context

Core tools:

- `browser_browse`
- `share_browser_session`
- `stop_video_share`

This is not “media playback,” but it is part of the same visual system because
the browser can be both:

- a reasoning tool for choosing media
- a live visual source for outbound native stream-publish flows

In text replies, images returned by tools can stay private reasoning context or
be attached to the final Discord message if the brain explicitly chooses that
output shape. Tool images are not auto-posted just because they exist.

Headless browser sessions still render pixels. The runtime can capture those
offscreen frames without requiring a visible window.

Deep dives:

- [`browser.md`](browser.md)
- [`../voice/discord-streaming.md`](../voice/discord-streaming.md)

### Image history context

Current-message image attachments and current-turn direct image links can be
sent directly to a vision-capable model as part of the reply turn. Animated
GIFs are treated as motion media instead of still images so the video-context
path can sample frames. Recent image references from channel history are
captioned in the background and cached so later turns can search or recall them
without re-reading the image every time.

For URL-backed images, including Discord CDN attachment URLs, Bun fetches the
image bytes first and sends base64 image data to the vision model. Providers do
not receive Discord CDN URLs to download server-side. If the runtime can no
longer fetch the URL, the caption is skipped and the existing cached caption, if
any, remains the available context.

## Autonomy Rules

The brain should not follow a rigid ladder like:

`if ambiguous -> browser -> if failed -> search`

Instead:

- use `music_play` / `video_play` for ordinary "play this now" requests
- use `music_search` / `video_search` when the user explicitly wants options
- use `video_context` when a shared link is a video and you want transcript/metadata
- use `web_scrape` for lightweight page text extraction
- use `browser_browse` when page appearance, thumbnails, or navigation matter
- use `share_browser_session` when the user should see the live browser itself
- use `start_screen_watch` when live visual context would materially help

The point is not to encode a flowchart. The point is to give the agent enough
capabilities to choose well.

## Runtime Ownership

High level:

- Bun owns prompts, tool routing, session lifecycle, discovery/control-plane
  logic, memory, and dashboard state.
- `clankvox` owns the Discord media plane: RTP, Opus, DAVE, audio output, and
  native Go Live stream transport.

That means media behavior is split between product orchestration in Bun and
transport/media execution in Rust.

Deep dives:

- [`../architecture/overview.md`](../architecture/overview.md)
- [`../voice/voice-provider-abstraction.md`](../voice/voice-provider-abstraction.md)
- [`../../src/voice/clankvox/README.md`](../../src/voice/clankvox/README.md)

## Current Shape

As of this repo snapshot:

- music playback is fully shipped
- `video_play` / `video_search` exist as product-layer capabilities on top of
  the playback stack
- native Discord screen watch is validated live end to end
- native outbound self publish exists as runtime transport work, with the
  product surface intentionally kept narrower than the underlying transport
- browser sessions can already feed native outbound browser share flows, even
  when headless

## Deep-Dive Ownership

Use the following split:

- product behavior and capability boundaries: this document
- music queue/playback/disambiguation semantics: [`../voice/music.md`](../voice/music.md)
- inbound screen-watch pipeline and prompt context: [`../voice/screen-share-system.md`](../voice/screen-share-system.md)
- Discord-native Go Live watch/publish transport: [`../voice/discord-streaming.md`](../voice/discord-streaming.md)
- browser runtime/session behavior: [`browser.md`](browser.md)

Historical planning doc:

- [`../archive/selfbot-stream-watch.md`](../archive/selfbot-stream-watch.md) remains useful as an
  implementation narrative, but it is not the primary product doc anymore

Product language: media is one agentic capability family. Music, video, screen
watch, and browser vision are different entry points into the same shared
context-and-action system.
