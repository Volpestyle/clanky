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
