/**
 * Discord presence host — the router that ties the gateway to eve sessions
 * (SPEC.md §5.2). Runs in the conductor process. For each inbound Discord
 * message it: parses bridge commands (escape to main Clanky), runs the free-will
 * acceptance gate, and dispatches accepted chat to a per-channel presence
 * session via the eve client over loopback. The presence session is a separate
 * eve session of the same root agent, so it shares Clanky's memory store,
 * persona, and tools without clogging the main face-pane thread. Replies post
 * back over Discord REST; a [SKIP] result posts nothing.
 */
import { Client, type ClientSession } from "eve/client";
import {
	type DiscordScopeOptions,
	type DiscordInboundMessage,
	EngagementTracker,
	decideDiscordInbound,
	decideDiscordScope,
	isSkipReplyText,
	resolveEngagementWindowMs,
	resolveDiscordScopeOptions,
} from "./acceptance.ts";
import { type DiscordCredentialKind, DiscordGateway } from "./gateway.ts";
import { discordGatewaySessionStatusFromMessage, type DiscordGatewaySessionStatus } from "./gateway-status.ts";
import { rememberDiscordMessageFacts } from "./memory.ts";
import { buildPresenceSessionMessage } from "./presence-payload.ts";
import type { DiscordHistoryEntry } from "./prompt.ts";
import { type VoiceIntent, detectVoiceIntent } from "./voice-intent.ts";
import { resolveWakeNameMatch, resolveWakeNames } from "./wake-names.ts";

export interface BridgeCommand {
	type: "direct" | "new" | "compact" | "help";
	prompt: string;
}

const BRIDGE_PREFIXES = ["/clanky", "/clank", "!clanky", "!clank"] as const;

/** Detect a bridge command that should bypass the presence subagent. */
export function parseBridgeCommand(text: string): BridgeCommand | null {
	const trimmed = text.trim();
	const lower = trimmed.toLowerCase();
	if (lower === "/new") return { type: "new", prompt: "" };
	if (lower === "/compact" || lower.startsWith("/compact ")) {
		return { type: "compact", prompt: trimmed.slice("/compact".length).trim() };
	}
	for (const prefix of BRIDGE_PREFIXES) {
		if (lower !== prefix && !lower.startsWith(`${prefix} `)) continue;
		const rest = trimmed.slice(prefix.length).trim();
		if (rest.length === 0) return { type: "help", prompt: "" };
		const [first, ...others] = rest.split(/\s+/);
		const sub = (first ?? "").toLowerCase();
		const remainder = others.join(" ");
		if (sub === "direct") return { type: "direct", prompt: remainder };
		if (sub === "new") return { type: "new", prompt: "" };
		if (sub === "compact") return { type: "compact", prompt: remainder };
		if (sub === "help") return { type: "help", prompt: "" };
		return { type: "direct", prompt: rest };
	}
	return null;
}

export const BRIDGE_HELP_TEXT = [
	"Discord Clanky commands:",
	"- Normal chat is handled by the dedicated Discord presence (a separate thread that shares my memory).",
	"- /clanky <msg> or /clanky direct <msg>: send straight to main Clanky.",
	"- /clanky new: start a fresh main Clanky session.",
	"- /clanky compact [focus]: compact main Clanky's context.",
	"Aliases: /clank, !clanky, !clank, /new, /compact.",
].join("\n");

export interface DiscordPresenceHostOptions {
	token: string;
	/** Bot token (default) or user/self token (selfbot, unlocks Go Live). */
	credentialKind?: DiscordCredentialKind;
	/** eve loopback base URL for the conductor's own session API. */
	eveHost?: string;
	/** Join voice intents so "hop in vc" and the media plane can attach. */
	voice?: boolean;
	wakeNames?: string[];
	/** Notified when a channel's presence session first gets a sessionId, so a
	 * herdr pane mirror can be spawned (SPEC.md §5.6). */
	onPresenceSession?: (info: DiscordGatewaySessionStatus) => void | Promise<void>;
	/** Persist live gateway status for every accepted presence turn. */
	onPresenceActivity?: (info: DiscordGatewaySessionStatus) => void | Promise<void>;
	/** Route a bridge command (and the inbound message) to the main Clanky thread. */
	onBridgeToMain?: (command: BridgeCommand, message: DiscordInboundMessage) => void | Promise<void>;
	/** Handle a "hop in vc" / "leave vc" intent on an accepted message. */
	onVoiceIntent?: (intent: VoiceIntent, message: DiscordInboundMessage) => void | Promise<void>;
}

