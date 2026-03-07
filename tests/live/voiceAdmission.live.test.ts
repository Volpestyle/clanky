/**
 * Live voice admission tests — CLASSIFIER + FAST-PATHS ONLY, no generation.
 *
 * Exercises the full evaluateVoiceReplyDecision pipeline (name detection
 * fast-paths + YES/NO LLM classifier) against a real LLM. The generation
 * LLM (buildVoiceTurnPrompt / llm.generate) is never called here.
 *
 * The classifier returns YES/NO. The admission pipeline wraps that into
 * allow/deny (deterministic fast-paths can also allow/deny before the
 * classifier runs). Each scenario asserts on the final allow/deny outcome.
 *
 * Run:
 *   bun test tests/live/voiceAdmission.live.test.ts
 *   CLASSIFIER_PROVIDER=anthropic ANTHROPIC_API_KEY=sk-... bun test tests/live/voiceAdmission.live.test.ts
 *
 * Optional:
 *   LABEL_FILTER=music
 *   VOICE_ADMISSION_DEBUG=1
 */
import { beforeAll, describe, test } from "bun:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { parseBooleanFlag } from "../../src/normalization/valueParsers.ts";
import {
  evaluateVoiceReplyDecision,
  type ReplyDecisionHost
} from "../../src/voice/voiceReplyDecision.ts";
import { createTestSettings } from "../../src/testSettings.ts";
import {
  runClaudeCli,
  buildClaudeCodeTextCliArgs
} from "../../src/llm/llmClaudeCode.ts";
import {
  VOICE_LIVE_SCENARIO_GROUPS,
  type VoiceLiveScenario
} from "./shared/voiceLiveScenarios.ts";

const CLASSIFIER_PROVIDER = (process.env.CLASSIFIER_PROVIDER || "claude-code").trim().toLowerCase();
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const MODEL = process.env.CLASSIFIER_MODEL || "claude-haiku-4-5";
const LABEL_FILTER = (process.env.LABEL_FILTER || "").trim().toLowerCase();
const LIVE_DEBUG = parseBooleanFlag(
  process.env.VOICE_ADMISSION_DEBUG ?? process.env.VOICE_CLASSIFIER_DEBUG,
  false
);
const TEST_TIMEOUT_MS = CLASSIFIER_PROVIDER === "claude-code" ? 30_000 : 10_000;

let anthropicClient: Anthropic | null = null;

beforeAll(() => {
  if (CLASSIFIER_PROVIDER === "anthropic") {
    if (!ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY is required when using anthropic provider");
    }
    anthropicClient = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    return;
  }

  if (CLASSIFIER_PROVIDER === "claude-code") {
    delete process.env.CLAUDECODE;
    return;
  }

  throw new Error("CLASSIFIER_PROVIDER must be either 'claude-code' or 'anthropic'");
});

function matchesLabelFilter(label: string): boolean {
  return !LABEL_FILTER || label.toLowerCase().includes(LABEL_FILTER);
}

function logAdmissionClassifierDebug({
  label,
  stage,
  systemPrompt = null,
  userPrompt = null,
  raw = null,
  parsedDecision = null
}: {
  label: string;
  stage: "prompt" | "result";
  systemPrompt?: string | null;
  userPrompt?: string | null;
  raw?: string | null;
  parsedDecision?: string | null;
}) {
  if (!LIVE_DEBUG) return;
  const lines = [`[voiceAdmission.live] ${label} stage=${stage} provider=${CLASSIFIER_PROVIDER} model=${MODEL}`];
  if (systemPrompt) {
    lines.push("System prompt:");
    lines.push(systemPrompt);
  }
  if (userPrompt) {
    lines.push("User prompt:");
    lines.push(userPrompt);
  }
  if (raw != null) {
    lines.push(`Raw output: ${raw}`);
  }
  if (parsedDecision != null) {
    lines.push(`Parsed decision: ${parsedDecision}`);
  }
  console.error(lines.join("\n"));
}

