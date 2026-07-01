import { EventEmitter } from "node:events";
import { setImmediate as nextTick } from "node:timers/promises";
import { bindClankvoxRealtimeBridge } from "../agent/lib/voice/clankvoxRealtimeBridge.ts";
import type { JsonRecord } from "../agent/lib/voice/json.ts";
import { OpenAiRealtimeClient } from "../agent/lib/voice/openAiRealtimeClient.ts";
import { createSerialOpQueue } from "../agent/lib/voice/opQueue.ts";
import { classifyRealtimeEvent } from "../agent/lib/voice/realtimeWsClientBase.ts";
import { XAiRealtimeClient } from "../agent/lib/voice/xAiRealtimeClient.ts";

let failures = 0;

function check(label: string, ok: boolean): void {
	console.log(`${ok ? "ok  " : "FAIL"}  ${label}`);
	if (!ok) failures += 1;
}

// --- classifyRealtimeEvent: reconciled transcript/audio union ---

{
	const input = classifyRealtimeEvent({
		type: "conversation.item.input_audio_transcription.delta",
		delta: "hel",
		item_id: "item_1",
	});
	check(
		"input transcription delta classifies as transcript",
		input.kind === "transcript" && input.transcript.text === "hel" && input.transcript.itemId === "item_1",
	);

	const legacyDelta = classifyRealtimeEvent({ type: "response.text.delta", delta: "hi" });
	check(
		"legacy response.text.delta normalizes to response.output_text.delta",
		legacyDelta.kind === "transcript" && legacyDelta.transcript.eventType === "response.output_text.delta",
	);

	const legacyDone = classifyRealtimeEvent({ type: "response.text.done", text: "hi there" });
	check(
		"legacy response.text.done normalizes to response.output_text.done",
		legacyDone.kind === "transcript" && legacyDone.transcript.eventType === "response.output_text.done",
	);

	const blankCompleted = classifyRealtimeEvent({
		type: "conversation.item.input_audio_transcription.completed",
		transcript: "",
		item_id: "item_2",
	});
	check(
		"blank input completion still emits (keeps speaker FIFO 1:1)",
		blankCompleted.kind === "transcript" && blankCompleted.transcript.text === "",
	);

	const blankDone = classifyRealtimeEvent({ type: "response.output_text.done", text: "" });
	check("blank terminal done still emits (flushes TTS delta buffer)", blankDone.kind === "transcript");

	const blankDelta = classifyRealtimeEvent({ type: "response.output_text.delta", delta: "" });
	check("blank delta is dropped", blankDelta.kind === "other");

	const audioNew = classifyRealtimeEvent({ type: "response.output_audio.delta", delta: "cGNt" });
	const audioLegacy = classifyRealtimeEvent({ type: "response.audio.delta", audio: "cGNt" });
	check(
		"both audio delta event names classify as audio",
		audioNew.kind === "audio_delta" && audioLegacy.kind === "audio_delta" && audioNew.audioBase64 === "cGNt",
	);

	check("error events classify as error_event", classifyRealtimeEvent({ type: "error" }).kind === "error_event");
	check("unknown events classify as other", classifyRealtimeEvent({ type: "session.updated" }).kind === "other");
}

// --- send-on-closed drops and logs instead of throwing (C1 convention flip) ---

{
	const logged: Array<{ level: string; event: string }> = [];
	const logger = (level: "info" | "warn" | "error", event: string): void => {
		logged.push({ level, event });
	};
	const openai = new OpenAiRealtimeClient({ apiKey: "test-key", logger });
	let threw = false;
	try {
		openai.appendInputAudioPcm(Buffer.alloc(12));
		openai.commitInputAudioBuffer();
		openai.createAudioResponse();
		openai.sendFunctionCallOutput({ callId: "c1", output: { ok: true } });
		openai.appendInputVideoFrame({ mimeType: "image/jpeg", dataBase64: "AA==" });
		openai.requestTextUtterance("hello");
	} catch {
		threw = true;
	}
	check("openai client never throws on a closed socket", !threw);
	check(
		"openai client logs dropped sends",
		logged.some((entry) => entry.event === "openai_realtime_send_dropped" && entry.level === "warn"),
	);

	const xaiLogged: Array<{ level: string; event: string }> = [];
	const xai = new XAiRealtimeClient({
		apiKey: "test-key",
		logger: (level, event) => xaiLogged.push({ level, event }),
	});
	let xaiThrew = false;
	try {
		xai.commitInputAudioBuffer();
		xai.cancelResponse();
		xai.sendFunctionCallOutput({ callId: "c2", output: "done" });
	} catch {
		xaiThrew = true;
	}
	check("xai client never throws on a closed socket", !xaiThrew);
	check(
		"xai client logs dropped sends",
		xaiLogged.some((entry) => entry.event === "xai_realtime_send_dropped"),
	);
}

