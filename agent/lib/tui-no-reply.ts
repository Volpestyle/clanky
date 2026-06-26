import type { ActionResultStreamEvent, HandleMessageStreamEvent, StepCompletedStreamEvent } from "eve/client";

export const NO_ASSISTANT_REPLY_NOTICE = "No assistant reply was produced for that turn.";

export interface NoReplyMonitor {
	events: AsyncIterable<HandleMessageStreamEvent>;
	shouldRenderNotice(): boolean;
	formatNoReplyNotice(): string;
	formatTraceNotice(): string;
}

type StreamUsage = StepCompletedStreamEvent["data"]["usage"];

interface NoReplyState {
	assistantCompleteEvents: number;
	assistantTextByKey: Map<string, string>;
	emptyAssistantCompleteEvents: number;
	errorTexts: string[];
	inputRequests: number;
	reasoningCompleteEvents: number;
	reasoningTextByKey: Map<string, string>;
	sawError: boolean;
	sawFinish: boolean;
	stepFinishes: number;
	stepStarts: number;
	toolApprovalRequests: number;
	toolCalls: string[];
	toolErrors: string[];
	toolResults: number;
	usage: StreamUsage | undefined;
}

export class NoReplyTracker {
	private readonly state = createNoReplyState();

	observe(event: HandleMessageStreamEvent): void {
		observeNoReplyEvent(this.state, event);
	}

	shouldRenderNotice(): boolean {
		return this.state.sawFinish && !this.state.sawError && !sawAssistantText(this.state);
	}

	formatNoReplyNotice(): string {
		return `${NO_ASSISTANT_REPLY_NOTICE}\n${formatTraceSummary(this.state)}`;
	}

	formatTraceNotice(): string {
		return `Turn trace: ${formatTraceSummary(this.state)}`;
	}
}

export function monitorNoReplyEvents(events: AsyncIterable<HandleMessageStreamEvent>): NoReplyMonitor {
	const tracker = new NoReplyTracker();

	return {
		events: observeEvents(events, (event) => tracker.observe(event)),
		shouldRenderNotice: () => tracker.shouldRenderNotice(),
		formatNoReplyNotice: () => tracker.formatNoReplyNotice(),
		formatTraceNotice: () => tracker.formatTraceNotice(),
	};
}

function createNoReplyState(): NoReplyState {
	return {
		assistantCompleteEvents: 0,
		assistantTextByKey: new Map(),
		emptyAssistantCompleteEvents: 0,
		errorTexts: [],
		inputRequests: 0,
		reasoningCompleteEvents: 0,
		reasoningTextByKey: new Map(),
		sawError: false,
		sawFinish: false,
		stepFinishes: 0,
		stepStarts: 0,
		toolApprovalRequests: 0,
		toolCalls: [],
		toolErrors: [],
		toolResults: 0,
		usage: undefined,
	};
}

function observeNoReplyEvent(state: NoReplyState, event: HandleMessageStreamEvent): void {
	switch (event.type) {
		case "step.started":
			state.stepStarts += 1;
			break;
		case "step.completed":
			state.stepFinishes += 1;
			state.usage = event.data.usage ?? state.usage;
			break;
		case "message.appended":
			state.assistantTextByKey.set(streamTextKey(event.data.turnId, event.data.stepIndex), event.data.messageSoFar);
			break;
		case "message.completed":
			state.assistantCompleteEvents += 1;
			if ((event.data.message ?? "").trim().length > 0) {
				state.assistantTextByKey.set(streamTextKey(event.data.turnId, event.data.stepIndex), event.data.message ?? "");
			} else {
				state.emptyAssistantCompleteEvents += 1;
			}
			break;
		case "reasoning.appended":
			state.reasoningTextByKey.set(streamTextKey(event.data.turnId, event.data.stepIndex), event.data.reasoningSoFar);
			break;
		case "reasoning.completed":
			state.reasoningCompleteEvents += 1;
			state.reasoningTextByKey.set(streamTextKey(event.data.turnId, event.data.stepIndex), event.data.reasoning);
			break;
		case "actions.requested":
			for (const action of event.data.actions) {
				if (action.kind === "tool-call") state.toolCalls.push(action.toolName);
				else state.toolCalls.push(action.kind);
			}
			break;
		case "input.requested":
			state.inputRequests += event.data.requests.length;
			for (const request of event.data.requests) {
				if (request.display === "confirmation") state.toolApprovalRequests += 1;
			}
			break;
		case "action.result":
			state.toolResults += 1;
			if (event.data.status === "failed" || event.data.result.isError === true) {
				state.toolErrors.push(event.data.error?.message ?? formatActionName(event.data.result));
			}
			break;
		case "step.failed":
		case "turn.failed":
		case "session.failed":
			state.errorTexts.push(event.data.message);
			state.sawError = true;
			state.sawFinish = true;
			break;
		case "turn.completed":
		case "session.completed":
		case "session.waiting":
			state.sawFinish = true;
			break;
	}
}

