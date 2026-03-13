const NATIVE_DISCORD_FRAME_DECODE_TIMEOUT_MS = 3_000;

let cachedFfmpegPath: string | null | undefined;

function resolveFfmpegPath(): string | null {
  if (cachedFfmpegPath !== undefined) {
    return cachedFfmpegPath;
  }
  cachedFfmpegPath =
    typeof Bun !== "undefined" && typeof Bun.which === "function"
      ? Bun.which("ffmpeg") || null
      : null;
  return cachedFfmpegPath;
}

function parseVp8KeyframeResolution(frame: Buffer): { width: number; height: number } | null {
  if (frame.length < 10) return null;
  const frameTag = frame[0] | (frame[1] << 8) | (frame[2] << 16);
  const isKeyframe = (frameTag & 0x01) === 0;
  if (!isKeyframe) return null;
  if (frame[3] !== 0x9d || frame[4] !== 0x01 || frame[5] !== 0x2a) {
    return null;
  }
  const width = frame.readUInt16LE(6) & 0x3fff;
  const height = frame.readUInt16LE(8) & 0x3fff;
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

function buildSingleFrameVp8IvfBuffer(frame: Buffer, rtpTimestamp: number): Buffer {
  const resolution = parseVp8KeyframeResolution(frame);
  if (!resolution) {
    throw new Error("vp8_keyframe_resolution_unavailable");
  }

  const header = Buffer.alloc(32);
  header.write("DKIF", 0, "ascii");
  header.writeUInt16LE(0, 4);
  header.writeUInt16LE(32, 6);
  header.write("VP80", 8, "ascii");
  header.writeUInt16LE(resolution.width, 12);
  header.writeUInt16LE(resolution.height, 14);
  header.writeUInt32LE(1, 16);
  header.writeUInt32LE(1, 20);
  header.writeUInt32LE(1, 24);
  header.writeUInt32LE(0, 28);

  const frameHeader = Buffer.alloc(12);
  frameHeader.writeUInt32LE(frame.length, 0);
  frameHeader.writeBigUInt64LE(BigInt(Math.max(0, Math.floor(Number(rtpTimestamp) || 0))), 4);

  return Buffer.concat([header, frameHeader, frame]);
}

function startsWithAnnexBStartCode(frame: Buffer): boolean {
  return frame.subarray(0, 4).equals(Buffer.from([0, 0, 0, 1])) ||
    frame.subarray(0, 3).equals(Buffer.from([0, 0, 1]));
}

function convertLengthPrefixedH264ToAnnexB(frame: Buffer): Buffer | null {
  if (frame.length < 5) {
    return null;
  }

  let cursor = 0;
  const nalUnits: Buffer[] = [];
  while (cursor + 4 <= frame.length) {
    const nalLength = frame.readUInt32BE(cursor);
    cursor += 4;
    if (nalLength <= 0 || cursor + nalLength > frame.length) {
      return null;
    }
    nalUnits.push(Buffer.concat([Buffer.from([0, 0, 0, 1]), frame.subarray(cursor, cursor + nalLength)]));
    cursor += nalLength;
  }

  if (cursor !== frame.length || nalUnits.length === 0) {
    return null;
  }

  return Buffer.concat(nalUnits);
}

export function normalizeH264FrameForDecoding(frame: Buffer): Buffer {
  if (startsWithAnnexBStartCode(frame)) {
    return frame;
  }

  return convertLengthPrefixedH264ToAnnexB(frame) || frame;
}

function resolveVideoFrameInput({
  codec,
  frame,
  rtpTimestamp
}: {
  codec: string;
  frame: Buffer;
  rtpTimestamp: number;
}) {
  const normalizedCodec = String(codec || "").trim().toLowerCase();
  switch (normalizedCodec) {
    case "h264":
      return {
        inputFormat: "h264",
        payload: normalizeH264FrameForDecoding(frame)
      };
    case "vp8":
      return {
        inputFormat: "ivf",
        payload: buildSingleFrameVp8IvfBuffer(frame, rtpTimestamp)
      };
    default:
      throw new Error(`unsupported_native_video_codec:${normalizedCodec || "unknown"}`);
  }
}

export function hasNativeDiscordVideoDecoderSupport(): boolean {
  return Boolean(resolveFfmpegPath());
}

export async function decodeNativeDiscordVideoFrameToJpeg({
  codec,
  frameBase64,
  rtpTimestamp
}: {
  codec: string;
  frameBase64: string;
  rtpTimestamp: number;
}): Promise<{ mimeType: "image/jpeg"; dataBase64: string }> {
  const ffmpegPath = resolveFfmpegPath();
  if (!ffmpegPath) {
    throw new Error("ffmpeg_not_installed");
  }

  const frame = Buffer.from(String(frameBase64 || "").trim(), "base64");
  if (frame.length <= 0) {
    throw new Error("native_video_frame_empty");
  }

  const { inputFormat, payload } = resolveVideoFrameInput({
    codec,
    frame,
    rtpTimestamp
  });

  const process = Bun.spawn(
    [
      ffmpegPath,
      "-nostdin",
      "-loglevel",
      "error",
      "-f",
      inputFormat,
      "-i",
      "pipe:0",
      "-frames:v",
      "1",
      "-f",
      "image2pipe",
      "-vcodec",
      "mjpeg",
      "pipe:1"
    ],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe"
    }
  );

  const timeout = setTimeout(() => {
    try {
      process.kill("SIGKILL");
    } catch {
      // ignore
    }
  }, NATIVE_DISCORD_FRAME_DECODE_TIMEOUT_MS);

  try {
    process.stdin.write(payload);
    process.stdin.end();

    const [stdoutBuffer, stderrText, exitCode] = await Promise.all([
      new Response(process.stdout).arrayBuffer(),
      new Response(process.stderr).text(),
      process.exited
    ]);

    if (exitCode !== 0) {
      throw new Error(String(stderrText || `ffmpeg_exit_${exitCode}`).trim() || `ffmpeg_exit_${exitCode}`);
    }

    const output = Buffer.from(stdoutBuffer);
    if (output.length <= 0) {
      throw new Error("ffmpeg_empty_frame_output");
    }

    return {
      mimeType: "image/jpeg",
      dataBase64: output.toString("base64")
    };
  } finally {
    clearTimeout(timeout);
  }
}
