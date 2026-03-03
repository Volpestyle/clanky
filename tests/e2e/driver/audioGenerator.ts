import { spawn } from "node:child_process";
import { writeFile, mkdir, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "node:process";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures");

export type AudioGeneratorResult = {
  path: string;
  durationMs: number;
  sampleRate: number;
  channels: number;
};

async function ensureFixturesDir(): Promise<void> {
  await mkdir(FIXTURES_DIR, { recursive: true });
}

function findFfmpeg(): string {
  return env.FFMPEG_PATH || "ffmpeg";
}

async function getPcmDurationMs(path: string, sampleRate = 48000, channels = 1): Promise<number> {
  const { stat } = await import("node:fs/promises");
  const { size } = await stat(path);
  const bytesPerSample = 2; // s16le
  return Math.round((size / bytesPerSample / channels / sampleRate) * 1000);
}

async function getWavDurationMs(path: string): Promise<number> {
  const { stat } = await import("node:fs/promises");
  const { size } = await stat(path);
  // WAV header = 44 bytes, data is stereo 48kHz s16le (4 bytes per frame)
  const dataBytes = Math.max(0, size - 44);
  const bytesPerFrame = 4; // 2 channels × 2 bytes
  return Math.round((dataBytes / bytesPerFrame / 48000) * 1000);
}

export async function generatePcmAudioFixture(
  name: string,
  text: string
): Promise<AudioGeneratorResult> {
  await ensureFixturesDir();

  const outputPath = join(FIXTURES_DIR, `${name}.wav`);
  const tmpAiff = join(FIXTURES_DIR, `${name}.tmp.aiff`);

  // Step 1: Use macOS `say` to synthesize speech to AIFF
  await new Promise<void>((resolve, reject) => {
    const say = spawn("say", ["-o", tmpAiff, text]);

    say.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`say exited with code ${code}`));
      }
    });

    say.on("error", (err) => {
      reject(new Error(`say not available: ${err.message}. macOS required for TTS fixture generation.`));
    });
  });

  // Step 2: Convert AIFF → 48kHz stereo s16le WAV via ffmpeg
  // WAV headers let createAudioResource auto-probe format correctly
  // (raw PCM has no headers → ffmpeg can't detect format → silent playback)
  await new Promise<void>((resolve, reject) => {
    const ffmpeg = spawn(findFfmpeg(), [
      "-y",
      "-i",
      tmpAiff,
      "-ar",
      "48000",
      "-ac",
      "2",
      "-acodec",
      "pcm_s16le",
      outputPath
    ]);

    ffmpeg.on("close", (code) => {
      unlink(tmpAiff).catch(() => {});
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg exited with code ${code}`));
      }
    });

    ffmpeg.on("error", reject);
  });

  const durationMs = await getWavDurationMs(outputPath);

  return {
    path: outputPath,
    durationMs,
    sampleRate: 48000,
    channels: 2
  };
}

export async function writeRawPcmFixture(
  name: string,
  buffer: Buffer,
  sampleRate = 48000,
  channels = 1
): Promise<AudioGeneratorResult> {
  await ensureFixturesDir();

  const outputPath = join(FIXTURES_DIR, `${name}.pcm`);
  await writeFile(outputPath, buffer);

  return {
    path: outputPath,
    durationMs: Math.round((buffer.length / 2 / channels / sampleRate) * 1000),
    sampleRate,
    channels
  };
}

export function getFixturePath(name: string): string {
  return join(FIXTURES_DIR, `${name}.wav`);
}

export function parsePcmDurationMs(buffer: Buffer, sampleRate = 48000, channels = 1): number {
  return Math.round((buffer.length / 2 / channels / sampleRate) * 1000);
}
