/**
 * Voice session supervisor — wires the ported control plane together:
 * ClankVox media transport + OpenAI Realtime + the turn-buffer bridge. This is
 * the eve-era replacement for the old voiceSupervisorExtension.
 *
 * The Discord voice adapter (`guild`) and provider credentials are injected at
 * runtime by whatever owns the Discord connection; this module owns the wiring,
 * not the transport.
 */
import { bindClankvoxRealtimeBridge } from "./clankvoxRealtimeBridge.ts";
import { ClankvoxIpcClient, type ClankvoxGuildLike, type ClankvoxSpawnOptions } from "./clankvoxIpcClient.ts";
import type { DiscordVoiceTurnBuffer } from "./discordVoiceTurnBuffer.ts";
import { bindExternalTtsOutput, type ExternalTtsOutputBinding } from "./externalTtsBridge.ts";
import {
	DEFAULT_ELEVENLABS_OUTPUT_FORMAT,
	DEFAULT_ELEVENLABS_SPEED,
	DEFAULT_ELEVENLABS_TTS_MODEL,
	ElevenLabsTtsClient,
	type ElevenLabsPcmOutputFormat,
} from "./elevenLabsTtsClient.ts";
import { bindVoiceEveSession, type VoiceEveSessionBinding, type VoiceEveSessionConfig } from "./eve-session.ts";
import { type JsonRecord, stringValue } from "./json.ts";
import { OpenAiRealtimeClient, type OpenAiRealtimeConnectOptions } from "./openAiRealtimeClient.ts";
import type { OpenAiRealtimeTranscript } from "./openAiRealtimeClient.ts";
import {
	bindVoiceTranscriptMemory,
	isVoiceInputTranscript,
	type VoiceMemorySpeaker,
	type VoiceTranscriptMemoryBinding,
	type VoiceTranscriptSpeakerContext,
} from "./memory.ts";
import { XAiRealtimeClient } from "./xAiRealtimeClient.ts";
import { buildMemoryContext } from "../memory.ts";

export type VoiceRealtimeProvider = "openai" | "xai";
export type VoiceTtsProvider = "realtime" | "elevenlabs";

export interface VoiceRealtimeConfig {
	provider: VoiceRealtimeProvider;
	apiKey: string;
	baseUrl?: string;
}

export interface VoiceElevenLabsTtsConfig {
	provider: "elevenlabs";
	apiKey: string;
	voiceId: string;
	modelId?: string;
	baseUrl?: string;
	outputFormat?: ElevenLabsPcmOutputFormat;
	speed?: number;
}

export type VoiceExternalTtsConfig = VoiceElevenLabsTtsConfig;

export interface VoiceElevenLabsRuntimeSummary {
	voiceId: string;
	modelId: string;
	outputFormat: ElevenLabsPcmOutputFormat;
	speed: number;
}

export interface VoiceRuntimeSummary {
	realtimeProvider: VoiceRealtimeProvider;
	realtimeModel: string;
	realtimeVoice?: string;
	responseOutputModality?: OpenAiRealtimeConnectOptions["responseOutputModality"];
	ttsProvider: VoiceTtsProvider;
	elevenLabs?: VoiceElevenLabsRuntimeSummary;
	eveSessionEnabled: boolean;
	memoryContextEnabled: boolean;
	memoryContextLimit: number;
}

export interface VoiceRuntimeSummaryInput {
	realtime: VoiceRealtimeConfig;
	connect: OpenAiRealtimeConnectOptions;
	externalTts?: VoiceExternalTtsConfig;
	eveSession?: VoiceEveSessionConfig;
	eveSessionHost?: string;
	memoryContextLimit?: number;
}

