/**
 * Builds the live voice runtime from the gateway's discord.js client + env
 * (SPEC.md §5.3). A discord.js Guild is structurally the ClankVox voice adapter
 * (it exposes `shard.send` and `voiceAdapterCreator`), so the same Gateway
 * connection that powers text presence also powers voice — no second client.
 * Provider credentials and realtime settings come from env; nothing committed.
 */
import type { Guild } from "discord.js";
import type { VoiceRuntime } from "../../channels/voice.ts";
import { resolveClankyDataPath } from "../paths.ts";
import type { ClankvoxGuildLike } from "../voice/clankvoxIpcClient.ts";
import {
	parseElevenLabsPcmOutputFormat,
	type ElevenLabsPcmOutputFormat,
} from "../voice/elevenLabsTtsClient.ts";
import type { OpenAiRealtimeConnectOptions, OpenAiRealtimeOutputModality } from "../voice/openAiRealtimeClient.ts";
import type {
	VoiceExternalTtsConfig,
	VoiceRealtimeConfig,
	VoiceRealtimeProvider,
	VoiceSpeakerResolver,
	VoiceTtsProvider,
} from "../voice/supervisor.ts";
import type { VoiceMemorySpeaker } from "../voice/memory.ts";

const DEFAULT_VOICE_INSTRUCTIONS = [
	"You are Clanky in a live Discord voice call with one or more people.",
	"Speak naturally and briefly, like a person on a call. You are the same Clanky",
	"as in chat and the terminal: same memory, same character. For anything that",
	"needs real work (web, code, builds, lookups), delegate rather than stalling",
	"the conversation. Stay quiet when nothing needs saying.",
].join(" ");
const DEFAULT_LOCAL_VOICE_LLM_MODEL = "qwen3.6:27b-mlx";
const DEFAULT_LOCAL_VOICE_LLM_BASE_URL = "http://127.0.0.1:11434/v1";
const DEFAULT_LOCAL_VOICE_ASR_MODEL = "models/voice/whisper/ggml-large-v3-turbo.bin";
const DEFAULT_LOCAL_VOICE = "Samantha";

function toClankvoxGuild(guild: Guild): ClankvoxGuildLike {
	return {
		shard: { send: (payload) => guild.shard.send(payload as never) },
		voiceAdapterCreator: (callbacks) =>
			guild.voiceAdapterCreator(callbacks as never) as ReturnType<
				NonNullable<ClankvoxGuildLike["voiceAdapterCreator"]>
			>,
	};
}

export interface VoiceRuntimeSettings {
	realtime: VoiceRealtimeConfig;
	connect: OpenAiRealtimeConnectOptions;
	externalTts?: VoiceExternalTtsConfig;
	memorySpeaker?: VoiceMemorySpeaker;
	resolveSpeaker?: VoiceSpeakerResolver;
	eveSessionHost?: string;
	memoryContextLimit?: number;
}

export function buildVoiceRuntimeSettings(env: NodeJS.ProcessEnv, memorySpeaker?: VoiceMemorySpeaker): VoiceRuntimeSettings {
	const realtimeProvider = parseRealtimeProvider(env.CLANKY_VOICE_REALTIME_PROVIDER);
	const ttsProvider = parseTtsProvider(env.CLANKY_VOICE_TTS_PROVIDER, env.CLANKY_ELEVENLABS_VOICE_ID?.trim() || env.ELEVENLABS_VOICE_ID);
	const realtime = buildRealtimeConfig(realtimeProvider, env);
	const outputModality: OpenAiRealtimeOutputModality = ttsProvider === "elevenlabs" ? "text" : "audio";
	const connect: OpenAiRealtimeConnectOptions = {
		model: resolveRealtimeModel(realtimeProvider, env),
		voice: env.CLANKY_VOICE_REALTIME_VOICE ?? defaultLocalVoiceValue(realtimeProvider),
		instructions: env.CLANKY_VOICE_INSTRUCTIONS ?? DEFAULT_VOICE_INSTRUCTIONS,
		toolChoice: "auto",
		responseOutputModality: outputModality,
		inputAudioFormat: "pcm16",
		outputAudioFormat: "pcm16",
	};
	const settings: VoiceRuntimeSettings = { realtime, connect };
	if (ttsProvider === "elevenlabs") settings.externalTts = buildElevenLabsConfig(env);
	if (memorySpeaker !== undefined) settings.memorySpeaker = memorySpeaker;
	const eveSessionHost = resolveVoiceEveSessionHost(env);
	if (eveSessionHost !== undefined) settings.eveSessionHost = eveSessionHost;
	const memoryContextLimit = parseMemoryContextLimit(env.CLANKY_VOICE_MEMORY_CONTEXT_LIMIT ?? env.CLANKY_MEMORY_CONTEXT_LIMIT);
	if (memoryContextLimit !== undefined) settings.memoryContextLimit = memoryContextLimit;
	return settings;
}

