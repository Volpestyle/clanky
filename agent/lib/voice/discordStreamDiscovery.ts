import { TtlCache } from "../ttl-cache.ts";
import { isRecord, type JsonRecord } from "./json.ts";

export interface DiscordRawGatewayClient {
	on(event: "raw", listener: (packet: DiscordRawPacket) => void): unknown;
	off?(event: "raw", listener: (packet: DiscordRawPacket) => void): unknown;
	removeListener?(event: "raw", listener: (packet: DiscordRawPacket) => void): unknown;
	ws: {
		_ws?: {
			send(shardId: number, payload: { op: number; d: unknown }): void;
		} | null;
		shards: {
			first(): { id?: number } | null | undefined;
		};
	};
}

export interface DiscordRawPacket {
	t?: string;
	d?: JsonRecord | null;
}

export type DiscordStreamKind = "guild" | "call";

export interface DiscoveredDiscordStream {
	kind: DiscordStreamKind;
	streamKey: string;
	guildId: string;
	channelId: string;
	userId: string;
	endpoint: string | null;
	token: string | null;
	rtcServerId: string | null;
	updatedAt: number;
}

export interface DiscordStreamDiscoveryHooks {
	onStreamCredentials?(stream: DiscoveredDiscordStream): void;
	onStreamDeleted?(stream: DiscoveredDiscordStream): void;
}

export interface DiscordStreamDiscovery {
	stop(): void;
	listStreams(): DiscoveredDiscordStream[];
	findStream(target?: string, scope?: DiscordStreamScope): DiscoveredDiscordStream | undefined;
	requestWatch(streamKey: string): void;
	requestPublish(input: { kind?: DiscordStreamKind; guildId: string; channelId: string; preferredRegion?: string | null }): void;
	requestPublishStop(streamKey: string): void;
	setPublishPaused(streamKey: string, paused: boolean): void;
}

export interface DiscordStreamScope {
	guildId?: string;
	channelId?: string;
}

// Discovered streams (and the Go Live credentials on them) expire after this
// long without a gateway update, so a missed STREAM_DELETE cannot leave stale
// endpoint/token pairs cached for the brain's whole uptime. Generous: Go Live
// sessions rarely outlast half a day without any credential refresh.
const STREAM_DISCOVERY_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_DISCOVERED_STREAMS = 128;

export function createDiscordStreamDiscovery(
	client: DiscordRawGatewayClient,
	hooks: DiscordStreamDiscoveryHooks = {},
): DiscordStreamDiscovery {
	const streams = new TtlCache<string, DiscoveredDiscordStream>({
		maxEntries: MAX_DISCOVERED_STREAMS,
		ttlMs: STREAM_DISCOVERY_TTL_MS,
	});
	const listener = (packet: DiscordRawPacket) => {
		if (packet.d === undefined || packet.d === null) return;
		if (packet.t === "GUILD_CREATE") handleGuildCreate(packet.d, streams);
		if (packet.t === "VOICE_STATE_UPDATE") {
			const deleted = handleVoiceStateUpdate(packet.d, streams);
			if (deleted !== undefined) hooks.onStreamDeleted?.(deleted);
		}
		if (packet.t === "STREAM_CREATE") {
			const stream = handleStreamCreate(packet.d, streams);
			if (stream !== undefined) hooks.onStreamCredentials?.(stream);
		}
		if (packet.t === "STREAM_SERVER_UPDATE") {
			const stream = handleStreamServerUpdate(packet.d, streams);
			if (stream !== undefined) hooks.onStreamCredentials?.(stream);
		}
		if (packet.t === "STREAM_DELETE") {
			const streamKey = stringValue(packet.d.stream_key) || streamKeyFromParts(packet.d);
			const existing = streamKey === undefined ? undefined : streams.get(streamKey);
			if (streamKey !== undefined) streams.delete(streamKey);
			if (existing !== undefined) hooks.onStreamDeleted?.(existing);
		}
	};
	client.on("raw", listener);

	return {
		stop() {
			if (client.off !== undefined) client.off("raw", listener);
			else client.removeListener?.("raw", listener);
		},
		listStreams() {
			return [...streams.values()].sort((left, right) => right.updatedAt - left.updatedAt);
		},
		findStream(target?: string, scope?: DiscordStreamScope) {
			return findStream([...streams.values()], target, scope);
		},
		requestWatch(streamKey: string) {
			sendGatewayPayload(client, { op: 20, d: { stream_key: streamKey } });
		},
		requestPublish(input) {
			const kind = input.kind ?? "guild";
			const guildId = input.guildId.trim();
			const channelId = input.channelId.trim();
			if (channelId.length === 0 || (kind === "guild" && guildId.length === 0)) return;
			sendGatewayPayload(client, {
				op: 18,
				d:
					kind === "call"
						? {
								type: "call",
								channel_id: channelId,
								preferred_region: input.preferredRegion?.trim() || null,
							}
						: {
								type: "guild",
								guild_id: guildId,
								channel_id: channelId,
								preferred_region: input.preferredRegion?.trim() || null,
							},
			});
		},
		requestPublishStop(streamKey: string) {
			const normalizedStreamKey = streamKey.trim();
			if (normalizedStreamKey.length === 0) return;
			sendGatewayPayload(client, { op: 19, d: { stream_key: normalizedStreamKey } });
		},
		setPublishPaused(streamKey: string, paused: boolean) {
			const normalizedStreamKey = streamKey.trim();
			if (normalizedStreamKey.length === 0) return;
			sendGatewayPayload(client, { op: 22, d: { stream_key: normalizedStreamKey, paused } });
		},
	};
}

