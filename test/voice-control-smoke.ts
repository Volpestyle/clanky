import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate, setTimeout } from "node:timers/promises";
import { rememberMemory } from "../agent/lib/memory.ts";
import {
	executeVoiceControl,
	type VoiceControlGoLive,
	type VoiceControlInput,
	type VoiceControlVox,
} from "../agent/lib/voice/control.ts";
import type { DiscoveredDiscordStream } from "../agent/lib/voice/discordStreamDiscovery.ts";
import { type JsonRecord } from "../agent/lib/voice/json.ts";
import { type OpenAiRealtimeTranscript } from "../agent/lib/voice/openAiRealtimeClient.ts";
import {
	appendVoiceRealtimeTools,
	bindRealtimeVoiceTools,
	parseRealtimeFunctionCall,
	VOICE_REALTIME_TOOLS,
} from "../agent/lib/voice/realtime-tools.ts";

let failures = 0;

function check(label: string, ok: boolean): void {
	console.log(`${ok ? "ok  " : "FAIL"}  ${label}`);
	if (!ok) failures += 1;
}

async function waitForOutput(
	outputs: Array<{ callId: string; output: unknown }>,
	callId: string,
): Promise<unknown> {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		const output = outputs.find((entry) => entry.callId === callId)?.output;
		if (output !== undefined) return output;
		await setTimeout(10);
	}
	return undefined;
}

const commands: string[] = [];
const vox: VoiceControlVox = {
	musicPlay(url, resolvedDirectUrl) {
		commands.push(`music_play:${url}:${resolvedDirectUrl === true}`);
	},
	musicStop() {
		commands.push("music_stop");
	},
	musicPause() {
		commands.push("music_pause");
	},
	musicResume() {
		commands.push("music_resume");
	},
	musicSetGain(target, fadeMs) {
		commands.push(`music_gain:${target}:${fadeMs}`);
	},
	streamPublishPlay(url, resolvedDirectUrl) {
		commands.push(`video_play:${url}:${resolvedDirectUrl === true}`);
	},
	streamPublishPlayVisualizer(url, resolvedDirectUrl, visualizerMode) {
		commands.push(`video_visualizer:${url}:${resolvedDirectUrl === true}:${visualizerMode}`);
	},
	streamPublishStop() {
		commands.push("video_stop");
	},
	streamPublishPause() {
		commands.push("video_pause");
	},
	streamPublishResume() {
		commands.push("video_resume");
	},
};

const ownStream: DiscoveredDiscordStream = {
	kind: "guild",
	streamKey: "guild:g1:vc1:self",
	guildId: "g1",
	channelId: "vc1",
	userId: "self",
	endpoint: "endpoint",
	token: "token",
	rtcServerId: "server",
	updatedAt: Date.now(),
};
const goLiveCalls: string[] = [];
const goLive: VoiceControlGoLive = {
	listStreams() {
		return [ownStream];
	},
	goLive(input) {
		goLiveCalls.push(`start:${input.guildId}:${input.channelId}:${input.preferredRegion ?? ""}`);
	},
	stopPublish(streamKey) {
		goLiveCalls.push(`stop:${streamKey}`);
	},
	setPaused(streamKey, paused) {
		goLiveCalls.push(`paused:${streamKey}:${paused}`);
	},
	findOwnStream() {
		return ownStream;
	},
};

await executeVoiceControl(
	{ op: "music_play", url: "https://youtube.example/audio" },
	{ guildId: "g1", channelId: "vc1", vox, goLive },
);
check("voice control routes music play to ClankVox", commands.includes("music_play:https://youtube.example/audio:false"));

const volume = await executeVoiceControl(
	{ op: "music_volume", volume: 0.25, fadeMs: 500 },
	{ guildId: "g1", channelId: "vc1", vox, goLive },
);
check("voice control returns normalized music volume", volume.volume === 0.25 && volume.fadeMs === 500);
check("voice control routes music volume to ClankVox", commands.includes("music_gain:0.25:500"));

await executeVoiceControl(
	{ op: "video_play", url: "https://youtube.example/video", preferredRegion: "us-central" },
	{ guildId: "g1", channelId: "vc1", vox, goLive },
);
check("voice video play requests Go Live", goLiveCalls.includes("start:g1:vc1:us-central"));
check("voice video play routes URL to stream publish", commands.includes("video_play:https://youtube.example/video:false"));

await executeVoiceControl({ op: "golive_stop" }, { guildId: "g1", channelId: "vc1", vox, goLive });
check("voice Go Live stop resolves own stream key", goLiveCalls.includes("stop:guild:g1:vc1:self"));

const call = parseRealtimeFunctionCall({
	type: "response.output_item.done",
	item: {
		type: "function_call",
		call_id: "call-1",
		name: "voice_music_play",
		arguments: "{\"url\":\"https://youtube.example/song\"}",
	},
});
check("realtime parser reads function call output item", call?.name === "voice_music_play" && call.arguments.url === "https://youtube.example/song");
check("voice realtime tool list includes memory search", VOICE_REALTIME_TOOLS.some((tool) => tool.name === "voice_memory_search"));
check("voice realtime append avoids duplicate names", appendVoiceRealtimeTools({ tools: [VOICE_REALTIME_TOOLS[0]!] }).length === VOICE_REALTIME_TOOLS.length);

