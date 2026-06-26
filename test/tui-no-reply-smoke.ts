import type { HandleMessageStreamEvent } from "eve/client";
import { monitorNoReplyEvents } from "../agent/lib/tui-no-reply.ts";

function assert(condition: boolean, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

async function* stream(events: readonly HandleMessageStreamEvent[]): AsyncGenerator<HandleMessageStreamEvent> {
	for (const event of events) yield event;
}

async function drain(events: AsyncIterable<HandleMessageStreamEvent>): Promise<void> {
	for await (const _event of events) {
		// Drain the stream so the monitor sees every event.
	}
}

const emptyReply = monitorNoReplyEvents(
	stream([
		{ type: "step.started", data: { sequence: 1, stepIndex: 0, turnId: "turn-1" } },
		{
			type: "step.completed",
			data: {
				finishReason: "stop",
				sequence: 2,
				stepIndex: 0,
				turnId: "turn-1",
				usage: { inputTokens: 9400, outputTokens: 131 },
			},
		},
		{ type: "turn.completed", data: { sequence: 3, turnId: "turn-1" } },
	]),
);
await drain(emptyReply.events);
assert(emptyReply.shouldRenderNotice(), "completed empty assistant turn should render a no-reply notice");
assert(
	emptyReply.formatNoReplyNotice().includes("No assistant reply was produced for that turn."),
	"no-reply notice should include the user-facing explanation",
);
assert(emptyReply.formatNoReplyNotice().includes("usage input 9400, output 131"), "no-reply trace should include usage");
assert(emptyReply.formatNoReplyNotice().includes("assistant 0 chars"), "no-reply trace should show no assistant text");

const textReply = monitorNoReplyEvents(
	stream([
		{ type: "step.started", data: { sequence: 1, stepIndex: 0, turnId: "turn-2" } },
		{
			type: "message.appended",
			data: { messageDelta: "Yes.", messageSoFar: "Yes.", sequence: 2, stepIndex: 0, turnId: "turn-2" },
		},
		{
			type: "message.completed",
			data: { finishReason: "stop", message: "Yes.", sequence: 3, stepIndex: 0, turnId: "turn-2" },
		},
		{ type: "turn.completed", data: { sequence: 4, turnId: "turn-2" } },
	]),
);
await drain(textReply.events);
assert(!textReply.shouldRenderNotice(), "assistant text should suppress the no-reply notice");
assert(textReply.formatTraceNotice().includes("assistant 4 chars"), "trace should count visible assistant text");

const failedReply = monitorNoReplyEvents(
	stream([
		{ type: "turn.failed", data: { code: "model_failed", message: "model failed", sequence: 1, turnId: "turn-3" } },
	]),
);
await drain(failedReply.events);
assert(!failedReply.shouldRenderNotice(), "error turns should use the normal error block only");
assert(failedReply.formatTraceNotice().includes("errors 1"), "trace should count stream errors");

console.log("tui no-reply smoke OK");
