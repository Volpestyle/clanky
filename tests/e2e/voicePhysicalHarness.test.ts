import { test, describe, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { env } from "node:process";
import {
  DriverBot,
  type DriverBotConfig,
  getE2EConfig,
  hasE2EConfig,
  hasTextE2EConfig,
  getFixturePath,
  generatePcmAudioFixture
} from "./driver/index.ts";
import { Store } from "../../src/store.ts";
import { LLMService } from "../../src/llm.ts";
import { runJsonJudge } from "../../scripts/replay/core/judge.ts";
import { DEFAULT_SETTINGS } from "../../src/settings/settingsSchema.ts";

function envFlag(name: string, defaultValue = false): boolean {
  const value = env[name];
  if (value === undefined) return defaultValue;
  return value === "1" || value === "true" || value === "yes";
}

function envNumber(name: string, defaultValue: number): number {
  const value = env[name];
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_RESPONSE_WAIT_MS = 12_000;

describe("E2E: Voice Physical Layer", () => {
  let driver: DriverBot;

  beforeAll(async () => {
    if (!hasE2EConfig()) {
      console.log("Skipping E2E tests: missing E2E environment variables");
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
    await driver.joinVoiceChannel();
    await driver.summonSystemBot(45_000);
  }, 90_000);

  afterAll(async () => {
    if (driver) {
      await driver.destroy();
    }
  });

  beforeEach(() => {
    if (!driver) return;
    driver.clearReceivedAudio();
  });

  test(
    "E2E: Bot joins voice channel successfully",
    async () => {
      if (!hasE2EConfig()) return;

      assert.ok(driver.connection, "Driver should have voice connection");
      assert.strictEqual(driver.connection.state.status, "ready", "Connection should be ready");
    },
    DEFAULT_TIMEOUT_MS
  );

  test(
    "E2E: Bot hears greeting and replies with audio",
    async () => {
      if (!hasE2EConfig()) return;

      const greetingFixture = env.E2E_GREETING_FIXTURE_PATH || getFixturePath("greeting_yo");
      const responseWaitMs = envNumber("E2E_RESPONSE_WAIT_MS", DEFAULT_RESPONSE_WAIT_MS);

      await driver.playAudio(greetingFixture);

      await new Promise((resolve) => setTimeout(resolve, responseWaitMs));

      const receivedBytes = driver.getReceivedAudioBytes();
      assert.ok(receivedBytes > 0, `Expected system bot to send audio back, got ${receivedBytes} bytes`);
    },
    DEFAULT_TIMEOUT_MS
  );

  test(
    "E2E: Bot responds to direct question",
    async () => {
      if (!hasE2EConfig()) return;

      const questionFixture = env.E2E_QUESTION_FIXTURE_PATH || getFixturePath("direct_question");
      const responseWaitMs = envNumber("E2E_RESPONSE_WAIT_MS", DEFAULT_RESPONSE_WAIT_MS);

      await driver.playAudio(questionFixture);

      await new Promise((resolve) => setTimeout(resolve, responseWaitMs));

      const receivedBytes = driver.getReceivedAudioBytes();
      assert.ok(receivedBytes > 0, `Expected system bot to answer question, got ${receivedBytes} bytes`);
    },
    DEFAULT_TIMEOUT_MS
  );

  test(
    "E2E: Bot handles non-directed speech without crashing",
    async () => {
      if (!hasE2EConfig()) return;

      const chatterFixture = env.E2E_CHATTER_FIXTURE_PATH || getFixturePath("undirected_chatter");

      await driver.playAudio(chatterFixture);
      await new Promise((resolve) => setTimeout(resolve, 5000));

      // Sanity check: connection still healthy after non-directed speech
      assert.ok(driver.connection, "Voice connection should still exist");
      assert.strictEqual(driver.connection.state.status, "ready", "Connection should still be ready");
      assert.ok(driver.isSystemBotInVoice(), "System bot should still be in the voice channel");
    },
    DEFAULT_TIMEOUT_MS
  );
  test(
    "E2E: Bot responds to text messages",
    async () => {
      if (!hasTextE2EConfig()) return;

      await driver.sendTextMessage("yo clanker what's the capital of france?");

      const responseWaitMs = envNumber("E2E_RESPONSE_WAIT_MS", DEFAULT_RESPONSE_WAIT_MS);

      const response = await driver.waitForMessage(driver.config.systemBotUserId, responseWaitMs);
      assert.ok((response as any).content.length > 0, "Expected a substantive text response from the system bot");
    },
    DEFAULT_TIMEOUT_MS
  );

  test(
    "E2E: Response latency is within SLO",
    async () => {
      if (!hasE2EConfig()) return;

      const greetingFixture = env.E2E_GREETING_FIXTURE_PATH || getFixturePath("greeting_yo");

      await driver.playAudio(greetingFixture);

      // Start timer after playback completes (audio fully sent to Discord)
      const start = Date.now();

      // Wait for the first chunk of audio back from the system bot
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timeout waiting for audio latency")), 15000);
        const checkInterval = setInterval(() => {
          if (driver.getReceivedAudioBytes() > 0) {
            clearTimeout(timeout);
            clearInterval(checkInterval);
            resolve();
          }
        }, 100);
      });

      const latency = Date.now() - start;
      // SLO: time from end of our utterance to first audio response from bot
      // Includes: clanker's ASR processing (~1.1s queue wait) + LLM response + TTS
      const MAX_SLO_MS = 10000;

      console.log(`Latency measured: ${latency}ms`);
      assert.ok(latency < MAX_SLO_MS, `Response latency ${latency}ms exceeds ${MAX_SLO_MS}ms SLO`);
    },
    DEFAULT_TIMEOUT_MS
  );

  test(
    "E2E: Bot handles network interruption gracefully",
    async () => {
      if (!hasE2EConfig()) return;

      const greetingFixture = env.E2E_GREETING_FIXTURE_PATH || getFixturePath("greeting_yo");

      await driver.playAudio(greetingFixture);

      // Simulate network drop mid-stream by destroying the driver's connection
      await driver.disconnect();
      await new Promise((r) => setTimeout(r, 1000));

      // Reconnect
      await driver.joinVoiceChannel();
      driver.clearReceivedAudio();

      // Ensure the bot can still process a new interaction after the disruption
      await driver.playAudio(greetingFixture);
      await new Promise((resolve) => setTimeout(resolve, envNumber("E2E_RESPONSE_WAIT_MS", DEFAULT_RESPONSE_WAIT_MS)));

      const receivedBytes = driver.getReceivedAudioBytes();
      assert.ok(receivedBytes > 0, `Expected system bot to recover and answer, got ${receivedBytes} bytes`);
    },
    DEFAULT_TIMEOUT_MS
  );

  test(
    "E2E: Bot leaves voice after inactivity timeout",
    async () => {
      if (!hasE2EConfig()) return;
      if (!envFlag("RUN_E2E_INACTIVITY_LEAVE")) return;

      const greetingFixture = env.E2E_GREETING_FIXTURE_PATH || getFixturePath("greeting_yo");
      const responseWaitMs = envNumber("E2E_RESPONSE_WAIT_MS", DEFAULT_RESPONSE_WAIT_MS);
      const inactivityTimeoutMs = envNumber("E2E_INACTIVITY_TIMEOUT_MS", 90_000);

      // Trigger a response so the bot is actively engaged
      await driver.playAudio(greetingFixture);
      await new Promise((resolve) => setTimeout(resolve, responseWaitMs));
      assert.ok(driver.getReceivedAudioBytes() > 0, "Bot should respond to greeting before inactivity test");

      // Now stay silent and wait for the bot to leave on its own
      const left = await driver.waitForBotLeave(inactivityTimeoutMs + 30_000);
      assert.ok(left, `Bot should leave after ~${inactivityTimeoutMs}ms of inactivity`);
    },
    180_000 // 3-minute timeout for long inactivity wait
  );

  test(
    "E2E: Bot handles rapid sequential utterances",
    async () => {
      if (!hasE2EConfig()) return;

      const greetingFixture = env.E2E_GREETING_FIXTURE_PATH || getFixturePath("greeting_yo");
      const followupFixture = env.E2E_FOLLOWUP_FIXTURE_PATH || getFixturePath("rapid_followup");
      const responseWaitMs = envNumber("E2E_RESPONSE_WAIT_MS", DEFAULT_RESPONSE_WAIT_MS);

      // Play two utterances back to back with minimal gap
      await driver.playAudio(greetingFixture);
      await new Promise((r) => setTimeout(r, 500));

      driver.clearReceivedAudio();

      try {
        await driver.playAudio(followupFixture);
      } catch (error) {
        // If rapid_followup fixture doesn't exist, generate it
        if ((error as Error).message.includes("ENOENT")) {
          console.log("Generating rapid_followup fixture...");
          await generatePcmAudioFixture("rapid_followup", "wait actually one more thing");
          await driver.playAudio(getFixturePath("rapid_followup"));
        } else {
          throw error;
        }
      }

      await new Promise((resolve) => setTimeout(resolve, responseWaitMs));

      const receivedBytes = driver.getReceivedAudioBytes();
      assert.ok(
        receivedBytes > 0,
        `Expected bot to respond to rapid followup, got ${receivedBytes} bytes`
      );
    },
    DEFAULT_TIMEOUT_MS
  );

  test(
    "E2E: Music playback via text command",
    async () => {
      if (!hasE2EConfig()) return;
      if (!hasTextE2EConfig()) return;
      if (!envFlag("RUN_E2E_MUSIC")) return;

      const responseWaitMs = envNumber("E2E_RESPONSE_WAIT_MS", DEFAULT_RESPONSE_WAIT_MS);

      // Send a play request via text
      await driver.sendTextMessage(`<@${driver.config.systemBotUserId}> play something chill`);

      // Wait for the bot to acknowledge (text reply or start playing audio)
      const gotAudio = await driver.waitForAudioResponse(responseWaitMs + 10_000);
      const response = await driver.waitForMessage(driver.config.systemBotUserId, 5000).catch(() => null);

      assert.ok(
        gotAudio || response,
        "Expected bot to either start playing music audio or acknowledge the request"
      );

      // Send stop command
      await driver.sendTextMessage(`<@${driver.config.systemBotUserId}> stop music`);
      await new Promise((r) => setTimeout(r, 3000));
    },
    DEFAULT_TIMEOUT_MS * 2
  );

});

test("smoke: E2E harness validates physical voice layer", async () => {
  if (!envFlag("RUN_E2E_VOICE_PHYSICAL")) return;

  if (!hasE2EConfig()) {
    throw new Error("E2E environment variables not configured");
  }

  const config = getE2EConfig();
  const driverConfig: DriverBotConfig = {
    token: config.driverBotToken,
    guildId: config.testGuildId,
    voiceChannelId: config.testVoiceChannelId,
    textChannelId: config.testTextChannelId,
    systemBotUserId: config.systemBotUserId
  };
  const driver = new DriverBot(driverConfig);

  try {
    await driver.connect();
    await driver.joinVoiceChannel();

    assert.ok(driver.connection, "Should have voice connection");
    assert.strictEqual(driver.connection.state.status, "ready");

    const fixturePath = env.E2E_GREETING_FIXTURE_PATH || getFixturePath("greeting_yo");

    try {
      await driver.playAudio(fixturePath);
    } catch (error) {
      if ((error as Error).message.includes("ENOENT")) {
        console.log(`Fixture not found at ${fixturePath}, generating...`);
        await generatePcmAudioFixture("greeting_yo", "Yo clanker");
        await driver.playAudio(getFixturePath("greeting_yo"));
      } else {
        throw error;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, envNumber("E2E_RESPONSE_WAIT_MS", DEFAULT_RESPONSE_WAIT_MS)));

    const receivedBytes = driver.getReceivedAudioBytes();
    assert.ok(receivedBytes > 0, `Expected system bot audio response, got ${receivedBytes} bytes`);

    console.log(`E2E smoke passed: received ${receivedBytes} bytes of audio from system bot`);

    // --- JSON Quality Assessment ---
    if (envFlag("E2E_RUN_JUDGE", true)) {
      console.log("Running JSON Judge to verify response quality...");
      const dbPath = ":memory:";
      const store = new Store(dbPath);
      store.init();
      // Need a mock appConfig to satisfy LLMService
      const mockAppConfig = {
        openaiApiKey: process.env.OPENAI_API_KEY || "",
        anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
        gcpProject: process.env.GCP_PROJECT || "",
        geminiApiKey: process.env.GEMINI_API_KEY || "",
        xaiApiKey: process.env.XAI_API_KEY || "",
      } as any;

      const llm = new LLMService({ appConfig: mockAppConfig, store });

      const buffer = driver.getReceivedAudioBuffer();
      const transcribedText = await llm.transcribeAudio({
        buffer,
        mimeType: "audio/pcm"
      });

      const judgeSettings = DEFAULT_SETTINGS;

      const systemPrompt = [
        "You are a strict evaluator for voice chat test assertions.",
        "Return strict JSON only.",
        "Score whether the observed text matches expected behavior."
      ].join("\\n");

      const userPrompt = [
        `Case objective: The bot should respond to a general greeting ("Yo clanker").`,
        `Observed response text: ${transcribedText || "(empty)"}`,
        "Scoring rules:",
        "1) The response text should be a friendly greeting back.",
        "2) If the response is empty, it fails.",
        'Output schema: {"pass":true|false,"score":0..100,"confidence":0..1,"summary":"...","issues":["..."]}'
      ].join("\\n");

      const judgeResult = await runJsonJudge<{ pass: boolean; score: number; summary: string; issues: string[] }>({
        llm,
        settings: judgeSettings,
        systemPrompt,
        userPrompt,
        trace: {
          guildId: config.testGuildId,
          channelId: config.testTextChannelId,
          userId: "e2e_judge",
          source: "e2e_harness",
          event: "judge_e2e_smoke",
        },
        onParsed: (parsed, rawText) => {
          return {
            pass: Boolean(parsed.pass),
            score: Number(parsed.score) || 0,
            summary: String(parsed.summary || "").trim(),
            issues: Array.isArray(parsed.issues) ? parsed.issues : [],
            rawText
          };
        },
        onParseError: (rawText) => {
          return {
            pass: false,
            score: 0,
            summary: "judge_output_parse_failed",
            issues: ["judge returned non-JSON output"],
            rawText
          };
        }
      });

      console.log("Judge Result:", judgeResult);
      assert.ok(judgeResult.pass, `Response failed quality assessment: ${judgeResult.summary}`);
    }

  } finally {
    await driver.destroy();
  }
});
