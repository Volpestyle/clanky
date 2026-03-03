import { spawn } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
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

function findFfprobe(): string {
  return env.FFPROBE_PATH || "ffprobe";
}

async function getAudioDurationMs(path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn(findFfprobe(), [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      path
    ]);

    let output = "";
    ffprobe.stdout.on("data", (data) => {
      output += data.toString();
    });

    ffprobe.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe exited with code ${code}`));
        return;
      }
      const seconds = parseFloat(output.trim());
      if (Number.isNaN(seconds)) {
        reject(new Error(`Could not parse duration: ${output}`));
        return;
      }
      resolve(Math.round(seconds * 1000));
    });

    ffprobe.on("error", reject);
  });
}

export async function generatePcmAudioFixture(
  name: string,
  text: string
): Promise<AudioGeneratorResult> {
  await ensureFixturesDir();

  const outputPath = join(FIXTURES_DIR, `${name}.pcm`);

  await new Promise<void>((resolve, reject) => {
    const ffmpeg = spawn(findFfmpeg(), [
      "-f",
      "tts",
      "-i",
      text,
      "-ar",
      "48000",
      "-ac",
      "1",
      "-f",
      "s16le",
      outputPath
    ]);

    ffmpeg.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg exited with code ${code}`));
      }
    });

    ffmpeg.on("error", reject);
  });

  const durationMs = await getAudioDurationMs(outputPath);

  return {
    path: outputPath,
    durationMs,
    sampleRate: 48000,
    channels: 1
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
  return join(FIXTURES_DIR, `${name}.pcm`);
}

export function parsePcmDurationMs(buffer: Buffer, sampleRate = 48000, channels = 1): number {
  return Math.round((buffer.length / 2 / channels / sampleRate) * 1000);
}