function buildMockManager(sc: VoiceLiveScenario): ReplyDecisionHost {
  const botName = sc.botName || "clanker conk";
  const settings = createTestSettings({
    botName,
    llm: {
      provider: "claude-code",
      model: "sonnet"
    },
    voice: {
      replyEagerness: sc.eagerness ?? 50,
      replyDecisionLlm: {
        provider: CLASSIFIER_PROVIDER,
        model: MODEL,
        realtimeAdmissionMode: "hard_classifier"
      }
    }
  });

  const llmGenerate = async ({
    systemPrompt,
    userPrompt
  }: {
    settings: Record<string, unknown>;
    systemPrompt: string;
    userPrompt: string;
    contextMessages: unknown[];
    trace?: Record<string, unknown>;
  }) => {
    logAdmissionClassifierDebug({
      label: sc.label,
      stage: "prompt",
      systemPrompt,
      userPrompt
    });

    if (CLASSIFIER_PROVIDER === "claude-code") {
      const args = buildClaudeCodeTextCliArgs({
        model: MODEL,
        systemPrompt,
        prompt: userPrompt
      });
      const { stdout } = await runClaudeCli({
        args,
        input: "",
        timeoutMs: 30_000,
        maxBufferBytes: 1024 * 1024
      });
      const text = String(stdout || "").trim();
      logAdmissionClassifierDebug({
        label: sc.label,
        stage: "result",
        raw: text,
        parsedDecision: text
      });
      return { text };
    }

    try {
      const result = await anthropicClient!.messages.create({
        model: MODEL,
        max_tokens: 4,
        temperature: 0,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }]
      });
      const text = result.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("")
        .trim();
      logAdmissionClassifierDebug({
        label: sc.label,
        stage: "result",
        raw: text,
        parsedDecision: text
      });
      return { text };
    } catch (error) {
      console.error(`[voiceAdmission.live] ${sc.label} LLM ERROR:`, error instanceof Error ? error.message : error);
      throw error;
    }
  };

  const participants = sc.participants.map((name, index) => ({
    userId: sc.userId && index === 0 ? sc.userId : `user_${index}`,
    displayName: name
  }));

  return {
    store: {
      getSettings: () => settings,
      logAction: () => {}
    },
    llm: { generate: llmGenerate },
    getVoiceChannelParticipants: () => participants,
    resolveVoiceSpeakerName: (_session, userId) => {
      const found = participants.find((entry) => entry.userId === userId);
      return found?.displayName || sc.speaker || "someone";
    },
    getOutputChannelState: () => ({ locked: false, lockReason: null }),
    isMusicPlaybackActive: () => Boolean(sc.musicActive),
    isMusicDisambiguationResolutionTurn: () => false,
    isCommandOnlyActive: () => Boolean(sc.musicActive),
    resolveRealtimeReplyStrategy: () => "brain",
    formatVoiceDecisionHistory: () => (sc.timeline?.length ? sc.timeline.join("\n") : ""),
    getMusicPhase: () => (sc.musicActive ? "playing" : "idle") as "playing" | "idle"
  } satisfies ReplyDecisionHost;
}

function buildAdmissionSession(sc: VoiceLiveScenario, userId: string, settings: unknown) {
  const now = Date.now();
  return {
    id: "test-session",
    guildId: "test-guild",
    textChannelId: "test-channel",
    mode: "openai_realtime",
    settingsSnapshot: settings,
    lastAudioDeltaAt: sc.recentAssistantReply ? now - (sc.msSinceAssistantReply ?? 0) : 0,
    lastDirectAddressAt: sc.msSinceDirectAddress != null ? now - sc.msSinceDirectAddress : 0,
    lastDirectAddressUserId: sc.msSinceDirectAddress != null ? userId : null,
    musicWakeLatchedUntil:
      sc.musicWakeLatched && sc.msUntilMusicWakeLatchExpiry != null
        ? now + sc.msUntilMusicWakeLatchExpiry
        : 0,
    musicWakeLatchedByUserId: sc.musicWakeLatched ? userId : null,
    transcriptTurns: []
  };
}

async function runAdmission(sc: VoiceLiveScenario): Promise<{ allow: boolean; reason: string }> {
  const manager = buildMockManager(sc);
  const settings = manager.store.getSettings();
  const userId = sc.userId || "user_0";
  const session = buildAdmissionSession(sc, userId, settings);

  if (LIVE_DEBUG) {
    console.error(`[voiceAdmission.live] ${sc.label} stage=run`);
  }

  const result = await evaluateVoiceReplyDecision(manager, {
    session,
    settings,
    userId,
    transcript: sc.transcript,
    inputKind: sc.inputKind || "transcript"
  });

  if (LIVE_DEBUG) {
    console.error(`[voiceAdmission.live] ${sc.label} stage=result allow=${result.allow} reason=${result.reason}`);
  }

  return { allow: result.allow, reason: String(result.reason || "") };
}

describe("voice admission live tests (full pipeline)", () => {
  for (const scenarioGroup of VOICE_LIVE_SCENARIO_GROUPS) {
    const filteredScenarios = scenarioGroup.scenarios.filter((scenario) => matchesLabelFilter(scenario.label));
    if (!filteredScenarios.length) continue;

    describe(scenarioGroup.label, () => {
      for (const scenario of filteredScenarios) {
        test(scenario.label, async () => {
          const { allow, reason } = await runAdmission(scenario);
          const got = allow ? "allow" : "deny";
          assert.equal(
            got,
            scenario.expected.admission,
            `Expected ${scenario.expected.admission} but got ${got} (reason: ${reason}) for: ${scenario.label}`
          );
        }, TEST_TIMEOUT_MS);
      }
    });
  }
});
