import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { buildVoiceRuntimeSettings } from "../agent/lib/discord/voice-runtime.ts";
import { rememberMemory } from "../agent/lib/memory.ts";
import { DiscordVoiceTurnBuffer } from "../agent/lib/voice/discordVoiceTurnBuffer.ts";
import {
	bindVoiceEveSession,
	formatVoiceEvePrompt,
	formatVoiceEveStartPrompt,
} from "../agent/lib/voice/eve-session.ts";
import { bindExternalTtsOutput } from "../agent/lib/voice/externalTtsBridge.ts";
import type { ElevenLabsTtsAudioChunk } from "../agent/lib/voice/elevenLabsTtsClient.ts";
import { extractVoiceMemoryCandidates, isVoiceInputTranscript } from "../agent/lib/voice/memory.ts";
import { buildRealtimeSessionUpdateEvent, type OpenAiRealtimeTranscript } from "../agent/lib/voice/openAiRealtimeClient.ts";
import { buildVoiceConnectOptions, summarizeVoiceRuntimeConfig } from "../agent/lib/voice/supervisor.ts";

let failures = 0;

function check(label: string, ok: boolean): void {
	console.log(`${ok ? "ok  " : "FAIL"}  ${label}`);
	if (!ok) failures += 1;
}

function env(input: Record<string, string>): NodeJS.ProcessEnv {
	return input as NodeJS.ProcessEnv;
}

function throws(label: string, fn: () => void, expected: string): void {
	try {
		fn();
		check(label, false);
	} catch (error) {
		check(label, error instanceof Error && error.message.includes(expected));
	}
}

const openai = buildVoiceRuntimeSettings(env({ OPENAI_API_KEY: "openai-key" }));
check("OpenAI realtime is the default provider", openai.realtime.provider === "openai");
check("OpenAI realtime defaults to native audio TTS", openai.externalTts === undefined);
check("OpenAI realtime default model is gpt-realtime", openai.connect.model === "gpt-realtime");
check("native TTS requests realtime audio output", openai.connect.responseOutputModality === "audio");
check("voice eve session is enabled by default", openai.eveSessionHost === "http://127.0.0.1:2000");

const openaiWithStaleLocalModel = buildVoiceRuntimeSettings(
	env({ OPENAI_API_KEY: "openai-key", CLANKY_VOICE_REALTIME_MODEL: "qwen3.6:27b-mlx" }),
);
check("OpenAI realtime ignores stale local model overrides", openaiWithStaleLocalModel.connect.model === "gpt-realtime");

const openaiWithHostedOverride = buildVoiceRuntimeSettings(
	env({ OPENAI_API_KEY: "openai-key", CLANKY_VOICE_REALTIME_MODEL: "gpt-4o-realtime-preview" }),
);
check("OpenAI realtime preserves hosted model overrides", openaiWithHostedOverride.connect.model === "gpt-4o-realtime-preview");

const localVoice = buildVoiceRuntimeSettings(
	env({
		CLANKY_VOICE_REALTIME_PROVIDER: "local",
		CLANKY_VOICE_ASR_MODEL: "/tmp/ggml-large-v3-turbo.bin",
		CLANKY_VOICE_LOCAL_BASE_URL: "http://127.0.0.1:11434/v1",
	}),
);
check("local realtime provider is selectable", localVoice.realtime.provider === "local");
check("local voice default model is qwen3.6:27b-mlx", localVoice.connect.model === "qwen3.6:27b-mlx");
check("local voice default TTS voice is Samantha", localVoice.connect.voice === "Samantha");
check("local voice uses native realtime audio output", localVoice.connect.responseOutputModality === "audio");
check("local voice preserves ASR model path", localVoice.realtime.provider === "local" && localVoice.realtime.asrModelPath === "/tmp/ggml-large-v3-turbo.bin");
check("local voice preserves local LLM endpoint", localVoice.realtime.provider === "local" && localVoice.realtime.llmBaseUrl === "http://127.0.0.1:11434/v1");

const voiceWithSpeaker = buildVoiceRuntimeSettings(env({ OPENAI_API_KEY: "openai-key" }), {
	userId: "u-voice",
	userName: "Morgan",
});
check("voice runtime preserves memory speaker id", voiceWithSpeaker.memorySpeaker?.userId === "u-voice");
const noVoiceEveSession = buildVoiceRuntimeSettings(env({ OPENAI_API_KEY: "openai-key", CLANKY_VOICE_EVE_SESSION: "off" }));
check("voice eve session can be disabled", noVoiceEveSession.eveSessionHost === undefined);

