import { env } from "node:process";

export type E2EConfig = {
  systemBotToken: string;
  driverBotToken: string;
  driverBot2Token: string;
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

/** Extract the user ID encoded in the first segment of a Discord bot token. */
function userIdFromToken(token: string): string {
  const base64UserId = token.split(".")[0];
  const decoded = Buffer.from(base64UserId, "base64").toString("utf-8");
  if (!/^\d+$/.test(decoded)) {
    throw new Error("Could not extract user ID from bot token");
  }
  return decoded;
}

function resolveSystemBotUserId(token: string): string {
  const explicit = env.E2E_SYSTEM_BOT_USER_ID;
  if (explicit) return explicit;
  return userIdFromToken(token);
}

export function getE2EConfig(): E2EConfig {
  const systemBotToken = env.E2E_SYSTEM_BOT_TOKEN || env.DISCORD_TOKEN;
  if (!systemBotToken) {
    throw new Error("Missing E2E_SYSTEM_BOT_TOKEN (or DISCORD_TOKEN fallback)");
  }

  return {
    systemBotToken,
    driverBotToken: requiredEnv("E2E_DRIVER_BOT_TOKEN"),
    driverBot2Token: env.E2E_DRIVER_BOT_2_TOKEN || "",
    testGuildId: requiredEnv("E2E_TEST_GUILD_ID"),
    testVoiceChannelId: requiredEnv("E2E_TEST_VOICE_CHANNEL_ID"),
    testTextChannelId: env.E2E_TEST_TEXT_CHANNEL_ID || "",
    systemBotUserId: resolveSystemBotUserId(systemBotToken)
  };
}

export function hasE2EConfig(): boolean {
  const systemBotToken = env.E2E_SYSTEM_BOT_TOKEN || env.DISCORD_TOKEN;
  return Boolean(
    systemBotToken &&
    env.E2E_DRIVER_BOT_TOKEN &&
    env.E2E_TEST_GUILD_ID &&
    env.E2E_TEST_VOICE_CHANNEL_ID
  );
}

export function hasTextE2EConfig(): boolean {
  return hasE2EConfig() && Boolean(env.E2E_TEST_TEXT_CHANNEL_ID) && env.RUN_E2E_TEXT === "1";
}

export function hasDialogueE2EConfig(): boolean {
  return hasE2EConfig() && Boolean(env.E2E_DRIVER_BOT_2_TOKEN);
}
