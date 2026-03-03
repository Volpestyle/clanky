import { env } from "node:process";

export type E2EConfig = {
  systemBotToken: string;
  driverBotToken: string;
  testGuildId: string;
  testVoiceChannelId: string;
  testTextChannelId: string;
  systemBotUserId: string;
};

function requiredEnv(name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function getE2EConfig(): E2EConfig {
  const systemBotToken = env.E2E_SYSTEM_BOT_TOKEN || env.DISCORD_TOKEN;
  if (!systemBotToken) {
    throw new Error("Missing E2E_SYSTEM_BOT_TOKEN (or DISCORD_TOKEN fallback)");
  }
  
  const systemBotUserId = env.E2E_SYSTEM_BOT_USER_ID || env.CLIENT_ID;
  if (!systemBotUserId) {
    throw new Error("Missing E2E_SYSTEM_BOT_USER_ID (or CLIENT_ID fallback)");
  }
  
  return {
    systemBotToken,
    driverBotToken: requiredEnv("E2E_DRIVER_BOT_TOKEN"),
    testGuildId: requiredEnv("E2E_TEST_GUILD_ID"),
    testVoiceChannelId: requiredEnv("E2E_TEST_VOICE_CHANNEL_ID"),
    testTextChannelId: env.E2E_TEST_TEXT_CHANNEL_ID || "",
    systemBotUserId
  };
}

export function hasE2EConfig(): boolean {
  const systemBotToken = env.E2E_SYSTEM_BOT_TOKEN || env.DISCORD_TOKEN;
  const systemBotUserId = env.E2E_SYSTEM_BOT_USER_ID || env.CLIENT_ID;
  return Boolean(
    systemBotToken &&
    systemBotUserId &&
    env.E2E_DRIVER_BOT_TOKEN &&
    env.E2E_TEST_GUILD_ID &&
    env.E2E_TEST_VOICE_CHANNEL_ID
  );
}
