import type { AgentTUIStreamEvent, AgentTUIStreamResult } from "../../node_modules/eve/dist/src/cli/dev/tui/runner.js";

export const NO_ASSISTANT_REPLY_NOTICE = "No assistant reply was produced for that turn.";

export interface NoReplyMonitor {
	events: AgentTUIStreamResult["events"];
	shouldRenderNotice(): boolean;
	formatNoReplyNotice(): string;
	formatTraceNotice(): string;
}

export function monitorNoReplyEvents(events: AgentTUIStreamResult["events"]): NoReplyMonitor {
	const state = {
		assistantCompleteEvents: 0,
		assistantTextChars: 0,
		emptyAssistantCompleteEvents: 0,
		errorTexts: [] as string[],
		reasoningCompleteEvents: 0,
		reasoningTextChars: 0,
		sawAssistantText: false,
		sawError: false,
		sawFinish: false,
		stepFinishes: 0,
		stepStarts: 0,
		toolApprovalRequests: 0,
		toolCalls: [] as string[],
		toolErrors: [] as string[],
		toolResults: 0,
		usage: undefined as AgentTUIStreamEventUsage | undefined,
	};

	return {
		events: observeEvents(events, (event) => {
			switch (event.type) {
				case "step-start":
					state.stepStarts += 1;
					break;
				case "step-finish":
					state.stepFinishes += 1;
					state.usage = event.usage ?? state.usage;
					break;
				case "assistant-delta":
					state.assistantTextChars += event.delta.length;
					if (event.delta.trim().length > 0) state.sawAssistantText = true;
					break;
				case "assistant-complete":
					state.assistantCompleteEvents += 1;
					if ((event.text ?? "").trim().length > 0) {
						state.assistantTextChars += event.text?.length ?? 0;
						state.sawAssistantText = true;
					} else {
						state.emptyAssistantCompleteEvents += 1;
					}
					break;
				case "reasoning-delta":
					state.reasoningTextChars += event.delta.length;
					break;
				case "reasoning-complete":
					state.reasoningCompleteEvents += 1;
					break;
				case "tool-call":
					state.toolCalls.push(event.toolName);
					break;
				case "tool-approval-request":
					state.toolApprovalRequests += 1;
					break;
				case "tool-result":
					state.toolResults += 1;
					break;
				case "tool-error":
					state.toolErrors.push(event.errorText);
					break;
				case "error":
					state.errorTexts.push(event.errorText);
					state.sawError = true;
					break;
				case "finish":
					state.sawFinish = true;
					state.usage = event.usage ?? state.usage;
					break;
			}
		}),
		shouldRenderNotice: () => state.sawFinish && !state.sawError && !state.sawAssistantText,
		formatNoReplyNotice: () => `${NO_ASSISTANT_REPLY_NOTICE}\n${formatTraceSummary(state)}`,
		formatTraceNotice: () => `Turn trace: ${formatTraceSummary(state)}`,
	};
}

type AgentTUIStreamEventUsage = Extract<AgentTUIStreamEvent, { type: "finish" }>["usage"];

function formatTraceSummary(state: {
	assistantCompleteEvents: number;
	assistantTextChars: number;
	emptyAssistantCompleteEvents: number;
	errorTexts: readonly string[];
	reasoningCompleteEvents: number;
	reasoningTextChars: number;
	sawFinish: boolean;
	stepFinishes: number;
	stepStarts: number;
	toolApprovalRequests: number;
	toolCalls: readonly string[];
	toolErrors: readonly string[];
	toolResults: number;
	usage: AgentTUIStreamEventUsage;
}): string {
	const parts = [
		`steps ${state.stepStarts}/${state.stepFinishes}`,
		`assistant ${state.assistantTextChars} chars`,
		`assistant-complete ${state.assistantCompleteEvents} (${state.emptyAssistantCompleteEvents} empty)`,
	];
	if (state.reasoningTextChars > 0 || state.reasoningCompleteEvents > 0) {
		parts.push(`reasoning ${state.reasoningTextChars} chars/${state.reasoningCompleteEvents} complete`);
	}
	if (state.toolCalls.length > 0) parts.push(`tool-calls ${summarizeNames(state.toolCalls)}`);
	if (state.toolResults > 0 || state.toolErrors.length > 0 || state.toolApprovalRequests > 0) {
		parts.push(`tool-results ${state.toolResults}, tool-errors ${state.toolErrors.length}, approvals ${state.toolApprovalRequests}`);
	}
	if (state.usage !== undefined) {
		parts.push(`usage input ${state.usage.inputTokens ?? 0}, output ${state.usage.outputTokens ?? 0}`);
	}
	if (state.errorTexts.length > 0) parts.push(`errors ${state.errorTexts.length}`);
	parts.push(state.sawFinish ? "finished" : "unfinished");
	return `Trace: ${parts.join("; ")}.`;
}

function summarizeNames(names: readonly string[]): string {
	const counts = new Map<string, number>();
	for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
	return [...counts.entries()].map(([name, count]) => (count === 1 ? name : `${name} x${count}`)).join(", ");
}

async function* observeEvents(
	events: AgentTUIStreamResult["events"],
	observe: (event: AgentTUIStreamEvent) => void,
): AsyncGenerator<AgentTUIStreamEvent> {
	if (events instanceof ReadableStream) {
		const reader = events.getReader();
		try {
			for (;;) {
				const next = await reader.read();
				if (next.done) return;
				observe(next.value);
				yield next.value;
			}
		} finally {
			reader.releaseLock();
		}
		return;
	}

	for await (const event of events) {
		observe(event);
		yield event;
	}
}