const xaiElevenLabs = buildVoiceRuntimeSettings(
	env({
		CLANKY_VOICE_REALTIME_PROVIDER: "xai",
		XAI_API_KEY: "xai-key",
		CLANKY_ELEVENLABS_API_KEY: "eleven-key",
		CLANKY_ELEVENLABS_VOICE_ID: "voice-id",
		CLANKY_ELEVENLABS_OUTPUT_FORMAT: "pcm_16000",
		CLANKY_ELEVENLABS_SPEED: "1.2",
	}),
);
check("xAI realtime provider is selectable", xaiElevenLabs.realtime.provider === "xai");
check("xAI realtime default model is grok-voice-2", xaiElevenLabs.connect.model === "grok-voice-2");
check("ElevenLabs is inferred from configured voice id", xaiElevenLabs.externalTts?.provider === "elevenlabs");
check("ElevenLabs voice id is preserved", xaiElevenLabs.externalTts?.voiceId === "voice-id");
check("ElevenLabs output format is parsed", xaiElevenLabs.externalTts?.outputFormat === "pcm_16000");
check("external TTS requests realtime text output", xaiElevenLabs.connect.responseOutputModality === "text");
const xaiVoiceSummary = summarizeVoiceRuntimeConfig(xaiElevenLabs);
check("voice status summary includes realtime provider", xaiVoiceSummary.realtimeProvider === "xai");
check("voice status summary includes realtime model", xaiVoiceSummary.realtimeModel === "grok-voice-2");
check("voice status summary includes response output modality", xaiVoiceSummary.responseOutputModality === "text");
check("voice status summary includes tts provider", xaiVoiceSummary.ttsProvider === "elevenlabs");
check("voice status summary includes ElevenLabs voice id", xaiVoiceSummary.elevenLabs?.voiceId === "voice-id");
check("voice status summary includes ElevenLabs output format", xaiVoiceSummary.elevenLabs?.outputFormat === "pcm_16000");
check("voice status summary includes Eve session state", xaiVoiceSummary.eveSessionEnabled);
check("voice status summary reports memory context enabled", xaiVoiceSummary.memoryContextEnabled);
check("voice status summary reports default memory context limit", xaiVoiceSummary.memoryContextLimit === 16);

const xaiWithStaleLocalModel = buildVoiceRuntimeSettings(
	env({ CLANKY_VOICE_REALTIME_PROVIDER: "xai", XAI_API_KEY: "xai-key", CLANKY_VOICE_REALTIME_MODEL: "qwen3.6:27b-mlx" }),
);
check("xAI realtime ignores stale local model overrides", xaiWithStaleLocalModel.connect.model === "grok-voice-2");

const previousHome = process.env.CLANKY_HOME;
const voiceMemoryHome = await mkdtemp(join(tmpdir(), "clanky-voice-memory-"));
process.env.CLANKY_HOME = voiceMemoryHome;
try {
	await rememberMemory({
		subjectKind: "discord_user",
		subjectId: "u-voice",
		subjectName: "Morgan",
		fact: "Morgan likes callback jokes.",
		tags: ["preference"],
		importance: 4,
	});
	await rememberMemory({
		subjectKind: "discord_server",
		subjectId: "g-voice",
		fact: "This Discord server uses voice for standups.",
		tags: ["voice"],
		importance: 4,
	});
	await rememberMemory({
		subjectKind: "main_user",
		fact: "The main user likes private face settings.",
		tags: ["preference"],
		importance: 4,
	});
	const voiceConnectWithMemory = await buildVoiceConnectOptions({
		guildId: "g-voice",
		channelId: "vc1",
		guild: {},
		realtime: { provider: "openai", apiKey: "openai-key" },
		connect: openai.connect,
		memorySpeaker: { userId: "u-voice", userName: "Morgan" },
	});
	check("voice realtime instructions include speaker memory", voiceConnectWithMemory.instructions.includes("Morgan likes callback jokes."));
	check("voice realtime instructions include server memory", voiceConnectWithMemory.instructions.includes("uses voice for standups"));
	check("voice realtime instructions exclude main-user memory in Discord voice", !voiceConnectWithMemory.instructions.includes("private face settings"));
	const voiceConnectWithoutMemory = await buildVoiceConnectOptions({
		guildId: "g-voice",
		channelId: "vc1",
		guild: {},
		realtime: { provider: "openai", apiKey: "openai-key" },
		connect: openai.connect,
		memorySpeaker: { userId: "u-voice", userName: "Morgan" },
		memoryContextLimit: 0,
	});
	check("voice memory context limit zero keeps base instructions", voiceConnectWithoutMemory.instructions === openai.connect.instructions);
} finally {
	if (previousHome === undefined) delete process.env.CLANKY_HOME;
	else process.env.CLANKY_HOME = previousHome;
	await rm(voiceMemoryHome, { recursive: true, force: true });
}

