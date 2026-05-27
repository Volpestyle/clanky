import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
	DiscordSubagentStore,
	resolveClankyPaths,
	saveStoredElevenLabsApiKey,
	saveStoredXAiApiKey,
} from "@clanky/core";
import {
	type AgentSessionEvent,
	AuthStorage,
	type CreateAgentSessionRuntimeFactory,
	type CreateAgentSessionRuntimeResult,
} from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_REALTIME_MODEL,
	DEFAULT_XAI_REALTIME_MODEL,
	extractRealtimeFunctionCallEnvelopes,
	resolveAgentDiscordVoiceConfig,
	startAgentDiscordVoiceBridge,
} from "../src/agentDiscordVoice.ts";
import {
	type ClankvoxDecodedVideoFrame,
	type ClankvoxGuildLike,
	createClankvoxVoiceAdapterProxy,
} from "../src/voice/clankvoxIpcClient.ts";
import { bindClankvoxRealtimeBridge } from "../src/voice/clankvoxRealtimeBridge.ts";
import {
	createDiscordStreamDiscovery,
	type DiscordRawPacket,
	type DiscordStreamDiscovery,
	type DiscoveredDiscordStream,
	deriveDiscordStreamWatchDaveChannelId,
} from "../src/voice/discordStreamDiscovery.ts";
import { DiscordVoiceSpeakerTranscriptionManager } from "../src/voice/discordVoiceSpeakerTranscription.ts";
import { DiscordVoiceTurnBuffer, mixPcm16MonoFrames } from "../src/voice/discordVoiceTurnBuffer.ts";
import {
	describeVoiceLiveValidationRequirements,
	evaluateVoiceLiveStatus,
	hasVoiceLiveSuccessRequirements,
	hasVoiceLiveValidationRequirements,
	isVoiceLiveValidationSatisfied,
	parseVoiceLiveValidationRequirements,
	requiresNativeDiscordScreenWatch,
	validateVoiceLiveStatus,
} from "../src/voice/liveValidation.ts";
import { buildVoiceLiveValidationResult } from "../src/voice/liveValidationResult.ts";
import {
	buildInputAudioAppendEvent,
	buildRealtimeSessionUpdateEvent,
	buildRealtimeTranscriptionSessionUpdateEvent,
	buildRealtimeTranscriptionUrl,
	type OpenAiRealtimeTranscriptionConnectOptions,
	splitRealtimeInputAudioChunk,
	stringifyRealtimeFunctionOutput,
} from "../src/voice/openAiRealtimeClient.ts";
import { __xaiRealtimeTestHooks, buildXAiRealtimeSessionUpdateEvent } from "../src/voice/xAiRealtimeClient.ts";
import type { VoiceSupervisorDelegateHandle } from "../src/voiceSupervisorExtension.ts";

type JsonRecord = Record<string, unknown>;

async function main(): Promise<void> {
	assertVoiceConfig();
	assertRealtimeSessionUpdateShape();
	assertXAiRealtimeSessionUpdateShape();
	assertRealtimeTranscriptionUrlShape();
	assertRealtimeTranscriptionSessionUpdateShape();
	assertRealtimeAudioAppendShape();
	assertRealtimeFunctionOutputSerialization();
	assertRealtimeFunctionCallParsing();
	assertDiscordVoiceTurnBuffer();
	assertDiscordVoiceTurnBufferMixing();
	assertClankvoxVoiceAdapterProxy();
	assertFakeClankvoxRealtimeBridge();
	assertDiscordStreamDiscovery();
	assertVoiceLiveValidation();
	assertVoiceLiveValidationResult();
	await assertSpeakerTranscriptionCommitGuard();
	await assertFakeVoiceBridgeRealtimeTools();
	await assertFakeVoiceBridgeXAiRealtimeAgent();
	await assertFakeVoiceBridgeElevenLabsTts();
	await assertFakeVoiceBridgeBargeInPolicy();
	await assertFakeVoiceBridgeSubagents();
	await assertFakeVoiceBridgeRealtimeMediaTools();
	await assertFakeVoiceBridgeRealtimeBatchToolResponse();
	await assertFakeVoiceBridgeBotTokenScreenWatchGuard();
	await assertFakeVoiceBridgeScreenWatchSwitchCleanup();
	await assertFakeVoiceBridgeGatewaySessionFallback();
	await assertFakeVoiceBridgeRealtimeStreamingToolDedup();
	await assertFakeVoiceBridgeRealtimeDuplicateAskPiCoalesces();
	console.log("voice-smoke: PASS");
}

function assertVoiceConfig(): void {
	const config = resolveAgentDiscordVoiceConfig(
		{
			CLANKY_DISCORD_VOICE_ENABLED: "1",
			CLANKY_DISCORD_TOKEN: "discord-token",
			CLANKY_DISCORD_VOICE_GUILD_ID: "guild-1",
			CLANKY_DISCORD_VOICE_CHANNEL_ID: "channel-1",
			OPENAI_API_KEY: "openai-key",
		},
		{
			providerId: "clanky-discord",
			token: "discord-token",
			credentialKind: "bot-token",
			source: "env",
		},
	);
	if (config === undefined) throw new Error("voice-smoke: expected voice config");
	if (config.openAiRealtimeModel !== DEFAULT_REALTIME_MODEL) {
		throw new Error(`voice-smoke: default realtime model mismatch: ${config.openAiRealtimeModel}`);
	}
	if (config.openAiRealtimeReasoningEffort !== "low") {
		throw new Error("voice-smoke: default realtime reasoning effort should be low for gpt-realtime-2");
	}
	if (config.realtimeAgentProvider !== "openai") {
		throw new Error("voice-smoke: default realtime agent provider should be OpenAI");
	}
	if (config.openAiRealtimeTranscriptionModel !== "gpt-realtime-whisper") {
		throw new Error("voice-smoke: default realtime transcription model mismatch");
	}
	if (config.openAiRealtimeTranscriptionDelay !== "low") {
		throw new Error("voice-smoke: default realtime transcription delay mismatch");
	}
	if (config.videoFrameAutoAttachIntervalMs !== 2_000) {
		throw new Error("voice-smoke: default screen frame auto-attach interval mismatch");
	}
	const dynamicConfig = resolveAgentDiscordVoiceConfig(
		{
			CLANKY_DISCORD_VOICE_ENABLED: "1",
			CLANKY_DISCORD_TOKEN: "discord-token",
			OPENAI_API_KEY: "openai-key",
		},
		{
			providerId: "clanky-discord",
			token: "discord-token",
			credentialKind: "bot-token",
			source: "env",
		},
	);
	if (dynamicConfig === undefined || dynamicConfig.guildId !== undefined || dynamicConfig.channelId !== undefined) {
		throw new Error("voice-smoke: enabled voice config should not require a pinned guild/channel target");
	}
	const elevenLabsConfig = resolveAgentDiscordVoiceConfig(
		{
			CLANKY_DISCORD_VOICE_ENABLED: "1",
			CLANKY_DISCORD_TOKEN: "discord-token",
			OPENAI_API_KEY: "openai-key",
			ELEVENLABS_API_KEY: "elevenlabs-key",
			CLANKY_DISCORD_VOICE_TTS_PROVIDER: "elevenlabs",
			CLANKY_ELEVENLABS_VOICE_ID: "eleven-voice",
			CLANKY_ELEVENLABS_MODEL: "eleven_flash_v2_5",
		},
		{
			providerId: "clanky-discord",
			token: "discord-token",
			credentialKind: "bot-token",
			source: "env",
		},
	);
	if (
		elevenLabsConfig?.ttsProvider !== "elevenlabs" ||
		elevenLabsConfig.elevenLabsApiKey !== "elevenlabs-key" ||
		elevenLabsConfig.elevenLabsVoiceId !== "eleven-voice" ||
		elevenLabsConfig.elevenLabsModel !== "eleven_flash_v2_5"
	) {
		throw new Error(`voice-smoke: ElevenLabs voice config did not resolve ${JSON.stringify(elevenLabsConfig)}`);
	}
	const xAiConfig = resolveAgentDiscordVoiceConfig(
		{
			CLANKY_DISCORD_VOICE_ENABLED: "1",
			CLANKY_DISCORD_TOKEN: "discord-token",
			CLANKY_DISCORD_VOICE_GUILD_ID: "guild-1",
			CLANKY_DISCORD_VOICE_CHANNEL_ID: "channel-1",
			OPENAI_API_KEY: "openai-key",
			XAI_API_KEY: "xai-key",
			CLANKY_DISCORD_VOICE_REALTIME_AGENT_PROVIDER: "xai",
			CLANKY_XAI_REALTIME_MODEL: "grok-voice-think-fast-1.0",
			CLANKY_XAI_REALTIME_VOICE: "ara",
		},
		{
			providerId: "clanky-discord",
			token: "discord-token",
			credentialKind: "bot-token",
			source: "env",
		},
	);
	if (
		xAiConfig?.realtimeAgentProvider !== "xai" ||
		xAiConfig.xAiApiKey !== "xai-key" ||
		xAiConfig.xAiRealtimeModel !== "grok-voice-think-fast-1.0" ||
		xAiConfig.xAiRealtimeVoice !== "ara" ||
		xAiConfig.openAiRealtimeReasoningEffort !== undefined
	) {
		throw new Error(`voice-smoke: xAI realtime agent config did not resolve ${JSON.stringify(xAiConfig)}`);
	}
	const xAiAuthStorage = AuthStorage.inMemory();
	saveStoredXAiApiKey(xAiAuthStorage, "stored-xai-key");
	const storedXAiConfig = resolveAgentDiscordVoiceConfig(
		{
			CLANKY_DISCORD_VOICE_ENABLED: "1",
			CLANKY_DISCORD_TOKEN: "discord-token",
			OPENAI_API_KEY: "openai-key",
		},
		{
			providerId: "clanky-discord",
			token: "discord-token",
			credentialKind: "bot-token",
			source: "env",
		},
		xAiAuthStorage,
		{
			enabled: true,
			realtimeAgentProvider: "xai",
			xAiRealtimeModel: "stored-grok-voice",
			xAiRealtimeVoice: "rex",
		},
	);
	if (
		storedXAiConfig?.realtimeAgentProvider !== "xai" ||
		storedXAiConfig.xAiApiKey !== "stored-xai-key" ||
		storedXAiConfig.xAiRealtimeModel !== "stored-grok-voice" ||
		storedXAiConfig.xAiRealtimeVoice !== "rex"
	) {
		throw new Error(`voice-smoke: stored xAI realtime agent config did not resolve ${JSON.stringify(storedXAiConfig)}`);
	}
	const transcriptionOverride = resolveAgentDiscordVoiceConfig(
		{
			CLANKY_DISCORD_VOICE_ENABLED: "1",
			CLANKY_DISCORD_TOKEN: "discord-token",
			CLANKY_DISCORD_VOICE_GUILD_ID: "guild-1",
			CLANKY_DISCORD_VOICE_CHANNEL_ID: "channel-1",
			OPENAI_API_KEY: "openai-key",
			CLANKY_OPENAI_REALTIME_TRANSCRIPTION_MODEL: "gpt-realtime-whisper",
			CLANKY_OPENAI_REALTIME_TRANSCRIPTION_DELAY: "medium",
			CLANKY_OPENAI_REALTIME_TRANSCRIPTION_LANGUAGE: "en",
			CLANKY_DISCORD_VOICE_SPEAKER_TRANSCRIPTION_IDLE_CLOSE_MS: "90000",
			CLANKY_DISCORD_VOICE_TRANSCRIPT_RESPONSE_BATCH_DELAY_MS: "0",
		},
		{
			providerId: "clanky-discord",
			token: "discord-token",
			credentialKind: "bot-token",
			source: "env",
		},
	);
	if (
		transcriptionOverride === undefined ||
		transcriptionOverride.openAiRealtimeTranscriptionDelay !== "medium" ||
		transcriptionOverride.openAiRealtimeTranscriptionLanguage !== "en" ||
		transcriptionOverride.speakerTranscriptionIdleCloseMs !== 90_000 ||
		transcriptionOverride.transcriptResponseBatchDelayMs !== 0
	) {
		throw new Error("voice-smoke: realtime transcription env overrides did not parse");
	}
	const nonReasoningOverride = resolveAgentDiscordVoiceConfig(
		{
			CLANKY_DISCORD_VOICE_ENABLED: "1",
			CLANKY_DISCORD_TOKEN: "discord-token",
			CLANKY_DISCORD_VOICE_GUILD_ID: "guild-1",
			CLANKY_DISCORD_VOICE_CHANNEL_ID: "channel-1",
			OPENAI_API_KEY: "openai-key",
			CLANKY_OPENAI_REALTIME_MODEL: "gpt-realtime-1.5",
		},
		{
			providerId: "clanky-discord",
			token: "discord-token",
			credentialKind: "bot-token",
			source: "env",
		},
	);
	if (nonReasoningOverride?.openAiRealtimeReasoningEffort !== undefined) {
		throw new Error("voice-smoke: non-default realtime model should not inherit Realtime 2 reasoning effort");
	}
	const reasoningOverride = resolveAgentDiscordVoiceConfig(
		{
			CLANKY_DISCORD_VOICE_ENABLED: "1",
			CLANKY_DISCORD_TOKEN: "discord-token",
			CLANKY_DISCORD_VOICE_GUILD_ID: "guild-1",
			CLANKY_DISCORD_VOICE_CHANNEL_ID: "channel-1",
			OPENAI_API_KEY: "openai-key",
			CLANKY_OPENAI_REALTIME_REASONING_EFFORT: "medium",
		},
		{
			providerId: "clanky-discord",
			token: "discord-token",
			credentialKind: "bot-token",
			source: "env",
		},
	);
	if (reasoningOverride?.openAiRealtimeReasoningEffort !== "medium") {
		throw new Error("voice-smoke: realtime reasoning effort override did not parse");
	}
	const unthrottled = resolveAgentDiscordVoiceConfig(
		{
			CLANKY_DISCORD_VOICE_ENABLED: "1",
			CLANKY_DISCORD_TOKEN: "discord-token",
			CLANKY_DISCORD_VOICE_GUILD_ID: "guild-1",
			CLANKY_DISCORD_VOICE_CHANNEL_ID: "channel-1",
			OPENAI_API_KEY: "openai-key",
			CLANKY_DISCORD_VOICE_VIDEO_FRAME_INTERVAL_MS: "0",
		},
		{
			providerId: "clanky-discord",
			token: "discord-token",
			credentialKind: "bot-token",
			source: "env",
		},
	);
	if (unthrottled?.videoFrameAutoAttachIntervalMs !== 0) {
		throw new Error("voice-smoke: screen frame auto-attach interval override did not parse");
	}
	const storedAuthStorage = AuthStorage.inMemory();
	saveStoredElevenLabsApiKey(storedAuthStorage, "stored-elevenlabs-key");
	const storedConfig = resolveAgentDiscordVoiceConfig(
		{
			OPENAI_API_KEY: "openai-key",
		},
		{
			providerId: "clanky-discord",
			token: "discord-token",
			credentialKind: "bot-token",
			source: "env",
		},
		storedAuthStorage,
		{
			enabled: true,
			guildId: "stored-guild",
			channelId: "stored-channel",
			allowedGuildIds: ["stored-guild", "guild-2", "stored-guild"],
			allowedChannelIds: ["stored-channel", "voice-2", "stored-channel"],
			ttsProvider: "elevenlabs",
			elevenLabsVoiceId: "stored-eleven-voice",
			elevenLabsModel: "eleven_turbo_v2_5",
			elevenLabsOutputFormat: "pcm_16000",
			elevenLabsBaseUrl: "https://api.example.test",
			openAiRealtimeModel: "gpt-realtime-1.5",
			openAiRealtimeVoice: "cedar",
			openAiRealtimeReasoningEffort: "medium",
			videoFrameAutoAttachIntervalMs: 250,
		},
	);
	if (
		storedConfig?.guildId !== "stored-guild" ||
		storedConfig.channelId !== "stored-channel" ||
		storedConfig.allowedGuildIds?.join(",") !== "stored-guild,guild-2" ||
		storedConfig.allowedChannelIds?.join(",") !== "stored-channel,voice-2" ||
		storedConfig.ttsProvider !== "elevenlabs" ||
		storedConfig.elevenLabsApiKey !== "stored-elevenlabs-key" ||
		storedConfig.elevenLabsVoiceId !== "stored-eleven-voice" ||
		storedConfig.elevenLabsModel !== "eleven_turbo_v2_5" ||
		storedConfig.elevenLabsOutputFormat !== "pcm_16000" ||
		storedConfig.elevenLabsBaseUrl !== "https://api.example.test" ||
		storedConfig.openAiRealtimeModel !== "gpt-realtime-1.5" ||
		storedConfig.openAiRealtimeVoice !== "cedar" ||
		storedConfig.openAiRealtimeReasoningEffort !== "medium" ||
		storedConfig.videoFrameAutoAttachIntervalMs !== 250
	) {
		throw new Error(`voice-smoke: stored voice settings did not resolve ${JSON.stringify(storedConfig)}`);
	}
	const envDisabledStored = resolveAgentDiscordVoiceConfig(
		{
			CLANKY_DISCORD_VOICE_ENABLED: "0",
			OPENAI_API_KEY: "openai-key",
		},
		{
			providerId: "clanky-discord",
			token: "discord-token",
			credentialKind: "bot-token",
			source: "env",
		},
		undefined,
		{
			enabled: true,
			guildId: "stored-guild",
			channelId: "stored-channel",
		},
	);
	if (envDisabledStored !== undefined) {
		throw new Error("voice-smoke: explicit env voice disable should override stored enabled setting");
	}
}

