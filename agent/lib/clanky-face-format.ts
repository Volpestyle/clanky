/**
 * Pure markdown/summary formatters and value helpers for the Clanky face.
 * No renderer state; operates only on stream events and plain values.
 * Extracted from clanky-face-renderer.ts.
 */
import type { InputRequest, InputResponse } from "eve/client";
import type {
	ActionRequest,
	ActionResult,
	ActionResultError,
	ActionResultStatus,
	AuthorizationCompletedEvent,
	AuthorizationRequiredEvent,
	FailureEvent,
	StepUsage,
	SubagentCalledEvent,
	TurnStats,
} from "./clanky-face-events.ts";

const MAX_CODE_BLOCK_LINE_CHARS = 72;
const JSON_BLOCK_MAX_CHARS = 4_000;

export function createEmptyTurnStats(): TurnStats {
	return {
		assistantTextChars: 0,
		reasoningTextChars: 0,
		sawAssistantText: false,
		sawInputRequest: false,
		stepFinishes: 0,
		stepStarts: 0,
		toolCalls: [],
		toolResults: [],
	};
}

export function formatTurnStats(stats: TurnStats): string {
	const parts = [
		`steps ${stats.stepStarts}/${stats.stepFinishes}`,
		`assistant ${stats.assistantTextChars} chars`,
		`reasoning ${stats.reasoningTextChars} chars`,
		`tool-calls ${stats.toolCalls.length === 0 ? "none" : summarizeNames(stats.toolCalls)}`,
		`tool-results ${stats.toolResults.length === 0 ? "none" : summarizeNames(stats.toolResults)}`,
		`input-requests ${stats.sawInputRequest ? "yes" : "no"}`,
	];
	return `Trace: ${parts.join("; ")}.`;
}

export function formatActionRequestBlock(action: ActionRequest, title = `Tool: ${actionRequestName(action)} - running`): string {
	const summary = summarizeToolArgs(action.input);
	return [
		`**${title}**`,
		"",
		summary.length === 0 ? `call ${action.callId}` : summary,
		"",
		`call: ${action.callId}`,
		"input:",
		"```json",
		formatJsonBlock(action.input),
		"```",
	].join("\n");
}

export function formatActionResultBlock(
	result: ActionResult,
	status: ActionResultStatus,
	error: ActionResultError,
	title = `Tool: ${actionResultName(result)} - ${actionOutcome(result, status)}`,
	input?: unknown,
): string {
	const outcome = actionOutcome(result, status);
	const detail = error === undefined ? summarizeToolResult(result.output) : `${error.code}: ${error.message}`;
	const lines = [
		`**${title}**`,
		"",
		`${outcome === "completed" ? "->" : "!"} ${detail}`,
		"",
		`call: ${result.callId}`,
		`status: ${status}`,
	];
	if (input !== undefined) {
		lines.push("", "input:", "```json", formatJsonBlock(input), "```");
	}
	if (error !== undefined) {
		lines.push("", "error:", "```json", formatJsonBlock(error), "```");
	}
	lines.push("", "output:", "```json", formatJsonBlock(result.output), "```");
	return lines.join("\n");
}

export function formatInputRequestBlock(request: InputRequest, title?: string): string {
	const resolvedTitle = title ?? (isApprovalRequest(request) ? `Tool: ${request.action.toolName} - approval requested` : "Input requested");
	return [`**${resolvedTitle}**`, "", formatInputRequestBody(request)].join("\n");
}

export function formatInputResponseBlock(request: InputRequest, response: InputResponse, approvalTitlePrefix?: string): string {
	if (isApprovalRequest(request)) {
		const status = inputResponseIsDenial(response) ? "rejected" : "approved";
		const titlePrefix = approvalTitlePrefix ?? `Tool: ${request.action.toolName}`;
		return [`**${titlePrefix} - ${status}**`, "", `${formatInputRequestBody(request)}\n\nanswer: ${formatInputResponseValue(response)}`].join("\n");
	}
	return [`**Input answered**`, "", `${formatInputRequestBody(request)}\n\nanswer: ${formatInputResponseValue(response)}`].join("\n");
}