export function buildDiscordStreamKey(input: { guildId: string; channelId: string; userId: string }): string {
	return `guild:${input.guildId}:${input.channelId}:${input.userId}`;
}

export function buildDiscordCallStreamKey(input: { channelId: string; userId: string }): string {
	return `call:${input.channelId}:${input.userId}`;
}

export function deriveDiscordStreamWatchDaveChannelId(rtcServerId: string | null | undefined): string | undefined {
	const normalizedRtcServerId = stringValue(rtcServerId);
	if (normalizedRtcServerId.length === 0) return undefined;
	try {
		const serverId = BigInt(normalizedRtcServerId);
		if (serverId <= 0n) return undefined;
		return String(serverId - 1n);
	} catch {
		return undefined;
	}
}

function handleVoiceStateUpdate(
	data: JsonRecord,
	streams: TtlCache<string, DiscoveredDiscordStream>,
): DiscoveredDiscordStream | undefined {
	const guildId = stringValue(data.guild_id);
	const channelId = stringValue(data.channel_id);
	const userId = stringValue(data.user_id);
	if (guildId.length === 0 || userId.length === 0) return undefined;
	if (data.self_stream === false) return removeStreamsForUser(streams, { guildId, userId });
	if (data.self_stream !== true || channelId.length === 0) return undefined;
	upsertStream(streams, {
		kind: "guild",
		streamKey: buildDiscordStreamKey({ guildId, channelId, userId }),
		guildId,
		channelId,
		userId,
		endpoint: null,
		token: null,
		rtcServerId: null,
		updatedAt: Date.now(),
	});
	return undefined;
}

function handleStreamCreate(
	data: JsonRecord,
	streams: TtlCache<string, DiscoveredDiscordStream>,
): DiscoveredDiscordStream | undefined {
	const streamKey = stringValue(data.stream_key) || streamKeyFromParts(data);
	const parts = streamKey === undefined ? undefined : parseStreamKey(streamKey);
	if (streamKey === undefined || parts === undefined) return undefined;
	const stream = upsertStream(streams, {
		kind: parts.kind,
		streamKey,
		guildId: parts.guildId ?? "",
		channelId: parts.channelId,
		userId: parts.userId,
		endpoint: stringValue(data.endpoint) || null,
		token: stringValue(data.token) || null,
		rtcServerId: stringValue(data.rtc_server_id) || stringValue(data.rtcServerId) || null,
		updatedAt: Date.now(),
	});
	return hasCredentials(stream) ? stream : undefined;
}

function handleGuildCreate(data: JsonRecord, streams: TtlCache<string, DiscoveredDiscordStream>): void {
	const guildId = stringValue(data.id);
	if (guildId.length === 0 || !Array.isArray(data.voice_states)) return;
	for (const entry of data.voice_states) {
		if (!isRecord(entry) || entry.self_stream !== true) continue;
		const channelId = stringValue(entry.channel_id);
		const userId = stringValue(entry.user_id);
		if (channelId.length === 0 || userId.length === 0) continue;
		upsertStream(streams, {
			kind: "guild",
			streamKey: buildDiscordStreamKey({ guildId, channelId, userId }),
			guildId,
			channelId,
			userId,
			endpoint: null,
			token: null,
			rtcServerId: null,
			updatedAt: Date.now(),
		});
	}
}

