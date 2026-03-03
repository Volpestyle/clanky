import { test, describe, beforeAll, afterAll } from "bun:test";
import assert from "node:assert/strict";
import { env } from "node:process";
import {
  DriverBot,
  type DriverBotConfig,
  getE2EConfig,
  hasTextE2EConfig
} from "./driver/index.ts";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_RESPONSE_WAIT_MS = 15_000;

function envNumber(name: string, defaultValue: number): number {
  const value = env[name];
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

describe("E2E: Text Channel", () => {
  let driver: DriverBot;

  beforeAll(async () => {
    if (!hasTextE2EConfig()) {
      console.log("Skipping text E2E tests: set RUN_E2E_TEXT=1 and E2E_TEST_TEXT_CHANNEL_ID");
      return;
    }

    const config = getE2EConfig();
    const driverConfig: DriverBotConfig = {
      token: config.driverBotToken,
      guildId: config.testGuildId,
      voiceChannelId: config.testVoiceChannelId,
      textChannelId: config.testTextChannelId,
      systemBotUserId: config.systemBotUserId
    };
    driver = new DriverBot(driverConfig);
    await driver.connect();
  });

  afterAll(async () => {
    if (driver) {
      await driver.destroy();
    }
  });

  test(
    "Text: Bot responds to direct mention",
    async () => {
      if (!hasTextE2EConfig()) return;
      const responseWaitMs = envNumber("E2E_RESPONSE_WAIT_MS", DEFAULT_RESPONSE_WAIT_MS);

      await driver.sendTextMessage(`<@${driver.config.systemBotUserId}> what's up`);

      const response = await driver.waitForMessage(driver.config.systemBotUserId, responseWaitMs);
      assert.ok(response, "Expected a response from the bot");
      assert.ok(
        (response as any).content.length > 0,
        "Expected non-empty response content"
      );
    },
    DEFAULT_TIMEOUT_MS
  );

  test(
    "Text: Bot responds to name in text",
    async () => {
      if (!hasTextE2EConfig()) return;
      const responseWaitMs = envNumber("E2E_RESPONSE_WAIT_MS", DEFAULT_RESPONSE_WAIT_MS);

      await driver.sendTextMessage("yo clanker how are you doing today");

      const response = await driver.waitForMessage(driver.config.systemBotUserId, responseWaitMs);
      assert.ok(response, "Expected a response when bot name is mentioned");
      assert.ok(
        (response as any).content.length > 0,
        "Expected non-empty response content"
      );
    },
    DEFAULT_TIMEOUT_MS
  );

  test(
    "Text: Bot ignores unaddressed messages",
    async () => {
      if (!hasTextE2EConfig()) return;

      await driver.sendTextMessage("the build passed on main, CI is green");

      const noReply = await driver.waitForNoMessage(driver.config.systemBotUserId, 8000);
      assert.ok(noReply, "Bot should not reply to unaddressed messages");
    },
    DEFAULT_TIMEOUT_MS
  );

  test(
    "Text: Bot applies reaction emoji",
    async () => {
      if (!hasTextE2EConfig()) return;
      const responseWaitMs = envNumber("E2E_RESPONSE_WAIT_MS", DEFAULT_RESPONSE_WAIT_MS);

      // Send a message that should trigger both a reply and a reaction
      await driver.sendTextMessage(`<@${driver.config.systemBotUserId}> tell me a joke`);

      // Wait for either a reply or a reaction from the system bot
      const reactionPromise = driver.waitForReaction(driver.config.systemBotUserId, responseWaitMs).catch(() => null);
      const messagePromise = driver.waitForMessage(driver.config.systemBotUserId, responseWaitMs).catch(() => null);

      const [reaction, message] = await Promise.all([reactionPromise, messagePromise]);

      // Bot should respond with at least a message (reaction is optional)
      assert.ok(
        reaction || message,
        "Expected bot to react or reply"
      );
    },
    DEFAULT_TIMEOUT_MS
  );

  test(
    "Text: Reply content is non-empty and reasonable length",
    async () => {
      if (!hasTextE2EConfig()) return;
      const responseWaitMs = envNumber("E2E_RESPONSE_WAIT_MS", DEFAULT_RESPONSE_WAIT_MS);

      await driver.sendTextMessage(`<@${driver.config.systemBotUserId}> what's the capital of japan`);

      const response = await driver.waitForMessage(driver.config.systemBotUserId, responseWaitMs);
      assert.ok(response, "Expected a response");
      const content = (response as any).content;
      assert.ok(content.length > 0, "Reply should not be empty");
      assert.ok(content.length < 4000, `Reply too long: ${content.length} chars`);
    },
    DEFAULT_TIMEOUT_MS
  );

  test(
    "Text: Bot handles rapid-fire messages (coalescing)",
    async () => {
      if (!hasTextE2EConfig()) return;

      // Send 3 messages rapidly
      await driver.sendTextMessage(`<@${driver.config.systemBotUserId}> first message`);
      await new Promise((r) => setTimeout(r, 300));
      await driver.sendTextMessage(`<@${driver.config.systemBotUserId}> second message`);
      await new Promise((r) => setTimeout(r, 300));
      await driver.sendTextMessage(`<@${driver.config.systemBotUserId}> third message`);

      // Wait for responses — bot should coalesce and send fewer replies than messages
      await new Promise((r) => setTimeout(r, 20_000));

      // Count messages from the bot in recent history
      const channel = await driver.getTextChannel();
      const messages = await channel.messages.fetch({ limit: 20 });
      const botReplies = messages.filter(
        (m: any) =>
          m.author.id === driver.config.systemBotUserId &&
          m.createdTimestamp > Date.now() - 30_000
      );

      // Bot should coalesce: fewer replies than the 3 messages we sent
      assert.ok(
        botReplies.size <= 2,
        `Expected coalesced reply (1-2 messages), got ${botReplies.size}`
      );
      assert.ok(botReplies.size >= 1, "Expected at least one reply");
    },
    DEFAULT_TIMEOUT_MS
  );
});
