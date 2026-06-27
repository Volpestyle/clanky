import { buildMemoryContext } from "../memory.ts";
import type { VoiceControlInput, VoiceControlResult } from "./control.ts";
import { errorMessage, isRecord, type JsonRecord, stringValue } from "./json.ts";
import type { OpenAiRealtimeTool } from "./openAiRealtimeClient.ts";
import {
	isVoiceInputTranscript,
	type VoiceMemorySpeaker,
	type VoiceTranscriptSpeakerContext,
	type VoiceTranscriptSpeakerResolver,
} from "./memory.ts";
import type { OpenAiRealtimeTranscript } from "./openAiRealtimeClient.ts";

export interface RealtimeFunctionCall {
	callId: string;
	name: string;
	arguments: JsonRecord;
}

export interface RealtimeVoiceToolClient {
	on(event: "transcript", listener: (transcript: OpenAiRealtimeTranscript) => void): unknown;
	on(event: "event", listener: (event: JsonRecord) => void): unknown;
	off?(event: "transcript", listener: (transcript: OpenAiRealtimeTranscript) => void): unknown;
	off?(event: "event", listener: (event: JsonRecord) => void): unknown;
	sendFunctionCallOutput(input: { callId: string; output: unknown }): void;
	createAudioResponse(): void;
}

export interface RealtimeVoiceToolBinding {
	dispose(): void;
}

export interface BindRealtimeVoiceToolOptions {
	realtime: RealtimeVoiceToolClient;
	guildId: string;
	channelId: string;
	resolveSpeakerContext?: VoiceTranscriptSpeakerResolver;
	executeControl(input: VoiceControlInput): Promise<VoiceControlResult> | VoiceControlResult;
}

const URL_PARAMETER = {
	type: "string",
	description: "YouTube, direct media, or other yt-dlp-supported media URL.",
} satisfies JsonRecord;

const DIRECT_URL_PARAMETER = {
	type: "boolean",
	description: "Set true only when url is already a direct media URL and should skip yt-dlp resolution.",
} satisfies JsonRecord;

const EMPTY_PARAMETERS = {
	type: "object",
	additionalProperties: false,
	properties: {},
} satisfies JsonRecord;

export const VOICE_REALTIME_TOOLS: OpenAiRealtimeTool[] = [
	{
		type: "function",
		name: "voice_memory_search",
		description:
			"Search Clanky's durable memory for facts relevant to the current Discord voice speaker and server before claiming recall.",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				query: { type: "string", description: "What to recall." },
				limit: { type: "integer", minimum: 1, maximum: 10, description: "Maximum memory facts to return." },
			},
			required: ["query"],
		},
	},
	{
		type: "function",
		name: "voice_music_play",
		description: "Play music/audio into the active Discord voice channel through ClankVox.",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: { url: URL_PARAMETER, resolvedDirectUrl: DIRECT_URL_PARAMETER },
			required: ["url"],
		},
	},
	{ type: "function", name: "voice_music_stop", description: "Stop music/audio playback in voice.", parameters: EMPTY_PARAMETERS },
	{ type: "function", name: "voice_music_pause", description: "Pause music/audio playback in voice.", parameters: EMPTY_PARAMETERS },
	{ type: "function", name: "voice_music_resume", description: "Resume paused music/audio playback in voice.", parameters: EMPTY_PARAMETERS },
	{
		type: "function",
		name: "voice_music_volume",
		description: "Set music/audio playback volume. Use values from 0.0 to 1.0.",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				volume: { type: "number", minimum: 0, maximum: 1 },
				fadeMs: { type: "integer", minimum: 0, maximum: 10000 },
			},
			required: ["volume"],
		},
	},
	{
		type: "function",
		name: "voice_video_play",
		description:
			"Start Discord Go Live for the active voice channel and publish a YouTube/direct video URL through ClankVox.",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				url: URL_PARAMETER,
				resolvedDirectUrl: DIRECT_URL_PARAMETER,
				preferredRegion: { type: "string" },
			},
			required: ["url"],
		},
	},
	{
		type: "function",
		name: "voice_video_visualizer",
		description:
			"Start Discord Go Live and publish an audio visualizer for a YouTube/direct audio URL through ClankVox.",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				url: URL_PARAMETER,
				resolvedDirectUrl: DIRECT_URL_PARAMETER,
				visualizerMode: { type: "string", enum: ["cqt", "spectrum", "waves", "vectorscope"] },
				preferredRegion: { type: "string" },
			},
			required: ["url"],
		},
	},
	{ type: "function", name: "voice_video_stop", description: "Stop Clanky's active Discord Go Live video pipeline.", parameters: EMPTY_PARAMETERS },
	{ type: "function", name: "voice_video_pause", description: "Pause Clanky's active Discord Go Live video pipeline.", parameters: EMPTY_PARAMETERS },
	{ type: "function", name: "voice_video_resume", description: "Resume Clanky's active Discord Go Live video pipeline.", parameters: EMPTY_PARAMETERS },
	{
		type: "function",
		name: "voice_golive_start",
		description: "Start Clanky's Discord Go Live publish stream for the active voice channel.",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: { preferredRegion: { type: "string" } },
		},
	},
	{
		type: "function",
		name: "voice_golive_stop",
		description: "Stop Clanky's Discord Go Live publish stream. streamKey is optional when Clanky's own stream is known.",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: { streamKey: { type: "string" } },
		},
	},
];

