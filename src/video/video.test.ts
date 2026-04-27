import { test } from "bun:test";
import assert from "node:assert/strict";
import { VideoContextService } from "./videoContextService.ts";

function createService() {
  const logs = [];
  const service = new VideoContextService({
    store: {
      logAction(entry) {
        logs.push(entry);
      }
    },
    llm: {}
  });
  return { service, logs };
}

test("extractVideoTargets parses and deduplicates youtube/direct/tiktok targets", () => {
  const { service } = createService();
  const targets = service.extractVideoTargets(
    [
      "check https://youtu.be/AbC123xyz_1",
      "dup https://www.youtube.com/watch?v=AbC123xyz_1",
      "direct https://cdn.discordapp.com/attachments/1/2/clip.mp4",
      "tiktok https://www.tiktok.com/@creator/video/7234567890123456789"
    ].join(" "),
    3
  );

  assert.equal(targets.length, 3);
  assert.equal(targets[0]?.kind, "youtube");
  assert.equal(targets[0]?.videoId, "AbC123xyz_1");
  assert.equal(targets[1]?.kind, "direct");
  assert.equal(targets[1]?.forceDirect, true);
  assert.equal(targets[2]?.kind, "tiktok");
  assert.equal(targets[2]?.videoId, "7234567890123456789");
});

test("fetchContexts aggregates successes and isolates per-target errors", async () => {
  const { service, logs } = createService();
  service.fetchVideoContext = async (input) => {
    if (input.target.key === "bad") {
      const error = new Error("boom");
      error.attempts = 3;
      throw error;
    }

    return {
      provider: "youtube",
      kind: "youtube",
      videoId: "v1",
      url: "https://www.youtube.com/watch?v=v1",
      title: "title",
      channel: "channel",
      transcript: "hello world",
      transcriptSource: "captions",
      transcriptError: null,
      keyframeCount: 0,
      keyframeError: null,
      cacheHit: false
    };
  };

  const result = await service.fetchContexts({
    targets: [
      { key: "good", kind: "youtube", url: "https://www.youtube.com/watch?v=v1" },
      { key: "bad", kind: "generic", url: "https://example.com/watch/2" }
    ],
    maxTranscriptChars: 50,
    keyframeIntervalSeconds: 999,
    maxKeyframesPerVideo: 25,
    allowAsrFallback: true,
    maxAsrSeconds: 3,
    trace: { guildId: "guild-1", channelId: "chan-1", userId: "user-1", source: "test" }
  });

  assert.equal(result.videos.length, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0]?.key, "bad");
  assert.equal(logs.some((entry) => entry.kind === "video_context_call"), true);
  assert.equal(logs.some((entry) => entry.kind === "video_context_error"), true);
});

test("fetchContexts reports missing ffmpeg as a local dependency blocker for direct video frames", async () => {
  const { service, logs } = createService();
  service.getToolAvailability = async () => ({ ffmpeg: false, ytDlp: true });

  const result = await service.fetchContexts({
    targets: [
      {
        key: "direct:https://media.tenor.com/example.mp4",
        kind: "direct",
        url: "https://media.tenor.com/example.mp4",
        forceDirect: true
      }
    ],
    keyframeIntervalSeconds: 1,
    maxKeyframesPerVideo: 1
  });

  assert.equal(result.errors.length, 0);
  assert.equal(result.videos.length, 1);
  assert.match(result.videos[0]?.keyframeError || "", /Local runtime dependency missing: ffmpeg/);
  assert.equal(result.videos[0]?.keyframeErrorCode, "missing_ffmpeg");
  assert.deepEqual(result.videos[0]?.missingDependencies, ["ffmpeg"]);

  const callLog = logs.find((entry) => entry.kind === "video_context_call");
  assert.deepEqual(callLog?.metadata?.missingDependencies, ["ffmpeg"]);
  assert.equal(callLog?.metadata?.keyframeErrorCode, "missing_ffmpeg");
});

test("fetchContexts reports missing yt-dlp as a local dependency blocker for hosted video pages", async () => {
  const { service } = createService();
  service.getToolAvailability = async () => ({ ffmpeg: true, ytDlp: false });
  service.fetchBaseSummary = async ({ target }) => ({
    provider: "generic",
    kind: target.kind,
    videoId: null,
    url: target.url,
    title: "Tenor GIF page",
    channel: "tenor.com",
    publishedAt: null,
    durationSeconds: null,
    viewCount: null,
    description: "",
    transcript: "",
    transcriptSource: "",
    transcriptError: null
  });

  const result = await service.fetchContexts({
    targets: [
      {
        key: "generic:https://tenor.com/view/example",
        kind: "generic",
        url: "https://tenor.com/view/example"
      }
    ],
    keyframeIntervalSeconds: 1,
    maxKeyframesPerVideo: 1
  });

  assert.equal(result.errors.length, 0);
  assert.match(result.videos[0]?.keyframeError || "", /Local runtime dependency missing: yt-dlp/);
  assert.equal(result.videos[0]?.keyframeErrorCode, "missing_yt_dlp");
  assert.deepEqual(result.videos[0]?.missingDependencies, ["yt-dlp"]);
});
