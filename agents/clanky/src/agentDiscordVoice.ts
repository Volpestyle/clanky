import { appendFile } from "node:fs/promises";
import type { DiscordGatewayClient } from "@agentroom/chat-discord";
import {
	type ClankySubagentState,
	type ClankySubagentSummary,
	type DiscordSubagentStore,
	resolveElevenLabsApiKeySync,
	resolveOpenAiApiKeySync,
} from "@clanky/core";
import type {
	AgentSessionEvent,
	AgentSessionRuntime,
	AuthStorage,
	CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";
import { type ClankyAgentDiscordGatewayConfig, resolveAgentDiscordCredentialConfig } from "./agentDiscordGateway.ts";
import type { ClankyThinkingLevel } from "./clankyDefaults.ts";
import type { DiscordVoiceTtsProvider, StoredDiscordVoiceSettings } from "./discordVoiceSettings.ts";
import { DiscordVoiceSubagentCoordinator } from "./discordVoiceSubagentCoordinator.ts";
import { DEFAULT_DISCORD_WAKE_NAMES, dedupeWakeNames, parseDiscordWakeNamesFromEnv } from "./discordWakeNames.ts";
import { type RuntimeTurnQueue, SerialRuntimeTurnQueue } from "./runtimeTurnQueue.ts";
import {
	type ClankvoxDecodedVideoFrame,
	type ClankvoxGuildLike,
	ClankvoxIpcClient,
	type ClankvoxSpawnOptions,
	type ClankvoxTransportState,
} from "./voice/clankvoxIpcClient.ts";
import type { ClankvoxRealtimeBridgeRealtime, ClankvoxRealtimeBridgeVox } from "./voice/clankvoxRealtimeBridge.ts";
import {
	createDiscordStreamDiscovery,
	type DiscordRawGatewayClient,
	type DiscordStreamDiscovery,
	type DiscoveredDiscordStream,
	deriveDiscordStreamWatchDaveChannelId,
} from "./voice/discordStreamDiscovery.ts";
import {
	type DiscordVoiceSpeakerTranscript,
	DiscordVoiceSpeakerTranscriptionManager,
	type DiscordVoiceSpeakerTranscriptionRealtime,
} from "./voice/discordVoiceSpeakerTranscription.ts";
import {
	DEFAULT_ELEVENLABS_OUTPUT_FORMAT,
	DEFAULT_ELEVENLABS_TTS_MODEL,
	type ElevenLabsPcmOutputFormat,
	type ElevenLabsTtsAudioChunk,
	ElevenLabsTtsClient,
	parseElevenLabsPcmOutputFormat,
} from "./voice/elevenLabsTtsClient.ts";
import {
	OpenAiRealtimeClient,
	type OpenAiRealtimeClientOptions,
	type OpenAiRealtimeConnectOptions,
	type OpenAiRealtimeReasoningEffort,
	type OpenAiRealtimeTool,
	type OpenAiRealtimeTranscript,
	OpenAiRealtimeTranscriptionClient,
	type OpenAiRealtimeTranscriptionConnectOptions,
	type OpenAiRealtimeTranscriptionDelay,
} from "./voice/openAiRealtimeClient.ts";
import type { VoiceSupervisorDelegateHandle } from "./voiceSupervisorExtension.ts";

type JsonRecord = Record<string, unknown>;
type TimerHandle = ReturnType<typeof setTimeout>;
type VoicePiDelegationTarget = "main-runtime" | "voice-worker";

export interface ClankyAgentDiscordVoiceConfig {
	enabled: boolean;
	guildId?: string;
	channelId?: string;
	allowedGuildIds?: string[];
	allowedChannelIds?: string[];
	wakeNames?: string[];
	ttsProvider?: DiscordVoiceTtsProvider;
	openAiApiKey: string;
	openAiBaseUrl?: string;
	openAiRealtimeModel: string;
	openAiRealtimeVoice: string;
	openAiRealtimeReasoningEffort?: OpenAiRealtimeReasoningEffort;
	elevenLabsApiKey?: string;
	elevenLabsBaseUrl?: string;
	elevenLabsVoiceId?: string;
	elevenLabsModel?: string;
	elevenLabsOutputFormat?: ElevenLabsPcmOutputFormat;
	openAiRealtimeTranscriptionModel?: string;
	openAiRealtimeTranscriptionDelay?: OpenAiRealtimeTranscriptionDelay;
	openAiRealtimeTranscriptionLanguage?: string;
	speakerTranscriptionIdleCloseMs?: number;
	transcriptResponseBatchDelayMs?: number;
	clankvoxBin?: string;
	clankvoxDir?: string;
	videoFrameAutoAttachIntervalMs?: number;
}

type FixedClankyAgentDiscordVoiceConfig = ClankyAgentDiscordVoiceConfig & {
	guildId: string;
	channelId: string;
};

export interface StartAgentDiscordVoiceBridgeInput {
	runtime: AgentSessionRuntime;
	client: DiscordGatewayClient;
	discordConfig: ClankyAgentDiscordGatewayConfig;
	authStorage?: AuthStorage;
	config?: ClankyAgentDiscordVoiceConfig;
	runtimeTurnQueue?: RuntimeTurnQueue;
	createSubagentRuntime?: CreateAgentSessionRuntimeFactory;
	createVoiceSubagentRuntime?: CreateAgentSessionRuntimeFactory;
	subagentStore?: DiscordSubagentStore;
	subagentSessionDir?: string;
	subagentCwd?: string;
	voiceSupervisorDelegate?: VoiceSupervisorDelegateHandle;
	bridgeLogPath?: string;
	voiceLogPath?: string;
	dependencies?: ClankyAgentDiscordVoiceDependencies;
}

export interface ClankyAgentDiscordVoiceHandle {
	stop(): Promise<void>;
	status(): JsonRecord;
	requestTextUtterance(text: string): void;
	setSubagentThinkingLevel?(level: ClankyThinkingLevel): number;
}

interface DiscordVoiceClient extends DiscordGatewayClient {
	guilds: {
		cache: { get(id: string): unknown };
		fetch(id: string): Promise<unknown>;
	};
}

interface PendingRealtimeToolCall {
	callId: string;
	name: string;
	argumentsJson: string;
}

interface RecentRealtimeToolResult {
	result: unknown;
	expiresAtMs: number;
}

interface VoiceBridgeStats {
	speakingStartCount: number;
	speakingEndCount: number;
	discordInputUniqueSpeakerCount: number;
	discordInputMaxConcurrentSpeakers: number;
	discordInputGroupOverlapCount: number;
	discordInputAudioEventCount: number;
	discordInputAudioBytes: number;
	discordInputAudioEndCount: number;
	voiceBargeInAcceptedCount: number;
	voiceBargeInSuppressedCount: number;
	realtimeAudioDeltaCount: number;
	realtimeAudioDeltaBytes: number;
	discordOutputAudioSendCount: number;
	discordOutputAudioDropCount: number;
	realtimeEventCount: number;
	realtimeSessionCreatedCount: number;
	realtimeSessionUpdatedCount: number;
	realtimeErrorEventCount: number;
	realtimeSocketCloseCount: number;
	realtimeSocketErrorCount: number;
	realtimeTranscriptCount: number;
	realtimeFunctionCallCount: number;
	realtimeFunctionCallOutputCount: number;
	realtimeFunctionCallErrorCount: number;
	speakerTranscriptDeltaCount: number;
	speakerTranscriptFinalCount: number;
	speakerTranscriptForwardCount: number;
	speakerTranscriptionErrorCount: number;
	speakerTranscriptionSocketCloseCount: number;
	askPiCallCount: number;
	piStatusRequestCount: number;
	piSubagentStatusRequestCount: number;
	screenShareListCount: number;
	screenWatchRequestCount: number;
	screenWatchUnsupportedCount: number;
	screenWatchSuccessCount: number;
	screenWatchMissCount: number;
	screenWatchStopCount: number;
	streamWatchConnectCount: number;
	streamWatchDisconnectCount: number;
	decodedVideoFrameCount: number;
	snapshotRequestCount: number;
	snapshotSuccessCount: number;
	videoFrameAttachCount: number;
	videoFrameAutoAttachSkipCount: number;
	externalTtsRequestCount: number;
	externalTtsAudioBytes: number;
	externalTtsErrorCount: number;
	musicPlayRequestCount: number;
	musicPauseRequestCount: number;
	musicResumeRequestCount: number;
	musicStopRequestCount: number;
	musicErrorCount: number;
	streamPublishRequestCount: number;
	streamPublishUnsupportedCount: number;
	streamPublishConnectCount: number;
	streamPublishDisconnectCount: number;
	streamPublishStopCount: number;
	streamPublishTransportEventCount: number;
}

export interface ClankyAgentDiscordVoiceDependencies {
	createRealtime?(options: OpenAiRealtimeClientOptions): VoiceRealtimeClientLike;
	createTranscriptionRealtime?(options: OpenAiRealtimeClientOptions): DiscordVoiceSpeakerTranscriptionRealtime;
	spawnVox?(
		guildId: string,
		channelId: string,
		guild: ClankvoxGuildLike,
		options: ClankvoxSpawnOptions,
	): Promise<VoiceVoxClientLike>;
	createStreamDiscovery?(
		client: DiscordRawGatewayClient,
		hooks: Parameters<typeof createDiscordStreamDiscovery>[1],
	): DiscordStreamDiscovery;
	createSpeechSynthesizer?(config: FixedClankyAgentDiscordVoiceConfig): VoiceSpeechSynthesizerLike | undefined;
}

interface VoiceRealtimeClientLike extends ClankvoxRealtimeBridgeRealtime {
	connect(options: OpenAiRealtimeConnectOptions): Promise<void>;
	close(): Promise<void>;
	requestTextUtterance(text: string): void;
	sendFunctionCallOutput(input: { callId: string; output: unknown }): void;
	cancelResponse(): void;
	on(event: "audio_delta", listener: (pcmBase64: string) => void): unknown;
	on(event: "socket_closed", listener: (event: JsonRecord) => void): unknown;
	on(event: "socket_error", listener: (error: Error) => void): unknown;
	on(event: "transcript", listener: (transcript: OpenAiRealtimeTranscript) => void): unknown;
	on(event: "event" | "error_event", listener: (event: JsonRecord) => void): unknown;
}

interface VoiceVoxClientLike extends ClankvoxRealtimeBridgeVox {
	readonly isAlive: boolean;
	on(event: "speakingStart" | "speakingEnd" | "userAudioEnd", listener: (userId: string) => void): unknown;
	on(event: "userAudio", listener: (userId: string, pcm: Buffer) => void): unknown;
	on(event: "decodedVideoFrame", listener: (frame: ClankvoxDecodedVideoFrame) => void): unknown;
	on(event: "ipcError", listener: (event: JsonRecord) => void): unknown;
	on(event: "transportState", listener: (state: ClankvoxTransportState) => void): unknown;
	on(event: "playerState", listener: (status: string) => void): unknown;
	on(event: "musicIdle", listener: () => void): unknown;
	on(event: "musicError", listener: (message: string) => void): unknown;
	on(event: "musicGainReached", listener: (gain: number) => void): unknown;
	on(event: "bufferDepth", listener: (ttsSamples: number, musicSamples: number) => void): unknown;
	sendAudio(pcmBase64: string, sampleRate?: number): void;
	stopPlayback(): void;
	stopTtsPlayback(): void;
	subscribeUserVideo(input: {
		userId: string;
		maxFramesPerSecond?: number;
		preferredQuality?: number;
		preferredPixelCount?: number | null;
		preferredStreamType?: string | null;
		jpegQuality?: number | null;
	}): void;
	unsubscribeUserVideo(userId: string): void;
	streamWatchConnect(input: {
		endpoint: string;
		token: string;
		serverId: string;
		sessionId: string;
		userId: string;
		daveChannelId: string;
	}): void;
	streamWatchDisconnect(reason?: string | null): void;
	streamPublishConnect(input: {
		endpoint: string;
		token: string;
		serverId: string;
		sessionId: string;
		userId: string;
		daveChannelId: string;
	}): void;
	streamPublishDisconnect(reason?: string | null): void;
	musicPlay(url: string, resolvedDirectUrl?: boolean): void;
	musicStop(): void;
	musicPause(): void;
	musicResume(): void;
	musicSetGain(target: number, fadeMs: number): void;
	streamPublishPlay(url: string, resolvedDirectUrl?: boolean): void;
	streamPublishPlayVisualizer(url: string, resolvedDirectUrl?: boolean, visualizerMode?: string): void;
	streamPublishStop(): void;
	streamPublishPause(): void;
	streamPublishResume(): void;
	getLastVoiceSessionId(): string | undefined;
	destroy(): Promise<void>;
}

interface VoiceSpeechSynthesizerLike {
	synthesize(
		text: string,
		onAudio: (chunk: ElevenLabsTtsAudioChunk) => void,
		options?: VoiceSpeechSynthesisOptions,
	): Promise<void>;
	dispose?(): Promise<void> | void;
	status?(): JsonRecord;
}

interface VoiceSpeechSynthesisOptions {
	signal?: AbortSignal;
}

type VoiceMusicStatus = "idle" | "loading" | "playing" | "paused" | "error";
type VoiceStreamPublishSourceKind = "video_url" | "music_visualizer";

interface VoiceStreamPublishState {
	active: boolean;
	paused: boolean;
	streamKey?: string;
	sourceKind?: VoiceStreamPublishSourceKind;
	sourceUrl?: string;
	visualizerMode?: string;
	status?: string;
	reason?: string | null;
	lastRequestedAt?: number;
	lastConnectedAt?: number;
}

interface SpeakerTranscriptLine {
	userId: string;
	displayName: string;
	text: string;
	interruptedAssistant?: boolean;
}

interface ResolvedVoiceDependencies {
	createRealtime(options: OpenAiRealtimeClientOptions): VoiceRealtimeClientLike;
	createTranscriptionRealtime(options: OpenAiRealtimeClientOptions): DiscordVoiceSpeakerTranscriptionRealtime;
	spawnVox(
		guildId: string,
		channelId: string,
		guild: ClankvoxGuildLike,
		options: ClankvoxSpawnOptions,
	): Promise<VoiceVoxClientLike>;
	createStreamDiscovery(
		client: DiscordRawGatewayClient,
		hooks: Parameters<typeof createDiscordStreamDiscovery>[1],
	): DiscordStreamDiscovery;
	createSpeechSynthesizer(config: FixedClankyAgentDiscordVoiceConfig): VoiceSpeechSynthesizerLike | undefined;
}

export const DEFAULT_REALTIME_MODEL = "gpt-realtime-2";
const DEFAULT_REALTIME_VOICE = "marin";
const DEFAULT_REALTIME_REASONING_EFFORT: OpenAiRealtimeReasoningEffort = "low";
const DEFAULT_REALTIME_TRANSCRIPTION_MODEL = "gpt-realtime-whisper";
const DEFAULT_REALTIME_TRANSCRIPTION_DELAY: OpenAiRealtimeTranscriptionDelay = "low";
const DEFAULT_VIDEO_FRAME_AUTO_ATTACH_INTERVAL_MS = 2_000;
const DEFAULT_SPEAKER_TRANSCRIPTION_IDLE_CLOSE_MS = 120_000;
const DEFAULT_TRANSCRIPT_RESPONSE_BATCH_DELAY_MS = 350;
const REALTIME_TOOL_RESPONSE_DEBOUNCE_MS = 25;
const REALTIME_DUPLICATE_TOOL_RESULT_CACHE_MS = 5_000;
const PI_TOOL_TIMEOUT_MS = 120_000;
const DEFAULT_VOICE_BARGE_IN_WAKE_WORDS = DEFAULT_DISCORD_WAKE_NAMES;
const PRIMARY_WAKE_TOKEN_MIN_LEN = 4;
const EN_WAKE_PRIMARY_GENERIC_TOKENS = new Set(["bot", "ai", "assistant"]);
const LEADING_WAKE_PREFIX_TOKENS = new Set(["yo", "hey", "hi", "hello", "ok", "okay", "uh", "um", "uhh", "umm"]);

function createVoiceBridgeStats(): VoiceBridgeStats {
	return {
		speakingStartCount: 0,
		speakingEndCount: 0,
		discordInputUniqueSpeakerCount: 0,
		discordInputMaxConcurrentSpeakers: 0,
		discordInputGroupOverlapCount: 0,
		discordInputAudioEventCount: 0,
		discordInputAudioBytes: 0,
		discordInputAudioEndCount: 0,
		voiceBargeInAcceptedCount: 0,
		voiceBargeInSuppressedCount: 0,
		realtimeAudioDeltaCount: 0,
		realtimeAudioDeltaBytes: 0,
		discordOutputAudioSendCount: 0,
		discordOutputAudioDropCount: 0,
		realtimeEventCount: 0,
		realtimeSessionCreatedCount: 0,
		realtimeSessionUpdatedCount: 0,
		realtimeErrorEventCount: 0,
		realtimeSocketCloseCount: 0,
		realtimeSocketErrorCount: 0,
		realtimeTranscriptCount: 0,
		realtimeFunctionCallCount: 0,
		realtimeFunctionCallOutputCount: 0,
		realtimeFunctionCallErrorCount: 0,
		speakerTranscriptDeltaCount: 0,
		speakerTranscriptFinalCount: 0,
		speakerTranscriptForwardCount: 0,
		speakerTranscriptionErrorCount: 0,
		speakerTranscriptionSocketCloseCount: 0,
		askPiCallCount: 0,
		piStatusRequestCount: 0,
		piSubagentStatusRequestCount: 0,
		screenShareListCount: 0,
		screenWatchRequestCount: 0,
		screenWatchUnsupportedCount: 0,
		screenWatchSuccessCount: 0,
		screenWatchMissCount: 0,
		screenWatchStopCount: 0,
		streamWatchConnectCount: 0,
		streamWatchDisconnectCount: 0,
		decodedVideoFrameCount: 0,
		snapshotRequestCount: 0,
		snapshotSuccessCount: 0,
		videoFrameAttachCount: 0,
		videoFrameAutoAttachSkipCount: 0,
		musicPlayRequestCount: 0,
		musicPauseRequestCount: 0,
		musicResumeRequestCount: 0,
		musicStopRequestCount: 0,
		musicErrorCount: 0,
		streamPublishRequestCount: 0,
		streamPublishUnsupportedCount: 0,
		streamPublishConnectCount: 0,
		streamPublishDisconnectCount: 0,
		streamPublishStopCount: 0,
		streamPublishTransportEventCount: 0,
		externalTtsRequestCount: 0,
		externalTtsAudioBytes: 0,
		externalTtsErrorCount: 0,
	};
}

function resolveVoiceDependencies(
	dependencies: ClankyAgentDiscordVoiceDependencies | undefined,
): ResolvedVoiceDependencies {
	return {
		createRealtime: dependencies?.createRealtime ?? ((options) => new OpenAiRealtimeClient(options)),
		createTranscriptionRealtime:
			dependencies?.createTranscriptionRealtime ?? ((options) => new OpenAiRealtimeTranscriptionClient(options)),
		spawnVox:
			dependencies?.spawnVox ??
			((guildId, channelId, guild, options) => ClankvoxIpcClient.spawn(guildId, channelId, guild, options)),
		createStreamDiscovery: dependencies?.createStreamDiscovery ?? createDiscordStreamDiscovery,
		createSpeechSynthesizer: dependencies?.createSpeechSynthesizer ?? createDefaultSpeechSynthesizer,
	};
}

function createDefaultSpeechSynthesizer(
	config: FixedClankyAgentDiscordVoiceConfig,
): VoiceSpeechSynthesizerLike | undefined {
	if ((config.ttsProvider ?? "openai") !== "elevenlabs") return undefined;
	if (config.elevenLabsApiKey === undefined) {
		throw new Error("Run /elevenlabs-login or set ELEVENLABS_API_KEY for ElevenLabs speech.");
	}
	if (config.elevenLabsVoiceId === undefined)
		throw new Error("An ElevenLabs voice id is required for ElevenLabs speech.");
	const options: ConstructorParameters<typeof ElevenLabsTtsClient>[0] = {
		apiKey: config.elevenLabsApiKey,
		voiceId: config.elevenLabsVoiceId,
		modelId: config.elevenLabsModel ?? DEFAULT_ELEVENLABS_TTS_MODEL,
		outputFormat: config.elevenLabsOutputFormat ?? DEFAULT_ELEVENLABS_OUTPUT_FORMAT,
	};
	if (config.elevenLabsBaseUrl !== undefined) options.baseUrl = config.elevenLabsBaseUrl;
	return new ElevenLabsTtsClient(options);
}

export function resolveAgentDiscordVoiceConfig(
	env: NodeJS.ProcessEnv = process.env,
	discordConfig?: ClankyAgentDiscordGatewayConfig,
	authStorage?: AuthStorage,
	storedSettings?: StoredDiscordVoiceSettings,
): ClankyAgentDiscordVoiceConfig | undefined {
	const enabledOverride = parseOptionalEnabled(env.CLANKY_DISCORD_VOICE_ENABLED ?? env.CLANKY_DISCORD_VOICE);
	if (!(enabledOverride ?? storedSettings?.enabled === true)) return undefined;
	const config = discordConfig ?? resolveAgentDiscordCredentialConfig(env);
	if (config === undefined) {
		throw new Error(
			"CLANKY_DISCORD_TOKEN or a stored /discord-login credential is required when Discord voice is enabled.",
		);
	}
	const guildId = cleanOptionalString(env.CLANKY_DISCORD_VOICE_GUILD_ID) ?? storedSettings?.guildId;
	const channelId = cleanOptionalString(env.CLANKY_DISCORD_VOICE_CHANNEL_ID) ?? storedSettings?.channelId;
	const allowedGuildIds =
		parseOptionalStringList(env.CLANKY_DISCORD_VOICE_ALLOWED_GUILD_IDS) ?? storedSettings?.allowedGuildIds;
	const allowedChannelIds =
		parseOptionalStringList(env.CLANKY_DISCORD_VOICE_ALLOWED_CHANNEL_IDS) ?? storedSettings?.allowedChannelIds;
	const wakeNames = parseDiscordWakeNamesFromEnv(env);
	const ttsProvider =
		parseDiscordVoiceTtsProvider(env.CLANKY_DISCORD_VOICE_TTS_PROVIDER ?? env.CLANKY_VOICE_TTS_PROVIDER) ??
		storedSettings?.ttsProvider ??
		"openai";
	const openAiApiKey = resolveOpenAiApiKeySync(env, authStorage);
	if (openAiApiKey === undefined) {
		throw new Error(
			"OpenAI credentials are required when Discord voice is enabled. Run /openai-login or set OPENAI_API_KEY/CLANKY_OPENAI_API_KEY.",
		);
	}
	const model =
		cleanOptionalString(env.CLANKY_OPENAI_REALTIME_MODEL) ??
		storedSettings?.openAiRealtimeModel ??
		DEFAULT_REALTIME_MODEL;
	const voiceConfig: ClankyAgentDiscordVoiceConfig = {
		enabled: true,
		ttsProvider,
		openAiApiKey: openAiApiKey.value,
		openAiRealtimeModel: model,
		openAiRealtimeVoice:
			cleanOptionalString(env.CLANKY_OPENAI_REALTIME_VOICE) ??
			storedSettings?.openAiRealtimeVoice ??
			DEFAULT_REALTIME_VOICE,
		openAiRealtimeTranscriptionModel:
			cleanOptionalString(env.CLANKY_OPENAI_REALTIME_TRANSCRIPTION_MODEL) ?? DEFAULT_REALTIME_TRANSCRIPTION_MODEL,
		openAiRealtimeTranscriptionDelay:
			parseRealtimeTranscriptionDelay(env.CLANKY_OPENAI_REALTIME_TRANSCRIPTION_DELAY) ??
			DEFAULT_REALTIME_TRANSCRIPTION_DELAY,
		videoFrameAutoAttachIntervalMs:
			parseOptionalNonNegativeInteger(env.CLANKY_DISCORD_VOICE_VIDEO_FRAME_INTERVAL_MS) ??
			storedSettings?.videoFrameAutoAttachIntervalMs ??
			DEFAULT_VIDEO_FRAME_AUTO_ATTACH_INTERVAL_MS,
	};
	if (guildId !== undefined && guildId.length > 0) voiceConfig.guildId = guildId;
	if (channelId !== undefined && channelId.length > 0) voiceConfig.channelId = channelId;
	if (allowedGuildIds !== undefined && allowedGuildIds.length > 0) {
		voiceConfig.allowedGuildIds = dedupeNonEmptyStrings(allowedGuildIds);
	}
	if (allowedChannelIds !== undefined && allowedChannelIds.length > 0) {
		voiceConfig.allowedChannelIds = dedupeNonEmptyStrings(allowedChannelIds);
	}
	if (wakeNames.length > 0) {
		voiceConfig.wakeNames = wakeNames;
	}
	if (ttsProvider === "elevenlabs") {
		const elevenLabsApiKey = resolveElevenLabsApiKeySync(env, authStorage);
		if (elevenLabsApiKey === undefined) {
			throw new Error(
				"ElevenLabs credentials are required for ElevenLabs Discord voice. Run /elevenlabs-login or set ELEVENLABS_API_KEY/CLANKY_ELEVENLABS_API_KEY.",
			);
		}
		const elevenLabsVoiceId = cleanOptionalString(env.CLANKY_ELEVENLABS_VOICE_ID) ?? storedSettings?.elevenLabsVoiceId;
		if (elevenLabsVoiceId === undefined) {
			throw new Error(
				"An ElevenLabs voice id is required for ElevenLabs Discord voice. Set CLANKY_ELEVENLABS_VOICE_ID or configure /discord-voice advanced settings.",
			);
		}
		voiceConfig.elevenLabsApiKey = elevenLabsApiKey.value;
		voiceConfig.elevenLabsVoiceId = elevenLabsVoiceId;
		voiceConfig.elevenLabsModel =
			cleanOptionalString(env.CLANKY_ELEVENLABS_MODEL) ??
			storedSettings?.elevenLabsModel ??
			DEFAULT_ELEVENLABS_TTS_MODEL;
		voiceConfig.elevenLabsOutputFormat =
			parseElevenLabsPcmOutputFormat(env.CLANKY_ELEVENLABS_OUTPUT_FORMAT) ??
			storedSettings?.elevenLabsOutputFormat ??
			DEFAULT_ELEVENLABS_OUTPUT_FORMAT;
		const elevenLabsBaseUrl =
			cleanOptionalString(env.CLANKY_ELEVENLABS_BASE_URL) ??
			cleanOptionalString(env.ELEVENLABS_BASE_URL) ??
			storedSettings?.elevenLabsBaseUrl;
		if (elevenLabsBaseUrl !== undefined) voiceConfig.elevenLabsBaseUrl = elevenLabsBaseUrl;
	}
	const transcriptionLanguage = cleanOptionalString(env.CLANKY_OPENAI_REALTIME_TRANSCRIPTION_LANGUAGE);
	if (transcriptionLanguage !== undefined) voiceConfig.openAiRealtimeTranscriptionLanguage = transcriptionLanguage;
	const speakerTranscriptionIdleCloseMs = parseOptionalPositiveInteger(
		env.CLANKY_DISCORD_VOICE_SPEAKER_TRANSCRIPTION_IDLE_CLOSE_MS,
	);
	if (speakerTranscriptionIdleCloseMs !== undefined) {
		voiceConfig.speakerTranscriptionIdleCloseMs = speakerTranscriptionIdleCloseMs;
	}
	const transcriptResponseBatchDelayMs = parseOptionalNonNegativeInteger(
		env.CLANKY_DISCORD_VOICE_TRANSCRIPT_RESPONSE_BATCH_DELAY_MS,
	);
	if (transcriptResponseBatchDelayMs !== undefined) {
		voiceConfig.transcriptResponseBatchDelayMs = transcriptResponseBatchDelayMs;
	}
	const reasoningEffort =
		parseRealtimeReasoningEffort(env.CLANKY_OPENAI_REALTIME_REASONING_EFFORT) ??
		storedSettings?.openAiRealtimeReasoningEffort;
	if (reasoningEffort !== undefined) {
		voiceConfig.openAiRealtimeReasoningEffort = reasoningEffort;
	} else if (model === DEFAULT_REALTIME_MODEL) {
		voiceConfig.openAiRealtimeReasoningEffort = DEFAULT_REALTIME_REASONING_EFFORT;
	}
	const baseUrl = env.CLANKY_OPENAI_BASE_URL?.trim() || env.OPENAI_BASE_URL?.trim();
	if (baseUrl !== undefined && baseUrl.length > 0) voiceConfig.openAiBaseUrl = baseUrl;
	const clankvoxBin = env.CLANKY_CLANKVOX_BIN?.trim();
	if (clankvoxBin !== undefined && clankvoxBin.length > 0) voiceConfig.clankvoxBin = clankvoxBin;
	const clankvoxDir = env.CLANKY_CLANKVOX_DIR?.trim();
	if (clankvoxDir !== undefined && clankvoxDir.length > 0) voiceConfig.clankvoxDir = clankvoxDir;
	return voiceConfig;
}

export async function startAgentDiscordVoiceBridge(
	input: StartAgentDiscordVoiceBridgeInput,
): Promise<ClankyAgentDiscordVoiceHandle | undefined> {
	const config = input.config ?? resolveAgentDiscordVoiceConfig(process.env, input.discordConfig, input.authStorage);
	if (config === undefined || !config.enabled) return undefined;
	if (!hasFixedVoiceTarget(config)) {
		return new AgentDiscordVoiceDynamicHandle(config, input.discordConfig);
	}
	assertVoiceTargetAllowed(config);
	const subagents =
		input.createSubagentRuntime !== undefined &&
		input.subagentStore !== undefined &&
		input.subagentSessionDir !== undefined
			? new DiscordVoiceSubagentCoordinator({
					store: input.subagentStore,
					createRuntime: input.createVoiceSubagentRuntime ?? input.createSubagentRuntime,
					createGeneralRuntime: input.createSubagentRuntime,
					agentDir: input.runtime.services.agentDir,
					cwd: input.subagentCwd ?? input.runtime.cwd,
					sessionDir: input.subagentSessionDir,
					guildId: config.guildId,
					channelId: config.channelId,
					model: config.openAiRealtimeModel,
					voice: config.openAiRealtimeVoice,
					...(config.openAiRealtimeReasoningEffort === undefined
						? {}
						: { reasoningEffort: config.openAiRealtimeReasoningEffort }),
					...(input.bridgeLogPath === undefined ? {} : { bridgeLogPath: input.bridgeLogPath }),
					...(input.voiceSupervisorDelegate === undefined
						? {}
						: { voiceSupervisorDelegate: input.voiceSupervisorDelegate }),
				})
			: undefined;
	const bridge = new AgentDiscordVoiceBridge(
		input.runtime,
		input.client as DiscordVoiceClient,
		input.discordConfig,
		config,
		input.runtimeTurnQueue ?? new SerialRuntimeTurnQueue(),
		resolveVoiceDependencies(input.dependencies),
		subagents,
		input.subagentStore,
		input.voiceLogPath,
	);
	await bridge.start();
	return bridge;
}

function hasFixedVoiceTarget(config: ClankyAgentDiscordVoiceConfig): config is FixedClankyAgentDiscordVoiceConfig {
	return (
		typeof config.guildId === "string" &&
		config.guildId.length > 0 &&
		typeof config.channelId === "string" &&
		config.channelId.length > 0
	);
}

function assertVoiceTargetAllowed(config: FixedClankyAgentDiscordVoiceConfig): void {
	if (
		config.allowedGuildIds !== undefined &&
		config.allowedGuildIds.length > 0 &&
		!config.allowedGuildIds.includes(config.guildId)
	) {
		throw new Error(`Discord voice guild ${config.guildId} is not in the allowed server list.`);
	}
	if (config.allowedChannelIds === undefined || config.allowedChannelIds.length === 0) return;
	if (config.allowedChannelIds.includes(config.channelId)) return;
	throw new Error(`Discord voice channel ${config.channelId} is not in the allowed voice channel list.`);
}

class AgentDiscordVoiceDynamicHandle implements ClankyAgentDiscordVoiceHandle {
	private readonly config: ClankyAgentDiscordVoiceConfig;
	private readonly discordConfig: ClankyAgentDiscordGatewayConfig;

	constructor(config: ClankyAgentDiscordVoiceConfig, discordConfig: ClankyAgentDiscordGatewayConfig) {
		this.config = config;
		this.discordConfig = discordConfig;
	}

	async stop(): Promise<void> {}

	requestTextUtterance(_text: string): void {
		throw new Error("Discord voice is enabled, but Clanky has not joined a voice channel.");
	}

	setSubagentThinkingLevel(_level: ClankyThinkingLevel): number {
		return 0;
	}

	status(): JsonRecord {
		return {
			active: false,
			enabled: this.config.enabled,
			mode: "dynamic",
			guildId: this.config.guildId,
			channelId: this.config.channelId,
			allowedGuildIds: this.config.allowedGuildIds ?? [],
			allowedChannelIds: this.config.allowedChannelIds ?? [],
			wakeNames: resolveVoiceBargeInWakeWords(this.config),
			ttsProvider: this.config.ttsProvider ?? "openai",
			model: this.config.openAiRealtimeModel,
			voice: this.config.openAiRealtimeVoice,
			elevenLabsVoiceId: this.config.elevenLabsVoiceId,
			elevenLabsModel: this.config.elevenLabsModel,
			elevenLabsOutputFormat: this.config.elevenLabsOutputFormat,
			elevenLabsBaseUrl: this.config.elevenLabsBaseUrl,
			reasoningEffort: this.config.openAiRealtimeReasoningEffort,
			interruptionPolicy: "while-speaking-requires-clanky",
			transcriptionModel: this.config.openAiRealtimeTranscriptionModel ?? DEFAULT_REALTIME_TRANSCRIPTION_MODEL,
			transcriptionDelay: this.config.openAiRealtimeTranscriptionDelay,
			transcriptionLanguage: this.config.openAiRealtimeTranscriptionLanguage,
			discordCredentialKind: this.discordConfig.credentialKind,
			nativeScreenWatchSupported: this.discordConfig.credentialKind === "user-token",
			nativeStreamPublishSupported: this.discordConfig.credentialKind === "user-token",
			hasVox: false,
		};
	}
}

class AgentDiscordVoiceBridge implements ClankyAgentDiscordVoiceHandle {
	private readonly runtime: AgentSessionRuntime;
	private readonly client: DiscordVoiceClient;
	private readonly discordConfig: ClankyAgentDiscordGatewayConfig;
	private readonly config: FixedClankyAgentDiscordVoiceConfig;
	private readonly runtimeTurnQueue: RuntimeTurnQueue;
	private readonly dependencies: ResolvedVoiceDependencies;
	private readonly subagents: DiscordVoiceSubagentCoordinator | undefined;
	private readonly subagentStore: DiscordSubagentStore | undefined;
	private readonly voiceLogPath: string | undefined;
	private realtime: VoiceRealtimeClientLike | undefined;
	private vox: VoiceVoxClientLike | undefined;
	private speechSynthesizer: VoiceSpeechSynthesizerLike | undefined;
	private streamDiscovery: DiscordStreamDiscovery | undefined;
	private speakerTranscription: DiscordVoiceSpeakerTranscriptionManager | undefined;
	private guild: ClankvoxGuildLike | undefined;
	private latestFrame: ClankvoxDecodedVideoFrame | undefined;
	private requestedStreamWatchKey: string | undefined;
	private activeStreamWatchKey: string | undefined;
	private activeVideoUserId: string | undefined;
	private lastVideoFrameAttachedAt = 0;
	private musicStatus: VoiceMusicStatus = "idle";
	private musicUrl: string | undefined;
	private musicResolvedDirectUrl = false;
	private musicLastError: string | undefined;
	private musicGain = 1;
	private mediaBufferDepth: { ttsSamples: number; musicSamples: number } = { ttsSamples: 0, musicSamples: 0 };
	private streamPublish: VoiceStreamPublishState = { active: false, paused: false };
	private readonly activeSpeakingUserIds = new Set<string>();
	private readonly seenInputSpeakerIds = new Set<string>();
	private readonly pendingToolCalls = new Map<string, PendingRealtimeToolCall>();
	private readonly inFlightToolResults = new Map<string, Promise<unknown>>();
	private readonly recentToolResults = new Map<string, RecentRealtimeToolResult>();
	private readonly pendingRealtimeOutputText = new Map<string, string>();
	private readonly completedToolCallIds: string[] = [];
	private readonly completedToolCallIdSet = new Set<string>();
	private readonly pendingSpeakerTranscriptLines: SpeakerTranscriptLine[] = [];
	private readonly stats: VoiceBridgeStats = createVoiceBridgeStats();
	private transcriptResponseTimer: TimerHandle | undefined;
	private realtimeToolResponseTimer: TimerHandle | undefined;
	private speechSynthesisQueue: Promise<void> = Promise.resolve();
	private speechSynthesisGeneration = 0;
	private speechSynthesisAbortController: AbortController | undefined;
	private externalSpeechActiveCount = 0;
	private assistantSpeechActiveUntilMs = 0;
	private realtimeResponseActive = false;
	private realtimeToolResponsePending = false;
	private voiceLogFailureReported = false;
	private piRequestActiveCount = 0;
	private piRequestLastStartedAt: string | undefined;
	private piRequestLastFinishedAt: string | undefined;
	private piRequestLastPrompt: string | undefined;
	private piRequestLastError: string | undefined;
	private piRequestLastTarget: VoicePiDelegationTarget | undefined;

	constructor(
		runtime: AgentSessionRuntime,
		client: DiscordVoiceClient,
		discordConfig: ClankyAgentDiscordGatewayConfig,
		config: FixedClankyAgentDiscordVoiceConfig,
		runtimeTurnQueue: RuntimeTurnQueue,
		dependencies: ResolvedVoiceDependencies,
		subagents: DiscordVoiceSubagentCoordinator | undefined,
		subagentStore: DiscordSubagentStore | undefined,
		voiceLogPath: string | undefined,
	) {
		this.runtime = runtime;
		this.client = client;
		this.discordConfig = discordConfig;
		this.config = config;
		this.runtimeTurnQueue = runtimeTurnQueue;
		this.dependencies = dependencies;
		this.subagents = subagents;
		this.subagentStore = subagentStore;
		this.voiceLogPath = voiceLogPath;
	}

	async start(): Promise<void> {
		if (!this.client.isReady()) {
			throw new Error("Discord voice bridge requires the shared Discord client to be ready.");
		}
		await this.subagents?.start();
		this.streamDiscovery = this.dependencies.createStreamDiscovery(this.client as unknown as DiscordRawGatewayClient, {
			onStreamCredentials: (stream) => {
				if (stream.streamKey === this.requestedStreamWatchKey) this.connectStreamWatch(stream);
				if (stream.streamKey === this.streamPublish.streamKey) this.connectStreamPublish(stream);
			},
			onStreamDeleted: (stream) => {
				if (stream.streamKey === this.activeStreamWatchKey || stream.streamKey === this.requestedStreamWatchKey) {
					this.clearScreenWatch("stream_deleted");
				}
				if (stream.streamKey === this.streamPublish.streamKey) {
					this.clearStreamPublish("stream_deleted", false);
				}
			},
		});
		let realtime: VoiceRealtimeClientLike | undefined;
		let vox: VoiceVoxClientLike | undefined;
		let speechSynthesizer: VoiceSpeechSynthesizerLike | undefined;
		try {
			const guild = await this.resolveGuild(this.config.guildId);
			this.guild = guild;
			const realtimeOptions: ConstructorParameters<typeof OpenAiRealtimeClient>[0] = {
				apiKey: this.config.openAiApiKey,
				logger: (level, event, details) => this.logVoice(level, event, details),
			};
			if (this.config.openAiBaseUrl !== undefined) realtimeOptions.baseUrl = this.config.openAiBaseUrl;
			realtime = this.dependencies.createRealtime(realtimeOptions);
			const voxOptions: ClankvoxSpawnOptions = {
				selfDeaf: false,
				selfMute: false,
			};
			if (this.config.clankvoxBin !== undefined) voxOptions.bin = this.config.clankvoxBin;
			if (this.config.clankvoxDir !== undefined) voxOptions.cwd = this.config.clankvoxDir;
			voxOptions.log = (line) => this.logVoiceLine(`[clankvox] ${line}`);
			vox = await this.dependencies.spawnVox(this.config.guildId, this.config.channelId, guild, voxOptions);
			speechSynthesizer = this.dependencies.createSpeechSynthesizer(this.config);
			this.realtime = realtime;
			this.vox = vox;
			this.speechSynthesizer = speechSynthesizer;
			this.speakerTranscription = this.createSpeakerTranscription(vox, realtimeOptions);
			this.bindVox(vox);
			this.bindRealtime(realtime);
			const connectOptions: OpenAiRealtimeConnectOptions = {
				model: this.config.openAiRealtimeModel,
				voice: this.config.openAiRealtimeVoice,
				instructions: buildRealtimeInstructions(this.discordConfig, this.config.ttsProvider ?? "openai"),
				tools: buildVoiceTools(),
				toolChoice: "auto",
				responseOutputModality: (this.config.ttsProvider ?? "openai") === "elevenlabs" ? "text" : "audio",
			};
			if (this.config.openAiRealtimeReasoningEffort !== undefined) {
				connectOptions.reasoningEffort = this.config.openAiRealtimeReasoningEffort;
			}
			await realtime.connect(connectOptions);
			await this.subagents?.updateStatus("listening in Discord voice");
			this.subagents?.prewarmWorker();
		} catch (error) {
			await this.subagents?.markFailed(error).catch(() => undefined);
			this.streamDiscovery?.stop();
			this.streamDiscovery = undefined;
			await this.speakerTranscription?.dispose().catch(() => undefined);
			this.speakerTranscription = undefined;
			await speechSynthesizer?.dispose?.();
			await realtime?.close().catch(() => undefined);
			await vox?.destroy().catch(() => undefined);
			this.realtime = undefined;
			this.vox = undefined;
			this.speechSynthesizer = undefined;
			this.guild = undefined;
			throw error;
		}
	}

	async stop(): Promise<void> {
		this.clearTranscriptResponseTimer();
		this.clearRealtimeToolResponseTimer();
		this.realtimeToolResponsePending = false;
		this.cancelExternalSpeechSynthesis();
		this.assistantSpeechActiveUntilMs = 0;
		this.clearStreamPublish("voice_bridge_stop", true);
		this.streamDiscovery?.stop();
		this.streamDiscovery = undefined;
		this.clearScreenWatch("voice_bridge_stop");
		this.activeStreamWatchKey = undefined;
		this.requestedStreamWatchKey = undefined;
		await this.speakerTranscription?.dispose();
		this.speakerTranscription = undefined;
		this.activeSpeakingUserIds.clear();
		this.seenInputSpeakerIds.clear();
		this.pendingSpeakerTranscriptLines.length = 0;
		this.pendingToolCalls.clear();
		this.inFlightToolResults.clear();
		this.recentToolResults.clear();
		this.pendingRealtimeOutputText.clear();
		await this.speechSynthesizer?.dispose?.();
		this.speechSynthesizer = undefined;
		await this.realtime?.close();
		this.realtime = undefined;
		await this.vox?.destroy();
		this.vox = undefined;
		this.guild = undefined;
		await this.subagents?.stop();
	}

	requestTextUtterance(text: string): void {
		const prompt = text.trim();
		if (prompt.length === 0) return;
		if (this.realtime === undefined) throw new Error("Discord voice realtime client is not connected.");
		this.realtime.requestTextUtterance(prompt);
	}

	setSubagentThinkingLevel(level: ClankyThinkingLevel): number {
		return this.subagents?.setThinkingLevel(level) ?? 0;
	}

	private logVoice(level: "info" | "warn" | "error", event: string, details?: JsonRecord): void {
		this.logVoiceLine(`[${level}] ${event}${formatVoiceLogDetails(details)}`);
	}

	private logVoiceLine(line: string): void {
		const path = this.voiceLogPath;
		if (path === undefined) return;
		appendFile(path, `${new Date().toISOString()} ${line}\n`).catch((error: unknown) => {
			if (this.voiceLogFailureReported) return;
			this.voiceLogFailureReported = true;
			console.error(`discord-voice log failed: ${error instanceof Error ? error.message : String(error)}`);
		});
	}

	status(): JsonRecord {
		return {
			active: true,
			enabled: this.config.enabled,
			mode: "fixed",
			guildId: this.config.guildId,
			channelId: this.config.channelId,
			allowedGuildIds: this.config.allowedGuildIds ?? [],
			allowedChannelIds: this.config.allowedChannelIds ?? [],
			wakeNames: this.voiceBargeInWakeWords(),
			ttsProvider: this.config.ttsProvider ?? "openai",
			model: this.config.openAiRealtimeModel,
			voice: this.config.openAiRealtimeVoice,
			elevenLabsVoiceId: this.config.elevenLabsVoiceId,
			elevenLabsModel: this.config.elevenLabsModel,
			elevenLabsOutputFormat: this.config.elevenLabsOutputFormat,
			elevenLabsBaseUrl: this.config.elevenLabsBaseUrl,
			reasoningEffort: this.config.openAiRealtimeReasoningEffort,
			interruptionPolicy: "while-speaking-requires-clanky",
			transcriptionModel: this.config.openAiRealtimeTranscriptionModel ?? DEFAULT_REALTIME_TRANSCRIPTION_MODEL,
			transcriptionDelay: this.config.openAiRealtimeTranscriptionDelay,
			transcriptionLanguage: this.config.openAiRealtimeTranscriptionLanguage,
			discordCredentialKind: this.discordConfig.credentialKind,
			nativeScreenWatchSupported: this.discordConfig.credentialKind === "user-token",
			nativeStreamPublishSupported: this.discordConfig.credentialKind === "user-token",
			hasVox: this.vox?.isAlive === true,
			discoveredStreams: this.streamDiscovery?.listStreams().length ?? 0,
			hasLatestFrame: this.latestFrame !== undefined,
			requestedStreamWatchKey: this.requestedStreamWatchKey,
			activeStreamWatchKey: this.activeStreamWatchKey,
			activeVideoUserId: this.activeVideoUserId,
			pi: {
				main: this.piMainRuntimeStatus(),
				voice: this.piVoiceRuntimeStatus(),
				subagentStoreAvailable: this.subagentStore !== undefined,
			},
			media: {
				speech: {
					provider: this.config.ttsProvider ?? "openai",
					synthesizer: this.speechSynthesizer?.status?.(),
				},
				music: {
					status: this.musicStatus,
					url: this.musicUrl,
					resolvedDirectUrl: this.musicResolvedDirectUrl,
					lastError: this.musicLastError,
					gain: this.musicGain,
				},
				streamPublish: { ...this.streamPublish },
				bufferDepth: { ...this.mediaBufferDepth },
			},
			speakerTranscription: this.speakerTranscription?.status(),
			stats: { ...this.stats },
		};
	}

	private async piStatus(): Promise<JsonRecord> {
		this.stats.piStatusRequestCount += 1;
		return {
			ok: true,
			main: this.piMainRuntimeStatus(),
			voice: this.piVoiceRuntimeStatus(),
			subagents: await this.readSubagentStatus({
				includeStale: false,
				limit: 10,
			}),
		};
	}

	private async piSubagentsStatus(args: JsonRecord): Promise<JsonRecord> {
		this.stats.piSubagentStatusRequestCount += 1;
		const stateInput = stringValue(args.state);
		const state = parseSubagentStateFilter(args.state);
		if (stateInput.length > 0 && state === undefined) {
			throw new Error("pi_subagents.state must be one of idle, queued, running, failed, or stale.");
		}
		const kind = stringValue(args.kind);
		return await this.readSubagentStatus({
			...(kind.length === 0 ? {} : { kind }),
			...(state === undefined ? {} : { state }),
			includeStale: booleanValue(args.includeStale ?? args.include_stale, false),
			limit: boundedIntegerValue(args.limit, 20, 1, 100),
		});
	}

	private piMainRuntimeStatus(): JsonRecord {
		const queueBusy = this.runtimeTurnQueue.isBusy();
		const session = this.runtime.session;
		return {
			state: queueBusy || this.piRequestActiveCount > 0 ? "busy" : "idle",
			queueBusy,
			sessionStreaming: session.isStreaming === true,
			sessionId: session.sessionId,
			sessionFile: session.sessionFile,
			cwd: this.runtime.cwd,
			voiceDelegationTarget: this.voiceDelegationTarget(),
			activeVoiceRequests: this.piRequestActiveCount,
			lastVoiceRequestTarget: this.piRequestLastTarget,
			lastVoiceRequestStartedAt: this.piRequestLastStartedAt,
			lastVoiceRequestFinishedAt: this.piRequestLastFinishedAt,
			lastVoiceRequestPrompt: this.piRequestLastPrompt,
			lastVoiceRequestError: this.piRequestLastError,
		};
	}

	private piVoiceRuntimeStatus(): JsonRecord {
		const scopeId = this.voiceScopeId();
		return {
			state: this.realtime === undefined ? "stopped" : this.realtimeResponseActive ? "responding" : "listening",
			guildId: this.config.guildId,
			channelId: this.config.channelId,
			scopeId,
			voiceSubagentId: `discord-voice:${scopeId}`,
			workerSubagentId: `voice-worker:${scopeId}`,
			model: this.config.openAiRealtimeModel,
			voice: this.config.openAiRealtimeVoice,
			realtimeConnected: this.realtime !== undefined,
			voxAlive: this.vox?.isAlive === true,
			supervisor: this.subagents?.status(),
			speakerTranscription: this.speakerTranscription?.status(),
			media: {
				musicStatus: this.musicStatus,
				streamPublishActive: this.streamPublish.active,
				streamPublishPaused: this.streamPublish.paused,
			},
		};
	}

	private async readSubagentStatus(options: {
		kind?: string;
		state?: ClankySubagentState;
		includeStale: boolean;
		limit: number;
	}): Promise<JsonRecord> {
		if (this.subagentStore === undefined) {
			return {
				available: false,
				reason: "subagent_store_unavailable",
				total: 0,
				filtered: 0,
				returned: 0,
				subagents: [],
			};
		}
		const summaries = await this.subagentStore.listSubagents();
		const filtered = summaries.filter((summary) => subagentMatchesStatusFilter(summary, options));
		const limited = filtered.slice(0, options.limit);
		return {
			available: true,
			total: summaries.length,
			filtered: filtered.length,
			returned: limited.length,
			limit: options.limit,
			filters: {
				kind: options.kind,
				state: options.state,
				includeStale: options.includeStale,
			},
			countsByState: countSubagentsByState(summaries),
			countsByKind: countSubagentsByKind(summaries),
			subagents: limited.map(formatSubagentSummary),
		};
	}

	private createSpeakerTranscription(
		vox: VoiceVoxClientLike,
		realtimeOptions: OpenAiRealtimeClientOptions,
	): DiscordVoiceSpeakerTranscriptionManager {
		const transcriptionConnectOptions: OpenAiRealtimeTranscriptionConnectOptions = {
			model: this.config.openAiRealtimeTranscriptionModel ?? DEFAULT_REALTIME_TRANSCRIPTION_MODEL,
			sampleRate: 24_000,
			...(this.config.openAiRealtimeTranscriptionDelay === undefined
				? {}
				: { delay: this.config.openAiRealtimeTranscriptionDelay }),
			...(this.config.openAiRealtimeTranscriptionLanguage === undefined
				? {}
				: { language: this.config.openAiRealtimeTranscriptionLanguage }),
		};
		return new DiscordVoiceSpeakerTranscriptionManager({
			realtimeOptions,
			connectOptions: transcriptionConnectOptions,
			createRealtime: this.dependencies.createTranscriptionRealtime,
			subscribeUser: (userId, silenceDurationMs, sampleRate) => {
				vox.subscribeUser(userId, silenceDurationMs, sampleRate);
			},
			onTranscript: (transcript) => {
				this.handleSpeakerTranscript(transcript);
			},
			onEvent: (_userId, event) => {
				const eventType = stringValue(event.type);
				if (eventType === "session.created") this.stats.realtimeSessionCreatedCount += 1;
				else if (eventType === "session.updated") this.stats.realtimeSessionUpdatedCount += 1;
			},
			onError: (userId, error) => {
				this.stats.speakerTranscriptionErrorCount += 1;
				this.logVoice("warn", "speaker_transcription_error", {
					userId,
					error: error instanceof Error ? error.message : String(error),
				});
			},
			onSocketClosed: (userId, event) => {
				this.stats.speakerTranscriptionSocketCloseCount += 1;
				this.logVoice("warn", "speaker_transcription_socket_closed", { userId, ...event });
			},
			idleCloseMs: this.config.speakerTranscriptionIdleCloseMs ?? DEFAULT_SPEAKER_TRANSCRIPTION_IDLE_CLOSE_MS,
		});
	}

	private handleSpeakerTranscript(transcript: DiscordVoiceSpeakerTranscript): void {
		this.stats.realtimeTranscriptCount += 1;
		if (isFinalInputTranscriptEvent(transcript.eventType)) {
			this.stats.speakerTranscriptFinalCount += 1;
			const text = transcript.text.trim();
			if (text.length === 0) return;
			const displayName = this.resolveSpeakerDisplayName(transcript.userId);
			this.subagents?.recordSpeakerTranscript({
				userId: transcript.userId,
				displayName,
				text,
				eventType: transcript.eventType,
			});
			const assistantWasSpeaking = this.isAssistantSpeechActive();
			const addressedAssistant = transcriptAddressesAssistant(text, this.voiceBargeInWakeWords());
			if (assistantWasSpeaking) {
				if (!addressedAssistant) {
					this.stats.voiceBargeInSuppressedCount += 1;
					return;
				}
				this.stats.voiceBargeInAcceptedCount += 1;
				this.interruptAssistantSpeech();
			}
			this.queueSpeakerTranscriptForResponse({
				userId: transcript.userId,
				displayName,
				text,
				interruptedAssistant: assistantWasSpeaking && addressedAssistant,
			});
			return;
		}
		if (transcript.eventType.endsWith(".delta")) this.stats.speakerTranscriptDeltaCount += 1;
	}

	private queueSpeakerTranscriptForResponse(line: SpeakerTranscriptLine): void {
		this.pendingSpeakerTranscriptLines.push(line);
		if (this.transcriptResponseTimer !== undefined) return;
		const delayMs = this.config.transcriptResponseBatchDelayMs ?? DEFAULT_TRANSCRIPT_RESPONSE_BATCH_DELAY_MS;
		this.transcriptResponseTimer = setTimeout(() => {
			this.transcriptResponseTimer = undefined;
			this.flushSpeakerTranscriptsForResponse();
		}, delayMs);
	}

	private flushSpeakerTranscriptsForResponse(): void {
		const realtime = this.realtime;
		if (realtime === undefined || this.pendingSpeakerTranscriptLines.length === 0) return;
		const lines = this.pendingSpeakerTranscriptLines.splice(0);
		const transcriptLines = lines.map((line) => {
			return `${line.displayName} (${line.userId}): ${line.text}`;
		});
		const interruptionLines = lines.some((line) => line.interruptedAssistant === true)
			? [
					"",
					"Interruption policy: a speaker explicitly addressed Clanky while Clanky was speaking. Treat that as an intentional interruption and answer that addressed request now.",
				]
			: [];
		realtime.requestTextUtterance(
			[
				"Discord voice transcript with speaker attribution:",
				"",
				...transcriptLines,
				...interruptionLines,
				"",
				"Respond in the Discord voice channel. Use the speaker names above when attribution matters.",
			].join("\n"),
		);
		this.stats.speakerTranscriptForwardCount += lines.length;
	}

	private clearTranscriptResponseTimer(): void {
		const timer = this.transcriptResponseTimer;
		if (timer === undefined) return;
		this.transcriptResponseTimer = undefined;
		clearTimeout(timer);
	}

	private clearRealtimeToolResponseTimer(): void {
		const timer = this.realtimeToolResponseTimer;
		if (timer === undefined) return;
		this.realtimeToolResponseTimer = undefined;
		clearTimeout(timer);
	}

	private bindVox(vox: VoiceVoxClientLike): void {
		vox.on("speakingStart", (userId) => {
			this.stats.speakingStartCount += 1;
			this.trackSpeakingStart(userId);
			this.speakerTranscription?.speakingStart(userId);
		});
		vox.on("speakingEnd", (userId) => {
			this.stats.speakingEndCount += 1;
			this.trackSpeakingEnd(userId);
			this.speakerTranscription?.speakingEnd(userId);
		});
		vox.on("userAudio", (userId, pcm) => {
			this.trackInputSpeaker(userId);
			this.stats.discordInputAudioEventCount += 1;
			this.stats.discordInputAudioBytes += pcm.length;
			this.speakerTranscription?.userAudio(userId, pcm);
		});
		vox.on("userAudioEnd", (userId) => {
			this.trackSpeakingEnd(userId);
			this.stats.discordInputAudioEndCount += 1;
			this.speakerTranscription?.userAudioEnd(userId);
		});
		vox.on("playerState", (status) => {
			this.applyMusicPlayerState(status);
		});
		vox.on("musicIdle", () => {
			this.musicStatus = "idle";
		});
		vox.on("musicError", (message) => {
			this.stats.musicErrorCount += 1;
			this.musicStatus = "error";
			this.musicLastError = message;
		});
		vox.on("musicGainReached", (gain) => {
			this.musicGain = gain;
		});
		vox.on("bufferDepth", (ttsSamples, musicSamples) => {
			this.mediaBufferDepth = { ttsSamples, musicSamples };
		});
		vox.on("transportState", (state) => {
			this.applyTransportState(state);
		});
		vox.on("decodedVideoFrame", (frame) => {
			this.latestFrame = frame;
			this.stats.decodedVideoFrameCount += 1;
			this.maybeAppendDecodedVideoFrame(frame);
		});
		vox.on("ipcError", (event) => {
			this.logVoice("warn", "clankvox_ipc_error", event);
		});
	}

	private trackSpeakingStart(userId: string): void {
		const normalizedUserId = userId.trim();
		if (normalizedUserId.length === 0) return;
		this.trackInputSpeaker(normalizedUserId);
		this.activeSpeakingUserIds.add(normalizedUserId);
		if (this.activeSpeakingUserIds.size > this.stats.discordInputMaxConcurrentSpeakers) {
			this.stats.discordInputMaxConcurrentSpeakers = this.activeSpeakingUserIds.size;
		}
		if (this.activeSpeakingUserIds.size > 1) {
			this.stats.discordInputGroupOverlapCount += 1;
		}
	}

	private trackSpeakingEnd(userId: string): void {
		const normalizedUserId = userId.trim();
		if (normalizedUserId.length === 0) return;
		this.activeSpeakingUserIds.delete(normalizedUserId);
	}

	private trackInputSpeaker(userId: string): void {
		const normalizedUserId = userId.trim();
		if (normalizedUserId.length === 0) return;
		this.seenInputSpeakerIds.add(normalizedUserId);
		this.stats.discordInputUniqueSpeakerCount = this.seenInputSpeakerIds.size;
	}

	private maybeAppendDecodedVideoFrame(frame: ClankvoxDecodedVideoFrame): void {
		const now = Date.now();
		const intervalMs = this.config.videoFrameAutoAttachIntervalMs ?? DEFAULT_VIDEO_FRAME_AUTO_ATTACH_INTERVAL_MS;
		if (now - this.lastVideoFrameAttachedAt < intervalMs) {
			this.stats.videoFrameAutoAttachSkipCount += 1;
			return;
		}
		this.lastVideoFrameAttachedAt = now;
		this.realtime?.appendInputVideoFrame({ mimeType: "image/jpeg", dataBase64: frame.jpegBase64 });
		this.stats.videoFrameAttachCount += 1;
	}

	private bindRealtime(realtime: VoiceRealtimeClientLike): void {
		realtime.on("audio_delta", (pcmBase64: string) => {
			this.stats.realtimeAudioDeltaCount += 1;
			this.stats.realtimeAudioDeltaBytes += base64DecodedByteLength(pcmBase64);
			if ((this.config.ttsProvider ?? "openai") === "elevenlabs") return;
			const vox = this.vox;
			if (vox === undefined) {
				this.stats.discordOutputAudioDropCount += 1;
				return;
			}
			vox.sendAudio(pcmBase64, 24_000);
			this.rememberAssistantSpeechOutput(pcmBase64, 24_000);
			this.stats.discordOutputAudioSendCount += 1;
		});
		realtime.on("event", (event: JsonRecord) => {
			this.stats.realtimeEventCount += 1;
			const eventType = stringValue(event.type);
			if (eventType === "session.created") this.stats.realtimeSessionCreatedCount += 1;
			else if (eventType === "session.updated") this.stats.realtimeSessionUpdatedCount += 1;
			else if (eventType === "response.created") this.realtimeResponseActive = true;
			else if (eventType === "response.done" || eventType === "response.cancelled") {
				this.realtimeResponseActive = false;
				this.flushRealtimeToolResponse();
			}
			void this.handleRealtimeEvent(event).catch((error: unknown) => {
				this.logVoice("error", "realtime_event_handler_error", { error: errorMessage(error) });
			});
		});
		realtime.on("error_event", (event: JsonRecord) => {
			this.stats.realtimeErrorEventCount += 1;
			this.logVoice("warn", "openai_realtime_error", event);
		});
		realtime.on("socket_closed", (event: JsonRecord) => {
			this.stats.realtimeSocketCloseCount += 1;
			this.logVoice("warn", "openai_realtime_socket_closed", event);
		});
		realtime.on("socket_error", (error: Error) => {
			this.stats.realtimeSocketErrorCount += 1;
			this.logVoice("warn", "openai_realtime_socket_error", { error: error.message });
		});
		realtime.on("transcript", (transcript: OpenAiRealtimeTranscript) => {
			this.handleRealtimeTranscript(transcript);
		});
	}

	private handleRealtimeTranscript(transcript: OpenAiRealtimeTranscript): void {
		this.stats.realtimeTranscriptCount += 1;
		this.subagents?.recordRealtimeTranscript(transcript);
		if ((this.config.ttsProvider ?? "openai") !== "elevenlabs") return;
		const eventType = transcript.eventType;
		if (eventType === "response.output_text.delta" || eventType === "response.output_audio_transcript.delta") {
			const key = transcript.itemId ?? "default";
			this.pendingRealtimeOutputText.set(key, `${this.pendingRealtimeOutputText.get(key) ?? ""}${transcript.text}`);
			return;
		}
		if (eventType !== "response.output_text.done" && eventType !== "response.output_audio_transcript.done") return;
		const key = transcript.itemId ?? "default";
		const fallback = this.pendingRealtimeOutputText.get(key) ?? "";
		this.pendingRealtimeOutputText.delete(key);
		const text = transcript.text.trim().length > 0 ? transcript.text : fallback;
		this.enqueueExternalSpeech(text);
	}

	private enqueueExternalSpeech(text: string): void {
		const prompt = text.trim();
		if (prompt.length === 0) return;
		const generation = this.speechSynthesisGeneration;
		const run = this.speechSynthesisQueue.then(() => this.synthesizeExternalSpeech(prompt, generation));
		this.speechSynthesisQueue = run.catch(() => undefined);
	}

	private async synthesizeExternalSpeech(text: string, generation: number): Promise<void> {
		if (generation !== this.speechSynthesisGeneration) return;
		const synthesizer = this.speechSynthesizer;
		const vox = this.vox;
		if (synthesizer === undefined || vox === undefined) {
			this.stats.discordOutputAudioDropCount += 1;
			return;
		}
		this.stats.externalTtsRequestCount += 1;
		this.externalSpeechActiveCount += 1;
		const abortController = new AbortController();
		this.speechSynthesisAbortController = abortController;
		try {
			await synthesizer.synthesize(
				text,
				(chunk) => {
					if (generation !== this.speechSynthesisGeneration || abortController.signal.aborted) return;
					this.stats.externalTtsAudioBytes += base64DecodedByteLength(chunk.pcmBase64);
					const activeVox = this.vox;
					if (activeVox === undefined) {
						this.stats.discordOutputAudioDropCount += 1;
						return;
					}
					activeVox.sendAudio(chunk.pcmBase64, chunk.sampleRate);
					this.rememberAssistantSpeechOutput(chunk.pcmBase64, chunk.sampleRate);
					this.stats.discordOutputAudioSendCount += 1;
				},
				{ signal: abortController.signal },
			);
		} catch (error) {
			if (abortController.signal.aborted || isAbortError(error)) return;
			this.stats.externalTtsErrorCount += 1;
			this.logVoice("warn", "external_tts_error", { error: errorMessage(error) });
			throw error;
		} finally {
			this.externalSpeechActiveCount = Math.max(0, this.externalSpeechActiveCount - 1);
			if (this.speechSynthesisAbortController === abortController) this.speechSynthesisAbortController = undefined;
		}
	}

	private cancelExternalSpeechSynthesis(): void {
		this.speechSynthesisGeneration += 1;
		this.speechSynthesisAbortController?.abort();
		this.speechSynthesisAbortController = undefined;
	}

	private interruptAssistantSpeech(): void {
		this.cancelExternalSpeechSynthesis();
		this.pendingRealtimeOutputText.clear();
		this.clearRealtimeToolResponseTimer();
		this.realtimeToolResponsePending = false;
		this.assistantSpeechActiveUntilMs = 0;
		this.vox?.stopTtsPlayback();
		if (this.realtimeResponseActive) {
			this.realtimeResponseActive = false;
			this.realtime?.cancelResponse();
		}
	}

	private rememberAssistantSpeechOutput(pcmBase64: string, sampleRate: number): void {
		const bytes = base64DecodedByteLength(pcmBase64);
		if (bytes <= 0 || sampleRate <= 0) return;
		const samples = bytes / 2;
		const durationMs = (samples / sampleRate) * 1_000;
		if (durationMs < 1) return;
		const now = Date.now();
		this.assistantSpeechActiveUntilMs = Math.max(this.assistantSpeechActiveUntilMs, now) + durationMs;
	}

	private isAssistantSpeechActive(): boolean {
		return (
			this.externalSpeechActiveCount > 0 ||
			this.mediaBufferDepth.ttsSamples > 0 ||
			Date.now() < this.assistantSpeechActiveUntilMs
		);
	}

	private voiceBargeInWakeWords(): string[] {
		return resolveVoiceBargeInWakeWords(this.config, this.client.user?.username);
	}

	private async handleRealtimeEvent(event: JsonRecord): Promise<void> {
		const envelopes = extractRealtimeFunctionCallEnvelopes(event);
		if (envelopes.length === 0) return;
		let completedToolCalls = 0;
		for (const envelope of envelopes) {
			if (await this.handleRealtimeFunctionCallEnvelope(envelope)) completedToolCalls += 1;
		}
		if (completedToolCalls > 0) this.scheduleRealtimeToolResponse();
	}

	private scheduleRealtimeToolResponse(): void {
		this.realtimeToolResponsePending = true;
		this.clearRealtimeToolResponseTimer();
		this.realtimeToolResponseTimer = setTimeout(() => {
			this.realtimeToolResponseTimer = undefined;
			this.flushRealtimeToolResponse();
		}, REALTIME_TOOL_RESPONSE_DEBOUNCE_MS);
	}

	private flushRealtimeToolResponse(): void {
		if (!this.realtimeToolResponsePending || this.realtimeResponseActive) return;
		this.clearRealtimeToolResponseTimer();
		this.realtimeToolResponsePending = false;
		this.realtime?.createAudioResponse();
	}

	private async handleRealtimeFunctionCallEnvelope(envelope: RealtimeFunctionCallEnvelope): Promise<boolean> {
		if (this.completedToolCallIdSet.has(envelope.callId)) return false;
		const existing = this.pendingToolCalls.get(envelope.callId);
		const pending: PendingRealtimeToolCall = {
			callId: envelope.callId,
			name: envelope.name || existing?.name || "",
			argumentsJson: `${existing?.argumentsJson ?? ""}${envelope.argumentsDelta ?? ""}`,
		};
		if (envelope.argumentsJson !== undefined) pending.argumentsJson = envelope.argumentsJson;
		this.pendingToolCalls.set(pending.callId, pending);
		if (!envelope.done) return false;
		this.pendingToolCalls.delete(pending.callId);
		this.stats.realtimeFunctionCallCount += 1;
		this.subagents?.recordToolCall(pending.name, pending.argumentsJson);
		let result: unknown;
		try {
			result = await this.executeRealtimeToolCall(pending);
		} catch (error) {
			this.stats.realtimeFunctionCallErrorCount += 1;
			result = {
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
		this.realtime?.sendFunctionCallOutput({ callId: pending.callId, output: result });
		this.subagents?.recordToolResult(pending.name, result);
		this.rememberCompletedToolCallId(pending.callId);
		this.stats.realtimeFunctionCallOutputCount += 1;
		return true;
	}

	private rememberCompletedToolCallId(callId: string): void {
		this.completedToolCallIdSet.add(callId);
		this.completedToolCallIds.push(callId);
		while (this.completedToolCallIds.length > 512) {
			const expired = this.completedToolCallIds.shift();
			if (expired !== undefined) this.completedToolCallIdSet.delete(expired);
		}
	}

	private async executeRealtimeToolCall(call: PendingRealtimeToolCall): Promise<unknown> {
		const args = parseToolArguments(call.argumentsJson);
		if (call.name === "ask_pi") {
			const prompt = stringValue(args.prompt);
			const signature = realtimeToolCallSignature(call.name, { prompt: prompt.trim() });
			return await this.executeDedupedRealtimeToolCall(signature, call.name, async () => {
				this.stats.askPiCallCount += 1;
				return { text: await this.askPi(prompt) };
			});
		}
		if (call.name === "pi_status") {
			return await this.piStatus();
		}
		if (call.name === "pi_subagents") {
			return await this.piSubagentsStatus(args);
		}
		if (call.name === "list_screen_shares") {
			return this.listScreenShares();
		}
		if (call.name === "start_screen_watch") {
			return this.startScreenWatch(stringValue(args.target));
		}
		if (call.name === "stop_screen_watch") {
			return this.stopScreenWatch();
		}
		if (call.name === "see_screenshare_snapshot") {
			return this.snapshotStatus();
		}
		if (call.name === "play_music_url") {
			return this.playMusicUrl(args);
		}
		if (call.name === "play_video_url") {
			return this.playVideoUrl(args);
		}
		if (call.name === "start_music_visualizer") {
			return this.startMusicVisualizer(args);
		}
		if (call.name === "media_pause") {
			return this.pauseMedia();
		}
		if (call.name === "media_resume") {
			return this.resumeMedia();
		}
		if (call.name === "media_stop") {
			return this.stopMedia();
		}
		if (call.name === "media_status") {
			return this.mediaStatus();
		}
		return { error: `Unknown Discord voice tool: ${call.name}` };
	}

	private async executeDedupedRealtimeToolCall(
		signature: string,
		name: string,
		execute: () => Promise<unknown>,
	): Promise<unknown> {
		this.pruneRecentRealtimeToolResults();
		const recent = this.recentToolResults.get(signature);
		if (recent !== undefined) {
			this.logVoice("warn", "realtime_duplicate_tool_result_reused", { name });
			return recent.result;
		}
		const inFlight = this.inFlightToolResults.get(signature);
		if (inFlight !== undefined) {
			this.logVoice("warn", "realtime_duplicate_tool_call_joined", { name });
			return await inFlight;
		}
		const run = execute();
		this.inFlightToolResults.set(signature, run);
		try {
			const result = await run;
			this.recentToolResults.set(signature, {
				result,
				expiresAtMs: Date.now() + REALTIME_DUPLICATE_TOOL_RESULT_CACHE_MS,
			});
			return result;
		} finally {
			this.inFlightToolResults.delete(signature);
		}
	}

	private pruneRecentRealtimeToolResults(): void {
		const now = Date.now();
		for (const [signature, recent] of this.recentToolResults) {
			if (recent.expiresAtMs <= now) this.recentToolResults.delete(signature);
		}
	}

	private async askPi(prompt: string): Promise<string> {
		if (prompt.trim().length === 0) throw new Error("ask_pi requires prompt.");
		const target = this.voiceDelegationTarget();
		this.recordPiRequestStarted(prompt, target);
		try {
			const text =
				this.subagents !== undefined ? await this.subagents.askWorker(prompt) : await this.askMainRuntime(prompt);
			this.recordPiRequestFinished(undefined);
			return text;
		} catch (error) {
			this.recordPiRequestFinished(error);
			throw error;
		}
	}

	private async askMainRuntime(prompt: string): Promise<string> {
		const message = [
			"Discord voice request:",
			"",
			prompt.trim(),
			"",
			"Answer concisely for spoken playback in the active Discord voice channel.",
		].join("\n");
		return await this.runtimeTurnQueue.enqueue(async () => {
			return await sendUserMessageAndWaitForAssistantText(this.runtime, message, PI_TOOL_TIMEOUT_MS);
		});
	}

	private recordPiRequestStarted(prompt: string, target: VoicePiDelegationTarget): void {
		this.piRequestActiveCount += 1;
		this.piRequestLastStartedAt = new Date().toISOString();
		this.piRequestLastFinishedAt = undefined;
		this.piRequestLastPrompt = truncateStatusText(prompt.trim(), 200);
		this.piRequestLastError = undefined;
		this.piRequestLastTarget = target;
	}

	private recordPiRequestFinished(error: unknown): void {
		this.piRequestActiveCount = Math.max(0, this.piRequestActiveCount - 1);
		this.piRequestLastFinishedAt = new Date().toISOString();
		this.piRequestLastError = error === undefined ? undefined : errorMessage(error);
	}

	private voiceDelegationTarget(): VoicePiDelegationTarget {
		return this.subagents === undefined ? "main-runtime" : "voice-worker";
	}

	private voiceScopeId(): string {
		return `${this.config.guildId}:${this.config.channelId}`;
	}

	private playMusicUrl(args: JsonRecord): JsonRecord {
		const url = parseMediaUrl(args.url, "play_music_url.url");
		const resolvedDirectUrl = booleanValue(args.resolvedDirectUrl ?? args.resolved_direct_url, false);
		this.stats.musicPlayRequestCount += 1;
		const vox = this.requireVox();
		vox.musicPlay(url, resolvedDirectUrl);
		this.musicStatus = "loading";
		this.musicUrl = url;
		this.musicResolvedDirectUrl = resolvedDirectUrl;
		this.musicLastError = undefined;
		return {
			ok: true,
			status: this.musicStatus,
			url,
			resolvedDirectUrl,
			note: "Music playback was queued for Discord voice audio.",
		};
	}

	private playVideoUrl(args: JsonRecord): JsonRecord {
		const url = parseMediaUrl(args.url, "play_video_url.url");
		const resolvedDirectUrl = booleanValue(args.resolvedDirectUrl ?? args.resolved_direct_url, false);
		const includeAudio = booleanValue(args.includeAudio ?? args.include_audio, true);
		if (includeAudio) {
			this.stats.musicPlayRequestCount += 1;
			const vox = this.requireVox();
			vox.musicPlay(url, resolvedDirectUrl);
			this.musicStatus = "loading";
			this.musicUrl = url;
			this.musicResolvedDirectUrl = resolvedDirectUrl;
			this.musicLastError = undefined;
		}
		const publish = this.startStreamPublish({
			sourceKind: "video_url",
			sourceUrl: url,
			resolvedDirectUrl,
		});
		return {
			ok: publish.ok === true,
			url,
			resolvedDirectUrl,
			audioStarted: includeAudio,
			streamPublish: publish,
		};
	}

	private startMusicVisualizer(args: JsonRecord): JsonRecord {
		const rawUrl = stringValue(args.url);
		const url = rawUrl.length > 0 ? parseMediaUrl(rawUrl, "start_music_visualizer.url") : this.musicUrl;
		if (url === undefined || url.length === 0) {
			throw new Error("start_music_visualizer requires a URL or active music playback.");
		}
		const resolvedDirectUrl =
			rawUrl.length > 0
				? booleanValue(args.resolvedDirectUrl ?? args.resolved_direct_url, false)
				: this.musicResolvedDirectUrl;
		const includeAudio = booleanValue(args.includeAudio ?? args.include_audio, rawUrl.length > 0);
		if (includeAudio) {
			this.stats.musicPlayRequestCount += 1;
			const vox = this.requireVox();
			vox.musicPlay(url, resolvedDirectUrl);
			this.musicStatus = "loading";
			this.musicUrl = url;
			this.musicResolvedDirectUrl = resolvedDirectUrl;
			this.musicLastError = undefined;
		}
		const visualizerMode = normalizeVisualizerMode(stringValue(args.visualizerMode ?? args.visualizer_mode));
		const publish = this.startStreamPublish({
			sourceKind: "music_visualizer",
			sourceUrl: url,
			resolvedDirectUrl,
			visualizerMode,
		});
		return {
			ok: publish.ok === true,
			url,
			resolvedDirectUrl,
			visualizerMode,
			audioStarted: includeAudio,
			streamPublish: publish,
		};
	}

	private pauseMedia(): JsonRecord {
		this.stats.musicPauseRequestCount += 1;
		const vox = this.requireVox();
		vox.musicPause();
		this.musicStatus = this.musicStatus === "idle" ? "idle" : "paused";
		if (this.streamPublish.active && this.streamPublish.streamKey !== undefined) {
			this.streamDiscovery?.setPublishPaused(this.streamPublish.streamKey, true);
			vox.streamPublishPause();
			this.streamPublish = {
				...this.streamPublish,
				paused: true,
				status: "paused",
				reason: "media_pause",
			};
		}
		return { ok: true, media: this.mediaStatus() };
	}

	private resumeMedia(): JsonRecord {
		this.stats.musicResumeRequestCount += 1;
		const vox = this.requireVox();
		vox.musicResume();
		if (this.musicStatus === "paused") this.musicStatus = "playing";
		if (this.streamPublish.active && this.streamPublish.streamKey !== undefined) {
			this.streamDiscovery?.setPublishPaused(this.streamPublish.streamKey, false);
			vox.streamPublishResume();
			this.streamPublish = {
				...this.streamPublish,
				paused: false,
				status: "resume_requested",
				reason: "media_resume",
			};
		}
		return { ok: true, media: this.mediaStatus() };
	}

	private stopMedia(): JsonRecord {
		this.stats.musicStopRequestCount += 1;
		const vox = this.requireVox();
		vox.musicStop();
		this.musicStatus = "idle";
		this.clearStreamPublish("media_stop", true);
		return { ok: true, media: this.mediaStatus() };
	}

	private mediaStatus(): JsonRecord {
		return {
			music: {
				status: this.musicStatus,
				url: this.musicUrl,
				resolvedDirectUrl: this.musicResolvedDirectUrl,
				lastError: this.musicLastError,
				gain: this.musicGain,
			},
			streamPublish: { ...this.streamPublish },
			bufferDepth: { ...this.mediaBufferDepth },
			nativeStreamPublishSupported: this.discordConfig.credentialKind === "user-token",
		};
	}

	private startStreamPublish(input: {
		sourceKind: VoiceStreamPublishSourceKind;
		sourceUrl: string;
		resolvedDirectUrl: boolean;
		visualizerMode?: string;
	}): JsonRecord {
		this.stats.streamPublishRequestCount += 1;
		if (this.discordConfig.credentialKind !== "user-token") {
			this.stats.streamPublishUnsupportedCount += 1;
			return {
				ok: false,
				error: "Discord Go Live publish requires a user-token Discord credential.",
				credentialKind: this.discordConfig.credentialKind,
			};
		}
		const vox = this.requireVox();
		const discovery = this.streamDiscovery;
		if (discovery === undefined) return { ok: false, error: "stream discovery is not running" };
		const streamKey = this.selfStreamKey();
		if (streamKey === undefined) {
			return { ok: false, error: "Discord client user id is unavailable for Go Live publish." };
		}

		const nextPublish: VoiceStreamPublishState = {
			active: true,
			paused: false,
			streamKey,
			sourceKind: input.sourceKind,
			sourceUrl: input.sourceUrl,
			status: "stream_requested",
			reason: null,
			lastRequestedAt: Date.now(),
		};
		if (input.visualizerMode !== undefined) nextPublish.visualizerMode = input.visualizerMode;
		this.streamPublish = nextPublish;

		if (input.sourceKind === "music_visualizer") {
			vox.streamPublishPlayVisualizer(input.sourceUrl, input.resolvedDirectUrl, input.visualizerMode ?? "cqt");
		} else {
			vox.streamPublishPlay(input.sourceUrl, input.resolvedDirectUrl);
		}

		const discovered = discovery.findStream(streamKey, {
			guildId: this.config.guildId,
			channelId: this.config.channelId,
		});
		if (discovered !== undefined && hasCredentials(discovered)) {
			this.connectStreamPublish(discovered);
		} else {
			discovery.requestPublish({ guildId: this.config.guildId, channelId: this.config.channelId });
			discovery.setPublishPaused(streamKey, false);
		}

		return {
			ok: true,
			streamKey,
			status: this.streamPublish.status,
			sourceKind: input.sourceKind,
			visualizerMode: input.visualizerMode,
		};
	}

	private listScreenShares(): JsonRecord {
		this.stats.screenShareListCount += 1;
		const nativeWatchSupported = this.discordConfig.credentialKind === "user-token";
		const discovery = this.streamDiscovery;
		const streams =
			discovery
				?.listStreams()
				.filter((stream) => stream.guildId === this.config.guildId && stream.channelId === this.config.channelId)
				.map((stream) => ({
					streamKey: stream.streamKey,
					userId: stream.userId,
					hasCredentials: hasCredentials(stream),
					isRequested: stream.streamKey === this.requestedStreamWatchKey,
					isActive: stream.streamKey === this.activeStreamWatchKey,
					updatedAt: stream.updatedAt,
				})) ?? [];
		return {
			nativeWatchSupported,
			warning: nativeWatchSupported
				? undefined
				: "Native Discord Go Live watching requires a user-token Discord credential.",
			streams,
		};
	}

	private startScreenWatch(target: string): JsonRecord {
		this.stats.screenWatchRequestCount += 1;
		if (this.discordConfig.credentialKind !== "user-token") {
			this.stats.screenWatchUnsupportedCount += 1;
			return {
				ok: false,
				error: "Native Discord Go Live watching requires a user-token Discord credential.",
				credentialKind: this.discordConfig.credentialKind,
			};
		}
		const discovery = this.streamDiscovery;
		if (discovery === undefined) return { ok: false, error: "stream discovery is not running" };
		const stream = discovery.findStream(target, { guildId: this.config.guildId, channelId: this.config.channelId });
		if (stream === undefined) {
			this.stats.screenWatchMissCount += 1;
			return { ok: false, error: "no active Discord Go Live stream found" };
		}
		if (this.shouldClearExistingScreenWatch(stream)) {
			this.clearScreenWatch("screen_watch_switch");
		}
		this.requestedStreamWatchKey = stream.streamKey;
		this.subscribeScreenShareVideo(stream.userId);
		discovery.requestWatch(stream.streamKey);
		if (hasCredentials(stream)) this.connectStreamWatch(stream);
		this.stats.screenWatchSuccessCount += 1;
		return {
			ok: true,
			streamKey: stream.streamKey,
			userId: stream.userId,
			hasCredentials: hasCredentials(stream),
		};
	}

	private stopScreenWatch(): JsonRecord {
		this.stats.screenWatchStopCount += 1;
		const hadWatch =
			this.requestedStreamWatchKey !== undefined ||
			this.activeStreamWatchKey !== undefined ||
			this.activeVideoUserId !== undefined;
		if (!hadWatch) return { ok: false, error: "no active screen watch" };
		const streamKey = this.activeStreamWatchKey ?? this.requestedStreamWatchKey;
		const userId = this.activeVideoUserId;
		this.clearScreenWatch("tool_stop_screen_watch");
		return {
			ok: true,
			streamKey,
			userId,
		};
	}

	private snapshotStatus(): JsonRecord {
		this.stats.snapshotRequestCount += 1;
		if (this.latestFrame === undefined) {
			return { ok: false, error: "no screen-share frame has been decoded yet" };
		}
		this.realtime?.appendInputVideoFrame({ mimeType: "image/jpeg", dataBase64: this.latestFrame.jpegBase64 });
		this.stats.snapshotSuccessCount += 1;
		this.stats.videoFrameAttachCount += 1;
		return {
			ok: true,
			userId: this.latestFrame.userId,
			width: this.latestFrame.width,
			height: this.latestFrame.height,
			rtpTimestamp: this.latestFrame.rtpTimestamp,
			note: "The latest JPEG frame was attached to the realtime conversation.",
		};
	}

	private connectStreamWatch(stream: DiscoveredDiscordStream): void {
		if (stream.guildId !== this.config.guildId || stream.channelId !== this.config.channelId) return;
		if (!hasCredentials(stream)) return;
		const vox = this.vox;
		const clientUserId = this.client.user?.id;
		const sessionId = vox?.getLastVoiceSessionId() ?? getGatewayVoiceSessionId(this.client, this.config.guildId);
		if (vox === undefined || clientUserId === undefined || sessionId === undefined) return;
		const daveChannelId = deriveDiscordStreamWatchDaveChannelId(stream.rtcServerId);
		if (daveChannelId === undefined) {
			this.logVoice("warn", "stream_watch_dave_channel_id_missing", {
				streamKey: stream.streamKey,
				rtcServerId: stream.rtcServerId,
			});
			return;
		}
		vox.streamWatchConnect({
			endpoint: stream.endpoint,
			token: stream.token,
			serverId: stream.rtcServerId,
			sessionId,
			userId: clientUserId,
			daveChannelId,
		});
		this.stats.streamWatchConnectCount += 1;
		this.activeStreamWatchKey = stream.streamKey;
	}

	private connectStreamPublish(stream: DiscoveredDiscordStream): void {
		if (stream.guildId !== this.config.guildId || stream.channelId !== this.config.channelId) return;
		if (!hasCredentials(stream)) return;
		if (stream.streamKey !== this.streamPublish.streamKey) return;
		const vox = this.vox;
		const clientUserId = this.client.user?.id;
		const sessionId = vox?.getLastVoiceSessionId() ?? getGatewayVoiceSessionId(this.client, this.config.guildId);
		if (vox === undefined || clientUserId === undefined || sessionId === undefined) {
			this.streamPublish = {
				...this.streamPublish,
				status: "waiting_for_voice_session",
				reason: "voice_session_unavailable",
			};
			return;
		}
		const daveChannelId = deriveDiscordStreamWatchDaveChannelId(stream.rtcServerId);
		if (daveChannelId === undefined) {
			this.streamPublish = {
				...this.streamPublish,
				status: "failed",
				reason: "stream_publish_dave_channel_unavailable",
			};
			return;
		}
		vox.streamPublishConnect({
			endpoint: stream.endpoint,
			token: stream.token,
			serverId: stream.rtcServerId,
			sessionId,
			userId: clientUserId,
			daveChannelId,
		});
		this.stats.streamPublishConnectCount += 1;
		this.streamPublish = {
			...this.streamPublish,
			active: true,
			paused: false,
			streamKey: stream.streamKey,
			status: "connect_requested",
			reason: null,
			lastConnectedAt: Date.now(),
		};
	}

	private subscribeScreenShareVideo(userId: string): void {
		const normalizedUserId = userId.trim();
		const vox = this.vox;
		if (vox === undefined || normalizedUserId.length === 0 || this.activeVideoUserId === normalizedUserId) return;
		if (this.activeVideoUserId !== undefined) vox.unsubscribeUserVideo(this.activeVideoUserId);
		vox.subscribeUserVideo({
			userId: normalizedUserId,
			maxFramesPerSecond: 2,
			preferredQuality: 100,
			preferredPixelCount: 640 * 360,
			preferredStreamType: "screen",
			jpegQuality: 70,
		});
		this.activeVideoUserId = normalizedUserId;
	}

	private shouldClearExistingScreenWatch(stream: DiscoveredDiscordStream): boolean {
		if (this.activeStreamWatchKey !== undefined && this.activeStreamWatchKey !== stream.streamKey) return true;
		if (this.requestedStreamWatchKey !== undefined && this.requestedStreamWatchKey !== stream.streamKey) return true;
		return this.activeVideoUserId !== undefined && this.activeVideoUserId !== stream.userId;
	}

	private clearScreenWatch(reason: string): void {
		if (this.activeVideoUserId !== undefined) {
			this.vox?.unsubscribeUserVideo(this.activeVideoUserId);
			this.activeVideoUserId = undefined;
		}
		if (this.activeStreamWatchKey !== undefined) {
			this.vox?.streamWatchDisconnect(reason);
			this.stats.streamWatchDisconnectCount += 1;
		}
		this.requestedStreamWatchKey = undefined;
		this.activeStreamWatchKey = undefined;
	}

	private clearStreamPublish(reason: string, requestStreamDelete: boolean): void {
		const hadPublish = this.streamPublish.active || this.streamPublish.streamKey !== undefined;
		const streamKey = this.streamPublish.streamKey ?? this.selfStreamKey();
		if (hadPublish) {
			this.vox?.streamPublishStop();
			this.vox?.streamPublishDisconnect(reason);
			this.stats.streamPublishStopCount += 1;
			this.stats.streamPublishDisconnectCount += 1;
		}
		if (requestStreamDelete && streamKey !== undefined) {
			this.streamDiscovery?.requestPublishStop(streamKey);
		}
		this.streamPublish = {
			active: false,
			paused: false,
			status: "stopped",
			reason,
		};
	}

	private applyMusicPlayerState(status: string): void {
		const normalized = status.trim().toLowerCase();
		if (normalized === "playing" || normalized === "paused" || normalized === "idle") {
			this.musicStatus = normalized;
		}
	}

	private applyTransportState(state: ClankvoxTransportState): void {
		if (state.role !== "stream_publish") return;
		this.stats.streamPublishTransportEventCount += 1;
		const next: VoiceStreamPublishState = {
			...this.streamPublish,
			status: state.status,
			reason: state.reason,
		};
		if (state.status === "playing" || state.status === "connecting" || state.status === "waiting_for_transport") {
			next.active = true;
		}
		if (state.status === "paused") {
			next.active = true;
			next.paused = true;
		}
		if (state.status === "ready" || state.status === "disconnected" || state.status === "failed") {
			next.active = false;
			next.paused = false;
		}
		this.streamPublish = next;
	}

	private selfStreamKey(): string | undefined {
		const userId = this.client.user?.id?.trim();
		if (userId === undefined || userId.length === 0) return undefined;
		return `guild:${this.config.guildId}:${this.config.channelId}:${userId}`;
	}

	private resolveSpeakerDisplayName(userId: string): string {
		return readDiscordDisplayName(this.guild, this.client, userId) ?? `User ${userId}`;
	}

	private requireVox(): VoiceVoxClientLike {
		const vox = this.vox;
		if (vox === undefined || !vox.isAlive) throw new Error("Discord voice media engine is not running.");
		return vox;
	}

	private async resolveGuild(guildId: string): Promise<ClankvoxGuildLike> {
		const cached = this.client.guilds.cache.get(guildId);
		const guild = cached ?? (await this.client.guilds.fetch(guildId));
		if (!isRecord(guild)) throw new Error(`Discord guild ${guildId} could not be resolved.`);
		return guild as ClankvoxGuildLike;
	}
}

function buildRealtimeInstructions(
	config: ClankyAgentDiscordGatewayConfig,
	ttsProvider: DiscordVoiceTtsProvider = "openai",
): string {
	const lines = [
		"You are Clanky in a Discord group voice channel.",
		"You receive labeled text transcripts from individual Discord speakers; use those speaker names when attribution matters.",
		"Keep replies short enough for spoken conversation, and avoid reading long tool output verbatim.",
		"Use ask_pi for durable work, memory-backed answers, coding tasks, Linear, MCP, or anything that should go through the Pi agent runtime.",
		"Use pi_status when users ask what Clanky, Pi, the voice bridge, or the main runtime is doing.",
		"Use pi_subagents when users ask about workers, subagents, queue depth, active work, session files, or failures.",
		"The voice session has a small control surface by design; do not mirror main Pi tools directly. Delegate work with ask_pi and inspect state with pi_status or pi_subagents.",
		"Use list_screen_shares when you need to inspect active Discord Go Live streams before choosing one.",
		"Use start_screen_watch when a user asks you to look at a Discord Go Live screen share.",
		"Use stop_screen_watch when the active Discord Go Live screen watch is no longer needed or before changing context.",
		"Use see_screenshare_snapshot when you need the current screen-share image.",
		"Use Pi as the reasoning and skill layer: for music/video requests that are search-like, ambiguous, or not already a direct URL, call ask_pi first and ask it to resolve a playable URL.",
		"Use play_music_url only when you already have an http(s) media URL. It plays audio into Discord voice.",
		"Use play_video_url only when you already have an http(s) video URL. It starts Discord Go Live publish and, by default, plays the audio into voice too.",
		"Use start_music_visualizer to show a Go Live visualizer for current music or a resolved music URL.",
		"Use media_pause, media_resume, media_stop, and media_status for live voice media controls.",
		`Discord credential kind: ${config.credentialKind}.`,
	];
	if (ttsProvider === "elevenlabs") {
		lines.push(
			"Your text output is spoken by ElevenLabs external TTS; write directly speakable text and avoid markdown formatting or stage directions unless requested.",
		);
	}
	return lines.join("\n");
}

function buildVoiceTools(): OpenAiRealtimeTool[] {
	return [
		{
			type: "function",
			name: "ask_pi",
			description: "Delegate a durable or tool-heavy request to the Clanky Pi runtime and return its concise answer.",
			parameters: {
				type: "object",
				properties: {
					prompt: { type: "string", description: "The user request and any voice-channel context needed by Pi." },
				},
				required: ["prompt"],
				additionalProperties: false,
			},
		},
		{
			type: "function",
			name: "pi_status",
			description:
				"Return current Clanky main runtime, voice bridge, and subagent status for questions about what Clanky is doing.",
			parameters: {
				type: "object",
				properties: {},
				additionalProperties: false,
			},
		},
		{
			type: "function",
			name: "pi_subagents",
			description:
				"List tracked Clanky subagents and workers, including queue depth, active work, session files, and failures.",
			parameters: {
				type: "object",
				properties: {
					kind: {
						type: "string",
						description: "Optional exact subagent kind filter, such as discord-voice or voice-worker.",
					},
					state: {
						type: "string",
						enum: ["idle", "queued", "running", "failed", "stale"],
						description: "Optional subagent state filter.",
					},
					includeStale: {
						type: "boolean",
						description: "Include stale/stopped subagents. Defaults to false unless state is stale.",
					},
					limit: {
						type: "number",
						description: "Maximum subagents to return, from 1 to 100. Defaults to 20.",
					},
				},
				additionalProperties: false,
			},
		},
		{
			type: "function",
			name: "list_screen_shares",
			description: "List active Discord Go Live screen shares discovered in this voice channel.",
			parameters: {
				type: "object",
				properties: {},
				additionalProperties: false,
			},
		},
		{
			type: "function",
			name: "start_screen_watch",
			description: "Start watching the most relevant active Discord Go Live screen share.",
			parameters: {
				type: "object",
				properties: {
					target: { type: "string", description: "Optional user id, channel id, or stream key hint." },
				},
				additionalProperties: false,
			},
		},
		{
			type: "function",
			name: "stop_screen_watch",
			description: "Stop the active Discord Go Live screen watch and unsubscribe from its video frames.",
			parameters: {
				type: "object",
				properties: {},
				additionalProperties: false,
			},
		},
		{
			type: "function",
			name: "see_screenshare_snapshot",
			description: "Attach the latest decoded Discord screen-share frame to the realtime conversation.",
			parameters: {
				type: "object",
				properties: {},
				additionalProperties: false,
			},
		},
		{
			type: "function",
			name: "play_music_url",
			description:
				"Play a resolved http(s) music/media URL as audio in Discord voice. If the user gave a search query instead of a URL, call ask_pi first to resolve it.",
			parameters: {
				type: "object",
				properties: {
					url: { type: "string", description: "Resolved http(s) media URL to play." },
					resolvedDirectUrl: {
						type: "boolean",
						description: "True only for direct CDN/media-file URLs that should skip yt-dlp.",
					},
				},
				required: ["url"],
				additionalProperties: false,
			},
		},
		{
			type: "function",
			name: "play_video_url",
			description:
				"Stream a resolved http(s) video URL through Discord Go Live and optionally play its audio in voice. Requires a user-token Discord credential for Go Live.",
			parameters: {
				type: "object",
				properties: {
					url: { type: "string", description: "Resolved http(s) video URL to stream." },
					resolvedDirectUrl: {
						type: "boolean",
						description: "True only for direct CDN/media-file URLs that should skip yt-dlp.",
					},
					includeAudio: {
						type: "boolean",
						description: "Whether to also play the video's audio in voice. Defaults to true.",
					},
				},
				required: ["url"],
				additionalProperties: false,
			},
		},
		{
			type: "function",
			name: "start_music_visualizer",
			description:
				"Start Discord Go Live with a generated visualizer for current music, or for a resolved http(s) music URL.",
			parameters: {
				type: "object",
				properties: {
					url: { type: "string", description: "Optional resolved http(s) music URL. Omit to use active music." },
					resolvedDirectUrl: {
						type: "boolean",
						description: "True only for direct CDN/media-file URLs that should skip yt-dlp.",
					},
					includeAudio: {
						type: "boolean",
						description: "Whether to also start voice audio playback for url. Defaults to true when url is provided.",
					},
					visualizerMode: {
						type: "string",
						enum: ["cqt", "spectrum", "waves", "vectorscope"],
						description: "Visualizer style.",
					},
				},
				additionalProperties: false,
			},
		},
		{
			type: "function",
			name: "media_pause",
			description: "Pause current Discord voice music/video media playback.",
			parameters: { type: "object", properties: {}, additionalProperties: false },
		},
		{
			type: "function",
			name: "media_resume",
			description: "Resume paused Discord voice music/video media playback.",
			parameters: { type: "object", properties: {}, additionalProperties: false },
		},
		{
			type: "function",
			name: "media_stop",
			description: "Stop current Discord voice music/video media playback and Go Live publish.",
			parameters: { type: "object", properties: {}, additionalProperties: false },
		},
		{
			type: "function",
			name: "media_status",
			description: "Return current Discord voice music/video media status.",
			parameters: { type: "object", properties: {}, additionalProperties: false },
		},
	];
}

interface RealtimeFunctionCallEnvelope {
	callId: string;
	name: string;
	argumentsDelta?: string;
	argumentsJson?: string;
	done: boolean;
}

export function extractRealtimeFunctionCallEnvelopes(event: JsonRecord): RealtimeFunctionCallEnvelope[] {
	const type = stringValue(event.type);
	if (type === "response.done" && isRecord(event.response) && Array.isArray(event.response.output)) {
		return event.response.output
			.filter(isRecord)
			.filter((item) => stringValue(item.type) === "function_call")
			.map((item) => {
				return {
					callId: stringValue(item.call_id) || stringValue(item.callId),
					name: stringValue(item.name),
					argumentsJson: stringValue(item.arguments),
					done: true,
				};
			})
			.filter((item) => item.callId.length > 0 && item.name.length > 0);
	}

	const item = isRecord(event.item) ? event.item : isRecord(event.output_item) ? event.output_item : event;
	const callId = stringValue(event.call_id) || stringValue(item.call_id) || stringValue(item.callId);
	if (callId.length === 0) return [];
	const name = stringValue(event.name) || stringValue(item.name);
	if (type === "response.function_call_arguments.delta") {
		return [{ callId, name, argumentsDelta: stringValue(event.delta), done: false }];
	}
	if (type === "response.function_call_arguments.done") {
		return [{ callId, name, argumentsJson: stringValue(event.arguments), done: true }];
	}
	const itemType = stringValue(item.type);
	if (itemType !== "function_call") return [];
	if (type === "response.output_item.done" || type === "response.output_item.added") {
		return [
			{
				callId,
				name,
				argumentsJson: stringValue(item.arguments),
				done: type === "response.output_item.done",
			},
		];
	}
	return [];
}

function sendUserMessageAndWaitForAssistantText(
	runtime: AgentSessionRuntime,
	message: string,
	timeoutMs: number,
): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		let settled = false;
		const timer = setTimeout(() => {
			finish(undefined, new Error("Timed out waiting for Pi response to Discord voice request."));
		}, timeoutMs);
		const unsubscribe = runtime.session.subscribe((event) => {
			const text = assistantText(event);
			if (text !== undefined) finish(text, undefined);
		});
		const finish = (text: string | undefined, error: Error | undefined) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			unsubscribe();
			if (error !== undefined) reject(error);
			else resolve(text ?? "");
		};
		runtime.session.sendUserMessage(message).catch((error: unknown) => {
			finish(undefined, error instanceof Error ? error : new Error(String(error)));
		});
	});
}

