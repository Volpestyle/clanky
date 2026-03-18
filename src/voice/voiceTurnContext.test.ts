import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  buildSharedVoiceTurnContext,
  normalizeVoiceScreenWatchCapability
} from "./voiceTurnContext.ts";
import type { VoiceSession } from "./voiceSessionTypes.ts";

test("normalizeVoiceScreenWatchCapability returns disabled defaults when capability is missing", () => {
  const capability = normalizeVoiceScreenWatchCapability(null);

  assert.equal(capability.supported, false);
  assert.equal(capability.available, false);
  assert.equal(capability.reason, "screen_watch_capability_unavailable");
});

test("buildSharedVoiceTurnContext includes native sharers and recent tool outcomes", () => {
  const session = {
    id: "session-1",
    guildId: "guild-1",
    textChannelId: "text-1",
    voiceChannelId: "voice-1",
    compactedContextSummary: null,
    compactedContextCoveredThroughTurn: null,
    nativeScreenShare: {
      sharers: new Map([[
        "speaker-2",
        {
          userId: "speaker-2",
          codec: "h264",
          updatedAt: Date.now(),
          lastFrameAt: Date.now(),
          videoSsrc: 4101,
          streams: [
            {
              ssrc: 4101,
              rtxSsrc: 4102,
              streamType: "screen",
              active: true,
              width: 1280,
              height: 720,
              quality: 100,
              pixelCount: 921600
            }
          ]
        }
      ]])
    },
    toolCallEvents: [
      {
        callId: "tool-1",
        toolName: "start_screen_watch",
        toolType: "function",
        arguments: { target: "bob" },
        startedAt: new Date(Date.now() - 2_000).toISOString(),
        completedAt: new Date(Date.now() - 1_000).toISOString(),
        runtimeMs: 320,
        success: true,
        outputSummary: {
          ok: true,
          started: true,
          transport: "native",
          targetUserId: "speaker-2"
        },
        error: null
      }
    ]
  } as VoiceSession;

  const context = buildSharedVoiceTurnContext({
    resolveVoiceSpeakerName: (_session, userId) => userId === "speaker-2" ? "bob" : "casey",
    getStreamWatchNotesForPrompt: () => ({
      prompt: "Use frame notes.",
      notes: ["The game HUD is visible."],
      active: true
    }),
    getVoiceScreenWatchCapability: () => ({
      supported: true,
      enabled: true,
      available: true,
      status: "ready",
      reason: null
    }),
    getVoiceChannelParticipants: () => [
      { userId: "speaker-1", displayName: "casey" },
      { userId: "speaker-2", displayName: "bob" }
    ],
    getRecentVoiceMembershipEvents: () => [],
    getRecentVoiceChannelEffectEvents: () => [],
    getMusicPromptContext: () => null
  }, {
    session,
    settings: null,
    speakerUserId: "speaker-1"
  });

  assert.equal(context.nativeDiscordSharers.length, 1);
  assert.equal(context.nativeDiscordSharers[0]?.displayName, "bob");
  assert.equal(context.nativeDiscordSharers[0]?.width, 1280);
  assert.equal(context.recentToolOutcomeLines.length, 1);
  assert.equal(context.recentToolOutcomeLines[0]?.includes("start_screen_watch succeeded"), true);
});
