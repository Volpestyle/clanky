/**
 * Durable record of unexpected voice-session faults (SPEC.md §5.3). Voice drops
 * tear the session down (no auto-reconnect), and the realtime close code or
 * ClankVox panic that caused them otherwise only reaches the brain's ephemeral
 * stderr. Appending each fault here keeps the "why did Clanky leave VC" answer
 * recoverable after the fact, and `readLastVoiceFault` surfaces it in voice
 * status for the debug skill.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
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

function voiceFaultLogPath(env: NodeJS.ProcessEnv): string {
	return resolveClankyDataPath("voice/faults.jsonl", env);
}

export function recordVoiceFault(record: VoiceFaultRecord, env: NodeJS.ProcessEnv = process.env): void {
	const path = voiceFaultLogPath(env);
	try {
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, `${JSON.stringify(record)}\n`);
	} catch {
		// Diagnostics are best-effort; never let a logging failure mask the fault.
	}
}

export function readLastVoiceFault(env: NodeJS.ProcessEnv = process.env): VoiceFaultRecord | undefined {
	try {
		const lines = readFileSync(voiceFaultLogPath(env), "utf8").trim().split(/\r?\n/);
		const last = lines.at(-1);
		if (last === undefined || last.length === 0) return undefined;
		return JSON.parse(last) as VoiceFaultRecord;
	} catch {
		return undefined;
	}
}
