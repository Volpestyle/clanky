# Music Visualizer over Go Live — Implementation Plan

Status: implemented March 13, 2026

References:
- [`docs/native-discord-screen-share.md`](../native-discord-screen-share.md) — Go Live send/receive protocol
- [`src/voice/clankvox/src/stream_publish.rs`](../../src/voice/clankvox/src/stream_publish.rs) — current publish pipeline
- [`src/voice/clankvox/src/music.rs`](../../src/voice/clankvox/src/music.rs) — current music pipeline
- [`src/voice/voiceStreamPublish.ts`](../../src/voice/voiceStreamPublish.ts) — Bun-side publish orchestration

## Goal

When music is playing, stream a real-time audio visualizer through Go Live so
everyone in the voice channel sees it as a native Discord screen share. No
browser needed — the visualizer is generated inside clankvox from the same audio
stream that produces the opus voice output.

## Shipped Outcome

The shipped implementation keeps the design intent from this plan and wires it
through the existing music lifecycle:

- `voice.streamWatch.visualizerMode` is a real setting, exposed in the dashboard,
  with `"cqt"` as the default
- `music_play` can now start a shared `ffmpeg` pipeline that emits PCM audio for
  Discord voice and H264 visualizer access units for Go Live at the same time
- Bun uses `stream_publish_play_visualizer` to attach the publish transport to
  that already-running visualizer feed instead of starting a second fetch
- `"off"` preserves the legacy URL-backed source-video relay path
- non-YouTube audio sources work in visualizer mode as long as the music
  playback path resolved a playable URL for the active track

Canonical runtime documentation lives in
[`docs/voice/discord-streaming.md`](../voice/discord-streaming.md).

## What Exists Today

Two **separate** ffmpeg child processes run in clankvox:

```
Music pipeline (music.rs):
  yt-dlp -f bestaudio → ffmpeg → PCM s16le mono 48kHz → opus encode → voice connection

Publish pipeline (stream_publish.rs):
  yt-dlp -f bestvideo → ffmpeg → H264 Annex-B → DAVE encrypt → RTP → Go Live stream
```

These are independent. The publish pipeline pulls the **video** track from
YouTube, re-encodes it to H264, and sends it. The music pipeline pulls the
**audio** track and decodes it to PCM. They share a URL but not a process.

## Visualizer Architecture

Replace the two-process model with a **single ffmpeg process** that reads the
audio track and produces both PCM audio output and H264 visualizer video:

```
yt-dlp -f bestaudio → ffmpeg -i pipe:0
                         │
                         asplit
                         ├── [passthrough] → PCM s16le 48kHz → opus → voice connection
                         └── [viz] → showcqt/showspectrum → libx264 → H264 → DAVE → RTP → Go Live
```

### Why One Process

- **Sync**: audio and video share the same source timebase. No drift, no clock
  alignment code.
- **Simpler**: one child process to spawn, monitor, and kill instead of two.
- **Cheaper**: yt-dlp fetches the stream once, not twice (no separate bestvideo
  download).

## Implementation Steps

### 1. New ffmpeg command builder in `stream_publish.rs`

Add a `build_visualizer_pipeline_command` function alongside the existing
`build_stream_publish_pipeline_command`. This produces a single command that
outputs PCM audio on one pipe and H264 video on another:

```rust
pub(crate) fn build_visualizer_pipeline_command(
    url: &str,
    resolved_direct_url: bool,
    visualizer: VisualizerMode,
) -> String {
    let filter = match visualizer {
        VisualizerMode::Spectrum => format!(
            "showspectrum=s={W}x{H}:slide=scroll:color=magma:scale=cbrt:fscale=log:orientation=vertical"
        ),
        VisualizerMode::Cqt => format!(
            "showcqt=s={W}x{H}:fps={FPS}:sono_v=18:bar_v=12:axis=0"
        ),
        VisualizerMode::Waves => format!(
            "showwaves=s={W}x{H}:mode=cline:rate={FPS}:scale=sqrt:colors=0x00ff88"
        ),
        VisualizerMode::Vectorscope => format!(
            "avectorscope=s={H}x{H}:mode=lissajous:draw=line:zoom=1.5:scale=sqrt:rate={FPS},pad={W}:{H}:(ow-iw)/2:0:black"
        ),
    };

    // asplit branches the audio: one to visualizer, one to PCM passthrough
    let filter_complex = format!(
        "[0:a]asplit=2[viz][pass];\
         [viz]{filter},format=yuv420p[v]"
    );

    // fd 1 (stdout) = H264 video, fd 3 = PCM audio
    format!(
        "ffmpeg -nostdin -loglevel error -re -i pipe:0 \
         -filter_complex \"{filter_complex}\" \
         -map \"[v]\" -c:v libx264 -preset ultrafast -tune zerolatency \
         -pix_fmt yuv420p -profile:v baseline -level 3.1 \
         -g {FPS} -keyint_min {FPS} -sc_threshold 0 \
         -b:v {BITRATE}k -maxrate {BITRATE}k -bufsize {BUF}k \
         -f h264 -bsf:v h264_metadata=aud=insert pipe:1 \
         -map \"[pass]\" -f s16le -ar 48000 -ac 1 pipe:3"
    )
}
```

Key flags:
- `-re` reads at realtime speed (prevents ffmpeg from racing ahead)
- `-preset ultrafast -tune zerolatency` minimizes encode latency
- `-bsf:v h264_metadata=aud=insert` adds AUD NAL delimiters for frame boundary detection
- `pipe:3` uses fd 3 for audio output (avoids mixing with video on stdout)

### 2. Unified player mode in `stream_publish.rs`

