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

const SKIP_MSG = "Skipping music play-now E2E tests: set RUN_E2E_MUSIC=1";

/**
 * Non-blocking music_play_now E2E tests.
 *
 * Validates that when a user asks to play music via voice, the bot
 * acknowledges immediately (within a few seconds) rather than blocking
 * for the full yt-dlp download (~17s).
 *
 * Requires: RUN_E2E_MUSIC=1 and standard E2E env vars.
 */
describe("E2E: Voice music_play_now (non-blocking)", () => {
  let driver: DriverBot;
  let driverB: DriverBot | null = null;

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

  /** Wait for clanker to finish speaking, then clear the audio buffer. */
  async function settleAndClear(settleMs = 3_000): Promise<void> {
    await new Promise((r) => setTimeout(r, settleMs));
    driver.clearReceivedAudio();
    driverB?.clearReceivedAudio();
  }

  async function stopMusic(): Promise<void> {
    const stopFixture = await ensureFixture(
      "music_stop_voice",
      "Hey clanker, stop the music"
    );
    driver.clearReceivedAudio();
    await driver.playAudio(stopFixture);
    await driver.waitForAudioResponse(10_000);
    await new Promise((r) => setTimeout(r, 3_000));
  }

  beforeAll(async () => {
    if (!hasE2EConfig() || !envFlag("RUN_E2E_MUSIC")) {
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

    driver = new DriverBot({ ...baseConfig, token: config.driverBotToken });
    await driver.connect();
    await driver.joinVoiceChannel();

    // Connect second driver bot if available (needed for chatter resilience test)
    if (hasDialogueE2EConfig()) {
      try {
        const b = new DriverBot({ ...baseConfig, token: config.driverBot2Token });
        await b.connect();
        await b.joinVoiceChannel();
        driverB = b;
      } catch (err) {
        console.log(`[Music] Driver B failed to join voice, chatter test will skip: ${(err as Error).message}`);
        driverB = null;
      }
    }

    await driver.summonSystemBot(45_000);
  }, 120_000);

  afterAll(async () => {
    // Safety cleanup — stop any lingering music
    try { await stopMusic(); } catch { /* ignore */ }
    try { await driver?.dismissBot("dismiss_music", "Yo clanker, thanks for the tunes, you can bounce now!"); } catch { /* ignore */ }
    await Promise.all([
      driver?.destroy(),
      driverB?.destroy()
    ]);
    await restoreTemporaryE2ESettings();
  }, 60_000);

  // ─────────────────────────────────────────────────────────────────────
  // Test 1: Full lifecycle — ack, download notification
  // ─────────────────────────────────────────────────────────────────────
  test(
    "Music: Full lifecycle — fast ack, now-playing notification",
    async () => {
      if (!hasE2EConfig() || !envFlag("RUN_E2E_MUSIC")) return;

      const maxAckMs = envNumber("E2E_MUSIC_ACK_MAX_MS", 8_000);
      const downloadWaitMs = envNumber("E2E_MUSIC_DOWNLOAD_WAIT_MS", 30_000);

      const playFixture = await ensureFixture(
        "music_play_request",
        "Hey clanker, play Bad and Boujee by Migos"
      );

      // --- Phase 1: Request song, verify fast ack (non-blocking) ---
      await settleAndClear(3_000);

      console.log("[Lifecycle] Playing music request...");
      await driver.playAudio(playFixture);

      const start = Date.now();
      const gotAck = await driver.waitForAudioResponse(maxAckMs);
      const ackMs = Date.now() - start;
      console.log(`[Lifecycle] Ack: ${gotAck ? "yes" : "no"} (${ackMs}ms)`);

      assert.ok(gotAck, `Bot should ack within ${maxAckMs}ms (got no audio — tool may still be blocking)`);
      assert.ok(ackMs < maxAckMs, `Ack latency ${ackMs}ms exceeds ${maxAckMs}ms`);

      const ackBytes = driver.getReceivedAudioBytes();

      // --- Phase 2: Wait for download, verify "now playing" notification ---
      console.log(`[Lifecycle] Waiting ${downloadWaitMs}ms for download + now-playing...`);
      await new Promise((r) => setTimeout(r, downloadWaitMs));

      const postDownloadBytes = driver.getReceivedAudioBytes();
      console.log(`[Lifecycle] Audio — ack: ${ackBytes}, postDownload: ${postDownloadBytes}`);

      assert.ok(
        postDownloadBytes > ackBytes,
        `Expected "now playing" notification after download. Ack: ${ackBytes}, total: ${postDownloadBytes}`
      );

      // NOTE: Do NOT stopMusic() here — music stays playing for the duck in/out test
    },
    120_000
  );

  // ─────────────────────────────────────────────────────────────────────
  // Test 2: Duck in/out — direct address during playback
  // ─────────────────────────────────────────────────────────────────────
  test(
    "Music: Direct address during playback — duck in/out",
    async () => {
      if (!hasE2EConfig() || !envFlag("RUN_E2E_MUSIC")) return;

      // Music is still playing from test 1
      // Ask "who sings this" — tests direct address through command-only gate
      const whoSingsFixture = await ensureFixture(
        "music_who_sings",
        "Hey clanker, who sings this song?"
      );

      await settleAndClear(3_000);

      console.log("[DuckInOut] Asking 'who sings this song?'...");
      await driver.playAudio(whoSingsFixture);

      const gotResponse = await driver.waitForAudioResponse(10_000);
      const responseBytes = driver.getReceivedAudioBytes();
      console.log(`[DuckInOut] Response: ${gotResponse ? "yes" : "no"} (${responseBytes} bytes)`);

      assert.ok(gotResponse, "Bot should respond to direct address during music playback");

      // Wait for bot to finish speaking, then verify music continues
      await new Promise((r) => setTimeout(r, 5_000));
      driver.clearReceivedAudio();
      await new Promise((r) => setTimeout(r, 5_000));
      const musicResumeBytes = driver.getReceivedAudioBytes();
      console.log(`[DuckInOut] Music resume: ${musicResumeBytes} bytes after bot response`);

      assert.ok(musicResumeBytes > 0, "Music should continue playing after bot responds (duck out)");

      await stopMusic();
    },
    60_000
  );

  // ─────────────────────────────────────────────────────────────────────
  // Test 3: Double queue backtrack — second request replaces first
  // ─────────────────────────────────────────────────────────────────────
  test(
    "Music: Double queue backtrack — second request replaces first",
    async () => {
      if (!hasE2EConfig() || !envFlag("RUN_E2E_MUSIC")) return;

      const downloadWaitMs = envNumber("E2E_MUSIC_DOWNLOAD_WAIT_MS", 30_000);

      const firstRequest = await ensureFixture(
        "music_backtrack_first",
        "Hey clanker, play Bad and Boujee by Migos"
      );
      const secondRequest = await ensureFixture(
        "music_backtrack_second",
        "Hey clanker, actually play Sicko Mode by Travis Scott instead"
      );

      // --- Phase 1: First request, wait for ack ---
      await settleAndClear(5_000);

      console.log("[Backtrack] First request...");
      await driver.playAudio(firstRequest);

      const gotFirstAck = await driver.waitForAudioResponse(10_000);
      console.log(`[Backtrack] First ack: ${gotFirstAck ? "yes" : "no"} (${driver.getReceivedAudioBytes()} bytes)`);
      assert.ok(gotFirstAck, "Bot should ack first request");

      // --- Phase 2: Immediately send second request ---
      // Let first ack finish speaking, then fire the replacement.
      // The first download is in-flight — clanker should cancel and switch.
      await settleAndClear(2_000);

      console.log("[Backtrack] Second request (replacement)...");
      await driver.playAudio(secondRequest);

      const gotSecondAck = await driver.waitForAudioResponse(10_000);
      const secondAckBytes = driver.getReceivedAudioBytes();
      console.log(`[Backtrack] Second ack: ${gotSecondAck ? "yes" : "no"} (${secondAckBytes} bytes)`);
      assert.ok(gotSecondAck, "Bot should ack second (replacement) request");

      // --- Phase 3: Wait for download, verify "now playing" fires ---
      console.log(`[Backtrack] Waiting ${downloadWaitMs}ms for download...`);
      await new Promise((r) => setTimeout(r, downloadWaitMs));

      const totalBytes = driver.getReceivedAudioBytes();
      console.log(`[Backtrack] Audio — secondAck: ${secondAckBytes}, total: ${totalBytes}`);

      assert.ok(
        totalBytes > secondAckBytes,
        `"Now playing" should fire for replacement track. Ack: ${secondAckBytes}, total: ${totalBytes}`
      );

      await stopMusic();
    },
    120_000
  );

  // ─────────────────────────────────────────────────────────────────────
  // Test 4: Disambiguation + chatter — bot stays locked on requester
  // ─────────────────────────────────────────────────────────────────────
  test(
    "Music: Disambiguation with background chatter — bot stays locked on requester's selection",
    async () => {
      if (!hasE2EConfig() || !envFlag("RUN_E2E_MUSIC")) return;
      if (!driverB) {
        console.log("[Music] Skipping disambiguation chatter test: no E2E_DRIVER_BOT_2_TOKEN");
        return;
      }

      const downloadWaitMs = envNumber("E2E_MUSIC_DOWNLOAD_WAIT_MS", 30_000);

      // Pre-generate all fixtures in parallel.
      // "play Roses" is intentionally vague — could be Outkast, SAINt JHN, etc.
      const [
        vagueRequest,
        chatterB1,
        chatterA1,
        chatterB2,
        chatterA2,
        disambiguationReply
      ] = await Promise.all([
        ensureFixture("music_disambig_vague", "Hey clanker, play Roses"),
        ensureFixture("music_disambig_chatter_b1", "Hey have you tried that new ramen place on fifth street?"),
        ensureFixture("music_disambig_chatter_a1", "No not yet, is it any good? I heard mixed things about it."),
        ensureFixture("music_disambig_chatter_b2", "It's amazing honestly, the tonkotsu is the best I've had."),
        ensureFixture("music_disambig_chatter_a2", "Alright bet, let's go there for lunch tomorrow then."),
        ensureFixture("music_disambig_selection", "The first one")
      ]);

      // --- Phase 1: Vague music request → disambiguation ---
      await settleAndClear(5_000);

      console.log("[Disambig] Vague music request...");
      await driver.playAudio(vagueRequest);

      const gotResponse = await driver.waitForAudioResponse(15_000);
      assert.ok(gotResponse, "Bot should respond to vague request (disambiguation or direct play)");
      console.log(`[Disambig] Initial response: ${driver.getReceivedAudioBytes()} bytes`);

      // --- Phase 2: Chatter fires during disambiguation window ---
      // Other users are talking but not addressing clanker. He should stay
      // locked on Driver A's pending music request.
      console.log("[Disambig] Background chatter during disambiguation window...");

      await new Promise((r) => setTimeout(r, 500));
      console.log("[Disambig] Driver B chatter 1...");
      await driverB.playAudio(chatterB1);

      await new Promise((r) => setTimeout(r, 800));
      console.log("[Disambig] Driver A chatter 1 (NOT addressing clanker)...");
      await driver.playAudio(chatterA1);

      await new Promise((r) => setTimeout(r, 800));
      console.log("[Disambig] Driver B chatter 2...");
      await driverB.playAudio(chatterB2);

      // --- Phase 3: Chatter stops, Driver A disambiguates ---
      // Clear break from chatter before the disambiguation reply.
      await settleAndClear(3_000);

      console.log("[Disambig] Driver A: 'the first one'...");
      await driver.playAudio(disambiguationReply);

      const gotSelectionAck = await driver.waitForAudioResponse(10_000);
      const selectionAckBytes = driver.getReceivedAudioBytes();
      console.log(`[Disambig] Selection ack: ${gotSelectionAck ? "yes" : "no"} (${selectionAckBytes} bytes)`);

      // --- Phase 4: Chatter resumes after disambiguation ---
      await new Promise((r) => setTimeout(r, 500));
      console.log("[Disambig] Driver A chatter 2 (resumes talking to B)...");
      await driver.playAudio(chatterA2);

      assert.ok(
        gotSelectionAck,
        `Bot should ack disambiguation selection after chatter break (got ${selectionAckBytes} bytes)`
      );

      // --- Phase 5: Wait for download, verify "now playing" fires ---
      console.log(`[Disambig] Waiting ${downloadWaitMs}ms for download...`);
      await new Promise((r) => setTimeout(r, downloadWaitMs));

      const totalBytes = driver.getReceivedAudioBytes();
      console.log(`[Disambig] Audio — selectionAck: ${selectionAckBytes}, total: ${totalBytes}`);

      assert.ok(
        totalBytes > selectionAckBytes,
        `Music flow should complete after disambiguation + chatter. ` +
        `Ack: ${selectionAckBytes}, total: ${totalBytes}`
      );

      await stopMusic();
    },
    120_000
  );
});
