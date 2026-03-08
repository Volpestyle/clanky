import { createTestSettings } from "../testSettings.ts";
import { VoiceSessionManager } from "./voiceSessionManager.ts";

export function createVoiceTestManager({
  participantCount = 2,
  generate = async () => ({ text: "NO" }),
  memory = null
} = {}) {
  const fakeClient = {
    on() {},
    off() {},
    guilds: { cache: new Map() },
    users: { cache: new Map() },
    user: { id: "bot-user", username: "clanker conk" }
  };
  const fakeStore = {
    logAction() {},
    getSettings() {
      return createVoiceTestSettings({
        botName: "clanker conk",
        botNameAliases: ["clankerconk"],
        voice: {
          replyPath: "brain"
        }
      });
    }
  };

  const manager = new VoiceSessionManager({
    client: fakeClient,
    store: fakeStore,
    appConfig: {
      openaiApiKey: "test-openai-key"
    },
    llm: {
      generate,
      isAsrReady() {
        return true;
      },
      isSpeechSynthesisReady() {
        return true;
      }
    },
    memory
  });

  manager.countHumanVoiceParticipants = () => participantCount;
  const defaultParticipants = Array.from({ length: participantCount }, (_, index) => ({
    userId: `speaker-${index + 1}`,
    displayName: `speaker ${index + 1}`
  }));
  manager.getVoiceChannelParticipants = () => defaultParticipants;
  return manager;
}

export function createVoiceTestSettings(overrides = {}) {
  const base = {
    botName: "clanker conk",
    botNameAliases: ["clankerconk"],
    memory: {
      enabled: false
    },
    llm: {
      provider: "openai",
      model: "claude-haiku-4-5"
    },
    voice: {
      replyEagerness: 60,
      replyPath: "brain",
      replyDecisionLlm: {
        provider: "anthropic",
        model: "claude-haiku-4-5"
      }
    }
  };

  return createTestSettings({
    ...base,
    ...overrides,
    memory: {
      ...base.memory,
      ...(overrides.memory || {})
    },
    llm: {
      ...base.llm,
      ...(overrides.llm || {})
    },
    voice: {
      ...base.voice,
      ...(overrides.voice || {}),
      replyDecisionLlm: {
        ...base.voice.replyDecisionLlm,
        ...(overrides.voice?.replyDecisionLlm || {})
      }
    }
  });
}
