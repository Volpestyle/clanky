/**
 * Discord user-token private call support.
 *
 * Discord private calls are not exposed through discord.js' guild voice adapter,
 * but the user gateway still emits raw call + voice events. This adapter maps
 * those raw events onto the tiny voice adapter shape ClankVox already consumes.
 */
import { ChannelType, type Client, type User } from "discord.js";
import type { DiscordScopeOptions } from "./acceptance.ts";
import type { ClankvoxGuildLike } from "../voice/clankvoxIpcClient.ts";
import { isRecord, type JsonRecord, stringValue } from "../voice/json.ts";
import type { DiscordRawGatewayClient, DiscordRawPacket } from "../voice/discordStreamDiscovery.ts";
import type { VoiceMemorySpeaker } from "../voice/memory.ts";

export interface PrivateCallInfo {
	channelId: string;
	ringingUserIds: string[];
	speakers?: VoiceMemorySpeaker[];
	peer?: VoiceMemorySpeaker;
}

export interface PrivateCallAutoAnswerOptions {
	client: Client;
	scope: DiscordScopeOptions;
	onIncoming(call: PrivateCallInfo): Promise<void> | void;
	onDeleted?(channelId: string): Promise<void> | void;
	onError?(error: unknown): void;
}

export interface PrivateCallAutoAnswerHandle {
	stop(): void;
}

export function createDiscordPrivateCallVoiceAdapter(
	client: DiscordRawGatewayClient,
	options: {
		channelId: string;
		selfUserId: () => string | undefined;
	},
): ClankvoxGuildLike {
	return {
		voiceAdapterCreator(callbacks) {
			const listener = (packet: DiscordRawPacket): void => {
				if (packet.d === undefined || packet.d === null) return;
				if (packet.t === "VOICE_SERVER_UPDATE" && isPrivateVoiceServerUpdate(packet.d, options.channelId)) {
					callbacks.onVoiceServerUpdate(packet.d);
					return;
				}
				if (packet.t === "VOICE_STATE_UPDATE" && isPrivateSelfVoiceStateUpdate(packet.d, options.channelId, options.selfUserId())) {
					callbacks.onVoiceStateUpdate(packet.d);
				}
			};
			client.on("raw", listener);
			return {
				sendPayload(payload) {
					sendRawGatewayPayload(client, rewritePrivateCallVoiceStatePayload(payload, options.channelId));
					return true;
				},
				destroy() {
					removeRawListener(client, listener);
				},
			};
		},
	};
}

export function attachPrivateCallAutoAnswer(options: PrivateCallAutoAnswerOptions): PrivateCallAutoAnswerHandle {
	const client = options.client as unknown as DiscordRawGatewayClient;
	const inFlight = new Set<string>();
	const listener = (packet: DiscordRawPacket): void => {
		if (packet.d === undefined || packet.d === null) return;
		if (packet.t === "CALL_DELETE") {
			const channelId = stringValue(packet.d.channel_id);
			if (channelId.length > 0) {
				inFlight.delete(channelId);
				void Promise.resolve(options.onDeleted?.(channelId)).catch((error: unknown) => options.onError?.(error));
			}
			return;
		}
		if (packet.t !== "CALL_CREATE" && packet.t !== "CALL_UPDATE") return;
		const call = parseIncomingPrivateCallDispatch(packet.d, options.client.user?.id);
		if (call === undefined || inFlight.has(call.channelId)) return;
		if (!privateCallAllowedByScope(call.channelId, options.scope)) return;
		inFlight.add(call.channelId);
		void (async () => {
			try {
				const context = await fetchPrivateCallContext(options.client, call.channelId);
				await options.onIncoming({ ...call, ...context });
			} catch (error) {
				inFlight.delete(call.channelId);
				options.onError?.(error);
			}
		})();
	};
	client.on("raw", listener);
	return {
		stop() {
			removeRawListener(client, listener);
			inFlight.clear();
		},
	};
}

export function parseIncomingPrivateCallDispatch(
	data: JsonRecord,
	selfUserId: string | undefined,
): PrivateCallInfo | undefined {
	const channelId = stringValue(data.channel_id);
	if (channelId.length === 0 || selfUserId === undefined || selfUserId.length === 0) return undefined;
	const ringingUserIds = Array.isArray(data.ringing)
		? data.ringing.map((value) => stringValue(value)).filter((value) => value.length > 0)
		: [];
	if (!ringingUserIds.includes(selfUserId)) return undefined;
	return { channelId, ringingUserIds };
}

