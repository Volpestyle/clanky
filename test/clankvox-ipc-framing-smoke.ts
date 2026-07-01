import { CLANKVOX_MAX_FRAME_BYTES, ClankvoxFrameDecoder } from "../agent/lib/voice/clankvoxIpcClient.ts";

let failures = 0;

function check(label: string, ok: boolean): void {
	console.log(`${ok ? "ok  " : "FAIL"}  ${label}`);
	if (!ok) failures += 1;
}

function frame(format: number, payload: Buffer): Buffer {
	const header = Buffer.alloc(5);
	header.writeUInt8(format, 0);
	header.writeUInt32LE(payload.length, 1);
	return Buffer.concat([header, payload]);
}

function binaryAudioPayload(userId: bigint, pcm: Buffer): Buffer {
	const header = Buffer.alloc(18);
	header.writeBigUInt64LE(userId, 0);
	return Buffer.concat([header, pcm]);
}

// Whole JSON frame in one chunk.
{
	const decoder = new ClankvoxFrameDecoder();
	const payload = Buffer.from(JSON.stringify({ type: "ready" }), "utf8");
	const result = decoder.push(frame(0, payload));
	check("json frame decodes in one chunk", result.frames.length === 1);
	check("json frame keeps format byte", result.frames[0]?.format === 0);
	check("json frame keeps payload", result.frames[0]?.payload.toString("utf8") === payload.toString("utf8"));
	check("json frame reports no fault", result.fault === undefined);
}

// Frame split across arbitrary chunk boundaries.
{
	const decoder = new ClankvoxFrameDecoder();
	const payload = Buffer.from(JSON.stringify({ type: "speaking_start", userId: "42" }), "utf8");
	const whole = frame(0, payload);
	const first = decoder.push(whole.subarray(0, 3));
	const second = decoder.push(whole.subarray(3, 9));
	const third = decoder.push(whole.subarray(9));
	check("split frame yields nothing before completion", first.frames.length === 0 && second.frames.length === 0);
	check("split frame decodes once complete", third.frames.length === 1);
	check("split frame payload intact", third.frames[0]?.payload.toString("utf8") === payload.toString("utf8"));
}

// Multiple frames (json + binary audio) in a single chunk.
{
	const decoder = new ClankvoxFrameDecoder();
	const json = Buffer.from(JSON.stringify({ type: "ready" }), "utf8");
	const pcm = Buffer.from([1, 2, 3, 4]);
	const chunk = Buffer.concat([frame(0, json), frame(1, binaryAudioPayload(7n, pcm))]);
	const result = decoder.push(chunk);
	check("mixed chunk decodes both frames", result.frames.length === 2);
	check("mixed chunk preserves order", result.frames[0]?.format === 0 && result.frames[1]?.format === 1);
	check("binary payload intact", result.frames[1]?.payload.subarray(18).equals(pcm) === true);
}

// Oversized length prefix is a fatal desync fault, not a silent buffer bomb.
{
	const decoder = new ClankvoxFrameDecoder();
	const header = Buffer.alloc(5);
	header.writeUInt8(0, 0);
	header.writeUInt32LE(CLANKVOX_MAX_FRAME_BYTES + 1, 1);
	const result = decoder.push(header);
	check("oversized frame faults", result.fault?.includes("exceeds cap") === true);
	check("oversized frame yields no frames", result.frames.length === 0);
	const after = decoder.push(frame(0, Buffer.from("{}", "utf8")));
	check("decoder stays faulted after oversize", after.frames.length === 0);
}

// Unknown format byte is a fatal desync fault (the length prefix is garbage).
{
	const decoder = new ClankvoxFrameDecoder();
	const good = frame(0, Buffer.from(JSON.stringify({ type: "ready" }), "utf8"));
	const stray = Buffer.from([0x37, 0x00, 0x00, 0x00, 0x99]);
	const result = decoder.push(Buffer.concat([good, stray]));
	check("frames before the desync still decode", result.frames.length === 1);
	check("unknown format byte faults", result.fault?.includes("format byte") === true);
	const after = decoder.push(good);
	check("decoder stays faulted after bad format", after.frames.length === 0 && after.fault === undefined);
}

// Zero-length payload frames are legal.
{
	const decoder = new ClankvoxFrameDecoder();
	const result = decoder.push(frame(1, Buffer.alloc(0)));
	check("zero-length frame decodes", result.frames.length === 1 && result.frames[0]?.payload.length === 0);
}

if (failures > 0) {
	console.error(`\n${failures} check(s) failed`);
	process.exitCode = 1;
} else {
	console.log("\nALL OK");
}
