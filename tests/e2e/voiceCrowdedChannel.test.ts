import { test, describe, beforeAll, afterAll } from "bun:test";
import assert from "node:assert/strict";
import { env } from "node:process";
import {
  beginTemporaryE2EEagerness50,
  DriverBot,
  type DriverBotConfig,
  getE2EConfig,
  hasE2EConfig,
  hasDialogueE2EConfig,
  getFixturePath,
  generatePcmAudioFixture,
  restoreTemporaryE2ESettings
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

const SKIP_MSG = "Skipping crowded channel E2E tests: set RUN_E2E_CROWDED=1 and provide E2E_DRIVER_BOT_2_TOKEN";

/**
 * Crowded channel E2E tests.
 *
 * Simulates a multi-participant voice channel with overlapping speech,
 * low-signal garbage transcripts, and interleaved music requests.
 * Validates fixes for:
 *
 *   Issue 1: ASR buffer clear/commit race — rapid overlapping speech
 *   Issue 2: response.create TOCTOU race — back-to-back turns
 *   Issue 3: brain_decides low-signal gate — garbage transcripts rejected
 *   Issue 4: Music request deferral — music requests survive chatter
 *   Issue 5: Stale deferred coalescing — garbage filtered from queue
 *
 * Requires: RUN_E2E_CROWDED=1, E2E_DRIVER_BOT_2_TOKEN, and standard E2E vars.
 */
describe("E2E: Crowded channel — multi-participant resilience", () => {
  let driverA: DriverBot;
  let driverB: DriverBot;

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

  /** Wait for clanker to finish speaking, then clear both audio buffers. */
  async function settleAndClear(settleMs = 3_000): Promise<void> {
    await new Promise((r) => setTimeout(r, settleMs));
    driverA.clearReceivedAudio();
    driverB.clearReceivedAudio();
  }

  async function stopMusic(): Promise<void> {
    const stopFixture = await ensureFixture(
      "music_stop_voice",
      "Hey clanker, stop the music"
    );
    driverA.clearReceivedAudio();
    await driverA.playAudio(stopFixture);
    await driverA.waitForAudioResponse(10_000);
    await new Promise((r) => setTimeout(r, 3_000));
  }

  beforeAll(async () => {
    if (!hasE2EConfig() || !envFlag("RUN_E2E_CROWDED") || !hasDialogueE2EConfig()) {
      console.log(SKIP_MSG);
      return;
    }

    const config = getE2EConfig();
    await beginTemporaryE2EEagerness50();

    const baseConfig = {
      guildId: config.testGuildId,
      voiceChannelId: config.testVoiceChannelId,
      textChannelId: config.testTextChannelId,
      systemBotUserId: config.systemBotUserId
    };

    driverA = new DriverBot({ ...baseConfig, token: config.driverBotToken });
    await driverA.connect();
    await driverA.joinVoiceChannel();

    driverB = new DriverBot({ ...baseConfig, token: config.driverBot2Token });
    await driverB.connect();
    await driverB.joinVoiceChannel();

    await driverA.summonSystemBot(45_000);
  }, 120_000);

  afterAll(async () => {
    try { await stopMusic(); } catch { /* ignore */ }
    try { await driverA?.dismissBot("dismiss_crowded", "Get the hell out clanker!"); } catch { /* ignore */ }
    await Promise.all([
      driverA?.destroy(),
      driverB?.destroy()
    ]);
    await restoreTemporaryE2ESettings();
  }, 60_000);

  // ─────────────────────────────────────────────────────────────────────
  // Test 1: Bot ignores overlapping low-signal garbage from two users
  // Tests: Issue 3 (brain_decides gate), Issue 5 (stale coalescing)
  // ─────────────────────────────────────────────────────────────────────
  test(
    "Crowded: Bot ignores rapid low-signal garbage from multiple speakers",
    async () => {
      if (!hasE2EConfig() || !envFlag("RUN_E2E_CROWDED") || !hasDialogueE2EConfig()) return;

      // All garbage must be truly low-signal: single short words with < 10 alnum
      // chars AND < 2 words, matching isLowSignalVoiceFragment() criteria.
      // Avoid words that sound like the wake phrase (e.g. "Blinker" ≈ "Clanker").
      const [garbageA1, garbageB1, garbageA2, garbageB2, garbageA3, garbageB3] = await Promise.all([
        ensureFixture("crowded_garbage_a1", "It"),
        ensureFixture("crowded_garbage_b1", "He"),
        ensureFixture("crowded_garbage_a2", "Fruit"),
        ensureFixture("crowded_garbage_b2", "Right"),
        ensureFixture("crowded_garbage_a3", "OK"),
        ensureFixture("crowded_garbage_b3", "Hmm")
      ]);

      // Long settle to drain any residual audio from warmup
      await settleAndClear(8_000);

      // Fire rapid overlapping garbage from both drivers — simulates ASR
      // hallucinations from multiple participants talking over each other.
      console.log("[Crowded] Firing garbage storm...");

      await driverA.playAudio(garbageA1);
      await new Promise((r) => setTimeout(r, 300));
      await driverB.playAudio(garbageB1);
      await new Promise((r) => setTimeout(r, 300));
      await driverA.playAudio(garbageA2);
      await new Promise((r) => setTimeout(r, 300));
      await driverB.playAudio(garbageB2);
      await new Promise((r) => setTimeout(r, 300));
      await driverA.playAudio(garbageA3);
      await new Promise((r) => setTimeout(r, 300));
      await driverB.playAudio(garbageB3);

      // Wait for the bot to (hopefully not) respond
      console.log("[Crowded] Waiting 8s to confirm bot stays silent...");
      await new Promise((r) => setTimeout(r, 8_000));

      const bytesA = driverA.getReceivedAudioBytes();
      const bytesB = driverB.getReceivedAudioBytes();
      console.log(`[Crowded] Audio received — A: ${bytesA}, B: ${bytesB}`);

      assert.equal(
        bytesA,
        0,
        `Bot should NOT respond to undirected garbage (driver A got ${bytesA} bytes)`
      );
      assert.equal(
        bytesB,
        0,
        `Bot should NOT respond to undirected garbage (driver B got ${bytesB} bytes)`
      );

      // Verify connection health — bot should not have crashed
      assert.ok(driverA.connection, "Driver A connection should still be alive");
      assert.ok(
        driverA.connection.state.status === "ready",
        "Driver A connection should be ready"
      );
      assert.ok(driverA.isSystemBotInVoice(), "System bot should still be in voice");
    },
    60_000
  );

  // ─────────────────────────────────────────────────────────────────────
  // Test 2: Direct address succeeds after garbage storm
  // Tests: Issue 1 (ASR buffer race), Issue 2 (response.create race)
  // ─────────────────────────────────────────────────────────────────────
  test(
    "Crowded: Direct address works after garbage storm",
    async () => {
      if (!hasE2EConfig() || !envFlag("RUN_E2E_CROWDED") || !hasDialogueE2EConfig()) return;

      const responseWaitMs = envNumber("E2E_RESPONSE_WAIT_MS", 12_000);
      const greeting = getFixturePath("greeting_yo");

      await settleAndClear(3_000);

      console.log("[Crowded] Direct address after garbage storm...");
      await driverA.playAudio(greeting);

      const gotResponse = await driverA.waitForAudioResponse(responseWaitMs);
      const bytes = driverA.getReceivedAudioBytes();
      console.log(`[Crowded] Response: ${gotResponse ? "yes" : "no"} (${bytes} bytes)`);

      assert.ok(
        gotResponse,
        `Bot should respond to direct address after garbage storm (got ${bytes} bytes)`
      );
    },
    60_000
  );

  // ─────────────────────────────────────────────────────────────────────
  // Test 3: Rapid back-to-back direct addresses from different speakers
  // Tests: Issue 2 (response.create TOCTOU race)
  // ─────────────────────────────────────────────────────────────────────
  test(
    "Crowded: Rapid back-to-back direct addresses from two speakers",
    async () => {
      if (!hasE2EConfig() || !envFlag("RUN_E2E_CROWDED") || !hasDialogueE2EConfig()) return;

      const greeting = getFixturePath("greeting_yo");
      const question = getFixturePath("direct_question");

      await settleAndClear(5_000);

      // Both drivers fire direct-addressed utterances with minimal gap
      console.log("[Crowded] Driver A: greeting...");
      await driverA.playAudio(greeting);
      await new Promise((r) => setTimeout(r, 500));
      console.log("[Crowded] Driver B: question (overlapping)...");
      await driverB.playAudio(question);

      // Wait for bot to process both
      console.log("[Crowded] Waiting for response...");
      const gotResponseA = await driverA.waitForAudioResponse(15_000);
      const bytesA = driverA.getReceivedAudioBytes();
      const bytesB = driverB.getReceivedAudioBytes();
      console.log(`[Crowded] Audio — A: ${bytesA}, B: ${bytesB}`);

      // At minimum the bot should respond to at least one direct address
      // without crashing from the response.create race
      const totalBytes = bytesA + bytesB;
      assert.ok(
        totalBytes > 0,
        `Bot should respond to at least one direct address (A: ${bytesA}, B: ${bytesB})`
      );

      // Verify connection health
      assert.ok(driverA.isSystemBotInVoice(), "System bot should still be in voice");
    },
    60_000
  );

  // ─────────────────────────────────────────────────────────────────────
  // Test 4: Music request survives chatter interference
  // Tests: Issue 4 (music deferral), Issue 5 (stale coalescing)
  // ─────────────────────────────────────────────────────────────────────
  test(
    "Crowded: Music request succeeds despite overlapping undirected chatter",
    async () => {
      if (!hasE2EConfig() || !envFlag("RUN_E2E_CROWDED") || !hasDialogueE2EConfig()) return;

      const maxAckMs = envNumber("E2E_MUSIC_ACK_MAX_MS", 8_000);
      const downloadWaitMs = envNumber("E2E_MUSIC_DOWNLOAD_WAIT_MS", 30_000);

      const musicRequest = await ensureFixture(
        "music_play_request_2",
        "Hey clanker, play Sicko Mode by Travis Scott"
      );
      const [chatterB1, chatterB2, chatterB3] = await Promise.all([
        ensureFixture("crowded_chatter_b1", "Did you see the game last night?"),
        ensureFixture("crowded_chatter_b2", "Yeah the fourth quarter was crazy"),
        ensureFixture("crowded_chatter_b3", "I can't believe they came back from that deficit")
      ]);

      await settleAndClear(5_000);

      // Driver A requests music, Driver B fires undirected chatter simultaneously
      console.log("[Crowded] Driver A: music request...");
      await driverA.playAudio(musicRequest);

      // Chatter starts 500ms after the music request — during tool-call window
      await new Promise((r) => setTimeout(r, 500));
      console.log("[Crowded] Driver B: chatter 1 (undirected)...");
      await driverB.playAudio(chatterB1);

      const start = Date.now();
      const gotAck = await driverA.waitForAudioResponse(maxAckMs);
      const ackMs = Date.now() - start;
      const ackBytes = driverA.getReceivedAudioBytes();
      console.log(`[Crowded] Music ack: ${gotAck ? "yes" : "no"} (${ackMs}ms, ${ackBytes} bytes)`);

      // More chatter while download is in progress
      await new Promise((r) => setTimeout(r, 800));
      console.log("[Crowded] Driver B: chatter 2...");
      await driverB.playAudio(chatterB2);
      await new Promise((r) => setTimeout(r, 800));
      console.log("[Crowded] Driver B: chatter 3...");
      await driverB.playAudio(chatterB3);

      assert.ok(gotAck, `Bot should ack music request within ${maxAckMs}ms despite chatter`);

      // Wait for download + pipeline commit + speech to finish
      console.log(`[Crowded] Waiting ${downloadWaitMs}ms for download...`);
      await new Promise((r) => setTimeout(r, downloadWaitMs));

      // Verify music is actually streaming — clear the buffer, wait, and
      // check that continuous audio frames arrive (music streams nonstop,
      // speech goes silent after a few seconds).
      console.log("[Crowded] Checking for sustained music audio...");
      driverA.clearReceivedAudio();
      await new Promise((r) => setTimeout(r, 5_000));
      const sustainedBytes = driverA.getReceivedAudioBytes();
      console.log(`[Crowded] Sustained audio after clear: ${sustainedBytes} bytes`);

      assert.ok(
        sustainedBytes > 0,
        `Music should be actively streaming (got ${sustainedBytes} bytes over 5s after clearing buffer). ` +
        `If zero, the model may have called music_search without following up with music_play_now.`
      );

      await stopMusic();
    },
    120_000
  );

  // ─────────────────────────────────────────────────────────────────────
  // Test 5: Garbage storm DURING bot response doesn't cause crash
  // Tests: Issue 1 (ASR race), Issue 2 (response.create race),
  //        Issue 5 (deferred queue with garbage)
  // ─────────────────────────────────────────────────────────────────────
  test(
    "Crowded: Garbage storm during bot response — bot stays healthy",
    async () => {
      if (!hasE2EConfig() || !envFlag("RUN_E2E_CROWDED") || !hasDialogueE2EConfig()) return;

      const greeting = getFixturePath("greeting_yo");
      const [garbageA1, garbageB1, garbageA2, garbageB2] = await Promise.all([
        ensureFixture("crowded_garbage_a1", "It"),
        ensureFixture("crowded_garbage_b1", "He"),
        ensureFixture("crowded_garbage_a2", "Fruit"),
        ensureFixture("crowded_garbage_b2", "Right")
      ]);

      await settleAndClear(5_000);

      // Trigger a bot response with a direct address
      console.log("[Crowded] Triggering bot response...");
      await driverA.playAudio(greeting);
      const gotInitial = await driverA.waitForAudioResponse(12_000);
      assert.ok(gotInitial, "Bot should respond to initial greeting");

      // While the bot is STILL speaking, fire garbage from both drivers
      // This creates the exact scenario from the logs: bot_turn_open + garbage
      console.log("[Crowded] Firing garbage DURING bot response...");
      driverA.clearReceivedAudio();
      driverB.clearReceivedAudio();

      await driverB.playAudio(garbageB1);
      await new Promise((r) => setTimeout(r, 200));
      await driverA.playAudio(garbageA1);
      await new Promise((r) => setTimeout(r, 200));
      await driverB.playAudio(garbageB2);
      await new Promise((r) => setTimeout(r, 200));
      await driverA.playAudio(garbageA2);

      // Wait for bot to finish its current response + deferred flush window
      console.log("[Crowded] Waiting for deferred flush window...");
      await new Promise((r) => setTimeout(r, 8_000));

      // Now verify bot is still healthy and responsive
      driverA.clearReceivedAudio();
      console.log("[Crowded] Follow-up direct address to verify health...");
      await driverA.playAudio(greeting);

      const gotFollowup = await driverA.waitForAudioResponse(12_000);
      const followupBytes = driverA.getReceivedAudioBytes();
      console.log(`[Crowded] Follow-up response: ${gotFollowup ? "yes" : "no"} (${followupBytes} bytes)`);

      assert.ok(
        gotFollowup,
        `Bot should still respond after garbage storm during prior response (got ${followupBytes} bytes)`
      );
      assert.ok(driverA.isSystemBotInVoice(), "System bot should still be in voice");
    },
    90_000
  );
});
