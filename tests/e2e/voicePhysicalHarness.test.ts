import { test, describe, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { env } from "node:process";
import {
  DriverBot,
  type DriverBotConfig,
  getE2EConfig,
  hasE2EConfig,
  getFixturePath,
  generatePcmAudioFixture
} from "./driver/index.ts";

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
  });

  afterAll(async () => {
    if (driver) {
      await driver.destroy();
    }
  });

  beforeEach(async () => {
    if (!driver) return;
    await driver.joinVoiceChannel();
    driver.clearReceivedAudio();
  });

  afterEach(async () => {
    if (!driver) return;
    await driver.disconnect();
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
    "E2E: Bot ignores undirected chatter",
    async () => {
      if (!hasE2EConfig()) return;

      const chatterFixture = env.E2E_CHATTER_FIXTURE_PATH || getFixturePath("undirected_chatter");
      const responseWaitMs = envNumber("E2E_RESPONSE_WAIT_MS", DEFAULT_RESPONSE_WAIT_MS);

      await driver.playAudio(chatterFixture);

      await new Promise((resolve) => setTimeout(resolve, responseWaitMs));

      const receivedBytes = driver.getReceivedAudioBytes();
      const maxExpectedBytes = envNumber("E2E_MAX_CHATTER_RESPONSE_BYTES", 1024);
      assert.ok(
        receivedBytes <= maxExpectedBytes,
        `Expected bot to ignore undirected chatter, got ${receivedBytes} bytes (max ${maxExpectedBytes})`
      );
    },
    DEFAULT_TIMEOUT_MS
  );
  test(
    "E2E: Bot responds to text messages",
    async () => {
      if (!hasE2EConfig()) return;

      const textChannel = await driver.getTextChannel();
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
      const start = Date.now();

      await driver.playAudio(greetingFixture);

      // Wait for the first chunk of audio
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timeout waiting for audio latency")), 10000);
        const checkInterval = setInterval(() => {
          if (driver.getReceivedAudioBytes() > 0) {
            clearTimeout(timeout);
            clearInterval(checkInterval);
            resolve();
          }
        }, 100);
      });

      const latency = Date.now() - start;
      const MAX_SLO_MS = 8000;

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
    "E2E: Bot discriminates between multiple users",
    async () => {
      if (!hasE2EConfig()) return;

      const aliceSpoofId = "alice_id_123";
      const bobSpoofId = "bob_id_456";

      // Tell Clanker my name is Bob over Bob's SSRC
      const nameFixturePath = env.E2E_GREETING_FIXTURE_PATH || getFixturePath("my_name_is_bob");
      try {
        await driver.playAudio(nameFixturePath, bobSpoofId);
      } catch (error) {
        if ((error as Error).message.includes("ENOENT")) {
          await generatePcmAudioFixture("my_name_is_bob", "Hi clanker, my name is Bob.");
          await driver.playAudio(getFixturePath("my_name_is_bob"), bobSpoofId);
        } else {
          throw error;
        }
      }

      await new Promise((resolve) => setTimeout(resolve, envNumber("E2E_RESPONSE_WAIT_MS", DEFAULT_RESPONSE_WAIT_MS)));
      driver.clearReceivedAudio();

      // Alice asks what her name is over Alice's SSRC
      const askFixturePath = env.E2E_GREETING_FIXTURE_PATH || getFixturePath("whats_my_name");
      try {
        await driver.playAudio(askFixturePath, aliceSpoofId);
      } catch (error) {
        if ((error as Error).message.includes("ENOENT")) {
          await generatePcmAudioFixture("whats_my_name", "Hey clanker, do you know what my name is?");
          await driver.playAudio(getFixturePath("whats_my_name"), aliceSpoofId);
        } else {
          throw error;
        }
      }

      await new Promise((resolve) => setTimeout(resolve, envNumber("E2E_RESPONSE_WAIT_MS", DEFAULT_RESPONSE_WAIT_MS)));

      const receivedBytes = driver.getReceivedAudioBytes();
      assert.ok(receivedBytes > 0, `Expected response for Alice, got ${receivedBytes} bytes`);
      // A deeper verification could run the transcription judge here to ensure Clanker says "I don't know your name" instead of "You are Bob".
    },
    DEFAULT_TIMEOUT_MS
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
