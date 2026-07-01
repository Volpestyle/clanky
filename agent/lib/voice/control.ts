import type { DiscoveredDiscordStream } from "./discordStreamDiscovery.ts";

export type VoiceControlOp =
	| "status"
	| "music_play"
	| "music_stop"
	| "music_pause"
	| "music_resume"
	| "music_volume"
	| "video_play"
	| "video_visualizer"
	| "video_stop"
	| "video_pause"
	| "video_resume"
	| "golive_start"
	| "golive_stop"
	| "golive_pause"
	| "golive_resume";

export interface VoiceControlInput {
	op: VoiceControlOp;
	url?: string;
	resolvedDirectUrl?: boolean;
	volume?: number;
	fadeMs?: number;
	visualizerMode?: string;
	preferredRegion?: string;
	streamKey?: string;
}

export type VoiceControlPublicStream = Omit<DiscoveredDiscordStream, "endpoint" | "token"> & {
	hasCredentials: boolean;
};

export interface VoiceControlResult {
	ok: true;
	op: VoiceControlOp;
	guildId: string;
	channelId: string;
	url?: string;
	streamKey?: string;
	volume?: number;
	fadeMs?: number;
	visualizerMode?: string;
	goLiveRequested?: boolean;
	goLiveStopped?: boolean;
	goLivePaused?: boolean;
	note?: string;
	streams?: VoiceControlPublicStream[];
}

export interface VoiceControlVox {
	musicPlay(url: string, resolvedDirectUrl?: boolean): void;
	musicStop(): void;
	musicPause(): void;
	musicResume(): void;
	musicSetGain(target: number, fadeMs: number): void;
	streamPublishPlay(url: string, resolvedDirectUrl?: boolean): void;
	streamPublishPlayVisualizer(url: string, resolvedDirectUrl?: boolean, visualizerMode?: string): void;
	streamPublishStop(): void;
	streamPublishPause(): void;
	streamPublishResume(): void;
}

export interface VoiceControlGoLive {
	listStreams(): DiscoveredDiscordStream[];
	goLive(input: { guildId: string; channelId: string; preferredRegion?: string | null }): void;
	stopPublish(streamKey: string): void;
	setPaused(streamKey: string, paused: boolean): void;
	findOwnStream?(): DiscoveredDiscordStream | undefined;
}

export interface VoiceControlContext {
	guildId: string;
	channelId: string;
	vox: VoiceControlVox;
	goLive?: VoiceControlGoLive | null;
}

const DEFAULT_VOLUME_FADE_MS = 250;

export async function executeVoiceControl(
	input: VoiceControlInput,
	context: VoiceControlContext,
): Promise<VoiceControlResult> {
	switch (input.op) {
		case "status":
			return {
				ok: true,
				op: input.op,
				guildId: context.guildId,
				channelId: context.channelId,
				streams: (context.goLive?.listStreams() ?? []).map(publicStream),
			};
		case "music_play": {
			const url = requiredUrl(input);
			context.vox.musicPlay(url, input.resolvedDirectUrl === true);
			return baseResult(input.op, context, { url });
		}
		case "music_stop":
			context.vox.musicStop();
			return baseResult(input.op, context);
		case "music_pause":
			context.vox.musicPause();
			return baseResult(input.op, context);
		case "music_resume":
			context.vox.musicResume();
			return baseResult(input.op, context);
		case "music_volume": {
			const volume = clampVolume(input.volume);
			const fadeMs = Math.max(0, Math.floor(input.fadeMs ?? DEFAULT_VOLUME_FADE_MS));
			context.vox.musicSetGain(volume, fadeMs);
			return baseResult(input.op, context, { volume, fadeMs });
		}
		case "video_play": {
			const url = requiredUrl(input);
			const goLiveRequested = requestGoLive(context, input);
			context.vox.streamPublishPlay(url, input.resolvedDirectUrl === true);
			return baseResult(input.op, context, { url, goLiveRequested });
		}
		case "video_visualizer": {
			const url = requiredUrl(input);
			const visualizerMode = normalizeVisualizerMode(input.visualizerMode);
			const goLiveRequested = requestGoLive(context, input);
			context.vox.streamPublishPlayVisualizer(url, input.resolvedDirectUrl === true, visualizerMode);
			return baseResult(input.op, context, { url, visualizerMode, goLiveRequested });
		}
		case "video_stop": {
			context.vox.streamPublishStop();
			const stopped = stopGoLiveIfPossible(context, input.streamKey);
			return baseResult(input.op, context, stopped);
		}
		case "video_pause":
			context.vox.streamPublishPause();
			pauseGoLiveIfPossible(context, input.streamKey, true);
			return baseResult(input.op, context, { goLivePaused: true });
		case "video_resume":
			context.vox.streamPublishResume();
			pauseGoLiveIfPossible(context, input.streamKey, false);
			return baseResult(input.op, context, { goLivePaused: false });
		case "golive_start": {
			requestGoLive(context, input);
			return baseResult(input.op, context, { goLiveRequested: true });
		}
		case "golive_stop": {
			const stopped = stopRequiredGoLive(context, input.streamKey);
			return baseResult(input.op, context, stopped);
		}
		case "golive_pause": {
			const streamKey = resolveGoLiveStreamKey(requireGoLive(context), input.streamKey);
			requireGoLive(context).setPaused(streamKey, true);
			return baseResult(input.op, context, { streamKey, goLivePaused: true });
		}
		case "golive_resume": {
			const streamKey = resolveGoLiveStreamKey(requireGoLive(context), input.streamKey);
			requireGoLive(context).setPaused(streamKey, false);
			return baseResult(input.op, context, { streamKey, goLivePaused: false });
		}
	}
}