export interface VoiceRealtimeClient {
	readonly supportsInputVideoFrames?: boolean;
	connect(options: OpenAiRealtimeConnectOptions): Promise<void>;
	appendInputAudioPcm(audio: Buffer): void;
	commitInputAudioBuffer(): void;
	cancelResponse?(): void;
	createAudioResponse(): void;
	requestTextUtterance?(text: string): void;
	appendInputVideoFrame(input: { mimeType: string; dataBase64: string }): void;
	sendFunctionCallOutput(input: { callId: string; output: unknown }): void;
	close(): Promise<void>;
	on(event: "audio_delta", listener: (pcmBase64: string) => void): unknown;
	on(event: "transcript", listener: (transcript: OpenAiRealtimeTranscript) => void): unknown;
	on(event: "event", listener: (event: JsonRecord) => void): unknown;
	on(event: "error_event", listener: (event: JsonRecord) => void): unknown;
	on(event: "socket_error", listener: (error: Error) => void): unknown;
	on(event: "socket_closed", listener: (event: { code: number; reason: string }) => void): unknown;
}

export interface VoiceSessionStats {
	discordInputAudioEventCount: number;
	discordInputMaxConcurrentSpeakers: number;
	decodedVideoFrameCount: number;
	realtimeSessionUpdatedCount: number;
	realtimeAudioDeltaCount: number;
	realtimeFunctionCallCount: number;
	realtimeErrorEventCount: number;
	realtimeSocketErrorCount: number;
	realtimeSocketCloseCount: number;
	externalTtsRequestCount: number;
	discordOutputAudioSendCount: number;
	streamWatchConnectCount: number;
	voiceMemoryCaptureCount: number;
	voiceEveSessionSendCount: number;
	voiceEveSessionErrorCount: number;
	voiceEveSessionSpokenResponseCount: number;
}

export interface VoiceSessionStatus {
	realtimeProvider: VoiceRealtimeProvider;
	ttsProvider: VoiceTtsProvider;
	settings: VoiceRuntimeSummary;
	turnBuffer: ReturnType<DiscordVoiceTurnBuffer["status"]>;
	stats: VoiceSessionStats;
}

export interface VoiceSessionConfig {
	guildId: string;
	channelId: string;
	/** Injected Discord voice adapter (a discord.js Guild-like). */
	guild: ClankvoxGuildLike;
	realtime: VoiceRealtimeConfig;
	connect: OpenAiRealtimeConnectOptions;
	externalTts?: VoiceExternalTtsConfig;
	memorySpeaker?: VoiceMemorySpeaker;
	resolveSpeaker?: VoiceSpeakerResolver;
	eveSession?: VoiceEveSessionConfig;
	eveSessionHost?: string;
	memoryContextLimit?: number;
	clankvox?: ClankvoxSpawnOptions;
}

export type VoiceSpeakerResolver = (userId: string) => VoiceMemorySpeaker | undefined;

export interface VoiceSession {
	vox: ClankvoxIpcClient;
	realtime: VoiceRealtimeClient;
	turnBuffer: DiscordVoiceTurnBuffer;
	recordStreamWatchConnect(): void;
	status(): VoiceSessionStatus;
	stop(): Promise<void>;
}

const DEFAULT_VOICE_MEMORY_CONTEXT_LIMIT = 16;

/** Start a live voice session: spawn ClankVox, connect Realtime, bind the bridge. */
export async function startVoiceSession(config: VoiceSessionConfig): Promise<VoiceSession> {
	const vox = await ClankvoxIpcClient.spawn(config.guildId, config.channelId, config.guild, config.clankvox ?? {});
	const realtime = createVoiceRealtimeClient(config.realtime);
	const stats = initialVoiceSessionStats();
	const activeSpeakers = bindDiscordInputStats(vox, stats);
	const speakerTracker = createVoiceTurnSpeakerTracker(config);
	const ttsProvider: VoiceTtsProvider = config.externalTts === undefined ? "realtime" : config.externalTts.provider;
	const ttsBinding =
		config.externalTts === undefined ? bindNativeRealtimeAudioOutput(realtime, vox, stats) : bindExternalTts(config, realtime, vox, stats);
	bindRealtimeStats(realtime, stats);
	const memoryBinding = bindVoiceMemory(config, realtime, stats, speakerTracker);
	const eveSessionBinding = bindVoiceSessionMirror(config, realtime, stats, speakerTracker);
	const turnBuffer = bindClankvoxRealtimeBridge({
		vox,
		realtime,
		onFlushSpeakers(userIds) {
			speakerTracker.recordCommittedTurn(userIds);
		},
		onDecodedVideoFrame() {
			stats.decodedVideoFrameCount += 1;
		},
	});
	await realtime.connect(await buildVoiceConnectOptions(config));

	return {
		vox,
		realtime,
		turnBuffer,
		recordStreamWatchConnect() {
			stats.streamWatchConnectCount += 1;
		},
		status() {
			return {
				realtimeProvider: config.realtime.provider,
				ttsProvider,
				settings: summarizeVoiceRuntimeConfig(config),
				turnBuffer: turnBuffer.status(),
				stats: { ...stats, discordInputMaxConcurrentSpeakers: Math.max(stats.discordInputMaxConcurrentSpeakers, activeSpeakers.size) },
			};
		},
		async stop() {
			eveSessionBinding.dispose();
			memoryBinding.dispose();
			ttsBinding.dispose();
			turnBuffer.dispose();
			await realtime.close();
			await vox.destroy();
		},
	};
}

