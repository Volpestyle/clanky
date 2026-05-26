import type { DiscordGatewayClient } from "@agentroom/chat-discord";
import { resolveOpenAiApiKeySync } from "@clanky/core";
import type { AgentSessionEvent, AgentSessionRuntime, AuthStorage } from "@earendil-works/pi-coding-agent";
import { type ClankyAgentDiscordGatewayConfig, resolveAgentDiscordCredentialConfig } from "./agentDiscordGateway.ts";
import { type RuntimeTurnQueue, SerialRuntimeTurnQueue } from "./runtimeTurnQueue.ts";
import {
	type ClankvoxDecodedVideoFrame,
	type ClankvoxGuildLike,
	ClankvoxIpcClient,
	type ClankvoxSpawnOptions,
} from "./voice/clankvoxIpcClient.ts";
import {
	bindClankvoxRealtimeBridge,
	type ClankvoxRealtimeBridgeRealtime,
	type ClankvoxRealtimeBridgeVox,
} from "./voice/clankvoxRealtimeBridge.ts";
import {
	createDiscordStreamDiscovery,
	type DiscordRawGatewayClient,
	type DiscordStreamDiscovery,
	type DiscoveredDiscordStream,
	deriveDiscordStreamWatchDaveChannelId,
} from "./voice/discordStreamDiscovery.ts";
import type { DiscordVoiceTurnBuffer } from "./voice/discordVoiceTurnBuffer.ts";
import {
	OpenAiRealtimeClient,
	type OpenAiRealtimeClientOptions,
	type OpenAiRealtimeConnectOptions,
	type OpenAiRealtimeTool,
	type OpenAiRealtimeTranscript,
} from "./voice/openAiRealtimeClient.ts";

type JsonRecord = Record<string, unknown>;

export interface ClankyAgentDiscordVoiceConfig {
	enabled: boolean;
	guildId: string;
	channelId: string;
	openAiApiKey: string;
	openAiBaseUrl?: string;
	openAiRealtimeModel: string;
	openAiRealtimeVoice: string;
	clankvoxBin?: string;
	clankvoxDir?: string;
	videoFrameAutoAttachIntervalMs?: number;
}

export interface StartAgentDiscordVoiceBridgeInput {
	runtime: AgentSessionRuntime;
	client: DiscordGatewayClient;
	discordConfig: ClankyAgentDiscordGatewayConfig;
	authStorage?: AuthStorage;
	config?: ClankyAgentDiscordVoiceConfig;
	runtimeTurnQueue?: RuntimeTurnQueue;
	dependencies?: ClankyAgentDiscordVoiceDependencies;
}

