import { test } from "bun:test";
import assert from "node:assert/strict";
import type { LLMService } from "../../llm.ts";
import { getResolvedOrchestratorBinding } from "../../settings/agentStack.ts";
import { normalizeSettings } from "../../store/settingsNormalization.ts";
import { createMinecraftBrain } from "./minecraftBrain.ts";

const EMPTY_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  cacheWriteTokens: 0,
  cacheReadTokens: 0
};

class FakeMinecraftBrainLlm implements Pick<LLMService, "generate"> {
  readonly calls: Parameters<LLMService["generate"]>[0][] = [];
  private readonly responseText: string;

  constructor(responseText: string) {
    this.responseText = responseText;
  }

  async generate(
    args: Parameters<LLMService["generate"]>[0]
  ): Promise<Awaited<ReturnType<LLMService["generate"]>>> {
    this.calls.push(args);
    return {
      text: this.responseText,
      costUsd: 0.25,
      usage: { ...EMPTY_USAGE }
    } as Awaited<ReturnType<LLMService["generate"]>>;
  }
}

test("createMinecraftBrain uses the dedicated Minecraft binding for operator turns", async () => {
  const llm = new FakeMinecraftBrainLlm('{"goal":"Stay with Volpestyle","subgoals":["follow Volpestyle"],"progress":["Already in the same area"],"summary":"Continuing the escort.","shouldContinue":false,"action":{"kind":"follow","playerName":"Volpestyle"}}');
  const settings = normalizeSettings({
    agentStack: {
      runtimeConfig: {
        minecraft: {
          enabled: true,
          server: {
            label: "Survival SMP",
            host: "mc.example.test",
            port: 25570,
            description: "Primary operator world"
          },
          execution: {
            mode: "dedicated_model",
            model: {
              provider: "anthropic",
              model: "claude-haiku-4-5"
            }
          }
        }
      }
    }
  });
  const brain = createMinecraftBrain(llm, () => settings as Record<string, unknown>);
  const lookImageInputs = [{ mediaType: "image/jpeg", dataBase64: "Zm9v" }];

  const result = await brain.planTurn({
    instruction: "follow me",
    chatHistory: [],
    worldSnapshot: null,
    botUsername: "ClankyBuddy",
    mode: "companion",
    knownIdentities: [{ mcUsername: "Volpestyle", relationship: "operator" }],
    constraints: {},
    serverTarget: {
      label: "Survival SMP",
      host: "mc.example.test",
      port: 25570,
      description: "Primary operator world"
    },
    serverCatalog: [],
    sessionState: {
      activeGoal: "Stay with Volpestyle",
      subgoals: ["keep up"],
      progress: ["recently rejoined"],
      lastInstruction: "follow me",
      lastDecisionSummary: "Rejoined the server.",
      lastActionResult: "Player 'Volpe' is not known in the current world state.",
      lastActionFailure: {
        actionKind: "follow",
        reason: "player_not_visible",
        message: "Player 'Volpe' is not known in the current world state.",
        didYouMeanPlayerName: "Volpestyle"
      },
      pendingInGameMessages: [
        { sender: "Alice", text: "clanky where are you", timestamp: "2026-04-04T12:00:10Z", isBot: false },
        { sender: "Bob", text: "follow Volpe", timestamp: "2026-04-04T12:00:11Z", isBot: false }
      ],
      activeProject: null
    },
    lookCapture: {
      mediaType: "image/jpeg",
      dataBase64: "Zm9v",
      width: 640,
      height: 360,
      capturedAt: "2026-04-04T12:00:15Z",
      viewpoint: {
        position: { x: 0, y: 64, z: 0 },
        yaw: 0,
        pitch: 0
      }
    },
    lookImageInputs
  });

  assert.equal(result.goal, "Stay with Volpestyle");
  assert.deepEqual(result.subgoals, ["follow Volpestyle"]);
  assert.equal(result.action.kind, "follow");
  if (result.action.kind !== "follow") throw new Error("expected follow action");
  assert.equal(result.action.playerName, "Volpestyle");
  assert.equal(llm.calls.length, 1);
  const orchestrator = getResolvedOrchestratorBinding(llm.calls[0]?.settings);
  assert.equal(orchestrator.provider, "anthropic");
  assert.equal(orchestrator.model, "claude-haiku-4-5");
  assert.equal(llm.calls[0]?.trace?.source, "minecraft_brain_turn");
  assert.deepEqual(llm.calls[0]?.imageInputs, lookImageInputs);
  assert.match(String(llm.calls[0]?.userPrompt || ""), /Preferred server target: Survival SMP; mc\.example\.test; port 25570; Primary operator world\./);
  assert.match(String(llm.calls[0]?.userPrompt || ""), /rendered first-person Minecraft scene image is attached/i);
  assert.match(String(llm.calls[0]?.userPrompt || ""), /Pending in-game messages: 2\./);
  assert.match(String(llm.calls[0]?.userPrompt || ""), /\[Pending in-game messages\][\s\S]*<Alice> clanky where are you/);
  assert.match(String(llm.calls[0]?.userPrompt || ""), /Last action failure: follow -> player_not_visible\./);
  assert.match(String(llm.calls[0]?.userPrompt || ""), /Did you mean player: Volpestyle\./);
});

test("createMinecraftBrain parses Minecraft chat reply and action separately", async () => {
  const llm = new FakeMinecraftBrainLlm('{"goal":"Escort Volpestyle","subgoals":["stay close"],"progress":["he asked again in chat"],"summary":"Acknowledging in chat and following.","chatText":"on my way","action":{"kind":"follow","playerName":"Volpestyle"}}');
  const settings = normalizeSettings({});
  const brain = createMinecraftBrain(llm, () => settings as Record<string, unknown>);

  const result = await brain.replyToChat({
    sender: "Volpestyle",
    message: "follow me",
    chatHistory: [],
    worldSnapshot: null,
    botUsername: "ClankyBuddy",
    mode: "companion",
    knownIdentities: [{ mcUsername: "Volpestyle", relationship: "operator" }],
    constraints: {},
    serverTarget: null,
    serverCatalog: [],
    sessionState: {
      activeGoal: null,
      subgoals: [],
      progress: [],
      lastInstruction: null,
      lastDecisionSummary: null,
      lastActionResult: null,
      lastActionFailure: null,
      pendingInGameMessages: [],
      activeProject: null
    }
  });

  assert.equal(result.chatText, "on my way");
  assert.equal(result.goal, "Escort Volpestyle");
  assert.equal(result.action.kind, "follow");
  if (result.action.kind !== "follow") throw new Error("expected follow action");
  assert.equal(result.action.playerName, "Volpestyle");
  assert.equal(llm.calls[0]?.trace?.source, "minecraft_brain_chat");
});