const DEFAULT_EVE_HOST = "http://127.0.0.1:2000";
const MAX_CHANNEL_HISTORY = 40;
const MAX_INBOUND_MESSAGE_MEMORY = 1000;

function formatDiscordTraceTarget(message: DiscordInboundMessage): string {
	const parts = [
		`message=${shortDiscordId(message.externalMessageId)}`,
		`kind=${message.kind}`,
		`channel=${shortDiscordId(message.channelId)}`,
		`author=${shortDiscordId(message.authorId)}`,
	];
	if (message.guildId !== undefined) parts.push(`guild=${shortDiscordId(message.guildId)}`);
	if (message.threadId !== undefined) parts.push(`thread=${shortDiscordId(message.threadId)}`);
	return parts.join(" ");
}

function shortDiscordId(id: string): string {
	return id.length <= 8 ? id : `...${id.slice(-6)}`;
}

function logDiscordTrace(message: string): void {
	console.info(`[discord] ${message}`);
}

export class RecentDiscordMessageIds {
	private readonly order: string[] = [];
	private readonly seen = new Set<string>();
	private readonly limit: number;

	constructor(limit = MAX_INBOUND_MESSAGE_MEMORY) {
		this.limit = limit;
	}

	remember(messageId: string): boolean {
		if (this.seen.has(messageId)) return false;
		this.seen.add(messageId);
		this.order.push(messageId);
		while (this.order.length > this.limit) {
			const evicted = this.order.shift();
			if (evicted !== undefined) this.seen.delete(evicted);
		}
		return true;
	}
}

const INBOUND_MESSAGE_IDS_KEY = "__clankyDiscordInboundMessageIds" as const;
type DiscordInboundMessageIdsGlobal = typeof globalThis & {
	[INBOUND_MESSAGE_IDS_KEY]?: RecentDiscordMessageIds;
};

function sharedInboundMessageIds(): RecentDiscordMessageIds {
	return ((globalThis as DiscordInboundMessageIdsGlobal)[INBOUND_MESSAGE_IDS_KEY] ??= new RecentDiscordMessageIds());
}

export function isDiscordSelfMessage(message: DiscordInboundMessage, selfUserId: string | undefined): boolean {
	return selfUserId !== undefined && message.authorId === selfUserId;
}

export class DiscordPresenceHost {
	private readonly gateway: DiscordGateway;
	private readonly client: Client;
	private readonly tracker: EngagementTracker;
	private readonly wakeNames: string[];
	private readonly scope: DiscordScopeOptions;
	private readonly inboundMessageIds = sharedInboundMessageIds();
	private readonly channelHistory = new Map<string, DiscordHistoryEntry[]>();
	private readonly sessions = new Map<string, ClientSession>();
	private readonly mirrored = new Set<string>();
	private readonly options: DiscordPresenceHostOptions;

	constructor(options: DiscordPresenceHostOptions) {
		this.options = options;
		this.gateway = new DiscordGateway({
			token: options.token,
			credentialKind: options.credentialKind,
			chat: true,
			voice: options.voice,
		});
		this.client = new Client({ host: options.eveHost ?? DEFAULT_EVE_HOST });
		this.tracker = new EngagementTracker(resolveEngagementWindowMs(process.env));
		this.wakeNames = options.wakeNames ?? resolveWakeNames(process.env);
		this.scope = resolveDiscordScopeOptions(process.env);
	}

	/** Underlying gateway, exposed so the voice runtime can join atop it. */
	get discordGateway(): DiscordGateway {
		return this.gateway;
	}

	async start(): Promise<void> {
		await this.gateway.start((message) => this.route(message));
	}

	async stop(): Promise<void> {
		await this.gateway.stop();
	}

	private sessionFor(channelId: string): ClientSession {
		const existing = this.sessions.get(channelId);
		if (existing !== undefined) return existing;
		const created = this.client.session();
		this.sessions.set(channelId, created);
		return created;
	}

	private startPresenceMirror(info: DiscordGatewaySessionStatus, traceTarget: string): void {
		if (this.mirrored.has(info.channelId) || info.sessionId.length === 0) return;
		this.mirrored.add(info.channelId);
		if (this.options.onPresenceSession === undefined) return;
		logDiscordTrace(`mirror starting session=${shortDiscordId(info.sessionId)} ${traceTarget}`);
		void Promise.resolve(this.options.onPresenceSession(info)).catch(
			(error: unknown) => {
				this.mirrored.delete(info.channelId);
				console.error(`discord presence mirror failed ${traceTarget}:`, error);
			},
		);
	}

	private historyFor(channelId: string): DiscordHistoryEntry[] {
		return [...(this.channelHistory.get(channelId) ?? [])];
	}