function publicStream(stream: DiscoveredDiscordStream): VoiceControlPublicStream {
	const { endpoint, token, ...rest } = stream;
	return {
		...rest,
		hasCredentials: endpoint !== null && token !== null,
	};
}

function baseResult(
	op: VoiceControlOp,
	context: VoiceControlContext,
	extra: Partial<Omit<VoiceControlResult, "ok" | "op" | "guildId" | "channelId">> = {},
): VoiceControlResult {
	return { ok: true, op, guildId: context.guildId, channelId: context.channelId, ...extra };
}

function requiredUrl(input: VoiceControlInput): string {
	const url = input.url?.trim();
	if (url === undefined || url.length === 0) throw new Error(`${input.op} requires url`);
	return url;
}

function clampVolume(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) throw new Error("music_volume requires volume");
	return Math.max(0, Math.min(1, value));
}

function normalizeVisualizerMode(value: string | undefined): string {
	const normalized = value?.trim().toLowerCase();
	if (normalized === "spectrum" || normalized === "waves" || normalized === "vectorscope") return normalized;
	return "cqt";
}

function requestGoLive(context: VoiceControlContext, input: VoiceControlInput): boolean {
	const controller = requireGoLive(context);
	controller.goLive({
		guildId: context.guildId,
		channelId: context.channelId,
		preferredRegion: input.preferredRegion ?? null,
	});
	return true;
}

function requireGoLive(context: VoiceControlContext): VoiceControlGoLive {
	if (context.goLive === undefined || context.goLive === null) {
		throw new Error("no active Go Live controller; join voice with a user token first");
	}
	return context.goLive;
}

function stopGoLiveIfPossible(
	context: VoiceControlContext,
	streamKey: string | undefined,
): Pick<VoiceControlResult, "streamKey" | "goLiveStopped" | "note"> {
	if (context.goLive === undefined || context.goLive === null) {
		return { goLiveStopped: false, note: "stopped local video pipeline; no active Go Live controller" };
	}
	return stopRequiredGoLive(context, streamKey);
}

function stopRequiredGoLive(
	context: VoiceControlContext,
	streamKey: string | undefined,
): Pick<VoiceControlResult, "streamKey" | "goLiveStopped"> {
	const controller = requireGoLive(context);
	const resolved = resolveGoLiveStreamKey(controller, streamKey);
	controller.stopPublish(resolved);
	return { streamKey: resolved, goLiveStopped: true };
}

function pauseGoLiveIfPossible(context: VoiceControlContext, streamKey: string | undefined, paused: boolean): void {
	if (context.goLive === undefined || context.goLive === null) return;
	const resolved = resolveGoLiveStreamKey(context.goLive, streamKey);
	context.goLive.setPaused(resolved, paused);
}

function resolveGoLiveStreamKey(controller: VoiceControlGoLive, streamKey: string | undefined): string {
	const explicit = streamKey?.trim();
	if (explicit !== undefined && explicit.length > 0) return explicit;
	const own = controller.findOwnStream?.();
	if (own !== undefined) return own.streamKey;
	throw new Error("streamKey is required because no active self Go Live stream was found");
}