export interface ClankyAgentDiscordVoiceHandle {
	stop(): Promise<void>;
	status(): JsonRecord;
	requestTextUtterance(text: string): void;
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

interface VoiceBridgeStats {
	speakingStartCount: number;
	speakingEndCount: number;
	discordInputUniqueSpeakerCount: number;
	discordInputMaxConcurrentSpeakers: number;
	discordInputGroupOverlapCount: number;
	discordInputAudioEventCount: number;
	discordInputAudioBytes: number;
	discordInputAudioEndCount: number;
	realtimeAudioDeltaCount: number;
	realtimeAudioDeltaBytes: number;
	discordOutputAudioSendCount: number;
	realtimeEventCount: number;
	realtimeErrorEventCount: number;
	realtimeSocketCloseCount: number;
	realtimeSocketErrorCount: number;
	realtimeTranscriptCount: number;
	realtimeFunctionCallCount: number;
	realtimeFunctionCallOutputCount: number;
	realtimeFunctionCallErrorCount: number;
	askPiCallCount: number;
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
}

export interface ClankyAgentDiscordVoiceDependencies {
	createRealtime?(options: OpenAiRealtimeClientOptions): VoiceRealtimeClientLike;
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
}

interface VoiceRealtimeClientLike extends ClankvoxRealtimeBridgeRealtime {
	connect(options: OpenAiRealtimeConnectOptions): Promise<void>;
	close(): Promise<void>;
	requestTextUtterance(text: string): void;
	sendFunctionCallOutput(input: { callId: string; output: unknown }): void;
	on(event: "audio_delta", listener: (pcmBase64: string) => void): unknown;
	on(event: "socket_closed", listener: (event: JsonRecord) => void): unknown;
	on(event: "socket_error", listener: (error: Error) => void): unknown;
	on(event: "transcript", listener: (transcript: OpenAiRealtimeTranscript) => void): unknown;
	on(event: "event" | "error_event", listener: (event: JsonRecord) => void): unknown;
}

interface VoiceVoxClientLike extends ClankvoxRealtimeBridgeVox {
	readonly isAlive: boolean;
	sendAudio(pcmBase64: string, sampleRate?: number): void;
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
	getLastVoiceSessionId(): string | undefined;
	destroy(): Promise<void>;
}

interface ResolvedVoiceDependencies {
	createRealtime(options: OpenAiRealtimeClientOptions): VoiceRealtimeClientLike;
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
}

export const DEFAULT_REALTIME_MODEL = "gpt-realtime-2";
const DEFAULT_REALTIME_VOICE = "marin";
const DEFAULT_VIDEO_FRAME_AUTO_ATTACH_INTERVAL_MS = 2_000;
const PI_TOOL_TIMEOUT_MS = 120_000;

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
		realtimeAudioDeltaCount: 0,
		realtimeAudioDeltaBytes: 0,
		discordOutputAudioSendCount: 0,
		realtimeEventCount: 0,
		realtimeErrorEventCount: 0,
		realtimeSocketCloseCount: 0,
		realtimeSocketErrorCount: 0,
		realtimeTranscriptCount: 0,
		realtimeFunctionCallCount: 0,
		realtimeFunctionCallOutputCount: 0,
		realtimeFunctionCallErrorCount: 0,
		askPiCallCount: 0,
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
	};
}

function resolveVoiceDependencies(
	dependencies: ClankyAgentDiscordVoiceDependencies | undefined,
): ResolvedVoiceDependencies {
	return {
		createRealtime: dependencies?.createRealtime ?? ((options) => new OpenAiRealtimeClient(options)),
		spawnVox:
			dependencies?.spawnVox ??
			((guildId, channelId, guild, options) => ClankvoxIpcClient.spawn(guildId, channelId, guild, options)),
		createStreamDiscovery: dependencies?.createStreamDiscovery ?? createDiscordStreamDiscovery,
	};
}

export function resolveAgentDiscordVoiceConfig(
	env: NodeJS.ProcessEnv = process.env,
	discordConfig?: ClankyAgentDiscordGatewayConfig,
	authStorage?: AuthStorage,
): ClankyAgentDiscordVoiceConfig | undefined {
	if (!parseEnabled(env.CLANKY_DISCORD_VOICE_ENABLED ?? env.CLANKY_DISCORD_VOICE)) return undefined;
	const config = discordConfig ?? resolveAgentDiscordCredentialConfig(env);
	if (config === undefined) {
		throw new Error(
			"CLANKY_DISCORD_TOKEN or a stored /discord-login credential is required when Discord voice is enabled.",
		);
	}
	const guildId = env.CLANKY_DISCORD_VOICE_GUILD_ID?.trim();
	const channelId = env.CLANKY_DISCORD_VOICE_CHANNEL_ID?.trim();
	if (guildId === undefined || guildId.length === 0) {
		throw new Error("CLANKY_DISCORD_VOICE_GUILD_ID is required when Discord voice is enabled.");
	}
	if (channelId === undefined || channelId.length === 0) {
		throw new Error("CLANKY_DISCORD_VOICE_CHANNEL_ID is required when Discord voice is enabled.");
	}
	const openAiApiKey = resolveOpenAiApiKeySync(env, authStorage);
	if (openAiApiKey === undefined) {
		throw new Error(
			"OpenAI credentials are required when Discord voice is enabled. Run /openai-login or set OPENAI_API_KEY/CLANKY_OPENAI_API_KEY.",
		);
	}
	const voiceConfig: ClankyAgentDiscordVoiceConfig = {
		enabled: true,
		guildId,
		channelId,
		openAiApiKey: openAiApiKey.value,
		openAiRealtimeModel: env.CLANKY_OPENAI_REALTIME_MODEL?.trim() || DEFAULT_REALTIME_MODEL,
		openAiRealtimeVoice: env.CLANKY_OPENAI_REALTIME_VOICE?.trim() || DEFAULT_REALTIME_VOICE,
		videoFrameAutoAttachIntervalMs: parseNonNegativeInteger(
			env.CLANKY_DISCORD_VOICE_VIDEO_FRAME_INTERVAL_MS,
			DEFAULT_VIDEO_FRAME_AUTO_ATTACH_INTERVAL_MS,
		),
	};
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
	const bridge = new AgentDiscordVoiceBridge(
		input.runtime,
		input.client as DiscordVoiceClient,
		input.discordConfig,
		config,
		input.runtimeTurnQueue ?? new SerialRuntimeTurnQueue(),
		resolveVoiceDependencies(input.dependencies),
	);
	await bridge.start();
	return bridge;
}

