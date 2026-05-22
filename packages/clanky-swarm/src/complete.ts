import type { SwarmLeaderState, SwarmLeaderStatus } from "./lifecycle.ts";

export const SWARM_COMPLETE_STATUSES = ["done", "failed", "cancelled"] as const;

export const SWARM_COMPLETE_TEST_STATUSES = ["passed", "failed", "skipped", "unknown"] as const;

export type SwarmCompleteStatus = (typeof SWARM_COMPLETE_STATUSES)[number];

export type SwarmCompleteTestStatus = (typeof SWARM_COMPLETE_TEST_STATUSES)[number];

export interface SwarmCompleteTestInput {
	command?: string;
	status: SwarmCompleteTestStatus;
	notes?: string;
}

export interface SwarmCompleteInput {
	taskId: string;
	status?: SwarmCompleteStatus;
	summary: string;
	filesChanged?: string[];
	tests?: SwarmCompleteTestInput[];
	trackerUpdate?: unknown;
	trackerUpdateSkipped?: unknown;
	followups?: string[];
}

export interface SwarmCompleteTestResult {
	status: SwarmCompleteTestStatus;
	command?: string;
	notes?: string;
}

export interface SwarmCompleteRequest {
	taskId: string;
	status: SwarmCompleteStatus;
	summary: string;
	filesChanged?: string[];
	tests?: SwarmCompleteTestResult[];
	trackerUpdate?: unknown;
	trackerUpdateSkipped?: unknown;
	followups?: string[];
}

export interface SwarmCompleteResult {
	ok: boolean;
	state: SwarmLeaderState;
	message: string;
	status: SwarmLeaderStatus;
	request: SwarmCompleteRequest;
	response?: unknown;
}

export function isSwarmCompleteStatus(value: unknown): value is SwarmCompleteStatus {
	return SWARM_COMPLETE_STATUSES.some((status) => status === value);
}

export function isSwarmCompleteTestStatus(value: unknown): value is SwarmCompleteTestStatus {
	return SWARM_COMPLETE_TEST_STATUSES.some((status) => status === value);
}

export function normalizeSwarmCompleteInput(input: SwarmCompleteInput): SwarmCompleteRequest {
	const taskId = nonEmptyString(input.taskId, "Swarm complete taskId must be a non-empty string");
	const summary = nonEmptyString(input.summary, "Swarm complete summary must be a non-empty string");
	const status = input.status ?? "done";
	if (!isSwarmCompleteStatus(status)) {
		throw new Error("Swarm complete status must be one of: done, failed, cancelled");
	}

	const request: SwarmCompleteRequest = { taskId, status, summary };
	const filesChanged = optionalStringArray(input.filesChanged, "Swarm complete filesChanged");
	if (filesChanged !== undefined) request.filesChanged = filesChanged;
	const tests = optionalTests(input.tests);
	if (tests !== undefined) request.tests = tests;
	if (input.trackerUpdate !== undefined) request.trackerUpdate = input.trackerUpdate;
	if (input.trackerUpdateSkipped !== undefined) request.trackerUpdateSkipped = input.trackerUpdateSkipped;
	const followups = optionalStringArray(input.followups, "Swarm complete followups");
	if (followups !== undefined) request.followups = followups;
	return request;
}

function optionalStringArray(values: string[] | undefined, label: string): string[] | undefined {
	if (values === undefined) return undefined;
	const result = values.map((value) => nonEmptyString(value, `${label} entries must be non-empty strings`));
	return result.length === 0 ? undefined : result;
}

function optionalTests(values: SwarmCompleteTestInput[] | undefined): SwarmCompleteTestResult[] | undefined {
	if (values === undefined) return undefined;
	const tests = values.map((value) => {
		if (!isSwarmCompleteTestStatus(value.status)) {
			throw new Error("Swarm complete test status must be one of: passed, failed, skipped, unknown");
		}
		const test: SwarmCompleteTestResult = { status: value.status };
		if (value.command !== undefined) {
			test.command = nonEmptyString(value.command, "Swarm complete test command must be a non-empty string");
		}
		if (value.notes !== undefined) {
			test.notes = nonEmptyString(value.notes, "Swarm complete test notes must be a non-empty string");
		}
		return test;
	});
	return tests.length === 0 ? undefined : tests;
}

function nonEmptyString(value: string, message: string): string {
	const trimmed = value.trim();
	if (trimmed.length === 0) throw new Error(message);
	return trimmed;
}
