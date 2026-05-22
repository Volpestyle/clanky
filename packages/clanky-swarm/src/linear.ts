import type { SwarmCompleteInput, SwarmCompleteResult } from "./complete.ts";

export type TerminalSwarmTaskStatus = "done" | "failed" | "cancelled";

export interface TerminalSwarmTask {
	id: string;
	status: TerminalSwarmTaskStatus;
	title?: string;
	result?: unknown;
}

interface StructuredTaskResult {
	summary?: string;
	filesChanged: string[];
	tests: Array<{
		command?: string;
		status: string;
		notes?: string;
	}>;
	followups: string[];
}

type SwarmCompletionCommentInput = Pick<SwarmCompleteResult, "request">;

export function withLinearTrackerFallback(params: SwarmCompleteInput, hasLinearLink: boolean): SwarmCompleteInput {
	if (!hasLinearLink || params.trackerUpdate !== undefined || params.trackerUpdateSkipped !== undefined) return params;
	return {
		...params,
		trackerUpdateSkipped: {
			reason: "No tracker_update or tracker_update_skipped was provided for this Linear-linked swarm completion.",
		},
	};
}

export function formatSwarmCompletionComment(result: SwarmCompletionCommentInput): string {
	const lines = [`Swarm task ${result.request.taskId} ${result.request.status}.`, "", result.request.summary];
	if (result.request.filesChanged !== undefined && result.request.filesChanged.length > 0) {
		lines.push("", "Files:");
		for (const file of result.request.filesChanged) lines.push(`- ${file}`);
	}
	if (result.request.tests !== undefined && result.request.tests.length > 0) {
		lines.push("", "Verification:");
		for (const test of result.request.tests) {
			const command = test.command === undefined ? "" : ` ${test.command}`;
			const notes = test.notes === undefined ? "" : ` - ${test.notes}`;
			lines.push(`- ${test.status}${command}${notes}`);
		}
	}
	appendTrackerSection(lines, "Tracker update", result.request.trackerUpdate);
	appendTrackerSection(lines, "Tracker update skipped", result.request.trackerUpdateSkipped);
	if (result.request.followups !== undefined && result.request.followups.length > 0) {
		lines.push("", "Follow-ups:");
		for (const followup of result.request.followups) lines.push(`- ${followup}`);
	}
	return lines.join("\n");
}

export function formatSwarmActivityCompletionComment(task: TerminalSwarmTask): string {
	const structured = structuredTaskResult(task.result);
	const lines = [`Swarm task ${task.id} ${task.status}.`];
	if (structured?.summary !== undefined) {
		lines.push("", structured.summary);
	} else if (typeof task.result === "string" && task.result.trim().length > 0) {
		lines.push("", task.result.trim());
	} else if (task.title !== undefined) {
		lines.push("", task.title);
	}
	if (structured !== undefined && structured.filesChanged.length > 0) {
		lines.push("", "Files:");
		for (const file of structured.filesChanged) lines.push(`- ${file}`);
	}
	if (structured !== undefined && structured.tests.length > 0) {
		lines.push("", "Verification:");
		for (const test of structured.tests) {
			const command = test.command === undefined ? "" : ` ${test.command}`;
			const notes = test.notes === undefined ? "" : ` - ${test.notes}`;
			lines.push(`- ${test.status}${command}${notes}`);
		}
	}
	if (structured !== undefined && structured.followups.length > 0) {
		lines.push("", "Follow-ups:");
		for (const followup of structured.followups) lines.push(`- ${followup}`);
	}
	return lines.join("\n");
}

function appendTrackerSection(lines: string[], title: string, payload: unknown): void {
	if (payload === undefined) return;
	lines.push("", `${title}:`);
	const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, "\t");
	for (const line of text.split("\n")) lines.push(line);
}

function structuredTaskResult(value: unknown): StructuredTaskResult | undefined {
	const parsed = typeof value === "string" ? parseJson(value) : value;
	const record = recordOrUndefined(parsed);
	if (record === undefined) return undefined;
	const summary = stringProperty(record, "summary");
	const filesChanged = stringArrayProperty(record, "files_changed");
	const tests = testResults(record.tests);
	const followups = stringArrayProperty(record, "followups");
	if (summary === undefined && filesChanged.length === 0 && tests.length === 0 && followups.length === 0) {
		return undefined;
	}
	const result: StructuredTaskResult = { filesChanged, tests, followups };
	if (summary !== undefined) result.summary = summary;
	return result;
}

function testResults(value: unknown): StructuredTaskResult["tests"] {
	if (!Array.isArray(value)) return [];
	const results: StructuredTaskResult["tests"] = [];
	for (const item of value) {
		const record = recordOrUndefined(item);
		const status = stringProperty(record, "status");
		if (status === undefined) continue;
		const test: StructuredTaskResult["tests"][number] = { status };
		const command = stringProperty(record, "command");
		const notes = stringProperty(record, "notes");
		if (command !== undefined) test.command = command;
		if (notes !== undefined) test.notes = notes;
		results.push(test);
	}
	return results;
}

function stringArrayProperty(record: Record<string, unknown>, key: string): string[] {
	const value = record[key];
	if (!Array.isArray(value)) return [];
	return value.filter((item) => typeof item === "string");
}

function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function stringProperty(record: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = record?.[key];
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length === 0 ? undefined : trimmed;
}

function parseJson(value: string): unknown {
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return undefined;
	}
}