class AgentDiscordVoiceBridge implements ClankyAgentDiscordVoiceHandle {
	private readonly runtime: AgentSessionRuntime;
	private readonly client: DiscordVoiceClient;
	private readonly discordConfig: ClankyAgentDiscordGatewayConfig;
	private readonly config: ClankyAgentDiscordVoiceConfig;
	private readonly runtimeTurnQueue: RuntimeTurnQueue;
	private readonly dependencies: ResolvedVoiceDependencies;
	private realtime: VoiceRealtimeClientLike | undefined;
	private vox: VoiceVoxClientLike | undefined;
	private streamDiscovery: DiscordStreamDiscovery | undefined;
	private voiceTurnBuffer: DiscordVoiceTurnBuffer | undefined;
	private latestFrame: ClankvoxDecodedVideoFrame | undefined;
	private requestedStreamWatchKey: string | undefined;
	private activeStreamWatchKey: string | undefined;
	private activeVideoUserId: string | undefined;
	private lastVideoFrameAttachedAt = 0;
	private readonly activeSpeakingUserIds = new Set<string>();
	private readonly seenInputSpeakerIds = new Set<string>();
	private readonly pendingToolCalls = new Map<string, PendingRealtimeToolCall>();
	private readonly completedToolCallIds: string[] = [];
	private readonly completedToolCallIdSet = new Set<string>();
	private readonly stats: VoiceBridgeStats = createVoiceBridgeStats();

	constructor(
		runtime: AgentSessionRuntime,
		client: DiscordVoiceClient,
		discordConfig: ClankyAgentDiscordGatewayConfig,
		config: ClankyAgentDiscordVoiceConfig,
		runtimeTurnQueue: RuntimeTurnQueue,
		dependencies: ResolvedVoiceDependencies,
	) {
		this.runtime = runtime;
		this.client = client;
		this.discordConfig = discordConfig;
		this.config = config;
		this.runtimeTurnQueue = runtimeTurnQueue;
		this.dependencies = dependencies;
	}

	async start(): Promise<void> {
		if (!this.client.isReady()) {
			throw new Error("Discord voice bridge requires the shared Discord client to be ready.");
		}
		this.streamDiscovery = this.dependencies.createStreamDiscovery(this.client as unknown as DiscordRawGatewayClient, {
			onStreamCredentials: (stream) => {
				if (stream.streamKey === this.requestedStreamWatchKey) this.connectStreamWatch(stream);
			},
			onStreamDeleted: (stream) => {
				if (stream.streamKey !== this.activeStreamWatchKey && stream.streamKey !== this.requestedStreamWatchKey) return;
				this.clearScreenWatch("stream_deleted");
			},
		});
		let realtime: VoiceRealtimeClientLike | undefined;
		let vox: VoiceVoxClientLike | undefined;
		try {
			const guild = await this.resolveGuild(this.config.guildId);
			const realtimeOptions: ConstructorParameters<typeof OpenAiRealtimeClient>[0] = {
				apiKey: this.config.openAiApiKey,
				logger: (level, event, details) => console[level](`[discord-voice] ${event}`, details ?? {}),
			};
			if (this.config.openAiBaseUrl !== undefined) realtimeOptions.baseUrl = this.config.openAiBaseUrl;
			realtime = this.dependencies.createRealtime(realtimeOptions);
			const voxOptions: ClankvoxSpawnOptions = {
				selfDeaf: false,
				selfMute: false,
			};
			if (this.config.clankvoxBin !== undefined) voxOptions.bin = this.config.clankvoxBin;
			if (this.config.clankvoxDir !== undefined) voxOptions.cwd = this.config.clankvoxDir;
			vox = await this.dependencies.spawnVox(this.config.guildId, this.config.channelId, guild, voxOptions);
			this.realtime = realtime;
			this.vox = vox;
			this.bindVox(vox, realtime);
			this.bindRealtime(realtime);
			await realtime.connect({
				model: this.config.openAiRealtimeModel,
				voice: this.config.openAiRealtimeVoice,
				instructions: buildRealtimeInstructions(this.discordConfig),
				tools: buildVoiceTools(),
				toolChoice: "auto",
			});
		} catch (error) {
			this.streamDiscovery?.stop();
			this.streamDiscovery = undefined;
			this.voiceTurnBuffer?.dispose();
			this.voiceTurnBuffer = undefined;
			await realtime?.close().catch(() => undefined);
			await vox?.destroy().catch(() => undefined);
			this.realtime = undefined;
			this.vox = undefined;
			throw error;
		}
	}