export function buildGuildVoiceRuntime(guild: Guild, env: NodeJS.ProcessEnv, memorySpeaker?: VoiceMemorySpeaker): VoiceRuntime {
	return {
		guild: toClankvoxGuild(guild),
		...buildVoiceRuntimeSettings(env, memorySpeaker),
		resolveSpeaker: (userId) => resolveGuildVoiceSpeaker(guild, userId, memorySpeaker),
	};
}

function resolveGuildVoiceSpeaker(
	guild: Guild,
	userId: string,
	fallback: VoiceMemorySpeaker | undefined,
): VoiceMemorySpeaker {
	if (fallback?.userId === userId) return fallback;
	const member = guild.members.cache.get(userId);
	const user = guild.client.users.cache.get(userId);
	const userName = member?.displayName ?? user?.globalName ?? user?.username;
	return {
		userId,
		...(userName === undefined ? {} : { userName }),
	};
}

function buildRealtimeConfig(provider: VoiceRealtimeProvider, env: NodeJS.ProcessEnv): VoiceRealtimeConfig {
	if (provider === "local") {
		const config: VoiceRealtimeConfig = {
			provider,
			asrModelPath: env.CLANKY_VOICE_ASR_MODEL?.trim() || resolveClankyDataPath(DEFAULT_LOCAL_VOICE_ASR_MODEL, env),
			llmModel: resolveRealtimeModel(provider, env),
			llmBaseUrl: env.CLANKY_VOICE_LOCAL_BASE_URL?.trim() || env.CLANKY_LOCAL_BASE_URL?.trim() || DEFAULT_LOCAL_VOICE_LLM_BASE_URL,
		};
		const asrCommand = env.CLANKY_VOICE_ASR_COMMAND?.trim();
		if (asrCommand !== undefined && asrCommand.length > 0) config.asrCommand = asrCommand;
		const asrLanguage = env.CLANKY_VOICE_ASR_LANGUAGE?.trim();
		if (asrLanguage !== undefined && asrLanguage.length > 0) config.asrLanguage = asrLanguage;
		const llmApiKey = env.CLANKY_VOICE_LOCAL_API_KEY?.trim();
		if (llmApiKey !== undefined && llmApiKey.length > 0) config.llmApiKey = llmApiKey;
		const audioSampleRate = parsePositiveInteger(env.CLANKY_VOICE_AUDIO_SAMPLE_RATE);
		if (audioSampleRate !== undefined) config.audioSampleRate = audioSampleRate;
		const ttsEngine = parseLocalTtsEngine(env.CLANKY_VOICE_LOCAL_TTS_ENGINE);
		if (ttsEngine !== undefined) config.ttsEngine = ttsEngine;
		const ttsCommand = env.CLANKY_VOICE_LOCAL_TTS_COMMAND?.trim();
		if (ttsCommand !== undefined && ttsCommand.length > 0) config.ttsCommand = ttsCommand;
		const ttsSampleRate = parsePositiveInteger(env.CLANKY_VOICE_TTS_SAMPLE_RATE);
		if (ttsSampleRate !== undefined) config.ttsSampleRate = ttsSampleRate;
		return config;
	}
	if (provider === "xai") {
		const apiKey = env.CLANKY_XAI_API_KEY?.trim() || env.XAI_API_KEY?.trim();
		if (apiKey === undefined || apiKey.length === 0) {
			throw new Error("voice requires CLANKY_XAI_API_KEY or XAI_API_KEY when CLANKY_VOICE_REALTIME_PROVIDER=xai");
		}
		const config: VoiceRealtimeConfig = { provider, apiKey };
		const baseUrl = env.CLANKY_XAI_BASE_URL?.trim() || env.XAI_BASE_URL?.trim();
		if (baseUrl !== undefined && baseUrl.length > 0) config.baseUrl = baseUrl;
		return config;
	}
	const apiKey = env.CLANKY_OPENAI_API_KEY?.trim() || env.OPENAI_API_KEY?.trim();
	if (apiKey === undefined || apiKey.length === 0) {
		throw new Error("voice requires CLANKY_OPENAI_API_KEY or OPENAI_API_KEY for the OpenAI realtime agent");
	}
	const config: VoiceRealtimeConfig = { provider, apiKey };
	const baseUrl = env.CLANKY_OPENAI_BASE_URL?.trim() || env.OPENAI_BASE_URL?.trim();
	if (baseUrl !== undefined && baseUrl.length > 0) config.baseUrl = baseUrl;
	return config;
}

