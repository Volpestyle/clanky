# 2026-04-27 — "look at that gif again": only one keyframe was sent

- **Instance:** `clanky`
- **Guild / channel:** `1052402897645752351` / `1052402898140667906`
- **GIF in question:** `https://media.tenor.com/rAWXcy9O6XUAAAPo/wow-taiko.mp4` (Tenor MP4 of a short looping GIF — a small creature spin-licking the air with a shovel/pan)
- **Turns covered:**
  - Turn A (initial "tell me what is the main point of this gif"): trigger `1498088693691453571` at `2026-04-26T22:29:37.762Z`
  - Turn B (followup "what does wifi taste like"): trigger `1498088964098232451` at `2026-04-26T22:30:42.235Z`
  - Turn C ("clanky take a look at that gif again"): trigger `1498131354926321806` at `2026-04-27T01:19:08.895Z`, reply `1498131452444020957` at `01:19:32.441Z`
- **Model:** `openai-oauth:gpt-5.5`

## Conversation Timeline

```
22:29:37  smelly conk : clanky, tell me what is the main point of this gif
                       (https://media.tenor.com/rAWXcy9O6XUAAAPo/wow-taiko.mp4)
22:29:47  clanky      : "the main point is: little creature has entered maximum
                        rotational brain damage mode and is licking the air like
                        it's tasting wifi … pure 'no thoughts, only spin' propaganda"
                                                          [HALLUCINATED — no pixels]

22:30:42  smelly conk : "licking the air like its tasting wifi" please tell me
                        more about what wifi tastes like
22:30:55  clanky      : "wifi tastes like licking a 9-volt battery that just got
                        done watching tiktok for 6 hours…"
                                                          [doubles down on hallucination]

— commit cb17236 ("Inspect GIF media before visual replies") lands ~00:43Z —

01:19:08  donky conk  : clanky take a look at that gif again
01:19:21  clanky      : (calls video_context tool on the Tenor URL)
01:19:21  tool        : video_context_tool_result → keyframeCount: 1 (15.5 KB)
01:19:32  clanky      : "OH WAIT hold up I misdiagnosed the patient 💀
                        That mf is not tasting wifi. That is a tiny dog(?)
                        absolutely *cranking a shovel/pan into its own dome*
                        while doing the forbidden taiko lick-spin ritual."
                                                          [grounded — but on ONE frame]
```

## Issues Reported / Observed

1. **The first time the user asked Clanky to read the GIF (Turn A/B), Clanky did not look at it at all.** It had zero images and no `video_context` tool exposed; the "tasting wifi" interpretation was pure confabulation on top of the message text.
2. **When the user asked "again" (Turn C), Clanky did invoke the GIF inspector — but only one keyframe was extracted from the entire animation**, not multiple frames. The corrected reply was based on a single still.

## Issue 1 — `video_context` was not exposed on the original GIF turns

**Evidence — `reply_tool_availability` for `1498088693691453571` (Turn A) and `1498088964098232451` (Turn B):**

- `metadata.includedTools` lists 32 tools (`web_search`, `browser_browse`, `image_lookup`, music/media tools, `note_context`, …). **`video_context` is absent.**
- `metadata.excludedTools` lists 18 swarm/coordination tools all with `reason: "settings_disabled"`. `video_context` is not in this list either — it simply was not registered for this pipeline at the time.