export function formatOrphanInputResponseBlock(response: InputResponse): string {
	return [`**Input answered**`, "", `${response.requestId}: ${formatInputResponseValue(response)}`].join("\n");
}

export function formatInputRequestBody(request: InputRequest): string {
	const optionsText =
		request.options
			?.map((option) => {
				const description = option.description === undefined ? "" : ` - ${option.description}`;
				const style = option.style === undefined ? "" : ` (${option.style})`;
				return `  - ${option.id}: ${option.label}${style}${description}`;
			})
			.join("\n") ?? "  - freeform";
	const freeform = request.allowFreeform === true ? "\n  - freeform allowed" : "";
	return [`- ${request.display ?? "text"} request ${request.requestId}`, `  ${request.prompt}`, `${optionsText}${freeform}`].join("\n");
}

export function formatInputResponseValue(response: InputResponse): string {
	return response.optionId ?? response.text ?? "(empty)";
}

export function inputResponseIsDenial(response: InputResponse): boolean {
	const value = `${response.optionId ?? ""} ${response.text ?? ""}`;
	return /\b(deny|denied|reject|rejected|no|stop)\b/iu.test(value);
}

export function isApprovalRequest(request: InputRequest): boolean {
	return request.display === "confirmation";
}

export function formatSubagentBlock(name: string, status: "completed" | "failed" | "running", body: string): string {
	const cleanBody = body.trim().length === 0 ? "no output" : body.trim();
	return [`**Subagent: ${name} - ${status}**`, "", cleanBody].join("\n");
}

export function formatSubagentCalledBody(event: SubagentCalledEvent): string {
	const lines = [`tool: ${event.data.toolName}`, `child session: ${event.data.childSessionId}`];
	if (event.data.remote?.url !== undefined) lines.push(`remote: ${event.data.remote.url}`);
	return lines.join("\n");
}

export function subagentActionKey(parentCallId: string, actionCallId: string): string {
	return `subagent:${parentCallId}:tool:${actionCallId}`;
}

export function subagentStreamKey(parentCallId: string, kind: "message" | "reasoning", turnId: string, stepIndex: number): string {
	return `subagent:${parentCallId}:${kind}:${turnId}:${stepIndex}`;
}

export function actionOutcome(result: ActionResult, status: ActionResultStatus): string {
	if (status === "rejected") return "rejected";
	if (status === "failed" || result.isError === true) return "failed";
	return "completed";
}

export function summarizeToolArgs(input: unknown): string {
	if (!isRecord(input)) return summarizeJsonValue(input);
	const entries = Object.entries(input);
	if (entries.length === 0) return "";
	return truncateInline(entries
		.slice(0, 4)
		.map(([key, value]) => `${key}=${summarizeJsonValue(value)}`)
		.join("  "), 68);
}

export function summarizeToolResult(output: unknown): string {
	if (isRecord(output)) {
		for (const key of ["stdout", "text", "message", "result", "error", "stderr"]) {
			const value = output[key];
			if (typeof value === "string" && value.trim().length > 0) return truncateInline(value.trim().replace(/\s+/gu, " "), 68);
		}
		const keys = Object.keys(output);
		return keys.length === 0 ? "{}" : `{${keys.slice(0, 5).join(", ")}}`;
	}
	return summarizeJsonValue(output);
}

export function summarizeJsonValue(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "string") return JSON.stringify(truncateInline(value.replace(/\s+/gu, " "), 64));
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) return `[${value.length}]`;
	if (isRecord(value)) {
		const keys = Object.keys(value);
		return keys.length === 0 ? "{}" : `{${keys.slice(0, 4).join(", ")}}`;
	}
	return String(value);
}

