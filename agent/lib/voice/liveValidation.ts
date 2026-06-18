import { isRecord, stringValue } from "./json.ts";

export interface VoiceLiveValidationRequirements {
	inputAudio: boolean;
	groupAudio: boolean;
	realtimeSession: boolean;
	outputAudio: boolean;
	toolCall: boolean;
	askPi: boolean;
	streamWatch: boolean;
	screenFrame: boolean;
	failOnRealtimeError: boolean;
}

export interface VoiceLiveValidationCheck {
	id: string;
	passed: boolean;
	observed: number;
	expected: string;
	failure: string;
}

export function parseVoiceLiveValidationRequirements(
	env: NodeJS.ProcessEnv = process.env,
): VoiceLiveValidationRequirements {
	const all = parseEnabled(env.CLANKY_DISCORD_VOICE_REQUIRE_ALL);
	return {
		inputAudio: all || parseEnabled(env.CLANKY_DISCORD_VOICE_REQUIRE_INPUT_AUDIO),
		groupAudio: all || parseEnabled(env.CLANKY_DISCORD_VOICE_REQUIRE_GROUP_AUDIO),
		realtimeSession: all || parseEnabled(env.CLANKY_DISCORD_VOICE_REQUIRE_REALTIME_SESSION),
		outputAudio: all || parseEnabled(env.CLANKY_DISCORD_VOICE_REQUIRE_OUTPUT_AUDIO),
		toolCall: all || parseEnabled(env.CLANKY_DISCORD_VOICE_REQUIRE_TOOL_CALL),
		askPi: all || parseEnabled(env.CLANKY_DISCORD_VOICE_REQUIRE_ASK_PI),
		streamWatch: all || parseEnabled(env.CLANKY_DISCORD_VOICE_REQUIRE_STREAM_WATCH),
		screenFrame: all || parseEnabled(env.CLANKY_DISCORD_VOICE_REQUIRE_SCREEN_FRAME),
		failOnRealtimeError: parseEnabled(env.CLANKY_DISCORD_VOICE_FAIL_ON_REALTIME_ERROR),
	};
}

export function validateVoiceLiveStatus(status: unknown, requirements: VoiceLiveValidationRequirements): string[] {
	return evaluateVoiceLiveStatus(status, requirements)
		.filter((check) => !check.passed)
		.map((check) => check.failure);
}

export function evaluateVoiceLiveStatus(
	status: unknown,
	requirements: VoiceLiveValidationRequirements,
): VoiceLiveValidationCheck[] {
	const voice = isRecord(status) && isRecord(status.voice) ? status.voice : {};
	const stats = isRecord(voice.stats) ? voice.stats : {};
	const checks: VoiceLiveValidationCheck[] = [];
	if (requirements.inputAudio) {
		checks.push(
			minimumCheck(
				"discord_input_audio",
				numberValue(stats.discordInputAudioEventCount),
				1,
				"expected Discord input audio events",
			),
		);
	}
	if (requirements.groupAudio) {
		checks.push(
			minimumCheck(
				"discord_group_audio",
				numberValue(stats.discordInputMaxConcurrentSpeakers),
				2,
				"expected overlapping Discord input from at least two speakers",
			),
		);
	}
	if (requirements.realtimeSession) {
		checks.push(
			minimumCheck(
				"openai_realtime_session_updated",
				numberValue(stats.realtimeSessionUpdatedCount),
				1,
				"expected OpenAI Realtime session.updated after session.update",
			),
		);
	}
	if (requirements.outputAudio) {
		const externalTts = stringValue(voice.ttsProvider) === "elevenlabs";
		checks.push(
			minimumCheck(
				externalTts ? "elevenlabs_tts_output_audio" : "openai_realtime_output_audio",
				externalTts ? numberValue(stats.externalTtsRequestCount) : numberValue(stats.realtimeAudioDeltaCount),
				1,
				externalTts ? "expected ElevenLabs TTS output audio" : "expected OpenAI Realtime output audio deltas",
			),
			minimumCheck(
				"discord_output_audio",
				numberValue(stats.discordOutputAudioSendCount),
				1,
				"expected voice output audio to be sent to Discord",
			),
		);
	}
	if (requirements.toolCall) {
		checks.push(
			minimumCheck(
				"openai_realtime_function_call",
				numberValue(stats.realtimeFunctionCallCount),
				1,
				"expected at least one Realtime function call",
			),
		);
	}
	if (requirements.askPi) {
		checks.push(minimumCheck("ask_pi", numberValue(stats.askPiCallCount), 1, "expected at least one ask_pi call"));
	}
	if (requirements.streamWatch) {
		checks.push(
			minimumCheck(
				"discord_stream_watch",
				numberValue(stats.streamWatchConnectCount),
				1,
				"expected Discord stream_watch connection",
			),
		);
	}
	if (requirements.screenFrame) {
		checks.push(
			minimumCheck(
				"discord_screen_frame",
				numberValue(stats.decodedVideoFrameCount),
				1,
				"expected decoded Discord screen-share frames",
			),
		);
	}
	if (requirements.failOnRealtimeError) {
		const realtimeErrors =
			numberValue(stats.realtimeErrorEventCount) +
			numberValue(stats.realtimeSocketErrorCount) +
			numberValue(stats.realtimeSocketCloseCount);
		checks.push({
			id: "openai_realtime_errors",
			passed: realtimeErrors === 0,
			observed: realtimeErrors,
			expected: "= 0",
			failure: "expected no OpenAI Realtime API/socket errors",
		});
	}
	return checks;
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
		requirements.realtimeSession ||
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
		requirements.realtimeSession ||
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
	if (requirements.realtimeSession) {
		lines.push("Wait for OpenAI Realtime to acknowledge the session.update configuration.");
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

function numberValue(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function minimumCheck(id: string, observed: number, minimum: number, failure: string): VoiceLiveValidationCheck {
	return {
		id,
		passed: observed >= minimum,
		observed,
		expected: `>= ${minimum}`,
		failure,
	};
}