const sessionUpdate = buildRealtimeSessionUpdateEvent(xaiElevenLabs.connect);
const session = sessionUpdate.session;
const sessionRecord =
	typeof session === "object" && session !== null && !Array.isArray(session) ? (session as Record<string, unknown>) : {};
const audio = sessionRecord.audio;
const hasRealtimeOutputAudio =
	typeof audio === "object" && audio !== null && !Array.isArray(audio) && Object.hasOwn(audio, "output");
check("text-output realtime session omits native output audio config", !hasRealtimeOutputAudio);

throws(
	"xAI provider requires xAI API key",
	() => buildVoiceRuntimeSettings(env({ CLANKY_VOICE_REALTIME_PROVIDER: "xai" })),
	"CLANKY_XAI_API_KEY or XAI_API_KEY",
);
throws(
	"ElevenLabs TTS requires API key",
	() => buildVoiceRuntimeSettings(env({ OPENAI_API_KEY: "openai-key", CLANKY_ELEVENLABS_VOICE_ID: "voice-id" })),
	"CLANKY_ELEVENLABS_API_KEY or ELEVENLABS_API_KEY",
);

const transcriptListeners: ((transcript: OpenAiRealtimeTranscript) => void)[] = [];
const realtime = {
	on(event: "transcript", listener: (transcript: OpenAiRealtimeTranscript) => void): void {
		if (event === "transcript") transcriptListeners.push(listener);
	},
	off(event: "transcript", listener: (transcript: OpenAiRealtimeTranscript) => void): void {
		if (event !== "transcript") return;
		const index = transcriptListeners.indexOf(listener);
		if (index >= 0) transcriptListeners.splice(index, 1);
	},
};
const synthesized: string[] = [];
const played: ElevenLabsTtsAudioChunk[] = [];
let stopped = false;
const stats = { externalTtsRequestCount: 0, discordOutputAudioSendCount: 0 };
const binding = bindExternalTtsOutput({
	realtime,
	tts: {
		async synthesize(
			text: string,
			onAudio: (chunk: ElevenLabsTtsAudioChunk) => Promise<void> | void,
		): Promise<void> {
			synthesized.push(text);
			await onAudio({ pcmBase64: Buffer.from(text).toString("base64"), sampleRate: 24_000 });
		},
	},
	playAudio(chunk) {
		played.push(chunk);
	},
	stopPlayback() {
		stopped = true;
	},
	stats,
});

for (const listener of transcriptListeners) {
	listener({ eventType: "response.output_text.delta", text: "hello " });
	listener({ eventType: "response.output_text.delta", text: "world" });
	listener({ eventType: "response.output_text.done", text: "" });
}
await setImmediate();
await setImmediate();
check("external TTS synthesizes completed text transcript", synthesized[0] === "hello world");
check("external TTS sends PCM to playback", played[0]?.sampleRate === 24_000);
check("external TTS request count is tracked", stats.externalTtsRequestCount === 1);
check("Discord output audio count is tracked", stats.discordOutputAudioSendCount === 1);
binding.dispose();
check("external TTS dispose stops playback", stopped);

