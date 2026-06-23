import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
	evaluateVoiceLiveStatus,
	hasVoiceLiveValidationRequirements,
	type VoiceLiveValidationCheck,
	type VoiceLiveValidationRequirements,
} from "./liveValidation.ts";

export interface VoiceLiveValidationResultInput {
	startedAt: Date;
	finishedAt: Date;
	requirements: VoiceLiveValidationRequirements;
	failures?: string[];
	status?: unknown;
	phase?: string;
	error?: unknown;
}

export interface VoiceLiveValidationResult {
	startedAt: string;
	finishedAt: string;
	durationMs: number;
	phase?: string;
	validation: {
		enabled: boolean;
		passed: boolean;
		failures: string[];
		checks: VoiceLiveValidationCheck[];
		requirements: VoiceLiveValidationRequirements;
	};
	status?: unknown;
	error?: {
		name?: string;
		message: string;
	};
}

export function buildVoiceLiveValidationResult(input: VoiceLiveValidationResultInput): VoiceLiveValidationResult {
	const failures = input.failures ?? [];
	const error = normalizeError(input.error);
	const result: VoiceLiveValidationResult = {
		startedAt: input.startedAt.toISOString(),
		finishedAt: input.finishedAt.toISOString(),
		durationMs: input.finishedAt.getTime() - input.startedAt.getTime(),
		validation: {
			enabled: hasVoiceLiveValidationRequirements(input.requirements),
			passed: failures.length === 0 && error === undefined,
			failures,
			checks: input.status === undefined ? [] : evaluateVoiceLiveStatus(input.status, input.requirements),
			requirements: input.requirements,
		},
	};
	if (input.phase !== undefined) result.phase = input.phase;
	if (input.status !== undefined) result.status = input.status;
	if (error !== undefined) result.error = error;
	return result;
}

export async function writeVoiceLiveValidationResult(
	resultPath: string | undefined,
	input: VoiceLiveValidationResultInput,
): Promise<void> {
	if (resultPath === undefined || resultPath.length === 0) return;
	await mkdir(dirname(resultPath), { recursive: true });
	await writeFile(resultPath, `${JSON.stringify(buildVoiceLiveValidationResult(input), null, 2)}\n`, { mode: 0o600 });
}

function normalizeError(error: unknown): { name?: string; message: string } | undefined {
	if (error === undefined) return undefined;
	if (error instanceof Error) {
		const normalized: { name?: string; message: string } = { message: error.message };
		if (error.name.length > 0) normalized.name = error.name;
		return normalized;
	}
	return { message: String(error) };
}
