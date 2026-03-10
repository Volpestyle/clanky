import { test } from "bun:test";
import assert from "node:assert/strict";
import { runVoiceReplyClassifier } from "./voiceReplyDecision.ts";

type LogEntry = {
  content: string;
  metadata?: Record<string, unknown>;
};

function createClassifierTestContext(rawOutput = "NO") {
  const logs: LogEntry[] = [];
  const generateCalls: Array<Record<string, unknown>> = [];
  return {
    logs,
    generateCalls,
    manager: {
      store: {
        logAction(entry: LogEntry) {
          logs.push(entry);
        }
      },
      llm: {
        async generate(args: Record<string, unknown>) {
          generateCalls.push(args);
          return { text: rawOutput };
        }
      },
      formatVoiceDecisionHistory() {
        return "alice: \"yo clanker\"";
      }
    }
  };
}

function buildClassifierArgs() {
  return {
    session: {
      id: "session-1",
      guildId: "guild-1",
      textChannelId: "channel-1"
    },
    settings: {
      voice: {
        replyDecisionLlm: {
          provider: "anthropic",
          model: "claude-haiku-4-5",
          reasoningEffort: "minimal"
        }
      }
    },
    userId: "user-1",
    transcript: "Yo.",
    speakerName: "alice",
    participantCount: 1,
    participantList: ["alice"],
    conversationContext: {
      engagementState: "wake_word_biased",
      engaged: false,
      engagedWithCurrentSpeaker: false,
      recentAssistantReply: true,
      recentDirectAddress: false,
      sameAsRecentDirectAddress: false,
      msSinceAssistantReply: 8000,
      msSinceDirectAddress: null
    },
    replyEagerness: 50,
    pendingCommandFollowupSignal: false,
    musicActive: false,
    musicWakeLatched: false,
    msUntilMusicWakeLatchExpiry: null
  };
}

test("runVoiceReplyClassifier emits debug prompt/result logs when VOICE_CLASSIFIER_DEBUG=true", async () => {
  const previous = process.env.VOICE_CLASSIFIER_DEBUG;
  process.env.VOICE_CLASSIFIER_DEBUG = "true";
  try {
    const { logs, manager } = createClassifierTestContext("NO");
    const result = await runVoiceReplyClassifier(manager, buildClassifierArgs());

    assert.equal(result.allow, false);
    const debugLogs = logs.filter((entry) => entry.content === "voice_reply_classifier_debug");
    assert.equal(debugLogs.length, 2);

    const promptLog = debugLogs.find((entry) => entry.metadata?.stage === "prompt");
    const resultLog = debugLogs.find((entry) => entry.metadata?.stage === "result");
    assert.ok(promptLog);
    assert.ok(resultLog);
    assert.equal(resultLog?.metadata?.rawOutput, "NO");
    assert.equal(resultLog?.metadata?.parsedDecision, "deny");
    assert.equal(resultLog?.metadata?.reason, "model_no");
  } finally {
    if (previous === undefined) {
      delete process.env.VOICE_CLASSIFIER_DEBUG;
    } else {
      process.env.VOICE_CLASSIFIER_DEBUG = previous;
    }
  }
});

test("runVoiceReplyClassifier does not emit debug logs when VOICE_CLASSIFIER_DEBUG is unset", async () => {
  const previous = process.env.VOICE_CLASSIFIER_DEBUG;
  delete process.env.VOICE_CLASSIFIER_DEBUG;
  try {
    const { logs, manager } = createClassifierTestContext("YES");
    const result = await runVoiceReplyClassifier(manager, buildClassifierArgs());

    assert.equal(result.allow, true);
    const debugLogs = logs.filter((entry) => entry.content === "voice_reply_classifier_debug");
    assert.equal(debugLogs.length, 0);
  } finally {
    if (previous === undefined) {
      delete process.env.VOICE_CLASSIFIER_DEBUG;
    } else {
      process.env.VOICE_CLASSIFIER_DEBUG = previous;
    }
  }
});

test("runVoiceReplyClassifier uses an OpenAI-safe token floor for native realtime presets", async () => {
  const { manager, generateCalls } = createClassifierTestContext("YES");
  const result = await runVoiceReplyClassifier(manager, {
    ...buildClassifierArgs(),
    settings: {
      agentStack: {
        preset: "openai_native_realtime"
      },
      voice: {
        admission: {
          mode: "adaptive"
        }
      }
    }
  });

  assert.equal(result.allow, true);
  assert.equal(generateCalls.length, 1);
  assert.equal(
    (generateCalls[0]?.settings as Record<string, unknown>)?.interaction?.replyGeneration?.maxOutputTokens,
    64
  );
});
