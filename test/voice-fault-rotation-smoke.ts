// Offline smoke for voice fault-log growth control (agent/lib/voice/fault-log.ts):
// bounded tail reads on an oversized log, size-budget rotation on write, and
// the rotated-generation fallback. Run: node test/voice-fault-rotation-smoke.ts
import { appendFileSync, existsSync, renameSync, statSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readLastVoiceFault, recordVoiceFault, type VoiceFaultRecord } from "../agent/lib/voice/fault-log.ts";

let failures = 0;
function check(label: string, ok: boolean): void {
	console.log(`${ok ? "ok  " : "FAIL"}  ${label}`);
	if (!ok) failures += 1;
}

function fault(detail: string): VoiceFaultRecord {
	return {
		at: new Date().toISOString(),
		guildId: "g1",
		channelId: "c1",
		kind: "socket_closed",
		detail,
	};
}

const ROTATION_BUDGET_BYTES = 1024 * 1024;

async function main(): Promise<void> {
	const home = await mkdtemp(join(tmpdir(), "clanky-voice-fault-rotation-"));
	const env = { CLANKY_HOME: home } as NodeJS.ProcessEnv;
	const logPath = join(home, "voice/faults.jsonl");
	try {
		// Newest record still wins when the log is far bigger than the read window.
		await mkdir(dirname(logPath), { recursive: true });
		const filler = `${JSON.stringify(fault(`old ${"x".repeat(400)}`))}\n`;
		writeFileSync(logPath, filler.repeat(Math.ceil(ROTATION_BUDGET_BYTES / filler.length) + 8));
		appendFileSync(logPath, `${JSON.stringify(fault("newest before rotation"))}\n`);
		check("tail read finds the newest record in an oversized log", readLastVoiceFault(env)?.detail === "newest before rotation");

		// A corrupt trailing partial line falls back to the previous complete record.
		appendFileSync(logPath, '{"broken');
		check("partial trailing line falls back to the last complete record", readLastVoiceFault(env)?.detail === "newest before rotation");

		// The next write rotates the oversized log and starts a fresh one.
		const sizeBefore = statSync(logPath).size;
		check("log is at the rotation budget before the write", sizeBefore >= ROTATION_BUDGET_BYTES);
		recordVoiceFault(fault("first after rotation"), env);
		check("rotation leaves a small current log", statSync(logPath).size < 4096);
		check("rotation keeps one previous generation", existsSync(`${logPath}.1`));
		check("newest record is read from the current log", readLastVoiceFault(env)?.detail === "first after rotation");

		// Repeated writes do not rotate again until the budget is hit.
		recordVoiceFault(fault("second after rotation"), env);
		check("subsequent writes append without rotating", readLastVoiceFault(env)?.detail === "second after rotation");

		// If only the rotated generation exists, reads fall back to it.
		renameSync(logPath, `${logPath}.1`);
		check("read falls back to the rotated generation", readLastVoiceFault(env)?.detail === "second after rotation");
	} finally {
		await rm(home, { recursive: true, force: true });
	}

	console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILED`);
	process.exit(failures === 0 ? 0 : 1);
}

void main();
