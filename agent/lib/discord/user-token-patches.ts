/**
 * User-token (selfbot) support for Clanky's Discord gateway (SPEC.md §5.3).
 *
 * discord.js targets bot tokens. Discord only exposes Go Live publish/watch to
 * user-token behavior, so this module applies the compatibility patches needed
 * for Discord user-token mode:
 *   - strip the "Bot " REST auth prefix (user tokens carry no prefix),
 *   - identify as a desktop Discord client and use /gateway (not /gateway/bot),
 *   - synthesize the `application` field a user READY payload omits.
 *
 * It also exposes the raw-gateway seam (sendGatewayPayload / onRawDispatch) the
 * Go Live stream discovery drives. These reach into discord.js internals
 * (client.ws._ws); availability is part of the live-gated voice/Go Live path.
 *
 * Note: automating a user account is against Discord's ToS; this is opt-in for a
 * personal account, gated behind CLANKY_DISCORD_CREDENTIAL_KIND=user-token.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { version as discordJsVersion } from "discord.js";

const DISCORD_USER_IDENTIFY_PROPERTIES = {
	os: "Windows",
	browser: "Discord Client",
	device: "",
};

const require = createRequire(import.meta.url);

/**
 * Loud failure for a missing/misshapen monkeypatch target. These patches reach
 * into discord.js internals under a caret range, so a routine dependency bump
 * can silently break user-token mode; failing the gateway start with a clear
 * operator message beats identifying as a half-patched bot client.
 */
function patchTargetError(detail: string): Error {
	return new Error(
		`discord.js user-token patch target check failed: ${detail}. ` +
			`The installed discord.js version (${discordJsVersion}) no longer matches the internals ` +
			"agent/lib/discord/user-token-patches.ts monkeypatches. Pin or downgrade discord.js to a " +
			"known-good version; user-token (Go Live) mode cannot run until then.",
	);
}

export interface DiscordUserTokenClientLike {
	rest: unknown;
	ws: unknown;
}

export interface GatewayDispatchClientLike {
	on: (event: string, callback: GatewayRawDispatchListener) => void;
	off?: (event: string, callback: GatewayRawDispatchListener) => void;
	removeListener?: (event: string, callback: GatewayRawDispatchListener) => void;
	ws: {
		_ws?: {
			send: (shardId: number, payload: { op: number; d: unknown }) => void;
		} | null;
		shards: {
			first: () => { id?: number } | null | undefined;
		};
	};
}

type GatewayRawDispatchPacket = {
	t?: string;
	d?: Record<string, unknown> | null;
};

type GatewayRawDispatchListener = (packet: GatewayRawDispatchPacket, shardId?: number) => void;

export function getDiscordUserAuthorizationHeaderValue(token: string): string {
	return String(token || "").trim();
}

export function applyDiscordUserTokenPatches(client: DiscordUserTokenClientLike): void {
	patchRestAuth(client);
	patchReadyHandlerForUserTokenPayload();
	patchInternalWebSocketManager(client);
}

export function sendGatewayPayload(client: GatewayDispatchClientLike, payload: { op: number; d: unknown }): void {
	const shardId = client.ws.shards.first()?.id ?? 0;
	client.ws._ws?.send(shardId, payload);
}

export function onRawDispatch(
	client: GatewayDispatchClientLike,
	eventName: string,
	callback: (data: Record<string, unknown>) => void,
): () => void {
	const listener: GatewayRawDispatchListener = (packet) => {
		if (!packet || packet.t !== eventName) return;
		if (!packet.d || typeof packet.d !== "object" || Array.isArray(packet.d)) return;
		callback(packet.d);
	};
	client.on("raw", listener);
	return () => {
		if (typeof client.off === "function") {
			client.off("raw", listener);
			return;
		}
		if (typeof client.removeListener === "function") {
			client.removeListener("raw", listener);
		}
	};
}

function patchRestAuth(client: DiscordUserTokenClientLike): void {
	const rest = coerceRest(client.rest);
	if (!rest) throw patchTargetError("client.rest.resolveRequest is missing or not a function");
	const originalResolveRequest = rest.resolveRequest;
	rest.resolveRequest = async (request: Record<string, unknown>) => {
		const result = await Promise.resolve(originalResolveRequest.call(rest, request));
		const headers = result?.fetchOptions?.headers;
		if (typeof headers?.Authorization === "string" && headers.Authorization.startsWith("Bot ")) {
			headers.Authorization = getDiscordUserAuthorizationHeaderValue(headers.Authorization.slice(4));
		}
		return result;
	};
}

function patchInternalWebSocketManager(client: DiscordUserTokenClientLike): void {
	const ws = coerceWebSocketManagerHost(client.ws);
	if (!ws) throw patchTargetError("client.ws is missing or not an object");
	let wsInner: InternalWSManager | null = coerceInternalWsManagerOrThrow(ws._ws);
	Object.defineProperty(ws, "_ws", {
		get() {
			return wsInner;
		},
		set(value: unknown) {
			// Thrown from inside discord.js's login path, which surfaces the patch
			// failure instead of silently identifying as an unpatched bot client.
			const nextWs = coerceInternalWsManagerOrThrow(value);
			wsInner = nextWs;
			if (nextWs?.options) {
				nextWs.options.identifyProperties = { ...DISCORD_USER_IDENTIFY_PROPERTIES };
				patchFetchGatewayInformation(nextWs);
			}
		},
		configurable: true,
		enumerable: true,
	});
}

