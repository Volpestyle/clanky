type JsonRecord = Record<string, unknown>;

export interface VoiceLiveValidationRequirements {
	inputAudio: boolean;
	groupAudio: boolean;
	outputAudio: boolean;
	toolCall: boolean;
	askPi: boolean;
	streamWatch: boolean;
	screenFrame: boolean;
	failOnRealtimeError: boolean;
}

export function parseVoiceLiveValidationRequirements(
	env: NodeJS.ProcessEnv = process.env,
): VoiceLiveValidationRequirements {
	const all = parseEnabled(env.CLANKY_DISCORD_VOICE_REQUIRE_ALL);
	return {
		inputAudio: all || parseEnabled(env.CLANKY_DISCORD_VOICE_REQUIRE_INPUT_AUDIO),
		groupAudio: all || parseEnabled(env.CLANKY_DISCORD_VOICE_REQUIRE_GROUP_AUDIO),
		outputAudio: all || parseEnabled(env.CLANKY_DISCORD_VOICE_REQUIRE_OUTPUT_AUDIO),
		toolCall: all || parseEnabled(env.CLANKY_DISCORD_VOICE_REQUIRE_TOOL_CALL),
		askPi: all || parseEnabled(env.CLANKY_DISCORD_VOICE_REQUIRE_ASK_PI),
		streamWatch: all || parseEnabled(env.CLANKY_DISCORD_VOICE_REQUIRE_STREAM_WATCH),
		screenFrame: all || parseEnabled(env.CLANKY_DISCORD_VOICE_REQUIRE_SCREEN_FRAME),
		failOnRealtimeError: parseEnabled(env.CLANKY_DISCORD_VOICE_FAIL_ON_REALTIME_ERROR),
	};
}

export function validateVoiceLiveStatus(status: unknown, requirements: VoiceLiveValidationRequirements): string[] {
	const voice = isRecord(status) && isRecord(status.voice) ? status.voice : {};
	const stats = isRecord(voice.stats) ? voice.stats : {};
	const failures: string[] = [];
	if (requirements.inputAudio && numberValue(stats.discordInputAudioEventCount) <= 0) {
		failures.push("expected Discord input audio events");
	}
	if (requirements.groupAudio && numberValue(stats.discordInputMaxConcurrentSpeakers) <= 1) {
		failures.push("expected overlapping Discord input from at least two speakers");
	}
	if (requirements.outputAudio && numberValue(stats.realtimeAudioDeltaCount) <= 0) {
		failures.push("expected OpenAI Realtime output audio deltas");
	}
	if (requirements.toolCall && numberValue(stats.realtimeFunctionCallCount) <= 0) {
		failures.push("expected at least one Realtime function call");
	}
	if (requirements.askPi && numberValue(stats.askPiCallCount) <= 0) {
		failures.push("expected at least one ask_pi call");
	}
	if (requirements.streamWatch && numberValue(stats.streamWatchConnectCount) <= 0) {
		failures.push("expected Discord stream_watch connection");
	}
	if (requirements.screenFrame && numberValue(stats.decodedVideoFrameCount) <= 0) {
		failures.push("expected decoded Discord screen-share frames");
	}
	if (requirements.failOnRealtimeError) {
		const realtimeErrors =
			numberValue(stats.realtimeErrorEventCount) +
			numberValue(stats.realtimeSocketErrorCount) +
			numberValue(stats.realtimeSocketCloseCount);
		if (realtimeErrors > 0) failures.push("expected no OpenAI Realtime API/socket errors");
	}
	return failures;
}

export function isVoiceLiveValidationSatisfied(
	status: unknown,
	requirements: VoiceLiveValidationRequirements,
): boolean {
	return validateVoiceLiveStatus(status, requirements).length === 0;
}

export function hasVoiceLiveValidationRequirements(requirements: VoiceLiveValidationRequirements): boolean {
	return (
		requirements.inputAudio ||
		requirements.groupAudio ||
		requirements.outputAudio ||
		requirements.toolCall ||
		requirements.askPi ||
		requirements.streamWatch ||
		requirements.screenFrame ||
		requirements.failOnRealtimeError
	);
}

export function hasVoiceLiveSuccessRequirements(requirements: VoiceLiveValidationRequirements): boolean {
	return (
		requirements.inputAudio ||
		requirements.groupAudio ||
		requirements.outputAudio ||
		requirements.toolCall ||
		requirements.askPi ||
		requirements.streamWatch ||
		requirements.screenFrame
	);
}

export function requiresNativeDiscordScreenWatch(requirements: VoiceLiveValidationRequirements): boolean {
	return requirements.streamWatch || requirements.screenFrame;
}

export function describeVoiceLiveValidationRequirements(requirements: VoiceLiveValidationRequirements): string[] {
	const lines: string[] = [];
	if (requirements.inputAudio) {
		lines.push("Speak in the configured Discord voice channel so Discord input audio is captured.");
	}
	if (requirements.groupAudio) {
		lines.push("Have at least two Discord voice participants overlap briefly so group audio is observed.");
	}
	if (requirements.outputAudio) {
		lines.push("Prompt Clanky verbally and wait for spoken Realtime audio output.");
	}
	if (requirements.toolCall) {
		lines.push("Ask for any tool-backed action so Realtime emits a function call.");
	}
	if (requirements.askPi) {
		lines.push("Ask Clanky to delegate a durable/task-style request to Pi, exercising ask_pi.");
	}
	if (requirements.streamWatch) {
		lines.push("Use a user-token Discord credential, start a Go Live stream, and ask Clanky to watch it.");
	}
	if (requirements.screenFrame) {
		lines.push("Use a user-token Discord credential and keep Go Live visible for at least one decoded screen frame.");
	}
	if (requirements.failOnRealtimeError) {
		lines.push("Fail the live run if OpenAI Realtime emits API errors or the Realtime socket errors/closes.");
	}
	return lines;
}

function parseEnabled(value: string | undefined): boolean {
	const normalized = value?.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function isRecord(value: unknown): value is JsonRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function numberValue(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
