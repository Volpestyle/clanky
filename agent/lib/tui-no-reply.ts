import type { AgentTUIStreamEvent, AgentTUIStreamResult } from "../../node_modules/eve/dist/src/cli/dev/tui/runner.js";

export const NO_ASSISTANT_REPLY_NOTICE = "No assistant reply was produced for that turn.";

export interface NoReplyMonitor {
	events: AgentTUIStreamResult["events"];
	shouldRenderNotice(): boolean;
}

export function monitorNoReplyEvents(events: AgentTUIStreamResult["events"]): NoReplyMonitor {
	const state = {
		sawAssistantText: false,
		sawError: false,
		sawFinish: false,
	};

	return {
		events: observeEvents(events, (event) => {
			switch (event.type) {
				case "assistant-delta":
					if (event.delta.trim().length > 0) state.sawAssistantText = true;
					break;
				case "assistant-complete":
					if ((event.text ?? "").trim().length > 0) state.sawAssistantText = true;
					break;
				case "error":
					state.sawError = true;
					break;
				case "finish":
					state.sawFinish = true;
					break;
			}
		}),
		shouldRenderNotice: () => state.sawFinish && !state.sawError && !state.sawAssistantText,
	};
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