// --- bridge guards realtime failures and unbinds on dispose ---

class FakeVox extends EventEmitter {
	readonly subscribed: string[] = [];
	subscribeUser(userId: string): void {
		this.subscribed.push(userId);
	}
}

async function bridgeChecks(): Promise<void> {
	const vox = new FakeVox();
	const errors: unknown[] = [];
	const appended: string[] = [];
	const realtime = {
		appendInputAudioPcm(audio: Buffer): void {
			appended.push(`audio:${audio.length}`);
		},
		commitInputAudioBuffer(): void {
			appended.push("commit");
		},
		createAudioResponse(): void {
			appended.push("respond");
		},
		appendInputVideoFrame(): void {
			throw new Error("realtime socket is not open");
		},
	};
	const frames: unknown[] = [];
	const binding = bindClankvoxRealtimeBridge({
		vox,
		realtime,
		onDecodedVideoFrame(frame) {
			frames.push(frame);
		},
		onError(error) {
			errors.push(error);
		},
	});

	const videoFrame = {
		userId: "u1",
		ssrc: 1,
		width: 2,
		height: 2,
		jpegBase64: "AA==",
		rtpTimestamp: 0,
		streamType: null,
		rid: null,
	};
	vox.emit("decodedVideoFrame", videoFrame);
	check("throwing video forward is captured by onError, not thrown", errors.length === 1);
	check("frame callback ran before the failing forward", frames.length === 1);

	vox.emit("speakingStart", "u1");
	check("speakingStart subscribes the user", vox.subscribed.length === 1);
	vox.emit("userAudio", "u1", Buffer.alloc(480));
	vox.emit("userAudioEnd", "u1");
	await nextTick();

	const ipcErrors: JsonRecord[] = [];
	const binding2Errors: unknown[] = [];
	const vox2 = new FakeVox();
	const binding2 = bindClankvoxRealtimeBridge({
		vox: vox2,
		realtime,
		onIpcError(event) {
			ipcErrors.push(event);
		},
		onError(error) {
			binding2Errors.push(error);
		},
		autoAppendDecodedVideoFrames: false,
	});
	vox2.emit("ipcError", { type: "error", message: "boom" });
	check("ipcError reaches onIpcError", ipcErrors.length === 1);
	vox2.emit("decodedVideoFrame", videoFrame);
	check("autoAppendDecodedVideoFrames=false skips the throwing forward", binding2Errors.length === 0);
	binding2.dispose();

	binding.dispose();
	const subscribedBefore = vox.subscribed.length;
	const errorsBefore = errors.length;
	vox.emit("speakingStart", "u2");
	vox.emit("decodedVideoFrame", videoFrame);
	check("dispose unbinds vox listeners", vox.subscribed.length === subscribedBefore && errors.length === errorsBefore);
	check("vox has no lingering bridge listeners", vox.listenerCount("decodedVideoFrame") === 0 && vox.listenerCount("userAudio") === 0);
}

// --- serial op queue (H5: join/leave serialization) ---

async function opQueueChecks(): Promise<void> {
	const queue = createSerialOpQueue();
	const order: string[] = [];
	let resolveFirst: (() => void) | undefined;
	const first = queue.run(async () => {
		order.push("first:start");
		await new Promise<void>((resolve) => {
			resolveFirst = resolve;
		});
		order.push("first:end");
		return "one";
	});
	const second = queue.run(async () => {
		order.push("second:start");
		return "two";
	});
	await nextTick();
	check("second op waits for the first", order.join(",") === "first:start");
	resolveFirst?.();
	const [firstResult, secondResult] = await Promise.all([first, second]);
	check("ops run strictly in order", order.join(",") === "first:start,first:end,second:start");
	check("op results propagate", firstResult === "one" && secondResult === "two");

	let rejected = false;
	await queue
		.run(async () => {
			throw new Error("join failed");
		})
		.catch(() => {
			rejected = true;
		});
	const after = await queue.run(async () => "still-running");
	check("a rejected op propagates to its caller", rejected);
	check("the queue keeps running after a rejection", after === "still-running");
}

await bridgeChecks();
await opQueueChecks();

if (failures > 0) {
	console.error(`\n${failures} check(s) failed`);
	process.exitCode = 1;
} else {
	console.log("\nALL OK");
}