const transcriptListeners: ((transcript: OpenAiRealtimeTranscript) => void)[] = [];
const eventListeners: ((event: JsonRecord) => void)[] = [];
const functionOutputs: Array<{ callId: string; output: unknown }> = [];
let responseCreates = 0;
const realtime = {
	on(event: "transcript" | "event", listener: ((transcript: OpenAiRealtimeTranscript) => void) | ((event: JsonRecord) => void)): void {
		if (event === "transcript") transcriptListeners.push(listener as (transcript: OpenAiRealtimeTranscript) => void);
		if (event === "event") eventListeners.push(listener as (event: JsonRecord) => void);
	},
	off(event: "transcript" | "event", listener: ((transcript: OpenAiRealtimeTranscript) => void) | ((event: JsonRecord) => void)): void {
		const list = event === "transcript" ? transcriptListeners : eventListeners;
		const index = list.indexOf(listener as never);
		if (index >= 0) list.splice(index, 1);
	},
	sendFunctionCallOutput(input: { callId: string; output: unknown }): void {
		functionOutputs.push(input);
	},
	createAudioResponse(): void {
		responseCreates += 1;
	},
};

const binding = bindRealtimeVoiceTools({
	realtime,
	guildId: "g1",
	channelId: "vc1",
	resolveSpeakerContext: () => ({ speaker: { userId: "u1", userName: "Morgan" }, speakerUserIds: ["u1"] }),
	executeControl(input: VoiceControlInput) {
		commands.push(`tool:${input.op}:${input.url ?? ""}`);
		return { ok: true, op: input.op, guildId: "g1", channelId: "vc1" };
	},
});
for (const listener of eventListeners) {
	listener({
		type: "response.output_item.done",
		item: {
			type: "function_call",
			call_id: "call-2",
			name: "voice_music_pause",
			arguments: "{}",
		},
	});
}
await setImmediate();
check("realtime dispatcher executes voice control calls", commands.includes("tool:music_pause:"));
check("realtime dispatcher returns function output", functionOutputs[0]?.callId === "call-2");
check("realtime dispatcher requests a follow-up response", responseCreates === 1);
binding.dispose();

const previousHome = process.env.CLANKY_HOME;
const memoryHome = await mkdtemp(join(tmpdir(), "clanky-voice-control-memory-"));
process.env.CLANKY_HOME = memoryHome;
try {
	await rememberMemory({
		subjectKind: "discord_user",
		subjectId: "u1",
		subjectName: "Morgan",
		fact: "Morgan likes ambient techno.",
		tags: ["music"],
		importance: 4,
	});
	const memoryTranscriptListeners: ((transcript: OpenAiRealtimeTranscript) => void)[] = [];
	const memoryEventListeners: ((event: JsonRecord) => void)[] = [];
	const memoryOutputs: Array<{ callId: string; output: unknown }> = [];
	const memoryRealtime = {
		on(event: "transcript" | "event", listener: ((transcript: OpenAiRealtimeTranscript) => void) | ((event: JsonRecord) => void)): void {
			if (event === "transcript") memoryTranscriptListeners.push(listener as (transcript: OpenAiRealtimeTranscript) => void);
			if (event === "event") memoryEventListeners.push(listener as (event: JsonRecord) => void);
		},
		off(event: "transcript" | "event", listener: ((transcript: OpenAiRealtimeTranscript) => void) | ((event: JsonRecord) => void)): void {
			const list = event === "transcript" ? memoryTranscriptListeners : memoryEventListeners;
			const index = list.indexOf(listener as never);
			if (index >= 0) list.splice(index, 1);
		},
		sendFunctionCallOutput(input: { callId: string; output: unknown }): void {
			memoryOutputs.push(input);
		},
		createAudioResponse(): void {},
	};
	const memoryBinding = bindRealtimeVoiceTools({
		realtime: memoryRealtime,
		guildId: "g1",
		channelId: "vc1",
		resolveSpeakerContext: () => ({ speaker: { userId: "u1", userName: "Morgan" }, speakerUserIds: ["u1"] }),
		executeControl() {
			throw new Error("unexpected control call");
		},
	});
	for (const listener of memoryTranscriptListeners) {
		listener({
			eventType: "conversation.item.input_audio_transcription.completed",
			text: "what do you remember about my music taste",
			itemId: "voice-memory-item",
		});
	}
	for (const listener of memoryEventListeners) {
		listener({
			type: "response.output_item.done",
			item: {
				type: "function_call",
				call_id: "call-memory",
				name: "voice_memory_search",
				arguments: "{\"query\":\"music taste\",\"limit\":5}",
			},
		});
	}
	const memoryOutput = await waitForOutput(memoryOutputs, "call-memory");
	check("realtime memory search returns scoped memory", JSON.stringify(memoryOutput ?? {}).includes("ambient techno"));
	memoryBinding.dispose();
} finally {
	if (previousHome === undefined) delete process.env.CLANKY_HOME;
	else process.env.CLANKY_HOME = previousHome;
	await rm(memoryHome, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