function assertRealtimeSessionUpdateShape(): void {
	const tool = {
		type: "function" as const,
		name: "ask_pi",
		description: "Delegate to Pi.",
		parameters: { type: "object", properties: {}, additionalProperties: false },
	};
	const event = buildRealtimeSessionUpdateEvent({
		model: DEFAULT_REALTIME_MODEL,
		voice: "marin",
		instructions: "Talk briefly.",
		tools: [tool],
		toolChoice: "auto",
		reasoningEffort: "low",
	});
	const session = expectRecord(event.session, "session");
	if (event.type !== "session.update") throw new Error("voice-smoke: expected session.update");
	if (session.type !== "realtime") throw new Error("voice-smoke: session.type must be realtime");
	if (session.model !== DEFAULT_REALTIME_MODEL) throw new Error("voice-smoke: session model missing");
	if (!Array.isArray(session.output_modalities) || session.output_modalities.join(",") !== "audio") {
		throw new Error("voice-smoke: realtime session should request audio output");
	}
	if ("modalities" in session) {
		throw new Error("voice-smoke: session.update should not use beta modalities field");
	}
	const audio = expectRecord(session.audio, "session.audio");
	const audioInput = expectRecord(audio.input, "session.audio.input");
	const audioOutput = expectRecord(audio.output, "session.audio.output");
	const inputFormat = expectRecord(audioInput.format, "session.audio.input.format");
	if (inputFormat.type !== "audio/pcm" || inputFormat.rate !== 24_000) {
		throw new Error("voice-smoke: realtime input audio format missing");
	}
	if (audioInput.turn_detection !== null) throw new Error("voice-smoke: realtime turn detection should be manual");
	const outputFormat = expectRecord(audioOutput.format, "session.audio.output.format");
	if (outputFormat.type !== "audio/pcm" || outputFormat.rate !== 24_000) {
		throw new Error("voice-smoke: realtime output audio format missing");
	}
	if (audioOutput.voice !== "marin") throw new Error("voice-smoke: realtime voice missing");
	if ("input_audio_format" in session) throw new Error("voice-smoke: session should use GA nested audio input config");
	const reasoning = expectRecord(session.reasoning, "session.reasoning");
	if (reasoning.effort !== "low") throw new Error("voice-smoke: realtime reasoning effort missing");
	const tools = session.tools;
	if (!Array.isArray(tools) || tools.length !== 1) throw new Error("voice-smoke: session tools missing");
	const textEvent = buildRealtimeSessionUpdateEvent({
		model: DEFAULT_REALTIME_MODEL,
		voice: "marin",
		instructions: "Talk briefly.",
		responseOutputModality: "text",
	});
	const textSession = expectRecord(textEvent.session, "text session");
	if (!Array.isArray(textSession.output_modalities) || textSession.output_modalities.join(",") !== "text") {
		throw new Error("voice-smoke: realtime text session should request text output");
	}
	const textAudio = expectRecord(textSession.audio, "text session audio");
	if ("output" in textAudio)
		throw new Error("voice-smoke: realtime text session should not configure audio output voice");
}

function assertXAiRealtimeSessionUpdateShape(): void {
	const tool = {
		type: "function" as const,
		name: "ask_pi",
		description: "Delegate to Pi.",
		parameters: { type: "object", properties: {}, additionalProperties: false },
	};
	const event = buildXAiRealtimeSessionUpdateEvent({
		model: DEFAULT_XAI_REALTIME_MODEL,
		voice: "eve",
		instructions: "Talk briefly.",
		tools: [tool],
		toolChoice: "auto",
		reasoningEffort: "low",
	});
	const session = expectRecord(event.session, "xAI session");
	if (event.type !== "session.update") throw new Error("voice-smoke: expected xAI session.update");
	if ("model" in session) throw new Error("voice-smoke: xAI realtime model should live in the WebSocket URL");
	if (session.voice !== "eve") throw new Error("voice-smoke: xAI realtime voice missing");
	if (session.turn_detection !== null) throw new Error("voice-smoke: xAI realtime turn detection should be manual");
	if ("reasoning" in session) throw new Error("voice-smoke: xAI session should not include OpenAI reasoning settings");
	const audio = expectRecord(session.audio, "xAI session audio");
	const audioInput = expectRecord(audio.input, "xAI session audio input");
	const audioOutput = expectRecord(audio.output, "xAI session audio output");
	const inputFormat = expectRecord(audioInput.format, "xAI input format");
	const outputFormat = expectRecord(audioOutput.format, "xAI output format");
	if (inputFormat.type !== "audio/pcm" || inputFormat.rate !== 24_000) {
		throw new Error("voice-smoke: xAI realtime input audio format missing");
	}
	if (outputFormat.type !== "audio/pcm" || outputFormat.rate !== 24_000) {
		throw new Error("voice-smoke: xAI realtime output audio format missing");
	}
	const url = __xaiRealtimeTestHooks.buildXAiRealtimeUrl("https://api.x.ai/v1", DEFAULT_XAI_REALTIME_MODEL);
	if (url !== `wss://api.x.ai/v1/realtime?model=${DEFAULT_XAI_REALTIME_MODEL}`) {
		throw new Error(`voice-smoke: xAI realtime URL mismatch: ${url}`);
	}
	if (__xaiRealtimeTestHooks.normalizeXAiTranscriptEventType("response.text.delta") !== "response.output_text.delta") {
		throw new Error("voice-smoke: xAI text delta event should normalize to OpenAI GA text delta");
	}
	const textEvent = buildXAiRealtimeSessionUpdateEvent({
		model: DEFAULT_XAI_REALTIME_MODEL,
		voice: "eve",
		instructions: "Talk briefly.",
		responseOutputModality: "text",
	});
	const textSession = expectRecord(textEvent.session, "xAI text session");
	const textAudio = expectRecord(textSession.audio, "xAI text session audio");
	if ("output" in textAudio) throw new Error("voice-smoke: xAI text session should not configure audio output");
}

function assertRealtimeTranscriptionUrlShape(): void {
	const url = buildRealtimeTranscriptionUrl("https://api.openai.com/v1");
	if (url !== "wss://api.openai.com/v1/realtime?intent=transcription") {
		throw new Error(`voice-smoke: realtime transcription URL should use intent=transcription, got ${url}`);
	}
}

function assertRealtimeTranscriptionSessionUpdateShape(): void {
	const event = buildRealtimeTranscriptionSessionUpdateEvent({
		model: "gpt-realtime-whisper",
		sampleRate: 24_000,
		language: "en",
		delay: "low",
	});
	const session = expectRecord(event.session, "transcription session");
	if (event.type !== "session.update") throw new Error("voice-smoke: expected transcription session.update");
	if (session.type !== "transcription") throw new Error("voice-smoke: transcription session.type missing");
	const audio = expectRecord(session.audio, "transcription session.audio");
	const audioInput = expectRecord(audio.input, "transcription session.audio.input");
	const format = expectRecord(audioInput.format, "transcription input format");
	if (format.type !== "audio/pcm" || format.rate !== 24_000) {
		throw new Error("voice-smoke: realtime transcription should use 24 kHz PCM input");
	}
	const transcription = expectRecord(audioInput.transcription, "transcription model config");
	if (
		transcription.model !== "gpt-realtime-whisper" ||
		transcription.language !== "en" ||
		transcription.delay !== "low"
	) {
		throw new Error("voice-smoke: realtime transcription model options missing");
	}
	if (audioInput.turn_detection !== null) {
		throw new Error("voice-smoke: realtime transcription should use manual commits");
	}
}

function assertRealtimeAudioAppendShape(): void {
	const alignedAudio = Buffer.from([1, 2, 3, 4, 5, 6]);
	const event = buildInputAudioAppendEvent(alignedAudio);
	if (event === undefined) throw new Error("voice-smoke: expected realtime audio append event");
	if (event.type !== "input_audio_buffer.append") throw new Error("voice-smoke: expected audio append event type");
	if (event.audio !== alignedAudio.toString("base64")) {
		throw new Error("voice-smoke: realtime audio append should send the complete PCM buffer");
	}
	if (buildInputAudioAppendEvent(Buffer.alloc(0)) !== undefined) {
		throw new Error("voice-smoke: empty realtime audio append should be skipped");
	}
	const firstSplit = splitRealtimeInputAudioChunk(Buffer.from([1, 2, 3, 4, 5]));
	if (firstSplit.event !== undefined || firstSplit.remainder.toString("hex") !== "0102030405") {
		throw new Error("voice-smoke: realtime audio split should hold sub-six-byte PCM tails");
	}
	const secondSplit = splitRealtimeInputAudioChunk(Buffer.from([6, 7, 8]), firstSplit.remainder);
	if (
		secondSplit.event?.audio !== Buffer.from([1, 2, 3, 4, 5, 6]).toString("base64") ||
		secondSplit.remainder.toString("hex") !== "0708"
	) {
		throw new Error("voice-smoke: realtime audio split should emit aligned chunks and keep the next tail");
	}
}

function assertRealtimeFunctionOutputSerialization(): void {
	if (stringifyRealtimeFunctionOutput("plain text") !== "plain text") {
		throw new Error("voice-smoke: string realtime function output should pass through unchanged");
	}
	if (stringifyRealtimeFunctionOutput(undefined) !== "null") {
		throw new Error("voice-smoke: undefined realtime function output should become null string");
	}
	if (stringifyRealtimeFunctionOutput({ ok: true, count: 2 }) !== '{"ok":true,"count":2}') {
		throw new Error("voice-smoke: object realtime function output should serialize to JSON");
	}
	const circular: JsonRecord = {};
	circular.self = circular;
	const fallback = expectRecord(
		JSON.parse(stringifyRealtimeFunctionOutput(circular)) as unknown,
		"circular function output fallback",
	);
	if (fallback.ok !== false || !String(fallback.error).includes("serialize")) {
		throw new Error("voice-smoke: circular realtime function output did not produce structured fallback");
	}
}

function assertRealtimeFunctionCallParsing(): void {
	const doneEvent = {
		type: "response.done",
		response: {
			output: [
				{
					type: "function_call",
					name: "ask_pi",
					call_id: "call_1",
					arguments: '{"prompt":"hello"}',
				},
			],
		},
	};
	const envelopes = extractRealtimeFunctionCallEnvelopes(doneEvent);
	if (envelopes.length !== 1) throw new Error(`voice-smoke: expected one function call, got ${envelopes.length}`);
	const [envelope] = envelopes;
	if (envelope?.callId !== "call_1" || envelope.name !== "ask_pi" || envelope.argumentsJson !== '{"prompt":"hello"}') {
		throw new Error("voice-smoke: function call envelope did not parse response.done output");
	}
}

function assertDiscordVoiceTurnBuffer(): void {
	const subscriptions: string[] = [];
	const appendedUsers: string[] = [];
	let commits = 0;
	let responses = 0;
	let pendingTimer: (() => void) | undefined;
	const readPendingTimer = () => pendingTimer;
	const timerHandle = {} as ReturnType<typeof setTimeout>;
	const buffer = new DiscordVoiceTurnBuffer({
		flushDelayMs: 1,
		subscribeUser(userId) {
			subscriptions.push(userId);
		},
		appendInputAudio(userId) {
			appendedUsers.push(userId);
		},
		commitInputAudioBuffer() {
			commits += 1;
		},
		createAudioResponse() {
			responses += 1;
		},
		setTimer(callback) {
			pendingTimer = callback;
			return timerHandle;
		},
		clearTimer() {
			pendingTimer = undefined;
		},
	});
	buffer.speakingStart("user-a");
	buffer.userAudio("user-a", Buffer.from([1, 2, 3, 4, 5, 6]));
	buffer.speakingStart("user-b");
	buffer.userAudio("user-b", Buffer.from([7, 8, 9, 10, 11, 12]));
	buffer.userAudioEnd("user-a");
	if (readPendingTimer() !== undefined)
		throw new Error("voice-smoke: group turn flushed while another speaker was active");
	buffer.userAudioEnd("user-b");
	const flush = readPendingTimer();
	if (flush === undefined) throw new Error("voice-smoke: group turn did not schedule idle flush");
	flush();
	if (commits !== 1 || responses !== 1) throw new Error("voice-smoke: group turn did not commit one response");
	if (subscriptions.join(",") !== "user-a,user-b") throw new Error("voice-smoke: speakers were not subscribed");
	if (appendedUsers.join(",") !== "user-a,user-b") throw new Error("voice-smoke: speaker audio was not appended");
}

function assertDiscordVoiceTurnBufferMixing(): void {
	const mixed = mixPcm16MonoFrames([pcm16([10_000, 20_000, -20_000]), pcm16([10_000, 20_000, -20_000])]);
	if (samplesFromPcm16(mixed).join(",") !== "20000,32767,-32768") {
		throw new Error("voice-smoke: PCM mixer did not sum and clamp overlapping speaker frames");
	}

	const appended: { userId: string; samples: number[] }[] = [];
	const buffer = new DiscordVoiceTurnBuffer({
		mixAudio: true,
		subscribeUser() {},
		appendInputAudio(userId, pcm) {
			appended.push({ userId, samples: samplesFromPcm16(pcm) });
		},
		commitInputAudioBuffer() {},
		createAudioResponse() {},
	});
	buffer.speakingStart("user-a");
	buffer.speakingStart("user-b");
	buffer.userAudio("user-a", pcm16([1_000, 2_000]));
	buffer.userAudio("user-b", pcm16([3_000, 4_000]));
	buffer.flushNow();
	if (appended.length !== 1 || appended[0]?.userId !== "mixed" || appended[0].samples.join(",") !== "4000,6000") {
		throw new Error("voice-smoke: group voice mixer did not combine same-turn active speaker audio");
	}
	buffer.dispose();
}

