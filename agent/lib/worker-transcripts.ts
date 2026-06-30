export const CLANKY_WORKER_TRANSCRIPTS_ENV = "CLANKY_WORKER_TRANSCRIPTS";

const TRUTHY_WORKER_TRANSCRIPT_VALUES = new Set(["1", "true", "yes", "on", "enabled", "enable"]);
const FALSY_WORKER_TRANSCRIPT_VALUES = new Set(["0", "false", "no", "off", "disabled", "disable"]);

/**
 * Global default for Clanky worker transcript capture. Undefined means the
 * historical default: enabled. Per-spawn booleans still override this default.
 */
export function parseWorkerTranscriptToggle(value: string | undefined): boolean | undefined {
	const normalized = value?.trim().toLowerCase();
	if (normalized === undefined || normalized.length === 0) return undefined;
	if (TRUTHY_WORKER_TRANSCRIPT_VALUES.has(normalized)) return true;
	if (FALSY_WORKER_TRANSCRIPT_VALUES.has(normalized)) return false;
	return undefined;
}

export function workerTranscriptsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return parseWorkerTranscriptToggle(env[CLANKY_WORKER_TRANSCRIPTS_ENV]) ?? true;
}

export function resolveWorkerTranscriptSetting(input: {
	override?: boolean;
	env?: NodeJS.ProcessEnv;
} = {}): boolean {
	return input.override ?? workerTranscriptsEnabled(input.env);
}