export function appendVoiceRealtimeTools(options: {
	tools?: readonly OpenAiRealtimeTool[];
}): OpenAiRealtimeTool[] {
	const existing = options.tools ?? [];
	const names = new Set(existing.map((tool) => tool.name));
	return [...existing, ...VOICE_REALTIME_TOOLS.filter((tool) => !names.has(tool.name))];
}

export function bindRealtimeVoiceTools(options: BindRealtimeVoiceToolOptions): RealtimeVoiceToolBinding {
	const seenCallIds = new Set<string>();
	let latestSpeakerContext: VoiceTranscriptSpeakerContext | undefined;
	const transcriptListener = (transcript: OpenAiRealtimeTranscript): void => {
		if (!isVoiceInputTranscript(transcript)) return;
		latestSpeakerContext = options.resolveSpeakerContext?.(transcript);
	};
	const eventListener = (event: JsonRecord): void => {
		const call = parseRealtimeFunctionCall(event);
		if (call === undefined || seenCallIds.has(call.callId)) return;
		seenCallIds.add(call.callId);
		void executeRealtimeVoiceTool(call, options, latestSpeakerContext)
			.then((output) => {
				options.realtime.sendFunctionCallOutput({ callId: call.callId, output });
				options.realtime.createAudioResponse();
			})
			.catch((error: unknown) => {
				options.realtime.sendFunctionCallOutput({
					callId: call.callId,
					output: { ok: false, error: errorMessage(error) },
				});
				options.realtime.createAudioResponse();
			});
	};
	options.realtime.on("transcript", transcriptListener);
	options.realtime.on("event", eventListener);
	return {
		dispose() {
			options.realtime.off?.("transcript", transcriptListener);
			options.realtime.off?.("event", eventListener);
		},
	};
}

export function parseRealtimeFunctionCall(event: JsonRecord): RealtimeFunctionCall | undefined {
	const type = stringValue(event.type);
	const record = functionCallRecord(event);
	if (record === undefined && !type.includes("function_call")) return undefined;
	const source = record ?? event;
	const callId = firstString(
		source.call_id,
		source.callId,
		event.call_id,
		event.callId,
		source.id,
		event.id,
	);
	const name = firstString(source.name, event.name);
	if (callId === undefined || name === undefined) return undefined;
	const args = parseArguments(source.arguments ?? event.arguments);
	return { callId, name, arguments: args };
}

async function executeRealtimeVoiceTool(
	call: RealtimeFunctionCall,
	options: BindRealtimeVoiceToolOptions,
	speakerContext: VoiceTranscriptSpeakerContext | undefined,
): Promise<unknown> {
	if (call.name === "voice_memory_search") {
		return await executeVoiceMemorySearch(call.arguments, options, speakerContext);
	}
	const input = voiceControlInputFromToolCall(call.name, call.arguments);
	if (input === undefined) return { ok: false, error: `unknown realtime voice tool '${call.name}'` };
	return await options.executeControl(input);
}

