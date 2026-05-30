import {
	clampInteger,
	isRecord,
	type JsonRecord,
	type MainAgentActivityToolInput,
	type MainAgentCancelToolInput,
	stringValue,
	truncateText,
} from "@clanky/core";
import type { AgentSession, AgentSessionEvent, AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import type { RuntimeTurnQueue } from "./runtimeTurnQueue.ts";

type MainRuntimeToolStatus = "running" | "done" | "error";

interface MainRuntimeToolActivity {
	toolCallId: string;
	toolName: string;
	status: MainRuntimeToolStatus;
	startedAt: string;
	finishedAt?: string;
	isError?: boolean;
	argsPreview?: string;
	resultPreview?: string;
}

interface MainRuntimeAssistantText {
	text: string;
	at?: string;
	stopReason?: string;
}

const DEFAULT_ACTIVITY_LIMIT = 5;
const MAX_ACTIVITY_LIMIT = 20;

export class MainAgentActivityMonitor {
	private session: AgentSession | undefined;
	private unsubscribe: (() => void) | undefined;
	private lastEventAt: string | undefined;
	private lastTurnStartedAt: string | undefined;
	private lastTurnFinishedAt: string | undefined;
	private readonly activeTools = new Map<string, MainRuntimeToolActivity>();
	private readonly recentTools: MainRuntimeToolActivity[] = [];
	private readonly recentAssistantTexts: MainRuntimeAssistantText[] = [];

	bind(runtime: AgentSessionRuntime | undefined): void {
		if (runtime === undefined) {
			this.dispose();
			return;
		}
		const session = runtime.session;
		if (this.session === session) return;
		this.dispose();
		this.session = session;
		this.unsubscribe = session.subscribe((event) => {
			this.recordEvent(event);
		});
	}

	dispose(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.session = undefined;
		this.lastEventAt = undefined;
		this.lastTurnStartedAt = undefined;
		this.lastTurnFinishedAt = undefined;
		this.activeTools.clear();
		this.recentTools.length = 0;
		this.recentAssistantTexts.length = 0;
	}

	read(runtime: AgentSessionRuntime, queue: RuntimeTurnQueue, input: MainAgentActivityToolInput): JsonRecord {
		this.bind(runtime);
		const limit = clampInteger(input.limit, DEFAULT_ACTIVITY_LIMIT, 1, MAX_ACTIVITY_LIMIT);
		const session = runtime.session;
		const activeTools = this.activeToolsForOutput();
		const recentAssistantMessages = this.readRecentAssistantMessages(session.messages, limit);
		return {
			available: true,
			state: queue.isBusy() || session.isStreaming === true ? "busy" : "idle",
			queueBusy: queue.isBusy(),
			sessionStreaming: session.isStreaming === true,
			pendingMessageCount: session.pendingMessageCount,
			sessionId: session.sessionId,
			sessionFile: session.sessionFile,
			cwd: runtime.cwd,
			activeToolName: activeTools[0]?.toolName,
			activeTools,
			recentTools: this.recentTools.slice(0, limit).map((activity) => toolActivityOutput(activity)),
			recentAssistantMessages,
			lastAssistantText: recentAssistantMessages[0]?.text,
			lastEventAt: this.lastEventAt,
			lastTurnStartedAt: this.lastTurnStartedAt,
			lastTurnFinishedAt: this.lastTurnFinishedAt,
		};
	}

	private recordEvent(event: AgentSessionEvent): void {
		const now = new Date().toISOString();
		this.lastEventAt = now;
		if (event.type === "turn_start") {
			this.lastTurnStartedAt = timestampToIso(readRecordNumber(event, "timestamp")) ?? now;
			this.lastTurnFinishedAt = undefined;
			return;
		}
		if (event.type === "turn_end") {
			this.lastTurnFinishedAt = now;
			return;
		}
		if (event.type === "message_end") {
			const text = assistantMessageText(event.message);
			if (text !== undefined) {
				this.rememberAssistantText({
					text,
					at: timestampToIso(readRecordNumber(event.message, "timestamp")) ?? now,
					stopReason: stringValue(isRecord(event.message) ? event.message.stopReason : undefined),
				});
			}
			return;
		}
		if (event.type === "tool_execution_start") {
			const activity: MainRuntimeToolActivity = {
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				status: "running",
				startedAt: now,
				argsPreview: previewJson(event.args, 300),
			};
			this.activeTools.set(event.toolCallId, activity);
			this.recentTools.unshift(activity);
			this.pruneRecentTools();
			return;
		}
		if (event.type === "tool_execution_end") {
			const activity = this.activeTools.get(event.toolCallId) ?? {
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				status: "running" as const,
				startedAt: now,
			};
			activity.status = event.isError ? "error" : "done";
			activity.finishedAt = now;
			activity.isError = event.isError;
			activity.resultPreview = previewJson(event.result, 300);
			this.activeTools.delete(event.toolCallId);
			if (!this.recentTools.some((recent) => recent.toolCallId === event.toolCallId)) {
				this.recentTools.unshift(activity);
				this.pruneRecentTools();
			}
		}
	}

	private rememberAssistantText(message: MainRuntimeAssistantText): void {
		const existing = this.recentAssistantTexts[0];
		if (existing?.text === message.text && existing.stopReason === message.stopReason) return;
		this.recentAssistantTexts.unshift({
			text: truncateText(message.text, 1_500),
			...(message.at === undefined ? {} : { at: message.at }),
			...(message.stopReason === undefined || message.stopReason.length === 0
				? {}
				: { stopReason: message.stopReason }),
		});
		while (this.recentAssistantTexts.length > MAX_ACTIVITY_LIMIT) this.recentAssistantTexts.pop();
	}

	private readRecentAssistantMessages(sessionMessages: readonly unknown[], limit: number): MainRuntimeAssistantText[] {
		const messages: MainRuntimeAssistantText[] = [];
		const seen = new Set<string>();
		for (let index = sessionMessages.length - 1; index >= 0 && messages.length < limit; index -= 1) {
			const message = sessionMessages[index];
			if (!isRecord(message) || stringValue(message.role) !== "assistant") continue;
			const text = assistantMessageText(message);
			if (text === undefined) continue;
			const at = timestampToIso(readRecordNumber(message, "timestamp"));
			const stopReason = stringValue(message.stopReason);
			const entry: MainRuntimeAssistantText = {
				text: truncateText(text, 1_500),
				...(at === undefined ? {} : { at }),
				...(stopReason.length === 0 ? {} : { stopReason }),
			};
			const key = `${entry.at ?? ""}:${entry.stopReason ?? ""}:${entry.text}`;
			if (seen.has(key)) continue;
			seen.add(key);
			messages.push(entry);
		}
		for (const cached of this.recentAssistantTexts) {
			if (messages.length >= limit) break;
			const key = `${cached.at ?? ""}:${cached.stopReason ?? ""}:${cached.text}`;
			if (seen.has(key)) continue;
			seen.add(key);
			messages.push(cached);
		}
		return messages;
	}

	private activeToolsForOutput(): JsonRecord[] {
		return Array.from(this.activeTools.values()).map((activity) => toolActivityOutput(activity));
	}

	private pruneRecentTools(): void {
		while (this.recentTools.length > MAX_ACTIVITY_LIMIT) this.recentTools.pop();
	}
}

export function readMainAgentActivity(
	runtime: AgentSessionRuntime | undefined,
	queue: RuntimeTurnQueue,
	input: MainAgentActivityToolInput,
	monitor: MainAgentActivityMonitor,
): JsonRecord {
	if (runtime === undefined) {
		monitor.bind(undefined);
		return {
			available: false,
			reason: "main Clanky runtime is not bound",
		};
	}
	return monitor.read(runtime, queue, input);
}

export async function cancelMainAgent(
	runtime: AgentSessionRuntime | undefined,
	queue: RuntimeTurnQueue,
	input: MainAgentCancelToolInput,
): Promise<JsonRecord> {
	if (runtime === undefined) {
		return {
			available: false,
			ok: false,
			cancelled: false,
			reason: "main Clanky runtime is not bound",
		};
	}
	const rawReason = stringValue(input.reason).trim();
	const reason = rawReason.length === 0 ? "cancel requested by Clanky subagent" : truncateText(rawReason, 200);
	const queueResult = queue.cancelPending(reason);
	const session = runtime.session;
	const before = {
		sessionId: session.sessionId,
		sessionStreaming: session.isStreaming === true,
		pendingMessageCount: session.pendingMessageCount,
	};
	const cleared = session.clearQueue();
	let aborted = false;
	let error: string | undefined;
	if (session.isStreaming === true) {
		try {
			await session.abort();
			aborted = true;
		} catch (abortError) {
			error = errorMessage(abortError);
		}
	}
	const after = {
		sessionId: session.sessionId,
		sessionStreaming: session.isStreaming === true,
		pendingMessageCount: session.pendingMessageCount,
	};
	const result: JsonRecord = {
		available: true,
		ok: error === undefined,
		cancelled: error === undefined,
		reason,
		aborted,
		before,
		after,
		queue: queueResult,
		clearedSteeringMessages: cleared.steering.length,
		clearedFollowUpMessages: cleared.followUp.length,
	};
	if (error !== undefined) result.error = error;
	return result;
}

export function assistantMessageText(message: unknown): string | undefined {
	if (!isRecord(message)) return undefined;
	if (stringValue(message.role) !== "assistant") return undefined;
	const content = Array.isArray(message.content) ? message.content : [];
	const text = content
		.filter(isRecord)
		.filter((part) => stringValue(part.type) === "text")
		.map((part) => stringValue(part.text))
		.join("\n")
		.trim();
	return text.length > 0 ? text : undefined;
}

function toolActivityOutput(activity: MainRuntimeToolActivity): JsonRecord {
	const output: JsonRecord = {
		toolCallId: activity.toolCallId,
		toolName: activity.toolName,
		status: activity.status,
		startedAt: activity.startedAt,
	};
	if (activity.finishedAt !== undefined) output.finishedAt = activity.finishedAt;
	if (activity.isError !== undefined) output.isError = activity.isError;
	if (activity.argsPreview !== undefined) output.argsPreview = activity.argsPreview;
	if (activity.resultPreview !== undefined) output.resultPreview = activity.resultPreview;
	return output;
}

function previewJson(value: unknown, maxChars: number): string {
	try {
		return truncateText(JSON.stringify(value) ?? "undefined", maxChars);
	} catch {
		return "[unserializable]";
	}
}

function timestampToIso(timestamp: number | undefined): string | undefined {
	if (timestamp === undefined || !Number.isFinite(timestamp)) return undefined;
	return new Date(timestamp).toISOString();
}

function readRecordNumber(record: unknown, key: string): number | undefined {
	if (!isRecord(record)) return undefined;
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? (error.stack ?? error.message) : String(error);
}