	async stop(): Promise<void> {
		this.streamDiscovery?.stop();
		this.streamDiscovery = undefined;
		this.clearScreenWatch("voice_bridge_stop");
		this.activeStreamWatchKey = undefined;
		this.requestedStreamWatchKey = undefined;
		this.voiceTurnBuffer?.dispose();
		this.voiceTurnBuffer = undefined;
		this.activeSpeakingUserIds.clear();
		this.seenInputSpeakerIds.clear();
		await this.realtime?.close();
		this.realtime = undefined;
		await this.vox?.destroy();
		this.vox = undefined;
	}

	requestTextUtterance(text: string): void {
		const prompt = text.trim();
		if (prompt.length === 0) return;
		if (this.realtime === undefined) throw new Error("Discord voice realtime client is not connected.");
		this.realtime.requestTextUtterance(prompt);
	}

	status(): JsonRecord {
		return {
			enabled: this.config.enabled,
			guildId: this.config.guildId,
			channelId: this.config.channelId,
			model: this.config.openAiRealtimeModel,
			voice: this.config.openAiRealtimeVoice,
			discordCredentialKind: this.discordConfig.credentialKind,
			nativeScreenWatchSupported: this.discordConfig.credentialKind === "user-token",
			hasVox: this.vox?.isAlive === true,
			discoveredStreams: this.streamDiscovery?.listStreams().length ?? 0,
			hasLatestFrame: this.latestFrame !== undefined,
			requestedStreamWatchKey: this.requestedStreamWatchKey,
			activeStreamWatchKey: this.activeStreamWatchKey,
			activeVideoUserId: this.activeVideoUserId,
			voiceTurn: this.voiceTurnBuffer?.status(),
			stats: { ...this.stats },
		};
	}

	private bindVox(vox: VoiceVoxClientLike, realtime: VoiceRealtimeClientLike): void {
		vox.on("speakingStart", (userId) => {
			this.stats.speakingStartCount += 1;
			this.trackSpeakingStart(userId);
		});
		vox.on("speakingEnd", (userId) => {
			this.stats.speakingEndCount += 1;
			this.trackSpeakingEnd(userId);
		});
		vox.on("userAudio", (userId, pcm) => {
			this.trackInputSpeaker(userId);
			this.stats.discordInputAudioEventCount += 1;
			this.stats.discordInputAudioBytes += pcm.length;
		});
		vox.on("userAudioEnd", (userId) => {
			this.trackSpeakingEnd(userId);
			this.stats.discordInputAudioEndCount += 1;
		});
		this.voiceTurnBuffer = bindClankvoxRealtimeBridge({
			vox,
			realtime,
			onDecodedVideoFrame: (frame) => {
				this.latestFrame = frame;
				this.stats.decodedVideoFrameCount += 1;
				this.maybeAppendDecodedVideoFrame(frame);
			},
			onIpcError: (event) => {
				console.warn("[discord-voice] clankvox ipc error", event);
			},
			turnBuffer: {
				onError: (error) => console.warn("[discord-voice] turn buffer error", error),
			},
			autoAppendDecodedVideoFrames: false,
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
			this.stats.discordOutputAudioSendCount += 1;
			this.vox?.sendAudio(pcmBase64, 24_000);
		});
		realtime.on("event", (event: JsonRecord) => {
			this.stats.realtimeEventCount += 1;
			void this.handleRealtimeEvent(event).catch((error: unknown) => {
				console.error(error instanceof Error ? error.message : String(error));
			});
		});
		realtime.on("error_event", (event: JsonRecord) => {
			this.stats.realtimeErrorEventCount += 1;
			console.warn("[discord-voice] openai realtime error", event);
		});
		realtime.on("socket_closed", (event: JsonRecord) => {
			this.stats.realtimeSocketCloseCount += 1;
			console.warn("[discord-voice] openai realtime socket closed", event);
		});
		realtime.on("socket_error", (error: Error) => {
			this.stats.realtimeSocketErrorCount += 1;
			console.warn("[discord-voice] openai realtime socket error", error.message);
		});
		realtime.on("transcript", () => {
			this.stats.realtimeTranscriptCount += 1;
		});
	}

