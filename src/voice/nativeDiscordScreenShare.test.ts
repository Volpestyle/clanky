import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  applyNativeDiscordVideoState,
  clearNativeDiscordScreenShareState,
  ensureNativeDiscordScreenShareState,
  listActiveNativeDiscordScreenSharers,
  recordNativeDiscordVideoFrame
} from "./nativeDiscordScreenShare.ts";

test("applyNativeDiscordVideoState persists active sharers onto the session-native state", () => {
  const session = {
    nativeScreenShare: {
      sharers: new Map(),
      subscribedTargetUserId: null,
      decodeInFlight: false,
      lastDecodeAttemptAt: 0,
      lastDecodeSuccessAt: 0,
      lastDecodeFailureAt: 0,
      lastDecodeFailureReason: null,
      ffmpegAvailable: null
    }
  };

  const updated = applyNativeDiscordVideoState(session, {
    userId: "user-1",
    audioSsrc: 111,
    videoSsrc: 222,
    codec: "H264",
    streams: [
      {
        ssrc: 333,
        rtxSsrc: 444,
        rid: "f",
        quality: 100,
        streamType: "screen",
        active: true,
        maxBitrate: 4_000_000,
        maxFramerate: 30,
        maxResolution: {
          type: "fixed",
          width: 1280,
          height: 720
        }
      }
    ]
  });

  assert.equal(updated.userId, "user-1");
  assert.equal(updated.codec, "h264");
  assert.equal(session.nativeScreenShare.sharers.get("user-1")?.videoSsrc, 222);
  assert.equal(listActiveNativeDiscordScreenSharers(session).length, 1);

  const frameState = recordNativeDiscordVideoFrame(session, {
    userId: "user-1",
    codec: "H264",
    keyframe: true
  });

  assert.equal(frameState?.lastFrameCodec, "h264");
  assert.equal(Number(session.nativeScreenShare.sharers.get("user-1")?.lastFrameAt || 0) > 0, true);
  assert.equal(Number(session.nativeScreenShare.sharers.get("user-1")?.lastFrameKeyframeAt || 0) > 0, true);
});

test("ensureNativeDiscordScreenShareState normalizes partial session-like state in place", () => {
  const session = {
    nativeScreenShare: {
      sharers: new Map([
        [
          " user-2 ",
          {
            codec: "VP8",
            streams: [
              {
                ssrc: 555,
                width: 1920,
                height: 1080
              }
            ]
          }
        ]
      ]),
      subscribedTargetUserId: " user-2 ",
      decodeInFlight: false,
      lastDecodeAttemptAt: 12,
      lastDecodeSuccessAt: 34,
      lastDecodeFailureAt: 56,
      lastDecodeFailureReason: " old_reason ",
      ffmpegAvailable: true
    }
  };

  const state = ensureNativeDiscordScreenShareState(session);

  assert.equal(session.nativeScreenShare, state);
  assert.equal(state.subscribedTargetUserId, "user-2");
  assert.equal(state.sharers.get("user-2")?.userId, "user-2");
  assert.equal(state.sharers.get("user-2")?.codec, "vp8");
  assert.equal(state.sharers.get("user-2")?.streams[0]?.pixelCount, 1920 * 1080);
  assert.equal(state.lastDecodeFailureReason, "old_reason");
});

test("ensureNativeDiscordScreenShareState preserves the live state object across updates", () => {
  const session = {
    nativeScreenShare: {
      sharers: new Map(),
      subscribedTargetUserId: " user-1 ",
      decodeInFlight: true,
      lastDecodeAttemptAt: 12,
      lastDecodeSuccessAt: 0,
      lastDecodeFailureAt: 0,
      lastDecodeFailureReason: null,
      ffmpegAvailable: true
    }
  };

  const state = ensureNativeDiscordScreenShareState(session);
  applyNativeDiscordVideoState(session, {
    userId: "user-1",
    audioSsrc: null,
    videoSsrc: 222,
    codec: "H264",
    streams: []
  });

  assert.equal(session.nativeScreenShare, state);
  assert.equal(state.decodeInFlight, true);
  assert.equal(state.subscribedTargetUserId, "user-1");
  assert.equal(state.sharers.get("user-1")?.videoSsrc, 222);
});

test("clearNativeDiscordScreenShareState resets the existing state object in place", () => {
  const session = {
    nativeScreenShare: {
      sharers: new Map([
        [
          "user-1",
          {
            userId: "user-1",
            codec: "h264",
            streams: [],
            updatedAt: 1,
            lastFrameAt: 2,
            lastFrameCodec: "h264",
            lastFrameKeyframeAt: 3
          }
        ]
      ]),
      subscribedTargetUserId: "user-1",
      decodeInFlight: true,
      lastDecodeAttemptAt: 12,
      lastDecodeSuccessAt: 34,
      lastDecodeFailureAt: 56,
      lastDecodeFailureReason: "bad",
      ffmpegAvailable: true
    }
  };

  const state = ensureNativeDiscordScreenShareState(session);
  clearNativeDiscordScreenShareState(session);

  assert.equal(session.nativeScreenShare, state);
  assert.equal(state.sharers.size, 0);
  assert.equal(state.subscribedTargetUserId, null);
  assert.equal(state.decodeInFlight, false);
  assert.equal(state.lastDecodeFailureReason, null);
  assert.equal(state.ffmpegAvailable, null);
});

test("listActiveNativeDiscordScreenSharers ignores explicit inactive states but keeps frame-backed watchers", () => {
  const session = {
    nativeScreenShare: {
      sharers: new Map([
        [
          "user-active",
          {
            userId: "user-active",
            videoSsrc: 111,
            updatedAt: 10,
            lastFrameAt: 0,
            streams: [
              {
                ssrc: 111,
                streamType: "screen",
                active: true
              }
            ]
          }
        ],
        [
          "user-ended",
          {
            userId: "user-ended",
            videoSsrc: null,
            updatedAt: 20,
            lastFrameAt: 0,
            streams: []
          }
        ],
        [
          "user-inactive",
          {
            userId: "user-inactive",
            videoSsrc: 222,
            updatedAt: 30,
            lastFrameAt: 0,
            streams: [
              {
                ssrc: 222,
                streamType: "screen",
                active: false
              }
            ]
          }
        ],
        [
          "user-frame-backed",
          {
            userId: "user-frame-backed",
            videoSsrc: 333,
            updatedAt: 5,
            lastFrameAt: 40,
            streams: []
          }
        ]
      ]),
      subscribedTargetUserId: null,
      decodeInFlight: false,
      lastDecodeAttemptAt: 0,
      lastDecodeSuccessAt: 0,
      lastDecodeFailureAt: 0,
      lastDecodeFailureReason: null,
      ffmpegAvailable: true
    }
  };

  assert.deepEqual(
    listActiveNativeDiscordScreenSharers(session).map((entry) => entry.userId),
    ["user-frame-backed", "user-active"]
  );
});