export function privateCallAllowedByScope(channelId: string, scope: DiscordScopeOptions): boolean {
	if (scope.allowDms === false) return false;
	const allowed = normalizedIdSet(scope.allowedChannelIds);
	return allowed === undefined || allowed.has(channelId);
}

export async function fetchPrivateCallContext(
	client: Client,
	channelId: string,
): Promise<Pick<PrivateCallInfo, "peer" | "speakers">> {
	const channel = await client.channels.fetch(channelId);
	if (channel === null) throw new Error(`private call channel ${channelId} was not found`);
	if (channel.type === ChannelType.DM) {
		const dm = channel as { recipientId?: string; recipient?: User | null };
		const recipient = dm.recipient ?? (dm.recipientId === undefined ? undefined : client.users.cache.get(dm.recipientId));
		const peer = recipient === undefined || recipient === null ? undefined : discordUserAsSpeaker(recipient);
		return peer === undefined ? {} : { peer, speakers: [peer] };
	}
	if (channel.type === ChannelType.GroupDM) {
		const group = channel as { recipients?: Array<{ id?: string; username?: string; globalName?: string | null }> };
		const speakers = (group.recipients ?? [])
			.map((recipient) => partialRecipientAsSpeaker(client, recipient))
			.filter((speaker): speaker is VoiceMemorySpeaker => speaker !== undefined);
		return speakers.length === 0 ? {} : { speakers };
	}
	throw new Error("private call answering only supports DM and group DM calls");
}

export function rewritePrivateCallVoiceStatePayload(payload: JsonRecord, channelId: string): JsonRecord {
	if (payload.op !== 4 || !isRecord(payload.d)) return payload;
	const requestedChannelId = payload.d.channel_id === null ? null : channelId;
	return {
		...payload,
		d: {
			...payload.d,
			guild_id: null,
			channel_id: requestedChannelId,
		},
	};
}

function isPrivateVoiceServerUpdate(data: JsonRecord, channelId: string): boolean {
	if (stringValue(data.guild_id).length > 0) return false;
	const eventChannelId = stringValue(data.channel_id);
	return eventChannelId.length === 0 || eventChannelId === channelId;
}

function isPrivateSelfVoiceStateUpdate(data: JsonRecord, channelId: string, selfUserId: string | undefined): boolean {
	if (selfUserId === undefined || stringValue(data.user_id) !== selfUserId) return false;
	if (stringValue(data.guild_id).length > 0) return false;
	const stateChannelId = data.channel_id === null ? null : stringValue(data.channel_id);
	return stateChannelId === channelId || stateChannelId === null;
}

function sendRawGatewayPayload(client: DiscordRawGatewayClient, payload: JsonRecord): void {
	if (typeof payload.op !== "number") return;
	const shardId = client.ws.shards.first()?.id ?? 0;
	client.ws._ws?.send(shardId, { op: payload.op, d: payload.d });
}

function removeRawListener(client: DiscordRawGatewayClient, listener: (packet: DiscordRawPacket) => void): void {
	if (client.off !== undefined) {
		client.off("raw", listener);
		return;
	}
	client.removeListener?.("raw", listener);
}

function normalizedIdSet(ids: readonly string[] | undefined): Set<string> | undefined {
	const set = new Set((ids ?? []).map((id) => id.trim()).filter((id) => id.length > 0));
	return set.size === 0 ? undefined : set;
}

function partialRecipientAsSpeaker(
	client: Client,
	recipient: { id?: string; username?: string; globalName?: string | null },
): VoiceMemorySpeaker | undefined {
	const userId = recipient.id?.trim();
	if (userId === undefined || userId.length === 0) return undefined;
	const user = client.users.cache.get(userId);
	const userName = user === undefined ? (recipient.globalName ?? recipient.username) : discordUserDisplayName(user);
	return { userId, ...(userName === undefined || userName === null ? {} : { userName }) };
}

function discordUserAsSpeaker(user: User): VoiceMemorySpeaker {
	return { userId: user.id, userName: discordUserDisplayName(user) };
}

function discordUserDisplayName(user: User): string {
	return user.globalName ?? user.username;
}