export function formatTraceSummary(state: {
	assistantCompleteEvents: number;
	assistantTextByKey: ReadonlyMap<string, string>;
	emptyAssistantCompleteEvents: number;
	errorTexts: readonly string[];
	inputRequests: number;
	reasoningCompleteEvents: number;
	reasoningTextByKey: ReadonlyMap<string, string>;
	sawFinish: boolean;
	stepFinishes: number;
	stepStarts: number;
	toolApprovalRequests: number;
	toolCalls: readonly string[];
	toolErrors: readonly string[];
	toolResults: number;
	usage: StreamUsage | undefined;
}): string {
	const assistantTextChars = totalTextChars(state.assistantTextByKey);
	const reasoningTextChars = totalTextChars(state.reasoningTextByKey);
	const parts = [
		`steps ${state.stepStarts}/${state.stepFinishes}`,
		`assistant ${assistantTextChars} chars`,
		`assistant-complete ${state.assistantCompleteEvents} (${state.emptyAssistantCompleteEvents} empty)`,
	];
	if (reasoningTextChars > 0 || state.reasoningCompleteEvents > 0) {
		parts.push(`reasoning ${reasoningTextChars} chars/${state.reasoningCompleteEvents} complete`);
	}
	if (state.toolCalls.length > 0) parts.push(`tool-calls ${summarizeNames(state.toolCalls)}`);
	if (state.toolResults > 0 || state.toolErrors.length > 0 || state.toolApprovalRequests > 0 || state.inputRequests > 0) {
		parts.push(
			`tool-results ${state.toolResults}, tool-errors ${state.toolErrors.length}, approvals ${state.toolApprovalRequests}, input-requests ${state.inputRequests}`,
		);
	}
	if (state.usage !== undefined) {
		parts.push(`usage input ${state.usage.inputTokens ?? 0}, output ${state.usage.outputTokens ?? 0}`);
	}
	if (state.errorTexts.length > 0) parts.push(`errors ${state.errorTexts.length}`);
	parts.push(state.sawFinish ? "finished" : "unfinished");
	return `Trace: ${parts.join("; ")}.`;
}

function streamTextKey(turnId: string, stepIndex: number): string {
	return `${turnId}:${stepIndex}`;
}

function sawAssistantText(state: NoReplyState): boolean {
	for (const text of state.assistantTextByKey.values()) {
		if (text.trim().length > 0) return true;
	}
	return false;
}

function totalTextChars(values: ReadonlyMap<string, string>): number {
	let total = 0;
	for (const text of values.values()) total += text.length;
	return total;
}

function summarizeNames(names: readonly string[]): string {
	const counts = new Map<string, number>();
	for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
	return [...counts.entries()].map(([name, count]) => (count === 1 ? name : `${name} x${count}`)).join(", ");
}

function formatActionName(result: ActionResultStreamEvent["data"]["result"]): string {
	if (result.kind === "tool-result") return result.toolName;
	if (result.kind === "subagent-result") return result.subagentName;
	return result.name ?? "load-skill";
}

async function* observeEvents(
	events: AsyncIterable<HandleMessageStreamEvent>,
	observe: (event: HandleMessageStreamEvent) => void,
): AsyncGenerator<HandleMessageStreamEvent> {
	for await (const event of events) {
		observe(event);
		yield event;
	}
}