	private recordChannelMessage(channelId: string, entry: DiscordHistoryEntry): void {
		const text = entry.text.trim();
		if (text.length === 0) return;
		const next = [...(this.channelHistory.get(channelId) ?? []), { author: entry.author, text }].slice(-MAX_CHANNEL_HISTORY);
		this.channelHistory.set(channelId, next);
	}

	private recordInboundHistory(message: DiscordInboundMessage): void {
		this.recordChannelMessage(message.channelId, {
			author: message.authorName ?? message.authorId,
			text: message.text,
		});
	}

	private shouldTraceScopedIgnore(message: DiscordInboundMessage): boolean {
		if (message.kind === "dm" || message.mentionsSelf) return true;
		if (parseBridgeCommand(message.text) !== null) return true;
		return resolveWakeNameMatch(message.text, this.wakeNames).mentioned;
	}

	private async route(message: DiscordInboundMessage): Promise<void> {
		const traceTarget = formatDiscordTraceTarget(message);
		if (!this.inboundMessageIds.remember(message.externalMessageId)) {
			logDiscordTrace(`ignored reason=duplicate_message message=${shortDiscordId(message.externalMessageId)} ${traceTarget}`);
			return;
		}
		const scopeReason = decideDiscordScope(message, this.scope);
		if (scopeReason !== undefined) {
			if (this.shouldTraceScopedIgnore(message)) logDiscordTrace(`ignored reason=${scopeReason} ${traceTarget}`);
			return;
		}
		if (isDiscordSelfMessage(message, this.gateway.selfUserId)) {
			logDiscordTrace(`ignored reason=self_message ${traceTarget}`);
			return;
		}
		const history = this.historyFor(message.channelId);
		this.recordInboundHistory(message);
		try {
			const bridge = parseBridgeCommand(message.text);
			if (bridge !== null) {
				logDiscordTrace(`bridge command type=${bridge.type} ${traceTarget}`);
				if (bridge.type === "help") {
					await this.gateway.sendMessage(message.channelId, BRIDGE_HELP_TEXT);
					return;
				}
				if (this.options.onBridgeToMain !== undefined) await this.options.onBridgeToMain(bridge, message);
				return;
			}

			const decision = decideDiscordInbound(message, {
				wakeNames: this.wakeNames,
				isEngaged: (channelId, userId) => this.tracker.isEngaged(channelId, userId),
				isKnownSelfMessage: (id) => this.gateway.isKnownSelfMessage(id),
				selfUserId: this.gateway.selfUserId,
				...this.scope,
			});
			if (!decision.accepted) return;
			if (decision.recordInboundEngagement) this.tracker.record(message.channelId, message.authorId);
			logDiscordTrace(`accepted reason=${decision.reason} ${traceTarget}`);

			if (this.options.onVoiceIntent !== undefined) {
				const intent = detectVoiceIntent(message.text);
				if (intent !== null) await this.options.onVoiceIntent(intent, message);
			}

			await rememberDiscordMessageFacts(message).catch((error: unknown) =>
				console.error("discord memory capture failed:", error),
			);

			await this.gateway.sendTyping(message.channelId);
			const mode = this.sessions.has(message.channelId) ? "compact" : "full";
			const prompt = await buildPresenceSessionMessage(message, decision.reason, message.authorName ?? message.authorId, {
				history,
				mode,
			});
			const session = this.sessionFor(message.channelId);
			const response = await session.send({ message: prompt });
			const sessionInfo = discordGatewaySessionStatusFromMessage(message, response.sessionId);
			if (this.options.onPresenceActivity !== undefined) await this.options.onPresenceActivity(sessionInfo);
			this.startPresenceMirror(sessionInfo, traceTarget);
			const result = await response.result();

			const text = result.message?.trim() ?? "";
			const sessionTrace = result.sessionId.length > 0 ? ` session=${shortDiscordId(result.sessionId)}` : "";
			if (text.length === 0) {
				logDiscordTrace(`no reply outcome=empty chars=0${sessionTrace} ${traceTarget}`);
				return;
			}
			if (isSkipReplyText(text)) {
				logDiscordTrace(`no reply outcome=skip chars=${text.length}${sessionTrace} ${traceTarget}`);
				return;
			}
			const sentIds = await this.gateway.sendMessage(message.channelId, text);
			this.recordChannelMessage(message.channelId, { author: "Clanky", text });
			logDiscordTrace(`sent chars=${text.length} messages=${sentIds.length}${sessionTrace} ${traceTarget}`);
			this.tracker.record(message.channelId, message.authorId);
		} catch (error) {
			console.error(`discord presence route failed ${traceTarget}:`, error);
		}
	}
}
