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
  const llm = new FakeMinecraftBrainLlm('{"command":"follow Volpestyle"}');
  const settings = normalizeSettings({
    agentStack: {
      runtimeConfig: {
        minecraft: {
          enabled: true,
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

  const result = await brain.planTurn({
    instruction: "follow me",
    chatHistory: [],
    worldSnapshot: null,
    botUsername: "ClankyBuddy",
    mode: "companion",
    operatorPlayerName: "Volpestyle",
    constraints: {}
  });

  assert.equal(result.command, "follow Volpestyle");
  assert.equal(llm.calls.length, 1);
  const orchestrator = getResolvedOrchestratorBinding(llm.calls[0]?.settings);
  assert.equal(orchestrator.provider, "anthropic");
  assert.equal(orchestrator.model, "claude-haiku-4-5");
  assert.equal(llm.calls[0]?.trace?.source, "minecraft_brain_turn");
});

test("createMinecraftBrain parses Minecraft chat reply and action separately", async () => {
  const llm = new FakeMinecraftBrainLlm('{"chatText":"on my way","command":"follow Volpestyle"}');
  const settings = normalizeSettings({});
  const brain = createMinecraftBrain(llm, () => settings as Record<string, unknown>);

  const result = await brain.replyToChat({
    sender: "Volpestyle",
    message: "follow me",
    chatHistory: [],
    worldSnapshot: null,
    botUsername: "ClankyBuddy",
    mode: "companion",
    operatorPlayerName: "Volpestyle",
    constraints: {}
  });

  assert.equal(result.chatText, "on my way");
  assert.equal(result.gameCommand, "follow Volpestyle");
  assert.equal(llm.calls[0]?.trace?.source, "minecraft_brain_chat");
});
