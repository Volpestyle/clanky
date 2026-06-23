import type { DiscordInboundMessage } from "../discord/acceptance.ts";
import { extractDiscordMemoryCandidates } from "../discord/memory.ts";
import { rememberMemory, type MemoryFact } from "../memory.ts";
import type { OpenAiRealtimeTranscript } from "./openAiRealtimeClient.ts";

export interface VoiceMemorySpeaker {
	userId: string;
	userName?: string;
}

export interface VoiceTranscriptSpeakerContext {
	speaker?: VoiceMemorySpeaker;
	speakerUserIds?: string[];
}

export type VoiceTranscriptSpeakerResolver = (transcript: OpenAiRealtimeTranscript) => VoiceTranscriptSpeakerContext | undefined;

export interface VoiceMemoryContext {
	guildId: string;
	channelId: string;
	speaker?: VoiceMemorySpeaker;
	speakerUserIds?: string[];
	resolveSpeakerContext?: VoiceTranscriptSpeakerResolver;
}

export interface VoiceMemoryStats {
	voiceMemoryCaptureCount: number;
}

export interface VoiceTranscriptSource {
	on(event: "transcript", listener: (transcript: OpenAiRealtimeTranscript) => void): unknown;
	off?(event: "transcript", listener: (transcript: OpenAiRealtimeTranscript) => void): unknown;
}

export interface VoiceTranscriptMemoryBinding {
	dispose(): void;
}

const USER_INPUT_TRANSCRIPT_EVENTS = new Set([
	"conversation.item.input_audio_transcription.completed",
	"input_audio_buffer.transcription.completed",
]);

export function isVoiceInputTranscript(transcript: OpenAiRealtimeTranscript): boolean {
	return USER_INPUT_TRANSCRIPT_EVENTS.has(transcript.eventType);
}

export function extractVoiceMemoryCandidates(transcript: OpenAiRealtimeTranscript, context: VoiceMemoryContext) {
	if (!isVoiceInputTranscript(transcript)) return [];
	if (transcript.text.trim().length === 0) return [];
	const speakerContext = resolveVoiceTranscriptSpeakerContext(transcript, context);
	const message = voiceTranscriptAsDiscordMessage(transcript, context, speakerContext.speaker);
	const candidates = extractDiscordMemoryCandidates(message);
	if (speakerContext.speaker !== undefined) return candidates;
	return candidates.filter((candidate) => candidate.subjectKind === "discord_server");
}

export async function rememberVoiceTranscriptFacts(
	transcript: OpenAiRealtimeTranscript,
	context: VoiceMemoryContext,
): Promise<MemoryFact[]> {
	const candidates = extractVoiceMemoryCandidates(transcript, context);
	const saved: MemoryFact[] = [];
	for (const candidate of candidates) {
		const { confidence: _confidence, ...input } = candidate;
		saved.push(await rememberMemory(input));
	}
	return saved;
}

export function bindVoiceTranscriptMemory(
	realtime: VoiceTranscriptSource,
	context: VoiceMemoryContext,
	stats?: VoiceMemoryStats,
): VoiceTranscriptMemoryBinding {
	const listener = (transcript: OpenAiRealtimeTranscript): void => {
		rememberVoiceTranscriptFacts(transcript, context)
			.then((saved) => {
				if (stats !== undefined) stats.voiceMemoryCaptureCount += saved.length;
			})
			.catch((error: unknown) => console.error("voice memory capture failed:", error));
	};
	realtime.on("transcript", listener);
	return {
		dispose() {
			realtime.off?.("transcript", listener);
		},
	};
}

function voiceTranscriptAsDiscordMessage(
	transcript: OpenAiRealtimeTranscript,
	context: VoiceMemoryContext,
	speaker: VoiceMemorySpeaker | undefined,
): DiscordInboundMessage {
	return {
		externalMessageId: `voice:${transcript.itemId ?? Date.now().toString(36)}`,
		channelId: context.channelId,
		guildId: context.guildId,
		authorId: speaker?.userId ?? `voice:${context.guildId}:${context.channelId}`,
		...(speaker?.userName === undefined ? {} : { authorName: speaker.userName }),
		text: transcript.text,
		kind: "channel",
		mentionsSelf: false,
	};
}

function resolveVoiceTranscriptSpeakerContext(
	transcript: OpenAiRealtimeTranscript,
	context: VoiceMemoryContext,
): VoiceTranscriptSpeakerContext {
	const resolved = context.resolveSpeakerContext?.(transcript);
	if (resolved !== undefined) return normalizedSpeakerContext(resolved);
	return normalizedSpeakerContext({ speaker: context.speaker, speakerUserIds: context.speakerUserIds });
}

function normalizedSpeakerContext(context: VoiceTranscriptSpeakerContext): VoiceTranscriptSpeakerContext {
	const speakerUserIds = uniqueSorted(context.speakerUserIds ?? []);
	if (context.speaker !== undefined) {
		return { speaker: context.speaker, speakerUserIds: speakerUserIds.length === 0 ? [context.speaker.userId] : speakerUserIds };
	}
	return speakerUserIds.length === 0 ? {} : { speakerUserIds };
}

function uniqueSorted(values: readonly string[]): string[] {
	return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))].sort();
}