function handleStreamServerUpdate(
	data: JsonRecord,
	streams: TtlCache<string, DiscoveredDiscordStream>,
): DiscoveredDiscordStream | undefined {
	const streamKey = stringValue(data.stream_key) || streamKeyFromParts(data);
	const parts = streamKey === undefined ? undefined : parseStreamKey(streamKey);
	if (streamKey === undefined || parts === undefined) return undefined;
	const stream = upsertStream(streams, {
		kind: parts.kind,
		streamKey,
		guildId: parts.guildId ?? "",
		channelId: parts.channelId,
		userId: parts.userId,
		endpoint: stringValue(data.endpoint) || null,
		token: stringValue(data.token) || null,
		rtcServerId: stringValue(data.rtc_server_id) || stringValue(data.rtcServerId) || null,
		updatedAt: Date.now(),
	});
	return hasCredentials(stream) ? stream : undefined;
}

function upsertStream(
	streams: TtlCache<string, DiscoveredDiscordStream>,
	input: DiscoveredDiscordStream,
): DiscoveredDiscordStream {
	const existing = streams.get(input.streamKey);
	const stream: DiscoveredDiscordStream = {
		kind: input.kind ?? existing?.kind ?? "guild",
		streamKey: input.streamKey,
		guildId: input.guildId || existing?.guildId || "",
		channelId: input.channelId || existing?.channelId || "",
		userId: input.userId || existing?.userId || "",
		endpoint: input.endpoint ?? existing?.endpoint ?? null,
		token: input.token ?? existing?.token ?? null,
		rtcServerId: input.rtcServerId ?? existing?.rtcServerId ?? null,
		updatedAt: input.updatedAt,
	};
	streams.set(stream.streamKey, stream);
	return stream;
}

function removeStreamsForUser(
	streams: TtlCache<string, DiscoveredDiscordStream>,
	input: { guildId: string; userId: string },
): DiscoveredDiscordStream | undefined {
	let removed: DiscoveredDiscordStream | undefined;
	for (const stream of streams.values()) {
		if (stream.guildId !== input.guildId || stream.userId !== input.userId) continue;
		streams.delete(stream.streamKey);
		removed = stream;
	}
	return removed;
}

function findStream(
	streams: DiscoveredDiscordStream[],
	target?: string,
	scope: DiscordStreamScope = {},
): DiscoveredDiscordStream | undefined {
	const normalizedTarget = target?.trim().toLowerCase();
	const guildId = scope.guildId?.trim();
	const channelId = scope.channelId?.trim();
	const scoped = streams.filter((stream) => {
		if (guildId !== undefined && guildId.length > 0 && stream.guildId !== guildId) return false;
		if (channelId !== undefined && channelId.length > 0 && stream.channelId !== channelId) return false;
		return true;
	});
	const sorted = [...scoped].sort((left, right) => right.updatedAt - left.updatedAt);
	if (normalizedTarget === undefined || normalizedTarget.length === 0) return sorted[0];
	return sorted.find((stream) => {
		return (
			stream.streamKey.toLowerCase().includes(normalizedTarget) ||
			stream.userId === normalizedTarget ||
			stream.channelId === normalizedTarget
		);
	});
}

function sendGatewayPayload(client: DiscordRawGatewayClient, payload: { op: number; d: unknown }): void {
	const shardId = client.ws.shards.first()?.id ?? 0;
	client.ws._ws?.send(shardId, payload);
}

function streamKeyFromParts(data: JsonRecord): string | undefined {
	const guildId = stringValue(data.guild_id);
	const channelId = stringValue(data.channel_id);
	const userId = stringValue(data.user_id);
	if (channelId.length === 0 || userId.length === 0) return undefined;
	if (guildId.length === 0) return buildDiscordCallStreamKey({ channelId, userId });
	return buildDiscordStreamKey({ guildId, channelId, userId });
}

function parseStreamKey(
	streamKey: string,
): { kind: DiscordStreamKind; guildId?: string; channelId: string; userId: string } | undefined {
	const [kind, first, second, third] = streamKey.split(":");
	if (kind === "guild" && first !== undefined && second !== undefined && third !== undefined) {
		return { kind, guildId: first, channelId: second, userId: third };
	}
	if (kind === "call" && first !== undefined && second !== undefined) {
		return { kind, channelId: first, userId: second };
	}
	return undefined;
}

function hasCredentials(stream: DiscoveredDiscordStream): boolean {
	return stream.endpoint !== null && stream.token !== null && stream.rtcServerId !== null;
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}
