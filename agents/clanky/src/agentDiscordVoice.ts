import { appendFile } from "node:fs/promises";
import type { DiscordGatewayClient } from "@agentroom/chat-discord";
import {
	type ClankySubagentState,
	type ClankySubagentStore,
	type ClankySubagentSummary,
	type MainAgentActivityToolInput,
	type MainAgentCancelToolInput,
	maybeInjectWorkTrackerSkill,
	resolveElevenLabsApiKeySync,
	resolveOpenAiApiKeySync,
	resolveXAiApiKeySync,
	type SendSubagentMessageInput,
	type SendSubagentMessageResult,
} from "@clanky/core";
import type {
	AgentSessionEvent,
	AgentSessionRuntime,
	AuthStorage,
	CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";
import { type ClankyAgentDiscordCredentialConfig, resolveAgentDiscordCredentialConfig } from "./agentDiscordGateway.ts";
import type { AgentRealtimeVoiceConfig, AgentVoiceFeature, AgentVoiceGatewayHandle } from "./agentVoiceGateway.ts";
import type { ClankyThinkingLevel } from "./clankyDefaults.ts";
import type {
	DiscordVoiceRealtimeAgentProvider,
	DiscordVoiceTtsProvider,
	StoredDiscordVoiceSettings,
} from "./discordVoiceSettings.ts";
import { DiscordVoiceSubagentCoordinator } from "./discordVoiceSubagentCoordinator.ts";
import { DEFAULT_DISCORD_WAKE_NAMES, dedupeWakeNames, parseDiscordWakeNamesFromEnv } from "./discordWakeNames.ts";
import {
	assistantMessageText,
	cancelMainAgent,
	MainAgentActivityMonitor,
	readMainAgentActivity,
} from "./mainAgentActivity.ts";
import { type RuntimeTurnQueue, SerialRuntimeTurnQueue } from "./runtimeTurnQueue.ts";
import {
	type ClankvoxDecodedVideoFrame,
	type ClankvoxGuildLike,
	ClankvoxIpcClient,
	type ClankvoxSpawnOptions,
	type ClankvoxTransportState,
	type ClankvoxTtsBufferOverflow,
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
import { XAiRealtimeClient } from "./voice/xAiRealtimeClient.ts";
import type { VoiceSupervisorDelegateHandle } from "./voiceSupervisorExtension.ts";

type JsonRecord = Record<string, unknown>;
type TimerHandle = ReturnType<typeof setTimeout>;
type VoicePiDelegationTarget = "main-runtime" | "voice-worker";
type RealtimeAudioOutputChunk = {
	pcmBase64: string;
	sampleRate: number;
	durationMs: number;
};

interface AskPiResult {
	text: string;
	target: VoicePiDelegationTarget;
}

const MIN_REALTIME_AUDIO_OUTPUT_DELAY_MS = 10;
const REALTIME_AUDIO_OUTPUT_TARGET_CHUNK_MS = 80;
const REALTIME_AUDIO_OUTPUT_MAX_COALESCED_CHUNK_MS = 140;
const REALTIME_AUDIO_OUTPUT_MAX_BACKLOG_MS = 8_000;
const REALTIME_AUDIO_OUTPUT_RESUME_BACKLOG_MS = 4_000;
const REALTIME_AUDIO_OUTPUT_MAX_CLANKVOX_BUFFER_MS = 4_000;
const REALTIME_AUDIO_OUTPUT_BACKPRESSURE_RETRY_MS = 40;
const EXTERNAL_TTS_OUTPUT_MAX_BACKLOG_MS = 8_000;
const EXTERNAL_TTS_OUTPUT_BACKPRESSURE_TIMEOUT_MS = 12_000;
const EXTERNAL_TTS_SEGMENT_TARGET_CHARS = 520;
const EXTERNAL_TTS_SEGMENT_MAX_CHARS = 900;
const VOICE_MUSIC_DUCK_GAIN = 0.22;
const VOICE_MUSIC_DUCK_FADE_MS = 180;
const VOICE_MUSIC_UNDUCK_FADE_MS = 650;
const VOICE_MUSIC_UNDUCK_DELAY_MS = 250;

export interface ClankyAgentDiscordVoiceConfig extends AgentRealtimeVoiceConfig {
	enabled: boolean;
	autoJoin?: boolean;
	guildId?: string;
	channelId?: string;
	allowedGuildIds?: string[];
	allowedChannelIds?: string[];
	wakeNames?: string[];
	realtimeAgentProvider?: DiscordVoiceRealtimeAgentProvider;
	ttsProvider?: DiscordVoiceTtsProvider;
	openAiApiKey: string;
	openAiBaseUrl?: string;
	openAiRealtimeModel: string;
	openAiRealtimeVoice: string;
	openAiRealtimeReasoningEffort?: OpenAiRealtimeReasoningEffort;
	xAiApiKey?: string;
	xAiBaseUrl?: string;
	xAiRealtimeModel?: string;
	xAiRealtimeVoice?: string;
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
	participationEagerness?: number;
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
	discordCredential: ClankyAgentDiscordCredentialConfig;
	authStorage?: AuthStorage;
	config?: ClankyAgentDiscordVoiceConfig;
	env?: NodeJS.ProcessEnv;
	runtimeTurnQueue?: RuntimeTurnQueue;
	createSubagentRuntime?: CreateAgentSessionRuntimeFactory;
	createVoiceSubagentRuntime?: CreateAgentSessionRuntimeFactory;
	subagentStore?: ClankySubagentStore;
	subagentSessionDir?: string;
	subagentCwd?: string;
	voiceSupervisorDelegate?: VoiceSupervisorDelegateHandle;
	bridgeLogPath?: string;
	voiceLogPath?: string;
	joinRequested?: boolean;
	dependencies?: ClankyAgentDiscordVoiceDependencies;
}

export interface ClankyAgentDiscordVoiceHandle extends AgentVoiceGatewayHandle {}

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

type RealtimeToolContinuation = "continue" | "stop";

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
	voiceMusicListenGateSuppressedCount: number;
	realtimeAudioDeltaCount: number;
	realtimeAudioDeltaBytes: number;
	realtimeAudioCoalescedChunkCount: number;
	realtimeAudioBackpressureDelayCount: number;
	realtimeAudioBackpressureDropCount: number;
	realtimeAudioBackpressurePauseCount: number;
	realtimeAudioBackpressureResumeCount: number;
	audioOutputQueueMaxQueuedMs: number;
	audioOutputQueueMaxBacklogMs: number;
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
	realtimeDuplicateToolCallCount: number;
	realtimeFunctionCallOutputCount: number;
	realtimeFunctionCallErrorCount: number;
	speakerTranscriptDeltaCount: number;
	speakerTranscriptFinalCount: number;
	speakerTranscriptForwardCount: number;
	speakerTranscriptionErrorCount: number;
	speakerTranscriptionSocketCloseCount: number;
	voiceStaySilentCount: number;
	askPiCallCount: number;
	piStatusRequestCount: number;
	piCurrentActivityRequestCount: number;
	piCancelRequestCount: number;
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
	externalTtsSegmentCount: number;
	externalTtsSegmentedReplyCount: number;
	externalTtsAudioBytes: number;
	externalTtsErrorCount: number;
	externalTtsBackpressureWaitCount: number;
	externalTtsBackpressureTimeoutCount: number;
	externalTtsAudioDropCount: number;
	externalTtsAudioDropMs: number;
	clankvoxTtsBufferMaxMs: number;
	clankvoxTtsBufferOverflowCount: number;
	clankvoxTtsBufferOverflowDropMs: number;
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
	createXAiRealtime?(options: OpenAiRealtimeClientOptions): VoiceRealtimeClientLike;
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
	readonly supportsInputVideoFrames?: boolean;
	connect(options: OpenAiRealtimeConnectOptions): Promise<void>;
	close(): Promise<void>;
	requestTextUtterance(text: string): void;
	sendFunctionCallOutput(input: { callId: string; output: unknown }): void;
	cancelResponse(): void;
	pauseIncoming?(): void;
	resumeIncoming?(): void;
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
	on(event: "ttsPlaybackState", listener: (status: string) => void): unknown;
	on(event: "musicIdle", listener: () => void): unknown;
	on(event: "musicError", listener: (message: string) => void): unknown;
	on(event: "musicGainReached", listener: (gain: number) => void): unknown;
	on(event: "bufferDepth", listener: (ttsSamples: number, musicSamples: number) => void): unknown;
	on(event: "ttsBufferOverflow", listener: (event: ClankvoxTtsBufferOverflow) => void): unknown;
	off(event: "playerState", listener: (status: string) => void): unknown;
	off(event: "musicError", listener: (message: string) => void): unknown;
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
		onAudio: (chunk: ElevenLabsTtsAudioChunk) => Promise<void> | void,
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

interface DiscordVoiceParticipant {
	userId: string;
	displayName: string;
	muted: boolean;
	deafened: boolean;
	isBot: boolean;
}

interface DiscordVoiceParticipantCandidate {
	userId?: string | undefined;
	displayName?: string | undefined;
	muted?: boolean | undefined;
	deafened?: boolean | undefined;
	isBot?: boolean | undefined;
}

interface ResolvedVoiceDependencies {
	createRealtime(options: OpenAiRealtimeClientOptions): VoiceRealtimeClientLike;
	createXAiRealtime(options: OpenAiRealtimeClientOptions): VoiceRealtimeClientLike;
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
export const DEFAULT_XAI_REALTIME_MODEL = "grok-voice-latest";
const DEFAULT_XAI_REALTIME_VOICE = "eve";
const DEFAULT_REALTIME_TRANSCRIPTION_MODEL = "gpt-realtime-whisper";
const DEFAULT_REALTIME_TRANSCRIPTION_DELAY: OpenAiRealtimeTranscriptionDelay = "low";
const DEFAULT_VIDEO_FRAME_AUTO_ATTACH_INTERVAL_MS = 2_000;
const DEFAULT_SPEAKER_TRANSCRIPTION_IDLE_CLOSE_MS = 120_000;
const DEFAULT_TRANSCRIPT_RESPONSE_BATCH_DELAY_MS = 350;
const DEFAULT_PARTICIPATION_EAGERNESS = 50;
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
		voiceMusicListenGateSuppressedCount: 0,
		realtimeAudioDeltaCount: 0,
		realtimeAudioDeltaBytes: 0,
		realtimeAudioCoalescedChunkCount: 0,
		realtimeAudioBackpressureDelayCount: 0,
		realtimeAudioBackpressureDropCount: 0,
		realtimeAudioBackpressurePauseCount: 0,
		realtimeAudioBackpressureResumeCount: 0,
		audioOutputQueueMaxQueuedMs: 0,
		audioOutputQueueMaxBacklogMs: 0,
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
		realtimeDuplicateToolCallCount: 0,
		realtimeFunctionCallOutputCount: 0,
		realtimeFunctionCallErrorCount: 0,
		speakerTranscriptDeltaCount: 0,
		speakerTranscriptFinalCount: 0,
		speakerTranscriptForwardCount: 0,
		speakerTranscriptionErrorCount: 0,
		speakerTranscriptionSocketCloseCount: 0,
		voiceStaySilentCount: 0,
		askPiCallCount: 0,
		piStatusRequestCount: 0,
		piCurrentActivityRequestCount: 0,
		piCancelRequestCount: 0,
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
		externalTtsSegmentCount: 0,
		externalTtsSegmentedReplyCount: 0,
		externalTtsAudioBytes: 0,
		externalTtsErrorCount: 0,
		externalTtsBackpressureWaitCount: 0,
		externalTtsBackpressureTimeoutCount: 0,
		externalTtsAudioDropCount: 0,
		externalTtsAudioDropMs: 0,
		clankvoxTtsBufferMaxMs: 0,
		clankvoxTtsBufferOverflowCount: 0,
		clankvoxTtsBufferOverflowDropMs: 0,
	};
}

function resolveVoiceDependencies(
	dependencies: ClankyAgentDiscordVoiceDependencies | undefined,
): ResolvedVoiceDependencies {
	return {
		createRealtime: dependencies?.createRealtime ?? ((options) => new OpenAiRealtimeClient(options)),
		createXAiRealtime: dependencies?.createXAiRealtime ?? ((options) => new XAiRealtimeClient(options)),
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
	discordCredential?: ClankyAgentDiscordCredentialConfig,
	authStorage?: AuthStorage,
	storedSettings?: StoredDiscordVoiceSettings,
): ClankyAgentDiscordVoiceConfig | undefined {
	const enabledOverride = parseOptionalEnabled(env.CLANKY_DISCORD_VOICE_ENABLED ?? env.CLANKY_DISCORD_VOICE);
	if (!(enabledOverride ?? storedSettings?.enabled === true)) return undefined;
	const config = discordCredential ?? resolveAgentDiscordCredentialConfig(env);
	if (config === undefined) {
		throw new Error(
			"CLANKY_DISCORD_TOKEN or a stored /discord-login credential is required when Discord voice is enabled.",
		);
	}
	const guildId = cleanOptionalString(env.CLANKY_DISCORD_VOICE_GUILD_ID) ?? storedSettings?.guildId;
	const channelId = cleanOptionalString(env.CLANKY_DISCORD_VOICE_CHANNEL_ID) ?? storedSettings?.channelId;
	const autoJoinOverride = parseOptionalEnabled(env.CLANKY_DISCORD_VOICE_AUTO_JOIN ?? env.CLANKY_VOICE_AUTO_JOIN);
	const autoJoin = autoJoinOverride ?? storedSettings?.autoJoin === true;
	const allowedGuildIds =
		parseOptionalStringList(env.CLANKY_DISCORD_VOICE_ALLOWED_GUILD_IDS) ?? storedSettings?.allowedGuildIds;
	const allowedChannelIds =
		parseOptionalStringList(env.CLANKY_DISCORD_VOICE_ALLOWED_CHANNEL_IDS) ?? storedSettings?.allowedChannelIds;
	const wakeNames = parseDiscordWakeNamesFromEnv(env);
	const ttsProvider =
		parseDiscordVoiceTtsProvider(env.CLANKY_DISCORD_VOICE_TTS_PROVIDER ?? env.CLANKY_VOICE_TTS_PROVIDER) ??
		storedSettings?.ttsProvider ??
		"openai";
	const realtimeAgentProvider =
		parseDiscordVoiceRealtimeAgentProvider(
			env.CLANKY_DISCORD_VOICE_REALTIME_AGENT_PROVIDER ?? env.CLANKY_VOICE_REALTIME_AGENT_PROVIDER,
		) ??
		storedSettings?.realtimeAgentProvider ??
		"openai";
	const openAiApiKey = resolveOpenAiApiKeySync(env, authStorage);
	if (openAiApiKey === undefined) {
		throw new Error(
			"OpenAI credentials are required for Discord voice speaker transcription. Run /openai-login or set OPENAI_API_KEY/CLANKY_OPENAI_API_KEY.",
		);
	}
	const xAiApiKey = realtimeAgentProvider === "xai" ? resolveXAiApiKeySync(env, authStorage) : undefined;
	if (realtimeAgentProvider === "xai" && xAiApiKey === undefined) {
		throw new Error(
			"xAI credentials are required when Discord voice realtime agent provider is xai. Run /xai-login or set XAI_API_KEY.",
		);
	}
	const model =
		cleanOptionalString(env.CLANKY_OPENAI_REALTIME_MODEL) ??
		storedSettings?.openAiRealtimeModel ??
		DEFAULT_REALTIME_MODEL;
	const xAiModel =
		cleanOptionalString(env.CLANKY_XAI_REALTIME_MODEL) ??
		cleanOptionalString(env.CLANKY_XAI_VOICE_MODEL) ??
		storedSettings?.xAiRealtimeModel ??
		DEFAULT_XAI_REALTIME_MODEL;
	const voiceConfig: ClankyAgentDiscordVoiceConfig = {
		enabled: true,
		realtimeAgentProvider,
		ttsProvider,
		openAiApiKey: openAiApiKey.value,
		openAiRealtimeModel: model,
		openAiRealtimeVoice:
			cleanOptionalString(env.CLANKY_OPENAI_REALTIME_VOICE) ??
			storedSettings?.openAiRealtimeVoice ??
			DEFAULT_REALTIME_VOICE,
		xAiRealtimeModel: xAiModel,
		xAiRealtimeVoice:
			cleanOptionalString(env.CLANKY_XAI_REALTIME_VOICE) ??
			cleanOptionalString(env.CLANKY_XAI_VOICE) ??
			storedSettings?.xAiRealtimeVoice ??
			DEFAULT_XAI_REALTIME_VOICE,
		openAiRealtimeTranscriptionModel:
			cleanOptionalString(env.CLANKY_OPENAI_REALTIME_TRANSCRIPTION_MODEL) ?? DEFAULT_REALTIME_TRANSCRIPTION_MODEL,
		openAiRealtimeTranscriptionDelay:
			parseRealtimeTranscriptionDelay(env.CLANKY_OPENAI_REALTIME_TRANSCRIPTION_DELAY) ??
			DEFAULT_REALTIME_TRANSCRIPTION_DELAY,
		participationEagerness:
			parseOptionalBoundedInteger(
				env.CLANKY_DISCORD_VOICE_PARTICIPATION_EAGERNESS ?? env.CLANKY_DISCORD_VOICE_EAGERNESS,
				0,
				100,
			) ??
			storedSettings?.participationEagerness ??
			DEFAULT_PARTICIPATION_EAGERNESS,
		videoFrameAutoAttachIntervalMs:
			parseOptionalNonNegativeInteger(env.CLANKY_DISCORD_VOICE_VIDEO_FRAME_INTERVAL_MS) ??
			storedSettings?.videoFrameAutoAttachIntervalMs ??
			DEFAULT_VIDEO_FRAME_AUTO_ATTACH_INTERVAL_MS,
	};
	if (autoJoin) voiceConfig.autoJoin = true;
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
	if (xAiApiKey !== undefined) {
		voiceConfig.xAiApiKey = xAiApiKey.value;
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
	if (realtimeAgentProvider === "openai" && reasoningEffort !== undefined) {
		voiceConfig.openAiRealtimeReasoningEffort = reasoningEffort;
	} else if (realtimeAgentProvider === "openai" && model === DEFAULT_REALTIME_MODEL) {
		voiceConfig.openAiRealtimeReasoningEffort = DEFAULT_REALTIME_REASONING_EFFORT;
	}
	const baseUrl = env.CLANKY_OPENAI_BASE_URL?.trim() || env.OPENAI_BASE_URL?.trim();
	if (baseUrl !== undefined && baseUrl.length > 0) voiceConfig.openAiBaseUrl = baseUrl;
	const xAiBaseUrl = env.CLANKY_XAI_BASE_URL?.trim() || env.XAI_BASE_URL?.trim();
	if (xAiBaseUrl !== undefined && xAiBaseUrl.length > 0) voiceConfig.xAiBaseUrl = xAiBaseUrl;
	const clankvoxBin = env.CLANKY_CLANKVOX_BIN?.trim();
	if (clankvoxBin !== undefined && clankvoxBin.length > 0) voiceConfig.clankvoxBin = clankvoxBin;
	const clankvoxDir = env.CLANKY_CLANKVOX_DIR?.trim();
	if (clankvoxDir !== undefined && clankvoxDir.length > 0) voiceConfig.clankvoxDir = clankvoxDir;
	return voiceConfig;
}

export async function startAgentDiscordVoiceBridge(
	input: StartAgentDiscordVoiceBridgeInput,
): Promise<ClankyAgentDiscordVoiceHandle | undefined> {
	const config =
		input.config ?? resolveAgentDiscordVoiceConfig(process.env, input.discordCredential, input.authStorage);
	if (config === undefined || !config.enabled) return undefined;
	if (!hasFixedVoiceTarget(config)) {
		return new AgentDiscordVoiceDynamicHandle(config, input.discordCredential);
	}
	if (input.joinRequested !== true && config.autoJoin !== true) {
		return new AgentDiscordVoiceDynamicHandle(config, input.discordCredential);
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
					model: realtimeAgentModelForConfig(config),
					voice: realtimeAgentVoiceForConfig(config),
					env: input.env ?? process.env,
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
		input.discordCredential,
		config,
		input.runtimeTurnQueue ?? new SerialRuntimeTurnQueue(),
		resolveVoiceDependencies(input.dependencies),
		subagents,
		input.subagentStore,
		input.voiceLogPath,
		input.env ?? process.env,
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

function discordVoiceTargetStatus(config: ClankyAgentDiscordVoiceConfig): {
	serverId?: string;
	channelId?: string;
	conversationId?: string;
} {
	return {
		...(config.guildId === undefined ? {} : { serverId: config.guildId }),
		...(config.channelId === undefined ? {} : { channelId: config.channelId, conversationId: config.channelId }),
	};
}

function discordVoiceFeatures(credential: ClankyAgentDiscordCredentialConfig): AgentVoiceFeature[] {
	const features: AgentVoiceFeature[] = ["audio-input", "audio-output", "music-playback"];
	if (credential.credentialKind === "user-token") {
		features.push("screen-watch", "screen-publish", "video-output");
	}
	return features;
}

class AgentDiscordVoiceDynamicHandle implements ClankyAgentDiscordVoiceHandle {
	private readonly config: ClankyAgentDiscordVoiceConfig;
	private readonly discordCredential: ClankyAgentDiscordCredentialConfig;

	constructor(config: ClankyAgentDiscordVoiceConfig, discordCredential: ClankyAgentDiscordCredentialConfig) {
		this.config = config;
		this.discordCredential = discordCredential;
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
			platform: "discord",
			mode: "dynamic",
			target: discordVoiceTargetStatus(this.config),
			features: discordVoiceFeatures(this.discordCredential),
			autoJoin: this.config.autoJoin === true,
			guildId: this.config.guildId,
			channelId: this.config.channelId,
			allowedGuildIds: this.config.allowedGuildIds ?? [],
			allowedChannelIds: this.config.allowedChannelIds ?? [],
			wakeNames: resolveVoiceBargeInWakeWords(this.config),
			realtimeAgentProvider: this.config.realtimeAgentProvider ?? "openai",
			realtimeAgentModel: realtimeAgentModelForConfig(this.config),
			realtimeAgentVoice: realtimeAgentVoiceForConfig(this.config),
			speechOutputProvider: this.config.ttsProvider ?? "openai",
			ttsProvider: this.config.ttsProvider ?? "openai",
			model: realtimeAgentModelForConfig(this.config),
			voice: realtimeAgentVoiceForConfig(this.config),
			elevenLabsVoiceId: this.config.elevenLabsVoiceId,
			elevenLabsModel: this.config.elevenLabsModel,
			elevenLabsOutputFormat: this.config.elevenLabsOutputFormat,
			elevenLabsBaseUrl: this.config.elevenLabsBaseUrl,
			reasoningEffort: this.config.openAiRealtimeReasoningEffort,
			participationEagerness: this.config.participationEagerness ?? DEFAULT_PARTICIPATION_EAGERNESS,
			interruptionPolicy: "while-speaking-requires-clanky",
			transcriptionModel: this.config.openAiRealtimeTranscriptionModel ?? DEFAULT_REALTIME_TRANSCRIPTION_MODEL,
			transcriptionDelay: this.config.openAiRealtimeTranscriptionDelay,
			transcriptionLanguage: this.config.openAiRealtimeTranscriptionLanguage,
			discordCredentialKind: this.discordCredential.credentialKind,
			nativeScreenWatchSupported: this.discordCredential.credentialKind === "user-token",
			nativeStreamPublishSupported: this.discordCredential.credentialKind === "user-token",
			hasVox: false,
		};
	}
}

class AgentDiscordVoiceBridge implements ClankyAgentDiscordVoiceHandle {
	private readonly runtime: AgentSessionRuntime;
	private readonly client: DiscordVoiceClient;
	private readonly discordCredential: ClankyAgentDiscordCredentialConfig;
	private readonly config: FixedClankyAgentDiscordVoiceConfig;
	private readonly runtimeTurnQueue: RuntimeTurnQueue;
	private readonly dependencies: ResolvedVoiceDependencies;
	private readonly subagents: DiscordVoiceSubagentCoordinator | undefined;
	private readonly subagentStore: ClankySubagentStore | undefined;
	private readonly voiceLogPath: string | undefined;
	private readonly env: NodeJS.ProcessEnv;
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
	private mediaMaxBufferDepth: { ttsSamples: number; musicSamples: number } = { ttsSamples: 0, musicSamples: 0 };
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
	private readonly realtimeAudioOutputQueue: RealtimeAudioOutputChunk[] = [];
	private realtimeAudioOutputQueuedMs = 0;
	private readonly stats: VoiceBridgeStats = createVoiceBridgeStats();
	private transcriptResponseTimer: TimerHandle | undefined;
	private realtimeToolResponseTimer: TimerHandle | undefined;
	private realtimeAudioOutputTimer: TimerHandle | undefined;
	private realtimeIncomingPausedForAudioBackpressure = false;
	private musicUnduckTimer: TimerHandle | undefined;
	private speechSynthesisQueue: Promise<void> = Promise.resolve();
	private speechSynthesisGeneration = 0;
	private speechSynthesisAbortController: AbortController | undefined;
	private externalSpeechActiveCount = 0;
	private assistantSpeechActiveUntilMs = 0;
	private musicDuckedForSpeech = false;
	private realtimeResponseActive = false;
	private realtimeToolResponsePending = false;
	private voiceLogFailureReported = false;
	private piRequestActiveCount = 0;
	private piRequestLastStartedAt: string | undefined;
	private piRequestLastFinishedAt: string | undefined;
	private piRequestLastPrompt: string | undefined;
	private piRequestLastError: string | undefined;
	private piRequestLastTarget: VoicePiDelegationTarget | undefined;
	private readonly mainAgentActivityMonitor = new MainAgentActivityMonitor();

	constructor(
		runtime: AgentSessionRuntime,
		client: DiscordVoiceClient,
		discordCredential: ClankyAgentDiscordCredentialConfig,
		config: FixedClankyAgentDiscordVoiceConfig,
		runtimeTurnQueue: RuntimeTurnQueue,
		dependencies: ResolvedVoiceDependencies,
		subagents: DiscordVoiceSubagentCoordinator | undefined,
		subagentStore: ClankySubagentStore | undefined,
		voiceLogPath: string | undefined,
		env: NodeJS.ProcessEnv,
	) {
		this.runtime = runtime;
		this.client = client;
		this.discordCredential = discordCredential;
		this.config = config;
		this.runtimeTurnQueue = runtimeTurnQueue;
		this.dependencies = dependencies;
		this.subagents = subagents;
		this.subagentStore = subagentStore;
		this.voiceLogPath = voiceLogPath;
		this.env = env;
	}

	async start(): Promise<void> {
		if (!this.client.isReady()) {
			throw new Error("Discord voice bridge requires the shared Discord client to be ready.");
		}
		this.mainAgentActivityMonitor.bind(this.runtime);
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
			const openAiRealtimeOptions: OpenAiRealtimeClientOptions = {
				apiKey: this.config.openAiApiKey,
				logger: (level, event, details) => this.logVoice(level, event, details),
			};
			if (this.config.openAiBaseUrl !== undefined) openAiRealtimeOptions.baseUrl = this.config.openAiBaseUrl;
			const realtimeOptions = this.realtimeAgentClientOptions(openAiRealtimeOptions);
			realtime =
				(this.config.realtimeAgentProvider ?? "openai") === "xai"
					? this.dependencies.createXAiRealtime(realtimeOptions)
					: this.dependencies.createRealtime(realtimeOptions);
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
			this.speakerTranscription = this.createSpeakerTranscription(vox, openAiRealtimeOptions);
			this.bindVox(vox);
			this.bindRealtime(realtime);
			const connectOptions: OpenAiRealtimeConnectOptions = {
				model: this.realtimeAgentModel(),
				voice: this.realtimeAgentVoice(),
				instructions: buildRealtimeInstructions(this.discordCredential, this.config.ttsProvider ?? "openai", {
					participationEagerness: this.config.participationEagerness ?? DEFAULT_PARTICIPATION_EAGERNESS,
					supportsScreenShareSnapshots: (this.config.realtimeAgentProvider ?? "openai") === "openai",
				}),
				tools: buildVoiceTools({
					supportsScreenShareSnapshots: (this.config.realtimeAgentProvider ?? "openai") === "openai",
				}),
				toolChoice: "auto",
				responseOutputModality: (this.config.ttsProvider ?? "openai") === "elevenlabs" ? "text" : "audio",
			};
			if (
				(this.config.realtimeAgentProvider ?? "openai") === "openai" &&
				this.config.openAiRealtimeReasoningEffort !== undefined
			) {
				connectOptions.reasoningEffort = this.config.openAiRealtimeReasoningEffort;
			}
			await realtime.connect(connectOptions);
			await this.subagents?.updateStatus("listening in Discord voice");
			this.subagents?.prewarmWorker();
		} catch (error) {
			await this.subagents?.markFailed(error).catch(() => undefined);
			this.mainAgentActivityMonitor.dispose();
			this.clearRealtimeAudioOutputQueue();
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
		this.mainAgentActivityMonitor.dispose();
		this.clearTranscriptResponseTimer();
		this.clearRealtimeToolResponseTimer();
		this.clearRealtimeAudioOutputQueue();
		this.clearMusicUnduckTimer();
		this.realtimeToolResponsePending = false;
		this.cancelExternalSpeechSynthesis();
		this.assistantSpeechActiveUntilMs = 0;
		this.musicDuckedForSpeech = false;
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

	async sendSubagentMessage(input: SendSubagentMessageInput): Promise<SendSubagentMessageResult | undefined> {
		return await this.subagents?.sendInteractiveMessage(input);
	}

	private realtimeAgentClientOptions(openAiRealtimeOptions: OpenAiRealtimeClientOptions): OpenAiRealtimeClientOptions {
		if ((this.config.realtimeAgentProvider ?? "openai") !== "xai") return openAiRealtimeOptions;
		const apiKey = this.config.xAiApiKey;
		if (apiKey === undefined || apiKey.length === 0) throw new Error("XAI_API_KEY is required for xAI voice.");
		const options: OpenAiRealtimeClientOptions = {
			apiKey,
			logger: (level, event, details) => this.logVoice(level, event, details),
		};
		if (this.config.xAiBaseUrl !== undefined) options.baseUrl = this.config.xAiBaseUrl;
		return options;
	}

	private realtimeAgentModel(): string {
		return realtimeAgentModelForConfig(this.config);
	}

	private realtimeAgentVoice(): string {
		return realtimeAgentVoiceForConfig(this.config);
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
			platform: "discord",
			mode: "fixed",
			target: discordVoiceTargetStatus(this.config),
			features: discordVoiceFeatures(this.discordCredential),
			autoJoin: this.config.autoJoin === true,
			guildId: this.config.guildId,
			channelId: this.config.channelId,
			allowedGuildIds: this.config.allowedGuildIds ?? [],
			allowedChannelIds: this.config.allowedChannelIds ?? [],
			wakeNames: this.voiceBargeInWakeWords(),
			realtimeAgentProvider: this.config.realtimeAgentProvider ?? "openai",
			realtimeAgentModel: this.realtimeAgentModel(),
			realtimeAgentVoice: this.realtimeAgentVoice(),
			speechOutputProvider: this.config.ttsProvider ?? "openai",
			ttsProvider: this.config.ttsProvider ?? "openai",
			model: this.realtimeAgentModel(),
			voice: this.realtimeAgentVoice(),
			elevenLabsVoiceId: this.config.elevenLabsVoiceId,
			elevenLabsModel: this.config.elevenLabsModel,
			elevenLabsOutputFormat: this.config.elevenLabsOutputFormat,
			elevenLabsBaseUrl: this.config.elevenLabsBaseUrl,
			reasoningEffort: this.config.openAiRealtimeReasoningEffort,
			participationEagerness: this.config.participationEagerness ?? DEFAULT_PARTICIPATION_EAGERNESS,
			interruptionPolicy: "while-speaking-requires-clanky",
			transcriptionModel: this.config.openAiRealtimeTranscriptionModel ?? DEFAULT_REALTIME_TRANSCRIPTION_MODEL,
			transcriptionDelay: this.config.openAiRealtimeTranscriptionDelay,
			transcriptionLanguage: this.config.openAiRealtimeTranscriptionLanguage,
			discordCredentialKind: this.discordCredential.credentialKind,
			nativeScreenWatchSupported: this.discordCredential.credentialKind === "user-token",
			nativeStreamPublishSupported: this.discordCredential.credentialKind === "user-token",
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
				bufferDepthMs: {
					tts: Math.round(this.clankvoxTtsBufferMs()),
					music: Math.round(Math.max(0, this.mediaBufferDepth.musicSamples) / 48),
				},
				bufferDepthMax: { ...this.mediaMaxBufferDepth },
				bufferDepthMaxMs: {
					tts: Math.round(Math.max(0, this.mediaMaxBufferDepth.ttsSamples) / 48),
					music: Math.round(Math.max(0, this.mediaMaxBufferDepth.musicSamples) / 48),
				},
				outputQueue: {
					chunks: this.realtimeAudioOutputQueue.length,
					queuedMs: Math.round(this.realtimeAudioOutputQueuedMs),
					totalBacklogMs: Math.round(this.audioOutputBacklogMs()),
					maxQueuedMs: Math.round(this.stats.audioOutputQueueMaxQueuedMs),
					maxBacklogMs: Math.round(this.stats.audioOutputQueueMaxBacklogMs),
				},
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

	private piCurrentActivity(args: JsonRecord): JsonRecord {
		this.stats.piCurrentActivityRequestCount += 1;
		const limit = boundedIntegerValue(args.limit, 5, 1, 20);
		const input: MainAgentActivityToolInput = { limit };
		return {
			ok: true,
			main: this.piMainRuntimeStatus(),
			activity: readMainAgentActivity(this.runtime, this.runtimeTurnQueue, input, this.mainAgentActivityMonitor),
		};
	}

	private async piCancel(args: JsonRecord): Promise<JsonRecord> {
		this.stats.piCancelRequestCount += 1;
		const rawReason = stringValue(args.reason).trim();
		const input: MainAgentCancelToolInput = {
			reason: rawReason.length === 0 ? "cancel requested from Discord voice" : rawReason,
		};
		const result = await cancelMainAgent(this.runtime, this.runtimeTurnQueue, input);
		return { ...result, target: "main-runtime" };
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
		const activity = readMainAgentActivity(
			this.runtime,
			this.runtimeTurnQueue,
			{ limit: 1 },
			this.mainAgentActivityMonitor,
		);
		const activeTools = Array.isArray(activity.activeTools) ? activity.activeTools.filter(isRecord) : [];
		const recentAssistantMessages = Array.isArray(activity.recentAssistantMessages)
			? activity.recentAssistantMessages.filter(isRecord)
			: [];
		const firstActiveTool = activeTools[0];
		const firstAssistantMessage = recentAssistantMessages[0];
		const lastMainEventAt = stringValue(activity.lastEventAt) || undefined;
		const lastMainTurnStartedAt = stringValue(activity.lastTurnStartedAt) || undefined;
		const lastMainTurnFinishedAt = stringValue(activity.lastTurnFinishedAt) || undefined;
		return {
			state: queueBusy || session.isStreaming === true || this.piRequestActiveCount > 0 ? "busy" : "idle",
			queueBusy,
			sessionStreaming: session.isStreaming === true,
			pendingMessageCount: session.pendingMessageCount,
			sessionId: session.sessionId,
			sessionFile: session.sessionFile,
			cwd: this.runtime.cwd,
			voiceDelegationTarget: this.voiceDelegationTarget(),
			activeToolName: stringValue(firstActiveTool?.toolName) || undefined,
			activeTools,
			lastMainEventAt,
			lastMainTurnStartedAt,
			lastMainTurnFinishedAt,
			lastAssistantText: stringValue(firstAssistantMessage?.text) || undefined,
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
			realtimeAgentProvider: this.config.realtimeAgentProvider ?? "openai",
			model: this.realtimeAgentModel(),
			voice: this.realtimeAgentVoice(),
			participationEagerness: this.config.participationEagerness ?? DEFAULT_PARTICIPATION_EAGERNESS,
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
			const wakeWords = this.voiceBargeInWakeWords();
			const directlyAddressedAssistant = transcriptDirectlyAddressesAssistant(text, wakeWords);
			const addressedAssistant = directlyAddressedAssistant || transcriptLikelyAddressesAssistant(text, wakeWords);
			const musicControlRequest = looksLikeMusicControlRequest(text);
			if (this.shouldSuppressTranscriptWhileMusicPlaying(text, directlyAddressedAssistant, musicControlRequest)) {
				return;
			}
			if (assistantWasSpeaking) {
				if (!addressedAssistant && !musicControlRequest) {
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
				interruptedAssistant: assistantWasSpeaking && (addressedAssistant || musicControlRequest),
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

	private shouldSuppressTranscriptWhileMusicPlaying(
		text: string,
		directlyAddressedAssistant: boolean,
		musicControlRequest: boolean,
	): boolean {
		if (!this.isMusicPlayingForReservedListening()) return false;
		if (directlyAddressedAssistant || musicControlRequest) return false;
		this.stats.voiceMusicListenGateSuppressedCount += 1;
		this.logVoice("info", "voice_music_listen_gate_suppressed", {
			reason: "music_playing_requires_direct_address",
			musicStatus: this.musicStatus,
			text: truncateStatusText(text, 160),
		});
		return true;
	}

	private flushSpeakerTranscriptsForResponse(): void {
		const realtime = this.realtime;
		if (realtime === undefined || this.pendingSpeakerTranscriptLines.length === 0) return;
		const lines = this.pendingSpeakerTranscriptLines.splice(0);
		const transcriptLines = lines.map((line) => {
			return `${line.displayName} (${line.userId}): ${line.text}`;
		});
		const participantList = formatDiscordVoiceChannelParticipants(this.guild, this.client, this.config.channelId);
		const participantLines =
			participantList === undefined ? [] : ["Discord voice channel participants:", participantList, ""];
		const interruptionLines = lines.some((line) => line.interruptedAssistant === true)
			? [
					"",
					"Interruption policy: a speaker explicitly addressed Clanky while Clanky was speaking. Treat that as an intentional interruption and answer that addressed request now.",
				]
			: [];
		const musicModeLines = this.isMusicPlayingForReservedListening()
			? [
					"",
					"Music mode: music is currently playing. Be reserved, keep any response very brief, and only continue because this batch directly addressed Clanky or requested media control.",
				]
			: [];
		realtime.requestTextUtterance(
			[
				...participantLines,
				"Discord voice transcript with speaker attribution:",
				"",
				...transcriptLines,
				...interruptionLines,
				...musicModeLines,
				"",
				`Voice participation eagerness: ${this.config.participationEagerness ?? DEFAULT_PARTICIPATION_EAGERNESS}/100.`,
				"Decide whether Clanky should speak now. If speaking would feel natural, respond briefly in the Discord voice channel. If not, call voice_stay_silent and do not say that you are staying silent.",
				"Use the speaker names above when attribution matters.",
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

	private clearMusicUnduckTimer(): void {
		const timer = this.musicUnduckTimer;
		if (timer === undefined) return;
		this.musicUnduckTimer = undefined;
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
		vox.on("ttsPlaybackState", (status) => {
			this.handleTtsPlaybackState(status);
		});
		vox.on("musicIdle", () => {
			this.musicStatus = "idle";
			this.musicDuckedForSpeech = false;
			this.clearMusicUnduckTimer();
		});
		vox.on("musicError", (message) => {
			this.logVoice("warn", "clankvox_music_error", { message });
			this.stats.musicErrorCount += 1;
			this.musicStatus = "error";
			this.musicLastError = message;
			this.musicDuckedForSpeech = false;
			this.clearMusicUnduckTimer();
		});
		vox.on("musicGainReached", (gain) => {
			this.musicGain = gain;
		});
		vox.on("bufferDepth", (ttsSamples, musicSamples) => {
			this.mediaBufferDepth = { ttsSamples, musicSamples };
			this.mediaMaxBufferDepth = {
				ttsSamples: Math.max(this.mediaMaxBufferDepth.ttsSamples, ttsSamples),
				musicSamples: Math.max(this.mediaMaxBufferDepth.musicSamples, musicSamples),
			};
			this.stats.clankvoxTtsBufferMaxMs = Math.max(this.stats.clankvoxTtsBufferMaxMs, Math.max(0, ttsSamples) / 48);
			this.recordAudioOutputBacklogWatermark();
			this.updateRealtimeIncomingBackpressure("clankvox_buffer_depth");
			this.drainRealtimeAudioOutputQueue();
		});
		vox.on("ttsBufferOverflow", (event) => {
			this.stats.clankvoxTtsBufferOverflowCount += 1;
			this.stats.clankvoxTtsBufferOverflowDropMs += Math.max(0, event.droppedMs);
			this.logVoice("warn", "clankvox_tts_buffer_overflow", {
				droppedSamples: event.droppedSamples,
				droppedMs: Math.round(event.droppedMs),
				bufferSamples: event.bufferSamples,
				bufferMs: Math.round(event.bufferMs),
			});
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
		if (this.realtime?.supportsInputVideoFrames === false) {
			this.stats.videoFrameAutoAttachSkipCount += 1;
			return;
		}
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
			this.enqueueRealtimeAudioOutput(pcmBase64, 24_000);
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
		const segments = splitExternalTtsText(prompt);
		if (segments.length > 1) {
			this.stats.externalTtsSegmentedReplyCount += 1;
			this.logVoice("info", "external_tts_text_segmented", {
				segments: segments.length,
				chars: prompt.length,
				targetChars: EXTERNAL_TTS_SEGMENT_TARGET_CHARS,
				maxChars: EXTERNAL_TTS_SEGMENT_MAX_CHARS,
			});
		}
		this.stats.externalTtsSegmentCount += segments.length;
		for (const [index, segment] of segments.entries()) {
			const run = this.speechSynthesisQueue.then(() =>
				this.synthesizeExternalSpeech(segment, generation, {
					segmentIndex: index,
					segmentCount: segments.length,
				}),
			);
			this.speechSynthesisQueue = run.catch(() => undefined);
		}
	}

	private async synthesizeExternalSpeech(
		text: string,
		generation: number,
		segment?: { segmentIndex: number; segmentCount: number },
	): Promise<void> {
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
				async (chunk) => {
					if (generation !== this.speechSynthesisGeneration || abortController.signal.aborted) return;
					this.stats.externalTtsAudioBytes += base64DecodedByteLength(chunk.pcmBase64);
					const activeVox = this.vox;
					if (activeVox === undefined) {
						this.stats.discordOutputAudioDropCount += 1;
						return;
					}
					const enqueued = await this.enqueueExternalTtsAudioOutput(chunk.pcmBase64, chunk.sampleRate, {
						signal: abortController.signal,
						segment,
					});
					if (!enqueued && !abortController.signal.aborted) {
						this.speechSynthesisGeneration += 1;
						abortController.abort();
					}
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
		this.clearRealtimeAudioOutputQueue();
		this.pendingRealtimeOutputText.clear();
		this.clearRealtimeToolResponseTimer();
		this.realtimeToolResponsePending = false;
		this.assistantSpeechActiveUntilMs = 0;
		this.vox?.stopTtsPlayback();
		this.scheduleMusicUnduckAfterAssistantSpeech("assistant_interrupted");
		if (this.realtimeResponseActive) {
			this.realtimeResponseActive = false;
			this.realtime?.cancelResponse();
		}
	}

	private enqueueRealtimeAudioOutput(pcmBase64: string, sampleRate: number): void {
		const normalizedPcm = pcmBase64.trim();
		const bytes = base64DecodedByteLength(normalizedPcm);
		if (normalizedPcm.length === 0 || bytes <= 0 || sampleRate <= 0) return;
		const durationMs = Math.max(MIN_REALTIME_AUDIO_OUTPUT_DELAY_MS, pcm16DurationMs(bytes, sampleRate));
		const backlogMs = this.estimatedAssistantOutputBacklogMs();
		const predictedBacklogMs = backlogMs + durationMs;
		const chunks = splitPcm16Base64Chunks(normalizedPcm, sampleRate);
		if (chunks.length === 0) return;
		if (this.realtimeSupportsIncomingBackpressure()) {
			this.pauseRealtimeIncomingForAudioBackpressure("realtime_audio_delta_received", predictedBacklogMs);
		} else if (predictedBacklogMs > REALTIME_AUDIO_OUTPUT_MAX_BACKLOG_MS) {
			this.stats.realtimeAudioBackpressureDropCount += 1;
			this.stats.discordOutputAudioDropCount += 1;
			if (
				this.stats.realtimeAudioBackpressureDropCount === 1 ||
				this.stats.realtimeAudioBackpressureDropCount % 25 === 0
			) {
				this.logVoice("warn", "realtime_audio_output_backpressure_drop", {
					backlogMs: Math.round(backlogMs),
					droppedDurationMs: Math.round(durationMs),
					droppedChunks: this.stats.realtimeAudioBackpressureDropCount,
				});
			}
			return;
		}
		for (const chunk of chunks) {
			this.pushRealtimeAudioOutputChunk(chunk);
		}
		this.rememberAssistantSpeechDuration(durationMs);
		this.updateRealtimeIncomingBackpressure("realtime_audio_enqueued");
		this.drainRealtimeAudioOutputQueue();
	}

	private async enqueueExternalTtsAudioOutput(
		pcmBase64: string,
		sampleRate: number,
		options: {
			signal?: AbortSignal;
			segment?: { segmentIndex: number; segmentCount: number } | undefined;
		} = {},
	): Promise<boolean> {
		const normalizedPcm = pcmBase64.trim();
		const bytes = base64DecodedByteLength(normalizedPcm);
		if (normalizedPcm.length === 0 || bytes <= 0 || sampleRate <= 0) return true;
		const chunks = splitPcm16Base64Chunks(normalizedPcm, sampleRate);
		if (chunks.length === 0) return true;
		for (const [index, chunk] of chunks.entries()) {
			const hasCapacity = await this.waitForExternalTtsOutputCapacity(chunk.durationMs, options.signal);
			if (!hasCapacity) {
				if (isAbortSignalAborted(options.signal)) return false;
				this.recordExternalTtsAudioDrop(
					chunks.slice(index),
					"external_tts_output_backpressure_timeout",
					options.segment,
				);
				return false;
			}
			this.pushRealtimeAudioOutputChunk(chunk);
			this.stats.audioOutputQueueMaxQueuedMs = Math.max(
				this.stats.audioOutputQueueMaxQueuedMs,
				this.realtimeAudioOutputQueuedMs,
			);
			this.recordAudioOutputBacklogWatermark();
			this.rememberAssistantSpeechDuration(chunk.durationMs);
			this.updateRealtimeIncomingBackpressure("external_tts_audio_enqueued");
			this.drainRealtimeAudioOutputQueue();
		}
		return true;
	}

	private async waitForExternalTtsOutputCapacity(
		durationMs: number,
		signal: AbortSignal | undefined,
	): Promise<boolean> {
		const startedAt = Date.now();
		let loggedWait = false;
		for (;;) {
			if (isAbortSignalAborted(signal)) return false;
			const backlogMs = this.audioOutputBacklogMs();
			const predictedBacklogMs = backlogMs + durationMs;
			if (predictedBacklogMs <= EXTERNAL_TTS_OUTPUT_MAX_BACKLOG_MS) {
				if (loggedWait) {
					this.logVoice("info", "external_tts_output_backpressure_released", {
						waitMs: Date.now() - startedAt,
						backlogMs: Math.round(backlogMs),
						queuedMs: Math.round(this.realtimeAudioOutputQueuedMs),
						clankvoxTtsBufferMs: Math.round(this.clankvoxTtsBufferMs()),
					});
				}
				return true;
			}
			if (!loggedWait) {
				loggedWait = true;
				this.stats.externalTtsBackpressureWaitCount += 1;
				this.logVoice("info", "external_tts_output_backpressure_wait", {
					backlogMs: Math.round(backlogMs),
					incomingDurationMs: Math.round(durationMs),
					highWatermarkMs: EXTERNAL_TTS_OUTPUT_MAX_BACKLOG_MS,
					queuedMs: Math.round(this.realtimeAudioOutputQueuedMs),
					clankvoxTtsBufferMs: Math.round(this.clankvoxTtsBufferMs()),
				});
			}
			if (Date.now() - startedAt >= EXTERNAL_TTS_OUTPUT_BACKPRESSURE_TIMEOUT_MS) {
				return false;
			}
			if (!(await sleepWithAbort(REALTIME_AUDIO_OUTPUT_BACKPRESSURE_RETRY_MS, signal))) return false;
		}
	}

	private recordExternalTtsAudioDrop(
		chunks: RealtimeAudioOutputChunk[],
		reason: string,
		segment: { segmentIndex: number; segmentCount: number } | undefined,
	): void {
		const droppedMs = chunks.reduce((total, chunk) => total + chunk.durationMs, 0);
		this.stats.externalTtsBackpressureTimeoutCount += 1;
		this.stats.externalTtsAudioDropCount += chunks.length;
		this.stats.externalTtsAudioDropMs += droppedMs;
		this.stats.discordOutputAudioDropCount += chunks.length;
		this.logVoice("warn", reason, {
			droppedChunks: chunks.length,
			droppedMs: Math.round(droppedMs),
			queuedMs: Math.round(this.realtimeAudioOutputQueuedMs),
			clankvoxTtsBufferMs: Math.round(this.clankvoxTtsBufferMs()),
			backlogMs: Math.round(this.audioOutputBacklogMs()),
			timeoutMs: EXTERNAL_TTS_OUTPUT_BACKPRESSURE_TIMEOUT_MS,
			segmentIndex: segment === undefined ? undefined : segment.segmentIndex + 1,
			segmentCount: segment?.segmentCount,
		});
	}

	private pushRealtimeAudioOutputChunk(chunk: RealtimeAudioOutputChunk): void {
		const previous = this.realtimeAudioOutputQueue[this.realtimeAudioOutputQueue.length - 1];
		if (
			previous !== undefined &&
			previous.sampleRate === chunk.sampleRate &&
			previous.durationMs < REALTIME_AUDIO_OUTPUT_TARGET_CHUNK_MS &&
			previous.durationMs + chunk.durationMs <= REALTIME_AUDIO_OUTPUT_MAX_COALESCED_CHUNK_MS
		) {
			const combined = Buffer.concat([
				Buffer.from(previous.pcmBase64, "base64"),
				Buffer.from(chunk.pcmBase64, "base64"),
			]);
			previous.pcmBase64 = combined.toString("base64");
			previous.durationMs += chunk.durationMs;
			this.realtimeAudioOutputQueuedMs += chunk.durationMs;
			this.stats.realtimeAudioCoalescedChunkCount += 1;
			this.stats.audioOutputQueueMaxQueuedMs = Math.max(
				this.stats.audioOutputQueueMaxQueuedMs,
				this.realtimeAudioOutputQueuedMs,
			);
			this.recordAudioOutputBacklogWatermark();
			return;
		}
		this.realtimeAudioOutputQueue.push(chunk);
		this.realtimeAudioOutputQueuedMs += chunk.durationMs;
		this.stats.audioOutputQueueMaxQueuedMs = Math.max(
			this.stats.audioOutputQueueMaxQueuedMs,
			this.realtimeAudioOutputQueuedMs,
		);
		this.recordAudioOutputBacklogWatermark();
	}

	private drainRealtimeAudioOutputQueue(): void {
		if (this.realtimeAudioOutputTimer !== undefined) return;
		const chunk = this.realtimeAudioOutputQueue[0];
		if (chunk === undefined) {
			this.updateRealtimeIncomingBackpressure("realtime_audio_queue_drained");
			return;
		}
		const clankvoxTtsBufferMs = this.clankvoxTtsBufferMs();
		if (clankvoxTtsBufferMs > REALTIME_AUDIO_OUTPUT_MAX_CLANKVOX_BUFFER_MS) {
			this.stats.realtimeAudioBackpressureDelayCount += 1;
			this.realtimeAudioOutputTimer = setTimeout(() => {
				this.realtimeAudioOutputTimer = undefined;
				this.updateRealtimeIncomingBackpressure("realtime_audio_backpressure_retry");
				this.drainRealtimeAudioOutputQueue();
			}, REALTIME_AUDIO_OUTPUT_BACKPRESSURE_RETRY_MS);
			return;
		}
		this.realtimeAudioOutputQueue.shift();
		this.realtimeAudioOutputQueuedMs = Math.max(0, this.realtimeAudioOutputQueuedMs - chunk.durationMs);
		const vox = this.vox;
		if (vox === undefined) {
			this.stats.discordOutputAudioDropCount += 1 + this.realtimeAudioOutputQueue.length;
			this.realtimeAudioOutputQueue.length = 0;
			this.realtimeAudioOutputQueuedMs = 0;
			return;
		}
		this.beginMusicDuckForAssistantSpeech("realtime_audio_output");
		vox.sendAudio(chunk.pcmBase64, chunk.sampleRate);
		this.stats.discordOutputAudioSendCount += 1;
		this.realtimeAudioOutputTimer = setTimeout(
			() => {
				this.realtimeAudioOutputTimer = undefined;
				this.updateRealtimeIncomingBackpressure("realtime_audio_pace_tick");
				this.drainRealtimeAudioOutputQueue();
			},
			Math.max(MIN_REALTIME_AUDIO_OUTPUT_DELAY_MS, Math.round(chunk.durationMs)),
		);
	}

	private clearRealtimeAudioOutputQueue(): void {
		const timer = this.realtimeAudioOutputTimer;
		this.realtimeAudioOutputTimer = undefined;
		this.realtimeAudioOutputQueue.length = 0;
		this.realtimeAudioOutputQueuedMs = 0;
		if (timer !== undefined) clearTimeout(timer);
		this.resumeRealtimeIncomingAfterAudioBackpressure("realtime_audio_queue_cleared");
	}

	private realtimeSupportsIncomingBackpressure(): boolean {
		const realtime = this.realtime;
		return typeof realtime?.pauseIncoming === "function" && typeof realtime.resumeIncoming === "function";
	}

	private updateRealtimeIncomingBackpressure(reason: string): void {
		const realtime = this.realtime;
		if (typeof realtime?.pauseIncoming !== "function" || typeof realtime.resumeIncoming !== "function") {
			this.realtimeIncomingPausedForAudioBackpressure = false;
			return;
		}

		const backlogMs = this.estimatedAssistantOutputBacklogMs();
		if (this.pauseRealtimeIncomingForAudioBackpressure(reason, backlogMs)) return;

		if (this.realtimeIncomingPausedForAudioBackpressure && backlogMs <= REALTIME_AUDIO_OUTPUT_RESUME_BACKLOG_MS) {
			this.realtimeIncomingPausedForAudioBackpressure = false;
			this.stats.realtimeAudioBackpressureResumeCount += 1;
			realtime.resumeIncoming();
			this.logVoice("info", "realtime_audio_input_resumed_after_backpressure", {
				backlogMs: Math.round(backlogMs),
				lowWatermarkMs: REALTIME_AUDIO_OUTPUT_RESUME_BACKLOG_MS,
				reason,
			});
		}
	}

	private pauseRealtimeIncomingForAudioBackpressure(reason: string, backlogMs: number): boolean {
		const realtime = this.realtime;
		if (typeof realtime?.pauseIncoming !== "function" || typeof realtime.resumeIncoming !== "function") {
			this.realtimeIncomingPausedForAudioBackpressure = false;
			return false;
		}
		if (this.realtimeIncomingPausedForAudioBackpressure || backlogMs < REALTIME_AUDIO_OUTPUT_MAX_BACKLOG_MS) {
			return false;
		}

		this.realtimeIncomingPausedForAudioBackpressure = true;
		this.stats.realtimeAudioBackpressurePauseCount += 1;
		realtime.pauseIncoming();
		this.logVoice("info", "realtime_audio_input_paused_for_backpressure", {
			backlogMs: Math.round(backlogMs),
			highWatermarkMs: REALTIME_AUDIO_OUTPUT_MAX_BACKLOG_MS,
			reason,
		});
		return true;
	}

	private resumeRealtimeIncomingAfterAudioBackpressure(reason: string): void {
		if (!this.realtimeIncomingPausedForAudioBackpressure) return;
		this.realtimeIncomingPausedForAudioBackpressure = false;
		this.stats.realtimeAudioBackpressureResumeCount += 1;
		this.realtime?.resumeIncoming?.();
		this.logVoice("info", "realtime_audio_input_resumed_after_backpressure", {
			backlogMs: Math.round(this.estimatedAssistantOutputBacklogMs()),
			lowWatermarkMs: REALTIME_AUDIO_OUTPUT_RESUME_BACKLOG_MS,
			reason,
		});
	}

	private estimatedAssistantOutputBacklogMs(): number {
		const predictedSpeechMs = Math.max(0, this.assistantSpeechActiveUntilMs - Date.now());
		return Math.max(predictedSpeechMs, this.audioOutputBacklogMs());
	}

	private queuedRealtimeAudioOutputMs(): number {
		return this.realtimeAudioOutputQueuedMs;
	}

	private audioOutputBacklogMs(): number {
		return this.queuedRealtimeAudioOutputMs() + this.clankvoxTtsBufferMs();
	}

	private recordAudioOutputBacklogWatermark(): void {
		this.stats.audioOutputQueueMaxBacklogMs = Math.max(
			this.stats.audioOutputQueueMaxBacklogMs,
			this.audioOutputBacklogMs(),
		);
	}

	private clankvoxTtsBufferMs(): number {
		return Math.max(0, this.mediaBufferDepth.ttsSamples) / 48;
	}

	private rememberAssistantSpeechDuration(durationMs: number): void {
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

	private isMusicPlayingForReservedListening(): boolean {
		return this.musicStatus === "playing";
	}

	private beginMusicDuckForAssistantSpeech(reason: string): void {
		if (this.musicStatus !== "playing") return;
		const vox = this.vox;
		if (vox === undefined) return;
		this.clearMusicUnduckTimer();
		if (this.musicDuckedForSpeech) return;
		this.musicDuckedForSpeech = true;
		vox.musicSetGain(VOICE_MUSIC_DUCK_GAIN, VOICE_MUSIC_DUCK_FADE_MS);
		this.logVoice("info", "voice_music_duck", {
			reason,
			target: VOICE_MUSIC_DUCK_GAIN,
			fadeMs: VOICE_MUSIC_DUCK_FADE_MS,
		});
	}

	private scheduleMusicUnduckAfterAssistantSpeech(reason: string): void {
		if (!this.musicDuckedForSpeech) return;
		this.clearMusicUnduckTimer();
		this.musicUnduckTimer = setTimeout(() => {
			this.musicUnduckTimer = undefined;
			this.maybeUnduckMusicAfterAssistantSpeech(reason);
		}, VOICE_MUSIC_UNDUCK_DELAY_MS);
	}

	private maybeUnduckMusicAfterAssistantSpeech(reason: string): void {
		if (!this.musicDuckedForSpeech) return;
		if (this.musicStatus !== "playing") {
			this.musicDuckedForSpeech = false;
			return;
		}
		if (this.externalSpeechActiveCount > 0 || this.realtimeAudioOutputTimer !== undefined) {
			this.scheduleMusicUnduckAfterAssistantSpeech(reason);
			return;
		}
		if (this.realtimeAudioOutputQueue.length > 0 || this.mediaBufferDepth.ttsSamples > 0) {
			this.scheduleMusicUnduckAfterAssistantSpeech(reason);
			return;
		}
		this.musicDuckedForSpeech = false;
		this.vox?.musicSetGain(1.0, VOICE_MUSIC_UNDUCK_FADE_MS);
		this.logVoice("info", "voice_music_unduck", {
			reason,
			target: 1.0,
			fadeMs: VOICE_MUSIC_UNDUCK_FADE_MS,
		});
	}

	private handleTtsPlaybackState(status: string): void {
		const normalized = status.trim().toLowerCase();
		if (normalized === "idle") {
			this.mediaBufferDepth = { ...this.mediaBufferDepth, ttsSamples: 0 };
			if (this.realtimeAudioOutputQueue.length === 0) {
				this.assistantSpeechActiveUntilMs = Math.min(this.assistantSpeechActiveUntilMs, Date.now());
			}
			this.updateRealtimeIncomingBackpressure("tts_playback_idle");
			this.drainRealtimeAudioOutputQueue();
			this.scheduleMusicUnduckAfterAssistantSpeech("tts_playback_idle");
		}
	}

	private voiceBargeInWakeWords(): string[] {
		return resolveVoiceBargeInWakeWords(this.config, this.client.user?.username);
	}

	private async handleRealtimeEvent(event: JsonRecord): Promise<void> {
		const envelopes = extractRealtimeFunctionCallEnvelopes(event);
		if (envelopes.length === 0) return;
		let shouldContinueAfterTool = false;
		for (const envelope of envelopes) {
			if ((await this.handleRealtimeFunctionCallEnvelope(envelope)) === "continue") shouldContinueAfterTool = true;
		}
		if (shouldContinueAfterTool) this.scheduleRealtimeToolResponse();
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

	private async handleRealtimeFunctionCallEnvelope(
		envelope: RealtimeFunctionCallEnvelope,
	): Promise<RealtimeToolContinuation | undefined> {
		if (this.completedToolCallIdSet.has(envelope.callId)) return undefined;
		const existing = this.pendingToolCalls.get(envelope.callId);
		const pending: PendingRealtimeToolCall = {
			callId: envelope.callId,
			name: envelope.name || existing?.name || "",
			argumentsJson: `${existing?.argumentsJson ?? ""}${envelope.argumentsDelta ?? ""}`,
		};
		if (envelope.argumentsJson !== undefined) pending.argumentsJson = envelope.argumentsJson;
		this.pendingToolCalls.set(pending.callId, pending);
		if (!envelope.done) return undefined;
		this.pendingToolCalls.delete(pending.callId);
		// Mark the callId as completed before awaiting dispatch so that follow-up envelopes
		// for the same call (the realtime API emits `function_call_arguments.done`,
		// `output_item.done`, and `response.done` for one logical call) short-circuit at the
		// guard above instead of slipping through and triggering the signature-based join warning.
		this.rememberCompletedToolCallId(pending.callId);
		const continuation: RealtimeToolContinuation = pending.name === "voice_stay_silent" ? "stop" : "continue";
		const coalescedDuplicate = this.isCoalescedDuplicateRealtimeToolCall(pending);
		if (coalescedDuplicate) {
			this.stats.realtimeDuplicateToolCallCount += 1;
		} else {
			this.stats.realtimeFunctionCallCount += 1;
			this.subagents?.recordToolCall(pending.name, pending.argumentsJson);
		}
		let result: unknown;
		try {
			result = await this.executeRealtimeToolCall(pending);
		} catch (error) {
			if (!coalescedDuplicate) this.stats.realtimeFunctionCallErrorCount += 1;
			result = {
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
		this.realtime?.sendFunctionCallOutput({ callId: pending.callId, output: result });
		if (!coalescedDuplicate) this.subagents?.recordToolResult(pending.name, result);
		this.stats.realtimeFunctionCallOutputCount += 1;
		return continuation;
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
				return await this.askPi(prompt);
			});
		}
		if (call.name === "pi_status") {
			return await this.piStatus();
		}
		if (call.name === "pi_current_activity") {
			return this.piCurrentActivity(args);
		}
		if (call.name === "pi_cancel") {
			return await this.piCancel(args);
		}
		if (call.name === "pi_subagents") {
			return await this.piSubagentsStatus(args);
		}
		if (call.name === "voice_stay_silent") {
			return this.voiceStaySilent(args);
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

	private isCoalescedDuplicateRealtimeToolCall(call: PendingRealtimeToolCall): boolean {
		const signature = this.realtimeDuplicateToolCallSignature(call);
		if (signature === undefined) return false;
		this.pruneRecentRealtimeToolResults();
		return this.inFlightToolResults.has(signature) || this.recentToolResults.has(signature);
	}

	private realtimeDuplicateToolCallSignature(call: PendingRealtimeToolCall): string | undefined {
		if (call.name !== "ask_pi") return undefined;
		let args: JsonRecord;
		try {
			args = parseToolArguments(call.argumentsJson);
		} catch {
			return undefined;
		}
		const prompt = stringValue(args.prompt).trim();
		if (prompt.length === 0) return undefined;
		return realtimeToolCallSignature(call.name, { prompt });
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

	private async askPi(prompt: string): Promise<AskPiResult> {
		if (prompt.trim().length === 0) throw new Error("ask_pi requires prompt.");
		const target = this.voiceDelegationTarget();
		this.recordPiRequestStarted(prompt, target);
		try {
			const text =
				this.subagents !== undefined ? await this.subagents.askWorker(prompt) : await this.askMainRuntime(prompt);
			this.recordPiRequestFinished(undefined);
			return { text, target };
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
		const trackedMessage = maybeInjectWorkTrackerSkill(message, this.env);
		return await this.runtimeTurnQueue.enqueue(async () => {
			return await sendUserMessageAndWaitForAssistantText(this.runtime, trackedMessage, PI_TOOL_TIMEOUT_MS);
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

	private voiceStaySilent(args: JsonRecord): JsonRecord {
		const reason = stringValue(args.reason) || "not_natural_to_speak";
		const confidence = boundedNumberValue(args.confidence, 0, 0, 1);
		const nextListenMs = boundedIntegerValue(args.nextListenMs ?? args.next_listen_ms, 0, 0, 60_000);
		this.stats.voiceStaySilentCount += 1;
		this.logVoice("info", "voice_stay_silent", {
			reason,
			confidence,
			nextListenMs,
			participationEagerness: this.config.participationEagerness ?? DEFAULT_PARTICIPATION_EAGERNESS,
		});
		return {
			ok: true,
			speaking: false,
			reason,
			confidence,
			nextListenMs,
		};
	}

	private waitForMusicPlaybackOutcome(
		vox: VoiceVoxClientLike,
		timeoutMs: number,
	): Promise<{ ok: true } | { ok: false; error: string }> {
		return new Promise((resolve) => {
			const onPlayerState = (status: string): void => {
				if (status.trim().toLowerCase() !== "playing") return;
				cleanup();
				resolve({ ok: true });
			};
			const onMusicError = (message: string): void => {
				cleanup();
				resolve({ ok: false, error: message.length > 0 ? message : "music_play failed" });
			};
			const timer = setTimeout(() => {
				cleanup();
				resolve({ ok: false, error: `music_play did not start within ${timeoutMs}ms` });
			}, timeoutMs);
			const cleanup = (): void => {
				vox.off("playerState", onPlayerState);
				vox.off("musicError", onMusicError);
				clearTimeout(timer);
			};
			vox.on("playerState", onPlayerState);
			vox.on("musicError", onMusicError);
		});
	}

	private async playMusicUrl(args: JsonRecord): Promise<JsonRecord> {
		const url = parseMediaUrl(args.url, "play_music_url.url");
		const resolvedDirectUrl = booleanValue(args.resolvedDirectUrl ?? args.resolved_direct_url, false);
		this.stats.musicPlayRequestCount += 1;
		const vox = this.requireVox();
		const outcome = this.waitForMusicPlaybackOutcome(vox, 20_000);
		vox.musicPlay(url, resolvedDirectUrl);
		this.musicStatus = "loading";
		this.musicUrl = url;
		this.musicResolvedDirectUrl = resolvedDirectUrl;
		this.musicLastError = undefined;
		const result = await outcome;
		if (result.ok) {
			return { ok: true, status: this.musicStatus, url, resolvedDirectUrl };
		}
		return { ok: false, status: this.musicStatus, url, resolvedDirectUrl, error: result.error };
	}

	private async playVideoUrl(args: JsonRecord): Promise<JsonRecord> {
		const url = parseMediaUrl(args.url, "play_video_url.url");
		const resolvedDirectUrl = booleanValue(args.resolvedDirectUrl ?? args.resolved_direct_url, false);
		const includeAudio = booleanValue(args.includeAudio ?? args.include_audio, true);
		let audioOutcome: { ok: true } | { ok: false; error: string } | undefined;
		if (includeAudio) {
			this.stats.musicPlayRequestCount += 1;
			const vox = this.requireVox();
			const pending = this.waitForMusicPlaybackOutcome(vox, 20_000);
			vox.musicPlay(url, resolvedDirectUrl);
			this.musicStatus = "loading";
			this.musicUrl = url;
			this.musicResolvedDirectUrl = resolvedDirectUrl;
			this.musicLastError = undefined;
			audioOutcome = await pending;
		}
		const publish = this.startStreamPublish({
			sourceKind: "video_url",
			sourceUrl: url,
			resolvedDirectUrl,
		});
		const audioStarted = audioOutcome?.ok === true;
		const audioMissing = audioOutcome !== undefined && !audioOutcome.ok && isNoAudioTrackError(audioOutcome.error);
		const ok = (!includeAudio || audioStarted || audioMissing) && publish.ok === true;
		const result: JsonRecord = { ok, url, resolvedDirectUrl, audioStarted, streamPublish: publish };
		if (audioMissing) {
			result.audioSkippedReason = "source_has_no_audio_track";
		} else if (audioOutcome !== undefined && !audioOutcome.ok) {
			result.error = audioOutcome.error;
		}
		return result;
	}

	private async startMusicVisualizer(args: JsonRecord): Promise<JsonRecord> {
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
		let audioOutcome: { ok: true } | { ok: false; error: string } | undefined;
		if (includeAudio) {
			this.stats.musicPlayRequestCount += 1;
			const vox = this.requireVox();
			const pending = this.waitForMusicPlaybackOutcome(vox, 20_000);
			vox.musicPlay(url, resolvedDirectUrl);
			this.musicStatus = "loading";
			this.musicUrl = url;
			this.musicResolvedDirectUrl = resolvedDirectUrl;
			this.musicLastError = undefined;
			audioOutcome = await pending;
		}
		const visualizerMode = normalizeVisualizerMode(stringValue(args.visualizerMode ?? args.visualizer_mode));
		const publish = this.startStreamPublish({
			sourceKind: "music_visualizer",
			sourceUrl: url,
			resolvedDirectUrl,
			visualizerMode,
		});
		const audioStarted = audioOutcome?.ok === true;
		const ok = (!includeAudio || audioStarted) && publish.ok === true;
		const result: JsonRecord = {
			ok,
			url,
			resolvedDirectUrl,
			visualizerMode,
			audioStarted,
			streamPublish: publish,
		};
		if (audioOutcome !== undefined && !audioOutcome.ok) result.error = audioOutcome.error;
		return result;
	}

	private pauseMedia(): JsonRecord {
		this.stats.musicPauseRequestCount += 1;
		const vox = this.requireVox();
		vox.musicPause();
		this.musicStatus = this.musicStatus === "idle" ? "idle" : "paused";
		this.musicDuckedForSpeech = false;
		this.clearMusicUnduckTimer();
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
		this.musicDuckedForSpeech = false;
		this.clearMusicUnduckTimer();
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
			nativeStreamPublishSupported: this.discordCredential.credentialKind === "user-token",
		};
	}

	private startStreamPublish(input: {
		sourceKind: VoiceStreamPublishSourceKind;
		sourceUrl: string;
		resolvedDirectUrl: boolean;
		visualizerMode?: string;
	}): JsonRecord {
		this.stats.streamPublishRequestCount += 1;
		if (this.discordCredential.credentialKind !== "user-token") {
			this.stats.streamPublishUnsupportedCount += 1;
			return {
				ok: false,
				error: "Discord Go Live publish requires a user-token Discord credential.",
				credentialKind: this.discordCredential.credentialKind,
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
		const nativeWatchSupported = this.discordCredential.credentialKind === "user-token";
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
		if (this.discordCredential.credentialKind !== "user-token") {
			this.stats.screenWatchUnsupportedCount += 1;
			return {
				ok: false,
				error: "Native Discord Go Live watching requires a user-token Discord credential.",
				credentialKind: this.discordCredential.credentialKind,
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
		if (this.realtime?.supportsInputVideoFrames === false) {
			return {
				ok: false,
				error: "the selected realtime voice agent does not support Discord screen-share frame attachments",
				realtimeAgentProvider: this.config.realtimeAgentProvider ?? "openai",
			};
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
			if (normalized !== "playing") {
				this.musicDuckedForSpeech = false;
				this.clearMusicUnduckTimer();
			}
		}
	}

	private applyTransportState(state: ClankvoxTransportState): void {
		if (state.role !== "stream_publish") return;
		this.stats.streamPublishTransportEventCount += 1;
		if (state.status === "failed") {
			this.logVoice("warn", "clankvox_stream_publish_failed", { reason: state.reason });
		}
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
	config: ClankyAgentDiscordCredentialConfig,
	ttsProvider: DiscordVoiceTtsProvider = "openai",
	options: { participationEagerness?: number; supportsScreenShareSnapshots?: boolean } = {},
): string {
	const participationEagerness = options.participationEagerness ?? DEFAULT_PARTICIPATION_EAGERNESS;
	const lines = [
		"You are Clanky in a Discord group voice channel.",
		"You receive labeled text transcripts from individual Discord speakers; use those speaker names when attribution matters.",
		"When a Discord voice channel participant list is provided, use it as live room context. Muted participants can listen but may not be able to talk; deafened participants may not hear you.",
		`Participation eagerness: ${participationEagerness}/100. Lower values mean behave like a quieter participant; higher values mean join more often and help steer the room.`,
		"When a transcript batch is side chatter, backchanneling, or not a natural moment for Clanky to speak, call voice_stay_silent instead of producing speech. Do not say that you are staying silent.",
		"When music is playing, behave like a reserved music player: speak only for direct Clanky address or explicit media controls.",
		"Always speak for direct Clanky address, explicit tool/media requests, urgent corrections, or clear follow-ups to Clanky's last turn.",
		"Keep replies short enough for spoken conversation, and avoid reading long tool output verbatim.",
		"For anything beyond voice chat, call ask_pi and present the result as your own — don't refuse, and don't tell the user a subagent or Pi is involved.",
		"Use pi_status when users ask what Clanky, Pi, the voice bridge, or the main runtime is doing.",
		"Use pi_current_activity when users ask what the main agent is actively doing, what tool it is using, or what it said recently.",
		"Use pi_cancel when users ask to stop, cancel, interrupt, or redirect the main agent's current work.",
		"Use pi_subagents when users ask about workers, subagents, queue depth, active work, session files, or failures.",
		"The voice session has a small control surface by design; do not mirror main Pi tools directly. Delegate work with ask_pi and inspect state with pi_status, pi_current_activity, or pi_subagents.",
		"Use list_screen_shares when you need to inspect active Discord Go Live streams before choosing one.",
		"Use Pi as the reasoning and skill layer: for music/video requests that are search-like, ambiguous, or not already a direct URL, call ask_pi first and ask it to resolve a playable URL.",
		"Use play_music_url only when you already have an http(s) media URL. It plays audio into Discord voice.",
		"Use play_video_url only when you already have an http(s) video URL. It starts Discord Go Live publish and, by default, plays the audio into voice too.",
		"Use start_music_visualizer to show a Go Live visualizer for current music or a resolved music URL.",
		"Use media_pause, media_resume, media_stop, and media_status for live voice media controls.",
		`Discord credential kind: ${config.credentialKind}.`,
	];
	if (options.supportsScreenShareSnapshots ?? true) {
		lines.push(
			"Use start_screen_watch when a user asks you to look at a Discord Go Live screen share.",
			"Use stop_screen_watch when the active Discord Go Live screen watch is no longer needed or before changing context.",
			"Use see_screenshare_snapshot when you need the current screen-share image.",
		);
	} else {
		lines.push("This realtime agent cannot inspect Discord screen-share image frames directly.");
	}
	if (ttsProvider === "elevenlabs") {
		lines.push(
			"Your text output is spoken by ElevenLabs external TTS; write directly speakable text and avoid markdown formatting or stage directions unless requested.",
		);
	}
	return lines.join("\n");
}

function buildVoiceTools(options: { supportsScreenShareSnapshots?: boolean } = {}): OpenAiRealtimeTool[] {
	const tools: OpenAiRealtimeTool[] = [
		{
			type: "function",
			name: "voice_stay_silent",
			description:
				"Choose not to speak for the current Discord voice transcript batch when replying would feel unnatural, too eager, or like interrupting side chatter.",
			parameters: {
				type: "object",
				properties: {
					reason: {
						type: "string",
						description: "Brief reason, such as side_chatter, backchannel, low_relevance, or letting_humans_talk.",
					},
					confidence: {
						type: "number",
						description: "Confidence from 0 to 1 that staying silent is the right participant behavior.",
					},
					nextListenMs: {
						type: "number",
						description: "Optional suggested listening cooldown in milliseconds before Clanky should be eager again.",
					},
				},
				required: ["reason"],
				additionalProperties: false,
			},
		},
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
			name: "pi_current_activity",
			description: "Return the main Pi runtime's active tools, recent tool activity, and recent assistant messages.",
			parameters: {
				type: "object",
				properties: {
					limit: {
						type: "number",
						description: "Maximum recent tools and assistant messages to return, from 1 to 20. Defaults to 5.",
					},
				},
				additionalProperties: false,
			},
		},
		{
			type: "function",
			name: "pi_cancel",
			description: "Cancel or interrupt the main Pi runtime's active work and clear queued main-runtime messages.",
			parameters: {
				type: "object",
				properties: {
					reason: {
						type: "string",
						description: "Brief user-facing reason for the cancellation.",
					},
				},
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
				"Stream a resolved http(s) video URL through Discord Go Live and optionally play its audio in voice. Requires a user-token Discord credential for Go Live. If the source has no audio track the result is still ok=true with audioStarted=false and audioSkippedReason='source_has_no_audio_track' — that is not a failure, the video is playing silently.",
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
	if (options.supportsScreenShareSnapshots ?? true) {
		tools.splice(
			4,
			0,
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
		);
	}
	return tools;
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
			const terminalError = assistantTerminalError(event);
			if (terminalError !== undefined) {
				finish(undefined, terminalError);
				return;
			}
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
	return assistantMessageText(event.message);
}

function assistantTerminalError(event: AgentSessionEvent): Error | undefined {
	if (event.type !== "message_end" || event.message.role !== "assistant") return undefined;
	if (event.message.stopReason !== "aborted" && event.message.stopReason !== "error") return undefined;
	const message = event.message.errorMessage ?? `Pi response ${event.message.stopReason}.`;
	return new Error(message);
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

function parseDiscordVoiceRealtimeAgentProvider(
	value: string | undefined,
): DiscordVoiceRealtimeAgentProvider | undefined {
	const normalized = value?.trim().toLowerCase();
	if (normalized === "openai") return "openai";
	if (normalized === "xai" || normalized === "grok") return "xai";
	return undefined;
}

function realtimeAgentModelForConfig(config: ClankyAgentDiscordVoiceConfig): string {
	return (config.realtimeAgentProvider ?? "openai") === "xai"
		? (config.xAiRealtimeModel ?? DEFAULT_XAI_REALTIME_MODEL)
		: config.openAiRealtimeModel;
}

function realtimeAgentVoiceForConfig(config: ClankyAgentDiscordVoiceConfig): string {
	return (config.realtimeAgentProvider ?? "openai") === "xai"
		? (config.xAiRealtimeVoice ?? DEFAULT_XAI_REALTIME_VOICE)
		: config.openAiRealtimeVoice;
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

function parseOptionalBoundedInteger(value: string | undefined, min: number, max: number): number | undefined {
	const normalized = value?.trim();
	if (normalized === undefined || normalized.length === 0) return undefined;
	const parsed = Number.parseInt(normalized, 10);
	if (!Number.isFinite(parsed)) return undefined;
	const integer = Math.trunc(parsed);
	if (integer < min) return min;
	if (integer > max) return max;
	return integer;
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

// ffmpeg with `-f s16le ... pipe:1` exits with "Output file does not contain any stream"
// when the input has no audio track to map to PCM output. Treat that as a missing audio
// track rather than a pipeline error.
function isNoAudioTrackError(error: string): boolean {
	return /does not contain any stream/i.test(error);
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

function boundedNumberValue(value: unknown, fallback: number, min: number, max: number): number {
	const parsed =
		typeof value === "number" ? value : typeof value === "string" && value.trim().length > 0 ? Number(value) : NaN;
	if (!Number.isFinite(parsed)) return fallback;
	if (parsed < min) return min;
	if (parsed > max) return max;
	return parsed;
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

function splitExternalTtsText(text: string): string[] {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length === 0) return [];
	if (normalized.length <= EXTERNAL_TTS_SEGMENT_MAX_CHARS) return [normalized];
	const sentenceParts = normalized.match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g) ?? [normalized];
	const segments: string[] = [];
	let current = "";
	for (const rawPart of sentenceParts) {
		const part = rawPart.trim();
		if (part.length === 0) continue;
		if (part.length > EXTERNAL_TTS_SEGMENT_MAX_CHARS) {
			if (current.length > 0) {
				segments.push(current);
				current = "";
			}
			segments.push(...splitLongExternalTtsTextPart(part));
			continue;
		}
		const candidate = current.length === 0 ? part : `${current} ${part}`;
		if (candidate.length <= EXTERNAL_TTS_SEGMENT_TARGET_CHARS || current.length === 0) {
			current = candidate;
			continue;
		}
		segments.push(current);
		current = part;
	}
	if (current.length > 0) segments.push(current);
	return segments;
}

function splitLongExternalTtsTextPart(text: string): string[] {
	const words = text.split(/\s+/).filter((word) => word.length > 0);
	const segments: string[] = [];
	let current = "";
	for (const word of words) {
		if (word.length > EXTERNAL_TTS_SEGMENT_MAX_CHARS) {
			if (current.length > 0) {
				segments.push(current);
				current = "";
			}
			for (let offset = 0; offset < word.length; offset += EXTERNAL_TTS_SEGMENT_MAX_CHARS) {
				segments.push(word.slice(offset, offset + EXTERNAL_TTS_SEGMENT_MAX_CHARS));
			}
			continue;
		}
		const candidate = current.length === 0 ? word : `${current} ${word}`;
		if (candidate.length <= EXTERNAL_TTS_SEGMENT_MAX_CHARS) {
			current = candidate;
			continue;
		}
		segments.push(current);
		current = word;
	}
	if (current.length > 0) segments.push(current);
	return segments;
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

function splitPcm16Base64Chunks(pcmBase64: string, sampleRate: number): RealtimeAudioOutputChunk[] {
	if (sampleRate <= 0) return [];
	let pcm: Buffer;
	try {
		pcm = Buffer.from(pcmBase64, "base64");
	} catch {
		return [];
	}
	const usableLength = pcm.length - (pcm.length % 2);
	if (usableLength <= 0) return [];

	const maxSamples = Math.max(1, Math.floor((sampleRate * REALTIME_AUDIO_OUTPUT_TARGET_CHUNK_MS) / 1_000));
	const maxBytes = Math.max(2, maxSamples * 2);
	const chunks: RealtimeAudioOutputChunk[] = [];
	for (let offset = 0; offset < usableLength; offset += maxBytes) {
		const end = Math.min(usableLength, offset + maxBytes);
		const slice = pcm.subarray(offset, end);
		chunks.push({
			pcmBase64: slice.toString("base64"),
			sampleRate,
			durationMs: Math.max(MIN_REALTIME_AUDIO_OUTPUT_DELAY_MS, pcm16DurationMs(slice.length, sampleRate)),
		});
	}
	return chunks;
}

function pcm16DurationMs(byteLength: number, sampleRate: number): number {
	if (byteLength <= 0 || sampleRate <= 0) return 0;
	return ((byteLength / 2) * 1_000) / sampleRate;
}

function isAbortSignalAborted(signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true;
}

function sleepWithAbort(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
	if (isAbortSignalAborted(signal)) return Promise.resolve(false);
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve(true);
		}, ms);
		const onAbort = (): void => {
			signal?.removeEventListener("abort", onAbort);
			clearTimeout(timer);
			resolve(false);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		if (isAbortSignalAborted(signal)) onAbort();
	});
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
	const directGet = container.get;
	if (typeof directGet === "function") return directGet.call(container, id);
	const cache = isRecord(container.cache) ? container.cache : undefined;
	const get = cache?.get;
	return typeof get === "function" ? get.call(cache, id) : undefined;
}

function formatDiscordVoiceChannelParticipants(guild: unknown, client: unknown, channelId: string): string | undefined {
	const participants = readDiscordVoiceChannelParticipants(guild, client, channelId)
		.filter((participant) => !participant.isBot)
		.sort((left, right) => left.displayName.localeCompare(right.displayName, undefined, { sensitivity: "base" }));
	if (participants.length === 0) return undefined;
	const maxParticipants = 16;
	const visibleParticipants = participants.slice(0, maxParticipants).map(formatDiscordVoiceParticipant);
	const hiddenCount = participants.length - visibleParticipants.length;
	if (hiddenCount > 0) visibleParticipants.push(`${hiddenCount} more`);
	return visibleParticipants.join(", ");
}

function readDiscordVoiceChannelParticipants(
	guild: unknown,
	client: unknown,
	channelId: string,
): DiscordVoiceParticipant[] {
	const normalizedChannelId = channelId.trim();
	if (normalizedChannelId.length === 0) return [];
	const selfUserId = readClientUserId(client);
	const participantsById = new Map<string, DiscordVoiceParticipant>();
	const mergeParticipant = (candidate: DiscordVoiceParticipantCandidate) => {
		const userId = candidate.userId?.trim();
		if (userId === undefined || userId.length === 0 || userId === selfUserId) return;
		const existing = participantsById.get(userId);
		participantsById.set(userId, {
			userId,
			displayName:
				candidate.displayName !== undefined && candidate.displayName.trim().length > 0
					? normalizePromptLine(candidate.displayName)
					: (existing?.displayName ?? readDiscordDisplayName(guild, client, userId) ?? `User ${userId}`),
			muted: existing?.muted === true || candidate.muted === true,
			deafened: existing?.deafened === true || candidate.deafened === true,
			isBot: existing?.isBot === true || candidate.isBot === true,
		});
	};

	for (const member of readDiscordVoiceChannelMembers(guild, normalizedChannelId)) {
		const voice = readDiscordMemberVoice(member);
		mergeParticipant({
			userId: readDiscordMemberUserId(member),
			displayName: readDiscordMemberDisplayName(member),
			muted: readDiscordVoiceMuted(voice),
			deafened: readDiscordVoiceDeafened(voice),
			isBot: readDiscordMemberIsBot(member),
		});
	}

	for (const state of readDiscordVoiceStates(guild, normalizedChannelId)) {
		const member = isRecord(state) ? state.member : undefined;
		const user = isRecord(state) ? state.user : undefined;
		const userId = readDiscordVoiceStateUserId(state) ?? readDiscordMemberUserId(member);
		mergeParticipant({
			userId,
			displayName: readDiscordMemberDisplayName(member) ?? discordDisplayNameFromRecord(user),
			muted: readDiscordVoiceMuted(state),
			deafened: readDiscordVoiceDeafened(state),
			isBot: readDiscordMemberIsBot(member) || readDiscordUserIsBot(user),
		});
	}

	return Array.from(participantsById.values());
}

function readDiscordVoiceChannelMembers(guild: unknown, channelId: string): unknown[] {
	const channel = readDiscordVoiceChannel(guild, channelId);
	const channelMembers = readCachedValues(isRecord(channel) ? channel.members : undefined);
	if (channelMembers.length > 0) return channelMembers;
	return readCachedValues(isRecord(guild) ? guild.members : undefined).filter((member) =>
		discordVoiceBelongsToChannel(readDiscordMemberVoice(member), channelId),
	);
}

function readDiscordVoiceChannel(guild: unknown, channelId: string): unknown {
	if (!isRecord(guild)) return undefined;
	return readCachedById(guild.channels, channelId);
}

function readDiscordVoiceStates(guild: unknown, channelId: string): unknown[] {
	if (!isRecord(guild)) return [];
	const states = readCachedValues(isRecord(guild.voiceStates) ? guild.voiceStates : undefined);
	return states.filter((state) => discordVoiceBelongsToChannel(state, channelId));
}

function readCachedValues(container: unknown): unknown[] {
	if (Array.isArray(container)) return container;
	if (!isRecord(container)) return [];
	const directValues = callValuesFunction(container);
	if (directValues.length > 0) return directValues;
	return callValuesFunction(container.cache);
}

function callValuesFunction(container: unknown): unknown[] {
	if (!isRecord(container)) return [];
	const values = container.values;
	if (typeof values !== "function") return [];
	const result = values.call(container);
	return isIterable(result) ? Array.from(result) : [];
}

function readClientUserId(client: unknown): string | undefined {
	const user = isRecord(client) ? client.user : undefined;
	const userId = stringValue(isRecord(user) ? user.id : undefined);
	return userId.length > 0 ? userId : undefined;
}

function readDiscordMemberVoice(member: unknown): unknown {
	return isRecord(member) ? member.voice : undefined;
}

function readDiscordMemberUserId(member: unknown): string | undefined {
	if (!isRecord(member)) return undefined;
	const user = isRecord(member.user) ? member.user : undefined;
	const userId =
		stringValue(member.id) || stringValue(member.userId) || stringValue(member.user_id) || stringValue(user?.id);
	return userId.length > 0 ? userId : undefined;
}

function readDiscordVoiceStateUserId(state: unknown): string | undefined {
	if (!isRecord(state)) return undefined;
	const user = isRecord(state.user) ? state.user : undefined;
	const userId =
		stringValue(state.userId) || stringValue(state.user_id) || stringValue(state.id) || stringValue(user?.id);
	return userId.length > 0 ? userId : undefined;
}

function readDiscordMemberDisplayName(member: unknown): string | undefined {
	const memberName = discordDisplayNameFromRecord(member);
	if (memberName !== undefined) return memberName;
	return isRecord(member) ? discordDisplayNameFromRecord(member.user) : undefined;
}

function readDiscordMemberIsBot(member: unknown): boolean {
	if (!isRecord(member)) return false;
	return booleanValue(member.bot, false) || readDiscordUserIsBot(member.user);
}

function readDiscordUserIsBot(user: unknown): boolean {
	return isRecord(user) ? booleanValue(user.bot, false) : false;
}

function readDiscordVoiceMuted(voice: unknown): boolean {
	if (!isRecord(voice)) return false;
	return (
		booleanValue(voice.mute, false) || booleanValue(voice.selfMute, false) || booleanValue(voice.serverMute, false)
	);
}

function readDiscordVoiceDeafened(voice: unknown): boolean {
	if (!isRecord(voice)) return false;
	return (
		booleanValue(voice.deaf, false) || booleanValue(voice.selfDeaf, false) || booleanValue(voice.serverDeaf, false)
	);
}

function discordVoiceBelongsToChannel(voice: unknown, channelId: string): boolean {
	if (!isRecord(voice)) return false;
	const directChannelId = stringValue(voice.channelId) || stringValue(voice.channel_id);
	if (directChannelId === channelId) return true;
	const channel = isRecord(voice.channel) ? voice.channel : undefined;
	return stringValue(channel?.id) === channelId;
}

function formatDiscordVoiceParticipant(participant: DiscordVoiceParticipant): string {
	const flags = [participant.deafened ? "deafened" : undefined, participant.muted ? "muted" : undefined].filter(
		(flag): flag is string => flag !== undefined,
	);
	return flags.length === 0 ? participant.displayName : `${participant.displayName} (${flags.join("/")})`;
}

function normalizePromptLine(value: string): string {
	return value.trim().replace(/\s+/g, " ");
}

function discordDisplayNameFromRecord(value: unknown): string | undefined {
	if (!isRecord(value)) return undefined;
	for (const field of ["displayName", "nickname", "globalName", "username", "tag"]) {
		const text = stringValue(value[field]);
		if (text.length > 0) return normalizePromptLine(text);
	}
	return undefined;
}

function resolveVoiceBargeInWakeWords(
	config: Pick<ClankyAgentDiscordVoiceConfig, "wakeNames">,
	username?: string,
): string[] {
	return dedupeWakeNames([...DEFAULT_VOICE_BARGE_IN_WAKE_WORDS, ...(config.wakeNames ?? []), username ?? ""]);
}

function transcriptDirectlyAddressesAssistant(text: string, wakeWords: readonly string[]): boolean {
	for (const wakeWord of wakeWords) {
		if (isVoiceWakeNameAddressed({ transcript: text, botName: wakeWord })) return true;
		if (containsVoiceWakeNameMention({ transcript: text, botName: wakeWord })) return true;
	}
	return false;
}

function transcriptLikelyAddressesAssistant(text: string, wakeWords: readonly string[]): boolean {
	for (const wakeWord of wakeWords) {
		if (hasLikelyVoiceWakeNameCue({ transcript: text, botName: wakeWord })) return true;
	}
	return false;
}

function looksLikeMusicControlRequest(text: string): boolean {
	const tokens = tokenizeWakeTokens(text);
	if (tokens.length === 0) return false;
	const tokenSet = new Set(tokens);
	const hasMediaNoun = tokens.some((token) =>
		["music", "song", "track", "audio", "playlist", "radio", "tune", "sound", "volume", "media", "video"].includes(
			token,
		),
	);
	const hasControlVerb = tokens.some((token) =>
		[
			"pause",
			"paused",
			"resume",
			"continue",
			"stop",
			"skip",
			"restart",
			"replay",
			"play",
			"quiet",
			"quieter",
			"louder",
			"mute",
			"unmute",
			"lower",
			"raise",
			"turn",
		].includes(token),
	);
	if (hasMediaNoun && hasControlVerb) return true;
	if ((tokenSet.has("pause") || tokenSet.has("resume") || tokenSet.has("stop")) && tokenSet.has("it")) return true;
	return tokenSet.has("resume") && (tokenSet.has("playing") || tokenSet.has("playback"));
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

function isIterable(value: unknown): value is Iterable<unknown> {
	return (
		value !== null &&
		typeof value === "object" &&
		typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] === "function"
	);
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}
