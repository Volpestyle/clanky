/**
 * Go Live control for Clanky's voice presence (SPEC.md §5.3).
 *
 * Drives Discord's screen-share opcodes through the gateway's raw seam (which
 * requires a user/self token, §user-token-patches) and routes discovered stream
 * credentials into ClankVox to decode (watch) or publish his own Go Live. The
 * opcode + discovery side is exercised here; the ClankVox forwarding (the GoLiveSink)
 * is the live-gated media step, supplied by the voice layer when a session is up.
 */
import {
	createDiscordStreamDiscovery,
	deriveDiscordStreamWatchDaveChannelId,
	type DiscordRawGatewayClient,
	type DiscordStreamDiscovery,
	type DiscoveredDiscordStream,
} from "../voice/discordStreamDiscovery.ts";

/** Stream connection credentials handed to ClankVox (sessionId filled by the sink). */
export interface GoLiveStreamCredentials {
	endpoint: string;
	token: string;
	serverId: string;
	userId: string;
	daveChannelId: string;
}

/** The ClankVox media boundary; the voice layer supplies this when a session is live. */
export interface GoLiveSink {
	watch(creds: GoLiveStreamCredentials): void;
	publish(creds: GoLiveStreamCredentials): void;
}

export interface GoLiveControllerOptions {
	/** Resolve the bot's own user id, to tell "publish my stream" from "watch theirs". */
	selfUserId?: () => string | undefined;
	/** ClankVox forwarding; when absent, streams are still discovered/requested. */
	sink?: GoLiveSink;
}

export class GoLiveController {
	private readonly discovery: DiscordStreamDiscovery;
	private readonly selfUserId?: () => string | undefined;
	private readonly sink?: GoLiveSink;

	constructor(client: DiscordRawGatewayClient, options: GoLiveControllerOptions = {}) {
		this.selfUserId = options.selfUserId;
		this.sink = options.sink;
		this.discovery = createDiscordStreamDiscovery(client, {
			onStreamCredentials: (stream) => this.forward(stream),
		});
	}

	listStreams(): DiscoveredDiscordStream[] {
		return this.discovery.listStreams();
	}

	/** Start watching a discovered stream by fuzzy target (user id, channel, key). */
	watch(target?: string): DiscoveredDiscordStream {
		const stream = this.discovery.findStream(target);
		if (stream === undefined) throw new Error(target ? `no stream matching '${target}'` : "no active streams to watch");
		this.discovery.requestWatch(stream.streamKey);
		return stream;
	}

	/** Publish Clanky's own Go Live in a voice channel. */
	goLive(input: { guildId: string; channelId: string; preferredRegion?: string | null }): void {
		this.discovery.requestPublish(input);
	}

	stopPublish(streamKey: string): void {
		this.discovery.requestPublishStop(streamKey);
	}

	setPaused(streamKey: string, paused: boolean): void {
		this.discovery.setPublishPaused(streamKey, paused);
	}

	stop(): void {
		this.discovery.stop();
	}

	private forward(stream: DiscoveredDiscordStream): void {
		if (this.sink === undefined) return;
		const creds = toCredentials(stream);
		if (creds === null) return;
		const self = this.selfUserId?.();
		if (self !== undefined && stream.userId === self) this.sink.publish(creds);
		else this.sink.watch(creds);
	}
}

function toCredentials(stream: DiscoveredDiscordStream): GoLiveStreamCredentials | null {
	if (stream.endpoint === null || stream.token === null || stream.rtcServerId === null) return null;
	return {
		endpoint: stream.endpoint,
		token: stream.token,
		serverId: stream.rtcServerId,
		userId: stream.userId,
		daveChannelId: deriveDiscordStreamWatchDaveChannelId(stream.rtcServerId) ?? "",
	};
}

// Active controller registry: the live voice join sets it, the discord_golive
// tool reads it. One voice session at a time, so one controller at a time.
let active: GoLiveController | null = null;

export function setActiveGoLive(controller: GoLiveController): void {
	if (active !== null && active !== controller) active.stop();
	active = controller;
}

export function getActiveGoLive(): GoLiveController | null {
	return active;
}

export function clearActiveGoLive(): void {
	active?.stop();
	active = null;
}