function assertClankvoxVoiceAdapterProxy(): void {
	const adapterPayloads: JsonRecord[] = [];
	const shardPayloads: JsonRecord[] = [];
	let destroyed = false;
	const callbacksSeen: string[] = [];
	const guild: ClankvoxGuildLike = {
		shard: {
			send(payload) {
				shardPayloads.push(payload);
			},
		},
		voiceAdapterCreator(callbacks) {
			callbacks.onVoiceServerUpdate({ token: "voice-token" });
			callbacks.onVoiceStateUpdate({ session_id: "voice-session", user_id: "user-1" });
			callbacksSeen.push("registered");
			return {
				sendPayload(payload) {
					adapterPayloads.push(payload);
					return true;
				},
				destroy() {
					destroyed = true;
				},
			};
		},
	};
	const proxy = createClankvoxVoiceAdapterProxy(guild, {
		onVoiceServerUpdate(data) {
			if (data.token === "voice-token") callbacksSeen.push("server");
		},
		onVoiceStateUpdate(data) {
			if (data.session_id === "voice-session") callbacksSeen.push("state");
		},
	});
	if (!proxy.send({ op: 4 })) throw new Error("voice-smoke: clankvox adapter proxy send failed");
	if (adapterPayloads.length !== 1 || shardPayloads.length !== 0) {
		throw new Error("voice-smoke: clankvox adapter proxy should prefer adapter.sendPayload over shard.send");
	}
	proxy.destroy();
	if (!destroyed || callbacksSeen.join(",") !== "server,state,registered") {
		throw new Error("voice-smoke: clankvox adapter proxy did not register callbacks or destroy adapter");
	}

	const fallbackPayloads: JsonRecord[] = [];
	const fallback = createClankvoxVoiceAdapterProxy(
		{
			shard: {
				send(payload) {
					fallbackPayloads.push(payload);
				},
			},
		},
		{
			onVoiceServerUpdate() {},
			onVoiceStateUpdate() {},
		},
	);
	if (!fallback.send({ op: 4 }) || fallbackPayloads.length !== 1) {
		throw new Error("voice-smoke: clankvox adapter proxy did not fall back to shard.send");
	}
}

function assertFakeClankvoxRealtimeBridge(): void {
	const vox = new FakeClankvox();
	const realtime = new FakeRealtime();
	let pendingTimer: (() => void) | undefined;
	const readPendingTimer = () => pendingTimer;
	const timerHandle = {} as ReturnType<typeof setTimeout>;
	let latestFrame: ClankvoxDecodedVideoFrame | undefined;
	const turnBuffer = bindClankvoxRealtimeBridge({
		vox,
		realtime,
		onDecodedVideoFrame(frame) {
			latestFrame = frame;
		},
		turnBuffer: {
			flushDelayMs: 1,
			setTimer(callback) {
				pendingTimer = callback;
				return timerHandle;
			},
			clearTimer() {
				pendingTimer = undefined;
			},
		},
	});
	vox.emit("speakingStart", "speaker-1");
	vox.emit("userAudio", "speaker-1", Buffer.from([1, 2, 3, 4, 5, 6]));
	vox.emit("userAudioEnd", "speaker-1");
	const flush = readPendingTimer();
	if (flush === undefined) throw new Error("voice-smoke: fake clankvox audio did not schedule realtime flush");
	flush();
	if (vox.subscriptions[0] !== "speaker-1") throw new Error("voice-smoke: fake clankvox speaker was not subscribed");
	if (realtime.audioAppends !== 1 || realtime.commits !== 1 || realtime.responses !== 1) {
		throw new Error("voice-smoke: fake clankvox audio did not reach realtime");
	}
	const frame: ClankvoxDecodedVideoFrame = {
		userId: "speaker-1",
		ssrc: 123,
		width: 640,
		height: 360,
		jpegBase64: "aW1hZ2U=",
		rtpTimestamp: 456,
		streamType: "screen",
		rid: null,
	};
	vox.emit("decodedVideoFrame", frame);
	if (latestFrame !== frame || realtime.videoFrames !== 1) {
		throw new Error("voice-smoke: fake clankvox screen frame did not reach realtime");
	}
	turnBuffer.dispose();
}

function assertDiscordStreamDiscovery(): void {
	const client = new FakeRawGatewayClient();
	let discovered: DiscoveredDiscordStream | undefined;
	let createDiscovered: DiscoveredDiscordStream | undefined;
	let deleted: DiscoveredDiscordStream | undefined;
	const discovery = createDiscordStreamDiscovery(client, {
		onStreamCredentials(stream) {
			discovered = stream;
			if (stream.streamKey === "guild:guild-1:voice-1:user-create-creds") createDiscovered = stream;
		},
		onStreamDeleted(stream) {
			deleted = stream;
		},
	});
	client.emitRaw({
		t: "GUILD_CREATE",
		d: {
			id: "guild-1",
			voice_states: [{ self_stream: true, channel_id: "voice-1", user_id: "cold-start-user" }],
		},
	});
	client.emitRaw({
		t: "VOICE_STATE_UPDATE",
		d: {
			self_stream: true,
			guild_id: "guild-1",
			channel_id: "voice-1",
			user_id: "user-1",
		},
	});
	client.emitRaw({
		t: "STREAM_CREATE",
		d: {
			stream_key: "guild:guild-1:voice-1:user-1",
			rtc_server_id: "9002",
		},
	});
	client.emitRaw({
		t: "STREAM_SERVER_UPDATE",
		d: {
			stream_key: "guild:guild-1:voice-1:user-1",
			endpoint: "voice.example",
			token: "stream-token",
		},
	});
	const stream = discovery.findStream("user-1", { guildId: "guild-1", channelId: "voice-1" });
	if (stream?.endpoint !== "voice.example") throw new Error("voice-smoke: stream credentials were not recorded");
	if (stream.rtcServerId !== "9002") throw new Error("voice-smoke: stream rtc server id was not preserved");
	if (discovered === undefined) throw new Error("voice-smoke: stream credentials hook did not fire");
	client.emitRaw({
		t: "STREAM_CREATE",
		d: {
			stream_key: "guild:guild-1:voice-1:user-create-creds",
			rtc_server_id: "9003",
			endpoint: "voice-create.example",
			token: "stream-create-token",
		},
	});
	if (
		createDiscovered?.endpoint !== "voice-create.example" ||
		createDiscovered.token !== "stream-create-token" ||
		createDiscovered.rtcServerId !== "9003"
	) {
		throw new Error("voice-smoke: stream credentials hook did not fire from credentialed STREAM_CREATE");
	}
	if (discovery.findStream(undefined, { guildId: "guild-1", channelId: "other-voice" }) !== undefined) {
		throw new Error("voice-smoke: stream lookup did not respect voice channel scope");
	}
	if (discovery.findStream("cold-start-user", { guildId: "guild-1", channelId: "voice-1" }) === undefined) {
		throw new Error("voice-smoke: guild create existing streamer was not discovered");
	}
	if (deriveDiscordStreamWatchDaveChannelId(stream.rtcServerId) !== "9001") {
		throw new Error("voice-smoke: stream watch DAVE channel derivation changed");
	}
	discovery.requestWatch("guild:guild-1:voice-1:user-1");
	if (client.sent[0]?.payload.op !== 20) throw new Error("voice-smoke: stream watch did not send OP20");
	discovery.requestPublish({ guildId: "guild-1", channelId: "voice-1" });
	if (client.sent[1]?.payload.op !== 18) throw new Error("voice-smoke: stream publish did not send OP18");
	discovery.setPublishPaused("guild:guild-1:voice-1:clanky-user", true);
	if (client.sent[2]?.payload.op !== 22) throw new Error("voice-smoke: stream publish pause did not send OP22");
	discovery.requestPublishStop("guild:guild-1:voice-1:clanky-user");
	if (client.sent[3]?.payload.op !== 19) throw new Error("voice-smoke: stream publish stop did not send OP19");
	client.emitRaw({
		t: "VOICE_STATE_UPDATE",
		d: {
			self_stream: false,
			guild_id: "guild-1",
			channel_id: "voice-1",
			user_id: "user-1",
		},
	});
	if (deleted?.streamKey !== "guild:guild-1:voice-1:user-1") {
		throw new Error("voice-smoke: stream was not removed on self_stream=false");
	}
	discovery.stop();
}

function assertVoiceLiveValidation(): void {
	const requirements = parseVoiceLiveValidationRequirements({
		CLANKY_DISCORD_VOICE_REQUIRE_INPUT_AUDIO: "1",
		CLANKY_DISCORD_VOICE_REQUIRE_GROUP_AUDIO: "1",
		CLANKY_DISCORD_VOICE_REQUIRE_REALTIME_SESSION: "1",
		CLANKY_DISCORD_VOICE_REQUIRE_OUTPUT_AUDIO: "1",
		CLANKY_DISCORD_VOICE_REQUIRE_TOOL_CALL: "1",
		CLANKY_DISCORD_VOICE_REQUIRE_ASK_PI: "1",
		CLANKY_DISCORD_VOICE_REQUIRE_STREAM_WATCH: "1",
		CLANKY_DISCORD_VOICE_REQUIRE_SCREEN_FRAME: "1",
		CLANKY_DISCORD_VOICE_FAIL_ON_REALTIME_ERROR: "1",
	});
	const failures = validateVoiceLiveStatus(
		{
			voice: {
				stats: {
					discordInputAudioEventCount: 1,
					discordInputMaxConcurrentSpeakers: 2,
					realtimeSessionUpdatedCount: 1,
					realtimeAudioDeltaCount: 1,
					discordOutputAudioSendCount: 1,
					realtimeFunctionCallCount: 1,
					askPiCallCount: 1,
					streamWatchConnectCount: 1,
					decodedVideoFrameCount: 1,
					realtimeErrorEventCount: 0,
					realtimeSocketErrorCount: 0,
					realtimeSocketCloseCount: 0,
				},
			},
		},
		requirements,
	);
	if (failures.length > 0) throw new Error(`voice-smoke: unexpected live validation failures: ${failures.join(", ")}`);
	const checks = evaluateVoiceLiveStatus(
		{
			voice: {
				stats: {
					discordInputAudioEventCount: 1,
					discordInputMaxConcurrentSpeakers: 2,
					realtimeSessionUpdatedCount: 1,
					realtimeAudioDeltaCount: 1,
					discordOutputAudioSendCount: 1,
					realtimeFunctionCallCount: 1,
					askPiCallCount: 1,
					streamWatchConnectCount: 1,
					decodedVideoFrameCount: 1,
					realtimeErrorEventCount: 0,
					realtimeSocketErrorCount: 0,
					realtimeSocketCloseCount: 0,
				},
			},
		},
		requirements,
	);
	if (checks.length !== 10 || checks.some((check) => !check.passed)) {
		throw new Error("voice-smoke: detailed live validation checks did not pass");
	}
	const elevenLabsChecks = evaluateVoiceLiveStatus(
		{
			voice: {
				ttsProvider: "elevenlabs",
				stats: {
					externalTtsRequestCount: 1,
					discordOutputAudioSendCount: 1,
				},
			},
		},
		parseVoiceLiveValidationRequirements({ CLANKY_DISCORD_VOICE_REQUIRE_OUTPUT_AUDIO: "1" }),
	);
	if (
		elevenLabsChecks.length !== 2 ||
		elevenLabsChecks.some((check) => !check.passed) ||
		elevenLabsChecks[0]?.id !== "elevenlabs_tts_output_audio"
	) {
		throw new Error("voice-smoke: ElevenLabs output audio validation did not pass");
	}
	if (
		!isVoiceLiveValidationSatisfied(
			{
				voice: {
					stats: {
						discordInputAudioEventCount: 1,
						discordInputMaxConcurrentSpeakers: 2,
						realtimeSessionUpdatedCount: 1,
						realtimeAudioDeltaCount: 1,
						discordOutputAudioSendCount: 1,
						realtimeFunctionCallCount: 1,
						askPiCallCount: 1,
						streamWatchConnectCount: 1,
						decodedVideoFrameCount: 1,
						realtimeErrorEventCount: 0,
						realtimeSocketErrorCount: 0,
						realtimeSocketCloseCount: 0,
					},
				},
			},
			requirements,
		)
	) {
		throw new Error("voice-smoke: satisfied live validation helper returned false");
	}
	const missing = validateVoiceLiveStatus({ voice: { stats: {} } }, requirements);
	if (missing.length !== 9)
		throw new Error(`voice-smoke: expected nine live validation failures, got ${missing.length}`);
	if (isVoiceLiveValidationSatisfied({ voice: { stats: {} } }, requirements)) {
		throw new Error("voice-smoke: satisfied live validation helper returned true for missing stats");
	}
	const realtimeErrorFailures = validateVoiceLiveStatus(
		{
			voice: {
				stats: {
					discordInputAudioEventCount: 1,
					discordInputMaxConcurrentSpeakers: 2,
					realtimeSessionUpdatedCount: 1,
					realtimeAudioDeltaCount: 1,
					discordOutputAudioSendCount: 1,
					realtimeFunctionCallCount: 1,
					askPiCallCount: 1,
					streamWatchConnectCount: 1,
					decodedVideoFrameCount: 1,
					realtimeSocketErrorCount: 1,
				},
			},
		},
		requirements,
	);
	if (!realtimeErrorFailures.some((failure) => failure.includes("Realtime API/socket errors"))) {
		throw new Error("voice-smoke: realtime error validation did not fail on socket error counter");
	}

	const all = parseVoiceLiveValidationRequirements({ CLANKY_DISCORD_VOICE_REQUIRE_ALL: "1" });
	const allFailures = validateVoiceLiveStatus({ voice: { stats: {} } }, all);
	if (allFailures.length !== 9) throw new Error("voice-smoke: require-all did not enable every live validation check");
	if (!requiresNativeDiscordScreenWatch(all)) {
		throw new Error("voice-smoke: require-all should require native Discord screen watch");
	}
	if (describeVoiceLiveValidationRequirements(all).length !== 8) {
		throw new Error("voice-smoke: require-all did not produce every live validation checklist item");
	}
	const none = parseVoiceLiveValidationRequirements({});
	if (requiresNativeDiscordScreenWatch(none)) {
		throw new Error("voice-smoke: empty requirements should not require native Discord screen watch");
	}
	if (describeVoiceLiveValidationRequirements(none).length !== 0) {
		throw new Error("voice-smoke: empty live validation requirements should not produce checklist items");
	}
	const failOnly = parseVoiceLiveValidationRequirements({ CLANKY_DISCORD_VOICE_FAIL_ON_REALTIME_ERROR: "1" });
	if (!hasVoiceLiveValidationRequirements(failOnly)) {
		throw new Error("voice-smoke: fail-on-realtime-error should count as a final validation requirement");
	}
	if (hasVoiceLiveSuccessRequirements(failOnly)) {
		throw new Error("voice-smoke: fail-on-realtime-error should not let STOP_WHEN_VALID stop immediately");
	}
	if (!isVoiceLiveValidationSatisfied({ voice: { stats: {} } }, failOnly)) {
		throw new Error("voice-smoke: fail-on-realtime-error should pass final validation when no errors were counted");
	}
}

function assertVoiceLiveValidationResult(): void {
	const requirements = parseVoiceLiveValidationRequirements({
		CLANKY_DISCORD_VOICE_REQUIRE_INPUT_AUDIO: "1",
	});
	const startedAt = new Date("2026-05-25T00:00:00.000Z");
	const finishedAt = new Date("2026-05-25T00:00:05.000Z");
	const passing = buildVoiceLiveValidationResult({
		startedAt,
		finishedAt,
		phase: "final",
		requirements,
		failures: [],
		status: { voice: { stats: { discordInputAudioEventCount: 1 } } },
	});
	if (!passing.validation.enabled || !passing.validation.passed || passing.durationMs !== 5_000) {
		throw new Error("voice-smoke: passing live result artifact shape was incorrect");
	}
	const passingCheck = passing.validation.checks[0];
	if (passingCheck?.id !== "discord_input_audio" || passingCheck.observed !== 1 || !passingCheck.passed) {
		throw new Error("voice-smoke: passing live result artifact did not include detailed validation checks");
	}
	const failed = buildVoiceLiveValidationResult({
		startedAt,
		finishedAt,
		phase: "preflight",
		requirements,
		failures: ["missing Discord credential"],
		error: new Error("missing Discord credential"),
	});
	if (failed.validation.passed || failed.error?.message !== "missing Discord credential") {
		throw new Error("voice-smoke: failed live result artifact did not preserve failure/error details");
	}
	if (failed.validation.checks.length !== 0) {
		throw new Error("voice-smoke: preflight result without bridge status should not invent validation checks");
	}
}

