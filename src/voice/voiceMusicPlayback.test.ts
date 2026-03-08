import { test } from "bun:test";
import assert from "node:assert/strict";

import {
  ensureSessionMusicState,
  isLikelyMusicResumePhrase,
  maybeHandleMusicPlaybackTurn,
  setMusicPhase
} from "./voiceMusicPlayback.ts";
import type { MusicPlaybackHost } from "./voiceMusicPlayback.ts";
import type { VoiceSession } from "./voiceSessionTypes.ts";

function createPlaybackHost() {
  const resumeCalls: string[] = [];
  const loggedEvents: Array<{ content: string; metadata?: Record<string, unknown> }> = [];
  const manager: MusicPlaybackHost = {
    client: {
      user: { id: "bot-1" },
      channels: {
        fetch: async () => null
      },
      guilds: {
        cache: {
          get: () => null
        }
      }
    },
    sessions: new Map<string, VoiceSession>(),
    store: {
      getSettings: () => null,
      logAction: (entry) => {
        loggedEvents.push({
          content: entry.content,
          metadata: entry.metadata
        });
      }
    },
    llm: null,
    replyManager: {
      clearPendingResponse: () => {},
      hasBufferedTtsPlayback: () => false
    },
    bargeInController: {
      clearBargeInOutputSuppression: () => {}
    },
    deferredActionQueue: {
      clearAllDeferredVoiceActions: () => {}
    },
    musicPlayer: {
      duck: () => {},
      unduck: () => {},
      play: () => {},
      stop: () => {},
      pause: () => {},
      resume: () => {
        resumeCalls.push("resume");
      }
    },
    musicPlayback: null,
    musicSearch: null,
    composeOperationalMessage: async () => "",
    transcribePcmTurn: async () => "",
    hasBotNameCueForTranscript: () => false,
    isMusicDisambiguationResolutionTurn: () => false,
    maybeHandlePendingMusicDisambiguationTurn: async () => false,
    playVoiceQueueTrackByIndex: async () => {},
    requestStopMusic: async () => {},
    maybeClearActiveReplyInterruptionPolicy: () => {},
    abortActiveInboundCaptures: () => {}
  };

  return { manager, resumeCalls, loggedEvents };
}

function createPausedSession(manager: MusicPlaybackHost) {
  const session = {
    id: "session-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    voiceChannelId: "voice-1",
    ending: false,
    botTurnResetTimer: null,
    musicQueueState: {
      guildId: "guild-1",
      voiceChannelId: "voice-1",
      tracks: [
        {
          id: "youtube:track-1",
          title: "That’s What I Like",
          artist: "Bruno Mars",
          source: "yt",
          platform: "youtube"
        }
      ],
      nowPlayingIndex: 0,
      isPaused: true,
      volume: 1
    }
  };
  ensureSessionMusicState(manager, session);
  setMusicPhase(manager, session, "paused", "user_pause");
  return session;
}

test("isLikelyMusicResumePhrase matches paused current-track phrases without matching new-play requests", () => {
  const { manager } = createPlaybackHost();

  assert.equal(isLikelyMusicResumePhrase(manager, { transcript: "Can you play the song again?" }), true);
  assert.equal(isLikelyMusicResumePhrase(manager, { transcript: "Okay, play this song." }), true);
  assert.equal(isLikelyMusicResumePhrase(manager, { transcript: "Resume the music" }), true);
  assert.equal(isLikelyMusicResumePhrase(manager, { transcript: "Unpause it" }), true);

  assert.equal(isLikelyMusicResumePhrase(manager, { transcript: "Play Bruno Mars" }), false);
  assert.equal(isLikelyMusicResumePhrase(manager, { transcript: "Play the next song" }), false);
  assert.equal(isLikelyMusicResumePhrase(manager, { transcript: "Play another song" }), false);
});

test("maybeHandleMusicPlaybackTurn resumes paused music for current-track phrasing", async () => {
  const { manager, resumeCalls, loggedEvents } = createPlaybackHost();
  const session = createPausedSession(manager);

  const handled = await maybeHandleMusicPlaybackTurn(manager, {
    session,
    settings: null,
    userId: "user-1",
    pcmBuffer: Buffer.alloc(0),
    source: "realtime",
    transcript: "Can you play the song again?"
  });

  assert.equal(handled, true);
  assert.equal(resumeCalls.length, 1);
  assert.equal(session.music?.phase, "playing");
  assert.equal(session.musicQueueState?.isPaused, false);
  assert.equal(loggedEvents.some((entry) => entry.content === "voice_music_resumed"), true);
});

test("maybeHandleMusicPlaybackTurn does not auto-resume paused music for a new play request", async () => {
  const { manager, resumeCalls, loggedEvents } = createPlaybackHost();
  const session = createPausedSession(manager);

  await maybeHandleMusicPlaybackTurn(manager, {
    session,
    settings: null,
    userId: "user-1",
    pcmBuffer: Buffer.alloc(0),
    source: "realtime",
    transcript: "Play Bruno Mars"
  });

  assert.equal(resumeCalls.length, 0);
  assert.equal(session.music?.phase, "paused");
  assert.equal(session.musicQueueState?.isPaused, true);
  assert.equal(loggedEvents.some((entry) => entry.content === "voice_music_resumed"), false);
});
