import { test, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import assert from "node:assert/strict";
import { env } from "node:process";
import {
  DriverBot,
  type DriverBotConfig,
  getE2EConfig,
  hasDialogueE2EConfig,
  getFixturePath,
  generatePcmAudioFixture
} from "./driver/index.ts";

function envNumber(name: string, defaultValue: number): number {
  const value = env[name];
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

const SKIP_MSG = "Skipping dialogue E2E tests: set E2E_DRIVER_BOT_2_TOKEN";
const DEFAULT_TIMEOUT_MS = 90_000;
const SILENCE_WINDOW_MS = 8_000;

/**
 * Two-person dialogue tests.
 *
 * Uses two independent driver bots (simulating real users) to have a
 * conversation that does NOT address the system bot. The system bot
 * should stay silent — it must not interrupt undirected dialogue.
 */
describe("E2E: Voice Dialogue (Two Speakers)", () => {
  let driverA: DriverBot;
  let driverB: DriverBot;

  beforeAll(async () => {
    if (!hasDialogueE2EConfig()) {
      console.log(SKIP_MSG);
      return;
    }

    const config = getE2EConfig();

    const baseConfig = {
      guildId: config.testGuildId,
      voiceChannelId: config.testVoiceChannelId,
      textChannelId: config.testTextChannelId,
      systemBotUserId: config.systemBotUserId
    };

    driverA = new DriverBot({ ...baseConfig, token: config.driverBotToken });
    driverB = new DriverBot({ ...baseConfig, token: config.driverBot2Token });

    // Connect both bots in parallel
    await Promise.all([driverA.connect(), driverB.connect()]);

    // Join voice in parallel
    await Promise.all([
      driverA.joinVoiceChannel(),
      driverB.joinVoiceChannel()
    ]);

    // Summon the system bot via driver A (only need one to do this)
    await driverA.summonSystemBot(45_000);

    // Let things settle after warmup before dialogue tests begin
    await new Promise((r) => setTimeout(r, 3_000));
  }, 120_000);

  afterAll(async () => {
    await Promise.all([
      driverA?.destroy(),
      driverB?.destroy()
    ]);
  });

  beforeEach(() => {
    if (!driverA || !driverB) return;
    driverA.clearReceivedAudio();
    driverB.clearReceivedAudio();
  });

  // ----------------------------------------------------------------
  // Fixture generation helper — generates dialogue fixtures if missing
  // ----------------------------------------------------------------
  async function ensureFixture(name: string, text: string): Promise<string> {
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

  test(
    "Dialogue: Two users chat — bot stays silent",
    async () => {
      if (!hasDialogueE2EConfig()) return;

      const fixtureA = await ensureFixture(
        "dialogue_a1",
        "Hey did you see the game last night? It was insane."
      );
      const fixtureB = await ensureFixture(
        "dialogue_b1",
        "Yeah I know right, I can't believe they pulled it off in overtime."
      );

      // Clear audio before the dialogue begins
      driverA.clearReceivedAudio();
      driverB.clearReceivedAudio();

      // Speaker A says something to Speaker B
      console.log("[Dialogue] Speaker A talking...");
      await driverA.playAudio(fixtureA);

      // Brief natural pause between speakers
      await new Promise((r) => setTimeout(r, 1_500));

      // Speaker B responds to Speaker A
      console.log("[Dialogue] Speaker B talking...");
      await driverB.playAudio(fixtureB);

      // Wait and observe — the bot should NOT speak
      console.log(`[Dialogue] Waiting ${SILENCE_WINDOW_MS}ms for bot silence...`);
      await new Promise((r) => setTimeout(r, SILENCE_WINDOW_MS));

      const bytesA = driverA.getReceivedAudioBytes();
      const bytesB = driverB.getReceivedAudioBytes();

      console.log(`[Dialogue] Audio received — driverA: ${bytesA} bytes, driverB: ${bytesB} bytes`);

      assert.strictEqual(
        bytesA,
        0,
        `Bot should stay silent during undirected dialogue, but driverA received ${bytesA} bytes`
      );
      assert.strictEqual(
        bytesB,
        0,
        `Bot should stay silent during undirected dialogue, but driverB received ${bytesB} bytes`
      );
    },
    DEFAULT_TIMEOUT_MS
  );

  test(
    "Dialogue: Multi-turn conversation — bot stays silent",
    async () => {
      if (!hasDialogueE2EConfig()) return;

      const turns = [
        { driver: "A", name: "dialogue_a2", text: "So what are you working on today?" },
        { driver: "B", name: "dialogue_b2", text: "Just fixing some bugs in the backend. The usual." },
        { driver: "A", name: "dialogue_a3", text: "Nice. I'm doing a code review, it's pretty long." },
        { driver: "B", name: "dialogue_b3", text: "Yeah those are the worst. Good luck with that." }
      ];

      // Pre-generate all fixtures in parallel
      const fixtures = await Promise.all(
        turns.map((t) => ensureFixture(t.name, t.text))
      );

      driverA.clearReceivedAudio();
      driverB.clearReceivedAudio();

      // Play the conversation turn by turn
      for (let i = 0; i < turns.length; i++) {
        const speaker = turns[i].driver === "A" ? driverA : driverB;
        console.log(`[Dialogue] Turn ${i + 1}: Speaker ${turns[i].driver} — "${turns[i].text}"`);
        await speaker.playAudio(fixtures[i]);
        // Natural inter-turn gap
        await new Promise((r) => setTimeout(r, 1_200));
      }

      // Wait for potential bot response
      console.log(`[Dialogue] Waiting ${SILENCE_WINDOW_MS}ms for bot silence...`);
      await new Promise((r) => setTimeout(r, SILENCE_WINDOW_MS));

      const bytesA = driverA.getReceivedAudioBytes();
      const bytesB = driverB.getReceivedAudioBytes();

      console.log(`[Dialogue] Audio received — driverA: ${bytesA} bytes, driverB: ${bytesB} bytes`);

      assert.strictEqual(
        bytesA,
        0,
        `Bot should stay silent during multi-turn dialogue, but driverA received ${bytesA} bytes`
      );
      assert.strictEqual(
        bytesB,
        0,
        `Bot should stay silent during multi-turn dialogue, but driverB received ${bytesB} bytes`
      );
    },
    DEFAULT_TIMEOUT_MS
  );

  test(
    "Dialogue: Bot responds when directly addressed mid-conversation",
    async () => {
      if (!hasDialogueE2EConfig()) return;

      const responseWaitMs = envNumber("E2E_RESPONSE_WAIT_MS", 12_000);

      const chatFixture = await ensureFixture(
        "dialogue_b4",
        "I was thinking we should grab lunch after this."
      );
      const addressFixture = await ensureFixture(
        "dialogue_a_address_bot",
        "Hey clanker, what do you think about that?"
      );

      driverA.clearReceivedAudio();
      driverB.clearReceivedAudio();

      // Speaker B says something undirected
      console.log("[Dialogue] Speaker B chatting...");
      await driverB.playAudio(chatFixture);
      await new Promise((r) => setTimeout(r, 1_200));

      // Speaker A directly addresses the bot
      console.log("[Dialogue] Speaker A addressing bot...");
      driverA.clearReceivedAudio();
      await driverA.playAudio(addressFixture);

      // Wait for response
      console.log(`[Dialogue] Waiting ${responseWaitMs}ms for bot response...`);
      await new Promise((r) => setTimeout(r, responseWaitMs));

      const bytesA = driverA.getReceivedAudioBytes();
      console.log(`[Dialogue] Audio from bot: ${bytesA} bytes`);

      assert.ok(
        bytesA > 0,
        `Bot should respond when directly addressed, but got ${bytesA} bytes`
      );
    },
    DEFAULT_TIMEOUT_MS
  );

  test(
    "Dialogue: Bot returns to silence after responding",
    async () => {
      if (!hasDialogueE2EConfig()) return;

      const responseWaitMs = envNumber("E2E_RESPONSE_WAIT_MS", 12_000);

      // First, address the bot to trigger a response
      const addressFixture = await ensureFixture(
        "dialogue_a_ping",
        "Hey clanker, you there?"
      );

      driverA.clearReceivedAudio();
      await driverA.playAudio(addressFixture);

      // Wait for the bot to finish responding
      await new Promise((r) => setTimeout(r, responseWaitMs));
      const responded = driverA.getReceivedAudioBytes() > 0;
      console.log(`[Dialogue] Bot responded to ping: ${responded}`);

      // Now resume undirected dialogue — bot should go quiet again
      const resumeA = await ensureFixture(
        "dialogue_a5",
        "Anyway, where were we? Oh right, the deployment."
      );
      const resumeB = await ensureFixture(
        "dialogue_b5",
        "Yeah let's roll it out after lunch I think."
      );

      driverA.clearReceivedAudio();
      driverB.clearReceivedAudio();

      console.log("[Dialogue] Resuming undirected conversation...");
      await driverA.playAudio(resumeA);
      await new Promise((r) => setTimeout(r, 1_200));
      await driverB.playAudio(resumeB);

      console.log(`[Dialogue] Waiting ${SILENCE_WINDOW_MS}ms for bot silence...`);
      await new Promise((r) => setTimeout(r, SILENCE_WINDOW_MS));

      const bytesA = driverA.getReceivedAudioBytes();
      const bytesB = driverB.getReceivedAudioBytes();

      console.log(`[Dialogue] Audio received — driverA: ${bytesA} bytes, driverB: ${bytesB} bytes`);

      assert.strictEqual(
        bytesA,
        0,
        `Bot should return to silence after undirected dialogue resumes, but driverA got ${bytesA} bytes`
      );
      assert.strictEqual(
        bytesB,
        0,
        `Bot should return to silence after undirected dialogue resumes, but driverB got ${bytesB} bytes`
      );
    },
    DEFAULT_TIMEOUT_MS
  );
});