export function summarizeVoiceRuntimeConfig(config: VoiceRuntimeSummaryInput): VoiceRuntimeSummary {
	const ttsProvider: VoiceTtsProvider = config.externalTts === undefined ? "realtime" : config.externalTts.provider;
	const memoryContextLimit = config.memoryContextLimit ?? DEFAULT_VOICE_MEMORY_CONTEXT_LIMIT;
	const summary: VoiceRuntimeSummary = {
		realtimeProvider: config.realtime.provider,
		realtimeModel: config.connect.model,
		ttsProvider,
		eveSessionEnabled: config.eveSession !== undefined || config.eveSessionHost !== undefined,
		memoryContextEnabled: memoryContextLimit > 0,
		memoryContextLimit,
	};
	if (config.connect.voice.trim().length > 0) summary.realtimeVoice = config.connect.voice;
	if (config.connect.responseOutputModality !== undefined) summary.responseOutputModality = config.connect.responseOutputModality;
	if (config.externalTts !== undefined) {
		summary.elevenLabs = {
			voiceId: config.externalTts.voiceId,
			modelId: config.externalTts.modelId ?? DEFAULT_ELEVENLABS_TTS_MODEL,
			outputFormat: config.externalTts.outputFormat ?? DEFAULT_ELEVENLABS_OUTPUT_FORMAT,
			speed: config.externalTts.speed ?? DEFAULT_ELEVENLABS_SPEED,
		};
	}
	return summary;
}

export function createVoiceRealtimeClient(config: VoiceRealtimeConfig): VoiceRealtimeClient {
	if (config.provider === "xai") {
		return new XAiRealtimeClient({ apiKey: config.apiKey, baseUrl: config.baseUrl });
	}
	return new OpenAiRealtimeClient({ apiKey: config.apiKey, baseUrl: config.baseUrl });
}

export async function buildVoiceConnectOptions(config: VoiceSessionConfig): Promise<OpenAiRealtimeConnectOptions> {
	const limit = config.memoryContextLimit ?? DEFAULT_VOICE_MEMORY_CONTEXT_LIMIT;
	if (limit <= 0) return config.connect;
	const memoryContext = await buildMemoryContext({
		limit,
		discordServerId: config.guildId,
		discordUserId: config.memorySpeaker?.userId,
		discordUserName: config.memorySpeaker?.userName,
		includeMainUser: false,
	});
	if (memoryContext.length === 0) return config.connect;
	return { ...config.connect, instructions: `${config.connect.instructions}\n\n${memoryContext}` };
}

function initialVoiceSessionStats(): VoiceSessionStats {
	return {
		discordInputAudioEventCount: 0,
		discordInputMaxConcurrentSpeakers: 0,
		decodedVideoFrameCount: 0,
		realtimeSessionUpdatedCount: 0,
		realtimeAudioDeltaCount: 0,
		realtimeFunctionCallCount: 0,
		realtimeErrorEventCount: 0,
		realtimeSocketErrorCount: 0,
		realtimeSocketCloseCount: 0,
		externalTtsRequestCount: 0,
		discordOutputAudioSendCount: 0,
		streamWatchConnectCount: 0,
		voiceMemoryCaptureCount: 0,
		voiceEveSessionSendCount: 0,
		voiceEveSessionErrorCount: 0,
		voiceEveSessionSpokenResponseCount: 0,
	};
}