async function assertSpeakerTranscriptionCommitGuard(): Promise<void> {
	const realtime = new FakeSpeakerTranscriptionRealtime("speaker transcript");
	const transcripts: string[] = [];
	const manager = new DiscordVoiceSpeakerTranscriptionManager({
		realtimeOptions: { apiKey: "openai-key" },
		connectOptions: {
			model: "gpt-realtime-whisper",
			sampleRate: 24_000,
		},
		createRealtime() {
			return realtime;
		},
		subscribeUser() {},
		onTranscript(transcript) {
			transcripts.push(transcript.text);
		},
	});

	manager.userAudio("speaker-1", Buffer.alloc(4_799));
	manager.userAudioEnd("speaker-1");
	await waitUntil(() => realtime.audioAppends.length === 1, "short speaker transcription append");
	await sleep(0);
	if (realtime.commits !== 0 || transcripts.length !== 0) {
		throw new Error("voice-smoke: speaker transcription should not commit less than 100ms of audio");
	}

	manager.userAudio("speaker-1", Buffer.alloc(4_800));
	manager.userAudioEnd("speaker-1");
	await waitUntil(() => realtime.commits === 1, "speaker transcription commit after 100ms");
	if (transcripts.join(",") !== "speaker transcript") {
		throw new Error("voice-smoke: speaker transcription did not emit transcript after commit");
	}
	await manager.dispose();
}

async function assertFakeVoiceBridgeRealtimeTools(): Promise<void> {
	const realtime = new FakeBridgeRealtime();
	const speakerTranscriptions: FakeSpeakerTranscriptionRealtime[] = [];
	const vox = new FakeBridgeClankvox();
	const runtime = new FakeVoiceRuntime();
	const discovery = new FakeVoiceStreamDiscovery({
		streamKey: "guild:guild-1:voice-1:streamer-1",
		guildId: "guild-1",
		channelId: "voice-1",
		userId: "streamer-1",
		endpoint: "voice.example",
		token: "stream-token",
		rtcServerId: "9002",
		updatedAt: Date.now(),
	});
	const handle = await startAgentDiscordVoiceBridge({
		runtime: runtime as never,
		client: new FakeVoiceDiscordClient() as never,
		discordConfig: {
			providerId: "clanky-discord",
			token: "discord-token",
			credentialKind: "user-token",
			source: "env",
		},
		config: {
			enabled: true,
			guildId: "guild-1",
			channelId: "voice-1",
			openAiApiKey: "openai-key",
			openAiRealtimeModel: DEFAULT_REALTIME_MODEL,
			openAiRealtimeVoice: "marin",
			transcriptResponseBatchDelayMs: 0,
		},
		dependencies: {
			createRealtime() {
				return realtime;
			},
			createTranscriptionRealtime() {
				const client = new FakeSpeakerTranscriptionRealtime(`speaker transcript ${speakerTranscriptions.length + 1}`);
				speakerTranscriptions.push(client);
				return client;
			},
			async spawnVox() {
				return vox;
			},
			createStreamDiscovery() {
				return discovery;
			},
		},
	});
	if (handle === undefined) throw new Error("voice-smoke: fake voice bridge did not start");
	if (!realtime.connected) throw new Error("voice-smoke: fake realtime was not connected by voice bridge");
	const tools = realtime.connectOptions?.tools
		?.map((tool) => tool.name)
		.sort()
		.join(",");
	if (
		tools !==
		"ask_pi,list_screen_shares,media_pause,media_resume,media_status,media_stop,pi_status,pi_subagents,play_music_url,play_video_url,see_screenshare_snapshot,start_music_visualizer,start_screen_watch,stop_screen_watch"
	) {
		throw new Error(`voice-smoke: fake voice bridge realtime tools mismatch: ${tools}`);
	}
	realtime.emit("audio_delta", "AQIDBA==");
	if (vox.audioSends[0]?.sampleRate !== 24_000) {
		throw new Error("voice-smoke: realtime audio delta was not sent to Discord audio");
	}
	handle.requestTextUtterance(" scripted voice prompt ");
	if (realtime.textUtterances[0] !== "scripted voice prompt") {
		throw new Error("voice-smoke: voice bridge did not forward scripted text utterance to Realtime");
	}
	realtime.emit("event", { type: "session.created" });
	realtime.emit("event", { type: "session.updated" });
	const restoreWarn = silenceConsoleWarn();
	try {
		realtime.emit("transcript", { text: "hello", eventType: "response.output_audio_transcript.delta" });
		realtime.emit("error_event", { type: "error", error: { message: "fake realtime error" } });
		realtime.emit("socket_error", new Error("fake socket error"));
		realtime.emit("socket_closed", { code: 1000, reason: "fake close" });
	} finally {
		restoreWarn();
	}
	vox.emit("speakingStart", "speaker-1");
	vox.emit("userAudio", "speaker-1", Buffer.alloc(4_800, 1));
	vox.emit("speakingStart", "speaker-2");
	vox.emit("userAudio", "speaker-2", Buffer.alloc(4_800, 2));
	vox.emit("userAudioEnd", "speaker-1");
	vox.emit("userAudioEnd", "speaker-2");
	await waitUntil(
		() =>
			realtime.textUtterances.some(
				(text) =>
					text.includes("Discord voice transcript with speaker attribution") &&
					text.includes("Speaker One (speaker-1): speaker transcript 1") &&
					text.includes("Speaker Two (speaker-2): speaker transcript 2"),
			),
		"speaker-attributed realtime transcript",
	);
	if (realtime.audioAppends !== 0 || realtime.commits !== 0) {
		throw new Error("voice-smoke: speaker audio should not be mixed into the main realtime response session");
	}
	if (
		speakerTranscriptions.length !== 2 ||
		speakerTranscriptions.some((client) => client.audioAppends.length !== 1 || client.commits !== 1)
	) {
		throw new Error("voice-smoke: per-speaker transcription sessions did not receive isolated audio");
	}
	if (speakerTranscriptions.some((client) => client.connectOptions?.model !== "gpt-realtime-whisper")) {
		throw new Error("voice-smoke: per-speaker transcription should connect with the transcription model");
	}
	const firstSubscription = vox.userSubscriptions[0];
	const secondSubscription = vox.userSubscriptions[1];
	if (
		firstSubscription === undefined ||
		secondSubscription === undefined ||
		firstSubscription.userId !== "speaker-1" ||
		firstSubscription.sampleRate !== 24_000 ||
		secondSubscription.userId !== "speaker-2" ||
		secondSubscription.silenceDurationMs !== 700
	) {
		throw new Error("voice-smoke: per-speaker transcription did not subscribe individual users");
	}

	realtime.emit("event", {
		type: "response.done",
		response: {
			output: [
				{
					type: "function_call",
					name: "ask_pi",
					call_id: "call-pi",
					arguments: '{"prompt":"summarize this for voice"}',
				},
			],
		},
	});
	await waitUntil(() => realtime.functionOutputs.some((output) => output.callId === "call-pi"), "ask_pi output");
	if (!runtime.session.messages[0]?.includes("summarize this for voice")) {
		throw new Error("voice-smoke: ask_pi did not forward prompt to Pi runtime");
	}
	const askOutput = expectRecord(
		realtime.functionOutputs.find((output) => output.callId === "call-pi")?.output,
		"ask_pi output",
	);
	if (askOutput.text !== "Pi voice answer.") throw new Error("voice-smoke: ask_pi output did not include Pi answer");

	realtime.emit("event", {
		type: "response.done",
		response: {
			output: [
				{
					type: "function_call",
					name: "pi_status",
					call_id: "call-pi-status",
					arguments: "{}",
				},
			],
		},
	});
	await waitUntil(
		() => realtime.functionOutputs.some((output) => output.callId === "call-pi-status"),
		"pi_status output",
	);
	const piStatusOutput = expectRecord(
		realtime.functionOutputs.find((output) => output.callId === "call-pi-status")?.output,
		"pi_status output",
	);
	const piStatusMain = expectRecord(piStatusOutput.main, "pi_status main");
	const piStatusVoice = expectRecord(piStatusOutput.voice, "pi_status voice");
	const piStatusSubagents = expectRecord(piStatusOutput.subagents, "pi_status subagents");
	if (
		piStatusOutput.ok !== true ||
		piStatusMain.voiceDelegationTarget !== "main-runtime" ||
		piStatusVoice.scopeId !== "guild-1:voice-1" ||
		piStatusSubagents.available !== false
	) {
		throw new Error(`voice-smoke: pi_status output mismatch ${JSON.stringify(piStatusOutput)}`);
	}

	realtime.emit("event", {
		type: "response.done",
		response: {
			output: [
				{
					type: "function_call",
					name: "pi_subagents",
					call_id: "call-pi-subagents",
					arguments: '{"limit":5}',
				},
			],
		},
	});
	await waitUntil(
		() => realtime.functionOutputs.some((output) => output.callId === "call-pi-subagents"),
		"pi_subagents output",
	);
	const piSubagentsOutput = expectRecord(
		realtime.functionOutputs.find((output) => output.callId === "call-pi-subagents")?.output,
		"pi_subagents output",
	);
	if (piSubagentsOutput.available !== false || !Array.isArray(piSubagentsOutput.subagents)) {
		throw new Error(`voice-smoke: pi_subagents unavailable output mismatch ${JSON.stringify(piSubagentsOutput)}`);
	}

	realtime.emit("event", {
		type: "response.done",
		response: {
			output: [
				{
					type: "function_call",
					name: "list_screen_shares",
					call_id: "call-list-screen",
					arguments: "{}",
				},
			],
		},
	});
	await waitUntil(
		() => realtime.functionOutputs.some((output) => output.callId === "call-list-screen"),
		"list_screen_shares output",
	);
	const listOutput = expectRecord(
		realtime.functionOutputs.find((output) => output.callId === "call-list-screen")?.output,
		"list_screen_shares output",
	);
	if (!Array.isArray(listOutput.streams) || listOutput.streams.length !== 1) {
		throw new Error("voice-smoke: list_screen_shares did not return discovered stream");
	}
	const listedStream = expectRecord(listOutput.streams[0], "listed stream");
	if (listedStream.streamKey !== "guild:guild-1:voice-1:streamer-1" || listedStream.hasCredentials !== true) {
		throw new Error("voice-smoke: list_screen_shares did not expose screen-share stream metadata");
	}

	realtime.emit("event", {
		type: "response.done",
		response: {
			output: [
				{
					type: "function_call",
					name: "start_screen_watch",
					call_id: "call-screen",
					arguments: '{"target":"streamer-1"}',
				},
			],
		},
	});
	await waitUntil(
		() => realtime.functionOutputs.some((output) => output.callId === "call-screen"),
		"start_screen_watch output",
	);
	if (discovery.requestedWatchKeys[0] !== "guild:guild-1:voice-1:streamer-1") {
		throw new Error("voice-smoke: start_screen_watch did not request Discord STREAM_WATCH");
	}
	if (vox.videoSubscriptions[0]?.userId !== "streamer-1") {
		throw new Error("voice-smoke: start_screen_watch did not subscribe target video");
	}
	const streamWatchConnect = vox.streamWatchConnections[0];
	if (streamWatchConnect?.sessionId !== "voice-session-1" || streamWatchConnect.daveChannelId !== "9001") {
		throw new Error("voice-smoke: start_screen_watch did not connect stream_watch with voice session/DAVE id");
	}
	const screenOutput = expectRecord(
		realtime.functionOutputs.find((output) => output.callId === "call-screen")?.output,
		"screen output",
	);
	if (screenOutput.ok !== true || screenOutput.hasCredentials !== true) {
		throw new Error("voice-smoke: start_screen_watch did not return successful credentialed status");
	}
	if (handle.status().activeStreamWatchKey !== "guild:guild-1:voice-1:streamer-1") {
		throw new Error("voice-smoke: voice bridge did not track active screen watch");
	}

	const frame: ClankvoxDecodedVideoFrame = {
		userId: "streamer-1",
		ssrc: 44,
		width: 640,
		height: 360,
		jpegBase64: "ZnJhbWU=",
		rtpTimestamp: 99,
		streamType: "screen",
		rid: null,
	};
	vox.emit("decodedVideoFrame", frame);
	await waitUntil(() => realtime.videoFrames.length === 1, "decoded frame append");
	const laterFrame: ClankvoxDecodedVideoFrame = {
		...frame,
		width: 800,
		height: 450,
		jpegBase64: "bGF0ZXItZnJhbWU=",
		rtpTimestamp: 100,
	};
	vox.emit("decodedVideoFrame", laterFrame);
	await sleep(10);
	if (realtime.videoFrames.length !== 1) {
		throw new Error("voice-smoke: rapid decoded screen frame should be throttled before auto-attach");
	}
	realtime.emit("event", {
		type: "response.done",
		response: {
			output: [
				{
					type: "function_call",
					name: "see_screenshare_snapshot",
					call_id: "call-snapshot",
					arguments: "{}",
				},
			],
		},
	});
	await waitUntil(
		() => realtime.functionOutputs.some((output) => output.callId === "call-snapshot"),
		"snapshot output",
	);
	const snapshotOutput = expectRecord(
		realtime.functionOutputs.find((output) => output.callId === "call-snapshot")?.output,
		"snapshot output",
	);
	const videoFrameCount = (realtime.videoFrames as unknown[]).length;
	if (snapshotOutput.ok !== true || snapshotOutput.width !== 800 || videoFrameCount !== 2) {
		throw new Error("voice-smoke: snapshot tool did not attach latest screen-share frame");
	}
	realtime.emit("event", {
		type: "response.done",
		response: {
			output: [
				{
					type: "function_call",
					name: "stop_screen_watch",
					call_id: "call-stop-screen",
					arguments: "{}",
				},
			],
		},
	});
	await waitUntil(
		() => realtime.functionOutputs.some((output) => output.callId === "call-stop-screen"),
		"stop_screen_watch output",
	);
	const stopOutput = expectRecord(
		realtime.functionOutputs.find((output) => output.callId === "call-stop-screen")?.output,
		"stop screen output",
	);
	if (stopOutput.ok !== true || stopOutput.streamKey !== "guild:guild-1:voice-1:streamer-1") {
		throw new Error("voice-smoke: stop_screen_watch did not return stopped screen-watch status");
	}
	if (handle.status().activeStreamWatchKey !== undefined || handle.status().activeVideoUserId !== undefined) {
		throw new Error("voice-smoke: stop_screen_watch did not clear active screen watch state");
	}
	realtime.emit("event", {
		type: "response.done",
		response: {
			output: [
				{
					type: "function_call",
					name: "ask_pi",
					call_id: "call-error",
					arguments: "{}",
				},
			],
		},
	});
	await waitUntil(() => realtime.functionOutputs.some((output) => output.callId === "call-error"), "tool error output");
	const errorOutput = expectRecord(
		realtime.functionOutputs.find((output) => output.callId === "call-error")?.output,
		"tool error output",
	);
	if (errorOutput.ok !== false || !String(errorOutput.error).includes("ask_pi requires prompt")) {
		throw new Error("voice-smoke: failed ask_pi did not return structured function-call error output");
	}
	const stats = expectRecord(handle.status().stats, "voice bridge stats");
	if (
		stats.realtimeAudioDeltaCount !== 1 ||
		stats.realtimeAudioDeltaBytes !== 4 ||
		stats.discordOutputAudioSendCount !== 1 ||
		stats.discordOutputAudioDropCount !== 0 ||
		stats.realtimeSessionCreatedCount !== 1 ||
		stats.realtimeSessionUpdatedCount !== 1 ||
		stats.realtimeTranscriptCount !== 3 ||
		stats.realtimeErrorEventCount !== 1 ||
		stats.realtimeSocketErrorCount !== 1 ||
		stats.realtimeSocketCloseCount !== 1
	) {
		throw new Error("voice-smoke: voice bridge did not count realtime audio/status output");
	}
	if (
		stats.speakingStartCount !== 2 ||
		stats.discordInputUniqueSpeakerCount !== 2 ||
		stats.discordInputMaxConcurrentSpeakers !== 2 ||
		stats.discordInputGroupOverlapCount !== 1 ||
		stats.discordInputAudioEventCount !== 2 ||
		stats.discordInputAudioBytes !== 9_600
	) {
		throw new Error("voice-smoke: voice bridge did not count Discord input audio");
	}
	if (stats.speakerTranscriptFinalCount !== 2 || stats.speakerTranscriptForwardCount !== 2) {
		throw new Error("voice-smoke: voice bridge did not count speaker-attributed transcripts");
	}
	if (
		stats.realtimeFunctionCallCount !== 8 ||
		stats.realtimeFunctionCallOutputCount !== 8 ||
		stats.realtimeFunctionCallErrorCount !== 1 ||
		stats.askPiCallCount !== 2 ||
		stats.piStatusRequestCount !== 1 ||
		stats.piSubagentStatusRequestCount !== 1
	) {
		throw new Error("voice-smoke: voice bridge did not count realtime tool calls");
	}
	if (stats.screenShareListCount !== 1) {
		throw new Error("voice-smoke: voice bridge did not count screen-share listing");
	}
	if (
		stats.screenWatchRequestCount !== 1 ||
		stats.screenWatchSuccessCount !== 1 ||
		stats.screenWatchStopCount !== 1 ||
		stats.streamWatchConnectCount !== 1 ||
		stats.streamWatchDisconnectCount !== 1
	) {
		throw new Error("voice-smoke: voice bridge did not count screen-watch setup");
	}
	if (
		stats.decodedVideoFrameCount !== 2 ||
		stats.snapshotSuccessCount !== 1 ||
		stats.videoFrameAttachCount !== 2 ||
		stats.videoFrameAutoAttachSkipCount !== 1
	) {
		throw new Error("voice-smoke: voice bridge did not count decoded/attached screen frames");
	}

	await handle.stop();
	if (!discovery.stopped) throw new Error("voice-smoke: fake stream discovery was not stopped");
	if (!vox.destroyed) throw new Error("voice-smoke: fake clankvox was not destroyed");
	if (vox.videoUnsubscriptions[0] !== "streamer-1") {
		throw new Error("voice-smoke: stop_screen_watch did not unsubscribe screen-share video");
	}
	if (vox.streamWatchDisconnects[0] !== "tool_stop_screen_watch" || vox.streamWatchDisconnects.length !== 1) {
		throw new Error("voice-smoke: stop_screen_watch did not disconnect stream_watch exactly once");
	}
}

