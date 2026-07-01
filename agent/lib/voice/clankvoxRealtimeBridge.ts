import type { JsonRecord } from "./json.ts";
import type { ClankvoxDecodedVideoFrame } from "./clankvoxIpcClient.ts";
import { DiscordVoiceTurnBuffer, type DiscordVoiceTurnBufferOptions } from "./discordVoiceTurnBuffer.ts";
import type { OpenAiRealtimeClient } from "./openAiRealtimeClient.ts";

export interface ClankvoxRealtimeBridgeVox {
	on(event: "speakingStart" | "speakingEnd" | "userAudioEnd", listener: (userId: string) => void): unknown;
	on(event: "userAudio", listener: (userId: string, pcm: Buffer) => void): unknown;
	on(event: "decodedVideoFrame", listener: (frame: ClankvoxDecodedVideoFrame) => void): unknown;
	on(event: "ipcError", listener: (event: JsonRecord) => void): unknown;
	off?(event: "speakingStart" | "speakingEnd" | "userAudioEnd", listener: (userId: string) => void): unknown;
	off?(event: "userAudio", listener: (userId: string, pcm: Buffer) => void): unknown;
	off?(event: "decodedVideoFrame", listener: (frame: ClankvoxDecodedVideoFrame) => void): unknown;
	off?(event: "ipcError", listener: (event: JsonRecord) => void): unknown;
	subscribeUser(userId: string, silenceDurationMs: number, sampleRate: number): void;
}

export interface ClankvoxRealtimeBridgeRealtime {
	appendInputAudioPcm(audio: Buffer): void;
	commitInputAudioBuffer(): void;
	cancelResponse?(): void;
	createAudioResponse(): void;
	appendInputVideoFrame(input: { mimeType: string; dataBase64: string }): void;
}

export interface BindClankvoxRealtimeBridgeOptions {
	vox: ClankvoxRealtimeBridgeVox;
	realtime: ClankvoxRealtimeBridgeRealtime | OpenAiRealtimeClient;
	onDecodedVideoFrame?(frame: ClankvoxDecodedVideoFrame): void;
	onIpcError?(event: JsonRecord): void;
	onFlushSpeakers?(userIds: string[]): void;
	/**
	 * Sink for errors thrown by the realtime side of the bridge (defaults to the
	 * turn-buffer onError). The bridge fires from vox event listeners, so a
	 * throwing realtime call with no guard would be an uncaught exception.
	 */
	onError?(error: unknown): void;
	autoAppendDecodedVideoFrames?: boolean;
	turnBuffer?: Pick<DiscordVoiceTurnBufferOptions, "flushDelayMs" | "mixAudio" | "setTimer" | "clearTimer" | "onError">;
}

export interface ClankvoxRealtimeBridgeBinding {
	turnBuffer: DiscordVoiceTurnBuffer;
	/** Unbind all vox listeners and dispose the turn buffer. */
	dispose(): void;
}

export function bindClankvoxRealtimeBridge(options: BindClankvoxRealtimeBridgeOptions): ClankvoxRealtimeBridgeBinding {
	const onError = options.onError ?? options.turnBuffer?.onError;
	const turnBufferOnError = options.turnBuffer?.onError ?? options.onError;
	const turnOptions: DiscordVoiceTurnBufferOptions = {
		mixAudio: true,
		subscribeUser: (userId) => options.vox.subscribeUser(userId, 700, 24_000),
		appendInputAudio: (_userId, pcm) => options.realtime.appendInputAudioPcm(pcm),
		commitInputAudioBuffer: () => options.realtime.commitInputAudioBuffer(),
		createAudioResponse: () => options.realtime.createAudioResponse(),
		onFlushSpeakers: options.onFlushSpeakers,
	};
	if (options.turnBuffer?.flushDelayMs !== undefined) turnOptions.flushDelayMs = options.turnBuffer.flushDelayMs;
	if (options.turnBuffer?.mixAudio !== undefined) turnOptions.mixAudio = options.turnBuffer.mixAudio;
	if (options.turnBuffer?.setTimer !== undefined) turnOptions.setTimer = options.turnBuffer.setTimer;
	if (options.turnBuffer?.clearTimer !== undefined) turnOptions.clearTimer = options.turnBuffer.clearTimer;
	if (turnBufferOnError !== undefined) turnOptions.onError = turnBufferOnError;

	const turnBuffer = new DiscordVoiceTurnBuffer(turnOptions);
	const safeCall = (fn: () => void): void => {
		try {
			fn();
		} catch (error) {
			onError?.(error);
		}
	};
	const speakingStartListener = (userId: string): void => {
		turnBuffer.speakingStart(userId);
	};
	const speakingEndListener = (userId: string): void => {
		turnBuffer.speakingEnd(userId);
	};
	const userAudioListener = (userId: string, pcm: Buffer): void => {
		turnBuffer.userAudio(userId, pcm);
	};
	const userAudioEndListener = (userId: string): void => {
		turnBuffer.userAudioEnd(userId);
	};
	// Video frames bypass the turn buffer (and its safeCall guard), so guard
	// here: a Realtime WS drop mid-Go-Live otherwise crashes the brain when the
	// next frame forwards into a dead socket.
	const decodedVideoFrameListener = (frame: ClankvoxDecodedVideoFrame): void => {
		safeCall(() => {
			options.onDecodedVideoFrame?.(frame);
			if (options.autoAppendDecodedVideoFrames !== false) {
				options.realtime.appendInputVideoFrame({ mimeType: "image/jpeg", dataBase64: frame.jpegBase64 });
			}
		});
	};
	const ipcErrorListener = (event: JsonRecord): void => {
		safeCall(() => options.onIpcError?.(event));
	};
	options.vox.on("speakingStart", speakingStartListener);
	options.vox.on("speakingEnd", speakingEndListener);
	options.vox.on("userAudio", userAudioListener);
	options.vox.on("userAudioEnd", userAudioEndListener);
	options.vox.on("decodedVideoFrame", decodedVideoFrameListener);
	options.vox.on("ipcError", ipcErrorListener);
	return {
		turnBuffer,
		dispose() {
			options.vox.off?.("speakingStart", speakingStartListener);
			options.vox.off?.("speakingEnd", speakingEndListener);
			options.vox.off?.("userAudio", userAudioListener);
			options.vox.off?.("userAudioEnd", userAudioEndListener);
			options.vox.off?.("decodedVideoFrame", decodedVideoFrameListener);
			options.vox.off?.("ipcError", ipcErrorListener);
			turnBuffer.dispose();
		},
	};
}
