import { test } from "bun:test";
import assert from "node:assert/strict";
import { buildStreamKey } from "../selfbot/streamDiscovery.ts";
import { createStreamPublishState } from "./voiceStreamPublish.ts";
import {
  startBrowserSessionStreamPublish,
  stopBrowserSessionStreamPublish
} from "./voiceBrowserStreamPublish.ts";

test("startBrowserSessionStreamPublish forwards browser frames into clankvox and stops cleanly", async () => {
  const calls: Array<Record<string, string | number>> = [];
  let resolveFirstFrame!: () => void;
  const firstFramePromise = new Promise<void>((resolve) => {
    resolveFirstFrame = resolve;
  });

  const session = {
    id: "session-1",
    guildId: "guild-1",
    textChannelId: "text-1",
    voiceChannelId: "voice-1",
    ending: false,
    cleanupHandlers: [] as Array<() => void>,
    streamPublish: {
      ...createStreamPublishState(),
      active: true,
      paused: false,
      streamKey: buildStreamKey("guild-1", "voice-1", "self-user"),
      guildId: "guild-1",
      channelId: "voice-1",
      sourceKind: "music" as const,
      visualizerMode: "cqt" as const,
      sourceKey: "https://youtube.com/watch?v=abc123",
      sourceUrl: "https://youtube.com/watch?v=abc123",
      sourceLabel: "https://youtube.com/watch?v=abc123",
      lastVoiceSessionId: "voice-session-1",
      transportStatus: "ready",
      transportConnectedAt: 1
    },
    voxClient: {
      streamPublishBrowserStart(mimeType?: string) {
        calls.push({ type: "browser_start", mimeType: String(mimeType || "") });
      },
      streamPublishBrowserFrame(payload: {
        mimeType?: string;
        frameBase64: string;
        capturedAtMs?: number;
      }) {
        calls.push({
          type: "browser_frame",
          mimeType: String(payload.mimeType || ""),
          capturedAtMs: Math.max(0, Math.round(Number(payload.capturedAtMs) || 0))
        });
        resolveFirstFrame();
      },
      streamPublishStop() {
        calls.push({ type: "stop" });
      },
      streamPublishDisconnect(reason?: string | null) {
        calls.push({ type: "disconnect", reason: String(reason || "") });
      }
    }
  };

  const manager = {
    browserManager: {
      async screenshot() {
        return `data:image/png;base64,${Buffer.from(`frame-${Date.now()}`).toString("base64")}`;
      },
      async currentUrl() {
        return "https://example.com/demo";
      }
    },
    subAgentSessions: {
      get(sessionId: string) {
        if (sessionId !== "browser:1") return null;
        return {
          ownerUserId: "user-1",
          getBrowserSessionKey() {
            return "session:browser:1";
          }
        };
      }
    },
    sessions: new Map([[session.guildId, session]]),
    client: {
      user: {
        id: "self-user"
      },
      ws: {
        _ws: {
          send() {
            return undefined;
          }
        },
        shards: {
          first() {
            return { id: 0 };
          }
        }
      }
    },
    store: {
      getSettings() {
        return null;
      },
      logAction() {
        return undefined;
      }
    }
  };

  const startResult = await startBrowserSessionStreamPublish(manager, {
    guildId: "guild-1",
    browserSessionId: "browser:1",
    requesterUserId: "user-1",
    source: "voice_realtime_tool_share_browser_session"
  });
  assert.equal(startResult.ok, true);
  assert.equal(startResult.started, true);

  await firstFramePromise;

  const stopResult = await stopBrowserSessionStreamPublish(manager, {
    guildId: "guild-1",
    reason: "test_complete"
  });
  assert.equal(stopResult.ok, true);

  assert.equal(calls.some((entry) => entry.type === "browser_start"), true);
  assert.equal(calls.some((entry) => entry.type === "browser_frame"), true);
  assert.equal(calls.some((entry) => entry.type === "stop"), true);
  assert.equal(
    calls.some((entry) => entry.type === "disconnect" && entry.reason === "test_complete"),
    true
  );
  assert.equal(session.streamPublish?.sourceKind, null);
});