async function assertFakeVoiceBridgeXAiRealtimeAgent(): Promise<void> {
	const realtime = new FakeBridgeRealtime();
	const speakerTranscription = new FakeSpeakerTranscriptionRealtime("speaker transcript");
	const vox = new FakeBridgeClankvox();
	const handle = await startAgentDiscordVoiceBridge({
		runtime: new FakeVoiceRuntime() as never,
		client: new FakeVoiceDiscordClient() as never,
		discordConfig: {
			providerId: "clanky-discord",
			token: "discord-token",
			credentialKind: "bot-token",
			source: "env",
		},
		config: {
			enabled: true,
			guildId: "guild-1",
			channelId: "voice-1",
			realtimeAgentProvider: "xai",
			openAiApiKey: "openai-key",
			openAiRealtimeModel: DEFAULT_REALTIME_MODEL,
			openAiRealtimeVoice: "marin",
			xAiApiKey: "xai-key",
			xAiRealtimeModel: "grok-voice-think-fast-1.0",
			xAiRealtimeVoice: "ara",
			transcriptResponseBatchDelayMs: 0,
		},
		dependencies: {
			createRealtime() {
				throw new Error("voice-smoke: xAI realtime agent should not use OpenAI realtime factory");
			},
			createXAiRealtime() {
				return realtime;
			},
			createTranscriptionRealtime() {
				return speakerTranscription;
			},
			async spawnVox() {
				return vox;
			},
		},
	});
	if (handle === undefined) throw new Error("voice-smoke: fake xAI voice bridge did not start");
	if (realtime.connectOptions?.model !== "grok-voice-think-fast-1.0" || realtime.connectOptions.voice !== "ara") {
		throw new Error(`voice-smoke: xAI realtime connect options mismatch ${JSON.stringify(realtime.connectOptions)}`);
	}
	const toolNames = new Set(realtime.connectOptions.tools?.map((tool) => tool.name) ?? []);
	if (!toolNames.has("ask_pi") || !toolNames.has("list_screen_shares")) {
		throw new Error("voice-smoke: xAI realtime agent should retain core voice tools");
	}
	if (toolNames.has("see_screenshare_snapshot") || toolNames.has("start_screen_watch")) {
		throw new Error("voice-smoke: xAI realtime agent should not expose screen-share image tools");
	}
	const voiceStatus = expectRecord(handle.status(), "xAI voice status");
	if (
		voiceStatus.realtimeAgentProvider !== "xai" ||
		voiceStatus.realtimeAgentModel !== "grok-voice-think-fast-1.0" ||
		voiceStatus.realtimeAgentVoice !== "ara" ||
		voiceStatus.speechOutputProvider !== "openai"
	) {
		throw new Error(`voice-smoke: xAI voice status mismatch ${JSON.stringify(voiceStatus)}`);
	}
	await handle.stop();
}

async function assertFakeVoiceBridgeElevenLabsTts(): Promise<void> {
	const realtime = new FakeBridgeRealtime();
	const vox = new FakeBridgeClankvox();
	const speech = new FakeSpeechSynthesizer();
	const handle = await startAgentDiscordVoiceBridge({
		runtime: new FakeVoiceRuntime() as never,
		client: new FakeVoiceDiscordClient() as never,
		discordConfig: {
			providerId: "clanky-discord",
			token: "discord-token",
			credentialKind: "bot-token",
			source: "env",
		},
		config: {
			enabled: true,
			guildId: "guild-1",
			channelId: "voice-1",
			ttsProvider: "elevenlabs",
			openAiApiKey: "openai-key",
			openAiRealtimeModel: DEFAULT_REALTIME_MODEL,
			openAiRealtimeVoice: "marin",
			elevenLabsApiKey: "elevenlabs-key",
			elevenLabsVoiceId: "eleven-voice",
			elevenLabsModel: "eleven_flash_v2_5",
		},
		dependencies: {
			createRealtime() {
				return realtime;
			},
			createTranscriptionRealtime() {
				return new FakeSpeakerTranscriptionRealtime("speaker transcript");
			},
			async spawnVox() {
				return vox;
			},
			createStreamDiscovery() {
				return new FakeVoiceStreamDiscovery({
					streamKey: "guild:guild-1:voice-1:streamer-1",
					guildId: "guild-1",
					channelId: "voice-1",
					userId: "streamer-1",
					endpoint: "voice.example",
					token: "stream-token",
					rtcServerId: "9002",
					updatedAt: Date.now(),
				});
			},
			createSpeechSynthesizer(config) {
				if (config.elevenLabsVoiceId !== "eleven-voice") {
					throw new Error("voice-smoke: ElevenLabs config was not passed to synthesizer");
				}
				return speech;
			},
		},
	});
	if (handle === undefined) throw new Error("voice-smoke: ElevenLabs voice bridge did not start");
	if (realtime.connectOptions?.responseOutputModality !== "text") {
		throw new Error("voice-smoke: ElevenLabs voice bridge should request text output from Realtime");
	}
	realtime.emit("audio_delta", "AQIDBA==");
	if (vox.audioSends.length !== 0) {
		throw new Error("voice-smoke: ElevenLabs voice bridge should ignore Realtime audio deltas");
	}
	realtime.emit("transcript", { eventType: "response.output_text.delta", itemId: "item-1", text: "Hello " });
	realtime.emit("transcript", { eventType: "response.output_text.delta", itemId: "item-1", text: "world." });
	realtime.emit("transcript", { eventType: "response.output_text.done", itemId: "item-1", text: "" });
	await waitUntil(() => vox.audioSends.length === 1, "ElevenLabs synthesized audio send");
	if (speech.texts[0] !== "Hello world.") {
		throw new Error(`voice-smoke: ElevenLabs synthesized wrong text ${JSON.stringify(speech.texts)}`);
	}
	if (vox.audioSends[0]?.pcmBase64 !== Buffer.from([1, 2, 3, 4]).toString("base64")) {
		throw new Error("voice-smoke: ElevenLabs PCM was not sent to Discord voice");
	}
	if (vox.audioSends[0]?.sampleRate !== 24_000) {
		throw new Error("voice-smoke: ElevenLabs PCM sample rate was not preserved");
	}
	await handle.stop();
}

async function assertFakeVoiceBridgeBargeInPolicy(): Promise<void> {
	const realtime = new FakeBridgeRealtime();
	const vox = new FakeBridgeClankvox();
	const transcripts = ["side chatter", "hey Clanky, hold on a second", "yo planky, one more thing"];
	const handle = await startAgentDiscordVoiceBridge({
		runtime: new FakeVoiceRuntime() as never,
		client: new FakeVoiceDiscordClient() as never,
		discordConfig: {
			providerId: "clanky-discord",
			token: "discord-token",
			credentialKind: "bot-token",
			source: "env",
		},
		config: {
			enabled: true,
			guildId: "guild-1",
			channelId: "voice-1",
			openAiApiKey: "openai-key",
			openAiRealtimeModel: DEFAULT_REALTIME_MODEL,
			openAiRealtimeVoice: "marin",
			transcriptResponseBatchDelayMs: 0,
		},
		dependencies: {
			createRealtime() {
				return realtime;
			},
			createTranscriptionRealtime() {
				return new FakeSpeakerTranscriptionRealtime(transcripts.shift() ?? "extra transcript");
			},
			async spawnVox() {
				return vox;
			},
			createStreamDiscovery() {
				return new FakeVoiceStreamDiscovery({
					streamKey: "guild:guild-1:voice-1:streamer-1",
					guildId: "guild-1",
					channelId: "voice-1",
					userId: "streamer-1",
					endpoint: "voice.example",
					token: "stream-token",
					rtcServerId: "9002",
					updatedAt: Date.now(),
				});
			},
		},
	});
	if (handle === undefined) throw new Error("voice-smoke: barge-in voice bridge did not start");
	vox.emit("bufferDepth", 24_000, 0);
	vox.emit("speakingStart", "speaker-1");
	vox.emit("userAudio", "speaker-1", Buffer.alloc(4_800, 1));
	vox.emit("userAudioEnd", "speaker-1");
	await sleep(10);
	if (realtime.textUtterances.length !== 0) {
		throw new Error("voice-smoke: side chatter should not barge in while Clanky is speaking");
	}
	realtime.emit("event", { type: "response.created" });
	vox.emit("bufferDepth", 24_000, 0);
	vox.emit("speakingStart", "speaker-2");
	vox.emit("userAudio", "speaker-2", Buffer.alloc(4_800, 2));
	vox.emit("userAudioEnd", "speaker-2");
	await waitUntil(
		() => realtime.textUtterances.some((text) => text.includes("hey Clanky, hold on a second")),
		"named barge-in transcript",
	);
	if (vox.stopTtsPlaybackCount !== 1 || realtime.cancelResponses !== 1) {
		throw new Error("voice-smoke: named barge-in did not stop current TTS and cancel Realtime response");
	}
	realtime.emit("event", { type: "response.created" });
	vox.emit("bufferDepth", 24_000, 0);
	vox.emit("speakingStart", "speaker-3");
	vox.emit("userAudio", "speaker-3", Buffer.alloc(4_800, 3));
	vox.emit("userAudioEnd", "speaker-3");
	await waitUntil(
		() => realtime.textUtterances.some((text) => text.includes("yo planky, one more thing")),
		"STT alias barge-in transcript",
	);
	if (Number(vox.stopTtsPlaybackCount) !== 2 || Number(realtime.cancelResponses) !== 2) {
		throw new Error("voice-smoke: STT alias barge-in did not stop current TTS and cancel Realtime response");
	}
	const stats = expectRecord(handle.status().stats, "barge-in stats");
	if (stats.voiceBargeInSuppressedCount !== 1 || stats.voiceBargeInAcceptedCount !== 2) {
		throw new Error("voice-smoke: barge-in stats were not counted");
	}
	await handle.stop();
}