const inputTranscript: OpenAiRealtimeTranscript = {
	eventType: "conversation.item.input_audio_transcription.completed",
	text: "clanky please remember I like noodles",
	itemId: "voice-item-1",
};
check("voice memory recognizes completed input transcript", isVoiceInputTranscript(inputTranscript));
const flushedSpeakers: string[][] = [];
const turnBuffer = new DiscordVoiceTurnBuffer({
	subscribeUser() {},
	appendInputAudio() {},
	commitInputAudioBuffer() {},
	createAudioResponse() {},
	onFlushSpeakers(userIds) {
		flushedSpeakers.push(userIds);
	},
});
turnBuffer.speakingStart("u-dynamic");
turnBuffer.userAudio("u-dynamic", Buffer.from([0, 0, 1, 0]));
check("voice turn buffer exposes pending audio speaker ids", turnBuffer.status().pendingAudioSpeakers[0] === "u-dynamic");
turnBuffer.speakingEnd("u-dynamic");
turnBuffer.flushNow();
check("voice turn buffer reports committed turn speakers", flushedSpeakers[0]?.[0] === "u-dynamic");
const voiceMemory = extractVoiceMemoryCandidates(inputTranscript, {
	guildId: "g1",
	channelId: "vc1",
	speaker: { userId: "u1", userName: "Nina" },
});
check("voice transcript captures speaker preference", voiceMemory[0]?.fact === "Nina likes noodles.");
check("voice transcript stores speaker user id", voiceMemory[0]?.subjectId === "u1");
const dynamicallyAttributedMemory = extractVoiceMemoryCandidates(inputTranscript, {
	guildId: "g1",
	channelId: "vc1",
	resolveSpeakerContext: () => ({ speaker: { userId: "u-dynamic", userName: "Ari" }, speakerUserIds: ["u-dynamic"] }),
});
check("voice memory uses dynamic single-speaker attribution", dynamicallyAttributedMemory[0]?.fact === "Ari likes noodles.");
check("voice memory stores dynamic speaker id", dynamicallyAttributedMemory[0]?.subjectId === "u-dynamic");
const mixedSpeakerMemory = extractVoiceMemoryCandidates(inputTranscript, {
	guildId: "g1",
	channelId: "vc1",
	resolveSpeakerContext: () => ({ speakerUserIds: ["u1", "u2"] }),
});
check("voice memory skips user facts for mixed-speaker turns", mixedSpeakerMemory.length === 0);
const assistantTranscript: OpenAiRealtimeTranscript = {
	eventType: "response.output_text.done",
	text: "remember I like noodles",
};
check("voice memory ignores assistant transcripts", extractVoiceMemoryCandidates(assistantTranscript, { guildId: "g1", channelId: "vc1" }).length === 0);
const serverTranscript: OpenAiRealtimeTranscript = {
	eventType: "conversation.item.input_audio_transcription.completed",
	text: "remember this server ships on Fridays",
};
const serverVoiceMemory = extractVoiceMemoryCandidates(serverTranscript, { guildId: "g1", channelId: "vc1" });
check("voice memory captures server facts without speaker", serverVoiceMemory[0]?.subjectKind === "discord_server");
check("voice memory skips user facts without speaker", extractVoiceMemoryCandidates(inputTranscript, { guildId: "g1", channelId: "vc1" }).length === 0);
const mixedServerVoiceMemory = extractVoiceMemoryCandidates(serverTranscript, {
	guildId: "g1",
	channelId: "vc1",
	resolveSpeakerContext: () => ({ speakerUserIds: ["u1", "u2"] }),
});
check("voice memory preserves server facts for mixed-speaker turns", mixedServerVoiceMemory[0]?.subjectKind === "discord_server");

const formattedVoicePrompt = formatVoiceEvePrompt(inputTranscript, {
	host: "http://127.0.0.1:2000",
	guildId: "g1",
	channelId: "vc1",
	speaker: { userId: "u1", userName: "Nina" },
});
check("voice eve prompt includes guild id", formattedVoicePrompt.includes("- guildId: g1"));
check("voice eve prompt includes speaker", formattedVoicePrompt.includes("- speakerName: Nina"));
check("voice eve prompt includes transcript", formattedVoicePrompt.includes("clanky please remember I like noodles"));
const mixedSpeakerPrompt = formatVoiceEvePrompt(inputTranscript, {
	host: "http://127.0.0.1:2000",
	guildId: "g1",
	channelId: "vc1",
	resolveSpeakerContext: () => ({ speakerUserIds: ["u2", "u1"] }),
});
check("voice eve prompt marks mixed speakers", mixedSpeakerPrompt.includes("- speaker: multiple-or-unknown"));
check("voice eve prompt includes mixed speaker ids", mixedSpeakerPrompt.includes("- speakerUserIds: u1, u2"));