	private async handleRealtimeEvent(event: JsonRecord): Promise<void> {
		const envelopes = extractRealtimeFunctionCallEnvelopes(event);
		if (envelopes.length === 0) return;
		for (const envelope of envelopes) {
			await this.handleRealtimeFunctionCallEnvelope(envelope);
		}
	}

	private async handleRealtimeFunctionCallEnvelope(envelope: RealtimeFunctionCallEnvelope): Promise<void> {
		if (this.completedToolCallIdSet.has(envelope.callId)) return;
		const existing = this.pendingToolCalls.get(envelope.callId);
		const pending: PendingRealtimeToolCall = {
			callId: envelope.callId,
			name: envelope.name || existing?.name || "",
			argumentsJson: `${existing?.argumentsJson ?? ""}${envelope.argumentsDelta ?? ""}`,
		};
		if (envelope.argumentsJson !== undefined) pending.argumentsJson = envelope.argumentsJson;
		this.pendingToolCalls.set(pending.callId, pending);
		if (!envelope.done) return;
		this.pendingToolCalls.delete(pending.callId);
		this.stats.realtimeFunctionCallCount += 1;
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
		this.rememberCompletedToolCallId(pending.callId);
		this.stats.realtimeFunctionCallOutputCount += 1;
		this.realtime?.createAudioResponse();
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
			this.stats.askPiCallCount += 1;
			return { text: await this.askPi(stringValue(args.prompt)) };
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
		return { error: `Unknown Discord voice tool: ${call.name}` };
	}

	private async askPi(prompt: string): Promise<string> {
		if (prompt.trim().length === 0) throw new Error("ask_pi requires prompt.");
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
			console.warn("[discord-voice] could not derive stream watch DAVE channel id", {
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

	private async resolveGuild(guildId: string): Promise<ClankvoxGuildLike> {
		const cached = this.client.guilds.cache.get(guildId);
		const guild = cached ?? (await this.client.guilds.fetch(guildId));
		if (!isRecord(guild)) throw new Error(`Discord guild ${guildId} could not be resolved.`);
		return guild as ClankvoxGuildLike;
	}
}

function buildRealtimeInstructions(config: ClankyAgentDiscordGatewayConfig): string {
	return [
		"You are Clanky in a Discord group voice channel.",
		"Listen to multiple speakers, keep replies short enough for spoken conversation, and avoid reading long tool output verbatim.",
		"Use ask_pi for durable work, memory-backed answers, coding tasks, Linear, MCP, or anything that should go through the Pi agent runtime.",
		"Use list_screen_shares when you need to inspect active Discord Go Live streams before choosing one.",
		"Use start_screen_watch when a user asks you to look at a Discord Go Live screen share.",
		"Use stop_screen_watch when the active Discord Go Live screen watch is no longer needed or before changing context.",
		"Use see_screenshare_snapshot when you need the current screen-share image.",
		`Discord credential kind: ${config.credentialKind}.`,
	].join("\n");
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

function parseEnabled(value: string | undefined): boolean {
	const normalized = value?.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function parseNonNegativeInteger(value: string | undefined, fallback: number): number {
	const normalized = value?.trim();
	if (normalized === undefined || normalized.length === 0) return fallback;
	const parsed = Number.parseInt(normalized, 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
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