function bindDiscordInputStats(vox: ClankvoxIpcClient, stats: VoiceSessionStats): Set<string> {
	const activeSpeakers = new Set<string>();
	vox.on("speakingStart", (userId: string) => {
		activeSpeakers.add(userId);
		stats.discordInputMaxConcurrentSpeakers = Math.max(stats.discordInputMaxConcurrentSpeakers, activeSpeakers.size);
	});
	vox.on("speakingEnd", (userId: string) => {
		activeSpeakers.delete(userId);
	});
	vox.on("userAudioEnd", (userId: string) => {
		activeSpeakers.delete(userId);
	});
	vox.on("userAudio", () => {
		stats.discordInputAudioEventCount += 1;
	});
	return activeSpeakers;
}

function bindNativeRealtimeAudioOutput(
	realtime: VoiceRealtimeClient,
	vox: ClankvoxIpcClient,
	stats: VoiceSessionStats,
): ExternalTtsOutputBinding {
	realtime.on("audio_delta", (pcmBase64) => {
		stats.realtimeAudioDeltaCount += 1;
		vox.sendAudio(pcmBase64, 24_000);
		stats.discordOutputAudioSendCount += 1;
	});
	return { dispose: () => vox.stopPlayback() };
}

function bindExternalTts(
	config: VoiceSessionConfig,
	realtime: VoiceRealtimeClient,
	vox: ClankvoxIpcClient,
	stats: VoiceSessionStats,
): ExternalTtsOutputBinding {
	const tts = config.externalTts;
	if (tts === undefined) throw new Error("external TTS config is required.");
	return bindExternalTtsOutput({
		realtime,
		tts: new ElevenLabsTtsClient({
			apiKey: tts.apiKey,
			voiceId: tts.voiceId,
			modelId: tts.modelId ?? DEFAULT_ELEVENLABS_TTS_MODEL,
			baseUrl: tts.baseUrl,
			outputFormat: tts.outputFormat ?? DEFAULT_ELEVENLABS_OUTPUT_FORMAT,
			speed: tts.speed ?? DEFAULT_ELEVENLABS_SPEED,
		}),
		playAudio: (chunk) => vox.sendAudio(chunk.pcmBase64, chunk.sampleRate),
		stopPlayback: () => vox.stopTtsPlayback(),
		stats,
	});
}

function bindRealtimeStats(realtime: VoiceRealtimeClient, stats: VoiceSessionStats): void {
	realtime.on("event", (event) => {
		const type = stringValue(event.type);
		if (type === "session.updated") stats.realtimeSessionUpdatedCount += 1;
		if (type.includes("function_call") && type.endsWith(".done")) stats.realtimeFunctionCallCount += 1;
	});
	realtime.on("error_event", () => {
		stats.realtimeErrorEventCount += 1;
	});
	realtime.on("socket_error", () => {
		stats.realtimeSocketErrorCount += 1;
	});
	realtime.on("socket_closed", () => {
		stats.realtimeSocketCloseCount += 1;
	});
}

function bindVoiceMemory(
	config: VoiceSessionConfig,
	realtime: VoiceRealtimeClient,
	stats: VoiceSessionStats,
	speakerTracker: VoiceTurnSpeakerTracker,
): VoiceTranscriptMemoryBinding {
	return bindVoiceTranscriptMemory(
		realtime,
		{
			guildId: config.guildId,
			channelId: config.channelId,
			...(config.memorySpeaker === undefined ? {} : { speaker: config.memorySpeaker }),
			resolveSpeakerContext: speakerTracker.resolveTranscriptSpeakerContext,
		},
		stats,
	);
}

