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
	type DiscordInboundMessage,
	EngagementTracker,
	decideDiscordInbound,
	isSkipReplyText,
	resolveEngagementWindowMs,
} from "./acceptance.ts";
import { DiscordGateway } from "./gateway.ts";
import { formatPresencePrompt } from "./prompt.ts";
import { type VoiceIntent, detectVoiceIntent } from "./voice-intent.ts";
import { resolveWakeNames } from "./wake-names.ts";

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
	/** eve loopback base URL for the conductor's own session API. */
	eveHost?: string;
	/** Join voice intents so "hop in vc" and the media plane can attach. */
	voice?: boolean;
	wakeNames?: string[];
	/** Notified when a channel's presence session first gets a sessionId, so a
	 * herdr pane mirror can be spawned (SPEC.md §5.6). */
	onPresenceSession?: (info: { channelId: string; sessionId: string }) => void | Promise<void>;
	/** Route a bridge command (and the inbound message) to the main Clanky thread. */
	onBridgeToMain?: (command: BridgeCommand, message: DiscordInboundMessage) => void | Promise<void>;
	/** Handle a "hop in vc" / "leave vc" intent on an accepted message. */
	onVoiceIntent?: (intent: VoiceIntent, message: DiscordInboundMessage) => void | Promise<void>;
}

const DEFAULT_EVE_HOST = "http://127.0.0.1:3000";

export class DiscordPresenceHost {
	private readonly gateway: DiscordGateway;
	private readonly client: Client;
	private readonly tracker: EngagementTracker;
	private readonly wakeNames: string[];
	private readonly sessions = new Map<string, ClientSession>();
	private readonly mirrored = new Set<string>();
	private readonly options: DiscordPresenceHostOptions;

	constructor(options: DiscordPresenceHostOptions) {
		this.options = options;
		this.gateway = new DiscordGateway({ token: options.token, chat: true, voice: options.voice });
		this.client = new Client({ host: options.eveHost ?? DEFAULT_EVE_HOST });
		this.tracker = new EngagementTracker(resolveEngagementWindowMs(process.env));
		this.wakeNames = options.wakeNames ?? resolveWakeNames(process.env);
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

	private async route(message: DiscordInboundMessage): Promise<void> {
		try {
			const bridge = parseBridgeCommand(message.text);
			if (bridge !== null) {
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
			});
			if (!decision.accepted) return;
			if (decision.recordInboundEngagement) this.tracker.record(message.channelId, message.authorId);

			if (this.options.onVoiceIntent !== undefined) {
				const intent = detectVoiceIntent(message.text);
				if (intent !== null) await this.options.onVoiceIntent(intent, message);
			}

			await this.gateway.sendTyping(message.channelId);
			const prompt = formatPresencePrompt(message, decision.reason, message.authorName ?? message.authorId);
			const session = this.sessionFor(message.channelId);
			const response = await session.send(prompt);
			const result = await response.result();

			if (!this.mirrored.has(message.channelId) && result.sessionId.length > 0) {
				this.mirrored.add(message.channelId);
				if (this.options.onPresenceSession !== undefined) {
					await this.options.onPresenceSession({ channelId: message.channelId, sessionId: result.sessionId });
				}
			}

			const text = result.message?.trim() ?? "";
			if (text.length === 0 || isSkipReplyText(text)) return;
			await this.gateway.sendMessage(message.channelId, text);
			this.tracker.record(message.channelId, message.authorId);
		} catch (error) {
			console.error(`discord presence route failed for channel ${message.channelId}:`, error);
		}
	}
}
