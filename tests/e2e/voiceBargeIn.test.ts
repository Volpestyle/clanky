import { test, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import assert from "node:assert/strict";
import {
  beginTemporaryE2EWithPreset,
  DriverBot,
  type DriverBotConfig,
  generatePcmAudioFixture,
  getE2EConfig,
  hasE2EConfig,
  restoreTemporaryE2ESettings,
  VoiceHistoryAssertionHelper
} from "./driver/index.ts";

const DEFAULT_TIMEOUT_MS = 120_000;

async function ensureFixture(name: string, text: string): Promise<string> {
  const { getFixturePath } = await import("./driver/index.ts");
  const path = getFixturePath(name);
  try {
    const { stat } = await import("node:fs/promises");
    await stat(path);
    return path;
  } catch {
    console.log(`Generating fixture: ${name} ("${text}")`);
    await generatePcmAudioFixture(name, text);
    return getFixturePath(name);
  }
}

describe("E2E: Voice Barge-In", () => {
  let driver: DriverBot;
  let history: VoiceHistoryAssertionHelper;

  beforeAll(async () => {
    if (!hasE2EConfig()) {
      console.log("Skipping barge-in E2E tests: missing E2E environment variables");
      return;
    }

    const config = getE2EConfig();
    const presetName = await beginTemporaryE2EWithPreset();
    console.log(`[E2E] Pipeline preset: ${presetName}`);

    const driverConfig: DriverBotConfig = {
      token: config.driverBotToken,
      guildId: config.testGuildId,
      voiceChannelId: config.testVoiceChannelId,
      textChannelId: config.testTextChannelId,
      systemBotUserId: config.systemBotUserId
    };

    history = new VoiceHistoryAssertionHelper();
    driver = new DriverBot(driverConfig);
    await driver.connect();
    await driver.joinVoiceChannel();
  }, 90_000);

  afterAll(async () => {
    try { await driver?.dismissBot("dismiss_barge_in", "Alright clanker, all done, bounce out."); } catch {}
    await driver?.destroy();
    await restoreTemporaryE2ESettings();
  }, 60_000);

  beforeEach(() => {
    driver?.clearReceivedAudio();
  });

  test("E2E: Bot stops current reply and answers the interruption", async () => {
    if (!hasE2EConfig()) return;

    const scenarioStartedAt = Date.now();
    const longPromptFixture = await ensureFixture(
      "barge_in_long_prompt",
      "Hey clanker, explain photosynthesis in a very detailed way with multiple steps and examples."
    );
    const interruptFixture = await ensureFixture(
      "barge_in_interrupt",
      "Wait stop, answer this instead, what is two plus two?"
    );

    await driver.summonSystemBot(45_000);
    driver.clearReceivedAudio();

    const initialPlayback = driver.playAudioNonBlocking(longPromptFixture);
    const botStartedSpeaking = await driver.waitForReceivedAudioBytes(6_000, 20_000, 100);
    assert.ok(botStartedSpeaking, "Expected the bot to begin speaking for the long prompt");

    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const bytesBeforeInterrupt = driver.getReceivedAudioBytes();

    const interruptPlayback = driver.playAudioNonBlocking(interruptFixture);
    await interruptPlayback;
    await initialPlayback.catch(() => undefined);

    const botSpokeAgain = await driver.waitForReceivedAudioBytes(bytesBeforeInterrupt + 6_000, 20_000, 100);
    assert.ok(botSpokeAgain, "Expected the bot to produce post-interruption audio");

    const left = await driver.dismissBot("dismiss_barge_in_after_test", "Clanker, thanks, you can leave voice now.");
    assert.ok(left, "Expected the bot to leave so the session is written to voice history");

    const session = await history.waitForLatestSession({
      guildId: driver.config.guildId,
      endedAfterMs: scenarioStartedAt,
      timeoutMs: 45_000
    });
    const events = await history.waitForSessionEvents(session.sessionId, { minEvents: 5, timeoutMs: 15_000 });

    history.assertEventSequence(events, [
      "bot_audio_started",
      "voice_barge_in_interrupt",
      "realtime_reply_requested"
    ]);
    history.assertAnyEventMetadataIncludes(events, "openai_realtime_asr_final_segment", "transcript", "two plus two");
    history.assertAnyEventMetadataIncludes(events, "realtime_reply_requested", "replyText", "4");

    await driver.summonSystemBot(45_000);
  }, DEFAULT_TIMEOUT_MS);
});