export function truncateInline(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function formatJsonBlock(value: unknown, maxChars = JSON_BLOCK_MAX_CHARS): string {
	const json = JSON.stringify(value, null, 2) ?? String(value);
	return truncateLongCodeLines(truncate(json, maxChars), MAX_CODE_BLOCK_LINE_CHARS);
}

export function actionRequestName(action: ActionRequest): string {
	switch (action.kind) {
		case "tool-call":
			if (action.toolName === "load_skill") return loadSkillNameFromInput(action.input) ?? action.toolName;
			return action.toolName;
		case "subagent-call":
			return action.subagentName;
		case "remote-agent-call":
			return action.remoteAgentName;
		case "load-skill":
			return loadSkillNameFromInput(action.input) ?? "load_skill";
	}
}

export function actionResultName(result: ActionResult): string {
	switch (result.kind) {
		case "tool-result":
			return result.toolName;
		case "subagent-result":
			return result.subagentName;
		case "load-skill-result":
			return result.name ?? "load_skill";
	}
}

export function loadSkillNameFromInput(input: unknown): string | undefined {
	if (!isRecord(input)) return undefined;
	const skill = input.skill;
	return typeof skill === "string" && skill.trim().length > 0 ? skill.trim() : undefined;
}

export function isSkillLoadRequest(action: ActionRequest): boolean {
	return action.kind === "load-skill" || (action.kind === "tool-call" && action.toolName === "load_skill");
}

export function isSkillLoadResult(result: ActionResult): boolean {
	return result.kind === "load-skill-result" || (result.kind === "tool-result" && result.toolName === "load_skill");
}

export function mergeUsage(current: StepUsage | undefined, next: StepUsage | undefined): StepUsage | undefined {
	if (next === undefined) return current;
	return {
		cacheReadTokens: (current?.cacheReadTokens ?? 0) + (next.cacheReadTokens ?? 0),
		cacheWriteTokens: (current?.cacheWriteTokens ?? 0) + (next.cacheWriteTokens ?? 0),
		inputTokens: next.inputTokens ?? current?.inputTokens ?? 0,
		outputTokens: (current?.outputTokens ?? 0) + (next.outputTokens ?? 0),
	};
}

export function formatAuthorizationChallenge(event: AuthorizationRequiredEvent): string {
	const challenge = event.data.authorization;
	const displayName = challenge?.displayName ?? event.data.name;
	const lines = [`${displayName}: ${event.data.description}`];
	if (challenge?.url !== undefined) lines.push(`url: ${challenge.url}`);
	if (challenge?.userCode !== undefined) lines.push(`code: ${challenge.userCode}`);
	if (challenge?.expiresAt !== undefined) lines.push(`expires: ${challenge.expiresAt}`);
	if (challenge?.instructions !== undefined) lines.push(challenge.instructions);
	return lines.join("\n");
}

export function formatAuthorizationCompletion(event: AuthorizationCompletedEvent): string {
	const displayName = event.data.authorization?.displayName ?? event.data.name;
	const reason = event.data.reason === undefined ? "" : `\nreason: ${event.data.reason}`;
	return `${displayName}${reason}`;
}

export function failureBlockKey(event: FailureEvent): string {
	return `${event.type}:${event.data.code}:${event.data.message}`;
}

export function failureTitle(event: FailureEvent): string {
	switch (event.type) {
		case "session.failed":
			return "Session failed";
		case "step.failed":
			return "Step failed";
		case "turn.failed":
			return "Turn failed";
	}
}

export function formatFailureEvent(event: FailureEvent): string {
	const detail = failureDetail(event);
	return detail === undefined ? `${event.data.code}: ${event.data.message}` : `${event.data.code}: ${event.data.message}\n${detail}`;
}

export function failureDetail(event: FailureEvent): string | undefined {
	const details = event.data.details;
	if (!isRecord(details)) return undefined;
	const detail = details.detail;
	return typeof detail === "string" && detail.trim().length > 0 ? detail : undefined;
}

export function summarizeNames(names: readonly string[]): string {
	const counts = new Map<string, number>();
	for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
	return [...counts.entries()].map(([name, count]) => (count === 1 ? name : `${name} x${count}`)).join(", ");
}

export function formatCompactAmount(value: number): string {
	return value >= 10 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/u, "");
}

export function truncate(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n... truncated ${text.length - maxChars} chars`;
}

export function truncateLongCodeLines(text: string, maxLineChars: number): string {
	return text
		.split("\n")
		.map((line) => {
			if (line.length <= maxLineChars) return line;
			return `${line.slice(0, Math.max(0, maxLineChars - 3))}...`;
		})
		.join("\n");
}

export function sanitizeTerminalText(text: string): string {
	return text
		.replace(/\r\n?/gu, "\n")
		.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\x1B\\))/gu, "")
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "");
}