function patchFetchGatewayInformation(wsManager: InternalWSManager): void {
	wsManager.fetchGatewayInformation = async function (force = false) {
		if (this.gatewayInformation) {
			if (this.gatewayInformation.expiresAt <= Date.now()) {
				this.gatewayInformation = null;
			} else if (!force) {
				return this.gatewayInformation.data;
			}
		}
		const data = (await this.options.rest.get("/gateway")) as GatewayResponse;
		const enriched: GatewayBotResponse = {
			url: data.url,
			shards: 1,
			session_start_limit: {
				total: 1000,
				remaining: 1000,
				reset_after: 14_400_000,
				max_concurrency: 1,
			},
		};
		this.gatewayInformation = {
			data: enriched,
			expiresAt: Date.now() + enriched.session_start_limit.reset_after,
		};
		return this.gatewayInformation.data;
	};
}

function patchReadyHandlerForUserTokenPayload(): void {
	let handlers: { READY?: ReadyHandler };
	try {
		handlers = require(resolveDiscordJsHandlersPath()) as { READY?: ReadyHandler };
	} catch (error) {
		throw patchTargetError(
			`discord.js/src/client/websocket/handlers/index.js could not be loaded (${error instanceof Error ? error.message : String(error)})`,
		);
	}
	const originalReady = handlers.READY;
	if (typeof originalReady !== "function") {
		throw patchTargetError("the READY dispatch handler is missing from discord.js/src/client/websocket/handlers");
	}
	if (originalReady.__clankyUserTokenPatched) return;
	const patchedReady: ReadyHandler = (client: unknown, packet: ReadyPacket, shard: { id: number }) => {
		const data = packet?.d;
		if (data && (!data.application || typeof data.application !== "object")) {
			packet = {
				...packet,
				d: {
					...data,
					application: buildSyntheticReadyApplication(data),
				},
			};
		}
		return originalReady(client, packet, shard);
	};
	patchedReady.__clankyUserTokenPatched = true;
	handlers.READY = patchedReady;
}

function resolveDiscordJsHandlersPath(): string {
	try {
		return require.resolve("discord.js/src/client/websocket/handlers/index.js");
	} catch {
		try {
			return path.resolve(path.dirname(require.resolve("discord.js")), "client/websocket/handlers/index.js");
		} catch {
			return path.resolve(process.cwd(), "node_modules/discord.js/src/client/websocket/handlers/index.js");
		}
	}
}

function buildSyntheticReadyApplication(data: Record<string, unknown>): Record<string, unknown> {
	const rawUser = data.user;
	const user =
		rawUser && typeof rawUser === "object" && !Array.isArray(rawUser) ? (rawUser as Record<string, unknown>) : null;
	const userId = String(user?.id || "").trim() || "0";
	const username = String(user?.username || "").trim() || "Discord User";
	return {
		id: userId,
		name: username,
		description: "",
		icon: null,
		flags: 0,
		bot_public: false,
		bot_require_code_grant: false,
	};
}

function coerceRest(value: unknown): RestLike | null {
	if (!value || typeof value !== "object") return null;
	const candidate = value as RestLike;
	if (typeof candidate.resolveRequest !== "function") return null;
	return candidate;
}

function coerceWebSocketManagerHost(value: unknown): WebSocketManagerHost | null {
	if (!value || typeof value !== "object") return null;
	return value as WebSocketManagerHost;
}

/** Null passes through (pre-login `_ws` is unset); a misshapen manager throws. */
function coerceInternalWsManagerOrThrow(value: unknown): InternalWSManager | null {
	if (value === null || value === undefined) return null;
	if (typeof value !== "object") {
		throw patchTargetError("client.ws._ws is not an object");
	}
	const candidate = value as InternalWSManager;
	if (!candidate.options || typeof candidate.options !== "object") {
		throw patchTargetError("client.ws._ws.options is missing (internal WebSocketManager shape changed)");
	}
	if (typeof candidate.fetchGatewayInformation !== "function") {
		throw patchTargetError("client.ws._ws.fetchGatewayInformation is missing (internal WebSocketManager shape changed)");
	}
	return candidate;
}

interface RestResolveRequestResult {
	url?: string;
	fetchOptions?: {
		headers?: Record<string, string>;
		[key: string]: unknown;
	};
	[key: string]: unknown;
}

interface RestLike {
	resolveRequest: (
		this: RestLike,
		request: Record<string, unknown>,
	) => Promise<RestResolveRequestResult> | RestResolveRequestResult;
}

interface WebSocketManagerHost {
	_ws?: unknown;
}

interface InternalWSManager {
	options: {
		identifyProperties: { os: string; browser: string; device: string };
		rest: { get: (route: string) => Promise<unknown> };
		[key: string]: unknown;
	};
	gatewayInformation: {
		data: GatewayBotResponse;
		expiresAt: number;
	} | null;
	fetchGatewayInformation: (this: InternalWSManager, force?: boolean) => Promise<GatewayBotResponse>;
	send: (shardId: number, payload: { op: number; d: unknown }) => void;
}

interface GatewayResponse {
	url: string;
}

interface GatewayBotResponse {
	url: string;
	shards: number;
	session_start_limit: {
		total: number;
		remaining: number;
		reset_after: number;
		max_concurrency: number;
	};
}

type ReadyPacket = {
	d?: Record<string, unknown>;
};

type ReadyHandler = ((client: unknown, packet: ReadyPacket, shard: { id: number }) => void) & {
	__clankyUserTokenPatched?: boolean;
};