async function assertFakeVoiceBridgeSubagents(): Promise<void> {
	const tmpRoot = await mkdtemp(join(tmpdir(), "clanky-voice-subagents-"));
	const paths = resolveClankyPaths({ homeDir: join(tmpRoot, "home") });
	const store = new DiscordSubagentStore(paths);
	try {
		const realtime = new FakeBridgeRealtime();
		const vox = new FakeBridgeClankvox();
		const workDir = join(tmpRoot, "work");
		const agentDir = join(tmpRoot, "agent");
		await mkdir(workDir, { recursive: true });
		await mkdir(agentDir, { recursive: true });
		const mainSession = new FakeVoiceRuntimeSession();
		const mainRuntime = {
			cwd: workDir,
			services: { agentDir },
			session: mainSession,
		};
		const voiceSupervisorDelegate: VoiceSupervisorDelegateHandle = {};
		const workerPrompts: string[] = [];
		const generalPrompts: string[] = [];
		let workerRuntimeCreateCount = 0;
		let generalRuntimeCreateCount = 0;
		let workerDisposedCount = 0;
		let generalDisposedCount = 0;
		const createFakeSubagentRuntimeFactory = (input: {
			answer: string;
			prompts: string[];
			onCreate: () => void;
			onDispose: () => void;
		}): CreateAgentSessionRuntimeFactory => {
			return async (options): Promise<CreateAgentSessionRuntimeResult> => {
				input.onCreate();
				const listeners = new Set<(event: AgentSessionEvent) => void>();
				const fakeSession = {
					isStreaming: false,
					sessionId: options.sessionManager.getSessionId(),
					sessionFile: options.sessionManager.getSessionFile(),
					sessionManager: options.sessionManager,
					extensionRunner: {
						hasHandlers: () => false,
						emit: async () => undefined,
					},
					subscribe(listener: (event: AgentSessionEvent) => void): () => void {
						listeners.add(listener);
						return () => listeners.delete(listener);
					},
					setThinkingLevel(): void {},
					async sendUserMessage(message: string): Promise<void> {
						input.prompts.push(message);
						options.sessionManager.appendMessage({
							role: "user",
							content: [{ type: "text", text: message }],
						} as never);
						queueMicrotask(() => {
							const assistantMessage = {
								role: "assistant",
								stopReason: "endTurn",
								content: [{ type: "text", text: input.answer }],
							};
							const event = {
								type: "message_end",
								message: assistantMessage,
							} as unknown as AgentSessionEvent;
							options.sessionManager.appendMessage(assistantMessage as never);
							for (const listener of listeners) listener(event);
						});
					},
					dispose(): void {
						input.onDispose();
					},
				};
				return {
					session: fakeSession as unknown as CreateAgentSessionRuntimeResult["session"],
					extensionsResult: {
						extensions: [],
						errors: [],
						runtime: {},
					} as unknown as CreateAgentSessionRuntimeResult["extensionsResult"],
					services: {
						cwd: options.cwd,
						agentDir: options.agentDir,
					} as unknown as CreateAgentSessionRuntimeResult["services"],
					diagnostics: [],
				};
			};
		};
		const createVoiceSubagentRuntime = createFakeSubagentRuntimeFactory({
			answer: "Worker voice answer.",
			prompts: workerPrompts,
			onCreate: () => {
				workerRuntimeCreateCount += 1;
			},
			onDispose: () => {
				workerDisposedCount += 1;
			},
		});
		const createSubagentRuntime = createFakeSubagentRuntimeFactory({
			answer: "General subagent answer.",
			prompts: generalPrompts,
			onCreate: () => {
				generalRuntimeCreateCount += 1;
			},
			onDispose: () => {
				generalDisposedCount += 1;
			},
		});
		const handle = await startAgentDiscordVoiceBridge({
			runtime: mainRuntime as never,
			client: new FakeVoiceDiscordClient() as never,
			discordConfig: {
				providerId: "clanky-discord",
				token: "discord-token",
				credentialKind: "bot-token",
				source: "env",
			},
			config: {
				enabled: true,
				guildId: "guild-1",
				channelId: "voice-1",
				openAiApiKey: "openai-key",
				openAiRealtimeModel: DEFAULT_REALTIME_MODEL,
				openAiRealtimeVoice: "marin",
			},
			createSubagentRuntime,
			createVoiceSubagentRuntime,
			subagentStore: store,
			subagentSessionDir: paths.subagentSessionsDir,
			subagentCwd: workDir,
			voiceSupervisorDelegate,
			dependencies: {
				createRealtime() {
					return realtime;
				},
				async spawnVox() {
					return vox;
				},
			},
		});
		if (handle === undefined) throw new Error("voice-smoke: subagent voice bridge did not start");
		let summaries = await store.listSubagents();
		const voiceSubagent = summaries.find((summary) => summary.id === "discord-voice:guild-1:voice-1");
		if (
			voiceSubagent === undefined ||
			voiceSubagent.kind !== "discord-voice" ||
			voiceSubagent.sessionFile === undefined ||
			voiceSubagent.state !== "running"
		) {
			throw new Error(`voice-smoke: voice subagent was not registered ${JSON.stringify(summaries)}`);
		}
		await waitUntil(() => workerRuntimeCreateCount === 1, "prewarmed voice worker runtime");
		summaries = await store.listSubagents();
		const prewarmedWorker = summaries.find((summary) => summary.id === "voice-worker:guild-1:voice-1");
		if (prewarmedWorker?.state !== "idle" || prewarmedWorker.sessionFile === undefined) {
			throw new Error(`voice-smoke: voice worker was not prewarmed ${JSON.stringify(summaries)}`);
		}
		const voiceSessionFile = voiceSubagent.sessionFile;
		realtime.emit("transcript", {
			eventType: "conversation.item.input_audio_transcription.completed",
			text: "can you check the queue",
		});
		realtime.emit("transcript", {
			eventType: "response.output_audio_transcript.done",
			text: "I'll check that.",
		});
		await waitUntil(async () => {
			const transcript = await readFile(voiceSessionFile, "utf8");
			return transcript.includes("can you check the queue") && transcript.includes("I'll check that.");
		}, "voice transcript session file");
		realtime.emit("event", {
			type: "response.done",
			response: {
				output: [
					{
						type: "function_call",
						name: "ask_pi",
						call_id: "call-worker",
						arguments: '{"prompt":"check durable project state"}',
					},
				],
			},
		});
		await waitUntil(() => realtime.functionOutputs.some((output) => output.callId === "call-worker"), "worker output");
		const output = realtime.functionOutputs.find((candidate) => candidate.callId === "call-worker")?.output;
		if (JSON.stringify(output) !== JSON.stringify({ text: "Worker voice answer." })) {
			throw new Error(`voice-smoke: ask_pi did not return worker answer ${JSON.stringify(output)}`);
		}
		if (mainSession.messages.length !== 0) {
			throw new Error(
				`voice-smoke: ask_pi used main runtime instead of worker ${JSON.stringify(mainSession.messages)}`,
			);
		}
		if (workerRuntimeCreateCount !== 1 || !workerPrompts[0]?.includes("check durable project state")) {
			throw new Error(`voice-smoke: worker runtime was not prompted ${JSON.stringify(workerPrompts)}`);
		}
		summaries = await store.listSubagents();
		const workerSubagent = summaries.find((summary) => summary.id === "voice-worker:guild-1:voice-1");
		if (
			workerSubagent?.kind !== "voice-worker" ||
			workerSubagent.sessionFile === undefined ||
			workerSubagent.state !== "idle"
		) {
			throw new Error(`voice-smoke: worker subagent was not tracked ${JSON.stringify(summaries)}`);
		}
		if (voiceSupervisorDelegate.delegateToSubagent === undefined) {
			throw new Error("voice-smoke: voice supervisor delegate was not installed");
		}
		const generalResult = await voiceSupervisorDelegate.delegateToSubagent({
			title: "Check bounded detail",
			prompt: "inspect the project detail",
			workerKey: "detail-checker",
			reason: "voice supervisor needs a bounded helper",
		});
		if (
			generalResult.delegated !== true ||
			generalResult.response !== "General subagent answer." ||
			generalResult.subagentId !== "voice-general:guild-1:voice-1:detail-checker" ||
			generalRuntimeCreateCount !== 1
		) {
			throw new Error(`voice-smoke: voice supervisor general delegation failed ${JSON.stringify(generalResult)}`);
		}
		if (
			!generalPrompts[0]?.includes("You cannot spawn child subagents") ||
			!generalPrompts[0]?.includes("inspect the project detail")
		) {
			throw new Error(`voice-smoke: general subagent prompt missed hierarchy ${JSON.stringify(generalPrompts)}`);
		}
		summaries = await store.listSubagents();
		const generalSubagent = summaries.find((summary) => summary.id === "voice-general:guild-1:voice-1:detail-checker");
		if (
			generalSubagent?.kind !== "voice-general" ||
			generalSubagent.sessionFile === undefined ||
			generalSubagent.state !== "idle"
		) {
			throw new Error(`voice-smoke: general voice subagent was not tracked ${JSON.stringify(summaries)}`);
		}
		realtime.emit("event", {
			type: "response.done",
			response: {
				output: [
					{
						type: "function_call",
						name: "pi_status",
						call_id: "call-subagent-status",
						arguments: "{}",
					},
				],
			},
		});
		await waitUntil(
			() => realtime.functionOutputs.some((candidate) => candidate.callId === "call-subagent-status"),
			"subagent pi_status output",
		);
		const statusOutput = expectRecord(
			realtime.functionOutputs.find((candidate) => candidate.callId === "call-subagent-status")?.output,
			"subagent pi_status output",
		);
		const statusSubagents = expectRecord(statusOutput.subagents, "subagent pi_status subagents");
		if (statusSubagents.available !== true || statusSubagents.filtered !== 3 || statusSubagents.returned !== 3) {
			throw new Error(`voice-smoke: pi_status did not include active subagents ${JSON.stringify(statusOutput)}`);
		}
		realtime.emit("event", {
			type: "response.done",
			response: {
				output: [
					{
						type: "function_call",
						name: "pi_subagents",
						call_id: "call-subagent-filter",
						arguments: '{"kind":"voice-worker","state":"idle","limit":1}',
					},
				],
			},
		});
		await waitUntil(
			() => realtime.functionOutputs.some((candidate) => candidate.callId === "call-subagent-filter"),
			"pi_subagents filtered output",
		);
		const filteredOutput = expectRecord(
			realtime.functionOutputs.find((candidate) => candidate.callId === "call-subagent-filter")?.output,
			"pi_subagents filtered output",
		);
		if (filteredOutput.available !== true || filteredOutput.filtered !== 1 || filteredOutput.returned !== 1) {
			throw new Error(`voice-smoke: pi_subagents did not filter worker status ${JSON.stringify(filteredOutput)}`);
		}
		const filteredSubagents = filteredOutput.subagents;
		if (
			!Array.isArray(filteredSubagents) ||
			expectRecord(filteredSubagents[0], "filtered subagent").id !== workerSubagent.id
		) {
			throw new Error(`voice-smoke: pi_subagents did not return the worker ${JSON.stringify(filteredOutput)}`);
		}
		const workerTranscript = await readFile(workerSubagent.sessionFile, "utf8");
		if (
			!workerTranscript.includes("check durable project state") ||
			!workerTranscript.includes("Worker voice answer.")
		) {
			throw new Error("voice-smoke: worker session transcript was not persisted");
		}
		await handle.stop();
		if (workerDisposedCount !== 1) {
			throw new Error(`voice-smoke: worker runtime was not disposed ${workerDisposedCount}`);
		}
		if (generalDisposedCount !== 1) {
			throw new Error(`voice-smoke: general runtime was not disposed ${generalDisposedCount}`);
		}
		summaries = await store.listSubagents();
		const stoppedVoiceSubagent = summaries.find((summary) => summary.id === "discord-voice:guild-1:voice-1");
		const stoppedWorkerSubagent = summaries.find((summary) => summary.id === "voice-worker:guild-1:voice-1");
		const stoppedGeneralSubagent = summaries.find(
			(summary) => summary.id === "voice-general:guild-1:voice-1:detail-checker",
		);
		if (
			stoppedVoiceSubagent?.state !== "stale" ||
			stoppedWorkerSubagent?.state !== "stale" ||
			stoppedGeneralSubagent?.state !== "stale"
		) {
			throw new Error(`voice-smoke: stopped voice subagents were not stale ${JSON.stringify(summaries)}`);
		}
	} finally {
		store.close();
		await rm(tmpRoot, { recursive: true, force: true });
	}
}

async function assertFakeVoiceBridgeRealtimeMediaTools(): Promise<void> {
	const realtime = new FakeBridgeRealtime();
	const vox = new FakeBridgeClankvox();
	const discovery = new FakeVoiceStreamDiscovery({
		streamKey: "guild:guild-1:voice-1:clanky-user",
		guildId: "guild-1",
		channelId: "voice-1",
		userId: "clanky-user",
		endpoint: "publish.example",
		token: "publish-token",
		rtcServerId: "9102",
		updatedAt: Date.now(),
	});
	const handle = await startAgentDiscordVoiceBridge({
		runtime: new FakeVoiceRuntime() as never,
		client: new FakeVoiceDiscordClient() as never,
		discordConfig: {
			providerId: "clanky-discord",
			token: "discord-token",
			credentialKind: "user-token",
			source: "env",
		},
		config: {
			enabled: true,
			guildId: "guild-1",
			channelId: "voice-1",
			openAiApiKey: "openai-key",
			openAiRealtimeModel: DEFAULT_REALTIME_MODEL,
			openAiRealtimeVoice: "marin",
		},
		dependencies: {
			createRealtime() {
				return realtime;
			},
			async spawnVox() {
				return vox;
			},
			createStreamDiscovery() {
				return discovery;
			},
		},
	});
	if (handle === undefined) throw new Error("voice-smoke: media voice bridge did not start");

	realtime.emit("event", {
		type: "response.done",
		response: {
			output: [
				{
					type: "function_call",
					name: "play_music_url",
					call_id: "call-music",
					arguments: '{"url":"https://example.com/song.mp3","resolvedDirectUrl":true}',
				},
			],
		},
	});
	await waitUntil(() => realtime.functionOutputs.some((output) => output.callId === "call-music"), "music output");
	if (vox.musicPlays[0]?.url !== "https://example.com/song.mp3" || vox.musicPlays[0].resolvedDirectUrl !== true) {
		throw new Error("voice-smoke: play_music_url did not send music_play to clankvox");
	}

	realtime.emit("event", {
		type: "response.done",
		response: {
			output: [
				{
					type: "function_call",
					name: "play_video_url",
					call_id: "call-video",
					arguments: '{"url":"https://www.youtube.com/watch?v=abc123"}',
				},
			],
		},
	});
	await waitUntil(() => realtime.functionOutputs.some((output) => output.callId === "call-video"), "video output");
	if (vox.musicPlays[1]?.url !== "https://www.youtube.com/watch?v=abc123") {
		throw new Error("voice-smoke: play_video_url did not start voice audio by default");
	}
	if (vox.streamPublishPlays[0]?.url !== "https://www.youtube.com/watch?v=abc123") {
		throw new Error("voice-smoke: play_video_url did not start stream_publish_play");
	}
	if (
		vox.streamPublishConnections[0]?.sessionId !== "voice-session-1" ||
		vox.streamPublishConnections[0]?.daveChannelId !== "9101"
	) {
		throw new Error("voice-smoke: play_video_url did not connect stream_publish with credentials");
	}
	if (discovery.publishRequests.length !== 0) {
		throw new Error("voice-smoke: play_video_url should not send OP18 when self stream credentials already exist");
	}

	realtime.emit("event", {
		type: "response.done",
		response: {
			output: [
				{
					type: "function_call",
					name: "start_music_visualizer",
					call_id: "call-visualizer",
					arguments: '{"visualizerMode":"waves"}',
				},
			],
		},
	});
	await waitUntil(
		() => realtime.functionOutputs.some((output) => output.callId === "call-visualizer"),
		"visualizer output",
	);
	if (vox.streamPublishVisualizers[0]?.visualizerMode !== "waves") {
		throw new Error("voice-smoke: start_music_visualizer did not start requested visualizer mode");
	}

	realtime.emit("event", {
		type: "response.done",
		response: {
			output: [
				{ type: "function_call", name: "media_pause", call_id: "call-media-pause", arguments: "{}" },
				{ type: "function_call", name: "media_resume", call_id: "call-media-resume", arguments: "{}" },
				{ type: "function_call", name: "media_status", call_id: "call-media-status", arguments: "{}" },
				{ type: "function_call", name: "media_stop", call_id: "call-media-stop", arguments: "{}" },
			],
		},
	});
	await waitUntil(
		() => realtime.functionOutputs.some((output) => output.callId === "call-media-stop"),
		"media control outputs",
	);
	if (vox.musicPauses !== 1 || vox.musicResumes !== 1 || vox.musicStops !== 1) {
		throw new Error("voice-smoke: media pause/resume/stop did not control music playback");
	}
	if (vox.streamPublishPauses !== 1 || vox.streamPublishResumes !== 1 || vox.streamPublishStops < 1) {
		throw new Error("voice-smoke: media pause/resume/stop did not control stream publish");
	}
	if (discovery.publishPaused.length !== 2 || discovery.publishStops[0] !== "guild:guild-1:voice-1:clanky-user") {
		throw new Error("voice-smoke: media controls did not send Go Live pause/delete gateway requests");
	}
	const stats = expectRecord(handle.status().stats, "media stats");
	if (
		stats.musicPlayRequestCount !== 2 ||
		stats.streamPublishRequestCount !== 2 ||
		stats.streamPublishConnectCount !== 2 ||
		stats.musicPauseRequestCount !== 1 ||
		stats.musicResumeRequestCount !== 1 ||
		stats.musicStopRequestCount !== 1
	) {
		throw new Error("voice-smoke: media tool stats did not increment");
	}
	await handle.stop();
}