function buildElevenLabsConfig(env: NodeJS.ProcessEnv): VoiceExternalTtsConfig {
	const apiKey = env.CLANKY_ELEVENLABS_API_KEY?.trim() || env.ELEVENLABS_API_KEY?.trim();
	if (apiKey === undefined || apiKey.length === 0) {
		throw new Error("voice requires CLANKY_ELEVENLABS_API_KEY or ELEVENLABS_API_KEY when ElevenLabs TTS is enabled");
	}
	const voiceId = env.CLANKY_ELEVENLABS_VOICE_ID?.trim() || env.ELEVENLABS_VOICE_ID?.trim();
	if (voiceId === undefined || voiceId.length === 0) {
		throw new Error("voice requires CLANKY_ELEVENLABS_VOICE_ID or ELEVENLABS_VOICE_ID when ElevenLabs TTS is enabled");
	}
	const config: VoiceExternalTtsConfig = { provider: "elevenlabs", apiKey, voiceId };
	const modelId = env.CLANKY_ELEVENLABS_TTS_MODEL?.trim() || env.ELEVENLABS_TTS_MODEL?.trim();
	if (modelId !== undefined && modelId.length > 0) config.modelId = modelId;
	const baseUrl = env.CLANKY_ELEVENLABS_BASE_URL?.trim() || env.ELEVENLABS_BASE_URL?.trim();
	if (baseUrl !== undefined && baseUrl.length > 0) config.baseUrl = baseUrl;
	const outputFormat = parseElevenLabsPcmOutputFormat(env.CLANKY_ELEVENLABS_OUTPUT_FORMAT ?? env.ELEVENLABS_OUTPUT_FORMAT);
	if (outputFormat !== undefined) config.outputFormat = outputFormat;
	const speed = parsePositiveNumber(env.CLANKY_ELEVENLABS_SPEED ?? env.ELEVENLABS_SPEED);
	if (speed !== undefined) config.speed = speed;
	return config;
}

function resolveRealtimeModel(provider: VoiceRealtimeProvider, env: NodeJS.ProcessEnv): string {
	if (env.CLANKY_VOICE_REALTIME_MODEL !== undefined && env.CLANKY_VOICE_REALTIME_MODEL.trim().length > 0) {
		return env.CLANKY_VOICE_REALTIME_MODEL.trim();
	}
	if (provider === "local") return DEFAULT_LOCAL_VOICE_LLM_MODEL;
	return provider === "xai" ? "grok-voice-2" : "gpt-realtime";
}

function parseRealtimeProvider(value: string | undefined): VoiceRealtimeProvider {
	const normalized = value?.trim().toLowerCase();
	if (normalized === "local") return "local";
	return normalized === "xai" || normalized === "grok" ? "xai" : "openai";
}

function parseTtsProvider(value: string | undefined, elevenLabsVoiceId: string | undefined): VoiceTtsProvider {
	const normalized = value?.trim().toLowerCase();
	if (normalized === "elevenlabs" || normalized === "11labs") return "elevenlabs";
	if (normalized === "realtime" || normalized === "native") return "realtime";
	return elevenLabsVoiceId?.trim() ? "elevenlabs" : "realtime";
}

function parsePositiveNumber(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number.parseFloat(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parsePositiveInteger(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseLocalTtsEngine(value: string | undefined): "say" | "command" | undefined {
	const normalized = value?.trim().toLowerCase();
	if (normalized === "say" || normalized === "macos") return "say";
	if (normalized === "command" || normalized === "cmd") return "command";
	return undefined;
}

function parseMemoryContextLimit(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed)) return undefined;
	return Math.max(0, Math.min(50, parsed));
}

export function defaultLocalVoiceValue(provider: VoiceRealtimeProvider): string {
	return provider === "local" ? DEFAULT_LOCAL_VOICE : "marin";
}

function resolveVoiceEveSessionHost(env: NodeJS.ProcessEnv): string | undefined {
	const enabled = env.CLANKY_VOICE_EVE_SESSION?.trim().toLowerCase();
	if (enabled === "0" || enabled === "false" || enabled === "off" || enabled === "no") return undefined;
	return env.CLANKY_EVE_HOST?.trim() || "http://127.0.0.1:2000";
}
