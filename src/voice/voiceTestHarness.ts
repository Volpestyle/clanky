import { createTestSettings } from "../testSettings.ts";
import { deepMerge } from "../utils.ts";
import { VoiceSessionManager } from "./voiceSessionManager.ts";

type VoiceTestSettingsOverrides = Parameters<typeof createTestSettings>[0];

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
        identity: {
          botName: "clanker conk",
          botNameAliases: ["clankerconk"]
        },
        voice: {
          conversationPolicy: {
            replyPath: "brain"
          }
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

export function createVoiceTestSettings(overrides: VoiceTestSettingsOverrides = {}) {
  const base: VoiceTestSettingsOverrides = {
    identity: {
      botName: "clanker conk",
      botNameAliases: ["clankerconk"]
    },
    memory: {
      enabled: false
    },
    agentStack: {
      overrides: {
        orchestrator: {
          provider: "openai",
          model: "claude-haiku-4-5"
        },
        voiceAdmissionClassifier: {
          mode: "dedicated_model",
          model: {
            provider: "anthropic",
            model: "claude-haiku-4-5"
          }
        }
      }
    },
    voice: {
      conversationPolicy: {
        ambientReplyEagerness: 60,
        replyPath: "brain"
      },
      admission: {
        mode: "classifier_gate"
      }
    }
  };

  return createTestSettings(deepMerge(base, overrides));
}