async function executeVoiceMemorySearch(
	args: JsonRecord,
	options: BindRealtimeVoiceToolOptions,
	speakerContext: VoiceTranscriptSpeakerContext | undefined,
): Promise<unknown> {
	const query = stringValue(args.query).trim();
	const limit = clampIntegerArg(args.limit, 6, 1, 10);
	const speaker = singleSpeaker(speakerContext);
	const markdown = await buildMemoryContext({
		limit,
		query,
		discordServerId: options.guildId,
		discordUserId: speaker?.userId,
		discordUserName: speaker?.userName,
		includeMainUser: false,
	});
	return {
		ok: true,
		query,
		scope: {
			guildId: options.guildId,
			channelId: options.channelId,
			...(speaker === undefined ? {} : { speakerUserId: speaker.userId, speakerName: speaker.userName }),
		},
		memory: markdown || "No scoped durable memory matched.",
	};
}

function voiceControlInputFromToolCall(name: string, args: JsonRecord): VoiceControlInput | undefined {
	switch (name) {
		case "voice_music_play":
			return { op: "music_play", url: stringValue(args.url), resolvedDirectUrl: booleanValue(args.resolvedDirectUrl) };
		case "voice_music_stop":
			return { op: "music_stop" };
		case "voice_music_pause":
			return { op: "music_pause" };
		case "voice_music_resume":
			return { op: "music_resume" };
		case "voice_music_volume":
			return { op: "music_volume", volume: numberValue(args.volume), fadeMs: numberValue(args.fadeMs) };
		case "voice_video_play":
			return {
				op: "video_play",
				url: stringValue(args.url),
				resolvedDirectUrl: booleanValue(args.resolvedDirectUrl),
				preferredRegion: stringValue(args.preferredRegion),
			};
		case "voice_video_visualizer":
			return {
				op: "video_visualizer",
				url: stringValue(args.url),
				resolvedDirectUrl: booleanValue(args.resolvedDirectUrl),
				visualizerMode: stringValue(args.visualizerMode),
				preferredRegion: stringValue(args.preferredRegion),
			};
		case "voice_video_stop":
			return { op: "video_stop" };
		case "voice_video_pause":
			return { op: "video_pause" };
		case "voice_video_resume":
			return { op: "video_resume" };
		case "voice_golive_start":
			return { op: "golive_start", preferredRegion: stringValue(args.preferredRegion) };
		case "voice_golive_stop":
			return { op: "golive_stop", streamKey: stringValue(args.streamKey) };
		default:
			return undefined;
	}
}

function functionCallRecord(event: JsonRecord): JsonRecord | undefined {
	const item = recordProp(event, "item");
	if (item !== undefined && stringValue(item.type) === "function_call") return item;
	const response = recordProp(event, "response");
	const output = response?.output;
	if (!Array.isArray(output)) return undefined;
	for (const entry of output) {
		if (isRecord(entry) && stringValue(entry.type) === "function_call") return entry;
	}
	return undefined;
}

function recordProp(record: JsonRecord, key: string): JsonRecord | undefined {
	const value = record[key];
	return isRecord(value) ? value : undefined;
}

function parseArguments(value: unknown): JsonRecord {
	if (isRecord(value)) return value;
	const text = stringValue(value).trim();
	if (text.length === 0) return {};
	try {
		const parsed = JSON.parse(text) as unknown;
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function firstString(...values: unknown[]): string | undefined {
	for (const value of values) {
		const text = stringValue(value).trim();
		if (text.length > 0) return text;
	}
	return undefined;
}

function booleanValue(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clampIntegerArg(value: unknown, fallback: number, min: number, max: number): number {
	const number = numberValue(value);
	if (number === undefined) return fallback;
	return Math.max(min, Math.min(max, Math.floor(number)));
}

function singleSpeaker(context: VoiceTranscriptSpeakerContext | undefined): VoiceMemorySpeaker | undefined {
	if (context?.speaker !== undefined) return context.speaker;
	const userIds = context?.speakerUserIds ?? [];
	if (userIds.length !== 1) return undefined;
	const userId = userIds[0];
	return userId === undefined ? undefined : { userId };
}