function assistantText(event: AgentSessionEvent): string | undefined {
	if (event.type !== "message_end" || event.message.role !== "assistant") return undefined;
	if (event.message.stopReason === "toolUse") return undefined;
	const text = event.message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
	return text.length > 0 ? text : undefined;
}

function parseOptionalEnabled(value: string | undefined): boolean | undefined {
	const normalized = value?.trim().toLowerCase();
	if (normalized === undefined || normalized.length === 0) return undefined;
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function cleanOptionalString(value: string | undefined): string | undefined {
	const normalized = value?.trim();
	return normalized !== undefined && normalized.length > 0 ? normalized : undefined;
}

function parseDiscordVoiceTtsProvider(value: string | undefined): DiscordVoiceTtsProvider | undefined {
	const normalized = value?.trim().toLowerCase();
	if (normalized === "openai" || normalized === "realtime") return "openai";
	if (normalized === "elevenlabs" || normalized === "eleven_labs" || normalized === "11labs") return "elevenlabs";
	return undefined;
}

function parseOptionalStringList(value: string | undefined): string[] | undefined {
	const normalized = value?.trim();
	if (normalized === undefined || normalized.length === 0) return undefined;
	return dedupeNonEmptyStrings(normalized.split(/[,\s]+/));
}

function dedupeNonEmptyStrings(values: readonly string[]): string[] {
	const seen = new Set<string>();
	const deduped: string[] = [];
	for (const value of values) {
		const normalized = cleanOptionalString(value);
		if (normalized === undefined || seen.has(normalized)) continue;
		seen.add(normalized);
		deduped.push(normalized);
	}
	return deduped;
}

function parseOptionalNonNegativeInteger(value: string | undefined): number | undefined {
	const normalized = value?.trim();
	if (normalized === undefined || normalized.length === 0) return undefined;
	const parsed = Number.parseInt(normalized, 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseOptionalPositiveInteger(value: string | undefined): number | undefined {
	const normalized = value?.trim();
	if (normalized === undefined || normalized.length === 0) return undefined;
	const parsed = Number.parseInt(normalized, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseRealtimeReasoningEffort(value: string | undefined): OpenAiRealtimeReasoningEffort | undefined {
	const normalized = value?.trim().toLowerCase();
	if (
		normalized === "minimal" ||
		normalized === "low" ||
		normalized === "medium" ||
		normalized === "high" ||
		normalized === "xhigh"
	) {
		return normalized;
	}
	return undefined;
}

function parseRealtimeTranscriptionDelay(value: string | undefined): OpenAiRealtimeTranscriptionDelay | undefined {
	const normalized = value?.trim().toLowerCase();
	if (
		normalized === "minimal" ||
		normalized === "low" ||
		normalized === "medium" ||
		normalized === "high" ||
		normalized === "xhigh"
	) {
		return normalized;
	}
	return undefined;
}

function parseToolArguments(raw: string): JsonRecord {
	if (raw.trim().length === 0) return {};
	try {
		const parsed = JSON.parse(raw);
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function realtimeToolCallSignature(name: string, args: JsonRecord): string {
	return `${name}:${stableJson(args)}`;
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
	if (isRecord(value)) {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "undefined";
}

function parseMediaUrl(value: unknown, fieldName: string): string {
	const raw = stringValue(value);
	if (raw.length === 0) throw new Error(`${fieldName} is required.`);
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new Error(`${fieldName} must be a valid http(s) URL.`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(`${fieldName} must use http or https.`);
	}
	return parsed.toString();
}

function booleanValue(value: unknown, fallback: boolean): boolean {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") return true;
		if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") return false;
	}
	return fallback;
}

function boundedIntegerValue(value: unknown, fallback: number, min: number, max: number): number {
	const parsed =
		typeof value === "number" ? value : typeof value === "string" && value.trim().length > 0 ? Number(value) : NaN;
	if (!Number.isFinite(parsed)) return fallback;
	const integer = Math.trunc(parsed);
	if (integer < min) return min;
	if (integer > max) return max;
	return integer;
}

function parseSubagentStateFilter(value: unknown): ClankySubagentState | undefined {
	const normalized = stringValue(value).toLowerCase();
	if (
		normalized === "idle" ||
		normalized === "queued" ||
		normalized === "running" ||
		normalized === "failed" ||
		normalized === "stale"
	) {
		return normalized;
	}
	return undefined;
}

function subagentMatchesStatusFilter(
	summary: ClankySubagentSummary,
	options: { kind?: string; state?: ClankySubagentState; includeStale: boolean },
): boolean {
	if (!options.includeStale && options.state !== "stale" && summary.state === "stale") return false;
	if (options.kind !== undefined && summary.kind !== options.kind) return false;
	if (options.state !== undefined && summary.state !== options.state) return false;
	return true;
}

function countSubagentsByState(summaries: ClankySubagentSummary[]): Record<ClankySubagentState, number> {
	const counts: Record<ClankySubagentState, number> = {
		idle: 0,
		queued: 0,
		running: 0,
		failed: 0,
		stale: 0,
	};
	for (const summary of summaries) counts[summary.state] += 1;
	return counts;
}

function countSubagentsByKind(summaries: ClankySubagentSummary[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const summary of summaries) counts[summary.kind] = (counts[summary.kind] ?? 0) + 1;
	return counts;
}

function formatSubagentSummary(summary: ClankySubagentSummary): JsonRecord {
	return {
		id: summary.id,
		kind: summary.kind,
		scopeId: summary.scopeId,
		scopeName: summary.scopeName,
		state: summary.state,
		queueDepth: summary.queueDepth,
		thinkingLevel: summary.thinkingLevel,
		activeConversationId: summary.activeConversationId,
		activeSummary: summary.activeSummary,
		sessionFile: summary.sessionFile,
		pid: summary.pid,
		lastHeartbeatAt: summary.lastHeartbeatAt,
		lastError: summary.lastError,
		createdAt: summary.createdAt,
		updatedAt: summary.updatedAt,
	};
}

function truncateStatusText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	if (maxChars <= 3) return text.slice(0, maxChars);
	return `${text.slice(0, maxChars - 3)}...`;
}

function normalizeVisualizerMode(value: string): string {
	const normalized = value.trim().toLowerCase();
	if (normalized === "spectrum" || normalized === "waves" || normalized === "vectorscope") return normalized;
	return "cqt";
}

function base64DecodedByteLength(value: string): number {
	const normalized = value.trim();
	if (normalized.length === 0) return 0;
	try {
		return Buffer.byteLength(Buffer.from(normalized, "base64"));
	} catch {
		return 0;
	}
}

function getGatewayVoiceSessionId(client: DiscordVoiceClient, guildId: string): string | undefined {
	const guild = client.guilds.cache.get(guildId.trim());
	if (!isRecord(guild)) return undefined;
	const members = isRecord(guild.members) ? guild.members : undefined;
	const me = isRecord(members?.me) ? members.me : undefined;
	const voice = isRecord(me?.voice) ? me.voice : undefined;
	const sessionId = stringValue(voice?.sessionId);
	return sessionId.length > 0 ? sessionId : undefined;
}

function readDiscordDisplayName(guild: unknown, client: unknown, userId: string): string | undefined {
	const member = readCachedById(isRecord(guild) ? guild.members : undefined, userId);
	const memberName = discordDisplayNameFromRecord(member);
	if (memberName !== undefined) return memberName;
	const userFromMember = isRecord(member) ? discordDisplayNameFromRecord(member.user) : undefined;
	if (userFromMember !== undefined) return userFromMember;
	const userContainer = isRecord(client) ? client.users : undefined;
	return discordDisplayNameFromRecord(readCachedById(userContainer, userId));
}

function readCachedById(container: unknown, id: string): unknown {
	if (!isRecord(container)) return undefined;
	const cache = isRecord(container.cache) ? container.cache : undefined;
	const get = cache?.get;
	return typeof get === "function" ? get.call(cache, id) : undefined;
}

function discordDisplayNameFromRecord(value: unknown): string | undefined {
	if (!isRecord(value)) return undefined;
	for (const field of ["displayName", "nickname", "globalName", "username", "tag"]) {
		const text = stringValue(value[field]);
		if (text.length > 0) return text;
	}
	return undefined;
}

function resolveVoiceBargeInWakeWords(
	config: Pick<ClankyAgentDiscordVoiceConfig, "wakeNames">,
	username?: string,
): string[] {
	return dedupeWakeNames([...DEFAULT_VOICE_BARGE_IN_WAKE_WORDS, ...(config.wakeNames ?? []), username ?? ""]);
}

function transcriptAddressesAssistant(text: string, wakeWords: readonly string[]): boolean {
	for (const wakeWord of wakeWords) {
		if (isVoiceWakeNameAddressed({ transcript: text, botName: wakeWord })) return true;
		if (containsVoiceWakeNameMention({ transcript: text, botName: wakeWord })) return true;
		if (hasLikelyVoiceWakeNameCue({ transcript: text, botName: wakeWord })) return true;
	}
	return false;
}

function isVoiceWakeNameAddressed({ transcript, botName = "" }: { transcript: string; botName?: string }): boolean {
	const transcriptTokens = tokenizeWakeTokens(transcript);
	if (transcriptTokens.length === 0) return false;

	const botTokens = tokenizeWakeTokens(botName);
	if (botTokens.length === 0) return false;
	if (botTokens.length === 1) {
		return hasSingleTokenWakeAddress({
			transcript,
			transcriptTokens,
			wakeToken: botTokens[0] ?? "",
		});
	}
	if (containsTokenSequence(transcriptTokens, botTokens)) return true;
	const mergedWakeToken = resolveMergedWakeToken(botTokens);
	if (mergedWakeToken !== null && transcriptTokens.some((token) => token === mergedWakeToken)) return true;

	const primaryWakeToken = resolvePrimaryWakeToken(botTokens);
	if (primaryWakeToken === null) return false;
	return hasSingleTokenWakeAddress({
		transcript,
		transcriptTokens,
		wakeToken: primaryWakeToken,
	});
}

function containsVoiceWakeNameMention({ transcript, botName = "" }: { transcript: string; botName?: string }): boolean {
	const transcriptTokens = tokenizeWakeTokens(transcript);
	if (transcriptTokens.length === 0) return false;
	const botTokens = tokenizeWakeTokens(botName);
	if (botTokens.length === 0) return false;
	if (containsTokenSequence(transcriptTokens, botTokens)) return true;
	const mergedWakeToken = resolveMergedWakeToken(botTokens);
	if (mergedWakeToken !== null && transcriptTokens.some((token) => token === mergedWakeToken)) return true;
	if (botTokens.length === 1) {
		const token = botTokens[0] ?? "";
		return token.length >= PRIMARY_WAKE_TOKEN_MIN_LEN && !EN_WAKE_PRIMARY_GENERIC_TOKENS.has(token)
			? transcriptTokens.some((candidate) => candidate === token)
			: false;
	}
	return false;
}

function hasLikelyVoiceWakeNameCue({ transcript, botName = "" }: { transcript: string; botName?: string }): boolean {
	const primary = pickPrimaryWakeToken(tokenizeWakeTokens(botName));
	if (primary.length === 0) return false;
	const transcriptTokens = tokenizeWakeTokens(transcript);
	for (const token of transcriptTokens) {
		if (isLikelyWakeCueToken(token, primary)) return true;
	}
	return false;
}

function tokenizeWakeTokens(value = ""): string[] {
	const normalized = normalizeWakeText(value);
	const matches = normalized.match(/[\p{L}\p{N}]+/gu);
	return Array.isArray(matches) ? matches : [];
}

function normalizeWakeText(value = ""): string {
	return value
		.trim()
		.toLowerCase()
		.normalize("NFKD")
		.replace(/\p{M}+/gu, "");
}

function containsTokenSequence(tokens: string[] = [], sequence: string[] = []): boolean {
	if (tokens.length === 0 || sequence.length === 0 || sequence.length > tokens.length) return false;
	for (let start = 0; start <= tokens.length - sequence.length; start += 1) {
		let matched = true;
		for (let index = 0; index < sequence.length; index += 1) {
			if (tokens[start + index] !== sequence[index]) {
				matched = false;
				break;
			}
		}
		if (matched) return true;
	}
	return false;
}

function resolvePrimaryWakeToken(botTokens: string[] = []): string | null {
	const candidates = botTokens.filter((token) => token.length >= PRIMARY_WAKE_TOKEN_MIN_LEN);
	if (candidates.length === 0) return null;
	const preferred = candidates.find((token) => !EN_WAKE_PRIMARY_GENERIC_TOKENS.has(token));
	return preferred ?? candidates[0] ?? null;
}

function pickPrimaryWakeToken(botTokens: string[] = []): string {
	const primary = resolvePrimaryWakeToken(botTokens);
	if (primary !== null) return primary;
	return botTokens.find((token) => token.length >= PRIMARY_WAKE_TOKEN_MIN_LEN) ?? "";
}

function resolveMergedWakeToken(botTokens: string[] = []): string | null {
	if (botTokens.length < 2) return null;
	const merged = botTokens.join("");
	return merged.length >= PRIMARY_WAKE_TOKEN_MIN_LEN ? merged : null;
}

function hasSingleTokenWakeAddress({
	transcript,
	transcriptTokens,
	wakeToken,
}: {
	transcript: string;
	transcriptTokens: string[];
	wakeToken: string;
}): boolean {
	const normalizedWakeToken = wakeToken.trim().toLowerCase();
	if (normalizedWakeToken.length === 0) return false;
	if (hasLeadingWakeToken(transcriptTokens, normalizedWakeToken)) return true;
	return hasVocativeWakeToken(transcript, normalizedWakeToken);
}

function hasLeadingWakeToken(tokens: string[] = [], wakeToken = ""): boolean {
	if (tokens.length === 0 || wakeToken.length === 0) return false;
	let index = 0;
	while (index < tokens.length && LEADING_WAKE_PREFIX_TOKENS.has(tokens[index] ?? "")) {
		index += 1;
	}
	return tokens[index] === wakeToken;
}

function hasVocativeWakeToken(transcript = "", wakeToken = ""): boolean {
	const normalizedTranscript = normalizeWakeText(transcript);
	if (normalizedTranscript.length === 0 || wakeToken.length === 0) return false;
	const escapedWakeToken = escapeRegExp(wakeToken);
	return new RegExp(`[,;:.!?]\\s*${escapedWakeToken}(?:\\b|')`, "u").test(normalizedTranscript);
}

function isLikelyWakeCueToken(token = "", primary = ""): boolean {
	const normalizedToken = token.trim().toLowerCase();
	const normalizedPrimary = primary.trim().toLowerCase();
	if (normalizedToken.length < PRIMARY_WAKE_TOKEN_MIN_LEN || normalizedPrimary.length < PRIMARY_WAKE_TOKEN_MIN_LEN) {
		return false;
	}
	if (normalizedToken === normalizedPrimary) return true;
	if (normalizedToken.slice(0, 3) === normalizedPrimary.slice(0, 3)) return true;
	if (
		normalizedToken.slice(0, 2) === normalizedPrimary.slice(0, 2) &&
		sharedConsonantCount(normalizedToken, normalizedPrimary) >= 2
	) {
		return true;
	}
	const distance = levenshteinDistance(normalizedToken, normalizedPrimary);
	const maxLen = Math.max(normalizedToken.length, normalizedPrimary.length);
	const normalizedSimilarity = maxLen > 0 ? 1 - distance / maxLen : 0;
	return normalizedSimilarity >= 0.58 && sharedConsonantCount(normalizedToken, normalizedPrimary) >= 2;
}

function sharedConsonantCount(left = "", right = ""): number {
	const leftSet = new Set(consonants(left));
	const rightSet = new Set(consonants(right));
	let count = 0;
	for (const char of leftSet) {
		if (rightSet.has(char)) count += 1;
	}
	return count;
}

function consonants(value = ""): string[] {
	const letters = value.toLowerCase().replace(/[^a-z]/g, "");
	const out: string[] = [];
	for (const char of letters) {
		if ("aeiou".includes(char)) continue;
		out.push(char);
	}
	return out;
}

function levenshteinDistance(left = "", right = ""): number {
	const rows = left.length + 1;
	const cols = right.length + 1;
	const matrix = Array.from({ length: rows }, (_, row) =>
		Array.from({ length: cols }, (_, col) => (row === 0 ? col : col === 0 ? row : 0)),
	);

	for (let row = 1; row < rows; row += 1) {
		for (let col = 1; col < cols; col += 1) {
			const cost = left[row - 1] === right[col - 1] ? 0 : 1;
			const deletion = (matrix[row - 1]?.[col] ?? 0) + 1;
			const insertion = (matrix[row]?.[col - 1] ?? 0) + 1;
			const substitution = (matrix[row - 1]?.[col - 1] ?? 0) + cost;
			const target = matrix[row];
			if (target !== undefined) target[col] = Math.min(deletion, insertion, substitution);
		}
	}

	return matrix[rows - 1]?.[cols - 1] ?? 0;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isAbortError(error: unknown): boolean {
	if (!isRecord(error)) return false;
	return stringValue(error.name) === "AbortError";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function formatVoiceLogDetails(details: JsonRecord | undefined): string {
	if (details === undefined) return "";
	try {
		return ` ${JSON.stringify(details)}`;
	} catch (error) {
		return ` ${JSON.stringify({ detail: "failed to serialize log details", error: errorMessage(error) })}`;
	}
}

function isFinalInputTranscriptEvent(eventType: string): boolean {
	return eventType === "conversation.item.input_audio_transcription.completed";
}

function hasCredentials(stream: DiscoveredDiscordStream): stream is DiscoveredDiscordStream & {
	endpoint: string;
	token: string;
	rtcServerId: string;
} {
	return stream.endpoint !== null && stream.token !== null && stream.rtcServerId !== null;
}

function isRecord(value: unknown): value is JsonRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}
