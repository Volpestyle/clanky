import type { AgentTUIStreamEvent } from "../node_modules/eve/dist/src/cli/dev/tui/runner.js";
import { monitorNoReplyEvents } from "../agent/lib/tui-no-reply.ts";

function assert(condition: boolean, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

async function* stream(events: readonly AgentTUIStreamEvent[]): AsyncGenerator<AgentTUIStreamEvent> {
	for (const event of events) yield event;
}

async function drain(events: AsyncIterable<AgentTUIStreamEvent> | ReadableStream<AgentTUIStreamEvent>): Promise<void> {
	if (events instanceof ReadableStream) {
		const reader = events.getReader();
		try {
			for (;;) {
				const next = await reader.read();
				if (next.done) return;
			}
		} finally {
			reader.releaseLock();
		}
		return;
	}

	for await (const _event of events) {
		// Drain the stream so the monitor sees every event.
	}
}

const emptyReply = monitorNoReplyEvents(
	stream([
		{ type: "step-start" },
		{ type: "step-finish", usage: { inputTokens: 9400, outputTokens: 131 } },
		{ type: "finish", usage: { inputTokens: 9400, outputTokens: 131 } },
	]),
);
await drain(emptyReply.events);
assert(emptyReply.shouldRenderNotice(), "completed empty assistant turn should render a no-reply notice");

const textReply = monitorNoReplyEvents(
	stream([
		{ type: "step-start" },
		{ type: "assistant-delta", id: "text:1:0", delta: "Yes." },
		{ type: "assistant-complete", id: "text:1:0" },
		{ type: "finish" },
	]),
);
await drain(textReply.events);
assert(!textReply.shouldRenderNotice(), "assistant text should suppress the no-reply notice");

const failedReply = monitorNoReplyEvents(stream([{ type: "error", errorText: "model failed" }, { type: "finish" }]));
await drain(failedReply.events);
assert(!failedReply.shouldRenderNotice(), "error turns should use the normal error block only");

console.log("tui no-reply smoke OK");
