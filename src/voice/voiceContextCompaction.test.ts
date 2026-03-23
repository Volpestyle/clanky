import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  getCompactedSessionSummaryContext,
  getCompactionCursor,
  maybeStartVoiceContextCompaction
} from "./voiceContextCompaction.ts";

function createSession(turnCount = 0) {
  return {
    id: "session-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    voiceChannelId: "voice-1",
    mode: "openai_realtime",
    ending: false,
    transcriptTurns: Array.from({ length: turnCount }, (_row, index) => ({
      role: index % 3 === 0 ? "assistant" : "user",
      kind: "speech",
      userId: index % 3 === 0 ? "bot-1" : `user-${index}`,
      speakerName: index % 3 === 0 ? "Clanky" : `user-${index}`,
      text: `turn ${index}`,
      at: index + 1
    })),
    compactedContextSummary: null,
    compactedContextLastAt: 0,
    compactedContextCoveredThroughTurn: null,
    compactedContextCursor: 0,
    compactedContextInFlight: false,
    pendingCompactionNotes: [],
    streamWatch: {
      noteEntries: []
    }
  };
}

function createHost(generatedText = "Alice and Bob kept talking through the early part of the session.") {
  const actions: Array<Record<string, unknown>> = [];
  const generateCalls: Array<Record<string, unknown>> = [];
  const miniReflectionCalls: Array<Record<string, unknown>> = [];
  return {
    host: {
      llm: {
        async generate(args: Record<string, unknown>) {
          generateCalls.push(args);
          return {
            text: generatedText,
            provider: "anthropic",
            model: "claude-haiku-4-5"
          };
        }
      },
      memory: {
        async runVoiceCompactionMiniReflection(args: Record<string, unknown>) {
          miniReflectionCalls.push(args);
          return { ok: true };
        }
      },
      store: {
        logAction(entry: Record<string, unknown>) {
          actions.push(entry);
        }
      },
      client: {
        user: {
          id: "bot-1"
        }
      }
    },
    actions,
    generateCalls,
    miniReflectionCalls
  };
}

test("maybeStartVoiceContextCompaction summarizes the oldest eligible batch and advances the cursor", async () => {
  const session = createSession(61);
  session.pendingCompactionNotes = ["alice: Tokyo map on screen"];
  const { host, actions, generateCalls, miniReflectionCalls } = createHost(
    "Earlier the group discussed strategy, Bob struggled with Hulk, and Alice was on the Tokyo map."
  );

  await maybeStartVoiceContextCompaction(host, {
    session,
    settings: {
      agentStack: {
        overrides: {
          orchestrator: {
            provider: "anthropic",
            model: "claude-haiku-4-5"
          }
        }
      }
    },
    source: "unit_test"
  });

  assert.equal(generateCalls.length, 1);
  assert.equal(miniReflectionCalls.length, 1);
  assert.equal(miniReflectionCalls[0]?.batchStart, 0);
  assert.equal(session.compactedContextCursor, 10);
  assert.equal(session.compactedContextCoveredThroughTurn, 9);
  assert.equal(Boolean(session.compactedContextSummary), true);
  assert.deepEqual(session.pendingCompactionNotes, []);
  assert.equal(actions.some((entry) => entry.content === "voice_context_compaction_started"), true);
  assert.equal(actions.some((entry) => entry.content === "voice_context_compaction_completed"), true);
});

test("maybeStartVoiceContextCompaction skips below threshold without generating", async () => {
  const session = createSession(59);
  const { host, actions, generateCalls } = createHost();

  await maybeStartVoiceContextCompaction(host, {
    session,
    settings: {},
    source: "unit_test"
  });

  assert.equal(generateCalls.length, 0);
  assert.equal(session.compactedContextCursor, 0);
  assert.equal(actions.some((entry) => entry.content === "voice_context_compaction_skipped"), true);
  assert.equal(
    actions.some((entry) => entry.content === "voice_context_compaction_skipped" && entry.metadata?.reason === "below_threshold"),
    true
  );
});

test("getCompactionCursor only returns a live cursor when a summary exists", () => {
  const session = createSession(100);
  session.compactedContextCursor = 20;
  assert.equal(getCompactionCursor(session), 0);

  session.compactedContextSummary = "Earlier they talked about team comps.";
  session.compactedContextCoveredThroughTurn = 19;
  session.compactedContextLastAt = 123;

  assert.equal(getCompactionCursor(session), 20);
  assert.deepEqual(getCompactedSessionSummaryContext(session), {
    text: "Earlier they talked about team comps.",
    coveredThroughTurn: 19,
    updatedAt: 123
  });
});
