import { test } from "bun:test";
import assert from "node:assert/strict";
import { createTestSettings } from "../testSettings.ts";
import {
  evaluateVoiceThoughtDecision,
  generateVoiceThoughtCandidate,
  resolveVoiceThoughtEngineConfig
} from "./voiceThoughtGeneration.ts";

function createThoughtSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "session-1",
    guildId: "guild-1",
    textChannelId: "text-1",
    mode: "voice_agent",
    ending: false,
    lastActivityAt: Date.now() - 12_000,
    ...overrides
  };
}

function createThoughtHost({
  generate = async () => ({ text: "" })
}: {
  generate?: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
} = {}) {
  const llmCalls: Array<Record<string, unknown>> = [];
  const actions: Array<Record<string, unknown>> = [];

  return {
    host: {
      client: {
        user: {
          id: "bot-1"
        }
      },
      store: {
        logAction(entry: Record<string, unknown>) {
          actions.push(entry);
        }
      },
      llm: {
        async generate(args: Record<string, unknown>) {
          llmCalls.push(args);
          return await generate(args);
        }
      },
      getVoiceChannelParticipants() {
        return [
          { userId: "user-1", displayName: "Alice" },
          { userId: "user-2", displayName: "Bob" }
        ];
      },
      formatVoiceDecisionHistory() {
        return "Alice: we should switch the vibe\nBob: maybe something weirder";
      },
      resolveVoiceThoughtTopicalityBias() {
        return {
          silenceSeconds: 12,
          topicTetherStrength: 35,
          randomInspirationStrength: 70,
          phase: "drifting",
          topicalStartSeconds: 8,
          fullDriftSeconds: 60,
          promptHint: "Prefer a fresh line over stale callbacks."
        };
      },
      requestRealtimeTextUtterance() {
        return true;
      },
      async speakVoiceLineWithTts() {
        return true;
      },
      recordVoiceTurn() {}
    },
    llmCalls,
    actions
  };
}

test("resolveVoiceThoughtEngineConfig uses orchestrator binding", () => {
  const settings = createTestSettings({});

  const config = resolveVoiceThoughtEngineConfig(settings);

  assert.equal(config.enabled, true);
  assert.equal(config.provider, "anthropic");
  assert.equal(config.model, "claude-sonnet-4-6");
  assert.equal(config.temperature, 0.8);
  assert.equal(config.eagerness, 50);
  assert.ok(config.minSilenceSeconds >= 8);
  assert.ok(config.minSecondsBetweenThoughts >= 30);
});

test("generateVoiceThoughtCandidate strips soundboard directives from LLM output", async () => {
  const settings = createTestSettings({
    identity: {
      botName: "clanker conk"
    },
    initiative: {
      voice: {
        enabled: true,
        execution: {
          mode: "dedicated_model",
          model: {
            provider: "openai",
            model: "gpt-4o-mini"
          },
          temperature: 0.9
        }
      }
    }
  });
  const { host, llmCalls } = createThoughtHost({
    async generate() {
      return {
        text: "  [[SOUNDBOARD:airhorn]] what if pigeons had rent  ",
        provider: "openai",
        model: "gpt-4o-mini"
      };
    }
  });

  const candidate = await generateVoiceThoughtCandidate(host, {
    session: createThoughtSession(),
    settings,
    trigger: "timer"
  });

  assert.equal(candidate, "what if pigeons had rent");
  assert.equal(llmCalls.length, 1);
  assert.equal(llmCalls[0]?.trace?.source, "voice_thought_generation");
  assert.equal(String(llmCalls[0]?.userPrompt || "").includes("Participant names: Alice, Bob."), true);
});

test("evaluateVoiceThoughtDecision returns an allowed decision when the classifier contract is valid", async () => {
  const settings = createTestSettings({
    identity: {
      botName: "clanker conk"
    },
    initiative: {
      voice: {
        enabled: true
      }
    }
  });
  const { host } = createThoughtHost({
    async generate() {
      return {
        text: JSON.stringify({
          allow: true,
          finalThought: "[[SOUNDBOARD:airhorn]] keep it moving",
          usedMemory: true,
          reason: "Natural Memory Callback"
        }),
        provider: "openai",
        model: "gpt-5-mini"
      };
    }
  });

  const decision = await evaluateVoiceThoughtDecision(host, {
    session: createThoughtSession(),
    settings,
    thoughtCandidate: "maybe we should pivot",
    memoryFacts: [{ fact: "Alice loves synthwave", fact_type: "preference" }]
  });

  assert.deepEqual(decision, {
    allow: true,
    reason: "natural_memory_callback",
    finalThought: "keep it moving",
    usedMemory: true,
    memoryFactCount: 1,
    llmResponse:
      "{\"allow\":true,\"finalThought\":\"[[SOUNDBOARD:airhorn]] keep it moving\",\"usedMemory\":true,\"reason\":\"Natural Memory Callback\"}",
    llmProvider: "openai",
    llmModel: "gpt-5-mini"
  });
});

test("evaluateVoiceThoughtDecision returns a rejected decision when the classifier denies the line", async () => {
  const { host } = createThoughtHost({
    async generate() {
      return {
        text: JSON.stringify({
          allow: false,
          finalThought: "ignored",
          usedMemory: true,
          reason: "stale callback"
        })
      };
    }
  });

  const decision = await evaluateVoiceThoughtDecision(host, {
    session: createThoughtSession(),
    settings: createTestSettings({}),
    thoughtCandidate: "maybe we should pivot",
    memoryFacts: [{ fact: "Alice loves synthwave" }]
  });

  assert.equal(decision.allow, false);
  assert.equal(decision.reason, "stale_callback");
  assert.equal(decision.finalThought, "");
  assert.equal(decision.usedMemory, false);
  assert.equal(decision.memoryFactCount, 1);
});

test("evaluateVoiceThoughtDecision reports contract violations when the classifier output is unparseable", async () => {
  const { host } = createThoughtHost({
    async generate() {
      return {
        text: "maybe",
        provider: "openai",
        model: "gpt-5-mini"
      };
    }
  });

  const decision = await evaluateVoiceThoughtDecision(host, {
    session: createThoughtSession(),
    settings: createTestSettings({}),
    thoughtCandidate: "maybe we should pivot"
  });

  assert.deepEqual(decision, {
    allow: false,
    reason: "llm_contract_violation",
    finalThought: "",
    usedMemory: false,
    memoryFactCount: 0,
    llmResponse: "maybe",
    llmProvider: "openai",
    llmModel: "gpt-5-mini"
  });
});