function bindVoiceSessionMirror(
	config: VoiceSessionConfig,
	realtime: VoiceRealtimeClient,
	stats: VoiceSessionStats,
	speakerTracker: VoiceTurnSpeakerTracker,
): VoiceEveSessionBinding {
	const eveSession = resolveVoiceEveSessionConfig(config, speakerTracker);
	if (eveSession === undefined) return { dispose() {} };
	return bindVoiceEveSession({
		realtime,
		config: eveSession,
		stats,
		speakResponse(message) {
			realtime.requestTextUtterance?.(message);
		},
	});
}

function resolveVoiceEveSessionConfig(
	config: VoiceSessionConfig,
	speakerTracker: VoiceTurnSpeakerTracker,
): VoiceEveSessionConfig | undefined {
	if (config.eveSession !== undefined) {
		return {
			...config.eveSession,
			resolveSpeakerContext: config.eveSession.resolveSpeakerContext ?? speakerTracker.resolveTranscriptSpeakerContext,
		};
	}
	if (config.eveSessionHost === undefined) return undefined;
	return {
		host: config.eveSessionHost,
		guildId: config.guildId,
		channelId: config.channelId,
		...(config.memorySpeaker === undefined ? {} : { speaker: config.memorySpeaker }),
		resolveSpeakerContext: speakerTracker.resolveTranscriptSpeakerContext,
	};
}

interface VoiceTurnSpeakerTracker {
	recordCommittedTurn(userIds: readonly string[]): void;
	resolveTranscriptSpeakerContext(transcript: OpenAiRealtimeTranscript): VoiceTranscriptSpeakerContext;
}

function createVoiceTurnSpeakerTracker(config: VoiceSessionConfig): VoiceTurnSpeakerTracker {
	const committedTurns: string[][] = [];
	const contextByTranscript = new WeakMap<OpenAiRealtimeTranscript, VoiceTranscriptSpeakerContext>();
	const contextByItemId = new Map<string, VoiceTranscriptSpeakerContext>();
	return {
		recordCommittedTurn(userIds) {
			// Record every committed turn, including speaker-less ones, so the queue
			// stays 1:1 with input transcripts; an unsynced shift would misattribute
			// a later turn's speakers (and the memory/session writes that follow).
			committedTurns.push(uniqueSorted(userIds));
			while (committedTurns.length > 50) committedTurns.shift();
		},
		resolveTranscriptSpeakerContext(transcript) {
			if (!isVoiceInputTranscript(transcript)) return {};
			const cached = contextByTranscript.get(transcript);
			if (cached !== undefined) return cached;
			if (transcript.itemId !== undefined) {
				const cachedByItem = contextByItemId.get(transcript.itemId);
				if (cachedByItem !== undefined) {
					contextByTranscript.set(transcript, cachedByItem);
					return cachedByItem;
				}
			}
			const speakerUserIds = committedTurns.shift();
			const context = resolveTurnSpeakerContext(config, speakerUserIds ?? []);
			contextByTranscript.set(transcript, context);
			if (transcript.itemId !== undefined) {
				contextByItemId.set(transcript.itemId, context);
				while (contextByItemId.size > 50) {
					const oldest = contextByItemId.keys().next().value;
					if (oldest === undefined) break;
					contextByItemId.delete(oldest);
				}
			}
			return context;
		},
	};
}

function resolveTurnSpeakerContext(
	config: VoiceSessionConfig,
	userIds: readonly string[],
): VoiceTranscriptSpeakerContext {
	const speakerUserIds = uniqueSorted(userIds);
	if (speakerUserIds.length !== 1) return speakerUserIds.length === 0 ? {} : { speakerUserIds };
	const userId = speakerUserIds[0];
	if (userId === undefined) return {};
	return {
		speaker: resolveVoiceSpeaker(config, userId),
		speakerUserIds,
	};
}

function resolveVoiceSpeaker(config: VoiceSessionConfig, userId: string): VoiceMemorySpeaker {
	const resolved = config.resolveSpeaker?.(userId);
	if (resolved !== undefined) return resolved;
	if (config.memorySpeaker?.userId === userId) return config.memorySpeaker;
	return { userId };
}

function uniqueSorted(values: readonly string[]): string[] {
	return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))].sort();
}