async function assertFakeVoiceBridgeRealtimeBatchToolResponse(): Promise<void> {
	const realtime = new FakeBridgeRealtime();
	const vox = new FakeBridgeClankvox();
	const runtime = new FakeVoiceRuntime();
	const discovery = new FakeVoiceStreamDiscovery({
		streamKey: "guild:guild-1:voice-1:streamer-1",
		guildId: "guild-1",
		channelId: "voice-1",
		userId: "streamer-1",
		endpoint: "voice.example",
		token: "stream-token",
		rtcServerId: "9002",
		updatedAt: Date.now(),
	});
	const handle = await startAgentDiscordVoiceBridge({
		runtime: runtime as never,
		client: new FakeVoiceDiscordClient() as never,
		discordConfig: {
			providerId: "clanky-discord",
			token: "discord-token",
			credentialKind: "user-token",
			source: "env",
		},
		config: {
			enabled: true,
			guildId: "guild-1",
			channelId: "voice-1",
			openAiApiKey: "openai-key",
			openAiRealtimeModel: DEFAULT_REALTIME_MODEL,
			openAiRealtimeVoice: "marin",
		},
		dependencies: {
			createRealtime() {
				return realtime;
			},
			async spawnVox() {
				return vox;
			},
			createStreamDiscovery() {
				return discovery;
			},
		},
	});
	if (handle === undefined) throw new Error("voice-smoke: batch tool voice bridge did not start");
	realtime.emit("event", {
		type: "response.done",
		response: {
			output: [
				{
					type: "function_call",
					name: "list_screen_shares",
					call_id: "call-batch-list",
					arguments: "{}",
				},
				{
					type: "function_call",
					name: "start_screen_watch",
					call_id: "call-batch-screen",
					arguments: '{"target":"streamer-1"}',
				},
			],
		},
	});
	await waitUntil(() => realtime.functionOutputs.length === 2, "batch realtime tool outputs");
	await waitUntil(() => realtime.responses === 1, "batch realtime audio response");
	if (realtime.responses !== 1) {
		throw new Error(`voice-smoke: batch realtime tool calls created ${realtime.responses} audio responses`);
	}
	if (vox.streamWatchConnections.length !== 1) {
		throw new Error("voice-smoke: batch realtime tool call did not connect screen watch");
	}
	const stats = expectRecord(handle.status().stats, "batch realtime tool stats");
	if (stats.realtimeFunctionCallCount !== 2 || stats.realtimeFunctionCallOutputCount !== 2) {
		throw new Error("voice-smoke: batch realtime tool calls were not counted");
	}
	await handle.stop();
}

async function assertFakeVoiceBridgeBotTokenScreenWatchGuard(): Promise<void> {
	const realtime = new FakeBridgeRealtime();
	const vox = new FakeBridgeClankvox();
	const discovery = new FakeVoiceStreamDiscovery({
		streamKey: "guild:guild-1:voice-1:streamer-1",
		guildId: "guild-1",
		channelId: "voice-1",
		userId: "streamer-1",
		endpoint: "voice.example",
		token: "stream-token",
		rtcServerId: "9002",
		updatedAt: Date.now(),
	});
	const handle = await startAgentDiscordVoiceBridge({
		runtime: new FakeVoiceRuntime() as never,
		client: new FakeVoiceDiscordClient() as never,
		discordConfig: {
			providerId: "clanky-discord",
			token: "discord-token",
			credentialKind: "bot-token",
			source: "env",
		},
		config: {
			enabled: true,
			guildId: "guild-1",
			channelId: "voice-1",
			openAiApiKey: "openai-key",
			openAiRealtimeModel: DEFAULT_REALTIME_MODEL,
			openAiRealtimeVoice: "marin",
		},
		dependencies: {
			createRealtime() {
				return realtime;
			},
			async spawnVox() {
				return vox;
			},
			createStreamDiscovery() {
				return discovery;
			},
		},
	});
	if (handle === undefined) throw new Error("voice-smoke: bot-token voice bridge did not start");
	if (handle.status().nativeScreenWatchSupported !== false) {
		throw new Error("voice-smoke: bot-token voice bridge should report native screen watch unsupported");
	}
	realtime.emit("event", {
		type: "response.done",
		response: {
			output: [
				{
					type: "function_call",
					name: "list_screen_shares",
					call_id: "call-list-bot-screen",
					arguments: "{}",
				},
			],
		},
	});
	await waitUntil(
		() => realtime.functionOutputs.some((output) => output.callId === "call-list-bot-screen"),
		"bot-token list_screen_shares output",
	);
	const listOutput = expectRecord(
		realtime.functionOutputs.find((output) => output.callId === "call-list-bot-screen")?.output,
		"bot-token list_screen_shares output",
	);
	if (listOutput.nativeWatchSupported !== false || !String(listOutput.warning).includes("user-token")) {
		throw new Error("voice-smoke: bot-token list_screen_shares did not report user-token requirement");
	}
	realtime.emit("event", {
		type: "response.done",
		response: {
			output: [
				{
					type: "function_call",
					name: "start_screen_watch",
					call_id: "call-screen-bot-token",
					arguments: '{"target":"streamer-1"}',
				},
			],
		},
	});
	await waitUntil(
		() => realtime.functionOutputs.some((output) => output.callId === "call-screen-bot-token"),
		"bot-token start_screen_watch output",
	);
	const screenOutput = expectRecord(
		realtime.functionOutputs.find((output) => output.callId === "call-screen-bot-token")?.output,
		"bot-token screen output",
	);
	if (screenOutput.ok !== false || screenOutput.credentialKind !== "bot-token") {
		throw new Error("voice-smoke: bot-token start_screen_watch did not return unsupported credential result");
	}
	if (
		discovery.requestedWatchKeys.length !== 0 ||
		vox.videoSubscriptions.length !== 0 ||
		vox.streamWatchConnections.length !== 0
	) {
		throw new Error("voice-smoke: bot-token start_screen_watch should not issue native watch commands");
	}
	const stats = expectRecord(handle.status().stats, "bot-token screen watch stats");
	if (stats.screenWatchRequestCount !== 1 || stats.screenWatchUnsupportedCount !== 1) {
		throw new Error("voice-smoke: bot-token screen watch unsupported stats were not counted");
	}
	await handle.stop();
}

async function assertFakeVoiceBridgeScreenWatchSwitchCleanup(): Promise<void> {
	const realtime = new FakeBridgeRealtime();
	const vox = new FakeBridgeClankvox();
	const discovery = new FakeVoiceMultiStreamDiscovery([
		{
			streamKey: "guild:guild-1:voice-1:streamer-1",
			guildId: "guild-1",
			channelId: "voice-1",
			userId: "streamer-1",
			endpoint: "voice-1.example",
			token: "stream-token-1",
			rtcServerId: "9002",
			updatedAt: Date.now(),
		},
		{
			streamKey: "guild:guild-1:voice-1:streamer-2",
			guildId: "guild-1",
			channelId: "voice-1",
			userId: "streamer-2",
			endpoint: "voice-2.example",
			token: "stream-token-2",
			rtcServerId: "9004",
			updatedAt: Date.now() + 1,
		},
	]);
	const handle = await startAgentDiscordVoiceBridge({
		runtime: new FakeVoiceRuntime() as never,
		client: new FakeVoiceDiscordClient() as never,
		discordConfig: {
			providerId: "clanky-discord",
			token: "discord-token",
			credentialKind: "user-token",
			source: "env",
		},
		config: {
			enabled: true,
			guildId: "guild-1",
			channelId: "voice-1",
			openAiApiKey: "openai-key",
			openAiRealtimeModel: DEFAULT_REALTIME_MODEL,
			openAiRealtimeVoice: "marin",
		},
		dependencies: {
			createRealtime() {
				return realtime;
			},
			async spawnVox() {
				return vox;
			},
			createStreamDiscovery() {
				return discovery;
			},
		},
	});
	if (handle === undefined) throw new Error("voice-smoke: switch voice bridge did not start");
	realtime.emit("event", {
		type: "response.done",
		response: {
			output: [
				{
					type: "function_call",
					name: "start_screen_watch",
					call_id: "call-screen-switch-1",
					arguments: '{"target":"streamer-1"}',
				},
			],
		},
	});
	await waitUntil(
		() => realtime.functionOutputs.some((output) => output.callId === "call-screen-switch-1"),
		"first switch start_screen_watch output",
	);
	realtime.emit("event", {
		type: "response.done",
		response: {
			output: [
				{
					type: "function_call",
					name: "start_screen_watch",
					call_id: "call-screen-switch-2",
					arguments: '{"target":"streamer-2"}',
				},
			],
		},
	});
	await waitUntil(
		() => realtime.functionOutputs.some((output) => output.callId === "call-screen-switch-2"),
		"second switch start_screen_watch output",
	);
	if (vox.videoUnsubscriptions[0] !== "streamer-1") {
		throw new Error("voice-smoke: switching screen watch did not unsubscribe prior video user");
	}
	if (vox.streamWatchDisconnects[0] !== "screen_watch_switch") {
		throw new Error("voice-smoke: switching screen watch did not disconnect previous stream_watch");
	}
	if (vox.streamWatchConnections.length !== 2 || vox.streamWatchConnections[1]?.daveChannelId !== "9003") {
		throw new Error("voice-smoke: switching screen watch did not connect the second stream");
	}
	if (handle.status().activeStreamWatchKey !== "guild:guild-1:voice-1:streamer-2") {
		throw new Error("voice-smoke: switching screen watch did not update active stream key");
	}
	await handle.stop();
	if (vox.streamWatchDisconnects[1] !== "voice_bridge_stop") {
		throw new Error("voice-smoke: switched screen watch did not disconnect active stream on bridge stop");
	}
}

async function assertFakeVoiceBridgeGatewaySessionFallback(): Promise<void> {
	const realtime = new FakeBridgeRealtime();
	const vox = new FakeBridgeClankvox();
	vox.voiceSessionId = undefined;
	const discovery = new FakeVoiceStreamDiscovery({
		streamKey: "guild:guild-1:voice-1:streamer-1",
		guildId: "guild-1",
		channelId: "voice-1",
		userId: "streamer-1",
		endpoint: "voice.example",
		token: "stream-token",
		rtcServerId: "9002",
		updatedAt: Date.now(),
	});
	const handle = await startAgentDiscordVoiceBridge({
		runtime: new FakeVoiceRuntime() as never,
		client: new FakeVoiceDiscordClient("gateway-session-1") as never,
		discordConfig: {
			providerId: "clanky-discord",
			token: "discord-token",
			credentialKind: "user-token",
			source: "env",
		},
		config: {
			enabled: true,
			guildId: "guild-1",
			channelId: "voice-1",
			openAiApiKey: "openai-key",
			openAiRealtimeModel: DEFAULT_REALTIME_MODEL,
			openAiRealtimeVoice: "marin",
		},
		dependencies: {
			createRealtime() {
				return realtime;
			},
			async spawnVox() {
				return vox;
			},
			createStreamDiscovery() {
				return discovery;
			},
		},
	});
	if (handle === undefined) throw new Error("voice-smoke: fallback voice bridge did not start");
	realtime.emit("event", {
		type: "response.done",
		response: {
			output: [
				{
					type: "function_call",
					name: "start_screen_watch",
					call_id: "call-screen-fallback",
					arguments: '{"target":"streamer-1"}',
				},
			],
		},
	});
	await waitUntil(
		() => realtime.functionOutputs.some((output) => output.callId === "call-screen-fallback"),
		"fallback start_screen_watch output",
	);
	if (vox.streamWatchConnections[0]?.sessionId !== "gateway-session-1") {
		throw new Error("voice-smoke: screen watch did not fall back to Discord gateway voice session id");
	}
	await handle.stop();
}

async function assertFakeVoiceBridgeRealtimeStreamingToolDedup(): Promise<void> {
	const realtime = new FakeBridgeRealtime();
	const vox = new FakeBridgeClankvox();
	const runtime = new FakeVoiceRuntime();
	const handle = await startAgentDiscordVoiceBridge({
		runtime: runtime as never,
		client: new FakeVoiceDiscordClient() as never,
		discordConfig: {
			providerId: "clanky-discord",
			token: "discord-token",
			credentialKind: "bot-token",
			source: "env",
		},
		config: {
			enabled: true,
			guildId: "guild-1",
			channelId: "voice-1",
			openAiApiKey: "openai-key",
			openAiRealtimeModel: DEFAULT_REALTIME_MODEL,
			openAiRealtimeVoice: "marin",
		},
		dependencies: {
			createRealtime() {
				return realtime;
			},
			async spawnVox() {
				return vox;
			},
			createStreamDiscovery() {
				return new FakeVoiceStreamDiscovery({
					streamKey: "guild:guild-1:voice-1:streamer-1",
					guildId: "guild-1",
					channelId: "voice-1",
					userId: "streamer-1",
					endpoint: null,
					token: null,
					rtcServerId: null,
					updatedAt: Date.now(),
				});
			},
		},
	});
	if (handle === undefined) throw new Error("voice-smoke: streaming tool bridge did not start");
	const item = {
		id: "item-stream",
		type: "function_call",
		name: "ask_pi",
		call_id: "call-stream",
		arguments: '{"prompt":"streamed prompt"}',
	};
	realtime.emit("event", {
		type: "response.output_item.added",
		item: { ...item, arguments: "" },
		output_index: 0,
		response_id: "response-stream",
	});
	realtime.emit("event", {
		type: "response.function_call_arguments.delta",
		call_id: "call-stream",
		item_id: "item-stream",
		delta: '{"prompt":',
		output_index: 0,
		response_id: "response-stream",
	});
	realtime.emit("event", {
		type: "response.function_call_arguments.delta",
		call_id: "call-stream",
		item_id: "item-stream",
		delta: '"streamed prompt"}',
		output_index: 0,
		response_id: "response-stream",
	});
	realtime.emit("event", {
		type: "response.function_call_arguments.done",
		name: "ask_pi",
		call_id: "call-stream",
		item_id: "item-stream",
		arguments: '{"prompt":"streamed prompt"}',
		output_index: 0,
		response_id: "response-stream",
	});
	await waitUntil(
		() => realtime.functionOutputs.some((output) => output.callId === "call-stream"),
		"streaming ask_pi output",
	);
	realtime.emit("event", {
		type: "response.output_item.done",
		item,
		output_index: 0,
		response_id: "response-stream",
	});
	realtime.emit("event", {
		type: "response.done",
		response: { output: [item] },
	});
	await sleep(10);
	const outputs = realtime.functionOutputs.filter((output) => output.callId === "call-stream");
	if (outputs.length !== 1) {
		throw new Error(`voice-smoke: streamed realtime tool call executed ${outputs.length} times`);
	}
	if (runtime.session.messages.length !== 1 || !runtime.session.messages[0]?.includes("streamed prompt")) {
		throw new Error("voice-smoke: streamed realtime tool call did not execute ask_pi exactly once");
	}
	await handle.stop();
}

async function assertFakeVoiceBridgeRealtimeDuplicateAskPiCoalesces(): Promise<void> {
	const realtime = new FakeBridgeRealtime();
	const vox = new FakeBridgeClankvox();
	const runtime = new FakeVoiceRuntime();
	const handle = await startAgentDiscordVoiceBridge({
		runtime: runtime as never,
		client: new FakeVoiceDiscordClient() as never,
		discordConfig: {
			providerId: "clanky-discord",
			token: "discord-token",
			credentialKind: "bot-token",
			source: "env",
		},
		config: {
			enabled: true,
			guildId: "guild-1",
			channelId: "voice-1",
			openAiApiKey: "openai-key",
			openAiRealtimeModel: DEFAULT_REALTIME_MODEL,
			openAiRealtimeVoice: "marin",
		},
		dependencies: {
			createRealtime() {
				return realtime;
			},
			async spawnVox() {
				return vox;
			},
			createStreamDiscovery() {
				return new FakeVoiceStreamDiscovery({
					streamKey: "guild:guild-1:voice-1:streamer-1",
					guildId: "guild-1",
					channelId: "voice-1",
					userId: "streamer-1",
					endpoint: null,
					token: null,
					rtcServerId: null,
					updatedAt: Date.now(),
				});
			},
		},
	});
	if (handle === undefined) throw new Error("voice-smoke: duplicate ask_pi voice bridge did not start");
	for (const callId of ["call-dup-1", "call-dup-2", "call-dup-3"]) {
		realtime.emit("event", {
			type: "response.function_call_arguments.done",
			name: "ask_pi",
			call_id: callId,
			arguments: '{"prompt":"open chrome as a test"}',
		});
	}
	await waitUntil(() => realtime.functionOutputs.length === 3, "duplicate ask_pi outputs");
	await waitUntil(() => realtime.responses === 1, "duplicate ask_pi audio response");
	if (runtime.session.messages.length !== 1) {
		throw new Error(`voice-smoke: duplicate ask_pi forwarded ${runtime.session.messages.length} Pi requests`);
	}
	const stats = expectRecord(handle.status().stats, "duplicate ask_pi stats");
	if (stats.askPiCallCount !== 1 || stats.realtimeFunctionCallOutputCount !== 3) {
		throw new Error("voice-smoke: duplicate ask_pi stats did not show one Pi call and three tool outputs");
	}
	await handle.stop();
}