**Evidence — `llm_call` at `2026-04-26T22:29:46.872Z` (Turn A's only LLM call):**
- `metadata.toolNames: null`
- `metadata.toolCallCount: 0`
- `metadata.inputImages: 0`
- `metadata.responseShape: "completed"`

So the model had no GIF pixels and no way to ask for any. The "rotational brain damage / tasting wifi" line is a free-form text completion off the channel transcript and the URL string. Same shape on Turn B.

The new tool first appears in `reply_tool_availability` on Turn C (`1498131354926321806`, `2026-04-27T01:19:15.506Z`), where `metadata.includedTools` now contains `"video_context"` near the top of the list. That's the first turn after commit `cb17236 "Inspect GIF media before visual replies"` (Apr 26 19:43:24 −0500 ≈ `2026-04-27T00:43:24Z`).

**Interpretation:** Turns A/B happened on a build that hadn't wired the visual-media inspector into the reply pipeline yet. The bot literally couldn't see the GIF — it was not lying, it was just blind, and the prompt before `cb17236` apparently didn't force it to disclose that.

## Issue 2 — On the "again" turn, only **one** GIF keyframe reached the LLM

Turn C ran four LLM calls. Three of them touched the GIF, but only one frame ever made it into the final reply context.

**LLM call sequence for trigger `1498131354926321806`:**

| ts (UTC) | role | inputImages | toolNames | toolCallCount | responseChars |
|---|---|---|---|---|---|
| 01:19:20.421 | image caption (klipy URL) | 1 | – | 0 | 118 |
| 01:19:21.010 | reply tool-loop step 0 | 0 | `video_context` | 1 | 0 |
| 01:19:21.680 | image caption (tenor URL) | 1 | – | 0 | 140 |
| 01:19:31.662 | reply tool-loop step 1 (`event: reply_tool_loop:1`, final reply) | **1** | – | 0 | 640 |

**Tool result — `runtime / video_context_tool_result` at `2026-04-27T01:19:21.474Z`:**

```json
{
  "url": "https://media.tenor.com/rAWXcy9O6XUAAAPo/wow-taiko.mp4",
  "provider": "direct",
  "title": "media.tenor.com video",
  "durationSeconds": null,
  "hasTranscript": false,
  "transcriptChars": 0,
  "keyframeCount": 1,
  "keyframePayloadBytes": 15519,
  "keyframeError": null,
  "keyframeErrorCode": null,
  "missingDependencies": [],
  "toolResultChars": 161,
  "toolResultPreview":
    "Provider: direct\nTitle: media.tenor.com video\nChannel: media.tenor.com\nURL: https://media.tenor.com/rAWXcy9O6XUAAAPo/wow-taiko.mp4\nKeyframes: 1 frame(s) attached"
}
```

Cross-checks:
- `keyframeError: null`, `missingDependencies: []` → ffmpeg ran cleanly. (Earlier on `2026-04-27T00:48:51.857Z` in a different channel the *same URL* came back with `keyframeCount: 0, keyframeError: "ffmpeg is not installed."` — by the time of Turn C, that dep was satisfied. Not the cause here.)
- `keyframePayloadBytes: 15519` → consistent with one ~15 KB JPEG, not several.
- The tool-result preview literally says **"Keyframes: 1 frame(s) attached"** — that's the string the model saw.
- Final reply LLM (`reply_tool_loop:1`) shows `inputImages: 1`, matching the single keyframe (the auxiliary captioning calls earlier are separate per-URL captions, not the reply context).

**Why one frame, not the configured minimum of four?**

`src/bot/replyPipeline.ts` sets, for GIF inspection paths: `keyframeIntervalSeconds = 1`, `maxKeyframesPerVideo = max(4, configured)`. The Tenor `wow-taiko.mp4` is a very short looping clip, and `videoContextService.extractKeyframesFromInput` runs `ffmpeg -vf "fps=1/<interval>" -frames:v <max>`. At 1 fps on a sub-second source, ffmpeg only emits one frame before the input ends — the `max=4` cap never gets exercised. `durationSeconds: null` in the result is consistent with the runtime not reading a duration back, which means it can't adapt the sampling rate to the clip length either.

So the caption "OH WAIT hold up I misdiagnosed the patient … cranking a shovel/pan into its own dome … forbidden taiko lick-spin ritual" was generated from a single still of the loop, plus the URL slug `wow-taiko`. Lucky framing — the still apparently caught the action — but it was not "every keyframe through Clanky."

## Direct answer to the operator's question

> *"did we really send each keyframe through clanky?"*

**No.** For Turn C, exactly one keyframe (15.5 KB JPEG) was attached to the reply LLM call. The `video_context` extractor was designed to sample up to 4–8 keyframes at 1 fps (`replyPipeline.ts` GIF branch), but for a sub-second Tenor MP4, 1 fps sampling yields one frame and the `max` cap is never reached. For Turns A and B on the prior build, **zero** keyframes were sent — the inspector tool wasn't even exposed yet, so Clanky's "tasting wifi" read was a hallucination off the URL/text alone.

## Fixes Applied

| Issue | Root Cause | Fix | File |
|---|---|---|---|
| Sub-second GIFs only emit one keyframe at fixed 1 fps | `extractKeyframesFromInput` ran `fps=1/configuredInterval` blind to clip duration, so a 0.6s loop produced one frame and the `maxFrames=4` cap never bit | Probe duration with `ffprobe` before sampling; when `duration < configuredInterval × maxFrames`, compress the effective interval to `duration / maxFrames` (floor at 1/15s) so up to `maxFrames` frames are spread across the clip | `src/video/videoContextService.ts` |
| `durationSeconds: null` for direct Tenor/Giphy MP4s | `fetchGenericSummary` doesn't have a duration source for `provider: "direct"` | Backfill `context.durationSeconds` from the same `ffprobe` probe whenever keyframes are extracted | `src/video/videoContextService.ts` |

## Open Items / Future Considerations

- Turn A/B left no breadcrumb that the bot couldn't see the GIF — it just confidently invented a reading. The `cb17236` prompt change ("falls back to honesty when no pixels are available") is the right instinct; worth confirming that pre-`cb17236` builds still in the field also emit a "no pixels" disclaimer rather than confabulating, and that test coverage in `replyPipeline.test.ts` exercises the empty-keyframe / no-tool-available branch.
- The duration-aware sampling fix relies on `ffprobe` being on `$PATH`. It ships with ffmpeg in essentially every distribution we run on, but if it goes missing we silently fall back to fixed-interval sampling (the previous behavior). Consider folding `ffprobe` into the `getToolAvailability` probe so missing-dependency telemetry is consistent with `ffmpeg` / `yt-dlp`.
