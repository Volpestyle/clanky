/**
 * Durable record of unexpected voice-session faults (SPEC.md §5.3). Voice drops
 * tear the session down (no auto-reconnect), and the realtime close code or
 * ClankVox panic that caused them otherwise only reaches the brain's ephemeral
 * stderr. Appending each fault here keeps the "why did Clanky leave VC" answer
 * recoverable after the fact, and `readLastVoiceFault` surfaces it in voice
 * status for the debug skill.
 */
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { resolveClankyDataPath } from "../paths.ts";
import type { VoiceSessionFault } from "./supervisor.ts";

export interface VoiceFaultRecord {
	at: string;
	guildId: string;
	channelId: string;
	kind: VoiceSessionFault["kind"];
	detail: string;
	stderrTail?: readonly string[];
}

// When the log outgrows this budget it rotates to `<path>.1` (one generation
// kept), so an unattended brain cannot grow it without bound.
const FAULT_LOG_MAX_BYTES = 1024 * 1024;
// Status calls only need the newest record, so reads stay bounded to a tail
// window instead of loading the whole log. Twice the rotation budget: any
// record appended to a pre-rotation log (even a pathologically large stderr
// tail) still fits inside the window.
const FAULT_READ_TAIL_BYTES = 2 * FAULT_LOG_MAX_BYTES;
const ROTATED_LOG_SUFFIX = ".1";

function voiceFaultLogPath(env: NodeJS.ProcessEnv): string {
	return resolveClankyDataPath("voice/faults.jsonl", env);
}

export function recordVoiceFault(record: VoiceFaultRecord, env: NodeJS.ProcessEnv = process.env): void {
	const path = voiceFaultLogPath(env);
	try {
		mkdirSync(dirname(path), { recursive: true });
		rotateIfOversized(path);
		appendFileSync(path, `${JSON.stringify(record)}\n`);
	} catch {
		// Diagnostics are best-effort; never let a logging failure mask the fault.
	}
}

export function readLastVoiceFault(env: NodeJS.ProcessEnv = process.env): VoiceFaultRecord | undefined {
	const path = voiceFaultLogPath(env);
	// The current log always holds the newest record (rotation happens before an
	// append); the rotated generation is only consulted when the log is missing
	// or empty, e.g. immediately after an interrupted rotation.
	return readLastRecord(path) ?? readLastRecord(`${path}${ROTATED_LOG_SUFFIX}`);
}

function rotateIfOversized(path: string): void {
	let size: number;
	try {
		size = statSync(path).size;
	} catch {
		return;
	}
	if (size < FAULT_LOG_MAX_BYTES) return;
	renameSync(path, `${path}${ROTATED_LOG_SUFFIX}`);
}

function readLastRecord(path: string): VoiceFaultRecord | undefined {
	let fd: number;
	try {
		fd = openSync(path, "r");
	} catch {
		return undefined;
	}
	try {
		const size = fstatSync(fd).size;
		const length = Math.min(size, FAULT_READ_TAIL_BYTES);
		if (length === 0) return undefined;
		const buffer = Buffer.alloc(length);
		const bytesRead = readSync(fd, buffer, 0, length, size - length);
		const lines = buffer.toString("utf8", 0, bytesRead).trim().split(/\r?\n/);
		// Parse from the end: the newest line is always complete (appends are whole
		// lines); only the window's first line can be a truncated partial record.
		for (let index = lines.length - 1; index >= 0; index -= 1) {
			const line = lines[index];
			if (line === undefined || line.length === 0) continue;
			try {
				return JSON.parse(line) as VoiceFaultRecord;
			} catch {
			}
		}
		return undefined;
	} catch {
		return undefined;
	} finally {
		closeSync(fd);
	}
}