class FakeRawGatewayClient {
	readonly sent: { shardId: number; payload: { op: number; d: unknown } }[] = [];
	private listener: ((packet: DiscordRawPacket) => void) | undefined;
	readonly ws = {
		_ws: {
			send: (shardId: number, payload: { op: number; d: unknown }) => {
				this.sent.push({ shardId, payload });
			},
		},
		shards: {
			first: () => ({ id: 7 }),
		},
	};

	on(event: "raw", listener: (packet: DiscordRawPacket) => void): void {
		if (event === "raw") this.listener = listener;
	}

	off(event: "raw", listener: (packet: DiscordRawPacket) => void): void {
		if (event === "raw" && this.listener === listener) this.listener = undefined;
	}

	emitRaw(packet: DiscordRawPacket): void {
		this.listener?.(packet);
	}
}

class FakeClankvox extends EventEmitter {
	readonly subscriptions: string[] = [];

	subscribeUser(userId: string): void {
		this.subscriptions.push(userId);
	}
}

class FakeRealtime {
	audioAppends = 0;
	commits = 0;
	responses = 0;
	cancelResponses = 0;
	videoFrames = 0;

	appendInputAudioPcm(): void {
		this.audioAppends += 1;
	}

	commitInputAudioBuffer(): void {
		this.commits += 1;
	}

	createAudioResponse(): void {
		this.responses += 1;
	}

	cancelResponse(): void {
		this.cancelResponses += 1;
	}

	appendInputVideoFrame(): void {
		this.videoFrames += 1;
	}
}

class FakeVoiceDiscordClient extends EventEmitter {
	readonly user = { id: "clanky-user", username: "clanky" };
	readonly users = {
		cache: {
			get: (id: string) => {
				if (id === "speaker-1") return { username: "Speaker One" };
				if (id === "speaker-2") return { username: "Speaker Two" };
				return undefined;
			},
		},
	};
	readonly guild: JsonRecord;
	readonly guilds = {
		cache: {
			get: () => this.guild,
		},
		fetch: async () => this.guild,
	};
	readonly ws = {
		_ws: {
			send() {},
		},
		shards: {
			first: () => ({ id: 0 }),
		},
	};

	constructor(gatewaySessionId?: string) {
		super();
		this.guild = {
			voiceAdapterCreator: () => ({ destroy() {} }),
			members:
				gatewaySessionId === undefined
					? undefined
					: {
							me: {
								voice: { sessionId: gatewaySessionId },
							},
						},
		};
	}

	isReady(): boolean {
		return true;
	}
}

class FakeVoiceRuntimeSession {
	readonly messages: string[] = [];
	private readonly subscribers = new Set<(event: JsonRecord) => void>();

	subscribe(listener: (event: JsonRecord) => void): () => void {
		this.subscribers.add(listener);
		return () => {
			this.subscribers.delete(listener);
		};
	}

	async sendUserMessage(message: string): Promise<void> {
		this.messages.push(message);
		queueMicrotask(() => {
			this.emit({
				type: "message_end",
				message: {
					role: "assistant",
					stopReason: "endTurn",
					content: [{ type: "text", text: "Pi voice answer." }],
				},
			});
		});
	}

	private emit(event: JsonRecord): void {
		for (const subscriber of this.subscribers) subscriber(event);
	}
}

class FakeVoiceRuntime {
	readonly session = new FakeVoiceRuntimeSession();
}

class FakeBridgeRealtime extends EventEmitter {
	connected = false;
	closed = false;
	connectOptions:
		| {
				model?: string;
				voice?: string;
				tools?: { name: string }[];
				responseOutputModality?: string;
		  }
		| undefined;
	readonly functionOutputs: { callId: string; output: unknown }[] = [];
	readonly videoFrames: { mimeType: string; dataBase64: string }[] = [];
	readonly textUtterances: string[] = [];
	audioAppends = 0;
	commits = 0;
	responses = 0;
	cancelResponses = 0;

	async connect(options: {
		model?: string;
		voice?: string;
		tools?: { name: string }[];
		responseOutputModality?: string;
	}): Promise<void> {
		this.connected = true;
		this.connectOptions = options;
	}

	async close(): Promise<void> {
		this.closed = true;
	}

	appendInputAudioPcm(): void {
		this.audioAppends += 1;
	}

	commitInputAudioBuffer(): void {
		this.commits += 1;
	}

	createAudioResponse(): void {
		this.responses += 1;
	}

	cancelResponse(): void {
		this.cancelResponses += 1;
	}

	appendInputVideoFrame(input: { mimeType: string; dataBase64: string }): void {
		this.videoFrames.push(input);
	}

	requestTextUtterance(text: string): void {
		this.textUtterances.push(text);
	}

	sendFunctionCallOutput(input: { callId: string; output: unknown }): void {
		this.functionOutputs.push(input);
	}
}

class FakeSpeechSynthesizer {
	readonly texts: string[] = [];

	async synthesize(text: string, onAudio: (chunk: { pcmBase64: string; sampleRate: number }) => void): Promise<void> {
		this.texts.push(text);
		onAudio({ pcmBase64: Buffer.from([1, 2, 3, 4]).toString("base64"), sampleRate: 24_000 });
	}
}

class FakeSpeakerTranscriptionRealtime extends EventEmitter {
	connected = false;
	closed = false;
	connectOptions: OpenAiRealtimeTranscriptionConnectOptions | undefined;
	readonly audioAppends: Buffer[] = [];
	private readonly transcriptText: string;
	commits = 0;

	constructor(transcriptText: string) {
		super();
		this.transcriptText = transcriptText;
	}

	async connect(options: OpenAiRealtimeTranscriptionConnectOptions): Promise<void> {
		this.connected = true;
		this.connectOptions = options;
	}

	appendInputAudioPcm(audio: Buffer): void {
		this.audioAppends.push(audio);
	}

	commitInputAudioBuffer(): void {
		this.commits += 1;
		this.emit("transcript", {
			eventType: "conversation.item.input_audio_transcription.completed",
			text: this.transcriptText,
		});
	}

	async close(): Promise<void> {
		this.closed = true;
	}
}

class FakeBridgeClankvox extends EventEmitter {
	readonly isAlive = true;
	readonly userSubscriptions: { userId: string; silenceDurationMs?: number; sampleRate?: number }[] = [];
	readonly videoSubscriptions: { userId: string }[] = [];
	readonly videoUnsubscriptions: string[] = [];
	readonly streamWatchConnections: {
		endpoint: string;
		token: string;
		serverId: string;
		sessionId: string;
		userId: string;
		daveChannelId: string;
	}[] = [];
	readonly streamWatchDisconnects: (string | null | undefined)[] = [];
	readonly streamPublishConnections: {
		endpoint: string;
		token: string;
		serverId: string;
		sessionId: string;
		userId: string;
		daveChannelId: string;
	}[] = [];
	readonly streamPublishDisconnects: (string | null | undefined)[] = [];
	readonly musicPlays: { url: string; resolvedDirectUrl?: boolean }[] = [];
	readonly streamPublishPlays: { url: string; resolvedDirectUrl?: boolean }[] = [];
	readonly streamPublishVisualizers: { url: string; resolvedDirectUrl?: boolean; visualizerMode?: string }[] = [];
	readonly audioSends: { pcmBase64: string; sampleRate?: number }[] = [];
	musicStops = 0;
	musicPauses = 0;
	musicResumes = 0;
	musicGainSets: { target: number; fadeMs: number }[] = [];
	streamPublishStops = 0;
	streamPublishPauses = 0;
	streamPublishResumes = 0;
	stopPlaybackCount = 0;
	stopTtsPlaybackCount = 0;
	destroyed = false;
	voiceSessionId: string | undefined = "voice-session-1";

	sendAudio(pcmBase64: string, sampleRate?: number): void {
		const send: { pcmBase64: string; sampleRate?: number } = { pcmBase64 };
		if (sampleRate !== undefined) send.sampleRate = sampleRate;
		this.audioSends.push(send);
	}

	stopPlayback(): void {
		this.stopPlaybackCount += 1;
	}

	stopTtsPlayback(): void {
		this.stopTtsPlaybackCount += 1;
	}

	subscribeUser(userId: string, silenceDurationMs?: number, sampleRate?: number): void {
		const subscription: { userId: string; silenceDurationMs?: number; sampleRate?: number } = { userId };
		if (silenceDurationMs !== undefined) subscription.silenceDurationMs = silenceDurationMs;
		if (sampleRate !== undefined) subscription.sampleRate = sampleRate;
		this.userSubscriptions.push(subscription);
	}

	subscribeUserVideo(input: { userId: string }): void {
		this.videoSubscriptions.push(input);
	}

	unsubscribeUserVideo(userId: string): void {
		this.videoUnsubscriptions.push(userId);
	}

	streamWatchConnect(input: {
		endpoint: string;
		token: string;
		serverId: string;
		sessionId: string;
		userId: string;
		daveChannelId: string;
	}): void {
		this.streamWatchConnections.push(input);
	}

	streamWatchDisconnect(reason?: string | null): void {
		this.streamWatchDisconnects.push(reason);
	}

	streamPublishConnect(input: {
		endpoint: string;
		token: string;
		serverId: string;
		sessionId: string;
		userId: string;
		daveChannelId: string;
	}): void {
		this.streamPublishConnections.push(input);
	}

	streamPublishDisconnect(reason?: string | null): void {
		this.streamPublishDisconnects.push(reason);
	}

	musicPlay(url: string, resolvedDirectUrl?: boolean): void {
		const entry: { url: string; resolvedDirectUrl?: boolean } = { url };
		if (resolvedDirectUrl !== undefined) entry.resolvedDirectUrl = resolvedDirectUrl;
		this.musicPlays.push(entry);
	}

	musicStop(): void {
		this.musicStops += 1;
	}

	musicPause(): void {
		this.musicPauses += 1;
	}

	musicResume(): void {
		this.musicResumes += 1;
	}

	musicSetGain(target: number, fadeMs: number): void {
		this.musicGainSets.push({ target, fadeMs });
	}

	streamPublishPlay(url: string, resolvedDirectUrl?: boolean): void {
		const entry: { url: string; resolvedDirectUrl?: boolean } = { url };
		if (resolvedDirectUrl !== undefined) entry.resolvedDirectUrl = resolvedDirectUrl;
		this.streamPublishPlays.push(entry);
	}

	streamPublishPlayVisualizer(url: string, resolvedDirectUrl?: boolean, visualizerMode?: string): void {
		const entry: { url: string; resolvedDirectUrl?: boolean; visualizerMode?: string } = { url };
		if (resolvedDirectUrl !== undefined) entry.resolvedDirectUrl = resolvedDirectUrl;
		if (visualizerMode !== undefined) entry.visualizerMode = visualizerMode;
		this.streamPublishVisualizers.push(entry);
	}

	streamPublishStop(): void {
		this.streamPublishStops += 1;
	}

	streamPublishPause(): void {
		this.streamPublishPauses += 1;
	}

	streamPublishResume(): void {
		this.streamPublishResumes += 1;
	}

	getLastVoiceSessionId(): string | undefined {
		return this.voiceSessionId;
	}

	async destroy(): Promise<void> {
		this.destroyed = true;
	}
}

class FakeVoiceStreamDiscovery implements DiscordStreamDiscovery {
	readonly requestedWatchKeys: string[] = [];
	readonly publishRequests: { guildId: string; channelId: string; preferredRegion?: string | null }[] = [];
	readonly publishStops: string[] = [];
	readonly publishPaused: { streamKey: string; paused: boolean }[] = [];
	stopped = false;

	constructor(private readonly stream: DiscoveredDiscordStream) {}

	stop(): void {
		this.stopped = true;
	}

	listStreams(): DiscoveredDiscordStream[] {
		return [this.stream];
	}

	findStream(target?: string): DiscoveredDiscordStream | undefined {
		const normalizedTarget = target?.trim();
		if (
			normalizedTarget === undefined ||
			normalizedTarget.length === 0 ||
			this.stream.userId === normalizedTarget ||
			this.stream.streamKey === normalizedTarget
		) {
			return this.stream;
		}
		return undefined;
	}

	requestWatch(streamKey: string): void {
		this.requestedWatchKeys.push(streamKey);
	}

	requestPublish(input: { guildId: string; channelId: string; preferredRegion?: string | null }): void {
		this.publishRequests.push(input);
	}

	requestPublishStop(streamKey: string): void {
		this.publishStops.push(streamKey);
	}

	setPublishPaused(streamKey: string, paused: boolean): void {
		this.publishPaused.push({ streamKey, paused });
	}
}

class FakeVoiceMultiStreamDiscovery implements DiscordStreamDiscovery {
	readonly requestedWatchKeys: string[] = [];
	readonly publishRequests: { guildId: string; channelId: string; preferredRegion?: string | null }[] = [];
	readonly publishStops: string[] = [];
	readonly publishPaused: { streamKey: string; paused: boolean }[] = [];
	stopped = false;

	constructor(private readonly streams: DiscoveredDiscordStream[]) {}

	stop(): void {
		this.stopped = true;
	}

	listStreams(): DiscoveredDiscordStream[] {
		return this.streams;
	}

	findStream(
		target?: string,
		scope: { guildId?: string; channelId?: string } = {},
	): DiscoveredDiscordStream | undefined {
		const normalizedTarget = target?.trim();
		const guildId = scope.guildId?.trim();
		const channelId = scope.channelId?.trim();
		return this.streams.find((stream) => {
			if (guildId !== undefined && guildId.length > 0 && stream.guildId !== guildId) return false;
			if (channelId !== undefined && channelId.length > 0 && stream.channelId !== channelId) return false;
			if (normalizedTarget === undefined || normalizedTarget.length === 0) return true;
			return stream.userId === normalizedTarget || stream.streamKey === normalizedTarget;
		});
	}

	requestWatch(streamKey: string): void {
		this.requestedWatchKeys.push(streamKey);
	}

	requestPublish(input: { guildId: string; channelId: string; preferredRegion?: string | null }): void {
		this.publishRequests.push(input);
	}

	requestPublishStop(streamKey: string): void {
		this.publishStops.push(streamKey);
	}

	setPublishPaused(streamKey: string, paused: boolean): void {
		this.publishPaused.push({ streamKey, paused });
	}
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		if (await predicate()) return;
		await sleep(5);
	}
	throw new Error(`voice-smoke: timed out waiting for ${label}`);
}

function expectRecord(value: unknown, name: string): JsonRecord {
	if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as JsonRecord;
	throw new Error(`voice-smoke: expected ${name} to be an object`);
}

function pcm16(samples: number[]): Buffer {
	const buffer = Buffer.alloc(samples.length * 2);
	for (const [index, sample] of samples.entries()) buffer.writeInt16LE(sample, index * 2);
	return buffer;
}

function samplesFromPcm16(pcm: Buffer): number[] {
	const samples: number[] = [];
	for (let offset = 0; offset + 1 < pcm.length; offset += 2) samples.push(pcm.readInt16LE(offset));
	return samples;
}

function silenceConsoleWarn(): () => void {
	const original = console.warn;
	console.warn = () => undefined;
	return () => {
		console.warn = original;
	};
}

main().catch((error: unknown) => {
	console.error("voice-smoke: FAIL");
	console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
	process.exit(1);
});
