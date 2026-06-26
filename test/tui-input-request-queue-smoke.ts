import type { InputRequest } from "eve/client";
import { InputRequestQueue } from "../agent/lib/tui-input-request-queue.ts";

function assert(condition: boolean, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function request(requestId: string, prompt: string): InputRequest {
	return {
		action: { callId: requestId, input: {}, kind: "tool-call", toolName: "ask_question" },
		display: "text",
		prompt,
		requestId,
	};
}

const queue = new InputRequestQueue();
queue.add([request("first", "First?")]);
queue.add([request("second", "Second?")]);
queue.add([request("first", "First updated?")]);

assert(queue.size === 2, "queue should dedupe by request id");
const drained = queue.drain();
assert(drained.length === 2, "drain should return all queued requests");
assert(drained[0]?.requestId === "first" && drained[0].prompt === "First updated?", "duplicate requests should update in place");
assert(drained[1]?.requestId === "second", "queue should preserve first-seen order for distinct requests");
const emptySize: number = queue.size;
assert(emptySize === 0, "drain should clear the queue");

console.log("tui-input-request-queue-smoke: ok");
