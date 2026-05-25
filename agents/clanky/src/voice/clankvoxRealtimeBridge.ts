import type { ClankvoxDecodedVideoFrame } from "./clankvoxIpcClient.ts";
import { DiscordVoiceTurnBuffer, type DiscordVoiceTurnBufferOptions } from "./discordVoiceTurnBuffer.ts";
import type { OpenAiRealtimeClient } from "./openAiRealtimeClient.ts";

type JsonRecord = Record<string, unknown>;

export interface ClankvoxRealtimeBridgeVox {
	on(event: "speakingStart" | "speakingEnd" | "userAudioEnd", listener: (userId: string) => void): unknown;
	on(event: "userAudio", listener: (userId: string, pcm: Buffer) => void): unknown;
	on(event: "decodedVideoFrame", listener: (frame: ClankvoxDecodedVideoFrame) => void): unknown;
	on(event: "ipcError", listener: (event: JsonRecord) => void): unknown;
	subscribeUser(userId: string, silenceDurationMs: number, sampleRate: number): void;
}

export interface ClankvoxRealtimeBridgeRealtime {
	appendInputAudioPcm(audio: Buffer): void;
	commitInputAudioBuffer(): void;
	createAudioResponse(): void;
	appendInputVideoFrame(input: { mimeType: string; dataBase64: string }): void;
}

export interface BindClankvoxRealtimeBridgeOptions {
	vox: ClankvoxRealtimeBridgeVox;
	realtime: ClankvoxRealtimeBridgeRealtime | OpenAiRealtimeClient;
	onDecodedVideoFrame?(frame: ClankvoxDecodedVideoFrame): void;
	onIpcError?(event: JsonRecord): void;
	autoAppendDecodedVideoFrames?: boolean;
	turnBuffer?: Pick<DiscordVoiceTurnBufferOptions, "flushDelayMs" | "mixAudio" | "setTimer" | "clearTimer" | "onError">;
}

export function bindClankvoxRealtimeBridge(options: BindClankvoxRealtimeBridgeOptions): DiscordVoiceTurnBuffer {
	const turnOptions: DiscordVoiceTurnBufferOptions = {
		mixAudio: true,
		subscribeUser: (userId) => options.vox.subscribeUser(userId, 700, 24_000),
		appendInputAudio: (_userId, pcm) => options.realtime.appendInputAudioPcm(pcm),
		commitInputAudioBuffer: () => options.realtime.commitInputAudioBuffer(),
		createAudioResponse: () => options.realtime.createAudioResponse(),
	};
	if (options.turnBuffer?.flushDelayMs !== undefined) turnOptions.flushDelayMs = options.turnBuffer.flushDelayMs;
	if (options.turnBuffer?.mixAudio !== undefined) turnOptions.mixAudio = options.turnBuffer.mixAudio;
	if (options.turnBuffer?.setTimer !== undefined) turnOptions.setTimer = options.turnBuffer.setTimer;
	if (options.turnBuffer?.clearTimer !== undefined) turnOptions.clearTimer = options.turnBuffer.clearTimer;
	if (options.turnBuffer?.onError !== undefined) turnOptions.onError = options.turnBuffer.onError;

	const turnBuffer = new DiscordVoiceTurnBuffer(turnOptions);
	options.vox.on("speakingStart", (userId) => {
		turnBuffer.speakingStart(userId);
	});
	options.vox.on("speakingEnd", (userId) => {
		turnBuffer.speakingEnd(userId);
	});
	options.vox.on("userAudio", (userId, pcm) => {
		turnBuffer.userAudio(userId, pcm);
	});
	options.vox.on("userAudioEnd", (userId) => {
		turnBuffer.userAudioEnd(userId);
	});
	options.vox.on("decodedVideoFrame", (frame) => {
		options.onDecodedVideoFrame?.(frame);
		if (options.autoAppendDecodedVideoFrames !== false) {
			options.realtime.appendInputVideoFrame({ mimeType: "image/jpeg", dataBase64: frame.jpegBase64 });
		}
	});
	options.vox.on("ipcError", (event) => {
		options.onIpcError?.(event);
	});
	return turnBuffer;
}