Add a `StreamPublishPlayerMode::Visualizer` variant. When this mode is active:

- Spawn the ffmpeg process with the visualizer command
- Open fd 3 on the child process for PCM audio reads
- Read H264 access units from stdout (existing `split_h264_access_units` logic)
- Read PCM samples from fd 3 and forward to `music_pcm_tx` (same channel the
  music player uses today)
- The playback supervisor's opus encode loop picks up PCM from `music_pcm_tx` as
  normal — no change needed in the audio path

The unified player replaces both `MusicPlayer` and `StreamPublishPlayer` for
visualizer-mode playback.

### 3. Bun-side orchestration in `voiceStreamPublish.ts`

The existing publish orchestration already binds to music lifecycle events:
- music play → `stream_publish_connect` + `stream_publish_play`
- music pause → `stream_publish_pause` + OP22 paused
- music stop → `stream_publish_stop` + `stream_publish_disconnect` + OP19

For visualizer mode, the change is:
- Instead of sending `stream_publish_play` (which starts the video-only pipeline)
  AND letting `music.rs` start a separate audio pipeline, send a new
  `stream_publish_play_visualizer` IPC command that tells clankvox to start the
  unified pipeline.
- clankvox feeds both audio PCM (to the opus encode path) and H264 video (to the
  stream publish path) from the single ffmpeg process.
- Pause, resume, stop work the same way — one process to manage.

### 4. Visualizer mode selection

Add a setting under `voice.streamWatch`:

```
visualizerMode: "cqt" | "spectrum" | "waves" | "vectorscope" | "off"
```

Default: `"cqt"` (showcqt is the most visually musical).

When `"off"`, the current two-process behavior is preserved (video track
from YouTube + separate audio track).

### 5. Source gating

The existing publish source gate only allows YouTube-backed music URLs.
Visualizer mode should use the same gate — if the source is publishable, the
visualizer can render it. No new source restrictions needed.

Non-YouTube audio sources (direct MP3 URLs, etc.) also work since the
visualizer only needs audio input, not a video track.

## ffmpeg Filter Reference

Ranked by visual quality for music:

### `showcqt` (recommended default)

Constant-Q transform — maps frequencies to a musical (piano) scale. Dual
display: reactive bars on top, falling spectrogram waterfall below.

```
showcqt=s=960x540:fps=30:sono_v=18:bar_v=12:sono_g=4:bar_g=2:axis=0
```

Key params: `sono_v` (waterfall brightness), `bar_v` (bar height), `axis=0`
(hide note labels), `cscheme` (channel coloring).

### `showspectrum`

Scrolling spectrogram with configurable color maps. Rich visual detail.

```
showspectrum=s=960x540:slide=scroll:color=magma:scale=cbrt:fscale=log
```

Color modes: `magma`, `fire`, `viridis`, `plasma`, `nebulae`, `cool`.
`fscale=log` gives piano-like frequency spacing.

### `avectorscope`

Stereo field Lissajous patterns. Abstract, hypnotic. Best in square aspect
ratio, padded to 16:9 for Discord.

```
avectorscope=s=540x540:mode=lissajous:draw=line:zoom=1.5:scale=sqrt,pad=960:540:(ow-iw)/2:0:black
```

### `showwaves`

Classic oscilloscope waveform. Simple and clean.

```
showwaves=s=960x540:mode=cline:rate=30:scale=sqrt:colors=0x00ff88
```

## File Changes Summary

| File | Change |
|------|--------|
| `src/voice/clankvox/src/stream_publish.rs` | `build_visualizer_pipeline_command`, `VisualizerMode`, publish attach path for shared visualizer frames |
| `src/voice/clankvox/src/music.rs` | shared music player source that can emit PCM audio and H264 visualizer frames from one process |
| `src/voice/clankvox/src/playback_supervisor.rs` | routes `music_play` visualizer mode and `stream_publish_play_visualizer` through the shared pipeline |
| `src/voice/clankvox/src/ipc.rs` + `src/voice/clankvox/src/ipc_protocol.rs` | `visualizerMode` on `music_play` plus `StreamPublishPlayVisualizer` IPC support |
| `src/voice/voiceMusicPlayback.ts` | passes configured visualizer mode into `music_play` and stores the resolved playback URL |
| `src/voice/voiceStreamPublish.ts` | selects visualizer vs legacy publish path from session music state |
| `src/voice/clankvoxClient.ts` | `streamPublishPlayVisualizer` IPC method |
| `src/voice/voiceSessionTypes.ts` | `visualizerMode` and last playback source metadata on publish/music state |
| `dashboard/src/settingsFormModel.ts` + `dashboard/src/components/settingsSections/VoiceModeSettingsSection.tsx` | dashboard support for `voice.streamWatch.visualizerMode` |

## Risks and Constraints

- **CPU cost**: `showcqt` is the heaviest filter. At 960x540@30fps on a modern
  machine this is fine, but constrained environments may need `showwaves` or
  lower resolution.
- **fd 3 portability**: Rust `Command` can open extra file descriptors on Unix
  via `CommandExt::pre_exec` with pipe2/dup2. This is Unix-only (fine for the
  current deployment target).
- **Audio channel count**: Music pipeline uses mono (`-ac 1`). Visualizers like
  `avectorscope` need stereo to show stereo field. Could use `-ac 2` for the
  viz branch only via the filter graph.
- **Latency**: `-tune zerolatency` + `-preset ultrafast` keeps H264 encode
  latency under one frame. The visualization filters themselves add minimal
  latency (one window of audio samples).
- **Fallback**: If visualizer ffmpeg fails to start, fall back to the current
  two-process model (video track publish + separate audio).
