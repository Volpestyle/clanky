import type { AdapterContext } from "../adapter.ts";

export interface TelegramAudio {
	mime: string;
	data: Buffer;
}

export async function transcribeTelegramVoice(
	context: AdapterContext,
	audio: TelegramAudio,
	options: { fallbackText?: string } = {},
): Promise<string> {
	if (context.transcribeAudio === undefined) {
		return options.fallbackText ?? "[voice message: no transcriber configured]";
	}
	try {
		const text = await context.transcribeAudio(audio.mime, audio.data);
		const trimmed = text.trim();
		if (trimmed.length === 0) return options.fallbackText ?? "[voice message: empty transcription]";
		return trimmed;
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return options.fallbackText ?? `[voice transcription failed: ${reason}]`;
	}
}
