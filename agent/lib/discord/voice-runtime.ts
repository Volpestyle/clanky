/**
 * Builds the live voice runtime from the gateway's discord.js client + env
 * (SPEC.md §5.3). A discord.js Guild is structurally the ClankVox voice adapter
 * (it exposes `shard.send` and `voiceAdapterCreator`), so the same Gateway
 * connection that powers text presence also powers voice — no second client.
 * Provider credentials and realtime settings come from env; nothing committed.
 */
import type { Guild } from "discord.js";
import type { VoiceRuntime } from "../../channels/voice.ts";
import type { ClankvoxGuildLike } from "../voice/clankvoxIpcClient.ts";
import type { OpenAiRealtimeConnectOptions } from "../voice/openAiRealtimeClient.ts";

const DEFAULT_VOICE_INSTRUCTIONS = [
	"You are Clanky in a live Discord voice call with one or more people.",
	"Speak naturally and briefly, like a person on a call. You are the same Clanky",
	"as in chat and the terminal: same memory, same character. For anything that",
	"needs real work (web, code, builds, lookups), delegate rather than stalling",
	"the conversation. Stay quiet when nothing needs saying.",
].join(" ");

function toClankvoxGuild(guild: Guild): ClankvoxGuildLike {
	return {
		shard: { send: (payload) => guild.shard.send(payload as never) },
		voiceAdapterCreator: (callbacks) =>
			guild.voiceAdapterCreator(callbacks as never) as ReturnType<
				NonNullable<ClankvoxGuildLike["voiceAdapterCreator"]>
			>,
	};
}

export function buildGuildVoiceRuntime(guild: Guild, env: NodeJS.ProcessEnv): VoiceRuntime {
	const openAiApiKey = env.OPENAI_API_KEY;
	if (openAiApiKey === undefined || openAiApiKey.length === 0) {
		throw new Error("voice requires OPENAI_API_KEY for the realtime agent");
	}
	const connect: OpenAiRealtimeConnectOptions = {
		model: env.CLANKY_VOICE_REALTIME_MODEL ?? "gpt-realtime",
		voice: env.CLANKY_VOICE_REALTIME_VOICE ?? "marin",
		instructions: env.CLANKY_VOICE_INSTRUCTIONS ?? DEFAULT_VOICE_INSTRUCTIONS,
		toolChoice: "auto",
		responseOutputModality: "audio",
		inputAudioFormat: "pcm16",
		outputAudioFormat: "pcm16",
	};
	return { guild: toClankvoxGuild(guild), openAiApiKey, connect };
}