{
	const startPrompt = formatVoiceEveStartPrompt({
		host: "http://127.0.0.1:2000",
		guildId: "g1",
		channelId: "vc1",
		speaker: { userId: "u1", userName: "Nina" },
	});
	check("voice eve start prompt marks the call start", startPrompt.includes("Discord voice conversation started:"));
	const bootstrapSent: string[] = [];
	const bootstrapSessions: string[] = [];
	const bootstrapStats = { voiceEveSessionSendCount: 0, voiceEveSessionErrorCount: 0 };
	bindVoiceEveSession({
		realtime: {
			on() {},
		},
		config: {
			host: "http://127.0.0.1:2000",
			guildId: "g1",
			channelId: "vc1",
			speaker: { userId: "u1", userName: "Nina" },
		},
		stats: bootstrapStats,
		initialPrompt: startPrompt,
		createSession() {
			return {
				async send(message: string) {
					bootstrapSent.push(message);
					return { result: async () => ({ sessionId: "voice-session-bootstrap", message: "[SKIP]" }) };
				},
			};
		},
		onSessionId(sessionId) {
			bootstrapSessions.push(sessionId);
		},
	});
	await setImmediate();
	await setImmediate();
	check("voice eve bootstrap creates the durability session immediately", bootstrapSent.length === 1);
	check("voice eve bootstrap reports the session id", bootstrapSessions[0] === "voice-session-bootstrap");
	check("voice eve bootstrap tracks the durability turn", bootstrapStats.voiceEveSessionSendCount === 1);
}

const eveTranscriptListeners: ((transcript: OpenAiRealtimeTranscript) => void)[] = [];
const eveRealtime = {
	on(event: "transcript", listener: (transcript: OpenAiRealtimeTranscript) => void): void {
		if (event === "transcript") eveTranscriptListeners.push(listener);
	},
	off(event: "transcript", listener: (transcript: OpenAiRealtimeTranscript) => void): void {
		if (event !== "transcript") return;
		const index = eveTranscriptListeners.indexOf(listener);
		if (index >= 0) eveTranscriptListeners.splice(index, 1);
	},
};
const eveSent: string[] = [];
const eveStats = { voiceEveSessionSendCount: 0, voiceEveSessionErrorCount: 0, voiceEveSessionSpokenResponseCount: 0 };
const spokenVoiceFollowUps: string[] = [];
const eveBinding = bindVoiceEveSession({
	realtime: eveRealtime,
	config: {
		host: "http://127.0.0.1:2000",
		guildId: "g1",
		channelId: "vc1",
		speaker: { userId: "u1", userName: "Nina" },
	},
	stats: eveStats,
	createSession() {
		return {
			async send(message: string) {
				eveSent.push(message);
				return { result: async () => ({ sessionId: "voice-session", message: "[SKIP]" }) };
			},
		};
	},
	speakResponse(message) {
		spokenVoiceFollowUps.push(message);
	},
});
for (const listener of eveTranscriptListeners) {
	listener(inputTranscript);
	listener(assistantTranscript);
}
await setImmediate();
await setImmediate();
check("voice eve bridge sends completed input transcript", eveSent.length === 1);
check("voice eve bridge tracks sent turns", eveStats.voiceEveSessionSendCount === 1);
check("voice eve bridge does not speak skip response", spokenVoiceFollowUps.length === 0);
eveBinding.dispose();
for (const listener of eveTranscriptListeners) listener(inputTranscript);
await setImmediate();
check("voice eve bridge dispose removes listener", eveSent.length === 1);

const voiceFollowUpListeners: ((transcript: OpenAiRealtimeTranscript) => void)[] = [];
const voiceFollowUpRealtime = {
	on(event: "transcript", listener: (transcript: OpenAiRealtimeTranscript) => void): void {
		if (event === "transcript") voiceFollowUpListeners.push(listener);
	},
};
const followUpStats = { voiceEveSessionSendCount: 0, voiceEveSessionErrorCount: 0, voiceEveSessionSpokenResponseCount: 0 };
const followUpSpeech: string[] = [];
bindVoiceEveSession({
	realtime: voiceFollowUpRealtime,
	config: {
		host: "http://127.0.0.1:2000",
		guildId: "g1",
		channelId: "vc1",
		speaker: { userId: "u1", userName: "Nina" },
	},
	stats: followUpStats,
	createSession() {
		return {
			async send() {
				return { result: async () => ({ sessionId: "voice-session", message: "I started a worker for that." }) };
			},
		};
	},
	speakResponse(message) {
		followUpSpeech.push(message);
	},
});
for (const listener of voiceFollowUpListeners) listener(inputTranscript);
await setImmediate();
await setImmediate();
check("voice eve bridge speaks non-skip follow-up", followUpSpeech[0] === "I started a worker for that.");
check("voice eve bridge tracks spoken follow-up", followUpStats.voiceEveSessionSpokenResponseCount === 1);

console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
